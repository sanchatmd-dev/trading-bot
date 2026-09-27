import {canonical, fail, hash, keys} from '../pine-bridge/source.js';

export const FOUNDATION_VERSION = 'quant-foundation-v1';
export const DATASET_VERSION = 'spot-dataset-v1';
export const FOUNDATION_LIMITS = Object.freeze({
  storageBars: 1_000_000, admittedBars: 10_000, chunkBars: 50_000,
  candidates: 100, evaluations: 125, runtimeMs: 900_000,
  outputBytes: 8 * 1024 * 1024, stateBytes: 1024 * 1024,
});
const minute = 60_000;
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
  keys(value, ['version','owner_id','bot_id','kind','dataset','engine_hash','snapshot_hash','budget']);
  if (value.version !== FOUNDATION_VERSION) throw fail('UNSUPPORTED_FOUNDATION_VERSION');
  id(value.owner_id); id(value.bot_id);
  if (!['PREFLIGHT','BACKTEST','OPTIMIZE','REPORT','BACKFILL'].includes(value.kind)) throw fail('INVALID_FOUNDATION_KIND');
  if (!sha(value.engine_hash) || !sha(value.snapshot_hash)) throw fail('INVALID_FOUNDATION_HASH');
  const dataset = validateDatasetReference(value.dataset);
  if (dataset.metadata.total_bars > FOUNDATION_LIMITS.admittedBars) throw fail('FOUNDATION_CAPABILITY_LIMIT');
  const budget = value.budget;
  keys(budget, ['candidates','max_evaluations','chunk_bars','max_runtime_ms','max_output_bytes','max_state_bytes']);
  const bounds = {
    candidates: FOUNDATION_LIMITS.candidates, max_evaluations: FOUNDATION_LIMITS.evaluations,
    chunk_bars: Math.min(FOUNDATION_LIMITS.chunkBars, dataset.metadata.total_bars),
    max_runtime_ms: FOUNDATION_LIMITS.runtimeMs, max_output_bytes: FOUNDATION_LIMITS.outputBytes,
    max_state_bytes: FOUNDATION_LIMITS.stateBytes,
  };
  for (const [key, max] of Object.entries(bounds)) integer(budget[key], 1, max, 'INVALID_FOUNDATION_BUDGET');
  if (budget.max_evaluations < budget.candidates) throw fail('INVALID_FOUNDATION_BUDGET');
  return JSON.parse(canonical({...value, dataset}));
}

export function foundationRequestHash(value) {
  return hash(canonical(validateFoundationRequest(value)));
}
