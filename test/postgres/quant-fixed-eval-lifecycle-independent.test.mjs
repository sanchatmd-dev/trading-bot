import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantFixedEvalService} from '../../src/postgres/quant-fixed-eval.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {cancelSelection} from '../../src/postgres/selection-store.js';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';

// Root's disposable TEST_DATABASE_URL only. No physical supervisor or Python process runs here.
// A distinct LOGIN connection exercises the canonical runtime grants and all installed guards.
async function withRuntime(work){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  let fixture,runtime,admin,role,directory;
  try{
    fixture=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'fe2b-independent-'));
    const root=path.join(directory,'datasets');
    await fixture.db.query(await fs.readFile(new URL('../../src/postgres/quant-storage-schema.sql',import.meta.url),'utf8'));
    await fixture.db.transaction(()=>bindQuantStorage(fixture.db,root));
    admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
    role='fe2b_independent_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE ROLE '+role+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT'+rolePasswordClause(fixture.connectionString));
    const grants=await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8');
    await fixture.db.query(grants.replaceAll(":'runtime_role'","'"+role+"'"));
    const url=new URL(fixture.connectionString);url.username=role;
    runtime=new PostgresDatabase({connectionString:url.toString(),max:4});
    assert.deepEqual((await runtime.query('SELECT current_user AS role,session_user AS session')).rows[0],{role,session:role});
    assert.equal((await runtime.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,false);
    const store=new Store(runtime),pine=new PineBridgeService(store);
    const service=new QuantFixedEvalService({pineService:pine,supportedSourceHash:fixture.c.source_hash,engineHash:async()=>fixture.context.engine});
    const worker=new QuantResearchFoundationWorker({
      service:{foundation:true,db:runtime,store,pine,datasetStore:new ResearchDatasetStore({root}),executorMode:async()=>{
        assert.equal((await runtime.query('SELECT mode FROM public.quant_research_executor_mode WHERE singleton')).rows[0].mode,'FOUNDATION');
      }},
      fixedEvalService:service,health:async()=>({ok:true}),
      supervisor:async()=>{throw Error('Independent test must install its deferred supervisor');}
    });
    worker.controller=new AbortController();
    await work({f:fixture,runtime,service,worker});
  }finally{
    try{await runtime?.close();}finally{
      try{await fixture?.close();}finally{
        try{if(role)await admin?.query('DROP ROLE IF EXISTS '+role);}finally{
          try{await admin?.close();}finally{if(directory)await fs.rm(directory,{recursive:true,force:true});}
        }
      }
    }
  }
}

function deferredSupervisor(worker){
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  worker.supervisor=async request=>{
    enter(request);
    const stopped=await gate;
    throw Object.assign(Error('Independent deferred launch stopped'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped});
  };
  return {entered,release};
}

async function waitForLaunch(entered){
  let timer;
  try{return await Promise.race([entered,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Deferred supervisor was not reached')),10000);
  })]);}finally{clearTimeout(timer);}
}

async function begin(context,key){
  const {f,service,worker}=context;
  const admitted=await service.enqueue(f.owner,f.body,key);assert.equal(admitted.ok,true);
  const claimed=await worker.claim();assert.equal(claimed?.run_id,admitted.evaluation_run_id);
  const job=await worker.fixedEval.prepare(claimed);
  return {job,key:job.run_id+':'+job.lease_token};
}

async function snapshot(runtime,runId){
  const q=(await runtime.query('SELECT status,lease_token,evaluations_started,diagnostic FROM public.quant_jobs WHERE run_id=$1',[runId])).rows[0];
  const foundation=(await runtime.query('SELECT status,lease_token FROM public.quant_foundation_jobs WHERE job_id=$1',[runId])).rows[0];
  const units=(await runtime.query('SELECT step_id,unit_name,unit_token FROM public.quant_research_chunks WHERE run_id=$1 AND (unit_name IS NOT NULL OR unit_token IS NOT NULL)',[runId])).rows;
  const steps=(await runtime.query('SELECT count(*)::int AS n FROM public.quant_job_steps WHERE run_id=$1',[runId])).rows[0].n;
  return {q,foundation,units,steps};
}

async function assertHeld(runtime,job){
  const state=await snapshot(runtime,job.run_id);
  assert.equal(state.q.status,'RUNNING');assert.equal(state.foundation.status,'STOPPING');
  assert.equal(state.q.lease_token,job.lease_token);assert.equal(state.foundation.lease_token,job.lease_token);
  assert.equal(state.q.evaluations_started,1);assert.equal(state.steps,0);
  assert.equal(state.units.length,1);assert.equal(state.units[0].unit_token,job.lease_token);
  return state;
}

test('independent FE2b: pending launch and unconfirmed stop each retain the global slot despite another eligible job',{timeout:120000},()=>withRuntime(async context=>{
  const {f,runtime,service,worker}=context,{job,key}=await begin(context,'independent_pending_01');
  const other=f.registration.participants.find(row=>row.export_id!==f.body.participant_id);
  assert.ok(other,'Fixture supplies a distinct eligible participant');
  const queued=await service.enqueue(f.owner,{...f.body,participant_id:other.export_id},'independent_waiter_01');
  assert.equal(queued.ok,true);assert.notEqual(queued.evaluation_run_id,job.run_id);
  const barrier=deferredSupervisor(worker);let pending;
  let stopCalls=0;worker.stopUnit=async()=>{stopCalls++;return true;};
  try{
    pending=worker.fixedEval.step(job,{step_id:'eval:base',kind:'EVALUATION'}).then(()=>null,error=>error);
    const request=await waitForLaunch(barrier.entered);assert.match(request.unitName,/^robot-quant-/);
    assert.equal(worker.activeLaunches.has(key),true);
    assert.equal((await service.cancel(f.owner,job.run_id)).status,'STOPPING');
    // Even an externally supplied stopped proof cannot release a launcher still awaiting completion.
    worker.stopped.add(key);
    assert.equal(await worker.fixedEval.reconcile(job.foundation),false);
    assert.equal(stopCalls,0);await assertHeld(runtime,job);
    assert.equal(await worker.scheduler.claim('independent-pending-blocked'),null);
    worker.stopped.delete(key);barrier.release(false);
    const error=await pending;assert.equal(error.stopped,false);
    assert.equal(worker.activeLaunches.has(key),false);assert.equal(worker.stopped.has(key),false);
    await worker.fixedEval.failed(job,error);
    assert.equal(stopCalls,0);await assertHeld(runtime,job);
    assert.equal(await worker.scheduler.claim('independent-unconfirmed-blocked'),null);
    worker.stopped.add(key);worker.stopUnit=async()=>{stopCalls++;return false;};
    assert.equal(await worker.fixedEval.reconcile(job.foundation),false);
    assert.equal(stopCalls,1);await assertHeld(runtime,job);
    worker.stopUnit=async()=>{stopCalls++;return true;};
    assert.equal(await worker.fixedEval.reconcile(job.foundation),true);
    const released=await snapshot(runtime,job.run_id);
    assert.equal(released.q.status,'CANCELLED');assert.equal(released.foundation.status,'CANCELLED');
    assert.equal(released.units.length,0);assert.equal(released.steps,0);
    assert.equal((await runtime.query('SELECT status FROM public.quant_foundation_jobs WHERE job_id=$1',[queued.evaluation_run_id])).rows[0].status,'QUEUED');
    const next=await worker.scheduler.claim('independent-after-release');
    assert.equal(next?.job_id,queued.evaluation_run_id,'The waiting job was eligible throughout the retained slot');
  }finally{barrier.release(false);await pending;}
}));

test('independent FE2b: revoked authority still permits exact-token stop cleanup before the guarded terminal write',{timeout:120000},()=>withRuntime(async context=>{
  const {f,runtime,service,worker}=context,{job,key}=await begin(context,'independent_cleanup_01');
  const guardSql="SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN ('public.quant_jobs'::regclass,'public.quant_research_chunks'::regclass) AND tgname IN ('quant_job_terminal_freeze','quant_research_chunk_terminal_freeze') ORDER BY tgname";
  const guards=(await runtime.query(guardSql)).rows;
  assert.equal(guards.length,2);assert.ok(guards.every(row=>row.tgenabled==='A'));
  const barrier=deferredSupervisor(worker);let pending;
  const cleanup=[];const query=runtime.query.bind(runtime);
  runtime.query=async(sql,args=[])=>{
    if(sql.startsWith('UPDATE public.quant_research_chunks SET unit_name=NULL,unit_token=NULL WHERE run_id=$1 AND unit_token=$2')){
      const before=await snapshot({query},job.run_id);
      cleanup.push({transaction:runtime.isTransaction,args:[...args],before});
      const answer=await query(sql,args);
      cleanup.at(-1).after=await snapshot({query},job.run_id);
      return answer;
    }
    return query(sql,args);
  };
  let stopCalls=0,confirmed=false;
  worker.stopUnit=async unit=>{
    stopCalls++;const state=await snapshot(runtime,job.run_id);
    assert.equal(state.q.status,'RUNNING');assert.equal(state.units.length,1);
    assert.equal(unit,state.units[0].unit_name);return confirmed;
  };
  try{
    pending=worker.fixedEval.step(job,{step_id:'eval:base',kind:'EVALUATION'}).then(()=>null,error=>error);
    await waitForLaunch(barrier.entered);
    assert.equal((await service.cancel(f.owner,job.run_id)).status,'STOPPING');
    assert.equal((await cancelSelection(runtime,{owner_id:f.owner,selection_id:f.body.object_id,confirmed:true})).ok,true);
    await runtime.query("UPDATE public.users SET status='SUSPENDED' WHERE id=$1",[f.owner]);
    barrier.release(true);assert.equal((await pending).stopped,true);
    assert.equal(worker.activeLaunches.has(key),false);assert.equal(worker.stopped.has(key),true);
    const wrongToken=randomUUID(),wrongKey=job.run_id+':'+wrongToken;
    worker.stopped.add(wrongKey);
    assert.equal(await worker.fixedEval.reconcile({...job.foundation,lease_token:wrongToken}),false);
    worker.stopped.delete(wrongKey);assert.equal(stopCalls,0);assert.equal(cleanup.length,0);
    assert.equal(await worker.fixedEval.reconcile(job.foundation),false);
    assert.equal(stopCalls,1);assert.equal(cleanup.length,0);await assertHeld(runtime,job);
    confirmed=true;
    assert.equal(await worker.fixedEval.reconcile(job.foundation),true,'Revocation must not strand an already stopped token');
    assert.equal(cleanup.length,1);assert.equal(cleanup[0].transaction,true);
    assert.deepEqual(cleanup[0].args,[job.run_id,job.lease_token]);
    assert.equal(cleanup[0].before.q.status,'RUNNING');assert.equal(cleanup[0].before.units.length,1);
    assert.equal(cleanup[0].after.q.status,'RUNNING');assert.equal(cleanup[0].after.units.length,0);
    const terminal=await snapshot(runtime,job.run_id);
    assert.equal(terminal.q.status,'CANCELLED');assert.equal(terminal.q.diagnostic,'FIXED_EVAL_OWNER_CANCELLED');
    assert.equal(terminal.foundation.status,'CANCELLED');assert.equal(terminal.q.lease_token,null);
    assert.equal(terminal.foundation.lease_token,null);assert.equal(terminal.units.length,0);assert.equal(terminal.steps,0);
    assert.deepEqual((await runtime.query(guardSql)).rows,guards);
    await assert.rejects(runtime.query("UPDATE public.quant_research_chunks SET next_bar=next_bar+1 WHERE run_id=$1 AND step_id='eval:base'",[job.run_id]),{code:'QR001'});
    assert.equal(await worker.fixedEval.reconcile(job.foundation),false);
    assert.equal(cleanup.length,1);assert.equal(stopCalls,2);
  }finally{barrier.release(true);await pending;runtime.query=query;}
}));
