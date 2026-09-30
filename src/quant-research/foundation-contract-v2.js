import {canonical,fail,hash} from '../pine-bridge/source.js';
import {validateDatasetReference} from './foundation-contract.js';
import {validateCapacityRequest} from './capacity-contract.js';
import {validateProfileSpecV2} from './profile-contract-v2.js';

const invalid=()=>{throw fail('INVALID_FOUNDATION_V2');};
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const PROFILE_ENROLLMENT_MODE='pf2-enrollment-v1';

/** Reject accessors, symbols, holes, special prototypes, and non-JSON leaves. */
export function strictJsonV2(value,seen=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value))invalid();return;}
 if(typeof value!=='object'||seen.has(value))invalid();
 seen.add(value);
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype)invalid();
  if(Reflect.ownKeys(value).length!==value.length+1)invalid();
  for(let index=0;index<value.length;index++){
   const field=Object.getOwnPropertyDescriptor(value,String(index));
   if(!field||!field.enumerable||!Object.hasOwn(field,'value'))invalid();
   strictJsonV2(field.value,seen);
  }
 }else{
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  for(const name of Reflect.ownKeys(value)){
   if(typeof name!=='string')invalid();
   const field=Object.getOwnPropertyDescriptor(value,name);
   if(!field||!field.enumerable||!Object.hasOwn(field,'value'))invalid();
   strictJsonV2(field.value,seen);
  }
 }
 seen.delete(value);
}

export function fieldsV2(value,names){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
 const own=Reflect.ownKeys(value);
 if(own.length!==names.length||own.some(name=>!names.includes(name)))invalid();
 for(const name of names){
  const field=Object.getOwnPropertyDescriptor(value,name);
  if(!field||!field.enumerable||!Object.hasOwn(field,'value'))invalid();
 }
}

export function frozenV2(value){
 const copy=JSON.parse(canonical(value));
 const freeze=item=>{if(item&&typeof item==='object'){Object.values(item).forEach(freeze);Object.freeze(item);}return item;};
 return freeze(copy);
}

export function validateFoundationRequestV2(value,{policy}={}){
 strictJsonV2(value);
 const enrollment=Object.hasOwn(value,'completion_mode');
 fieldsV2(value,['version','owner_id','bot_id','kind','dataset','engine_hash',
  'snapshot_hash','budget','profile','capacity',...(enrollment?['completion_mode']:[])]);
 if(enrollment&&value.completion_mode!==PROFILE_ENROLLMENT_MODE)invalid();
 if(value.version!=='quant-foundation-v2'||value.kind!=='PROFILE'||
    !['owner_id','bot_id'].every(name=>typeof value[name]==='string'&&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value[name]))||
    !sha(value.engine_hash)||!sha(value.snapshot_hash))invalid();
 const dataset=validateDatasetReference(value.dataset);
 const capacity=validateCapacityRequest(value.capacity,{policy});
 const profile=validateProfileSpecV2(value.profile,dataset);
 if(enrollment&&(capacity.environment!=='staging'||dataset.metadata.total_bars>10000||
    !policy.terminal||value.budget.candidates!==1||value.budget.max_evaluations!==1))invalid();
 if(value.engine_hash===capacity.scope.evaluator_hash||
    value.snapshot_hash!==profile.snapshot_hash||
    profile.source_hash!==capacity.scope.source_hash||
    profile.effective_inputs_hash!==capacity.scope.settings_hash||
    dataset.metadata.total_bars!==capacity.dataset.raw_bars||
    dataset.metadata.warmup_bars!==capacity.dataset.warmup_bars||
    profile.seed_bars!==capacity.dataset.seed_bars)invalid();
 const budget=value.budget;
 fieldsV2(budget,['candidates','max_evaluations','chunk_bars','max_runtime_ms',
  'max_output_bytes','max_state_bytes']);
 if(budget.chunk_bars!==capacity.chunk_bars||
    Object.keys(capacity.budget).some(name=>budget[name]!==capacity.budget[name]))invalid();
 return frozenV2({...value,dataset,profile,capacity});
}

export function foundationRequestHashV2(value,{policy}={}){
 return hash(canonical(validateFoundationRequestV2(value,{policy})));
}
