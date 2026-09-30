import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';
import {buildProfileEnrollmentReceipt,validateProfileEnrollmentReceipt} from '../src/quant-research/profile-contract-v2.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {profileEnrollmentEvidenceFixture} from './helpers/profile-enrollment-evidence-fixture.js';
const sha=letter=>letter.repeat(64);
function fixture(){
 const {policy,contract}=profileV2Fixture(2600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const metadata=deriveClosedMetadataV2(contract.dataset);
 const references={raw:{dataset_id:sha('5'),sha256:sha('5'),metadata},sidecar:{version:'research-atr14-chunked-v2',sha256:sha('6'),bar_count:metadata.total_bars,first_time:metadata.start_time,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'}};
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:contract.dataset.sha256,closed_dataset_sha256:references.raw.sha256,atr14_sha256:references.sidecar.sha256,first_closed_time:metadata.start_time,bar_count:metadata.total_bars,evidence:{source_hash:contract.profile.source_hash,effective_inputs_hash:contract.profile.effective_inputs_hash,evaluator_hash:contract.capacity.scope.evaluator_hash,execution_model_hash:hash(canonical(contract.profile.execution_model)),metadata_hash:contract.profile.metadata_hash,raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500},data_profile_verified:true,evaluator_admission:false};
 const result={version:'research-profile-enrollment-v2',raw:structuredClone(contract.dataset),references,binding:{...binding,binding_sha256:hash(canonical(binding))},data_profile_verified:true,evaluator_admission:false,acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
 return structuredClone(profileEnrollmentEvidenceFixture({contract,result,policy,now:1700000000000}));
}
const reseal=value=>{const {receipt_hash,...payload}=value.receipt;value.receipt.receipt_hash=hash(canonical(payload));value.ledger.state_hash=hash(canonical(value.ledger.state));};
const denied=value=>assert.throws(()=>validateProfileEnrollmentReceipt(value),{code:'PROFILE_ENROLLMENT_RECEIPT_INVALID'});
test('receipt builder validates complete settled proof, policy and detached canonical evidence',()=>{
 const value=fixture(),receipt=buildProfileEnrollmentReceipt({...value,policy:value.receipt.policy,completed_at:value.receipt.completed_at});
 assert.deepEqual(receipt,value.receipt);assert.notEqual(receipt,value.receipt);assert.equal(Object.isFrozen(receipt.policy.io),true);
 const reordered=structuredClone(value);reordered.receipt=Object.fromEntries(Object.entries(reordered.receipt).reverse());
 assert.deepEqual(validateProfileEnrollmentReceipt(reordered),receipt);
});
test('receipt rejects independently restamped binding, identity, proof and charge mutations',()=>{
 for(const mutate of [
 v=>v.job.owner_id='other-owner',v=>v.job.job_id='00000000-0000-4000-8000-000000000000',
 v=>v.job.status='CANCELLED',v=>v.job.checkpoint={},v=>v.job.next_bar=1,v=>v.job.lease_token=v.launch.lease_token,
 v=>delete v.job.contract.completion_mode,v=>v.job.result.evaluator_admission=true,
 v=>v.receipt.operation_id='another-operation',v=>v.receipt.payload_hash=sha('a'),v=>v.receipt.lease_token='00000000-0000-4000-8000-000000000000',
 v=>v.receipt.stop_proof_sha256=sha('a'),v=>v.receipt.readback_proof_sha256=sha('b'),v=>v.receipt.contract_hash=sha('a'),v=>v.receipt.result_hash=sha('b'),
 v=>v.receipt.policy_hash=sha('a'),v=>v.receipt.policy.scope.evaluator_hash=sha('f'),
 v=>v.launch.state='RESERVED',v=>v.launch.unit_name='wrong-service',v=>v.launch.job_id='other-job',v=>v.launch.operation_id='other-operation',
 v=>v.ledger.lease_token='other-token',v=>v.ledger.revision++,v=>v.ledger.state.charged.read_bytes++,
 v=>v.ledger.state.operations[0].charge.read_bytes++,v=>v.ledger.state.operations[0].terminal_proof.cgroup_inode++,
 v=>v.ledger.state.operations[0].status='CRASHED',v=>v.ledger.state.operations[0].terminal_proof.sample.devices[0].write_bytes++,
 ]){const value=fixture();mutate(value);reseal(value);denied(value);}
});
test('receipt rejects malformed shape, accessors, extra fields and missing proofs',()=>{
 for(const mutate of [v=>v.receipt.extra=true,v=>delete v.receipt.payload_hash,v=>v.receipt.completed_at=-1,v=>v.receipt.completed_at=Number.MAX_SAFE_INTEGER+1,v=>v.receipt.policy='{}',v=>v.ledger.state.operations=[]]){const value=fixture();mutate(value);denied(value);}
 const value=fixture();Object.defineProperty(value.receipt,'policy',{enumerable:true,get(){throw Error('getter ran');}});denied(value);
});
