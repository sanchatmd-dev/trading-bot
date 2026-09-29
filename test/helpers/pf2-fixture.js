import {cp,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {capacityPolicyHash} from '../../src/quant-research/capacity-contract.js';
import {deriveClosedMetadataV2,streamClosedProfileRowsV2,verifyEnrollmentBindingV2} from '../../src/quant-research/data-profile-v2.js';
import {pf2ExecutableHashes,resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {reviewedInputs} from '../../src/pine-bridge/input-review.js';
import {canonical,hash,inspectSource} from '../../src/pine-bridge/source.js';
import {validateRisk} from '../../src/postgres/risk-policy-validation.js';

// Engineering fixture only: synthetic Pine source, synthetic bars, in-memory trusted sources.
export const MINUTE=60000;
export const START=Date.UTC(2024,0,1);
export const RAW_BARS=2600;
export const RAW_WARMUP=1600;
export const OWNER='owner-a';
export const BOT='fixture-bot';
export const DEPLOYMENT='deployment-fixture-0001';
export const PLAN_FIELD=Object.freeze({source:'source_hash',effective_inputs:'effective_inputs_hash',
  bridge:'bridge_hash',policy:'policy_hash',capital:'capital_hash',initial_state:'initial_state_hash',
  execution_model:'execution_model_hash',venue_metadata:'venue_metadata_hash'});
const sha=letter=>letter.repeat(64);
const clone=value=>structuredClone(value);
const KLINES='https://api.binance.com/api/v3/klines';

export const DEFAULT_RISK=Object.freeze({paperTrading:true,killSwitch:false,capPercentEquitySize:true,
  maxRiskPercent:100,maxOrderNotional:10000,maxDailyNotional:100000,maxTradesPerDay:10,maxDailyLossR:3,
  maxOpenPositions:3,onePositionPerSymbol:false,pauseAfterLossStreak:3,maxSignalAgeSeconds:60,
  maxVolatilityPercent:5,blockHighVolatility:true,blockDuringNews:true,sideMode:'BOTH',
  requireReduceOnlySell:true,allowedSymbols:[],equities:{},balances:{},
  defaults:{riskPercent:1,tradesPerDay:10,dailyLossR:3,lossStreak:3,openPositions:3,signalAgeSeconds:60,
    orderNotional:1000,dailyNotional:5000,volatilityPercent:5}});

/** Synthetic Pine v6 indicator with exactly 58 inputs (or a chosen count) and both signals. */
export function syntheticSource({count=58,slowType='int',slow=200}={}){
  const lines=['//@version=6','indicator("PF2 synthetic", overlay=true)',
    'emaFastInput = input.int(20, "EMA fast", minval=1, maxval=500)',
    slowType==='int'?`emaSlowInput = input.int(${slow}, "EMA slow", minval=1, maxval=1000)`:
      `emaSlowInput = input.float(${slow}, "EMA slow", minval=1, maxval=1000)`,
    'useSlowFilter = input.bool(true, "Slow filter")','labelText = input.string("abc", "Label")',
    'startTime = input.time(1704067200000, "Start")'];
  for(let index=1;lines.length-2<count;index++){
    const name='filler'+String(index).padStart(2,'0');
    lines.push(index%2?`${name} = input.int(${index}, "F${index}", minval=0, maxval=1000)`:
      `${name} = input.float(${index}.5, "F${index}", minval=0, maxval=1000, step=0.5)`);
  }
  lines.push('buySignal = ta.crossover(ta.ema(close, emaFastInput), ta.ema(close, emaSlowInput))',
    'sellSignal = ta.crossunder(ta.ema(close, emaFastInput), ta.ema(close, emaSlowInput))','plot(close)');
  return lines.join('\n');
}

/** Reviewed analysis exactly as production builds it (inspectSource + reviewedInputs). */
export function reviewedAnalysis(source){
  const analysis=inspectSource(source);
  const values=Object.fromEntries(analysis.inputs.map(input=>[input.input_id,
    input.type==='bool'?input.default==='true':input.type==='string'?JSON.parse(input.default):
    input.type==='time'?Number(input.default):input.default]));
  return reviewedInputs(analysis,values,{source_hash:analysis.source_hash,confirmed:true},'reviewer-1');
}

/** Independent statement of the plan hash preimages (contract section 1). */
export function planHash(kind,record){
  if(kind==='source')return hash(record);
  if(kind==='effective_inputs')return hash(canonical(Object.fromEntries(record.inputs.map(input=>[input.input_id,input.effective_value]))));
  return hash(canonical(record));
}

export const sealPlan=plan=>{plan.foundation.snapshot_hash=hash(canonical(plan.snapshot));return plan;};

export function policyRecord(variant='string'){
  return variant==='numeric'?clone(DEFAULT_RISK):
    validateRisk({maxOrderNotional:5000,maxDailyNotional:50000},clone(DEFAULT_RISK),clone(DEFAULT_RISK));
}

export const modelRecord=(form='number')=>form==='string'?
  {version:'paper-close-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'5',risk_percent:'1',data_profile:'closed-ohlcv-atr14-v1'}:
  {version:'paper-close-v1',price_tick:0.01,quantity_step:0.001,fee_bps:10,slippage_bps:5,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};

export function venueRecord(model,market={}){
  return {market:{deployment_id:DEPLOYMENT,pine_import_id:'pine-import-fixture-1',source_version:1,
    broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',...market},
  price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),data_profile:model.data_profile};
}

export function makeProvenance(raw,{counts=[1000,1000,600],retrievedAt=page=>page.end_time+1000}={}){
  let next=raw.start_time;
  const pages=counts.map((count,index)=>{
    const page={page:index,start_time:next,end_time:next+count*MINUTE,count,sha256:hash('page-'+index),
      retrieved_at:0,source:KLINES,timestamp_semantics:'UTC open time; end exclusive'};
    page.retrieved_at=retrievedAt(page);
    next=page.end_time;
    return page;
  });
  const range={version:'spot-ingestion-v1',evaluation_start:raw.start_time+raw.warmup_bars*MINUTE,
    evaluation_end:raw.end_time,evaluation_bars:(raw.end_time-raw.start_time)/MINUTE-raw.warmup_bars,
    warmup_bars:raw.warmup_bars,total_bars:raw.total_bars,page_count:pages.length,
    timestamp_semantics:'UTC open time; end exclusive',metadata:clone(raw)};
  return {range,pages};
}

export function deploymentSnapshot({policy,analysis,bridge,capital,market,sourceHash}){
  return {policy:clone(policy),policy_hash:hash(canonical(policy)),
    capital:[{userId:BOT,broker:market.broker,currency:'USDT',cash:capital.cash,positionCost:'0',bookEquity:capital.equity,
      configuredEquity:capital.equity,configuredBalance:capital.cash,valuation:'COST_BASIS_NOT_MARK_TO_MARKET'}],
    funding_cutoff:0,membership:[{pine_import_id:market.pine_import_id,source_version:market.source_version,
      source_hash:sourceHash,analysis:clone(analysis)}],session:{state:'RUNNING',run_id:null},captured_at:START,
    selection:{signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},bindings:[],
      bridge:{atr_multiplier:Number(bridge.atr_multiplier),rr:Number(bridge.rr)},fixed_inputs:clone(analysis.inputs)},
    market:clone(market),source_hash:sourceHash,instruction_versions:{prompt:'bridge-prompt-v3'},
    artifact_hash:hash('artifact')};
}

const rawMetadata=(total=RAW_BARS,warmup=RAW_WARMUP)=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
  symbol:'BTCUSDT',timeframe:'1',start_time:START,end_time:START+total*MINUTE,warmup_bars:warmup,total_bars:total,
  cutoff:START+total*MINUTE,source:'binance-spot-klines-v1'});
const bar=index=>({time:START+index*MINUTE,open:String(100+index%13),high:String(102+index%13),
  low:String(99+index%13),close:String(101+index%13),volume:'2'});
async function* bars(count){for(let index=0;index<count;index++)yield bar(index);}

const storesFor=root=>({root,rawStore:new DatasetStore({root}),
  researchStore:new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:true})});

/** Real raw, closed and ATR datasets on a temporary root. Shared by many worlds. */
export async function createPf2Base(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'pf2-resolver-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stores=storesFor(root);
  const model=modelRecord();
  const rawReference=await stores.rawStore.publish(rawMetadata(),bars(RAW_BARS),{chunkBars:1000});
  const derived=deriveClosedMetadataV2(rawReference);
  const researchReference=await stores.researchStore.publishStream(derived,
    streamClosedProfileRowsV2({rawReference,rawStore:stores.rawStore,model}),{model});
  const executables=await pf2ExecutableHashes();
  const base={...stores,rawReference,researchReference,executables,model,now:rawReference.metadata.end_time+MINUTE};

  /** Independent copy of the dataset root, for tests that flip bytes on disk. */
  base.cloneStores=async(cloneTest)=>{
    const copy=await mkdtemp(path.join(os.tmpdir(),'pf2-resolver-copy-'));
    cloneTest.after(()=>rm(copy,{recursive:true,force:true}));
    await cp(root,copy,{recursive:true});
    return storesFor(copy);
  };

  /** Enrollment contract + result over the shared datasets; overrides model, deployment, owner. */
  base.buildEnrollment=async({sourceHash,settingsHash,model:enrolledModel=model,venue,provenanceSha,snapshotHash,
    owner=OWNER,bot=BOT,deploymentId=venue.market.deployment_id,edit})=>{
    const scope={venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
      execution_model:'paper-close-v1',source_hash:sourceHash,settings_hash:settingsHash,evaluator_hash:sha('c')};
    const policy={version:'quant-capacity-v2',environment:'local',scope,
      evidence:{calibration_sha256:sha('d'),parity_sha256:sha('e')},max_raw_bars:50000,max_chunk_bars:1000,
      budget:{candidates:1,max_evaluations:1,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
      io:{read_bytes:100000000,write_bytes:100000000,overshoot_read_bytes:1000000,overshoot_write_bytes:1000000,
        cleanup_read_bytes:2000000,cleanup_write_bytes:2000000}};
    const raw=rawReference.metadata;
    const capacity={version:'quant-capacity-v2',environment:'local',policy_hash:capacityPolicyHash(policy),
      stage:'HISTORICAL_PREFLIGHT',scope:clone(scope),dataset:{raw_bars:raw.total_bars,seed_bars:500,
        warmup_bars:raw.warmup_bars,evaluation_bars:raw.total_bars-raw.warmup_bars,processed_bars:raw.total_bars-500},
      chunk_bars:Math.min(1000,raw.total_bars-500),budget:clone(policy.budget),io:clone(policy.io)};
    const profile={raw_job_id:'11111111-1111-4111-8111-111111111111',deployment_id:deploymentId,
      source_hash:sourceHash,effective_inputs_hash:settingsHash,execution_model:enrolledModel,
      metadata_hash:hash(canonical(venue)),raw_provenance_sha256:provenanceSha,seed_bars:500,snapshot_hash:snapshotHash};
    const contract={version:'quant-foundation-v2',owner_id:owner,bot_id:bot,kind:'PROFILE',dataset:clone(rawReference),
      engine_hash:sha('f'),snapshot_hash:snapshotHash,budget:{...capacity.budget,chunk_bars:capacity.chunk_bars},
      capacity,profile};
    const evidence={source_hash:sourceHash,effective_inputs_hash:settingsHash,evaluator_hash:sha('c'),
      execution_model_hash:hash(canonical(enrolledModel)),metadata_hash:profile.metadata_hash,
      raw_provenance_sha256:provenanceSha,seed_bars:500};
    const binding=await verifyEnrollmentBindingV2({rawReference,researchReference,evidence,
      rawStore:stores.rawStore,researchStore:stores.researchStore});
    const result={version:'research-profile-enrollment-v2',raw:clone(rawReference),references:clone(researchReference),
      binding:clone(binding),data_profile_verified:true,evaluator_admission:false,
      acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
    const enrollment={contract,result,capacity_policy:policy};
    edit?.(enrollment);
    return enrollment;
  };

  /** Complete consistent scenario; every edit below is applied before the hashes are computed. */
  base.scenario=async(edits={})=>{
    const source=edits.source??syntheticSource();
    const analysis=reviewedAnalysis(source);
    const records={source,effective_inputs:analysis,bridge:edits.bridge??{atr_multiplier:'2',rr:'1.5'},
      policy:edits.policy??policyRecord(),capital:edits.capital??{cash:'800',equity:'1000'},
      initial_state:edits.initial_state??{kind:'FRESH',loss_streak:0},execution_model:edits.model??modelRecord()};
    records.venue_metadata=venueRecord(records.execution_model,edits.market);
    const hashes=Object.fromEntries(Object.entries(PLAN_FIELD).map(([kind,field])=>[field,planHash(kind,records[kind])]));
    const snapshot=deploymentSnapshot({policy:records.policy,analysis,bridge:records.bridge,capital:records.capital,
      market:records.venue_metadata.market,sourceHash:hashes.source_hash});
    edits.snapshot?.(snapshot);
    const snapshotHash=hash(canonical(snapshot));
    const provenance=makeProvenance(rawReference.metadata,edits.provenanceOptions);
    edits.provenance?.(provenance);
    const provenanceSha=hash(canonical(provenance));
    const enrolledModel=edits.enrolledModel??records.execution_model;
    const enrollment=await base.buildEnrollment({sourceHash:hashes.source_hash,settingsHash:hashes.effective_inputs_hash,
      model:enrolledModel,venue:records.venue_metadata,provenanceSha,snapshotHash,...edits.enrollmentOptions,
      edit:edits.enrollment});
    const raw=rawReference.metadata;
    const plan={version:'historical-preflight-v1',foundation:{version:'quant-foundation-v1',owner_id:OWNER,bot_id:BOT,
      kind:'PREFLIGHT',dataset:clone(rawReference),engine_hash:executables.engine_hash,snapshot_hash:sha('0'),
      budget:{candidates:1,max_evaluations:1,chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:8*1024*1024,
        max_state_bytes:1024*1024}},
    snapshot:{version:'pf2-snapshot-v1',...hashes,execution_model_version:'paper-close-v1',
      signal:{mode:'EVALUATOR',evaluator_hash:executables.evaluator_hash,artifact_sha256:null},
      development:{start_time:raw.start_time,end_time:raw.end_time,holdout_start_time:raw.end_time}}};
    edits.plan?.(plan);
    sealPlan(plan);
    return {plan,records,snapshot,snapshotHash,provenance,provenanceSha,enrollment,source,
      supportedSourceHash:hashes.source_hash,now:edits.now??base.now};
  };
  base.defaultScenario=await base.scenario();
  return base;
}

const ALLOWED_STORE_PROPS=new Set(['inspect','read','readV2','inspectSidecarV2','raw']);

/**
 * Fresh, mutable trusted world over a shared scenario. Every trusted call is logged in
 * `calls`; every dataset call in `reads`. Stores are Proxies that throw on any property
 * outside the read-only allowlist (publish, publishStream, write*, set*, delete*...).
 */
export function makeWorld(base,scenario=base.defaultScenario,{stores=base}={}){
  const key=(...parts)=>parts.join('|');
  const world={base,scenario,plan:clone(scenario.plan),records:new Map(),enrollments:new Map(),
    provenances:new Map(),holdout:{value:scenario.plan.snapshot.development.holdout_start_time},
    authorized:new Set([key(OWNER,BOT)]),throwOn:new Map(),calls:[],reads:[],hooks:{},key,
    now:scenario.now,supportedSourceHash:scenario.supportedSourceHash};
  for(const kind of Object.keys(PLAN_FIELD)){
    const value=scenario.records[kind];
    world.records.set(key(OWNER,BOT,kind,planHash(kind,value)),kind==='source'?value:clone(value));
  }
  world.records.set(key(OWNER,BOT,'deployment_snapshot',scenario.snapshotHash),clone(scenario.snapshot));
  world.enrollments.set(key(OWNER,BOT,base.rawReference.sha256),clone(scenario.enrollment));
  world.provenances.set(key(OWNER,BOT,scenario.provenanceSha),clone(scenario.provenance));

  const wrapGenerator=(target,method,name)=>async function*(reference,options={}){
    const entry={api:`${name}.${method}`,sha:reference?.sha256??reference?.raw?.sha256,start:options.start??0,
      end:options.end,rows:0,maxTime:0,returned:false,signal:options.signal};
    world.reads.push(entry);
    try{
      for await(const row of target[method](reference,options)){
        entry.rows++;entry.maxTime=Math.max(entry.maxTime,row.time);
        world.hooks.row?.(entry,row);
        yield row;
      }
    }finally{entry.returned=true;}
  };
  const spy=(store,name)=>new Proxy(store,{get(target,prop){
    if(typeof prop==='symbol')return Reflect.get(target,prop,target);
    if(!ALLOWED_STORE_PROPS.has(prop)){world.calls.push({api:name+'.DENIED',prop});throw new Error('STORE_ACCESS_DENIED:'+prop);}
    if(prop==='raw')return spy(target.raw,name+'.raw');
    if(prop==='read'||prop==='readV2')return wrapGenerator(target,prop,name);
    return async(reference,options)=>{
      world.reads.push({api:`${name}.${prop}`,sha:reference?.sha256??reference?.raw?.sha256,signal:options?.signal});
      return target[prop](reference,options);
    };
  }});

  world.trusted={
    authorize:async(scope,options)=>{
      world.calls.push({api:'authorize',scope:clone(scope),signal:options?.signal});
      if(world.throwOn.has('authorize'))throw world.throwOn.get('authorize');
      return world.authorized.has(key(scope.owner_id,scope.bot_id));
    },
    records:{get:async(kind,sha,context)=>{
      world.calls.push({api:'records.get',kind,sha,signal:context.signal});
      world.hooks.recordGet?.(kind,context);
      if(world.throwOn.has(kind))throw world.throwOn.get(kind);
      return world.records.get(key(context.owner_id,context.bot_id,kind,sha))??null;
    }},
    enrollment:{find:async(query,options)=>{
      world.calls.push({api:'enrollment.find',query:clone(query),signal:options?.signal});
      if(world.throwOn.has('enrollment'))throw world.throwOn.get('enrollment');
      return world.enrollments.get(key(query.owner_id,query.bot_id,query.raw_dataset_sha256))??null;
    }},
    provenance:{get:async(sha,context)=>{
      world.calls.push({api:'provenance.get',sha,signal:context.signal});
      if(world.throwOn.has('provenance'))throw world.throwOn.get('provenance');
      return world.provenances.get(key(context.owner_id,context.bot_id,sha))??null;
    }},
    holdout:new Proxy({boundary:async(query,options)=>{
      world.calls.push({api:'holdout.boundary',query:clone(query),signal:options?.signal});
      if(world.throwOn.has('holdout'))throw world.throwOn.get('holdout');
      if(world.holdout.respond)return world.holdout.respond(query);
      return world.holdout.value===null?null:{holdout_start_time:world.holdout.value};
    }},{get(target,prop){
      if(prop!=='boundary'){world.calls.push({api:'holdout.DENIED',prop:String(prop)});throw new Error('HOLDOUT_ACCESS_DENIED');}
      return target.boundary;
    }}),
    datasets:{raw:spy(stores.rawStore,'raw'),research:spy(stores.researchStore,'research')}};

  world.resolve=(extra={})=>resolveHistoricalPreflight(world.plan,world.trusted,
    {now:world.now,supportedSourceHash:world.supportedSourceHash,...extra});
  /** Store a record under its true hash and point the plan at it (then reseal the plan). */
  world.reseal=(kind,record)=>{
    const sha256=planHash(kind,record);
    world.records.set(key(OWNER,BOT,kind,sha256),record);
    world.plan.snapshot[PLAN_FIELD[kind]]=sha256;
    sealPlan(world.plan);
    return sha256;
  };
  world.seal=()=>sealPlan(world.plan);
  world.callNames=()=>world.calls.map(call=>call.api);
  world.recordKinds=()=>world.calls.filter(call=>call.api==='records.get').map(call=>call.kind);
  return world;
}

export function isDeepFrozen(value){
  if(value===null||typeof value!=='object')return true;
  return Object.isFrozen(value)&&Object.values(value).every(isDeepFrozen);
}
