import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr2Database,createOwner,createBot,book,insertBars,barOf,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {qr2PerformanceRoute,createQr2Slot,QR2_PERFORMANCE_PATH} from '../../src/postgres/qr2-routes.js';
import {qr2OwnerPerformanceRoute,QR2_OWNER_PERFORMANCE_PATH} from '../../src/postgres/qr2-owner-route.js';
import {createQr2ComputePool} from '../../src/postgres/qr2-compute-pool.js';
import {runMarketDeferred} from '../../src/postgres/market-ohlcv.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED} from '../../src/portfolio/qr2-boundaries.js';
import {QR2_BOUNDARY_RECORDS,QR2_BOUNDARY_RECORD_DEFAULT} from '../../src/portfolio/qr2-boundary-records.js';
import {validateResponse} from '../../src/portfolio/qr2-labels.js';
import {validateOwnerResponse} from '../../src/portfolio/qr2-owner-response.js';

// QR-2 boundary record wiring (contract 6.2; RC-Q46) with PostgreSQL: the real route, the real reader and the real worker pool. The record given as
// deps.boundaries turns a fill-bearing account from RECONCILIATION_FAILED into OK, and a spy in front of the pool proves the record reached the compute
// call. With no deps.boundaries the route takes QR2_BOUNDARY_RECORD_DEFAULT; this file is written for the empty registry of the mechanism slice, so that
// default is UNRECORDED and the answers are today's. The values slice that adds a staging record updates the control assertions with its review.
// Isolated local PostgreSQL only (TEST_DATABASE_URL). Every fixture row comes through the live Store and ExecutionWorker; nothing here is evidence.

let fx,store;
before(async()=>{fx=await createQr2Database('robot_qr2_boundary_wiring');({store}=fx);await fx.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));});
after(async()=>{await fx?.dispose();});

async function priceNow(){await fx.db.query('DELETE FROM public.pine_market_bars');await insertBars(fx.db,[barOf(Math.floor((Date.now()-1000)/60000)*60000,'62000')]);}
async function tradedBot(owner){
  const bot=await createBot(store,owner,10000);
  await priceNow();
  await book(store,bot,'bw-b-'+bot.id.slice(0,6),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await priceNow();
  return bot;
}
// A pool behind a spy: every compute call is recorded before it reaches the real worker thread.
const spied=pool=>{const calls=[];return {calls,run:async(snapshot,input)=>{calls.push({snapshot,input});return pool.run(snapshot,input);}};};
async function drive(route,path,query,actor,deps){
  const url=new URL('http://localhost'+path+'?'+query);
  const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null,phase2AfterCommit:null,headers:{}};
  res.setHeader=(name,value)=>{res.headers[name]=value;};
  const json=(r,status,body)=>{r.phase2Result={status,body};};
  const handled=await route({method:'GET',headers:{}},res,url,actor,{store,auth:{sensitive:async()=>{}},json,enabled:true,slot:createQr2Slot(),...deps});
  assert.equal(handled,true);
  return res.phase2Deferred?runMarketDeferred(res.phase2Deferred):res.phase2Result;
}

test('P2 per-Bot route: the given record turns a fill-bearing account OK; the default stays UNRECORDED; the record reaches the compute call',async()=>{
  assert.equal(QR2_BOUNDARY_RECORDS.size,0,'the mechanism slice ships an empty registry');
  assert.equal(QR2_BOUNDARY_RECORD_DEFAULT,QR2_BOUNDARY_RECORD_UNRECORDED);
  const owner=await createOwner(store),bot=await tradedBot(owner);
  const pool=createQr2ComputePool();
  try{
    const query=`bot_id=${bot.id}&period=DAY`;
    const given=spied(pool);
    const ok=await drive(qr2PerformanceRoute,QR2_PERFORMANCE_PATH,query,owner,{compute:given,boundaries:LOCAL_FIXTURE_E2});
    assert.equal(ok.status,200,JSON.stringify(ok.body));
    assert.equal(ok.body.reconciliation.state,'OK');assert.equal(ok.body.reconciliation.first_failure,null);
    assert.notEqual(ok.body.status.status,'UNAVAILABLE');assert.notEqual(ok.body.account.nav.value,null);
    assert.equal(validateResponse(ok.body).ok,true);
    assert.equal(given.calls.length,1);assert.deepEqual(given.calls[0].input.boundaries,LOCAL_FIXTURE_E2,'the record crossed the route into the compute input');
    const control=spied(pool);
    const failed=await drive(qr2PerformanceRoute,QR2_PERFORMANCE_PATH,query,owner,{compute:control});
    assert.equal(failed.status,200,JSON.stringify(failed.body));
    assert.equal(control.calls.length,1);assert.deepEqual(control.calls[0].input.boundaries,QR2_BOUNDARY_RECORD_DEFAULT,'no deps.boundaries: the route takes the registry default');
    assert.equal(failed.body.reconciliation.state,'RECONCILIATION_FAILED');assert.equal(failed.body.reconciliation.first_failure.code,'LEDGER_RULE_UNREPLAYABLE');
    assert.equal(failed.body.status.status,'UNAVAILABLE');assert.equal(failed.body.account.nav.value,null);
    assert.equal(validateResponse(failed.body).ok,true);
    assert.equal(pool.counters.completed,2);assert.equal(pool.counters.crash+pool.counters.timeout+pool.counters.spawn,0);
  }finally{await pool.close();}
});

test('P3 owner route: the given record reaches every member read and turns a fill-bearing member OK; the default stays UNRECORDED',async()=>{
  assert.equal(QR2_BOUNDARY_RECORD_DEFAULT,QR2_BOUNDARY_RECORD_UNRECORDED);
  const owner=await createOwner(store),traded=await tradedBot(owner),funded=await createBot(store,owner,5000);
  const pool=createQr2ComputePool();
  try{
    const query='currency=USDT&period=DAY';
    const memberOf=(body,bot)=>body.accounts.find(row=>row.bot_id===bot.id&&row.broker==='binance-global');
    const given=spied(pool);
    const ok=await drive(qr2OwnerPerformanceRoute,QR2_OWNER_PERFORMANCE_PATH,query,owner,{compute:given,boundaries:LOCAL_FIXTURE_E2});
    assert.equal(ok.status,200,JSON.stringify(ok.body));
    assert.equal(validateOwnerResponse(ok.body),true);
    assert.notEqual(memberOf(ok.body,traded).status.status,'UNAVAILABLE');assert.notEqual(memberOf(ok.body,traded).nav_to.value,null);
    assert.notEqual(memberOf(ok.body,funded).nav_to.value,null);
    assert.equal(given.calls.length,1);
    const members=given.calls[0].snapshot.accounts;
    assert.ok(members.length>=2,'both child Bots are read');
    for(const member of members)assert.deepEqual(member.input.boundaries,LOCAL_FIXTURE_E2,'the record crossed the owner route into every member read');
    const control=spied(pool);
    const failed=await drive(qr2OwnerPerformanceRoute,QR2_OWNER_PERFORMANCE_PATH,query,owner,{compute:control});
    assert.equal(failed.status,200,JSON.stringify(failed.body));
    assert.equal(validateOwnerResponse(failed.body),true);
    for(const member of control.calls[0].snapshot.accounts)assert.deepEqual(member.input.boundaries,QR2_BOUNDARY_RECORD_DEFAULT,'no deps.boundaries: the route takes the registry default');
    assert.equal(memberOf(failed.body,traded).status.status,'UNAVAILABLE');assert.equal(memberOf(failed.body,traded).nav_to.value,null);
    assert.notEqual(memberOf(failed.body,funded).nav_to.value,null,'a funding-only account keeps its NAV');
    assert.equal(pool.counters.completed,2);assert.equal(pool.counters.crash+pool.counters.timeout+pool.counters.spawn,0);
  }finally{await pool.close();}
});
