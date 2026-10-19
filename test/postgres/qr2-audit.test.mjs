import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {readQr2Account} from '../../src/postgres/qr2-reader.js';
import {writeQr2Audit,QR2_AUDIT_EVENT,QR2_AUDIT_MAX_KEYS} from '../../src/postgres/qr2-audit.js';
import {auditDedupKey} from '../../src/portfolio/qr2-labels.js';
import {createQr2Database,createOwner,createBot,book,insertBars,barOf,ledgerDigest,openSecond,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';

// QR-2 S2c (design T12; contract 6.7): the after-commit audit writer. Isolated local PostgreSQL only. The faults are labelled direct-SQL
// edits made by the test. The writer writes audit rows only and nothing else.
let fx,db,store;
before(async()=>{fx=await createQr2Database('robot_qr2_audit');({db,store}=fx);});
after(async()=>{await fx?.dispose();});

const rows=bot=>db.query("SELECT user_id,event,trade_id,details FROM public.audit WHERE user_id=$1 AND event=$2 ORDER BY id",[bot.id,QR2_AUDIT_EVENT]).then(r=>r.rows);
async function faultedBot(){
  const owner=await createOwner(store),bot=await createBot(store,owner,10000);bot.owner=owner;
  await db.query('DELETE FROM public.pine_market_bars');await insertBars(db,[barOf(Date.now()-1000,'62000')]);
  const buy=await book(store,bot,'a1-'+bot.id.slice(0,6),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(store,bot,'a2-'+bot.id.slice(0,6),{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  // Two distinct defects: a cost_basis drift (R7 for BTCUSDT) and a journal cash change (R2 for the BUY).
  await db.query('UPDATE public.ledger_positions SET cost_basis=cost_basis+0.000000000000000001 WHERE user_id=$1',[bot.id]);
  await db.query('UPDATE public.paper_cash_journal SET cash_delta=cash_delta+0.000000000000000001 WHERE signal_id=$1',[buy.id]);
  return bot;
}
const read=bot=>{const now=Date.now();return readQr2Account(store,{ownerId:bot.owner.id,botId:bot.id,broker:'binance-global',from:bot.created_at,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2});};

test('T12 one audit row per distinct defect after commit; a repeated call adds none; no ledger row changes',async()=>{
  const bot=await faultedBot();
  const view=await read(bot);
  const checks=[...new Set(view.audit_findings.map(f=>f.check))].sort();
  assert.ok(checks.includes('R2')&&checks.includes('R7'));
  assert.equal((await rows(bot)).length,0,'the reader itself writes no audit row');
  const before=await ledgerDigest(db,bot);
  const first=await writeQr2Audit(store,{findings:view.audit_findings,botId:bot.id,broker:'binance-global'});
  assert.equal(first.capped,false);assert.equal(first.skipped_existing,0);
  const written=await rows(bot);
  assert.equal(written.length,first.written);assert.equal(written.length,first.keys.length);
  assert.ok(written.length>=2);
  const expectedKeys=view.audit_findings.map(f=>auditDedupKey({method_id:'qr2-reader-v1',bot_id:bot.id,broker:'binance-global',check_id:f.check,first_row_key:f.event_key??f.position_id??f.symbol??''}));
  assert.deepEqual(new Set(written.map(r=>r.trade_id)),new Set(expectedKeys),'trade_id holds the dedup key');
  const detail=JSON.parse(written.find(r=>JSON.parse(r.details).check_id==='R7').details);
  assert.deepEqual([detail.bot_id,detail.broker,detail.method_id,detail.code],[bot.id,'binance-global','qr2-reader-v1','COST_DRIFT']);
  const after=await ledgerDigest(db,bot);
  assert.deepEqual({...after,audit:null},{...before,audit:null},'only the audit table changed');
  assert.notEqual(after.audit,before.audit);
  // A repeat (a second GET of the same view) adds none.
  const again=await writeQr2Audit(store,{findings:(await read(bot)).audit_findings,botId:bot.id,broker:'binance-global'});
  assert.deepEqual([again.written,again.skipped_existing],[0,first.written]);
  assert.equal((await rows(bot)).length,written.length);
});

test('T12 at most 20 distinct keys per call; the surplus is reported as capped, never written',async()=>{
  const owner=await createOwner(store),bot=await createBot(store,owner,1000);
  const findings=Array.from({length:30},(_,i)=>({check:'R2',code:'RECONCILIATION_FAILED',event_key:'9'+i+':1'}));
  const result=await writeQr2Audit(store,{findings:[...findings,...findings],botId:bot.id,broker:'binance-global'});
  assert.deepEqual([result.considered,result.capped,result.written],[30,true,QR2_AUDIT_MAX_KEYS]);
  assert.equal((await rows(bot)).length,20);
  assert.deepEqual(new Set((await rows(bot)).map(r=>JSON.parse(r.details).first_row_key)),new Set(findings.slice(0,20).map(f=>f.event_key)),'order of first appearance is kept');
  await assert.rejects(writeQr2Audit(store,{findings,botId:bot.id,broker:'binance-global',max:21}),{code:'QR2_INPUT_INVALID'});
  assert.equal((await writeQr2Audit(store,{findings:[],botId:bot.id,broker:'binance-global'})).written,0);
});

test('T12 two concurrent writers of one key give one row: with the key lock held elsewhere both wait, then the second sees the first row',async()=>{
  const owner=await createOwner(store),bot=await createBot(store,owner,1000);
  const findings=[{check:'R7',code:'COST_DRIFT',symbol:'BTCUSDT'}];
  const key=auditDedupKey({method_id:'qr2-reader-v1',bot_id:bot.id,broker:'binance-global',check_id:'R7',first_row_key:'BTCUSDT'});
  const holder=openSecond(fx);
  try{
    let writers;
    await holder.db.transaction(async()=>{
      await holder.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['qr2:audit:'+key]);
      writers=Promise.all([1,2].map(()=>writeQr2Audit(store,{findings,botId:bot.id,broker:'binance-global'})));
      await new Promise(resolve=>setTimeout(resolve,500));
      assert.equal((await rows(bot)).length,0,'both writers wait for the key lock');
    });
    const results=await writers;
    assert.equal(results.reduce((t,r)=>t+r.written,0),1);
    assert.equal((await rows(bot)).length,1);
  }finally{await holder.close();}
});

test('T12 the writer runs only after the read transaction: inside a transaction it is refused and a rolled-back request writes no audit row',async()=>{
  const owner=await createOwner(store),bot=await createBot(store,owner,1000);
  const findings=[{check:'R2',code:'RECONCILIATION_FAILED',event_key:'1:1'}];
  await assert.rejects(db.transaction(()=>writeQr2Audit(store,{findings,botId:bot.id,broker:'binance-global'}),{isolation:'SERIALIZABLE'}),{code:'QR2_AUDIT_OUTSIDE_TRANSACTION_REQUIRED'});
  // The hook is called only after COMMIT: a request that fails never calls it.
  let hook=false;
  await assert.rejects(db.transaction(async()=>{await db.query('SELECT 1');throw new Error('request failed');},{isolation:'SERIALIZABLE'}).then(()=>{hook=true;}));
  assert.equal(hook,false);
  assert.equal((await rows(bot)).length,0);
});

test('T12 Z1: two different RX incidents on one Bot are two audit rows; RX on journal and RX on fills stay distinct; a later incident is recorded, never skipped',async()=>{
  const owner=await createOwner(store),bot=await createBot(store,owner,10000);bot.owner=owner;
  const other=await createBot(store,await createOwner(store),5000);
  await db.query('DELETE FROM public.pine_market_bars');await insertBars(db,[barOf(Date.now()-1000,'62000')]);
  const buy=await book(store,bot,'z1a-'+bot.id.slice(0,6),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  const sell=await book(store,bot,'z1b-'+bot.id.slice(0,6),{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  // Incident one: the journal row of the BUY names another Bot.
  await db.query('UPDATE public.paper_cash_journal SET user_id=$2 WHERE signal_id=$1',[buy.id,other.id]);
  const view1=await read(bot);
  assert.equal(view1.refused,'QR2_CROSS_BOT_ROW');
  assert.equal(view1.audit_findings.length,1);
  const w1=await writeQr2Audit(store,{findings:view1.audit_findings,botId:bot.id,broker:'binance-global'});
  assert.deepEqual([w1.written,w1.skipped_existing],[1,0]);
  const again=await writeQr2Audit(store,{findings:(await read(bot)).audit_findings,botId:bot.id,broker:'binance-global'});
  assert.deepEqual([again.written,again.skipped_existing],[0,1],'the same incident is not written twice');
  // Incident two, later: the journal row of the SELL names another Bot. The first offending row is unchanged; the new row is a new audit key.
  await db.query('UPDATE public.paper_cash_journal SET user_id=$2 WHERE signal_id=$1',[sell.id,other.id]);
  const view2=await read(bot);
  assert.equal(view2.audit_findings.length,2);
  const w2=await writeQr2Audit(store,{findings:view2.audit_findings,botId:bot.id,broker:'binance-global'});
  assert.deepEqual([w2.written,w2.skipped_existing],[1,1],'the later incident is recorded, the first is skipped');
  const written=await rows(bot);
  assert.equal(written.length,2);
  assert.equal(new Set(written.map(r=>r.trade_id)).size,2);
  assert.equal(JSON.stringify(written).includes(other.id),false,'no foreign Bot id in the audit rows');
  // The source table is part of the key: the same check, code and row identity on journal and on fills give two keys.
  const hash64='0'.repeat(64);
  const split=await writeQr2Audit(store,{findings:[{check:'RX',code:'QR2_CROSS_BOT_ROW',table:'journal',event_key:'row:journal:'+hash64},{check:'RX',code:'QR2_CROSS_BOT_ROW',table:'fills',event_key:'row:fills:'+hash64}],botId:bot.id,broker:'binance-global'});
  assert.equal(split.written,2);
  assert.equal((await rows(bot)).length,4);
});
