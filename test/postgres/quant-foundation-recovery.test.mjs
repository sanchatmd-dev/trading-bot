import test,{describe,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantIoRuntime,canReleaseQuantIo,QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,quantIoUnitName} from '../../src/postgres/quant-io-runtime.js';
import {assertQuantWorkerUnit,recoverQuantFoundation,withQuantOfflineGuard} from '../../src/postgres/quant-foundation-recovery.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

const workerUnit='robot-quant-research-staging.service';
const policy={workerUnit};
function fixture({unit=true,reason='LEASE_EXPIRED',deadline=Date.now()+60000,lock=true}={}){
 const id=randomUUID(),token=randomUUID(),digest='a'.repeat(64);
 const contract={version:'quant-foundation-v1',dataset:{dataset_id:digest,sha256:digest,metadata:{total_bars:2000}},
  engine_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64),budget:{max_state_bytes:1024,max_runtime_ms:900000}};
 const research={execution_backend:'quant-foundation-v1'};
 const payload={next_bar:1250,state:{cash:'1000'},dataset_id:digest,dataset_sha256:digest,
  engine_hash:contract.engine_hash,snapshot_hash:contract.snapshot_hash};
 const checkpoint={...payload,sha256:hash(canonical(payload))};
 const transient=`robot-quant-${id}-${token}.service`;
 const row={job_id:id,run_id:id,lease_token:token,status:'STOPPING',stop_reason:reason,
  attempts:1,deadline_at:deadline,contract,contract_hash:hash(canonical(contract)),
  research_contract:research,research_contract_hash:hash(canonical(research)),research_job_hash:hash(canonical(research)),
  checkpoint,next_bar:1250,runtime_used_ms:0,run_started_at:null};
 const units=new Map([[workerUnit,{LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}]]);
 if(unit)units.set(transient,{LoadState:'loaded',ActiveState:'active',Job:'0',ControlGroup:''});
 let locks=0,quantUpdates=0,inventoryCalls=0;
 const chunks=unit?[{unit_name:transient,unit_token:token,identity_hash:hash(canonical({contract:research,parameters:{},kind:'CANDIDATE'})),parameters:{},kind:'CANDIDATE',checkpoint:null,next_bar:0}]:[];
 const query=async(sql,params=[])=>{
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{ok:lock}]};
  if(sql.includes('pg_advisory_unlock')||sql==='SELECT 1'||['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[{}]};
  if(sql.includes('LEFT JOIN quant_research_foundation'))return {rows:[structuredClone(row)]};
  if(sql.startsWith('SELECT * FROM quant_research_chunks'))return {rows:structuredClone(chunks)};
  if(sql.includes('quant_foundation_scheduler FOR UPDATE')){locks++;return {rows:[{}]};}
  if(sql.startsWith('UPDATE quant_foundation_jobs')){assert.equal(params[2],row.lease_token);row.status=params[1];row.lease_token=null;return {rowCount:1};}
  if(sql.startsWith('UPDATE quant_research_chunks')){let count=0;for(const chunk of chunks){if(chunk.unit_token===params[1]&&chunk.unit_name){chunk.unit_name=null;chunk.unit_token=null;count++;}}return {rowCount:count};}
  if(sql.startsWith('UPDATE quant_jobs')){quantUpdates++;return {rowCount:1};}
  throw Error('Unexpected SQL: '+sql);
 };
 const client=new EventEmitter();client.release=()=>{};client.query=query;
 const db={pool:{connect:async()=>client}};
 const manager={
  async show(name){return structuredClone(units.get(name)??{LoadState:'not-found',ActiveState:'inactive',Job:'0',ControlGroup:''});},
  async jobs(){return '';},
  async kill(name){units.get(name).ActiveState='inactive';},
  async stop(name){units.get(name).ActiveState='inactive';},
  async mask(name){units.get(name).LoadState='masked';}
 };
 return {db,client,manager,row,chunks,transient,stats:()=>({locks,quantUpdates,inventoryCalls}),inventory:async()=>{inventoryCalls++;}};
}

test('maintenance lock loss during final OS inventory rejects before mutation',async()=>{
 const f=fixture();let inventoryCalls=0,mutated=false;
 await assert.rejects(withQuantOfflineGuard({db:f.db,policy,manager:f.manager,settleMs:0,
  inventory:async()=>{if(++inventoryCalls===3)f.client.emit('error',Error('connection lost'));}},
  async({assertExclusive})=>{await assertExclusive();mutated=true;}),
  {code:'RECOVERY_MAINTENANCE_LOCK_LOST'});
 assert.equal(mutated,false);
 assert.equal(f.row.status,'STOPPING');assert.equal(f.stats().locks,0);
});

test('recovery clears only old token unit evidence before a second crash',async()=>{
 const f=fixture();const oldToken=f.row.lease_token;
 await recoverQuantFoundation({db:f.db,policy,manager:f.manager,inventory:f.inventory,settleMs:0});
 assert.equal(f.chunks[0].unit_name,null);assert.equal(f.chunks[0].unit_token,null);
 assert.equal(f.row.status,'PAUSED');assert.notEqual(f.row.lease_token,oldToken);
 f.row.status='STOPPING';f.row.lease_token=randomUUID();f.row.stop_reason='LEASE_EXPIRED';f.row.attempts=2;
 const again=await recoverQuantFoundation({db:f.db,policy,manager:f.manager,inventory:f.inventory,settleMs:0});
 assert.deepEqual(again.maskedUnits,[]);assert.equal(again.recovered[0].status,'PAUSED');
});

test('offline recovery fences old token and retains immutable checkpoint and original deadline',async()=>{
 const f=fixture(),before=structuredClone(f.row.checkpoint),deadline=f.row.deadline_at;
 const result=await recoverQuantFoundation({db:f.db,policy,manager:f.manager,inventory:f.inventory,settleMs:0});
 assert.deepEqual(result.recovered,[{job_id:f.row.job_id,status:'PAUSED'}]);
 assert.deepEqual(result.maskedUnits,[f.transient]);
 assert.equal((await f.manager.show(f.transient)).LoadState,'masked');
 assert.deepEqual(f.row.checkpoint,before);assert.equal(f.row.deadline_at,deadline);
 assert.equal(f.stats().locks,1);assert.equal(f.stats().quantUpdates,1);
 assert.ok(f.stats().inventoryCalls>=3);
});

test('cold STOPPING with no registered unit recovers only under exclusive maintenance and masked launcher',async()=>{
 const f=fixture({unit:false});
 const result=await recoverQuantFoundation({db:f.db,policy,manager:f.manager,inventory:f.inventory,settleMs:0});
 assert.equal(result.recovered[0].status,'PAUSED');assert.deepEqual(result.maskedUnits,[]);
 const blocked=fixture({unit:false,lock:false});
 await assert.rejects(recoverQuantFoundation({db:blocked.db,policy,manager:blocked.manager,inventory:blocked.inventory}),{code:'RECOVERY_RUNTIME_ACTIVE'});
 assert.equal(blocked.row.status,'STOPPING');
});

test('unmasked launcher or pending start keeps STOPPING',async()=>{
 const unmasked=fixture();unmasked.manager.show=async name=>({...(name===workerUnit?{LoadState:'loaded',ActiveState:'inactive',Job:'0',ControlGroup:''}:{LoadState:'not-found',ActiveState:'inactive',Job:'0',ControlGroup:''})});
 await assert.rejects(recoverQuantFoundation({db:unmasked.db,policy,manager:unmasked.manager,inventory:unmasked.inventory}),{code:'RECOVERY_UNIT_NOT_MASKED'});
 assert.equal(unmasked.row.status,'STOPPING');
 const pending=fixture();pending.manager.jobs=async()=>`1 ${pending.transient} start running`;
 await assert.rejects(recoverQuantFoundation({db:pending.db,policy,manager:pending.manager,inventory:pending.inventory}),{code:'RECOVERY_PENDING_START'});
 assert.equal(pending.row.status,'STOPPING');
});

test('changed binding and deadline expiry fail closed or terminate without checkpoint overwrite',async()=>{
 const changed=fixture();changed.row.research_job_hash='0'.repeat(64);
 await assert.rejects(recoverQuantFoundation({db:changed.db,policy,manager:changed.manager,inventory:changed.inventory}),{code:'RECOVERY_BINDING_UNVERIFIED'});
 assert.equal(changed.row.status,'STOPPING');
 const expired=fixture({deadline:Date.now()-1});
 const result=await recoverQuantFoundation({db:expired.db,policy,manager:expired.manager,inventory:expired.inventory,settleMs:0});
 assert.equal(result.recovered[0].status,'CANCELLED');assert.equal(expired.stats().quantUpdates,1);
});

test('worker startup requires reviewed unit identity, main PID, cgroup and control-group kill mode',async()=>{
 const manager={show:async()=>({LoadState:'loaded',ActiveState:'active',KillMode:'control-group',MainPID:String(process.pid),ControlGroup:'/test/worker.service'})};
 assert.equal(await assertQuantWorkerUnit(workerUnit,{policy,manager,selfCgroup:'/test/worker.service'}),true);
 await assert.rejects(assertQuantWorkerUnit('different.service',{policy,manager,selfCgroup:'/test/worker.service'}),{code:'QUANT_WORKER_UNIT_MISMATCH'});
 const bad={show:async()=>({...await manager.show(),KillMode:'process'})};
 await assert.rejects(assertQuantWorkerUnit(workerUnit,{policy,manager:bad,selfCgroup:'/test/worker.service'}),{code:'QUANT_WORKER_UNIT_UNVERIFIED'});
});

/** Real PostgreSQL, real QuantIoRuntime and QuantIoLedger. Each crash is reproduced by abandoning the
 * runtime at a chosen point, so the recovery input is the row state the production writers leave behind.
 */
describe('I/O-aware offline recovery of a parent crash mid-terminal',()=>{
 const ioNow=4102444800000,operationId='operation-00001',allowance={read_bytes:30,write_bytes:30};
 const baseSchemas=['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'];
 const resetTables='TRUNCATE quant_io_launches,quant_io_ledgers,quant_research_foundation,quant_foundation_jobs,quant_foundation_owners';
 let admin,db,name,scheduler,ledger,claimed,capacityPolicy,contract;
 const args=(job=claimed)=>({jobId:job.job_id,leaseToken:job.lease_token,operationId});
 const unitOf=(job=claimed)=>quantIoUnitName(job.job_id,operationId);
 const proofOf=(job=claimed)=>hash(canonical({version:'quant-io-recovery-stop-proof-v1',jobId:job.job_id,operationId,
  unitName:unitOf(job),unitMasked:true,cgroupEmpty:true,pendingStartsExcluded:true,launcherInventoryEmpty:true}));
 const jobRow=async(job=claimed)=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[job.job_id])).rows[0];
 const ledgerRow=async(job=claimed)=>(await db.query('SELECT * FROM quant_io_ledgers WHERE job_id=$1',[job.job_id])).rows[0];
 const launchRow=async(job=claimed)=>(await db.query('SELECT * FROM quant_io_launches WHERE job_id=$1',[job.job_id])).rows[0];
 const until=async ready=>{for(let attempt=0;attempt<300&&!ready();attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(ready(),'condition not reached');};
 const evidenceFor=frozen=>({freezer:'frozen',windowMs:2500,
  reads:[{readBytes:frozen.readBytes,writeBytes:frozen.writeBytes},{readBytes:frozen.readBytes,writeBytes:frozen.writeBytes}],
  fileDirty:0,fileWriteback:0,maxBioBytes:1310720,rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}});
 /** `terminal` scripts handle.terminate(): frozen counters, commit hook, then a gate the test may never open. */
 const fixtureLauncher=terminal=>({spawnPrepared({unitName}){
  const group='/user.slice/'+unitName;
  const sample={unitName,group,cgroupInode:23,deviceId:'8:0',deviceInode:17,pid:4242,procStartTicks:'12345',
   invocationId:'1'.repeat(32),readBytes:3,writeBytes:4};
  const handle={payloadHash:QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,
   ready:Promise.resolve({unitName,group,cgroupInode:23,invocationId:'1'.repeat(32)}),
   async sample(){return sample;},release(){},
   async stop(){return {unitName,launcherClosed:true,startRegistered:true,pendingStartsExcluded:true,unitStopped:true};}};
  if(terminal)handle.terminate=async request=>{
   const frozen={...sample,readBytes:terminal.read??7,writeBytes:terminal.write??9};
   await request.commit(frozen,evidenceFor(frozen));
   terminal.committed=true;
   await terminal.gate;
   return Object.freeze({stopProof:await handle.stop(),measured:true,postExit:'REMOVED',frozenSample:frozen,
    readbackEvidence:evidenceFor(frozen)});
  };
  return handle;
 }});
 const runtimeFor=terminal=>new QuantIoRuntime({db,ledger,scheduler,launcher:fixtureLauncher(terminal),clock:()=>ioNow});
 const reserved=async(job=claimed,terminal=null)=>{
  const active=runtimeFor(terminal);
  await active.reserve({...args(job),expectedRevision:0,allowance});
  return active;
 };
 const armed=async(job=claimed,terminal=null)=>{
  const active=await reserved(job,terminal);
  await active.start(args(job));await active.ready(args(job));
  await active.bind(args(job));await active.release(args(job));
  return active;
 };
 /** Parent-crash points. Each leaves the durable rows a killed process would leave. */
 const stages={
  INTENT_RECORDED:async job=>{await reserved(job);},
  STARTING:async job=>{await reserved(job);await db.query("UPDATE quant_io_launches SET state='STARTING' WHERE job_id=$1",[job.job_id]);},
  SPAWNED:async job=>{const active=await reserved(job);await active.start(args(job));},
  SPAWNED_BOUND:async job=>{const active=await reserved(job);await active.start(args(job));await active.ready(args(job));await active.bind(args(job));},
  RELEASED:async job=>{await armed(job);},
  // Frozen sample committed, terminal then held forever: the process "dies" before stop or settle.
  FROZEN:async(job,options={})=>{
   const terminal={gate:new Promise(()=>{}),...options};
   const active=await armed(job,terminal);
   active.cancel({ownerId:'owner-a',...args(job)}).catch(()=>{});
   await until(()=>terminal.committed===true);
  }
 };
 const crash=async(stage,job=claimed,options)=>{
  await stages[stage](job,options);
  if(stage!=='FROZEN')await scheduler.cancel('owner-a',job.job_id);
  assert.equal((await jobRow(job)).status,'STOPPING');
 };
 // `groups` gives an alive unit a control group (kept after stop) and `cgroupRoot` points the cgroup proof at a fake tree.
 // `maskedAlive` units are masked but still active, as a partial earlier run leaves them.
 function fakeManager({alive=[],failKill=null,stubborn=null,ignoreMask=null,pending=null,maskedAlive=[],groups={},cgroupRoot}={}){
  const units=new Map([[workerUnit,{LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}]]);
  for(const unit of alive)units.set(unit,{LoadState:'loaded',ActiveState:'active',Job:'0',ControlGroup:groups[unit]??''});
  for(const unit of maskedAlive)units.set(unit,{LoadState:'masked',ActiveState:'active',Job:'0',ControlGroup:''});
  const calls=[];
  const state=unit=>units.get(unit)??{LoadState:'not-found',ActiveState:'inactive',Job:'0',ControlGroup:''};
  const deactivate=unit=>{if(units.has(unit)&&unit!==stubborn)units.get(unit).ActiveState='inactive';};
  return {calls,cgroupRoot,
   async show(unit){return structuredClone(state(unit));},
   async jobs(){return pending?'7 '+pending+' start running':'';},
   async kill(unit){calls.push('kill '+unit);
    if(unit===failKill)throw Object.assign(Error('RECOVERY_COMMAND_FAILED'),{code:'RECOVERY_COMMAND_FAILED'});deactivate(unit);},
   async stop(unit){calls.push('stop '+unit);deactivate(unit);},
   async mask(unit){calls.push('mask '+unit);if(unit!==ignoreMask)units.set(unit,{...state(unit),LoadState:'masked'});}};
 }
 const recover=(manager,extra={})=>recoverQuantFoundation({db,policy,manager,inventory:async()=>{},settleMs:0,...extra});
 const blockedError=async(promise,code)=>{
  let caught;
  await promise.then(()=>assert.fail('recovery must report the blocked row'),failure=>{caught=failure;});
  assert.equal(caught.code,code);
  return caught;
 };

 before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_recovery_io_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  await db.migrate();
  for(const file of [...baseSchemas,'quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
   await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
 });
 beforeEach(async()=>{
  await db.query(resetTables);
  ({policy:capacityPolicy,contract}=profileV2Fixture(2000));
  scheduler=new QuantFoundationScheduler({db,capacityPolicy,clock:()=>ioNow,leaseMs:30000,
   authorize:async()=>({ok:true}),health:async()=>({ok:true}),canRelease:row=>canReleaseQuantIo(db,row)});
  const queued=await scheduler.enqueue('owner-a',contract,randomUUID());
  claimed=await scheduler.claim('io-recovery-test');assert.equal(claimed.job_id,queued.job_id);
  ledger=new QuantIoLedger({db,policy:capacityPolicy,devices:[{device_id:'8:0',device_inode:17}],
   authorizeTerminal:async()=>({ok:true}),clock:()=>ioNow});
 });
 after(async()=>{
  await db?.close();
  if(admin){if(name)await admin.query('DROP DATABASE IF EXISTS '+name);await admin.close();}
 });

 const points=[
  ['INTENT_RECORDED',false,'INTENT_RECORDED','RESERVED'],['STARTING',true,'STARTING','RESERVED'],
  ['SPAWNED',true,'SPAWNED','RESERVED'],['SPAWNED_BOUND',true,'SPAWNED','ACTIVE'],
  ['RELEASED',true,'RELEASED','ACTIVE'],['FROZEN',true,'RELEASED','ACTIVE']];
 for(const [stage,alive,launchState,operationBefore] of points)
  test('crash at '+stage+' charges unknown-final once, proves stop and cancels the job',async()=>{
   await crash(stage);
   const job=claimed,unit=unitOf(job),before=await ledgerRow(job);
   assert.equal((await launchRow(job)).state,launchState);
   assert.equal(before.state.operations[0].status,operationBefore);
   assert.deepEqual(before.state.charged,{read_bytes:0,write_bytes:0});
   // The wedge: the release trigger blocks a plain release and STOPPING keeps the global slot.
   await assert.rejects(db.query(`UPDATE quant_foundation_jobs SET status='CANCELLED',stop_reason=NULL,worker_id=NULL,
    lease_token=NULL,lease_until=NULL WHERE job_id=$1`,[job.job_id]),/Foundation I\/O launch unresolved/);
   assert.equal(await scheduler.claim('wedged'),null);
   const manager=fakeManager({alive:alive?[unit]:[]});
   const result=await recover(manager);
   assert.deepEqual(result,{recovered:[{job_id:job.job_id,status:'CANCELLED',
    io:[{operation_id:operationId,proof:'UNKNOWN_FINAL_CHARGED'}]}],maskedUnits:[unit]});
   assert.deepEqual(manager.calls,alive?['kill '+unit,'stop '+unit,'mask '+unit]:['mask '+unit]);
   const after=await ledgerRow(job),operation=after.state.operations[0];
   assert.equal(operation.status,'CRASHED');
   assert.deepEqual(operation.charge,{read_bytes:30,write_bytes:30});
   assert.deepEqual(after.state.charged,{read_bytes:30,write_bytes:30});
   assert.equal(operation.terminal_proof.crash_evidence_sha256,proofOf(job));
   assert.equal(operation.stop_confirmation,proofOf(job));
   assert.equal(after.revision,before.revision+2);assert.equal(after.state_hash,hash(canonical(after.state)));
   assert.equal((await launchRow(job)).state,'STOP_PROVEN');
   const stored=await jobRow(job);
   assert.deepEqual([stored.status,stored.lease_token,stored.stop_reason,stored.worker_id,stored.result],['CANCELLED',null,null,null,null]);
   // Idempotent: nothing left to recover and no second charge.
   assert.deepEqual(await recover(fakeManager()),{recovered:[],maskedUnits:[]});
   assert.equal((await ledgerRow(job)).revision,after.revision);
   // The slot is free again.
   await scheduler.enqueue('owner-a',contract,randomUUID());
   assert.equal((await scheduler.claim('after-recovery')).status,'RUNNING');
  });

 test('frozen sample above the allowance is charged as observed, not as the allowance',async()=>{
  await crash('FROZEN',claimed,{read:40,write:9});
  const before=await ledgerRow();
  assert.equal(before.state.operations[0].status,'STOP_REQUIRED');
  assert.equal(before.state.operations[0].last.devices[0].read_bytes,40);
  await recover(fakeManager({alive:[unitOf()]}));
  const after=await ledgerRow();
  assert.deepEqual(after.state.operations[0].charge,{read_bytes:40,write_bytes:30});
  assert.deepEqual(after.state.charged,{read_bytes:40,write_bytes:30});
  assert.equal(after.state.operations[0].last.devices[0].read_bytes,40);
 });

 test('parent crash while the job is still RUNNING stops the unit, charges once and cancels',async()=>{
  await armed();
  assert.equal((await jobRow()).status,'RUNNING');
  const result=await recover(fakeManager({alive:[unitOf()]}));
  assert.equal(result.recovered[0].status,'CANCELLED');
  const after=await ledgerRow();
  assert.equal(after.state.operations[0].status,'CRASHED');
  assert.deepEqual(after.state.charged,{read_bytes:30,write_bytes:30});
  const stored=await jobRow();
  assert.deepEqual([stored.status,stored.lease_token,stored.lease_until,stored.run_started_at],['CANCELLED',null,null,null]);
 });

 test('crash after the settle commit keeps the measured settlement and only finishes the row',async()=>{
  const active=await armed(claimed,{});
  const original=scheduler.acknowledgeStopped;
  scheduler.acknowledgeStopped=async()=>{throw Error('parent crashed before acknowledgement');};
  try{await assert.rejects(active.cancel({ownerId:'owner-a',...args()}),/parent crashed/);}
  finally{scheduler.acknowledgeStopped=original;}
  // A relaunch is impossible once an operation exists, so recovery cancels even a lease-expiry stop.
  await db.query("UPDATE quant_foundation_jobs SET stop_reason='LEASE_EXPIRED' WHERE job_id=$1",[claimed.job_id]);
  const before=await ledgerRow();
  assert.equal(before.state.operations[0].status,'SETTLED');
  assert.deepEqual(before.state.charged,{read_bytes:7,write_bytes:9});
  assert.equal((await launchRow()).state,'STOP_PROVEN');assert.equal((await jobRow()).status,'STOPPING');
  const result=await recover(fakeManager());
  assert.deepEqual(result.recovered,[{job_id:claimed.job_id,status:'CANCELLED',
   io:[{operation_id:operationId,proof:'MEASURED_FINAL_SETTLED'}]}]);
  assert.deepEqual(await ledgerRow(),before);
  assert.equal((await launchRow()).state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
 });

 async function settledWithOpenLaunch(){
  await armed();await scheduler.cancel('owner-a',claimed.job_id);
  const state=(await ledgerRow()).state,operation=state.operations[0];
  await ledger.transition({jobId:claimed.job_id,leaseToken:claimed.lease_token,expectedRevision:state.revision,action:'settle',
   input:{operation_id:operationId,lease_token:claimed.lease_token,cgroup_id:operation.cgroup_id,cgroup_inode:operation.cgroup_inode,
    stopped:true,stop_proof_sha256:'a'.repeat(64),final_readback:true,readback_proof_sha256:'b'.repeat(64),
    sample:{devices:[{device_id:'8:0',device_inode:17,read_bytes:7,write_bytes:9}]}}});
 }
 test('settled operation with an unfinished launch row stays settled and only closes the launch',async()=>{
  await settledWithOpenLaunch();
  const before=await ledgerRow();
  assert.equal(before.state.operations[0].status,'SETTLED');assert.equal((await launchRow()).state,'RELEASED');
  const manager=fakeManager({alive:[unitOf()]});
  const result=await recover(manager);
  // The ledger stays SETTLED and is not charged again, but the live unit is reported: I/O after settlement is unaccounted.
  assert.equal(result.recovered[0].io[0].proof,'MEASURED_FINAL_SETTLED_UNIT_WAS_LIVE');
  assert.deepEqual(manager.calls,['kill '+unitOf(),'stop '+unitOf(),'mask '+unitOf()]);
  assert.deepEqual(await ledgerRow(),before);
  assert.equal((await launchRow()).state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
 });

 test('settled operation whose unit was already gone keeps the plain measured label',async()=>{
  await settledWithOpenLaunch();
  const before=await ledgerRow(),manager=fakeManager();
  const result=await recover(manager);
  assert.equal(result.recovered[0].io[0].proof,'MEASURED_FINAL_SETTLED');
  assert.deepEqual(manager.calls,['mask '+unitOf()]);
  assert.deepEqual(await ledgerRow(),before);assert.equal((await launchRow()).state,'STOP_PROVEN');
 });

 async function crashCharged(acknowledge){
  await armed();await scheduler.cancel('owner-a',claimed.job_id);
  const operation=(await ledgerRow()).state.operations[0],base={operation_id:operationId,lease_token:claimed.lease_token,
   cgroup_id:operation.cgroup_id,cgroup_inode:operation.cgroup_inode};
  const step=async(action,input)=>ledger.transition({jobId:claimed.job_id,leaseToken:claimed.lease_token,
   expectedRevision:(await ledgerRow()).revision,action,input:{...base,...input}});
  await step('crash',{crash_evidence_sha256:'c'.repeat(64)});
  if(acknowledge)await step('acknowledgeCrashStop',{stop_proof_sha256:'d'.repeat(64)});
 }
 test('operation already crash-charged but unacknowledged is only acknowledged, never charged twice',async()=>{
  await crashCharged(false);
  const before=await ledgerRow();
  assert.equal(before.state.operations[0].status,'CRASHED_UNCONFIRMED');
  assert.deepEqual(before.state.charged,{read_bytes:30,write_bytes:30});
  const result=await recover(fakeManager({alive:[unitOf()]}));
  assert.equal(result.recovered[0].io[0].proof,'UNKNOWN_FINAL_CHARGED');
  const after=await ledgerRow(),operation=after.state.operations[0];
  assert.equal(operation.status,'CRASHED');
  assert.equal(operation.terminal_proof.crash_evidence_sha256,'c'.repeat(64));
  assert.equal(operation.stop_confirmation,proofOf());
  assert.deepEqual(after.state.charged,{read_bytes:30,write_bytes:30});
  assert.equal(after.revision,before.revision+1);
  assert.equal((await launchRow()).state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
 });

 test('operation already crash-stopped by the runtime only closes the launch',async()=>{
  await crashCharged(true);
  const before=await ledgerRow();
  assert.equal(before.state.operations[0].status,'CRASHED');assert.equal((await launchRow()).state,'RELEASED');
  await recover(fakeManager({alive:[unitOf()]}));
  assert.deepEqual(await ledgerRow(),before);
  assert.equal((await launchRow()).state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
 });

 const refusals=[
  ['kill command fails',unit=>({alive:[unit],failKill:unit}),'RECOVERY_COMMAND_FAILED',['kill']],
  ['unit stays active after kill and stop',unit=>({alive:[unit],stubborn:unit}),'RECOVERY_UNIT_ACTIVE',['kill','stop','mask']],
  ['mask does not take effect',unit=>({alive:[unit],ignoreMask:unit}),'RECOVERY_UNIT_NOT_MASKED',['kill','stop','mask']],
  ['start job still pending for the unit',unit=>({alive:[unit],pending:unit}),'RECOVERY_PENDING_START',[]]];
 for(const [label,options,code,acted] of refusals)
  test('manager refusal ('+label+') blocks exactly that row and leaves it untouched',async()=>{
   await crash('RELEASED');
   const unit=unitOf(),before=await ledgerRow(),manager=fakeManager(options(unit));
   const failure=await blockedError(recover(manager),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:claimed.job_id,operation_id:operationId,code}]);
   assert.deepEqual(failure.recovered,[]);
   assert.deepEqual(manager.calls,acted.map(action=>action+' '+unit));
   assert.deepEqual(await ledgerRow(),before);
   assert.equal((await launchRow()).state,'RELEASED');assert.equal((await jobRow()).status,'STOPPING');
   // The operator fixes the manager and repeats: the same row now recovers, charged once.
   const result=await recover(fakeManager({alive:[unit]}));
   assert.equal(result.recovered[0].status,'CANCELLED');
   assert.deepEqual((await ledgerRow()).state.charged,{read_bytes:30,write_bytes:30});
  });

 test('a launcher or worker still running aborts the whole command before any mutation',async()=>{
  await crash('RELEASED');
  const before=await ledgerRow(),manager=fakeManager({alive:[unitOf()]});
  await assert.rejects(recover(manager,{inventory:async()=>{throw Object.assign(Error('RECOVERY_LAUNCHER_STILL_RUNNING'),
   {code:'RECOVERY_LAUNCHER_STILL_RUNNING'});}}),{code:'RECOVERY_LAUNCHER_STILL_RUNNING'});
  assert.deepEqual(manager.calls,[]);assert.deepEqual(await ledgerRow(),before);
  assert.equal((await launchRow()).state,'RELEASED');assert.equal((await jobRow()).status,'STOPPING');
 });

 test('tampered ledger evidence blocks the row before any unit action or write',async()=>{
  await crash('RELEASED');
  await db.query(`UPDATE quant_io_ledgers SET revision=revision+1,state=jsonb_set(state,'{revision}',to_jsonb(revision+1)) WHERE job_id=$1`,[claimed.job_id]);
  const before=await ledgerRow(),manager=fakeManager({alive:[unitOf()]});
  const failure=await blockedError(recover(manager),'RECOVERY_IO_ROW_BLOCKED');
  assert.deepEqual(failure.blocked,[{job_id:claimed.job_id,operation_id:null,code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'}]);
  assert.deepEqual(manager.calls,[]);assert.deepEqual(await ledgerRow(),before);
  assert.equal((await launchRow()).state,'RELEASED');assert.equal((await jobRow()).status,'STOPPING');
 });

 /** The scheduler allows one RUNNING/STOPPING job, so multi-row isolation needs the index dropped. */
 async function withTwoRows(callback){
  await db.query('DROP INDEX quant_foundation_one_executor');
  try{
   const queued=await scheduler.enqueue('owner-a',contract,randomUUID());
   const second={job_id:queued.job_id,lease_token:randomUUID()};
   await db.query(`UPDATE quant_foundation_jobs SET status='RUNNING',worker_id='second-worker',attempts=1,lease_token=$2,
    lease_until=$3,run_started_at=$4 WHERE job_id=$1`,[second.job_id,second.lease_token,ioNow+30000,ioNow]);
   await callback(claimed,second);
  }finally{
   await db.query(resetTables);
   await db.query("CREATE UNIQUE INDEX quant_foundation_one_executor ON quant_foundation_jobs ((TRUE)) WHERE status IN ('RUNNING','STOPPING')");
  }
 }

 test('a blocked row does not roll back the other rows',async()=>{
  await withTwoRows(async(first,second)=>{
   await stages.RELEASED(first);await stages.RELEASED(second);
   await scheduler.cancel('owner-a',first.job_id);await scheduler.cancel('owner-a',second.job_id);
   const beforeFirst=await ledgerRow(first),beforeSecond=await ledgerRow(second);
   const manager=fakeManager({alive:[unitOf(first),unitOf(second)],failKill:unitOf(first)});
   const failure=await blockedError(recover(manager),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:first.job_id,operation_id:operationId,code:'RECOVERY_COMMAND_FAILED'}]);
   assert.deepEqual(failure.recovered.map(item=>[item.job_id,item.status]),[[second.job_id,'CANCELLED']]);
   assert.deepEqual(failure.maskedUnits,[unitOf(second)]);
   assert.deepEqual(await ledgerRow(first),beforeFirst);
   assert.equal((await jobRow(first)).status,'STOPPING');assert.equal((await launchRow(first)).state,'RELEASED');
   const done=await ledgerRow(second);
   assert.equal(done.state.operations[0].status,'CRASHED');assert.equal(done.revision,beforeSecond.revision+2);
   assert.equal((await jobRow(second)).status,'CANCELLED');assert.equal((await launchRow(second)).state,'STOP_PROVEN');
  });
 });

 test('a row failing evidence verification is reported while the other row recovers',async()=>{
  await withTwoRows(async(first,second)=>{
   await stages.RELEASED(first);await stages.RELEASED(second);
   await scheduler.cancel('owner-a',first.job_id);await scheduler.cancel('owner-a',second.job_id);
   await db.query(`UPDATE quant_io_ledgers SET revision=revision+1,state=jsonb_set(state,'{revision}',to_jsonb(revision+1)) WHERE job_id=$1`,[first.job_id]);
   const manager=fakeManager({alive:[unitOf(first),unitOf(second)]});
   const failure=await blockedError(recover(manager),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:first.job_id,operation_id:null,code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'}]);
   assert.ok(manager.calls.every(call=>call.endsWith(unitOf(second))),'no action on the unverified row unit');
   assert.equal((await jobRow(first)).status,'STOPPING');assert.equal((await jobRow(second)).status,'CANCELLED');
  });
 });

 test('a PROFILE row without I/O state and an I/O row recover side by side',async()=>{
  await withTwoRows(async(io,plain)=>{
   await stages.RELEASED(io);await scheduler.cancel('owner-a',io.job_id);
   await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,run_started_at=NULL WHERE job_id=$1",[plain.job_id]);
   const result=await recover(fakeManager({alive:[unitOf(io)]}));
   assert.deepEqual(result.recovered.find(item=>item.job_id===plain.job_id),{job_id:plain.job_id,status:'PAUSED'});
   assert.equal(result.recovered.find(item=>item.job_id===io.job_id).status,'CANCELLED');
   assert.deepEqual(result.maskedUnits,[unitOf(io)]);
  });
 });

 test('launch unit name that does not derive from job and operation blocks the row',async()=>{
  await crash('RELEASED');
  await db.query('ALTER TABLE quant_io_launches DISABLE TRIGGER quant_io_launch_guard');
  try{await db.query('UPDATE quant_io_launches SET unit_name=$2 WHERE job_id=$1',[claimed.job_id,'robot-quant-'+'e'.repeat(64)+'.service']);}
  finally{await db.query('ALTER TABLE quant_io_launches ENABLE TRIGGER quant_io_launch_guard');}
  const manager=fakeManager({alive:[unitOf()]});
  const failure=await blockedError(recover(manager),'RECOVERY_IO_ROW_BLOCKED');
  assert.deepEqual(failure.blocked,[{job_id:claimed.job_id,operation_id:operationId,code:'RECOVERY_IO_STATE_INCONSISTENT'}]);
  assert.deepEqual(manager.calls,[]);assert.equal((await jobRow()).status,'STOPPING');
 });

 /** A writer changes the row after planning and after the unit is retired, before the row transaction begins.
  * The hook fires once, on the first exclusivity check that follows the first mask, and records the row as it then stands.
  */
 function raceAfterMask(manager,mutate,seen,job=claimed){
  const mask=manager.mask;let armed=false,fired=false;
  manager.mask=async unit=>{await mask(unit);armed=true;};
  return async()=>{
   if(!armed||fired)return;
   fired=true;await mutate();
   Object.assign(seen,{ledger:await ledgerRow(job),launch:await launchRow(job),job:await jobRow(job)});
  };
 }
 const rivalCrash=async(job=claimed)=>{
  const state=(await ledgerRow(job)).state,operation=state.operations[0];
  await ledger.transition({jobId:job.job_id,leaseToken:job.lease_token,expectedRevision:state.revision,action:'crash',
   input:{operation_id:operationId,lease_token:job.lease_token,cgroup_id:operation.cgroup_id,cgroup_inode:operation.cgroup_inode,
    crash_evidence_sha256:'c'.repeat(64)}});
 };
 const bumpAttempts=job=>db.query('UPDATE quant_foundation_jobs SET attempts=attempts+1 WHERE job_id=$1',[job.job_id]);
 const races=[
  ['a job row change',()=>bumpAttempts(claimed),2],
  ['a rival crash charge on the ledger',()=>rivalCrash(),1]];
 for(const [label,mutate,revisionsAfterRetry] of races)
  test('row changed by '+label+' after planning is blocked as RECOVERY_STATE_CHANGED with no writes',async()=>{
   await crash('RELEASED');
   const unit=unitOf(),manager=fakeManager({alive:[unit]}),seen={};
   const failure=await blockedError(recover(manager,{inventory:raceAfterMask(manager,mutate,seen)}),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:claimed.job_id,operation_id:null,code:'RECOVERY_STATE_CHANGED'}]);
   assert.deepEqual(failure.recovered,[]);
   assert.ok(seen.ledger,'the race hook must have fired');
   assert.deepEqual(await ledgerRow(),seen.ledger);assert.deepEqual(await launchRow(),seen.launch);assert.deepEqual(await jobRow(),seen.job);
   assert.equal((await launchRow()).state,'RELEASED');assert.equal((await jobRow()).status,'STOPPING');
   // The repeat sees the new state and finishes the row, charging exactly once.
   const result=await recover(fakeManager({alive:[unit]}));
   assert.equal(result.recovered[0].status,'CANCELLED');
   const after=await ledgerRow();
   assert.deepEqual(after.state.charged,{read_bytes:30,write_bytes:30});
   assert.equal(after.state.operations[0].status,'CRASHED');assert.equal(after.revision,seen.ledger.revision+revisionsAfterRetry);
   assert.equal((await launchRow()).state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
  });

 test('a row changed after planning is blocked while the other row recovers',async()=>{
  await withTwoRows(async(first,second)=>{
   await stages.RELEASED(first);await stages.RELEASED(second);
   await scheduler.cancel('owner-a',first.job_id);await scheduler.cancel('owner-a',second.job_id);
   const beforeSecond=await ledgerRow(second),manager=fakeManager({alive:[unitOf(first),unitOf(second)]}),seen={};
   const failure=await blockedError(recover(manager,{inventory:raceAfterMask(manager,()=>bumpAttempts(first),seen,first)}),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:first.job_id,operation_id:null,code:'RECOVERY_STATE_CHANGED'}]);
   assert.deepEqual(failure.recovered.map(item=>[item.job_id,item.status]),[[second.job_id,'CANCELLED']]);
   assert.deepEqual(await ledgerRow(first),seen.ledger);assert.deepEqual(await jobRow(first),seen.job);
   assert.equal((await launchRow(first)).state,'RELEASED');
   assert.equal((await ledgerRow(second)).revision,beforeSecond.revision+2);assert.equal((await jobRow(second)).status,'CANCELLED');
  });
 });

 test('a masked unit that is still active is killed and stopped, not skipped',async()=>{
  await crash('RELEASED');
  const unit=unitOf(),manager=fakeManager({maskedAlive:[unit]});
  const result=await recover(manager);
  assert.equal(result.recovered[0].status,'CANCELLED');
  assert.deepEqual(manager.calls,['kill '+unit,'stop '+unit,'mask '+unit]);
  assert.equal((await launchRow()).state,'STOP_PROVEN');
  assert.deepEqual((await ledgerRow()).state.charged,{read_bytes:30,write_bytes:30});
 });

 test('a blocked row still gets the guard final exclusivity check after the row work',async()=>{
  await crash('RELEASED');
  const unit=unitOf(),manager=fakeManager({alive:[unit],failKill:unit}),kill=manager.kill;
  let rowBlocked=false;
  manager.kill=async name=>{rowBlocked=true;return kill(name);};
  // The launcher reappears only once the row is blocked. After that, only the guard's final check can see it.
  await assert.rejects(recover(manager,{inventory:async()=>{
   if(rowBlocked)throw Object.assign(Error('RECOVERY_LAUNCHER_STILL_RUNNING'),{code:'RECOVERY_LAUNCHER_STILL_RUNNING'});}}),
   {code:'RECOVERY_LAUNCHER_STILL_RUNNING'});
  assert.equal((await jobRow()).status,'STOPPING');
 });

 /** The cgroup proof reads a fake tree through manager.cgroupRoot: cgroup.events of the unit's control group. */
 async function withCgroupTree(events,callback){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quant-cgroup-'));
  try{
   if(events!==null){
    const dir=path.join(root,'user.slice',unitOf());
    await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'cgroup.events'),events);
   }
   await callback(root);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
 const groupManager=(root,group=null,unit=unitOf())=>fakeManager({alive:[unit],groups:{[unit]:group??'/user.slice/'+unit},cgroupRoot:root});

 test('unit cgroup still populated after stop blocks exactly that row until it empties',async()=>{
  await crash('RELEASED');
  const unit=unitOf(),before=await ledgerRow();
  await withCgroupTree('populated 1\nfrozen 0\n',async root=>{
   const manager=groupManager(root);
   const failure=await blockedError(recover(manager),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:claimed.job_id,operation_id:operationId,code:'RECOVERY_CGROUP_POPULATED'}]);
   assert.deepEqual(failure.recovered,[]);
   assert.deepEqual(manager.calls,['kill '+unit,'stop '+unit,'mask '+unit]);
   assert.deepEqual(await ledgerRow(),before);
   assert.equal((await launchRow()).state,'RELEASED');assert.equal((await jobRow()).status,'STOPPING');
   await fs.writeFile(path.join(root,'user.slice',unit,'cgroup.events'),'populated 0\nfrozen 0\n');
   const result=await recover(groupManager(root));
   assert.equal(result.recovered[0].status,'CANCELLED');
   assert.deepEqual((await ledgerRow()).state.charged,{read_bytes:30,write_bytes:30});
  });
 });

 for(const [label,events] of [['events report populated 0','populated 0\nfrozen 0\n'],['cgroup directory is gone',null]])
  test('cgroup proof accepts a unit whose '+label,async()=>{
   await crash('RELEASED');
   await withCgroupTree(events,async root=>{
    const result=await recover(groupManager(root));
    assert.equal(result.recovered[0].status,'CANCELLED');
    assert.equal((await launchRow()).state,'STOP_PROVEN');
   });
  });

 test('control group outside the cgroup tree blocks the row',async()=>{
  await crash('RELEASED');
  const before=await ledgerRow();
  await withCgroupTree(null,async root=>{
   const failure=await blockedError(recover(groupManager(root,'/user.slice/../escape')),'RECOVERY_IO_ROW_BLOCKED');
   assert.deepEqual(failure.blocked,[{job_id:claimed.job_id,operation_id:operationId,code:'RECOVERY_INVALID_CGROUP'}]);
   assert.deepEqual(await ledgerRow(),before);assert.equal((await jobRow()).status,'STOPPING');
  });
 });

 // A failure inside the row transaction must undo the crash charge, the acknowledgement and the launch update.
 const injections=[
  ['launch update',operationId,'quant_io_launches','TRUE'],
  ['job release',null,'quant_foundation_jobs',"NEW.status='CANCELLED'"]];
 for(const [label,blockedOperation,table,condition] of injections)
  test('failure at the '+label+' rolls the whole row back and the retry charges once',async()=>{
   await crash('RELEASED');
   const before=await ledgerRow();
   await db.query(`CREATE FUNCTION injected_row_failure() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
    BEGIN IF `+condition+` THEN RAISE EXCEPTION 'injected row failure'; END IF; RETURN NEW; END $body$`);
   await db.query('CREATE TRIGGER injected_row_failure BEFORE UPDATE ON '+table+' FOR EACH ROW EXECUTE FUNCTION injected_row_failure()');
   try{
    const failure=await blockedError(recover(fakeManager({alive:[unitOf()]})),'RECOVERY_IO_ROW_BLOCKED');
    assert.equal(failure.blocked.length,1);
    assert.deepEqual([failure.blocked[0].job_id,failure.blocked[0].operation_id],[claimed.job_id,blockedOperation]);
    assert.equal(typeof failure.blocked[0].code,'string');
    assert.deepEqual(await ledgerRow(),before);
    assert.equal((await launchRow()).state,'RELEASED');assert.equal((await jobRow()).status,'STOPPING');
   }finally{
    await db.query('DROP TRIGGER injected_row_failure ON '+table);await db.query('DROP FUNCTION injected_row_failure()');
   }
   const result=await recover(fakeManager({alive:[unitOf()]}));
   assert.equal(result.recovered[0].status,'CANCELLED');
   const after=await ledgerRow();
   assert.deepEqual(after.state.charged,{read_bytes:30,write_bytes:30});assert.equal(after.revision,before.revision+2);
  });

 const stopped="UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,run_started_at=NULL WHERE job_id=$1";
 test('PROFILE v2 row without I/O state keeps the plain release path',async()=>{
  await db.query(stopped,[claimed.job_id]);
  const manager=fakeManager();
  assert.deepEqual(await recover(manager),{recovered:[{job_id:claimed.job_id,status:'PAUSED'}],maskedUnits:[]});
  assert.deepEqual(manager.calls,[]);
 });

 test('PROFILE v2 row with an opened but empty ledger keeps the plain release path',async()=>{
  await ledger.open({jobId:claimed.job_id,leaseToken:claimed.lease_token});
  await db.query(stopped,[claimed.job_id]);
  assert.deepEqual(await recover(fakeManager()),{recovered:[{job_id:claimed.job_id,status:'PAUSED'}],maskedUnits:[]});
 });

 test('database without the I/O tables recovers PROFILE v2 rows through the plain path',async()=>{
  const bare='quant_recovery_bare_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+bare);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+bare;
  const bareDb=new PostgresDatabase({connectionString:url.toString(),max:2});
  try{
   await bareDb.migrate();
   for(const file of baseSchemas)
    await bareDb.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
   const bareScheduler=new QuantFoundationScheduler({db:bareDb,capacityPolicy,clock:()=>ioNow,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true})});
   await bareScheduler.enqueue('owner-a',contract,randomUUID());
   const job=await bareScheduler.claim('bare-worker');
   await bareDb.query(stopped,[job.job_id]);
   const result=await recoverQuantFoundation({db:bareDb,policy,manager:fakeManager(),inventory:async()=>{},settleMs:0});
   assert.deepEqual(result,{recovered:[{job_id:job.job_id,status:'PAUSED'}],maskedUnits:[]});
  }finally{await bareDb.close();await admin.query('DROP DATABASE IF EXISTS '+bare);}
 });
});
