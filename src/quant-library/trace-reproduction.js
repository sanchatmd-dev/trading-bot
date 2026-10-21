import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {D} from '../money.js';
import {canonical,hash,fail} from '../pine-bridge/source.js';
import {validParameters} from '../quant-research/contract.js';
import {pythonEvaluation} from '../postgres/quant-research-worker.js';
import {LEGACY_ENGINE_FILES,TERMINAL,engineHash} from '../postgres/quant-research.js';
import {TRACE_FILES} from './package-gates.js';

/*
 * F09 builder S3b: trace reproduction (docs/design/f09-trace-repro/JUDGEMENT.md, sections 3 and 6.1).
 *
 * For one finished legacy research run this module recomputes the steps of the selected candidate (candidate, sensitivity
 * neighbours, cost stress and the holdout step), derives the three trace tables from the one holdout replay, and returns the
 * canonical steps and holdout digests the package gate (C3) compares with the stored values. It reads no stored step result,
 * never compares with a stored digest, and has no clock, database or file writer. The engine work sits behind injected ports.
 *
 * Reproduction record (reproduceRun result), frozen:
 *   steps_digest, holdout_digest, run_engine_hash, trace_engine_hash, trace: {equity, trades, decisions} as {columns, rows}.
 */

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

/** Module refusal codes. They are never gate codes, never stored in a status event and never shown to the owner (RC-39). */
export const TRACE_REFUSAL_CODES=Object.freeze(['TRACE_REPRODUCTION_DIVERGED','TRACE_REPRODUCTION_UNSUPPORTED']);
const DIVERGED='TRACE_REPRODUCTION_DIVERGED',UNSUPPORTED='TRACE_REPRODUCTION_UNSUPPORTED';

/** Trace file columns. Time is both integer milliseconds and an ISO-8601 UTC text; partition labels every row (open question OQ-1). */
export const TRACE_COLUMNS=Object.freeze({
  equity:Object.freeze(['time_ms','time_utc','partition','event_type','cash','position_quantity','equity_at_fill']),
  trades:Object.freeze(['entry_ref','partition','entry_time_ms','entry_time_utc','entry_price','quantity','entry_fee','exit_time_ms','exit_time_utc','exit_price','exit_fee','exit_reason','net','realized_r']),
  decisions:Object.freeze(['time_ms','time_utc','partition','event_type','entry_ref','outcome','reason','sizing_outcome','quantity','price','fee'])});

/* ---- trace engine hash (J7) ---- */

export const TRACE_REPRODUCTION_CLOSURE_VERSION='trace-reproduction-closure-v1';
/** This module and the driver, then the Python import closure of the driver (package initializer included, as the other closures do). */
const OWN_FILES=['src/quant-library/trace-reproduction.js','quant_lab/src/robot_quant/trace_reproduction.py'];
/* money.js and source.js compute every digest and decide which decimals are accepted, so they bind the reproduction. package-gates.js stays out on purpose: it is the judge
 * (it compares the stored values with this module's output), TRACE_FILES is pinned by the schema CHECK and test B8, and hashing the judge would tie every stored record to a gate edit. */
const NODE_SUPPORT_FILES=['src/money.js','src/pine-bridge/source.js'];
const DRIVER_PYTHON_CLOSURE=['__init__','analytics','backtest','bridge_paper','bridge_replay','contracts','market_data','optimizer','ql2a','ql3a','records','research_engine',
  'risk_evaluator','risk_preview','spt_checkpoint','spt_custom_evaluator','spt_evaluator','spt_repaint','strategy','trace_reproduction','validation']
  .map(name=>'quant_lab/src/robot_quant/'+name+'.py');
/** The two S3 files, the two digest and decimal support modules, the full static import closure of the driver and the legacy run closure (which holds the worker module that runs pythonEvaluation). */
export const TRACE_REPRODUCTION_FILES=Object.freeze([...new Set([...OWN_FILES,...NODE_SUPPORT_FILES,...DRIVER_PYTHON_CLOSURE,...LEGACY_ENGINE_FILES])].sort());
/** Hash of the trace closure. `readFile` is injectable so a test can change one file or drop one. */
export async function traceReproductionEngineHash(readFile=fs.readFile){
  const values=await Promise.all(TRACE_REPRODUCTION_FILES.map(async name=>[name,hash(await readFile(new URL('../../'+name,import.meta.url)))]));
  return hash(canonical({version:TRACE_REPRODUCTION_CLOSURE_VERSION,files:Object.fromEntries(values)}));
}

/* ---- helpers ---- */

const HEX64=/^[0-9a-f]{64}$/;
const MAX_MS=253402300799999;
/*
 * Execution profiles (root ruling R-CV1). S3 dispatches on the stored contract's `version` and on whether the `execution_backend` key is present, never on the
 * contract's shape (a v3 or multi-Pine contract that happens to carry bars must not reach the legacy engine). The keys are literal strings on purpose: they are
 * never computed from the G7 constant, so renaming that placeholder leaves a version unclassified until the slice that owns it classifies it. S3 never rewrites a
 * stored contract's version. Every version outside the ACTIVE table, and any contract that carries an `execution_backend` key, is refused with
 * TRACE_REPRODUCTION_UNSUPPORTED before any port call and before any engine-hash read.
 */
/** The one ACTIVE profile: a legacy research contract carries its bars inline and is checked against the legacy run closure engineHash(false). */
export const TRACE_EXECUTION_PROFILES=Object.freeze({
  'ql3a-research-job-v1':Object.freeze({state:'ACTIVE',closure:'engineHash(false)',path:'pythonEvaluation + trace driver'})});
/** Known forms that S3 does not reproduce yet, each with the slice that owns them. Refused exactly like an unknown form. */
export const TRACE_PROFILE_DEFERRED=Object.freeze({
  'ql3a-research-job-v2':Object.freeze({execution_backend:'quant-foundation-v1',owner:'S3d (J4)'}),
  'ql3a-research-job-multi-v1':Object.freeze({owner:'F11 trace producer'}),
  'ql3a-research-job-v3':Object.freeze({owner:'the slice that defines the next research contract (OD-3, OD-12, OD-18)'})});
/** The profile of a stored contract, or one UNSUPPORTED refusal. Reads only `version` and the presence of `execution_backend`. */
function executionProfile(contract){
  const version=contract.version;
  if(typeof version!=='string'||Object.hasOwn(TRACE_PROFILE_DEFERRED,version)||!Object.hasOwn(TRACE_EXECUTION_PROFILES,version)||Object.hasOwn(contract,'execution_backend'))throw fail(UNSUPPORTED);
  return TRACE_EXECUTION_PROFILES[version];
}
const PENDING='RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';
const PARTITIONS=['train','validation','test'];
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const deepFreeze=value=>{if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;};
const clone=value=>JSON.parse(JSON.stringify(value));
const sameKeys=(object,keys)=>{const names=Object.keys(object).sort();return names.length===keys.length&&[...keys].sort().every((key,index)=>key===names[index]);};
const timeMs=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX_MS;
const isoUtc=ms=>new Date(ms).toISOString();
/** A decimal string as the engine prints it. Exponent forms such as 0E-18 are decimals, so they are parsed, never matched as raw text. */
function decimalString(value){
  if(typeof value!=='string')return false;
  try{D(value);return true;}catch{return false;}
}
const invalidReply=()=>fail('INVALID_EVALUATION_RESPONSE');
const diverged=()=>fail(DIVERGED);

/* ---- evaluation result shape (copy of QuantResearchWorker.step lines 82-88; test B7 pins the drift) ---- */

function checkResult(result,parameters,kind){
  if(!isObject(result))throw invalidReply();
  try{
    if(canonical(result.parameters)!==canonical(parameters)||result.kind!==kind||!result.train||!result.validation||(kind!=='HOLDOUT'&&Object.hasOwn(result,'test')))throw invalidReply();
    for(const metrics of [result.train,result.validation,...(kind==='HOLDOUT'?[result.test]:[])]){
      if(!metrics||!Number.isSafeInteger(metrics.closed_trades)||metrics.closed_trades<0)throw invalidReply();
      for(const key of ['net_return_percent','max_drawdown_percent']){
        if(!['string','number'].includes(typeof metrics[key]))throw invalidReply();
        const value=D(metrics[key]);
        if(!value.isFinite()||(key==='max_drawdown_percent'&&value.lt(0)))throw invalidReply();
      }
    }
  }catch(error){
    throw error?.code==='INVALID_EVALUATION_RESPONSE'?error:invalidReply();
  }
  return result;
}

/* ---- run view checks (J1, J9) ---- */

function unresolved(){return fail('BI_PROVENANCE_UNRESOLVED');}
function digestOf(value){try{return hash(canonical(value));}catch{return null;}}

/** Everything S3 reads from storage: the frozen contract, its hash, the status, the completion flags and the selected parameters. */
function readRun(run){
  if(!isObject(run)||!isObject(run.contract))throw unresolved();
  if(!TERMINAL.has(run.status))throw fail('STATUS_NOT_COMPLETED');
  const result=run.result;
  if(run.status!=='SUCCEEDED'||!isObject(result)||result.completion_reason!==PENDING)throw fail('BI_RUN_NOT_QUALIFIABLE');
  if(result.holdout_evaluated!==true)throw fail('HOLDOUT_NOT_EVALUATED');
  const contract=run.contract;
  if(typeof run.contract_hash!=='string'||digestOf(contract)!==run.contract_hash)throw unresolved();
  // The version dispatch comes before every plan check: a deferred or unknown form is UNSUPPORTED whatever its plan looks like (pinned by test B6c).
  executionProfile(contract);
  const selected=result.selected;
  if(!isObject(selected)||!isObject(selected.parameters))throw unresolved();
  const parameters=clone(selected.parameters),plan=contract.plan?.candidates,domains=contract.input_lock?.domains,fixedInputs=contract.input_lock?.selection?.fixed_inputs;
  if(!Array.isArray(plan)||!isObject(domains)||!Array.isArray(fixedInputs))throw unresolved();
  if(plan.filter(candidate=>canonical(candidate)===canonical(parameters)).length!==1)throw unresolved();
  for(const [name,grid] of Object.entries(domains))if(!Array.isArray(grid)||!grid.includes(parameters[name]))throw unresolved();
  if(fixedInputs.some(item=>!isObject(item)||typeof item.pine_variable!=='string'))throw unresolved();
  return {contract,parameters,plan,domains,fixed:Object.fromEntries(fixedInputs.map(item=>[item.pine_variable,item.effective_value]))};
}

/** Bars exist, match the split and are gapless one-minute rows. Checked before any process starts. */
function checkBars(contract){
  const split=contract.split,bars=contract.dataset?.bars;
  if(!isObject(split)||!Array.isArray(bars)||!['warmup','train_end','validation_end','test_end'].every(key=>Number.isSafeInteger(split[key])))throw fail('BI_DATASET_UNAVAILABLE');
  if(!(0<split.warmup&&split.warmup<split.train_end&&split.train_end<split.validation_end&&split.validation_end<split.test_end&&split.test_end<=10000)||bars.length!==split.test_end)throw fail('BI_DATASET_UNAVAILABLE');
  for(let i=0;i<bars.length;i++)if(!isObject(bars[i])||!timeMs(bars[i].time)||(i>0&&bars[i].time-bars[i-1].time!==60000))throw fail('BI_DATASET_UNAVAILABLE');
  return {edges:[bars[split.warmup].time,bars[split.train_end].time,bars[split.validation_end].time],last:bars[bars.length-1].time};
}

/** The steps in worker order (quant-research-worker.js run): candidate, sensitivity neighbours, cost stress. The holdout step follows. */
function planSteps({parameters,plan,domains,fixed}){
  const steps=[{kind:'CANDIDATE',parameters}];
  for(const name of Object.keys(domains).sort()){
    const grid=domains[name],index=grid.indexOf(parameters[name]);
    for(const next of [index-1,index+1])if(next>=0&&next<grid.length){
      const neighbour={...parameters,[name]:grid[next]};
      if(!validParameters(neighbour,fixed))continue;
      // A neighbour equal to a plan candidate is stored as that candidate's own result, so its kind is CANDIDATE (not SENSITIVITY).
      const planned=plan.some(candidate=>canonical(candidate)===canonical(neighbour));
      steps.push({kind:planned?'CANDIDATE':'SENSITIVITY',parameters:neighbour,dimension:name});
    }
  }
  steps.push({kind:'STRESS',parameters});
  return steps;
}

/* ---- trace tables (J2) ---- */

function partitionOf(time,edges,last){
  if(time<edges[0]||time>last)throw diverged();
  return time<edges[1]?'train':time<edges[2]?'validation':'test';
}
function ordered(times){return times.every((time,index)=>index===0||times[index-1]<=time);}
/** Validate the driver reply, re-derive every partition from the contract split and cross-check with the recomputed holdout result. */
function buildTrace(reply,result,{edges,last}){
  if(!isObject(reply)||!sameKeys(reply,['result','trades','decisions','equity'])||!Array.isArray(reply.trades)||!Array.isArray(reply.decisions)||!Array.isArray(reply.equity))throw invalidReply();
  const TRADE_KEYS=['entry_ref','partition','entry_time','entry_price','quantity','entry_fee','exit_time','exit_price','exit_fee','exit_reason','net','realized_r'];
  const EQUITY_KEYS=['time','partition','event_type','cash','position_quantity','equity_at_fill'];
  const label=(row,time)=>{const partition=partitionOf(time,edges,last);if(row.partition!==partition)throw diverged();return partition;};
  const seen=new Set(),counts={train:0,validation:0,test:0};
  const trades=reply.trades.map(row=>{
    if(!isObject(row)||!sameKeys(row,TRADE_KEYS)||typeof row.entry_ref!=='string'||!timeMs(row.entry_time)||!timeMs(row.exit_time)||typeof row.exit_reason!=='string'||
      !['entry_price','quantity','entry_fee','exit_price','exit_fee','net','realized_r'].every(key=>decimalString(row[key])))throw invalidReply();
    partitionOf(row.entry_time,edges,last);  // the entry bar lies inside the contract bars like every other time
    if(row.entry_time>row.exit_time)throw diverged();
    const partition=label(row,row.exit_time);  // a trade belongs to the partition of its EXIT bar
    if(seen.has(row.entry_ref))throw diverged();
    seen.add(row.entry_ref);counts[partition]++;
    return [row.entry_ref,partition,row.entry_time,isoUtc(row.entry_time),row.entry_price,row.quantity,row.entry_fee,row.exit_time,isoUtc(row.exit_time),row.exit_price,row.exit_fee,row.exit_reason,row.net,row.realized_r];
  });
  const equity=reply.equity.map(row=>{
    if(!isObject(row)||!sameKeys(row,EQUITY_KEYS)||!timeMs(row.time)||typeof row.event_type!=='string'||!['cash','position_quantity','equity_at_fill'].every(key=>decimalString(row[key])))throw invalidReply();
    const partition=label(row,row.time);
    return [row.time,isoUtc(row.time),partition,row.event_type,row.cash,row.position_quantity,row.equity_at_fill];
  });
  const text=value=>value===undefined||value===null?null:value;
  const decisions=reply.decisions.map(row=>{
    if(!isObject(row)||!timeMs(row.time)||typeof row.event_type!=='string'||typeof row.entry_ref!=='string'||typeof row.outcome!=='string'||!decimalString(row.quantity)||!decimalString(row.fee)||
      (row.price!==undefined&&row.price!==null&&!decimalString(row.price))||![row.reason,row.sizing_outcome].every(value=>value===undefined||value===null||typeof value==='string'))throw invalidReply();
    const partition=label(row,row.time);
    return [row.time,isoUtc(row.time),partition,row.event_type,row.entry_ref,row.outcome,text(row.reason),text(row.sizing_outcome),row.quantity,text(row.price),row.fee];
  });
  // Exact cross-checks against the recomputed HOLDOUT result. No tolerance: any difference means these rows are not that result's path.
  for(const name of PARTITIONS)if(counts[name]!==result[name].closed_trades)throw diverged();
  if(decisions.length!==result.decision_count||equity.length!==result.fills)throw diverged();
  if(!ordered(reply.equity.map(row=>row.time))||!ordered(reply.decisions.map(row=>row.time))||!ordered(reply.trades.map(row=>row.exit_time)))throw diverged();
  return {equity:{columns:[...TRACE_COLUMNS.equity],rows:equity},trades:{columns:[...TRACE_COLUMNS.trades],rows:trades},decisions:{columns:[...TRACE_COLUMNS.decisions],rows:decisions}};
}

/* ---- reproduction ---- */

/** The only codes a port may pass through (J9 process codes and the two module refusals). An allowed error is rebuilt as a fresh error with that code only (no original message, stack or property); any other error, such as ENOENT or a TypeError, becomes a fresh EVALUATION_FAILED. */
const PROCESS_CODES=Object.freeze(['QUANT_PYTHON_UNAVAILABLE','EVALUATION_TIMED_OUT','RESEARCH_INTERRUPTED','EVALUATION_OUTPUT_TOO_LARGE','EVALUATION_FAILED','INVALID_EVALUATION_RESPONSE','RESEARCH_REQUEST_TOO_LARGE']);
const PASS_CODES=new Set([...PROCESS_CODES,...TRACE_REFUSAL_CODES]);
function coded(error){
  return typeof error?.code==='string'&&PASS_CODES.has(error.code)?fail(error.code):fail('EVALUATION_FAILED');
}
function checkPorts(ports){
  if(!isObject(ports)||!['evaluate','traceEvaluate','engineHash'].every(name=>typeof ports[name]==='function'))throw new TypeError('trace reproduction ports require evaluate, traceEvaluate and engineHash');
  if(ports.traceEngineHash!==undefined&&typeof ports.traceEngineHash!=='function')throw new TypeError('ports.traceEngineHash must be a function');
}

/**
 * Recompute the selected candidate's steps and the trace tables for one run view {owner_id, bot_id, run_id, status, contract,
 * contract_hash, result}. ports: evaluate(contract, parameters, kind, signal) like pythonEvaluation; traceEvaluate(contract,
 * parameters, signal) returning the driver reply; engineHash() returning the live legacy closure hash; optional traceEngineHash().
 * Throws one coded refusal; a refusal produces no output.
 */
export async function reproduceRun({run,ports,signal}={}){
  checkPorts(ports);
  const read=readRun(run),{contract,parameters}=read;
  const bars=checkBars(contract),steps=planSteps(read);
  const live=async()=>{
    if(signal?.aborted)throw fail('RESEARCH_INTERRUPTED');
    let value;
    try{value=await ports.engineHash();}catch(error){throw coded(error);}
    if(typeof value!=='string'||!HEX64.test(contract.engine_hash??'')||value!==contract.engine_hash)throw fail('BI_ENGINE_HASH_MISMATCH');
    return value;
  };
  const call=async work=>{
    if(signal?.aborted)throw fail('RESEARCH_INTERRUPTED');
    try{return await work();}catch(error){throw coded(error);}
  };
  // The trace closure (this module, the driver, the digest support files) is read before and after the run. A change in flight means the
  // reproduction does not describe one engine, which is the same fact as a changed run closure, so it uses the same code (J9).
  const traceHash=async()=>{
    if(signal?.aborted)throw fail('RESEARCH_INTERRUPTED');
    let value;
    try{value=await (typeof ports.traceEngineHash==='function'?ports.traceEngineHash():traceReproductionEngineHash());}catch(error){throw coded(error);}
    if(typeof value!=='string'||!HEX64.test(value))throw fail('EVALUATION_FAILED');
    return value;
  };
  await live();
  const traceBefore=await traceHash();
  const results=[];
  for(const step of steps)results.push(checkResult(await call(()=>ports.evaluate(contract,clone(step.parameters),step.kind,signal)),step.parameters,step.kind));
  const reply=await call(()=>ports.traceEvaluate(contract,clone(parameters),signal));
  const runEngineHash=await live();
  if(!isObject(reply))throw invalidReply();
  const holdout=checkResult(reply.result,parameters,'HOLDOUT');
  const trace=buildTrace(reply,holdout,bars);
  const stepsDigest=hash(canonical({candidate:{parameters,result:results[0]},
    sensitivity:steps.flatMap((step,index)=>step.dimension===undefined?[]:[{dimension:step.dimension,parameters:step.parameters,result:results[index]}]),cost_stress:results[results.length-1]}));
  const holdoutDigest=hash(canonical({test:holdout.test}));
  const traceEngineHash=await traceHash();
  if(traceEngineHash!==traceBefore)throw fail('BI_ENGINE_HASH_MISMATCH');
  return deepFreeze({steps_digest:stepsDigest,holdout_digest:holdoutDigest,run_engine_hash:runEngineHash,trace_engine_hash:traceEngineHash,trace});
}

/* ---- records (J6) ---- */

const bytesOf=content=>typeof content==='string'?Buffer.from(content,'utf8'):content instanceof Uint8Array?content:null;
/** The three bi_trace_reproductions rows (without export_id, which the build transaction owns) in TRACE_FILES order. */
export function traceReproductionRecords(reproduction,files,recordedAtMs){
  if(!isObject(reproduction)||!['steps_digest','holdout_digest','run_engine_hash','trace_engine_hash'].every(key=>typeof reproduction[key]==='string'&&HEX64.test(reproduction[key])))throw new TypeError('invalid reproduction');
  if(!Number.isSafeInteger(recordedAtMs)||recordedAtMs<0||recordedAtMs>MAX_MS)throw new TypeError('invalid recorded_at_ms');
  if(!isObject(files))throw new TypeError('files required');
  return Object.freeze(TRACE_FILES.map(file=>{
    const bytes=bytesOf(files[file]);
    if(bytes===null)throw new TypeError('missing trace file '+file);
    return Object.freeze({path:file,sha256:hash(bytes),steps_digest:reproduction.steps_digest,holdout_digest:reproduction.holdout_digest,
      trace_engine_hash:reproduction.trace_engine_hash,run_engine_hash:reproduction.run_engine_hash,recorded_at_ms:recordedAtMs});
  }));
}
/**
 * Read side of the stored rows for gate C3. A row is dropped (so C3 sees an absent record) when a field is malformed, when its
 * run_engine_hash is not the contract's engine hash, or when its path appears more than once. Result order is TRACE_FILES order.
 */
export function gateTraceReproduction(rows,contract){
  const engine=isObject(contract)&&typeof contract.engine_hash==='string'&&HEX64.test(contract.engine_hash)?contract.engine_hash:null;
  if(engine===null||!Array.isArray(rows))return Object.freeze([]);
  const counts=new Map();
  for(const row of rows)if(isObject(row))counts.set(row.path,(counts.get(row.path)??0)+1);
  const good=row=>isObject(row)&&TRACE_FILES.includes(row.path)&&counts.get(row.path)===1&&['sha256','steps_digest','holdout_digest','trace_engine_hash','run_engine_hash'].every(key=>typeof row[key]==='string'&&HEX64.test(row[key]))&&
    row.run_engine_hash===engine&&Number.isSafeInteger(row.recorded_at_ms)&&row.recorded_at_ms>=0&&row.recorded_at_ms<=MAX_MS;
  return Object.freeze(TRACE_FILES.flatMap(file=>rows.filter(row=>isObject(row)&&row.path===file&&good(row)).map(row=>Object.freeze({path:row.path,sha256:row.sha256,steps_digest:row.steps_digest,holdout_digest:row.holdout_digest}))));
}

/* ---- driver spawner (J11) ---- */

export const DRIVER_REQUEST_LIMIT=8*1024*1024;
export const DRIVER_REPLY_LIMIT=16*1024*1024;
export const DRIVER_KILL_GRACE_MS=2000;
export const DRIVER_ARGS=Object.freeze(['-P','-m','robot_quant.trace_reproduction']);
const INHERITED_ENV=['PATH','LANG','LC_ALL'];
const venvPython=()=>path.join(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
/** The interpreter as the F11 combined-job runner resolves it: explicit option, else QUANT_RESEARCH_PYTHON, else quant_lab/.venv, else null. Never a bare `python` from PATH. */
export function resolveInterpreter({python,env=process.env,venv=venvPython(),exists=existsSync}={}){
  return python??env.QUANT_RESEARCH_PYTHON??(exists(venv)?venv:null);
}
/** A short fixed environment: no DATABASE_URL, no secret and no other PYTHON* variable reaches the driver. */
function driverEnvironment(source=process.env){
  const out={};
  for(const name of INHERITED_ENV)if(typeof source[name]==='string')out[name]=source[name];
  return {...out,PYTHONPATH:path.join(root,'quant_lab/src'),PYTHONHASHSEED:'0'};
}
/**
 * One HOLDOUT replay through the driver `python -m robot_quant.trace_reproduction` (started with -P, working directory the repository root per
 * JUDGEMENT.md 6.1, minimal environment). stdin gets {contract, parameters}; stdout is one JSON object. stderr is discarded. Exit 1 with
 * {"error":"TRACE_REPRODUCTION_DIVERGED"} maps to that code, any other failure to EVALUATION_FAILED. With no interpreter the call rejects
 * QUANT_PYTHON_UNAVAILABLE. Options: python, timeoutMs, and the TEST-ONLY seams args (replaces the whole argument list, so a stub script can run
 * under this Node binary) and killGraceMs (SIGKILL after SIGTERM when the child ignores it).
 */
export function driverEvaluation(contract,parameters,signal,{python,args=DRIVER_ARGS,timeoutMs=30000,killGraceMs=DRIVER_KILL_GRACE_MS}={}){
  return new Promise((resolve,reject)=>{
    const input=JSON.stringify({contract,parameters});
    if(Buffer.byteLength(input)>DRIVER_REQUEST_LIMIT){reject(fail('RESEARCH_REQUEST_TOO_LARGE'));return;}
    if(signal?.aborted){reject(fail('RESEARCH_INTERRUPTED'));return;}
    const interpreter=resolveInterpreter({python});
    if(!interpreter){reject(fail('QUANT_PYTHON_UNAVAILABLE'));return;}
    let child;
    try{child=spawn(interpreter,args,{cwd:root,env:driverEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch{reject(fail('QUANT_PYTHON_UNAVAILABLE'));return;}  // a synchronous throw (for example a NUL byte in the interpreter string) is a coded failure, not a raw error
    const chunks=[];
    let size=0,settled=false,interrupted=null,killer=null;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    // SIGTERM first; a child that ignores it is killed with SIGKILL after the grace period. The promise settles only when the child has closed.
    const stop=()=>{child.kill();killer??=setTimeout(()=>{child.kill('SIGKILL');},killGraceMs);};
    const abort=()=>{interrupted??='RESEARCH_INTERRUPTED';stop();};
    const timer=setTimeout(()=>{interrupted??='EVALUATION_TIMED_OUT';stop();},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',data=>{if(interrupted)return;chunks.push(data);size+=data.length;if(size>DRIVER_REPLY_LIMIT){interrupted='EVALUATION_OUTPUT_TOO_LARGE';stop();}});
    child.stderr.on('data',()=>{});  // Never echo a contract or source through Python errors.
    child.stdin.on('error',()=>{});
    child.on('error',()=>finish(fail('QUANT_PYTHON_UNAVAILABLE')));
    child.on('close',code=>{
      if(interrupted){finish(fail(interrupted));return;}
      let value;
      try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{value=undefined;}
      if(code!==0){finish(fail(isObject(value)&&value.error===DIVERGED?DIVERGED:'EVALUATION_FAILED'));return;}
      if(!isObject(value)||value.error){finish(invalidReply());return;}
      finish(null,value);
    });
    child.stdin.end(input);
  });
}

/**
 * The ports a real build uses: the unchanged legacy evaluation call, the driver spawner and the live legacy closure hash. The interpreter is
 * resolved once and the same one serves the legacy evaluation and the driver. Only python and timeoutMs are forwarded (no args, cwd or env seam).
 */
export function defaultPorts({python,timeoutMs}={}){
  const interpreter=resolveInterpreter({python});
  const options={...(timeoutMs!==undefined?{timeoutMs}:{})};
  const evaluate=(contract,parameters,kind,signal)=>interpreter?pythonEvaluation(contract,parameters,kind,signal,{python:interpreter,...options}):Promise.reject(fail('QUANT_PYTHON_UNAVAILABLE'));
  return {evaluate,traceEvaluate:(contract,parameters,signal)=>interpreter?driverEvaluation(contract,parameters,signal,{python:interpreter,...options}):Promise.reject(fail('QUANT_PYTHON_UNAVAILABLE')),engineHash:()=>engineHash(false)};
}
