import {canonical,fail,hash} from '../pine-bridge/source.js';
import {validateFoundationRequest} from './foundation-contract.js';
import {strictJsonV2,fieldsV2,frozenV2} from './foundation-contract-v2.js';

const invalid=()=>{throw fail('INVALID_PREFLIGHT_CONTRACT');};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const minute=60000;
const snapshotFields=['version','source_hash','effective_inputs_hash','bridge_hash',
  'policy_hash','capital_hash','initial_state_hash','execution_model_hash',
  'venue_metadata_hash','execution_model_version','signal','development'];

// This validates a frozen plan only. Resolving ownership, referenced bytes,
// evaluator parity and scheduler admission remains the caller's responsibility.
export function validateHistoricalPreflightRequest(value){
  strictJsonV2(value);
  fieldsV2(value,['version','foundation','snapshot']);
  if(value.version!=='historical-preflight-v1')invalid();
  const foundation=validateFoundationRequest(value.foundation);
  if(foundation.kind!=='PREFLIGHT'||foundation.budget.candidates!==1||
     foundation.budget.max_evaluations!==1)invalid();
  const snapshot=value.snapshot;
  fieldsV2(snapshot,snapshotFields);
  if(snapshot.version!=='pf2-snapshot-v1'||
     snapshotFields.filter(name=>name.endsWith('_hash')).some(name=>!sha(snapshot[name])))invalid();
  // Existing V1 evidence cannot admit the newer cost-inclusive execution model.
  if(snapshot.execution_model_version!=='paper-close-v1')
    throw fail('PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED');
  fieldsV2(snapshot.signal,['mode','evaluator_hash','artifact_sha256']);
  const signal=snapshot.signal;
  if(!sha(signal.evaluator_hash)||
     !['EVALUATOR','BOUND_SIGNAL_CSV'].includes(signal.mode)||
     (signal.mode==='EVALUATOR'?signal.artifact_sha256!==null:!sha(signal.artifact_sha256)))invalid();
  const development=snapshot.development;
  fieldsV2(development,['start_time','end_time','holdout_start_time']);
  if(Object.values(development).some(time=>!Number.isSafeInteger(time)||time<=0||
      time>8640000000000000||time%minute)||
     development.start_time>=development.end_time||
     development.end_time>development.holdout_start_time)invalid();
  const metadata=foundation.dataset.metadata;
  // The entire artifact, including warm-up, must remain development-only.
  // Reject a full dataset containing holdout even if a caller promises to slice it.
  if(metadata.start_time<development.start_time||metadata.end_time>development.end_time)
    throw fail('PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED');
  if(foundation.snapshot_hash!==hash(canonical(snapshot)))invalid();
  return frozenV2({...value,foundation});
}

export function historicalPreflightHash(value){
  return hash(canonical(validateHistoricalPreflightRequest(value)));
}
