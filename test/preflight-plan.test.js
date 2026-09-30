import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';
import {FOUNDATION_LIMITS} from '../src/quant-research/foundation-contract.js';
import {validateHistoricalPreflightRequest} from '../src/quant-research/preflight-contract.js';
import {PREFLIGHT_PLAN_ERRORS,PREFLIGHT_RECORD_FIELDS,PREFLIGHT_RUNTIME_BUDGET,buildPreflightPlan,
  derivePreflightRecords,validatePreflightEnvelope} from '../src/quant-research/preflight-plan.js';
import {PF2_REPLAY_ENVELOPE_VERSION,PF2_REPLAY_LIMITATIONS,PF2_RESULT_VERSION,createLocalPythonRunner,
  runHistoricalPreflight} from '../src/quant-research/preflight-replay.js';
import {PF2_ENGINE_FILES,PF2_LIMITATIONS} from '../src/quant-research/preflight-resolver.js';
import {validateProfileResultV2} from '../src/quant-research/profile-contract-v2.js';
import {BOT,DEPLOYMENT,MINUTE,OWNER,START,createPf2Base,isDeepFrozen,makeWorld,modelRecord,planHash,
  policyRecord,venueRecord} from './helpers/pf2-fixture.js';

// Engineering fixture only: synthetic Pine source, synthetic bars, in-memory rows. No database, no network.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PLAN_FILE='src/quant-research/preflight-plan.js';
const TEST_FILE='test/preflight-plan.test.js';
const SHIM=resolve(root,'test','helpers','pf2_replay_shim.py');
const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
// Only an absolute interpreter path is ever spawned (see test/preflight-replay.test.js): a bare command
// name can resolve through an installer alias, so a non-absolute QUANT_RESEARCH_PYTHON means no interpreter.
const configuredPython=process.env.QUANT_RESEARCH_PYTHON;
const python=configuredPython?(path.isAbsolute(configuredPython)?configuredPython:null):
  (existsSync(localPython)?localPython:null);
const probeEnvironment={PYTHONPATH:resolve(root,'quant_lab','src'),PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};
for(const name of ['PATH','SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','TMPDIR'])
  if(process.env[name])probeEnvironment[name]=process.env[name];
const probe=python===null?null:spawnSync(python,['-B','-s','-c','import robot_quant.pf2_replay'],
  {encoding:'utf8',timeout:180000,env:probeEnvironment});
const pythonReady=probe!==null&&!(probe.error?.code==='ENOENT'||/ModuleNotFoundError|No module named/.test(probe.stderr??''));
const NO_PYTHON=python===null?
  'no absolute python interpreter (set QUANT_RESEARCH_PYTHON to an absolute path or create quant_lab/.venv)':
  'python runtime or quant dependencies unavailable here';

const clone=value=>structuredClone(value);
const sha=letter=>letter.repeat(64);
const ALLOWED_CODES=new Set(PREFLIGHT_PLAN_ERRORS);
const MARKER=String.raw`C:\secret-location\marker-4242`;

/** A Windows checkout may hold CRLF (core.autocrlf); only a lone CR or a trailing blank is a defect. */
function assertCleanText(text,label){
  const lines=text.replace(/\r\n/g,'\n');
  assert.equal(lines.includes('\r'),false,label+' CR');
  assert.equal(/[ \t]+$/m.test(lines),false,label+' trailing whitespace');
}

/** Error hygiene for every refusal: one known code, message===code, only code+status, no leaked value. */
function hygiene(error,status){
  assert.ok(ALLOWED_CODES.has(error.code),'unexpected code '+error.code);
  assert.equal(error.message,error.code);
  assert.equal('cause' in error,false);
  assert.deepEqual(Object.keys(error),['code','status']);
  if(status!==undefined)assert.equal(error.status,status);
  assert.equal([error.message,error.stack,JSON.stringify(error)].join('\n').includes(MARKER),false);
  return true;
}
const refuses=(operation,code,status)=>assert.throws(operation,error=>{
  hygiene(error,status);
  assert.equal(error.code,code);
  return true;
});
const resolverRejects=(promise,code)=>assert.rejects(promise,error=>{
  assert.equal(error.code,code);
  assert.equal(error.message,error.code);
  return true;
});
const accessor=(target,name)=>Object.defineProperty(target,name,{enumerable:true,configurable:true,
  get(){throw new Error(MARKER);}});

/** Synthetic wavy series: gives BUY signals with the shim inputs (the default sawtooth gives none). */
const wave=index=>Math.round((100+12*Math.sin(index/23)+4*Math.sin(index/2.1))*100)/100;
function waveBar(index){
  const close=wave(index),open=index===0?100:wave(index-1);
  return {time:START+index*MINUTE,open:open.toFixed(2),high:(Math.max(open,close)+1.2).toFixed(2),
    low:(Math.min(open,close)-1.2).toFixed(2),close:close.toFixed(2),volume:'2'};
}

test('PF-2 R1 plan builder, record derivation and envelope validator',async t=>{
  const base=await createPf2Base(t,{bar:waveBar});
  const baselinePolicy={...policyRecord(),blockDuringNews:false};
  const scenarioOf=(edits={})=>base.scenario({policy:baselinePolicy,...edits});
  const main=await scenarioOf();
  const rawOf=scenario=>scenario.enrollment.contract.dataset.metadata;
  const boundaryOf=scenario=>rawOf(scenario).end_time;
  /** Complete builder input over a fixture scenario: the rows a service would read under its locks. */
  const inputOf=(scenario=main,edit)=>{
    const {contract,result,capacity_policy:policy}=scenario.enrollment;
    const input={owner_id:OWNER,bot_id:BOT,deployment_id:DEPLOYMENT,
      enrollment:{contract:clone(contract),result:clone(result),contract_hash:hash(canonical(contract)),
        status:'SUCCEEDED'},
      deployment:{deployment_id:DEPLOYMENT,owner_id:OWNER,bot_id:BOT,state:'READY',
        snapshot:clone(scenario.snapshot),snapshot_hash:scenario.snapshotHash,pine_import_id:'pine-import-fixture-1',
        source_version:1,created_at:1},
      source:{source:scenario.source,source_hash:scenario.supportedSourceHash},
      boundary:{holdout_start_time:boundaryOf(scenario)},executables:{...base.executables},
      capacityPolicy:clone(policy),supportedSourceHash:scenario.supportedSourceHash};
    edit?.(input);
    return input;
  };
  const build=(scenario=main,edit)=>buildPreflightPlan(inputOf(scenario,edit));
  /** World whose trusted sources serve the scenario, with the built plan as the plan under resolve. */
  const worldFor=(built,scenario=main)=>{
    const world=makeWorld(base,scenario);
    world.plan=clone(built.plan);
    return world;
  };
  const deriveOf=(scenario=main,edit)=>{
    const input={snapshot:clone(scenario.snapshot),model:clone(scenario.enrollment.contract.profile.execution_model),
      source:scenario.source};
    edit?.(input);
    return derivePreflightRecords(input);
  };

  await t.test('static: pure import set, no I/O or clock, clean files, engine closure hashed',async()=>{
    const source=await readFile(path.join(root,PLAN_FILE),'utf8');
    const imports=[...source.matchAll(/^import\s.*?from\s*'([^']+)'/gms)].map(match=>match[1]).sort();
    assert.deepEqual(imports,['../money.js','../pine-bridge/source.js','./contract.js','./data-profile-v2.js',
      './foundation-contract-v2.js','./foundation-contract.js','./preflight-contract.js','./preflight-replay.js',
      './preflight-resolver.js','./profile-contract-v2.js']);
    for(const banned of ['node:','process.','Date.','performance','fetch(','Math.random','setTimeout','postgres','systemd',
      'spawn','readFile','writeFile','console.'])assert.equal(source.includes(banned),false,banned);
    for(const match of source.matchAll(/^import\s.*?from\s*'(\.[^']+)'/gm)){
      const file=path.posix.join('src/quant-research',match[1]);
      assert.ok(PF2_ENGINE_FILES.includes(path.posix.normalize(file)),file);
    }
    for(const file of [PLAN_FILE,TEST_FILE])assertCleanText(await readFile(path.join(root,file),'utf8'),file);
    assert.throws(()=>assertCleanText('a \nb','defect'),assert.AssertionError);
    assert.throws(()=>assertCleanText('a\rb','defect'),assert.AssertionError);
  });

  await t.test('budget constants: RD-3 values, inside the foundation limits, response cap holds',()=>{
    const budget=PREFLIGHT_RUNTIME_BUDGET;
    assert.ok(Object.isFrozen(budget));
    assert.deepEqual({...budget},{candidates:1,max_evaluations:1,chunk_bars:1000,max_runtime_ms:900000,
      max_output_bytes:524288,max_state_bytes:1048576,response_headroom_bytes:65536,response_cap_bytes:2097152});
    assert.ok(budget.max_runtime_ms<=FOUNDATION_LIMITS.runtimeMs&&budget.max_state_bytes<=FOUNDATION_LIMITS.stateBytes&&
      budget.max_output_bytes<=FOUNDATION_LIMITS.outputBytes&&budget.chunk_bars<=FOUNDATION_LIMITS.chunkBars);
    assert.ok(budget.max_state_bytes+budget.max_output_bytes+budget.response_headroom_bytes<=budget.response_cap_bytes);
    assert.deepEqual(Object.keys(PREFLIGHT_RECORD_FIELDS),['source','effective_inputs','bridge','policy','capital',
      'initial_state','execution_model','venue_metadata']);
    assert.ok(Object.isFrozen(PREFLIGHT_RECORD_FIELDS)&&Object.isFrozen(PREFLIGHT_PLAN_ERRORS));
  });

  await t.test('derive: hashes equal the fixture plan hashes and the quant-profile.js metadata formula',()=>{
    const derived=deriveOf();
    for(const [kind,field] of Object.entries(PREFLIGHT_RECORD_FIELDS)){
      assert.equal(derived.hashes[field],main.plan.snapshot[field],field);
      assert.equal(derived.hashes[field],planHash(kind,main.records[kind]),field);
      assert.equal(canonical(derived.records[kind]),canonical(main.records[kind]),kind);
    }
    assert.deepEqual(Object.keys(derived.hashes).sort(),Object.values(PREFLIGHT_RECORD_FIELDS).sort());
    // Independent statement of the QuantProfileService formula (src/postgres/quant-profile.js).
    const model=main.enrollment.contract.profile.execution_model;
    const metadata=hash(canonical({market:main.snapshot.market,price_tick:String(model.price_tick),
      quantity_step:String(model.quantity_step),data_profile:model.data_profile}));
    assert.equal(derived.hashes.venue_metadata_hash,metadata);
    assert.equal(metadata,main.enrollment.contract.profile.metadata_hash);
    assert.equal(derived.hashes.source_hash,hash(main.source));
    assert.equal(derived.hashes.effective_inputs_hash,main.enrollment.contract.profile.effective_inputs_hash);
    assert.equal(derived.hashes.execution_model_hash,hash(canonical(model)));
    assert.deepEqual(derived.records.initial_state,{kind:'FRESH',loss_streak:0});
    assert.deepEqual(derived.records.bridge,{atr_multiplier:'2',rr:'1.5'});
    assert.deepEqual(derived.records.capital,{cash:'800',equity:'1000'});
  });

  await t.test('derive: frozen, detached, deterministic, inputs untouched, model and policy spellings',async()=>{
    const input={snapshot:clone(main.snapshot),model:clone(main.enrollment.contract.profile.execution_model),
      source:main.source};
    const before=canonical(input);
    const derived=derivePreflightRecords(input);
    assert.equal(canonical(input),before);
    assert.ok(isDeepFrozen(derived));
    assert.equal(canonical(derivePreflightRecords(input)),canonical(derived));
    // Mutating the input afterwards cannot reach the derived copy.
    input.snapshot.policy.maxDailyLossR=99;
    input.snapshot.selection.bridge.rr=99;
    assert.equal(derived.records.policy.maxDailyLossR,baselinePolicy.maxDailyLossR);
    assert.equal(derived.records.bridge.rr,'1.5');
    // String model decimals give the same venue metadata (String() of the decimals) and a new model hash.
    const stringForm=deriveOf(main,in2=>{in2.model=modelRecord('string');});
    assert.equal(stringForm.hashes.venue_metadata_hash,derived.hashes.venue_metadata_hash);
    assert.notEqual(stringForm.hashes.execution_model_hash,derived.hashes.execution_model_hash);
    // A numeric policy spelling (floats) hashes as itself: the record is verbatim.
    const numeric=await scenarioOf({policy:policyRecord('numeric')});
    const numericDerived=deriveOf(numeric);
    assert.equal(numericDerived.hashes.policy_hash,numeric.plan.snapshot.policy_hash);
    assert.equal(numericDerived.hashes.policy_hash,hash(canonical(policyRecord('numeric'))));
    assert.notEqual(numericDerived.hashes.policy_hash,derived.hashes.policy_hash);
  });

  await t.test('derive: every unsupported or inconsistent snapshot part fails closed with a fixed code',()=>{
    const unsupported='PREFLIGHT_DEPLOYMENT_UNSUPPORTED';
    const rehash=snapshot=>{snapshot.policy_hash=hash(canonical(snapshot.policy));};
    const values=snapshot=>hash(canonical(Object.fromEntries(
      snapshot.membership[0].analysis.inputs.map(item=>[item.input_id,item.effective_value]))));
    const cases=[
      ['two members',s=>{s.membership.push(clone(s.membership[0]));},unsupported],
      ['no member',s=>{s.membership=[];},unsupported],
      ['policy not paper',s=>{s.policy.paperTrading=false;rehash(s);},unsupported],
      ['policy not reduce-only',s=>{s.policy.requireReduceOnlySell=false;rehash(s);},unsupported],
      ['policy float edited, hash kept',s=>{s.policy.maxDailyLossR=3.0000001;},'SNAPSHOT_HASH_MISMATCH'],
      ['policy hash swapped',s=>{s.policy_hash=sha('7');},'SNAPSHOT_HASH_MISMATCH'],
      ['market symbol',s=>{s.market.symbol='ETHUSDT';},unsupported],
      ['market broker',s=>{s.market.broker='binance-us';},unsupported],
      ['market timeframe',s=>{s.market.timeframe='5';},unsupported],
      ['signals',s=>{s.selection.signals.buy='otherSignal';},unsupported],
      ['no bridge',s=>{delete s.selection.bridge;},unsupported],
      ['bridge text',s=>{s.selection.bridge.rr='abc';},unsupported],
      ['bridge too many decimals',s=>{s.selection.bridge.rr='1.1234567890123456789';},unsupported],
      ['capital broker',s=>{s.capital[0].broker='binance-us';},unsupported],
      ['capital twice',s=>{s.capital.push(clone(s.capital[0]));},unsupported],
      ['capital not a number',s=>{s.capital[0].configuredBalance='lots';},unsupported],
      ['capital missing',s=>{delete s.capital[0].configuredEquity;},unsupported],
      ['analysis value, hash kept',s=>{s.membership[0].analysis.inputs[0].effective_value=21;},unsupported],
      ['analysis value and hash',s=>{
        s.membership[0].analysis.inputs[0].effective_value=21;
        s.membership[0].analysis.effective_inputs_hash=values(s);},null],
      ['analysis duplicate input id',s=>{
        s.membership[0].analysis.inputs[1].input_id=s.membership[0].analysis.inputs[0].input_id;},unsupported],
      ['analysis inputs missing',s=>{delete s.membership[0].analysis.inputs;},unsupported],
      ['member source hash',s=>{s.membership[0].source_hash=sha('8');},'UNSUPPORTED_SOURCE_HASH'],
      ['snapshot source hash',s=>{s.source_hash=sha('8');},'UNSUPPORTED_SOURCE_HASH'],
      ['not an object',(s,input)=>{input.snapshot=[];},unsupported]];
    for(const [name,edit,code] of cases){
      const run=()=>deriveOf(main,input=>edit(input.snapshot,input));
      if(code===null){
        // Self-consistent edits derive a different record set instead of failing.
        assert.notEqual(run().hashes.effective_inputs_hash,main.plan.snapshot.effective_inputs_hash,name);
      }else refuses(run,code,409);
    }
    for(const [name,source] of [['empty',''],['appended',main.source+' '],['lone surrogate',main.source+'\ud800'],
      ['not text',7],['oversized','x'.repeat(256*1024+1)]])
      refuses(()=>deriveOf(main,input=>{input.source=source;}),'UNSUPPORTED_SOURCE_HASH',409);
  });

  await t.test('derive: V2 or malformed model, malformed arguments and hostile values are refused',()=>{
    const parity='PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED',enrollment='PREFLIGHT_ENROLLMENT_REQUIRED';
    for(const version of ['paper-close-v2','paper-close-cost-v2','V2'])
      refuses(()=>deriveOf(main,input=>{input.model.version=version;}),parity,409);
    const models=[['data profile',m=>{m.data_profile='other';}],['missing key',m=>{delete m.fee_bps;}],
      ['extra key',m=>{m.extra=1;}],['tick not a decimal',m=>{m.price_tick=null;}],['version missing',m=>{delete m.version;}],
      ['version number',m=>{m.version=1;}]];
    for(const [name,edit] of models)refuses(()=>deriveOf(main,input=>edit(input.model)),enrollment,409);
    refuses(()=>deriveOf(main,input=>{input.model=null;}),enrollment,409);
    for(const junk of [null,undefined,[],'x',7])refuses(()=>derivePreflightRecords(junk),'INVALID_PREFLIGHT_CONTRACT',409);
    refuses(()=>derivePreflightRecords({snapshot:main.snapshot,model:main.records.execution_model}),
      'INVALID_PREFLIGHT_CONTRACT',409);
    refuses(()=>deriveOf(main,input=>{input.extra=1;}),'INVALID_PREFLIGHT_CONTRACT',409);
    refuses(()=>deriveOf(main,input=>accessor(input,'model')),'INVALID_PREFLIGHT_CONTRACT',409);
    refuses(()=>deriveOf(main,input=>accessor(input.snapshot,'policy')),'PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
    refuses(()=>deriveOf(main,input=>{input.snapshot.membership[0].analysis.self=input.snapshot;}),
      'PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
    const proxy=new Proxy(clone(main.snapshot),{get(){throw new Error(MARKER);},
      getOwnPropertyDescriptor(target,name){return Reflect.getOwnPropertyDescriptor(target,name);}});
    refuses(()=>deriveOf(main,input=>{input.snapshot=proxy;}),'PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
  });

  await t.test('builder: frozen plan, RD-3 budget, hashes bound, passes the contract validator and the S3 resolver',async()=>{
    const input=inputOf();
    const before=canonical(input);
    const built=buildPreflightPlan(input);
    assert.equal(canonical(input),before);
    assert.deepEqual(Object.keys(built).sort(),['contract_hash','hashes','plan','plan_hash','plan_json','records']);
    assert.ok(Object.isFrozen(built)&&isDeepFrozen(built.plan)&&isDeepFrozen(built.records)&&isDeepFrozen(built.hashes));
    assert.equal(canonical(buildPreflightPlan(inputOf())),canonical(built));
    const raw=rawOf(main),{plan}=built;
    assert.equal(plan.version,'historical-preflight-v1');
    assert.deepEqual(plan.foundation,{version:'quant-foundation-v1',owner_id:OWNER,bot_id:BOT,kind:'PREFLIGHT',
      dataset:main.enrollment.contract.dataset,engine_hash:base.executables.engine_hash,
      snapshot_hash:hash(canonical(plan.snapshot)),
      budget:{candidates:1,max_evaluations:1,chunk_bars:Math.min(1000,raw.total_bars),max_runtime_ms:900000,
        max_output_bytes:524288,max_state_bytes:1048576}});
    assert.deepEqual(plan.snapshot,{version:'pf2-snapshot-v1',...built.hashes,execution_model_version:'paper-close-v1',
      signal:{mode:'EVALUATOR',evaluator_hash:base.executables.evaluator_hash,artifact_sha256:null},
      development:{start_time:raw.start_time,end_time:raw.end_time,holdout_start_time:raw.end_time}});
    for(const [kind,field] of Object.entries(PREFLIGHT_RECORD_FIELDS))
      assert.equal(plan.snapshot[field],planHash(kind,main.records[kind]),field);
    assert.equal(built.plan_json,canonical(plan));
    assert.equal(built.plan_hash,hash(built.plan_json));
    assert.equal(built.contract_hash,hash(canonical(plan.foundation)));
    assert.equal(canonical(validateHistoricalPreflightRequest(clone(plan))),built.plan_json);
    // The resolver takes the built plan with fixture trusted sources and computes the same plan hash.
    const world=worldFor(built);
    const resolved=await world.resolve();
    assert.equal(resolved.plan_hash,built.plan_hash);
    assert.equal(resolved.owner_id,OWNER);
    assert.deepEqual(resolved.budget,{chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:524288,
      max_state_bytes:1048576});
    assert.equal(resolved.contract.limits.max_output_bytes,524288);
    assert.equal(resolved.identities.engine_hash,base.executables.engine_hash);
    for(const field of Object.values(PREFLIGHT_RECORD_FIELDS))assert.equal(resolved.identities[field],built.hashes[field]);
    assert.deepEqual(resolved.admission,{development_only:true,evaluator_admission:false,holdout_accessed:false,
      orders_executed:false,execution_model_parity:'V1_ONLY'});
    // Every input carries the stored contract hash and the SUCCEEDED status; both are required (defect cases).
    assert.equal(input.enrollment.contract_hash,hash(canonical(main.enrollment.contract)));
    assert.equal(input.enrollment.status,'SUCCEEDED');
  });

  await t.test('builder: each supported holdout boundary and the raw-end rule',async()=>{
    const raw=rawOf(main),end=raw.end_time;
    const later=end+7*24*60*MINUTE;
    const built=build(main,input=>{input.boundary={holdout_start_time:later};});
    assert.equal(built.plan.snapshot.development.holdout_start_time,later);
    assert.equal(built.plan.snapshot.development.end_time,end);
    const resolved=await (()=>{const world=worldFor(built);world.holdout.value=later;return world.resolve();})();
    assert.equal(resolved.dataset.holdout_start_time,later);
    // The boundary equal to the raw end is allowed; one minute earlier exposes the last bar to holdout.
    assert.equal(build(main,input=>{input.boundary={holdout_start_time:end};}).plan.snapshot.development.holdout_start_time,end);
    for(const time of [end-MINUTE,end-1,START])
      refuses(()=>build(main,input=>{input.boundary={holdout_start_time:time};}),
        time===end-1?'PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED':'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED',409);
    for(const [name,boundary] of [['missing',undefined],['null',null],['number',end],['string',{holdout_start_time:String(end)}],
      ['float',{holdout_start_time:end+0.5}],['unaligned',{holdout_start_time:end+1}],['zero',{holdout_start_time:0}],
      ['negative',{holdout_start_time:-MINUTE}],['too late',{holdout_start_time:253_402_300_799_999+1}],
      ['extra key',{holdout_start_time:end,note:'x'}],['array',[end]],['unsafe',{holdout_start_time:2**53}]])
      refuses(()=>build(main,input=>{input.boundary=boundary;}),'PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED',409);
    refuses(()=>build(main,input=>{delete input.boundary;}),'INVALID_PREFLIGHT_CONTRACT',409);
  });

  /** The enrollment re-stated for another raw bar count. Structure only: no dataset bytes are read. */
  const scaledInput=(total,warmup=1600)=>inputOf(main,input=>{
    const {contract,result}=input.enrollment;
    const meta=contract.dataset.metadata;
    meta.total_bars=total;meta.warmup_bars=warmup;meta.end_time=meta.start_time+total*MINUTE;meta.cutoff=meta.end_time;
    const chunk=Math.min(1000,total-500);
    contract.capacity.dataset={raw_bars:total,seed_bars:500,warmup_bars:warmup,evaluation_bars:total-warmup,
      processed_bars:total-500};
    contract.capacity.chunk_bars=chunk;contract.budget.chunk_bars=chunk;
    result.raw=clone(contract.dataset);
    result.references.raw.metadata=deriveClosedMetadataV2(contract.dataset);
    result.references.sidecar.bar_count=total-500;
    const binding=result.binding;
    binding.bar_count=total-500;
    const {binding_sha256:old,...payload}=binding;
    void old;
    binding.binding_sha256=hash(canonical(payload));
    input.enrollment.contract_hash=hash(canonical(contract));
    input.boundary={holdout_start_time:meta.end_time};
  });

  await t.test('builder: 10K raw-bar ceiling counts warm-up; chunk size is min(1000, total)',()=>{
    const ceiling=buildPreflightPlan(scaledInput(FOUNDATION_LIMITS.admittedBars));
    assert.equal(ceiling.plan.foundation.dataset.metadata.total_bars,10000);
    assert.equal(ceiling.plan.foundation.budget.chunk_bars,1000);
    assert.equal(ceiling.plan.snapshot.development.end_time,ceiling.plan.foundation.dataset.metadata.end_time);
    // Marked enrollment now rejects oversized datasets before the plan's own ceiling.
    // Keep the historical unmarked contract check to exercise that independent ceiling.
    for(const total of [10001,50000,8500+1600]){
      const oversized=scaledInput(total);
      refuses(()=>buildPreflightPlan(oversized),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
      delete oversized.enrollment.contract.completion_mode;
      oversized.enrollment.contract_hash=hash(canonical(oversized.enrollment.contract));
      refuses(()=>buildPreflightPlan(oversized),'FOUNDATION_CAPABILITY_LIMIT',409);
    }
    const small=buildPreflightPlan(scaledInput(900,500));
    assert.equal(small.plan.foundation.budget.chunk_bars,900);
    assert.equal(small.plan.foundation.dataset.metadata.total_bars,900);
    assert.equal(FOUNDATION_LIMITS.admittedBars,10000);
  });

  await t.test('builder: a V2 or unknown cost model is refused, the plan is always paper-close-v1',()=>{
    const parity='PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED';
    for(const version of ['paper-close-v2','paper-close-cost-v2','V2'])
      refuses(()=>build(main,input=>{input.enrollment.contract.profile.execution_model.version=version;}),parity,409);
    refuses(()=>deriveOf(main,input=>{input.model.version='paper-close-v2';}),parity,409);
    assert.equal(build().plan.snapshot.execution_model_version,'paper-close-v1');
    const forged=clone(build().plan);
    forged.snapshot.execution_model_version='paper-close-v2';
    forged.foundation.snapshot_hash=hash(canonical(forged.snapshot));
    assert.throws(()=>validateHistoricalPreflightRequest(forged),{code:parity});
  });

  await t.test('builder: every enrollment, deployment, source and argument defect is a fixed code, no row',()=>{
    const enrollment='PREFLIGHT_ENROLLMENT_REQUIRED',deployment='PREFLIGHT_DEPLOYMENT_UNSUPPORTED';
    const source='UNSUPPORTED_SOURCE_HASH',invalid='INVALID_PREFLIGHT_CONTRACT',mismatch='SNAPSHOT_HASH_MISMATCH';
    const notReady='RESEARCH_DEPLOYMENT_NOT_READY',other='deployment-other-1';
    const cases=[
      ['owner mismatch',i=>{i.enrollment.contract.owner_id='owner-b';},enrollment],
      ['bot mismatch',i=>{i.enrollment.contract.bot_id='other-bot';},enrollment],
      ['profile deployment id',i=>{i.deployment_id=other;i.deployment.deployment_id=other;},enrollment],
      ['contract v1',i=>{i.enrollment.contract.version='quant-foundation-v1';},enrollment],
      ['contract kind',i=>{i.enrollment.contract.kind='BACKFILL';},enrollment],
      ['contract without profile',i=>{delete i.enrollment.contract.profile;},enrollment],
      ['result null',i=>{i.enrollment.result=null;},enrollment],
      ['result unverified',i=>{i.enrollment.result.data_profile_verified=false;},enrollment],
      ['result admission flipped',i=>{i.enrollment.result.evaluator_admission=true;},enrollment],
      ['blockers dropped',i=>{i.enrollment.result.acceptance_blockers=['A_ONE','B_TWO'];},enrollment],
      ['binding forged',i=>{i.enrollment.result.binding.binding_sha256=sha('6');},enrollment],
      ['capacity policy rotated',i=>{i.capacityPolicy.evidence.calibration_sha256=sha('6');},enrollment],
      ['capacity policy missing',i=>{i.capacityPolicy=null;},enrollment],
      ['stored contract hash',i=>{i.enrollment.contract_hash=sha('6');},enrollment],
      ['row not succeeded',i=>{i.enrollment.status='RUNNING';},enrollment],
      ['row status not text',i=>{i.enrollment.status=null;},enrollment],
      ['stored contract hash missing',i=>{delete i.enrollment.contract_hash;},enrollment],
      ['row status missing',i=>{delete i.enrollment.status;},enrollment],
      ['stored contract hash not text',i=>{i.enrollment.contract_hash=7;},enrollment],
      ['enrollment extra key',i=>{i.enrollment.extra=1;},enrollment],
      ['enrollment null',i=>{i.enrollment=null;},enrollment],
      ['enrollment getter',i=>{accessor(i.enrollment,'result');},enrollment],
      ['deployment not ready',i=>{i.deployment.state='EXIT_ONLY';},notReady],
      ['deployment revoked',i=>{i.deployment.state='REVOKED';},notReady],
      ['deployment owner',i=>{i.deployment.owner_id='owner-b';},deployment],
      ['deployment bot',i=>{i.deployment.bot_id='other-bot';},deployment],
      ['deployment row id',i=>{i.deployment.deployment_id=other;},deployment],
      ['deployment column missing',i=>{delete i.deployment.snapshot_hash;},deployment],
      ['deployment null',i=>{i.deployment=null;},deployment],
      ['snapshot hash stored wrong',i=>{i.deployment.snapshot_hash=sha('5');},mismatch],
      ['snapshot hash not text',i=>{i.deployment.snapshot_hash=7;},mismatch],
      ['snapshot edited, hash kept',i=>{i.deployment.snapshot.captured_at+=1;},mismatch],
      ['snapshot edited, row rehashed',i=>{i.deployment.snapshot.captured_at+=1;
        i.deployment.snapshot_hash=hash(canonical(i.deployment.snapshot));},mismatch],
      ['production source hash by default',i=>{delete i.supportedSourceHash;},source],
      ['source text edited',i=>{i.source.source+=' ';},source],
      ['source hash swapped',i=>{i.source.source_hash=sha('4');},source],
      ['source row null',i=>{i.source=null;},source],
      ['supported hash malformed',i=>{i.supportedSourceHash='x';},invalid],
      ['owner id',i=>{i.owner_id='';},invalid],['bot id',i=>{i.bot_id='bad id';},invalid],
      ['owner id number',i=>{i.owner_id=7;},invalid],['bot id number',i=>{i.bot_id=7;},invalid],
      ['owner id object',i=>{i.owner_id={toString(){return OWNER;}};},invalid],
      ['bot id object',i=>{i.bot_id={toString(){return BOT;}};},invalid],
      ['deployment id text',i=>{i.deployment_id='x';},invalid],
      ['executables missing',i=>{delete i.executables.evaluator_hash;},invalid],
      ['executables equal',i=>{i.executables.evaluator_hash=i.executables.engine_hash;},invalid],
      ['executables not sha',i=>{i.executables.engine_hash='abc';},invalid],
      ['unknown key',i=>{i.extra=1;},invalid],['getter argument',i=>{accessor(i,'source');},invalid]];
    for(const [name,edit,code] of cases){
      const input=inputOf(main,edit);
      assert.throws(()=>buildPreflightPlan(input),error=>{
        hygiene(error,409);
        assert.equal(error.code,code,name);
        return true;
      },name);
    }
    for(const junk of [null,undefined,[],'x',7])refuses(()=>buildPreflightPlan(junk),invalid,409);
  });

  await t.test('builder: an enrollment that does not match the derived records is refused',async()=>{
    const enrollment='PREFLIGHT_ENROLLMENT_REQUIRED';
    // Each enrollment is otherwise fully valid (real binding over the real datasets): only the
    // cross-check of the profile hash against the derived record refuses it.
    for(const [enrollmentOptions,profileField,derivedField] of [
      [{settingsHash:sha('9')},'effective_inputs_hash','effective_inputs_hash'],
      [{sourceHash:sha('8')},'source_hash','source_hash'],
      [{venue:venueRecord(modelRecord(),{source_version:2})},'metadata_hash','venue_metadata_hash']]){
      const scenario=await scenarioOf({enrollmentOptions});
      const {contract,result,capacity_policy:policy}=scenario.enrollment;
      assert.doesNotThrow(()=>validateProfileResultV2(contract,result,{policy}));
      assert.notEqual(contract.profile[profileField],deriveOf(scenario).hashes[derivedField]);
      refuses(()=>build(scenario),enrollment,409);
    }
  });

  await t.test('builder: a snapshot venue of another deployment is refused at enqueue',async()=>{
    const scenario=await scenarioOf({market:{deployment_id:'deployment-other-1'},
      enrollmentOptions:{deploymentId:DEPLOYMENT}});
    const {contract,result,capacity_policy:policy}=scenario.enrollment;
    // Enrollment, deployment row and snapshot are otherwise consistent: only the venue deployment id differs.
    assert.doesNotThrow(()=>validateProfileResultV2(contract,result,{policy}));
    assert.equal(contract.profile.deployment_id,DEPLOYMENT);
    assert.equal(scenario.snapshot.market.deployment_id,'deployment-other-1');
    assert.equal(hash(canonical(scenario.snapshot)),contract.snapshot_hash);
    refuses(()=>build(scenario),'PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
  });

  await t.test('tamper: policy float, capital broker, bridge decimals and membership analysis never reach a run',async()=>{
    const built=build();
    const values=snapshot=>hash(canonical(Object.fromEntries(
      snapshot.membership[0].analysis.inputs.map(item=>[item.input_id,item.effective_value]))));
    const tampers=[
      {name:'policy float',kind:'policy',edit:s=>{
        s.policy.maxDailyLossR=3.0000001;s.policy_hash=hash(canonical(s.policy));}},
      {name:'capital broker',kind:null,edit:s=>{s.capital[0].broker='binance-us';}},
      {name:'bridge decimals',kind:'bridge',edit:s=>{s.selection.bridge.atr_multiplier=2.5;}},
      {name:'membership analysis',kind:'effective_inputs',edit:s=>{
        const analysis=s.membership[0].analysis;
        analysis.inputs[0].effective_value=21;analysis.effective_inputs_hash=values(s);}}];
    assert.equal((await worldFor(built).resolve()).plan_hash,built.plan_hash);
    for(const {name,kind,edit} of tampers){
      const snapshot=clone(main.snapshot);
      edit(snapshot);
      // A deployment row that carries the tampered snapshot no longer matches the enrollment.
      refuses(()=>build(main,input=>{input.deployment.snapshot=clone(snapshot);
        input.deployment.snapshot_hash=hash(canonical(snapshot));}),'SNAPSHOT_HASH_MISMATCH',409);
      const derive=()=>deriveOf(main,input=>{input.snapshot=clone(snapshot);});
      if(kind===null)refuses(derive,'PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
      else{
        // The record derived from the tampered snapshot, served under the plan's own key, is refused.
        const field=PREFLIGHT_RECORD_FIELDS[kind],derived=derive();
        assert.notEqual(derived.hashes[field],built.hashes[field],name);
        const world=worldFor(built);
        world.records.set(world.key(OWNER,BOT,kind,built.hashes[field]),clone(derived.records[kind]));
        await resolverRejects(world.resolve(),'PF2_INPUT_HASH_MISMATCH');
      }
      // The tampered snapshot served as the authoritative deployment record is refused too.
      const world=worldFor(built);
      world.records.set(world.key(OWNER,BOT,'deployment_snapshot',main.snapshotHash),clone(snapshot));
      await resolverRejects(world.resolve(),'PF2_INPUT_HASH_MISMATCH');
    }
  });

  await t.test('tamper: a hash swapped in the built plan leaves the resolver without a trusted record',async()=>{
    const built=build();
    for(const field of Object.values(PREFLIGHT_RECORD_FIELDS)){
      const world=worldFor(built);
      world.plan.snapshot[field]=sha('1');
      world.seal();
      await assert.rejects(world.resolve(),error=>{
        assert.match(error.code,/^PF2_/,field);
        assert.equal(error.message,error.code);
        return true;
      },field);
    }
  });

  // --- envelope validator -------------------------------------------------------------------
  const S1_LIMITATIONS=['V1_ONLY','DEVELOPMENT_ONLY','EVALUATOR_ADMISSION_FALSE','DIAGNOSTIC_ONLY',
    'SIZING_ADJUSTED_INCLUDES_QUANTITY_STEP_ROUNDING'];
  const ENVELOPE_LIMITATIONS=[...new Set([...PF2_LIMITATIONS,...S1_LIMITATIONS,...PF2_REPLAY_LIMITATIONS])];
  const ADMISSION={development_only:true,evaluator_admission:false,holdout_accessed:false,orders_executed:false,
    execution_model_parity:'V1_ONLY'};
  const builtMain=build();
  const resolvedMain=await worldFor(builtMain).resolve();
  const invalidEnvelope=(contract,envelope,options,message)=>assert.throws(
    ()=>validatePreflightEnvelope(contract,envelope,options),error=>{
      hygiene(error,500);
      assert.equal(error.code,'PREFLIGHT_ENVELOPE_INVALID',message);
      return true;
    },message);
  /** A hand-made result that satisfies every S4 invariant: no Python needed. */
  const fakeResult=(resolved,planHash,shape='traded')=>{
    const d=resolved.dataset,S=d.evaluation_start_time;
    const window={first_time:d.first_time,evaluation_start_time:S,last_time:d.last_time,
      development_end_time:d.development_end_time,holdout_start_time:d.holdout_start_time,bars_seen:d.total_bars,
      warmup_bars:d.warmup_bars,evaluated_bars:d.total_bars-d.warmup_bars};
    const fill=(offset,type,reason)=>({time:S+offset*MINUTE,event_type:type,entry_ref:DEPLOYMENT+':'+offset,reason,
      sizing_outcome:'ACCEPTED',quantity:'0.5',price:'100.5',notional:'50.25',fee:'0.05'});
    const traded={counters:{signals:{buy:2,native_exit:1,buy_evaluated:2,native_exit_evaluated:1},
      intents:{buy:2,exit_sl:1,exit_tp:0,exit_native:0},warmup_intents:{buy:0,exit:0},
      orders:{accepted:2,sizing_adjusted:1,rejected:0,rejected_by_reason:{}},
      fills:{buy:2,exit:1,exit_by_reason:{SL:1}},episodes:{closed:1,losing:1}},
    derived:{intents_evaluated:3,suppressed_buy:0,suppressed_buy_evaluated:0,non_losing_episodes:0},
    guards:{kill_switch:false,loss_streak_final:1,pause:{persistent:false,active_kinds:[],periods:[],
      truncated:false,dropped_periods:0}},
    account:{cash:'749.7',position_quantity:'0.5',position_cost:'50.25',open_allocations:1},
    samples:{fills:[fill(5,'BUY',null),fill(9,'EXIT','SL'),fill(20,'BUY',null)],rejections:[]}};
    // Every intent rejected once, under a reason name that looks like an ETA key.
    const rejected={counters:{signals:{buy:1,native_exit:0,buy_evaluated:1,native_exit_evaluated:0},
      intents:{buy:1,exit_sl:0,exit_tp:0,exit_native:0},warmup_intents:{buy:0,exit:0},
      orders:{accepted:0,sizing_adjusted:0,rejected:1,rejected_by_reason:{eta_guard:1}},
      fills:{buy:0,exit:0,exit_by_reason:{}},episodes:{closed:0,losing:0}},
    derived:{intents_evaluated:1,suppressed_buy:0,suppressed_buy_evaluated:0,non_losing_episodes:0},
    guards:{kill_switch:false,loss_streak_final:0,pause:{persistent:false,active_kinds:[],periods:[],
      truncated:false,dropped_periods:0}},
    account:{cash:'800',position_quantity:'0',position_cost:'0',open_allocations:0},
    samples:{fills:[],rejections:[{time:S+3*MINUTE,event_type:'BUY',entry_ref:DEPLOYMENT+':3',reason:'eta_guard'}]}};
    return {version:PF2_RESULT_VERSION,plan_hash:planHash,execution_model_version:'paper-close-v1',window,
      ...(shape==='traded'?traded:rejected),admission:{...ADMISSION},limitations:[...S1_LIMITATIONS]};
  };
  const envelopeOf=(resolved,planHash,result,run)=>({version:PF2_REPLAY_ENVELOPE_VERSION,plan_hash:planHash,
    owner_id:resolved.owner_id,bot_id:resolved.bot_id,
    binding:{contract_sha256:sha('1'),resolved_sha256:sha('2'),contract_digest:sha('3'),
      engine_hash:resolved.identities.engine_hash,evaluator_hash:resolved.identities.evaluator_hash,
      raw_dataset_sha256:resolved.identities.raw_dataset_sha256,
      closed_dataset_sha256:resolved.identities.closed_dataset_sha256,atr14_sha256:resolved.identities.atr14_sha256,
      enrollment_binding_sha256:resolved.identities.enrollment_binding_sha256},
    dataset:{first_time:resolved.dataset.first_time,evaluation_start_time:resolved.dataset.evaluation_start_time,
      last_time:resolved.dataset.last_time,total_bars:resolved.dataset.total_bars,
      warmup_bars:resolved.dataset.warmup_bars,development_end_time:resolved.dataset.development_end_time,
      holdout_start_time:resolved.dataset.holdout_start_time},
    run:run??{chunk_bars:resolved.budget.chunk_bars,
      chunks_executed:Math.ceil(resolved.dataset.total_bars/resolved.budget.chunk_bars),resumed_from_bar:0},
    result,admission:{...ADMISSION},acceptance_blockers:[...resolved.acceptance_blockers],
    limitations:[...new Set([...resolved.limitations,...result.limitations,...PF2_REPLAY_LIMITATIONS])]});
  const fakeOf=(shape='traded',edit)=>{
    const envelope=envelopeOf(resolvedMain,builtMain.plan_hash,fakeResult(resolvedMain,builtMain.plan_hash,shape));
    edit?.(envelope);
    return envelope;
  };
  // The stored plan is required next to its hash: both come from the same job row.
  const foundation=builtMain.plan.foundation,options={planHash:builtMain.plan_hash,plan:builtMain.plan};
  const validOptions=[options];

  await t.test('envelope: a consistent S4 envelope is accepted as a deep-frozen detached copy',()=>{
    for(const shape of ['traded','rejected'])for(const option of validOptions){
      const envelope=fakeOf(shape);
      const before=canonical(envelope);
      const checked=validatePreflightEnvelope(foundation,envelope,option);
      assert.equal(canonical(envelope),before);
      assert.equal(canonical(checked),before);
      assert.ok(isDeepFrozen(checked));
      assert.notEqual(checked,envelope);
      envelope.result.counters.signals.buy=99;
      assert.equal(checked.result.counters.signals.buy,shape==='traded'?2:1);
    }
    assert.deepEqual(fakeOf().limitations,ENVELOPE_LIMITATIONS);
    // A reason name that looks like an ETA key is data, not a schema key (the S4 scan skips that object).
    assert.deepEqual(Object.keys(fakeOf('rejected').result.counters.orders.rejected_by_reason),['eta_guard']);
  });

  await t.test('envelope: an ETA, estimate or collection key anywhere is refused',()=>{
    // The strict key sets refuse these keys too (defense in depth): the scan is the contract's explicit rule.
    const places=[['top level',e=>{e.eta_ms=5;}],['top level estimate',e=>{e.estimated_finish=1;}],
      ['run',e=>{e.run.eta=9;}],['dataset',e=>{e.dataset.collection_time=1;}],['binding',e=>{e.binding.time_estimate=1;}],
      ['result window',e=>{e.result.window.estimated_completion=1;}],
      ['result counters',e=>{e.result.counters.signals.collection_ms=1;}],
      ['guards',e=>{e.result.guards.pause.eta_seconds=null;}],
      ['sample entry',e=>{e.result.samples.fills[0].eta_s=1;}],
      ['nested object',e=>{e.result.derived.progress={eta:1};}],['upper case',e=>{e.ETA=1;}],
      ['snake middle',e=>{e.run.time_eta_ms=1;}]];
    for(const [name,edit] of places)for(const option of validOptions)
      invalidEnvelope(foundation,fakeOf('traded',edit),option,name);
    // The same key inside the rejection-reason map of a rejected run is still only data.
    invalidEnvelope(foundation,fakeOf('rejected',e=>{e.result.counters.orders.other={eta_guard:1};}),options,'other map');
  });

  await t.test('envelope: an admission flip is refused, in the envelope and in the result',()=>{
    for(const [name,value] of [['development_only',false],['evaluator_admission',true],['holdout_accessed',true],
      ['orders_executed',true],['execution_model_parity','V2']])for(const target of ['envelope','result'])
      for(const option of validOptions)
        invalidEnvelope(foundation,fakeOf('traded',e=>{(target==='envelope'?e.admission:e.result.admission)[name]=value;}),
          option,target+' '+name);
    for(const [name,edit] of [['extra key',e=>{e.admission.recommendation='APPLY';}],
      ['missing key',e=>{delete e.admission.holdout_accessed;}],['not an object',e=>{e.admission=null;}],
      ['result admission swapped',e=>{e.result.admission=[];}]])
      invalidEnvelope(foundation,fakeOf('traded',edit),options,name);
    for(const [name,edit] of [['blockers emptied',e=>{e.acceptance_blockers=[];}],
      ['parity blocker dropped',e=>{e.acceptance_blockers=['SOURCE_SETTINGS_CAPABILITY_REQUIRED','OTHER_ONE'];}],
      ['settings blocker dropped',e=>{e.acceptance_blockers=['EVALUATOR_PARITY_REQUIRED'];}],
      ['blocker duplicated',e=>{e.acceptance_blockers.push(e.acceptance_blockers[0]);}],
      ['blocker not text',e=>{e.acceptance_blockers.push(7);}]])
      invalidEnvelope(foundation,fakeOf('traded',edit),options,name);
  });

  await t.test('envelope: a swapped plan hash is refused, the plan hash comes from the trusted row',()=>{
    for(const [name,edit] of [['envelope plan hash',e=>{e.plan_hash=sha('a');}],
      ['result plan hash',e=>{e.result.plan_hash=sha('a');}],
      ['both swapped together',e=>{e.plan_hash=sha('a');e.result.plan_hash=sha('a');}],
      ['not a hash',e=>{e.plan_hash='x';}]])
      for(const option of validOptions)invalidEnvelope(foundation,fakeOf('traded',edit),option,name);
    // The trusted plan hash rules: a self-consistent envelope for another plan fails against this row.
    const swapped=fakeOf('traded',e=>{e.plan_hash=sha('a');e.result.plan_hash=sha('a');});
    invalidEnvelope(foundation,swapped,options,'row hash');
    invalidEnvelope(foundation,swapped,{planHash:sha('a'),plan:builtMain.plan},'plan does not hash to the row hash');
    invalidEnvelope(foundation,fakeOf(),{planHash:sha('a'),plan:builtMain.plan},'wrong row hash');
    invalidEnvelope(foundation,fakeOf(),{planHash:'x',plan:builtMain.plan},'malformed row hash');
    // The stored plan must hash to the row hash and equal the contract.
    const other=build(main,input=>{input.boundary={holdout_start_time:boundaryOf(main)+MINUTE};});
    invalidEnvelope(foundation,fakeOf(),{planHash:builtMain.plan_hash,plan:other.plan},'other plan');
    invalidEnvelope(other.plan.foundation,fakeOf(),options,'other contract');
    // The stored plan also binds the evaluator identity and the development and holdout times.
    for(const [name,edit] of [['evaluator identity',p=>{p.snapshot.signal.evaluator_hash=sha('b');}],
      ['holdout start',p=>{p.snapshot.development.holdout_start_time+=MINUTE;}],
      ['development end and holdout',p=>{p.snapshot.development.end_time+=MINUTE;
        p.snapshot.development.holdout_start_time+=MINUTE;}]]){
      const forged=clone(builtMain.plan);
      edit(forged);
      forged.foundation.snapshot_hash=hash(canonical(forged.snapshot));
      const forgedHash=hash(canonical(forged));
      const envelope=fakeOf('traded',e=>{e.plan_hash=forgedHash;e.result.plan_hash=forgedHash;});
      assert.doesNotThrow(()=>validateHistoricalPreflightRequest(clone(forged)),name);
      invalidEnvelope(forged.foundation,envelope,{planHash:forgedHash,plan:forged},name);
    }
    // Positive controls: an envelope that matches the forged plan is accepted, so only the binding refuses above.
    const forgedOf=edit=>{
      const plan=clone(builtMain.plan);
      edit(plan);
      plan.foundation.snapshot_hash=hash(canonical(plan.snapshot));
      const forgedHash=hash(canonical(plan));
      return {plan,forgedHash,options:{planHash:forgedHash,plan}};
    };
    const evaluator=forgedOf(p=>{p.snapshot.signal.evaluator_hash=sha('b');});
    assert.equal(validatePreflightEnvelope(evaluator.plan.foundation,fakeOf('traded',e=>{
      e.plan_hash=evaluator.forgedHash;e.result.plan_hash=evaluator.forgedHash;e.binding.evaluator_hash=sha('b');}),
    evaluator.options).binding.evaluator_hash,sha('b'));
    const later=forgedOf(p=>{p.snapshot.development.holdout_start_time+=MINUTE;});
    assert.equal(validatePreflightEnvelope(later.plan.foundation,fakeOf('traded',e=>{
      e.plan_hash=later.forgedHash;e.result.plan_hash=later.forgedHash;e.dataset.holdout_start_time+=MINUTE;
      e.result.window.holdout_start_time+=MINUTE;}),later.options).dataset.holdout_start_time,
    builtMain.plan.snapshot.development.holdout_start_time+MINUTE);
  });

  await t.test('envelope: a reordered, dropped or added limitation is refused',()=>{
    const limitations=ENVELOPE_LIMITATIONS;
    const edits=[['swap first two',l=>{[l[0],l[1]]=[l[1],l[0]];}],['reverse',l=>{l.reverse();}],
      ['swap S1 with driver entries',l=>{[l[12],l[14]]=[l[14],l[12]];}],['drop last',l=>{l.pop();}],
      ['drop first',l=>{l.shift();}],['add',l=>{l.push('RECOMMENDATION_READY');}],
      ['duplicate',l=>{l.push(l[0]);}],['empty',l=>{l.length=0;}],['not text',l=>{l[0]=1;}]];
    assert.ok(limitations.length>=20&&new Set(limitations).size===limitations.length);
    for(const [name,edit] of edits)for(const option of validOptions)
      invalidEnvelope(foundation,fakeOf('traded',e=>edit(e.limitations)),option,name);
    for(const [name,edit] of [['result swap',l=>{[l[0],l[1]]=[l[1],l[0]];}],['result drop',l=>{l.pop();}],
      ['result add',l=>{l.push('X');}]])
      invalidEnvelope(foundation,fakeOf('traded',e=>edit(e.result.limitations)),options,name);
  });

  await t.test('envelope: binding, dataset and run must match the contract and the resolved window',()=>{
    const d=resolvedMain.dataset;
    const edits=[['engine hash',e=>{e.binding.engine_hash=sha('a');}],
      ['evaluator equals engine',e=>{e.binding.evaluator_hash=e.binding.engine_hash;}],
      ['raw dataset hash',e=>{e.binding.raw_dataset_sha256=sha('a');}],
      ['binding hash not text',e=>{e.binding.atr14_sha256=7;}],['binding missing key',e=>{delete e.binding.contract_digest;}],
      ['binding extra key',e=>{e.binding.note='x';}],
      ['owner',e=>{e.owner_id='owner-b';}],['bot',e=>{e.bot_id='other-bot';}],
      ['version',e=>{e.version='pf2-preflight-replay-v0';}],['extra top key',e=>{e.recommendation='APPLY';}],
      ['missing top key',e=>{delete e.run;}],
      ['first time',e=>{e.dataset.first_time+=MINUTE;}],['total bars',e=>{e.dataset.total_bars-=1;}],
      ['warmup bars',e=>{e.dataset.warmup_bars+=1;}],['evaluation start',e=>{e.dataset.evaluation_start_time+=MINUTE;}],
      ['last time',e=>{e.dataset.last_time-=MINUTE;}],
      ['development end before last',e=>{e.dataset.development_end_time=d.last_time-MINUTE;}],
      ['holdout before development end',e=>{e.dataset.holdout_start_time=e.dataset.development_end_time-MINUTE;}],
      ['holdout past the time ceiling',e=>{e.dataset.holdout_start_time=253_402_300_800_000;}],
      ['chunk bars',e=>{e.run.chunk_bars=500;e.run.chunks_executed=5;}],
      ['chunks executed',e=>{e.run.chunks_executed+=1;}],['chunks zero',e=>{e.run.chunks_executed=0;}],
      ['resumed past the end',e=>{e.run.resumed_from_bar=d.total_bars;}],
      ['resumed with a full run count',e=>{e.run.resumed_from_bar=1000;}],['run extra key',e=>{e.run.wall_ms=5;}],
      ['run float',e=>{e.run.resumed_from_bar=0.5;}]];
    for(const [name,edit] of edits)for(const option of validOptions)invalidEnvelope(foundation,fakeOf('traded',edit),option,name);
    // A resumed run counts only the chunks it executed.
    const resumed=fakeOf('traded',e=>{e.run={chunk_bars:1000,chunks_executed:Math.ceil((d.total_bars-1000)/1000),
      resumed_from_bar:1000};});
    assert.equal(validatePreflightEnvelope(foundation,resumed,options).run.resumed_from_bar,1000);
  });

  await t.test('envelope: result shape, counters, guards, account and samples are checked',()=>{
    const edits=[['result version',e=>{e.result.version='pf2-replay-result-v0';}],
      ['result model version',e=>{e.result.execution_model_version='paper-close-cost-v2';}],
      ['result extra key',e=>{e.result.readiness='READY';}],
      ['result missing key',e=>{delete e.result.samples;}],
      ['window first time',e=>{e.result.window.first_time+=MINUTE;}],
      ['window holdout',e=>{e.result.window.holdout_start_time+=MINUTE;}],
      ['window bars seen',e=>{e.result.window.bars_seen+=1;}],['window evaluated',e=>{e.result.window.evaluated_bars+=1;}],
      ['counter float',e=>{e.result.counters.signals.buy=1.5;}],['counter negative',e=>{e.result.counters.fills.buy=-1;}],
      ['counter text',e=>{e.result.counters.intents.buy='2';}],
      ['orders do not add up',e=>{e.result.counters.orders.accepted+=1;}],
      ['fills do not add up',e=>{e.result.counters.fills.buy+=1;e.result.account.open_allocations+=1;}],
      ['exit reasons do not add up',e=>{e.result.counters.fills.exit_by_reason={SL:1,TP:1};}],
      ['exit reason unknown',e=>{e.result.counters.fills.exit_by_reason={LIQUIDATION:1};}],
      ['rejection reasons do not add up',e=>{e.result.counters.orders.rejected_by_reason={LOW_CASH:1};}],
      ['derived value',e=>{e.result.derived.intents_evaluated+=1;}],
      ['episodes',e=>{e.result.counters.episodes.losing=2;}],
      ['guards extra key',e=>{e.result.guards.reset=true;}],['guards kill switch text',e=>{e.result.guards.kill_switch='no';}],
      ['pause kinds order',e=>{e.result.guards.pause.active_kinds=['LOSS_STREAK','KILL_SWITCH'];}],
      ['pause kind unknown',e=>{e.result.guards.pause.active_kinds=['NEWS'];}],
      ['pause persistent flag',e=>{e.result.guards.pause.persistent=true;}],
      ['pause truncated flag',e=>{e.result.guards.pause.truncated=true;}],
      ['pause period shape',e=>{e.result.guards.pause.periods=[{kind:'KILL_SWITCH'}];}],
      ['pause period outside window',e=>{e.result.guards.pause.periods=[{kind:'MAX_DAILY_LOSS',start_time:1,end_time:null,
        persistent:false}];}],
      ['account text',e=>{e.result.account.cash=800;}],['account negative',e=>{e.result.account.cash='-1';}],
      ['account exponent',e=>{e.result.account.position_cost='1e5';}],
      ['open allocations',e=>{e.result.account.open_allocations=0;}],
      ['flat position with open allocations',e=>{e.result.account.position_quantity='0';}],
      ['samples short',e=>{e.result.samples.fills.pop();}],
      ['sample outside window',e=>{e.result.samples.fills[0].time=1;}],
      ['sample unaligned',e=>{e.result.samples.fills[0].time+=1;}],
      ['sample key',e=>{e.result.samples.fills[0].pnl='1';}],
      ['sample exit without reason',e=>{e.result.samples.fills[1].reason=null;}],
      ['sample buy with reason',e=>{e.result.samples.fills[0].reason='SL';}],
      ['sample outcome',e=>{e.result.samples.fills[0].sizing_outcome='FORCED';}],
      ['sample text',e=>{e.result.samples.fills[0].price=100.5;}],
      ['non printable text',e=>{e.result.samples.fills[0].entry_ref='caf\u00e9';}],
      ['result admission',e=>{e.result.admission.orders_executed=true;}]];
    for(const [name,edit] of edits)invalidEnvelope(foundation,fakeOf('traded',edit),options,name);
    invalidEnvelope(foundation,fakeOf('rejected',e=>{e.result.samples.rejections[0].reason='OTHER';}),options,'reason unknown');
    invalidEnvelope(foundation,fakeOf('rejected',e=>{e.result.samples.rejections=[];}),options,'rejection sample short');
  });

  await t.test('envelope: byte bound, contract kind, hostile arguments; every refusal is one fixed code',()=>{
    const envelope=fakeOf();
    const size=Buffer.byteLength(canonical(envelope));
    // The bound is the pinned output budget (512 KiB): the fixture envelope is far below it, a padded copy above.
    assert.equal(foundation.budget.max_output_bytes,PREFLIGHT_RUNTIME_BUDGET.max_output_bytes);
    assert.ok(size>1024&&size<foundation.budget.max_output_bytes);
    const padded=fakeOf('traded',e=>{e.acceptance_blockers.push('P'.repeat(foundation.budget.max_output_bytes));});
    assert.ok(Buffer.byteLength(canonical(padded))>foundation.budget.max_output_bytes);
    invalidEnvelope(foundation,padded,options,'over the pinned output budget');
    invalidEnvelope({...foundation,kind:'BACKTEST'},envelope,options,'other kind');
    invalidEnvelope({...foundation,owner_id:'owner-b'},envelope,options,'other owner');
    invalidEnvelope({...foundation,extra:1},envelope,options,'contract extra key');
    invalidEnvelope(null,envelope,options,'contract null');
    for(const junk of [null,undefined,[],'x',7,true])invalidEnvelope(foundation,junk,options,'envelope '+String(junk));
    for(const junk of [undefined,null,[],'x',{},{planHash:7},{planHash:sha('a'),extra:1},{plan:builtMain.plan},
      {planHash:builtMain.plan_hash},{planHash:builtMain.plan_hash,plan:undefined},
      {planHash:builtMain.plan_hash,plan:null},{planHash:builtMain.plan_hash,plan:{}},
      {planHash:builtMain.plan_hash,plan:builtMain.plan,extra:1}])
      invalidEnvelope(foundation,envelope,junk,'options '+JSON.stringify(junk));
    invalidEnvelope(foundation,envelope,accessor({},'planHash'),'options getter');
    invalidEnvelope(foundation,accessor(fakeOf(),'result'),options,'envelope getter');
    const cyclic=fakeOf();
    cyclic.result.self=cyclic;
    invalidEnvelope(foundation,cyclic,options,'cyclic');
    invalidEnvelope(foundation,fakeOf('traded',e=>{e[Symbol('x')]=1;}),options,'symbol key');
    invalidEnvelope(foundation,fakeOf('traded',e=>{e.result.samples.fills[0].price=()=>1;}),options,'function value');
    invalidEnvelope(foundation,fakeOf('traded',e=>{e.result.window.first_time=NaN;}),options,'NaN');
    invalidEnvelope(foundation,fakeOf('traded',e=>{e.result.counters.signals.buy=2**53;}),options,'unsafe integer');
    const proxy=new Proxy(fakeOf(),{get(){throw new Error(MARKER);}});
    invalidEnvelope(foundation,proxy,options,'proxy');
    const deep=fakeOf();
    let cursor=deep;
    for(let level=0;level<5000;level++){cursor.next={};cursor=cursor.next;}
    invalidEnvelope(foundation,deep,options,'deep nesting');
  });

  await t.test('envelope: the stored plan is required and binds the evaluator and the holdout times',()=>{
    assert.equal(validatePreflightEnvelope(foundation,fakeOf(),options).plan_hash,builtMain.plan_hash);
    invalidEnvelope(foundation,fakeOf(),{planHash:builtMain.plan_hash},'no plan');
    // An envelope moved to a later holdout (dataset and window alike) is self-consistent: only the stored plan refuses it.
    const later=fakeOf('traded',e=>{e.dataset.holdout_start_time+=MINUTE;e.result.window.holdout_start_time+=MINUTE;});
    invalidEnvelope(foundation,later,options,'holdout moved');
    invalidEnvelope(foundation,fakeOf('traded',e=>{e.dataset.development_end_time+=MINUTE;
      e.result.window.development_end_time+=MINUTE;}),options,'development end moved');
    invalidEnvelope(foundation,fakeOf('traded',e=>{e.binding.evaluator_hash=sha('b');}),options,'evaluator swapped');
  });

  await t.test('envelope: the contract must carry the one PREFLIGHT budget, whatever the stored plan says',()=>{
    const total=resolvedMain.dataset.total_bars;
    assert.deepEqual(foundation.budget,{candidates:1,max_evaluations:1,
      chunk_bars:Math.min(1000,foundation.dataset.metadata.total_bars),max_runtime_ms:900000,max_output_bytes:524288,
      max_state_bytes:1048576});
    // Each forged plan is sealed and its envelope is self-consistent. The plan validator already pins one
    // candidate and one evaluation (planValid false); every other budget field is refused only by the pin.
    const budgets=[['candidates and evaluations',{candidates:2,max_evaluations:2},false],
      ['evaluations',{max_evaluations:2},false],['chunk smaller',{chunk_bars:500},true],
      ['chunk larger',{chunk_bars:1001},true],['runtime',{max_runtime_ms:899999},true],
      ['output larger',{max_output_bytes:8*1024*1024},true],['output smaller',{max_output_bytes:524287},true],
      ['state',{max_state_bytes:1048575},true]];
    for(const [name,change,planValid] of budgets){
      const forged=clone(builtMain.plan);
      Object.assign(forged.foundation.budget,change);
      if(planValid)assert.doesNotThrow(()=>validateHistoricalPreflightRequest(clone(forged)),name);
      const forgedHash=hash(canonical(forged));
      const chunk=Math.min(forged.foundation.budget.chunk_bars,total);
      const envelope=fakeOf('traded',e=>{
        e.plan_hash=forgedHash;e.result.plan_hash=forgedHash;
        e.run={chunk_bars:chunk,chunks_executed:Math.ceil(total/chunk),resumed_from_bar:0};});
      invalidEnvelope(forged.foundation,envelope,{planHash:forgedHash,plan:forged},name);
    }
  });

  await t.test('envelope: policy-free S4 invariants (counters, loss streak, pause periods, samples) are enforced',()=>{
    const data=resolvedMain.dataset,S=data.evaluation_start_time;
    const rejection=offset=>({time:S+offset*MINUTE,event_type:'BUY',entry_ref:DEPLOYMENT+':'+offset,reason:'eta_guard'});
    const period=(kind,start,end,persistent)=>({kind,start_time:S+start*MINUTE,
      end_time:end===null?null:S+end*MINUTE,persistent});
    const pause=(e,kinds,periods)=>{
      const p=e.result.guards.pause;
      p.active_kinds=kinds;
      p.persistent=kinds.some(kind=>['KILL_SWITCH','LOSS_STREAK'].includes(kind));
      p.periods=periods;
    };
    // One buy and one exit fill, flat at the end: closed episodes 0 breaks the flat rule, 1 keeps it.
    const flat=closed=>e=>{
      const r=e.result,c=r.counters;
      c.intents={buy:1,exit_sl:1,exit_tp:0,exit_native:0};
      c.orders={accepted:1,sizing_adjusted:1,rejected:0,rejected_by_reason:{}};
      c.fills={buy:1,exit:1,exit_by_reason:{SL:1}};
      c.episodes={closed,losing:0};
      r.derived={intents_evaluated:2,suppressed_buy:1,suppressed_buy_evaluated:1,non_losing_episodes:closed};
      r.guards.loss_streak_final=0;
      r.account={cash:'800',position_quantity:'0',position_cost:'0',open_allocations:0};
      r.samples.fills=r.samples.fills.slice(0,2);
    };
    const twoRejections=second=>e=>{
      const r=e.result,c=r.counters;
      c.signals.buy=2;c.signals.buy_evaluated=2;c.intents.buy=2;c.orders.rejected=2;
      c.orders.rejected_by_reason={eta_guard:2};r.derived.intents_evaluated=2;
      r.samples.rejections=[rejection(5),rejection(second)];
    };
    const accepted=[
      ['flat after a buy with a closed episode','traded',flat(1)],
      ['two ordered rejections','rejected',twoRejections(9)],
      ['equal sample times','traded',e=>{e.result.samples.fills[1].time=e.result.samples.fills[0].time;}],
      ['kill switch pause from the first evaluated bar','traded',e=>{
        e.result.guards.kill_switch=true;
        pause(e,['KILL_SWITCH'],[period('MAX_DAILY_LOSS',1,3,false),period('KILL_SWITCH',0,null,true)]);}],
      ['loss streak pause open at the end','traded',e=>{pause(e,['LOSS_STREAK'],[period('LOSS_STREAK',9,null,true)]);}],
      ['day pause open at the end','traded',e=>{pause(e,['MAX_DAILY_LOSS'],[period('MAX_DAILY_LOSS',1,null,false)]);}],
      ['all closed periods kept, more dropped','traded',e=>{
        const p=e.result.guards.pause;
        p.periods=Array.from({length:256},(_,index)=>period(index%2?'MAX_DAILY_LOSS':'MAX_TRADES_PER_DAY',1,2,false));
        p.truncated=true;p.dropped_periods=3;}]];
    for(const [name,shape,edit] of accepted){
      const envelope=fakeOf(shape,edit);
      assert.equal(canonical(validatePreflightEnvelope(foundation,envelope,options)),canonical(envelope),name);
    }
    const refused=[
      ['buy signals above the bar count','traded',e=>{
        e.result.counters.signals.buy=data.total_bars+1;e.result.derived.suppressed_buy=data.total_bars-1;}],
      ['evaluated buy signals above the buy signals','traded',e=>{
        e.result.counters.signals.buy_evaluated=3;e.result.derived.suppressed_buy_evaluated=1;}],
      ['evaluated native exits above the native exits','traded',e=>{e.result.counters.signals.native_exit_evaluated=2;}],
      ['unevaluated buy signals above the warm-up bars','traded',e=>{
        e.result.counters.signals.buy=data.warmup_bars+3;e.result.derived.suppressed_buy=data.warmup_bars+1;}],
      ['warm-up buy intents above the warm-up signals','traded',e=>{
        const r=e.result;
        r.counters.signals.buy=3;r.counters.signals.buy_evaluated=3;r.counters.warmup_intents.buy=1;
        r.derived.suppressed_buy=0;r.derived.suppressed_buy_evaluated=1;}],
      ['buy fills above buy intents','traded',e=>{
        const r=e.result;
        r.counters.intents.buy=1;r.counters.intents.exit_sl=2;
        r.derived.suppressed_buy=1;r.derived.suppressed_buy_evaluated=1;}],
      ['exit fills above buy fills','traded',e=>{
        const r=e.result,c=r.counters,s=r.samples.fills;
        c.fills={buy:1,exit:2,exit_by_reason:{SL:2}};c.intents.buy=1;c.intents.exit_sl=2;
        r.derived.suppressed_buy=1;r.derived.suppressed_buy_evaluated=1;r.account.open_allocations=-1;
        s[2].event_type='EXIT';s[2].reason='SL';}],
      ['exit reason above its intents','traded',e=>{e.result.counters.fills.exit_by_reason={TP:1};}],
      ['closed episodes above the exit fills','traded',e=>{
        e.result.counters.episodes={closed:2,losing:1};e.result.derived.non_losing_episodes=1;}],
      ['losing episodes above the closed ones','traded',e=>{
        e.result.counters.episodes={closed:1,losing:2};e.result.derived.non_losing_episodes=-1;}],
      ['flat after a buy with no closed episode','traded',flat(0)],
      ['loss streak above the losing episodes','traded',e=>{e.result.guards.loss_streak_final=2;}],
      ['kill switch flag without its pause','traded',e=>{e.result.guards.kill_switch=true;}],
      ['kill switch pause without the flag','traded',e=>{pause(e,['KILL_SWITCH'],[period('KILL_SWITCH',0,null,true)]);}],
      ['kill switch pause not from the first evaluated bar','traded',e=>{
        e.result.guards.kill_switch=true;pause(e,['KILL_SWITCH'],[period('KILL_SWITCH',1,null,true)]);}],
      ['closed persistent kill switch period','traded',e=>{pause(e,[],[period('KILL_SWITCH',0,1,true)]);}],
      ['closed day period marked persistent','traded',e=>{pause(e,[],[period('MAX_DAILY_LOSS',0,1,true)]);}],
      ['open period without an active kind','traded',e=>{pause(e,[],[period('MAX_DAILY_LOSS',0,null,false)]);}],
      ['active kind without an open period','traded',e=>{pause(e,['LOSS_STREAK'],[]);}],
      ['open period of another kind','traded',e=>{
        pause(e,['LOSS_STREAK'],[period('MAX_DAILY_LOSS',0,null,false)]);}],
      ['open period persistence flag','traded',e=>{pause(e,['LOSS_STREAK'],[period('LOSS_STREAK',1,null,false)]);}],
      ['closed period after an open one','traded',e=>{
        pause(e,['LOSS_STREAK'],[period('LOSS_STREAK',1,null,true),period('MAX_DAILY_LOSS',2,3,false)]);}],
      ['dropped periods without a full closed list','traded',e=>{
        e.result.guards.pause.truncated=true;e.result.guards.pause.dropped_periods=3;}],
      ['fill samples out of time order','traded',e=>{e.result.samples.fills.reverse();}],
      ['more exit samples than exit fills','traded',e=>{
        const s=e.result.samples.fills;s[2].event_type='EXIT';s[2].reason='SL';}],
      ['more buy samples than buy fills','traded',e=>{
        const s=e.result.samples.fills;s[1].event_type='BUY';s[1].reason=null;}],
      ['rejection samples out of time order','rejected',twoRejections(3)]];
    for(const [name,shape,edit] of refused)invalidEnvelope(foundation,fakeOf(shape,edit),options,name);
  });

  await t.test('envelope: a real S4 replay of the built plan validates; resumed and tampered variants',async st=>{
    // PF2_REQUIRE_PYTHON=1 (the Quant Lab CI job) turns a would-be skip into a failure.
    if(!pythonReady){
      assert.notEqual(process.env.PF2_REQUIRE_PYTHON,'1','PF2_REQUIRE_PYTHON=1: '+NO_PYTHON);
      st.skip(NO_PYTHON);
      return;
    }
    const world=worldFor(builtMain);
    const resolved=await world.resolve();
    const research=world.trusted.datasets.research;
    const runChunk=createLocalPythonRunner({python,developmentOnly:true,shim:SHIM});
    const tokens=[];
    const envelope=await runHistoricalPreflight({resolved,research,runChunk,
      onCheckpoint:async token=>{tokens.push(token);}});
    assert.equal(envelope.plan_hash,builtMain.plan_hash);
    assert.equal(envelope.binding.engine_hash,foundation.engine_hash);
    for(const option of validOptions)
      assert.equal(canonical(validatePreflightEnvelope(foundation,envelope,option)),canonical(envelope));
    // The independent expectation of the limitation list matches what the real driver emits.
    assert.deepEqual(envelope.limitations,ENVELOPE_LIMITATIONS);
    assert.deepEqual(envelope.result.limitations,S1_LIMITATIONS);
    assert.deepEqual(envelope.admission,ADMISSION);
    // A run resumed from a stored token counts only the chunks it executed.
    assert.ok(tokens.length>=1);
    const resumed=await runHistoricalPreflight({resolved,research,runChunk,resume:tokens[0]});
    assert.equal(resumed.run.resumed_from_bar,tokens[0].next_bar);
    assert.equal(canonical(validatePreflightEnvelope(foundation,resumed,options)),canonical(resumed));
    // Tampered copies of the real envelope are refused: ETA key, admission flip, plan hash swap, limitations reorder.
    const tampered=[['eta key',e=>{e.run.eta_ms=5;}],['admission flip',e=>{e.admission.evaluator_admission=true;}],
      ['result admission flip',e=>{e.result.admission.holdout_accessed=true;}],
      ['plan hash swap',e=>{e.plan_hash=sha('a');}],['result plan hash swap',e=>{e.result.plan_hash=sha('a');}],
      ['limitations reorder',e=>{e.limitations.reverse();}],['engine swap',e=>{e.binding.engine_hash=sha('a');}],
      ['counter edit',e=>{e.result.counters.fills.buy+=1;}],['window edit',e=>{e.result.window.last_time-=MINUTE;}]];
    for(const [name,edit] of tampered){
      const copy=structuredClone(envelope);
      edit(copy);
      for(const option of validOptions)invalidEnvelope(foundation,copy,option,name);
    }
  });
});
