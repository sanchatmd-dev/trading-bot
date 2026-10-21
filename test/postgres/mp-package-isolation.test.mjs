import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {QuantLibraryService} from '../../src/postgres/quant-library.js';
import {researchHistory} from '../../src/postgres/quant-research-history.js';
import {QuantPreflightService} from '../../src/postgres/quant-preflight.js';
import {readSearchedWindows} from '../../src/postgres/selection-store.js';
import {readComparison,createComparison} from '../../src/postgres/comparison-store.js';
import {validateSpec} from '../../src/comparison/ranking.js';
import {validateRequest} from '../../src/comparison/context.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {migrateQuantComparison} from '../../src/postgres/quant-comparison-migration.js';
import {migrateQuantSelection} from '../../src/postgres/quant-selection-migration.js';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {storeBotState} from '../../src/postgres/mp-member-set-store.js';
import {RUN_STORE_TABLES,MARKER_TABLE as RUN_MARKER,migrateMpRunStore,inspectMpRunStore} from '../../src/postgres/mp-run-store-migration.js';
import {PACKAGE_STORE_TABLES,MARKER_TABLE as PACKAGE_MARKER,migrateMpPackageStore,inspectMpPackageStore,classifyMpPackageStore} from '../../src/postgres/mp-package-store-migration.js';
import {getMultiRun} from '../../src/postgres/mp-run-store.js';
import {MultiPineFixturePackageService} from '../../src/postgres/mp-package-store.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {runOf,seedRun,hex,MINUTE,T0 as LIB_T0} from '../helpers/quant-library-fixture.mjs';
import {canonical,hash,inspectSource,validateSelection} from '../../src/pine-bridge/source.js';
import {assemble} from '../../src/pine-bridge/template.js';
import {MultiPineFixtureService,effectiveInputsHash} from '../../src/multi-pine/fixture-service.js';
import {SPT_CUSTOM_SETTINGS,SPT_SIGNAL_MAPPING} from '../../src/multi-pine/member-admission.js';
import {MultiPineFixtureExecutor} from '../../src/multi-pine/executor.js';
import {createPythonRunner} from '../../src/multi-pine/python-runner.js';
import {mpCombinedEngineHash} from '../../src/multi-pine/engine-closure.js';
import {buildMemberSet} from '../../src/multi-pine/member-set.js';
import {config} from '../../src/config.js';

/*
 * F11-01 R6-5 (RD-MP-36, RD-MP-42 b): the BEHAVIOUR half of the package-store isolation proof, on a throwaway PostgreSQL cluster. It mirrors
 * test/postgres/mp-run-store-isolation.test.mjs. The static half is test/mp-package-store-static-isolation.test.js. Every row is a LABELLED FIXTURE (fixture=true, synthetic bars-v2,
 * never a research result, never market evidence).
 *
 * The stored export is the REAL one: one multi-Pine run is admitted and executed with the real Python job on the committed 6,000 synthetic bars-v2 (the private source gate is the one
 * stub, as in test/postgres/mp-package-build.test.mjs, which this file copies for the world, the gate wrapper and the F17 path), then built, given fixture records and validated to
 * EXPORT_INTERNAL by MultiPineFixturePackageService on a FIXTURE-role connection. Two copies of one template database exist: WITHOUT holds the multi world (users, members, deployments,
 * bars) but no run and no export; WITH additionally holds the run, the member set, the export and every package row. Each reader, claim and lookup of the one-Pine product then runs as the
 * real non-owner RUNTIME role on both, in the same order, and the answers must be equal. Tables that belong to the multi side (run store, member set, package store) are excluded from the
 * whole-schema digest; the control test shows they differ, so the exclusion is not hiding an empty comparison.
 */
const GRANT_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const RUN_FIXTURE_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url));
const PACKAGE_FIXTURE_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-mp-package-fixture.sql',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const FIXTURES=new URL('../fixtures/mp-combined/',import.meta.url);
const MANIFEST=JSON.parse(await fs.readFile(new URL('manifest.json',FIXTURES),'utf8'));
const BARS2=JSON.parse(await fs.readFile(new URL('bars-v2.json',FIXTURES),'utf8'));
// The allowlist is written out, not derived: a table the package store adds later fails the allowlist test until this list changes on purpose.
const EXPECTED_PACKAGE_TABLES=['mp_package_attempts','mp_package_blobs','mp_package_clearances','mp_package_compile_records','mp_package_evidence_records','mp_package_exports',
  'mp_package_files','mp_package_status_events','mp_package_store_schema','mp_package_trace_records','mp_package_validations'];
const PACKAGE_TABLES=[...EXPECTED_PACKAGE_TABLES];
const RUN_TABLES=[RUN_MARKER,...RUN_STORE_TABLES];
const MEMBER_SET_TABLES=['mp_member_sets','mp_member_set_members'];
const DENIED='42501',FK_VIOLATION='23503';
const UTC='2026-10-20T10:00:00Z',T0=1790000000000,CLOCK=LIB_T0+7_200_000+60_000;
const START2=BARS2.first_time,END2=START2+(BARS2.bar_count-1)*60000,NOW2=END2+3600000;
const DATASET2={start_time:START2,end_time:END2,warmup_bars:MANIFEST.split.warmup};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:10,slippage_bps:1,risk_percent:0.05,data_profile:'closed-ohlcv-atr14-v1'};
const POLICY={paperTrading:true,requireReduceOnlySell:true,...MANIFEST.policy};
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const SOURCE='//@version=6\nindicator("mp executor fixture")\nbuySignal = ta.crossover(close, ta.sma(close, 20))\nsellSignal = ta.crossunder(close, ta.sma(close, 20))\nplot(close)\n';
const SUPPORTED=hash(SOURCE);
const V2_DOMAINS={atr_multiplier:{min:'2',max:'3',step:'0.5'},rr:{min:'1',max:'2',step:'0.5'}};
const PROVENANCE2={profile:MODEL.data_profile,source:BARS2.provenance.source,fixture:true};
// Fixed ids: the same ids are asked on both databases, so a lookup that "finds" a multi run or an export on one side shows up as a difference.
const IDS={oneSucceeded:'b0000000-0000-4000-8000-000000000001',oneNoValid:'b0000000-0000-4000-8000-000000000002',oneFailed:'b0000000-0000-4000-8000-000000000003',
  oneForeign:'b0000000-0000-4000-8000-000000000004',oneQueued:'b0000000-0000-4000-8000-000000000005'};

let admin,templateName,runtimeName,fixtureName,env,ENGINE,tablesBefore,objectsBefore;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const track=pool=>{pools.push(pool);return pool;};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let text=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))text=text.replaceAll(":'"+variable+"'","'"+value+"'");return text;};
/** The boundary table is part of the preflight extension; the package build reads it, so exactly the table, its function and its trigger are installed (as test/postgres/mp-package-build.test.mjs). */
async function boundarySql(){
  const body=await sqlText('quant-preflight-schema.sql');
  const start=body.indexOf('CREATE TABLE quant_holdout_boundaries('),marker='EXECUTE FUNCTION quant_holdout_boundary_write_once();',end=body.indexOf(marker)+marker.length;
  assert.ok(start>=0&&end>start);
  return body.slice(start,end);
}

/* ---- labelled one-Pine worlds (the recipe of test/postgres/mp-run-store-isolation.test.mjs) ---- */

const evidenceFor=(snapshot,snapshotHash,tag,model=MODEL)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(model),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});
const ONE_POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const ONE_CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const ONE_MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
/** One owner with COUNT connected one-Pine members, written by the schema owner (no multi run, no member set). */
async function oneWorld(target,targetStore,{count=2}={}){
  const user=await targetStore.createUser({email:'r65-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const ids=Array.from({length:count},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,pine:id,sourceHash:hash('source-'+id),analysis:{effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i'+(i+1)}]},dep:'dep-'+randomUUID()}));
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:m.sourceHash,analysis:m.analysis}));
  for(const m of specs){
    await target.query('INSERT INTO pine_sources VALUES($1,$2,$8,1,$3,$4,$5,$6,$7)',[m.pine,user.id,m.sourceHash,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(m.analysis),LIB_T0,user.id]);
    await target.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,m.sourceHash,'//@version=6\nindicator("x")',JSON.stringify(m.analysis),LIB_T0]);
    await target.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,user.id]);
  }
  for(const m of specs){
    const snapshot={policy:ONE_POLICY,policy_hash:hash(canonical(ONE_POLICY)),capital:ONE_CAPITAL,funding_cutoff:7,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection:{bridge:{atr_multiplier:2,rr:1.5},bindings:[]},market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:m.sourceHash,
      instruction_versions:{template:'fixture'},artifact_hash:hash('artifact-'+m.pine)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n,ONE_MODEL);
    await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$7,$3,1,$4,$5,'DRAFT',$6)",
      [m.dep,user.id,m.pine,JSON.stringify(snapshot),snapshotHash,LIB_T0,user.id]);
    await target.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),LIB_T0]);
  }
  return {id:user.id,specs};
}

/* ---- the multi world (copied from test/postgres/mp-package-build.test.mjs: same members, same inputs, same gate wrapper) ---- */

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
async function multiWorld(target,targetStore,{names=['M1','M2']}={}){
  const user=await targetStore.createUser({email:'r65m-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=user.id;
  await target.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,$3,$3,'CONFIGURATION')",[bot,T0,MANIFEST.capital.equity]);
  const capital=await targetStore.paperAccounts(bot);
  const funding_cutoff=(await target.query('SELECT COALESCE(max(id),0)::int AS cutoff FROM paper_funding WHERE user_id=$1',[bot])).rows[0].cutoff;
  const ids=Array.from({length:names.length},()=>randomUUID()).sort();
  const deps=Array.from({length:names.length},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,name:names[i],pine:id,dep:deps[i],inputs:MANIFEST.members[names[i]].inputs,analysis:analysisFor(MANIFEST.members[names[i]].inputs)}));
  for(const m of specs){
    await target.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[m.pine,user.id,bot,SUPPORTED,'Member fixture',SOURCE,JSON.stringify(m.analysis),T0]);
    await target.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,SUPPORTED,SOURCE,JSON.stringify(m.analysis),T0]);
    await target.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:SUPPORTED,analysis:m.analysis}));
  const selection=validateSelection(inspectSource(SOURCE),{...SPT_SIGNAL_MAPPING,buy:'buySignal',exit:'sellSignal'},[]);
  for(const m of specs){
    const artifact=assemble(SOURCE,selection,{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET}).integrated_pine;
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital,funding_cutoff,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection,market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:SUPPORTED,instruction_versions:{template:'fixture'},artifact_hash:hash(artifact)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n);
    await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'DRAFT',$7)",
      [m.dep,user.id,bot,m.pine,JSON.stringify(snapshot),snapshotHash,T0]);
    await target.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
    await target.query(JOB_SQL,[randomUUID(),user.id,bot,randomUUID(),hash('request-'+randomUUID()),m.pine,T0,JSON.stringify({integrated_pine:artifact,deployment_id:m.dep,artifact_status:'DRAFT'})]);
  }
  return {id:user.id,bot,specs,inputsByImport:Object.fromEntries(specs.map(m=>[m.pine,m.inputs]))};
}
const namesOf=world=>world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}));
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
const barRow=bar=>({time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,atr14:bar.atr14,price_tick:BARS2.price_tick,quantity_step:BARS2.quantity_step});
let tick=0;
const botState=handle=>storeBotState({store:new Store(handle),defaultRisk:POLICY});
const packages=handle=>new MultiPineFixturePackageService({db:handle,store:new Store(handle),readBotState:botState(handle),clock:()=>NOW2+5000+(tick++),engineHash:()=>ENGINE});

/* ---- comparison and catalog helpers (the recipe of the run-store suite) ---- */

const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.tgname||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
const VOLATILE={quant_comparison_specs:['frozen_at_ms'],quant_comparison_status_events:['at_ms'],quant_exposure_register:['exposure_id','at_ms']};
async function tableDigests(target,{skip=[],volatile={}}={}){
  const tables=(await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename).filter(name=>!skip.includes(name));
  const out={};
  for(const table of tables){
    out[table]=(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg((to_jsonb(t)-'lease_token'-$1::text[])::text,'|' ORDER BY (to_jsonb(t)-'lease_token'-$1::text[])::text),''),'UTF8')),'hex') d FROM public.${table} t`,[volatile[table]??[]])).rows[0];
  }
  return out;
}
const diffTables=(left,right)=>[...new Set([...Object.keys(left),...Object.keys(right)])].sort().filter(table=>JSON.stringify(left[table])!==JSON.stringify(right[table]));
async function record(fn){
  try{return JSON.parse(JSON.stringify({ok:true,value:await fn()}));}
  catch(error){return {ok:false,error:{code:error.code??null,status:error.status??error.statusCode??null,constraint:error.constraint??null,message:String(error.message)}};}
}
const withoutLease=value=>{const out=structuredClone(value);const strip=item=>{if(item&&typeof item==='object'){delete item.lease_token;Object.values(item).forEach(strip);}};strip(out);return out;};
const CLOCK_KEYS=new Set(['frozen_at_ms','exposure_at_ms','at_ms','attempts']);
const withoutClock=value=>{const out=structuredClone(value);const strip=item=>{if(item&&typeof item==='object'){for(const key of Object.keys(item)){if(CLOCK_KEYS.has(key))delete item[key];else strip(item[key]);}}};strip(out);return out;};
const tableList=async target=>(await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
/** Every named object of the public schema (relations including indexes, functions, triggers, constraints) as 'kind:name' strings. */
const objectList=async target=>(await target.query(`SELECT 'rel:'||c.relname x FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'fn:'||p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 'trg:'||t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'con:'||k.conname FROM pg_constraint k WHERE k.connamespace='public'::regnamespace ORDER BY 1`)).rows.map(row=>row.x);

async function openEnv(name){
  const adminPool=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:3})));
  const rt=track(new PostgresDatabase({connectionString:urlOf(name,runtimeName),max:4}));
  const fx=ser(track(new PostgresDatabase({connectionString:serialOf(name,fixtureName),max:4})));
  const store=new Store(rt),pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  const service=new QuantResearchService({pineService:pine,clock:()=>CLOCK,foundation:false});
  const worker=new QuantResearchWorker({service,evaluate:()=>{throw new Error('the isolation suite never evaluates');},clock:()=>CLOCK});
  return {name,admin:adminPool,rt,fx,store,pine,service,worker,library:new QuantLibraryService(rt),transcripts:{}};
}
const ids={};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  ENGINE=await mpCombinedEngineHash();
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_pb_r65tpl_'+suffix;
  runtimeName='robot_pb_r65rt_'+suffix.slice(0,12);fixtureName='robot_pb_r65fx_'+suffix.slice(0,12);
  for(const name of [runtimeName,fixtureName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=ser(new PostgresDatabase({connectionString:serialOf(templateName),max:3}));
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql','quant-storage-schema.sql'])await install(builder,name);
    await migrateQuantExposureRegister(builder);await migrateBestInputsPackage(builder);await migrateQuantComparison(builder);await migrateQuantSelection(builder);
    await installQuantGuards(builder);
    if((await builder.query("SELECT to_regclass('public.quant_holdout_boundaries') AS present")).rows[0].present===null)await builder.transaction(async()=>builder.query(await boundarySql()));
    await migrateMpMemberSet(builder);
    await migrateMpRunStore(builder);
    // The state before the package store: its tables and named objects, so the allowlist test can name exactly what the package store added.
    tablesBefore=await tableList(builder);objectsBefore=await objectList(builder);
    await migrateMpPackageStore(builder);
    const store=new Store(builder);
    // Two owners of one-Pine runs (the surfaces of the run-store suite) and one multi owner (the stored export) with its bars.
    const worldU=await oneWorld(builder,store),worldV=await oneWorld(builder,store),worldM=await multiWorld(builder,store);
    const one=(world,member,options)=>runOf({owner:world.id,deployment:world.specs[member].dep,importId:world.specs[member].pine,...options});
    const seed=(world,member,run)=>seedRun(builder,run,{owner:world.id,deployment:world.specs[member].dep});
    await seed(worldU,0,one(worldU,0,{id:IDS.oneSucceeded,scenario:'PENDING',tag:'u-ok',at:LIB_T0+3_600_000}));
    await seed(worldU,0,one(worldU,0,{id:IDS.oneNoValid,scenario:'NO_VALID',tag:'u-nv',at:LIB_T0+3_700_000}));
    await seed(worldU,1,one(worldU,1,{id:IDS.oneFailed,status:'FAILED',partial:2,diagnostic:'FIXTURE_FAILED',tag:'u-fail',at:LIB_T0+3_800_000}));
    await seed(worldV,0,one(worldV,0,{id:IDS.oneForeign,scenario:'PENDING',tag:'v-ok',at:LIB_T0+3_650_000}));
    const rows=BARS2.bars.map(barRow);
    await builder.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,b::jsonb,$4::jsonb,h FROM unnest($1::bigint[],$2::text[],$3::text[]) AS u(t,b,h)`,
      [rows.map(row=>row.time),rows.map(row=>JSON.stringify(row)),rows.map(row=>hash(canonical(row))),JSON.stringify(PROVENANCE2)]);
    Object.assign(ids,{ownerU:worldU.id,ownerV:worldV.id,depU:worldU.specs[0].dep,importU:worldU.specs[0].pine,ownerM:worldM.id,worldM});
    // The repository grant scripts, exactly as an isolated cluster is prepared: the runtime role first, then the run-store fixture role, then the package-store fixture role.
    await builder.query(await roleScript(GRANT_SCRIPT,{runtime_role:runtimeName}));
    await builder.query(await roleScript(RUN_FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
    await builder.query(await roleScript(PACKAGE_FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  }finally{await builder.close();}
  const names={without:'robot_pb_r65wo_'+suffix.slice(0,20),with:'robot_pb_r65wi_'+suffix.slice(0,20)};
  for(const name of Object.values(names)){databases.push(name);await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);}
  env={without:await openEnv(names.without),with:await openEnv(names.with)};
  // WITH: the F17 path of test/postgres/mp-package-build.test.mjs on the real job: admit, execute, build, attempt 1, fixture records, attempt 2 to EXPORT_INTERNAL.
  const e=env.with,world=ids.worldM;
  const own=new Store(e.fx);
  const admission=new MultiPineFixtureService({db:e.fx,store:own,readBotState:botState(e.fx),clock:()=>NOW2,engineHash:ENGINE,supported_source_hash:SUPPORTED});
  const admitted=await admission.admit({owner_id:world.id,bot_id:world.bot,fixture:true,idempotency_key:'r65-key-'+suffix,member_deployments:namesOf(world),
    bridge_domains:structuredClone(V2_DOMAINS),dataset:{...DATASET2},budget:{candidates:30},seed:42});
  assert.equal(admitted.ok,true,JSON.stringify(admitted));
  const executor=new MultiPineFixtureExecutor({db:e.fx,store:own,readBotState:botState(e.fx),clock:()=>NOW2+1000,runEvaluator:realRunner(world),engineHash:()=>ENGINE});
  const out=await executor.execute({owner_id:world.id,run_id:admitted.run.run_id});
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'SUCCEEDED',reason_code:null});
  const svc=packages(e.fx);
  const built=await svc.build({owner_id:world.id,run_id:admitted.run.run_id});
  assert.equal(built.ok,true,JSON.stringify(built));
  const exportId=built.export.export_id;
  const a1=await svc.attempt({owner_id:world.id,export_id:exportId});
  assert.equal(a1.ok,true,JSON.stringify(a1));assert.equal(a1.pass,false);
  assert.deepEqual(await svc.recordFixtureRecords({owner_id:world.id,export_id:exportId}),{ok:true});
  const a2=await svc.attempt({owner_id:world.id,export_id:exportId});
  assert.equal(a2.ok,true,JSON.stringify(a2));assert.deepEqual([a2.pass,a2.status,a2.ready],[true,'EXPORT_INTERNAL',false]);
  const stored=await getMultiRun(e.fx,{owner_id:world.id,run_id:admitted.run.run_id});
  assert.equal(stored.ok,true);
  const multiSourceHashes=[...new Set(stored.run.contract.members.map(member=>member.source_hash))].sort();
  assert.deepEqual(multiSourceHashes,[SUPPORTED],'the QR-4 probe uses the source actually stored in the multi run');
  Object.assign(ids,{multiRun:admitted.run.run_id,exportId,multiSourceHashes});
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    // A raw client: the application pool times a statement out after 15 s, and dropping a database with 6,000 bars can take longer.
    const dropper=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
    await dropper.connect();
    for(const name of [...databases,templateName])await dropper.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [runtimeName,fixtureName])await dropper.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await dropper.end();
    await admin.close();
  }
});

/* ---- the surfaces: owner readers, the QR-3 and QR-4 lookups, G8 and the legacy worker claim, run in this order on both databases ---- */

const get=(e,owner,id,cancel=false)=>e.rt.transaction(()=>e.service.get(owner,id,cancel));
const statusOf=async(e,id)=>(await e.admin.query('SELECT status,updated_at FROM quant_jobs WHERE run_id=$1',[id])).rows[0]??null;
const queuedRun=(options={})=>runOf({id:IDS.oneQueued,owner:ids.ownerU,deployment:ids.depU,importId:ids.importU,status:'QUEUED',tag:'u-queued',at:LIB_T0+7_200_000,...options});
const CMP_WINDOW={start_ms:LIB_T0,end_ms:LIB_T0+1440*MINUTE};
/** QR-3 input naming the given ids as participants (a one-Pine run, a multi run id and/or an export id): the store takes ids as text, so the answer must not depend on which database holds the rows. */
function comparisonInput(comparisonId,participantIds,shiftDays=0){
  const shift=shiftDays*1440*MINUTE;
  const checked=validateSpec({mode:'STANDARDIZED',participants:participantIds,period:{start_ms:CMP_WINDOW.start_ms+shift,end_ms:CMP_WINDOW.end_ms+shift},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
    uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'}});
  assert.equal(checked.ok,true,JSON.stringify(checked));
  return {owner_id:ids.ownerU,comparison_id:comparisonId,market:{...MARKET},fixture:true,spec:checked.spec,spec_hash:checked.spec_hash,context_key:hex('context'),
    participants:participantIds.map((id,index)=>({participant_id:id,source_hash:hex('source-'+id),origin:'FIXTURE',fixture:true,context_key:hex('context'),freeze:{subject:{index},disclosure:{prior_searches:[],gates:{G5:'PASS'}}}}))};
}
const CMP_IDS={mixed:'c0000000-0000-4000-8000-000000000011',multi:'c0000000-0000-4000-8000-000000000012'};
const SURFACES=[
  ['owner run get: a one-Pine run reads; the multi run id and the export id are NOT_FOUND for the multi owner, another owner and the one-Pine owner',async e=>({
    one:await record(()=>get(e,ids.ownerU,IDS.oneSucceeded)),multiOwn:await record(()=>get(e,ids.ownerM,ids.multiRun)),multiOther:await record(()=>get(e,ids.ownerU,ids.multiRun)),
    exportAsRun:await record(()=>get(e,ids.ownerM,ids.exportId)),foreign:await record(()=>get(e,ids.ownerV,ids.multiRun))})],
  ['owner run cancel: cancelling the multi run id or the export id is NOT_FOUND and writes nothing',async e=>({
    multi:await record(()=>get(e,ids.ownerM,ids.multiRun,true)),exportId:await record(()=>get(e,ids.ownerM,ids.exportId,true)),after:await statusOf(e,ids.multiRun),
    terminal:await record(()=>get(e,ids.ownerU,IDS.oneSucceeded,true)),afterOne:await statusOf(e,IDS.oneSucceeded)})],
  ['Research Library list: the multi owner lists nothing; owner U lists the one-Pine runs only; totals and qualified_total are those of the database without packages (G8)',async e=>({
    m:await record(()=>e.library.list(ids.ownerM,{limit:50})),u:await record(()=>e.library.list(ids.ownerU,{limit:50})),v:await record(()=>e.library.list(ids.ownerV,{limit:50}))})],
  ['Research Library detail: a one-Pine run reads with G8 failing (QL4C_VALIDATION_NOT_AVAILABLE); the multi run id and the export id are NOT_FOUND',async e=>({
    one:await record(()=>e.library.detail(ids.ownerU,IDS.oneSucceeded)),noValid:await record(()=>e.library.detail(ids.ownerU,IDS.oneNoValid)),
    multi:await record(()=>e.library.detail(ids.ownerM,ids.multiRun)),exportId:await record(()=>e.library.detail(ids.ownerM,ids.exportId)),other:await record(()=>e.library.detail(ids.ownerU,ids.multiRun))})],
  ['Research Library compare and the QR-3 participant lookup: neither the multi run id nor the export id resolves as a participant',async e=>({
    pair:await record(()=>e.library.compare(ids.ownerU,[IDS.oneSucceeded,IDS.oneNoValid])),withMulti:await record(()=>e.library.compare(ids.ownerU,[IDS.oneSucceeded,ids.multiRun])),
    multiOnly:await record(()=>e.library.compare(ids.ownerM,[ids.multiRun,ids.exportId])),withExport:await record(()=>e.library.compare(ids.ownerU,[IDS.oneSucceeded,ids.exportId]))})],
  ['research history: total and runs are those of the one-Pine runs only (multi owner and owner U)',async e=>({
    m:await record(()=>researchHistory(e.rt,ids.ownerM,50)),u:await record(()=>researchHistory(e.rt,ids.ownerU,50))})],
  ['QR-4 searched-window lookup (selection-store readSearchedWindows): one-Pine run windows only; the multi owner has none',async e=>({
    m:await record(()=>readSearchedWindows(e.rt,{owner_id:ids.ownerM,source_hashes:[hex('source')]})),
    matchingMulti:await record(()=>readSearchedWindows(e.rt,{owner_id:ids.ownerM,source_hashes:ids.multiSourceHashes})),
    u:await record(()=>readSearchedWindows(e.rt,{owner_id:ids.ownerU,source_hashes:[hex('source')]}))})],
  ['G8 sources as the runtime role: the ql4c validation, bi export and clearance tables and the exposure register read the same rows (no package-store record is a G8 record)',async e=>({
    validation:(await e.rt.query('SELECT count(*)::int n FROM public.ql4c_validation')).rows[0],exports:(await e.rt.query('SELECT count(*)::int n FROM public.bi_exports')).rows[0],
    clearances:(await e.rt.query('SELECT count(*)::int n FROM public.bi_clearances')).rows[0],attempts:(await e.rt.query('SELECT count(*)::int n FROM public.bi_attempts')).rows[0],
    exposures:(await e.rt.query('SELECT count(*)::int n FROM public.quant_exposure_register')).rows[0]})],
  ['QR-3 comparison read: an unknown id is NOT_FOUND on both databases',async e=>({absent:await record(()=>readComparison(e.rt,{owner_id:ids.ownerU,comparison_id:randomUUID().replace(/^.{8}/,'00000000')}))})],
  ['QR-3 comparison create and read (comparison-store): participants naming a one-Pine run and the multi run id, then the multi run id and the export id only',async e=>{
    const mixed=await record(()=>createComparison(e.rt,comparisonInput(CMP_IDS.mixed,[IDS.oneSucceeded,ids.multiRun])));
    const multi=await record(()=>createComparison(e.rt,comparisonInput(CMP_IDS.multi,[ids.multiRun,ids.exportId],2)));
    const readMixed=await record(()=>readComparison(e.rt,{owner_id:ids.ownerU,comparison_id:CMP_IDS.mixed}));
    const readMulti=await record(()=>readComparison(e.rt,{owner_id:ids.ownerU,comparison_id:CMP_IDS.multi}));
    return withoutClock({mixed,multi,readMixed,readMulti});}],
  ['mode guard and legacy worker claim: a legacy QUEUED run is accepted and claimed, and no multi run or export is claimed, swept or counted',async e=>({
    legacy:await record(()=>seedRun(e.rt,queuedRun(),{owner:ids.ownerU,deployment:ids.depU})),queued:await statusOf(e,IDS.oneQueued),
    claim:await record(async()=>withoutLease(await e.worker.claim())),again:await record(async()=>withoutLease(await e.worker.claim())),row:await statusOf(e,IDS.oneQueued),
    holdout:await record(()=>QuantPreflightService.prototype.legacyHoldout.call({db:e.rt},ids.ownerU)),holdoutM:await record(()=>QuantPreflightService.prototype.legacyHoldout.call({db:e.rt},ids.ownerM))})]];

for(const [name,run] of SURFACES){
  test(name,async()=>{
    const answers={};
    for(const side of ['without','with'])answers[side]=await run(env[side]);
    assert.deepEqual(answers.with,answers.without,'the same call answers differently once a stored multi export exists');
    // The answer is a real answer, not an error on both sides, except where NOT_FOUND / a guard refusal is the designed answer.
    const text=JSON.stringify(answers);
    assert.ok(!text.includes('"code":"'+DENIED+'"'),'a normal path raised 42501: '+text.slice(0,400));
    assert.ok(!/mp_package|mp_research_run|mp_run_store/i.test(text),'an answer names a package-store or run-store object');
    for(const side of ['without','with'])env[side].transcripts[name]=answers[side];
  });
}

test('the designed answers are real: NOT_FOUND for the multi run id and the export id, one-Pine data present, G8 failing, QUALIFIED_TOTAL 0, the multi owner lists nothing',()=>{
  const t=name=>env.with.transcripts[SURFACES.find(([label])=>label.startsWith(name))[0]];
  const get_=t('owner run get');
  assert.equal(get_.one.ok,true);assert.equal(get_.one.value.run_id,IDS.oneSucceeded);
  for(const key of ['multiOwn','multiOther','exportAsRun','foreign'])assert.deepEqual([get_[key].ok,get_[key].error.status,get_[key].error.message],[false,404,'NOT_FOUND'],key);
  const cancel=t('owner run cancel');
  for(const key of ['multi','exportId'])assert.equal(cancel[key].error.message,'NOT_FOUND',key);
  assert.equal(cancel.after,null,'the multi run id is not a quant_jobs row');assert.equal(cancel.terminal.ok,true);assert.equal(cancel.afterOne.status,'SUCCEEDED');
  const list=t('Research Library list');
  assert.equal(list.u.value.totals.all,3);assert.equal(list.v.value.totals.all,1);assert.equal(list.m.value.totals.all,0,'the multi owner has no one-Pine run, and the stored export adds none');
  for(const key of ['u','v','m'])assert.equal(list[key].value.qualified_total,0,'QUALIFIED_TOTAL stays 0 (T-K1) for '+key);
  const detail=t('Research Library detail');
  assert.equal(detail.one.ok,true);assert.equal(detail.one.value.qualified_total??0,0);
  assert.match(JSON.stringify(detail.one.value),/QL4C_VALIDATION_NOT_AVAILABLE/,'G8 fails with the no-source code on the one-Pine run');
  for(const key of ['multi','exportId','other'])assert.equal(detail[key].error.message,'NOT_FOUND',key);
  const compare=t('Research Library compare');
  assert.equal(compare.pair.ok,true);for(const key of ['withMulti','multiOnly','withExport'])assert.equal(compare[key].ok,false,key);
  assert.equal(t('research history').u.value.total_runs,3);assert.equal(t('research history').m.value.total_runs,0);
  assert.equal(t('QR-4').u.value.length,9);assert.equal(t('QR-4').m.value.length,0);
  assert.deepEqual(t('QR-4').matchingMulti,{ok:true,value:[]},'even the stored multi source resolves no QR-4 searched window');
  const g8=t('G8 sources');
  assert.deepEqual([g8.validation.n,g8.exports.n,g8.clearances.n,g8.attempts.n],[0,0,0,0],'no G8 source holds a record: the multi export wrote none (RD-MP-37)');
  const qr3=t('QR-3 comparison create');
  for(const key of ['mixed','multi','readMixed','readMulti'])assert.equal(qr3[key].ok,true,key+': '+JSON.stringify(qr3[key]).slice(0,300));
  assert.deepEqual(qr3.readMulti.value.participants.map(item=>item.participant_id).sort(),[ids.exportId,ids.multiRun].sort(),'the comparison names the multi run id and the export id as plain text, with no join to the package store');
  const worker=t('mode guard');
  assert.equal(worker.legacy.ok,true);assert.equal(worker.claim.value.run_id,IDS.oneQueued);assert.equal(worker.again.value,null);
  assert.equal(worker.holdout.value.total,4);assert.equal(worker.holdoutM.value.total,0,'the holdout lookup of the multi owner counts no one-Pine row, and the stored multi export is not one');
});

test('side effects: after every surface ran, no table outside the multi side differs between the database with a stored multi export and the one without',async()=>{
  const skip=[...RUN_TABLES,...MEMBER_SET_TABLES,...PACKAGE_TABLES,'quant_storage_namespace'];
  const [without,withPackage]=[await tableDigests(env.without.admin,{skip,volatile:VOLATILE}),await tableDigests(env.with.admin,{skip,volatile:VOLATILE})];
  assert.ok(Object.keys(withPackage).length>60,'the digest covers the whole schema: '+Object.keys(withPackage).length+' tables');
  for(const table of ['audit','notification_outbox','risk_profiles','bot_sessions','quant_exposure_register','bi_exports','bi_attempts','bi_clearances','ql4c_validation','quant_comparison_specs','quant_selection_registrations',
    'quant_jobs','users','pine_deployments','pine_bridge_jobs','quant_holdout_boundaries','paper_funding'])assert.ok(table in withPackage,table+' is part of the digest');
  for(const table of ['quant_comparison_specs','quant_comparison_participants','quant_exposure_register'])assert.ok(withPackage[table].n>0,table+' holds the rows of the QR-3 surface, so the compare covers them');
  assert.deepEqual(diffTables(withPackage,without),[],'tables that differ');
  assert.deepEqual(withPackage,without);
  // Control: the excluded multi side is genuinely different (this is not an empty comparison), and the stored export is the expected size (10 + 3 * 2 files).
  const counts=async target=>Object.fromEntries(await Promise.all([...PACKAGE_TABLES,...RUN_TABLES,...MEMBER_SET_TABLES].map(async table=>[table,(await target.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
  const [cw,cwo]=[await counts(env.with.admin),await counts(env.without.admin)];
  assert.deepEqual([cw.mp_package_exports,cw.mp_package_files,cw.mp_package_attempts,cw.mp_package_validations,cw.mp_package_trace_records,cw.mp_research_runs,cw.mp_member_sets],[1,16,2,1,3,1,1]);
  assert.deepEqual(Object.fromEntries(Object.entries(cwo).filter(([,n])=>n>0)),{mp_package_store_schema:1,mp_run_store_schema:1},'the database without the export holds only the schema marker rows of the stores');
  assert.deepEqual([cwo.mp_package_exports,cwo.mp_package_files,cwo.mp_research_runs,cwo.mp_member_sets],[0,0,0,0]);
  assert.ok(diffTables(await tableDigests(env.with.admin,{volatile:VOLATILE}),await tableDigests(env.without.admin,{volatile:VOLATILE})).length>0,'control: the full digest does see the multi side');
});

test('the two databases are still the same schema: neither a reader nor a surface changed the catalog (objects, ACLs, constraints, triggers)',async()=>{
  assert.deepEqual(await catalogDigest(env.with.admin),await catalogDigest(env.without.admin));
});

/* ---- RD-MP-42 (b): the runtime role holds nothing on the package store ---- */

test('privilege: the runtime role gets 42501 on every statement kind against each package-store table; the fixture role reads (and the table privileges are false in the catalog)',async()=>{
  const e=env.with;
  const COLUMN={mp_package_store_schema:'version',mp_package_blobs:'sha256',mp_package_exports:'fixture',mp_package_files:'path',mp_package_status_events:'status',mp_package_attempts:'pass',
    mp_package_validations:'fixture',mp_package_compile_records:'method',mp_package_evidence_records:'kind',mp_package_clearances:'blocker',mp_package_trace_records:'path'};
  for(const table of PACKAGE_TABLES){
    const column=COLUMN[table];
    assert.ok(column,'a column for '+table);
    for(const sql of [`SELECT count(*) FROM public.${table}`,`INSERT INTO public.${table} SELECT * FROM public.${table} LIMIT 0`,`UPDATE public.${table} SET ${column}=${column} WHERE false`,
      `DELETE FROM public.${table} WHERE false`,`TRUNCATE public.${table}`]){
      const answer=await record(()=>e.rt.query(sql));
      assert.equal(answer.ok,false,sql);assert.equal(answer.error.code,DENIED,sql+': '+answer.error.message);
    }
  }
  const grants=(await e.admin.query(`SELECT t AS table, bool_or(has_table_privilege($1,'public.'||t,p)) AS table_priv, (SELECT bool_or(has_any_column_privilege($1,'public.'||t,c)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) c) AS column_priv
    FROM unnest($2::text[]) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p GROUP BY t ORDER BY t`,[runtimeName,PACKAGE_TABLES])).rows;
  assert.equal(grants.length,PACKAGE_TABLES.length);
  for(const row of grants)assert.deepEqual([row.table_priv,row.column_priv],[false,false],row.table);
  assert.deepEqual((await e.admin.query(`SELECT has_schema_privilege($1,'public','USAGE') AS usage`,[runtimeName])).rows[0],{usage:true},'control: the role is a real runtime role (it can use the schema) and still has nothing on the store');
  // The fixture role reads and writes: the grant script gives it SELECT and INSERT, the marker SELECT only.
  assert.equal((await e.fx.query('SELECT count(*)::int n FROM public.mp_package_exports')).rows[0].n,1);
  assert.equal((await e.fx.query('SELECT has_table_privilege(current_user,$1,$2) AS ok',['public.mp_package_store_schema','INSERT'])).rows[0].ok,false);
  // The same statement fails the same way on a database without any package row.
  assert.equal((await record(()=>env.without.rt.query('SELECT 1 FROM public.mp_package_exports LIMIT 1'))).error.code,DENIED);
});

test('RD-MP-42 (b): the runtime role cannot resolve the multi run or the export at all, by table, by the run-store reader or by the package service (42501 is rethrown, never mapped to a result)',async()=>{
  const e=env.with;
  // by table, by id
  for(const sql of [`SELECT export_id FROM public.mp_package_exports WHERE export_id='${ids.exportId}'`,`SELECT export_id FROM public.mp_package_exports WHERE run_id='${ids.multiRun}'`,
    `SELECT run_id FROM public.mp_research_runs WHERE run_id='${ids.multiRun}'`,`SELECT sha256 FROM public.mp_package_files LIMIT 1`]){
    const answer=await record(()=>e.rt.query(sql));
    assert.equal(answer.ok,false,sql);assert.equal(answer.error.code,DENIED,sql+': '+answer.error.message);
  }
  // by the run-store reader (a function that exists, run as the runtime role)
  const run=await record(()=>getMultiRun(e.rt,{owner_id:ids.ownerM,run_id:ids.multiRun}));
  assert.equal(run.ok,false);assert.equal(run.error.code,DENIED,run.error.message);
  // by the package service on the runtime handle: read, build and attempt all fail with 42501 and none returns an export
  const svc=packages(e.rt);
  for(const [name,call] of [['read by export',()=>svc.read({owner_id:ids.ownerM,export_id:ids.exportId})],['read by run',()=>svc.read({owner_id:ids.ownerM,run_id:ids.multiRun})],
    ['build',()=>svc.build({owner_id:ids.ownerM,run_id:ids.multiRun})],['attempt',()=>svc.attempt({owner_id:ids.ownerM,export_id:ids.exportId})]]){
    const answer=await record(call);
    assert.equal(answer.ok,false,name+': '+JSON.stringify(answer).slice(0,200));assert.equal(answer.error.code,DENIED,name+': '+answer.error.message);
  }
  // control: the same service on the fixture handle resolves the same export, so the runtime failure is the privilege and nothing else
  const found=await packages(e.fx).read({owner_id:ids.ownerM,export_id:ids.exportId});
  assert.equal(found.ok,true,JSON.stringify(found));assert.deepEqual([found.status,found.ready],['EXPORT_INTERNAL',false]);
  // and the one-Pine services of the runtime role never name a store object in an answer (the surfaces above), so nothing reaches the owner either way
  const inspect=await inspectMpPackageStore(e.admin,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(inspect.ok,true,inspect.failures?.join());
});

test('K3-style residuals: the runtime role can see that the package-store tables exist and the table statistics, but no column statistics, no rows; a users DELETE of the multi owner fails 23503',async()=>{
  const e=env.with;
  await e.admin.query('ANALYZE '+PACKAGE_TABLES.map(table=>'public.'+table).join(', '));
  const visible=(await e.rt.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname = ANY($1) ORDER BY 1`,[PACKAGE_TABLES])).rows.map(row=>row.relname);
  assert.deepEqual(visible,[...PACKAGE_TABLES].sort(),'the table names are visible (documented residual, as for the run store)');
  // Column statistics (histograms, most common values) are filtered by table privilege and stay hidden from the runtime role.
  assert.equal((await e.rt.query("SELECT count(*)::int n FROM pg_stats WHERE schemaname='public' AND tablename = ANY($1)",[PACKAGE_TABLES])).rows[0].n,0);
  assert.ok((await e.admin.query("SELECT count(*)::int n FROM pg_stats WHERE schemaname='public' AND tablename = ANY($1)",[PACKAGE_TABLES])).rows[0].n>0,'control: the schema owner sees column statistics');
  assert.equal((await e.rt.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_name = ANY($1)",[PACKAGE_TABLES])).rows[0].n,0,'information_schema lists only tables the role may use');
  // Existence of an owner with stored exports is observable only as a refused delete (23503), and the refusal changes nothing.
  const before_=await tableDigests(e.admin,{skip:[]});
  const plain=await record(()=>e.rt.query('DELETE FROM users WHERE id=$1',[ids.ownerM]));
  assert.equal(plain.ok,false);assert.equal(plain.error.code,FK_VIOLATION,plain.error.message);
  assert.deepEqual(await tableDigests(e.admin,{skip:[]}),before_,'the refused delete changed nothing');
});

/* ---- the table-name allowlist ---- */

test('table-name allowlist: after install the mp_package_ tables are exactly the eleven known ones, and the package store added no other table, run-store, bi_ or quant_ name',async()=>{
  const e=env.with;
  assert.deepEqual([...PACKAGE_STORE_TABLES,PACKAGE_MARKER].sort(),EXPECTED_PACKAGE_TABLES,'the migration constants and the written-out allowlist agree');
  const now=await tableList(e.admin);
  assert.deepEqual(now.filter(name=>/^mp_package_/.test(name)),EXPECTED_PACKAGE_TABLES);
  assert.deepEqual(now.filter(name=>!tablesBefore.includes(name)),EXPECTED_PACKAGE_TABLES,'every table the install added is a package-store table');
  assert.deepEqual(tablesBefore.filter(name=>!now.includes(name)),[],'the install removed no table');
  // every other relation, function, trigger and constraint the install added carries a package-store name (no run-store, member-set, bi_ or quant_ name)
  const added=(await objectList(e.admin)).filter(item=>!objectsBefore.includes(item));
  assert.ok(added.length>40,'the install added its tables, indexes, functions, triggers and constraints: '+added.length);
  const stray=added.filter(item=>!/^(rel|fn|trg|con):mp_package_/.test(item));
  assert.deepEqual(stray,[],'objects added by the package store with another name');
  assert.deepEqual(added.filter(item=>/mp_research_run|mp_run_store|mp_member_set|:bi_|:quant_|ql4c/.test(item)),[]);
  // the install changed no pre-existing object: every earlier name is still there (the catalog digest of the earlier objects is covered by the two-database compare)
  const nowObjects=new Set(await objectList(e.admin));
  assert.deepEqual(objectsBefore.filter(item=>!nowObjects.has(item)),[]);
  // the classifiers: package store INSTALLED, run store INSTALLED (the package store never sits in front of the run-store classifier)
  assert.equal((await classifyMpPackageStore(e.admin)).state,'INSTALLED');
  const run=await inspectMpRunStore(e.admin,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(run.ok,true,run.failures?.join());assert.equal(run.facts.state,'INSTALLED');
});

test('catalog: foreign keys of the package store go only to users and to package-store tables, nothing outside the store references it, and no view, rule, policy or publication depends on it',async()=>{
  const q=(sql,params)=>env.with.admin.query(sql,params).then(result=>result.rows);
  const oids=`ARRAY(SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY($1))`;
  const out=await q(`SELECT DISTINCT c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype='f' AND c.conrelid = ANY(${oids}) ORDER BY 1`,[PACKAGE_TABLES]);
  assert.ok(out.every(row=>row.parent==='users'||PACKAGE_TABLES.includes(row.parent.replace(/^public\./,''))),JSON.stringify(out));
  assert.deepEqual(await q(`SELECT c.conrelid::regclass::text AS child,c.conname FROM pg_constraint c WHERE c.contype='f' AND c.confrelid = ANY(${oids}) AND NOT c.conrelid = ANY(${oids}) ORDER BY 1,2`,[PACKAGE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT d.classid::regclass::text AS class,count(*)::int n FROM pg_depend d WHERE d.refobjid = ANY(${oids}) AND d.deptype IN ('n','a')
    AND d.classid <> 'pg_constraint'::regclass AND d.classid <> 'pg_class'::regclass AND d.classid <> 'pg_trigger'::regclass AND d.classid <> 'pg_attrdef'::regclass GROUP BY 1 ORDER BY 1`,[PACKAGE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT polname FROM pg_policy WHERE polrelid = ANY(${oids})`,[PACKAGE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT pr.prrelid::regclass::text AS rel FROM pg_publication_rel pr WHERE pr.prrelid = ANY(${oids})`,[PACKAGE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT i.inhrelid::regclass::text AS child FROM pg_inherits i WHERE i.inhrelid = ANY(${oids}) OR i.inhparent = ANY(${oids})`,[PACKAGE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ~* 'mp_package'`),[]);
  // no trigger on another table calls a package-store function, and no function outside the extension names a package-store table
  assert.deepEqual(await q(`SELECT t.tgname,t.tgrelid::regclass::text AS rel FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname ~ '^mp_package_' AND NOT t.tgrelid = ANY(${oids})`,[PACKAGE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosrc ~* 'mp_package' AND p.proname !~ '^mp_package_' ORDER BY 1`),[]);
  // the package functions read the run store (the export guard, by SELECT, RD-MP-36) and name no one-Pine bi_ or quant_ table (lower-case table names; upper-case BI_ codes are error codes)
  const bodies=await q(`SELECT p.proname,p.prosrc FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname ~ '^mp_package_' ORDER BY 1`);
  assert.ok(bodies.length>=8,'the extension functions were found: '+bodies.length);
  assert.deepEqual(bodies.filter(row=>/\bbi_[a-z]|quant_|ql4c_validation/.test(row.prosrc.replace(/--[^\n]*/g,''))).map(row=>row.proname),[]);
});

/* ---- RD-MP-42 (a): the QR-3 request check refuses a participant built from the stored multi export ---- */

test('RD-MP-42 (a): validateRequest refuses QR3_FIXTURE_PARTICIPANT for a non-fixture comparison offered a participant built from the stored multi export (id = the run id, fixture = the stored true)',async()=>{
  const row=(await env.with.admin.query('SELECT export_id,run_id,owner_id,fixture,mode FROM public.mp_package_exports WHERE export_id=$1',[ids.exportId])).rows[0];
  assert.deepEqual([row.run_id,row.fixture,row.mode],[ids.multiRun,true,'MULTI_PINE'],'the stored export is the real one built above');
  const participant={id:row.run_id,mode:'ACTUAL_BOT',fixture:row.fixture};
  const other={id:'ordinary-run-0001',mode:'ACTUAL_BOT',fixture:false};
  const request=(over={})=>({mode:'ACTUAL_BOT',participants:[participant,other],market:{...MARKET},fixture_comparison:false,...over});
  const refused=validateRequest(request());
  assert.deepEqual([refused.ok,refused.code],[false,'QR3_FIXTURE_PARTICIPANT'],JSON.stringify(refused));
  // the refusal is the same when fixture_comparison is absent, and when the multi participant is second
  assert.equal(validateRequest(request({fixture_comparison:undefined})).code,'QR3_FIXTURE_PARTICIPANT');
  assert.equal(validateRequest(request({participants:[other,participant]})).code,'QR3_FIXTURE_PARTICIPANT');
  // controls: the check discriminates. A fixture comparison accepts it, and a participant built from the same export with fixture false is not refused by this check.
  assert.deepEqual([validateRequest(request({fixture_comparison:true})).ok],[true]);
  assert.equal(validateRequest(request({participants:[{...participant,fixture:false},other]})).ok,true);
  // the participant is built from the stored row only: the runtime role cannot make this row, so a real participant of this kind never comes from the QR-3 store path
  assert.equal((await record(()=>env.with.rt.query('SELECT fixture FROM public.mp_package_exports WHERE run_id=$1',[ids.multiRun]))).error.code,DENIED);
});
