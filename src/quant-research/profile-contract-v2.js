import {canonical,fail,hash} from '../pine-bridge/source.js';
import {D,exact} from '../money.js';
import {validateDatasetReference} from './foundation-contract.js';
import {deriveClosedMetadataV2} from './data-profile-v2.js';
import {validateFoundationRequestV2,strictJsonV2,fieldsV2,frozenV2,PROFILE_ENROLLMENT_MODE} from './foundation-contract-v2.js';
import {validateCapacityPolicy,capacityPolicyHash} from './capacity-contract.js';
import {validateIoBudgetLedgerState} from './io-budget-ledger.js';

export {PROFILE_ENROLLMENT_MODE};
export const PROFILE_ENROLLMENT_RECEIPT_VERSION='profile-enrollment-receipt-v1';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=code=>{throw fail(code);};

function decimal(value,positive){
 try{exact(value);return positive?D(value).gt(0):D(value).gte(0);}
 catch{return false;}
}

export function validateProfileSpecV2(profile,rawReference){
 strictJsonV2(profile);
 fieldsV2(profile,['raw_job_id','deployment_id','source_hash','effective_inputs_hash',
  'execution_model','metadata_hash','raw_provenance_sha256','seed_bars','snapshot_hash']);
 if(typeof profile.raw_job_id!=='string'||!/^[a-f0-9-]{36}$/.test(profile.raw_job_id)||
    typeof profile.deployment_id!=='string'||!/^[A-Za-z0-9-]{8,128}$/.test(profile.deployment_id)||
    !sha(profile.source_hash)||!sha(profile.effective_inputs_hash)||!sha(profile.metadata_hash)||
    !sha(profile.raw_provenance_sha256)||!sha(profile.snapshot_hash)||profile.seed_bars!==500)
  invalid('PROFILE_SPEC_INVALID');
 const model=profile.execution_model;
 fieldsV2(model,['version','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','data_profile']);
 if(model.version!=='paper-close-v1'||model.data_profile!=='closed-ohlcv-atr14-v1'||
    !['price_tick','quantity_step','risk_percent'].every(name=>decimal(model[name],true))||
    !['fee_bps','slippage_bps'].every(name=>decimal(model[name],false)))
  invalid('PROFILE_MODEL_UNSUPPORTED');
 const raw=validateDatasetReference(rawReference).metadata;
 if(raw.total_bars<515||raw.total_bars>1000000||raw.warmup_bars<500||
    raw.start_time+500*60000>=raw.end_time)invalid('PROFILE_RAW_UNSUPPORTED');
 return frozenV2(profile);
}

export function validateProfileResultV2(contract,result,{policy}={}){
 const approved=validateFoundationRequestV2(contract,{policy});
 strictJsonV2(result);
 fieldsV2(result,['version','raw','references','binding','data_profile_verified','evaluator_admission','acceptance_blockers']);
 if(result.version!=='research-profile-enrollment-v2'||result.data_profile_verified!==true||
    result.evaluator_admission!==false||!Array.isArray(result.acceptance_blockers)||
    result.acceptance_blockers.length<2||result.acceptance_blockers.length>16||
    new Set(result.acceptance_blockers).size!==result.acceptance_blockers.length||
    result.acceptance_blockers.some(value=>typeof value!=='string'||!/^[A-Z][A-Z0-9_]{1,63}$/.test(value))||
    !result.acceptance_blockers.includes('EVALUATOR_PARITY_REQUIRED')||
    !result.acceptance_blockers.includes('SOURCE_SETTINGS_CAPABILITY_REQUIRED')||
    canonical(result.raw)!==canonical(approved.dataset))invalid('PROFILE_RESULT_INVALID');
 fieldsV2(result.references,['raw','sidecar']);
 const research=validateDatasetReference(result.references.raw);
 const expected=deriveClosedMetadataV2(approved.dataset);
 if(canonical(research.metadata)!==canonical(expected))invalid('PROFILE_RESULT_INVALID');
 const sidecar=result.references.sidecar;
 fieldsV2(sidecar,['version','sha256','bar_count','first_time','profile','price_tick','quantity_step']);
 if(sidecar.version!=='research-atr14-chunked-v2'||!sha(sidecar.sha256)||
    sidecar.bar_count!==expected.total_bars||sidecar.first_time!==expected.start_time||
    sidecar.profile!=='closed-ohlcv-atr14-v1'||
    typeof sidecar.price_tick!=='string'||typeof sidecar.quantity_step!=='string'||
    String(sidecar.price_tick)!==String(approved.profile.execution_model.price_tick)||
    String(sidecar.quantity_step)!==String(approved.profile.execution_model.quantity_step))
  invalid('PROFILE_RESULT_INVALID');
 const binding=result.binding;
 fieldsV2(binding,['version','raw_dataset_sha256','closed_dataset_sha256','atr14_sha256',
  'first_closed_time','bar_count','evidence','data_profile_verified','evaluator_admission','binding_sha256']);
 const {binding_sha256,...payload}=binding;
 fieldsV2(binding.evidence,['source_hash','effective_inputs_hash','evaluator_hash',
  'execution_model_hash','metadata_hash','raw_provenance_sha256','seed_bars']);
 const evidence=binding.evidence,profile=approved.profile;
 if(binding.version!=='research-enrollment-binding-v2'||!sha(binding_sha256)||
    binding_sha256!==hash(canonical(payload))||binding.raw_dataset_sha256!==approved.dataset.sha256||
    binding.closed_dataset_sha256!==research.sha256||binding.atr14_sha256!==sidecar.sha256||
    binding.first_closed_time!==expected.start_time||binding.bar_count!==expected.total_bars||
    evidence.source_hash!==profile.source_hash||evidence.effective_inputs_hash!==profile.effective_inputs_hash||
    evidence.evaluator_hash!==approved.capacity.scope.evaluator_hash||
    evidence.execution_model_hash!==hash(canonical(profile.execution_model))||
    evidence.metadata_hash!==profile.metadata_hash||
    evidence.raw_provenance_sha256!==profile.raw_provenance_sha256||evidence.seed_bars!==500||
    binding.data_profile_verified!==true||binding.evaluator_admission!==false)
  invalid('PROFILE_RESULT_INVALID');
 return frozenV2(result);
}

const receiptFields=['version','job_id','operation_id','lease_token','contract_hash','payload_hash',
 'result_hash','policy_hash','policy','stop_proof_sha256','readback_proof_sha256','completed_at','receipt_hash'];
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const receiptInvalid=()=>invalid('PROFILE_ENROLLMENT_RECEIPT_INVALID');

/** Historical evidence validation. New admission must also compare the current reviewed policy.
 * This proves exact persisted relationships, including settled charges, rather than hashes alone.
 */
export function validateProfileEnrollmentReceipt({job,receipt,launch,ledger}){
 try{
  strictJsonV2(receipt);fieldsV2(receipt,receiptFields);
  strictJsonV2(job);strictJsonV2(launch);strictJsonV2(ledger);
  if(receipt.version!==PROFILE_ENROLLMENT_RECEIPT_VERSION||!uuid(receipt.job_id)||!uuid(receipt.lease_token)||
     typeof receipt.operation_id!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(receipt.operation_id)||
     !Number.isSafeInteger(receipt.completed_at)||receipt.completed_at<0||
     !['contract_hash','payload_hash','result_hash','policy_hash','stop_proof_sha256',
       'readback_proof_sha256','receipt_hash'].every(name=>sha(receipt[name])))receiptInvalid();
  const {receipt_hash,...payload}=receipt;
  if(hash(canonical(payload))!==receipt_hash)receiptInvalid();
  const policy=validateCapacityPolicy(receipt.policy);
  if(canonical(policy)!==canonical(receipt.policy)||capacityPolicyHash(policy)!==receipt.policy_hash||
     job?.job_id!==receipt.job_id||job.status!=='SUCCEEDED'||job.owner_id!==job.contract?.owner_id||
     job.contract?.completion_mode!==PROFILE_ENROLLMENT_MODE||job.checkpoint!==null||job.next_bar!==0||
     job.lease_token!==null||job.lease_until!==null||job.run_started_at!==null||job.stop_reason!==null||
     job.contract_hash!==receipt.contract_hash||hash(canonical(job.contract))!==receipt.contract_hash||
     job.contract.capacity.policy_hash!==receipt.policy_hash||hash(canonical(job.result))!==receipt.result_hash)
   receiptInvalid();
  validateProfileResultV2(job.contract,job.result,{policy});
  if(launch?.job_id!==receipt.job_id||launch.operation_id!==receipt.operation_id||
     launch.lease_token!==receipt.lease_token||launch.payload_hash!==receipt.payload_hash||
     launch.state!=='STOP_PROVEN'||ledger?.job_id!==receipt.job_id||
     ledger.policy_hash!==receipt.policy_hash||ledger.lease_token!==receipt.lease_token||
     ledger.state_hash!==hash(canonical(ledger.state))||ledger.revision!==ledger.state?.revision)
   receiptInvalid();
  const state=validateIoBudgetLedgerState(ledger.state);
  if(state.job_id!==receipt.job_id||state.policy_hash!==receipt.policy_hash||state.lease_token!==receipt.lease_token||
     state.operations.some(operation=>operation.status!=='SETTLED'))receiptInvalid();
  const operation=state.operations.find(value=>value.operation_id===receipt.operation_id);
  if(!operation||operation.lease_token!==receipt.lease_token||
     launch.unit_name!==operation.cgroup_id||launch.unit_name!==
      'robot-quant-'+hash(canonical({jobId:receipt.job_id,operationId:receipt.operation_id}))+'.service'||
     operation.terminal_proof.stop_proof_sha256!==receipt.stop_proof_sha256||
     operation.terminal_proof.readback_proof_sha256!==receipt.readback_proof_sha256)receiptInvalid();
  const limits=state.limits;
  for(const direction of ['read','write']){
   if(limits[direction+'_bytes']!==job.contract.capacity.io[direction+'_bytes']||
      limits['overshoot_'+direction+'_bytes']!==job.contract.capacity.io['overshoot_'+direction+'_bytes']||
      limits['cleanup_'+direction+'_bytes']!==job.contract.capacity.io['cleanup_'+direction+'_bytes'])receiptInvalid();
  }
  return frozenV2(receipt);
 }catch{receiptInvalid();}
}

/** Build evidence only. The caller owns measured settlement and the atomic success transaction. */
export function buildProfileEnrollmentReceipt({job,policy,launch,ledger,completed_at}){
 try{
  const snapshot=validateCapacityPolicy(policy);
  const state=validateIoBudgetLedgerState(ledger.state);
  const operation=state.operations.find(value=>value.operation_id===launch.operation_id);
  if(operation?.status!=='SETTLED')receiptInvalid();
  const payload={version:PROFILE_ENROLLMENT_RECEIPT_VERSION,job_id:job.job_id,
   operation_id:launch.operation_id,lease_token:launch.lease_token,contract_hash:job.contract_hash,
   payload_hash:launch.payload_hash,result_hash:hash(canonical(job.result)),policy_hash:capacityPolicyHash(snapshot),
   policy:snapshot,stop_proof_sha256:operation.terminal_proof.stop_proof_sha256,
   readback_proof_sha256:operation.terminal_proof.readback_proof_sha256,completed_at};
  return validateProfileEnrollmentReceipt({job,launch,ledger,receipt:{...payload,receipt_hash:hash(canonical(payload))}});
 }catch{receiptInvalid();}
}
