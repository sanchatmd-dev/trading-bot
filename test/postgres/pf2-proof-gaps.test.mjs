import test,{describe,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchFoundationWorker,capturePreflightRunChunkForTest} from '../../src/postgres/quant-research-foundation.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {RESEARCH_V2_VERSIONS} from '../../src/quant-research/research-contract-v2.js';
import {createLocalPythonRunner} from '../../src/quant-research/preflight-replay.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createHarness,createWorld} from '../helpers/preflight-pg-fixture.mjs';
import {quantResearchHttpFixture} from '../helpers/quant-research-prepare-fixture.mjs';
import {source} from '../helpers/quant-research-fixture.mjs';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

// Proof gaps of the PF-2 carry notes (R5-19, R5-21, R5-23, S3b-9, W3-4). Isolated local PostgreSQL only. The PF-2
// suite runs the real resolver and replay driver over local Python; its supervisor is a synthetic stand-in for
// systemd, so none of this is evidence of Linux systemd or production I/O isolation.
const root=fileURLToPath(new URL('../../',import.meta.url));
// The uv-synced quant_lab/.venv interpreter: Scripts on Windows, bin elsewhere.
const python=process.env.QUANT_TEST_PYTHON??path.resolve(root,'quant_lab/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,label,timeoutMs=45000){
 let timer;
 try{return await Promise.race([promise,new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error(label+' timed out')),timeoutMs);
 })]);}finally{clearTimeout(timer);}
}

describe('PF-2 worker: R5-19 recovery of a never-loaded unit, R5-21 serial launches, R5-23 conditional unit clear',()=>{
 let admin,base,h,local;
 const dispose=[];
 let workers,queuedIds,releaseGates;
 before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  assert.ok(existsSync(python),'PF-2 proof tests need the quant_lab/.venv interpreter (uv sync) or QUANT_TEST_PYTHON');
  local=createLocalPythonRunner({python,developmentOnly:true,shim:path.resolve(root,'test/helpers/pf2_replay_shim.py')});
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  base=await createPf2Base({after:cleanup=>dispose.push(cleanup)});
  h=await createHarness({admin,base});dispose.push(()=>h.dispose());
 });
 after(async()=>{for(const cleanup of dispose.reverse())await cleanup();await admin?.close();});
 beforeEach(()=>{workers=new Set();queuedIds=[];releaseGates=[];});
 afterEach(async()=>{
  for(const release of releaseGates)release();
  let drained=false;
  try{
   for(const w of workers)await bounded(Promise.allSettled([w.stop(),...w.testTicks]),'worker cleanup',20000);
   drained=true;
  }finally{
   if(drained)for(const id of queuedIds)await settle(id);
  }
 });
 const row=async id=>(await h.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
 const binding=async id=>(await h.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[id])).rows[0];
 async function launched(started,pending,id){
  return bounded(Promise.race([started.promise,pending.then(async()=>{
   const saved=await row(id);
   throw Error('tick ended before launch: '+saved.status+' '+saved.diagnostic);
  })]),'PREFLIGHT launch');
 }
 async function replay(options){
  assert.equal(options.module,'robot_quant.pf2_replay');
  assert.match(options.unitName,/^robot-quant-[a-f0-9-]+[.]service$/);
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
   const pending=tick(...args);w.testTicks.add(pending);
   void pending.then(()=>w.testTicks.delete(pending),()=>w.testTicks.delete(pending));
   return pending;
  };
  workers.add(w);return w;
 }
 async function queued(){
  const world=await createWorld(h);
  const job=await h.tx(()=>h.service.enqueue(world.owner,world.request,'fixture-proof-'+randomUUID()));
  queuedIds.push(job.job_id);
  return {world,id:job.job_id};
 }
 /**
  * Fixture hygiene after a test that deliberately leaves a job STOPPING. The synthetic supervisor owns the stop
  * proof of every unit it persisted, so the binding is wiped and the stop proof is supplied explicitly. A leftover
  * RUNNING or STOPPING row would otherwise hold the single executor slot for the next test.
  */
 async function settle(id){
  const saved=await row(id);
  if(!['QUEUED','PAUSED','RUNNING','STOPPING'].includes(saved.status))return;
  const cleanup=worker();
  await cleanup.scheduler.cancel(saved.owner_id,id);
  const stopped=await row(id);
  if(stopped.status!=='STOPPING')return;
  await h.db.query('UPDATE quant_preflight_jobs SET unit_name=NULL,unit_token=NULL WHERE job_id=$1',[id]);
  cleanup.stopped.add(id+':'+stopped.lease_token);await cleanup.reconcile();
 }

 test('R5-21 chunks launch strictly one at a time: a held chunk blocks every later launch',async()=>{
  const {id}=await queued(),events=[],entered=deferred(),gate=deferred();releaseGates.push(gate.resolve);
  let launches=0;
  const w=worker({supervisor:async options=>{
   const n=++launches;events.push('launch:'+n);
   assert.equal((await binding(id)).unit_name,options.unitName,'the unit is persisted before its launch');
   if(n===1){entered.resolve(options.unitName);await gate.promise;}
   const answer=await replay(options);events.push('settle:'+n);return answer;
  }});
  const pending=w.tick();
  const unit=await launched(entered,pending,id);
  // The first chunk is in flight and held. Nothing may launch beside it, however long it takes.
  await sleep(300);
  assert.equal(launches,1);assert.deepEqual(events,['launch:1']);
  assert.equal((await binding(id)).unit_name,unit);assert.equal((await row(id)).next_bar,0);
  gate.resolve();
  assert.equal(await bounded(pending,'serial replay'),true);
  const saved=await row(id);assert.equal(saved.status,'SUCCEEDED',saved.diagnostic);
  assert.deepEqual(events,['launch:1','settle:1','launch:2','settle:2','launch:3','settle:3']);
  assert.equal((await binding(id)).unit_name,null);
 });

 test('R5-21 a second launch forced while a chunk runs is refused before any unit or process exists',async()=>{
  const {id}=await queued(),entered=deferred(),gate=deferred();releaseGates.push(gate.resolve);
  let launches=0;
  const w=worker({supervisor:async options=>{
   if(++launches===1){entered.resolve(options.unitName);await gate.promise;}
   return replay(options);
  }});
  const capture=capturePreflightRunChunkForTest(w);
  const fences=[],fenced=w.scheduler.fenced.bind(w.scheduler);
  w.scheduler.fenced=(job,action,update)=>{fences.push(action);return fenced(job,action,update);};
  const persists=()=>fences.filter(action=>action==='CHECKPOINT').length;
  const pending=w.tick();
  try{
   const unit=await launched(entered,pending,id);
   assert.equal(typeof capture.runChunk,'function','the run loop handed its runChunk wrapper to the driver');
   const before={persists:persists(),saved:await binding(id)};
   // The driver never calls the wrapper twice at once, so the overlap is forced from outside.
   await assert.rejects(capture.runChunk(Buffer.from('{}'),{signal:new AbortController().signal}),{code:'PF2_RUNNER_FAILED'});
   assert.equal(persists(),before.persists,'the overlap is refused before it asks to persist a unit');
   assert.equal(launches,1,'no second process was started');
   const after=await binding(id);
   assert.equal(after.unit_name,unit);assert.equal(after.unit_token,before.saved.unit_token);
   gate.resolve();
   assert.equal(await bounded(pending,'run after refused overlap'),true);
  }finally{capture.release();gate.resolve();await bounded(pending.catch(()=>{}),'overlap cleanup');}
  const saved=await row(id);assert.equal(saved.status,'SUCCEEDED',saved.diagnostic);
  assert.equal(launches,3);assert.equal((await binding(id)).unit_name,null);
 });

 test('R5-23 clearUnit does not clear a unit that carries another lease token',async()=>{
  const {id}=await queued(),foreign=randomUUID();let launches=0;
  const w=worker({stopUnit:async()=>false,supervisor:async options=>{
   launches++;
   const before=await binding(id);
   assert.equal(before.unit_name,options.unitName);assert.equal(before.unit_token,(await row(id)).lease_token);
   await h.db.query('UPDATE quant_preflight_jobs SET unit_token=$2 WHERE job_id=$1',[id,foreign]);
   return replay(options);
  }});
  await bounded(w.tick(),'foreign token tick');
  const saved=await row(id),bound=await binding(id);
  assert.equal(launches,1,'no chunk follows a refused clear');
  assert.equal(saved.status,'STOPPING');assert.equal(saved.diagnostic,'PF2_RUNNER_FAILED');
  assert.equal(saved.result,null);assert.equal(saved.next_bar,0);assert.equal(saved.checkpoint,null);
  assert.ok(bound.unit_name,'the unit stays persisted');assert.equal(bound.unit_token,foreign);
 });

 test('R5-23 clearUnit does not clear a different unit name',async()=>{
  const {id}=await queued(),other='robot-quant-'+randomUUID()+'.service',stops=[];let launches=0;
  const w=worker({stopUnit:async name=>{stops.push(name);return false;},supervisor:async options=>{
   launches++;
   const before=await binding(id);
   assert.equal(before.unit_name,options.unitName);assert.equal(before.unit_token,(await row(id)).lease_token);
   await h.db.query('UPDATE quant_preflight_jobs SET unit_name=$2 WHERE job_id=$1',[id,other]);
   return replay(options);
  }});
  await bounded(w.tick(),'foreign unit tick');
  const saved=await row(id),bound=await binding(id);
  assert.equal(launches,1,'no chunk follows a refused clear');
  assert.equal(saved.status,'STOPPING');assert.equal(saved.diagnostic,'PF2_RUNNER_FAILED');
  assert.equal(saved.result,null);assert.equal(saved.next_bar,0);assert.equal(saved.checkpoint,null);
  assert.equal(bound.unit_name,other,'the unit stays persisted');assert.equal(bound.unit_token,saved.lease_token);
  assert.deepEqual(stops,[other],'reconciliation still sees the unit that clearUnit refused to clear');
 });

 test('R5-19 a persisted PREFLIGHT unit that systemd never loaded counts as stopped through offline recovery',async()=>{
  const {id}=await queued();
  const w=worker({supervisor:async()=>{
   throw Object.assign(new Error('launcher failed before systemd loaded the unit'),{code:'QUANT_PYTHON_UNAVAILABLE'});
  }});
  await bounded(w.tick(),'pre-spawn failure tick');
  const stuck=await row(id),persisted=(await binding(id)).unit_name;
  assert.equal(stuck.status,'STOPPING');assert.equal(stuck.diagnostic,'QUANT_PROCESS_STOP_UNCONFIRMED');
  assert.match(persisted,/^robot-quant-[a-z0-9-]+[.]service$/);
  // A cold worker has no in-memory stop proof, even if the unit manager reports the unit as gone.
  const cold=worker({stopUnit:async()=>true});await cold.reconcile();
  assert.equal((await row(id)).status,'STOPPING');assert.equal((await binding(id)).unit_name,persisted);
  const workerUnit='robot-quant-research-staging.service',calls=[];
  const notLoaded=()=>({LoadState:'not-found',ActiveState:'inactive',SubState:'dead',ControlGroup:''});
  const states=new Map([[workerUnit,{LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}]]);
  // systemctl refuses kill and stop for a unit it never loaded, so recovery must not issue them.
  const refused=()=>{throw Object.assign(new Error('RECOVERY_COMMAND_FAILED'),{code:'RECOVERY_COMMAND_FAILED'});};
  const manager={show:async name=>structuredClone(states.get(name)??notLoaded()),jobs:async()=>'',
   kill:async name=>{calls.push('kill '+name);refused();},stop:async name=>{calls.push('stop '+name);refused();},
   mask:async name=>{calls.push('mask '+name);states.set(name,{...notLoaded(),LoadState:'masked'});}};
  const result=await recoverQuantFoundation({db:h.db,policy:{workerUnit},manager,inventory:async()=>{},settleMs:0});
  assert.deepEqual(result.recovered,[{job_id:id,status:'CANCELLED'}]);
  assert.deepEqual(result.maskedUnits,[persisted]);assert.deepEqual(calls,['mask '+persisted]);
  const recovered=await row(id),bound=await binding(id);
  assert.equal(bound.unit_name,null);assert.equal(bound.unit_token,null);
  assert.deepEqual([recovered.status,recovered.lease_token,recovered.worker_id,recovered.stop_reason],['CANCELLED',null,null,null]);
  // No result, checkpoint, retry or I/O record is made up: the failure diagnostic of the run is all that remains.
  assert.equal(recovered.result,null);assert.equal(recovered.checkpoint,null);assert.equal(recovered.next_bar,0);
  assert.equal(recovered.attempts,1);assert.equal(recovered.diagnostic,'QUANT_PROCESS_STOP_UNCONFIRMED');
  const ioTables=(await h.db.query("SELECT to_regclass('quant_io_ledgers') IS NOT NULL AND to_regclass('quant_io_launches') IS NOT NULL AS present")).rows[0].present;
  if(ioTables)for(const table of ['quant_io_ledgers','quant_io_launches'])
   assert.equal((await h.db.query('SELECT count(*)::int n FROM '+table+' WHERE job_id=$1',[id])).rows[0].n,0,table);
  // The reconciled slot is free: the next queued job claims at once.
  const next=await queued(),claimed=await worker().claim();
  assert.equal(claimed.kind,'PREFLIGHT');assert.equal(claimed.foundation.job_id,next.id);
 });
});

describe('W3-4 a V2 PROFILE row recovered offline as PAUSED',()=>{
 let admin,db,name;
 const baseSchemas=['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'];
 before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='pf2_w34_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  await db.migrate();
  for(const file of [...baseSchemas,'quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
   await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
 });
 after(async()=>{await db?.close();if(admin){if(name)await admin.query('DROP DATABASE IF EXISTS '+name);await admin.close();}});
 const jobRow=async id=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];

 test('W3-4 the next claim cancels it (PROFILE_ATTEMPT_EXHAUSTED) and the runtime never relaunches it',async()=>{
  const ioNow=4102444800000,workerUnit='robot-quant-research-staging.service';
  const {policy:capacityPolicy,contract}=profileV2Fixture(2000);
  const launcher=new QuantFoundationScheduler({db,capacityPolicy,profileV2Enabled:true,clock:()=>ioNow,leaseMs:30000,
   authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  const queued=await launcher.enqueue('owner-a',contract,randomUUID());
  const claimed=await launcher.claim('w34-first-launch');
  assert.equal(claimed.job_id,queued.job_id);assert.equal(claimed.attempts,1);
  // The launcher died mid-run: its lease expired and the row waits in STOPPING for offline recovery.
  await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,run_started_at=NULL WHERE job_id=$1",[claimed.job_id]);
  const manager={show:async unit=>({LoadState:unit===workerUnit?'masked':'not-found',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''};
  const recovered=await recoverQuantFoundation({db,policy:{workerUnit},manager,inventory:async()=>{},settleMs:0});
  assert.deepEqual(recovered,{recovered:[{job_id:claimed.job_id,status:'PAUSED'}],maskedUnits:[]});
  const paused=await jobRow(claimed.job_id);
  assert.deepEqual([paused.status,paused.attempts,paused.lease_token,paused.diagnostic],['PAUSED',1,null,null]);
  // The product worker, with a runtime and an authority that would accept the job, claims next.
  const authorizations=[],launches=[];
  const w=new QuantResearchFoundationWorker({service:{db,foundation:true,executorMode:async()=>{}},
   health:async()=>({ok:true}),clock:()=>ioNow,capacityPolicy,profileV2Enabled:true,
   profileService:{authorize:async(owner,request,action)=>{authorizations.push(action);return {ok:true};}},
   profileRuntimeV2:{run:async()=>{launches.push('run');throw Error('a recovered V2 PROFILE row must never relaunch');}}});
  assert.equal(await w.tick(),false,'nothing is claimed');
  const cancelled=await jobRow(claimed.job_id);
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.diagnostic,'PROFILE_ATTEMPT_EXHAUSTED');
  assert.equal(cancelled.attempts,1,'no second attempt starts');
  assert.equal(cancelled.lease_token,null);assert.equal(cancelled.result,null);
  assert.deepEqual(authorizations,[],'the row is cancelled before the claim is even authorized');
  assert.deepEqual(launches,[]);assert.equal(w.activeLaunches.size,0);
  // Idempotent: a later claim finds nothing and changes nothing.
  assert.equal(await w.tick(),false);
  assert.deepEqual(await jobRow(claimed.job_id),cancelled);
 });
});

describe('S3b-9 research V2 foundation checkpoint',()=>{
 const M=60000;
 test('S3b-9 a research V2 worker run never writes the foundation checkpoint of its row',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const f=await quantResearchHttpFixture(process.env.TEST_DATABASE_URL);t.after(()=>f.close());
  const start=Math.floor(Date.now()/M)*M-20000*M;
  await f.seedBars({start,count:3250});
  const owner=await f.newOwner(),session=await owner.login();
  const budget=new StorageBudget({root:f.root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const datasetStore=new ResearchDatasetStore({root:f.root,storageBudget:budget});
  const now=Date.now();
  const service=new QuantResearchService({pineService:new PineBridgeService(f.store,{defaultRisk:config.defaultRisk}),
   clock:()=>now,supportedSourceHash:hash(source),foundation:true,datasetStore});
  const answer=await f.enqueue(owner,session,f.researchBody(owner,{start}));
  assert.equal(answer.status,202,JSON.stringify(answer.body));
  const runId=answer.body.run_id;
  const foundation=async()=>(await f.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[runId])).rows[0];
  const queuedRow=await foundation();
  assert.equal(queuedRow.contract.version,RESEARCH_V2_VERSIONS.request,'the row is a research V2 foundation row');
  assert.equal(queuedRow.checkpoint,null);assert.equal(queuedRow.next_bar,0);
  // The evaluator runs once per chunk. Each call records the foundation row as it stands mid-run.
  const seen=[];
  async function evaluate(payload){
   const saved=await foundation();
   seen.push({status:saved.status,checkpoint:saved.checkpoint,next_bar:saved.next_bar});
   const next=(payload.checkpoint?.next_bar??0)+payload.rows.length;
   const end=payload.contract.split.validation_end;
   const metric={closed_trades:0,net_return_percent:'0',max_drawdown_percent:'0'};
   return {checkpoint:{version:'research-chunk-v1',identity:hash(canonical({contract:payload.contract,parameters:payload.parameters,kind:payload.kind})),
    integrity:'a'.repeat(64),next_bar:next,last_time:payload.rows.at(-1).time,paper:{cash:'1000'},evaluator:{index:next-1}},
    result:next===end?{parameters:payload.parameters,kind:payload.kind,train:metric,validation:metric}:null};
  }
  const w=new QuantResearchFoundationWorker({service,clock:()=>now,leaseMs:1500,health:async()=>({ok:true}),
   evaluateChunk:evaluate,stopUnit:async()=>true});
  const writes=[],checkpoint=w.scheduler.checkpoint.bind(w.scheduler);
  w.scheduler.checkpoint=async(...args)=>{writes.push(args);return checkpoint(...args);};
  assert.equal(await w.tick(),true);
  const done=await foundation();
  assert.equal(done.status,'SUCCEEDED');
  assert.equal(done.checkpoint,null);assert.equal(done.next_bar,0);
  assert.ok(seen.length>1,'the run needed several chunks');
  for(const item of seen)assert.deepEqual(item,{status:'RUNNING',checkpoint:null,next_bar:0});
  assert.deepEqual(writes,[],'the scheduler checkpoint is never used for a research row');
  // The run did checkpoint, in its own chunk table, so the null is not an artifact of missing progress.
  const chunks=(await f.db.query("SELECT next_bar,checkpoint FROM quant_research_chunks WHERE run_id=$1 AND kind='CANDIDATE'",[runId])).rows;
  assert.ok(chunks.length>0);for(const chunk of chunks){assert.ok(chunk.next_bar>0);assert.notEqual(chunk.checkpoint,null);}
 });
});
