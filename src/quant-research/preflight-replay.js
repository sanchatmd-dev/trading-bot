import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {D,exact} from '../money.js';
import {canonical,fail as makeError,hash} from '../pine-bridge/source.js';
import {FOUNDATION_LIMITS} from './foundation-contract.js';
import {frozenV2,strictJsonV2} from './foundation-contract-v2.js';
import {PF2_RESOLVED_VERSION,pf2ExecutableHashes} from './preflight-resolver.js';

/**
 * PF-2 replay driver (slice S4). Development only, V1 only, local proof only.
 * Reads the closed rows of one enrolled research dataset chunk by chunk, runs the S1 replay
 * core through an injected runChunk, and returns a frozen envelope after Node re-checks every
 * response. Pure library: no database, network, scheduler or write API. Every value from an
 * injected adapter is untrusted data: it is detached once and only the copy is used.
 */
export const PF2_REPLAY_ENVELOPE_VERSION='pf2-preflight-replay-v1';
export const PF2_RESUME_VERSION='pf2-replay-resume-v1';
export const PF2_CHUNK_VERSION='pf2-replay-chunk-v1';
export const PF2_JOB_VERSION='pf2-replay-job-v1';
export const PF2_RESULT_VERSION='pf2-replay-result-v1';

export const PF2_REPLAY_LIMITS=Object.freeze({ipcBytes:8388608,stateBytes:1048576,maxBars:10000,maxSamples:200,
  chunkTimeoutMs:30000,minChunkTimeoutMs:100,killGraceMs:5000,maxRuntimeMs:900000});

export const PF2_REPLAY_ERRORS=Object.freeze(['PF2_REPLAY_CONFIG_INVALID','PF2_RESOLVED_INVALID',
  'PF2_RESUME_INVALID','PF2_ENGINE_HASH_MISMATCH','PF2_EVALUATOR_HASH_MISMATCH','PF2_CANCELLED',
  'PF2_DEADLINE_EXCEEDED','PF2_CHUNK_TIMEOUT','PF2_DATASET_READ_FAILED','PF2_ROW_INVALID','PF2_ROW_CONTINUITY',
  'PF2_HOLDOUT_BOUNDARY_VIOLATION','PF2_LIMIT_EXCEEDED','PF2_RUNNER_FAILED','PF2_RESPONSE_INVALID',
  'PF2_RESULT_INVALID','PF2_CHECKPOINT_SINK_FAILED','PF2_REPLAY_FAILED']);

// Codes the S1 child may report with exit 1; each is passed through unchanged.
export const PF2_S1_ERRORS=Object.freeze(['PF2_REQUEST_INVALID','PF2_UNSUPPORTED_EXECUTION_MODEL',
  'PF2_UNSUPPORTED_SIGNAL_MODE','PF2_INITIAL_STATE_UNSUPPORTED','PF2_HOLDOUT_BOUNDARY_VIOLATION',
  'PF2_ROW_CONTINUITY','PF2_ROW_INVALID','PF2_CHECKPOINT_INVALID','PF2_LIMIT_EXCEEDED',
  'PF2_EVALUATOR_UNAVAILABLE','PF2_EVALUATION_FAILED']);

export const PF2_REPLAY_LIMITATIONS=Object.freeze(['LOCAL_DRIVER_ONLY','RUNNER_ISOLATION_NOT_VERIFIED',
  'PYTHON_RUNTIME_NOT_HASHED','CHECKPOINT_INTEGRITY_NOT_AUTHENTICATED','ENGINE_HASH_ON_DISK_BRACKETED',
  'NO_COLLECTION_ETA','ROW_CONTENT_VERIFIED_BY_STORE_ONLY']);

const MINUTE=60000;
const DAY=86_400_000;
const MAX_TIME_MS=253_402_300_799_999;
const MAX_NODES=1_000_000;
const GUARD_KINDS=['KILL_SWITCH','MAX_TRADES_PER_DAY','MAX_DAILY_LOSS','LOSS_STREAK'];
const PERSISTENT_KINDS=['KILL_SWITCH','LOSS_STREAK'];
const EXIT_REASONS=['SL','TP','NATIVE'];
const RESULT_LIMITATIONS=['V1_ONLY','DEVELOPMENT_ONLY','EVALUATOR_ADMISSION_FALSE','DIAGNOSTIC_ONLY',
  'SIZING_ADJUSTED_INCLUDES_QUANTITY_STEP_ROUNDING'];
const ADMISSION={development_only:true,evaluator_admission:false,holdout_accessed:false,orders_executed:false,
  execution_model_parity:'V1_ONLY'};
const NO_ETA_KEYS=[/(^|_)eta(_|$)/i,/estimat/i,/collection/i];

// Errors minted here are tracked by identity, so a value thrown by an adapter can never pass as
// a driver error, whatever code it claims.
const ownErrors=new WeakSet();
function fail(code){
  const error=makeError(code);
  ownErrors.add(error);
  return error;
}
const bad=code=>{throw fail(code);};
const attempt=operation=>{try{return operation();}catch{return false;}};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,names)=>isObject(value)&&Object.keys(value).length===names.length&&
  names.every(name=>Object.hasOwn(value,name));
const isSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safeInt=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const printable=(value,min=0,max=Infinity)=>typeof value==='string'&&value.length>=min&&
  value.length<=max&&/^[\x20-\x7e]*$/.test(value);
const lonelySurrogate=/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const sum=values=>values.reduce((total,value)=>total+value,0);
const nextMidnight=time=>(Math.floor(time/DAY)+1)*DAY;

/** Canonical decimal text: one spelling per value, so both languages read the same bytes. */
function canonicalDecimal(value,{positive=false}={}){
  if(typeof value!=='string'||value.length>64||!/^[0-9]+(?:\.[0-9]+)?$/.test(value))return false;
  return attempt(()=>exact(value)===value&&(positive?D(value).gt(0):true));
}

/** Plain non-negative decimal text as the S1 core prints it (fixed point, no exponent). */
const plainDecimal=(value,max)=>typeof value==='string'&&value.length>=1&&value.length<=max&&
  /^[0-9]+(?:\.[0-9]+)?$/.test(value)&&attempt(()=>D(value).gte(0));

/**
 * One structural pass over untrusted data. Each property is read once through its descriptor
 * (accessors, symbols, holes and odd prototypes are refused, get traps are never used); the
 * plain copy is then re-validated and re-serialized, and only that copy is used.
 */
function detach(value,code){
  let nodes=0;
  const active=new Set();
  const refuse=()=>{throw fail(code);};
  const copy=input=>{
    if(input===null||typeof input==='string'||typeof input==='boolean')return input;
    if(typeof input==='number'){if(!Number.isFinite(input))refuse();return input;}
    if(typeof input!=='object'||active.has(input)||++nodes>MAX_NODES)refuse();
    active.add(input);
    let output;
    if(Array.isArray(input)){
      if(Object.getPrototypeOf(input)!==Array.prototype)refuse();
      const length=Object.getOwnPropertyDescriptor(input,'length')?.value;
      if(!safeInt(length,0,MAX_NODES)||Reflect.ownKeys(input).length!==length+1)refuse();
      output=[];
      for(let index=0;index<length;index++){
        const field=Object.getOwnPropertyDescriptor(input,String(index));
        if(!field||!field.enumerable||!Object.hasOwn(field,'value'))refuse();
        output.push(copy(field.value));
      }
    }else{
      const prototype=Object.getPrototypeOf(input);
      if(prototype!==Object.prototype&&prototype!==null)refuse();
      output={};
      for(const name of Reflect.ownKeys(input)){
        if(typeof name!=='string')refuse();
        const field=Object.getOwnPropertyDescriptor(input,name);
        if(!field||!field.enumerable||!Object.hasOwn(field,'value'))refuse();
        Object.defineProperty(output,name,{value:copy(field.value),enumerable:true,writable:true,configurable:true});
      }
    }
    active.delete(input);
    return output;
  };
  try{
    const shaped=copy(value);
    strictJsonV2(shaped);
    return JSON.parse(canonical(shaped));
  }catch{throw fail(code);}
}

/** Wire rule for tokens and results: safe integers only (no float), printable ASCII text. */
function assertWire(value,code){
  const walk=item=>{
    if(typeof item==='string'){if(!printable(item))bad(code);return;}
    if(typeof item==='number'){if(!Number.isSafeInteger(item)||Object.is(item,-0))bad(code);return;}
    if(typeof item==='boolean'||item===null)return;
    if(Array.isArray(item)){item.forEach(walk);return;}
    if(isObject(item)){for(const [key,child] of Object.entries(item)){walk(key);walk(child);}return;}
    bad(code);
  };
  walk(value);
}

// --- resolved intake (section 3) ----------------------------------------------------

const RESOLVED_KEYS=['version','plan_hash','owner_id','bot_id','budget','identities','dataset','contract',
  'admission','acceptance_blockers','limitations'];
const BUDGET_KEYS=['chunk_bars','max_runtime_ms','max_output_bytes','max_state_bytes'];
const IDENTITY_KEYS=['engine_hash','evaluator_hash','source_hash','effective_inputs_hash','bridge_hash',
  'policy_hash','capital_hash','initial_state_hash','execution_model_hash','venue_metadata_hash',
  'raw_dataset_sha256','closed_dataset_sha256','atr14_sha256','enrollment_binding_sha256',
  'raw_provenance_sha256','enrollment_evaluator_hash'];
const DATASET_KEYS=['raw','research','first_time','total_bars','warmup_bars','evaluation_start_time','last_time',
  'development_start_time','development_end_time','holdout_start_time'];
const CONTRACT_KEYS=['version','plan_hash','deployment_id','signal','bridge','model','policy','capital',
  'initial_state','broker','symbol','dataset','limits'];
const MODEL_KEYS=['price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','version'];
const POLICY_KEYS=['killSwitch','maxSignalAgeSeconds','maxTradesPerDay','maxDailyLossR','pauseAfterLossStreak',
  'blockHighVolatility','maxVolatilityPercent','blockDuringNews','allowedSymbols','sideMode','maxOpenPositions',
  'onePositionPerSymbol','capPercentEquitySize','maxRiskPercent','maxOrderNotional','maxDailyNotional'];
const CONTRACT_DATASET_KEYS=['first_time','total_bars','warmup_bars','development_end_time','holdout_start_time'];
const LIMIT_KEYS=['max_bars','max_state_bytes','max_output_bytes','max_samples'];

const admissionOk=value=>exactKeys(value,Object.keys(ADMISSION))&&
  Object.entries(ADMISSION).every(([name,expected])=>value[name]===expected);
const uniquePrintable=list=>Array.isArray(list)&&list.every(item=>printable(item,1,128))&&
  new Set(list).size===list.length;
const stateLimit=budget=>Math.min(PF2_REPLAY_LIMITS.stateBytes,budget.max_state_bytes);

/** Shape and cross-field checks of a detached S3 output. Throws PF2_RESOLVED_INVALID. */
function checkResolved(resolved){
  const ok=condition=>{if(!condition)bad('PF2_RESOLVED_INVALID');};
  ok(exactKeys(resolved,RESOLVED_KEYS)&&resolved.version===PF2_RESOLVED_VERSION&&isSha(resolved.plan_hash)&&
    typeof resolved.owner_id==='string'&&resolved.owner_id.length>=1&&
    typeof resolved.bot_id==='string'&&resolved.bot_id.length>=1);
  const budget=resolved.budget,identities=resolved.identities,data=resolved.dataset,contract=resolved.contract;
  ok(exactKeys(budget,BUDGET_KEYS)&&safeInt(budget.chunk_bars,1,Number.MAX_SAFE_INTEGER)&&
    safeInt(budget.max_runtime_ms,1,PF2_REPLAY_LIMITS.maxRuntimeMs)&&safeInt(budget.max_output_bytes,1024,8388608)&&
    safeInt(budget.max_state_bytes,4096,PF2_REPLAY_LIMITS.stateBytes));
  ok(exactKeys(identities,IDENTITY_KEYS)&&IDENTITY_KEYS.every(name=>isSha(identities[name]))&&
    identities.engine_hash!==identities.evaluator_hash);
  ok(admissionOk(resolved.admission)&&uniquePrintable(resolved.acceptance_blockers)&&
    uniquePrintable(resolved.limitations));
  ok(exactKeys(data,DATASET_KEYS)&&safeInt(data.total_bars,1,PF2_REPLAY_LIMITS.maxBars)&&
    safeInt(data.warmup_bars,0,data.total_bars-1)&&safeInt(data.first_time,1,MAX_TIME_MS)&&data.first_time%MINUTE===0&&
    data.evaluation_start_time===data.first_time+data.warmup_bars*MINUTE&&
    data.last_time===data.first_time+(data.total_bars-1)*MINUTE&&
    safeInt(data.development_start_time,1,MAX_TIME_MS)&&data.development_start_time<data.first_time&&
    safeInt(data.development_end_time,1,MAX_TIME_MS)&&safeInt(data.holdout_start_time,1,MAX_TIME_MS)&&
    data.last_time<=data.development_end_time&&data.development_end_time<=data.holdout_start_time&&
    isObject(data.raw)&&data.raw.sha256===identities.raw_dataset_sha256);
  const research=data.research;
  ok(exactKeys(research,['raw','sidecar'])&&isObject(research.raw)&&isObject(research.raw.metadata)&&
    research.raw.sha256===identities.closed_dataset_sha256&&research.raw.metadata.start_time===data.first_time&&
    research.raw.metadata.total_bars===data.total_bars&&isObject(research.sidecar)&&
    research.sidecar.sha256===identities.atr14_sha256&&research.sidecar.bar_count===data.total_bars&&
    research.sidecar.first_time===data.first_time);
  ok(exactKeys(contract,CONTRACT_KEYS)&&contract.version===PF2_JOB_VERSION&&contract.plan_hash===resolved.plan_hash&&
    typeof contract.deployment_id==='string'&&/^[A-Za-z0-9_.-]{1,64}$/.test(contract.deployment_id));
  const signal=contract.signal;
  ok(exactKeys(signal,['mode','profile','source','snapshot'])&&signal.mode==='EVALUATOR'&&
    signal.profile==='SPT_CUSTOM'&&typeof signal.source==='string'&&signal.source.length>=1&&
    !lonelySurrogate.test(signal.source)&&hash(signal.source)===identities.source_hash&&
    isObject(signal.snapshot)&&signal.snapshot.source_hash===identities.source_hash);
  const bridge=contract.bridge,model=contract.model,capital=contract.capital,initial=contract.initial_state;
  ok(exactKeys(bridge,['atr_multiplier','rr'])&&canonicalDecimal(bridge.atr_multiplier,{positive:true})&&
    canonicalDecimal(bridge.rr,{positive:true}));
  ok(exactKeys(model,MODEL_KEYS)&&model.version==='paper-close-v1'&&
    ['price_tick','quantity_step','risk_percent'].every(name=>canonicalDecimal(model[name],{positive:true}))&&
    ['fee_bps','slippage_bps'].every(name=>canonicalDecimal(model[name])));
  ok(attempt(()=>D(research.sidecar.price_tick).eq(D(model.price_tick))&&
    D(research.sidecar.quantity_step).eq(D(model.quantity_step))));
  ok(exactKeys(contract.policy,POLICY_KEYS)&&exactKeys(capital,['cash','equity'])&&
    canonicalDecimal(capital.cash,{positive:true})&&canonicalDecimal(capital.equity,{positive:true}));
  ok(exactKeys(initial,['kind','loss_streak'])&&initial.kind==='FRESH'&&initial.loss_streak===0);
  ok(contract.broker==='binance-global'&&contract.symbol==='BTCUSDT');
  ok(exactKeys(contract.dataset,CONTRACT_DATASET_KEYS)&&
    CONTRACT_DATASET_KEYS.every(name=>contract.dataset[name]===data[name]));
  const limits=contract.limits;
  ok(exactKeys(limits,LIMIT_KEYS)&&limits.max_bars===FOUNDATION_LIMITS.admittedBars&&
    data.total_bars<=limits.max_bars&&limits.max_state_bytes===budget.max_state_bytes&&
    limits.max_output_bytes===budget.max_output_bytes&&safeInt(limits.max_samples,0,PF2_REPLAY_LIMITS.maxSamples));
}

/** Detach once, validate, freeze. Only the returned context is used afterwards. */
function intakeResolved(value){
  const copy=detach(value,'PF2_RESOLVED_INVALID');
  try{checkResolved(copy);}catch{throw fail('PF2_RESOLVED_INVALID');}
  const resolved=frozenV2(copy);
  const data=resolved.dataset;
  return Object.freeze({resolved,contract:resolved.contract,budget:resolved.budget,identities:resolved.identities,
    dataset:data,planHash:resolved.plan_hash,first:data.first_time,total:data.total_bars,warmup:data.warmup_bars,
    evaluationStart:data.evaluation_start_time,last:data.last_time,developmentEnd:data.development_end_time,
    chunkBars:Math.min(resolved.budget.chunk_bars,data.total_bars),stateLimit:stateLimit(resolved.budget),
    contractSha:hash(canonical(resolved.contract)),resolvedSha:hash(canonical(resolved))});
}

// --- rows, requests and checkpoints (sections 3.5, 4, 6) ---------------------------------

const ROW_FIELDS=['time','open','high','low','close','volume','atr14'];
const CHECKPOINT_KEYS=['version','identity','next_bar','last_time','evaluator','paper','counters','guards',
  'samples','integrity'];

/** Store rows carry Binance text verbatim (trailing zeros); S1 receives exact() text. */
function rowDecimal(value,{positive}){
  if(typeof value!=='string'||value.length>64||!/^[0-9]+(?:\.[0-9]+)?$/.test(value))bad('PF2_ROW_INVALID');
  let text;
  try{text=exact(value);}catch{throw fail('PF2_ROW_INVALID');}
  if(!attempt(()=>positive?D(text).gt(0):D(text).gte(0)))bad('PF2_ROW_INVALID');
  return text;
}

/** One descriptor read per field, so a Proxy or getter row is judged on the copy only. */
function detachRow(value){
  if(value===null||typeof value!=='object'||Array.isArray(value))bad('PF2_ROW_INVALID');
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)bad('PF2_ROW_INVALID');
  const names=Reflect.ownKeys(value);
  if(names.length!==ROW_FIELDS.length||names.some(name=>!ROW_FIELDS.includes(name)))bad('PF2_ROW_INVALID');
  const row={};
  for(const name of ROW_FIELDS){
    const field=Object.getOwnPropertyDescriptor(value,name);
    if(!field||!field.enumerable||!Object.hasOwn(field,'value'))bad('PF2_ROW_INVALID');
    row[name]=field.value;
  }
  return row;
}

/** Returns {raw,row}: the detached input and the normalized S1 row. */
function normalizeRow(value,index,ctx){
  const raw=detachRow(value);
  if(!Number.isSafeInteger(raw.time))bad('PF2_ROW_INVALID');
  if(raw.time>ctx.developmentEnd)bad('PF2_HOLDOUT_BOUNDARY_VIOLATION');
  if(raw.time!==ctx.first+index*MINUTE)bad('PF2_ROW_CONTINUITY');
  const row={time:raw.time};
  for(const name of ROW_FIELDS.slice(1))row[name]=rowDecimal(raw[name],{positive:name!=='volume'});
  return {raw,row};
}

/** Header, integrity and cursor of a checkpoint; the rest is opaque here and checked by S1. */
function checkpointHeader(ctx,checkpoint,pinned,codes){
  if(!exactKeys(checkpoint,CHECKPOINT_KEYS))bad(codes.shape);
  if(Buffer.byteLength(canonical(checkpoint))>ctx.stateLimit)bad(codes.size);
  const identity=checkpoint.identity;
  if(checkpoint.version!==PF2_CHUNK_VERSION||!exactKeys(identity,['plan_hash','contract_digest'])||
     identity.plan_hash!==ctx.planHash||!isSha(identity.contract_digest)||
     (pinned!==null&&identity.contract_digest!==pinned))bad(codes.shape);
  const {integrity,...payload}=checkpoint;
  if(integrity!==hash(canonical(payload)))bad(codes.shape);
  if(!safeInt(checkpoint.next_bar,1,ctx.total)||checkpoint.last_time!==ctx.first+(checkpoint.next_bar-1)*MINUTE)
    bad(codes.shape);
  if(!['evaluator','paper','counters','guards','samples'].every(name=>isObject(checkpoint[name])))bad(codes.shape);
}

function assemble(ctx,rows,checkpoint){
  return {version:PF2_CHUNK_VERSION,contract:ctx.contract,rows,checkpoint};
}

/** Pure request builder. Validates everything it is given and never aliases its inputs. */
export function buildChunkRequest(resolved,rows,checkpoint=null){
  const ctx=intakeResolved(resolved);
  const cp=checkpoint===null?null:detach(checkpoint,'PF2_RESUME_INVALID');
  if(cp!==null)checkpointHeader(ctx,cp,null,{shape:'PF2_RESUME_INVALID',size:'PF2_RESUME_INVALID'});
  const start=cp===null?0:cp.next_bar;
  if(!Array.isArray(rows))bad('PF2_ROW_INVALID');
  let length;
  try{length=rows.length;}catch{throw fail('PF2_ROW_INVALID');}
  if(!Number.isSafeInteger(length)||length<1||start+length>ctx.total)bad('PF2_ROW_CONTINUITY');
  const built=[];
  for(let offset=0;offset<length;offset++){
    let item;
    try{item=rows[offset];}catch{throw fail('PF2_ROW_INVALID');}
    const {raw,row}=normalizeRow(item,start+offset,ctx);
    if(ROW_FIELDS.some(name=>raw[name]!==row[name]))bad('PF2_ROW_INVALID');
    built.push(row);
  }
  return JSON.parse(canonical(assemble(ctx,built,cp)));
}

export function encodeChunkRequest(request){
  let text;
  try{text=canonical(request);}catch{throw fail('PF2_REPLAY_CONFIG_INVALID');}
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>PF2_REPLAY_LIMITS.ipcBytes)bad('PF2_LIMIT_EXCEEDED');
  return Buffer.from(text,'utf8');
}

/** Validates one runChunk return. Throws a fixed code; returns {checkpoint,result}. */
function parseResponse(ctx,value,{cursor,count,pinned}){
  let exitCode,stdout;
  try{({exitCode,stdout}=value);}catch{bad('PF2_RUNNER_FAILED');}
  if(!(stdout instanceof Uint8Array)||!(exitCode===null||Number.isSafeInteger(exitCode)))bad('PF2_RUNNER_FAILED');
  const limit=PF2_REPLAY_LIMITS.ipcBytes+1;
  let bytes=null,oversize=false;
  try{if(stdout.byteLength>limit)oversize=true;else bytes=Buffer.from(stdout);}
  catch{bad('PF2_RUNNER_FAILED');}
  if(oversize||bytes.length>limit)bad('PF2_LIMIT_EXCEEDED');
  const invalid=exitCode===0?'PF2_RESPONSE_INVALID':'PF2_RUNNER_FAILED';
  const last=bytes.length-1;
  if(last<1||bytes[last]!==0x0a)bad(invalid);
  for(let index=0;index<last;index++)if(bytes[index]<0x20||bytes[index]>0x7e)bad(invalid);
  const line=bytes.toString('latin1',0,last);
  let parsed;
  try{parsed=JSON.parse(line);}catch{bad(invalid);}
  // Node canonical equals the S1 canonical line for ASCII, float-free JSON (sorted keys, no
  // duplicate key, no float, no precision loss); anything else fails closed.
  if(attempt(()=>canonical(parsed))!==line)bad(invalid);
  if(exitCode!==0){
    const known=exitCode===1&&exactKeys(parsed,['error'])&&PF2_S1_ERRORS.includes(parsed.error);
    bad(known?parsed.error:'PF2_RUNNER_FAILED');
  }
  if(!exactKeys(parsed,['checkpoint','result']))bad('PF2_RESPONSE_INVALID');
  checkpointHeader(ctx,parsed.checkpoint,pinned,{shape:'PF2_RESPONSE_INVALID',size:'PF2_LIMIT_EXCEEDED'});
  if(parsed.checkpoint.next_bar!==cursor+count)bad('PF2_RESPONSE_INVALID');
  // The result exists on the final chunk and only there.
  if((parsed.result===null)===(parsed.checkpoint.next_bar===ctx.total))bad('PF2_RESPONSE_INVALID');
  return {checkpoint:parsed.checkpoint,result:parsed.result};
}

// --- result invariants (section 11) ---------------------------------------------------

const MAX_COUNT=Number.MAX_SAFE_INTEGER;
const RESULT_KEYS=['version','plan_hash','execution_model_version','window','counters','derived','guards',
  'account','samples','admission','limitations'];
const WINDOW_KEYS=['first_time','evaluation_start_time','last_time','development_end_time','holdout_start_time',
  'bars_seen','warmup_bars','evaluated_bars'];
const FILL_KEYS=['time','event_type','entry_ref','reason','sizing_outcome','quantity','price','notional','fee'];
const REJECTION_KEYS=['time','event_type','entry_ref','reason'];
const counts=(group,names)=>exactKeys(group,names)&&names.every(name=>safeInt(group[name],0,MAX_COUNT));

/** Rejects any schema key that could carry a time-to-completion figure or a collection estimate. */
function assertNoEta(value,skip=new Set()){
  const walk=item=>{
    if(Array.isArray(item)){item.forEach(walk);return;}
    if(!isObject(item))return;
    for(const [key,child] of Object.entries(item)){
      if(!skip.has(item)&&NO_ETA_KEYS.some(pattern=>pattern.test(key)))bad('PF2_RESULT_INVALID');
      walk(child);
    }
  };
  walk(value);
}

function verifyCounters(ctx,r){
  const ok=condition=>{if(!condition)bad('PF2_RESULT_INVALID');};
  const T=ctx.total,W=ctx.warmup,E=T-W;
  const c=r.counters;
  ok(exactKeys(c,['signals','intents','warmup_intents','orders','fills','episodes']));
  const sig=c.signals,it=c.intents,wu=c.warmup_intents,od=c.orders,fl=c.fills,ep=c.episodes;
  ok(counts(sig,['buy','native_exit','buy_evaluated','native_exit_evaluated'])&&
    counts(it,['buy','exit_sl','exit_tp','exit_native'])&&counts(wu,['buy','exit'])&&counts(ep,['closed','losing']));
  ok(exactKeys(od,['accepted','sizing_adjusted','rejected','rejected_by_reason'])&&
    ['accepted','sizing_adjusted','rejected'].every(name=>safeInt(od[name],0,MAX_COUNT))&&
    exactKeys(fl,['buy','exit','exit_by_reason'])&&['buy','exit'].every(name=>safeInt(fl[name],0,MAX_COUNT)));
  const byReason=od.rejected_by_reason,byExit=fl.exit_by_reason;
  ok(isObject(byReason)&&Object.keys(byReason).length<=33&&
    Object.entries(byReason).every(([key,count])=>printable(key,1,128)&&safeInt(count,1,MAX_COUNT)));
  ok(isObject(byExit)&&Object.entries(byExit).every(([key,count])=>EXIT_REASONS.includes(key)&&safeInt(count,1,MAX_COUNT)));
  const IE=sum(Object.values(it));
  // a. signal totals
  ok(sig.buy<=T&&sig.native_exit<=T&&sig.buy_evaluated<=Math.min(sig.buy,E)&&
    sig.native_exit_evaluated<=Math.min(sig.native_exit,E)&&sig.buy-sig.buy_evaluated<=W);
  // b. intents against signals
  ok(it.buy+wu.buy<=sig.buy&&it.buy<=sig.buy_evaluated&&wu.buy<=sig.buy-sig.buy_evaluated&&IE<=E*1000&&
    (W!==0||wu.buy+wu.exit===0)&&(E!==0||IE===0));
  // c, d, e. orders and fills add up
  ok(sum(Object.values(byReason))===od.rejected&&sum(Object.values(byExit))===fl.exit&&
    od.accepted+od.sizing_adjusted+od.rejected===IE&&fl.buy+fl.exit===od.accepted+od.sizing_adjusted);
  // f. one decision per intent and the fill keeps the event reason (Node-only, from PaperState)
  ok(fl.buy<=it.buy&&fl.exit<=fl.buy&&(byExit.SL??0)<=it.exit_sl&&(byExit.TP??0)<=it.exit_tp&&
    (byExit.NATIVE??0)<=it.exit_native);
  // g. episodes; a fresh start is flat, so a flat end after a buy closed one (Node-only)
  ok(ep.closed<=fl.exit&&ep.losing<=ep.closed&&(fl.buy-fl.exit!==0||fl.buy===0||ep.closed>=1));
  return {sig,it,wu,od,fl,ep,IE};
}

function verifyGuards(ctx,r,{ep}){
  const ok=condition=>{if(!condition)bad('PF2_RESULT_INVALID');};
  const E=ctx.total-ctx.warmup,S=ctx.evaluationStart,L=ctx.last;
  const P=ctx.contract.policy,I0=ctx.contract.initial_state.loss_streak;
  const g=r.guards,pause=g?.pause;
  ok(exactKeys(g,['kill_switch','loss_streak_final','pause'])&&g.kill_switch===P.killSwitch&&
    safeInt(g.loss_streak_final,0,I0+ep.losing)&&(ep.closed!==0||g.loss_streak_final===I0));
  ok(exactKeys(pause,['persistent','active_kinds','periods','truncated','dropped_periods']));
  const kinds=pause.active_kinds;
  ok(Array.isArray(kinds)&&kinds.every(kind=>GUARD_KINDS.includes(kind))&&new Set(kinds).size===kinds.length&&
    kinds.every((kind,index)=>index===0||GUARD_KINDS.indexOf(kinds[index-1])<GUARD_KINDS.indexOf(kind)));
  ok(pause.persistent===kinds.some(kind=>PERSISTENT_KINDS.includes(kind))&&
    kinds.includes('KILL_SWITCH')===(P.killSwitch===true&&E>0)&&
    kinds.includes('LOSS_STREAK')===(E>0&&g.loss_streak_final>=P.pauseAfterLossStreak));
  const periods=pause.periods;
  ok(Array.isArray(periods)&&periods.every(item=>exactKeys(item,['kind','start_time','end_time','persistent'])));
  const closed=periods.filter(item=>item.end_time!==null),open=periods.filter(item=>item.end_time===null);
  ok(periods.slice(0,closed.length).every(item=>item.end_time!==null)&&closed.length<=256&&
    open.length===kinds.length&&open.every((item,index)=>item.kind===kinds[index]));
  for(const item of periods){
    ok(GUARD_KINDS.includes(item.kind)&&safeInt(item.start_time,S,L)&&item.start_time%MINUTE===0&&
      typeof item.persistent==='boolean');
  }
  for(const item of closed){
    ok(['MAX_TRADES_PER_DAY','MAX_DAILY_LOSS'].includes(item.kind)&&item.persistent===false&&
      safeInt(item.end_time,item.start_time+1,Math.min(nextMidnight(item.start_time),L))&&item.end_time%MINUTE===0);
  }
  for(const item of open){
    ok(item.persistent===PERSISTENT_KINDS.includes(item.kind));
    // A day-scoped pause still open at the end must not have crossed a UTC midnight.
    if(!item.persistent)ok(nextMidnight(item.start_time)>L);
    // The kill switch starts on the first evaluated bar (Node-only, from Guards.after_bar).
    if(item.kind==='KILL_SWITCH')ok(item.start_time===S);
  }
  ok(safeInt(pause.dropped_periods,0,MAX_COUNT)&&pause.truncated===(pause.dropped_periods>0)&&
    (pause.dropped_periods===0||closed.length===256));
}

function verifySamples(ctx,r,{od,fl}){
  const ok=condition=>{if(!condition)bad('PF2_RESULT_INVALID');};
  const S=ctx.evaluationStart,L=ctx.last,K=ctx.contract.limits.max_samples,prefix=ctx.contract.deployment_id+':';
  const sm=r.samples,byReason=od.rejected_by_reason;
  ok(exactKeys(sm,['fills','rejections'])&&Array.isArray(sm.fills)&&Array.isArray(sm.rejections));
  ok(sm.fills.length===Math.min(K,fl.buy+fl.exit)&&sm.rejections.length===Math.min(K,od.rejected));
  let previous=S,buys=0,exits=0;
  for(const item of sm.fills){
    ok(exactKeys(item,FILL_KEYS)&&safeInt(item.time,previous,L)&&item.time%MINUTE===0);
    previous=item.time;
    ok(item.event_type==='BUY'||item.event_type==='EXIT');
    if(item.event_type==='BUY'){ok(item.reason===null);buys++;}
    else{ok(EXIT_REASONS.includes(item.reason));exits++;}
    ok(['ACCEPTED','CAPPED'].includes(item.sizing_outcome)&&printable(item.entry_ref,prefix.length,256)&&
      item.entry_ref.startsWith(prefix)&&['quantity','price','notional','fee'].every(name=>printable(item[name],1,80)));
  }
  ok(buys<=fl.buy&&exits<=fl.exit&&(K<fl.buy+fl.exit||(buys===fl.buy&&exits===fl.exit)));
  previous=S;
  for(const item of sm.rejections){
    ok(exactKeys(item,REJECTION_KEYS)&&safeInt(item.time,previous,L)&&item.time%MINUTE===0);
    previous=item.time;
    ok((item.event_type==='BUY'||item.event_type==='EXIT')&&printable(item.entry_ref,1,256)&&
      printable(item.reason,1,128)&&Object.hasOwn(byReason,item.reason));
  }
}

function verifyResult(ctx,r){
  const ok=condition=>{if(!condition)bad('PF2_RESULT_INVALID');};
  const T=ctx.total,W=ctx.warmup,E=T-W,data=ctx.dataset;
  ok(exactKeys(r,RESULT_KEYS)&&r.version===PF2_RESULT_VERSION&&r.plan_hash===ctx.planHash&&
    r.execution_model_version==='paper-close-v1');
  const w=r.window;
  ok(exactKeys(w,WINDOW_KEYS)&&w.first_time===ctx.first&&w.evaluation_start_time===ctx.evaluationStart&&
    w.last_time===ctx.last&&w.development_end_time===data.development_end_time&&
    w.holdout_start_time===data.holdout_start_time&&w.bars_seen===T&&w.warmup_bars===W&&w.evaluated_bars===E&&
    w.last_time<=w.development_end_time&&w.development_end_time<=w.holdout_start_time);
  const group=verifyCounters(ctx,r);
  const {sig,it,wu,od,fl,ep,IE}=group;
  const d=r.derived;
  ok(exactKeys(d,['intents_evaluated','suppressed_buy','suppressed_buy_evaluated','non_losing_episodes'])&&
    d.intents_evaluated===IE&&d.suppressed_buy===sig.buy-it.buy-wu.buy&&d.suppressed_buy>=0&&
    d.suppressed_buy_evaluated===sig.buy_evaluated-it.buy&&d.suppressed_buy_evaluated>=0&&
    d.non_losing_episodes===ep.closed-ep.losing);
  verifyGuards(ctx,r,group);
  const a=r.account;
  ok(exactKeys(a,['cash','position_quantity','position_cost','open_allocations'])&&
    ['cash','position_quantity','position_cost'].every(name=>plainDecimal(a[name],80))&&
    a.open_allocations===fl.buy-fl.exit&&attempt(()=>D(a.position_quantity).eq(0))===(a.open_allocations===0));
  verifySamples(ctx,r,group);
  ok(admissionOk(r.admission)&&Array.isArray(r.limitations)&&
    canonical(r.limitations)===canonical(RESULT_LIMITATIONS));
  assertNoEta(r,new Set([od.rejected_by_reason]));
}

/** Detach once, verify every invariant on the copy. Returns the detached, unfrozen copy. */
function checkResult(ctx,value){
  const result=detach(value,'PF2_RESULT_INVALID');
  try{
    assertWire(result,'PF2_RESULT_INVALID');
    verifyResult(ctx,result);
  }catch{throw fail('PF2_RESULT_INVALID');}
  if(Buffer.byteLength(canonical(result))>ctx.budget.max_output_bytes)bad('PF2_LIMIT_EXCEEDED');
  return result;
}

/** Node re-check of the S1 result against the resolved contract. Returns a deep-frozen copy. */
export function validatePreflightResult(resolved,result){
  return frozenV2(checkResult(intakeResolved(resolved),result));
}

// --- resume token (section 7) and envelope (section 12) -------------------------------------

const TOKEN_KEYS=['version','plan_hash','contract_sha256','resolved_sha256','engine_hash','evaluator_hash',
  'contract_digest','next_bar','last_time','elapsed_ms','checkpoint','token_sha256'];
const tokenLimit=ctx=>ctx.stateLimit+4096;

/** Built after a chunk fully validated. SHA-256 integrity only: it detects damage, not forgery. */
function buildToken(ctx,checkpoint,elapsed){
  const body={version:PF2_RESUME_VERSION,plan_hash:ctx.planHash,contract_sha256:ctx.contractSha,
    resolved_sha256:ctx.resolvedSha,engine_hash:ctx.identities.engine_hash,
    evaluator_hash:ctx.identities.evaluator_hash,contract_digest:checkpoint.identity.contract_digest,
    next_bar:checkpoint.next_bar,last_time:checkpoint.last_time,elapsed_ms:elapsed,checkpoint};
  const token={...body,token_sha256:hash(canonical(body))};
  if(Buffer.byteLength(canonical(token))>tokenLimit(ctx))bad('PF2_LIMIT_EXCEEDED');
  return frozenV2(token);
}

/** Resume intake, before any read, hash re-check or spawn. Returns the detached token. */
function intakeResume(ctx,value){
  const code='PF2_RESUME_INVALID';
  const token=detach(value,code);
  try{
    const ok=condition=>{if(!condition)bad(code);};
    assertWire(token,code);
    ok(exactKeys(token,TOKEN_KEYS)&&token.version===PF2_RESUME_VERSION);
    const {token_sha256:sealed,...body}=token;
    ok(sealed===hash(canonical(body))&&Buffer.byteLength(canonical(token))<=tokenLimit(ctx));
    ok(token.plan_hash===ctx.planHash&&token.contract_sha256===ctx.contractSha&&
      token.resolved_sha256===ctx.resolvedSha&&token.engine_hash===ctx.identities.engine_hash&&
      token.evaluator_hash===ctx.identities.evaluator_hash);
    ok(isSha(token.contract_digest)&&safeInt(token.next_bar,1,ctx.total-1)&&
      token.last_time===ctx.first+(token.next_bar-1)*MINUTE&&safeInt(token.elapsed_ms,0,Number.MAX_SAFE_INTEGER));
    checkpointHeader(ctx,token.checkpoint,token.contract_digest,{shape:code,size:code});
    ok(token.checkpoint.next_bar===token.next_bar&&token.checkpoint.last_time===token.last_time);
  }catch{throw fail(code);}
  // Only after every integrity check: a spent budget is a deadline, not a tampered token.
  if(token.elapsed_ms>=ctx.budget.max_runtime_ms)bad('PF2_DEADLINE_EXCEEDED');
  return token;
}

function buildEnvelope(ctx,{result,digest,chunks,resumedFrom}){
  const id=ctx.identities,data=ctx.dataset;
  const envelope={version:PF2_REPLAY_ENVELOPE_VERSION,plan_hash:ctx.planHash,owner_id:ctx.resolved.owner_id,
    bot_id:ctx.resolved.bot_id,
    binding:{contract_sha256:ctx.contractSha,resolved_sha256:ctx.resolvedSha,contract_digest:digest,
      engine_hash:id.engine_hash,evaluator_hash:id.evaluator_hash,raw_dataset_sha256:id.raw_dataset_sha256,
      closed_dataset_sha256:id.closed_dataset_sha256,atr14_sha256:id.atr14_sha256,
      enrollment_binding_sha256:id.enrollment_binding_sha256},
    dataset:{first_time:ctx.first,evaluation_start_time:ctx.evaluationStart,last_time:ctx.last,
      total_bars:ctx.total,warmup_bars:ctx.warmup,development_end_time:data.development_end_time,
      holdout_start_time:data.holdout_start_time},
    run:{chunk_bars:ctx.chunkBars,chunks_executed:chunks,resumed_from_bar:resumedFrom},
    result,admission:{...ADMISSION},acceptance_blockers:[...ctx.resolved.acceptance_blockers],
    limitations:[...new Set([...ctx.resolved.limitations,...result.limitations,...PF2_REPLAY_LIMITATIONS])]};
  assertNoEta(envelope,new Set([result.counters.orders.rejected_by_reason]));
  return frozenV2(envelope);
}

// --- cancellation, deadline and timers (section 8) ---------------------------------------

/** Waits for a settle, never longer than ms. The promise outcome is ignored. */
function bounded(promise,ms){
  return new Promise(done=>{
    const timer=setTimeout(done,ms);
    const finish=()=>{clearTimeout(timer);done();};
    Promise.resolve(promise).then(finish,finish);
  });
}

/**
 * Driver-owned stop state. The caller signal is read here and never reaches an adapter:
 * adapters get driver-owned scope and chunk signals, and the driver never reads any signal an
 * adapter can see. Stop is a closure flag (set by one caller listener, or by a guarded boolean
 * read at each poll for a signal-like without addEventListener), one shared promise rejects on
 * any stop, and every await of adapter work races it: no listener per call.
 */
function openRun(callerSignal,clockFunction){
  const scope=new AbortController();
  let chunk=null,chunkTimer=null,runTimer=null;
  let cancelled=false,deadlineHit=false,chunkTimedOut=false,broken=false,stopped=false;
  let link=false,poll=false,rejectStop=null,deadline=Infinity,startClock=0,lastClock=-Infinity;
  const stop=new Promise((_,reject)=>{rejectStop=reject;});
  stop.catch(()=>{});
  const abortAll=()=>{if(chunk)attempt(()=>chunk.abort());attempt(()=>scope.abort());};
  const trip=code=>{
    if(!stopped){stopped=true;rejectStop(fail(code));}
    abortAll();
  };
  const onAbort=()=>{
    if(cancelled)return;
    cancelled=true;
    trip('PF2_CANCELLED');
  };
  const invalid=()=>{broken=true;return fail('PF2_REPLAY_CONFIG_INVALID');};
  if(callerSignal!==undefined){
    let aborted,linkable;
    try{
      if(callerSignal===null||typeof callerSignal!=='object')throw new TypeError('signal');
      aborted=callerSignal.aborted;
      linkable=typeof callerSignal.addEventListener==='function';
    }catch{throw fail('PF2_REPLAY_CONFIG_INVALID');}
    if(typeof aborted!=='boolean')throw fail('PF2_REPLAY_CONFIG_INVALID');
    if(aborted)throw fail('PF2_CANCELLED');
    if(linkable){
      try{callerSignal.addEventListener('abort',onAbort,{once:true});}
      catch{throw fail('PF2_REPLAY_CONFIG_INVALID');}
      link=true;
    }else poll=true;
  }
  const readClock=()=>{
    let value;
    try{value=clockFunction();}catch{throw invalid();}
    if(typeof value!=='number'||!Number.isFinite(value)||value<lastClock)throw invalid();
    lastClock=value;
    return value;
  };
  const polled=()=>{
    if(!poll||cancelled)return;
    let value;
    try{value=callerSignal.aborted;}catch{throw invalid();}
    if(typeof value!=='boolean')throw invalid();
    if(value){cancelled=true;trip('PF2_CANCELLED');}
  };
  const throwFlag=()=>{
    if(cancelled)throw fail('PF2_CANCELLED');
    if(deadlineHit)throw fail('PF2_DEADLINE_EXCEEDED');
    if(chunkTimedOut)throw fail('PF2_CHUNK_TIMEOUT');
  };
  const clearChunkTimer=()=>{if(chunkTimer!==null){clearTimeout(chunkTimer);chunkTimer=null;}};
  const observed=()=>cancelled||(poll&&attempt(()=>callerSignal.aborted===true));
  return {
    scopeSignal:scope.signal,
    /** Starts the active-runtime budget: one wall timer for the whole run. */
    arm(budgetMs,elapsedMs){
      startClock=readClock();
      const remaining=budgetMs-elapsedMs;
      if(remaining<=0){deadlineHit=true;trip('PF2_DEADLINE_EXCEEDED');throwFlag();}
      deadline=startClock+remaining;
      runTimer=setTimeout(()=>{deadlineHit=true;trip('PF2_DEADLINE_EXCEEDED');},remaining);
    },
    /** Poll point: caller signal, flags, then the clock against the wall deadline. */
    poll(){
      polled();
      if(!cancelled&&!deadlineHit&&readClock()>=deadline){deadlineHit=true;trip('PF2_DEADLINE_EXCEEDED');}
      throwFlag();
    },
    elapsedSinceStart:()=>Math.max(0,Math.ceil(readClock()-startClock)),
    beginChunk(){chunk=new AbortController();return chunk.signal;},
    /** Per chunk timer: min(30 s, remaining). Under 100 ms left nothing is started. */
    armChunkTimer(){
      const remaining=deadline-readClock();
      if(remaining<PF2_REPLAY_LIMITS.minChunkTimeoutMs){deadlineHit=true;trip('PF2_DEADLINE_EXCEEDED');throwFlag();}
      const wall=remaining<=PF2_REPLAY_LIMITS.chunkTimeoutMs;
      clearChunkTimer();
      chunkTimer=setTimeout(()=>{
        if(wall)deadlineHit=true;else chunkTimedOut=true;
        trip(wall?'PF2_DEADLINE_EXCEEDED':'PF2_CHUNK_TIMEOUT');
      },wall?remaining:PF2_REPLAY_LIMITS.chunkTimeoutMs);
    },
    endChunk(){
      clearChunkTimer();
      if(chunk){attempt(()=>chunk.abort());chunk=null;}
    },
    race:pending=>Promise.race([stop,pending]),
    settle:pending=>bounded(pending,PF2_REPLAY_LIMITS.killGraceMs),
    /** First match: config, cancel, deadline, chunk timeout, own error, then the fallback code. */
    classify(error,fallback='PF2_REPLAY_FAILED'){
      if(broken)return fail('PF2_REPLAY_CONFIG_INVALID');
      if(observed())return fail('PF2_CANCELLED');
      if(deadlineHit)return fail('PF2_DEADLINE_EXCEEDED');
      if(chunkTimedOut)return fail('PF2_CHUNK_TIMEOUT');
      return ownErrors.has(error)?error:fail(fallback);
    },
    close(){
      if(runTimer!==null){clearTimeout(runTimer);runTimer=null;}
      clearChunkTimer();
      if(link)attempt(()=>callerSignal.removeEventListener('abort',onAbort));
      abortAll();
    }};
}

// --- chunk loop (section 5) ------------------------------------------------------------------

/** Brackets each child with the on-disk hashed bytes. Evaluator first: its files are a subset. */
async function recheckExecutables(ctx,run,readFile){
  let hashes;
  try{
    const pending=(async()=>({value:await pf2ExecutableHashes({readFile,signal:run.scopeSignal})}))();
    pending.catch(()=>{});
    hashes=await run.race(pending);
  }catch(error){throw run.classify(error,'PF2_ENGINE_HASH_MISMATCH');}
  let engine,evaluator;
  try{({engine_hash:engine,evaluator_hash:evaluator}=hashes.value);}catch{bad('PF2_ENGINE_HASH_MISMATCH');}
  if(evaluator!==ctx.identities.evaluator_hash)bad('PF2_EVALUATOR_HASH_MISMATCH');
  if(engine!==ctx.identities.engine_hash)bad('PF2_ENGINE_HASH_MISMATCH');
}

/** Rows [start,end) for one chunk, through the injected readV2 only. Never a bar past the end. */
async function readChunk(ctx,run,readV2,start,end,signal){
  const rows=[];
  let iterator=null;
  try{
    run.poll();
    if(ctx.first+(end-1)*MINUTE>ctx.developmentEnd)bad('PF2_HOLDOUT_BOUNDARY_VIOLATION');
    iterator=readV2(ctx.dataset.research,{start,end,signal})[Symbol.asyncIterator]();
    for(;;){
      const step=await run.race(Promise.resolve().then(()=>iterator.next()));
      if(step===null||typeof step!=='object')bad('PF2_DATASET_READ_FAILED');
      const {done,value}=step;
      if(done)break;
      if(rows.length>=end-start)bad('PF2_DATASET_READ_FAILED');
      rows.push(normalizeRow(value,start+rows.length,ctx).row);
    }
    if(rows.length!==end-start)bad('PF2_DATASET_READ_FAILED');
    return rows;
  }catch(error){
    // Only the driver flags decide cancel or deadline; a thrown store value is never read.
    throw run.classify(error,'PF2_DATASET_READ_FAILED');
  }finally{
    if(iterator)await run.settle(Promise.resolve().then(()=>iterator.return?.()));
  }
}

/** One child run. The runner settles only after its process exited, so a stop waits for that. */
async function spawnChunk(run,runner,input,signal){
  let pending=null;
  try{
    run.poll();
    run.armChunkTimer();
    pending=(async()=>({value:await runner(input,{signal})}))();
    pending.catch(()=>{});
    const box=await run.race(pending);
    run.endChunk();
    return box.value;
  }catch(error){
    run.endChunk();
    throw run.classify(error,'PF2_RUNNER_FAILED');
  }finally{
    if(pending)await run.settle(pending);
  }
}

/** The token exists only after a full chunk validated. The sink is awaited before more work. */
async function emitCheckpoint(ctx,run,onCheckpoint,checkpoint,elapsedBefore){
  const token=buildToken(ctx,checkpoint,elapsedBefore+run.elapsedSinceStart());
  if(onCheckpoint===undefined)return;
  try{
    const pending=(async()=>{await onCheckpoint(token);})();
    pending.catch(()=>{});
    await run.race(pending);
  }catch(error){throw run.classify(error,'PF2_CHECKPOINT_SINK_FAILED');}
}

/**
 * Runs the whole historical replay for one resolved preflight and returns the frozen envelope.
 * Adapters (research.readV2, runChunk, onCheckpoint) get driver-owned signals only.
 */
export async function runHistoricalPreflight(options={}){
  let run=null;
  try{
    let settings;
    try{
      const {resolved,research,runChunk,signal,clock,onCheckpoint,resume,readFile}=options??{};
      settings={resolved,research,runChunk,signal,clock,onCheckpoint,resume,readFile};
    }catch{throw fail('PF2_REPLAY_CONFIG_INVALID');}
    const holder={clock:null};
    run=openRun(settings.signal,()=>holder.clock());
    const {runChunk:runner,onCheckpoint,readFile}=settings;
    let readV2=null;
    try{
      const method=settings.research.readV2;
      if(typeof method==='function')readV2=method.bind(settings.research);
    }catch{readV2=null;}
    if(typeof runner!=='function'||readV2===null||(onCheckpoint!==undefined&&typeof onCheckpoint!=='function')||
       (settings.clock!==undefined&&typeof settings.clock!=='function')||
       (readFile!==undefined&&typeof readFile!=='function'))bad('PF2_REPLAY_CONFIG_INVALID');
    holder.clock=settings.clock??(()=>globalThis.performance.now());
    const ctx=intakeResolved(settings.resolved);
    const token=settings.resume===undefined?null:intakeResume(ctx,settings.resume);
    const resumedFrom=token===null?0:token.next_bar,elapsedBefore=token===null?0:token.elapsed_ms;
    run.arm(ctx.budget.max_runtime_ms,elapsedBefore);
    let cursor=resumedFrom,checkpoint=token===null?null:token.checkpoint,pinned=token===null?null:token.contract_digest;
    let chunks=0,result=null;
    run.poll();
    while(cursor<ctx.total){
      run.poll();
      await recheckExecutables(ctx,run,readFile);
      const start=cursor,end=Math.min(cursor+ctx.chunkBars,ctx.total);
      const signal=run.beginChunk();
      try{
        const rows=await readChunk(ctx,run,readV2,start,end,signal);
        const input=encodeChunkRequest(assemble(ctx,rows,checkpoint));
        const response=await spawnChunk(run,runner,input,signal);
        run.poll();
        const parsed=parseResponse(ctx,response,{cursor:start,count:end-start,pinned});
        checkpoint=parsed.checkpoint;
        pinned=checkpoint.identity.contract_digest;
        cursor=checkpoint.next_bar;
        chunks++;
        if(parsed.result!==null)result=checkResult(ctx,parsed.result);
      }finally{run.endChunk();}
      if(result===null){
        run.poll();
        await emitCheckpoint(ctx,run,onCheckpoint,checkpoint,elapsedBefore);
      }
    }
    await recheckExecutables(ctx,run,readFile);
    run.poll();
    return buildEnvelope(ctx,{result,digest:pinned,chunks,resumedFrom});
  }catch(error){
    throw run?run.classify(error):(ownErrors.has(error)?error:fail('PF2_REPLAY_FAILED'));
  }finally{
    run?.close();
  }
}

// --- default local Python runner (section 10) ---------------------------------------------------

const REPO_ROOT=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
// Same base as pf2ExecutableHashes, so the hashed files are the files that run. -B stops bytecode
// writes only: a stale __pycache__ .pyc stays readable. PYTHONPYCACHEPREFIX would force a source
// compile but costs seconds per spawn (measured), so the gap stays inside PYTHON_RUNTIME_NOT_HASHED.
const SRC_ROOT=path.resolve(fileURLToPath(new URL('../../quant_lab/src/',import.meta.url)));
const SHIM_PATH=path.resolve(REPO_ROOT,'test','helpers','pf2_replay_shim.py');
const sameFile=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;

/** Built fresh for every spawn from an allowlist; nothing else is inherited. */
function runnerEnvironment(){
  const env={PYTHONPATH:SRC_ROOT,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHONHASHSEED:'0',
    OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'};
  for(const name of ['PATH','SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','TMPDIR']){
    const value=process.env[name];
    if(typeof value==='string'&&value.length>0)env[name]=value;
  }
  return env;
}

/** Kills the process tree. A venv launcher can hold a child interpreter, so Windows uses taskkill. */
async function killTree(child){
  const pid=child.pid;
  if(process.platform==='win32'&&Number.isSafeInteger(pid)){
    await new Promise(done=>{
      let finished=false,timer=null;
      const finish=()=>{if(!finished){finished=true;clearTimeout(timer);done();}};
      let killer;
      try{
        const system=process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows';
        killer=spawn(path.join(system,'System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],
          {windowsHide:true,stdio:'ignore',shell:false});
      }catch{finish();return;}
      timer=setTimeout(()=>{attempt(()=>killer.kill());finish();},PF2_REPLAY_LIMITS.killGraceMs);
      killer.on('error',finish);
      killer.on('close',finish);
    });
  }
  attempt(()=>child.kill(process.platform==='win32'?undefined:'SIGKILL'));
}

/**
 * Development-only runner over a local interpreter. `python` is an absolute path only: a bare
 * command name can resolve through an installer alias, so it is a configuration error. `shim`
 * accepts only the test helper of this repository. The returned function
 * resolves {exitCode,stdout} after the child exited; stderr is drained and dropped.
 */
export function createLocalPythonRunner(options){
  let settings;
  try{
    if(!isObject(options))throw new TypeError('options');
    const {python,developmentOnly,shim,onSpawn}=options;
    settings={python,developmentOnly,shim,onSpawn};
  }catch{throw fail('PF2_REPLAY_CONFIG_INVALID');}
  const {python,developmentOnly,shim,onSpawn}=settings;
  if(developmentOnly!==true||typeof python!=='string'||python.length<1||python.length>1024||python.includes('\0')||
     !path.isAbsolute(python)||
     (shim!==undefined&&(typeof shim!=='string'||!sameFile(path.resolve(shim),SHIM_PATH)))||
     (onSpawn!==undefined&&typeof onSpawn!=='function'))throw fail('PF2_REPLAY_CONFIG_INVALID');
  const args=shim===undefined?['-B','-s','-m','robot_quant.pf2_replay']:['-B','-s',SHIM_PATH];
  const collectLimit=PF2_REPLAY_LIMITS.ipcBytes+2;
  return function runChunk(input,callOptions){
    return new Promise((resolve,reject)=>{
      let signal;
      try{signal=callOptions?.signal;}catch{signal=undefined;}
      if(!(input instanceof Uint8Array)){reject(new Error('runner input'));return;}
      if(signal?.aborted===true){resolve({exitCode:null,stdout:Buffer.alloc(0)});return;}
      let child;
      try{
        child=spawn(python,args,{cwd:SRC_ROOT,env:runnerEnvironment(),stdio:['pipe','pipe','pipe'],
          windowsHide:true,shell:false});
      }catch{reject(new Error('runner spawn'));return;}
      let settled=false,overflow=false,killing=false,size=0;
      const pieces=[];
      const kill=()=>{if(!killing){killing=true;killTree(child).catch(()=>{});}};
      const cleanup=()=>{attempt(()=>signal?.removeEventListener?.('abort',kill));};
      if(signal&&typeof signal.addEventListener==='function')attempt(()=>signal.addEventListener('abort',kill,{once:true}));
      child.on('error',()=>{
        // A spawn failure never reaches a running process; later errors wait for 'close'.
        if(child.pid===undefined&&!settled){settled=true;cleanup();reject(new Error('runner spawn'));}
      });
      child.stdout.on('data',data=>{
        if(size>=collectLimit)return;
        const piece=data.length>collectLimit-size?data.subarray(0,collectLimit-size):data;
        pieces.push(piece);
        size+=piece.length;
        if(size>=collectLimit&&!overflow){overflow=true;kill();}
      });
      child.stderr.on('data',()=>{});
      child.stdin.on('error',()=>{});
      child.on('close',code=>{
        if(settled)return;
        settled=true;
        cleanup();
        resolve({exitCode:overflow||!Number.isSafeInteger(code)?null:code,stdout:Buffer.concat(pieces,size)});
      });
      if(onSpawn&&child.pid!==undefined)attempt(()=>onSpawn(child.pid));
      child.stdin.end(input);
    });
  };
}
