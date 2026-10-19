import {CODES,DEVELOPMENT_VIEW_PARAMS,DEVELOPMENT_NAME_PREFIXES,EVALUATION_REQUEST_KEYS,INCOMPLETE_CODES,OUTCOMES,isObject,text,deepFreeze,refuse,keyTokens} from './codes.js';
import {findWeightKey} from './objective.js';

/**
 * Selection lifecycle and request guards (contract sections 3.3, 5.4, 8.1 and 12.2). All pure. Statuses are append-only events
 * in the database; the current status is the last event. Every transition not listed in TRANSITIONS is QR4_TRANSITION_INVALID.
 *
 * Three rows are not in the diagram of section 8.1 as written (REGISTERED with DEADLINE_PASSED, REGISTERED with WINDOW_DATA_UNAVAILABLE,
 * EVALUATING with PARTICIPANT_INELIGIBLE), but sections 4.3, 5.4 and 10 require these endings: a later participant becomes ineligible
 * while evaluation runs, the admission deadline passes before the first start, the W history is unavailable before the first start.
 * Root amends 8.1 under RO-4 with these three rows.
 */
export const TRANSITIONS=Object.freeze([
  {from:null,event:'REGISTER',to:'SELECTION_REGISTERED'},
  {from:'SELECTION_REGISTERED',event:'FIRST_EVALUATION_START',to:'SELECTION_EVALUATING'},
  {from:'SELECTION_REGISTERED',event:'OWNER_CANCEL',to:'SELECTION_CANCELLED'},
  {from:'SELECTION_REGISTERED',event:'PARTICIPANT_INELIGIBLE',to:'SELECTION_INCOMPLETE',codes:['QR4_PARTICIPANT_STALE']},
  {from:'SELECTION_REGISTERED',event:'WINDOW_RECHECK_FAILED',to:'SELECTION_INCOMPLETE',codes:['QR4_WINDOW_EXPOSED','QR4_WINDOW_OVERLAPS_SEARCHED_DATA']},
  {from:'SELECTION_REGISTERED',event:'DEADLINE_PASSED',to:'SELECTION_INCOMPLETE',codes:['QR4_ADMISSION_REFUSED']},
  {from:'SELECTION_REGISTERED',event:'WINDOW_DATA_UNAVAILABLE',to:'SELECTION_INCOMPLETE',codes:['QR4_WINDOW_DATA_UNAVAILABLE']},
  {from:'SELECTION_EVALUATING',event:'PARTICIPANT_INELIGIBLE',to:'SELECTION_INCOMPLETE',codes:['QR4_PARTICIPANT_STALE']},
  {from:'SELECTION_EVALUATING',event:'ALL_EVALUATIONS_DONE',to:['SELECTION_COMPLETED','SELECTION_INCOMPLETE'],codes:INCOMPLETE_CODES},
  {from:'SELECTION_EVALUATING',event:'OWNER_CANCEL',to:'SELECTION_CANCELLED'},
  {from:'SELECTION_EVALUATING',event:'DEADLINE_PASSED',to:'SELECTION_INCOMPLETE',codes:['QR4_ADMISSION_REFUSED','QR4_EVALUATION_FAILED']},
  {from:'SELECTION_EVALUATING',event:'WINDOW_RECHECK_FAILED',to:'SELECTION_INCOMPLETE',codes:['QR4_WINDOW_EXPOSED','QR4_WINDOW_OVERLAPS_SEARCHED_DATA']}]);
export const TERMINAL_STATUSES=Object.freeze(['SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED']);

/**
 * Decide one status transition. event: {kind, to (for ALL_EVALUATIONS_DONE: the status the ranking produced), code, outcome}.
 * Returns {ok:true, to, code} or {ok:false, code:'QR4_TRANSITION_INVALID'}. A terminal selection has no event. A completed selection
 * needs an outcome of the four ranked outcomes; an incomplete one needs a code that its row of the diagram allows.
 */
export function transitionSelection(from,event){
  const invalid=detail=>refuse(CODES.QR4_TRANSITION_INVALID,detail);
  if(!isObject(event)||typeof event.kind!=='string')return invalid('EVENT_UNREADABLE');
  if(from!==null&&!['SELECTION_REGISTERED','SELECTION_EVALUATING',...TERMINAL_STATUSES].includes(from))return invalid('FROM_UNKNOWN');
  const row=TRANSITIONS.find(item=>item.from===from&&item.event===event.kind);
  if(!row)return invalid('NOT_LISTED');
  let to=row.to;
  if(Array.isArray(to)){
    if(!to.includes(event.to))return invalid('TARGET_NOT_ALLOWED');
    to=event.to;
  }
  if(to==='SELECTION_COMPLETED'&&!OUTCOMES.includes(event.outcome))return invalid('OUTCOME_REQUIRED');
  if(to==='SELECTION_INCOMPLETE'){
    const allowed=row.codes??null;
    if(!text(event.code)||(allowed!==null&&!allowed.includes(event.code)))return invalid('CODE_NOT_ALLOWED');
  }
  return deepFreeze({ok:true,to,code:to==='SELECTION_INCOMPLETE'?event.code:null,outcome:to==='SELECTION_COMPLETED'?event.outcome:null});
}

/** What the owner sees of a selection per status (section 8.1). Metrics of W only after SELECTION_COMPLETED. */
export const metricsVisible=status=>status==='SELECTION_COMPLETED';

/**
 * D1: a development view request is refused before any row is read when any query key is not on the allow-list of development-view
 * parameters (exact spelling). A sort, order, rank, top, best, winner or leader name, joined or digit-suffixed, is never on it.
 */
export function checkDevelopmentViewRequest(query){
  if(!isObject(query))return null;
  const key=Object.keys(query).find(name=>!DEVELOPMENT_VIEW_PARAMS.includes(name));
  return key?refuse(CODES.QR4_DEVELOPMENT_SCORE_NOT_RANKABLE,String(key).slice(0,40)):null;
}
/**
 * D2: no response field name of a development, library or QR-2 row has a word token that starts with rank, best, top, winner or
 * leader, except the fixed qualified_winner echo. Tokens split on every run of non-letters (digits and underscores too) and on camelCase,
 * so top10, bestscore, winnerid and leader are flagged, and stop_loss and desktop are not.
 */
export function developmentRowViolations(row,path='row'){
  const violations=[];
  const walk=(value,at)=>{
    if(Array.isArray(value)){value.forEach((item,index)=>walk(item,at+'['+index+']'));return;}
    if(!isObject(value))return;
    for(const [key,item] of Object.entries(value)){
      if(keyTokens(key).some(token=>DEVELOPMENT_NAME_PREFIXES.some(prefix=>token.startsWith(prefix)))&&!(key==='qualified_winner'&&item===null))violations.push(at+'.'+key);
      walk(item,at+'.'+key);
    }
  };
  walk(row,path);
  return violations;
}

const SEARCH_KEYS=['search','search_dimension','search_dimensions','dimension','dimensions','domain','domains','bound','bounds','budget','algorithm','seed','planned_candidates','grid','free_dimensions'];
/**
 * Section 5.4: an evaluation request has zero free dimensions. A named search dimension, bound, domain or budget is refused with
 * QR4_EVALUATION_SEARCH_REFUSED. The keys are an allow-list: every other key is INVALID_FIELDS, so an unnamed free dimension cannot pass.
 */
export function validateEvaluationRequest(request){
  if(!isObject(request))return refuse(CODES.INVALID_FIELDS,'REQUEST_UNREADABLE');
  const key=Object.keys(request).find(name=>SEARCH_KEYS.includes(name.toLowerCase()));
  if(key)return refuse(CODES.QR4_EVALUATION_SEARCH_REFUSED,String(key).slice(0,40));
  if(findWeightKey(request)!==null)return refuse(CODES.QR4_CUSTOM_WEIGHTS_REFUSED,'WEIGHT_KEY');
  const extra=Object.keys(request).find(name=>!EVALUATION_REQUEST_KEYS.includes(name));
  if(extra!==undefined)return refuse(CODES.INVALID_FIELDS,'REQUEST_KEYS:'+String(extra).slice(0,40));
  return deepFreeze({ok:true});
}

/** The only actions a selection route has (section 12.2 table). Every other name is refused. */
export const ROUTE_ACTIONS=Object.freeze(['register','cancel','replay_outcome','open_package','list','detail']);
/**
 * Section 12.2: no selection route applies inputs, changes a Bot, starts a session, enqueues email, starts another selection or
 * optimizes. An allow-list: an unknown name is refused, spelled as given (no case folding), so a new write action cannot pass by
 * avoiding a blocked word.
 */
export function checkRouteAction(action){
  if(typeof action!=='string'||!ROUTE_ACTIONS.includes(action))return refuse(CODES.QR4_APPLY_REFUSED,'ACTION_NOT_ALLOWED',{status:403});
  return deepFreeze({ok:true});
}
/** Change requests to a registered selection are refused (QR4_REGISTRATION_IMMUTABLE). */
export const refuseRegistrationChange=()=>refuse(CODES.QR4_REGISTRATION_IMMUTABLE,'REGISTRATION_IS_FROZEN');
/** Cancel needs the confirm token (CONFIRMATION_REQUIRED) and a status the diagram allows. */
export function checkCancel(status,confirmed){
  if(confirmed!==true)return refuse(CODES.CONFIRMATION_REQUIRED);
  return transitionSelection(status,{kind:'OWNER_CANCEL'});
}
