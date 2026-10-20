import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {PACKAGE_GUARDS,PACKAGE_MARKER,PACKAGE_TABLES,INSERT_ONLY_SQLSTATE,INSERT_GUARD_SQLSTATE,SERIALIZABLE_SQLSTATE,classifyBestInputsPackage,inspectBestInputsPackage,
  migrateBestInputsPackage,rollbackBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {PACKAGE_FILES,TRACE_FILES,CANDIDATE_BLOCKERS,MAX_VALIDATION_ATTEMPTS,ENGINEERING_SCOPE,RETRYABLE_CODES} from '../../src/quant-library/package-gates.js';
import {FIXTURE_LABEL,hex,T0} from '../helpers/quant-library-fixture.mjs';

// F09 builder slice S2: the insert-only Best Inputs package tables, proven on a throwaway PostgreSQL cluster as real non-owner LOGIN roles with
// the repo grants. Every row is a LABELLED FIXTURE (synthetic, never a research result). Rows are insert-only, so each test uses its own export.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,SERIALIZATION_FAILURE='40001',DENIED='42501',CHECK_VIOLATION='23514',FK_VIOLATION='23503',UNIQUE_VIOLATION='23505';
const CLI='scripts/migrate-best-inputs-package.mjs';
const REAL_SCOPE='SPT_CUSTOMER_FIXTURE_SCOPE';
const MIB=1048576;
let admin,db,rt,rt2,dl,tr,connectionString,templateName,databaseName,roleName,deleterName,truncaterName,dbOwnerRole,store,OWNER_A,OWNER_B;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every package writer is SERIALIZABLE (QR003 otherwise): the pools of the writers default to it for autocommit statements (a connection option)
// and their transactions default to it (ser). A test that proves a refusal opens its transaction at another level explicitly.
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const refusedWith=(promise,code,message)=>assert.rejects(promise,error=>error.code===code&&message.test(error.message));
const track=pool=>{pools.push(pool);return pool;};
const sha=value=>createHash('sha256').update(value).digest('hex');
let savepoints=0;
/** Runs fn inside the current transaction behind a savepoint; returns the SQLSTATE of its failure (and rolls back to the savepoint), or null. */
async function codeOf(target,fn){
  const name='sp'+(++savepoints);await target.query('SAVEPOINT '+name);
  try{await fn();await target.query('RELEASE SAVEPOINT '+name);return null;}catch(error){await target.query('ROLLBACK TO SAVEPOINT '+name);return error.code;}
}
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}

/** A database built from the template (base schema 14 plus the Pine and research extensions, no package tables). */
async function clone(label){
  const name='robot_s2b_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
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
const packageObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND (relname LIKE 'bi\\_%' OR relname LIKE 'ql4c\\_validation%')) relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'bi\\_%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE 'bi\\_%' OR tgname LIKE 'ql4c\\_validation%')) triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0},ALL={relations:30,functions:14,triggers:44};
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgname LIKE 'bi\\_%' OR t.tgname LIKE 'ql4c\\_validation%') ORDER BY t.tgname`)).rows;
// bi_blobs rows are digested by hash and size (the CHECKs tie the content to both), so a 16 MiB blob is never serialised.
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(${table==='bi_blobs'?"t.sha256||':'||t.size":'row_to_json(t)::text'},'|' ORDER BY ${table==='bi_blobs'?'t.sha256':'row_to_json(t)::text'}),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const allDigests=async target=>Object.fromEntries(await Promise.all(PACKAGE_TABLES.map(async table=>[table,await rowDigest(target,table)])));
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;

async function newOwner(label,target=db,targetStore=store){
  const user=await targetStore.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:'bi-fixture'};
  await target.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hex(importId),'Package fixture','//@version=6\nindicator("x")','{}',T0]);
  await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hex(JSON.stringify(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
/** A labelled fixture research run, written directly (the freeze extension is not installed here). */
async function newRun(owner,{status='SUCCEEDED',scope=ENGINEERING_SCOPE,target=db,contract=null}={}){
  const runId='run-'+randomUUID();
  await target.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,[runId,owner.id,owner.deployment,'idem-'+runId,hex('submission'),hex('contract'),JSON.stringify(contract??{scope,label:FIXTURE_LABEL}),status,T0,T0+900000]);
  return runId;
}

/* ---- package builders (labelled fixtures) ---- */

const contentOf=(tag,file)=>Buffer.from(FIXTURE_LABEL+'\n'+tag+'\n'+file+'\n');
const filesOf=tag=>Object.fromEntries(PACKAGE_FILES.map(file=>[file,contentOf(tag,file)]));
const UTC=new Date(T0).toISOString();
const EXPORT_SQL=`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;
/** The row of one export. over replaces columns, bindingOver replaces binding fields. */
function exportRow({owner,runId,botId=owner.id,mode='ONE_PINE',fixture=true,files,over={},bindingOver={}}){
  const exportId=over.export_id??randomUUID();
  const row={export_id:exportId,owner_id:owner.id,bot_id:botId,run_id:runId,parent_export_id:null,mode,internal:mode==='MULTI_PINE',fixture,gate_version:'best-inputs-gates-v1',
    library_versions:{label:FIXTURE_LABEL},binding:{owner_id:owner.id,bot_id:botId,run_id:runId,mode,fixture,created_at:UTC,...bindingOver},
    binding_hash:hex('binding:'+exportId),package_hash:sha(files['quant-data/manifest.json']),b0:{gate:'B0',state:'PASS',codes:[]},created_at:T0,created_at_utc:UTC,...over};
  return row;
}
const exportValues=row=>[row.export_id,row.owner_id,row.bot_id,row.run_id,row.parent_export_id,row.mode,row.internal,row.fixture,row.gate_version,JSON.stringify(row.library_versions),
  JSON.stringify(row.binding),row.binding_hash,row.package_hash,JSON.stringify(row.b0),row.created_at,row.created_at_utc];
const insertBlob=(target,bytes)=>target.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(bytes),bytes.length,bytes]);
const insertFile=(target,exportId,file,bytes)=>target.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[exportId,file,sha(bytes),bytes.length]);
const insertEvent=(target,exportId,seq,status,attemptNo=null,codes=[],over={})=>target.query(
  'INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [exportId,over.seq??seq,over.status??status,over.codes??codes,over.attempt_no??attemptNo,T0+seq,UTC]);
/** One transaction, in the documented insert order: blobs, export, files, then the seq 1 EXPORT_CANDIDATE event. */
async function buildExport(target,{owner=OWNER_A,scope=ENGINEERING_SCOPE,fixture=true,mode='ONE_PINE',runStatus='SUCCEEDED',botId,runId,tag=randomUUID(),events=true,withFiles=true,isolation='SERIALIZABLE',over={},bindingOver={}}={}){
  const files=filesOf(tag),run_id=runId??await newRun(owner,{status:runStatus,scope});
  const row=exportRow({owner,runId:run_id,botId,mode,fixture,files,over,bindingOver});
  await target.transaction(async()=>{
    if(withFiles)for(const bytes of Object.values(files))await insertBlob(target,bytes);
    await target.query(EXPORT_SQL,exportValues(row));
    if(withFiles)for(const [file,bytes] of Object.entries(files))await insertFile(target,row.export_id,file,bytes);
    if(events)await insertEvent(target,row.export_id,1,'EXPORT_CANDIDATE');
  },{isolation});
  return {...row,exportId:row.export_id,files,attempts:0,events:1};
}
const RETRYABLE=['BI_PARITY_EVIDENCE_MISSING'];
/** One validation attempt row; a passing attempt has no codes (CHECK). */
async function attempt(target,pack,{no=pack.attempts+1,pass=false,codes=pass?[]:RETRYABLE,over={}}={}){
  const id=over.attempt_id??'att-'+randomUUID();
  await target.query(`INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[pack.exportId,over.attempt_no??no,id,over.package_hash??pack.package_hash,over.pass??pass,over.codes??codes,'[]','{}',over.validator_engine_hash??hex('validator'),T0+no,UTC]);
  pack.attempts=no;pack.lastAttempt=id;
  return id;
}
const validationValues=(pack,attemptId,over={})=>[pack.exportId,over.package_hash??pack.package_hash,over.binding_hash??pack.binding_hash,over.attempt_id??attemptId,'[]',over.validator_engine_hash??hex('validator'),over.fixture??pack.fixture,T0,UTC];
const validation=(target,pack,attemptId,over={})=>target.query(`INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,validationValues(pack,attemptId,over));
const compileRecord=(target,exportId,over={})=>target.query(`INSERT INTO public.bi_compile_records(export_id,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,duplicate_bindings,mapping_check,compiled_at_ms,compiled_at_utc,operator_role,method)
  VALUES($1,$2,'6','[]','[]',0,0,0,'[{"slot":"s1","pine_variable":"v1"}]',$3,$4,'root-coordinator','tradingview-compile-serial-step')`,[over.export_id??exportId,hex('indicator'),T0,UTC]);
const evidenceRecord=(target,exportId,kind='native_parity',record={scope:{}},hash=hex('evidence:'+kind))=>target.query(
  'INSERT INTO public.bi_evidence_records(export_id,kind,record,evidence_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5)',[exportId,kind,JSON.stringify(record),hash,T0]);
const clearance=(target,pack,over={})=>target.query('INSERT INTO public.bi_clearances(export_id,blocker,run_id,parameter_hash,evidence_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5,$6)',
  [pack.exportId,over.blocker??CANDIDATE_BLOCKERS[0],over.run_id??pack.run_id,hex('parameters'),over.evidence_hash??hex('evidence:native_parity'),T0]);
const traceRecord=(target,exportId,file=TRACE_FILES[0],over={})=>target.query(`INSERT INTO public.bi_trace_reproductions(export_id,path,sha256,steps_digest,holdout_digest,trace_engine_hash,run_engine_hash,recorded_at_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[exportId,over.path??file,hex('trace'),hex('steps'),hex('holdout'),hex('trace-engine'),hex('run-engine'),T0]);
/** A one-Pine export taken to a terminal status through the documented path (as the runtime role). */
async function terminal(kind,target=rt,over={}){
  const mode=kind==='EXPORT_INTERNAL'?'MULTI_PINE':'ONE_PINE',pack=await buildExport(target,{mode,...over});
  if(kind==='EXPORT_VALIDATED'){const id=await attempt(target,pack,{pass:true});await validation(target,pack,id);await insertEvent(target,pack.exportId,2,kind,1);}
  else if(kind==='EXPORT_INTERNAL'){await attempt(target,pack,{pass:true});await insertEvent(target,pack.exportId,2,kind,1);}
  else{await attempt(target,pack,{codes:['BI_NATIVE_SIGNAL_PARITY_FAILED']});await insertEvent(target,pack.exportId,2,kind,1,['BI_NATIVE_SIGNAL_PARITY_FAILED']);}
  return pack;
}
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
  templateName='robot_s2b_tpl_'+suffix;databaseName='robot_s2b_main_'+suffix;
  dbOwnerRole='robot_s2b_dbo_'+suffix.slice(0,14);roleName='robot_s2b_rt_'+suffix.slice(0,14);deleterName='robot_s2b_del_'+suffix.slice(0,14);truncaterName='robot_s2b_trn_'+suffix.slice(0,14);
  for(const name of [roleName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
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

/* ---- 1. install lifecycle ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing',async()=>{
  const before=await catalogDigest(db);
  const classification=await classifyBestInputsPackage(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectBestInputsPackage(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectBestInputsPackage(db,{runtimeRole:'no_such_role_s2b'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await packageObjects(db),NONE);
});

test('absent: a same-name foreign object classifies OTHER, so an install over it would be refused',async()=>{
  const noop="CREATE FUNCTION public.s2b_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign export table','CREATE TABLE public.bi_exports(x integer)','TABLE_DEFINITION:bi_exports:'],
    ['foreign marker table','CREATE TABLE public.bi_package_schema(version integer)','TABLE_DEFINITION:bi_package_schema:'],
    ['foreign validation table','CREATE TABLE public.ql4c_validation(x integer)','TABLE_DEFINITION:ql4c_validation:'],
    ['foreign marker function',"CREATE FUNCTION public.bi_package_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:bi_package_version:'],
    ['overload of the freeze function','CREATE FUNCTION public.bi_freeze(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:bi_freeze('],
    ['view carrying an index name','CREATE VIEW public.bi_exports_pkey AS SELECT 1 AS x','RELATION_UNEXPECTED:bi_exports_pkey'],
    ['sequence carrying an index name','CREATE SEQUENCE public.bi_blobs_pkey','RELATION_UNEXPECTED:bi_blobs_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.bi_attempts AS integer','TYPE_UNEXPECTED:bi_attempts'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER bi_exports_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.s2b_noop()','TRIGGER_UNEXPECTED:bi_exports_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyBestInputsPackage(db),report:await inspectBestInputsPackage(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await packageObjects(db),NONE,'every probe was rolled back');
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, tables and grants stay as they were; a second install is a no-op',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')
    AND c.relname NOT LIKE 'bi\\_%' AND c.relname NOT LIKE 'ql4c\\_validation%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migrateBestInputsPackage(db,{runtimeRole:roleName}).catch(error=>error);
  // The runtime role has no grants yet, so only the missing-privilege checks may be reported by an inspection; the install itself does not require grants.
  assert.ok(!(report instanceof Error),String(report));assert.equal(report.ok,true,report.failures?.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,PACKAGE_MARKER);assert.equal(report.facts.guards.length,44);
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(name=>!baseTables.includes(name)),
    [...PACKAGE_TABLES,'bi_package_schema'].sort(),'exactly the eleven package tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await packageObjects(db),ALL,'eleven tables, nineteen indexes, fourteen functions and forty-four triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM bi_package_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.bi_package_version() v')).rows[0].v,PACKAGE_MARKER);
  assert.deepEqual((await guardRows(db)).map(row=>[row.tgname,row.tgenabled,row.tgtype]).sort(),PACKAGE_GUARDS.map(item=>[item[0],'A',item[3]]).sort());
  assert.equal(PACKAGE_GUARDS.filter(item=>item[2]==='bi_freeze').length,22,'a row and a statement freeze trigger on each of the eleven tables');
  assert.equal(PACKAGE_GUARDS.filter(item=>item[2]==='bi_require_serializable').length,11,'a SERIALIZABLE insert trigger on each of the eleven tables');
  assert.ok((await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'bi\\_%'`)).rows
    .every(row=>row.prosecdef===false&&row.proconfig.length===1&&row.proconfig[0]==='search_path=pg_catalog, pg_temp'),'every function is SECURITY INVOKER with the pinned search_path');
  const settled=await catalogDigest(db);
  const again=await migrateBestInputsPackage(db,{runtimeRole:roleName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyBestInputsPackage(db)).state,'INSTALLED');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.s2b_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const T='ALTER TABLE public.bi_exports ';
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const cases=[
    ['freeze body replaced',"CREATE OR REPLACE FUNCTION public.bi_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:bi_freeze:BODY'],
    ['status guard body replaced',"CREATE OR REPLACE FUNCTION public.bi_guard_status_event() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:bi_guard_status_event:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.bi_guard_status_event() SECURITY DEFINER','FUNCTION_DEFINITION:bi_guard_status_event:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.bi_guard_attempt() RESET search_path','FUNCTION_DEFINITION:bi_guard_attempt:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.bi_freeze() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:bi_freeze:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.bi_freeze() STRICT','FUNCTION_DEFINITION:bi_freeze:ATTRIBUTES'],
    ['latest-status reader made STABLE (a stale snapshot)','ALTER FUNCTION public.bi_latest_status(uuid) STABLE','FUNCTION_DEFINITION:bi_latest_status:ATTRIBUTES'],
    ['lock function replaced',"CREATE OR REPLACE FUNCTION public.bi_lock_export(p_export uuid) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN NULL; END $$",'FUNCTION_DEFINITION:bi_lock_export:BODY'],
    ['freeze trigger disabled','ALTER TABLE public.bi_attempts DISABLE TRIGGER bi_attempts_no_change','TRIGGER_NOT_ALWAYS:bi_attempts_no_change'],
    ['guard trigger origin only','ALTER TABLE public.bi_status_events ENABLE TRIGGER bi_status_events_guard','TRIGGER_NOT_ALWAYS:bi_status_events_guard'],
    ['trigger replica only','ALTER TABLE public.bi_blobs ENABLE REPLICA TRIGGER bi_blobs_no_truncate','TRIGGER_NOT_ALWAYS:bi_blobs_no_truncate'],
    ['truncate trigger dropped','DROP TRIGGER ql4c_validation_no_truncate ON public.ql4c_validation','TRIGGER_MISSING:ql4c_validation_no_truncate'],
    ['deferred check dropped','DROP TRIGGER bi_exports_complete ON public.bi_exports','TRIGGER_MISSING:bi_exports_complete'],
    ['deferred check made immediate',`DROP TRIGGER bi_exports_complete ON public.bi_exports; CREATE CONSTRAINT TRIGGER bi_exports_complete AFTER INSERT ON public.bi_exports FOR EACH ROW EXECUTE FUNCTION public.bi_guard_export_complete(); ${T}ENABLE ALWAYS TRIGGER bi_exports_complete`,'TRIGGER_SHAPE:bi_exports_complete'],
    ['deferred check made a plain trigger',`${redo('bi_exports_complete','bi_exports','AFTER INSERT','bi_guard_export_complete')} ${T}ENABLE ALWAYS TRIGGER bi_exports_complete`,'TRIGGER_SHAPE:bi_exports_complete'],
    ['trigger rebound to the other function',`${redo('bi_exports_no_change','bi_exports','BEFORE UPDATE OR DELETE','bi_guard_export')} ${T}ENABLE ALWAYS TRIGGER bi_exports_no_change`,'TRIGGER_FUNCTION:bi_exports_no_change'],
    ['freeze trigger narrowed to UPDATE only',`${redo('bi_exports_no_change','bi_exports','BEFORE UPDATE','bi_freeze')} ${T}ENABLE ALWAYS TRIGGER bi_exports_no_change`,'TRIGGER_SHAPE:bi_exports_no_change'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER s2b_marker AFTER INSERT ON public.bi_package_schema FOR EACH ROW EXECUTE FUNCTION public.s2b_noop()','TRIGGER_UNEXPECTED:s2b_marker'],
    ['extra foreign trigger',noop+' CREATE TRIGGER s2b_extra AFTER INSERT ON public.bi_exports FOR EACH ROW EXECUTE FUNCTION public.s2b_noop()','TRIGGER_UNEXPECTED:s2b_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER s2b_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.bi_freeze()','TRIGGER_UNEXPECTED:s2b_elsewhere'],
    ['check constraint dropped','ALTER TABLE public.bi_blobs DROP CONSTRAINT bi_blobs_hash_content_check','TABLE_DEFINITION:bi_blobs:CONSTRAINTS'],
    ['check constraint weakened','ALTER TABLE public.bi_blobs DROP CONSTRAINT bi_blobs_size_check, ADD CONSTRAINT bi_blobs_size_check CHECK(size>=0)','TABLE_DEFINITION:bi_blobs:CONSTRAINTS'],
    ['attempt cap raised','ALTER TABLE public.bi_attempts DROP CONSTRAINT bi_attempts_attempt_no_check, ADD CONSTRAINT bi_attempts_attempt_no_check CHECK(attempt_no>=1 AND attempt_no<=50)','TABLE_DEFINITION:bi_attempts:CONSTRAINTS'],
    ['parent_export_id check dropped (RC-24)',T+'DROP CONSTRAINT bi_exports_parent_check','TABLE_DEFINITION:bi_exports:CONSTRAINTS'],
    ['extra constraint',T+'ADD CONSTRAINT s2b_extra CHECK(created_at>=0)','TABLE_DEFINITION:bi_exports:CONSTRAINTS'],
    ['foreign key dropped',T+'DROP CONSTRAINT bi_exports_run_id_fkey','TABLE_DEFINITION:bi_exports:CONSTRAINTS'],
    ['foreign key made CASCADE',T+'DROP CONSTRAINT bi_exports_run_id_fkey, ADD CONSTRAINT bi_exports_run_id_fkey FOREIGN KEY(run_id) REFERENCES public.quant_jobs(run_id) ON DELETE CASCADE','TABLE_DEFINITION:bi_exports:CONSTRAINTS'],
    ['one export per run dropped',T+'DROP CONSTRAINT bi_exports_owner_run_key','TABLE_DEFINITION:bi_exports:'],
    ['file blob key dropped','ALTER TABLE public.bi_package_files DROP CONSTRAINT bi_package_files_blob_fkey','TABLE_DEFINITION:bi_package_files:CONSTRAINTS'],
    ['index dropped','DROP INDEX public.bi_compile_records_export','INDEX_MISSING:bi_compile_records_export'],
    ['extra index','CREATE INDEX s2b_extra ON public.bi_attempts(attempt_id)','TABLE_DEFINITION:bi_attempts:INDEXES'],
    ['column default added',T+'ALTER COLUMN created_at SET DEFAULT 0','TABLE_DEFINITION:bi_exports:COLUMNS'],
    ['column made optional','ALTER TABLE public.bi_attempts ALTER COLUMN package_hash DROP NOT NULL','TABLE_DEFINITION:bi_attempts:COLUMNS'],
    ['column added',T+'ADD COLUMN extra integer','TABLE_DEFINITION:bi_exports:COLUMNS'],
    ['column type changed','ALTER TABLE public.bi_evidence_records ALTER COLUMN evidence_hash TYPE character varying(64)','TABLE_DEFINITION:bi_evidence_records:'],
    ['column collation changed',T+'ALTER COLUMN gate_version TYPE text COLLATE "C"','TABLE_DEFINITION:bi_exports:COLLATION'],
    ['column collation changed on a second table','ALTER TABLE public.bi_status_events ALTER COLUMN status TYPE text COLLATE "POSIX"','TABLE_DEFINITION:bi_status_events:COLLATION'],
    ['array column collation changed','ALTER TABLE public.bi_attempts ALTER COLUMN codes TYPE text[] COLLATE "C"','TABLE_DEFINITION:bi_attempts:COLLATION'],
    ['table re-owned to another role','CREATE ROLE s2b_other_owner NOLOGIN; ALTER TABLE public.bi_attempts OWNER TO s2b_other_owner','OWNER_MISMATCH:bi_attempts'],
    ['marker table re-owned to another role','CREATE ROLE s2b_other_owner NOLOGIN; ALTER TABLE public.bi_package_schema OWNER TO s2b_other_owner','OWNER_MISMATCH:bi_exports'],
    ['guard function re-owned to another role','CREATE ROLE s2b_other_owner NOLOGIN; ALTER FUNCTION public.bi_guard_attempt() OWNER TO s2b_other_owner','OWNER_MISMATCH:bi_guard_attempt'],
    ['marker function re-owned to another role','CREATE ROLE s2b_other_owner NOLOGIN; ALTER FUNCTION public.bi_package_version() OWNER TO s2b_other_owner','OWNER_MISMATCH:bi_package_version'],
    ['row security enabled',T+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:bi_exports:SHAPE'],
    ['rule added','CREATE RULE s2b_rule AS ON INSERT TO public.bi_blobs DO ALSO NOTHING','TABLE_DEFINITION:bi_blobs:SHAPE'],
    ['marker row removed','DELETE FROM public.bi_package_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.bi_package_schema DROP CONSTRAINT bi_package_schema_version_check','TABLE_DEFINITION:bi_package_schema:CONSTRAINTS'],
    ['marker table renamed','ALTER TABLE public.bi_package_schema RENAME TO s2b_renamed','TABLE_MISSING:bi_package_schema']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // A tamper may need the freeze triggers out of the way for its own setup statement (DELETE of the marker row); the probe is rolled back.
      if(label==='marker row removed')await db.query('ALTER TABLE public.bi_package_schema DISABLE TRIGGER bi_package_schema_no_change');
      await db.query(statement);return {classification:await classifyBestInputsPackage(db),report:await inspectBestInputsPackage(db)};});
    const all=[...found.classification.problems,...found.classification.missing];
    assert.equal(found.classification.state,'OTHER',label+': '+all.join());
    assert.ok(all.some(item=>item.startsWith(prefix)),label+': '+all.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.bi_package_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectBestInputsPackage(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:bi_package_version:BODY')));
  assert.equal((await classifyBestInputsPackage(db)).state,'INSTALLED','every tamper was rolled back');
});

test('offline only: the install and the rollback need the maintenance lock, their own transaction and the research extension',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateBestInputsPackage(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackBestInputsPackage(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateBestInputsPackage(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackBestInputsPackage(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
  // A database without the research extension: refused before any write.
  const bareName='robot_s2b_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));
  await bare.migrate();
  await assert.rejects(migrateBestInputsPackage(bare),/Quant research extension 1 required/);
  assert.deepEqual(await packageObjects(bare),NONE);
  await bare.query('CREATE TABLE quant_job_schema(version INTEGER)');await bare.query('INSERT INTO quant_job_schema VALUES(2)');
  await assert.rejects(migrateBestInputsPackage(bare),/Unsupported quant_job_schema version/);
  assert.deepEqual(await packageObjects(bare),NONE);
});

test('a foreign or partial install is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.bi_exports(x integer)');await foreign.query('INSERT INTO public.bi_exports VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateBestInputsPackage(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackBestInputsPackage(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.bi_exports')).rows,[{x:7}],'the foreign row survived');
  await migrateBestInputsPackage(partial);
  await partial.query('DROP TRIGGER bi_attempts_no_truncate ON public.bi_attempts');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateBestInputsPackage(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:bi_attempts_no_truncate/);
  await assert.rejects(rollbackBestInputsPackage(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyBestInputsPackage(partial)).state,'OTHER');
});

/* ---- 2. grants and the runtime role boundary ---- */

test('grants: the repo grant script gives the runtime role SELECT and INSERT only on the package tables; the marker is read-only; reapply is idempotent',async()=>{
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  // Layer-2 proof roles: the deleter also holds UPDATE and DELETE, the truncater TRUNCATE, on every package table.
  const all=[...PACKAGE_TABLES,'bi_package_schema'].map(table=>'public.'+table).join(',');
  await db.query(`GRANT UPDATE,DELETE ON TABLE ${all} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${all} TO ${truncaterName}`);
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:6})));rt2=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:6})));
  dl=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,deleterName),max:3})));tr=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,truncaterName),max:2})));
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  await db.query(`GRANT UPDATE,DELETE ON TABLE ${all} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${all} TO ${truncaterName}`);
  assert.equal(await acl(),first,'a second application of the grant script changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger
    FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  for(const table of PACKAGE_TABLES)assert.deepEqual(await facts(roleName,'public.'+table),{owner:false,select:true,insert:true,update:false,delete:false,truncate:false,trigger:false},table);
  assert.deepEqual(await facts(roleName,'public.bi_package_schema'),{owner:false,select:true,insert:false,update:false,delete:false,truncate:false,trigger:false},'the marker table is read-only');
  assert.equal((await facts(deleterName,'public.bi_exports')).delete,true);assert.equal((await facts(truncaterName,'public.bi_exports')).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // inspect with the runtime role passes, and names the role that broke the boundary
  const ok=await inspectBestInputsPackage(db,{runtimeRole:roleName});assert.equal(ok.ok,true,ok.failures.join());
  assert.equal(ok.facts.runtime_role.tables.length,11);assert.deepEqual(ok.facts.runtime_role.privileged_members,[]);
  const deleter=await inspectBestInputsPackage(db,{runtimeRole:deleterName});
  assert.ok(deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:bi_exports:DELETE')&&deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:bi_exports:UPDATE'),deleter.failures.join());
  assert.ok(deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:bi_package_schema:DELETE'));
  assert.ok((await inspectBestInputsPackage(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:bi_exports'));
  // the admin role of this cluster, derived from the connection URL (never a literal)
  const adminRole=decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).username);
  assert.ok(adminRole.length>0);
  assert.ok((await inspectBestInputsPackage(db,{runtimeRole:adminRole})).failures.some(item=>item.startsWith('RUNTIME_ROLE_SUPERUSER')||item.startsWith('RUNTIME_ROLE_OWNS:')));
  // Membership of the owning role counts as ownership, for the tables and for each function (all rolled back).
  const ownerRole=(await db.query('SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=$1::regclass',['public.bi_exports'])).rows[0].o;
  const memberOf=await probe(db,async()=>{
    await db.query('CREATE ROLE s2b_member NOLOGIN');await db.query('GRANT '+ownerRole+' TO s2b_member');
    return inspectBestInputsPackage(db,{runtimeRole:'s2b_member'});
  });
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS:bi_exports')&&memberOf.failures.includes('RUNTIME_ROLE_OWNS:bi_package_schema'),memberOf.failures.join());
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS_FUNCTION:bi_freeze'),memberOf.failures.join());
  const fnOwner=await probe(db,async()=>{
    await db.query('CREATE ROLE s2b_fn_owner NOLOGIN');await db.query('CREATE ROLE s2b_fn_member NOLOGIN');await db.query('GRANT s2b_fn_owner TO s2b_fn_member');
    await db.query('ALTER FUNCTION public.bi_guard_attempt() OWNER TO s2b_fn_owner');
    return inspectBestInputsPackage(db,{runtimeRole:'s2b_fn_member',requireGrants:false});
  });
  assert.deepEqual(fnOwner.failures.filter(item=>item.startsWith('RUNTIME_ROLE_OWNS')),['RUNTIME_ROLE_OWNS_FUNCTION:bi_guard_attempt']);
  // Membership of a superuser or BYPASSRLS role is a way around every guard (SET ROLE), whatever the member's own attributes say.
  const privileged=await probe(db,async()=>{
    await db.query('CREATE ROLE s2b_super NOLOGIN SUPERUSER');await db.query('CREATE ROLE s2b_bypass NOLOGIN BYPASSRLS');await db.query('CREATE ROLE s2b_clean NOLOGIN');
    await db.query('CREATE ROLE s2b_viasuper NOLOGIN NOINHERIT');await db.query('GRANT s2b_super TO s2b_viasuper');
    await db.query('CREATE ROLE s2b_viabypass NOLOGIN');await db.query('GRANT s2b_bypass TO s2b_viabypass');
    return {clean:await inspectBestInputsPackage(db,{runtimeRole:'s2b_clean',requireGrants:false}),viaSuper:await inspectBestInputsPackage(db,{runtimeRole:'s2b_viasuper',requireGrants:false}),
      viaBypass:await inspectBestInputsPackage(db,{runtimeRole:'s2b_viabypass',requireGrants:false})};
  });
  assert.ok(!privileged.clean.failures.some(item=>item.startsWith('RUNTIME_ROLE_PRIVILEGED_MEMBER')));
  assert.ok(privileged.viaSuper.failures.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:s2b_super'),privileged.viaSuper.failures.join());
  assert.ok(privileged.viaBypass.failures.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:s2b_bypass'),privileged.viaBypass.failures.join());
  // The role cannot disable a guard, replace a function or change the replication role.
  await refused(rt.query('ALTER TABLE public.bi_exports DISABLE TRIGGER bi_exports_no_change'),DENIED);
  await refused(rt.query('ALTER TABLE public.bi_status_events DISABLE TRIGGER ALL'),DENIED);
  await refused(rt.query('DROP TRIGGER bi_attempts_guard ON public.bi_attempts'),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.bi_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query('DROP TABLE public.bi_exports'),DENIED);
  await refused(rt.query('INSERT INTO public.bi_package_schema VALUES(2)'),DENIED);await refused(rt.query('UPDATE public.bi_package_schema SET version=1'),DENIED);await refused(rt.query('DELETE FROM public.bi_package_schema'),DENIED);
  OWNER_A=await newOwner('s2b-a');OWNER_B=await newOwner('s2b-b');
  assert.equal((await classifyBestInputsPackage(db)).state,'INSTALLED');
});

test('runtime role inspection (shared module): a privilege reachable through a role without inheritance, schema ownership and CREATE on schema public all fail',async()=>{
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  // A clean role reports none of the new failures.
  const clean=await probe(db,async()=>{await db.query('CREATE ROLE s2b_plain NOLOGIN');return inspectBestInputsPackage(db,{runtimeRole:'s2b_plain',requireGrants:false});});
  assert.deepEqual(clean.failures,[],clean.failures.join());
  // A member of a role that holds TRIGGER, UPDATE or TRUNCATE without inheriting it (NOINHERIT): has_table_privilege(member, ...) says false, SET ROLE reaches it.
  const viaNoInherit=await probe(db,async()=>{
    await db.query('CREATE ROLE s2b_holder NOLOGIN');await db.query('CREATE ROLE s2b_noinherit NOLOGIN NOINHERIT');await db.query('GRANT s2b_holder TO s2b_noinherit');
    await db.query('GRANT TRIGGER,UPDATE,TRUNCATE ON TABLE public.bi_exports TO s2b_holder');await db.query('GRANT UPDATE ON TABLE public.bi_package_schema TO s2b_holder');
    const direct=(await db.query("SELECT has_table_privilege('s2b_noinherit','public.bi_exports','TRIGGER') v")).rows[0].v;
    return {direct,report:await inspectBestInputsPackage(db,{runtimeRole:'s2b_noinherit',requireGrants:false})};
  });
  assert.equal(viaNoInherit.direct,false,'the privilege is not inherited');
  for(const failure of ['RUNTIME_ROLE_TRIGGER_PRIVILEGE:bi_exports','RUNTIME_ROLE_WRITE_PRIVILEGE:bi_exports:UPDATE','RUNTIME_ROLE_TRUNCATE_PRIVILEGE:bi_exports','RUNTIME_ROLE_WRITE_PRIVILEGE:bi_package_schema:UPDATE'])
    assert.ok(viaNoInherit.report.failures.includes(failure),failure+': '+viaNoInherit.report.failures.join());
  const reached=viaNoInherit.report.facts.runtime_role.tables.find(item=>item.table==='bi_exports');
  assert.deepEqual([reached.trigger,reached.reached.trigger],[false,true]);
  // The same with a grant WITH INHERIT FALSE (PostgreSQL 16 and later), whatever the member's own INHERIT attribute says.
  if(version>=160000){
    const viaGrant=await probe(db,async()=>{
      await db.query('CREATE ROLE s2b_holder2 NOLOGIN');await db.query('CREATE ROLE s2b_member2 NOLOGIN INHERIT');await db.query('GRANT s2b_holder2 TO s2b_member2 WITH INHERIT FALSE');
      await db.query('GRANT TRIGGER ON TABLE public.bi_attempts TO s2b_holder2');
      return inspectBestInputsPackage(db,{runtimeRole:'s2b_member2',requireGrants:false});
    });
    assert.ok(viaGrant.failures.includes('RUNTIME_ROLE_TRIGGER_PRIVILEGE:bi_attempts'),viaGrant.failures.join());
  }
  // A column-level grant is a write path that has_table_privilege does not see: UPDATE on one column, held directly, through a NOINHERIT membership
  // and (PostgreSQL 16 and later) through a grant WITH INHERIT FALSE, fails like a table-level UPDATE. Column SELECT or INSERT never satisfies a required privilege.
  const column=await probe(db,async()=>{
    await db.query('CREATE ROLE s2b_coldirect NOLOGIN');await db.query('GRANT UPDATE (mode) ON TABLE public.bi_exports TO s2b_coldirect');
    await db.query('CREATE ROLE s2b_colholder NOLOGIN');await db.query('GRANT UPDATE (codes) ON TABLE public.bi_attempts TO s2b_colholder');
    await db.query('CREATE ROLE s2b_colmember NOLOGIN NOINHERIT');await db.query('GRANT s2b_colholder TO s2b_colmember');
    await db.query('CREATE ROLE s2b_colonly NOLOGIN');await db.query('GRANT SELECT (export_id), INSERT (export_id) ON TABLE public.bi_exports TO s2b_colonly');
    const out={tableLevel:(await db.query("SELECT has_table_privilege('s2b_coldirect','public.bi_exports','UPDATE') a, has_any_column_privilege('s2b_coldirect','public.bi_exports','UPDATE') b")).rows[0],
      direct:await inspectBestInputsPackage(db,{runtimeRole:'s2b_coldirect',requireGrants:false}),member:await inspectBestInputsPackage(db,{runtimeRole:'s2b_colmember',requireGrants:false}),
      only:await inspectBestInputsPackage(db,{runtimeRole:'s2b_colonly'})};
    if(version>=160000){
      await db.query('CREATE ROLE s2b_colmember2 NOLOGIN INHERIT');await db.query('GRANT s2b_colholder TO s2b_colmember2 WITH INHERIT FALSE');
      out.memberFalse=await inspectBestInputsPackage(db,{runtimeRole:'s2b_colmember2',requireGrants:false});
    }
    return out;
  });
  assert.deepEqual(column.tableLevel,{a:false,b:true},'the table-level check alone misses the column grant');
  assert.ok(column.direct.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:bi_exports:UPDATE'),column.direct.failures.join());
  assert.ok(column.member.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:bi_attempts:UPDATE'),column.member.failures.join());
  if(version>=160000)assert.ok(column.memberFalse.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:bi_attempts:UPDATE'),column.memberFalse.failures.join());
  for(const privilege of ['SELECT','INSERT'])assert.ok(column.only.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:bi_exports:'+privilege),privilege+': '+column.only.failures.join());
  // CREATE on schema public, held directly or through a role the runtime role reaches without inheriting it.
  const create=await probe(db,async()=>{
    await db.query('CREATE ROLE s2b_creator NOLOGIN');await db.query('GRANT CREATE ON SCHEMA public TO s2b_creator');
    await db.query('CREATE ROLE s2b_via_creator NOLOGIN NOINHERIT');await db.query('GRANT s2b_creator TO s2b_via_creator');
    return {direct:await inspectBestInputsPackage(db,{runtimeRole:'s2b_creator',requireGrants:false}),reached:await inspectBestInputsPackage(db,{runtimeRole:'s2b_via_creator',requireGrants:false})};
  });
  assert.ok(create.direct.failures.includes('RUNTIME_ROLE_SCHEMA_CREATE'),create.direct.failures.join());
  assert.ok(create.reached.failures.includes('RUNTIME_ROLE_SCHEMA_CREATE'),create.reached.failures.join());
  // A database owned by the runtime role: the role owns schema public through pg_database_owner (PostgreSQL 15 and later).
  if(version>=150000){
    const owned='robot_s2b_owned_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(owned);
    await admin.query('CREATE ROLE '+dbOwnerRole+' NOLOGIN');
    await admin.query('CREATE DATABASE '+owned+' TEMPLATE '+templateName+' OWNER '+dbOwnerRole);
    const target=track(new PostgresDatabase({connectionString:urlOf(owned),max:2}));
    await migrateBestInputsPackage(target);
    const report=await inspectBestInputsPackage(target,{runtimeRole:dbOwnerRole,requireGrants:false});
    assert.equal(report.ok,false);assert.ok(report.failures.includes('RUNTIME_ROLE_OWNS_SCHEMA:public'),report.failures.join());
    assert.equal(report.facts.runtime_role.owns_schema,true);
    // the role of this cluster that does not own the database is clean
    const other=await inspectBestInputsPackage(target,{runtimeRole:roleName,requireGrants:false});
    assert.ok(!other.failures.some(item=>item.startsWith('RUNTIME_ROLE_OWNS_SCHEMA')),other.failures.join());
  }
});

/* ---- 3a. SERIALIZABLE only, and the pinned retryable list ---- */

test('SERIALIZABLE only: an INSERT into any package table under READ COMMITTED or REPEATABLE READ is refused with QR003; the retryable list equals RETRYABLE_CODES',async()=>{
  assert.deepEqual((await db.query('SELECT public.bi_retryable_codes() c')).rows[0].c,[...RETRYABLE_CODES],'the SQL list is the gate module list, in order');
  const pack=await buildExport(rt),bytes=Buffer.from(FIXTURE_LABEL+' serial blob'),fresh=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('serial')});
  const writes={
    bi_blobs:()=>insertBlob(rt,bytes),
    bi_exports:()=>rt.query(EXPORT_SQL,exportValues(fresh)),
    bi_package_files:()=>insertFile(rt,fresh.export_id,'inputs.json',bytes),
    bi_status_events:()=>insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE),
    bi_attempts:()=>attempt(rt,pack,{}),
    ql4c_validation:()=>validation(rt,pack,'att-serial'),
    bi_compile_records:()=>compileRecord(rt,pack.exportId),
    bi_evidence_records:()=>evidenceRecord(rt,pack.exportId,'repaint',{},hex('serial')),
    bi_clearances:()=>clearance(rt,pack),
    bi_trace_reproductions:()=>traceRecord(rt,pack.exportId)};
  assert.deepEqual(Object.keys(writes).sort(),[...PACKAGE_TABLES].sort(),'every record table is covered');
  const before=await allDigests(db);
  for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
    for(const [table,write] of Object.entries(writes))
      await refusedWith(rt.transaction(write,{isolation}),QR003,/require a SERIALIZABLE transaction/).catch(error=>{throw Error(isolation+' '+table+': '+error.message);});
  // the marker table too (the owner role, which holds INSERT there)
  for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
    await refused(db.transaction(()=>db.query('INSERT INTO public.bi_package_schema VALUES(1)'),{isolation}),QR003);
  // an autocommit statement of a session whose default is READ COMMITTED meets it too, also with session_replication_role=replica (ENABLE ALWAYS)
  const plain=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:1}));
  await refused(plain.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3)',[sha(bytes),bytes.length,bytes]),QR003);
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await insertBlob(db,bytes);},{isolation:'READ COMMITTED'}),QR003);
  assert.deepEqual(await allDigests(db),before,'no refused insert left a row');
  // SERIALIZABLE writes the same rows
  await rt.transaction(async()=>{await insertBlob(rt,bytes);await compileRecord(rt,pack.exportId);await traceRecord(rt,pack.exportId);},{isolation:'SERIALIZABLE'});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_blobs WHERE sha256=$1',[sha(bytes)])).rows[0].n,1);
});

/* ---- 3. table rules: blobs, files, exports ---- */

test('blobs: the hash, the size and the 16 MiB cap are CHECKs; an identical blob is a conflict; the schema file list is the gate module list',async()=>{
  const bytes=Buffer.from(FIXTURE_LABEL+' blob a'),ok=sha(bytes);
  const put=(target,hash,size,content)=>target.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3)',[hash,size,content]);
  await put(rt,ok,bytes.length,bytes);
  await refused(put(rt,ok,bytes.length,bytes),UNIQUE_VIOLATION);
  assert.equal((await insertBlob(rt,bytes)).rowCount,0,'DO NOTHING writes nothing for the same content');
  const other=Buffer.from(FIXTURE_LABEL+' blob b');
  await refused(put(rt,sha(other),other.length+1,other),CHECK_VIOLATION);              // size differs from the content
  await refused(put(rt,sha(other),other.length-1,other),CHECK_VIOLATION);
  await refused(put(rt,hex('wrong'),other.length,other),CHECK_VIOLATION);              // hash differs from the content
  await refused(put(rt,sha(other).toUpperCase(),other.length,other),CHECK_VIOLATION);  // uppercase hex
  await refused(put(rt,sha(other).slice(1),other.length,other),CHECK_VIOLATION);
  await refused(put(rt,sha(other),-1,other),CHECK_VIOLATION);
  const big=Buffer.alloc(16*MIB+1,7);                                                    // one byte over the cap, with a matching hash and size
  await refused(put(rt,sha(big),big.length,big),CHECK_VIOLATION);
  const cap=Buffer.alloc(16*MIB,9);await put(rt,sha(cap),cap.length,cap);                // exactly the cap is fine
  await put(rt,sha(Buffer.alloc(0)),0,Buffer.alloc(0));                                  // an empty file is a file
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_blobs WHERE sha256=$1',[sha(other)])).rows[0].n,0,'no malformed blob was stored');
  const constraint=(await db.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='bi_package_files_path_check'")).rows[0].d;
  assert.deepEqual([...constraint.matchAll(/'([^']+)'::text/g)].map(match=>match[1]).sort(),[...PACKAGE_FILES].sort(),'the path CHECK is exactly PACKAGE_FILES of the gate module');
  const traces=(await db.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='bi_trace_reproductions_path_check'")).rows[0].d;
  assert.deepEqual([...traces.matchAll(/'([^']+)'::text/g)].map(match=>match[1]).sort(),[...TRACE_FILES].sort());
  const blockers=(await db.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='bi_clearances_blocker_check'")).rows[0].d;
  assert.deepEqual([...blockers.matchAll(/'([^']+)'::text/g)].map(match=>match[1]).sort(),[...CANDIDATE_BLOCKERS].sort());
  assert.equal(MAX_VALIDATION_ATTEMPTS,5);
});

test('exports and files: shape CHECKs, owner and Bot foreign keys, one export per run, no parent, file path and byte rules',async()=>{
  const files=filesOf('rules'),label=async(over,bindingOver,runId)=>{
    const run=runId??await newRun(OWNER_A);
    return exportRow({owner:OWNER_A,runId:run,files,over,bindingOver});
  };
  const put=row=>rt.transaction(async()=>{
    for(const bytes of Object.values(files))await insertBlob(rt,bytes);await rt.query(EXPORT_SQL,exportValues(row));
    for(const [file,bytes] of Object.entries(files))await insertFile(rt,row.export_id,file,bytes);
    await insertEvent(rt,row.export_id,1,'EXPORT_CANDIDATE');});
  const bad=[
    ['unknown mode',await label({mode:'TWO_PINE'}),CHECK_VIOLATION],
    ['one-Pine marked internal',await label({internal:true}),CHECK_VIOLATION],
    ['multi-Pine not internal',await label({mode:'MULTI_PINE',internal:false},{mode:'MULTI_PINE'}),CHECK_VIOLATION],
    ['a parent export (RC-24)',await label({parent_export_id:randomUUID()}),CHECK_VIOLATION],
    ['binding of another owner',await label({},{owner_id:OWNER_B.id}),CHECK_VIOLATION],
    ['binding of another Bot',await label({},{bot_id:OWNER_B.id}),CHECK_VIOLATION],
    ['binding of another run',await label({},{run_id:'run-other'}),CHECK_VIOLATION],
    ['binding mode differs',await label({},{mode:'MULTI_PINE'}),CHECK_VIOLATION],
    ['binding fixture differs',await label({},{fixture:false}),CHECK_VIOLATION],
    ['binding without a creation time',await label({},{created_at:undefined}),CHECK_VIOLATION],
    ['binding not an object',await label({binding:[]}),CHECK_VIOLATION],
    ['library versions not an object',await label({library_versions:[]}),CHECK_VIOLATION],
    ['b0 not an object',await label({b0:'PASS'}),CHECK_VIOLATION],
    ['empty gate version',await label({gate_version:''}),CHECK_VIOLATION],
    ['short binding hash',await label({binding_hash:hex('x').slice(1)}),CHECK_VIOLATION],
    ['uppercase package hash',await label({package_hash:hex('x').toUpperCase()}),CHECK_VIOLATION],
    ['negative creation time',await label({created_at:-1}),CHECK_VIOLATION],
    ['creation time beyond year 9999',await label({created_at:253402300800000}),CHECK_VIOLATION],
    ['creation text not UTC',await label({created_at_utc:'2026-09-27 07:30:00'},{created_at:'2026-09-27 07:30:00'}),CHECK_VIOLATION],
    ['unknown owner',await label({owner_id:'no-such-owner'},{owner_id:'no-such-owner'}),QR004],
    ['unknown Bot',await label({bot_id:'no-such-bot'},{bot_id:'no-such-bot'}),QR004],
    ['null owner',await label({owner_id:null}),QR004]];
  for(const [name,row,code] of bad)await refused(put(row),code).catch(error=>{throw Error(name+': '+error.message);});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_exports WHERE package_hash=$1',[sha(files['quant-data/manifest.json'])])).rows[0].n,0,'no malformed export was stored');
  // valid, then the unique keys: one export per (owner, run), one export_id, and a second export of the same run is refused (RC-24)
  const run=await newRun(OWNER_A),first=await label({},{},run);
  await put(first);
  await refused(put(await label({},{},run)),UNIQUE_VIOLATION);
  await refused(put({...await label({},{},await newRun(OWNER_A)),export_id:first.export_id}),UNIQUE_VIOLATION);
  const second=await label({},{},await newRun(OWNER_A));await put(second);                  // another run, same owner: fine
  // files: only the twelve paths, bytes equal to the blob size, the blob must exist, a path once; all inside one build transaction (a file needs an export without a status event)
  const fileSql='INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',inputs=files['inputs.json'];
  const build=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('file-rules')});
  const codes=await rt.transaction(async()=>{
    for(const bytes of Object.values(files))await insertBlob(rt,bytes);
    await rt.query(EXPORT_SQL,exportValues(build));
    const found={};
    found.path=await codeOf(rt,()=>rt.query(fileSql,[build.export_id,'README.md',sha(inputs),inputs.length]));
    found.size=await codeOf(rt,()=>rt.query(fileSql,[build.export_id,'inputs.json',sha(inputs),inputs.length+1]));
    found.absent=await codeOf(rt,()=>rt.query(fileSql,[build.export_id,'inputs.json',hex('absent'),5]));
    found.negative=await codeOf(rt,()=>rt.query(fileSql,[build.export_id,'inputs.json',sha(inputs),-1]));
    found.unknownExport=await codeOf(rt,()=>rt.query(fileSql,[randomUUID(),'inputs.json',sha(inputs),inputs.length]));
    await insertFile(rt,build.export_id,'inputs.json',inputs);
    found.twice=await codeOf(rt,()=>insertFile(rt,build.export_id,'inputs.json',inputs));
    for(const [file,bytes] of Object.entries(files))if(file!=='inputs.json')await insertFile(rt,build.export_id,file,bytes);
    await insertEvent(rt,build.export_id,1,'EXPORT_CANDIDATE');
    return found;
  });
  assert.deepEqual(codes,{path:CHECK_VIOLATION,size:FK_VIOLATION,absent:FK_VIOLATION,negative:CHECK_VIOLATION,unknownExport:FK_VIOLATION,twice:UNIQUE_VIOLATION});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_package_files WHERE export_id=$1',[build.export_id])).rows[0].n,PACKAGE_FILES.length);
  // A file cannot be added once the first status event exists (the package bytes are frozen with it), even by the owner.
  await refusedWith(insertFile(rt,build.export_id,'inputs.json',inputs),QR004,/after the first status event/);
  await refusedWith(insertFile(db,first.export_id,'inputs.json',inputs),QR004,/after the first status event/);
  // The CHECKs hold without the insert guards too: a probe with the guards disabled (rolled back) reaches the constraint
  const noGuard=await probe(db,async()=>{
    await db.query('ALTER TABLE public.bi_exports DISABLE TRIGGER bi_exports_guard');
    const extra=await label({parent_export_id:randomUUID()},{},run);
    return db.query(EXPORT_SQL,exportValues(extra)).then(()=>null,error=>error.code);
  });
  assert.equal(noGuard,CHECK_VIOLATION);
});

/* ---- 4. insert guards, one by one ---- */

test('export guard: the parent run must be SUCCEEDED with the same owner and Bot; an engineering-scope run refuses fixture=false and is never rewritten',async()=>{
  // a passing case for each scope
  const engineering=await buildExport(rt,{fixture:true});
  assert.deepEqual((await db.query('SELECT fixture,internal,mode FROM public.bi_exports WHERE export_id=$1',[engineering.exportId])).rows,[{fixture:true,internal:false,mode:'ONE_PINE'}]);
  const real=await buildExport(rt,{scope:REAL_SCOPE,fixture:false});
  assert.equal((await db.query('SELECT fixture FROM public.bi_exports WHERE export_id=$1',[real.exportId])).rows[0].fixture,false);
  const realFixture=await buildExport(rt,{scope:REAL_SCOPE,fixture:true});                   // a fixture export of a real-scope run is allowed
  assert.equal((await db.query('SELECT fixture FROM public.bi_exports WHERE export_id=$1',[realFixture.exportId])).rows[0].fixture,true);
  // refused cases
  const before=await rowDigest(db,'bi_exports');
  await refusedWith(buildExport(rt,{fixture:false}),QR004,/engineering-scope research run can only have a fixture export/);
  for(const status of ['QUEUED','RUNNING','FAILED','NO_VALID_CANDIDATE','CANCELLED','TIMED_OUT'])
    await refusedWith(buildExport(rt,{runStatus:status}),QR004,/needs a SUCCEEDED research run/).catch(error=>{throw Error(status+': '+error.message);});
  await refusedWith(buildExport(rt,{runId:'run-missing'}),QR004,/existing research run/);
  // a run whose contract names no scope is refused for either fixture flag (never fail open): a null scope, an empty scope and no scope key
  // and a malformed scope (blank, lower case, one character, too long) is refused the same way: it never escapes the engineering-scope rule
  for(const scope of [null,'',' ','spt_custom_engineering_only','A','X'.repeat(65)])
    for(const fixture of [true,false])await refusedWith(buildExport(rt,{scope,fixture}),QR004,/contract names a well-formed scope/).catch(error=>{throw Error(JSON.stringify(scope)+' '+fixture+': '+error.message);});
  for(const fixture of [true,false])
    await refusedWith(buildExport(rt,{runId:await newRun(OWNER_A,{contract:{label:FIXTURE_LABEL}}),fixture}),QR004,/contract names a well-formed scope/);
  const foreignRun=await newRun(OWNER_B);
  await refusedWith(buildExport(rt,{owner:OWNER_A,runId:foreignRun}),QR004,/owner and Bot must equal/);   // run of owner B
  const ownRun=await newRun(OWNER_A);
  await refusedWith(buildExport(rt,{owner:OWNER_A,runId:ownRun,botId:OWNER_B.id}),QR004,/owner and Bot must equal/);   // another Bot
  assert.deepEqual(await rowDigest(db,'bi_exports'),{n:before.n,d:before.d},'no refused export left a row');
});

test('deferred check: an export without its seq 1 EXPORT_CANDIDATE event cannot commit; with it the commit succeeds',async()=>{
  const before=await rowDigest(db,'bi_exports'),blobs=(await rowDigest(db,'bi_blobs')).n;
  await refusedWith(buildExport(rt,{events:false}),QR004,/EXPORT_CANDIDATE status event in the same transaction/);
  await refusedWith(buildExport(rt,{events:false,withFiles:false}),QR004,/same transaction/);
  assert.deepEqual(await rowDigest(db,'bi_exports'),before,'the refused build left no export');
  assert.ok((await rowDigest(db,'bi_blobs')).n===blobs,'and no blob');
  // an event written in a LATER transaction does not help: the check runs at the commit of the export
  const late=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('late')});
  await refused(rt.transaction(()=>rt.query(EXPORT_SQL,exportValues(late))),QR004);
  // the same transaction, any order: event written first is impossible (foreign key), so the documented order is the only order
  const ordered=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('ordered')});
  await refused(rt.transaction(async()=>{await insertEvent(rt,ordered.export_id,1,'EXPORT_CANDIDATE');await rt.query(EXPORT_SQL,exportValues(ordered));}),FK_VIOLATION);
  // the package files: exactly the twelve, quant-data/manifest.json included; one missing file (any of them) or none at all is refused at COMMIT
  await refusedWith(buildExport(rt,{withFiles:false}),QR004,/all 12 package files, quant-data\/manifest.json included/);
  for(const missing of ['quant-data/manifest.json','inputs.json','quant-data/validation.json']){
    const partialFiles=filesOf('partial-'+missing),partial=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:partialFiles});
    await refusedWith(rt.transaction(async()=>{
      for(const bytes of Object.values(partialFiles))await insertBlob(rt,bytes);
      await rt.query(EXPORT_SQL,exportValues(partial));
      for(const [file,bytes] of Object.entries(partialFiles))if(file!==missing)await insertFile(rt,partial.export_id,file,bytes);
      await insertEvent(rt,partial.export_id,1,'EXPORT_CANDIDATE');
    }),QR004,/all 12 package files, quant-data\/manifest.json included/).catch(error=>{throw Error('without '+missing+': '+error.message);});
    assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_exports WHERE export_id=$1',[partial.export_id])).rows[0].n,0,'the refused export left no row');
  }
  const done=await buildExport(rt);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_package_files WHERE export_id=$1',[done.exportId])).rows[0].n,PACKAGE_FILES.length);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_status_events WHERE export_id=$1 AND seq=1',[done.exportId])).rows[0].n,1);
  // SET CONSTRAINTS ... IMMEDIATE moves the failure into the statement; the commit never sees a half-written export
  const immediate=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('immediate')});
  await refused(rt.transaction(async()=>{await rt.query('SET CONSTRAINTS bi_exports_complete IMMEDIATE');await rt.query(EXPORT_SQL,exportValues(immediate));}),QR004);
  // the owner role meets it too, also with session_replication_role=replica (the trigger is ENABLE ALWAYS)
  const replica=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('replica')});
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(EXPORT_SQL,exportValues(replica));},{isolation:'SERIALIZABLE'}),QR004);
});

test('status events: first seq 1 EXPORT_CANDIDATE, seq = last + 1, only the edges of contract 6.1, nothing after a terminal status',async()=>{
  const pack=await buildExport(rt);
  // seq rules
  await refusedWith(insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',1),QR004,/latest validation attempt/);                 // no attempt yet
  await attempt(rt,pack,{codes:RETRYABLE});
  await refusedWith(insertEvent(rt,pack.exportId,3,'EXPORT_CANDIDATE',1),QR004,/seq = last \+ 1/);                           // gap
  await refusedWith(insertEvent(rt,pack.exportId,1,'EXPORT_CANDIDATE',1),QR004,/seq = last \+ 1/);                           // repeat of seq 1
  await refusedWith(insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',null),QR004,/latest validation attempt/);              // no attempt reference
  await refusedWith(insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',2),QR004,/latest validation attempt/);                 // an attempt that does not exist
  await refusedWith(insertEvent(rt,pack.exportId,2,'EXPORT_VALIDATED',1),QR004,/one-Pine export, a passing attempt/);        // a failed attempt cannot validate
  await refusedWith(insertEvent(rt,pack.exportId,2,'EXPORT_INTERNAL',1),QR004,/internal export and a passing attempt/);      // one-Pine is never internal
  await refused(insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',1,[],{status:'NO_VALID_CANDIDATE'}),CHECK_VIOLATION);       // not an export status (run-level only)
  await insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE);                                                      // retryable failure keeps the candidate (attempt recorded)
  await refused(insertEvent(rt,pack.exportId,3,'EXPORT_CANDIDATE',1,RETRYABLE),UNIQUE_VIOLATION);                            // one status event per attempt
  // first-event rules on fresh exports (built without the event so the first insert is the one under test)
  for(const [name,seq,status] of [['seq 2 first',2,'EXPORT_CANDIDATE'],['seq 0',0,'EXPORT_CANDIDATE'],['VALIDATED first',1,'EXPORT_VALIDATED'],['REFUSED first',1,'EXPORT_REFUSED']]){
    const fresh=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files:filesOf('first-'+seq+status)});
    await refusedWith(rt.transaction(async()=>{await rt.query(EXPORT_SQL,exportValues(fresh));await insertEvent(rt,fresh.export_id,seq,status,null,status==='EXPORT_REFUSED'?['BI_X_CODE']:[]);}),QR004,/first status event must be seq 1/).catch(error=>{throw Error(name+': '+error.message);});
  }
  // post-terminal: nothing follows any terminal status; an attempt is refused too
  for(const kind of ['EXPORT_VALIDATED','EXPORT_INTERNAL','EXPORT_REFUSED']){
    const done=await terminal(kind);
    await refusedWith(insertEvent(rt,done.exportId,3,'EXPORT_CANDIDATE',1),QR004,/terminal status/).catch(error=>{throw Error(kind+': '+error.message);});
    await refusedWith(insertEvent(rt,done.exportId,3,'EXPORT_REFUSED',1,['BI_X_CODE']),QR004,/terminal status/);
    await refusedWith(attempt(rt,done,{}),QR004,/latest status EXPORT_CANDIDATE/);
    assert.equal((await db.query('SELECT status FROM public.bi_status_events WHERE export_id=$1 ORDER BY seq DESC LIMIT 1',[done.exportId])).rows[0].status,kind);
  }
  // VALIDATED needs the ql4c_validation row; INTERNAL needs an internal export; VALIDATED on an internal export is refused
  const noRecord=await buildExport(rt);const passing=await attempt(rt,noRecord,{pass:true});
  await refusedWith(insertEvent(rt,noRecord.exportId,2,'EXPORT_VALIDATED',1),QR004,/ql4c_validation row/);
  await refusedWith(insertEvent(rt,noRecord.exportId,2,'EXPORT_CANDIDATE',1),QR004,/passing attempt can only lead to/);
  await refusedWith(insertEvent(rt,noRecord.exportId,2,'EXPORT_REFUSED',1,['BI_X_CODE']),QR004,/passing attempt can only lead to/);
  await validation(rt,noRecord,passing);await insertEvent(rt,noRecord.exportId,2,'EXPORT_VALIDATED',1);
  const multi=await buildExport(rt,{mode:'MULTI_PINE'});await attempt(rt,multi,{pass:true});
  await refusedWith(insertEvent(rt,multi.exportId,2,'EXPORT_VALIDATED',1),QR004,/one-Pine export/);
  await insertEvent(rt,multi.exportId,2,'EXPORT_INTERNAL',1);
  // a status event row: codes rules (terminal REFUSED needs codes, VALIDATED and INTERNAL none; every code matches the gate pattern)
  const codes=await buildExport(rt);await attempt(rt,codes,{codes:['BI_NATIVE_SIGNAL_PARITY_FAILED']});
  await refusedWith(insertEvent(rt,codes.exportId,2,'EXPORT_REFUSED',1,[]),QR004,/carry the codes of that attempt/);          // the guard meets these first; the CHECK is proven with the guard off (retry test)
  await refusedWith(insertEvent(rt,codes.exportId,2,'EXPORT_REFUSED',1,['lower_case']),QR004,/carry the codes of that attempt/);
  await refusedWith(insertEvent(rt,codes.exportId,2,'EXPORT_REFUSED',1,[null]),QR004,/carry the codes of that attempt/);
  await insertEvent(rt,codes.exportId,2,'EXPORT_REFUSED',1,['BI_NATIVE_SIGNAL_PARITY_FAILED']);
  // the first status-event shape CHECKs hold without the guard (probe)
  const probeCodes=await probe(db,async()=>{
    await db.query('ALTER TABLE public.bi_status_events DISABLE TRIGGER bi_status_events_guard');
    const fresh=await buildExport(db);
    return db.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,$2,$3,NULL,$4,$5)',[fresh.exportId,'EXPORT_CANDIDATE','{}',T0,UTC]).then(()=>null,error=>error.code);
  });
  assert.equal(probeCodes,CHECK_VIOLATION);
});

test('attempts: attempt_no is the count + 1 from 1 to 5; the sixth is refused; only while EXPORT_CANDIDATE; no attempt follows a passing one; package_hash must match',async()=>{
  const pack=await buildExport(rt);
  await refusedWith(attempt(rt,pack,{no:2}),QR004,/count \+ 1/);                                                           // a gap
  await refusedWith(attempt(rt,pack,{no:0}),QR004,/count \+ 1/);
  await refusedWith(attempt(rt,pack,{no:1,over:{package_hash:hex('other')}}),QR004,/export package_hash/);
  await refused(attempt(rt,pack,{no:1,over:{validator_engine_hash:'xyz'}}),CHECK_VIOLATION);
  await refused(attempt(rt,pack,{no:1,over:{pass:true}}),CHECK_VIOLATION);                                                   // pass must equal "no codes"
  await refused(attempt(rt,pack,{no:1,codes:['lower_case']}),CHECK_VIOLATION);
  await refused(attempt(rt,pack,{no:1,codes:[null,'BI_X_CODE']}),CHECK_VIOLATION);
  // BI_ATTEMPTS_EXHAUSTED is a status code, never an attempt code: the guard refuses it alone or beside retryable codes.
  await refusedWith(attempt(rt,pack,{no:1,codes:['BI_ATTEMPTS_EXHAUSTED']}),QR004,/status code, never an attempt code/);
  await refusedWith(attempt(rt,pack,{no:1,codes:[...RETRYABLE,'BI_ATTEMPTS_EXHAUSTED']}),QR004,/status code, never an attempt code/);
  const other=await buildExport(rt);const taken=await attempt(rt,other,{});
  await refused(attempt(rt,pack,{no:1,over:{attempt_id:taken}}),UNIQUE_VIOLATION);                                           // attempt_id is unique across exports
  for(let n=1;n<=5;n++){
    await attempt(rt,pack,{no:n});
    if(n<5){
      await refusedWith(attempt(rt,pack,{no:n}),QR004,/count \+ 1/);                                                        // a repeat of the same number
      await refusedWith(attempt(rt,pack,{no:n+1}),QR004,/status event of the previous attempt/);                           // one status event per attempt
      await insertEvent(rt,pack.exportId,n+1,'EXPORT_CANDIDATE',n,RETRYABLE);
    }
  }
  await refusedWith(attempt(rt,pack,{no:6}),QR004,/at most 5/);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_attempts WHERE export_id=$1',[pack.exportId])).rows[0].n,5);
  // the fifth failure ends the candidate: CANDIDATE after attempt 5 is refused, REFUSED is the edge
  await refusedWith(insertEvent(rt,pack.exportId,6,'EXPORT_CANDIDATE',5,RETRYABLE),QR004,/fifth failed attempt must end EXPORT_REFUSED/);
  await refusedWith(insertEvent(rt,pack.exportId,6,'EXPORT_REFUSED',5,['BI_ATTEMPTS_EXHAUSTED']),QR004,/carry the codes of that attempt/);
  await insertEvent(rt,pack.exportId,6,'EXPORT_REFUSED',5,[...RETRYABLE,'BI_ATTEMPTS_EXHAUSTED']);
  await refusedWith(attempt(rt,pack,{no:6}),QR004,/latest status EXPORT_CANDIDATE/);
  // the CHECK is a second layer: with the guard disabled in a rolled-back probe attempt 6 reaches the constraint
  const six=await probe(db,async()=>{
    await db.query('ALTER TABLE public.bi_attempts DISABLE TRIGGER bi_attempts_guard');
    const fresh=await buildExport(db);
    for(let n=1;n<=5;n++)await attempt(db,fresh,{no:n});
    return attempt(db,fresh,{no:6}).then(()=>null,error=>error.code);
  });
  assert.equal(six,CHECK_VIOLATION);
  // a passing attempt closes the attempt list until its status event; an attempt on a missing export finds no latest status
  const passed=await buildExport(rt);await attempt(rt,passed,{pass:true});
  await refusedWith(attempt(rt,passed,{no:2}),QR004,/follow a passing attempt/);
  await refused(attempt(rt,{exportId:randomUUID(),package_hash:hex('x'),attempts:0},{no:1}),QR004);
});

test('ql4c_validation: a passing attempt of this export, matching hashes and fixture flag, only while EXPORT_CANDIDATE',async()=>{
  // a one-Pine non-fixture export: the G8 source
  const real=await buildExport(rt,{scope:REAL_SCOPE,fixture:false});
  const failing=await attempt(rt,real,{});
  await insertEvent(rt,real.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE);                                                    // one status event per attempt
  await refusedWith(validation(rt,real,failing),QR004,/passing attempt of this export/);                                      // a failed attempt
  await refusedWith(validation(rt,real,'att-missing'),QR004,/passing attempt of this export/);                                // no such attempt
  const other=await buildExport(rt,{scope:REAL_SCOPE,fixture:false});const otherAttempt=await attempt(rt,other,{pass:true});
  await refusedWith(validation(rt,real,otherAttempt),QR004,/passing attempt of this export/);                                 // the attempt of another export
  const passing=await attempt(rt,real,{pass:true});
  await refusedWith(validation(rt,real,passing,{package_hash:hex('other')}),QR004,/package_hash, binding_hash and fixture flag/);
  await refusedWith(validation(rt,real,passing,{binding_hash:hex('other')}),QR004,/package_hash, binding_hash and fixture flag/);
  await refusedWith(validation(rt,real,passing,{fixture:true}),QR004,/package_hash, binding_hash and fixture flag/);           // fixture flag differs from the export
  await refusedWith(validation(rt,real,passing,{validator_engine_hash:hex('other')}),QR004,/same package_hash and validator hash/);
  await validation(rt,real,passing);
  await refused(validation(rt,real,passing),UNIQUE_VIOLATION);                                                               // one record per export
  await insertEvent(rt,real.exportId,3,'EXPORT_VALIDATED',2);
  // after a terminal status no record can be added
  const done=await terminal('EXPORT_REFUSED');
  await refusedWith(attempt(db,done,{pass:true}),QR004,/latest status EXPORT_CANDIDATE/);
  await refusedWith(validation(rt,done,'att-any'),QR004,/latest status EXPORT_CANDIDATE/);
  // a fixture export keeps its record with fixture=true (the contract lets a fixture package reach EXPORT_VALIDATED, section 11.1 item 1)
  const fixture=await terminal('EXPORT_VALIDATED');
  assert.deepEqual((await db.query('SELECT fixture FROM public.ql4c_validation WHERE export_id=$1',[fixture.exportId])).rows,[{fixture:true}]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM public.ql4c_validation v JOIN public.bi_exports e USING(export_id) WHERE v.fixture=false AND e.mode='ONE_PINE' AND e.fixture=false`)).rows[0].n,1,'the G8 shape is one non-fixture one-Pine record');
});

test('evidence rows: compile, evidence, clearance and trace rows only while EXPORT_CANDIDATE; a clearance names the run of its export',async()=>{
  const pack=await buildExport(rt);
  await compileRecord(rt,pack.exportId);await compileRecord(rt,pack.exportId);                                                // append-only, more than one is fine
  for(const kind of ['dataset_alignment','native_parity','bridge_parity','repaint','quant_baseline'])await evidenceRecord(rt,pack.exportId,kind,{scope:{kind}},hex('evidence:'+kind));
  await refused(evidenceRecord(rt,pack.exportId,'native_parity',{scope:{}},hex('evidence:native_parity')),UNIQUE_VIOLATION);
  await refused(evidenceRecord(rt,pack.exportId,'other_kind'),CHECK_VIOLATION);
  await refused(evidenceRecord(rt,pack.exportId,'repaint',[1]),CHECK_VIOLATION);
  await refused(evidenceRecord(rt,pack.exportId,'repaint',{},'XYZ'),CHECK_VIOLATION);
  for(const file of TRACE_FILES)await traceRecord(rt,pack.exportId,file);
  await refused(traceRecord(rt,pack.exportId,TRACE_FILES[0]),UNIQUE_VIOLATION);
  await refused(traceRecord(rt,pack.exportId,TRACE_FILES[0],{path:'quant-data/metrics.json'}),CHECK_VIOLATION);
  await clearance(rt,pack);await clearance(rt,pack,{blocker:CANDIDATE_BLOCKERS[1],evidence_hash:hex('evidence:repaint')});
  await refused(clearance(rt,pack),UNIQUE_VIOLATION);
  await refused(clearance(rt,pack,{blocker:'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED',evidence_hash:hex('capability')}),CHECK_VIOLATION);       // capability blockers are never cleared
  await refusedWith(clearance(rt,pack,{run_id:await newRun(OWNER_A),evidence_hash:hex('other-run')}),QR004,/run of its export/);
  await refused(compileRecord(rt,pack.exportId,{export_id:randomUUID()}),QR004);
  // a clearance needs an evidence record of the SAME export with the same evidence_hash and the kind of its blocker (parity: native_parity, repaint: repaint)
  const bare=await buildExport(rt);
  await refusedWith(clearance(rt,bare),QR004,/needs an evidence record of its export with the same evidence_hash and the kind of its blocker/);   // no record at all
  await evidenceRecord(rt,bare.exportId,'repaint',{scope:{}},hex('evidence:native_parity'));                                                        // same hash, wrong kind
  await refusedWith(clearance(rt,bare),QR004,/kind of its blocker/);
  await refusedWith(clearance(rt,bare,{evidence_hash:hex('other-hash')}),QR004,/kind of its blocker/);                                            // right kind, other hash
  await refusedWith(clearance(rt,bare,{blocker:CANDIDATE_BLOCKERS[1],evidence_hash:hex('evidence:repaint')}),QR004,/kind of its blocker/);      // that hash is not recorded here
  await clearance(rt,bare,{blocker:CANDIDATE_BLOCKERS[1],evidence_hash:hex('evidence:native_parity')});                                           // repaint record, repaint blocker
  const other=await buildExport(rt);await evidenceRecord(rt,other.exportId,'native_parity',{scope:{}},hex('evidence:other-export'));
  await refusedWith(clearance(rt,bare,{evidence_hash:hex('evidence:other-export')}),QR004,/kind of its blocker/);                                   // a record of another export does not count
  // the compile record holds the shape the gate reads
  const stored=(await db.query('SELECT * FROM public.bi_compile_records WHERE export_id=$1 LIMIT 1',[pack.exportId])).rows[0];
  assert.deepEqual([stored.indicator_sha256,stored.pine_version,stored.errors,stored.warnings,stored.mapping_check,stored.operator_role,stored.method,stored.compiled_at_utc],
    [hex('indicator'),'6',[],[],[{slot:'s1',pine_variable:'v1'}],'root-coordinator','tradingview-compile-serial-step',UTC]);
  // after a terminal status every one of them is refused
  for(const kind of ['EXPORT_REFUSED','EXPORT_VALIDATED','EXPORT_INTERNAL']){
    const done=await terminal(kind);
    const write={compile:()=>compileRecord(rt,done.exportId),evidence:()=>evidenceRecord(rt,done.exportId,'repaint',{},hex('late:'+kind)),clearance:()=>clearance(rt,done,{evidence_hash:hex('late:'+kind)}),
      trace:()=>traceRecord(rt,done.exportId,TRACE_FILES[1])};
    for(const [name,fn] of Object.entries(write))await refusedWith(fn(),QR004,/latest status EXPORT_CANDIDATE/).catch(error=>{throw Error(kind+' '+name+': '+error.message);});
  }
  // the same on an export that has no status event at all (built and committed without one is impossible, so use a probe with the deferred check off)
  const none=await probe(db,async()=>{
    await db.query('ALTER TABLE public.bi_exports DISABLE TRIGGER bi_exports_complete');
    const fresh=await buildExport(db,{events:false});
    return compileRecord(db,fresh.exportId).then(()=>null,error=>error.code);
  });
  assert.equal(none,QR004);
});

test('package cap: the files of one export sum to at most 16 MiB; files only before the first status event',async()=>{
  // Every export commits with its twelve files, so each build writes the nine small files first, then the three large ones in the order under test.
  // b fills the cap together with a and the small files, less one byte; a file the cap refuses is replaced by a one-byte file ('z').
  const a=Buffer.alloc(8*MIB,1),c=Buffer.from('one more byte'),z=Buffer.from('z');
  const small=label=>Object.entries(filesOf(label)).filter(([file])=>!TRACE_FILES.includes(file));
  const smallSize=label=>small(label).reduce((sum,[,bytes])=>sum+bytes.length,0);
  const build=async(label,plan)=>{
    const files=filesOf(label),row=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A),files}),b=Buffer.alloc(8*MIB-smallSize(label)-1,2);
    const codes=await rt.transaction(async()=>{
      for(const bytes of [a,b,c,z,...small(label).map(([,bytes])=>bytes)])await insertBlob(rt,bytes);
      await rt.query(EXPORT_SQL,exportValues(row));
      for(const [file,bytes] of small(label))await insertFile(rt,row.export_id,file,bytes);
      const found=[],placed=new Set();
      for(const [file,bytes] of plan(b)){const code=await codeOf(rt,()=>insertFile(rt,row.export_id,file,bytes));found.push(code);if(code===null)placed.add(file);}
      for(const file of TRACE_FILES)if(!placed.has(file))await insertFile(rt,row.export_id,file,z);
      await insertEvent(rt,row.export_id,1,'EXPORT_CANDIDATE');
      return found;
    });
    return {row,codes,small:smallSize(label)};
  };
  // exactly 16 MiB is fine; one more byte is over
  const exact=await build('cap-exact',b=>[['quant-data/equity.csv',a],['quant-data/trades.csv',b],['quant-data/decisions.csv',c]]);
  assert.deepEqual(exact.codes,[null,null,QR004]);
  assert.equal((await db.query('SELECT sum(bytes)::bigint s FROM public.bi_package_files WHERE export_id=$1',[exact.row.export_id])).rows[0].s,16*MIB);
  // the order of insertion does not matter: the small file first, the second large one is over
  const reversed=await build('cap-reversed',b=>[['quant-data/decisions.csv',c],['quant-data/equity.csv',a],['quant-data/trades.csv',b]]);
  assert.deepEqual(reversed.codes,[null,null,QR004]);
  assert.equal((await db.query('SELECT sum(bytes)::bigint s FROM public.bi_package_files WHERE export_id=$1',[reversed.row.export_id])).rows[0].s,8*MIB+c.length+reversed.small+z.length);
  // the cap is per export: the same blobs under another export are fine again
  const again=await build('cap-again',b=>[['quant-data/equity.csv',a],['quant-data/trades.csv',b]]);
  assert.deepEqual(again.codes,[null,null]);
  // files only before the first status event, also for the owner
  await refusedWith(insertFile(rt,again.row.export_id,'inputs.json',c),QR004,/after the first status event/);
  await refusedWith(insertFile(db,again.row.export_id,'inputs.json',c),QR004,/after the first status event/);
});

test('retry edges (contract 6.1): CANDIDATE needs retryable-only attempt codes below attempt 5 and the same codes; REFUSED a non-retryable code or exhaustion; no attempt after a non-retryable one',async()=>{
  const HARD='BI_NATIVE_SIGNAL_PARITY_FAILED',SOFT=RETRYABLE_CODES[0],SOFT2=RETRYABLE_CODES[1];
  assert.ok(!RETRYABLE_CODES.includes(HARD)&&RETRYABLE_CODES.includes(RETRYABLE[0]));
  // Fable probe P4: a non-retryable failed attempt must not continue as EXPORT_CANDIDATE, must not take attempt 2, and must end EXPORT_REFUSED with its codes.
  const p4=await buildExport(rt);await attempt(rt,p4,{codes:[HARD]});
  await refusedWith(insertEvent(rt,p4.exportId,2,'EXPORT_CANDIDATE',1,[HARD]),QR004,/non-retryable code can only lead to EXPORT_REFUSED/);
  await refusedWith(insertEvent(rt,p4.exportId,2,'EXPORT_CANDIDATE',1,[HARD,SOFT]),QR004,/non-retryable code can only lead to EXPORT_REFUSED/);
  await refusedWith(attempt(rt,p4,{}),QR004,/follow an attempt with a non-retryable code/);                                  // attempt 2 without any event
  await refusedWith(insertEvent(rt,p4.exportId,2,'EXPORT_REFUSED',1,['BI_X_CODE']),QR004,/must carry the codes of that attempt/);   // unrelated codes
  await refusedWith(insertEvent(rt,p4.exportId,2,'EXPORT_REFUSED',1,[SOFT]),QR004,/must carry the codes of that attempt/);
  await refusedWith(insertEvent(rt,p4.exportId,2,'EXPORT_REFUSED',1,[HARD,'BI_ATTEMPTS_EXHAUSTED']),QR004,/exactly the codes of that attempt/);   // no exhaustion code on attempt 1
  await insertEvent(rt,p4.exportId,2,'EXPORT_REFUSED',1,[HARD]);
  // a mixed attempt is non-retryable as a whole; the REFUSED event carries the attempt codes exactly: it may neither drop nor add a code
  const mixed=await buildExport(rt);await attempt(rt,mixed,{codes:[SOFT,HARD]});
  await refusedWith(insertEvent(rt,mixed.exportId,2,'EXPORT_CANDIDATE',1,[SOFT,HARD]),QR004,/non-retryable code can only lead to EXPORT_REFUSED/);
  await refusedWith(attempt(rt,mixed,{}),QR004,/non-retryable code/);
  await refusedWith(insertEvent(rt,mixed.exportId,2,'EXPORT_REFUSED',1,[HARD]),QR004,/must carry the codes of that attempt/);
  await refusedWith(insertEvent(rt,mixed.exportId,2,'EXPORT_REFUSED',1,[SOFT,HARD,'BI_EXTRA_CODE']),QR004,/exactly the codes of that attempt/);
  await insertEvent(rt,mixed.exportId,2,'EXPORT_REFUSED',1,[HARD,SOFT]);
  // a retryable-only failure below attempt 5: CANDIDATE with exactly the attempt codes; REFUSED is not an edge, with or without the exhaustion code
  const soft=await buildExport(rt);await attempt(rt,soft,{codes:[SOFT,SOFT2]});
  await refusedWith(insertEvent(rt,soft.exportId,2,'EXPORT_CANDIDATE',1,[]),QR004,/must carry the codes of that attempt/);
  await refusedWith(insertEvent(rt,soft.exportId,2,'EXPORT_CANDIDATE',1,[SOFT]),QR004,/must carry the codes of that attempt/);
  await refusedWith(insertEvent(rt,soft.exportId,2,'EXPORT_CANDIDATE',1,[SOFT,SOFT2,RETRYABLE_CODES[2]]),QR004,/exactly the codes of that attempt/);
  await refusedWith(insertEvent(rt,soft.exportId,2,'EXPORT_CANDIDATE',1,[SOFT,SOFT2,HARD]),QR004,/exactly the codes of that attempt/);
  await refusedWith(insertEvent(rt,soft.exportId,2,'EXPORT_REFUSED',1,[SOFT,SOFT2]),QR004,/non-retryable code, or the fifth failed attempt/);
  await refusedWith(insertEvent(rt,soft.exportId,2,'EXPORT_REFUSED',1,[SOFT,SOFT2,'BI_ATTEMPTS_EXHAUSTED']),QR004,/non-retryable code, or the fifth failed attempt/);
  await insertEvent(rt,soft.exportId,2,'EXPORT_CANDIDATE',1,[SOFT2,SOFT]);                                                    // the same set in another order
  // the chain through events: a retryable attempt keeps the candidate, a later non-retryable attempt ends it
  await attempt(rt,soft,{codes:[HARD]});
  await refusedWith(insertEvent(rt,soft.exportId,3,'EXPORT_CANDIDATE',2,[HARD]),QR004,/non-retryable code can only lead to EXPORT_REFUSED/);
  await insertEvent(rt,soft.exportId,3,'EXPORT_REFUSED',2,[HARD]);
  // exhaustion: the fifth failure with retryable-only codes ends REFUSED only with BI_ATTEMPTS_EXHAUSTED next to the attempt codes
  const tired=await buildExport(rt);
  for(let n=1;n<=5;n++){await attempt(rt,tired,{no:n,codes:[SOFT]});if(n<5)await insertEvent(rt,tired.exportId,n+1,'EXPORT_CANDIDATE',n,[SOFT]);}   // one status event per attempt
  await refusedWith(insertEvent(rt,tired.exportId,6,'EXPORT_CANDIDATE',5,[SOFT]),QR004,/fifth failed attempt must end EXPORT_REFUSED/);
  await refusedWith(insertEvent(rt,tired.exportId,6,'EXPORT_REFUSED',5,[SOFT]),QR004,/must carry the codes of that attempt/);          // the exhaustion code is required
  await refusedWith(insertEvent(rt,tired.exportId,6,'EXPORT_REFUSED',5,['BI_ATTEMPTS_EXHAUSTED']),QR004,/must carry the codes of that attempt/);
  await refusedWith(insertEvent(rt,tired.exportId,6,'EXPORT_REFUSED',5,[SOFT,'BI_ATTEMPTS_EXHAUSTED','BI_EXTRA_CODE']),QR004,/exactly the codes of that attempt/);
  await insertEvent(rt,tired.exportId,6,'EXPORT_REFUSED',5,[SOFT,'BI_ATTEMPTS_EXHAUSTED']);
  // the fifth attempt may also hold a non-retryable code: the exhaustion code is then refused, as on any other hard failure
  const late=await buildExport(rt);
  for(let n=1;n<=4;n++){await attempt(rt,late,{no:n,codes:[SOFT]});await insertEvent(rt,late.exportId,n+1,'EXPORT_CANDIDATE',n,[SOFT]);}
  await attempt(rt,late,{no:5,codes:[HARD]});
  await refusedWith(insertEvent(rt,late.exportId,6,'EXPORT_REFUSED',5,[HARD,'BI_ATTEMPTS_EXHAUSTED']),QR004,/exactly the codes of that attempt/);
  await insertEvent(rt,late.exportId,6,'EXPORT_REFUSED',5,[HARD]);
  // the exhaustion code alone does not make a retryable failure terminal before attempt 5 (it is not a retryable code and not an attempt code)
  const early=await buildExport(rt);await attempt(rt,early,{codes:[SOFT]});
  await refusedWith(insertEvent(rt,early.exportId,2,'EXPORT_CANDIDATE',1,[SOFT,'BI_ATTEMPTS_EXHAUSTED']),QR004,/exactly the codes of that attempt/);
  // the rules hold on the guard only: with it disabled (rolled-back probe) the status CHECK still refuses empty and malformed codes
  const checks=await probe(db,async()=>{
    await db.query('ALTER TABLE public.bi_status_events DISABLE TRIGGER bi_status_events_guard');
    const fresh=await buildExport(db);await attempt(db,fresh,{codes:[HARD]});
    const found=[];
    for(const bad of [[],['lower_case'],[null]])found.push(await codeOf(db,()=>insertEvent(db,fresh.exportId,2,'EXPORT_REFUSED',1,bad)));
    return found;
  });
  assert.deepEqual(checks,[CHECK_VIOLATION,CHECK_VIOLATION,CHECK_VIOLATION]);
});

/* ---- 5. insert-only enforcement ---- */

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers on every table; the replication role cannot skip a guard; no row changes',async()=>{
  const pack=await terminal('EXPORT_VALIDATED');
  const live=await buildExport(rt);await compileRecord(rt,live.exportId);await evidenceRecord(rt,live.exportId);await traceRecord(rt,live.exportId);await clearance(rt,live);
  const before=await allDigests(db);
  for(const table of PACKAGE_TABLES)assert.ok(before[table].n>0,table+' holds a row');
  const column={bi_exports:'created_at',bi_package_files:'bytes',bi_blobs:'size',bi_status_events:'at_ms',bi_attempts:'validated_at_ms',bi_compile_records:'compiled_at_ms',bi_evidence_records:'recorded_at_ms',
    bi_clearances:'recorded_at_ms',bi_trace_reproductions:'recorded_at_ms',ql4c_validation:'validated_at_ms',bi_package_schema:'version'};
  // layer 1 (privilege): the runtime role holds no UPDATE, DELETE or TRUNCATE on a package table
  for(const table of [...PACKAGE_TABLES,'bi_package_schema']){
    await refused(rt.query(`UPDATE public.${table} SET ${column[table]}=${column[table]}`),DENIED).catch(error=>{throw Error(table+': '+error.message);});
    await refused(rt.query(`DELETE FROM public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table} CASCADE`),DENIED);
  }
  // layer 2 (trigger): a role that holds UPDATE and DELETE still meets the guard, with and without a WHERE clause and for a no-op update
  for(const table of [...PACKAGE_TABLES,'bi_package_schema']){
    await refused(dl.query(`UPDATE public.${table} SET ${column[table]}=${column[table]}`),QR002).catch(error=>{throw Error(table+' update: '+error.message);});
    await refused(dl.query(`UPDATE public.${table} SET ${column[table]}=${column[table]}+1`),QR002);
    await refused(dl.query(`DELETE FROM public.${table}`),QR002).catch(error=>{throw Error(table+' delete: '+error.message);});
    // A table referenced by a foreign key refuses a plain TRUNCATE with 0A000 before any trigger runs; CASCADE reaches every freeze trigger.
    await assert.rejects(tr.query(`TRUNCATE public.${table}`),error=>[QR002,'0A000'].includes(error.code),table+' plain truncate');
    await refused(tr.query(`TRUNCATE TABLE public.${table} RESTART IDENTITY CASCADE`),QR002).catch(error=>{throw Error(table+' truncate: '+error.message);});
    // the table owner / superuser meet it too, also with session_replication_role=replica (the triggers are ENABLE ALWAYS)
    for(const statement of [`UPDATE public.${table} SET ${column[table]}=${column[table]}`,`DELETE FROM public.${table}`,`TRUNCATE public.${table} CASCADE`]){
      await refused(db.query(statement),QR002);
      await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(statement);}),QR002);
    }
  }
  // an upsert or a MERGE that would rewrite a stored row meets the UPDATE guard; a DO NOTHING conflict writes nothing
  const blob=contentOf('x','x');await insertBlob(rt,blob);
  await refused(dl.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT (sha256) DO UPDATE SET size=0',[sha(blob),blob.length,blob]),QR002);
  assert.equal((await rt.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT (sha256) DO NOTHING',[sha(blob),blob.length,blob])).rowCount,0);
  await refused(dl.query('MERGE INTO public.bi_blobs t USING (SELECT $1::text AS h) s ON t.sha256=s.h WHEN MATCHED THEN UPDATE SET size=0',[sha(blob)]),QR002);
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await dl.query(`UPDATE public.bi_attempts SET validated_at_ms=1 WHERE attempt_id='no-such-attempt'`)).rowCount,0);
  // a data change through a disabled-trigger path is closed to the runtime: it cannot disable, drop or replace anything (see the grants test)
  assert.deepEqual(await allDigests(db),{...before,bi_blobs:await rowDigest(db,'bi_blobs')},'no refusal changed a row (blobs gained only the one blob inserted above)');
  assert.ok((await guardRows(db)).every(row=>row.tgenabled==='A'));
  // an INSERT under the replica role still meets the insert guards
  const pending=exportRow({owner:OWNER_A,runId:await newRun(OWNER_A,{scope:REAL_SCOPE}),files:filesOf('replica2'),fixture:false});
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(EXPORT_SQL,exportValues(pending));},{isolation:'SERIALIZABLE'}),QR004);
});

test('a session TEMP table named like a package table fools neither the guards nor the freeze',async()=>{
  const done=await terminal('EXPORT_VALIDATED');
  const live=await buildExport(rt);
  // a TEMP bi_status_events / bi_exports / bi_attempts that looks empty and non-terminal must not change what the guards read
  await refusedWith(rt.transaction(async()=>{
    for(const table of ['bi_status_events','bi_exports','bi_attempts','ql4c_validation'])await rt.query(`CREATE TEMP TABLE ${table}(LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,3,$2,$3,1,$4,$5)',[done.exportId,'EXPORT_CANDIDATE',RETRYABLE,T0,UTC]);
  }),QR004,/terminal status/);
  await refusedWith(rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE bi_attempts(LIKE public.bi_attempts INCLUDING DEFAULTS) ON COMMIT DROP');await rt.query('CREATE TEMP TABLE bi_status_events(LIKE public.bi_status_events INCLUDING DEFAULTS) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query(`INSERT INTO pg_temp.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
      VALUES($1,1,'att-fake',$2,true,'{}','[]','{}',$3,$4,$5)`,[live.exportId,live.package_hash,hex('validator'),T0,UTC]);
    await rt.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,$2,$3,1,$4,$5)',[live.exportId,'EXPORT_INTERNAL','{}',T0,UTC]);
  }),QR004,/latest validation attempt/);
  // a writer that qualifies its own insert still works with a TEMP table of the same name in front: the guards read the real tables
  await rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE bi_status_events(x integer) ON COMMIT DROP');await rt.query('SET LOCAL search_path = pg_temp, public');
    await attempt(rt,live,{});
    await rt.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,$2,$3,1,$4,$5)',[live.exportId,'EXPORT_CANDIDATE',RETRYABLE,T0,UTC]);
  });
  // the freeze still fires for the real table whatever search_path says, and a TEMP function cannot replace a pinned call
  await refused(dl.transaction(async()=>{
    await dl.query('CREATE TEMP TABLE bi_exports(x integer) ON COMMIT DROP');await dl.query('SET LOCAL search_path = pg_temp, public');
    await dl.query('UPDATE public.bi_exports SET created_at=created_at');
  }),QR002);
  await refused(dl.transaction(async()=>{
    await dl.query("CREATE FUNCTION pg_temp.pg_advisory_xact_lock(bigint) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$");
    await dl.query("CREATE FUNCTION pg_temp.raise_exception() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$");
    await dl.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await dl.query('DELETE FROM public.bi_clearances');
  }),QR002);
  assert.equal((await classifyBestInputsPackage(db)).state,'INSTALLED');
});

/* ---- 6. concurrency ---- */

test('race: two SERIALIZABLE writers of the same next seq or attempt number serialize on the export; exactly one commits',async()=>{
  const pack=await buildExport(rt);await attempt(rt,pack,{});
  const insideA=gate(),releaseA=gate();
  const holding=()=>`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted`;
  const writerA=rt.transaction(async()=>{await insertEvent(rt,pack.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE);insideA.open();await releaseA.promise;});
  await insideA.promise;
  const writerB=rt2.transaction(async()=>insertEvent(rt2,pack.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE)).then(()=>'WROTE',error=>error);
  await until(async()=>(await db.query(holding())).rows[0].n>=1,'writer B to wait for the export lock');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_status_events WHERE export_id=$1',[pack.exportId])).rows[0].n,1,'nothing of A is visible before it commits');
  releaseA.open();await writerA;
  const result=await writerB;
  assert.ok(result instanceof Error,'writer B refused');assert.ok([QR004,UNIQUE_VIOLATION,SERIALIZATION_FAILURE].includes(result.code),result.code+': '+result.message);   // a SERIALIZABLE writer that waited keeps its snapshot
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_status_events WHERE export_id=$1 AND seq=2',[pack.exportId])).rows[0].n,1);
  // two writers of the same attempt number
  const second=await buildExport(rt),inside=gate(),release=gate();
  const first=rt.transaction(async()=>{await attempt(rt,{...second},{no:1});inside.open();await release.promise;});
  await inside.promise;
  const rival=rt2.transaction(async()=>attempt(rt2,{...second},{no:1})).then(()=>'WROTE',error=>error);
  await until(async()=>(await db.query(holding())).rows[0].n>=1,'the rival attempt to wait');
  release.open();await first;
  const loser=await rival;assert.ok(loser instanceof Error);assert.ok([QR004,UNIQUE_VIOLATION,SERIALIZATION_FAILURE].includes(loser.code),loser.code);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_attempts WHERE export_id=$1',[second.exportId])).rows[0].n,1);
  // a terminal event racing an evidence row: the evidence row waits, then sees the terminal status and is refused
  const third=await buildExport(rt);await attempt(rt,third,{codes:['BI_NATIVE_SIGNAL_PARITY_FAILED']});
  const innerA=gate(),releaseB=gate();
  const terminalWriter=rt.transaction(async()=>{await insertEvent(rt,third.exportId,2,'EXPORT_REFUSED',1,['BI_NATIVE_SIGNAL_PARITY_FAILED']);innerA.open();await releaseB.promise;});
  await innerA.promise;
  const evidenceWriter=rt2.transaction(async()=>evidenceRecord(rt2,third.exportId,'repaint',{},hex('race'))).then(()=>'WROTE',error=>error);
  await until(async()=>(await db.query(holding())).rows[0].n>=1,'the evidence writer to wait');
  releaseB.open();await terminalWriter;
  // The late writer waited for the lock with a snapshot older than the terminal event. The terminal event read the candidate-record tables of the
  // export, so the writer is always refused (QR004, 40001); it never lands a row after the terminal status.
  const late=await evidenceWriter;
  assert.ok(late instanceof Error,'the late evidence writer is refused');
  assert.ok([QR004,SERIALIZATION_FAILURE].includes(late.code),late.code+': '+late.message);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_evidence_records WHERE export_id=$1',[third.exportId])).rows[0].n,0,'no evidence row landed after the terminal event');
  assert.equal((await db.query('SELECT status FROM public.bi_status_events WHERE export_id=$1 ORDER BY seq DESC LIMIT 1',[third.exportId])).rows[0].status,'EXPORT_REFUSED');
  await refusedWith(evidenceRecord(rt2,third.exportId,'repaint',{},hex('race-again')),QR004,/latest status EXPORT_CANDIDATE/);                       // a fresh snapshot is refused
});

test('SERIALIZABLE writers (the build transaction of RC-16): build, attempt, validation and the terminal event all commit; a rival of the same seq fails with 40001 or a guard code',async()=>{
  const serializable={isolation:'SERIALIZABLE'};
  const pack=await buildExport(rt,{scope:REAL_SCOPE,fixture:false,isolation:'SERIALIZABLE'});
  await rt.transaction(async()=>{await traceRecord(rt,pack.exportId);await compileRecord(rt,pack.exportId);await evidenceRecord(rt,pack.exportId);},serializable);
  await rt.transaction(async()=>{const id=await attempt(rt,pack,{pass:true});await validation(rt,pack,id);await insertEvent(rt,pack.exportId,2,'EXPORT_VALIDATED',1);},serializable);
  assert.equal((await db.query('SELECT status FROM public.bi_status_events WHERE export_id=$1 ORDER BY seq DESC LIMIT 1',[pack.exportId])).rows[0].status,'EXPORT_VALIDATED');
  // two SERIALIZABLE writers of the same seq: exactly one commits
  const racing=await buildExport(rt);await attempt(rt,racing,{});
  const settled=await Promise.allSettled([rt.transaction(()=>insertEvent(rt,racing.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE),serializable),
    rt2.transaction(()=>insertEvent(rt2,racing.exportId,2,'EXPORT_CANDIDATE',1,RETRYABLE),serializable)]);
  assert.equal(settled.filter(item=>item.status==='fulfilled').length,1,JSON.stringify(settled.map(item=>item.status==='rejected'?item.reason.code:'ok')));
  assert.ok(['40001',QR004,UNIQUE_VIOLATION].includes(settled.find(item=>item.status==='rejected').reason.code));
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_status_events WHERE export_id=$1 AND seq=2',[racing.exportId])).rows[0].n,1);
});

/* ---- 7. CLI ---- */

test('the CLI: install, second install, --inspect exit codes, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=track(new PostgresDatabase({connectionString:cliUrl,max:2}));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  const badRole=await inspect(['--runtime-role=no_such_role_s2b']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/Best Inputs package tables ready: best-inputs-package-v1; state=INSTALLED; previous state=ABSENT; guards=44/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  const ungranted=await inspect(['--runtime-role='+roleName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:bi_exports:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(roleName));
  const granted=await inspect(['--runtime-role='+roleName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.filter(item=>item.table==='bi_exports'||item.table==='bi_package_schema').map(item=>[item.table,item.insert,item.update,item.delete]).sort(),
    [['bi_exports',true,false,false],['bi_package_schema',false,false,false]]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.bi_exports DISABLE TRIGGER bi_exports_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.bi_exports ENABLE ALWAYS TRIGGER bi_exports_no_change');
  assert.equal((await inspect()).code,0);
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--bogus'],['--runtime-role=Bad-Name']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await packageObjects(cliDb),NONE);
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
});

/* ---- 8. rollback with evidence, dump and restore ---- */

test('rollback: empty tables are dropped completely; a table that holds a row is refused and unchanged; a blob alone counts',async()=>{
  const name=await clone('rollback');
  const target=track(new PostgresDatabase({connectionString:serialOf(name),max:3}));
  const targetStore=new Store(target);
  const owner=await newOwner('rb',target,targetStore);
  const baseline=await catalogDigest(target);
  await migrateBestInputsPackage(target);
  const rolled=await rollbackBestInputsPackage(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await packageObjects(target),NONE);
  assert.deepEqual((await catalogDigest(target)).n,baseline.n,'the catalog is back to the baseline object count');
  assert.deepEqual(await rollbackBestInputsPackage(target),{rolled_back:true,previous_state:'ABSENT'});
  await migrateBestInputsPackage(target);
  // a single blob is enough to refuse (evidence is never dropped)
  await insertBlob(target,Buffer.from(FIXTURE_LABEL+' lone blob'));
  await assert.rejects(rollbackBestInputsPackage(target),/rollback refused; 1 evidence row\(s\) exist in bi_blobs \(no change made\)/);
  assert.equal((await classifyBestInputsPackage(target)).state,'INSTALLED');
  const run=await newRun(owner,{target});
  const files=filesOf('rollback'),row=exportRow({owner,runId:run,files});
  await target.transaction(async()=>{
    for(const bytes of Object.values(files))await insertBlob(target,bytes);
    await target.query(EXPORT_SQL,exportValues(row));
    for(const [file,bytes] of Object.entries(files))await insertFile(target,row.export_id,file,bytes);
    await insertEvent(target,row.export_id,1,'EXPORT_CANDIDATE');
  },{isolation:'SERIALIZABLE'});
  const held=await allDigests(target),objects=await catalogDigest(target);
  await assert.rejects(rollbackBestInputsPackage(target),/rollback refused; 27 evidence row\(s\) exist in bi_exports, bi_package_files, bi_blobs, bi_status_events \(no change made\)/);
  assert.deepEqual(await allDigests(target),held,'the evidence rows are still there');assert.deepEqual(await catalogDigest(target),objects,'nothing else changed');
  assert.equal((await classifyBestInputsPackage(target)).state,'INSTALLED');
  // a writer that holds a row in an open transaction blocks the rollback from counting past it (ACCESS EXCLUSIVE), then the count sees it
  const empty=await clone('rollback2');
  const second=track(new PostgresDatabase({connectionString:serialOf(empty),max:3}));
  await migrateBestInputsPackage(second);
  const insert=gate(),finish=gate();
  const writer=second.transaction(async()=>{await insertBlob(second,Buffer.from(FIXTURE_LABEL+' late blob'));insert.open();await finish.promise;},{isolation:'SERIALIZABLE'});
  await insert.promise;
  const waiting=rollbackBestInputsPackage(track(new PostgresDatabase({connectionString:urlOf(empty),max:2})));
  const settled=waiting.then(()=>'DROPPED',error=>error.message);
  finish.open();await writer;
  assert.match(await settled,/rollback refused; 1 evidence row\(s\) exist in bi_blobs \(no change made\)/);
});

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS, the rows and the grants',async t=>{
  const restoredName='robot_s2b_restore_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-s2b-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'s2b.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=track(new PostgresDatabase({connectionString:serialOf(restoredName)})),restoredDeleter=track(new PostgresDatabase({connectionString:serialOf(restoredName,deleterName)}));
  const restoredRuntime=track(new PostgresDatabase({connectionString:serialOf(restoredName,roleName)}));
  assert.deepEqual(await guardRows(restored),await guardRows(db));assert.equal((await guardRows(restored)).length,44);assert.ok((await guardRows(restored)).every(row=>row.tgenabled==='A'));
  assert.deepEqual(await allDigests(restored),await allDigests(db),'every stored row came back');
  assert.equal((await classifyBestInputsPackage(restored)).state,'INSTALLED');
  const report=await inspectBestInputsPackage(restored,{runtimeRole:roleName});assert.equal(report.ok,true,report.failures.join());
  await refused(restoredRuntime.query('UPDATE public.bi_exports SET created_at=created_at'),DENIED);
  await refused(restoredDeleter.query('UPDATE public.bi_exports SET created_at=created_at'),QR002);
  await refused(restoredDeleter.query('DELETE FROM public.bi_attempts'),QR002);
  await buildExport(restoredRuntime,{owner:OWNER_A,runId:await newRun(OWNER_A,{target:restored})});          // the insert guards and the deferred check survive the restore
  await refusedWith(buildExport(restoredRuntime,{owner:OWNER_A,events:false,runId:await newRun(OWNER_A,{target:restored})}),QR004,/same transaction/);
});
