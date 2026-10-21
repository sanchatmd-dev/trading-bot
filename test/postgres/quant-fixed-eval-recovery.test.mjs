import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {fixedEvalUnitName} from '../../src/postgres/quant-fixed-eval.js';

/** Guarded isolated PostgreSQL. The offline manager below is synthetic, not native QS/systemd evidence. */
async function setup(t){
 assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
 const f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL),directory=await fs.mkdtemp(path.join(os.tmpdir(),'fe2b-recovery-'));
 t.after(async()=>{try{await f.close();}finally{await fs.rm(directory,{recursive:true,force:true});}});
 await f.db.query(await fs.readFile(new URL('../../src/postgres/quant-storage-schema.sql',import.meta.url),'utf8'));
 const root=path.join(directory,'datasets');await f.db.transaction(()=>bindQuantStorage(f.db,root));
 const research={foundation:true,db:f.db,pine:f.service.pine,store:f.store,datasetStore:new ResearchDatasetStore({root}),executorMode:async()=>{
  assert.equal((await f.db.query('SELECT mode FROM public.quant_research_executor_mode WHERE singleton')).rows[0].mode,'FOUNDATION');
 }};
 const calls=[],worker=new QuantResearchFoundationWorker({service:research,fixedEvalService:f.service,health:async()=>({ok:true}),supervisor:async()=>{
  throw Object.assign(Error('Synthetic interrupted launch after durable intent'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped:false});
 }});worker.controller=new AbortController();
 // These test-only observers prove cleanup occurs while the research parent is nonterminal.
 // Production immutable guards remain installed and enabled throughout.
 await f.db.query(`CREATE TABLE fe2b_cleanup_observations(step_id text,parent_status text);
  CREATE FUNCTION fe2b_observe_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
   IF OLD.unit_name IS NOT NULL AND NEW.unit_name IS NULL THEN
    INSERT INTO fe2b_cleanup_observations SELECT OLD.step_id,status FROM quant_jobs WHERE run_id=OLD.run_id;
   END IF;
   RETURN NEW;
  END $$;
  CREATE TRIGGER fe2b_observe_cleanup BEFORE UPDATE ON quant_research_chunks FOR EACH ROW EXECUTE FUNCTION fe2b_observe_cleanup();
  CREATE FUNCTION fe2b_assert_cleanup_order() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
   IF NEW.status IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') AND OLD.status IN ('QUEUED','RUNNING')
    AND EXISTS(SELECT 1 FROM quant_research_chunks WHERE run_id=NEW.run_id AND (unit_name IS NOT NULL OR unit_token IS NOT NULL)) THEN
    RAISE EXCEPTION 'Fixed cleanup must precede terminal parent';
   END IF;
   RETURN NEW;
  END $$;
  CREATE TRIGGER fe2b_assert_cleanup_order BEFORE UPDATE ON quant_jobs FOR EACH ROW EXECUTE FUNCTION fe2b_assert_cleanup_order()`);
 const admitted=await f.service.enqueue(f.owner,f.body,'fixed_recovery_phase1');
 let job=await worker.claim();assert.equal(job.run_id,admitted.evaluation_run_id);job=await worker.fixedEval.prepare(job);
 const masked=[];
 const recover=()=>recoverQuantFoundation({db:f.db,policy:{workerUnit:'fe2b-fixture-worker.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>'',mask:async unit=>{masked.push(unit);}},
  inventory:async()=>{},settleMs:0});
 const snapshot=async()=>({quant:(await f.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows,
  foundation:(await f.db.query('SELECT * FROM public.quant_foundation_jobs WHERE job_id=$1',[job.run_id])).rows,
  chunks:(await f.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[job.run_id])).rows,
  steps:(await f.db.query('SELECT * FROM public.quant_job_steps WHERE run_id=$1 ORDER BY step_id',[job.run_id])).rows,
  observations:(await f.db.query('SELECT * FROM fe2b_cleanup_observations ORDER BY step_id')).rows});
 return {...f,worker,job,recover,snapshot,masked,calls};
}

/** Real Python base result, bounded subprocess and physical exit; explicitly not native QS/systemd proof. */
function pythonSupervisor(calls){
 return ({payload,module,signal,timeoutMs})=>new Promise((resolve,reject)=>{
  assert.equal(module,'robot_quant.fixed_eval_job');calls.push(payload.kind);
  const repo=fileURLToPath(new URL('../../',import.meta.url));
  const python=process.env.QUANT_RESEARCH_PYTHON??path.join(repo,'quant_lab/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  assert.ok(path.isAbsolute(python)&&existsSync(python),'Actual Python requires the configured interpreter or repository virtual environment');
  const child=spawn(python,['-m',module],{cwd:repo,env:{...process.env,PYTHONPATH:path.join(repo,'quant_lab/src')},stdio:['pipe','pipe','pipe']});
  let output='',reason=null;
  const abort=()=>{reason='RESEARCH_INTERRUPTED';child.kill('SIGKILL');};
  const timer=setTimeout(()=>{reason='EVALUATION_TIMED_OUT';child.kill('SIGKILL');},Math.min(timeoutMs,30000));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',bytes=>{output+=bytes;if(Buffer.byteLength(output)>8*1024*1024){reason='EVALUATION_OUTPUT_TOO_LARGE';child.kill('SIGKILL');}});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',()=>{reason='QUANT_PYTHON_UNAVAILABLE';});
  child.on('close',code=>{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(reason||code!==0){reject(Object.assign(Error(reason??'EVALUATION_FAILED'),{code:reason??'EVALUATION_FAILED',stopped:true}));return;}
   try{resolve(JSON.parse(output));}catch{reject(Object.assign(Error('INVALID_EVALUATION_RESPONSE'),{code:'INVALID_EVALUATION_RESPONSE',stopped:true}));}
  });
  child.stdin.end(JSON.stringify(payload));
 });
}

async function assertTerminal(f,before,expectedUnit=null){
 const recovered=await f.recover(),after=await f.snapshot();
 assert.deepEqual(recovered.recovered,[{job_id:f.job.run_id,status:'CANCELLED'}]);
 assert.equal(after.foundation[0].status,'CANCELLED');assert.equal(after.foundation[0].lease_token,null);
 assert.equal(after.quant[0].status,'FAILED');assert.equal(after.quant[0].lease_token,null);
 assert.equal(after.quant[0].attempt,1);assert.equal(after.foundation[0].attempts,1);
 assert.equal(after.quant[0].evaluations_started,before.quant[0].evaluations_started);
 assert.deepEqual(after.steps,before.steps);
 assert.deepEqual(after.chunks,before.chunks.map(row=>({...row,unit_name:null,unit_token:null})));
 assert.ok(after.chunks.every(row=>row.unit_name===null&&row.unit_token===null));
 assert.ok(after.observations.every(row=>row.parent_status==='RUNNING'));
 assert.deepEqual(f.masked,expectedUnit?[expectedUnit]:[]);
 const expectedObservations=[...before.observations];
 if(expectedUnit)expectedObservations.push({step_id:before.chunks.find(row=>row.unit_name===expectedUnit).step_id,parent_status:'RUNNING'});
 expectedObservations.sort((a,b)=>a.step_id.localeCompare(b.step_id));assert.deepEqual(after.observations,expectedObservations);
 assert.equal(await f.worker.scheduler.claim('no-resume-after-recovery'),null);
 await assert.rejects(f.worker.run(f.job));
 assert.deepEqual(await f.snapshot(),after);
 return after;
}

test('real PG cold recovery: prepared binding with no evaluation ends terminal without any launch',async t=>{
 const f=await setup(t),before=await f.snapshot();
 assert.equal(before.chunks.length,1);assert.equal(before.quant[0].evaluations_started,0);assert.equal(before.steps.length,0);
 await assertTerminal(f,before);assert.deepEqual(f.calls,[]);
});

test('real PG cold recovery: base launch intent with no result clears the exact unit before terminal freeze',async t=>{
 const f=await setup(t);
 await assert.rejects(f.worker.fixedEval.step(f.job,{step_id:'eval:base',kind:'EVALUATION'}),{code:'QUANT_PROCESS_STOP_UNCONFIRMED'});
 const before=await f.snapshot(),unit=fixedEvalUnitName(f.job.run_id,'eval:base',f.job.lease_token);
 assert.equal(before.quant[0].evaluations_started,1);assert.equal(before.steps.length,0);
 assert.equal(before.chunks.find(row=>row.step_id==='eval:base').unit_name,unit);
 await assertTerminal(f,before,unit);
});

test('real PG plus actual Python cold recovery: pending stress preserves the committed base and never retries stress',async t=>{
 const f=await setup(t);f.worker.supervisor=pythonSupervisor(f.calls);
 await f.worker.fixedEval.step(f.job,{step_id:'eval:base',kind:'EVALUATION'});assert.deepEqual(f.calls,['EVALUATION']);
 f.worker.supervisor=async()=>{throw Object.assign(Error('Synthetic interrupted stress'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped:false});};
 await assert.rejects(f.worker.fixedEval.step(f.job,{step_id:'eval:stress',kind:'EVALUATION_STRESS'}),{code:'QUANT_PROCESS_STOP_UNCONFIRMED'});
 const before=await f.snapshot(),unit=fixedEvalUnitName(f.job.run_id,'eval:stress',f.job.lease_token);
 assert.equal(before.quant[0].evaluations_started,2);assert.equal(before.steps.length,1);assert.equal(before.steps[0].step_id,'eval:base');
 await assertTerminal(f,before,unit);assert.deepEqual(f.calls,['EVALUATION']);
});

for(const corruption of ['counter','extra-progress'])test('real PG cold recovery refuses '+corruption+' and preserves every persisted record',async t=>{
 const f=await setup(t);
 if(corruption==='counter')await f.db.query('UPDATE public.quant_jobs SET evaluations_started=1 WHERE run_id=$1',[f.job.run_id]);
 else await f.db.query("UPDATE public.quant_research_chunks SET next_bar=1 WHERE run_id=$1 AND step_id='prepare:dataset'",[f.job.run_id]);
 const before=await f.snapshot();
 await assert.rejects(f.recover(),{code:'RECOVERY_FIXED_RECORDS_INVALID'});
 assert.deepEqual(await f.snapshot(),before);assert.deepEqual(f.masked,[]);
 assert.equal(before.quant[0].status,'RUNNING');assert.equal(before.foundation[0].status,'RUNNING');
});
