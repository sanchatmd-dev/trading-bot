import {QR4_VERSIONS,CODES,EPISODE_FLOOR_V1,WEIGHT_KEYS,isObject,isCount,dec,nonNegative,cmp,deepFreeze,refuse,hasOwn,keyTokens} from './codes.js';

/**
 * Objective registry and filter registration (contract section 6). The registry is a frozen constant of this module. A custom
 * formula, a weight, a sort key or an unknown id is refused. The registration keeps copies of every parameter value, never a
 * reference to a current code constant, so a later registry change cannot relabel an earlier selection.
 */
export const OBJECTIVE_REGISTRY=deepFreeze({
  [QR4_VERSIONS.objective]:{
    id:QR4_VERSIONS.objective,
    kind:'LEXICOGRAPHIC',
    filters:[
      {id:'F1',code:'FILTER_DRAWDOWN_LIMIT',metric:'max_drawdown_percent',test:'AT_MOST_REGISTERED_LIMIT',required:true},
      {id:'F2',code:'FILTER_EPISODE_FLOOR',metric:'episodes',test:'AT_LEAST_REGISTERED_FLOOR',required:true},
      {id:'F3',code:'FILTER_COST_STRESS',metric:'cost_stress_net_return_percent',test:'NOT_NEGATIVE',required:true},
      {id:'F4',code:'FILTER_NET_RETURN_POSITIVE',metric:'net_return_percent',test:'GREATER_THAN_ZERO',required:true},
      {id:'F5',code:'FILTER_BEATS_BUY_AND_HOLD',metric:'net_return_percent',test:'GREATER_THAN_BUY_AND_HOLD',required:false}],
    primary:{metric:'net_return_percent',direction:'HIGHER_IS_BETTER'},
    secondary:{metric:'max_drawdown_percent',direction:'LOWER_IS_BETTER',use:'INSIDE_PRIMARY_TIE_GROUP_ONLY'},
    third_key:null,
    weights:null,
    // OD-S3 (a): the tie tolerances are registry constants that the owner sets before the first selection. They are null until then,
    // and a registration is refused while they are null. A request never carries a tolerance.
    tie_tolerances:{return_pp:null,drawdown_pp:null,unit:'PERCENTAGE_POINTS'},
    uncertainty:QR4_VERSIONS.uncertainty,
    arithmetic:'EXACT_DECIMAL'}});
export const OBJECTIVE_IDS=Object.freeze(Object.keys(OBJECTIVE_REGISTRY));

/** A request names only the objective id. Any other key, a tie tolerance included, is INVALID_FIELDS. */
const OBJECTIVE_KEYS=['id'];
/**
 * Code of a registry whose tie tolerances are not set (or not readable). Section 9 has no code for this case and no dependency code
 * fits it; QR4_OBJECTIVE_UNKNOWN (the objective is not usable from the registry) is the closest. This is a CONTRACT QUESTION for root.
 */
export const TOLERANCES_UNSET_CODE=CODES.QR4_OBJECTIVE_UNKNOWN;
export const TOLERANCES_UNSET_DETAIL='TIE_TOLERANCES_NOT_SET';
export const TOLERANCES_INVALID_DETAIL='TIE_TOLERANCES_INVALID';
const FILTER_KEYS=['drawdown_limit_percent','episode_floor','beats_buy_and_hold'];
const HUNDRED='100';

/** First forbidden weight or sort key found anywhere in a plain value (depth limited), or null. */
export function findWeightKey(value,depth=0){
  if(!isObject(value)&&!Array.isArray(value))return null;
  if(depth>6)return null;
  for(const key of Array.isArray(value)?[]:Object.keys(value)){
    if(WEIGHT_KEYS.includes(key.toLowerCase()))return key;
  }
  for(const item of Array.isArray(value)?value:Object.values(value)){
    const found=findWeightKey(item,depth+1);
    if(found!==null)return found;
  }
  return null;
}

/**
 * Validate the objective block and the filter block of a registration request.
 * Returns {ok:true, objective, filters} with copies of every value, or a refusal. Filters never get weaker than the participant
 * rules (maximum_drawdown_percent) or the scope policy limit; F3 and F4 are fixed copies (OD-S2: F1 to F4 required in v1).
 * options: participant_rules: array of each participant's frozen rules object; policy_max_drawdown_percent: the drawdown limit of the
 * policy snapshot (decimal string) or null when the snapshot defines none; registry: the objective registry (default OBJECTIVE_REGISTRY;
 * a server-side context may inject another one, a request never can); require_tolerances: false returns the shape check only, with null
 * tolerance copies, for the early registration step that runs before the dependency checks.
 */
export function validateObjective(objective,filters,{participant_rules:rules=[],policy_max_drawdown_percent:policyLimit=null,registry=OBJECTIVE_REGISTRY,require_tolerances:requireTolerances=true}={}){
  if(!isObject(objective)||!isObject(filters))return refuse(CODES.INVALID_FIELDS,'OBJECTIVE_OR_FILTERS_MISSING');
  const weight=findWeightKey(objective)??findWeightKey(filters);
  if(weight!==null)return refuse(CODES.QR4_CUSTOM_WEIGHTS_REFUSED,weight);
  const entry=typeof objective.id==='string'&&isObject(registry)&&hasOwn(registry,objective.id)&&isObject(registry[objective.id])?registry[objective.id]:null;
  if(!entry)return refuse(CODES.QR4_OBJECTIVE_UNKNOWN,typeof objective.id==='string'?objective.id.slice(0,64):'ID_MISSING');
  if(Object.keys(objective).some(key=>!OBJECTIVE_KEYS.includes(key)))return refuse(CODES.INVALID_FIELDS,'OBJECTIVE_KEYS');
  const fixed=isObject(entry.tie_tolerances)?entry.tie_tolerances:{};
  let returnTol=null,drawdownTol=null;
  if(requireTolerances){
    if(fixed.return_pp===null||fixed.drawdown_pp===null)return refuse(TOLERANCES_UNSET_CODE,TOLERANCES_UNSET_DETAIL);
    returnTol=nonNegative(fixed.return_pp);drawdownTol=nonNegative(fixed.drawdown_pp);
    if(returnTol===null||drawdownTol===null||cmp(returnTol,HUNDRED)>0||cmp(drawdownTol,HUNDRED)>0)return refuse(TOLERANCES_UNSET_CODE,TOLERANCES_INVALID_DETAIL);
  }
  if(Object.keys(filters).some(key=>keyTokens(key).includes('tolerance')))return refuse(CODES.INVALID_FIELDS,'TOLERANCE_IN_REQUEST');
  if(Object.keys(filters).some(key=>!FILTER_KEYS.includes(key)))return refuse(CODES.QR4_FILTER_INVALID,'FILTER_KEYS');
  const limit=typeof filters.drawdown_limit_percent==='string'?nonNegative(filters.drawdown_limit_percent):null;
  if(limit===null||cmp(limit,HUNDRED)>0)return refuse(CODES.QR4_FILTER_INVALID,'FILTER_DRAWDOWN_LIMIT');
  if(!isCount(filters.episode_floor)||filters.episode_floor<EPISODE_FLOOR_V1)return refuse(CODES.QR4_FILTER_INVALID,'FILTER_EPISODE_FLOOR');
  const beats=hasOwn(filters,'beats_buy_and_hold')?filters.beats_buy_and_hold:false;
  if(typeof beats!=='boolean')return refuse(CODES.QR4_FILTER_INVALID,'FILTER_BEATS_BUY_AND_HOLD');
  // Never weaker than a participant's frozen rules or the scope policy; a threshold that cannot be read cannot prove "not weaker".
  for(const item of rules){
    const bound=isObject(item)&&(typeof item.maximum_drawdown_percent==='string'||typeof item.maximum_drawdown_percent==='number')?dec(item.maximum_drawdown_percent):null;
    if(bound===null||cmp(limit,bound)>0)return refuse(CODES.QR4_FILTER_INVALID,'FILTER_DRAWDOWN_LIMIT_WEAKER_THAN_RULES');
  }
  if(policyLimit!==null&&policyLimit!==undefined){
    const bound=typeof policyLimit==='string'?dec(policyLimit):null;
    if(bound===null||cmp(limit,bound)>0)return refuse(CODES.QR4_FILTER_INVALID,'FILTER_DRAWDOWN_LIMIT_WEAKER_THAN_POLICY');
  }
  const {tie_tolerances:_fixed,...parameters}=structuredClone(entry);
  return deepFreeze({ok:true,
    objective:{...parameters,tie_tolerance_return_pp:returnTol,tie_tolerance_drawdown_pp:drawdownTol},
    filters:{drawdown_limit_percent:limit,episode_floor:filters.episode_floor,cost_stress_min_return_percent:'0',net_return_min_exclusive_percent:'0',beats_buy_and_hold:beats}});
}
