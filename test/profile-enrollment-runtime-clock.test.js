import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {profileEnrollmentEvidenceFixture} from './helpers/profile-enrollment-evidence-fixture.js';
import {createProfileEnrollmentTicketAuthority} from '../src/postgres/quant-profile-enrollment-ticket.js';
import {prepareEnrollmentAttempt,beginProfileCompletionLocked} from '../src/postgres/quant-profile-enrollment.js';
const sha=letter=>letter.repeat(64);
async function fixture({runtimeUsed=899998,elapsed=2}={}){
 const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const metadata=deriveClosedMetadataV2(contract.dataset);
 const references={raw:{dataset_id:sha('5'),sha256:sha('5'),metadata},sidecar:{version:'research-atr14-chunked-v2',sha256:sha('6'),bar_count:metadata.total_bars,first_time:metadata.start_time,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'}};
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:contract.dataset.sha256,closed_dataset_sha256:references.raw.sha256,atr14_sha256:references.sidecar.sha256,first_closed_time:metadata.start_time,bar_count:metadata.total_bars,evidence:{source_hash:contract.profile.source_hash,effective_inputs_hash:contract.profile.effective_inputs_hash,evaluator_hash:contract.capacity.scope.evaluator_hash,execution_model_hash:hash(canonical(contract.profile.execution_model)),metadata_hash:contract.profile.metadata_hash,raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500},data_profile_verified:true,evaluator_admission:false};
 const result={version:'research-profile-enrollment-v2',raw:structuredClone(contract.dataset),references,binding:{...binding,binding_sha256:hash(canonical(binding))},data_profile_verified:true,evaluator_admission:false,acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
 const evidence=profileEnrollmentEvidenceFixture({contract,result,policy,now:1700000000000});
 const now=Number.MAX_SAFE_INTEGER-1000,lease=evidence.launch.lease_token;
 const job={...evidence.job,status:'RUNNING',lease_token:lease,lease_until:now+50,deadline_at:now+100,run_started_at:now-elapsed,runtime_used_ms:runtimeUsed};
 const state={transaction:false,updates:[]},epoch={};
 const tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:async()=>contract.engine_hash,releaseGuard:()=>epoch,isTransaction:()=>state.transaction});
 const enrollment={enabled:true,tickets,assertSchemaLocked:async()=>{},authorizeLocked:async()=>({ok:true})};
 const frame={jobId:job.job_id,operationId:evidence.launch.operation_id,payloadHash:evidence.launch.payload_hash,resultHash:hash(canonical(result)),result};
 const attempt=await prepareEnrollmentAttempt({job,frame,leaseToken:lease,operationId:frame.operationId,policy,enrollment});
 const db={get isTransaction(){return state.transaction;},query:async(sql,parameters)=>{state.updates.push({sql,parameters});return {rowCount:1,rows:[{...job,status:'STOPPING'}]};}};
 state.transaction=true;return {db,job,attempt,state,clock:()=>now,monotonic:()=>0};
}
test('BEGIN rejects exact runtime exhaustion even when safe absolute clock addition would round down',async()=>{
 const f=await fixture();await assert.rejects(beginProfileCompletionLocked(f),{code:'PROFILE_ENROLLMENT_DENIED'});
 assert.equal(f.state.updates.length,0);
});
test('BEGIN persists exact elapsed runtime below boundary without absolute-clock rounding',async()=>{
 const f=await fixture({runtimeUsed:899997});const completion=await beginProfileCompletionLocked(f);
 assert.equal(completion.jobId,f.job.job_id);assert.equal(f.state.updates.length,1);
 assert.equal(f.state.updates[0].parameters[2],899999);
});
test('BEGIN refuses backward wall clock before any publication transition',async()=>{
 const f=await fixture({runtimeUsed:0,elapsed:-1});await assert.rejects(beginProfileCompletionLocked(f),{code:'PROFILE_ENROLLMENT_DENIED'});
 assert.equal(f.state.updates.length,0);
});
