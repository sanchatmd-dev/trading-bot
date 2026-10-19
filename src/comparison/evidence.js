import {CODES,isObject,isInt,isNumber,text,decString,deepFreeze,refuse} from './common.js';

/**
 * Evidence class and independence (contract section 7), sample adequacy (6.3), the evaluation check (5.1 V8) and the fixed
 * participant status chain (8.2). Pure: every list (earlier holdouts, searched windows, the exposure register, library gates)
 * is an input array that a caller read from durable rows. Windows are half-open [start_ms, end_ms) in epoch milliseconds, so
 * two windows that only touch do not overlap. Unknown or unreadable input is a FAIL, never a pass.
 */
export const LIBRARY_GATE_NAMES=Object.freeze(['G1','G2','G3','G4','G5','G6','G7','G8']);
export const EXPOSURE_KINDS=Object.freeze(['QR3_COMPARISON','QR4_SELECTION']);
const validWindow=value=>isObject(value)&&isInt(value.start_ms)&&isInt(value.end_ms)&&value.end_ms>value.start_ms;
export const windowsOverlap=(a,b)=>validWindow(a)&&validWindow(b)&&a.start_ms<b.end_ms&&b.start_ms<a.end_ms;
const exposureId=entry=>text(entry.comparison_id)||text(entry.selection_id);
function readRegister(register){
  if(!Array.isArray(register))return null;
  for(const entry of register){
    if(!isObject(entry)||!text(entry.owner_id)||!text(entry.market_key)||!validWindow(entry.window)||!exposureId(entry)||!EXPOSURE_KINDS.includes(entry.kind)||!isInt(entry.at_ms))return null;
  }
  return register;
}
const counted=(entry,own,asOf)=>exposureId(entry)!==own&&(!isInt(asOf)||entry.at_ms<=asOf);

/** Exposure events of the register (same owner, same market, window overlap) that touch one window; own comparison and later events are ignored. */
export function exposuresOverlapping({register,owner_id:owner,market_key:market,window,comparison_id:own=null,as_of_ms:asOf=null}){
  const entries=readRegister(register);
  if(entries===null)return refuse(CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE);
  const hits=entries.filter(entry=>entry.owner_id===owner&&entry.market_key===market&&counted(entry,own,asOf)&&windowsOverlap(entry.window,window));
  return deepFreeze({ok:true,code:null,detail:null,ids:[...new Set(hits.map(exposureId))].sort(),events:hits.map(entry=>({id:exposureId(entry),kind:entry.kind,at_ms:entry.at_ms}))});
}
/** HOLDOUT_EXPOSED_BY_COMPARISON (section 7): the source run's holdout window overlaps an exposure event of the same owner and market. */
export function holdoutExposure(input){
  const request=isObject(input)?input:{};
  const overlap=exposuresOverlapping({register:request.exposure_register,owner_id:request.owner_id,market_key:request.market_key,window:request.holdout_window,
    comparison_id:request.comparison_id??null,as_of_ms:request.as_of_ms??null});
  if(!overlap.ok)return overlap;
  return deepFreeze({ok:true,exposed:overlap.ids.length>0,code:overlap.ids.length>0?CODES.HOLDOUT_EXPOSED_BY_COMPARISON:null,ids:overlap.ids});
}

function gateState(gates,name){
  if(!Array.isArray(gates))return {state:'FAIL',codes:[]};
  const found=gates.find(item=>isObject(item)&&item.gate===name);
  if(!found)return {state:'FAIL',codes:[]};
  return {state:found.state==='PASS'&&found.pass!==false?'PASS':'FAIL',codes:Array.isArray(found.codes)?found.codes.filter(code=>typeof code==='string'):[]};
}

/**
 * Evidence class of one participant for the declared window.
 * F3: the evaluation record must reference this comparison and this frozen spec (record_comparison_id equals comparison_id and
 * record_spec_hash equals spec_hash, else QR3_RESULT_PREDATES_SPEC; an absent or unreadable one is QR3_INTEGRITY_FAILED) and must be
 * created strictly after frozen_at_ms (a record created at the freeze instant predates the spec).
 * input: {participant_id, owner_id, market_key, source_hash, window, record_created_at_ms (null: no evaluation record),
 *   record_comparison_id, record_spec_hash, spec_hash, frozen_at_ms, as_of_ms, comparison_id, viewable_before_freeze, from_stored_view, imported, no_screened_candidate,
 *   earlier_holdouts:[{owner_id,market_key,window}], searched_windows:[{owner_id,source_hash,window}], source_holdout_window,
 *   exposure_register, registered_boundary_ms (null: none registered; integer: boundary; anything else is unreadable),
 *   library_gates:[{gate,state,codes}]}
 * Returns {evidence_class, reasons, failing_gates, gate_codes, exposed_by}; a missing or unreadable register refuses with
 * QR3_EXPOSURE_REGISTER_UNAVAILABLE (an empty register is valid). A record created at the freeze instant is not after it, so it
 * predates the spec (fail closed).
 */
export function classifyEvidence(input){
  const request=isObject(input)?input:{};
  const result=(evidenceClass,reasons,extra={})=>deepFreeze({ok:true,code:null,detail:null,evidence_class:evidenceClass,reasons:[...new Set(reasons)],failing_gates:[],gate_codes:[],
    exposed_by:[],...extra});
  if(request.no_screened_candidate===true)return result('NOT_EVALUATED',[CODES.QR3_NO_SCREENED_CANDIDATE]);
  if(request.record_created_at_ms===null||request.record_created_at_ms===undefined)return result('NOT_EVALUATED',[]);
  const register=readRegister(request.exposure_register);
  if(register===null)return refuse(CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE);
  const reasons=[];
  const unreadable=!text(request.owner_id)||!text(request.market_key)||!text(request.source_hash)||!validWindow(request.window)||!isInt(request.record_created_at_ms)||!isInt(request.frozen_at_ms)||
    !text(request.comparison_id)||!text(request.spec_hash)||!text(request.record_comparison_id)||!text(request.record_spec_hash);
  if(unreadable)return result('DEVELOPMENT_EVIDENCE',[CODES.QR3_INTEGRITY_FAILED]);
  const {owner_id:owner,market_key:market,source_hash:source,window}=request;
  if(request.record_created_at_ms<=request.frozen_at_ms||request.record_comparison_id!==request.comparison_id||request.record_spec_hash!==request.spec_hash||
    request.viewable_before_freeze!==false||request.from_stored_view===true)reasons.push(CODES.QR3_RESULT_PREDATES_SPEC);
  if(request.imported===true)reasons.push(CODES.QR3_NOT_QUALIFIED);
  const holdouts=request.earlier_holdouts,searched=request.searched_windows;
  const lists=Array.isArray(holdouts)&&Array.isArray(searched)&&holdouts.every(item=>isObject(item)&&validWindow(item.window)&&text(item.owner_id)&&text(item.market_key))&&
    searched.every(item=>isObject(item)&&validWindow(item.window)&&text(item.owner_id)&&text(item.source_hash));
  if(!lists)reasons.push(CODES.QR3_INTEGRITY_FAILED);
  else{
    if(holdouts.some(item=>item.owner_id===owner&&item.market_key===market&&windowsOverlap(item.window,window)))reasons.push(CODES.QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT);
    if(searched.some(item=>item.owner_id===owner&&item.source_hash===source&&windowsOverlap(item.window,window)))reasons.push(CODES.QR3_WINDOW_OVERLAPS_SEARCHED_DATA);
  }
  const own=request.comparison_id??null,asOf=request.as_of_ms??null;
  if(exposuresOverlapping({register,owner_id:owner,market_key:market,window,comparison_id:own,as_of_ms:asOf}).ids.length>0)reasons.push(CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED);
  const boundary=request.registered_boundary_ms;
  if(boundary===null){/* none registered */}
  else if(!isInt(boundary)||window.start_ms<boundary)reasons.push(CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY);
  let exposedBy=[];
  if(request.source_holdout_window!==undefined&&request.source_holdout_window!==null){
    const exposed=holdoutExposure({exposure_register:register,owner_id:owner,market_key:market,holdout_window:request.source_holdout_window,comparison_id:own,as_of_ms:asOf});
    if(exposed.exposed){reasons.push(CODES.HOLDOUT_EXPOSED_BY_COMPARISON);exposedBy=exposed.ids;}
  }
  const failing=LIBRARY_GATE_NAMES.map(name=>({gate:name,...gateState(request.library_gates,name)})).filter(item=>item.state!=='PASS');
  if(failing.length>0)reasons.push(CODES.QR3_NOT_QUALIFIED);
  return result(reasons.length===0?'INDEPENDENT':'DEVELOPMENT_EVIDENCE',reasons,{failing_gates:failing.map(item=>item.gate),
    gate_codes:[...new Set(failing.flatMap(item=>item.codes))],exposed_by:exposedBy});
}

/**
 * Sample adequacy (6.3). Only completed flat-to-flat episodes count; closed allocations never do (S4). A malformed adequacy spec FAILs
 * with QR3_SPEC_INCOMPLETE. Without the versioned episode gate the count is unknown and adequacy FAILs with QR3_EPISODE_GATE_NOT_AVAILABLE
 * (S5); with the gate but without a readable count (not an integer of at least 0) it FAILs with QR3_METRIC_UNAVAILABLE.
 * input: {completed_episodes, episode_gate_available, spec:{min_episodes_floor, min_episodes_ranking}}
 */
export function adequacy(input){
  const request=isObject(input)?input:{};
  const floor=request.spec?.min_episodes_floor,ranking=request.spec?.min_episodes_ranking;
  const answer=(state,status,code)=>deepFreeze({state,participant_status:status,code});
  if(!isInt(floor)||!isInt(ranking)||floor<1||ranking<floor)return answer('FAIL','INADEQUATE_SAMPLE',CODES.QR3_SPEC_INCOMPLETE);
  if(request.episode_gate_available!==true)return answer('FAIL','INADEQUATE_SAMPLE',CODES.QR3_EPISODE_GATE_NOT_AVAILABLE);
  if(!isInt(request.completed_episodes)||request.completed_episodes<0)return answer('FAIL','INADEQUATE_SAMPLE',CODES.QR3_METRIC_UNAVAILABLE);
  if(request.completed_episodes<floor)return answer('FAIL','INADEQUATE_SAMPLE',CODES.QR3_SAMPLE_INADEQUATE);
  if(request.completed_episodes<ranking)return answer('FAIL','DEVELOPMENT_EVIDENCE',CODES.QR3_SAMPLE_INADEQUATE);
  return answer('PASS',null,null);
}

/** Metrics the report needs before a participant counts as evaluated (11.1 item 5 minus episodes, which adequacy owns). */
export const REQUIRED_METRICS=Object.freeze(['net_return_percent','max_drawdown_percent','total_fees','total_slippage','exposure_percent','rejected_intents']);
const present=value=>value!==null&&value!==undefined&&!(isObject(value)&&(value.value===null||value.value===undefined));
/**
 * Evaluation check (V8): FAIL with VALUATION_BASIS_UNCONFIRMED until root confirms the valuation basis (RD-5), and FAIL with
 * METRIC_NOT_RECORDED for every required metric that is null or absent. This is a gap, never a pass.
 */
export function evaluationCheck(input){
  const {basis_confirmed:confirmed,metrics}=isObject(input)?input:{};
  const codes=[],missing=[];
  if(confirmed!==true)codes.push(CODES.VALUATION_BASIS_UNCONFIRMED);
  const source=isObject(metrics)?metrics:{};
  for(const name of REQUIRED_METRICS)if(!present(source[name]))missing.push(name);
  if(missing.length>0)codes.push(CODES.METRIC_NOT_RECORDED);
  return deepFreeze({state:codes.length===0?'PASS':'FAIL',codes,missing});
}
/** Report view of metrics: a null is {value:null, reason:'METRIC_NOT_RECORDED'}, never 0. */
export function metricsView(metrics){
  const source=isObject(metrics)?metrics:{};
  const view={};
  for(const name of [...REQUIRED_METRICS,'completed_episodes','closed_allocations'])view[name]=present(source[name])?{value:isObject(source[name])?source[name].value:source[name],reason:null}:{value:null,reason:CODES.METRIC_NOT_RECORDED};
  return deepFreeze(view);
}

export const CHECK_ORDER=Object.freeze(['integrity','compatibility','coverage','evaluation','evidence','adequacy','risk']);
const HIDDEN_METRICS=new Set(['EXCLUDED_INCOMPATIBLE','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','UNAVAILABLE','NOT_EVALUATED']);
/**
 * The fixed participant status chain (8.2): integrity, compatibility, coverage, evaluation, evidence class, adequacy, risk
 * filter. The first failing check decides the status; later checks are NOT_REACHED. A participant that passes all seven is
 * ELIGIBLE_QUALIFIED. NOT_EVALUATED means no evaluation record. A participant whose record exists but fails the evaluation check (V8)
 * is DEVELOPMENT_EVIDENCE with VALUATION_BASIS_UNCONFIRMED and/or METRIC_NOT_RECORDED; its recorded metrics stay visible in
 * metrics (a missing one is null with METRIC_NOT_RECORDED), it is never ranked and later checks are NOT_REACHED. Metrics are hidden
 * for EXCLUDED_INTEGRITY, EXCLUDED_INCOMPATIBLE, EXCLUDED_COVERAGE, UNAVAILABLE and NOT_EVALUATED.
 * input: {integrity_ok, unavailable, compatibility:{compatible}, coverage:{state}, has_evaluation, evaluation:{basis_confirmed,metrics},
 *   evidence:{evidence_class,reasons}, completed_episodes, episode_gate_available,
 *   spec:{min_episodes_floor,min_episodes_ranking,max_drawdown_percent}, max_drawdown_percent_exact}
 */
export function participantStatus(input){
  const request=isObject(input)?input:{};
  const checks=Object.fromEntries(CHECK_ORDER.map(name=>[name,'NOT_REACHED']));
  const finish=(status,reasons,metrics=null)=>deepFreeze({status,reasons:[...new Set(reasons)],checks,metrics_visible:!HIDDEN_METRICS.has(status),
    metrics:HIDDEN_METRICS.has(status)?null:metrics});
  if(request.unavailable===true)return finish('UNAVAILABLE',[CODES.QR3_PARTICIPANT_UNAVAILABLE]);
  const step=(name,pass)=>{checks[name]=pass?'PASS':'FAIL';return pass;};
  if(!step('integrity',request.integrity_ok===true))return finish('EXCLUDED_INTEGRITY',[CODES.QR3_INTEGRITY_FAILED]);
  if(!step('compatibility',request.compatibility?.compatible===true))return finish('EXCLUDED_INCOMPATIBLE',[CODES.QR3_CONTEXT_MISMATCH]);
  if(!step('coverage',request.coverage?.state==='PASS'))return finish('EXCLUDED_COVERAGE',[CODES.QR3_COVERAGE_INCOMPLETE]);
  if(request.has_evaluation!==true){checks.evaluation='FAIL';return finish('NOT_EVALUATED',request.evidence?.reasons??[]);}
  const shown=metricsView(request.evaluation?.metrics);
  const evaluated=evaluationCheck(request.evaluation);
  if(!step('evaluation',evaluated.state==='PASS'))return finish('DEVELOPMENT_EVIDENCE',evaluated.codes,shown);
  if(!step('evidence',request.evidence?.evidence_class==='INDEPENDENT'))return finish('DEVELOPMENT_EVIDENCE',request.evidence?.reasons?.length?request.evidence.reasons:[CODES.QR3_NOT_QUALIFIED],shown);
  const sample=adequacy({completed_episodes:request.completed_episodes,episode_gate_available:request.episode_gate_available,spec:request.spec});
  if(!step('adequacy',sample.state==='PASS'))return finish(sample.participant_status,[sample.code],shown);
  const recorded=request.evaluation?.metrics?.max_drawdown_percent;
  const source=request.max_drawdown_percent_exact??(isObject(recorded)?recorded.value:recorded),limitSource=request.spec?.max_drawdown_percent;
  const drawdown=decString(source),limit=decString(limitSource);
  /* Fail closed: a number in the threshold or in the drawdown source, or an unreadable threshold, is a spec problem (QR3_SPEC_INCOMPLETE), so decideOutcome refuses. */
  const specUnreadable=limit===null||isNumber(limitSource)||isNumber(source);
  if(!step('risk',!specUnreadable&&drawdown!==null&&drawdown.lte(limit)))return finish('FILTERED_RISK',[specUnreadable?CODES.QR3_SPEC_INCOMPLETE:drawdown===null?CODES.QR3_METRIC_UNAVAILABLE:CODES.QR3_RISK_FILTER_FAILED],shown);
  return finish('ELIGIBLE_QUALIFIED',[],shown);
}
