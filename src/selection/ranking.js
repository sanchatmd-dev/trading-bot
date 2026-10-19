import {CODES,INCOMPLETE_CODES,QR4_VERSIONS,MAX_PARTICIPANTS,MIN_PARTICIPANTS,isObject,isCount,isSha,text,dec,decString,norm,canonical,hash,digest,deepFreeze,byText} from './codes.js';
import {OBJECTIVE_REGISTRY} from './objective.js';
import {registrationHashOf} from './hash.js';
import {buildLabel,outcomeText,NO_WINNER_TEXT,NO_SIGNIFICANCE_SENTENCE} from './labels.js';

/**
 * The pure ranking function (contract section 7): rankSelection(registration, evaluations) -> outcome. No clock, no I/O, no
 * random source. The filters and tolerances are read from the registration's own copies. Comparisons use exact decimals, so
 * "1.10" equals "1.1". The only keys are the registered primary and secondary keys; parameter order, creation time, run id and
 * source name never break a tie. A participant that fails a filter never changes the ranks of the others. Any gap in the
 * evaluations ends the selection incomplete; there is no partial ranking and no ranking with fewer participants.
 *
 * Inputs beside the registration and the evaluations: the frozen W dataset hash (options.window_dataset_hash, read by the caller from
 * the freeze record of W). Every evaluation dataset hash must equal it; evaluations that only agree with each other prove nothing if
 * they all ran on the same wrong data. A missing frozen hash ends the selection incomplete with BI_DATASET_HASH_MISMATCH.
 * An unreadable or altered registration is INTEGRITY_CHECK_FAILED (section 10, detail REGISTRATION_UNREADABLE or REGISTRATION_HASH);
 * QR4_REGISTRATION_IMMUTABLE is the code of a change request to a registered selection and is not used here.
 */
export const INCOMPLETE_PRIORITY=INCOMPLETE_CODES;
const DECIMAL_METRICS=['net_return_percent','max_drawdown_percent'];
const NON_NEGATIVE_RESULT=['fees','slippage'];

const sub=(a,b)=>dec(a).minus(dec(b));
const within=(gap,tolerance)=>gap.lte(dec(tolerance));
const byEvaluationKeys=(a,b)=>dec(b.net_return_percent).cmp(dec(a.net_return_percent))||dec(a.max_drawdown_percent).cmp(dec(b.max_drawdown_percent))||(a.export_id<b.export_id?-1:a.export_id>b.export_id?1:0);

function incomplete(registration,problems,evaluationIds=[]){
  const order=item=>INCOMPLETE_PRIORITY.indexOf(item.code),who=item=>item.participant??'',what=item=>item.detail??'';
  const ordered=[...problems].sort((a,b)=>order(a)-order(b)||(who(a)<who(b)?-1:who(a)>who(b)?1:0)||(what(a)<what(b)?-1:what(a)>what(b)?1:0));
  const codes=[...new Set(ordered.map(item=>item.code))];
  return deepFreeze({status:'SELECTION_INCOMPLETE',outcome:null,code:codes[0],codes,problems:ordered,ranking:null,not_passed:null,label:null,
    registration_hash:isObject(registration)&&isSha(registration.registration_hash)?registration.registration_hash:null,
    completed_evaluation_ids:[...evaluationIds].sort(),version:QR4_VERSIONS.outcome});
}
const problem=(code,participant,detail)=>({code,participant:participant??null,detail:detail===undefined||detail===null?null:String(detail).slice(0,120)});

/** Read the registration's own copies; null when anything is unreadable. */
function readRegistration(registration){
  if(!isObject(registration)||registration.version!==QR4_VERSIONS.registration||!Array.isArray(registration.participants))return null;
  const count=registration.participants.length;
  if(count<MIN_PARTICIPANTS||count>MAX_PARTICIPANTS||registration.participant_count!==count)return null;
  if(!registration.participants.every(item=>isObject(item)&&text(item.export_id)&&text(item.run_id))||new Set(registration.participants.map(item=>item.export_id)).size!==count)return null;
  const objective=registration.objective,filters=registration.filters;
  if(!isObject(objective)||!Object.hasOwn(OBJECTIVE_REGISTRY,objective.id)||!isObject(filters))return null;
  const returnTol=decString(objective.tie_tolerance_return_pp),drawdownTol=decString(objective.tie_tolerance_drawdown_pp),limit=decString(filters.drawdown_limit_percent);
  if(!returnTol||!drawdownTol||!limit||returnTol.isNegative()||drawdownTol.isNegative()||!isCount(filters.episode_floor)||typeof filters.beats_buy_and_hold!=='boolean')return null;
  if(!isObject(registration.window)||!isCount(registration.window.evaluation_bars)||!text(registration.selection_id)||!isObject(registration.scope))return null;
  return {participants:registration.participants,count,tolerances:{return_pp:norm(returnTol),drawdown_pp:norm(drawdownTol)},limit:norm(limit),
    floor:filters.episode_floor,beats:filters.beats_buy_and_hold,expectedBars:registration.window.evaluation_bars,engine:registration.scope.engine};
}

/** Read one evaluation into plain checked values. Returns {values} or {problems}. */
function readEvaluation(evaluation,participant,read,registration,frozenDataset){
  const problems=[],id=participant.export_id;
  const bad=(code,detail)=>problems.push(problem(code,id,detail));
  if(evaluation.mode!==QR4_VERSIONS.evaluation_mode||evaluation.selection_id!==registration.selection_id||!text(evaluation.run_id))bad(CODES.INTEGRITY_CHECK_FAILED,'EVALUATION_IDENTITY');
  if(evaluation.status!=='SUCCEEDED')bad(CODES.QR4_EVALUATION_FAILED,/^[A-Z][A-Z0-9_]{1,63}$/.test(String(evaluation.status))?evaluation.status:'STATUS_UNREADABLE');
  const integrity=evaluation.integrity;
  if(!isObject(integrity)||integrity.contract_hash_verified!==true||integrity.report_matches_checkpoints!==true)bad(CODES.INTEGRITY_CHECK_FAILED,'INTEGRITY');
  const result=evaluation.result;
  if(!isObject(result)||!isSha(evaluation.result_hash)||digest(result)!==evaluation.result_hash)bad(CODES.INTEGRITY_CHECK_FAILED,'RESULT_HASH');
  if(!isSha(evaluation.engine_hash)||evaluation.engine_hash!==read.engine)bad(CODES.QR4_ENGINE_MISMATCH,'ENGINE');
  if(!isSha(evaluation.dataset_hash))bad(CODES.BI_DATASET_HASH_MISMATCH,'DATASET_HASH');
  else if(frozenDataset!==null&&evaluation.dataset_hash!==frozenDataset)bad(CODES.BI_DATASET_HASH_MISMATCH,'DATASET_HASH_DIFFERS');
  if(!isObject(result))return {problems};
  const metrics=isObject(result.metrics)?result.metrics:{};
  const values={export_id:id,run_id:participant.run_id,evaluation_run_id:evaluation.run_id,result_hash:evaluation.result_hash,dataset_hash:evaluation.dataset_hash};
  for(const key of DECIMAL_METRICS){
    const d=decString(metrics[key]);
    if(d===null||(key==='max_drawdown_percent'&&d.isNegative()&&!d.isZero()))bad(CODES.QR4_METRIC_MISSING,key);else values[key]=norm(metrics[key]);
  }
  for(const key of NON_NEGATIVE_RESULT){
    const d=decString(result[key]);
    if(d===null||(d.isNegative()&&!d.isZero()))bad(CODES.QR4_METRIC_MISSING,key);else values[key]=norm(result[key]);
  }
  if(decString(result.exposure_percent)===null)bad(CODES.QR4_METRIC_MISSING,'exposure_percent');else values.exposure_percent=norm(result.exposure_percent);
  for(const [key,source] of [['episodes',result.episodes],['closed_trades',metrics.closed_trades],['rejected_intents',result.rejected_intents],['evaluation_bars',result.evaluation_bars]]){
    if(!isCount(source))bad(CODES.QR4_METRIC_MISSING,key);else values[key]=source;
  }
  if(!isObject(result.cost_stress)||decString(result.cost_stress.net_return_percent)===null)bad(CODES.QR4_METRIC_MISSING,'cost_stress');
  else values.cost_stress_net_return_percent=norm(result.cost_stress.net_return_percent);
  for(const key of ['profit_factor','gross_profit','gross_loss']){
    values[key]=decString(metrics[key])===null?null:norm(metrics[key]);
  }
  if(!isObject(result.benchmark)||decString(result.benchmark.net_return_percent)===null)bad(CODES.QR4_BENCHMARK_UNAVAILABLE,'benchmark');
  else values.benchmark_net_return_percent=norm(result.benchmark.net_return_percent);
  if(isCount(values.evaluation_bars)&&values.evaluation_bars!==read.expectedBars)bad(CODES.QR4_WINDOW_DATA_GAP,'BAR_COUNT_DIFFERS');
  return problems.length>0?{problems}:{values};
}

/** Filters of 6.2 on one participant's values. Returns the failing filter codes in registry order. */
export function applyFilters(values,read){
  const failed=[];
  if(dec(values.max_drawdown_percent).gt(dec(read.limit)))failed.push(CODES.FILTER_DRAWDOWN_LIMIT);
  if(values.episodes<read.floor)failed.push(CODES.FILTER_EPISODE_FLOOR);
  if(dec(values.cost_stress_net_return_percent).isNegative()&&!dec(values.cost_stress_net_return_percent).isZero())failed.push(CODES.FILTER_COST_STRESS);
  if(!dec(values.net_return_percent).gt(0))failed.push(CODES.FILTER_NET_RETURN_POSITIVE);
  if(read.beats&&!dec(values.net_return_percent).gt(dec(values.benchmark_net_return_percent)))failed.push(CODES.FILTER_BEATS_BUY_AND_HOLD);
  return failed;
}

/**
 * Rank the passing participants (7.1 items 4 to 7). Each round anchors on the highest primary value of the remaining set, takes
 * every member within the primary tolerance, and splits that group by the secondary key anchored on its lowest drawdown. The group
 * that is left takes the next dense rank. Anchoring on the top (not on the neighbour above) keeps the result independent of input order.
 */
export function rankPassed(passed,tolerances){
  const remaining=[...passed].sort(byEvaluationKeys),ranked=[];
  let rank=1;
  while(remaining.length>0){
    const top=remaining[0].net_return_percent;
    const primary=remaining.filter(item=>within(sub(top,item.net_return_percent),tolerances.return_pp));
    let group,decidedBy;
    if(primary.length===1){group=primary;decidedBy='PRIMARY';}
    else{
      const low=primary.reduce((best,item)=>dec(item.max_drawdown_percent).lt(dec(best))?item.max_drawdown_percent:best,primary[0].max_drawdown_percent);
      group=primary.filter(item=>within(sub(item.max_drawdown_percent,low),tolerances.drawdown_pp));
      decidedBy=group.length===1?'SECONDARY':'TIE';
    }
    for(const item of group){ranked.push({rank,decided_by:decidedBy,...item});remaining.splice(remaining.indexOf(item),1);}
    rank++;
  }
  return ranked;
}

const DISPLAY=['net_return_percent','benchmark_net_return_percent','max_drawdown_percent','episodes','closed_trades','rejected_intents','fees','slippage','exposure_percent',
  'cost_stress_net_return_percent','evaluation_bars','profit_factor','gross_profit','gross_loss'];
const display=values=>Object.fromEntries(DISPLAY.map(key=>[key,values[key]]));

export function rankSelection(registration,evaluations,options={}){
  try{return rank(registration,evaluations,options);}
  catch{return incomplete(registration,[problem(CODES.INTEGRITY_CHECK_FAILED,null,'UNEXPECTED_INPUT')]);}
}
function rank(registration,evaluations,options){
  const read=readRegistration(registration);
  if(read===null||registration.registration_hash!==registrationHashOf(registration))return incomplete(registration,[problem(CODES.INTEGRITY_CHECK_FAILED,null,read===null?'REGISTRATION_UNREADABLE':'REGISTRATION_HASH')]);
  const frozenDataset=isObject(options)&&isSha(options.window_dataset_hash)?options.window_dataset_hash:null;
  if(!Array.isArray(evaluations))return incomplete(registration,[problem(CODES.QR4_EVALUATION_FAILED,null,'EVALUATIONS_UNREADABLE')]);
  const problems=[],values=[],doneIds=[];
  const known=new Set(read.participants.map(item=>item.run_id));
  for(const evaluation of evaluations){
    if(!isObject(evaluation)||!known.has(evaluation.parent_run_id))problems.push(problem(CODES.INTEGRITY_CHECK_FAILED,null,'UNKNOWN_EVALUATION'));
  }
  for(const participant of read.participants){
    const own=evaluations.filter(item=>isObject(item)&&item.parent_run_id===participant.run_id);
    if(own.length===0){problems.push(problem(CODES.QR4_EVALUATION_FAILED,participant.export_id,'EVALUATION_MISSING'));continue;}
    if(own.length>1){problems.push(problem(CODES.INTEGRITY_CHECK_FAILED,participant.export_id,'DUPLICATE_EVALUATION'));continue;}
    // Only an evaluation that SUCCEEDED counts as completed; a failed, timed-out or cancelled one does not.
    if(text(own[0].run_id)&&own[0].status==='SUCCEEDED')doneIds.push(own[0].run_id);
    const checked=readEvaluation(own[0],participant,read,registration,frozenDataset);
    if(checked.problems)problems.push(...checked.problems);else values.push(checked.values);
  }
  if(frozenDataset===null)problems.push(problem(CODES.BI_DATASET_HASH_MISMATCH,null,'FROZEN_DATASET_HASH_MISSING'));
  if(problems.length>0)return incomplete(registration,problems,doneIds);

  const results=values.map(item=>{
    const filters=applyFilters(item,read);
    const state=filters.length===0?'PASSED':filters.length===1&&filters[0]===CODES.FILTER_EPISODE_FLOOR?'EVIDENCE_INADEQUATE':'NOT_QUALIFYING_IN_SCOPE';
    return {...item,result:state,filter_codes:filters};
  });
  const passed=results.filter(item=>item.result==='PASSED');
  const ranking=rankPassed(passed,read.tolerances).map(item=>({rank:item.rank,decided_by:item.decided_by,export_id:item.export_id,run_id:item.run_id,
    evaluation_run_id:item.evaluation_run_id,net_return_percent:item.net_return_percent,max_drawdown_percent:item.max_drawdown_percent}));
  const notPassed=results.filter(item=>item.result!=='PASSED').sort(byText('export_id')).map(item=>({export_id:item.export_id,run_id:item.run_id,
    evaluation_run_id:item.evaluation_run_id,result:item.result,filter_codes:item.filter_codes}));
  let outcome;
  if(passed.length===0)outcome=results.every(item=>item.result==='EVIDENCE_INADEQUATE')?'INADEQUATE_EVIDENCE':'NO_QUALIFYING_STRATEGY';
  else outcome=ranking.filter(item=>item.rank===1).length===1?'BEST_IN_SCOPE':'TIED_IN_SCOPE';
  const body={version:QR4_VERSIONS.outcome,status:'SELECTION_COMPLETED',outcome,code:null,selection_id:registration.selection_id,registration_hash:registration.registration_hash,
    window_dataset_hash:frozenDataset,participant_count:read.count,passed_count:passed.length,
    passed_note:outcome==='BEST_IN_SCOPE'&&passed.length===1?'1 of '+read.count+' participants passed the filters':null,
    ranking,not_passed:notPassed,tolerances:read.tolerances,
    no_significance_sentence:ranking.length>0?NO_SIGNIFICANCE_SENTENCE:null,
    evaluations:[...results].sort(byText('export_id')).map(item=>({export_id:item.export_id,run_id:item.run_id,evaluation_run_id:item.evaluation_run_id,
      result_hash:item.result_hash,result:item.result,filter_codes:item.filter_codes,values:display(item)})),
    rulesets:{objective:registration.objective.id,scope:registration.scope.version,uncertainty:registration.objective.uncertainty,registration:registration.version,
      outcome:QR4_VERSIONS.outcome},
    text:outcomeText(outcome),no_winner_text:outcome==='NO_QUALIFYING_STRATEGY'||outcome==='INADEQUATE_EVIDENCE'?NO_WINNER_TEXT:null,
    fixture:registration.fixture===true};
  const label=buildLabel(registration,{...body});
  const full={...body,label};
  return deepFreeze({...full,outcome_hash:hash(canonical(full))});
}

/** Outcome replay (13.2): rank again on the frozen inputs. An equal outcome_hash passes; any difference is a replay mismatch event. */
export function replayOutcome(registration,evaluations,storedOutcomeHash,options={}){
  const again=rankSelection(registration,evaluations,options);
  const recomputed=again.status==='SELECTION_COMPLETED'?again.outcome_hash:null;
  const match=isSha(storedOutcomeHash)&&recomputed!==null&&recomputed===storedOutcomeHash;
  return deepFreeze({ok:true,match,recomputed_outcome_hash:recomputed,
    event:match?null:{kind:'SELECTION_REPLAY_MISMATCH',stored_outcome_hash:isSha(storedOutcomeHash)?storedOutcomeHash:null,recomputed_outcome_hash:recomputed,label_suppressed:true}});
}
