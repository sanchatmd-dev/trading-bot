import test from 'node:test';
import assert from 'node:assert/strict';
import {validateQuantCapacityPolicy,createProfileRuntimeHealth} from '../src/postgres/quant-capacity-policy.js';
import {QuantResearchFoundationWorker} from '../src/postgres/quant-research-foundation.js';
import {QuantFoundationScheduler} from '../src/postgres/quant-foundation-scheduler.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {canonical,hash} from '../src/pine-bridge/source.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
 const {policy,contract}=profileV2Fixture(600);
 policy.environment='staging';policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=hash(canonical(policy));
 return {policy,contract};
}

test('product capacity policy requires staging and terminal block',()=>{
 const {policy}=fixture();assert.ok(Object.isFrozen(validateQuantCapacityPolicy(policy)));
 const missing=structuredClone(policy);delete missing.terminal;
 assert.throws(()=>validateQuantCapacityPolicy(missing),{code:'QUANT_CAPACITY_POLICY_INVALID'});
 assert.throws(()=>validateQuantCapacityPolicy({...policy,environment:'local'}),{code:'QUANT_CAPACITY_POLICY_INVALID'});
});

test('PROFILE runtime health maps only known actions',async()=>{
 const calls=[],health=createProfileRuntimeHealth(async input=>{calls.push(input.action);return {ok:true};});
 await health({action:'PROFILE_RELEASE'});await health({action:'PROFILE_OBSERVE'});
 assert.deepEqual(calls,['CLAIM','HEARTBEAT']);
 for(const action of ['FINISH','toString','constructor','__proto__'])
  assert.throws(()=>health({action}),{code:'QUANT_PROFILE_HEALTH_ACTION_INVALID'});
 assert.throws(()=>createProfileRuntimeHealth(null),{code:'QUANT_PROFILE_HEALTH_CALLBACK_REQUIRED'});
});

function workerFixture(){
 const {policy,contract}=fixture();
 const foundation={job_id:'job-1',lease_token:'token-1',owner_id:contract.owner_id,contract,status:'RUNNING',deadline_at:1000000,run_started_at:0};
 let heartbeats=0,reconciles=0;const logs=[];
 const db={query:async sql=>{
  if(sql.startsWith('SELECT * FROM quant_foundation_jobs'))return {rows:[foundation]};
  if(sql.startsWith('UPDATE quant_foundation_jobs')){foundation.status='STOPPING';return {rows:[]};}
  return {rows:[]};
 },transaction:async callback=>callback()};
 const worker=new QuantResearchFoundationWorker({service:{db,foundation:true},health:async()=>({ok:true}),profileV2Enabled:true,capacityPolicy:policy,clock:()=>0,leaseMs:30,terminalLog:line=>logs.push(JSON.parse(line))});
 worker.claim=async()=>({kind:'PROFILE',foundation});
 worker.scheduler.heartbeat=async()=>{heartbeats++;if(foundation.status!=='RUNNING')throw Error('lease lost');};
 worker.reconcile=async()=>{reconciles++;};
 return {worker,foundation,policy,logs,stats:()=>({heartbeats,reconciles})};
}

test('V2 tick quiets heartbeat before terminal and clears emergency entries on throw',{timeout:3000},async()=>{
 const f=workerFixture(),entries=new Set(['job-1:op-token-1']);
 let atTerminal;
 f.worker.profileRuntimeV2={io:{emergency:entries},run:async({beforeTerminal,signal})=>{
  await sleep(25);await beforeTerminal();atTerminal=f.stats().heartbeats;
  f.foundation.status='STOPPING';await sleep(45);
  assert.equal(f.stats().heartbeats,atTerminal);assert.equal(signal.aborted,false);
  throw Object.assign(Error('PROFILE_COMPUTE_DEADLINE'),{code:'PROFILE_COMPUTE_DEADLINE',terminal:{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'}});
 }};
 assert.equal(await f.worker.tick(),true);
 assert.ok(atTerminal>0);assert.equal(entries.size,0);assert.equal(f.worker.profileOperations.size,0);
 assert.equal(f.stats().reconciles,1);
});

test('V2 pre-reserve refusal stops heartbeat and never invokes runtime',{timeout:3000},async()=>{
 const f=workerFixture();f.foundation.deadline_at=34999;
 f.worker.profileRuntimeV2={run:()=>assert.fail('reserve path must not run')};
 await f.worker.tick();const before=f.stats().heartbeats;await sleep(35);
 assert.equal(f.stats().heartbeats,before);assert.equal(f.foundation.status,'STOPPING');
});

test('V2 UNCONFIRMED terminal stays quarantined and stop delivers emergency',{timeout:3000},async()=>{
 const f=workerFixture();let reached;
 const started=new Promise(resolve=>{reached=resolve;});
 f.worker.profileRuntimeV2={run:async({emergency,beforeTerminal})=>{
  reached();await new Promise(resolve=>emergency.addEventListener('abort',resolve,{once:true}));
  await beforeTerminal();throw Object.assign(Error('PROFILE_STOP_REQUESTED'),{code:'PROFILE_STOP_REQUESTED',terminal:{status:'STOPPING',proof:'UNCONFIRMED'}});
 }};
 const tick=f.worker.tick();await started;await f.worker.stop();await tick;
 assert.equal(f.foundation.status,'STOPPING');assert.equal(f.stats().reconciles,0);
});

function schedulerFixture(rows,{policy,enabled=true}={}){
 const db={transaction:async callback=>callback(),query:async(sql,args=[])=>{
  if(sql.includes("status IN ('RUNNING','STOPPING')"))return {rows:[]};
  if(sql.includes('AND (deadline_at'))return {rows:[]};
  if(sql.includes('SELECT j.*'))return {rows:rows.filter(row=>['QUEUED','PAUSED'].includes(row.status)).slice(0,1)};
  if(sql.startsWith("UPDATE quant_foundation_jobs SET status='CANCELLED'")){
   rows.find(row=>row.job_id===args[0]).status='CANCELLED';rows.find(row=>row.job_id===args[0]).diagnostic=args[1];return {rows:[]};
  }
  if(sql.includes('RETURNING service_counter'))return {rows:[{service_counter:1}]};
  if(sql.startsWith("UPDATE quant_foundation_jobs SET status='RUNNING'")){
   const row=rows.find(row=>row.job_id===args[0]);Object.assign(row,{status:'RUNNING',lease_token:args[2]});return {rows:[row]};
  }
  return {rows:[]};
 }};
 return new QuantFoundationScheduler({db,capacityPolicy:policy,profileV2Enabled:enabled,authorize:async()=>({ok:true}),health:async()=>({ok:true}),clock:()=>0});
}
const queued=(contract,id)=>({job_id:id,owner_id:contract.owner_id,contract,contract_hash:hash(canonical(contract)),status:'QUEUED',attempts:0,next_bar:0,deadline_at:1000000});

test('V2 disabled or invalid policy cancels row and next research-v2 row claims',async()=>{
 for(const options of [{enabled:false},{enabled:true},{enabled:true,policy:fixture().policy}]){
  const {contract}=fixture();if(options.policy)contract.capacity.policy_hash='0'.repeat(64);
  const research={version:'quant-foundation-research-v2',owner_id:'owner-b',kind:'OPTIMIZE',budget:{max_runtime_ms:900000}};
  const rows=[queued(contract,'bad'),queued(research,'research')],scheduler=schedulerFixture(rows,options);
  const claimed=await scheduler.claim('worker');assert.equal(claimed.job_id,'research');
  assert.equal(rows[0].status,'CANCELLED');assert.equal(rows[0].diagnostic,options.enabled===false?'PROFILE_V2_DISABLED':'CAPACITY_POLICY_MISMATCH');
 }
});

test('V2 PROFILE refuses second attempt at claim',async()=>{
 const {policy,contract}=fixture(),row=queued(contract,'retry');row.attempts=1;row.status='PAUSED';
 assert.equal(await schedulerFixture([row],{policy}).claim('worker'),null);
 assert.equal(row.status,'CANCELLED');assert.equal(row.diagnostic,'PROFILE_ATTEMPT_EXHAUSTED');
});

test('worker preserves initiating error and terminal proof for every required cause',async()=>{
 for(const code of ['PROFILE_STOP_REQUESTED','PROFILE_COMPUTE_DEADLINE','QUANT_PROFILE_POLICY_MISMATCH','QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED']){
  for(const proof of ['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED','NO_START_PROVEN','UNCONFIRMED']){
   const f=workerFixture();
   f.worker.profileRuntimeV2={run:async({onTerminalDiagnostic})=>{
    onTerminalDiagnostic({proof,reason:'COMPLETE',elapsedMs:9999999,drainMs:3});
    throw Object.assign(Error(code),{code,terminal:{status:proof==='UNCONFIRMED'?'STOPPING':'CANCELLED',proof}});
   }};
   await f.worker.tick();assert.equal(f.logs.length,1);assert.equal(f.logs[0].proof,proof);
   assert.equal(f.logs[0].reason,code,'initiating error wins over terminal diagnostic');
   assert.equal(f.logs[0].drainMs,3);assert.ok(f.logs[0].elapsedMs<9999999,'elapsed always uses worker-run clock');
   assert.equal(f.stats().reconciles,proof==='UNCONFIRMED'?0:1);
  }
 }
});
