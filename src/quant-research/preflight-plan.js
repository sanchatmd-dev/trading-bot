import {canonical,fail as makeError,hash} from '../pine-bridge/source.js';
import {D,exact} from '../money.js';
import {SOURCE_HASH} from './contract.js';
import {deriveClosedMetadataV2} from './data-profile-v2.js';
import {validateFoundationRequest} from './foundation-contract.js';
import {frozenV2,strictJsonV2} from './foundation-contract-v2.js';
import {validateHistoricalPreflightRequest} from './preflight-contract.js';
import {PF2_REPLAY_ENVELOPE_VERSION,PF2_REPLAY_LIMITATIONS,PF2_RESULT_VERSION} from './preflight-replay.js';
import {PF2_LIMITATIONS} from './preflight-resolver.js';
import {validateProfileResultV2} from './profile-contract-v2.js';

/**
 * PF-2 runtime slice R1: pure plan builder, record derivation and envelope validator.
 * No database, network, clock, file or process access. Every input is untrusted data: it is
 * detached once and only the copy is used. Row-level integrity (ownership, status, locks,
 * freshness against live tables) stays with the caller that reads the rows. Every failure is
 * a fixed code; no inner error, path or value leaves this module.
 */
export const PREFLIGHT_PLAN_VERSION='historical-preflight-v1';

// RD-3 budgets. The 2 MiB cap is the TerminalFrame / plain stdout limit of the supervised runner.
export const PREFLIGHT_RUNTIME_BUDGET=Object.freeze({candidates:1,max_evaluations:1,chunk_bars:1000,
  max_runtime_ms:900000,max_output_bytes:524288,max_state_bytes:1048576,
  response_headroom_bytes:65536,response_cap_bytes:2097152});

export const PREFLIGHT_RECORD_FIELDS=Object.freeze({source:'source_hash',effective_inputs:'effective_inputs_hash',
  bridge:'bridge_hash',policy:'policy_hash',capital:'capital_hash',initial_state:'initial_state_hash',
  execution_model:'execution_model_hash',venue_metadata:'venue_metadata_hash'});

export const PREFLIGHT_PLAN_ERRORS=Object.freeze(['INVALID_PREFLIGHT_CONTRACT','PREFLIGHT_ENROLLMENT_REQUIRED',
  'PREFLIGHT_DEPLOYMENT_UNSUPPORTED','RESEARCH_DEPLOYMENT_NOT_READY','SNAPSHOT_HASH_MISMATCH',
  'UNSUPPORTED_SOURCE_HASH','PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED','PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED',
  'FOUNDATION_CAPABILITY_LIMIT','PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED','PREFLIGHT_ENVELOPE_INVALID']);

const MINUTE=60000;
const DAY=86_400_000;
const MAX_TIME_MS=253_402_300_799_999;
const MAX_SOURCE_BYTES=256*1024;
const MODEL_VERSION='paper-close-v1';
const DATA_PROFILE='closed-ohlcv-atr14-v1';
const BROKER='binance-global';
const SYMBOL='BTCUSDT';
const TIMEFRAME='1';
const SIGNALS=canonical({buy:'buySignal',exit:'sellSignal',timing:'bar_close'});
const MODEL_KEYS=['version','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','data_profile'];
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEPLOYMENT_ID=/^[A-Za-z0-9-]{8,128}$/;
const PLAN_CODES=new Set(['FOUNDATION_CAPABILITY_LIMIT','PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED',
  'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED']);
const lonelySurrogate=/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// The only budget a PREFLIGHT plan may carry: the builder writes it and the envelope validator pins it.
const preflightBudget=rawTotal=>({candidates:PREFLIGHT_RUNTIME_BUDGET.candidates,
  max_evaluations:PREFLIGHT_RUNTIME_BUDGET.max_evaluations,
  chunk_bars:Math.min(PREFLIGHT_RUNTIME_BUDGET.chunk_bars,rawTotal),
  max_runtime_ms:PREFLIGHT_RUNTIME_BUDGET.max_runtime_ms,max_output_bytes:PREFLIGHT_RUNTIME_BUDGET.max_output_bytes,
  max_state_bytes:PREFLIGHT_RUNTIME_BUDGET.max_state_bytes});

// Errors minted here are tracked by identity, so a value thrown by an untrusted getter or an
// inner validator can never pass as one of ours, whatever code it claims.
const ownErrors=new WeakSet();
function fail(code,status=409){
  const error=makeError(code,status);
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
const attempt=operation=>{try{return operation();}catch{return false;}};

/** One structural pass: strict JSON shape, then a plain canonical copy. Fixed code on any defect. */
function clean(value,code){
  try{
    strictJsonV2(value);
    return JSON.parse(canonical(value));
  }catch{throw fail(code);}
}

/** Reads named data properties once through their descriptors; accessors and symbols are refused. */
function take(value,names,code,{optional=[],exactSet=true}={}){
  if(!isObject(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad(code);
  const own=Reflect.ownKeys(value),allowed=[...names,...optional];
  if(exactSet&&(own.some(name=>typeof name!=='string'||!allowed.includes(name))||
     names.some(name=>!own.includes(name))))bad(code);
  const out={};
  for(const name of allowed){
    if(!own.includes(name)){
      if(names.includes(name))bad(code);
      continue;
    }
    const field=Object.getOwnPropertyDescriptor(value,name);
    if(!field||!field.enumerable||!Object.hasOwn(field,'value'))bad(code);
    out[name]=field.value;
  }
  return out;
}

// --- record derivation (contract section 4.2) -----------------------------------------------

function checkModel(value){
  const model=clean(value,'PREFLIGHT_ENROLLMENT_REQUIRED');
  if(!isObject(model))bad('PREFLIGHT_ENROLLMENT_REQUIRED');
  // A later cost model never rides on V1 evidence.
  if(typeof model.version==='string'&&model.version!==MODEL_VERSION)bad('PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED');
  if(!exactKeys(model,MODEL_KEYS)||model.version!==MODEL_VERSION||model.data_profile!==DATA_PROFILE||
     ['price_tick','quantity_step'].some(name=>!['number','string'].includes(typeof model[name])))
    bad('PREFLIGHT_ENROLLMENT_REQUIRED');
  return model;
}

function checkSource(source,snapshot,member){
  if(typeof source!=='string'||source.length<1||lonelySurrogate.test(source)||
     Buffer.byteLength(source,'utf8')>MAX_SOURCE_BYTES)bad('UNSUPPORTED_SOURCE_HASH');
  const digest=hash(source);
  if(snapshot.source_hash!==digest||member.source_hash!==digest)bad('UNSUPPORTED_SOURCE_HASH');
  return digest;
}

/** Structure the deployment snapshot must have before any record is read from it. */
function checkSnapshot(snapshot){
  const unsupported=()=>bad('PREFLIGHT_DEPLOYMENT_UNSUPPORTED');
  if(!isObject(snapshot))unsupported();
  const {market,policy,selection,membership,capital}=snapshot;
  const member=Array.isArray(membership)&&membership.length===1?membership[0]:null;
  if(!isObject(market)||market.broker!==BROKER||market.symbol!==SYMBOL||market.timeframe!==TIMEFRAME||
     !isObject(policy)||policy.paperTrading!==true||policy.requireReduceOnlySell!==true||
     !isObject(selection)||canonical(selection.signals)!==SIGNALS||!isObject(selection.bridge)||
     !isObject(member)||!isObject(member.analysis)||!Array.isArray(member.analysis.inputs)||
     !Array.isArray(capital))unsupported();
  if(snapshot.policy_hash!==hash(canonical(policy)))bad('SNAPSHOT_HASH_MISMATCH');
  const accounts=capital.filter(item=>isObject(item)&&item.broker===market.broker);
  if(accounts.length!==1)unsupported();
  return {market,policy,selection,member,account:accounts[0]};
}

/**
 * Derives the eight plan records from an authoritative deployment snapshot, the enrolled
 * execution model and the source text. One pure function shared by the plan builder and the
 * production trusted adapters, so both sides hash the same bytes. Returns a deep-frozen
 * {records,hashes}; the hash preimages are the S3 resolver preimages (contract section 1).
 */
export function derivePreflightRecords(input){
  try{
    const {snapshot:untrusted,model:enrolled,source}=take(input,['snapshot','model','source'],
      'INVALID_PREFLIGHT_CONTRACT');
    const model=checkModel(enrolled);
    const snapshot=clean(untrusted,'PREFLIGHT_DEPLOYMENT_UNSUPPORTED');
    const {market,policy,selection,member,account}=checkSnapshot(snapshot);
    const sourceHash=checkSource(source,snapshot,member);
    const analysis=member.analysis;
    const ids=new Set();
    const values=Object.fromEntries(analysis.inputs.map(item=>{
      if(!isObject(item)||typeof item.input_id!=='string'||!Object.hasOwn(item,'effective_value')||
         ids.has(item.input_id))bad('PREFLIGHT_DEPLOYMENT_UNSUPPORTED');
      ids.add(item.input_id);
      return [item.input_id,item.effective_value];
    }));
    const valuesHash=hash(canonical(values));
    if(analysis.effective_inputs_hash!==valuesHash)bad('PREFLIGHT_DEPLOYMENT_UNSUPPORTED');
    let bridge,capital;
    try{
      bridge={atr_multiplier:exact(selection.bridge.atr_multiplier),rr:exact(selection.bridge.rr)};
      capital={cash:exact(account.configuredBalance),equity:exact(account.configuredEquity)};
    }catch{bad('PREFLIGHT_DEPLOYMENT_UNSUPPORTED');}
    const records={source,effective_inputs:analysis,bridge,policy,capital,
      initial_state:{kind:'FRESH',loss_streak:0},execution_model:model,
      // The exact metadata formula of QuantProfileService: String() of the model decimals.
      venue_metadata:{market,price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),
        data_profile:model.data_profile}};
    const hashes={};
    for(const [kind,field] of Object.entries(PREFLIGHT_RECORD_FIELDS)){
      hashes[field]=kind==='source'?sourceHash:kind==='effective_inputs'?valuesHash:hash(canonical(records[kind]));
    }
    return frozenV2({records,hashes});
  }catch(error){
    throw ownErrors.has(error)?error:fail('INVALID_PREFLIGHT_CONTRACT');
  }
}

// --- plan builder (contract sections 3.3 e to l, pure part) ---------------------------------

const BUILD_FIELDS=['owner_id','bot_id','deployment_id','enrollment','deployment','source','boundary',
  'executables','capacityPolicy'];
const DEPLOYMENT_FIELDS=['deployment_id','owner_id','bot_id','state','snapshot','snapshot_hash'];

function checkEnrollment(args,ids){
  const code='PREFLIGHT_ENROLLMENT_REQUIRED';
  const {contract:untrusted,result:untrustedResult,contract_hash:sealed,status}=take(args.enrollment,
    ['contract','result','contract_hash','status'],code);
  const contract=clean(untrusted,code),result=clean(untrustedResult,code);
  const policy=clean(args.capacityPolicy,code);
  if(!isObject(contract)||!isObject(result)||!isObject(contract.profile)||
     !isObject(contract.profile.execution_model))bad(code);
  const version=contract.profile.execution_model.version;
  if(typeof version==='string'&&version!==MODEL_VERSION)bad('PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED');
  if(contract.version!=='quant-foundation-v2'||contract.kind!=='PROFILE'||contract.owner_id!==ids.owner_id||
     contract.bot_id!==ids.bot_id||contract.profile.deployment_id!==ids.deployment_id)bad(code);
  // Row integrity of the caller: the stored contract hash must match and the job must have succeeded.
  if(sealed!==hash(canonical(contract))||status!=='SUCCEEDED')bad(code);
  if(!attempt(()=>validateProfileResultV2(contract,result,{policy})))bad(code);
  return {contract,result};
}

function checkDeployment(args,ids,enrolled){
  const code='PREFLIGHT_DEPLOYMENT_UNSUPPORTED';
  const row=take(args.deployment,DEPLOYMENT_FIELDS,code,{exactSet:false});
  if(row.deployment_id!==ids.deployment_id||row.owner_id!==ids.owner_id||row.bot_id!==ids.bot_id)bad(code);
  if(row.state!=='READY')bad('RESEARCH_DEPLOYMENT_NOT_READY');
  const snapshot=clean(row.snapshot,code);
  if(!isSha(row.snapshot_hash)||hash(canonical(snapshot))!==row.snapshot_hash||
     row.snapshot_hash!==enrolled.snapshot_hash)bad('SNAPSHOT_HASH_MISMATCH');
  // Cheap enqueue check: the venue the snapshot captured belongs to this deployment.
  if(snapshot?.market?.deployment_id!==ids.deployment_id)bad(code);
  return snapshot;
}

function checkSourceRow(args,supported,snapshot){
  const row=take(args.source,['source','source_hash'],'UNSUPPORTED_SOURCE_HASH',{exactSet:false});
  if(typeof row.source!=='string'||!isSha(row.source_hash)||row.source_hash!==supported||
     hash(row.source)!==row.source_hash||snapshot.source_hash!==row.source_hash)bad('UNSUPPORTED_SOURCE_HASH');
  return row.source;
}

function checkBoundary(args,raw){
  const code='PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED';
  const {holdout_start_time:holdout}=take(args.boundary,['holdout_start_time'],code);
  if(!safeInt(holdout,1,MAX_TIME_MS)||holdout%MINUTE)bad(code);
  // The whole artifact, warm-up included, must end at or before the registered holdout start.
  if(raw.end_time>holdout)bad('PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED');
  return holdout;
}

/**
 * Builds the frozen historical-preflight plan for one enrolled PROFILE v2 dataset. Development
 * only, V1 only, EVALUATOR mode only. Pure: the caller supplies rows it has already read under
 * its own locks (and ran its live freshness check on) and stores the returned bytes.
 * Returns {plan,plan_json,plan_hash,contract_hash,records,hashes}; plan_hash equals the plan
 * hash the S3 resolver computes.
 */
export function buildPreflightPlan(input){
  try{
    const args=take(input,BUILD_FIELDS,'INVALID_PREFLIGHT_CONTRACT',{optional:['supportedSourceHash']});
    const supported=args.supportedSourceHash===undefined?SOURCE_HASH:args.supportedSourceHash;
    const ids={owner_id:args.owner_id,bot_id:args.bot_id,deployment_id:args.deployment_id};
    if(typeof ids.owner_id!=='string'||!OWNER_ID.test(ids.owner_id)||typeof ids.bot_id!=='string'||
       !OWNER_ID.test(ids.bot_id)||typeof ids.deployment_id!=='string'||!DEPLOYMENT_ID.test(ids.deployment_id)||
       !isSha(supported))bad('INVALID_PREFLIGHT_CONTRACT');
    const {contract}=checkEnrollment(args,ids);
    const snapshot=checkDeployment(args,ids,contract);
    const source=checkSourceRow(args,supported,snapshot);
    const raw=contract.dataset.metadata;
    const holdout=checkBoundary(args,raw);
    const derived=derivePreflightRecords({snapshot,model:contract.profile.execution_model,source});
    const {hashes}=derived,profile=contract.profile;
    if(hashes.source_hash!==profile.source_hash||hashes.effective_inputs_hash!==profile.effective_inputs_hash||
       hashes.venue_metadata_hash!==profile.metadata_hash||
       hashes.execution_model_hash!==hash(canonical(profile.execution_model)))bad('PREFLIGHT_ENROLLMENT_REQUIRED');
    const executables=take(args.executables,['engine_hash','evaluator_hash'],'INVALID_PREFLIGHT_CONTRACT');
    if(!isSha(executables.engine_hash)||!isSha(executables.evaluator_hash)||
       executables.engine_hash===executables.evaluator_hash)bad('INVALID_PREFLIGHT_CONTRACT');
    const planSnapshot={version:'pf2-snapshot-v1',...hashes,execution_model_version:MODEL_VERSION,
      signal:{mode:'EVALUATOR',evaluator_hash:executables.evaluator_hash,artifact_sha256:null},
      development:{start_time:raw.start_time,end_time:raw.end_time,holdout_start_time:holdout}};
    let plan;
    try{
      plan=validateHistoricalPreflightRequest({version:PREFLIGHT_PLAN_VERSION,
        foundation:{version:'quant-foundation-v1',owner_id:ids.owner_id,bot_id:ids.bot_id,kind:'PREFLIGHT',
          dataset:contract.dataset,engine_hash:executables.engine_hash,snapshot_hash:hash(canonical(planSnapshot)),
          budget:preflightBudget(raw.total_bars)},
        snapshot:planSnapshot});
    }catch(error){
      throw fail(PLAN_CODES.has(error?.code)?error.code:'INVALID_PREFLIGHT_CONTRACT');
    }
    const plan_json=canonical(plan);
    return Object.freeze({plan,plan_json,plan_hash:hash(plan_json),contract_hash:hash(canonical(plan.foundation)),
      records:derived.records,hashes});
  }catch(error){
    throw ownErrors.has(error)?error:fail('INVALID_PREFLIGHT_CONTRACT');
  }
}

// --- envelope validator (contract sections 6.9 and 9.2) -------------------------------------

const ENVELOPE_KEYS=['version','plan_hash','owner_id','bot_id','binding','dataset','run','result','admission',
  'acceptance_blockers','limitations'];
const BINDING_KEYS=['contract_sha256','resolved_sha256','contract_digest','engine_hash','evaluator_hash',
  'raw_dataset_sha256','closed_dataset_sha256','atr14_sha256','enrollment_binding_sha256'];
const DATASET_KEYS=['first_time','evaluation_start_time','last_time','total_bars','warmup_bars',
  'development_end_time','holdout_start_time'];
const RUN_KEYS=['chunk_bars','chunks_executed','resumed_from_bar'];
const RESULT_KEYS=['version','plan_hash','execution_model_version','window','counters','derived','guards',
  'account','samples','admission','limitations'];
const WINDOW_KEYS=['first_time','evaluation_start_time','last_time','development_end_time','holdout_start_time',
  'bars_seen','warmup_bars','evaluated_bars'];
const FILL_KEYS=['time','event_type','entry_ref','reason','sizing_outcome','quantity','price','notional','fee'];
const REJECTION_KEYS=['time','event_type','entry_ref','reason'];
const GUARD_KINDS=['KILL_SWITCH','MAX_TRADES_PER_DAY','MAX_DAILY_LOSS','LOSS_STREAK'];
const PERSISTENT_KINDS=['KILL_SWITCH','LOSS_STREAK'];
const DAY_KINDS=['MAX_TRADES_PER_DAY','MAX_DAILY_LOSS'];
const PERIOD_KEYS=['kind','start_time','end_time','persistent'];
const MAX_CLOSED_PERIODS=256;
const EXIT_REASONS=['SL','TP','NATIVE'];
const MAX_COUNT=Number.MAX_SAFE_INTEGER;
const MAX_SAMPLES=200; // The S3 resolver fixes contract.limits.max_samples at 200.
const MAX_PERIODS=260; // 256 closed periods plus at most one open period per guard kind.
// The S1 result limitations (research_chunk core constant, kept in order by the S4 driver).
const S1_LIMITATIONS=Object.freeze(['V1_ONLY','DEVELOPMENT_ONLY','EVALUATOR_ADMISSION_FALSE','DIAGNOSTIC_ONLY',
  'SIZING_ADJUSTED_INCLUDES_QUANTITY_STEP_ROUNDING']);
// Same first-occurrence order the S4 driver uses: resolver, S1 result, then driver limitations.
const ENVELOPE_LIMITATIONS=Object.freeze([...new Set([...PF2_LIMITATIONS,...S1_LIMITATIONS,
  ...PF2_REPLAY_LIMITATIONS])]);
const ADMISSION=Object.freeze({development_only:true,evaluator_admission:false,holdout_accessed:false,
  orders_executed:false,execution_model_parity:'V1_ONLY'});
const REQUIRED_BLOCKERS=['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED'];
const NO_ETA_KEYS=[/(^|_)eta(_|$)/i,/estimat/i,/collection/i];

const must=condition=>{if(!condition)throw fail('PREFLIGHT_ENVELOPE_INVALID',500);};
const counts=(group,names)=>exactKeys(group,names)&&names.every(name=>safeInt(group[name],0,MAX_COUNT));
const total=values=>values.reduce((sum,value)=>sum+value,0);
const nextMidnight=time=>(Math.floor(time/DAY)+1)*DAY;
const plainDecimal=value=>printable(value,1,80)&&/^[0-9]+(?:\.[0-9]+)?$/.test(value);
const admissionOk=value=>exactKeys(value,Object.keys(ADMISSION))&&
  Object.entries(ADMISSION).every(([name,expected])=>value[name]===expected);

/** Rejects any key that could carry a time-to-completion figure or a collection estimate. */
function assertNoEta(value,skip){
  const walk=item=>{
    if(Array.isArray(item)){item.forEach(walk);return;}
    if(!isObject(item))return;
    for(const [key,child] of Object.entries(item)){
      must(skip.has(item)||!NO_ETA_KEYS.some(pattern=>pattern.test(key)));
      walk(child);
    }
  };
  walk(value);
}

/** Policy-free guard invariants of S4 (the plan fixes a FRESH start, so the initial loss streak is 0). */
function checkGuards(result,dataset,{episodes}){
  const S=dataset.evaluation_start_time,L=dataset.last_time,E=dataset.total_bars-dataset.warmup_bars;
  const g=result.guards;
  must(exactKeys(g,['kill_switch','loss_streak_final','pause'])&&typeof g.kill_switch==='boolean'&&
    safeInt(g.loss_streak_final,0,episodes.losing));
  const pause=g.pause;
  must(exactKeys(pause,['persistent','active_kinds','periods','truncated','dropped_periods'])&&
    typeof pause.persistent==='boolean'&&typeof pause.truncated==='boolean'&&
    safeInt(pause.dropped_periods,0,MAX_COUNT)&&pause.truncated===(pause.dropped_periods>0));
  const kinds=pause.active_kinds;
  must(Array.isArray(kinds)&&kinds.every(kind=>GUARD_KINDS.includes(kind))&&new Set(kinds).size===kinds.length&&
    kinds.every((kind,index)=>index===0||GUARD_KINDS.indexOf(kinds[index-1])<GUARD_KINDS.indexOf(kind))&&
    pause.persistent===kinds.some(kind=>PERSISTENT_KINDS.includes(kind))&&
    // The driver equates the flag with the policy switch, so the switch pause follows the flag alone.
    kinds.includes('KILL_SWITCH')===(g.kill_switch&&E>0));
  const periods=pause.periods;
  must(Array.isArray(periods)&&periods.length<=MAX_PERIODS&&periods.every(item=>
    exactKeys(item,PERIOD_KEYS)&&GUARD_KINDS.includes(item.kind)&&
    safeInt(item.start_time,S,L)&&item.start_time%MINUTE===0&&typeof item.persistent==='boolean'&&
    (item.end_time===null||(safeInt(item.end_time,item.start_time+1,L)&&item.end_time%MINUTE===0))));
  const closed=periods.filter(item=>item.end_time!==null),open=periods.filter(item=>item.end_time===null);
  // Closed periods come first; the open ones are exactly the active kinds, in kind order.
  must(periods.slice(0,closed.length).every(item=>item.end_time!==null)&&closed.length<=MAX_CLOSED_PERIODS&&
    open.length===kinds.length&&open.every((item,index)=>item.kind===kinds[index]));
  // Only day-scoped pauses end, never past their UTC day; persistent pauses stay open to the last bar.
  must(closed.every(item=>DAY_KINDS.includes(item.kind)&&item.persistent===false&&
    item.end_time<=Math.min(nextMidnight(item.start_time),L)));
  must(open.every(item=>item.persistent===PERSISTENT_KINDS.includes(item.kind)&&
    (item.persistent||nextMidnight(item.start_time)>L)&&(item.kind!=='KILL_SWITCH'||item.start_time===S)));
  must(pause.dropped_periods===0||closed.length===MAX_CLOSED_PERIODS);
}

function checkSamples(result,dataset,{orders,fills,byReason}){
  const S=dataset.evaluation_start_time,L=dataset.last_time;
  const samples=result.samples;
  must(exactKeys(samples,['fills','rejections'])&&Array.isArray(samples.fills)&&Array.isArray(samples.rejections)&&
    samples.fills.length===Math.min(MAX_SAMPLES,fills.buy+fills.exit)&&
    samples.rejections.length===Math.min(MAX_SAMPLES,orders.rejected));
  // Samples keep event order: a time never goes back, from the first evaluated bar to the last bar.
  let previous=S,buys=0,exits=0;
  for(const item of samples.fills){
    must(exactKeys(item,FILL_KEYS)&&safeInt(item.time,previous,L)&&item.time%MINUTE===0&&
      ['BUY','EXIT'].includes(item.event_type)&&
      (item.event_type==='BUY'?item.reason===null:EXIT_REASONS.includes(item.reason))&&
      ['ACCEPTED','CAPPED'].includes(item.sizing_outcome)&&printable(item.entry_ref,1,256)&&
      ['quantity','price','notional','fee'].every(name=>printable(item[name],1,80)));
    previous=item.time;
    if(item.event_type==='BUY')buys++;else exits++;
  }
  // The sample length equals the smaller of the cap and the fill count, so these bounds also force equality.
  must(buys<=fills.buy&&exits<=fills.exit);
  previous=S;
  for(const item of samples.rejections){
    must(exactKeys(item,REJECTION_KEYS)&&safeInt(item.time,previous,L)&&item.time%MINUTE===0&&
      ['BUY','EXIT'].includes(item.event_type)&&printable(item.entry_ref,1,256)&&printable(item.reason,1,128)&&
      Object.hasOwn(byReason,item.reason));
    previous=item.time;
  }
}

/** Shape, cross-field and dataset-binding checks of the S1 result carried by the envelope. */
function checkResult(result,{planHash,dataset}){
  must(exactKeys(result,RESULT_KEYS)&&result.version===PF2_RESULT_VERSION&&result.plan_hash===planHash&&
    result.execution_model_version===MODEL_VERSION);
  const w=result.window;
  must(exactKeys(w,WINDOW_KEYS)&&w.first_time===dataset.first_time&&
    w.evaluation_start_time===dataset.evaluation_start_time&&w.last_time===dataset.last_time&&
    w.development_end_time===dataset.development_end_time&&w.holdout_start_time===dataset.holdout_start_time&&
    w.bars_seen===dataset.total_bars&&w.warmup_bars===dataset.warmup_bars&&
    w.evaluated_bars===dataset.total_bars-dataset.warmup_bars);
  const c=result.counters;
  must(exactKeys(c,['signals','intents','warmup_intents','orders','fills','episodes']));
  const {signals,intents,warmup_intents:warm,orders,fills,episodes}=c;
  must(counts(signals,['buy','native_exit','buy_evaluated','native_exit_evaluated'])&&
    counts(intents,['buy','exit_sl','exit_tp','exit_native'])&&counts(warm,['buy','exit'])&&
    counts(episodes,['closed','losing']));
  must(exactKeys(orders,['accepted','sizing_adjusted','rejected','rejected_by_reason'])&&
    ['accepted','sizing_adjusted','rejected'].every(name=>safeInt(orders[name],0,MAX_COUNT))&&
    exactKeys(fills,['buy','exit','exit_by_reason'])&&['buy','exit'].every(name=>safeInt(fills[name],0,MAX_COUNT)));
  const byReason=orders.rejected_by_reason,byExit=fills.exit_by_reason;
  must(isObject(byReason)&&Object.keys(byReason).length<=33&&
    Object.entries(byReason).every(([key,count])=>printable(key,1,128)&&safeInt(count,1,MAX_COUNT)));
  must(isObject(byExit)&&
    Object.entries(byExit).every(([key,count])=>EXIT_REASONS.includes(key)&&safeInt(count,1,MAX_COUNT)));
  const T=dataset.total_bars,W=dataset.warmup_bars,E=T-W;
  const evaluated=total(Object.values(intents));
  // S4 11.3 a and b: signal totals, then intents against signals.
  must(signals.buy<=T&&signals.native_exit<=T&&signals.buy_evaluated<=Math.min(signals.buy,E)&&
    signals.native_exit_evaluated<=Math.min(signals.native_exit,E)&&signals.buy-signals.buy_evaluated<=W);
  must(intents.buy+warm.buy<=signals.buy&&intents.buy<=signals.buy_evaluated&&
    warm.buy<=signals.buy-signals.buy_evaluated&&evaluated<=E*1000&&(W!==0||warm.buy+warm.exit===0)&&
    (E!==0||evaluated===0));
  // S4 11.3 c, d, e: orders and fills add up.
  must(total(Object.values(byReason))===orders.rejected&&total(Object.values(byExit))===fills.exit&&
    orders.accepted+orders.sizing_adjusted+orders.rejected===evaluated&&
    fills.buy+fills.exit===orders.accepted+orders.sizing_adjusted);
  // S4 11.3 f and g: one decision per intent, an exit keeps its reason, episodes follow the exits.
  must(fills.buy<=intents.buy&&fills.exit<=fills.buy&&(byExit.SL??0)<=intents.exit_sl&&
    (byExit.TP??0)<=intents.exit_tp&&(byExit.NATIVE??0)<=intents.exit_native);
  must(episodes.closed<=fills.exit&&episodes.losing<=episodes.closed&&
    (fills.buy-fills.exit!==0||fills.buy===0||episodes.closed>=1));
  const d=result.derived;
  must(exactKeys(d,['intents_evaluated','suppressed_buy','suppressed_buy_evaluated','non_losing_episodes'])&&
    d.intents_evaluated===evaluated&&d.suppressed_buy===signals.buy-intents.buy-warm.buy&&d.suppressed_buy>=0&&
    d.suppressed_buy_evaluated===signals.buy_evaluated-intents.buy&&d.suppressed_buy_evaluated>=0&&
    d.non_losing_episodes===episodes.closed-episodes.losing);
  checkGuards(result,dataset,{episodes});
  const a=result.account;
  must(exactKeys(a,['cash','position_quantity','position_cost','open_allocations'])&&
    ['cash','position_quantity','position_cost'].every(name=>plainDecimal(a[name]))&&
    a.open_allocations===fills.buy-fills.exit&&
    attempt(()=>D(a.position_quantity).eq(0))===(a.open_allocations===0));
  checkSamples(result,dataset,{orders,fills,byReason});
  must(admissionOk(result.admission)&&canonical(result.limitations)===canonical(S1_LIMITATIONS));
}

/**
 * Re-validates a stored PF-2 envelope (`pf2-preflight-replay-v1`) against the foundation contract
 * and the plan hash the caller read from its own row (options.planHash, never from the envelope).
 * options.plan is required: the stored plan from the same row. It must hash to planHash and match the
 * contract, and it binds the evaluator identity and the development and holdout times of the envelope.
 * The contract must carry the one PREFLIGHT budget of this module. The result checks are the S4 driver
 * invariants that need no policy input; the policy dependent ones (kill switch equals the policy switch,
 * the loss streak pause threshold, entry reference prefix) were checked by the driver before it wrote
 * the envelope. Returns a deep-frozen detached copy. Any defect is PREFLIGHT_ENVELOPE_INVALID (status 500).
 */
export function validatePreflightEnvelope(contract,envelope,options){
  try{
    const {planHash,plan}=take(options,['planHash','plan'],'PREFLIGHT_ENVELOPE_INVALID');
    must(isSha(planHash));
    const foundation=validateFoundationRequest(clean(contract,'PREFLIGHT_ENVELOPE_INVALID'));
    must(foundation.kind==='PREFLIGHT'&&
      canonical(foundation.budget)===canonical(preflightBudget(foundation.dataset.metadata.total_bars)));
    const env=clean(envelope,'PREFLIGHT_ENVELOPE_INVALID');
    // The pinned output budget also caps the work the scans below do on a hostile value.
    must(Buffer.byteLength(canonical(env))<=foundation.budget.max_output_bytes);
    // The key scan runs first, so a stray ETA field is named as such before any shape check.
    const reasons=env?.result?.counters?.orders?.rejected_by_reason;
    assertNoEta(env,new Set(isObject(reasons)?[reasons]:[]));
    must(exactKeys(env,ENVELOPE_KEYS)&&env.version===PF2_REPLAY_ENVELOPE_VERSION&&env.plan_hash===planHash&&
      env.owner_id===foundation.owner_id&&env.bot_id===foundation.bot_id);
    const b=env.binding;
    must(exactKeys(b,BINDING_KEYS)&&BINDING_KEYS.every(name=>isSha(b[name]))&&
      b.engine_hash===foundation.engine_hash&&b.evaluator_hash!==b.engine_hash&&
      b.raw_dataset_sha256===foundation.dataset.sha256);
    const closed=deriveClosedMetadataV2(foundation.dataset);
    const d=env.dataset;
    must(exactKeys(d,DATASET_KEYS)&&d.first_time===closed.start_time&&d.total_bars===closed.total_bars&&
      d.warmup_bars===closed.warmup_bars&&d.evaluation_start_time===d.first_time+d.warmup_bars*MINUTE&&
      d.last_time===d.first_time+(d.total_bars-1)*MINUTE&&safeInt(d.development_end_time,1,MAX_TIME_MS)&&
      safeInt(d.holdout_start_time,1,MAX_TIME_MS)&&d.last_time<=d.development_end_time&&
      d.development_end_time<=d.holdout_start_time);
    const r=env.run;
    const chunk=Math.min(foundation.budget.chunk_bars,d.total_bars);
    must(exactKeys(r,RUN_KEYS)&&r.chunk_bars===chunk&&safeInt(r.resumed_from_bar,0,d.total_bars-1)&&
      r.chunks_executed===Math.ceil((d.total_bars-r.resumed_from_bar)/chunk));
    checkResult(env.result,{planHash,dataset:d});
    must(admissionOk(env.admission));
    const blockers=env.acceptance_blockers;
    must(Array.isArray(blockers)&&blockers.length<=16&&new Set(blockers).size===blockers.length&&
      blockers.every(item=>printable(item,1,128))&&REQUIRED_BLOCKERS.every(item=>blockers.includes(item)));
    must(canonical(env.limitations)===canonical(ENVELOPE_LIMITATIONS));
    const checked=validateHistoricalPreflightRequest(clean(plan,'PREFLIGHT_ENVELOPE_INVALID'));
    const {development:when,signal}=checked.snapshot;
    must(hash(canonical(checked))===planHash&&canonical(checked.foundation)===canonical(foundation)&&
      b.evaluator_hash===signal.evaluator_hash&&d.development_end_time===when.end_time&&
      d.holdout_start_time===when.holdout_start_time);
    return frozenV2(env);
  }catch{
    throw fail('PREFLIGHT_ENVELOPE_INVALID',500);
  }
}
