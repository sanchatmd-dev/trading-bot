import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {appendExposures} from '../../src/postgres/exposure-register.js';
import {storeBotState} from '../../src/postgres/mp-member-set-store.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {engineHash} from '../../src/postgres/quant-research.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {assemble} from '../../src/pine-bridge/template.js';
import {PACKAGE_FILES,TRACE_FILES,CANDIDATE_BLOCKERS,RETRYABLE_CODES,libraryG8,packageHash,bindingHash,PACKAGE_GATE_VERSION} from '../../src/quant-library/package-gates.js';
import {renderPackage} from '../../src/quant-library/package-render.js';
import {defaultPorts,driverEvaluation,reproduceRun,resolveInterpreter,traceReproductionEngineHash} from '../../src/quant-library/trace-reproduction.js';
import {checkPackage} from '../../src/selection/eligibility.js';
import {BiFixturePackageService,PACKAGE_STORE_CODES,PACKAGE_STORE_MAX_RETRIES,PACKAGE_STORE_MAX_WAITERS,PACKAGE_LIBRARY_VERSIONS,WRITTEN_TABLES} from '../../src/postgres/bi-package-store.js';
import {contractOf,hex,MINUTE,T0} from '../helpers/quant-library-fixture.mjs';

/*
 * F09-01 stage I (L7): the one-Pine fixture build and attempt service (src/postgres/bi-package-store.js; root rulings SB176) on a throwaway PostgreSQL cluster. Every row here is a LABELLED
 * FIXTURE (fixture true, synthetic bars, never a research result, READY false). One real stored v3 fixture run (the real QuantResearchWorker, the real Python engine and trace driver) goes through S3
 * reproduction, the renderer, B0 and the SERIALIZABLE transaction ("E1" below). The other cases build from CLONES of that stored run under other owners (same stored result and checkpoints, a new
 * contract for the new owner and deployment) and replay the engine replies the real run produced: they test the mechanics (refusals, races, retries, attempts), not the engine.
 * Rows are insert-only, so each case that commits a package uses its own run. Run the file whole, in order.
 * Needs an interpreter (QUANT_RESEARCH_PYTHON, else quant_lab/.venv; never a bare python from PATH); the real-run cases are skipped with a reason elsewhere and must run in CI.
 */

const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const PYTHON=resolveInterpreter();
const NO_PYTHON=PYTHON?false:'no interpreter: QUANT_RESEARCH_PYTHON is unset and quant_lab/.venv is absent (a bare python from PATH is never used)';
test('the real-run cases run in CI: an interpreter resolves there',{skip:process.env.CI!=='true'&&'checked only in CI'},()=>{assert.ok(PYTHON,NO_PYTHON||'');});

const clone=value=>JSON.parse(JSON.stringify(value));
const sha=value=>createHash('sha256').update(value).digest('hex');
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const grantScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const once=fn=>{let promise;return()=>promise??=fn();};
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const BI_TABLES=['bi_blobs','bi_exports','bi_package_files','bi_status_events','bi_attempts','ql4c_validation','bi_compile_records','bi_evidence_records','bi_clearances','bi_trace_reproductions'];
const SIDE_TABLES=['quant_exposure_register','quant_jobs','quant_job_steps','pine_sources','pine_source_revisions','pine_memberships','pine_deployments','pine_bridge_jobs','pine_bridge_evidence','pine_market_bars'];

let admin,db,fx,fx2,ro,none,store,templateName,databaseName,rtName,roName,noName,CLOSURE,TRACE,BASE_TIME;
const pools=[],roles=[];
const track=pool=>{pools.push(pool);return pool;};

/* ---- the fixture world: the S3c fixture (quant_lab/tests/test_trace_reproduction.py), a v3 contract, a deployment the exit version derives from ---- */

const BOOTSTRAP=entry=>['import sys','from robot_quant import research_engine, trace_reproduction',
  'from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, CustomSignalInputs',
  'BASE = CustomSignalInputs(ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2, zone_atr_mult=2.5, setup_expiry=8, cooldown=2, confirm_lookback=3)',
  'PLAN = CustomOptimizationPlan(BASE, {"emaFastInput": (4, 6, 1)})','CustomOptimizationPlan.from_snapshot = lambda *_: PLAN',entry,''].join('\n');
const STATEMENT='emaFastInput = input.int(5, "EMA fast", minval=4, maxval=6, step=1)';
const SOURCE=['//@version=6','indicator("BI build fixture indicator", overlay=true)',STATEMENT,'useSlowFilter = input.bool(true, "Slow filter")','notifyEnabled = input.bool(false, "Notify")',
  'emaFast = ta.ema(close, emaFastInput)','emaSlow = ta.ema(close, 17)','buySignal = ta.crossover(emaFast, emaSlow)','sellSignal = ta.crossunder(emaFast, emaSlow)','plot(emaFast)',''].join('\n');
const SOURCE_HASH=hash(SOURCE),SPAN_START=SOURCE.indexOf(STATEMENT);
const BARS=1500,SPLIT={warmup:10,train_end:600,validation_end:1050,test_end:BARS};
const GRID={emaFastInput:[4,5,6],atr_multiplier:[0.95,1,1.05],rr:[1.9,2,2.1]};
const PLAN=[{emaFastInput:5,atr_multiplier:1,rr:1.9},{emaFastInput:5,atr_multiplier:1,rr:2},{emaFastInput:5,atr_multiplier:0.95,rr:2},{emaFastInput:6,atr_multiplier:1,rr:1.9}];
const POLICY={max_daily_loss_percent:'3',equities:{'binance-global':'1000'},killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:10000,maxDailyLossR:10000,
  pauseAfterLossStreak:10000,blockHighVolatility:false,maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',maxOpenPositions:5,
  onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,maxDailyNotional:10000000};
const POLICY_HASH=hash(canonical(POLICY));
const PROVENANCE={profile:'closed-ohlcv-atr14-v1',source:'bi-build-fixture',fixture:true};
function engineBars(){
  const bars=[];let previous=100;
  for(let i=0;i<BARS;i++){
    const close=100+12*Math.sin(i/23)+2*Math.sin(i/3);
    bars.push({time:T0+i*MINUTE,open:String(previous),high:String(Math.max(previous,close)+1.2),low:String(Math.min(previous,close)-1.2),close:String(close),volume:'1',atr14:'2.75'});
    previous=close;
  }
  return bars;
}
const BAR_LIST=engineBars();
const DATASET_SHA=hash(canonical(BAR_LIST.map(bar=>({bar,content_hash:hash(canonical(bar)),provenance:PROVENANCE}))));
let runClock=0;
const nextCreated=()=>BASE_TIME+(runClock++)*1000;

/** A user (= Bot), the source and its revision, the connected membership, a deployment whose generated artifact pins its exit version, its generate job and its Bridge evidence. */
async function newWorld(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID();
  const artifact=assemble(SOURCE,{bridge:{atr_multiplier:1,rr:2},signals:{buy:'buySignal',exit:'sellSignal'},bindings:[],fixed_inputs:[]},{deployment_id:deployment,pine_import_id:importId,source_version:1,...MARKET}).integrated_pine;
  const snapshot={policy:POLICY,policy_hash:POLICY_HASH,source_hash:SOURCE_HASH,artifact_hash:hash(artifact),market:{deployment_id:deployment,pine_import_id:importId,source_version:1,...MARKET}};
  const snapshotHash=hash(canonical(snapshot));
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,SOURCE_HASH,'BI build fixture',SOURCE,'{}',T0]);
  await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[importId,SOURCE_HASH,SOURCE,'{}',T0]);
  await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$2,1,true)',[importId,user.id]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'DRAFT',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),snapshotHash,T0]);
  const evidence={snapshot_hash:snapshotHash,native_alerts_isolated:true,unrelated_payloads:0,references:{fixture:label}};
  await db.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[deployment,snapshotHash,JSON.stringify(evidence),hash(canonical(evidence)),T0]);
  await db.query(`INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,result)
    VALUES($1,$2,$2,'generate',$3,$4,'{}',$5,'SUCCEEDED',$6,$6,$6,$7)`,[randomUUID(),user.id,randomUUID(),hex('request-'+deployment),importId,T0,JSON.stringify({integrated_pine:artifact,deployment_id:deployment,artifact_status:'DRAFT'})]);
  return {id:user.id,importId,deployment,snapshotHash};
}
/** The v3 legacy contract of the S3c fixture (bars inline, no execution_backend key, the two candidate blockers, policy fields) bound to a world. */
async function worldContract(who){
  const contract=clone(contractOf({owner:who.id,bot:who.id,deployment:who.deployment,importId:who.importId,tag:'bi-build',total:BARS,warmup:SPLIT.warmup,barCount:0,candidates:PLAN.length,domains:GRID}));
  Object.assign(contract,{version:'ql3a-research-job-v3',source:SOURCE,source_hash:SOURCE_HASH,policy_version:'fixture-v1',policy_hash:POLICY_HASH,acceptance_blockers:[...CANDIDATE_BLOCKERS],
    split:{...SPLIT},baseline_snapshot_hash:who.snapshotHash});
  contract.snapshot.policy=clone(POLICY);contract.snapshot.policy_hash=POLICY_HASH;
  contract.snapshot.membership=[{pine_import_id:who.importId,source_version:1,source_hash:SOURCE_HASH}];
  contract.dataset.bars=clone(BAR_LIST);contract.dataset.sha256=DATASET_SHA;
  contract.model={...contract.model,quantity_step:0.00001};
  Object.assign(contract.input_lock.selection.bindings[0],{effective_value:5,search_domain:{min:4,max:6,step:1},source_span:{start:SPAN_START,end:SPAN_START+STATEMENT.length}});
  contract.input_lock.selection.fixed_inputs.push({input_id:'input_11',pine_variable:'emaSlowInput',effective_value:17,type:'int',eligible:false});
  contract.input_lock.baseline=clone(PLAN[0]);
  contract.plan.candidates=clone(PLAN);contract.plan.planned_candidates=PLAN.length;
  contract.max_evaluations=40;
  contract.engine_hash=await engineHash(false);
  return contract;
}
function runPython(code,body,{timeoutMs=120000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(PYTHON,['-P','-c',code],{cwd:repoRoot,env:{...process.env,PYTHONPATH:path.join(repoRoot,'quant_lab/src'),PYTHONHASHSEED:'0'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    const out=[],timer=setTimeout(()=>child.kill(),timeoutMs);
    child.stdout.on('data',data=>out.push(data));child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0){reject(Object.assign(new Error('python exited '+code),{code:'EVALUATION_FAILED'}));return;}
      try{resolve(JSON.parse(Buffer.concat(out).toString('utf8')));}catch{reject(Object.assign(new Error('bad engine reply'),{code:'INVALID_EVALUATION_RESPONSE'}));}
    });
    child.stdin.end(JSON.stringify(body));
  });
}
const ENGINE_CODE=BOOTSTRAP('research_engine.main()'),DRIVER_CODE=BOOTSTRAP('trace_reproduction.main()');
const evaluateReal=(contract,parameters,kind)=>runPython(ENGINE_CODE,{contract:kind==='HOLDOUT'?contract:{...contract,dataset:{...contract.dataset,bars:contract.dataset.bars.slice(0,contract.split.validation_end)}},parameters,kind});
/** The real S3 ports: the unchanged legacy evaluation (through the engine script), the real trace driver and the live hash of the run closure. */
const REAL_PORTS={evaluate:evaluateReal,traceEvaluate:(contract,parameters,signal)=>driverEvaluation(contract,parameters,signal,{python:PYTHON,args:['-P','-c',DRIVER_CODE],timeoutMs:120000}),
  engineHash:()=>engineHash(false),closure:'engineHash(false)'};
/** Engine replies by (kind, parameters, dataset, split, engine, model), shared by every case: the first reproduction of a case family reaches the real engine, later ones replay its replies. */
const REPLAY=new Map();
function ports(){
  const stats={evaluate:0,trace:0,realEvaluate:0,realTrace:0};
  const keyOf=(kind,contract,parameters)=>canonical([kind,parameters,contract.dataset.sha256,contract.split,contract.engine_hash,contract.model]);
  const fetchReply=async(key,load,counter)=>{
    if(!REPLAY.has(key)){stats[counter]++;REPLAY.set(key,load().then(value=>JSON.stringify(value),error=>{REPLAY.delete(key);throw error;}));}
    return JSON.parse(await REPLAY.get(key));
  };
  return {stats,closure:REAL_PORTS.closure,engineHash:REAL_PORTS.engineHash,
    evaluate:(contract,parameters,kind,signal)=>{stats.evaluate++;return fetchReply(keyOf(kind,contract,parameters),()=>REAL_PORTS.evaluate(contract,parameters,kind,signal),'realEvaluate');},
    traceEvaluate:(contract,parameters,signal)=>{stats.trace++;return fetchReply(keyOf('TRACE',contract,parameters),()=>REAL_PORTS.traceEvaluate(contract,parameters,signal),'realTrace');}};
}

/** The real run: stored by the real QuantResearchWorker (real engine, real checkpoints, real JSONB result). */
const BASE=once(async()=>{
  const who=await newWorld('bi-base');
  const contract=await worldContract(who),contractHash=hash(canonical(contract)),runId='run-bi-'+randomUUID(),created=nextCreated();
  const leaseToken='lease-'+randomUUID();
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,phase,created_at,updated_at,deadline,attempt,lease_token,lease_until)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'RUNNING','CANDIDATES',$8,$8,$9,1,$10,$9)`,[runId,who.id,who.deployment,'idem-'+runId,hex('submission-bi'),contractHash,JSON.stringify(contract),created,created+3600000,leaseToken]);
  const worker=Object.create(QuantResearchWorker.prototype);
  worker.service={foundation:false,store:{audit:async()=>{}}};
  worker.db=db;worker.clock=()=>created+1000;worker.controller={signal:new AbortController().signal};
  worker.current=async()=>{};
  worker.evaluate=evaluateReal;
  await worker.run({...(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0]});
  const row=(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0];
  const steps=(await db.query('SELECT step_id,kind,parameters,result,completed_at FROM quant_job_steps WHERE run_id=$1 ORDER BY step_id',[runId])).rows;
  assert.equal(row.status,'SUCCEEDED',JSON.stringify(row.result?.selected?.screen_reasons));
  assert.equal(row.result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  return {who,run_id:runId,owner_id:who.id,row,steps,contract:row.contract,result:row.result,created};
});
/**
 * A clone of the real stored run under a new owner (same stored result and checkpoints, a new contract for the new owner, deployment and source), so a case can build or refuse without consuming
 * the real run. over: {mutate(contract), status, result, steps, created, owner}. owner: an existing world (a second run of the same owner).
 */
async function cloneRun(label,over={}){
  const base=await BASE(),who=over.owner??await newWorld(label);
  const contract=clone(base.contract);
  Object.assign(contract,{owner_id:who.id,bot_id:who.id,deployment_id:who.deployment,pine_import_id:who.importId,baseline_snapshot_hash:who.snapshotHash});
  contract.snapshot.membership=[{pine_import_id:who.importId,source_version:1,source_hash:SOURCE_HASH}];
  over.mutate?.(contract);
  const runId='run-bi-'+randomUUID(),created=over.created??nextCreated(),status=over.status??'SUCCEEDED',result=Object.hasOwn(over,'result')?over.result:base.result;
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,phase,created_at,updated_at,deadline,attempt,result)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,'COMPLETE',$9,$9,$10,1,$11)`,[runId,who.id,who.deployment,'idem-'+runId,hex('submission-'+label),hash(canonical(contract)),JSON.stringify(contract),status,created,created+3600000,
    result===null?null:JSON.stringify(result)]);
  for(const step of over.steps??base.steps)await db.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
    [runId,step.step_id,step.kind,JSON.stringify(step.parameters),JSON.stringify(step.result),step.completed_at]);
  return {who,owner_id:who.id,run_id:runId,contract,created};
}

/* ---- service construction ---- */

let tick=0;
function service(handle=fx,over={}){
  const own=new Store(handle);
  return new BiFixturePackageService({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>BASE_TIME+30*24*3600000+(tick++),
    engineHash:()=>engineHash(false),traceClosureHash:()=>TRACE(),ports:ports(),...over});
}
const counts=async()=>Object.fromEntries(await Promise.all(BI_TABLES.map(async table=>[table,(await db.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
const digestOf=async table=>(await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const sideDigest=async()=>Object.fromEntries(await Promise.all(SIDE_TABLES.map(async table=>[table,await digestOf(table)])));
const rowsFor=async(table,exportId)=>(await db.query(`SELECT * FROM public.${table} WHERE export_id=$1`,[exportId])).rows;
const exportsOf=async(owner,run)=>(await db.query('SELECT export_id FROM public.bi_exports WHERE owner_id=$1 AND run_id=$2',[owner,run])).rows;
/** Asserts that fn refuses with the code and writes no row of any package table. */
async function refusesWithNoRows(fn,code,fields={}){
  const was=await counts(),out=await fn();
  assert.equal(out.ok,false,JSON.stringify(out));
  assert.equal(out.code,code,JSON.stringify(out));
  for(const [key,value] of Object.entries(fields))assert.deepEqual(out[key],value,key);
  assert.deepEqual(await counts(),was,'a refusal writes no row');
  return out;
}
/** A fixture compile record and the five evidence kinds (and the two clearances) for an export, through the service. */
async function fill(svc,who,exportId,{skip=[]}={}){
  const given={owner_id:who,export_id:exportId};
  for(const kind of ['dataset_alignment','native_parity','bridge_parity','repaint','quant_baseline'])if(!skip.includes(kind))assert.equal((await svc.recordEvidence({...given,kind})).ok,true,kind);
  if(!skip.includes('compile'))assert.equal((await svc.recordCompile(given)).ok,true);
  if(!skip.includes('clearance'))for(const blocker of CANDIDATE_BLOCKERS)assert.equal((await svc.recordClearance({...given,blocker})).ok,true,blocker);
}
/** db with fault injection: onQuery(sql, params) may throw or rewrite the params. Everything else is the real database. */
function faulty(handle,{onQuery=()=>undefined,afterTransaction=null}={}){
  return new Proxy(handle,{get(target,prop){
    if(prop==='query')return async(sql,params)=>{const rewritten=onQuery(sql,params);return target.query(sql,rewritten??params);};
    if(prop==='transaction'&&afterTransaction)return async(fn,options)=>{const value=await target.transaction(fn,options);afterTransaction();return value;};
    const value=Reflect.get(target,prop,target);
    return typeof value==='function'?value.bind(target):value;
  }});
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  CLOSURE=await engineHash(false);TRACE=()=>traceReproductionEngineHash();
  BASE_TIME=T0+6*3600000;
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL,max:2});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_bi_tpl_'+suffix;databaseName='robot_bi_main_'+suffix;
  rtName='robot_bi_rt_'+suffix.slice(0,14);roName='robot_bi_ro_'+suffix.slice(0,14);noName='robot_bi_no_'+suffix.slice(0,14);
  for(const name of [rtName,roName,noName]){await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());roles.push(name);}
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await builder.transaction(async()=>builder.query(await sqlText(name)));
    // The boundary table is part of the preflight extension, which needs the whole foundation schema; the test installs exactly the table, its function and its trigger from that file.
    const preflight=await sqlText('quant-preflight-schema.sql'),start=preflight.indexOf('CREATE TABLE quant_holdout_boundaries('),marker='EXECUTE FUNCTION quant_holdout_boundary_write_once();';
    assert.ok(start>=0&&preflight.indexOf(marker)>start);
    await builder.transaction(async()=>builder.query(preflight.slice(start,preflight.indexOf(marker)+marker.length)));
    await migrateQuantExposureRegister(builder);
    await migrateBestInputsPackage(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  db=track(new PostgresDatabase({connectionString:urlOf(databaseName),max:4}));
  store=new Store(db);
  await db.query(await grantScript(rtName));
  await db.query('GRANT USAGE ON SCHEMA public TO '+roName+','+noName);
  await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO '+roName);
  fx=track(new PostgresDatabase({connectionString:urlOf(databaseName,rtName),max:4}));
  fx2=track(new PostgresDatabase({connectionString:urlOf(databaseName,rtName),max:3}));
  ro=track(new PostgresDatabase({connectionString:urlOf(databaseName,roName),max:2}));
  none=track(new PostgresDatabase({connectionString:urlOf(databaseName,noName),max:2}));
  const rows=BAR_LIST.map(bar=>({time:bar.time,bar:JSON.stringify(bar),hash:hash(canonical(bar))}));
  await db.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,b::jsonb,$4::jsonb,h FROM unnest($1::bigint[],$2::text[],$3::text[]) AS u(t,b,h)`,
    [rows.map(row=>row.time),rows.map(row=>row.bar),rows.map(row=>row.hash),JSON.stringify(PROVENANCE)]);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    const dropper=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
    await dropper.connect();
    for(const name of [databaseName,templateName])await dropper.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of roles)await dropper.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await dropper.end();
    await admin.close();
  }
});

/* ================================ E1: the real run ================================ */

let E1_EXPORT=null;
test('E1 (real run) one stored v3 fixture run goes through S3, the renderer, B0 and the SERIALIZABLE transaction into one labelled fixture export; every hash is recomputed independently',{skip:NO_PYTHON,timeout:900000},async()=>{
  const base=await BASE(),side=await sideDigest(),was=await counts();
  const p=ports(),steps=[],svc=service(fx,{ports:p,hooks:{step:name=>{steps.push(name);}}});
  const built=await svc.build({owner_id:base.owner_id,run_id:base.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.deepEqual([built.action,built.status,built.codes,built.fixture,built.ready],['BUILD','EXPORT_CANDIDATE',[],true,false]);
  assert.deepEqual(steps,['LOOKUPS','REPRODUCE','RENDER','B0','TX_BEGIN','INSERT'],'the RC-16 order');
  assert.equal(p.stats.trace,1,'one HOLDOUT replay');
  assert.ok(p.stats.realTrace===1&&p.stats.realEvaluate>=6,'the first reproduction reached the real engine and the real trace driver');
  const id=built.export_id;
  E1_EXPORT=id;
  const now=await counts();
  assert.deepEqual(Object.fromEntries(Object.keys(now).map(key=>[key,now[key]-was[key]])),{bi_blobs:12,bi_exports:1,bi_package_files:12,bi_status_events:1,bi_attempts:0,ql4c_validation:0,bi_compile_records:0,bi_evidence_records:0,bi_clearances:0,bi_trace_reproductions:3});
  assert.deepEqual(await sideDigest(),side,'no side table changed (the exposure register, the run, the Pine tables, the bars)');
  const row=(await rowsFor('bi_exports',id))[0];
  assert.deepEqual([row.owner_id,row.bot_id,row.run_id,row.mode,row.internal,row.fixture,row.gate_version,row.parent_export_id],[base.owner_id,base.owner_id,base.run_id,'ONE_PINE',false,true,PACKAGE_GATE_VERSION,null]);
  assert.deepEqual(row.library_versions,PACKAGE_LIBRARY_VERSIONS);
  assert.equal(row.b0.pass,true);assert.deepEqual(row.b0.codes,[]);assert.equal(row.b0.g7.state,'PASS','G7 derives PASS from the v3 version and the completion reason');
  assert.deepEqual((await rowsFor('bi_status_events',id)).map(event=>[event.seq,event.status,event.codes,event.attempt_no]),[[1,'EXPORT_CANDIDATE',[],null]]);
  // every file and trace hash is recomputed here, with node:crypto, from the stored bytes
  const stored=(await db.query('SELECT f.path,f.sha256,f.bytes,b.content FROM public.bi_package_files f JOIN public.bi_blobs b ON b.sha256=f.sha256 WHERE f.export_id=$1 ORDER BY f.path',[id])).rows;
  assert.deepEqual(stored.map(file=>file.path).sort(),[...PACKAGE_FILES].sort());
  for(const file of stored){assert.equal(sha(file.content),file.sha256,file.path);assert.equal(file.content.length,Number(file.bytes),file.path);}
  const byPath=Object.fromEntries(stored.map(file=>[file.path,file]));
  const manifest=JSON.parse(byPath['quant-data/manifest.json'].content.toString('utf8'));
  assert.equal(sha(canonical(manifest)),row.package_hash);assert.equal(packageHash(manifest),row.package_hash);
  assert.equal(sha(canonical(row.binding)),row.binding_hash);assert.equal(bindingHash(manifest.binding),row.binding_hash);
  assert.deepEqual(manifest.files.map(file=>[file.path,file.sha256,file.bytes]),stored.filter(file=>file.path!=='quant-data/manifest.json').map(file=>[file.path,file.sha256,Number(file.bytes)]));
  assert.equal(manifest.fixture,true);assert.equal(row.binding.fixture,true);assert.equal(row.binding.mode,'ONE_PINE');
  const trace=await rowsFor('bi_trace_reproductions',id);
  assert.deepEqual(trace.map(item=>item.path).sort(),[...TRACE_FILES].sort());
  const storedDigests={steps:sha(canonical({candidate:{parameters:base.result.selected.parameters,result:base.result.selected.result},sensitivity:base.result.selected.sensitivity,cost_stress:base.result.selected.cost_stress})),
    holdout:sha(canonical({test:base.result.selected.test}))};
  for(const item of trace){
    assert.equal(item.sha256,byPath[item.path].sha256,'the trace row names the stored file');
    assert.equal(sha(byPath[item.path].content),item.sha256);
    assert.deepEqual([item.steps_digest,item.holdout_digest,item.run_engine_hash,item.trace_engine_hash],[storedDigests.steps,storedDigests.holdout,CLOSURE,await TRACE()],'recomputed digests equal the digests of the stored steps');
  }
  // an independent reproduction by the real engine (no replay) renders the same twelve files
  const again=await reproduceRun({run:{...base.row},ports:REAL_PORTS});
  assert.equal(again.steps_digest,storedDigests.steps);assert.equal(again.holdout_digest,storedDigests.holdout);
  const rendered=renderPackage({export_id:id,created_at:row.binding.created_at,fixture:true,run:{...base.row},library_versions:row.library_versions,risk_limits:JSON.parse(byPath['risk-profile.json'].content.toString('utf8')).limits,
    trace:again.trace,exit_version:'bridge-exit-v2'});
  for(const file of stored)assert.equal(rendered.files[file.path],file.content.toString('utf8'),'independent real reproduction renders '+file.path);
  // a second build is a new operator request: it starts with the existing-export check and does not evaluate again
  const traceCalls=p.stats.trace,second=await svc.build({owner_id:base.owner_id,run_id:base.run_id});
  assert.deepEqual([second.ok,second.action,second.export_id,second.status],[true,'LOAD',id,'EXPORT_CANDIDATE']);
  assert.equal(p.stats.trace,traceCalls,'LOAD never replays HOLDOUT');
  assert.deepEqual(await counts(),now);
  // read: stored export, derived freshness, READY false
  const view=await svc.read({owner_id:base.owner_id,export_id:id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.deepEqual([view.status,view.fixture,view.ready,view.freshness.fresh,view.freshness.state],['EXPORT_CANDIDATE',true,false,true,'FRESH']);
  assert.deepEqual((await svc.read({owner_id:base.owner_id,run_id:base.run_id})).export.export_id,id);
});

test('E1 attempts: a retryable-only failure keeps the export a candidate, fixture records and clearances make attempt 2 pass to a fixture EXPORT_VALIDATED with a ql4c_validation row, READY false and G8 unchanged',{skip:NO_PYTHON,timeout:900000},async()=>{
  const base=await BASE(),id=E1_EXPORT;
  assert.ok(id,'the E1 build ran first');
  const gate=[],svc=service(fx,{hooks:{step:(name,detail)=>{if(name==='GATES')gate.push(detail);}}});
  await fill(svc,base.owner_id,id,{skip:['compile','clearance']});
  const first=await svc.attempt({owner_id:base.owner_id,export_id:id});
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.deepEqual([first.attempt_no,first.pass,first.status,first.fixture,first.ready],[1,false,'EXPORT_CANDIDATE',true,false]);
  assert.deepEqual([...first.codes].sort(),['ACCEPTANCE_BLOCKERS_PRESENT','BI_COMPILE_EVIDENCE_MISSING']);
  assert.ok(first.codes.every(code=>RETRYABLE_CODES.includes(code)));
  assert.deepEqual(first.event_codes,first.codes);
  assert.deepEqual(Object.keys(gate[0].evidence).sort(),['bridge_parity','dataset_alignment','native_parity','quant_baseline','repaint'],'the gates read the five evidence records');
  assert.deepEqual((await rowsFor('bi_status_events',id)).map(event=>[event.seq,event.status,event.attempt_no]),[[1,'EXPORT_CANDIDATE',null],[2,'EXPORT_CANDIDATE',1]]);
  assert.equal((await rowsFor('ql4c_validation',id)).length,0,'no validation record for a failed attempt');
  // the missing records are now recorded: attempt 2 passes
  assert.equal((await svc.recordCompile({owner_id:base.owner_id,export_id:id})).ok,true);
  for(const blocker of CANDIDATE_BLOCKERS)assert.equal((await svc.recordClearance({owner_id:base.owner_id,export_id:id,blocker})).ok,true,blocker);
  const second=await svc.attempt({owner_id:base.owner_id,export_id:id});
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.deepEqual([second.attempt_no,second.pass,second.status,second.codes,second.event_codes,second.ready],[2,true,'EXPORT_VALIDATED',[],[],false],JSON.stringify(second.gates));
  assert.deepEqual(second.gates.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','PASS'],['C3','PASS'],['C4','PASS'],['Q','PASS']]);
  const validation=(await rowsFor('ql4c_validation',id))[0],attempts=await rowsFor('bi_attempts',id),events=await rowsFor('bi_status_events',id);
  assert.deepEqual([validation.fixture,validation.attempt_id,validation.package_hash],[true,second.attempt_id,(await rowsFor('bi_exports',id))[0].package_hash]);
  assert.deepEqual(attempts.map(item=>[item.attempt_no,item.pass]),[[1,false],[2,true]]);
  assert.deepEqual(events.map(event=>[event.seq,event.status,event.attempt_no]),[[1,'EXPORT_CANDIDATE',null],[2,'EXPORT_CANDIDATE',1],[3,'EXPORT_VALIDATED',2]]);
  assert.equal(attempts[1].validator_engine_hash,validation.validator_engine_hash);
  // the candidate record writers share the status guard: a record for a validated export is refused by the database guard (QR004), mapped to BI_TRANSITION_INVALID
  assert.deepEqual([(await svc.recordCompile({owner_id:base.owner_id,export_id:id})).code,(await svc.recordEvidence({owner_id:base.owner_id,export_id:id,kind:'repaint'})).code],['BI_TRANSITION_INVALID','BI_TRANSITION_INVALID']);
  assert.equal((await rowsFor('bi_compile_records',id)).length,1);
  // the export is closed
  const closed=await svc.attempt({owner_id:base.owner_id,export_id:id});
  assert.deepEqual([closed.ok,closed.code,closed.status],[false,'EXPORT_NOT_OPEN','EXPORT_VALIDATED']);
  // READY stays false and no reader counts a fixture export as a non-fixture one
  const view=await svc.read({owner_id:base.owner_id,export_id:id});
  assert.deepEqual([view.status,view.ready,view.fixture,view.freshness.fresh],['EXPORT_VALIDATED',false,true,true]);
  const record={...validation,export_id:id};
  assert.equal(libraryG8([{run_id:base.run_id,mode:'ONE_PINE',record}],base.run_id).state,'FAIL','G8 counts only non-fixture packages');
  const member={export_id:id,package:{export_id:id,package_hash:validation.package_hash,status:view.status,binding:(await rowsFor('bi_exports',id))[0].binding,current:view.current,replay_mismatch:false}};
  assert.deepEqual([checkPackage(member,base.owner_id,false).state,checkPackage(member,base.owner_id,false).detail],['FAIL','FIXTURE'],'a customer selection refuses the fixture export');
  assert.equal(checkPackage(member,base.owner_id,true).state,'PASS','a fixture selection reads it as ready');
  // freshness is derived at read time and never written: a newer source revision and a changed policy make the validated export STALE
  const writes=await counts();
  await db.query("INSERT INTO pine_source_revisions VALUES($1,2,$2,$3,'{}',$4)",[base.who.importId,SOURCE_HASH,SOURCE,T0]);
  await db.query('UPDATE pine_memberships SET source_version=2 WHERE pine_import_id=$1',[base.who.importId]);
  try{
    const stale=await svc.read({owner_id:base.owner_id,export_id:id});
    assert.deepEqual([stale.status,stale.freshness.state,stale.freshness.code,stale.ready],['EXPORT_VALIDATED','STALE','BI_SOURCE_VERSION_STALE',false]);
  }finally{await db.query('UPDATE pine_memberships SET source_version=1 WHERE pine_import_id=$1',[base.who.importId]);}
  const policy=service(fx,{readBotState:async()=>({policy_hash:hex('another policy')})});
  assert.deepEqual((await policy.read({owner_id:base.owner_id,export_id:id})).freshness.codes,['BI_POLICY_SNAPSHOT_MISMATCH']);
  // a changed bar makes the dataset unavailable at read time
  const bar="SELECT 1 FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time="+(T0+5*MINUTE);
  await db.query("UPDATE pine_market_bars SET bar=jsonb_set(bar,'{volume}','\"2\"') WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[T0+5*MINUTE]);
  try{assert.ok((await svc.read({owner_id:base.owner_id,export_id:id})).freshness.codes.includes('BI_DATASET_UNAVAILABLE'),bar);}
  finally{await db.query("UPDATE pine_market_bars SET bar=jsonb_set(bar,'{volume}','\"1\"') WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[T0+5*MINUTE]);}
  assert.equal((await svc.read({owner_id:base.owner_id,export_id:id})).freshness.fresh,true,'restored');
  assert.deepEqual(await counts(),writes,'a read writes nothing');
});

test('attempt-time recomputation: a reproduction that disagrees with the stored steps fails C3 (BI_RESULT_MISMATCH), a non-retryable failure that refuses the export',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('tampered'),svc=service(fx);
  const built=await svc.build({owner_id:run.owner_id,run_id:run.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));
  await fill(svc,run.owner_id,built.export_id);
  const bent=ports(),original=bent.evaluate;
  bent.evaluate=async(contract,parameters,kind,signal)=>{
    const reply=await original(contract,parameters,kind,signal);
    if(kind==='STRESS')reply.validation.net_return_percent=String(Number(reply.validation.net_return_percent)+0.01);
    return reply;
  };
  const out=await service(fx,{ports:bent}).attempt({owner_id:run.owner_id,export_id:built.export_id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual([out.pass,out.status,out.codes.includes('BI_RESULT_MISMATCH'),out.codes.every(code=>!RETRYABLE_CODES.includes(code))],[false,'EXPORT_REFUSED',true,true]);
  assert.equal((await rowsFor('ql4c_validation',built.export_id)).length,0);
});

/* ================================ refusals: zero rows written ================================ */

test('refusals write no row and never reach the evaluator: foreign or absent owner, malformed request, v1 run, multi-Pine run, nonterminal and no-candidate runs, a deployment the run did not freeze',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const p=ports(),svc=service(fx,{ports:p});
  const mine=await cloneRun('refuse-a');
  const foreign=await cloneRun('refuse-b');
  await refusesWithNoRows(()=>svc.build({owner_id:foreign.owner_id,run_id:mine.run_id}),'NOT_FOUND');
  await refusesWithNoRows(()=>svc.build({owner_id:mine.owner_id,run_id:'run-absent'}),'NOT_FOUND');
  await refusesWithNoRows(()=>svc.build({owner_id:mine.owner_id,run_id:mine.run_id,fixture:false}),'NOT_FOUND');
  await refusesWithNoRows(()=>svc.build({owner_id:mine.owner_id}),'NOT_FOUND');
  await refusesWithNoRows(()=>svc.build(null),'NOT_FOUND');
  await refusesWithNoRows(()=>svc.attempt({owner_id:foreign.owner_id,export_id:randomUUID()}),'NOT_FOUND');
  const v1=await cloneRun('refuse-v1',{mutate:c=>{c.version='ql3a-research-job-v1';delete c.policy_version;delete c.policy_hash;c.acceptance_blockers=['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'];}});
  const out=await refusesWithNoRows(()=>svc.build({owner_id:v1.owner_id,run_id:v1.run_id}),'BUILD_B0_FAILED');
  assert.ok(out.codes.includes('OWNER_RECOMMENDATION_NOT_READY'),'G7 refuses a v1 run: '+out.codes);
  const multi=await cloneRun('refuse-multi',{mutate:c=>{c.snapshot.membership.push({pine_import_id:randomUUID(),source_version:1,source_hash:SOURCE_HASH});}});
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:multi.owner_id,run_id:multi.run_id}),'BUILD_B0_FAILED')).codes.includes('BI_MULTI_PINE_INTERNAL_ONLY'));
  const running=await cloneRun('refuse-running',{status:'RUNNING',result:null,steps:[]});
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:running.owner_id,run_id:running.run_id}),'BUILD_B0_FAILED')).codes.includes('STATUS_NOT_COMPLETED'));
  const none=await cloneRun('refuse-none',{status:'NO_VALID_CANDIDATE',result:{completion_reason:'NO_VALID_TRAIN_VALIDATION_CANDIDATE',holdout_evaluated:false,selected:null,candidates:[]},steps:[]});
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:none.owner_id,run_id:none.run_id}),'BUILD_B0_FAILED')).codes.length>0);
  const outside=await cloneRun('refuse-scope',{mutate:c=>{c.scope='SOME_OTHER_SCOPE';}});
  await refusesWithNoRows(()=>svc.build({owner_id:outside.owner_id,run_id:outside.run_id}),'BUILD_INPUT_INVALID',{stage:'SCOPE'});
  const stale=await cloneRun('refuse-stale',{mutate:c=>{c.baseline_snapshot_hash=hex('another baseline');}});
  await refusesWithNoRows(()=>svc.build({owner_id:stale.owner_id,run_id:stale.run_id}),'BI_BINDING_INCOMPLETE',{stage:'DEPLOYMENT'});
  assert.deepEqual([p.stats.evaluate,p.stats.trace],[0,0],'no refusal above costs an evaluation');
});

test('B0 lookups refuse before the evaluator: a reused holdout window, malformed history, an exposed window, an unavailable register',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const p=ports(),svc=service(fx,{ports:p});
  const holdoutStart=T0+SPLIT.validation_end*MINUTE;
  const prior=(who,{created,split=SPLIT,start=T0,holdout=true,contract})=>db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,phase,created_at,updated_at,deadline,attempt,result)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'SUCCEEDED','COMPLETE',$8,$8,$8,1,$9)`,[randomUUID(),who.id,who.deployment,'idem-'+randomUUID(),hex('prior'),hex('prior-contract'),
    JSON.stringify(contract??{version:'ql3a-research-job-v1',source_hash:hex('another source'),snapshot:{market:MARKET},split,dataset:{start_time:start}}),created,JSON.stringify({holdout_evaluated:holdout})]);
  // a reused holdout window: an earlier run of the owner evaluated the same window
  const reused=await cloneRun('lookups-reused');
  await prior(reused.who,{created:reused.created-10000});
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:reused.owner_id,run_id:reused.run_id}),'BUILD_B0_FAILED')).codes.includes('HOLDOUT_WINDOW_REUSED'));
  // malformed history: an earlier holdout run whose window cannot be read is not an empty history
  const malformed=await cloneRun('lookups-malformed');
  await prior(malformed.who,{created:malformed.created-10000,contract:{version:'ql3a-research-job-v1',source_hash:hex('x'),snapshot:{market:MARKET}}});
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:malformed.owner_id,run_id:malformed.run_id}),'BUILD_B0_FAILED')).codes.includes('HOLDOUT_INDEPENDENCE_NOT_CHECKED'));
  // an earlier run that searched the holdout period with the same source
  const searched=await cloneRun('lookups-searched');
  await prior(searched.who,{created:searched.created-10000,holdout:false,start:T0+SPLIT.train_end*MINUTE-100*MINUTE,contract:{version:'ql3a-research-job-v1',source_hash:SOURCE_HASH,snapshot:{market:MARKET},
    split:{warmup:10,train_end:700,validation_end:1200,test_end:1400},dataset:{start_time:T0+SPLIT.train_end*MINUTE-100*MINUTE}}});
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:searched.owner_id,run_id:searched.run_id}),'BUILD_B0_FAILED')).codes.includes('BI_HOLDOUT_OVERLAPS_SEARCHED_DATA'));
  // a registered boundary after the holdout start
  const bounded=await cloneRun('lookups-boundary');
  await db.query('INSERT INTO quant_holdout_boundaries(owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8)',
    [bounded.owner_id,'binance-global','SPOT','BTCUSDT','1',holdoutStart+MINUTE,'fixture',T0]);
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:bounded.owner_id,run_id:bounded.run_id}),'BUILD_B0_FAILED')).codes.includes('BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY'));
  // an exposure of the window recorded before the run was created
  const exposed=await cloneRun('lookups-exposed');
  const appended=await db.transaction(()=>appendExposures(db,{owner_id:exposed.owner_id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:holdoutStart,end_ms:holdoutStart+MINUTE},selection_id:'sel-'+randomUUID()}],now:()=>exposed.created-5000}),{isolation:'SERIALIZABLE'});
  assert.equal(appended.ok,true);
  assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:exposed.owner_id,run_id:exposed.run_id}),'BUILD_B0_FAILED')).codes.includes('BI_HOLDOUT_EXPOSED_BY_SELECTION'));
  // an unavailable register fails closed
  const gone=await cloneRun('lookups-register');
  await db.query('ALTER TABLE public.quant_exposure_register RENAME TO quant_exposure_register_gone');
  try{assert.ok((await refusesWithNoRows(()=>svc.build({owner_id:gone.owner_id,run_id:gone.run_id}),'BUILD_B0_FAILED')).codes.includes('BI_EXPOSURE_REGISTER_UNAVAILABLE'));}
  finally{await db.query('ALTER TABLE public.quant_exposure_register_gone RENAME TO quant_exposure_register');}
  assert.deepEqual([p.stats.evaluate,p.stats.trace],[0,0],'B0 on the run and its history refuses before any evaluation');
});

test('reproduction and rendering refusals: a profile mismatch, a run closure change, a failed evaluation, oversized output and a late insert failure write no row',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('closure');
  const given={owner_id:run.owner_id,run_id:run.run_id};
  // ports bound to another closure than the profile names
  const other={...ports(),closure:'engineHash(true)'};
  await refusesWithNoRows(()=>service(fx,{ports:other}).build(given),'TRACE_REPRODUCTION_UNSUPPORTED',{stage:'REPRODUCE'});
  // the run closure no longer equals the contract engine hash
  const drifted=ports();drifted.engineHash=async()=>hex('another run closure');
  await refusesWithNoRows(()=>service(fx,{ports:drifted}).build(given),'BI_ENGINE_HASH_MISMATCH',{stage:'REPRODUCE'});
  assert.equal(drifted.stats.trace,0,'no HOLDOUT replay after a closure change');
  // the real port factory is accepted by the service and binds the run closure (its evaluation needs the private SPT source gate that the bootstrap replaces, so it is not run here)
  const factory=defaultPorts({closure:'engineHash(false)',python:PYTHON});
  assert.equal(await factory.engineHash(),CLOSURE);
  assert.doesNotThrow(()=>service(fx,{ports:factory}));
  // the closure the service pins is judged before the evaluator is paid for
  const pinned=ports();
  await refusesWithNoRows(()=>service(fx,{ports:pinned,engineHash:()=>hex('another pinned closure')}).build(given),'BI_ENGINE_HASH_MISMATCH',{stage:'ENGINE'});
  assert.deepEqual([pinned.stats.evaluate,pinned.stats.trace],[0,0]);
  // a failed evaluation: a coded refusal, no raw error
  const broken=ports();broken.evaluate=async()=>{throw Object.assign(new Error('C:\\secret\\path'),{code:'ENOENT'});};
  await refusesWithNoRows(()=>service(fx,{ports:broken}).build(given),'EVALUATION_FAILED',{stage:'REPRODUCE'});
  // an oversized package
  await refusesWithNoRows(()=>service(fx,{maxPackageBytes:2000}).build(given),'BUILD_INPUT_INVALID',{stage:'SIZE'});
  assert.throws(()=>service(fx,{maxPackageBytes:0}));
  // the trace closure changes between the reproduction and the transaction: BI_ENGINE_HASH_MISMATCH, no row, no restart
  let live=false;const stepNames=[];
  const drift=service(fx,{traceClosureHash:()=>live?hex('another trace closure'):TRACE(),hooks:{beforeTransaction:()=>{live=true;},step:name=>{stepNames.push(name);}}});
  await refusesWithNoRows(()=>drift.build(given),'BI_ENGINE_HASH_MISMATCH',{stage:'ENGINE'});
  assert.equal(stepNames.filter(name=>name==='TX_BEGIN').length,1,'a closure change is never retried');
  // a late insert failure (the last insert of the transaction) rolls everything back and is rethrown
  const late=faulty(fx,{onQuery:sql=>{if(sql.includes('INSERT INTO public.bi_trace_reproductions'))throw Object.assign(new Error('injected late failure'),{code:'23514'});}});
  const was=await counts();
  await assert.rejects(service(late).build(given),{code:'23514'});
  assert.deepEqual(await counts(),was,'rollback leaves no blob, export, file, event or trace row');
  const retry=ports();
  await assert.doesNotReject(service(fx,{ports:retry}).build(given).then(out=>{assert.equal(out.ok,true,JSON.stringify(out));}),'the slot is free and the run is still buildable');
});

test('B0 runs again inside the SERIALIZABLE transaction: an exposure committed between the first B0 and TX_BEGIN refuses with BUILD_B0_FAILED, writes no row and does not reproduce again',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('b0-in-tx');
  const holdoutStart=T0+SPLIT.validation_end*MINUTE;
  const p=ports(),steps=[];
  const svc=service(fx,{ports:p,hooks:{step:name=>{steps.push(name);},beforeTransaction:async()=>{
    const appended=await db.transaction(()=>appendExposures(db,{owner_id:run.owner_id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:holdoutStart,end_ms:holdoutStart+MINUTE},selection_id:'sel-'+randomUUID()}],now:()=>run.created-5000}),{isolation:'SERIALIZABLE'});
    assert.equal(appended.ok,true);
  }}});
  const was=await counts();
  const out=await refusesWithNoRows(()=>svc.build({owner_id:run.owner_id,run_id:run.run_id}),'BUILD_B0_FAILED',{stage:'B0'});
  assert.ok(out.codes.includes('BI_HOLDOUT_EXPOSED_BY_SELECTION'),JSON.stringify(out));
  assert.deepEqual(steps.filter(name=>name==='B0'),['B0'],'the first B0 passed before the hook ran');
  assert.equal(steps.filter(name=>name==='TX_BEGIN').length,1,'the in-transaction B0 refusal is not restarted');
  assert.ok(!steps.includes('INSERT'));
  assert.equal(p.stats.trace,1,'one reproduction only');
  assert.deepEqual(await counts(),was);
});

test('a QR004 insert guard maps to BI_TRANSITION_INVALID and rolls back; QR003 is impossible through the service (it always opens SERIALIZABLE)',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('guard');
  const rewrite=faulty(fx,{onQuery:(sql,params)=>{if(sql.includes('INSERT INTO public.bi_exports')){const next=[...params];next[3]='run-that-does-not-exist';return next;}}});
  const out=await refusesWithNoRows(()=>service(rewrite).build({owner_id:run.owner_id,run_id:run.run_id}),'BI_TRANSITION_INVALID');
  assert.match(out.diagnostic.message,/existing research run/);
  const guarded=service(fx);
  const inside=await fx.transaction(()=>guarded.build({owner_id:run.owner_id,run_id:run.run_id}),{isolation:'READ COMMITTED'});
  assert.deepEqual([inside.ok,inside.code],[false,'PACKAGE_STORE_IN_TRANSACTION'],'a call inside a caller transaction is refused before any statement');
  assert.throws(()=>new BiFixturePackageService({db:fx,store:new Store(db),readBotState:()=>{},clock:()=>1,engineHash:CLOSURE,traceClosureHash:CLOSURE,ports:ports()}),/same db/);
});

/* ================================ limitations, single-flight, races, retries, cancellation ================================ */

test('rules that differ from the current rules render the limitation code once and the stored b0 and the manifest agree',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('limitations'),steps=[];
  const svc=service(fx,{currentRules:{minimum_closed_trades_train:5,minimum_closed_trades_validation:5,minimum_closed_trades_test:5,maximum_drawdown_percent:25,sensitivity_max_drop_percentage_points:2},hooks:{step:name=>{steps.push(name);}}});
  const built=await svc.build({owner_id:run.owner_id,run_id:run.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.deepEqual(steps.filter(name=>name==='RENDER'),['RENDER','RENDER'],'rendered again once the limitation codes changed');
  const row=(await rowsFor('bi_exports',built.export_id))[0],manifest=JSON.parse((await db.query("SELECT convert_from(b.content,'UTF8') t FROM public.bi_package_files f JOIN public.bi_blobs b ON b.sha256=f.sha256 WHERE f.export_id=$1 AND f.path='quant-data/manifest.json'",[built.export_id])).rows[0].t);
  assert.deepEqual(row.b0.limitations,['RULES_VERSION_DIFFERS']);assert.deepEqual(manifest.limitations.codes,['RULES_VERSION_DIFFERS']);
  // a non-retryable failure of attempt 1 (no evidence at all: the quant baseline is missing) refuses the export for good
  const first=await svc.attempt({owner_id:run.owner_id,export_id:built.export_id});
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.deepEqual([first.pass,first.status],[false,'EXPORT_REFUSED']);
  assert.ok(first.codes.includes('BI_QUANT_BASELINE_FAILED')&&!first.codes.includes('BI_ATTEMPTS_EXHAUSTED'));
  assert.deepEqual(first.event_codes,first.codes);
  const events=await rowsFor('bi_status_events',built.export_id);
  assert.deepEqual(events.map(event=>[event.seq,event.status,event.attempt_no]),[[1,'EXPORT_CANDIDATE',null],[2,'EXPORT_REFUSED',1]]);
  assert.deepEqual([(await svc.attempt({owner_id:run.owner_id,export_id:built.export_id})).code],['EXPORT_NOT_OPEN'],'no attempt follows a terminal status');
});

test('the fifth retryable failure gives EXPORT_REFUSED with BI_ATTEMPTS_EXHAUSTED; a changed engine hash refuses an attempt with no attempt row',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('exhausted'),svc=service(fx);
  const built=await svc.build({owner_id:run.owner_id,run_id:run.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));
  const id=built.export_id;
  await fill(svc,run.owner_id,id,{skip:['compile','clearance']});
  // a live engine hash that is not the contract's: no attempt row, no evaluation
  const changed=ports(),moved=service(fx,{engineHash:()=>hex('a changed engine'),ports:changed});
  const was=await counts();
  const refused=await moved.attempt({owner_id:run.owner_id,export_id:id});
  assert.deepEqual([refused.ok,refused.code,refused.stage],[false,'BI_ENGINE_HASH_MISMATCH','ENGINE']);
  assert.deepEqual(await counts(),was);assert.equal(changed.stats.trace,0);
  for(let n=1;n<=4;n++){
    const out=await svc.attempt({owner_id:run.owner_id,export_id:id});
    assert.deepEqual([out.ok,out.attempt_no,out.pass,out.status],[true,n,false,'EXPORT_CANDIDATE'],JSON.stringify(out));
  }
  const fifth=await svc.attempt({owner_id:run.owner_id,export_id:id});
  assert.deepEqual([fifth.ok,fifth.attempt_no,fifth.pass,fifth.status],[true,5,false,'EXPORT_REFUSED']);
  assert.deepEqual([...fifth.event_codes].sort(),[...fifth.codes,'BI_ATTEMPTS_EXHAUSTED'].sort());
  assert.ok(!fifth.codes.includes('BI_ATTEMPTS_EXHAUSTED'),'no attempt carries BI_ATTEMPTS_EXHAUSTED');
  assert.deepEqual((await rowsFor('bi_attempts',id)).map(row=>row.attempt_no),[1,2,3,4,5]);
  assert.equal((await rowsFor('ql4c_validation',id)).length,0);
  assert.equal((await svc.attempt({owner_id:run.owner_id,export_id:id})).code,'EXPORT_NOT_OPEN');
});

test('single-flight: two same-instance callers cause one reproduction and one export; another run or a ninth waiter is PACKAGE_STORE_BUSY; a joined waiter that aborts detaches alone; nothing is cached after the job settles',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('single'),other=await cloneRun('single-other');
  const p=ports(),reached=defer(),gate=defer();
  const svc=service(fx,{ports:p,hooks:{beforeTransaction:async()=>{reached.resolve();await gate.promise;}}});
  const given={owner_id:run.owner_id,run_id:run.run_id};
  const first=svc.build(given);
  await reached.promise;
  assert.equal(p.stats.trace,1);
  const was=await counts();
  const busy=await svc.build({owner_id:other.owner_id,run_id:other.run_id});
  assert.deepEqual([busy.ok,busy.code],[false,'PACKAGE_STORE_BUSY']);
  assert.equal((await svc.attempt({owner_id:run.owner_id,export_id:randomUUID()})).code,'PACKAGE_STORE_BUSY','an attempt never joins a build');
  const cancel=new AbortController(),detached=svc.build(given,{signal:cancel.signal});
  cancel.abort();
  assert.deepEqual([(await detached).code],['PACKAGE_STORE_CANCELLED'],'a joined waiter detaches alone');
  const waiters=Array.from({length:PACKAGE_STORE_MAX_WAITERS},()=>svc.build(given));
  const ninth=await svc.build(given);
  assert.deepEqual([ninth.ok,ninth.code],[false,'PACKAGE_STORE_BUSY'],'at most '+PACKAGE_STORE_MAX_WAITERS+' joined waiters');
  gate.resolve();
  const results=[await first,...await Promise.all(waiters)];
  assert.ok(results.every(out=>out.ok===true&&out.export_id===results[0].export_id),JSON.stringify(results.map(out=>out.code??out.export_id)));
  assert.ok(results.every(out=>out.action==='BUILD'),'every joined caller receives the one job result');
  assert.equal(p.stats.trace,1,'one reproduction for every caller');
  assert.equal((await exportsOf(run.owner_id,run.run_id)).length,1);
  assert.equal((await counts()).bi_exports-was.bi_exports,1);
  // zero terminal-entry lifetime: the next call is a new request (LOAD), and a different run is no longer BUSY
  assert.deepEqual([(await svc.build(given)).action],['LOAD']);
  const next=await svc.build({owner_id:other.owner_id,run_id:other.run_id});
  assert.equal(next.ok,true,JSON.stringify(next));
});

test('final-transaction race: two instances build the same run at once and exactly one export commits; each instance replays HOLDOUT once (no cross-process exclusion)',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('race'),given={owner_id:run.owner_id,run_id:run.run_id};
  let arrived=0;const barrier=defer();
  const hooks={beforeInsert:async()=>{if(++arrived===2)barrier.resolve();await barrier.promise;}};
  const one=ports(),two=ports();
  const [a,b]=await Promise.all([service(fx,{ports:one,hooks}).build(given),service(fx2,{ports:two,hooks}).build(given)]);
  assert.equal(a.ok,true,JSON.stringify(a));assert.equal(b.ok,true,JSON.stringify(b));
  assert.equal(a.export_id,b.export_id);
  assert.deepEqual([a.action,b.action].sort(),['BUILD','LOAD']);
  assert.equal((await exportsOf(run.owner_id,run.run_id)).length,1);
  assert.equal((await rowsFor('bi_package_files',a.export_id)).length,12);
  assert.deepEqual([one.stats.trace,two.stats.trace],[1,1],'the loser restarted its transaction without evaluating again');
});

test('commit retries: 40001 restarts reuse the verified reproduction (HOLDOUT stays one); after the last restart the race error is rethrown; an error after COMMIT is rethrown and read() finds the export',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('retry'),given={owner_id:run.owner_id,run_id:run.run_id};
  const race=()=>Object.assign(new Error('injected serialization failure'),{code:'40001'});
  // always lost: one first try plus PACKAGE_STORE_MAX_RETRIES restarts, then the last race error
  let p=ports(),begins=0;
  const lost=faulty(fx,{onQuery:sql=>{if(sql.includes('INSERT INTO public.bi_exports'))throw race();}});
  const was=await counts();
  await assert.rejects(service(lost,{ports:p,hooks:{step:name=>{if(name==='TX_BEGIN')begins++;}}}).build(given),{code:'40001'});
  assert.equal(begins,PACKAGE_STORE_MAX_RETRIES+1);
  assert.equal(p.stats.trace,1,'HOLDOUT stays one across every commit retry');
  assert.deepEqual(await counts(),was);
  // lost twice, then committed
  p=ports();begins=0;let lostCount=0;
  const twice=faulty(fx,{onQuery:sql=>{if(sql.includes('INSERT INTO public.bi_exports')&&lostCount<2){lostCount++;throw race();}}});
  const built=await service(twice,{ports:p,hooks:{step:name=>{if(name==='TX_BEGIN')begins++;}}}).build(given);
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.deepEqual([begins,p.stats.trace,built.action],[3,1,'BUILD']);
  // another unique violation is not success and not a race
  const other=await cloneRun('retry-unique');
  const wrong=faulty(fx,{onQuery:sql=>{if(sql.includes('INSERT INTO public.bi_exports'))throw Object.assign(new Error('injected'),{code:'23505',constraint:'bi_exports_pkey'});}});
  begins=0;
  await assert.rejects(service(wrong,{hooks:{step:name=>{if(name==='TX_BEGIN')begins++;}}}).build({owner_id:other.owner_id,run_id:other.run_id}),{code:'23505'});
  assert.equal(begins,1,'a unique violation of another key is not retried');
  // an error at or after COMMIT: rethrown unchanged, no retry, no requeue; the operator reads before a new request
  const uncertain=await cloneRun('uncertain');
  begins=0;
  const after=faulty(fx,{afterTransaction:()=>{throw Object.assign(new Error('connection lost after commit'),{code:'08006'});}});
  const traceCalls=ports();
  await assert.rejects(service(after,{ports:traceCalls,hooks:{step:name=>{if(name==='TX_BEGIN')begins++;}}}).build({owner_id:uncertain.owner_id,run_id:uncertain.run_id}),{code:'08006'});
  assert.deepEqual([begins,traceCalls.stats.trace],[1,1]);
  const found=await service(fx).read({owner_id:uncertain.owner_id,run_id:uncertain.run_id});
  assert.equal(found.ok,true,JSON.stringify(found));assert.equal(found.status,'EXPORT_CANDIDATE');
});

test('cancellation: a cancel before REPRODUCE or before TX_BEGIN writes nothing; after TX_BEGIN the signal is ignored until COMMIT',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const run=await cloneRun('cancel'),given={owner_id:run.owner_id,run_id:run.run_id};
  const early=new AbortController(),p1=ports();
  const out1=await refusesWithNoRows(()=>service(fx,{ports:p1,hooks:{step:name=>{if(name==='REPRODUCE')early.abort();}}}).build(given,{signal:early.signal}),'PACKAGE_STORE_CANCELLED');
  assert.equal(out1.stage,'REPRODUCE');assert.deepEqual([p1.stats.evaluate,p1.stats.trace],[0,0],'a cancel before REPRODUCE reaches no port');
  const late=new AbortController(),p2=ports();
  await refusesWithNoRows(()=>service(fx,{ports:p2,hooks:{beforeTransaction:()=>{late.abort();}}}).build(given,{signal:late.signal}),'PACKAGE_STORE_CANCELLED',{stage:'TX_BEGIN'});
  assert.equal(p2.stats.trace,1);
  const inside=new AbortController();
  const built=await service(fx,{hooks:{step:name=>{if(name==='TX_BEGIN')inside.abort();}}}).build(given,{signal:inside.signal});
  assert.equal(built.ok,true,JSON.stringify(built));assert.equal(built.action,'BUILD');
  const aborted=new AbortController();aborted.abort();
  assert.deepEqual([(await service(fx).build(given,{signal:aborted.signal})).action],['LOAD'],'an existing export is returned before the signal is looked at');
});

/* ================================ database privileges ================================ */

test('the runtime role holds the insert-only list: UPDATE, DELETE and TRUNCATE of every package table and any marker write are 42501; roles without INSERT or SELECT get 42501 on every service write path',{skip:NO_PYTHON,timeout:900000},async()=>{
  await BASE();
  const id=E1_EXPORT??(await db.query('SELECT export_id FROM public.bi_exports LIMIT 1')).rows[0]?.export_id;
  assert.ok(id,'a stored export exists');
  const denied=sql=>assert.rejects(fx.transaction(()=>fx.query(sql),{isolation:'SERIALIZABLE'}),{code:'42501'},sql);
  for(const table of BI_TABLES){
    await denied(`UPDATE public.${table} SET ${table==='bi_blobs'?'sha256=sha256':'export_id=export_id'}`);
    await denied(`DELETE FROM public.${table}`);
    await denied(`TRUNCATE public.${table}`);
  }
  await denied('INSERT INTO public.bi_package_schema VALUES(1)');
  assert.deepEqual([...WRITTEN_TABLES].sort(),[...BI_TABLES].sort(),'the module writes the ten package tables and no other');
  // a read-only role: the build reaches its first insert and the attempt its attempt insert, and 42501 is rethrown, never mapped
  const run=await cloneRun('privileges'),was=await counts();
  await assert.rejects(service(ro).build({owner_id:run.owner_id,run_id:run.run_id}),{code:'42501'});
  const owner=(await db.query('SELECT owner_id FROM public.bi_exports WHERE export_id=$1',[id])).rows[0].owner_id;
  await assert.rejects(service(ro).recordCompile({owner_id:owner,export_id:id}),{code:'42501'});
  await assert.rejects(service(ro).recordEvidence({owner_id:owner,export_id:id,kind:'repaint'}),{code:'42501'});
  await assert.rejects(service(ro).recordClearance({owner_id:owner,export_id:id,blocker:CANDIDATE_BLOCKERS[0]}),{code:'42501'});
  // a role with no grant at all cannot even read the run
  await assert.rejects(service(none).build({owner_id:run.owner_id,run_id:run.run_id}),{code:'42501'});
  await assert.rejects(service(none).read({owner_id:owner,export_id:id}),{code:'42501'});
  assert.deepEqual(await counts(),was);
});
