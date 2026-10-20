import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {migrateQuantSelection} from '../../src/postgres/quant-selection-migration.js';
import {appendExposures,readExposures,toComparisonEntries} from '../../src/postgres/exposure-register.js';
import {QUALIFICATION_VERSION} from '../../src/selection/eligibility.js';
import {registerSelection,cancelSelection,readSelection,readSearchedWindows,registrationBodyText,GUARD_REFUSALS,REGISTRATION_SLOW_LIMIT_MS} from '../../src/postgres/selection-store.js';
import {OBJECTIVE_REGISTRY,recheckWindow,transitionSelection,TRANSITIONS,INCOMPLETE_CODES,registrationHashOf} from '../../src/selection/index.js';
import {canonical} from '../../src/pine-bridge/source.js';
import {PACKAGE_FILES} from '../../src/quant-library/package-gates.js';
import {FIXTURE_LABEL,hex,T0} from '../helpers/quant-library-fixture.mjs';

// QR-4 S2-1: the registration path of the qualified-selection tables (registerSelection, cancelSelection, readSelection, readSearchedWindows),
// proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repo grants. Every row is a LABELLED FIXTURE.
// The runtime role gets its grants from scripts/grant-postgres-runtime.sql.
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002='QR002',QR003='QR003',QR004='QR004',SERIALIZATION_FAILURE='40001',DENIED='42501',CHECK_VIOLATION='23514';
let admin,db,rt,connectionString,templateName,databaseName,roleName,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
// Every selection writer is SERIALIZABLE (QR003 otherwise): the pools of the writers default to it for autocommit statements and their transactions default to it.
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantScript=async role=>(await fs.readFile(fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url)),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const track=pool=>{pools.push(pool);return pool;};
const sha=value=>createHash('sha256').update(value).digest('hex');
const dbClock=async target=>Number((await target.query('SELECT public.quant_selection_now_ms() AS n')).rows[0].n);

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_qs_tpl_'+suffix;databaseName='robot_qs_main_'+suffix;roleName='robot_qs_rt_'+suffix.slice(0,14);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
    await migrateQuantExposureRegister(builder);await migrateBestInputsPackage(builder);await migrateQuantSelection(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString:serialOf(databaseName),max:8}));
  store=new Store(db);
  await db.query(await grantScript(roleName));
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:8})));
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
    await admin.close();
  }
});

/* ---- fixtures: every row is a LABELLED FIXTURE (synthetic, never a research result) ---- */

const MS=60000,DAY=86400000,BASE=Math.floor(Date.now()/MS)*MS;
const POLICY=hex('policy'),ENGINE=hex('engine'),REAL_SCOPE='SPT_CUSTOMER_FIXTURE_SCOPE',OBJECTIVE_ID='qr4-objective-lexi-v1';
const RULES_OBJECT={maximum_drawdown_percent:'25',minimum_closed_trades_test:10};
const RULES=sha(canonical(RULES_OBJECT));
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
// OD-S3: the product registry holds null tie tolerances (the owner has not set them). Every registration here injects a TEST registry.
const TEST_REGISTRY=(()=>{const registry=structuredClone(OBJECTIVE_REGISTRY);registry[OBJECTIVE_ID].tie_tolerances.return_pp='0.5';registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp='0.5';return registry;})();
const SCOPE={market:structuredClone(MARKET),data_model:{data_profile:'spot-klines-1m',price_tick:'0.01',quantity_step:'0.00001'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'5'},
  capital:{equity:'10000',cash:'10000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const range=(fromDays,toDays)=>({start_ms:BASE-fromDays*DAY,end_ms:BASE-toDays*DAY});
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
const qualification=fixture=>({version:QUALIFICATION_VERSION,qualified:!fixture,label:fixture?'DEVELOPMENT_ONLY':'QUALIFIED',
  gates:GATES.map(gate=>({gate,name:'N_'+gate,state:fixture&&gate==='G8'?'FAIL':'PASS',code:fixture&&gate==='G8'?'QL4C_VALIDATION_NOT_AVAILABLE':null}))});
const EXPORT_SQL=`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;
const UTC=new Date(T0).toISOString();

async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:'qs-fixture'};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hex(importId),'Selection fixture','//@version=6\nindicator("x")','{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hex(JSON.stringify(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
/** A labelled fixture research run. The contract carries the source hash, the dataset start and the split that readSearchedWindows reads. */
async function newRun(owner,{source=hex('source:'+randomUUID()),start=BASE-40*DAY,split={warmup:0,train_end:600,validation_end:800,test_end:1000},status='SUCCEEDED',contract=null}={}){
  const runId='run-'+randomUUID();
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,[runId,owner.id,owner.deployment,'idem-'+runId,hex('submission'),hex('contract'),
    JSON.stringify(contract??{scope:REAL_SCOPE,label:FIXTURE_LABEL,source_hash:source,dataset:{start_time:start},split}),status,T0,T0+900000]);
  return {runId,source};
}
/** One export of a run taken through the documented path (blobs, export, files, seq 1 event, passing attempt, validation, seq 2). finish: EXPORT_VALIDATED | EXPORT_CANDIDATE | EXPORT_REFUSED. */
async function newExport(owner,run,{fixture=false,mode='ONE_PINE',finish='EXPORT_VALIDATED'}={}){
  const files=Object.fromEntries(PACKAGE_FILES.map(file=>[file,Buffer.from(FIXTURE_LABEL+'\n'+run.runId+'\n'+file+'\n')]));
  const exportId=randomUUID(),packageHash=sha(files['quant-data/manifest.json']),bindingHash=hex('binding:'+exportId);
  await db.transaction(async()=>{
    for(const bytes of Object.values(files))await db.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(bytes),bytes.length,bytes]);
    await db.query(EXPORT_SQL,[exportId,owner.id,owner.id,run.runId,null,mode,mode==='MULTI_PINE',fixture,'best-inputs-gates-v1',JSON.stringify({label:FIXTURE_LABEL}),
      JSON.stringify({owner_id:owner.id,bot_id:owner.id,run_id:run.runId,mode,fixture,created_at:UTC}),bindingHash,packageHash,JSON.stringify({gate:'B0',state:'PASS',codes:[]}),T0,UTC]);
    for(const [file,bytes] of Object.entries(files))await db.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[exportId,file,sha(bytes),bytes.length]);
    await db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,'EXPORT_CANDIDATE','{}',NULL,$2,$3)",[exportId,T0+1,UTC]);
  },{isolation:'SERIALIZABLE'});
  if(finish!=='EXPORT_CANDIDATE'){
    const attemptId='att-'+randomUUID(),pass=finish!=='EXPORT_REFUSED';
    const codes=pass?[]:['BI_NATIVE_SIGNAL_PARITY_FAILED'];
    await db.query(`INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
      VALUES($1,1,$2,$3,$4,$5,'[]','{}',$6,$7,$8)`,[exportId,attemptId,packageHash,pass,codes,hex('validator'),T0+2,UTC]);
    if(finish==='EXPORT_VALIDATED')await db.query(`INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc)
      VALUES($1,$2,$3,$4,'[]',$5,$6,$7,$8)`,[exportId,packageHash,bindingHash,attemptId,hex('validator'),fixture,T0+3,UTC]);
    await db.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,$2,$3,1,$4,$5)',[exportId,finish,codes,T0+4,UTC]);
  }
  return {exportId,packageHash,bindingHash};
}
/** The pure-module universe member of a run and its validated export (the shape src/selection/eligibility.js reads). */
function memberOf(owner,run,exp,i,{fixture=false}={}){
  const binding={mode:'ONE_PINE',fixture,pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i,membership:[{pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:hex('lock'+i)};
  const current={...structuredClone(binding),dataset_available:true,bot_owner_id:owner.id};
  return {kind:'RESEARCH_RUN',owner_id:owner.id,run_id:run.runId,export_id:exp.exportId,created_at_ms:BASE-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:run.source,market:structuredClone(MARKET),
    qualification:qualification(fixture),integrity_checked:true,
    package:{export_id:exp.exportId,package_hash:exp.packageHash,status:'EXPORT_VALIDATED',binding,current,replay_mismatch:false},
    validation_records:[{run_id:run.runId,mode:'ONE_PINE',record:{fixture,export_id:exp.exportId,package_hash:exp.packageHash,binding_hash:exp.bindingHash,validated_at_utc:UTC,
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:structuredClone(SCOPE.data_model),cost_model:structuredClone(SCOPE.cost_model),capital:structuredClone(SCOPE.capital),policy:structuredClone(SCOPE.policy),engine:ENGINE},
    library_class:'READY_FOR_REVIEW',rules_hash:RULES,rules:structuredClone(RULES_OBJECT),
    data_windows:{dataset:range(40,10),train:range(40,32),validation:range(32,26),holdout:range(26,10)},registered_boundary_ms:null};
}
/** n runs with a validated export each for one owner. */
async function newSet(owner,{n=3,fixture=false}={}){
  const runs=[],exports=[],members=[];
  for(let i=1;i<=n;i++){
    const run=await newRun(owner),exp=await newExport(owner,run,{fixture});
    runs.push(run);exports.push(exp);members.push(memberOf(owner,run,exp,i,{fixture}));
  }
  return {runs,exports,members};
}
/** The window opens startDays days after BASE, so a different startDays gives a different registration key. */
const requestOf=(owner,set,{startDays=10,fixture=false,over={}}={})=>({owner_id:owner.id,confirmed:true,fixture,scope:structuredClone(SCOPE),
  window:{kind:'PROSPECTIVE',start_ms:BASE+startDays*DAY,end_ms:BASE+startDays*DAY+1000*MS,warmup_bars:200},objective:{id:OBJECTIVE_ID},
  filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},admission_deadline_ms:BASE+startDays*DAY+1000*MS+DAY,universe:set.members,...over});
const contextOf=(owner,over={})=>({dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},universe_cap:20,requester_owner_id:owner.id,
  policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},objective_registry:TEST_REGISTRY,fixture_selections_allowed:true,...over});
const SELECTION_TABLES_SQL=['quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events'];
const counts=async target=>Object.fromEntries(await Promise.all(SELECTION_TABLES_SQL.map(async table=>[table,(await target.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
const researchDigest=async target=>(await target.query(`SELECT encode(sha256(convert_to((SELECT COALESCE(string_agg(row_to_json(j)::text,'|' ORDER BY j.run_id),'') FROM quant_jobs j)
  ||(SELECT COALESCE(string_agg(row_to_json(e)::text,'|' ORDER BY e.export_id),'') FROM bi_exports e)
  ||(SELECT COALESCE(string_agg(row_to_json(s)::text,'|' ORDER BY s.export_id,s.seq),'') FROM bi_status_events s)
  ||(SELECT COALESCE(string_agg(row_to_json(v)::text,'|' ORDER BY v.export_id),'') FROM ql4c_validation v),'UTF8')),'hex') d`)).rows[0].d;

/* ---- registration rows written outside the store (to reach a database guard the pure code would stop first) ---- */

const newKey=()=>sha('key:'+randomUUID());
/** A copy of a registration with a new selection_id and key; the hash is recomputed from the (mutated) body text. bodyText overrides the canonical text. */
function forged(reg,mutate=()=>{},bodyText=null){
  const copy=structuredClone(reg);
  copy.selection_id=randomUUID();copy.registration_key=newKey();
  mutate(copy);
  const body=bodyText?bodyText(copy):registrationBodyText({...copy,registration_hash:'x'});
  return {...copy,registration_hash:sha(body),body};
}
/**
 * Inserts the rows of one registration in the documented order, from the stored body text. options: frozen (a supplied frozen_at_ms), immediate
 * (SET CONSTRAINTS ALL IMMEDIATE first), skipUniverse (drop the last n universe rows), participantOver (columns replaced on every participant row),
 * extraParticipant (a fourth participant row {export_id,run_id,package_hash,...}), noEvent, eventOver.
 */
async function writeRows(target,reg,{frozen=null,immediate=false,skipUniverse=0,participantOver={},extraParticipant=null,noEvent=false,universeOver=null}={}){
  const body=JSON.parse(reg.body),win=reg.window;
  if(immediate)await target.query('SET CONSTRAINTS ALL IMMEDIATE');
  await target.query(`INSERT INTO public.quant_selection_registrations(selection_id,owner_id,fixture,broker,symbol,timeframe,window_kind,start_ms,end_ms,warmup_bars,
    evaluation_bars,total_bars,participant_count,admission_deadline_ms,registered_at_ms,${frozen===null?'':'frozen_at_ms,'}registration_key,registration_hash,body_canonical)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,${frozen===null?'':'$19,'}$16,$17,$18)`,
    [reg.selection_id,reg.owner_id,reg.fixture,reg.market.broker,reg.market.symbol,reg.market.timeframe,win.kind,win.start_ms,win.end_ms,win.warmup_bars,win.evaluation_bars,win.total_bars,
      reg.participant_count,reg.admission_deadline_ms,reg.registered_at_ms,reg.registration_key,reg.registration_hash,reg.body,...(frozen===null?[]:[frozen])]);
  const universe=body.universe.slice(0,body.universe.length-skipUniverse);
  for(const [index,item] of universe.entries()){
    const row={run_id:item.run_id,member_kind:item.kind,universe_status:item.status,first_code:item.code,export_id:item.export_id,...(universeOver?.(index)??{})};
    await target.query('INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [reg.selection_id,index+1,row.run_id,row.member_kind,row.universe_status,row.first_code,row.export_id]);
  }
  const chosen=[...body.participants,...(extraParticipant?[extraParticipant]:[])];
  for(const [index,item] of chosen.entries()){
    const row={export_id:item.export_id,run_id:item.run_id,package_hash:item.package_hash,source_hash:item.source_hash,rules_hash:item.rules_hash,
      validation_package_hash:item.validation_binding?.package_hash??item.package_hash,validated_at_utc:item.validation_binding?.validated_at_utc??UTC,...participantOver};
    await target.query(`INSERT INTO public.quant_selection_participants(selection_id,export_id,position,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[reg.selection_id,row.export_id,index+1,row.run_id,row.package_hash,row.source_hash,row.rules_hash,row.validation_package_hash,row.validated_at_utc]);
  }
  if(!noEvent)await target.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids)
    VALUES($1,1,'REGISTER','SELECTION_REGISTERED',NULL,NULL,NULL,'{}')`,[reg.selection_id]);
}
const commit=(reg,options)=>rt.transaction(async()=>writeRows(rt,reg,options),{isolation:'SERIALIZABLE'});
const guardFailure=(promise,constraint,code=QR004)=>assert.rejects(promise,error=>error.code===code&&(constraint===null||error.constraint===constraint),constraint);
const exists=async id=>(await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE selection_id=$1',[id])).rows[0].n;

let OWNER,SET,BASE_SELECTION,startDays=20;
/** A fresh registration of the shared owner and participant set, each with its own window (so its own key). */
const registerNext=async(over={},options={})=>{
  startDays+=1;
  return registerSelection(rt,{request:requestOf(OWNER,options.set??SET,{startDays,over,fixture:options.fixture??false}),context:contextOf(OWNER)});
};

/* ---- 1. the happy path ---- */

test('registration: stores the hashed body, stamps the database clock, replaces a supplied time and writes no research or register row',async()=>{
  OWNER=await newOwner('qs-reg');SET=await newSet(OWNER,{n:3});
  const researchBefore=await researchDigest(db),registerBefore=(await db.query('SELECT count(*)::int n FROM public.quant_exposure_register')).rows[0].n;
  const before=await dbClock(rt);
  const out=await registerSelection(rt,{request:{...requestOf(OWNER,SET,{startDays:10}),registered_at_ms:1},context:contextOf(OWNER)});
  const after=await dbClock(rt);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.attempts,1);
  BASE_SELECTION=out;
  const reg=out.registration;
  assert.ok(reg.registered_at_ms>=before&&reg.registered_at_ms<=after,'registered_at_ms is the database clock read inside the transaction, not the caller value 1');
  assert.ok(out.frozen_at_ms>=reg.registered_at_ms&&out.frozen_at_ms<=after&&out.frozen_at_ms-reg.registered_at_ms<60000,'the database stamp follows the hashed time');
  const row=(await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1',[reg.selection_id])).rows[0];
  assert.equal(sha(row.body_canonical),row.registration_hash,'the stored text hashes to registration_hash');
  assert.equal(registrationHashOf({...JSON.parse(row.body_canonical),registration_hash:row.registration_hash}),row.registration_hash,'the pure module reproduces the same hash from the parsed body');
  assert.equal(row.registration_hash,reg.registration_hash);assert.equal(row.registration_key,reg.registration_key);assert.equal(Number(row.registered_at_ms),reg.registered_at_ms);
  assert.deepEqual([row.window_kind,Number(row.start_ms),Number(row.end_ms),row.warmup_bars,row.evaluation_bars,row.total_bars],['PROSPECTIVE',reg.window.start_ms,reg.window.end_ms,200,1000,1200]);
  assert.deepEqual(await counts(db),{quant_selection_registrations:1,quant_selection_universe:3,quant_selection_participants:3,quant_selection_status_events:1});
  const read=await readSelection(rt,{owner_id:OWNER.id,selection_id:reg.selection_id});
  assert.equal(read.ok,true,JSON.stringify(read));
  const sel=read.selection;
  assert.deepEqual([sel.status,sel.seq,sel.code,sel.outcome,sel.fixture],['SELECTION_REGISTERED',1,null,null,false]);
  assert.deepEqual(sel.universe.map(item=>item.position),[1,2,3]);assert.deepEqual(sel.participants.map(item=>item.position),[1,2,3]);
  assert.deepEqual(sel.participants.map(item=>item.export_id),[...SET.exports.map(item=>item.exportId)].sort(),'participants are stored in export_id order');
  assert.deepEqual(sel.events.map(item=>[item.seq,item.event,item.status]),[[1,'REGISTER','SELECTION_REGISTERED']]);
  // The parsed registration is what the RO-12 recheck reads: it accepts it against an empty register and an empty searched list.
  const register=await readExposures(rt,{owner_id:OWNER.id,...MARKET});
  assert.equal(register.ok,true);
  const recheck=recheckWindow({registration:sel.registration,exposure_register:toComparisonEntries(register),searched_windows:[],stage:'EVALUATION_START'});
  assert.equal(recheck.ok,true,JSON.stringify(recheck));
  assert.equal(await researchDigest(db),researchBefore,'quant_jobs and the bi_* rows are byte-identical after a registration');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_exposure_register')).rows[0].n,registerBefore,'a registration is not an exposure: the register is unchanged');
});

test('registration refusals write nothing: confirmation, too few participants, an exposed window, an overlapped searched window and an unreadable searched list',async()=>{
  const owner=await newOwner('qs-refuse'),set=await newSet(owner,{n:3});
  const ask=(days,over={},useSet=set)=>registerSelection(rt,{request:requestOf(owner,useSet,{startDays:days,over}),context:contextOf(owner)});
  const before=await counts(db);
  const unconfirmed=await ask(40,{confirmed:false});
  assert.deepEqual([unconfirmed.ok,unconfirmed.code],[false,'CONFIRMATION_REQUIRED']);
  const one=await newSet(owner,{n:1});
  const few=await ask(41,{},one);
  assert.deepEqual([few.ok,few.code],[false,'QR4_TOO_FEW_PARTICIPANTS']);
  // An exposure register row of the owner and market over the window (a QR-3 comparison event) refuses with QR4_WINDOW_EXPOSED.
  const w=BASE+42*DAY;
  await db.transaction(async()=>appendExposures(db,{owner_id:owner.id,...MARKET,events:[{kind:'QR3_COMPARISON',window:{start_ms:w,end_ms:w+500*MS},comparison_id:'cmp-'+randomUUID(),
    participant_run_id:set.runs[0].runId,source_hash:set.runs[0].source}]}),{isolation:'SERIALIZABLE'});
  const exposed=await ask(42);
  assert.deepEqual([exposed.ok,exposed.code],[false,'QR4_WINDOW_EXPOSED']);
  // Another run of the owner on a participant source whose holdout covers the window: QR4_WINDOW_OVERLAPS_SEARCHED_DATA. Its train, validation
  // and holdout are read from the contract; a foreign owner's run on the same source is ignored.
  await newRun(owner,{source:set.runs[0].source,start:BASE+43*DAY-850*MS,status:'FAILED'});
  const stranger=await newOwner('qs-stranger');await newRun(stranger,{source:set.runs[1].source,start:BASE+44*DAY-850*MS});
  const searched=await ask(43);
  assert.deepEqual([searched.ok,searched.code],[false,'QR4_WINDOW_OVERLAPS_SEARCHED_DATA']);
  const clean=await ask(44);
  assert.equal(clean.ok,true,'a foreign owner run over the window does not refuse: '+JSON.stringify(clean));
  // A run of the owner on a participant source whose contract has no split makes the list unreadable: the registration is refused, not passed.
  await newRun(owner,{contract:{scope:REAL_SCOPE,source_hash:set.runs[2].source,dataset:{start_time:BASE-40*DAY}}});
  const unreadable=await ask(45);
  assert.deepEqual([unreadable.ok,unreadable.code,unreadable.detail],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE']);
  assert.deepEqual(await counts(db),{...before,quant_selection_registrations:before.quant_selection_registrations+1,quant_selection_universe:before.quant_selection_universe+3,
    quant_selection_participants:before.quant_selection_participants+3,quant_selection_status_events:before.quant_selection_status_events+1},'only the one clean registration wrote rows');
});

test('registration: a repeated key returns QR4_SELECTION_EXISTS with the existing id; prior selections count every earlier selection of the owner',async()=>{
  const first=await registerNext();assert.equal(first.ok,true,JSON.stringify(first));
  const again=await registerSelection(rt,{request:requestOf(OWNER,SET,{startDays}),context:contextOf(OWNER)});
  assert.deepEqual([again.ok,again.code,again.selection_id],[false,'QR4_SELECTION_EXISTS',first.selection_id]);
  const next=await registerNext();
  assert.equal(next.ok,true);
  assert.equal(next.registration.prior_selection_count,(await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE owner_id=$1',[OWNER.id])).rows[0].n-1,
    'every earlier selection of the owner is counted');
  assert.ok(next.registration.prior_selection_ids.includes(first.selection_id)&&next.registration.prior_selection_ids.includes(BASE_SELECTION.selection_id));
  const other=await newOwner('qs-other'),otherSet=await newSet(other,{n:2});
  const fresh=await registerSelection(rt,{request:requestOf(other,otherSet,{startDays}),context:contextOf(other)});
  assert.equal(fresh.ok,true,JSON.stringify(fresh));assert.equal(fresh.registration.prior_selection_count,0,'another owner has no prior selections');
});

test('a fixture selection stores fixture participants only; a fixture export in a customer selection is refused before any row',async()=>{
  const owner=await newOwner('qs-fix'),fixtureSet=await newSet(owner,{n:2,fixture:true}),customerSet=await newSet(owner,{n:2});
  const fixture=await registerSelection(rt,{request:requestOf(owner,fixtureSet,{startDays:60,fixture:true}),context:contextOf(owner)});
  assert.equal(fixture.ok,true,JSON.stringify(fixture));
  const read=await readSelection(rt,{owner_id:owner.id,selection_id:fixture.selection_id});assert.equal(read.selection.fixture,true);
  const mixed=await registerSelection(rt,{request:requestOf(owner,{members:[...fixtureSet.members,...customerSet.members]},{startDays:61}),context:contextOf(owner)});
  assert.equal(mixed.ok,true,'the customer selection takes the customer members and lists the fixture ones as excluded');
  assert.deepEqual(mixed.registration.participants.map(item=>item.export_id).sort(),customerSet.exports.map(item=>item.exportId).sort());
  assert.equal(mixed.registration.universe.filter(item=>item.status==='EXCLUDED').length,2);
  // an earlier FIXTURE selection of the owner is counted among the prior selections of a later customer selection
  assert.equal(fixture.registration.fixture,true);
  assert.equal(mixed.registration.prior_selection_count,1);
  assert.deepEqual(mixed.registration.prior_selection_ids,[fixture.selection_id]);
});

/* ---- 2. the database clock guard ---- */

test('registration clock (RC-S22): the hashed time must be the database time of this transaction; PROSPECTIVE starts after the stamp; a supplied frozen_at_ms is overwritten',async()=>{
  const now=await dbClock(rt),base=BASE_SELECTION.registration;
  const clock=(mutate)=>forged(base,copy=>{copy.registered_at_ms=now;mutate(copy);});
  const win=(copy,kind,start,end,warm=200)=>{const bars=(end-start)/MS;copy.window={kind,start_ms:start,end_ms:end,warmup_bars:warm,evaluation_bars:bars,total_bars:bars+warm};copy.admission_deadline_ms=end+DAY;};
  // the hashed time is after the stamp (a future registered_at_ms)
  await guardFailure(commit(forged(base,copy=>{copy.registered_at_ms=now+600000;})),'quant_selection_registration_clock');
  // more than 60 s before the stamp
  await guardFailure(commit(forged(base,copy=>{copy.registered_at_ms=now-120000;})),'quant_selection_registration_clock');
  // a PROSPECTIVE window that has already started, and one that starts exactly at an earlier instant
  await guardFailure(commit(clock(copy=>win(copy,'PROSPECTIVE',Math.floor((now-30*MS)/MS)*MS,Math.floor((now-30*MS)/MS)*MS+100*MS))),'quant_selection_registration_clock');
  // a FORWARD_PAST window that has not ended by the stamp
  await guardFailure(commit(clock(copy=>win(copy,'FORWARD_PAST',Math.floor((now+10*DAY)/MS)*MS,Math.floor((now+10*DAY)/MS)*MS+100*MS))),'quant_selection_registration_clock');
  // A FORWARD_PAST window that has ended is accepted; the supplied frozen_at_ms (1) is overwritten by the database stamp, the hashed time is kept.
  const past=clock(copy=>win(copy,'FORWARD_PAST',Math.floor((now-3*DAY)/MS)*MS,Math.floor((now-3*DAY)/MS)*MS+100*MS));
  await commit(past,{frozen:1});
  const row=(await db.query('SELECT frozen_at_ms,registered_at_ms FROM public.quant_selection_registrations WHERE selection_id=$1',[past.selection_id])).rows[0];
  assert.ok(Number(row.frozen_at_ms)>=now&&Number(row.frozen_at_ms)<=await dbClock(rt),'the stamp is the database clock, not 1');
  assert.equal(Number(row.registered_at_ms),now,'the hashed registration time is never overwritten');
});

test('body checks: a missing tie tolerance, a body that disagrees with a column, a hash that is not the text hash, a hash key and an oversized body are CHECK violations',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  // The columns keep the registered values; only the hashed body is changed, so the body-to-column checks are what refuses.
  const bodyOnly=change=>forged(base,copy=>{copy.registered_at_ms=now;},copy=>{const body=JSON.parse(registrationBodyText({...copy,registration_hash:'x'}));change(body);return canonical(body);});
  const check=async(reg,name)=>{await assert.rejects(commit(reg),error=>error.code===CHECK_VIOLATION&&error.constraint===name,name);assert.equal(await exists(reg.selection_id),0,name);};
  await check(bodyOnly(body=>{delete body.objective.tie_tolerance_return_pp;}),'quant_selection_registrations_body_tolerance_return_check');
  await check(bodyOnly(body=>{body.objective.tie_tolerance_drawdown_pp=null;}),'quant_selection_registrations_body_tolerance_drawdown_check');
  await check(bodyOnly(body=>{body.objective.tie_tolerance_return_pp='-1';}),'quant_selection_registrations_body_tolerance_return_check');
  await check(bodyOnly(body=>{body.owner_id=randomUUID();}),'quant_selection_registrations_body_owner_check');
  await check(bodyOnly(body=>{body.selection_id=randomUUID();}),'quant_selection_registrations_body_selection_check');
  await check(bodyOnly(body=>{body.version='qr4-registration-v2';}),'quant_selection_registrations_body_version_check');
  await check(bodyOnly(body=>{body.fixture=true;}),'quant_selection_registrations_body_fixture_check');
  await check(bodyOnly(body=>{body.registration_key=hex('other-key');}),'quant_selection_registrations_body_key_check');
  await check(bodyOnly(body=>{body.registered_at_ms+=1;}),'quant_selection_registrations_body_registered_check');
  await check(bodyOnly(body=>{body.admission_deadline_ms+=MS;}),'quant_selection_registrations_body_deadline_check');
  await check(bodyOnly(body=>{body.participant_count=2;}),'quant_selection_registrations_body_participants_check');
  await check(bodyOnly(body=>{body.prior_selection_count=9;}),'quant_selection_registrations_body_prior_check');
  await check(bodyOnly(body=>{body.window.end_ms+=MS;}),'quant_selection_registrations_body_window_check');
  await check(bodyOnly(body=>{body.market.symbol='ETHUSDT';}),'quant_selection_registrations_body_market_check');
  const hashMismatch=forged(base,copy=>{copy.registered_at_ms=now;});hashMismatch.registration_hash=sha('other');
  await check(hashMismatch,'quant_selection_registrations_body_hash_check');
  await check(bodyOnly(body=>{body.registration_hash=hex('h');}),'quant_selection_registrations_body_no_hash_check');
  await check(bodyOnly(body=>{body.note='x'.repeat(262200);}),'quant_selection_registrations_body_size_check');
  // the market columns are a CHECK too
  const market=forged(base,copy=>{copy.registered_at_ms=now;copy.market={...copy.market,symbol:'ETHUSDT'};});
  await check(market,'quant_selection_registrations_market_check');
});

/* ---- 3. the deferred completeness check C1 and the participant guard ---- */

test('C1 quant_selection_registration_complete: every incomplete or inconsistent registration fails at commit and leaves no row; SET CONSTRAINTS ALL IMMEDIATE fails closed',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  const reg=()=>forged(base,copy=>{copy.registered_at_ms=now;});
  const cases={
    'a universe row is missing':[reg(),{skipUniverse:1}],
    'a universe row disagrees with the body':[reg(),{universeOver:index=>index===0?{universe_status:'EXCLUDED',first_code:'QR4_PARTICIPANT_NOT_READY'}:{}}],
    'a participant row disagrees with the body':[reg(),{participantOver:{rules_hash:hex('other-rules')}}],
    'the seq 1 event is missing':[reg(),{noEvent:true}],
    'SET CONSTRAINTS ALL IMMEDIATE runs the check before the children exist':[reg(),{immediate:true}]};
  for(const [label,[registration,options]] of Object.entries(cases)){
    await guardFailure(commit(registration,options),'quant_selection_registration_complete');
    assert.equal(await exists(registration.selection_id),0,label+': nothing was left behind');
  }
  // an extra, valid participant row that the body does not name is stopped by the member guard before the commit check (defence in depth)
  const extraSet=await newSet(OWNER,{n:1}),extra=extraSet.members[0];
  const withExtra=reg();
  await guardFailure(commit(withExtra,{extraParticipant:{export_id:extra.export_id,run_id:extra.run_id,package_hash:extra.package.package_hash,source_hash:extra.source_hash,rules_hash:RULES,
    validation_binding:{package_hash:extra.package.package_hash,validated_at_utc:UTC}}}),'quant_selection_participant_member');
  assert.equal(await exists(withExtra.selection_id),0);
  // a register row of the selection exists before the commit: a registration commits before any exposure
  const exposed=reg();
  await guardFailure(rt.transaction(async()=>{
    const appended=await appendExposures(rt,{owner_id:OWNER.id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:BASE+90*DAY,end_ms:BASE+90*DAY+MS},selection_id:exposed.selection_id}]});
    assert.equal(appended.ok,true);
    await writeRows(rt,exposed);
  },{isolation:'SERIALIZABLE'}),'quant_selection_registration_complete');
  assert.equal(await exists(exposed.selection_id),0);
  assert.equal((await db.query("SELECT count(*)::int n FROM public.quant_exposure_register WHERE selection_id=$1",[exposed.selection_id])).rows[0].n,0,'the register row rolled back with it');
  // the complete registration commits
  const good=reg();await commit(good);assert.equal(await exists(good.selection_id),1);
});

test('participant guard (QR004 quant_selection_participant_ready): a non-validated, foreign, mode, fixture, hash or run mismatch export is refused; the pure check is not the only defence',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  const reg=()=>forged(base,copy=>{copy.registered_at_ms=now;});
  const stranger=await newOwner('qs-pg-stranger');
  const run=await newRun(OWNER),good=await newExport(OWNER,run);
  const candidateRun=await newRun(OWNER),candidate=await newExport(OWNER,candidateRun,{finish:'EXPORT_CANDIDATE'});
  const refusedRun=await newRun(OWNER),refusedExport=await newExport(OWNER,refusedRun,{finish:'EXPORT_REFUSED'});
  const foreignRun=await newRun(stranger),foreign=await newExport(stranger,foreignRun);
  const fixtureRun=await newRun(OWNER),fixtureExport=await newExport(OWNER,fixtureRun,{fixture:true});
  const multiRun=await newRun(OWNER),multi=await newExport(OWNER,multiRun,{mode:'MULTI_PINE',finish:'EXPORT_INTERNAL'});
  const row=(exp,runId,over={})=>({export_id:exp.exportId,run_id:runId,package_hash:exp.packageHash,validation_package_hash:exp.packageHash,...over});
  const refusals={
    'export still EXPORT_CANDIDATE':row(candidate,candidateRun.runId),
    'export EXPORT_REFUSED':row(refusedExport,refusedRun.runId),
    'export of another owner':row(foreign,foreignRun.runId),
    'fixture export in a customer selection':row(fixtureExport,fixtureRun.runId),
    'multi-Pine export':row(multi,multiRun.runId),
    'package_hash that is not the export package_hash':row(good,run.runId,{package_hash:hex('wrong'),validation_package_hash:hex('wrong')}),
    'run that is not the export run':row(good,base.participants[0].run_id),
    'export that does not exist':row({exportId:randomUUID(),packageHash:hex('none')},run.runId),
    'validated_at_utc that differs from the ql4c_validation row':{validated_at_utc:'2026-10-18T10:00:00Z'}};
  for(const [label,participantOver] of Object.entries(refusals)){
    const registration=reg();
    await assert.rejects(commit(registration,{participantOver}),error=>error.code===QR004&&error.constraint==='quant_selection_participant_ready',label);
    assert.equal(await exists(registration.selection_id),0,label);
  }
  // A valid, validated export of the right owner passes the readiness rules but is not the participant of the hashed body at that position: participant_member.
  const outsider=reg();
  await assert.rejects(commit(outsider,{participantOver:row(good,run.runId)}),error=>error.code===QR004&&error.constraint==='quant_selection_participant_member');
  assert.equal(await exists(outsider.selection_id),0);
  // A participant row with the body export_id and package_hash but another run_id: the export belongs to that other run, so readiness passes and the member guard refuses.
  const realRunId=base.participants[0].run_id,otherRun=await newRun(OWNER);
  const wrongRun=forged(base,copy=>{copy.registered_at_ms=now;copy.participants[0].run_id=otherRun.runId;});
  await assert.rejects(commit(wrongRun,{participantOver:{run_id:realRunId}}),error=>error.code===QR004&&error.constraint==='quant_selection_participant_member','run_id differs from the body');
  assert.equal(await exists(wrongRun.selection_id),0);
});

test('participant guard (QR004 quant_selection_participant_member): no participant row can be appended to a registration, committed or still open',async()=>{
  const outer=await newOwner('qs-pm'),pmSet=await newSet(outer,{n:3}),extraSet=await newSet(outer,{n:1});
  const selection=await registerSelection(rt,{request:requestOf(outer,pmSet,{startDays:30}),context:contextOf(outer)});
  assert.equal(selection.ok,true,JSON.stringify(selection));
  const extra=extraSet.exports[0],extraRun=extraSet.runs[0];
  const append=(target,id,position,over={})=>target.query(`INSERT INTO public.quant_selection_participants(selection_id,export_id,position,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$5,$8)`,[id,over.export_id??extra.exportId,position,over.run_id??extraRun.runId,over.package_hash??extra.packageHash,hex('s'),RULES,over.validated_at_utc??UTC]);
  // after the commit: the next position (participant_count + 1), and positions outside 1 to the count
  await guardFailure(append(rt,selection.selection_id,4),'quant_selection_participant_member');
  await guardFailure(append(rt,selection.selection_id,0),'quant_selection_participant_member');
  await guardFailure(append(rt,selection.selection_id,-1),'quant_selection_participant_member');
  // a position inside the count with another export than the body names
  await guardFailure(append(rt,selection.selection_id,1),'quant_selection_participant_member');
  // the same inside the registration transaction after SET CONSTRAINTS ALL IMMEDIATE ran the deferred check C1 on a complete registration
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  const open=forged(base,copy=>{copy.registered_at_ms=now;});
  const ownRun=await newRun(OWNER),ownExtra=await newExport(OWNER,ownRun);
  await guardFailure(rt.transaction(async()=>{
    await writeRows(rt,open);
    await rt.query('SET CONSTRAINTS ALL IMMEDIATE');
    await rt.query('SET CONSTRAINTS ALL DEFERRED');
    await append(rt,open.selection_id,4,{export_id:ownExtra.exportId,run_id:ownRun.runId,package_hash:ownExtra.packageHash});
  },{isolation:'SERIALIZABLE'}),'quant_selection_participant_member');
  assert.equal(await exists(open.selection_id),0);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_participants WHERE selection_id=$1',[selection.selection_id])).rows[0].n,3,'the committed selection kept its three participants');
});

test('TEMP shadows: a session TEMP table named like bi_exports, bi_status_events, ql4c_validation or quant_exposure_register fools no guard',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  const reg=()=>forged(base,copy=>{copy.registered_at_ms=now;});
  const stranger=await newOwner('qs-shadow-stranger'),foreignRun=await newRun(stranger),foreign=await newExport(stranger,foreignRun);
  const candidateRun=await newRun(OWNER),candidate=await newExport(OWNER,candidateRun,{finish:'EXPORT_CANDIDATE'});
  const goodRun=await newRun(OWNER),good=await newExport(OWNER,goodRun);
  const row=(exp,runId,over={})=>({export_id:exp.exportId,run_id:runId,package_hash:exp.packageHash,validation_package_hash:exp.packageHash,...over});
  const shadow=async(statements,registration,options)=>{
    const outcome=rt.transaction(async()=>{for(const statement of statements)await rt.query(statement[0],statement[1]??[]);await writeRows(rt,registration,options);},{isolation:'SERIALIZABLE'});
    await assert.rejects(outcome,error=>error.code===QR004&&error.constraint==='quant_selection_participant_ready');
    assert.equal(await exists(registration.selection_id),0);
  };
  // bi_exports: a TEMP row claims the export of another owner belongs to the selection owner
  await shadow([['CREATE TEMP TABLE bi_exports(export_id uuid,owner_id text,run_id text,mode text,fixture boolean,package_hash text) ON COMMIT DROP'],
    ["INSERT INTO bi_exports VALUES($1,$2,$3,'ONE_PINE',false,$4)",[foreign.exportId,OWNER.id,foreignRun.runId,foreign.packageHash]]],reg(),{participantOver:row(foreign,foreignRun.runId)});
  // bi_status_events: a TEMP row claims the candidate export is validated
  await shadow([['CREATE TEMP TABLE bi_status_events(export_id uuid,seq integer,status text) ON COMMIT DROP'],
    ["INSERT INTO bi_status_events VALUES($1,99,'EXPORT_VALIDATED')",[candidate.exportId]]],reg(),{participantOver:row(candidate,candidateRun.runId)});
  // ql4c_validation: a TEMP row carries the validated_at_utc that the public row does not
  await shadow([['CREATE TEMP TABLE ql4c_validation(export_id uuid,package_hash text,fixture boolean,validated_at_utc text) ON COMMIT DROP'],
    ["INSERT INTO ql4c_validation VALUES($1,$2,false,'2026-10-18T10:00:00Z')",[good.exportId,good.packageHash]]],reg(),
    {participantOver:row(good,goodRun.runId,{validated_at_utc:'2026-10-18T10:00:00Z'})});
  // quant_exposure_register: the check C1 reads the public register, which already holds a QR4_SELECTION row of the selection id
  const exposed=reg();
  await db.transaction(async()=>appendExposures(db,{owner_id:OWNER.id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:BASE+130*DAY,end_ms:BASE+130*DAY+MS},selection_id:exposed.selection_id}]}),{isolation:'SERIALIZABLE'});
  await guardFailure(rt.transaction(async()=>{
    await rt.query('CREATE TEMP TABLE quant_exposure_register(kind text,selection_id text) ON COMMIT DROP');
    await writeRows(rt,exposed);
  },{isolation:'SERIALIZABLE'}),'quant_selection_registration_complete');
  assert.equal(await exists(exposed.selection_id),0);
});

test('universe guard (QR004 quant_selection_universe_member): a row without a registration and a position beyond the registered universe are refused',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  await guardFailure(rt.transaction(async()=>{
    await rt.query("INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,1,'run-x','RESEARCH_RUN','EXCLUDED','QR4_PARTICIPANT_NOT_READY',NULL)",[randomUUID()]);
  },{isolation:'SERIALIZABLE'}),'quant_selection_universe_member');
  const copy=forged(base,c=>{c.registered_at_ms=now;});
  await guardFailure(rt.transaction(async()=>{
    await writeRows(rt,copy);
    await rt.query("INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,99,'run-extra','RESEARCH_RUN','EXCLUDED','QR4_PARTICIPANT_NOT_READY',NULL)",[copy.selection_id]);
  },{isolation:'SERIALIZABLE'}),'quant_selection_universe_member');
  assert.equal(await exists(copy.selection_id),0);
  // a pinned (committed) registration takes no further universe row
  const before=(await db.query('SELECT count(*)::int n FROM public.quant_selection_universe WHERE selection_id=$1',[BASE_SELECTION.selection_id])).rows[0].n;
  await guardFailure(rt.query("INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,$2,'run-late','RESEARCH_RUN','EXCLUDED','QR4_PARTICIPANT_NOT_READY',NULL)",
    [BASE_SELECTION.selection_id,before+1]),'quant_selection_universe_member');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_universe WHERE selection_id=$1',[BASE_SELECTION.selection_id])).rows[0].n,before);
});

test('C1: a body whose universe and participants disagree fails at commit, in both directions',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt);
  const exactly=/exactly the universe members/;
  const refusedWith=(registration)=>assert.rejects(commit(registration),error=>error.code===QR004&&error.constraint==='quant_selection_registration_complete'&&exactly.test(error.message));
  // a universe member with the status PARTICIPANT that has no participant row (the body names two participants, the universe three PARTICIPANT members)
  const fewer=forged(base,copy=>{copy.registered_at_ms=now;copy.participant_count=2;copy.participants=copy.participants.slice(0,2);});
  await refusedWith(fewer);assert.equal(await exists(fewer.selection_id),0);
  // a participant row whose universe member is not a PARTICIPANT
  const demoted=forged(base,copy=>{copy.registered_at_ms=now;const item=copy.universe.find(member=>member.run_id===copy.participants[0].run_id);item.status='EXCLUDED';item.code='QR4_PARTICIPANT_NOT_READY';});
  await refusedWith(demoted);assert.equal(await exists(demoted.selection_id),0);
});

/* ---- 4. status transitions (the pinned SQL table against the pure module) ---- */

const probeInsert=async(event,status,code,outcome=null,seq=2,selection=null)=>{
  await rt.query('SAVEPOINT probe');
  try{
    await rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,$2,$3,$4,$5,NULL,$6,'{}')`,[selection,seq,event,status,code,outcome]);
    return {ok:true};
  }catch(error){return {ok:false,code:error.code,constraint:error.constraint};}
  finally{await rt.query('ROLLBACK TO SAVEPOINT probe');await rt.query('RELEASE SAVEPOINT probe');}
};

test('transitions: from SELECTION_REGISTERED the database accepts exactly what the pure lifecycle accepts; FIRST_EVALUATION_START is refused until S2-2',async()=>{
  const selection=(await registerNext());assert.equal(selection.ok,true);
  const events=['FIRST_EVALUATION_START','OWNER_CANCEL','PARTICIPANT_INELIGIBLE','WINDOW_RECHECK_FAILED','DEADLINE_PASSED','WINDOW_DATA_UNAVAILABLE','ALL_EVALUATIONS_DONE'];
  const statuses=['SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED'];
  const codes=[...new Set([...INCOMPLETE_CODES,...TRANSITIONS.flatMap(row=>row.codes??[]),'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','QR4_TRANSITION_INVALID'])];
  let accepted=0,refusedN=0;
  await rt.transaction(async()=>{
    for(const event of events)for(const status of statuses)for(const code of [null,...codes]){
      // Only tuples that satisfy the table CHECKs reach the guard: a code exactly for SELECTION_INCOMPLETE and an outcome exactly for SELECTION_COMPLETED.
      if((status==='SELECTION_INCOMPLETE')!==(code!==null))continue;
      const outcome=status==='SELECTION_COMPLETED'?'BEST_IN_SCOPE':null;
      const decided=transitionSelection('SELECTION_REGISTERED',{kind:event,to:status,code,outcome});
      const pureOk=decided.ok===true&&decided.to===status&&(decided.code??null)===code;
      const got=await probeInsert(event,status,code,outcome,2,selection.selection_id);
      const label=[event,status,code].join(' ');
      if(event==='FIRST_EVALUATION_START'&&pureOk){
        assert.deepEqual([got.ok,got.code,got.constraint],[false,QR004,'quant_selection_exposure_bind'],label);refusedN++;continue;
      }
      if(pureOk){assert.equal(got.ok,true,label+' '+JSON.stringify(got));accepted++;}
      else{assert.deepEqual([got.ok,got.code,got.constraint],[false,QR004,'quant_selection_status_transition'],label);refusedN++;}
    }
  },{isolation:'SERIALIZABLE'});
  assert.equal(accepted,6,'OWNER_CANCEL, PARTICIPANT_INELIGIBLE, two WINDOW_RECHECK_FAILED codes, DEADLINE_PASSED and WINDOW_DATA_UNAVAILABLE leave SELECTION_REGISTERED');
  assert.ok(refusedN>100);
});

test('transitions: every reachable edge commits and moves the status; seq must be last + 1; nothing follows a terminal status; a second REGISTER is refused',async()=>{
  const edges=[['OWNER_CANCEL','SELECTION_CANCELLED',null],['PARTICIPANT_INELIGIBLE','SELECTION_INCOMPLETE','QR4_PARTICIPANT_STALE'],['WINDOW_RECHECK_FAILED','SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED'],
    ['WINDOW_RECHECK_FAILED','SELECTION_INCOMPLETE','QR4_WINDOW_OVERLAPS_SEARCHED_DATA'],['DEADLINE_PASSED','SELECTION_INCOMPLETE','QR4_ADMISSION_REFUSED'],
    ['WINDOW_DATA_UNAVAILABLE','SELECTION_INCOMPLETE','QR4_WINDOW_DATA_UNAVAILABLE']];
  for(const [event,status,code] of edges){
    const selection=await registerNext();assert.equal(selection.ok,true);
    await rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,2,$2,$3,$4,NULL,NULL,'{}')`,[selection.selection_id,event,status,code]);
    const read=await readSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id});
    assert.deepEqual([read.selection.status,read.selection.code,read.selection.seq],[status,code,2],[event,code].join(' '));
    // terminal: nothing follows, whatever the tuple
    await guardFailure(rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,3,'OWNER_CANCEL','SELECTION_CANCELLED',NULL,NULL,NULL,'{}')`,[selection.selection_id]),'quant_selection_status_transition');
    const cancelled=await cancelSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id,confirmed:true});
    assert.deepEqual([cancelled.ok,cancelled.code],[false,'QR4_TRANSITION_INVALID'],'the owner cannot cancel a terminal selection');
  }
  const open=await registerNext();
  await guardFailure(rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,3,'OWNER_CANCEL','SELECTION_CANCELLED',NULL,NULL,NULL,'{}')`,[open.selection_id]),'quant_selection_status_transition');
  // a repeated seq 1 and a second REGISTER meet the guard before the table CHECKs
  await guardFailure(rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,1,'OWNER_CANCEL','SELECTION_CANCELLED',NULL,NULL,NULL,'{}')`,[open.selection_id]),'quant_selection_status_transition');
  await guardFailure(rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,2,'REGISTER','SELECTION_REGISTERED',NULL,NULL,NULL,'{}')`,[open.selection_id]),'quant_selection_status_transition');
  // an event of a selection that has no registration, and a status event with a supplied at_ms (overwritten)
  await guardFailure(rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,1,'REGISTER','SELECTION_REGISTERED',NULL,NULL,NULL,'{}')`,[randomUUID()]),'quant_selection_status_transition');
  await rt.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids,at_ms) VALUES($1,2,'OWNER_CANCEL','SELECTION_CANCELLED',NULL,NULL,NULL,'{}',5)`,[open.selection_id]);
  const stamped=(await db.query('SELECT at_ms FROM public.quant_selection_status_events WHERE selection_id=$1 AND seq=2',[open.selection_id])).rows[0].at_ms;
  assert.ok(Number(stamped)>BASE-DAY,'the database stamped at_ms (a supplied 5 is overwritten)');
});

test('the SQL transition table equals TRANSITIONS and INCOMPLETE_CODES of src/selection/lifecycle.js (pin test)',async()=>{
  const derived=[];
  for(const row of TRANSITIONS)for(const to of Array.isArray(row.to)?row.to:[row.to])for(const code of to==='SELECTION_INCOMPLETE'?row.codes:[''])derived.push([row.from??'',row.event,to,code].join('>'));
  const stored=(await db.query('SELECT public.quant_selection_transitions() AS t')).rows[0].t;
  assert.deepEqual([...stored].sort(),[...derived].sort());
  assert.equal(new Set(stored).size,stored.length,'no tuple is listed twice');
  for(const code of INCOMPLETE_CODES)assert.ok(stored.includes('SELECTION_EVALUATING>ALL_EVALUATIONS_DONE>SELECTION_INCOMPLETE>'+code),code);
  assert.ok(!stored.some(item=>item.includes('QR4_EXPOSURE_REGISTRY_UNAVAILABLE')),'an unreadable register never ends a selection');
});

/* ---- 5. cancel and the owner-scoped read ---- */

test('cancel: needs the confirm token, the owner and a non-terminal status; the registration and the research rows stay untouched',async()=>{
  const selection=await registerNext();assert.equal(selection.ok,true);
  const stranger=await newOwner('qs-cancel-stranger');
  const research=await researchDigest(db),registrationRow=(await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1',[selection.selection_id])).rows[0];
  assert.deepEqual((await cancelSelection(rt,{owner_id:stranger.id,selection_id:selection.selection_id,confirmed:true})).code,'NOT_FOUND');
  assert.equal((await cancelSelection(rt,{owner_id:OWNER.id,selection_id:randomUUID(),confirmed:true})).code,'NOT_FOUND');
  assert.equal((await cancelSelection(rt,{owner_id:OWNER.id,selection_id:'not-a-uuid',confirmed:true})).code,'NOT_FOUND');
  assert.equal((await cancelSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id})).code,'CONFIRMATION_REQUIRED');
  assert.equal((await readSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id})).selection.status,'SELECTION_REGISTERED');
  const done=await cancelSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id,confirmed:true});
  assert.deepEqual([done.ok,done.status,done.seq],[true,'SELECTION_CANCELLED',2]);
  const again=await cancelSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id,confirmed:true});
  assert.deepEqual([again.ok,again.code],[false,'QR4_TRANSITION_INVALID']);
  const read=await readSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id});
  assert.deepEqual([read.selection.status,read.selection.seq],['SELECTION_CANCELLED',2]);assert.deepEqual(read.selection.events.map(item=>item.event),['REGISTER','OWNER_CANCEL']);
  assert.deepEqual((await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1',[selection.selection_id])).rows[0],registrationRow,'the registration row is unchanged');
  assert.equal(await researchDigest(db),research);
});

test('a concurrent cancel and a terminal event end with one terminal event and QR4_TRANSITION_INVALID for the other',async()=>{
  const selection=await registerNext();assert.equal(selection.ok,true);
  const results=await Promise.all([cancelSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id,confirmed:true}),
    cancelSelection(rt,{owner_id:OWNER.id,selection_id:selection.selection_id,confirmed:true})]);
  assert.equal(results.filter(item=>item.ok).length,1,JSON.stringify(results));
  assert.equal(results.find(item=>!item.ok).code,'QR4_TRANSITION_INVALID');
  assert.equal((await db.query("SELECT count(*)::int n FROM public.quant_selection_status_events WHERE selection_id=$1 AND status='SELECTION_CANCELLED'",[selection.selection_id])).rows[0].n,1);
});

test('readSelection: absent and foreign selections are the same NOT_FOUND; an altered or unreadable body is INTEGRITY_CHECK_FAILED',async()=>{
  const stranger=await newOwner('qs-read-stranger');
  const absent=await readSelection(rt,{owner_id:OWNER.id,selection_id:randomUUID()}),foreign=await readSelection(rt,{owner_id:stranger.id,selection_id:BASE_SELECTION.selection_id});
  assert.deepEqual([absent.ok,absent.code,absent.detail],[foreign.ok,foreign.code,foreign.detail]);assert.equal(absent.code,'NOT_FOUND');
  assert.equal((await readSelection(rt,{owner_id:OWNER.id,selection_id:'x'})).code,'NOT_FOUND');
  // The read runs in one READ ONLY snapshot: its first statement is SET TRANSACTION READ ONLY, and a write after that statement is refused by the server.
  const seen=[];const spy=Object.create(rt);spy.query=(sql,params)=>{seen.push(String(sql));return rt.query(sql,params);};
  const spied=await readSelection(spy,{owner_id:OWNER.id,selection_id:BASE_SELECTION.selection_id});
  assert.equal(spied.ok,true);assert.equal(seen[0],'SET TRANSACTION READ ONLY');
  await assert.rejects(rt.transaction(async()=>{
    await rt.query('SET TRANSACTION READ ONLY');
    await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,2,'OWNER_CANCEL','SELECTION_CANCELLED',NULL,NULL,NULL,'{}')",[BASE_SELECTION.selection_id]);
  },{isolation:'REPEATABLE READ'}),{code:'25006'});
  // A body whose text hashes to its registration_hash but is not the neutral-order canonical text of the pure module: the recomputed hash differs.
  const now=await dbClock(rt);
  const unsorted=forged(BASE_SELECTION.registration,copy=>{copy.registered_at_ms=now;},copy=>{
    const body=JSON.parse(registrationBodyText({...copy,registration_hash:'x'}));body.participants.reverse();return canonical(body);});
  await commit(unsorted);
  const read=await readSelection(rt,{owner_id:OWNER.id,selection_id:unsorted.selection_id});
  assert.deepEqual([read.ok,read.code,read.detail],[false,'INTEGRITY_CHECK_FAILED','REGISTRATION_HASH']);
});

test('readSelection: universe or participant rows that differ from the hashed body are INTEGRITY_CHECK_FAILED ROWS_DIFFER_FROM_BODY',async()=>{
  const id=BASE_SELECTION.selection_id;
  const tampered=(match,change)=>{const spy=Object.create(rt);spy.query=async(sql,params)=>{const result=await rt.query(sql,params);
    return String(sql).includes(match)?{...result,rows:change(result.rows.map(item=>({...item})))}:result;};return spy;};
  const U='FROM public.quant_selection_universe',P='FROM public.quant_selection_participants';
  const cases={
    'a universe row is missing':[U,rows=>rows.slice(0,-1)],
    'an extra universe row':[U,rows=>[...rows,{...rows[0],position:rows.length+1,run_id:'run-extra'}]],
    'a universe run_id differs':[U,rows=>{rows[0].run_id='run-other';return rows;}],
    'a universe status differs':[U,rows=>{rows[0].universe_status='EXCLUDED';return rows;}],
    'the universe positions are swapped':[U,rows=>[rows[1],rows[0],...rows.slice(2)]],
    'a participant row is missing':[P,rows=>rows.slice(1)],
    'a participant package_hash differs':[P,rows=>{rows[0].package_hash=hex('other');return rows;}],
    'a participant validated_at_utc differs':[P,rows=>{rows[2].validated_at_utc='2026-10-18T10:00:00Z';return rows;}],
    'a participant rules_hash differs':[P,rows=>{rows[1].rules_hash=hex('other');return rows;}]};
  for(const [label,[match,change]] of Object.entries(cases)){
    const read=await readSelection(tampered(match,change),{owner_id:OWNER.id,selection_id:id});
    assert.deepEqual([read.ok,read.code,read.detail],[false,'INTEGRITY_CHECK_FAILED','ROWS_DIFFER_FROM_BODY'],label);
  }
  assert.equal((await readSelection(tampered(U,rows=>rows),{owner_id:OWNER.id,selection_id:id})).ok,true,'unchanged rows are accepted');
});

/* ---- 6. the searched-window reader ---- */

test('readSearchedWindows: three half-open windows per run from the dataset start, every status, own runs on the given sources only; anything unreadable gives null',async()=>{
  const owner=await newOwner('qs-sw'),other=await newOwner('qs-sw-other');
  const source=hex('sw-source'),start=BASE-30*DAY;
  const failed=await newRun(owner,{source,start,status:'FAILED'}),queued=await newRun(owner,{source,start:start+DAY,status:'QUEUED',split:{warmup:5,train_end:10,validation_end:20,test_end:30}});
  await newRun(owner,{source:hex('sw-elsewhere'),start});await newRun(other,{source,start});
  const entries=await readSearchedWindows(rt,{owner_id:owner.id,source_hashes:[source]});
  assert.equal(entries.length,6);
  const of=run=>entries.filter(item=>item.run_id===run.runId).map(item=>[item.window.start_ms,item.window.end_ms]);
  assert.deepEqual(of(failed),[[start,start+600*MS],[start+600*MS,start+800*MS],[start+800*MS,start+1000*MS]],'train from the dataset start (warm-up included), validation, holdout');
  assert.deepEqual(of(queued),[[start+DAY,start+DAY+10*MS],[start+DAY+10*MS,start+DAY+20*MS],[start+DAY+20*MS,start+DAY+30*MS]]);
  assert.ok(entries.every(item=>item.owner_id===owner.id&&item.source_hash===source&&item.kind==='RESEARCH_RUN'));
  assert.deepEqual(await readSearchedWindows(rt,{owner_id:owner.id,source_hashes:[hex('sw-none')]}),[],'a source without runs gives an empty, readable list');
  for(const [label,input] of [['no sources',{owner_id:owner.id,source_hashes:[]}],['sources not an array',{owner_id:owner.id,source_hashes:'x'}],['no owner',{source_hashes:[source]}],['an empty source',{owner_id:owner.id,source_hashes:['']}]])
    assert.equal(await readSearchedWindows(rt,input),null,label);
  const broken=[['no split',{scope:REAL_SCOPE,source_hash:source,dataset:{start_time:start}}],['no dataset start',{scope:REAL_SCOPE,source_hash:source,dataset:{},split:{train_end:1,validation_end:2,test_end:3}}],
    ['non-increasing split',{scope:REAL_SCOPE,source_hash:source,dataset:{start_time:start},split:{train_end:5,validation_end:5,test_end:9}}],
    ['zero train',{scope:REAL_SCOPE,source_hash:source,dataset:{start_time:start},split:{train_end:0,validation_end:5,test_end:9}}],
    ['fractional split',{scope:REAL_SCOPE,source_hash:source,dataset:{start_time:start},split:{train_end:1.5,validation_end:5,test_end:9}}]];
  for(const [label,contract] of broken){
    const probe=await newOwner('qs-sw-broken');await newRun(probe,{contract});
    assert.equal(await readSearchedWindows(rt,{owner_id:probe.id,source_hashes:[source]}),null,label);
  }
});

/* ---- 7. concurrency (SSI, 40001 retry) ---- */

const barrier=count=>{let waiting=0,open;const gate=new Promise(resolve=>{open=resolve;});return async()=>{if(++waiting>=count)open();await gate;};};

test('two concurrent registrations of one owner with different keys serialize: one sees no prior selection and the other, after a 40001 retry, sees it',async()=>{
  const owner=await newOwner('qs-race'),set=await newSet(owner,{n:3});
  const wait=barrier(2);
  const run=days=>registerSelection(rt,{request:requestOf(owner,set,{startDays:days}),context:contextOf(owner),readInputs:async()=>{await wait();return null;}});
  const results=await Promise.all([run(70),run(71)]);
  assert.ok(results.every(item=>item.ok),JSON.stringify(results.map(item=>item.code??item.attempts)));
  assert.deepEqual(results.map(item=>item.registration.prior_selection_count).sort(),[0,1],'the rw cycle ends one writer with 40001; its retry sees the other registration');
  assert.deepEqual(results.map(item=>item.attempts).sort(),[1,2]);
  const second=results.find(item=>item.registration.prior_selection_count===1);
  assert.equal(second.registration.prior_selection_ids.length,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE owner_id=$1',[owner.id])).rows[0].n,2);
});

test('two concurrent registrations with the same key: one row, the other QR4_SELECTION_EXISTS with the existing id',async()=>{
  const owner=await newOwner('qs-race-key'),set=await newSet(owner,{n:3});
  const wait=barrier(2);
  const run=()=>registerSelection(rt,{request:requestOf(owner,set,{startDays:72}),context:contextOf(owner),readInputs:async()=>{await wait();return null;}});
  const results=await Promise.all([run(),run()]);
  const winner=results.find(item=>item.ok),loser=results.find(item=>!item.ok);
  assert.ok(winner&&loser,JSON.stringify(results));
  assert.deepEqual([loser.code,loser.selection_id],['QR4_SELECTION_EXISTS',winner.selection_id]);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE owner_id=$1',[owner.id])).rows[0].n,1);
});

test('the retry is bounded: a serialization failure that never clears is thrown after the third retry; a QR004 guard is never retried',async()=>{
  const owner=await newOwner('qs-retry'),set=await newSet(owner,{n:2});
  let attempts=0;
  const failing={...rt,isTransaction:false,transaction:async()=>{attempts++;throw Object.assign(Error('forced'),{code:SERIALIZATION_FAILURE});}};
  await assert.rejects(registerSelection(failing,{request:requestOf(owner,set,{startDays:73}),context:contextOf(owner)}),{code:SERIALIZATION_FAILURE});
  assert.equal(attempts,4,'one attempt and three retries');
  attempts=0;
  const guarded={...rt,isTransaction:false,transaction:async()=>{attempts++;throw Object.assign(Error('guard'),{code:QR004,constraint:'quant_selection_registration_clock'});}};
  const refusedOnce=await registerSelection(guarded,{request:requestOf(owner,set,{startDays:73}),context:contextOf(owner)});
  assert.deepEqual([refusedOnce.ok,refusedOnce.code,attempts],[false,'QR4_WINDOW_INVALID',1]);
  assert.deepEqual(Object.keys(GUARD_REFUSALS).sort(),['quant_selection_exposure_bind','quant_selection_participant_member','quant_selection_participant_ready','quant_selection_registration_clock','quant_selection_registration_complete',
    'quant_selection_status_transition','quant_selection_universe_member']);
  await assert.rejects(registerSelection({...rt,isTransaction:true},{request:requestOf(owner,set,{startDays:74}),context:contextOf(owner)}),/own SERIALIZABLE transaction/);
});

test('REGISTRATION_TOO_SLOW: a transaction older than 50 s at its insert throws a retryable error and writes nothing; the 60 s database guard stays',async()=>{
  const owner=await newOwner('qs-slow'),set=await newSet(owner,{n:2});
  const before=await counts(db);
  const slowBy=extra=>{let reads=0;const spy=Object.create(rt);spy.query=async(sql,params)=>{const result=await rt.query(sql,params);
    if(String(sql).includes('quant_selection_now_ms')&&++reads===2)return {...result,rows:[{now_ms:Number(result.rows[0].now_ms)+extra}]};return result;};return spy;};
  const error=await registerSelection(slowBy(REGISTRATION_SLOW_LIMIT_MS+1000),{request:requestOf(owner,set,{startDays:75}),context:contextOf(owner)}).then(()=>null,caught=>caught);
  assert.ok(error,'the registration was not written');assert.deepEqual([error.code,error.retryable],['REGISTRATION_TOO_SLOW',true]);
  assert.deepEqual(await counts(db),before);
  const fine=await registerSelection(slowBy(REGISTRATION_SLOW_LIMIT_MS-1000),{request:requestOf(owner,set,{startDays:75}),context:contextOf(owner)});
  assert.equal(fine.ok,true,JSON.stringify(fine));
  assert.equal(REGISTRATION_SLOW_LIMIT_MS<60000,true);
});

test('selection_id: a request id is accepted only with the internal option; a taken id is refused identically for every owner',async()=>{
  const owner=await newOwner('qs-sid'),other=await newOwner('qs-sid-other'),set=await newSet(owner,{n:2}),otherSet=await newSet(other,{n:2});
  const before=await counts(db),wanted=randomUUID();
  const without=await registerSelection(rt,{request:{...requestOf(owner,set,{startDays:76}),selection_id:wanted},context:contextOf(owner)});
  assert.deepEqual([without.ok,without.code,without.detail],[false,'INVALID_FIELDS','SELECTION_ID']);
  assert.deepEqual(await counts(db),before,'nothing was written');
  const internal=await registerSelection(rt,{request:{...requestOf(owner,set,{startDays:76}),selection_id:wanted},context:contextOf(owner),internal:true});
  assert.equal(internal.ok,true,JSON.stringify(internal));assert.equal(internal.selection_id,wanted);
  const own=await registerSelection(rt,{request:{...requestOf(owner,set,{startDays:77}),selection_id:wanted},context:contextOf(owner),internal:true});
  const foreign=await registerSelection(rt,{request:{...requestOf(other,otherSet,{startDays:77}),selection_id:wanted},context:contextOf(other),internal:true});
  const malformed=await registerSelection(rt,{request:{...requestOf(other,otherSet,{startDays:78}),selection_id:'not-a-uuid'},context:contextOf(other),internal:true});
  assert.deepEqual(own,foreign,'the same refusal whoever owns the taken id');assert.deepEqual(own,malformed,'and the same as for a malformed id');
  assert.deepEqual([own.ok,own.code,own.detail],[false,'INVALID_FIELDS','SELECTION_ID']);
});

test('registration is SERIALIZABLE only: a registration insert under READ COMMITTED or REPEATABLE READ is refused with QR003',async()=>{
  const base=BASE_SELECTION.registration,now=await dbClock(rt),registration=forged(base,copy=>{copy.registered_at_ms=now;});
  for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
    await assert.rejects(rt.transaction(async()=>writeRows(rt,registration),{isolation}),{code:QR003});
  assert.equal(await exists(registration.selection_id),0);
  assert.equal(QR002,'QR002');
});
