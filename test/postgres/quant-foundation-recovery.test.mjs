import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {assertQuantWorkerUnit,recoverQuantFoundation,withQuantOfflineGuard} from '../../src/postgres/quant-foundation-recovery.js';

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
