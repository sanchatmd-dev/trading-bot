import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {PAPER_CAPITAL_GUARDS,QR004_GUARDS,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,PAPER_CAPITAL_MARKER,classifyPaperCapitalModel,
  inspectPaperCapitalModel,migratePaperCapitalModel,rollbackPaperCapitalModel} from '../../src/postgres/paper-capital-model-migration.js';

// QR-2 S4-1 paper capital model declaration extension, proven on a throwaway PostgreSQL cluster as real non-owner LOGIN roles with the repo grants.
// Every row is a LABELLED FIXTURE (synthetic owners and Bots, never a research or trading result). Rows are insert-only, so each test uses its own owner.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501';
const DAY=86400000;
const TABLE='public.paper_capital_models',MARKER='public.paper_capital_model_schema';
const CLI='scripts/migrate-paper-capital-model.mjs';
let admin,db,rt,rt2,upd,dl,tr,connectionString,templateName,databaseName,roleName,updaterName,deleterName,truncaterName,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const grantScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const serializable={isolation:'SERIALIZABLE'};
const track=pool=>{pools.push(pool);return pool;};
/** A QR004 refusal carries CONSTRAINT = the rule family; the message pattern tells the rules of one family apart. */
const guardRefused=(promise,name,pattern)=>assert.rejects(promise,error=>{
  assert.equal(error.code,QR004,'SQLSTATE: '+error.message);assert.equal(error.constraint,name,'rule family: '+error.message);
  if(pattern)assert.match(error.message,pattern);
  return true;});
const checkRefused=(promise,constraint,code='23514')=>assert.rejects(promise,error=>{assert.equal(error.code,code,error.message);assert.equal(error.constraint,constraint,error.message);return true;});
// Midnight-safe fixture date. The database clock decides (the stamp trigger uses it): clockOffset is the database clock minus Date.now(), read once in before().
// When a UTC midnight is less than 30 s away, the call waits (a synchronous sleep) until it has passed, so a fixture never straddles a midnight and
// an effective_from computed here is never before the stamp of the insert that uses it.
let clockOffset=0;
const databaseNow=()=>Date.now()+clockOffset;
const nextMidnight=()=>{
  let now=databaseNow();
  if(DAY-now%DAY<30000){
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,DAY-now%DAY+1000);
    now=databaseNow();
  }
  return (Math.floor(now/DAY)+1)*DAY;
};

/** A database built from the template (base schema 14, no capital-model extension). */
async function clone(label){
  const name='robot_pcm_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  return name;
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog. */
async function probe(target,fn,isolation='READ COMMITTED'){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();},{isolation});}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.oid||':'||c.xmin::text||':'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.oid||':'||k.xmin::text||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
const extensionObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'paper\\_capital\\_model%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'paper\\_capital\\_model%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'paper\\_capital\\_model%') triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0};
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE t.tgrelid IN ('public.paper_capital_models'::regclass,'public.paper_capital_model_schema'::regclass) AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
const rowDigest=async target=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY t.owner_id,t.currency,t.version),''),'UTF8')),'hex') d FROM ${TABLE} t`)).rows[0];
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;
const insertSql=`INSERT INTO ${TABLE}(owner_id,currency,version,capital_model,bot_set,effective_from,declared_at,declared_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`;
/** A valid first USDT declaration of an owner who has no Bots; every field can be overridden. declared_at is a client value the database overwrites. */
const row=(owner,over={})=>({owner_id:owner,currency:'USDT',version:1,capital_model:'INDEPENDENT_ACCOUNTS',bot_set:[owner],effective_from:nextMidnight(),declared_at:1,declared_by:owner,...over});
const valuesOf=value=>[value.owner_id,value.currency,value.version,value.capital_model,
  value.bot_set===null?null:typeof value.bot_set==='string'?value.bot_set:JSON.stringify(value.bot_set),value.effective_from,value.declared_at,value.declared_by];
const insertRaw=(target,value,isolation='SERIALIZABLE')=>target.transaction(()=>target.query(insertSql,valuesOf(value)),{isolation});
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}
async function newOwner(label,target=store){
  const user=await target.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  return user.id;
}
/** A child Bot row of an owner. The base schema allows slots 1 to 5 and repeats; ids are the caller's. */
async function addBot(owner,id=randomUUID(),slot=2,target=db){
  await target.query(`INSERT INTO users(id,email,password_hash,role,status,created_at,parent_user_id,bot_slot_index,label) VALUES($1,$2,'NO_LOGIN','BOT','ACTIVE',$3,$4,$5,'Fixture Bot')`,
    [id,id+'@bot.invalid',Date.now(),owner,slot]);
  return id;
}
const fullSet=async(owner,target=db)=>(await target.query('SELECT id FROM users WHERE id=$1 OR parent_user_id=$1',[owner])).rows.map(item=>item.id).sort();
async function cli(args=[],url=connectionString){
  try{
    const {stdout,stderr}=await run(process.execPath,[CLI,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}});
    return {code:0,stdout,stderr};
  }catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  clockOffset=Number((await admin.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS ms')).rows[0].ms)-Date.now();
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_pcm_tpl_'+suffix;databaseName='robot_pcm_main_'+suffix;
  roleName='robot_pcm_rt_'+suffix.slice(0,14);updaterName='robot_pcm_upd_'+suffix.slice(0,14);deleterName='robot_pcm_del_'+suffix.slice(0,14);truncaterName='robot_pcm_trn_'+suffix.slice(0,14);
  for(const name of [roleName,updaterName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{await builder.migrate();}finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString,max:6}));
  store=new Store(db);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [roleName,updaterName,deleterName,truncaterName])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. install lifecycle ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing',async()=>{
  const before=await catalogDigest(db);
  const classification=await classifyPaperCapitalModel(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectPaperCapitalModel(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectPaperCapitalModel(db,{runtimeRole:'no_such_role_pcm'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await extensionObjects(db),NONE);
});

test('absent: a same-name foreign object classifies OTHER, so an install over it would be refused',async()=>{
  const noop="CREATE FUNCTION public.pcm_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign declaration table','CREATE TABLE public.paper_capital_models(x integer)','TABLE_DEFINITION:paper_capital_models:'],
    ['foreign marker table','CREATE TABLE public.paper_capital_model_schema(version integer)','TABLE_DEFINITION:paper_capital_model_schema:'],
    ['foreign marker function',"CREATE FUNCTION public.paper_capital_model_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:paper_capital_model_version:'],
    ['foreign clock function',"CREATE FUNCTION public.paper_capital_model_now_ms() RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$",'FUNCTION_DEFINITION:paper_capital_model_now_ms:'],
    ['overload of the guard function','CREATE FUNCTION public.paper_capital_model_guard(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:paper_capital_model_guard('],
    ['view carrying an index name','CREATE VIEW public.paper_capital_models_pkey AS SELECT 1 AS x','RELATION_UNEXPECTED:paper_capital_models_pkey'],
    ['sequence carrying an index name','CREATE SEQUENCE public.paper_capital_model_schema_pkey','RELATION_UNEXPECTED:paper_capital_model_schema_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.paper_capital_models AS integer','TYPE_UNEXPECTED:paper_capital_models'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER paper_capital_models_20_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.pcm_noop()','TRIGGER_UNEXPECTED:paper_capital_models_20_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyPaperCapitalModel(db),report:await inspectPaperCapitalModel(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await extensionObjects(db),NONE,'every probe was rolled back');
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, tables and grants stay as they were; a second install is a no-op',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(item=>item.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S') AND c.relname NOT LIKE 'paper\\_capital\\_model%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migratePaperCapitalModel(db,{runtimeRole:roleName});
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,PAPER_CAPITAL_MARKER);assert.equal(report.facts.guards.length,7);
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(item=>item.relname).filter(name=>!baseTables.includes(name)),
    ['paper_capital_model_schema','paper_capital_models'],'exactly the two tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await extensionObjects(db),{relations:4,functions:6,triggers:7},'two tables, two primary keys, six functions and seven triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM paper_capital_model_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.paper_capital_model_version() v')).rows[0].v,PAPER_CAPITAL_MARKER);
  assert.deepEqual((await guardRows(db)).map(item=>[item.tgname,item.tgenabled,item.tgtype]).sort(),PAPER_CAPITAL_GUARDS.map(item=>[item[0],'A',item[3]]).sort());
  // the QR004 rule families are the four named ones, each present in the guard text
  const guardText=(await db.query("SELECT prosrc FROM pg_proc WHERE proname='paper_capital_model_guard'")).rows[0].prosrc;
  for(const name of QR004_GUARDS)assert.ok(guardText.includes("CONSTRAINT = '"+name+"'"),name);
  assert.equal([...guardText.matchAll(/CONSTRAINT = '([^']+)'/g)].every(match=>QR004_GUARDS.includes(match[1])),true,'no other rule family name');
  const settled=await catalogDigest(db);
  const again=await migratePaperCapitalModel(db,{runtimeRole:roleName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.pcm_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const T='ALTER TABLE public.paper_capital_models ',M='ALTER TABLE public.paper_capital_model_schema ';
  const OTHER_OWNER='CREATE ROLE pcm_other_owner NOLOGIN; ';
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const cases=[
    ['guard body replaced',"CREATE OR REPLACE FUNCTION public.paper_capital_model_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:paper_capital_model_guard:BODY'],
    ['stamp body replaced',"CREATE OR REPLACE FUNCTION public.paper_capital_model_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:paper_capital_model_stamp:BODY'],
    ['freeze body replaced',"CREATE OR REPLACE FUNCTION public.paper_capital_model_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:paper_capital_model_freeze:BODY'],
    ['clock function body replaced',"CREATE OR REPLACE FUNCTION public.paper_capital_model_now_ms() RETURNS bigint LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 0::bigint $$",'FUNCTION_DEFINITION:paper_capital_model_now_ms:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.paper_capital_model_guard() SECURITY DEFINER','FUNCTION_DEFINITION:paper_capital_model_guard:SECURITY_DEFINER'],
    ['serializable guard made SECURITY DEFINER','ALTER FUNCTION public.paper_capital_model_require_serializable() SECURITY DEFINER','FUNCTION_DEFINITION:paper_capital_model_require_serializable:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.paper_capital_model_guard() RESET search_path','FUNCTION_DEFINITION:paper_capital_model_guard:SEARCH_PATH'],
    ['stamp search_path reset','ALTER FUNCTION public.paper_capital_model_stamp() RESET search_path','FUNCTION_DEFINITION:paper_capital_model_stamp:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.paper_capital_model_guard() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:paper_capital_model_guard:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.paper_capital_model_guard() STRICT','FUNCTION_DEFINITION:paper_capital_model_guard:ATTRIBUTES'],
    ['clock function made STABLE','ALTER FUNCTION public.paper_capital_model_now_ms() STABLE','FUNCTION_DEFINITION:paper_capital_model_now_ms:ATTRIBUTES'],
    ['marker function made VOLATILE','ALTER FUNCTION public.paper_capital_model_version() VOLATILE','FUNCTION_DEFINITION:paper_capital_model_version:ATTRIBUTES'],
    ['trigger disabled',T+'DISABLE TRIGGER paper_capital_models_no_change','TRIGGER_NOT_ALWAYS:paper_capital_models_no_change'],
    ['guard trigger disabled',T+'DISABLE TRIGGER paper_capital_models_20_guard','TRIGGER_NOT_ALWAYS:paper_capital_models_20_guard'],
    ['stamp trigger origin only',T+'ENABLE TRIGGER paper_capital_models_10_stamp','TRIGGER_NOT_ALWAYS:paper_capital_models_10_stamp'],
    ['serializable trigger origin only',T+'ENABLE TRIGGER paper_capital_models_00_serializable','TRIGGER_NOT_ALWAYS:paper_capital_models_00_serializable'],
    ['truncate trigger replica only',T+'ENABLE REPLICA TRIGGER paper_capital_models_no_truncate','TRIGGER_NOT_ALWAYS:paper_capital_models_no_truncate'],
    ['marker trigger origin only',M+'ENABLE TRIGGER paper_capital_model_schema_no_change','TRIGGER_NOT_ALWAYS:paper_capital_model_schema_no_change'],
    ['trigger dropped','DROP TRIGGER paper_capital_models_no_truncate ON public.paper_capital_models','TRIGGER_MISSING:paper_capital_models_no_truncate'],
    ['stamp trigger dropped','DROP TRIGGER paper_capital_models_10_stamp ON public.paper_capital_models','TRIGGER_MISSING:paper_capital_models_10_stamp'],
    ['marker truncate trigger dropped','DROP TRIGGER paper_capital_model_schema_no_truncate ON public.paper_capital_model_schema','TRIGGER_MISSING:paper_capital_model_schema_no_truncate'],
    ['trigger rebound to the other function',redo('paper_capital_models_no_change','paper_capital_models','BEFORE UPDATE OR DELETE','paper_capital_model_stamp')+' '+T+'ENABLE ALWAYS TRIGGER paper_capital_models_no_change','TRIGGER_FUNCTION:paper_capital_models_no_change'],
    ['trigger narrowed to UPDATE only',redo('paper_capital_models_no_change','paper_capital_models','BEFORE UPDATE','paper_capital_model_freeze')+' '+T+'ENABLE ALWAYS TRIGGER paper_capital_models_no_change','TRIGGER_SHAPE:paper_capital_models_no_change'],
    ['guard trigger made AFTER',redo('paper_capital_models_20_guard','paper_capital_models','AFTER INSERT','paper_capital_model_guard')+' '+T+'ENABLE ALWAYS TRIGGER paper_capital_models_20_guard','TRIGGER_SHAPE:paper_capital_models_20_guard'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER pcm_marker AFTER INSERT ON public.paper_capital_model_schema FOR EACH ROW EXECUTE FUNCTION public.pcm_noop()','TRIGGER_UNEXPECTED:pcm_marker'],
    ['extra foreign trigger',noop+' CREATE TRIGGER pcm_extra AFTER INSERT ON public.paper_capital_models FOR EACH ROW EXECUTE FUNCTION public.pcm_noop()','TRIGGER_UNEXPECTED:pcm_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER pcm_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.paper_capital_model_freeze()','TRIGGER_UNEXPECTED:pcm_elsewhere'],
    ['orphan overload of the clock function','CREATE FUNCTION public.paper_capital_model_now_ms(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:paper_capital_model_now_ms('],
    ['check constraint dropped',T+'DROP CONSTRAINT paper_capital_models_bot_set_check','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['version cap check dropped',T+'DROP CONSTRAINT paper_capital_models_version_check','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['midnight check dropped',T+'DROP CONSTRAINT paper_capital_models_effective_from_check','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['version cap weakened',T+'DROP CONSTRAINT paper_capital_models_version_check, ADD CONSTRAINT paper_capital_models_version_check CHECK(version>=1 AND version<=5000)','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['currency list widened',T+"DROP CONSTRAINT paper_capital_models_currency_check, ADD CONSTRAINT paper_capital_models_currency_check CHECK(currency IN ('USDT','THB','EUR'))",'TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['extra constraint',T+'ADD CONSTRAINT pcm_extra CHECK(declared_at>=0)','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['check added NOT VALID in place of a valid one',T+'DROP CONSTRAINT paper_capital_models_declared_at_check, ADD CONSTRAINT paper_capital_models_declared_at_check CHECK(declared_at>=0 AND declared_at<=253402300799999) NOT VALID','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['foreign key dropped',T+'DROP CONSTRAINT paper_capital_models_declared_by_fkey','TABLE_DEFINITION:paper_capital_models:CONSTRAINTS'],
    ['internal foreign key triggers of the declaration table disabled',T+'DISABLE TRIGGER ALL','TABLE_DEFINITION:paper_capital_models:FOREIGN_KEY_TRIGGERS'],
    ['internal foreign key triggers on users disabled','ALTER TABLE public.users DISABLE TRIGGER ALL','TABLE_DEFINITION:paper_capital_models:FOREIGN_KEY_TRIGGERS'],
    ['one internal foreign key trigger on users disabled',`DO $$ DECLARE name text; BEGIN SELECT t.tgname INTO name FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
      WHERE t.tgisinternal AND k.conname='paper_capital_models_owner_id_fkey' AND t.tgrelid='public.users'::regclass ORDER BY t.tgname LIMIT 1;
      EXECUTE format('ALTER TABLE public.users DISABLE TRIGGER %I',name); END $$`,'TABLE_DEFINITION:paper_capital_models:FOREIGN_KEY_TRIGGERS'],
    ['primary key dropped',T+'DROP CONSTRAINT paper_capital_models_pkey','TABLE_DEFINITION:paper_capital_models:'],
    ['extra index','CREATE INDEX pcm_extra ON public.paper_capital_models(declared_at)','TABLE_DEFINITION:paper_capital_models:INDEXES'],
    ['extra unique index','CREATE UNIQUE INDEX pcm_extra ON public.paper_capital_models(owner_id,effective_from)','TABLE_DEFINITION:paper_capital_models:INDEXES'],
    ['primary key index rebuilt in another order',T+'DROP CONSTRAINT paper_capital_models_pkey, ADD CONSTRAINT paper_capital_models_pkey PRIMARY KEY(version,owner_id,currency)','TABLE_DEFINITION:paper_capital_models:'],
    ['column default added',T+'ALTER COLUMN declared_at SET DEFAULT 0','TABLE_DEFINITION:paper_capital_models:COLUMNS'],
    ['column made optional',T+'ALTER COLUMN declared_by DROP NOT NULL','TABLE_DEFINITION:paper_capital_models:COLUMNS'],
    ['column added',T+'ADD COLUMN extra integer','TABLE_DEFINITION:paper_capital_models:COLUMNS'],
    ['column type changed',T+'ALTER COLUMN version TYPE integer','TABLE_DEFINITION:paper_capital_models:'],
    ['column collation changed',T+'ALTER COLUMN capital_model TYPE text COLLATE "C"','TABLE_DEFINITION:paper_capital_models:COLLATION'],
    ['column collation changed on a second column',T+'ALTER COLUMN currency TYPE text COLLATE "POSIX"','TABLE_DEFINITION:paper_capital_models:COLLATION'],
    ['table re-owned to another role',OTHER_OWNER+T+'OWNER TO pcm_other_owner','OWNER_MISMATCH:paper_capital_models'],
    ['marker table re-owned to another role',OTHER_OWNER+M+'OWNER TO pcm_other_owner','OWNER_MISMATCH:paper_capital_models'],
    ['guard function re-owned to another role',OTHER_OWNER+'ALTER FUNCTION public.paper_capital_model_guard() OWNER TO pcm_other_owner','OWNER_MISMATCH:paper_capital_model_guard'],
    ['marker function re-owned to another role',OTHER_OWNER+'ALTER FUNCTION public.paper_capital_model_version() OWNER TO pcm_other_owner','OWNER_MISMATCH:paper_capital_model_version'],
    ['row security enabled',T+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:paper_capital_models:SHAPE'],
    ['rule added','CREATE RULE pcm_rule AS ON INSERT TO public.paper_capital_models DO ALSO NOTHING','TABLE_DEFINITION:paper_capital_models:SHAPE'],
    ['marker row removed','DELETE FROM public.paper_capital_model_schema','MARKER_ROW'],
    ['marker check constraint dropped',M+'DROP CONSTRAINT paper_capital_model_schema_version_check','TABLE_DEFINITION:paper_capital_model_schema:CONSTRAINTS'],
    ['marker table renamed',M+'RENAME TO pcm_renamed','TABLE_MISSING:paper_capital_model_schema']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // The marker row can only be removed by an owner who first disables the insert-only trigger (the catalog tamper is what is judged).
      if(label==='marker row removed')await db.query(M+'DISABLE TRIGGER paper_capital_model_schema_no_change');
      await db.query(statement);return {classification:await classifyPaperCapitalModel(db),report:await inspectPaperCapitalModel(db)};
    });
    assert.equal(found.classification.state,'OTHER',label+': '+found.classification.problems.join());
    const items=[...found.classification.problems,...found.classification.missing];
    // An owner mismatch is matched by exact name: a longer name that starts with it never satisfies it.
    if(prefix.startsWith('OWNER_MISMATCH:')){
      const mismatches=items.filter(item=>item.startsWith('OWNER_MISMATCH:'));
      assert.ok(mismatches.includes(prefix),label+': '+items.join());
      if(label.includes('function'))assert.ok(!mismatches.includes('OWNER_MISMATCH:paper_capital_models'),label+': '+items.join());
    }
    else assert.ok(items.some(item=>item.startsWith(prefix)),label+': '+items.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.paper_capital_model_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectPaperCapitalModel(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:paper_capital_model_version:BODY')));
  assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED','every tamper was rolled back');
});

test('the runtime-role inspection is the shared one: privileged membership, a privilege reached without inheriting it, a column-level write grant and CREATE on public are named',async()=>{
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  const failuresOf=(setup,role,options={})=>probe(db,async()=>{await db.query(setup);return (await inspectPaperCapitalModel(db,{runtimeRole:role,requireGrants:false,...options})).failures;});
  // A clean role reports none of the shared failures.
  assert.deepEqual(await failuresOf('CREATE ROLE pcm_plain NOLOGIN','pcm_plain'),[]);
  // A member of a BYPASSRLS or superuser role, even without inheriting it, is a privileged member.
  const privileged=await failuresOf('CREATE ROLE pcm_bypass NOLOGIN BYPASSRLS; CREATE ROLE pcm_super NOLOGIN SUPERUSER; CREATE ROLE pcm_pm NOLOGIN NOINHERIT; GRANT pcm_bypass TO pcm_pm; GRANT pcm_super TO pcm_pm','pcm_pm');
  assert.ok(privileged.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:pcm_bypass')&&privileged.includes('RUNTIME_ROLE_PRIVILEGED_MEMBER:pcm_super'),privileged.join());
  // UPDATE, DELETE, TRUNCATE and TRIGGER held by a role the runtime role reaches without inheriting it (NOINHERIT) still count.
  const reached=await failuresOf(`CREATE ROLE pcm_holder NOLOGIN; GRANT UPDATE,DELETE,TRUNCATE,TRIGGER ON ${TABLE} TO pcm_holder; CREATE ROLE pcm_noinherit NOLOGIN NOINHERIT; GRANT pcm_holder TO pcm_noinherit`,'pcm_noinherit');
  for(const failure of ['RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_models:UPDATE','RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_models:DELETE','RUNTIME_ROLE_TRUNCATE_PRIVILEGE:paper_capital_models','RUNTIME_ROLE_TRIGGER_PRIVILEGE:paper_capital_models'])
    assert.ok(reached.includes(failure),failure+': '+reached.join());
  if(version>=160000){
    const viaGrant=await failuresOf(`CREATE ROLE pcm_holder2 NOLOGIN; GRANT TRUNCATE ON ${TABLE} TO pcm_holder2; CREATE ROLE pcm_member2 NOLOGIN INHERIT; GRANT pcm_holder2 TO pcm_member2 WITH INHERIT FALSE`,'pcm_member2');
    assert.ok(viaGrant.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:paper_capital_models'),viaGrant.join());
  }
  // A column-level UPDATE grant on the declaration table and a column INSERT or UPDATE on the marker are write paths has_table_privilege does not see.
  const tableColumn=await failuresOf(`CREATE ROLE pcm_tcol NOLOGIN; GRANT UPDATE (declared_by) ON ${TABLE} TO pcm_tcol`,'pcm_tcol');
  assert.ok(tableColumn.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_models:UPDATE'),tableColumn.join());
  const column=await failuresOf(`CREATE ROLE pcm_col NOLOGIN; GRANT UPDATE (version), INSERT (version) ON ${MARKER} TO pcm_col`,'pcm_col');
  for(const privilege of ['UPDATE','INSERT'])assert.ok(column.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_model_schema:'+privilege),privilege+': '+column.join());
  // Any write privilege on the marker table counts: INSERT, UPDATE, DELETE, TRUNCATE and TRIGGER.
  const marker=await failuresOf(`CREATE ROLE pcm_mk NOLOGIN; GRANT INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON ${MARKER} TO pcm_mk`,'pcm_mk');
  for(const privilege of ['INSERT','UPDATE','DELETE'])assert.ok(marker.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_model_schema:'+privilege),privilege+': '+marker.join());
  assert.ok(marker.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:paper_capital_model_schema')&&marker.includes('RUNTIME_ROLE_TRIGGER_PRIVILEGE:paper_capital_model_schema'),marker.join());
  // A column SELECT never satisfies a required table-level privilege.
  const columnOnly=await failuresOf(`CREATE ROLE pcm_colonly NOLOGIN; GRANT SELECT (owner_id), INSERT (owner_id) ON ${TABLE} TO pcm_colonly`,'pcm_colonly',{requireGrants:true});
  for(const privilege of ['SELECT','INSERT'])assert.ok(columnOnly.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:paper_capital_models:'+privilege),privilege+': '+columnOnly.join());
  // CREATE on schema public, held through a role the runtime role reaches without inheriting it.
  const create=await failuresOf('CREATE ROLE pcm_creator NOLOGIN; GRANT CREATE ON SCHEMA public TO pcm_creator; CREATE ROLE pcm_via NOLOGIN NOINHERIT; GRANT pcm_creator TO pcm_via','pcm_via');
  assert.ok(create.includes('RUNTIME_ROLE_SCHEMA_CREATE'),create.join());
  // Membership of the database owner is ownership of schema public (PostgreSQL 15 and later).
  if(version>=150000){
    const owner=(await db.query('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname=current_database()')).rows[0].o;
    const schema=await failuresOf(`CREATE ROLE pcm_dbm NOLOGIN; GRANT ${owner} TO pcm_dbm`,'pcm_dbm');
    assert.ok(schema.includes('RUNTIME_ROLE_OWNS_SCHEMA:public'),schema.join());
  }
  assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED','every probe was rolled back');
});

test('offline only: the install and the rollback need the maintenance lock, their own transaction and the base schema',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migratePaperCapitalModel(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackPaperCapitalModel(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migratePaperCapitalModel(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackPaperCapitalModel(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
  // A database without the base schema 14: refused before any write.
  const bareName='robot_pcm_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));
  await assert.rejects(migratePaperCapitalModel(bare),/Initialize\/import schema 14 offline/);
  assert.deepEqual(await extensionObjects(bare),NONE);
  await bare.migrate();
  await bare.query('DROP TABLE users CASCADE');
  await assert.rejects(migratePaperCapitalModel(bare),/Base schema required: table users is missing/);
  assert.deepEqual(await extensionObjects(bare),NONE);
});

test('a foreign or partial extension is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.paper_capital_models(x integer)');await foreign.query('INSERT INTO public.paper_capital_models VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migratePaperCapitalModel(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackPaperCapitalModel(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.paper_capital_models')).rows,[{x:7}],'the foreign row survived');
  await migratePaperCapitalModel(partial);
  await partial.query('DROP TRIGGER paper_capital_models_10_stamp ON public.paper_capital_models');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migratePaperCapitalModel(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:paper_capital_models_10_stamp/);
  await assert.rejects(rollbackPaperCapitalModel(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyPaperCapitalModel(partial)).state,'OTHER');
});

/* ---- 2. grants, insert-only guards, isolation guard, stamp ---- */

let OWNER_A;
test('grants: the repo grant script gives the runtime role SELECT and INSERT only, never UPDATE, DELETE, TRUNCATE or TRIGGER; the marker is read-only; reapply is idempotent',async()=>{
  for(const role of [roleName,updaterName,deleterName,truncaterName])await db.query(await grantScript(role));
  await db.query(`GRANT UPDATE ON TABLE ${TABLE} TO ${updaterName}`);await db.query(`GRANT DELETE ON TABLE ${TABLE} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${TABLE} TO ${truncaterName}`);
  rt=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:4}));rt2=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:4}));
  upd=track(new PostgresDatabase({connectionString:urlOf(databaseName,updaterName),max:2}));
  dl=track(new PostgresDatabase({connectionString:urlOf(databaseName,deleterName),max:2}));tr=track(new PostgresDatabase({connectionString:urlOf(databaseName,truncaterName),max:2}));
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  for(const role of [roleName,updaterName,deleterName,truncaterName])await db.query(await grantScript(role));
  await db.query(`GRANT UPDATE ON TABLE ${TABLE} TO ${updaterName}`);await db.query(`GRANT DELETE ON TABLE ${TABLE} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${TABLE} TO ${truncaterName}`);
  assert.equal(await acl(),first,'a second application of the grant script changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger
    FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  assert.deepEqual(await facts(roleName,TABLE),{owner:false,select:true,insert:true,update:false,delete:false,truncate:false,trigger:false});
  assert.deepEqual(await facts(roleName,MARKER),{owner:false,select:true,insert:false,update:false,delete:false,truncate:false,trigger:false},'the marker table is read-only');
  assert.equal((await facts(updaterName,TABLE)).update,true);assert.equal((await facts(deleterName,TABLE)).delete,true);assert.equal((await facts(truncaterName,TABLE)).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // The inspection with the runtime role passes, and names the role that broke the boundary.
  const ok=await inspectPaperCapitalModel(db,{runtimeRole:roleName});assert.equal(ok.ok,true,ok.failures.join());
  assert.ok((await inspectPaperCapitalModel(db,{runtimeRole:updaterName})).failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_models:UPDATE'));
  assert.ok((await inspectPaperCapitalModel(db,{runtimeRole:deleterName})).failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_models:DELETE'));
  assert.ok((await inspectPaperCapitalModel(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:paper_capital_models'));
  assert.ok((await inspectPaperCapitalModel(db,{runtimeRole:'robot_test'})).failures.some(item=>item.startsWith('RUNTIME_ROLE_SUPERUSER')||item.startsWith('RUNTIME_ROLE_OWNS:')));
  // Membership of the owning role counts as ownership, for the tables and for each function (all rolled back).
  const memberOf=await probe(db,async()=>{
    await db.query('CREATE ROLE pcm_member NOLOGIN');await db.query('GRANT '+(await db.query('SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=$1::regclass',[TABLE])).rows[0].o+' TO pcm_member');
    return inspectPaperCapitalModel(db,{runtimeRole:'pcm_member'});
  });
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS:paper_capital_models')&&memberOf.failures.includes('RUNTIME_ROLE_OWNS:paper_capital_model_schema'),memberOf.failures.join());
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS_FUNCTION:paper_capital_model_guard'),memberOf.failures.join());
  // The role cannot disable a guard, replace a function, change the replication role or touch the marker.
  await refused(rt.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER paper_capital_models_20_guard`),DENIED);
  await refused(rt.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER ALL`),DENIED);
  await refused(rt.query(`DROP TRIGGER paper_capital_models_00_serializable ON ${TABLE}`),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.paper_capital_model_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query(`DROP TABLE ${TABLE}`),DENIED);
  await refused(rt.query(`INSERT INTO ${MARKER} VALUES(2)`),DENIED);await refused(rt.query(`UPDATE ${MARKER} SET version=1`),DENIED);await refused(rt.query(`DELETE FROM ${MARKER}`),DENIED);
  OWNER_A=await newOwner('pcm-a');
  assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED');
});

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers on the table and the marker; the replication role cannot skip a guard; no row changes',async()=>{
  await insertRaw(rt,row(OWNER_A));
  const before=await rowDigest(db);assert.equal(before.n,1);
  // layer 1 (privilege): the runtime role holds no UPDATE, DELETE or TRUNCATE
  await refused(rt.query(`UPDATE ${TABLE} SET declared_by=declared_by`),DENIED);await refused(rt.query(`DELETE FROM ${TABLE}`),DENIED);await refused(rt.query(`TRUNCATE ${TABLE}`),DENIED);
  // layer 2 (trigger): a role that holds the privilege still meets QR002
  for(const [label,statement] of [
    ['update of one column',`UPDATE ${TABLE} SET capital_model='SHARED_HYPOTHETICAL' WHERE owner_id='${OWNER_A}'`],
    ['update of every row',`UPDATE ${TABLE} SET version=version`],
    ['update to the same value',`UPDATE ${TABLE} SET currency=currency WHERE owner_id='${OWNER_A}'`],
    ['update of the key',`UPDATE ${TABLE} SET version=version+1 WHERE owner_id='${OWNER_A}'`],
    ['update of the effective date',`UPDATE ${TABLE} SET effective_from=effective_from+${DAY} WHERE owner_id='${OWNER_A}'`],
    ['update of the stamp',`UPDATE ${TABLE} SET declared_at=0 WHERE owner_id='${OWNER_A}'`]])
    await refused(upd.query(statement),QR002).catch(error=>{throw Error(label+': '+error.message);});
  await refused(upd.transaction(()=>upd.query(`MERGE INTO ${TABLE} t USING (SELECT $1::text AS id) s ON t.owner_id=s.id WHEN MATCHED THEN UPDATE SET version=version`,[OWNER_A]),serializable),QR002);
  await refused(dl.query(`DELETE FROM ${TABLE} WHERE owner_id=$1`,[OWNER_A]),QR002);await refused(dl.query(`DELETE FROM ${TABLE}`),QR002);
  await refused(dl.transaction(()=>dl.query(`MERGE INTO ${TABLE} t USING (SELECT $1::text AS id) s ON t.owner_id=s.id WHEN MATCHED THEN DELETE`,[OWNER_A]),serializable),QR002);
  await refused(tr.query(`TRUNCATE ${TABLE}`),QR002);await refused(tr.query(`TRUNCATE TABLE ${TABLE} RESTART IDENTITY`),QR002);
  // the table owner and a superuser meet it too, also with session_replication_role=replica (the triggers are ENABLE ALWAYS); the same on the marker
  for(const statement of [`UPDATE ${TABLE} SET version=version`,`DELETE FROM ${TABLE}`,`TRUNCATE ${TABLE}`,`TRUNCATE ${TABLE},${MARKER}`,
    `UPDATE ${MARKER} SET version=version`,`UPDATE ${MARKER} SET version=2`,`DELETE FROM ${MARKER}`,`TRUNCATE ${MARKER}`]){
    await refused(db.query(statement),QR002).catch(error=>{throw Error(statement+': '+error.message);});
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(statement);}),QR002);
  }
  // an INSERT under the replica role still meets the isolation guard
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(insertSql,valuesOf(row(OWNER_A,{version:2})));}),QR003);
  assert.deepEqual(await rowDigest(db),before,'no refusal changed a row');
  assert.deepEqual((await db.query(`SELECT version FROM ${MARKER}`)).rows,[{version:1}],'the marker row is unchanged');
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await upd.query(`UPDATE ${TABLE} SET version=1 WHERE owner_id='no-such-owner'`)).rowCount,0);
  assert.deepEqual(await rowDigest(db),before);
  assert.deepEqual((await guardRows(db)).map(item=>item.tgenabled),Array(7).fill('A'));
});

test('isolation guard: an INSERT below SERIALIZABLE is refused (QR003); SERIALIZABLE commits; a TEMP function cannot fake the setting',async()=>{
  const O=await newOwner('pcm-iso');
  const before=await rowDigest(db);
  await refused(rt.query(insertSql,valuesOf(row(O))),QR003);                                    // autocommit READ COMMITTED
  await refused(insertRaw(rt,row(O),'READ COMMITTED'),QR003);
  await refused(insertRaw(rt,row(O),'REPEATABLE READ'),QR003);
  await refused(insertRaw(db,row(O),'READ COMMITTED'),QR003);                                   // the owner meets it too
  await refused(db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');await db.query(insertSql,valuesOf(row(O)));}),'25006');
  assert.deepEqual(await rowDigest(db),before,'the refused inserts wrote nothing');
  // QR003 fires before the stamp and the guard: a row that would also break a rule meets QR003 first
  await refused(insertRaw(rt,row(O,{version:9,declared_by:'someone'}),'READ COMMITTED'),QR003);
  // a serializable read-write transaction commits
  await insertRaw(rt,row(O));
  await rt.transaction(()=>rt.query(insertSql,valuesOf(row(O,{version:2}))),serializable);
  assert.equal((await rowDigest(db)).n,before.n+2);
  // a session TEMP function named like the settings reader never replaces the schema-qualified call inside the guard
  await refused(rt.transaction(async()=>{
    await rt.query("CREATE FUNCTION pg_temp.current_setting(text) RETURNS text LANGUAGE sql AS $$ SELECT 'serializable'::text $$");
    await rt.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await rt.query(insertSql,valuesOf(row(O,{version:3})));
  },{isolation:'READ COMMITTED'}),QR003);
  assert.equal((await rowDigest(db)).n,before.n+2);
});

test('stamp: declared_at is overwritten by the database clock, whatever the client sends or omits',async()=>{
  const O=await newOwner('pcm-stamp');
  const bracket=async fn=>{
    const low=Number((await db.query('SELECT public.paper_capital_model_now_ms() t')).rows[0].t);
    await fn();
    const high=Number((await db.query('SELECT public.paper_capital_model_now_ms() t')).rows[0].t);
    return [low,high];
  };
  const stored=async version=>Number((await db.query(`SELECT declared_at FROM ${TABLE} WHERE owner_id=$1 AND currency='USDT' AND version=$2`,[O,version])).rows[0].declared_at);
  let [low,high]=await bracket(()=>insertRaw(rt,row(O,{declared_at:1})));
  let value=await stored(1);assert.ok(value>=low&&value<=high&&value>1000000000000,'a past client value was replaced: '+value+' in ['+low+','+high+']');
  [low,high]=await bracket(()=>insertRaw(rt,row(O,{version:2,declared_at:253402300799999})));
  value=await stored(2);assert.ok(value>=low&&value<=high,'a far-future client value was replaced: '+value);
  [low,high]=await bracket(()=>insertRaw(rt,row(O,{version:3,declared_at:null})));
  value=await stored(3);assert.ok(value>=low&&value<=high,'a NULL client value was replaced: '+value);
  [low,high]=await bracket(()=>rt.transaction(()=>rt.query(`INSERT INTO ${TABLE}(owner_id,currency,version,capital_model,bot_set,effective_from,declared_by) VALUES($1,'USDT',4,'INDEPENDENT_ACCOUNTS',$2::jsonb,$3,$1)`,
    [O,JSON.stringify([O]),nextMidnight()]),serializable));
  value=await stored(4);assert.ok(value>=low&&value<=high,'an omitted column was filled: '+value);
  const all=(await db.query(`SELECT declared_at FROM ${TABLE} WHERE owner_id=$1 ORDER BY version`,[O])).rows.map(item=>item.declared_at);
  assert.deepEqual([...all].sort((a,b)=>a-b),all,'the stamps never go backwards');
});

/* ---- 3. QR004 rule families ---- */

test('owner rules: a child Bot, an unknown account and a declared_by other than the owner are refused (QR004, paper_capital_models_owner); a main account is accepted',async()=>{
  const O=await newOwner('pcm-own'),other=await newOwner('pcm-own-other'),bot=await addBot(O);
  const before=await rowDigest(db);
  await guardRefused(insertRaw(rt,row(bot,{bot_set:[bot]})),'paper_capital_models_owner',/child Bot cannot be the owner/);
  await guardRefused(insertRaw(rt,row(bot,{bot_set:[O,bot].sort(),declared_by:O})),'paper_capital_models_owner',/child Bot cannot be the owner/);
  await guardRefused(insertRaw(rt,row('no-such-account',{bot_set:['no-such-account'],declared_by:'no-such-account'})),'paper_capital_models_owner',/existing main account/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:(await fullSet(O)),declared_by:other})),'paper_capital_models_owner',/declared_by must be the owner/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:(await fullSet(O)),declared_by:bot})),'paper_capital_models_owner',/declared_by must be the owner/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:(await fullSet(O)),declared_by:'no-such-account'})),'paper_capital_models_owner',/declared_by must be the owner/);
  assert.deepEqual(await rowDigest(db),before,'no refused row was stored');
  await insertRaw(rt,row(O,{bot_set:await fullSet(O)}));
  assert.equal((await rowDigest(db)).n,before.n+1);
  // a NULL in a required column is left to NOT NULL (the guard does not mask it)
  for(const column of ['owner_id','currency','version','capital_model','bot_set','effective_from','declared_by']){
    const value=row(await newOwner('pcm-null'),{[column]:null});
    await refused(insertRaw(rt,value),'23502').catch(error=>{throw Error(column+': '+error.message);});
  }
});

test('version rules: the first row is 1, each next is the highest plus 1 for the owner and currency; a gap, a reuse, 0 and a negative are refused (QR004, paper_capital_models_version); 1000 is the cap',async()=>{
  const O=await newOwner('pcm-ver');
  const before=await rowDigest(db);
  await guardRefused(insertRaw(rt,row(O,{version:2})),'paper_capital_models_version');
  await guardRefused(insertRaw(rt,row(O,{version:0})),'paper_capital_models_version');
  await guardRefused(insertRaw(rt,row(O,{version:-1})),'paper_capital_models_version');
  await guardRefused(insertRaw(rt,row(O,{version:1000})),'paper_capital_models_version');
  assert.deepEqual(await rowDigest(db),before);
  await insertRaw(rt,row(O,{version:1}));
  await guardRefused(insertRaw(rt,row(O,{version:1})),'paper_capital_models_version');                // a reuse never reaches the primary key
  await guardRefused(insertRaw(rt,row(O,{version:3})),'paper_capital_models_version');
  await insertRaw(rt,row(O,{version:2,capital_model:'SHARED_HYPOTHETICAL'}));
  await guardRefused(insertRaw(rt,row(O,{version:2})),'paper_capital_models_version');
  // the count is per currency and per owner
  await insertRaw(rt,row(O,{currency:'THB',version:1}));
  await guardRefused(insertRaw(rt,row(O,{currency:'THB',version:3})),'paper_capital_models_version');
  await insertRaw(rt,row(O,{version:3}));
  await insertRaw(rt,row(await newOwner('pcm-ver-other'),{version:1}));
  assert.deepEqual((await db.query(`SELECT currency,version,capital_model FROM ${TABLE} WHERE owner_id=$1 ORDER BY currency,version`,[O])).rows,
    [{currency:'THB',version:1,capital_model:'INDEPENDENT_ACCOUNTS'},{currency:'USDT',version:1,capital_model:'INDEPENDENT_ACCOUNTS'},
      {currency:'USDT',version:2,capital_model:'SHARED_HYPOTHETICAL'},{currency:'USDT',version:3,capital_model:'INDEPENDENT_ACCOUNTS'}]);
  // the cap: version 1000 is accepted, 1001 is a CHECK failure (not a guard failure), and after it the next number is still 1001
  const C=await newOwner('pcm-cap'),effective=nextMidnight();
  await rt.transaction(()=>rt.query(`DO $$ BEGIN FOR i IN 1..1000 LOOP INSERT INTO public.paper_capital_models(owner_id,currency,version,capital_model,bot_set,effective_from,declared_at,declared_by)
    VALUES('${C}','USDT',i,'INDEPENDENT_ACCOUNTS','["${C}"]'::jsonb,${effective},0,'${C}'); END LOOP; END $$`),serializable);
  assert.equal((await db.query(`SELECT max(version)::int v,count(*)::int n FROM ${TABLE} WHERE owner_id=$1`,[C])).rows[0].n,1000);
  await checkRefused(insertRaw(rt,row(C,{version:1001})),'paper_capital_models_version_check');
  await guardRefused(insertRaw(rt,row(C,{version:1002})),'paper_capital_models_version');
  await guardRefused(insertRaw(rt,row(C,{version:1000})),'paper_capital_models_version');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${TABLE} WHERE owner_id=$1`,[C])).rows[0].n,1000);
});

test('bot_set rules: 1 to 5 strictly ascending string ids, all in the owner set and equal to the full owner set; each other shape is refused (QR004, paper_capital_models_bot_set)',async()=>{
  const GUARD='paper_capital_models_bot_set';
  const O=await newOwner('pcm-set'),foreign=await newOwner('pcm-set-foreign'),foreignBot=await addBot(foreign);
  const before=await rowDigest(db);
  // border low: an owner with no Bot declares itself alone; an empty array is just below it
  await guardRefused(insertRaw(rt,row(O,{bot_set:[]})),GUARD,/array of 1 to 5/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:'"x"'})),GUARD,/array of 1 to 5/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:'{"a":1}'})),GUARD,/array of 1 to 5/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:'7'})),GUARD,/array of 1 to 5/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:'null'})),GUARD,/array of 1 to 5/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:[7]})),GUARD,/must be a string/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:[null]})),GUARD,/must be a string/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:[[O]]})),GUARD,/must be a string/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:[foreign]})),GUARD,/belong to the owner set/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:[foreignBot]})),GUARD,/belong to the owner set/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:['no-such-account']})),GUARD,/belong to the owner set/);
  await guardRefused(insertRaw(rt,row(O,{bot_set:[O,O]})),GUARD,/strictly ascending/);
  assert.deepEqual(await rowDigest(db),before);
  await insertRaw(rt,row(O,{bot_set:[O]}));
  // an owner with two Bots: only the complete set, in ascending order, is accepted
  const bots=[await addBot(O),await addBot(O,randomUUID(),3)],all=[O,...bots].sort();
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:[O]})),GUARD,/full owner set/);              // the old set is now a subset
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:all.slice(0,2)})),GUARD,/full owner set/);
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:all.slice(1)})),GUARD,/full owner set/);
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:[...all].reverse()})),GUARD,/strictly ascending/);
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:[all[1],all[0],all[2]]})),GUARD,/strictly ascending/);
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:[...all,all[2]]})),GUARD,/strictly ascending/);
  await guardRefused(insertRaw(rt,row(O,{version:2,bot_set:[...all,foreignBot].sort()})),GUARD,/belong to the owner set/);
  await insertRaw(rt,row(O,{version:2,bot_set:all}));
  // border high: an owner with four Bots (five accounts) is accepted; a sixth account makes the set longer than 5 and refused
  const P=await newOwner('pcm-set-five'),fiveBots=[];
  for(let slot=2;slot<=5;slot++)fiveBots.push(await addBot(P,randomUUID(),slot));
  const five=[P,...fiveBots].sort();
  await insertRaw(rt,row(P,{bot_set:five}));
  assert.equal((await db.query(`SELECT jsonb_array_length(bot_set)::int n FROM ${TABLE} WHERE owner_id=$1`,[P])).rows[0].n,5);
  // the base schema allows at most five accounts per owner (index idx_bot_slot), so a sixth account exists only in a rolled-back owner session without that index
  const withSixth=fn=>probe(db,async()=>{
    await db.query('DROP INDEX public.idx_bot_slot');await addBot(P,randomUUID(),2);
    const six=await fullSet(P);assert.equal(six.length,6);
    await fn(six);
  },'SERIALIZABLE');
  await withSixth(six=>guardRefused(db.query(insertSql,valuesOf(row(P,{version:2,bot_set:six}))),GUARD,/array of 1 to 5/));
  await withSixth(()=>guardRefused(db.query(insertSql,valuesOf(row(P,{version:2,bot_set:five}))),GUARD,/full owner set/));
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${TABLE} WHERE owner_id=$1`,[P])).rows[0].n,1);
  // byte order, not locale order: an upper-case id sorts before a lower-case one whatever the database collation
  const stem=randomUUID(),ordered=await newOwnerWithId('c-'+stem),capital=await addBot(ordered,'B-'+stem),small=await addBot(ordered,'a-'+stem,3);
  await guardRefused(insertRaw(rt,row(ordered,{bot_set:[small,capital,ordered]})),GUARD,/strictly ascending/);
  await guardRefused(insertRaw(rt,row(ordered,{bot_set:[capital,ordered,small]})),GUARD,/strictly ascending/);
  await insertRaw(rt,row(ordered,{bot_set:[capital,small,ordered]}));
  assert.deepEqual((await db.query(`SELECT bot_set FROM ${TABLE} WHERE owner_id=$1`,[ordered])).rows[0].bot_set,['B-'+stem,'a-'+stem,'c-'+stem]);
});

/** A main account with a chosen id (the guard compares ids byte by byte). */
async function newOwnerWithId(id){
  await db.query(`INSERT INTO users(id,email,password_hash,role,status,created_at) VALUES($1,$2,'unused-fixture-hash','USER','ACTIVE',$3)`,[id,id+'@example.test',Date.now()]);
  return id;
}

test('table rules: the CHECKs and NOT NULL refuse what the guard leaves to them; with the guard and the stamp disabled in a rolled-back owner session every CHECK and key is reached',async()=>{
  const O=await newOwner('pcm-chk'),before=await rowDigest(db);
  // reachable without disabling anything: an effective_from that is not a UTC midnight but is inside the clock window
  const midnight=nextMidnight();
  await checkRefused(insertRaw(rt,row(O,{effective_from:midnight+1})),'paper_capital_models_effective_from_check');
  await checkRefused(insertRaw(rt,row(O,{effective_from:midnight-1})),'paper_capital_models_effective_from_check');
  await checkRefused(insertRaw(rt,row(O,{currency:'EUR'})),'paper_capital_models_currency_check');
  await checkRefused(insertRaw(rt,row(O,{currency:'usdt'})),'paper_capital_models_currency_check');
  await checkRefused(insertRaw(rt,row(O,{capital_model:'POOLED'})),'paper_capital_models_capital_model_check');
  await checkRefused(insertRaw(rt,row(O,{capital_model:'independent_accounts'})),'paper_capital_models_capital_model_check');
  assert.deepEqual(await rowDigest(db),before);
  // THB and both capital models are accepted
  await insertRaw(rt,row(O,{currency:'THB'}));await insertRaw(rt,row(O,{version:2,currency:'THB',capital_model:'SHARED_HYPOTHETICAL'}));
  // with the guard and the stamp disabled (the owner may; a rolled-back probe), the CHECKs and the foreign keys are what remain
  const disabled=(over,isolation='SERIALIZABLE')=>probe(db,async()=>{
    await db.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER paper_capital_models_10_stamp`);await db.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER paper_capital_models_20_guard`);
    await db.query(insertSql,valuesOf(row(O,{currency:'USDT',...over})));
  },isolation);
  await disabled({});                                                                                    // sanity: a valid row passes with them disabled
  for(const [label,over,constraint] of [
    ['version 0',{version:0},'paper_capital_models_version_check'],['version negative',{version:-5},'paper_capital_models_version_check'],
    ['version 1001',{version:1001},'paper_capital_models_version_check'],
    ['bot_set a string',{bot_set:'"x"'},'paper_capital_models_bot_set_check'],['bot_set an object',{bot_set:'{"a":1}'},'paper_capital_models_bot_set_check'],
    ['bot_set empty',{bot_set:[]},'paper_capital_models_bot_set_check'],['bot_set six long',{bot_set:['a','b','c','d','e','f']},'paper_capital_models_bot_set_check'],
    ['effective_from negative',{effective_from:-DAY},'paper_capital_models_effective_from_check'],
    ['effective_from beyond year 10000',{effective_from:253402300800000},'paper_capital_models_effective_from_check'],
    ['effective_from not a midnight',{effective_from:DAY+1},'paper_capital_models_effective_from_check'],
    ['declared_at negative',{declared_at:-1},'paper_capital_models_declared_at_check'],
    ['declared_at beyond year 9999',{declared_at:253402300800000},'paper_capital_models_declared_at_check']])
    await checkRefused(disabled(over),constraint).catch(error=>{throw Error(label+': '+error.message);});
  // border values that are valid
  await disabled({version:1000});await disabled({bot_set:['a','b','c','d','e']});await disabled({effective_from:0,declared_at:0});
  await disabled({effective_from:253402214400000,declared_at:253402300799999});
  // foreign keys: an unknown owner and an unknown declared_by
  await checkRefused(disabled({owner_id:'no-such-account',bot_set:['no-such-account'],declared_by:O}),'paper_capital_models_owner_id_fkey','23503');
  await checkRefused(disabled({declared_by:'no-such-account'}),'paper_capital_models_declared_by_fkey','23503');
  // the primary key: a reused version meets the key when the guard is off
  await checkRefused(probe(db,async()=>{
    await db.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER paper_capital_models_20_guard`);
    await db.query(insertSql,valuesOf(row(O,{version:1,currency:'THB'})));
  },'SERIALIZABLE'),'paper_capital_models_pkey','23505');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${TABLE} WHERE owner_id=$1`,[O])).rows[0].n,2,'only the two committed rows remain');
  assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED');
});

test('a session TEMP table named like users or the declaration table fools neither the guard nor the stamp',async()=>{
  const O=await newOwner('pcm-shadow'),bot=await addBot(O),other=await newOwner('pcm-shadow-other');
  const set=await fullSet(O);
  // A TEMP users table that lists the Bot as a main account and hides the owner's Bot, and a TEMP declaration table that already holds a version 1.
  const shadow=async()=>{
    await rt.query('CREATE TEMP TABLE users(id text,parent_user_id text) ON COMMIT DROP');
    await rt.query(`INSERT INTO pg_temp.users VALUES('${bot}',NULL),('${O}',NULL)`);
    await rt.query('CREATE TEMP TABLE paper_capital_models(LIKE public.paper_capital_models INCLUDING DEFAULTS) ON COMMIT DROP');
    await rt.query(`INSERT INTO pg_temp.paper_capital_models VALUES('${O}','USDT',1,'INDEPENDENT_ACCOUNTS','["${O}"]',${nextMidnight()},1,'${O}')`);
    await rt.query('SET LOCAL search_path = pg_temp, public');
  };
  // the real users table decides: the Bot is a child, so it cannot own a declaration, and the owner set has two ids
  await guardRefused(rt.transaction(async()=>{await shadow();await rt.query(insertSql.replace(TABLE,'public.paper_capital_models'),valuesOf(row(bot,{bot_set:[bot]})));},serializable),
    'paper_capital_models_owner',/child Bot cannot be the owner/);
  await guardRefused(rt.transaction(async()=>{await shadow();await rt.query(insertSql,valuesOf(row(O,{bot_set:[O]})));},serializable),
    'paper_capital_models_bot_set',/full owner set/);
  // the real declaration table decides: it has no version 1 for the owner, so version 1 is accepted and version 2 is refused
  await guardRefused(rt.transaction(async()=>{await shadow();await rt.query(insertSql,valuesOf(row(O,{version:2,bot_set:set})));},serializable),'paper_capital_models_version');
  await rt.transaction(async()=>{await shadow();await rt.query(insertSql,valuesOf(row(O,{bot_set:set})));
    assert.equal((await rt.query('SELECT count(*)::int n FROM pg_temp.paper_capital_models')).rows[0].n,1,'the TEMP table kept only its own row');},serializable);
  assert.deepEqual((await db.query(`SELECT version FROM ${TABLE} WHERE owner_id=$1`,[O])).rows,[{version:1}]);
  // the insert-only triggers still fire for the real table whatever search_path says
  await refused(upd.transaction(async()=>{
    await upd.query('CREATE TEMP TABLE paper_capital_models(x integer) ON COMMIT DROP');
    await upd.query('SET LOCAL search_path = pg_temp, public');
    await upd.query(`UPDATE ${TABLE} SET version=version WHERE owner_id=$1`,[O]);
  },serializable),QR002);
  // a TEMP function that would replace the clock never replaces the schema-qualified stamp
  const stamped=await rt.transaction(async()=>{
    await rt.query('CREATE FUNCTION pg_temp.paper_capital_model_now_ms() RETURNS bigint LANGUAGE sql AS $$ SELECT 5::bigint $$');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query(insertSql,valuesOf(row(other)));
    return Number((await rt.query(`SELECT declared_at FROM ${TABLE} WHERE owner_id=$1`,[other])).rows[0].declared_at);
  },serializable);
  assert.ok(stamped>1000000000000,'the stamp is the database clock: '+stamped);
  assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED');
});

/* ---- 4. clock rules with a controlled clock ---- */

test('clock rules: effective_from is not before the stamp, at most one day after it, never before the previous version; the stamp never goes backwards (QR004, paper_capital_models_clock)',async()=>{
  const clockName=await clone('clock'),clockDb=track(new PostgresDatabase({connectionString:urlOf(clockName),max:3})),clockStore=new Store(clockDb);
  await migratePaperCapitalModel(clockDb);
  // only in this throwaway database the clock function reads a session setting, so each border can be hit exactly
  await clockDb.query("CREATE OR REPLACE FUNCTION public.paper_capital_model_now_ms() RETURNS bigint LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT pg_catalog.current_setting('pcm.now_ms')::bigint $$");
  const M=Date.UTC(2026,9,21);assert.equal(M%DAY,0);
  const at=(ms,value)=>clockDb.transaction(async()=>{
    await clockDb.query("SELECT pg_catalog.set_config('pcm.now_ms',$1,true)",[String(ms)]);
    await clockDb.query(insertSql,valuesOf(value));
  },serializable);
  const stored=async owner=>(await clockDb.query('SELECT version,effective_from,declared_at FROM public.paper_capital_models WHERE owner_id=$1 ORDER BY version',[owner])).rows;
  const fresh=async label=>{const owner=await newOwner('pcm-clock-'+label,clockStore);return owner;};
  const BEFORE=/before the database stamp/,AFTER=/at most one day after/,PREVIOUS=/before the previous version\b(?! stamp)/,STAMP=/stamp cannot be before the previous version stamp/;
  // lower border: effective_from equal to the stamp is accepted, one millisecond later stamp is refused
  let owner=await fresh('low');
  await at(M,row(owner,{effective_from:M}));
  assert.deepEqual(await stored(owner),[{version:1,effective_from:M,declared_at:M}],'the stamp is the clock reading');
  owner=await fresh('low-past');
  await guardRefused(at(M+1,row(owner,{effective_from:M})),'paper_capital_models_clock',BEFORE);
  await guardRefused(at(M+DAY,row(owner,{effective_from:M})),'paper_capital_models_clock',BEFORE);
  assert.deepEqual(await stored(owner),[]);
  // upper border: effective_from exactly one day after the stamp is accepted, one millisecond more is refused
  owner=await fresh('high');
  await at(M,row(owner,{effective_from:M+DAY}));
  assert.deepEqual(await stored(owner),[{version:1,effective_from:M+DAY,declared_at:M}]);
  owner=await fresh('high-past');
  await guardRefused(at(M-1,row(owner,{effective_from:M+DAY})),'paper_capital_models_clock',AFTER);
  await guardRefused(at(M-DAY,row(owner,{effective_from:M+DAY})),'paper_capital_models_clock',AFTER);
  await guardRefused(at(M,row(owner,{effective_from:M+2*DAY})),'paper_capital_models_clock',AFTER);
  // a stamp inside the day: the next midnight is accepted, the one after is not
  await at(M+5*3600000,row(owner,{effective_from:M+DAY}));
  assert.deepEqual((await stored(owner)).map(item=>[item.version,item.effective_from,item.declared_at]),[[1,M+DAY,M+5*3600000]]);
  owner=await fresh('inside');
  await guardRefused(at(M+5*3600000,row(owner,{effective_from:M+2*DAY})),'paper_capital_models_clock',AFTER);
  // a time that is not a midnight is the CHECK, not the guard, when it lies in the window
  await checkRefused(at(M+5,row(owner,{effective_from:M+10})),'paper_capital_models_effective_from_check');
  // previous-version borders: effective_from equal to the previous is accepted, one day earlier is refused
  owner=await fresh('prev');
  await at(M,row(owner,{effective_from:M+DAY}));
  await at(M,row(owner,{version:2,effective_from:M+DAY}));                                              // equal effective_from and equal stamp: both borders
  await guardRefused(at(M,row(owner,{version:3,effective_from:M})),'paper_capital_models_clock',PREVIOUS);
  await at(M+1,row(owner,{version:3,effective_from:M+DAY}));                                           // a later stamp, equal effective_from
  await at(M+DAY,row(owner,{version:4,effective_from:M+2*DAY}));                                       // moving forward
  await guardRefused(at(M+DAY,row(owner,{version:5,effective_from:M+DAY})),'paper_capital_models_clock',PREVIOUS);
  assert.deepEqual((await stored(owner)).map(item=>item.version),[1,2,3,4]);
  // the stamp border: a stamp equal to the previous is accepted, one millisecond earlier is refused (effective_from kept legal)
  owner=await fresh('stamp');
  await at(M,row(owner,{effective_from:M}));
  await guardRefused(at(M-1,row(owner,{version:2,effective_from:M})),'paper_capital_models_clock',STAMP);
  await at(M,row(owner,{version:2,effective_from:M}));
  await guardRefused(at(M-DAY,row(owner,{version:3,effective_from:M})),'paper_capital_models_clock',STAMP);
  await at(M,row(owner,{version:3,effective_from:M}));
  assert.deepEqual((await stored(owner)).map(item=>item.version),[1,2,3]);
  // the clock rules are per owner and currency: another currency of the same owner starts fresh
  await at(M-DAY,row(owner,{currency:'THB',effective_from:M-DAY}));
  assert.deepEqual((await clockDb.query("SELECT version FROM public.paper_capital_models WHERE owner_id=$1 AND currency='THB'",[owner])).rows,[{version:1}]);
});

/* ---- 5. concurrency ---- */

test('race: two SERIALIZABLE inserts of the same next version; PostgreSQL reports a serialization failure or a unique violation for the second, one row commits, the retry sees the next number',async t=>{
  const R=await newOwner('pcm-race');
  const insideA=gate(),releaseA=gate();
  const writerA=rt.transaction(async()=>{await rt.query(insertSql,valuesOf(row(R)));insideA.open();await releaseA.promise;},serializable);
  await insideA.promise;
  const outcomeB=rt2.transaction(()=>rt2.query(insertSql,valuesOf(row(R,{capital_model:'SHARED_HYPOTHETICAL'}))),serializable).then(()=>({ok:true}),error=>({ok:false,code:error.code,message:error.message}));
  await until(async()=>(await db.query("SELECT count(*)::int n FROM pg_locks WHERE NOT granted AND locktype='transactionid'")).rows[0].n>=1,'writer B to wait for writer A');
  releaseA.open();await writerA;
  const b=await outcomeB;
  t.diagnostic('observed for the losing writer: SQLSTATE '+b.code+' ('+b.message+')');
  assert.equal(b.ok,false);assert.ok(['40001','23505'].includes(b.code),'unexpected result of the second writer: '+b.code+' '+b.message);
  assert.deepEqual((await db.query(`SELECT version,capital_model FROM ${TABLE} WHERE owner_id=$1`,[R])).rows,[{version:1,capital_model:'INDEPENDENT_ACCOUNTS'}],'exactly the first writer committed');
  // the retry of the loser starts from a new snapshot: version 1 is now a reuse for the guard, version 2 is the next number
  await guardRefused(insertRaw(rt2,row(R,{capital_model:'SHARED_HYPOTHETICAL'})),'paper_capital_models_version');
  await insertRaw(rt2,row(R,{version:2,capital_model:'SHARED_HYPOTHETICAL'}));
  assert.deepEqual((await db.query(`SELECT version FROM ${TABLE} WHERE owner_id=$1 ORDER BY version`,[R])).rows,[{version:1},{version:2}]);
  // two different owners write at the same time: the rows never conflict as data, but SERIALIZABLE may still cancel one writer with 40001
  // (page-level predicate locks on a small primary-key index can link two owners); the application retries 40001, so each outcome is a commit or 40001
  const X=await newOwner('pcm-race-x'),Y=await newOwner('pcm-race-y');
  const settle=promise=>promise.then(()=>({ok:true}),error=>({ok:false,code:error.code}));
  const both=await Promise.all([settle(insertRaw(rt,row(X))),settle(insertRaw(rt2,row(Y)))]);
  t.diagnostic('two owners at once: '+both.map(item=>item.ok?'commit':item.code).join(', '));
  assert.ok(both.every(item=>item.ok||item.code==='40001'),JSON.stringify(both));
  if(!both[0].ok)await insertRaw(rt,row(X));
  if(!both[1].ok)await insertRaw(rt2,row(Y));
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${TABLE} WHERE owner_id=ANY($1)`,[[X,Y]])).rows[0].n,2);
});

/* ---- 6. the CLI ---- */

test('the CLI: install, second install, --inspect exit codes, --runtime-role, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=track(new PostgresDatabase({connectionString:cliUrl,max:2}));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  // ABSENT is a known state: exit 0, nothing written
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  // a bad runtime role in the ABSENT state still fails
  const badRole=await inspect(['--runtime-role=no_such_role_pcm']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  // install, then a second install
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/Paper capital model ready: paper-capital-model-v1; state=INSTALLED; previous state=ABSENT; guards=7/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  // INSTALLED without a runtime role passes; with a role that has no grant yet it fails on the missing privileges; after the grant script it passes
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  const ungranted=await inspect(['--runtime-role='+roleName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:paper_capital_models:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(roleName));
  const granted=await inspect(['--runtime-role='+roleName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.map(item=>[item.table,item.select,item.insert,item.update,item.delete,item.truncate,item.trigger]),
    [['paper_capital_model_schema',true,false,false,false,false,false],['paper_capital_models',true,true,false,false,false,false]]);
  // a runtime role that holds UPDATE exits 1 and names the privilege
  await cliDb.query(`GRANT UPDATE ON public.paper_capital_models TO ${roleName}`);
  const updatable=await inspect(['--runtime-role='+roleName]);assert.equal(updatable.code,1);assert.ok(updatable.report.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:paper_capital_models:UPDATE'));
  await cliDb.query(`REVOKE UPDATE ON public.paper_capital_models FROM ${roleName}`);
  assert.equal((await inspect(['--runtime-role='+roleName])).code,0);
  // --inspect is a READ ONLY transaction: it writes nothing even with the tool's own session
  const settledDigest=await catalogDigest(cliDb);await inspect(['--runtime-role='+roleName]);assert.deepEqual(await catalogDigest(cliDb),settledDigest);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.paper_capital_models DISABLE TRIGGER paper_capital_models_20_guard');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.paper_capital_models ENABLE ALWAYS TRIGGER paper_capital_models_20_guard');
  assert.equal((await inspect()).code,0);
  // usage errors
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--bogus'],['--runtime-role=Bad-Name']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  // rollback of the empty table, then a second rollback (no-op) and a re-install
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await extensionObjects(cliDb),NONE);
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
  // with a declaration row the CLI rollback exits nonzero and changes nothing
  const owner=await newOwner('pcm-cli',new Store(cliDb));
  await cliDb.transaction(()=>cliDb.query(insertSql,valuesOf(row(owner))),serializable);
  const held=await catalogDigest(cliDb);
  const refusedRollback=await cli(['--rollback'],cliUrl);assert.notEqual(refusedRollback.code,0);assert.match(refusedRollback.stderr,/rollback refused; 1 declaration row\(s\) exist \(no change made\)/);
  assert.deepEqual(await catalogDigest(cliDb),held);
});

/* ---- 7. rollback ---- */

test('rollback: an empty install is dropped completely; a table that holds a row is refused and unchanged; the rollback SQL refuses a row by itself',async()=>{
  const name=await clone('rollback');
  const target=track(new PostgresDatabase({connectionString:urlOf(name),max:3}));
  const owner=await newOwner('pcm-rb',new Store(target));
  const baseline=await catalogDigest(target);
  await migratePaperCapitalModel(target);
  const rolled=await rollbackPaperCapitalModel(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await extensionObjects(target),NONE);
  assert.equal((await catalogDigest(target)).n,baseline.n,'the catalog is back to the baseline object count');
  assert.deepEqual(await rollbackPaperCapitalModel(target),{rolled_back:true,previous_state:'ABSENT'});
  await migratePaperCapitalModel(target);
  await target.transaction(()=>target.query(insertSql,valuesOf(row(owner))),serializable);
  const held=await rowDigest(target),objects=await catalogDigest(target);
  await assert.rejects(rollbackPaperCapitalModel(target),/rollback refused; 1 declaration row\(s\) exist \(no change made\)/);
  assert.deepEqual(await rowDigest(target),held,'the declaration is still there');assert.deepEqual(await catalogDigest(target),objects,'nothing else changed');
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
  // the rollback SQL file refuses by itself with a row (run in a rolled-back owner transaction); nothing is dropped
  const rollbackSql=await sqlText('paper-capital-model-rollback.sql');
  await assert.rejects(probe(target,()=>target.query(rollbackSql)),/declaration rows exist/);
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
  // a writer that holds a row in an open transaction blocks the rollback from counting past it (ACCESS EXCLUSIVE), then the count sees it
  const insert=gate(),finish=gate();
  const writer=target.transaction(async()=>{await target.query(insertSql,valuesOf(row(owner,{version:2})));insert.open();await finish.promise;},serializable);
  await insert.promise;
  const waiting=rollbackPaperCapitalModel(track(new PostgresDatabase({connectionString:urlOf(name),max:2})));
  const settled=waiting.then(()=>'DROPPED',error=>error.message);
  finish.open();await writer;
  assert.match(await settled,/rollback refused; 2 declaration row\(s\) exist \(no change made\)/);
  assert.equal((await rowDigest(target)).n,2);
});

/* ---- 8. rollback race: zero committed rows, one writer holds an uncommitted version 1 ---- */

/** True while some session waits for an ACCESS EXCLUSIVE lock on the declaration table of target's database. */
const exclusiveLockWaiting=target=>async()=>(await target.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype='relation' AND relation='public.paper_capital_models'::regclass
  AND mode='AccessExclusiveLock' AND NOT granted`)).rows[0].n>0;

/** Installs on a fresh clone, starts a writer that holds an uncommitted version 1, and returns the pieces the race tests need. */
async function raceSetup(label){
  const name=await clone(label);
  const target=track(new PostgresDatabase({connectionString:urlOf(name),max:3}));
  const owner=await newOwner('pcm-'+label,new Store(target));
  await migratePaperCapitalModel(target);
  assert.equal((await rowDigest(target)).n,0,'zero committed declarations');
  const inserted=gate(),finish=gate();
  const writer=target.transaction(async()=>{await target.query(insertSql,valuesOf(row(owner)));inserted.open();await finish.promise;},serializable);
  await inserted.promise;
  return {name,target,writer,finish};
}

test('rollback race (tool): the rollback waits on the ACCESS EXCLUSIVE lock behind an uncommitted version 1, then refuses with one row',async()=>{
  const {name,target,writer,finish}=await raceSetup('rbrace');
  const rolling=track(new PostgresDatabase({connectionString:urlOf(name),max:2}));
  const settled=rollbackPaperCapitalModel(rolling).then(()=>'DROPPED',error=>error.message);
  try{
    await until(exclusiveLockWaiting(target),'the rollback waits for the ACCESS EXCLUSIVE lock');
  }finally{finish.open();}
  await writer;
  assert.match(await settled,/rollback refused; 1 declaration row\(s\) exist \(no change made\)/);
  assert.equal((await rowDigest(target)).n,1,'the declaration survived');
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
});

test('rollback race (SQL file in autocommit): the file waits on the ACCESS EXCLUSIVE lock behind an uncommitted version 1, then refuses and drops nothing',async()=>{
  const {name,target,writer,finish}=await raceSetup('rbracesql');
  const rollbackSql=await sqlText('paper-capital-model-rollback.sql');
  const session=track(new PostgresDatabase({connectionString:urlOf(name),max:2}));
  // not inside db.transaction: the file runs as one autocommit statement, the way psql -f runs it
  const settled=session.query(rollbackSql).then(()=>'DROPPED',error=>error.message);
  try{
    await until(exclusiveLockWaiting(target),'the rollback SQL waits for the ACCESS EXCLUSIVE lock');
  }finally{finish.open();}
  await writer;
  assert.match(await settled,/declaration rows exist/);
  assert.equal((await rowDigest(target)).n,1,'the declaration survived');
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
});

test('rollback SQL file: with zero rows it drops every object in autocommit, and it has no BEGIN, COMMIT or CASCADE',async()=>{
  const name=await clone('rbsqlzero');
  const target=track(new PostgresDatabase({connectionString:urlOf(name),max:2}));
  await migratePaperCapitalModel(target);
  const rollbackSql=await sqlText('paper-capital-model-rollback.sql');
  assert.ok(!/\bCASCADE\b/i.test(rollbackSql.replace(/^--.*$/gm,'')),'no CASCADE');
  assert.ok(!/^\s*(BEGIN|COMMIT)\s*;/im.test(rollbackSql),'no transaction control');
  assert.equal((await rollbackSql.match(/^DO \$\$/gm)).length,1,'one DO block');
  await target.query(rollbackSql);
  assert.deepEqual(await extensionObjects(target),NONE);
});
