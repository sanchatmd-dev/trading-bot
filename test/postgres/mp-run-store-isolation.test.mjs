import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {QuantLibraryService} from '../../src/postgres/quant-library.js';
import {researchHistory} from '../../src/postgres/quant-research-history.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {QuantPreflightService} from '../../src/postgres/quant-preflight.js';
import {readSearchedWindows} from '../../src/postgres/selection-store.js';
import {readComparison,createComparison} from '../../src/postgres/comparison-store.js';
import {validateSpec} from '../../src/comparison/ranking.js';
import {bindQuantStorage,maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {migrateQuantComparison} from '../../src/postgres/quant-comparison-migration.js';
import {migrateQuantSelection} from '../../src/postgres/quant-selection-migration.js';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {RUN_STORE_TABLES,MARKER_TABLE,migrateMpRunStore,inspectMpRunStore} from '../../src/postgres/mp-run-store-migration.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {runOf,seedRun,hex,MINUTE,T0 as LIB_T0} from '../helpers/quant-library-fixture.mjs';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {buildMemberSet} from '../../src/multi-pine/member-set.js';
import {buildMultiResearchContract} from '../../src/multi-pine/run-contract.js';
import {RULES} from '../../src/quant-research/contract.js';
import {config} from '../../src/config.js';

// F11-01 RS-3 (root decisions I1 and I3): the BEHAVIOUR half of the run-store isolation proof, on a throwaway PostgreSQL cluster. The run store is installed
// next to every one-Pine surface a multi run could leak into (research queue, foundation, mode guards, exposure register, package, QR-3, QR-4), and labelled
// multi-Pine runs are inserted through a fixture-role connection (RS-2 has no writer yet). Each reader, worker claim, mode guard and lookup the design lists
// then runs as the real non-owner RUNTIME role, once on a database without run rows and once on a copy of the same database holding multi runs of the same
// owner, in the same order. The two transcripts must be equal, and none may contain a 42501 on a normal path. The static half is
// test/mp-run-store-static-isolation.test.js. Every row is a LABELLED FIXTURE (fixture=true, synthetic, never a research result).
const GRANT_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const FIXTURE_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const RUN_TABLES=[...RUN_STORE_TABLES],STORE_TABLES=[MARKER_TABLE,...RUN_STORE_TABLES];
const DENIED='42501',FK_VIOLATION='23503',QR004='QR004';
const UTC='2026-10-20T10:00:00Z',T0MS=1790000000000,CLOCK=LIB_T0+7_200_000+60_000;
// Fixed ids: the same run ids are asked on both databases, so a lookup that "finds" a multi run on one side shows up as a difference.
const IDS={setU:'11111111-1111-4111-8111-111111111111',setV:'22222222-2222-4222-8222-222222222222',
  admitted:'a0000000-0000-4000-8000-000000000001',running:'a0000000-0000-4000-8000-000000000002',foreign:'a0000000-0000-4000-8000-000000000003',
  oneSucceeded:'b0000000-0000-4000-8000-000000000001',oneNoValid:'b0000000-0000-4000-8000-000000000002',oneFailed:'b0000000-0000-4000-8000-000000000003',
  oneForeign:'b0000000-0000-4000-8000-000000000004',oneQueued:'b0000000-0000-4000-8000-000000000005',oneFoundation:'b0000000-0000-4000-8000-000000000006'};

let admin,templateName,runtimeName,fixtureName,env;
const databases=[],pools=[],storageRoots=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const track=pool=>{pools.push(pool);return pool;};
// Run-store and member-set writers are SERIALIZABLE (QR003 otherwise): the pools of the fixture writers default their transactions to it.
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let text=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))text=text.replaceAll(":'"+variable+"'","'"+value+"'");return text;};

/* ---- labelled fixtures: pine rows, S1 member sets and S2 run contracts (the same recipe as test/postgres/mp-run-store.test.mjs) ---- */

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const evidenceFor=(snapshot,snapshotHash,tag)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(MODEL),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});

/** One owner (also the Bot) with COUNT connected members, each a source revision, a DRAFT deployment and Bridge evidence, written by the schema owner. */
async function newWorld(target,targetStore,{count=2}={}){
  const user=await targetStore.createUser({email:'rs3-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=user;
  const ids=Array.from({length:count},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,pine:id,version:1,sourceHash:hash('source-'+id),analysis:{effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i'+(i+1)}]},dep:'dep-'+randomUUID()}));
  for(const m of specs){
    await target.query('INSERT INTO pine_sources VALUES($1,$2,$8,1,$3,$4,$5,$6,$7)',[m.pine,user.id,m.sourceHash,'Member fixture','//@version=6\nindicator("x")',JSON.stringify(m.analysis),LIB_T0,bot.id]);
    await target.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,m.sourceHash,'//@version=6\nindicator("x")',JSON.stringify(m.analysis),LIB_T0]);
    await target.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot.id]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:m.sourceHash,analysis:m.analysis}));
  for(const m of specs){
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital:CAPITAL,funding_cutoff:7,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection:{bridge:{atr_multiplier:2,rr:1.5},bindings:[]},market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:m.sourceHash,
      instruction_versions:{template:'fixture'},artifact_hash:hash('artifact-'+m.pine)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n);
    await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$7,$3,1,$4,$5,'DRAFT',$6)",
      [m.dep,user.id,m.pine,JSON.stringify(snapshot),snapshotHash,LIB_T0,bot.id]);
    await target.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),LIB_T0]);
  }
  return {id:user.id,bot:bot.id,specs,exit:'bridge-exit-v2',target};
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
async function setOf(world,id){
  const out=buildMemberSet({...await rowsOf(world),fixture:true,member_set_id:id,created_at:UTC,member_deployments:world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}))});
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.member_set;
}
const PARENT_SQL=`INSERT INTO public.mp_member_sets(member_set_id,owner_id,bot_id,version,pine_count,membership_hash,content_digest,set_hash,execution_model_hash,policy_hash,capital_basis_hash,
  funding_cutoff,bridge_atr_multiplier,bridge_rr,exit_version,same_bar_order,fixture,record,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`;
const MEMBER_SQL=`INSERT INTO public.mp_member_set_members(member_set_id,ordinal,owner_id,bot_id,pine_import_id,source_version,source_hash,effective_inputs_hash,deployment_id,deployment_snapshot_hash,
  exit_version,evidence_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
async function freezeSet(target,set){
  await target.transaction(async()=>{
    await target.query(PARENT_SQL,[set.member_set_id,set.owner_id,set.bot_id,set.version,set.pine_count,set.membership_hash,set.content_digest,set.set_hash,set.execution_model_hash,set.policy_hash,
      set.capital_basis_hash,set.funding_cutoff,set.bridge_pair.atr_multiplier,set.bridge_pair.rr,set.exit_version,set.same_bar_order,set.fixture,JSON.stringify(set),set.created_at]);
    for(const m of set.members)await target.query(MEMBER_SQL,[set.member_set_id,m.ordinal,set.owner_id,set.bot_id,m.pine_import_id,m.source_version,m.source_hash,m.effective_inputs_hash,
      m.deployment_id,m.deployment_snapshot_hash,m.exit_version,m.evidence_hash]);
  },{isolation:'SERIALIZABLE'});
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
function makeRun(set,runId){
  const contract=contractOf(set);
  return {run_id:runId,owner_id:set.owner_id,bot_id:set.bot_id,member_set_id:set.member_set_id,set_hash:set.set_hash,membership_hash:set.membership_hash,pine_count:set.pine_count,
    contract_version:contract.version,contract,contract_hash:hash(canonical(contract)),idempotency_key:'key-'+randomUUID().replaceAll('-',''),submission_hash:hash('submission-'+randomUUID()),
    engine_hash:contract.engine_hash,dataset_content_digest:contract.dataset.content_digest,created_at_ms:T0MS,deadline_ms:T0MS+600000,fixture:true};
}
const EVENT_SQL='INSERT INTO public.mp_research_run_events(run_id,seq,status,at_ms,reason_code,result,result_hash) VALUES($1,$2,$3,$4,$5,$6,$7)';
function eventFields(status,row){
  if(status==='SUCCEEDED'||status==='NO_VALID_CANDIDATE'){
    const result={run_id:row.run_id,contract_hash:row.contract_hash,owner_recommendation_ready:false,acceptance_blockers:[...row.contract.acceptance_blockers],fixture:true};
    return {result:JSON.stringify(result),result_hash:hash(canonical(result)),reason_code:null};
  }
  if(['FAILED','CANCELLED','TIMED_OUT'].includes(status))return {result:null,result_hash:null,reason_code:'FIXTURE_'+status};
  return {result:null,result_hash:null,reason_code:null};
}
const PATH_TO={ADMITTED:['ADMITTED'],RUNNING:['ADMITTED','RUNNING'],SUCCEEDED:['ADMITTED','RUNNING','SUCCEEDED'],NO_VALID_CANDIDATE:['ADMITTED','RUNNING','NO_VALID_CANDIDATE'],
  FAILED:['ADMITTED','RUNNING','FAILED'],CANCELLED:['ADMITTED','RUNNING','CANCELLED'],TIMED_OUT:['ADMITTED','RUNNING','TIMED_OUT']};
/** One run row and its events in one SERIALIZABLE transaction through the fixture-role pool (there is no writer module yet). */
async function insertMultiRun(target,set,runId,finalStatus){
  const row=makeRun(set,runId);
  await target.transaction(async()=>{
    await target.query(RUN_SQL,RUN_COLUMNS.map(name=>name==='contract'?JSON.stringify(row.contract):row[name]));
    for(const [index,status] of PATH_TO[finalStatus].entries()){
      const e=eventFields(status,row);
      await target.query(EVENT_SQL,[runId,index+1,status,1,e.reason_code,e.result,e.result_hash]);
    }
  },{isolation:'SERIALIZABLE'});
  return row;
}

/* ---- the fixture cluster state ---- */

const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,''))||':'||p.prosecdef::text x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.tgname||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.relname||':'||c.relkind::text||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT 'k:'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.connamespace='public'::regnamespace) s`)).rows[0];
/** Count and digest of every public base table's rows (lease tokens are random per claim and are dropped from the row), keyed by table. */
const VOLATILE={quant_comparison_specs:['frozen_at_ms'],quant_comparison_status_events:['at_ms'],quant_exposure_register:['exposure_id','at_ms']};
async function tableDigests(target,{skip=[],volatile={}}={}){
  const tables=(await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename).filter(name=>!skip.includes(name));
  const out={};
  for(const table of tables){
    out[table]=(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg((to_jsonb(t)-'lease_token'-$1::text[])::text,'|' ORDER BY (to_jsonb(t)-'lease_token'-$1::text[])::text),''),'UTF8')),'hex') d FROM public.${table} t`,[volatile[table]??[]])).rows[0];
  }
  return out;
}

/** The tables whose count or digest differs between two tableDigests results (a table present on one side only differs). */
const diffTables=(left,right)=>[...new Set([...Object.keys(left),...Object.keys(right)])].sort().filter(table=>JSON.stringify(left[table])!==JSON.stringify(right[table]));

/** The result of one call as data: a value, or the error's code, message, HTTP status and constraint. JSON round trip, so BigInt-free and key-order stable. */
async function record(fn){
  try{return JSON.parse(JSON.stringify({ok:true,value:await fn()}));}
  catch(error){return {ok:false,error:{code:error.code??null,status:error.status??error.statusCode??null,constraint:error.constraint??null,message:String(error.message)}};}
}
const withoutLease=value=>{const out=structuredClone(value);const strip=item=>{if(item&&typeof item==='object'){delete item.lease_token;Object.values(item).forEach(strip);}};strip(out);return out;};

/** The services of one database as the RUNTIME role (a real non-owner LOGIN role), plus the schema-owner and fixture-role pools. */
async function openEnv(name){
  const adminPool=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:3})));
  const rt=track(new PostgresDatabase({connectionString:urlOf(name,runtimeName),max:4}));
  const fx=ser(track(new PostgresDatabase({connectionString:serialOf(name,fixtureName),max:3})));
  const store=new Store(rt),pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  const service=new QuantResearchService({pineService:pine,clock:()=>CLOCK,foundation:false});
  const worker=new QuantResearchWorker({service,evaluate:()=>{throw new Error('the isolation suite never evaluates');},clock:()=>CLOCK});
  const scheduler=new QuantFoundationScheduler({db:rt,authorize:async()=>({ok:true}),health:async()=>({ok:true}),clock:()=>CLOCK});
  return {name,admin:adminPool,rt,fx,store,pine,service,worker,scheduler,library:new QuantLibraryService(rt),transcripts:{}};
}
const ids={};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_rs3_tpl_'+suffix;
  runtimeName='robot_rs3_rt_'+suffix.slice(0,14);fixtureName='robot_rs3_fx_'+suffix.slice(0,14);
  for(const name of [runtimeName,fixtureName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=ser(new PostgresDatabase({connectionString:serialOf(templateName),max:3}));
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql','quant-storage-schema.sql'])await install(builder,name);
    await migrateQuantExposureRegister(builder);await migrateBestInputsPackage(builder);await migrateQuantComparison(builder);await migrateQuantSelection(builder);
    await installQuantGuards(builder);
    await migrateMpMemberSet(builder);
    await migrateMpRunStore(builder);
    // Two owners, each with a world of two Pine members, a frozen member set and a few finished ONE-PINE runs (written by the schema owner like the library suites do).
    const store=new Store(builder);
    const worldU=await newWorld(builder,store),worldV=await newWorld(builder,store);
    await freezeSet(builder,await setOf(worldU,IDS.setU));await freezeSet(builder,await setOf(worldV,IDS.setV));
    const one=(world,member,options)=>runOf({owner:world.id,deployment:world.specs[member].dep,importId:world.specs[member].pine,...options});
    const seed=(world,member,run)=>seedRun(builder,run,{owner:world.id,deployment:world.specs[member].dep});
    await seed(worldU,0,one(worldU,0,{id:IDS.oneSucceeded,scenario:'PENDING',tag:'u-ok',at:LIB_T0+3_600_000}));
    await seed(worldU,0,one(worldU,0,{id:IDS.oneNoValid,scenario:'NO_VALID',tag:'u-nv',at:LIB_T0+3_700_000}));
    await seed(worldU,1,one(worldU,1,{id:IDS.oneFailed,status:'FAILED',partial:2,diagnostic:'FIXTURE_FAILED',tag:'u-fail',at:LIB_T0+3_800_000}));
    await seed(worldV,0,one(worldV,0,{id:IDS.oneForeign,scenario:'PENDING',tag:'v-ok',at:LIB_T0+3_650_000}));
    Object.assign(ids,{ownerU:worldU.id,ownerV:worldV.id,depU:worldU.specs[0].dep,importU:worldU.specs[0].pine,depV:worldV.specs[0].dep,importV:worldV.specs[0].pine});
    // The repository grant scripts, exactly as an isolated cluster is prepared: the runtime role first, then the fixture role.
    await builder.query(await roleScript(GRANT_SCRIPT,{runtime_role:runtimeName}));
    await builder.query(await roleScript(FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  }finally{await builder.close();}
  // Two copies of the same database: A holds no run-store rows, B receives the multi runs. The surfaces run on both, in the same order.
  const names={without:'robot_rs3_wo_'+suffix.slice(0,20),with:'robot_rs3_wi_'+suffix.slice(0,20)};
  for(const name of Object.values(names)){databases.push(name);await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);}
  env={without:await openEnv(names.without),with:await openEnv(names.with)};
  // Each database gets its own storage namespace bound to its own empty root (the retention surface asserts the owner marker like the real command does).
  for(const e of Object.values(env)){
    e.root=await fs.mkdtemp(path.join(os.tmpdir(),'rs3-storage-'));storageRoots.push(e.root);
    await e.admin.transaction(()=>bindQuantStorage(e.admin,e.root),{isolation:'SERIALIZABLE'});
  }
  const record_=async(set)=>(await env.with.admin.query('SELECT record FROM public.mp_member_sets WHERE member_set_id=$1',[set])).rows[0].record;
  const setU=await record_(IDS.setU),setV=await record_(IDS.setV);
  // Multi runs of BOTH owners in every non-terminal and terminal state, inserted as the fixture role (the runtime role has no privilege on these tables).
  await insertMultiRun(env.with.fx,setU,IDS.admitted,'ADMITTED');
  await insertMultiRun(env.with.fx,setU,IDS.running,'RUNNING');
  for(const status of ['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT'])await insertMultiRun(env.with.fx,setU,randomUUID(),status);
  await insertMultiRun(env.with.fx,setV,IDS.foreign,'RUNNING');
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  for(const dir of storageRoots)await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  if(admin){
    for(const name of [...databases,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [runtimeName,fixtureName])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- the surfaces: every owner reader, worker claim, mode guard and QR-3 / QR-4 lookup the design lists (section 4.2), run in this order on both databases ---- */

const get=(e,owner,id,cancel=false)=>e.rt.transaction(()=>e.service.get(owner,id,cancel));
const statusOf=async(e,id)=>(await e.admin.query('SELECT status,updated_at FROM quant_jobs WHERE run_id=$1',[id])).rows[0]??null;
const modeOf=async e=>(await e.admin.query('SELECT mode FROM quant_research_executor_mode')).rows[0].mode;
/** The startup drain query, read from its single source: the one statement of src/postgres/quant-research-main.js (a top-level script, so it cannot be imported). Not a copy. */
const startupDrainSql=async()=>{
  const text=await fs.readFile(new URL('../../src/postgres/quant-research-main.js',import.meta.url),'utf8');
  const lines=text.split(String.fromCharCode(10)).filter(line=>line.includes('FROM quant_jobs WHERE status IN')).map(line=>line.replace(String.fromCharCode(13),''));
  assert.equal(lines.length,1,'the startup drain statement appears exactly once in quant-research-main.js');
  const parts=lines[0].split('"');
  assert.equal(parts.length,3,'the statement is one double-quoted literal: '+lines[0]);
  assert.match(parts[1],/^SELECT count/);
  return parts[1];
};
const queuedRun=(options={})=>runOf({id:IDS.oneQueued,owner:ids.ownerU,deployment:ids.depU,importId:ids.importU,status:'QUEUED',tag:'u-queued',at:LIB_T0+7_200_000,...options});
const foundationRun=()=>runOf({id:IDS.oneFoundation,owner:ids.ownerU,deployment:ids.depU,importId:ids.importU,status:'QUEUED',version:'v2',tag:'u-foundation',at:LIB_T0+7_200_000});
/** QR-3 input naming the given run ids as participants (a one-Pine run and/or a multi run id): the store takes ids as text, so the answer must not depend on which database holds run rows. */
const CMP_WINDOW={start_ms:LIB_T0,end_ms:LIB_T0+1440*MINUTE};
function comparisonInput(comparisonId,runIds,shiftDays=0){
  // Windows of the two comparisons do not overlap, so no freeze carries a prior exposure (those carry database clock stamps).
  const shift=shiftDays*1440*MINUTE;
  const checked=validateSpec({mode:'STANDARDIZED',participants:runIds,period:{start_ms:CMP_WINDOW.start_ms+shift,end_ms:CMP_WINDOW.end_ms+shift},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
    uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'}});
  assert.equal(checked.ok,true,JSON.stringify(checked));
  return {owner_id:ids.ownerU,comparison_id:comparisonId,market:{...MARKET},fixture:true,spec:checked.spec,spec_hash:checked.spec_hash,context_key:hex('context'),
    participants:runIds.map((id,index)=>({participant_id:id,source_hash:hex('source-'+id),origin:'FIXTURE',fixture:true,context_key:hex('context'),freeze:{subject:{index},disclosure:{prior_searches:[],gates:{G5:'PASS'}}}}))};
}
const CMP_IDS={mixed:'c0000000-0000-4000-8000-000000000001',multi:'c0000000-0000-4000-8000-000000000002'};
// Database clock stamps (frozen_at_ms, event times) differ between two databases by construction; the answers compare without them.
const CLOCK_KEYS=new Set(['frozen_at_ms','exposure_at_ms','at_ms','attempts']);
const withoutClock=value=>{const out=structuredClone(value);const strip=item=>{if(item&&typeof item==='object'){for(const key of Object.keys(item)){if(CLOCK_KEYS.has(key))delete item[key];else strip(item[key]);}}};strip(out);return out;};
// The offline fakes of test/postgres/quant-storage-retention.test.mjs and quant-foundation-recovery.test.mjs: a masked, inactive worker unit, no jobs, no process inventory.
const OFFLINE={policy:{workerUnit:'qdqs-isolation-test.service',releaseRoot:path.resolve('.')},manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},inventory:async()=>{},settleMs:0};
const SURFACES=[
  ['owner run get: a one-Pine run reads, and a multi run id of the owner or of another owner is NOT_FOUND',async e=>({
    one:await record(()=>get(e,ids.ownerU,IDS.oneSucceeded)),admitted:await record(()=>get(e,ids.ownerU,IDS.admitted)),running:await record(()=>get(e,ids.ownerU,IDS.running)),
    foreignOwner:await record(()=>get(e,ids.ownerV,IDS.running)),foreignRun:await record(()=>get(e,ids.ownerU,IDS.foreign)),oneForeign:await record(()=>get(e,ids.ownerU,IDS.oneForeign))})],
  ['owner run cancel: cancelling a multi run id is NOT_FOUND and writes nothing; a terminal one-Pine run is unchanged',async e=>({
    admitted:await record(()=>get(e,ids.ownerU,IDS.admitted,true)),running:await record(()=>get(e,ids.ownerU,IDS.running,true)),foreign:await record(()=>get(e,ids.ownerV,IDS.admitted,true)),
    foreignRun:await record(()=>get(e,ids.ownerU,IDS.foreign,true)),terminal:await record(()=>get(e,ids.ownerU,IDS.oneSucceeded,true)),after:await statusOf(e,IDS.oneSucceeded)})],
  ['Research Library list: counts, order and paging are those of the one-Pine runs only (both owners)',async e=>({
    u:await record(()=>e.library.list(ids.ownerU,{limit:50})),v:await record(()=>e.library.list(ids.ownerV,{limit:50})),page:await record(()=>e.library.list(ids.ownerU,{limit:2}))})],
  ['Research Library detail: a one-Pine run reads; a multi run id is NOT_FOUND (owner and foreign owner)',async e=>({
    one:await record(()=>e.library.detail(ids.ownerU,IDS.oneSucceeded)),noValid:await record(()=>e.library.detail(ids.ownerU,IDS.oneNoValid)),failed:await record(()=>e.library.detail(ids.ownerU,IDS.oneFailed)),
    admitted:await record(()=>e.library.detail(ids.ownerU,IDS.admitted)),running:await record(()=>e.library.detail(ids.ownerU,IDS.running)),foreign:await record(()=>e.library.detail(ids.ownerV,IDS.running))})],
  ['Research Library compare and the QR-3 participant lookup (the library run lookup): a multi run id never resolves as a participant',async e=>({
    pair:await record(()=>e.library.compare(ids.ownerU,[IDS.oneSucceeded,IDS.oneNoValid])),
    withMulti:await record(()=>e.library.compare(ids.ownerU,[IDS.oneSucceeded,IDS.running])),multiOnly:await record(()=>e.library.compare(ids.ownerU,[IDS.admitted,IDS.running])),
    foreignMulti:await record(()=>e.library.compare(ids.ownerU,[IDS.oneSucceeded,IDS.foreign]))})],
  ['research history: total and runs are those of the one-Pine runs only',async e=>({u:await record(()=>researchHistory(e.rt,ids.ownerU,50)),v:await record(()=>researchHistory(e.rt,ids.ownerV,50))})],
  ['QR-4 searched-window lookup (selection-store readSearchedWindows): one-Pine run windows only',async e=>({
    u:await record(()=>readSearchedWindows(e.rt,{owner_id:ids.ownerU,source_hashes:[hex('source')]})),v:await record(()=>readSearchedWindows(e.rt,{owner_id:ids.ownerV,source_hashes:[hex('source')]}))})],
  ['QR-3 comparison read: an unknown id is NOT_FOUND on both databases',async e=>({absent:await record(()=>readComparison(e.rt,{owner_id:ids.ownerU,comparison_id:randomUUID().replace(/^.{8}/,'00000000')}))})],
  ['mode guard (quant_research_mode_change): the executor mode changes LEGACY to FOUNDATION and back with ADMITTED and RUNNING multi runs present',async e=>{
    const first=await record(()=>e.rt.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION' WHERE singleton").then(result=>result.rowCount));
    const middle=await modeOf(e);
    const back=await record(()=>e.rt.query("UPDATE quant_research_executor_mode SET mode='LEGACY' WHERE singleton").then(result=>result.rowCount));
    return {first,middle,back,final:await modeOf(e)};}],
  ['mode guard (quant_research_mode_guard): a legacy QUEUED run is accepted and a foundation QUEUED run is refused, as the runtime role',async e=>({
    foundation:await record(()=>seedRun(e.rt,foundationRun(),{owner:ids.ownerU,deployment:ids.depU})),legacy:await record(()=>seedRun(e.rt,queuedRun(),{owner:ids.ownerU,deployment:ids.depU})),
    queued:await statusOf(e,IDS.oneQueued),foundationRow:await statusOf(e,IDS.oneFoundation)})],
  ['mode guard drain rule: with a QUEUED one-Pine run the mode change is refused, with the same message whether multi runs exist or not',async e=>({
    change:await record(()=>e.rt.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION' WHERE singleton")),final:await modeOf(e)})],
  ['legacy worker claim (quant-research-worker claim): returns only the one-Pine QUEUED run, no multi run is claimed, swept or counted',async e=>({
    claim:await record(async()=>withoutLease(await e.worker.claim())),again:await record(async()=>withoutLease(await e.worker.claim())),row:await statusOf(e,IDS.oneQueued)})],
  ['foundation scheduler claim: nothing to claim, no foundation job exists for a multi run',async e=>({
    claim:await record(()=>e.scheduler.claim('rs3-worker')),jobs:(await e.admin.query('SELECT count(*)::int n FROM quant_foundation_jobs')).rows[0].n,
    bindings:(await e.admin.query('SELECT count(*)::int n FROM quant_research_foundation')).rows[0].n})],
  ['startup drain count (the query of quant-research-main) and the preflight legacy holdout lookup (QuantPreflightService.legacyHoldout) see one-Pine rows only',async e=>({
    startup:(await e.rt.query(await startupDrainSql())).rows[0],
    holdout:await record(()=>QuantPreflightService.prototype.legacyHoldout.call({db:e.rt},ids.ownerU)),holdoutV:await record(()=>QuantPreflightService.prototype.legacyHoldout.call({db:e.rt},ids.ownerV))})],
  ['QR-3 comparison create and read (comparison-store createComparison, readComparison): participants naming a one-Pine run and a multi run id, then multi run ids only',async e=>{
    const mixed=await record(()=>createComparison(e.rt,comparisonInput(CMP_IDS.mixed,[IDS.oneSucceeded,IDS.running])));
    const multi=await record(()=>createComparison(e.rt,comparisonInput(CMP_IDS.multi,[IDS.admitted,IDS.foreign],2)));
    const readMixed=await record(()=>readComparison(e.rt,{owner_id:ids.ownerU,comparison_id:CMP_IDS.mixed}));
    const readMulti=await record(()=>readComparison(e.rt,{owner_id:ids.ownerU,comparison_id:CMP_IDS.multi}));
    return withoutClock({mixed,multi,readMixed,readMulti});}],
  ['retention (maintainQuantStorage with the fake budget and offline fakes of the retention suite): the retained set and the dry and apply answers are those of the database without run rows',async e=>{
    const budget={root:e.root,maintenance:async options=>({retained:[...options.retainedNames].sort(),apply:options.apply,exclusiveOffline:options.exclusiveOffline})};
    return {dry:await record(()=>maintainQuantStorage({db:e.admin,budget,...OFFLINE})),apply:await record(()=>maintainQuantStorage({db:e.admin,budget,apply:true,...OFFLINE}))};}],
  ['recovery (recoverQuantFoundation with the fake manager and inventory of the recovery suite): the recovery answer is that of the database without run rows',async e=>({
    recover:await record(()=>recoverQuantFoundation({db:e.admin,...OFFLINE}))})]];

for(const [name,run] of SURFACES){
  test(name,async()=>{
    const answers={};
    for(const side of ['without','with'])answers[side]=await run(env[side]);
    assert.deepEqual(answers.with,answers.without,'the same call answers differently once multi runs exist');
    // The answer is a real answer, not an error on both sides, except where NOT_FOUND / a guard refusal is the designed answer.
    const text=JSON.stringify(answers);
    assert.ok(!text.includes('"code":"'+DENIED+'"'),'a normal path raised 42501: '+text.slice(0,400));
    assert.ok(!/mp_research_run|mp_run_store/i.test(text),'an answer names a run-store object');
    for(const side of ['without','with'])env[side].transcripts[name]=answers[side];
  });
}

test('the designed answers are real: NOT_FOUND for a multi run id, runs of the one-Pine kind present, the drain rule and the mode mismatch fire',()=>{
  const t=Object.fromEntries(SURFACES.map(([name])=>[name,env.with.transcripts[name]]));
  const at=index=>t[SURFACES[index][0]];
  const get_=at(0);
  assert.equal(get_.one.ok,true);assert.equal(get_.one.value.run_id,IDS.oneSucceeded);
  for(const key of ['admitted','running','foreignOwner','foreignRun'])assert.deepEqual([get_[key].ok,get_[key].error.status,get_[key].error.message],[false,404,'NOT_FOUND'],key);
  assert.equal(get_.oneForeign.ok,false,'a one-Pine run of another owner is NOT_FOUND too');
  const cancel=at(1);
  for(const key of ['admitted','running','foreign','foreignRun'])assert.equal(cancel[key].error.message,'NOT_FOUND',key);
  assert.equal(cancel.terminal.ok,true);assert.equal(cancel.after.status,'SUCCEEDED');
  const list=at(2).u.value;
  assert.equal(list.totals.all,3,'owner U holds three one-Pine runs');assert.equal(list.runs.length,3);
  assert.ok(list.runs.every(run=>![IDS.admitted,IDS.running].includes(run.run_id)));
  assert.equal(at(2).v.value.totals.all,1);
  assert.equal(at(3).one.ok,true);for(const key of ['admitted','running','foreign'])assert.equal(at(3)[key].error.message,'NOT_FOUND',key);
  assert.equal(at(4).pair.ok,true);for(const key of ['withMulti','multiOnly','foreignMulti'])assert.equal(at(4)[key].ok,false,key);
  assert.equal(at(5).u.value.total_runs,3);assert.equal(at(5).u.value.runs.length,3);
  assert.equal(at(6).u.value.length,9,'three windows per one-Pine run of owner U');
  assert.deepEqual(at(8),{first:{ok:true,value:1},middle:'FOUNDATION',back:{ok:true,value:1},final:'LEGACY'});
  assert.match(at(9).foundation.error.message,/Research executor mode mismatch/);assert.equal(at(9).legacy.ok,true);
  assert.equal(at(9).queued.status,'QUEUED');assert.equal(at(9).foundationRow,null);
  assert.match(at(10).change.error.message,/Stop and drain every research executor before changing mode/);assert.equal(at(10).final,'LEGACY');
  assert.equal(at(11).claim.value.run_id,IDS.oneQueued);assert.equal(at(11).claim.value.status,'RUNNING');assert.equal(at(11).again.value,null);
  assert.equal(at(12).claim.value,null);assert.deepEqual([at(12).jobs,at(12).bindings],[0,0]);
  assert.equal(at(13).startup.total,1,'the startup count sees the one-Pine run only (the legacy run is RUNNING)');
  const qr3=at(14);
  for(const key of ['mixed','multi','readMixed','readMulti'])assert.equal(qr3[key].ok,true,key+': '+JSON.stringify(qr3[key]).slice(0,300));
  assert.equal(qr3.mixed.value.ok,true,JSON.stringify(qr3.mixed.value));assert.equal(qr3.readMixed.value.ok,true);
  assert.deepEqual(qr3.readMixed.value.participants.map(item=>item.participant_id).sort(),[IDS.oneSucceeded,IDS.running].sort(),'the comparison names the multi run id as plain text, with no join to the run store');
  assert.equal(qr3.readMulti.value.ok,true);
  const retention=at(15);
  assert.equal(retention.dry.ok,true,JSON.stringify(retention.dry));assert.equal(retention.apply.ok,true);
  assert.deepEqual(retention.dry.value.retained,['.database-owner.json'],'only the owner marker is retained: no multi run holds a dataset reference');
  assert.equal(retention.dry.value.apply,false);assert.equal(retention.apply.value.apply,true);
  const recovery=at(16);
  assert.equal(recovery.recover.ok,true,JSON.stringify(recovery.recover));assert.deepEqual(recovery.recover.value.recovered,[]);
  assert.equal(at(13).holdout.ok,true);assert.equal(at(13).holdout.value.total,4,'the holdout lookup counts the four one-Pine rows of owner U (three finished and the QUEUED one), never a multi run');assert.equal(at(13).holdoutV.value.total,1);
});

test('side effects: after every surface ran, no table outside the run store differs between the database with multi runs and the one without (outbox, audit, exposure register, quant, package, QR-3, QR-4, Bot and policy)',async()=>{
  // quant_storage_namespace holds a per-database identity (store id, database oid hash), so it differs by construction; the QR-3 clock stamps and the register's random exposure ids are removed from the digest.
  const skip=[...STORE_TABLES,'quant_storage_namespace'];
  const [without,withRuns]=[await tableDigests(env.without.admin,{skip,volatile:VOLATILE}),await tableDigests(env.with.admin,{skip,volatile:VOLATILE})];
  assert.ok(Object.keys(withRuns).length>60,'the digest covers the whole schema: '+Object.keys(withRuns).length+' tables');
  for(const table of ['audit','notification_outbox','risk_profiles','bot_sessions','quant_exposure_register','bi_exports','quant_comparison_specs','quant_selection_registrations','quant_foundation_jobs','quant_job_steps','quant_jobs','users','pine_deployments']){
    assert.ok(table in withRuns,table+' is part of the digest');
  }
  for(const table of ['quant_comparison_specs','quant_comparison_participants','quant_exposure_register'])assert.ok(withRuns[table].n>0,table+' holds the rows of the QR-3 surface, so the compare covers them');
  assert.deepEqual(diffTables(withRuns,without),[],'tables that differ');
  assert.deepEqual(withRuns,without);
  // The run store itself is untouched by every reader above: same rows as inserted.
  const counts=Object.fromEntries(await Promise.all(STORE_TABLES.map(async table=>[table,(await env.with.admin.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
  assert.deepEqual(counts,{mp_run_store_schema:1,mp_research_runs:8,mp_research_run_events:20});
  assert.deepEqual((await tableDigests(env.without.admin)).mp_research_runs.n,0);
});

test('package builder and QR-4 participants: a multi run id is not a quant_jobs row, a bi_exports insert naming it is refused by the export guard (QR004), and the foreign keys point at quant_jobs only',async()=>{
  for(const side of ['without','with']){
    const e=env[side];
    const probe=(await e.rt.query('SELECT count(*)::int n FROM quant_jobs WHERE run_id = ANY($1::text[])',[[IDS.admitted,IDS.running,IDS.foreign]])).rows[0];
    assert.equal(probe.n,0,side+': the key that a package or participant foreign key checks finds nothing');
    const exportId=randomUUID(),runId=IDS.running,files='quant-data/manifest.json';
    const row=[exportId,ids.ownerU,ids.ownerU,runId,null,'MULTI_PINE',true,true,'best-inputs-gates-v1',JSON.stringify({}),JSON.stringify({owner_id:ids.ownerU,bot_id:ids.ownerU,run_id:runId,mode:'MULTI_PINE',fixture:true}),
      hash('binding'),hash(files),JSON.stringify({gate:'B0',state:'PASS',codes:[]}),T0MS,UTC];
    const failure=await record(()=>e.rt.transaction(()=>e.rt.query(`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,row),{isolation:'SERIALIZABLE'}));
    assert.equal(failure.ok,false,side);
    assert.equal(failure.error.code,QR004,side+': '+failure.error.message);
    assert.match(failure.error.message,/needs an existing research run/);
    assert.equal((await e.admin.query('SELECT count(*)::int n FROM bi_exports')).rows[0].n,0);
  }
  const referenced=(await env.with.admin.query(`SELECT c.conrelid::regclass::text AS child,a.attname AS column,c.confrelid::regclass::text AS parent FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.contype='f' AND c.conname IN ('bi_exports_run_id_fkey','bi_clearances_run_id_fkey','quant_selection_participants_run_id_fkey')
    ORDER BY c.conname`)).rows;
  assert.deepEqual(referenced,[{child:'bi_clearances',column:'run_id',parent:'quant_jobs'},{child:'bi_exports',column:'run_id',parent:'quant_jobs'},{child:'quant_selection_participants',column:'run_id',parent:'quant_jobs'}]);
});

/* ---- the catalog: nothing outside the extension references the run store, the extension references nothing outside the member-set side ---- */

test('catalog: no view, rule, policy, publication, inheritance, foreign key or function outside the extension depends on a run-store table, and the extension reaches no one-Pine, package, QR-3 or QR-4 object',async()=>{
  const q=(sql,params)=>env.with.admin.query(sql,params).then(result=>result.rows);
  const storeOids=`ARRAY(SELECT c.oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY($1))`;
  const dependents=await q(`SELECT d.classid::regclass::text AS class,count(*)::int n FROM pg_depend d WHERE d.refobjid = ANY(${storeOids}) AND d.deptype IN ('n','a')
    AND d.classid <> 'pg_constraint'::regclass AND d.classid <> 'pg_class'::regclass AND d.classid <> 'pg_trigger'::regclass GROUP BY 1 ORDER BY 1`,[STORE_TABLES]);
  assert.deepEqual(dependents,[],'a view, rule, policy or other object depends on the run-store tables: '+JSON.stringify(dependents));
  // Foreign keys INTO the run store come from the run store only; foreign keys OUT of it reach users and the member-set tables only.
  const into=await q(`SELECT c.conrelid::regclass::text AS child,c.conname FROM pg_constraint c WHERE c.contype='f' AND c.confrelid = ANY(${storeOids}) AND NOT c.conrelid = ANY(${storeOids}) ORDER BY 1,2`,[STORE_TABLES]);
  assert.deepEqual(into,[]);
  const out=await q(`SELECT DISTINCT c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype='f' AND c.conrelid = ANY(${storeOids}) ORDER BY 1`,[STORE_TABLES]);
  assert.deepEqual(out.map(row=>row.parent),['mp_member_sets','mp_research_runs','users']);
  assert.deepEqual(await q(`SELECT i.inhrelid::regclass::text AS child FROM pg_inherits i WHERE i.inhrelid = ANY(${storeOids}) OR i.inhparent = ANY(${storeOids})`,[STORE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT pr.prrelid::regclass::text AS rel FROM pg_publication_rel pr WHERE pr.prrelid = ANY(${storeOids})`,[STORE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT polname FROM pg_policy WHERE polrelid = ANY(${storeOids})`,[STORE_TABLES]),[]);
  assert.deepEqual(await q(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ~* 'mp_research_run|mp_run_store'`),[]);
  // Triggers on the run-store tables call the extension's own functions only.
  const triggerFns=await q(`SELECT DISTINCT p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND t.tgrelid = ANY(${storeOids}) ORDER BY 1`,[STORE_TABLES]);
  assert.ok(triggerFns.length>=5&&triggerFns.every(row=>/^mp_run_store_/.test(row.proname)||/^mp_research_run/.test(row.proname)),JSON.stringify(triggerFns));
  // Every function that names a run-store table is a run-store function, and no other table's trigger calls one.
  const namers=await q(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prosrc ~* 'mp_research_run|mp_run_store' ORDER BY 1`);
  assert.ok(namers.length>=5&&namers.every(row=>/^mp_run_store_/.test(row.proname)||/^mp_research_run/.test(row.proname)),JSON.stringify(namers));
  const foreignCalls=await q(`SELECT t.tgname,t.tgrelid::regclass::text AS rel FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname ~ '^mp_run_store_|^mp_research_run'
    AND NOT t.tgrelid = ANY(${storeOids})`,[STORE_TABLES]);
  assert.deepEqual(foreignCalls,[],'a trigger on another table calls a run-store function');
  // The extension's function bodies reference no one-Pine research, package, comparison or selection table. The stale guard reads the Pine Bridge deployment side only
  // (memberships, source revisions, deployments, Bridge evidence), exactly the rows the member-set guards read.
  const bodies=await q(`SELECT p.proname,p.prosrc FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.proname ~ '^mp_run_store_|^mp_research_run') ORDER BY 1`);
  assert.ok(bodies.length>=8,'the extension functions were found: '+bodies.length);
  const reach=bodies.filter(row=>/quant_|\bbi_|ql4c|\bqr_/i.test(row.prosrc)).map(row=>row.proname);
  assert.deepEqual(reach,[]);
  const pineTables=[...new Set(bodies.flatMap(row=>[...row.prosrc.matchAll(/\bpine_(?!count|import_id)[a-z_]+/g)].map(match=>match[0])))].sort();
  assert.deepEqual(pineTables,['pine_bridge_evidence','pine_deployments','pine_memberships','pine_source_revisions']);
  // The extension is complete in the catalog (so the scan above judged a real installation).
  const report=await inspectMpRunStore(env.with.admin,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(report.ok,true,report.failures.join());
  assert.equal(report.facts.state,'INSTALLED');
});

/* ---- privilege: the runtime role holds nothing on the run store ---- */

test('privilege: the runtime role gets 42501 on every statement kind against each run-store table, existing or not; the fixture role reads',async()=>{
  const e=env.with;
  const COLUMN={mp_run_store_schema:'version',mp_research_runs:'fixture',mp_research_run_events:'status'};
  for(const table of STORE_TABLES){
    const column=COLUMN[table];
    for(const sql of [`SELECT count(*) FROM public.${table}`,`INSERT INTO public.${table} SELECT * FROM public.${table} LIMIT 0`,`UPDATE public.${table} SET ${column}=${column} WHERE false`,
      `DELETE FROM public.${table} WHERE false`,`TRUNCATE public.${table}`]){
      const answer=await record(()=>e.rt.query(sql));
      assert.equal(answer.ok,false,sql);assert.equal(answer.error.code,DENIED,sql+': '+answer.error.message);
    }
  }
  assert.equal((await e.fx.query('SELECT count(*)::int n FROM public.mp_research_runs')).rows[0].n,8);
  // The same statements fail the same way for the runtime role on a database without any run row.
  assert.equal((await record(()=>env.without.rt.query('SELECT 1 FROM public.mp_research_runs LIMIT 1'))).error.code,DENIED);
});

/* ---- I3: the accepted residuals of K3 ---- */

test('K3 residual 1: the runtime role can see that the run-store tables exist and their table statistics (row counts), but no column statistics or rows',async()=>{
  await env.with.admin.query('ANALYZE public.mp_research_runs, public.mp_research_run_events');
  const e=env.with;
  const visible=(await e.rt.query(`SELECT c.relname,c.reltuples::bigint AS tuples FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY($1) ORDER BY 1`,[RUN_TABLES])).rows;
  assert.deepEqual(visible,[{relname:'mp_research_run_events',tuples:20},{relname:'mp_research_runs',tuples:8}],'pg_class shows the analysed row counts to the runtime role');
  assert.notEqual((await e.rt.query("SELECT to_regclass('public.mp_research_runs') AS present")).rows[0].present,null,'the table name is visible');
  // The fixture pool wrote every run-store row. Close it first: a backend flushes its pending table counters when it exits, so the polling below meets flushed counters
  // and does not depend on an idle timer. Nothing after this test uses env.with.fx.
  await e.fx.close();
  // pg_stat_user_tables can still lag the exit by a moment; poll for the counters.
  let stat=[];
  for(let attempt=0;attempt<50;attempt++){
    stat=(await e.rt.query(`SELECT relname,n_tup_ins::int AS inserted,n_live_tup::int AS live FROM pg_stat_user_tables WHERE relname = ANY($1) ORDER BY 1`,[RUN_TABLES])).rows;
    if(stat.length===2&&stat.every(row=>row.inserted>0))break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.deepEqual(stat.map(row=>row.relname),['mp_research_run_events','mp_research_runs']);
  assert.deepEqual(stat.map(row=>row.inserted),[20,8],'the insert counters are readable by the runtime role (documented residual)');
  // Column statistics (histograms, most common values) are filtered by table privilege and stay hidden from the runtime role, which is the part that could leak a value.
  assert.equal((await e.rt.query("SELECT count(*)::int n FROM pg_stats WHERE schemaname='public' AND tablename = ANY($1)",[RUN_TABLES])).rows[0].n,0);
  assert.ok((await e.admin.query("SELECT count(*)::int n FROM pg_stats WHERE schemaname='public' AND tablename = ANY($1)",[RUN_TABLES])).rows[0].n>0,'control: the schema owner sees column statistics');
  assert.equal((await e.rt.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_name = ANY($1)",[RUN_TABLES])).rows[0].n,0,'information_schema lists only tables the role may use');
});

test('K3 residual 2: a users DELETE of a fixture owner fails 23503 on the run-store key (asserted, not mapped), and with every other key removed the run-store key alone refuses it',async()=>{
  const e=env.with;
  const before_=await tableDigests(e.admin,{skip:[]});
  const plain=await record(()=>e.rt.query('DELETE FROM users WHERE id=$1',[ids.ownerU]));
  assert.equal(plain.ok,false);assert.equal(plain.error.code,FK_VIOLATION,plain.error.message);
  assert.deepEqual(await tableDigests(e.admin,{skip:[]}),before_,'the refused delete changed nothing');
  // Attribution, in a transaction that is always rolled back: drop every other foreign key onto users, then delete as the runtime role.
  class Rollback extends Error {}
  let failure;
  try{
    await e.admin.transaction(async()=>{
      const others=(await e.admin.query(`SELECT c.conrelid::regclass::text AS child,c.conname FROM pg_constraint c WHERE c.contype='f' AND c.confrelid='public.users'::regclass
        AND c.conrelid <> 'public.mp_research_runs'::regclass`)).rows;
      for(const item of others)await e.admin.query(`ALTER TABLE ${item.child} DROP CONSTRAINT ${item.conname}`);
      await e.admin.query('SET LOCAL ROLE '+runtimeName);
      failure=await record(()=>e.admin.query('DELETE FROM users WHERE id=$1',[ids.ownerU]));
      throw new Rollback();
    },{isolation:'SERIALIZABLE'});
  }catch(error){if(!(error instanceof Rollback))throw error;}
  assert.equal(failure.ok,false);assert.equal(failure.error.code,FK_VIOLATION,failure.error.message);
  assert.match(failure.error.constraint,/^mp_research_runs_/,'the refusing key belongs to the run store: '+failure.error.constraint);
  assert.equal((await e.admin.query('SELECT count(*)::int n FROM users WHERE id=$1',[ids.ownerU])).rows[0].n,1);
  assert.deepEqual((await e.admin.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND confrelid='public.users'::regclass")).rows[0].n>3,true,'the dropped keys came back with the rollback');
});

test('the two databases are still the same schema: neither a reader nor a surface changed the catalog (objects, ACLs, constraints)',async()=>{
  assert.deepEqual(await catalogDigest(env.with.admin),await catalogDigest(env.without.admin));
});

test('control: on one fresh database the transcripts stay equal when a multi run is inserted and change when a one-Pine run is inserted (the comparison can tell the two apart)',async()=>{
  const name='robot_rs3_ct_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  const e=await openEnv(name);
  const read=async()=>({list:await record(()=>e.library.list(ids.ownerU,{limit:50})),history:await record(()=>researchHistory(e.rt,ids.ownerU,50)),
    windows:await record(()=>readSearchedWindows(e.rt,{owner_id:ids.ownerU,source_hashes:[hex('source')]}))});
  const first=await read();
  assert.equal(first.list.value.totals.all,3);
  const set=(await e.admin.query('SELECT record FROM public.mp_member_sets WHERE member_set_id=$1',[IDS.setU])).rows[0].record;
  await insertMultiRun(e.fx,set,randomUUID(),'RUNNING');await insertMultiRun(e.fx,set,randomUUID(),'SUCCEEDED');
  assert.deepEqual(await read(),first,'two multi runs do not change any answer');
  await seedRun(e.admin,runOf({owner:ids.ownerU,deployment:ids.depU,importId:ids.importU,scenario:'NO_VALID',tag:'control',at:LIB_T0+3_900_000}),{owner:ids.ownerU,deployment:ids.depU});
  const third=await read();
  assert.notDeepEqual(third,first);
  assert.equal(third.list.value.totals.all,4);assert.equal(third.history.value.total_runs,4);assert.equal(third.windows.value.length,12);
});

test('control: the full compare detects a content change that keeps every row count (two clones of one template; the second differs in one users row only)',async()=>{
  const clones=[];
  for(const label of ['a','b']){
    const name='robot_rs3_cc'+label+'_'+randomUUID().replaceAll('-','').slice(0,18);databases.push(name);
    await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
    clones.push(ser(track(new PostgresDatabase({connectionString:serialOf(name),max:2}))));
  }
  const skip=[...STORE_TABLES];
  const same=[await tableDigests(clones[0],{skip,volatile:VOLATILE}),await tableDigests(clones[1],{skip,volatile:VOLATILE})];
  assert.deepEqual(diffTables(same[0],same[1]),[],'positive control: two untouched clones compare equal');
  await clones[1].query("UPDATE users SET email=email||'.changed' WHERE id=$1",[ids.ownerU]);
  const changed=await tableDigests(clones[1],{skip,volatile:VOLATILE});
  assert.deepEqual(diffTables(same[0],changed),['users'],'exactly the changed surface differs');
  assert.equal(changed.users.n,same[0].users.n,'the row count of the changed table is equal, so a count-only compare would have passed');
  assert.deepEqual(Object.fromEntries(Object.entries(changed).map(([table,item])=>[table,item.n])),Object.fromEntries(Object.entries(same[0]).map(([table,item])=>[table,item.n])),'every count is equal');
  assert.notDeepEqual(changed,same[0]);
});
