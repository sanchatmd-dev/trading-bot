import {canonical,hash,QR3_VERSIONS,CODE_PATTERN,MINUTE,MAX_TOTAL_BARS,REQUIRED_MARKET,ADMITTED_COST_MODELS,isObject,isInt,isAligned,text,dec,decString,norm,out,cmp,deepFreeze,refuse,utc as utcOf} from '../comparison/common.js';

/**
 * Shared constants of the pure QR-4 qualified selection module (docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md, test plan 16.1).
 * Nothing under src/selection reads a database, file, network, clock or random source. Every time is an input in epoch
 * milliseconds (UTC), every decimal is a string, and every result is a frozen plain value. Money, returns and drawdowns
 * compare as exact decimals (decimal.js through src/money.js); binary floating point never decides a filter, a tie or a rank.
 */
export {canonical,hash,QR3_VERSIONS,CODE_PATTERN,MINUTE,MAX_TOTAL_BARS,REQUIRED_MARKET,ADMITTED_COST_MODELS,isObject,isInt,isAligned,text,dec,decString,norm,out,cmp,deepFreeze,refuse,utcOf};

export const QR4_VERSIONS=Object.freeze({scope:'qr4-scope-v1',objective:'qr4-objective-lexi-v1',uncertainty:'qr4-uncertainty-disclosure-v1',
  registration:'qr4-registration-v1',outcome:'qr4-outcome-v1',evaluation_mode:'QR4_SELECTION_EVAL',library_compat:'library-compat-v1'});

/** Section 9 and section 10, every code the pure module can emit. Reused repository codes sit beside the QR4_ ones. */
export const CODE_LIST=Object.freeze([
  'NOT_FOUND','CONFIRMATION_REQUIRED','INVALID_FIELDS',
  'QR4_NO_ELIGIBLE_PARTICIPANT','QR4_PARTICIPANT_NOT_READY','QR4_PARTICIPANT_NOT_QUALIFIED','QR4_VALIDATION_BINDING_MISMATCH','QR4_FIXTURE_PARTICIPANT',
  'QR4_MULTI_PINE_PARTICIPANT','QR4_DEVELOPMENT_SCORE_NOT_RANKABLE','QR4_OWN_HOLDOUT_NOT_COMPARABLE','QR4_ACTUAL_HISTORY_NOT_RANKABLE','QR4_MIXED_BASIS',
  'QR4_TOO_FEW_PARTICIPANTS','QR4_TOO_MANY_PARTICIPANTS','QR4_DUPLICATE_PARTICIPANT','QR4_UNIVERSE_TOO_LARGE','QR4_SCOPE_INCOMPATIBLE','QR4_RULES_VERSION_MIXED',
  'BI_MARKET_SCOPE_INVALID','QR4_OBJECTIVE_UNKNOWN','QR4_CUSTOM_WEIGHTS_REFUSED','QR4_FILTER_INVALID','QR4_REGISTRATION_IMMUTABLE','QR4_WINDOW_INVALID',
  'QR4_WINDOW_OVER_CAPACITY','QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA','QR4_WINDOW_OVERLAPS_SEARCHED_DATA','QR4_WINDOW_EXPOSED','QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY',
  'QR4_QR3_CONTEXT_UNAVAILABLE','QR4_EVALUATION_MODE_UNAVAILABLE','QR4_EPISODE_GATE_UNAVAILABLE','QR4_EXPOSURE_REGISTRY_UNAVAILABLE','QR4_EVALUATION_SEARCH_REFUSED',
  'QR4_SELECTION_EXISTS','QR4_APPLY_REFUSED','QR4_TRANSITION_INVALID',
  'QR4_WINDOW_DATA_UNAVAILABLE','QR4_WINDOW_DATA_GAP','BI_DATASET_HASH_MISMATCH','QR4_EVALUATION_FAILED','QR4_METRIC_MISSING','INTEGRITY_CHECK_FAILED',
  'QR4_ENGINE_MISMATCH','QR4_BENCHMARK_UNAVAILABLE','QR4_PARTICIPANT_STALE','QR4_ADMISSION_REFUSED',
  'FILTER_DRAWDOWN_LIMIT','FILTER_EPISODE_FLOOR','FILTER_COST_STRESS','FILTER_NET_RETURN_POSITIVE','FILTER_BEATS_BUY_AND_HOLD']);
export const CODES=Object.freeze(Object.fromEntries(CODE_LIST.map(code=>[code,code])));

export const OUTCOMES=Object.freeze(['BEST_IN_SCOPE','TIED_IN_SCOPE','NO_QUALIFYING_STRATEGY','INADEQUATE_EVIDENCE']);
export const STATUSES=Object.freeze(['SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED']);
export const PARTICIPANT_RESULTS=Object.freeze(['PASSED','EVIDENCE_INADEQUATE','NOT_QUALIFYING_IN_SCOPE']);
export const UNIVERSE_STATUSES=Object.freeze(['PARTICIPANT','QUALIFIED_STALE','EXCLUDED']);
export const WINDOW_KINDS=Object.freeze(['PROSPECTIVE','FORWARD_PAST']);
export const MIN_PARTICIPANTS=2;
export const MAX_PARTICIPANTS=4;
/** OD-S5: the QL4 OD-4 episode floor, an engineering minimum and not a statistical guarantee. */
export const EPISODE_FLOOR_V1=5;
export const FILTER_CODE_LIST=Object.freeze(['FILTER_DRAWDOWN_LIMIT','FILTER_EPISODE_FLOOR','FILTER_COST_STRESS','FILTER_NET_RETURN_POSITIVE','FILTER_BEATS_BUY_AND_HOLD']);

/** Keys that name a custom formula, weight or sort key (section 6.1). */
export const WEIGHT_KEYS=Object.freeze(['weights','weight','sort','sort_by','order_by','rank','rank_by','score','formula','composite','custom']);
/**
 * D1 (section 3.3, RC-S12): the only query keys a development view accepts. Every other key is refused with
 * QR4_DEVELOPMENT_SCORE_NOT_RANKABLE before any row is read, so a joined or digit-suffixed form (sortby, rankby, top10, best3, leader)
 * cannot pass by avoiding a blocked word. The contract does not list the parameters; this is the minimum of paging and display
 * (CONTRACT QUESTION for root).
 */
export const DEVELOPMENT_VIEW_PARAMS=Object.freeze(['limit','offset','page_size','include_gates']);
/** D2 (section 3.3): a field name token that starts with one of these is flagged. */
export const DEVELOPMENT_NAME_PREFIXES=Object.freeze(['rank','best','top','winner','leader']);
/**
 * Lower-case word tokens of a field name (D2): camelCase boundaries split first, then every run of characters that are not letters
 * is a separator, so digits and underscores split too (top10 gives top; stop_loss gives stop and loss).
 */
export const keyTokens=key=>String(key).replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split(/[^a-z]+/).filter(Boolean);

/**
 * Section 5.4: the only keys of an evaluation request. An evaluation has zero free dimensions, so every other key is refused (the
 * named search keys with QR4_EVALUATION_SEARCH_REFUSED, the rest with INVALID_FIELDS). The contract does not list the keys; this is
 * the set the section names (CONTRACT QUESTION for root).
 */
export const EVALUATION_REQUEST_KEYS=Object.freeze(['selection_id','run_id','parent_run_id','mode','export_id','package_hash','scope','window','dataset_hash','engine_hash']);

/**
 * Codes that end a selection SELECTION_INCOMPLETE (section 10), in the order that picks the first code of a ranking. The lifecycle
 * table allows only these codes for ALL_EVALUATIONS_DONE, so an unreadable register (QR4_EXPOSURE_REGISTRY_UNAVAILABLE) never ends a selection.
 */
export const INCOMPLETE_CODES=Object.freeze([CODES.QR4_PARTICIPANT_STALE,CODES.QR4_ADMISSION_REFUSED,CODES.QR4_EVALUATION_FAILED,
  CODES.QR4_WINDOW_DATA_UNAVAILABLE,CODES.QR4_WINDOW_DATA_GAP,CODES.BI_DATASET_HASH_MISMATCH,CODES.INTEGRITY_CHECK_FAILED,CODES.QR4_ENGINE_MISMATCH,
  CODES.QR4_METRIC_MISSING,CODES.QR4_BENCHMARK_UNAVAILABLE]);

export const geq=(a,b)=>cmp(a,b)>=0;
export const hasOwn=(object,key)=>isObject(object)&&Object.hasOwn(object,key);
/** Neutral order of section 3.3 D1: creation time, then id. Metrics never matter. */
export const byCreation=(a,b)=>(a.created_at_ms-b.created_at_ms)||(a.run_id<b.run_id?-1:a.run_id>b.run_id?1:0);
export const byText=key=>(a,b)=>a[key]<b[key]?-1:a[key]>b[key]?1:0;
/** Canonical hash that never throws; null when the value cannot be serialised. */
export function digest(value){
  try{const textual=canonical(value);return typeof textual==='string'?hash(textual):null;}catch{return null;}
}
export const HEX64=/^[a-f0-9]{64}$/;
export const isSha=value=>typeof value==='string'&&HEX64.test(value);
export const isCount=value=>Number.isSafeInteger(value)&&value>=0;
/** Non-negative decimal string (exact), or null. A JS number is never read. */
export function nonNegative(value){
  const d=decString(value);
  return d&&(!d.isNegative()||d.isZero())?norm(value):null;
}
export const marketKeyOf=()=>canonical(REQUIRED_MARKET);
export const marketIsRequired=market=>isObject(market)&&market.broker===REQUIRED_MARKET.broker&&market.symbol===REQUIRED_MARKET.symbol&&market.timeframe===REQUIRED_MARKET.timeframe;
