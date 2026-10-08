import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {QuantFoundationScheduler} from '../src/postgres/quant-foundation-scheduler.js';
import {QuantResearchFoundationWorker,assertQuantHealthRecoveryPool,QUANT_HEALTH_RECOVERY_MINIMUM_POOL,
 QUANT_PROFILE_TERMINAL_LOG_REASONS} from '../src/postgres/quant-research-foundation.js';
import {QUANT_IO_DIAGNOSTIC_REASONS} from '../src/postgres/quant-io-runtime.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {canonical,hash} from '../src/pine-bridge/source.js';

// --- A: worker pool rule for health recovery ---------------------------------------------------------------------
const pool=(poolMax,recoveryEnabled=true)=>()=>assertQuantHealthRecoveryPool({recoveryEnabled,poolMax});

test('health recovery needs 4 pool connections for every worker and no pool check without recovery',()=>{
 assert.equal(QUANT_HEALTH_RECOVERY_MINIMUM_POOL,4);
 for(const max of [1,2,3])assert.throws(pool(max),/PG_POOL_SIZE at least 4 /);
 for(const max of [4,5,50])assert.doesNotThrow(pool(max));
 for(const max of [1,2,3,4])assert.doesNotThrow(pool(max,false));
 // BACKFILL, PROFILE V1 and legacy research (V2 and PREFLIGHT off) starve the probe at 3 as well: no flag changes the rule.
 for(const flags of [{},{profileV2Enabled:false,preflightEnabled:false},{profileV2Enabled:true},{preflightEnabled:true}])
  assert.throws(()=>assertQuantHealthRecoveryPool({recoveryEnabled:true,poolMax:3,...flags}),/PG_POOL_SIZE at least 4 /);
 assert.throws(pool(3),{message:'Health recovery requires PG_POOL_SIZE at least 4 for runtime lock, two scheduler transactions and independent probe'});
});

test('health recovery refuses a pool size that is not a usable number',()=>{
 for(const max of [undefined,null,NaN,0,-1])assert.throws(pool(max),/PG_POOL_SIZE at least 4 /);
 assert.throws(()=>assertQuantHealthRecoveryPool(),/PG_POOL_SIZE at least 4 /,'an omitted recoveryEnabled still checks');
});

test('the worker entry point runs the shared pool rule right after recoveryEnabled and before the recovery probe',()=>{
 // quant-research-main.js runs top-level side effects (config, database, systemd), so it is checked from source.
 // Comments are removed first, so a commented-out call cannot satisfy the check.
 const code=fs.readFileSync(new URL('../src/postgres/quant-research-main.js',import.meta.url),'utf8')
  .replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
 assert.match(code,/const recoveryEnabled=!!process\.env\.QUANT_HEALTH_RECOVERY_FILE;\s*assertQuantHealthRecoveryPool\(\{recoveryEnabled,poolMax:db\.pool\.options\.max\}\);\s*const researchProbeDb=/);
 assert.doesNotMatch(code,/options\.max\s*[<>]/);
});

// --- B: the scheduler claims PROFILE V2 only with an explicit flag ------------------------------------------------
const jobRow=(contract,id)=>({job_id:id,owner_id:contract.owner_id,contract,contract_hash:hash(canonical(contract)),
 status:'QUEUED',attempts:0,next_bar:0,deadline_at:1000000});
function schedulerOver(rows,options){
 const db={transaction:async callback=>callback(),query:async(sql,args=[])=>{
  if(sql.includes("status IN ('RUNNING','STOPPING')")||sql.includes('AND (deadline_at'))return {rows:[]};
  if(sql.includes('SELECT j.*'))return {rows:rows.filter(row=>['QUEUED','PAUSED'].includes(row.status)).slice(0,1)};
  if(sql.startsWith("UPDATE quant_foundation_jobs SET status='CANCELLED'")){
   Object.assign(rows.find(row=>row.job_id===args[0]),{status:'CANCELLED',diagnostic:args[1]});return {rows:[]};
  }
  if(sql.includes('RETURNING service_counter'))return {rows:[{service_counter:1}]};
  if(sql.startsWith("UPDATE quant_foundation_jobs SET status='RUNNING'")){
   const row=rows.find(row=>row.job_id===args[0]);Object.assign(row,{status:'RUNNING',lease_token:args[2]});return {rows:[row]};
  }
  return {rows:[]};
 }};
 return new QuantFoundationScheduler({db,authorize:async()=>({ok:true}),health:async()=>({ok:true}),clock:()=>0,...options});
}

test('a scheduler built without profileV2Enabled refuses a PROFILE V2 claim with PROFILE_V2_DISABLED',async()=>{
 const {policy,contract}=profileV2Fixture(2000);
 const legacy={version:'quant-foundation-v1',owner_id:'owner-b',kind:'BACKTEST',budget:{max_runtime_ms:900000}};
 const rows=[jobRow(contract,'profile'),jobRow(legacy,'legacy')];
 const scheduler=schedulerOver(rows,{capacityPolicy:policy});
 assert.equal(scheduler.profileV2Enabled,false);
 const claimed=await scheduler.claim('worker');
 assert.equal(claimed.job_id,'legacy','only the PROFILE V2 row is refused; the next row still claims');
 assert.equal(rows[0].status,'CANCELLED');assert.equal(rows[0].diagnostic,'PROFILE_V2_DISABLED');
 assert.equal(rows[1].status,'RUNNING');
 // Positive control: the same row and policy claim once the flag is an explicit true.
 const enabledRows=[jobRow(contract,'profile')];
 const enabled=schedulerOver(enabledRows,{capacityPolicy:policy,profileV2Enabled:true});
 assert.equal(enabled.profileV2Enabled,true);
 assert.equal((await enabled.claim('worker')).job_id,'profile');assert.equal(enabledRows[0].status,'RUNNING');
});

test('only an explicit true enables PROFILE V2 on a scheduler',()=>{
 for(const value of [undefined,false,null,'true',1,'1',{}])assert.equal(schedulerOver([],{profileV2Enabled:value}).profileV2Enabled,false);
 assert.equal(schedulerOver([],{profileV2Enabled:true}).profileV2Enabled,true);
});

// --- C: one source for the diagnostic reasons ---------------------------------------------------------------------
const profileReasons=['PROFILE_STOP_REQUESTED','PROFILE_COMPUTE_DEADLINE','QUANT_PROFILE_POLICY_MISMATCH',
 'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED','PROFILE_DEADLINE_NEAR','PROFILE_V2_DISABLED','QUANT_IO_LAUNCH_UNCERTAIN'];

test('the worker terminal log reasons are the I/O diagnostic reasons plus the seven PROFILE reasons',()=>{
 assert.deepEqual([...QUANT_IO_DIAGNOSTIC_REASONS],['COMPLETE','STOP_REQUESTED','ALREADY_STOPPING','STOP_UNCONFIRMED','UNKNOWN',
  'WRITEBACK_PENDING','COMMIT_BARRIER_FAILED','COMMIT_BARRIER_TIMEOUT','MEMORY_STAT_INVALID','FREEZE_UNVERIFIED','NOT_FROZEN',
  'CGROUP_EMPTY','QUANT_IO_TELEMETRY_UNAVAILABLE','POST_EXIT_UNKNOWN','POST_EXIT_TAIL_OBSERVED']);
 assert.deepEqual([...QUANT_PROFILE_TERMINAL_LOG_REASONS],[...QUANT_IO_DIAGNOSTIC_REASONS,...profileReasons]);
 assert.equal(QUANT_PROFILE_TERMINAL_LOG_REASONS.length,22);
 assert.equal(new Set(QUANT_PROFILE_TERMINAL_LOG_REASONS).size,22);
 assert.ok(Object.isFrozen(QUANT_IO_DIAGNOSTIC_REASONS)&&Object.isFrozen(QUANT_PROFILE_TERMINAL_LOG_REASONS));
});

function profileTerminalLogFixture(){
 const policy={terminal:{runtime_max_ms:30000}};
 const logs=[],worker=Object.create(QuantResearchFoundationWorker.prototype);
 const job={foundation:{job_id:'job-1',lease_token:'token-1',owner_id:'owner-1',deadline_at:1000000,
  contract:{capacity:{policy_hash:hash(canonical(policy))}}}};
 Object.assign(worker,{profileV2Enabled:true,capacityPolicy:policy,clock:()=>0,
  profileOperations:new Map(),terminalLog:line=>logs.push(JSON.parse(line))});
 return {worker,job,logs};
}

test('PROFILE V2 thrown launch uncertainty retains its safe code, terminal proof and timings',async()=>{
 for(const proof of ['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED','UNCONFIRMED']){
  const {worker,job,logs}=profileTerminalLogFixture();
  const error=Object.assign(new Error('private message /private/error-path'),{
   code:'QUANT_IO_LAUNCH_UNCERTAIN',terminal:{proof,status:'private status'},path:'/private/path'});
  worker.profileRuntimeV2={run:async({onTerminalDiagnostic})=>{
   onTerminalDiagnostic({proof:'MEASURED_FINAL_SETTLED',reason:'COMPLETE',drainMs:32099,barrierMs:2,
    message:'private diagnostic',path:'/private/diagnostic-path'});
   throw error;
  }};
  await assert.rejects(worker.runProfileV2(job,{}),value=>value===error);
  assert.equal(logs.length,1);
  const {elapsedMs,...record}=logs[0];
  assert.deepEqual(record,{jobId:'job-1',proof,reason:'QUANT_IO_LAUNCH_UNCERTAIN',drainMs:32099,barrierMs:2});
  assert.ok(Number.isSafeInteger(elapsedMs)&&elapsedMs>=0);
  assert.doesNotMatch(JSON.stringify(logs),/private/);
  assert.equal(worker.profileOperations.size,0);
 }
});

test('PROFILE V2 error logs exclude arbitrary codes, messages and paths; COMPLETE needs measured proof',async()=>{
 for(const code of ['arbitrary error /private/code-path',undefined,'COMPLETE']){
  const {worker,job,logs}=profileTerminalLogFixture();
  const error=Object.assign(new Error('private message /private/message-path'),{
   code,terminal:{proof:'UNKNOWN_FINAL_CHARGED'},path:'/private/path'});
  worker.profileRuntimeV2={run:async({onTerminalDiagnostic})=>{
   onTerminalDiagnostic({proof:'UNKNOWN_FINAL_CHARGED',reason:'COMPLETE',drainMs:-1,barrierMs:'private'});
   throw error;
  }};
  await assert.rejects(worker.runProfileV2(job,{}),value=>value===error);
  assert.equal(logs.length,1);
  const {elapsedMs,...record}=logs[0];
  assert.deepEqual(record,{jobId:'job-1',proof:'UNKNOWN_FINAL_CHARGED',reason:'UNKNOWN'});
  assert.ok(Number.isSafeInteger(elapsedMs)&&elapsedMs>=0);
  assert.doesNotMatch(JSON.stringify(logs),/private|arbitrary/);
 }
 for(const proof of ['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED','UNCONFIRMED']){
  const {worker,job,logs}=profileTerminalLogFixture();
  const answer={status:'CANCELLED',proof};
  worker.profileRuntimeV2={run:async()=>answer};
  assert.equal(await worker.runProfileV2(job,{}),answer);
  assert.equal(logs.length,1);
  assert.equal(logs[0].proof,proof);
  assert.equal(logs[0].reason,proof==='MEASURED_FINAL_SETTLED'?'COMPLETE':'UNKNOWN');
 }
});

test('the PROFILE V2 terminal log keeps every listed reason and maps any other reason to UNKNOWN',{timeout:10000},async()=>{
 const {policy,contract}=profileV2Fixture(600);
 policy.environment='staging';policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=hash(canonical(policy));
 const foundation={job_id:'job-1',lease_token:'token-1',owner_id:contract.owner_id,contract,status:'RUNNING',deadline_at:1000000,run_started_at:0};
 const db={query:async()=>({rows:[]}),transaction:async callback=>callback()},logs=[];
 const worker=new QuantResearchFoundationWorker({service:{db,foundation:true},health:async()=>({ok:true}),profileV2Enabled:true,
  capacityPolicy:policy,clock:()=>0,leaseMs:30,terminalLog:line=>logs.push(JSON.parse(line))});
 worker.claim=async()=>({kind:'PROFILE',foundation});
 worker.scheduler.heartbeat=async()=>{};
 worker.reconcile=async()=>{};
 let reported;
 worker.profileRuntimeV2={run:async({onTerminalDiagnostic})=>{
  onTerminalDiagnostic({proof:'MEASURED_FINAL_SETTLED',reason:reported});
  return {status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'};
 }};
 for(const reason of [...QUANT_PROFILE_TERMINAL_LOG_REASONS,'RUNTIME_EXCEEDED','FOUNDATION_LEASE_LOST','complete','']){
  reported=reason;logs.length=0;
  assert.equal(await worker.tick(),true);
  assert.equal(logs.length,1);
  assert.equal(logs[0].proof,'MEASURED_FINAL_SETTLED');
  assert.equal(logs[0].reason,QUANT_PROFILE_TERMINAL_LOG_REASONS.includes(reason)?reason:'UNKNOWN',JSON.stringify(reason));
 }
});
