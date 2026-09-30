import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {createLocalPythonRunner} from '../../src/quant-research/preflight-replay.js';
import {canonical} from '../../src/pine-bridge/source.js';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createHarness,createWorld,fixtureEnvelope} from '../helpers/preflight-pg-fixture.mjs';

// Real isolated PostgreSQL, real resolver and replay driver. The supervisor adapter below runs
// local Python only; it is not evidence of Linux systemd or production I/O isolation.
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=path.resolve(root,'quant_lab/.venv/Scripts/python.exe');
const local=createLocalPythonRunner({python,developmentOnly:true,
 shim:path.resolve(root,'test/helpers/pf2_replay_shim.py')});
let admin,base,h;
const dispose=[];
let workers,queuedIds,releaseGates;
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 base=await createPf2Base({after:cleanup=>dispose.push(cleanup)});
 h=await createHarness({admin,base});dispose.push(()=>h.dispose());
});
after(async()=>{for(const cleanup of dispose.reverse())await cleanup();await admin?.close();});
beforeEach(()=>{workers=new Set();queuedIds=[];releaseGates=[];});
afterEach(async()=>{
 // Release test-controlled terminal gates before stop() joins a production loop.
 for(const release of releaseGates)release();
 let drained=false;
 try{
  for(const w of workers){
   const stopping=w.stop();
   await bounded(Promise.all([stopping,...w.testTicks]),'worker cleanup',20000);
  }
  drained=true;
 }finally{
  // Every launch is now settled. The synthetic supervisor's stopUnit is the trusted
  // proof used only to clean up fixture rows after an assertion fails.
  if(drained){
   const cleanup=worker();
   for(const id of queuedIds){
    const saved=await row(id);
    if(!['QUEUED','PAUSED','RUNNING','STOPPING'].includes(saved.status))continue;
    await cleanup.scheduler.cancel(saved.owner_id,id);
    const stopped=await row(id);
    if(stopped.status==='STOPPING'){
     const unit=await binding(id);
     if(unit.unit_name)assert.equal(await cleanup.stopUnit(unit.unit_name),true);
     cleanup.stopped.add(id+':'+stopped.lease_token);await cleanup.reconcile();
    }
   }
  }
 }
});
const row=async id=>(await h.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
const binding=async id=>(await h.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[id])).rows[0];
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,label,timeoutMs=45000){
 let timer;
 try{return await Promise.race([promise,new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error(label+' timed out')),timeoutMs);
 })]);}finally{clearTimeout(timer);}
}
async function launched(started,pending,id){
 return bounded(Promise.race([started.promise,pending.then(async()=>{
  const saved=await row(id);
  throw Error('tick ended before launch: '+saved.status+' '+saved.diagnostic);
 })]),'PREFLIGHT launch');
}
const abortFailure=(signal,stopped=true)=>new Promise((resolve,reject)=>{
 const stop=()=>reject(Object.assign(new Error('RESEARCH_INTERRUPTED'),{code:'RESEARCH_INTERRUPTED',stopped}));
 if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});
});
async function replay(options){
 assert.equal(options.module,'robot_quant.pf2_replay');
 assert.match(options.unitName,/^robot-quant-[a-f0-9-]+\.service$/);
 const answer=await local(Buffer.from(canonical(options.payload)+'\n'),{signal:options.signal});
 if(answer.exitCode!==0)throw Object.assign(new Error('RESEARCH_INTERRUPTED'),{code:'RESEARCH_INTERRUPTED',stopped:true});
 return JSON.parse(answer.stdout.toString('utf8'));
}
function worker({supervisor=replay,health=async()=>({ok:true}),clock=Date.now,preflightService=h.service,leaseMs=30000,stopUnit=async()=>true}={}){
 const w=new QuantResearchFoundationWorker({service:{db:h.db,foundation:true,datasetStore:h.stores.research,
  storageBudget:h.stores.research.storageBudget,executorMode:()=>h.data.ready()},dataService:h.data,
  preflightService,capacityPolicy:h.capacityPolicy,health,clock,leaseMs,supervisor,stopUnit,python,
  allowUnsupportedPlatformForTests:true});
 w.testTicks=new Set();const tick=w.tick.bind(w);
 w.tick=(...args)=>{
  const pending=tick(...args);w.lastTick=pending;w.testTicks.add(pending);
  void pending.then(()=>w.testTicks.delete(pending),()=>w.testTicks.delete(pending));
  return pending;
 };
 workers.add(w);return w;
}
async function queued(){
 const world=await createWorld(h);
 const job=await h.tx(()=>h.service.enqueue(world.owner,world.request,'fixture-worker-'+randomUUID()));
 queuedIds.push(job.job_id);
 return {world,id:job.job_id};
}

test('actual worker completes serial replay, persists checkpoints, clears unit and publishes bounded envelope',async()=>{
 const {id}=await queued();let launches=0,active=0,maxActive=0,checkpoints=0;
 const w=worker({supervisor:async options=>{
  launches++;maxActive=Math.max(maxActive,++active);
  const saved=await binding(id);assert.equal(saved.unit_name,options.unitName);
  assert.equal(saved.unit_token,(await row(id)).lease_token);
  try{return await replay(options);}finally{active--;}
 }});
 const checkpoint=w.scheduler.checkpoint.bind(w.scheduler);
 w.scheduler.checkpoint=async(...args)=>{const result=await checkpoint(...args);checkpoints++;return result;};
 assert.equal(await bounded(w.tick(),'successful replay'),true);
 const saved=await row(id);assert.equal(saved.status,'SUCCEEDED',saved.diagnostic);assert.equal(launches,3);
 assert.equal(maxActive,1);assert.equal(checkpoints,2);assert.equal(saved.next_bar,2000);
 assert.equal(saved.checkpoint.state.version,'pf2-replay-resume-v1');
 assert.equal(saved.result.run.chunks_executed,3);assert.equal(saved.result.admission.evaluator_admission,false);
 assert.equal((await binding(id)).unit_name,null);assert.equal(w.activeLaunches.size,0);
 assert.equal((await h.db.query('SELECT count(*)::int n FROM quant_jobs WHERE run_id=$1',[id])).rows[0].n,0);
});

test('cancel waits for supervisor stop and releases without a research binding',async()=>{
 const {world,id}=await queued(),started=deferred();let stopping=0;
 const w=worker({supervisor:options=>{started.resolve();return abortFailure(options.signal);},stopUnit:async()=>{stopping++;return true;}});
 const pending=w.tick();
 try{await launched(started,pending,id);await w.scheduler.cancel(world.owner,id);await bounded(pending,'cancelled tick');}
 finally{w.controller?.abort();await bounded(pending,'cancel cleanup');}
 assert.equal((await row(id)).status,'CANCELLED');assert.equal((await binding(id)).unit_name,null);
 assert.equal(w.activeLaunches.size,0);assert.equal(stopping,0);
});

test('health loss after first checkpoint pauses; new claim resolves fresh and resumes remaining bars',async()=>{
 const {id}=await queued(),started=deferred();let healthy=true,launches=0,trusted=0;
 const service=Object.create(h.service);service.trusted=job=>{trusted++;return h.service.trusted(job);};
 const w=worker({preflightService:service,health:async()=>({ok:healthy}),
  supervisor:options=>{if(++launches===1)return replay(options);healthy=false;started.resolve();return abortFailure(options.signal);}});
 const pending=w.tick();
 try{await launched(started,pending,id);await bounded(pending,'health-loss tick');}
 finally{w.controller?.abort();await bounded(pending,'health-loss cleanup');}
 const paused=await row(id);assert.equal(paused.status,'PAUSED');assert.equal(paused.next_bar,1000);
 const token=structuredClone(paused.checkpoint),deadline=paused.deadline_at;
 healthy=true;w.supervisor=replay;
 await bounded(w.tick(),'resumed replay');const finished=await row(id);
 assert.equal(finished.status,'SUCCEEDED',finished.diagnostic);assert.equal(finished.attempts,2);
 assert.equal(finished.result.run.resumed_from_bar,1000);assert.equal(finished.result.run.chunks_executed,2);
 assert.equal(finished.deadline_at,deadline);assert.equal(token.state.next_bar,1000);assert.equal(trusted,2);
});

test('queued revocation cancels without launch; absent service retains safe refusal',async()=>{
 const {world,id}=await queued();let launches=0;
 await h.db.query("UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",[world.deploymentId]);
 const w=worker({supervisor:async()=>{launches++;throw Error('unexpected');}});
 assert.equal(await bounded(w.tick(),'revoked claim'),false);assert.equal((await row(id)).diagnostic,'AUTHORIZATION_REVOKED');assert.equal(launches,0);
 const next=await queued();w.preflightService=undefined;
 assert.equal(await bounded(w.tick(),'disabled claim'),false);assert.equal((await row(next.id)).diagnostic,'AUTHORIZATION_REVOKED');
});

test('epoch deadline before next chunk forbids a later launch',async()=>{
 const {id}=await queued();let now=Date.now(),launches=0;
 const w=worker({clock:()=>now,supervisor:options=>{launches++;return replay(options);}});
 const checkpoint=w.scheduler.checkpoint.bind(w.scheduler);
 w.scheduler.checkpoint=async(...args)=>{const saved=await checkpoint(...args);now=saved.deadline_at;return saved;};
 await bounded(w.tick(),'deadline tick');assert.equal(launches,1);assert.equal((await row(id)).status,'CANCELLED');
 assert.equal((await row(id)).diagnostic,'PF2_DEADLINE_EXCEEDED');assert.equal((await binding(id)).unit_name,null);
});

test('unconfirmed supervisor retains STOPPING and unit; cold reconciliation never fabricates proof',async()=>{
 const {world,id}=await queued();let launches=0;
 const w=worker({supervisor:async()=>{launches++;throw Object.assign(Error('private'),{code:'EVALUATION_FAILED',stopped:false});}});
 await bounded(w.tick(),'unconfirmed tick');const saved=await row(id);
 assert.equal(saved.status,'STOPPING');assert.equal(saved.diagnostic,'QUANT_PROCESS_STOP_UNCONFIRMED');
 assert.ok((await binding(id)).unit_name);assert.equal(launches,1);
 const cold=worker();await cold.reconcile();assert.equal((await row(id)).status,'STOPPING');
 // Cleanup only after the test supplies explicit live supervisor proof for this token.
 w.stopped.add(id+':'+saved.lease_token);await w.reconcile();
 assert.equal((await row(id)).status,'CANCELLED');assert.equal((await binding(id)).unit_name,null);
 assert.equal((await h.tx(()=>h.service.get(world.owner,id))).diagnostic,'QUANT_PROCESS_STOP_UNCONFIRMED');
});

test('scheduler refuses stale/unbound result within transaction and keeps the running lease',async()=>{
 const {id}=await queued(),w=worker(),job=await w.claim(),bound=await binding(id);
 assert.equal(job.kind,'PREFLIGHT');
 const resolved=await resolveHistoricalPreflight(JSON.parse(bound.plan_json),h.service.trusted(job.foundation),
  {now:Date.now(),supportedSourceHash:h.service.supportedSourceHash});
 const result=fixtureEnvelope({resolved,planHash:bound.plan_hash});result.plan_hash='a'.repeat(64);
 await assert.rejects(w.scheduler.finish(job.foundation,result),{code:'INTEGRITY_FAILED'});
 assert.equal((await row(id)).status,'RUNNING');assert.equal((await row(id)).result,null);
 await w.scheduler.cancel(job.foundation.owner_id,id);await w.reconcile();
 assert.equal((await row(id)).status,'CANCELLED');
});

test('offline recovery masks persisted PREFLIGHT unit and clears only the stopped token',async()=>{
 const {id}=await queued();
 const w=worker({supervisor:async()=>{throw Object.assign(Error('test'),{code:'QUANT_PROCESS_STOP_UNCONFIRMED',stopped:false});}});
 await bounded(w.tick(),'recovery setup tick');const saved=await row(id),unit=(await binding(id)).unit_name;
 const workerUnit='robot-quant-research-staging.service';
 const states=new Map([[workerUnit,{LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}],
  [unit,{LoadState:'loaded',ActiveState:'active',Job:'0',ControlGroup:''}]]);
 const manager={show:async name=>structuredClone(states.get(name)),jobs:async()=>'',
  kill:async name=>{states.get(name).ActiveState='inactive';},
  stop:async name=>{states.get(name).ActiveState='inactive';},
  mask:async name=>{states.get(name).LoadState='masked';}};
 const result=await recoverQuantFoundation({db:h.db,policy:{workerUnit},manager,inventory:async()=>{},settleMs:0});
 assert.deepEqual(result.recovered,[{job_id:id,status:'CANCELLED'}]);assert.deepEqual(result.maskedUnits,[unit]);
 assert.equal((await binding(id)).unit_name,null);assert.equal((await row(id)).lease_token,null);
 assert.equal(saved.diagnostic,'QUANT_PROCESS_STOP_UNCONFIRMED');
});

test('production start/stop loop waits for active PREFLIGHT launch and preserves fixed failure diagnostic',async()=>{
 const {id}=await queued(),started=deferred(),settle=deferred();let exited=false;
 const w=worker({supervisor:async options=>{
  started.resolve();
  try{await abortFailure(options.signal);}catch{await settle.promise;exited=true;
   throw Object.assign(Error('private supervisor message'),{code:'RESEARCH_INTERRUPTED',stopped:true});}
 }});
 releaseGates.push(settle.resolve);
 w.start();let stopped=false;
 try{
  await launched(started,w.lastTick,id);
  const stopping=w.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(stopped,false);
  assert.equal((await row(id)).status,'RUNNING');assert.ok((await binding(id)).unit_name);
  settle.resolve();await bounded(stopping,'production loop stop');
 }finally{settle.resolve();await bounded(w.stop(),'production loop cleanup');}
 assert.equal(exited,true);assert.equal(stopped,true);assert.equal((await row(id)).status,'CANCELLED');
 assert.equal((await row(id)).diagnostic,'PF2_CANCELLED');assert.equal((await binding(id)).unit_name,null);
});

test('confirmed supervisor error stores only allowlisted runner suffix',async()=>{
 const {id}=await queued();
 const w=worker({supervisor:async()=>{throw Object.assign(Error('secret marker'),{code:'EVALUATION_FAILED',stopped:true});}});
 await bounded(w.tick(),'confirmed failure tick');assert.equal((await row(id)).status,'CANCELLED');
 assert.equal((await row(id)).diagnostic,'PF2_RUNNER_FAILED:EVALUATION_FAILED');
 assert.equal((await binding(id)).unit_name,null);
});
