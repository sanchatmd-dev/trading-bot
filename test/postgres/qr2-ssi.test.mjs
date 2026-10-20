import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readQr2Account} from '../../src/postgres/qr2-reader.js';
import {createQr2Database,createOwner,createBot,book,insertBars,barOf,openSecond,policyFor,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';

// QR-2 S3a SSI tests (R-F, RC-Q28; design S1 to S4). Isolated local PostgreSQL only, one file per process. Interleavings are made by promise
// gates inside the product calls (a wrapper on store.paperAccount) or by explicit pg clients; no sleep orders anything. The reader runs
// standalone, so it opens its own REPEATABLE READ, READ ONLY transaction (qr2-reader.js). The question: can the reader make a SERIALIZABLE
// funding request fail with 40001, and does the reader see one consistent state.
let fx,db,store,second;
before(async()=>{fx=await createQr2Database('robot_qr2_ssi');({db,store}=fx);second=openSecond(fx);});
after(async()=>{await second?.close();await fx?.dispose();});

const gate=()=>{let open;const promise=new Promise(r=>{open=r;});return {promise,open};};
// A store whose paperAccount stops once, after the real read, and tells the test it is waiting.
function pausing(base){
  const reached=gate(),hold=gate();let used=false;
  const real=base.paperAccount;
  const wrapped=Object.create(base);
  wrapped.paperAccount=async function(...args){
    const result=await real.apply(this,args);
    if(!used){used=true;reached.open();await hold.promise;}
    return result;
  };
  return {store:wrapped,reached:reached.promise,release:hold.open};
}
async function newBot(capital=10000){
  const owner=await createOwner(store),bot=await createBot(store,owner,capital);bot.owner=owner;
  await db.query('DELETE FROM public.pine_market_bars');await insertBars(db,[barOf(Date.now()-1000,'62000')]);
  return bot;
}
async function tradedBot(){
  const bot=await newBot();
  const tag=bot.id.slice(0,6);
  await book(store,bot,'ssi-b-'+tag,{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(store,bot,'ssi-s-'+tag,{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  await db.query('DELETE FROM public.pine_market_bars');await insertBars(db,[barOf(Date.now()-1000,'62000')]);
  return bot;
}
const readOf=(readerStore,bot)=>{const now=Date.now();return readQr2Account(readerStore,{ownerId:bot.owner.id,botId:bot.id,broker:'binance-global',from:bot.created_at,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2});};
const fence=async bot=>Number((await db.query('SELECT version FROM public.paper_ledger_fence WHERE user_id=$1',[bot.id])).rows[0]?.version??0);
const fundingMax=async bot=>Number((await db.query("SELECT COALESCE(max(id),0) AS m FROM public.paper_funding WHERE user_id=$1",[bot.id])).rows[0].m);
// F: the product funding path (setRisk -> recordFunding) as the API runs it: SERIALIZABLE, on the second pool.
const funding=(fStore,bot,capital)=>second.db.transaction(()=>fStore.setRisk(bot.id,policyFor(capital)),{isolation:'SERIALIZABLE'});
const settled=promise=>promise.then(value=>({ok:true,value}),error=>({ok:false,error}));

test('S1 product path: a funding request paused after its first read commits without 40001 while the reader runs entirely inside it',async()=>{
  const bot=await tradedBot();
  const before=await fence(bot),idBefore=await fundingMax(bot);
  const F=pausing(second.store);
  const f=settled(funding(F.store,bot,12000));
  await F.reached;
  // The reader starts, reads and computes while F holds its snapshot, its users lock and its uncommitted fence bump.
  const view=await readOf(store,bot);
  assert.equal(view.reader.isolation,'repeatable read');assert.equal(view.reader.read_only,true);
  assert.equal(view.cutoffs.max_funding_id,idBefore,'the reader sees the state before F');
  assert.equal(view.performance.nav_to.nav,'10016');
  F.release();
  const done=await f;
  assert.equal(done.ok,true,'F committed: '+(done.error?.code||''));
  assert.equal(await fence(bot),before+1,'the fence changed only by F');
  assert.ok(await fundingMax(bot)>idBefore);
  const later=await readOf(store,bot);
  assert.equal(later.cutoffs.max_funding_id,await fundingMax(bot));
  assert.equal(later.performance.nav_to.cash,'11644','F added 2000 of capital: 9644 + 2000');
});

test('S1 the reader spans the whole of F: a snapshot opened before F commits keeps one consistent state; F commits without 40001',async()=>{
  const bot=await tradedBot();
  const before=await fence(bot),idBefore=await fundingMax(bot);
  const F=pausing(second.store),R=pausing(store);
  const f=settled(funding(F.store,bot,13000));
  await F.reached;
  const r=settled(readOf(R.store,bot));
  await R.reached;                       // the reader is inside its snapshot, after its earlier reads, before its later reads
  F.release();
  const done=await f;                    // F inserts and commits while the reader still holds its snapshot
  assert.equal(done.ok,true,'F committed: '+(done.error?.code||''));
  assert.ok(await fundingMax(bot)>idBefore,'F is committed and visible to others');
  R.release();
  const result=await r;
  assert.equal(result.ok,true,'the reader finished: '+(result.error?.code||''));
  const view=result.value;
  assert.equal(view.cutoffs.max_funding_id,idBefore,'one snapshot: nothing of F is visible to the reader');
  assert.equal(view.cutoffs.max_snapshot_id,Math.max(...view.rows.snapshots.map(s=>Number(s.id))));
  assert.equal(view.gates.gates.R4.ok,true,'cash from the later read and the replayed funding agree');
  assert.equal(view.performance.nav_to.cash,'9644');
  assert.equal(await fence(bot),before+1);
});

test('S1 reverse order: F starts after the reader is inside its snapshot; both finish with no 40001',async()=>{
  const bot=await tradedBot();
  const idBefore=await fundingMax(bot);
  const R=pausing(store);
  const r=settled(readOf(R.store,bot));
  await R.reached;
  const done=await settled(funding(second.store,bot,14000));
  assert.equal(done.ok,true,'F committed: '+(done.error?.code||''));
  R.release();
  const result=await r;
  assert.equal(result.ok,true);assert.equal(result.value.cutoffs.max_funding_id,idBefore);
  assert.equal(result.value.performance.nav_to.cash,'9644');
});

test('S3 fills: a READ COMMITTED fill writer (recordExecution) never gets 40001 beside the reader and the reader keeps its snapshot',async()=>{
  const bot=await tradedBot();
  const before=await fence(bot);
  const R=pausing(store);
  const r=settled(readOf(R.store,bot));
  await R.reached;
  const booked=await settled(book(second.store,bot,'ssi-late-'+bot.id.slice(0,6),{side:'BUY',steps:[{qty:'0.001',quote:'60'}]}));
  assert.equal(booked.ok,true,'the fill committed: '+(booked.error?.code||''));
  R.release();
  const result=await r;
  assert.equal(result.ok,true);
  assert.equal(result.value.cutoffs.fill_count,2,'the late fill is not in the reader snapshot');
  assert.ok(await fence(bot)>before,'the fill writer bumped the fence');
  assert.equal((await readOf(store,bot)).cutoffs.fill_count,3);
});

test('S4 no lock: while the reader holds its snapshot another client takes the users row lock at once and the fence row is untouched',async()=>{
  const bot=await tradedBot();
  const before=await fence(bot);
  const R=pausing(store);
  const r=settled(readOf(R.store,bot));
  await R.reached;
  const client=new pg.Client({connectionString:(()=>{const u=new URL(process.env.TEST_DATABASE_URL);u.pathname='/'+fx.name;return u.toString();})()});
  await client.connect();
  try{
    await client.query('BEGIN');
    const locked=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT',[bot.id]);
    assert.equal(locked.rowCount,1,'NOWAIT succeeds: the reader holds no users lock');
    const fenceLocked=await client.query('SELECT version FROM public.paper_ledger_fence WHERE user_id=$1 FOR UPDATE NOWAIT',[bot.id]);
    assert.equal(fenceLocked.rowCount,1,'and no fence lock');
    await client.query('ROLLBACK');
  }finally{await client.end();}
  R.release();
  assert.equal((await r).ok,true);
  assert.equal(await fence(bot),before,'the reader did not bump the fence');
});

/* ------------------------------------------------------------------ S2: the literal R-F case */

// The read-only anomaly (Fekete et al.): F (funding, reads the Bot's signals) -rw-> T3 (a SERIALIZABLE API write to a signal F read, commits
// first) -wr-> R (reads T3's write and misses F's funding row) -rw-> F. R is a SERIALIZABLE reader here, which is NOT the product reader; this is
// the shape of design decision D1 option A. The test asserts only what must hold and records the observed outcome for root.
const clientOf=async()=>{
  const u=new URL(process.env.TEST_DATABASE_URL);u.pathname='/'+fx.name;
  const c=new pg.Client({connectionString:u.toString()});await c.connect();return c;
};
async function anomaly(variant,t){
  const bot=await tradedBot();
  const signal=(await db.query('SELECT id FROM signals WHERE user_id=$1 ORDER BY id LIMIT 1',[bot.id])).rows[0].id;
  const baseFunding=Number((await db.query('SELECT count(*) AS n FROM public.paper_funding WHERE user_id=$1',[bot.id])).rows[0].n);
  const [F,T3,R]=[await clientOf(),await clientOf(),await clientOf()];
  const outcome={F:null,T3:null,R:null};
  const step=async(who,client,sql,params=[])=>{
    if(outcome[who])return null;
    try{return await client.query(sql,params);}
    catch(error){outcome[who]={step:sql.slice(0,40),code:error.code};await client.query('ROLLBACK').catch(()=>{});return null;}
  };
  try{
    await step('F',F,'BEGIN ISOLATION LEVEL SERIALIZABLE');
    await step('F',F,'SELECT id,status FROM signals WHERE user_id=$1',[bot.id]);
    await step('T3',T3,'BEGIN ISOLATION LEVEL SERIALIZABLE');
    await step('T3',T3,"UPDATE signals SET review_note='t3' WHERE id=$1",[signal]);
    await step('T3',T3,'COMMIT');
    if(variant==='read-only-after-first-query'){
      await step('R',R,'BEGIN ISOLATION LEVEL SERIALIZABLE');
      await step('R',R,'SELECT 1');
      await step('R',R,'SET TRANSACTION READ ONLY');
    }else await step('R',R,'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
    const sawT3=await step('R',R,'SELECT review_note FROM signals WHERE id=$1',[signal]);
    const sawF=await step('R',R,'SELECT count(*) AS n FROM public.paper_funding WHERE user_id=$1',[bot.id]);
    await step('R',R,'COMMIT');
    await step('F',F,"INSERT INTO public.paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,1000,1000,'CONFIGURATION')",[bot.id,Date.now()]);
    await step('F',F,'COMMIT');
    assert.equal(sawT3?.rows[0]?.review_note,outcome.R?undefined:'t3','R saw T3 when it ran');
    assert.equal(Number(sawF?.rows[0]?.n),outcome.R?undefined:baseFunding,'R missed F when it ran');
  }finally{await Promise.all([F,T3,R].map(c=>c.end().catch(()=>{})));}
  const fundingNow=Number((await db.query('SELECT count(*) AS n FROM public.paper_funding WHERE user_id=$1',[bot.id])).rows[0].n);
  const failed=Object.entries(outcome).filter(([,v])=>v).map(([who,v])=>who+':'+v.code);
  // Whatever PostgreSQL decided: only serialization failures, at most one of F and R fails, and F's row exists exactly when F did not fail.
  for(const v of Object.values(outcome))if(v)assert.equal(v.code,'40001');
  assert.ok(!(outcome.F&&outcome.R),'at most one of F and R is the victim');
  assert.equal(outcome.T3,null,'T3 committed first and is never the victim');
  assert.equal(fundingNow,baseFunding+(outcome.F?0:1));
  t.diagnostic(`SSI ${variant}: victims=[${failed.join(',')||'none'}] (F fails at: ${outcome.F?.step??'-'}; R fails at: ${outcome.R?.step??'-'})`);
  return {outcome,failed};
}

test('S2(a) a SERIALIZABLE reader made READ ONLY after its first query (decision D1 option A): outcome recorded',async t=>{
  const {failed}=await anomaly('read-only-after-first-query',t);
  assert.ok(failed.length<=1);
});
test('S2(b) BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY: outcome recorded',async t=>{
  const {failed}=await anomaly('serializable-read-only',t);
  assert.ok(failed.length<=1);
});
test('S2 the product reader (REPEATABLE READ) in the same triad: nobody fails and the reader still sees one snapshot',async t=>{
  const bot=await tradedBot();
  const signal=(await db.query('SELECT id FROM signals WHERE user_id=$1 ORDER BY id LIMIT 1',[bot.id])).rows[0].id;
  const idBefore=await fundingMax(bot);
  const [F,T3]=[await clientOf(),await clientOf()];
  try{
    await F.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await F.query('SELECT id FROM signals WHERE user_id=$1',[bot.id]);
    await T3.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await T3.query("UPDATE signals SET review_note='t3' WHERE id=$1",[signal]);await T3.query('COMMIT');
    const view=await readOf(store,bot);                 // REPEATABLE READ, READ ONLY: takes no SIREAD lock
    assert.equal(view.reader.isolation,'repeatable read');
    await F.query("INSERT INTO public.paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,1000,1000,'CONFIGURATION')",[bot.id,Date.now()]);
    await F.query('COMMIT');                             // must not fail: the reader is invisible to SSI
    // One snapshot: the view was read before F inserted, so the funding cutoff is the id before F and the cash is the cash before F.
    assert.equal(view.cutoffs.max_funding_id,idBefore,'the reader snapshot ends before F');
    assert.equal(view.performance.nav_to.cash,'9644');
    assert.ok(await fundingMax(bot)>idBefore,'F is committed');
  }finally{await F.end();await T3.end();}
  t.diagnostic('SSI product reader: F committed with no 40001');
});
