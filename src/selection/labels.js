import {isObject,isInt,text,deepFreeze,utcOf,byCreation} from './codes.js';

/**
 * Label rules (contract section 11) and read-time overlays (8.2). The server builds the label text; a UI renders it exactly and
 * composes none. A label exists only on a completed selection with outcome BEST_IN_SCOPE or TIED_IN_SCOPE, only for the rank 1
 * participants, and never on a fixture selection (OD-S15). The word "best" never appears without the scope phrase.
 */
export const SCOPE_PHRASE='within the selected scope';
export const NO_QUALIFYING_TEXT='No qualifying strategy within the selected scope.';
export const INADEQUATE_EVIDENCE_TEXT='Evidence is not adequate to rank within the selected scope.';
export const NO_WINNER_TEXT='Qualified recommendations: none. No qualified winner.';
export const EXPOSURE_SENTENCE='This selection used the period W. That period is now development evidence. A claim about another period needs new independent data.';
export const NO_SIGNIFICANCE_SENTENCE='No statistical significance is claimed.';
export const NO_PROFIT_SENTENCE='This is not a profitability claim or a forecast.';
export const DEVELOPMENT_PANEL_TEXT='Development scores, not a ranking.';
export const OVERLAYS=Object.freeze(['WINNER_NOT_READY','SELECTION_REPLAY_MISMATCH','RULESET_SUPERSEDED']);
export const bestLabelText=count=>'Best of '+count+' compared strategies '+SCOPE_PHRASE;
export const tiedLabelText=count=>'Tied for best of '+count+' compared strategies '+SCOPE_PHRASE;

/** Section 11.2 item 4: the scope statement that always sits beside a label. Plain values only. */
export function scopeStatement(registration){
  const r=isObject(registration)?registration:{};
  const w=isObject(r.window)?r.window:{},scope=isObject(r.scope)?r.scope:{},objective=isObject(r.objective)?r.objective:{};
  return deepFreeze({
    asset:isObject(r.market)?r.market.broker+':'+r.market.symbol+' '+r.market.timeframe+'m':null,
    window:{kind:w.kind??null,start_utc:isInt(w.start_ms)?utcOf(w.start_ms):null,end_utc:isInt(w.end_ms)?utcOf(w.end_ms):null,
      evaluation_bars:w.evaluation_bars??null,warmup_bars:w.warmup_bars??null,total_bars:w.total_bars??null},
    risk_profile:isObject(scope.policy)?scope.policy.policy_version:null,cost_model:scope.cost_model??null,capital:scope.capital??null,
    evaluation_basis:{valuation:isObject(scope.valuation)?scope.valuation.valuation:null,benchmark:isObject(scope.valuation)?scope.valuation.benchmark:null,
      evaluation_mode:'QR4_SELECTION_EVAL'},
    // Coverage (11.2 item 4): what the compared evaluations covered. A completed outcome has the exact bar count on every evaluation
    // (a different count ends the selection), so the evaluation bars of W are the coverage of each participant.
    coverage:{participants_compared:r.participant_count??null,universe_runs:Array.isArray(r.universe)?r.universe.length:null,evaluation_bars_each:w.evaluation_bars??null},
    objective_id:objective.id??null,filters:r.filters??null,
    tie_tolerances:{return_pp:objective.tie_tolerance_return_pp??null,drawdown_pp:objective.tie_tolerance_drawdown_pp??null},
    participant_count:r.participant_count??null,
    universe:[...(Array.isArray(r.universe)?r.universe:[])].sort(byCreation).map(item=>({run_id:item.run_id,export_id:item.export_id,status:item.status,code:item.code})),
    prior_selection_count:r.prior_selection_count??null});
}

/**
 * The label block of a completed outcome, or null. outcome: {status, outcome, ranking, participant_count}. A fixture selection never gets
 * one, and only the body of a SELECTION_COMPLETED outcome does. The fixed sentences travel with the label so that no view can show a
 * label without them. This function is internal to the module (index.js does not export it): the label is built inside rankSelection,
 * where the outcome_hash is computed over the label as well.
 */
export function buildLabel(registration,outcome){
  if(!isObject(registration)||!isObject(outcome)||registration.fixture===true||outcome.status!=='SELECTION_COMPLETED')return null;
  if(outcome.outcome!=='BEST_IN_SCOPE'&&outcome.outcome!=='TIED_IN_SCOPE')return null;
  const first=(Array.isArray(outcome.ranking)?outcome.ranking:[]).filter(item=>item.rank===1);
  if(first.length===0||!Number.isSafeInteger(outcome.participant_count))return null;
  const best=outcome.outcome==='BEST_IN_SCOPE';
  if(best&&first.length!==1)return null;
  if(!best&&first.length<2)return null;
  return deepFreeze({
    label_text:best?bestLabelText(outcome.participant_count):tiedLabelText(outcome.participant_count),
    participants:first.map(item=>item.export_id),
    scope_statement:scopeStatement(registration),
    exposure_sentence:EXPOSURE_SENTENCE,no_significance_sentence:NO_SIGNIFICANCE_SENTENCE,no_profitability_sentence:NO_PROFIT_SENTENCE});
}
/** Text of the outcomes without a label (section 7.2). */
export const outcomeText=code=>code==='NO_QUALIFYING_STRATEGY'?NO_QUALIFYING_TEXT:code==='INADEQUATE_EVIDENCE'?INADEQUATE_EVIDENCE_TEXT:null;

/**
 * Derived read overlays (8.2). They are computed at read time and never written over the status. facts:
 * {packages_ready:{export_id:boolean}, replay_mismatch:boolean, current_versions:{objective, scope}}. Anything unreadable suppresses
 * the label (OD-S13: suppress, and hide recommended values and links). RULESET_SUPERSEDED is information only.
 */
export function deriveOverlays(registration,outcome,facts){
  const r=isObject(registration)?registration:{},o=isObject(outcome)?outcome:{},f=isObject(facts)?facts:{};
  const overlays=[];
  const winners=(Array.isArray(o.ranking)?o.ranking:[]).filter(item=>item.rank===1).map(item=>item.export_id);
  const ready=isObject(f.packages_ready)?f.packages_ready:null;
  const labelled=o.outcome==='BEST_IN_SCOPE'||o.outcome==='TIED_IN_SCOPE';
  if(labelled&&(ready===null||winners.some(id=>ready[id]!==true)))overlays.push('WINNER_NOT_READY');
  if(typeof f.replay_mismatch!=='boolean'||f.replay_mismatch===true)overlays.push('SELECTION_REPLAY_MISMATCH');
  const current=isObject(f.current_versions)?f.current_versions:{};
  if(isObject(r.objective)&&isObject(r.scope)&&(current.objective!==r.objective.id||current.scope!==r.scope.version))overlays.push('RULESET_SUPERSEDED');
  const suppress=overlays.some(code=>code!=='RULESET_SUPERSEDED');
  return deepFreeze({overlays,label_visible:labelled&&!suppress&&r.fixture!==true&&text(o.label&&o.label.label_text)!==null,
    hide_recommended_values:suppress&&labelled,hide_package_links:overlays.includes('WINNER_NOT_READY')});
}
