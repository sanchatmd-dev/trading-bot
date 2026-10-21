import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {classifyMpMemberSet,migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {classifyMpRunStore,inspectMpRunStore,migrateMpRunStore,rollbackMpRunStore,RUN_STORE_TABLES} from '../../src/postgres/mp-run-store-migration.js';
import {PACKAGE_STORE_GUARDS,PACKAGE_STORE_MARKER,PACKAGE_STORE_TABLES,MARKER_TABLE,QR004_GUARDS,INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,
  classifyMpPackageStore,inspectMpPackageStore,migrateMpPackageStore,rollbackMpPackageStore} from '../../src/postgres/mp-package-store-migration.js';
import {classifyBestInputsPackage,inspectBestInputsPackage,migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {buildMemberSet} from '../../src/multi-pine/member-set.js';
import {buildMultiResearchContract} from '../../src/multi-pine/run-contract.js';
import {multiPackageFiles,multiPackageFileCount} from '../../src/multi-pine/package-render.js';
import {RETRYABLE_CODES,CANDIDATE_BLOCKERS} from '../../src/quant-library/package-gates.js';
import {RULES} from '../../src/quant-research/contract.js';

// F11-01 R6-3: the internal multi-Pine package store (RD-MP-36, RD-MP-37, RD-MP-41, RD-MP-39, RD-MP-42), proven on a throwaway PostgreSQL cluster as real non-owner LOGIN
// roles with the repo grant scripts: the runtime role (no privilege on the package store) and the fixture role (SELECT and INSERT). Every row is a LABELLED FIXTURE
// (fixture=true, synthetic, never a research result). Rows are insert-only: cases that commit use their own run and owner; guard negatives run in a transaction that is
// always rolled back, and write a complete export in that transaction first. There is no writer module, builder, service, route or worker in this slice: the cases write
// SQL directly.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501',CHECK_VIOLATION='23514',FK_VIOLATION='23503',UNIQUE_VIOLATION='23505',NOT_NULL='23502',DEPENDENT='2BP01';
const CLI='scripts/migrate-mp-package-store.mjs';
const GRANT_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const RUN_FIXTURE_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url));
const PACKAGE_FIXTURE_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-mp-package-fixture.sql',import.meta.url));
const T0=1790000000000,UTC='2026-10-20T10:00:00Z',T0MS=1790000000000;
const RECORD_TABLES=[...PACKAGE_STORE_TABLES],ALL_TABLES=[MARKER_TABLE,...PACKAGE_STORE_TABLES];
const G={exports:'mp_package_exports_guard',complete:'mp_package_exports_complete',files:'mp_package_files_guard',status:'mp_package_status_events_guard',attempts:'mp_package_attempts_guard',
  validations:'mp_package_validations_guard',compile:'mp_package_compile_records_guard',evidence:'mp_package_evidence_records_guard',clearances:'mp_package_clearances_guard',trace:'mp_package_trace_records_guard'};
let admin,db,rt,fx,dl,tr,connectionString,templateName,databaseName,runtimeName,fixtureName,deleterName,truncaterName,store;
const databases=[],pools=[],extraRoles=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every package-store writer is SERIALIZABLE (QR003 otherwise): the pools of the writers default to it for autocommit statements (a connection option) and their
// transactions default to it (ser). A case that proves a refusal opens its transaction at another level explicitly.
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let text=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))text=text.replaceAll(":'"+variable+"'","'"+value+"'");return text;};
const grantScript=role=>roleScript(GRANT_SCRIPT,{runtime_role:role});
const runFixtureScript=(runtime,fixture)=>roleScript(RUN_FIXTURE_SCRIPT,{runtime_role:runtime,fixture_role:fixture});
const packageFixtureScript=(runtime,fixture)=>roleScript(PACKAGE_FIXTURE_SCRIPT,{runtime_role:runtime,fixture_role:fixture});
const refused=(promise,code)=>assert.rejects(promise,{code});
const track=pool=>{pools.push(pool);return pool;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};

/** A database built from the template (base schema 14, Pine Bridge, quant research, member-set, run-store and Best Inputs package extensions; no package-store objects). */
async function clone(label){
  const name='robot_ps_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
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
const packageObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'mp\\_package\\_%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'mp\\_package\\_store\\_%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'mp\\_package\\_%') triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0};
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled,t.tgtype FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'mp\\_package\\_%' ORDER BY t.tgname`)).rows;
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const allDigests=async target=>Object.fromEntries(await Promise.all(ALL_TABLES.map(async table=>[table,await rowDigest(target,table)])));
const NOT_INSTALLED=/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/;
const sha=value=>createHash('sha256').update(value).digest('hex');

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
const resultOf=row=>({run_id:row.run_id,contract_hash:row.contract_hash,owner_recommendation_ready:false,acceptance_blockers:[...row.contract.acceptance_blockers],fixture:true,holdout_evaluated:true,completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'});
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

/* ---- package fixtures: a complete export of a finished run, and the record writers (all labelled fixture) ---- */

const TRACE_PATHS=['quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv'];
const EVIDENCE_KINDS=['dataset_alignment','native_parity','bridge_parity','repaint'];
const successFor=(row,mutate=null)=>{const result=resultOf(row);if(mutate)mutate(result);return {result,result_hash:hash(canonical(result))};};
/** A frozen set and a run of COUNT members, written by the fixture role. statuses is a path of PATH_TO; mutate edits the SUCCEEDED result before its hash is taken. */
async function newRun({count=2,path='SUCCEEDED',mutate=null}={}){
  const {set}=await committedSet({count});
  const row=makeRun(set);
  if(path==='SUCCEEDED'&&mutate){
    await fx.transaction(async()=>{
      await insertRun(fx,row);await insertEvent(fx,row,1,'ADMITTED');await insertEvent(fx,row,2,'RUNNING');await insertEvent(fx,row,3,'SUCCEEDED',successFor(row,mutate));
    },{isolation:'SERIALIZABLE'});
  }else await admit(fx,row,PATH_TO[path]);
  return row;
}
/** The files, blobs and rows of one export of RUN; over replaces columns of the export row, bindingOver columns of its binding. */
function buildExport(source,{pineCount=source.pine_count,export_id=randomUUID(),over={},bindingOver={}}={}){
  const files=multiPackageFiles(pineCount).map(path=>{const content=Buffer.from('fixture '+export_id+' '+path);return {path,content,sha256:sha(content),bytes:content.length};});
  const binding={owner_id:source.owner_id,bot_id:source.bot_id,run_id:source.run_id,mode:'MULTI_PINE',pine_count:pineCount,fixture:true,created_at:UTC,...bindingOver};
  const row={export_id,owner_id:source.owner_id,bot_id:source.bot_id,run_id:source.run_id,mode:'MULTI_PINE',pine_count:pineCount,fixture:true,gate_version:'mp-package-gates-fixture-v1',
    library_versions:{package_render:'fixture'},binding,binding_hash:sha('binding-'+export_id),package_hash:sha('package-'+export_id),b0:{pass:true},created_at:T0MS,created_at_utc:UTC,...over};
  return {id:export_id,row,files,run:source};
}
const fileOf=(built,path)=>built.files.find(item=>item.path===path);
const EXPORT_COLUMNS=['export_id','owner_id','bot_id','run_id','mode','pine_count','fixture','gate_version','library_versions','binding','binding_hash','package_hash','b0','created_at','created_at_utc'];
const JSON_COLUMNS=new Set(['library_versions','binding','b0']);
const insertExport=(target,row)=>target.query(`INSERT INTO public.mp_package_exports(${EXPORT_COLUMNS.join(',')}) VALUES(${EXPORT_COLUMNS.map((_,index)=>'$'+(index+1)).join(',')})`,
  EXPORT_COLUMNS.map(name=>JSON_COLUMNS.has(name)&&typeof row[name]!=='string'?JSON.stringify(row[name]):row[name]));
const insertBlob=(target,file)=>target.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3)',[file.sha256,file.bytes,file.content]);
const insertFile=(target,id,file,over={})=>target.query('INSERT INTO public.mp_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[id,over.path??file.path,over.sha256??file.sha256,over.bytes??file.bytes]);
const insertStatus=(target,id,seq,status,{codes=[],attempt_no=null}={})=>target.query('INSERT INTO public.mp_package_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [id,seq,status,codes,attempt_no,T0MS+seq,UTC]);
/** Blobs, the export row, its files and the seq 1 event: one transaction of a writer. files replaces the file list; status false leaves the seq 1 event out. */
async function writeExport(target,built,{files=built.files,status=true}={}){
  for(const file of built.files)await insertBlob(target,file);
  await insertExport(target,built.row);
  for(const file of files)await insertFile(target,built.id,file);
  if(status)await insertStatus(target,built.id,1,'EXPORT_CANDIDATE');
}
const commit=async(target,built,options)=>{await target.transaction(()=>writeExport(target,built,options),{isolation:'SERIALIZABLE'});return built;};
const VALIDATOR=sha('validator');
async function insertAttempt(target,built,n,{pass=true,codes=pass?[]:['BI_PARITY_EVIDENCE_MISSING'],attempt_id='att-'+randomUUID(),package_hash=built.row.package_hash,validator=VALIDATOR}={}){
  await target.query(`INSERT INTO public.mp_package_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[built.id,n,attempt_id,package_hash,pass,codes,'[]','{}',validator,T0MS,UTC]);
  return attempt_id;
}
const insertValidation=(target,built,attemptId,over={})=>target.query(`INSERT INTO public.mp_package_validations(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,mode,validated_at_ms,validated_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[built.id,over.package_hash??built.row.package_hash,over.binding_hash??built.row.binding_hash,attemptId,'[]',over.validator??VALIDATOR,over.fixture??true,over.mode??'MULTI_PINE',T0MS,UTC]);
const insertCompile=(target,built,ordinal,over={})=>target.query(`INSERT INTO public.mp_package_compile_records(export_id,ordinal,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,
  duplicate_bindings,mapping_check,compiled_at_ms,compiled_at_utc,operator_role,method) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [built.id,ordinal,over.sha??fileOf(built,'members/'+ordinal+'/indicator.pine')?.sha256??sha('none'),'v6','[]','[]',0,0,0,'[]',T0MS,UTC,'fixture','fixture-record']);
async function insertEvidence(target,built,ordinal,kind,evidenceHash=sha('evidence-'+built.id+'-'+ordinal+'-'+kind)){
  await target.query('INSERT INTO public.mp_package_evidence_records(export_id,ordinal,kind,record,evidence_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5,$6)',
    [built.id,ordinal,kind,JSON.stringify({method:'fixture-record',operator_role:'fixture',ordinal}),evidenceHash,T0MS]);
  return evidenceHash;
}
const BLOCKER_KIND={VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED:'native_parity',CUSTOM_REPAINT_EVIDENCE_REQUIRED:'repaint'};
const insertClearance=(target,built,blocker,ordinal,evidenceHash,over={})=>target.query(`INSERT INTO public.mp_package_clearances(export_id,blocker,ordinal,run_id,parameter_hash,evidence_hash,recorded_at_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[built.id,blocker,ordinal,over.run_id??built.row.run_id,sha('parameters'),evidenceHash,T0MS]);
const insertTrace=(target,built,path,over={})=>target.query(`INSERT INTO public.mp_package_trace_records(export_id,path,sha256,decisions_hash,steps_digest,holdout_digest,run_engine_hash,producer_closure_hash,method,recorded_at_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[built.id,path,over.sha256??fileOf(built,path)?.sha256??sha('none'),sha('decisions'),sha('steps'),sha('holdout'),over.run_engine_hash??built.run.engine_hash,
  sha('closure'),over.method??'stored-holdout-decisions-v1',T0MS]);
/** Every record kind for the members of BUILT: compile, four evidence kinds, both clearances per member, three trace records. */
async function insertCandidateRecords(target,built){
  for(let ordinal=1;ordinal<=built.row.pine_count;ordinal++){
    await insertCompile(target,built,ordinal);
    const hashes={};
    for(const kind of EVIDENCE_KINDS)hashes[kind]=await insertEvidence(target,built,ordinal,kind);
    for(const [blocker,kind] of Object.entries(BLOCKER_KIND))await insertClearance(target,built,blocker,ordinal,hashes[kind]);
  }
  for(const path of TRACE_PATHS)await insertTrace(target,built,path);
}
/** A passing attempt n, its validation and the terminal EXPORT_INTERNAL event at seq. */
async function internalAt(target,built,n,seq){
  const attemptId=await insertAttempt(target,built,n,{pass:true});
  await insertValidation(target,built,attemptId);
  await insertStatus(target,built.id,seq,'EXPORT_INTERNAL',{attempt_no:n});
  return attemptId;
}
/** One failed attempt n and its event at seq (EXPORT_CANDIDATE for a retryable failure, EXPORT_REFUSED otherwise). */
async function failAt(target,built,n,seq,{codes=['BI_PARITY_EVIDENCE_MISSING'],status='EXPORT_CANDIDATE',eventCodes=codes}={}){
  await insertAttempt(target,built,n,{pass:false,codes});
  await insertStatus(target,built.id,seq,status,{codes:eventCodes,attempt_no:n});
}
let fullMemo=null;
/** One committed export of a two-member run holding every record kind, a failed then a passing attempt, the validation row and the terminal EXPORT_INTERNAL event. */
const fullExport=()=>fullMemo??=(async()=>{
  const built=buildExport(await newRun({count:2}));
  await commit(fx,built);
  await fx.transaction(()=>insertCandidateRecords(fx,built),{isolation:'SERIALIZABLE'});
  await fx.transaction(()=>failAt(fx,built,1,2),{isolation:'SERIALIZABLE'});
  await fx.transaction(()=>internalAt(fx,built,2,3),{isolation:'SERIALIZABLE'});
  return built;
})();
let openRuns=null;
/** Two finished runs that stay without a committed export (pine_count 2 and 3); the cases write their exports inside rolled-back transactions. */
const sharedRuns=()=>openRuns??=(async()=>({two:await newRun({count:2}),three:await newRun({count:3})}))();
const expectGuard=(found,guard,label)=>{assert.ok(found,label+': accepted');assert.equal(found.code,QR004,label+': '+found.message);assert.equal(found.constraint,guard,label+': '+found.message);};
const expectConstraint=(found,code,constraint,label)=>{assert.ok(found,label+': accepted');assert.equal(found.code,code,label+': '+found.message);assert.equal(found.constraint,constraint,label+': '+found.message);};

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
  templateName='robot_ps_tpl_'+suffix;databaseName='robot_ps_main_'+suffix;
  runtimeName='robot_ps_rt_'+suffix.slice(0,14);fixtureName='robot_ps_fx_'+suffix.slice(0,14);deleterName='robot_ps_del_'+suffix.slice(0,14);truncaterName='robot_ps_trn_'+suffix.slice(0,14);
  for(const name of [runtimeName,fixtureName,deleterName,truncaterName]){extraRoles.push(name);await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());}
  await admin.query('CREATE DATABASE '+templateName);
  const builder=ser(new PostgresDatabase({connectionString:urlOf(templateName),max:2}));
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
    await migrateMpMemberSet(builder);await migrateMpRunStore(builder);await migrateBestInputsPackage(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName),max:6})));
  store=new Store(db);
  await migrateMpPackageStore(db);
  await db.query(await grantScript(runtimeName));await db.query(await runFixtureScript(runtimeName,fixtureName));await db.query(await packageFixtureScript(runtimeName,fixtureName));
  // Layer-2 proof roles: the deleter holds UPDATE and DELETE, the truncater TRUNCATE, on every package-store table (granted after the scripts, as a hostile operator could).
  const all=ALL_TABLES.map(table=>'public.'+table).join(',');
  await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${all} TO ${deleterName}`);await db.query(`GRANT SELECT ON TABLE public.mp_research_runs,public.mp_research_run_events TO ${deleterName}`);await db.query(`GRANT SELECT,TRUNCATE ON TABLE ${all} TO ${truncaterName}`);
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,runtimeName),max:4})));fx=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:6})));
  dl=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,deleterName),max:3})));tr=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,truncaterName),max:2})));
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    // A raw client: the application pool times a statement out after 15 s, and dropping the first big database can take longer than that.
    const dropper=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
    await dropper.connect();
    for(const name of [...databases,databaseName,templateName])await dropper.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of extraRoles)await dropper.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await dropper.end();
    await admin.close();
  }
});

/* ---- 1. install lifecycle ---- */

test('absent: the classification and a read-only inspection report ABSENT and write nothing; the module constants and the SQL file are the plan',async()=>{
  const name=await clone('absent');
  const target=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:2})));
  const before=await catalogDigest(target);
  const classification=await classifyMpPackageStore(target);
  assert.deepEqual([classification.state,classification.problems,classification.tables],['ABSENT',[],[]]);
  const report=await inspectMpPackageStore(target);
  assert.equal(report.facts.state,'ABSENT');assert.equal(report.facts.run_store_state,'INSTALLED');assert.equal(report.facts.member_set_state,'INSTALLED');assert.equal(report.ok,false);
  assert.ok(report.failures.length>0&&report.failures.every(item=>NOT_INSTALLED.test(item)),report.failures.join());
  assert.equal((await inspectMpPackageStore(target,{runtimeRole:'no_such_role_ps'})).failures.includes('RUNTIME_ROLE_MISSING'),true);
  assert.equal((await inspectMpPackageStore(target,{fixtureRole:'no_such_role_ps'})).failures.includes('FIXTURE_ROLE_MISSING'),true);
  assert.deepEqual(await catalogDigest(target),before,'an inspection changes nothing');
  assert.deepEqual(await packageObjects(target),NONE);
  assert.equal(PACKAGE_STORE_GUARDS.length,43);
  assert.deepEqual([...PACKAGE_STORE_TABLES].sort(),['mp_package_attempts','mp_package_blobs','mp_package_clearances','mp_package_compile_records','mp_package_evidence_records','mp_package_exports',
    'mp_package_files','mp_package_status_events','mp_package_trace_records','mp_package_validations']);
  assert.equal(MARKER_TABLE,'mp_package_store_schema');assert.equal(PACKAGE_STORE_MARKER,'mp-package-store-v1-schema');
  assert.deepEqual([...QR004_GUARDS].sort(),Object.values(G).sort());
  assert.deepEqual([QR002,QR003,QR004],['QR002','QR003','QR004']);
  // The SQL file: only the QR002, QR003 and QR004 plan, no SECURITY DEFINER, and no foreign key onto anything but users and the extension's own tables (judgement J1).
  const text=await sqlText('mp-package-store.sql');
  assert.deepEqual([...new Set([...text.matchAll(/ERRCODE = '([A-Z0-9]+)'/g)].map(match=>match[1]))].sort(),['QR002','QR003','QR004']);
  assert.doesNotMatch(text,/SECURITY DEFINER/i);
  const code=text.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n');
  const targets=[...code.matchAll(/REFERENCES public\.([a-z_0-9]+)/g)].map(match=>match[1]);
  assert.ok(targets.length>=12,'the keys are found: '+targets.length);
  for(const item of targets)assert.ok(item==='users'||item.startsWith('mp_package_'),'a foreign key onto '+item);
  assert.doesNotMatch(code,/REFERENCES public\.(mp_research|mp_member|mp_run|bi_|quant_|ql4c)/);
  // The runtime reads (SELECT) of the run store are the only mentions of its tables, inside the guard functions.
  for(const match of code.matchAll(/(?:FROM|JOIN)\s+public\.(mp_research_runs?|mp_research_run_events)\b/g))assert.ok(match[1].startsWith('mp_research_run'));
  assert.doesNotMatch(code,/(?:INSERT INTO|UPDATE|DELETE FROM)\s+public\.(mp_research_run|mp_member|bi_|quant_)/);
  assert.equal([...code.matchAll(/CREATE TABLE public\.(\w+)/g)].length,11);
  assert.equal([...code.matchAll(/CREATE FUNCTION public\.(\w+)/g)].length,17);
  assert.equal([...code.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER (\w+)/g)].length,43);
  assert.equal([...code.matchAll(/ENABLE ALWAYS TRIGGER (\w+)/g)].length,43,'every trigger is ENABLE ALWAYS');
  assert.equal([...code.matchAll(/LANGUAGE \w+( IMMUTABLE)? SET search_path = pg_catalog, pg_temp/g)].length,17,'every function pins its search_path');
  // The rollback SQL names exactly the objects of the install.
  const rollback=await sqlText('mp-package-store-rollback.sql');
  assert.deepEqual([...rollback.matchAll(/DROP TABLE public\.(\w+)/g)].map(match=>match[1]).sort(),[...ALL_TABLES].sort());
  assert.equal([...rollback.matchAll(/DROP FUNCTION public\.(\w+)/g)].length,17);
  assert.doesNotMatch(rollback.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n'),/CASCADE/i);
});

test('install: ABSENT to INSTALLED in one transaction; the base schema, other tables and grants stay as they were; a second install is a no-op; db.migrate never installs it',async()=>{
  const name=await clone('install');
  const target=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:2})));
  const baseTables=(await target.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname);
  const acl=async()=>(await target.query(`SELECT c.relname||':'||COALESCE(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')
    AND c.relname NOT LIKE 'mp\\_package\\_%' ORDER BY 1`)).rows;
  const aclBefore=await acl();
  const report=await migrateMpPackageStore(target,{runtimeRole:runtimeName}).catch(error=>error);
  assert.ok(!(report instanceof Error),String(report));assert.equal(report.ok,true,report.failures?.join());assert.equal(report.previous_state,'ABSENT');
  assert.equal(report.facts.state,'INSTALLED');assert.equal(report.facts.marker,PACKAGE_STORE_MARKER);assert.equal(report.facts.guards.length,43);
  assert.equal(report.facts.run_store_state,'INSTALLED');assert.equal(report.facts.member_set_state,'INSTALLED');
  assert.ok(report.facts.guards.every(item=>item.enabled==='A'),'every guard is ENABLE ALWAYS');
  assert.deepEqual((await target.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows.map(row=>row.relname).filter(item=>!baseTables.includes(item)),
    [...ALL_TABLES].sort(),'exactly the eleven package-store tables were added');
  assert.deepEqual(await acl(),aclBefore,'no existing grant changed');
  const objects=await packageObjects(target);
  assert.equal(objects.functions,17);assert.equal(objects.triggers,43);assert.ok(objects.relations>=11+11,'eleven tables and their indexes: '+objects.relations);
  assert.equal((await target.query('SELECT version FROM schema_version')).rows[0].version,14,'the base schema version stays 14');
  assert.deepEqual((await target.query('SELECT version FROM mp_package_store_schema')).rows,[{version:1}]);
  assert.equal((await target.query('SELECT public.mp_package_store_version() v')).rows[0].v,PACKAGE_STORE_MARKER);
  assert.deepEqual((await guardRows(target)).map(row=>[row.tgname,row.tgenabled,row.tgtype]).sort(),PACKAGE_STORE_GUARDS.map(item=>[item[0],'A',item[3]]).sort());
  assert.ok((await target.query(`SELECT p.prosecdef,p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'mp\\_package\\_store\\_%'`)).rows
    .every(row=>row.prosecdef===false&&row.proconfig.length===1&&row.proconfig[0]==='search_path=pg_catalog, pg_temp'),'every function is SECURITY INVOKER with the pinned search_path');
  const deferred=(await target.query("SELECT tgdeferrable,tginitdeferred,tgconstraint<>0 AS constraint_trigger FROM pg_trigger WHERE tgname='mp_package_exports_complete'")).rows;
  assert.deepEqual(deferred,[{tgdeferrable:true,tginitdeferred:true,constraint_trigger:true}],'the completeness check is a deferred constraint trigger');
  assert.equal((await classifyMpPackageStore(target)).state,'INSTALLED');
  const settled=await catalogDigest(target);
  const again=await migrateMpPackageStore(target,{runtimeRole:runtimeName});
  assert.equal(again.ok,true);assert.equal(again.previous_state,'INSTALLED');assert.deepEqual(await catalogDigest(target),settled,'a second install writes nothing, not even a row version');
  // Never through db.migrate: a fresh database migrated to the base schema holds no package-store object, and the product code never imports the installer.
  const freshName='robot_ps_fresh_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(freshName);
  await admin.query('CREATE DATABASE '+freshName);
  const fresh=track(new PostgresDatabase({connectionString:urlOf(freshName),max:2}));await fresh.migrate();
  assert.deepEqual(await packageObjects(fresh),NONE);
  assert.doesNotMatch(await fs.readFile(new URL('../../src/postgres/db.js',import.meta.url),'utf8'),/mp-package-store|mp_package_/);
});

test('install only over an INSTALLED run store: an absent, member-set-only or tampered run store is refused with no write; a foreign object classifies OTHER',async()=>{
  const bareName='robot_ps_bare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=ser(track(new PostgresDatabase({connectionString:urlOf(bareName),max:2})));await bare.migrate();
  const bareBefore=await catalogDigest(bare);
  await assert.rejects(migrateMpPackageStore(bare),/the run store must be INSTALLED, found ABSENT \(no change made\)/);
  assert.deepEqual(await catalogDigest(bare),bareBefore);
  // member-set extension only (no run store)
  await install(bare,'pine-bridge-schema.sql');await migrateMpMemberSet(bare);
  const memberBefore=await catalogDigest(bare);
  await assert.rejects(migrateMpPackageStore(bare),/the run store must be INSTALLED, found ABSENT \(no change made\)/);
  assert.deepEqual(await catalogDigest(bare),memberBefore);assert.deepEqual(await packageObjects(bare),NONE);
  // a tampered run store
  const brokenName=await clone('badrs');
  const broken=ser(track(new PostgresDatabase({connectionString:urlOf(brokenName),max:2})));
  await broken.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER mp_research_runs_no_change');
  const brokenBefore=await catalogDigest(broken);
  await assert.rejects(migrateMpPackageStore(broken),/the run store must be INSTALLED, found OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(broken),brokenBefore);assert.deepEqual(await packageObjects(broken),NONE);
  // the inspection of a package store over a run store that is not INSTALLED fails (RUN_STORE_REQUIRED)
  const installedName=await clone('rsgone');
  const gone=ser(track(new PostgresDatabase({connectionString:urlOf(installedName),max:2})));
  await migrateMpPackageStore(gone);
  const required=await probe(gone,async()=>{await gone.query('ALTER TABLE public.mp_research_runs DISABLE TRIGGER mp_research_runs_no_change');return inspectMpPackageStore(gone);});
  assert.equal(required.ok,false);assert.ok(required.failures.includes('RUN_STORE_REQUIRED:OTHER'),required.failures.join());
  // same-name foreign objects classify OTHER
  const noop="CREATE FUNCTION public.mp_pkg_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const cases=[
    ['foreign exports table','CREATE TABLE public.mp_package_exports(x integer)','TABLE_DEFINITION:mp_package_exports:'],
    ['foreign files table','CREATE TABLE public.mp_package_files(x integer)','TABLE_DEFINITION:mp_package_files:'],
    ['foreign marker table','CREATE TABLE public.mp_package_store_schema(version integer)','TABLE_DEFINITION:mp_package_store_schema:'],
    ['foreign marker function',"CREATE FUNCTION public.mp_package_store_version() RETURNS text LANGUAGE sql AS $$ SELECT 'evil'::text $$",'FUNCTION_DEFINITION:mp_package_store_version:'],
    ['overload of the freeze function','CREATE FUNCTION public.mp_package_store_freeze(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:mp_package_store_freeze('],
    ['foreign function of a package-store name','CREATE FUNCTION public.mp_package_store_guard_export(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$','FUNCTION_UNEXPECTED:mp_package_store_guard_export('],
    ['view carrying an index name','CREATE VIEW public.mp_package_exports_pkey AS SELECT 1 AS x','RELATION_UNEXPECTED:mp_package_exports_pkey'],
    ['sequence carrying an index name','CREATE SEQUENCE public.mp_package_files_pkey','RELATION_UNEXPECTED:mp_package_files_pkey'],
    ['standalone type carrying a table name','CREATE DOMAIN public.mp_package_exports AS integer','TYPE_UNEXPECTED:mp_package_exports'],
    ['trigger carrying a guard name on another table',noop+' CREATE TRIGGER mp_package_exports_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.mp_pkg_noop()','TRIGGER_UNEXPECTED:mp_package_exports_guard']];
  for(const [label,statement,prefix] of cases){
    const found=await probe(bare,async()=>{
      // The bare database has no run store; classification of the package store does not need it.
      await bare.query(statement);return {classification:await classifyMpPackageStore(bare)};});
    assert.equal(found.classification.state,'OTHER',label);
    assert.ok([...found.classification.problems,...found.classification.missing].some(item=>item.startsWith(prefix)),label+': '+found.classification.problems.join());
  }
  const foreignName=await clone('foreign');
  const foreign=ser(track(new PostgresDatabase({connectionString:urlOf(foreignName),max:2})));
  await foreign.query('CREATE TABLE public.mp_package_exports(x integer)');await foreign.query('INSERT INTO public.mp_package_exports VALUES(7)');
  const foreignBefore=await catalogDigest(foreign);
  await assert.rejects(migrateMpPackageStore(foreign),/unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackMpPackageStore(foreign),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(foreign),foreignBefore);assert.deepEqual((await foreign.query('SELECT x FROM public.mp_package_exports')).rows,[{x:7}],'the foreign row survived');
  const partialName=await clone('partial');
  const partial=ser(track(new PostgresDatabase({connectionString:urlOf(partialName),max:2})));
  await migrateMpPackageStore(partial);
  await partial.query('DROP TRIGGER mp_package_files_no_truncate ON public.mp_package_files');
  const partialBefore=await catalogDigest(partial);
  await assert.rejects(migrateMpPackageStore(partial),/unexpected state OTHER \(no change made\).*TRIGGER_MISSING:mp_package_files_no_truncate/);
  await assert.rejects(rollbackMpPackageStore(partial),/unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await catalogDigest(partial),partialBefore);
  assert.equal((await classifyMpPackageStore(partial)).state,'OTHER');
});

test('offline only: the install and the rollback need the maintenance lock and their own transaction',async()=>{
  const before=await catalogDigest(db);
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateMpPackageStore(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackMpPackageStore(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateMpPackageStore(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackMpPackageStore(db)),/own transaction/);
  assert.deepEqual(await catalogDigest(db),before,'the refused attempts changed nothing');
});

/* ---- 2. judgement J1: the other extensions stay INSTALLED ---- */

test('J1: with the package store installed, the run-store, member-set and Best Inputs classifiers still report INSTALLED, and no foreign key leaves the package store for a run-store or bi_ table',async()=>{
  assert.equal((await classifyMpPackageStore(db)).state,'INSTALLED');
  const runStore=await classifyMpRunStore(db);
  assert.equal(runStore.state,'INSTALLED',[...runStore.problems,...runStore.missing].join());assert.deepEqual([runStore.problems,runStore.missing],[[],[]]);
  const runReport=await inspectMpRunStore(db);assert.equal(runReport.ok,true,runReport.failures.join());
  const members=await classifyMpMemberSet(db);assert.equal(members.state,'INSTALLED',[...members.problems,...members.missing].join());
  const best=await classifyBestInputsPackage(db);assert.equal(best.state,'INSTALLED',[...best.problems,...best.missing].join());
  const bestReport=await inspectBestInputsPackage(db);assert.equal(bestReport.ok,true,bestReport.failures.join());
  // The classification query of the proof: every foreign key whose referencing table is a package-store table, with the table it names.
  const keys=(await db.query(`SELECT k.conrelid::regclass::text AS from_table,k.conname,k.confrelid::regclass::text AS to_table FROM pg_catalog.pg_constraint k
    WHERE k.contype='f' AND k.conrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'mp\\_package\\_%') ORDER BY 1,2`)).rows;
  assert.ok(keys.length>=12);
  for(const key of keys)assert.ok(key.to_table==='users'||key.to_table.startsWith('mp_package_'),key.conname+' names '+key.to_table);
  // The query the run-store classifier asks for each of its tables (REFERENCED_BY): a foreign key from outside the run store onto it. It finds none.
  const runTables=(await db.query("SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('mp_research_runs','mp_research_run_events','mp_run_store_schema')")).rows.map(row=>row.oid);
  assert.equal(runTables.length,3);
  for(const oid of runTables)assert.equal((await db.query("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.contype='f' AND k.confrelid=$1 AND k.conrelid<>ALL($2::oid[])) AS referenced_by",[oid,runTables])).rows[0].referenced_by,false);
  // No view, rule or publication depends on a run-store, member-set or bi_ table because of this extension.
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_depend d JOIN pg_rewrite w ON d.classid='pg_rewrite'::regclass AND d.objid=w.oid
    WHERE d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT oid FROM pg_class WHERE relname LIKE 'mp\\_research\\_run%' OR relname LIKE 'mp\\_run\\_store%')`)).rows[0].n,0);
  // Negative control: one foreign key from a package table onto the run table would make the run-store classifier read OTHER (REFERENCED_BY). That is why the guard reads by SELECT.
  const control=await probe(db,async()=>{
    await db.query('ALTER TABLE public.mp_package_exports ADD CONSTRAINT mp_ps_control_fkey FOREIGN KEY(run_id) REFERENCES public.mp_research_runs(run_id)');
    return {run:await classifyMpRunStore(db),pack:await classifyMpPackageStore(db)};
  });
  assert.equal(control.run.state,'OTHER');assert.ok(control.run.problems.includes('TABLE_DEFINITION:mp_research_runs:REFERENCED_BY'),control.run.problems.join());
  assert.equal(control.pack.state,'OTHER');
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED','the control was rolled back');
});

/* ---- 3. every tamper classifies OTHER ---- */

test('installed: every tampered object classifies OTHER and is reported; a replaced marker function is never executed',async()=>{
  const noop="CREATE FUNCTION public.mp_pkg_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;";
  const redo=(name,table,when,fn)=>`DROP TRIGGER ${name} ON public.${table}; CREATE TRIGGER ${name} ${when} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();`;
  const X='ALTER TABLE public.mp_package_exports ',F='ALTER TABLE public.mp_package_files ',S='ALTER TABLE public.mp_package_status_events ',A='ALTER TABLE public.mp_package_attempts ';
  const cases=[];
  // every trigger function: its body replaced
  for(const name of ['freeze','require_serializable','guard_export','guard_export_complete','guard_file','guard_status','guard_attempt','guard_validation','guard_compile','guard_evidence','guard_clearance','guard_trace'])
    cases.push([name+' body replaced',`CREATE OR REPLACE FUNCTION public.mp_package_store_${name}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$`,
      'FUNCTION_DEFINITION:mp_package_store_'+name+':BODY']);
  cases.push(
    ['marker function body replaced',"CREATE OR REPLACE FUNCTION public.mp_package_store_version() RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x'::text $$",'FUNCTION_DEFINITION:mp_package_store_version:BODY'],
    ['retryable list body replaced',"CREATE OR REPLACE FUNCTION public.mp_package_store_retryable_codes() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT ARRAY['X']::text[] $$",'FUNCTION_DEFINITION:mp_package_store_retryable_codes:BODY'],
    ['export lock body replaced','CREATE OR REPLACE FUNCTION public.mp_package_store_lock_export(p_export UUID) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN NULL; END $$','FUNCTION_DEFINITION:mp_package_store_lock_export:BODY'],
    ['latest status body replaced','CREATE OR REPLACE FUNCTION public.mp_package_store_latest_status(p_export UUID) RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NULL; END $$','FUNCTION_DEFINITION:mp_package_store_latest_status:BODY'],
    ['candidate gate body replaced','CREATE OR REPLACE FUNCTION public.mp_package_store_require_candidate(p_export UUID, p_guard TEXT) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN NULL; END $$','FUNCTION_DEFINITION:mp_package_store_require_candidate:BODY'],
    ['guard made SECURITY DEFINER','ALTER FUNCTION public.mp_package_store_guard_export() SECURITY DEFINER','FUNCTION_DEFINITION:mp_package_store_guard_export:SECURITY_DEFINER'],
    ['guard search_path reset','ALTER FUNCTION public.mp_package_store_guard_status() RESET search_path','FUNCTION_DEFINITION:mp_package_store_guard_status:SEARCH_PATH'],
    ['guard search_path widened','ALTER FUNCTION public.mp_package_store_freeze() SET search_path = public, pg_catalog','FUNCTION_DEFINITION:mp_package_store_freeze:SEARCH_PATH'],
    ['guard made STRICT','ALTER FUNCTION public.mp_package_store_freeze() STRICT','FUNCTION_DEFINITION:mp_package_store_freeze:ATTRIBUTES'],
    ['freeze trigger disabled',S+'DISABLE TRIGGER mp_package_status_events_no_change','TRIGGER_NOT_ALWAYS:mp_package_status_events_no_change'],
    ['export guard origin only',X+'ENABLE TRIGGER mp_package_exports_guard','TRIGGER_NOT_ALWAYS:mp_package_exports_guard'],
    ['status guard replica only',S+'ENABLE REPLICA TRIGGER mp_package_status_events_guard','TRIGGER_NOT_ALWAYS:mp_package_status_events_guard'],
    ['serializable trigger disabled',F+'DISABLE TRIGGER mp_package_files_00_serializable','TRIGGER_NOT_ALWAYS:mp_package_files_00_serializable'],
    ['attempt guard disabled',A+'DISABLE TRIGGER mp_package_attempts_guard','TRIGGER_NOT_ALWAYS:mp_package_attempts_guard'],
    ['deferred check disabled',X+'DISABLE TRIGGER mp_package_exports_complete','TRIGGER_NOT_ALWAYS:mp_package_exports_complete'],
    ['deferred check made immediate',`DROP TRIGGER mp_package_exports_complete ON public.mp_package_exports; CREATE CONSTRAINT TRIGGER mp_package_exports_complete AFTER INSERT ON public.mp_package_exports FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_guard_export_complete(); ${X}ENABLE ALWAYS TRIGGER mp_package_exports_complete`,'TRIGGER_SHAPE:mp_package_exports_complete'],
    ['deferred check made a plain trigger',`${redo('mp_package_exports_complete','mp_package_exports','AFTER INSERT','mp_package_store_guard_export_complete')} ${X}ENABLE ALWAYS TRIGGER mp_package_exports_complete`,'TRIGGER_SHAPE:mp_package_exports_complete'],
    ['trigger rebound to another function',`${redo('mp_package_exports_guard','mp_package_exports','BEFORE INSERT','mp_package_store_guard_file')} ${X}ENABLE ALWAYS TRIGGER mp_package_exports_guard`,'TRIGGER_FUNCTION:mp_package_exports_guard'],
    ['freeze trigger narrowed to UPDATE only',`${redo('mp_package_exports_no_change','mp_package_exports','BEFORE UPDATE','mp_package_store_freeze')} ${X}ENABLE ALWAYS TRIGGER mp_package_exports_no_change`,'TRIGGER_SHAPE:mp_package_exports_no_change'],
    ['file guard made AFTER',`${redo('mp_package_files_guard','mp_package_files','AFTER INSERT','mp_package_store_guard_file')} ${F}ENABLE ALWAYS TRIGGER mp_package_files_guard`,'TRIGGER_SHAPE:mp_package_files_guard'],
    ['extra trigger on the marker table',noop+' CREATE TRIGGER mp_marker AFTER INSERT ON public.mp_package_store_schema FOR EACH ROW EXECUTE FUNCTION public.mp_pkg_noop()','TRIGGER_UNEXPECTED:mp_marker'],
    ['extra trigger on the exports table',noop+' CREATE TRIGGER mp_extra AFTER INSERT ON public.mp_package_exports FOR EACH ROW EXECUTE FUNCTION public.mp_pkg_noop()','TRIGGER_UNEXPECTED:mp_extra'],
    ['guard function bound elsewhere',noop+' CREATE TRIGGER mp_elsewhere BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.mp_package_store_freeze()','TRIGGER_UNEXPECTED:mp_elsewhere'],
    ['path check widened',F+"DROP CONSTRAINT mp_package_files_path_check, ADD CONSTRAINT mp_package_files_path_check CHECK(path ~ '^.*$')",'TABLE_DEFINITION:mp_package_files:CONSTRAINTS'],
    ['path check dropped',F+'DROP CONSTRAINT mp_package_files_path_check','TABLE_DEFINITION:mp_package_files:CONSTRAINTS'],
    ['binding ties check dropped',X+'DROP CONSTRAINT mp_package_exports_binding_ties_check','TABLE_DEFINITION:mp_package_exports:CONSTRAINTS'],
    ['fixture check dropped',X+'DROP CONSTRAINT mp_package_exports_fixture_check','TABLE_DEFINITION:mp_package_exports:CONSTRAINTS'],
    ['mode check widened',X+"DROP CONSTRAINT mp_package_exports_mode_check, ADD CONSTRAINT mp_package_exports_mode_check CHECK(mode IN ('ONE_PINE','MULTI_PINE'))",'TABLE_DEFINITION:mp_package_exports:CONSTRAINTS'],
    ['owner and run unique key dropped',X+'DROP CONSTRAINT mp_package_exports_owner_run_key','TABLE_DEFINITION:mp_package_exports:CONSTRAINTS'],
    ['status check widened to EXPORT_VALIDATED',S+"DROP CONSTRAINT mp_package_status_events_status_check, ADD CONSTRAINT mp_package_status_events_status_check CHECK(status IN ('EXPORT_CANDIDATE','EXPORT_INTERNAL','EXPORT_REFUSED','EXPORT_VALIDATED'))",'TABLE_DEFINITION:mp_package_status_events:CONSTRAINTS'],
    ['attempt cap widened',A+'DROP CONSTRAINT mp_package_attempts_attempt_no_check, ADD CONSTRAINT mp_package_attempts_attempt_no_check CHECK(attempt_no>=1 AND attempt_no<=9)','TABLE_DEFINITION:mp_package_attempts:CONSTRAINTS'],
    ['extra constraint',X+'ADD CONSTRAINT mp_extra CHECK(created_at>=0)','TABLE_DEFINITION:mp_package_exports:CONSTRAINTS'],
    ['foreign key dropped',F+'DROP CONSTRAINT mp_package_files_blob_fkey','TABLE_DEFINITION:mp_package_files:CONSTRAINTS'],
    ['foreign key made CASCADE',F+'DROP CONSTRAINT mp_package_files_export_id_fkey, ADD CONSTRAINT mp_package_files_export_id_fkey FOREIGN KEY(export_id) REFERENCES public.mp_package_exports(export_id) ON DELETE CASCADE','TABLE_DEFINITION:mp_package_files:CONSTRAINTS'],
    ['primary key of the files dropped',F+'DROP CONSTRAINT mp_package_files_pkey','INDEX_MISSING:mp_package_files_pkey'],
    ['extra index','CREATE INDEX mp_extra ON public.mp_package_exports(package_hash)','TABLE_DEFINITION:mp_package_exports:INDEXES'],
    ['column default added',X+'ALTER COLUMN created_at SET DEFAULT 0','TABLE_DEFINITION:mp_package_exports:COLUMNS'],
    ['column made optional',S+'ALTER COLUMN at_ms DROP NOT NULL','TABLE_DEFINITION:mp_package_status_events:COLUMNS'],
    ['column added',X+'ADD COLUMN status text','TABLE_DEFINITION:mp_package_exports:COLUMNS'],
    ['column type changed',S+'ALTER COLUMN seq TYPE bigint','TABLE_DEFINITION:mp_package_status_events:COLUMNS'],
    ['column collation changed',S+'ALTER COLUMN status TYPE text COLLATE "C"','TABLE_DEFINITION:mp_package_status_events:COLLATION'],
    ['row security enabled',X+'ENABLE ROW LEVEL SECURITY','TABLE_DEFINITION:mp_package_exports:SHAPE'],
    ['rule added','CREATE RULE mp_rule AS ON INSERT TO public.mp_package_status_events DO ALSO NOTHING','TABLE_DEFINITION:mp_package_status_events:SHAPE'],
    ['marker row removed','DELETE FROM public.mp_package_store_schema','MARKER_ROW'],
    ['marker check constraint dropped','ALTER TABLE public.mp_package_store_schema DROP CONSTRAINT mp_package_store_schema_version_check','TABLE_DEFINITION:mp_package_store_schema:CONSTRAINTS'],
    ['exports table re-owned to another role',X+'OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_package_exports'],
    ['marker table re-owned (every other object then differs from the marker owner)','ALTER TABLE public.mp_package_store_schema OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_package_exports'],
    ['guard function re-owned to another role','ALTER FUNCTION public.mp_package_store_guard_status() OWNER TO '+runtimeName,'OWNER_MISMATCH:mp_package_store_guard_status'],
    ['marker table renamed','ALTER TABLE public.mp_package_store_schema RENAME TO mp_renamed','TABLE_MISSING:mp_package_store_schema'],
    ['internal foreign key triggers of the files disabled',F+'DISABLE TRIGGER ALL','TABLE_DEFINITION:mp_package_files:FOREIGN_KEY_TRIGGERS']);
  // every trigger dropped in turn
  for(const [name,table] of PACKAGE_STORE_GUARDS)cases.push(['trigger '+name+' dropped',`DROP TRIGGER ${name} ON public.${table}`,'TRIGGER_MISSING:'+name]);
  for(const [label,statement,prefix] of cases){
    const found=await probe(db,async()=>{
      // A tamper may need the freeze trigger out of the way for its own setup statement (DELETE of the marker row); the probe is rolled back.
      if(label==='marker row removed')await db.query('ALTER TABLE public.mp_package_store_schema DISABLE TRIGGER mp_package_store_schema_no_change');
      await db.query(statement);return {classification:await classifyMpPackageStore(db),report:await inspectMpPackageStore(db),runStore:(await classifyMpRunStore(db)).state};});
    const all=[...found.classification.problems,...found.classification.missing];
    assert.equal(found.classification.state,'OTHER',label+': '+all.join());
    assert.ok(all.some(item=>item.startsWith(prefix)),label+': '+all.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
    // The run-store classifier does not look at package-store objects: whatever the tamper, it stays INSTALLED.
    assert.equal(found.runStore,'INSTALLED','run-store classifier after: '+label);
  }
  // A replaced marker function that raises when called: the inspection reports it and never calls it.
  const replaced=await probe(db,async()=>{
    await db.query("CREATE OR REPLACE FUNCTION public.mp_package_store_version() RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RAISE EXCEPTION 'marker executed'; END $$");
    return inspectMpPackageStore(db);
  });
  assert.equal(replaced.ok,false);assert.equal(replaced.facts.marker,null);assert.ok(replaced.failures.includes('MARKER_MISSING'));
  assert.ok(replaced.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:mp_package_store_version:BODY')));
  assert.equal((await classifyMpPackageStore(db)).state,'INSTALLED','every tamper was rolled back');
});

test('installed: a derived object that can expose package-store rows classifies OTHER (inheritance, an outside foreign key, a publication, a view, a rule, a materialized view)',async()=>{
  const reasonsOf=(found,table)=>found.classification.problems.filter(item=>item.startsWith('TABLE_DEFINITION:'+table+':')).flatMap(item=>item.split(':')[2].split('+'));
  const tamper=statements=>probe(db,async()=>{for(const statement of statements)await db.query(statement);
    return {classification:await classifyMpPackageStore(db),report:await inspectMpPackageStore(db),runStore:(await classifyMpRunStore(db)).state};});
  const cases=[
    ['exports table made a child of a foreign parent','mp_package_exports','INHERITANCE',['CREATE TABLE public.ps_parent(export_id uuid, owner_id text)','ALTER TABLE public.mp_package_exports INHERIT public.ps_parent']],
    ['foreign child table inheriting from the files table','mp_package_files','INHERITANCE',['CREATE TABLE public.ps_child() INHERITS (public.mp_package_files)']],
    ['foreign key from a table outside the package store onto the exports','mp_package_exports','REFERENCED_BY',['CREATE TABLE public.ps_ref(export_id uuid REFERENCES public.mp_package_exports(export_id))']],
    ['foreign key from a table outside the package store onto the blobs','mp_package_blobs','REFERENCED_BY',['CREATE TABLE public.ps_ref(sha256 text REFERENCES public.mp_package_blobs(sha256))']],
    ['foreign key from a table outside the package store onto the marker','mp_package_store_schema','REFERENCED_BY',['CREATE TABLE public.ps_ref(version integer REFERENCES public.mp_package_store_schema(version))']],
    ['publication of the exports table','mp_package_exports','PUBLICATION',['CREATE PUBLICATION ps_pub FOR TABLE public.mp_package_exports']],
    ['publication of every table','mp_package_files','PUBLICATION',['CREATE PUBLICATION ps_pub FOR ALL TABLES']],
    ['publication of the tables in schema public','mp_package_blobs','PUBLICATION',['CREATE PUBLICATION ps_pub FOR TABLES IN SCHEMA public']],
    ['view over the exports table','mp_package_exports','DEPENDENT_VIEW',['CREATE VIEW public.ps_view AS SELECT export_id,owner_id,binding FROM public.mp_package_exports']],
    ['view over the blobs table','mp_package_blobs','DEPENDENT_VIEW',['CREATE VIEW public.ps_view AS SELECT sha256,content FROM public.mp_package_blobs']],
    ['view over two tables (a join)','mp_package_exports','DEPENDENT_VIEW',['CREATE VIEW public.ps_view AS SELECT x.export_id,f.path FROM public.mp_package_exports x JOIN public.mp_package_files f USING(export_id)']],
    ['view over the marker table','mp_package_store_schema','DEPENDENT_VIEW',['CREATE VIEW public.ps_view AS SELECT version FROM public.mp_package_store_schema']],
    ['materialized view over the trace records','mp_package_trace_records','DEPENDENT_VIEW',['CREATE MATERIALIZED VIEW public.ps_view AS SELECT export_id,path FROM public.mp_package_trace_records']],
    ['rule of a foreign table that reads a package-store table','mp_package_exports','DEPENDENT_VIEW',['CREATE TABLE public.ps_sink(n bigint)',
      'CREATE RULE ps_rule AS ON INSERT TO public.ps_sink DO ALSO SELECT export_id FROM public.mp_package_exports']]];
  for(const [label,table,reason,statements] of cases){
    const found=await tamper(statements);
    assert.equal(found.classification.state,'OTHER',label+': '+found.classification.problems.join());
    assert.ok(reasonsOf(found,table).includes(reason),label+': '+found.classification.problems.join());
    assert.equal(found.report.ok,false,label);assert.equal(found.report.facts.state,'OTHER',label);
    // A publication of every table or of the schema is global: it makes the run-store classifier read OTHER as well (its own rule), whatever this extension does.
    if(!/publication of (every table|the tables in schema)/.test(label))assert.equal(found.runStore,'INSTALLED','the run-store classifier does not look at package-store derived objects: '+label);
  }
  assert.equal((await classifyMpPackageStore(db)).state,'INSTALLED','every tamper was rolled back');
});

/* ---- 4. grants: the runtime role holds nothing, the fixture role reads and inserts (RD-MP-36, RD-MP-42, K7) ---- */

test('grants: the repository grant script lists every package-store table as internal_only, and nowhere else (integrator gate, K7)',async()=>{
  const text=await fs.readFile(GRANT_SCRIPT,'utf8');
  const list=name=>{const match=new RegExp(name+' CONSTANT TEXT\\[\\] := ARRAY\\[([^\\]]*)\\]').exec(text);assert.ok(match,name);return [...match[1].matchAll(/'([^']+)'/g)].map(item=>item[1]);};
  const internal=list('internal_only');
  for(const table of ALL_TABLES)assert.ok(internal.includes(table),table+' is internal_only');
  assert.deepEqual(internal.filter(name=>name.startsWith('mp_package_')).sort(),[...ALL_TABLES].sort());
  for(const name of ['insert_only','read_only','protected'])for(const table of ALL_TABLES)assert.ok(!list(name).includes(table),table+' is not '+name);
  // Every package-store table the catalog holds is in that array: a table missing from it would get runtime DML from the default category.
  const live=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname LIKE 'mp\\_package\\_%' ORDER BY 1")).rows.map(row=>row.relname);
  assert.deepEqual(live,[...ALL_TABLES].sort());
  for(const table of live)assert.ok(internal.includes(table),table+' is missing from internal_only');
});

test('grants (B2): the runtime role holds no privilege on any package-store table and gets 42501; the fixture role reads and inserts; reapply is idempotent; the inspection judges both roles',async()=>{
  const acl=async()=>(await db.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  const first=await acl();
  await db.query(await grantScript(runtimeName));await db.query(await packageFixtureScript(runtimeName,fixtureName));
  assert.equal(await acl(),first,'a second application of the scripts changes nothing');
  const facts=async(who,table)=>(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'SELECT') AS "select",has_table_privilege($2,oid,'INSERT') AS "insert",
    has_table_privilege($2,oid,'UPDATE') AS "update",has_table_privilege($2,oid,'DELETE') AS "delete",has_table_privilege($2,oid,'TRUNCATE') AS truncate,has_table_privilege($2,oid,'TRIGGER') AS trigger,
    has_table_privilege($2,oid,'REFERENCES') AS "references",has_any_column_privilege($2,oid,'SELECT') AS column_select FROM pg_class WHERE oid=$1::regclass`,[table,who])).rows[0];
  const NOTHING={owner:false,select:false,insert:false,update:false,delete:false,truncate:false,trigger:false,references:false,column_select:false};
  for(const table of ALL_TABLES)assert.deepEqual(await facts(runtimeName,'public.'+table),NOTHING,'runtime role on '+table);
  for(const table of RECORD_TABLES)assert.deepEqual(await facts(fixtureName,'public.'+table),{...NOTHING,select:true,insert:true,column_select:true},'fixture role on '+table);
  assert.deepEqual(await facts(fixtureName,'public.mp_package_store_schema'),{...NOTHING,select:true,column_select:true},'the marker is read-only for the fixture role');
  assert.equal((await db.query('SELECT pg_has_role($1,$2,$3) AS m',[fixtureName,runtimeName,'MEMBER'])).rows[0].m,true,'the fixture role is a member of the runtime role (run-store fixture script)');
  assert.equal((await db.query('SELECT pg_has_role($1,$2,$3) AS m',[runtimeName,fixtureName,'MEMBER'])).rows[0].m,false,'the runtime role is no member of the fixture role');
  assert.equal((await facts(runtimeName,'public.mp_member_sets')).insert,true,'the runtime grants of the other tables are untouched');
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[fixtureName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  // The runtime role gets 42501 on every package-store table, for reads and for writes, and cannot change a guard.
  for(const table of ALL_TABLES){
    await refused(rt.query(`SELECT 1 FROM public.${table}`),DENIED).catch(error=>{throw Error(table+' select: '+error.message);});
    await refused(rt.query(`SELECT count(*) FROM public.${table}`),DENIED);await refused(rt.query(`DELETE FROM public.${table}`),DENIED);await refused(rt.query(`TRUNCATE public.${table}`),DENIED);
    await refused(rt.transaction(()=>rt.query(`LOCK TABLE public.${table} IN ACCESS SHARE MODE`)),DENIED);
  }
  await refused(rt.query('INSERT INTO public.mp_package_exports(export_id) VALUES(gen_random_uuid())'),DENIED);
  await refused(rt.query('INSERT INTO public.mp_package_status_events(export_id,seq,status,codes,at_ms,at_utc) VALUES(gen_random_uuid(),1,$1,$2,1,$3)',['EXPORT_CANDIDATE',[],UTC]),DENIED);
  await refused(rt.query('INSERT INTO public.mp_package_store_schema VALUES(1)'),DENIED);
  await refused(rt.query('UPDATE public.mp_package_exports SET fixture=fixture'),DENIED);
  await refused(rt.query('ALTER TABLE public.mp_package_exports DISABLE TRIGGER mp_package_exports_no_change'),DENIED);
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.mp_package_store_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),DENIED);
  await refused(rt.query("SET session_replication_role = 'replica'"),DENIED);
  await refused(rt.query('DROP TABLE public.mp_package_exports'),DENIED);
  // The fixture role cannot edit, truncate or change the extension either.
  await refused(fx.query('UPDATE public.mp_package_exports SET fixture=fixture'),DENIED);await refused(fx.query('DELETE FROM public.mp_package_status_events'),DENIED);
  await refused(fx.query('TRUNCATE public.mp_package_exports'),DENIED);await refused(fx.query('INSERT INTO public.mp_package_store_schema VALUES(2)'),DENIED);
  await refused(fx.query('ALTER TABLE public.mp_package_exports DISABLE TRIGGER ALL'),DENIED);await refused(fx.query("SET session_replication_role = 'replica'"),DENIED);
  assert.equal((await fx.query('SELECT version FROM public.mp_package_store_schema')).rows[0].version,1,'the fixture role reads the marker');
  // The inspection passes for both roles ...
  const ok=await inspectMpPackageStore(db,{runtimeRole:runtimeName,fixtureRole:fixtureName});assert.equal(ok.ok,true,ok.failures.join());
  assert.equal(ok.facts.runtime_role.tables.length,11);assert.deepEqual(ok.facts.runtime_role.privileged_members,[]);assert.equal(ok.facts.runtime_reaches_fixture,false);
  assert.equal(ok.facts.fixture_role.tables.length,11);
  // ... and names every violation (each case is a rolled-back tamper).
  const seeded=async(statements,options)=>probe(db,async()=>{for(const statement of statements)await db.query(statement);return inspectMpPackageStore(db,options);});
  const both={runtimeRole:runtimeName,fixtureRole:fixtureName};
  const cases=[
    ['runtime SELECT',['GRANT SELECT ON TABLE public.mp_package_exports TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_exports:SELECT'],
    ['runtime INSERT on the files',['GRANT INSERT ON TABLE public.mp_package_files TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_files:INSERT'],
    ['runtime SELECT on the marker',['GRANT SELECT ON TABLE public.mp_package_store_schema TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_store_schema:SELECT'],
    ['runtime UPDATE',['GRANT UPDATE ON TABLE public.mp_package_exports TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_exports:UPDATE'],
    ['runtime TRUNCATE',['GRANT TRUNCATE ON TABLE public.mp_package_blobs TO '+runtimeName],both,'RUNTIME_ROLE_TRUNCATE_PRIVILEGE:mp_package_blobs'],
    ['runtime TRIGGER',['GRANT TRIGGER ON TABLE public.mp_package_attempts TO '+runtimeName],both,'RUNTIME_ROLE_TRIGGER_PRIVILEGE:mp_package_attempts'],
    ['runtime REFERENCES',['GRANT REFERENCES ON TABLE public.mp_package_exports TO '+runtimeName],both,'RUNTIME_ROLE_REFERENCES_PRIVILEGE:mp_package_exports'],
    ['runtime column SELECT',['GRANT SELECT (export_id) ON TABLE public.mp_package_exports TO '+runtimeName],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_exports:SELECT'],
    ['runtime SELECT through PUBLIC',['GRANT SELECT ON TABLE public.mp_package_validations TO PUBLIC'],both,'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_validations:SELECT'],
    ['runtime SELECT through a NOINHERIT member',['CREATE ROLE ps_holder NOLOGIN','CREATE ROLE ps_noinherit NOLOGIN NOINHERIT','GRANT ps_holder TO ps_noinherit','GRANT SELECT ON TABLE public.mp_package_exports TO ps_holder'],
      {runtimeRole:'ps_noinherit'},'RUNTIME_ROLE_WRITE_PRIVILEGE:mp_package_exports:SELECT'],
    ['runtime made a member of the fixture role',['REVOKE '+runtimeName+' FROM '+fixtureName,'GRANT '+fixtureName+' TO '+runtimeName],both,'RUNTIME_ROLE_REACHES_FIXTURE_ROLE'],
    ['runtime role is the fixture role',[],{runtimeRole:fixtureName,fixtureRole:fixtureName},'RUNTIME_ROLE_REACHES_FIXTURE_ROLE'],
    ['runtime owns a table',['ALTER TABLE public.mp_package_exports OWNER TO '+runtimeName],both,'RUNTIME_ROLE_OWNS:mp_package_exports'],
    ['fixture UPDATE',['GRANT UPDATE ON TABLE public.mp_package_exports TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_package_exports:UPDATE'],
    ['fixture column UPDATE',['GRANT UPDATE (fixture) ON TABLE public.mp_package_exports TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_package_exports:UPDATE'],
    ['fixture DELETE on the status events',['GRANT DELETE ON TABLE public.mp_package_status_events TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_package_status_events:DELETE'],
    ['fixture TRUNCATE',['GRANT TRUNCATE ON TABLE public.mp_package_files TO '+fixtureName],both,'FIXTURE_ROLE_TRUNCATE_PRIVILEGE:mp_package_files'],
    ['fixture TRIGGER',['GRANT TRIGGER ON TABLE public.mp_package_blobs TO '+fixtureName],both,'FIXTURE_ROLE_TRIGGER_PRIVILEGE:mp_package_blobs'],
    ['fixture REFERENCES',['GRANT REFERENCES ON TABLE public.mp_package_exports TO '+fixtureName],both,'FIXTURE_ROLE_REFERENCES_PRIVILEGE:mp_package_exports'],
    ['fixture INSERT on the marker',['GRANT INSERT ON TABLE public.mp_package_store_schema TO '+fixtureName],both,'FIXTURE_ROLE_WRITE_PRIVILEGE:mp_package_store_schema:INSERT'],
    ['fixture INSERT revoked',['REVOKE INSERT ON TABLE public.mp_package_exports FROM '+fixtureName],both,'FIXTURE_ROLE_PRIVILEGE_MISSING:mp_package_exports:INSERT'],
    ['fixture SELECT revoked on the marker',['REVOKE SELECT ON TABLE public.mp_package_store_schema FROM '+fixtureName],both,'FIXTURE_ROLE_PRIVILEGE_MISSING:mp_package_store_schema:SELECT'],
    ['fixture SELECT revoked on the run store',['REVOKE SELECT ON TABLE public.mp_research_runs FROM '+fixtureName],both,'FIXTURE_ROLE_RUN_STORE_UNREADABLE:mp_research_runs'],
    ['fixture owns a table',['ALTER TABLE public.mp_package_trace_records OWNER TO '+fixtureName],both,'FIXTURE_ROLE_OWNS:mp_package_trace_records'],
    ['fixture is a superuser',['ALTER ROLE '+fixtureName+' SUPERUSER'],both,'FIXTURE_ROLE_SUPERUSER'],
    ['fixture may create in public',['GRANT CREATE ON SCHEMA public TO '+fixtureName],both,'FIXTURE_ROLE_SCHEMA_CREATE']];
  for(const [label,statements,options,failure] of cases){
    const report=await seeded(statements,options);
    assert.equal(report.ok,false,label);assert.ok(report.failures.includes(failure),label+': '+report.failures.join());
  }
  assert.equal((await inspectMpPackageStore(db,both)).ok,true,'the inspection leaves no trace of the tampers');
  assert.equal((await classifyMpPackageStore(db)).state,'INSTALLED');
});

test('grant scripts: the package fixture script refuses with nothing left behind (runtime role reaching the fixture role or a table, missing store, no run-store read, bad fixture role, running worker)',async()=>{
  const name=await clone('grantscripts');
  const target=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:2})));
  const role=async(label,attributes='NOSUPERUSER NOCREATEDB NOCREATEROLE')=>{const value='robot_ps_'+label+'_'+randomUUID().replaceAll('-','').slice(0,12);extraRoles.push(value);
    await admin.query('CREATE ROLE '+value+' LOGIN '+attributes+rolePasswordClause());return value;};
  const runtime=await role('gr'),fixture=await role('gf'),badFixture=await role('gb','SUPERUSER');
  const acl=async()=>(await target.query(`SELECT string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname) d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0].d;
  // not installed: the package store is absent
  const before=await acl();
  await assert.rejects(target.query(await packageFixtureScript(runtime,fixture)),/The multi-Pine package store is not installed \(table mp_package_blobs missing\)/);
  assert.equal(await acl(),before);
  await migrateMpPackageStore(target);
  await target.query(await grantScript(runtime));
  // the fixture role has no run-store read yet
  await assert.rejects(target.query(await packageFixtureScript(runtime,fixture)),/Fixture role .* lacks SELECT on mp_research_runs; apply scripts\/grant-postgres-mp-fixture.sql first/);
  await target.query(await runFixtureScript(runtime,fixture));
  const afterRun=await acl();
  // bad fixture role (superuser), unknown roles, equal roles, a running worker
  await assert.rejects(target.query(await packageFixtureScript(runtime,badFixture)),/must be NOSUPERUSER/);
  await assert.rejects(target.query(await packageFixtureScript(runtime,'no_such_role_ps')),/Fixture role no_such_role_ps does not exist/);
  await assert.rejects(target.query(await packageFixtureScript('no_such_role_ps',fixture)),/Runtime role no_such_role_ps does not exist/);
  await assert.rejects(target.query(await packageFixtureScript(runtime,runtime)),/must differ/);
  const holder=new PostgresDatabase({connectionString:urlOf(name)});
  try{await holder.runtimeLock();await assert.rejects(target.query(await packageFixtureScript(runtime,fixture)),/Stop every PostgreSQL API and worker/);}finally{await holder.close();}
  assert.equal(await acl(),afterRun,'every refusal rolled back');
  // the runtime role already reaching a package table (the runtime grant script was not applied after the install, or a hostile grant) is refused
  await target.query(`GRANT SELECT ON TABLE public.mp_package_files TO ${runtime}`);
  await assert.rejects(target.query(await packageFixtureScript(runtime,fixture)),/Runtime role .* can still reach internal table mp_package_files; apply scripts\/grant-postgres-runtime.sql first/);
  await target.query(`REVOKE SELECT ON TABLE public.mp_package_files FROM ${runtime}`);
  // the runtime role a member of the fixture role is refused before any grant (PostgreSQL refuses a circular membership, so the intended one is removed first)
  await target.query(`REVOKE ${runtime} FROM ${fixture}`);await target.query(`GRANT ${fixture} TO ${runtime}`);
  await assert.rejects(target.query(await packageFixtureScript(runtime,fixture)),/Runtime role .* can reach fixture role/);
  await target.query(`REVOKE ${fixture} FROM ${runtime}`);await target.query(`GRANT ${runtime} TO ${fixture}`);
  await target.query(await packageFixtureScript(runtime,fixture));
  const report=await inspectMpPackageStore(target,{runtimeRole:runtime,fixtureRole:fixture});
  assert.equal(report.ok,true,report.failures.join());
});

/* ---- 5. insert-only (QR002), SERIALIZABLE only (QR003) ---- */

test('insert-only (QR002, T-K4): UPDATE, DELETE and TRUNCATE are refused at both layers on every table; the replication role cannot skip a guard; no row changes',async()=>{
  await fullExport();
  const before=await allDigests(db);
  for(const table of ALL_TABLES)assert.ok(before[table].n>0,table+' holds a row');
  const column={mp_package_store_schema:'version',mp_package_blobs:'size',mp_package_exports:'created_at',mp_package_files:'bytes',mp_package_status_events:'at_ms',mp_package_attempts:'validated_at_ms',
    mp_package_validations:'validated_at_ms',mp_package_compile_records:'compiled_at_ms',mp_package_evidence_records:'recorded_at_ms',mp_package_clearances:'recorded_at_ms',mp_package_trace_records:'recorded_at_ms'};
  assert.deepEqual(Object.keys(column).sort(),[...ALL_TABLES].sort());
  // layer 1 (privilege): neither the runtime role nor the fixture role holds UPDATE, DELETE or TRUNCATE on a package-store table (the runtime role not even SELECT)
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
    // the fixture role, once it holds the privilege (granted inside a rolled-back transaction), meets the same guard
    for(const statement of [`UPDATE public.${table} SET ${column[table]}=${column[table]}`,`DELETE FROM public.${table}`]){
      const code=await probe(db,async()=>{
        await db.query(`GRANT UPDATE,DELETE ON TABLE public.${table} TO ${fixtureName}`);
        await db.query('SET LOCAL ROLE '+fixtureName);
        try{await db.query(statement);return null;}catch(error){return error.code;}
      });
      assert.equal(code,QR002,'fixture role with the privilege: '+statement);
    }
  }
  // an upsert or a MERGE that would rewrite a stored row meets the UPDATE guard
  await refused(dl.query('INSERT INTO public.mp_package_exports SELECT * FROM public.mp_package_exports ON CONFLICT (export_id) DO UPDATE SET fixture=excluded.fixture'),QR002);
  await refused(dl.query('MERGE INTO public.mp_package_exports t USING (SELECT export_id FROM public.mp_package_exports LIMIT 1) s ON t.export_id=s.export_id WHEN MATCHED THEN UPDATE SET fixture=true'),QR002);
  // an UPDATE that matches no row fires no row trigger and changes nothing (documented, harmless)
  assert.equal((await dl.query(`UPDATE public.mp_package_exports SET fixture=true WHERE gate_version='no-such-gate-at-all'`)).rowCount,0);
  assert.deepEqual(await allDigests(db),before,'no refusal changed a row');
  assert.ok((await guardRows(db)).every(item=>item.tgenabled==='A'));
});

test('SERIALIZABLE only (QR003): an INSERT into any package-store table under READ COMMITTED or REPEATABLE READ is refused, whatever the other guards say',async()=>{
  const statements={
    mp_package_store_schema:['INSERT INTO public.mp_package_store_schema VALUES(1)',[]],
    mp_package_blobs:['INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,0,$2)',[sha(Buffer.alloc(0)),Buffer.alloc(0)]],
    mp_package_exports:['INSERT INTO public.mp_package_exports(export_id) VALUES(gen_random_uuid())',[]],
    mp_package_files:['INSERT INTO public.mp_package_files(export_id,path,sha256,bytes) VALUES(gen_random_uuid(),$1,$2,0)',['inputs.json',sha('x')]],
    mp_package_status_events:['INSERT INTO public.mp_package_status_events(export_id,seq,status,codes,at_ms,at_utc) VALUES(gen_random_uuid(),1,$1,$2,1,$3)',['EXPORT_CANDIDATE',[],UTC]],
    mp_package_attempts:['INSERT INTO public.mp_package_attempts(export_id,attempt_no) VALUES(gen_random_uuid(),1)',[]],
    mp_package_validations:['INSERT INTO public.mp_package_validations(export_id) VALUES(gen_random_uuid())',[]],
    mp_package_compile_records:['INSERT INTO public.mp_package_compile_records(export_id,ordinal) VALUES(gen_random_uuid(),1)',[]],
    mp_package_evidence_records:['INSERT INTO public.mp_package_evidence_records(export_id,ordinal) VALUES(gen_random_uuid(),1)',[]],
    mp_package_clearances:['INSERT INTO public.mp_package_clearances(export_id,ordinal) VALUES(gen_random_uuid(),1)',[]],
    mp_package_trace_records:['INSERT INTO public.mp_package_trace_records(export_id,path) VALUES(gen_random_uuid(),$1)',['quant-data/equity.csv']]};
  assert.deepEqual(Object.keys(statements).sort(),[...ALL_TABLES].sort());
  for(const [table,[statement,params]] of Object.entries(statements)){
    for(const isolation of ['READ COMMITTED','REPEATABLE READ']){
      await assert.rejects(db.transaction(()=>db.query(statement,params),{isolation}),error=>error.code===QR003,table+' under '+isolation);
      if(table!==MARKER_TABLE)await assert.rejects(fx.transaction(()=>fx.query(statement,params),{isolation}),error=>error.code===QR003,table+' as the fixture role under '+isolation);
    }
  }
  // a valid export under REPEATABLE READ is refused at its first insert and nothing is stored
  const {two}=await sharedRuns(),built=buildExport(two);
  const before=await allDigests(db);
  await assert.rejects(fx.transaction(()=>writeExport(fx,built),{isolation:'REPEATABLE READ'}),error=>error.code===QR003);
  assert.deepEqual(await allDigests(db),before);
});

/* ---- 6. the export: run guard, keys, completeness and the file rules ---- */

test('export guard: the run is read by SELECT and every precondition is refused with QR004 naming mp_package_exports_guard',async()=>{
  const {two,three}=await sharedRuns();
  const good=buildExport(two);
  assert.equal(await attempt(fx,()=>writeExport(fx,good)),null,'a complete export of a finished run is accepted');
  const other=await store.createUser({email:'ps-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const refusals=[
    ['run row missing',buildExport({...two,run_id:randomUUID()})],
    ['another owner',buildExport({...two,owner_id:other.id})],
    ['another Bot',buildExport({...two,bot_id:other.id})],
    ['another pine_count (3 for a run of 2)',buildExport(two,{pineCount:3})],
    ['another pine_count (2 for a run of 3)',buildExport(three,{pineCount:2})]];
  for(const [label,built] of refusals)expectGuard(await attempt(fx,()=>writeExport(fx,built)),G.exports,label);
  assert.equal(await attempt(fx,()=>writeExport(fx,buildExport(three))),null,'a run of three members takes an export of three');
  // the run must be SUCCEEDED
  for(const path of ['ADMITTED','RUNNING','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']){
    const row=await newRun({path});
    expectGuard(await attempt(fx,()=>writeExport(fx,buildExport(row))),G.exports,'run last event '+path);
  }
  // the result must say holdout_evaluated true and completion_reason RESEARCH_CANDIDATE_PENDING_ACCEPTANCE
  const results=[
    ['holdout_evaluated false',result=>{result.holdout_evaluated=false;}],
    ['holdout_evaluated the string true',result=>{result.holdout_evaluated='true';}],
    ['holdout_evaluated null',result=>{result.holdout_evaluated=null;}],
    ['holdout_evaluated missing',result=>{delete result.holdout_evaluated;}],
    ['completion_reason CANDIDATE_FAILED_CHECKS',result=>{result.completion_reason='CANDIDATE_FAILED_CHECKS';}],
    ['completion_reason lower case',result=>{result.completion_reason='research_candidate_pending_acceptance';}],
    ['completion_reason a list',result=>{result.completion_reason=['RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'];}],
    ['completion_reason missing',result=>{delete result.completion_reason;}]];
  for(const [label,mutate] of results){
    const row=await newRun({mutate});
    expectGuard(await attempt(fx,()=>writeExport(fx,buildExport(row))),G.exports,label);
  }
  // the guard reads the real run store, whatever a session TEMP table named like it holds
  const row=await newRun({path:'RUNNING'});
  const shadowed=await attempt(fx,async()=>{
    await fx.query('CREATE TEMP TABLE mp_research_run_events (run_id uuid, seq integer, status text, at_ms bigint, reason_code text, result jsonb, result_hash text) ON COMMIT DROP');
    await fx.query('CREATE TEMP TABLE mp_research_runs (run_id uuid, owner_id text, bot_id text, pine_count smallint, contract_version text) ON COMMIT DROP');
    await fx.query(`INSERT INTO pg_temp.mp_research_runs VALUES($1,$2,$3,2,'ql3a-research-job-multi-v1')`,[row.run_id,row.owner_id,row.bot_id]);
    await fx.query(`INSERT INTO pg_temp.mp_research_run_events VALUES($1,9,'SUCCEEDED',1,NULL,'{"holdout_evaluated":true,"completion_reason":"RESEARCH_CANDIDATE_PENDING_ACCEPTANCE"}',NULL)`,[row.run_id]);
    await writeExport(fx,buildExport(row));
  });
  expectGuard(shadowed,G.exports,'a TEMP table named like the run store');
  // the runtime role cannot write an export at all
  await refused(rt.transaction(()=>insertExport(rt,buildExport(two).row)),DENIED);
});

test('export keys and checks: one export per (owner, run), the row ties to its binding, the mode is MULTI_PINE and the fixture flag true',async()=>{
  const run=await newRun({count:2});
  const built=buildExport(run);
  await commit(fx,built);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_package_exports WHERE run_id=$1',[run.run_id])).rows[0].n,1);
  // a second build for the same run is a different export_id and meets UNIQUE (owner_id, run_id)
  const second=buildExport(run);
  expectConstraint(await attempt(fx,()=>writeExport(fx,second)),UNIQUE_VIOLATION,'mp_package_exports_owner_run_key','second export of one run');
  // the same export_id twice meets the primary key
  expectGuard(await attempt(fx,async()=>{await insertExport(fx,{...built.row,run_id:randomUUID()});}),G.exports,'the run guard fires first for a run that is not stored');
  // checks, each with the run guard out of the way by using a run of its own that passes
  const fresh=await newRun({count:2});
  const cases=[
    ['mode ONE_PINE',{mode:'ONE_PINE',binding:{...buildExport(fresh).row.binding,mode:'ONE_PINE'}},CHECK_VIOLATION,'mp_package_exports_mode_check'],
    ['fixture false',{fixture:false,binding:{...buildExport(fresh).row.binding,fixture:false}},CHECK_VIOLATION,'mp_package_exports_fixture_check'],
    ['binding of another owner',{binding:{...buildExport(fresh).row.binding,owner_id:'someone-else'}},CHECK_VIOLATION,'mp_package_exports_binding_ties_check'],
    ['binding of another run',{binding:{...buildExport(fresh).row.binding,run_id:randomUUID()}},CHECK_VIOLATION,'mp_package_exports_binding_ties_check'],
    ['binding of another mode',{binding:{...buildExport(fresh).row.binding,mode:'ONE_PINE'}},CHECK_VIOLATION,'mp_package_exports_binding_ties_check'],
    ['binding without created_at',{binding:(({created_at,...rest})=>rest)(buildExport(fresh).row.binding)},CHECK_VIOLATION,'mp_package_exports_binding_ties_check'],
    ['binding created_at different',{binding:{...buildExport(fresh).row.binding,created_at:'2026-10-20T10:00:01Z'}},CHECK_VIOLATION,'mp_package_exports_binding_ties_check'],
    ['binding pine_count different',{binding:{...buildExport(fresh).row.binding,pine_count:3}},CHECK_VIOLATION,'mp_package_exports_binding_ties_check'],
    ['binding not an object',{binding:'[]'},CHECK_VIOLATION,'mp_package_exports_binding_check'],
    ['b0 not an object',{b0:'[]'},CHECK_VIOLATION,'mp_package_exports_b0_check'],
    ['library_versions not an object',{library_versions:'[]'},CHECK_VIOLATION,'mp_package_exports_library_versions_check'],
    ['gate_version empty',{gate_version:''},CHECK_VIOLATION,'mp_package_exports_gate_version_check'],
    ['package_hash not hex',{package_hash:'XYZ'},CHECK_VIOLATION,'mp_package_exports_package_hash_check'],
    ['binding_hash upper case',{binding_hash:sha('b').toUpperCase()},CHECK_VIOLATION,'mp_package_exports_binding_hash_check'],
    ['created_at negative',{created_at:-1},CHECK_VIOLATION,'mp_package_exports_created_at_check'],
    ['created_at_utc malformed',{created_at_utc:'2026-10-20 10:00:00',binding:{...buildExport(fresh).row.binding,created_at:'2026-10-20 10:00:00'}},CHECK_VIOLATION,'mp_package_exports_created_at_utc_check']];
  for(const [label,over,code,constraint] of cases){
    const found=await attempt(fx,()=>writeExport(fx,buildExport(fresh,{over})));
    assert.ok(found,label+': accepted');assert.equal(found.code,code,label+': '+found.message);
    if(constraint)assert.equal(found.constraint,constraint,label+': '+found.message);
  }
});

test('export completeness (10 + 3 * pine_count): the file set, the path CHECK, the ordinal guard, the 16 MiB cap and the deferred check',async()=>{
  const {two,three}=await sharedRuns();
  // the layout the renderer writes is the layout of the CHECK, for both member counts
  for(const [source,count] of [[two,2],[three,3]]){
    const built=buildExport(source);
    assert.equal(built.files.length,10+3*count);assert.equal(built.files.length,multiPackageFileCount(count));
    assert.equal(await attempt(fx,()=>writeExport(fx,built)),null,count+' members: all '+built.files.length+' files');
    // one file short
    expectGuard(await attempt(fx,()=>writeExport(fx,built,{files:built.files.slice(0,-1)})),G.complete,count+' members: one file short');
    expectGuard(await attempt(fx,()=>writeExport(fx,built,{files:built.files.filter(file=>file.path!=='quant-data/manifest.json')})),G.complete,count+' members: no manifest');
    expectGuard(await attempt(fx,()=>writeExport(fx,built,{files:[]})),G.complete,count+' members: no file at all');
    expectGuard(await attempt(fx,()=>writeExport(fx,built,{files:built.files.filter(file=>!file.path.includes('/1/'))})),G.complete,count+' members: member 1 missing');
    // no seq 1 event
    expectGuard(await attempt(fx,()=>writeExport(fx,built,{status:false})),G.complete,count+' members: no EXPORT_CANDIDATE event');
  }
  // the member files of a two-member export cannot name member 3, and a three-member layout is not a two-member one
  const twoBuilt=buildExport(two),threeBuilt=buildExport(three);
  const extra=threeBuilt.files.filter(file=>file.path.includes('/3/'));
  assert.equal(extra.length,3);
  for(const file of extra){
    const found=await attempt(fx,async()=>{
      for(const item of twoBuilt.files)await insertBlob(fx,item);await insertBlob(fx,file);
      await insertExport(fx,twoBuilt.row);for(const item of twoBuilt.files)await insertFile(fx,twoBuilt.id,item);await insertFile(fx,twoBuilt.id,file);
    });
    expectGuard(found,G.files,'a two-member export with '+file.path);
  }
  // paths outside the layout meet the CHECK with its own name
  for(const path of ['indicator.pine','inputs.JSON','../inputs.json','/inputs.json','inputs.json ','members/0/indicator.pine','members/4/indicator.pine','members/1/indicator.txt','members/1/extra/indicator.pine',
    'members/10/indicator.pine','quant-data/members/1/parity.pine','quant-data/members/4/parity.json','quant-data/other.json','quant-data/equity.json','quant-data/manifest.csv','','members//indicator.pine',
    'inputs.json\n','setup-guide.md\nx']){
    const found=await attempt(fx,async()=>{
      for(const item of twoBuilt.files)await insertBlob(fx,item);
      await insertExport(fx,twoBuilt.row);await insertFile(fx,twoBuilt.id,twoBuilt.files[0],{path});
    });
    expectConstraint(found,CHECK_VIOLATION,'mp_package_files_path_check','path '+JSON.stringify(path));
  }
  // one row per path
  expectConstraint(await attempt(fx,async()=>{
    for(const item of twoBuilt.files)await insertBlob(fx,item);
    await insertExport(fx,twoBuilt.row);await insertFile(fx,twoBuilt.id,twoBuilt.files[0]);await insertFile(fx,twoBuilt.id,twoBuilt.files[0]);
  }),UNIQUE_VIOLATION,'mp_package_files_pkey','the same path twice');
  // a file needs its blob with the same hash and size
  const found=await attempt(fx,async()=>{
    for(const item of twoBuilt.files)await insertBlob(fx,item);
    await insertExport(fx,twoBuilt.row);await insertFile(fx,twoBuilt.id,twoBuilt.files[0],{bytes:twoBuilt.files[0].bytes+1});
  });
  expectConstraint(found,FK_VIOLATION,'mp_package_files_blob_fkey','a file naming a blob with another size');
  expectConstraint(await attempt(fx,async()=>{
    await insertExport(fx,twoBuilt.row);await insertFile(fx,twoBuilt.id,twoBuilt.files[0]);
  }),FK_VIOLATION,'mp_package_files_blob_fkey','a file without its blob');
  // blob rules: hash and size are checked by the database
  const blob=Buffer.from('blob rules');
  expectConstraint(await attempt(fx,()=>fx.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3)',[sha('other'),blob.length,blob])),CHECK_VIOLATION,'mp_package_blobs_hash_content_check','a blob whose hash is not the SHA-256 of its content');
  expectConstraint(await attempt(fx,()=>fx.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3)',[sha(blob),blob.length+1,blob])),CHECK_VIOLATION,'mp_package_blobs_size_content_check','a blob whose size is not its length');
  expectConstraint(await attempt(fx,()=>fx.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3)',['ABC',blob.length,blob])),CHECK_VIOLATION,'mp_package_blobs_hash_content_check','a blob hash that is not lower-case hex (its content hash check sorts first)');
  // the files of one export may not exceed 16 MiB in total (one 9 MiB blob serves two paths)
  const big=Buffer.alloc(9*1024*1024,7),bigFile={path:'quant-data/trades.csv',content:big,sha256:sha(big),bytes:big.length};
  const oversize=await attempt(fx,async()=>{
    await insertBlob(fx,bigFile);await insertExport(fx,twoBuilt.row);
    await insertFile(fx,twoBuilt.id,bigFile);await insertFile(fx,twoBuilt.id,bigFile,{path:'quant-data/decisions.csv'});
  });
  expectGuard(oversize,G.files,'two 9 MiB files');
  const fits=await attempt(fx,async()=>{
    await insertBlob(fx,bigFile);await insertExport(fx,twoBuilt.row);await insertFile(fx,twoBuilt.id,bigFile);
  });
  assert.ok(fits&&fits.constraint===G.complete,'one 9 MiB file is under the cap (only completeness is missing): '+JSON.stringify(fits));
  // a file added after the first status event is refused
  const late=await attempt(fx,async()=>{
    for(const item of twoBuilt.files)await insertBlob(fx,item);
    await insertExport(fx,twoBuilt.row);for(const item of twoBuilt.files.slice(0,-1))await insertFile(fx,twoBuilt.id,item);
    await insertStatus(fx,twoBuilt.id,1,'EXPORT_CANDIDATE');await insertFile(fx,twoBuilt.id,twoBuilt.files.at(-1));
  });
  expectGuard(late,G.files,'a file after the first status event');
  // a file of an export that does not exist
  expectGuard(await attempt(fx,async()=>{await insertBlob(fx,twoBuilt.files[0]);await insertFile(fx,randomUUID(),twoBuilt.files[0]);}),G.files,'a file without an export row');
});

/* ---- 7. the status graph, the attempts and the validation record ---- */

const RETRYABLE='BI_PARITY_EVIDENCE_MISSING',HARD='BI_FIXED_INPUT_CHANGED';

test('status graph: seq 1 EXPORT_CANDIDATE, one event per attempt, EXPORT_INTERNAL only after a passing attempt and its validation row; no EXPORT_VALIDATED exists; nothing follows a terminal status',async()=>{
  const {two}=await sharedRuns();
  const flow=(steps)=>attempt(fx,async()=>{const built=buildExport(two);await writeExport(fx,built);await steps(built);});
  const S=G.status;
  // the accepted paths
  assert.equal(await flow(async built=>{await internalAt(fx,built,1,2);}),null,'pass at once');
  assert.equal(await flow(async built=>{await failAt(fx,built,1,2);await internalAt(fx,built,2,3);}),null,'one retryable failure, then a pass');
  assert.equal(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD],status:'EXPORT_REFUSED'});}),null,'a non-retryable failure is refused at once');
  assert.equal(await flow(async built=>{
    for(let n=1;n<=4;n++)await failAt(fx,built,n,n+1);
    await failAt(fx,built,5,6,{status:'EXPORT_REFUSED',eventCodes:[RETRYABLE,'BI_ATTEMPTS_EXHAUSTED']});
  }),null,'five retryable failures end EXPORT_REFUSED with BI_ATTEMPTS_EXHAUSTED');
  assert.equal(await flow(async built=>{await failAt(fx,built,1,2,{codes:[RETRYABLE,HARD],status:'EXPORT_REFUSED'});}),null,'mixed codes: a non-retryable code makes it final');
  // EXPORT_VALIDATED does not exist: the CHECK refuses it after a failed attempt, the guard after a passing one
  // the codes CHECK sorts before the status CHECK, so it names the refusal; the status CHECK text is pinned below
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false});await insertStatus(fx,built.id,2,'EXPORT_VALIDATED',{attempt_no:1});}),CHECK_VIOLATION,'mp_package_status_events_codes_status_check','EXPORT_VALIDATED after a failure');
  expectGuard(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id);await insertStatus(fx,built.id,2,'EXPORT_VALIDATED',{attempt_no:1});}),S,'EXPORT_VALIDATED after a pass');
  expectGuard(await flow(async built=>{await insertStatus(fx,built.id,2,'EXPORT_VALIDATED',{attempt_no:1});}),S,'EXPORT_VALIDATED with no attempt');
  // edges
  expectGuard(await attempt(fx,async()=>{const built=buildExport(two);await writeExport(fx,built,{status:false});await insertStatus(fx,built.id,1,'EXPORT_INTERNAL');}),S,'first event not EXPORT_CANDIDATE');
  expectGuard(await attempt(fx,async()=>{const built=buildExport(two);await writeExport(fx,built,{status:false});await insertStatus(fx,built.id,2,'EXPORT_CANDIDATE');}),S,'first event at seq 2');
  expectGuard(await flow(async built=>{await insertStatus(fx,built.id,1,'EXPORT_CANDIDATE');}),S,'a second seq 1');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertStatus(fx,built.id,3,'EXPORT_INTERNAL',{attempt_no:1});}),S,'a gap in seq');
  expectGuard(await flow(async built=>{await insertStatus(fx,built.id,2,'EXPORT_REFUSED',{codes:[HARD],attempt_no:1});}),S,'an event with no attempt');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertStatus(fx,built.id,2,'EXPORT_INTERNAL',{attempt_no:null});}),S,'a later event without attempt_no');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertStatus(fx,built.id,2,'EXPORT_INTERNAL',{attempt_no:2});}),S,'an event naming another attempt');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertStatus(fx,built.id,2,'EXPORT_INTERNAL',{attempt_no:1});}),S,'EXPORT_INTERNAL without the validation row');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false});await insertStatus(fx,built.id,2,'EXPORT_INTERNAL',{attempt_no:1});}),S,'EXPORT_INTERNAL after a failed attempt');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertStatus(fx,built.id,2,'EXPORT_CANDIDATE',{attempt_no:1});}),S,'EXPORT_CANDIDATE after a passing attempt');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertStatus(fx,built.id,2,'EXPORT_REFUSED',{codes:[RETRYABLE],attempt_no:1});}),S,'EXPORT_REFUSED after a passing attempt');
  // retry rules
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{status:'EXPORT_REFUSED'});}),S,'EXPORT_REFUSED after a retryable failure that is not the fifth');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD]});}),S,'EXPORT_CANDIDATE after a non-retryable failure');
  expectGuard(await flow(async built=>{for(let n=1;n<=4;n++)await failAt(fx,built,n,n+1);await failAt(fx,built,5,6);}),S,'EXPORT_CANDIDATE after the fifth failure');
  expectGuard(await flow(async built=>{for(let n=1;n<=4;n++)await failAt(fx,built,n,n+1);await failAt(fx,built,5,6,{status:'EXPORT_REFUSED'});}),S,'the fifth failure without BI_ATTEMPTS_EXHAUSTED');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD],status:'EXPORT_REFUSED',eventCodes:[HARD,'BI_ATTEMPTS_EXHAUSTED']});}),S,'BI_ATTEMPTS_EXHAUSTED on a non-fifth failure');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{eventCodes:[RETRYABLE,'BI_ATTEMPTS_EXHAUSTED']});}),S,'BI_ATTEMPTS_EXHAUSTED on a candidate event');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[RETRYABLE,'BI_REPAINT_EVIDENCE_MISSING'],eventCodes:[RETRYABLE]});}),S,'an event dropping a code of the attempt');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[RETRYABLE],eventCodes:[RETRYABLE,'BI_REPAINT_EVIDENCE_MISSING']});}),S,'an event adding a code');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD],status:'EXPORT_REFUSED',eventCodes:['BI_PARITY_EVIDENCE_MISSING']});}),S,'an event naming other codes');
  // nothing follows a terminal status
  expectGuard(await flow(async built=>{await internalAt(fx,built,1,2);await insertStatus(fx,built.id,3,'EXPORT_CANDIDATE',{attempt_no:2});}),S,'an event after EXPORT_INTERNAL');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD],status:'EXPORT_REFUSED'});await insertStatus(fx,built.id,3,'EXPORT_CANDIDATE',{attempt_no:1});}),S,'an event after EXPORT_REFUSED');
  // the status CHECKs (the guard answers first wherever it can; the CHECK is the border for what the guard lets through)
  expectConstraint(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id);await insertStatus(fx,built.id,2,'EXPORT_INTERNAL',{codes:[RETRYABLE],attempt_no:1});}),CHECK_VIOLATION,'mp_package_status_events_codes_status_check','EXPORT_INTERNAL with codes');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false,codes:[HARD]});await insertStatus(fx,built.id,2,'EXPORT_REFUSED',{codes:[],attempt_no:1});}),S,'EXPORT_REFUSED without codes');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false});await insertStatus(fx,built.id,2,'EXPORT_CANDIDATE',{codes:['bad code'],attempt_no:1});}),S,'a malformed code on an event');
  // the stored statuses can never include EXPORT_VALIDATED
  const text=await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='mp_package_status_events_status_check'");
  assert.doesNotMatch(text.rows[0].def,/EXPORT_VALIDATED/);
  // the retryable list of the database is the one of the gate module, and the clearance blockers are the candidate blockers
  assert.deepEqual((await db.query('SELECT public.mp_package_store_retryable_codes() AS codes')).rows[0].codes,[...RETRYABLE_CODES]);
  const blockers=(await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='mp_package_clearances_blocker_check'")).rows[0].def;
  assert.deepEqual([...blockers.matchAll(/'([A-Z_]+)'::text/g)].map(match=>match[1]).sort(),[...CANDIDATE_BLOCKERS].sort());
});

test('attempts: attempt_no is the count plus one, at most 5; none after a pass or a non-retryable failure; each needs the event of the one before; package_hash ties to the export',async()=>{
  const {two}=await sharedRuns();
  const flow=steps=>attempt(fx,async()=>{const built=buildExport(two);await writeExport(fx,built);await steps(built);});
  const A=G.attempts;
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,2);}),A,'attempt 2 first');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,3);}),A,'attempt 3 first');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,0);}),A,'attempt 0');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false});await insertAttempt(fx,built,2,{pass:false});}),A,'attempt 2 before the event of attempt 1');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false});await insertStatus(fx,built.id,2,'EXPORT_CANDIDATE',{codes:[RETRYABLE],attempt_no:1});await insertAttempt(fx,built,1,{pass:false});}),A,'attempt 1 twice');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{package_hash:sha('other package')});}),A,'a package_hash other than the export package_hash');
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false,codes:['BI_ATTEMPTS_EXHAUSTED']});}),A,'BI_ATTEMPTS_EXHAUSTED as an attempt code');
  expectGuard(await flow(async built=>{await internalAt(fx,built,1,2);await insertAttempt(fx,built,2);}),A,'an attempt after the terminal EXPORT_INTERNAL');
  expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD],status:'EXPORT_REFUSED'});await insertAttempt(fx,built,2);}),A,'an attempt after EXPORT_REFUSED');
  // the cap: five attempts, never a sixth
  expectGuard(await flow(async built=>{
    for(let n=1;n<=4;n++)await failAt(fx,built,n,n+1);
    await failAt(fx,built,5,6,{status:'EXPORT_REFUSED',eventCodes:[RETRYABLE,'BI_ATTEMPTS_EXHAUSTED']});
    await insertAttempt(fx,built,6,{pass:false});
  }),A,'attempt 6');
  // CHECKs: pass is exactly an empty code list, shapes
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{pass:true,codes:[RETRYABLE]});}),CHECK_VIOLATION,'mp_package_attempts_pass_check','pass with codes');
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false,codes:[]});}),CHECK_VIOLATION,'mp_package_attempts_pass_check','failure without codes');
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{pass:false,codes:['not a code']});}),CHECK_VIOLATION,'mp_package_attempts_codes_check','a malformed attempt code');
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{attempt_id:''});}),CHECK_VIOLATION,'mp_package_attempts_attempt_id_check','an empty attempt_id');
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{validator:'abc'});}),CHECK_VIOLATION,'mp_package_attempts_validator_hash_check','a malformed validator hash');
  // attempt_id is unique across exports
  const full=await fullExport();
  const taken=(await db.query('SELECT attempt_id FROM public.mp_package_attempts WHERE export_id=$1 ORDER BY attempt_no LIMIT 1',[full.id])).rows[0].attempt_id;
  expectConstraint(await flow(async built=>{await insertAttempt(fx,built,1,{attempt_id:taken});}),UNIQUE_VIOLATION,'mp_package_attempts_attempt_id_key','an attempt_id used by another export');
});

test('validation record (RD-MP-37): fixture true, mode MULTI_PINE, tied to a passing attempt of the same export with the same hashes; never in ql4c_validation',async()=>{
  const {two}=await sharedRuns();
  const flow=steps=>attempt(fx,async()=>{const built=buildExport(two);await writeExport(fx,built);await steps(built);});
  const V=G.validations;
  assert.equal(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id);}),null);
  expectGuard(await flow(async built=>{await insertValidation(fx,built,'att-none');}),V,'no attempt');
  expectGuard(await flow(async built=>{const id=await insertAttempt(fx,built,1,{pass:false});await insertValidation(fx,built,id);}),V,'a failed attempt');
  expectGuard(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id,{package_hash:sha('other')});}),V,'another package_hash');
  expectGuard(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id,{binding_hash:sha('other')});}),V,'another binding_hash');
  expectGuard(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id,{validator:sha('other validator')});}),V,'another validator hash');
  expectGuard(await flow(async built=>{const id=await internalAt(fx,built,1,2);await insertValidation(fx,built,id);}),V,'a validation after the terminal event');
  expectGuard(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id,{fixture:false});}),V,'fixture false (the guard ties the flag to the export)');
  expectConstraint(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id,{mode:'ONE_PINE'});}),CHECK_VIOLATION,'mp_package_validations_mode_check','mode ONE_PINE');
  expectConstraint(await flow(async built=>{const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id);await insertValidation(fx,built,id);}),UNIQUE_VIOLATION,'mp_package_validations_pkey','a second validation of one export');
  // the validation of another export's attempt is refused by the guard (no attempt of this export with that id)
  const other=await fullExport();
  const otherAttempt=(await db.query('SELECT attempt_id FROM public.mp_package_attempts WHERE export_id=$1 AND pass',[other.id])).rows[0].attempt_id;
  expectGuard(await flow(async built=>{await insertAttempt(fx,built,1);await insertValidation(fx,built,otherAttempt);}),V,'an attempt of another export');
  // the one-Pine validation table is never touched
  assert.equal((await db.query('SELECT count(*)::int n FROM public.ql4c_validation')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_exports')).rows[0].n,0);
});

/* ---- 8. candidate records ---- */

test('candidate records: compile, evidence, clearance and trace rows are accepted only while the export is an open candidate and tie to its members, files and run',async()=>{
  const {two,three}=await sharedRuns();
  const flow=(steps,source=two)=>attempt(fx,async()=>{const built=buildExport(source);await writeExport(fx,built);await steps(built);});
  // the accepted rows for both member counts
  assert.equal(await flow(built=>insertCandidateRecords(fx,built)),null,'two members');
  assert.equal(await flow(built=>insertCandidateRecords(fx,built),three),null,'three members');
  // compile records: one per member indicator.pine, bound to that file's SHA-256
  const C=G.compile;
  expectGuard(await flow(async built=>{await insertCompile(fx,built,3);}),C,'compile ordinal 3 of a two-member export');
  expectGuard(await flow(async built=>{await insertCompile(fx,built,1,{sha:fileOf(built,'members/2/indicator.pine').sha256});}),C,'member 1 bound to the file of member 2');
  expectGuard(await flow(async built=>{await insertCompile(fx,built,1,{sha:sha('some other bytes')});}),C,'a compile record bound to other bytes');
  expectGuard(await flow(async built=>{await insertCompile(fx,built,1,{sha:fileOf(built,'members/1/indicator.json').sha256});}),C,'a compile record bound to indicator.json');
  expectGuard(await flow(async built=>{await insertCompile(fx,built,0);}),C,'compile ordinal 0 (no member file)');
  expectGuard(await flow(async built=>{await insertCompile(fx,built,4);}),C,'compile ordinal 4');
  // evidence records: four kinds per member, no quant_baseline
  const E=G.evidence;
  expectGuard(await flow(async built=>{await insertEvidence(fx,built,3,'repaint');}),E,'evidence ordinal 3 of a two-member export');
  expectConstraint(await flow(async built=>{await insertEvidence(fx,built,1,'quant_baseline');}),CHECK_VIOLATION,'mp_package_evidence_records_kind_check','kind quant_baseline');
  expectConstraint(await flow(async built=>{await insertEvidence(fx,built,1,'repaint','XYZ');}),CHECK_VIOLATION,'mp_package_evidence_records_hash_check','evidence_hash not hex');
  expectConstraint(await flow(async built=>{await insertEvidence(fx,built,1,'repaint',sha('same'));await insertEvidence(fx,built,1,'repaint',sha('same'));}),UNIQUE_VIOLATION,'mp_package_evidence_records_unique_key','the same record twice');
  assert.equal(await flow(async built=>{await insertEvidence(fx,built,1,'repaint',sha('same'));await insertEvidence(fx,built,2,'repaint',sha('same'));}),null,'the same hash for another member is another record');
  // clearances: per (blocker, ordinal), with the evidence record of that member and kind
  const L=G.clearances;
  for(const [blocker,kind] of Object.entries(BLOCKER_KIND)){
    assert.equal(await flow(async built=>{const hashOf=await insertEvidence(fx,built,2,kind);await insertClearance(fx,built,blocker,2,hashOf);}),null,blocker);
    expectGuard(await flow(async built=>{await insertClearance(fx,built,blocker,1,sha('no evidence'));}),L,blocker+': no evidence record');
    expectGuard(await flow(async built=>{const hashOf=await insertEvidence(fx,built,1,kind);await insertClearance(fx,built,blocker,2,hashOf);}),L,blocker+': evidence of another member');
    expectGuard(await flow(async built=>{const hashOf=await insertEvidence(fx,built,1,'dataset_alignment');await insertClearance(fx,built,blocker,1,hashOf);}),L,blocker+': evidence of another kind');
    expectGuard(await flow(async built=>{const hashOf=await insertEvidence(fx,built,1,kind);await insertClearance(fx,built,blocker,1,hashOf,{run_id:randomUUID()});}),L,blocker+': another run');
    expectGuard(await flow(async built=>{const hashOf=await insertEvidence(fx,built,1,kind);await insertClearance(fx,built,blocker,3,hashOf);}),L,blocker+': ordinal 3 of a two-member export');
    expectConstraint(await flow(async built=>{const hashOf=await insertEvidence(fx,built,1,kind);await insertClearance(fx,built,blocker,1,hashOf);await insertClearance(fx,built,blocker,1,hashOf);}),UNIQUE_VIOLATION,'mp_package_clearances_pkey',blocker+': twice');
  }
  expectConstraint(await flow(async built=>{const hashOf=await insertEvidence(fx,built,1,'repaint');await insertClearance(fx,built,'SOMETHING_ELSE',1,hashOf);}),CHECK_VIOLATION,'mp_package_clearances_blocker_check','an unknown blocker');
  // trace records: the SHA-256 of that trace file, the engine hash of the run, the method of RD-MP-39
  const T=G.trace;
  expectGuard(await flow(async built=>{await insertTrace(fx,built,'quant-data/equity.csv',{sha256:sha('other bytes')});}),T,'a trace record with other bytes');
  expectGuard(await flow(async built=>{await insertTrace(fx,built,'quant-data/equity.csv',{sha256:fileOf(built,'quant-data/trades.csv').sha256});}),T,'a trace record bound to another trace file');
  expectGuard(await flow(async built=>{await insertTrace(fx,built,'quant-data/equity.csv',{run_engine_hash:sha('another engine')});}),T,'a trace record with another engine hash');
  expectConstraint(await flow(async built=>{await insertTrace(fx,built,'quant-data/equity.csv',{method:'re-evaluated'});}),CHECK_VIOLATION,'mp_package_trace_records_method_check','a method other than stored-holdout-decisions-v1');
  expectConstraint(await flow(async built=>{await insertTrace(fx,built,'quant-data/metrics.json');}),CHECK_VIOLATION,'mp_package_trace_records_path_check','a path that is not a trace file');
  expectConstraint(await flow(async built=>{await insertTrace(fx,built,'quant-data/equity.csv');await insertTrace(fx,built,'quant-data/equity.csv');}),UNIQUE_VIOLATION,'mp_package_trace_records_pkey','a trace file twice');
  // after the first terminal event every kind is refused, and so is a record for an export with no status event
  const closed=async(label,step)=>{
    expectGuard(await flow(async built=>{await internalAt(fx,built,1,2);await step(built);}),label.guard,label.name+' after EXPORT_INTERNAL');
    expectGuard(await flow(async built=>{await failAt(fx,built,1,2,{codes:[HARD],status:'EXPORT_REFUSED'});await step(built);}),label.guard,label.name+' after EXPORT_REFUSED');
    expectGuard(await attempt(fx,async()=>{const built=buildExport(two);await writeExport(fx,built,{status:false});await step(built);}),label.guard,label.name+' with no status event');
  };
  await closed({name:'compile record',guard:C},built=>insertCompile(fx,built,1));
  await closed({name:'evidence record',guard:E},built=>insertEvidence(fx,built,1,'repaint'));
  await closed({name:'trace record',guard:T},built=>insertTrace(fx,built,'quant-data/equity.csv'));
  await closed({name:'clearance',guard:L},built=>insertClearance(fx,built,'CUSTOM_REPAINT_EVIDENCE_REQUIRED',1,sha('x')));
  // a record for an export that does not exist
  expectGuard(await attempt(fx,()=>fx.query(`INSERT INTO public.mp_package_compile_records(export_id,ordinal,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,duplicate_bindings,mapping_check,
    compiled_at_ms,compiled_at_utc,operator_role,method) VALUES($1,1,$2,'v6','[]','[]',0,0,0,'[]',1,$3,'fixture','fixture-record')`,[randomUUID(),sha('x'),UTC])),C,'a compile record without an export');
  // a terminal event reads the four record tables, so a record writer that raced it conflicts (40001) instead of landing late: the writer holds the export lock,
  // the terminal transaction waits for it with a snapshot that cannot see the late row, and the serializable checker aborts one of the two.
  const built=buildExport(two);
  await commit(fx,built);
  const firstReady=gate(),release=gate();
  const writer=fx.transaction(async()=>{await insertEvidence(fx,built,1,'repaint',sha('late'));firstReady.open();await release.promise;},{isolation:'SERIALIZABLE'}).then(()=>'WRITTEN',error=>error.code);
  await firstReady.promise;
  const terminal=fx.transaction(async()=>{
    const id=await insertAttempt(fx,built,1);await insertValidation(fx,built,id);await insertStatus(fx,built.id,2,'EXPORT_INTERNAL',{attempt_no:1});
  },{isolation:'SERIALIZABLE'}).then(()=>'TERMINAL',error=>error.code);
  await new Promise(resolve=>setTimeout(resolve,500));
  release.open();
  const outcome=[await writer,await terminal];
  assert.ok(outcome.includes('40001'),'one of the two raced writers is aborted: '+outcome.join());
  assert.notDeepEqual(outcome,['WRITTEN','TERMINAL'],'a record never lands beside a terminal event that did not count it');
  const rows=(await db.query(`SELECT (SELECT count(*)::int FROM public.mp_package_evidence_records WHERE export_id=$1) evidence,
    (SELECT count(*)::int FROM public.mp_package_status_events WHERE export_id=$1 AND status='EXPORT_INTERNAL') terminal`,[built.id])).rows[0];
  assert.equal(rows.evidence+rows.terminal,1,'exactly one of the two committed');
});

/* ---- 9. the CLI, the rollback and the uninstall order ---- */

test('the CLI: install, second install, --inspect exit codes, both role checks, usage errors and rollback, on throwaway databases',async()=>{
  const cliName=await clone('cli'),cliUrl=urlOf(cliName);
  const cliDb=ser(track(new PostgresDatabase({connectionString:cliUrl,max:2})));
  const inspect=async(extra=[])=>{const result=await cli(['--inspect',...extra],cliUrl);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage error */}return {...result,report};};
  const before=await catalogDigest(cliDb);
  const absent=await inspect();assert.equal(absent.code,0,absent.stderr);assert.equal(absent.report.facts.state,'ABSENT');
  assert.deepEqual(await catalogDigest(cliDb),before,'--inspect writes nothing');
  const badRole=await inspect(['--runtime-role=no_such_role_ps']);assert.equal(badRole.code,1);assert.ok(badRole.report.failures.includes('RUNTIME_ROLE_MISSING'));
  const badFixture=await inspect(['--fixture-role=no_such_role_ps']);assert.equal(badFixture.code,1);assert.ok(badFixture.report.failures.includes('FIXTURE_ROLE_MISSING'));
  const installed=await cli([],cliUrl);assert.equal(installed.code,0,installed.stderr);
  assert.match(installed.stdout,/Multi-Pine package store ready: mp-package-store-v1-schema; state=INSTALLED; previous state=ABSENT; guards=43; runtime role not checked; fixture role not checked/);
  const second=await cli([],cliUrl);assert.equal(second.code,0,second.stderr);assert.match(second.stdout,/previous state=INSTALLED/);
  const checked=await cli(['--runtime-role='+runtimeName,'--fixture-role='+fixtureName],cliUrl);assert.equal(checked.code,0,checked.stderr);assert.match(checked.stdout,/runtime role checked; fixture role checked/);
  const settled=await inspect();assert.equal(settled.code,0,settled.stderr);assert.equal(settled.report.facts.state,'INSTALLED');assert.equal(settled.report.ok,true);
  // without the fixture grants the fixture role lacks SELECT and INSERT
  const ungranted=await inspect(['--runtime-role='+runtimeName,'--fixture-role='+fixtureName]);assert.equal(ungranted.code,1);
  assert.ok(ungranted.report.failures.includes('FIXTURE_ROLE_PRIVILEGE_MISSING:mp_package_exports:INSERT'),ungranted.report.failures.join());
  await cliDb.query(await grantScript(runtimeName));await cliDb.query(await runFixtureScript(runtimeName,fixtureName));await cliDb.query(await packageFixtureScript(runtimeName,fixtureName));
  const granted=await inspect(['--runtime-role='+runtimeName,'--fixture-role='+fixtureName]);assert.equal(granted.code,0,granted.report.failures.join());assert.equal(granted.report.ok,true);
  assert.deepEqual(granted.report.facts.runtime_role.tables.filter(item=>item.select||item.insert||item.update||item.delete),[]);
  assert.deepEqual(granted.report.facts.fixture_role.tables.filter(item=>item.table!=='mp_package_store_schema'&&!(item.select&&item.insert&&!item.update&&!item.delete)),[]);
  // a tampered install exits 1
  await cliDb.query('ALTER TABLE public.mp_package_exports DISABLE TRIGGER mp_package_exports_no_change');
  const other=await inspect();assert.equal(other.code,1);assert.equal(other.report.facts.state,'OTHER');
  const refusedInstall=await cli([],cliUrl);assert.notEqual(refusedInstall.code,0);assert.match(refusedInstall.stderr,/unexpected state OTHER/);
  await cliDb.query('ALTER TABLE public.mp_package_exports ENABLE ALWAYS TRIGGER mp_package_exports_no_change');
  assert.equal((await inspect()).code,0);
  for(const args of [['--rollback','--inspect'],['--rollback','--runtime-role=x'],['--rollback','--fixture-role=x'],['--bogus'],['--runtime-role=Bad-Name'],['--fixture-role=Bad-Name'],['--runtime-role=a','--runtime-role=b']])
    assert.notEqual((await cli(args,cliUrl)).code,0,args.join(' '));
  const rolled=await cli(['--rollback'],cliUrl);assert.equal(rolled.code,0,rolled.stderr);assert.match(rolled.stdout,/previous state=INSTALLED/);
  assert.deepEqual(await packageObjects(cliDb),NONE);
  assert.equal((await classifyMpRunStore(cliDb)).state,'INSTALLED','the run store is untouched by the package store rollback');
  const noop=await cli(['--rollback'],cliUrl);assert.equal(noop.code,0,noop.stderr);assert.match(noop.stdout,/previous state=ABSENT/);
  assert.equal((await cli([],cliUrl)).code,0);
  // a database without the run store: the install exits nonzero and writes nothing
  const bareName='robot_ps_clibare_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(bareName);
  await admin.query('CREATE DATABASE '+bareName);
  const bare=track(new PostgresDatabase({connectionString:urlOf(bareName),max:2}));await bare.migrate();
  const refusedBare=await cli([],urlOf(bareName));assert.notEqual(refusedBare.code,0);assert.match(refusedBare.stderr,/the run store must be INSTALLED/);
  assert.deepEqual(await packageObjects(bare),NONE);
});

test('rollback: empty tables are dropped completely; any row refuses it and stays; the run store and the member set are untouched and roll back after it',async()=>{
  const name=await clone('rollback');
  const target=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:4})));
  await migrateMpPackageStore(target);
  const rolled=await rollbackMpPackageStore(target);
  assert.deepEqual(rolled,{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await packageObjects(target),NONE);
  assert.equal((await classifyMpRunStore(target)).state,'INSTALLED');assert.equal((await classifyMpMemberSet(target)).state,'INSTALLED');assert.equal((await classifyBestInputsPackage(target)).state,'INSTALLED');
  assert.deepEqual(await rollbackMpPackageStore(target),{rolled_back:true,previous_state:'ABSENT'});
  // it comes back, and the whole stack leaves in order: package store, run store (member set follows)
  await migrateMpPackageStore(target);
  assert.deepEqual(await rollbackMpPackageStore(target),{rolled_back:true,previous_state:'INSTALLED'});
  assert.deepEqual(await rollbackMpRunStore(target),{rolled_back:true,previous_state:'INSTALLED'});
  assert.equal((await classifyMpRunStore(target)).state,'ABSENT');
  await assert.rejects(migrateMpPackageStore(target),/the run store must be INSTALLED, found ABSENT/);
  // with rows: the rollback is refused and nothing changes. Each kind of row refuses it alone.
  const second=await clone('rollback2');
  const live=ser(track(new PostgresDatabase({connectionString:serialOf(second),max:4})));
  await migrateMpPackageStore(live);
  const blob=Buffer.from('a lone blob');
  await live.transaction(()=>live.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3)',[sha(blob),blob.length,blob]),{isolation:'SERIALIZABLE'});
  const held=await allDigests(live),objects=await catalogDigest(live);
  await assert.rejects(rollbackMpPackageStore(live),/rollback refused; 1 record row\(s\) exist in mp_package_blobs \(no change made\)/);
  assert.deepEqual(await allDigests(live),held,'the record rows are still there');assert.deepEqual(await catalogDigest(live),objects,'nothing else changed');
  assert.equal((await classifyMpPackageStore(live)).state,'INSTALLED');
});

test('fixture role: reads and inserts a whole export; the runtime role sees nothing; the one-Pine package, run-store and member-set tables are untouched by an export',async()=>{
  const built=await fullExport();
  const counts=async()=>(await db.query(`SELECT (SELECT count(*)::int FROM public.mp_package_files WHERE export_id=$1) files,(SELECT count(*)::int FROM public.mp_package_status_events WHERE export_id=$1) events,
    (SELECT count(*)::int FROM public.mp_package_attempts WHERE export_id=$1) attempts,(SELECT count(*)::int FROM public.mp_package_validations WHERE export_id=$1) validations,
    (SELECT count(*)::int FROM public.mp_package_compile_records WHERE export_id=$1) compiles,(SELECT count(*)::int FROM public.mp_package_evidence_records WHERE export_id=$1) evidence,
    (SELECT count(*)::int FROM public.mp_package_clearances WHERE export_id=$1) clearances,(SELECT count(*)::int FROM public.mp_package_trace_records WHERE export_id=$1) traces`,[built.id])).rows[0];
  assert.deepEqual(await counts(),{files:16,events:3,attempts:2,validations:1,compiles:2,evidence:8,clearances:4,traces:3});
  assert.deepEqual((await fx.query('SELECT status FROM public.mp_package_status_events WHERE export_id=$1 ORDER BY seq',[built.id])).rows.map(row=>row.status),['EXPORT_CANDIDATE','EXPORT_CANDIDATE','EXPORT_INTERNAL']);
  // the one-Pine package tables and the run store hold nothing of this export
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_exports')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.bi_status_events')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.ql4c_validation')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.mp_research_run_events WHERE run_id=$1',[built.row.run_id])).rows[0].n,3,'the run keeps its three events');
  // the runtime role cannot read any of it
  for(const table of ALL_TABLES)await refused(rt.query(`SELECT 1 FROM public.${table} LIMIT 1`),DENIED);
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');assert.equal((await classifyBestInputsPackage(db)).state,'INSTALLED');assert.equal((await classifyMpPackageStore(db)).state,'INSTALLED');
  // the run store itself stays insert-only with an export on top of it: the export does not pin the run through a key, the run rows are protected by the run-store guards
  await refused(dl.query('DELETE FROM public.mp_research_run_events').catch(error=>{throw Object.assign(error,{code:error.code==='42501'?QR002:error.code});}),QR002);
  // the run-store rollback refuses while the run holds rows, with or without the package store
  await assert.rejects(rollbackMpRunStore(db),/rollback refused|Stop every PostgreSQL API|own transaction/);
  assert.equal((await classifyMpRunStore(db)).state,'INSTALLED');
});
