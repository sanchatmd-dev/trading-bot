import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {profileEnrollmentEvidenceFixture} from './helpers/profile-enrollment-evidence-fixture.js';
import {createProfileEnrollmentTicketAuthority} from '../src/postgres/quant-profile-enrollment-ticket.js';
import {createIoBudgetLedger,reserveIoOperation,bindIoOperation,observeIoOperation,settleIoOperation}
 from '../src/quant-research/io-budget-ledger.js';
import * as enrollmentModule from '../src/postgres/quant-profile-enrollment.js';
const {prepareEnrollmentAttempt,beginProfileCompletionLocked,refreshProfileCompletionTicket,finalizeProfileEnrollmentLocked,
 chargeProfileCompletionRuntime}=enrollmentModule;

// Pure harness: real attempt, ticket, BEGIN, finalizer and receipt code over a recording database double.
const sha=letter=>letter.repeat(64);
const MAX=900000,START=1000000;
// Returns the listed readings in order, then repeats the last one.
const scripted=(...values)=>{let index=0;return ()=>values[Math.min(index++,values.length-1)];};
const isCharge=sql=>sql.startsWith('UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST(runtime_used_ms,$3)');
const isBegin=sql=>sql.startsWith("UPDATE quant_foundation_jobs SET status='STOPPING'");
const isReceipt=sql=>sql.startsWith('INSERT INTO public.quant_profile_enrollment_receipts');
const isSuccess=sql=>sql.startsWith("UPDATE quant_foundation_jobs SET status='SUCCEEDED'");

async function prepared({startAt=START,runtimeUsed=0,deadlineAt=startAt+MAX,leaseUntil=startAt+30000}={}){
 const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const metadata=deriveClosedMetadataV2(contract.dataset);
 const references={raw:{dataset_id:sha('5'),sha256:sha('5'),metadata},sidecar:{version:'research-atr14-chunked-v2',sha256:sha('6'),bar_count:metadata.total_bars,first_time:metadata.start_time,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'}};
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:contract.dataset.sha256,closed_dataset_sha256:references.raw.sha256,atr14_sha256:references.sidecar.sha256,first_closed_time:metadata.start_time,bar_count:metadata.total_bars,evidence:{source_hash:contract.profile.source_hash,effective_inputs_hash:contract.profile.effective_inputs_hash,evaluator_hash:contract.capacity.scope.evaluator_hash,execution_model_hash:hash(canonical(contract.profile.execution_model)),metadata_hash:contract.profile.metadata_hash,raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500},data_profile_verified:true,evaluator_admission:false};
 const result={version:'research-profile-enrollment-v2',raw:structuredClone(contract.dataset),references,binding:{...binding,binding_sha256:hash(canonical(binding))},data_profile_verified:true,evaluator_admission:false,acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
 const evidence=profileEnrollmentEvidenceFixture({contract,result,policy,now:1700000000000}),lease=evidence.launch.lease_token;
 const job={...evidence.job,status:'RUNNING',lease_token:lease,lease_until:leaseUntil,deadline_at:deadlineAt,
  run_started_at:startAt,runtime_used_ms:runtimeUsed};
 const flags={transaction:false},epoch={},calls=[];
 const tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:async()=>contract.engine_hash,
  releaseGuard:()=>epoch,isTransaction:()=>flags.transaction});
 const enrollment={enabled:true,tickets,assertSchemaLocked:async()=>{},authorizeLocked:async()=>({ok:true})};
 const frame={jobId:job.job_id,operationId:evidence.launch.operation_id,payloadHash:evidence.launch.payload_hash,
  resultHash:hash(canonical(result)),result};
 const attempt=await prepareEnrollmentAttempt({job,frame,leaseToken:lease,operationId:frame.operationId,policy,enrollment});
 const db={get isTransaction(){return flags.transaction;},query:async(sql,parameters)=>{calls.push({sql,parameters});
  if(sql.startsWith('SELECT 1 FROM quant_io_launches'))return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[{...job,status:isSuccess(sql)?'SUCCEEDED':'STOPPING'}]};}};
 const locked=async work=>{flags.transaction=true;try{return await work();}finally{flags.transaction=false;}};
 // BEGIN keeps the clock functions in the completion; these indirections let a test script terminal readings later.
 const readings={wall:()=>START,mono:()=>0};
 const clock=()=>readings.wall(),monotonic=()=>readings.mono();
 const begin=()=>locked(()=>beginProfileCompletionLocked({db,job,attempt,clock,monotonic}));
 async function finalize(completion,{wall,mono,launch=evidence.launch,health={ok:true},ledger=evidence.ledger}){
  const executionTicket=await refreshProfileCompletionTicket(completion);
  const persisted=calls.find(call=>isBegin(call.sql)).parameters[2];
  const stopping={...job,status:'STOPPING',stop_reason:'PROFILE_COMPLETING',lease_until:null,run_started_at:null,
   runtime_used_ms:persisted};
  readings.wall=wall;readings.mono=mono;
  return locked(()=>finalizeProfileEnrollmentLocked({db,job:stopping,settledLedger:ledger,launch,completion,
   executionTicket,healthObservation:health,currentPolicy:attempt.policy}));
 }
 // The unknown-final fallback charge: outside any transaction, on the same completion clock.
 async function charge(completion,{wall,mono}){
  readings.wall=wall;readings.mono=mono;
  return chargeProfileCompletionRuntime({db,completion});
 }
 return {evidence,policy,contract,readings,begin,finalize,charge,
  charges:()=>calls.filter(call=>isCharge(call.sql)).map(call=>call.parameters[2]),
  chargeKeys:()=>calls.filter(call=>isCharge(call.sql)).map(call=>call.parameters.slice(0,2)),
  begun:()=>calls.filter(call=>isBegin(call.sql)).map(call=>call.parameters[2]),
  receipts:()=>calls.filter(call=>isReceipt(call.sql)).map(call=>{
   const fields=call.sql.slice(call.sql.indexOf('(')+1,call.sql.indexOf(')')).split(',');
   return Object.fromEntries(fields.map((field,index)=>[field,call.parameters[index]]));}),
  successes:()=>calls.filter(call=>isSuccess(call.sql)).map(call=>call.parameters[3]),
  rolledBack:()=>calls.some(call=>call.sql==='ROLLBACK TO SAVEPOINT profile_enrollment_publication')};
}
// Prepare, then BEGIN with the given readings.
async function begun(options,{wall,mono}){
 const f=await prepared(options);f.readings.wall=wall;f.readings.mono=mono;
 return {f,completion:await f.begin()};
}

test('BEGIN refuses a wall read below an earlier read of the same attempt, even after run_started_at',async()=>{
 const f=await prepared();f.readings.wall=scripted(START+100,START+99);f.readings.mono=()=>5;
 await assert.rejects(f.begin(),{code:'PROFILE_ENROLLMENT_DENIED'});
 assert.deepEqual(f.begun(),[]);
});

test('BEGIN persists exactly the reading it compared, at runtime, deadline and lease boundaries',async()=>{
 const fit=async(options,wall,expected)=>{
  const f=await prepared(options);f.readings.wall=wall;
  if(expected===null){
   await assert.rejects(f.begin(),{code:'PROFILE_ENROLLMENT_DENIED'});assert.deepEqual(f.begun(),[]);
  }else{await f.begin();assert.deepEqual(f.begun(),[expected]);}
 };
 await fit({runtimeUsed:MAX-101},()=>START+100,MAX-1);
 await fit({runtimeUsed:MAX-100},()=>START+100,null);
 await fit({deadlineAt:START+101},()=>START+100,100);
 await fit({deadlineAt:START+100},()=>START+100,null);
 await fit({leaseUntil:START+100},()=>START+100,null);
 // Earlier readings fit; the persisted reading reaches the deadline, so it is refused rather than persisted.
 await fit({deadlineAt:START+30},scripted(START+10,START+20,START+30),null);
 await fit({deadlineAt:START+31},scripted(START+10,START+20,START+30),30);
});

test('FINALIZE compares the charged reading: a wall step past the budget cannot be undone by a later lower read',async()=>{
 const {f,completion}=await begun({},{wall:()=>START,mono:()=>0});
 const answer=await f.finalize(completion,{wall:scripted(START+800000,START+800001,START+800002,START+800003,
  START+905000,START+850000),mono:()=>800000});
 assert.deepEqual(answer,{kind:'DENIED',reason:'BUDGET'});
 assert.deepEqual(f.receipts(),[]);assert.deepEqual(f.successes(),[]);
 // The measured 905,000 ms stays charged; the lower wall read afterwards is an anomaly, never a smaller charge.
 assert.deepEqual(f.charges(),[905000,905000]);
});

test('FINALIZE denies publication when the wall clock steps back after the charge and keeps the higher charge',async()=>{
 const {f,completion}=await begun({},{wall:()=>START,mono:()=>0});
 const answer=await f.finalize(completion,{wall:scripted(START+1000,START+1001,START+1002,START+1003,START+1004,
  START+500),mono:()=>1000});
 assert.deepEqual(answer,{kind:'DENIED',reason:'VETO'});
 assert.equal(f.rolledBack(),true);assert.deepEqual(f.receipts(),[]);assert.deepEqual(f.successes(),[]);
 assert.deepEqual(f.charges(),[1004,1004]);
});

test('FINALIZE wall reversal below BEGIN denies and still charges the monotonic terminal runtime',async()=>{
 const {f,completion}=await begun({runtimeUsed:1000},{wall:()=>START,mono:()=>0});
 assert.deepEqual(f.begun(),[1000]);
 const answer=await f.finalize(completion,{wall:()=>START-5,mono:()=>800000});
 assert.deepEqual(answer,{kind:'DENIED',reason:'AUTHORITY'});
 assert.deepEqual(f.charges(),[801000]);assert.deepEqual(f.receipts(),[]);
});

test('FINALIZE enrolls one millisecond inside both limits and persists exactly the compared reading',async()=>{
 const {f,completion}=await begun({},{wall:()=>START,mono:()=>0});
 const answer=await f.finalize(completion,{wall:()=>START+MAX-1,mono:()=>MAX-1});
 assert.equal(answer.kind,'ENROLLED');
 assert.deepEqual(f.charges(),[MAX-1]);assert.deepEqual(f.successes(),[MAX-1]);
 assert.equal(f.receipts()[0].completed_at,START+MAX-1);
});

test('FINALIZE denies at the exact runtime and deadline boundary of the charged reading',async()=>{
 const runtime=await begun({deadlineAt:START+MAX+5000},{wall:()=>START,mono:()=>0});
 assert.deepEqual(await runtime.f.finalize(runtime.completion,{wall:scripted(START+10,START+11,START+12,START+13,
  START+MAX),mono:()=>0}),{kind:'DENIED',reason:'BUDGET'});
 assert.deepEqual(runtime.f.charges(),[MAX,MAX]);assert.deepEqual(runtime.f.receipts(),[]);
 const deadline=await begun({deadlineAt:START+500},{wall:()=>START,mono:()=>0});
 assert.deepEqual(await deadline.f.finalize(deadline.completion,{wall:scripted(START+10,START+11,START+12,START+13,
  START+500),mono:()=>0}),{kind:'DENIED',reason:'BUDGET'});
 assert.deepEqual(deadline.f.charges(),[500,500]);assert.deepEqual(deadline.f.receipts(),[]);
});

test('a denied FINALIZE still charges its measured runtime',async()=>{
 const {f,completion}=await begun({runtimeUsed:250},{wall:()=>START,mono:()=>0});
 const answer=await f.finalize(completion,{wall:()=>START+40,mono:()=>70,health:{ok:false}});
 assert.deepEqual(answer,{kind:'DENIED',reason:'AUTHORITY'});assert.deepEqual(f.charges(),[320]);
});

test('FINALIZE denies a launch row that is not the attempt launch while the measured runtime is charged',async()=>{
 for(const mutate of [launch=>{launch.payload_hash=sha('a');},launch=>{launch.operation_id='other-operation-fixture';},
  launch=>{launch.lease_token='00000000-0000-4000-8000-000000000000';},
  launch=>{launch.job_id='00000000-0000-4000-8000-000000000001';},launch=>{launch.state='RELEASED';}]){
  const {f,completion}=await begun({},{wall:()=>START,mono:()=>0}),launch=structuredClone(f.evidence.launch);mutate(launch);
  const answer=await f.finalize(completion,{wall:()=>START+10,mono:()=>10,launch});
  assert.deepEqual(answer,{kind:'DENIED',reason:'AUTHORITY'});
  assert.deepEqual(f.receipts(),[]);assert.deepEqual(f.successes(),[]);assert.deepEqual(f.charges(),[10]);
 }
});

// The attempt's own settled operation, replayed through the real ledger transitions with the unit frozen at the given
// counters. A frozen sample at the allowance or in the cleanup reserve latches the stop reason a measured settlement keeps.
function settledLedgerAt(f,{read,write=0}){
 const {evidence,contract,policy}=f,base=evidence.ledger.state,operation=base.operations[0],[device]=base.devices;
 const sampleAt=(readBytes,writeBytes)=>({devices:[{...device,read_bytes:readBytes,write_bytes:writeBytes}]});
 const identity={operation_id:operation.operation_id,lease_token:operation.lease_token,cgroup_id:operation.cgroup_id,
  cgroup_inode:operation.cgroup_inode};
 let state=createIoBudgetLedger({request:contract.capacity,policy,job_id:base.job_id,lease_token:base.lease_token,devices:base.devices});
 state=reserveIoOperation(state,{operation_id:operation.operation_id,lease_token:operation.lease_token,
  domain_id:operation.domain_id,cgroup_id:operation.cgroup_id,allowance:operation.allowance});
 state=bindIoOperation(state,{...identity,domain_id:operation.domain_id,domain_relation:'DISJOINT',
  domain_proof_sha256:operation.domain_proof_sha256,identity_proof_sha256:operation.identity_proof_sha256,
  counter_origin:'CGROUP_BIRTH',sample:sampleAt(0,0)});
 state=observeIoOperation(state,{...identity,sample:sampleAt(read,write)});
 state=settleIoOperation(state,{...identity,stopped:true,stop_proof_sha256:operation.terminal_proof.stop_proof_sha256,
  final_readback:true,readback_proof_sha256:operation.terminal_proof.readback_proof_sha256,sample:sampleAt(read,write)});
 return {...evidence.ledger,revision:state.revision,state,state_hash:hash(canonical(state))};
}

test('FINALIZE never enrolls a settled operation that still carries a latched stop reason, and charges the measured runtime',async()=>{
 // Counters of 0 latch nothing: the replayed ledger itself enrolls, so only the stop reason can cause the denial below.
 const control=await begun({runtimeUsed:250},{wall:()=>START,mono:()=>0});
 const clean=settledLedgerAt(control.f,{read:0});
 assert.equal(clean.state.operations[0].stop_reason,null);
 assert.equal((await control.f.finalize(control.completion,{wall:()=>START+40,mono:()=>70,ledger:clean})).kind,'ENROLLED');
 // Reading exactly the allowance exhausts it. Reading one byte more than the total minus the cleanup reserve puts the
 // cleanup reserve at risk.
 const atAllowance=f=>f.evidence.ledger.state.operations[0].allowance.read_bytes;
 const intoCleanup=f=>f.contract.capacity.io.read_bytes-f.contract.capacity.io.cleanup_read_bytes+1;
 for(const [reason,readOf] of [['ALLOWANCE_EXHAUSTED',atAllowance],['CLEANUP_RESERVE_AT_RISK',intoCleanup]]){
  const {f,completion}=await begun({runtimeUsed:250},{wall:()=>START,mono:()=>0}),ledger=settledLedgerAt(f,{read:readOf(f)});
  assert.equal(ledger.state.operations[0].status,'SETTLED');assert.equal(ledger.state.operations[0].stop_reason,reason);
  const answer=await f.finalize(completion,{wall:()=>START+40,mono:()=>70,ledger});
  assert.deepEqual(answer,{kind:'DENIED',reason:'IO_BUDGET'},reason);
  assert.deepEqual(f.receipts(),[],reason);assert.deepEqual(f.successes(),[],reason);assert.equal(f.rolledBack(),false);
  // The measured terminal runtime (250 at BEGIN plus the 70 ms monotonic floor) is charged exactly once.
  assert.deepEqual(f.charges(),[320],reason);
 }
});

test('a wall reading whose runtime total is unsafe is a clock anomaly: it is not stored and the monotonic floor still charges',async()=>{
 // BEGIN at wall 100 with the largest runtime BEGIN accepts. The largest safe wall reading is a safe elapsed on its own,
 // but the runtime already used plus that elapsed is not a safe integer.
 const {f,completion}=await begun({startAt:100,runtimeUsed:MAX-1},{wall:()=>100,mono:()=>0});
 assert.deepEqual(f.begun(),[MAX-1]);
 const answer=await f.finalize(completion,{wall:()=>Number.MAX_SAFE_INTEGER,mono:()=>70});
 assert.deepEqual(answer,{kind:'DENIED',reason:'AUTHORITY'});
 assert.deepEqual(f.charges(),[MAX+69]);assert.deepEqual(f.receipts(),[]);assert.deepEqual(f.successes(),[]);
 // The absurd reading was not stored, so a later floor still raises the charge instead of being lost behind it.
 assert.equal(await f.charge(completion,{wall:()=>Number.MAX_SAFE_INTEGER,mono:()=>90}),MAX+89);
 assert.deepEqual(f.charges(),[MAX+69,MAX+89]);
});

test('the fallback charge persists the absolute terminal runtime on the completion clock and never counts twice',async()=>{
 const {f,completion}=await begun({runtimeUsed:1000},{wall:()=>START,mono:()=>0});
 assert.deepEqual(f.begun(),[1000]);
 // Monotonic 70 ms against wall 40 ms: the floor wins. Later readings charge a higher absolute total, never an increment.
 assert.equal(await f.charge(completion,{wall:()=>START+40,mono:()=>70}),1070);
 assert.equal(await f.charge(completion,{wall:()=>START+90,mono:()=>80}),1090);
 // A wall step back is an anomaly: the charge keeps the high-water elapsed instead of dropping or growing.
 assert.equal(await f.charge(completion,{wall:()=>START+10,mono:()=>5}),1090);
 assert.deepEqual(f.charges(),[1070,1090,1090]);
 // Each charge is keyed by the attempt's own job and lease token, so it can never touch a later lease of the job.
 const {job_id,lease_token}=f.evidence.launch;
 assert.deepEqual(f.chargeKeys(),[[job_id,lease_token],[job_id,lease_token],[job_id,lease_token]]);
 // A completion this module never created is refused before any database work.
 await assert.rejects(chargeProfileCompletionRuntime({db:{query:async()=>{throw Error('no database');}},completion:{}}),
  {code:'PROFILE_ENROLLMENT_DENIED'});
});

test('a fallback charge after a denied FINALIZE repeats the persisted total instead of adding the runtime again',async()=>{
 const {f,completion}=await begun({runtimeUsed:250},{wall:()=>START,mono:()=>0});
 const answer=await f.finalize(completion,{wall:()=>START+40,mono:()=>70,health:{ok:false}});
 assert.deepEqual(answer,{kind:'DENIED',reason:'AUTHORITY'});assert.deepEqual(f.charges(),[320]);
 assert.equal(await f.charge(completion,{wall:()=>START+40,mono:()=>70}),320);
 assert.deepEqual(f.charges(),[320,320]);
});
