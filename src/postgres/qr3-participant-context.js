import {canonical,hash} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {strictJsonV2} from '../quant-research/foundation-contract-v2.js';
import {CODES,MINUTE,QR3_VERSIONS,REQUIRED_MARKET,isObject,refuse} from '../comparison/common.js';
import {contextFields,contextKey,subjectOf} from '../comparison/context.js';

/**
 * QR-3 S4 frozen participant context (contract 3.2, C1 to C16) built from one parent research run. The create route freezes this value in the
 * participant row (freeze.context); the fixed-evaluation admission re-reads it at enqueue and refuses any drift with a context mismatch, so a
 * field written here that the admission would compute differently fails closed later and never changes a stored number.
 *
 * This module must stay outside the reviewed evaluation closure (root ruling S3AP section 13 and SB177): it names no module of that closure. The
 * two formulas that the admission module exports (the C11 policy hash and the C16 protocol hash), the 16-name policy projection they use, the
 * warm-up rule and the three literals below are restated as code, and test/qr3-participant-context.test.js pins every one of them against the
 * exports of the closure (the S3a pattern). The two values only the closure can supply, the engine hash (C7) and the shared dataset digest (C6),
 * are inputs of the caller.
 *
 * Nothing here reads a database, file, clock or random source.
 */
export const FIXED_EVAL_CONTRACT_VERSION='fixed-eval-job-v1';
export const DATASET_DIGEST_KIND='ql3a-dataset-sha256-v1';
export const DATASET_TIMESTAMPS='verified closed-bar timestamps; half-open index end is last timestamp plus one minute';
export const COST_STRESS_RULE='ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE';
export const EXECUTION_CONTEXT=Object.freeze({fill_model:'paper-close-v1',exit_semantics_version:'bridge-exit-v2'});
export const VALUATION_CONTEXT=Object.freeze({price_series:'DATASET_CLOSE',grid_id:QR3_VERSIONS.grid,currency:'USDT',fx:'NONE',end_treatment:'MARK_AT_END_CLOSE'});
export const WARMUP_FLOOR=1006,WARMUP_EMA_MULTIPLE=5,WARMUP_MAX=5000;

/** The 16 policy names the evaluator reads from a larger snapshot policy (restated). */
export const POLICY_KEYS=Object.freeze(['killSwitch','maxSignalAgeSeconds','maxTradesPerDay','maxDailyLossR','pauseAfterLossStreak','blockHighVolatility','maxVolatilityPercent',
  'blockDuringNews','allowedSymbols','sideMode','maxOpenPositions','onePositionPerSymbol','capPercentEquitySize','maxRiskPercent','maxOrderNotional','maxDailyNotional']);
const BOOLEAN_KEYS=Object.freeze(['killSwitch','blockHighVolatility','blockDuringNews','onePositionPerSymbol','capPercentEquitySize']);
const DECIMAL_KEYS=Object.freeze(['maxDailyLossR','maxRiskPercent','maxOrderNotional','maxDailyNotional']);
const SIDE_MODES=Object.freeze(['BOTH','BUY_ONLY','SELL_ONLY']);
const DECIMAL_TEXT=/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;
const HEX64=/^[a-f0-9]{64}$/;
const decimalText=value=>typeof value==='string'&&value.length<=120&&DECIMAL_TEXT.test(value);
const policyValue=(name,value)=>{
  if(BOOLEAN_KEYS.includes(name))return typeof value==='boolean';
  if(name==='allowedSymbols')return Array.isArray(value)&&value.length===1&&value[0]===REQUIRED_MARKET.symbol;
  if(name==='sideMode')return SIDE_MODES.includes(value);
  if(typeof value==='number')return Number.isFinite(value)&&value>=0;
  return DECIMAL_KEYS.includes(name)&&decimalText(value);
};
/** The policy projection of the evaluator. Throws on any gap, so a participant with an unreadable policy has no context (fail closed). */
export function projectPolicy(raw){
  if(!isObject(raw))throw new Error('POLICY_INVALID');
  strictJsonV2(raw);
  const projected={};
  for(const name of POLICY_KEYS){
    if(!Object.hasOwn(raw,name)||!policyValue(name,raw[name]))throw new Error('POLICY_INVALID');
    projected[name]=JSON.parse(canonical({value:raw[name]})).value;
  }
  return projected;
}
const decimal=value=>D(value).toFixed();

/** C11: the comparison policy hash of one parent contract (restated; pinned to the admission export). */
export const comparisonPolicyHash=c=>hash(canonical({policy:projectPolicy(c.snapshot.policy),risk_percent:decimal(c.model.risk_percent)}));
/** C16: the validation protocol hash of one parent contract and the frozen spec (restated; pinned to the admission export). */
export const comparisonProtocolHash=(c,spec)=>hash(canonical({rules:{adequacy:spec.adequacy,risk_filter:spec.risk_filter,
  sensitivity_max_drop_percentage_points:decimal(c.rules.sensitivity_max_drop_percentage_points),cost_stress:COST_STRESS_RULE},
  ledger_initialization:c.ledger_initialization,evaluation_contract_version:FIXED_EVAL_CONTRACT_VERSION}));

/**
 * Warm-up bars of one parent: max(1006, 5 times the slow EMA length) of the evaluator inputs, where the slow EMA is the parent's selected value
 * or, when the search did not move it, its fixed input (restated; pinned to the admission rule). Returns an integer or null (unreadable).
 */
export function warmupBarsOf({fixed_inputs:fixedInputs,selected}){
  const chosen=isObject(selected)&&Object.hasOwn(selected,'emaSlowInput')?selected.emaSlowInput
    :Array.isArray(fixedInputs)?fixedInputs.find(item=>isObject(item)&&item.pine_variable==='emaSlowInput')?.effective_value:undefined;
  if(typeof chosen!=='number'||!Number.isFinite(chosen)||chosen<1||chosen>1000||!Number.isSafeInteger(chosen))return null;
  const bars=Math.max(WARMUP_FLOOR,WARMUP_EMA_MULTIPLE*chosen);
  return bars<=WARMUP_MAX?bars:null;
}

/**
 * Builds the C1 to C16 context and the disclosed subject of one participant.
 * input: {participant_id, contract (a validated research contract v2), selected (the parent's selected.parameters), run: {run_id, contract_hash, bot_id, deployment_id},
 *   spec (the frozen STANDARDIZED spec), spec_hash, period: {start_ms, end_ms}, warmup_bars (W_max over the participants), dataset_digest (64 hex), engine_hash (64 hex)}
 * Returns {ok:true, fields, missing:[], context_key, subject, freeze} or {ok:false, code, detail}. freeze is the object the store takes as participant freeze.
 */
export function buildParticipantContext(input){
  const request=isObject(input)?input:{};
  const {participant_id:participantId,contract:c,spec,period}=request;
  if(typeof participantId!=='string'||!isObject(c)||!isObject(spec)||!isObject(period)||!isObject(request.run))return refuse(CODES.INVALID_FIELDS,'CONTEXT_INPUT');
  if(typeof request.engine_hash!=='string'||!HEX64.test(request.engine_hash))return refuse(CODES.QR3_DATASET_UNAVAILABLE,'ENGINE_HASH');
  if(typeof request.dataset_digest!=='string'||!HEX64.test(request.dataset_digest))return refuse(CODES.QR3_DATASET_UNAVAILABLE,'DATASET_DIGEST');
  if(!Number.isSafeInteger(request.warmup_bars)||request.warmup_bars<WARMUP_FLOOR)return refuse(CODES.INVALID_FIELDS,'WARMUP_BARS');
  const start=period.start_ms,end=period.end_ms,warmup=request.warmup_bars;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start%MINUTE!==0||end%MINUTE!==0||end<=start)return refuse(CODES.QR3_PERIOD_INVALID,'CONTEXT_PERIOD');
  let raw;
  try{
    // The admission demands cash equal to equity for the fixed evaluation; a parent with another split has no comparable capital.
    if(decimal(c.capital.cash)!==decimal(c.capital.equity))return refuse(CODES.INVALID_FIELDS,'CASH_NOT_EQUITY');
    raw={mode:'STANDARDIZED',scope:c.scope,market:c.snapshot.market,
      data_model:{data_profile:c.model.data_profile,price_tick:decimal(c.model.price_tick),quantity_step:decimal(c.model.quantity_step)},
      period:{start_ms:start,end_ms:end,evaluation_bars:(end-start)/MINUTE},
      dataset:{digest_kind:DATASET_DIGEST_KIND,digest:request.dataset_digest,first_bar:start-warmup*MINUTE+MINUTE,last_bar:end,bar_count:(end-start)/MINUTE+warmup,timestamp_semantics:DATASET_TIMESTAMPS},
      engine:request.engine_hash,execution:{...EXECUTION_CONTEXT},
      cost_model:{version:c.model.version,fee_bps:decimal(c.model.fee_bps),slippage_bps:decimal(c.model.slippage_bps)},
      capital:{initial_cash:decimal(c.capital.cash),initial_inventory:'0',quote:'USDT'},
      risk_policy:comparisonPolicyHash(c),ledger_initialization:c.ledger_initialization,valuation:{...VALUATION_CONTEXT},
      benchmark:QR3_VERSIONS.benchmark,spec_hash:request.spec_hash??null,validation_protocol:comparisonProtocolHash(c,spec)};
  }catch{return refuse(CODES.INVALID_FIELDS,'CONTEXT_SOURCE');}
  const {fields,missing}=contextFields(participantId,raw);
  if(missing.length>0)return refuse(CODES.INVALID_FIELDS,'CONTEXT_FIELDS:'+missing.join(','));
  const selected=isObject(request.selected)?structuredClone(request.selected):{};
  const subject=subjectOf({source_hash:c.source_hash,source_version:c.source_version,source_contract_version:c.version,parameters:selected,
    bridge_atr_rr:{atr_multiplier:selected.atr_multiplier??null,rr:selected.rr??null},warmup_bars:warmup,originating_run:request.run.run_id,
    bot_id:request.run.bot_id,deployment_id:request.run.deployment_id,bot_policy_hash:c.snapshot.policy_hash});
  return {ok:true,fields,missing,context_key:contextKey(fields),subject,
    freeze:{context:structuredClone(fields),subject:structuredClone(subject),parent:{run_id:request.run.run_id,contract_hash:request.run.contract_hash}}};
}
