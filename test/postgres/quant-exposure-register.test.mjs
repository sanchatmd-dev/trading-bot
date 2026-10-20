import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {EXPOSURE_GUARDS,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,REGISTER_MARKER,classifyQuantExposureRegister,inspectQuantExposureRegister,migrateQuantExposureRegister,
  rollbackQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {EXPOSURE_CODES,appendExposures,readExposures,toComparisonEntries,toPackageEntries} from '../../src/postgres/exposure-register.js';
import {canonical} from '../../src/pine-bridge/source.js';
import {CODES as QR3_CODES,REQUIRED_MARKET} from '../../src/comparison/common.js';
import {exposuresOverlapping} from '../../src/comparison/evidence.js';
import {CODES as QR4_CODES} from '../../src/selection/codes.js';
import {overlapsExposure} from '../../src/selection/window.js';
import {hex,MINUTE,T0} from '../helpers/quant-library-fixture.mjs';

// QR-3 S2a exposure register, proven on a throwaway PostgreSQL cluster as real non-owner LOGIN roles with the repo grants.
// Every row is a LABELLED FIXTURE (synthetic, never a research result). Rows are insert-only, so each test uses its own owner or ids.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,DENIED='42501',SERIALIZATION_FAILURE='40001';
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const WINDOW={start_ms:T0,end_ms:T0+60*MINUTE};
const REGISTER='public.quant_exposure_register',MARKER='public.quant_exposure_register_schema';
const AT=Date.UTC(2026,9,19,11,0,0);
const CLI='scripts/migrate-quant-exposure-register.mjs';
let admin,db,rt,rt2,dl,tr,connectionString,templateName,databaseName,roleName,deleterName,truncaterName,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const serializable={isolation:'SERIALIZABLE'};
const track=pool=>{pools.push(pool);return pool;};

/** A database built from the template (base schema 14 plus the research extension 1, no register). */
async function clone(label){
  const name='robot_s2a_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  return name;
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog. */
async function probe(target,fn){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();});}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.oid||':'||c.xmin::text||':'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.oid||':'||k.xmin::text||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
const registerObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'quant\\_exposure\\_register%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'quant\\_exposure\\_register%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'quant\\_exposure\\_register%') triggers`)).rows[0];
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE t.tgrelid='public.quant_exposure_register'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
const rowDigest=async target=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY t.exposure_id),''),'UTF8')),'hex') d FROM public.quant_exposure_register t`)).rows[0];
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;
const insertSql='INSERT INTO public.quant_exposure_register(kind,owner_id,broker,symbol,timeframe,start_ms,end_ms,comparison_id,participant_run_id,source_hash,selection_id,at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
const rawRow=(owner,over={})=>({kind:'QR3_COMPARISON',owner_id:owner,...MARKET,...WINDOW,comparison_id:'cmp-'+randomUUID(),participant_run_id:'p-1',source_hash:hex('s'),selection_id:null,at_ms:AT,...over});
const valuesOf=row=>[row.kind,row.owner_id,row.broker,row.symbol,row.timeframe,row.start_ms,row.end_ms,row.comparison_id,row.participant_run_id,row.source_hash,row.selection_id,row.at_ms];
const qr4Row=(owner,over={})=>rawRow(owner,{kind:'QR4_SELECTION',comparison_id:null,participant_run_id:null,source_hash:null,selection_id:'sel-'+randomUUID(),...over});
const insertRaw=(target,row,isolation='SERIALIZABLE')=>target.transaction(()=>target.query(insertSql,valuesOf(row)),{isolation});
const event=(id,over={})=>({kind:'QR3_COMPARISON',window:{...WINDOW},comparison_id:id,participant_run_id:'p-1',source_hash:hex('s'),at_ms:1,...over});
const marketOf=owner=>({owner_id:owner,...MARKET});
// The writer reads one clock per call and ignores an event at_ms; the tests fix the clock at AT.
const append=(target,args)=>appendExposures(target,{now:()=>AT,...args});
const overlapsIn=(read,owner,window=WINDOW)=>exposuresOverlapping({register:toComparisonEntries(read),owner_id:owner,market_key:canonical(REQUIRED_MARKET),window}).ids.length>0;
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}
async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  return user.id;
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
  templateName='robot_s2a_tpl_'+suffix;databaseName='robot_s2a_main_'+suffix;
  roleName='robot_s2a_rt_'+suffix.slice(0,14);deleterName='robot_s2a_del_'+suffix.slice(0,14);truncaterName='robot_s2a_trn_'+suffix.slice(0,14);
  for(const name of [roleName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString,max:6}));
  store=new Store(db);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [roleName,deleterName,truncaterName])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. install lifecycle ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing',async()=>{
  const before=await catalogDigest(db);
  const classification=await classifyQuantExposureRegister(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectQuantExposureRegister(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectQuantExposureRegister(db,{runtimeRole:'no_such_role_s2a'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await registerObjects(db),{relations:0,functions:0,triggers:0});
});

test('absent: a same-name foreign object classifies OTHER, so an install over it would be refused',async()=>{
  const noop="CREATE FUNCTION public.s2a_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign register table','CREATE TABLE public.quant_exposure_register(x integer)','TABLE_DEFINITION:quant_exposure_register:'],
    ['foreign marker table','CREATE TABLE public.quant_exposure_register_schema(version integer)','TABLE_DEFINITION:quant_exposure_register_schema:'],
    ['foreign marker function',"CREATE FUNCTION public.quant_exposure_register_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:quant_exposure_register_version:'],
    ['overload of a guard function','CREATE FUNCTION public.quant_exposure_register_insert_only(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:quant_exposure_register_insert_only('],
    ['view carrying an index name','CREATE VIEW public.quant_exposure_register_lookup AS SELECT 1 AS x','RELATION_UNEXPECTED:quant_exposure_register_lookup'],
    ['sequence carrying an index name','CREATE SEQUENCE public.quant_exposure_register_pkey','RELATION_UNEXPECTED:quant_exposure_register_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.quant_exposure_register AS integer','TYPE_UNEXPECTED:quant_exposure_register'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER quant_exposure_register_serializable BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.s2a_noop()','TRIGGER_UNEXPECTED:quant_exposure_register_serializable']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyQuantExposureRegister(db),report:await inspectQuantExposureRegister(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await registerObjects(db),{relations:0,functions:0,triggers:0},'every probe was rolled back');
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, tables and grants stay as they were; a second install is a no-op',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S') AND c.relname NOT LIKE 'quant\\_exposure\\_register%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migrateQuantExposureRegister(db,{runtimeRole:roleName});
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,REGISTER_MARKER);assert.equal(report.facts.guards.length,3);
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(name=>!baseTables.includes(name)),
    ['quant_exposure_register','quant_exposure_register_schema'],'exactly the two register tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await registerObjects(db),{relations:7,functions:3,triggers:3},'two tables, five indexes, three functions and three triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM quant_exposure_register_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.quant_exposure_register_version() v')).rows[0].v,REGISTER_MARKER);
  // The install adds no grant: the runtime role cannot even read the new table until the grant script is reapplied.
  assert.deepEqual((await guardRows(db)).map(row=>[row.tgname,row.tgenabled,row.tgtype]).sort(),EXPOSURE_GUARDS.map(item=>[item[0],'A',item[2]]).sort());
  const settled=await catalogDigest(db);
  const again=await migrateQuantExposureRegister(db,{runtimeRole:roleName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyQuantExposureRegister(db)).state,'INSTALLED');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.s2a_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const T='ALTER TABLE public.quant_exposure_register ';
  const OTHER_OWNER='CREATE ROLE s2a_other_owner NOLOGIN; ';
  const redo=(name,when,fn)=>`DROP TRIGGER ${name} ON public.quant_exposure_register; CREATE TRIGGER ${name} ${when} ON public.quant_exposure_register FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const cases=[
    ['guard body replaced',"CREATE OR REPLACE FUNCTION public.quant_exposure_register_insert_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:quant_exposure_register_insert_only:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.quant_exposure_register_serializable_insert() SECURITY DEFINER','FUNCTION_DEFINITION:quant_exposure_register_serializable_insert:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.quant_exposure_register_serializable_insert() RESET search_path','FUNCTION_DEFINITION:quant_exposure_register_serializable_insert:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.quant_exposure_register_insert_only() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:quant_exposure_register_insert_only:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.quant_exposure_register_insert_only() STRICT','FUNCTION_DEFINITION:quant_exposure_register_insert_only:ATTRIBUTES'],
    ['trigger disabled',T+'DISABLE TRIGGER quant_exposure_register_no_change','TRIGGER_NOT_ALWAYS:quant_exposure_register_no_change'],
    ['trigger origin only',T+'ENABLE TRIGGER quant_exposure_register_serializable','TRIGGER_NOT_ALWAYS:quant_exposure_register_serializable'],
    ['trigger replica only',T+'ENABLE REPLICA TRIGGER quant_exposure_register_no_truncate','TRIGGER_NOT_ALWAYS:quant_exposure_register_no_truncate'],
    ['trigger dropped','DROP TRIGGER quant_exposure_register_no_truncate ON public.quant_exposure_register','TRIGGER_MISSING:quant_exposure_register_no_truncate'],
    ['trigger rebound to the other function',redo('quant_exposure_register_no_change','BEFORE UPDATE OR DELETE','quant_exposure_register_serializable_insert')+' '+T+'ENABLE ALWAYS TRIGGER quant_exposure_register_no_change','TRIGGER_FUNCTION:quant_exposure_register_no_change'],
    ['trigger narrowed to UPDATE only',redo('quant_exposure_register_no_change','BEFORE UPDATE','quant_exposure_register_insert_only')+' '+T+'ENABLE ALWAYS TRIGGER quant_exposure_register_no_change','TRIGGER_SHAPE:quant_exposure_register_no_change'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER s2a_marker AFTER INSERT ON public.quant_exposure_register_schema FOR EACH ROW EXECUTE FUNCTION public.s2a_noop()','TRIGGER_UNEXPECTED:s2a_marker'],
    ['extra foreign trigger',noop+' CREATE TRIGGER s2a_extra AFTER INSERT ON public.quant_exposure_register FOR EACH ROW EXECUTE FUNCTION public.s2a_noop()','TRIGGER_UNEXPECTED:s2a_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER s2a_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.quant_exposure_register_insert_only()','TRIGGER_UNEXPECTED:s2a_elsewhere'],
    ['check constraint dropped',T+'DROP CONSTRAINT quant_exposure_register_kind_fields_check','TABLE_DEFINITION:quant_exposure_register:CONSTRAINTS'],
    ['check constraint weakened',T+'DROP CONSTRAINT quant_exposure_register_end_ms_check, ADD CONSTRAINT quant_exposure_register_end_ms_check CHECK(end_ms>0)','TABLE_DEFINITION:quant_exposure_register:CONSTRAINTS'],
    ['extra constraint',T+'ADD CONSTRAINT s2a_extra CHECK(at_ms>=0)','TABLE_DEFINITION:quant_exposure_register:CONSTRAINTS'],
    ['foreign key dropped',T+'DROP CONSTRAINT quant_exposure_register_owner_id_fkey','TABLE_DEFINITION:quant_exposure_register:CONSTRAINTS'],
    ['unique constraint dropped',T+'DROP CONSTRAINT quant_exposure_register_qr3_unique','TABLE_DEFINITION:quant_exposure_register:'],
    ['partial unique index dropped','DROP INDEX public.quant_exposure_register_qr4_unique','INDEX_MISSING:quant_exposure_register_qr4_unique'],
    ['partial unique index widened','DROP INDEX public.quant_exposure_register_qr4_unique; CREATE UNIQUE INDEX quant_exposure_register_qr4_unique ON public.quant_exposure_register(selection_id)','TABLE_DEFINITION:quant_exposure_register:INDEXES'],
    ['extra index','CREATE INDEX s2a_extra ON public.quant_exposure_register(at_ms)','TABLE_DEFINITION:quant_exposure_register:INDEXES'],
    ['lookup index changed','DROP INDEX public.quant_exposure_register_lookup; CREATE INDEX quant_exposure_register_lookup ON public.quant_exposure_register(owner_id)','TABLE_DEFINITION:quant_exposure_register:INDEXES'],
    ['column default added',T+'ALTER COLUMN at_ms SET DEFAULT 0','TABLE_DEFINITION:quant_exposure_register:COLUMNS'],
    ['column made required',T+'ALTER COLUMN comparison_id SET NOT NULL','TABLE_DEFINITION:quant_exposure_register:COLUMNS'],
    ['column added',T+'ADD COLUMN extra integer','TABLE_DEFINITION:quant_exposure_register:COLUMNS'],
    ['column type changed',T+'ALTER COLUMN source_hash TYPE character varying(64)','TABLE_DEFINITION:quant_exposure_register:'],
    ['column collation changed',T+'ALTER COLUMN source_hash TYPE text COLLATE "C"','TABLE_DEFINITION:quant_exposure_register:COLLATION'],
    ['column collation changed on a second column',T+'ALTER COLUMN kind TYPE text COLLATE "POSIX"','TABLE_DEFINITION:quant_exposure_register:COLLATION'],
    ['table re-owned to another role',OTHER_OWNER+T+'OWNER TO s2a_other_owner','OWNER_MISMATCH:quant_exposure_register'],
    ['marker table re-owned to another role',OTHER_OWNER+'ALTER TABLE public.quant_exposure_register_schema OWNER TO s2a_other_owner','OWNER_MISMATCH:quant_exposure_register'],
    ['guard function re-owned to another role',OTHER_OWNER+'ALTER FUNCTION public.quant_exposure_register_insert_only() OWNER TO s2a_other_owner','OWNER_MISMATCH:quant_exposure_register_insert_only'],
    ['marker function re-owned to another role',OTHER_OWNER+'ALTER FUNCTION public.quant_exposure_register_version() OWNER TO s2a_other_owner','OWNER_MISMATCH:quant_exposure_register_version'],
    ['row security enabled',T+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:quant_exposure_register:SHAPE'],
    ['rule added','CREATE RULE s2a_rule AS ON INSERT TO public.quant_exposure_register DO ALSO NOTHING','TABLE_DEFINITION:quant_exposure_register:SHAPE'],
    ['marker row removed','DELETE FROM public.quant_exposure_register_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.quant_exposure_register_schema DROP CONSTRAINT quant_exposure_register_schema_version_check','TABLE_DEFINITION:quant_exposure_register_schema:CONSTRAINTS'],
    ['marker table dropped','ALTER TABLE public.quant_exposure_register_schema RENAME TO s2a_renamed','TABLE_MISSING:quant_exposure_register_schema']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyQuantExposureRegister(db),report:await inspectQuantExposureRegister(db)};});
    assert.equal(found.classification.state,'OTHER',label+': '+found.classification.problems.join());
    const items=[...found.classification.problems,...found.classification.missing];
    // An owner mismatch is matched by exact name: includes() takes no prefix, so a longer name that starts with it never satisfies it. A re-owned function
    // leaves the table alone, so the shorter table name must be absent then: the longer function name is not accepted in its place.
    if(prefix.startsWith('OWNER_MISMATCH:')){
      const mismatches=items.filter(item=>item.startsWith('OWNER_MISMATCH:'));
      assert.ok(mismatches.includes(prefix),label+': '+items.join());
      if(label.includes('function'))assert.ok(!mismatches.includes('OWNER_MISMATCH:quant_exposure_register'),label+': '+items.join());
    }
    else assert.ok(items.some(item=>item.startsWith(prefix)),label+': '+items.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.quant_exposure_register_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectQuantExposureRegister(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:quant_exposure_register_version:BODY')));
  assert.equal((await classifyQuantExposureRegister(db)).state,'INSTALLED','every tamper was rolled back');
});

test('the runtime-role inspection is the shared one: privileged membership, a privilege reached without inheriting it, a column-level write grant and CREATE on public are named',async()=>{
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  const failuresOf=(setup,role,options={})=>probe(db,async()=>{await db.query(setup);return (await inspectQuantExposureRegister(db,{runtimeRole:role,requireGrants:false,...options})).failures;});
  // A clean role reports none of the shared failures.
  assert.deepEqual(await failuresOf('CREATE ROLE s2a_plain NOLOGIN','s2a_plain'),[]);
  // A member of a BYPASSRLS or superuser role, even without inheriting it, is a privileged member.
  const privileged=await failuresOf('CREATE ROLE s2a_bypass NOLOGIN BYPASSRLS; CREATE ROLE s2a_super NOLOGIN SUPERUSER; CREATE ROLE s2a_pm NOLOGIN NOINHERIT; GRANT s2a_bypass TO s2a_pm; GRANT s2a_super TO s2a_pm','s2a_pm');
  assert.ok(privileged.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:s2a_bypass')&&privileged.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:s2a_super'),privileged.join());
  // TRUNCATE, TRIGGER and DELETE held by a role the runtime role reaches without inheriting it (NOINHERIT) still count; DELETE keeps its register name.
  const reached=await failuresOf(`CREATE ROLE s2a_holder NOLOGIN; GRANT TRUNCATE,TRIGGER,DELETE ON ${REGISTER} TO s2a_holder; CREATE ROLE s2a_noinherit NOLOGIN NOINHERIT; GRANT s2a_holder TO s2a_noinherit`,'s2a_noinherit');
  for(const failure of ['RUNTIME_ROLE_TRUNCATE_PRIVILEGE:quant_exposure_register','RUNTIME_ROLE_TRIGGER_PRIVILEGE:quant_exposure_register','RUNTIME_ROLE_DELETE_PRIVILEGE:quant_exposure_register'])
    assert.ok(reached.includes(failure),failure+': '+reached.join());
  assert.ok(!reached.some(item=>item.startsWith('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_exposure_register:DELETE')),'the register DELETE failure keeps its own name');
  if(version>=160000){
    const viaGrant=await failuresOf(`CREATE ROLE s2a_holder2 NOLOGIN; GRANT TRUNCATE ON ${REGISTER} TO s2a_holder2; CREATE ROLE s2a_member2 NOLOGIN INHERIT; GRANT s2a_holder2 TO s2a_member2 WITH INHERIT FALSE`,'s2a_member2');
    assert.ok(viaGrant.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:quant_exposure_register'),viaGrant.join());
  }
  // A column-level INSERT or UPDATE grant on the read-only marker table is a write path that has_table_privilege does not see.
  const column=await failuresOf(`CREATE ROLE s2a_col NOLOGIN; GRANT UPDATE (version), INSERT (version) ON ${MARKER} TO s2a_col`,'s2a_col');
  for(const privilege of ['UPDATE','INSERT'])assert.ok(column.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_exposure_register_schema:'+privilege),privilege+': '+column.join());
  // A column SELECT never satisfies a required table-level privilege.
  const columnOnly=await failuresOf(`CREATE ROLE s2a_colonly NOLOGIN; GRANT SELECT (exposure_id), INSERT (exposure_id) ON ${REGISTER} TO s2a_colonly`,'s2a_colonly',{requireGrants:true});
  for(const privilege of ['SELECT','INSERT'])assert.ok(columnOnly.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:quant_exposure_register:'+privilege),privilege+': '+columnOnly.join());
  // CREATE on schema public, held through a role the runtime role reaches without inheriting it.
  const create=await failuresOf('CREATE ROLE s2a_creator NOLOGIN; GRANT CREATE ON SCHEMA public TO s2a_creator; CREATE ROLE s2a_via NOLOGIN NOINHERIT; GRANT s2a_creator TO s2a_via','s2a_via');
  assert.ok(create.includes('RUNTIME_ROLE_SCHEMA_CREATE'),create.join());
  // Membership of the database owner is ownership of schema public (PostgreSQL 15 and later).
  if(version>=150000){
    const owner=(await db.query('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname=current_database()')).rows[0].o;
    const schema=await failuresOf(`CREATE ROLE s2a_dbm NOLOGIN; GRANT ${owner} TO s2a_dbm`,'s2a_dbm');
    assert.ok(schema.includes('RUNTIME_ROLE_OWNS_SCHEMA:public'),schema.join());
  }
  assert.equal((await classifyQuantExposureRegister(db)).state,'INSTALLED','every probe was rolled back');
});

test('offline only: the install and the rollback need the maintenance lock, their own transaction and the research extension',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateQuantExposureRegister(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackQuantExposureRegister(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateQuantExposureRegister(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackQuantExposureRegister(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
  // A database without the research extension: refused before any write.
  const bareName='robot_s2a_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));
  await bare.migrate();
  await assert.rejects(migrateQuantExposureRegister(bare),/Quant research extension 1 required/);
  assert.deepEqual(await registerObjects(bare),{relations:0,functions:0,triggers:0});
  await bare.query('CREATE TABLE quant_job_schema(version INTEGER)');await bare.query('INSERT INTO quant_job_schema VALUES(2)');
  await assert.rejects(migrateQuantExposureRegister(bare),/Unsupported quant_job_schema version/);
  assert.deepEqual(await registerObjects(bare),{relations:0,functions:0,triggers:0});
});

test('a foreign or partial register is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.quant_exposure_register(x integer)');await foreign.query('INSERT INTO public.quant_exposure_register VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateQuantExposureRegister(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackQuantExposureRegister(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.quant_exposure_register')).rows,[{x:7}],'the foreign row survived');
  await migrateQuantExposureRegister(partial);
  await partial.query('DROP TRIGGER quant_exposure_register_no_truncate ON public.quant_exposure_register');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateQuantExposureRegister(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:quant_exposure_register_no_truncate/);
  await assert.rejects(rollbackQuantExposureRegister(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyQuantExposureRegister(partial)).state,'OTHER');
});

/* ---- 2. grants, insert-only guards, isolation guard ---- */

let OWNER_A,OWNER_B;
test('grants: the repo grant script gives the runtime role INSERT and the lock-carrying UPDATE, never DELETE, TRUNCATE or TRIGGER; reapply is idempotent',async()=>{
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  await db.query(`GRANT DELETE ON TABLE ${REGISTER} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${REGISTER} TO ${truncaterName}`);
  rt=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:4}));rt2=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:4}));
  dl=track(new PostgresDatabase({connectionString:urlOf(databaseName,deleterName),max:2}));tr=track(new PostgresDatabase({connectionString:urlOf(databaseName,truncaterName),max:2}));
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  await db.query(await grantScript(roleName));await db.query(await grantScript(deleterName));await db.query(await grantScript(truncaterName));
  await db.query(`GRANT DELETE ON TABLE ${REGISTER} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${REGISTER} TO ${truncaterName}`);
  assert.equal(await acl(),first,'a second application of the grant script changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger
    FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  assert.deepEqual(await facts(roleName,REGISTER),{owner:false,select:true,insert:true,update:true,delete:false,truncate:false,trigger:false});
  assert.deepEqual(await facts(roleName,MARKER),{owner:false,select:true,insert:false,update:false,delete:false,truncate:false,trigger:false},'the marker table is read-only');
  assert.equal((await facts(deleterName,REGISTER)).delete,true);assert.equal((await facts(truncaterName,REGISTER)).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // inspect with the runtime role passes, and names the role that broke the boundary
  const ok=await inspectQuantExposureRegister(db,{runtimeRole:roleName});assert.equal(ok.ok,true,ok.failures.join());
  assert.ok((await inspectQuantExposureRegister(db,{runtimeRole:deleterName})).failures.includes('RUNTIME_ROLE_DELETE_PRIVILEGE:quant_exposure_register'));
  assert.ok((await inspectQuantExposureRegister(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:quant_exposure_register'));
  assert.ok((await inspectQuantExposureRegister(db,{runtimeRole:'robot_test'})).failures.some(item=>item.startsWith('RUNTIME_ROLE_SUPERUSER')||item.startsWith('RUNTIME_ROLE_OWNS:')));
  // Membership of the owning role counts as ownership, for the tables and for each register function (all rolled back).
  const memberOf=await probe(db,async()=>{
    await db.query('CREATE ROLE s2a_member NOLOGIN');await db.query('GRANT '+(await db.query('SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=$1::regclass',[REGISTER])).rows[0].o+' TO s2a_member');
    return inspectQuantExposureRegister(db,{runtimeRole:'s2a_member'});
  });
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS:quant_exposure_register')&&memberOf.failures.includes('RUNTIME_ROLE_OWNS:quant_exposure_register_schema'),memberOf.failures.join());
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS_FUNCTION:quant_exposure_register_insert_only'),memberOf.failures.join());
  const fnOwner=await probe(db,async()=>{
    await db.query('CREATE ROLE s2a_fn_owner NOLOGIN');await db.query('CREATE ROLE s2a_fn_member NOLOGIN');await db.query('GRANT s2a_fn_owner TO s2a_fn_member');
    await db.query('ALTER FUNCTION public.quant_exposure_register_serializable_insert() OWNER TO s2a_fn_owner');
    return inspectQuantExposureRegister(db,{runtimeRole:'s2a_fn_member',requireGrants:false});
  });
  assert.deepEqual(fnOwner.failures.filter(item=>item.startsWith('RUNTIME_ROLE_OWNS')),['RUNTIME_ROLE_OWNS_FUNCTION:quant_exposure_register_serializable_insert']);
  // The role cannot disable a guard, replace a function or change the replication role.
  await refused(rt.query(`ALTER TABLE ${REGISTER} DISABLE TRIGGER quant_exposure_register_no_change`),DENIED);
  await refused(rt.query(`ALTER TABLE ${REGISTER} DISABLE TRIGGER ALL`),DENIED);
  await refused(rt.query(`DROP TRIGGER quant_exposure_register_serializable ON ${REGISTER}`),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.quant_exposure_register_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query(`DROP TABLE ${REGISTER}`),DENIED);
  await refused(rt.query(`INSERT INTO ${MARKER} VALUES(2)`),DENIED);await refused(rt.query(`UPDATE ${MARKER} SET version=1`),DENIED);await refused(rt.query(`DELETE FROM ${MARKER}`),DENIED);
  OWNER_A=await newOwner('s2a-a');OWNER_B=await newOwner('s2a-b');
  assert.equal((await classifyQuantExposureRegister(db)).state,'INSTALLED');
});

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers; the replication role cannot skip a guard; no row changes',async()=>{
  const first=rawRow(OWNER_A);await insertRaw(rt,first);await insertRaw(rt,qr4Row(OWNER_A));
  const before=await rowDigest(db);assert.equal(before.n,2);
  // layer 1 (privilege): the runtime role holds no DELETE or TRUNCATE
  await refused(rt.query(`DELETE FROM ${REGISTER}`),DENIED);await refused(rt.query(`TRUNCATE ${REGISTER}`),DENIED);await refused(rt.query(`DELETE FROM ${REGISTER} WHERE owner_id=$1`,[OWNER_A]),DENIED);
  // layer 2 (trigger): the runtime role's UPDATE reaches the guard
  for(const [label,statement,params] of [
    ['update of one column',`UPDATE ${REGISTER} SET at_ms=at_ms+1 WHERE owner_id=$1`,[OWNER_A]],
    ['update of every row',`UPDATE ${REGISTER} SET at_ms=at_ms`,[]],
    ['update to the same value',`UPDATE ${REGISTER} SET kind=kind WHERE owner_id=$1`,[OWNER_A]],
    ['update of the key',`UPDATE ${REGISTER} SET exposure_id=gen_random_uuid() WHERE owner_id=$1`,[OWNER_A]],
    ['update of a window',`UPDATE ${REGISTER} SET end_ms=end_ms+60000 WHERE owner_id=$1`,[OWNER_A]]])
    await refused(rt.query(statement,params),QR002).catch(error=>{throw Error(label+': '+error.message);});
  // an upsert or a MERGE that would rewrite a stored row meets the UPDATE guard; a DO NOTHING conflict is allowed and writes nothing
  const existing=(await db.query(`SELECT exposure_id FROM ${REGISTER} WHERE owner_id=$1 ORDER BY exposure_id LIMIT 1`,[OWNER_A])).rows[0].exposure_id;
  const upsert=tail=>`INSERT INTO ${REGISTER}(exposure_id,kind,owner_id,broker,symbol,timeframe,start_ms,end_ms,comparison_id,participant_run_id,source_hash,selection_id,at_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (exposure_id) ${tail}`;
  const upsertValues=[existing,...valuesOf(rawRow(OWNER_A))];
  await refused(rt.transaction(()=>rt.query(upsert('DO UPDATE SET at_ms=0'),upsertValues),serializable),QR002);
  assert.equal((await rt.transaction(()=>rt.query(upsert('DO NOTHING'),upsertValues),serializable)).rowCount,0);
  await refused(rt.transaction(()=>rt.query(`MERGE INTO ${REGISTER} t USING (SELECT $1::uuid AS id) s ON t.exposure_id=s.id WHEN MATCHED THEN UPDATE SET at_ms=0`,[existing]),serializable),QR002);
  // a deleter that holds DELETE and a truncater that holds TRUNCATE still meet the guard
  await refused(dl.query(`DELETE FROM ${REGISTER} WHERE owner_id=$1`,[OWNER_A]),QR002);await refused(dl.query(`DELETE FROM ${REGISTER}`),QR002);
  await refused(tr.query(`TRUNCATE ${REGISTER}`),QR002);await refused(tr.query(`TRUNCATE TABLE ${REGISTER} RESTART IDENTITY`),QR002);
  // the table owner and a superuser meet it too, also with session_replication_role=replica (the triggers are ENABLE ALWAYS)
  for(const statement of [`UPDATE ${REGISTER} SET at_ms=at_ms`,`DELETE FROM ${REGISTER}`,`TRUNCATE ${REGISTER}`]){
    await refused(db.query(statement),QR002);
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(statement);}),QR002);
  }
  // an INSERT under the replica role still meets the isolation guard
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(insertSql,valuesOf(rawRow(OWNER_A)));}),QR003);
  assert.deepEqual(await rowDigest(db),before,'no refusal changed a row');
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await rt.query(`UPDATE ${REGISTER} SET at_ms=1 WHERE owner_id='no-such-owner'`)).rowCount,0);
  assert.deepEqual(await rowDigest(db),before);
  assert.deepEqual((await guardRows(db)).map(row=>row.tgenabled),['A','A','A']);
});

test('isolation guard: an INSERT below SERIALIZABLE is refused (QR003); SERIALIZABLE commits; a TEMP function cannot fake the setting',async()=>{
  const row=()=>rawRow(OWNER_A);
  const before=await rowDigest(db);
  await refused(rt.query(insertSql,valuesOf(row())),QR003);                                      // autocommit READ COMMITTED
  await refused(insertRaw(rt,row(),'READ COMMITTED'),QR003);
  await refused(insertRaw(rt,row(),'REPEATABLE READ'),QR003);
  await refused(insertRaw(rt,qr4Row(OWNER_A),'REPEATABLE READ'),QR003);
  await refused(insertRaw(db,row(),'READ COMMITTED'),QR003);                                    // the owner meets it too
  await refused(db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');await db.query(insertSql,valuesOf(row()));}),'25006');
  assert.deepEqual(await rowDigest(db),before,'the refused inserts wrote nothing');
  // a serializable read-write transaction commits
  await insertRaw(rt,row());
  await rt.transaction(()=>rt.query(insertSql,valuesOf(row())),serializable);
  assert.equal((await rowDigest(db)).n,before.n+2);
  // a session TEMP function named like the settings reader never replaces the schema-qualified call inside the guard
  await refused(rt.transaction(async()=>{
    await rt.query("CREATE FUNCTION pg_temp.current_setting(text) RETURNS text LANGUAGE sql AS $$ SELECT 'serializable'::text $$");
    await rt.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await rt.query(insertSql,valuesOf(row()));
  },{isolation:'READ COMMITTED'}),QR003);
  // the JS writer refuses below SERIALIZABLE too, after its LOCK and before any read or write
  const lowered=await rowDigest(db);
  await assert.rejects(rt.transaction(()=>append(rt,{...marketOf(OWNER_A),events:[event('cmp-low')]}),{isolation:'REPEATABLE READ'}),error=>error.code===QR003);
  await assert.rejects(rt.transaction(()=>append(rt,{...marketOf(OWNER_A),events:[event('cmp-low')]})),error=>error.code===QR003);
  assert.deepEqual(await rowDigest(db),lowered);
});

/* ---- 3. table rules ---- */

test('table rules: every malformed shape is a CHECK, NOT NULL or foreign-key failure; duplicates are unique violations',async()=>{
  const O=OWNER_B,HASH=hex('rule');
  const bad=[
    ['unknown kind',rawRow(O,{kind:'OTHER'}),'23514'],
    ['QR3 without comparison id',rawRow(O,{comparison_id:null}),'23514'],['QR3 with an empty comparison id',rawRow(O,{comparison_id:''}),'23514'],
    ['QR3 without participant',rawRow(O,{participant_run_id:null}),'23514'],['QR3 with an empty participant',rawRow(O,{participant_run_id:''}),'23514'],
    ['QR3 without a hash (NULL does not pass a CHECK)',rawRow(O,{source_hash:null}),'23514'],['QR3 with an uppercase hash',rawRow(O,{source_hash:HASH.toUpperCase()}),'23514'],
    ['QR3 with a short hash',rawRow(O,{source_hash:HASH.slice(1)}),'23514'],['QR3 with a long hash',rawRow(O,{source_hash:HASH+'0'}),'23514'],
    ['QR3 with a selection id',rawRow(O,{selection_id:'sel-both'}),'23514'],
    ['QR4 without a selection id',qr4Row(O,{selection_id:null}),'23514'],['QR4 with an empty selection id',qr4Row(O,{selection_id:''}),'23514'],
    ['QR4 with a comparison id',qr4Row(O,{comparison_id:'cmp-both'}),'23514'],['QR4 with a participant',qr4Row(O,{participant_run_id:'p'}),'23514'],
    ['QR4 with a source hash',qr4Row(O,{source_hash:HASH}),'23514'],
    ['misaligned start',rawRow(O,{start_ms:WINDOW.start_ms+1}),'23514'],['misaligned end',rawRow(O,{end_ms:WINDOW.end_ms+1}),'23514'],
    ['negative start',rawRow(O,{start_ms:-60000,end_ms:60000}),'23514'],['end equals start',rawRow(O,{end_ms:WINDOW.start_ms}),'23514'],
    ['end before start',rawRow(O,{end_ms:WINDOW.start_ms-60000}),'23514'],
    ['end beyond year 10000',rawRow(O,{start_ms:253402300800000,end_ms:253402300860000}),'23514'],['end one minute beyond year 10000',rawRow(O,{start_ms:253402300740000,end_ms:253402300860000}),'23514'],
    ['negative at',rawRow(O,{at_ms:-1}),'23514'],['at beyond year 9999',rawRow(O,{at_ms:253402300800000}),'23514'],
    ['empty broker',rawRow(O,{broker:''}),'23514'],['empty symbol',rawRow(O,{symbol:''}),'23514'],['empty timeframe',rawRow(O,{timeframe:''}),'23514'],
    ['null kind',rawRow(O,{kind:null}),'23502'],['null owner',rawRow(O,{owner_id:null}),'23502'],['null market',rawRow(O,{symbol:null}),'23502'],
    ['null window',rawRow(O,{start_ms:null}),'23502'],['null clock',rawRow(O,{at_ms:null}),'23502'],
    ['unknown owner',rawRow('no-such-owner'),'23503']];
  for(const [label,row,code] of bad)await refused(insertRaw(rt,row),code).catch(error=>{throw Error(label+': '+error.message);});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=$1`,[O])).rows[0].n,0,'no malformed row was stored');
  // boundary values that are valid
  await insertRaw(rt,rawRow(O,{start_ms:0,end_ms:60000,at_ms:0}));
  await insertRaw(rt,rawRow(O,{start_ms:253402300740000,end_ms:253402300800000}));
  await insertRaw(rt,rawRow(O,{start_ms:WINDOW.start_ms,end_ms:WINDOW.end_ms,at_ms:253402300799999}));
  // QR3 unique key: the same comparison, participant and window twice; another participant, window or comparison is fine
  const base=rawRow(O,{comparison_id:'cmp-dup',participant_run_id:'p-dup'});
  await insertRaw(rt,base);
  await refused(insertRaw(rt,{...base}),'23505');
  await refused(insertRaw(rt,{...base,at_ms:AT+1,source_hash:hex('other')}),'23505');
  await insertRaw(rt,{...base,participant_run_id:'p-dup-2'});
  await insertRaw(rt,{...base,start_ms:base.start_ms+60000});
  await insertRaw(rt,{...base,comparison_id:'cmp-dup-2'});
  // QR4 unique key: one exposure per selection, whatever its window
  const selection=qr4Row(O,{selection_id:'sel-dup'});
  await insertRaw(rt,selection);
  await refused(insertRaw(rt,{...selection}),'23505');
  await refused(insertRaw(rt,{...selection,start_ms:0,end_ms:60000}),'23505');
  await insertRaw(rt,qr4Row(O,{selection_id:'sel-dup-2'}));
});

/* ---- 4. concurrency ---- */

test('race with the lock: two SERIALIZABLE writers on overlapping windows serialize; the second sees the first row and refuses; another owner is not blocked out',async()=>{
  const R=await newOwner('s2a-race'),overlap=read=>(overlapsIn(read,R)?'OVERLAP':null);
  const insideA=gate(),releaseA=gate();
  const writerA=rt.transaction(()=>append(rt,{...marketOf(R),events:[event('cmp-race-a')],check:async read=>{insideA.open();await releaseA.promise;return overlap(read);}}),serializable);
  await insideA.promise;
  const writerB=rt2.transaction(()=>append(rt2,{...marketOf(R),events:[event('cmp-race-b')],check:async read=>overlap(read)}),serializable);
  // writer B waits on the table lock while A holds it
  await until(async()=>(await db.query(`SELECT count(*)::int n FROM pg_locks WHERE NOT granted AND locktype='relation' AND relation='${REGISTER}'::regclass`)).rows[0].n>=1,'writer B to wait for the lock');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=$1`,[R])).rows[0].n,0,'nothing is committed while A holds the lock');
  releaseA.open();
  const [a,b]=[await writerA,await writerB];
  assert.equal(a.ok,true);assert.equal(a.appended,1);
  assert.deepEqual([b.ok,b.code,b.refusal,b.appended],[false,EXPOSURE_CODES.CHECK_REFUSED,'OVERLAP',0],'the second writer saw the committed row, not a stale snapshot, and did not fail with 40001');
  assert.deepEqual((await db.query(`SELECT comparison_id FROM ${REGISTER} WHERE owner_id=$1`,[R])).rows,[{comparison_id:'cmp-race-a'}]);
  // readers are not blocked by the writer lock
  const holding=gate(),done=gate();
  const holder=rt.transaction(()=>append(rt,{...marketOf(R),events:[event('cmp-race-hold',{window:{start_ms:WINDOW.end_ms+3600000,end_ms:WINDOW.end_ms+3660000}})],check:async()=>{holding.open();await done.promise;return null;}}),serializable);
  await holding.promise;
  const reading=await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=$1`,[R]);assert.equal(reading.rows[0].n,1);
  assert.equal((await readExposures(rt2,marketOf(R))).ok,true,'a reader is not blocked by the writer lock');
  done.open();assert.equal((await holder).ok,true);
  // two different owners on the same window both commit (serialized by the lock, no serialization failure)
  const X=await newOwner('s2a-x'),Y=await newOwner('s2a-y');
  const both=await Promise.all([rt.transaction(()=>append(rt,{...marketOf(X),events:[event('cmp-x')],check:async read=>overlapsIn(read,X)?'OVERLAP':null}),serializable),
    rt2.transaction(()=>append(rt2,{...marketOf(Y),events:[event('cmp-y')],check:async read=>overlapsIn(read,Y)?'OVERLAP':null}),serializable)]);
  assert.deepEqual(both.map(item=>item.ok),[true,true]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=ANY($1)`,[[X,Y]])).rows[0].n,2);
});

test('race without the lock: two SERIALIZABLE writers that both read then append cannot both commit (40001); the database does not need the lock to stay correct',async()=>{
  const R=await newOwner('s2a-nolock');
  const arrived=[];const bothRead=gate();
  const writer=(target,id)=>target.transaction(async()=>{
    const read=await readExposures(target,marketOf(R));
    assert.equal(read.ok,true);
    arrived.push(id);if(arrived.length===2)bothRead.open();
    await bothRead.promise;
    if(overlapsIn(read,R))return 'REFUSED';
    await target.query(insertSql,valuesOf(rawRow(R,{comparison_id:'cmp-nolock-'+id})));
    return 'WROTE';
  },serializable);
  const results=await Promise.allSettled([writer(rt,'a'),writer(rt2,'b')]);
  const wrote=results.filter(item=>item.status==='fulfilled'&&item.value==='WROTE'),failed=results.filter(item=>item.status==='rejected');
  assert.equal(wrote.length,1,JSON.stringify(results.map(item=>item.status==='rejected'?item.reason.code:item.value)));
  assert.equal(failed.length,1);assert.equal(failed[0].reason.code,SERIALIZATION_FAILURE);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=$1`,[R])).rows[0].n,1);
  // the retry the caller owns: it reruns its read and now refuses
  const retried=await rt.transaction(()=>append(rt,{...marketOf(R),events:[event('cmp-nolock-retry')],check:async read=>(overlapsIn(read,R)?'OVERLAP':null)}),serializable);
  assert.equal(retried.ok,false);assert.equal(retried.code,EXPOSURE_CODES.CHECK_REFUSED);
});

/* ---- 5. shadowing ---- */

test('a session TEMP table named like the register fools neither the writer, the reader nor the guards',async()=>{
  const S=await newOwner('s2a-shadow');
  await rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE quant_exposure_register(LIKE public.quant_exposure_register INCLUDING DEFAULTS) ON COMMIT DROP');
    await rt.query('CREATE TEMP TABLE quant_exposure_register_schema(version integer) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    // a bogus row only the TEMP table holds; an unqualified name now means the TEMP table
    await rt.query(insertSql.replace('public.quant_exposure_register','quant_exposure_register'),valuesOf(rawRow(S,{comparison_id:'cmp-bogus'})));
    assert.equal((await rt.query('SELECT count(*)::int n FROM quant_exposure_register')).rows[0].n,1);
    const read=await readExposures(rt,marketOf(S));
    assert.deepEqual([read.ok,read.rows.length],[true,0],'the reader looks at the real register, not the TEMP table');
    const written=await append(rt,{...marketOf(S),events:[event('cmp-real')]});
    assert.equal(written.ok,true);
    assert.equal((await rt.query('SELECT count(*)::int n FROM pg_temp.quant_exposure_register')).rows[0].n,1,'the TEMP table kept only its own row');
    assert.deepEqual((await rt.query(`SELECT comparison_id FROM ${REGISTER} WHERE owner_id=$1`,[S])).rows,[{comparison_id:'cmp-real'}]);
  },serializable);
  // the guards still fire for the real table whatever search_path says
  await refused(rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE quant_exposure_register(x integer) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query(`UPDATE ${REGISTER} SET at_ms=at_ms WHERE owner_id=$1`,[S]);
  },serializable),QR002);
  assert.deepEqual((await rt.query(`SELECT comparison_id FROM ${REGISTER} WHERE owner_id=$1`,[S])).rows,[{comparison_id:'cmp-real'}]);
  assert.equal((await classifyQuantExposureRegister(db)).state,'INSTALLED');
});

/* ---- 6. reader and adapters on real rows ---- */

test('rows written by the runtime role are flagged by QR-3, QR-4 and B0 alike; absent is unavailable for each; empty is valid',async()=>{
  const E=await newOwner('s2a-adapt');
  const empty=await rt.transaction(()=>readExposures(rt,marketOf(E)),serializable);
  assert.deepEqual([empty.ok,empty.rows],[true,[]],'an empty register is valid');
  assert.deepEqual(toComparisonEntries(empty),[]);
  const written=await rt.transaction(()=>append(rt,{...marketOf(E),events:[event('cmp-adapt'),{kind:'QR4_SELECTION',window:{start_ms:WINDOW.end_ms,end_ms:WINDOW.end_ms+60*MINUTE},selection_id:'sel-adapt',at_ms:AT}]}),serializable);
  assert.deepEqual([written.ok,written.appended],[true,2]);
  const read=await rt.transaction(()=>readExposures(rt,marketOf(E)),serializable);
  assert.equal(read.ok,true);assert.equal(read.rows.length,2);
  assert.deepEqual(read.rows.map(row=>[row.kind,row.start_ms,row.end_ms,row.at_ms]),[['QR3_COMPARISON',WINDOW.start_ms,WINDOW.end_ms,AT],['QR4_SELECTION',WINDOW.end_ms,WINDOW.end_ms+60*MINUTE,AT]]);
  // QR-3 and QR-4 read the half-open window; the second event only touches the first
  assert.equal(overlapsIn(read,E,{start_ms:WINDOW.start_ms+MINUTE,end_ms:WINDOW.start_ms+2*MINUTE}),true);
  assert.deepEqual(exposuresOverlapping({register:toComparisonEntries(read),owner_id:E,market_key:canonical(REQUIRED_MARKET),window:{start_ms:WINDOW.start_ms,end_ms:WINDOW.end_ms}}).ids,['cmp-adapt']);
  assert.equal(overlapsExposure({start_ms:WINDOW.start_ms-60*MINUTE,end_ms:WINDOW.start_ms},{register:toComparisonEntries(read),owner_id:E}),null,'touching the first window is no overlap');
  assert.equal(overlapsExposure({start_ms:WINDOW.start_ms,end_ms:WINDOW.start_ms+MINUTE},{register:toComparisonEntries(read),owner_id:E}).code,QR4_CODES.QR4_WINDOW_EXPOSED);
  // B0 takes the inclusive package shape of the same rows
  const packaged=toPackageEntries(read);
  assert.deepEqual(packaged.map(entry=>entry.window),[{start_time:WINDOW.start_ms,end_time:WINDOW.end_ms-MINUTE},{start_time:WINDOW.end_ms,end_time:WINDOW.end_ms+60*MINUTE-MINUTE}]);
  assert.deepEqual(packaged.map(entry=>entry.at_utc),['2026-10-19T11:00:00.000Z','2026-10-19T11:00:00.000Z']);
  // another owner's rows are never read
  const other=await rt.transaction(()=>readExposures(rt,marketOf(OWNER_A)),serializable);
  assert.equal(other.rows.every(row=>row.owner_id===OWNER_A),true);
  assert.equal((await readExposures(rt,{...marketOf(E),symbol:'ETHUSDT'})).rows.length,0,'another market is a different register slice');
  // a marker without its version row makes the register unavailable (rolled back)
  const noMarker=await probe(db,async()=>{await db.query('DELETE FROM public.quant_exposure_register_schema');return readExposures(db,marketOf(E));});
  assert.deepEqual(noMarker,{ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null});
  // an absent register gives each consumer its own unavailable code
  const absentName=await clone('absent');
  const absentDb=track(new PostgresDatabase({connectionString:urlOf(absentName),max:2}));
  const absent=await readExposures(absentDb,marketOf('whoever'));
  assert.deepEqual(absent,{ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null});
  assert.equal(exposuresOverlapping({register:toComparisonEntries(absent),owner_id:'whoever',market_key:canonical(REQUIRED_MARKET),window:WINDOW}).code,QR3_CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE);
  assert.equal(overlapsExposure(WINDOW,{register:toComparisonEntries(absent),owner_id:'whoever'}).code,QR4_CODES.QR4_EXPOSURE_REGISTRY_UNAVAILABLE);
  assert.equal(toPackageEntries(absent),null);
  // the writer on an absent register throws at its LOCK (fail closed) and writes nothing
  await assert.rejects(absentDb.transaction(()=>append(absentDb,{...marketOf('whoever'),events:[event('cmp-absent')]}),serializable),error=>error.code==='42P01');
  // a tampered row the CHECK constraints would refuse (written under a disabled constraint by a privileged repair) makes the read unavailable
  const tamperedName=await clone('tampered');
  const tampered=track(new PostgresDatabase({connectionString:urlOf(tamperedName),max:2}));
  await migrateQuantExposureRegister(tampered);
  const T=await (async()=>{const user=await new Store(tampered).createUser({email:'t-'+randomUUID()+'@example.test',passwordHash:'x'});return user.id;})();
  await tampered.transaction(async()=>{
    await tampered.query('ALTER TABLE public.quant_exposure_register DROP CONSTRAINT quant_exposure_register_kind_fields_check');
    await tampered.query(insertSql,valuesOf(rawRow(T,{source_hash:null})));
  },serializable);
  const unreadable=await tampered.transaction(()=>readExposures(tampered,marketOf(T)),serializable);
  assert.deepEqual([unreadable.ok,unreadable.code],[false,EXPOSURE_CODES.ROW_INVALID]);
  // the writer throws on an unreadable register, so the caller transaction cannot commit
  await assert.rejects(tampered.transaction(()=>append(tampered,{...marketOf(T),events:[event('cmp-unreadable')]}),serializable),error=>error.code===EXPOSURE_CODES.ROW_INVALID);
  assert.equal((await classifyQuantExposureRegister(tampered)).state,'OTHER','and the inspection reports the dropped constraint');
});

/* ---- 7. CLI ---- */

test('the CLI: install, second install, --inspect exit codes, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=track(new PostgresDatabase({connectionString:cliUrl,max:2}));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  // ABSENT is a known state: exit 0, nothing written
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  // a bad runtime role in the ABSENT state still fails
  const badRole=await inspect(['--runtime-role=no_such_role_s2a']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  // install, then a second install
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/Quant exposure register ready: quant-exposure-register-v1; state=INSTALLED; previous state=ABSENT; guards=3/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  // INSTALLED without a runtime role passes; with a role that has no grant yet it fails on the missing privileges; after the grant script it passes
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  const ungranted=await inspect(['--runtime-role='+roleName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:quant_exposure_register:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(roleName));
  const granted=await inspect(['--runtime-role='+roleName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.map(item=>[item.table,item.insert,item.delete]),[['quant_exposure_register',true,false],['quant_exposure_register_schema',false,false]]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.quant_exposure_register DISABLE TRIGGER quant_exposure_register_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.quant_exposure_register ENABLE ALWAYS TRIGGER quant_exposure_register_no_change');
  assert.equal((await inspect()).code,0);
  // usage errors
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--bogus'],['--runtime-role=Bad-Name']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  // rollback of the empty register, then a second rollback (no-op) and a re-install
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await registerObjects(cliDb),{relations:0,functions:0,triggers:0});
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
});

/* ---- 8. rollback with evidence, dump and restore ---- */

test('rollback: an empty register is dropped completely; a register that holds a row is refused and unchanged',async()=>{
  const name=await clone('rollback');
  const target=track(new PostgresDatabase({connectionString:urlOf(name),max:3}));
  const user=await new Store(target).createUser({email:'rb-'+randomUUID()+'@example.test',passwordHash:'x'});
  const baseline=await catalogDigest(target);
  await migrateQuantExposureRegister(target);
  const rolled=await rollbackQuantExposureRegister(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await registerObjects(target),{relations:0,functions:0,triggers:0});
  assert.deepEqual((await catalogDigest(target)).n,baseline.n,'the catalog is back to the baseline object count');
  assert.deepEqual(await rollbackQuantExposureRegister(target),{rolled_back:true,previous_state:'ABSENT'});
  await migrateQuantExposureRegister(target);
  await target.transaction(()=>append(target,{...marketOf(user.id),events:[event('cmp-keep')]}),serializable);
  const held=await rowDigest(target),objects=await catalogDigest(target);
  await assert.rejects(rollbackQuantExposureRegister(target),/rollback refused; 1 evidence row\(s\) exist \(no change made\)/);
  assert.deepEqual(await rowDigest(target),held,'the evidence row is still there');assert.deepEqual(await catalogDigest(target),objects,'nothing else changed');
  assert.equal((await classifyQuantExposureRegister(target)).state,'INSTALLED');
  // a writer that holds a row in an open transaction blocks the rollback from counting past it (ACCESS EXCLUSIVE), then the count sees it
  const insert=gate(),finish=gate();
  const writer=target.transaction(async()=>{await append(target,{...marketOf(user.id),events:[event('cmp-late')]});insert.open();await finish.promise;},serializable);
  await insert.promise;
  const waiting=rollbackQuantExposureRegister(track(new PostgresDatabase({connectionString:urlOf(name),max:2})));
  const settled=waiting.then(()=>'DROPPED',error=>error.message);
  finish.open();await writer;
  assert.match(await settled,/rollback refused; 2 evidence row\(s\) exist \(no change made\)/);
  assert.equal((await rowDigest(target)).n,2);
});

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS, the rows and the grants',async t=>{
  const restoredName='robot_s2a_restore_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-s2a-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'s2a.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=track(new PostgresDatabase({connectionString:urlOf(restoredName)})),restoredRuntime=track(new PostgresDatabase({connectionString:urlOf(restoredName,roleName)}));
  assert.deepEqual(await guardRows(restored),await guardRows(db));assert.ok((await guardRows(restored)).every(row=>row.tgenabled==='A'));
  assert.deepEqual(await rowDigest(restored),await rowDigest(db),'every stored row came back');
  assert.equal((await classifyQuantExposureRegister(restored)).state,'INSTALLED');
  const report=await inspectQuantExposureRegister(restored,{runtimeRole:roleName});assert.equal(report.ok,true,report.failures.join());
  await refused(restoredRuntime.query(`UPDATE ${REGISTER} SET at_ms=at_ms WHERE owner_id=$1`,[OWNER_A]),QR002);
  await refused(restoredRuntime.query(insertSql,valuesOf(rawRow(OWNER_A))),QR003);
  await refused(restoredRuntime.query(`DELETE FROM ${REGISTER}`),DENIED);
  await insertRaw(restoredRuntime,rawRow(OWNER_A));
});
