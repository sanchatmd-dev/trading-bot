import {canonical,hash} from '../pine-bridge/source.js';
import {Money,D} from '../money.js';

/**
 * Shared constants and helpers of the pure QR-3 fair comparison module (docs/QR_3_FAIR_COMPARISON_CONTRACT.md, slice S1).
 * Nothing under src/comparison reads a database, file, network, clock or random source; every time is an input in epoch
 * milliseconds (UTC), every decimal is a string, and every result is a frozen plain value. Money and returns use decimal.js
 * through src/money.js; binary floating point never touches a money value, a return or a rank. Every *_exact field is the unrounded
 * value at the 80-digit precision of src/money.js (RC-C14); it is a decimal, not a rational, so it can still carry a last-digit rounding.
 */
export {canonical,hash,Money};
export const MINUTE=60000;
export const DAY=86400000;
export const MAX_TOTAL_BARS=10000;

export const QR3_VERSIONS=Object.freeze({context_std:'qr3-context-std-v1',context_actual:'qr3-context-actual-v1',valuation:'qr3-valuation-std-v1',
  grid:'qr3-grid-bar-close-v1',benchmark:'qr3-bh-close-same-cost-v1',objective:'qr3-obj-net-return-v1',
  uncertainty:'qr3-unc-paired-daily-block-bootstrap-v1',stored_view:'qr3-period-partition-aligned-v1',spec:'qr3-spec-v1',
  outcome:'qr3-outcome-v1',period:'qr3-period-v1',evidence:'qr3-evidence-v1'});
export const MODES=Object.freeze(['STANDARDIZED','ACTUAL_BOT']);
export const OUTCOMES=Object.freeze(['QUALIFIED_RANKING','QUALIFIED_TIE','NO_QUALIFIED_RESULT','INADEQUATE_EVIDENCE','ACTUAL_HISTORY_SIDE_BY_SIDE']);
export const PARTICIPANT_STATUSES=Object.freeze(['ELIGIBLE_QUALIFIED','DEVELOPMENT_EVIDENCE','INADEQUATE_SAMPLE','FILTERED_RISK','EXCLUDED_INCOMPATIBLE',
  'EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','NOT_EVALUATED','UNAVAILABLE']);
export const EVIDENCE_CLASSES=Object.freeze(['INDEPENDENT','DEVELOPMENT_EVIDENCE','NOT_EVALUATED']);
/** Section 9, every code the pure module can emit. Reused library codes are listed beside the new QR3_ ones. */
export const CODES=Object.freeze(Object.fromEntries([
  'INVALID_RUN_ID','DUPLICATE_RUN_ID','INVALID_FIELDS',
  'QR3_MODE_REQUIRED','QR3_MODE_MIX','QR3_PARTICIPANT_COUNT','QR3_MARKET_UNSUPPORTED','QR3_TIMEFRAME_UNSUPPORTED','QR3_PERIOD_INVALID',
  'QR3_PERIOD_IN_FUTURE','QR3_PERIOD_NOT_PARTITION_ALIGNED','QR3_RANGE_ADMISSION_REFUSED','QR3_OBJECTIVE_UNKNOWN','QR3_OBJECTIVE_NOT_ALLOWED',
  'QR3_FILTER_LOOSENED','QR3_SPEC_INCOMPLETE','QR3_SPEC_IMMUTABLE','QR3_COST_MODEL_UNSUPPORTED','QR3_FIXTURE_PARTICIPANT','QR3_DATASET_UNAVAILABLE',
  'QR3_DATASET_GAPPED','QR3_EXPOSURE_REGISTER_UNAVAILABLE',
  'QR3_CONTEXT_MISMATCH','QR3_COVERAGE_INCOMPLETE','QR3_INTEGRITY_FAILED','QR3_PARTICIPANT_UNAVAILABLE','QR3_FLOW_IN_WINDOW',
  'QR3_RESULT_PREDATES_SPEC','QR3_WINDOW_OVERLAPS_SEARCHED_DATA','QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT','QR3_WINDOW_PREVIOUSLY_EXPOSED',
  'QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY','QR3_NOT_QUALIFIED','QR3_NO_SCREENED_CANDIDATE','QR3_EPISODE_GATE_NOT_AVAILABLE',
  'QR3_SAMPLE_INADEQUATE','QR3_RISK_FILTER_FAILED','QR3_METRIC_UNAVAILABLE','METRIC_NOT_RECORDED','QR3_BENCHMARK_DATA_UNAVAILABLE',
  'HOLDOUT_EXPOSED_BY_COMPARISON',
  'RULES_VERSION_DIFFERS','UNCERTAINTY_METHOD_NOT_APPROVED','VALUATION_BASIS_UNCONFIRMED','REPRODUCTION_DISABLED','ENGINE_RELEASE_UNKNOWN',
  'SELECTION_WINDOW_EXPOSED','QL4C_VALIDATION_NOT_AVAILABLE'].map(code=>[code,code])));
export const CODE_PATTERN=/^[A-Z][A-Z0-9_]{1,63}$/;
/** Cost model versions QR-3 admits (mirrors ADMITTED_COST_MODELS of package-gates.js, PKG section 9: no V2 before V2 parity). */
export const ADMITTED_COST_MODELS=Object.freeze(['paper-close-v1']);
export const REQUIRED_MARKET=Object.freeze({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
/** Registry defaults of the objective (6.2, 6.3, 6.5, F7). An owner may tighten a filter and never loosen it (OD-C21). */
export const REGISTRY_DEFAULTS=Object.freeze({max_drawdown_percent:'20',min_episodes_floor:5,min_episodes_ranking:20,tie_band_pp:'0.50'});

export const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const isInt=value=>Number.isSafeInteger(value);
export const isAligned=value=>isInt(value)&&value%MINUTE===0;
export const text=value=>typeof value==='string'&&value.length>0?value:null;
export function deepFreeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const key of Object.keys(value))deepFreeze(value[key]);}
  return value;
}
/** Parse a decimal (string or finite number) to Money, or null. Never throws. */
export function dec(value){
  try{return D(value);}catch{return null;}
}
/** Canonical decimal string ('1.50' and '1.5' become '1.5'; negative zero becomes '0'), or null when unreadable. */
export function norm(value){
  const d=dec(value);
  if(!d)return null;
  return d.isZero()?'0':d.toFixed();
}
export const round18=value=>D(value).toDecimalPlaces(18,Money.ROUND_HALF_EVEN);
export const round12=value=>D(value).toDecimalPlaces(12,Money.ROUND_HALF_EVEN);
export const out=value=>{const d=D(value);return d.isZero()?'0':d.toFixed();};
export const cmp=(a,b)=>D(a).cmp(D(b));
/** Fixed-place text of a rounded value, trailing zeros kept so a stored value has one spelling. */
export const fixed=(value,places)=>D(value).toDecimalPlaces(places,Money.ROUND_HALF_EVEN).toFixed(places);
export const utc=ms=>new Date(ms).toISOString();
export const refuse=(code,detail=null,extra={})=>deepFreeze({ok:false,code,detail,...extra});
/** V7 (RC-C10): a money or metric input of type number is refused, never read; decimals travel as strings. */
export const NUMBER_DETAIL='NUMBER_NOT_DECIMAL_STRING';
export const isNumber=value=>typeof value==='number';
export const numberRefusal=(extra={})=>refuse(CODES.QR3_SPEC_INCOMPLETE,NUMBER_DETAIL,extra);
/** Like dec, but a JS number is unreadable. */
export const decString=value=>typeof value==='string'?dec(value):null;
/** Neutral order of section 6.6 X7 and OD-C6: creation time, then id. Metrics never matter. */
export const neutralCompare=(a,b)=>(a.created_at_ms-b.created_at_ms)||(a.id<b.id?-1:a.id>b.id?1:0);
export const nullMetric=(reason)=>deepFreeze({value:null,reason});
