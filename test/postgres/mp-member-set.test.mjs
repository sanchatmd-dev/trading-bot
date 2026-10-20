import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {MEMBER_SET_GUARDS,MEMBER_SET_MARKER,MEMBER_SET_TABLES,QR004_GUARDS,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,classifyMpMemberSet,inspectMpMemberSet,
  migrateMpMemberSet,rollbackMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {buildMemberSet,decideFreeze,memberSetFreshness} from '../../src/multi-pine/member-set.js';

// F11-01 member-set extension T1: the insert-only multi-Pine member-set tables, proven on a throwaway PostgreSQL cluster as real non-owner LOGIN roles with
// the repo grants. Every row is a LABELLED FIXTURE (fixture=true, synthetic, never a research result). Rows are insert-only, so each case that commits
// uses its own owner; guard negatives tamper with the pine rows inside a transaction that is always rolled back.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,SERIALIZATION_FAILURE='40001',DENIED='42501',CHECK_VIOLATION='23514',FK_VIOLATION='23503',UNIQUE_VIOLATION='23505';
const CLI='scripts/migrate-mp-member-set.mjs';
const MEMBER_GUARD='mp_member_set_members_guard',COMPLETE_GUARD='mp_member_sets_complete';
// The grant script the cases apply is always the repository file.
const GRANT_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const T0=1790000000000,UTC='2026-10-20T10:00:00Z';
let admin,db,rt,rt2,dl,tr,connectionString,templateName,databaseName,roleName,deleterName,truncaterName,dbOwnerRole,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every member-set writer is SERIALIZABLE (QR003 otherwise): the pools of the writers default to it for autocommit statements (a connection option)
// and their transactions default to it (ser). A case that proves a refusal opens its transaction at another level explicitly.
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantScript=async role=>(await fs.readFile(GRANT_SCRIPT,'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const refusedWith=(promise,code,message)=>assert.rejects(promise,error=>error.code===code&&message.test(error.message));
const track=pool=>{pools.push(pool);return pool;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}

/** A database built from the template (base schema 14 plus the Pine Bridge extension, no member-set tables). */
async function clone(label){
  const name='robot_mp_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  return name;
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog or rows. */
async function probe(target,fn){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();},{isolation:'SERIALIZABLE'});}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
/** Runs fn in a rolled-back SERIALIZABLE transaction, then forces the deferred checks; returns null on success or {code,constraint,message} of the first failure. */
const attempt=(target,fn)=>probe(target,async()=>{
  try{await fn();await target.query('SET CONSTRAINTS ALL IMMEDIATE');return null;}
  catch(error){return {code:error.code,constraint:error.constraint,message:error.message};}
});
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.oid||':'||c.xmin::text||':'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.oid||':'||k.xmin::text||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
const memberSetObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'mp\\_member\\_set%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'mp\\_%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'mp\\_member\\_set%') triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0},ALL={relations:12,functions:5,triggers:11};
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'mp\\_member\\_set%' ORDER BY t.tgname`)).rows;
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const ALL_TABLES=['mp_member_set_schema',...MEMBER_SET_TABLES];
const allDigests=async target=>Object.fromEntries(await Promise.all(ALL_TABLES.map(async table=>[table,await rowDigest(target,table)])));
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;

/* ---- fixtures: pine rows and S1 member sets (labelled, synthetic) ---- */

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const evidenceFor=(snapshot,snapshotHash,tag)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(MODEL),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});

/**
 * One owner (also the Bot) with COUNT connected members, each with a source revision, a DRAFT deployment and Bridge evidence, all inserted by the schema owner.
 * Returns the owner and the member specs. exit is the exit version the S1 input carries (it is no pine column).
 */
async function newWorld({count=2,exit='bridge-exit-v2',target=db,targetStore=store,split=false}={}){
  const user=await targetStore.createUser({email:'mp-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  // split: the Bot is another user than the owner, so a predicate on bot_id or a swapped owner/bot comparison cannot pass by accident.
  const bot=split?await targetStore.createUser({email:'mp-bot-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'}):user;
  const ids=Array.from({length:count},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,pine:id,version:1,sourceHash:hash('source-'+id),analysis:{effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i'+(i+1)}]},dep:'dep-'+randomUUID()}));
  for(const m of specs){
    await target.query('INSERT INTO pine_sources VALUES($1,$2,$8,1,$3,$4,$5,$6,$7)',[m.pine,user.id,m.sourceHash,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(m.analysis),T0,bot.id]);
    await target.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,m.sourceHash,'//@version=6\nindicator("x")',JSON.stringify(m.analysis),T0]);
    await target.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot.id]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:m.sourceHash,analysis:m.analysis}));
  for(const m of specs){
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital:CAPITAL,funding_cutoff:7,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection:{bridge:{atr_multiplier:2,rr:1.5},bindings:[]},market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:m.sourceHash,
      instruction_versions:{template:'fixture'},artifact_hash:hash('artifact-'+m.pine)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n);
    await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$7,$3,1,$4,$5,'DRAFT',$6)",
      [m.dep,user.id,m.pine,JSON.stringify(snapshot),snapshotHash,T0,bot.id]);
    await target.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
  }
  return {id:user.id,bot:bot.id,specs,exit,target};
}
/** The S1 input rows, read back from the database like a service would (exit_version is attached from the world: the schema has no such column). */
async function rowsOf(world){
  const t=world.target;
  const memberships=(await t.query(`SELECT m.pine_import_id,m.owner_id,m.bot_id,m.source_version,r.source_hash,m.connected,r.analysis FROM pine_memberships m
    JOIN pine_source_revisions r ON r.pine_import_id=m.pine_import_id AND r.source_version=m.source_version WHERE m.owner_id=$1 ORDER BY m.pine_import_id`,[world.id])).rows;
  const deployments=(await t.query('SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash FROM pine_deployments WHERE owner_id=$1 ORDER BY deployment_id',[world.id]))
    .rows.map(row=>({...row,exit_version:world.exit}));
  const evidence=(await t.query('SELECT e.deployment_id,e.snapshot_hash,e.evidence,e.evidence_hash FROM pine_bridge_evidence e JOIN pine_deployments d USING(deployment_id) WHERE d.owner_id=$1 ORDER BY e.deployment_id',[world.id])).rows;
  const bot_state={policy_hash:hash(canonical(POLICY)),capital_basis_hash:hash(canonical(CAPITAL.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance})))),funding_cutoff:7};
  return {owner_id:world.id,bot_id:world.bot,bot_state,memberships,deployments,evidence};
}
const namesOf=world=>world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}));
/** A built S1 member set for the world (new id and time by default). */
async function setOf(world,{id=randomUUID(),created_at=UTC}={}){
  const out=buildMemberSet({...await rowsOf(world),fixture:true,member_set_id:id,created_at,member_deployments:namesOf(world)});
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.member_set;
}
const PARENT_SQL=`INSERT INTO public.mp_member_sets(member_set_id,owner_id,bot_id,version,pine_count,membership_hash,content_digest,set_hash,execution_model_hash,policy_hash,capital_basis_hash,
  funding_cutoff,bridge_atr_multiplier,bridge_rr,exit_version,same_bar_order,fixture,record,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`;
const MEMBER_SQL=`INSERT INTO public.mp_member_set_members(member_set_id,ordinal,owner_id,bot_id,pine_import_id,source_version,source_hash,effective_inputs_hash,deployment_id,deployment_snapshot_hash,
  exit_version,evidence_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
/** The parent row of an S1 record; over replaces columns (record included, as an object or as raw text). */
function parentRow(set,over={}){
  return {member_set_id:set.member_set_id,owner_id:set.owner_id,bot_id:set.bot_id,version:set.version,pine_count:set.pine_count,membership_hash:set.membership_hash,content_digest:set.content_digest,
    set_hash:set.set_hash,execution_model_hash:set.execution_model_hash,policy_hash:set.policy_hash,capital_basis_hash:set.capital_basis_hash,funding_cutoff:set.funding_cutoff,
    bridge_atr_multiplier:set.bridge_pair.atr_multiplier,bridge_rr:set.bridge_pair.rr,exit_version:set.exit_version,same_bar_order:set.same_bar_order,fixture:set.fixture,record:set,
    created_at_utc:set.created_at,...over};
}
const parentValues=row=>[row.member_set_id,row.owner_id,row.bot_id,row.version,row.pine_count,row.membership_hash,row.content_digest,row.set_hash,row.execution_model_hash,row.policy_hash,
  row.capital_basis_hash,row.funding_cutoff,row.bridge_atr_multiplier,row.bridge_rr,row.exit_version,row.same_bar_order,row.fixture,typeof row.record==='string'?row.record:JSON.stringify(row.record),row.created_at_utc];
const insertParent=(target,set,over={})=>target.query(PARENT_SQL,parentValues(parentRow(set,over)));
function memberRow(set,member,over={}){
  return {member_set_id:set.member_set_id,ordinal:member.ordinal,owner_id:set.owner_id,bot_id:set.bot_id,pine_import_id:member.pine_import_id,source_version:member.source_version,
    source_hash:member.source_hash,effective_inputs_hash:member.effective_inputs_hash,deployment_id:member.deployment_id,deployment_snapshot_hash:member.deployment_snapshot_hash,
    exit_version:member.exit_version,evidence_hash:member.evidence_hash,...over};
}
const insertMember=(target,set,member,over={})=>{
  const row=memberRow(set,member,over);
  return target.query(MEMBER_SQL,[row.member_set_id,row.ordinal,row.owner_id,row.bot_id,row.pine_import_id,row.source_version,row.source_hash,row.effective_inputs_hash,row.deployment_id,
    row.deployment_snapshot_hash,row.exit_version,row.evidence_hash]);
};
/** The documented insert order of one set: the parent, then every member (memberOver(member, index) may replace member columns). */
async function insertSet(target,set,{parent={},memberOver=()=>({}),skip=[]}={}){
  await insertParent(target,set,parent);
  for(const [i,member] of set.members.entries())if(!skip.includes(i))await insertMember(target,set,member,memberOver(member,i));
}
/** One committed freeze as the runtime role (the documented path). */
const freeze=(target,set)=>target.transaction(()=>insertSet(target,set),{isolation:'SERIALIZABLE'});
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
  templateName='robot_mp_tpl_'+suffix;databaseName='robot_mp_main_'+suffix;
  dbOwnerRole='robot_mp_dbo_'+suffix.slice(0,14);roleName='robot_mp_rt_'+suffix.slice(0,14);deleterName='robot_mp_del_'+suffix.slice(0,14);truncaterName='robot_mp_trn_'+suffix.slice(0,14);
  for(const name of [roleName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    await install(builder,'pine-bridge-schema.sql');
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
  const classification=await classifyMpMemberSet(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectMpMemberSet(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectMpMemberSet(db,{runtimeRole:'no_such_role_mp'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await memberSetObjects(db),NONE);
  assert.equal(MEMBER_SET_GUARDS.length,11);
  assert.deepEqual([...MEMBER_SET_TABLES],['mp_member_sets','mp_member_set_members']);
  assert.deepEqual([...QR004_GUARDS],[MEMBER_GUARD,COMPLETE_GUARD]);
  assert.deepEqual([QR002,QR003,QR004],['QR002','QR003','QR004']);
});

test('absent: a same-name foreign object classifies OTHER, so an install over it would be refused',async()=>{
  const noop="CREATE FUNCTION public.mp_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign set table','CREATE TABLE public.mp_member_sets(x integer)','TABLE_DEFINITION:mp_member_sets:'],
    ['foreign member table','CREATE TABLE public.mp_member_set_members(x integer)','TABLE_DEFINITION:mp_member_set_members:'],
    ['foreign marker table','CREATE TABLE public.mp_member_set_schema(version integer)','TABLE_DEFINITION:mp_member_set_schema:'],
    ['foreign marker function',"CREATE FUNCTION public.mp_member_set_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:mp_member_set_version:'],
    ['overload of the freeze function','CREATE FUNCTION public.mp_freeze(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:mp_freeze('],
    ['view carrying an index name','CREATE VIEW public.mp_member_sets_pkey AS SELECT 1 AS x','RELATION_UNEXPECTED:mp_member_sets_pkey'],
    ['sequence carrying an index name','CREATE SEQUENCE public.mp_member_set_members_pkey','RELATION_UNEXPECTED:mp_member_set_members_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.mp_member_sets AS integer','TYPE_UNEXPECTED:mp_member_sets'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER mp_member_set_members_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.mp_noop()','TRIGGER_UNEXPECTED:mp_member_set_members_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyMpMemberSet(db),report:await inspectMpMemberSet(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await memberSetObjects(db),NONE,'every probe was rolled back');
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, tables and grants stay as they were; a second install is a no-op',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')
    AND c.relname NOT LIKE 'mp\\_member\\_set%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migrateMpMemberSet(db,{runtimeRole:roleName}).catch(error=>error);
  // The runtime role has no grants yet, so only the missing-privilege checks may be reported by an inspection; the install itself does not require grants.
  assert.ok(!(report instanceof Error),String(report));assert.equal(report.ok,true,report.failures?.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,MEMBER_SET_MARKER);assert.equal(report.facts.guards.length,11);
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(name=>!baseTables.includes(name)),
    [...ALL_TABLES].sort(),'exactly the three member-set tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await memberSetObjects(db),ALL,'three tables, nine indexes, five functions and eleven triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM mp_member_set_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.mp_member_set_version() v')).rows[0].v,MEMBER_SET_MARKER);
  assert.deepEqual((await guardRows(db)).map(row=>[row.tgname,row.tgenabled,row.tgtype]).sort(),MEMBER_SET_GUARDS.map(item=>[item[0],'A',item[3]]).sort());
  assert.equal(MEMBER_SET_GUARDS.filter(item=>item[2]==='mp_freeze').length,6,'a row and a statement freeze trigger on each of the three tables');
  assert.equal(MEMBER_SET_GUARDS.filter(item=>item[2]==='mp_require_serializable').length,3,'a SERIALIZABLE insert trigger on each of the three tables');
  assert.ok((await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'mp\\_%'`)).rows
    .every(row=>row.prosecdef===false&&row.proconfig.length===1&&row.proconfig[0]==='search_path=pg_catalog, pg_temp'),'every function is SECURITY INVOKER with the pinned search_path');
  const deferred=(await db.query("SELECT tgdeferrable,tginitdeferred,tgconstraint<>0 AS constraint_trigger FROM pg_trigger WHERE tgname='mp_member_sets_complete'")).rows;
  assert.deepEqual(deferred,[{tgdeferrable:true,tginitdeferred:true,constraint_trigger:true}],'the completeness check is a deferred constraint trigger');
  const settled=await catalogDigest(db);
  const again=await migrateMpMemberSet(db,{runtimeRole:roleName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyMpMemberSet(db)).state,'INSTALLED');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.mp_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const T='ALTER TABLE public.mp_member_sets ';
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const cases=[
    ['freeze body replaced',"CREATE OR REPLACE FUNCTION public.mp_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:mp_freeze:BODY'],
    ['member guard body replaced',"CREATE OR REPLACE FUNCTION public.mp_guard_member() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:mp_guard_member:BODY'],
    ['completeness body replaced',"CREATE OR REPLACE FUNCTION public.mp_guard_set_complete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NULL; END $$",'FUNCTION_DEFINITION:mp_guard_set_complete:BODY'],
    ['serializable guard body replaced',"CREATE OR REPLACE FUNCTION public.mp_require_serializable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$",'FUNCTION_DEFINITION:mp_require_serializable:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.mp_guard_member() SECURITY DEFINER','FUNCTION_DEFINITION:mp_guard_member:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.mp_guard_member() RESET search_path','FUNCTION_DEFINITION:mp_guard_member:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.mp_freeze() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:mp_freeze:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.mp_freeze() STRICT','FUNCTION_DEFINITION:mp_freeze:ATTRIBUTES'],
    ['freeze trigger disabled','ALTER TABLE public.mp_member_set_members DISABLE TRIGGER mp_member_set_members_no_change','TRIGGER_NOT_ALWAYS:mp_member_set_members_no_change'],
    ['guard trigger origin only','ALTER TABLE public.mp_member_set_members ENABLE TRIGGER mp_member_set_members_guard','TRIGGER_NOT_ALWAYS:mp_member_set_members_guard'],
    ['trigger replica only','ALTER TABLE public.mp_member_sets ENABLE REPLICA TRIGGER mp_member_sets_no_truncate','TRIGGER_NOT_ALWAYS:mp_member_sets_no_truncate'],
    ['serializable trigger disabled','ALTER TABLE public.mp_member_sets DISABLE TRIGGER mp_member_sets_00_serializable','TRIGGER_NOT_ALWAYS:mp_member_sets_00_serializable'],
    ['truncate trigger dropped','DROP TRIGGER mp_member_set_schema_no_truncate ON public.mp_member_set_schema','TRIGGER_MISSING:mp_member_set_schema_no_truncate'],
    ['deferred check dropped','DROP TRIGGER mp_member_sets_complete ON public.mp_member_sets','TRIGGER_MISSING:mp_member_sets_complete'],
    ['deferred check made immediate',`DROP TRIGGER mp_member_sets_complete ON public.mp_member_sets; CREATE CONSTRAINT TRIGGER mp_member_sets_complete AFTER INSERT ON public.mp_member_sets FOR EACH ROW EXECUTE FUNCTION public.mp_guard_set_complete(); ${T}ENABLE ALWAYS TRIGGER mp_member_sets_complete`,'TRIGGER_SHAPE:mp_member_sets_complete'],
    ['deferred check made not initially deferred',`DROP TRIGGER mp_member_sets_complete ON public.mp_member_sets; CREATE CONSTRAINT TRIGGER mp_member_sets_complete AFTER INSERT ON public.mp_member_sets DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.mp_guard_set_complete(); ${T}ENABLE ALWAYS TRIGGER mp_member_sets_complete`,'TRIGGER_SHAPE:mp_member_sets_complete'],
    ['deferred check made a plain trigger',`${redo('mp_member_sets_complete','mp_member_sets','AFTER INSERT','mp_guard_set_complete')} ${T}ENABLE ALWAYS TRIGGER mp_member_sets_complete`,'TRIGGER_SHAPE:mp_member_sets_complete'],
    ['trigger rebound to the other function',`${redo('mp_member_sets_no_change','mp_member_sets','BEFORE UPDATE OR DELETE','mp_guard_set_complete')} ${T}ENABLE ALWAYS TRIGGER mp_member_sets_no_change`,'TRIGGER_FUNCTION:mp_member_sets_no_change'],
    ['freeze trigger narrowed to UPDATE only',`${redo('mp_member_sets_no_change','mp_member_sets','BEFORE UPDATE','mp_freeze')} ${T}ENABLE ALWAYS TRIGGER mp_member_sets_no_change`,'TRIGGER_SHAPE:mp_member_sets_no_change'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER mp_marker AFTER INSERT ON public.mp_member_set_schema FOR EACH ROW EXECUTE FUNCTION public.mp_noop()','TRIGGER_UNEXPECTED:mp_marker'],
    ['extra foreign trigger',noop+' CREATE TRIGGER mp_extra AFTER INSERT ON public.mp_member_set_members FOR EACH ROW EXECUTE FUNCTION public.mp_noop()','TRIGGER_UNEXPECTED:mp_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER mp_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.mp_freeze()','TRIGGER_UNEXPECTED:mp_elsewhere'],
    ['exit version check dropped',T+'DROP CONSTRAINT mp_member_sets_exit_version_check','TABLE_DEFINITION:mp_member_sets:CONSTRAINTS'],
    ['exit version check widened',T+"DROP CONSTRAINT mp_member_sets_exit_version_check, ADD CONSTRAINT mp_member_sets_exit_version_check CHECK(exit_version IN ('bridge-exit-v1','bridge-exit-v2','bridge-exit-v3'))",'TABLE_DEFINITION:mp_member_sets:CONSTRAINTS'],
    ['member exit version check dropped','ALTER TABLE public.mp_member_set_members DROP CONSTRAINT mp_member_set_members_exit_version_check','TABLE_DEFINITION:mp_member_set_members:CONSTRAINTS'],
    ['record ties check dropped',T+'DROP CONSTRAINT mp_member_sets_record_ties_check','TABLE_DEFINITION:mp_member_sets:CONSTRAINTS'],
    ['pine count widened',T+'DROP CONSTRAINT mp_member_sets_pine_count_check, ADD CONSTRAINT mp_member_sets_pine_count_check CHECK(pine_count>=1 AND pine_count<=9)','TABLE_DEFINITION:mp_member_sets:CONSTRAINTS'],
    ['fixture check dropped',T+'DROP CONSTRAINT mp_member_sets_fixture_check','TABLE_DEFINITION:mp_member_sets:CONSTRAINTS'],
    ['content key dropped (RD-MP-11)',T+'DROP CONSTRAINT mp_member_sets_content_key','TABLE_DEFINITION:mp_member_sets:'],
    ['extra constraint',T+'ADD CONSTRAINT mp_extra CHECK(funding_cutoff>=0)','TABLE_DEFINITION:mp_member_sets:CONSTRAINTS'],
    ['foreign key dropped','ALTER TABLE public.mp_member_set_members DROP CONSTRAINT mp_member_set_members_deployment_fkey','TABLE_DEFINITION:mp_member_set_members:CONSTRAINTS'],
    ['foreign key made CASCADE','ALTER TABLE public.mp_member_set_members DROP CONSTRAINT mp_member_set_members_deployment_fkey, ADD CONSTRAINT mp_member_set_members_deployment_fkey FOREIGN KEY(deployment_id) REFERENCES public.pine_deployments(deployment_id) ON DELETE CASCADE','TABLE_DEFINITION:mp_member_set_members:CONSTRAINTS'],
    ['index dropped','DROP INDEX public.mp_member_set_members_deployment','INDEX_MISSING:mp_member_set_members_deployment'],
    ['extra index','CREATE INDEX mp_extra ON public.mp_member_set_members(source_hash)','TABLE_DEFINITION:mp_member_set_members:INDEXES'],
    ['column default added',T+'ALTER COLUMN created_at_utc SET DEFAULT 0','TABLE_DEFINITION:mp_member_sets:COLUMNS'],
    ['column made optional','ALTER TABLE public.mp_member_set_members ALTER COLUMN deployment_id DROP NOT NULL','TABLE_DEFINITION:mp_member_set_members:COLUMNS'],
    ['column added',T+'ADD COLUMN extra integer','TABLE_DEFINITION:mp_member_sets:COLUMNS'],
    ['column type changed','ALTER TABLE public.mp_member_set_members ALTER COLUMN evidence_hash TYPE character varying(64)','TABLE_DEFINITION:mp_member_set_members:'],
    ['column collation changed','ALTER TABLE public.mp_member_set_members ALTER COLUMN exit_version TYPE text COLLATE "C"','TABLE_DEFINITION:mp_member_set_members:COLLATION'],
    ['column collation changed on the parent table','ALTER TABLE public.mp_member_sets ALTER COLUMN version TYPE text COLLATE "POSIX"','TABLE_DEFINITION:mp_member_sets:COLLATION'],
    ['row security enabled',T+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:mp_member_sets:SHAPE'],
    ['rule added','CREATE RULE mp_rule AS ON INSERT TO public.mp_member_set_members DO ALSO NOTHING','TABLE_DEFINITION:mp_member_set_members:SHAPE'],
    ['marker row removed','DELETE FROM public.mp_member_set_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.mp_member_set_schema DROP CONSTRAINT mp_member_set_schema_version_check','TABLE_DEFINITION:mp_member_set_schema:CONSTRAINTS'],
    ['member table re-owned to another role','ALTER TABLE public.mp_member_set_members OWNER TO '+roleName,'OWNER_MISMATCH:mp_member_set_members'],
    ['parent table re-owned to another role','ALTER TABLE public.mp_member_sets OWNER TO '+roleName,'OWNER_MISMATCH:mp_member_sets'],
    ['marker table re-owned (every other object then differs from the marker owner)','ALTER TABLE public.mp_member_set_schema OWNER TO '+roleName,'OWNER_MISMATCH:mp_member_sets'],
    ['guard function re-owned to another role','ALTER FUNCTION public.mp_guard_member() OWNER TO '+roleName,'OWNER_MISMATCH:mp_guard_member'],
    ['freeze function re-owned to another role','ALTER FUNCTION public.mp_freeze() OWNER TO '+roleName,'OWNER_MISMATCH:mp_freeze'],
    ['marker table renamed','ALTER TABLE public.mp_member_set_schema RENAME TO mp_renamed','TABLE_MISSING:mp_member_set_schema']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // A tamper may need the freeze triggers out of the way for its own setup statement (DELETE of the marker row); the probe is rolled back.
      if(label==='marker row removed')await db.query('ALTER TABLE public.mp_member_set_schema DISABLE TRIGGER mp_member_set_schema_no_change');
      await db.query(statement);return {classification:await classifyMpMemberSet(db),report:await inspectMpMemberSet(db)};});
    const all=[...found.classification.problems,...found.classification.missing];
    assert.equal(found.classification.state,'OTHER',label+': '+all.join());
    assert.ok(all.some(item=>item.startsWith(prefix)),label+': '+all.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.mp_member_set_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectMpMemberSet(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:mp_member_set_version:BODY')));
  assert.equal((await classifyMpMemberSet(db)).state,'INSTALLED','every tamper was rolled back');
});

test('offline only: the install and the rollback need the maintenance lock, their own transaction and the Pine Bridge extension',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateMpMemberSet(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackMpMemberSet(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateMpMemberSet(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackMpMemberSet(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
  // A database without the Pine Bridge extension: refused before any write.
  const bareName='robot_mp_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));
  await bare.migrate();
  await assert.rejects(migrateMpMemberSet(bare),/Pine Bridge extension 1 required/);
  assert.deepEqual(await memberSetObjects(bare),NONE);
  await bare.query('CREATE TABLE pine_bridge_schema(version INTEGER)');await bare.query('INSERT INTO pine_bridge_schema VALUES(2)');
  await assert.rejects(migrateMpMemberSet(bare),/Unsupported pine_bridge_schema version/);
  assert.deepEqual(await memberSetObjects(bare),NONE);
});

test('a foreign or partial install is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.mp_member_sets(x integer)');await foreign.query('INSERT INTO public.mp_member_sets VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateMpMemberSet(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackMpMemberSet(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.mp_member_sets')).rows,[{x:7}],'the foreign row survived');
  await migrateMpMemberSet(partial);
  await partial.query('DROP TRIGGER mp_member_sets_no_truncate ON public.mp_member_sets');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateMpMemberSet(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:mp_member_sets_no_truncate/);
  await assert.rejects(rollbackMpMemberSet(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyMpMemberSet(partial)).state,'OTHER');
});

/* ---- 2. grants and the runtime role boundary ---- */

test('grants: the repository grant script lists the member-set tables (integrator gate)',async()=>{
  const text=await fs.readFile(GRANT_SCRIPT,'utf8');
  const list=name=>{const match=new RegExp(name+' CONSTANT TEXT\\[\\] := ARRAY\\[([^\\]]*)\\]').exec(text);assert.ok(match,name);return [...match[1].matchAll(/'([^']+)'/g)].map(item=>item[1]);};
  const insertOnly=list('insert_only'),readOnly=list('read_only'),protectedTables=list('protected');
  for(const table of MEMBER_SET_TABLES){assert.ok(insertOnly.includes(table),table+' is insert-only');assert.ok(!readOnly.includes(table)&&!protectedTables.includes(table),table);}
  assert.ok(readOnly.includes('mp_member_set_schema'),'the member-set marker is read-only');
  assert.ok(!insertOnly.includes('mp_member_set_schema'),'the marker is read-only, not insert-only');
});

test('grants: the grant script gives the runtime role SELECT and INSERT only on the member-set tables; the marker is read-only; reapply is idempotent',async()=>{
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  // Layer-2 proof roles: the deleter also holds UPDATE and DELETE, the truncater TRUNCATE, on every member-set table.
  const all=ALL_TABLES.map(table=>'public.'+table).join(',');
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
  for(const table of MEMBER_SET_TABLES)assert.deepEqual(await facts(roleName,'public.'+table),{owner:false,select:true,insert:true,update:false,delete:false,truncate:false,trigger:false},table);
  assert.deepEqual(await facts(roleName,'public.mp_member_set_schema'),{owner:false,select:true,insert:false,update:false,delete:false,truncate:false,trigger:false},'the marker table is read-only');
  assert.equal((await facts(deleterName,'public.mp_member_sets')).delete,true);assert.equal((await facts(truncaterName,'public.mp_member_sets')).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // inspect with the runtime role passes, and names the role that broke the boundary
  const ok=await inspectMpMemberSet(db,{runtimeRole:roleName});assert.equal(ok.ok,true,ok.failures.join());
  assert.equal(ok.facts.runtime_role.tables.length,3);assert.deepEqual(ok.facts.runtime_role.privileged_members,[]);
  const deleter=await inspectMpMemberSet(db,{runtimeRole:deleterName});
  assert.ok(deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:mp_member_sets:DELETE')&&deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:mp_member_set_members:UPDATE'),deleter.failures.join());
  assert.ok(deleter.failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:mp_member_set_schema:DELETE'));
  assert.ok((await inspectMpMemberSet(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:mp_member_sets'));
  const adminRole=decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).username);
  assert.ok(adminRole.length>0);
  assert.ok((await inspectMpMemberSet(db,{runtimeRole:adminRole})).failures.some(item=>item.startsWith('RUNTIME_ROLE_SUPERUSER')||item.startsWith('RUNTIME_ROLE_OWNS:')));
  // Membership of the owning role counts as ownership, for the tables and for each function (all rolled back).
  const ownerRole=(await db.query('SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=$1::regclass',['public.mp_member_sets'])).rows[0].o;
  const memberOf=await probe(db,async()=>{
    await db.query('CREATE ROLE mp_member NOLOGIN');await db.query('GRANT '+ownerRole+' TO mp_member');
    return inspectMpMemberSet(db,{runtimeRole:'mp_member'});
  });
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS:mp_member_sets')&&memberOf.failures.includes('RUNTIME_ROLE_OWNS:mp_member_set_schema'),memberOf.failures.join());
  assert.ok(memberOf.failures.includes('RUNTIME_ROLE_OWNS_FUNCTION:mp_freeze'),memberOf.failures.join());
  // A privilege reachable through a role without inheritance, and a column grant, fail like a table-level one.
  const reached=await probe(db,async()=>{
    await db.query('CREATE ROLE mp_holder NOLOGIN');await db.query('CREATE ROLE mp_noinherit NOLOGIN NOINHERIT');await db.query('GRANT mp_holder TO mp_noinherit');
    await db.query('GRANT TRIGGER,UPDATE,TRUNCATE ON TABLE public.mp_member_sets TO mp_holder');await db.query('GRANT UPDATE (ordinal) ON TABLE public.mp_member_set_members TO mp_holder');
    return inspectMpMemberSet(db,{runtimeRole:'mp_noinherit',requireGrants:false});
  });
  for(const failure of ['RUNTIME_ROLE_TRIGGER_PRIVILEGE:mp_member_sets','RUNTIME_ROLE_WRITE_PRIVILEGE:mp_member_sets:UPDATE','RUNTIME_ROLE_TRUNCATE_PRIVILEGE:mp_member_sets','RUNTIME_ROLE_WRITE_PRIVILEGE:mp_member_set_members:UPDATE'])
    assert.ok(reached.failures.includes(failure),failure+': '+reached.failures.join());
  // The role cannot disable a guard, replace a function or change the replication role.
  await refused(rt.query('ALTER TABLE public.mp_member_sets DISABLE TRIGGER mp_member_sets_no_change'),DENIED);
  await refused(rt.query('ALTER TABLE public.mp_member_set_members DISABLE TRIGGER ALL'),DENIED);
  await refused(rt.query('DROP TRIGGER mp_member_set_members_guard ON public.mp_member_set_members'),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.mp_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query('DROP TABLE public.mp_member_sets'),DENIED);
  await refused(rt.query('INSERT INTO public.mp_member_set_schema VALUES(2)'),DENIED);await refused(rt.query('UPDATE public.mp_member_set_schema SET version=1'),DENIED);await refused(rt.query('DELETE FROM public.mp_member_set_schema'),DENIED);
  assert.equal((await classifyMpMemberSet(db)).state,'INSTALLED');
});

/* ---- 3. SERIALIZABLE only ---- */

test('SERIALIZABLE only: an INSERT into any member-set table under READ COMMITTED or REPEATABLE READ is refused with QR003, whatever the other guards say',async()=>{
  const world=await newWorld(),set=await setOf(world);
  const writes={
    mp_member_sets:()=>insertParent(rt,set),
    mp_member_set_members:()=>insertMember(rt,set,set.members[0])};
  const before=await allDigests(db);
  for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
    for(const [table,write] of Object.entries(writes))
      await refusedWith(rt.transaction(write,{isolation}),QR003,/require a SERIALIZABLE transaction/).catch(error=>{throw Error(isolation+' '+table+': '+error.message);});
  for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
    await refused(db.transaction(()=>db.query('INSERT INTO public.mp_member_set_schema VALUES(1)'),{isolation}),QR003);
  // an autocommit statement of a session whose default is READ COMMITTED meets it too, also with session_replication_role=replica (ENABLE ALWAYS)
  const plain=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:1}));
  await refused(insertParent(plain,set),QR003);
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await insertParent(db,set);},{isolation:'READ COMMITTED'}),QR003);
  assert.deepEqual(await allDigests(db),before,'no refused insert left a row');
  // the QR003 trigger sorts first: a member insert that would also fail the member guard reports QR003 under READ COMMITTED and the guard under SERIALIZABLE
  const bad={...set.members[0],source_hash:'0'.repeat(64)};
  await refused(rt.transaction(()=>insertMember(rt,set,bad),{isolation:'READ COMMITTED'}),QR003);
  await refused(rt.transaction(()=>insertMember(rt,set,bad),{isolation:'SERIALIZABLE'}),QR004);
  // SERIALIZABLE writes the same rows
  await freeze(rt,set);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_set_members WHERE member_set_id=$1',[set.member_set_id])).rows[0].n,2);
});

/* ---- 4. the parent table: CHECKs and ties ---- */

test('parent CHECKs and record ties: every shape, tie and malformed-JSON case is refused with 23514 and stores nothing',async()=>{
  const world=await newWorld({exit:'bridge-exit-v2'}),set=await setOf(world);
  const clone=value=>structuredClone(value);
  const withRecord=mutate=>{const record=clone(set);mutate(record);return {record};};
  const HEX='f'.repeat(64);
  const cases=[
    ['unknown version',{version:'mp-member-set-v2'}],
    ['pine_count 1',{pine_count:1}],['pine_count 4',{pine_count:4}],['pine_count 0',{pine_count:0}],
    ['membership_hash short',{membership_hash:HEX.slice(1)}],['content_digest uppercase',{content_digest:HEX.toUpperCase()}],['set_hash not hex',{set_hash:'z'.repeat(64)}],
    ['execution_model_hash empty',{execution_model_hash:''}],['policy_hash short',{policy_hash:'ab'}],['capital_basis_hash long',{capital_basis_hash:HEX+'0'}],
    ['negative funding_cutoff',{funding_cutoff:-1}],['funding_cutoff beyond a safe integer',{funding_cutoff:9007199254740992}],
    ['atr multiplier 2.0',{bridge_atr_multiplier:'2.0'}],['atr multiplier 02',{bridge_atr_multiplier:'02'}],['atr multiplier zero',{bridge_atr_multiplier:'0'}],
    ['atr multiplier above 1000',{bridge_atr_multiplier:'1001'}],['atr multiplier exponent',{bridge_atr_multiplier:'1e2'}],['atr multiplier padded',{bridge_atr_multiplier:' 2'}],
    ['atr multiplier not a number',{bridge_atr_multiplier:'abc'}],['atr multiplier empty',{bridge_atr_multiplier:''}],['atr multiplier negative',{bridge_atr_multiplier:'-1'}],
    ['rr 1.50',{bridge_rr:'1.50'}],['rr trailing dot',{bridge_rr:'1.'}],['rr leading dot',{bridge_rr:'.5'}],
    ['unknown exit version',{exit_version:'bridge-exit-v3'}],['empty exit version',{exit_version:''}],
    ['same bar order differs',{same_bar_order:'ordinal-first'}],['fixture false',{fixture:false}],
    ['created_at month 13',{created_at_utc:'2026-13-20T10:00:00Z'}],['created_at month 00',{created_at_utc:'2026-00-20T10:00:00Z'}],['created_at day 32',{created_at_utc:'2026-10-32T10:00:00Z'}],
    ['created_at day 00',{created_at_utc:'2026-10-00T10:00:00Z'}],['created_at hour 25',{created_at_utc:'2026-10-20T25:00:00Z'}],['created_at minute 60',{created_at_utc:'2026-10-20T10:60:00Z'}],
    ['created_at second 60',{created_at_utc:'2026-10-20T10:00:60Z'}],
    ['created_at not UTC text',{created_at_utc:'2026-10-20 10:00:00'}],['created_at four fraction digits',{created_at_utc:'2026-10-20T10:00:00.1234Z'}],
    ['record not an object (array)',{record:'[]'}],['record not an object (string)',{record:'"x"'}],['record not an object (number)',{record:'7'}],['record JSON null',{record:'null'}],['record empty object',{record:'{}'}],
    ['record member_set_id differs',withRecord(r=>{r.member_set_id=randomUUID();})],
    ['record owner differs',withRecord(r=>{r.owner_id='other';})],['record Bot differs',withRecord(r=>{r.bot_id='other';})],
    ['record version differs',withRecord(r=>{r.version='mp-member-set-v2';})],['record mode differs',withRecord(r=>{r.mode='ONE_PINE';})],
    ['record pine_count is text',withRecord(r=>{r.pine_count='2';})],['record pine_count differs',withRecord(r=>{r.pine_count=3;})],
    ['record funding_cutoff is text',withRecord(r=>{r.funding_cutoff='7';})],['record funding_cutoff differs',withRecord(r=>{r.funding_cutoff=8;})],
    ['record membership_hash differs',withRecord(r=>{r.membership_hash=HEX;})],['record content_digest differs',withRecord(r=>{r.content_digest=HEX;})],['record set_hash differs',withRecord(r=>{r.set_hash=HEX;})],
    ['record execution_model_hash differs',withRecord(r=>{r.execution_model_hash=HEX;})],['record policy_hash differs',withRecord(r=>{r.policy_hash=HEX;})],['record capital_basis_hash differs',withRecord(r=>{r.capital_basis_hash=HEX;})],
    ['record bridge pair differs',withRecord(r=>{r.bridge_pair={atr_multiplier:'3',rr:'1.5'};})],['record bridge pair is a string',withRecord(r=>{r.bridge_pair='2/1.5';})],
    ['record bridge pair has an extra key',withRecord(r=>{r.bridge_pair.extra='x';})],
    ['record ATR period differs',withRecord(r=>{r.bridge_atr_period=20;})],['record market differs',withRecord(r=>{r.market={...r.market,symbol:'ETHUSDT'};})],
    ['record market missing',withRecord(r=>{delete r.market;})],
    ['record exit_version differs',withRecord(r=>{r.exit_version='bridge-exit-v1';})],['record same_bar_order differs',withRecord(r=>{r.same_bar_order='other';})],
    ['record fixture is text',withRecord(r=>{r.fixture='true';})],['record fixture false',withRecord(r=>{r.fixture=false;})],
    ['record created_at differs',withRecord(r=>{r.created_at='2026-10-20T11:00:00Z';})],
    ['record members missing',withRecord(r=>{delete r.members;})],['record members is an object',withRecord(r=>{r.members={};})],['record members is text',withRecord(r=>{r.members='x';})],
    ['record members shorter than pine_count',withRecord(r=>{r.members=r.members.slice(0,1);})],['record members longer than pine_count',withRecord(r=>{r.members=[...r.members,r.members[0]];})],
    ['record key missing (content_digest)',withRecord(r=>{delete r.content_digest;})],['record has an extra key',withRecord(r=>{r.extra='x';})]];
  // A JSON number whose digits equal an all-digit hash is not the JSON string the column holds (the text tie alone would pass it).
  const DIGITS='1'.repeat(64),typed=clone(set);typed.membership_hash=DIGITS;
  const NUMBER_CASE='record membership_hash is a JSON number with the digits of the column';
  cases.push([NUMBER_CASE,{membership_hash:DIGITS,record:JSON.stringify(typed).replace('"membership_hash":"'+DIGITS+'"','"membership_hash":'+DIGITS)}]);
  const before=await rowDigest(db,'mp_member_sets');
  for(const [label,over] of cases){
    const found=await attempt(db,()=>insertParent(db,set,over));
    assert.equal(found?.code,CHECK_VIOLATION,label+': '+JSON.stringify(found));
    // The column's own hash CHECK accepts the digits, so only the record tie can refuse the JSON number.
    if(label===NUMBER_CASE)assert.equal(found.constraint,'mp_member_sets_record_ties_check',label+': '+JSON.stringify(found));
  }
  // not CHECKs: a foreign owner or Bot is a foreign key violation, a repeated id or content a unique violation
  assert.equal((await attempt(db,()=>insertParent(db,set,{owner_id:'no-such-owner',record:{...set,owner_id:'no-such-owner'}})))?.code,FK_VIOLATION);
  assert.equal((await attempt(db,()=>insertParent(db,set,{bot_id:'no-such-bot',record:{...set,bot_id:'no-such-bot'}})))?.code,FK_VIOLATION);
  assert.equal((await attempt(db,async()=>{await insertParent(db,set);await insertParent(db,set);}))?.code,UNIQUE_VIOLATION);
  const twin=await setOf(world);
  assert.equal(twin.content_digest,set.content_digest,'the same rows give the same content digest');
  const dup=await attempt(db,async()=>{await insertParent(db,set);await insertParent(db,twin);});
  assert.equal(dup?.code,UNIQUE_VIOLATION);assert.equal(dup.constraint,'mp_member_sets_content_key','a second set of the same content is the insert-or-load conflict (RD-MP-11)');
  assert.deepEqual(await rowDigest(db,'mp_member_sets'),before,'no refused insert left a row');
  // a canonical set is accepted by the CHECKs (a rolled back probe: members and the completeness check are other cases)
  assert.equal(await attempt(db,async()=>{await insertSet(db,set);}),null);
  // The same all-digit hash as a JSON string is accepted by the parent CHECKs (so the case above fails only on the JSON type).
  const textual=clone(set);textual.membership_hash=DIGITS;
  const control=await attempt(db,()=>insertParent(db,set,{membership_hash:DIGITS,record:textual}));
  assert.equal(control?.code,QR004,'the parent alone passes every CHECK and meets only the completeness guard: '+JSON.stringify(control));assert.equal(control.constraint,COMPLETE_GUARD);
  // A decimal given as 2.5 or 0.25 and a version-1 exit are accepted by the parent CHECKs
  const v1=await setOf(await newWorld({exit:'bridge-exit-v1'}));
  assert.equal(v1.exit_version,'bridge-exit-v1');assert.equal(await attempt(db,()=>insertSet(db,v1)),null,'bridge-exit-v1 is a known receiver version');
});

test('member CHECKs hold without the guard: ordinal, hashes, versions and lengths (a rolled-back probe with the guard disabled)',async()=>{
  const world=await newWorld(),set=await setOf(world);
  const [first]=set.members;
  const cases=[['ordinal 0',{ordinal:0}],['ordinal 4',{ordinal:4}],['source_version 0',{source_version:0}],['source_hash short',{source_hash:'ab'}],
    ['effective_inputs_hash uppercase',{effective_inputs_hash:'A'.repeat(64)}],['snapshot hash not hex',{deployment_snapshot_hash:'z'.repeat(64)}],['evidence_hash empty',{evidence_hash:''}],
    ['unknown exit version',{exit_version:'bridge-exit-v3'}],['empty import id',{pine_import_id:''}],['import id over 200 characters',{pine_import_id:'x'.repeat(201)}],
    ['empty deployment id',{deployment_id:''}],['deployment id over 200 characters',{deployment_id:'x'.repeat(201)}]];
  for(const [label,over] of cases){
    const found=await probe(db,async()=>{
      await db.query('ALTER TABLE public.mp_member_set_members DISABLE TRIGGER mp_member_set_members_guard');
      await insertParent(db,set);
      return insertMember(db,set,first,over).then(()=>null,error=>({code:error.code,constraint:error.constraint}));
    });
    assert.equal(found?.code,CHECK_VIOLATION,label+': '+JSON.stringify(found));
  }
  // keys with the guard disabled: a repeated ordinal, import and deployment per set, and the foreign keys
  const keys=await probe(db,async()=>{
    await db.query('ALTER TABLE public.mp_member_set_members DISABLE TRIGGER mp_member_set_members_guard');
    await insertParent(db,set);await insertMember(db,set,first);
    const found={};
    found.ordinal=await codeIn(()=>insertMember(db,set,set.members[1],{ordinal:1}));
    found.import=await codeIn(()=>insertMember(db,set,set.members[1],{pine_import_id:first.pine_import_id,ordinal:2}));
    found.deployment=await codeIn(()=>insertMember(db,set,set.members[1],{deployment_id:first.deployment_id,ordinal:2}));
    found.revision=await codeIn(()=>insertMember(db,set,set.members[1],{source_version:9}));
    found.deploymentFk=await codeIn(()=>insertMember(db,set,set.members[1],{deployment_id:'dep-none'}));
    found.setFk=await codeIn(()=>insertMember(db,set,set.members[1],{owner_id:'no-such-owner'}));
    found.otherBot=await codeIn(()=>insertMember(db,set,set.members[1],{bot_id:'no-such-bot'}));
    return found;
  });
  assert.deepEqual(keys,{ordinal:UNIQUE_VIOLATION,import:UNIQUE_VIOLATION,deployment:UNIQUE_VIOLATION,revision:FK_VIOLATION,deploymentFk:FK_VIOLATION,setFk:FK_VIOLATION,otherBot:FK_VIOLATION});
});
let savepoints=0;
/** Runs fn behind a savepoint of the current transaction; returns the SQLSTATE of its failure (rolled back to the savepoint) or null. */
async function codeIn(fn){
  const name='sp'+(++savepoints);await db.query('SAVEPOINT '+name);
  try{await fn();await db.query('RELEASE SAVEPOINT '+name);return null;}catch(error){await db.query('ROLLBACK TO SAVEPOINT '+name);return error.code;}
}

/* ---- 5. the member insert guard, one precondition at a time ---- */

test('member guard: every precondition is refused with QR004 naming mp_member_set_members_guard; each case is a rolled-back tamper of the pine rows',async()=>{
  const world=await newWorld(),set=await setOf(world);
  const [a,b]=set.members;
  assert.equal(await attempt(db,()=>insertSet(db,set)),null,'the untampered set is accepted');
  const other=await newWorld();
  const tampers=[
    ['deployment READY',/must be DRAFT/,()=>db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[a.deployment_id])],
    ['deployment EXIT_ONLY',/must be DRAFT/,()=>db.query("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE deployment_id=$1",[b.deployment_id])],
    ['deployment REVOKED',/must be DRAFT/,()=>db.query("UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",[a.deployment_id])],
    ['deployment of another owner',/same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET owner_id=$2 WHERE deployment_id=$1',[a.deployment_id,other.id])],
    ['deployment of another Bot',/same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET bot_id=$2 WHERE deployment_id=$1',[a.deployment_id,other.id])],
    ['deployment of another import',/same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET pine_import_id=$2 WHERE deployment_id=$1',[a.deployment_id,b.pine_import_id])],
    ['deployment of another source version',/same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET source_version=2 WHERE deployment_id=$1',[a.deployment_id])],
    ['deployment absent',/same owner, Bot, import and source version/,async()=>{
      await db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[b.deployment_id]);await db.query('DELETE FROM pine_deployments WHERE deployment_id=$1',[b.deployment_id]);}],
    ['deployment snapshot_hash differs',/deployment_snapshot_hash must equal/,()=>db.query('UPDATE pine_deployments SET snapshot_hash=$2 WHERE deployment_id=$1',[a.deployment_id,'e'.repeat(64)])],
    ['membership disconnected',/connected membership/,()=>db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[b.pine_import_id])],
    ['membership of another owner',/connected membership/,()=>db.query('UPDATE pine_memberships SET owner_id=$2 WHERE pine_import_id=$1',[a.pine_import_id,other.id])],
    ['membership of another Bot',/connected membership/,()=>db.query('UPDATE pine_memberships SET bot_id=$2 WHERE pine_import_id=$1',[a.pine_import_id,other.id])],
    ['membership at another source version',/connected membership/,async()=>{
      await db.query('INSERT INTO pine_source_revisions SELECT pine_import_id,2,source_hash,source,analysis,created_at FROM pine_source_revisions WHERE pine_import_id=$1 AND source_version=1',[a.pine_import_id]);
      await db.query('UPDATE pine_memberships SET source_version=2 WHERE pine_import_id=$1',[a.pine_import_id]);}],
    ['source revision hash differs',/must equal the source revision/,()=>db.query('UPDATE pine_source_revisions SET source_hash=$2 WHERE pine_import_id=$1 AND source_version=1',[a.pine_import_id,'d'.repeat(64)])],
    ['effective inputs hash differs',/must equal the source revision/,()=>db.query(`UPDATE pine_source_revisions SET analysis=jsonb_set(analysis,'{effective_inputs_hash}',to_jsonb($2::text)) WHERE pine_import_id=$1`,[b.pine_import_id,'c'.repeat(64)])],
    ['effective inputs hash missing',/must equal the source revision/,()=>db.query(`UPDATE pine_source_revisions SET analysis=analysis-'effective_inputs_hash' WHERE pine_import_id=$1`,[a.pine_import_id])],
    ['evidence absent',/Bridge evidence row/,()=>db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[a.deployment_id])],
    ['evidence of another snapshot',/Bridge evidence row/,()=>db.query('UPDATE pine_bridge_evidence SET snapshot_hash=$2 WHERE deployment_id=$1',[b.deployment_id,'b'.repeat(64)])],
    ['evidence_hash differs',/Bridge evidence row/,()=>db.query('UPDATE pine_bridge_evidence SET evidence_hash=$2 WHERE deployment_id=$1',[a.deployment_id,'a'.repeat(64)])]];
  for(const [label,message,tamper] of tampers){
    const found=await attempt(db,async()=>{await tamper();await insertSet(db,set);});
    assert.equal(found?.code,QR004,label+': '+JSON.stringify(found));
    assert.equal(found.constraint,MEMBER_GUARD,label);
    assert.match(found.message,message,label);
  }
  // the member row against the stored record and the parent
  const rowCases=[
    ['source_hash differs from the record',{source_hash:'1'.repeat(64)},/equal the member of the stored record/],
    ['effective_inputs_hash differs from the record',{effective_inputs_hash:'2'.repeat(64)},/equal the member of the stored record/],
    ['snapshot hash differs from the record',{deployment_snapshot_hash:'3'.repeat(64)},/equal the member of the stored record/],
    ['evidence_hash differs from the record',{evidence_hash:'4'.repeat(64)},/equal the member of the stored record/],
    ['deployment differs from the record',{deployment_id:b.deployment_id},/equal the member of the stored record/],
    ['import differs from the record',{pine_import_id:b.pine_import_id},/equal the member of the stored record/],
    ['source_version differs from the record',{source_version:2},/equal the member of the stored record/],
    ['exit_version differs from the parent',{exit_version:'bridge-exit-v1'},/owner, Bot and exit_version of its member set/],
    ['owner differs from the parent',{owner_id:other.id},/owner, Bot and exit_version of its member set/],
    ['Bot differs from the parent',{bot_id:other.id},/owner, Bot and exit_version of its member set/]];
  for(const [label,over,message] of rowCases){
    const found=await attempt(db,async()=>{await insertParent(db,set);await insertMember(db,set,a,over);});
    assert.equal(found?.code,QR004,label+': '+JSON.stringify(found));assert.equal(found.constraint,MEMBER_GUARD,label);assert.match(found.message,message,label);
  }
  // the members swapped between ordinals, a member without its parent, an ordinal beyond pine_count
  const swapped=await attempt(db,async()=>{await insertParent(db,set);await insertMember(db,set,a,{ordinal:2});});
  assert.equal(swapped?.code,QR004);assert.match(swapped.message,/equal the member of the stored record/);
  const orphan=await attempt(db,()=>insertMember(db,set,a));
  assert.equal(orphan?.code,QR004);assert.equal(orphan.constraint,MEMBER_GUARD);assert.match(orphan.message,/needs its member set row first/);
  const third=await attempt(db,async()=>{await insertParent(db,set);await insertMember(db,set,a,{ordinal:3});});
  assert.equal(third?.code,QR004);assert.match(third.message,/cannot exceed the pine_count/);
  assert.equal(await attempt(db,()=>insertSet(db,set)),null,'every tamper was rolled back');
});

test('completeness: a member set commits only with exactly pine_count members; nothing is stored otherwise',async()=>{
  const world=await newWorld({count:3}),set=await setOf(world);
  assert.equal(set.pine_count,3);
  const before=await allDigests(db);
  // A parent alone, a parent with one or two of three members, all fail at COMMIT with the deferred guard (QR004 naming mp_member_sets_complete)
  for(const skip of [[0,1,2],[1,2],[0,2],[2]]){
    const error=await db.transaction(()=>insertSet(db,set,{skip}),{isolation:'SERIALIZABLE'}).then(()=>null,failure=>failure);
    assert.equal(error?.code,QR004,'skip '+skip.join()+': '+error?.message);assert.equal(error.constraint,COMPLETE_GUARD);assert.match(error.message,/exactly pine_count member rows/);
  }
  assert.deepEqual(await allDigests(db),before,'no incomplete set left a row');
  // the check is deferred: inside the transaction the missing members can still be added; SET CONSTRAINTS IMMEDIATE brings it forward
  const early=await attempt(db,()=>insertSet(db,set,{skip:[2]}));
  assert.equal(early?.code,QR004);assert.equal(early.constraint,COMPLETE_GUARD);
  await db.transaction(async()=>{await insertParent(db,set);for(const member of set.members)await insertMember(db,set,member);},{isolation:'SERIALIZABLE'});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_set_members WHERE member_set_id=$1',[set.member_set_id])).rows[0].n,3);
  // after the commit no member can be added: a repeated ordinal meets the primary key, an ordinal beyond the count meets the guard
  await refused(rt.transaction(()=>insertMember(rt,set,set.members[0])),UNIQUE_VIOLATION);
  await refused(rt.transaction(()=>insertMember(rt,set,set.members[1])),UNIQUE_VIOLATION);
  const small=await setOf(await newWorld({count:2}));
  await freeze(rt,small);
  await refusedWith(rt.transaction(()=>insertMember(rt,small,small.members[0],{ordinal:3})),QR004,/cannot exceed the pine_count/);
  await refusedWith(rt.transaction(()=>insertMember(rt,small,small.members[0],{source_hash:'9'.repeat(64)})),QR004,/equal the member of the stored record/);
});

test('completeness: pine_count must equal the connected memberships of the Bot (QR004 mp_member_sets_complete); a disconnected membership does not count',async()=>{
  const world=await newWorld({count:2}),set=await setOf(world);
  assert.equal(set.pine_count,2);
  // A third membership of the Bot is connected after the S1 set was built from two: the self-consistent two-member record is refused at commit.
  const addMembership=async connected=>{
    const id=randomUUID(),hashOf=hash('source-'+id),analysis={effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i3'}]};
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[id,world.id,hashOf,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[id,hashOf,'//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$2,1,$3)',[id,world.id,connected]);
  };
  const before=await allDigests(db);
  const subset=await attempt(db,async()=>{await addMembership(true);await insertSet(db,set);});
  assert.equal(subset?.code,QR004,JSON.stringify(subset));assert.equal(subset.constraint,COMPLETE_GUARD);assert.match(subset.message,/connected memberships of its Bot/);
  // The same through a real commit as the runtime role: nothing is stored.
  await addMembership(true);
  const error=await rt.transaction(()=>insertSet(rt,set),{isolation:'SERIALIZABLE'}).then(()=>null,failure=>failure);
  assert.equal(error?.code,QR004,error?.message);assert.equal(error.constraint,COMPLETE_GUARD);assert.match(error.message,/connected memberships of its Bot/);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_sets WHERE owner_id=$1',[world.id])).rows[0].n,0);
  // A third membership that is not connected does not count.
  const other=await newWorld({count:2}),otherSet=await setOf(other);
  const disconnected=await attempt(db,async()=>{
    const id=randomUUID(),hashOf=hash('source-'+id),analysis={effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i3'}]};
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[id,other.id,hashOf,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[id,hashOf,'//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$2,1,false)',[id,other.id]);
    await insertSet(db,otherSet);
  });
  assert.equal(disconnected,null,JSON.stringify(disconnected));
  assert.deepEqual((await allDigests(db)).mp_member_sets,before.mp_member_sets,'no refused or probed set left a row');
});

test('completeness: the connected count is of the (owner_id, bot_id) pair, in a world where the owner and the Bot are different users',async()=>{
  const world=await newWorld({count:2,split:true}),set=await setOf(world);
  assert.notEqual(world.id,world.bot);assert.equal(set.owner_id,world.id);assert.equal(set.bot_id,world.bot);assert.equal(set.pine_count,2);
  const addMembership=async(owner,bot,connected=true)=>{
    const id=randomUUID(),hashOf=hash('source-'+id),analysis={effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i3'}]};
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[id,owner,bot,hashOf,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[id,hashOf,'//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,$4)',[id,owner,bot,connected]);
  };
  const userId=async()=>(await store.createUser({email:'mp-extra-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'})).id;
  const otherBot=await userId(),stranger=await userId();
  const before=await allDigests(db);
  // Connected memberships of other pairs never count: the same owner with another Bot, another owner with the same Bot, and the swapped pair.
  // A count that drops bot_id, drops owner_id or compares the wrong columns sees a number other than pine_count and refuses.
  const others=await attempt(db,async()=>{
    await addMembership(world.id,otherBot);await addMembership(stranger,world.bot);await addMembership(world.bot,world.id);
    await insertSet(db,set);
  });
  assert.equal(others,null,'memberships of other (owner, Bot) pairs do not count: '+JSON.stringify(others));
  // A third connected membership of exactly this pair is refused, with the connected-memberships message.
  const exact=await attempt(db,async()=>{await addMembership(world.id,world.bot);await insertSet(db,set);});
  assert.equal(exact?.code,QR004,JSON.stringify(exact));assert.equal(exact.constraint,COMPLETE_GUARD);assert.match(exact.message,/connected memberships of its Bot/);
  // A disconnected third membership of this pair does not count.
  assert.equal(await attempt(db,async()=>{await addMembership(world.id,world.bot,false);await insertSet(db,set);}),null);
  assert.deepEqual(await allDigests(db),before,'every probe was rolled back');
  // The same through a real commit as the runtime role, with the other-pair memberships committed beside it.
  await addMembership(world.id,otherBot);await addMembership(stranger,world.bot);await addMembership(world.bot,world.id);
  await freeze(rt,set);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_sets WHERE owner_id=$1 AND bot_id=$2',[world.id,world.bot])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_set_members WHERE member_set_id=$1',[set.member_set_id])).rows[0].n,2);
});

/* ---- 6. S1 end to end: freeze, load, freshness ---- */

test('S1 record: freeze as the runtime role, load it back, insert-or-load by content, freshness on the stored rows',async()=>{
  const world=await newWorld({count:2}),set=await setOf(world);
  await freeze(rt,set);
  const stored=(await rt.query('SELECT record,exit_version,pine_count,fixture,created_at_utc FROM public.mp_member_sets WHERE owner_id=$1 AND bot_id=$1 AND content_digest=$2',[world.id,set.content_digest])).rows;
  assert.equal(stored.length,1);assert.deepEqual(stored[0].record,set,'the stored record is the S1 record, verbatim');
  assert.deepEqual([stored[0].exit_version,stored[0].pine_count,stored[0].fixture,stored[0].created_at_utc],['bridge-exit-v2',2,true,UTC]);
  const members=(await rt.query('SELECT * FROM public.mp_member_set_members WHERE member_set_id=$1 ORDER BY ordinal',[set.member_set_id])).rows;
  assert.deepEqual(members.map(row=>({ordinal:row.ordinal,pine_import_id:row.pine_import_id,source_version:row.source_version,source_hash:row.source_hash,effective_inputs_hash:row.effective_inputs_hash,
    deployment_id:row.deployment_id,deployment_snapshot_hash:row.deployment_snapshot_hash,exit_version:row.exit_version,evidence_hash:row.evidence_hash})),set.members,'the child rows equal the record members');
  // the same content again (new id, later time): the S1 decision is LOAD of the stored set, and a second insert meets the content key
  const again=await setOf(world,{id:randomUUID(),created_at:'2026-10-20T12:00:00.500Z'});
  assert.notEqual(again.member_set_id,set.member_set_id);assert.equal(again.content_digest,set.content_digest);
  const decision=decideFreeze(again,stored.map(row=>row.record));
  assert.equal(decision.ok,true,JSON.stringify(decision));assert.equal(decision.action,'LOAD');assert.equal(decision.member_set.member_set_id,set.member_set_id);
  const dup=await rt.transaction(()=>insertSet(rt,again),{isolation:'SERIALIZABLE'}).then(()=>null,error=>error);
  assert.equal(dup?.code,UNIQUE_VIOLATION);assert.equal(dup.constraint,'mp_member_sets_content_key');
  const onConflict=await rt.transaction(async()=>(await rt.query(`INSERT INTO public.mp_member_sets(member_set_id,owner_id,bot_id,version,pine_count,membership_hash,content_digest,set_hash,execution_model_hash,policy_hash,
    capital_basis_hash,funding_cutoff,bridge_atr_multiplier,bridge_rr,exit_version,same_bar_order,fixture,record,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT ON CONSTRAINT mp_member_sets_content_key DO NOTHING RETURNING member_set_id`,parentValues(parentRow(again)))).rowCount,{isolation:'SERIALIZABLE'});
  assert.equal(onConflict,0,'insert-or-load: DO NOTHING returns no row when an equal set exists (INSERT and SELECT privilege only)');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_sets WHERE owner_id=$1',[world.id])).rows[0].n,1);
  const rows=await rowsOf(world);
  const fresh=memberSetFreshness(stored[0].record,rows);
  assert.deepEqual(fresh,{ok:true,fresh:true},JSON.stringify(fresh));
  // F10 (database part): disconnect member 2 after freeze and the stored set reads stale
  const disconnected=await probe(db,async()=>{
    await db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[set.members[1].pine_import_id]);
    return memberSetFreshness(stored[0].record,await rowsOf(world));
  });
  assert.equal(disconnected.ok,true);assert.equal(disconnected.fresh,false);assert.equal(disconnected.code,'MP_MEMBER_SET_STALE');assert.equal(disconnected.diagnostic.field,'membership_hash');
  // owner isolation (I1): another owner's query sees nothing of this set
  const stranger=await newWorld({count:2});
  assert.equal((await rt.query('SELECT count(*)::int n FROM public.mp_member_sets WHERE owner_id=$1 AND content_digest=$2',[stranger.id,set.content_digest])).rows[0].n,0);
  // exit_version is limited to the receiver versions, whatever S1 accepts: an S1 set with another version is built but never stored
  const odd=await setOf(await newWorld({exit:'bridge-exit-v3'}));
  assert.equal(odd.exit_version,'bridge-exit-v3');
  assert.equal((await attempt(db,()=>insertSet(db,odd)))?.code,CHECK_VIOLATION);
  const v1=await setOf(await newWorld({exit:'bridge-exit-v1'}));
  await freeze(rt,v1);
  assert.equal((await db.query('SELECT exit_version FROM public.mp_member_sets WHERE member_set_id=$1',[v1.member_set_id])).rows[0].exit_version,'bridge-exit-v1');
});

/* ---- 7. insert-only enforcement ---- */

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers on every table; the replication role cannot skip a guard; no row changes',async()=>{
  const world=await newWorld(),set=await setOf(world);await freeze(rt,set);
  const before=await allDigests(db);
  for(const table of ALL_TABLES)assert.ok(before[table].n>0,table+' holds a row');
  const column={mp_member_sets:'funding_cutoff',mp_member_set_members:'ordinal',mp_member_set_schema:'version'};
  // layer 1 (privilege): the runtime role holds no UPDATE, DELETE or TRUNCATE on a member-set table
  for(const table of ALL_TABLES){
    await refused(rt.query(`UPDATE public.${table} SET ${column[table]}=${column[table]}`),DENIED).catch(error=>{throw Error(table+': '+error.message);});
    await refused(rt.query(`DELETE FROM public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table} CASCADE`),DENIED);
  }
  // layer 2 (trigger): a role that holds UPDATE and DELETE still meets the guard, with and without a WHERE clause and for a no-op update
  for(const table of ALL_TABLES){
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
  // an upsert or a MERGE that would rewrite a stored row meets the UPDATE guard
  await refused(dl.query(`INSERT INTO public.mp_member_set_members(member_set_id,ordinal,owner_id,bot_id,pine_import_id,source_version,source_hash,effective_inputs_hash,deployment_id,deployment_snapshot_hash,exit_version,evidence_hash)
    SELECT member_set_id,ordinal,owner_id,bot_id,pine_import_id,source_version,source_hash,effective_inputs_hash,deployment_id,deployment_snapshot_hash,exit_version,evidence_hash FROM public.mp_member_set_members LIMIT 1
    ON CONFLICT (member_set_id,ordinal) DO UPDATE SET source_version=excluded.source_version`),QR002);
  await refused(dl.query('MERGE INTO public.mp_member_sets t USING (SELECT $1::uuid AS id) s ON t.member_set_id=s.id WHEN MATCHED THEN UPDATE SET funding_cutoff=0',[set.member_set_id]),QR002);
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await dl.query(`UPDATE public.mp_member_set_members SET ordinal=1 WHERE deployment_id='no-such-deployment'`)).rowCount,0);
  assert.deepEqual(await allDigests(db),before,'no refusal changed a row');
  assert.ok((await guardRows(db)).every(row=>row.tgenabled==='A'));
  // an INSERT under the replica role still meets the insert guards
  const other=await setOf(await newWorld());
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await insertParent(db,other);await insertMember(db,other,other.members[0],{source_hash:'8'.repeat(64)});},{isolation:'SERIALIZABLE'}),QR004);
});

test('a session TEMP table named like a pine or member-set table fools neither the guards nor the freeze',async()=>{
  const done=await setOf(await newWorld());await freeze(rt,done);
  const live=await setOf(await newWorld());
  // TEMP copies of the pine tables the guard reads, empty or flipped, must not change what the member guard reads
  await refusedWith(rt.transaction(async()=>{
    for(const table of ['pine_deployments','pine_memberships','pine_source_revisions','pine_bridge_evidence','mp_member_sets'])await rt.query(`CREATE TEMP TABLE ${table}(LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await rt.query("INSERT INTO pg_temp.pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,'{}',$4,'DRAFT',0)",
      [live.members[0].deployment_id,live.owner_id,live.members[0].pine_import_id,live.members[0].deployment_snapshot_hash]);
    await insertParent(rt,live);
    await insertMember(rt,live,live.members[0],{source_hash:'7'.repeat(64)});
  }),QR004,/equal the member of the stored record/);
  // a writer that qualifies its own insert works with TEMP tables of the same names in front: the guards read the real tables
  await rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE pine_deployments(x integer) ON COMMIT DROP');await rt.query('CREATE TEMP TABLE mp_member_set_members(x integer) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await insertSet(rt,live);
  });
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_set_members WHERE member_set_id=$1',[live.member_set_id])).rows[0].n,2);
  // the freeze still fires for the real table whatever search_path says, and a TEMP function cannot replace a pinned call
  await refused(dl.transaction(async()=>{
    await dl.query('CREATE TEMP TABLE mp_member_sets(x integer) ON COMMIT DROP');await dl.query('SET LOCAL search_path = pg_temp, public');
    await dl.query('UPDATE public.mp_member_sets SET funding_cutoff=funding_cutoff');
  }),QR002);
  await refused(dl.transaction(async()=>{
    await dl.query("CREATE FUNCTION pg_temp.raise_exception() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$");
    await dl.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await dl.query('DELETE FROM public.mp_member_set_members');
  }),QR002);
  assert.equal((await classifyMpMemberSet(db)).state,'INSTALLED');
  // a TEMP member table in front cannot hide a missing member from the completeness check
  const incomplete=await setOf(await newWorld());
  const failure=await rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE mp_member_set_members(x integer) ON COMMIT DROP');
    await rt.query('SET LOCAL search_path = pg_temp, public');
    await insertSet(rt,incomplete,{skip:[1]});
  }).then(()=>null,error=>error);
  assert.equal(failure?.code,QR004);assert.equal(failure.constraint,COMPLETE_GUARD);
});

/* ---- 8. concurrency ---- */

test('race: two SERIALIZABLE writers of the same content serialize on the content key; exactly one set is stored, the other loads',async()=>{
  const world=await newWorld(),first=await setOf(world),second=await setOf(world);
  assert.notEqual(first.member_set_id,second.member_set_id);assert.equal(first.content_digest,second.content_digest);
  const inside=gate(),release=gate();
  const writerA=rt.transaction(async()=>{await insertSet(rt,first);inside.open();await release.promise;});
  await inside.promise;
  const waiting=()=>`SELECT count(*)::int n FROM pg_locks WHERE NOT granted AND locktype='transactionid'`;
  const writerB=rt2.transaction(async()=>insertSet(rt2,second)).then(()=>'WROTE',error=>error);
  await until(async()=>(await db.query(waiting())).rows[0].n>=1,'writer B to wait for the content key');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_sets WHERE owner_id=$1',[world.id])).rows[0].n,0,'nothing of A is visible before it commits');
  release.open();await writerA;
  const result=await writerB;
  assert.ok(result instanceof Error,'writer B refused');assert.ok([UNIQUE_VIOLATION,SERIALIZATION_FAILURE].includes(result.code),result.code+': '+result.message);
  const rows=(await db.query('SELECT member_set_id FROM public.mp_member_sets WHERE owner_id=$1',[world.id])).rows;
  assert.deepEqual(rows,[{member_set_id:first.member_set_id}],'the winner is the only stored set (writer B loads it)');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_member_set_members WHERE member_set_id=$1',[second.member_set_id])).rows[0].n,0,'the loser left no member row');
  // the winner rolls back instead: the waiting writer then stores its own set
  const fresh=await newWorld(),a=await setOf(fresh),b=await setOf(fresh);
  const held=gate(),letGo=gate();
  const loser=rt.transaction(async()=>{await insertSet(rt,a);held.open();await letGo.promise;throw new Rollback();}).then(()=>null,error=>error);
  await held.promise;
  const stays=rt2.transaction(async()=>insertSet(rt2,b)).then(()=>'WROTE',error=>error);
  await until(async()=>(await db.query(waiting())).rows[0].n>=1,'writer B to wait for the rolled-back writer');
  letGo.open();assert.ok((await loser) instanceof Rollback);
  assert.equal(await stays,'WROTE');
  assert.deepEqual((await db.query('SELECT member_set_id FROM public.mp_member_sets WHERE owner_id=$1',[fresh.id])).rows,[{member_set_id:b.member_set_id}]);
});

/* ---- 9. CLI ---- */

test('the CLI: install, second install, --inspect exit codes, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=track(new PostgresDatabase({connectionString:cliUrl,max:2}));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  const badRole=await inspect(['--runtime-role=no_such_role_mp']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/Multi-Pine member-set tables ready: mp-member-set-v1-schema; state=INSTALLED; previous state=ABSENT; guards=11/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  const ungranted=await inspect(['--runtime-role='+roleName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('RUNTIME_ROLE_PRIVILEGE_MISSING:mp_member_sets:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(roleName));
  const granted=await inspect(['--runtime-role='+roleName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.filter(item=>item.table==='mp_member_sets'||item.table==='mp_member_set_schema').map(item=>[item.table,item.insert,item.update,item.delete]).sort(),
    [['mp_member_set_schema',false,false,false],['mp_member_sets',true,false,false]]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.mp_member_sets DISABLE TRIGGER mp_member_sets_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.mp_member_sets ENABLE ALWAYS TRIGGER mp_member_sets_no_change');
  assert.equal((await inspect()).code,0);
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--bogus'],['--runtime-role=Bad-Name']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await memberSetObjects(cliDb),NONE);
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
});

/* ---- 10. rollback with rows, Pine Bridge coupling, dump and restore ---- */

test('rollback: empty tables are dropped completely; a set row refuses it and stays; the Pine Bridge tables cannot be dropped while the extension is installed',async()=>{
  const name=await clone('rollback');
  const target=track(new PostgresDatabase({connectionString:serialOf(name),max:3}));
  const targetStore=new Store(target);
  const world=await newWorld({target,targetStore});
  const baseline=await catalogDigest(target);
  await migrateMpMemberSet(target);
  // the foreign keys couple the Pine Bridge extension to this one (RK6): its tables cannot be dropped while the member-set tables exist
  for(const [table,constraint] of [['pine_deployments','mp_member_set_members_deployment_fkey'],['pine_source_revisions','mp_member_set_members_revision_fkey']])
    await assert.rejects(target.query('DROP TABLE public.'+table),error=>error.code==='2BP01'&&error.detail.includes(constraint),table);
  const rolled=await rollbackMpMemberSet(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await memberSetObjects(target),NONE);
  assert.deepEqual((await catalogDigest(target)).n,baseline.n,'the catalog is back to the baseline object count');
  assert.deepEqual(await rollbackMpMemberSet(target),{rolled_back:true,previous_state:'ABSENT'});
  await migrateMpMemberSet(target);
  const set=await setOf(world);
  await target.transaction(()=>insertSet(target,set),{isolation:'SERIALIZABLE'});
  const held=await allDigests(target),objects=await catalogDigest(target);
  await assert.rejects(rollbackMpMemberSet(target),/rollback refused; 3 record row\(s\) exist in mp_member_sets, mp_member_set_members \(no change made\)/);
  assert.deepEqual(await allDigests(target),held,'the record rows are still there');assert.deepEqual(await catalogDigest(target),objects,'nothing else changed');
  assert.equal((await classifyMpMemberSet(target)).state,'INSTALLED');
  // a writer that holds a row in an open transaction blocks the rollback from counting past it (ACCESS EXCLUSIVE), then the count sees it
  const emptyName=await clone('rollback2');
  const second=track(new PostgresDatabase({connectionString:serialOf(emptyName),max:3}));
  const secondStore=new Store(second);
  const lateWorld=await newWorld({target:second,targetStore:secondStore});
  await migrateMpMemberSet(second);
  const lateSet=await setOf(lateWorld);
  const insert=gate(),finish=gate();
  const writer=second.transaction(async()=>{await insertSet(second,lateSet);insert.open();await finish.promise;},{isolation:'SERIALIZABLE'});
  await insert.promise;
  const waiting=rollbackMpMemberSet(track(new PostgresDatabase({connectionString:urlOf(emptyName),max:2})));
  const settled=waiting.then(()=>'DROPPED',error=>error.message);
  finish.open();await writer;
  assert.match(await settled,/rollback refused; 3 record row\(s\) exist in mp_member_sets, mp_member_set_members \(no change made\)/);
});

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS, the rows and the grants',async t=>{
  const restoredName='robot_mp_restore_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-mp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'mp.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=track(new PostgresDatabase({connectionString:serialOf(restoredName)})),restoredDeleter=track(new PostgresDatabase({connectionString:serialOf(restoredName,deleterName)}));
  const restoredRuntime=track(new PostgresDatabase({connectionString:serialOf(restoredName,roleName)}));
  assert.deepEqual(await guardRows(restored),await guardRows(db));assert.equal((await guardRows(restored)).length,11);assert.ok((await guardRows(restored)).every(row=>row.tgenabled==='A'));
  assert.deepEqual(await allDigests(restored),await allDigests(db),'every stored row came back');
  assert.equal((await classifyMpMemberSet(restored)).state,'INSTALLED');
  const report=await inspectMpMemberSet(restored,{runtimeRole:roleName});assert.equal(report.ok,true,report.failures.join());
  await refused(restoredRuntime.query('UPDATE public.mp_member_sets SET funding_cutoff=funding_cutoff'),DENIED);
  await refused(restoredDeleter.query('UPDATE public.mp_member_sets SET funding_cutoff=funding_cutoff'),QR002);
  await refused(restoredDeleter.query('DELETE FROM public.mp_member_set_members'),QR002);
  // the insert guards and the deferred check survive the restore (a new owner and set in the restored database)
  const world=await newWorld({target:restored,targetStore:new Store(restored)}),set=await setOf(world);
  await restoredRuntime.transaction(()=>insertSet(restoredRuntime,set),{isolation:'SERIALIZABLE'});
  const late=await setOf(await newWorld({target:restored,targetStore:new Store(restored)}));
  await refusedWith(restoredRuntime.transaction(()=>insertSet(restoredRuntime,late,{skip:[1]}),{isolation:'SERIALIZABLE'}),QR004,/exactly pine_count member rows/);
  await refusedWith(restoredRuntime.transaction(()=>insertMember(restoredRuntime,set,set.members[0],{source_hash:'6'.repeat(64)}),{isolation:'SERIALIZABLE'}),QR004,/equal the member of the stored record/);
});
