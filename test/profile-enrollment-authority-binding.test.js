import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {profileEnrollmentEvidenceFixture} from './helpers/profile-enrollment-evidence-fixture.js';
import {createProfileEnrollmentTicketAuthority} from '../src/postgres/quant-profile-enrollment-ticket.js';
import {prepareEnrollmentAttempt,beginProfileCompletionLocked} from '../src/postgres/quant-profile-enrollment.js';
import {QuantIoRuntime} from '../src/postgres/quant-io-runtime.js';
import {QuantProfileRuntimeV2} from '../src/postgres/quant-profile-runtime-v2.js';

const sha=letter=>letter.repeat(64);
function world(){
 const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const metadata=deriveClosedMetadataV2(contract.dataset);
 const references={raw:{dataset_id:sha('5'),sha256:sha('5'),metadata},sidecar:{version:'research-atr14-chunked-v2',sha256:sha('6'),bar_count:metadata.total_bars,first_time:metadata.start_time,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'}};
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:contract.dataset.sha256,closed_dataset_sha256:references.raw.sha256,atr14_sha256:references.sidecar.sha256,first_closed_time:metadata.start_time,bar_count:metadata.total_bars,evidence:{source_hash:contract.profile.source_hash,effective_inputs_hash:contract.profile.effective_inputs_hash,evaluator_hash:contract.capacity.scope.evaluator_hash,execution_model_hash:hash(canonical(contract.profile.execution_model)),metadata_hash:contract.profile.metadata_hash,raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500},data_profile_verified:true,evaluator_admission:false};
 const result={version:'research-profile-enrollment-v2',raw:structuredClone(contract.dataset),references,binding:{...binding,binding_sha256:hash(canonical(binding))},data_profile_verified:true,evaluator_admission:false,acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
 const evidence=profileEnrollmentEvidenceFixture({contract,result,policy,now:1700000000000}),leaseToken=evidence.launch.lease_token;
 const job={...evidence.job,status:'RUNNING',lease_token:leaseToken,lease_until:1030000,deadline_at:1900000,
  run_started_at:1000000,runtime_used_ms:0};
 const operationId=evidence.launch.operation_id;
 const frame={jobId:job.job_id,operationId,payloadHash:evidence.launch.payload_hash,resultHash:hash(canonical(result)),result};
 const flags={transaction:false},epoch={},stats={transactions:0,queries:0};
 const authority=()=>Object.freeze({enabled:true,assertSchemaLocked:async()=>{},authorizeLocked:async()=>({ok:true}),
  tickets:createProfileEnrollmentTicketAuthority({readExecutableHash:async()=>contract.engine_hash,
   releaseGuard:()=>epoch,isTransaction:()=>flags.transaction})});
 // The runtime database is unavailable: any accounting or readback work would show up in the counters.
 const db={get isTransaction(){return flags.transaction;},
  transaction:async()=>{stats.transactions++;throw Error('database unavailable');},
  query:async()=>{stats.queries++;throw Error('database unavailable');}};
 const ledger={open(){},db,policy,devices:[{device_id:'8:0',device_inode:100}]};
 const parts={db,ledger,scheduler:{cancel(){throw Error('not expected');}},launcher:{spawnPrepared(){throw Error('not expected');}},
  clock:()=>1000000};
 const txDb={get isTransaction(){return true;},query:async()=>({rowCount:1,rows:[{}]})};
 async function complete(attempt){
  flags.transaction=true;
  try{return await beginProfileCompletionLocked({db:txDb,job,attempt,clock:()=>1000000,monotonic:()=>0});}
  finally{flags.transaction=false;}
 }
 return {policy,job,frame,leaseToken,operationId,flags,stats,authority,parts,complete,
  request:completion=>({jobId:job.job_id,leaseToken,operationId,completion})};
}

test('I/O runtime prepares attempts only with its construction-bound enrollment authority',async()=>{
 const w=world(),trusted=w.authority(),other=w.authority();
 const io=new QuantIoRuntime({...w.parts,enrollment:trusted}),foreign=new QuantIoRuntime({...w.parts,enrollment:other});
 const attempt=await io.prepareEnrollment({job:w.job,frame:w.frame,leaseToken:w.leaseToken,operationId:w.operationId});
 const completion=await w.complete(attempt);
 // Bound authority passes the identity check; no handle and no recorded proof leave the outcome unconfirmed.
 assert.deepEqual(await io.completeProfile(w.request(completion)),{status:'STOPPING',proof:'UNCONFIRMED'});
 // Another runtime refuses it before any terminal or accounting work.
 await assert.rejects(foreign.completeProfile(w.request(completion)),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
 assert.equal(foreign.terminals.size,0);
 assert.deepEqual(await foreign.settleMeasured({...w.request(completion),handle:null,bound:null,frozen:null,
  evidence:null,postExit:null,stopDigest:null}),{kind:'UNCERTAIN'});
 assert.deepEqual(w.stats,{transactions:0,queries:0});
});

test('a caller-supplied enrollment authority never reaches terminal publication',async()=>{
 const w=world(),trusted=w.authority();
 const io=new QuantIoRuntime({...w.parts,enrollment:trusted});
 // Same functions, different object: a per-attempt authority chosen by the caller is not the bound one.
 const forged=Object.freeze({...trusted});
 const attempt=await prepareEnrollmentAttempt({job:w.job,frame:w.frame,leaseToken:w.leaseToken,
  operationId:w.operationId,policy:w.policy,enrollment:forged});
 const completion=await w.complete(attempt);
 await assert.rejects(io.completeProfile(w.request(completion)),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
 assert.equal(io.terminals.size,0);assert.deepEqual(w.stats,{transactions:0,queries:0});
});

test('I/O runtime without a valid bound authority cannot prepare or complete enrollment',async()=>{
 const w=world(),trusted=w.authority();
 assert.throws(()=>new QuantIoRuntime({...w.parts,enrollment:{enabled:true}}),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
 assert.throws(()=>new QuantIoRuntime({...w.parts,enrollment:'trusted'}),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
 const none=new QuantIoRuntime(w.parts);
 await assert.rejects(none.prepareEnrollment({job:w.job,frame:w.frame,leaseToken:w.leaseToken,operationId:w.operationId}),
  {code:'PROFILE_ENROLLMENT_DENIED'});
 const completion=await w.complete(await prepareEnrollmentAttempt({job:w.job,frame:w.frame,leaseToken:w.leaseToken,
  operationId:w.operationId,policy:w.policy,enrollment:trusted}));
 await assert.rejects(none.completeProfile(w.request(completion)),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
});

test('PROFILE V2 adapter hands its enrollment authority to the I/O runtime at construction',async()=>{
 const w=world(),trusted=w.authority(),root=path.resolve('enrollment-binding-root');
 const adapter=new QuantProfileRuntimeV2({...w.parts,storageBudget:{root,diskQuotaBytes:1,tempQuotaBytes:1,freeFloorBytes:0},
  authorizeRelease:async()=>({ok:true}),health:async()=>({ok:true}),enrollment:trusted});
 const attempt=await adapter.io.prepareEnrollment({job:w.job,frame:w.frame,leaseToken:w.leaseToken,operationId:w.operationId});
 assert.deepEqual(await adapter.io.completeProfile(w.request(await w.complete(attempt))),{status:'STOPPING',proof:'UNCONFIRMED'});
 const outside=await prepareEnrollmentAttempt({job:w.job,frame:w.frame,leaseToken:w.leaseToken,operationId:w.operationId,
  policy:w.policy,enrollment:w.authority()});
 await assert.rejects(adapter.io.completeProfile(w.request(await w.complete(outside))),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
});
