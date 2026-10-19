import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {DATASET_BINDING_STEP_ID} from '../../src/quant-research/research-contract-v2.js';
import {scripted} from '../helpers/quant-research-clauses-fixture.mjs';
import {createModeDatabase,seedGuardDeployment} from '../helpers/quant-research-contract-guards-fixture.mjs';
import {legacyInterruptible,chunkInterruptible,chunkIgnoringAbort} from '../helpers/quant-research-graceful-stop-fixture.mjs';

/**
 * D1 graceful-stop recovery (docs/QL_3A_DURABLE_JOBS.md recovery paragraph, owner decision 2026-10-19):
 * LEGACY: graceful termination aborts the subprocess and leaves its uncommitted step recoverable after lease expiry; the next
 *   worker reclaims the job and resumes from the committed checkpoints.
 * FOUNDATION: graceful termination is terminal. The supervised step stops, the foundation job moves to STOPPING and is
 *   acknowledged CANCELLED after stop proof, the research job ends FAILED with its interruption code, committed checkpoints stay
 *   unchanged and are not resumed, no late output commits, and a new run needs a new job.
 * Termination is driven through worker.stop(), the call of the SIGTERM handler in src/postgres/quant-research-main.js. The injected
 * clock moves the lease; there is no real sleep. Expected values are literals on purpose. Evaluators are stubs; metrics
 * establish engineering behaviour only.
 */
let admin,L,F;
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 L=await createModeDatabase({admin,foundation:false,label:'gstop_legacy'});
 F=await createModeDatabase({admin,foundation:true,label:'gstop_foundation'});
});
after(async()=>{
 if(L)await L.close();
 if(F)await F.close();
 await admin?.close();
});

const seed=async ctx=>{const x=await seedGuardDeployment({db:ctx.db,store:ctx.store,now:ctx.now});ctx.now=x.now;return x;};
const enqueue=(ctx,x)=>ctx.db.transaction(()=>ctx.service.enqueue(x.a,x.body,randomUUID()));
const cancel=(ctx,owner,runId)=>ctx.db.transaction(()=>ctx.service.get(owner,runId,true));
const runRow=(ctx,runId)=>ctx.db.prepare('SELECT * FROM quant_jobs WHERE run_id=?').get(runId);
const stepRows=async(ctx,runId)=>(await ctx.db.query('SELECT step_id,kind,parameters,result,completed_at FROM quant_job_steps WHERE run_id=$1 ORDER BY step_id',[runId])).rows;
const foundationRow=async(ctx,runId)=>(await ctx.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[runId])).rows[0];
const chunkRows=async(ctx,runId)=>(await ctx.db.query('SELECT step_id,kind,parameters,identity_hash,next_bar,checkpoint,checkpoint_hash FROM quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[runId])).rows;
const slotBusy=async ctx=>Number((await ctx.db.query("SELECT count(*) n FROM quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')")).rows[0].n);
const noOtherRunnable=async(ctx,runId)=>assert.equal(Number((await ctx.db.prepare("SELECT count(*) n FROM quant_jobs WHERE status IN ('QUEUED','RUNNING') AND run_id<>?").get(runId)).n),0);
/** Cancels every job still open and lets the worker prove its stop, so the shared foundation slot is released for the next test. */
async function settle(ctx,worker){
 const open=(await ctx.db.query("SELECT run_id,owner_id FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')")).rows;
 for(const row of open)await cancel(ctx,row.owner_id,row.run_id);
 if(worker?.reconcile)await worker.reconcile();
}
const legacyWorker=evaluate=>new QuantResearchWorker({service:L.service,evaluate,clock:()=>L.now});
/** stopProof.value is the answer of stopUnit; `seen` records what the database showed at the moment the stop proof was requested. */
function foundationWorker({evaluateChunk,stopProof={value:true},seen=[]}){
 return new QuantResearchFoundationWorker({service:F.service,clock:()=>F.now,health:async()=>({ok:true}),evaluateChunk,
  stopUnit:async unit=>{
   const row=(await F.db.query("SELECT f.status foundation,f.stop_reason,q.status research,q.diagnostic FROM quant_foundation_jobs f JOIN quant_jobs q ON q.run_id=f.job_id::text WHERE $1 LIKE 'robot-quant-'||q.run_id||'-%'",[unit])).rows[0];
   seen.push({unit,...row});return stopProof.value;
  }});
}

// ---- LEGACY ---------------------------------------------------------------------------------------------------------------------
test('D1 LEGACY: graceful stop aborts the subprocess, leaves the uncommitted step recoverable and a new worker resumes after lease expiry',async()=>{
 const x=await seed(L),queued=await enqueue(L,x),runId=queued.run_id;
 const firstScript=scripted({}),interrupt=legacyInterruptible({script:firstScript,interruptAt:3}),first=legacyWorker(interrupt.evaluate);
 try{
  await noOtherRunnable(L,runId);
  first.start();await interrupt.ready;
  const committed=await stepRows(L,runId),claimedRow=await runRow(L,runId);
  assert.deepEqual(committed.map(s=>s.step_id),['candidate:000','candidate:001'],'two steps are committed while the third evaluation runs');
  assert.equal(claimedRow.status,'RUNNING');assert.equal(claimedRow.attempt,1);assert.equal(claimedRow.evaluations_started,3);
  assert.equal(claimedRow.lease_until,L.now+30000);
  await first.stop();
  assert.equal(interrupt.count(),3,'the third evaluation was the last one started');
  // The aborted worker writes nothing: no FAILED row, no diagnostic, no step. The job stays RUNNING under its old lease.
  const stopped=await runRow(L,runId);
  assert.equal(stopped.status,'RUNNING');assert.equal(stopped.diagnostic,null);assert.equal(stopped.result,null);
  assert.equal(stopped.lease_token,claimedRow.lease_token);assert.equal(stopped.lease_until,claimedRow.lease_until);
  assert.equal(stopped.attempt,1);assert.equal(stopped.evaluations_started,3);
  assert.deepEqual(await stepRows(L,runId),committed,'committed checkpoints are unchanged and the interrupted step is not committed');
  // Before the lease expires nobody reclaims the job.
  const early=scripted({}),beforeExpiry=legacyWorker(early.evaluate);
  assert.equal(await beforeExpiry.tick(),false);assert.equal(early.calls.length,0);
  assert.equal((await runRow(L,runId)).status,'RUNNING');assert.equal((await runRow(L,runId)).attempt,1);
  // After the lease expires the next worker recovers and resumes from the committed checkpoints.
  L.now+=31000;
  const resumedScript=scripted({}),second=legacyWorker(resumedScript.evaluate);
  assert.equal(await second.tick(),true);
  const done=await runRow(L,runId);
  assert.ok(['SUCCEEDED','NO_VALID_CANDIDATE'].includes(done.status),'resumed job finished normally: '+done.status);
  assert.equal(done.diagnostic,null);assert.equal(done.attempt,2,'the job was reclaimed once');assert.equal(done.lease_token,null);
  assert.notEqual(done.result,null);assert.equal(done.result.contract_hash,done.contract_hash);
  assert.deepEqual([resumedScript.calls[0].kind,resumedScript.calls[0].index],['CANDIDATE',2],'resume starts at the interrupted step');
  assert.equal(resumedScript.calls.some(c=>c.kind==='CANDIDATE'&&c.index<2),false,'no committed candidate is evaluated again');
  const finalSteps=await stepRows(L,runId);
  assert.deepEqual(finalSteps.slice(0,2),committed,'the two checkpoints written before the stop are byte-identical');
  assert.equal(finalSteps.length,2+resumedScript.calls.length,'one step per resumed evaluation');
  assert.equal(done.evaluations_started,3+resumedScript.calls.length,'the interrupted evaluation was counted once and not repeated');
 }finally{await settle(L);}
});

// ---- FOUNDATION -----------------------------------------------------------------------------------------------------------------
test('D1 FOUNDATION: graceful stop is terminal; STOPPING then CANCELLED after proof, research FAILED RESEARCH_INTERRUPTED, checkpoints unchanged, not resumed',async()=>{
 const x=await seed(F),queued=await enqueue(F,x),runId=queued.run_id;
 const interrupt=chunkInterruptible({interruptAtCall:2}),seen=[];
 const first=foundationWorker({evaluateChunk:interrupt.evaluateChunk,seen});
 let second;
 try{
  assert.equal(await slotBusy(F),0);
  first.start();await interrupt.ready;
  // Chunk 1 of candidate:000 is committed; chunk 2 is running when the termination arrives.
  const chunksBefore=await chunkRows(F,runId),candidate=chunksBefore.find(c=>c.step_id==='candidate:000');
  assert.equal(chunksBefore.length,2,'dataset binding row and candidate:000');assert.equal(candidate.next_bar,1000);assert.equal(candidate.checkpoint.next_bar,1000);
  assert.equal(chunksBefore.some(c=>c.step_id===DATASET_BINDING_STEP_ID),true);
  assert.equal((await foundationRow(F,runId)).status,'RUNNING');assert.equal((await runRow(F,runId)).status,'RUNNING');
  const claimedFoundation=await foundationRow(F,runId);
  await first.stop();
  assert.equal(interrupt.count(),2);
  // Research job: terminal FAILED with the interruption code.
  const research=await runRow(F,runId);
  assert.equal(research.status,'FAILED');assert.equal(research.diagnostic,'RESEARCH_INTERRUPTED');
  assert.equal(research.result,null);assert.equal(research.lease_token,null);assert.equal(research.lease_until,0);
  // Foundation job: STOPPING was entered, stop proof was requested for the supervised unit, then CANCELLED.
  assert.equal(seen.length,1,'one supervised unit needed stop proof');
  assert.match(seen[0].unit,new RegExp('^robot-quant-'+runId+'-[a-f0-9]{8}-'+claimedFoundation.lease_token+'\\.service$'));
  assert.equal(seen[0].foundation,'STOPPING','the job was STOPPING when stop proof was requested');
  assert.equal(seen[0].stop_reason,'CANCELLED');assert.equal(seen[0].research,'FAILED');assert.equal(seen[0].diagnostic,'RESEARCH_INTERRUPTED');
  const foundation=await foundationRow(F,runId);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.stop_reason,null);assert.equal(foundation.diagnostic,'RESEARCH_INTERRUPTED');
  assert.equal(foundation.lease_token,null);assert.equal(foundation.worker_id,null);assert.equal(foundation.result,null);
  assert.equal(await slotBusy(F),0,'the shared foundation slot is free after proof');
  // Checkpoints: the committed chunk is unchanged, nothing was added, no step result exists.
  assert.deepEqual(await chunkRows(F,runId),chunksBefore,'chunk checkpoint rows are unchanged by the stop');
  assert.equal((await stepRows(F,runId)).length,0);
  // The output the killed process would have produced exists but nobody committed it.
  assert.equal(interrupt.late().checkpoint.next_bar,2000);
  assert.deepEqual(await chunkRows(F,runId),chunksBefore,'late output did not commit');
  // No resume: a new worker finds nothing to claim, even long after the old lease, and evaluates nothing.
  F.now+=120000;
  const counted=chunkInterruptible({interruptAtCall:0});
  second=foundationWorker({evaluateChunk:counted.evaluateChunk});
  assert.equal(await second.tick(),false);assert.equal(counted.count(),0,'no evaluation was started');
  assert.equal((await runRow(F,runId)).status,'FAILED');assert.equal((await runRow(F,runId)).diagnostic,'RESEARCH_INTERRUPTED');
  assert.equal((await foundationRow(F,runId)).status,'CANCELLED');
  assert.deepEqual(await chunkRows(F,runId),chunksBefore);
  // A new run needs a new job: the same request makes a different job that starts from nothing.
  const again=await enqueue(F,x);
  assert.notEqual(again.run_id,runId);
  const job=await second.claim();
  assert.equal(job.run_id,again.run_id);assert.equal(job.phase,'PREPARE');assert.equal(job.attempt,1);
  assert.equal((await chunkRows(F,again.run_id)).length,0,'the new job has no checkpoint');
  assert.equal(counted.count(),0);
  assert.deepEqual(await chunkRows(F,runId),chunksBefore,'the stopped job keeps its checkpoints and gains none');
 }finally{await settle(F,second??first);}
});

test('D1 FOUNDATION: without stop proof the job stays STOPPING and holds the slot; proof later makes it CANCELLED',async()=>{
 const x=await seed(F),queued=await enqueue(F,x),runId=queued.run_id;
 // Equal created_at would let the job id decide the claim order; one millisecond makes the first job the one claimed.
 F.now+=1;const waiting=await enqueue(F,x);
 const interrupt=chunkInterruptible({interruptAtCall:2}),proof={value:false},seen=[];
 const first=foundationWorker({evaluateChunk:interrupt.evaluateChunk,stopProof:proof,seen});
 try{
  assert.equal(await slotBusy(F),0);
  first.start();await interrupt.ready;
  const chunksBefore=await chunkRows(F,runId);
  await first.stop();
  const research=await runRow(F,runId);
  assert.equal(research.status,'FAILED');assert.equal(research.diagnostic,'RESEARCH_INTERRUPTED');
  const parked=await foundationRow(F,runId);
  assert.equal(parked.status,'STOPPING');assert.equal(parked.stop_reason,'CANCELLED');assert.equal(parked.diagnostic,'RESEARCH_INTERRUPTED');
  assert.notEqual(parked.lease_token,null,'the lease token stays until proof');
  assert.equal(seen.length>=1,true);assert.equal(seen.every(s=>s.foundation==='STOPPING'),true);
  assert.equal(await slotBusy(F),1,'the slot stays reserved');
  assert.equal(await first.claim(),null,'a queued job cannot take the reserved slot');
  assert.equal((await foundationRow(F,waiting.run_id)).status,'QUEUED');
  assert.equal((await foundationRow(F,runId)).status,'STOPPING');
  // Proof arrives: the job is acknowledged CANCELLED, never paused for resume, and the queued job can run.
  proof.value=true;
  const claimed=await first.claim();
  const released=await foundationRow(F,runId);
  assert.equal(released.status,'CANCELLED','acknowledged CANCELLED, not PAUSED');assert.equal(released.stop_reason,null);assert.equal(released.lease_token,null);
  assert.equal(claimed.run_id,waiting.run_id);
  assert.equal((await runRow(F,runId)).status,'FAILED');
  assert.deepEqual(await chunkRows(F,runId),chunksBefore);assert.equal((await stepRows(F,runId)).length,0);
 }finally{await settle(F,first);}
});

test('D1 FOUNDATION: output that arrives after the stop must not commit',async()=>{
 const x=await seed(F),queued=await enqueue(F,x),runId=queued.run_id;
 const late=chunkIgnoringAbort({lateAtCall:2}),first=foundationWorker({evaluateChunk:late.evaluateChunk});
 try{
  assert.equal(await slotBusy(F),0);
  first.start();await late.ready;
  const chunksBefore=await chunkRows(F,runId);
  const stopping=first.stop();late.release();await stopping;
  // The runner answered after the abort; the worker refuses the answer, so the job ends as an interruption.
  assert.equal(late.count(),2,'the late answer came from the second chunk call');
  const research=await runRow(F,runId);
  assert.equal(research.status,'FAILED');assert.equal(research.diagnostic,'RESEARCH_INTERRUPTED');assert.equal(research.result,null);
  const candidate=chunksBefore.find(c=>c.step_id==='candidate:000');
  assert.equal(candidate.next_bar,1000);assert.equal(candidate.checkpoint.next_bar,1000);
  assert.deepEqual(await chunkRows(F,runId),chunksBefore,'no late output committed: next_bar and checkpoint unchanged');
  assert.equal((await stepRows(F,runId)).length,0);
  const foundation=await foundationRow(F,runId);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.diagnostic,'RESEARCH_INTERRUPTED');
 }finally{await settle(F,first);}
});

test('D1 FOUNDATION: an abort at finish entry ends research FAILED RESEARCH_INTERRUPTED; no terminal SUCCEEDED commits',async()=>{
 const x=await seed(F),queued=await enqueue(F,x),runId=queued.run_id;
 const chunks=chunkInterruptible({interruptAtCall:0}),seen=[];
 const first=foundationWorker({evaluateChunk:chunks.evaluateChunk,seen});
 // The termination lands after the last step commit and before the FINISH fence, the window the review found.
 const original=first.finish.bind(first);let entered,stopping=null,atEntry=null;
 const reached=new Promise(resolve=>{entered=resolve;});
 first.finish=async(...args)=>{
  atEntry={research:await runRow(F,runId),foundation:await foundationRow(F,runId),steps:await stepRows(F,runId),chunks:await chunkRows(F,runId),status:args[1]};
  stopping=first.stop();entered();return original(...args);
 };
 try{
  assert.equal(await slotBusy(F),0);
  first.start();await reached;await stopping;
  assert.ok(['SUCCEEDED','NO_VALID_CANDIDATE'].includes(atEntry.status),'finish was about to commit a terminal result: '+atEntry.status);
  assert.equal(atEntry.research.status,'RUNNING');assert.equal(atEntry.foundation.status,'RUNNING');
  assert.ok(atEntry.steps.length>0,'steps were committed before finish');
  const research=await runRow(F,runId);
  assert.equal(research.status,'FAILED');assert.equal(research.diagnostic,'RESEARCH_INTERRUPTED');
  assert.equal(research.result,null);assert.equal(research.lease_token,null);assert.equal(research.lease_until,0);
  assert.notEqual(research.phase,'COMPLETE','the FINISH update did not commit');
  const foundation=await foundationRow(F,runId);
  assert.equal(foundation.status,'CANCELLED','acknowledged CANCELLED after stop proof, never SUCCEEDED');
  assert.equal(foundation.stop_reason,null);assert.equal(foundation.diagnostic,'RESEARCH_INTERRUPTED');
  assert.equal(foundation.result,null);assert.equal(foundation.lease_token,null);assert.equal(foundation.worker_id,null);
  assert.equal(seen.every(s=>s.foundation==='STOPPING'),true,'any stop proof was requested while STOPPING');
  assert.equal(await slotBusy(F),0);
  assert.deepEqual(await stepRows(F,runId),atEntry.steps,'committed steps are unchanged');
  assert.deepEqual(await chunkRows(F,runId),atEntry.chunks,'committed chunk checkpoints are unchanged');
 }finally{await settle(F,first);}
});

test('D1 FOUNDATION: an abort between steps creates no chunk row and counts no evaluation',async()=>{
 const x=await seed(F),queued=await enqueue(F,x),runId=queued.run_id;
 const chunks=chunkInterruptible({interruptAtCall:0});
 const first=foundationWorker({evaluateChunk:chunks.evaluateChunk});
 // The termination lands after candidate:000 committed and before step() reaches the chunk-row creation fence of candidate:001.
 const original=first.step.bind(first);let entered,stopping=null,atEntry=null;
 const reached=new Promise(resolve=>{entered=resolve;});
 first.step=async(job,id,...rest)=>{
  if(id==='candidate:001'&&!atEntry){
   atEntry={research:await runRow(F,runId),steps:await stepRows(F,runId),chunks:await chunkRows(F,runId),calls:chunks.count()};
   stopping=first.stop();entered();
  }
  return original(job,id,...rest);
 };
 try{
  assert.equal(await slotBusy(F),0);
  first.start();await reached;await stopping;
  assert.equal(atEntry.research.status,'RUNNING');
  assert.deepEqual(atEntry.steps.map(s=>s.step_id),['candidate:000'],'one step committed before the abort');
  assert.equal(atEntry.chunks.some(c=>c.step_id==='candidate:001'),false);
  assert.equal(chunks.count(),atEntry.calls,'no chunk evaluation started after the abort');
  const research=await runRow(F,runId);
  assert.equal(research.status,'FAILED');assert.equal(research.diagnostic,'RESEARCH_INTERRUPTED');assert.equal(research.result,null);
  assert.equal(research.evaluations_started,atEntry.research.evaluations_started,'evaluations_started is unchanged');
  assert.deepEqual(await chunkRows(F,runId),atEntry.chunks,'no new chunk row');
  assert.deepEqual(await stepRows(F,runId),atEntry.steps);
  const foundation=await foundationRow(F,runId);
  assert.equal(foundation.status,'CANCELLED');assert.equal(foundation.diagnostic,'RESEARCH_INTERRUPTED');assert.equal(foundation.result,null);
  assert.equal(await slotBusy(F),0);
 }finally{await settle(F,first);}
});

// ---- SIGTERM wiring -------------------------------------------------------------------------------------------------------------
test('D1 wiring: SIGTERM and SIGINT call worker.stop() before the databases close',async()=>{
 const text=await fs.readFile(new URL('../../src/postgres/quant-research-main.js',import.meta.url),'utf8');
 const from=text.indexOf('async function stop()'),to=text.indexOf("process.on('SIGTERM'");
 assert.ok(from>0&&to>from);
 assert.ok(text.slice(from,to).includes('await worker.stop();await healthDb?.close();await db.close();'),'stop() awaits the worker before the databases close');
 assert.ok(text.includes("process.on('SIGTERM',stop);process.on('SIGINT',stop);"));
});
