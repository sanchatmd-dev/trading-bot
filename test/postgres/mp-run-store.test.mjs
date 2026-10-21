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
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {classifyMpMemberSet,inspectMpMemberSet,migrateMpMemberSet,rollbackMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {RUN_STORE_GUARDS,RUN_STORE_MARKER,RUN_STORE_TABLES,MARKER_TABLE,QR004_GUARDS,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,
  classifyMpRunStore,inspectMpRunStore,migrateMpRunStore,rollbackMpRunStore} from '../../src/postgres/mp-run-store-migration.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {buildMemberSet} from '../../src/multi-pine/member-set.js';
import {buildMultiResearchContract} from '../../src/multi-pine/run-contract.js';
import {RULES} from '../../src/quant-research/contract.js';

// F11-01 RS-1: the internal multi-Pine run store (insert-only run and run-event tables), proven on a throwaway PostgreSQL cluster as real non-owner LOGIN roles
// with the repo grant scripts: the runtime role (no privilege on the run store) and the fixture role (SELECT and INSERT). Every row is a LABELLED FIXTURE
// (fixture=true, synthetic, never a research result). Rows are insert-only, so each case that commits uses its own owner; guard negatives run in a
// transaction that is always rolled back. There is no writer module, service, route or worker in this slice: the cases write SQL directly.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501',CHECK_VIOLATION='23514',FK_VIOLATION='23503',UNIQUE_VIOLATION='23505',NOT_NULL='23502',DEPENDENT='2BP01';
const CLI='scripts/migrate-mp-run-store.mjs';
const GRANT_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const FIXTURE_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url));
const G_RUN='mp_research_runs_guard',G_STALE='mp_research_runs_set_stale',G_COMPLETE='mp_research_runs_complete',G_ORDER='mp_research_run_events_order',G_RESULT='mp_research_run_events_result',
  G_TRANSITION='mp_research_run_events_transition';
const T0=1790000000000,UTC='2026-10-20T10:00:00Z',T0MS=1790000000000;
const RUN_TABLES=[...RUN_STORE_TABLES],ALL_TABLES=[MARKER_TABLE,...RUN_STORE_TABLES];
let admin,db,rt,fx,dl,tr,connectionString,templateName,databaseName,runtimeName,fixtureName,deleterName,truncaterName,store;
const databases=[],pools=[],extraRoles=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every run-store writer is SERIALIZABLE (QR003 otherwise): the pools of the writers default to it for autocommit statements (a connection option) and their
// transactions default to it (ser). A case that proves a refusal opens its transaction at another level explicitly.
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let text=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))text=text.replaceAll(":'"+variable+"'","'"+value+"'");return text;};
const grantScript=role=>roleScript(GRANT_SCRIPT,{runtime_role:role});
const fixtureScript=(runtime,fixture)=>roleScript(FIXTURE_SCRIPT,{runtime_role:runtime,fixture_role:fixture});
const refused=(promise,code)=>assert.rejects(promise,{code});
const refusedWith=(promise,code,message)=>assert.rejects(promise,error=>error.code===code&&message.test(error.message));
const track=pool=>{pools.push(pool);return pool;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};

/** A database built from the template (base schema 14, the Pine Bridge extension and the member-set extension; no run-store objects). */
async function clone(label){
  const name='robot_rs_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  return name;
}
async function newRole(label,attributes='NOSUPERUSER NOCREATEDB NOCREATEROLE',login=false){
  const name='robot_rs_'+label+'_'+randomUUID().replaceAll('-','').slice(0,12);extraRoles.push(name);
  await admin.query('CREATE ROLE '+name+(login?' LOGIN ':' ')+attributes+(login?rolePasswordClause():''));
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
const runStoreObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND (relname LIKE 'mp\\_research\\_run%' OR relname LIKE 'mp\\_run\\_store%')) relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'mp\\_run\\_store\\_%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE 'mp\\_research\\_run%' OR tgname LIKE 'mp\\_run\\_store%')) triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0},ALL={relations:7,functions:9,triggers:15};
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgname LIKE 'mp\\_research\\_run%' OR t.tgname LIKE 'mp\\_run\\_store%') ORDER BY t.tgname`)).rows;
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const allDigests=async target=>Object.fromEntries(await Promise.all(ALL_TABLES.map(async table=>[table,await rowDigest(target,table)])));
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;
const dbClockMs=async target=>Number((await target.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms')).rows[0].ms);

/* ---- fixtures: pine rows, S1 member sets and S2 run contracts (labelled, synthetic) ---- */

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const evidenceFor=(snapshot,snapshotHash,tag)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(MODEL),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});

/** One owner (also the Bot) with COUNT connected members, each with a source revision, a DRAFT deployment and Bridge evidence, all inserted by the schema owner. */
async function newWorld({count=2,exit='bridge-exit-v2',target=db,targetStore=store}={}){
  const user=await targetStore.createUser({email:'rs-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=user;
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
async function setOf(world,{id=randomUUID(),created_at=UTC}={}){
  const out=buildMemberSet({...await rowsOf(world),fixture:true,member_set_id:id,created_at,member_deployments:namesOf(world)});
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.member_set;
}
const PARENT_SQL=`INSERT INTO public.mp_member_sets(member_set_id,owner_id,bot_id,version,pine_count,membership_hash,content_digest,set_hash,execution_model_hash,policy_hash,capital_basis_hash,
  funding_cutoff,bridge_atr_multiplier,bridge_rr,exit_version,same_bar_order,fixture,record,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`;
const MEMBER_SQL=`INSERT INTO public.mp_member_set_members(member_set_id,ordinal,owner_id,bot_id,pine_import_id,source_version,source_hash,effective_inputs_hash,deployment_id,deployment_snapshot_hash,
  exit_version,evidence_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
function parentRow(set,over={}){
  return {member_set_id:set.member_set_id,owner_id:set.owner_id,bot_id:set.bot_id,version:set.version,pine_count:set.pine_count,membership_hash:set.membership_hash,content_digest:set.content_digest,
    set_hash:set.set_hash,execution_model_hash:set.execution_model_hash,policy_hash:set.policy_hash,capital_basis_hash:set.capital_basis_hash,funding_cutoff:set.funding_cutoff,
    bridge_atr_multiplier:set.bridge_pair.atr_multiplier,bridge_rr:set.bridge_pair.rr,exit_version:set.exit_version,same_bar_order:set.same_bar_order,fixture:set.fixture,record:set,
    created_at_utc:set.created_at,...over};
}
const parentValues=row=>[row.member_set_id,row.owner_id,row.bot_id,row.version,row.pine_count,row.membership_hash,row.content_digest,row.set_hash,row.execution_model_hash,row.policy_hash,
  row.capital_basis_hash,row.funding_cutoff,row.bridge_atr_multiplier,row.bridge_rr,row.exit_version,row.same_bar_order,row.fixture,typeof row.record==='string'?row.record:JSON.stringify(row.record),row.created_at_utc];
const insertParent=(target,set,over={})=>target.query(PARENT_SQL,parentValues(parentRow(set,over)));
const insertMember=(target,set,member)=>target.query(MEMBER_SQL,[set.member_set_id,member.ordinal,set.owner_id,set.bot_id,member.pine_import_id,member.source_version,member.source_hash,member.effective_inputs_hash,
  member.deployment_id,member.deployment_snapshot_hash,member.exit_version,member.evidence_hash]);
async function insertSet(target,set,{parent={}}={}){
  await insertParent(target,set,parent);
  for(const member of set.members)await insertMember(target,set,member);
}
const freeze=(target,set)=>target.transaction(()=>insertSet(target,set),{isolation:'SERIALIZABLE'});
/** A fresh world with a frozen (committed) member set, written by the given pool. */
async function committedSet({count=2,target=fx,world}={}){
  const w=world??await newWorld({count,target:db});
  const set=await setOf(w);
  await freeze(target,set);
  return {world:w,set};
}
async function addMembership(world,connected=true,target=db){
  const id=randomUUID(),hashOf=hash('source-'+id),analysis={effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i3'}]};
  await target.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[id,world.id,hashOf,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
  await target.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[id,hashOf,'//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
  await target.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$2,1,$3)',[id,world.id,connected]);
}

const START=29333333*60000,BARS=5000;
function contractOf(set){
  const built=buildMultiResearchContract({member_set:structuredClone(set),member_set_id:set.member_set_id,set_hash:set.set_hash,membership_hash:set.membership_hash,pine_count:set.pine_count,
    members:structuredClone(set.members),owner_id:set.owner_id,bot_id:set.bot_id,policy_hash:set.policy_hash,funding_cutoff:set.funding_cutoff,capital_accounts:structuredClone(CAPITAL),
    model:structuredClone(MODEL),rules:structuredClone(RULES),engine_hash:hash('engine'),dataset:{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,content_digest:hash('digest')},
    budget:{candidates:30},seed:42,bridge_domains:{atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'}},fixture:true});
  assert.equal(built.ok,true,JSON.stringify(built));
  return built.contract;
}
const RUN_COLUMNS=['run_id','owner_id','bot_id','member_set_id','set_hash','membership_hash','pine_count','contract_version','contract','contract_hash','idempotency_key','submission_hash','engine_hash',
  'dataset_content_digest','created_at_ms','deadline_ms','fixture'];
const RUN_SQL=`INSERT INTO public.mp_research_runs(${RUN_COLUMNS.join(',')}) VALUES(${RUN_COLUMNS.map((_,index)=>'$'+(index+1)).join(',')})`;
/** A run row for a frozen set: the S2 contract built from it, hashes derived with the application recipe. over replaces columns (contract as an object or raw text). */
function makeRun(set,over={}){
  const contract=contractOf(set);
  return {run_id:randomUUID(),owner_id:set.owner_id,bot_id:set.bot_id,member_set_id:set.member_set_id,set_hash:set.set_hash,membership_hash:set.membership_hash,pine_count:set.pine_count,
    contract_version:contract.version,contract,contract_hash:hash(canonical(contract)),idempotency_key:'key-'+randomUUID().replaceAll('-',''),submission_hash:hash('submission-'+randomUUID()),
    engine_hash:contract.engine_hash,dataset_content_digest:contract.dataset.content_digest,created_at_ms:T0MS,deadline_ms:T0MS+600000,fixture:true,...over};
}
const withContract=(row,mutate)=>{const contract=structuredClone(row.contract);mutate(contract);return {...row,contract};};
const runValues=row=>RUN_COLUMNS.map(name=>name==='contract'&&typeof row.contract!=='string'?JSON.stringify(row.contract):row[name]);
const insertRun=(target,row)=>target.query(RUN_SQL,runValues(row));
const resultOf=row=>({run_id:row.run_id,contract_hash:row.contract_hash,owner_recommendation_ready:false,acceptance_blockers:[...row.contract.acceptance_blockers],fixture:true});
function eventFields(status,row){
  if(status==='SUCCEEDED'||status==='NO_VALID_CANDIDATE'){const result=resultOf(row);return {result,result_hash:hash(canonical(result)),reason_code:null};}
  if(['FAILED','CANCELLED','TIMED_OUT'].includes(status))return {result:null,result_hash:null,reason_code:'FIXTURE_'+status};
  return {result:null,result_hash:null,reason_code:null};
}
const EVENT_SQL='INSERT INTO public.mp_research_run_events(run_id,seq,status,at_ms,reason_code,result,result_hash) VALUES($1,$2,$3,$4,$5,$6,$7)';
/** One event; fields follow the status unless over replaces them (result as an object or raw text, run_id for an event of another run). */
const insertEvent=(target,row,seq,status,over={})=>{
  const e={at_ms:1,...eventFields(status,row),...over};
  return target.query(EVENT_SQL,[e.run_id??row.run_id,seq,status,e.at_ms,e.reason_code,e.result===null?null:typeof e.result==='string'?e.result:JSON.stringify(e.result),e.result_hash]);
};
/** The run row, then the events of the given statuses at seq 1.. in order (the first is ADMITTED). */
async function walk(target,row,statuses=['ADMITTED']){
  await insertRun(target,row);
  for(const [index,status] of statuses.entries())await insertEvent(target,row,index+1,status);
}
const admit=async(target,row,statuses=['ADMITTED'])=>{await target.transaction(()=>walk(target,row,statuses),{isolation:'SERIALIZABLE'});return row;};
const PATH_TO={ADMITTED:['ADMITTED'],RUNNING:['ADMITTED','RUNNING'],SUCCEEDED:['ADMITTED','RUNNING','SUCCEEDED'],NO_VALID_CANDIDATE:['ADMITTED','RUNNING','NO_VALID_CANDIDATE'],
  FAILED:['ADMITTED','RUNNING','FAILED'],CANCELLED:['ADMITTED','RUNNING','CANCELLED'],TIMED_OUT:['ADMITTED','RUNNING','TIMED_OUT']};
const STATUSES=Object.keys(PATH_TO),TERMINAL=['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT'];
const EDGES={ADMITTED:['RUNNING','FAILED','CANCELLED','TIMED_OUT'],RUNNING:TERMINAL};

async function cli(args=[],url=connectionString){
  try{
    const {stdout,stderr}=await run(process.execPath,[CLI,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}});
    return {code:0,stdout,stderr};
  }catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}
/** One application of a psql script on its own connection, as psql does; a failed one leaves nothing behind. */
async function apply(url,script){
  const client=new pg.Client({connectionString:url});await client.connect();
  try{await client.query(script);}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{await client.end();}
}
/** A database from the template with the run store installed and its own pool (owner/superuser). */
async function cloneWithStore(label){
  const name=await clone(label);
  const target=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:4})));
  await migrateMpRunStore(target);
  return {name,target,targetStore:new Store(target)};
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_rs_tpl_'+suffix;databaseName='robot_rs_main_'+suffix;
  runtimeName='robot_rs_rt_'+suffix.slice(0,14);fixtureName='robot_rs_fx_'+suffix.slice(0,14);deleterName='robot_rs_del_'+suffix.slice(0,14);truncaterName='robot_rs_trn_'+suffix.slice(0,14);
  for(const name of [runtimeName,fixtureName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    await install(builder,'pine-bridge-schema.sql');
    await migrateMpMemberSet(builder);
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
    for(const name of [...extraRoles,runtimeName,fixtureName,deleterName,truncaterName])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. install lifecycle (T-RS-S1, T-RS-X1) ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing; the module constants are the plan',async()=>{
  const before=await catalogDigest(db);
  const classification=await classifyMpRunStore(db);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectMpRunStore(db);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.facts.member_set_state,'INSTALLED');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectMpRunStore(db,{runtimeRole:'no_such_role_rs'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.equal((await inspectMpRunStore(db,{fixtureRole:'no_such_role_rs'})).failures.includes('FIXTURE_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(db),before,'an inspection changes nothing');
  assert.deepEqual(await runStoreObjects(db),NONE);
  assert.equal(RUN_STORE_GUARDS.length,15);
  assert.deepEqual([...RUN_STORE_TABLES],['mp_research_runs','mp_research_run_events']);
  assert.deepEqual([...QR004_GUARDS],[G_RUN,G_STALE,G_COMPLETE,G_ORDER,G_RESULT,G_TRANSITION]);
  assert.deepEqual([QR002,QR003,QR004],['QR002','QR003','QR004']);
  assert.equal(RUN_STORE_MARKER,'mp-run-store-v1-schema');
  // The SQL file: only the RC-25 SQLSTATE plan, no SECURITY DEFINER, and no reference to a one-Pine, package or comparison table.
  const text=await sqlText('mp-run-store.sql');
  assert.deepEqual([...new Set([...text.matchAll(/ERRCODE = '([A-Z0-9]+)'/g)].map(match=>match[1]))].sort(),['QR002','QR003','QR004']);
  assert.doesNotMatch(text,/SECURITY DEFINER/i);
  const code=text.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(code,/quant_|\bbi_|ql4c|deployment_id TEXT|pine_import_id TEXT|\bqr_/,'the extension references no one-Pine, package, comparison or selection table and stores no deployment_id column');
});

test('absent: the install needs the member-set extension INSTALLED; a same-name foreign object classifies OTHER; nothing is written',async()=>{
  // No member-set extension at all, and a tampered member-set extension: refused before any write.
  const bareName='robot_rs_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));
  await bare.migrate();
  const bareBefore=await catalogDigest(bare);
  await assert.rejects(migrateMpRunStore(bare),/member-set extension 1 required/);
  assert.deepEqual(await catalogDigest(bare),bareBefore);
  const brokenName=await clone('nomember');
  const broken=track(new PostgresDatabase({connectionString:urlOf(brokenName),max:2}));
  await broken.query('ALTER TABLE public.mp_member_sets DISABLE TRIGGER mp_member_sets_no_change');
  const brokenBefore=await catalogDigest(broken);
  await assert.rejects(migrateMpRunStore(broken),/the member-set extension must be INSTALLED, found OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(broken),brokenBefore);
  assert.deepEqual(await runStoreObjects(broken),NONE);
  const noop="CREATE FUNCTION public.mp_run_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign runs table','CREATE TABLE public.mp_research_runs(x integer)','TABLE_DEFINITION:mp_research_runs:'],
    ['foreign events table','CREATE TABLE public.mp_research_run_events(x integer)','TABLE_DEFINITION:mp_research_run_events:'],
    ['foreign marker table','CREATE TABLE public.mp_run_store_schema(version integer)','TABLE_DEFINITION:mp_run_store_schema:'],
    ['foreign marker function',"CREATE FUNCTION public.mp_run_store_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:mp_run_store_version:'],
    ['overload of the freeze function','CREATE FUNCTION public.mp_run_store_freeze(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:mp_run_store_freeze('],
    ['view carrying an index name','CREATE VIEW public.mp_research_runs_pkey AS SELECT 1 AS x','RELATION_UNEXPECTED:mp_research_runs_pkey'],
    ['sequence carrying an index name','CREATE SEQUENCE public.mp_research_run_events_pkey','RELATION_UNEXPECTED:mp_research_run_events_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.mp_research_runs AS integer','TYPE_UNEXPECTED:mp_research_runs'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER mp_research_runs_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.mp_run_noop()','TRIGGER_UNEXPECTED:mp_research_runs_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{await db.query(statement);return {classification:await classifyMpRunStore(db),report:await inspectMpRunStore(db)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  }
  assert.deepEqual(await runStoreObjects(db),NONE,'every probe was rolled back');
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, other tables and grants stay as they were; a second install is a no-op; the member-set classifier stays INSTALLED',async()=>{
  const baseTables=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await db.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')
    AND c.relname NOT LIKE 'mp\\_research\\_run%' AND c.relname NOT LIKE 'mp\\_run\\_store%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const memberTriggers=async()=>(await db.query(`SELECT t.tgname,t.tgenabled FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'mp\\_member\\_set%' ORDER BY 1`)).rows;
  const memberBefore=await memberTriggers();
  assert.equal((await classifyMpMemberSet(db)).state,'INSTALLED');
  const report=await migrateMpRunStore(db,{runtimeRole:runtimeName}).catch(error=>error);
  assert.ok(!(report instanceof Error),String(report));assert.equal(report.ok,true,report.failures?.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,RUN_STORE_MARKER);assert.equal(report.facts.guards.length,15);assert.equal(report.facts.member_set_state,'INSTALLED');
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(name=>!baseTables.includes(name)),
    [...ALL_TABLES].sort(),'exactly the three run-store tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  assert.deepEqual(await runStoreObjects(db),ALL,'three tables, four indexes, nine functions and fifteen triggers');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await db.query('SELECT version FROM mp_run_store_schema')).rows,[{version:1}]);
  assert.equal((await db.query('SELECT public.mp_run_store_version() v')).rows[0].v,RUN_STORE_MARKER);
  assert.deepEqual((await guardRows(db)).map(row=>[row.tgname,row.tgenabled,row.tgtype]).sort(),RUN_STORE_GUARDS.map(item=>[item[0],'A',item[3]]).sort());
  assert.equal(RUN_STORE_GUARDS.filter(item=>item[2]==='mp_run_store_freeze').length,6,'a row and a statement freeze trigger on each of the three tables');
  assert.equal(RUN_STORE_GUARDS.filter(item=>item[2]==='mp_run_store_require_serializable').length,3,'a SERIALIZABLE insert trigger on each of the three tables');
  assert.ok((await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'mp\\_run\\_store\\_%'`)).rows
    .every(row=>row.prosecdef===false&&row.proconfig.length===1&&row.proconfig[0]==='search_path=pg_catalog, pg_temp'),'every function is SECURITY INVOKER with the pinned search_path');
  const deferred=(await db.query("SELECT tgdeferrable,tginitdeferred,tgconstraint<>0 AS constraint_trigger FROM pg_trigger WHERE tgname='mp_research_runs_complete'")).rows;
  assert.deepEqual(deferred,[{tgdeferrable:true,tginitdeferred:true,constraint_trigger:true}],'the completeness check is a deferred constraint trigger');
  // T-RS-X3 (root decision S5): the foreign keys add internal triggers to mp_member_sets and users; the member-set classifier ignores them and stays INSTALLED.
  const member=await classifyMpMemberSet(db);
  assert.equal(member.state,'INSTALLED',[...member.problems,...member.missing].join());
  const memberReport=await inspectMpMemberSet(db);assert.equal(memberReport.ok,true,memberReport.failures.join());
  assert.deepEqual(await memberTriggers(),memberBefore,'no user trigger was added to a member-set table');
  assert.deepEqual((await db.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relname IN ('users','mp_member_sets','mp_member_set_members')`)).rows
    .map(row=>row.tgname).filter(name=>/mp_research|mp_run_store/.test(name)),[],'no run-store trigger on a table of another extension');
  const settled=await catalogDigest(db);
  const again=await migrateMpRunStore(db,{runtimeRole:runtimeName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(db),settled,'a second install writes nothing, not even a row version');
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
});

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.mp_run_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const R='ALTER TABLE public.mp_research_runs ',E='ALTER TABLE public.mp_research_run_events ';
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const cases=[];
  // every trigger function: its body replaced (the marker function is covered by the dedicated check below)
  for(const name of ['mp_run_store_freeze','mp_run_store_require_serializable','mp_run_store_guard_run','mp_run_store_guard_stale','mp_run_store_guard_complete','mp_run_store_guard_order','mp_run_store_guard_result','mp_run_store_guard_transition'])
    cases.push([name+' body replaced',`CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$`,'FUNCTION_DEFINITION:'+name+':BODY']);
  cases.push(
    ['marker function body replaced',"CREATE OR REPLACE FUNCTION public.mp_run_store_version() RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x'::text $$",'FUNCTION_DEFINITION:mp_run_store_version:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.mp_run_store_guard_run() SECURITY DEFINER','FUNCTION_DEFINITION:mp_run_store_guard_run:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.mp_run_store_guard_stale() RESET search_path','FUNCTION_DEFINITION:mp_run_store_guard_stale:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.mp_run_store_freeze() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:mp_run_store_freeze:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.mp_run_store_freeze() STRICT','FUNCTION_DEFINITION:mp_run_store_freeze:ATTRIBUTES'],
    ['freeze trigger disabled',E+'DISABLE TRIGGER mp_research_run_events_no_change','TRIGGER_NOT_ALWAYS:mp_research_run_events_no_change'],
    ['run guard origin only',R+'ENABLE TRIGGER mp_research_runs_guard','TRIGGER_NOT_ALWAYS:mp_research_runs_guard'],
    ['transition guard replica only',E+'ENABLE REPLICA TRIGGER mp_research_run_events_transition','TRIGGER_NOT_ALWAYS:mp_research_run_events_transition'],
    ['serializable trigger disabled',R+'DISABLE TRIGGER mp_research_runs_00_serializable','TRIGGER_NOT_ALWAYS:mp_research_runs_00_serializable'],
    ['stale guard disabled',R+'DISABLE TRIGGER mp_research_runs_set_stale','TRIGGER_NOT_ALWAYS:mp_research_runs_set_stale'],
    ['deferred check disabled',R+'DISABLE TRIGGER mp_research_runs_complete','TRIGGER_NOT_ALWAYS:mp_research_runs_complete'],
    ['deferred check made immediate',`DROP TRIGGER mp_research_runs_complete ON public.mp_research_runs; CREATE CONSTRAINT TRIGGER mp_research_runs_complete AFTER INSERT ON public.mp_research_runs FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_complete(); ${R}ENABLE ALWAYS TRIGGER mp_research_runs_complete`,'TRIGGER_SHAPE:mp_research_runs_complete'],
    ['deferred check made not initially deferred',`DROP TRIGGER mp_research_runs_complete ON public.mp_research_runs; CREATE CONSTRAINT TRIGGER mp_research_runs_complete AFTER INSERT ON public.mp_research_runs DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_guard_complete(); ${R}ENABLE ALWAYS TRIGGER mp_research_runs_complete`,'TRIGGER_SHAPE:mp_research_runs_complete'],
    ['deferred check made a plain trigger',`${redo('mp_research_runs_complete','mp_research_runs','AFTER INSERT','mp_run_store_guard_complete')} ${R}ENABLE ALWAYS TRIGGER mp_research_runs_complete`,'TRIGGER_SHAPE:mp_research_runs_complete'],
    ['trigger rebound to another function',`${redo('mp_research_runs_guard','mp_research_runs','BEFORE INSERT','mp_run_store_guard_stale')} ${R}ENABLE ALWAYS TRIGGER mp_research_runs_guard`,'TRIGGER_FUNCTION:mp_research_runs_guard'],
    ['freeze trigger narrowed to UPDATE only',`${redo('mp_research_runs_no_change','mp_research_runs','BEFORE UPDATE','mp_run_store_freeze')} ${R}ENABLE ALWAYS TRIGGER mp_research_runs_no_change`,'TRIGGER_SHAPE:mp_research_runs_no_change'],
    ['order guard made AFTER',`${redo('mp_research_run_events_order','mp_research_run_events','AFTER INSERT','mp_run_store_guard_order')} ${E}ENABLE ALWAYS TRIGGER mp_research_run_events_order`,'TRIGGER_SHAPE:mp_research_run_events_order'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER mp_marker AFTER INSERT ON public.mp_run_store_schema FOR EACH ROW EXECUTE FUNCTION public.mp_run_noop()','TRIGGER_UNEXPECTED:mp_marker'],
    ['extra trigger on the events table',noop+' CREATE TRIGGER mp_extra AFTER INSERT ON public.mp_research_run_events FOR EACH ROW EXECUTE FUNCTION public.mp_run_noop()','TRIGGER_UNEXPECTED:mp_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER mp_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.mp_run_store_freeze()','TRIGGER_UNEXPECTED:mp_elsewhere'],
    ['contract ties check dropped',R+'DROP CONSTRAINT mp_research_runs_contract_ties_check','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['contract size cap widened',R+'DROP CONSTRAINT mp_research_runs_contract_size_check, ADD CONSTRAINT mp_research_runs_contract_size_check CHECK(pg_column_size(contract)<=9999999)','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['fixture check dropped',R+'DROP CONSTRAINT mp_research_runs_fixture_check','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['deadline bound widened',R+'DROP CONSTRAINT mp_research_runs_deadline_ms_check, ADD CONSTRAINT mp_research_runs_deadline_ms_check CHECK(deadline_ms>created_at_ms)','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['deadline minimum dropped',R+'DROP CONSTRAINT mp_research_runs_deadline_ms_check, ADD CONSTRAINT mp_research_runs_deadline_ms_check CHECK(deadline_ms>created_at_ms AND deadline_ms<=created_at_ms+900000)','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['deadline minimum raised',R+'DROP CONSTRAINT mp_research_runs_deadline_ms_check, ADD CONSTRAINT mp_research_runs_deadline_ms_check CHECK(deadline_ms>=created_at_ms+60001 AND deadline_ms<=created_at_ms+900000)','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['idempotency key unique constraint dropped',R+'DROP CONSTRAINT mp_research_runs_idempotency_key','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['pine count widened',R+'DROP CONSTRAINT mp_research_runs_pine_count_check, ADD CONSTRAINT mp_research_runs_pine_count_check CHECK(pine_count>=1 AND pine_count<=9)','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['status check widened',E+"DROP CONSTRAINT mp_research_run_events_status_check, ADD CONSTRAINT mp_research_run_events_status_check CHECK(status IN ('ADMITTED','RUNNING','QUEUED'))",'TABLE_DEFINITION:mp_research_run_events:CONSTRAINTS'],
    ['result size cap dropped',E+'DROP CONSTRAINT mp_research_run_events_result_size_check','TABLE_DEFINITION:mp_research_run_events:CONSTRAINTS'],
    ['extra constraint',R+'ADD CONSTRAINT mp_extra CHECK(created_at_ms>=0)','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['foreign key dropped',R+'DROP CONSTRAINT mp_research_runs_set_hash_fkey','TABLE_DEFINITION:mp_research_runs:CONSTRAINTS'],
    ['foreign key made CASCADE',E+'DROP CONSTRAINT mp_research_run_events_run_fkey, ADD CONSTRAINT mp_research_run_events_run_fkey FOREIGN KEY(run_id) REFERENCES public.mp_research_runs(run_id) ON DELETE CASCADE','TABLE_DEFINITION:mp_research_run_events:CONSTRAINTS'],
    ['primary key of the events dropped',E+'DROP CONSTRAINT mp_research_run_events_pkey','INDEX_MISSING:mp_research_run_events_pkey'],
    ['extra index','CREATE INDEX mp_extra ON public.mp_research_runs(set_hash)','TABLE_DEFINITION:mp_research_runs:INDEXES'],
    ['column default added',R+'ALTER COLUMN created_at_ms SET DEFAULT 0','TABLE_DEFINITION:mp_research_runs:COLUMNS'],
    ['column made optional',E+'ALTER COLUMN at_ms DROP NOT NULL','TABLE_DEFINITION:mp_research_run_events:COLUMNS'],
    ['column added',R+'ADD COLUMN status text','TABLE_DEFINITION:mp_research_runs:COLUMNS'],
    ['deployment_id column added',R+'ADD COLUMN deployment_id text','TABLE_DEFINITION:mp_research_runs:COLUMNS'],
    ['column type changed',E+'ALTER COLUMN seq TYPE bigint','TABLE_DEFINITION:mp_research_run_events:COLUMNS'],
    ['column collation changed (events)',E+'ALTER COLUMN status TYPE text COLLATE "C"','TABLE_DEFINITION:mp_research_run_events:COLLATION'],
    ['column collation changed (runs)',R+'ALTER COLUMN idempotency_key TYPE text COLLATE "POSIX"','TABLE_DEFINITION:mp_research_runs:COLLATION'],
    ['row security enabled',R+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:mp_research_runs:SHAPE'],
    ['rule added','CREATE RULE mp_rule AS ON INSERT TO public.mp_research_run_events DO ALSO NOTHING','TABLE_DEFINITION:mp_research_run_events:SHAPE'],
    ['marker row removed','DELETE FROM public.mp_run_store_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.mp_run_store_schema DROP CONSTRAINT mp_run_store_schema_version_check','TABLE_DEFINITION:mp_run_store_schema:CONSTRAINTS'],
    ['runs table re-owned to another role',R+'OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_research_runs'],
    ['events table re-owned to another role',E+'OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_research_run_events'],
    ['marker table re-owned (every other object then differs from the marker owner)','ALTER TABLE public.mp_run_store_schema OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_research_runs'],
    ['guard function re-owned to another role','ALTER FUNCTION public.mp_run_store_guard_transition() OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_run_store_guard_transition'],
    ['marker table renamed','ALTER TABLE public.mp_run_store_schema RENAME TO mp_renamed','TABLE_MISSING:mp_run_store_schema']);
  // every trigger dropped in turn
  for(const [name,table] of RUN_STORE_GUARDS)cases.push(['trigger '+name+' dropped',`DROP TRIGGER ${name} ON public.${table}`,'TRIGGER_MISSING:'+name]);
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // A tamper may need the freeze trigger out of the way for its own setup statement (DELETE of the marker row); the probe is rolled back.
      if(label==='marker row removed')await db.query('ALTER TABLE public.mp_run_store_schema DISABLE TRIGGER mp_run_store_schema_no_change');
      await db.query(statement);return {classification:await classifyMpRunStore(db),report:await inspectMpRunStore(db)};});
    const all=[...found.classification.problems,...found.classification.missing];
    assert.equal(found.classification.state,'OTHER',label+': '+all.join());
    assert.ok(all.some(item=>item.startsWith(prefix)),label+': '+all.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
    // The member-set classifier does not look at run-store objects: whatever the tamper, it stays INSTALLED.
    assert.equal((await probe(db,async()=>{
      if(label==='marker row removed')await db.query('ALTER TABLE public.mp_run_store_schema DISABLE TRIGGER mp_run_store_schema_no_change');
      await db.query(statement);return (await classifyMpMemberSet(db)).state;})),'INSTALLED','member-set classifier after: '+label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.mp_run_store_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectMpRunStore(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:mp_run_store_version:BODY')));
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED','every tamper was rolled back');
});

test('installed: the internal foreign key triggers are judged on both run-store tables and on every referenced table, one trigger at a time; a tampered member-set key is not this extension\'s business',async()=>{
  const KEY_COUNT=5;
  const keys=(await db.query(`SELECT k.oid AS key_oid,k.conname,c.relname AS child,r.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class r ON r.oid=k.confrelid
    WHERE k.contype='f' AND c.relnamespace='public'::regnamespace AND c.relname LIKE ANY($1) ORDER BY k.conname`,[['mp\\_research\\_run%']])).rows;
  assert.equal(keys.length,KEY_COUNT,'every foreign key of the extension: '+keys.map(key=>key.conname).join());
  assert.deepEqual(keys.map(key=>key.parent).sort(),['mp_member_sets','mp_member_sets','mp_research_runs','users','users']);
  const riOf=async key=>(await db.query(`SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgisinternal AND t.tgconstraint=$1 ORDER BY t.tgname`,[key.key_oid])).rows;
  const tampered=statements=>probe(db,async()=>{for(const statement of statements)await db.query(statement);return {classification:await classifyMpRunStore(db),report:await inspectMpRunStore(db),member:(await classifyMpMemberSet(db)).state};});
  const flagged=(found,child)=>found.classification.problems.some(item=>item.startsWith('TABLE_DEFINITION:'+child+':')&&item.split(':')[2].split('+').includes('FOREIGN_KEY_TRIGGERS'));
  const refusedKey=(found,child,label)=>{
    assert.equal(found.classification.state,'OTHER',label+': '+found.classification.problems.join());
    assert.ok(flagged(found,child),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
  };
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
  for(const key of keys){
    const triggers=await riOf(key);
    assert.equal(triggers.length,4,key.conname+': two triggers on the referencing table and two on the referenced table');
    assert.deepEqual(triggers.map(item=>item.relname).sort(),[key.child,key.child,key.parent,key.parent].sort(),key.conname);
  }
  for(const child of new Set(keys.map(key=>key.child))){
    const found=await tampered(['ALTER TABLE public.'+child+' DISABLE TRIGGER ALL']);
    refusedKey(found,child,'DISABLE TRIGGER ALL on '+child);
    assert.equal(found.member,'INSTALLED','the member-set classifier ignores a tampered run-store table');
  }
  // DISABLE TRIGGER ALL on a referenced table fails closed for every run-store key that points at it.
  for(const parent of new Set(keys.map(key=>key.parent))){
    const found=await tampered(['ALTER TABLE public.'+parent+' DISABLE TRIGGER ALL']);
    for(const child of new Set(keys.filter(key=>key.parent===parent).map(key=>key.child)))assert.ok(flagged(found,child),'referenced '+parent+' -> '+child+': '+found.classification.problems.join());
    assert.equal(found.classification.state,'OTHER','DISABLE TRIGGER ALL on referenced '+parent);assert.equal(found.report.ok,false,parent);
  }
  // One named RI trigger of one key, each of the four in turn: disabled, replica-only, always.
  for(const key of keys){
    const triggers=await riOf(key);
    for(const item of triggers)refusedKey(await tampered(['ALTER TABLE public.'+item.relname+' DISABLE TRIGGER "'+item.tgname+'"']),key.child,'disable '+item.tgname+' of '+key.conname);
    refusedKey(await tampered(['ALTER TABLE public.'+triggers[0].relname+' ENABLE REPLICA TRIGGER "'+triggers[0].tgname+'"']),key.child,'replica-only '+triggers[0].tgname+' of '+key.conname);
    refusedKey(await tampered(['ALTER TABLE public.'+triggers[3].relname+' ENABLE ALWAYS TRIGGER "'+triggers[3].tgname+'"']),key.child,'always '+triggers[3].tgname+' of '+key.conname);
  }
  // Every other foreign key of the database is not judged here: disabling the RI triggers of the keys that are not this extension's leaves it INSTALLED.
  const own=new Set(keys.map(key=>key.conname));
  const others=(await db.query(`SELECT t.tgname,c.relname FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgisinternal AND k.contype='f' AND k.conname<>ALL($1) AND c.relname NOT LIKE 'mp\\_member\\_set%'`,[[...own]])).rows;
  assert.ok(others.length>0,'a foreign key of another table exists to disable');
  const unrelated=await tampered(others.map(item=>'ALTER TABLE public.'+item.relname+' DISABLE TRIGGER "'+item.tgname+'"'));
  assert.equal(unrelated.classification.state,'INSTALLED',unrelated.classification.problems.join());
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED','every tamper was rolled back');
});

test('installed: a derived object that can expose run-store rows classifies OTHER (inheritance, an outside foreign key, a publication, a view, a rule, a materialized view); the run store own keys stay INSTALLED',async()=>{
  const reasonsOf=(found,table)=>found.classification.problems.filter(item=>item.startsWith('TABLE_DEFINITION:'+table+':')).flatMap(item=>item.split(':')[2].split('+'));
  const tamper=statements=>probe(db,async()=>{for(const statement of statements)await db.query(statement);
    return {classification:await classifyMpRunStore(db),report:await inspectMpRunStore(db),member:(await classifyMpMemberSet(db)).state};});
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED','the events key onto the runs table is the extension own key and is no derived object');
  const cases=[
    ['run table made a child of a foreign parent','mp_research_runs','INHERITANCE',['CREATE TABLE public.rs_parent(run_id uuid, owner_id text)','ALTER TABLE public.mp_research_runs INHERIT public.rs_parent']],
    ['events table made a child of a foreign parent','mp_research_run_events','INHERITANCE',['CREATE TABLE public.rs_parent(run_id uuid, seq integer)','ALTER TABLE public.mp_research_run_events INHERIT public.rs_parent']],
    ['foreign child table inheriting from the run table','mp_research_runs','INHERITANCE',['CREATE TABLE public.rs_child() INHERITS (public.mp_research_runs)']],
    ['foreign child table inheriting from the events table','mp_research_run_events','INHERITANCE',['CREATE TABLE public.rs_child() INHERITS (public.mp_research_run_events)']],
    ['foreign key from a table outside the run store onto the runs','mp_research_runs','REFERENCED_BY',['CREATE TABLE public.rs_ref(run_id uuid REFERENCES public.mp_research_runs(run_id))']],
    ['foreign key from a table outside the run store onto the events','mp_research_run_events','REFERENCED_BY',['CREATE TABLE public.rs_ref(run_id uuid, seq integer, FOREIGN KEY(run_id,seq) REFERENCES public.mp_research_run_events(run_id,seq))']],
    ['foreign key from a table outside the run store onto the marker','mp_run_store_schema','REFERENCED_BY',['CREATE TABLE public.rs_ref(version integer REFERENCES public.mp_run_store_schema(version))']],
    ['publication of the runs table','mp_research_runs','PUBLICATION',['CREATE PUBLICATION rs_pub FOR TABLE public.mp_research_runs']],
    ['publication of the events table','mp_research_run_events','PUBLICATION',['CREATE PUBLICATION rs_pub FOR TABLE public.mp_research_run_events']],
    ['publication of every table','mp_research_runs','PUBLICATION',['CREATE PUBLICATION rs_pub FOR ALL TABLES']],
    ['publication of the tables in schema public','mp_research_run_events','PUBLICATION',['CREATE PUBLICATION rs_pub FOR TABLES IN SCHEMA public']],
    ['view over the runs table','mp_research_runs','DEPENDENT_VIEW',['CREATE VIEW public.rs_view AS SELECT run_id,owner_id,contract FROM public.mp_research_runs']],
    ['view over the events table','mp_research_run_events','DEPENDENT_VIEW',['CREATE VIEW public.rs_view AS SELECT run_id,status FROM public.mp_research_run_events']],
    ['view over both tables (a join)','mp_research_runs','DEPENDENT_VIEW',['CREATE VIEW public.rs_view AS SELECT r.run_id,e.status FROM public.mp_research_runs r JOIN public.mp_research_run_events e USING(run_id)']],
    ['view over the marker table','mp_run_store_schema','DEPENDENT_VIEW',['CREATE VIEW public.rs_view AS SELECT version FROM public.mp_run_store_schema']],
    ['materialized view over the runs table','mp_research_runs','DEPENDENT_VIEW',['CREATE MATERIALIZED VIEW public.rs_view AS SELECT run_id,owner_id FROM public.mp_research_runs']],
    ['rule of a foreign table that reads a run-store table','mp_research_runs','DEPENDENT_VIEW',['CREATE TABLE public.rs_sink(n bigint)',
      'CREATE RULE rs_rule AS ON INSERT TO public.rs_sink DO ALSO SELECT run_id FROM public.mp_research_runs']]];
  for(const [label,table,reason,statements] of cases){
    const found=await tamper(statements);
    assert.equal(found.classification.state,'OTHER',label+': '+found.classification.problems.join());
    assert.ok(reasonsOf(found,table).includes(reason),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
    assert.equal(found.member,'INSTALLED','the member-set classifier does not look at run-store derived objects: '+label);
  }
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED','every tamper was rolled back');
});

test('installed: the probe cases of the review (an inherited parent or a view granted to the runtime role by the grant script) are caught by the classifier and the inspection',async()=>{
  const {name,target}=await cloneWithStore('derived');
  const url=urlOf(name);
  const runtime=await newRole('derivedrt','NOSUPERUSER NOCREATEDB NOCREATEROLE',true);
  await apply(url,await grantScript(runtime));
  const asRuntime=track(new PostgresDatabase({connectionString:urlOf(name,runtime),max:2}));
  assert.equal((await inspectMpRunStore(target,{runtimeRole:runtime})).ok,true,'baseline: the runtime role holds nothing');
  await refused(asRuntime.query('SELECT count(*) FROM public.mp_research_runs'),DENIED);
  // The grant script grants ALL TABLES of the schema, so a parent table or a view that the schema owner adds later is readable by the runtime role again, and a privilege
  // check on the run-store tables alone does not see it; the classifier does.
  await target.query('CREATE TABLE public.rs_parent(run_id uuid, owner_id text)');
  await target.query('ALTER TABLE public.mp_research_runs INHERIT public.rs_parent');
  await apply(url,await grantScript(runtime));
  assert.equal((await asRuntime.query('SELECT count(*)::int n FROM public.rs_parent')).rows[0].n,0,'the hole: the runtime role reads through the granted parent');
  const inherited=await classifyMpRunStore(target);
  assert.equal(inherited.state,'OTHER');assert.ok(inherited.problems.some(item=>item.startsWith('TABLE_DEFINITION:mp_research_runs:')&&item.includes('INHERITANCE')),inherited.problems.join());
  const inheritedReport=await inspectMpRunStore(target,{runtimeRole:runtime});
  assert.equal(inheritedReport.ok,false);assert.ok(inheritedReport.failures.some(item=>item.includes('INHERITANCE')),inheritedReport.failures.join());
  await assert.rejects(migrateMpRunStore(target,{runtimeRole:runtime}),/unexpected state OTHER \(no change made\).*INHERITANCE/);
  await assert.rejects(rollbackMpRunStore(target),/unexpected state OTHER \(no change made\).*INHERITANCE/);
  await target.query('ALTER TABLE public.mp_research_runs NO INHERIT public.rs_parent');await target.query('DROP TABLE public.rs_parent');
  assert.equal((await classifyMpRunStore(target)).state,'INSTALLED');
  await target.query('CREATE VIEW public.rs_view AS SELECT run_id,owner_id,contract FROM public.mp_research_runs');
  await apply(url,await grantScript(runtime));
  assert.equal((await asRuntime.query('SELECT count(*)::int n FROM public.rs_view')).rows[0].n,0,'the hole: the runtime role reads through the granted view');
  const viewed=await classifyMpRunStore(target);
  assert.equal(viewed.state,'OTHER');assert.ok(viewed.problems.some(item=>item.startsWith('TABLE_DEFINITION:mp_research_runs:')&&item.includes('DEPENDENT_VIEW')),viewed.problems.join());
  const viewedReport=await inspectMpRunStore(target,{runtimeRole:runtime});
  assert.equal(viewedReport.ok,false);assert.ok(viewedReport.failures.some(item=>item.includes('DEPENDENT_VIEW')),viewedReport.failures.join());
  const cliReport=await cli(['--inspect','--runtime-role='+runtime],url);
  assert.equal(cliReport.code,1,'the CLI inspection exits nonzero: '+cliReport.stderr);assert.match(cliReport.stdout,/DEPENDENT_VIEW/);
  await target.query('DROP VIEW public.rs_view');
  assert.equal((await classifyMpRunStore(target)).state,'INSTALLED','removing the derived object restores INSTALLED');
  assert.equal((await inspectMpRunStore(target,{runtimeRole:runtime})).ok,true);
});

test('offline only: the install and the rollback need the maintenance lock and their own transaction',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateMpRunStore(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackMpRunStore(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateMpRunStore(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackMpRunStore(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
});

test('a foreign or partial install is refused with no write, in both directions',async()=>{
  const foreignName=await clone('foreign'),partialName=await clone('partial');
  const foreign=track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})),partial=track(new PostgresDatabase({connectionString:urlOf(partialName),max:2}));
  await foreign.query('CREATE TABLE public.mp_research_runs(x integer)');await foreign.query('INSERT INTO public.mp_research_runs VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateMpRunStore(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackMpRunStore(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.mp_research_runs')).rows,[{x:7}],'the foreign row survived');
  await migrateMpRunStore(partial);
  await partial.query('DROP TRIGGER mp_research_runs_no_truncate ON public.mp_research_runs');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateMpRunStore(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:mp_research_runs_no_truncate/);
  await assert.rejects(rollbackMpRunStore(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyMpRunStore(partial)).state,'OTHER');
});

/* ---- 2. grants: the runtime role holds nothing, the fixture role reads and inserts (T-RS-X4, root decision S4) ---- */

test('grants: the repository grant script lists the run-store tables as internal_only, and nowhere else (integrator gate)',async()=>{
  const text=await fs.readFile(GRANT_SCRIPT,'utf8');
  const list=name=>{const match=new RegExp(name+' CONSTANT TEXT\\[\\] := ARRAY\\[([^\\]]*)\\]').exec(text);assert.ok(match,name);return [...match[1].matchAll(/'([^']+)'/g)].map(item=>item[1]);};
  const internal=list('internal_only');
  assert.deepEqual([...internal].sort(),[...ALL_TABLES].sort());
  for(const name of ['insert_only','read_only','protected'])for(const table of ALL_TABLES)assert.ok(!list(name).includes(table),table+' is not '+name);
});

test('grants (B2): the runtime role holds no privilege on any run-store table and gets 42501; the fixture role reads and inserts; reapply is idempotent; the inspection judges both roles',async()=>{
  for(const role of [runtimeName,deleterName,truncaterName])await db.query(await grantScript(role));
  await db.query(await fixtureScript(runtimeName,fixtureName));
  // Layer-2 proof roles: the deleter holds UPDATE and DELETE, the truncater TRUNCATE, on every run-store table (granted after the scripts, as a hostile operator could).
  const all=ALL_TABLES.map(table=>'public.'+table).join(',');
  await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${all} TO ${deleterName}`);await db.query(`GRANT SELECT,TRUNCATE ON TABLE ${all} TO ${truncaterName}`);
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,runtimeName),max:4})));fx=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:6})));
  dl=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,deleterName),max:3})));tr=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,truncaterName),max:2})));
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  await db.query(await grantScript(runtimeName));await db.query(await fixtureScript(runtimeName,fixtureName));
  assert.equal(await acl(),first,'a second application of both scripts changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger,
    has_table_privilege($2,oid,'REFERENCES') AS "references",has_any_column_privilege($2,oid,'SELECT') AS column_select FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  const NOTHING={owner:false,select:false,insert:false,update:false,delete:false,truncate:false,trigger:false,references:false,column_select:false};
  for(const table of ALL_TABLES)assert.deepEqual(await facts(runtimeName,'public.'+table),NOTHING,'runtime role on '+table);
  for(const table of RUN_TABLES)assert.deepEqual(await facts(fixtureName,'public.'+table),{...NOTHING,select:true,insert:true,column_select:true},'fixture role on '+table);
  assert.deepEqual(await facts(fixtureName,'public.mp_run_store_schema'),{...NOTHING,select:true,column_select:true},'the marker is read-only for the fixture role');
  assert.equal((await db.query('SELECT pg_has_role($1,$2,$3) AS m',[fixtureName,runtimeName,'MEMBER'])).rows[0].m,true,'the fixture role is a member of the runtime role');
  assert.equal((await db.query('SELECT pg_has_role($1,$2,$3) AS m',[runtimeName,fixtureName,'MEMBER'])).rows[0].m,false,'the runtime role is no member of the fixture role');
  assert.equal((await facts(runtimeName,'public.mp_member_sets')).insert,true,'the runtime grants of the other tables are untouched');
  assert.equal((await facts(deleterName,'public.mp_research_runs')).delete,true);assert.equal((await facts(truncaterName,'public.mp_research_runs')).truncate,true);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[fixtureName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  // The runtime role gets 42501 on every run-store table, for reads and for writes, and cannot change a guard.
  for(const table of ALL_TABLES){
    await refused(rt.query(`SELECT 1 FROM public.${table}`),DENIED).catch(error=>{throw Error(table+' select: '+error.message);});
    await refused(rt.query(`SELECT count(*) FROM public.${table}`),DENIED);await refused(rt.query(`DELETE FROM public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table}`),DENIED);
    await refused(rt.transaction(()=>rt.query(`LOCK TABLE public.${table} IN ACCESS SHARE MODE`)),DENIED);
  }
  await refused(rt.query('INSERT INTO public.mp_research_runs(run_id) VALUES(gen_random_uuid())'),DENIED);
  await refused(rt.query('INSERT INTO public.mp_research_run_events(run_id,seq,status,at_ms) VALUES(gen_random_uuid(),1,$1,1)',['ADMITTED']),DENIED);
  await refused(rt.query('INSERT INTO public.mp_run_store_schema VALUES(1)'),DENIED);
  await refused(rt.query('UPDATE public.mp_research_runs SET fixture=fixture'),DENIED);
  await refused(rt.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER mp_research_runs_no_change'),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.mp_run_store_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query('DROP TABLE public.mp_research_runs'),DENIED);
  // The fixture role cannot edit, truncate or change the extension either.
  await refused(fx.query('UPDATE public.mp_research_runs SET fixture=fixture'),DENIED);await refused(fx.query('DELETE FROM public.mp_research_run_events'),DENIED);
  await refused(fx.query('TRUNCATE public.mp_research_runs'),DENIED);await refused(fx.query('INSERT INTO public.mp_run_store_schema VALUES(2)'),DENIED);
  await refused(fx.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER ALL'),DENIED);await refused(fx.query("SET session_replication_role = 'replica'"),DENIED);
  assert.equal((await fx.query('SELECT version FROM public.mp_run_store_schema')).rows[0].version,1,'the fixture role reads the marker');
  // The inspection passes for both roles ...
  const ok=await inspectMpRunStore(db,{runtimeRole:runtimeName,fixtureRole:fixtureName});assert.equal(ok.ok,true,ok.failures.join());
  assert.equal(ok.facts.runtime_role.tables.length,3);assert.deepEqual(ok.facts.runtime_role.privileged_members,[]);assert.equal(ok.facts.runtime_reaches_fixture,false);
  assert.equal(ok.facts.fixture_role.tables.length,3);
  // ... and names every violation (each case is a rolled-back tamper).
  const seeded=async(statements,options)=>probe(db,async()=>{for(const statement of statements)await db.query(statement);return inspectMpRunStore(db,options);});
  const both={runtimeRole:runtimeName,fixtureRole:fixtureName};
  const cases=[
    ['runtime SELECT',['GRANT SELECT ON TABLE public.mp_research_runs TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_research_runs:SELECT'],
    ['runtime INSERT on the events',['GRANT INSERT ON TABLE public.mp_research_run_events TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_research_run_events:INSERT'],
    ['runtime SELECT on the marker',['GRANT SELECT ON TABLE public.mp_run_store_schema TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_run_store_schema:SELECT'],
    ['runtime UPDATE',['GRANT UPDATE ON TABLE public.mp_research_runs TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_research_runs:UPDATE'],
    ['runtime TRUNCATE',['GRANT TRUNCATE ON TABLE public.mp_research_runs TO '+runtimeName],both,'RUNTIME_ROLE_TRUNCATE_PRIVILEGE:mp_research_runs'],
    ['runtime TRIGGER',['GRANT TRIGGER ON TABLE public.mp_research_run_events TO '+runtimeName],both,'RUNTIME_ROLE_TRIGGER_PRIVILEGE:mp_research_run_events'],
    ['runtime REFERENCES',['GRANT REFERENCES ON TABLE public.mp_research_runs TO '+runtimeName],both,'RUNTIME_ROLE_REFERENCES_PRIVILEGE:mp_research_runs'],
    ['runtime column SELECT',['GRANT SELECT (run_id) ON TABLE public.mp_research_runs TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_research_runs:SELECT'],
    ['runtime SELECT through PUBLIC',['GRANT SELECT ON TABLE public.mp_research_runs TO PUBLIC'],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_research_runs:SELECT'],
    ['runtime SELECT through a NOINHERIT member',['CREATE ROLE rs_holder NOLOGIN','CREATE ROLE rs_noinherit NOLOGIN NOINHERIT','GRANT rs_holder TO rs_noinherit','GRANT SELECT ON TABLE public.mp_research_runs TO rs_holder'],
      {runtimeRole:'rs_noinherit'},'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_research_runs:SELECT'],
    // PostgreSQL refuses a circular membership, so the reversed direction (the misconfiguration the inspection guards against) needs the intended membership removed first.
    ['runtime made a member of the fixture role',['REVOKE '+runtimeName+' FROM '+fixtureName,'GRANT '+fixtureName+' TO '+runtimeName],both,'RUNTIME_ROLE_REACHES_FIXTURE_ROLE'],
    ['runtime made a member of a role that is a member of the fixture role',['REVOKE '+runtimeName+' FROM '+fixtureName,'CREATE ROLE rs_mid NOLOGIN','GRANT '+fixtureName+' TO rs_mid','GRANT rs_mid TO '+runtimeName],both,'RUNTIME_ROLE_REACHES_FIXTURE_ROLE'],
    ['runtime role is the fixture role',[],{runtimeRole:fixtureName,fixtureRole:fixtureName},'RUNTIME_ROLE_REACHES_FIXTURE_ROLE'],
    ['runtime owns a table',['ALTER TABLE public.mp_research_runs OWNER TO '+runtimeName],both,'RUNTIME_ROLE_OWNS:mp_research_runs'],
    ['fixture UPDATE',['GRANT UPDATE ON TABLE public.mp_research_runs TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_research_runs:UPDATE'],
    ['fixture column UPDATE',['GRANT UPDATE (fixture) ON TABLE public.mp_research_runs TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_research_runs:UPDATE'],
    ['fixture DELETE on the events',['GRANT DELETE ON TABLE public.mp_research_run_events TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_research_run_events:DELETE'],
    ['fixture TRUNCATE',['GRANT TRUNCATE ON TABLE public.mp_research_runs TO '+fixtureName],both,'FIXTURE_ROLE_TRUNCATE_PRIVILEGE:mp_research_runs'],
    ['fixture TRIGGER',['GRANT TRIGGER ON TABLE public.mp_research_run_events TO '+fixtureName],both,'FIXTURE_ROLE_TRIGGER_PRIVILEGE:mp_research_run_events'],
    ['fixture REFERENCES',['GRANT REFERENCES ON TABLE public.mp_research_runs TO '+fixtureName],both,'FIXTURE_ROLE_REFERENCES_PRIVILEGE:mp_research_runs'],
    ['fixture INSERT on the marker',['GRANT INSERT ON TABLE public.mp_run_store_schema TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_run_store_schema:INSERT'],
    ['fixture INSERT revoked',['REVOKE INSERT ON TABLE public.mp_research_runs FROM '+fixtureName],both,'FIXTURE_ROLE_PRIVILEGE_MISSING:mp_research_runs:INSERT'],
    ['fixture SELECT revoked on the marker',['REVOKE SELECT ON TABLE public.mp_run_store_schema FROM '+fixtureName],both,'FIXTURE_ROLE_PRIVILEGE_MISSING:mp_run_store_schema:SELECT'],
    ['fixture owns a table',['ALTER TABLE public.mp_research_run_events OWNER TO '+fixtureName],both,'FIXTURE_ROLE_OWNS:mp_research_run_events'],
    ['fixture is a superuser',['ALTER ROLE '+fixtureName+' SUPERUSER'],both,'FIXTURE_ROLE_SUPERUSER'],
    ['fixture may create in public',['GRANT CREATE ON SCHEMA public TO '+fixtureName],both,'FIXTURE_ROLE_SCHEMA_CREATE']];
  for(const [label,statements,options,failure] of cases){
    const report=await seeded(statements,options);
    assert.equal(report.ok,false,label);assert.ok(report.failures.includes(failure),label+': '+report.failures.join());
  }
  // The grants and the inspection leave no trace of the tampers.
  assert.equal((await inspectMpRunStore(db,both)).ok,true);
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
});

test('grant scripts: refusals leave nothing behind (runtime role reaching the fixture role or a table, missing store, bad fixture role, running worker)',async()=>{
  const bad=await clone('grantbad');
  const url=urlOf(bad);
  const target=track(new PostgresDatabase({connectionString:url,max:3}));
  const usage=async who=>(await target.query("SELECT has_table_privilege($1,'public.sessions','SELECT') AS ok",[who])).rows[0].ok;
  const rtX=await newRole('rtx'),fxX=await newRole('fxx',undefined,false),inheritless=await newRole('fxn','NOSUPERUSER NOINHERIT'),privileged=await newRole('fxs','SUPERUSER'),
    fxY=await newRole('fxy'),holder=await newRole('hold');
  // Before the run store exists the fixture script refuses.
  await assert.rejects(apply(url,await fixtureScript(rtX,fxX)),/The multi-Pine run store is not installed/);
  await migrateMpRunStore(target);
  // The runtime script refuses a runtime role that reaches a run-store table: through the fixture role, through PUBLIC and through a NOINHERIT member.
  await target.query('GRANT SELECT ON TABLE public.mp_research_runs TO '+fxX);await target.query('GRANT '+fxX+' TO '+rtX);
  await assert.rejects(apply(url,await grantScript(rtX)),/Runtime role .* can still reach internal table mp_research_runs/);
  assert.equal(await usage(rtX),false,'the refused run changed nothing');
  await target.query('REVOKE '+fxX+' FROM '+rtX);
  await target.query('GRANT SELECT ON TABLE public.mp_research_runs TO PUBLIC');
  await assert.rejects(apply(url,await grantScript(rtX)),/can still reach internal table mp_research_runs/);
  await target.query('REVOKE SELECT ON TABLE public.mp_research_runs FROM PUBLIC');
  await target.query('GRANT SELECT (run_id) ON TABLE public.mp_research_runs TO '+holder);await target.query('GRANT '+holder+' TO '+rtX+' WITH INHERIT FALSE');
  await assert.rejects(apply(url,await grantScript(rtX)),/can still reach internal table mp_research_runs/);
  await target.query('REVOKE '+holder+' FROM '+rtX);await target.query('REVOKE SELECT (run_id) ON TABLE public.mp_research_runs FROM '+holder);
  await apply(url,await grantScript(rtX));
  assert.equal(await usage(rtX),true,'without the reachable privilege the same role is granted');
  // The fixture script refuses: the same role twice, a missing role, a privileged role, a NOINHERIT role, a runtime role that is already a member of the fixture role,
  // a runtime role that still holds a run-store privilege, and a running API or worker.
  await assert.rejects(apply(url,await fixtureScript(rtX,rtX)),/must differ/);
  await assert.rejects(apply(url,await fixtureScript(rtX,'robot_rs_missing_role')),/Fixture role .* does not exist/);
  await assert.rejects(apply(url,await fixtureScript('robot_rs_missing_role',fxY)),/Runtime role .* does not exist/);
  await assert.rejects(apply(url,await fixtureScript(rtX,privileged)),/must be NOSUPERUSER/);
  await assert.rejects(apply(url,await fixtureScript(rtX,inheritless)),/does not inherit the privileges of runtime role/);
  await target.query('GRANT '+fxY+' TO '+rtX);
  await assert.rejects(apply(url,await fixtureScript(rtX,fxY)),/can reach fixture role/);
  await target.query('REVOKE '+fxY+' FROM '+rtX);
  await target.query('GRANT SELECT ON TABLE public.mp_research_run_events TO '+rtX);
  await assert.rejects(apply(url,await fixtureScript(rtX,fxY)),/can still reach internal table mp_research_run_events; apply scripts\/grant-postgres-runtime.sql first/);
  await target.query('REVOKE SELECT ON TABLE public.mp_research_run_events FROM '+rtX);
  const privilegeOf=async(who,table,kind)=>(await target.query('SELECT has_table_privilege($1,$2,$3) AS ok',[who,'public.'+table,kind])).rows[0].ok;
  assert.equal(await privilegeOf(fxY,'mp_research_runs','SELECT'),false,'the refused runs granted nothing');
  const holderConnection=new PostgresDatabase({connectionString:url});
  try{
    await holderConnection.runtimeLock();
    const started=Date.now();
    await assert.rejects(apply(url,await fixtureScript(rtX,fxY)),/Stop every PostgreSQL API and worker before maintenance/);
    assert.ok(Date.now()-started<10000,'the lock is tried, never waited for');
  }finally{await holderConnection.close();}
  // A stale grant of the history is removed, and a second application changes nothing.
  await target.query('GRANT UPDATE,DELETE,TRIGGER,REFERENCES ON TABLE public.mp_research_runs TO '+fxY);
  await apply(url,await fixtureScript(rtX,fxY));
  for(const kind of ['UPDATE','DELETE','TRIGGER','REFERENCES','TRUNCATE'])assert.equal(await privilegeOf(fxY,'mp_research_runs',kind),false,'history removed: '+kind);
  for(const kind of ['SELECT','INSERT'])assert.equal(await privilegeOf(fxY,'mp_research_run_events',kind),true,kind);
  const aclNow=async()=>(await target.query("SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'")).rows[0].d;
  const settled=await aclNow();await apply(url,await fixtureScript(rtX,fxY));assert.equal(await aclNow(),settled);
});

test('the marker read: a role without SELECT on the marker (the runtime role under B2) is told MARKER_UNREADABLE and nothing throws; a column grant on version is enough; the CLI inspection says it runs as the schema owner',async()=>{
  const asRuntime=await classifyMpRunStore(rt);
  assert.equal(asRuntime.state,'OTHER');assert.deepEqual(asRuntime.problems,['MARKER_UNREADABLE']);assert.deepEqual(asRuntime.missing,[]);
  const report=await inspectMpRunStore(rt);
  assert.equal(report.ok,false);assert.ok(report.failures.includes('MARKER_UNREADABLE'),report.failures.join());
  assert.equal(report.facts.state,'OTHER');
  // The schema owner is not affected, and a runtime role with a column privilege on the marker version reads the row (rolled back).
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
  const columnOnly=await probe(db,async()=>{
    await db.query('GRANT SELECT (version) ON TABLE public.mp_run_store_schema TO '+runtimeName);
    await db.query('SET LOCAL ROLE '+runtimeName);
    try{return await classifyMpRunStore(db);}finally{await db.query('RESET ROLE');}
  });
  assert.equal(columnOnly.state,'INSTALLED',columnOnly.problems.join());
  const cliAsRuntime=await cli(['--inspect'],urlOf(databaseName,runtimeName));
  assert.equal(cliAsRuntime.code,1);assert.match(cliAsRuntime.stdout,/MARKER_UNREADABLE/);
  const cliAsOwner=await cli(['--inspect']);
  assert.equal(cliAsOwner.code,0,cliAsOwner.stderr);
  assert.match(await fs.readFile(new URL('../../'+CLI,import.meta.url),'utf8'),/--inspect runs as the schema owner/);
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
});

/* ---- 3. SERIALIZABLE only ---- */

test('SERIALIZABLE only (QR003): an INSERT into any run-store table under READ COMMITTED or REPEATABLE READ is refused, whatever the other guards say',async()=>{
  const {set}=await committedSet(),row=makeRun(set);
  const writes={mp_research_runs:()=>insertRun(fx,row),mp_research_run_events:()=>insertEvent(fx,row,1,'ADMITTED')};
  const before=await allDigests(db);
  for(const isolation of ['READ COMMITTED','REPEATABLE READ']){
    for(const [table,write] of Object.entries(writes))
      await refusedWith(fx.transaction(write,{isolation}),QR003,/require a SERIALIZABLE transaction/).catch(error=>{throw Error(isolation+' '+table+': '+error.message);});
    await refused(db.transaction(()=>db.query('INSERT INTO public.mp_run_store_schema VALUES(1)'),{isolation}),QR003);
  }
  // an autocommit statement of a session whose default is READ COMMITTED meets it too, also with session_replication_role=replica (ENABLE ALWAYS)
  const plain=track(new PostgresDatabase({connectionString:urlOf(databaseName,fixtureName),max:1}));
  await refused(insertRun(plain,row),QR003);
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await insertRun(db,row);},{isolation:'READ COMMITTED'}),QR003);
  assert.deepEqual(await allDigests(db),before,'no refused insert left a row');
  // the QR003 trigger sorts first: a run that would also fail the run guard reports QR003 under READ COMMITTED and the guard under SERIALIZABLE
  const bad={...row,pine_count:3};
  await refused(fx.transaction(()=>insertRun(fx,bad),{isolation:'READ COMMITTED'}),QR003);
  await refused(fx.transaction(()=>insertRun(fx,bad),{isolation:'SERIALIZABLE'}),QR004);
  // SERIALIZABLE writes the same rows
  await admit(fx,row);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_research_run_events WHERE run_id=$1',[row.run_id])).rows[0].n,1);
});

/* ---- 4. the run table: CHECKs and contract ties (T-RS-S5, T-RS-S6) ---- */

test('run CHECKs and contract ties hold without the guards: every shape, hash, bound and tie case is refused with 23514 and its constraint (guards disabled in a rolled-back probe)',async()=>{
  const {set}=await committedSet(),base=makeRun(set);
  const HEX='f'.repeat(64);
  const tied=(column,value,path)=>({over:{[column]:value},mutate:contract=>{path(contract,value);}});
  const ties='mp_research_runs_contract_ties_check';
  const cases=[
    // columns that carry no tie to the contract
    ['fixture false',{over:{fixture:false}},'mp_research_runs_fixture_check'],
    ['contract_hash short',{over:{contract_hash:HEX.slice(1)}},'mp_research_runs_contract_hash_check'],
    ['contract_hash uppercase',{over:{contract_hash:HEX.toUpperCase()}},'mp_research_runs_contract_hash_check'],
    ['submission_hash not hex',{over:{submission_hash:'z'.repeat(64)}},'mp_research_runs_submission_hash_check'],
    ['idempotency_key 7 characters',{over:{idempotency_key:'abcdefg'}},'mp_research_runs_idempotency_key_check'],
    ['idempotency_key 129 characters',{over:{idempotency_key:'a'.repeat(129)}},'mp_research_runs_idempotency_key_check'],
    ['idempotency_key with a space',{over:{idempotency_key:'abcd efgh'}},'mp_research_runs_idempotency_key_check'],
    ['idempotency_key with a dot',{over:{idempotency_key:'abcd.efgh'}},'mp_research_runs_idempotency_key_check'],
    ['created_at_ms zero',{over:{created_at_ms:0,deadline_ms:600000}},'mp_research_runs_created_at_ms_check'],
    ['created_at_ms beyond the date range',{over:{created_at_ms:8640000000000001,deadline_ms:8640000000000002}},'mp_research_runs_created_at_ms_check'],
    ['deadline equals the creation time',{over:{deadline_ms:T0MS}},'mp_research_runs_deadline_ms_check'],
    ['deadline before the creation time',{over:{deadline_ms:T0MS-1}},'mp_research_runs_deadline_ms_check'],
    ['deadline 1 ms after the creation time',{over:{deadline_ms:T0MS+1}},'mp_research_runs_deadline_ms_check'],
    ['deadline 59999 ms after the creation time (one-Pine minimum is 60 s)',{over:{deadline_ms:T0MS+59999}},'mp_research_runs_deadline_ms_check'],
    ['deadline 900001 ms after the creation time',{over:{deadline_ms:T0MS+900001}},'mp_research_runs_deadline_ms_check'],
    // columns tied to the contract: both sides are changed so only the column CHECK can refuse
    ['set_hash short',tied('set_hash','ab',(contract,value)=>{contract.set_hash=value;}),'mp_research_runs_set_hash_check'],
    ['membership_hash uppercase',tied('membership_hash',HEX.toUpperCase(),(contract,value)=>{contract.membership_hash=value;}),'mp_research_runs_membership_hash_check'],
    ['engine_hash short',tied('engine_hash','1234',(contract,value)=>{contract.engine_hash=value;}),'mp_research_runs_engine_hash_check'],
    ['dataset_content_digest not hex',tied('dataset_content_digest','x'.repeat(64),(contract,value)=>{contract.dataset.content_digest=value;}),'mp_research_runs_dataset_content_digest_check'],
    ['contract_version unknown',tied('contract_version','ql3a-research-job-multi-v2',(contract,value)=>{contract.version=value;}),'mp_research_runs_contract_version_check'],
    ['pine_count 4 with four members',{over:{pine_count:4},mutate:contract=>{contract.pine_count=4;contract.members=[...contract.members,...contract.members];}},'mp_research_runs_pine_count_check'],
    ['pine_count 1 with one member',{over:{pine_count:1},mutate:contract=>{contract.pine_count=1;contract.members=contract.members.slice(0,1);}},'mp_research_runs_pine_count_check'],
    // the contract JSON ties and the exact key set
    ['contract version differs from the column',{mutate:contract=>{contract.version='ql3a-research-job-multi-v2';}},ties],
    ['contract mode ONE_PINE',{mutate:contract=>{contract.mode='ONE_PINE';}},ties],
    ['contract owner differs',{mutate:contract=>{contract.owner_id='someone-else';}},ties],
    ['contract Bot differs',{mutate:contract=>{contract.bot_id='someone-else';}},ties],
    ['contract member_set_id differs',{mutate:contract=>{contract.member_set_id=randomUUID();}},ties],
    ['contract set_hash differs',{mutate:contract=>{contract.set_hash=HEX;}},ties],
    ['contract membership_hash differs',{mutate:contract=>{contract.membership_hash=HEX;}},ties],
    ['contract pine_count is text',{mutate:contract=>{contract.pine_count='2';}},ties],
    ['contract pine_count differs',{mutate:contract=>{contract.pine_count=3;}},ties],
    ['contract engine_hash differs',{mutate:contract=>{contract.engine_hash=HEX;}},ties],
    ['contract dataset digest differs',{mutate:contract=>{contract.dataset.content_digest=HEX;}},ties],
    ['contract dataset missing',{mutate:contract=>{delete contract.dataset;}},ties],
    ['contract fixture false',{mutate:contract=>{contract.fixture=false;}},ties],
    ['contract fixture is text',{mutate:contract=>{contract.fixture='true';}},ties],
    ['contract same_bar_order differs',{mutate:contract=>{contract.same_bar_order='ordinal-first';}},ties],
    ['contract blocker missing',{mutate:contract=>{contract.acceptance_blockers=contract.acceptance_blockers.filter(item=>item!=='MULTI_PINE_REQUIRES_APP_3B');}},ties],
    ['contract blockers is a string equal to the blocker',{mutate:contract=>{contract.acceptance_blockers='MULTI_PINE_REQUIRES_APP_3B';}},ties],
    ['contract blockers missing',{mutate:contract=>{delete contract.acceptance_blockers;}},ties],
    ['contract members is an object',{mutate:contract=>{contract.members={};}},ties],
    ['contract members shorter than pine_count',{mutate:contract=>{contract.members=contract.members.slice(0,1);}},ties],
    ['contract members longer than pine_count',{mutate:contract=>{contract.members=[...contract.members,contract.members[0]];}},ties],
    ['contract has an extra key',{mutate:contract=>{contract.extra='x';}},ties],
    ['contract key missing (seed)',{mutate:contract=>{delete contract.seed;}},ties],
    ['contract key missing (rules)',{mutate:contract=>{delete contract.rules;}},ties],
    ['contract carries deployment_id',{mutate:contract=>{contract.deployment_id='dep-1';}},ties],
    ['contract carries pine_import_id',{mutate:contract=>{contract.pine_import_id='pine-1';}},ties],
    ['contract carries source_version',{mutate:contract=>{contract.source_version=1;}},ties],
    ['contract is an array',{over:{contract:'[]'}},'mp_research_runs_contract_check'],
    ['contract is a string',{over:{contract:'"x"'}},'mp_research_runs_contract_check'],
    ['contract is JSON null',{over:{contract:'null'}},'mp_research_runs_contract_check'],
    ['contract is an empty object',{over:{contract:'{}'}},ties],
    ['contract above 262144 bytes',{mutate:contract=>{contract.model.pad=Array.from({length:40000},(_,index)=>'p'+index).join(' ');}},'mp_research_runs_contract_size_check']];
  const before=await rowDigest(db,'mp_research_runs');
  const guardsOff=['mp_research_runs_guard','mp_research_runs_set_stale','mp_research_runs_complete'];
  for(const [label,spec,constraint] of cases){
    const row=spec.mutate?withContract({...base,...(spec.over??{})},spec.mutate):{...base,...(spec.over??{})};
    const found=await attempt(db,async()=>{
      for(const name of guardsOff)await db.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER '+name);
      await insertRun(db,row);
    });
    assert.equal(found?.code,CHECK_VIOLATION,label+': '+JSON.stringify(found));
    assert.equal(found.constraint,constraint,label+': '+JSON.stringify(found));
  }
  // not CHECKs: a missing contract is a NOT NULL violation
  assert.equal((await attempt(db,async()=>{
    for(const name of guardsOff)await db.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER '+name);
    await db.query(RUN_SQL,runValues({...base,contract:'x'}).map((value,index)=>RUN_COLUMNS[index]==='contract'?null:value));
  }))?.code,NOT_NULL);
  assert.deepEqual(await rowDigest(db,'mp_research_runs'),before,'no refused insert left a row');
  // the boundaries accepted: a deadline exactly 60000 and exactly 900000 ms after the creation time (the one-Pine deadline_seconds bounds 60 and 900), pine_count 3, uppercase and mixed idempotency keys of 8 and 128 characters
  const accepted=[{deadline_ms:T0MS+60000},{deadline_ms:T0MS+900000},{idempotency_key:'ABCDEFGH'},{idempotency_key:'a'.repeat(127)+'-'},{idempotency_key:'A_1-b_2-'}];
  for(const over of accepted){
    const found=await attempt(db,async()=>{
      for(const name of guardsOff)await db.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER '+name);
      await insertRun(db,{...base,...over});
    });
    assert.equal(found,null,JSON.stringify(over)+': '+JSON.stringify(found));
  }
  // the bounds are those of deadline_seconds of the one-Pine job (root ruling K5), read from its source
  const research=await sqlText('quant-research.js');
  const bounds=/const seconds=body\.deadline_seconds\?\?900;number\(seconds,\{min:(\d+),max:(\d+),integer:true\}\)/.exec(research);
  assert.ok(bounds,'the one-Pine deadline_seconds bounds were found');
  assert.deepEqual([Number(bounds[1])*1000,Number(bounds[2])*1000],[60000,900000]);
  // a canonical run with all guards on is accepted together with its first event
  assert.equal(await attempt(db,()=>walk(db,base)),null);
});

test('foreign keys and keys (T-RS-S6): a wrong set_hash, a missing owner, Bot, set or run, a repeated key or id are refused; the guards are out of the way only where a key is the case',async()=>{
  const {set}=await committedSet(),other=await newWorld(),row=makeRun(set);
  const unknownId=randomUUID();
  // a set_hash that names no (member_set_id, set_hash) pair of mp_member_sets: the guards pass (they do not compare it), the contract ties pass, the key refuses
  const wrongHash='9'.repeat(64);
  const hashed=withContract({...row,set_hash:wrongHash},contract=>{contract.set_hash=wrongHash;});
  const found=await attempt(db,()=>walk(db,hashed));
  assert.equal(found?.code,FK_VIOLATION,JSON.stringify(found));assert.equal(found.constraint,'mp_research_runs_set_hash_fkey');
  // the set row of another owner: the guard refuses first, the key behind it needs the guards out of the way
  const guardsOff=['mp_research_runs_guard','mp_research_runs_set_stale','mp_research_runs_complete'];
  const off=async()=>{for(const name of guardsOff)await db.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER '+name);};
  const cases=[
    ['unknown set',{member_set_id:unknownId},['mp_research_runs_set_fkey','mp_research_runs_set_hash_fkey'],contract=>{contract.member_set_id=unknownId;}],
    ['unknown owner',{owner_id:'no-such-owner'},['mp_research_runs_owner_id_fkey','mp_research_runs_set_fkey'],contract=>{contract.owner_id='no-such-owner';}],
    ['unknown Bot',{bot_id:'no-such-bot'},['mp_research_runs_bot_id_fkey','mp_research_runs_set_fkey'],contract=>{contract.bot_id='no-such-bot';}],
    ['owner and Bot of another user than the set',{owner_id:other.id,bot_id:other.bot},['mp_research_runs_set_fkey'],contract=>{contract.owner_id=other.id;contract.bot_id=other.bot;}]];
  for(const [label,over,constraints,mutate] of cases){
    const variant=withContract({...row,...over},mutate);
    const failed=await attempt(db,async()=>{await off();await insertRun(db,variant);});
    assert.equal(failed?.code,FK_VIOLATION,label+': '+JSON.stringify(failed));assert.ok(constraints.includes(failed.constraint),label+': '+failed.constraint);
    // with the guards on, the same row is a QR004 of the run guard
    const guarded=await attempt(db,()=>insertRun(db,variant));
    assert.equal(guarded?.code,QR004,label+': '+JSON.stringify(guarded));assert.equal(guarded.constraint,G_RUN,label);
  }
  // an event of an unknown run: the order guard passes (seq 1), the transition guard refuses; with the three event guards out of the way the key refuses
  const orphan=await attempt(db,()=>insertEvent(db,row,1,'ADMITTED'));
  assert.equal(orphan?.code,QR004);assert.equal(orphan.constraint,G_TRANSITION);assert.match(orphan.message,/needs its run row/);
  const keyed=await attempt(db,async()=>{
    for(const name of [G_ORDER,G_RESULT,G_TRANSITION])await db.query('ALTER TABLE public.mp_research_run_events DISABLE TRIGGER '+name);
    await insertEvent(db,row,1,'ADMITTED');
  });
  assert.equal(keyed?.code,FK_VIOLATION,JSON.stringify(keyed));assert.equal(keyed.constraint,'mp_research_run_events_run_fkey');
  // unique keys: the same idempotency key of the same owner and Bot, and a repeated run id
  const committed=await admit(fx,makeRun(set));
  const sameKey=await attempt(db,()=>walk(db,makeRun(set,{idempotency_key:committed.idempotency_key})));
  assert.equal(sameKey?.code,UNIQUE_VIOLATION,JSON.stringify(sameKey));assert.equal(sameKey.constraint,'mp_research_runs_idempotency_key');
  const sameId=await attempt(db,async()=>{await insertRun(db,{...makeRun(set),run_id:committed.run_id});});
  assert.equal(sameId?.code,UNIQUE_VIOLATION);assert.equal(sameId.constraint,'mp_research_runs_pkey');
  // the same key under another owner or Bot is a different run (the key is per owner and Bot)
  const second=await committedSet();
  assert.equal(await attempt(db,()=>walk(db,makeRun(second.set,{idempotency_key:committed.idempotency_key}))),null);
});

/* ---- 5. the run guards, one precondition at a time (T-RS-S4, T-RS-S9) ---- */

test('run guard: every binding precondition is refused with QR004 naming mp_research_runs_guard; a non-fixture set is refused',async()=>{
  const {set}=await committedSet(),other=await newWorld(),base=makeRun(set);
  assert.equal(await attempt(db,()=>walk(db,base)),null,'the untampered run is accepted');
  const HEX='1'.repeat(64);
  const cases=[
    ['member set row absent',withContract({...base,member_set_id:randomUUID()},contract=>{contract.member_set_id=randomUUID();}),/needs its member set row/],
    ['owner differs from the set',{...base,owner_id:other.id},/owner and Bot of its member set/],
    ['Bot differs from the set',{...base,bot_id:other.id},/owner and Bot of its member set/],
    ['pine_count differs from the set',{...base,pine_count:3},/pine_count of its member set/],
    ['membership_hash differs from the set',withContract({...base,membership_hash:HEX},contract=>{contract.membership_hash=HEX;}),/membership_hash of its member set/],
    ['contract same_bar_order differs from the set',withContract(base,contract=>{contract.same_bar_order='ordinal-first';}),/same_bar_order of its member set/],
    ['contract policy_hash differs from the set',withContract(base,contract=>{contract.policy_hash=HEX;}),/policy_hash and funding_cutoff/],
    ['contract funding_cutoff differs from the set',withContract(base,contract=>{contract.funding_cutoff=8;}),/policy_hash and funding_cutoff/],
    ['contract member hash differs from the set record',withContract(base,contract=>{contract.members[0].source_hash=HEX;}),/members of the stored member set record/],
    ['contract members swapped',withContract(base,contract=>{contract.members.reverse();}),/members of the stored member set record/],
    ['contract members shorter than the record',withContract(base,contract=>{contract.members=contract.members.slice(0,1);}),/members of the stored member set record/],
    ['contract members missing',withContract(base,contract=>{delete contract.members;}),/members of the stored member set record/]];
  for(const [label,row,message] of cases){
    const found=await attempt(db,()=>insertRun(db,row));
    assert.equal(found?.code,QR004,label+': '+JSON.stringify(found));assert.equal(found.constraint,G_RUN,label);assert.match(found.message,message,label);
  }
  // the parent is not a fixture set (the parent CHECK is dropped in the probe only): the run guard refuses
  const nonFixture=await setOf(await newWorld());
  const found=await attempt(db,async()=>{
    await db.query('ALTER TABLE public.mp_member_sets DROP CONSTRAINT mp_member_sets_fixture_check');
    await insertSet(db,nonFixture,{parent:{fixture:false,record:{...nonFixture,fixture:false}}});
    await insertRun(db,makeRun(nonFixture));
  });
  assert.equal(found?.code,QR004,JSON.stringify(found));assert.equal(found.constraint,G_RUN);assert.match(found.message,/needs a fixture member set/);
  assert.equal(await attempt(db,()=>walk(db,base)),null,'every tamper was rolled back');
});

test('stale guard: any change of a member after the freeze is refused with QR004 naming mp_research_runs_set_stale; each case is a rolled-back tamper of the pine rows',async()=>{
  const {world,set}=await committedSet(),row=makeRun(set);
  const [a,b]=set.members;
  const other=await newWorld();
  assert.equal(await attempt(db,()=>walk(db,row)),null,'the fresh set admits the run');
  const tampers=[
    ['deployment READY',/must still be DRAFT/,()=>db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[a.deployment_id])],
    ['deployment EXIT_ONLY',/must still be DRAFT/,()=>db.query("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE deployment_id=$1",[b.deployment_id])],
    ['deployment REVOKED',/must still be DRAFT/,()=>db.query("UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",[a.deployment_id])],
    ['deployment of another owner',/still exist with the same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET owner_id=$2 WHERE deployment_id=$1',[a.deployment_id,other.id])],
    ['deployment of another Bot',/still exist with the same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET bot_id=$2 WHERE deployment_id=$1',[a.deployment_id,other.id])],
    ['deployment of another import',/still exist with the same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET pine_import_id=$2 WHERE deployment_id=$1',[a.deployment_id,b.pine_import_id])],
    ['deployment of another source version',/still exist with the same owner, Bot, import and source version/,()=>db.query('UPDATE pine_deployments SET source_version=2 WHERE deployment_id=$1',[a.deployment_id])],
    ['deployment snapshot_hash changed',/snapshot_hash must still equal the frozen one/,()=>db.query('UPDATE pine_deployments SET snapshot_hash=$2 WHERE deployment_id=$1',[a.deployment_id,'e'.repeat(64)])],
    ['membership disconnected',/still be a connected membership/,()=>db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[b.pine_import_id])],
    ['membership of another owner',/still be a connected membership/,()=>db.query('UPDATE pine_memberships SET owner_id=$2 WHERE pine_import_id=$1',[a.pine_import_id,other.id])],
    ['membership of another Bot',/still be a connected membership/,()=>db.query('UPDATE pine_memberships SET bot_id=$2 WHERE pine_import_id=$1',[a.pine_import_id,other.id])],
    ['membership at a new source version',/still be a connected membership/,async()=>{
      await db.query('INSERT INTO pine_source_revisions SELECT pine_import_id,2,source_hash,source,analysis,created_at FROM pine_source_revisions WHERE pine_import_id=$1 AND source_version=1',[a.pine_import_id]);
      await db.query('UPDATE pine_memberships SET source_version=2 WHERE pine_import_id=$1',[a.pine_import_id]);}],
    ['source revision hash changed',/must still equal the source revision/,()=>db.query('UPDATE pine_source_revisions SET source_hash=$2 WHERE pine_import_id=$1 AND source_version=1',[a.pine_import_id,'d'.repeat(64)])],
    ['effective inputs hash changed',/must still equal the source revision/,()=>db.query(`UPDATE pine_source_revisions SET analysis=jsonb_set(analysis,'{effective_inputs_hash}',to_jsonb($2::text)) WHERE pine_import_id=$1`,[b.pine_import_id,'c'.repeat(64)])],
    ['Bridge evidence absent',/Bridge evidence row/,()=>db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[a.deployment_id])],
    ['Bridge evidence of another snapshot',/Bridge evidence row/,()=>db.query('UPDATE pine_bridge_evidence SET snapshot_hash=$2 WHERE deployment_id=$1',[b.deployment_id,'b'.repeat(64)])],
    ['Bridge evidence_hash changed',/Bridge evidence row/,()=>db.query('UPDATE pine_bridge_evidence SET evidence_hash=$2 WHERE deployment_id=$1',[a.deployment_id,'a'.repeat(64)])],
    ['a third connected membership of the Bot',/connected memberships of its Bot/,()=>addMembership(world,true,db)]];
  for(const [label,message,tamper] of tampers){
    const found=await attempt(db,async()=>{await tamper();await walk(db,row);});
    assert.equal(found?.code,QR004,label+': '+JSON.stringify(found));
    assert.equal(found.constraint,G_STALE,label);
    assert.match(found.message,message,label);
  }
  // a disconnected third membership does not count
  assert.equal(await attempt(db,async()=>{await addMembership(world,false,db);await walk(db,row);}),null);
  // the same through a real commit as the fixture role: a stale set admits nothing
  await db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[b.pine_import_id]);
  const before=await allDigests(db);
  const error=await fx.transaction(()=>walk(fx,row),{isolation:'SERIALIZABLE'}).then(()=>null,failure=>failure);
  assert.equal(error?.code,QR004,error?.message);assert.equal(error.constraint,G_STALE);
  assert.deepEqual(await allDigests(db),before,'no stale run left a row');
  await db.query('UPDATE pine_memberships SET connected=TRUE WHERE pine_import_id=$1',[b.pine_import_id]);
  await admit(fx,row);
});

test('stale guard: the connected count is of the (owner_id, bot_id) pair, in a world where the owner and the Bot are different users',async()=>{
  const world=await newWorld({count:2});
  const owner=world.id;
  const botUser=await store.createUser({email:'rs-bot-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  // A set of an owner whose Bot is the owner itself, plus connected memberships of other pairs that must not count.
  const {set}=await committedSet({world});
  const row=makeRun(set);
  const addPair=async(ownerId,botId)=>{
    const id=randomUUID(),hashOf=hash('source-'+id),analysis={effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i3'}]};
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[id,ownerId,botId,hashOf,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[id,hashOf,'//@version=6\nindicator("x")',JSON.stringify(analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[id,ownerId,botId]);
  };
  const stranger=(await store.createUser({email:'rs-str-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'})).id;
  const others=await attempt(db,async()=>{await addPair(owner,botUser.id);await addPair(stranger,owner);await addPair(botUser.id,owner);await walk(db,row);});
  assert.equal(others,null,'memberships of other (owner, Bot) pairs do not count: '+JSON.stringify(others));
  const exact=await attempt(db,async()=>{await addPair(owner,owner);await walk(db,row);});
  assert.equal(exact?.code,QR004,JSON.stringify(exact));assert.equal(exact.constraint,G_STALE);assert.match(exact.message,/connected memberships of its Bot/);
});

test('complete guard: a run commits only with its seq 1 ADMITTED event written by the same transaction; nothing is stored otherwise',async()=>{
  const {set}=await committedSet(),row=makeRun(set);
  const before=await allDigests(db);
  // a run alone fails at COMMIT with the deferred guard
  const alone=await fx.transaction(()=>insertRun(fx,row),{isolation:'SERIALIZABLE'}).then(()=>null,error=>error);
  assert.equal(alone?.code,QR004,alone?.message);assert.equal(alone.constraint,G_COMPLETE);assert.match(alone.message,/seq 1 ADMITTED event written by the same transaction/);
  assert.deepEqual(await allDigests(db),before,'no incomplete run left a row');
  // the check is deferred: inside the transaction the event can still be added; SET CONSTRAINTS IMMEDIATE brings it forward
  const early=await attempt(db,()=>insertRun(db,row));
  assert.equal(early?.code,QR004);assert.equal(early.constraint,G_COMPLETE);
  assert.equal(await attempt(db,()=>walk(db,row)),null);
  await admit(fx,row);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_research_runs WHERE run_id=$1',[row.run_id])).rows[0].n,1);
  // a run whose first event is written, but a second run of the same transaction without one, is refused as a whole
  const second=makeRun(set),third=makeRun(set);
  const mixed=await fx.transaction(async()=>{await walk(fx,second);await insertRun(fx,third);},{isolation:'SERIALIZABLE'}).then(()=>null,error=>error);
  assert.equal(mixed?.code,QR004);assert.equal(mixed.constraint,G_COMPLETE);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_research_runs WHERE run_id=ANY($1)',[[second.run_id,third.run_id]])).rows[0].n,0);
  // another transaction's seq 1 does not satisfy the check, and an event written behind a SAVEPOINT is a subtransaction row and does not either
  const sub=await attempt(db,async()=>{
    const fresh=makeRun(set);await insertRun(db,fresh);
    await db.query('SAVEPOINT s1');await insertEvent(db,fresh,1,'ADMITTED');await db.query('RELEASE SAVEPOINT s1');
  });
  assert.equal(sub?.code,QR004,JSON.stringify(sub));assert.equal(sub.constraint,G_COMPLETE);
});

/* ---- 6. the event guards: order, result, transition (T-RS-S7, T-RS-S8) ---- */

test('event order guard: seq must be the last seq plus one; a gap, a repeat, a zero and a first seq above 1 are refused with QR004 naming mp_research_run_events_order',async()=>{
  const {set}=await committedSet(),row=makeRun(set);
  const cases=[
    ['seq 3 after seq 1',async()=>{await walk(db,row);await insertEvent(db,row,3,'RUNNING');}],
    ['seq 1 repeated',async()=>{await walk(db,row);await insertEvent(db,row,1,'ADMITTED');}],
    ['seq 2 repeated',async()=>{await walk(db,row,['ADMITTED','RUNNING']);await insertEvent(db,row,2,'FAILED');}],
    ['seq 2 as the first event',async()=>{await insertRun(db,row);await insertEvent(db,row,2,'ADMITTED');}],
    ['seq 0 as the first event',async()=>{await insertRun(db,row);await insertEvent(db,row,0,'ADMITTED');}],
    ['seq -1 as the first event',async()=>{await insertRun(db,row);await insertEvent(db,row,-1,'ADMITTED');}],
    ['seq 64 as the first event',async()=>{await insertRun(db,row);await insertEvent(db,row,64,'ADMITTED');}]];
  for(const [label,body] of cases){
    const found=await attempt(db,body);
    assert.equal(found?.code,QR004,label+': '+JSON.stringify(found));assert.equal(found.constraint,G_ORDER,label);assert.match(found.message,/last seq of its run plus one/,label);
  }
  // seq follows the order of the events themselves, in any isolation of the other writers: the next seq is accepted
  assert.equal(await attempt(db,()=>walk(db,row,['ADMITTED','RUNNING','SUCCEEDED'])),null);
  // a repeated seq after commit meets the guard (and, with the guard out of the way, the primary key)
  await admit(fx,row,['ADMITTED','RUNNING']);
  await refusedWith(fx.transaction(()=>insertEvent(fx,row,2,'FAILED')),QR004,/last seq of its run plus one/);
  const pk=await attempt(db,async()=>{
    await db.query('ALTER TABLE public.mp_research_run_events DISABLE TRIGGER '+G_ORDER);
    await insertEvent(db,row,2,'FAILED');
  });
  assert.equal(pk?.code,UNIQUE_VIOLATION,JSON.stringify(pk));assert.equal(pk.constraint,'mp_research_run_events_pkey');
});

test('event result guard: reason_code, result and result_hash follow the status, and a result ties to its run; each case is refused with QR004 naming mp_research_run_events_result',async()=>{
  const {set}=await committedSet(),row=makeRun(set);
  const HEX='2'.repeat(64);
  const good=resultOf(row);
  const reasonLess='needs a reason_code and no result',resultful='needs a result and a result_hash and no reason_code';
  const cases=[
    // [label, statuses before, status, over, message]
    ...['FAILED','CANCELLED','TIMED_OUT'].flatMap(status=>[
      [status+' without a reason_code',['ADMITTED','RUNNING'],status,{reason_code:null},reasonLess],
      [status+' with a result',['ADMITTED','RUNNING'],status,{result:good,result_hash:hash(canonical(good))},reasonLess],
      [status+' with a result_hash only',['ADMITTED','RUNNING'],status,{result_hash:HEX},reasonLess]]),
    ...['SUCCEEDED','NO_VALID_CANDIDATE'].flatMap(status=>[
      [status+' without a result',['ADMITTED','RUNNING'],status,{result:null,result_hash:null},resultful],
      [status+' without a result_hash',['ADMITTED','RUNNING'],status,{result_hash:null},resultful],
      [status+' with a result_hash only',['ADMITTED','RUNNING'],status,{result:null},resultful],
      [status+' with a reason_code',['ADMITTED','RUNNING'],status,{reason_code:'SOME_REASON'},resultful],
      [status+' with a result that is an array',['ADMITTED','RUNNING'],status,{result:'[]'},'must be a JSON object'],
      [status+' with a result of another run',['ADMITTED','RUNNING'],status,{result:{...good,run_id:randomUUID()}},'name the run_id and the contract_hash of its run'],
      [status+' with a result of another contract',['ADMITTED','RUNNING'],status,{result:{...good,contract_hash:HEX}},'name the run_id and the contract_hash of its run'],
      [status+' with a result without run_id',['ADMITTED','RUNNING'],status,{result:(({run_id,...rest})=>rest)(good)},'name the run_id and the contract_hash of its run'],
      [status+' with owner_recommendation_ready true',['ADMITTED','RUNNING'],status,{result:{...good,owner_recommendation_ready:true}},'owner_recommendation_ready false'],
      [status+' with owner_recommendation_ready missing',['ADMITTED','RUNNING'],status,{result:(({owner_recommendation_ready,...rest})=>rest)(good)},'owner_recommendation_ready false'],
      [status+' with owner_recommendation_ready as text',['ADMITTED','RUNNING'],status,{result:{...good,owner_recommendation_ready:'false'}},'owner_recommendation_ready false'],
      [status+' without the APP-3B blocker',['ADMITTED','RUNNING'],status,{result:{...good,acceptance_blockers:good.acceptance_blockers.filter(item=>item!=='MULTI_PINE_REQUIRES_APP_3B')}},'MULTI_PINE_REQUIRES_APP_3B blocker'],
      [status+' with a blockers string',['ADMITTED','RUNNING'],status,{result:{...good,acceptance_blockers:'MULTI_PINE_REQUIRES_APP_3B'}},'MULTI_PINE_REQUIRES_APP_3B blocker'],
      [status+' without blockers',['ADMITTED','RUNNING'],status,{result:(({acceptance_blockers,...rest})=>rest)(good)},'MULTI_PINE_REQUIRES_APP_3B blocker']]),
    ['ADMITTED with a reason_code',[],'ADMITTED',{reason_code:'SOME_REASON'},'carries no reason_code, result or result_hash'],
    ['ADMITTED with a result',[],'ADMITTED',{result:good,result_hash:hash(canonical(good))},'carries no reason_code, result or result_hash'],
    ['RUNNING with a result_hash',['ADMITTED'],'RUNNING',{result_hash:HEX},'carries no reason_code, result or result_hash'],
    ['RUNNING with a reason_code',['ADMITTED'],'RUNNING',{reason_code:'SOME_REASON'},'carries no reason_code, result or result_hash']];
  for(const [label,before,status,over,message] of cases){
    const found=await attempt(db,async()=>{
      await insertRun(db,row);
      for(const [index,earlier] of before.entries())await insertEvent(db,row,index+1,earlier);
      await insertEvent(db,row,before.length+1,status,over);
    });
    assert.equal(found?.code,QR004,label+': '+JSON.stringify(found));assert.equal(found.constraint,G_RESULT,label);assert.ok(found.message.includes(message),label+': '+found.message);
  }
  // every well-formed terminal event is accepted, and its result is stored verbatim
  for(const status of TERMINAL)assert.equal(await attempt(db,()=>walk(db,row,PATH_TO[status])),null,status);
  await admit(fx,row,PATH_TO.SUCCEEDED);
  const stored=(await fx.query('SELECT result,result_hash,reason_code FROM public.mp_research_run_events WHERE run_id=$1 AND seq=3',[row.run_id])).rows[0];
  assert.deepEqual(stored.result,good);assert.equal(stored.result_hash,hash(canonical(good)));assert.equal(stored.reason_code,null);
});

test('event transition guard: every edge of the status graph at its border; nothing after a terminal event; the first event is ADMITTED from the run\'s own transaction',async()=>{
  const {set}=await committedSet(),row=makeRun(set);
  // [predecessor] x [next status]: allowed exactly as the graph says; the fields of the new event follow its status, so only the edge decides
  for(const last of ['ADMITTED','RUNNING']){
    for(const next of STATUSES){
      const allowed=EDGES[last].includes(next);
      const found=await attempt(db,async()=>{
        await walk(db,row,PATH_TO[last]);
        await insertEvent(db,row,PATH_TO[last].length+1,next);
      });
      if(allowed)assert.equal(found,null,last+' -> '+next+': '+JSON.stringify(found));
      else{
        assert.equal(found?.code,QR004,last+' -> '+next+': '+JSON.stringify(found));assert.equal(found.constraint,G_TRANSITION,last+' -> '+next);
        assert.match(found.message,/transition is not allowed/,last+' -> '+next);
      }
    }
  }
  // nothing follows a terminal event, whatever the next status is
  for(const terminal of TERMINAL){
    for(const next of STATUSES){
      const found=await attempt(db,async()=>{
        await walk(db,row,PATH_TO[terminal]);
        await insertEvent(db,row,PATH_TO[terminal].length+1,next);
      });
      assert.equal(found?.code,QR004,terminal+' -> '+next+': '+JSON.stringify(found));assert.equal(found.constraint,G_TRANSITION,terminal+' -> '+next);
      assert.match(found.message,/No event can follow a terminal event/,terminal+' -> '+next);
    }
  }
  // the first event
  for(const first of STATUSES.filter(status=>status!=='ADMITTED')){
    const found=await attempt(db,async()=>{await insertRun(db,row);await insertEvent(db,row,1,first);});
    assert.equal(found?.code,QR004,'first '+first+': '+JSON.stringify(found));assert.equal(found.constraint,G_TRANSITION,first);assert.match(found.message,/first event of a run must be ADMITTED/,first);
  }
  // a committed terminal run refuses the next event, also as the fixture role in its own transaction
  const done=await admit(fx,makeRun(set),PATH_TO.TIMED_OUT);
  for(const next of ['RUNNING','FAILED','SUCCEEDED']){
    await refusedWith(fx.transaction(()=>insertEvent(fx,done,4,next)),QR004,/No event can follow a terminal event/).catch(error=>{throw Error('committed terminal -> '+next+': '+error.message);});
  }
  // an ADMITTED run that is only running can still end
  const live=await admit(fx,makeRun(set),PATH_TO.RUNNING);
  await fx.transaction(()=>insertEvent(fx,live,3,'SUCCEEDED'));
  assert.deepEqual((await db.query('SELECT status FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq',[live.run_id])).rows.map(item=>item.status),['ADMITTED','RUNNING','SUCCEEDED']);
  // the status of a run is its last event; a run has at most one terminal event
  assert.equal((await db.query(`SELECT count(*)::int n FROM public.mp_research_run_events WHERE run_id=$1 AND status IN ('SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT')`,[done.run_id])).rows[0].n,1);
});

test('event transition guard: a seq 1 ADMITTED event of a later transaction than the run row is refused, and the catalog survives the setup',async()=>{
  const {name,target,targetStore}=await cloneWithStore('later');
  const world=await newWorld({target,targetStore}),set=await setOf(world);
  await freeze(target,set);
  const row=makeRun(set);
  // a run committed without its first event (the deferred check is out of the way for this setup only, then restored)
  await target.transaction(async()=>{
    await target.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER mp_research_runs_complete');
    await insertRun(target,row);
    await target.query('ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_complete');
  },{isolation:'SERIALIZABLE'});
  assert.equal((await classifyMpRunStore(target)).state,'INSTALLED','the setup left every guard as it was');
  const error=await target.transaction(()=>insertEvent(target,row,1,'ADMITTED'),{isolation:'SERIALIZABLE'}).then(()=>null,failure=>failure);
  assert.equal(error?.code,QR004,error?.message);assert.equal(error.constraint,G_TRANSITION);assert.match(error.message,/written by the transaction that wrote the run/);
  assert.equal((await target.query('SELECT count(*)::int n FROM public.mp_research_run_events')).rows[0].n,0);
  void name;
});

test('event clock (T-RS-S8): at_ms comes from the database clock, a writer value is overwritten, and a reading equal to the previous event still gives a strictly later value',async()=>{
  const {set}=await committedSet(),row=makeRun(set);
  const before=await dbClockMs(db);
  const seen=await probe(db,async()=>{
    await insertRun(db,row);
    await insertEvent(db,row,1,'ADMITTED',{at_ms:5});
    await insertEvent(db,row,2,'RUNNING',{at_ms:9007199254740991});
    await insertEvent(db,row,3,'SUCCEEDED',{at_ms:1});
    return (await db.query('SELECT seq,at_ms FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq',[row.run_id])).rows.map(item=>Number(item.at_ms));
  });
  const after=await dbClockMs(db);
  assert.ok(seen[0]>=before-1&&seen[0]<=after+1,'the first at_ms is the database clock, not the writer value 5: '+JSON.stringify({seen,before,after}));
  assert.ok(seen[1]>seen[0]&&seen[2]>seen[1],'strictly increasing: '+seen.join());
  assert.ok(seen[2]<=after+5,'a writer value is never kept: '+seen.join());
  // The previous event is ahead of the clock (the order guard is out of the way once to plant it): the next event is exactly previous + 1.
  const future=before+1000000;
  const planted=await probe(db,async()=>{
    await insertRun(db,row);
    await insertEvent(db,row,1,'ADMITTED');
    await db.query('ALTER TABLE public.mp_research_run_events DISABLE TRIGGER '+G_ORDER);
    await insertEvent(db,row,2,'RUNNING',{at_ms:future});
    await db.query('ALTER TABLE public.mp_research_run_events ENABLE ALWAYS TRIGGER '+G_ORDER);
    await insertEvent(db,row,3,'FAILED');
    return (await db.query('SELECT seq,at_ms FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq',[row.run_id])).rows.map(item=>Number(item.at_ms));
  });
  assert.ok(Array.isArray(planted),String(planted));
  assert.equal(planted[1],future,'the planted value is kept by the disabled guard');
  assert.equal(planted[2],future+1,'the next event is exactly previous + 1: '+planted.join());
});

/* ---- 7. insert-only enforcement (T-RS-S2) ---- */

test('insert-only (QR002): UPDATE, DELETE and TRUNCATE are refused at both layers on every table; the replication role cannot skip a guard; no row changes',async()=>{
  const {set}=await committedSet(),row=await admit(fx,makeRun(set),PATH_TO.SUCCEEDED);
  const before=await allDigests(db);
  for(const table of ALL_TABLES)assert.ok(before[table].n>0,table+' holds a row');
  const column={mp_research_runs:'created_at_ms',mp_research_run_events:'seq',mp_run_store_schema:'version'};
  // layer 1 (privilege): neither the runtime role nor the fixture role holds UPDATE, DELETE or TRUNCATE on a run-store table
  for(const table of ALL_TABLES){
    for(const who of [rt,fx]){
      await refused(who.query(`UPDATE public.${table} SET ${column[table]}=${column[table]}`),DENIED).catch(error=>{throw Error(table+': '+error.message);});
      await refused(who.query(`DELETE FROM public.${table}`),DENIED);await refused(who.query(`TRUNCATE public.${table}`),DENIED);await refused(who.query(`TRUNCATE public.${table} CASCADE`),DENIED);
    }
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
  await refused(dl.query('INSERT INTO public.mp_research_runs SELECT * FROM public.mp_research_runs WHERE run_id=$1 ON CONFLICT (run_id) DO UPDATE SET fixture=excluded.fixture',[row.run_id]),QR002);
  await refused(dl.query('MERGE INTO public.mp_research_runs t USING (SELECT $1::uuid AS id) s ON t.run_id=s.id WHEN MATCHED THEN UPDATE SET fixture=true',[row.run_id]),QR002);
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await dl.query(`UPDATE public.mp_research_runs SET fixture=true WHERE idempotency_key='no-such-key-at-all'`)).rowCount,0);
  assert.deepEqual(await allDigests(db),before,'no refusal changed a row');
  assert.ok((await guardRows(db)).every(item=>item.tgenabled==='A'));
  // an INSERT under the replica role still meets the insert guards
  const bad=makeRun(set,{pine_count:3});
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await insertRun(db,bad);},{isolation:'SERIALIZABLE'}),QR004);
  await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await insertEvent(db,row,9,'RUNNING');},{isolation:'SERIALIZABLE'}),QR004);
});

test('a session TEMP table named like a run-store, member-set or pine table fools neither the guards nor the freeze',async()=>{
  const {set:doneSet}=await committedSet();await admit(fx,makeRun(doneSet));
  const {set:liveSet}=await committedSet(),live=makeRun(liveSet);
  // TEMP copies of the tables the guards read, empty, in front on the search_path, must not change what the guards read
  await refusedWith(fx.transaction(async()=>{
    for(const table of ['mp_member_sets','mp_member_set_members','pine_deployments','pine_memberships','pine_source_revisions','pine_bridge_evidence'])
      await fx.query(`CREATE TEMP TABLE ${table}(LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
    await fx.query('SET LOCAL search_path = pg_temp, public');
    await insertRun(fx,withContract(live,contract=>{contract.members[0].source_hash='7'.repeat(64);}));
  }),QR004,/members of the stored member set record/);
  // a writer that qualifies its own insert works with TEMP tables of the same names in front: the guards read the real tables
  await fx.transaction(async()=>{
    await fx.query('CREATE TEMP TABLE mp_research_run_events(x integer) ON COMMIT DROP');await fx.query('CREATE TEMP TABLE pine_deployments(x integer) ON COMMIT DROP');
    await fx.query('SET LOCAL search_path = pg_temp, public');
    await walk(fx,live);
  });
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_research_run_events WHERE run_id=$1',[live.run_id])).rows[0].n,1);
  // the freeze still fires for the real table whatever search_path says, and a TEMP function cannot replace a pinned call
  await refused(dl.transaction(async()=>{
    await dl.query('CREATE TEMP TABLE mp_research_runs(x integer) ON COMMIT DROP');await dl.query('SET LOCAL search_path = pg_temp, public');
    await dl.query('UPDATE public.mp_research_runs SET fixture=fixture');
  }),QR002);
  await refused(dl.transaction(async()=>{
    await dl.query("CREATE FUNCTION pg_temp.raise_exception() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$");
    await dl.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await dl.query('DELETE FROM public.mp_research_run_events');
  }),QR002);
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
  // a TEMP event table in front cannot hide a missing first event from the completeness check
  const incomplete=makeRun((await committedSet()).set);
  const failure=await fx.transaction(async()=>{
    await fx.query('CREATE TEMP TABLE mp_research_run_events(LIKE public.mp_research_run_events INCLUDING DEFAULTS) ON COMMIT DROP');
    await fx.query('SET LOCAL search_path = pg_temp, public');
    await insertRun(fx,incomplete);
  }).then(()=>null,error=>error);
  assert.equal(failure?.code,QR004);assert.equal(failure.constraint,G_COMPLETE);
});

/* ---- 8. the fixture role end to end ---- */

test('fixture role: reads and inserts runs and events; the runtime role sees nothing; the one-Pine and member-set tables are untouched by a run',async()=>{
  const {set}=await committedSet();
  const countsOf=async()=>Object.fromEntries(await Promise.all(['mp_member_sets','mp_member_set_members','pine_deployments','pine_memberships','users','pine_bridge_evidence','pine_source_revisions'].map(async table=>[table,(await rowDigest(db,table)).n])));
  const outside=await countsOf();
  const row=await admit(fx,makeRun(set));
  await fx.transaction(()=>insertEvent(fx,row,2,'RUNNING'));
  await fx.transaction(()=>insertEvent(fx,row,3,'NO_VALID_CANDIDATE'));
  const stored=(await fx.query('SELECT * FROM public.mp_research_runs WHERE run_id=$1',[row.run_id])).rows;
  assert.equal(stored.length,1);
  assert.deepEqual(stored[0].contract,row.contract,'the stored contract is the S2 contract, verbatim');
  assert.equal(stored[0].contract_hash,hash(canonical(stored[0].contract)),'the application recomputes the contract hash from the stored contract');
  assert.deepEqual([stored[0].owner_id,stored[0].bot_id,stored[0].member_set_id,stored[0].set_hash,stored[0].pine_count,stored[0].fixture,Number(stored[0].created_at_ms),Number(stored[0].deadline_ms)],
    [set.owner_id,set.bot_id,set.member_set_id,set.set_hash,2,true,T0MS,T0MS+600000]);
  assert.deepEqual(stored[0].contract.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B'),true);
  assert.equal('deployment_id' in stored[0].contract,false);assert.equal('status' in stored[0],false);assert.equal('result' in stored[0],false);
  const events=(await fx.query('SELECT seq,status,at_ms,reason_code,result IS NOT NULL AS has_result FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq',[row.run_id])).rows;
  assert.deepEqual(events.map(item=>[item.seq,item.status,item.has_result]),[[1,'ADMITTED',false],[2,'RUNNING',false],[3,'NO_VALID_CANDIDATE',true]]);
  assert.ok(events.every((item,index)=>index===0||Number(item.at_ms)>Number(events[index-1].at_ms)),'at_ms strictly increases');
  // the runtime role (every owner reader and worker runs as it) holds nothing and sees nothing
  for(const table of RUN_TABLES)await refused(rt.query(`SELECT 1 FROM public.${table} WHERE true`),DENIED);
  // nothing outside the run store changed
  assert.deepEqual(await countsOf(),outside);
  // owner isolation by key: the same key of another owner is another run, a repeat of the same key is refused
  await refused(fx.transaction(()=>walk(fx,makeRun(set,{idempotency_key:row.idempotency_key}))),UNIQUE_VIOLATION);
});

/* ---- 9. CLI ---- */

test('the CLI: install, second install, --inspect exit codes, both role checks, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=track(new PostgresDatabase({connectionString:cliUrl,max:2}));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  const badRole=await inspect(['--runtime-role=no_such_role_rs']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  const badFixture=await inspect(['--fixture-role=no_such_role_rs']);assert.equal(badFixture.code,1);assert.ok(badFixture.report.failures.includes('FIXTURE_ROLE_MISSING'));
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);
  assert.match(installed.stdout,/Multi-Pine run store ready: mp-run-store-v1-schema; state=INSTALLED; previous state=ABSENT; guards=15; runtime role not checked; fixture role not checked/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  const checked=await cli(['--runtime-role='+runtimeName,'--fixture-role='+fixtureName],cliUrl);assert.equal(checked.code,0,checked.stderr);assert.match(checked.stdout,/runtime role checked; fixture role checked/);
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  // without the fixture grants the fixture role lacks SELECT and INSERT; without any grant the runtime role is fine (it holds nothing)
  const ungranted=await inspect(['--runtime-role='+runtimeName,'--fixture-role='+fixtureName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('FIXTURE_ROLE_PRIVILEGE_MISSING:mp_research_runs:INSERT'),ungranted.report.failures.join());
  assert.ok(!ungranted.report.failures.some(item=>item.startsWith('RUNTIME_ROLE_')),ungranted.report.failures.join());
  await cliDb.query(await grantScript(runtimeName));await cliDb.query(await fixtureScript(runtimeName,fixtureName));
  const granted=await inspect(['--runtime-role='+runtimeName,'--fixture-role='+fixtureName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.map(item=>[item.table,item.select,item.insert,item.update,item.delete]).sort(),
    [['mp_research_run_events',false,false,false,false],['mp_research_runs',false,false,false,false],['mp_run_store_schema',false,false,false,false]]);
  assert.deepEqual(granted.report.facts.fixture_role.tables.filter(item=>item.table!=='mp_run_store_schema').map(item=>[item.table,item.select,item.insert,item.update,item.delete]).sort(),
    [['mp_research_run_events',true,true,false,false],['mp_research_runs',true,true,false,false]]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER mp_research_runs_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.mp_research_runs ENABLE ALWAYS TRIGGER mp_research_runs_no_change');
  assert.equal((await inspect()).code,0);
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--rollback','--fixture-role=x'],['--bogus'],['--runtime-role=Bad-Name'],['--fixture-role=Bad-Name'],['--runtime-role=a','--runtime-role=b']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await runStoreObjects(cliDb),NONE);
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
  // a database without the member-set extension: the install exits nonzero and writes nothing
  const bareName='robot_rs_clibare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));await bare.migrate();
  const refusedBare=await cli([],urlOf(bareName));assert.notEqual(refusedBare.code,0);assert.match(refusedBare.stderr,/member-set extension 1 required/);
  assert.deepEqual(await runStoreObjects(bare),NONE);
});

/* ---- 10. rollback, uninstall order, dump and restore (T-RS-X2) ---- */

test('rollback: empty tables are dropped completely; a row refuses it and stays; the member-set rollback fails loudly while the run store is installed (uninstall order)',async()=>{
  const {name,target,targetStore}=await cloneWithStore('rollback');
  const world=await newWorld({target,targetStore});
  // uninstall order: the member-set rollback fails on the dependent foreign keys while the run store is installed, even at zero rows, and changes nothing
  const installedDigest=await catalogDigest(target);
  await assert.rejects(rollbackMpMemberSet(target),error=>error.code===DEPENDENT&&/mp_research_runs_set(_hash)?_fkey/.test(error.detail),'member-set rollback while the run store is installed');
  assert.deepEqual(await catalogDigest(target),installedDigest,'the refused member-set rollback changed nothing');
  assert.equal((await classifyMpMemberSet(target)).state,'INSTALLED');assert.equal((await classifyMpRunStore(target)).state,'INSTALLED');
  // run store first, then the member set
  const rolled=await rollbackMpRunStore(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await runStoreObjects(target),NONE);
  assert.equal((await classifyMpMemberSet(target)).state,'INSTALLED','the member set is intact after the run store rollback');
  assert.equal((await inspectMpMemberSet(target)).ok,true);
  assert.deepEqual(await rollbackMpRunStore(target),{rolled_back:true,previous_state:'ABSENT'});
  assert.deepEqual(await rollbackMpMemberSet(target),{rolled_back:true,previous_state:'INSTALLED'});
  assert.equal((await classifyMpMemberSet(target)).state,'ABSENT','both extensions are gone');
  assert.deepEqual(await runStoreObjects(target),NONE);
  // a run store cannot be installed over a missing member set, and both come back in order
  await assert.rejects(migrateMpRunStore(target),/member-set extension 1 required/);
  await migrateMpMemberSet(target);await migrateMpRunStore(target);
  // with rows: the rollback is refused and nothing changes
  const set=await setOf(world);
  await target.transaction(()=>insertSet(target,set),{isolation:'SERIALIZABLE'});
  const row=await admit(target,makeRun(set),PATH_TO.RUNNING);
  const held=await allDigests(target),objects=await catalogDigest(target);
  await assert.rejects(rollbackMpRunStore(target),/rollback refused; 3 record row\(s\) exist in mp_research_runs, mp_research_run_events \(no change made\)/);
  assert.deepEqual(await allDigests(target),held,'the record rows are still there');assert.deepEqual(await catalogDigest(target),objects,'nothing else changed');
  assert.equal((await classifyMpRunStore(target)).state,'INSTALLED');
  // a member set that a run references cannot be removed or edited either
  await assert.rejects(rollbackMpMemberSet(target),/rollback refused; 3 record row\(s\) exist/);
  void row;void name;
  // a writer that holds a row in an open transaction blocks the rollback from counting past it (ACCESS EXCLUSIVE), then the count sees it
  const late=await cloneWithStore('rollback2');
  const lateWorld=await newWorld({target:late.target,targetStore:late.targetStore});
  const lateSet=await setOf(lateWorld);
  await late.target.transaction(()=>insertSet(late.target,lateSet),{isolation:'SERIALIZABLE'});
  const insert=gate(),finish=gate();
  const writer=late.target.transaction(async()=>{await walk(late.target,makeRun(lateSet));insert.open();await finish.promise;},{isolation:'SERIALIZABLE'});
  await insert.promise;
  const waiting=rollbackMpRunStore(track(new PostgresDatabase({connectionString:urlOf(late.name),max:2})));
  const settled=waiting.then(()=>'DROPPED',error=>error.message);
  finish.open();await writer;
  assert.match(await settled,/rollback refused; 2 record row\(s\) exist in mp_research_runs, mp_research_run_events \(no change made\)/);
});

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS, the rows and the grants',async t=>{
  const {set}=await committedSet();await admit(fx,makeRun(set),PATH_TO.FAILED);
  const restoredName='robot_rs_restore_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-rs-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'rs.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=track(new PostgresDatabase({connectionString:serialOf(restoredName)})),restoredDeleter=track(new PostgresDatabase({connectionString:serialOf(restoredName,deleterName)}));
  const restoredFixture=ser(track(new PostgresDatabase({connectionString:serialOf(restoredName,fixtureName)}))),restoredRuntime=track(new PostgresDatabase({connectionString:serialOf(restoredName,runtimeName)}));
  assert.deepEqual(await guardRows(restored),await guardRows(db));assert.equal((await guardRows(restored)).length,15);assert.ok((await guardRows(restored)).every(row=>row.tgenabled==='A'));
  assert.deepEqual(await allDigests(restored),await allDigests(db),'every stored row came back');
  assert.equal((await classifyMpRunStore(restored)).state,'INSTALLED');assert.equal((await classifyMpMemberSet(restored)).state,'INSTALLED');
  const report=await inspectMpRunStore(restored,{runtimeRole:runtimeName,fixtureRole:fixtureName});assert.equal(report.ok,true,report.failures.join());
  await refused(restoredRuntime.query('SELECT 1 FROM public.mp_research_runs'),DENIED);
  await refused(restoredFixture.query('UPDATE public.mp_research_runs SET fixture=fixture'),DENIED);
  await refused(restoredDeleter.query('UPDATE public.mp_research_runs SET fixture=fixture'),QR002);
  await refused(restoredDeleter.query('DELETE FROM public.mp_research_run_events'),QR002);
  // the guards survive the restore (a new owner, set and run in the restored database)
  const world=await newWorld({target:restored,targetStore:new Store(restored)}),set2=await setOf(world);
  await restoredFixture.transaction(()=>insertSet(restoredFixture,set2),{isolation:'SERIALIZABLE'});
  const row=makeRun(set2);
  await refusedWith(restoredFixture.transaction(()=>insertRun(restoredFixture,row),{isolation:'SERIALIZABLE'}),QR004,/seq 1 ADMITTED event written by the same transaction/);
  await admit(restoredFixture,row);
  await refusedWith(restoredFixture.transaction(()=>insertEvent(restoredFixture,row,3,'RUNNING'),{isolation:'SERIALIZABLE'}),QR004,/last seq of its run plus one/);
});
