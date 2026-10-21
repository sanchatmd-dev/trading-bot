import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {QuantFixedEvalService} from '../../src/postgres/quant-fixed-eval.js';
import {QuantFixedEvalRunner} from '../../src/postgres/quant-fixed-eval-worker.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {Store} from '../../src/postgres/store.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {cancelSelection} from '../../src/postgres/selection-store.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {fixedEvalEngineHash} from '../../src/postgres/quant-fixed-eval-engine.js';

/** Real guarded PG and filesystem storage under runtime grants. Only explicitly labelled tests inject a Python supervisor. */
async function setup(t){
 assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
 const f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL),directory=await fs.mkdtemp(path.join(os.tmpdir(),'fe2b-prepare-'));
 const role='fe2b_runtime_'+randomUUID().replaceAll('-','').slice(0,20);let roleCreated=false;
 t.after(async()=>{await f.close();if(roleCreated){
  // The isolated fixture database has been dropped, removing all role-owned grant dependencies.
  const {PostgresDatabase}=await import('../../src/postgres/db.js');const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  try{await admin.query('DROP ROLE '+role);}finally{await admin.close();}
 }await fs.rm(directory,{recursive:true,force:true});});
 await f.db.query(await fs.readFile(new URL('../../src/postgres/quant-storage-schema.sql',import.meta.url),'utf8'));
 const root=path.join(directory,'datasets');await f.db.transaction(()=>bindQuantStorage(f.db,root));
 await f.db.query('CREATE ROLE '+role+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');roleCreated=true;
 await f.db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'"));
 const runtime={get isTransaction(){return f.db.isTransaction;},
  transaction:(fn,options)=>f.db.transaction(async()=>{await f.db.query('SET LOCAL ROLE '+role);return fn();},options),
  query:(sql,args=[])=>f.db.isTransaction?f.db.query(sql,args):runtime.transaction(()=>f.db.query(sql,args)),
  prepare(sql){let index=0;const translated=sql.replace(/'(?:''|[^'])*'|\?/g,token=>token==='?'?'$'+(++index):token);
   return {get:async(...args)=>(await runtime.query(translated,args)).rows[0],all:async(...args)=>(await runtime.query(translated,args)).rows,
    run:async(...args)=>({changes:(await runtime.query(translated,args)).rowCount})};}};
 const store=new Store(runtime),pine=new PineBridgeService(store),fixedService=new QuantFixedEvalService({pineService:pine,supportedSourceHash:f.c.source_hash,engineHash:async()=>f.context.engine});
 const datasetStore=new ResearchDatasetStore({root}),research={foundation:true,db:runtime,pine,store,datasetStore,executorMode:async()=>{
  const mode=(await runtime.query('SELECT mode FROM public.quant_research_executor_mode WHERE singleton')).rows[0]?.mode;assert.equal(mode,'FOUNDATION');
 }};
 const worker=new QuantResearchFoundationWorker({service:research,fixedEvalService:fixedService,health:async()=>({ok:true}),supervisor:async()=>{throw Error('A preparation checkpoint must not launch');}});
 worker.controller=new AbortController();
 return {...f,runtime,fixedService,worker,root,datasetStore};
}

test('real PG runtime grants: fixed dispatch and preparation validate SHA and persist one immutable binding',async t=>{
 const f=await setup(t);
 await assert.rejects(f.runtime.query('SELECT selection_id FROM public.quant_selection_registrations WHERE selection_id=$1 FOR UPDATE',[f.body.object_id]),{code:'42501'});
 const admission=await f.fixedService.enqueue(f.owner,f.body,'prepare_runtime_001');assert.equal(admission.ok,true);
 const job=await f.worker.claim();assert.equal(job.kind,'FIXED_EVAL');assert.equal(job.attempt,1);
 const prepared=await f.worker.fixedEval.prepare(job);assert.equal(prepared.dataset_binding.dataset_sha256,f.freeze.dataset_hash);
 const again=await f.worker.fixedEval.prepare(job);assert.deepEqual(again.dataset_binding,prepared.dataset_binding);
 const chunks=(await f.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1',[job.run_id])).rows;
 assert.equal(chunks.length,1);assert.equal(chunks[0].step_id,'prepare:dataset');assert.equal(chunks[0].checkpoint,null);assert.equal(chunks[0].next_bar,0);
 assert.equal((await f.db.query('SELECT evaluations_started FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows[0].evaluations_started,0);
 await assert.rejects(f.worker.scheduler.pause(job.foundation),{code:'FOUNDATION_FORBIDDEN'});
});

test('real PG: committed object cancellation before the claim fence prevents claim and preparation',async t=>{
 const f=await setup(t);await f.fixedService.enqueue(f.owner,f.body,'prepare_cancel_001');
 const cancelled=await cancelSelection(f.runtime,{owner_id:f.owner,selection_id:f.body.object_id,confirmed:true});assert.equal(cancelled.ok,true);
 assert.equal(await f.worker.claim(),null);
 const chunks=(await f.db.query("SELECT count(*)::int n FROM public.quant_research_chunks c JOIN public.quant_jobs j USING(run_id) WHERE j.contract->>'mode'='FIXED_INPUT_EVAL'")).rows[0].n;
 assert.equal(chunks,0);
});

test('real PG: a cancellation overlapping a fence is reread at the next SERIALIZABLE fence',async t=>{
 const f=await setup(t),admitted=await f.fixedService.enqueue(f.owner,f.body,'prepare_overlap_001');
 let entered,release;const seen=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const fence=f.worker.scheduler.transaction(async()=>{
  await f.worker.scheduler.lock();const authority=await f.fixedService.storedRun(f.owner,admitted.evaluation_run_id,{live:true});entered();await gate;return authority;
 });
 await seen;
 try{assert.equal((await cancelSelection(f.db,{owner_id:f.owner,selection_id:f.body.object_id,confirmed:true})).ok,true);}
 finally{release();}
 // The overlapping read may serialize before cancellation. No physical-after-response guarantee is claimed.
 await fence;
 await assert.rejects(f.worker.scheduler.transaction(()=>f.fixedService.storedRun(f.owner,admitted.evaluation_run_id,{live:true})),{code:'FIXED_EVAL_OBJECT_NOT_EVALUATING'});
});

test('real PG: stop acknowledgement remains available after object and owner revocation, never PAUSED',async t=>{
 const f=await setup(t);await f.fixedService.enqueue(f.owner,f.body,'prepare_stop_0001');const job=await f.worker.claim();
 await f.db.query("UPDATE public.quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL WHERE job_id=$1",[job.run_id]);
 await f.db.query("UPDATE public.users SET status='SUSPENDED' WHERE id=$1",[f.owner]);
 f.worker.stopped.add(job.run_id+':'+job.lease_token);
 const result=await f.worker.scheduler.acknowledgeStopped(job.run_id,job.lease_token);assert.equal(result.status,'CANCELLED');
});

test('fixed authorization propagates database serialization/deadlock/grant failures',async()=>{
 for(const code of ['40001','40P01','42501','08006']){
  const worker={scheduler:{},db:{isTransaction:true},stopped:new Set(),activeLaunches:new Set()};
  const service={storedRun:async()=>{throw Object.assign(Error('database failure'),{code});}};
  const runner=new QuantFixedEvalRunner({worker,service});
  await assert.rejects(runner.authorize('owner',{version:'quant-foundation-fixed-eval-v1'},'CLAIM',{job_id:'job'}),{code});
 }
});

test('fixed-enabled scheduler retries the complete transaction on serialization/deadlock only',async()=>{
 for(const code of ['40001','40P01']){
  let calls=0;const options=[];
  const db={isTransaction:false,query:async()=>({rows:[]}),transaction:async(fn,option)=>{options.push(option);calls++;if(calls===1)throw Object.assign(Error('retry'),{code});return fn();}};
  const scheduler=new QuantFoundationScheduler({db,authorize:async()=>({ok:true}),health:async()=>({ok:true}),serializable:true});
  assert.equal(await scheduler.transaction(async()=>42),42);assert.equal(calls,2);assert.deepEqual(options,[{isolation:'SERIALIZABLE'},{isolation:'SERIALIZABLE'}]);
 }
});

/** Actual bounded Python subprocess with exit proof. This injected test supervisor is not native QS/systemd evidence. */
function pythonSupervisor(stoppedUnits,calls){
 return ({payload,module,signal,unitName,timeoutMs})=>new Promise((resolve,reject)=>{
  assert.equal(module,'robot_quant.fixed_eval_job');calls.push(payload.kind);
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  const python=process.env.QUANT_RESEARCH_PYTHON??path.join(repo,'quant_lab/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  assert.ok(path.isAbsolute(python)&&existsSync(python),'Actual Python evidence requires the configured interpreter or repository virtual environment');
  const child=spawn(python,['-m',module],{cwd:repo,env:{...process.env,PYTHONPATH:path.join(repo,'quant_lab/src')},stdio:['pipe','pipe','pipe']});
  let output='',reason=null,settled=false;
  const abort=()=>{reason='RESEARCH_INTERRUPTED';child.kill('SIGKILL');};
  const timer=setTimeout(()=>{reason='EVALUATION_TIMED_OUT';child.kill('SIGKILL');},Math.min(timeoutMs,30000));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',bytes=>{output+=bytes;if(Buffer.byteLength(output)>8*1024*1024){reason='EVALUATION_OUTPUT_TOO_LARGE';child.kill('SIGKILL');}});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.on('error',()=>{reason='QUANT_PYTHON_UNAVAILABLE';});
  child.on('close',code=>{
   if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);stoppedUnits.add(unitName);
   if(reason||code!==0){reject(Object.assign(Error(reason??'EVALUATION_FAILED'),{code:reason??'EVALUATION_FAILED',stopped:true}));return;}
   try{resolve(JSON.parse(output));}catch{reject(Object.assign(Error('INVALID_EVALUATION_RESPONSE'),{code:'INVALID_EVALUATION_RESPONSE',stopped:true}));}
  });
  child.stdin.end(JSON.stringify(payload));
 });
}

test('real PG plus actual Python: exactly base and stress finish under the real closure and closed readback',async t=>{
 const f=await setup(t),stopped=new Set(),calls=[];f.worker.supervisor=pythonSupervisor(stopped,calls);f.worker.stopUnit=async unit=>stopped.has(unit);
 assert.equal(f.context.engine,await fixedEvalEngineHash());
 await f.fixedService.enqueue(f.owner,f.body,'fixed_python_success1');const job=await f.worker.claim();
 await f.worker.run(job);assert.deepEqual(calls,['EVALUATION','EVALUATION_STRESS']);
 const read=await f.fixedService.read(f.owner,job.run_id);assert.equal(read.status,'SUCCEEDED');assert.equal(read.dataset_sha_verified,true);
 assert.equal(read.result.evaluation_closure.hash,await fixedEvalEngineHash());assert.equal(read.result.dataset_sha256,f.freeze.dataset_hash);
 const chunks=(await f.db.query('SELECT step_id,next_bar,checkpoint,unit_name,unit_token FROM public.quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[job.run_id])).rows;
 assert.equal(chunks.length,3);assert.ok(chunks.every(row=>row.next_bar===0&&row.checkpoint===null&&row.unit_name===null&&row.unit_token===null));
 assert.equal((await f.db.query('SELECT evaluations_started FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows[0].evaluations_started,2);
 assert.equal(f.worker.activeLaunches.size,0);
 // Both immutable SHA authorities agree with one another, but disagree with otherwise valid stored results.
 const query=f.runtime.query;
 f.runtime.query=async(sql,args)=>{
  const answer=await query(sql,args);
  if(sql.includes('SELECT * FROM public.quant_selection_evaluation_starts')||sql.includes('SELECT * FROM public.quant_selection_window_freezes'))
   return {...answer,rows:answer.rows.map(row=>({...row,dataset_hash:'f'.repeat(64)}))};
  return answer;
 };
 try{await assert.rejects(f.fixedService.read(f.owner,job.run_id),{code:'FIXED_EVAL_DATASET_SHA_MISMATCH'});}
 finally{f.runtime.query=query;}
 assert.equal((await f.fixedService.read(f.owner,job.run_id)).dataset_sha_verified,true);
 await assert.rejects(f.worker.run(job));assert.deepEqual(calls,['EVALUATION','EVALUATION_STRESS']);
});

test('real PG: queued cancellation is immediate and cannot be claimed',async t=>{
 const f=await setup(t),admitted=await f.fixedService.enqueue(f.owner,f.body,'fixed_queued_cancel1');
 assert.equal((await f.fixedService.cancel(f.owner,admitted.evaluation_run_id)).status,'CANCELLED');assert.equal(await f.worker.claim(),null);
 assert.equal((await f.fixedService.read(f.owner,admitted.evaluation_run_id)).status,'CANCELLED');
});

test('real PG: running cancellation keeps quant nonterminal until token-matched stop acknowledgement',async t=>{
 const f=await setup(t);await f.fixedService.enqueue(f.owner,f.body,'fixed_running_cancel1');const job=await f.worker.claim();await f.worker.fixedEval.prepare(job);
 assert.equal((await f.fixedService.cancel(f.owner,job.run_id)).status,'STOPPING');
 assert.equal((await f.db.query('SELECT status FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows[0].status,'RUNNING');
 await f.worker.fixedEval.reconcile(job.foundation);
 assert.equal((await f.fixedService.read(f.owner,job.run_id)).status,'CANCELLED');
 assert.equal((await f.db.query('SELECT status FROM public.quant_foundation_jobs WHERE job_id=$1',[job.run_id])).rows[0].status,'CANCELLED');
});

test('real PG: an unconfirmed launch keeps STOPPING reserved and the quant parent nonterminal',async t=>{
 const f=await setup(t);await f.fixedService.enqueue(f.owner,f.body,'fixed_unknown_stop1');const job=await f.worker.claim();
 f.worker.supervisor=async()=>{throw Object.assign(Error('unknown stop'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped:false});};f.worker.stopUnit=async()=>false;
 let error;try{await f.worker.run(job);}catch(failure){error=failure;}assert.equal(error.code,'QUANT_PROCESS_STOP_UNCONFIRMED');
 await f.worker.fixedEval.failed(job,error);
 assert.equal((await f.db.query('SELECT status FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows[0].status,'RUNNING');
 assert.equal((await f.db.query('SELECT status FROM public.quant_foundation_jobs WHERE job_id=$1',[job.run_id])).rows[0].status,'STOPPING');
 assert.equal(await f.worker.scheduler.claim('must-remain-blocked'),null);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM public.quant_research_chunks WHERE run_id=$1 AND unit_name IS NOT NULL',[job.run_id])).rows[0].n,1);
});

test('real PG: foreign durable unit is rejected before stop and leaves quarantined evidence unchanged',async t=>{
 const f=await setup(t);await f.fixedService.enqueue(f.owner,f.body,'fixed_foreign_unit1');const job=await f.worker.claim();
 f.worker.supervisor=async()=>{throw Object.assign(Error('unknown stop'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped:false});};
 await assert.rejects(f.worker.run(job),{code:'QUANT_PROCESS_STOP_UNCONFIRMED'});
 await f.worker.fixedEval.failed(job,{code:'QUANT_PROCESS_STOP_UNCONFIRMED'});
 await f.db.query("UPDATE public.quant_research_chunks SET unit_name=$2 WHERE run_id=$1 AND step_id='eval:base'",[job.run_id,'robot-quant-foreign.service']);
 const evidence=async()=>({chunks:(await f.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[job.run_id])).rows,
  quant:(await f.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows,
  foundation:(await f.db.query('SELECT * FROM public.quant_foundation_jobs WHERE job_id=$1',[job.run_id])).rows});
 const before=await evidence();let stopCalls=0;f.worker.stopUnit=async()=>{stopCalls++;return true;};
 f.worker.stopped.add(job.run_id+':'+job.lease_token);
 await assert.rejects(f.worker.fixedEval.reconcile(job.foundation),{code:'FIXED_EVAL_RECORDS_INVALID'});
 assert.equal(stopCalls,0);assert.deepEqual(await evidence(),before);
});

test('real PG: stop cleanup requires the exact evidence validated before stopping',async t=>{
 const f=await setup(t);await f.fixedService.enqueue(f.owner,f.body,'fixed_stop_evidence1');const job=await f.worker.claim();
 f.worker.supervisor=async()=>{throw Object.assign(Error('unknown stop'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped:false});};
 await assert.rejects(f.worker.run(job),{code:'QUANT_PROCESS_STOP_UNCONFIRMED'});
 await f.worker.fixedEval.failed(job,{code:'QUANT_PROCESS_STOP_UNCONFIRMED'});
 const chunks=(await f.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[job.run_id])).rows;
 f.worker.stopped.add(job.run_id+':'+job.lease_token);
 f.worker.stopUnit=async()=>{await f.db.query('UPDATE public.quant_jobs SET diagnostic=$2 WHERE run_id=$1',[job.run_id,'CHANGED_DURING_STOP']);return true;};
 await assert.rejects(f.worker.fixedEval.reconcile(job.foundation),{code:'FIXED_EVAL_STOP_EVIDENCE_CHANGED'});
 assert.deepEqual((await f.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[job.run_id])).rows,chunks);
 assert.equal((await f.db.query('SELECT status FROM public.quant_foundation_jobs WHERE job_id=$1',[job.run_id])).rows[0].status,'STOPPING');
});

test('real PG and actual Python base: cold recovery preserves the step but terminalizes without a stress retry',async t=>{
 const f=await setup(t),stopped=new Set(),calls=[];f.worker.supervisor=pythonSupervisor(stopped,calls);f.worker.stopUnit=async unit=>stopped.has(unit);
 await f.fixedService.enqueue(f.owner,f.body,'fixed_cold_base_01');let job=await f.worker.claim();job=await f.worker.fixedEval.prepare(job);
 await f.worker.fixedEval.step(job,{step_id:'eval:base',kind:'EVALUATION'});assert.deepEqual(calls,['EVALUATION']);
 const recovery=await recoverQuantFoundation({db:f.db,policy:{workerUnit:'fe2b-fixture-worker.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},inventory:async()=>{},settleMs:0});
 assert.equal(recovery.recovered[0].status,'CANCELLED');assert.equal((await f.fixedService.read(f.owner,job.run_id)).status,'FAILED');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM public.quant_job_steps WHERE run_id=$1',[job.run_id])).rows[0].n,1);
 assert.equal(await f.worker.scheduler.claim('no-requeue'),null);assert.deepEqual(calls,['EVALUATION']);
});

for(const malformed of [false,true])test('real PG: claim-only cold recovery '+(malformed?'rejects a non-pristine mirror without changes':'terminalizes the pristine mirror without binding or launch'),async t=>{
 const f=await setup(t),admitted=await f.fixedService.enqueue(f.owner,f.body,'fixed_claim_gap_'+String(malformed));
 const foundation=await f.worker.scheduler.claim('claim-only-crash');assert.equal(foundation.job_id,admitted.evaluation_run_id);
 const runId=admitted.evaluation_run_id;
 assert.equal((await f.db.query('SELECT status FROM public.quant_jobs WHERE run_id=$1',[runId])).rows[0].status,'QUEUED');
 if(malformed)await f.db.query('UPDATE public.quant_jobs SET evaluations_started=1 WHERE run_id=$1',[runId]);
 const snapshot=async()=>({quant:(await f.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1',[runId])).rows,
  foundation:(await f.db.query('SELECT * FROM public.quant_foundation_jobs WHERE job_id=$1',[runId])).rows});
 const before=await snapshot();let stopCalls=0;
 const recover=()=>recoverQuantFoundation({db:f.db,policy:{workerUnit:'fe2b-fixture-worker.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>'',stop:async()=>{stopCalls++;}},inventory:async()=>{},settleMs:0});
 if(malformed){await assert.rejects(recover(),{code:'RECOVERY_FIXED_RECORDS_INVALID'});assert.deepEqual(await snapshot(),before);}
 else{
  assert.equal((await recover()).recovered[0].status,'CANCELLED');
  assert.equal((await f.fixedService.read(f.owner,runId)).status,'FAILED');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.quant_research_chunks WHERE run_id=$1',[runId])).rows[0].n,0);
  assert.equal(await f.worker.scheduler.claim('never-resume-gap'),null);
 }
 assert.equal(stopCalls,0);
});
