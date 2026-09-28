import {canonical, fail, hash, keys} from '../pine-bridge/source.js';
import {validateProfileSpec} from './profile-contract.js';

export const FOUNDATION_VERSION = 'quant-foundation-v1';
export const DATASET_VERSION = 'spot-dataset-v1';
export const FOUNDATION_LIMITS = Object.freeze({
  storageBars: 1_000_000, admittedBars: 10_000, chunkBars: 50_000,
  candidates: 100, evaluations: 125, runtimeMs: 900_000,
  outputBytes: 8 * 1024 * 1024, stateBytes: 1024 * 1024,
});
const minute = 60_000;
function backfillBars(range){
  keys(range,['broker','symbol','timeframe','start_time','end_time','warmup_bars','cutoff']);
  if(range.broker!=='binance-global'||range.symbol!=='BTCUSDT'||range.timeframe!=='1')throw fail('INGESTION_CAPABILITY_UNAVAILABLE');
  for(const key of ['start_time','end_time','cutoff'])integer(range[key],1,8_640_000_000_000_000,'INVALID_INGESTION_RANGE');
  integer(range.warmup_bars,0,5000,'INVALID_INGESTION_WARMUP');
  if(range.start_time%minute||range.end_time%minute||range.start_time>=range.end_time||range.end_time>range.cutoff||
    range.start_time-range.warmup_bars*minute<=0)throw fail('INVALID_INGESTION_RANGE');
  const total=(range.end_time-range.start_time)/minute+range.warmup_bars;
  if(total>FOUNDATION_LIMITS.admittedBars)throw fail('FOUNDATION_CAPABILITY_LIMIT');
  return total;
}
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(code);
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw fail('INVALID_FOUNDATION_ID');
}

// Storage capacity and evaluator admission are deliberately distinct contracts.
export function validateDatasetMetadata(value) {
  keys(value, ['version','venue','market','symbol','timeframe','start_time','end_time','warmup_bars','total_bars','cutoff','source']);
  if (value.version !== DATASET_VERSION || value.venue !== 'binance-global' || value.market !== 'SPOT' ||
      value.symbol !== 'BTCUSDT' || value.timeframe !== '1' || value.source !== 'binance-spot-klines-v1') throw fail('UNSUPPORTED_DATASET_PROFILE');
  for (const key of ['start_time','end_time','cutoff']) integer(value[key], 1, 8_640_000_000_000_000, 'INVALID_DATASET_TIME');
  integer(value.total_bars, 1, FOUNDATION_LIMITS.storageBars, 'INVALID_DATASET_BAR_COUNT');
  integer(value.warmup_bars, 0, value.total_bars - 1, 'INVALID_DATASET_WARMUP');
  if (value.start_time % minute || value.end_time % minute || value.end_time > value.cutoff ||
      value.end_time - value.start_time !== value.total_bars * minute) throw fail('INVALID_DATASET_INTERVAL');
  return JSON.parse(canonical(value));
}

export function validateDatasetReference(value) {
  keys(value, ['dataset_id','sha256','metadata']);
  if (!sha(value.dataset_id) || value.dataset_id !== value.sha256) throw fail('INVALID_DATASET_REFERENCE');
  return {dataset_id: value.dataset_id, sha256: value.sha256, metadata: validateDatasetMetadata(value.metadata)};
}

export function validateFoundationRequest(value) {
  const backfill=value?.kind==='BACKFILL';
  keys(value, backfill?['version','owner_id','bot_id','kind','range','engine_hash','snapshot_hash','budget']:
    ['version','owner_id','bot_id','kind','dataset','engine_hash','snapshot_hash','budget',...(value?.kind==='PROFILE'?['profile']:[])]);
  if (value.version !== FOUNDATION_VERSION) throw fail('UNSUPPORTED_FOUNDATION_VERSION');
  id(value.owner_id); id(value.bot_id);
  if (!['PREFLIGHT','BACKTEST','OPTIMIZE','REPORT','BACKFILL','PROFILE'].includes(value.kind)) throw fail('INVALID_FOUNDATION_KIND');
  if (!sha(value.engine_hash) || !sha(value.snapshot_hash)) throw fail('INVALID_FOUNDATION_HASH');
  const dataset = backfill?null:validateDatasetReference(value.dataset);
  if(value.kind==='PROFILE'){
    validateProfileSpec(value.profile,dataset);
    if(value.snapshot_hash!==value.profile.snapshot_hash)throw fail('INVALID_FOUNDATION_HASH');
  }
  const totalBars=backfill?backfillBars(value.range):dataset.metadata.total_bars;
  if (totalBars > FOUNDATION_LIMITS.admittedBars) throw fail('FOUNDATION_CAPABILITY_LIMIT');
  const budget = value.budget;
  keys(budget, ['candidates','max_evaluations','chunk_bars','max_runtime_ms','max_output_bytes','max_state_bytes']);
  const bounds = {
    candidates: FOUNDATION_LIMITS.candidates, max_evaluations: FOUNDATION_LIMITS.evaluations,
    chunk_bars: Math.min(FOUNDATION_LIMITS.chunkBars, totalBars),
    max_runtime_ms: FOUNDATION_LIMITS.runtimeMs, max_output_bytes: FOUNDATION_LIMITS.outputBytes,
    max_state_bytes: FOUNDATION_LIMITS.stateBytes,
  };
  for (const [key, max] of Object.entries(bounds)) integer(budget[key], 1, max, 'INVALID_FOUNDATION_BUDGET');
  if (budget.max_evaluations < budget.candidates) throw fail('INVALID_FOUNDATION_BUDGET');
  if(backfill && value.snapshot_hash!==hash(canonical(value.range)))throw fail('INVALID_FOUNDATION_HASH');
  return JSON.parse(canonical(backfill?{...value,range:value.range}:{...value,dataset}));
}

export function foundationTotalBars(contract){
  return contract.kind==='BACKFILL'?backfillBars(contract.range):contract.dataset.metadata.total_bars;
}

export function validateBackfillState(contract,nextBar,state){
  if(contract.kind!=='BACKFILL'||!state||typeof state!=='object')throw fail('BACKFILL_CHECKPOINT_INVALID');
  keys(state,['version','pages']);
  if(state.version!=='backfill-pages-v1'||!Array.isArray(state.pages)||state.pages.length<1||state.pages.length>10)throw fail('BACKFILL_CHECKPOINT_INVALID');
  const first=contract.range.start_time-contract.range.warmup_bars*minute;
  let offset=0;
  for(const page of state.pages){
    keys(page,['reference','provenance']);
    const ref=validateDatasetReference(page.reference),meta=ref.metadata,provenance=page.provenance;
    if(meta.start_time!==first+offset*minute||meta.warmup_bars!==0||meta.total_bars>1000||
      meta.cutoff!==contract.range.cutoff||meta.end_time>contract.range.end_time)throw fail('BACKFILL_CHECKPOINT_INVALID');
    keys(provenance,['page','start_time','end_time','count','sha256','retrieved_at','source','timestamp_semantics']);
    if(provenance.page!==state.pages.indexOf(page)||provenance.start_time!==meta.start_time||
      provenance.end_time!==meta.end_time||provenance.count!==meta.total_bars||
      typeof provenance.sha256!=='string'||!/^[a-f0-9]{64}$/.test(provenance.sha256)||
      !Number.isSafeInteger(provenance.retrieved_at)||provenance.retrieved_at<0||
      provenance.source!=='https://api.binance.com/api/v3/klines'||
      provenance.timestamp_semantics!=='UTC open time; end exclusive')throw fail('BACKFILL_CHECKPOINT_INVALID');
    offset+=meta.total_bars;
  }
  if(offset!==nextBar||nextBar>foundationTotalBars(contract))throw fail('BACKFILL_CHECKPOINT_INVALID');
  return state;
}

export function validateBackfillResult(contract,checkpoint,result){
  const total=foundationTotalBars(contract);
  if(!checkpoint||checkpoint.next_bar!==total)throw fail('BACKFILL_RESULT_INVALID');
  const state=validateBackfillState(contract,total,checkpoint.state);
  keys(result,['version','dataset','provenance','raw_only','verified_execution_profile']);
  const dataset=validateDatasetReference(result.dataset),metadata=dataset.metadata;
  if(result.version!=='spot-ingestion-v1'||result.raw_only!==true||result.verified_execution_profile!==false||
    metadata.start_time!==contract.range.start_time-contract.range.warmup_bars*minute||
    metadata.end_time!==contract.range.end_time||metadata.warmup_bars!==contract.range.warmup_bars||
    metadata.total_bars!==total||metadata.cutoff!==contract.range.cutoff)throw fail('BACKFILL_RESULT_INVALID');
  keys(result.provenance,['range','pages']);
  const range=result.provenance.range;
  keys(range,['version','evaluation_start','evaluation_end','evaluation_bars','warmup_bars','total_bars',
    'page_count','timestamp_semantics','metadata']);
  if(canonical(result.provenance.pages)!==canonical(state.pages.map(page=>page.provenance))||
    range.version!=='spot-ingestion-v1'||range.evaluation_start!==contract.range.start_time||
    range.evaluation_end!==contract.range.end_time||
    range.evaluation_bars!==(contract.range.end_time-contract.range.start_time)/minute||
    range.warmup_bars!==contract.range.warmup_bars||range.total_bars!==total||
    range.page_count!==Math.ceil(total/1000)||
    range.timestamp_semantics!=='UTC open time; end exclusive'||
    canonical(range.metadata)!==canonical(metadata))throw fail('BACKFILL_RESULT_INVALID');
  return result;
}

export function foundationRequestHash(value) {
  return hash(canonical(validateFoundationRequest(value)));
}
