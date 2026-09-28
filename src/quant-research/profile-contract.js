import {canonical, fail, hash, keys} from '../pine-bridge/source.js';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const minute=60000;

/** Pure PROFILE request validation. The foundation contract calls this without a reverse import. */
export function validateProfileSpec(profile,rawDataset){
  keys(profile,['raw_job_id','deployment_id','source_hash','effective_inputs_hash',
    'execution_model','metadata_hash','raw_provenance_sha256','seed_bars','snapshot_hash']);
  if(typeof profile.raw_job_id!=='string'||!/^[a-f0-9-]{36}$/.test(profile.raw_job_id)||
     typeof profile.deployment_id!=='string'||!/^[A-Za-z0-9-]{8,128}$/.test(profile.deployment_id)||
     !sha(profile.source_hash)||!sha(profile.effective_inputs_hash)||
     !sha(profile.metadata_hash)||!sha(profile.raw_provenance_sha256)||
     !sha(profile.snapshot_hash)||profile.seed_bars!==500)
    throw fail('PROFILE_SPEC_INVALID');
  const model=profile.execution_model;
  keys(model,['version','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','data_profile']);
  if(!['paper-close-v1','paper-close-cost-v2'].includes(model.version)||
     model.data_profile!=='closed-ohlcv-atr14-v1')throw fail('PROFILE_MODEL_UNSUPPORTED');
  for(const field of ['price_tick','quantity_step','risk_percent'])
    if(!Number.isFinite(Number(model[field]))||Number(model[field])<=0)throw fail('PROFILE_MODEL_UNSUPPORTED');
  for(const field of ['fee_bps','slippage_bps'])
    if(!Number.isFinite(Number(model[field]))||Number(model[field])<0)throw fail('PROFILE_MODEL_UNSUPPORTED');
  const meta=rawDataset?.metadata;
  if(meta?.source!=='binance-spot-klines-v1'||meta.venue!=='binance-global'||
     meta.market!=='SPOT'||meta.symbol!=='BTCUSDT'||meta.timeframe!=='1'||
     !Number.isSafeInteger(meta.total_bars)||meta.total_bars<515||meta.total_bars>10000||
     !Number.isSafeInteger(meta.warmup_bars)||meta.warmup_bars<500||
     meta.start_time+500*minute>=meta.end_time)throw fail('PROFILE_RAW_UNSUPPORTED');
  return JSON.parse(canonical(profile));
}

/** Terminal result is structurally bound to the frozen request. Content proof runs in worker. */
export function validateProfileResult(contract,result){
  if(contract?.kind!=='PROFILE')throw fail('PROFILE_RESULT_INVALID');
  const profile=validateProfileSpec(contract.profile,contract.dataset);
  keys(result,['version','raw','references','binding','data_profile_verified','evaluator_admission','acceptance_blockers']);
  if(result.version!=='research-profile-enrollment-v1'||result.data_profile_verified!==true||
     result.evaluator_admission!==false||!Array.isArray(result.acceptance_blockers)||
     !result.acceptance_blockers.includes('EVALUATOR_PARITY_REQUIRED')||
     canonical(result.raw)!==canonical(contract.dataset))throw fail('PROFILE_RESULT_INVALID');
  const research=result.references,derived=research?.raw?.metadata,source=contract.dataset.metadata;
  keys(research,['raw','sidecar']);
  keys(research.raw,['dataset_id','sha256','metadata']);
  keys(research.sidecar,['sha256','bar_count','first_time','profile','price_tick','quantity_step']);
  if(!sha(research.raw.sha256)||research.raw.dataset_id!==research.raw.sha256||
     !sha(research.sidecar.sha256)||derived?.start_time!==source.start_time+501*minute||
     derived.end_time!==source.end_time+minute||derived.cutoff!==source.cutoff+minute||
     derived.total_bars!==source.total_bars-500||derived.warmup_bars!==source.warmup_bars-500||
     derived.version!==source.version||derived.venue!==source.venue||
     derived.market!==source.market||derived.symbol!==source.symbol||
     derived.timeframe!==source.timeframe||derived.source!==source.source||
     research.sidecar.bar_count!==derived.total_bars||research.sidecar.first_time!==derived.start_time||
     research.sidecar.profile!=='closed-ohlcv-atr14-v1'||
     String(research.sidecar.price_tick)!==String(profile.execution_model.price_tick)||
     String(research.sidecar.quantity_step)!==String(profile.execution_model.quantity_step))
    throw fail('PROFILE_RESULT_INVALID');
  const binding=result.binding;
  keys(binding,['version','raw_dataset_sha256','closed_dataset_sha256','atr14_sha256',
    'first_closed_time','bar_count','evidence','data_profile_verified','evaluator_admission','binding_sha256']);
  const {binding_sha256,...payload}=binding;
  if(binding.version!=='research-enrollment-binding-v1'||!sha(binding_sha256)||
     binding_sha256!==hash(canonical(payload))||binding.raw_dataset_sha256!==contract.dataset.sha256||
     binding.closed_dataset_sha256!==research.raw.sha256||binding.atr14_sha256!==research.sidecar.sha256||
     binding.first_closed_time!==derived.start_time||binding.bar_count!==derived.total_bars||
     binding.evidence.source_hash!==profile.source_hash||
     binding.evidence.effective_inputs_hash!==profile.effective_inputs_hash||
     binding.evidence.evaluator_hash!==contract.engine_hash||
     binding.evidence.execution_model_hash!==hash(canonical(profile.execution_model))||
     binding.evidence.metadata_hash!==profile.metadata_hash||
     binding.evidence.raw_provenance_sha256!==profile.raw_provenance_sha256||
     binding.data_profile_verified!==true||binding.evaluator_admission!==false||
     binding.evidence.seed_bars!==500)
    throw fail('PROFILE_RESULT_INVALID');
  return result;
}
