import fs from 'node:fs/promises';
import {canonical,fail as makeError,hash,inspectSource,number} from '../pine-bridge/source.js';
import {D,exact} from '../money.js';
import {validateHistoricalPreflightRequest} from './preflight-contract.js';
import {FOUNDATION_LIMITS} from './foundation-contract.js';
import {strictJsonV2,frozenV2} from './foundation-contract-v2.js';
import {validateProfileResultV2,validateProfileEnrollmentReceipt} from './profile-contract-v2.js';
import {deriveClosedMetadataV2,verifyEnrollmentBindingV2} from './data-profile-v2.js';
import {SOURCE_HASH} from './contract.js';
import {QUANT_RUNTIME_ENGINE_FILES} from './runtime-engine-files.js';

/**
 * PF-2 trusted resolver (slice S3). Development only, V1 only, EVALUATOR mode only.
 * Pure local library: no database, network, clock or write API. Every value from an
 * injected trusted source is untrusted data: it is detached once, re-hashed and
 * re-validated, and only the detached copy is used.
 */
export const PF2_RESOLVED_VERSION='pf2-resolved-preflight-v1';

const PLAN_RECORD_KINDS=['source','effective_inputs','bridge','policy','capital','initial_state',
  'execution_model','venue_metadata'];
// deployment_snapshot is fetched by the enrollment contract snapshot hash, after enrollment.
export const PF2_RECORD_KINDS=Object.freeze([...PLAN_RECORD_KINDS,'deployment_snapshot']);

export const PF2_EVALUATOR_FILES=Object.freeze([
  'quant_lab/src/robot_quant/__init__.py','quant_lab/src/robot_quant/analytics.py',
  'quant_lab/src/robot_quant/backtest.py','quant_lab/src/robot_quant/bridge_replay.py',
  'quant_lab/src/robot_quant/contracts.py','quant_lab/src/robot_quant/market_data.py',
  'quant_lab/src/robot_quant/optimizer.py','quant_lab/src/robot_quant/records.py',
  'quant_lab/src/robot_quant/risk_evaluator.py','quant_lab/src/robot_quant/risk_preview.py',
  'quant_lab/src/robot_quant/spt_custom_evaluator.py','quant_lab/src/robot_quant/spt_evaluator.py',
  'quant_lab/src/robot_quant/strategy.py','quant_lab/src/robot_quant/validation.py']);

// Sorted after the runtime files merge in, so the list stays in canonical order.
export const PF2_ENGINE_FILES=Object.freeze([...new Set([
  'quant_lab/src/robot_quant/__init__.py','quant_lab/src/robot_quant/analytics.py',
  'quant_lab/src/robot_quant/backtest.py','quant_lab/src/robot_quant/bridge_replay.py',
  'quant_lab/src/robot_quant/contracts.py','quant_lab/src/robot_quant/market_data.py',
  'quant_lab/src/robot_quant/optimizer.py','quant_lab/src/robot_quant/paper_state.py',
  'quant_lab/src/robot_quant/pf2_replay.py','quant_lab/src/robot_quant/records.py',
  'quant_lab/src/robot_quant/research_chunk.py','quant_lab/src/robot_quant/risk_evaluator.py',
  'quant_lab/src/robot_quant/risk_preview.py','quant_lab/src/robot_quant/spt_custom_evaluator.py',
  'quant_lab/src/robot_quant/spt_evaluator.py','quant_lab/src/robot_quant/strategy.py',
  'quant_lab/src/robot_quant/validation.py',
  'src/money.js','src/pine-bridge/source.js',
  'src/quant-research/atr14-chunk-store.js','src/quant-research/capacity-contract.js',
  'src/quant-research/contract.js','src/quant-research/data-profile-v2.js',
  'src/quant-research/dataset-store.js','src/quant-research/foundation-contract-v2.js',
  'src/quant-research/foundation-contract.js','src/quant-research/io-budget-ledger.js','src/quant-research/io-controls.js',
  'src/quant-research/io-terminal.js','src/quant-research/preflight-contract.js',
  'src/quant-research/preflight-replay.js','src/quant-research/preflight-resolver.js',
  'src/quant-research/preflight-runtime.js','src/quant-research/process-supervisor.js',
  'src/quant-research/profile-contract-v2.js','src/quant-research/profile-contract.js',
  'src/quant-research/research-dataset-store.js',...QUANT_RUNTIME_ENGINE_FILES])].sort());

export const PF2_RESOLVER_ERRORS=Object.freeze(['PF2_RESOLVER_CONFIG_INVALID','PF2_CANCELLED',
  'PF2_UNSUPPORTED_SIGNAL_MODE','PF2_EVALUATOR_UNAVAILABLE','PF2_BUDGET_UNSUPPORTED',
  'PF2_RESOLVE_UNAUTHORIZED','PF2_HOLDOUT_BOUNDARY_MISMATCH','PF2_ENGINE_HASH_MISMATCH',
  'PF2_EVALUATOR_HASH_MISMATCH','PF2_INPUT_UNRESOLVED','PF2_INPUT_HASH_MISMATCH','PF2_INPUT_INVALID',
  'PF2_INITIAL_STATE_UNSUPPORTED','PF2_WARMUP_INSUFFICIENT','PF2_DATASET_ENROLLMENT_REQUIRED',
  'PF2_CAPTURE_EVIDENCE_REQUIRED','PF2_OPEN_BAR','PF2_DATASET_HASH_MISMATCH']);

export const PF2_LIMITATIONS=Object.freeze(['DEVELOPMENT_ONLY','EXECUTION_MODEL_V1_ONLY',
  'EVALUATOR_ADMISSION_FALSE','INITIAL_STATE_FRESH_ONLY','BOUND_SIGNAL_CSV_UNSUPPORTED',
  'TRUSTED_SOURCES_INJECTED','HOLDOUT_REGISTRY_INJECTED','CAPTURE_TIME_ARITHMETIC_ONLY',
  'EXECUTABLE_IDENTITY_LOCAL_FILES_ONLY','EVALUATOR_SETTINGS_CHECKED_BY_REPLAY',
  'ENROLLMENT_EVALUATOR_IDENTITY_NOT_BOUND','NO_SCHEDULER_ADMISSION']);

const REUSED_ERRORS=['INVALID_PREFLIGHT_CONTRACT','PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED',
  'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED'];
const KNOWN_CODES=new Set([...PF2_RESOLVER_ERRORS,...REUSED_ERRORS]);

const MINUTE=60000;
const SEED_BARS=500;
const MAX_TIME_MS=253_402_300_799_999; // End of year 9999, the S1 time ceiling.
const MAX_NODES=1_000_000;
const MODEL_VERSION='paper-close-v1';
const DATA_PROFILE='closed-ohlcv-atr14-v1';
const SIGNALS={buy:'buySignal',exit:'sellSignal',timing:'bar_close'};
const INPUT_COUNT=58;
const KLINES_SOURCE='https://api.binance.com/api/v3/klines';
const OPEN_TIME_SEMANTICS='UTC open time; end exclusive';
const POLICY_KEYS=Object.freeze(['killSwitch','maxSignalAgeSeconds','maxTradesPerDay','maxDailyLossR',
  'pauseAfterLossStreak','blockHighVolatility','maxVolatilityPercent','blockDuringNews','allowedSymbols',
  'sideMode','maxOpenPositions','onePositionPerSymbol','capPercentEquitySize','maxRiskPercent',
  'maxOrderNotional','maxDailyNotional']);
const POLICY_BOOLS=['killSwitch','blockHighVolatility','blockDuringNews','onePositionPerSymbol','capPercentEquitySize'];
const POLICY_INTS=['maxSignalAgeSeconds','maxTradesPerDay','pauseAfterLossStreak','maxOpenPositions'];
const MARKET_KEYS=['deployment_id','pine_import_id','source_version','broker','symbol','timeframe'];

// Errors minted here are tracked by identity (no trap or getter can run), so a value thrown
// from an untrusted source can never pass as a resolver error, whatever code it claims.
const ownErrors=new WeakSet();
function fail(code){
  const error=makeError(code);
  ownErrors.add(error);
  return error;
}
const bad=code=>{throw fail(code);};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,names)=>isObject(value)&&Object.keys(value).length===names.length&&
  names.every(name=>Object.hasOwn(value,name));
const isSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safeInt=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const printable=(value,min=0,max=Infinity)=>typeof value==='string'&&value.length>=min&&
  value.length<=max&&/^[\x20-\x7e]*$/.test(value);
const lonelySurrogate=/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const attempt=operation=>{try{return operation();}catch{return false;}};

/** Canonical decimal text: one spelling per value, so both languages read the same bytes. */
function canonicalDecimal(value,{positive=false}={}){
  if(typeof value!=='string'||value.length>64||!/^[0-9]+(?:\.[0-9]+)?$/.test(value))return false;
  return attempt(()=>exact(value)===value&&(positive?D(value).gt(0):true));
}

/** Enrolled model decimals may be JS numbers or strings; S1 receives exact() text. */
function enrolledDecimal(value,min,max){
  if(typeof value!=='number'&&typeof value!=='string')return null;
  return attempt(()=>{
    const text=exact(value),decimal=D(value);
    if(decimal.lt(min)||decimal.gt(max)||!canonicalDecimal(text))return null;
    return text;
  })||null;
}

/**
 * One structural pass over untrusted data. Each property is read once through its
 * descriptor (accessors, symbols, holes and odd prototypes are refused, and get
 * traps are never used), then the plain copy is re-validated and re-serialized.
 */
function detach(value){
  let nodes=0;
  const active=new Set();
  const copy=input=>{
    if(input===null||typeof input==='string'||typeof input==='boolean')return input;
    if(typeof input==='number'){if(!Number.isFinite(input))bad('PF2_INPUT_INVALID');return input;}
    if(typeof input!=='object'||active.has(input)||++nodes>MAX_NODES)bad('PF2_INPUT_INVALID');
    active.add(input);
    let output;
    if(Array.isArray(input)){
      if(Object.getPrototypeOf(input)!==Array.prototype)bad('PF2_INPUT_INVALID');
      const length=Object.getOwnPropertyDescriptor(input,'length')?.value;
      if(!safeInt(length,0,MAX_NODES)||Reflect.ownKeys(input).length!==length+1)bad('PF2_INPUT_INVALID');
      output=[];
      for(let index=0;index<length;index++){
        const field=Object.getOwnPropertyDescriptor(input,String(index));
        if(!field||!field.enumerable||!Object.hasOwn(field,'value'))bad('PF2_INPUT_INVALID');
        output.push(copy(field.value));
      }
    }else{
      const prototype=Object.getPrototypeOf(input);
      if(prototype!==Object.prototype&&prototype!==null)bad('PF2_INPUT_INVALID');
      output={};
      for(const name of Reflect.ownKeys(input)){
        if(typeof name!=='string')bad('PF2_INPUT_INVALID');
        const field=Object.getOwnPropertyDescriptor(input,name);
        if(!field||!field.enumerable||!Object.hasOwn(field,'value'))bad('PF2_INPUT_INVALID');
        Object.defineProperty(output,name,{value:copy(field.value),enumerable:true,writable:true,configurable:true});
      }
    }
    active.delete(input);
    return output;
  };
  const shaped=copy(value);
  strictJsonV2(shaped);
  return JSON.parse(canonical(shaped));
}

/** Cross-canonical: identical bytes from Node canonical() and Python json.dumps(sort_keys). */
function assertCrossCanonical(value){
  const walk=item=>{
    if(typeof item==='string'){if(!printable(item))bad('PF2_INPUT_INVALID');return;}
    if(typeof item==='number'){if(!Number.isSafeInteger(item)||Object.is(item,-0))bad('PF2_INPUT_INVALID');return;}
    if(typeof item==='boolean')return;
    if(Array.isArray(item)){item.forEach(walk);return;}
    if(isObject(item)){for(const [key,child] of Object.entries(item)){walk(key);walk(child);}return;}
    bad('PF2_INPUT_INVALID');
  };
  walk(value);
}

// --- executable identity ----------------------------------------------------------

/**
 * One read per file; both aggregates come from the same per-file digest map. The caller
 * decides cancellation through a predicate, so the resolver can drive it from its closure.
 */
async function hashExecutables(readFile,cancelled){
  const digests={};
  for(const file of PF2_ENGINE_FILES){
    if(cancelled())throw fail('PF2_CANCELLED');
    let bytes;
    try{bytes=await readFile(new URL('../../'+file,import.meta.url));}
    catch{if(cancelled())throw fail('PF2_CANCELLED');throw fail('PF2_ENGINE_HASH_MISMATCH');}
    if(!(bytes instanceof Uint8Array))throw fail('PF2_ENGINE_HASH_MISMATCH');
    digests[file]=hash(bytes);
  }
  const aggregate=files=>hash(canonical(Object.fromEntries(files.map(file=>[file,digests[file]]))));
  return {engine_hash:aggregate(PF2_ENGINE_FILES),evaluator_hash:aggregate(PF2_EVALUATOR_FILES)};
}

export async function pf2ExecutableHashes({readFile=fs.readFile,signal}={}){
  if(typeof readFile!=='function')throw fail('PF2_RESOLVER_CONFIG_INVALID');
  return hashExecutables(readFile,()=>attempt(()=>signal?.aborted===true));
}

// --- record validators -------------------------------------------------------------

function effectiveValues(analysis){
  if(!isObject(analysis)||!Array.isArray(analysis.inputs))bad('PF2_INPUT_INVALID');
  return Object.fromEntries(analysis.inputs.map(input=>{
    if(!isObject(input)||typeof input.input_id!=='string'||!Object.hasOwn(input,'effective_value'))bad('PF2_INPUT_INVALID');
    return [input.input_id,input.effective_value];
  }));
}

const withoutValue=input=>{const {effective_value,...rest}=input;void effective_value;return canonical(rest);};

function validValue(input){
  const value=input.effective_value,domain=input.declared_domain;
  if(['int','float'].includes(input.type)){
    return attempt(()=>number(value,{integer:input.type==='int',min:domain.min??-1e12,max:domain.max??1e12})===value);
  }
  if(input.type==='bool')return typeof value==='boolean';
  if(input.type==='time')return attempt(()=>number(value,{min:-Number.MAX_SAFE_INTEGER,max:Number.MAX_SAFE_INTEGER,integer:true})===value);
  return typeof value==='string'&&value.length<=2000;
}

function checkEffectiveInputs(analysis,inspected,sourceHash,valuesHash){
  if(analysis.source_hash!==sourceHash||analysis.inputs.length!==INPUT_COUNT||
     inspected.inputs.length!==INPUT_COUNT)bad('PF2_INPUT_INVALID');
  const ids=new Set(),names=new Set();
  analysis.inputs.forEach((input,index)=>{
    // Full static identity (id, variable, type, domain, default...) minus the effective value.
    if(withoutValue(input)!==withoutValue(inspected.inputs[index])||!validValue(input))bad('PF2_INPUT_INVALID');
    ids.add(input.input_id);names.add(input.pine_variable);
  });
  if(ids.size!==INPUT_COUNT||names.size!==INPUT_COUNT||analysis.effective_inputs_hash!==valuesHash)bad('PF2_INPUT_INVALID');
  const review=analysis.effective_input_review;
  if(!isObject(review)||review.source_hash!==sourceHash||review.effective_inputs_hash!==valuesHash||
     review.input_count!==INPUT_COUNT||typeof review.reviewed_by!=='string'||
     review.reviewed_by.length<1||review.reviewed_by.length>128||!safeInt(review.reviewed_at,1,Number.MAX_SAFE_INTEGER))
    bad('PF2_INPUT_INVALID');
}

function checkBridge(record){
  if(!exactKeys(record,['atr_multiplier','rr']))bad('PF2_INPUT_INVALID');
  for(const name of ['atr_multiplier','rr']){
    if(!canonicalDecimal(record[name],{positive:true})||D(record[name]).gt(1000))bad('PF2_INPUT_INVALID');
  }
}

const finiteNumber=value=>typeof value==='number'&&Number.isFinite(value);
// validateRisk stores the two notional limits as exact() strings; config defaults are numbers.
const notional=value=>(finiteNumber(value)&&value>=0)||
  (typeof value==='string'&&attempt(()=>exact(value)===value&&D(value).gte(0)));

function checkPolicy(record){
  if(!isObject(record)||POLICY_KEYS.some(name=>!Object.hasOwn(record,name))||
     record.paperTrading!==true||record.requireReduceOnlySell!==true)bad('PF2_INPUT_INVALID');
  const valid=POLICY_BOOLS.every(name=>typeof record[name]==='boolean')&&
    POLICY_INTS.every(name=>safeInt(record[name],0,1e9))&&
    ['maxDailyLossR','maxRiskPercent'].every(name=>finiteNumber(record[name])&&record[name]>=0)&&
    ['maxOrderNotional','maxDailyNotional'].every(name=>notional(record[name]))&&
    finiteNumber(record.maxVolatilityPercent)&&record.maxVolatilityPercent>=0&&record.maxVolatilityPercent<=1e12&&
    Array.isArray(record.allowedSymbols)&&record.allowedSymbols.every(symbol=>printable(symbol))&&
    ['BOTH','BUY_ONLY','SELL_ONLY'].includes(record.sideMode);
  if(!valid)bad('PF2_INPUT_INVALID');
  return Object.fromEntries(POLICY_KEYS.map(name=>[name,record[name]]));
}

function checkCapital(record){
  if(!exactKeys(record,['cash','equity'])||!canonicalDecimal(record.cash,{positive:true})||
     !canonicalDecimal(record.equity,{positive:true}))bad('PF2_INPUT_INVALID');
}

function checkInitialState(record){
  if(!isObject(record))bad('PF2_INPUT_INVALID');
  if(record.kind!=='FRESH'||!exactKeys(record,['kind','loss_streak']))bad('PF2_INITIAL_STATE_UNSUPPORTED');
  if(!safeInt(record.loss_streak,0,1_000_000))bad('PF2_INPUT_INVALID');
  // FRESH means no loss streak: the deployment snapshot cannot bind a carried streak.
  if(record.loss_streak!==0)bad('PF2_INITIAL_STATE_UNSUPPORTED');
}

/** Returns the S1 model: exact() decimal strings, no data_profile. */
function checkModel(record,planVersion){
  if(!isObject(record))bad('PF2_INPUT_INVALID');
  if(typeof record.version==='string'&&record.version!==MODEL_VERSION)bad('PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED');
  if(!exactKeys(record,['version','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','data_profile'])||
     record.version!==planVersion||record.data_profile!==DATA_PROFILE)bad('PF2_INPUT_INVALID');
  const model={
    price_tick:enrolledDecimal(record.price_tick,'1e-18','1e12'),
    quantity_step:enrolledDecimal(record.quantity_step,'1e-18','1e12'),
    fee_bps:enrolledDecimal(record.fee_bps,'0','1000'),
    slippage_bps:enrolledDecimal(record.slippage_bps,'0','1000'),
    risk_percent:enrolledDecimal(record.risk_percent,'1e-18','100'),
    version:MODEL_VERSION};
  if(Object.values(model).some(value=>value===null))bad('PF2_INPUT_INVALID');
  return model;
}

function checkVenue(record,rawModel){
  if(!exactKeys(record,['market','price_tick','quantity_step','data_profile'])||!exactKeys(record.market,MARKET_KEYS))
    bad('PF2_INPUT_INVALID');
  const market=record.market;
  if(market.broker!=='binance-global'||market.symbol!=='BTCUSDT'||market.timeframe!=='1'||
     typeof market.deployment_id!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(market.deployment_id)||
     !printable(market.pine_import_id,1,128)||!safeInt(market.source_version,1,Number.MAX_SAFE_INTEGER)||
     // Production metadata hash uses String(model.price_tick) (quant-profile.js), not exact().
     typeof record.price_tick!=='string'||record.price_tick!==String(rawModel.price_tick)||
     typeof record.quantity_step!=='string'||record.quantity_step!==String(rawModel.quantity_step)||
     !attempt(()=>D(record.price_tick).gt(0)&&D(record.quantity_step).gt(0))||
     record.data_profile!==rawModel.data_profile)bad('PF2_INPUT_INVALID');
}

/** Bind every plan input to the deployment snapshot the enrollment was created from. */
function checkDeploymentSnapshot(snapshot,bound){
  const {plan,venue,analysis,bridge,capital}=bound;
  const market=venue.market;
  const member=Array.isArray(snapshot.membership)&&snapshot.membership.length===1?snapshot.membership[0]:null;
  const account=Array.isArray(snapshot.capital)?snapshot.capital.filter(item=>isObject(item)&&item.broker===market.broker):[];
  const ok=isObject(snapshot)&&isObject(snapshot.policy)&&isObject(snapshot.selection)&&
    snapshot.policy_hash===plan.policy_hash&&snapshot.policy_hash===hash(canonical(snapshot.policy))&&
    canonical(snapshot.market)===canonical(market)&&snapshot.source_hash===plan.source_hash&&
    isObject(member)&&member.source_hash===plan.source_hash&&member.pine_import_id===market.pine_import_id&&
    member.source_version===market.source_version&&canonical(member.analysis)===canonical(analysis)&&
    canonical(snapshot.selection.signals)===canonical(SIGNALS)&&isObject(snapshot.selection.bridge)&&
    attempt(()=>D(snapshot.selection.bridge.atr_multiplier).eq(D(bridge.atr_multiplier))&&
      D(snapshot.selection.bridge.rr).eq(D(bridge.rr)))&&
    account.length===1&&
    attempt(()=>D(account[0].configuredBalance).eq(D(capital.cash))&&D(account[0].configuredEquity).eq(D(capital.equity)));
  if(!ok)bad('PF2_INPUT_INVALID');
}

function provenanceShape(provenance,raw){
  if(!exactKeys(provenance,['range','pages'])||!isObject(provenance.range)||!Array.isArray(provenance.pages)||
     provenance.pages.length<1||provenance.pages.length>10000||
     canonical(provenance.range.metadata)!==canonical(raw))return false;
  let expectedStart=raw.start_time,total=0;
  for(const [index,page] of provenance.pages.entries()){
    if(!exactKeys(page,['page','start_time','end_time','count','sha256','retrieved_at','source','timestamp_semantics'])||
       page.page!==index||!safeInt(page.count,1,1000)||!safeInt(page.start_time,1,Number.MAX_SAFE_INTEGER)||
       !safeInt(page.end_time,1,Number.MAX_SAFE_INTEGER)||!isSha(page.sha256)||
       !safeInt(page.retrieved_at,0,Number.MAX_SAFE_INTEGER)||page.source!==KLINES_SOURCE||
       page.timestamp_semantics!==OPEN_TIME_SEMANTICS||page.start_time!==expectedStart||
       page.end_time!==page.start_time+page.count*MINUTE)return false;
    expectedStart=page.end_time;
    total+=page.count;
  }
  return expectedStart===raw.end_time&&total===raw.total_bars;
}

/// --- cancellation -----------------------------------------------------------------

/**
 * Resolver-owned cancellation. The caller signal is read here and never reaches a trusted
 * source: sources and stores get resolver-owned child signals, and the resolver never reads
 * any signal an adapter can see. Cancel state is a closure flag, set by one caller listener
 * (or by a guarded boolean read at each step boundary for a signal-like without
 * addEventListener). One shared promise rejects on abort, so awaits on trusted work race it
 * without a listener per call. `scope` serves the trusted sources; `verifyScope` serves the
 * dataset stores behind verifyEnrollmentBindingV2, which reads `signal.aborted` unguarded, so
 * a source that tampers with its own signal cannot disturb the content pass.
 */
function openCancel(callerSignal){
  const scope=new AbortController(),verifyScope=new AbortController();
  const child=scope.signal,verifyChild=verifyScope.signal;
  // Config breakage is decided by this closure flag, never by a caught value: an adapter can hold
  // one of our error objects and redefine its code, so no caught value is trusted to say "broken".
  let broken=false;
  const invalid=()=>{broken=true;return fail('PF2_RESOLVER_CONFIG_INVALID');};
  let cancelled=false,open=true,link=false,poll=false,shared=null,rejectShared=null;
  // An adapter can shadow dispatchEvent on its child, so each abort is guarded and independent.
  const closeScopes=()=>{if(open){open=false;attempt(()=>scope.abort());attempt(()=>verifyScope.abort());}};
  const onAbort=()=>{
    if(cancelled)return;
    cancelled=true;
    rejectShared(fail('PF2_CANCELLED'));
    closeScopes();
  };
  if(callerSignal!==undefined){
    let aborted,linkable;
    try{
      if(callerSignal===null||typeof callerSignal!=='object')throw new TypeError('signal');
      aborted=callerSignal.aborted;
      linkable=typeof callerSignal.addEventListener==='function';
    }catch{throw invalid();}
    if(typeof aborted!=='boolean')throw invalid();
    if(aborted)throw fail('PF2_CANCELLED');
    if(linkable){
      shared=new Promise((_,reject)=>{rejectShared=reject;});
      shared.catch(()=>{});
      try{callerSignal.addEventListener('abort',onAbort,{once:true});}catch{throw invalid();}
      link=true;
    }else poll=true;
  }
  const polled=()=>{
    let value;
    try{value=callerSignal.aborted;}catch{throw invalid();}
    if(typeof value!=='boolean')throw invalid();
    if(value&&!cancelled){cancelled=true;closeScopes();}
    return cancelled;
  };
  return {
    signal:child,verifySignal:verifyChild,
    cancelled:()=>poll&&!cancelled?polled():cancelled,
    broken:()=>broken,
    // Outer catch: no throw, no signal read in link mode, one guarded read in poll mode.
    observed:()=>cancelled||(poll&&attempt(()=>callerSignal.aborted===true)),
    race:pending=>link?Promise.race([pending,shared]):pending,
    close:()=>{
      if(link)attempt(()=>callerSignal.removeEventListener('abort',onAbort));
      closeScopes();
    }};
}

// --- resolver ---------------------------------------------------------------------

/**
 * options.signal is optional: an AbortSignal (one abort listener is linked) or a signal-like
 * without addEventListener (a boolean `aborted` is read at each step boundary). Trusted sources
 * and stores never receive it; they get resolver-owned child signals that are aborted on a
 * caller abort and once the call settles.
 */
export async function resolveHistoricalPreflight(planValue,trusted,options={}){
  let cancel=null;
  try{
    let settings;
    try{
      const {now,signal,supportedSourceHash=SOURCE_HASH,readFile=fs.readFile}=options??{};
      settings={now,signal,supportedSourceHash,readFile};
    }catch{throw fail('PF2_RESOLVER_CONFIG_INVALID');}
    cancel=openCancel(settings.signal);
    return await resolve(planValue,trusted,settings,cancel);
  }catch(error){
    if(cancel?.observed())throw fail('PF2_CANCELLED');
    // Never rethrow an inner error object: its keys, cause, stack and messages are not ours.
    throw fail(ownErrors.has(error)&&KNOWN_CODES.has(error.code)?error.code:'PF2_INPUT_INVALID');
  }finally{
    cancel?.close();
  }
}

async function resolve(planValue,trusted,{now,supportedSourceHash,readFile},cancel){
  const aborted=()=>{if(cancel.cancelled())throw fail('PF2_CANCELLED');};
  // A trusted call that ignores its signal must not hold the resolver past an abort.
  const guarded=async(code,operation)=>{
    aborted();
    let value;
    try{value=await cancel.race(operation());}
    catch(error){
      // A caller signal that broke mid resolve is our config error; decided by closure state, and the
      // caught value is never read or rethrown. Anything else is the adapter's.
      if(cancel.broken())throw fail('PF2_RESOLVER_CONFIG_INVALID');
      aborted();
      throw fail(code);
    }
    aborted();
    return value;
  };

  // 1. Config. Method references are captured once so later swaps have no effect.
  const api=attempt(()=>{
    const {records,enrollment,provenance,holdout,datasets}=trusted;
    const raw=datasets.raw,research=datasets.research;
    const found={authorize:trusted.authorize.bind(trusted),recordsGet:records.get.bind(records),
      enrollmentFind:enrollment.find.bind(enrollment),provenanceGet:provenance.get.bind(provenance),
      holdoutBoundary:holdout.boundary.bind(holdout),raw,research};
    const usable=[found.authorize,found.recordsGet,found.enrollmentFind,found.provenanceGet,
      found.holdoutBoundary,raw.inspect,raw.read,research.raw.inspect,research.inspectSidecarV2,
      research.readV2].every(item=>typeof item==='function');
    return usable?found:null;
  });
  if(!api||!safeInt(now,1,Number.MAX_SAFE_INTEGER)||typeof readFile!=='function'||!isSha(supportedSourceHash))
    bad('PF2_RESOLVER_CONFIG_INVALID');

  // 2. Plan.
  aborted();
  let plan,untrustedPlan;
  try{untrustedPlan=detach(planValue);}catch{bad('INVALID_PREFLIGHT_CONTRACT');}
  try{plan=validateHistoricalPreflightRequest(untrustedPlan);}
  catch(error){
    if(['PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED','PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED'].includes(error?.code))throw fail(error.code);
    throw fail('INVALID_PREFLIGHT_CONTRACT');
  }
  const plan_hash=hash(canonical(plan));
  const {foundation,snapshot:planSnapshot}=plan;
  const raw=foundation.dataset.metadata,development=planSnapshot.development;
  if([development.start_time,development.end_time,development.holdout_start_time,raw.start_time,raw.end_time]
    .some(time=>time>MAX_TIME_MS))bad('INVALID_PREFLIGHT_CONTRACT');

  // 3. Plan-level PF-2 gates (no I/O).
  if(planSnapshot.signal.mode==='BOUND_SIGNAL_CSV')bad('PF2_UNSUPPORTED_SIGNAL_MODE');
  if(planSnapshot.source_hash!==supportedSourceHash)bad('PF2_EVALUATOR_UNAVAILABLE');
  if(foundation.engine_hash===planSnapshot.signal.evaluator_hash)bad('PF2_ENGINE_HASH_MISMATCH');
  const budget=foundation.budget;
  if(budget.max_state_bytes<4096||budget.max_output_bytes<1024)bad('PF2_BUDGET_UNSUPPORTED');
  const {owner_id,bot_id}=foundation,ids={owner_id,bot_id};

  // 4. Authorization. No further trusted call after a failure.
  // Only a boolean leaves the guarded call: a raw adapter value must never settle a resolver promise.
  if(!await guarded('PF2_RESOLVE_UNAUTHORIZED',async()=>(await api.authorize({...ids},{signal:cancel.signal}))===true))
    bad('PF2_RESOLVE_UNAUTHORIZED');

  // 5. Holdout boundary from the registry (timestamp only, never data).
  const boundary=await guarded('PF2_HOLDOUT_BOUNDARY_MISMATCH',async()=>detach(await api.holdoutBoundary(
    {...ids,venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1'},{signal:cancel.signal})));
  if(!exactKeys(boundary,['holdout_start_time'])||!safeInt(boundary.holdout_start_time,1,MAX_TIME_MS)||
     boundary.holdout_start_time%MINUTE||boundary.holdout_start_time!==development.holdout_start_time)
    bad('PF2_HOLDOUT_BOUNDARY_MISMATCH');

  // 6. Executable identity (evaluator layer first, then the engine layer).
  const executables=await guarded('PF2_ENGINE_HASH_MISMATCH',()=>hashExecutables(readFile,cancel.cancelled));
  if(executables.evaluator_hash!==planSnapshot.signal.evaluator_hash)bad('PF2_EVALUATOR_HASH_MISMATCH');
  if(executables.engine_hash!==foundation.engine_hash)bad('PF2_ENGINE_HASH_MISMATCH');

  // 7. Records, in fixed order. Fetch, detach, re-hash, then validate the shape.
  // The value travels in a box: a hostile thenable must never be a resolution value of ours.
  const load=async(kind,sha)=>{
    const box=await guarded('PF2_INPUT_UNRESOLVED',
      async()=>({value:await api.recordsGet(kind,sha,{...ids,signal:cancel.signal})}));
    if(box.value===null||box.value===undefined)bad('PF2_INPUT_UNRESOLVED');
    return box;
  };
  const record=async(kind,sha)=>{
    const {value}=await load(kind,sha);
    // Proxy traps and getters on a trusted record run here: one fixed code, never their error.
    try{return detach(value);}catch{throw fail('PF2_INPUT_INVALID');}
  };
  const verified=(value,expected)=>{if(hash(canonical(value))!==expected)bad('PF2_INPUT_HASH_MISMATCH');return value;};

  const {value:source}=await load('source',planSnapshot.source_hash);
  if(typeof source!=='string'||source.length<1||lonelySurrogate.test(source)||
     Buffer.byteLength(source,'utf8')>256*1024)bad('PF2_INPUT_INVALID');
  if(hash(source)!==planSnapshot.source_hash)bad('PF2_INPUT_HASH_MISMATCH');
  const inspected=attempt(()=>inspectSource(source));
  if(!inspected||inspected.source_hash!==planSnapshot.source_hash||inspected.inputs.length!==INPUT_COUNT)
    bad('PF2_EVALUATOR_UNAVAILABLE');

  const analysis=await record('effective_inputs',planSnapshot.effective_inputs_hash);
  const valuesHash=hash(canonical(effectiveValues(analysis)));
  if(valuesHash!==planSnapshot.effective_inputs_hash)bad('PF2_INPUT_HASH_MISMATCH');
  checkEffectiveInputs(analysis,inspected,planSnapshot.source_hash,valuesHash);

  const bridge=verified(await record('bridge',planSnapshot.bridge_hash),planSnapshot.bridge_hash);
  checkBridge(bridge);
  const policyRecord=verified(await record('policy',planSnapshot.policy_hash),planSnapshot.policy_hash);
  const policy=checkPolicy(policyRecord);
  const capital=verified(await record('capital',planSnapshot.capital_hash),planSnapshot.capital_hash);
  checkCapital(capital);
  const initialState=verified(await record('initial_state',planSnapshot.initial_state_hash),
    planSnapshot.initial_state_hash);
  checkInitialState(initialState);
  const modelRecord=verified(await record('execution_model',planSnapshot.execution_model_hash),
    planSnapshot.execution_model_hash);
  const model=checkModel(modelRecord,planSnapshot.execution_model_version);
  const venue=verified(await record('venue_metadata',planSnapshot.venue_metadata_hash),
    planSnapshot.venue_metadata_hash);
  checkVenue(venue,modelRecord);

  // 8. Warm-up sufficiency (REQUIRED_SETTINGS stay authoritative in the replay evaluator).
  const slow=analysis.inputs.find(input=>input.pine_variable==='emaSlowInput');
  if(!slow||!safeInt(slow.effective_value,1,1000))bad('PF2_INPUT_INVALID');
  const warmupBars=raw.warmup_bars-SEED_BARS;
  if(warmupBars<Math.max(1006,slow.effective_value*5))bad('PF2_WARMUP_INSUFFICIENT');

  // 9. Enrollment.
  const enrollmentFail=()=>bad('PF2_DATASET_ENROLLMENT_REQUIRED');
  const found=await guarded('PF2_DATASET_ENROLLMENT_REQUIRED',async()=>{
    const value=await api.enrollmentFind({...ids,raw_dataset_sha256:foundation.dataset.sha256,
      execution_model_hash:planSnapshot.execution_model_hash,
      venue_metadata_hash:planSnapshot.venue_metadata_hash},{signal:cancel.signal});
    if(value===null||value===undefined)throw new Error('missing');
    return detach(value);
  });
  if(!exactKeys(found,['contract','result','capacity_policy','enrollment_evidence']))enrollmentFail();
  const {contract:enrolled,result:enrollment,capacity_policy,enrollment_evidence}=found;
  if(!attempt(()=>validateProfileEnrollmentReceipt(enrollment_evidence))||
    canonical(enrollment_evidence.job.contract)!==canonical(enrolled)||
    canonical(enrollment_evidence.job.result)!==canonical(enrollment)||
    canonical(enrollment_evidence.receipt.policy)!==canonical(capacity_policy))enrollmentFail();
  if(!attempt(()=>validateProfileResultV2(enrolled,enrollment,{policy:capacity_policy})))enrollmentFail();
  const profile=enrolled.profile,binding=enrollment.binding;
  if(enrolled.owner_id!==owner_id||enrolled.bot_id!==bot_id||
     canonical(enrolled.dataset)!==canonical(foundation.dataset)||
     profile.source_hash!==planSnapshot.source_hash||
     profile.effective_inputs_hash!==planSnapshot.effective_inputs_hash||
     hash(canonical(profile.execution_model))!==planSnapshot.execution_model_hash||
     profile.metadata_hash!==planSnapshot.venue_metadata_hash||
     profile.deployment_id!==venue.market.deployment_id)enrollmentFail();

  // 9b. The deployment snapshot the enrollment was created from binds the plan inputs.
  const deployment=verified(await record('deployment_snapshot',enrolled.snapshot_hash),enrolled.snapshot_hash);
  checkDeploymentSnapshot(deployment,{plan:planSnapshot,venue,analysis,bridge,capital});

  // 10. Boundary invariants from metadata only. derived.end_time is an index bound.
  const derived=attempt(()=>deriveClosedMetadataV2(foundation.dataset));
  const firstTime=derived?.start_time;
  const lastTime=firstTime+(derived?.total_bars-1)*MINUTE;
  if(!derived||firstTime!==binding.first_closed_time||derived.total_bars!==binding.bar_count||
     lastTime!==raw.end_time||lastTime>development.end_time||development.end_time>development.holdout_start_time)
    bad('PF2_HOLDOUT_BOUNDARY_MISMATCH');

  // 11. Capture-time evidence (arithmetic only).
  const provenance=await guarded('PF2_CAPTURE_EVIDENCE_REQUIRED',async()=>{
    const value=await api.provenanceGet(profile.raw_provenance_sha256,{...ids,signal:cancel.signal});
    if(value===null||value===undefined)throw new Error('missing');
    return detach(value);
  });
  if(hash(canonical(provenance))!==profile.raw_provenance_sha256||!provenanceShape(provenance,raw))
    bad('PF2_CAPTURE_EVIDENCE_REQUIRED');
  if(now<raw.end_time||provenance.pages.some(page=>page.retrieved_at<page.end_time||page.retrieved_at>now))
    bad('PF2_OPEN_BAR');

  // 12. Content: full byte pass over manifest, chunks, sidecar and ATR recompute.
  aborted();
  try{
    const content=await cancel.race(verifyEnrollmentBindingV2({rawReference:foundation.dataset,
      researchReference:enrollment.references,evidence:binding.evidence,rawStore:api.raw,
      researchStore:api.research,signal:cancel.verifySignal}));
    if(content.binding_sha256!==binding.binding_sha256)throw new Error('mismatch');
  }catch{
    // Only the closure decides cancellation; a store error, whatever its code, is a mismatch.
    aborted();
    throw fail('PF2_DATASET_HASH_MISMATCH');
  }
  aborted();

  // 13. Output. Cross-canonical parts are asserted, then detached and deep-frozen.
  const contract={
    version:'pf2-replay-job-v1',plan_hash,deployment_id:venue.market.deployment_id,
    signal:{mode:'EVALUATOR',profile:'SPT_CUSTOM',source,snapshot:{
      source_hash:planSnapshot.source_hash,
      market:{broker:venue.market.broker,symbol:venue.market.symbol,timeframe:venue.market.timeframe},
      selection:{signals:{...SIGNALS},bindings:[],fixed_inputs:analysis.inputs},
      membership:[{source_hash:planSnapshot.source_hash,analysis}]}},
    bridge:{atr_multiplier:bridge.atr_multiplier,rr:bridge.rr},model,policy,
    capital:{cash:capital.cash,equity:capital.equity},
    initial_state:{kind:'FRESH',loss_streak:initialState.loss_streak},
    broker:venue.market.broker,symbol:venue.market.symbol,
    dataset:{first_time:firstTime,total_bars:derived.total_bars,warmup_bars:warmupBars,
      development_end_time:development.end_time,holdout_start_time:development.holdout_start_time},
    limits:{max_bars:FOUNDATION_LIMITS.admittedBars,max_state_bytes:budget.max_state_bytes,
      max_output_bytes:budget.max_output_bytes,max_samples:200}};
  for(const part of [contract.bridge,contract.capital,contract.initial_state,contract.model,contract.dataset,
    contract.limits,contract.plan_hash,contract.deployment_id,contract.broker,contract.symbol])
    assertCrossCanonical(part);
  return frozenV2({
    version:PF2_RESOLVED_VERSION,plan_hash,owner_id,bot_id,
    budget:{chunk_bars:budget.chunk_bars,max_runtime_ms:budget.max_runtime_ms,
      max_output_bytes:budget.max_output_bytes,max_state_bytes:budget.max_state_bytes},
    identities:{engine_hash:foundation.engine_hash,evaluator_hash:planSnapshot.signal.evaluator_hash,
      source_hash:planSnapshot.source_hash,effective_inputs_hash:planSnapshot.effective_inputs_hash,
      bridge_hash:planSnapshot.bridge_hash,policy_hash:planSnapshot.policy_hash,
      capital_hash:planSnapshot.capital_hash,initial_state_hash:planSnapshot.initial_state_hash,
      execution_model_hash:planSnapshot.execution_model_hash,
      venue_metadata_hash:planSnapshot.venue_metadata_hash,raw_dataset_sha256:binding.raw_dataset_sha256,
      closed_dataset_sha256:binding.closed_dataset_sha256,atr14_sha256:binding.atr14_sha256,
      enrollment_binding_sha256:binding.binding_sha256,raw_provenance_sha256:profile.raw_provenance_sha256,
      enrollment_evaluator_hash:binding.evidence.evaluator_hash},
    dataset:{raw:foundation.dataset,research:enrollment.references,first_time:firstTime,
      total_bars:derived.total_bars,warmup_bars:warmupBars,
      evaluation_start_time:firstTime+warmupBars*MINUTE,last_time:lastTime,
      development_start_time:development.start_time,development_end_time:development.end_time,
      holdout_start_time:development.holdout_start_time},
    contract,
    admission:{development_only:true,evaluator_admission:false,holdout_accessed:false,
      orders_executed:false,execution_model_parity:'V1_ONLY'},
    acceptance_blockers:enrollment.acceptance_blockers,limitations:[...PF2_LIMITATIONS]});
}
