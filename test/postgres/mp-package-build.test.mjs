import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {inspectMpRunStore,migrateMpRunStore,classifyMpRunStore} from '../../src/postgres/mp-run-store-migration.js';
import {migrateMpPackageStore,classifyMpPackageStore} from '../../src/postgres/mp-package-store-migration.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {appendExposures} from '../../src/postgres/exposure-register.js';
import {storeBotState} from '../../src/postgres/mp-member-set-store.js';
import {getMultiRun,listMultiRuns,appendRunEvent} from '../../src/postgres/mp-run-store.js';
import {PREFLIGHT_HOLDOUT_SCOPE} from '../../src/postgres/quant-preflight.js';
import {canonical,hash,inspectSource,validateSelection} from '../../src/pine-bridge/source.js';
import {assemble} from '../../src/pine-bridge/template.js';
import {MultiPineFixtureService,effectiveInputsHash} from '../../src/multi-pine/fixture-service.js';
import {SPT_CUSTOM_SETTINGS,SPT_SIGNAL_MAPPING} from '../../src/multi-pine/member-admission.js';
import {MultiPineFixtureExecutor} from '../../src/multi-pine/executor.js';
import {createPythonRunner} from '../../src/multi-pine/python-runner.js';
import {mpCombinedEngineHash} from '../../src/multi-pine/engine-closure.js';
import {mpPackageTraceClosureHash} from '../../src/multi-pine/package-closure.js';
import {evaluateMultiBuildEligibility,MULTI_PACKAGE_GATE_VERSION} from '../../src/multi-pine/package-gates.js';
import {RETRYABLE_CODES} from '../../src/quant-library/package-gates.js';
import {RULES} from '../../src/quant-research/contract.js';
import {MP_TRACE_PATHS} from '../../src/multi-pine/package-trace.js';
import {multiPackageFiles} from '../../src/multi-pine/package-render.js';
import {config} from '../../src/config.js';
import {
  MultiPineFixturePackageService,PACKAGE_STORE_CODES,PACKAGE_STORE_GUARD_NAMES,BOUNDARY_SCOPE,EARLIER_ONE_PINE_SQL,EFFECTIVE_BOUNDARY_SQL,mapPackageStoreFailure,readMultiHoldoutLookups,
  fixtureEvidenceRecord,fixtureCompileRecord,riskLimitsOf,serverHardLimits,bridgeBoundsOf,memberIsolation,HOLDOUT_MAX_PAGES
} from '../../src/postgres/mp-package-store.js';
import {HARD_RANGES} from '../../src/postgres/pf4-risk-proposals.js';

/*
 * F11-01 R6-4: the multi-Pine package store writer, readers and build service (src/postgres/mp-package-store.js; RD-MP-36 to RD-MP-41, RD-MP-46, RC-16) on a throwaway PostgreSQL
 * cluster, FIXTURE-role connection. Every row is a LABELLED FIXTURE (fixture=true, synthetic bars-v2, never a research result, never market evidence).
 *
 * REAL versus STUB: the "real run" cases admit a run and execute it with the REAL Python job (robot_quant.mp_combined_job, src/multi-pine/python-runner.js) on the committed
 * 6,000 synthetic bars-v2 through the real executor, run store, member set and Node oracle. The ONE thing replaced is the private source gate (the owner's reviewed SPT source is
 * not in the repository): validate_custom_snapshot returns the fixture inputs of the member, exactly as test/postgres/mp-executor.test.mjs does. The package service then builds,
 * validates and reads the resulting export with the real renderer, trace producer, B0 and C1 to C4 gates. No compile or parity ran on TradingView: compile and evidence records are
 * fixture records (method fixture-record, operator_role fixture, RD-MP-41), so these cases prove mechanics only.
 * Rows are insert-only, so each case that commits a package uses its own owner and Bot (one packaged run per owner, RD-MP-43 and judgement J3). The six real runs R1 to R6 are
 * created on first use and shared in file order: the cases after "F17 end to end" read the export that case built on R1, so run the file whole, not by test name.
 * D1 (RD-MP-48): the pair of the stored result is a pair of canonical decimal strings and the package modules read it as it is, so F17 runs through the unmodified modules and the package binds the
 * stored result_hash. The cases marked SYN use a hand-built minimal result (no executor): they test the store guards and the B0 refusal, never a research result.
 */
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const FIXTURES=new URL('../fixtures/mp-combined/',import.meta.url);
const GRANT_SCRIPT=new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url);
const RUN_FIXTURE_SCRIPT=new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url);
const PACKAGE_FIXTURE_SCRIPT=new URL('../../scripts/grant-postgres-mp-package-fixture.sql',import.meta.url);
const MANIFEST=JSON.parse(await fs.readFile(new URL('manifest.json',FIXTURES),'utf8'));
const BARS2=JSON.parse(await fs.readFile(new URL('bars-v2.json',FIXTURES),'utf8'));
const T0=1790000000000;
const START2=BARS2.first_time,END2=START2+(BARS2.bar_count-1)*60000,NOW2=END2+3600000;
const DATASET2={start_time:START2,end_time:END2,warmup_bars:MANIFEST.split.warmup};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:10,slippage_bps:1,risk_percent:0.05,data_profile:'closed-ohlcv-atr14-v1'};
const POLICY={paperTrading:true,requireReduceOnlySell:true,...MANIFEST.policy};
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const SOURCE='//@version=6\nindicator("mp executor fixture")\nbuySignal = ta.crossover(close, ta.sma(close, 20))\nsellSignal = ta.crossunder(close, ta.sma(close, 20))\nplot(close)\n';
const SUPPORTED=hash(SOURCE);
// bars-v2 passes the one-Pine HOLDOUT gates on this small grid (test/postgres/mp-executor.test.mjs, "REAL JOB on bars-v2"): the search selects 2/2.
const V2_DOMAINS={atr_multiplier:{min:'2',max:'3',step:'0.5'},rr:{min:'1',max:'2',step:'0.5'}};
const PROVENANCE2={profile:MODEL.data_profile,source:BARS2.provenance.source,fixture:true};
let admin,db,fx,fx2,rt,connectionString,templateName,databaseName,runtimeName,fixtureName,store,service,ENGINE,CLOSURE;
const databases=[],pools=[],extraRoles=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const track=pool=>{pools.push(pool);return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let body=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))body=body.replaceAll(":'"+variable+"'","'"+value+"'");return body;};
const barRow=bar=>({time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,atr14:bar.atr14,price_tick:BARS2.price_tick,quantity_step:BARS2.quantity_step});

/** The boundary table is part of the preflight extension, which needs the whole foundation schema; the test installs exactly the table, its function and its trigger from that file. */
async function boundarySql(){
  const body=await sqlText('quant-preflight-schema.sql');
  const start=body.indexOf('CREATE TABLE quant_holdout_boundaries('),marker='EXECUTE FUNCTION quant_holdout_boundary_write_once();',end=body.indexOf(marker)+marker.length;
  assert.ok(start>=0&&end>start);
  return body.slice(start,end);
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  ENGINE=await mpCombinedEngineHash();CLOSURE=await mpPackageTraceClosureHash();
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_pb_tpl_'+suffix;databaseName='robot_pb_main_'+suffix;
  runtimeName='robot_pb_rt_'+suffix.slice(0,14);fixtureName='robot_pb_fx_'+suffix.slice(0,14);
  for(const name of [runtimeName,fixtureName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  extraRoles.push(runtimeName,fixtureName);
  await admin.query('CREATE DATABASE '+templateName);
  const builder=ser(new PostgresDatabase({connectionString:urlOf(templateName),max:2}));
  try{
    await builder.migrate();
    await install(builder,'pine-bridge-schema.sql');
    await install(builder,'quant-research-schema.sql');
    await builder.transaction(async()=>builder.query(await boundarySql()));
    await migrateQuantExposureRegister(builder);
    await migrateMpMemberSet(builder);
    await migrateMpRunStore(builder);
    await migrateMpPackageStore(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName),max:8})));
  store=new Store(db);
  await db.query(await roleScript(GRANT_SCRIPT,{runtime_role:runtimeName}));
  await db.query(await roleScript(RUN_FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  await db.query(await roleScript(PACKAGE_FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  fx=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:8})));
  fx2=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:4})));
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,runtimeName),max:2})));
  const report=await inspectMpRunStore(db,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(report.ok,true,report.failures?.join());
  service=serviceOn(fx);
  const rows=BARS2.bars.map(barRow);
  await db.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,b::jsonb,$4::jsonb,h FROM unnest($1::bigint[],$2::text[],$3::text[]) AS u(t,b,h)`,
    [rows.map(row=>row.time),rows.map(row=>JSON.stringify(row)),rows.map(row=>hash(canonical(row))),JSON.stringify(PROVENANCE2)]);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    // A raw client: the application pool times a statement out after 15 s, and dropping a big database can take longer.
    const dropper=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
    await dropper.connect();
    for(const name of [...databases,databaseName,templateName])await dropper.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of extraRoles)await dropper.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await dropper.end();
    await admin.close();
  }
});

/* ---- worlds: one owner (= Bot) with COUNT connected members, the supported source, different reviewed inputs (as test/postgres/mp-executor.test.mjs) ---- */

const evidenceFor=(snapshot,snapshotHash,tag)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(MODEL),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});
function analysisFor(inputs){
  const list=Object.entries(SPT_CUSTOM_SETTINGS).map(([name,value])=>({pine_variable:name,type:typeof value==='boolean'?'bool':'string',effective_value:value}));
  list.push({pine_variable:'emaFastInput',type:'int',effective_value:inputs.emaFastInput},{pine_variable:'emaSlowInput',type:'int',effective_value:inputs.emaSlowInput});
  list.push({pine_variable:'minRiskATRInput',type:'float',effective_value:inputs.minRiskATRInput});
  for(let i=list.length;i<58;i++)list.push({pine_variable:'fixtureInput'+i,type:'int',effective_value:i});
  list.forEach((input,i)=>Object.assign(input,{input_id:'in-'+i,eligible:true,declared_domain:{min:null,max:null}}));
  const effective_inputs_hash=effectiveInputsHash({inputs:list});
  return {inputs:list,declarations:['buySignal','sellSignal'],effective_inputs_hash,
    effective_input_review:{source_hash:SUPPORTED,effective_inputs_hash,input_count:58,reviewed_by:'fixture-reviewer',reviewed_at:1700000000000}};
}
const JOB_SQL=`INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,result)
  VALUES($1,$2,$3,'generate',$4,$5,'{}',$6,'SUCCEEDED',$7,$7,$7,$8)`;
async function newWorld({names=['M1','M2']}={}){
  const user=await store.createUser({email:'pb-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=user.id;
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,$3,$3,'CONFIGURATION')",[bot,T0,MANIFEST.capital.equity]);
  const capital=await store.paperAccounts(bot);
  const funding_cutoff=(await db.query('SELECT COALESCE(max(id),0)::int AS cutoff FROM paper_funding WHERE user_id=$1',[bot])).rows[0].cutoff;
  const ids=Array.from({length:names.length},()=>randomUUID()).sort();
  const deps=Array.from({length:names.length},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,name:names[i],pine:id,dep:deps[i],inputs:MANIFEST.members[names[i]].inputs,analysis:analysisFor(MANIFEST.members[names[i]].inputs)}));
  for(const m of specs){
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[m.pine,user.id,bot,SUPPORTED,'Member fixture',SOURCE,JSON.stringify(m.analysis),T0]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,SUPPORTED,SOURCE,JSON.stringify(m.analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:SUPPORTED,analysis:m.analysis}));
  const selection=validateSelection(inspectSource(SOURCE),{...SPT_SIGNAL_MAPPING,buy:'buySignal',exit:'sellSignal'},[]);
  for(const m of specs){
    const artifact=assemble(SOURCE,selection,{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET}).integrated_pine;
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital,funding_cutoff,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection,market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:SUPPORTED,instruction_versions:{template:'fixture'},artifact_hash:hash(artifact)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n);
    await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'DRAFT',$7)",
      [m.dep,user.id,bot,m.pine,JSON.stringify(snapshot),snapshotHash,T0]);
    await db.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
    await db.query(JOB_SQL,[randomUUID(),user.id,bot,randomUUID(),hash('request-'+randomUUID()),m.pine,T0,JSON.stringify({integrated_pine:artifact,deployment_id:m.dep,artifact_status:'DRAFT'})]);
  }
  return {id:user.id,bot,specs,inputsByImport:Object.fromEntries(specs.map(m=>[m.pine,m.inputs]))};
}
const namesOf=world=>world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}));
const keyOf=()=>'pb-key-'+randomUUID().replaceAll('-','');
const inputOf=(world,over={})=>({owner_id:world.id,bot_id:world.bot,fixture:true,idempotency_key:keyOf(),member_deployments:namesOf(world),bridge_domains:structuredClone(V2_DOMAINS),
  dataset:{...DATASET2},budget:{candidates:30},seed:42,...over});
function serviceOn(handle){
  const own=new Store(handle);
  return new MultiPineFixtureService({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>NOW2,engineHash:ENGINE,supported_source_hash:SUPPORTED});
}
function executorOn(handle,{runEvaluator}){
  const own=new Store(handle);
  return new MultiPineFixtureExecutor({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>NOW2+1000,runEvaluator,engineHash:()=>ENGINE});
}
/** A strictly increasing package clock: record times then order the records the service chooses between (the newest of a kind wins). */
let tick=0;
/** The package service of a fixture-role handle. over replaces constructor options (hooks, engineHash, currentRules, clock). */
function packages(handle=fx,over={}){
  const own=new Store(handle);
  return new MultiPineFixturePackageService({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>NOW2+5000+(tick++),engineHash:()=>ENGINE,...over});
}
const GATE_WRAPPER=[
  'import json,os',
  'from robot_quant import mp_combined_job as job',
  'from robot_quant.spt_custom_evaluator import CustomSignalInputs',
  'INPUTS=json.loads(os.environ["MP_TEST_INPUTS"])',
  'def gate(source,snapshot):',
  '    rows=snapshot["membership"]',
  '    if len(rows)!=1: raise ValueError("MISSING_SOURCE_MEMBERSHIP")',
  '    return CustomSignalInputs.from_source_values(INPUTS[rows[0]["pine_import_id"]]),[]',
  'job.validate_custom_snapshot=gate',
  'job.main()'
].join('\n');
const realRunner=world=>createPythonRunner({args:['-c',GATE_WRAPPER],env:{MP_TEST_INPUTS:JSON.stringify(world.inputsByImport)}});
const eventsOf=async run_id=>(await db.query('SELECT seq,status,reason_code,result FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq',[run_id])).rows;
/** A new owner whose run finished SUCCEEDED on the REAL job over bars-v2 (about 10 to 20 s). */
async function realRun({names}={}){
  const world=await newWorld({names});
  const admitted=await service.admit(inputOf(world));
  assert.equal(admitted.ok,true,JSON.stringify(admitted));
  const out=await executorOn(fx,{runEvaluator:realRunner(world)}).execute({owner_id:world.id,run_id:admitted.run.run_id});
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'SUCCEEDED',reason_code:null});
  return {world,run:admitted.run,run_id:admitted.run.run_id,owner_id:world.id};
}
const PACKAGE_TABLES=['mp_package_blobs','mp_package_exports','mp_package_files','mp_package_status_events','mp_package_attempts','mp_package_validations','mp_package_compile_records',
  'mp_package_evidence_records','mp_package_clearances','mp_package_trace_records'];
const counts=async()=>Object.fromEntries(await Promise.all(PACKAGE_TABLES.map(async table=>[table,(await db.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
const rowsFor=async(table,exportId)=>(await db.query(`SELECT * FROM public.${table} WHERE export_id=$1`,[exportId])).rows;

/* ---- the package service, helpers ---- */

const once=fn=>{let promise;return()=>promise??=fn();};
const MINUTE=60000;
/** A clock value before every run created at NOW2: an earlier one-Pine run and a register event at this time count as earlier than the runs of this file. */
const EARLY=NOW2-10*MINUTE;
const holdoutOf=c=>({start_time:c.dataset.start_time+c.split.validation_end*MINUTE,end_time:c.dataset.start_time+(c.split.test_end-1)*MINUTE});
const searchedOf=c=>({start_time:c.dataset.start_time,end_time:c.dataset.start_time+(c.split.validation_end-1)*MINUTE});
const byStart=(a,b)=>a.start_time-b.start_time||a.end_time-b.end_time;
const SMALL_DATASET={start_time:START2,end_time:START2+3499*MINUTE,warmup_bars:MANIFEST.split.warmup};
const viewOf=async(owner_id,run_id,handle=fx)=>{const out=await getMultiRun(handle,{owner_id,run_id});assert.equal(out.ok,true,JSON.stringify(out));return out;};
const serviceAt=ms=>{const own=new Store(fx);return new MultiPineFixtureService({db:fx,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>ms,engineHash:ENGINE,supported_source_hash:SUPPORTED});};
/** A cheap multi run (DB only, no executor): admitted at the clock ms; terminal is null, 'SUCCEEDED' (holdout evaluated) or 'NO_VALID_CANDIDATE' (holdout not evaluated), with a minimal result. */
async function craft(world,{dataset=DATASET2,at=NOW2,terminal=null}={}){
  const out=await serviceAt(at).admit(inputOf(world,{dataset:{...dataset}}));
  assert.equal(out.ok,true,JSON.stringify(out));
  const run=out.run;
  if(terminal!==null){
    assert.equal((await appendRunEvent(fx,{owner_id:world.id,run_id:run.run_id,status:'RUNNING'})).ok,true);
    const result={run_id:run.run_id,contract_hash:run.contract_hash,owner_recommendation_ready:false,acceptance_blockers:['MULTI_PINE_REQUIRES_APP_3B'],holdout_evaluated:terminal==='SUCCEEDED',
      completion_reason:terminal==='SUCCEEDED'?'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE':'NO_VALID_TRAIN_VALIDATION_CANDIDATE'};
    assert.equal((await appendRunEvent(fx,{owner_id:world.id,run_id:run.run_id,status:terminal,result})).ok,true);
  }
  return run;
}
const ONE_PINE_SQL=`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,result)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$11)`;
/** An earlier one-Pine quant_jobs row of the world's owner (the read-only EARLIER mirror reads it). holdout: true, false or null (no result). */
async function onePine(world,{created_at=EARLY,market=MARKET,split,start_time=START2,source_hash=SUPPORTED,status='SUCCEEDED',holdout=true,owner=world.id}={}){
  const contract={version:'ql3a-research-job-v2',source_hash,...(market===null?{}:{snapshot:{market}}),split,dataset:{start_time}};
  const run_id='one-'+randomUUID();
  await db.query(ONE_PINE_SQL,[run_id,owner,world.bot,world.specs[0].dep,'key-'+run_id,hash('s'+run_id),hash('c'+run_id),JSON.stringify(contract),status,created_at,holdout===null?null:JSON.stringify({holdout_evaluated:holdout})]);
  return run_id;
}
const insertBoundary=(world,{bot=world.bot,start,owner=world.id})=>db.query('INSERT INTO quant_holdout_boundaries(owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [owner,bot,...Object.values(BOUNDARY_SCOPE),start,'fixture',T0]);
async function exposure(world,{start_ms,end_ms,at=EARLY,selection='sel-'+randomUUID()}){
  const out=await db.transaction(()=>appendExposures(db,{owner_id:world.id,broker:MARKET.broker,symbol:MARKET.symbol,timeframe:MARKET.timeframe,events:[{kind:'QR4_SELECTION',window:{start_ms,end_ms},selection_id:selection}],now:()=>at}),
    {isolation:'SERIALIZABLE'});
  assert.equal(out.ok,true,JSON.stringify(out));
}
/** Renames a table for the duration of fn (the lookup then finds the table absent), whatever fn does. */
async function absent(table,fn){
  await db.query(`ALTER TABLE public.${table} RENAME TO ${table}_gone`);
  try{return await fn();}finally{await db.query(`ALTER TABLE public.${table}_gone RENAME TO ${table}`);}
}
const SIDE_TABLES=['mp_research_runs','mp_research_run_events','mp_member_sets','mp_member_set_members','pine_deployments','pine_memberships','pine_sources','pine_source_revisions','paper_funding','quant_exposure_register','quant_jobs','audit'];
const digestOf=async table=>(await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const sideDigest=async()=>Object.fromEntries(await Promise.all(SIDE_TABLES.map(async table=>[table,await digestOf(table)])));
const packageDigest=async()=>Object.fromEntries(await Promise.all(PACKAGE_TABLES.map(async table=>[table,await digestOf(table)])));
const last=list=>list[list.length-1];
const manifestOf=async exportId=>JSON.parse((await db.query("SELECT convert_from(b.content,'UTF8') AS t FROM mp_package_files f JOIN mp_package_blobs b ON b.sha256=f.sha256 WHERE f.export_id=$1 AND f.path='quant-data/manifest.json'",[exportId])).rows[0].t);

/* ---- shared real runs (each takes its own owner; created on first use) ---- */

const R1=once(()=>realRun());
const R2=once(()=>realRun());
const R3=once(()=>realRun());
const R4=once(()=>realRun());
const R5=once(()=>realRun());
const R6=once(()=>realRun());
const R7=once(()=>realRun());
const R8=once(()=>realRun());
const R9=once(()=>realRun());
const R10=once(()=>realRun());
/**
 * A write the insert-only guards would refuse: the superuser of the throwaway cluster switches the user triggers of ONE table off, writes and switches each trigger back to the state it had (the
 * guards are ENABLE ALWAYS), all in one committed transaction. Every test that uses it restores what it changed, by the same call.
 */
const quietWrite=(table,sql,params=[])=>db.transaction(async()=>{
  const triggers=(await db.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal",[table])).rows;
  await db.query('ALTER TABLE '+table+' DISABLE TRIGGER USER');
  const out=await db.query(sql,params);
  for(const {tgname,tgenabled} of triggers)await db.query('ALTER TABLE '+table+({O:' ENABLE TRIGGER ',A:' ENABLE ALWAYS TRIGGER ',R:' ENABLE REPLICA TRIGGER ',D:' DISABLE TRIGGER '}[tgenabled])+tgname);
  return out;
},{isolation:'SERIALIZABLE'});

test('F17 end to end on a real run: build, attempt 1 fails with retryable codes, fixture records, attempt 2 passes to EXPORT_INTERNAL with READY false (F19 first half)',{timeout:600000},async()=>{
  const real=await R1(),svc=packages();
  const side=await sideDigest();
  const built=await svc.build({owner_id:real.owner_id,run_id:real.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));assert.equal(built.action,'BUILD');
  const id=built.export.export_id;
  assert.deepEqual([built.export.status,built.export.ready],['EXPORT_CANDIDATE',false]);
  // rows of the build: 1 export, 10 + 3 * 2 files, the seq 1 event with empty codes, 3 trace records, nothing else
  const c=await counts();
  assert.deepEqual([c.mp_package_exports,c.mp_package_files,c.mp_package_status_events,c.mp_package_trace_records],[1,16,1,3]);
  assert.deepEqual([c.mp_package_attempts,c.mp_package_validations,c.mp_package_compile_records,c.mp_package_evidence_records,c.mp_package_clearances],[0,0,0,0,0]);
  const exportRow=(await rowsFor('mp_package_exports',id))[0];
  assert.deepEqual([exportRow.owner_id,exportRow.bot_id,exportRow.run_id,exportRow.mode,exportRow.fixture,exportRow.pine_count],[real.owner_id,real.world.bot,real.run_id,'MULTI_PINE',true,2]);
  assert.equal(exportRow.gate_version,MULTI_PACKAGE_GATE_VERSION);assert.equal(exportRow.b0.pass,true);assert.equal(exportRow.b0.g7.state,'FAIL','G7 stays FAIL on the internal path');
  assert.deepEqual((await rowsFor('mp_package_status_events',id)).map(row=>[row.seq,row.status,row.codes,row.attempt_no]),[[1,'EXPORT_CANDIDATE',[],null]]);
  assert.deepEqual((await rowsFor('mp_package_files',id)).map(row=>row.path).sort(),[...multiPackageFiles(2)].sort());
  const trace=await rowsFor('mp_package_trace_records',id),filesByPath=Object.fromEntries((await rowsFor('mp_package_files',id)).map(row=>[row.path,row.sha256]));
  assert.deepEqual(trace.map(row=>row.path).sort(),Object.values(MP_TRACE_PATHS).sort());
  for(const row of trace){assert.equal(row.sha256,filesByPath[row.path]);assert.equal(row.producer_closure_hash,CLOSURE);assert.equal(row.run_engine_hash,ENGINE);assert.equal(row.method,'stored-holdout-decisions-v1');}
  assert.deepEqual(await sideDigest(),side,'a build writes nothing outside the package store');
  // attempt 1: no compile or evidence record yet: retryable missing-evidence codes only, the export stays an open candidate (F19)
  const a1=await svc.attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(a1.ok,true,JSON.stringify(a1));
  assert.deepEqual([a1.attempt_no,a1.pass,a1.status,a1.ready],[1,false,'EXPORT_CANDIDATE',false]);
  assert.ok(a1.codes.length>0&&a1.codes.every(code=>RETRYABLE_CODES.includes(code)),a1.codes.join());
  for(const code of ['BI_COMPILE_EVIDENCE_MISSING','BI_DATASET_ALIGNMENT_MISSING','BI_PARITY_EVIDENCE_MISSING','BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT'])assert.ok(a1.codes.includes(code),code);
  assert.deepEqual([...new Set(a1.diagnostics.filter(item=>item.code==='BI_COMPILE_EVIDENCE_MISSING').map(item=>item.ordinal))].sort(),[1,2],'every missing member is named');
  assert.deepEqual(a1.gates.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','FAIL'],['C3','PASS'],['C4','FAIL'],['Q','NOT_REACHED']]);
  let events=await rowsFor('mp_package_status_events',id);
  assert.deepEqual(events.map(row=>[row.seq,row.status,row.attempt_no]),[[1,'EXPORT_CANDIDATE',null],[2,'EXPORT_CANDIDATE',1]]);
  assert.deepEqual(events[1].codes,a1.codes);
  // the fixture records: a clean compile record per member file, the four evidence kinds per member, a clearance per blocker and member (RD-MP-41)
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:real.owner_id,export_id:id}),{ok:true});
  const after=await counts();
  assert.deepEqual([after.mp_package_compile_records,after.mp_package_evidence_records,after.mp_package_clearances],[2,8,4]);
  for(const row of await rowsFor('mp_package_compile_records',id))assert.deepEqual([row.operator_role,row.method,row.errors,row.mapping_check],['fixture','fixture-record',[],[]]);
  for(const row of await rowsFor('mp_package_evidence_records',id)){assert.equal(row.record.method,'fixture-record');assert.equal(row.record.operator_role,'fixture');assert.equal(row.record.scope.ordinal,row.ordinal);}
  // attempt 2 passes: EXPORT_INTERNAL, the RD-MP-37 validation record, READY false
  const a2=await svc.attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(a2.ok,true,JSON.stringify(a2));
  assert.deepEqual([a2.attempt_no,a2.pass,a2.status,a2.codes,a2.ready],[2,true,'EXPORT_INTERNAL',[],false]);
  assert.deepEqual(a2.gates.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','PASS'],['C3','PASS'],['C4','PASS'],['Q','PASS']]);
  events=await rowsFor('mp_package_status_events',id);
  assert.deepEqual(events.map(row=>[row.seq,row.status,row.codes,row.attempt_no]).slice(2),[[3,'EXPORT_INTERNAL',[],2]]);
  const validation=(await rowsFor('mp_package_validations',id))[0];
  assert.deepEqual([validation.fixture,validation.mode,validation.package_hash,validation.binding_hash],[true,'MULTI_PINE',exportRow.package_hash,exportRow.binding_hash]);
  assert.deepEqual(validation.gate_results.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','PASS'],['C3','PASS'],['C4','PASS']]);
  assert.match(validation.validator_engine_hash,/^[0-9a-f]{64}$/);
  const attempts=await rowsFor('mp_package_attempts',id);
  assert.deepEqual(attempts.map(row=>[row.attempt_no,row.pass]),[[1,false],[2,true]]);
  assert.equal(attempts[1].attempt_id,validation.attempt_id);
  // the export is terminal: no further attempt, and READ says FRESH with READY false
  assert.deepEqual(await svc.attempt({owner_id:real.owner_id,export_id:id}),{ok:false,code:PACKAGE_STORE_CODES.EXPORT_NOT_OPEN,status:'EXPORT_INTERNAL'});
  const read=await svc.read({owner_id:real.owner_id,export_id:id});
  assert.equal(read.ok,true,JSON.stringify(read));
  assert.deepEqual([read.status,read.ready,read.freshness.state,read.freshness.fresh],['EXPORT_INTERNAL',false,'FRESH',true]);
  assert.equal(read.export.owner_id,real.owner_id);
  assert.deepEqual(await sideDigest(),side,'the whole flow writes nothing outside the package store');
});

test('D1: the stored result keeps decimal-string pairs, the unmodified modules package it, and the package binds the stored result_hash itself',{timeout:600000},async()=>{
  const real=await R1(),read=await packages().read({owner_id:real.owner_id,run_id:real.run_id});
  assert.equal(read.ok,true,JSON.stringify(read));
  const event=(await db.query("SELECT result,result_hash FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1",[real.run_id])).rows[0];
  for(const name of ['atr_multiplier','rr']){assert.equal(typeof event.result.selected.parameters[name],'string');assert.equal(typeof event.result.combined_baseline.pair[name],'string');}
  const manifest=await manifestOf(read.export.export_id);
  assert.equal(manifest.evidence.result_sha256,event.result_hash,'D1: the manifest ties to the stored result_hash');
  assert.equal(manifest.binding.library_record_ref.result_sha256,event.result_hash);
  assert.deepEqual(manifest.binding.bridge_pair,event.result.selected.parameters,'the pair of the binding is the stored pair, string for string');
});

test('F27: a second build of the same run returns the same export and writes nothing',{timeout:600000},async()=>{
  const real=await R1(),before=await packageDigest();
  const existing=await packages().read({owner_id:real.owner_id,run_id:real.run_id});
  for(const svc of [packages(),packages(fx2)]){
    const again=await svc.build({owner_id:real.owner_id,run_id:real.run_id});
    assert.equal(again.ok,true,JSON.stringify(again));assert.equal(again.action,'LOAD');
    assert.equal(again.export.export_id,existing.export.export_id);
    assert.deepEqual([again.export.status,again.export.ready],['EXPORT_INTERNAL',false]);
  }
  assert.deepEqual(await packageDigest(),before);
});

test('F21 foreign owner: owner B gets NOT_FOUND for the run, the export and every record writer, with no row and no audit row',{timeout:600000},async()=>{
  const real=await R1(),other=await newWorld(),svc=packages();
  const exportId=(await svc.read({owner_id:real.owner_id,run_id:real.run_id})).export.export_id;
  const before=[await packageDigest(),await sideDigest()];
  const same=out=>{assert.equal(out.ok,false);assert.equal(out.code,'NOT_FOUND');assert.deepEqual(Object.keys(out).filter(key=>key!=='diagnostic').sort(),['code','ok']);};
  same(await svc.build({owner_id:other.id,run_id:real.run_id}));
  same(await svc.attempt({owner_id:other.id,export_id:exportId}));
  same(await svc.read({owner_id:other.id,export_id:exportId}));
  same(await svc.read({owner_id:other.id,run_id:real.run_id}));
  same(await svc.recordCompile({owner_id:other.id,export_id:exportId,ordinal:1}));
  same(await svc.recordEvidence({owner_id:other.id,export_id:exportId,ordinal:1,kind:'repaint'}));
  same(await svc.recordClearance({owner_id:other.id,export_id:exportId,blocker:'CUSTOM_REPAINT_EVIDENCE_REQUIRED',ordinal:1}));
  same(await svc.recordFixtureRecords({owner_id:other.id,export_id:exportId}));
  // an unknown and a malformed id answer the same
  same(await svc.build({owner_id:real.owner_id,run_id:randomUUID()}));same(await svc.build({owner_id:real.owner_id,run_id:'not-a-uuid'}));
  same(await svc.attempt({owner_id:real.owner_id,export_id:randomUUID()}));
  assert.deepEqual([await packageDigest(),await sideDigest()],before);
});

test('F10, F11, F24 package halves: a membership change, a new source analysis and a new reviewed input make the export STALE at read; the first code leads; nothing is written',{timeout:600000},async()=>{
  const real=await R1(),svc=packages(),id=(await svc.read({owner_id:real.owner_id,run_id:real.run_id})).export.export_id,before=await packageDigest();
  const state=async()=>{const out=await svc.read({owner_id:real.owner_id,export_id:id});assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.status,'EXPORT_INTERNAL','the stored status never changes');assert.equal(out.ready,false);return out.freshness;};
  assert.equal((await state()).state,'FRESH');
  const [m1,m2]=real.world.specs;
  // F10: member 2 is disconnected after the freeze
  await db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[m2.pine]);
  let fresh=await state();
  assert.deepEqual([fresh.state,fresh.fresh,fresh.code],['STALE',false,'BI_SOURCE_VERSION_STALE']);
  assert.ok(fresh.codes.includes('BI_MEMBERSHIP_CHANGED')&&fresh.codes.includes('BI_SELECTION_CHANGED'),fresh.codes.join());
  await db.query('UPDATE pine_memberships SET connected=true WHERE pine_import_id=$1',[m2.pine]);
  assert.equal((await state()).state,'FRESH');
  // F11: a new analysis of member 1 (a new source revision, version 2, the membership points at it)
  await db.query('INSERT INTO pine_source_revisions VALUES($1,2,$2,$3,$4,$5)',[m1.pine,SUPPORTED,SOURCE,JSON.stringify(m1.analysis),T0+1]);
  await db.query('UPDATE pine_memberships SET source_version=2 WHERE pine_import_id=$1',[m1.pine]);
  fresh=await state();
  assert.deepEqual([fresh.state,fresh.code],['STALE','BI_SOURCE_VERSION_STALE']);
  await db.query('UPDATE pine_memberships SET source_version=1 WHERE pine_import_id=$1',[m1.pine]);
  assert.equal((await state()).state,'FRESH');
  // F24: a new reviewed input for member 2 (its effective inputs hash changes); member 1 is untouched
  const changed={...m2.analysis,effective_inputs_hash:hash('new reviewed input')};
  await db.query('UPDATE pine_source_revisions SET analysis=$2 WHERE pine_import_id=$1 AND source_version=1',[m2.pine,JSON.stringify(changed)]);
  fresh=await state();
  assert.deepEqual([fresh.state,fresh.code],['STALE','BI_SELECTION_CHANGED']);
  await db.query('UPDATE pine_source_revisions SET analysis=$2 WHERE pine_import_id=$1 AND source_version=1',[m2.pine,JSON.stringify(m2.analysis)]);
  assert.equal((await state()).state,'FRESH');
  // auditor R6-2 NB2: a change the freshness tuple F does not read (the deployment state of member 1) is still a stale member set: the input lock of `current` is passed unreadable
  await db.query("UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",[m1.dep]);
  fresh=await state();
  assert.deepEqual([fresh.state,fresh.code],['STALE','BI_SELECTION_CHANGED']);
  await db.query("UPDATE pine_deployments SET state='DRAFT' WHERE deployment_id=$1",[m1.dep]);
  assert.equal((await state()).state,'FRESH');
  assert.deepEqual(await packageDigest(),before,'freshness is derived at read and never written');
});

test('RC-16 order: render, B0, render again when the limitation codes changed, then one transaction that reads again, re-runs B0 and only then inserts; F19 attempts 1 to 5 end EXPORT_REFUSED with BI_ATTEMPTS_EXHAUSTED',{timeout:600000},async()=>{
  const real=await R2(),steps=[];
  // the Bot's run rules differ from the current rules: B0 reports the informational limitation RULES_VERSION_DIFFERS, so the package is rendered a second time with it
  const svc=packages(fx,{currentRules:{...RULES,maximum_drawdown_percent:25},hooks:{step:name=>{steps.push(name);}}});
  const before=await counts();
  const built=await svc.build({owner_id:real.owner_id,run_id:real.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));assert.equal(built.action,'BUILD');
  assert.deepEqual(steps,['LOOKUPS','RENDER','B0','RENDER','TX_BEGIN','LOOKUPS','RENDER','B0','RENDER','INSERT']);
  const id=built.export.export_id,manifest=await manifestOf(id);
  assert.deepEqual(manifest.limitations.codes,['MP_TRACE_STEPS_NOT_REEVALUATED','RULES_VERSION_DIFFERS']);
  assert.deepEqual((await rowsFor('mp_package_exports',id))[0].b0.limitations,['RULES_VERSION_DIFFERS']);
  // F19: member 2 has no native parity record and no clearance for it: a retryable code naming member 2, five times, then exhausted
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:real.owner_id,export_id:id,skip:['2:native_parity']}),{ok:true});
  const codesOf=out=>[...out.codes].sort();
  let out;
  for(let n=1;n<=4;n++){
    out=await svc.attempt({owner_id:real.owner_id,export_id:id});
    assert.equal(out.ok,true,JSON.stringify(out));
    assert.deepEqual([out.attempt_no,out.pass,out.status],[n,false,'EXPORT_CANDIDATE']);
    assert.deepEqual(codesOf(out),['ACCEPTANCE_BLOCKERS_PRESENT','BI_PARITY_EVIDENCE_MISSING']);
    assert.deepEqual(out.diagnostics.map(item=>[item.code,item.ordinal]),[['BI_PARITY_EVIDENCE_MISSING',2]],'only member 2 is named');
  }
  out=await svc.attempt({owner_id:real.owner_id,export_id:id});
  assert.deepEqual([out.attempt_no,out.pass,out.status],[5,false,'EXPORT_REFUSED']);
  assert.deepEqual(codesOf(out),['ACCEPTANCE_BLOCKERS_PRESENT','BI_PARITY_EVIDENCE_MISSING'],'the attempt codes do not carry the exhaustion code');
  assert.deepEqual([...out.event_codes].sort(),['ACCEPTANCE_BLOCKERS_PRESENT','BI_ATTEMPTS_EXHAUSTED','BI_PARITY_EVIDENCE_MISSING'],'the fifth failure event does');
  const events=await rowsFor('mp_package_status_events',id);
  assert.deepEqual(events.map(row=>[row.seq,row.status,row.attempt_no]),[[1,'EXPORT_CANDIDATE',null],[2,'EXPORT_CANDIDATE',1],[3,'EXPORT_CANDIDATE',2],[4,'EXPORT_CANDIDATE',3],[5,'EXPORT_CANDIDATE',4],[6,'EXPORT_REFUSED',5]]);
  assert.equal((await rowsFor('mp_package_attempts',id)).length,5);assert.equal((await rowsFor('mp_package_validations',id)).length,0);
  // a sixth attempt, and every record writer, find the export closed
  assert.deepEqual(await svc.attempt({owner_id:real.owner_id,export_id:id}),{ok:false,code:PACKAGE_STORE_CODES.EXPORT_NOT_OPEN,status:'EXPORT_REFUSED'});
  const late=await svc.recordEvidence({owner_id:real.owner_id,export_id:id,ordinal:2,kind:'native_parity'});
  assert.equal(late.ok,false);assert.equal(late.code,PACKAGE_STORE_CODES.STORE_GUARD);assert.equal(late.diagnostic.guard,PACKAGE_STORE_GUARD_NAMES.evidence);
  const read=await svc.read({owner_id:real.owner_id,export_id:id});
  assert.deepEqual([read.status,read.ready,read.freshness.state],['EXPORT_REFUSED',false,'FRESH']);
});

test('RC-16: a B0 failure stops before the transaction and writes no row; a stale member set, a changed engine, an absent lookup table and every holdout rule end the build (R3)',{timeout:600000},async()=>{
  const real=await R3(),before=await counts(),steps=[];
  const svc=packages(fx,{hooks:{step:name=>{steps.push(name);}}});
  let out0;
  const refused=async(service,expectCodes)=>{
    const out=await service.build({owner_id:real.owner_id,run_id:real.run_id});
    assert.equal(out.ok,false,JSON.stringify(out));
    assert.deepEqual(await counts(),before,'no row');
    return out;
  };
  // RD-MP-48 N6: limitations that B0 reports for the final binding must be the ones that were rendered. The rules differ at the first B0 and agree again at the second one: refused, no row.
  const drift={...RULES,maximum_drawdown_percent:25};let renders=0;
  out0=await refused(packages(fx,{currentRules:drift,hooks:{step:name=>{if(name==='RENDER'&&++renders===2)drift.maximum_drawdown_percent=RULES.maximum_drawdown_percent;}}}));
  assert.deepEqual([out0.code,out0.stage],[PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,'LIMITATIONS']);assert.equal(renders,2);
  // the RUN_CHANGED check of the transaction: the status of the run differs from the one phase 1 read (staged by an admin write between the phases, restored at once), no row
  const flip=status=>quietWrite('public.mp_research_run_events','UPDATE public.mp_research_run_events SET status=$2 WHERE run_id=$1 AND seq=(SELECT max(seq) FROM public.mp_research_run_events WHERE run_id=$1)',[real.run_id,status]);
  try{
    out0=await refused(packages(fx,{hooks:{beforeTransaction:()=>flip('NO_VALID_CANDIDATE')}}));
    assert.deepEqual([out0.code,out0.stage],[PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,'RUN_CHANGED']);
  }finally{await flip('SUCCEEDED');}
  assert.equal((await viewOf(real.owner_id,real.run_id)).status,'SUCCEEDED');
  // BI_ENGINE_HASH_MISMATCH: an injected live hash that is not the run engine hash
  let out=await refused(packages(fx,{engineHash:()=>'a'.repeat(64),hooks:{step:name=>{steps.push(name);}}}));
  assert.deepEqual([out.code,out.stage],['BI_ENGINE_HASH_MISMATCH','ENGINE']);assert.deepEqual(steps,[],'the engine check comes before any lookup or render');
  // MP_MEMBER_SET_STALE: member 2 disconnected after the freeze (F10 build half)
  const m2=real.world.specs[1];
  await db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[m2.pine]);
  out=await refused(svc);
  assert.deepEqual([out.code,out.stage],[PACKAGE_STORE_CODES.BUILD_B0_FAILED,'B0']);assert.ok(out.codes.includes('MP_MEMBER_SET_STALE'),out.codes.join());
  assert.deepEqual(steps,['LOOKUPS','RENDER','B0'],'B0 failed: no second render, no transaction');
  await db.query('UPDATE pine_memberships SET connected=true WHERE pine_import_id=$1',[m2.pine]);
  // an absent exposure register, an absent boundary table and an absent quant_jobs table each fail closed
  out=await absent('quant_exposure_register',()=>refused(svc));
  assert.ok(out.codes.includes('BI_EXPOSURE_REGISTER_UNAVAILABLE'),out.codes.join());
  out=await absent('quant_holdout_boundaries',()=>refused(svc));
  assert.ok(out.codes.includes('HOLDOUT_INDEPENDENCE_NOT_CHECKED'),out.codes.join());
  out=await absent('quant_jobs',()=>refused(svc));
  assert.ok(out.codes.includes('HOLDOUT_INDEPENDENCE_NOT_CHECKED'),out.codes.join());
  // the four independence rules at once, from rows the owner really has: an earlier one-Pine run on the same bars and source, a registered boundary after the holdout start, and an exposure
  const view=await viewOf(real.owner_id,real.run_id),contract=view.run.contract,own=holdoutOf(contract);
  await onePine(real.world,{split:contract.split,start_time:contract.dataset.start_time});
  // a second earlier one-Pine run on the same source whose searched data (train and validation) cover the holdout of this run; it evaluated no holdout of its own
  await onePine(real.world,{split:{...contract.split,validation_end:contract.split.test_end,test_end:contract.split.test_end+1},start_time:contract.dataset.start_time,holdout:false});
  await insertBoundary(real.world,{start:own.end_time});
  await exposure(real.world,{start_ms:own.start_time,end_ms:own.end_time+MINUTE});
  out=await refused(svc);
  assert.deepEqual([out.code,out.stage],[PACKAGE_STORE_CODES.BUILD_B0_FAILED,'B0']);
  for(const code of ['HOLDOUT_WINDOW_REUSED','BI_HOLDOUT_OVERLAPS_SEARCHED_DATA','BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY','BI_HOLDOUT_EXPOSED_BY_SELECTION'])assert.ok(out.codes.includes(code),code+' in '+out.codes.join());
  assert.equal((await db.query('SELECT count(*)::int n FROM mp_package_exports WHERE owner_id=$1',[real.owner_id])).rows[0].n,0);
});

test('F27 race: two builds of one run decided by UNIQUE (owner_id, run_id) and SERIALIZABLE end with one export and the loser LOADs the winner; the newest record of a kind is the one the gates read (N3)',{timeout:600000},async()=>{
  const real=await R4();
  // both transactions read "no export" and reach the insert before either inserts
  let arrived=0;const waiting=[];
  const barrier=async()=>{arrived++;if(arrived>2)return;if(arrived===2){waiting.forEach(open=>open());return;}await new Promise(open=>waiting.push(open));};
  const one=packages(fx,{hooks:{beforeInsert:barrier}}),two=packages(fx2,{hooks:{beforeInsert:barrier}});
  const [a,b]=await Promise.all([one.build({owner_id:real.owner_id,run_id:real.run_id}),two.build({owner_id:real.owner_id,run_id:real.run_id})]);
  assert.equal(a.ok,true,JSON.stringify(a));assert.equal(b.ok,true,JSON.stringify(b));
  assert.deepEqual([a.action,b.action].sort(),['BUILD','LOAD'],'one builds, the other loads the winner');
  assert.equal(a.export.export_id,b.export.export_id);
  assert.ok(arrived>=2,'both transactions reached the insert');
  const owned=(await db.query('SELECT export_id FROM mp_package_exports WHERE owner_id=$1',[real.owner_id])).rows;
  assert.deepEqual(owned.map(row=>row.export_id),[a.export.export_id]);
  assert.deepEqual([(await rowsFor('mp_package_files',a.export.export_id)).length,(await rowsFor('mp_package_status_events',a.export.export_id)).length,(await rowsFor('mp_package_trace_records',a.export.export_id)).length],[16,1,3],'the loser wrote nothing');
  // N3: a wrong native-parity record of member 2 (the scope of member 1) is superseded by a newer correct one; the newest record of each kind is read, so the export passes
  const id=a.export.export_id,contract=(await viewOf(real.owner_id,real.run_id)).run.contract,svc=packages();
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:real.owner_id,export_id:id,skip:['2:native_parity']}),{ok:true});
  assert.equal((await svc.recordEvidence({owner_id:real.owner_id,export_id:id,ordinal:2,kind:'native_parity',record:fixtureEvidenceRecord(contract,contract.members[0],'native_parity')})).ok,true);
  assert.equal((await svc.recordEvidence({owner_id:real.owner_id,export_id:id,ordinal:2,kind:'native_parity'})).ok,true);
  assert.equal((await svc.recordClearance({owner_id:real.owner_id,export_id:id,blocker:'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED',ordinal:2})).ok,true);
  assert.equal((await rowsFor('mp_package_evidence_records',id)).filter(row=>row.ordinal===2&&row.kind==='native_parity').length,2);
  const out=await svc.attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual([out.pass,out.status,out.codes],[true,'EXPORT_INTERNAL',[]]);
});

test('F25 evidence swap: member 2 references member 1 evidence: MP_MEMBER_PARITY_SCOPE_MISMATCH is non-retryable and ends the export EXPORT_REFUSED at once, with exactly the attempt codes',{timeout:600000},async()=>{
  const real=await R5(),svc=packages(),built=await svc.build({owner_id:real.owner_id,run_id:real.run_id}),id=built.export.export_id,contract=(await viewOf(real.owner_id,real.run_id)).run.contract;
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:real.owner_id,export_id:id,skip:['2:native_parity']}),{ok:true});
  assert.equal((await svc.recordEvidence({owner_id:real.owner_id,export_id:id,ordinal:2,kind:'native_parity',record:fixtureEvidenceRecord(contract,contract.members[0],'native_parity')})).ok,true);
  assert.equal((await svc.recordClearance({owner_id:real.owner_id,export_id:id,blocker:'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED',ordinal:2})).ok,true);
  const out=await svc.attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual([out.pass,out.status],[false,'EXPORT_REFUSED']);
  assert.ok(out.codes.includes('MP_MEMBER_PARITY_SCOPE_MISMATCH'),out.codes.join());
  assert.deepEqual(out.diagnostics.filter(item=>item.code==='MP_MEMBER_PARITY_SCOPE_MISMATCH').map(item=>item.ordinal),[2]);
  assert.ok(!out.codes.includes('BI_ATTEMPTS_EXHAUSTED')&&!out.event_codes.includes('BI_ATTEMPTS_EXHAUSTED'));
  assert.deepEqual([...out.event_codes].sort(),[...out.codes].sort(),'a hard failure carries exactly the attempt codes');
  assert.equal((await rowsFor('mp_package_attempts',id)).length,1);
  assert.deepEqual(await svc.attempt({owner_id:real.owner_id,export_id:id}),{ok:false,code:PACKAGE_STORE_CODES.EXPORT_NOT_OPEN,status:'EXPORT_REFUSED'});
});

test('producer drift: a producer closure that differs from the one the trace records name makes C3 report the trace as not reproduced (BI_RESULT_MISMATCH, non-retryable) and ends the export EXPORT_REFUSED',{timeout:600000},async()=>{
  const real=await R6(),built=await packages().build({owner_id:real.owner_id,run_id:real.run_id}),id=built.export.export_id;
  assert.equal((await rowsFor('mp_package_trace_records',id))[0].producer_closure_hash,CLOSURE);
  assert.deepEqual(await packages().recordFixtureRecords({owner_id:real.owner_id,export_id:id}),{ok:true});
  const drifted=packages(fx,{producerClosureHash:()=>'c'.repeat(64)});
  const out=await drifted.attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual([out.pass,out.status],[false,'EXPORT_REFUSED']);
  assert.deepEqual(out.codes,['BI_RESULT_MISMATCH'],'the closure hash is a producer field, not a step or holdout field');
  assert.deepEqual(out.gates.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','PASS'],['C3','FAIL'],['C4','NOT_REACHED'],['Q','NOT_REACHED']]);
  assert.deepEqual((await rowsFor('mp_package_validations',id)).length,0);
});

test('limits parity: the server hard limits equal the ranges the risk policy validator and the server enforce',async()=>{
  assert.deepEqual(serverHardLimits(),Object.fromEntries(Object.entries(HARD_RANGES).map(([name,[min,max]])=>[name,{min,max}])));
  for(const file of ['../../src/postgres/risk-policy-validation.js','../../src/server.js']){
    const body=await fs.readFile(new URL(file,import.meta.url),'utf8');
    for(const [name,[min,max]] of Object.entries(HARD_RANGES)){
      const match=new RegExp(name+'\\s*:\\s*\\[\\s*([0-9.e+]+)\\s*,\\s*([0-9.e+]+)\\s*\\]').exec(body);
      assert.ok(match,file+' '+name);
      assert.deepEqual([Number(match[1]),Number(match[2])],[Number(min),Number(max)],file+' '+name);
    }
  }
  const limits=serverHardLimits();limits.maxRiskPercent.max='1';
  assert.equal(serverHardLimits().maxRiskPercent.max,'100','a caller cannot change the limits');
});

test('N1 memberIsolation: only the Bridge evidence row of the member snapshot that verifies counts; native_alerts_isolated true gives native_payloads 0; anything else is unproven',()=>{
  const member={ordinal:2,deployment_id:'d2',deployment_snapshot_hash:hash('snapshot 2')};
  const evidence={native_alerts_isolated:true,unrelated_payloads:0};
  const row=(over={})=>({deployment_id:'d2',snapshot_hash:hash('snapshot 2'),evidence,evidence_hash:hash(canonical(evidence)),...over});
  const proven={ordinal:2,routes_disabled:true,unrelated_payloads:0,native_payloads:0};
  assert.deepEqual(memberIsolation(member,[row()]),proven);
  const unproven={ordinal:2,routes_disabled:false,unrelated_payloads:-1,native_payloads:-1};
  for(const rows of [[],null,undefined,[row({snapshot_hash:hash('another snapshot')})],[row({evidence_hash:hash('not the digest')})],[row({deployment_id:'d1'})],[row({evidence:null})],[null,7]])
    assert.deepEqual(memberIsolation(member,rows),unproven,JSON.stringify(rows));
  // the matching row is picked wherever it stands; a row that does not match is never read
  assert.deepEqual(memberIsolation(member,[row({snapshot_hash:hash('another snapshot'),evidence:{native_alerts_isolated:false},evidence_hash:hash(canonical({native_alerts_isolated:false}))}),row(),row({evidence_hash:hash('x')})]),proven);
  // a verified row without the proof: not isolated, a count that is not an integer is -1
  const open={native_alerts_isolated:false,unrelated_payloads:3};
  assert.deepEqual(memberIsolation(member,[row({evidence:open,evidence_hash:hash(canonical(open))})]),{ordinal:2,routes_disabled:false,unrelated_payloads:3,native_payloads:-1});
  const odd={native_alerts_isolated:true,unrelated_payloads:'0'};
  assert.deepEqual(memberIsolation(member,[row({evidence:odd,evidence_hash:hash(canonical(odd))})]),{ordinal:2,routes_disabled:true,unrelated_payloads:-1,native_payloads:0});
});

test('attempt on live state (R7): a live engine that is not the run engine writes no attempt (N3); an evidence record that does not verify is not read; a member Bridge evidence row that is not its snapshot leaves its isolation unproven (N1)',{timeout:600000},async()=>{
  const real=await R7(),svc=packages(),built=await svc.build({owner_id:real.owner_id,run_id:real.run_id}),m2=real.world.specs[1];
  assert.equal(built.ok,true,JSON.stringify(built));
  const id=built.export.export_id;
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:real.owner_id,export_id:id}),{ok:true});
  const before=await counts();
  const wrong=await packages(fx,{engineHash:()=>'a'.repeat(64)}).attempt({owner_id:real.owner_id,export_id:id});
  assert.deepEqual([wrong.ok,wrong.code,wrong.stage],[false,'BI_ENGINE_HASH_MISMATCH','ENGINE']);
  assert.deepEqual(await counts(),before,'no attempt row and no event');
  // the repaint record of member 1 is changed after it was written, so its evidence_hash no longer verifies: it is skipped and the kind is missing (retryable), the export stays open
  const target=(await rowsFor('mp_package_evidence_records',id)).find(row=>row.ordinal===1&&row.kind==='repaint');
  assert.ok(target);
  await quietWrite('public.mp_package_evidence_records',"UPDATE public.mp_package_evidence_records SET record=record||'{\"tampered\":true}'::jsonb WHERE evidence_id=$1",[target.evidence_id]);
  try{
    const out=await svc.attempt({owner_id:real.owner_id,export_id:id});
    assert.equal(out.ok,true,JSON.stringify(out));
    assert.deepEqual([out.pass,out.status],[false,'EXPORT_CANDIDATE']);
    assert.ok(out.codes.includes('BI_REPAINT_EVIDENCE_MISSING'),out.codes.join());
    assert.ok(out.codes.every(code=>RETRYABLE_CODES.includes(code)),out.codes.join());
  }finally{await quietWrite('public.mp_package_evidence_records','UPDATE public.mp_package_evidence_records SET record=$2::jsonb WHERE evidence_id=$1',[target.evidence_id,JSON.stringify(target.record)]);}
  // member 2: its Bridge evidence row names another snapshot, so it is not the evidence of this member snapshot
  await quietWrite('public.pine_bridge_evidence','UPDATE public.pine_bridge_evidence SET snapshot_hash=$2 WHERE deployment_id=$1',[m2.dep,'f'.repeat(64)]);
  let out;
  try{
    out=await svc.attempt({owner_id:real.owner_id,export_id:id});
    assert.equal(out.ok,true,JSON.stringify(out));
    assert.equal(out.pass,false);
    assert.deepEqual(out.diagnostics.filter(item=>item.code==='BI_NATIVE_ALERT_ISOLATION_UNPROVEN').map(item=>item.ordinal),[2],out.codes.join());
  }finally{await quietWrite('public.pine_bridge_evidence','UPDATE public.pine_bridge_evidence SET snapshot_hash=(SELECT snapshot_hash FROM public.pine_deployments WHERE deployment_id=$1) WHERE deployment_id=$1',[m2.dep]);}
  assert.equal((await db.query('SELECT count(*)::int n FROM mp_package_attempts WHERE export_id=$1',[id])).rows[0].n,2,'the engine refusal wrote no attempt');
});

test('attempt on live state (R8): Bridge bounds narrower than the chosen pair end the export with BI_BRIDGE_PAIR_OUT_OF_BOUNDS on readable state (RD-MP-48 F2 limitation: the default bounds are the frozen domains)',{timeout:600000},async()=>{
  const real=await R8(),built=await packages().build({owner_id:real.owner_id,run_id:real.run_id}),id=built.export.export_id;
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.deepEqual(await packages().recordFixtureRecords({owner_id:real.owner_id,export_id:id}),{ok:true});
  const contract=(await viewOf(real.owner_id,real.run_id)).run.contract,pair=(await db.query('SELECT result FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[real.run_id])).rows[0].result.selected.parameters;
  assert.deepEqual(bridgeBoundsOf(contract).atr_multiplier,{min:contract.bridge_domains.atr_multiplier.min,max:contract.bridge_domains.atr_multiplier.max},'the default bounds are the contract domains');
  const narrow={atr_multiplier:{min:String(Number(pair.atr_multiplier)+0.5),max:'3'},rr:bridgeBoundsOf(contract).rr};
  const out=await packages(fx,{bridgeBounds:narrow}).attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual([out.pass,out.status,out.codes],[false,'EXPORT_REFUSED',['BI_BRIDGE_PAIR_OUT_OF_BOUNDS']]);
  assert.deepEqual(out.gates.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','PASS'],['C3','PASS'],['C4','FAIL'],['Q','NOT_REACHED']]);
});

test('attempt on live state (R9): hard limits tighter than the risk profile end the export with BI_RISK_RELAXATION; the newest compile record of a member is the one read (N9)',{timeout:600000},async()=>{
  const real=await R9(),svc=packages(),built=await svc.build({owner_id:real.owner_id,run_id:real.run_id}),id=built.export.export_id;
  assert.equal(built.ok,true,JSON.stringify(built));
  // an older compile record of member 1 with an error, then the clean records: the newest per ordinal is read, so no compile error is reported
  const file=(await db.query("SELECT sha256 FROM mp_package_files WHERE export_id=$1 AND path='members/1/indicator.pine'",[id])).rows[0];
  const older=await svc.recordCompile({owner_id:real.owner_id,export_id:id,ordinal:1,record:{...fixtureCompileRecord({indicatorSha256:file.sha256}),errors:['SYNTAX_ERROR']}});
  assert.equal(older.ok,true,JSON.stringify(older));
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:real.owner_id,export_id:id}),{ok:true});
  assert.equal((await rowsFor('mp_package_compile_records',id)).filter(row=>row.ordinal===1).length,2);
  const tight={...serverHardLimits(),maxRiskPercent:{min:'0.01',max:'50'}};
  const out=await packages(fx,{hardLimits:tight}).attempt({owner_id:real.owner_id,export_id:id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual([out.pass,out.status,out.codes],[false,'EXPORT_REFUSED',['BI_RISK_RELAXATION']],'the policy limit 100 is above 50; the older compile error is not read');
  assert.deepEqual(out.gates.map(item=>[item.gate,item.state]),[['C1','PASS'],['C2','PASS'],['C3','FAIL'],['C4','NOT_REACHED'],['Q','NOT_REACHED']]);
});

test('read: the stored integrity check refuses a changed package hash or binding hash; read runs in one READ ONLY REPEATABLE READ transaction (N7) and writes nothing',{timeout:600000},async()=>{
  // an export without attempt rows (an attempt row references the package hash): a build alone on its own run
  const real=await R10(),svc=packages(),built=await svc.build({owner_id:real.owner_id,run_id:real.run_id}),id=built.export.export_id,before=await packageDigest();
  assert.equal(built.ok,true,JSON.stringify(built));
  const refusedWith=async check=>{
    const out=await svc.read({owner_id:real.owner_id,export_id:id});
    assert.deepEqual([out.ok,out.code,out.diagnostic.check],[false,PACKAGE_STORE_CODES.STORED_INTEGRITY,check]);
  };
  // the file bytes and the run columns of the export row are tied by CHECK constraints, so the stored hashes of the integrity gate are staged: a changed package hash and a changed binding hash
  const exportRow=(await db.query('SELECT package_hash,binding_hash FROM mp_package_exports WHERE export_id=$1',[id])).rows[0];
  await quietWrite('public.mp_package_exports','UPDATE public.mp_package_exports SET package_hash=$2 WHERE export_id=$1',[id,'0'.repeat(64)]);
  try{await refusedWith('package_hash');}finally{await quietWrite('public.mp_package_exports','UPDATE public.mp_package_exports SET package_hash=$2 WHERE export_id=$1',[id,exportRow.package_hash]);}
  await quietWrite('public.mp_package_exports','UPDATE public.mp_package_exports SET binding_hash=$2 WHERE export_id=$1',[id,'0'.repeat(64)]);
  try{await refusedWith('binding_hash');}finally{await quietWrite('public.mp_package_exports','UPDATE public.mp_package_exports SET binding_hash=$2 WHERE export_id=$1',[id,exportRow.binding_hash]);}
  assert.equal((await svc.read({owner_id:real.owner_id,export_id:id})).ok,true,'restored');
  assert.deepEqual(await packageDigest(),before);
  // N7: the transaction the live state is read in
  const own=new Store(fx),base=storeBotState({store:own,defaultRisk:POLICY});let seen=null;
  const probe=new MultiPineFixturePackageService({db:fx,store:own,clock:()=>NOW2,engineHash:()=>ENGINE,
    readBotState:async input=>{seen=(await fx.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only")).rows[0];return base(input);}});
  const out=await probe.read({owner_id:real.owner_id,export_id:id});
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual({...seen},{isolation:'repeatable read',read_only:'on'});
  assert.deepEqual(await packageDigest(),before);
});

test('F20 (SYN: a hand-built minimal NO_VALID_CANDIDATE result, no executor): a run without a passing candidate builds no package, and the database export guard refuses it as well',{timeout:600000},async()=>{
  const world=await newWorld(),run=await craft(world,{terminal:'NO_VALID_CANDIDATE'});
  const before=await counts();
  const out=await packages().build({owner_id:world.id,run_id:run.run_id});
  assert.deepEqual([out.ok,out.code,out.stage],[false,PACKAGE_STORE_CODES.BUILD_B0_FAILED,'B0']);
  assert.ok(out.codes.includes('BI_RUN_NOT_QUALIFIABLE'),out.codes.join());
  assert.deepEqual(await counts(),before);
  // the guard: a hand-written export row for that run is refused by mp_package_exports_guard
  const caught=await fx.transaction(async()=>{
    try{
      await fx.query(`INSERT INTO public.mp_package_exports(export_id,owner_id,bot_id,run_id,mode,pine_count,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
        VALUES($1,$2,$3,$4,'MULTI_PINE',2,true,'x','{}',$5,$6,$6,'{}',1,'2026-01-01T00:00:00Z')`,[randomUUID(),world.id,world.bot,run.run_id,
        JSON.stringify({owner_id:world.id,bot_id:world.bot,run_id:run.run_id,mode:'MULTI_PINE',pine_count:2,fixture:true,created_at:'2026-01-01T00:00:00Z'}),'b'.repeat(64)]);
      return null;
    }catch(error){return error;}
  },{isolation:'SERIALIZABLE'});
  assert.deepEqual([caught?.code,caught?.constraint],['QR004',PACKAGE_STORE_GUARD_NAMES.exports]);
  assert.deepEqual(await counts(),before);
});

/* ---- RD-MP-40: the holdout independence reader, on cheap crafted runs (no executor) ---- */

test('lookups: earlier multi runs of the same owner only; a holdout counts when it was evaluated, searched data counts for the same source in any state after admission; ties break by run_id',{timeout:120000},async()=>{
  const world=await newWorld(),other=await newWorld();
  const e1=await craft(world,{at:NOW2-3000,terminal:'SUCCEEDED'});
  const e2=await craft(world,{at:NOW2-2000,dataset:SMALL_DATASET,terminal:'NO_VALID_CANDIDATE'});
  const e3=await craft(world,{at:NOW2-1000});
  const later=await craft(world,{at:NOW2+1000,terminal:'SUCCEEDED'});
  await craft(other,{at:NOW2-3000,terminal:'SUCCEEDED'});
  const subject=await craft(world,{at:NOW2});
  const ties=[await craft(world,{at:NOW2,terminal:'SUCCEEDED'}),await craft(world,{at:NOW2,terminal:'SUCCEEDED'})];
  const subjectView=await viewOf(world.id,subject.run_id),contract=subjectView.run.contract;
  const tieEarlier=ties.filter(item=>item.run_id<subject.run_id);
  const out=await readMultiHoldoutLookups(fx,subjectView);
  assert.equal(out.ok,true,JSON.stringify(out.unavailable));assert.deepEqual(out.unavailable,[]);
  const smallContract=(await viewOf(world.id,e2.run_id)).run.contract;
  assert.deepEqual(out.lookups.earlier_holdouts.sort(byStart),[holdoutOf(contract),...tieEarlier.map(()=>holdoutOf(contract))].sort(byStart),'the evaluated holdouts of the owner before this run');
  assert.deepEqual(out.lookups.earlier_searched.sort(byStart),[searchedOf(contract),searchedOf(smallContract),searchedOf(contract),...tieEarlier.map(()=>searchedOf(contract))].sort(byStart),
    'every earlier run of the owner on the same source, whatever its state, and not the run itself, a later run or another owner');
  assert.notDeepEqual(searchedOf(smallContract),searchedOf(contract));
  assert.deepEqual([out.lookups.registered_boundary,out.lookups.exposure_register],[{exists:false},[]]);
  void e1;void e3;void later;
});

test('lookups: earlier one-Pine runs (the EARLIER mirror and the searched mirror) of the owner on this market; other markets, later runs and other owners do not count; unreadable rows fail closed',{timeout:120000},async()=>{
  const world=await newWorld(),other=await newWorld(),subject=await craft(world,{at:NOW2});
  const split=(validation_end,test_end)=>({warmup:1250,train_end:validation_end-100,validation_end,test_end});
  const row=(k,over={})=>({split:split(5000+k*10,5900+k*10),start_time:START2+k*MINUTE*1000,...over});
  const rows={
    p1:row(1),                                                      // counts: holdout evaluated, same market, same source
    p2:row(2,{market:{broker:'binance-global',symbol:'ETHUSDT',timeframe:'1'}}),   // another market
    p3:row(3,{market:null}),                                   // no market recorded: counts (cannot be shown to differ)
    p4:row(4,{created_at:NOW2+1000}),                               // later than this run
    p5:row(5,{owner:other.id}),                                     // another owner
    p6:row(6,{status:'QUEUED',holdout:false}),                      // no holdout, same source: searched only
    p7:row(7,{source_hash:hash('another source')}),                 // another source: holdout only
    p8:row(8,{holdout:null})                                        // no result at all: searched only
  };
  for(const [name,over] of Object.entries(rows))await onePine(name==='p5'?other:world,over);
  const win=(item,kind)=>{const c={dataset:{start_time:item.start_time},split:item.split};return kind==='holdout'?holdoutOf(c):searchedOf(c);};
  const out=await readMultiHoldoutLookups(fx,await viewOf(world.id,subject.run_id));
  assert.equal(out.ok,true,JSON.stringify(out.unavailable));
  assert.deepEqual(out.lookups.earlier_holdouts.sort(byStart),[rows.p1,rows.p3,rows.p7].map(item=>win(item,'holdout')).sort(byStart));
  assert.deepEqual(out.lookups.earlier_searched.sort(byStart),[rows.p1,rows.p3,rows.p6,rows.p8].map(item=>win(item,'searched')).sort(byStart));
  // an unreadable earlier row (a holdout run whose split is missing) fails the whole part closed
  const third=await newWorld(),subject3=await craft(third,{at:NOW2});
  await onePine(third,{split:null,start_time:START2});
  const bad=await readMultiHoldoutLookups(fx,await viewOf(third.id,subject3.run_id));
  assert.deepEqual([bad.ok,bad.lookups.earlier_holdouts,bad.lookups.earlier_searched,bad.unavailable],[false,null,null,['HOLDOUT_INDEPENDENCE_NOT_CHECKED']]);
  assert.deepEqual([bad.lookups.registered_boundary,bad.lookups.exposure_register],[{exists:false},[]],'the other parts are still read');
});

test('lookups: the registered boundary is the strictest boundary of the owner for this Bot; the exposure register gives the owner and market entries in the package shape; an absent table fails closed',{timeout:120000},async()=>{
  const world=await newWorld(),other=await newWorld(),sibling=await newWorld(),subject=await craft(world,{at:NOW2}),view=await viewOf(world.id,subject.run_id);
  assert.deepEqual((await readMultiHoldoutLookups(fx,view)).lookups.registered_boundary,{exists:false});
  await insertBoundary(sibling,{owner:world.id,bot:sibling.bot,start:START2+100*MINUTE});          // a sibling Bot of the owner alone does not make this Bot registered
  assert.deepEqual((await readMultiHoldoutLookups(fx,view)).lookups.registered_boundary,{exists:false},'the outer row needs this Bot\'s own registration');
  await insertBoundary(world,{start:START2+500*MINUTE});
  assert.deepEqual((await readMultiHoldoutLookups(fx,view)).lookups.registered_boundary,{exists:true,start_time:START2+100*MINUTE},'the minimum of the owner\'s boundaries');
  await insertBoundary(other,{start:START2+1*MINUTE});
  assert.deepEqual((await readMultiHoldoutLookups(fx,view)).lookups.registered_boundary,{exists:true,start_time:START2+100*MINUTE},'another owner is ignored');
  await exposure(world,{start_ms:START2+10*MINUTE,end_ms:START2+20*MINUTE,at:EARLY,selection:'sel-own'});
  await exposure(other,{start_ms:START2+10*MINUTE,end_ms:START2+20*MINUTE,at:EARLY,selection:'sel-other'});
  const out=await readMultiHoldoutLookups(fx,view);
  assert.deepEqual(out.lookups.exposure_register,[{owner_id:world.id,market:MARKET,window:{start_time:START2+10*MINUTE,end_time:START2+19*MINUTE},at_utc:new Date(EARLY).toISOString(),selection_id:'sel-own'}]);
  assert.deepEqual(out.unavailable,[]);
  for(const [table,key,code] of [['quant_exposure_register','exposure_register','BI_EXPOSURE_REGISTER_UNAVAILABLE'],['quant_holdout_boundaries','registered_boundary','HOLDOUT_INDEPENDENCE_NOT_CHECKED'],
    ['quant_jobs','earlier_holdouts','HOLDOUT_INDEPENDENCE_NOT_CHECKED']]) {
    const gone=await absent(table,()=>readMultiHoldoutLookups(fx,view));
    assert.deepEqual([gone.ok,gone.lookups[key],gone.unavailable],[false,null,[code]],table);
  }
});

test('lookups: more runs than maxPages pages of the owner fail closed (5,000 runs by default); a list within the bound is read to the end',{timeout:120000},async()=>{
  assert.deepEqual([HOLDOUT_MAX_PAGES,500*HOLDOUT_MAX_PAGES],[10,5000]);
  const world=await newWorld();
  await craft(world,{at:NOW2-300});await craft(world,{at:NOW2-200});await craft(world,{at:NOW2-100});
  const subject=await craft(world,{at:NOW2}),view=await viewOf(world.id,subject.run_id);
  const tight=await readMultiHoldoutLookups(fx,view,{pageSize:1,maxPages:3});
  assert.deepEqual([tight.ok,tight.lookups.earlier_holdouts,tight.lookups.earlier_searched,tight.unavailable],[false,null,null,['HOLDOUT_INDEPENDENCE_NOT_CHECKED']],'four runs do not fit three pages of one');
  const wide=await readMultiHoldoutLookups(fx,view,{pageSize:1,maxPages:4});
  assert.equal(wide.ok,true);assert.equal(wide.lookups.earlier_searched.length,3);
});

test('J3: a second run of a packaged owner on the same bars sees the first run as an earlier holdout and earlier searched data, which is why every packaged run has its own owner and Bot',{timeout:600000},async()=>{
  const real=await R1(),second=await craft(real.world,{at:NOW2+5000});
  const first=(await viewOf(real.owner_id,real.run_id)).run.contract,out=await readMultiHoldoutLookups(fx,await viewOf(real.owner_id,second.run_id));
  assert.deepEqual(out.lookups.earlier_holdouts,[holdoutOf(first)]);assert.deepEqual(out.lookups.earlier_searched,[searchedOf(first)]);
  const exports=await Promise.all([R1(),R2(),R3(),R4(),R5(),R6()].map(async promise=>{const item=await promise;return {owner:item.owner_id,bot:item.world.bot};}));
  assert.equal(new Set(exports.map(item=>item.owner)).size,6,'one owner per packaged run');
  for(const item of exports)assert.equal(item.owner,item.bot,'the owner is the Bot of its own packaged run');
  for(const row of (await db.query('SELECT owner_id,bot_id,binding FROM mp_package_exports')).rows){assert.equal(row.binding.owner_id,row.owner_id);assert.equal(row.binding.bot_id,row.bot_id);}
});

/* ---- parity of the two mirrored queries with their originals ---- */

const squash=sql=>sql.replace(/public\./g,'').replace(/\s+/g,' ').trim();
const constantOf=(source,name)=>{const match=new RegExp('const '+name+'=`([\\s\\S]*?)`;').exec(source);assert.ok(match,name);return match[1];};

test('parity: the boundary query is the text of EFFECTIVE_BOUNDARY_SQL of the preflight reader (the schema name apart) and answers the same on the same rows; the scope is PREFLIGHT_HOLDOUT_SCOPE',{timeout:120000},async()=>{
  const original=constantOf(await fs.readFile(new URL('../../src/postgres/quant-preflight.js',import.meta.url),'utf8'),'EFFECTIVE_BOUNDARY_SQL');
  assert.equal(squash(EFFECTIVE_BOUNDARY_SQL),squash(original));
  assert.deepEqual({...BOUNDARY_SCOPE},{...PREFLIGHT_HOLDOUT_SCOPE});
  assert.match(EFFECTIVE_BOUNDARY_SQL,/public\.quant_holdout_boundaries sibling/);
  const a=await newWorld(),b=await newWorld(),c=await newWorld(),d=await newWorld();
  await insertBoundary(a,{start:START2+300*MINUTE});
  await insertBoundary(b,{start:START2+200*MINUTE});await insertBoundary(b,{owner:b.id,bot:c.bot,start:START2+100*MINUTE});   // b has a sibling Bot with an earlier boundary
  for(const [owner,bot] of [[a.id,a.bot],[b.id,b.bot],[b.id,c.bot],[c.id,c.bot],[d.id,d.bot],[a.id,b.bot]]){
    const params=[owner,bot,...Object.values(PREFLIGHT_HOLDOUT_SCOPE)];
    const mine=(await db.query(EFFECTIVE_BOUNDARY_SQL,params)).rows.map(row=>[row.holdout_start_time]);
    const theirs=(await db.query(original,params)).rows.map(row=>[row.holdout_start_time]);
    assert.deepEqual(mine,theirs,owner+' '+bot);
  }
  assert.deepEqual((await db.query(EFFECTIVE_BOUNDARY_SQL,[b.id,b.bot,...Object.values(BOUNDARY_SCOPE)])).rows.map(row=>Number(row.holdout_start_time)),[START2+100*MINUTE],'the sibling minimum wins');
});

test('parity: the earlier-holdout query is the text of EARLIER of the one-Pine library reader (the schema name apart) and answers the same on the same rows',{timeout:120000},async()=>{
  const original=constantOf(await fs.readFile(new URL('../../src/postgres/quant-library.js',import.meta.url),'utf8'),'EARLIER');
  assert.equal(squash(EARLIER_ONE_PINE_SQL),squash(original));
  const world=await newWorld(),other=await newWorld();
  const split={warmup:1250,train_end:4100,validation_end:5050,test_end:6000};
  const ids=[await onePine(world,{split,created_at:EARLY}),await onePine(world,{split,created_at:EARLY+5,holdout:false}),await onePine(world,{split,created_at:EARLY+10,market:null}),
    await onePine(world,{split,created_at:NOW2+1}),await onePine(other,{split,created_at:EARLY}),await onePine(world,{split,created_at:EARLY+20,holdout:null})];
  for(const [owner,run,created] of [[world.id,'nothing',NOW2],[world.id,ids[2],EARLY+10],[other.id,'nothing',NOW2],[world.id,'nothing',EARLY]]){
    const mine=(await db.query(EARLIER_ONE_PINE_SQL,[owner,run,created])).rows,theirs=(await db.query(original,[owner,run,created])).rows;
    assert.deepEqual(mine,theirs,owner+' '+run);
  }
  assert.deepEqual((await db.query(EARLIER_ONE_PINE_SQL,[world.id,'nothing',NOW2])).rows.map(row=>row.run_id),[ids[0],ids[2]],'holdout evaluated, created before the subject');
});

/* ---- unit-level cases ---- */

test('mapPackageStoreFailure maps a QR004 guard by its constraint name and owns nothing else',()=>{
  for(const guard of Object.values(PACKAGE_STORE_GUARD_NAMES)){
    const out=mapPackageStoreFailure(Object.assign(new Error('x'),{code:'QR004',constraint:guard}));
    assert.deepEqual([out.ok,out.code,out.diagnostic.guard],[false,PACKAGE_STORE_CODES.STORE_GUARD,guard]);
  }
  assert.equal(Object.keys(PACKAGE_STORE_GUARD_NAMES).length,10);
  for(const error of [{code:'QR004',constraint:'mp_research_runs_guard'},{code:'QR004'},{code:'QR002'},{code:'QR003'},{code:'40001'},{code:'42501'},{code:'23505',constraint:'mp_package_exports_pkey'},{}, null, undefined])
    assert.equal(mapPackageStoreFailure(error),null);
});

test('the runtime role cannot use the service: it fails with 42501 and nothing is mapped',{timeout:120000},async()=>{
  const real=await R1(),svc=packages(rt);
  await assert.rejects(svc.build({owner_id:real.owner_id,run_id:real.run_id}),{code:'42501'});
  await assert.rejects(svc.read({owner_id:real.owner_id,run_id:real.run_id}),{code:'42501'});
  await assert.rejects(rt.query('SELECT 1 FROM public.mp_package_exports'),{code:'42501'});
});

test('the service refuses a configuration that is not a fixture-role handle outside a transaction with its own store',async()=>{
  const own=new Store(fx),good={db:fx,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>NOW2,engineHash:()=>ENGINE};
  assert.doesNotThrow(()=>new MultiPineFixturePackageService(good));
  assert.throws(()=>new MultiPineFixturePackageService({...good,store:new Store(fx2)}),/same db/);
  assert.throws(()=>new MultiPineFixturePackageService({...good,readBotState:undefined}),/readBotState/);
  assert.throws(()=>new MultiPineFixturePackageService({...good,clock:undefined}),/clock/);
  assert.throws(()=>new MultiPineFixturePackageService({...good,currentRules:null}),/currentRules/);
  for(const engineHash of [undefined,'short',123])assert.throws(()=>new MultiPineFixturePackageService({...good,engineHash}),/engineHash/);
  assert.doesNotThrow(()=>new MultiPineFixturePackageService({...good,engineHash:ENGINE}));
  assert.throws(()=>new MultiPineFixturePackageService({}),/PostgresDatabase/);
  await fx.transaction(async()=>{assert.throws(()=>new MultiPineFixturePackageService(good),/outside a transaction/);},{isolation:'SERIALIZABLE'});
  for(const input of [null,{},{owner_id:'x'},{owner_id:'x',run_id:'y',extra:1},{owner_id:'',run_id:randomUUID()}]){
    assert.deepEqual((await new MultiPineFixturePackageService(good).build(input)).code,'NOT_FOUND');
  }
});

test('fixture records are labelled and scoped to their member; the hard limits are the current server limits and the bounds the frozen domains',async()=>{
  const real=await R1(),contract=(await viewOf(real.owner_id,real.run_id)).run.contract;
  for(const member of contract.members)for(const kind of ['dataset_alignment','native_parity','bridge_parity','repaint']){
    const record=fixtureEvidenceRecord(contract,member,kind);
    assert.equal(record.method,'fixture-record');assert.equal(record.operator_role,'fixture');
    assert.deepEqual(record.scope,{source_hash:member.source_hash,effective_input_hash:member.effective_inputs_hash,dataset_digest:contract.dataset.content_digest,engine_hash:contract.engine_hash,
      deployment_id:member.deployment_id,ordinal:member.ordinal});
  }
  assert.throws(()=>fixtureEvidenceRecord(contract,contract.members[0],'quant_baseline'),/Unknown evidence kind/);
  assert.deepEqual(riskLimitsOf(POLICY),{maxRiskPercent:'100',maxOrderNotional:'10000',maxDailyNotional:'100000'});
  // RD-MP-48 F2, N2: the hard limits are the validator ranges, not the policy: every limit of the Bot policy lies inside them
  assert.deepEqual(serverHardLimits(),{maxRiskPercent:{min:'0.01',max:'100'},maxOrderNotional:{min:'0.01',max:'1000000000000'},maxDailyNotional:{min:'0.01',max:'10000000000000'}});
  assert.deepEqual(Object.keys(serverHardLimits()).sort(),Object.keys(riskLimitsOf(POLICY)).sort());
  assert.notDeepEqual(serverHardLimits().maxOrderNotional,{min:'0',max:riskLimitsOf(POLICY).maxOrderNotional});
  assert.deepEqual(riskLimitsOf({maxRiskPercent:0,maxOrderNotional:'x'}),{});
  // N5: the positive plain decimal rule of the run contract (no sign, no leading zero, no exponent, below 1e20, at least one non-zero digit)
  assert.deepEqual(riskLimitsOf({maxRiskPercent:'0.5',maxOrderNotional:12.5,maxDailyNotional:'100000000000000000000'}),{maxRiskPercent:'0.5',maxOrderNotional:'12.5'});
  for(const bad of ['01','007','0','0.0','-1','+1','1e3','1.','.5',' 1','1 ','',NaN,Infinity,null,true,{}])assert.deepEqual(riskLimitsOf({maxRiskPercent:bad}),{},String(bad));
  assert.deepEqual(bridgeBoundsOf(contract),{atr_multiplier:{min:'2',max:'3'},rr:{min:'1',max:'2'}});
});

test('the module names every relation with its schema, reads no run-store table itself and writes only package-store tables',async()=>{
  const code=(await fs.readFile(new URL('../../src/postgres/mp-package-store.js',import.meta.url),'utf8')).split('\n').filter(line=>!line.trimStart().startsWith('*')&&!line.trimStart().startsWith('/*')&&!line.trimStart().startsWith('//')).join('\n');
  for(const match of code.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_.]*)/g))assert.ok(match[1].startsWith('public.')||['earlier'].includes(match[1]),match[0]);
  assert.doesNotMatch(code,/mp_research_run/,'the run store is read through its reader module only');
  for(const match of code.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.([a-z_]+)/g))assert.ok(match[1].startsWith('mp_package_'),match[0]);
  assert.doesNotMatch(code,/SECURITY DEFINER|CREATE TABLE|ALTER TABLE|DROP /);
});
