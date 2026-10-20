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
import {COMPARISON_GUARDS,COMPARISON_MARKER,COMPARISON_TABLES,INSERT_ONLY_SQLSTATE,INSERT_GUARD_SQLSTATE,SERIALIZABLE_SQLSTATE,classifyQuantComparison,inspectQuantComparison,
  migrateQuantComparison,rollbackQuantComparison} from '../../src/postgres/quant-comparison-migration.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {createComparison,readComparison} from '../../src/postgres/comparison-store.js';
import {validateSpec} from '../../src/comparison/ranking.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {hex,MINUTE,T0} from '../helpers/quant-library-fixture.mjs';

// QR-3 S2c-1: the comparison specs, participants and status events, proven on a throwaway PostgreSQL cluster as real non-owner LOGIN roles with the
// repo grants. Every row is a LABELLED FIXTURE (synthetic, never a research result). Rows are insert-only, so each test uses its own owner or ids.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501',CHECK_VIOLATION='23514',NOT_NULL='23502',FK_VIOLATION='23503',UNIQUE_VIOLATION='23505',
  SERIALIZATION_FAILURE='40001',INVALID_TEXT='22P02';
const SPECS='public.quant_comparison_specs',PARTICIPANTS='public.quant_comparison_participants',EVENTS='public.quant_comparison_status_events',MARKER='public.quant_comparison_schema';
const CLI='scripts/migrate-quant-comparison.mjs';
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const serializable={isolation:'SERIALIZABLE'};
let admin,db,rt,rt2,dl,tr,connectionString,templateBase,templateRegister,databaseName,roleName,deleterName,truncaterName,store,OWNER_A,OWNER_B;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantPath=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const grantScript=async role=>(await fs.readFile(grantPath,'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const refusedBy=(promise,code,constraint)=>assert.rejects(promise,error=>error.code===code&&error.constraint===constraint);
const track=pool=>{pools.push(pool);return pool;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}

/** A database built from a template: base schema 14, the Pine and research extensions, and (default) the exposure register. */
async function clone(label,{register=true}={}){
  const name='robot_s2c_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+(register?templateRegister:templateBase));
  return name;
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog. */
async function probe(target,fn,options={}){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();},options);}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.oid||':'||c.xmin::text||':'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.oid||':'||k.xmin::text||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
const comparisonObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'quant\\_comparison%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'quant\\_comparison%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'quant\\_comparison%') triggers`)).rows[0];
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM ${table} t`)).rows[0];
const allRows=async target=>Promise.all([SPECS,PARTICIPANTS,EVENTS,'public.quant_exposure_register'].map(table=>rowDigest(target,table)));
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;
const OBJECTS={relations:4+7,functions:8,triggers:16};

/** A STANDARDIZED spec for the given participant ids and window, in the frozen normal form. */
function specFor(ids,window=WINDOW,patch={}){
  const checked=validateSpec({mode:'STANDARDIZED',participants:ids,period:{start_ms:window.start_ms,end_ms:window.end_ms},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
    uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'},...patch});
  assert.equal(checked.ok,true);
  return checked;
}
const WINDOW={start_ms:T0,end_ms:T0+1440*MINUTE};
let windowShift=0;
/** createComparison input over fresh participant ids; every comparison gets its own window so a prior-exposure list never depends on test order. */
function inputFor(owner,{count=2,fixture=true,origin=fixture?'FIXTURE':'LIBRARY_RUN',window=null,patch={}}={}){
  windowShift+=1;
  const w=window??{start_ms:WINDOW.start_ms+windowShift*2*1440*MINUTE,end_ms:WINDOW.end_ms+windowShift*2*1440*MINUTE};
  const ids=Array.from({length:count},(_,index)=>'run-'+randomUUID().slice(0,8)+'-'+index);
  const checked=specFor(ids,w);
  return {owner_id:owner,market:{...MARKET},fixture,spec:checked.spec,spec_hash:checked.spec_hash,context_key:hex('context'),
    participants:ids.map((id,index)=>({participant_id:id,source_hash:hex('source-'+id),origin,fixture,context_key:hex('context'),freeze:{subject:{index},disclosure:{prior_searches:[]}}})),...patch};
}
const create=async(target,owner,options)=>{const result=await createComparison(target,inputFor(owner,options));assert.equal(result.ok,true,JSON.stringify(result));return result;};
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
const addEvent=(target,id,seq,status,reason=null)=>target.transaction(()=>target.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status,reason_code) VALUES($1,$2,$3,$4) RETURNING at_ms`,[id,seq,status,reason]),serializable);
const statusOf=async(target,id)=>(await target.query(`SELECT seq,status FROM ${EVENTS} WHERE comparison_id=$1 ORDER BY seq DESC LIMIT 1`,[id])).rows[0];

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateBase='robot_s2c_tb_'+suffix;templateRegister='robot_s2c_tr_'+suffix;databaseName='robot_s2c_main_'+suffix;
  roleName='robot_s2c_rt_'+suffix.slice(0,14);deleterName='robot_s2c_del_'+suffix.slice(0,14);truncaterName='robot_s2c_trn_'+suffix.slice(0,14);
  for(const name of [roleName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateBase);
  const builder=new PostgresDatabase({connectionString:urlOf(templateBase),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+templateRegister+' TEMPLATE '+templateBase);
  const registerBuilder=new PostgresDatabase({connectionString:urlOf(templateRegister),max:2});
  try{await migrateQuantExposureRegister(registerBuilder);}finally{await registerBuilder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateRegister);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString,max:6}));
  store=new Store(db);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateRegister,templateBase])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [roleName,deleterName,truncaterName])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. install lifecycle ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing',async()=>{
  const before=await catalogDigest(db);
  const classification=await classifyQuantComparison(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectQuantComparison(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectQuantComparison(db,{runtimeRole:'no_such_role_s2c'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await comparisonObjects(db),{relations:0,functions:0,triggers:0});
});

test('absent: a same-name foreign object classifies OTHER, so an install over it would be refused',async()=>{
  const noop="CREATE FUNCTION public.s2c_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign specs table','CREATE TABLE public.quant_comparison_specs(x integer)','TABLE_DEFINITION:quant_comparison_specs:'],
    ['foreign marker table','CREATE TABLE public.quant_comparison_schema(version integer)','TABLE_DEFINITION:quant_comparison_schema:'],
    ['foreign marker function',"CREATE FUNCTION public.quant_comparison_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:quant_comparison_version:'],
    ['overload of a guard function','CREATE FUNCTION public.quant_comparison_insert_only(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:quant_comparison_insert_only('],
    ['view carrying an index name','CREATE VIEW public.quant_comparison_specs_owner AS SELECT 1 AS x','RELATION_UNEXPECTED:quant_comparison_specs_owner'],
    ['sequence carrying an index name','CREATE SEQUENCE public.quant_comparison_specs_pkey','RELATION_UNEXPECTED:quant_comparison_specs_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.quant_comparison_participants AS integer','TYPE_UNEXPECTED:quant_comparison_participants'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER quant_comparison_specs_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.s2c_noop()','TRIGGER_UNEXPECTED:quant_comparison_specs_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyQuantComparison(db),report:await inspectQuantComparison(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await comparisonObjects(db),{relations:0,functions:0,triggers:0},'every probe was rolled back');
});

test('the install needs the exposure register: an absent or foreign register refuses it with no write',async()=>{
  const bareName=await clone('noregister',{register:false}),foreignName=await clone('foreignregister',{register:false});
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2})),foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2}));
  const bareBefore=await catalogDigest(bare);
  await assert.rejects(migrateQuantComparison(bare),/Exposure register extension required before the comparison tables; its state is ABSENT \(no change made\)/);
  assert.deepEqual(await catalogDigest(bare),bareBefore);assert.deepEqual(await comparisonObjects(bare),{relations:0,functions:0,triggers:0});
  await foreign.query('CREATE TABLE public.quant_exposure_register(x integer)');
  await assert.rejects(migrateQuantComparison(foreign),/its state is OTHER \(no change made\)/);
  assert.deepEqual(await comparisonObjects(foreign),{relations:0,functions:0,triggers:0});
  // the research extension is a prerequisite too
  const noResearchName='robot_s2c_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(noResearchName);
  await admin.query('CREATE DATABASE '+noResearchName);
  const noResearch=track(new PostgresDatabase({connectionString:urlOf(noResearchName),max:2}));
  await noResearch.migrate();
  await assert.rejects(migrateQuantComparison(noResearch),/Quant research extension 1 required/);
  await noResearch.query('CREATE TABLE quant_job_schema(version INTEGER)');await noResearch.query('INSERT INTO quant_job_schema VALUES(2)');
  await assert.rejects(migrateQuantComparison(noResearch),/Unsupported quant_job_schema version/);
  assert.deepEqual(await comparisonObjects(noResearch),{relations:0,functions:0,triggers:0});
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, tables and grants stay as they were; a second install is a no-op',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S') AND c.relname NOT LIKE 'quant\\_comparison%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migrateQuantComparison(db,{runtimeRole:roleName});
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,COMPARISON_MARKER);assert.equal(report.facts.guards.length,16);assert.equal(report.facts.register_state,'INSTALLED');
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(name=>!baseTables.includes(name)),
    ['quant_comparison_participants','quant_comparison_schema','quant_comparison_specs','quant_comparison_status_events'],'exactly the four comparison tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await comparisonObjects(db),OBJECTS,'four tables, seven indexes, eight functions and sixteen triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM quant_comparison_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.quant_comparison_version() v')).rows[0].v,COMPARISON_MARKER);
  assert.deepEqual((await db.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'quant\\_comparison%' ORDER BY t.tgname`)).rows.map(row=>[row.tgname,row.tgenabled,row.tgtype]),
    COMPARISON_GUARDS.map(item=>[item[0],'A',item[3]]).sort((a,b)=>a[0]<b[0]?-1:1));
  const settled=await catalogDigest(db);
  const again=await migrateQuantComparison(db,{runtimeRole:roleName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.s2c_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const T=table=>'ALTER TABLE public.'+table+' ';
  const OTHER_OWNER='CREATE ROLE s2c_other_owner NOLOGIN; ';
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const cases=[
    ['guard body replaced',"CREATE OR REPLACE FUNCTION public.quant_comparison_insert_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:quant_comparison_insert_only:BODY'],
    ['status guard body replaced',"CREATE OR REPLACE FUNCTION public.quant_comparison_guard_status_event() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:quant_comparison_guard_status_event:BODY'],
    ['transaction-membership helper body replaced',"CREATE OR REPLACE FUNCTION public.quant_comparison_in_this_transaction(row_xmin xid) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN false; END $$",'FUNCTION_DEFINITION:quant_comparison_in_this_transaction:BODY'],
    ['table re-owned to another role',OTHER_OWNER+'ALTER TABLE public.quant_comparison_participants OWNER TO s2c_other_owner','OWNER_MISMATCH:quant_comparison_participants'],
    ['marker table re-owned to another role',OTHER_OWNER+'ALTER TABLE public.quant_comparison_schema OWNER TO s2c_other_owner','OWNER_MISMATCH:quant_comparison_specs'],
    ['guard function re-owned to another role',OTHER_OWNER+'ALTER FUNCTION public.quant_comparison_guard_spec() OWNER TO s2c_other_owner','OWNER_MISMATCH:quant_comparison_guard_spec'],
    ['helper function re-owned to another role',OTHER_OWNER+'ALTER FUNCTION public.quant_comparison_in_this_transaction(xid) OWNER TO s2c_other_owner','OWNER_MISMATCH:quant_comparison_in_this_transaction'],
    ['commit check body replaced',"CREATE OR REPLACE FUNCTION public.quant_comparison_check_create() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NULL; END $$",'FUNCTION_DEFINITION:quant_comparison_check_create:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.quant_comparison_require_serializable() SECURITY DEFINER','FUNCTION_DEFINITION:quant_comparison_require_serializable:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.quant_comparison_require_serializable() RESET search_path','FUNCTION_DEFINITION:quant_comparison_require_serializable:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.quant_comparison_guard_spec() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:quant_comparison_guard_spec:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.quant_comparison_insert_only() STRICT','FUNCTION_DEFINITION:quant_comparison_insert_only:ATTRIBUTES'],
    ['trigger disabled',T('quant_comparison_specs')+'DISABLE TRIGGER quant_comparison_specs_no_change','TRIGGER_NOT_ALWAYS:quant_comparison_specs_no_change'],
    ['trigger origin only',T('quant_comparison_participants')+'ENABLE TRIGGER quant_comparison_participants_00_serializable','TRIGGER_NOT_ALWAYS:quant_comparison_participants_00_serializable'],
    ['trigger replica only',T('quant_comparison_status_events')+'ENABLE REPLICA TRIGGER quant_comparison_status_events_no_truncate','TRIGGER_NOT_ALWAYS:quant_comparison_status_events_no_truncate'],
    ['commit check disabled',T('quant_comparison_specs')+'DISABLE TRIGGER quant_comparison_specs_complete','TRIGGER_NOT_ALWAYS:quant_comparison_specs_complete'],
    ['trigger dropped','DROP TRIGGER quant_comparison_status_events_guard ON public.quant_comparison_status_events','TRIGGER_MISSING:quant_comparison_status_events_guard'],
    ['commit check dropped','DROP TRIGGER quant_comparison_specs_complete ON public.quant_comparison_specs','TRIGGER_MISSING:quant_comparison_specs_complete'],
    ['commit check made immediate','DROP TRIGGER quant_comparison_specs_complete ON public.quant_comparison_specs; CREATE CONSTRAINT TRIGGER quant_comparison_specs_complete AFTER INSERT ON public.quant_comparison_specs FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_check_create(); '
      +T('quant_comparison_specs')+'ENABLE ALWAYS TRIGGER quant_comparison_specs_complete','TRIGGER_SHAPE:quant_comparison_specs_complete'],
    ['trigger rebound to the other function',redo('quant_comparison_specs_no_change','quant_comparison_specs','BEFORE UPDATE OR DELETE','quant_comparison_require_serializable')+' '+T('quant_comparison_specs')+'ENABLE ALWAYS TRIGGER quant_comparison_specs_no_change','TRIGGER_FUNCTION:quant_comparison_specs_no_change'],
    ['trigger narrowed to UPDATE only',redo('quant_comparison_specs_no_change','quant_comparison_specs','BEFORE UPDATE','quant_comparison_insert_only')+' '+T('quant_comparison_specs')+'ENABLE ALWAYS TRIGGER quant_comparison_specs_no_change','TRIGGER_SHAPE:quant_comparison_specs_no_change'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER s2c_marker AFTER INSERT ON public.quant_comparison_schema FOR EACH ROW EXECUTE FUNCTION public.s2c_noop()','TRIGGER_UNEXPECTED:s2c_marker'],
    ['extra foreign trigger',noop+' CREATE TRIGGER s2c_extra AFTER INSERT ON public.quant_comparison_participants FOR EACH ROW EXECUTE FUNCTION public.s2c_noop()','TRIGGER_UNEXPECTED:s2c_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER s2c_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.quant_comparison_insert_only()','TRIGGER_UNEXPECTED:s2c_elsewhere'],
    ['check constraint dropped',T('quant_comparison_specs')+'DROP CONSTRAINT quant_comparison_specs_market_check','TABLE_DEFINITION:quant_comparison_specs:CONSTRAINTS'],
    ['check constraint weakened',T('quant_comparison_specs')+"DROP CONSTRAINT quant_comparison_specs_mode_check, ADD CONSTRAINT quant_comparison_specs_mode_check CHECK(mode IS NOT NULL)",'TABLE_DEFINITION:quant_comparison_specs:CONSTRAINTS'],
    ['body hash check dropped',T('quant_comparison_specs')+'DROP CONSTRAINT quant_comparison_specs_spec_digest_check','TABLE_DEFINITION:quant_comparison_specs:CONSTRAINTS'],
    ['freeze body check dropped',T('quant_comparison_participants')+'DROP CONSTRAINT quant_comparison_participants_freeze_body_check','TABLE_DEFINITION:quant_comparison_participants:CONSTRAINTS'],
    ['extra constraint',T('quant_comparison_status_events')+'ADD CONSTRAINT s2c_extra CHECK(at_ms>=0)','TABLE_DEFINITION:quant_comparison_status_events:CONSTRAINTS'],
    ['foreign key dropped',T('quant_comparison_specs')+'DROP CONSTRAINT quant_comparison_specs_owner_id_fkey','TABLE_DEFINITION:quant_comparison_specs:CONSTRAINTS'],
    ['foreign key made cascading',T('quant_comparison_participants')+'DROP CONSTRAINT quant_comparison_participants_comparison_id_fkey, ADD CONSTRAINT quant_comparison_participants_comparison_id_fkey FOREIGN KEY(comparison_id) REFERENCES public.quant_comparison_specs(comparison_id) ON DELETE CASCADE','TABLE_DEFINITION:quant_comparison_participants:CONSTRAINTS'],
    ['unique constraint dropped',T('quant_comparison_participants')+'DROP CONSTRAINT quant_comparison_participants_position_key','TABLE_DEFINITION:quant_comparison_participants:'],
    ['partial unique index dropped','DROP INDEX public.quant_comparison_specs_request_key','INDEX_MISSING:quant_comparison_specs_request_key'],
    ['partial unique index widened','DROP INDEX public.quant_comparison_specs_request_key; CREATE UNIQUE INDEX quant_comparison_specs_request_key ON public.quant_comparison_specs(owner_id,request_key_hash)','TABLE_DEFINITION:quant_comparison_specs:INDEXES'],
    ['extra index','CREATE INDEX s2c_extra ON public.quant_comparison_status_events(at_ms)','TABLE_DEFINITION:quant_comparison_status_events:INDEXES'],
    ['owner index changed','DROP INDEX public.quant_comparison_specs_owner; CREATE INDEX quant_comparison_specs_owner ON public.quant_comparison_specs(owner_id)','TABLE_DEFINITION:quant_comparison_specs:INDEXES'],
    ['column default added',T('quant_comparison_specs')+'ALTER COLUMN frozen_at_ms SET DEFAULT 0','TABLE_DEFINITION:quant_comparison_specs:COLUMNS'],
    ['column made optional',T('quant_comparison_specs')+'ALTER COLUMN spec_canonical DROP NOT NULL','TABLE_DEFINITION:quant_comparison_specs:COLUMNS'],
    ['column added',T('quant_comparison_status_events')+'ADD COLUMN extra integer','TABLE_DEFINITION:quant_comparison_status_events:COLUMNS'],
    ['column type changed',T('quant_comparison_participants')+'ALTER COLUMN source_hash TYPE character varying(64)','TABLE_DEFINITION:quant_comparison_participants:'],
    ['column collation changed',T('quant_comparison_participants')+'ALTER COLUMN origin TYPE text COLLATE "C"','TABLE_DEFINITION:quant_comparison_participants:COLLATION'],
    ['column collation changed on a second table',T('quant_comparison_status_events')+'ALTER COLUMN status TYPE text COLLATE "POSIX"','TABLE_DEFINITION:quant_comparison_status_events:COLLATION'],
    ['row security enabled',T('quant_comparison_specs')+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:quant_comparison_specs:SHAPE'],
    ['rule added','CREATE RULE s2c_rule AS ON INSERT TO public.quant_comparison_participants DO ALSO NOTHING','TABLE_DEFINITION:quant_comparison_participants:SHAPE'],
    ['marker row removed','DELETE FROM public.quant_comparison_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.quant_comparison_schema DROP CONSTRAINT quant_comparison_schema_version_check','TABLE_DEFINITION:quant_comparison_schema:CONSTRAINTS'],
    ['marker table renamed','ALTER TABLE public.quant_comparison_schema RENAME TO s2c_renamed','TABLE_MISSING:quant_comparison_schema']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // the owner meets the guard too, so a tamper that edits a guarded row first lifts the guard in the same rolled-back transaction
      if(statement.startsWith('DELETE FROM public.quant_comparison_schema'))await db.query('ALTER TABLE public.quant_comparison_schema DISABLE TRIGGER quant_comparison_schema_no_change');
      await db.query(statement);return {classification:await classifyQuantComparison(db),report:await inspectQuantComparison(db)};});
    const reasons=[...found.classification.problems,...found.classification.missing];
    assert.equal(found.classification.state,'OTHER',label+': '+reasons.join());
    assert.ok(reasons.some(item=>item.startsWith(prefix)),label+': '+reasons.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.quant_comparison_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectQuantComparison(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:quant_comparison_version:BODY')));
  // An installed extension over a register that is no longer exactly the register SQL is a failure the inspection names.
  const registerGone=await probe(db,async()=>{await db.query('ALTER TABLE public.quant_exposure_register RENAME TO s2c_register_renamed');return inspectQuantComparison(db);});
  assert.equal(registerGone.ok,false);assert.ok(registerGone.failures.some(item=>item.startsWith('EXPOSURE_REGISTER_NOT_INSTALLED:')),registerGone.failures.join());
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED','every tamper was rolled back');
});

test('offline only: the install and the rollback need the maintenance lock and their own transaction',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateQuantComparison(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackQuantComparison(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateQuantComparison(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackQuantComparison(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
});

test('a foreign or partial install is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.quant_comparison_specs(x integer)');await foreign.query('INSERT INTO public.quant_comparison_specs VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateQuantComparison(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackQuantComparison(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.quant_comparison_specs')).rows,[{x:7}],'the foreign row survived');
  await migrateQuantComparison(partial);
  await partial.query('DROP TRIGGER quant_comparison_status_events_no_truncate ON public.quant_comparison_status_events');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateQuantComparison(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:quant_comparison_status_events_no_truncate/);
  await assert.rejects(rollbackQuantComparison(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyQuantComparison(partial)).state,'OTHER');
});

/* ---- 2. grants ---- */

test('grants: the repo grant script gives the runtime role SELECT and INSERT on the three record tables and SELECT on the marker, nothing else; reapply is idempotent',async()=>{
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  for(const table of COMPARISON_TABLES){
    await db.query(`GRANT DELETE ON TABLE public.${table} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE public.${table} TO ${truncaterName}`);
  }
  rt=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:5}));rt2=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:5}));
  dl=track(new PostgresDatabase({connectionString:urlOf(databaseName,deleterName),max:2}));tr=track(new PostgresDatabase({connectionString:urlOf(databaseName,truncaterName),max:2}));
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  for(const table of COMPARISON_TABLES){
    await db.query(`GRANT DELETE ON TABLE public.${table} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE public.${table} TO ${truncaterName}`);
  }
  assert.equal(await acl(),first,'a second application of the grant script changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger
    FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  for(const table of [SPECS,PARTICIPANTS,EVENTS])
    assert.deepEqual(await facts(roleName,table),{owner:false,select:true,insert:true,update:false,delete:false,truncate:false,trigger:false},table+': SELECT and INSERT only');
  assert.deepEqual(await facts(roleName,MARKER),{owner:false,select:true,insert:false,update:false,delete:false,truncate:false,trigger:false},'the marker table is read-only');
  assert.equal((await facts(deleterName,SPECS)).delete,true);assert.equal((await facts(truncaterName,EVENTS)).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // the register keeps its own grants (lock-carrying UPDATE) and the comparison tables take none of them
  assert.equal((await facts(roleName,'public.quant_exposure_register')).update,true);
  // inspect with the runtime role passes, and names the role that broke the boundary
  const ok=await inspectQuantComparison(db,{runtimeRole:roleName});assert.equal(ok.ok,true,ok.failures.join());
  assert.ok((await inspectQuantComparison(db,{runtimeRole:deleterName})).failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_comparison_specs:DELETE'));
  assert.ok((await inspectQuantComparison(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:quant_comparison_status_events'));
  assert.ok((await inspectQuantComparison(db,{runtimeRole:'robot_test'})).failures.some(item=>item.startsWith('RUNTIME_ROLE_SUPERUSER')||item.startsWith('RUNTIME_ROLE_OWNS:')));
  // a role without the grants fails on the missing privileges, and passes when the grants are not required
  const bare=await probe(db,async()=>{await db.query('CREATE ROLE s2c_bare NOLOGIN');return {strict:await inspectQuantComparison(db,{runtimeRole:'s2c_bare'}),relaxed:await inspectQuantComparison(db,{runtimeRole:'s2c_bare',requireGrants:false})};});
  assert.ok(bare.strict.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:quant_comparison_participants:INSERT'),bare.strict.failures.join());
  assert.equal(bare.relaxed.ok,true,bare.relaxed.failures.join());
  // membership of the owning role counts as ownership, for the tables and for each function (all rolled back)
  const memberOf=await probe(db,async()=>{
    await db.query('CREATE ROLE s2c_member NOLOGIN');await db.query('GRANT '+(await db.query('SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=$1::regclass',[SPECS])).rows[0].o+' TO s2c_member');
    return inspectQuantComparison(db,{runtimeRole:'s2c_member'});
  });
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS:quant_comparison_specs')&&memberOf.failures.includes('RUNTIME_ROLE_OWNS:quant_comparison_schema'),memberOf.failures.join());
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS_FUNCTION:quant_comparison_insert_only'),memberOf.failures.join());
  // the role cannot disable a guard, replace a function, drop a table or change the replication role
  await refused(rt.query(`ALTER TABLE ${SPECS} DISABLE TRIGGER quant_comparison_specs_no_change`),DENIED);
  await refused(rt.query(`ALTER TABLE ${EVENTS} DISABLE TRIGGER ALL`),DENIED);
  await refused(rt.query(`DROP TRIGGER quant_comparison_specs_complete ON ${SPECS}`),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.quant_comparison_insert_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query(`DROP TABLE ${SPECS}`),DENIED);
  await refused(rt.query(`INSERT INTO ${MARKER} VALUES(2)`),DENIED);await refused(rt.query(`UPDATE ${MARKER} SET version=1`),DENIED);await refused(rt.query(`DELETE FROM ${MARKER}`),DENIED);
  OWNER_A=await newOwner('s2c-a');OWNER_B=await newOwner('s2c-b');
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

/* ---- 3. insert-only layers and the isolation guard ---- */

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers on every table; the replication role cannot skip a guard; no row changes',async()=>{
  const made=await create(rt,OWNER_A,{count:3});
  const before=await allRows(db);
  // layer 1 (privilege): the runtime role holds no UPDATE, DELETE or TRUNCATE on the record tables
  for(const table of [SPECS,PARTICIPANTS,EVENTS]){
    await refused(rt.query(`DELETE FROM ${table}`),DENIED);await refused(rt.query(`TRUNCATE ${table}`),DENIED);await refused(rt.query(`UPDATE ${table} SET comparison_id=comparison_id`),DENIED);
  }
  await refused(rt.query(`UPDATE ${SPECS} SET frozen_at_ms=frozen_at_ms+1 WHERE comparison_id=$1`,[made.comparison_id]),DENIED);
  // layer 2 (trigger): a role that does hold the privilege (the table owner, a deleter and a truncater) still meets the guard
  const edits=[
    ['specs: update of one column',`UPDATE ${SPECS} SET frozen_at_ms=frozen_at_ms+1 WHERE comparison_id=$1`,[made.comparison_id]],
    ['specs: update to the same value',`UPDATE ${SPECS} SET owner_id=owner_id WHERE comparison_id=$1`,[made.comparison_id]],
    ['specs: update of the key',`UPDATE ${SPECS} SET comparison_id='moved' WHERE comparison_id=$1`,[made.comparison_id]],
    ['participants: update of a hash',`UPDATE ${PARTICIPANTS} SET source_hash=source_hash WHERE comparison_id=$1`,[made.comparison_id]],
    ['participants: update of a position',`UPDATE ${PARTICIPANTS} SET "position"=4 WHERE comparison_id=$1`,[made.comparison_id]],
    ['events: update of the status',`UPDATE ${EVENTS} SET status='CANCELLED' WHERE comparison_id=$1`,[made.comparison_id]],
    ['events: update of the clock',`UPDATE ${EVENTS} SET at_ms=0 WHERE comparison_id=$1`,[made.comparison_id]],
    ['marker: update',`UPDATE ${MARKER} SET version=1`,[]]];
  for(const [label,statement,params] of edits)await refused(db.query(statement,params),QR002).catch(error=>{throw Error(label+': '+error.message);});
  for(const table of [SPECS,PARTICIPANTS,EVENTS,MARKER]){
    await refused(db.query(`DELETE FROM ${table}`),QR002);await refused(db.query(table===SPECS?`TRUNCATE ${table} CASCADE`:`TRUNCATE ${table}`),QR002);
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`DELETE FROM ${table}`);}),QR002);
    const touch={[MARKER]:'version=version',[SPECS]:'owner_id=owner_id',[PARTICIPANTS]:'source_hash=source_hash',[EVENTS]:'seq=seq'}[table];
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`UPDATE ${table} SET ${touch}`);}),QR002);
  }
  await refused(dl.query(`DELETE FROM ${SPECS} WHERE comparison_id=$1`,[made.comparison_id]),QR002);await refused(dl.query(`DELETE FROM ${PARTICIPANTS}`),QR002);await refused(dl.query(`DELETE FROM ${EVENTS}`),QR002);
  await refused(tr.query(`TRUNCATE ${SPECS} CASCADE`),QR002);await refused(tr.query(`TRUNCATE ${PARTICIPANTS}`),QR002);await refused(tr.query(`TRUNCATE ${EVENTS} RESTART IDENTITY`),QR002);
  await refused(tr.query(`TRUNCATE ${EVENTS}, ${PARTICIPANTS}, ${SPECS}`),QR002);
  // a plain TRUNCATE of the referenced spec table fails on its foreign keys before any trigger: refused either way
  await refused(tr.query(`TRUNCATE ${SPECS}`),'0A000');await refused(db.query(`TRUNCATE ${SPECS}`),'0A000');
  // an upsert that would rewrite a stored row needs UPDATE privilege for the runtime role; a DO NOTHING conflict writes nothing
  assert.equal((await rt.transaction(()=>rt.query(specInsert+' ON CONFLICT (comparison_id) DO NOTHING',values(OWNER_A,{comparison_id:made.comparison_id})),serializable)).rowCount,0);
  await refusedBy(rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,1,'SPEC_FROZEN') ON CONFLICT (comparison_id,seq) DO NOTHING`,[made.comparison_id]),serializable),QR004,'quant_comparison_status_transition');
  await refused(rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,1,'SPEC_FROZEN') ON CONFLICT (comparison_id,seq) DO UPDATE SET status='EVALUATING'`,[made.comparison_id]),serializable),DENIED);
  assert.deepEqual(await allRows(db),before,'no refusal changed a row');
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await db.query(`UPDATE ${SPECS} SET owner_id=owner_id WHERE comparison_id='no-such-comparison'`)).rowCount,0);
  assert.deepEqual(await allRows(db),before);
});

test('isolation guard: an INSERT below SERIALIZABLE is refused (QR003) on every table; a TEMP function cannot fake the setting',async()=>{
  const made=await create(rt,OWNER_A);
  const before=await allRows(db);
  const specValues=values(OWNER_A);
  for(const level of ['READ COMMITTED','REPEATABLE READ']){
    await refused(rt.transaction(()=>rt.query(specInsert,specValues),{isolation:level}),QR003);
    await refused(rt.transaction(()=>rt.query(participantInsert,participantValues(made.comparison_id,'late-1',1)),{isolation:level}),QR003);
    await refused(rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[made.comparison_id]),{isolation:level}),QR003);
  }
  await refused(rt.query(specInsert,specValues),QR003);                                          // autocommit READ COMMITTED
  await refused(rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[made.comparison_id]),QR003);
  await refused(db.transaction(()=>db.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[made.comparison_id])),QR003);   // the owner meets it too
  await refused(db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');await db.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[made.comparison_id]);},serializable),'25006');
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[made.comparison_id]);}),QR003);
  assert.deepEqual(await allRows(db),before,'the refused inserts wrote nothing');
  // a session TEMP function named like the settings reader never replaces the schema-qualified call inside the guard
  await refused(rt.transaction(async()=>{
    await rt.query("CREATE FUNCTION pg_temp.current_setting(text) RETURNS text LANGUAGE sql AS $$ SELECT 'serializable'::text $$");
    await rt.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[made.comparison_id]);
  },{isolation:'READ COMMITTED'}),QR003);
  // a SERIALIZABLE transaction commits
  await addEvent(rt,made.comparison_id,2,'EVALUATING');
  assert.deepEqual(await statusOf(db,made.comparison_id),{seq:2,status:'EVALUATING'});
});

/* ---- 4. table rules ---- */

const specInsert=`INSERT INTO ${SPECS}(comparison_id,owner_id,parent_comparison_id,mode,fixture,broker,symbol,timeframe,start_ms,end_ms,participant_count,context_key,spec_hash,spec_canonical,spec_body_hash,request_key_hash,frozen_at_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`;
/** Column values of one valid spec row (positional for specInsert). over: column name to value. */
function values(owner,over={}){
  windowShift+=1;
  const w={start_ms:WINDOW.start_ms+windowShift*2*1440*MINUTE,end_ms:WINDOW.end_ms+windowShift*2*1440*MINUTE};
  const ids=['raw-'+windowShift+'-a','raw-'+windowShift+'-b'];
  const checked=specFor(ids,w);
  const text=canonical(checked.spec);
  const row={comparison_id:'raw-'+randomUUID().slice(0,12),owner_id:owner,parent_comparison_id:null,mode:'STANDARDIZED',fixture:true,...MARKET,start_ms:w.start_ms,end_ms:w.end_ms,participant_count:2,
    context_key:hex('context'),spec_hash:checked.spec_hash,spec_canonical:text,spec_body_hash:hash(text),request_key_hash:null,frozen_at_ms:1,...over};
  return ['comparison_id','owner_id','parent_comparison_id','mode','fixture','broker','symbol','timeframe','start_ms','end_ms','participant_count','context_key','spec_hash','spec_canonical','spec_body_hash','request_key_hash','frozen_at_ms'].map(name=>row[name]);
}
const specColumns=['comparison_id','owner_id','parent_comparison_id','mode','fixture','broker','symbol','timeframe','start_ms','end_ms','participant_count','context_key','spec_hash','spec_canonical','spec_body_hash','request_key_hash','frozen_at_ms'];
const withColumn=(owner,name,value)=>{const row=values(owner);row[specColumns.indexOf(name)]=value;return row;};
const participantInsert=`INSERT INTO ${PARTICIPANTS}(comparison_id,participant_id,"position",source_hash,origin,fixture,context_key,freeze_canonical,freeze_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
function participantValues(comparisonId,participantId,position,over={}){
  const freeze=canonical({participant_id:participantId,source_hash:hex('s'),prior_exposed_by:[],...(over.freeze??{})});
  const row={comparison_id:comparisonId,participant_id:participantId,position,source_hash:hex('s'),origin:'LIBRARY_RUN',fixture:false,context_key:hex('context'),freeze_canonical:freeze,freeze_hash:hash(freeze),...over.columns};
  return ['comparison_id','participant_id','position','source_hash','origin','fixture','context_key','freeze_canonical','freeze_hash'].map(name=>row[name]);
}
const inTransaction=(target,fn)=>target.transaction(fn,serializable);

test('table rules (specs): every malformed shape is a CHECK, NOT NULL or foreign-key failure; the freeze time is the database clock; duplicates are unique violations',async()=>{
  const O=OWNER_B;
  const body=(patch)=>{const w={start_ms:T0,end_ms:T0+MINUTE*60};const spec=specFor(['x1','x2'],w).spec;const text=canonical({...spec,...patch});return {text,hash:hash(text)};};
  const badBody=(patch,over={})=>{const {text,hash:digest}=body(patch);const row=values(O,{start_ms:T0,end_ms:T0+MINUTE*60,spec_canonical:text,spec_body_hash:digest,...over});return row;};
  const bad=[
    ['mode ACTUAL_BOT',withColumn(O,'mode','ACTUAL_BOT'),CHECK_VIOLATION],['other broker',withColumn(O,'broker','binance-us'),CHECK_VIOLATION],['other symbol',withColumn(O,'symbol','ETHUSDT'),CHECK_VIOLATION],
    ['other timeframe',withColumn(O,'timeframe','5'),CHECK_VIOLATION],['misaligned start',withColumn(O,'start_ms',T0+1),CHECK_VIOLATION],['misaligned end',withColumn(O,'end_ms',T0+1440*MINUTE+1),CHECK_VIOLATION],
    ['negative start',withColumn(O,'start_ms',-60000),CHECK_VIOLATION],['end before start',withColumn(O,'end_ms',T0-MINUTE),CHECK_VIOLATION],['end beyond year 10000',withColumn(O,'end_ms',253402300860000),CHECK_VIOLATION],
    ['one participant',withColumn(O,'participant_count',1),CHECK_VIOLATION],['five participants',withColumn(O,'participant_count',5),CHECK_VIOLATION],
    ['short context key',withColumn(O,'context_key',hex('c').slice(1)),CHECK_VIOLATION],['uppercase spec hash',withColumn(O,'spec_hash',hex('c').toUpperCase()),CHECK_VIOLATION],
    ['short body hash',withColumn(O,'spec_body_hash','abc'),CHECK_VIOLATION],['body hash of other text',withColumn(O,'spec_body_hash',hex('other')),CHECK_VIOLATION],
    ['request key hash not hex',withColumn(O,'request_key_hash','not-hex'),CHECK_VIOLATION],['invalid comparison id',withColumn(O,'comparison_id','-bad id'),CHECK_VIOLATION],
    ['spec text over 64 KiB',(()=>{const text=canonical({...specFor(['x1','x2'],WINDOW).spec,pad:'x'.repeat(70000)});return withColumn(O,'spec_canonical',text);})(),CHECK_VIOLATION],
    ['body not JSON',(()=>{const row=values(O);row[specColumns.indexOf('spec_canonical')]='not json';row[specColumns.indexOf('spec_body_hash')]=hash('not json');return row;})(),INVALID_TEXT],
    ['body is an array',(()=>{const row=values(O);row[specColumns.indexOf('spec_canonical')]='[]';row[specColumns.indexOf('spec_body_hash')]=hash('[]');return row;})(),CHECK_VIOLATION],
    ['body mode differs',badBody({mode:'ACTUAL_BOT'}),CHECK_VIOLATION],['body without a version',badBody({version:'qr3-spec-v0'}),CHECK_VIOLATION],
    ['body benchmark differs',badBody({benchmark:'other'}),CHECK_VIOLATION],['body participants not an array',badBody({participants:'ab'}),CHECK_VIOLATION],
    ['body participants length differs',badBody({participants:['a','b','c']}),CHECK_VIOLATION],['body period start differs',badBody({period:{start_ms:T0+MINUTE,end_ms:T0+MINUTE*60}}),CHECK_VIOLATION],
    ['body period end as a string',badBody({period:{start_ms:T0,end_ms:String(T0+MINUTE*60)}}),CHECK_VIOLATION],['body without a period',badBody({period:null}),CHECK_VIOLATION],
    ['null owner',withColumn(O,'owner_id',null),NOT_NULL],['null mode',withColumn(O,'mode',null),NOT_NULL],['null fixture',withColumn(O,'fixture',null),NOT_NULL],['null body',withColumn(O,'spec_canonical',null),NOT_NULL],
    ['unknown owner',withColumn('no-such-owner','owner_id','no-such-owner'),FK_VIOLATION]];
  for(const [label,row,code] of bad)await refused(inTransaction(rt,()=>rt.query(specInsert,row)),code).catch(error=>{throw Error(label+': '+error.message);});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${SPECS} WHERE owner_id=$1`,[O])).rows[0].n,0,'no malformed row was stored');
  // the freeze time is the database clock: a supplied value is overwritten (the row is rolled back, nothing commits without its participants)
  const stamped=await probe(rt,async()=>{
    const first=(await rt.query(specInsert+' RETURNING frozen_at_ms',values(O,{frozen_at_ms:1}))).rows[0].frozen_at_ms;
    const second=(await rt.query(specInsert+' RETURNING frozen_at_ms',values(O,{frozen_at_ms:253402300799999}))).rows[0].frozen_at_ms;
    const clock=(await rt.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now;
    return {first:Number(first),second:Number(second),clock:Number(clock)};
  },serializable);
  assert.ok(stamped.first>1&&stamped.first<=stamped.second&&stamped.second<=stamped.clock,JSON.stringify(stamped));
  // a comparison cannot be its own parent: the guard refuses it before the CHECK (the CHECK stays as defense in depth)
  await refusedBy(inTransaction(rt,()=>rt.query(specInsert,(()=>{const row=values(O);row[2]=row[0];return row;})())),QR004,'quant_comparison_spec_parent');
  // an unknown parent, and a parent of another owner, are guard refusals; a parent of the same owner is accepted
  await refusedBy(inTransaction(rt,()=>rt.query(specInsert,withColumn(O,'parent_comparison_id','no-such-parent'))),QR004,'quant_comparison_spec_parent');
  const parent=await create(rt,OWNER_A);
  await refusedBy(inTransaction(rt,()=>rt.query(specInsert,withColumn(O,'parent_comparison_id',parent.comparison_id))),QR004,'quant_comparison_spec_parent');
  const child=await createComparison(rt,{...inputFor(OWNER_A),parent_comparison_id:parent.comparison_id});
  assert.equal(child.ok,true,JSON.stringify(child));
  assert.equal((await readComparison(rt,{owner_id:OWNER_A,comparison_id:child.comparison_id})).comparison.parent_comparison_id,parent.comparison_id);
  // unique keys: the comparison id and the request key per owner
  await refused(inTransaction(rt,()=>rt.query(specInsert,withColumn(OWNER_A,'comparison_id',parent.comparison_id))),UNIQUE_VIOLATION);
  const keyed=await create(rt,OWNER_A,{patch:{request_key:'rule-key'}});
  await refused(inTransaction(rt,()=>rt.query(specInsert,withColumn(OWNER_A,'request_key_hash',hash('rule-key')))),UNIQUE_VIOLATION);
  assert.equal((await probe(rt,()=>rt.query(specInsert+' RETURNING comparison_id',withColumn(O,'request_key_hash',hash('rule-key'))),serializable)).rows[0].comparison_id.startsWith('raw-'),true,'another owner may use the same key');
  assert.equal(keyed.ok,true);
});

test('table rules (participants): no row can be added after the create commit; every malformed shape is refused',async()=>{
  const real=await create(rt,OWNER_A,{fixture:false,count:3});
  const before=await rowDigest(db,PARTICIPANTS);
  const add=(participantId,position,over)=>inTransaction(rt,()=>rt.query(participantInsert,participantValues(real.comparison_id,participantId,position,over)));
  // every position 1..count is taken, so a new participant collides or falls outside the declared count
  await refused(add('extra-1',1),UNIQUE_VIOLATION);await refused(add('extra-2',3),UNIQUE_VIOLATION);
  await refusedBy(add('extra-3',4),QR004,'quant_comparison_participant_position');
  await refusedBy(add('extra-4',5),QR004,'quant_comparison_participant_position');await refused(add('extra-5',0),CHECK_VIOLATION);
  await refused(add(real.participants[0].participant_id,1),UNIQUE_VIOLATION);
  await refusedBy(inTransaction(rt,()=>rt.query(participantInsert,participantValues('no-such-comparison','p-1',1))),QR004,'quant_comparison_participant_spec');
  const open=await probe(rt,async()=>{
    // inside one rolled-back transaction: a new comparison row that still has room for participants
    const row=values(OWNER_A,{fixture:false,participant_count:2});
    await rt.query(specInsert,row);
    const id=row[0];
    const codes=[];
    const attempt=async(participantId,position,over)=>{
      await rt.query('SAVEPOINT s');
      try{await rt.query(participantInsert,participantValues(id,participantId,position,over));await rt.query('RELEASE SAVEPOINT s');return null;}
      catch(error){await rt.query('ROLLBACK TO SAVEPOINT s');return [error.code,error.constraint??null];}
    };
    codes.push(await attempt('fx',1,{columns:{origin:'FIXTURE',fixture:true}}));                                    // fixture participant, non-fixture comparison
    codes.push(await attempt('p-origin',1,{columns:{origin:'FIXTURE',fixture:false}}));                              // origin and flag disagree
    codes.push(await attempt('p-library-fixture',1,{columns:{origin:'LIBRARY_RUN',fixture:true}}));
    codes.push(await attempt('p-unknown-origin',1,{columns:{origin:'OTHER'}}));
    codes.push(await attempt('p-source',1,{columns:{source_hash:'xyz'},freeze:{source_hash:'xyz'}}));
    codes.push(await attempt('p-context',1,{columns:{context_key:hex('c').toUpperCase()}}));
    codes.push(await attempt('-bad id',1));
    codes.push(await attempt('p-freeze-hash',1,{columns:{freeze_hash:hex('other')}}));
    codes.push(await attempt('p-freeze-id',1,{freeze:{participant_id:'someone-else'}}));
    codes.push(await attempt('p-freeze-source',1,{freeze:{source_hash:hex('other')}}));
    codes.push(await attempt('p-freeze-prior',1,{freeze:{prior_exposed_by:'none'}}));
    codes.push(await attempt('p-freeze-json',1,{columns:{freeze_canonical:'not json',freeze_hash:hash('not json')}}));
    codes.push(await attempt('p-freeze-size',1,{freeze:{pad:'x'.repeat(270000)}}));
    codes.push(await attempt('p-ok',1));
    return codes;
  },serializable);
  assert.deepEqual(open,[[QR004,'quant_comparison_participant_fixture'],[CHECK_VIOLATION,'quant_comparison_participants_fixture_check'],[QR004,'quant_comparison_participant_fixture'],
    [CHECK_VIOLATION,'quant_comparison_participants_origin_check'],[CHECK_VIOLATION,'quant_comparison_participants_source_hash_check'],[CHECK_VIOLATION,'quant_comparison_participants_context_key_check'],
    [CHECK_VIOLATION,'quant_comparison_participants_participant_id_check'],[CHECK_VIOLATION,'quant_comparison_participants_freeze_digest_check'],[CHECK_VIOLATION,'quant_comparison_participants_freeze_body_check'],
    [CHECK_VIOLATION,'quant_comparison_participants_freeze_body_check'],[CHECK_VIOLATION,'quant_comparison_participants_freeze_body_check'],[INVALID_TEXT,null],
    [CHECK_VIOLATION,'quant_comparison_participants_freeze_size_check'],null]);
  assert.deepEqual(await rowDigest(db,PARTICIPANTS),before,'no refused participant was stored');
});

/* ---- 5. status graph ---- */

test('status events: seq = last + 1, only the allowed edges, nothing after a terminal status, COMPLETE refused, the database clock stamps strictly increasing times',async()=>{
  const mk=async()=>create(rt,OWNER_A);
  const transition='quant_comparison_status_transition';
  // the first event is the SPEC_FROZEN written by the create; a second seq 1 or another first status is refused
  const a=await mk();
  assert.deepEqual(await statusOf(db,a.comparison_id),{seq:1,status:'SPEC_FROZEN'});
  await refusedBy(addEvent(rt,a.comparison_id,1,'SPEC_FROZEN'),QR004,transition);
  await refusedBy(addEvent(rt,a.comparison_id,3,'EVALUATING'),QR004,transition);                       // gap
  await refusedBy(addEvent(rt,a.comparison_id,2,'SPEC_FROZEN'),QR004,transition);
  await refusedBy(addEvent(rt,a.comparison_id,2,'COMPLETE'),QR004,transition);                         // not an edge from SPEC_FROZEN
  await refusedBy(addEvent(rt,a.comparison_id,2,'BOGUS'),QR004,transition);
  await refusedBy(addEvent(rt,'no-such-comparison',1,'SPEC_FROZEN'),QR004,'quant_comparison_status_spec');
  await refused(addEvent(rt,a.comparison_id,2,'FAILED'),CHECK_VIOLATION);                                 // FAILED needs a reason
  await refused(addEvent(rt,a.comparison_id,2,'FAILED','lower_case'),CHECK_VIOLATION);
  await refused(addEvent(rt,a.comparison_id,2,'EVALUATING','SOME_REASON'),CHECK_VIOLATION);              // a reason only on FAILED and CANCELLED
  await refusedBy(rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,0,'EVALUATING')`,[a.comparison_id]),serializable),QR004,transition);
  assert.deepEqual(await statusOf(db,a.comparison_id),{seq:1,status:'SPEC_FROZEN'},'no refusal stored an event');
  // SPEC_FROZEN -> EVALUATING -> COMPLETE is refused until the outcome table exists; -> FAILED with a reason is terminal
  const evaluating=await addEvent(rt,a.comparison_id,2,'EVALUATING');
  await refusedBy(addEvent(rt,a.comparison_id,3,'COMPLETE'),QR004,transition);
  await refusedBy(addEvent(rt,a.comparison_id,3,'SPEC_FROZEN'),QR004,transition);
  await refusedBy(addEvent(rt,a.comparison_id,3,'EVALUATING'),QR004,transition);
  await addEvent(rt,a.comparison_id,3,'FAILED','EVALUATION_ERROR');
  for(const status of ['EVALUATING','CANCELLED','FAILED','COMPLETE','SPEC_FROZEN'])await refusedBy(addEvent(rt,a.comparison_id,4,status,status==='FAILED'?'AGAIN':null),QR004,transition);
  assert.deepEqual(await statusOf(db,a.comparison_id),{seq:3,status:'FAILED'});
  assert.ok(Number(evaluating.rows[0].at_ms)>0);
  // every other allowed edge, each from a fresh comparison
  const edge=async(path)=>{const c=await mk();let seq=1;for(const [status,reason] of path){seq+=1;await addEvent(rt,c.comparison_id,seq,status,reason??null);}return statusOf(db,c.comparison_id);};
  assert.deepEqual(await edge([['CANCELLED',null]]),{seq:2,status:'CANCELLED'});
  assert.deepEqual(await edge([['CANCELLED','OWNER_REQUEST']]),{seq:2,status:'CANCELLED'});
  assert.deepEqual(await edge([['FAILED','ADMISSION_CLOSED']]),{seq:2,status:'FAILED'});
  assert.deepEqual(await edge([['EVALUATING'],['CANCELLED',null]]),{seq:3,status:'CANCELLED'});
  assert.deepEqual(await edge([['EVALUATING'],['FAILED','NO_DATA']]),{seq:3,status:'FAILED'});
  // a cancelled comparison keeps its exposure register rows (the register is insert-only evidence)
  const cancelled=await mk();
  const registerBefore=(await db.query('SELECT count(*)::int n FROM public.quant_exposure_register WHERE comparison_id=$1',[cancelled.comparison_id])).rows[0].n;
  await addEvent(rt,cancelled.comparison_id,2,'CANCELLED',null);
  assert.equal(registerBefore,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_exposure_register WHERE comparison_id=$1',[cancelled.comparison_id])).rows[0].n,2);
  // the read follows the last event; a supplied clock value is ignored and the times strictly increase, also inside one millisecond
  const timed=await mk();
  const burst=await rt.transaction(async()=>{
    const times=[];
    for(const [seq,status] of [[2,'EVALUATING']])times.push(Number((await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status,at_ms) VALUES($1,$2,$3,1) RETURNING at_ms`,[timed.comparison_id,seq,status])).rows[0].at_ms));
    times.push(Number((await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status,at_ms) VALUES($1,3,'CANCELLED',253402300799999) RETURNING at_ms`,[timed.comparison_id])).rows[0].at_ms));
    return times;
  },serializable);
  const view=await readComparison(rt,{owner_id:OWNER_A,comparison_id:timed.comparison_id});
  assert.deepEqual(view.events.map(item=>item.status),['SPEC_FROZEN','EVALUATING','CANCELLED']);
  assert.deepEqual(view.status,{seq:3,status:'CANCELLED',reason_code:null,at_ms:burst[1]});
  const times=[view.comparison.frozen_at_ms,...view.events.map(item=>item.at_ms)];
  assert.ok(times.every((value,index)=>index===0||value>times[index-1]),'times strictly increase: '+times.join());
  assert.ok(burst[0]>1&&burst[1]<253402300799999);
});

test('status events: a race between two transitions of one comparison leaves one winner and the other fails on the key (23505 or 40001); a cancel and a later event cannot both land',async()=>{
  for(let round=0;round<3;round+=1){
    const c=await create(rt,OWNER_A);
    const entered=gate(),release=gate();
    const evaluating=rt.transaction(async()=>{
      await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[c.comparison_id]);
      entered.open();await release.promise;
    },serializable);
    await entered.promise;
    const cancel=rt2.transaction(()=>rt2.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'CANCELLED')`,[c.comparison_id]),serializable);
    const settled=cancel.then(()=>({ok:true}),error=>({ok:false,code:error.code}));
    // the second writer waits on the first writer's uncommitted key
    await until(async()=>(await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active'")).rows[0].n>=1,'the second transition to wait');
    release.open();
    await evaluating;
    const result=await settled;
    assert.equal(result.ok,false);assert.ok([UNIQUE_VIOLATION,SERIALIZATION_FAILURE].includes(result.code),result.code);
    assert.deepEqual(await statusOf(db,c.comparison_id),{seq:2,status:'EVALUATING'});
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${EVENTS} WHERE comparison_id=$1`,[c.comparison_id])).rows[0].n,2);
    // the loser can retry and now meets the transition guard: a cancel after EVALUATING is a valid edge at seq 3
    await addEvent(rt2,c.comparison_id,3,'CANCELLED');
    assert.deepEqual(await statusOf(db,c.comparison_id),{seq:3,status:'CANCELLED'});
  }
});

/* ---- 6. shadowing ---- */

test('a session TEMP table or function named like a comparison object fools none of the guards',async()=>{
  const c=await create(rt,OWNER_A);
  // The guards read the real tables whatever the search_path says: with empty TEMP shadows of the spec and event tables first on the path, a valid
  // event still lands (a guard that read the shadows would find no spec and refuse it).
  await rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE quant_comparison_specs(x integer) ON COMMIT DROP');
    await rt.query('CREATE TEMP TABLE quant_comparison_status_events(LIKE public.quant_comparison_status_events) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,2,'EVALUATING')",[c.comparison_id]);
    assert.equal((await rt.query('SELECT count(*)::int n FROM pg_temp.quant_comparison_status_events')).rows[0].n,0,'the TEMP table kept nothing');
  },serializable);
  assert.deepEqual(await statusOf(db,c.comparison_id),{seq:2,status:'EVALUATING'});
  // a TEMP floor() cannot zero the stamped clock, and a TEMP current_setting() cannot fake the isolation (see the isolation test)
  await rt.transaction(async()=>{
    await rt.query("CREATE FUNCTION pg_temp.floor(numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT 0::numeric $$");
    await rt.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await rt.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,3,'CANCELLED')",[c.comparison_id]);
  },serializable);
  assert.ok(Number((await db.query(`SELECT at_ms FROM ${EVENTS} WHERE comparison_id=$1 AND seq=3`,[c.comparison_id])).rows[0].at_ms)>1e12,'the event carries the database time');
  // the privilege layer still holds with a shadowed path
  await refused(rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE quant_comparison_specs(x integer) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query('UPDATE public.quant_comparison_specs SET owner_id=owner_id WHERE comparison_id=$1',[c.comparison_id]);
  },serializable),DENIED);
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

test('transaction-membership helper: own xid true, earlier or system xid false, a future-looking xid answers false and never raises',async()=>{
  const answer=async(offset,fixed=null)=>probe(db,async()=>{
    const current=BigInt((await db.query('SELECT pg_current_xact_id()::text x')).rows[0].x);
    const target=fixed===null?(current+BigInt(offset))%4294967296n:BigInt(fixed);
    return (await db.query('SELECT public.quant_comparison_in_this_transaction($1::text::xid) v',[target.toString()])).rows[0].v;
  });
  assert.equal(await answer(0),true,'the current transaction id');
  assert.equal(await answer(-1),false,'an earlier transaction id');
  assert.equal(await answer(0,0),false,'invalid xid');
  assert.equal(await answer(0,2),false,'frozen xid');
  assert.equal(await answer(1000000),false,'a future-looking xid');
  assert.equal(await answer(2000000000),false,'a far future-looking xid');
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
  const badRole=await inspect(['--runtime-role=no_such_role_s2c']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  // install, then a second install
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/Quant comparison tables ready: quant-comparison-v1; state=INSTALLED; previous state=ABSENT; guards=16/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  // INSTALLED without a runtime role passes; with a role that has no grant yet it fails on the missing privileges; after the grant script it passes
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  const ungranted=await inspect(['--runtime-role='+roleName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:quant_comparison_specs:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(roleName));
  const granted=await inspect(['--runtime-role='+roleName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.map(item=>[item.table,item.insert,item.update,item.delete]).sort((a,b)=>a[0]<b[0]?-1:1),
    [['quant_comparison_participants',true,false,false],['quant_comparison_schema',false,false,false],['quant_comparison_specs',true,false,false],['quant_comparison_status_events',true,false,false]]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.quant_comparison_specs DISABLE TRIGGER quant_comparison_specs_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.quant_comparison_specs ENABLE ALWAYS TRIGGER quant_comparison_specs_no_change');
  assert.equal((await inspect()).code,0);
  // an installed extension whose register has gone fails the inspection
  await cliDb.query('ALTER TABLE public.quant_exposure_register RENAME TO s2c_register_renamed');
  const noRegister=await inspect();assert.equal(noRegister.code,1);assert.ok(noRegister.report.failures.some(item=>item.startsWith('EXPOSURE_REGISTER_NOT_INSTALLED:')));
  await cliDb.query('ALTER TABLE public.s2c_register_renamed RENAME TO quant_exposure_register');
  assert.equal((await inspect()).code,0);
  // usage errors
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--bogus'],['--runtime-role=Bad-Name']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  // rollback of the empty tables, then a second rollback (no-op) and a re-install
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await comparisonObjects(cliDb),{relations:0,functions:0,triggers:0});
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
});

/* ---- 8. rollback with evidence, dump and restore ---- */

test('rollback: empty tables are dropped completely and the register is untouched; any comparison row refuses it with no change',async()=>{
  const name=await clone('rollback');
  const target=track(new PostgresDatabase({connectionString:urlOf(name),max:3}));
  const user=await new Store(target).createUser({email:'rb-'+randomUUID()+'@example.test',passwordHash:'x'});
  const baseline=await catalogDigest(target);
  await migrateQuantComparison(target);
  const rolled=await rollbackQuantComparison(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await comparisonObjects(target),{relations:0,functions:0,triggers:0});
  assert.deepEqual((await catalogDigest(target)).n,baseline.n,'the catalog is back to the baseline object count');
  assert.deepEqual(await rollbackQuantComparison(target),{rolled_back:true,previous_state:'ABSENT'});
  await migrateQuantComparison(target);
  const made=await createComparison(target,inputFor(user.id));
  assert.equal(made.ok,true,JSON.stringify(made));
  const held=await allRows(target),objects=await catalogDigest(target);
  await assert.rejects(rollbackQuantComparison(target),/rollback refused; 4 evidence row\(s\) exist in quant_comparison_specs, quant_comparison_participants, quant_comparison_status_events \(no change made\)/);
  assert.deepEqual(await allRows(target),held,'the evidence rows are still there');assert.deepEqual(await catalogDigest(target),objects,'nothing else changed');
  assert.equal((await classifyQuantComparison(target)).state,'INSTALLED');
  // the register is never touched by this rollback, and its own rollback refuses while its rows stay
  assert.equal((await target.query('SELECT count(*)::int n FROM public.quant_exposure_register')).rows[0].n,2);
  // a writer that holds an uncommitted create blocks the rollback from counting past it (ACCESS EXCLUSIVE), then the count sees the row
  const other=await clone('rollbacklate');
  const late=track(new PostgresDatabase({connectionString:urlOf(other),max:3}));
  const lateUser=await new Store(late).createUser({email:'rl-'+randomUUID()+'@example.test',passwordHash:'x'});
  await migrateQuantComparison(late);
  const inside=gate(),finish=gate();
  const writer=late.transaction(async()=>{
    const row=values(lateUser.id);
    await late.query(specInsert,row);
    inside.open();await finish.promise;
    throw new Rollback();                       // the spec alone would fail its commit check; the rollback test needs a held row only
  },serializable).catch(error=>{if(!(error instanceof Rollback))throw error;});
  await inside.promise;
  const waiting=rollbackQuantComparison(track(new PostgresDatabase({connectionString:urlOf(other),max:2})));
  const settled=waiting.then(()=>'DROPPED',error=>error.message);
  finish.open();await writer;
  assert.equal(await settled,'DROPPED','the uncommitted spec never became evidence, so the empty tables were dropped');
});

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS, the deferred commit check, the rows and the grants',async t=>{
  const restoredName='robot_s2c_restore_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-s2c-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'s2c.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=track(new PostgresDatabase({connectionString:urlOf(restoredName)})),restoredRuntime=track(new PostgresDatabase({connectionString:urlOf(restoredName,roleName)}));
  const triggers=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype,t.tgdeferrable,t.tginitdeferred FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'quant\\_comparison%' ORDER BY t.tgname`)).rows;
  assert.deepEqual(await triggers(restored),await triggers(db));assert.ok((await triggers(restored)).every(row=>row.tgenabled==='A'));
  assert.deepEqual(await allRows(restored),await allRows(db),'every stored row came back, with its stamped clock values');
  assert.equal((await classifyQuantComparison(restored)).state,'INSTALLED');
  const report=await inspectQuantComparison(restored,{runtimeRole:roleName});assert.equal(report.ok,true,report.failures.join());
  await refused(restoredRuntime.query(`UPDATE ${SPECS} SET owner_id=owner_id WHERE owner_id=$1`,[OWNER_A]),DENIED);
  await refused(db.query(`UPDATE ${SPECS} SET owner_id=owner_id`),QR002);
  await refused(restoredRuntime.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES('x',1,'SPEC_FROZEN')`),QR003);
  const again=await createComparison(restoredRuntime,inputFor(OWNER_A));
  assert.equal(again.ok,true,JSON.stringify(again));
});
