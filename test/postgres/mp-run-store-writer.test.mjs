import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {inspectMpRunStore,migrateMpRunStore,RUN_STORE_TABLES,MARKER_TABLE} from '../../src/postgres/mp-run-store-migration.js';
import {insertMultiRun,appendRunEvent,getMultiRun,findMultiRunByKey,listMultiRuns,mapRunStoreFailure,RUN_STORE_MAX_RETRIES,RUN_STORE_GUARD,RUN_STORE_CODES,RUN_STORE_STATUSES,
  RUN_STORE_TERMINAL,RUN_LIST_MAX_LIMIT} from '../../src/postgres/mp-run-store.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {buildMemberSet} from '../../src/multi-pine/member-set.js';
import {buildMultiResearchContract} from '../../src/multi-pine/run-contract.js';
import {MP_CODES} from '../../src/multi-pine/codes.js';
import {RULES} from '../../src/quant-research/contract.js';

// F11-01 RS-2: the writer and readers of the internal multi-Pine run store (src/postgres/mp-run-store.js), proven on a throwaway PostgreSQL cluster as real non-owner
// LOGIN roles with the repo grant scripts: the fixture role runs every call, the runtime role must get 42501 from all of them. Every row is a LABELLED FIXTURE
// (fixture=true, synthetic, never a research result). Rows are insert-only, so a case that needs a clean slate uses its own owner. A tampered row is planted by the
// schema owner inside a transaction that is always rolled back.
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const GRANT_SCRIPT=new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url);
const FIXTURE_SCRIPT=new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url);
const QR003='QR003',QR004='QR004',DENIED='42501',SERIALIZATION='40001',UNIQUE_VIOLATION='23505',LOCK_UNAVAILABLE='55P03',ABORTED='25P02';
const T0=1790000000000,T0MS=1790000000000,UTC='2026-10-20T10:00:00Z';
let admin,db,rt,fx,connectionString,templateName,databaseName,runtimeName,fixtureName,store;
const databases=[],pools=[],extraRoles=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every run-store writer is SERIALIZABLE (QR003 otherwise): the pool defaults to it for autocommit statements (a connection option) and for its transactions (ser).
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const track=pool=>{pools.push(pool);return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let body=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))body=body.replaceAll(":'"+variable+"'","'"+value+"'");return body;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Source text without block comments, full-line comments and trailing line comments (what the static scans judge). */
const stripComments=source=>source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|\s)\/\/.*$/gm,'$1');
/** Table names after FROM, INTO or JOIN: case-insensitive, with ONLY, a public. prefix and double quotes. */
const tableNames=source=>[...source.matchAll(/\b(?:FROM|INTO|JOIN)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([a-z_]+)"?/gi)].map(match=>match[1].toLowerCase());
const writesOtherThanInsert=source=>/\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?[a-z_]+|\bDELETE\s+FROM\b|\bTRUNCATE\b/i.test(source);
async function until(check,label,limit=15000){
  const start=Date.now();
  while(Date.now()-start<limit){if(await check())return;await sleep(50);}
  throw Error('timeout waiting for '+label);
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog or rows. */
async function probe(target,fn){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();},{isolation:'SERIALIZABLE'});}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const allDigests=async target=>Object.fromEntries(await Promise.all([MARKER_TABLE,...RUN_STORE_TABLES].map(async table=>[table,await rowDigest(target,table)])));
const dbClockMs=async target=>Number((await target.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms')).rows[0].ms);

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_rw_tpl_'+suffix;databaseName='robot_rw_main_'+suffix;
  runtimeName='robot_rw_rt_'+suffix.slice(0,14);fixtureName='robot_rw_fx_'+suffix.slice(0,14);
  for(const name of [runtimeName,fixtureName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  extraRoles.push(runtimeName,fixtureName);
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    await install(builder,'pine-bridge-schema.sql');
    await migrateMpMemberSet(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName),max:8})));
  store=new Store(db);
  await migrateMpRunStore(db);
  await db.query(await roleScript(GRANT_SCRIPT,{runtime_role:runtimeName}));
  await db.query(await roleScript(FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,runtimeName),max:4})));
  fx=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:8})));
  const report=await inspectMpRunStore(db,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(report.ok,true,report.failures?.join());
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of extraRoles)await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

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
async function newWorld({count=2,exit='bridge-exit-v2'}={}){
  const user=await store.createUser({email:'rw-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=user;
  const ids=Array.from({length:count},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,pine:id,version:1,sourceHash:hash('source-'+id),analysis:{effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i'+(i+1)}]},dep:'dep-'+randomUUID()}));
  for(const m of specs){
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$8,1,$3,$4,$5,$6,$7)',[m.pine,user.id,m.sourceHash,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(m.analysis),T0,bot.id]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,m.sourceHash,'//@version=6\nindicator("x")',JSON.stringify(m.analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot.id]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:m.sourceHash,analysis:m.analysis}));
  for(const m of specs){
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital:CAPITAL,funding_cutoff:7,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection:{bridge:{atr_multiplier:2,rr:1.5},bindings:[]},market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:m.sourceHash,
      instruction_versions:{template:'fixture'},artifact_hash:hash('artifact-'+m.pine)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n);
    await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$7,$3,1,$4,$5,'DRAFT',$6)",
      [m.dep,user.id,m.pine,JSON.stringify(snapshot),snapshotHash,T0,bot.id]);
    await db.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
  }
  return {id:user.id,bot:bot.id,specs,exit};
}
async function rowsOf(world){
  const memberships=(await db.query(`SELECT m.pine_import_id,m.owner_id,m.bot_id,m.source_version,r.source_hash,m.connected,r.analysis FROM pine_memberships m
    JOIN pine_source_revisions r ON r.pine_import_id=m.pine_import_id AND r.source_version=m.source_version WHERE m.owner_id=$1 ORDER BY m.pine_import_id`,[world.id])).rows;
  const deployments=(await db.query('SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash FROM pine_deployments WHERE owner_id=$1 ORDER BY deployment_id',[world.id]))
    .rows.map(row=>({...row,exit_version:world.exit}));
  const evidence=(await db.query('SELECT e.deployment_id,e.snapshot_hash,e.evidence,e.evidence_hash FROM pine_bridge_evidence e JOIN pine_deployments d USING(deployment_id) WHERE d.owner_id=$1 ORDER BY e.deployment_id',[world.id])).rows;
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
async function insertSet(target,set){
  await target.query(PARENT_SQL,[set.member_set_id,set.owner_id,set.bot_id,set.version,set.pine_count,set.membership_hash,set.content_digest,set.set_hash,set.execution_model_hash,set.policy_hash,
    set.capital_basis_hash,set.funding_cutoff,set.bridge_pair.atr_multiplier,set.bridge_pair.rr,set.exit_version,set.same_bar_order,set.fixture,JSON.stringify(set),set.created_at]);
  for(const member of set.members)
    await target.query(MEMBER_SQL,[set.member_set_id,member.ordinal,set.owner_id,set.bot_id,member.pine_import_id,member.source_version,member.source_hash,member.effective_inputs_hash,
      member.deployment_id,member.deployment_snapshot_hash,member.exit_version,member.evidence_hash]);
}
/** A fresh world with a frozen (committed) member set, written by the fixture role. */
async function committedSet({count=2}={}){
  const world=await newWorld({count});
  const set=await setOf(world);
  await fx.transaction(()=>insertSet(fx,set));
  return {world,set};
}
const START=29333333*60000,BARS=5000;
function contractOf(set,over={}){
  const built=buildMultiResearchContract({member_set:structuredClone(set),member_set_id:set.member_set_id,set_hash:set.set_hash,membership_hash:set.membership_hash,pine_count:set.pine_count,
    members:structuredClone(set.members),owner_id:set.owner_id,bot_id:set.bot_id,policy_hash:set.policy_hash,funding_cutoff:set.funding_cutoff,capital_accounts:structuredClone(CAPITAL),
    model:structuredClone(MODEL),rules:structuredClone(RULES),engine_hash:hash('engine'),dataset:{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,content_digest:hash('digest')},
    budget:{candidates:30},seed:42,bridge_domains:{atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'}},fixture:true,...over});
  assert.equal(built.ok,true,JSON.stringify(built));
  return built.contract;
}
const keyOf=()=>'rw-'+randomUUID().replaceAll('-','');
/** The insertMultiRun input for a frozen set; over replaces fields. */
const inputOf=(set,over={})=>({member_set:structuredClone(set),contract:contractOf(set),idempotency_key:keyOf(),submission_hash:hash('submission-'+randomUUID()),created_at_ms:T0MS,deadline_ms:T0MS+600000,...over});
/** Admits a run through the module in the fixture role's own SERIALIZABLE transaction. */
async function admitRun(set,over={}){
  const input=inputOf(set,over);
  const out=await fx.transaction(()=>insertMultiRun(fx,input));
  assert.equal(out.ok,true,JSON.stringify(out));
  return {input,out,run_id:out.run.run_id,owner_id:set.owner_id};
}
const resultFor=(admitted,over={})=>({run_id:admitted.run_id,contract_hash:admitted.out.run.contract_hash,owner_recommendation_ready:false,
  acceptance_blockers:[...admitted.input.contract.acceptance_blockers],fixture:true,funnel:{members:admitted.input.contract.pine_count},...over});
const append=(admitted,status,extra={})=>appendRunEvent(fx,{owner_id:admitted.owner_id,run_id:admitted.run_id,status,...extra});
const fieldsFor=(admitted,status)=>
  status==='SUCCEEDED'||status==='NO_VALID_CANDIDATE'?{result:resultFor(admitted)}:['FAILED','CANCELLED','TIMED_OUT'].includes(status)?{reason_code:'FIXTURE_'+status}:{};
const PATH_TO={ADMITTED:[],RUNNING:['RUNNING'],SUCCEEDED:['RUNNING','SUCCEEDED'],NO_VALID_CANDIDATE:['RUNNING','NO_VALID_CANDIDATE'],FAILED:['RUNNING','FAILED'],CANCELLED:['RUNNING','CANCELLED'],TIMED_OUT:['RUNNING','TIMED_OUT']};
/** A new run walked to the given status through appendRunEvent. */
async function runAt(set,status,over={}){
  const admitted=await admitRun(set,over);
  for(const step of PATH_TO[status]){
    const out=await append(admitted,step,fieldsFor(admitted,step));
    assert.equal(out.ok,true,step+': '+JSON.stringify(out));
  }
  return admitted;
}
const ownerOf=admitted=>({owner_id:admitted.owner_id,run_id:admitted.run_id});
const runCount=async()=>(await db.query('SELECT count(*)::int n FROM public.mp_research_runs')).rows[0].n;
const eventCount=async run_id=>(await db.query('SELECT count(*)::int n FROM public.mp_research_run_events WHERE run_id=$1',[run_id])).rows[0].n;
/** Plants a tamper with the schema owner inside a rolled-back transaction, then reads with the module (still inside it). */
const tampered=(statements,read)=>probe(db,async()=>{
  for(const statement of statements)await (Array.isArray(statement)?db.query(statement[0],statement[1]):db.query(statement));
  return read(db);
});
const NO_RUN_TRIGGER='ALTER TABLE public.mp_research_runs DISABLE TRIGGER mp_research_runs_no_change';
const NO_EVENT_TRIGGER='ALTER TABLE public.mp_research_run_events DISABLE TRIGGER mp_research_run_events_no_change';
const NO_SET_TRIGGER='ALTER TABLE public.mp_member_sets DISABLE TRIGGER mp_member_sets_no_change';

/* ---- 1. pure: constants, imports, failure mapping ---- */

test('module: the plan constants; no SAVEPOINT or EXCEPTION block in the executable code (K4); only the S1/S2 pure modules and the hash helper are imported; no runtime root names it',async()=>{
  assert.equal(RUN_STORE_MAX_RETRIES,3);
  assert.deepEqual({...RUN_STORE_GUARD},{RUN:'mp_research_runs_guard',STALE:'mp_research_runs_set_stale',COMPLETE:'mp_research_runs_complete',ORDER:'mp_research_run_events_order',
    RESULT:'mp_research_run_events_result',TRANSITION:'mp_research_run_events_transition'});
  assert.deepEqual([...RUN_STORE_STATUSES],['ADMITTED','RUNNING','SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
  assert.deepEqual([...RUN_STORE_TERMINAL],['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
  assert.equal(RUN_STORE_CODES.NOT_FOUND,'NOT_FOUND');
  const text=await sqlText('mp-run-store.js');
  const code=stripComments(text);
  assert.doesNotMatch(code,/SAVEPOINT|EXCEPTION|BEGIN\b|COMMIT\b|ROLLBACK\b|process\.env|setTimeout/i,'the module opens no savepoint and no exception block and reads no environment');
  // P6: no other way to load code: dynamic import, require, a side-effect import, eval, new Function
  assert.doesNotMatch(code,/\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b|^\s*import\s*['"]|\beval\s*\(|\bnew\s+Function\b/m,'no dynamic import, require, side-effect import or eval');
  for(const sample of ["await import('x')","import ( 'x' )","const a=require('x')","import 'x';","import\n'x';",'eval("1")','new Function("1")'])
    assert.match(sample,/\bimport\s*\(|\brequire\s*\(|\bcreateRequire\b|^\s*import\s*['"]|\beval\s*\(|\bnew\s+Function\b/m,'the scan catches: '+sample);
  assert.deepEqual([...text.matchAll(/^import .* from '([^']+)'/gm)].map(match=>match[1]).sort(),
    ['../multi-pine/codes.js','../multi-pine/member-set.js','../multi-pine/run-contract.js','../pine-bridge/source.js','node:crypto']);
  // the guard names are the trigger names of the SQL file
  const sql=await sqlText('mp-run-store.sql');
  for(const name of Object.values(RUN_STORE_GUARD))assert.match(sql,new RegExp('CREATE (CONSTRAINT )?TRIGGER '+name+' '),name);
});

test('mapRunStoreFailure: each guard by constraint name; storage refusals for CHECK, foreign key, not-null and other unique violations; the rest is not ours',()=>{
  const fail=(code,constraint)=>Object.assign(new Error('x'),{code,constraint});
  const diag=(code,constraint)=>mapRunStoreFailure(fail(code,constraint));
  assert.deepEqual(diag('QR004',RUN_STORE_GUARD.STALE),{ok:false,code:MP_CODES.MEMBER_SET_STALE,diagnostic:{stage:'store',field:'insert_guard',guard:RUN_STORE_GUARD.STALE}});
  const invalid=(field,guard)=>({ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field,guard}});
  assert.deepEqual(diag('QR004',RUN_STORE_GUARD.RUN),invalid('storage.binding',RUN_STORE_GUARD.RUN));
  assert.deepEqual(diag('QR004',RUN_STORE_GUARD.COMPLETE),invalid('storage.complete',RUN_STORE_GUARD.COMPLETE));
  assert.deepEqual(diag('QR004',RUN_STORE_GUARD.TRANSITION),invalid('run.transition',RUN_STORE_GUARD.TRANSITION));
  assert.deepEqual(diag('QR004',RUN_STORE_GUARD.ORDER),invalid('run.order',RUN_STORE_GUARD.ORDER));
  assert.deepEqual(diag('QR004',RUN_STORE_GUARD.RESULT),invalid('run.result',RUN_STORE_GUARD.RESULT));
  assert.equal(diag('QR004','some_other_guard'),null,'an unknown guard is a defect: rethrown');
  assert.equal(diag('QR004',undefined),null);
  for(const code of ['23514','23503','23502'])assert.deepEqual(diag(code,'a_constraint'),{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'storage',sqlstate:code,constraint:'a_constraint'}});
  assert.deepEqual(diag('23505','mp_research_runs_pkey'),{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'storage',sqlstate:'23505',constraint:'mp_research_runs_pkey'}});
  assert.equal(diag('23505','mp_research_runs_idempotency_key'),null,'a lost key race is rethrown to the admission transaction');
  assert.equal(diag('23505','mp_research_run_events_pkey'),null,'a duplicate seq is a lost race');
  for(const code of ['40001','40P01','QR002','QR003','42501','25P02','XX000'])assert.equal(diag(code,'x'),null,code);
  assert.equal(mapRunStoreFailure(undefined),null);assert.equal(mapRunStoreFailure(null),null);assert.equal(mapRunStoreFailure('boom'),null);
});

/* ---- 2. insertMultiRun: round trip, replay, conflict (W1, W2) ---- */

test('insertMultiRun: ADMIT writes the run and its seq 1 ADMITTED event in the caller transaction; the run loads through the readers; the application clock stays, the event clock is the database clock',async()=>{
  const {set}=await committedSet();
  const input=inputOf(set,{created_at_ms:T0MS+7,deadline_ms:T0MS+7+900000});
  const clockBefore=await dbClockMs(db);
  const out=await fx.transaction(()=>insertMultiRun(fx,input));
  const clockAfter=await dbClockMs(db);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.action,'ADMIT');
  assert.match(out.run.run_id,/^[0-9a-f-]{36}$/);
  assert.equal(out.run.contract_hash,hash(canonical(input.contract)));assert.equal(out.run.status,'ADMITTED');assert.equal(out.run.owner_recommendation_ready,false);
  assert.deepEqual(Object.keys(out).sort(),['action','ok','run']);
  const stored=(await db.query('SELECT * FROM public.mp_research_runs WHERE run_id=$1',[out.run.run_id])).rows[0];
  assert.equal(stored.created_at_ms,T0MS+7,'created_at_ms is the application clock');assert.equal(stored.deadline_ms,T0MS+7+900000);
  assert.equal(stored.fixture,true);assert.equal(stored.idempotency_key,input.idempotency_key);assert.equal(stored.submission_hash,input.submission_hash);
  assert.equal(stored.contract_hash,out.run.contract_hash);assert.equal(stored.contract_version,'ql3a-research-job-multi-v1');
  assert.equal(canonical(stored.contract),canonical(input.contract));
  const events=(await db.query('SELECT * FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq',[out.run.run_id])).rows;
  assert.equal(events.length,1);assert.deepEqual([events[0].seq,events[0].status,events[0].reason_code,events[0].result,events[0].result_hash],[1,'ADMITTED',null,null,null]);
  assert.ok(events[0].at_ms>=clockBefore&&events[0].at_ms<=clockAfter,'the event time is the database clock, not the placeholder the writer sent');
  const read=await getMultiRun(fx,{owner_id:set.owner_id,run_id:out.run.run_id});
  assert.equal(read.ok,true,JSON.stringify(read));
  assert.deepEqual([read.status,read.terminal,read.owner_recommendation_ready],['ADMITTED',false,false]);
  assert.deepEqual(read.acceptance_blockers,input.contract.acceptance_blockers);
  assert.equal(canonical(read.run.contract),canonical(input.contract));assert.equal(read.run.created_at_ms,T0MS+7);
});

test('insertMultiRun: the same key and submission loads the stored run (also from a later status), another submission is MP_INPUT_INVALID idempotency_key; neither writes',async()=>{
  const {set}=await committedSet();
  const first=await admitRun(set);
  const before=await allDigests(db);
  const replay=await fx.transaction(()=>insertMultiRun(fx,{...first.input,created_at_ms:T0MS+5,deadline_ms:T0MS+5+60000}));
  assert.deepEqual(replay,{ok:true,action:'LOAD',run:{run_id:first.run_id,contract_hash:first.out.run.contract_hash,status:'ADMITTED',owner_recommendation_ready:false}});
  assert.deepEqual(await allDigests(db),before,'a LOAD writes nothing');
  const conflict=await fx.transaction(()=>insertMultiRun(fx,{...first.input,submission_hash:hash('another submission')}));
  assert.deepEqual(conflict,{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'idempotency_key'}});
  assert.deepEqual(await allDigests(db),before,'a conflict writes nothing');
  assert.equal((await append(first,'RUNNING')).ok,true);
  const later=await fx.transaction(()=>insertMultiRun(fx,first.input));
  assert.deepEqual([later.ok,later.action,later.run.run_id,later.run.status],[true,'LOAD',first.run_id,'RUNNING']);
  // the key is per owner and Bot: the same key under another owner is a new run
  const other=await committedSet();
  const second=await fx.transaction(()=>insertMultiRun(fx,inputOf(other.set,{idempotency_key:first.input.idempotency_key})));
  assert.deepEqual([second.ok,second.action],[true,'ADMIT']);assert.notEqual(second.run.run_id,first.run_id);
  // findMultiRunByKey agrees
  const found=await findMultiRunByKey(fx,{owner_id:set.owner_id,bot_id:set.bot_id,idempotency_key:first.input.idempotency_key});
  assert.deepEqual([found.ok,found.found,found.run.run_id,found.status],[true,true,first.run_id,'RUNNING']);
});

test('insertMultiRun: a loaded run is re-checked; a stored run that fails an integrity check is refused instead of loaded',async()=>{
  const {set}=await committedSet();
  const first=await admitRun(set);
  const out=await tampered([NO_RUN_TRIGGER,["UPDATE public.mp_research_runs SET contract=jsonb_set(contract,'{seed}','43'::jsonb) WHERE run_id=$1",[first.run_id]]],
    ()=>insertMultiRun(db,first.input).catch(error=>({error})));
  // db is the schema owner outside any transaction here: probe wraps the call in one, so db.isTransaction is true and the module reads the tampered row
  assert.equal(out.ok,false,JSON.stringify(out));assert.equal(out.code,MP_CODES.INPUT_INVALID);
  assert.deepEqual([out.diagnostic.stage,out.diagnostic.field,out.diagnostic.run_id],['stored','contract_hash',first.run_id]);
});

/* ---- 3. insertMultiRun: refusals before any statement leave the transaction usable (W1) ---- */

test('insertMultiRun: input refusals are pure (no statement ran, nothing written, the transaction stays usable); the field names the problem',async()=>{
  const {set}=await committedSet();
  const base=inputOf(set),before=await allDigests(db);
  const cases=[
    ['not an object',null,'input'],['array',[],'input'],
    ['unknown key',{...base,extra:1},'input.extra'],['deployment_id key',{...base,deployment_id:'d'},'input.deployment_id'],['run_id key',{...base,run_id:randomUUID()},'input.run_id'],
    ['member_set missing',(({member_set,...rest})=>rest)(base),'member_set'],['contract missing',(({contract,...rest})=>rest)(base),'contract'],
    ['key missing',(({idempotency_key,...rest})=>rest)(base),'idempotency_key'],['hash missing',(({submission_hash,...rest})=>rest)(base),'submission_hash'],
    ['created missing',(({created_at_ms,...rest})=>rest)(base),'created_at_ms'],['deadline missing',(({deadline_ms,...rest})=>rest)(base),'deadline_ms'],
    ['key too short',{...base,idempotency_key:'short'},'idempotency_key'],['key too long',{...base,idempotency_key:'k'.repeat(129)},'idempotency_key'],
    ['key bad character',{...base,idempotency_key:'bad key bad key'},'idempotency_key'],['key not a string',{...base,idempotency_key:12345678},'idempotency_key'],
    ['hash upper case',{...base,submission_hash:'A'.repeat(64)},'submission_hash'],['hash short',{...base,submission_hash:'a'.repeat(63)},'submission_hash'],
    ['created zero',{...base,created_at_ms:0,deadline_ms:60000},'created_at_ms'],['created float',{...base,created_at_ms:1.5},'created_at_ms'],
    ['created string',{...base,created_at_ms:String(T0MS)},'created_at_ms'],['created beyond range',{...base,created_at_ms:8_640_000_000_000_001},'created_at_ms'],
    ['deadline 59999 ms after',{...base,deadline_ms:T0MS+59999},'deadline_ms'],['deadline equal',{...base,deadline_ms:T0MS},'deadline_ms'],
    ['deadline 900001 ms after',{...base,deadline_ms:T0MS+900001},'deadline_ms'],['deadline float',{...base,deadline_ms:T0MS+60000.5},'deadline_ms'],
    ['readFresh not a function',{...base,readFresh:true},'readFresh']];
  await fx.transaction(async()=>{
    for(const [label,input,field] of cases) {
      const out=await insertMultiRun(fx,input);
      assert.deepEqual([out.ok,out.code,out.diagnostic?.stage,out.diagnostic?.field],[false,MP_CODES.INPUT_INVALID,'store',field],label+': '+JSON.stringify(out));
      assert.equal(out.diagnostic.rollback_required,undefined,label);
    }
    // the border values pass the input check (and are admitted later); the transaction is still usable
    for(const [label,over] of [['deadline at the minimum',{deadline_ms:T0MS+60000}],['deadline at the maximum',{deadline_ms:T0MS+900000}]]) {
      const out=await insertMultiRun(fx,inputOf(set,over));
      assert.deepEqual([out.ok,out.action],[true,'ADMIT'],label+': '+JSON.stringify(out));
    }
    assert.equal((await fx.query('SELECT 1 AS one')).rows[0].one,1);
    throw new Rollback();
  }).catch(error=>{if(!(error instanceof Rollback))throw error;});
  assert.deepEqual(await allDigests(db),before,'nothing was written');
  // outside a transaction: refused without a statement, whatever the input
  const outside=await insertMultiRun(fx,base);
  assert.deepEqual(outside,{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'db.transaction'}});
  for(const bad of [null,undefined,{}])assert.equal((await insertMultiRun(bad,base)).diagnostic.field,'db.transaction');
  assert.deepEqual(await allDigests(db),before);
});

test('insertMultiRun: the contract must be a valid multi-Pine contract and equal the frozen member set; a non-fixture or malformed one is refused with the pure code',async()=>{
  const {set}=await committedSet(),other=await committedSet();
  const base=inputOf(set),before=await allDigests(db);
  const mutate=(change)=>{const contract=structuredClone(base.contract);change(contract);return {...base,contract};};
  const refusedFirst=async(input)=>fx.transaction(async()=>insertMultiRun(fx,input));
  const cases=[
    ['fixture false',mutate(c=>{c.fixture=false;}),MP_CODES.FIXTURE_ONLY,'fixture'],
    ['extra top-level key',mutate(c=>{c.deployment_id='d';}),MP_CODES.INPUT_INVALID,'deployment_id'],
    ['key removed',mutate(c=>{delete c.seed;}),MP_CODES.INPUT_INVALID,'seed'],
    ['candidates zero',mutate(c=>{c.budget.candidates=0;}),MP_CODES.INPUT_INVALID,'budget.candidates'],
    ['not an object',{...base,contract:'text'},MP_CODES.INPUT_INVALID,'contract'],
    ['mode',mutate(c=>{c.mode='ONE_PINE';}),MP_CODES.INPUT_INVALID,'mode']];
  for(const [label,input,code,field] of cases) {
    const out=await refusedFirst(input);
    assert.deepEqual([out.ok,out.code,out.diagnostic.stage,out.diagnostic.field],[false,code,'contract',field],label+': '+JSON.stringify(out));
  }
  // a valid contract that differs from the member set it travels with
  const swapped=await refusedFirst({...base,member_set:structuredClone(other.set)});
  assert.deepEqual([swapped.ok,swapped.code,swapped.diagnostic.field],[false,MP_CODES.INPUT_INVALID,'contract.owner_id'],JSON.stringify(swapped));
  assert.equal(swapped.diagnostic.against,'member_set');
  const tamperedSet=structuredClone(set);tamperedSet.policy_hash='f'.repeat(64);
  const forged=await refusedFirst({...base,member_set:tamperedSet});
  assert.equal(forged.ok,false);assert.equal(forged.code,MP_CODES.INPUT_INVALID,'a member set record that fails the S1 check is refused: '+JSON.stringify(forged));
  for(const key of ['policy_hash','funding_cutoff','set_hash','membership_hash','member_set_id','bot_id']) {
    const out=await refusedFirst(mutate(c=>{c[key]=typeof c[key]==='number'?c[key]+1:key==='member_set_id'?randomUUID():key==='bot_id'?'someone-else':'1'.repeat(64);}));
    assert.equal(out.ok,false,key);
    assert.ok(out.diagnostic.field===key||out.diagnostic.field==='contract.'+key||out.diagnostic.stage==='contract',key+': '+JSON.stringify(out));
  }
  // a model that is valid but not the model the set froze
  const model=mutate(c=>{c.model={...c.model,fee_bps:1};});
  const modelOut=await refusedFirst(model);
  assert.deepEqual([modelOut.ok,modelOut.diagnostic.field,modelOut.diagnostic.against],[false,'contract.model','member_set.execution_model_hash'],JSON.stringify(modelOut));
  assert.deepEqual(await allDigests(db),before,'nothing was written');
});

/* ---- 4. database guards mapped by constraint name; a database refusal aborts the caller transaction ---- */

test('insertMultiRun: the run guard (parent set row absent) maps to storage.binding; the transaction is aborted and the refusal says so; nothing is written',async()=>{
  const world=await newWorld(),unfrozen=await setOf(world);
  const before=await allDigests(db);
  const state={};
  const out=await fx.transaction(async()=>{
    const refusal=await insertMultiRun(fx,inputOf(unfrozen));
    state.after=await fx.query('SELECT 1 AS one').then(()=>null,error=>error.code);
    return refusal;
  });
  assert.deepEqual([out.ok,out.code,out.diagnostic.stage,out.diagnostic.field,out.diagnostic.guard],[false,MP_CODES.INPUT_INVALID,'store','storage.binding',RUN_STORE_GUARD.RUN],JSON.stringify(out));
  assert.equal(out.diagnostic.rollback_required,true);
  assert.equal(state.after,ABORTED,'a database refusal leaves the caller transaction aborted: the caller must roll back');
  assert.deepEqual(await allDigests(db),before,'the aborted transaction wrote nothing');
});

test('insertMultiRun: a stale member set (each change after the freeze) is MP_MEMBER_SET_STALE from the database stale guard; a fresh set is admitted',async()=>{
  const before=await allDigests(db);
  const tampers=[
    ['deployment READY',(w,s)=>db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[s.members[0].deployment_id])],
    ['membership disconnected',(w,s)=>db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[s.members[1].pine_import_id])],
    ['evidence hash changed',(w,s)=>db.query('UPDATE pine_bridge_evidence SET evidence_hash=$2 WHERE deployment_id=$1',[s.members[0].deployment_id,'a'.repeat(64)])],
    ['snapshot hash changed',(w,s)=>db.query('UPDATE pine_deployments SET snapshot_hash=$2 WHERE deployment_id=$1',[s.members[0].deployment_id,'e'.repeat(64)])]];
  for(const [label,change] of tampers) {
    const {world,set}=await committedSet();
    await change(world,set);
    const out=await fx.transaction(()=>insertMultiRun(fx,inputOf(set)));
    assert.deepEqual([out.ok,out.code,out.diagnostic.stage,out.diagnostic.field,out.diagnostic.guard,out.diagnostic.rollback_required],
      [false,MP_CODES.MEMBER_SET_STALE,'store','insert_guard',RUN_STORE_GUARD.STALE,true],label+': '+JSON.stringify(out));
  }
  assert.deepEqual(await allDigests(db),before,'no stale run left a row');
  const fresh=await committedSet();
  assert.equal((await fx.transaction(()=>insertMultiRun(fx,inputOf(fresh.set)))).ok,true);
});

test('insertMultiRun: a run behind a SAVEPOINT is refused by the transition guard (run.transition); the commit-time completeness failure maps to storage.complete (K4)',async()=>{
  const {set}=await committedSet();
  const before=await allDigests(db);
  const out=await fx.transaction(async()=>{
    await fx.query('SAVEPOINT behind');
    return insertMultiRun(fx,inputOf(set));
  });
  assert.deepEqual([out.ok,out.code,out.diagnostic.field,out.diagnostic.guard,out.diagnostic.rollback_required],[false,MP_CODES.INPUT_INVALID,'run.transition',RUN_STORE_GUARD.TRANSITION,true],JSON.stringify(out));
  assert.deepEqual(await allDigests(db),before);
  // A raw run at the top level whose seq 1 event sits in a released subtransaction commits nothing: the deferred completeness guard fails at COMMIT.
  const contract=contractOf(set),run_id=randomUUID();
  const error=await fx.transaction(async()=>{
    await fx.query(`INSERT INTO public.mp_research_runs(run_id,owner_id,bot_id,member_set_id,set_hash,membership_hash,pine_count,contract_version,contract,contract_hash,idempotency_key,submission_hash,
      engine_hash,dataset_content_digest,created_at_ms,deadline_ms,fixture) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
    [run_id,set.owner_id,set.bot_id,set.member_set_id,set.set_hash,set.membership_hash,set.pine_count,contract.version,JSON.stringify(contract),hash(canonical(contract)),keyOf(),hash('s'),
      contract.engine_hash,contract.dataset.content_digest,T0MS,T0MS+60000]);
    await fx.query('SAVEPOINT inner_event');
    await fx.query("INSERT INTO public.mp_research_run_events(run_id,seq,status,at_ms) VALUES($1,1,'ADMITTED',1)",[run_id]);
    await fx.query('RELEASE SAVEPOINT inner_event');
  }).then(()=>null,failure=>failure);
  assert.equal(error?.code,QR004,String(error));assert.equal(error.constraint,RUN_STORE_GUARD.COMPLETE);
  assert.deepEqual(mapRunStoreFailure(error),{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'storage.complete',guard:RUN_STORE_GUARD.COMPLETE}});
  assert.deepEqual(await allDigests(db),before,'nothing committed');
});

test('insertMultiRun: a real CHECK failure maps to a storage refusal through the same mapper',async()=>{
  const {set}=await committedSet(),admitted=await admitRun(set);
  // the guards pass (a FAILED event with a reason is allowed after ADMITTED); the CHECK on the reason_code shape then fails
  const error=await fx.transaction(()=>fx.query("INSERT INTO public.mp_research_run_events(run_id,seq,status,at_ms,reason_code) VALUES($1,2,'FAILED',1,'bad code')",[admitted.run_id])).then(()=>null,failure=>failure);
  assert.equal(error?.code,'23514',String(error));
  assert.deepEqual(mapRunStoreFailure(error),{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'storage',sqlstate:'23514',constraint:'mp_research_run_events_reason_code_check'}});
});

/* ---- 5. the transaction contract: SERIALIZABLE, locks, no retry (W1) ---- */

test('insertMultiRun: the first statement checks the isolation level; READ COMMITTED and REPEATABLE READ throw QR003 (rethrown, not mapped) on every path: ADMIT, LOAD, key conflict, readFresh refusal',async()=>{
  const {set}=await committedSet();
  const existing=await admitRun(set);
  const before=await allDigests(db);
  for(const isolation of ['READ COMMITTED','REPEATABLE READ']) {
    let fresh=0;
    const paths=[['ADMIT',inputOf(set)],['LOAD',existing.input],['key conflict',{...existing.input,submission_hash:hash('another submission')}],
      ['readFresh refusal',inputOf(set,{readFresh:async()=>{fresh+=1;return {ok:false,code:MP_CODES.MEMBER_SET_STALE,diagnostic:{stage:'fresh'}};}})]];
    for(const [label,input] of paths) {
      const error=await fx.transaction(()=>insertMultiRun(fx,input),{isolation}).then(value=>({value}),failure=>failure);
      assert.equal(error?.code,QR003,isolation+' '+label+': '+JSON.stringify(error?.value??String(error)));
      assert.match(error.message,/SERIALIZABLE/,label);
    }
    assert.equal(fresh,0,isolation+': readFresh never ran');
  }
  assert.deepEqual(await allDigests(db),before);
  // the check is the first and only statement when it fails (stubbed connection): nothing else is read or locked
  let queries=0;
  const weak={isTransaction:true,query:async()=>{queries+=1;return {rows:[{level:'read committed'}]};}};
  await assert.rejects(insertMultiRun(weak,existing.input),{code:QR003});
  assert.equal(queries,1);
  // a serializable answer lets the call continue
  const strong=await fx.transaction(()=>insertMultiRun(fx,existing.input));
  assert.deepEqual([strong.ok,strong.action],[true,'LOAD']);
});

test('insertMultiRun: the FOR SHARE locks cover the Bot memberships and the member deployments until commit; a change after the snapshot fails with 40001 and is not retried',async()=>{
  const {world,set}=await committedSet();
  const state={deployments:[],memberships:[]};
  const first=await fx.transaction(async()=>{
    const out=await insertMultiRun(fx,inputOf(set));
    // P5: another session cannot take a row lock on ANY membership row of the Bot or on ANY member deployment while the admission transaction is open (one NOWAIT per row)
    for(const member of set.members) {
      state.deployments.push(await db.query('SELECT deployment_id FROM pine_deployments WHERE deployment_id=$1 FOR UPDATE NOWAIT',[member.deployment_id]).then(()=>null,error=>error.code));
      state.memberships.push(await db.query('SELECT pine_import_id FROM pine_memberships WHERE pine_import_id=$1 FOR UPDATE NOWAIT',[member.pine_import_id]).then(()=>null,error=>error.code));
    }
    return out;
  });
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal((await db.query('SELECT count(*)::int n FROM pine_memberships WHERE owner_id=$1',[world.id])).rows[0].n,set.members.length,'every membership row of the Bot is a member');
  assert.equal(set.members.length,2);
  assert.deepEqual(state.deployments,Array(set.members.length).fill(LOCK_UNAVAILABLE));
  assert.deepEqual(state.memberships,Array(set.members.length).fill(LOCK_UNAVAILABLE));
  // after the commit the locks are gone
  await db.query('SELECT deployment_id FROM pine_deployments WHERE owner_id=$1 FOR UPDATE NOWAIT',[world.id]);
  // a member row changed and committed after the transaction's snapshot: the lock step fails the attempt with a serialization failure
  const second=await committedSet();
  const before=await allDigests(db);
  let queries=0;
  const counted={isTransaction:true,query:(...args)=>{queries+=1;return fx.query(...args);}};
  const error=await fx.transaction(async()=>{
    await fx.query('SELECT 1 AS snapshot');
    await db.query('UPDATE pine_deployments SET created_at=created_at WHERE deployment_id=$1',[second.set.members[0].deployment_id]);
    return insertMultiRun(counted,inputOf(second.set));
  }).then(()=>null,failure=>failure);
  assert.equal(error?.code,SERIALIZATION,String(error));
  assert.equal(queries,4,'isolation check, lookup, membership lock, deployment lock: it stopped at the failing lock and did not retry');
  assert.deepEqual(await allDigests(db),before);
  // the caller restarts the whole transaction: the new snapshot admits
  assert.equal((await fx.transaction(()=>insertMultiRun(fx,inputOf(second.set)))).ok,true);
});

test('insertMultiRun: a lost idempotency-key race surfaces to the caller as 40001 (or the key unique violation) and is not retried; the caller restart loads the winner',async()=>{
  const {set}=await committedSet();
  const a=inputOf(set),b={...inputOf(set),idempotency_key:a.idempotency_key,submission_hash:a.submission_hash};
  const inserted=gate(),release=gate();
  const winner=fx.transaction(async()=>{
    const out=await insertMultiRun(fx,a);
    inserted.open();
    await release.promise;
    return out;
  });
  await inserted.promise;
  const loser=fx.transaction(()=>insertMultiRun(fx,b)).then(value=>({value}),error=>({error}));
  await until(async()=>(await db.query('SELECT count(*)::int n FROM pg_locks WHERE NOT granted')).rows[0].n>0,'the second admission to wait on the first');
  release.open();
  const won=await winner,lost=await loser;
  assert.equal(won.ok,true);
  assert.ok(lost.error,'the loser threw: '+JSON.stringify(lost.value));
  assert.ok(lost.error.code===SERIALIZATION||(lost.error.code===UNIQUE_VIOLATION&&lost.error.constraint==='mp_research_runs_idempotency_key'),lost.error.code+' '+lost.error.constraint);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_research_runs WHERE idempotency_key=$1',[a.idempotency_key])).rows[0].n,1);
  const retried=await fx.transaction(()=>insertMultiRun(fx,b));
  assert.deepEqual([retried.ok,retried.action,retried.run.run_id],[true,'LOAD',won.run.run_id]);
});

test('insertMultiRun: no retry of its own on any failure; 40001, 40P01 and an unknown database error are rethrown unchanged after exactly the statements run so far',async()=>{
  const {set}=await committedSet(),input=inputOf(set);
  for(const code of ['40001','40P01','XX000','42501']) {
    let queries=0;
    const failing={isTransaction:true,query:async()=>{queries+=1;throw Object.assign(new Error('boom '+code),{code});}};
    const error=await insertMultiRun(failing,input).then(()=>null,failure=>failure);
    assert.equal(error?.code,code);assert.equal(queries,1,code+': the first statement failed and nothing was retried');
  }
  // an unmapped QR004 (not a guard of this store) is a defect and rethrown
  const stray={isTransaction:true,query:async()=>{throw Object.assign(new Error('stray'),{code:'QR004',constraint:'some_other_guard'});}};
  await assert.rejects(insertMultiRun(stray,input),{code:'QR004'});
});

/* ---- 6. readFresh ---- */

test('insertMultiRun: readFresh runs after the locks inside the transaction; its refusal (a code of the contract) is returned with the transaction still usable; a bad return is MP_INPUT_INVALID readFresh',async()=>{
  const {set}=await committedSet();
  const before=await allDigests(db);
  const seen=[];
  await fx.transaction(async()=>{
    const stale=await insertMultiRun(fx,inputOf(set,{readFresh:async()=>{seen.push('called');return {ok:false,code:MP_CODES.MEMBER_SET_STALE,diagnostic:{stage:'fresh',field:'funding_cutoff'}};}}));
    assert.deepEqual(stale,{ok:false,code:MP_CODES.MEMBER_SET_STALE,diagnostic:{stage:'fresh',field:'funding_cutoff'}});
    assert.equal((await fx.query('SELECT 1 AS one')).rows[0].one,1,'the refusal came before the write: the transaction is usable');
    for(const [label,value] of [['no object',null],['ok missing',{}],['ok false without a code',{ok:false}],['unknown code',{ok:false,code:'SOMETHING_ELSE'}],['ok not boolean',{ok:'yes'}]]) {
      const out=await insertMultiRun(fx,inputOf(set,{readFresh:async()=>value}));
      assert.deepEqual([out.ok,out.code,out.diagnostic.field],[false,MP_CODES.INPUT_INVALID,'readFresh'],label);
    }
    throw new Rollback();
  }).catch(error=>{if(!(error instanceof Rollback))throw error;});
  assert.deepEqual(seen,['called']);
  assert.deepEqual(await allDigests(db),before,'no refusal wrote anything');
  const order=[];
  const ok=await fx.transaction(()=>insertMultiRun(fx,inputOf(set,{readFresh:async()=>{
    order.push((await fx.query('SELECT count(*)::int n FROM public.mp_research_runs WHERE member_set_id=$1',[set.member_set_id])).rows[0].n);
    return {ok:true};
  }})));
  assert.deepEqual([ok.ok,ok.action,order],[true,'ADMIT',[0]],'readFresh ran before the insert');
  await assert.rejects(fx.transaction(()=>insertMultiRun(fx,inputOf(set,{readFresh:async()=>{throw Error('reader defect');}}))),/reader defect/);
});

/* ---- 7. appendRunEvent (W3) ---- */

test('appendRunEvent: ADMITTED to RUNNING to SUCCEEDED; seq follows the last event; at_ms is the database clock and strictly increases; the result hash is computed here; the readers return it',async()=>{
  const {set}=await committedSet(),admitted=await admitRun(set);
  const clock=await dbClockMs(db);
  const running=await append(admitted,'RUNNING');
  assert.equal(running.ok,true,JSON.stringify(running));
  assert.deepEqual([running.event.run_id,running.event.seq,running.event.status,running.event.reason_code,running.event.result_hash,running.terminal],[admitted.run_id,2,'RUNNING',null,null,false]);
  assert.ok(running.event.at_ms>=clock,'database clock');
  const result=resultFor(admitted,{extra:{nested:[1,2,{z:null}]}});
  const done=await append(admitted,'SUCCEEDED',{result});
  assert.equal(done.ok,true,JSON.stringify(done));
  assert.deepEqual([done.event.seq,done.event.status,done.terminal,done.event.result_hash],[3,'SUCCEEDED',true,hash(canonical(result))]);
  assert.ok(done.event.at_ms>running.event.at_ms,'strictly increasing');
  const read=await getMultiRun(fx,ownerOf(admitted));
  assert.equal(read.ok,true,JSON.stringify(read));
  assert.deepEqual(read.events.map(event=>[event.seq,event.status]),[[1,'ADMITTED'],[2,'RUNNING'],[3,'SUCCEEDED']]);
  assert.deepEqual([read.status,read.terminal],['SUCCEEDED',true]);
  assert.equal(canonical(read.events[2].result),canonical(result));assert.equal(read.events[2].result_hash,hash(canonical(result)));
  assert.ok(read.events[0].at_ms<read.events[1].at_ms&&read.events[1].at_ms<read.events[2].at_ms);
  assert.equal((await getMultiRun(fx,ownerOf(admitted))).owner_recommendation_ready,false);
  // the writer's own result_hash cannot be supplied: the key is not accepted
  assert.equal((await append(admitted,'FAILED',{result_hash:'a'.repeat(64),reason_code:'X_FIXTURE'})).diagnostic.field,'input.result_hash');
});

test('appendRunEvent: every edge of the status graph; a disallowed edge and any event after a terminal event are run.transition; nothing is written by a refusal',async()=>{
  const {set}=await committedSet();
  const FROM_ADMITTED=['RUNNING','FAILED','CANCELLED','TIMED_OUT'],FROM_RUNNING=['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT'];
  for(const status of FROM_ADMITTED) {
    const admitted=await runAt(set,'ADMITTED'),out=await append(admitted,status,fieldsFor(admitted,status));
    assert.deepEqual([status,out.ok,out.event?.seq,out.terminal],[status,true,2,RUN_STORE_TERMINAL.includes(status)],JSON.stringify(out));
  }
  for(const status of FROM_RUNNING) {
    const admitted=await runAt(set,'RUNNING'),out=await append(admitted,status,fieldsFor(admitted,status));
    assert.deepEqual([status,out.ok,out.event?.seq,out.terminal],[status,true,3,true],JSON.stringify(out));
  }
  const refusedEdges=[['ADMITTED',['ADMITTED','SUCCEEDED','NO_VALID_CANDIDATE']],['RUNNING',['ADMITTED','RUNNING']],
    ...RUN_STORE_TERMINAL.map(terminal=>[terminal,RUN_STORE_STATUSES])];
  for(const [from,targets] of refusedEdges) {
    const admitted=await runAt(set,from),before=await eventCount(admitted.run_id);
    for(const status of targets) {
      const out=await append(admitted,status,fieldsFor(admitted,status));
      assert.deepEqual([from,status,out.ok,out.code,out.diagnostic?.field,out.diagnostic?.guard],[from,status,false,MP_CODES.INPUT_INVALID,'run.transition',RUN_STORE_GUARD.TRANSITION],JSON.stringify(out));
    }
    assert.equal(await eventCount(admitted.run_id),before,from+': a refusal appended nothing');
    assert.equal((await getMultiRun(fx,ownerOf(admitted))).status,from);
  }
});

test('appendRunEvent: the result guard maps to run.result (presence rules and the tie of a result to its run)',async()=>{
  const {set}=await committedSet();
  const cases=[
    ['FAILED without a reason_code','ADMITTED','FAILED',()=>({})],
    ['FAILED with a result','ADMITTED','FAILED',a=>({reason_code:'X_FAIL',result:resultFor(a)})],
    ['CANCELLED without a reason_code','RUNNING','CANCELLED',()=>({})],
    ['TIMED_OUT with a result','RUNNING','TIMED_OUT',a=>({reason_code:'X_FAIL',result:resultFor(a)})],
    ['SUCCEEDED without a result','RUNNING','SUCCEEDED',()=>({})],
    ['NO_VALID_CANDIDATE without a result','RUNNING','NO_VALID_CANDIDATE',()=>({})],
    ['SUCCEEDED with a reason_code','RUNNING','SUCCEEDED',a=>({reason_code:'X_FAIL',result:resultFor(a)})],
    ['RUNNING with a reason_code','ADMITTED','RUNNING',()=>({reason_code:'X_FAIL'})],
    ['RUNNING with a result','ADMITTED','RUNNING',a=>({result:resultFor(a)})],
    ['result of another run','RUNNING','SUCCEEDED',a=>({result:resultFor(a,{run_id:randomUUID()})})],
    ['result of another contract','RUNNING','SUCCEEDED',a=>({result:resultFor(a,{contract_hash:'9'.repeat(64)})})],
    ['owner_recommendation_ready true','RUNNING','SUCCEEDED',a=>({result:resultFor(a,{owner_recommendation_ready:true})})],
    ['owner_recommendation_ready absent','RUNNING','SUCCEEDED',a=>({result:(({owner_recommendation_ready,...rest})=>rest)(resultFor(a))})],
    ['no blocker in the result','RUNNING','NO_VALID_CANDIDATE',a=>({result:resultFor(a,{acceptance_blockers:['SOMETHING_ELSE']})})],
    ['blockers not an array','RUNNING','SUCCEEDED',a=>({result:resultFor(a,{acceptance_blockers:'MULTI_PINE_REQUIRES_APP_3B'})})]];
  for(const [label,from,status,extra] of cases) {
    const admitted=await runAt(set,from),before=await eventCount(admitted.run_id);
    const out=await append(admitted,status,extra(admitted));
    assert.deepEqual([out.ok,out.code,out.diagnostic?.field,out.diagnostic?.guard],[false,MP_CODES.INPUT_INVALID,'run.result',RUN_STORE_GUARD.RESULT],label+': '+JSON.stringify(out));
    assert.equal(await eventCount(admitted.run_id),before,label);
  }
});

test('appendRunEvent: input and owner scoping; another owner, an unknown or a malformed run answer NOT_FOUND and write nothing; the call refuses to run inside a transaction',async()=>{
  const {set}=await committedSet(),other=await committedSet();
  const admitted=await admitRun(set),before=await allDigests(db);
  const notFound={ok:false,code:'NOT_FOUND',diagnostic:{stage:'store'}};
  assert.deepEqual(await appendRunEvent(fx,{owner_id:other.set.owner_id,run_id:admitted.run_id,status:'RUNNING'}),notFound,'another owner');
  assert.deepEqual(await appendRunEvent(fx,{owner_id:set.owner_id,run_id:randomUUID(),status:'RUNNING'}),notFound,'unknown run');
  assert.deepEqual(await appendRunEvent(fx,{owner_id:set.owner_id,run_id:'not-a-uuid',status:'RUNNING'}),notFound,'malformed run id');
  assert.deepEqual(await appendRunEvent(fx,{owner_id:'',run_id:admitted.run_id,status:'RUNNING'}),notFound,'empty owner');
  assert.deepEqual(await appendRunEvent(fx,{owner_id:set.owner_id,run_id:admitted.run_id.toUpperCase(),status:'RUNNING'}),notFound,'upper-case run id');
  const field=async(input)=>(await appendRunEvent(fx,input)).diagnostic?.field;
  const base={owner_id:set.owner_id,run_id:admitted.run_id,status:'RUNNING'};
  assert.equal(await field(null),'input');assert.equal(await field([]),'input');
  assert.equal(await field({...base,extra:1}),'input.extra');assert.equal(await field({...base,at_ms:5}),'input.at_ms');assert.equal(await field({...base,seq:5}),'input.seq');
  assert.equal(await field({...base,status:'QUEUED'}),'status');assert.equal(await field({...base,status:undefined}),'status');assert.equal(await field({...base,status:'running'}),'status');
  for(const reason of ['lower','1BAD','A','X'.repeat(65),7,{},'X Y'])assert.equal(await field({...base,reason_code:reason}),'reason_code',String(reason));
  for(const value of [[],'text',5,true,{a:undefined},{a:Number.NaN},{a:Infinity},{get a(){return 1;}},Object.create({inherited:1}),new Map(),
    // P7: JSONB cannot hold U+0000 (22P05): refused here, in a string value at any depth and in a key
    {a:'x\u0000y'},{a:{b:['ok','\u0000']}},{['k\u0000']:1}])assert.equal(await field({...base,result:value}),'result',String(Object.keys(value)));
  assert.equal((await appendRunEvent(fx,{...base,status:'FAILED',reason_code:'X_FIXTURE',result:{a:'tab\tnewline\n'}})).diagnostic?.field,'run.result','a string with control characters other than U+0000 passes the input check (the result guard refuses a FAILED result)');
  assert.equal((await appendRunEvent(fx,{...base,reason_code:null,result:null})).ok,true,'explicit nulls are the same as absent');
  assert.deepEqual((await db.query('SELECT status FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq',[admitted.run_id])).rows.map(row=>row.status),['ADMITTED','RUNNING']);
  // never inside a transaction: the writer opens its own
  const inside=await fx.transaction(()=>appendRunEvent(fx,{...base,status:'FAILED',reason_code:'X_FIXTURE'}));
  assert.deepEqual(inside,{ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage:'store',field:'db.transaction'}});
  assert.equal((await getMultiRun(fx,ownerOf(admitted))).status,'RUNNING');
  assert.notDeepEqual(await allDigests(db),before);
});

test('appendRunEvent: two concurrent appends of the same event end with exactly one event; the loser retries and is refused by the transition guard',async()=>{
  const {set}=await committedSet(),admitted=await admitRun(set);
  const outs=await Promise.all([append(admitted,'RUNNING'),append(admitted,'RUNNING')]);
  assert.deepEqual(outs.map(out=>out.ok).sort(),[false,true],JSON.stringify(outs));
  const lost=outs.find(out=>!out.ok);
  assert.deepEqual([lost.code,lost.diagnostic.field,lost.diagnostic.guard],[MP_CODES.INPUT_INVALID,'run.transition',RUN_STORE_GUARD.TRANSITION]);
  assert.equal(await eventCount(admitted.run_id),2);
  // two different terminal events: one wins, the other is refused after the retry saw the terminal event
  const second=await runAt(set,'RUNNING');
  const finals=await Promise.all([append(second,'FAILED',{reason_code:'X_ONE'}),append(second,'CANCELLED',{reason_code:'X_TWO'})]);
  assert.deepEqual(finals.map(out=>out.ok).sort(),[false,true],JSON.stringify(finals));
  assert.equal(await eventCount(second.run_id),3);
});

test('appendRunEvent: the retry bound; 40001, 40P01 and a duplicate seq are retried three times and then rethrown; the order guard is not retried and maps at once to run.order (P3); an unmapped error is rethrown at once',async()=>{
  const {set}=await committedSet(),admitted=await admitRun(set);
  const stub=(raise)=>{const state={calls:0};return Object.assign(state,{isTransaction:false,query:async()=>({rows:[]}),transaction:async()=>{state.calls+=1;throw raise();}});};
  const input={owner_id:set.owner_id,run_id:admitted.run_id,status:'RUNNING'};
  const fail=(code,constraint)=>()=>Object.assign(new Error('x '+code),{code,constraint});
  for(const [label,raise] of [['serialization',fail('40001')],['deadlock',fail('40P01')],['duplicate seq',fail('23505','mp_research_run_events_pkey')]]) {
    const db2=stub(raise);
    const error=await appendRunEvent(db2,input).then(()=>null,failure=>failure);
    assert.equal(error?.code,raise().code,label);assert.equal(db2.calls,RUN_STORE_MAX_RETRIES+1,label+': one attempt plus three retries');
  }
  const order=stub(fail('QR004',RUN_STORE_GUARD.ORDER));
  const out=await appendRunEvent(order,input);
  assert.deepEqual([out.ok,out.diagnostic.field,out.diagnostic.guard,order.calls],[false,'run.order',RUN_STORE_GUARD.ORDER,1]);
  for(const [label,raise] of [['unknown QR004',fail('QR004','other_guard')],['no privilege',fail('42501')],['other',fail('XX000')],['unique key of runs',fail('23505','mp_research_runs_idempotency_key')]]) {
    const db2=stub(raise);
    const error=await appendRunEvent(db2,input).then(()=>null,failure=>failure);
    assert.equal(error?.code,raise().code,label);
    // the idempotency key violation is not a lost event race: it is rethrown; the others stop at once as well
    assert.equal(db2.calls,1,label);
  }
  // a retry that succeeds on the third attempt
  let calls=0;
  const flaky={isTransaction:false,query:async()=>({rows:[]}),transaction:async(fn,options)=>{calls+=1;if(calls<3)throw Object.assign(new Error('x'),{code:'40001'});return fx.transaction(fn,options);}};
  const ok=await appendRunEvent({...flaky,query:fx.query.bind(fx)},input);
  assert.deepEqual([ok.ok,calls],[true,3]);
});

/* ---- 8. readers (W4) ---- */

test('getMultiRun: the owner reads the run with its events; another owner, an unknown or a malformed id answer NOT_FOUND; a foreign Bot filter is not a path',async()=>{
  const {set}=await committedSet(),other=await committedSet();
  const admitted=await runAt(set,'SUCCEEDED');
  const read=await getMultiRun(fx,ownerOf(admitted));
  assert.equal(read.ok,true,JSON.stringify(read));
  assert.deepEqual(Object.keys(read).sort(),['acceptance_blockers','events','ok','owner_recommendation_ready','run','status','terminal']);
  assert.deepEqual(Object.keys(read.run).sort(),['bot_id','contract','contract_hash','contract_version','created_at_ms','dataset_content_digest','deadline_ms','engine_hash','fixture','idempotency_key','member_set_id',
    'membership_hash','owner_id','pine_count','run_id','set_hash','submission_hash']);
  assert.deepEqual([read.run.run_id,read.run.owner_id,read.run.bot_id,read.run.member_set_id,read.run.set_hash,read.run.pine_count,read.run.fixture],
    [admitted.run_id,set.owner_id,set.bot_id,set.member_set_id,set.set_hash,2,true]);
  assert.deepEqual(read.events.map(event=>Object.keys(event).join()),Array(3).fill('seq,status,at_ms,reason_code,result,result_hash'));
  assert.deepEqual([read.status,read.terminal,read.owner_recommendation_ready],['SUCCEEDED',true,false]);
  const notFound={ok:false,code:'NOT_FOUND',diagnostic:{stage:'store'}};
  assert.deepEqual(await getMultiRun(fx,{owner_id:other.set.owner_id,run_id:admitted.run_id}),notFound);
  assert.deepEqual(await getMultiRun(fx,{owner_id:set.owner_id,run_id:randomUUID()}),notFound);
  assert.deepEqual(await getMultiRun(fx,{owner_id:set.owner_id,run_id:'x'}),notFound);
  assert.deepEqual(await getMultiRun(fx,{owner_id:7,run_id:admitted.run_id}),notFound);
  assert.equal((await getMultiRun(fx,{owner_id:set.owner_id,run_id:admitted.run_id,bot_id:set.bot_id})).diagnostic.field,'input');
  assert.equal((await getMultiRun(fx,null)).diagnostic.field,'input');
});

test('findMultiRunByKey: found, not found, owner and Bot scoped, input checked',async()=>{
  const {set}=await committedSet(),other=await committedSet();
  const admitted=await admitRun(set);
  const key={owner_id:set.owner_id,bot_id:set.bot_id,idempotency_key:admitted.input.idempotency_key};
  const found=await findMultiRunByKey(fx,key);
  assert.deepEqual([found.ok,found.found,found.run.run_id,found.status,found.events.length],[true,true,admitted.run_id,'ADMITTED',1]);
  assert.deepEqual(await findMultiRunByKey(fx,{...key,idempotency_key:keyOf()}),{ok:true,found:false});
  assert.deepEqual(await findMultiRunByKey(fx,{...key,owner_id:other.set.owner_id}),{ok:true,found:false});
  assert.deepEqual(await findMultiRunByKey(fx,{...key,bot_id:other.set.bot_id}),{ok:true,found:false});
  for(const [label,input,field] of [['no input',null,'input'],['extra key',{...key,x:1},'input'],['owner',{...key,owner_id:''},'owner_id'],['bot',{...key,bot_id:3},'bot_id'],
    ['key',{...key,idempotency_key:'short'},'idempotency_key']])
    assert.deepEqual([label,(await findMultiRunByKey(fx,input)).diagnostic?.field],[label,field]);
});

test('listMultiRuns: owner scoped, newest first, bounded; keyset cursor (before_ms + before_run_id) never drops runs tied on created_at_ms; the Bot filter; input checked',async()=>{
  const {set}=await committedSet(),other=await committedSet();
  const times=[T0MS+1000,T0MS+3000,T0MS+2000];
  const made=[];
  for(const created of times)made.push(await admitRun(set,{created_at_ms:created,deadline_ms:created+600000}));
  const tied=await admitRun(set,{created_at_ms:T0MS+3000,deadline_ms:T0MS+3000+600000});
  const foreign=await admitRun(other.set);
  const all=await listMultiRuns(fx,{owner_id:set.owner_id});
  assert.equal(all.ok,true,JSON.stringify(all));
  const expected=[made[1],tied].sort((a,b)=>a.run_id<b.run_id?-1:1).map(item=>item.run_id).concat([made[2].run_id,made[0].run_id]);
  assert.deepEqual(all.runs.map(view=>view.run.run_id),expected,'created_at_ms descending, ties by run_id');
  assert.ok(all.runs.every(view=>view.run.owner_id===set.owner_id&&view.events.length===1&&view.status==='ADMITTED'&&view.owner_recommendation_ready===false));
  assert.ok(!all.runs.some(view=>view.run.run_id===foreign.run_id));
  assert.equal(all.next,null,'everything fit: no cursor');
  assert.deepEqual(Object.keys(all).sort(),['next','ok','runs']);
  const two=await listMultiRuns(fx,{owner_id:set.owner_id,limit:2});
  assert.deepEqual(two.runs.map(view=>view.run.run_id),expected.slice(0,2));
  assert.deepEqual(two.next,{before_ms:T0MS+3000,before_run_id:expected[1]},'limit 2 of 4: the cursor is the last returned run');
  assert.equal((await listMultiRuns(fx,{owner_id:set.owner_id,limit:4})).next,null,'exactly limit rows left: no cursor');
  assert.notEqual((await listMultiRuns(fx,{owner_id:set.owner_id,limit:3})).next,null);
  // P1: two runs tie at T0MS+3000; with limit 1 the second one must come on the next page, never dropped at the page boundary
  const walked=[];
  let cursor={},pages=0;
  do {
    const page=await listMultiRuns(fx,{owner_id:set.owner_id,limit:1,...cursor});
    assert.equal(page.ok,true,JSON.stringify(page));assert.equal(page.runs.length,1);
    walked.push(page.runs[0].run.run_id);pages+=1;
    cursor=page.next??null;
    if(cursor!==null)assert.deepEqual(Object.keys(cursor),['before_ms','before_run_id']);
  } while(cursor!==null&&pages<10);
  assert.deepEqual([walked,pages],[expected,4],'limit 1 walks all four runs in order, the tied pair included');
  assert.equal(new Set(walked.slice(0,2).map(id=>all.runs.find(view=>view.run.run_id===id).run.created_at_ms)).size,1,'the first two pages are the tied runs');
  const ZERO='00000000-0000-0000-0000-000000000000',TOP='ffffffff-ffff-ffff-ffff-ffffffffffff';
  assert.deepEqual((await listMultiRuns(fx,{owner_id:set.owner_id,before_ms:T0MS+3000,before_run_id:TOP})).runs.map(view=>view.run.run_id),[made[2].run_id,made[0].run_id],'after the last tied run');
  assert.deepEqual((await listMultiRuns(fx,{owner_id:set.owner_id,before_ms:T0MS+3000,before_run_id:ZERO})).runs.map(view=>view.run.run_id),expected,'the tied runs come after a cursor that sorts before them');
  assert.deepEqual((await listMultiRuns(fx,{owner_id:set.owner_id,before_ms:T0MS+1000,before_run_id:TOP})).runs,[]);
  assert.deepEqual((await listMultiRuns(fx,{owner_id:set.owner_id,before_ms:T0MS+1000,before_run_id:ZERO})).runs.map(view=>view.run.run_id),[made[0].run_id],'a run tied with the cursor time and after its id');
  assert.deepEqual((await listMultiRuns(fx,{owner_id:set.owner_id,bot_id:set.bot_id})).runs.length,4);
  assert.deepEqual((await listMultiRuns(fx,{owner_id:set.owner_id,bot_id:'someone-else'})).runs,[]);
  assert.deepEqual((await listMultiRuns(fx,{owner_id:'nobody'})).runs,[]);
  assert.equal((await listMultiRuns(fx,{owner_id:other.set.owner_id})).runs.length,1);
  for(const [label,input,field] of [['null',null,'input'],['extra',{owner_id:set.owner_id,x:1},'input'],['owner',{owner_id:''},'owner_id'],['bot',{owner_id:'a',bot_id:''},'bot_id'],
    ['before float',{owner_id:'a',before_ms:1.5},'before_ms'],['before zero',{owner_id:'a',before_ms:0},'before_ms'],['limit zero',{owner_id:'a',limit:0},'limit'],
    ['before_ms alone',{owner_id:'a',before_ms:5},'before_run_id'],['before_run_id alone',{owner_id:'a',before_run_id:randomUUID()},'before_ms'],
    ['before_run_id malformed',{owner_id:'a',before_ms:5,before_run_id:'x'},'before_run_id'],['before_run_id upper case',{owner_id:'a',before_ms:5,before_run_id:randomUUID().toUpperCase()},'before_run_id'],
    ['before_run_id not a string',{owner_id:'a',before_ms:5,before_run_id:7},'before_run_id'],
    ['limit above the bound',{owner_id:'a',limit:RUN_LIST_MAX_LIMIT+1},'limit'],['limit float',{owner_id:'a',limit:1.5},'limit']])
    assert.deepEqual([label,(await listMultiRuns(fx,input)).diagnostic?.field],[label,field]);
  assert.equal((await listMultiRuns(fx,{owner_id:set.owner_id,limit:RUN_LIST_MAX_LIMIT})).ok,true,'the bound itself is allowed');
});

/* ---- 9. reader integrity refusals: a tampered row is refused, never returned (W4) ---- */

test('readers: a tampered run row is refused with a storage integrity refusal naming the check (planted by the owner role in a rolled-back transaction)',async()=>{
  const {set}=await committedSet(),admitted=await runAt(set,'SUCCEEDED');
  const get=target=>getMultiRun(target,ownerOf(admitted));
  assert.equal((await get(fx)).ok,true);
  const bad=newContract=>[NO_RUN_TRIGGER,['UPDATE public.mp_research_runs SET contract=$2::jsonb,contract_hash=$3 WHERE run_id=$1',[admitted.run_id,JSON.stringify(newContract),hash(canonical(newContract))]]];
  const edit=change=>{const contract=structuredClone(admitted.input.contract);change(contract);return contract;};
  const dropRun=name=>'ALTER TABLE public.mp_research_runs DROP CONSTRAINT '+name,dropSet=name=>'ALTER TABLE public.mp_member_sets DROP CONSTRAINT '+name;
  const REPLICA="SET LOCAL session_replication_role = 'replica'";
  const NO_TIES=dropRun('mp_research_runs_contract_ties_check');
  const cases=[
    ['contract edited, hash kept',[NO_RUN_TRIGGER,["UPDATE public.mp_research_runs SET contract=jsonb_set(contract,'{seed}','43'::jsonb) WHERE run_id=$1",[admitted.run_id]]],'contract_hash'],
    ['contract hash column changed',[NO_RUN_TRIGGER,['UPDATE public.mp_research_runs SET contract_hash=$2 WHERE run_id=$1',[admitted.run_id,'1'.repeat(64)]]],'contract_hash'],
    ['contract no longer a valid contract (hash recomputed)',bad(edit(c=>{c.budget.candidates=0;})),'contract'],
    ['column engine_hash differs from the contract',[NO_RUN_TRIGGER,NO_TIES,['UPDATE public.mp_research_runs SET engine_hash=$2 WHERE run_id=$1',[admitted.run_id,'2'.repeat(64)]]],'columns.engine_hash'],
    ['column dataset digest differs from the contract',[NO_RUN_TRIGGER,NO_TIES,['UPDATE public.mp_research_runs SET dataset_content_digest=$2 WHERE run_id=$1',[admitted.run_id,'3'.repeat(64)]]],'columns.dataset_content_digest'],
    ['contract policy_hash differs from the member set (hash recomputed)',bad(edit(c=>{c.policy_hash='4'.repeat(64);})),'member_set.policy_hash'],
    ['contract funding_cutoff differs from the member set (hash recomputed)',bad(edit(c=>{c.funding_cutoff+=1;})),'member_set.funding_cutoff'],
    ['contract model differs from the frozen execution model (hash recomputed)',bad(edit(c=>{c.model.fee_bps=5;})),'member_set.execution_model_hash'],
    ['member set record edited',[NO_SET_TRIGGER,["UPDATE public.mp_member_sets SET record=jsonb_set(record,'{members,0,evidence_hash}',to_jsonb($2::text)) WHERE member_set_id=$1",[set.member_set_id,'5'.repeat(64)]]],'member_set.record'],
    ['deadline outside the window',[NO_RUN_TRIGGER,'ALTER TABLE public.mp_research_runs DROP CONSTRAINT mp_research_runs_deadline_ms_check',['UPDATE public.mp_research_runs SET deadline_ms=created_at_ms+5 WHERE run_id=$1',[admitted.run_id]]],'deadline_ms'],
    ['events removed',[NO_EVENT_TRIGGER,['DELETE FROM public.mp_research_run_events WHERE run_id=$1',[admitted.run_id]]],'events'],
    ['event 2 removed (a seq gap)',[NO_EVENT_TRIGGER,['DELETE FROM public.mp_research_run_events WHERE run_id=$1 AND seq=2',[admitted.run_id]]],'events.seq'],
    ['event 3 reason added',[NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET reason_code=$2 WHERE run_id=$1 AND seq=3',[admitted.run_id,'X_FIXTURE']]],'events.result'],
    ['event 3 result changed, hash kept',[NO_EVENT_TRIGGER,["UPDATE public.mp_research_run_events SET result=jsonb_set(result,'{extra}','1') WHERE run_id=$1 AND seq=3",[admitted.run_id]]],'events.result_hash'],
    ['event 3 result hash changed',[NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET result_hash=$2 WHERE run_id=$1 AND seq=3',[admitted.run_id,'6'.repeat(64)]]],'events.result_hash'],
    ['event 2 reason added',[NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET reason_code=$2 WHERE run_id=$1 AND seq=2',[admitted.run_id,'X_FIXTURE']]],'events.open'],
    ['event 2 time not after event 1',[NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET at_ms=(SELECT at_ms FROM public.mp_research_run_events WHERE run_id=$1 AND seq=1) WHERE run_id=$1 AND seq=2',[admitted.run_id]]],'events.at_ms'],
    ['event 2 status changed to ADMITTED',[NO_EVENT_TRIGGER,["UPDATE public.mp_research_run_events SET status='ADMITTED' WHERE run_id=$1 AND seq=2",[admitted.run_id]]],'events.transition'],
    ['event 1 status changed to RUNNING',[NO_EVENT_TRIGGER,["UPDATE public.mp_research_run_events SET status='RUNNING' WHERE run_id=$1 AND seq=1",[admitted.run_id]]],'events.transition'],
    // P4: row shape checks (each column CHECK is dropped in the rolled-back transaction, so the reader is the only defence)
    ['row fixture false',[NO_RUN_TRIGGER,dropRun('mp_research_runs_fixture_check'),['UPDATE public.mp_research_runs SET fixture=false WHERE run_id=$1',[admitted.run_id]]],'fixture'],
    ['row idempotency key malformed',[NO_RUN_TRIGGER,dropRun('mp_research_runs_idempotency_key_check'),["UPDATE public.mp_research_runs SET idempotency_key='bad key bad key' WHERE run_id=$1",[admitted.run_id]]],'idempotency_key'],
    ['row submission hash malformed',[NO_RUN_TRIGGER,dropRun('mp_research_runs_submission_hash_check'),["UPDATE public.mp_research_runs SET submission_hash='zz' WHERE run_id=$1",[admitted.run_id]]],'submission_hash'],
    // P4: every tied column against the contract (the contract-ties CHECK is dropped too)
    ['column contract_version differs',[NO_RUN_TRIGGER,NO_TIES,dropRun('mp_research_runs_contract_version_check'),["UPDATE public.mp_research_runs SET contract_version='other-version-v1' WHERE run_id=$1",[admitted.run_id]]],'columns.version'],
    ['contract owner_id differs from the column (hash recomputed)',[NO_TIES,...bad(edit(c=>{c.owner_id='someone-else';}))],'columns.owner_id'],
    ['contract bot_id differs from the column (hash recomputed)',[NO_TIES,...bad(edit(c=>{c.bot_id='someone-else';}))],'columns.bot_id'],
    ['contract member_set_id differs from the column (hash recomputed)',[NO_TIES,...bad(edit(c=>{c.member_set_id=randomUUID();}))],'columns.member_set_id'],
    ['contract set_hash differs from the column (hash recomputed)',[NO_TIES,...bad(edit(c=>{c.set_hash='8'.repeat(64);}))],'columns.set_hash'],
    ['column membership_hash differs from the contract',[NO_RUN_TRIGGER,NO_TIES,['UPDATE public.mp_research_runs SET membership_hash=$2 WHERE run_id=$1',[admitted.run_id,'9'.repeat(64)]]],'columns.membership_hash'],
    ['column pine_count differs from the contract',[NO_RUN_TRIGGER,NO_TIES,['UPDATE public.mp_research_runs SET pine_count=3 WHERE run_id=$1',[admitted.run_id]]],'columns.pine_count'],
    // P4: the member set row against its record and the contract (owner schema role, FK triggers skipped by replica role inside the rolled-back transaction)
    ['member set fixture column false',[NO_SET_TRIGGER,dropSet('mp_member_sets_fixture_check'),dropSet('mp_member_sets_record_ties_check'),['UPDATE public.mp_member_sets SET fixture=false WHERE member_set_id=$1',[set.member_set_id]]],'member_set.fixture'],
    ['member set owner column differs from its record',[NO_SET_TRIGGER,REPLICA,dropSet('mp_member_sets_record_ties_check'),["UPDATE public.mp_member_sets SET owner_id='someone-else' WHERE member_set_id=$1",[set.member_set_id]]],'member_set.owner_id'],
    ['member set bot column differs from its record',[NO_SET_TRIGGER,REPLICA,dropSet('mp_member_sets_record_ties_check'),["UPDATE public.mp_member_sets SET bot_id='someone-else' WHERE member_set_id=$1",[set.member_set_id]]],'member_set.bot_id'],
    ['member set set_hash column differs from its record',[NO_SET_TRIGGER,REPLICA,dropSet('mp_member_sets_record_ties_check'),['UPDATE public.mp_member_sets SET set_hash=$2 WHERE member_set_id=$1',[set.member_set_id,'a'.repeat(64)]]],'member_set.set_hash'],
    // P4: events.status
    ['event 2 status not a known status',[NO_EVENT_TRIGGER,'ALTER TABLE public.mp_research_run_events DROP CONSTRAINT mp_research_run_events_status_check',["UPDATE public.mp_research_run_events SET status='QUEUED' WHERE run_id=$1 AND seq=2",[admitted.run_id]]],'events.status'],
    ['event 2 result added',[NO_EVENT_TRIGGER,["UPDATE public.mp_research_run_events SET result='{\"a\":1}'::jsonb WHERE run_id=$1 AND seq=2",[admitted.run_id]]],'events.open']];
  for(const [label,statements,field] of cases) {
    const out=await tampered(statements,get);
    assert.equal(out.ok,false,label+': '+JSON.stringify(out));
    assert.deepEqual([out.code,out.diagnostic.stage,out.diagnostic.field,out.diagnostic.run_id],[MP_CODES.INPUT_INVALID,'stored',field,admitted.run_id],label+': '+JSON.stringify(out.diagnostic));
  }
  assert.equal((await get(fx)).ok,true,'every tamper was rolled back');
  // P4: events.reason on a FAILED run (the failure reason is mandatory and shaped; a result or a hash is not allowed)
  const failed=await runAt(set,'FAILED');
  const getFailed=target=>getMultiRun(target,ownerOf(failed));
  assert.equal((await getFailed(fx)).ok,true);
  for(const [label,statements] of [
    ['FAILED reason removed',[NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET reason_code=NULL WHERE run_id=$1 AND seq=3',[failed.run_id]]]],
    ['FAILED reason malformed',[NO_EVENT_TRIGGER,'ALTER TABLE public.mp_research_run_events DROP CONSTRAINT mp_research_run_events_reason_code_check',["UPDATE public.mp_research_run_events SET reason_code='bad code' WHERE run_id=$1 AND seq=3",[failed.run_id]]]],
    ['FAILED carries a result',[NO_EVENT_TRIGGER,["UPDATE public.mp_research_run_events SET result='{\"a\":1}'::jsonb WHERE run_id=$1 AND seq=3",[failed.run_id]]]],
    ['FAILED carries a result hash',[NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET result_hash=$2 WHERE run_id=$1 AND seq=3',[failed.run_id,'8'.repeat(64)]]]]]) {
    const out=await tampered(statements,getFailed);
    assert.deepEqual([out.ok,out.diagnostic?.stage,out.diagnostic?.field,out.diagnostic?.run_id],[false,'stored','events.reason',failed.run_id],label+': '+JSON.stringify(out));
  }
  assert.equal((await getFailed(fx)).ok,true,'every tamper was rolled back');
});

test('readers: the result tie and a terminal event followed by another are refused; the other readers apply the same checks',async()=>{
  const {set}=await committedSet(),admitted=await runAt(set,'SUCCEEDED');
  const get=target=>getMultiRun(target,ownerOf(admitted));
  const rehash=(change)=>{
    const result=structuredClone(resultFor(admitted));change(result);
    return [NO_EVENT_TRIGGER,['UPDATE public.mp_research_run_events SET result=$2::jsonb,result_hash=$3 WHERE run_id=$1 AND seq=3',[admitted.run_id,JSON.stringify(result),hash(canonical(result))]]];
  };
  for(const [label,statements,field] of [
    ['result names another run',rehash(r=>{r.run_id=randomUUID();}),'events.result_tie'],
    ['result names another contract',rehash(r=>{r.contract_hash='7'.repeat(64);}),'events.result_tie'],
    ['result claims a recommendation',rehash(r=>{r.owner_recommendation_ready=true;}),'events.result_tie'],
    ['result without the blocker',rehash(r=>{r.acceptance_blockers=[];}),'events.result_tie'],
    ['an event after the terminal one',[NO_EVENT_TRIGGER,'ALTER TABLE public.mp_research_run_events DISABLE TRIGGER mp_research_run_events_transition','ALTER TABLE public.mp_research_run_events DISABLE TRIGGER mp_research_run_events_result',
      ["INSERT INTO public.mp_research_run_events(run_id,seq,status,at_ms,reason_code) VALUES($1,4,'FAILED',9999999999999,'X_LATE')",[admitted.run_id]]],'events.transition']]) {
    const out=await tampered(statements,get);
    assert.deepEqual([out.ok,out.diagnostic?.stage,out.diagnostic?.field],[false,'stored',field],label+': '+JSON.stringify(out));
  }
  // the same tamper through findMultiRunByKey and listMultiRuns (the list refuses as a whole and names the run)
  const tamper=[NO_RUN_TRIGGER,["UPDATE public.mp_research_runs SET contract=jsonb_set(contract,'{seed}','44'::jsonb) WHERE run_id=$1",[admitted.run_id]]];
  const key={owner_id:set.owner_id,bot_id:set.bot_id,idempotency_key:admitted.input.idempotency_key};
  const byKey=await tampered(tamper,target=>findMultiRunByKey(target,key));
  assert.deepEqual([byKey.ok,byKey.diagnostic.field,byKey.diagnostic.run_id],[false,'contract_hash',admitted.run_id]);
  const second=await admitRun(set);
  const listed=await tampered(tamper,target=>listMultiRuns(target,{owner_id:set.owner_id}));
  assert.deepEqual([listed.ok,listed.diagnostic.field,listed.diagnostic.run_id],[false,'contract_hash',admitted.run_id]);
  assert.equal((await listMultiRuns(fx,{owner_id:set.owner_id})).runs.length,2,'untampered, both read');
  assert.ok(second.run_id);
});

test('readers: a run whose member set row is gone is refused (member_set); the foreign key is skipped only by the schema owner under replica role, in a rolled-back transaction',async()=>{
  const {set}=await committedSet(),admitted=await runAt(set,'RUNNING');
  const get=target=>getMultiRun(target,ownerOf(admitted));
  const gone=await tampered([NO_SET_TRIGGER,"SET LOCAL session_replication_role = 'replica'",['DELETE FROM public.mp_member_sets WHERE member_set_id=$1',[set.member_set_id]]],get);
  assert.deepEqual([gone.ok,gone.diagnostic?.stage,gone.diagnostic?.field,gone.diagnostic?.run_id],[false,'stored','member_set',admitted.run_id],JSON.stringify(gone));
  assert.equal((await get(fx)).ok,true);
});

/* ---- 10. the runtime role holds nothing (W4, root decision S4) ---- */

test('the runtime role gets 42501 from every reader and every writer; nothing is returned or written',async()=>{
  const {set}=await committedSet(),admitted=await admitRun(set),before=await allDigests(db);
  const denied=promise=>assert.rejects(promise,{code:DENIED});
  await denied(getMultiRun(rt,ownerOf(admitted)));
  await denied(findMultiRunByKey(rt,{owner_id:set.owner_id,bot_id:set.bot_id,idempotency_key:admitted.input.idempotency_key}));
  await denied(listMultiRuns(rt,{owner_id:set.owner_id}));
  await denied(listMultiRuns(rt,{owner_id:set.owner_id,bot_id:set.bot_id,before_ms:T0MS+1,before_run_id:randomUUID(),limit:1}));
  await denied(rt.transaction(()=>insertMultiRun(rt,inputOf(set))));
  await denied(appendRunEvent(rt,{...ownerOf(admitted),status:'RUNNING'}));
  // the module does not mask it: the same calls succeed for the fixture role
  assert.equal((await getMultiRun(fx,ownerOf(admitted))).ok,true);
  assert.deepEqual(await allDigests(db),before);
  // and the runtime role still cannot read the tables directly
  for(const table of [...RUN_STORE_TABLES,MARKER_TABLE])await assert.rejects(rt.query('SELECT 1 FROM public.'+table+' LIMIT 1'),{code:DENIED},table);
});

test('the module reaches only the run-store tables and the member-set and Pine rows it needs',async()=>{
  // P6: comments stripped; names matched case-insensitively with ONLY, a public. prefix and double quotes; UPDATE with or without the schema prefix
  const code=stripComments(await sqlText('mp-run-store.js'));
  assert.deepEqual([...new Set(tableNames(code))].sort(),['mp_member_sets','mp_research_run_events','mp_research_runs','pine_deployments','pine_memberships']);
  assert.equal(writesOtherThanInsert(code),false,'the module has no UPDATE, DELETE or TRUNCATE statement');
  // the scanners themselves: each variant is seen
  assert.deepEqual(tableNames('SELECT 1 FROM ONLY "public"."Mp_Research_Runs" JOIN pine_Deployments d INSERT INTO PUBLIC.x_y(a)'),['mp_research_runs','pine_deployments','x_y']);
  assert.deepEqual(tableNames('select * from  only public.mp_member_sets'),['mp_member_sets']);
  for(const sample of ['update mp_research_runs SET a=1','UPDATE public.t SET a=1','UPDATE ONLY "public"."t" SET','Update  "t" SET','delete from t','DELETE   FROM t','truncate t'])
    assert.equal(writesOtherThanInsert(sample),true,sample);
  assert.equal(writesOtherThanInsert('SELECT 1 FROM t FOR SHARE'),false);
  assert.equal(stripComments('a // x\n/* b\nc */d\n// e\nf'),'a \nd\n\nf');
});
