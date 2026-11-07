import {CODES,QR4_VERSIONS,MINUTE,canonical,isObject,isInt,isSha,isCount,text,dec,decString,digest,deepFreeze,refuse} from '../selection/codes.js';
import {Money,CODES as QR3_CODES,isNumber,round12,round18} from '../comparison/common.js';
import {valueRun,buyAndHold} from '../comparison/valuation.js';

/**
 * QR-4 slice Q4-A (docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md 5.4, 6.2, 7.1, 10; Root ruling SB203): the pure half of the evaluation orchestration.
 * selectionEvaluationOf turns the stored result of one terminal fixed-evaluation run of a selection into the evaluation object that rankSelection reads
 * (src/selection/ranking.js). Nothing here reads a database, file, network, clock or random source, and nothing in src imports this module yet (the wiring
 * slice does that later, under its own owner GO). It is not exported from src/selection/index.js.
 *
 * The figures are not copied from the evaluator. They come from the standardized valuation of the QR-3 module (valueRun on the base step and on the stress step,
 * buyAndHold on the same grid and base cost), after the same exact-decimal cross-check of every evaluator figure against that valuation (restated here from the
 * QR-3 evaluation record; this module does not import it, so a change there cannot move QR-4). Basis ruling RR-Q4-2: the QR-3 V8 hold is not discharged, so every
 * valuation call passes basis_confirmed false, every result states basis_confirmed false and the limitation VALUATION_BASIS_UNCONFIRMED, and no input can turn it on.
 *
 * Metric mapping (RR-Q4-5, SB203 item 2): net return, max drawdown, fees, slippage and exposure percent from valueRun on the base step; cost stress from valueRun on
 * the stress step; Buy & Hold from buyAndHold; episodes = base.episodes.completed_count; rejected intents = base.rejected.intents_total; closed trades =
 * base.closed_allocations (the same figure as closed_allocations of the QR-3 evaluation record; a test pins both); evaluation bars = split.evaluated_bars.
 * The fixed-evaluation contract names the mode FIXED_INPUT_EVAL with the purpose QR4_SELECTION; the evaluation object carries the mode QR4_SELECTION_EVAL (RR-Q4-4).
 *
 * Two kinds of answer:
 *  - {ok:true, evaluation}: an evaluation for rankSelection. A run that did not SUCCEED becomes an evaluation with that status, so rankSelection ends the selection
 *    with QR4_EVALUATION_FAILED. A count that is absent or has the wrong type is stored as null and a benchmark that cannot be computed as a null line, so rankSelection
 *    ends it with QR4_METRIC_MISSING or QR4_BENCHMARK_UNAVAILABLE. Nothing is repaired, nothing becomes zero.
 *  - a refusal {ok:false, code, detail}: the input is not the record of this selection's run, or a figure does not survive the cross-check. Nothing is built.
 *    INTEGRITY_CHECK_FAILED carries the detail, QR4_METRIC_MISSING stands for a number where a decimal string is required or a valuation that cannot be made, and
 *    INVALID_FIELDS for a malformed call. The function never throws.
 *
 * input: {registration, evaluation_run_id, fixed_contract, binding, fixed_result, rows, run_status}; every key is required (a run that did not succeed passes null
 * for binding, fixed_result and rows). registration is the stored registration of the selection (window and participants are read from it). rows are the dataset
 * rows read through the verified binding of that run: exactly bar_count rows, rows[i].time = first_time + i * 60000.
 * deps: {validateFixedEvalContract, validateFixedEvalResult}, the validators of the fixed-evaluation contract. They are a required argument, so this module names no
 * guarded evaluation module (the importer guard of the evaluation closure test); a missing or non-function validator refuses INTEGRITY_CHECK_FAILED, VALIDATOR_MISSING.
 */
export const EVALUATION_ADAPTER_VERSION='qr4-selection-evaluation-adapter-v1';
/** The limitation every result records while the V8 hold stands. */
export const VALUATION_LIMITATION=QR3_CODES.VALUATION_BASIS_UNCONFIRMED;
/** Run statuses that end a run (quant_jobs): the adapter accepts these and no others. */
export const TERMINAL_RUN_STATUSES=Object.freeze(['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);

const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PURPOSE='QR4_SELECTION';
/** Restated from the fixed-evaluation contract (this module must not import it); a test pins both to the contract exports. */
const CLOSURE_VERSION='fixed-eval-closure-v1';
const CONTRACT_MODE='FIXED_INPUT_EVAL';
const INPUT_KEYS=Object.freeze(['registration','evaluation_run_id','fixed_contract','binding','fixed_result','rows','run_status']);
const NUMBER_DETAIL='NUMBER_NOT_DECIMAL_STRING';

const idOk=value=>typeof value==='string'&&ID.test(value);
const invalid=detail=>refuse(CODES.INVALID_FIELDS,detail);
const integrity=detail=>refuse(CODES.INTEGRITY_CHECK_FAILED,detail);
const hasKeys=(value,names)=>isObject(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const hasBasisKey=value=>isObject(value)&&Object.hasOwn(value,'basis_confirmed');
const hasValidators=deps=>isObject(deps)&&['validateFixedEvalContract','validateFixedEvalResult'].every(name=>typeof deps[name]==='function');

/** The parts of the stored registration that this module reads, or null when any of them is unreadable. */
function readRegistration(registration){
  if(!isObject(registration)||!text(registration.selection_id)||!isObject(registration.window)||!isObject(registration.scope)||!isSha(registration.scope.engine))return null;
  const window=registration.window;
  if(![window.start_ms,window.end_ms,window.warmup_bars,window.evaluation_bars,window.total_bars].every(isInt)||window.end_ms<=window.start_ms)return null;
  if(window.start_ms%MINUTE!==0||window.end_ms%MINUTE!==0||(window.end_ms-window.start_ms)/MINUTE!==window.evaluation_bars||window.warmup_bars+window.evaluation_bars!==window.total_bars)return null;
  if(!Array.isArray(registration.participants)||registration.participants.length===0||!registration.participants.every(item=>isObject(item)&&text(item.run_id)))return null;
  return {selectionId:registration.selection_id,window,runIds:new Set(registration.participants.map(item=>item.run_id))};
}

/**
 * Time translation. Dataset times are closed-bar timestamps; the QR-4 window names bar-open times (the half-open interval [start_ms, end_ms)) and the grid of the
 * standardized valuation uses bar-open times. The dataset starts at start_ms minus the warm-up bars plus one minute, the scored rows are rows[warmup] to
 * rows[count - 1], the grid is {time_ms: row.time - 60000, close}, and the period of the grid must be exactly the registered window. Any other shape is WINDOW_MISMATCH.
 */
function scoredWindow(contract,window,rows,evaluatedBars){
  const {first_time:first,bar_count:count,warmup_bars:warmup}=contract.dataset;
  if(count!==window.total_bars||warmup!==window.warmup_bars||first!==window.start_ms-warmup*MINUTE+MINUTE||evaluatedBars!==window.evaluation_bars)return integrity('WINDOW_MISMATCH');
  if(!Array.isArray(rows)||rows.length!==count||rows.some((row,index)=>!isObject(row)||row.time!==first+index*MINUTE))return integrity('WINDOW_MISMATCH');
  const scored=rows.slice(warmup,count);
  const grid=scored.map(row=>({time_ms:row.time-MINUTE,close:row.close}));
  const period={start_ms:scored[0].time-MINUTE,end_ms:scored[scored.length-1].time};
  if(period.start_ms!==window.start_ms||period.end_ms!==window.end_ms||grid.length!==window.evaluation_bars)return integrity('WINDOW_MISMATCH');
  return {ok:true,grid,period};
}

const fillHasNumber=fill=>isObject(fill)&&[fill.quantity,fill.price,fill.fee,fill.slippage_cost_incl_tick].some(isNumber);
const stepHasNumber=step=>[step.initial_equity,step.metrics.end_equity,step.metrics.net_return_percent,step.metrics.max_drawdown_percent,step.exposure.fraction,step.fees_total,
  step.slippage_cost_incl_tick_total].some(isNumber)||step.fills.some(fillHasNumber);
const gridHasNumber=grid=>grid.some(bar=>isNumber(bar.close));

/** Exact-decimal equality: never a float, never a tolerance. An unreadable or missing figure on either side is a difference. */
function equal(left,right){
  const a=decString(left);
  const b=typeof right==='string'?dec(right):right;
  return a!==null&&b!==null&&b!==undefined&&a.eq(b);
}
/** Cross-check of one evaluator step against its valueRun output; returns the detail of the first difference, or null. */
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
  // The in-market count is an integer, the fraction is that count over the bars at 18 places (the evaluator rule) and the exposure percent is the count over the
  // bars at 12 places. Distinct counts differ by at least 100 / bars, so this pins the count exactly.
  if(!isInt(inMarket))return 'CROSS_CHECK_EXPOSURE';
  const share=new Money(inMarket).div(valued.bars);
  if(!equal(step.exposure.fraction,round18(share))||!equal(valued.exposure_percent,round12(share.mul(100))))return 'CROSS_CHECK_EXPOSURE';
  return null;
}

/**
 * A valuation that cannot be made becomes a refusal with a QR-4 code: a gapped grid and an unreadable grid are both a window data gap (a bar of the frozen, verified window whose close cannot be read is an incomplete bar; QR4_WINDOW_DATA_UNAVAILABLE is only for a window that was never available before the first start and the adapter never emits it), and
 * every other reason (an unreadable fill, a negative position, an unknown fill order, a flow) is a metric that cannot be computed. The original code and detail
 * stay in the detail so the cause is not lost.
 */
const VALUATION_CODES=Object.freeze({[QR3_CODES.QR3_DATASET_GAPPED]:CODES.QR4_WINDOW_DATA_GAP,[QR3_CODES.QR3_DATASET_UNAVAILABLE]:CODES.QR4_WINDOW_DATA_GAP});
function valuationRefusal(answer){
  const code=VALUATION_CODES[answer.code]??CODES.QR4_METRIC_MISSING;
  return refuse(code,[answer.code,answer.detail].filter(item=>typeof item==='string').join(':').slice(0,120));
}

/** The valuation figures that the result keeps; the series of NAV points stays out (it is large and nothing reads it). */
const summary=valued=>({version:valued.version,grid_id:valued.grid_id,end_treatment:valued.end_treatment,bars:valued.bars,start_nav:valued.start_nav,end_nav:valued.end_nav,
  net_return_percent_exact:valued.net_return_percent_exact,max_drawdown_percent_exact:valued.max_drawdown_percent_exact});
/** A count that is a non-negative integer, else null (rankSelection then ends the selection with QR4_METRIC_MISSING and the name of the figure). */
const count=value=>isCount(value)?value:null;

/** The evaluation of a run that did not succeed: rankSelection reads the status and ends the selection with QR4_EVALUATION_FAILED. */
function failedEvaluation(registration,input,deps){
  let contract;
  try{contract=deps.validateFixedEvalContract(input.fixed_contract);}catch{return integrity('FIXED_CONTRACT_INVALID');}
  const refused=checkLineage(registration,contract);
  if(refused)return refused;
  return {ok:true,code:null,detail:null,evaluation:deepFreeze({mode:QR4_VERSIONS.evaluation_mode,selection_id:registration.selectionId,run_id:input.evaluation_run_id,
    parent_run_id:contract.lineage.parent_run_id,status:input.run_status,integrity:{contract_hash_verified:false,report_matches_checkpoints:false},engine_hash:contract.engine_hash,
    dataset_hash:null,result:null,result_hash:null})};
}

/** Purpose, selection and participant of the contract (the lineage of the run): null when it is the run of one participant of this selection. */
function checkLineage(registration,contract){
  if(contract.mode!==CONTRACT_MODE||contract.purpose!==PURPOSE)return integrity('PURPOSE');
  if(contract.lineage.object_id!==registration.selectionId)return integrity('LINEAGE_OBJECT');
  if(!registration.runIds.has(contract.lineage.parent_run_id))return integrity('PARTICIPANT_NOT_IN_REGISTRATION');
  return null;
}

function build(input,deps){
  if(!hasValidators(deps))return integrity('VALIDATOR_MISSING');
  if(hasBasisKey(input))return invalid('BASIS_CONFIRMED');
  if(!hasKeys(input,INPUT_KEYS))return invalid('INPUT');
  const registration=readRegistration(input.registration);
  if(registration===null)return integrity('REGISTRATION_UNREADABLE');
  if(!idOk(input.evaluation_run_id))return integrity('EVALUATION_RUN_ID');
  if(!TERMINAL_RUN_STATUSES.includes(input.run_status))return invalid('RUN_STATUS');
  if(input.run_status!=='SUCCEEDED')return failedEvaluation(registration,input,deps);

  let contract,result;
  try{
    contract=deps.validateFixedEvalContract(input.fixed_contract);
    result=deps.validateFixedEvalResult(contract,input.binding,input.fixed_result);
  }catch{return integrity('FIXED_RESULT_INVALID');}
  const {base,stress}=result;
  const lineage=checkLineage(registration,contract);
  if(lineage)return lineage;
  if(result.mode!==CONTRACT_MODE||result.purpose!==PURPOSE)return integrity('PURPOSE');
  const participant=contract.lineage.parent_run_id;
  if(result.lineage.object_id!==registration.selectionId)return integrity('LINEAGE_OBJECT');
  if(result.lineage.parent_run_id!==participant||base.parent_run_id!==participant||stress.parent_run_id!==participant)return integrity('LINEAGE_PARENT');
  if(base.selection_id!==registration.selectionId||stress.selection_id!==registration.selectionId)return integrity('SELECTION_ID');
  if(result.evaluation_closure.version!==CLOSURE_VERSION)return integrity('CLOSURE_VERSION');
  if(canonical(base.split)!==canonical(stress.split))return integrity('SPLIT_MISMATCH');
  const window=scoredWindow(contract,registration.window,input.rows,base.split.evaluated_bars);
  if(!window.ok)return window;
  if(stepHasNumber(base)||stepHasNumber(stress)||gridHasNumber(window.grid))return refuse(CODES.QR4_METRIC_MISSING,NUMBER_DETAIL);
  for(const step of [base,stress]){
    if(step.fills.some(fill=>!isObject(fill)||!isInt(fill.time)||fill.bar_time_ms!==fill.time-MINUTE))return integrity('FILL_TIME_TRANSLATION');
  }
  const cash=decString(contract.capital.initial_cash),equity=decString(base.initial_equity);
  if(cash===null||equity===null||!cash.eq(equity))return integrity('CASH_EQUITY');
  const value=step=>valueRun({initial_cash:contract.capital.initial_cash,period:window.period,grid:window.grid,flows:[],basis_confirmed:false,
    fills:step.fills.map(fill=>({bar_time_ms:fill.bar_time_ms,side:fill.side,quantity:fill.quantity,price:fill.price,fee:fill.fee,sequence:fill.sequence,
      slippage_cost:fill.slippage_cost_incl_tick}))});
  const valued=value(base);
  if(!valued.ok)return valuationRefusal(valued);
  const stressed=value(stress);
  if(!stressed.ok)return valuationRefusal(stressed);
  const difference=crossCheck(base,valued)||crossCheck(stress,stressed);
  if(difference!==null)return integrity(difference);

  const model=contract.cost_model;
  const line=buyAndHold({initial_cash:contract.capital.initial_cash,period:window.period,grid:window.grid,data_model:{price_tick:model.price_tick,quantity_step:model.quantity_step},
    cost_model:{fee_bps:model.fee_bps,slippage_bps:model.slippage_bps},basis_confirmed:false,include_liquidation_line:false});
  const benchmark=line.ok===true
    ?{ok:true,code:null,detail:null,version:line.version,method:line.method,net_return_percent:line.net_return_percent,net_return_percent_exact:line.net_return_percent_exact,
      max_drawdown_percent:line.max_drawdown_percent,entry:line.entry,valuation:summary(line.valuation)}
    :{ok:false,code:line.code??null,detail:line.detail??null,net_return_percent:null};

  const {rejected,episodes}=base;
  const orphans=isObject(rejected)&&isObject(rejected.orphan_exits)?Object.values(rejected.orphan_exits):null;
  // The evaluator reports intents_total as the total minus the orphan exits; a figure that does not agree with its own parts is not a count.
  const intents=isObject(rejected)&&isCount(rejected.intents_total)&&isCount(rejected.total)&&orphans!==null&&orphans.every(isCount)&&
    rejected.intents_total===rejected.total-orphans.reduce((sum,item)=>sum+item,0)?rejected.intents_total:null;
  const completed=isObject(episodes)&&isCount(episodes.completed_count)&&Array.isArray(episodes.completed)&&episodes.completed_count===episodes.completed.length?episodes.completed_count:null;

  const body={evaluation_bars:base.split.evaluated_bars,
    metrics:{net_return_percent:valued.net_return_percent,max_drawdown_percent:valued.max_drawdown_percent,closed_trades:count(base.closed_allocations)},
    episodes:completed,rejected_intents:intents,fees:valued.total_fees,slippage:valued.total_slippage.value,exposure_percent:valued.exposure_percent,
    cost_stress:{net_return_percent:stressed.net_return_percent},benchmark,
    basis_confirmed:false,limitations:[...new Set([...valued.limitations,...stressed.limitations,...(line.ok===true?line.valuation.limitations:[]),VALUATION_LIMITATION])].sort(),
    valuation:summary(valued),stress_valuation:summary(stressed),adapter_version:EVALUATION_ADAPTER_VERSION,
    engine_closure:{version:result.evaluation_closure.version,hash:result.evaluation_closure.hash}};
  const resultHash=digest(body);
  if(resultHash===null)return integrity('RESULT_UNHASHABLE');
  return {ok:true,code:null,detail:null,evaluation:deepFreeze({mode:QR4_VERSIONS.evaluation_mode,selection_id:registration.selectionId,run_id:input.evaluation_run_id,
    parent_run_id:participant,status:'SUCCEEDED',integrity:{contract_hash_verified:true,report_matches_checkpoints:true},engine_hash:result.engine_hash,
    dataset_hash:result.dataset_sha256,result:body,result_hash:resultHash})};
}

/** Never throws: an input that breaks an assumption of the pure code is refused as INTEGRITY_CHECK_FAILED, UNEXPECTED_INPUT. */
export function selectionEvaluationOf(input,deps){
  try{return build(input,deps);}catch{return integrity('UNEXPECTED_INPUT');}
}

/**
 * Refusal codes of the adapter that end a selection (contract 7.1 item 1, sections 10 and RC-S3) once the finalizer has confirmed them with a second read of the same
 * run through the same dependencies: a record that fails the integrity checks, a figure that is not a decimal string or cannot be valued (QR4_METRIC_MISSING), and a
 * window whose bars cannot be read complete after the freeze (QR4_WINDOW_DATA_GAP). The adapter never emits QR4_WINDOW_DATA_UNAVAILABLE (an unreadable close
 * maps to QR4_WINDOW_DATA_GAP), so no ending code is missing from this list.
 */
export const ENDING_REFUSAL_CODES=Object.freeze([CODES.INTEGRITY_CHECK_FAILED,CODES.QR4_METRIC_MISSING,CODES.QR4_WINDOW_DATA_GAP]);

/**
 * The evaluation that stands for a terminal run whose record the adapter refused for good, built only from facts the caller already holds (the start row of the
 * participant, the run status and the refusal), so rankSelection ends the selection with the matching code and its own detail:
 *  - INTEGRITY_CHECK_FAILED: integrity flags false and no result, so rankSelection reads INTEGRITY_CHECK_FAILED.
 *  - QR4_METRIC_MISSING: integrity flags true and a result that holds no figure, so rankSelection reads QR4_METRIC_MISSING for each missing figure.
 *  - QR4_WINDOW_DATA_GAP: integrity flags true and a result whose evaluation_bars is a count that differs from the registered one (expected_bars plus one; it is a
 *    marker, not a measurement), so rankSelection reads QR4_WINDOW_DATA_GAP, which ranks before the missing figures. Needs a non-negative integer expected_bars.
 * status is the real status of the run (default SUCCEEDED): a run that did not succeed keeps it, so rankSelection ends the selection QR4_EVALUATION_FAILED, which ranks
 * before every code above. The adapter code and detail stay in adapter_refusal. Pure; returns null for any other refusal code, an unreadable identity or a status that
 * is not a terminal run status.
 */
export function refusedEvaluation({selection_id:selectionId,run_id:runId,parent_run_id:parentRunId,engine_hash:engineHash,dataset_hash:datasetHash,refusal,status='SUCCEEDED',expected_bars:expectedBars=null}){
  if(!isObject(refusal)||!ENDING_REFUSAL_CODES.includes(refusal.code)||![selectionId,runId,parentRunId].every(text)||!TERMINAL_RUN_STATUSES.includes(status))return null;
  const gap=refusal.code===CODES.QR4_WINDOW_DATA_GAP;
  if(gap&&!isCount(expectedBars))return null;
  const detail=typeof refusal.detail==='string'?refusal.detail.slice(0,120):null;
  const figures=refusal.code!==CODES.INTEGRITY_CHECK_FAILED;
  const result=figures?{refused:{code:refusal.code,detail},adapter_version:EVALUATION_ADAPTER_VERSION,...(gap?{evaluation_bars:expectedBars+1}:{})}:null;
  const resultHash=figures?digest(result):null;
  if(figures&&resultHash===null)return null;
  return deepFreeze({mode:QR4_VERSIONS.evaluation_mode,selection_id:selectionId,run_id:runId,parent_run_id:parentRunId,status,
    integrity:{contract_hash_verified:figures,report_matches_checkpoints:figures},engine_hash:engineHash,dataset_hash:datasetHash,result,result_hash:resultHash,
    adapter_refusal:{code:refusal.code,detail}});
}
