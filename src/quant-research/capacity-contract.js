import {canonical,fail,hash} from '../pine-bridge/source.js';

const VERSION='quant-capacity-v2';
const stages=Object.freeze({PARITY_DEBUG:20000,HISTORICAL_PREFLIGHT:50000,
  BROAD_SEARCH:250000,EXTENDED_VALIDATION:500000,FINAL_VALIDATION:1000000});
const budgets=Object.freeze({candidates:100,max_evaluations:125,max_runtime_ms:900000,
  max_output_bytes:8*1024*1024,max_state_bytes:1024*1024});
const ioFields=['read_bytes','write_bytes','overshoot_read_bytes','overshoot_write_bytes',
  'cleanup_read_bytes','cleanup_write_bytes'];
const scopeFields=['venue','market','symbol','timeframe','source_profile','execution_model',
  'source_hash','settings_hash','evaluator_hash'];
const invalid=()=>{throw fail('INVALID_CAPACITY_CONTRACT');};

function fields(value,names){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const own=Reflect.ownKeys(value);
  if(own.length!==names.length||own.some(key=>!names.includes(key)))invalid();
  // Only JSON data fields are accepted; getters must not change validated input.
  for(const name of names){
    const descriptor=Object.getOwnPropertyDescriptor(value,name);
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))invalid();
  }
}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)invalid();}
function sha(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))invalid();}
function scope(value){
  fields(value,scopeFields);
  if(value.venue!=='binance-global'||value.market!=='SPOT'||value.symbol!=='BTCUSDT'||
    value.timeframe!=='1'||value.source_profile!=='SPT_CUSTOM'||value.execution_model!=='paper-close-v1')invalid();
  for(const name of ['source_hash','settings_hash','evaluator_hash'])sha(value[name]);
}
function budget(value,ceilings=budgets){
  fields(value,Object.keys(budgets));
  for(const name of Object.keys(budgets))integer(value[name],1,ceilings[name]);
  if(value.max_evaluations<value.candidates)invalid();
}
function io(value){
  fields(value,ioFields);
  for(const name of ioFields)integer(value[name],1,Number.MAX_SAFE_INTEGER);
  // Total includes both reserves and must leave positive compute allowance.
  // Subtraction avoids overflowing while adding two safe integer reserves.
  for(const direction of ['read','write']){
    if(value['cleanup_'+direction+'_bytes']>=value[direction+'_bytes']||
      value['overshoot_'+direction+'_bytes']>=value[direction+'_bytes']-value['cleanup_'+direction+'_bytes'])invalid();
  }
}
function immutable(value){
  const copy=JSON.parse(canonical(value));
  const freeze=item=>{if(item&&typeof item==='object'){Object.values(item).forEach(freeze);Object.freeze(item);}return item;};
  return freeze(copy);
}

/** Validate caller-trusted configuration, not the validity of its evidence.
 * The caller must resolve genuine calibration/parity records and current scope,
 * enforce enrollment, ownership and runtime gates, and keep production at V1.
 * Evidence references are SHA-256 artifact identities, never paths or URLs.
 */
export function validateCapacityPolicy(policy){
  fields(policy,['version','environment','scope','evidence','max_raw_bars','max_chunk_bars','budget','io']);
  if(policy.version!==VERSION||!['local','staging'].includes(policy.environment))invalid();
  scope(policy.scope);
  fields(policy.evidence,['calibration_sha256','parity_sha256']);
  sha(policy.evidence.calibration_sha256);sha(policy.evidence.parity_sha256);
  integer(policy.max_raw_bars,501,1000000);
  // The initial reviewed execution envelope permits at most 1,000 per chunk.
  // The architectural 50K ceiling does not authorize a larger measured policy.
  integer(policy.max_chunk_bars,1,Math.min(1000,policy.max_raw_bars-500));
  budget(policy.budget);io(policy.io);
  return immutable(policy);
}

export function capacityPolicyHash(policy){return hash(canonical(validateCapacityPolicy(policy)));}

/** Pure capacity check only. Passing does not enroll data or authorize execution.
 * raw_bars includes seed and warm-up; warmup_bars includes the discarded seed.
 * I/O totals include compute, fixed calibrated overshoot and cleanup reserves.
 */
export function validateCapacityRequest(request,{policy}={}){
  const approved=validateCapacityPolicy(policy);
  fields(request,['version','environment','policy_hash','stage','scope','dataset','chunk_bars','budget','io']);
  if(request.version!==VERSION||request.environment!==approved.environment||
    typeof request.stage!=='string'||!Object.hasOwn(stages,request.stage))invalid();
  sha(request.policy_hash);
  if(request.policy_hash!==hash(canonical(approved)))invalid();
  scope(request.scope);
  if(canonical(request.scope)!==canonical(approved.scope))invalid();
  fields(request.dataset,['raw_bars','seed_bars','warmup_bars','evaluation_bars','processed_bars']);
  const data=request.dataset;
  integer(data.raw_bars,501,Math.min(approved.max_raw_bars,stages[request.stage]));
  if(data.seed_bars!==500)invalid();
  integer(data.warmup_bars,500,data.raw_bars-1);
  integer(data.evaluation_bars,1,data.raw_bars-500);
  integer(data.processed_bars,1,999500);
  if(data.evaluation_bars!==data.raw_bars-data.warmup_bars||
    data.processed_bars!==data.raw_bars-data.seed_bars)invalid();
  integer(request.chunk_bars,1,Math.min(50000,approved.max_chunk_bars,data.processed_bars));
  budget(request.budget,approved.budget);io(request.io);
  for(const name of ioFields){
    if(request.io[name]>approved.io[name])invalid();
    // A requester cannot shrink the calibrated safety or cleanup allowance.
    if(name!=='read_bytes'&&name!=='write_bytes'&&request.io[name]!==approved.io[name])invalid();
  }
  return immutable(request);
}
