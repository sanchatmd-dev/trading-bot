import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {SELECTION_GUARDS,SELECTION_MARKER,SELECTION_TABLES,SELECTION_GRANT_TABLES,SELECTION_GUARD_NAMES,INSERT_ONLY_SQLSTATE,INSERT_GUARD_SQLSTATE,SERIALIZABLE_SQLSTATE,
  classifyQuantSelection,inspectQuantSelection,migrateQuantSelection,rollbackQuantSelection} from '../../src/postgres/quant-selection-migration.js';
import {appendExposures} from '../../src/postgres/exposure-register.js';
import {registerSelection,GUARD_REFUSALS} from '../../src/postgres/selection-store.js';
import {OBJECTIVE_REGISTRY} from '../../src/selection/index.js';
import {canonical} from '../../src/pine-bridge/source.js';
import {PACKAGE_FILES} from '../../src/quant-library/package-gates.js';
import {FIXTURE_LABEL,hex,T0} from '../helpers/quant-library-fixture.mjs';

// QR-4 S2-1: install lifecycle, guards, grants and rollback of the qualified-selection registration tables, proven on a throwaway PostgreSQL
// cluster as real non-owner LOGIN roles with the repo grants. Every row is a LABELLED FIXTURE (synthetic, never a research result).
// The grants come from scripts/grant-postgres-runtime.sql.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501';
const CLI='scripts/migrate-quant-selection.mjs';
let admin,db,rt,dl,tr,connectionString,templateName,databaseName,roleName,deleterName,truncaterName,dbOwnerRole,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every selection writer is SERIALIZABLE (QR003 otherwise): the pools of the writers default to it for autocommit statements and their transactions default to it.
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantScript=async role=>(await fs.readFile(fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url)),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const track=pool=>{pools.push(pool);return pool;};
const sha=value=>createHash('sha256').update(value).digest('hex');

/** A database built from the template (base schema 14, the Pine and research extensions, the exposure register and the package extension; no selection tables). */
async function clone(label){
  const name='robot_qsm_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  return name;
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog. */
async function probe(target,fn){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();},{isolation:'SERIALIZABLE'});}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.oid||':'||c.xmin::text||':'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.oid||':'||k.xmin::text||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
const selectionObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'quant\\_selection\\_%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'quant\\_selection\\_%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'quant\\_selection\\_%') triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0},ALL={relations:16,functions:12,triggers:22};
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'quant\\_selection\\_%' ORDER BY t.tgname`)).rows;
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const allDigests=async target=>Object.fromEntries(await Promise.all(SELECTION_TABLES.map(async table=>[table,await rowDigest(target,table)])));
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;
async function cli(args=[],url=connectionString){
  try{
    const {stdout,stderr}=await run(process.execPath,[CLI,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}});
    return {code:0,stdout,stderr};
  }catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_qsm_tpl_'+suffix;databaseName='robot_qsm_main_'+suffix;
  dbOwnerRole='robot_qsm_dbo_'+suffix.slice(0,14);roleName='robot_qsm_rt_'+suffix.slice(0,14);deleterName='robot_qsm_del_'+suffix.slice(0,14);truncaterName='robot_qsm_trn_'+suffix.slice(0,14);
  for(const name of [roleName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
    await migrateQuantExposureRegister(builder);await migrateBestInputsPackage(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString:serialOf(databaseName),max:6}));
  store=new Store(db);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [roleName,deleterName,truncaterName,dbOwnerRole])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- fixtures: every row is a LABELLED FIXTURE (synthetic, never a research result) ---- */

const MS=60000,DAY=86400000,BASE=Math.floor(Date.now()/MS)*MS;
const POLICY=hex('policy'),ENGINE=hex('engine'),REAL_SCOPE='SPT_CUSTOMER_FIXTURE_SCOPE',OBJECTIVE_ID='qr4-objective-lexi-v1';
const RULES_OBJECT={maximum_drawdown_percent:'25',minimum_closed_trades_test:10};
const RULES=sha(canonical(RULES_OBJECT));
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
// OD-S3: the product registry holds null tie tolerances (the owner has not set them). Every registration here injects a TEST registry.
const TEST_REGISTRY=(()=>{const registry=structuredClone(OBJECTIVE_REGISTRY);registry[OBJECTIVE_ID].tie_tolerances.return_pp='0.5';registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp='0.5';return registry;})();
const SCOPE={market:structuredClone(MARKET),data_model:{data_profile:'spot-klines-1m',price_tick:'0.01',quantity_step:'0.00001'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'5'},
  capital:{equity:'10000',cash:'10000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const range=(fromDays,toDays)=>({start_ms:BASE-fromDays*DAY,end_ms:BASE-toDays*DAY});
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
const qualification=fixture=>({version:'library-qualification-v1',qualified:!fixture,label:fixture?'DEVELOPMENT_ONLY':'QUALIFIED',
  gates:GATES.map(gate=>({gate,name:'N_'+gate,state:fixture&&gate==='G8'?'FAIL':'PASS',code:fixture&&gate==='G8'?'QL4C_VALIDATION_NOT_AVAILABLE':null}))});
const EXPORT_SQL=`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;
const UTC=new Date(T0).toISOString();

async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:'qs-fixture'};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hex(importId),'Selection fixture','//@version=6\nindicator("x")','{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hex(JSON.stringify(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
/** A labelled fixture research run. The contract carries the source hash, the dataset start and the split that readSearchedWindows reads. */
async function newRun(owner,{source=hex('source:'+randomUUID()),start=BASE-40*DAY,split={warmup:0,train_end:600,validation_end:800,test_end:1000},status='SUCCEEDED',contract=null}={}){
  const runId='run-'+randomUUID();
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,[runId,owner.id,owner.deployment,'idem-'+runId,hex('submission'),hex('contract'),
    JSON.stringify(contract??{scope:REAL_SCOPE,label:FIXTURE_LABEL,source_hash:source,dataset:{start_time:start},split}),status,T0,T0+900000]);
  return {runId,source};
}
/** One export of a run taken through the documented path (blobs, export, files, seq 1 event, passing attempt, validation, seq 2). finish: EXPORT_VALIDATED | EXPORT_CANDIDATE | EXPORT_REFUSED. */
async function newExport(owner,run,{fixture=false,mode='ONE_PINE',finish='EXPORT_VALIDATED'}={}){
  const files=Object.fromEntries(PACKAGE_FILES.map(file=>[file,Buffer.from(FIXTURE_LABEL+'\n'+run.runId+'\n'+file+'\n')]));
  const exportId=randomUUID(),packageHash=sha(files['quant-data/manifest.json']),bindingHash=hex('binding:'+exportId);
  await db.transaction(async()=>{
    for(const bytes of Object.values(files))await db.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(bytes),bytes.length,bytes]);
    await db.query(EXPORT_SQL,[exportId,owner.id,owner.id,run.runId,null,mode,mode==='MULTI_PINE',fixture,'best-inputs-gates-v1',JSON.stringify({label:FIXTURE_LABEL}),
      JSON.stringify({owner_id:owner.id,bot_id:owner.id,run_id:run.runId,mode,fixture,created_at:UTC}),bindingHash,packageHash,JSON.stringify({gate:'B0',state:'PASS',codes:[]}),T0,UTC]);
    for(const [file,bytes] of Object.entries(files))await db.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[exportId,file,sha(bytes),bytes.length]);
    await db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,'EXPORT_CANDIDATE','{}',NULL,$2,$3)",[exportId,T0+1,UTC]);
  },{isolation:'SERIALIZABLE'});
  if(finish!=='EXPORT_CANDIDATE'){
    const attemptId='att-'+randomUUID(),pass=finish!=='EXPORT_REFUSED';
    const codes=pass?[]:['BI_NATIVE_SIGNAL_PARITY_FAILED'];
    await db.query(`INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
      VALUES($1,1,$2,$3,$4,$5,'[]','{}',$6,$7,$8)`,[exportId,attemptId,packageHash,pass,codes,hex('validator'),T0+2,UTC]);
    if(finish==='EXPORT_VALIDATED')await db.query(`INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc)
      VALUES($1,$2,$3,$4,'[]',$5,$6,$7,$8)`,[exportId,packageHash,bindingHash,attemptId,hex('validator'),fixture,T0+3,UTC]);
    await db.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,$2,$3,1,$4,$5)',[exportId,finish,codes,T0+4,UTC]);
  }
  return {exportId,packageHash,bindingHash};
}
/** The pure-module universe member of a run and its validated export (the shape src/selection/eligibility.js reads). */
function memberOf(owner,run,exp,i,{fixture=false}={}){
  const binding={mode:'ONE_PINE',fixture,pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i,membership:[{pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:hex('lock'+i)};
  const current={...structuredClone(binding),dataset_available:true,bot_owner_id:owner.id};
  return {kind:'RESEARCH_RUN',owner_id:owner.id,run_id:run.runId,export_id:exp.exportId,created_at_ms:BASE-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:run.source,market:structuredClone(MARKET),
    qualification:qualification(fixture),integrity_checked:true,
    package:{export_id:exp.exportId,package_hash:exp.packageHash,status:'EXPORT_VALIDATED',binding,current,replay_mismatch:false},
    validation_records:[{run_id:run.runId,mode:'ONE_PINE',record:{fixture,export_id:exp.exportId,package_hash:exp.packageHash,binding_hash:exp.bindingHash,validated_at_utc:UTC,
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:structuredClone(SCOPE.data_model),cost_model:structuredClone(SCOPE.cost_model),capital:structuredClone(SCOPE.capital),policy:structuredClone(SCOPE.policy),engine:ENGINE},
    library_class:'READY_FOR_REVIEW',rules_hash:RULES,rules:structuredClone(RULES_OBJECT),
    data_windows:{dataset:range(40,10),train:range(40,32),validation:range(32,26),holdout:range(26,10)},registered_boundary_ms:null};
}
/** n runs with a validated export each for one owner. */
async function newSet(owner,{n=3,fixture=false}={}){
  const runs=[],exports=[],members=[];
  for(let i=1;i<=n;i++){
    const run=await newRun(owner),exp=await newExport(owner,run,{fixture});
    runs.push(run);exports.push(exp);members.push(memberOf(owner,run,exp,i,{fixture}));
  }
  return {runs,exports,members};
}
/** The window opens startDays days after BASE, so a different startDays gives a different registration key. */
const requestOf=(owner,set,{startDays=10,fixture=false,over={}}={})=>({owner_id:owner.id,confirmed:true,fixture,scope:structuredClone(SCOPE),
  window:{kind:'PROSPECTIVE',start_ms:BASE+startDays*DAY,end_ms:BASE+startDays*DAY+1000*MS,warmup_bars:200},objective:{id:OBJECTIVE_ID},
  filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},admission_deadline_ms:BASE+startDays*DAY+1000*MS+DAY,universe:set.members,...over});
const contextOf=(owner,over={})=>({dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},universe_cap:20,requester_owner_id:owner.id,
  policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},objective_registry:TEST_REGISTRY,fixture_selections_allowed:true,...over});
const SELECTION_TABLES_SQL=['quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events'];
const counts=async target=>Object.fromEntries(await Promise.all(SELECTION_TABLES_SQL.map(async table=>[table,(await target.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
const researchDigest=async target=>(await target.query(`SELECT encode(sha256(convert_to((SELECT COALESCE(string_agg(row_to_json(j)::text,'|' ORDER BY j.run_id),'') FROM quant_jobs j)
  ||(SELECT COALESCE(string_agg(row_to_json(e)::text,'|' ORDER BY e.export_id),'') FROM bi_exports e)
  ||(SELECT COALESCE(string_agg(row_to_json(s)::text,'|' ORDER BY s.export_id,s.seq),'') FROM bi_status_events s)
  ||(SELECT COALESCE(string_agg(row_to_json(v)::text,'|' ORDER BY v.export_id),'') FROM ql4c_validation v),'UTF8')),'hex') d`)).rows[0].d;

let OWNER_A,SET_A,FIRST_SELECTION;

/* ---- 1. install lifecycle ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing',async()=>{
  const before=await catalogDigest(db);
  const classification=await classifyQuantSelection(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectQuantSelection(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectQuantSelection(db,{runtimeRole:'no_such_role_qsm'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await selectionObjects(db),NONE);
});

test('absent: a same-name foreign object classifies OTHER, so an install over it would be refused',async()=>{
  const noop="CREATE FUNCTION public.qsm_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign registration table','CREATE TABLE public.quant_selection_registrations(x integer)','TABLE_DEFINITION:quant_selection_registrations:'],
    ['foreign marker table','CREATE TABLE public.quant_selection_schema(version integer)','TABLE_DEFINITION:quant_selection_schema:'],
    ['foreign event table','CREATE TABLE public.quant_selection_status_events(x integer)','TABLE_DEFINITION:quant_selection_status_events:'],
    ['foreign marker function',"CREATE FUNCTION public.quant_selection_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:quant_selection_version:'],
    ['foreign clock function','CREATE FUNCTION public.quant_selection_now_ms() RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$','FUNCTION_DEFINITION:quant_selection_now_ms:'],
    ['overload of the freeze function','CREATE FUNCTION public.quant_selection_insert_only(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:quant_selection_insert_only('],
    ['view carrying an index name','CREATE VIEW public.quant_selection_registrations_pkey AS SELECT 1 AS x','RELATION_UNEXPECTED:quant_selection_registrations_pkey'],
    ['sequence carrying an index name','CREATE SEQUENCE public.quant_selection_universe_pkey','RELATION_UNEXPECTED:quant_selection_universe_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.quant_selection_participants AS integer','TYPE_UNEXPECTED:quant_selection_participants'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER quant_selection_registrations_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.qsm_noop()','TRIGGER_UNEXPECTED:quant_selection_registrations_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyQuantSelection(db),report:await inspectQuantSelection(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await selectionObjects(db),NONE,'every probe was rolled back');
});

test('prerequisites: the install is refused with no write without the research extension, the exposure register or the package extension',async()=>{
  const bareName='robot_qsm_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));
  await bare.migrate();
  await assert.rejects(migrateQuantSelection(bare),/Quant research extension 1 required/);
  await bare.query('CREATE TABLE quant_job_schema(version INTEGER)');await bare.query('INSERT INTO quant_job_schema VALUES(2)');
  await assert.rejects(migrateQuantSelection(bare),/Unsupported quant_job_schema version/);
  const noRegister=track(new PostgresDatabase({connectionString:urlOf(await clone('noreg')),max:2}));
  await noRegister.transaction(async()=>noRegister.query(await sqlText('best-inputs-package-rollback.sql')));
  await noRegister.transaction(async()=>noRegister.query(await sqlText('quant-exposure-register-rollback.sql')));
  await assert.rejects(migrateQuantSelection(noRegister),/Exposure register extension required \(state ABSENT\)/);
  assert.deepEqual(await selectionObjects(noRegister),NONE);
  const noBuilder=track(new PostgresDatabase({connectionString:urlOf(await clone('nobi')),max:2}));
  await noBuilder.transaction(async()=>noBuilder.query(await sqlText('best-inputs-package-rollback.sql')));
  await assert.rejects(migrateQuantSelection(noBuilder),/Best Inputs package extension required \(state ABSENT\)/);
  assert.deepEqual(await selectionObjects(noBuilder),NONE);
  assert.deepEqual(await selectionObjects(bare),NONE);
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, other tables and grants stay as they were; a second install is a no-op',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')
    AND c.relname NOT LIKE 'quant\\_selection\\_%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migrateQuantSelection(db,{runtimeRole:roleName}).catch(error=>error);
  // The runtime role has no grants yet, so only the missing-privilege checks may be reported by an inspection; the install itself does not require grants.
  assert.ok(!(report instanceof Error),String(report));assert.equal(report.ok,true,report.failures?.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,SELECTION_MARKER);assert.equal(report.facts.guards.length,22);
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(name=>!baseTables.includes(name)),
    [...SELECTION_TABLES,'quant_selection_schema'].sort(),'exactly the five selection tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await selectionObjects(db),ALL,'five tables, eleven indexes, twelve functions and twenty-two triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM quant_selection_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.quant_selection_version() v')).rows[0].v,SELECTION_MARKER);
  assert.deepEqual((await guardRows(db)).map(row=>[row.tgname,row.tgenabled,row.tgtype]).sort(),SELECTION_GUARDS.map(item=>[item[0],'A',item[3]]).sort());
  assert.equal(SELECTION_GUARDS.filter(item=>item[2]==='quant_selection_insert_only').length,10,'a row and a statement freeze trigger on each of the five tables');
  assert.equal(SELECTION_GUARDS.filter(item=>item[2]==='quant_selection_require_serializable').length,5,'a SERIALIZABLE insert trigger on each of the five tables');
  assert.equal(SELECTION_GUARDS.filter(item=>item[4]).length,1,'one deferred constraint trigger (C1)');
  assert.ok((await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'quant\\_selection\\_%'`)).rows
    .every(row=>row.prosecdef===false&&row.proconfig.length===1&&row.proconfig[0]==='search_path=pg_catalog, pg_temp'),'every function is SECURITY INVOKER with the pinned search_path');
  // the trigger order: the SERIALIZABLE check fires first, then the clock stamp, then the guard
  const order=(await db.query(`SELECT t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid='public.quant_selection_registrations'::regclass AND (t.tgtype & 6)=6 ORDER BY t.tgname COLLATE "C"`)).rows.map(row=>row.tgname);
  assert.deepEqual(order,['quant_selection_registrations_00_serializable','quant_selection_registrations_01_stamp','quant_selection_registrations_guard']);
  const settled=await catalogDigest(db);
  const again=await migrateQuantSelection(db,{runtimeRole:roleName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyQuantSelection(db)).state,'INSTALLED');
  assert.deepEqual(SELECTION_GUARD_NAMES.filter(name=>!Object.hasOwn(GUARD_REFUSALS,name)),[],'every guard name the SQL raises is mapped by the store');
  // pin: the names the SQL text raises (USING ... CONSTRAINT = '...') equal the migration list and the store map
  const raised=[...new Set([...(await sqlText('quant-selection.sql')).matchAll(/CONSTRAINT = '([a-z0-9_]+)'/g)].map(match=>match[1]))].sort();
  assert.deepEqual(raised,[...SELECTION_GUARD_NAMES].sort(),'the guard names raised by the SQL equal SELECTION_GUARD_NAMES');
  assert.deepEqual(raised,Object.keys(GUARD_REFUSALS).sort(),'the guard names raised by the SQL equal the GUARD_REFUSALS keys');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.qsm_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const R='ALTER TABLE public.quant_selection_registrations ';
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const body=name=>`CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$`;
  const cases=[
    ['freeze body replaced',body('quant_selection_insert_only'),'FUNCTION_DEFINITION:quant_selection_insert_only:BODY'],
    ['status guard body replaced',body('quant_selection_guard_status_event'),'FUNCTION_DEFINITION:quant_selection_guard_status_event:BODY'],
    ['participant guard body replaced',body('quant_selection_guard_participant'),'FUNCTION_DEFINITION:quant_selection_guard_participant:BODY'],
    ['completeness check body replaced',body('quant_selection_check_registration_complete'),'FUNCTION_DEFINITION:quant_selection_check_registration_complete:BODY'],
    ['transition table replaced',"CREATE OR REPLACE FUNCTION public.quant_selection_transitions() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT ARRAY['>REGISTER>SELECTION_REGISTERED>','SELECTION_REGISTERED>OWNER_CANCEL>SELECTION_COMPLETED>']::text[] $$",'FUNCTION_DEFINITION:quant_selection_transitions:BODY'],
    ['clock function replaced',"CREATE OR REPLACE FUNCTION public.quant_selection_now_ms() RETURNS bigint LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 0::bigint $$",'FUNCTION_DEFINITION:quant_selection_now_ms:BODY'],
    ['clock function made STABLE (a frozen clock)','ALTER FUNCTION public.quant_selection_now_ms() STABLE','FUNCTION_DEFINITION:quant_selection_now_ms:ATTRIBUTES'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.quant_selection_guard_status_event() SECURITY DEFINER','FUNCTION_DEFINITION:quant_selection_guard_status_event:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.quant_selection_guard_registration() RESET search_path','FUNCTION_DEFINITION:quant_selection_guard_registration:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.quant_selection_insert_only() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:quant_selection_insert_only:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.quant_selection_insert_only() STRICT','FUNCTION_DEFINITION:quant_selection_insert_only:ATTRIBUTES'],
    ['freeze trigger disabled','ALTER TABLE public.quant_selection_universe DISABLE TRIGGER quant_selection_universe_no_change','TRIGGER_NOT_ALWAYS:quant_selection_universe_no_change'],
    ['guard trigger origin only','ALTER TABLE public.quant_selection_status_events ENABLE TRIGGER quant_selection_status_events_guard','TRIGGER_NOT_ALWAYS:quant_selection_status_events_guard'],
    ['stamp trigger replica only','ALTER TABLE public.quant_selection_registrations ENABLE REPLICA TRIGGER quant_selection_registrations_01_stamp','TRIGGER_NOT_ALWAYS:quant_selection_registrations_01_stamp'],
    ['truncate trigger dropped','DROP TRIGGER quant_selection_participants_no_truncate ON public.quant_selection_participants','TRIGGER_MISSING:quant_selection_participants_no_truncate'],
    ['stamp trigger dropped','DROP TRIGGER quant_selection_status_events_01_stamp ON public.quant_selection_status_events','TRIGGER_MISSING:quant_selection_status_events_01_stamp'],
    ['SERIALIZABLE trigger dropped','DROP TRIGGER quant_selection_registrations_00_serializable ON public.quant_selection_registrations','TRIGGER_MISSING:quant_selection_registrations_00_serializable'],
    ['deferred check dropped','DROP TRIGGER quant_selection_registrations_complete ON public.quant_selection_registrations','TRIGGER_MISSING:quant_selection_registrations_complete'],
    ['deferred check made immediate',`DROP TRIGGER quant_selection_registrations_complete ON public.quant_selection_registrations; CREATE CONSTRAINT TRIGGER quant_selection_registrations_complete AFTER INSERT ON public.quant_selection_registrations FOR EACH ROW EXECUTE FUNCTION public.quant_selection_check_registration_complete(); ${R}ENABLE ALWAYS TRIGGER quant_selection_registrations_complete`,'TRIGGER_SHAPE:quant_selection_registrations_complete'],
    ['deferred check made a plain trigger',`${redo('quant_selection_registrations_complete','quant_selection_registrations','AFTER INSERT','quant_selection_check_registration_complete')} ${R}ENABLE ALWAYS TRIGGER quant_selection_registrations_complete`,'TRIGGER_SHAPE:quant_selection_registrations_complete'],
    ['trigger rebound to the other function',`${redo('quant_selection_registrations_no_change','quant_selection_registrations','BEFORE UPDATE OR DELETE','quant_selection_guard_registration')} ${R}ENABLE ALWAYS TRIGGER quant_selection_registrations_no_change`,'TRIGGER_FUNCTION:quant_selection_registrations_no_change'],
    ['freeze trigger narrowed to UPDATE only',`${redo('quant_selection_registrations_no_change','quant_selection_registrations','BEFORE UPDATE','quant_selection_insert_only')} ${R}ENABLE ALWAYS TRIGGER quant_selection_registrations_no_change`,'TRIGGER_SHAPE:quant_selection_registrations_no_change'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER qsm_marker AFTER INSERT ON public.quant_selection_schema FOR EACH ROW EXECUTE FUNCTION public.qsm_noop()','TRIGGER_UNEXPECTED:qsm_marker'],
    ['extra foreign trigger',noop+' CREATE TRIGGER qsm_extra AFTER INSERT ON public.quant_selection_registrations FOR EACH ROW EXECUTE FUNCTION public.qsm_noop()','TRIGGER_UNEXPECTED:qsm_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER qsm_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.quant_selection_insert_only()','TRIGGER_UNEXPECTED:qsm_elsewhere'],
    ['body hash check dropped',R+'DROP CONSTRAINT quant_selection_registrations_body_hash_check','TABLE_DEFINITION:quant_selection_registrations:CONSTRAINTS'],
    ['tolerance check dropped',R+'DROP CONSTRAINT quant_selection_registrations_body_tolerance_return_check','TABLE_DEFINITION:quant_selection_registrations:CONSTRAINTS'],
    ['participant count check weakened',R+'DROP CONSTRAINT quant_selection_registrations_participant_count_check, ADD CONSTRAINT quant_selection_registrations_participant_count_check CHECK(participant_count>=1)','TABLE_DEFINITION:quant_selection_registrations:CONSTRAINTS'],
    ['market check weakened',R+"DROP CONSTRAINT quant_selection_registrations_market_check, ADD CONSTRAINT quant_selection_registrations_market_check CHECK(broker IS NOT NULL)",'TABLE_DEFINITION:quant_selection_registrations:CONSTRAINTS'],
    ['extra constraint',R+'ADD CONSTRAINT qsm_extra CHECK(start_ms>=0)','TABLE_DEFINITION:quant_selection_registrations:CONSTRAINTS'],
    ['foreign key dropped','ALTER TABLE public.quant_selection_participants DROP CONSTRAINT quant_selection_participants_export_fkey','TABLE_DEFINITION:quant_selection_participants:CONSTRAINTS'],
    ['foreign key made CASCADE',R+'DROP CONSTRAINT quant_selection_registrations_owner_id_fkey, ADD CONSTRAINT quant_selection_registrations_owner_id_fkey FOREIGN KEY(owner_id) REFERENCES public.users(id) ON DELETE CASCADE','TABLE_DEFINITION:quant_selection_registrations:CONSTRAINTS'],
    ['one registration per key dropped',R+'DROP CONSTRAINT quant_selection_registrations_owner_key_key','TABLE_DEFINITION:quant_selection_registrations:'],
    ['one status event per seq dropped','ALTER TABLE public.quant_selection_status_events DROP CONSTRAINT quant_selection_status_events_pkey','TABLE_DEFINITION:quant_selection_status_events:'],
    ['index dropped','DROP INDEX public.quant_selection_registrations_owner_frozen','INDEX_MISSING:quant_selection_registrations_owner_frozen'],
    ['extra index','CREATE INDEX qsm_extra ON public.quant_selection_universe(run_id)','TABLE_DEFINITION:quant_selection_universe:INDEXES'],
    ['column default added',R+'ALTER COLUMN warmup_bars SET DEFAULT 0','TABLE_DEFINITION:quant_selection_registrations:COLUMNS'],
    ['event default dropped','ALTER TABLE public.quant_selection_status_events ALTER COLUMN completed_evaluation_run_ids DROP DEFAULT','TABLE_DEFINITION:quant_selection_status_events:COLUMNS'],
    ['column made optional',R+'ALTER COLUMN body_canonical DROP NOT NULL','TABLE_DEFINITION:quant_selection_registrations:COLUMNS'],
    ['column added',R+'ADD COLUMN extra integer','TABLE_DEFINITION:quant_selection_registrations:COLUMNS'],
    ['column type changed','ALTER TABLE public.quant_selection_participants ALTER COLUMN source_hash TYPE character varying(64)','TABLE_DEFINITION:quant_selection_participants:'],
    ['row security enabled',R+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:quant_selection_registrations:SHAPE'],
    ['rule added','CREATE RULE qsm_rule AS ON INSERT TO public.quant_selection_universe DO ALSO NOTHING','TABLE_DEFINITION:quant_selection_universe:SHAPE'],
    ['marker row removed','DELETE FROM public.quant_selection_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.quant_selection_schema DROP CONSTRAINT quant_selection_schema_version_check','TABLE_DEFINITION:quant_selection_schema:CONSTRAINTS'],
    ['marker table renamed','ALTER TABLE public.quant_selection_schema RENAME TO qsm_renamed','TABLE_MISSING:quant_selection_schema'],
    // Cross-lane rule: every relation and function is owned by the owner of the marker table.
    ['table re-owned to another role','CREATE ROLE qsm_other NOLOGIN; ALTER TABLE public.quant_selection_universe OWNER TO qsm_other','OWNER_MISMATCH:quant_selection_universe'],
    ['function re-owned to another role','CREATE ROLE qsm_other NOLOGIN; ALTER FUNCTION public.quant_selection_guard_universe() OWNER TO qsm_other','OWNER_MISMATCH:quant_selection_guard_universe'],
    ['marker table re-owned (every other object now differs)','CREATE ROLE qsm_other NOLOGIN; ALTER TABLE public.quant_selection_schema OWNER TO qsm_other','OWNER_MISMATCH:quant_selection_registrations']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // A tamper may need the freeze trigger out of the way for its own setup statement (DELETE of the marker row); the probe is rolled back.
      if(label==='marker row removed')await db.query('ALTER TABLE public.quant_selection_schema DISABLE TRIGGER quant_selection_schema_no_change');
      await db.query(statement);return {classification:await classifyQuantSelection(db),report:await inspectQuantSelection(db)};});
    const all=[...found.classification.problems,...found.classification.missing];
    assert.equal(found.classification.state,'OTHER',label+': '+all.join());
    assert.ok(all.some(item=>item.startsWith(prefix)),label+': '+all.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.quant_selection_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectQuantSelection(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:quant_selection_version:BODY')));
  assert.equal((await classifyQuantSelection(db)).state,'INSTALLED','every tamper was rolled back');
});

test('offline only: the install and the rollback need the maintenance lock and their own transaction',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateQuantSelection(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackQuantSelection(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateQuantSelection(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackQuantSelection(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
});

test('a foreign or partial install is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.quant_selection_registrations(x integer)');await foreign.query('INSERT INTO public.quant_selection_registrations VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateQuantSelection(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackQuantSelection(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.quant_selection_registrations')).rows,[{x:7}],'the foreign row survived');
  await migrateQuantSelection(partial);
  await partial.query('DROP TRIGGER quant_selection_participants_no_truncate ON public.quant_selection_participants');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateQuantSelection(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:quant_selection_participants_no_truncate/);
  await assert.rejects(rollbackQuantSelection(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyQuantSelection(partial)).state,'OTHER');
});

/* ---- 2. grants and the runtime role boundary ---- */

test('grants: the repo grant script lists the QR-4 tables; the runtime role gets SELECT and INSERT only on them; the marker is read-only; reapply is idempotent',async()=>{
  // The grant script must list the QR-4 names (the integrator adds them to the repository script: insert_only gets the table names, read_only the marker).
  const text=await grantScript(roleName);
  const listOf=name=>[...new RegExp(name+' CONSTANT TEXT\\[\\] := ARRAY\\[([^\\]]*)\\]').exec(text)[1].matchAll(/'([a-z0-9_]+)'/g)].map(item=>item[1]);
  const insertOnly=listOf('insert_only'),readOnly=listOf('read_only'),protectedList=listOf('protected');
  assert.deepEqual(SELECTION_GRANT_TABLES.filter(name=>!insertOnly.includes(name)),[],'every QR-4 table name is in the insert_only list of the grant script');
  assert.ok(readOnly.includes('quant_selection_schema'),'the marker table is in the read_only list');
  assert.ok(!SELECTION_GRANT_TABLES.some(name=>protectedList.includes(name)||readOnly.includes(name))&&!protectedList.includes('quant_selection_schema'),'no QR-4 name is in a second list');
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  // Layer-2 proof roles: the deleter also holds UPDATE and DELETE, the truncater TRUNCATE, on every selection table.
  const all=[...SELECTION_TABLES,'quant_selection_schema'].map(table=>'public.'+table).join(',');
  await db.query(`GRANT UPDATE,DELETE ON TABLE ${all} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${all} TO ${truncaterName}`);
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:6})));
  dl=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,deleterName),max:3})));tr=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,truncaterName),max:2})));
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  await db.query(`GRANT UPDATE,DELETE ON TABLE ${all} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${all} TO ${truncaterName}`);
  assert.equal(await acl(),first,'a second application of the grant script changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger
    FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  for(const table of SELECTION_TABLES)assert.deepEqual(await facts(roleName,'public.'+table),{owner:false,select:true,insert:true,update:false,delete:false,truncate:false,trigger:false},table);
  assert.deepEqual(await facts(roleName,'public.quant_selection_schema'),{owner:false,select:true,insert:false,update:false,delete:false,truncate:false,trigger:false},'the marker table is read-only');
  assert.equal((await facts(deleterName,'public.quant_selection_registrations')).delete,true);assert.equal((await facts(truncaterName,'public.quant_selection_registrations')).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // inspect with the runtime role passes, and names the role that broke the boundary (the privilege checks are the shared inspection module)
  const ok=await inspectQuantSelection(db,{runtimeRole:roleName});assert.equal(ok.ok,true,ok.failures.join());
  assert.equal(ok.facts.runtime_role.tables.length,5);assert.deepEqual(ok.facts.runtime_role.privileged_members,[]);
  const deleter=await inspectQuantSelection(db,{runtimeRole:deleterName});
  assert.ok(deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_selection_registrations:DELETE')&&deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_selection_registrations:UPDATE'),deleter.failures.join());
  assert.ok(deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_selection_schema:DELETE'));
  assert.ok((await inspectQuantSelection(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:quant_selection_registrations'));
  const adminRole=decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).username);
  assert.ok(adminRole.length>0);
  assert.ok((await inspectQuantSelection(db,{runtimeRole:adminRole})).failures.some(item=>item.startsWith('RUNTIME_ROLE_SUPERUSER')||item.startsWith('RUNTIME_ROLE_OWNS:')));
  // Membership of the owning role counts as ownership, for the tables and for each function (all rolled back).
  const ownerRole=(await db.query('SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=$1::regclass',['public.quant_selection_registrations'])).rows[0].o;
  const memberOf=await probe(db,async()=>{
    await db.query('CREATE ROLE qsm_member NOLOGIN');await db.query('GRANT '+ownerRole+' TO qsm_member');
    return inspectQuantSelection(db,{runtimeRole:'qsm_member'});
  });
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS:quant_selection_registrations')&&memberOf.failures.includes('RUNTIME_ROLE_OWNS:quant_selection_schema'),memberOf.failures.join());
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS_FUNCTION:quant_selection_insert_only'),memberOf.failures.join());
  const privileged=await probe(db,async()=>{
    await db.query('CREATE ROLE qsm_super NOLOGIN SUPERUSER');await db.query('CREATE ROLE qsm_viasuper NOLOGIN NOINHERIT');await db.query('GRANT qsm_super TO qsm_viasuper');
    await db.query('CREATE ROLE qsm_holder NOLOGIN');await db.query('GRANT UPDATE (position) ON TABLE public.quant_selection_universe TO qsm_holder');
    await db.query('CREATE ROLE qsm_colmember NOLOGIN NOINHERIT');await db.query('GRANT qsm_holder TO qsm_colmember');
    await db.query('CREATE ROLE qsm_creator NOLOGIN');await db.query('GRANT CREATE ON SCHEMA public TO qsm_creator');
    return {viaSuper:await inspectQuantSelection(db,{runtimeRole:'qsm_viasuper',requireGrants:false}),column:await inspectQuantSelection(db,{runtimeRole:'qsm_colmember',requireGrants:false}),
      create:await inspectQuantSelection(db,{runtimeRole:'qsm_creator',requireGrants:false})};
  });
  assert.ok(privileged.viaSuper.failures.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:qsm_super'),privileged.viaSuper.failures.join());
  assert.ok(privileged.column.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_selection_universe:UPDATE'),privileged.column.failures.join());
  assert.ok(privileged.create.failures.includes('RUNTIME_ROLE_SCHEMA_CREATE'),privileged.create.failures.join());
  // The role cannot disable a guard, replace a function or change the replication role.
  await refused(rt.query('ALTER TABLE public.quant_selection_registrations DISABLE TRIGGER quant_selection_registrations_no_change'),DENIED);
  await refused(rt.query('ALTER TABLE public.quant_selection_status_events DISABLE TRIGGER ALL'),DENIED);
  await refused(rt.query('DROP TRIGGER quant_selection_status_events_guard ON public.quant_selection_status_events'),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.quant_selection_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query('DROP TABLE public.quant_selection_registrations'),DENIED);
  await refused(rt.query('INSERT INTO public.quant_selection_schema VALUES(2)'),DENIED);await refused(rt.query('UPDATE public.quant_selection_schema SET version=1'),DENIED);await refused(rt.query('DELETE FROM public.quant_selection_schema'),DENIED);
  assert.equal((await classifyQuantSelection(db)).state,'INSTALLED');
});

/* ---- 3. SERIALIZABLE only, insert-only, TEMP shadows ---- */

test('SERIALIZABLE only: an INSERT into any selection table under READ COMMITTED or REPEATABLE READ is refused with QR003, before any other check',async()=>{
  for(const table of [...SELECTION_TABLES,'quant_selection_schema'])
    for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
      await assert.rejects(db.transaction(async()=>db.query(`INSERT INTO public.${table} DEFAULT VALUES`),{isolation}),{code:QR003},table+' '+isolation);
  assert.deepEqual(await counts(db),{quant_selection_registrations:0,quant_selection_universe:0,quant_selection_participants:0,quant_selection_status_events:0});
});

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers on every table; the replication role cannot skip a guard; no row changes',async()=>{
  OWNER_A=await newOwner('qsm-a');SET_A=await newSet(OWNER_A,{n:3});
  FIRST_SELECTION=await registerSelection(rt,{request:requestOf(OWNER_A,SET_A,{startDays:10}),context:contextOf(OWNER_A)});
  assert.equal(FIRST_SELECTION.ok,true,JSON.stringify(FIRST_SELECTION));
  const digests=await allDigests(db);
  assert.deepEqual(Object.values(digests).map(item=>item.n),[1,3,3,1]);
  const columns={quant_selection_registrations:'owner_id',quant_selection_universe:'run_id',quant_selection_participants:'run_id',quant_selection_status_events:'event',quant_selection_schema:'version'};
  for(const [table,column] of Object.entries(columns)){
    // layer 1: the runtime role has no UPDATE, DELETE or TRUNCATE privilege
    await refused(rt.query(`UPDATE public.${table} SET ${column}=${column}`),DENIED);await refused(rt.query(`DELETE FROM public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table} CASCADE`),DENIED);
    // layer 2: a role that holds the privilege meets the trigger
    await refused(dl.query(`UPDATE public.${table} SET ${column}=${column}`),QR002);await refused(dl.query(`DELETE FROM public.${table}`),QR002);// A table referenced by a foreign key refuses a plain TRUNCATE with 0A000 before any trigger runs; CASCADE reaches every freeze trigger.
    await assert.rejects(tr.query(`TRUNCATE public.${table}`),error=>[QR002,'0A000'].includes(error.code),table+' plain truncate');
    await refused(tr.query(`TRUNCATE TABLE public.${table} RESTART IDENTITY CASCADE`),QR002);
    // layer 2 for the owner too, also with the replication role (every trigger is ENABLE ALWAYS)
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`UPDATE public.${table} SET ${column}=${column}`);}),QR002);
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`DELETE FROM public.${table}`);}),QR002);
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`TRUNCATE public.${table} CASCADE`);}),QR002);
  }
  const after=await allDigests(db);
  assert.deepEqual(after,digests,'no row changed');
  assert.deepEqual((await db.query('SELECT version FROM quant_selection_schema')).rows,[{version:1}]);
});

test('a session TEMP table named like a selection table fools neither the guards nor the freeze',async()=>{
  // The guards qualify every relation. A TEMP registrations table holding a fake selection must not satisfy the status guard (public.* is read).
  const fake=randomUUID();
  await refused(rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE quant_selection_registrations(selection_id uuid)');
    await rt.query('INSERT INTO quant_selection_registrations VALUES($1)',[fake]);
    await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,1,'REGISTER','SELECTION_REGISTERED',NULL,NULL,NULL,'{}')",[fake]);
  }),QR004);
  assert.equal((await counts(db)).quant_selection_status_events,1);
});

test('the clock function is the database clock: quant_selection_now_ms is within seconds of the host clock and never earlier than the transaction start',async()=>{
  const before=Date.now(),value=Number((await db.query('SELECT public.quant_selection_now_ms() AS n')).rows[0].n),after=Date.now();
  assert.ok(value>=before-2000&&value<=after+2000,String(value));
  const [first,second]=await db.transaction(async()=>{
    const a=Number((await db.query('SELECT public.quant_selection_now_ms() AS n')).rows[0].n);await new Promise(resolve=>setTimeout(resolve,30));
    return [a,Number((await db.query('SELECT public.quant_selection_now_ms() AS n')).rows[0].n)];
  },{isolation:'SERIALIZABLE'});
  assert.ok(second>first,'clock_timestamp advances inside one transaction');
});

/* ---- 4. rollback ---- */

test('rollback: empty tables are dropped completely; a selection row, or a QR4_SELECTION register row, refuses and changes nothing',async()=>{
  // a database that holds a selection (the main database, registered above)
  const before=await catalogDigest(db),rowsBefore=await allDigests(db);
  await assert.rejects(rollbackQuantSelection(db),/rollback refused; \d+ evidence row\(s\) exist in .*quant_selection_registrations.*\(no change made\)/);
  assert.deepEqual(await catalogDigest(db),before);assert.deepEqual(await allDigests(db),rowsBefore);assert.equal((await classifyQuantSelection(db)).state,'INSTALLED');
  // a database whose selection tables are empty but whose register holds a QR4_SELECTION row
  const exposedName=await clone('exposed');
  const exposed=track(new PostgresDatabase({connectionString:serialOf(exposedName),max:3}));
  await migrateQuantSelection(exposed);
  const owner=await new Store(exposed).createUser({email:'qsm-exposed-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  await exposed.transaction(async()=>appendExposures(exposed,{owner_id:owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:BASE+50*DAY,end_ms:BASE+50*DAY+MS},selection_id:randomUUID()}]}),{isolation:'SERIALIZABLE'});
  const exposedBefore=await catalogDigest(exposed);
  await assert.rejects(rollbackQuantSelection(exposed),/rollback refused; 1 QR4_SELECTION exposure register row\(s\) exist \(no change made\)/);
  assert.deepEqual(await catalogDigest(exposed),exposedBefore);assert.equal((await classifyQuantSelection(exposed)).state,'INSTALLED');
  assert.equal((await exposed.query("SELECT count(*)::int n FROM public.quant_exposure_register WHERE kind='QR4_SELECTION'")).rows[0].n,1,'the register row is untouched');
  // an empty install is dropped completely, a second rollback is a no-op, and the install works again
  const emptyName=await clone('empty');
  const empty=track(new PostgresDatabase({connectionString:urlOf(emptyName),max:2}));
  await migrateQuantSelection(empty);
  const rolled=await rollbackQuantSelection(empty);
  assert.deepEqual([rolled.rolled_back,rolled.previous_state],[true,'INSTALLED']);
  assert.deepEqual(await selectionObjects(empty),NONE);
  assert.equal((await rollbackQuantSelection(empty)).previous_state,'ABSENT');
  assert.equal((await migrateQuantSelection(empty)).previous_state,'ABSENT');
  assert.deepEqual(await selectionObjects(empty),ALL);
  assert.equal((await classifyQuantSelection(empty)).state,'INSTALLED');
});

/* ---- 5. the CLI ---- */

test('the CLI: install, second install, --inspect exit codes, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=track(new PostgresDatabase({connectionString:cliUrl,max:2}));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  const badRole=await inspect(['--runtime-role=no_such_role_qsm']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/Quant selection tables ready: quant-selection-v1; state=INSTALLED; previous state=ABSENT; guards=22/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  const ungranted=await inspect(['--runtime-role='+roleName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:quant_selection_registrations:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(roleName));
  const granted=await inspect(['--runtime-role='+roleName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.filter(item=>item.table==='quant_selection_registrations'||item.table==='quant_selection_schema').map(item=>[item.table,item.insert,item.update,item.delete]).sort(),
    [['quant_selection_registrations',true,false,false],['quant_selection_schema',false,false,false]]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.quant_selection_registrations DISABLE TRIGGER quant_selection_registrations_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.quant_selection_registrations ENABLE ALWAYS TRIGGER quant_selection_registrations_no_change');
  assert.equal((await inspect()).code,0);
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--bogus'],['--runtime-role=Bad-Name']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await selectionObjects(cliDb),NONE);
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
  // the install refuses without the prerequisite extensions (exit nonzero, no write)
  const bareUrl=urlOf(await clone('clibare'));
  const bareDb=track(new PostgresDatabase({connectionString:bareUrl,max:2}));
  await bareDb.transaction(async()=>bareDb.query(await sqlText('best-inputs-package-rollback.sql')));
  const noBuilder=await cli([],bareUrl);assert.notEqual(noBuilder.code,0);assert.match(noBuilder.stderr,/Best Inputs package extension required/);
  assert.deepEqual(await selectionObjects(bareDb),NONE);
});

/* ---- 6. dump and restore ---- */

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS, the deferred check, the rows and the database-stamped values',async t=>{
  const restoredName='robot_qsm_restore_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-qsm-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'qsm.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=track(new PostgresDatabase({connectionString:serialOf(restoredName)})),restoredDeleter=track(new PostgresDatabase({connectionString:serialOf(restoredName,deleterName)}));
  const restoredRuntime=ser(track(new PostgresDatabase({connectionString:serialOf(restoredName,roleName)})));
  assert.deepEqual(await guardRows(restored),await guardRows(db));assert.equal((await guardRows(restored)).length,22);assert.ok((await guardRows(restored)).every(row=>row.tgenabled==='A'));
  assert.deepEqual(await allDigests(restored),await allDigests(db),'every stored row came back, frozen_at_ms and at_ms included');
  assert.equal((await classifyQuantSelection(restored)).state,'INSTALLED');
  const report=await inspectQuantSelection(restored,{runtimeRole:roleName});assert.equal(report.ok,true,report.failures.join());
  await refused(restoredRuntime.query('UPDATE public.quant_selection_registrations SET fixture=fixture'),DENIED);
  await refused(restoredDeleter.query('UPDATE public.quant_selection_registrations SET fixture=fixture'),QR002);
  await refused(restoredDeleter.query('DELETE FROM public.quant_selection_status_events'),QR002);
  // the insert guards and the deferred check survive the restore: an event without a registration meets QR004, and a registration without its children fails at commit (C1)
  await assert.rejects(restoredRuntime.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,1,'REGISTER','SELECTION_REGISTERED',NULL,NULL,NULL,'{}')",[randomUUID()]),
    error=>error.code===QR004&&error.constraint==='quant_selection_status_transition');
  const old=(await restored.query('SELECT * FROM public.quant_selection_registrations LIMIT 1')).rows[0];
  // The hashed time is read from the database clock of the restored database, so the 60 s clock guard passes whatever the age of the stored row.
  const clock=Number((await restored.query('SELECT public.quant_selection_now_ms() AS n')).rows[0].n);
  const fresh=JSON.parse(old.body_canonical);fresh.selection_id=randomUUID();fresh.registration_key=sha('restore-key');fresh.registered_at_ms=clock;
  const text=canonical(fresh);
  await assert.rejects(restoredRuntime.transaction(async()=>restoredRuntime.query(`INSERT INTO public.quant_selection_registrations(selection_id,owner_id,fixture,broker,symbol,timeframe,window_kind,start_ms,end_ms,warmup_bars,
    evaluation_bars,total_bars,participant_count,admission_deadline_ms,registered_at_ms,registration_key,registration_hash,body_canonical) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [fresh.selection_id,old.owner_id,old.fixture,old.broker,old.symbol,old.timeframe,old.window_kind,old.start_ms,old.end_ms,old.warmup_bars,old.evaluation_bars,old.total_bars,old.participant_count,
      old.admission_deadline_ms,clock,fresh.registration_key,sha(text),text])),error=>error.code===QR004&&error.constraint==='quant_selection_registration_complete');
});
