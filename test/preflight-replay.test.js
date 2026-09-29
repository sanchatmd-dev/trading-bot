import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PF2_ENGINE_FILES,PF2_EVALUATOR_FILES,pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {PF2_CHUNK_VERSION,PF2_REPLAY_ENVELOPE_VERSION,PF2_REPLAY_ERRORS,PF2_REPLAY_LIMITATIONS,PF2_REPLAY_LIMITS,
  PF2_RESUME_VERSION,PF2_S1_ERRORS,buildChunkRequest,createLocalPythonRunner,encodeChunkRequest,
  runHistoricalPreflight,validatePreflightResult} from '../src/quant-research/preflight-replay.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {MINUTE,START,createPf2Base,isDeepFrozen,makeWorld,policyRecord} from './helpers/pf2-fixture.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SHIM=resolve(root,'test','helpers','pf2_replay_shim.py');
const REPLAY_FILE='src/quant-research/preflight-replay.js';
const MARKER=String.raw`C:\secret-location\marker-4242`;
const TMP=os.tmpdir();
const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
// Only an absolute interpreter path is ever spawned. A bare command name can resolve through an installer
// alias (the Windows Python install manager downloads a runtime into the working directory), so a
// non-absolute QUANT_RESEARCH_PYTHON means no interpreter and the Python-dependent tests skip.
const configuredPython=process.env.QUANT_RESEARCH_PYTHON;
const python=configuredPython?(path.isAbsolute(configuredPython)?configuredPython:null):
  (existsSync(localPython)?localPython:null);
const ALLOWED_CODES=new Set([...PF2_REPLAY_ERRORS,...PF2_S1_ERRORS]);
const clone=value=>structuredClone(value);
const sha=letter=>letter.repeat(64);

/** A Windows checkout may hold CRLF (core.autocrlf); only a lone CR or a trailing blank is a defect. */
function assertCleanText(text,label){
  const lines=text.replace(/\r\n/g,'\n');
  assert.equal(lines.includes('\r'),false,label+' CR');
  assert.equal(/[ \t]+$/m.test(lines),false,label+' trailing whitespace');
}

// Python is needed for the success path only. The tests skip, with a reason, when no absolute interpreter
// is configured, the interpreter is missing (ENOENT) or its quant dependencies are (ModuleNotFoundError;
// the CI job has none of them).
// The probe uses the runner's flags and environment allowlist; a timeout, a permission error or any
// other import failure stays loud.
const probeEnvironment={PYTHONPATH:resolve(root,'quant_lab','src'),PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};
for(const name of ['PATH','SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','TMPDIR'])
  if(process.env[name])probeEnvironment[name]=process.env[name];
const probe=python===null?null:spawnSync(python,['-B','-s','-c','import robot_quant.pf2_replay'],
  {encoding:'utf8',timeout:180000,env:probeEnvironment});
const pythonReady=probe!==null&&!(probe.error?.code==='ENOENT'||/ModuleNotFoundError|No module named/.test(probe.stderr??''));
const NO_PYTHON=python===null?
  'no absolute python interpreter (set QUANT_RESEARCH_PYTHON to an absolute path or create quant_lab/.venv); the S4 success path needs one':
  'python runtime or quant dependencies unavailable here; the S4 success path needs them';

/** Synthetic wavy series: gives BUY signals with the shim inputs (the default sawtooth gives none). */
const wave=index=>Math.round((100+12*Math.sin(index/23)+4*Math.sin(index/2.1))*100)/100;
function waveBar(index){
  const close=wave(index),open=index===0?100:wave(index-1);
  return {time:START+index*MINUTE,open:open.toFixed(2),high:(Math.max(open,close)+1.2).toFixed(2),
    low:(Math.min(open,close)-1.2).toFixed(2),close:close.toFixed(2),volume:'2'};
}

/** Error hygiene applied to every rejection: known code, message===code, no cause, only code+status. */
function hygiene(error){
  assert.ok(ALLOWED_CODES.has(error.code),'unexpected code '+error.code);
  assert.equal(error.message,error.code);
  assert.equal('cause' in error,false);
  assert.deepEqual(Object.keys(error),['code','status']);
  const text=[error.message,error.stack,JSON.stringify(error)].join('\n');
  assert.equal(text.includes(MARKER),false);
  assert.equal(text.includes(TMP),false);
  return true;
}
const rejectsWith=(promise,code)=>assert.rejects(promise,error=>{hygiene(error);assert.equal(error.code,code);return true;});
const outcome=promise=>promise.then(()=>'RESOLVED',error=>error);
const flush=()=>new Promise(done=>setImmediate(done));
async function until(condition,ms=10000){
  const end=Date.now()+ms;
  while(!condition()){
    if(Date.now()>end)throw new Error('until: timeout');
    await new Promise(done=>setTimeout(done,10));
  }
}
// Bounded by real time, not a turn count: real file reads (executable hashing) can outlast 2000 turns on a cold cache.
const untilTick=async condition=>{
  const end=performance.now()+15000;
  while(!condition()&&performance.now()<end)await flush();
  assert.ok(condition(),'until tick');
};
const stuck=()=>new Promise(()=>{});
const craftedError=code=>Object.assign(new Error(code),{code,status:400,leak:MARKER,cause:new Error(MARKER)});
const fakeClock=(now=0)=>{const state={now};const clock=()=>state.now;clock.state=state;return clock;};
function watchUnhandled(){
  const seen=[],listener=reason=>seen.push(reason);
  process.on('unhandledRejection',listener);
  return {seen,stop:()=>process.off('unhandledRejection',listener)};
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

/** Runner doubles. `counting` records every call; replay/fixed serve captured or scripted output. */
function counting(inner){
  const calls=[];
  const runner=async(input,options)=>{calls.push({input,options});return inner(input,options,calls.length);};
  runner.calls=calls;
  return runner;
}
const recording=(inner,pairs)=>async(input,options)=>{
  const out=await inner(input,options);
  pairs.push({input:Buffer.from(input),exitCode:out.exitCode,stdout:Buffer.from(out.stdout)});
  return out;
};
/** Serves the recorded response for a byte-identical request; anything else is a test failure. */
const replayRunner=pairs=>{
  const known=new Map(pairs.map(pair=>[hash(pair.input),pair]));
  return counting(async input=>{
    const pair=known.get(hash(input));
    if(!pair)throw new Error('replay: unknown request');
    return {exitCode:pair.exitCode,stdout:Buffer.from(pair.stdout)};
  });
};
const fixedRunner=(exitCode,stdout)=>counting(async()=>({exitCode,stdout}));
const lineOf=(value,newline=true)=>Buffer.from(canonical(value)+(newline?'\n':''));
/** Rewrites one recorded response (parsed, edited, canonical again) and keeps the rest. */
function editedReplay(pairs,index,edit){
  const runner=replayRunner(pairs);
  const served=counting(async(input,options,count)=>{
    const out=await runner(input,options);
    if(count-1!==index)return out;
    return edit(out,JSON.parse(out.stdout.toString('latin1',0,out.stdout.length-1)));
  });
  return served;
}
const sealCheckpoint=checkpoint=>{
  const {integrity,...payload}=checkpoint;
  void integrity;
  checkpoint.integrity=hash(canonical(payload));
  return checkpoint;
};
const sealToken=token=>{
  const {token_sha256:sealed,...body}=token;
  void sealed;
  token.token_sha256=hash(canonical(body));
  return token;
};

test('PF-2 S4 replay driver',async t=>{
  const base=await createPf2Base(t,{bar:waveBar});
  const baselinePolicy={...policyRecord(),blockDuringNews:false};
  const scenarioOf=(edits={})=>base.scenario({policy:baselinePolicy,...edits});
  /** Trusted world over a scenario: the resolved contract plus a store spy that logs every read. */
  const open=async scenario=>{
    const world=makeWorld(base,scenario);
    const resolved=await world.resolve();
    return {world,resolved,research:world.trusted.datasets.research,mark:world.reads.length};
  };
  const runOn=(ctx,extra={})=>runHistoricalPreflight({resolved:ctx.resolved,research:ctx.research,...extra});
  const readsOf=ctx=>ctx.world.reads.slice(ctx.mark);
  const baseScenario=await scenarioOf();
  let baseline=null;
  // PF2_REQUIRE_PYTHON=1 (the Quant Lab CI job) turns a would-be skip into a failure.
  const needPython=st=>{
    if(pythonReady)return false;
    assert.notEqual(process.env.PF2_REQUIRE_PYTHON,'1','PF2_REQUIRE_PYTHON=1: '+NO_PYTHON);
    st.skip(NO_PYTHON);
    return true;
  };

  await t.test('test interpreter: an absolute path or none, never a bare command name',()=>{
    assert.ok(python===null||(typeof python==='string'&&path.isAbsolute(python)));
    if(python===null)assert.equal(pythonReady,false);
  });

  await t.test('static: import set, forbidden couplings, clean files, shim hygiene',async()=>{
    const source=await readFile(path.join(root,REPLAY_FILE),'utf8');
    const imports=[...source.matchAll(/^import\s.*?from\s*'([^']+)'/gm)].map(match=>match[1]).sort();
    assert.deepEqual(imports,['../money.js','../pine-bridge/source.js','./foundation-contract-v2.js',
      './foundation-contract.js','./preflight-resolver.js','node:child_process','node:path','node:url']);
    for(const banned of ['process-supervisor','runQuantProcess','systemd','io-controls','postgres','paper-cost-model',
      'research_chunk'])assert.equal(source.includes(banned),false,banned);
    const shim=await readFile(SHIM,'utf8');
    assert.equal(shim.includes('paper_cost_model'),false);
    for(const file of [REPLAY_FILE,'test/preflight-replay.test.js','test/helpers/pf2_replay_shim.py'])
      assertCleanText(await readFile(path.join(root,file),'utf8'),file);
    // 'C:\Windows' is a drive-relative path: \W is just W in a string literal.
    assert.equal(source.includes(String.raw`'C:\Windows'`),false);
    assert.ok(source.includes(String.raw`'C:\\Windows'`));
  });

  await t.test('text hygiene helper: a CRLF checkout is clean, a lone CR or a trailing blank is not',()=>{
    assertCleanText('a\nb\n','LF');
    assertCleanText('a\r\nb\r\n','CRLF');
    for(const text of ['a\rb\n','a\n\rb','a\r\r\nb','a \nb\n','a\t\r\nb','a\r\n ','a\r\n\r'])
      assert.throws(()=>assertCleanText(text,'defect'),assert.AssertionError,JSON.stringify(text));
  });

  await t.test('engine list: the driver is hashed with the engine and its imports are listed',async()=>{
    assert.ok(PF2_ENGINE_FILES.includes(REPLAY_FILE),'preflight-replay.js missing from PF2_ENGINE_FILES');
    assert.equal(PF2_EVALUATOR_FILES.includes(REPLAY_FILE),false);
    const source=await readFile(path.join(root,REPLAY_FILE),'utf8');
    for(const match of source.matchAll(/^import\s.*?from\s*'(\.[^']+)'/gm)){
      const file=path.posix.join('src/quant-research',match[1]);
      assert.ok(PF2_ENGINE_FILES.includes(path.posix.normalize(file)),file);
    }
  });

  await t.test('resolved intake: malformed input is refused before any read, hash or spawn',async()=>{
    const ctx=await open(baseScenario);
    const cases=[['contract.plan_hash',r=>{r.contract.plan_hash=sha('1');}],
      ['dataset.total_bars',r=>{r.dataset.total_bars+=1;}],
      ['contract.dataset.warmup_bars',r=>{r.contract.dataset.warmup_bars+=1;}],
      ['model version cost-v2',r=>{r.contract.model.version='paper-close-cost-v2';}],
      ['initial_state.loss_streak',r=>{r.contract.initial_state.loss_streak=1;}],
      ['admission.holdout_accessed',r=>{r.admission.holdout_accessed=true;}],
      ['last_time past development end',r=>{
        r.dataset.development_end_time=r.dataset.last_time-MINUTE;
        r.contract.dataset.development_end_time=r.dataset.development_end_time;}],
      ['sidecar sha',r=>{r.dataset.research.sidecar.sha256=sha('2');}],
      ['sidecar tick',r=>{r.dataset.research.sidecar.price_tick='0.02';}],
      ['max_samples 201',r=>{r.contract.limits.max_samples=201;}],
      ['max_state_bytes vs budget',r=>{r.contract.limits.max_state_bytes-=1;}],
      ['source hash',r=>{r.contract.signal.source+=' ';}],
      ['extra key',r=>{r.extra=1;}],
      ['wrong version',r=>{r.version='pf2-resolved-preflight-v0';}],
      ['evaluator equals engine',r=>{r.identities.evaluator_hash=r.identities.engine_hash;}],
      ['identity not hex',r=>{r.identities.atr14_sha256='xyz';}],
      ['runtime budget over 900000',r=>{r.budget.max_runtime_ms=900001;}],
      ['policy key missing',r=>{delete r.contract.policy.killSwitch;}],
      ['bridge decimal not canonical',r=>{r.contract.bridge.rr='1.50';}],
      ['raw sha',r=>{r.dataset.raw.sha256=sha('3');}],
      ['development start not before first bar',r=>{r.dataset.development_start_time=r.dataset.first_time;}],
      ['holdout before development end',r=>{r.dataset.holdout_start_time=r.dataset.development_end_time-MINUTE;
        r.contract.dataset.holdout_start_time=r.dataset.holdout_start_time;}],
      ['duplicate blocker',r=>{r.acceptance_blockers=['A','A'];}],['non text limitation',r=>{r.limitations=[1];}],
      ['warmup covers every bar',r=>{r.dataset.warmup_bars=r.dataset.total_bars;}],
      ['first bar unaligned',r=>{r.dataset.first_time+=1;}],
      ['fee not canonical',r=>{r.contract.model.fee_bps='10.0';}],
      ['loss streak text',r=>{r.contract.initial_state.loss_streak='0';}],
      ['broker',r=>{r.contract.broker='other';}],['symbol',r=>{r.contract.symbol='ETHUSDT';}],
      ['deployment id',r=>{r.contract.deployment_id='bad id!';}],
      ['mode',r=>{r.contract.signal.mode='BOUND_SIGNAL_CSV';}],
      ['snapshot source hash',r=>{r.contract.signal.snapshot.source_hash=sha('4');}],
      ['max_bars',r=>{r.contract.limits.max_bars=50000;}],
      ['getter field',r=>{Object.defineProperty(r.contract,'bridge',{enumerable:true,configurable:true,
        get(){return {atr_multiplier:'2',rr:'1.5'};}});}]];
    for(const [name,edit] of cases){
      const resolved=clone(ctx.resolved);
      edit(resolved);
      const runner=counting(async()=>{throw new Error('spawn');});
      let reads=0,hashes=0;
      const research={readV2(){reads++;throw new Error('read');}};
      await rejectsWith(runHistoricalPreflight({resolved,research,runChunk:runner,
        readFile:async()=>{hashes++;throw new Error('hash');}}),'PF2_RESOLVED_INVALID');
      assert.deepEqual([runner.calls.length,reads,hashes],[0,0,0],name);
    }
    for(const junk of [null,undefined,[],'x',7]){
      await rejectsWith(runOn(ctx,{resolved:junk,runChunk:counting(async()=>{throw new Error('spawn');})}),'PF2_RESOLVED_INVALID');
    }
    // The resolved value is detached once: one descriptor read per property, never a get trap.
    const traps={get:0,descriptors:new Map()};
    const spied=new Proxy(clone(ctx.resolved),{
      get(){traps.get++;throw new Error(MARKER);},
      getOwnPropertyDescriptor(target,name){
        traps.descriptors.set(name,(traps.descriptors.get(name)??0)+1);
        return Reflect.getOwnPropertyDescriptor(target,name);}});
    const runner=counting(async()=>{throw new Error('spawn');});
    await rejectsWith(runOn(ctx,{resolved:spied,runChunk:runner}),'PF2_RUNNER_FAILED');
    assert.equal(traps.get,0);
    assert.ok([...traps.descriptors.values()].every(count=>count===1));
    assert.equal(traps.descriptors.size,Object.keys(ctx.resolved).length);
  });

  await t.test('baseline: real S3 resolve to real S1 replay, ledger exercised, envelope exact',async st=>{
    if(needPython(st))return;
    const ctx=await open(baseScenario);
    const runner=createLocalPythonRunner({python,developmentOnly:true,shim:SHIM});
    const pairs=[],tokens=[],callerAbort=new AbortController();
    const started=Date.now();
    const envelope=await runOn(ctx,{runChunk:recording(runner,pairs),signal:callerAbort.signal,
      onCheckpoint:async token=>{tokens.push(token);}});
    baseline={ctx,envelope,pairs,tokens,seconds:(Date.now()-started)/1000};
    const {resolved}=ctx,result=envelope.result;
    assert.deepEqual(Object.keys(envelope).sort(),['acceptance_blockers','admission','binding','bot_id','dataset',
      'limitations','owner_id','plan_hash','result','run','version']);
    assert.equal(envelope.version,PF2_REPLAY_ENVELOPE_VERSION);
    assert.equal(envelope.plan_hash,resolved.plan_hash);
    assert.equal(envelope.owner_id,resolved.owner_id);
    assert.equal(envelope.bot_id,resolved.bot_id);
    assert.ok(isDeepFrozen(envelope));
    assert.deepEqual(envelope.run,{chunk_bars:1000,chunks_executed:3,resumed_from_bar:0});
    assert.deepEqual(envelope.admission,{development_only:true,evaluator_admission:false,holdout_accessed:false,
      orders_executed:false,execution_model_parity:'V1_ONLY'});
    assert.deepEqual(envelope.acceptance_blockers,resolved.acceptance_blockers);
    assert.deepEqual(envelope.limitations,[...new Set([...resolved.limitations,...result.limitations,
      ...PF2_REPLAY_LIMITATIONS])]);
    const id=resolved.identities;
    assert.deepEqual(Object.keys(envelope.binding).sort(),['atr14_sha256','closed_dataset_sha256','contract_digest',
      'contract_sha256','engine_hash','enrollment_binding_sha256','evaluator_hash','raw_dataset_sha256','resolved_sha256']);
    assert.equal(envelope.binding.contract_sha256,hash(canonical(resolved.contract)));
    assert.equal(envelope.binding.resolved_sha256,hash(canonical(resolved)));
    assert.match(envelope.binding.contract_digest,/^[a-f0-9]{64}$/);
    for(const name of ['engine_hash','evaluator_hash','raw_dataset_sha256','closed_dataset_sha256','atr14_sha256',
      'enrollment_binding_sha256'])assert.equal(envelope.binding[name],id[name],name);
    const d=resolved.dataset;
    assert.deepEqual(envelope.dataset,{first_time:d.first_time,evaluation_start_time:d.evaluation_start_time,
      last_time:d.last_time,total_bars:2100,warmup_bars:1100,development_end_time:d.development_end_time,
      holdout_start_time:d.holdout_start_time});
    // Result: the Node invariants hold, are idempotent, and the window is the resolved window.
    assert.deepEqual(validatePreflightResult(resolved,result),result);
    assert.ok(isDeepFrozen(validatePreflightResult(resolved,result)));
    assert.deepEqual(result.window,{first_time:d.first_time,evaluation_start_time:d.evaluation_start_time,
      last_time:d.last_time,development_end_time:d.development_end_time,holdout_start_time:d.holdout_start_time,
      bars_seen:2100,warmup_bars:1100,evaluated_bars:1000});
    // B2: the ledger really ran (default policy blocks every BUY on missing news data, this one does not).
    const c=result.counters;
    assert.ok(c.signals.buy>0&&c.intents.buy>0&&c.fills.buy>0&&c.fills.exit>0&&c.episodes.closed>0);
    assert.ok(result.samples.fills.length>0&&c.orders.rejected>0);
    assert.ok(Object.keys(c.orders.rejected_by_reason).length>0);
    const keys=[];
    const walk=value=>{if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')
      for(const [key,child] of Object.entries(value)){if(value!==c.orders.rejected_by_reason)keys.push(key);walk(child);}};
    walk(envelope);
    assert.ok(keys.length>50);
    assert.equal(keys.some(key=>/(^|_)eta(_|$)|estimat|collection/i.test(key)),false);
    // Reads: exactly the three chunks through readV2, nothing else, never past development.
    const reads=readsOf(ctx);
    assert.ok(reads.every(read=>read.api==='research.readV2'));
    assert.deepEqual(reads.map(read=>[read.start,read.end,read.rows]),[[0,1000,1000],[1000,2000,1000],[2000,2100,100]]);
    assert.ok(reads.every(read=>read.maxTime<=d.development_end_time));
    assert.ok(reads.every(read=>read.signal!==callerAbort.signal&&read.signal!==undefined));
    assert.equal(ctx.world.calls.some(call=>String(call.api).endsWith('DENIED')),false);
    // Requests: mapping, byte-identical checkpoint re-send, canonical wire, ASCII only.
    assert.equal(pairs.length,3);
    assert.ok(pairs.every(pair=>pair.exitCode===0));
    const requests=pairs.map(pair=>JSON.parse(pair.input.toString('utf8')));
    const responses=pairs.map(pair=>JSON.parse(pair.stdout.toString('latin1',0,pair.stdout.length-1)));
    assert.ok(requests.every(request=>request.version===PF2_CHUNK_VERSION));
    assert.deepEqual(requests[0].contract,resolved.contract);
    assert.deepEqual(requests.map(request=>request.rows.length),[1000,1000,100]);
    assert.equal(requests[0].checkpoint,null);
    assert.equal(canonical(requests[1].checkpoint),canonical(responses[0].checkpoint));
    assert.equal(canonical(requests[2].checkpoint),canonical(responses[1].checkpoint));
    assert.equal(requests[0].rows[0].time,d.first_time);
    assert.deepEqual(buildChunkRequest(resolved,requests[1].rows,requests[1].checkpoint),requests[1]);
    assert.equal(encodeChunkRequest(buildChunkRequest(resolved,requests[0].rows,null)).compare(pairs[0].input),0);
    assert.ok(pairs.every(pair=>pair.input.length<PF2_REPLAY_LIMITS.ipcBytes));
    // Non-vacuous state for the size tests, and tokens: one per intermediate chunk, none for the last.
    assert.ok(canonical(responses[1].checkpoint).length>4096);
    assert.equal(tokens.length,2);
    assert.deepEqual(tokens.map(token=>token.next_bar),[1000,2000]);
    assert.ok(tokens.every(token=>isDeepFrozen(token)&&token.version===PF2_RESUME_VERSION));
    assert.equal(responses[2].result!==null&&responses[0].result===null&&responses[1].result===null,true);
    // Rows are forwarded as canonical decimal text only (no exponent, no trailing zeros, no number).
    assert.ok(requests.every(request=>request.rows.every(row=>['open','high','low','close','volume','atr14']
      .every(name=>/^[0-9]+(\.[0-9]*[1-9])?$/.test(row[name])))));
  });


  const realRunner=()=>createLocalPythonRunner({python,developmentOnly:true,shim:SHIM});
  const withoutRun=envelope=>{const {run,...rest}=envelope;void run;return rest;};

  await t.test('determinism and chunk invariance: same result whatever the chunking',async st=>{
    if(needPython(st))return;
    const runner=realRunner();
    const again=await runOn(await open(baseScenario),{runChunk:runner});
    assert.equal(canonical(withoutRun(again)),canonical(withoutRun(baseline.envelope)));
    const {plan_hash:basePlan,...baseRest}=baseline.envelope.result;
    for(const chunkBars of [700,2100]){
      const scenario=await scenarioOf({plan:plan=>{plan.foundation.budget.chunk_bars=chunkBars;}});
      const envelope=await runOn(await open(scenario),{runChunk:runner});
      assert.deepEqual(envelope.run,{chunk_bars:chunkBars,chunks_executed:Math.ceil(2100/chunkBars),resumed_from_bar:0});
      const {plan_hash:otherPlan,...rest}=envelope.result;
      assert.notEqual(otherPlan,basePlan);
      assert.equal(canonical(rest),canonical(baseRest));
    }
  });

  await t.test('resume: real tokens equal the uninterrupted run and carry the runtime budget',async st=>{
    if(needPython(st))return;
    const runner=realRunner();
    for(const [index,chunks] of [[0,2],[1,1]]){
      const token=baseline.tokens[index];
      const ctx=await open(baseScenario);
      const emitted=[];
      const envelope=await runOn(ctx,{runChunk:runner,resume:token,onCheckpoint:async next=>{emitted.push(next);}});
      assert.equal(canonical(envelope.result),canonical(baseline.envelope.result));
      assert.equal(canonical(withoutRun(envelope)),canonical(withoutRun(baseline.envelope)));
      assert.deepEqual(envelope.run,{chunk_bars:1000,chunks_executed:chunks,resumed_from_bar:token.next_bar});
      const reads=readsOf(ctx);
      assert.equal(reads.length,chunks);
      assert.equal(reads[0].start,token.next_bar);
      assert.ok(reads.every(read=>read.start>=token.next_bar));
      assert.equal(emitted.length,chunks-1);
      assert.ok(emitted.every(next=>next.next_bar>token.next_bar&&next.elapsed_ms>=token.elapsed_ms));
    }
  });

  await t.test('cancel inside onCheckpoint: the token stays valid and resumes to the same result',async st=>{
    if(needPython(st))return;
    const controller=new AbortController(),replay=replayRunner(baseline.pairs);
    let token=null;
    await rejectsWith(runOn(await open(baseScenario),{runChunk:replay,signal:controller.signal,
      onCheckpoint:async next=>{token=next;controller.abort();}}),'PF2_CANCELLED');
    assert.equal(replay.calls.length,1);
    assert.equal(canonical(token.checkpoint),canonical(baseline.tokens[0].checkpoint));
    const resumed=await runOn(await open(baseScenario),{runChunk:replayRunner(baseline.pairs),resume:token});
    assert.equal(canonical(resumed.result),canonical(baseline.envelope.result));
  });

  await t.test('resume tamper: every edit is refused before any read, hash or spawn',async st=>{
    if(needPython(st))return;
    const ctx=baseline.ctx,first=ctx.resolved.dataset.first_time;
    const other=await open(await scenarioOf({bridge:{atr_multiplier:'2',rr:'2'}}));
    const forge=(edit,seal=true)=>{const token=clone(baseline.tokens[0]);edit(token);return seal?sealToken(token):token;};
    const refuse=async(token,code='PF2_RESUME_INVALID')=>{
      const before=ctx.world.reads.length;
      const runner=counting(async()=>{throw new Error('spawn');});
      let hashes=0;
      await rejectsWith(runOn(ctx,{resume:token,runChunk:runner,readFile:async()=>{hashes++;throw new Error('hash');}}),code);
      assert.deepEqual([ctx.world.reads.length-before,runner.calls.length,hashes],[0,0,0]);
    };
    const cases=[
      forge(token=>{token.extra=1;}),forge(token=>{token.extra=1;},false),
      forge(token=>{token.version='pf2-replay-resume-v0';}),
      forge(token=>{token.token_sha256=sha('0');},false),
      forge(token=>{token.plan_hash=sha('a');}),
      forge(token=>{token.contract_sha256=sha('b');}),
      forge(token=>{token.resolved_sha256=sha('c');}),
      forge(token=>{token.plan_hash=other.resolved.plan_hash;
        token.contract_sha256=hash(canonical(other.resolved.contract));
        token.resolved_sha256=hash(canonical(other.resolved));}),
      forge(token=>{token.engine_hash=sha('d');}),forge(token=>{token.evaluator_hash=sha('e');}),
      forge(token=>{token.next_bar=0;}),forge(token=>{token.next_bar=2100;}),forge(token=>{token.next_bar=2101;}),
      forge(token=>{token.next_bar=1001;token.last_time=first+1000*MINUTE;}),
      forge(token=>{token.last_time+=MINUTE;}),
      forge(token=>{token.checkpoint.integrity=sha('9');}),
      forge(token=>{token.contract_digest=sha('8');}),
      forge(token=>{token.checkpoint.evaluator.zz='\u00e9';sealCheckpoint(token.checkpoint);}),
      forge(token=>{token.checkpoint.evaluator.zz=1.5;sealCheckpoint(token.checkpoint);}),
      forge(token=>{token.checkpoint.paper.pad='x'.repeat(1_100_000);sealCheckpoint(token.checkpoint);}),
      forge(token=>{token.elapsed_ms=-1;}),forge(token=>{token.elapsed_ms=1.5;}),
      forge(token=>{delete token.checkpoint;}),null,'token',[]];
    for(const token of cases)await refuse(token);
    // A spent budget is a deadline, not a tampered token; it is judged after the integrity checks.
    await refuse(forge(token=>{token.elapsed_ms=ctx.resolved.budget.max_runtime_ms;}),'PF2_DEADLINE_EXCEEDED');
    await refuse(forge(token=>{token.elapsed_ms=ctx.resolved.budget.max_runtime_ms;},false),'PF2_RESUME_INVALID');
    // Both integrities re-signed over inflated counters: only the S1 core notices (second gate).
    const inflated=forge(token=>{token.checkpoint.counters.signals.buy+=1000;sealCheckpoint(token.checkpoint);});
    await rejectsWith(runOn(ctx,{resume:inflated,runChunk:realRunner()}),'PF2_CHECKPOINT_INVALID');
  });

  await t.test('resume token detaches once and never runs a getter',async st=>{
    if(needPython(st))return;
    const ctx=baseline.ctx,token=clone(baseline.tokens[0]);
    const traps={get:0,descriptors:new Map()};
    const spied=new Proxy(token,{get(){traps.get++;throw new Error(MARKER);},
      getOwnPropertyDescriptor(target,name){
        traps.descriptors.set(name,(traps.descriptors.get(name)??0)+1);
        return Reflect.getOwnPropertyDescriptor(target,name);}});
    const replay=replayRunner(baseline.pairs);
    const envelope=await runOn(ctx,{resume:spied,runChunk:replay});
    assert.equal(canonical(envelope.result),canonical(baseline.envelope.result));
    assert.equal(traps.get,0);
    assert.ok([...traps.descriptors.values()].every(count=>count===1));
    const getter=clone(baseline.tokens[0]);
    Object.defineProperty(getter,'elapsed_ms',{enumerable:true,configurable:true,get(){return 0;}});
    await rejectsWith(runOn(ctx,{resume:getter,runChunk:replayRunner(baseline.pairs)}),'PF2_RESUME_INVALID');
  });

  const shared=await open(baseScenario);
  const noSpawn=()=>counting(async()=>{throw new Error('unexpected spawn');});
  /** Store double: same read surface, rows passed through an async generator transform. */
  const withRows=(ctx,transform)=>({readV2:(reference,options)=>transform(ctx.research.readV2(reference,options),options)});
  const eventTarget=()=>{
    const state={aborted:false,added:0,removed:0,listeners:new Set()};
    state.addEventListener=(type,listener)=>{assert.equal(type,'abort');state.added++;state.listeners.add(listener);};
    state.removeEventListener=(type,listener)=>{state.removed++;state.listeners.delete(listener);};
    state.abort=()=>{state.aborted=true;for(const listener of [...state.listeners])listener();};
    return state;
  };

  await t.test('cancellation: pre-aborted, polling signal-likes, adapter shadowing, listener hygiene',async()=>{
    const ctx=shared,before=ctx.world.reads.length;
    const pre=new AbortController();
    pre.abort();
    const runner=noSpawn();
    let hashes=0;
    await rejectsWith(runOn(ctx,{signal:pre.signal,runChunk:runner,readFile:async()=>{hashes++;throw new Error('hash');}}),
      'PF2_CANCELLED');
    await rejectsWith(runHistoricalPreflight({signal:pre.signal}),'PF2_CANCELLED');
    assert.deepEqual([ctx.world.reads.length-before,runner.calls.length,hashes],[0,0,0]);
    for(const signal of [null,{},{aborted:'no'},7]){
      await rejectsWith(runOn(ctx,{signal,runChunk:noSpawn()}),'PF2_REPLAY_CONFIG_INVALID');
    }
    // A signal-like without addEventListener is polled: a flip after the child is seen at the next poll.
    const like={aborted:false};
    const flip=counting(async()=>{like.aborted=true;return {exitCode:0,stdout:Buffer.from('x\n')};});
    await rejectsWith(runOn(ctx,{signal:like,runChunk:flip}),'PF2_CANCELLED');
    assert.equal(flip.calls.length,1);
    let reads=0;
    const breaking={get aborted(){if(reads++>0)throw new Error(MARKER);return false;}};
    await rejectsWith(runOn(ctx,{signal:breaking,runChunk:noSpawn()}),'PF2_REPLAY_CONFIG_INVALID');
    // An adapter that shadows `aborted` on the signal it received changes nothing: the driver never reads it.
    const shadow=(signal,thrown)=>{
      Object.defineProperty(signal,'aborted',{configurable:true,get(){throw thrown;}});
      throw thrown;
    };
    const thrower=craftedError('PF2_CANCELLED');
    await rejectsWith(runOn(ctx,{research:{readV2:(reference,options)=>shadow(options.signal,thrower)},
      runChunk:noSpawn()}),'PF2_DATASET_READ_FAILED');
    await rejectsWith(runOn(ctx,{runChunk:(input,options)=>{
      Object.defineProperty(options.signal,'aborted',{configurable:true,value:true});
      throw craftedError('PF2_CANCELLED');}}),'PF2_RUNNER_FAILED');
    await rejectsWith(runOn(ctx,{runChunk:(input,options)=>shadow(options.signal,new Error(MARKER))}),'PF2_RUNNER_FAILED');
    // The caller listener is removed after a failure, and a caller abort runs through the same path.
    const failing=eventTarget();
    await rejectsWith(runOn(ctx,{signal:failing,runChunk:counting(async()=>{throw new Error(MARKER);})}),'PF2_RUNNER_FAILED');
    assert.deepEqual([failing.added,failing.removed,failing.listeners.size],[1,1,0]);
    const aborting=eventTarget();
    await rejectsWith(runOn(ctx,{signal:aborting,runChunk:counting(async()=>{aborting.abort();return {exitCode:0,stdout:Buffer.from('x\n')};})}),
      'PF2_CANCELLED');
    assert.deepEqual([aborting.added,aborting.removed,aborting.listeners.size],[1,1,0]);
  });

  await t.test('cancellation: a successful replay removes its listener and hands adapters driver signals only',async st=>{
    if(needPython(st))return;
    const watch=watchUnhandled();
    try{
      const ctx=await open(baseScenario),target=eventTarget(),replay=replayRunner(baseline.pairs);
      const envelope=await runOn(ctx,{signal:target,runChunk:replay});
      assert.equal(canonical(envelope.result),canonical(baseline.envelope.result));
      assert.deepEqual([target.added,target.removed,target.listeners.size],[1,1,0]);
      assert.ok(replay.calls.every(call=>call.options.signal instanceof AbortSignal&&call.options.signal!==target));
      assert.ok(readsOf(ctx).every(read=>read.signal instanceof AbortSignal));
      // One fresh signal per chunk, shared by that chunk's read and child.
      assert.equal(new Set([...replay.calls.map(call=>call.options.signal),...readsOf(ctx).map(read=>read.signal)]).size,
        replay.calls.length);
      await flush();
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('cancellation: a real child is killed when the caller aborts',async st=>{
    if(needPython(st))return;
    const ctx=await open(baseScenario),controller=new AbortController();
    const folder=await mkdtemp(path.join(TMP,'pf2-shim-'));
    await writeFile(path.join(folder,'pf2-shim.enable'),'1');
    const saved=Object.fromEntries(['TEMP','TMP','TMPDIR'].map(name=>[name,process.env[name]]));
    const spawned=[];
    try{
      for(const name of Object.keys(saved))process.env[name]=folder;
      const shimRunner=createLocalPythonRunner({python,developmentOnly:true,shim:SHIM,onSpawn:pid=>spawned.push(pid)});
      const running=outcome(runOn(ctx,{runChunk:shimRunner,signal:controller.signal}));
      await until(()=>existsSync(path.join(folder,'pf2-shim.pid')),20000);
      controller.abort();
      const error=await running;
      hygiene(error);
      assert.equal(error.code,'PF2_CANCELLED');
      const shimPid=Number((await readFile(path.join(folder,'pf2-shim.pid'),'utf8')).trim());
      assert.ok(Number.isSafeInteger(shimPid)&&spawned.length===1);
      await until(()=>!alive(spawned[0])&&!alive(shimPid),10000);
    }finally{
      for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
      await rm(folder,{recursive:true,force:true});
    }
    assert.equal(spawned.length,1);
  });

  const hungRunner=()=>counting((input,options)=>new Promise((_,reject)=>{
    options.signal.addEventListener('abort',()=>reject(new Error(MARKER)),{once:true});}));
  const hungStore={readV2:()=>({[Symbol.asyncIterator]:()=>({next:stuck,return:async()=>({done:true})})})};

  await t.test('deadline and timeouts: fake clock, mock timers, no spawn past the budget',async()=>{
    const ctx=shared,watch=watchUnhandled();
    try{
      // Under 100 ms left at spawn time: nothing starts.
      let clock=fakeClock(0),runner=noSpawn();
      await rejectsWith(runOn(ctx,{clock,runChunk:runner,research:withRows(ctx,async function*(rows){
        clock.state.now=899950;yield* rows;})}),'PF2_DEADLINE_EXCEEDED');
      assert.equal(runner.calls.length,0);
      // Hung child with under 30 s left: the wall timer aborts the chunk.
      mock.timers.enable({apis:['setTimeout']});
      try{
        clock=fakeClock(0);
        let hung=hungRunner();
        let running=outcome(runOn(ctx,{clock,runChunk:hung,research:withRows(ctx,async function*(rows){
          clock.state.now=880000;yield* rows;})}));
        await untilTick(()=>hung.calls.length===1);
        mock.timers.tick(20000);
        let error=await running;
        hygiene(error);
        assert.equal(error.code,'PF2_DEADLINE_EXCEEDED');
        assert.equal(hung.calls[0].options.signal.aborted,true);
        // Hung child with plenty of budget left: the 30 s chunk timer fires.
        clock=fakeClock(0);
        hung=hungRunner();
        running=outcome(runOn(ctx,{clock,runChunk:hung}));
        await untilTick(()=>hung.calls.length===1);
        mock.timers.tick(29999);
        await flush();
        assert.equal(hung.calls[0].options.signal.aborted,false);
        mock.timers.tick(1);
        error=await running;
        hygiene(error);
        assert.equal(error.code,'PF2_CHUNK_TIMEOUT');
        assert.equal(hung.calls[0].options.signal.aborted,true);
        // Hung store read and hung hash: the one run-level wall timer stops them.
        clock=fakeClock(0);
        running=outcome(runOn(ctx,{clock,research:hungStore,runChunk:noSpawn()}));
        await flush();
        mock.timers.tick(ctx.resolved.budget.max_runtime_ms);
        error=await running;
        hygiene(error);
        assert.equal(error.code,'PF2_DEADLINE_EXCEEDED');
        let hashCalls=0;
        running=outcome(runOn(ctx,{clock:fakeClock(0),runChunk:noSpawn(),readFile:()=>{hashCalls++;return stuck();}}));
        await untilTick(()=>hashCalls===1);
        mock.timers.tick(ctx.resolved.budget.max_runtime_ms);
        error=await running;
        hygiene(error);
        assert.equal(error.code,'PF2_DEADLINE_EXCEEDED');
      }finally{mock.timers.reset();}
      await flush();
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('deadline: a spent budget stops the next chunk, a hung sink is stopped, tokens stay valid',async st=>{
    if(needPython(st))return;
    const ctx=await open(baseScenario),watch=watchUnhandled();
    try{
      const clock=fakeClock(0),replay=replayRunner(baseline.pairs);
      let token=null;
      await rejectsWith(runOn(ctx,{clock,runChunk:replay,onCheckpoint:async next=>{
        token=next;clock.state.now=ctx.resolved.budget.max_runtime_ms;}}),'PF2_DEADLINE_EXCEEDED');
      assert.equal(replay.calls.length,1);
      const resumed=await runOn(ctx,{clock:fakeClock(0),runChunk:replayRunner(baseline.pairs),resume:token});
      assert.equal(canonical(resumed.result),canonical(baseline.envelope.result));
      // Cumulative active runtime: a token 1 ms short of the budget leaves 1 ms, not a fresh budget.
      const spent=clone(token);
      spent.elapsed_ms=ctx.resolved.budget.max_runtime_ms-1;
      sealToken(spent);
      const late=replayRunner(baseline.pairs);
      await rejectsWith(runOn(ctx,{clock:fakeClock(0),runChunk:late,resume:spent}),'PF2_DEADLINE_EXCEEDED');
      assert.equal(late.calls.length,0);
      mock.timers.enable({apis:['setTimeout']});
      try{
        let delivered=null;
        const running=outcome(runOn(ctx,{clock:fakeClock(0),runChunk:replayRunner(baseline.pairs),
          onCheckpoint:next=>{delivered=next;return stuck();}}));
        await untilTick(()=>delivered!==null);
        mock.timers.tick(ctx.resolved.budget.max_runtime_ms);
        const error=await running;
        hygiene(error);
        assert.equal(error.code,'PF2_DEADLINE_EXCEEDED');
        assert.equal(delivered.next_bar,1000);
      }finally{mock.timers.reset();}
      await flush();
      assert.deepEqual(watch.seen,[]);
    }finally{watch.stop();}
  });

  await t.test('clock: decreasing, non-finite, throwing and non-function clocks are configuration errors',async()=>{
    const ctx=shared;
    let calls=0;
    await rejectsWith(runOn(ctx,{clock:()=>calls++===0?10:5,runChunk:noSpawn()}),'PF2_REPLAY_CONFIG_INVALID');
    await rejectsWith(runOn(ctx,{clock:()=>NaN,runChunk:noSpawn()}),'PF2_REPLAY_CONFIG_INVALID');
    await rejectsWith(runOn(ctx,{clock:()=>{throw new Error(MARKER);},runChunk:noSpawn()}),'PF2_REPLAY_CONFIG_INVALID');
    await rejectsWith(runOn(ctx,{clock:'now',runChunk:noSpawn()}),'PF2_REPLAY_CONFIG_INVALID');
    for(const extra of [{runChunk:undefined},{runChunk:'x'},{onCheckpoint:'x',runChunk:noSpawn()},
      {readFile:'x',runChunk:noSpawn()},{research:{},runChunk:noSpawn()},{research:null,runChunk:noSpawn()}])
      await rejectsWith(runOn(ctx,extra),'PF2_REPLAY_CONFIG_INVALID');
  });

  await t.test('runner output: scripted exit codes and bodies map to fixed codes',async()=>{
    const ctx=shared;
    const attempt=(runChunk,code)=>rejectsWith(runOn(ctx,{runChunk}),code);
    for(const code of PF2_S1_ERRORS)await attempt(fixedRunner(1,lineOf({error:code})),code);
    for(const body of [{error:'PF2_CANCELLED'},{error:'PF2_DEADLINE_EXCEEDED'},{error:'PF2_NOT_A_CODE'},
      {error:'PF2_EVALUATION_FAILED',extra:1},{error:MARKER}])
      await attempt(fixedRunner(1,lineOf(body)),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(1,Buffer.from('garbage')),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(1,Buffer.from('')),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(2,lineOf({error:'PF2_EVALUATION_FAILED'})),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(null,lineOf({error:'PF2_EVALUATION_FAILED'})),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner('1',lineOf({error:'PF2_EVALUATION_FAILED'})),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(1,lineOf({error:'PF2_EVALUATION_FAILED'}).toString()),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(0,lineOf({error:'PF2_EVALUATION_FAILED'})),'PF2_RESPONSE_INVALID');
    for(const stdout of ['','\n','{"checkpoint":null,"result":null}\n','{"checkpoint":{},"result":null}\n','[]\n',
      '{"result":null,"checkpoint":{}}\n','{"checkpoint":{},"result":null}\n\n']){
      await attempt(fixedRunner(0,Buffer.from(stdout)),'PF2_RESPONSE_INVALID');
    }
    await attempt(async()=>{throw new Error(MARKER);},'PF2_RUNNER_FAILED');
    await attempt(async()=>{throw craftedError('PF2_LIMIT_EXCEEDED');},'PF2_RUNNER_FAILED');
    await attempt(async()=>undefined,'PF2_RUNNER_FAILED');
    await attempt(()=>{throw new Error(MARKER);},'PF2_RUNNER_FAILED');
    await attempt(async()=>({get exitCode(){throw new Error(MARKER);},stdout:Buffer.alloc(0)}),'PF2_RUNNER_FAILED');
    await attempt(fixedRunner(null,Buffer.alloc(PF2_REPLAY_LIMITS.ipcBytes+2,0x61)),'PF2_LIMIT_EXCEEDED');
    await attempt(fixedRunner(0,Buffer.alloc(PF2_REPLAY_LIMITS.ipcBytes+2,0x61)),'PF2_LIMIT_EXCEEDED');
    await attempt(fixedRunner(1,Buffer.alloc(PF2_REPLAY_LIMITS.ipcBytes+2,0x61)),'PF2_LIMIT_EXCEEDED');
    await attempt(fixedRunner(0,new Uint8Array(PF2_REPLAY_LIMITS.ipcBytes+2)),'PF2_LIMIT_EXCEEDED');
  });

  await t.test('captured responses: every tamper is refused with a fixed code',async st=>{
    if(needPython(st))return;
    const {pairs}=baseline,ctx=baseline.ctx,first=ctx.resolved.dataset.first_time;
    const parse=out=>JSON.parse(out.stdout.toString('latin1',0,out.stdout.length-1));
    const reply=value=>({exitCode:0,stdout:lineOf(value)});
    const tamper=(index,edit)=>editedReplay(pairs,index,(out,parsed)=>edit(out,parsed)??reply(parsed));
    const cp=parsed=>parsed.checkpoint;
    const at=(next)=>parsed=>{cp(parsed).next_bar=next;cp(parsed).last_time=first+(next-1)*MINUTE;sealCheckpoint(cp(parsed));};
    const finalResult=parse(pairs[2]).result;
    const cases=[
      [0,out=>({exitCode:0,stdout:Buffer.concat([out.stdout.subarray(0,-1),Buffer.from(' \n')])}),'PF2_RESPONSE_INVALID'],
      [0,(out,parsed)=>({exitCode:0,stdout:Buffer.from(JSON.stringify({result:parsed.result,checkpoint:parsed.checkpoint})+'\n')}),
        'PF2_RESPONSE_INVALID'],
      [0,out=>({exitCode:0,stdout:Buffer.from(out.stdout.toString('latin1').replace('{"checkpoint":',
        '{"checkpoint":0,"checkpoint":'),'latin1')}),'PF2_RESPONSE_INVALID'],
      [0,out=>({exitCode:0,stdout:Buffer.concat([out.stdout.subarray(0,-1),Buffer.from([0xc3,0xa9,0x0a])])}),'PF2_RESPONSE_INVALID'],
      [0,out=>({exitCode:0,stdout:out.stdout.subarray(0,-1)}),'PF2_RESPONSE_INVALID'],
      [0,out=>({exitCode:0,stdout:Buffer.concat([out.stdout,out.stdout])}),'PF2_RESPONSE_INVALID'],
      [0,(out,parsed)=>{cp(parsed).identity.plan_hash=sha('b');sealCheckpoint(cp(parsed));},'PF2_RESPONSE_INVALID'],
      [1,(out,parsed)=>{cp(parsed).identity.contract_digest=sha('c');sealCheckpoint(cp(parsed));},'PF2_RESPONSE_INVALID'],
      [1,(out,parsed)=>at(1000)(parsed),'PF2_RESPONSE_INVALID'],
      [1,(out,parsed)=>at(2001)(parsed),'PF2_RESPONSE_INVALID'],
      [0,(out,parsed)=>{cp(parsed).last_time+=MINUTE;sealCheckpoint(cp(parsed));},'PF2_RESPONSE_INVALID'],
      [0,(out,parsed)=>{cp(parsed).integrity=sha('7');},'PF2_RESPONSE_INVALID'],
      [0,(out,parsed)=>{parsed.result=finalResult;},'PF2_RESPONSE_INVALID'],
      [2,(out,parsed)=>{parsed.result=null;},'PF2_RESPONSE_INVALID'],
      [2,(out,parsed)=>{parsed.result.counters.fills.buy+=1;},'PF2_RESULT_INVALID'],
      [2,(out,parsed)=>{parsed.result.counters.signals.buy=99999;},'PF2_RESULT_INVALID']];
    for(const [index,edit,code] of cases){
      const runner=tamper(index,edit);
      await rejectsWith(runOn(ctx,{runChunk:runner}),code);
      assert.equal(runner.calls.length,index+1);
    }
    // The checkpoint size limit is judged against the resolved budget, before anything else about it.
    const small=await open(await scenarioOf({plan:plan=>{plan.foundation.budget.max_state_bytes=4096;}}));
    await rejectsWith(runOn(small,{runChunk:fixedRunner(0,pairs[1].stdout)}),'PF2_LIMIT_EXCEEDED');
    assert.equal(baseline.envelope.result.plan_hash,baseline.ctx.resolved.plan_hash);
  });

  await t.test('result invariants: each minimal break is refused, the real result passes',async st=>{
    if(needPython(st))return;
    const ctx=baseline.ctx,good=baseline.envelope.result;
    const S=ctx.resolved.dataset.evaluation_start_time,L=ctx.resolved.dataset.last_time;
    const refuse=(name,edit,resolved=ctx.resolved)=>{
      const value=clone(good);
      edit(value);
      assert.throws(()=>validatePreflightResult(resolved,value),error=>{
        hygiene(error);
        assert.equal(error.code,'PF2_RESULT_INVALID',name);
        return true;
      },name);
    };
    const loss=good.guards.pause.periods[0];
    assert.deepEqual(good.guards.pause.active_kinds,['LOSS_STREAK']);
    const breaks=[
      ['plan_hash',r=>{r.plan_hash=sha('1');}],['model version',r=>{r.execution_model_version='paper-close-cost-v2';}],
      ['development_only',r=>{r.admission.development_only=false;}],
      ['evaluator_admission',r=>{r.admission.evaluator_admission=true;}],
      ['holdout_accessed',r=>{r.admission.holdout_accessed=true;}],
      ['orders_executed',r=>{r.admission.orders_executed=true;}],
      ['parity',r=>{r.admission.execution_model_parity='V2';}],
      ['extra top key',r=>{r.extra=1;}],['result.eta',r=>{r.eta=1;}],
      ['pause.collection_eta',r=>{r.guards.pause.collection_eta=5;}],['window.estimated_end',r=>{r.window.estimated_end=5;}],
      ['a signals.buy',r=>{r.counters.signals.buy=2101;}],
      ['a buy_evaluated',r=>{r.counters.signals.buy_evaluated=r.counters.signals.buy+1;}],
      ['a native_exit_evaluated',r=>{r.counters.signals.native_exit_evaluated=r.counters.signals.native_exit+1;}],
      ['b intents.buy',r=>{r.counters.intents.buy=r.counters.signals.buy_evaluated+1;}],
      ['b warmup buy',r=>{r.counters.warmup_intents.buy=r.counters.signals.buy-r.counters.signals.buy_evaluated+1;}],
      ['b intents ceiling',r=>{r.counters.intents.exit_tp=1_000_000;}],
      ['c rejected map',r=>{r.counters.orders.rejected_by_reason.TARGET_NOT_OPEN+=1;}],
      ['c exit map',r=>{r.counters.fills.exit_by_reason.NATIVE=3;}],
      ['d accepted',r=>{r.counters.orders.accepted+=1;}],['e fills.buy',r=>{r.counters.fills.buy=3;}],
      ['f exit_native',r=>{r.counters.intents.exit_native=3;}],
      ['f exit reason',r=>{r.counters.fills.exit_by_reason={SL:4};}],
      ['g closed',r=>{r.counters.episodes.closed=5;}],['g losing',r=>{r.counters.episodes.losing=4;}],
      ['g flat needs an episode',r=>{r.counters.episodes={closed:0,losing:0};}],
      ['derived evaluated',r=>{r.derived.intents_evaluated+=1;}],['derived suppressed',r=>{r.derived.suppressed_buy+=1;}],
      ['derived suppressed evaluated',r=>{r.derived.suppressed_buy_evaluated+=1;}],
      ['derived non losing',r=>{r.derived.non_losing_episodes+=1;}],
      ['open_allocations',r=>{r.account.open_allocations=1;}],
      ['position zero mismatch',r=>{r.account.position_quantity='1';}],
      ['negative cash',r=>{r.account.cash='-1';}],['exponent cash',r=>{r.account.cash='1e5';}],
      ['long cash',r=>{r.account.cash='9'.repeat(81);}],
      ['last_time past end',r=>{r.window.last_time+=MINUTE;}],['bars_seen',r=>{r.window.bars_seen=2099;}],
      ['window development end',r=>{r.window.development_end_time-=MINUTE;}],
      ['persistent flag',r=>{r.guards.pause.persistent=false;}],['kill_switch flag',r=>{r.guards.kill_switch=true;}],
      ['loss_streak_final above losing',r=>{r.guards.loss_streak_final=4;}],
      ['active kinds empty',r=>{r.guards.pause.active_kinds=[];}],
      ['kill switch kind while off',r=>{r.guards.pause.active_kinds=['KILL_SWITCH','LOSS_STREAK'];
        r.guards.pause.periods=[{kind:'KILL_SWITCH',start_time:S,end_time:null,persistent:true},loss];}],
      ['kind order',r=>{r.guards.pause.active_kinds=['LOSS_STREAK','LOSS_STREAK'];}],
      ['closed end before start',r=>{r.guards.pause.periods=[{kind:'MAX_TRADES_PER_DAY',start_time:S+MINUTE,
        end_time:S+MINUTE,persistent:false},loss];}],
      ['closed persistent kind',r=>{r.guards.pause.periods=[{kind:'LOSS_STREAK',start_time:S,end_time:S+MINUTE,
        persistent:false},loss];}],
      ['closed past the last bar',r=>{r.guards.pause.periods=[{kind:'MAX_DAILY_LOSS',start_time:S,end_time:L+MINUTE,
        persistent:false},loss];}],
      ['closed after open',r=>{r.guards.pause.periods=[loss,{kind:'MAX_DAILY_LOSS',start_time:S,end_time:S+MINUTE,
        persistent:false}];}],
      ['open persistent flag',r=>{r.guards.pause.periods[0].persistent=false;}],
      ['period start before window',r=>{r.guards.pause.periods[0].start_time=S-MINUTE;}],
      ['period start unaligned',r=>{r.guards.pause.periods[0].start_time+=1;}],
      ['dropped without truncation',r=>{r.guards.pause.dropped_periods=1;}],
      ['truncated without drops',r=>{r.guards.pause.truncated=true;}],
      ['fill samples short',r=>{r.samples.fills.pop();}],['rejection samples short',r=>{r.samples.rejections.pop();}],
      ['rejection reason unknown',r=>{r.samples.rejections[0].reason='ZZZ';}],
      ['BUY with reason',r=>{r.samples.fills.find(item=>item.event_type==='BUY').reason='SL';}],
      ['EXIT without reason',r=>{r.samples.fills.find(item=>item.event_type==='EXIT').reason=null;}],
      ['EXIT reason unknown',r=>{r.samples.fills.find(item=>item.event_type==='EXIT').reason='X';}],
      ['entry_ref prefix',r=>{r.samples.fills[0].entry_ref='other:1';}],
      ['sizing outcome',r=>{r.samples.fills[0].sizing_outcome='X';}],
      ['sample string long',r=>{r.samples.fills[0].quantity='1'.repeat(81);}],
      ['sample time unaligned',r=>{r.samples.fills[0].time+=1;}],
      ['sample time before window',r=>{r.samples.fills[0].time=S-MINUTE;}],
      ['sample time decreasing',r=>{r.samples.fills[0].time=r.samples.fills[1].time+MINUTE;}],
      ['limitations order',r=>{r.limitations.reverse();}],['limitations extra',r=>{r.limitations.push('X');}],
      ['float counter',r=>{r.counters.intents.buy=1.5;}],['negative zero',r=>{r.counters.episodes.closed=-0;}],
      ['non-ascii text',r=>{r.account.cash='1\u00e9';}],['null result',()=>{}]];
    for(const [name,edit] of breaks){
      if(name==='null result'){
        assert.throws(()=>validatePreflightResult(ctx.resolved,null),error=>hygiene(error)&&error.code==='PF2_RESULT_INVALID');
        continue;
      }
      refuse(name,edit);
    }
    assert.deepEqual(validatePreflightResult(ctx.resolved,good),good);
  });

  await t.test('result invariants: near-miss variants pass, day pauses obey UTC midnight, detach happens once',async st=>{
    if(needPython(st))return;
    const ctx=baseline.ctx,good=baseline.envelope.result,d=ctx.resolved.dataset;
    const S=d.evaluation_start_time,L=d.last_time,DAY=86_400_000;
    const accepts=(value,resolved=ctx.resolved)=>assert.deepEqual(validatePreflightResult(resolved,value),value);
    const loss=good.guards.pause.periods[0];
    let value=clone(good);
    value.guards.pause.periods=[{kind:'MAX_TRADES_PER_DAY',start_time:S,end_time:S+MINUTE,persistent:false},loss];
    accepts(value);
    // A reason key is text from the risk evaluator: it may hold any printable words, even ETA-like ones.
    value=clone(good);
    const reason='Estimated collection ETA';
    for(const name of ['rejected_by_reason']){
      value.counters.orders[name][reason]=value.counters.orders[name].TARGET_NOT_OPEN;
      delete value.counters.orders[name].TARGET_NOT_OPEN;
    }
    for(const item of value.samples.rejections)if(item.reason==='TARGET_NOT_OPEN')item.reason=reason;
    accepts(value);
    // A window that crosses a UTC midnight: same result, every time shifted by ten hours.
    const delta=10*60*MINUTE;
    const shifted=clone(ctx.resolved);
    for(const name of ['first_time','evaluation_start_time','last_time','development_end_time','holdout_start_time',
      'development_start_time'])shifted.dataset[name]+=delta;
    for(const name of ['first_time','development_end_time','holdout_start_time'])shifted.contract.dataset[name]+=delta;
    shifted.dataset.research.raw.metadata.start_time+=delta;
    shifted.dataset.research.sidecar.first_time+=delta;
    const later=clone(good);
    for(const name of ['first_time','evaluation_start_time','last_time','development_end_time','holdout_start_time'])
      later.window[name]+=delta;
    for(const item of [...later.samples.fills,...later.samples.rejections,...later.guards.pause.periods])
      item.time===undefined?(item.start_time+=delta):(item.time+=delta);
    accepts(later,shifted);
    const midnight=(Math.floor((S+delta)/DAY)+1)*DAY;
    assert.ok(midnight<=L+delta&&midnight>S+delta);
    const dayPause=start=>{
      const next=clone(later);
      next.guards.pause.active_kinds=['MAX_TRADES_PER_DAY','LOSS_STREAK'];
      next.guards.pause.periods=[{kind:'MAX_TRADES_PER_DAY',start_time:start,end_time:null,persistent:false},
        next.guards.pause.periods[0]];
      return next;
    };
    accepts(dayPause(midnight),shifted);
    assert.throws(()=>validatePreflightResult(shifted,dayPause(S+delta)),error=>hygiene(error)&&error.code==='PF2_RESULT_INVALID');
    const closed=clone(later);
    closed.guards.pause.periods=[{kind:'MAX_TRADES_PER_DAY',start_time:S+delta,end_time:midnight,persistent:false},
      closed.guards.pause.periods[0]];
    accepts(closed,shifted);
    closed.guards.pause.periods[0].end_time=midnight+MINUTE;
    assert.throws(()=>validatePreflightResult(shifted,closed),error=>hygiene(error)&&error.code==='PF2_RESULT_INVALID');
    // One descriptor read per property, no get trap; a getter or a foreign prototype is refused.
    const traps={get:0,descriptors:new Map()};
    const spied=new Proxy(clone(good),{get(){traps.get++;throw new Error(MARKER);},
      getOwnPropertyDescriptor(target,name){
        traps.descriptors.set(name,(traps.descriptors.get(name)??0)+1);
        return Reflect.getOwnPropertyDescriptor(target,name);}});
    assert.deepEqual(validatePreflightResult(ctx.resolved,spied),good);
    assert.equal(traps.get,0);
    assert.ok([...traps.descriptors.values()].every(count=>count===1));
    const getter=clone(good);
    Object.defineProperty(getter,'plan_hash',{enumerable:true,configurable:true,get(){return good.plan_hash;}});
    assert.throws(()=>validatePreflightResult(ctx.resolved,getter),error=>hygiene(error)&&error.code==='PF2_RESULT_INVALID');
    assert.throws(()=>validatePreflightResult(ctx.resolved,Object.assign(Object.create({inherited:1}),clone(good))),
      error=>hygiene(error)&&error.code==='PF2_RESULT_INVALID');
    assert.throws(()=>validatePreflightResult(null,good),error=>hygiene(error)&&error.code==='PF2_RESOLVED_INVALID');
  });

  const single=plan=>{plan.foundation.budget.chunk_bars=2100;};

  await t.test('persistent pauses end to end: kill switch and loss streak',async st=>{
    if(needPython(st))return;
    const runner=realRunner();
    const ctx=await open(await scenarioOf({policy:{...baselinePolicy,killSwitch:true},plan:single}));
    const envelope=await runOn(ctx,{runner:undefined,runChunk:runner});
    const S=ctx.resolved.dataset.evaluation_start_time,r=envelope.result;
    assert.equal(envelope.run.chunks_executed,1);
    assert.equal(r.guards.kill_switch,true);
    assert.equal(r.guards.pause.persistent,true);
    assert.deepEqual(r.guards.pause.active_kinds,['KILL_SWITCH']);
    assert.deepEqual(r.guards.pause.periods,[{kind:'KILL_SWITCH',start_time:S,end_time:null,persistent:true}]);
    assert.equal(r.counters.fills.buy,0);
    assert.ok(r.counters.intents.buy>0);
    assert.ok(r.counters.orders.rejected_by_reason['Kill switch is active: entries paused']>0);
    assert.equal(JSON.stringify(envelope).includes('"eta"'),false);
    const moved=clone(r);
    moved.guards.pause.periods[0].start_time+=MINUTE;
    assert.throws(()=>validatePreflightResult(ctx.resolved,moved),error=>hygiene(error)&&error.code==='PF2_RESULT_INVALID');
    // The baseline run already ended paused by a loss streak (three losing episodes, pause after three).
    const base=baseline.envelope.result;
    assert.ok(base.counters.episodes.losing>=3&&base.guards.pause.active_kinds.includes('LOSS_STREAK'));
    assert.equal(base.guards.pause.persistent,true);
    const strict=await open(await scenarioOf({policy:{...baselinePolicy,pauseAfterLossStreak:1},plan:single}));
    const out=(await runOn(strict,{runChunk:runner})).result;
    if(out.counters.episodes.losing>0){
      assert.ok(out.guards.pause.active_kinds.includes('LOSS_STREAK'));
      assert.ok(out.guards.pause.periods.some(item=>item.kind==='LOSS_STREAK'&&item.persistent&&item.end_time===null));
      assert.ok(out.guards.loss_streak_final>=1);
    }
    assert.equal(out.guards.kill_switch,false);
  });

  await t.test('read bounds and store faults: no bar past development, nothing forwarded blindly',async()=>{
    const ctx=shared,dev=ctx.resolved.dataset.development_end_time;
    const faulty=async(transform,code)=>{
      const runner=noSpawn();
      await rejectsWith(runOn(ctx,{research:withRows(ctx,transform),runChunk:runner}),code);
      assert.equal(runner.calls.length,0);
    };
    const patchRow=(index,edit)=>async function*(rows){
      let at=0;
      for await(const row of rows)yield at++===index?edit({...row}):row;
    };
    await faulty(async function*(rows){
      let last=null;
      for await(const row of rows){yield row;last=row;}
      yield {...last,time:last.time+MINUTE};
    },'PF2_DATASET_READ_FAILED');
    await faulty(async function*(rows){let at=0;for await(const row of rows)if(at++<999)yield row;},'PF2_DATASET_READ_FAILED');
    await faulty(patchRow(5,row=>({...row,time:dev+MINUTE})),'PF2_HOLDOUT_BOUNDARY_VIOLATION');
    await faulty(patchRow(3,row=>({...row,time:row.time+MINUTE})),'PF2_ROW_CONTINUITY');
    await faulty(patchRow(3,row=>({...row,time:'x'})),'PF2_ROW_INVALID');
    await faulty(patchRow(3,row=>({...row,time:row.time+0.5})),'PF2_ROW_INVALID');
    const bad=['1e5','-1','+1',' 1','','1.0000000000000000001','0','abc','1'+'0'.repeat(20),'1'.repeat(65),100.5,null,undefined,{},['1']];
    for(const value of bad){
      for(const field of ['open','high','low','close','atr14'])await faulty(patchRow(2,row=>({...row,[field]:value})),'PF2_ROW_INVALID');
    }
    for(const value of ['-0','1e5','x',0.5,null])await faulty(patchRow(2,row=>({...row,volume:value})),'PF2_ROW_INVALID');
    for(const shape of [row=>({time:row.time}),row=>({...row,extra:1}),()=>null,()=>[],()=>'row',
      row=>Object.defineProperty({...row},'close',{enumerable:true,get(){return '100';}}),
      row=>Object.assign(Object.create({inherited:1}),row)])
      await faulty(patchRow(4,shape),'PF2_ROW_INVALID');
    // Text with trailing zeros is real store output; zero volume is allowed; both reach S1 normalized.
    const runner=counting(async()=>{throw new Error(MARKER);});
    await rejectsWith(runOn(ctx,{research:withRows(ctx,patchRow(2,row=>({...row,close:'109.8200000',volume:'0.00000000'}))),
      runChunk:runner}),'PF2_RUNNER_FAILED');
    const sent=JSON.parse(runner.calls[0].input.toString('utf8'));
    assert.equal(sent.rows[2].close,'109.82');
    assert.equal(sent.rows[2].volume,'0');
    // Store failures of every kind give one fixed code; the thrown value is never read.
    await faulty(async function*(){throw craftedError('PF2_CANCELLED');},'PF2_DATASET_READ_FAILED');
    await faulty(async function*(rows){let at=0;for await(const row of rows){if(at++===10)throw new Error(MARKER);yield row;}},
      'PF2_DATASET_READ_FAILED');
    for(const research of [{readV2:()=>undefined},{readV2:()=>({})},{readV2:()=>{throw new Error(MARKER);}},
      {readV2:()=>({[Symbol.asyncIterator]:()=>({next:async()=>7})})},
      {readV2:()=>new Proxy({},{get(){throw new Error(MARKER);}})}]){
      await rejectsWith(runOn(ctx,{research,runChunk:noSpawn()}),'PF2_DATASET_READ_FAILED');
    }
    // One return() per chunk read, even when the read fails part way.
    let returns=0;
    const counted={readV2:(reference,options)=>{
      const inner=ctx.research.readV2(reference,options)[Symbol.asyncIterator]();
      return {[Symbol.asyncIterator]:()=>({next:()=>inner.next(),return:()=>{returns++;return inner.return();}})};}};
    await rejectsWith(runOn(ctx,{research:counted,runChunk:counting(async()=>{throw new Error(MARKER);})}),'PF2_RUNNER_FAILED');
    assert.equal(returns,1);
    // A flipped byte in the closed rows or the ATR sidecar after enrollment: the store refuses the read.
    for(const parts of [[base.researchReference.raw.dataset_id,'chunk-00000.jsonl'],
      ['atr14-v2-'+base.researchReference.sidecar.sha256,'chunk-00000.jsonl']]){
      const copy=await base.cloneStores(t);
      const world=makeWorld(base,baseScenario,{stores:copy});
      const resolved=await world.resolve();
      const file=path.join(copy.root,...parts),bytes=await readFile(file);
      bytes[10]^=1;
      await writeFile(file,bytes);
      await rejectsWith(runHistoricalPreflight({resolved,research:world.trusted.datasets.research,runChunk:noSpawn()}),
        'PF2_DATASET_READ_FAILED');
    }
  });

  await t.test('limits: the request size limit is enforced before a child exists',async()=>{
    const roomy={version:PF2_CHUNK_VERSION,contract:{pad:'x'.repeat(PF2_REPLAY_LIMITS.ipcBytes-200)},rows:[],checkpoint:null};
    assert.ok(encodeChunkRequest(roomy).length<=PF2_REPLAY_LIMITS.ipcBytes);
    assert.throws(()=>encodeChunkRequest({...roomy,contract:{pad:'x'.repeat(PF2_REPLAY_LIMITS.ipcBytes)}}),
      error=>hygiene(error)&&error.code==='PF2_LIMIT_EXCEEDED');
    assert.throws(()=>encodeChunkRequest(1n),error=>hygiene(error)&&error.code==='PF2_REPLAY_CONFIG_INVALID');
  });

  await t.test('limits: state and output sizes fail closed in Node and in S1',async st=>{
    if(needPython(st))return;
    const {pairs}=baseline,runner=realRunner();
    // S1 refuses first: a state over max_state_bytes and a result over max_output_bytes (one chunk each).
    await rejectsWith(runOn(await open(await scenarioOf({plan:plan=>{single(plan);plan.foundation.budget.max_state_bytes=4096;}})),
      {runChunk:runner}),'PF2_LIMIT_EXCEEDED');
    await rejectsWith(runOn(await open(await scenarioOf({plan:plan=>{single(plan);plan.foundation.budget.max_output_bytes=1024;}})),
      {runChunk:runner}),'PF2_LIMIT_EXCEEDED');
    // Node judges the same numbers on its own: a forged, otherwise valid final response.
    const forged=resolved=>{
      const parsed=JSON.parse(pairs[2].stdout.toString('latin1',0,pairs[2].stdout.length-1));
      parsed.checkpoint.identity.plan_hash=resolved.plan_hash;
      sealCheckpoint(parsed.checkpoint);
      parsed.result.plan_hash=resolved.plan_hash;
      return fixedRunner(0,lineOf(parsed));
    };
    const roomyRun=await open(await scenarioOf({plan:single}));
    const envelope=await runOn(roomyRun,{runChunk:forged(roomyRun.resolved)});
    assert.equal(envelope.result.counters.fills.buy,baseline.envelope.result.counters.fills.buy);
    const tight=await open(await scenarioOf({plan:plan=>{single(plan);plan.foundation.budget.max_output_bytes=1024;}}));
    await rejectsWith(runOn(tight,{runChunk:forged(tight.resolved)}),'PF2_LIMIT_EXCEEDED');
  });

  await t.test('executable re-check: brackets every child with the hashed bytes on disk',async st=>{
    if(needPython(st))return;
    const {pairs}=baseline;
    const hashing=mutate=>{
      let call=0;
      const reader=async url=>{
        const name=fileURLToPath(url).split(path.sep).join('/');
        if(name.endsWith('/'+PF2_ENGINE_FILES[0]))call++;
        return mutate(name,call,await readFile(url));
      };
      reader.count=()=>call;
      return reader;
    };
    const tail=(file,from)=>(name,call,bytes)=>name.endsWith('/'+file)&&call>=from?Buffer.concat([bytes,Buffer.from('\n#')]):bytes;
    const attempt=async(readFile,code,spawns)=>{
      const replay=replayRunner(pairs);
      let token=null;
      await rejectsWith(runOn(baseline.ctx,{runChunk:replay,readFile,onCheckpoint:async next=>{token??=next;}}),code);
      assert.equal(replay.calls.length,spawns);
      return token;
    };
    const token=await attempt(hashing(tail('quant_lab/src/robot_quant/pf2_replay.py',2)),'PF2_ENGINE_HASH_MISMATCH',1);
    assert.equal(canonical(token.checkpoint),canonical(baseline.tokens[0].checkpoint));
    // The evaluator layer is judged first: its files are a subset of the engine files.
    await attempt(hashing(tail('quant_lab/src/robot_quant/spt_evaluator.py',2)),'PF2_EVALUATOR_HASH_MISMATCH',1);
    await attempt(hashing(tail('quant_lab/src/robot_quant/pf2_replay.py',1)),'PF2_ENGINE_HASH_MISMATCH',0);
    await attempt(hashing(tail('src/money.js',3)),'PF2_ENGINE_HASH_MISMATCH',2);
    // The final check after the last response.
    await attempt(hashing(tail('quant_lab/src/robot_quant/paper_state.py',4)),'PF2_ENGINE_HASH_MISMATCH',3);
    await attempt(hashing((name,call,bytes)=>{if(call>=2)throw new Error(MARKER);return bytes;}),'PF2_ENGINE_HASH_MISMATCH',1);
    await attempt(hashing((name,call,bytes)=>call>=2?'text':bytes),'PF2_ENGINE_HASH_MISMATCH',1);
    // The driver hashes itself with the engine: editing it between two children stops the run.
    await attempt(hashing(tail(REPLAY_FILE,2)),'PF2_ENGINE_HASH_MISMATCH',1);
    const clean=hashing((name,call,bytes)=>bytes);
    const replay=replayRunner(pairs);
    const envelope=await runOn(baseline.ctx,{runChunk:replay,readFile:clean});
    assert.equal(canonical(envelope.result),canonical(baseline.envelope.result));
    assert.equal(clean.count(),4);
    // Hashes reach only the injected reader: never a signal, and one URL argument.
    const seen=[];
    await runOn(baseline.ctx,{runChunk:replayRunner(pairs),readFile:async(...args)=>{seen.push(args.length);return readFile(args[0]);}});
    assert.ok(seen.length===4*PF2_ENGINE_FILES.length&&seen.every(count=>count===1));
  });

  await t.test('runner factory: options are validated, a missing interpreter is a runner failure',async()=>{
    // Never the resolved test interpreter here: these cases hold whether or not one exists.
    const absolute=path.join(TMP,'no-such-dir','python-missing'+(process.platform==='win32'?'.exe':''));
    const good={python:absolute,developmentOnly:true};
    const invalid=[undefined,null,'x',{},{...good,developmentOnly:undefined},{...good,developmentOnly:'true'},
      {...good,python:''},{...good,python:7},{...good,python:'bin/python'},{...good,python:'./bin/python'},
      {...good,python:'python'},{...good,python:'python3.12'},{...good,python:'py.exe'},{...good,python:absolute+'\0x'},
      {...good,python:'bin\\python'},{...good,python:'.\\bin\\python'},{...good,python:'quant_lab\\.venv\\Scripts\\python.exe'},
      {...good,python:'C:python'},{...good,python:'C:bin/python'},
      {...good,python:'py\0thon'},{...good,shim:resolve(root,'test','helpers','other.py')},
      {...good,shim:resolve(root,'test','preflight-replay.test.js')},{...good,shim:'pf2_replay_shim.py'},
      {...good,shim:resolve(root,'src','pf2_replay_shim.py')},{...good,shim:7},{...good,onSpawn:'x'}];
    for(const options of invalid){
      assert.throws(()=>createLocalPythonRunner(options),error=>hygiene(error)&&error.code==='PF2_REPLAY_CONFIG_INVALID');
    }
    assert.equal(typeof createLocalPythonRunner(good),'function');
    assert.equal(typeof createLocalPythonRunner({...good,shim:SHIM,onSpawn:()=>{}}),'function');
    const spawned=[];
    const runner=createLocalPythonRunner({python:absolute,developmentOnly:true,onSpawn:pid=>spawned.push(pid)});
    await rejectsWith(runOn(shared,{runChunk:runner}),'PF2_RUNNER_FAILED');
    assert.deepEqual(spawned,[]);
    // A signal that is already aborted never starts a child.
    const stopped=new AbortController();
    stopped.abort();
    assert.deepEqual(await runner(Buffer.from('{}'),{signal:stopped.signal}),{exitCode:null,stdout:Buffer.alloc(0)});
  });

  await t.test('runner pinning: the real module runs from the hashed source root and inherits nothing',async st=>{
    if(needPython(st))return;
    const folder=await mkdtemp(path.join(TMP,'pf2-inherit-'));
    const marker=path.join(folder,'marker.txt');
    const saved=Object.fromEntries(['PYTHONPATH','PYTHONSTARTUP','QUANT_IO_TERMINAL_PROTOCOL'].map(name=>[name,process.env[name]]));
    try{
      await writeFile(path.join(folder,'sitecustomize.py'),
        'import os\nopen(os.path.join(os.path.dirname(os.path.abspath(__file__)), "marker.txt"), "w").write("inherited")\n');
      // Control: an interpreter that inherits this PYTHONPATH does import the marker module at startup.
      const control=spawnSync(python,['-s','-c','pass'],{env:{...process.env,PYTHONPATH:folder},encoding:'utf8',timeout:60000});
      assert.equal(control.status,0,control.stderr);
      assert.equal(await readFile(marker,'utf8'),'inherited');
      await rm(marker);
      process.env.PYTHONPATH=folder;
      process.env.PYTHONSTARTUP=path.join(folder,'sitecustomize.py');
      process.env.QUANT_IO_TERMINAL_PROTOCOL='quant-io-terminal-v1';
      const spawned=[];
      // No shim: the real module rejects the synthetic source, which proves module entry and exit-1 mapping.
      await rejectsWith(runOn(baseline.ctx,{runChunk:createLocalPythonRunner({python,developmentOnly:true,
        onSpawn:pid=>{spawned.push(pid);throw new Error(MARKER);}})}),'PF2_EVALUATOR_UNAVAILABLE');
      assert.equal(spawned.length,1);
      assert.equal(existsSync(marker),false);
    }finally{
      for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
      await rm(folder,{recursive:true,force:true});
    }
  });

  await t.test('request builder: pure, validating, never aliasing',async()=>{
    const ctx=shared,rows=[];
    for await(const row of ctx.research.readV2(ctx.resolved.dataset.research,{start:0,end:5}))
      rows.push({...row,open:String(Number(row.open)),high:String(Number(row.high)),low:String(Number(row.low)),
        close:String(Number(row.close)),volume:String(Number(row.volume))});
    const input=clone(rows),request=buildChunkRequest(ctx.resolved,rows,null);
    assert.deepEqual(rows,input);
    assert.equal(request.version,PF2_CHUNK_VERSION);
    assert.deepEqual(request.contract,ctx.resolved.contract);
    assert.equal(Object.isFrozen(request.contract),false);
    assert.equal(request.checkpoint,null);
    assert.deepEqual(request.rows,rows);
    request.rows[0].open='1';request.contract.bridge.rr='9';
    assert.deepEqual(rows,input);
    assert.equal(ctx.resolved.contract.bridge.rr,'1.5');
    const refuse=(rowsValue,code,checkpoint=null)=>assert.throws(()=>buildChunkRequest(ctx.resolved,rowsValue,checkpoint),
      error=>hygiene(error)&&error.code===code);
    refuse([{...rows[0],close:rows[0].close+'0'}],'PF2_ROW_INVALID');
    refuse([{...rows[0],volume:1}],'PF2_ROW_INVALID');
    refuse([],'PF2_ROW_CONTINUITY');
    refuse('rows','PF2_ROW_INVALID');
    refuse([rows[1]],'PF2_ROW_CONTINUITY');
    refuse([{...rows[0],time:ctx.resolved.dataset.development_end_time+MINUTE}],'PF2_HOLDOUT_BOUNDARY_VIOLATION');
    refuse(rows,'PF2_RESUME_INVALID',{version:PF2_CHUNK_VERSION});
    assert.throws(()=>buildChunkRequest({},rows,null),error=>hygiene(error)&&error.code==='PF2_RESOLVED_INVALID');
    assert.equal(encodeChunkRequest(request).toString('utf8'),canonical(request));
  });

  await t.test('adapters get frozen copies, tokens carry whole milliseconds, timers and listeners are released',async st=>{
    const ctx=shared;
    let seen=null,options=null;
    await rejectsWith(runOn(ctx,{research:{readV2:(reference,call)=>{seen=reference;options=call;throw new Error(MARKER);}},
      runChunk:noSpawn()}),'PF2_DATASET_READ_FAILED');
    assert.ok(isDeepFrozen(seen));
    assert.notEqual(seen,ctx.resolved.dataset.research);
    assert.equal(canonical(seen),canonical(ctx.resolved.dataset.research));
    assert.deepEqual(Object.keys(options).sort(),['end','signal','start']);
    // Every timer the driver arms is fired or cleared by the time the call settles, on every path.
    const armed=new Set(),realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;
    const listeners=['unhandledRejection','uncaughtException'].map(name=>process.listenerCount(name));
    globalThis.setTimeout=(fn,ms,...rest)=>{
      const timer=realSet(()=>{armed.delete(timer);fn(...rest);},ms);
      armed.add(timer);
      return timer;
    };
    globalThis.clearTimeout=timer=>{armed.delete(timer);realClear(timer);};
    try{
      await rejectsWith(runOn(ctx,{runChunk:counting(async()=>{throw new Error(MARKER);})}),'PF2_RUNNER_FAILED');
      await rejectsWith(runOn(ctx,{runChunk:noSpawn(),research:hungStore,signal:AbortSignal.abort()}),'PF2_CANCELLED');
      const controller=new AbortController();
      await rejectsWith(runOn(ctx,{signal:controller.signal,runChunk:counting(async()=>{controller.abort();return {exitCode:0,stdout:Buffer.from('x\n')};})}),
        'PF2_CANCELLED');
      if(pythonReady){
        const ticking=(()=>{let now=0;return ()=>(now+=0.3);})();
        const tokens=[];
        await runOn(baseline.ctx,{runChunk:replayRunner(baseline.pairs),clock:ticking,onCheckpoint:async token=>{tokens.push(token);}});
        assert.ok(tokens.length===2&&tokens.every(token=>Number.isSafeInteger(token.elapsed_ms)&&token.elapsed_ms>=1));
        assert.ok(tokens[1].elapsed_ms>=tokens[0].elapsed_ms);
      }
      await flush();
      assert.equal(armed.size,0);
    }finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
    assert.deepEqual(['unhandledRejection','uncaughtException'].map(name=>process.listenerCount(name)),listeners);
    void st;
  });

  await t.test('error surface: fixed codes, every S1 code mapped',async()=>{
    assert.equal(new Set(PF2_REPLAY_ERRORS).size,PF2_REPLAY_ERRORS.length);
    assert.ok([...PF2_REPLAY_ERRORS,...PF2_S1_ERRORS].every(code=>/^PF2_[A-Z_]+$/.test(code)));
    const source=await readFile(path.join(root,'quant_lab','src','robot_quant','pf2_replay.py'),'utf8');
    const emitted=new Set(['PF2_REQUEST_INVALID',...[...source.matchAll(/(?:_bad|PF2Error|_emit_error)\(\s*"(PF2_[A-Z_]+)"/g)]
      .map(match=>match[1])]);
    for(const code of emitted){
      assert.ok(PF2_S1_ERRORS.includes(code)||['PF2_CANCELLED','PF2_DEADLINE_EXCEEDED'].includes(code),'unmapped '+code);
    }
    for(const code of PF2_S1_ERRORS)assert.ok(emitted.has(code),'unused '+code);
  });

  await t.test('error surface: a failing checkpoint sink never leaks its thrown value',async st=>{
    if(needPython(st))return;
    await rejectsWith(runOn(baseline.ctx,{runChunk:replayRunner(baseline.pairs),onCheckpoint:async()=>{throw craftedError('PF2_CANCELLED');}}),
      'PF2_CHECKPOINT_SINK_FAILED');
    await rejectsWith(runOn(baseline.ctx,{runChunk:replayRunner(baseline.pairs),onCheckpoint:()=>{throw new Error(MARKER);}}),
      'PF2_CHECKPOINT_SINK_FAILED');
  });

  await t.test('shim hygiene: its own directory leaves sys.path, no pid file without the sentinel',async st=>{
    if(needPython(st))return;
    const helpers=path.dirname(SHIM);
    const script='import runpy,sys\nsys.path.insert(0,'+JSON.stringify(helpers)+')\n'+
      'runpy.run_path('+JSON.stringify(SHIM)+',run_name="shim_probe")\nprint("STAYED" if '+JSON.stringify(helpers)+' in sys.path else "GONE")\n';
    const child=spawnSync(python,['-B','-s','-c',script],{encoding:'utf8',timeout:60000});
    assert.equal(child.status,0,child.stderr);
    assert.equal(child.stdout.trim(),'GONE');
    assert.equal(existsSync(path.join(TMP,'pf2-shim.pid')),false);
    assert.equal(existsSync(path.join(TMP,'pf2-shim.enable')),false);
  });
/*END-OF-MAIN*/});
