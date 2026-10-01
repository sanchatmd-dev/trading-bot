import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {profileEnrollmentEvidenceFixture} from './helpers/profile-enrollment-evidence-fixture.js';
import {createProfileEnrollmentTicketAuthority} from '../src/postgres/quant-profile-enrollment-ticket.js';
import {prepareEnrollmentAttempt,beginProfileCompletionLocked,refreshProfileCompletionTicket,finalizeProfileEnrollmentLocked,
 chargeProfileCompletionRuntime} from '../src/postgres/quant-profile-enrollment.js';
import {QuantIoRuntime,quantIoUnitName} from '../src/postgres/quant-io-runtime.js';

// Pure harness: real attempt, ticket, BEGIN, finalizer and I/O runtime terminal over a recording database double. The
// double keeps the one job row a charge touches and applies runtime_used_ms=GREATEST(runtime_used_ms,$3) for its key.
const sha=letter=>letter.repeat(64);
const MAX=900000,START=1000000,EXITS=['untrusted stop','untrusted terminate','settle UNCERTAIN'];
const isCharge=sql=>sql.startsWith('UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST(runtime_used_ms,$3)');
const isBegin=sql=>sql.startsWith("UPDATE quant_foundation_jobs SET status='STOPPING'");
const isReceipt=sql=>sql.startsWith('INSERT INTO public.quant_profile_enrollment_receipts');
const isSuccess=sql=>sql.startsWith("UPDATE quant_foundation_jobs SET status='SUCCEEDED'");

// Prepares an attempt, takes BEGIN at wall START and monotonic 0 with the given runtime already used, and builds an I/O
// runtime bound to the same enrollment authority. Later readings come from w.at(wall,mono).
async function begun({runtimeUsed=1000}={}){
 const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const metadata=deriveClosedMetadataV2(contract.dataset);
 const references={raw:{dataset_id:sha('5'),sha256:sha('5'),metadata},sidecar:{version:'research-atr14-chunked-v2',sha256:sha('6'),bar_count:metadata.total_bars,first_time:metadata.start_time,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'}};
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:contract.dataset.sha256,closed_dataset_sha256:references.raw.sha256,atr14_sha256:references.sidecar.sha256,first_closed_time:metadata.start_time,bar_count:metadata.total_bars,evidence:{source_hash:contract.profile.source_hash,effective_inputs_hash:contract.profile.effective_inputs_hash,evaluator_hash:contract.capacity.scope.evaluator_hash,execution_model_hash:hash(canonical(contract.profile.execution_model)),metadata_hash:contract.profile.metadata_hash,raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500},data_profile_verified:true,evaluator_admission:false};
 const result={version:'research-profile-enrollment-v2',raw:structuredClone(contract.dataset),references,binding:{...binding,binding_sha256:hash(canonical(binding))},data_profile_verified:true,evaluator_admission:false,acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
 const evidence=profileEnrollmentEvidenceFixture({contract,result,policy,now:1700000000000}),lease=evidence.launch.lease_token;
 const job={...evidence.job,status:'RUNNING',lease_token:lease,lease_until:START+30000,deadline_at:START+MAX,
  run_started_at:START,runtime_used_ms:runtimeUsed};
 const flags={transaction:false},epoch={},calls=[],row={runtime:runtimeUsed,token:lease},failure={charge:false};
 const tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:async()=>contract.engine_hash,
  releaseGuard:()=>epoch,isTransaction:()=>flags.transaction});
 const enrollment={enabled:true,tickets,assertSchemaLocked:async()=>{},authorizeLocked:async()=>({ok:true})};
 const frame={jobId:job.job_id,operationId:evidence.launch.operation_id,payloadHash:evidence.launch.payload_hash,
  resultHash:hash(canonical(result)),result};
 const attempt=await prepareEnrollmentAttempt({job,frame,leaseToken:lease,operationId:frame.operationId,policy,enrollment});
 const db={get isTransaction(){return flags.transaction;},transaction:async()=>{throw Error('no transaction expected');},
  query:async(sql,parameters)=>{calls.push({sql,parameters});
   if(sql.startsWith('SELECT 1 FROM quant_io_launches'))return {rowCount:0,rows:[]};
   if(isCharge(sql)){
    if(failure.charge)throw Error('charge unavailable');
    const match=parameters[0]===job.job_id&&parameters[1]===row.token;
    if(match)row.runtime=Math.max(row.runtime,parameters[2]);
    return {rowCount:match?1:0,rows:[]};
   }
   if(isBegin(sql))row.runtime=parameters[2];
   return {rowCount:1,rows:[{...job,status:isSuccess(sql)?'SUCCEEDED':'STOPPING'}]};}};
 const locked=async work=>{flags.transaction=true;try{return await work();}finally{flags.transaction=false;}};
 const readings={wall:()=>START,mono:()=>0};
 const clock=()=>readings.wall(),monotonic=()=>readings.mono();
 const completion=await locked(()=>beginProfileCompletionLocked({db,job,attempt,clock,monotonic}));
 const events=[],logs=[];
 const scheduler={cancel:async()=>{events.push('cancel');return {};},
  acknowledgeStopped:async()=>{events.push('acknowledge');return {status:'CANCELLED'};}};
 const ledger={open(){},db,policy,devices:[{device_id:'8:0',device_inode:100}]};
 const io=new QuantIoRuntime({db,ledger,scheduler,launcher:{spawnPrepared(){throw Error('not expected');}},clock:()=>START,enrollment});
 const request={jobId:job.job_id,leaseToken:lease,operationId:frame.operationId};
 const id=job.job_id+':'+frame.operationId,unitName=quantIoUnitName(job.job_id,frame.operationId);
 const trusted={unitName,launcherClosed:true,startRegistered:true,pendingStartsExcluded:true,unitStopped:true};
 // Puts a handle in the runtime that takes the named UNCONFIRMED exit of the terminal. The settle step is the only
 // other collaborator and is stubbed to report an uncertain commit outcome; no real settlement runs here.
 function install(kind){
  const sample={unitName},terminate=stopProof=>async({commit})=>{await commit(sample);
   return {stopProof,measured:true,frozenSample:sample,readbackEvidence:{},postExit:'REMOVED'};};
  io.handles.set(id,kind==='untrusted stop'?{stop:async()=>({unitName:'robot-quant-other.service'})}:
   {terminate:terminate(kind==='untrusted terminate'?null:trusted),stop:async()=>trusted});
  if(kind!=='untrusted stop')io.boundIdentity.set(id,{unitName});
  io.commitFrozen=async()=>{};io.settleMeasured=async()=>({kind:'UNCERTAIN'});
 }
 const at=(wall,mono)=>{readings.wall=()=>wall;readings.mono=()=>mono;};
 const onTerminalDiagnostic=log=>logs.push(log);
 const charge=async({wall,mono})=>{at(wall,mono);return chargeProfileCompletionRuntime({db,completion});};
 async function finalize({wall,mono,health={ok:true}}){
  const executionTicket=await refreshProfileCompletionTicket(completion);
  const stopping={...job,status:'STOPPING',stop_reason:'PROFILE_COMPLETING',lease_until:null,run_started_at:null,
   runtime_used_ms:calls.find(call=>isBegin(call.sql)).parameters[2]};
  at(wall,mono);
  return locked(()=>finalizeProfileEnrollmentLocked({db,job:stopping,settledLedger:evidence.ledger,launch:evidence.launch,
   completion,executionTicket,healthObservation:health,currentPolicy:attempt.policy}));
 }
 return {job,lease,row,calls,events,logs,failure,io,request,install,at,charge,finalize,onTerminalDiagnostic,
  complete:()=>io.completeProfile({...request,completion,onTerminalDiagnostic}),
  charges:()=>calls.filter(call=>isCharge(call.sql)).map(call=>call.parameters[2]),
  chargeKeys:()=>calls.filter(call=>isCharge(call.sql)).map(call=>call.parameters.slice(0,2)),
  receipts:()=>calls.filter(call=>isReceipt(call.sql)),successes:()=>calls.filter(call=>isSuccess(call.sql))};
}
const quarantined={status:'STOPPING',proof:'UNCONFIRMED'};

test('an UNCONFIRMED terminal with a completion charges the runtime since BEGIN once and keeps the quarantine',async()=>{
 for(const kind of EXITS){
  const w=await begun({runtimeUsed:1000});w.install(kind);w.at(START+40,70);
  assert.deepEqual(await w.complete(),quarantined,kind);
  // BEGIN persisted 1,000 ms. The monotonic floor (70 ms) is above the wall elapsed (40 ms), and it is charged as an
  // absolute total for the attempt's own job and lease token.
  assert.deepEqual(w.charges(),[1070],kind);assert.deepEqual(w.chargeKeys(),[[w.job.job_id,w.lease]],kind);
  assert.equal(w.row.runtime,1070,kind);
  // No cancel and no acknowledgement: the job stays STOPPING with its token and the handle stays owned.
  assert.deepEqual(w.events,[],kind);assert.equal(w.io.handles.size,1,kind);
  assert.deepEqual(w.logs.map(log=>[log.proof,log.reason]),[['UNCONFIRMED','STOP_UNCONFIRMED']],kind);
 }
});

test('an UNCONFIRMED terminal without a completion never charges',async()=>{
 for(const kind of EXITS){
  const w=await begun();w.install(kind);w.at(START+40,70);const before=w.calls.length;
  assert.deepEqual(await w.io.terminal({...w.request,onTerminalDiagnostic:w.onTerminalDiagnostic}),quarantined,kind);
  assert.deepEqual(w.charges(),[],kind);assert.equal(w.calls.length,before,kind);
  assert.deepEqual(w.events,[],kind);assert.equal(w.logs.length,1,kind);
 }
});

test('a failing charge keeps the UNCONFIRMED result and its STOPPING quarantine',async()=>{
 for(const kind of EXITS){
  const w=await begun({runtimeUsed:1000});w.install(kind);w.failure.charge=true;w.at(START+40,70);
  assert.deepEqual(await w.complete(),quarantined,kind);
  // One attempt, nothing persisted, no cancel or acknowledgement, and the diagnostic still reports UNCONFIRMED once.
  assert.equal(w.charges().length,1,kind);assert.equal(w.row.runtime,1000,kind);assert.deepEqual(w.events,[],kind);
  assert.deepEqual(w.logs.map(log=>log.proof),['UNCONFIRMED'],kind);
 }
});

test('a later charge on the same job and lease token raises the total to the latest elapsed and never doubles it',async()=>{
 const w=await begun({runtimeUsed:1000});w.install('settle UNCERTAIN');w.at(START+40,70);
 assert.deepEqual(await w.complete(),quarantined);assert.equal(w.row.runtime,1070);
 // A denied FINALIZE and the fallback charge on the same completion repeat the absolute total on a later reading.
 assert.deepEqual(await w.finalize({wall:START+90,mono:80,health:{ok:false}}),{kind:'DENIED',reason:'AUTHORITY'});
 assert.equal(await w.charge({wall:START+90,mono:80}),1090);
 // A later reading below an earlier one is an anomaly: the charge keeps the high-water elapsed instead of dropping.
 assert.equal(await w.charge({wall:START+10,mono:5}),1090);
 // Elapsed since BEGIN is 90 ms. Adding the charges instead of taking the maximum would store far more than 1,090.
 assert.deepEqual(w.charges(),[1070,1090,1090,1090]);assert.equal(w.row.runtime,1000+90);
 assert.ok(w.chargeKeys().every(([jobId,lease])=>jobId===w.job.job_id&&lease===w.lease));
 // The same charge after the token cleared (a committed success) matches no row.
 w.row.token=null;assert.equal(await w.charge({wall:START+95,mono:95}),1095);assert.equal(w.row.runtime,1090);
});

test('an absurd monotonic reading is a clock anomaly: the total stays safe, charges still happen and nothing enrolls',async()=>{
 const w=await begun({runtimeUsed:1000});
 assert.equal(await w.charge({wall:START+40,mono:70}),1070);
 // Finite, but the elapsed total is not a safe integer. The term is dropped and the 70 ms already charged stays.
 assert.equal(await w.charge({wall:START+50,mono:1e300}),1070);
 // The monotonic high-water mark is sticky: the same absurd mark on the next reading still charges the safe total.
 assert.equal(await w.charge({wall:START+90,mono:1e300}),1070);
 // The anomaly is sticky too, and no reading went backwards: only the guard stops enrollment. The denial still charges.
 assert.deepEqual(await w.finalize({wall:START+100,mono:1e300}),{kind:'DENIED',reason:'AUTHORITY'});
 assert.deepEqual(w.receipts(),[]);assert.deepEqual(w.successes(),[]);
 // A later sane reading is below the sticky mark: the same safe charge again, never a lower or an unsafe one.
 assert.equal(await w.charge({wall:START+110,mono:90}),1070);
 assert.deepEqual(w.charges(),[1070,1070,1070,1070,1070]);assert.equal(w.row.runtime,1070);
 assert.ok(w.charges().every(Number.isSafeInteger));
});

test('an absurd monotonic reading at FINALIZE denies, charges the safe total and never skips the charge',async()=>{
 const w=await begun({runtimeUsed:250});
 assert.deepEqual(await w.finalize({wall:START+40,mono:Number.MAX_VALUE}),{kind:'DENIED',reason:'AUTHORITY'});
 // Nothing was charged before, so the kept elapsed is zero: the persisted total is the runtime BEGIN stopped at.
 assert.deepEqual(w.charges(),[250]);assert.deepEqual(w.receipts(),[]);assert.deepEqual(w.successes(),[]);
 assert.equal(await w.charge({wall:START+60,mono:Number.MAX_VALUE}),250);
});

test('the monotonic guard is exact: a runtime total of 2^53-1 is safe and one more is dropped',async()=>{
 const w=await begun({runtimeUsed:1000}),top=Number.MAX_SAFE_INTEGER;
 assert.equal(await w.charge({wall:START+40,mono:top-1000}),top);
 assert.equal(await w.charge({wall:START+41,mono:top-999}),top);
 assert.deepEqual(w.charges(),[top,top]);assert.equal(w.row.runtime,top);
});
