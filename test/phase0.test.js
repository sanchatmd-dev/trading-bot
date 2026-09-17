import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/database.js';
import {Worker} from '../src/worker.js';
import {config} from '../src/config.js';
import {backupDatabase} from '../scripts/backup.mjs';

const broker='binance-global';
const policy=(capital=1000)=>({...config.defaultRisk,equities:{[broker]:capital},balances:{[broker]:capital}});
const signal=(tradeId,overrides={})=>({tradeId,broker,symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',timestamp:Date.now(),riskMode:'QUANTITY',quantity:10,referencePrice:100,stopLoss:90,leverage:1,newsRisk:false,volatilityPercent:0,...overrides});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'robot-phase0-')),filename=path.join(dir,'test.db');
  let store=new Store(filename);
  const user=store.createUser({email:'phase0@test.local',passwordHash:'unused',role:'ADMIN'});store.setRisk(user.id,policy());
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},user,filename,reopen(){store.close();store=new Store(filename);return store;}};
}
async function execute(store,user,s){store.enqueue(user.id,s);await new Worker({store,config}).tick();return store.listSignals(user.id).find(row=>row.trade_id===s.tradeId);}
function claim(store,user,s){store.enqueue(user.id,s);return store.claimNext();}
function fill(store,row,quantity,quote,status='FILLED',fee=0){
  const order={...row.payload,price:row.payload.referencePrice};store.persistIntent(row,order);
  store.recordExecution(row,{status,orderId:'paper-test',executedQty:quantity,quoteQty:quote,deltaFeeQuote:fee,raw:{paper:true}},order);
}

test('cash and book equity reflect realized loss; a second purchase cannot reuse lost capital',async t=>{
  const {store,user}=fixture(t);
  await execute(store,user,signal('buy'));
  assert.equal(store.paperAccount(user.id,broker).cash,0);assert.equal(store.paperAccount(user.id,broker).bookEquity,1000);
  await execute(store,user,signal('sell',{side:'SELL',event:'SL',reduceOnly:true,referencePrice:90}));
  assert.equal(store.paperAccount(user.id,broker).cash,900);assert.equal(store.paperAccount(user.id,broker).bookEquity,900);
  assert.equal((await execute(store,user,signal('overspend'))).status,'REJECTED');
  assert.equal((await execute(store,user,signal('affordable',{quantity:9}))).status,'FILLED');
  assert.equal(store.paperAccount(user.id,broker).cash,0);
});

test('profit increases available cash and no position cost is subtracted twice',async t=>{
  const {store,user}=fixture(t);
  await execute(store,user,signal('half',{quantity:5}));
  assert.equal(store.paperAccount(user.id,broker).cash,500);
  assert.equal((await execute(store,user,signal('other-half',{quantity:5}))).status,'FILLED');
  await execute(store,user,signal('profit',{side:'SELL',event:'TP',reduceOnly:true,referencePrice:110}));
  assert.equal(store.paperAccount(user.id,broker).cash,1100);
  assert.equal((await execute(store,user,signal('compound',{quantity:11}))).status,'FILLED');
});

test('fees, partial fills and retries journal cash once; invalid responses roll back every write',t=>{
  const {store,user}=fixture(t),row=claim(store,user,signal('fee',{quantity:9}));
  fill(store,row,4,400,'PARTIALLY_FILLED',1);fill(store,row,4,400,'PARTIALLY_FILLED',1);
  assert.equal(store.paperAccount(user.id,broker).cash,599);
  assert.throws(()=>fill(store,row,9,900,'UNRECOGNIZED',1),/Unknown broker/);
  assert.equal(store.paperAccount(user.id,broker).cash,599);
  assert.equal(store.db.prepare('SELECT count(*) n FROM paper_cash_journal').get().n,1);
  fill(store,row,9,900,'FILLED',1);
  assert.equal(store.paperAccount(user.id,broker).cash,98);
  const sell=claim(store,user,signal('sell',{quantity:9,side:'SELL',event:'SELL',reduceOnly:true}));
  fill(store,sell,9,900,'FILLED',1);
  assert.equal(store.paperAccount(user.id,broker).cash,997);assert.equal(store.paperAccount(user.id,broker).bookEquity,997);
});

test('fee-inclusive cash overdraft cannot be committed',t=>{
  const {store,user}=fixture(t),row=claim(store,user,signal('overdraft'));
  assert.throws(()=>fill(store,row,10,1000,'FILLED',1),/Insufficient Paper cash/);
  assert.equal(store.paperAccount(user.id,broker).cash,1000);assert.equal(store.listPositions(user.id).length,0);
});

test('zero cash cannot buy even a tiny quantity using floating-point tolerance',async t=>{
  const {store,user}=fixture(t);
  store.setRisk(user.id,{...policy(),balances:{[broker]:0}});
  assert.equal((await execute(store,user,signal('tiny',{quantity:1e-12}))).status,'REJECTED');
  assert.equal(store.paperAccount(user.id,broker).cash,0);
});

test('funding edits preserve PnL, are idempotent and reject withdrawing committed money',async t=>{
  const {store,user}=fixture(t);
  await execute(store,user,signal('buy'));await execute(store,user,signal('sell',{side:'SELL',event:'SL',reduceOnly:true,referencePrice:90}));
  store.setRisk(user.id,policy(1500));assert.equal(store.paperAccount(user.id,broker).cash,1400);
  const count=store.paperFunding(user.id,broker).length;store.setRisk(user.id,policy(1500));
  assert.equal(store.paperFunding(user.id,broker).length,count);
  await execute(store,user,signal('new',{quantity:10}));
  assert.throws(()=>store.setRisk(user.id,policy(500)),/withdrawal/);
  assert.equal(store.paperAccount(user.id,broker).configuredEquity,1500);
  assert.equal(store.risk(user.id,config.defaultRisk).equities[broker],1500);
});

test('funding preview is read-only and cash is isolated by Bot and broker',async t=>{
  const {store,user}=fixture(t),bot=store.createBot(user.id,'Child',policy(1000));
  await execute(store,user,signal('buy'));
  assert.equal(store.paperAccount(bot.id,broker).cash,1000);assert.equal(store.paperAccount(user.id,'binance-th').cash,0);
  assert.equal(store.paperAccount(user.id,broker,policy(2000)).cash,1000);
  assert.equal(store.paperAccount(user.id,broker).cash,0);
  assert.equal(store.paperFunding(user.id,broker).length,1);
});

test('restart before a Paper fill revalidates once; a second restart never duplicates the committed fill',async t=>{
  const f=fixture(t),row=claim(f.store,f.user,signal('interrupted'));f.store.persistIntent(row,{...row.payload,price:100});
  let reopened=f.reopen();assert.equal(reopened.listSignals(f.user.id)[0].status,'QUEUED');
  await new Worker({store:reopened,config}).tick();assert.equal(reopened.listSignals(f.user.id)[0].status,'FILLED');
  reopened=f.reopen();await new Worker({store:reopened,config}).tick();
  assert.equal(reopened.db.prepare('SELECT count(*) n FROM fills').get().n,1);assert.equal(reopened.paperAccount(f.user.id,broker).cash,0);
});

test('Paper recovery cancels an unfilled remainder without replaying partial cash movements',async t=>{
  const f=fixture(t),row=claim(f.store,f.user,signal('partial'));fill(f.store,row,4,400,'PARTIALLY_FILLED');
  const reopened=f.reopen();assert.equal(reopened.listSignals(f.user.id)[0].status,'CANCELED');
  assert.equal(reopened.paperAccount(f.user.id,broker).cash,600);assert.equal(reopened.listPositions(f.user.id)[0].quantity,4);
  assert.equal((await execute(reopened,f.user,signal('continue',{quantity:6}))).status,'FILLED');
  assert.equal(reopened.paperAccount(f.user.id,broker).cash,0);
});

test('Paper recovery still rejects stale signals and does not replay LIVE or LEGACY orders',async t=>{
  const f=fixture(t);claim(f.store,f.user,signal('stale',{timestamp:Date.now()-120000}));
  f.store.enqueue(f.user.id,signal('live'),'LIVE');f.store.claimNext();
  const reopened=f.reopen();await new Worker({store:reopened,config}).tick();
  const rows=reopened.listSignals(f.user.id);
  assert.equal(rows.find(row=>row.trade_id==='live').status,'UNKNOWN');
  assert.match(rows.find(row=>row.trade_id==='stale').error_message,/stale/);
  assert.equal(reopened.paperAccount(f.user.id,broker).cash,1000);
});

test('schema 8 migration backfills cash once and preserves fills, IDs and historical policies',async t=>{
  const f=fixture(t);await execute(f.store,f.user,signal('buy'));
  await execute(f.store,f.user,signal('sell',{side:'SELL',event:'SL',reduceOnly:true,referencePrice:90}));
  const ids=f.store.listSignals(f.user.id).map(row=>row.id),beforePolicy=f.store.risk(f.user.id,config.defaultRisk);
  f.store.db.exec('DROP TABLE paper_cash_journal; DROP TABLE paper_snapshots; DROP TABLE paper_funding; PRAGMA user_version=8');
  backupDatabase(f.filename,path.join(path.dirname(f.filename),'before-v9.db'));
  let reopened=f.reopen();assert.equal(reopened.paperAccount(f.user.id,broker).cash,900);
  assert.deepEqual(reopened.listSignals(f.user.id).map(row=>row.id),ids);
  assert.deepEqual(reopened.risk(f.user.id,config.defaultRisk),beforePolicy);
  assert.equal(reopened.paperFunding(f.user.id,broker)[0].kind,'LEGACY_BASELINE');
  reopened=f.reopen();assert.equal(reopened.paperAccount(f.user.id,broker).cash,900);
  assert.equal(reopened.db.prepare('SELECT count(*) n FROM paper_cash_journal').get().n,2);
  assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('recovery keeps inconsistent Paper fills quarantined instead of guessing balances',t=>{
  const f=fixture(t),row=claim(f.store,f.user,signal('corrupt'));fill(f.store,row,4,400,'PARTIALLY_FILLED');
  f.store.db.prepare('UPDATE paper_cash_journal SET cash_delta=-399 WHERE signal_id=?').run(row.id);
  const reopened=f.reopen();assert.equal(reopened.listSignals(f.user.id)[0].status,'UNKNOWN');
  assert.match(reopened.listSignals(f.user.id)[0].error_message,/ledger mismatch/);
});

test('funding cannot withdraw cash reserved by another pending Paper order',t=>{
  const {store,user}=fixture(t),row=claim(store,user,signal('reserved'));
  store.persistIntent(row,{...row.payload,price:100});
  assert.throws(()=>store.setRisk(user.id,policy(900)),/withdrawal/);
  assert.equal(store.paperAccount(user.id,broker).cash,1000);
});

test('rehearsal CLI migrates a verified copy while leaving the source schema and balances untouched',async t=>{
  const f=fixture(t);await execute(f.store,f.user,signal('buy',{quantity:5}));
  f.store.db.exec('DROP TABLE paper_cash_journal; DROP TABLE paper_snapshots; DROP TABLE paper_funding; PRAGMA user_version=8');
  const target=path.join(path.dirname(f.filename),'rehearsal.db'),originalArgv=process.argv;
  process.argv=[process.execPath,'scripts/rehearse-phase0.mjs',f.filename,target];
  try{await import(`../scripts/rehearse-phase0.mjs?test=${Date.now()}`);}finally{process.argv=originalArgv;}
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version,8);
  assert.equal(f.store.listPositions(f.user.id)[0].quantity,5);
  const copy=new Store(target);
  try{assert.equal(copy.paperAccount(f.user.id,broker).cash,500);assert.equal(copy.db.prepare('PRAGMA user_version').get().user_version,9);}
  finally{copy.close();}
});
