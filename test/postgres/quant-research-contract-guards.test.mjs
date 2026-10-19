import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {engineHash} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {contentDigest,DATASET_BINDING_STEP_ID} from '../../src/quant-research/research-contract-v2.js';
import {config} from '../../src/config.js';
import {source} from '../helpers/quant-research-fixture.mjs';
import {scripted} from '../helpers/quant-research-clauses-fixture.mjs';
import {createModeDatabase,seedGuardDeployment,withTriggerDisabled,triggerState,continuation} from '../helpers/quant-research-contract-guards-fixture.mjs';

/**
 * F06-01 contract-guard tests for the QL-3A durable research jobs (docs/QL_3A_DURABLE_JOBS.md "Immutable contract" and
 * "every write checks engine"), in LEGACY and FOUNDATION executor mode:
 * J1 the frozen contract snapshot and its hash: freeze at enqueue, database immutability, hash recheck before each step,
 *    refusal on a mismatch with the exact code;
 * J7 the engine guard: an engine fingerprint change fails a queued, running or resumed job closed and writes no step.
 * Graceful-stop recovery (DJ:76, defect D1) is an open owner decision and is deliberately not asserted here.
 * Expected values are literals on purpose. Evaluators are stubs; metrics establish engineering behaviour only.
 */
let admin,L,F;
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 L=await createModeDatabase({admin,foundation:false,label:'legacy'});
 F=await createModeDatabase({admin,foundation:true,label:'foundation'});
});
after(async()=>{
 if(L)await L.close();
 if(F)await F.close();
 await admin?.close();
});

const DRIFTED_ENGINE='d'.repeat(64);
const OLD_ENGINE='a'.repeat(64);
const seed=async ctx=>{const x=await seedGuardDeployment({db:ctx.db,store:ctx.store,now:ctx.now});ctx.now=x.now;return x;};
const enqueue=(ctx,x,key=randomUUID())=>ctx.db.transaction(()=>ctx.service.enqueue(x.a,x.body,key));
const cancel=(ctx,owner,runId)=>ctx.db.transaction(()=>ctx.service.get(owner,runId,true));
const runRow=(ctx,runId)=>ctx.db.prepare('SELECT * FROM quant_jobs WHERE run_id=?').get(runId);
const stepCount=async(ctx,runId)=>Number((await ctx.db.prepare('SELECT count(*) n FROM quant_job_steps WHERE run_id=?').get(runId)).n);
const foundationRow=async(ctx,runId)=>(await ctx.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[runId])).rows[0];
const chunkRows=async(ctx,runId)=>(await ctx.db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id<>$2 ORDER BY step_id',[runId,DATASET_BINDING_STEP_ID])).rows;
/** Cancels every job still open in the database, then lets the worker prove its own stop so that the shared foundation slot is released. */
async function settle(ctx,worker){
 const open=(await ctx.db.query("SELECT run_id,owner_id FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')")).rows;
 for(const row of open)await cancel(ctx,row.owner_id,row.run_id);
 if(worker?.reconcile)await worker.reconcile();
}
const slotBusy=async ctx=>Number((await ctx.db.query("SELECT count(*) n FROM quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')")).rows[0].n);
/** No other job may be runnable, so that the worker under test can only pick the job under test. */
const onlyRunnable=async(ctx,runId)=>assert.equal(Number((await ctx.db.prepare("SELECT count(*) n FROM quant_jobs WHERE status IN ('QUEUED','RUNNING') AND run_id<>?").get(runId)).n),0);

const legacyWorker=evaluate=>new QuantResearchWorker({service:L.service,evaluate,clock:()=>L.now});
const foundationWorker=(evaluateChunk,leaseMs)=>new QuantResearchFoundationWorker({service:F.service,clock:()=>F.now,health:async()=>({ok:true}),evaluateChunk,stopUnit:async()=>true,leaseMs});
/** Engine fingerprint seam: the same instance-level replacement that the accepted P9 foundation test uses. */
function engineDrift(worker){
 const original=worker.engineHash.bind(worker),state={on:false};
 worker.engineHash=async()=>state.on?DRIFTED_ENGINE:original();
 return state;
}
const preparedClaim=async worker=>{
 const job=await worker.claim();assert.ok(job,'worker claimed the queued job');
 worker.controller=new AbortController();
 return worker.prepareResearch(job);
};

/** Every identity, contract and deadline column of quant_jobs is refused by the database trigger, row unchanged; a free column is not. */
async function assertQuantJobImmutable(ctx,runId,foreign){
 const before=(await ctx.db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0];
 const forged={...before.contract,engine_hash:OLD_ENGINE};
 const attempts=[
  ['run_id',randomUUID()],['owner_id',foreign.a],['bot_id',foreign.a],['deployment_id',foreign.body.deployment_id],
  ['idempotency_key','forged-key-0001'],['submission_hash','f'.repeat(64)],['contract_hash','f'.repeat(64)],
  ['contract',JSON.stringify(forged)],['created_at',before.created_at+1],['deadline',before.deadline+1]
 ];
 for(const [column,value] of attempts){
  await assert.rejects(ctx.db.query('UPDATE quant_jobs SET '+column+'=$1 WHERE run_id=$2',[value,runId]),/Quant run contract is immutable/,column+' is immutable');
  assert.deepEqual((await ctx.db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0],before,column+' left unchanged');
 }
 // A forger who also recomputes the hash is refused too: the trigger does not trust the hash.
 await assert.rejects(ctx.db.query('UPDATE quant_jobs SET contract=$1,contract_hash=$2 WHERE run_id=$3',[JSON.stringify(forged),hash(canonical(forged)),runId]),/Quant run contract is immutable/);
 assert.deepEqual((await ctx.db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0],before);
 // Control: runtime columns stay writable, so the refusals above come from the guard and not from a broken update.
 await ctx.db.query('UPDATE quant_jobs SET updated_at=updated_at+1 WHERE run_id=$1',[runId]);
 assert.equal((await ctx.db.query('SELECT updated_at FROM quant_jobs WHERE run_id=$1',[runId])).rows[0].updated_at,before.updated_at+1);
}

// ---- J1 LEGACY ------------------------------------------------------------------------------------------------------------------
test('J1 LEGACY: enqueue freezes source bytes, snapshot, capital, dataset and engine; each equals its record; later edits never reach the contract',async()=>{
 const x=await seed(L),queued=await enqueue(L,x);
 try{
  const row=await runRow(L,queued.run_id),c=row.contract,{start_time:start,end_time:end}=x.body.dataset;
  const deployment=await L.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(x.body.deployment_id);
  const stored=await L.db.prepare('SELECT source FROM pine_sources WHERE pine_import_id=?').get(deployment.pine_import_id);
  const bars=(await L.db.query("SELECT * FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=$1 AND bar_time<=$2 ORDER BY bar_time",[start,end])).rows;
  assert.equal(c.version,'ql3a-research-job-v1');assert.equal(Object.hasOwn(c,'execution_backend'),false);
  assert.equal(c.source,source);assert.equal(c.source,stored.source,'frozen source bytes equal the stored source');
  assert.equal(c.source_hash,hash(source));assert.equal(c.baseline_snapshot_hash,deployment.snapshot_hash);
  assert.deepEqual(c.snapshot.policy,deployment.snapshot.policy);assert.equal(c.snapshot.policy_hash,deployment.snapshot.policy_hash);
  assert.equal(c.snapshot.policy.paperTrading,true);assert.equal(c.snapshot.policy.requireReduceOnlySell,true);
  assert.deepEqual(c.snapshot.capital,deployment.snapshot.capital);
  const capital=deployment.snapshot.capital.find(a=>a.broker==='binance-global');
  assert.deepEqual(c.capital,{equity:capital.configuredEquity,cash:capital.configuredBalance});
  assert.deepEqual(c.capital,{equity:'1000',cash:'800'},'equity and cash are frozen as two distinct values');
  assert.equal(c.owner_id,x.a);assert.equal(c.bot_id,x.a);assert.equal(c.deployment_id,x.body.deployment_id);
  assert.equal(c.plan.planned_candidates,25);assert.equal(c.max_evaluations,50);
  assert.equal(c.dataset.bar_count,3250);assert.equal(bars.length,3250);
  assert.deepEqual(c.dataset.bars,bars.map(r=>r.bar),'frozen candles equal the stored candles');
  assert.equal(c.dataset.sha256,hash(canonical(bars.map(r=>({bar:r.bar,content_hash:r.content_hash,provenance:r.provenance})))));
  assert.deepEqual([c.dataset.start_time,c.dataset.end_time,c.dataset.warmup_bars],[start,end,1250]);
  assert.deepEqual(c.split,{warmup:1250,train_end:2450,validation_end:2850,test_end:3250});
  assert.equal(c.engine_hash,await engineHash(false));assert.match(c.engine_hash,/^[a-f0-9]{64}$/);
  assert.notEqual(c.engine_hash,await engineHash(true),'LEGACY and FOUNDATION fingerprint different file sets');
  assert.equal(row.contract_hash,hash(canonical(c)));assert.equal(queued.contract_hash,row.contract_hash);
  assert.equal(queued.source_hash,c.source_hash);assert.equal(queued.dataset_hash,c.dataset.sha256);
  // Edits after enqueue (market candle, risk policy) never reach the frozen contract or its hash.
  const time=bars[0].bar_time,changedBar={...bars[0].bar,volume:'2'};
  try{
   await L.db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',[time,JSON.stringify(changedBar),hash(canonical(changedBar))]);
   const policy=await L.store.risk(x.a,config.defaultRisk);await L.store.setRisk(x.a,{...policy,maxDailyLossR:policy.maxDailyLossR+1});
   const after=await runRow(L,queued.run_id);
   assert.deepEqual(after.contract,c);assert.equal(after.contract_hash,row.contract_hash);
  }finally{await L.db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',[time,JSON.stringify(bars[0].bar),bars[0].content_hash]);}
 }finally{await settle(L);}
});

test('J1 LEGACY: the database refuses every identity, contract and deadline edit of a queued job, even with a recomputed hash',async()=>{
 const x=await seed(L),foreign=await seed(L),queued=await enqueue(L,x);
 try{await assertQuantJobImmutable(L,queued.run_id,foreign);}finally{await settle(L);}
});

test('J1 LEGACY: a changed contract or hash fails the hash recheck with RESEARCH_CONTRACT_CHANGED before any evaluation, step or result',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({}),worker=legacyWorker(script.evaluate);
 try{
  await onlyRunnable(L,queued.run_id);
  const job=await worker.claim();worker.controller=new AbortController();
  assert.equal(job.run_id,queued.run_id);assert.equal(job.contract_hash,hash(canonical(job.contract)));
  const parameters=job.contract.plan.candidates[0];
  const forged={
   'raised evaluation budget':{...job,contract:{...job.contract,max_evaluations:job.contract.max_evaluations+1000}},
   'edited source':{...job,contract:{...job.contract,source:job.contract.source+'\n// edited'}},
   'swapped hash':{...job,contract_hash:'0'.repeat(64)}
  };
  for(const [name,tampered] of Object.entries(forged)){
   await assert.rejects(worker.current(tampered),{code:'RESEARCH_CONTRACT_CHANGED'},name+': current');
   await assert.rejects(worker.step(tampered,'candidate:000','CANDIDATE',parameters),{code:'RESEARCH_CONTRACT_CHANGED'},name+': step');
   await assert.rejects(worker.finish(tampered,'SUCCEEDED',{forged:true}),{code:'RESEARCH_CONTRACT_CHANGED'},name+': finish');
  }
  assert.equal(script.calls.length,0,'no evaluation started on a forged contract');
  assert.equal(await stepCount(L,job.run_id),0);
  const row=await runRow(L,job.run_id);
  assert.equal(row.status,'RUNNING');assert.equal(row.result,null);assert.equal(row.evaluations_started,0);assert.equal(row.lease_token,job.lease_token);
  // Control: the untouched job passes the same gate, so the refusals above come from the hash check.
  await worker.current(job);
  await worker.step(job,'candidate:000','CANDIDATE',parameters);
  assert.equal(script.calls.length,1);assert.equal(await stepCount(L,job.run_id),1);assert.equal((await runRow(L,job.run_id)).evaluations_started,1);
 }finally{await settle(L);}
});

test('J1 LEGACY: a contract changed during an evaluation is caught at the commit recheck; the step is not written',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({});
 let job;
 const worker=legacyWorker((contract,parameters,kind)=>{
  job.contract={...job.contract,max_evaluations:job.contract.max_evaluations+1000};
  return script.evaluate(contract,parameters,kind);
 });
 try{
  await onlyRunnable(L,queued.run_id);
  job=await worker.claim();worker.controller=new AbortController();
  await assert.rejects(worker.step(job,'candidate:000','CANDIDATE',job.contract.plan.candidates[0]),{code:'RESEARCH_CONTRACT_CHANGED'});
  assert.equal(script.calls.length,1,'the evaluation ran, only its commit was refused');
  assert.equal(await stepCount(L,job.run_id),0);
 }finally{await settle(L);}
});

test('J1 LEGACY: a stored job whose hash no longer matches its contract fails closed on the first step through the real worker',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({}),worker=legacyWorker(script.evaluate);
 try{
  // A privileged edit with the guard trigger paused; the guard is verified to be back before the worker runs.
  await withTriggerDisabled(L.db,'quant_jobs','quant_job_contract_immutable',()=>L.db.query('UPDATE quant_jobs SET contract_hash=$1 WHERE run_id=$2',['0'.repeat(64),queued.run_id]));
  assert.equal(await triggerState(L.db,'quant_jobs','quant_job_contract_immutable'),'O');
  await assert.rejects(L.db.query('UPDATE quant_jobs SET contract_hash=$1 WHERE run_id=$2',['1'.repeat(64),queued.run_id]),/Quant run contract is immutable/);
  await onlyRunnable(L,queued.run_id);
  assert.equal(await worker.tick(),true);
  const row=await runRow(L,queued.run_id);
  assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'RESEARCH_CONTRACT_CHANGED');
  assert.equal(script.calls.length,0);assert.equal(await stepCount(L,queued.run_id),0);assert.equal(row.evaluations_started,0);assert.equal(row.result,null);
 }finally{await settle(L);}
});

// ---- J7 LEGACY ------------------------------------------------------------------------------------------------------------------
test('J7 LEGACY: a queued job frozen under an earlier engine fails closed with QUANT_ENGINE_CHANGED and starts nothing',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({}),worker=legacyWorker(script.evaluate);
 try{
  const row=await runRow(L,queued.run_id);
  assert.equal(row.contract.engine_hash,await engineHash(false),'control: enqueue froze the current engine');
  // Simulates a job queued before an engine file changed: consistent contract and hash, older engine fingerprint.
  const older={...row.contract,engine_hash:OLD_ENGINE};
  await withTriggerDisabled(L.db,'quant_jobs','quant_job_contract_immutable',()=>L.db.query('UPDATE quant_jobs SET contract=$1,contract_hash=$2 WHERE run_id=$3',[JSON.stringify(older),hash(canonical(older)),queued.run_id]));
  await onlyRunnable(L,queued.run_id);
  assert.equal(await worker.tick(),true);
  const done=await runRow(L,queued.run_id);
  assert.equal(done.status,'FAILED');assert.equal(done.diagnostic,'QUANT_ENGINE_CHANGED');assert.equal(done.attempt,1);
  assert.equal(script.calls.length,0);assert.equal(await stepCount(L,queued.run_id),0);assert.equal(done.evaluations_started,0);assert.equal(done.result,null);
 }finally{await settle(L);}
});

test('J7 LEGACY: a job resumed after lease expiry under a changed engine fails closed; completed checkpoints stay and nothing new is written',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({});
 let first,calls=0;
 first=legacyWorker((contract,parameters,kind)=>{
  if(++calls===4){first.controller.abort();throw Error('worker lost');}
  return script.evaluate(contract,parameters,kind);
 });
 try{
  await onlyRunnable(L,queued.run_id);
  assert.equal(await first.tick(),true);
  const lost=await runRow(L,queued.run_id);
  assert.equal(lost.status,'RUNNING','an aborted worker leaves the row for recovery');assert.equal(await stepCount(L,queued.run_id),3);assert.equal(lost.evaluations_started,4);
  L.now+=31000;
  const resumedScript=scripted({}),second=legacyWorker(resumedScript.evaluate),drift=engineDrift(second);drift.on=true;
  assert.equal(await second.tick(),true);
  const done=await runRow(L,queued.run_id);
  assert.equal(done.status,'FAILED');assert.equal(done.diagnostic,'QUANT_ENGINE_CHANGED');assert.equal(done.attempt,2,'the job was recovered and claimed again before it was refused');
  assert.equal(resumedScript.calls.length,0);assert.equal(await stepCount(L,queued.run_id),3,'checkpoints kept, no step added');assert.equal(done.evaluations_started,4);
 }finally{await settle(L);}
});

test('J7 LEGACY: a fully checkpointed job resumed under a changed engine publishes no result',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({});
 const first=legacyWorker(script.evaluate);
 // Process loss after the last step commit and before the result is published: every finish attempt of this worker fails.
 first.finish=async()=>{throw Error('simulated process loss before publication');};
 try{
  await onlyRunnable(L,queued.run_id);
  assert.equal(await first.tick(),true);
  const lost=await runRow(L,queued.run_id),committed=await stepCount(L,queued.run_id);
  assert.equal(lost.status,'RUNNING');assert.equal(lost.result,null);
  assert.equal(committed,script.calls.length);assert.ok(committed>25,'candidates and every check are checkpointed');
  L.now+=31000;
  const resumedScript=scripted({}),second=legacyWorker(resumedScript.evaluate),drift=engineDrift(second);drift.on=true;
  assert.equal(await second.tick(),true);
  const done=await runRow(L,queued.run_id);
  assert.equal(done.status,'FAILED');assert.equal(done.diagnostic,'QUANT_ENGINE_CHANGED');assert.equal(done.result,null,'no research result under a changed engine');
  assert.equal(resumedScript.calls.length,0);assert.equal(await stepCount(L,queued.run_id),committed);
 }finally{await settle(L);}
});

test('J7 LEGACY: an engine change after one committed step is refused before the next evaluation starts',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({}),worker=legacyWorker(script.evaluate),drift=engineDrift(worker);
 const step=worker.step.bind(worker);
 worker.step=async(...args)=>{const result=await step(...args);if(args[1]==='candidate:000')drift.on=true;return result;};
 try{
  await onlyRunnable(L,queued.run_id);
  assert.equal(await worker.tick(),true);
  const done=await runRow(L,queued.run_id);
  assert.equal(done.status,'FAILED');assert.equal(done.diagnostic,'QUANT_ENGINE_CHANGED');
  assert.equal(script.calls.length,1,'the second evaluation never started');
  assert.equal(await stepCount(L,queued.run_id),1);assert.equal(done.evaluations_started,1);
 }finally{await settle(L);}
});

test('J7 LEGACY: an engine change during an evaluation is refused at the commit; the step is not written',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),script=scripted({});
 let drift;
 const worker=legacyWorker((contract,parameters,kind)=>{drift.on=true;return script.evaluate(contract,parameters,kind);});
 drift=engineDrift(worker);
 try{
  await onlyRunnable(L,queued.run_id);
  assert.equal(await worker.tick(),true);
  const done=await runRow(L,queued.run_id);
  assert.equal(done.status,'FAILED');assert.equal(done.diagnostic,'QUANT_ENGINE_CHANGED');
  assert.equal(script.calls.length,1,'the evaluation ran, only its commit was refused');
  assert.equal(await stepCount(L,queued.run_id),0);assert.equal(done.evaluations_started,1);
 }finally{await settle(L);}
});

// ---- J1 FOUNDATION --------------------------------------------------------------------------------------------------------------
test('J1 FOUNDATION: enqueue freezes source bytes, snapshot, capital, range/digest and engine; each equals its record; request and binding agree',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);
 try{
  const row=await runRow(F,queued.run_id),c=row.contract,{start_time:start,end_time:end}=x.body.dataset;
  const deployment=await F.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(x.body.deployment_id);
  const stored=await F.db.prepare('SELECT source FROM pine_sources WHERE pine_import_id=?').get(deployment.pine_import_id);
  const bars=(await F.db.query("SELECT * FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=$1 AND bar_time<=$2 ORDER BY bar_time",[start,end])).rows;
  assert.equal(c.version,'ql3a-research-job-v2');assert.equal(c.execution_backend,'quant-foundation-v1');
  assert.equal(c.source,source);assert.equal(c.source,stored.source);assert.equal(c.source_hash,hash(source));
  assert.equal(c.baseline_snapshot_hash,deployment.snapshot_hash);
  assert.deepEqual(c.snapshot.policy,deployment.snapshot.policy);assert.equal(c.snapshot.policy_hash,deployment.snapshot.policy_hash);
  const capital=deployment.snapshot.capital.find(a=>a.broker==='binance-global');
  assert.deepEqual(c.capital,{equity:capital.configuredEquity,cash:capital.configuredBalance});
  assert.deepEqual(c.capital,{equity:'1000',cash:'800'},'equity and cash are frozen as two distinct values');
  assert.equal(c.owner_id,x.a);assert.equal(c.bot_id,x.a);assert.equal(c.deployment_id,x.body.deployment_id);
  assert.equal(Object.hasOwn(c.dataset,'bars'),false,'V2 freezes range and digest, not candles');
  assert.equal(c.dataset.bar_count,3250);assert.equal(bars.length,3250);
  assert.deepEqual([c.dataset.start_time,c.dataset.end_time,c.dataset.warmup_bars],[start,end,1250]);
  assert.equal(c.dataset.content_digest,contentDigest(bars));assert.match(c.dataset.content_digest,/^[a-f0-9]{64}$/);
  assert.equal(c.engine_hash,await engineHash(true));assert.notEqual(c.engine_hash,await engineHash(false));
  assert.equal(row.contract_hash,hash(canonical(c)));assert.equal(queued.contract_hash,row.contract_hash);
  assert.equal(queued.dataset_content_digest,c.dataset.content_digest);assert.equal(queued.dataset_prepared,false);
  const binding=(await F.db.query('SELECT * FROM quant_research_foundation WHERE run_id=$1',[queued.run_id])).rows[0];
  assert.equal(binding.contract_hash,row.contract_hash);assert.equal(binding.job_id,queued.run_id);
  const request=await foundationRow(F,queued.run_id);
  assert.equal(request.contract_hash,hash(canonical(request.contract)));
  assert.equal(request.contract.engine_hash,c.engine_hash,'the scheduler request carries the same frozen engine');
  assert.equal(request.contract.bot_id,x.a);
  // A candle edit after enqueue never reaches the frozen range/digest or the hash.
  const time=bars[0].bar_time,changedBar={...bars[0].bar,volume:'2'};
  try{
   await F.db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',[time,JSON.stringify(changedBar),hash(canonical(changedBar))]);
   const after=await runRow(F,queued.run_id);
   assert.deepEqual(after.contract,c);assert.equal(after.contract_hash,row.contract_hash);
  }finally{await F.db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',[time,JSON.stringify(bars[0].bar),bars[0].content_hash]);}
 }finally{await settle(F);}
});

test('J1 FOUNDATION: the database refuses edits of the research contract, the scheduler request and the binding',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),foreign=await seed(F),queued=await enqueue(F,x);
 try{
  await assertQuantJobImmutable(F,queued.run_id,foreign);
  const before=await foundationRow(F,queued.run_id);
  const forged={...before.contract,engine_hash:OLD_ENGINE};
  const attempts=[
   ['job_id',randomUUID()],['owner_id',foreign.a],['idempotency_key','forged-key-0001'],['contract',JSON.stringify(forged)],
   ['contract_hash','f'.repeat(64)],['created_at',before.created_at+1],['deadline_at',before.deadline_at+1]
  ];
  for(const [column,value] of attempts){
   await assert.rejects(F.db.query('UPDATE quant_foundation_jobs SET '+column+'=$1 WHERE job_id=$2',[value,queued.run_id]),/Foundation job contract is immutable/,column);
   assert.deepEqual(await foundationRow(F,queued.run_id),before,column+' left unchanged');
  }
  const binding=(await F.db.query('SELECT * FROM quant_research_foundation WHERE run_id=$1',[queued.run_id])).rows[0];
  await assert.rejects(F.db.query('UPDATE quant_research_foundation SET contract_hash=$1 WHERE run_id=$2',['f'.repeat(64),queued.run_id]),/Research foundation identity is immutable/);
  await assert.rejects(F.db.query('DELETE FROM quant_research_foundation WHERE run_id=$1',[queued.run_id]),/Research foundation identity is immutable/);
  assert.deepEqual((await F.db.query('SELECT * FROM quant_research_foundation WHERE run_id=$1',[queued.run_id])).rows[0],binding);
 }finally{await settle(F);}
});

test('J1 FOUNDATION: a stored hash that no longer matches the contract is refused at claim with AUTHORIZATION_REVOKED; nothing runs',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0;
 const worker=foundationWorker(payload=>{calls++;return continuation(payload);});
 try{
  await withTriggerDisabled(F.db,'quant_jobs','quant_job_contract_immutable',()=>F.db.query('UPDATE quant_jobs SET contract_hash=$1 WHERE run_id=$2',['0'.repeat(64),queued.run_id]));
  assert.equal(await triggerState(F.db,'quant_jobs','quant_job_contract_immutable'),'O');
  assert.equal(await worker.claim(),null);
  const foundation=await foundationRow(F,queued.run_id),row=await runRow(F,queued.run_id);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.diagnostic,'AUTHORIZATION_REVOKED');
  assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'AUTHORIZATION_REVOKED');
  assert.equal(calls,0);assert.equal((await chunkRows(F,queued.run_id)).length,0);assert.equal(await stepCount(F,queued.run_id),0);assert.equal(row.evaluations_started,0);
 }finally{await settle(F,worker);}
});

test('J1 FOUNDATION: a hash changed after claim is refused before the next step with FOUNDATION_FORBIDDEN; nothing is evaluated or written',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0;
 const worker=foundationWorker(payload=>{calls++;return continuation(payload);});
 try{
  const job=await preparedClaim(worker),parameters=job.contract.plan.candidates[0];
  const original=queued.contract_hash;
  await withTriggerDisabled(F.db,'quant_jobs','quant_job_contract_immutable',()=>F.db.query('UPDATE quant_jobs SET contract_hash=$1 WHERE run_id=$2',['0'.repeat(64),queued.run_id]));
  await assert.rejects(worker.step(job,'candidate:000','CANDIDATE',parameters),{code:'FOUNDATION_FORBIDDEN'});
  assert.equal(calls,0);assert.equal((await chunkRows(F,queued.run_id)).length,0);assert.equal(await stepCount(F,queued.run_id),0);assert.equal((await runRow(F,queued.run_id)).evaluations_started,0);
  // Control: with the hash restored the same step proceeds, so the refusal came from the hash check.
  await withTriggerDisabled(F.db,'quant_jobs','quant_job_contract_immutable',()=>F.db.query('UPDATE quant_jobs SET contract_hash=$1 WHERE run_id=$2',[original,queued.run_id]));
  await worker.step(job,'candidate:000','CANDIDATE',parameters);
  assert.ok(calls>0);assert.equal(await stepCount(F,queued.run_id),1);
 }finally{await settle(F,worker);}
});

test('J1 FOUNDATION: a scheduler request whose hash no longer matches is refused at claim with INTEGRITY_FAILED; nothing runs',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0;
 const worker=foundationWorker(payload=>{calls++;return continuation(payload);});
 try{
  await withTriggerDisabled(F.db,'quant_foundation_jobs','quant_foundation_contract_guard',()=>F.db.query('UPDATE quant_foundation_jobs SET contract_hash=$1 WHERE job_id=$2',['0'.repeat(64),queued.run_id]));
  assert.equal(await triggerState(F.db,'quant_foundation_jobs','quant_foundation_contract_guard'),'O');
  assert.equal(await worker.claim(),null);
  const foundation=await foundationRow(F,queued.run_id),row=await runRow(F,queued.run_id);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.diagnostic,'INTEGRITY_FAILED');
  assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'INTEGRITY_FAILED');
  assert.equal(calls,0);assert.equal((await chunkRows(F,queued.run_id)).length,0);assert.equal(await stepCount(F,queued.run_id),0);
 }finally{await settle(F,worker);}
});

// ---- J7 FOUNDATION --------------------------------------------------------------------------------------------------------------
test('J7 FOUNDATION: a queued job whose engine changed is refused at claim with AUTHORIZATION_REVOKED and ends FAILED in the research API',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0;
 const worker=foundationWorker(payload=>{calls++;return continuation(payload);}),drift=engineDrift(worker);
 try{
  drift.on=true;
  assert.equal(await worker.claim(),null);
  const foundation=await foundationRow(F,queued.run_id),row=await runRow(F,queued.run_id);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.diagnostic,'AUTHORIZATION_REVOKED');
  assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'AUTHORIZATION_REVOKED');
  assert.equal(calls,0);assert.equal((await chunkRows(F,queued.run_id)).length,0);assert.equal(await stepCount(F,queued.run_id),0);assert.equal(row.evaluations_started,0);
  assert.equal(await slotBusy(F),0,'the refused job reserves no slot');
  // Control: the same worker with the engine restored claims the next valid job.
  drift.on=false;
  const next=await enqueue(F,x),claimed=await worker.claim();
  assert.equal(claimed.run_id,next.run_id);
 }finally{await settle(F,worker);}
});

test('J7 FOUNDATION: an engine change after claim is refused at dataset preparation with QUANT_ENGINE_CHANGED; no binding is written',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);
 const worker=foundationWorker(continuation),drift=engineDrift(worker);
 try{
  const job=await worker.claim();worker.controller=new AbortController();
  assert.equal(job.run_id,queued.run_id);
  drift.on=true;
  await assert.rejects(worker.prepareResearch(job),{code:'QUANT_ENGINE_CHANGED'});
  assert.equal(Number((await F.db.query('SELECT count(*) n FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0].n),0);
  assert.equal(await stepCount(F,queued.run_id),0);
 }finally{await settle(F,worker);}
});

test('J7 FOUNDATION: an engine change after preparation is refused before the first chunk with FOUNDATION_FORBIDDEN',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0;
 const worker=foundationWorker(payload=>{calls++;return continuation(payload);}),drift=engineDrift(worker);
 try{
  const job=await preparedClaim(worker);
  drift.on=true;
  await assert.rejects(worker.step(job,'candidate:000','CANDIDATE',job.contract.plan.candidates[0]),{code:'FOUNDATION_FORBIDDEN'});
  assert.equal(calls,0);assert.equal((await chunkRows(F,queued.run_id)).length,0);assert.equal(await stepCount(F,queued.run_id),0);assert.equal((await runRow(F,queued.run_id)).evaluations_started,0);
 }finally{await settle(F,worker);}
});

test('J7 FOUNDATION: an engine change during a chunk refuses its checkpoint; progress and steps are not written',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0,drift;
 const worker=foundationWorker(payload=>{calls++;drift.on=true;return continuation(payload);});
 drift=engineDrift(worker);
 try{
  const job=await preparedClaim(worker);
  await assert.rejects(worker.step(job,'candidate:000','CANDIDATE',job.contract.plan.candidates[0]),{code:'FOUNDATION_FORBIDDEN'});
  assert.equal(calls,1,'the chunk ran, only its checkpoint was refused');
  const chunks=await chunkRows(F,queued.run_id);
  assert.equal(chunks.length,1);assert.equal(chunks[0].next_bar,0);assert.equal(chunks[0].checkpoint,null);assert.equal(chunks[0].checkpoint_hash,null);
  assert.equal(await stepCount(F,queued.run_id),0);
 }finally{await settle(F,worker);}
});

test('J7 FOUNDATION: a paused job with a durable checkpoint is refused at reclaim under a changed engine; its checkpoint stays',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0;
 const first=foundationWorker(payload=>{if(++calls===2)throw Object.assign(Error('fixture interruption'),{stopped:true});return continuation(payload);});
 let second;
 try{
  const old=await preparedClaim(first);
  await assert.rejects(first.step(old,'candidate:000','CANDIDATE',old.contract.plan.candidates[0]),/fixture interruption/);
  const saved=(await chunkRows(F,queued.run_id))[0];
  assert.equal(saved.next_bar,1000);assert.equal(saved.checkpoint.next_bar,1000);
  await first.scheduler.pause(old.foundation);
  assert.equal((await foundationRow(F,queued.run_id)).status,'PAUSED');
  let resumedCalls=0;
  second=foundationWorker(payload=>{resumedCalls++;return continuation(payload);});engineDrift(second).on=true;
  assert.equal(await second.claim(),null);
  const foundation=await foundationRow(F,queued.run_id),row=await runRow(F,queued.run_id);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.diagnostic,'AUTHORIZATION_REVOKED');
  assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'AUTHORIZATION_REVOKED');
  assert.equal(resumedCalls,0);assert.equal(await stepCount(F,queued.run_id),0);
  const kept=(await chunkRows(F,queued.run_id))[0];
  assert.equal(kept.next_bar,1000,'durable progress is kept, never replayed under a changed engine');assert.deepEqual(kept.checkpoint,saved.checkpoint);
 }finally{await settle(F,second??first);}
});

test('J7 FOUNDATION: an engine change during the first chunk ends the job FAILED through the real worker loop without a step',async()=>{
 assert.equal(await slotBusy(F),0,'a previous test left the foundation slot reserved');
 const x=await seed(F),queued=await enqueue(F,x);let calls=0,drift;
 const worker=foundationWorker(payload=>{calls++;drift.on=true;return continuation(payload);});
 drift=engineDrift(worker);
 try{
  assert.equal(await worker.tick(),true);
  const row=await runRow(F,queued.run_id),foundation=await foundationRow(F,queued.run_id);
  assert.equal(calls,1);assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'FOUNDATION_FORBIDDEN');
  assert.equal(foundation.status,'CANCELLED');
  assert.equal(await stepCount(F,queued.run_id),0);assert.equal(row.result,null);
  assert.equal(await slotBusy(F),0,'the slot is released after the stop proof');
 }finally{await settle(F,worker);}
});
