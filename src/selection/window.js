import {exposuresOverlapping,windowsOverlap} from '../comparison/evidence.js';
import {CODES,MINUTE,MAX_TOTAL_BARS,WINDOW_KINDS,isObject,isInt,isAligned,isCount,text,deepFreeze,refuse,hasOwn,marketKeyOf} from './codes.js';
import {registrationHashOf} from './hash.js';

/**
 * The common evaluation window W (contract section 5.3) and its recheck (RO-12). All windows are half-open [start_ms, end_ms)
 * in epoch milliseconds, so windows that only touch do not overlap (the convention of src/comparison/evidence.js). Warm-up bars
 * precede start_ms, are not evaluated and may overlap anything. Unknown or unreadable input is a failure, never a pass.
 */
const WINDOW_KEYS=['kind','start_ms','end_ms','warmup_bars'];
const SEARCHED_UNREADABLE='SEARCHED_WINDOWS_UNREADABLE';
export const RECHECK_STAGES=Object.freeze(['EVALUATION_START','OUTCOME_WRITE']);
export const isWindow=value=>isObject(value)&&isInt(value.start_ms)&&isInt(value.end_ms)&&value.end_ms>value.start_ms;

/**
 * Validate the shape, the bar counts and the window kind of W. Returns {ok:true, window} with evaluation, warm-up and total bars
 * (the view shows evaluation + warm-up = total), or a refusal. latest_dataset_end_ms is the latest end of any participant dataset.
 */
export function validateWindow(input,{registered_at_ms:registeredAt,latest_dataset_end_ms:datasetEnd=null,capacity_bars:capacity=MAX_TOTAL_BARS}={}){
  if(!isObject(input)||Object.keys(input).some(key=>!WINDOW_KEYS.includes(key))||!WINDOW_KEYS.every(key=>hasOwn(input,key)))return refuse(CODES.QR4_WINDOW_INVALID,'WINDOW_SHAPE');
  const {kind,start_ms:start,end_ms:end,warmup_bars:warmup}=input;
  if(!WINDOW_KINDS.includes(kind))return refuse(CODES.QR4_WINDOW_INVALID,'WINDOW_KIND');
  if(!isAligned(start)||!isAligned(end)||end<=start||!isCount(warmup))return refuse(CODES.QR4_WINDOW_INVALID,'WINDOW_NOT_HALF_OPEN_BAR_INTERVAL');
  if(!isInt(registeredAt)||!Number.isSafeInteger(capacity)||capacity<1)return refuse(CODES.QR4_WINDOW_INVALID,'WINDOW_CONTEXT_UNREADABLE');
  const evaluation=(end-start)/MINUTE,total=evaluation+warmup;
  if(total>capacity)return refuse(CODES.QR4_WINDOW_OVER_CAPACITY,'TOTAL_'+total+'_LIMIT_'+capacity);
  if(kind==='PROSPECTIVE'&&!(start>registeredAt))return refuse(CODES.QR4_WINDOW_INVALID,'PROSPECTIVE_NOT_AFTER_REGISTRATION');
  if(kind==='FORWARD_PAST'){
    if(!isAligned(datasetEnd))return refuse(CODES.QR4_WINDOW_INVALID,'FORWARD_PAST_DATASET_END_UNREADABLE');
    if(start<datasetEnd)return refuse(CODES.QR4_WINDOW_INVALID,'FORWARD_PAST_BEFORE_DATASET_END');
    if(end>registeredAt)return refuse(CODES.QR4_WINDOW_INVALID,'FORWARD_PAST_NOT_COMPLETED');
  }
  return deepFreeze({ok:true,window:{kind,start_ms:start,end_ms:end,warmup_bars:warmup,evaluation_bars:evaluation,total_bars:total}});
}

const NAMED=['dataset','train','validation','holdout'];
/** A participant's own run windows: dataset, train, validation, holdout, and any dataset its package evidence names. Null when unreadable. */
export function participantWindows(member){
  const data=isObject(member)?member.data_windows:null;
  if(!isObject(data)||!NAMED.every(name=>isWindow(data[name])))return null;
  const evidence=data.evidence===undefined?[]:data.evidence;
  if(!Array.isArray(evidence)||!evidence.every(isWindow))return null;
  return [...NAMED.map(name=>({name,window:data[name]})),...evidence.map((window,index)=>({name:'evidence_'+index,window}))];
}
/** Overlap with a participant's own data (section 5.3, first bullet). Missing window data fails. Null when clear. */
export function overlapsParticipantData(evaluation,members){
  for(const member of members){
    const windows=participantWindows(member);
    const id=isObject(member)&&text(member.export_id)?member.export_id:'UNKNOWN';
    if(windows===null)return refuse(CODES.QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA,'WINDOWS_UNREADABLE:'+id);
    const hit=windows.find(item=>windowsOverlap(item.window,evaluation));
    if(hit)return refuse(CODES.QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA,hit.name+':'+id);
  }
  return null;
}
/**
 * Overlap with a train, validation or holdout window of another research run of the owner on a participant source (section 5.3,
 * second bullet). entries: [{owner_id, source_hash, run_id, kind, window}]. Evaluation runs (kind EVALUATION_RUN, this selection's
 * own included) are not research runs and are skipped here; the exposure register covers them. The list must be well formed.
 *
 * An unreadable list is not an overlap that anyone observed. It is refused like an unreadable exposure register: the code is
 * QR4_EXPOSURE_REGISTRY_UNAVAILABLE with detail SEARCHED_WINDOWS_UNREADABLE (section 9 has no code for the searched list; this reuse is a
 * CONTRACT QUESTION for root). At registration it refuses. In a recheck it blocks the guarded step and never ends the selection.
 */
export function overlapsSearchedData(evaluation,{owner_id:owner,source_hashes:sources,entries}){
  const unreadable=()=>refuse(CODES.QR4_EXPOSURE_REGISTRY_UNAVAILABLE,SEARCHED_UNREADABLE);
  if(!Array.isArray(sources)||sources.length===0||sources.some(item=>!text(item))||!text(owner)||!Array.isArray(entries))return unreadable();
  if(!entries.every(entry=>isObject(entry)&&text(entry.owner_id)&&text(entry.source_hash)&&text(entry.run_id)&&isWindow(entry.window)&&['RESEARCH_RUN','EVALUATION_RUN'].includes(entry.kind)))return unreadable();
  const sourceSet=new Set(sources);
  const hit=entries.find(entry=>entry.kind==='RESEARCH_RUN'&&entry.owner_id===owner&&sourceSet.has(entry.source_hash)&&windowsOverlap(entry.window,evaluation));
  return hit?refuse(CODES.QR4_WINDOW_OVERLAPS_SEARCHED_DATA,hit.run_id):null;
}
/** Overlap with an exposure record of the owner and market, QR-3 comparison events included (section 13.3). Own selection is ignored. */
export function overlapsExposure(evaluation,{register,owner_id:owner,selection_id:own=null}){
  const result=exposuresOverlapping({register,owner_id:owner,market_key:marketKeyOf(),window:evaluation,comparison_id:own,as_of_ms:null});
  if(!result.ok)return refuse(CODES.QR4_EXPOSURE_REGISTRY_UNAVAILABLE,'REGISTRY_UNREADABLE');
  return result.ids.length>0?refuse(CODES.QR4_WINDOW_EXPOSED,result.ids[0]):null;
}
/** PF-2 R3 registered holdout boundary (QL4 OD-9). null: none registered; integer: the boundary; anything else is unreadable. */
export function beforeRegisteredBoundary(evaluation,members){
  for(const member of members){
    const boundary=isObject(member)?member.registered_boundary_ms:undefined;
    if(boundary===null)continue;
    if(!isInt(boundary))return refuse(CODES.QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY,'BOUNDARY_UNREADABLE');
    if(evaluation.start_ms<boundary)return refuse(CODES.QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY,String(boundary));
  }
  return null;
}
/** The window checks of registration, in the order of section 5.3. Returns the first refusal, or {ok:true}. */
export function checkWindowAtRegistration({window,members,owner_id:owner,selection_id:own,exposure_register:register,searched_windows:entries}){
  const evaluation={start_ms:window.start_ms,end_ms:window.end_ms};
  return overlapsParticipantData(evaluation,members)??
    overlapsSearchedData(evaluation,{owner_id:owner,source_hashes:members.map(member=>member.source_hash),entries})??
    overlapsExposure(evaluation,{register,owner_id:owner,selection_id:own})??
    beforeRegisteredBoundary(evaluation,members)??deepFreeze({ok:true});
}

/**
 * RO-12 recheck, run at each evaluation start and before the outcome write, in the same SERIALIZABLE transaction as the guarded
 * step. The caller reads the register and the searched windows inside that transaction; this function only judges them.
 * Result: {ok:true}; or {ok:false, ends_selection:true, status:'SELECTION_INCOMPLETE', code} with QR4_WINDOW_EXPOSED or
 * QR4_WINDOW_OVERLAPS_SEARCHED_DATA, each from an overlap that was observed; or, for an unreadable register or an unreadable searched
 * list, {ok:false, ends_selection:false, code:'QR4_EXPOSURE_REGISTRY_UNAVAILABLE'}: the guarded step must not run, no exposure record is
 * written, nothing is ranked and the selection stays open so that the step is retried. The detail tells the two apart
 * (REGISTRY_UNREADABLE or SEARCHED_WINDOWS_UNREADABLE). The selection's own exposure record and its own evaluation runs never fail the recheck.
 * An unreadable registration is INTEGRITY_CHECK_FAILED (section 10), not QR4_REGISTRATION_IMMUTABLE (a change request), and blocks the step.
 */
export function recheckWindow({registration,exposure_register:register,searched_windows:entries,stage}={}){
  const stop=(code,detail,ends)=>deepFreeze({ok:false,ends_selection:ends,status:ends?'SELECTION_INCOMPLETE':null,code,detail,stage:stage??null,ranking:false});
  if(!RECHECK_STAGES.includes(stage))return stop(CODES.QR4_TRANSITION_INVALID,'STAGE_UNKNOWN',false);
  const reg=isObject(registration)?registration:{};
  const window=reg.window,participants=Array.isArray(reg.participants)?reg.participants:null;
  if(!isWindow(window)||participants===null||participants.length===0||!text(reg.owner_id))return stop(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_UNREADABLE',false);
  // The stored window and participant list are judged only if the registration is the one that was hashed at registration.
  if(reg.registration_hash!==registrationHashOf(reg))return stop(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_HASH',false);
  const evaluation={start_ms:window.start_ms,end_ms:window.end_ms};
  const exposed=overlapsExposure(evaluation,{register,owner_id:reg.owner_id,selection_id:text(reg.selection_id)?reg.selection_id:null});
  if(exposed)return stop(exposed.code,exposed.detail,exposed.code===CODES.QR4_WINDOW_EXPOSED);
  const searched=overlapsSearchedData(evaluation,{owner_id:reg.owner_id,source_hashes:participants.map(item=>item.source_hash),entries});
  if(searched)return stop(searched.code,searched.detail,searched.code===CODES.QR4_WINDOW_OVERLAPS_SEARCHED_DATA);
  return deepFreeze({ok:true,ends_selection:false,status:null,code:null,detail:null,stage,ranking:true});
}
