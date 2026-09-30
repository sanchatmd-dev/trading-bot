import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {assertProfileV2Configuration,wireQuantProfileV2} from '../src/postgres/quant-profile-wiring.js';
import {QuantResearchFoundationWorker} from '../src/postgres/quant-research-foundation.js';
import {QuantProfileRuntimeV2} from '../src/postgres/quant-profile-runtime-v2.js';
import {QuantIoLedger} from '../src/postgres/quant-io-ledger.js';
import {createIoRuntimeLauncher} from '../src/quant-research/io-runtime-launcher.js';
import {StorageBudget} from '../src/quant-research/storage-budget.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {canonical,hash} from '../src/pine-bridge/source.js';

const environment={QUANT_PROFILE_V2_ENABLED:'1',QUANT_RESEARCH_FOUNDATION_ENABLED:'1',
 QUANT_HEALTH_RECOVERY_FILE:'reviewed-health',QUANT_IO_CONTROLS_FILE:'reviewed-io',
 QUANT_RECOVERY_POLICY_FILE:'reviewed-recovery',QUANT_CAPACITY_POLICY_FILE:'reviewed-capacity'};

test('PROFILE startup requires Linux foundation and every reviewed configuration',()=>{
 assert.equal(assertProfileV2Configuration({environment,platform:'linux'}),true);
 assert.equal(assertProfileV2Configuration({environment:{},platform:'win32'}),false);
 assert.throws(()=>assertProfileV2Configuration({environment,platform:'win32'}),{code:'QUANT_PROFILE_FOUNDATION_REQUIRED'});
 const codes={QUANT_RESEARCH_FOUNDATION_ENABLED:'QUANT_PROFILE_FOUNDATION_REQUIRED',
  QUANT_HEALTH_RECOVERY_FILE:'QUANT_PROFILE_RECOVERY_HEALTH_REQUIRED',QUANT_IO_CONTROLS_FILE:'QUANT_PROFILE_IO_CONTROLS_REQUIRED',
  QUANT_RECOVERY_POLICY_FILE:'QUANT_PROFILE_RECOVERY_POLICY_REQUIRED',QUANT_CAPACITY_POLICY_FILE:'QUANT_CAPACITY_POLICY_REQUIRED'};
 for(const [field,code] of Object.entries(codes)){
  const missing={...environment};delete missing[field];
  assert.throws(()=>assertProfileV2Configuration({environment:missing,platform:'linux'}),{code});
 }
});

function fixture(){
 const {policy}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
 const root=path.join(os.tmpdir(),'wiring-no-files'),calls=[];
 const db={isTransaction:false,transaction:async callback=>{db.isTransaction=true;try{return await callback();}finally{db.isTransaction=false;}},
  query:async(sql,args)=>{calls.push({sql,args});return sql.includes('to_regclass')?{rows:[{present:args[0]}]}:{rows:[{}],rowCount:1};}};
 const storageBudget=new StorageBudget({root,diskQuotaBytes:1000000,tempQuotaBytes:100000,freeFloorBytes:0});
 const healthCalls=[],health=async input=>{healthCalls.push(input.action);return {ok:true};};
 const worker=new QuantResearchFoundationWorker({service:{db,foundation:true,storageBudget},profileV2Enabled:true,capacityPolicy:policy,health});
 const ioControls={version:'quant-io-v1',device:'8:0',devicePath:'/dev/reviewed',main:{readBytesPerSecond:1024,writeBytesPerSecond:1024},evaluator:{readBytesPerSecond:1024,writeBytesPerSecond:1024}};
 let factories=0;
 const options={worker,db,capacityPolicy:policy,recoveryPolicy:{releaseRoot:root},ioControls,health,releaseRoot:root,
  fileSystem:{realpath:async()=>root,stat:async()=>({ino:17,isBlockDevice:()=>true})},
  launcherFactory:input=>{factories++;return createIoRuntimeLauncher({...input,allowUnsupportedPlatformForTests:true});}};
 return {options,worker,db,calls,healthCalls,stats:()=>({factories})};
}

test('enabled startup builds real ledger, launcher and PROFILE runtime without launch',async()=>{
 const f=fixture(),runtime=await wireQuantProfileV2(f.options);
 assert.ok(runtime instanceof QuantProfileRuntimeV2);assert.ok(runtime.ledger instanceof QuantIoLedger);
 assert.equal(runtime,f.worker.profileRuntimeV2);assert.equal(runtime.io.scheduler,f.worker.scheduler);
 assert.equal(runtime.ledger.db,f.db);assert.deepEqual(runtime.ledger.devices,[{device_id:'8:0',device_inode:17}]);
 assert.equal(hash(canonical(runtime.ledger.policy)),hash(canonical(f.options.capacityPolicy)));
 assert.deepEqual(runtime.launcher.terminalConfig,f.options.capacityPolicy.terminal);
 await runtime.io.profile.health({action:'PROFILE_RELEASE'});await runtime.io.profile.health({action:'PROFILE_OBSERVE'});
 assert.deepEqual(f.healthCalls,['CLAIM','HEARTBEAT']);assert.equal(f.stats().factories,1);
 const job={job_id:'job',lease_token:'token'},input={operation_id:'op-token'};
 const authorize=action=>runtime.ledger.authorizeTerminal({job,action,input});
 assert.equal((await authorize('settle')).ok,false);
 f.worker.profileOperations.set('job',{leaseToken:'token',operationId:'op-token'});
 assert.equal((await authorize('settle')).ok,false,'not transaction-local');
 await f.db.transaction(async()=>{
  for(const action of ['settle','crash','acknowledgeCrashStop'])assert.equal((await authorize(action)).ok,true);
  assert.equal((await authorize('constructor')).ok,false);
  f.worker.profileOperations.set('job',{leaseToken:'old',operationId:'op-token'});
  assert.equal((await authorize('settle')).ok,false,'stale token');
 });
});

test('startup refuses missing I/O tables or release trigger before constructor side effects',async()=>{
 for(const missing of ['quant_io_ledgers','quant_io_launches','trigger']){
  const f=fixture(),query=f.db.query;
  f.db.query=async(sql,args)=>sql.includes('to_regclass')&&args[0]===missing?{rows:[{present:null}]}:
   sql.includes('pg_trigger')&&missing==='trigger'?{rows:[],rowCount:0}:query(sql,args);
  await assert.rejects(wireQuantProfileV2(f.options),{code:missing==='trigger'?'QUANT_PROFILE_RELEASE_GUARD_REQUIRED':'QUANT_PROFILE_IO_SCHEMA_REQUIRED'});
  assert.equal(f.stats().factories,0);assert.equal(f.worker.profileRuntimeV2,undefined);
 }
});

test('startup refuses changed release root or untrusted device identity',async()=>{
 const root=fixture();root.options.fileSystem.realpath=async()=>path.join(os.tmpdir(),'wrong-release');
 await assert.rejects(wireQuantProfileV2(root.options),{code:'QUANT_PROFILE_RELEASE_ROOT_MISMATCH'});
 for(const identity of [{ino:17,isBlockDevice:()=>false},{ino:0,isBlockDevice:()=>true},{ino:NaN,isBlockDevice:()=>true}]){
  const f=fixture();f.options.fileSystem.stat=async()=>identity;
  await assert.rejects(wireQuantProfileV2(f.options),{code:'QUANT_PROFILE_DEVICE_IDENTITY_REQUIRED'});
  assert.equal(f.stats().factories,0);
 }
});
