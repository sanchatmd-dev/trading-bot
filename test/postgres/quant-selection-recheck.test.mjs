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
import {appendExposures,readExposures,readExposuresLocked,toComparisonEntries} from '../../src/postgres/exposure-register.js';
import {QUALIFICATION_VERSION} from '../../src/selection/eligibility.js';
import {registerSelection,cancelSelection,readSelection,freezeWindow,startEvaluation,writeOutcome,replaySelectionOutcome,markWindowDataUnavailable,findOrphanSelectionExposures,EVALUATIONS_UNAVAILABLE} from '../../src/postgres/selection-store.js';
import {OBJECTIVE_REGISTRY,transitionSelection,TRANSITIONS,INCOMPLETE_CODES,rankSelection,digest} from '../../src/selection/index.js';
import {canonical} from '../../src/pine-bridge/source.js';
import {PACKAGE_FILES} from '../../src/quant-library/package-gates.js';
import {FIXTURE_LABEL,hex,T0} from '../helpers/quant-library-fixture.mjs';

// QR-4 S2-2: the RO-12 rechecks, the window freeze, the evaluation starts, the outcome and the replay of the qualified-selection tables,
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
    await admin.query('DROP ROLE IF EXISTS '+roleName+'_dl').catch(()=>{});await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
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
    data_windows:{dataset:range(60,30),train:range(60,50),validation:range(50,40),holdout:range(40,30)},registered_boundary_ms:null};
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
const researchDigest=async target=>(await target.query(`SELECT encode(sha256(convert_to((SELECT COALESCE(string_agg(row_to_json(j)::text,'|' ORDER BY j.run_id),'') FROM quant_jobs j)
  ||(SELECT COALESCE(string_agg(row_to_json(e)::text,'|' ORDER BY e.export_id),'') FROM bi_exports e)
  ||(SELECT COALESCE(string_agg(row_to_json(s)::text,'|' ORDER BY s.export_id,s.seq),'') FROM bi_status_events s)
  ||(SELECT COALESCE(string_agg(row_to_json(v)::text,'|' ORDER BY v.export_id),'') FROM ql4c_validation v),'UTF8')),'hex') d`)).rows[0].d;

/* ---- helpers of the S2-2 tests: FORWARD_PAST selections (their window has closed, so W can be frozen), disjoint windows, evaluations ---- */

const QR004_='QR004';
const guardFailure=(promise,constraint,code=QR004_)=>assert.rejects(promise,error=>error.code===code&&(constraint===null||error.constraint===constraint),String(constraint));
const guardMessage=(promise,constraint,message)=>assert.rejects(promise,error=>error.code===QR004_&&error.constraint===constraint&&error.message===message,constraint+': '+message);
const NEW_TABLES=['quant_selection_window_freezes','quant_selection_evaluation_starts','quant_selection_outcomes','quant_selection_replay_events'];
const ALL_TABLES=['quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events',...NEW_TABLES];
const counts=async target=>Object.fromEntries(await Promise.all(ALL_TABLES.map(async table=>[table,(await target.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
const ownRegisterRows=async(target,id)=>(await target.query("SELECT exposure_id,owner_id,start_ms,end_ms FROM public.quant_exposure_register WHERE kind='QR4_SELECTION' AND selection_id=$1",[id])).rows;
const registerCount=async target=>(await target.query('SELECT count(*)::int n FROM public.quant_exposure_register')).rows[0].n;
const eventsOf=async(target,id)=>(await target.query('SELECT seq,event,status,code,outcome,completed_evaluation_run_ids FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq',[id])).rows;
const statusOf=async(target,id)=>{const rows=await eventsOf(target,id);return rows[rows.length-1].status;};

/** A FORWARD_PAST request: the window starts daysAgo days before BASE (plus offsetMin), so two selections with different daysAgo never overlap. */
const pastRequest=(owner,set,{daysAgo=5,offsetMin=0,fixture=false,over={}}={})=>{
  const start=BASE-daysAgo*DAY+offsetMin*MS;
  return {owner_id:owner.id,confirmed:true,fixture,scope:structuredClone(SCOPE),window:{kind:'FORWARD_PAST',start_ms:start,end_ms:start+1000*MS,warmup_bars:200},objective:{id:OBJECTIVE_ID},
    filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},admission_deadline_ms:BASE+DAY,universe:set.members,...over};
};
const contextOf=(owner,over={})=>({dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},universe_cap:20,requester_owner_id:owner.id,
  policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},objective_registry:TEST_REGISTRY,fixture_selections_allowed:true,...over});
/** A registered (and by default frozen) selection of a fresh owner. */
async function prepared({n=3,daysAgo=5,offsetMin=0,over={},freeze=true,owner=null,set=null}={}){
  const who=owner??await newOwner('qs-rc'),members=set??await newSet(who,{n});
  const reg=await registerSelection(rt,{request:pastRequest(who,members,{daysAgo,offsetMin,over}),context:contextOf(who)});
  assert.equal(reg.ok,true,JSON.stringify(reg));
  const dataset=hex('dataset:'+reg.selection_id);
  if(freeze){const frozen=await freezeWindow(rt,{owner_id:who.id,selection_id:reg.selection_id,dataset_hash:dataset});assert.equal(frozen.ok,true,JSON.stringify(frozen));}
  return {owner:who,set:members,reg,id:reg.selection_id,dataset,registration:reg.registration,exports:reg.registration.participants.map(item=>item.export_id)};
}
const startOne=(p,index,over={})=>startEvaluation(rt,{owner_id:p.owner.id,selection_id:p.id,export_id:p.exports[index],evaluation_run_id:'ev-'+randomUUID(),...over});
async function startAll(p){const out=[];for(let i=0;i<p.exports.length;i++){out.push(await startOne(p,i));assert.equal(out[i].ok,true,JSON.stringify(out[i]));}return out;}
const evaluationOf=(registration,start,v={})=>{
  const result={evaluation_bars:registration.window.evaluation_bars,metrics:{net_return_percent:v.net??'2',max_drawdown_percent:v.dd??'5',closed_trades:9},episodes:8,rejected_intents:0,
    fees:'1.2',slippage:'0.4',exposure_percent:'35',cost_stress:{net_return_percent:'1'},benchmark:{net_return_percent:'0.1'}};
  return {run_id:start.evaluation_run_id,parent_run_id:start.parent_run_id,selection_id:registration.selection_id,mode:'QR4_SELECTION_EVAL',status:'SUCCEEDED',
    integrity:{contract_hash_verified:true,report_matches_checkpoints:true},engine_hash:ENGINE,dataset_hash:start.dataset_hash,result,result_hash:digest(result)};
};
async function evaluationsFor(p,nets=['3','2','1']){
  const read=await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id});assert.equal(read.ok,true);
  return read.selection.starts.map((start,index)=>evaluationOf(read.selection.registration,start,{net:nets[index]??'1'}));
}
/** A QR-3 comparison event over [start, end) written the way a committed QR-3 comparison would (no check, the test decides what the register holds). */
const qr3Event=(window,tag='x')=>({kind:'QR3_COMPARISON',window,comparison_id:'cmp-'+tag+'-'+randomUUID(),participant_run_id:'run-'+tag,source_hash:hex('src:'+tag)});
const addExposure=(owner,events)=>db.transaction(async()=>appendExposures(db,{owner_id:owner.id,...MARKET,events}),{isolation:'SERIALIZABLE'});
const windowOf=p=>({start_ms:p.registration.window.start_ms,end_ms:p.registration.window.end_ms});
/** A spy that records every statement and transaction start of a store call and can fail chosen statements. */
function spyOf(fail=()=>null){
  const seen=[],spy=Object.create(rt);
  spy.query=async(sql,params)=>{const text=String(sql).replace(/\s+/g,' ').trim();seen.push(text);const error=fail(text,params);if(error)throw error;return rt.query(sql,params);};
  spy.transaction=(fn,options)=>{seen.push('TX:'+(options?.isolation??''));return rt.transaction(fn,options);};
  return {spy,seen};
}
const ONLY_SERIALIZABLE_TX=seen=>seen.map((item,index)=>[item,index]).filter(([item])=>item==='TX:SERIALIZABLE').map(([,index])=>index);

let DL,deleterName;
before(async()=>{
  deleterName=roleName+'_dl';
  await admin.query('CREATE ROLE '+deleterName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await db.query(await grantScript(deleterName));
  await db.query(`GRANT UPDATE,DELETE,TRUNCATE ON TABLE ${NEW_TABLES.map(table=>'public.'+table).join(',')} TO ${deleterName}`);
  DL=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,deleterName),max:3})));
});

/* ---- 1. the window freeze ---- */

test('freeze (T-FREEZE): once, while registered, over the closed registered window; before it closes, twice, after the end and with a bad hash it is refused',async()=>{
  const p=await prepared({freeze:false,daysAgo:6});
  const before=await counts(db);
  assert.deepEqual((await freezeWindow(rt,{owner_id:p.owner.id,selection_id:p.id,dataset_hash:'zz'})).detail,'DATASET_HASH');
  assert.equal((await freezeWindow(rt,{owner_id:(await newOwner('qs-fz-stranger')).id,selection_id:p.id,dataset_hash:p.dataset})).code,'NOT_FOUND');
  const before1=await dbClock(rt);
  const done=await freezeWindow(rt,{owner_id:p.owner.id,selection_id:p.id,dataset_hash:p.dataset});
  assert.equal(done.ok,true,JSON.stringify(done));assert.ok(done.frozen_at_ms>=before1&&done.frozen_at_ms<=await dbClock(rt),'the stamp is the database clock');
  const row=(await db.query('SELECT * FROM public.quant_selection_window_freezes WHERE selection_id=$1',[p.id])).rows[0];
  assert.deepEqual([Number(row.start_ms),Number(row.end_ms),row.bars_total,row.dataset_hash],[p.registration.window.start_ms,p.registration.window.end_ms,1200,p.dataset]);
  const again=await freezeWindow(rt,{owner_id:p.owner.id,selection_id:p.id,dataset_hash:hex('other')});
  assert.deepEqual([again.ok,again.code,again.detail],[false,'QR4_TRANSITION_INVALID','ALREADY_FROZEN']);
  assert.equal((await counts(db)).quant_selection_window_freezes,before.quant_selection_window_freezes+1);
  // a PROSPECTIVE window has not closed: the freeze guard refuses it by the database stamp
  const owner=await newOwner('qs-fz-prospective'),set=await newSet(owner,{n:2});
  const future=await registerSelection(rt,{request:{...pastRequest(owner,set,{daysAgo:0}),window:{kind:'PROSPECTIVE',start_ms:BASE+3*DAY,end_ms:BASE+3*DAY+1000*MS,warmup_bars:200},admission_deadline_ms:BASE+5*DAY},context:contextOf(owner)});
  assert.equal(future.ok,true,JSON.stringify(future));
  const early=await freezeWindow(rt,{owner_id:owner.id,selection_id:future.selection_id,dataset_hash:hex('d')});
  assert.deepEqual([early.ok,early.code,early.detail],[false,'QR4_TRANSITION_INVALID','FREEZE_ORDER']);
  // raw rows: a window that differs from the registration, a supplied frozen_at_ms (overwritten), a freeze after a terminal status
  const q=await prepared({freeze:false,daysAgo:7});
  await guardFailure(rt.query('INSERT INTO public.quant_selection_window_freezes(selection_id,dataset_hash,start_ms,end_ms,bars_total) VALUES($1,$2,$3,$4,$5)',[q.id,hex('d'),q.registration.window.start_ms,q.registration.window.end_ms+MS,1201]),'quant_selection_freeze_order');
  await guardFailure(rt.query('INSERT INTO public.quant_selection_window_freezes(selection_id,dataset_hash,start_ms,end_ms,bars_total) VALUES($1,$2,$3,$4,$5)',[q.id,hex('d'),q.registration.window.start_ms,q.registration.window.end_ms,1199]),'quant_selection_freeze_order');
  await rt.query('INSERT INTO public.quant_selection_window_freezes(selection_id,dataset_hash,start_ms,end_ms,bars_total,frozen_at_ms) VALUES($1,$2,$3,$4,$5,1)',[q.id,hex('d'),q.registration.window.start_ms,q.registration.window.end_ms,1200]);
  assert.ok(Number((await db.query('SELECT frozen_at_ms FROM public.quant_selection_window_freezes WHERE selection_id=$1',[q.id])).rows[0].frozen_at_ms)>BASE,'a supplied frozen_at_ms is overwritten by the database stamp');
  const c=await prepared({freeze:false,daysAgo:8});
  assert.equal((await cancelSelection(rt,{owner_id:c.owner.id,selection_id:c.id,confirmed:true})).ok,true);
  const late=await freezeWindow(rt,{owner_id:c.owner.id,selection_id:c.id,dataset_hash:c.dataset});
  assert.deepEqual([late.ok,late.code],[false,'QR4_TRANSITION_INVALID']);
  // a data gap found before the first start ends the selection on the REGISTERED edge (RC-S27); a second ending is refused
  const g=await prepared({freeze:false,daysAgo:9});
  const gap=await markWindowDataUnavailable(rt,{owner_id:g.owner.id,selection_id:g.id});
  assert.deepEqual([gap.ok,gap.ended,gap.status,gap.code],[false,true,'SELECTION_INCOMPLETE','QR4_WINDOW_DATA_UNAVAILABLE'],JSON.stringify(gap));
  assert.deepEqual((await eventsOf(db,g.id)).map(item=>[item.event,item.status,item.code]),[['REGISTER','SELECTION_REGISTERED',null],['WINDOW_DATA_UNAVAILABLE','SELECTION_INCOMPLETE','QR4_WINDOW_DATA_UNAVAILABLE']]);
  assert.equal((await markWindowDataUnavailable(rt,{owner_id:g.owner.id,selection_id:g.id})).code,'QR4_TRANSITION_INVALID');
});

/* ---- 2. the first evaluation start and the later ones (RO-12) ---- */

test('first start (T-START1): rechecks under the register lock, appends the one QR4_SELECTION row for the evaluation window, writes FIRST_EVALUATION_START and the start row; later starts add no register row',async()=>{
  const p=await prepared({daysAgo:10});
  assert.deepEqual(await ownRegisterRows(db,p.id),[],'a registered selection holds no register row: the exposure comes with the first start');
  assert.deepEqual(await findOrphanSelectionExposures(db,{owner_id:p.owner.id}),[]);
  const unfrozen=await prepared({freeze:false,daysAgo:11});
  const research=await researchDigest(db),registerBefore=await registerCount(db);
  const notFrozen=await startOne(unfrozen,0);
  assert.deepEqual([notFrozen.ok,notFrozen.code,notFrozen.detail,notFrozen.blocked],[false,'QR4_TRANSITION_INVALID','WINDOW_NOT_FROZEN',true]);
  assert.equal(await statusOf(db,unfrozen.id),'SELECTION_REGISTERED');
  assert.equal(await registerCount(db),registerBefore,'a blocked start writes no register row');
  const t0=Date.now();
  const first=await startOne(p,0);
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.first,true);
  const rows=await ownRegisterRows(db,p.id);
  assert.equal(rows.length,1);assert.deepEqual([rows[0].owner_id,Number(rows[0].start_ms),Number(rows[0].end_ms)],[p.owner.id,p.registration.window.start_ms,p.registration.window.end_ms],'the exposure is the evaluation part of W (warm-up excluded)');
  assert.ok(Number((await db.query('SELECT at_ms FROM public.quant_exposure_register WHERE selection_id=$1',[p.id])).rows[0].at_ms)>=t0-1000,'the register at_ms is the application clock');
  assert.deepEqual((await eventsOf(db,p.id)).map(item=>[item.seq,item.event,item.status]),[[1,'REGISTER','SELECTION_REGISTERED'],[2,'FIRST_EVALUATION_START','SELECTION_EVALUATING']]);
  const start=(await db.query('SELECT * FROM public.quant_selection_evaluation_starts WHERE selection_id=$1',[p.id])).rows[0];
  const part=p.registration.participants.find(item=>item.export_id===p.exports[0]);
  assert.deepEqual([start.export_id,start.parent_run_id,start.dataset_hash,start.engine_hash],[p.exports[0],part.run_id,p.dataset,ENGINE]);
  assert.ok(Number(start.started_at_ms)>=t0-2000&&Number(start.started_at_ms)<=await dbClock(rt),'started_at_ms is the database stamp');
  // later starts: no second register row, no second FIRST_EVALUATION_START
  const second=await startOne(p,1),third=await startOne(p,2);
  assert.deepEqual([second.ok,second.first,third.ok,third.first],[true,false,true,false],JSON.stringify([second,third]));
  assert.equal((await ownRegisterRows(db,p.id)).length,1);
  assert.deepEqual((await eventsOf(db,p.id)).map(item=>item.event),['REGISTER','FIRST_EVALUATION_START']);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_evaluation_starts WHERE selection_id=$1',[p.id])).rows[0].n,3);
  assert.equal(await registerCount(db),registerBefore+1,'exactly one register row for the whole selection');
  assert.equal(await researchDigest(db),research,'quant_jobs and the bi_* rows are byte-identical after the starts');
  assert.deepEqual(await findOrphanSelectionExposures(db,{owner_id:p.owner.id}),[]);
  // a repeated start and a repeated evaluation run id
  const repeat=await startOne(p,0);assert.deepEqual([repeat.ok,repeat.code,repeat.detail],[false,'QR4_TRANSITION_INVALID','ALREADY_STARTED']);
  const taken=(await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection.starts[0].evaluation_run_id;
  const q=await prepared({daysAgo:12});
  const duplicate=await startOne(q,0,{evaluation_run_id:taken});
  assert.deepEqual([duplicate.ok,duplicate.code,duplicate.detail],[false,'INVALID_FIELDS','EVALUATION_RUN_ID_TAKEN']);
  assert.equal(await statusOf(db,q.id),'SELECTION_REGISTERED');assert.deepEqual(await ownRegisterRows(db,q.id),[],'the failed start left no register row (it rolled back)');
  for(const bad of [{export_id:'x'},{export_id:randomUUID()},{evaluation_run_id:''},{selection_id:'x'},{owner_id:''}]){
    const out=await startOne(q,0,bad);assert.equal(out.ok,false,JSON.stringify(bad));
  }
  const stranger=await newOwner('qs-start-stranger');
  assert.equal((await startOne(q,0,{owner_id:stranger.id})).code,'NOT_FOUND');
});

test('first start: the register lock is the first statement of the write transaction (first and later start, and the outcome write)',async()=>{
  const p=await prepared({daysAgo:13});
  const a=spyOf();
  const first=await startEvaluation(a.spy,{owner_id:p.owner.id,selection_id:p.id,export_id:p.exports[0],evaluation_run_id:'ev-'+randomUUID()});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.first,true);
  const tx=ONLY_SERIALIZABLE_TX(a.seen);assert.equal(tx.length,1);
  assert.match(a.seen[tx[0]+1],/^LOCK TABLE public\.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE$/,'the very next statement after BEGIN is the register lock');
  // a start after the first one takes the same lock first
  const q=await prepared({daysAgo:14});
  assert.equal((await startOne(q,0)).ok,true);
  const b=spyOf();
  assert.equal((await startEvaluation(b.spy,{owner_id:q.owner.id,selection_id:q.id,export_id:q.exports[1],evaluation_run_id:'ev-'+randomUUID()})).first,false);
  assert.match(b.seen[ONLY_SERIALIZABLE_TX(b.seen)[0]+1],/^LOCK TABLE public\.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE$/);
  // the outcome write takes it first too (readExposuresLocked)
  assert.equal((await startOne(q,2)).ok,true);
  const c=spyOf();
  const outcome=await writeOutcome(c.spy,{owner_id:q.owner.id,selection_id:q.id,evaluations:await evaluationsFor(q)});
  assert.equal(outcome.ok,true,JSON.stringify(outcome));
  assert.match(c.seen[ONLY_SERIALIZABLE_TX(c.seen)[0]+1],/^LOCK TABLE public\.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE$/);
});

test('RO-12 at the first start: an exposure by a QR-3 row, by another selection, or a research run over W ends the selection INCOMPLETE and writes no exposure row',async()=>{
  const registerBefore=await registerCount(db);
  // (a) a QR-3 comparison event over W
  const a=await prepared({daysAgo:15});
  await addExposure(a.owner,[qr3Event({start_ms:a.registration.window.start_ms+10*MS,end_ms:a.registration.window.start_ms+20*MS})]);
  const exposed=await startOne(a,0);
  assert.deepEqual([exposed.ok,exposed.ended,exposed.status,exposed.code,exposed.event],[false,true,'SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED','WINDOW_RECHECK_FAILED'],JSON.stringify(exposed));
  assert.deepEqual(await ownRegisterRows(db,a.id),[]);assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_evaluation_starts WHERE selection_id=$1',[a.id])).rows[0].n,0);
  assert.deepEqual((await eventsOf(db,a.id)).map(item=>[item.event,item.status,item.code]),[['REGISTER','SELECTION_REGISTERED',null],['WINDOW_RECHECK_FAILED','SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED']]);
  const after=await startOne(a,1);assert.deepEqual([after.ok,after.code],[false,'QR4_TRANSITION_INVALID'],'nothing starts after the selection ended');
  assert.equal(await registerCount(db),registerBefore+1,'only the QR-3 row of this test exists');
  // (b) another selection of the same owner with an overlapping W that started first
  const owner=await newOwner('qs-two'),setA=await newSet(owner,{n:2}),setB=await newSet(owner,{n:2});
  const first=await prepared({owner,set:setA,daysAgo:16,n:2}),second=await prepared({owner,set:setB,daysAgo:16,offsetMin:500,n:2});
  assert.equal((await startOne(first,0)).ok,true);
  const clash=await startOne(second,0);
  assert.deepEqual([clash.ok,clash.ended,clash.code],[false,true,'QR4_WINDOW_EXPOSED'],JSON.stringify(clash));
  assert.deepEqual(await ownRegisterRows(db,second.id),[]);assert.equal((await ownRegisterRows(db,first.id)).length,1);
  // (c) a research run of the owner on a participant source created after the registration, whose holdout covers W
  const c=await prepared({daysAgo:17});
  await newRun(c.owner,{source:c.set.runs[0].source,start:c.registration.window.start_ms-850*MS,status:'FAILED'});
  const searched=await startOne(c,0);
  assert.deepEqual([searched.ok,searched.ended,searched.code],[false,true,'QR4_WINDOW_OVERLAPS_SEARCHED_DATA'],JSON.stringify(searched));
  assert.deepEqual(await ownRegisterRows(db,c.id),[]);
  // (d) a foreign owner's run and an unrelated source do not matter
  const d=await prepared({daysAgo:18});
  const stranger=await newOwner('qs-two-stranger');
  await newRun(stranger,{source:d.set.runs[0].source,start:d.registration.window.start_ms-850*MS});await newRun(d.owner,{start:d.registration.window.start_ms-850*MS});
  assert.equal((await startOne(d,0)).ok,true);
});

test('RO-12 blocks, never ends: an unreadable searched list or an unreadable register leaves the selection open and writes nothing',async()=>{
  const p=await prepared({daysAgo:19});
  await newRun(p.owner,{contract:{scope:REAL_SCOPE,source_hash:p.set.runs[0].source,dataset:{start_time:BASE-40*DAY}}});
  const registerBefore=await registerCount(db),before=await counts(db);
  const unreadable=await startOne(p,0);
  assert.deepEqual([unreadable.ok,unreadable.code,unreadable.detail,unreadable.blocked],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE',true],JSON.stringify(unreadable));
  assert.equal(await statusOf(db,p.id),'SELECTION_REGISTERED');assert.deepEqual(await counts(db),before);assert.equal(await registerCount(db),registerBefore);
  // an absent register table (42P01 at the LOCK), a marker that is not version 1, and a row that breaks a table rule: all block
  const q=await prepared({daysAgo:20});
  const absent=await startEvaluation(spyOf((sql)=>/^LOCK TABLE/.test(sql)?Object.assign(Error('relation does not exist'),{code:'42P01'}):null).spy,{owner_id:q.owner.id,selection_id:q.id,export_id:q.exports[0],evaluation_run_id:'ev-'+randomUUID()});
  assert.deepEqual([absent.ok,absent.code,absent.blocked],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE',true]);
  const badMarker=spyOf();const realQuery=badMarker.spy.query;
  badMarker.spy.query=async(sql,params)=>String(sql).includes('SELECT version FROM public.quant_exposure_register_schema')?(badMarker.seen.push('marker'),{rows:[{version:2}]}):realQuery(sql,params);
  const marker=await startEvaluation(badMarker.spy,{owner_id:q.owner.id,selection_id:q.id,export_id:q.exports[0],evaluation_run_id:'ev-'+randomUUID()});
  assert.deepEqual([marker.ok,marker.code,marker.blocked],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE',true]);
  assert.equal(await statusOf(db,q.id),'SELECTION_REGISTERED');assert.deepEqual(await ownRegisterRows(db,q.id),[]);
  // the same start succeeds once the register is readable again
  assert.equal((await startOne(q,0)).ok,true);
  // unreadable at a later start (EVALUATING): blocked, still EVALUATING, no new row
  const r=await prepared({daysAgo:21});
  assert.equal((await startOne(r,0)).ok,true);
  await newRun(r.owner,{contract:{scope:REAL_SCOPE,source_hash:r.set.runs[1].source,dataset:{start_time:BASE-40*DAY}}});
  const later=await startOne(r,1);
  assert.deepEqual([later.ok,later.code,later.detail,later.blocked],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE',true]);
  assert.equal(await statusOf(db,r.id),'SELECTION_EVALUATING');assert.equal((await ownRegisterRows(db,r.id)).length,1);
});

test('RO-12 at a later start: a window that became exposed or searched after the first start ends the selection and keeps the existing register row; own exposure never fails',async()=>{
  const a=await prepared({daysAgo:22});
  assert.equal((await startOne(a,0)).ok,true);
  assert.equal((await startOne(a,1)).ok,true,'the own register row and the own earlier start do not fail the recheck');
  await addExposure(a.owner,[qr3Event({start_ms:a.registration.window.end_ms-5*MS,end_ms:a.registration.window.end_ms+5*MS})]);
  const exposed=await startOne(a,2);
  assert.deepEqual([exposed.ok,exposed.ended,exposed.code],[false,true,'QR4_WINDOW_EXPOSED'],JSON.stringify(exposed));
  assert.equal((await ownRegisterRows(db,a.id)).length,1,'the register keeps the selection exposure');
  assert.deepEqual((await eventsOf(db,a.id)).map(item=>[item.event,item.status,item.code]).slice(-1),[['WINDOW_RECHECK_FAILED','SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED']]);
  const b=await prepared({daysAgo:23});
  assert.equal((await startOne(b,0)).ok,true);
  await newRun(b.owner,{source:b.set.runs[1].source,start:b.registration.window.start_ms-850*MS});
  const searched=await startOne(b,1);
  assert.deepEqual([searched.ok,searched.code],[false,'QR4_WINDOW_OVERLAPS_SEARCHED_DATA']);
  assert.equal(await statusOf(db,b.id),'SELECTION_INCOMPLETE');
});

test('deadline and participant checks: a passed admission deadline or a stale participant ends the selection before any register row; the database guards repeat both',async()=>{
  const d=await prepared({daysAgo:24,over:{admission_deadline_ms:BASE-24*DAY+1000*MS}});
  const late=await startOne(d,0);
  assert.deepEqual([late.ok,late.ended,late.code,late.event],[false,true,'QR4_ADMISSION_REFUSED','DEADLINE_PASSED'],JSON.stringify(late));
  assert.deepEqual(await ownRegisterRows(db,d.id),[]);
  // the participant hook (E1 to E3 of slice S3 plug in here) ends the selection stale; the hook sees the first flag
  const s=await prepared({daysAgo:25});
  let seenFirst=null;
  const stale=await startOne(s,0,{participantCheck:async(tx,{first})=>{seenFirst=first;return {detail:'LIBRARY_ROW_CHANGED'};}});
  assert.deepEqual([stale.ok,stale.ended,stale.code,stale.event,seenFirst],[false,true,'QR4_PARTICIPANT_STALE','PARTICIPANT_INELIGIBLE',true],JSON.stringify(stale));
  assert.deepEqual(await ownRegisterRows(db,s.id),[]);
  // guard layer: a start after the deadline by the database stamp (QR004 start_deadline) and a participant that is no longer validated (start_ready)
  const g=await prepared({daysAgo:26,over:{admission_deadline_ms:BASE-26*DAY+1000*MS}});
  const rawStart=(target,p,over='')=>target.transaction(async()=>{
    await appendExposures(target,{owner_id:p.owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:windowOf(p),selection_id:p.id}]});
    await target.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')",[p.id]);
    if(over)await target.query(over);
    await target.query('INSERT INTO public.quant_selection_evaluation_starts(selection_id,export_id,evaluation_run_id,parent_run_id,dataset_hash,engine_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [p.id,p.exports[0],'ev-'+randomUUID(),p.registration.participants.find(item=>item.export_id===p.exports[0]).run_id,p.dataset,ENGINE]);
  },{isolation:'SERIALIZABLE'});
  await guardFailure(rawStart(rt,g),'quant_selection_start_deadline');
  assert.deepEqual(await ownRegisterRows(db,g.id),[],'the failed transaction rolled the register row back');
  const h=await prepared({daysAgo:27});
  await guardFailure(db.transaction(async()=>{
    await db.query('ALTER TABLE public.ql4c_validation DISABLE TRIGGER USER');
    await db.query('DELETE FROM public.ql4c_validation WHERE export_id=$1',[h.exports[0]]);
    await appendExposures(db,{owner_id:h.owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:windowOf(h),selection_id:h.id}]});
    await db.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')",[h.id]);
    await db.query('INSERT INTO public.quant_selection_evaluation_starts(selection_id,export_id,evaluation_run_id,parent_run_id,dataset_hash,engine_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [h.id,h.exports[0],'ev-'+randomUUID(),h.registration.participants.find(item=>item.export_id===h.exports[0]).run_id,h.dataset,ENGINE]);
  },{isolation:'SERIALIZABLE'}),'quant_selection_start_ready');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.ql4c_validation WHERE export_id=$1',[h.exports[0]])).rows[0].n,1,'the tamper rolled back');
  // the writer maps a start guard that fires in a race to the ending of the selection in a new transaction
  for(const [guard,code,event] of [['quant_selection_start_deadline','QR4_ADMISSION_REFUSED','DEADLINE_PASSED'],['quant_selection_start_ready','QR4_PARTICIPANT_STALE','PARTICIPANT_INELIGIBLE']]){
    const p=await prepared({daysAgo:28});
    const raced=spyOf(sql=>/^INSERT INTO public\.quant_selection_evaluation_starts/.test(sql)?Object.assign(Error('raced'),{code:'QR004',constraint:guard}):null);
    const out=await startEvaluation(raced.spy,{owner_id:p.owner.id,selection_id:p.id,export_id:p.exports[0],evaluation_run_id:'ev-'+randomUUID()});
    assert.deepEqual([out.ok,out.ended,out.code,out.event],[false,true,code,event],JSON.stringify(out));
    assert.deepEqual(await ownRegisterRows(db,p.id),[],'the register row of the failed transaction rolled back');
  }
});

/* ---- 3. the exposure order: a register row only together with FIRST_EVALUATION_START ---- */

test('exposure order: an orphan register row blocks the start; a status event needs the register row of this very transaction; C3 needs a start row; the audit lists orphans',async()=>{
  const owner=await newOwner('qs-order'),set=await newSet(owner,{n:2});
  const p=await prepared({owner,set,n:2,daysAgo:5}),w=windowOf(p);
  const fev=(target,id)=>target.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')",[id]);
  // no register row at all
  await guardFailure(rt.transaction(async()=>fev(rt,p.id),{isolation:'SERIALIZABLE'}),'quant_selection_exposure_bind');
  // a register row of another window, or of another selection, written in the same transaction
  await guardFailure(rt.transaction(async()=>{await appendExposures(rt,{owner_id:owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:w.start_ms,end_ms:w.end_ms-MS},selection_id:p.id}]});await fev(rt,p.id);},{isolation:'SERIALIZABLE'}),'quant_selection_exposure_bind');
  await guardFailure(rt.transaction(async()=>{await appendExposures(rt,{owner_id:owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:w,selection_id:randomUUID()}]});await fev(rt,p.id);},{isolation:'SERIALIZABLE'}),'quant_selection_exposure_bind');
  assert.deepEqual(await ownRegisterRows(db,p.id),[]);assert.equal(await statusOf(db,p.id),'SELECTION_REGISTERED');
  // C3: the event with its own register row but no start row fails at commit; SET CONSTRAINTS ALL IMMEDIATE fails at once
  const noStart=()=>rt.transaction(async()=>{await appendExposures(rt,{owner_id:owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:w,selection_id:p.id}]});await fev(rt,p.id);},{isolation:'SERIALIZABLE'});
  await guardFailure(noStart(),'quant_selection_first_start_complete');
  await guardFailure(rt.transaction(async()=>{await appendExposures(rt,{owner_id:owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:w,selection_id:p.id}]});await fev(rt,p.id);await rt.query('SET CONSTRAINTS ALL IMMEDIATE');},{isolation:'SERIALIZABLE'}),'quant_selection_first_start_complete');
  assert.deepEqual(await ownRegisterRows(db,p.id),[]);assert.equal(await statusOf(db,p.id),'SELECTION_REGISTERED');
  // an orphan register row (written by a faulty writer, with no FIRST_EVALUATION_START): the status event of a later transaction is refused (xmin), the writer blocks, the audit lists it
  await addExposure(owner,[{kind:'QR4_SELECTION',window:w,selection_id:p.id}]);
  await guardFailure(rt.transaction(async()=>fev(rt,p.id),{isolation:'SERIALIZABLE'}),'quant_selection_exposure_bind');
  const orphans=await findOrphanSelectionExposures(db,{owner_id:owner.id});
  assert.deepEqual(orphans.map(item=>[item.selection_id,item.start_ms,item.end_ms]),[[p.id,w.start_ms,w.end_ms]]);
  const blockedStart=await startOne(p,0);
  assert.deepEqual([blockedStart.ok,blockedStart.code,blockedStart.detail,blockedStart.blocked],[false,'INTEGRITY_CHECK_FAILED','ORPHAN_EXPOSURE',true],JSON.stringify(blockedStart));
  assert.equal(await statusOf(db,p.id),'SELECTION_REGISTERED');
  assert.equal((await findOrphanSelectionExposures(db,{owner_id:(await newOwner('qs-order-other')).id})).length,0,'another owner sees none');
  assert.equal(await findOrphanSelectionExposures(null,{owner_id:owner.id}),null);
  // a registration commit with a register row of its selection is already refused by C1 (S2-1); a started selection is not an orphan
  const healthy=await prepared({daysAgo:6});assert.equal((await startOne(healthy,0)).ok,true);
  assert.deepEqual((await findOrphanSelectionExposures(db,{owner_id:healthy.owner.id})),[]);
});

/* ---- 4. the status oracle from SELECTION_EVALUATING (every tuple) ---- */

test('EVALUATING-origin oracle: for every (event, status, code) tuple the database accepts exactly what the pure lifecycle accepts; COMPLETED needs the stored outcome with the same value',async()=>{
  const p=await prepared({daysAgo:7});
  await startAll(p);
  const evaluations=await evaluationsFor(p);
  const read=(await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection;
  const ranked=rankSelection(read.registration,evaluations,{window_dataset_hash:p.dataset});
  assert.equal(ranked.status,'SELECTION_COMPLETED',JSON.stringify(ranked.problems));
  const {outcome_hash:outcomeHash,...rest}=ranked,body=canonical(rest);assert.equal(sha(body),outcomeHash);
  const events=['FIRST_EVALUATION_START','OWNER_CANCEL','PARTICIPANT_INELIGIBLE','WINDOW_RECHECK_FAILED','DEADLINE_PASSED','WINDOW_DATA_UNAVAILABLE','ALL_EVALUATIONS_DONE'];
  const statuses=['SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED'];
  const codes=[...new Set([...INCOMPLETE_CODES,...TRANSITIONS.flatMap(row=>row.codes??[]),'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','QR4_TRANSITION_INVALID'])];
  const outcomes=['BEST_IN_SCOPE','TIED_IN_SCOPE','NO_QUALIFYING_STRATEGY','INADEQUATE_EVIDENCE'];
  let accepted=0,refusedN=0,pureAccepted=0;
  await rt.transaction(async()=>{
    await rt.query('INSERT INTO public.quant_selection_outcomes(selection_id,outcome,outcome_hash,body_canonical) VALUES($1,$2,$3,$4)',[p.id,ranked.outcome,outcomeHash,body]);
    const probe=async(event,status,code,outcome)=>{
      await rt.query('SAVEPOINT probe');
      try{
        await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,3,$2,$3,$4,NULL,$5,'{}')",[p.id,event,status,code,outcome]);
        return {ok:true};
      }catch(error){return {ok:false,code:error.code,constraint:error.constraint};}
      finally{await rt.query('ROLLBACK TO SAVEPOINT probe');await rt.query('RELEASE SAVEPOINT probe');}
    };
    for(const event of events)for(const status of statuses)for(const code of [null,...codes])for(const outcome of status==='SELECTION_COMPLETED'?outcomes:[null]){
      if((status==='SELECTION_INCOMPLETE')!==(code!==null))continue;
      const decided=transitionSelection('SELECTION_EVALUATING',{kind:event,to:status,code,outcome});
      const pureOk=decided.ok===true&&decided.to===status&&(decided.code??null)===code;
      const got=await probe(event,status,code,outcome);
      const label=[event,status,code,outcome].join(' ');
      if(pureOk)pureAccepted++;
      if(pureOk&&event!=='FIRST_EVALUATION_START'&&(status!=='SELECTION_COMPLETED'||outcome===ranked.outcome)){assert.equal(got.ok,true,label+' '+JSON.stringify(got));accepted++;}
      else if(pureOk&&status==='SELECTION_COMPLETED'){assert.deepEqual([got.ok,got.code,got.constraint],[false,QR004_,'quant_selection_outcome_order'],label);refusedN++;}
      else{assert.deepEqual([got.ok,got.code,got.constraint],[false,QR004_,'quant_selection_status_transition'],label);refusedN++;}
    }
  },{isolation:'SERIALIZABLE'}).catch(error=>{if(error.code!=='QR004'||error.constraint!=='quant_selection_outcome_complete')throw error;});
  // The outer transaction ends without a COMPLETED event: the stored outcome alone cannot commit (C2), which the probe loop relied on being deferred.
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_outcomes WHERE selection_id=$1',[p.id])).rows[0].n,0);
  const expected=TRANSITIONS.filter(row=>row.from==='SELECTION_EVALUATING').reduce((sum,row)=>sum+(Array.isArray(row.to)?row.to.reduce((inner,to)=>inner+(to==='SELECTION_COMPLETED'?1:row.codes.length),0):(row.codes?.length??1)),0);
  assert.equal(pureAccepted,expected+3,'the oracle walked every pure edge (COMPLETED counted once per outcome value: 4, so 3 extra)');
  assert.equal(accepted,expected,'every EVALUATING-origin edge but the three other COMPLETED outcome values is accepted');
  assert.ok(refusedN>60,String(refusedN));
  // REGISTERED-origin FIRST_EVALUATION_START with its register row is accepted by the store path (above); here it is refused from EVALUATING by the transition table
  assert.equal(await statusOf(db,p.id),'SELECTION_EVALUATING');
});

/* ---- 5. the outcome ---- */

test('outcome (T-OUT): the recheck runs under the register lock, the pure ranking decides, the result is stored hashed and COMPLETED follows; a replay that matches writes nothing',async()=>{
  const p=await prepared({daysAgo:8});
  const early=await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:[]});
  assert.deepEqual([early.ok,early.code,early.detail],[false,'QR4_TRANSITION_INVALID','STATUS_SELECTION_REGISTERED']);
  await startOne(p,0);await startOne(p,1);
  const partial=await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:[]});
  assert.deepEqual([partial.ok,partial.code,partial.detail,partial.blocked],[false,'QR4_TRANSITION_INVALID','EVALUATIONS_NOT_ALL_STARTED',true]);
  await startOne(p,2);
  const research=await researchDigest(db),registerBefore=await registerCount(db);
  let called=0;
  const done=await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,readEvaluations:async(tx,{selection,window_dataset_hash})=>{
    called++;assert.equal(tx.isTransaction,true);assert.equal(window_dataset_hash,p.dataset);
    return selection.starts.map((start,index)=>evaluationOf(selection.registration,start,{net:['3','2','1'][index]}));}});
  assert.equal(done.ok,true,JSON.stringify(done));assert.equal(called,1);
  assert.deepEqual([done.status,done.outcome],['SELECTION_COMPLETED','BEST_IN_SCOPE']);
  const row=(await db.query('SELECT * FROM public.quant_selection_outcomes WHERE selection_id=$1',[p.id])).rows[0];
  assert.equal(sha(row.body_canonical),row.outcome_hash);assert.equal(row.outcome_hash,done.outcome_hash);assert.equal(row.outcome,'BEST_IN_SCOPE');
  const body=JSON.parse(row.body_canonical);
  assert.deepEqual([body.version,body.status,body.registration_hash,body.window_dataset_hash,body.evaluations.length],['qr4-outcome-v1','SELECTION_COMPLETED',p.registration.registration_hash,p.dataset,3]);
  assert.ok(!('outcome_hash' in body));
  assert.deepEqual((await eventsOf(db,p.id)).map(item=>[item.event,item.status,item.outcome]).slice(-1),[['ALL_EVALUATIONS_DONE','SELECTION_COMPLETED','BEST_IN_SCOPE']]);
  assert.equal(await registerCount(db),registerBefore,'the outcome writes no register row');
  assert.equal(await researchDigest(db),research);
  const read=(await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection;
  assert.deepEqual([read.status,read.outcome,read.outcome_row.outcome_hash,read.freeze.dataset_hash,read.starts.length],['SELECTION_COMPLETED','BEST_IN_SCOPE',row.outcome_hash,p.dataset,3]);
  // the outcome is final
  const second=await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)});
  assert.deepEqual([second.ok,second.code],[false,'QR4_TRANSITION_INVALID']);
  // replay: equal writes nothing; a changed evaluation writes one SELECTION_REPLAY_MISMATCH row and leaves the outcome untouched
  const replayRows=async()=>(await db.query('SELECT * FROM public.quant_selection_replay_events WHERE selection_id=$1',[p.id])).rows;
  const same=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)});
  assert.deepEqual([same.ok,same.match,same.recomputed_outcome_hash],[true,true,row.outcome_hash]);assert.deepEqual(await replayRows(),[]);
  const changed=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p,['1','2','3'])});
  assert.deepEqual([changed.ok,changed.match,changed.stored_outcome_hash],[true,false,row.outcome_hash]);assert.notEqual(changed.recomputed_outcome_hash,row.outcome_hash);
  const mismatch=await replayRows();
  assert.equal(mismatch.length,1);assert.deepEqual([mismatch[0].kind,mismatch[0].stored_outcome_hash,mismatch[0].recomputed_outcome_hash],['SELECTION_REPLAY_MISMATCH',row.outcome_hash,changed.recomputed_outcome_hash]);
  assert.ok(Number(mismatch[0].at_ms)>BASE-DAY);
  const incomplete=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:[]});
  assert.equal(incomplete.match,false);assert.equal(incomplete.recomputed_outcome_hash,null);assert.equal((await replayRows()).length,2);
  assert.equal((await db.query('SELECT outcome_hash FROM public.quant_selection_outcomes WHERE selection_id=$1',[p.id])).rows[0].outcome_hash,row.outcome_hash,'the stored outcome row is unchanged');
  assert.equal((await replaySelectionOutcome(rt,{owner_id:(await newOwner('qs-rp-stranger')).id,selection_id:p.id,evaluations:[]})).code,'NOT_FOUND');
  const none=await prepared({daysAgo:9});assert.equal((await replaySelectionOutcome(rt,{owner_id:none.owner.id,selection_id:none.id,evaluations:[]})).detail,'NO_OUTCOME');
});

test('outcome: an incomplete ranking is stored as ALL_EVALUATIONS_DONE to INCOMPLETE; a failed recheck ranks nothing; an unreadable searched list blocks; a cancel wins over a late outcome',async()=>{
  // (a) the ranking is incomplete: a missing evaluation
  const a=await prepared({daysAgo:10});await startAll(a);
  const evaluations=(await evaluationsFor(a)).slice(0,2);
  const incomplete=await writeOutcome(rt,{owner_id:a.owner.id,selection_id:a.id,evaluations});
  assert.deepEqual([incomplete.ok,incomplete.ended,incomplete.code,incomplete.event],[false,true,'QR4_EVALUATION_FAILED','ALL_EVALUATIONS_DONE'],JSON.stringify(incomplete));
  const last=(await eventsOf(db,a.id)).pop();
  assert.deepEqual([last.status,last.code,last.completed_evaluation_run_ids.length],['SELECTION_INCOMPLETE','QR4_EVALUATION_FAILED',2]);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_outcomes WHERE selection_id=$1',[a.id])).rows[0].n,0);
  // (b) the recheck fails at the outcome write: nothing is ranked, the selection ends WINDOW_RECHECK_FAILED
  const b=await prepared({daysAgo:11});await startAll(b);
  await addExposure(b.owner,[qr3Event({start_ms:b.registration.window.start_ms,end_ms:b.registration.window.start_ms+MS})]);
  let ranked=false;
  const exposed=await writeOutcome(rt,{owner_id:b.owner.id,selection_id:b.id,readEvaluations:async()=>{ranked=true;return [];}});
  assert.deepEqual([exposed.ok,exposed.ended,exposed.code,exposed.event],[false,true,'QR4_WINDOW_EXPOSED','WINDOW_RECHECK_FAILED']);assert.equal(ranked,false,'the evaluations are not even read');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_outcomes WHERE selection_id=$1',[b.id])).rows[0].n,0);
  // (c) an unreadable searched list at the outcome write blocks it and leaves the selection EVALUATING
  const c=await prepared({daysAgo:12});await startAll(c);
  await newRun(c.owner,{contract:{scope:REAL_SCOPE,source_hash:c.set.runs[0].source,dataset:{start_time:BASE-40*DAY}}});
  const blockedOut=await writeOutcome(rt,{owner_id:c.owner.id,selection_id:c.id,evaluations:await evaluationsFor(c)});
  assert.deepEqual([blockedOut.ok,blockedOut.code,blockedOut.detail,blockedOut.blocked],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE',true]);
  assert.equal(await statusOf(db,c.id),'SELECTION_EVALUATING');
  // (d) after the owner cancel nothing is ranked
  const d=await prepared({daysAgo:13});await startAll(d);
  const cancelled=await cancelSelection(rt,{owner_id:d.owner.id,selection_id:d.id,confirmed:true});assert.equal(cancelled.ok,true);
  const afterCancel=await writeOutcome(rt,{owner_id:d.owner.id,selection_id:d.id,evaluations:await evaluationsFor(d)});
  assert.deepEqual([afterCancel.ok,afterCancel.code],[false,'QR4_TRANSITION_INVALID']);
  // (e) a cancel and an outcome at the same time end with exactly one terminal event
  const e=await prepared({daysAgo:14});await startAll(e);
  const evaluationsE=await evaluationsFor(e);
  const results=await Promise.all([writeOutcome(rt,{owner_id:e.owner.id,selection_id:e.id,evaluations:evaluationsE}),cancelSelection(rt,{owner_id:e.owner.id,selection_id:e.id,confirmed:true})]);
  assert.equal(results.filter(item=>item.ok).length,1,JSON.stringify(results.map(item=>item.code??item.status)));
  const terminal=(await eventsOf(db,e.id)).filter(item=>['SELECTION_COMPLETED','SELECTION_CANCELLED','SELECTION_INCOMPLETE'].includes(item.status));
  assert.equal(terminal.length,1);
  const outcomeRows=(await db.query('SELECT count(*)::int n FROM public.quant_selection_outcomes WHERE selection_id=$1',[e.id])).rows[0].n;
  assert.equal(outcomeRows,terminal[0].status==='SELECTION_COMPLETED'?1:0,'a stored outcome exists exactly when the selection completed');
});

test('outcome guards (QR004 quant_selection_outcome_order, outcome_complete, replay_order) refuse a body that is not the registered, frozen and started selection',async()=>{
  const p=await prepared({daysAgo:15});await startAll(p);
  const read=(await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection;
  const ranked=rankSelection(read.registration,await evaluationsFor(p),{window_dataset_hash:p.dataset});
  const {outcome_hash:_h,...rest}=ranked;
  const insert=(body,over={})=>{const text=canonical(body);return rt.query('INSERT INTO public.quant_selection_outcomes(selection_id,outcome,outcome_hash,body_canonical) VALUES($1,$2,$3,$4)',[p.id,over.outcome??body.outcome,over.hash??sha(text),over.text??text]);};
  const complete=async(body)=>{await insert(body);await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,outcome) VALUES($1,3,'ALL_EVALUATIONS_DONE','SELECTION_COMPLETED',$2)",[p.id,body.outcome]);};
  const mutate=change=>{const body=structuredClone(rest);change(body);return body;};
  const refused=(body,name,code=QR004_)=>guardFailure(rt.transaction(async()=>insert(body),{isolation:'SERIALIZABLE'}),name,code);
  await refused(mutate(body=>{body.registration_hash=hex('other');}),'quant_selection_outcome_order');
  await refused(mutate(body=>{body.window_dataset_hash=hex('other');}),'quant_selection_outcome_order');
  await refused(mutate(body=>{body.fixture=true;}),'quant_selection_outcome_order');
  await refused(mutate(body=>{body.evaluations[0].evaluation_run_id='ev-other';}),'quant_selection_outcome_order');
  await refused(mutate(body=>{body.evaluations[0].run_id='run-other';}),'quant_selection_outcome_order');
  await refused(mutate(body=>{body.evaluations.pop();}),'quant_selection_outcome_order');
  await refused(mutate(body=>{body.evaluations.push(structuredClone(body.evaluations[0]));}),'quant_selection_outcome_order');
  // CHECK violations: hash that is not the text hash, an outcome value that differs from the body, a body hash key, a wrong version
  await assert.rejects(rt.transaction(async()=>insert(rest,{hash:hex('wrong')}),{isolation:'SERIALIZABLE'}),error=>error.code==='23514'&&error.constraint==='quant_selection_outcomes_body_hash_check');
  await assert.rejects(rt.transaction(async()=>insert(rest,{outcome:rest.outcome==='BEST_IN_SCOPE'?'TIED_IN_SCOPE':'BEST_IN_SCOPE'}),{isolation:'SERIALIZABLE'}),error=>error.code==='23514'&&error.constraint==='quant_selection_outcomes_body_outcome_check');
  await assert.rejects(rt.transaction(async()=>insert({...rest,outcome_hash:hex('h')}),{isolation:'SERIALIZABLE'}),error=>error.code==='23514'&&error.constraint==='quant_selection_outcomes_body_no_hash_check');
  await assert.rejects(rt.transaction(async()=>insert({...rest,version:'qr4-outcome-v2'}),{isolation:'SERIALIZABLE'}),error=>error.code==='23514'&&error.constraint==='quant_selection_outcomes_body_version_check');
  // C2: the outcome without its COMPLETED event does not commit; SET CONSTRAINTS ALL IMMEDIATE fails at once; the COMPLETED event without the outcome is refused at the insert
  await guardFailure(rt.transaction(async()=>insert(rest),{isolation:'SERIALIZABLE'}),'quant_selection_outcome_complete');
  await guardFailure(rt.transaction(async()=>{await insert(rest);await rt.query('SET CONSTRAINTS ALL IMMEDIATE');},{isolation:'SERIALIZABLE'}),'quant_selection_outcome_complete');
  await guardFailure(rt.transaction(async()=>rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,outcome) VALUES($1,3,'ALL_EVALUATIONS_DONE','SELECTION_COMPLETED','BEST_IN_SCOPE')",[p.id]),{isolation:'SERIALIZABLE'}),'quant_selection_outcome_order');
  await guardFailure(rt.transaction(async()=>rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,completed_evaluation_run_ids) VALUES($1,3,'ALL_EVALUATIONS_DONE','SELECTION_INCOMPLETE','QR4_EVALUATION_FAILED','{ev-unknown}')",[p.id]),{isolation:'SERIALIZABLE'}),'quant_selection_outcome_order');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_outcomes WHERE selection_id=$1',[p.id])).rows[0].n,0);
  // the valid pair commits (the status event for another outcome value is refused with the stored one in place)
  await guardFailure(rt.transaction(async()=>{await insert(rest);await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,outcome) VALUES($1,3,'ALL_EVALUATIONS_DONE','SELECTION_COMPLETED',$2)",[p.id,rest.outcome==='BEST_IN_SCOPE'?'TIED_IN_SCOPE':'BEST_IN_SCOPE']);},{isolation:'SERIALIZABLE'}),'quant_selection_outcome_order');
  await rt.transaction(async()=>complete(rest),{isolation:'SERIALIZABLE'});
  assert.equal(await statusOf(db,p.id),'SELECTION_COMPLETED');
  // an outcome of a selection that is not EVALUATING anymore, and the replay guard
  await guardFailure(rt.query('INSERT INTO public.quant_selection_outcomes(selection_id,outcome,outcome_hash,body_canonical) VALUES($1,$2,$3,$4)',[p.id,rest.outcome,sha(canonical(rest)),canonical(rest)]),'quant_selection_outcome_order');
  const stored=(await db.query('SELECT outcome_hash FROM public.quant_selection_outcomes WHERE selection_id=$1',[p.id])).rows[0].outcome_hash;
  const replay=(stored_hash,recomputed,kind='SELECTION_REPLAY_MISMATCH')=>rt.query('INSERT INTO public.quant_selection_replay_events(selection_id,kind,stored_outcome_hash,recomputed_outcome_hash) VALUES($1,$2,$3,$4)',[p.id,kind,stored_hash,recomputed]);
  await guardFailure(replay(hex('not-stored'),hex('r')),'quant_selection_replay_order');
  await assert.rejects(replay(stored,stored),error=>error.code==='23514'&&error.constraint==='quant_selection_replay_events_recomputed_check');
  await assert.rejects(replay(stored,hex('r'),'SELECTION_OTHER'),error=>error.code==='23514'&&error.constraint==='quant_selection_replay_events_kind_check');
  await replay(stored,null);
  await guardFailure(rt.query('INSERT INTO public.quant_selection_replay_events(selection_id,kind,stored_outcome_hash,recomputed_outcome_hash) VALUES($1,$2,$3,$4)',[randomUUID(),'SELECTION_REPLAY_MISMATCH',stored,hex('r')]),'quant_selection_replay_order');
});

/* ---- 6. C1 zero-row checks, insert-only, SERIALIZABLE only ---- */

test('a freeze in the registration transaction is refused at once (freeze_order); QR003 and QR002 hold on the four new tables',async()=>{
  const p=await prepared({daysAgo:16,freeze:false});
  const row=(await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1',[p.id])).rows[0];
  const universe=(await db.query('SELECT * FROM public.quant_selection_universe WHERE selection_id=$1 ORDER BY position',[p.id])).rows;
  const participants=(await db.query('SELECT * FROM public.quant_selection_participants WHERE selection_id=$1 ORDER BY position',[p.id])).rows;
  const clock=await dbClock(rt),body=JSON.parse(row.body_canonical);
  body.selection_id=randomUUID();body.registration_key=sha('c1:'+randomUUID());body.registered_at_ms=clock;
  const text=canonical(body),id=body.selection_id;
  const write=async(tx,withFreeze)=>{
    await tx.query(`INSERT INTO public.quant_selection_registrations(selection_id,owner_id,fixture,broker,symbol,timeframe,window_kind,start_ms,end_ms,warmup_bars,evaluation_bars,total_bars,participant_count,
      admission_deadline_ms,registered_at_ms,registration_key,registration_hash,body_canonical) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id,row.owner_id,row.fixture,row.broker,row.symbol,row.timeframe,row.window_kind,row.start_ms,row.end_ms,row.warmup_bars,row.evaluation_bars,row.total_bars,row.participant_count,row.admission_deadline_ms,clock,body.registration_key,sha(text),text]);
    for(const u of universe)await tx.query('INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,u.position,u.run_id,u.member_kind,u.universe_status,u.first_code,u.export_id]);
    for(const q of participants)await tx.query(`INSERT INTO public.quant_selection_participants(selection_id,export_id,position,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id,q.export_id,q.position,q.run_id,q.package_hash,q.source_hash,q.rules_hash,q.validation_package_hash,q.validated_at_utc]);
    await tx.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,1,'REGISTER','SELECTION_REGISTERED')",[id]);
    if(withFreeze)await tx.query('INSERT INTO public.quant_selection_window_freezes(selection_id,dataset_hash,start_ms,end_ms,bars_total) VALUES($1,$2,$3,$4,$5)',[id,hex('d'),row.start_ms,row.end_ms,row.total_bars]);
  };
  await guardFailure(rt.transaction(async()=>write(rt,true),{isolation:'SERIALIZABLE'}),'quant_selection_freeze_order');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE selection_id=$1',[id])).rows[0].n,0);
  await rt.transaction(async()=>write(rt,false),{isolation:'SERIALIZABLE'});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE selection_id=$1',[id])).rows[0].n,1,'the same registration without the freeze commits');
  // a finished selection with a row in every new table
  const f=await prepared({daysAgo:17});await startAll(f);
  assert.equal((await writeOutcome(rt,{owner_id:f.owner.id,selection_id:f.id,evaluations:await evaluationsFor(f)})).ok,true);
  assert.equal((await replaySelectionOutcome(rt,{owner_id:f.owner.id,selection_id:f.id,evaluations:[]})).match,false);
  const sizes=await counts(db);for(const table of NEW_TABLES)assert.ok(sizes[table]>0,table);
  for(const [table,column] of [['quant_selection_window_freezes','dataset_hash'],['quant_selection_evaluation_starts','engine_hash'],['quant_selection_outcomes','outcome'],['quant_selection_replay_events','kind']]){
    for(const sql of [`UPDATE public.${table} SET ${column}=${column}`,`DELETE FROM public.${table}`,`TRUNCATE public.${table}`,`TRUNCATE public.${table} CASCADE`])await assert.rejects(rt.query(sql),{code:DENIED},table+' '+sql);
    await assert.rejects(DL.query(`UPDATE public.${table} SET ${column}=${column}`),{code:QR002},table);await assert.rejects(DL.query(`DELETE FROM public.${table}`),{code:QR002},table);
    await assert.rejects(DL.query(`TRUNCATE TABLE public.${table} CASCADE`),{code:QR002},table);
    await assert.rejects(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`DELETE FROM public.${table}`);}),{code:QR002},table+' replica');
    for(const isolation of ['READ COMMITTED','REPEATABLE READ'])await assert.rejects(db.transaction(async()=>db.query(`INSERT INTO public.${table} DEFAULT VALUES`),{isolation}),{code:QR003},table+' '+isolation);
  }
  assert.deepEqual(await counts(db),sizes,'no row changed');
});

/* ---- 7. concurrency and the lock-first reader ---- */

test('readExposuresLocked waits for an open register writer and then sees its row (D1-A); a plain read does not wait',async()=>{
  const owner=await newOwner('qs-lockread');
  let release,opened;const gate=new Promise(resolve=>{release=resolve;}),signal=new Promise(resolve=>{opened=resolve;});
  const writer=rt.transaction(async()=>{
    const appended=await appendExposures(rt,{owner_id:owner.id,...MARKET,events:[qr3Event({start_ms:BASE-40*DAY,end_ms:BASE-40*DAY+MS},'lock')]});assert.equal(appended.ok,true);
    opened();await gate;
  },{isolation:'SERIALIZABLE'});
  await signal;
  let settled=false;
  const reader=rt.transaction(async()=>readExposuresLocked(rt,{owner_id:owner.id,...MARKET}),{isolation:'SERIALIZABLE'}).then(result=>{settled=true;return result;});
  const plain=await rt.transaction(async()=>readExposures(rt,{owner_id:owner.id,...MARKET}),{isolation:'SERIALIZABLE'});
  assert.equal(plain.rows.length,0,'a plain read does not wait and does not see the uncommitted row');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(settled,false,'the locked read waits for the open writer');
  release();await writer;
  const locked=await reader;
  assert.equal(locked.ok,true);assert.equal(locked.rows.length,1,'after the writer committed the locked read already sees its row');
  await assert.rejects(rt.transaction(async()=>readExposuresLocked(rt,{owner_id:owner.id,...MARKET}),{isolation:'REPEATABLE READ'}),{code:QR003});
});

test('races (16.2 item 10): two selections with overlapping W start at once, one wins and the other ends QR4_WINDOW_EXPOSED, also after a forced 40001; a QR-3 writer and a first start never both win',async()=>{
  for(const round of [0,1]){
    const owner=await newOwner('qs-race-'+round),setA=await newSet(owner,{n:2}),setB=await newSet(owner,{n:2});
    const a=await prepared({owner,set:setA,n:2,daysAgo:18+round*2}),b=await prepared({owner,set:setB,n:2,daysAgo:18+round*2,offsetMin:300});
    let thrown=0;
    const forcing=round===1?{participantCheck:async()=>{if(thrown<2){thrown++;throw Object.assign(Error('forced serialization failure'),{code:'40001'});}return null;}}:{};
    const results=await Promise.all([startOne(a,0,forcing),startOne(b,0,forcing)]);
    const winners=results.filter(item=>item.ok),losers=results.filter(item=>!item.ok);
    assert.equal(winners.length,1,JSON.stringify(results));assert.deepEqual([losers[0].ended,losers[0].code],[true,'QR4_WINDOW_EXPOSED']);
    assert.equal((await ownRegisterRows(db,a.id)).length+(await ownRegisterRows(db,b.id)).length,1,'exactly one register row commits');
    if(round===1)assert.ok(thrown>=1,'the winner passed the hook and was retried after a forced 40001');
  }
  const owner=await newOwner('qs-race-qr3'),set=await newSet(owner,{n:2});
  const p=await prepared({owner,set,n:2,daysAgo:24});
  const w=windowOf(p);
  const qr3=db.transaction(async()=>appendExposures(db,{owner_id:owner.id,...MARKET,events:[qr3Event({start_ms:w.start_ms+MS,end_ms:w.start_ms+2*MS},'race')],
    check:async read=>toComparisonEntries(read).some(entry=>entry.window.start_ms<w.start_ms+2*MS&&w.start_ms+MS<entry.window.end_ms)?'OVERLAP':null}),{isolation:'SERIALIZABLE'});
  const [started,written]=await Promise.all([startOne(p,0),qr3]);
  assert.equal([started.ok===true,written.ok===true].filter(Boolean).length,1,JSON.stringify([started,written]));
  if(started.ok)assert.equal(written.code,'EXPOSURE_CHECK_REFUSED');else assert.equal(started.code,'QR4_WINDOW_EXPOSED');
});

after(async()=>{
  await admin.query('DROP ROLE IF EXISTS '+deleterName).catch(()=>{});
});

/* ---- 8. round 2: steps inside the registration transaction, evaluation lists, register ownership, deadline order, branches, options ---- */

/** The writer of a second registration copied from the rows of p (a new selection id and key); write(tx) inserts the registration, universe, participants and the seq 1 event. */
async function rawRegistration(p){
  const row=(await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1',[p.id])).rows[0];
  const universe=(await db.query('SELECT * FROM public.quant_selection_universe WHERE selection_id=$1 ORDER BY position',[p.id])).rows;
  const participants=(await db.query('SELECT * FROM public.quant_selection_participants WHERE selection_id=$1 ORDER BY position',[p.id])).rows;
  const clock=await dbClock(rt),body=JSON.parse(row.body_canonical);
  body.selection_id=randomUUID();body.registration_key=sha('r2:'+randomUUID());body.registered_at_ms=clock;
  const text=canonical(body),id=body.selection_id;
  const write=async tx=>{
    await tx.query(`INSERT INTO public.quant_selection_registrations(selection_id,owner_id,fixture,broker,symbol,timeframe,window_kind,start_ms,end_ms,warmup_bars,evaluation_bars,total_bars,participant_count,
      admission_deadline_ms,registered_at_ms,registration_key,registration_hash,body_canonical) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id,row.owner_id,row.fixture,row.broker,row.symbol,row.timeframe,row.window_kind,row.start_ms,row.end_ms,row.warmup_bars,row.evaluation_bars,row.total_bars,row.participant_count,row.admission_deadline_ms,clock,body.registration_key,sha(text),text]);
    for(const u of universe)await tx.query('INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,u.position,u.run_id,u.member_kind,u.universe_status,u.first_code,u.export_id]);
    for(const q of participants)await tx.query(`INSERT INTO public.quant_selection_participants(selection_id,export_id,position,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id,q.export_id,q.position,q.run_id,q.package_hash,q.source_hash,q.rules_hash,q.validation_package_hash,q.validated_at_utc]);
    await tx.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,1,'REGISTER','SELECTION_REGISTERED')",[id]);
  };
  return {id,row,participants,write};
}
const registrationRows=async id=>(await db.query('SELECT count(*)::int n FROM public.quant_selection_registrations WHERE selection_id=$1',[id])).rows[0].n;
/** The probe shape: run the C1 check early (everything is complete), then defer again, so no deferred check is left for the later rows. */
const earlyCheck=async tx=>{await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('SET CONSTRAINTS ALL DEFERRED');};

test('QR-4 S2-2 round 2: a freeze, an evaluation start, an outcome and FIRST_EVALUATION_START are refused in the transaction that wrote the registration, also after an early SET CONSTRAINTS IMMEDIATE then DEFERRED',async()=>{
  const source=await prepared({daysAgo:30,freeze:false});
  const steps={
    freeze:[(tx,r)=>tx.query('INSERT INTO public.quant_selection_window_freezes(selection_id,dataset_hash,start_ms,end_ms,bars_total) VALUES($1,$2,$3,$4,$5)',[r.id,hex('d'),r.row.start_ms,r.row.end_ms,r.row.total_bars]),'quant_selection_freeze_order','A window freeze cannot run in the transaction that wrote the registration'],
    start:[(tx,r)=>tx.query('INSERT INTO public.quant_selection_evaluation_starts(selection_id,export_id,evaluation_run_id,parent_run_id,dataset_hash,engine_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [r.id,r.participants[0].export_id,'ev-'+randomUUID(),r.participants[0].run_id,hex('d'),ENGINE]),'quant_selection_start_order','An evaluation start cannot run in the transaction that wrote the registration'],
    outcome:[(tx,r)=>tx.query("INSERT INTO public.quant_selection_outcomes(selection_id,outcome,outcome_hash,body_canonical) VALUES($1,'BEST_IN_SCOPE',$2,'{}')",[r.id,hex('o')]),'quant_selection_outcome_order','An outcome cannot be stored in the transaction that wrote the registration'],
    first_event:[async(tx,r)=>{
      await appendExposures(tx,{owner_id:r.row.owner_id,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:Number(r.row.start_ms),end_ms:Number(r.row.end_ms)},selection_id:r.id}]});
      await tx.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')",[r.id]);
    },'quant_selection_exposure_bind','FIRST_EVALUATION_START cannot run in the transaction that wrote the registration'],
    cancel_event:[(tx,r)=>tx.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'OWNER_CANCEL','SELECTION_CANCELLED')",[r.id]),
      'quant_selection_status_transition','A status event after the first cannot run in the transaction that wrote the registration']};
  for(const [name,[step,guard,message]] of Object.entries(steps)){
    for(const early of [false,true]){
      const r=await rawRegistration(source);
      await guardMessage(rt.transaction(async()=>{await r.write(rt);if(early)await earlyCheck(rt);await step(rt,r);},{isolation:'SERIALIZABLE'}),guard,message);
      assert.equal(await registrationRows(r.id),0,name+(early?' (early check)':'')+': nothing committed');
    }
  }
  // the same registration without a later step commits, so the refusals above belong to the later step
  const ok=await rawRegistration(source);
  await rt.transaction(async()=>{await ok.write(rt);await earlyCheck(rt);},{isolation:'SERIALIZABLE'});
  assert.equal(await registrationRows(ok.id),1);
  // a replay event needs a stored outcome, which cannot exist in the registration transaction: the replay guard still refuses it by its first rule
  const r=await rawRegistration(source);
  await guardMessage(rt.transaction(async()=>{await r.write(rt);await earlyCheck(rt);
    await rt.query("INSERT INTO public.quant_selection_replay_events(selection_id,kind,stored_outcome_hash,recomputed_outcome_hash) VALUES($1,'SELECTION_REPLAY_MISMATCH',$2,NULL)",[r.id,hex('o')]);},{isolation:'SERIALIZABLE'}),'quant_selection_replay_order','A replay mismatch needs the stored outcome hash of the selection');
});

test('QR-4 S2-2 round 2: the exposure bind accepts a register row written in a subtransaction of the same transaction (savepoint), and still refuses an older orphan row',async()=>{
  const p=await prepared({daysAgo:8});
  const part=p.registration.participants.find(item=>item.export_id===p.exports[0]);
  await rt.transaction(async()=>{
    await rt.query('SAVEPOINT sp_register');
    await appendExposures(rt,{owner_id:p.owner.id,...MARKET,events:[{kind:'QR4_SELECTION',window:windowOf(p),selection_id:p.id}]});
    await rt.query('RELEASE SAVEPOINT sp_register');
    await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')",[p.id]);
    await rt.query('INSERT INTO public.quant_selection_evaluation_starts(selection_id,export_id,evaluation_run_id,parent_run_id,dataset_hash,engine_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [p.id,p.exports[0],'ev-'+randomUUID(),part.run_id,p.dataset,ENGINE]);
  },{isolation:'SERIALIZABLE'});
  assert.equal(await statusOf(db,p.id),'SELECTION_EVALUATING');assert.equal((await ownRegisterRows(db,p.id)).length,1);
  // the older orphan row (committed by an earlier transaction, so its xmin is not this transaction's) never satisfies the bind, savepoint or not
  const q=await prepared({daysAgo:8,offsetMin:7});
  await addExposure(q.owner,[{kind:'QR4_SELECTION',window:windowOf(q),selection_id:q.id}]);
  assert.equal((await ownRegisterRows(db,q.id)).length,1);
  await guardMessage(rt.transaction(async()=>{
    await rt.query('SAVEPOINT sp_orphan');await rt.query('RELEASE SAVEPOINT sp_orphan');
    await rt.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')",[q.id]);
  },{isolation:'SERIALIZABLE'}),'quant_selection_exposure_bind','FIRST_EVALUATION_START needs the exposure register row of the selection, written by the same transaction');
  assert.equal(await statusOf(db,q.id),'SELECTION_REGISTERED');
});

test('QR-4 S2-2 round 2: writeOutcome without a usable evaluation list throws a retryable error and writes nothing; a later call with the list completes',async()=>{
  const p=await prepared({daysAgo:9});await startAll(p);
  const before=await counts(db),events=await eventsOf(db,p.id);
  const attempts=[{},{evaluations:null},{evaluations:{}},{evaluations:'x'},{readEvaluations:async()=>null},{readEvaluations:async()=>({})},{readEvaluations:async()=>undefined}];
  for(const attempt of attempts){
    await assert.rejects(writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,...attempt}),error=>error.code===EVALUATIONS_UNAVAILABLE&&error.retryable===true,JSON.stringify(Object.keys(attempt)));
    assert.deepEqual(await counts(db),before,'nothing was written');assert.deepEqual(await eventsOf(db,p.id),events);assert.equal(await statusOf(db,p.id),'SELECTION_EVALUATING');
  }
  const done=await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)});
  assert.equal(done.ok,true,JSON.stringify(done));assert.equal(await statusOf(db,p.id),'SELECTION_COMPLETED');
  // an empty array is a list (the ranking judges it), not a missing one
  const q=await prepared({daysAgo:10});await startAll(q);
  const empty=await writeOutcome(rt,{owner_id:q.owner.id,selection_id:q.id,evaluations:[]});
  assert.equal(empty.ended,true,JSON.stringify(empty));assert.equal(await statusOf(db,q.id),'SELECTION_INCOMPLETE');
});

test('QR-4 S2-2 round 3: replaySelectionOutcome without a usable evaluation list throws a retryable error and writes nothing; a later call with the list matches',async()=>{
  const p=await prepared({daysAgo:12});await startAll(p);
  const done=await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)});
  assert.equal(done.ok,true,JSON.stringify(done));
  const before=await counts(db),events=await eventsOf(db,p.id);
  const attempts=[{},{evaluations:null},{evaluations:{}},{evaluations:'x'},{readEvaluations:async()=>null},{readEvaluations:async()=>({})},{readEvaluations:async()=>undefined}];
  for(const attempt of attempts){
    await assert.rejects(replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,...attempt}),error=>error.code===EVALUATIONS_UNAVAILABLE&&error.retryable===true,JSON.stringify(Object.keys(attempt)));
    assert.deepEqual(await counts(db),before,'no replay row was written');assert.deepEqual(await eventsOf(db,p.id),events);
  }
  const replay=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)});
  assert.equal(replay.ok,true,JSON.stringify(replay));assert.equal(replay.match,true);
});

test('QR-4 S2-2 round 2: a register row of another owner that names this selection id maps to INTEGRITY_CHECK_FAILED and blocks the step; nothing is written',async()=>{
  const p=await prepared({daysAgo:11}),stranger=await newOwner('qs-r2-stranger');
  await addExposure(stranger,[{kind:'QR4_SELECTION',window:windowOf(p),selection_id:p.id}]);
  const blockedStart=await startOne(p,0);
  assert.deepEqual([blockedStart.ok,blockedStart.code,blockedStart.detail,blockedStart.blocked],[false,'INTEGRITY_CHECK_FAILED','EXPOSURE_SELECTION_TAKEN',true],JSON.stringify(blockedStart));
  assert.equal(await statusOf(db,p.id),'SELECTION_REGISTERED');const rows=await ownRegisterRows(db,p.id);assert.deepEqual(rows.map(row=>row.owner_id),[stranger.id],'only the stranger row exists');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_selection_evaluation_starts WHERE selection_id=$1',[p.id])).rows[0].n,0);
});

test('QR-4 S2-2 round 2: the admission deadline is judged before the exposure order, so a passed deadline ends a selection that an orphan register row would block',async()=>{
  const p=await prepared({daysAgo:12,over:{admission_deadline_ms:BASE-12*DAY+1000*MS}});
  await addExposure(p.owner,[{kind:'QR4_SELECTION',window:windowOf(p),selection_id:p.id}]);
  const out=await startOne(p,0);
  assert.deepEqual([out.ok,out.ended,out.code,out.event],[false,true,'QR4_ADMISSION_REFUSED','DEADLINE_PASSED'],JSON.stringify(out));
  assert.equal(await statusOf(db,p.id),'SELECTION_INCOMPLETE');
  // before the deadline the same orphan row still blocks
  const q=await prepared({daysAgo:13});
  await addExposure(q.owner,[{kind:'QR4_SELECTION',window:windowOf(q),selection_id:q.id}]);
  const blockedStart=await startOne(q,0);
  assert.deepEqual([blockedStart.code,blockedStart.detail,blockedStart.blocked],['INTEGRITY_CHECK_FAILED','ORPHAN_EXPOSURE',true]);
});

/** A copy of rt whose result rows are changed for the statements the matcher selects (the database itself is untouched). */
function doctored(match,change){
  const spy=Object.create(rt);
  spy.query=async(sql,params)=>{const result=await rt.query(sql,params);return match(String(sql).replace(/\s+/g,' ').trim())?{...result,rows:change(result.rows)}:result;};
  spy.transaction=(fn,options)=>rt.transaction(fn,options);
  return spy;
}

test('QR-4 S2-2 round 2: a later step blocks with EXPOSURE_MISSING when the register row of the started selection is missing or over another window, and with EXPOSURE_WITHOUT_START when the start event is missing',async()=>{
  const p=await prepared({daysAgo:14});
  assert.equal((await startOne(p,0)).ok,true);
  const before=await counts(db),events=await eventsOf(db,p.id);
  const registerRead=sql=>/^SELECT .* FROM public\.quant_exposure_register WHERE owner_id/.test(sql);
  const shift=value=>typeof value==='string'?String(Number(value)-MS):Number(value)-MS;
  const variants=[
    ['the row is missing',doctored(registerRead,rows=>rows.filter(row=>row.kind!=='QR4_SELECTION'))],
    ['the row is over another window',doctored(registerRead,rows=>rows.map(row=>row.kind==='QR4_SELECTION'?{...row,end_ms:shift(row.end_ms)}:row))]];
  for(const [label,spy] of variants){
    const out=await startEvaluation(spy,{owner_id:p.owner.id,selection_id:p.id,export_id:p.exports[1],evaluation_run_id:'ev-'+randomUUID()});
    assert.deepEqual([out.ok,out.code,out.detail,out.blocked],[false,'INTEGRITY_CHECK_FAILED','EXPOSURE_MISSING',true],label+' '+JSON.stringify(out));
  }
  const noEvent=doctored(sql=>/AND event='FIRST_EVALUATION_START'/.test(sql),()=>[]);
  const missingEvent=await startEvaluation(noEvent,{owner_id:p.owner.id,selection_id:p.id,export_id:p.exports[1],evaluation_run_id:'ev-'+randomUUID()});
  assert.deepEqual([missingEvent.ok,missingEvent.code,missingEvent.detail,missingEvent.blocked],[false,'INTEGRITY_CHECK_FAILED','EXPOSURE_WITHOUT_START',true],JSON.stringify(missingEvent));
  const outcomeBlocked=await writeOutcome(noEvent,{owner_id:p.owner.id,selection_id:p.id,evaluations:[]});
  assert.deepEqual([outcomeBlocked.code,outcomeBlocked.detail],['INTEGRITY_CHECK_FAILED','EXPOSURE_WITHOUT_START']);
  assert.deepEqual(await counts(db),before,'nothing was written');assert.deepEqual(await eventsOf(db,p.id),events);
  // without the doctoring the second start works
  assert.equal((await startOne(p,1)).ok,true);
});

test('QR-4 S2-2 round 2: the now option of startEvaluation needs the internal option; readSelection reports replay_mismatch',async()=>{
  const p=await prepared({daysAgo:15});
  for(const over of [{now:()=>1},{now:123},{now:null},{now:()=>1,internal:false},{now:'x',internal:true}]){
    const out=await startOne(p,0,over);
    assert.deepEqual([out.ok,out.code,out.detail],[false,'INVALID_FIELDS','NOW'],JSON.stringify(over));
  }
  assert.equal(await statusOf(db,p.id),'SELECTION_REGISTERED');assert.deepEqual(await ownRegisterRows(db,p.id),[]);
  const fixed=Date.now()-7;
  const first=await startOne(p,0,{now:()=>fixed,internal:true});
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(Number((await db.query("SELECT at_ms FROM public.quant_exposure_register WHERE kind='QR4_SELECTION' AND selection_id=$1",[p.id])).rows[0].at_ms),fixed,'the internal clock stamps the register row');
  // replay_mismatch: false until a replay mismatch row exists
  await startOne(p,1);await startOne(p,2);
  assert.equal((await writeOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)})).ok,true);
  assert.equal((await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection.replay_mismatch,false);
  assert.equal((await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:await evaluationsFor(p)})).match,true);
  assert.equal((await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection.replay_mismatch,false,'an equal replay writes no row');
  assert.equal((await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:[]})).match,false);
  assert.equal((await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection.replay_mismatch,true);
});
