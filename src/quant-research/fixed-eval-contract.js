import {canonical,fail,hash,keys} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {FOUNDATION_LIMITS,validateDatasetMetadata,validateDatasetReference} from './foundation-contract.js';
import {strictJsonV2} from './foundation-contract-v2.js';
import {DATASET_BINDING_KIND,DATASET_BINDING_STEP_ID} from './research-contract-v2.js';

export {CONTENT_DIGEST_SQL,contentDigest} from './research-contract-v2.js';
export {DATASET_BINDING_KIND,DATASET_BINDING_STEP_ID};

/** Pure contract layer of mode FIXED_INPUT_EVAL (FE-2a): one frozen window, fixed inputs, zero search.
 * It closes RO-7 ("Backtest another period" with no search) for two purposes, QR4_SELECTION and QR3_COMPARISON.
 * The stored contract lives in the immutable quant_jobs contract JSONB: lineage is inside it, so no column or trigger
 * changes. It holds no bars and no file reference; the dataset binding, written once by the worker, supplies those.
 * The module reads no database, file, clock or random source. FE-2b uses it through the opt-in foundation worker.
 *
 * Time: dataset times are verified closed-bar timestamps, as in research v2 (end_time is the last timestamp; the
 * published metadata end is one minute later). fixed_eval takes these times unchanged as engine time.
 */
export const FIXED_EVAL_VERSIONS=Object.freeze({mode:'FIXED_INPUT_EVAL',contract:'fixed-eval-job-v1',request:'quant-foundation-fixed-eval-v1',
 binding:'fixed-eval-dataset-binding-v1',result:'fixed-eval-result-v1',step:'fixed-eval-v1',closure:'fixed-eval-closure-v1',
 digest:'pine-bar-content-digest-v1',model:'paper-close-v1',profile:'closed-ohlcv-atr14-v1'});
export const FIXED_EVAL_PURPOSES=Object.freeze(['QR4_SELECTION','QR3_COMPARISON']);
/** Steps after prepare:dataset. EVALUATION_STRESS is the engine-defined 2x fee and slippage run. */
export const FIXED_EVAL_STEPS=Object.freeze([Object.freeze({step_id:'eval:base',kind:'EVALUATION'}),Object.freeze({step_id:'eval:stress',kind:'EVALUATION_STRESS'})]);
export const FIXED_EVAL_LIMITS=Object.freeze({totalBars:FOUNDATION_LIMITS.admittedBars,warmupFloor:1006,warmupEmaMultiple:5,warmupMax:5000,
 runtimeMs:FOUNDATION_LIMITS.runtimeMs,evaluations:2,outputBytes:FOUNDATION_LIMITS.outputBytes,stateBytes:FOUNDATION_LIMITS.stateBytes});
/** Parent input name (Pine variable) to evaluator field, with the CATALOG bounds [min, max, integer]. */
export const FIXED_EVAL_INPUT_FIELDS=Object.freeze({emaFastInput:['ema_fast',1,500,true],emaSlowInput:['ema_slow',1,1000,true],
 atrLenInput:['atr_len',1,500,true],stFactorInput:['st_factor',.1,100,false],zoneAtrMultInput:['zone_atr_mult',.1,100,false],
 setupExpiryInput:['setup_expiry',1,100,true],cooldownInput:['cooldown',0,100,true],confirmLookback:['confirm_lookback',2,50,true],
 slAtrBufferInput:['sl_atr_buffer',0,100,false],minRiskATRInput:['min_risk_atr',.05,100,false]});
export const FIXED_EVAL_POLICY_KEYS=Object.freeze(['killSwitch','maxSignalAgeSeconds','maxTradesPerDay','maxDailyLossR','pauseAfterLossStreak',
 'blockHighVolatility','maxVolatilityPercent','blockDuringNews','allowedSymbols','sideMode','maxOpenPositions','onePositionPerSymbol',
 'capPercentEquitySize','maxRiskPercent','maxOrderNotional','maxDailyNotional']);
/** Same fragments as the Python evaluator: any key containing one carries a search dimension, bound, domain, budget or seed. */
export const FIXED_EVAL_SEARCH_FRAGMENTS=Object.freeze(['domain','budget','seed','search','evaluations','slot','dimension','bound']);
export const FIXED_EVAL_SEARCH_REFUSED='QR4_EVALUATION_SEARCH_REFUSED';

const V=FIXED_EVAL_VERSIONS;
const MINUTE=60_000;
const MAX_TIME=8_640_000_000_000_000;
const SCOPE='SPT_CUSTOM_ENGINEERING_ONLY';
const BACKEND='quant-foundation-v1';
const BROKER='binance-global';
const SYMBOL='BTCUSDT';
const TIMESTAMP_SEMANTICS='verified closed-bar timestamps; half-open index end is last timestamp plus one minute';
const INVALID_CONTRACT='INVALID_FIXED_EVAL_CONTRACT';
const INVALID_BINDING='FIXED_EVAL_DATASET_BINDING_INVALID';
const INVALID_RESULT='FIXED_EVAL_RESULT_INVALID';
const INVALID_ROWS='FIXED_EVAL_ROWS_INVALID';
const INVALID_INPUTS='FIXED_EVAL_INPUTS_INVALID';
const INVALID_POLICY='FIXED_EVAL_POLICY_INVALID';
const CONTRACT_KEYS=['version','mode','purpose','scope','execution_backend','owner_id','bot_id','deployment_id','lineage','engine_hash','parameters',
 'capital','policy','policy_hash','cost_model','dataset','parent_dataset_range'];
const BUILD_KEYS=['purpose','owner_id','bot_id','deployment_id','lineage','engine_hash','parameters','capital','policy','cost_model','dataset','parent_dataset_range'];
const LINEAGE_KEYS=['parent_run_id','parent_contract_hash','object_kind','object_id'];
const CAPITAL_KEYS=['initial_cash','initial_equity','initial_inventory','quote'];
const MODEL_KEYS=['version','data_profile','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent'];
const DATASET_KEYS=['start_time','end_time','warmup_bars','bar_count','first_time','timestamp_semantics','content_digest','digest_version'];
const REQUEST_KEYS=['version','owner_id','bot_id','kind','pending_dataset','engine_hash','snapshot_hash','budget'];
const PENDING_KEYS=['metadata','content_digest','digest_version'];
const BUDGET_KEYS=['candidates','max_evaluations','chunk_bars','max_runtime_ms','max_output_bytes','max_state_bytes'];
const BINDING_KEYS=['version','references','dataset_sha256','content_digest','bar_count','execution_contract_hash'];
const SIDECAR_KEYS=['sha256','bar_count','first_time','profile','price_tick','quantity_step'];
const ROW_KEYS=['time','open','high','low','close','volume','atr14'];
const RESULT_KEYS=['version','mode','purpose','lineage','engine_hash','evaluation_closure','dataset_sha256','base','stress'];
const STEP_RESULT_KEYS=['version','evaluator_closure','kind','cost_stress','model','bridge','initial_equity','split','engine_hash','dataset_sha256',
 'parent_run_id','selection_id','metrics_precision','metrics','fills','fees_total','slippage_cost_incl_tick_total','exposure','episodes',
 'closed_allocations','open_position','rejected'];
const FACTOR={EVALUATION:1,EVALUATION_STRESS:2};

const HEX=/^[a-f0-9]{64}$/;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Same plain decimal text the research contract accepts: digits with an optional fraction, no sign, no exponent.
const DECIMAL_TEXT=/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;
const sha=value=>typeof value==='string'&&HEX.test(value);
const identifier=value=>typeof value==='string'&&IDENTIFIER.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const decimalText=value=>typeof value==='string'&&value.length<=120&&DECIMAL_TEXT.test(value);
const positive=value=>decimalText(value)&&/[1-9]/.test(value);
const need=ok=>{if(!ok)throw new Error('check');};
// A refusal with its own code survives the catch-all that maps every other failure to the generic contract code.
const refuse=code=>{throw Object.assign(fail(code),{expected:true});};
const clone=value=>JSON.parse(canonical(value));
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
// Every failure inside work becomes one coded refusal; a refusal that already has its own code (also from a nested guard) is kept.
const guard=(code,work)=>{
 try{return work();}catch(error){if(error?.expected===true)throw error;throw Object.assign(fail(code),{expected:true});}
};

/** Walk every nested key (arrays included) and refuse a search field before anything else is read.
 * Iterative, reads data properties only (no getter runs), so a hostile value cannot exhaust the stack or run code.
 */
export function refuseSearchFields(value){
 const pending=[value],seen=new Set();
 while(pending.length){
  const node=pending.pop();
  if(node===null||typeof node!=='object'||seen.has(node))continue;
  seen.add(node);
  for(const name of Reflect.ownKeys(node)){
   if(typeof name==='symbol')continue; // strictJsonV2 refuses a symbol key later
   if(!Array.isArray(node)||name!=='length'){
    const text=name.toLowerCase();
    if(FIXED_EVAL_SEARCH_FRAGMENTS.some(part=>text.includes(part)))refuse(FIXED_EVAL_SEARCH_REFUSED);
   }
   const field=Object.getOwnPropertyDescriptor(node,name);
   if(field&&Object.hasOwn(field,'value'))pending.push(field.value);
  }
 }
}

function policyValue(name,value){
 if(['killSwitch','blockHighVolatility','blockDuringNews','onePositionPerSymbol','capPercentEquitySize'].includes(name))return typeof value==='boolean';
 if(name==='allowedSymbols')return Array.isArray(value)&&value.length===1&&value[0]===SYMBOL;
 if(name==='sideMode')return ['BOTH','BUY_ONLY','SELL_ONLY'].includes(value);
 if(typeof value==='number')return Number.isFinite(value)&&value>=0;
 return ['maxDailyLossR','maxRiskPercent','maxOrderNotional','maxDailyNotional'].includes(name)&&decimalText(value);
}

/** The 16 node policy names the evaluator requires, projected from a larger snapshot policy. Fails closed on a gap. */
export function projectFixedEvalPolicy(raw){
 return guard(INVALID_POLICY,()=>{
  need(plain(raw));
  strictJsonV2(raw);
  const projected={};
  for(const name of FIXED_EVAL_POLICY_KEYS){
   need(Object.hasOwn(raw,name));
   const value=raw[name];
   need(policyValue(name,value));
   projected[name]=clone({value}).value;
  }
  return projected;
 });
}
export function fixedEvalPolicyHash(policy){
 return hash(canonical(projectFixedEvalPolicy(policy)));
}

/** Parent inputs for the evaluator: parent fixed inputs plus the selected parameters, mapped to the ten SPT fields.
 * `fixedInputs` is the parent selection's fixed_inputs list ({pine_variable, effective_value}); `selected` is the parent
 * selected.parameters object (Pine variable names plus atr_multiplier and rr). The two must not overlap; every catalog
 * input and both Bridge values must be present. Extra non-catalog fixed inputs are not evaluator inputs and are ignored.
 */
export function fixedEvalParametersFromParent({fixedInputs,selected}){
 return guard(INVALID_INPUTS,()=>{
  need(Array.isArray(fixedInputs)&&plain(selected));
  const values=new Map();
  for(const input of fixedInputs){
   need(plain(input)&&typeof input.pine_variable==='string');
   if(Object.hasOwn(FIXED_EVAL_INPUT_FIELDS,input.pine_variable)){
    need(!values.has(input.pine_variable));
    values.set(input.pine_variable,input.effective_value);
   }
  }
  for(const name of Object.keys(selected)){
   need(name==='atr_multiplier'||name==='rr'||Object.hasOwn(FIXED_EVAL_INPUT_FIELDS,name));
   need(!values.has(name));
   if(name!=='atr_multiplier'&&name!=='rr')values.set(name,selected[name]);
  }
  need(Object.keys(FIXED_EVAL_INPUT_FIELDS).every(name=>values.has(name)));
  const inputs={};
  for(const [name,[field]] of Object.entries(FIXED_EVAL_INPUT_FIELDS))inputs[field]=values.get(name);
  const parameters={inputs,atr_multiplier:bridgeText(selected.atr_multiplier),rr:bridgeText(selected.rr)};
  checkedParameters(parameters);
  return parameters;
 });
}
function bridgeText(value){
 // The research path reads these through str(); String(number) is the same shortest form within 0.01..1000.
 need(typeof value==='string'||(typeof value==='number'&&Number.isFinite(value)));
 return typeof value==='string'?value:String(value);
}
function checkedParameters(parameters){
 keys(parameters,['inputs','atr_multiplier','rr']);
 const fields=Object.values(FIXED_EVAL_INPUT_FIELDS);
 keys(parameters.inputs,fields.map(([field])=>field));
 for(const [field,min,max,isInt] of fields){
  const value=parameters.inputs[field];
  need(typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&(!isInt||Number.isSafeInteger(value)));
 }
 need(parameters.inputs.ema_fast<parameters.inputs.ema_slow);
 for(const name of ['atr_multiplier','rr'])need(positive(parameters[name])&&D(parameters[name]).gte('0.01')&&D(parameters[name]).lte(1000));
}

const metadataFrom=dataset=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:SYMBOL,timeframe:'1',start_time:dataset.start_time,
 end_time:dataset.end_time+MINUTE,warmup_bars:dataset.warmup_bars,total_bars:dataset.bar_count,cutoff:dataset.end_time+MINUTE,source:'binance-spot-klines-v1'});
/** Dataset metadata the worker publishes and the foundation request pins (spot-dataset-v1, half-open end). */
export function fixedEvalPendingMetadata(contract){
 return validateDatasetMetadata(metadataFrom(validateFixedEvalContract(contract).dataset));
}
/** Index range the evaluator scores inside the dataset: bars [warmup, end). */
export function fixedEvalWindow(contract){
 const d=validateFixedEvalContract(contract).dataset;
 return {warmup:d.warmup_bars,end:d.bar_count};
}
export function fixedEvalSelectionId(contract){
 const c=validateFixedEvalContract(contract);
 return c.purpose==='QR4_SELECTION'?c.lineage.object_id:null;
}

/** Exact-shape validation of the stored contract. Returns a canonical copy and never mutates the input.
 * It checks shape and internal consistency only. It does not prove v1 policy equality with the parent or the truth of
 * the lineage; callers that enqueue or authorize must re-read the parent row and compare (FE-2b). */
export function validateFixedEvalContract(value){
 guard(INVALID_CONTRACT,()=>{
  strictJsonV2(value);
  keys(value,CONTRACT_KEYS);
  need(value.version===V.contract&&value.mode===V.mode&&value.scope===SCOPE&&value.execution_backend===BACKEND);
  need(FIXED_EVAL_PURPOSES.includes(value.purpose));
  need(identifier(value.owner_id)&&identifier(value.bot_id));
  need(typeof value.deployment_id==='string'&&value.deployment_id.length>0&&value.deployment_id.length<=200);
  keys(value.lineage,LINEAGE_KEYS);
  need(identifier(value.lineage.parent_run_id)&&sha(value.lineage.parent_contract_hash)&&value.lineage.object_kind===value.purpose&&
   identifier(value.lineage.object_id));
  need(sha(value.engine_hash));
  checkedParameters(value.parameters);
  keys(value.capital,CAPITAL_KEYS);
  need(positive(value.capital.initial_cash)&&positive(value.capital.initial_equity)&&value.capital.initial_inventory==='0'&&value.capital.quote==='USDT');
  keys(value.policy,[...FIXED_EVAL_POLICY_KEYS]);
  for(const name of FIXED_EVAL_POLICY_KEYS)need(policyValue(name,value.policy[name]));
  need(sha(value.policy_hash)&&value.policy_hash===hash(canonical(value.policy)));
  const m=value.cost_model;
  keys(m,MODEL_KEYS);
  need(m.version===V.model&&m.data_profile===V.profile&&positive(m.price_tick)&&positive(m.quantity_step)&&positive(m.risk_percent)&&
   decimalText(m.fee_bps)&&decimalText(m.slippage_bps));
  need(D(m.fee_bps).lte(1000)&&D(m.slippage_bps).lte(1000)&&D(m.risk_percent).lte(100));
  const d=value.dataset;
  keys(d,DATASET_KEYS);
  need(integer(d.start_time,1,MAX_TIME)&&integer(d.end_time,1,MAX_TIME)&&d.start_time%MINUTE===0&&d.end_time%MINUTE===0&&d.start_time<d.end_time);
  need(integer(d.bar_count,1,FIXED_EVAL_LIMITS.totalBars)&&d.bar_count===1+(d.end_time-d.start_time)/MINUTE);
  need(d.first_time===d.start_time&&d.timestamp_semantics===TIMESTAMP_SEMANTICS&&sha(d.content_digest)&&d.digest_version===V.digest);
  const floor=Math.max(FIXED_EVAL_LIMITS.warmupFloor,FIXED_EVAL_LIMITS.warmupEmaMultiple*value.parameters.inputs.ema_slow);
  need(integer(d.warmup_bars,floor,FIXED_EVAL_LIMITS.warmupMax)&&d.warmup_bars<d.bar_count);
  validateDatasetMetadata(metadataFrom(d));
  const p=value.parent_dataset_range;
  keys(p,['start_time','end_time']);
  need(integer(p.start_time,1,MAX_TIME)&&integer(p.end_time,1,MAX_TIME)&&p.start_time%MINUTE===0&&p.end_time%MINUTE===0&&p.start_time<=p.end_time);
  // The scored part (after the warm-up) must not touch the parent dataset. Warm-up bars may.
  const scoredStart=d.start_time+d.warmup_bars*MINUTE;
  if(scoredStart<=p.end_time&&d.end_time>=p.start_time)refuse('FIXED_EVAL_WINDOW_OVERLAPS_PARENT');
 });
 return clone(value);
}

/** Builds the stored contract from resolved values. Derived fields (mode, scope, backend, bar count, window,
 * policy hash, object kind) are computed here. The policy equals the parent policy under v1 (QR-4 OD-S7; QR-3 v1):
 * a different policy is FIXED_EVAL_POLICY_MISMATCH. Search fields anywhere in the input are refused first.
 * parent_dataset_range is {start_time,end_time} taken from the verified parent contract dataset: closed-bar
 * timestamps with an inclusive end, never the half-open metadata end (last bar plus one minute).
 */
export function buildFixedEvalContract(input){
 // Copy descriptors, never values: no top-level getter runs before strictJsonV2 refuses it.
 const source=plain(input)?input:{};
 const rest={};
 let parentPolicy;
 for(const name of Reflect.ownKeys(source)){
  const field=Object.getOwnPropertyDescriptor(source,name);
  if(name==='parent_policy'){
   if(field&&Object.hasOwn(field,'value'))parentPolicy=field.value;
  }else Object.defineProperty(rest,name,field);
 }
 refuseSearchFields(rest);
 let contract;
 guard(INVALID_CONTRACT,()=>{
  strictJsonV2(rest);
  keys(rest,BUILD_KEYS);
  keys(rest.lineage,['parent_run_id','parent_contract_hash','object_id']);
  keys(rest.dataset,['start_time','end_time','warmup_bars','content_digest']);
  need(plain(rest.parameters)&&plain(rest.policy));
  const policy=projectFixedEvalPolicy(rest.policy);
  if(hash(canonical(policy))!==hash(canonical(projectFixedEvalPolicy(parentPolicy))))refuse('FIXED_EVAL_POLICY_MISMATCH');
  const d=rest.dataset;
  contract={version:V.contract,mode:V.mode,purpose:rest.purpose,scope:SCOPE,execution_backend:BACKEND,owner_id:rest.owner_id,bot_id:rest.bot_id,
   deployment_id:rest.deployment_id,lineage:{parent_run_id:rest.lineage.parent_run_id,parent_contract_hash:rest.lineage.parent_contract_hash,
    object_kind:rest.purpose,object_id:rest.lineage.object_id},engine_hash:rest.engine_hash,parameters:rest.parameters,capital:rest.capital,policy,
   policy_hash:hash(canonical(policy)),cost_model:rest.cost_model,
   dataset:{start_time:d.start_time,end_time:d.end_time,warmup_bars:d.warmup_bars,bar_count:1+(d.end_time-d.start_time)/MINUTE,first_time:d.start_time,
    timestamp_semantics:TIMESTAMP_SEMANTICS,content_digest:d.content_digest,digest_version:V.digest},parent_dataset_range:rest.parent_dataset_range};
 });
 return validateFixedEvalContract(contract);
}
export function fixedEvalContractHash(contract){
 return hash(canonical(validateFixedEvalContract(contract)));
}

function requestFrom(contract,maxRuntimeMs){
 const d=contract.dataset;
 return {version:V.request,owner_id:contract.owner_id,bot_id:contract.bot_id,kind:'BACKTEST',
  pending_dataset:{metadata:metadataFrom(d),content_digest:d.content_digest,digest_version:d.digest_version},engine_hash:contract.engine_hash,
  snapshot_hash:contract.lineage.parent_contract_hash,
  budget:{candidates:1,max_evaluations:FIXED_EVAL_LIMITS.evaluations,chunk_bars:d.bar_count,max_runtime_ms:maxRuntimeMs,
   max_output_bytes:FIXED_EVAL_LIMITS.outputBytes,max_state_bytes:FIXED_EVAL_LIMITS.stateBytes}};
}
function checkedRequest(value){
 try{strictJsonV2(value);}catch{throw fail('INVALID_FIELDS');}
 keys(value,REQUEST_KEYS);
 if(value.version!==V.request)throw fail('UNSUPPORTED_FOUNDATION_VERSION');
 if(!identifier(value.owner_id)||!identifier(value.bot_id))throw fail('INVALID_FOUNDATION_ID');
 if(value.kind!=='BACKTEST')throw fail('INVALID_FOUNDATION_KIND');
 if(!sha(value.engine_hash)||!sha(value.snapshot_hash))throw fail('INVALID_FOUNDATION_HASH');
 const pending=value.pending_dataset;
 keys(pending,PENDING_KEYS);
 const metadata=validateDatasetMetadata(pending.metadata);
 if(!sha(pending.content_digest))throw fail('INVALID_FOUNDATION_HASH');
 if(pending.digest_version!==V.digest)throw fail('UNSUPPORTED_FOUNDATION_VERSION');
 if(metadata.cutoff!==metadata.end_time)throw fail('INVALID_DATASET_INTERVAL');
 if(metadata.total_bars>FIXED_EVAL_LIMITS.totalBars)throw fail('FOUNDATION_CAPABILITY_LIMIT');
 const budget=value.budget;
 keys(budget,BUDGET_KEYS);
 const bounds={candidates:1,max_evaluations:FIXED_EVAL_LIMITS.evaluations,chunk_bars:Math.min(FOUNDATION_LIMITS.chunkBars,metadata.total_bars),
  max_runtime_ms:FIXED_EVAL_LIMITS.runtimeMs,max_output_bytes:FIXED_EVAL_LIMITS.outputBytes,max_state_bytes:FIXED_EVAL_LIMITS.stateBytes};
 for(const [name,max] of Object.entries(bounds))if(!integer(budget[name],1,max))throw fail('INVALID_FOUNDATION_BUDGET');
 if(budget.candidates!==1||budget.max_evaluations!==FIXED_EVAL_LIMITS.evaluations)throw fail('INVALID_FOUNDATION_BUDGET');
 return clone({...value,pending_dataset:{...pending,metadata}});
}
/** The pending foundation request an enqueue stores for this contract (kind BACKTEST, no dataset reference yet).
 * It is routed on its version, never on its kind alone. snapshot_hash is the parent contract hash.
 */
export function expectedFixedEvalRequest(contract,maxRuntimeMs){
 return checkedRequest(requestFrom(validateFixedEvalContract(contract),maxRuntimeMs));
}
/** Validates a stored request. With a contract it must also equal the request that contract yields. */
export function validateFixedEvalRequest(value,contract){
 const request=checkedRequest(value);
 if(contract!==undefined&&canonical(request)!==canonical(requestFrom(validateFixedEvalContract(contract),request.budget.max_runtime_ms))){
  throw fail('FIXED_EVAL_REQUEST_MISMATCH');
 }
 return request;
}

function materialize(contract,references,datasetSha256){
 return clone({...contract,dataset:{...contract.dataset,sha256:datasetSha256,references}});
}
function checkedBinding(contract,parameters){
 return guard(INVALID_BINDING,()=>{
  strictJsonV2(parameters);
  keys(parameters,BINDING_KEYS);
  need(parameters.version===V.binding);
  const {references}=parameters;
  keys(references,['raw','sidecar']);
  const raw=validateDatasetReference(references.raw);
  need(canonical(raw.metadata)===canonical(metadataFrom(contract.dataset)));
  const sidecar=references.sidecar;
  keys(sidecar,SIDECAR_KEYS);
  need(sha(sidecar.sha256)&&sidecar.bar_count===contract.dataset.bar_count&&sidecar.first_time===contract.dataset.start_time);
  need(sidecar.profile===contract.cost_model.data_profile&&sidecar.price_tick===contract.cost_model.price_tick&&sidecar.quantity_step===contract.cost_model.quantity_step);
  need(sha(parameters.dataset_sha256)&&parameters.content_digest===contract.dataset.content_digest&&parameters.bar_count===contract.dataset.bar_count);
  need(parameters.execution_contract_hash===hash(canonical(materialize(contract,references,parameters.dataset_sha256))));
  return clone(parameters);
 });
}
/** Builds the write-once dataset binding parameters from the published references and the file digest. */
export function fixedEvalBindingParameters(contract,input){
 const checked=validateFixedEvalContract(contract);
 let parameters;
 guard(INVALID_BINDING,()=>{
  keys(input,['references','dataset_sha256']);
  const {references,dataset_sha256:datasetSha256}=input;
  strictJsonV2({references,dataset_sha256:datasetSha256});
  parameters={version:V.binding,references,dataset_sha256:datasetSha256,content_digest:checked.dataset.content_digest,bar_count:checked.dataset.bar_count,
   execution_contract_hash:hash(canonical(materialize(checked,references,datasetSha256)))};
 });
 return checkedBinding(checked,parameters);
}
/** Exact-shape validation of a stored binding against its contract. Returns a canonical copy. */
export function validateFixedEvalBinding(contract,parameters){
 return checkedBinding(validateFixedEvalContract(contract),parameters);
}
/** Identity hash of the binding step row, on the formula the research worker uses for every chunk. */
export function fixedEvalBindingIdentity(contract,parameters){
 const checked=validateFixedEvalContract(contract);
 return hash(canonical({contract:checked,parameters:checkedBinding(checked,parameters),kind:DATASET_BINDING_KIND}));
}

const rowNumber=value=>(typeof value==='string'&&value.length<=64&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))||(typeof value==='number'&&Number.isFinite(value));
/** The exact request the Python job receives for one step (version fixed-eval-v1 request keys). `rows` are the dataset
 * rows read through the binding (closed-bar time, OHLCV, frozen atr14); extra row keys are dropped, not forwarded.
 */
export function fixedEvalJobRequest(contract,binding,kind,rows){
 const c=validateFixedEvalContract(contract),b=checkedBinding(c,binding);
 return guard(INVALID_ROWS,()=>{
  need(Object.hasOwn(FACTOR,kind));
  need(Array.isArray(rows)&&rows.length===c.dataset.bar_count);
  const frozen=rows.map((row,index)=>{
   need(plain(row)&&ROW_KEYS.every(name=>Object.hasOwn(row,name)));
   need(row.time===c.dataset.first_time+index*MINUTE);
   for(const name of ROW_KEYS.slice(1))need(rowNumber(row[name]));
   return Object.fromEntries(ROW_KEYS.map(name=>[name,row[name]]));
  });
  const m=c.cost_model;
  return {contract:{model:{price_tick:m.price_tick,quantity_step:m.quantity_step,fee_bps:m.fee_bps,slippage_bps:m.slippage_bps,risk_percent:m.risk_percent,
    version:m.version},policy:c.policy,initial_cash:c.capital.initial_cash,initial_equity:c.capital.initial_equity,broker:BROKER,symbol:SYMBOL,
    deployment_id:c.deployment_id,engine_hash:c.engine_hash,dataset_sha256:b.dataset_sha256,parent_run_id:c.lineage.parent_run_id,
    selection_id:c.purpose==='QR4_SELECTION'?c.lineage.object_id:null,rows:frozen},
   parameters:clone(c.parameters),kind,split:{warmup:c.dataset.warmup_bars,end:c.dataset.bar_count}};
 });
}

const sameNumber=(left,right)=>{try{return D(left).eq(D(right));}catch{return false;}};
function checkedStep(c,b,kind,result){
 strictJsonV2(result);
 keys(result,STEP_RESULT_KEYS);
 const factor=FACTOR[kind],m=c.cost_model;
 need(result.version===V.step&&result.evaluator_closure===V.closure&&result.kind===kind);
 need(result.engine_hash===c.engine_hash&&result.dataset_sha256===b.dataset_sha256&&result.parent_run_id===c.lineage.parent_run_id);
 need(result.selection_id===(c.purpose==='QR4_SELECTION'?c.lineage.object_id:null));
 keys(result.cost_stress,['fee_multiplier','slippage_multiplier']);
 need(result.cost_stress.fee_multiplier===String(factor)&&result.cost_stress.slippage_multiplier===String(factor));
 keys(result.model,['price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','version']);
 need(result.model.version===m.version&&sameNumber(result.model.price_tick,m.price_tick)&&sameNumber(result.model.quantity_step,m.quantity_step)&&
  sameNumber(result.model.risk_percent,m.risk_percent)&&sameNumber(result.model.fee_bps,D(m.fee_bps).mul(factor))&&
  sameNumber(result.model.slippage_bps,D(m.slippage_bps).mul(factor)));
 keys(result.bridge,['atr_multiplier','rr']);
 need(sameNumber(result.bridge.atr_multiplier,c.parameters.atr_multiplier)&&sameNumber(result.bridge.rr,c.parameters.rr));
 need(sameNumber(result.initial_equity,c.capital.initial_equity));
 keys(result.split,['warmup','end','evaluated_bars']);
 need(result.split.warmup===c.dataset.warmup_bars&&result.split.end===c.dataset.bar_count&&result.split.evaluated_bars===c.dataset.bar_count-c.dataset.warmup_bars);
 need(result.metrics_precision===80&&plain(result.metrics)&&Array.isArray(result.fills)&&plain(result.exposure)&&plain(result.episodes)&&
  plain(result.open_position)&&plain(result.rejected));
 need(integer(result.closed_allocations,0,result.fills.length)&&decimalText(result.fees_total)&&decimalText(result.slippage_cost_incl_tick_total));
 return clone(result);
}
/** Validates one Python step result against the contract and its binding: closure constant, echoed identities,
 * frozen window, cost stress and model. It does not re-derive metrics; FE-3 valuation owns that. */
export function validateFixedEvalStepResult(contract,binding,kind,result){
 const c=validateFixedEvalContract(contract),b=checkedBinding(c,binding);
 return guard(INVALID_RESULT,()=>{need(Object.hasOwn(FACTOR,kind));return checkedStep(c,b,kind,result);});
}

/** The stored run result (fixed-eval-result-v1). `closure` is {version, hash} of the evaluation closure the worker
 * computed; its hash must equal the frozen engine_hash. */
export function buildFixedEvalResult(contract,binding,steps,closure){
 const c=validateFixedEvalContract(contract),b=checkedBinding(c,binding);
 const {base,stress}=guard(INVALID_RESULT,()=>{need(plain(steps));return steps;});
 guard(INVALID_RESULT,()=>{
  keys(closure,['version','hash']);
  need(closure.version===V.closure&&closure.hash===c.engine_hash);
 });
 const result={version:V.result,mode:V.mode,purpose:c.purpose,lineage:c.lineage,engine_hash:c.engine_hash,evaluation_closure:{version:closure.version,hash:closure.hash},
  dataset_sha256:b.dataset_sha256,base:validateFixedEvalStepResult(c,b,'EVALUATION',base),stress:validateFixedEvalStepResult(c,b,'EVALUATION_STRESS',stress)};
 return validateFixedEvalResult(c,b,result);
}
export function validateFixedEvalResult(contract,binding,value){
 const c=validateFixedEvalContract(contract),b=checkedBinding(c,binding);
 return guard(INVALID_RESULT,()=>{
  strictJsonV2(value);
  keys(value,RESULT_KEYS);
  need(value.version===V.result&&value.mode===V.mode&&value.purpose===c.purpose&&canonical(value.lineage)===canonical(c.lineage));
  need(value.engine_hash===c.engine_hash&&value.dataset_sha256===b.dataset_sha256);
  keys(value.evaluation_closure,['version','hash']);
  need(value.evaluation_closure.version===V.closure&&value.evaluation_closure.hash===c.engine_hash);
  checkedStep(c,b,'EVALUATION',value.base);
  checkedStep(c,b,'EVALUATION_STRESS',value.stress);
  return clone(value);
 });
}

deepFreeze(FIXED_EVAL_INPUT_FIELDS);
