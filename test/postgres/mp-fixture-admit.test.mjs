import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {inspectMpRunStore,migrateMpRunStore} from '../../src/postgres/mp-run-store-migration.js';
import {storeBotState,BOT_ROWS,DEPLOYMENT_ROWS} from '../../src/postgres/mp-member-set-store.js';
import {CONTENT_DIGEST_SQL} from '../../src/quant-research/research-contract-v2.js';
import {appendRunEvent,getMultiRun,RUN_STORE_MAX_RETRIES,RUN_STORE_KEY_CONSTRAINT} from '../../src/postgres/mp-run-store.js';
import {canonical,hash,inspectSource,validateSelection} from '../../src/pine-bridge/source.js';
import {assemble} from '../../src/pine-bridge/template.js';
import {MultiPineFixtureService,DEFAULT_DEADLINE_SECONDS,MIN_DEADLINE_SECONDS,MAX_DEADLINE_SECONDS,effectiveInputsHash} from '../../src/multi-pine/fixture-service.js';
import {MAX_DATASET_BARS,SPT_CUSTOM_SETTINGS,SPT_SIGNAL_MAPPING} from '../../src/multi-pine/member-admission.js';
import {MP_CODES,MP_CODE_LIST} from '../../src/multi-pine/codes.js';

// F11-01 RS-5: the internal multi-Pine fixture admission service (src/multi-pine/fixture-service.js), proven on a throwaway PostgreSQL cluster. The service runs on a
// FIXTURE-role connection (repo grant scripts); a second fixture-role pool plays a competing writer. Every row is a LABELLED FIXTURE (fixture=true, synthetic, never a
// research result). Rows are insert-only, so each case that commits uses its own owner. The Bot state is read by the real storeBotState over the Store of the service.
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const serviceFile=new URL('../../src/multi-pine/fixture-service.js',import.meta.url);
const GRANT_SCRIPT=new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url);
const FIXTURE_SCRIPT=new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url);
const T0=1790000000000;
let admin,db,fx,fx2,connectionString,templateName,databaseName,runtimeName,fixtureName,store;
const databases=[],pools=[],extraRoles=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every run-store writer is SERIALIZABLE (QR003 otherwise): the pool defaults to it for autocommit statements (a connection option) and for its transactions (ser).
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const track=pool=>{pools.push(pool);return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let body=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))body=body.replaceAll(":'"+variable+"'","'"+value+"'");return body;};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_fa_tpl_'+suffix;databaseName='robot_fa_main_'+suffix;
  runtimeName='robot_fa_rt_'+suffix.slice(0,14);fixtureName='robot_fa_fx_'+suffix.slice(0,14);
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
  fx=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:8})));
  fx2=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:8})));
  const report=await inspectMpRunStore(db,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(report.ok,true,report.failures?.join());
  service=serviceOn(fx);
  // The verified bars of the admission dataset: contiguous 1m BINANCE:BTCUSDT bars with the profile and a content hash (synthetic, labelled).
  await db.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,jsonb_build_object('time',t),'{"profile":"closed-ohlcv-atr14-v1"}'::jsonb,
    encode(sha256(convert_to(t::text,'UTF8')),'hex') FROM generate_series($1::bigint,$2::bigint,60000) AS t`,[START,END]);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of extraRoles)await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- fixtures: one world per case (owner = Bot), synthetic bars, the service ---- */

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const SOURCE='//@version=6\nindicator("mp fixture service")\nbuySignal = ta.crossover(close, ta.sma(close, 20))\nsellSignal = ta.crossunder(close, ta.sma(close, 20))\nplot(close)\n';
const SUPPORTED=hash(SOURCE);
const ENGINE=hash('fixture engine');
const START=29333333*60000,BARS=3300,END=START+(BARS-1)*60000,NOW=END+3600000;
const DATASET={start_time:START,end_time:END,warmup_bars:1200};
const DOMAINS={atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'}};
const evidenceFor=(snapshot,snapshotHash,tag,model={})=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{...structuredClone(MODEL),...model},
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});
/** The reviewed analysis of one member: 58 effective inputs (the 11 supported Custom settings, two EMA lengths, fillers), its hash by the recipe of the service (tied to the real producer by test/multi-pine-fixture-service.test.js). */
function analysisFor(slow,{hashOf}={}){
  const inputs=Object.entries(SPT_CUSTOM_SETTINGS).map(([name,value])=>({pine_variable:name,type:typeof value==='boolean'?'bool':'string',effective_value:value}));
  inputs.push({pine_variable:'emaFastInput',type:'int',effective_value:20},{pine_variable:'emaSlowInput',type:'int',effective_value:slow});
  for(let i=inputs.length;i<58;i++)inputs.push({pine_variable:'fixtureInput'+i,type:'int',effective_value:i});
  inputs.forEach((input,i)=>Object.assign(input,{input_id:'in-'+i,eligible:true,declared_domain:{min:null,max:null}}));
  const real=effectiveInputsHash({inputs});
  const effective_inputs_hash=hashOf??real;
  return {inputs,declarations:['buySignal','sellSignal'],effective_inputs_hash,
    effective_input_review:{source_hash:SUPPORTED,effective_inputs_hash,input_count:58,reviewed_by:'fixture-reviewer',reviewed_at:1700000000000}};
}
const JOB_SQL=`INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,result)
  VALUES($1,$2,$3,'generate',$4,$5,'{}',$6,'SUCCEEDED',$7,$7,$7,$8)`;

/**
 * One owner with COUNT connected members of the supported source and different effective inputs, each with a source revision, a DRAFT deployment that pins a
 * real integrated Pine artifact, Bridge evidence and the SUCCEEDED generate job that carries the artifact; Paper capital and funding exist as rows (the snapshots hold what
 * the Store reads). The owner is also the Bot, unless child is set: then the Bot is a child Bot of the owner (owner id != Bot id). tamper(n) returns options for the
 * analysis of member n (a stored hash that does not match its inputs); modelOf(n) overrides fields of the execution model in the evidence of member n; reverseDeps gives
 * the member with the HIGHEST pine import id the LOWEST deployment id (so evidence rows, ordered by deployment id, do not follow the member ordinals).
 */
async function newWorld({count=2,tamper=()=>({}),child=false,reverseDeps=false,modelOf=()=>({})}={}){
  const user=await store.createUser({email:'fa-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=child?(await store.createBot(user.id,'fixture child bot',POLICY)).id:user.id;
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,1000,1000,'CONFIGURATION')",[bot,T0]);
  const capital=await store.paperAccounts(bot);
  const funding_cutoff=(await db.query('SELECT COALESCE(max(id),0)::int AS cutoff FROM paper_funding WHERE user_id=$1',[bot])).rows[0].cutoff;
  const ids=Array.from({length:count},()=>randomUUID()).sort();
  const deps=Array.from({length:count},()=>randomUUID()).sort();
  if(reverseDeps)deps.reverse();
  const specs=ids.map((id,i)=>({n:i+1,pine:id,analysis:analysisFor(200+10*(i+1),tamper(i+1)),dep:deps[i]}));
  for(const m of specs){
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[m.pine,user.id,bot,SUPPORTED,'Member fixture',SOURCE,JSON.stringify(m.analysis),T0]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,SUPPORTED,SOURCE,JSON.stringify(m.analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:SUPPORTED,analysis:m.analysis}));
  const selection=validateSelection(inspectSource(SOURCE),{...SPT_SIGNAL_MAPPING,buy:'buySignal',exit:'sellSignal'},[]);
  for(const m of specs){
    const artifact=assemble(SOURCE,selection,{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET}).integrated_pine;
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital,funding_cutoff,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection,market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:SUPPORTED,instruction_versions:{template:'fixture'},artifact_hash:hash(artifact)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n,modelOf(m.n));
    await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'DRAFT',$7)",
      [m.dep,user.id,bot,m.pine,JSON.stringify(snapshot),snapshotHash,T0]);
    await db.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
    await db.query(JOB_SQL,[randomUUID(),user.id,bot,randomUUID(),hash('request-'+randomUUID()),m.pine,T0,JSON.stringify({integrated_pine:artifact,deployment_id:m.dep,artifact_status:'DRAFT'})]);
  }
  return {id:user.id,bot,specs};
}
const namesOf=world=>world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}));
const keyOf=()=>'fa-key-'+randomUUID().replaceAll('-','');
const inputOf=(world,over={})=>({owner_id:world.id,bot_id:world.bot,fixture:true,idempotency_key:keyOf(),member_deployments:namesOf(world),bridge_domains:structuredClone(DOMAINS),
  dataset:{...DATASET},budget:{candidates:30},seed:42,...over});
/** The service on a handle: its Store is built on the same handle, and the real storeBotState reads the Bot state through it. */
function serviceOn(handle,over={}){
  const own=new Store(handle);
  return new MultiPineFixtureService({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>NOW,engineHash:ENGINE,supported_source_hash:SUPPORTED,...over});
}
let service;
const admit=(world,over={},target=service)=>target.admit(inputOf(world,over));
const refusedAs=(out,code,partial={})=>{
  assert.equal(out.ok,false,JSON.stringify(out));assert.equal(out.code,code,JSON.stringify(out));
  for(const [key,value] of Object.entries(partial))assert.deepEqual(out.diagnostic[key],value,key+': '+JSON.stringify(out.diagnostic));
};
const RUN_TABLES=['mp_member_sets','mp_member_set_members','mp_research_runs','mp_research_run_events'];
const rowDigest=async(table,where='',params=[])=>(await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t ${where}`,params)).rows[0];
/** A digest of every table of the schema and every sequence: what a side effect would change. */
async function digestAll(){
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
  const out={};
  for(const table of tables)out[table]=await rowDigest(table);
  out['(sequences)']=(await db.query("SELECT string_agg(sequencename||':'||COALESCE(last_value::text,'-'),',' ORDER BY sequencename) AS s FROM pg_sequences WHERE schemaname='public'")).rows[0].s;
  return out;
}
const only=(digest,names)=>Object.fromEntries(Object.entries(digest).filter(([name])=>names.includes(name)));
const except=(digest,names)=>Object.fromEntries(Object.entries(digest).filter(([name])=>!names.includes(name)));
const counts=async world=>({
  sets:(await db.query('SELECT count(*)::int n FROM mp_member_sets WHERE owner_id=$1',[world.id])).rows[0].n,
  runs:(await db.query('SELECT count(*)::int n FROM mp_research_runs WHERE owner_id=$1',[world.id])).rows[0].n,
  events:(await db.query('SELECT count(*)::int n FROM mp_research_run_events e JOIN mp_research_runs r USING(run_id) WHERE r.owner_id=$1',[world.id])).rows[0].n});
/** A database handle whose query() and transaction() are observed: the log records every query (with whether it ran in a transaction) and every transaction start. */
function tapped(target,{onQuery,onTransaction,log=[]}={}){
  return {log,
    get isTransaction(){return target.isTransaction;},
    prepare:sql=>target.prepare(sql),
    transaction:(fn,options)=>{
      log.push({kind:'begin',isolation:options?.isolation});
      const run=()=>target.transaction(fn,options);
      return onTransaction?onTransaction(options,run,log.filter(e=>e.kind==='begin'&&e.isolation==='SERIALIZABLE').length):run();
    },
    query:(sql,params)=>{
      log.push({kind:'query',sql:String(sql),tx:target.isTransaction});
      return onQuery?onQuery(String(sql),params,()=>target.query(sql,params)):target.query(sql,params);
    }};
}
const isRunInsert=sql=>/^INSERT INTO public\.mp_research_runs\(/.test(sql.trim());
const isKeyLookup=entry=>entry.kind==='query'&&!entry.tx&&/WHERE owner_id=\$1 AND bot_id=\$2 AND idempotency_key=\$3/.test(entry.sql);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const begins=log=>log.filter(e=>e.kind==='begin'&&e.isolation==='SERIALIZABLE').length;
const injected=code=>Object.assign(new Error('injected '+code+' failure'),{code});

/* ---- 1. admit, load, return shape, engine hash, deadline default (V4, V6) ---- */

test('admit then load: ADMIT writes one frozen set, one run and its ADMITTED event; the same request loads the run with the stored status (V4)',async()=>{
  const world=await newWorld();
  const input=inputOf(world);
  const first=await service.admit(input);
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.action,'ADMIT');
  assert.deepEqual(Object.keys(first).sort(),['action','ok','run']);
  assert.deepEqual(Object.keys(first.run).sort(),['contract_hash','owner_recommendation_ready','run_id','status']);
  assert.equal(first.run.status,'ADMITTED');assert.equal(first.run.owner_recommendation_ready,false);
  assert.match(first.run.run_id,/^[0-9a-f-]{36}$/);assert.match(first.run.contract_hash,/^[0-9a-f]{64}$/);
  assert.deepEqual(await counts(world),{sets:1,runs:1,events:1});
  assert.equal((await db.query('SELECT created_at_utc FROM mp_member_sets WHERE owner_id=$1',[world.id])).rows[0].created_at_utc,new Date(NOW).toISOString(),'T1 gets the injected clock as the creation time of the member set (N4)');
  const row=(await db.query('SELECT * FROM mp_research_runs WHERE run_id=$1',[first.run.run_id])).rows[0];
  assert.equal(row.fixture,true);assert.equal(row.contract_hash,first.run.contract_hash);assert.equal(row.idempotency_key,input.idempotency_key);
  assert.equal(row.contract.engine_hash,ENGINE,'the engine hash is the configured one (V6)');
  assert.equal(row.engine_hash,ENGINE);assert.equal(row.contract.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B'),true);
  assert.deepEqual(row.contract.members.map(m=>m.deployment_id),world.specs.map(m=>m.dep));
  const digests=await digestAll();
  const second=await service.admit(input);
  assert.deepEqual(second,{ok:true,action:'LOAD',run:first.run},'the replay loads the stored run');
  assert.deepEqual(await digestAll(),digests,'a load writes nothing');
  // LOAD reports the stored run's CURRENT status, not ADMITTED
  const appended=await appendRunEvent(fx,{owner_id:world.id,run_id:first.run.run_id,status:'RUNNING'});
  assert.equal(appended.ok,true,JSON.stringify(appended));
  const third=await service.admit(input);
  assert.equal(third.action,'LOAD');assert.equal(third.run.status,'RUNNING');assert.equal(third.run.run_id,first.run.run_id);
  const stored=await getMultiRun(fx,{owner_id:world.id,run_id:first.run.run_id});
  assert.equal(stored.ok,true);assert.equal(stored.status,'RUNNING');
  // three members
  const three=await newWorld({count:3});
  const out=await admit(three);
  assert.equal(out.ok,true,JSON.stringify(out));assert.deepEqual(await counts(three),{sets:1,runs:1,events:1});
});

test('deadline: whole seconds 60 to 900, default 900; anything else is MP_INPUT_INVALID and writes nothing (V1)',async()=>{
  assert.deepEqual([MIN_DEADLINE_SECONDS,MAX_DEADLINE_SECONDS,DEFAULT_DEADLINE_SECONDS],[60,900,900]);
  const world=await newWorld();
  const before=await digestAll();
  for(const bad of [59,901,0,-60,60.5,'60',null,NaN,Infinity,[900],{}]) {
    refusedAs(await admit(world,{deadline_seconds:bad}),MP_CODES.INPUT_INVALID,{field:'deadline_seconds'});
  }
  assert.deepEqual(await digestAll(),before);
  const deadlines=async out=>{const row=(await db.query('SELECT created_at_ms,deadline_ms FROM mp_research_runs WHERE run_id=$1',[out.run.run_id])).rows[0];return Number(row.deadline_ms)-Number(row.created_at_ms);};
  const low=await admit(world,{deadline_seconds:60});
  assert.equal(low.ok,true,JSON.stringify(low));assert.equal(await deadlines(low),60_000);
  const high=await admit(world,{deadline_seconds:900});
  assert.equal(await deadlines(high),900_000);
  const standard=await admit(world);
  assert.equal(await deadlines(standard),DEFAULT_DEADLINE_SECONDS*1000);
  assert.equal(Number((await db.query('SELECT created_at_ms FROM mp_research_runs WHERE run_id=$1',[standard.run.run_id])).rows[0].created_at_ms),NOW,'created_at_ms is the injected clock');
});

/* ---- 2. step 1: shape, fixture flag, source slots ---- */

test('step 1: the key list is closed, so no configuration or server-owned value comes from the request (V1)',async()=>{
  const world=await newWorld();
  const before=await digestAll();
  for(const extra of ['engine_hash','supported_source_hash','quant_capability','member_set','member_set_id','set_hash','created_at','members','mode','pine_count','deployment_id','pine_import_id','source_version','clock','readBotState','bot_state','model','rules','capital_accounts','__proto__x'])
    refusedAs(await admit(world,{[extra]:ENGINE}),MP_CODES.INPUT_INVALID,{field:'input.'+extra,stage:'service'});
  for(const key of ['owner_id','bot_id','fixture','idempotency_key','member_deployments','bridge_domains','dataset','budget','seed']) {
    const input=inputOf(world);delete input[key];
    refusedAs(await service.admit(input),MP_CODES.INPUT_INVALID,{field:key});
  }
  for(const input of [null,undefined,'x',7,[],[inputOf(world)]])refusedAs(await service.admit(input),MP_CODES.INPUT_INVALID,{field:'input'});
  for(const [key,value] of [['owner_id',''],['owner_id',7],['bot_id',{}],['idempotency_key','short'],['idempotency_key','has space in it'],['idempotency_key',7],['member_deployments','x'],['member_deployments',{}],['parameter_slots','x'],['parameter_slots',{}]])
    refusedAs(await admit(world,{[key]:value}),MP_CODES.INPUT_INVALID,{field:key});
  assert.deepEqual(await digestAll(),before,'a shape refusal writes nothing');
  const service2=serviceOn(fx);
  assert.equal((await service2.admit(inputOf(world,{deadline_seconds:300}))).ok,true,'the optional keys are accepted');
});

test('step 1 order: shape first, then the fixture flag, then non-empty source slots',async()=>{
  const world=await newWorld();
  const before=await digestAll();
  // fixture off or absent from the truth: MP_FIXTURE_ONLY
  for(const flag of [false,'true',1,null,undefined,0])refusedAs(await admit(world,{fixture:flag}),MP_CODES.FIXTURE_ONLY,{field:'fixture'});
  // the fixture flag comes before the slots, and the shape comes before the fixture flag
  refusedAs(await admit(world,{fixture:false,parameter_slots:[{slot:3}]}),MP_CODES.FIXTURE_ONLY);
  refusedAs(await admit(world,{fixture:false,extra:1}),MP_CODES.INPUT_INVALID,{field:'input.extra'});
  refusedAs(await admit(world,{fixture:false,idempotency_key:'x'}),MP_CODES.INPUT_INVALID,{field:'idempotency_key'});
  // source slots: any entry refuses, with no authorization, no read and no write behind it
  for(const slots of [[{slot:3,input_id:'in-1',min:1,max:2,step:1}],[1],[null],[[]],['x']])refusedAs(await admit(world,{parameter_slots:slots}),MP_CODES.SOURCE_SLOTS_FORBIDDEN,{field:'parameter_slots'});
  refusedAs(await admit({id:'nobody',bot:'nobody',specs:[]},{parameter_slots:[{slot:3}],member_deployments:[]}),MP_CODES.SOURCE_SLOTS_FORBIDDEN);
  assert.deepEqual(await digestAll(),before);
  // absent and empty are the same: no slots
  const empty=await admit(world,{parameter_slots:[]});
  assert.equal(empty.ok,true,JSON.stringify(empty));
  const absent=await admit(world);
  assert.equal(absent.ok,true);
});

test('step 1: a service call inside a transaction is refused before anything is read (G1)',async()=>{
  const world=await newWorld();
  const before=await digestAll();
  const log=[];
  const watched=serviceOn(tapped(fx,{log}));
  const out=await fx.transaction(()=>watched.admit(inputOf(world)));
  refusedAs(out,MP_CODES.INPUT_INVALID,{field:'db.transaction'});
  assert.deepEqual(log,[],'no query and no transaction start: refused before authorization and before every read');
  refusedAs(await fx.transaction(()=>service.admit(inputOf(world))),MP_CODES.INPUT_INVALID,{field:'db.transaction'});
  assert.deepEqual(await digestAll(),before);
  // control: the same service outside a transaction does read
  const outside=await watched.admit(inputOf(world));
  assert.equal(outside.ok,true,JSON.stringify(outside));
  assert.ok(log.some(e=>e.kind==='query'),'the control reads');
});

/* ---- 3. step 2: authorization ---- */

test('step 2: an unknown owner, a Bot of another owner and an inactive user are NOT_FOUND and write nothing',async()=>{
  const world=await newWorld(),other=await newWorld();
  const before=await digestAll();
  refusedAs(await admit(world,{owner_id:'no-such-owner'}),'NOT_FOUND',{field:'bot_id'});
  refusedAs(await admit(world,{bot_id:other.bot}),'NOT_FOUND');
  refusedAs(await admit(world,{owner_id:other.id}),'NOT_FOUND');
  refusedAs(await admit(world,{bot_id:'no-such-bot'}),'NOT_FOUND');
  assert.deepEqual(await digestAll(),before);
  // an inactive user is not authorized
  const quiet=await newWorld();
  await db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[quiet.id]);
  refusedAs(await admit(quiet),'NOT_FOUND');
  assert.deepEqual(await counts(quiet),{sets:0,runs:0,events:0});
});

test('step 2: with a child Bot (owner id != Bot id) both users must be ACTIVE; a disabled Bot or a disabled owner is NOT_FOUND, with no transaction and no write (G2)',async()=>{
  const control=await newWorld({child:true});
  assert.notEqual(control.id,control.bot,'a child Bot has its own id');
  const admitted=await admit(control);
  assert.equal(admitted.ok,true,'control: an active owner with an active child Bot is admitted: '+JSON.stringify(admitted));
  assert.deepEqual(await counts(control),{sets:1,runs:1,events:1});
  for(const [label,disabled] of [['the Bot',world=>world.bot],['the owner',world=>world.id]]) {
    const world=await newWorld({child:true});
    await db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[disabled(world)]);
    assert.equal((await db.query("SELECT count(*)::int n FROM users WHERE id IN ($1,$2) AND status='ACTIVE'",[world.id,world.bot])).rows[0].n,1,'exactly one of the two users is still ACTIVE');
    const before=await digestAll();
    const log=[];
    refusedAs(await admit(world,{},serviceOn(tapped(fx,{log}))),'NOT_FOUND',{field:'bot_id'});
    assert.equal(log.some(e=>e.kind==='begin'),false,label+' disabled: refused before T1');
    assert.equal(log.some(e=>e.kind==='query'&&/INSERT|UPDATE|DELETE/i.test(e.sql)),false);
    assert.deepEqual(await digestAll(),before,label+' disabled: nothing written');
    assert.deepEqual(await counts(world),{sets:0,runs:0,events:0});
  }
  // a child Bot of another owner is not this owner's Bot, whoever is active
  const other=await newWorld({child:true});
  refusedAs(await admit(control,{bot_id:other.bot}),'NOT_FOUND');
  refusedAs(await admit(other,{owner_id:control.id}),'NOT_FOUND');
});

/* ---- 4. step 3: the read-only replay check ---- */

test('step 3: the same key with the same request loads; the same key with another request is MP_INPUT_INVALID (idempotency_key); neither writes',async()=>{
  const world=await newWorld();
  const input=inputOf(world);
  const first=await service.admit(input);
  assert.equal(first.ok,true,JSON.stringify(first));
  const before=await digestAll();
  for(const change of [{seed:43},{budget:{candidates:31}},{deadline_seconds:300},{dataset:{...DATASET,warmup_bars:1201}},{parameter_slots:[]},
    {bridge_domains:{...DOMAINS,rr:{min:'0.5',max:'2.5',step:'1'}}},{member_deployments:[...namesOf(world)].reverse()}])
    refusedAs(await service.admit({...input,...change}),MP_CODES.INPUT_INVALID,{field:'idempotency_key'});
  const log=[];
  const watched=serviceOn(tapped(fx,{log}));
  const replayed=await watched.admit(input);
  assert.deepEqual(replayed,{ok:true,action:'LOAD',run:first.run});
  assert.equal(log.some(e=>e.kind==='begin'),false,'the replay check opens no transaction (T1 and T2 are not entered)');
  assert.equal(log.some(e=>e.kind==='query'&&/INSERT|UPDATE|DELETE/i.test(e.sql)),false);
  assert.deepEqual(await digestAll(),before,'a conflict and a load write nothing');
  // the key is scoped by owner and Bot: another owner may use the same key
  const other=await newWorld();
  const mine=await service.admit({...inputOf(other),idempotency_key:input.idempotency_key});
  assert.equal(mine.ok,true);assert.equal(mine.action,'ADMIT');assert.notEqual(mine.run.run_id,first.run.run_id);
});

/* ---- 5. steps 4 to 7: the T2 checks, mapped outside the transaction ---- */

test('X3 quant capability: a member whose stored effective inputs hash does not match its inputs refuses the whole set with MP_MEMBER_QUANT_UNSUPPORTED, end to end',async()=>{
  const world=await newWorld({tamper:n=>n===2?{hashOf:hash('a hash that names no inputs')}:{}});
  const before=await digestAll();
  const out=await admit(world);
  refusedAs(out,MP_CODES.MEMBER_QUANT_UNSUPPORTED,{ordinal:2,pine_import_id:world.specs[1].pine,field:'quant_capability'});
  assert.deepEqual(except(await digestAll(),RUN_TABLES),except(before,RUN_TABLES));
  assert.equal((await counts(world)).runs,0);assert.equal((await counts(world)).sets,1,'T1 froze the set; T2 refused');
  // the same member with the matching hash is admitted (control), and a tamper on member 1 names member 1
  const good=await newWorld();
  assert.equal((await admit(good)).ok,true);
  const first=await newWorld({tamper:n=>n===1?{hashOf:hash('another hash')}:{}});
  refusedAs(await admit(first),MP_CODES.MEMBER_QUANT_UNSUPPORTED,{ordinal:1,pine_import_id:first.specs[0].pine});
  // the source hash is configuration: a service configured for another source refuses at the per-member checks, before any capability
  const other=serviceOn(fx,{supported_source_hash:hash('another supported source')});
  const world3=await newWorld();
  refusedAs(await admit(world3,{},other),'UNSUPPORTED_SOURCE_HASH',{ordinal:1,pine_import_id:world3.specs[0].pine,field:'source.source_hash'});
});

test('step 5 and 7: every refusal inside T2 is thrown out of the transaction callback (ROLLBACK) and mapped outside it',async()=>{
  const failures=[];
  const handle=tapped(fx,{onTransaction:async(options,run)=>{try{return await run();}catch(error){failures.push(error);throw error;}}});
  const watched=serviceOn(handle);
  const cases=[
    ['dataset with a gap',w=>({dataset:{...DATASET,end_time:END+60000}}),'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'],
    ['too few compared bars',w=>({dataset:{...DATASET,warmup_bars:1200,end_time:START+2500*60000}}),'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'],
    ['warm-up below the floor',w=>({dataset:{...DATASET,warmup_bars:1005}}),'INVALID_NUMERIC_VALUE'],
    ['unaligned range',w=>({dataset:{...DATASET,start_time:START+1}}),'INVALID_RESEARCH_DATASET'],
    ['range ahead of the clock',w=>({dataset:{...DATASET,end_time:NOW+60000}}),'INVALID_NUMERIC_VALUE'],
    ['dataset keys',w=>({dataset:{...DATASET,extra:1}}),'INVALID_FIELDS'],
    ['bridge domain without the pair',w=>({bridge_domains:{...DOMAINS,atr_multiplier:{min:'2.5',max:'3',step:'0.5'}}}),MP_CODES.INPUT_INVALID],
    ['budget',w=>({budget:{candidates:0}}),MP_CODES.INPUT_INVALID]];
  for(const [label,over,code] of cases) {
    const world=await newWorld();
    failures.length=0;
    const before=await digestAll();
    const out=await watched.admit(inputOf(world,over(world)));
    refusedAs(out,code);
    assert.ok(failures.some(error=>error.message===code),label+': the refusal was thrown out of the transaction, which rolled back: '+failures.map(error=>error.message).join());
    assert.equal(Object.hasOwn(out,'rollback_required'),false);
    assert.deepEqual(except(await digestAll(),RUN_TABLES),except(before,RUN_TABLES),label);
    assert.equal((await counts(world)).runs,0,label);
  }
  assert.equal(MP_CODE_LIST.includes('UNSUPPORTED_SOURCE_HASH'),false,'one-Pine codes stay one-Pine codes: this service adds no MP code');
});

test('X2 stale: the real storeBotState reader and a change of database rows between T1 and T2 refuse with MP_MEMBER_SET_STALE',async()=>{
  const changes=[
    ['policy_hash',async world=>db.query('INSERT INTO risk_profiles(user_id,policy,updated_at) VALUES($1,$2,$3)',[world.id,JSON.stringify({maxRiskPercent:3}),T0])],
    ['funding_cutoff',async world=>db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'CONFIGURATION')",[world.id,T0+1])],
    ['capital_basis_hash',async world=>db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,5,5,'CONFIGURATION')",[world.id,T0+1])],
    ['membership_hash',async world=>db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[world.specs[1].pine])],
    ['effective_inputs_hash',async world=>db.query("UPDATE pine_source_revisions SET analysis=jsonb_set(analysis,'{effective_inputs_hash}',to_jsonb($2::text)) WHERE pine_import_id=$1",[world.specs[0].pine,hash('changed')])],
    ['deployment_state',async world=>db.query("UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",[world.specs[0].dep])],
    ['exit_version',async world=>db.query("DELETE FROM pine_bridge_jobs WHERE pine_import_id=$1",[world.specs[1].pine])]];
  for(const [field,change] of changes) {
    const world=await newWorld();
    const failures=[];
    // The change commits after T1 and before the T2 snapshot: it happens as the second SERIALIZABLE transaction starts.
    const handle=tapped(fx,{onTransaction:async(options,run,serializable)=>{
      if(serializable===2)await change(world);
      try{return await run();}catch(error){failures.push(error);throw error;}
    }});
    const out=await admit(world,{},serviceOn(handle));
    refusedAs(out,MP_CODES.MEMBER_SET_STALE);
    assert.equal(out.diagnostic.field,field,JSON.stringify(out));
    assert.ok(failures.some(error=>error.message===MP_CODES.MEMBER_SET_STALE),field+': thrown out of the transaction');
    const now=await counts(world);
    assert.equal(now.runs,0,field);assert.equal(now.events,0);
  }
  // a stale deployment is not admitted again until it is regenerated; the replay of an admitted request still loads (step 3 comes first)
  const world=await newWorld();
  const input=inputOf(world);
  const first=await service.admit(input);
  assert.equal(first.ok,true,JSON.stringify(first));
  await db.query('INSERT INTO risk_profiles(user_id,policy,updated_at) VALUES($1,$2,$3)',[world.id,JSON.stringify({maxRiskPercent:3}),T0]);
  refusedAs(await admit(world),MP_CODES.MEMBER_SET_STALE,{field:'policy_hash',against:'bot_state'});
  assert.deepEqual(await service.admit(input),{ok:true,action:'LOAD',run:first.run});
  assert.deepEqual(await counts(world),{sets:1,runs:1,events:1});
});

test('X5: a database failure maps to an existing code and leaks no database text, constraint, SQL or secret; an unmapped one is rethrown',async()=>{
  const SECRET='SECRET internal text password=hunter2 /var/lib/postgresql';
  const world=await newWorld();
  const guard=Object.assign(new Error(SECRET),{code:'QR004',constraint:'mp_research_runs_set_stale',detail:SECRET,where:SECRET,table:'mp_research_runs'});
  const handle=tapped(fx,{onQuery:(sql,params,run)=>{if(isRunInsert(sql))throw guard;return run();}});
  const out=await admit(world,{},serviceOn(handle));
  refusedAs(out,MP_CODES.MEMBER_SET_STALE,{field:'insert_guard',stage:'store'});
  assert.ok(MP_CODE_LIST.includes(out.code));
  const text=JSON.stringify(out);
  for(const leak of ['SECRET','hunter2','postgres','mp_research_runs','set_stale','QR004','constraint','rollback_required','INSERT'])assert.equal(text.includes(leak),false,leak+' leaked: '+text);
  assert.deepEqual(Object.keys(out).sort(),['code','diagnostic','ok']);
  assert.equal((await counts(world)).runs,0);
  for(const [constraint,field] of [['mp_research_runs_guard','storage.binding'],['mp_research_run_events_order','run.order']]) {
    const mapped=await admit(await newWorld(),{},serviceOn(tapped(fx,{onQuery:(sql,params,run)=>{if(isRunInsert(sql))throw Object.assign(new Error(SECRET),{code:'QR004',constraint});return run();}})));
    refusedAs(mapped,MP_CODES.INPUT_INVALID,{field});
    assert.equal(JSON.stringify(mapped).includes('SECRET'),false);
  }
  // CHECK, foreign key and other unique violations are storage refusals with the same sanitized shape
  const storage=await admit(await newWorld(),{},serviceOn(tapped(fx,{onQuery:(sql,params,run)=>{if(isRunInsert(sql))throw Object.assign(new Error(SECRET),{code:'23514',constraint:'mp_research_runs_check'});return run();}})));
  refusedAs(storage,MP_CODES.INPUT_INVALID,{field:'storage'});
  assert.equal(JSON.stringify(storage).includes('mp_research_runs_check'),false);
  assert.equal(JSON.stringify(storage).includes('23514'),false);
  // errors that no refusal covers stay errors: a missing privilege, a wrong isolation level, the retry bound
  for(const code of ['42501','QR003','XX000']) {
    const w=await newWorld();
    await assert.rejects(admit(w,{},serviceOn(tapped(fx,{onQuery:(sql,params,run)=>{if(isRunInsert(sql))throw injected(code);return run();}}))),{code});
    assert.equal((await counts(w)).runs,0);
  }
});

/* ---- 6. T2 retries ---- */

test('retry: an injected 40001 or 40P01 restarts T2 and succeeds; the attempt after the first calls findMultiRunByKey first (X6)',async()=>{
  for(const code of ['40001','40P01']) {
    const world=await newWorld();
    let left=1;
    const log=[];
    const handle=tapped(fx,{log,onQuery:(sql,params,run)=>{if(isRunInsert(sql)&&left-->0)throw injected(code);return run();}});
    const out=await admit(world,{},serviceOn(handle));
    assert.equal(out.ok,true,code+': '+JSON.stringify(out));assert.equal(out.action,'ADMIT');
    assert.deepEqual(await counts(world),{sets:1,runs:1,events:1},'one run, written once');
    const serializable=log.map((e,i)=>({e,i})).filter(({e})=>e.kind==='begin'&&e.isolation==='SERIALIZABLE').map(({i})=>i);
    assert.equal(serializable.length,3,'T1, T2 attempt 1 (injected failure), T2 attempt 2');
    const lookups=log.map((e,i)=>({e,i})).filter(({e})=>isKeyLookup(e)).map(({i})=>i);
    assert.equal(lookups.length,2,'step 3 and the one retry');
    assert.ok(lookups[0]<serializable[0],'step 3 runs before T1');
    assert.ok(lookups[1]>serializable[1]&&lookups[1]<serializable[2],'the retry looks the key up before the second T2 attempt');
    const firstQuery=log.slice(serializable[2]+1).find(e=>e.kind==='query');
    assert.equal(firstQuery.tx,true);assert.match(firstQuery.sql,/FOR SHARE/,'the second attempt starts with the locks');
  }
});

test('retry cap: after the first attempt and three retries the last database error is rethrown, nothing is written, and each retry looked the key up',async()=>{
  assert.equal(RUN_STORE_MAX_RETRIES,3);
  const world=await newWorld();
  const log=[];
  const handle=tapped(fx,{log,onQuery:(sql,params,run)=>{if(isRunInsert(sql))throw injected('40001');return run();}});
  await assert.rejects(admit(world,{},serviceOn(handle)),{code:'40001'});
  const serializable=log.filter(e=>e.kind==='begin'&&e.isolation==='SERIALIZABLE').length;
  assert.equal(serializable,1+4,'T1 and four T2 attempts (the first plus three retries)');
  assert.equal(log.filter(isKeyLookup).length,1+3,'step 3 and one lookup per retry');
  assert.deepEqual(await counts(world),{sets:1,runs:0,events:0});
  // a service call after the failure still works: nothing is left open
  assert.equal((await admit(world)).ok,true);
});

test('retry: a lost idempotency-key race loads the competitor run on the next attempt, with no second run',async()=>{
  const world=await newWorld();
  const input=inputOf(world);
  const rival=serviceOn(fx2);
  let raced=false;
  const log=[];
  const handle=tapped(fx,{log,onQuery:async(sql,params,run)=>{
    if(isRunInsert(sql)&&!raced) {
      raced=true;
      const winner=await rival.admit(input);
      assert.equal(winner.ok,true,JSON.stringify(winner));
      return run();
    }
    return run();
  }});
  const out=await serviceOn(handle).admit(input);
  assert.equal(raced,true);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.action,'LOAD');
  assert.deepEqual(await counts(world),{sets:1,runs:1,events:1});
  const stored=(await db.query('SELECT run_id FROM mp_research_runs WHERE owner_id=$1',[world.id])).rows;
  assert.equal(out.run.run_id,stored[0].run_id,'the loser holds the winner run');
  assert.equal(log.filter(isKeyLookup).length,2,'the retry looked the key up (X6)');
  // a competitor with a different request under the same key makes the retry a key conflict
  const other=await newWorld();
  const mine=inputOf(other),theirs={...mine,seed:7};
  let again=false;
  const conflicted=await serviceOn(tapped(fx,{onQuery:async(sql,params,run)=>{
    if(isRunInsert(sql)&&!again){again=true;assert.equal((await rival.admit(theirs)).ok,true);}
    return run();
  }})).admit(mine);
  refusedAs(conflicted,MP_CODES.INPUT_INVALID,{field:'idempotency_key'});
  assert.equal((await counts(other)).runs,1);
});

/* ---- 7. concurrency, side effects, boundaries ---- */

test('race: callers that admit the same request at the same moment end with one run and every caller holding it',async()=>{
  for(let round=0;round<3;round++) {
    const world=await newWorld({count:round===1?3:2});
    const input=inputOf(world);
    const services=[serviceOn(fx),serviceOn(fx2),serviceOn(fx),serviceOn(fx2)];
    const outs=await Promise.all(services.map(s=>s.admit(input)));
    for(const out of outs)assert.equal(out.ok,true,'round '+round+': '+JSON.stringify(out));
    assert.equal(new Set(outs.map(out=>out.run.run_id)).size,1,'one run id');
    assert.equal(outs.filter(out=>out.action==='ADMIT').length,1,outs.map(out=>out.action).join());
    assert.deepEqual(await counts(world),{sets:1,runs:1,events:1});
  }
});

test('V5 side effects: admit and load write nothing outside the member-set and run-store tables (digest of every table and sequence)',async()=>{
  const world=await newWorld();
  const before=await digestAll();
  const input=inputOf(world);
  const first=await service.admit(input);
  assert.equal(first.ok,true,JSON.stringify(first));
  const after=await digestAll();
  assert.deepEqual(except(after,RUN_TABLES),except(before,RUN_TABLES),'no table or sequence outside the four changed');
  assert.ok(Object.keys(before).length>40,'the digest covers the schema: '+Object.keys(before).length);
  assert.equal(after.mp_member_sets.n,before.mp_member_sets.n+1);assert.equal(after.mp_member_set_members.n,before.mp_member_set_members.n+2);
  assert.equal(after.mp_research_runs.n,before.mp_research_runs.n+1);assert.equal(after.mp_research_run_events.n,before.mp_research_run_events.n+1);
  assert.equal((await service.admit(input)).action,'LOAD');
  assert.deepEqual(await digestAll(),after);
  // the refusal paths, too
  for(const over of [{seed:1.5},{parameter_slots:[1]},{fixture:false},{dataset:{...DATASET,end_time:END+60000}}]) {
    assert.equal((await admit(world,over)).ok,false);
    assert.deepEqual(except(await digestAll(),RUN_TABLES),except(before,RUN_TABLES));
  }
  // static: the module contains no SQL write at all (it writes through the member-set and run-store modules) and names no table outside the Pine Bridge reads
  const code=(await fs.readFile(serviceFile,'utf8')).replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|\s)\/\/.*$/gm,'$1');
  assert.doesNotMatch(code,/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT)\b/);
  const tables=[...code.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map(match=>match[1]).sort();
  assert.deepEqual([...new Set(tables)],['pine_bridge_evidence','pine_bridge_jobs','pine_deployments','pine_market_bars','pine_memberships','pine_source_revisions','pine_sources']
    .filter(name=>tables.includes(name)),'the module reads only Pine Bridge tables');
});

test('X4 the dataset bound is the member-admission constant: a range above it is refused before the span query, a range at it reaches the span',async()=>{
  assert.equal(MAX_DATASET_BARS,10000);
  const log=[];
  const watched=serviceOn(tapped(fx,{log}),{clock:()=>START+(MAX_DATASET_BARS+10)*60000});
  const world=await newWorld();
  const over=await admit(world,{dataset:{start_time:START,end_time:START+MAX_DATASET_BARS*60000,warmup_bars:1200}},watched);
  refusedAs(over,'INVALID_RESEARCH_DATASET');
  assert.equal(log.some(e=>/FROM pine_market_bars/.test(e.sql)),false,'no span query for a range the rules refuse');
  const at=await admit(world,{dataset:{start_time:START,end_time:START+(MAX_DATASET_BARS-1)*60000,warmup_bars:1200}},watched);
  refusedAs(at,'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
  assert.equal(log.filter(e=>/FROM pine_market_bars/.test(e.sql)).length,1,'the span query ran for the bounded range');
});

test('RD-MP-15 locks (G3, N2): T2 reads the memberships of the Bot and the member deployments FOR SHARE, so a concurrent change waits until the admission ends',async()=>{
  for(const [label,table,base,suffix,change] of [
    ['deployments','pine_deployments',DEPLOYMENT_ROWS,' FOR SHARE',world=>["UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",[world.specs[0].dep]]],
    ['memberships','pine_memberships',BOT_ROWS,' FOR SHARE OF m',world=>['UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[world.specs[0].pine]]]]) {
    const world=await newWorld();
    const log=[];
    const seen={read:null,blocked:false,doneWhileHeld:null};
    let competitor=null;
    const handle=tapped(fx,{log,onQuery:async(sql,params,run)=>{
      const rows=await run();
      // the second SERIALIZABLE transaction is T2 (the first is T1, which takes the same locks for its own snapshot)
      if(competitor===null&&begins(log)===2&&new RegExp('FROM '+table+'\\b').test(sql)) {
        seen.read=sql;
        let done=false;
        const [text,values]=change(world);
        competitor=db.query(text,values).then(()=>{done=true;});
        for(let i=0;i<150&&!done&&!seen.blocked;i++) {
          seen.blocked=(await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",['UPDATE '+table+'%'])).rows[0].n>0;
          if(!seen.blocked)await sleep(20);
        }
        seen.doneWhileHeld=done;
      }
      return rows;
    }});
    const out=await admit(world,{},serviceOn(handle));
    assert.ok(competitor!==null,label+': T2 read the table');
    await competitor;
    assert.equal(seen.read,base+suffix,label+': T2 reads the member-set store text of the table plus its lock');
    assert.equal(seen.blocked,true,label+': a concurrent UPDATE waits on the lock held by T2');
    assert.equal(seen.doneWhileHeld,false,label+': the concurrent UPDATE did not finish while T2 was open');
    assert.equal(out.ok,true,label+': '+JSON.stringify(out));
    assert.deepEqual(await counts(world),{sets:1,runs:1,events:1});
  }
});

test('N5 the dataset span uses the data profile of the execution model of ordinal 1; another profile never reaches the span query',async()=>{
  const spans=[];
  const watched=serviceOn(tapped(fx,{onQuery:(sql,params,run)=>{if(sql===CONTENT_DIGEST_SQL)spans.push(params[2]);return run();}}));
  // Evidence rows are ordered by deployment id: with reversed ids the first evidence row belongs to ordinal 2. The profile is the same either way.
  const world=await newWorld({reverseDeps:true});
  assert.ok(world.specs[1].dep<world.specs[0].dep,'the deployment of ordinal 2 sorts first');
  const out=await admit(world,{},watched);
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.deepEqual(spans,[MODEL.data_profile]);
  const row=(await db.query('SELECT contract FROM mp_research_runs WHERE run_id=$1',[out.run.run_id])).rows[0];
  assert.equal(row.contract.model.data_profile,MODEL.data_profile,'the contract carries the same profile');
  // Why the two sources are equivalent: freshness refuses any evidence whose execution model is not the one supported model, so no member can carry another profile.
  spans.length=0;
  const mixed=await newWorld({reverseDeps:true,modelOf:n=>n===2?{data_profile:'other-profile-v1'}:{}});
  refusedAs(await admit(mixed,{},watched),MP_CODES.MEMBER_EVIDENCE_MISSING,{ordinal:2,pine_import_id:mixed.specs[1].pine,reason:'UNSUPPORTED_EXECUTION_MODEL'});
  assert.deepEqual(spans,[],'refused before the span query');
  assert.equal((await counts(mixed)).runs,0);
});

test('retry bound (G4): a unique violation on another constraint and an unmapped error are not retried; the idempotency-key violation is',async()=>{
  const attempt=async(error,expect)=>{
    const world=await newWorld();
    const log=[];
    const handle=tapped(fx,{log,onQuery:(sql,params,run)=>{if(isRunInsert(sql)&&!log.thrown){log.thrown=true;throw error;}return run();}});
    const out=expect==='rethrow'?await admit(world,{},serviceOn(handle)).then(()=>null,failure=>failure):await admit(world,{},serviceOn(handle));
    return {world,log,out};
  };
  // The run store rethrows two unique violations (the idempotency key and the event key); only the first is a lost race. The event key reaches the service and is not retried.
  const event=await attempt(Object.assign(new Error('x'),{code:'23505',constraint:'mp_research_run_events_pkey'}),'rethrow');
  assert.equal(event.out?.code,'23505','a unique violation on the event key is rethrown');
  assert.equal(begins(event.log),2,'23505 on the event key: T1 and one T2 attempt, no retry');
  assert.equal(event.log.filter(isKeyLookup).length,1,'no retry lookup');
  assert.equal((await counts(event.world)).runs,0);
  // any other unique violation is a storage refusal inside the run store
  const other=await attempt(Object.assign(new Error('x'),{code:'23505',constraint:'mp_research_runs_pkey'}),'refusal');
  refusedAs(other.out,MP_CODES.INPUT_INVALID,{field:'storage'});
  assert.equal(begins(other.log),2,'23505 on another constraint: T1 and one T2 attempt');
  assert.equal((await counts(other.world)).runs,0);
  const bare=await attempt(Object.assign(new Error('x'),{code:'23505'}),'refusal');
  refusedAs(bare.out,MP_CODES.INPUT_INVALID,{field:'storage'});
  assert.equal(begins(bare.log),2,'23505 without a constraint name is not a lost key race');
  const unmapped=await attempt(injected('XX000'),'rethrow');
  assert.equal(unmapped.out?.code,'XX000','the unmapped error is rethrown');
  assert.equal(begins(unmapped.log),2,'XX000: T1 and one T2 attempt, no retry');
  assert.equal(unmapped.log.filter(isKeyLookup).length,1);
  assert.equal((await counts(unmapped.world)).runs,0);
  // control: the same shape of error on the idempotency-key constraint IS a lost race and restarts T2
  const raced=await attempt(Object.assign(new Error('x'),{code:'23505',constraint:RUN_STORE_KEY_CONSTRAINT}),'refusal');
  assert.equal(raced.out.ok,true,JSON.stringify(raced.out));
  assert.equal(begins(raced.log),3,'key violation: T1, the failed T2 and the retry');
  assert.equal(raced.log.filter(isKeyLookup).length,2);
});

/** The run store may change by exactly one run with its ADMITTED event: every other row of the four tables, the sets and their members stay as they were (V5, G6). */
async function assertRunStoreDelta(before,run_id) {
  const after=await digestAll();
  assert.deepEqual(except(after,RUN_TABLES),except(before,RUN_TABLES),'no table or sequence outside the four changed');
  assert.deepEqual(only(after,['mp_member_sets','mp_member_set_members']),only(before,['mp_member_sets','mp_member_set_members']),'the member set was loaded, not written again');
  assert.deepEqual(await rowDigest('mp_research_runs','WHERE run_id<>$1',[run_id]),before.mp_research_runs,'no other run row changed');
  assert.deepEqual(await rowDigest('mp_research_run_events','WHERE run_id<>$1',[run_id]),before.mp_research_run_events,'no event of another run was added or changed');
  assert.equal(after.mp_research_runs.n,before.mp_research_runs.n+1);
  assert.equal((await rowDigest('mp_research_run_events','WHERE run_id=$1',[run_id])).n,1,'exactly the ADMITTED event of the new run');
}

test('V5 delta (G6): a second admission of the same set changes exactly one run and its event; a write into an allowed table that is not expected is caught',async()=>{
  const world=await newWorld();
  const first=await admit(world);
  assert.equal(first.ok,true,JSON.stringify(first));
  const before=await digestAll();
  const second=await admit(world,{deadline_seconds:300});
  assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.action,'ADMIT');assert.notEqual(second.run.run_id,first.run.run_id);
  await assertRunStoreDelta(before,second.run.run_id);
  // The fixture role can only INSERT into the run store (no UPDATE or DELETE grant), so the only unexpected write it can make into an allowed place is an extra row.
  // Here a competitor appends an event to the FIRST run while the second admission runs: the counts of the new run look right, but the delta check names it.
  const mid=await digestAll();
  let injectedOnce=false;
  const handle=tapped(fx,{onQuery:async(sql,params,run)=>{
    const result=await run();
    if(isRunInsert(sql)&&!injectedOnce) {
      injectedOnce=true;
      const appended=await appendRunEvent(fx2,{owner_id:world.id,run_id:first.run.run_id,status:'RUNNING'});
      assert.equal(appended.ok,true,JSON.stringify(appended));
    }
    return result;
  }});
  const third=await admit(world,{deadline_seconds:600},serviceOn(handle));
  assert.equal(third.ok,true,JSON.stringify(third));
  assert.equal(injectedOnce,true);
  await assert.rejects(assertRunStoreDelta(mid,third.run.run_id),assert.AssertionError,'an extra event on an old run is not an admission side effect');
  // and the same write into a table outside the four is caught by the table digest
  const outside=await digestAll();
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'CONFIGURATION')",[world.id,T0+7]);
  assert.notDeepEqual(except(await digestAll(),RUN_TABLES),except(outside,RUN_TABLES));
});

test('V1 and V6 configuration: every value comes from the constructor and is checked there',()=>{
  const own=new Store(fx);
  const good={db:fx,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock:()=>NOW,engineHash:ENGINE,supported_source_hash:SUPPORTED};
  assert.ok(new MultiPineFixtureService(good));
  assert.ok(new MultiPineFixtureService({...good,clock:undefined}),'the clock defaults to Date.now');
  for(const [key,value] of [['db',null],['db',{}],['store',null],['store',new Store(fx2)],['readBotState',null],['readBotState','x'],['clock','x'],['engineHash','abc'],['engineHash',undefined],['engineHash',ENGINE.toUpperCase()],
    ['supported_source_hash','abc'],['supported_source_hash',undefined],['supported_source_hash',7]])
    assert.throws(()=>new MultiPineFixtureService({...good,[key]:value}),TypeError,key);
  assert.throws(()=>new MultiPineFixtureService(),TypeError);
  assert.equal(Object.keys(MultiPineFixtureService.prototype).length,0);
});

test('the clock must answer epoch milliseconds: a bad clock is a configuration error, not a refusal',async()=>{
  const world=await newWorld();
  for(const bad of ['now',NaN,0,-5,1.5,8.64e15+2])await assert.rejects(admit(world,{},serviceOn(fx,{clock:()=>bad})),/clock must return epoch milliseconds/,String(bad));
  assert.deepEqual(await counts(world),{sets:0,runs:0,events:0},'the clock is read before T1, so nothing is written');
});

