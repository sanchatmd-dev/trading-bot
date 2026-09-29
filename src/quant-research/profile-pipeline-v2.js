import {canonical,hash,fail} from '../pine-bridge/source.js';
import {validateFoundationRequestV2} from './foundation-contract-v2.js';
import {validateProfileResultV2} from './profile-contract-v2.js';
import {deriveClosedMetadataV2,streamClosedProfileRowsV2,verifyEnrollmentBindingV2} from './data-profile-v2.js';

/** Managed worker preparation. The caller must hold the global resource lease
 * and fence publication. This function alone never grants evaluator admission.
 */
export async function buildProfileV2({contract,policy,rawStore,researchStore,signal,now=Date.now}) {
  const frozen=validateFoundationRequestV2(contract,{policy});
  const raw=frozen.dataset,model=frozen.profile.execution_model;
  const current=typeof now==='function'?now():now;
  if(!Number.isSafeInteger(current)||current<raw.metadata.end_time)throw fail('PROFILE_OPEN_BAR');
  if(signal?.aborted)throw fail('DATASET_CANCELLED');
  const references=await researchStore.publishStream(deriveClosedMetadataV2(raw),
    streamClosedProfileRowsV2({rawReference:raw,rawStore,model,signal}),
    {model,signal,chunkBars:frozen.budget.chunk_bars});
  const evidence={source_hash:frozen.profile.source_hash,
    effective_inputs_hash:frozen.profile.effective_inputs_hash,
    evaluator_hash:frozen.capacity.scope.evaluator_hash,
    execution_model_hash:hash(canonical(model)),metadata_hash:frozen.profile.metadata_hash,
    raw_provenance_sha256:frozen.profile.raw_provenance_sha256,seed_bars:500};
  const binding=await verifyEnrollmentBindingV2({rawReference:raw,researchReference:references,
    evidence,rawStore,researchStore,signal});
  if(signal?.aborted)throw fail('DATASET_CANCELLED');
  return validateProfileResultV2(frozen,{version:'research-profile-enrollment-v2',raw,
    references,binding,data_profile_verified:true,evaluator_admission:false,
    acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']},{policy});
}
