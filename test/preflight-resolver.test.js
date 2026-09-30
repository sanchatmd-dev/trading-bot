import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {getEventListeners} from 'node:events';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {delimiter,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {historicalPreflightHash} from '../src/quant-research/preflight-contract.js';
import {SOURCE_HASH} from '../src/quant-research/contract.js';
import {PF2_ENGINE_FILES,PF2_EVALUATOR_FILES,PF2_LIMITATIONS,PF2_RECORD_KINDS,PF2_RESOLVED_VERSION,
  PF2_RESOLVER_ERRORS,pf2ExecutableHashes,resolveHistoricalPreflight} from '../src/quant-research/preflight-resolver.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {SHARED_APPLICATION_FILES} from './helpers/runtime-shared-boundary.js';
import {DEPLOYMENT,MINUTE,OWNER,BOT,PLAN_FIELD,START,RAW_BARS,createPf2Base,isDeepFrozen,makeWorld,modelRecord,
  planHash,policyRecord,syntheticSource} from './helpers/pf2-fixture.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MARKER=String.raw`C:\secret-location\marker-4242`;
const TMP=os.tmpdir();
const sha=letter=>letter.repeat(64);
const clone=value=>structuredClone(value);
const ALLOWED_CODES=new Set([...PF2_RESOLVER_ERRORS,'INVALID_PREFLIGHT_CONTRACT',
  'PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED','PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED']);

/** Error hygiene applied to every rejection: known code, message===code, no cause, no extra keys. */
function hygiene(error){
  assert.ok(ALLOWED_CODES.has(error.code),'unexpected code '+error.code);
  assert.equal(error.message,error.code);
  assert.equal('cause' in error,false);
  assert.ok(Object.keys(error).every(name=>['code','status'].includes(name)),Object.keys(error).join());
  const text=[error.message,error.stack,...Object.keys(error).map(name=>String(error[name]))].join('\n');
  assert.equal(text.includes(MARKER),false);
  assert.equal(text.includes(TMP),false);
  return true;
}
const rejectsWith=(promise,code)=>assert.rejects(promise,error=>{hygiene(error);assert.equal(error.code,code);return true;});
const keyOf=(world,kind)=>kind==='deployment_snapshot'?world.key(OWNER,BOT,kind,world.scenario.snapshotHash):
  world.key(OWNER,BOT,kind,world.plan.snapshot[PLAN_FIELD[kind]]);
const craftedError=code=>Object.assign(new Error(code),{code,status:400,leak:MARKER,cause:new Error(MARKER)});
const settled=(promise,ms=3000)=>Promise.race([promise.then(()=>'RESOLVED',error=>error),
  new Promise(done=>setTimeout(()=>done('HUNG'),ms))]);
const stuck=()=>new Promise(()=>{});
function watchUnhandled(){
  const seen=[],listener=reason=>seen.push(reason);
  process.on('unhandledRejection',listener);
  return {seen,stop:()=>process.off('unhandledRejection',listener)};
}
/** A dispatch that throws inside the caller's own dispatch surfaces as an uncaughtException. */
function watchUncaught(){
  const seen=[],listener=error=>seen.push(error);
  process.on('uncaughtException',listener);
  return {seen,stop:()=>process.off('uncaughtException',listener)};
}
/** What a hostile adapter can do to a signal it received: shadow `aborted` on the object. */
const shadowThrowing=(signal,thrown)=>Object.defineProperty(signal,'aborted',{configurable:true,get(){throw thrown;}});
const shadowValue=(signal,value)=>Object.defineProperty(signal,'aborted',{configurable:true,value});
const digestFile=async file=>createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
const isCrossCanonical=value=>{
  if(typeof value==='string')return /^[\x20-\x7e]*$/.test(value);
  if(typeof value==='number')return Number.isSafeInteger(value)&&!Object.is(value,-0);
  if(typeof value==='boolean')return true;
  if(Array.isArray(value))return value.every(isCrossCanonical);
  if(value&&typeof value==='object')return Object.entries(value).every(([key,item])=>isCrossCanonical(key)&&isCrossCanonical(item));
  return false;
};
const fakeDataset=(metadata={},id=sha('a'))=>({dataset_id:id,sha256:id,metadata:{version:'spot-dataset-v1',venue:'binance-global',
  market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:START,end_time:START+RAW_BARS*MINUTE,warmup_bars:1600,
  total_bars:RAW_BARS,cutoff:START+RAW_BARS*MINUTE,source:'binance-spot-klines-v1',...metadata}});

const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
// Only an absolute interpreter is spawned: a bare name can resolve through an installer alias that
// downloads a runtime. A non-absolute QUANT_RESEARCH_PYTHON means no interpreter.
const configuredPython=process.env.QUANT_RESEARCH_PYTHON;
const python=configuredPython?(path.isAbsolute(configuredPython)?configuredPython:null):
  (existsSync(localPython)?localPython:null);

test('PF-2 S3 trusted resolver',async t=>{
  const base=await createPf2Base(t);
  const raw=base.rawReference.metadata;
  const world=(scenario,options)=>makeWorld(base,scenario,options);
  const resolvedVariants=[];

  await t.test('happy path: frozen, detached, mapped, deterministic',async()=>{
    const w=world();
    const out=await w.resolve();
    assert.equal(out.version,PF2_RESOLVED_VERSION);
    assert.equal(out.plan_hash,historicalPreflightHash(w.plan));
    assert.equal(out.owner_id,OWNER);assert.equal(out.bot_id,BOT);
    assert.ok(isDeepFrozen(out));
    assert.deepEqual(w.callNames(),['authorize','holdout.boundary',...Array(8).fill('records.get'),'enrollment.find',
      'records.get','provenance.get']);
    assert.deepEqual(w.recordKinds(),[...PF2_RECORD_KINDS]);
    const c=out.contract,rec=w.scenario.records;
    resolvedVariants.push(['default',c]);
    assert.equal(c.version,'pf2-replay-job-v1');assert.equal(c.plan_hash,out.plan_hash);assert.equal(c.deployment_id,DEPLOYMENT);
    assert.equal(c.signal.mode,'EVALUATOR');assert.equal(c.signal.profile,'SPT_CUSTOM');assert.equal(c.signal.source,w.scenario.source);
    assert.deepEqual(c.signal.snapshot.market,{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
    assert.equal(c.signal.snapshot.source_hash,w.plan.snapshot.source_hash);
    assert.deepEqual(c.signal.snapshot.selection.signals,{buy:'buySignal',exit:'sellSignal',timing:'bar_close'});
    assert.deepEqual(c.signal.snapshot.selection.bindings,[]);
    assert.equal(c.signal.snapshot.selection.fixed_inputs.length,58);
    assert.deepEqual(c.signal.snapshot.selection.fixed_inputs,rec.effective_inputs.inputs);
    assert.deepEqual(c.signal.snapshot.membership,[{source_hash:w.plan.snapshot.source_hash,analysis:rec.effective_inputs}]);
    assert.deepEqual(c.bridge,{atr_multiplier:'2',rr:'1.5'});
    assert.deepEqual(c.model,{price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'5',risk_percent:'1',version:'paper-close-v1'});
    assert.deepEqual(Object.keys(c.policy).sort(),['allowedSymbols','blockDuringNews','blockHighVolatility','capPercentEquitySize',
      'killSwitch','maxDailyLossR','maxDailyNotional','maxOpenPositions','maxOrderNotional','maxRiskPercent','maxSignalAgeSeconds',
      'maxTradesPerDay','maxVolatilityPercent','onePositionPerSymbol','pauseAfterLossStreak','sideMode']);
    for(const name of Object.keys(c.policy))assert.deepEqual(c.policy[name],rec.policy[name]);
    assert.deepEqual(c.capital,{cash:'800',equity:'1000'});
    assert.deepEqual(c.initial_state,{kind:'FRESH',loss_streak:0});
    assert.equal(c.broker,'binance-global');assert.equal(c.symbol,'BTCUSDT');
    assert.deepEqual(c.dataset,{first_time:START+501*MINUTE,total_bars:2100,warmup_bars:1100,
      development_end_time:raw.end_time,holdout_start_time:raw.end_time});
    assert.deepEqual(c.limits,{max_bars:10000,max_state_bytes:1048576,max_output_bytes:8388608,max_samples:200});
    assert.deepEqual(out.budget,{chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576});
    assert.equal(out.dataset.evaluation_start_time,START+501*MINUTE+1100*MINUTE);
    assert.equal(out.dataset.last_time,raw.end_time);
    assert.equal(out.dataset.development_start_time,raw.start_time);
    assert.deepEqual(out.dataset.raw,base.rawReference);
    assert.deepEqual(out.dataset.research,base.researchReference);
    const enrollment=w.scenario.enrollment;
    assert.deepEqual(out.identities,{engine_hash:base.executables.engine_hash,evaluator_hash:base.executables.evaluator_hash,
      source_hash:w.plan.snapshot.source_hash,effective_inputs_hash:w.plan.snapshot.effective_inputs_hash,
      bridge_hash:w.plan.snapshot.bridge_hash,policy_hash:w.plan.snapshot.policy_hash,capital_hash:w.plan.snapshot.capital_hash,
      initial_state_hash:w.plan.snapshot.initial_state_hash,execution_model_hash:w.plan.snapshot.execution_model_hash,
      venue_metadata_hash:w.plan.snapshot.venue_metadata_hash,raw_dataset_sha256:base.rawReference.sha256,
      closed_dataset_sha256:base.researchReference.raw.sha256,atr14_sha256:base.researchReference.sidecar.sha256,
      enrollment_binding_sha256:enrollment.result.binding.binding_sha256,raw_provenance_sha256:w.scenario.provenanceSha,
      enrollment_evaluator_hash:enrollment.result.binding.evidence.evaluator_hash});
    assert.deepEqual(out.admission,{development_only:true,evaluator_admission:false,holdout_accessed:false,
      orders_executed:false,execution_model_parity:'V1_ONLY'});
    assert.deepEqual(out.acceptance_blockers,enrollment.result.acceptance_blockers);
    assert.deepEqual(out.limitations,['DEVELOPMENT_ONLY','EXECUTION_MODEL_V1_ONLY','EVALUATOR_ADMISSION_FALSE',
      'INITIAL_STATE_FRESH_ONLY','BOUND_SIGNAL_CSV_UNSUPPORTED','TRUSTED_SOURCES_INJECTED','HOLDOUT_REGISTRY_INJECTED',
      'CAPTURE_TIME_ARITHMETIC_ONLY','EXECUTABLE_IDENTITY_LOCAL_FILES_ONLY','EVALUATOR_SETTINGS_CHECKED_BY_REPLAY',
      'ENROLLMENT_EVALUATOR_IDENTITY_NOT_BOUND','NO_SCHEDULER_ADMISSION']);
    assert.deepEqual(out.limitations,[...PF2_LIMITATIONS]);
    for(const part of [c.bridge,c.capital,c.initial_state,c.model,c.dataset,c.limits,c.plan_hash,c.deployment_id,c.broker,c.symbol])
      assert.ok(isCrossCanonical(part),canonical(part));
    // Detached: mutate every trusted source and the plan after the fact.
    const before=canonical(out);
    for(const value of w.records.values())if(value&&typeof value==='object')value.injected=true;
    for(const value of w.enrollments.values())value.result.acceptance_blockers.push('MUTATED');
    for(const value of w.provenances.values())value.pages[0].count=1;
    w.plan.snapshot.development.end_time=1;
    assert.equal(canonical(out),before);
    assert.throws(()=>{out.contract.bridge.rr='9';},TypeError);
    assert.throws(()=>{out.limitations.push('X');},TypeError);
    const again=await world().resolve();
    assert.equal(canonical(again),before);
  });

  await t.test('formula proof: executable and record hashes from first principles',async()=>{
    const digests={};
    for(const file of PF2_ENGINE_FILES)digests[file]=await digestFile(file);
    const aggregate=files=>createHash('sha256').update(canonical(Object.fromEntries(files.map(file=>[file,digests[file]])))).digest('hex');
    const hashes=await pf2ExecutableHashes();
    assert.equal(hashes.engine_hash,aggregate(PF2_ENGINE_FILES));
    assert.equal(hashes.evaluator_hash,aggregate(PF2_EVALUATOR_FILES));
    assert.notEqual(hashes.engine_hash,hashes.evaluator_hash);
    const w=world(),rec=w.scenario.records,plan=w.plan.snapshot;
    const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
    assert.equal(plan.source_hash,sha256(rec.source));
    assert.equal(plan.effective_inputs_hash,sha256(canonical(Object.fromEntries(
      rec.effective_inputs.inputs.map(input=>[input.input_id,input.effective_value])))));
    for(const [kind,field] of Object.entries(PLAN_FIELD)){
      if(['source','effective_inputs'].includes(kind))continue;
      assert.equal(plan[field],sha256(canonical(rec[kind])),kind);
    }
    assert.equal(w.scenario.enrollment.result.binding.evidence.execution_model_hash,plan.execution_model_hash);
    assert.equal(w.scenario.enrollment.contract.profile.metadata_hash,plan.venue_metadata_hash);
    assert.equal(w.scenario.snapshotHash,sha256(canonical(w.scenario.snapshot)));
    // The fixture shortcut keyed by pine_variable is NOT the production formula.
    const shortcut=Object.fromEntries(rec.effective_inputs.inputs.map(input=>[input.pine_variable,input.effective_value]));
    const bad=world();
    bad.plan.snapshot.effective_inputs_hash=sha256(canonical(shortcut));bad.seal();
    bad.records.set(keyOf(bad,'effective_inputs'),clone(rec.effective_inputs));
    await rejectsWith(bad.resolve(),'PF2_INPUT_HASH_MISMATCH');
  });

  const tamper={
    source:value=>value+'\n',
    effective_inputs:value=>{const copy=clone(value);copy.inputs[0].effective_value=21;return copy;},
    bridge:value=>({...value,rr:'1.6'}),
    policy:value=>({...value,maxDailyLossR:4}),
    capital:value=>({...value,cash:'801'}),
    initial_state:value=>({...value,loss_streak:1}),
    execution_model:value=>({...value,fee_bps:11}),
    venue_metadata:value=>({...value,market:{...value.market,pine_import_id:'pine-import-other'}}),
    deployment_snapshot:value=>({...value,captured_at:value.captured_at+1})};
  for(const kind of PF2_RECORD_KINDS){
    await t.test(`record kind ${kind}: missing, foreign, throwing and tampered`,async()=>{
      const later=kind==='deployment_snapshot'?[]:['enrollment.find','provenance.get'];
      let w=world();
      w.records.delete(keyOf(w,kind));
      await rejectsWith(w.resolve(),'PF2_INPUT_UNRESOLVED');
      assert.equal(w.callNames().filter(name=>later.includes(name)).length,0);
      // A record owned by another owner is indistinguishable from a missing one.
      w=world();
      const key=keyOf(w,kind),value=w.records.get(key);
      w.records.delete(key);w.records.set(key.replace(OWNER+'|','owner-b|'),value);
      await rejectsWith(w.resolve(),'PF2_INPUT_UNRESOLVED');
      // A throwing source must not leak its message, path or stack.
      w=world();
      w.throwOn.set(kind,new Error(MARKER));
      await assert.rejects(w.resolve(),error=>{hygiene(error);assert.equal(error.code,'PF2_INPUT_UNRESOLVED');return true;});
      // One field altered, plan unchanged.
      w=world();
      w.records.set(keyOf(w,kind),tamper[kind](w.records.get(keyOf(w,kind))));
      await rejectsWith(w.resolve(),'PF2_INPUT_HASH_MISMATCH');
      assert.equal(w.callNames().filter(name=>later.includes(name)).length,0);
    });
  }

  const INVALID='PF2_INPUT_INVALID',UNSUPPORTED='PF2_INITIAL_STATE_UNSUPPORTED';
  const PARITY='PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED';
  const withInput=(index,change)=>record=>{change(record.inputs[index]);return record;};
  const drop=name=>record=>{delete record[name];return record;};
  const cases=[
    ['bridge','rr not canonical',r=>({...r,rr:'1.50'}),INVALID],
    ['bridge','atr_multiplier zero',r=>({...r,atr_multiplier:'0'}),INVALID],
    ['bridge','rr as number',r=>({...r,rr:1.5}),INVALID],
    ['bridge','atr_multiplier above 1000',r=>({...r,atr_multiplier:'1001'}),INVALID],
    ['bridge','extra key',r=>({...r,extra:'1'}),INVALID],
    ['capital','cash zero',r=>({...r,cash:'0'}),INVALID],
    ['capital','equity as number',r=>({...r,equity:1000}),INVALID],
    ['capital','cash leading zero',r=>({...r,cash:'0800'}),INVALID],
    ['initial_state','kind CARRY',r=>({...r,kind:'CARRY'}),UNSUPPORTED],
    ['initial_state','extra key',r=>({...r,open_position:{}}),UNSUPPORTED],
    ['initial_state','missing loss_streak',r=>({kind:r.kind}),UNSUPPORTED],
    ['initial_state','loss_streak 1 is not fresh',r=>({...r,loss_streak:1}),UNSUPPORTED],
    ['initial_state','loss_streak at ceiling is not fresh',r=>({...r,loss_streak:1_000_000}),UNSUPPORTED],
    ['initial_state','negative loss_streak',r=>({...r,loss_streak:-1}),INVALID],
    ['initial_state','loss_streak as text',r=>({...r,loss_streak:'0'}),INVALID],
    ['initial_state','fractional loss_streak',r=>({...r,loss_streak:1.5}),INVALID],
    ['initial_state','loss_streak above ceiling',r=>({...r,loss_streak:1_000_001}),INVALID],
    ['policy','paperTrading false',r=>({...r,paperTrading:false}),INVALID],
    ['policy','requireReduceOnlySell false',r=>({...r,requireReduceOnlySell:false}),INVALID],
    ['policy','missing maxTradesPerDay',drop('maxTradesPerDay'),INVALID],
    ['policy','maxDailyLossR string',r=>({...r,maxDailyLossR:'3'}),INVALID],
    ['policy','maxRiskPercent string',r=>({...r,maxRiskPercent:'100'}),INVALID],
    ['policy','notional not exact',r=>({...r,maxOrderNotional:'10.50'}),INVALID],
    ['policy','notional exponent text',r=>({...r,maxOrderNotional:'1e3'}),INVALID],
    ['policy','negative notional',r=>({...r,maxDailyNotional:-1}),INVALID],
    ['policy','killSwitch string',r=>({...r,killSwitch:'false'}),INVALID],
    ['policy','bad sideMode',r=>({...r,sideMode:'X'}),INVALID],
    ['policy','non ASCII symbol',r=>({...r,allowedSymbols:['\u00e9']}),INVALID],
    ['policy','volatility above ceiling',r=>({...r,maxVolatilityPercent:1e13}),INVALID],
    ['policy','fractional trade limit',r=>({...r,maxTradesPerDay:1.5}),INVALID],
    ['execution_model','cost-v2 record under V1 plan',r=>({...r,version:'paper-close-cost-v2'}),PARITY],
    ['execution_model','unknown version',r=>({...r,version:'unknown'}),PARITY],
    ['execution_model','other data_profile',r=>({...r,data_profile:'raw-ohlcv'}),INVALID],
    ['execution_model','fee above 1000',r=>({...r,fee_bps:1001}),INVALID],
    ['execution_model','negative slippage',r=>({...r,slippage_bps:-1}),INVALID],
    ['execution_model','zero price_tick',r=>({...r,price_tick:0}),INVALID],
    ['execution_model','risk above 100',r=>({...r,risk_percent:101}),INVALID],
    ['execution_model','non numeric text',r=>({...r,price_tick:'abc'}),INVALID],
    ['execution_model','scale above 18',r=>({...r,quantity_step:1e-19}),INVALID],
    ['execution_model','extra key',r=>({...r,extra:1}),INVALID]];
  cases.push(
    ['venue_metadata','other symbol',r=>({...r,market:{...r.market,symbol:'ETHUSDT'}}),INVALID],
    ['venue_metadata','other broker',r=>({...r,market:{...r.market,broker:'binance-th'}}),INVALID],
    ['venue_metadata','other timeframe',r=>({...r,market:{...r.market,timeframe:'5'}}),INVALID],
    ['venue_metadata','tick differs from model',r=>({...r,price_tick:'0.02'}),INVALID],
    ['venue_metadata','tick as number',r=>({...r,price_tick:0.01}),INVALID],
    ['venue_metadata','short deployment id',r=>({...r,market:{...r.market,deployment_id:'short'}}),INVALID],
    ['venue_metadata','source_version zero',r=>({...r,market:{...r.market,source_version:0}}),INVALID],
    ['venue_metadata','extra market key',r=>({...r,market:{...r.market,extra:1}}),INVALID],
    ['venue_metadata','data_profile differs',r=>({...r,data_profile:'other'}),INVALID],
    ['effective_inputs','pine_variable swapped, hash unchanged',r=>{
      const [a,b]=[r.inputs[0].pine_variable,r.inputs[1].pine_variable];
      r.inputs[0].pine_variable=b;r.inputs[1].pine_variable=a;return r;},INVALID],
    ['effective_inputs','review hash differs',r=>{r.effective_input_review.effective_inputs_hash=sha('9');return r;},INVALID],
    ['effective_inputs','review input_count 57',r=>{r.effective_input_review.input_count=57;return r;},INVALID],
    ['effective_inputs','analysis hash differs',r=>{r.effective_inputs_hash=sha('9');return r;},INVALID],
    ['effective_inputs','analysis source_hash differs',r=>{r.source_hash=sha('9');return r;},INVALID],
    ['effective_inputs','reviewed_by empty',r=>{r.effective_input_review.reviewed_by='';return r;},INVALID],
    ['effective_inputs','reviewed_at zero',r=>{r.effective_input_review.reviewed_at=0;return r;},INVALID],
    ['effective_inputs','declared_domain changed',withInput(0,i=>{i.declared_domain.max=999;}),INVALID],
    ['effective_inputs','type changed',withInput(0,i=>{i.type='float';}),INVALID],
    ['effective_inputs','default changed',withInput(0,i=>{i.default=99;}),INVALID],
    ['effective_inputs','title changed',withInput(0,i=>{i.input_title='other';}),INVALID],
    ['effective_inputs','extra input field',withInput(0,i=>{i.extra=1;}),INVALID],
    ['effective_inputs','duplicate input_id',withInput(1,i=>{i.input_id='dup';}),INVALID],
    ['effective_inputs','fractional int value',withInput(0,i=>{i.effective_value=20.5;}),INVALID],
    ['effective_inputs','value above declared max',withInput(0,i=>{i.effective_value=501;}),INVALID],
    ['effective_inputs','bool as text',withInput(4,i=>{i.effective_value='true';}),INVALID],
    ['effective_inputs','string value too long',withInput(5,i=>{i.effective_value='x'.repeat(2001);}),INVALID],
    ['effective_inputs','time fractional',withInput(6,i=>{i.effective_value=1.5;}),INVALID],
    ['effective_inputs','57 inputs',r=>{r.inputs.pop();return r;},INVALID],
    ['effective_inputs','accessor property',r=>{Object.defineProperty(r,'note',{enumerable:true,get:()=>1});return r;},INVALID]);
  await t.test('resealed invalid shapes fail closed with one code',async()=>{
    const seen=new Set(cases.map(([kind])=>kind));
    for(const kind of Object.keys(PLAN_FIELD))if(kind!=='source')assert.ok(seen.has(kind),kind);
    for(const [kind,name,mutate,code] of cases){
      const w=world();
      w.reseal(kind,mutate(clone(w.scenario.records[kind])));
      await assert.rejects(w.resolve(),error=>{hygiene(error);assert.equal(error.code,code,`${kind}: ${name}`);return true;});
      assert.equal(w.callNames().includes('enrollment.find'),false,`${kind}: ${name}`);
    }
  });

  await t.test('source record: variants, bounds, lone surrogate, inputs count, emaSlowInput',async()=>{
    // 57 inputs (resealed plan plus matching supportedSourceHash) is not the supported evaluator input set.
    let w=world(await base.scenario({source:syntheticSource({count:57})}));
    await rejectsWith(w.resolve(),'PF2_EVALUATOR_UNAVAILABLE');
    // Lone surrogate: the UTF-8 bytes would differ between languages, so refuse before hashing.
    w=world(await base.scenario({source:syntheticSource()+'\n// \ud800'}));
    await rejectsWith(w.resolve(),INVALID);
    for(const value of ['',{a:1},'x'.repeat(256*1024+1),7]){
      w=world();
      w.records.set(keyOf(w,'source'),value);
      await rejectsWith(w.resolve(),INVALID);
    }
    // emaSlowInput must be an integer (float type with a fractional value passes the domain check only).
    w=world(await base.scenario({source:syntheticSource({slowType:'float',slow:200.5})}));
    await rejectsWith(w.resolve(),INVALID);
  });

  await t.test('plan-level gates fail before any trusted call or file read',async()=>{
    let reads=0;
    const readFileSpy=async url=>{reads++;return readFile(url);};
    const silent=async(w,code,extra={})=>{
      await rejectsWith(w.resolve({readFile:readFileSpy,...extra}),code);
      assert.equal(w.calls.length,0);assert.equal(reads,0);
    };
    let w=world();
    w.plan.snapshot.signal={mode:'BOUND_SIGNAL_CSV',evaluator_hash:w.plan.snapshot.signal.evaluator_hash,artifact_sha256:sha('7')};w.seal();
    await silent(w,'PF2_UNSUPPORTED_SIGNAL_MODE');
    await silent(world(),'PF2_EVALUATOR_UNAVAILABLE',{supportedSourceHash:sha('9')});
    w=world();
    await silent(w,'PF2_EVALUATOR_UNAVAILABLE',{supportedSourceHash:undefined});
    w=world();w.plan.foundation.engine_hash=w.plan.snapshot.signal.evaluator_hash;
    await silent(w,'PF2_ENGINE_HASH_MISMATCH');
    for(const field of ['max_state_bytes','max_output_bytes']){
      w=world();w.plan.foundation.budget[field]=1000;
      await silent(w,'PF2_BUDGET_UNSUPPORTED');
    }
    w=world();w.plan.extra=1;
    await silent(w,'INVALID_PREFLIGHT_CONTRACT');
    w=world();w.plan.snapshot.execution_model_version='paper-close-cost-v2';w.seal();
    await silent(w,PARITY);
    // O7: plan times above the S1 ceiling (year 9999) are refused early.
    w=world();w.plan.snapshot.development.holdout_start_time=253402300800000;w.seal();
    await silent(w,'INVALID_PREFLIGHT_CONTRACT');
    // A plan with an accessor is not plain data.
    w=world();
    const foundation=w.plan.foundation;
    delete w.plan.foundation;
    Object.defineProperty(w.plan,'foundation',{enumerable:true,get:()=>foundation});
    await silent(w,'INVALID_PREFLIGHT_CONTRACT');
    // Default supported hash is the frozen SPT source hash (contract.js == evaluator text).
    const text=await readFile(path.join(root,'quant_lab/src/robot_quant/spt_evaluator.py'),'utf8');
    assert.equal(text.match(/^SOURCE_HASH = "([a-f0-9]{64})"/m)[1],SOURCE_HASH);
    w=world();w.plan.snapshot.source_hash=SOURCE_HASH;w.seal();
    await rejectsWith(resolveHistoricalPreflight(w.plan,w.trusted,{now:w.now}),'PF2_INPUT_UNRESOLVED');
    assert.equal(w.callNames()[0],'authorize');
  });

  await t.test('resolver configuration is validated before any call',async()=>{
    const w=world();
    const options={now:w.now,supportedSourceHash:w.supportedSourceHash};
    const bad=[{...options,now:undefined},{...options,now:0},{...options,now:1.5},{...options,now:'5'},
      {...options,readFile:'x'},{...options,supportedSourceHash:'abc'},{...options,signal:{aborted:'no'}},{...options,signal:null}];
    for(const option of bad)await rejectsWith(resolveHistoricalPreflight(w.plan,w.trusted,option),'PF2_RESOLVER_CONFIG_INVALID');
    const trusted=w.trusted;
    for(const broken of [{...trusted,authorize:undefined},{...trusted,records:{}},{...trusted,datasets:undefined},
      {...trusted,datasets:{raw:trusted.datasets.raw}},{...trusted,enrollment:null},{}]){
      await rejectsWith(resolveHistoricalPreflight(w.plan,broken,options),'PF2_RESOLVER_CONFIG_INVALID');
    }
    await rejectsWith(resolveHistoricalPreflight(w.plan,undefined,options),'PF2_RESOLVER_CONFIG_INVALID');
    assert.equal(w.calls.length,0);
  });

  await t.test('executable identity: layers, tamper, unreadable files, one read per file',async()=>{
    const patch=needle=>async url=>{
      const bytes=await readFile(url);
      return String(url).endsWith(needle)?Buffer.concat([bytes,Buffer.from('\n#tampered')]):bytes;
    };
    let w=world();w.plan.snapshot.signal.evaluator_hash=sha('9');w.seal();
    await rejectsWith(w.resolve(),'PF2_EVALUATOR_HASH_MISMATCH');
    assert.deepEqual(w.callNames(),['authorize','holdout.boundary']);
    w=world();w.plan.foundation.engine_hash=sha('9');
    await rejectsWith(w.resolve(),'PF2_ENGINE_HASH_MISMATCH');
    for(const [file,code] of [['quant_lab/src/robot_quant/pf2_replay.py','PF2_ENGINE_HASH_MISMATCH'],
      ['src/quant-research/preflight-resolver.js','PF2_ENGINE_HASH_MISMATCH'],
      ['quant_lab/src/robot_quant/spt_evaluator.py','PF2_EVALUATOR_HASH_MISMATCH'],
      ['quant_lab/src/robot_quant/__init__.py','PF2_EVALUATOR_HASH_MISMATCH']]){
      w=world();
      await rejectsWith(w.resolve({readFile:patch(file)}),code);
      assert.equal(w.recordKinds().length,0);
    }
    w=world();
    await rejectsWith(w.resolve({readFile:async()=>{throw new Error(MARKER);}}),'PF2_ENGINE_HASH_MISMATCH');
    w=world();
    await rejectsWith(w.resolve({readFile:async()=>'not bytes'}),'PF2_ENGINE_HASH_MISMATCH');
    const counts=new Map();
    w=world();w.records.delete(keyOf(w,'source'));
    await rejectsWith(w.resolve({readFile:async url=>{counts.set(url.href,(counts.get(url.href)??0)+1);return readFile(url);}}),
      'PF2_INPUT_UNRESOLVED');
    assert.deepEqual([...counts.keys()].sort(),PF2_ENGINE_FILES.map(file=>new URL('../'+file,import.meta.url).href).sort());
    assert.ok([...counts.values()].every(count=>count===1));
    await assert.rejects(pf2ExecutableHashes({readFile:async()=>{throw new Error(MARKER);}}),
      error=>{hygiene(error);assert.equal(error.code,'PF2_ENGINE_HASH_MISMATCH');return true;});
    await rejectsWith(pf2ExecutableHashes({readFile:'x'}),'PF2_RESOLVER_CONFIG_INVALID');
  });

  await t.test('executable lists: sorted, evaluator subset of engine, import closure verified',async()=>{
    for(const list of [PF2_ENGINE_FILES,PF2_EVALUATOR_FILES]){
      assert.deepEqual([...list],[...list].sort());
      assert.equal(new Set(list).size,list.length);
      for(const file of list)assert.ok((await stat(path.join(root,file))).isFile(),file);
    }
    assert.ok(PF2_EVALUATOR_FILES.every(file=>PF2_ENGINE_FILES.includes(file)));
    const relative=text=>[...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/g),
      ...text.matchAll(/(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g)].map(match=>match[1]);
    const jsImports=async file=>(relative(await readFile(path.join(root,file),'utf8')))
      .map(item=>path.posix.normalize(path.posix.join(path.posix.dirname(file),item)));
    const dir='quant_lab/src/robot_quant/';
    const pyImports=async file=>{
      const text=await readFile(path.join(root,file),'utf8'),found=new Set();
      for(const match of text.matchAll(/^\s*from\s+robot_quant\.(\w+)\s+import/gm))found.add(dir+match[1]+'.py');
      for(const match of text.matchAll(/^\s*import\s+robot_quant\.(\w+)/gm))found.add(dir+match[1]+'.py');
      for(const match of text.matchAll(/^\s*from\s+robot_quant\s+import\s+([\w, ]+)/gm))
        for(const name of match[1].split(','))found.add(dir+name.trim()+'.py');
      // Importing any robot_quant module first runs the package __init__.py.
      if(found.size&&!file.endsWith('__init__.py'))found.add(dir+'__init__.py');
      return [...found];
    };
    const closure=async(seeds,imports)=>{
      const seen=new Set(),queue=[...seeds];
      while(queue.length){
        const file=queue.pop();
        if(seen.has(file))continue;
        seen.add(file);
        for(const next of await imports(file))queue.push(next);
      }
      return [...seen].sort();
    };
    // PF-2's own import closure plus the shared runtime manifest; quant-engine-files.test.js walks that
    // manifest from the worker and API roots, like the Python check below.
    const pf2Js=await closure(['src/quant-research/preflight-resolver.js','src/quant-research/dataset-store.js',
      'src/quant-research/research-dataset-store.js','src/quant-research/preflight-replay.js','src/quant-research/preflight-runtime.js'],jsImports);
    // PF-2's own closure stays pinned: a PF-2 module may not reach hashed runtime or database modules either.
    assert.deepEqual(pf2Js,[
      'src/money.js','src/pine-bridge/source.js','src/quant-research/atr14-chunk-store.js',
      'src/quant-research/capacity-contract.js','src/quant-research/contract.js','src/quant-research/data-profile-v2.js',
      'src/quant-research/dataset-store.js','src/quant-research/foundation-contract-v2.js','src/quant-research/foundation-contract.js',
      'src/quant-research/io-budget-ledger.js','src/quant-research/io-controls.js','src/quant-research/io-terminal.js',
      'src/quant-research/preflight-contract.js','src/quant-research/preflight-replay.js','src/quant-research/preflight-resolver.js',
      'src/quant-research/preflight-runtime.js','src/quant-research/process-supervisor.js','src/quant-research/profile-contract-v2.js',
      'src/quant-research/profile-contract.js','src/quant-research/research-dataset-store.js','src/quant-research/runtime-engine-files.js']);
    assert.deepEqual([...new Set([...pf2Js,...QUANT_RUNTIME_ENGINE_FILES.filter(file=>file.endsWith('.js'))])].sort(),
      PF2_ENGINE_FILES.filter(file=>file.endsWith('.js')));
    const replayPython=await closure([dir+'pf2_replay.py'],pyImports);
    assert.deepEqual([...new Set([...replayPython,...QUANT_RUNTIME_ENGINE_FILES.filter(file=>file.endsWith('.py'))])].sort(),
      PF2_ENGINE_FILES.filter(file=>file.endsWith('.py')));
    assert.deepEqual(await closure([dir+'spt_custom_evaluator.py'],pyImports),[...PF2_EVALUATOR_FILES]);
    // Runtime manifest modules may import the reviewed shared-application boundary without hashing it.
    const shared=new Set(SHARED_APPLICATION_FILES);
    for(const file of PF2_ENGINE_FILES){
      const listed=await (file.endsWith('.js')?jsImports:pyImports)(file);
      for(const item of listed)assert.ok(PF2_ENGINE_FILES.includes(item)||shared.has(item),`${file} imports unlisted ${item}`);
    }
    // The resolver itself may only import the reviewed modules.
    const own=await readFile(path.join(root,'src/quant-research/preflight-resolver.js'),'utf8');
    const imports=[...own.matchAll(/^import\s.*?from\s*'([^']+)'/gm)].map(match=>match[1]).sort();
    assert.deepEqual(imports,['../money.js','../pine-bridge/source.js','./contract.js','./data-profile-v2.js',
      './foundation-contract-v2.js','./foundation-contract.js','./preflight-contract.js','./profile-contract-v2.js',
      './runtime-engine-files.js',
      'node:fs/promises']);
  });

  await t.test('authorization gates everything: false, throw, non-true',async()=>{
    for(const setup of [w=>w.authorized.clear(),w=>w.throwOn.set('authorize',new Error(MARKER)),
      w=>{w.trusted.authorize=async()=>'yes';},w=>{w.plan.foundation.owner_id='owner-b';}]){
      const w=world();
      setup(w);
      await rejectsWith(w.resolve(),'PF2_RESOLVE_UNAUTHORIZED');
      assert.equal(w.callNames().filter(name=>name!=='authorize').length,0);
      assert.equal(w.reads.length,0);
    }
  });

  await t.test('holdout registry: null, throw, off by one minute, unaligned, bad shape',async()=>{
    const setups=[w=>{w.holdout.value=null;},w=>w.throwOn.set('holdout',new Error(MARKER)),
      w=>{w.holdout.value+=MINUTE;},w=>{w.holdout.value-=MINUTE;},w=>{w.holdout.value+=1;},
      w=>{w.holdout.respond=()=>({holdout_start_time:w.holdout.value,extra:1});},
      w=>{w.holdout.respond=()=>({holdout_start_time:String(w.holdout.value)});},
      w=>{w.holdout.respond=()=>({get holdout_start_time(){return w.holdout.value;}});},
      w=>{w.holdout.respond=()=>[];},w=>{w.holdout.value=0;}];
    for(const setup of setups){
      const w=world();
      setup(w);
      await rejectsWith(w.resolve(),'PF2_HOLDOUT_BOUNDARY_MISMATCH');
      assert.deepEqual(w.callNames(),['authorize','holdout.boundary']);
      assert.equal(w.reads.length,0);
    }
    const w=world();
    await w.resolve();
    assert.deepEqual(w.calls.find(call=>call.api==='holdout.boundary').query,
      {owner_id:OWNER,bot_id:BOT,venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1'});
    assert.equal(w.calls.filter(call=>call.api.startsWith('holdout')).length,1);
  });

  await t.test('boundary off by one: end==holdout, gap, dev beyond raw, raw beyond development',async()=>{
    // Derived closed metadata ends one minute after raw (index bound); it must not be compared.
    let w=world();
    const out=await w.resolve();
    assert.equal(out.dataset.last_time,out.contract.dataset.holdout_start_time);
    assert.equal(out.dataset.research.raw.metadata.end_time,out.contract.dataset.holdout_start_time+MINUTE);
    const gap=raw.end_time+60*MINUTE;
    for(const [development,holdout] of [[raw.end_time,gap],[raw.end_time+MINUTE,raw.end_time+MINUTE]]){
      w=world();
      w.plan.snapshot.development.end_time=development;w.plan.snapshot.development.holdout_start_time=holdout;
      w.seal();w.holdout.value=holdout;
      const result=await w.resolve();
      assert.equal(result.contract.dataset.development_end_time,development);
      assert.equal(result.contract.dataset.holdout_start_time,holdout);
      assert.equal(result.dataset.last_time,raw.end_time);
    }
    // Raw one minute beyond the development end: the plan validator refuses before any trusted call.
    w=world();
    w.plan.foundation.dataset=fakeDataset({end_time:raw.end_time+MINUTE,total_bars:RAW_BARS+1,cutoff:raw.end_time+MINUTE});
    await rejectsWith(w.resolve(),'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED');
    assert.equal(w.calls.length,0);
    // Development end after holdout is an invalid plan.
    w=world();w.plan.snapshot.development.end_time=raw.end_time+2*MINUTE;
    w.plan.snapshot.development.holdout_start_time=raw.end_time+MINUTE;w.seal();
    await rejectsWith(w.resolve(),'INVALID_PREFLIGHT_CONTRACT');
  });

  await t.test('no holdout read: only the three enrolled datasets, bounded ranges, closed rows within development',async()=>{
    const w=world();
    await w.resolve();
    const allowedShas=new Set([base.rawReference.sha256,base.researchReference.raw.sha256,base.researchReference.sidecar.sha256]);
    const development=w.plan.snapshot.development;
    assert.ok(w.reads.length>=5);
    for(const read of w.reads){
      assert.ok(allowedShas.has(read.sha),`unexpected dataset ${read.api}`);
      if(read.end!==undefined)assert.ok(read.end<=raw.total_bars);
      assert.ok(['raw.inspect','raw.read','research.raw.inspect','research.inspectSidecarV2','research.readV2'].includes(read.api),read.api);
    }
    const rawRead=w.reads.find(read=>read.api==='raw.read'),closed=w.reads.find(read=>read.api==='research.readV2');
    assert.equal(rawRead.rows,raw.total_bars);
    assert.ok(rawRead.maxTime+MINUTE<=development.end_time);
    assert.equal(closed.rows,raw.total_bars-500);
    assert.ok(closed.maxTime<=development.end_time);
    assert.equal(w.calls.filter(call=>call.api.startsWith('holdout')).length,1);
    assert.equal(w.calls.filter(call=>call.api.includes('DENIED')).length,0);
    assert.ok(w.reads.every(read=>read.api.startsWith('raw.')||read.api.startsWith('research.')));
  });

  await t.test('enrollment: absent, throwing, tampered, foreign, deployment or model mismatch, v1',async()=>{
    const cases=[
      w=>{w.enrollments.clear();},
      w=>w.throwOn.set('enrollment',new Error(MARKER)),
      w=>{for(const [key,value] of [...w.enrollments]){w.enrollments.delete(key);w.enrollments.set(key.replace(base.rawReference.sha256,sha('e')),value);}},
      w=>{for(const value of w.enrollments.values())value.result.binding.binding_sha256=sha('0');},
      w=>{for(const value of w.enrollments.values())value.capacity_policy.max_chunk_bars=999;},
      w=>{for(const value of w.enrollments.values())value.result.version='research-profile-enrollment-v1';},
      w=>{for(const value of w.enrollments.values())value.contract.dataset.sha256=sha('e');},
      w=>{for(const value of w.enrollments.values())delete value.enrollment_evidence;},
      w=>{for(const value of w.enrollments.values())value.enrollment_evidence.receipt=null;},
      w=>{for(const value of w.enrollments.values())delete value.contract.completion_mode;},
      w=>{for(const value of w.enrollments.values())delete value.enrollment_evidence.job.contract.completion_mode;},
      w=>{for(const value of w.enrollments.values())value.enrollment_evidence.launch.unit_name='different-unit';},
      w=>{for(const value of w.enrollments.values())value.enrollment_evidence.receipt.result_hash=sha('9');},
      w=>{for(const value of w.enrollments.values())value.enrollment_evidence.ledger.state.operations[0].terminal_proof.readback_proof_sha256=sha('9');},
      w=>{for(const value of w.enrollments.values())value.extra=1;},
      w=>{for(const value of w.enrollments.values())value.result.references.sidecar.sha256=sha('e');},
      w=>{for(const [key,value] of [...w.enrollments]){
        const holder={contract:value.contract,result:value.result};
        Object.defineProperty(holder,'capacity_policy',{enumerable:true,get:()=>value.capacity_policy});
        w.enrollments.set(key,holder);}}];
    for(const setup of cases){
      const w=world();
      setup(w);
      await rejectsWith(w.resolve(),'PF2_DATASET_ENROLLMENT_REQUIRED');
      assert.equal(w.callNames().includes('provenance.get'),false);
      assert.equal(w.reads.length,0);
    }
    // Structurally valid enrollments that belong to something else.
    const variants=[
      {enrollmentOptions:{owner:'owner-b'}},
      {enrollmentOptions:{deploymentId:'deployment-other-0002'}},
      {model:{...modelRecord(),fee_bps:11},enrolledModel:modelRecord()},
      {enrollment:enrollment=>{enrollment.contract.bot_id='bot-b';}}];
    for(const edits of variants){
      const w=world(await base.scenario(edits));
      await rejectsWith(w.resolve(),'PF2_DATASET_ENROLLMENT_REQUIRED');
    }
    const w=world();
    await w.resolve();
    assert.deepEqual(w.calls.find(call=>call.api==='enrollment.find').query,{owner_id:OWNER,bot_id:BOT,
      raw_dataset_sha256:base.rawReference.sha256,execution_model_hash:w.plan.snapshot.execution_model_hash,
      venue_metadata_hash:w.plan.snapshot.venue_metadata_hash});
  });

  await t.test('warm-up: derived warm-up must cover 1006 bars and five slow EMAs',async()=>{
    // Plan-only datasets (no store read happens before this gate).
    for(const [warmup,code] of [[1400,'PF2_WARMUP_INSUFFICIENT'],[1505,'PF2_WARMUP_INSUFFICIENT'],
      [1506,'PF2_DATASET_ENROLLMENT_REQUIRED']]){
      const w=world();
      w.plan.foundation.dataset=fakeDataset({warmup_bars:warmup});
      await rejectsWith(w.resolve(),code);
      assert.equal(w.reads.length,0);
    }
    const w=world(await base.scenario({source:syntheticSource({slow:250})}));
    await rejectsWith(w.resolve(),'PF2_WARMUP_INSUFFICIENT');
    const exact=world(await base.scenario({source:syntheticSource({slow:220})}));
    assert.equal((await exact.resolve()).contract.dataset.warmup_bars,1100);
  });

  await t.test('capture evidence: missing, altered, gapped, miscounted, mismatched',async()=>{
    const setups=[w=>w.provenances.clear(),w=>w.throwOn.set('provenance',new Error(MARKER)),
      w=>{for(const value of w.provenances.values())value.pages[0].retrieved_at+=1;}];
    for(const setup of setups){
      const w=world();
      setup(w);
      await rejectsWith(w.resolve(),'PF2_CAPTURE_EVIDENCE_REQUIRED');
      assert.equal(w.reads.length,0);
    }
    const edits=[p=>{p.pages[1].start_time+=MINUTE;},p=>{p.pages[2].count=599;p.pages[2].end_time-=MINUTE;},
      p=>{p.range.metadata.cutoff+=1;},p=>{p.pages=[];},p=>{p.pages[0].extra=1;},p=>{p.pages[0].page=1;},
      p=>{p.pages[0].source='https://example.invalid/klines';},p=>{p.extra=1;},p=>{p.pages[1].sha256='xyz';}];
    for(const provenance of edits){
      const w=world(await base.scenario({provenance}));
      await rejectsWith(w.resolve(),'PF2_CAPTURE_EVIDENCE_REQUIRED');
      assert.equal(w.reads.length,0);
    }
  });

  await t.test('open bars: retrieved before page end, after now, or now before raw end',async()=>{
    const variants=[{provenanceOptions:{retrievedAt:page=>page.end_time-1}},
      {provenanceOptions:{retrievedAt:()=>base.now+1}},{now:raw.end_time-MINUTE}];
    for(const edits of variants){
      const w=world(await base.scenario(edits));
      await rejectsWith(w.resolve(),'PF2_OPEN_BAR');
      assert.equal(w.reads.length,0);
    }
    // Exactly at the boundaries (retrieved at page end, now at raw end) is closed.
    const w=world(await base.scenario({provenanceOptions:{retrievedAt:page=>page.end_time},now:raw.end_time}));
    assert.equal((await w.resolve()).identities.raw_provenance_sha256,w.scenario.provenanceSha);
  });

  await t.test('content tamper on disk: raw chunk, raw manifest, closed chunk, sidecar chunk',async st=>{
    const targets=[['raw chunk',base.rawReference.dataset_id,'chunk-00000.jsonl'],
      ['raw manifest',base.rawReference.dataset_id,'manifest.json'],
      ['closed chunk',base.researchReference.raw.dataset_id,'chunk-00000.jsonl'],
      ['sidecar chunk','atr14-v2-'+base.researchReference.sidecar.sha256,'chunk-00000.jsonl']];
    for(const [name,...parts] of targets){
      const copy=await base.cloneStores(st);
      const file=path.join(copy.root,...parts);
      const bytes=await readFile(file);
      bytes[10]^=1;
      await writeFile(file,bytes);
      const w=world(undefined,{stores:copy});
      await assert.rejects(w.resolve(),error=>{hygiene(error);assert.equal(error.code,'PF2_DATASET_HASH_MISMATCH',name);return true;});
    }
  });

  await t.test('cancellation: pre-aborted, inside trusted calls, inside dataset reads',async()=>{
    const unhandled=[],listener=reason=>unhandled.push(reason);
    process.on('unhandledRejection',listener);
    try{
      let controller=new AbortController();
      controller.abort();
      let w=world();
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      assert.equal(w.calls.length,0);
      controller=new AbortController();w=world();
      w.trusted.authorize=async()=>{controller.abort();return true;};
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      assert.equal(w.callNames().includes('holdout.boundary'),false);
      controller=new AbortController();w=world();
      w.hooks.recordGet=kind=>{if(kind==='bridge')controller.abort();};
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      assert.equal(w.recordKinds().at(-1),'bridge');
      assert.equal(w.callNames().includes('enrollment.find'),false);
      for(const [api,limit] of [['research.readV2',5],['raw.read',700]]){
        controller=new AbortController();w=world();
        w.hooks.row=entry=>{if(entry.api===api&&entry.rows===limit)controller.abort();};
        await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
        const iterators=w.reads.filter(read=>read.api==='raw.read'||read.api==='research.readV2');
        // The resolver returns at the abort; the store unwinds on its own signal a moment later.
        for(let wait=0;wait<100&&!iterators.every(read=>read.returned===true);wait++)await new Promise(done=>setTimeout(done,10));
        assert.ok(iterators.some(read=>read.api===api)&&iterators.every(read=>read.returned===true));
      }
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(unhandled,[]);
    }finally{process.off('unhandledRejection',listener);}
  });

  await t.test('no writes: dataset tree unchanged, write surfaces unreachable, no write vocabulary in source',async()=>{
    const tree=async dir=>{
      const listed=[];
      const walk=async current=>{
        for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){
          const file=path.join(current,entry.name);
          if(entry.isDirectory()){listed.push([path.relative(dir,file),'dir']);await walk(file);}
          else listed.push([path.relative(dir,file),(await stat(file)).size,createHash('sha256').update(await readFile(file)).digest('hex')]);
        }
      };
      await walk(dir);
      return listed;
    };
    const before=await tree(base.root);
    const w=world();
    await w.resolve();
    assert.deepEqual(await tree(base.root),before);
    assert.equal(w.calls.filter(call=>call.api.includes('DENIED')).length,0);
    for(const store of [w.trusted.datasets.raw,w.trusted.datasets.research,w.trusted.datasets.research.raw]){
      for(const property of ['publish','publishStream','writeFile','setChunk','deleteDataset'])
        assert.throws(()=>store[property],/STORE_ACCESS_DENIED/);
    }
    assert.throws(()=>w.trusted.holdout.set,/HOLDOUT_ACCESS_DENIED/);
    const text=await readFile(path.join(root,'src/quant-research/preflight-resolver.js'),'utf8');
    for(const word of ['writeFile','appendFile','rename','unlink','mkdir','fs.rm','child_process','INSERT','UPDATE','publish',
      'Date.now','new Date','process.env','setTimeout','fetch(','.write(','.set('])
      assert.equal(text.includes(word),false,word);
    assert.equal(/\brm\s*\(/.test(text),false);
    assert.ok(text.includes('readFile'));
  });

  await t.test('R1 policy notionals: validateRisk strings and config numbers both pass through unchanged',async()=>{
    const strings=await world().resolve();
    assert.equal(strings.contract.policy.maxOrderNotional,'5000');
    assert.equal(strings.contract.policy.maxDailyNotional,'50000');
    assert.equal(strings.contract.policy.maxDailyLossR,3);
    const numeric=await world(await base.scenario({policy:policyRecord('numeric')})).resolve();
    assert.equal(numeric.contract.policy.maxOrderNotional,10000);
    assert.equal(numeric.contract.policy.maxDailyNotional,100000);
    resolvedVariants.push(['numeric notionals',numeric.contract]);
  });

  await t.test('R2 execution model: numeric, string and mixed enrolled forms map to exact decimal strings',async()=>{
    const cd=/^[0-9]+(?:\.[0-9]+)?$/;
    const mixed={...modelRecord(),fee_bps:7.5,slippage_bps:'2.25',risk_percent:0.5};
    for(const model of [modelRecord('string'),mixed]){
      const out=await world(await base.scenario({model})).resolve();
      assert.deepEqual(out.contract.model,{price_tick:'0.01',quantity_step:'0.001',fee_bps:String(model.fee_bps),
        slippage_bps:String(model.slippage_bps),risk_percent:String(model.risk_percent),version:'paper-close-v1'});
      assert.ok(Object.entries(out.contract.model).every(([name,value])=>name==='version'||cd.test(value)));
      assert.equal(out.identities.execution_model_hash,hash(canonical(model)));
      resolvedVariants.push([`model ${canonical(model)}`,out.contract]);
    }
  });

  await t.test('R3 deployment snapshot binds policy, market, source, membership, signals, bridge and capital',async()=>{
    const edits=[
      ['policy_hash differs from plan',s=>{s.policy_hash=sha('1');}],
      ['policy changed, hash kept',s=>{s.policy.maxDailyLossR=9;}],
      ['policy changed and rehashed',s=>{s.policy.maxDailyLossR=9;s.policy_hash=hash(canonical(s.policy));}],
      ['policy missing',s=>{delete s.policy;}],
      ['market differs from venue',s=>{s.market.pine_import_id='pine-import-other';}],
      ['source_hash differs',s=>{s.source_hash=sha('1');}],
      ['membership listed twice',s=>{s.membership.push(clone(s.membership[0]));}],
      ['membership analysis differs',s=>{s.membership[0].analysis.effective_input_review.reviewed_by='someone-else';}],
      ['membership source_version differs',s=>{s.membership[0].source_version=2;}],
      ['membership source_hash differs',s=>{s.membership[0].source_hash=sha('1');}],
      ['signal mapping differs',s=>{s.selection.signals.buy='other';}],
      ['selection missing',s=>{delete s.selection;}],
      ['bridge rr differs',s=>{s.selection.bridge.rr=1.6;}],
      ['bridge atr differs',s=>{s.selection.bridge.atr_multiplier=3;}],
      ['capital balance differs',s=>{s.capital[0].configuredBalance='799';}],
      ['capital equity differs',s=>{s.capital[0].configuredEquity='1001';}],
      ['capital broker differs',s=>{s.capital[0].broker='binance-th';}],
      ['capital account duplicated',s=>{s.capital.push(clone(s.capital[0]));}]];
    for(const [name,snapshot] of edits){
      const w=world(await base.scenario({snapshot}));
      await assert.rejects(w.resolve(),error=>{hygiene(error);assert.equal(error.code,INVALID,name);return true;});
      assert.equal(w.reads.length,0,name);
    }
    // Same decimal values in other spellings (production stores numbers and toFixed() text) still bind.
    const w=world(await base.scenario({snapshot:s=>{
      s.capital[0].configuredBalance='800.00';s.capital[0].configuredEquity='1000.000';
      s.selection.bridge={atr_multiplier:2.0,rr:1.5};s.extra_field='allowed';}}));
    assert.equal((await w.resolve()).identities.raw_dataset_sha256,base.rawReference.sha256);
  });

  await t.test('O2 detach: get traps never used, mid-resolve mutation ignored, hostile shapes refused',async()=>{
    // Promise resolution reads .then once; every other property read through get is a failure.
    const trap={get(target,property){
      if(property==='then'||typeof property==='symbol')return undefined;
      throw new Error('get trap used');},has(){throw new Error('has trap used');}};
    const deep=value=>{
      if(!value||typeof value!=='object')return value;
      const copy=Array.isArray(value)?value.map(deep):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,deep(item)]));
      return new Proxy(copy,trap);
    };
    const expected=historicalPreflightHash(world().plan);
    let w=world();
    w.plan=deep(w.plan);
    for(const [key,value] of [...w.records])w.records.set(key,deep(value));
    for(const [key,value] of [...w.enrollments])w.enrollments.set(key,deep(value));
    for(const [key,value] of [...w.provenances])w.provenances.set(key,deep(value));
    w.holdout.respond=()=>deep({holdout_start_time:w.holdout.value});
    assert.equal((await w.resolve()).plan_hash,expected);
    // Live objects mutated between fetches: only the copy taken at fetch time is used.
    w=world();
    w.hooks.recordGet=kind=>{
      if(kind==='capital')for(const [key,value] of w.records)if(key.includes('|bridge|'))value.rr='9';
      if(kind==='deployment_snapshot')for(const value of w.enrollments.values())value.result.acceptance_blockers=['MUTATED'];
    };
    const out=await w.resolve();
    assert.equal(out.contract.bridge.rr,'1.5');
    assert.deepEqual(out.acceptance_blockers,w.scenario.enrollment.result.acceptance_blockers);
    const cycle={atr_multiplier:'2',rr:'1.5'};cycle.self=cycle;
    const hostile=[cycle,{atr_multiplier:'2',rr:'1.5',[Symbol('hidden')]:1},Object.assign([1],{extra:1}),
      new (class Custom{constructor(){this.atr_multiplier='2';this.rr='1.5';}})(),new Date(0),
      {atr_multiplier:'2',rr:NaN},{atr_multiplier:'2',rr:undefined},Object.create({inherited:1})];
    for(const value of hostile){
      w=world();
      w.records.set(keyOf(w,'bridge'),value);
      await rejectsWith(w.resolve(),INVALID);
    }
  });

  await t.test('F1 hostile trusted values: proxy traps and thrown objects never escape or fake a code',async()=>{
    const crafted=code=>Object.assign(new Error(code),{code,status:400,leak:MARKER,cause:new Error(MARKER)});
    const hostileThrown=()=>new Proxy(new Error('x'),{get(){throw new Error(MARKER);},
      getOwnPropertyDescriptor(){throw new Error(MARKER);},ownKeys(){throw new Error(MARKER);}});
    // A record whose proxy traps throw a crafted error that claims a known resolver code.
    for(const code of ['PF2_OPEN_BAR','PF2_CANCELLED','PF2_INPUT_UNRESOLVED','PF2_HOLDOUT_BOUNDARY_MISMATCH']){
      for(const trapName of ['getPrototypeOf','ownKeys','getOwnPropertyDescriptor']){
        for(const kind of ['bridge','effective_inputs']){
          const thrown=crafted(code);
          const w=world();
          const target=clone(w.records.get(keyOf(w,kind)));
          w.records.set(keyOf(w,kind),new Proxy(target,{[trapName](){throw thrown;}}));
          let seen;
          await assert.rejects(w.resolve(),error=>{
            seen=error;hygiene(error);assert.equal(error.code,INVALID,`${kind} ${trapName} ${code}`);return true;});
          assert.notEqual(seen,thrown);
          assert.equal(Object.hasOwn(seen,'leak'),false);
          assert.equal(seen.cause,undefined);
        }
      }
    }
    // The same for the caller plan: no reused-code faking, one fixed code.
    for(const code of ['PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED','PF2_CANCELLED']){
      const w=world();
      w.plan=new Proxy(clone(w.plan),{ownKeys(){throw crafted(code);}});
      await rejectsWith(w.resolve(),'INVALID_PREFLIGHT_CONTRACT');
      assert.equal(w.calls.length,0);
    }
    // A thrown value that is itself hostile (throwing getters) is never read into the result.
    let w=world();
    w.throwOn.set('authorize',hostileThrown());
    await rejectsWith(w.resolve(),'PF2_RESOLVE_UNAUTHORIZED');
    for(const thrown of [hostileThrown(),crafted('PF2_CANCELLED'),crafted('PF2_OPEN_BAR')]){
      w=world();
      const original=w.trusted.datasets;
      w.trusted.datasets={raw:original.raw,research:new Proxy(original.research,{get(target,property){
        if(property==='inspectSidecarV2')return async()=>{throw thrown;};
        return Reflect.get(target,property);}})};
      await rejectsWith(w.resolve(),'PF2_DATASET_HASH_MISMATCH');
    }
    // Errors still map to the same code for our own failures, freshly created each time.
    const first=await world().resolve({now:1}).catch(error=>error);
    const second=await world().resolve({now:1}).catch(error=>error);
    assert.equal(first.code,'PF2_OPEN_BAR');
    assert.notEqual(first,second);
  });

  await t.test('F2 abort releases trusted calls that ignore the signal',async()=>{
    const unhandled=[],listener=reason=>unhandled.push(reason);
    process.on('unhandledRejection',listener);
    try{
      const cases=[['authorize',(w,hang)=>{w.trusted.authorize=hang;}],
        ['holdout',(w,hang)=>{w.trusted.holdout.boundary=hang;}],
        ['records',(w,hang)=>{w.trusted.records.get=hang;}],
        ['enrollment',(w,hang)=>{w.trusted.enrollment.find=hang;}],
        ['provenance',(w,hang)=>{w.trusted.provenance.get=hang;}]];
      for(const [name,setup] of cases){
        const controller=new AbortController(),w=world();
        // The stuck adapter raises the abort itself, so the call is certainly in flight.
        let reached=false;
        setup(w,()=>{reached=true;setTimeout(()=>controller.abort(),20);return stuck();});
        const outcome=await settled(w.resolve({signal:controller.signal}));
        assert.equal(reached,true,name);
        assert.notEqual(outcome,'HUNG',name);
        hygiene(outcome);
        assert.equal(outcome.code,'PF2_CANCELLED',name);
        assert.equal(getEventListeners(controller.signal,'abort').length,0,name);
      }
      // Abort raised inside the call itself, which then never settles.
      const controller=new AbortController(),w=world();
      w.trusted.authorize=()=>{controller.abort();return stuck();};
      const outcome=await settled(w.resolve({signal:controller.signal}));
      assert.equal(outcome.code,'PF2_CANCELLED');
      // A stuck call without any abort is not the resolver's business (adapter must honour deadlines).
      // Listener cleanup after a normal run, and a signal-like object without addEventListener.
      const idle=new AbortController();
      assert.equal((await world().resolve({signal:idle.signal})).version,PF2_RESOLVED_VERSION);
      assert.equal(getEventListeners(idle.signal,'abort').length,0);
      assert.equal((await world().resolve({signal:{aborted:false}})).version,PF2_RESOLVED_VERSION);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(unhandled,[]);
    }finally{process.off('unhandledRejection',listener);}
  });

  await t.test('resolver-owned signals: one child per source phase, never the caller signal, aborted at scope end',async()=>{
    const watch=watchUnhandled();
    try{
      const inspectSignals=(w,caller)=>{
        const sources=new Set(w.calls.map(call=>call.signal)),stores=new Set(w.reads.map(read=>read.signal).filter(Boolean));
        assert.ok(w.calls.length>0&&w.calls.every(call=>call.signal instanceof AbortSignal));
        assert.equal(sources.size,1);
        assert.ok(stores.size<=1);
        for(const item of [...sources,...stores]){
          assert.ok(item instanceof AbortSignal);
          assert.notEqual(item,caller);
          assert.equal(item.aborted,true,'aborted once resolve settled');
        }
        return {source:[...sources][0],store:[...stores][0]};
      };
      // Success: one source child (authorize, holdout, records, enrollment, provenance), one store child.
      let controller=new AbortController(),during=-1;
      let w=world();
      w.hooks.recordGet=()=>{during=getEventListeners(controller.signal,'abort').length;};
      assert.equal((await w.resolve({signal:controller.signal})).version,PF2_RESOLVED_VERSION);
      assert.equal(during,1,'exactly one caller listener while resolving');
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      assert.equal(controller.signal.aborted,false);
      assert.equal(new Set(w.calls.map(call=>call.api)).size,5);
      const seen=inspectSignals(w,controller.signal);
      assert.ok(seen.store&&seen.store!==seen.source);
      assert.ok(w.reads.filter(read=>read.signal).length>=3);
      // Failure after every source call, failure at the first call, no caller signal at all.
      controller=new AbortController();w=world();
      await rejectsWith(w.resolve({signal:controller.signal,now:1}),'PF2_OPEN_BAR');
      inspectSignals(w,controller.signal);
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      controller=new AbortController();w=world();w.authorized.clear();
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_RESOLVE_UNAUTHORIZED');
      assert.equal(w.calls.length,1);
      inspectSignals(w,controller.signal);
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      w=world();
      await w.resolve();
      inspectSignals(w,undefined);
      // Cancel: the child is aborted at once (an adapter sees it) and stays aborted.
      controller=new AbortController();w=world();
      w.hooks.recordGet=kind=>{if(kind==='bridge')controller.abort();};
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      inspectSignals(w,controller.signal);
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('F9/F10 an adapter cannot disturb the resolver through the signal it receives',async()=>{
    const watch=watchUnhandled();
    try{
      const baseline=canonical(await world().resolve());
      const fresh=()=>new AbortController().signal;
      const thrown=craftedError('PF2_OPEN_BAR');
      const sourceHook=(shadow,extra)=>w=>{w.hooks.recordGet=(kind,context)=>{shadow(context.signal);extra?.(kind);};return w;};
      // F9: an own throwing aborted getter (crafted known-code error) is never read, in any mode.
      for(const signal of [fresh,()=>({aborted:false}),()=>undefined]){
        const w=sourceHook(child=>shadowThrowing(child,thrown))(world());
        assert.equal(canonical(await w.resolve({signal:signal()})),baseline);
      }
      // F9 on a failing resolve: the code stays the resolver's own, freshly minted.
      let w=world();
      w.trusted.authorize=async(ids,options)=>{shadowThrowing(options.signal,thrown);return true;};
      let seen;
      await assert.rejects(w.resolve({signal:fresh(),now:1}),error=>{
        seen=error;hygiene(error);assert.equal(error.code,'PF2_OPEN_BAR');return true;});
      assert.notEqual(seen,thrown);
      assert.equal(Object.hasOwn(seen,'leak'),false);
      assert.equal(seen.cause,undefined);
      // F10-B: a child shadowed as aborted never fakes PF2_CANCELLED.
      w=sourceHook(child=>shadowValue(child,true))(world());
      assert.equal(canonical(await w.resolve({signal:fresh()})),baseline);
      // F10-B2: shadow false, no-op listeners, never settle: a caller abort still wins promptly.
      const controller=new AbortController();
      w=world();
      let started=0;
      w.trusted.records.get=(kind,sha,context)=>{
        shadowValue(context.signal,false);
        context.signal.addEventListener=()=>{};
        context.signal.removeEventListener=()=>{};
        started=performance.now();
        setTimeout(()=>controller.abort(),20);
        return stuck();
      };
      const outcome=await settled(w.resolve({signal:controller.signal}));
      assert.notEqual(outcome,'HUNG');
      hygiene(outcome);
      assert.equal(outcome.code,'PF2_CANCELLED');
      assert.ok(started>0&&performance.now()-started<1000);
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      // F10-C: throwing add/removeEventListener on the child: no unhandled rejection, result unaffected.
      w=sourceHook(child=>{
        child.addEventListener=()=>{throw new Error(MARKER);};
        child.removeEventListener=()=>{throw new Error(MARKER);};
      })(world());
      assert.equal(canonical(await w.resolve({signal:fresh()})),baseline);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('F11 an adapter cannot break the scope close through dispatchEvent on its signal',async()=>{
    const watch=watchUnhandled(),uncaught=watchUncaught();
    try{
      const baseline=canonical(await world().resolve());
      const thrown=craftedError('PF2_OPEN_BAR');
      let shadows=0;
      // Node's abort() looks up dispatchEvent on the instance, so an adapter can make abort() throw.
      const shadowDispatch=signal=>{
        shadows++;
        Object.defineProperty(signal,'dispatchEvent',{configurable:true,value(){throw thrown;}});
      };
      const shadowSource=w=>{w.hooks.recordGet=(kind,context)=>{shadowDispatch(context.signal);};};
      const shadowStore=w=>{w.hooks.row=entry=>{shadowDispatch(entry.signal);};};
      const variants=[shadowSource,shadowStore,w=>{shadowSource(w);shadowStore(w);}];
      const modes=[()=>new AbortController().signal,()=>({aborted:false}),()=>undefined];
      const storeReads=w=>w.reads.filter(read=>read.signal);
      // Success: equal to the baseline (never the adapter's error), and every child still ends aborted.
      for(const variant of variants){
        for(const mode of modes){
          const w=world();
          variant(w);
          shadows=0;
          assert.equal(canonical(await w.resolve({signal:mode()})),baseline);
          assert.ok(shadows>0);
          assert.ok(w.calls.every(call=>call.signal.aborted));
          assert.ok(storeReads(w).length>=3&&storeReads(w).every(read=>read.signal.aborted));
        }
      }
      // Failure: the code stays the resolver's own and freshly minted.
      let w=world();
      shadowSource(w);
      let seen;
      await assert.rejects(w.resolve({signal:new AbortController().signal,now:1}),error=>{
        seen=error;hygiene(error);assert.equal(error.code,'PF2_OPEN_BAR');return true;});
      assert.notEqual(seen,thrown);
      assert.equal(Object.hasOwn(seen,'leak'),false);
      // A caller abort after the shadow: cancelled, nothing thrown inside the caller's dispatch,
      // the second child still aborted, and no caller listener left.
      let controller=new AbortController();
      w=world();
      let shadowed=false;
      w.hooks.recordGet=(kind,context)=>{
        if(!shadowed){shadowDispatch(context.signal);shadowed=true;}
        if(kind==='bridge')controller.abort();
      };
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      assert.equal(controller.signal.aborted,true);
      assert.ok(w.calls.every(call=>call.signal.aborted));
      // The same abort during the content pass, both children shadowed: the store child still aborts.
      controller=new AbortController();
      w=world();
      shadowSource(w);
      w.hooks.row=entry=>{
        shadowDispatch(entry.signal);
        if(entry.api==='raw.read'&&entry.rows===700)controller.abort();
      };
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      assert.ok(storeReads(w).length>=1&&storeReads(w).every(read=>read.signal.aborted));
      // Poll mode: a flip at a boundary closes the shadowed scope without throwing.
      const like={aborted:false};
      w=world();
      shadowed=false;
      w.hooks.recordGet=(kind,context)=>{
        if(!shadowed){shadowDispatch(context.signal);shadowed=true;}
        if(kind==='bridge')like.aborted=true;
      };
      await rejectsWith(w.resolve({signal:like}),'PF2_CANCELLED');
      assert.ok(w.calls.every(call=>call.signal.aborted));
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
      assert.deepEqual(uncaught.seen,[]);
    }finally{uncaught.stop();watch.stop();}
  });

  await t.test('F12 a hostile thenable from an adapter cannot pin the resolver',async()=>{
    const watch=watchUnhandled();
    try{
      // First read of `then` says "plain value"; later reads say "thenable that never calls back".
      const pinning=()=>{let reads=0;return {get then(){return ++reads===1?undefined:()=>{};}};};
      const neverCalls=()=>({then(){}});
      const onAuthorize=(w,value)=>{w.trusted.authorize=value;};
      const onRecord=kind=>(w,value)=>{
        const original=w.trusted.records.get;
        w.trusted.records.get=(name,sha,context)=>name===kind?value():original(name,sha,context);
      };
      const cases=[
        ['authorize pinning',onAuthorize,pinning,'PF2_RESOLVE_UNAUTHORIZED',true],
        ['source pinning',onRecord('source'),pinning,'PF2_INPUT_INVALID',true],
        ['bridge pinning',onRecord('bridge'),pinning,'PF2_INPUT_INVALID',true],
        ['authorize never calls back',onAuthorize,neverCalls,'PF2_CANCELLED',false],
        ['source never calls back',onRecord('source'),neverCalls,'PF2_CANCELLED',false]];
      for(const [name,install,make,code,alsoWithoutSignal] of cases){
        for(const linked of alsoWithoutSignal?[true,false]:[true]){
          const controller=new AbortController(),w=world();
          let started=0;
          install(w,()=>{started=performance.now();setTimeout(()=>controller.abort(),20);return make();});
          const outcome=await settled(w.resolve({signal:linked?controller.signal:undefined}),1500);
          const label=name+(linked?' (link)':' (no signal)');
          assert.notEqual(outcome,'HUNG',label);
          hygiene(outcome);
          assert.equal(outcome.code,code,label);
          assert.ok(started>0&&performance.now()-started<1000,label);
          assert.equal(getEventListeners(controller.signal,'abort').length,0,label);
        }
      }
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('F16 config breakage is decided by resolver state: a redefined code on our own error is never read',async()=>{
    const watch=watchUnhandled(),uncaught=watchUncaught();
    try{
      const CONFIG='PF2_RESOLVER_CONFIG_INVALID';
      const crafted=craftedError('PF2_OPEN_BAR');
      // Resolver-own errors reachable through the public API: an adapter can hold one and redefine its code.
      const sources={
        hashes:()=>pf2ExecutableHashes({readFile:0}).catch(error=>error),
        resolve:()=>world().resolve({signal:5}).catch(error=>error)};
      // Each variant reads the getter `count` times; the first reads claim the config code.
      const variants={
        P1:count=>{if(count===1)return CONFIG;throw crafted;},
        P2:count=>count===1?CONFIG:'PF2_CANCELLED',
        P3:count=>count<3?CONFIG:MARKER,
        P4:null};
      const steps=[['authorize','PF2_RESOLVE_UNAUTHORIZED'],['bridge','PF2_INPUT_UNRESOLVED']];
      const modes={
        link:()=>{const controller=new AbortController();return {signal:controller.signal,controller};},
        poll:()=>({signal:{aborted:false}}),
        none:()=>({signal:undefined})};
      let runs=0;
      for(const [sourceName,obtain] of Object.entries(sources)){
        for(const [variantName,read] of Object.entries(variants)){
          for(const [step,expected] of steps){
            for(const [modeName,makeMode] of Object.entries(modes)){
              const label=[sourceName,variantName,step,modeName].join(' ');
              const thrown=await obtain();
              assert.equal(thrown.code,CONFIG,label);
              const counter={reads:0};
              if(read)Object.defineProperty(thrown,'code',{configurable:true,enumerable:true,
                get(){counter.reads++;return read(counter.reads);}});
              const w=world();
              w.throwOn.set(step,thrown);
              const {signal,controller}=makeMode();
              const outcome=await settled(w.resolve({signal}));
              assert.notEqual(outcome,'HUNG',label);
              assert.notEqual(outcome,'RESOLVED',label);
              hygiene(outcome);
              assert.notEqual(outcome,thrown,label);
              assert.notEqual(outcome,crafted,label);
              assert.equal(Object.hasOwn(outcome,'leak'),false,label);
              assert.equal(outcome.cause,undefined,label);
              // The step code, never the claimed config code and never a fake cancel.
              assert.equal(outcome.code,expected,label);
              assert.equal(counter.reads,0,label+' getter read');
              if(controller){
                assert.equal(controller.signal.aborted,false,label);
                assert.equal(getEventListeners(controller.signal,'abort').length,0,label);
              }
              assert.ok(w.calls.every(call=>call.signal.aborted),label+' child aborted');
              runs++;
            }
          }
        }
      }
      assert.equal(runs,48);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
      assert.deepEqual(uncaught.seen,[]);
    }finally{uncaught.stop();watch.stop();}
  });

  await t.test('propagation: sources and stores observe a caller abort on their own signal',async()=>{
    const watch=watchUnhandled();
    try{
      let controller=new AbortController(),observed=false;
      let w=world();
      w.trusted.records.get=(kind,sha,context)=>new Promise(done=>{
        context.signal.addEventListener('abort',()=>{observed=true;done(null);},{once:true});
        setTimeout(()=>controller.abort(),20);
      });
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      assert.equal(observed,true);
      // A dataset store sees the abort on the signal it was given, mid content pass.
      controller=new AbortController();w=world();
      w.hooks.row=entry=>{if(entry.api==='raw.read'&&entry.rows===700)controller.abort();};
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      const read=w.reads.find(item=>item.api==='raw.read');
      assert.ok(read.signal instanceof AbortSignal);
      assert.notEqual(read.signal,controller.signal);
      assert.equal(read.signal.aborted,true);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('content pass: only the caller abort means cancelled; store errors are hash mismatches',async()=>{
    const watch=watchUnhandled();
    try{
      const storeWith=(w,method,replacement)=>{
        const original=w.trusted.datasets;
        w.trusted.datasets={raw:original.raw,research:new Proxy(original.research,{get(target,property){
          if(property===method)return replacement(target);
          return Reflect.get(target,property);}})};
      };
      const cancelledError=()=>Object.assign(new Error('DATASET_CANCELLED'),{code:'DATASET_CANCELLED',status:400});
      // A store reporting DATASET_CANCELLED (or claiming it) without a caller abort: mismatch, in every mode.
      for(const signal of [()=>new AbortController().signal,()=>({aborted:false}),()=>undefined]){
        const w=world();
        storeWith(w,'inspectSidecarV2',()=>async()=>{throw cancelledError();});
        await rejectsWith(w.resolve({signal:signal()}),'PF2_DATASET_HASH_MISMATCH');
      }
      // A store that tampers with the signal it was given (the content pass reads it): fail closed,
      // never a fake cancel and never the store's own error.
      const thrown=craftedError('PF2_OPEN_BAR');
      for(const shadow of [child=>shadowThrowing(child,thrown),child=>shadowValue(child,true)]){
        const w=world();
        storeWith(w,'inspectSidecarV2',target=>async(reference,options)=>{
          shadow(options.signal);
          return target.inspectSidecarV2(reference,options);
        });
        await assert.rejects(w.resolve({signal:new AbortController().signal}),error=>{
          hygiene(error);assert.equal(error.code,'PF2_DATASET_HASH_MISMATCH');assert.notEqual(error,thrown);return true;});
      }
      // A caller abort during the pass, with the store reporting it as DATASET_CANCELLED: cancelled.
      let controller=new AbortController();
      let w=world();
      storeWith(w,'inspectSidecarV2',()=>async()=>{controller.abort();throw cancelledError();});
      await rejectsWith(w.resolve({signal:controller.signal}),'PF2_CANCELLED');
      // The pass never settles: the abort releases the resolver promptly and the listener is gone.
      controller=new AbortController();w=world();
      let started=0;
      storeWith(w,'inspectSidecarV2',()=>()=>{
        started=performance.now();
        setTimeout(()=>controller.abort(),20);
        return stuck();
      });
      const outcome=await settled(w.resolve({signal:controller.signal}));
      assert.notEqual(outcome,'HUNG');
      hygiene(outcome);
      assert.equal(outcome.code,'PF2_CANCELLED');
      assert.ok(started>0&&performance.now()-started<1000);
      assert.equal(getEventListeners(controller.signal,'abort').length,0);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('poll mode: a signal-like without addEventListener is read (guarded) at each step boundary',async()=>{
    const baseline=canonical(await world().resolve());
    const thrown=craftedError('PF2_CANCELLED');
    const clean=async(promise,code)=>{
      let seen;
      await assert.rejects(promise,error=>{seen=error;hygiene(error);assert.equal(error.code,code);return true;});
      assert.notEqual(seen,thrown);
      assert.equal(Object.hasOwn(seen,'leak'),false);
      assert.equal(seen.cause,undefined);
    };
    let w=world(),signal={aborted:false};
    assert.equal(canonical(await w.resolve({signal})),baseline);
    assert.equal(w.calls[0].signal.aborted,true,'child aborted at scope end');
    w=world();
    await rejectsWith(w.resolve({signal:{aborted:true}}),'PF2_CANCELLED');
    assert.equal(w.calls.length,0);
    // Flipped to true mid resolve: cancelled at the next boundary, no later trusted call.
    w=world();signal={aborted:false};
    w.hooks.recordGet=kind=>{if(kind==='bridge')signal.aborted=true;};
    await rejectsWith(w.resolve({signal}),'PF2_CANCELLED');
    assert.equal(w.recordKinds().at(-1),'bridge');
    assert.equal(w.callNames().includes('enrollment.find'),false);
    assert.equal(w.calls[0].signal.aborted,true);
    // Throwing getter or non-boolean value, at the start or later: one fixed, fresh config error.
    const getters=[()=>({get aborted(){throw thrown;}}),()=>({aborted:'no'}),()=>({aborted:undefined})];
    for(const make of getters){
      w=world();
      await clean(w.resolve({signal:make()}),'PF2_RESOLVER_CONFIG_INVALID');
      assert.equal(w.calls.length,0);
    }
    for(const flip of [()=>{throw thrown;},()=>1,()=>null]){
      let reads=0,broken=false,atFlip=0;
      w=world();
      const late={get aborted(){reads++;if(broken)return flip();return false;}};
      w.hooks.recordGet=kind=>{if(kind==='bridge'){broken=true;atFlip=reads;}};
      await clean(w.resolve({signal:late}),'PF2_RESOLVER_CONFIG_INVALID');
      assert.equal(w.callNames().includes('enrollment.find'),false);
      // One boundary read fails, then the outer catch makes at most one guarded read.
      assert.ok(reads-atFlip>=1&&reads-atFlip<=2,String(reads-atFlip));
      assert.equal(w.calls[0].signal.aborted,true);
    }
    // F13: a getter that throws once, inside the executable hashing, then reads clean in the outer catch.
    // A caller signal that breaks mid resolve gives a fresh config error; it is not remapped to an engine hash mismatch.
    let armed=false;
    const flaky={get aborted(){if(armed){armed=false;throw thrown;}return false;}};
    w=world();
    await clean(w.resolve({signal:flaky,readFile:async url=>{armed=true;return readFile(url);}}),'PF2_RESOLVER_CONFIG_INVALID');
    assert.equal(w.callNames().includes('records.get'),false);
  });

  await t.test('link mode: the caller signal is read once and gets one guarded listener',async()=>{
    const watch=watchUnhandled();
    try{
      const baseline=canonical(await world().resolve());
      const thrown=craftedError('PF2_OPEN_BAR');
      const booby=()=>{
        const controller=new AbortController(),state={reads:0};
        Object.defineProperty(controller.signal,'aborted',{configurable:true,get(){
          if(++state.reads>1)throw thrown;
          return false;}});
        return {controller,state};
      };
      // Success and failure alike: no second read of the caller signal, hence nothing to throw.
      let {controller,state}=booby();
      assert.equal(canonical(await world().resolve({signal:controller.signal})),baseline);
      assert.equal(state.reads,1);
      ({controller,state}=booby());
      let seen;
      await assert.rejects(world().resolve({signal:controller.signal,now:1}),error=>{
        seen=error;hygiene(error);assert.equal(error.code,'PF2_OPEN_BAR');return true;});
      assert.notEqual(seen,thrown);
      assert.equal(state.reads,1);
      // Registration that throws: config error, zero trusted calls. Removal that throws is ignored.
      let w=world();
      await rejectsWith(w.resolve({signal:{aborted:false,addEventListener(){throw new Error(MARKER);}}}),
        'PF2_RESOLVER_CONFIG_INVALID');
      assert.equal(w.calls.length,0);
      w=world();
      assert.equal(canonical(await w.resolve({signal:{aborted:false,addEventListener(){},
        removeEventListener(){throw new Error(MARKER);}}})),baseline);
      // A signal-like with its own listener list: its abort event cancels through the one listener.
      const like={aborted:false,listeners:[],addEventListener(type,listener){this.listeners.push([type,listener]);},
        removeEventListener(type,listener){this.listeners=this.listeners.filter(item=>item[1]!==listener);}};
      w=world();
      w.hooks.recordGet=kind=>{
        if(kind==='bridge'){assert.equal(like.listeners.length,1);like.aborted=true;for(const [,listener] of like.listeners)listener();}
      };
      await rejectsWith(w.resolve({signal:like}),'PF2_CANCELLED');
      assert.equal(like.listeners.length,0);
      await new Promise(done=>setTimeout(done,25));
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('F3 FRESH means loss_streak 0: other valid values are unsupported, malformed ones invalid',async()=>{
    for(const value of [1,3,1_000_000]){
      const w=world();
      w.reseal('initial_state',{kind:'FRESH',loss_streak:value});
      await rejectsWith(w.resolve(),UNSUPPORTED);
      assert.equal(w.callNames().includes('enrollment.find'),false);
    }
    for(const value of [-1,1.5,'0',null,1_000_001,Number.NaN]){
      const w=world();
      w.reseal('initial_state',{kind:'FRESH',loss_streak:value});
      await rejectsWith(w.resolve(),INVALID);
    }
    const w=world();
    w.reseal('initial_state',{kind:'FRESH',loss_streak:0});
    assert.deepEqual((await w.resolve()).contract.initial_state,{kind:'FRESH',loss_streak:0});
  });

  await t.test('error hygiene: fixed codes, no cause, no paths, no inner messages',async()=>{
    const scenarios=[w=>w.throwOn.set('authorize',new Error(MARKER)),w=>w.throwOn.set('holdout',new Error(MARKER)),
      w=>w.throwOn.set('source',new Error(MARKER)),w=>w.throwOn.set('deployment_snapshot',new Error(MARKER)),
      w=>w.throwOn.set('enrollment',new Error(MARKER)),w=>w.throwOn.set('provenance',new Error(MARKER))];
    for(const setup of scenarios){
      const w=world();
      setup(w);
      await assert.rejects(w.resolve(),error=>{
        hygiene(error);
        assert.deepEqual(Object.getOwnPropertyNames(error).sort(),['code','message','stack','status']);
        assert.deepEqual(Object.keys(error).sort(),['code','status']);
        assert.equal(error.message,error.code);
        return true;
      });
    }
    // A store failing with a path-carrying message is reported as a fixed code.
    const failing=world();
    const original=failing.trusted.datasets;
    failing.trusted.datasets={raw:original.raw,research:new Proxy(original.research,{get(target,property){
      if(property==='inspectSidecarV2')return async()=>{throw new Error(MARKER);};
      return Reflect.get(target,property);}})};
    await assert.rejects(failing.resolve(),error=>{hygiene(error);assert.equal(error.code,'PF2_DATASET_HASH_MISMATCH');return true;});
    // Every code observed so far is a documented one.
    assert.ok(PF2_RESOLVER_ERRORS.every(code=>/^PF2_[A-Z_]+$/.test(code)));
    assert.equal(new Set(PF2_RESOLVER_ERRORS).size,PF2_RESOLVER_ERRORS.length);
  });

  await t.test('resolved contracts are accepted by the S1 Python request validator',async st=>{
    const script='import json,sys\nfrom robot_quant.pf2_replay import _parse_contract\n'+
      'for item in json.loads(sys.stdin.read()):\n    job=_parse_contract(item)\n    print(job.total_bars,job.evaluation_start)\n';
    assert.ok(resolvedVariants.length>=4);
    if(python===null){
      assert.notEqual(process.env.PF2_REQUIRE_PYTHON,'1','PF2_REQUIRE_PYTHON=1: no absolute python interpreter');
      st.skip('no absolute python interpreter here; S4 covers the S1 validator');
      return;
    }
    const child=spawnSync(python,['-c',script],{input:JSON.stringify(resolvedVariants.map(([,contract])=>contract)),
      encoding:'utf8',timeout:60000,env:{...process.env,PYTHONPATH:[resolve(root,'quant_lab','src'),process.env.PYTHONPATH].filter(Boolean).join(delimiter)}});
    if(child.error||/ModuleNotFoundError|No module named/.test(child.stderr??'')){
      assert.notEqual(process.env.PF2_REQUIRE_PYTHON,'1','PF2_REQUIRE_PYTHON=1: python runtime unavailable');
      st.skip('python runtime unavailable here; S4 covers the S1 validator');
      return;
    }
    assert.equal(child.status,0,child.stderr);
    const lines=child.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length,resolvedVariants.length);
    for(const line of lines)assert.equal(line,`2100 ${START+501*MINUTE+1100*MINUTE}`);
  });
});
