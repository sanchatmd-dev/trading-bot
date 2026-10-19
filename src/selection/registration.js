import {CODES,ADMITTED_COST_MODELS,QR3_VERSIONS,QR4_VERSIONS,REQUIRED_MARKET,MIN_PARTICIPANTS,MAX_PARTICIPANTS,WEIGHT_KEYS,MAX_TOTAL_BARS,isObject,isInt,isSha,text,decString,nonNegative,norm,canonical,digest,deepFreeze,refuse,hasOwn,byCreation,byText,marketIsRequired} from './codes.js';
import {validateObjective,findWeightKey,OBJECTIVE_REGISTRY} from './objective.js';
import {evaluateEligibility} from './eligibility.js';
import {validateWindow,checkWindowAtRegistration,isWindow} from './window.js';
import {registrationHashOf} from './hash.js';
import {exposuresOverlapping} from '../comparison/evidence.js';

/**
 * Registration (contract sections 3.4, 4.3, 5, 6 and 9): the frozen declaration of scope, window W, objective, filters, universe
 * snapshot and participants, written before any evaluation starts. buildRegistration is pure: the caller reads the universe,
 * the exposure register, the searched windows, the policy snapshot, the earlier selections and the dependency facts and passes them
 * in; it returns a frozen registration or the first refusal. A refusal writes no row and starts no run.
 *
 * The request carries only what the owner declares: owner, selection id, time, confirmation, fixture flag, ranking basis, scope,
 * window, objective id, filters, admission deadline and universe. Everything the server must read is in the context and never in the
 * request: dependencies, exposure register, searched windows, universe cap, window capacity, requester, policy snapshot, earlier
 * selection ids, earlier registrations and (for tests only) an injected objective registry.
 *
 * Refusal order: request shape and forbidden keys, ranking basis, confirmation, requester, scope and policy snapshot, objective shape,
 * basis (actual history, mixed), universe cap, duplicates, per-member eligibility, no eligible participant (first row of the table
 * of 1.3), dependencies in the order of 1.3 (with the objective registry readiness), participant count, rules, filters against
 * participant rules and the policy, window shape and kind, admission deadline, earlier selections, idempotency, window overlaps.
 */
export const REQUEST_KEYS=Object.freeze(['owner_id','selection_id','registered_at_ms','confirmed','fixture','ranking_basis','scope','window','objective','filters',
  'admission_deadline_ms','universe']);
export const SCOPE_KEYS=Object.freeze(['market','data_model','cost_model','capital','policy','valuation','engine']);
export const RANKING_BASES=Object.freeze(['QR4_SELECTION_EVAL']);

/**
 * The drawdown limit of the policy snapshot. The caller reads the snapshot of the registered policy_hash from the server and passes
 * {policy_hash, max_drawdown_percent} where max_drawdown_percent is a non-negative decimal string, or null when the policy defines no
 * limit. A missing, mismatched or unreadable snapshot cannot prove that no limit exists, so it is refused (the policy snapshot
 * schema is a CONTRACT QUESTION for root).
 */
function policyLimitOf(snapshot,policyHash){
  const unreadable=()=>refuse(CODES.QR4_FILTER_INVALID,'POLICY_SNAPSHOT_UNREADABLE');
  if(!isObject(snapshot)||snapshot.policy_hash!==policyHash||!hasOwn(snapshot,'max_drawdown_percent'))return unreadable();
  const limit=snapshot.max_drawdown_percent;
  if(limit===null)return {ok:true,limit:null};
  const value=typeof limit==='string'?nonNegative(limit):null;
  return value===null?unreadable():{ok:true,limit:value};
}

/** Validate the declared scope (qr4-scope-v1). Returns {ok:true, scope} (a normalised copy) or a refusal. */
export function validateScope(input,{policy_snapshot:snapshot}={}){
  if(!isObject(input)||Object.keys(input).some(key=>!SCOPE_KEYS.includes(key)))return refuse(CODES.INVALID_FIELDS,'SCOPE_KEYS');
  if(!marketIsRequired(input.market))return refuse(CODES.BI_MARKET_SCOPE_INVALID,'MARKET');
  const model=input.data_model,cost=input.cost_model,capital=input.capital,policy=input.policy,valuation=input.valuation;
  if(!isObject(model)||!['data_profile','price_tick','quantity_step'].every(key=>hasOwn(model,key)&&model[key]!==null&&model[key]!==undefined))return refuse(CODES.QR4_SCOPE_INCOMPATIBLE,'data_model');
  if(!isObject(cost)||!ADMITTED_COST_MODELS.includes(cost.version)||!['fee_bps','slippage_bps'].every(key=>hasOwn(cost,key)&&cost[key]!==null&&cost[key]!==undefined))return refuse(CODES.QR4_SCOPE_INCOMPATIBLE,'cost_model');
  if(!isObject(capital)||decString(capital.equity)===null||decString(capital.cash)===null)return refuse(CODES.QR4_SCOPE_INCOMPATIBLE,'capital');
  if(!isObject(policy)||!text(policy.policy_version)||!isSha(policy.policy_hash))return refuse(CODES.QR4_SCOPE_INCOMPATIBLE,'policy');
  if(!isSha(input.engine))return refuse(CODES.QR4_SCOPE_INCOMPATIBLE,'engine');
  if(!isObject(valuation)||valuation.valuation!==QR3_VERSIONS.valuation||valuation.benchmark!==QR3_VERSIONS.benchmark)return refuse(CODES.QR4_QR3_CONTEXT_UNAVAILABLE,'valuation');
  const limit=policyLimitOf(snapshot,policy.policy_hash);
  if(limit.ok!==true)return limit;
  const scope={version:QR4_VERSIONS.scope,market:{...REQUIRED_MARKET},data_model:structuredClone(model),cost_model:structuredClone(cost),
    capital:{equity:norm(capital.equity),cash:norm(capital.cash)},policy:{policy_version:policy.policy_version,policy_hash:policy.policy_hash},
    valuation:{valuation:valuation.valuation,benchmark:valuation.benchmark},engine:input.engine,policy_max_drawdown_percent:limit.limit};
  return deepFreeze({ok:true,scope});
}

/** Dependencies of section 1.3, in the order of its table. Missing or non-boolean facts mean unavailable. */
export function checkDependencies(dependencies){
  const d=isObject(dependencies)?dependencies:{};
  if(d.qr3_context!==true)return refuse(CODES.QR4_QR3_CONTEXT_UNAVAILABLE,'QR3_VALUATION_AND_BENCHMARK');
  if(d.evaluation_mode!==true)return refuse(CODES.QR4_EVALUATION_MODE_UNAVAILABLE,'QR4_SELECTION_EVAL');
  if(typeof d.episode_gate_version!=='string'||d.episode_gate_version.length===0)return refuse(CODES.QR4_EPISODE_GATE_UNAVAILABLE,'QL4_OD4');
  return null;
}

export {registrationHashOf};
/** Idempotency key (13.1): hash of owner, scope, W, objective, filters and participants. */
export function registrationKeyOf(registration){
  if(!isObject(registration)||!isWindow(registration.window))return null;
  const {kind,start_ms:start,end_ms:end,warmup_bars:warmup}=registration.window;
  const participants=(Array.isArray(registration.participants)?registration.participants:[]).map(item=>[item.export_id,item.package_hash]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  return digest({owner_id:registration.owner_id,scope:registration.scope,window:{kind,start_ms:start,end_ms:end,warmup_bars:warmup},objective:registration.objective,filters:registration.filters,participants});
}

const participantRecord=(member,result)=>({run_id:member.run_id,export_id:member.package.export_id,package_hash:member.package.package_hash,source_hash:member.source_hash,
  created_at_ms:member.created_at_ms,rules_hash:member.rules_hash,validation_binding:result.validation_binding,data_windows:structuredClone(member.data_windows),
  registered_boundary_ms:member.registered_boundary_ms});

/** Never throws: an input that breaks an assumption of the pure code is refused as INVALID_FIELDS. */
export function buildRegistration(input,context){
  try{return build(input,context);}catch{return refuse(CODES.INVALID_FIELDS,'UNEXPECTED_INPUT');}
}
function build(input,context){
  const request=isObject(input)?input:null,ctx=isObject(context)?context:{};
  if(request===null||Object.keys(request).some(key=>!REQUEST_KEYS.includes(key)&&!WEIGHT_KEYS.includes(key.toLowerCase())))return refuse(CODES.INVALID_FIELDS,'REQUEST_KEYS');
  const weight=Object.keys(request).find(key=>WEIGHT_KEYS.includes(key.toLowerCase()))??findWeightKey(request.objective)??findWeightKey(request.filters);
  if(weight)return refuse(CODES.QR4_CUSTOM_WEIGHTS_REFUSED,String(weight).slice(0,40));
  if(hasOwn(request,'ranking_basis')){
    if(request.ranking_basis==='DEVELOPMENT_SCORE')return refuse(CODES.QR4_DEVELOPMENT_SCORE_NOT_RANKABLE,'RANKING_BASIS');
    if(request.ranking_basis==='OWN_HOLDOUT')return refuse(CODES.QR4_OWN_HOLDOUT_NOT_COMPARABLE,'RANKING_BASIS');
    if(!RANKING_BASES.includes(request.ranking_basis))return refuse(CODES.INVALID_FIELDS,'RANKING_BASIS');
  }
  const {owner_id:owner,selection_id:selectionId,registered_at_ms:at}=request;
  if(!text(owner)||!text(selectionId)||!isInt(at)||!Array.isArray(request.universe)||typeof (request.fixture??false)!=='boolean')return refuse(CODES.INVALID_FIELDS,'IDENTITY_OR_TIME');
  if(request.confirmed!==true)return refuse(CODES.CONFIRMATION_REQUIRED);
  // OD-S18: only the owner registers. The requester is read by the server, never defaulted, and must be the owner.
  // Section 9 has no code for a requester who is not the owner; INVALID_FIELDS with a detail is a CONTRACT QUESTION for root.
  if(!text(ctx.requester_owner_id))return refuse(CODES.INVALID_FIELDS,'REQUESTER_UNREADABLE');
  if(ctx.requester_owner_id!==owner)return refuse(CODES.INVALID_FIELDS,'REQUESTER_NOT_OWNER');
  const requester=ctx.requester_owner_id;
  const fixture=request.fixture===true;
  // A fixture selection is allowed only where the server says so (OD-S15, staging). A request flag alone never admits fixture packages.
  if(fixture&&ctx.fixture_selections_allowed!==true)return refuse(CODES.QR4_FIXTURE_PARTICIPANT,'FIXTURE_SELECTION_NOT_ALLOWED');
  const registry=ctx.objective_registry===undefined?OBJECTIVE_REGISTRY:ctx.objective_registry;
  const scoped=validateScope(request.scope,{policy_snapshot:ctx.policy_snapshot});
  if(!scoped.ok)return scoped;
  const shape=validateObjective(request.objective,request.filters,{registry,require_tolerances:false});
  if(!shape.ok)return shape;
  const members=request.universe;
  if(!members.every(isObject))return refuse(CODES.INVALID_FIELDS,'UNIVERSE_MEMBER');
  const actual=members.filter(item=>item.kind==='ACTUAL_HISTORY').length;
  if(actual>0&&actual<members.length)return refuse(CODES.QR4_MIXED_BASIS,'ACTUAL_HISTORY_WITH_SIMULATED');
  if(actual>0)return refuse(CODES.QR4_ACTUAL_HISTORY_NOT_RANKABLE,'ACTUAL_HISTORY');
  if(!Number.isSafeInteger(ctx.universe_cap)||ctx.universe_cap<1)return refuse(CODES.INVALID_FIELDS,'UNIVERSE_CAP_UNREADABLE');
  if(members.length>ctx.universe_cap)return refuse(CODES.QR4_UNIVERSE_TOO_LARGE,String(members.length));
  const exports=members.map(item=>item.export_id).filter(text),runs=members.map(item=>item.run_id).filter(text);
  if(new Set(exports).size!==exports.length||new Set(runs).size!==runs.length)return refuse(CODES.QR4_DUPLICATE_PARTICIPANT,'EXPORT_OR_RUN_REPEATED');
  const results=members.map(member=>({member,result:evaluateEligibility(member,{owner_id:owner,requester_owner_id:requester,scope:scoped.scope,fixture})}));
  const universe=results.map(item=>item.result).sort(byCreation);
  const eligible=results.filter(item=>item.result.eligible);
  // The first row of the table of 1.3: with no eligible participant the registration is refused for that, whatever else is unavailable.
  if(eligible.length===0)return refuse(CODES.QR4_NO_ELIGIBLE_PARTICIPANT,null,{universe});
  const dependencies=checkDependencies(ctx.dependencies);
  if(dependencies)return dependencies;
  const registryRead=exposuresOverlapping({register:ctx.exposure_register,owner_id:owner,market_key:canonical(REQUIRED_MARKET),window:{start_ms:0,end_ms:1},comparison_id:null,as_of_ms:null});
  if(!registryRead.ok)return refuse(CODES.QR4_EXPOSURE_REGISTRY_UNAVAILABLE,'REGISTRY_UNREADABLE');
  // OD-S3: the objective registry must hold the tie tolerances. While the owner has not set them the registration is refused.
  const ready=validateObjective(request.objective,request.filters,{registry});
  if(!ready.ok)return ready;
  if(eligible.length<MIN_PARTICIPANTS)return refuse(CODES.QR4_TOO_FEW_PARTICIPANTS,String(eligible.length),{universe});
  const rulesHashes=eligible.map(item=>item.member.rules_hash);
  if(rulesHashes.some(value=>!isSha(value))||new Set(rulesHashes).size!==1)return refuse(CODES.QR4_RULES_VERSION_MIXED,null,{universe});
  // The hash must belong to the rules object that the 6.1 "not weaker than" check reads. Section 9 names no code for a hash that does not
  // match its rules; QR4_RULES_VERSION_MIXED with a detail is a CONTRACT QUESTION for root.
  if(eligible.some(item=>digest(item.member.rules)!==item.member.rules_hash))return refuse(CODES.QR4_RULES_VERSION_MIXED,'RULES_HASH_MISMATCH',{universe});
  if(eligible.length>MAX_PARTICIPANTS)return refuse(CODES.QR4_TOO_MANY_PARTICIPANTS,String(eligible.length),{universe});
  const checked=validateObjective(request.objective,request.filters,{registry,participant_rules:eligible.map(item=>item.member.rules),policy_max_drawdown_percent:scoped.scope.policy_max_drawdown_percent});
  if(!checked.ok)return checked;
  const participantMembers=eligible.map(item=>({...item.member,export_id:item.member.package.export_id}));
  const datasetEnds=participantMembers.map(member=>member.data_windows?.dataset?.end_ms);
  const latest=datasetEnds.every(isInt)?Math.max(...datasetEnds):null;
  const windowed=validateWindow(request.window,{registered_at_ms:at,latest_dataset_end_ms:latest,capacity_bars:ctx.capacity_bars===undefined?MAX_TOTAL_BARS:ctx.capacity_bars});
  if(!windowed.ok)return windowed;
  if(!isInt(request.admission_deadline_ms)||request.admission_deadline_ms<windowed.window.end_ms)return refuse(CODES.INVALID_FIELDS,'ADMISSION_DEADLINE');
  // The earlier selections come from the server. A request value, a missing value or a duplicate would understate the multiple-comparison
  // disclosure the owner sees. Section 9 names no code for this; INVALID_FIELDS with a detail is a CONTRACT QUESTION for root.
  const prior=ctx.prior_selection_ids;
  if(!Array.isArray(prior)||!prior.every(text)||new Set(prior).size!==prior.length)return refuse(CODES.INVALID_FIELDS,'PRIOR_SELECTIONS_UNREADABLE');
  if(!Array.isArray(ctx.existing_registrations))return refuse(CODES.INVALID_FIELDS,'EXISTING_REGISTRATIONS_UNREADABLE');
  const participants=eligible.map(item=>participantRecord(item.member,item.result)).sort(byText('export_id'));
  const registration={version:QR4_VERSIONS.registration,selection_id:selectionId,owner_id:owner,registered_at_ms:at,fixture,
    market:{...REQUIRED_MARKET},scope:scoped.scope,window:windowed.window,objective:checked.objective,filters:checked.filters,
    admission_deadline_ms:request.admission_deadline_ms,universe,participants,participant_count:participants.length,
    prior_selection_count:prior.length,prior_selection_ids:[...prior].sort()};
  const key=registrationKeyOf(registration);
  if(key===null)return refuse(CODES.INVALID_FIELDS,'REGISTRATION_UNHASHABLE');
  const existing=ctx.existing_registrations.find(item=>isObject(item)&&item.owner_id===owner&&item.registration_key===key);
  if(existing)return refuse(CODES.QR4_SELECTION_EXISTS,null,{selection_id:existing.selection_id??null});
  const overlap=checkWindowAtRegistration({window:windowed.window,members:participantMembers,owner_id:owner,selection_id:selectionId,exposure_register:ctx.exposure_register,searched_windows:ctx.searched_windows});
  if(overlap.ok!==true)return overlap;
  const withKey={...registration,registration_key:key};
  return deepFreeze({ok:true,registration:{...withKey,registration_hash:registrationHashOf(withKey)}});
}
