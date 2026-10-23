import {canonical,hash,Money,MINUTE,QR3_VERSIONS,CODES,isObject,isInt,isNumber,dec,decString,deepFreeze,refuse,numberRefusal,round12,round18} from './common.js';
import {valueRun,buyAndHold} from './valuation.js';
import {participantStatus} from './evidence.js';
import {decideOutcome,specThresholds,specHashOf} from './ranking.js';

/**
 * QR-3 slice S3a (docs/QR3_S3A_EVALUATION_RECORD_PACKET_2026-10-24.md): the pure half of the evaluation orchestration. Three functions build the
 * exact bodies that writeEvaluation, writeBenchmark and writeOutcome of the QR-3 comparison store accept, from one terminal fixed-evaluation
 * result (fixed-eval-result-v1), the frozen dataset rows and the frozen comparison spec. Nothing here reads a database, file, network, clock or
 * random source, writes a row, or is imported by a route, worker or service. The module is not exported from index.js (ruling R5).
 *
 * Basis ruling R1: the RD-5 V8 hold is NOT discharged. Every record states basis_confirmed false and every valuation call passes basis_confirmed false,
 * so end_treatment is VALUATION_BASIS_UNCONFIRMED, every evaluated participant is DEVELOPMENT_EVIDENCE (R2) and the outcome is NO_QUALIFIED_RESULT.
 * An input that carries a basis_confirmed key is refused INVALID_FIELDS; no input can turn the basis to true.
 * Refuse means {ok:false, code, detail}; nothing is repaired. Money and metrics are decimal strings; a number in such a position is refused
 * QR3_SPEC_INCOMPLETE with detail NUMBER_NOT_DECIMAL_STRING. Every output is a deep frozen new value; no input is mutated or aliased.
 */
export const EVALUATION_RECORD_VERSION='qr3-evaluation-record-v1';
/** Same limits as MAX_EVALUATION_BYTES and MAX_BENCHMARK_BYTES of the store writers (a canonical text above them is refused BODY_SIZE). */
export const EVALUATION_RECORD_MAX_BYTES=4194304;
export const BENCHMARK_RECORD_MAX_BYTES=262144;
export const BENCHMARK_ID=QR3_VERSIONS.benchmark;

const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX64=/^[0-9a-f]{64}$/;
const COMPARISON_PURPOSE='QR3_COMPARISON';
/** Restated from the fixed-evaluation contract (this module must not import it; root ruling, packet section 13); a test pins both to the contract exports. */
const CLOSURE_VERSION='fixed-eval-closure-v1';
const EVALUATION_KEYS=Object.freeze(['comparison_id','spec_hash','spec','participant_id','evaluation_run_id','fixed_contract','binding','fixed_result','rows']);
const BENCHMARK_KEYS=Object.freeze(['comparison_id','spec_hash','spec','fixed_contract','rows']);
const OUTCOME_KEYS=Object.freeze(['spec','spec_hash','context_key','participants']);
const ENTRY_KEYS=Object.freeze(['participant_id','status_input','evaluation']);
const EVALUATION_ENTRY_KEYS=Object.freeze(['body','created_at_ms']);
/** participantStatus fields the caller owns (5.8, Q3). has_evaluation, evaluation and spec belong to S3a; basis_confirmed is never an input. */
const STATUS_INPUT_KEYS=Object.freeze(['integrity_ok','unavailable','compatibility','coverage','evidence','completed_episodes','episode_gate_available','max_drawdown_percent_exact']);
/** Statuses that need no stored evaluation row (the store UNEVALUATED_STATUSES; UNAVAILABLE may have one or not). */
const UNRECORDED_STATUSES=Object.freeze(['NOT_EVALUATED','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','EXCLUDED_INCOMPATIBLE']);

const idOk=value=>typeof value==='string'&&ID.test(value);
const invalid=detail=>refuse(CODES.INVALID_FIELDS,detail);
const integrity=detail=>refuse(CODES.QR3_INTEGRITY_FAILED,detail);
const hasKeys=(value,names)=>isObject(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const hasBasisKey=value=>isObject(value)&&Object.hasOwn(value,'basis_confirmed');

/**
 * The validators of the fixed-evaluation contract are a required dependency argument, so this module stays outside the reviewed evaluation closure
 * (root ruling, packet section 13). A missing or non-function validator refuses QR3_INTEGRITY_FAILED, detail VALIDATOR_MISSING, before anything is read.
 */
const hasValidators=(deps,names)=>isObject(deps)&&names.every(name=>typeof deps[name]==='function');

/** Shape shared by the evaluation and benchmark inputs: exact keys, no basis_confirmed, a comparison id, a spec hash and a spec object. */
function checkInput(input,names){
  if(hasBasisKey(input))return invalid('BASIS_CONFIRMED');
  if(!hasKeys(input,names))return invalid('INPUT');
  if(!idOk(input.comparison_id))return invalid('COMPARISON_ID');
  if(typeof input.spec_hash!=='string'||!HEX64.test(input.spec_hash))return invalid('SPEC_HASH');
  if(!isObject(input.spec))return invalid('SPEC');
  return null;
}

/**
 * Time translation (5.3). Dataset times are closed-bar timestamps; the QR-3 grid uses bar-open times (qr3-grid-bar-close-v1).
 * W1 scored rows are rows[warmup] to rows[end-1]; W2 grid {time_ms: row.time - 60000, close}; W3 period start is the first scored time minus one
 * minute, period end is the last scored time, and both must equal spec.period; W4 grid length equals the evaluated bar count.
 * Rows must be exactly the contract dataset: bar_count rows, rows[i].time === first_time + i * 60000. Any other shape is WINDOW_MISMATCH.
 */
function scoredWindow(contract,spec,rows,evaluatedBars){
  const {first_time:first,bar_count:count,warmup_bars:warmup}=contract.dataset;
  if(!Array.isArray(rows)||rows.length!==count||rows.some((row,index)=>!isObject(row)||row.time!==first+index*MINUTE))return integrity('WINDOW_MISMATCH');
  const scored=rows.slice(warmup,count);
  const grid=scored.map(row=>({time_ms:row.time-MINUTE,close:row.close}));
  const period={start_ms:scored[0].time-MINUTE,end_ms:scored[scored.length-1].time};
  if(!isObject(spec.period)||spec.period.start_ms!==period.start_ms||spec.period.end_ms!==period.end_ms)return integrity('WINDOW_MISMATCH');
  if(grid.length!==evaluatedBars)return integrity('WINDOW_MISMATCH');
  return {ok:true,grid,period};
}

/** Canonical text, byte limit, hash: the same text and hash that the store computes (bodyText and hash). */
function seal(body,limit){
  const serialized=canonical(body);
  if(Buffer.byteLength(serialized,'utf8')>limit)return invalid('BODY_SIZE');
  return deepFreeze({ok:true,code:null,detail:null,body,body_hash:hash(serialized)});
}

const fillHasNumber=fill=>isObject(fill)&&[fill.quantity,fill.price,fill.fee,fill.slippage_cost_incl_tick].some(isNumber);
const stepHasNumber=step=>[step.initial_equity,step.metrics.end_equity,step.metrics.net_return_percent,step.metrics.max_drawdown_percent,step.exposure.fraction].some(isNumber)||
  step.fills.some(fillHasNumber);
const gridHasNumber=grid=>grid.some(bar=>isNumber(bar.close));

/** Exact-decimal equality (5.5): never a float, never a tolerance. An unreadable or missing figure on either side is a difference. */
function equal(left,right){
  const a=decString(left);
  const b=typeof right==='string'?dec(right):right;
  return a!==null&&b!==null&&b!==undefined&&a.eq(b);
}
/** Cross-check of one evaluator step against its valueRun output (5.5); returns the detail of the first difference, or null. */
function crossCheck(step,valued){
  const metrics=step.metrics;
  if(!equal(metrics.end_equity,valued.end_nav))return 'CROSS_CHECK_END_NAV';
  if(!equal(metrics.net_return_percent,valued.net_return_percent_exact))return 'CROSS_CHECK_RETURN';
  if(!equal(metrics.max_drawdown_percent,valued.max_drawdown_percent_exact))return 'CROSS_CHECK_DRAWDOWN';
  if(!equal(step.fees_total,valued.total_fees))return 'CROSS_CHECK_FEES';
  if(!equal(step.slippage_cost_incl_tick_total,valued.total_slippage.value))return 'CROSS_CHECK_SLIPPAGE';
  if(step.exposure.bars!==valued.bars)return 'CROSS_CHECK_EXPOSURE';
  const fraction=decString(step.exposure.fraction),inMarket=step.exposure.bars_in_market;
  if(fraction===null||!equal(valued.exposure_percent,round12(fraction.mul(100))))return 'CROSS_CHECK_EXPOSURE';
  /* Hardening (root ruling P3): the in-market count is an integer, the fraction is that count over the bars at 18 places (the evaluator rule), and the
     exposure percent is the count over the bars at 12 places. Distinct counts differ by at least 100 / bars, so this pins the count exactly. */
  if(!isInt(inMarket))return 'CROSS_CHECK_EXPOSURE';
  const share=new Money(inMarket).div(valued.bars);
  if(!equal(step.exposure.fraction,round18(share))||!equal(valued.exposure_percent,round12(share.mul(100))))return 'CROSS_CHECK_EXPOSURE';
  return null;
}

/**
 * Evaluation record body qr3-evaluation-record-v1 (5.6) for one participant.
 * input: {comparison_id, spec_hash, spec (frozen STANDARDIZED spec), participant_id, evaluation_run_id, fixed_contract, binding, fixed_result, rows}
 * deps: {validateFixedEvalContract, validateFixedEvalResult}, the validators of the fixed-evaluation contract (required, VALIDATOR_MISSING otherwise).
 * Order: dependencies, input shape, validateFixedEvalResult (FIXED_RESULT_INVALID), lineage and purpose (5.2), window translation (WINDOW_MISMATCH), numbers,
 * fill times (FILL_TIME_TRANSLATION), cash against equity (CASH_EQUITY), valueRun for base and stress (a refusal is passed through unchanged),
 * the exact-decimal cross-check of base then stress (5.5), then the body. The body stores the valueRun outputs, never an evaluator figure.
 * Returns {ok:true, code:null, detail:null, body, body_hash} or a refusal.
 */
export function evaluationRecordBody(input,deps){
  if(!hasValidators(deps,['validateFixedEvalContract','validateFixedEvalResult']))return integrity('VALIDATOR_MISSING');
  const bad=checkInput(input,EVALUATION_KEYS);
  if(bad)return bad;
  let contract,result;
  try{
    contract=deps.validateFixedEvalContract(input.fixed_contract);
    result=deps.validateFixedEvalResult(contract,input.binding,input.fixed_result);
  }catch{return integrity('FIXED_RESULT_INVALID');}
  const {base,stress}=result,participant=input.participant_id;
  if(result.purpose!==COMPARISON_PURPOSE)return integrity('PURPOSE');
  if(result.lineage.object_id!==input.comparison_id)return integrity('LINEAGE_OBJECT');
  if(result.lineage.parent_run_id!==participant||base.parent_run_id!==participant||stress.parent_run_id!==participant)return integrity('LINEAGE_PARENT');
  if(base.selection_id!==null||stress.selection_id!==null)return integrity('SELECTION_ID');
  if(!Array.isArray(input.spec.participants)||!input.spec.participants.includes(participant))return integrity('PARTICIPANT_NOT_IN_SPEC');
  if(!idOk(input.evaluation_run_id))return integrity('EVALUATION_RUN_ID');
  if(result.evaluation_closure.version!==CLOSURE_VERSION)return integrity('CLOSURE_VERSION');
  if(canonical(base.split)!==canonical(stress.split))return integrity('SPLIT_MISMATCH');
  const window=scoredWindow(contract,input.spec,input.rows,base.split.evaluated_bars);
  if(!window.ok)return window;
  if(stepHasNumber(base)||stepHasNumber(stress)||gridHasNumber(window.grid))return numberRefusal();
  for(const step of [base,stress]){
    if(step.fills.some(fill=>!isObject(fill)||!isInt(fill.time)||fill.bar_time_ms!==fill.time-MINUTE))return integrity('FILL_TIME_TRANSLATION');
  }
  const cash=decString(contract.capital.initial_cash),equity=decString(base.initial_equity);
  if(cash===null||equity===null||!cash.eq(equity))return integrity('CASH_EQUITY');
  const value=step=>valueRun({initial_cash:contract.capital.initial_cash,period:window.period,grid:window.grid,flows:[],basis_confirmed:false,
    fills:step.fills.map(fill=>({bar_time_ms:fill.bar_time_ms,side:fill.side,quantity:fill.quantity,price:fill.price,fee:fill.fee,sequence:fill.sequence,
      slippage_cost:fill.slippage_cost_incl_tick}))});
  const valued=value(base);
  if(!valued.ok)return valued;
  const stressed=value(stress);
  if(!stressed.ok)return stressed;
  const difference=crossCheck(base,valued)||crossCheck(stress,stressed);
  if(difference!==null)return integrity(difference);
  const {rejected,episodes}=base,intents=rejected.intents_total,completed=episodes.completed_count;
  /* The evaluator reports intents_total as total minus the orphan exits (TARGET_NOT_OPEN for a warm-up or refused entry); the count of episodes is the length of the list. */
  const orphans=isObject(rejected.orphan_exits)?Object.values(rejected.orphan_exits):null;
  if(!isInt(intents)||intents<0||!isInt(rejected.total)||orphans===null||!orphans.every(count=>isInt(count)&&count>=0)||
    intents!==rejected.total-orphans.reduce((sum,count)=>sum+count,0))return integrity('REJECTED_SHAPE');
  if(!isInt(completed)||completed<0||!Array.isArray(episodes.completed)||completed!==episodes.completed.length)return integrity('EPISODES_SHAPE');
  return seal({version:EVALUATION_RECORD_VERSION,record_comparison_id:input.comparison_id,record_spec_hash:input.spec_hash,
    window:{start_ms:window.period.start_ms,end_ms:window.period.end_ms},participant_id:participant,evaluation_run_id:input.evaluation_run_id,
    engine_hash:result.engine_hash,dataset_sha256:result.dataset_sha256,evaluation_closure:result.evaluation_closure,basis_confirmed:false,
    valuation:valued,stress_valuation:stressed,
    metrics:{net_return_percent:valued.net_return_percent,max_drawdown_percent:valued.max_drawdown_percent,total_fees:valued.total_fees,
      total_slippage:valued.total_slippage,exposure_percent:valued.exposure_percent,rejected_intents:intents},
    completed_episodes:completed,closed_allocations:base.closed_allocations,rejected:base.rejected,
    limitations:[...new Set([...valued.limitations,...stressed.limitations,CODES.VALUATION_BASIS_UNCONFIRMED])].sort()},EVALUATION_RECORD_MAX_BYTES);
}

/**
 * Benchmark body (5.7): Buy & Hold qr3-bh-close-same-cost-v1 on the same scored grid, with the base step cost model of the frozen contract (Q4),
 * basis_confirmed false and no liquidation line. A refused benchmark is stored as a null line that keeps its own code and detail (B6, RC-C20);
 * it does not refuse the comparison. Only an input fault (shape, contract, window, a number) refuses.
 * input: {comparison_id, spec_hash, spec, fixed_contract, rows}; deps: {validateFixedEvalContract} (required, VALIDATOR_MISSING otherwise)
 * Returns {ok:true, code:null, detail:null, body:{benchmark_id, record_comparison_id, record_spec_hash, window, result}, body_hash} or a refusal.
 */
export function benchmarkRecordBody(input,deps){
  if(!hasValidators(deps,['validateFixedEvalContract']))return integrity('VALIDATOR_MISSING');
  const bad=checkInput(input,BENCHMARK_KEYS);
  if(bad)return bad;
  let contract;
  try{contract=deps.validateFixedEvalContract(input.fixed_contract);}catch{return integrity('FIXED_CONTRACT_INVALID');}
  const window=scoredWindow(contract,input.spec,input.rows,contract.dataset.bar_count-contract.dataset.warmup_bars);
  if(!window.ok)return window;
  if(gridHasNumber(window.grid))return numberRefusal();
  const model=contract.cost_model;
  const line=buyAndHold({initial_cash:contract.capital.initial_cash,period:window.period,grid:window.grid,data_model:{price_tick:model.price_tick,quantity_step:model.quantity_step},
    cost_model:{fee_bps:model.fee_bps,slippage_bps:model.slippage_bps},basis_confirmed:false,include_liquidation_line:false});
  let result={ok:false,code:line.code,detail:line.detail??null,value:null};
  if(line.ok===true){
    /* Root ruling P1: the stored result omits valuation.nav_series (QR3 5.3 B1 to B6 never need it; B5 uses the net return). It carries the SHA-256 of the
       canonical text of the omitted series and its length, which must equal the scored bar count, so the body stays small for any admitted window. */
    const {nav_series:series,...valuation}=line.valuation;
    if(series.length!==window.grid.length)return integrity('NAV_POINTS');
    result={...line,valuation:{...valuation,nav_series_sha256:hash(canonical(series)),nav_points:series.length}};
  }
  return seal({benchmark_id:BENCHMARK_ID,record_comparison_id:input.comparison_id,record_spec_hash:input.spec_hash,
    window:{start_ms:window.period.start_ms,end_ms:window.period.end_ms},result},BENCHMARK_RECORD_MAX_BYTES);
}

const metricHasNumber=metrics=>[metrics.net_return_percent,metrics.max_drawdown_percent,metrics.total_fees,metrics.exposure_percent,metrics.total_slippage,
  isObject(metrics.total_slippage)?metrics.total_slippage.value:null].some(isNumber);
/** True when the status and the stored evaluation disagree (QR3:987, the store): NOT_EVALUATED has none, an evaluated status has one. */
function evaluationMismatch(status,evaluation){
  if(status==='NOT_EVALUATED')return evaluation!==null;
  if(UNRECORDED_STATUSES.includes(status)||status==='UNAVAILABLE')return false;
  return evaluation===null;
}

/** A stored evaluation body must be the record of this entry: version, participant, frozen spec hash, and an unconfirmed basis (root ruling P3). */
const bodyBelongsTo=(body,participantId,specHash)=>body.version===EVALUATION_RECORD_VERSION&&body.participant_id===participantId&&body.record_spec_hash===specHash&&
  body.basis_confirmed===false;

/**
 * Outcome record (5.8) over the participants of the spec.
 * input: {spec, spec_hash, context_key, participants:[{participant_id, status_input, evaluation}]} where evaluation is null or {body, created_at_ms}
 * read back from the store, and status_input holds the participantStatus fields the caller owns (Q3: integrity_ok, unavailable, compatibility,
 * coverage, evidence, episode gate; never has_evaluation, evaluation, spec or basis_confirmed). S3a sets has_evaluation, sets evaluation to
 * {basis_confirmed:false, metrics: body.metrics} and takes the thresholds from specThresholds(spec). created_at_ms is the stored record time, and 0
 * for a participant without a record (decideOutcome needs an integer; the store does not read it for an unrecorded status). primary_metric is
 * body.metrics.net_return_percent only when a record exists and participantStatus shows the metrics (QR3 3.4, RC-C26: an excluded or unavailable
 * participant keeps no figure), otherwise null. A stored body must carry this entry's participant id, the spec hash, the record version and
 * basis_confirmed false. The outcome limitations are [VALUATION_BASIS_UNCONFIRMED] (R1). The result is the decideOutcome result (ok, code, detail, the nine OUTCOME_FIELDS and outcome_hash), which is
 * the value writeOutcome takes as `outcome`. Only NO_QUALIFIED_RESULT is allowed (R2): any other outcome is OUTCOME_NOT_ALLOWED.
 */
export function outcomeRecord(input){
  if(hasBasisKey(input))return invalid('BASIS_CONFIRMED');
  if(!hasKeys(input,OUTCOME_KEYS))return invalid('INPUT');
  if(!isObject(input.spec))return invalid('SPEC');
  if(typeof input.context_key!=='string'||!HEX64.test(input.context_key))return invalid('CONTEXT_KEY');
  /* validateSpec (inside decideOutcome) deep freezes the period object it receives, so decideOutcome gets a copy and the caller's spec stays writable. */
  let spec;
  try{spec=structuredClone(input.spec);}catch{return invalid('SPEC');}
  if(input.spec_hash!==specHashOf(spec))return refuse(CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH');
  const list=input.participants;
  if(!Array.isArray(list)||list.length===0)return invalid('PARTICIPANTS');
  const seen=new Set();
  for(const entry of list){
    if(hasBasisKey(entry))return invalid('BASIS_CONFIRMED');
    if(!hasKeys(entry,ENTRY_KEYS))return invalid('PARTICIPANT_ENTRY');
    if(!idOk(entry.participant_id))return refuse(CODES.INVALID_RUN_ID);
    if(seen.has(entry.participant_id))return refuse(CODES.DUPLICATE_RUN_ID);
    seen.add(entry.participant_id);
  }
  const declared=Array.isArray(spec.participants)?[...spec.participants].sort():null;
  const given=[...seen].sort();
  if(declared===null||declared.length!==given.length||declared.some((id,index)=>id!==given[index]))return invalid('PARTICIPANTS_DIFFER_FROM_SPEC');
  const thresholds=specThresholds(spec);
  const participants=[];
  const evaluations=new Map();
  for(const entry of list){
    const {status_input:supplied,evaluation}=entry;
    if(hasBasisKey(supplied)||hasBasisKey(evaluation))return invalid('BASIS_CONFIRMED');
    if(!isObject(supplied)||Object.keys(supplied).some(name=>!STATUS_INPUT_KEYS.includes(name)))return invalid('STATUS_INPUT');
    if(evaluation!==null&&(!hasKeys(evaluation,EVALUATION_ENTRY_KEYS)||!isObject(evaluation.body)||!isObject(evaluation.body.metrics)||!isInt(evaluation.created_at_ms)||evaluation.created_at_ms<0))return invalid('EVALUATION');
    if(evaluation!==null&&metricHasNumber(evaluation.body.metrics))return numberRefusal();
    if(evaluation!==null&&supplied.evidence?.evidence_class==='NOT_EVALUATED')return integrity('OUTCOME_EVALUATION_MISMATCH');
    if(evaluation!==null&&!bodyBelongsTo(evaluation.body,entry.participant_id,input.spec_hash))return integrity('OUTCOME_EVALUATION_MISMATCH');
    const status=participantStatus({...supplied,has_evaluation:evaluation!==null,evaluation:evaluation===null?null:{basis_confirmed:false,metrics:evaluation.body.metrics},spec:thresholds});
    evaluations.set(entry.participant_id,evaluation);
    participants.push({id:entry.participant_id,created_at_ms:evaluation===null?0:evaluation.created_at_ms,status:status.status,reasons:status.reasons,
      primary_metric:evaluation!==null&&status.metrics_visible?evaluation.body.metrics.net_return_percent??null:null});
  }
  const decided=decideOutcome({mode:'STANDARDIZED',spec,spec_hash:input.spec_hash,context_key:input.context_key,participants,limitations:[CODES.VALUATION_BASIS_UNCONFIRMED]});
  if(!decided.ok)return decided;
  if(decided.outcome!=='NO_QUALIFIED_RESULT')return integrity('OUTCOME_NOT_ALLOWED');
  if(decided.participants.some(item=>evaluationMismatch(item.status,evaluations.get(item.id))))return integrity('OUTCOME_EVALUATION_MISMATCH');
  return decided;
}
