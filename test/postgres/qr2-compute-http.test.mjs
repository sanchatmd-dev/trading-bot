import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createQr2Database,createOwner,createBot,book,insertBars,barOf,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {qr2PerformanceRoute,createQr2Slot,QR2_PERFORMANCE_PATH,QR2_ADMIN_READ_EVENT} from '../../src/postgres/qr2-routes.js';
import {readQr2Snapshot,computeQr2View} from '../../src/postgres/qr2-reader.js';
import {executeQr2Job} from '../../src/postgres/qr2-compute-worker.js';
import {createQr2ComputePool} from '../../src/postgres/qr2-compute-pool.js';
import {runMarketDeferred} from '../../src/postgres/market-ohlcv.js';
import {composePerformanceResponse} from '../../src/portfolio/qr2-response.js';
import {validateResponse} from '../../src/portfolio/qr2-labels.js';

// QR-2 S3b (RC-Q35) with PostgreSQL: the route computing through the real worker pool, driven like the dispatcher drives it (phase 1, the
// deferred function through the real runMarketDeferred, then the after-commit function). Isolated local PostgreSQL only (TEST_DATABASE_URL).
// Every direct-SQL write below is a labelled fixture or fault made by the test. Timing bounds are generous (thread start differs between
// Windows and Linux); the timing tests are load-sensitive and run alone.
const PATH=QR2_PERFORMANCE_PATH;
const READY="require('node:worker_threads').parentPort.postMessage({type:'ready'});";
const HEAD="const {parentPort}=require('node:worker_threads');";
const WORKERS={
  loop:HEAD+"parentPort.on('message',()=>{for(;;){}});"+READY,
  throwOnMessage:HEAD+"parentPort.on('message',()=>{throw new Error('boom-secret-text');});"+READY,
  sleeper:HEAD+"parentPort.on('message',m=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);parentPort.postMessage({id:m.id,ok:true,body:{slept:true},auditFindings:[],compute_ms:1500});});"+READY
};
// A pool whose first spawns use the named eval workers; once the names are used up it starts the real worker module.
function poolWith(names,options={}){
  let spawned=0;
  const spawn=(url,spawnOptions)=>{
    const name=names[spawned++];
    return name?new Worker(WORKERS[name],{...spawnOptions,eval:true}):new Worker(url,spawnOptions);
  };
  return createQr2ComputePool({spawn,...options});
}
function nonPlain(value,pathOf='$'){
  if(value===null||value===undefined)return null;
  if(typeof value==='function'||typeof value==='symbol'||typeof value==='bigint')return pathOf+' is '+typeof value;
  if(typeof value!=='object')return null;
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==Array.prototype)return pathOf+' is a '+(proto?.constructor?.name||'null-prototype object');
  for(const key of Object.keys(value)){const found=nonPlain(value[key],pathOf+'.'+key);if(found)return found;}
  return null;
}
// Timers zeroed, then compared as JSON text; the copy is a JSON round trip, never a structured clone (callers assert nonPlain() first).
const stable=body=>{const copy=JSON.parse(JSON.stringify(body));if(copy.reader){copy.reader.compute_ms=0;copy.reader.read_ms=0;}return JSON.stringify(copy);};

let fx,store;
async function priceNow(price='62000'){await fx.db.query('DELETE FROM public.pine_market_bars');await insertBars(fx.db,[barOf(Date.now()-1000,price)]);}
async function tradedBot({targeted=false}={}){
  const o=await createOwner(store),bot=await createBot(store,o,10000);bot.owner=o;
  await priceNow();
  const tag=bot.id.slice(0,6);
  const buy=await book(store,bot,'cp-b-'+tag,{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(store,bot,'cp-s-'+tag,{side:'SELL',steps:[{qty:'0.004',quote:'244'}],...(targeted?{target:'cp-b-'+tag}:{})});
  await priceNow();
  return {bot,buy};
}
async function drive(query,actor,deps={}){
  const url=new URL('http://localhost'+PATH+'?'+query);
  const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null,phase2AfterCommit:null,headers:{}};
  res.setHeader=(name,value)=>{res.headers[name]=value;};
  const json=(r,status,body)=>{r.phase2Result={status,body};};
  const handled=await qr2PerformanceRoute({method:'GET',headers:{}},res,url,actor,{store,auth:{sensitive:async()=>{}},json,enabled:true,slot:createQr2Slot(),boundaries:LOCAL_FIXTURE_E2,...deps});
  const result=res.phase2Deferred?await runMarketDeferred(res.phase2Deferred):res.phase2Result;
  return {handled,result,res,hook:()=>res.phase2AfterCommit,headers:res.headers};
}

before(async()=>{fx=await createQr2Database('robot_qr2_compute');({store}=fx);});
after(async()=>{await fx?.dispose();});

test('the real worker pool gives the S3a answer: hand values, the in-thread body for the same clock, and a body that validates',async()=>{
  const {bot}=await tradedBot();
  const clock=Date.now();
  const pool=createQr2ComputePool();
  try{
    const pooled=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{compute:pool,clock:()=>clock});
    const inline=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{compute:{run:async(snapshot,input)=>executeQr2Job({snapshot,input})},clock:()=>clock});
    assert.equal(pooled.result.status,200,JSON.stringify(pooled.result.body));
    const a=pooled.result.body.account;
    assert.deepEqual([a.cash.value,a.nav.value,a.market_value.value,a.position_cost.value,a.realized_pnl.value,a.unrealized_pnl.value,a.fees.value,a.money_pnl.value,a.twr.value],
      ['9644','10016','372','360','4','12','0','16','0.0016']);
    assert.equal(validateResponse(pooled.result.body).ok,true);
    assert.equal(nonPlain(pooled.result.body),null,'the worker body holds plain data only');
    assert.equal(nonPlain(inline.result.body),null,'the in-thread body holds plain data only');
    assert.equal(stable(pooled.result.body),stable(inline.result.body),'worker body JSON equals in-thread body JSON');
    assert.equal(Object.hasOwn(pooled.result.body,'rows'),false);
    assert.equal(pool.counters.completed,1);assert.equal(pool.counters.crash+pool.counters.timeout+pool.counters.spawn,0);
    // The same warm worker serves the next request.
    assert.equal((await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{compute:pool})).result.status,200);
    assert.equal(pool.counters.completed,2);
  }finally{await pool.close();}
});

test('a real reader snapshot is plain data, a structured clone computes the same view, and the worker agrees for a targeted-SELL account',async()=>{
  const {bot}=await tradedBot({targeted:true});
  const requestTime=Date.now();
  const args={ownerId:bot.owner.id,botId:bot.id,broker:'binance-global',from:requestTime-86400000,to:requestTime+1,requestTime,boundaries:LOCAL_FIXTURE_E2};
  const {snapshot,input}=await readQr2Snapshot(store,args);
  assert.equal(nonPlain(snapshot),null,'the snapshot holds no Decimal, Date, function or class instance');
  assert.equal(nonPlain({...input,boundaries:null,limits:null}),null);
  assert.ok(snapshot.market.rows.length>0,'the fixture exercises the price path');
  const direct=composePerformanceResponse(computeQr2View(snapshot,input),{requestTime});
  const cloned=composePerformanceResponse(computeQr2View(structuredClone(snapshot),structuredClone(input)),{requestTime});
  assert.equal(nonPlain(direct),null,'the in-thread body holds plain data only');
  assert.equal(stable(cloned),stable(direct));
  const pool=createQr2ComputePool();
  try{
    const viaWorker=await pool.run(snapshot,input);
    assert.equal(viaWorker.ok,true,JSON.stringify(viaWorker));
    assert.equal(nonPlain(viaWorker.body),null,'the worker body holds plain data only');
    assert.equal(stable(viaWorker.body),stable(direct));
    assert.equal(direct.analytics_comparison.targeted_exits,1,'the second (analytics) replay ran');
  }finally{await pool.close();}
});

test('admin read: the audit row exists when the reader runs; the after-commit audit follows a successful compute and never a timeout or a crash',async()=>{
  const {bot}=await tradedBot();
  const admin=await createOwner(store);
  // Labelled fixture fault made by the test: an R7 cost drift on the Bot, so a successful read has a finding to audit.
  await fx.db.query('UPDATE public.ledger_positions SET cost_basis=cost_basis+0.000000000000000001 WHERE user_id=$1',[bot.id]);
  const adminRows=async()=>Number((await fx.db.query('SELECT count(*) AS n FROM public.audit WHERE user_id=$1 AND event=$2',[admin.id,QR2_ADMIN_READ_EVENT])).rows[0].n);
  const findings=async()=>Number((await fx.db.query("SELECT count(*) AS n FROM public.audit WHERE user_id=$1 AND event='qr2.finding'",[bot.id])).rows[0].n);
  const query=`bot_id=${bot.id}&period=DAY`;
  const seen=[];
  const spy=async(...args)=>{seen.push(await adminRows());return readQr2Snapshot(...args);};
  const good=createQr2ComputePool();
  try{
    const ok=await drive(query,admin,{compute:good,readSnapshot:spy});
    assert.equal(ok.result.status,200);assert.deepEqual(seen,[1],'the admin audit row is committed before the read');
    assert.equal(typeof ok.hook(),'function');
    assert.equal(await findings(),0,'phase 2 itself writes no finding row');
    await ok.hook()();
    assert.ok(await findings()>=1,'the audit writer wrote the finding after the answer');
  }finally{await good.close();}
  const before=await findings();
  for(const [name,workers] of [['timeout',['loop']],['crash',['throwOnMessage']]]){
    const pool=poolWith(workers,{deadlineMs:name==='timeout'?1000:10000});
    try{
      const failed=await drive(query,admin,{compute:pool});
      assert.equal(failed.result.status,503,name);
      assert.deepEqual(failed.result.body,{code:'QR2_REPORT_FAILED',error:'Performance report could not be produced'},name);
      assert.equal(failed.headers['Retry-After'],'2',name);
      assert.equal(failed.hook(),null,name+': no after-commit audit');
      assert.equal(JSON.stringify(failed.result.body).includes('boom-secret-text'),false);
      assert.equal(pool.counters[name],1,name);
    }finally{await pool.close();}
  }
  assert.equal(await findings(),before,'a failed compute writes no finding row');
  assert.equal(await adminRows(),3,'one admin row per request, kept when the compute fails');
});

test('timeout and crash free the slot and the next request is served by a new worker with the S3a answer',async()=>{
  const {bot}=await tradedBot();
  const query=`bot_id=${bot.id}&period=DAY`;
  for(const [name,workers,deadlineMs] of [['timeout',['loop'],1000],['crash',['throwOnMessage'],10000]]){
    const slot=createQr2Slot();
    const pool=poolWith(workers,{deadlineMs});
    try{
      const started=Date.now();
      const failed=await drive(query,bot.owner,{compute:pool,slot});
      assert.equal(failed.result.status,503,name);
      if(name==='timeout')assert.ok(Date.now()-started<deadlineMs+5000,'the 503 comes within the deadline plus a generous margin');
      assert.equal(slot.busy,0,name+': slot free');
      const next=await drive(query,bot.owner,{compute:pool,slot});
      assert.equal(next.result.status,200,name+' '+JSON.stringify(next.result.body));
      assert.equal(next.result.body.account.nav.value,'10016');
    }finally{await pool.close();}
  }
});

test('concurrency and event loop: during a compute that blocks its worker for 1.5 s a second request gets 429 and a database round trip stays fast',async()=>{
  const {bot}=await tradedBot();
  const query=`bot_id=${bot.id}&period=DAY`;
  const slot=createQr2Slot();
  const pool=poolWith(['sleeper'],{deadlineMs:20000});
  try{
    const first=drive(query,bot.owner,{compute:pool,slot});
    while(slot.busy===0)await new Promise(r=>setTimeout(r,5));
    await new Promise(r=>setTimeout(r,300)); // the read finished and the worker is inside its 1.5 s block
    let last=Date.now(),maxGap=0;
    const beat=setInterval(()=>{const now=Date.now();maxGap=Math.max(maxGap,now-last);last=now;},10);
    const probes=[];
    for(let i=0;i<5;i++){const t=Date.now();await fx.db.query('SELECT 1');probes.push(Date.now()-t);await new Promise(r=>setTimeout(r,50));}
    const second=await drive(query,bot.owner,{compute:pool,slot});
    clearInterval(beat);
    assert.equal(slot.busy,1,'the first request still holds the slot');
    assert.equal(second.result.status,429);
    assert.deepEqual(second.result.body.detail,{limit:'concurrency',max:1});
    assert.equal(second.headers['Retry-After'],'2');
    assert.ok(Math.max(...probes)<250,'database round trips during the compute: '+probes.join(','));
    assert.ok(maxGap<250,'largest main-thread gap during the compute: '+maxGap+' ms');
    const done=await first;
    assert.equal(done.result.status,200);assert.deepEqual(done.result.body,{slept:true});
    assert.equal(slot.busy,0);
  }finally{await pool.close();}
});
