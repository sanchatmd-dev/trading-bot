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
import {appendExposures} from '../../src/postgres/exposure-register.js';
import {QUALIFICATION_VERSION} from '../../src/selection/eligibility.js';
import {registerSelection,cancelSelection,readSelection,freezeWindow,startEvaluation,replaySelectionOutcome,readSearchedWindows} from '../../src/postgres/selection-store.js';
import {OBJECTIVE_REGISTRY,rankSelection} from '../../src/selection/index.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {PACKAGE_FILES} from '../../src/quant-library/package-gates.js';
import {finalizeSelection,readSelectionEvaluations} from '../../src/selection-eval/selection-finalizer.js';
import {selectionEvaluationOf} from '../../src/selection-eval/evaluation-adapter.js';
import {validateFixedEvalContract,validateFixedEvalResult,refuseSearchFields} from '../../src/quant-research/fixed-eval-contract.js';
import {FIXTURE_LABEL,hex,T0} from '../helpers/quant-library-fixture.mjs';
import {qr4FixedRunWorld} from '../helpers/quant-fixed-eval-fixture.mjs';

// QR-4 slice Q4-A on a real PostgreSQL cluster: the unwired finalizer (src/selection-eval/selection-finalizer.js) and the adapter behind it, with the real selection store
// (registration, window freeze, the exposure-first evaluation start, the outcome writer and the outcome replay) as a real non-owner LOGIN role with the repo grants.
// The fixed-evaluation runs are LABELLED SYNTHETIC FIXTURES: their job rows are inserted before the start rows (the order slice Q4-S will make a guard; Root ruling SB203
// item 8), their results are built through the real builders and checked by the real validators, and the finalizer reads them through injected dependencies, as the later
// wiring slice will. No Python and no worker run, and the fixed-evaluation service is not used: its QR4_SELECTION path has no PostgreSQL test yet (it comes with the wiring
// slice). The tie tolerances are an injected TEST registry (OD-S3 is unset; the product registry refuses). Nothing here is a research result. One file per process.
const sourceDir=new URL('../../src/postgres/',import.meta.url);
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
const clone=value=>structuredClone(value);

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_q4a_tpl_'+suffix;databaseName='robot_q4a_main_'+suffix;roleName='robot_q4a_rt_'+suffix.slice(0,14);
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
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:10})));
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
const SCOPE={market:structuredClone(MARKET),data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'10'},
  capital:{equity:'10000',cash:'10000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const range=(fromDays,toDays)=>({start_ms:BASE-fromDays*DAY,end_ms:BASE-toDays*DAY});
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
const qualification=()=>({version:QUALIFICATION_VERSION,qualified:true,label:'QUALIFIED',gates:GATES.map(gate=>({gate,name:'N_'+gate,state:'PASS',code:null}))});
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
async function newRun(owner,{source=hex('source:'+randomUUID()),start=BASE-40*DAY,split={warmup:0,train_end:600,validation_end:800,test_end:1000},status='SUCCEEDED'}={}){
  const runId='run-'+randomUUID();
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,[runId,owner.id,owner.deployment,'idem-'+runId,hex('submission'),hex('contract'),
    JSON.stringify({scope:REAL_SCOPE,label:FIXTURE_LABEL,source_hash:source,dataset:{start_time:start},split}),status,T0,T0+900000]);
  return {runId,source};
}
/** One validated export of a run taken through the documented path (blobs, export, files, seq 1 event, passing attempt, validation, seq 2). */
async function newExport(owner,run){
  const files=Object.fromEntries(PACKAGE_FILES.map(file=>[file,Buffer.from(FIXTURE_LABEL+'\n'+run.runId+'\n'+file+'\n')]));
  const exportId=randomUUID(),packageHash=sha(files['quant-data/manifest.json']),bindingHash=hex('binding:'+exportId);
  await db.transaction(async()=>{
    for(const bytes of Object.values(files))await db.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(bytes),bytes.length,bytes]);
    await db.query(EXPORT_SQL,[exportId,owner.id,owner.id,run.runId,null,'ONE_PINE',false,false,'best-inputs-gates-v1',JSON.stringify({label:FIXTURE_LABEL}),
      JSON.stringify({owner_id:owner.id,bot_id:owner.id,run_id:run.runId,mode:'ONE_PINE',fixture:false,created_at:UTC}),bindingHash,packageHash,JSON.stringify({gate:'B0',state:'PASS',codes:[]}),T0,UTC]);
    for(const [file,bytes] of Object.entries(files))await db.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[exportId,file,sha(bytes),bytes.length]);
    await db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,'EXPORT_CANDIDATE','{}',NULL,$2,$3)",[exportId,T0+1,UTC]);
  },{isolation:'SERIALIZABLE'});
  const attemptId='att-'+randomUUID();
  await db.query(`INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
    VALUES($1,1,$2,$3,true,'{}','[]','{}',$4,$5,$6)`,[exportId,attemptId,packageHash,hex('validator'),T0+2,UTC]);
  await db.query(`INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc)
    VALUES($1,$2,$3,$4,'[]',$5,false,$6,$7)`,[exportId,packageHash,bindingHash,attemptId,hex('validator'),T0+3,UTC]);
  await db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,'EXPORT_VALIDATED','{}',1,$2,$3)",[exportId,T0+4,UTC]);
  return {exportId,packageHash,bindingHash};
}
/** The pure-module universe member of a run and its validated export (the shape src/selection/eligibility.js reads). */
function memberOf(owner,run,exp,i){
  const binding={mode:'ONE_PINE',fixture:false,pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i,membership:[{pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:hex('lock'+i)};
  const current={...structuredClone(binding),dataset_available:true,bot_owner_id:owner.id};
  return {kind:'RESEARCH_RUN',owner_id:owner.id,run_id:run.runId,export_id:exp.exportId,created_at_ms:BASE-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:run.source,market:structuredClone(MARKET),
    qualification:qualification(),integrity_checked:true,
    package:{export_id:exp.exportId,package_hash:exp.packageHash,status:'EXPORT_VALIDATED',binding,current,replay_mismatch:false},
    validation_records:[{run_id:run.runId,mode:'ONE_PINE',record:{fixture:false,export_id:exp.exportId,package_hash:exp.packageHash,binding_hash:exp.bindingHash,validated_at_utc:UTC,
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:structuredClone(SCOPE.data_model),cost_model:structuredClone(SCOPE.cost_model),capital:structuredClone(SCOPE.capital),policy:structuredClone(SCOPE.policy),engine:ENGINE},
    library_class:'READY_FOR_REVIEW',rules_hash:RULES,rules:structuredClone(RULES_OBJECT),
    data_windows:{dataset:range(60,30),train:range(60,50),validation:range(50,40),holdout:range(40,30)},registered_boundary_ms:null};
}
async function newSet(owner,{n=3}={}){
  const runs=[],exports=[],members=[];
  for(let i=1;i<=n;i++){
    const run=await newRun(owner),exp=await newExport(owner,run);
    runs.push(run);exports.push(exp);members.push(memberOf(owner,run,exp,i));
  }
  return {runs,exports,members};
}

/* ---- helpers of this suite: FORWARD_PAST selections over W (200 evaluated bars after the 1006 bar warm-up of the fixed-evaluation contract), runs, dependencies ---- */

const EVALUATED=200,WARMUP=1006;
const pastRequest=(owner,set,{daysAgo=5}={})=>{
  const start=BASE-daysAgo*DAY;
  return {owner_id:owner.id,confirmed:true,fixture:false,scope:structuredClone(SCOPE),window:{kind:'FORWARD_PAST',start_ms:start,end_ms:start+EVALUATED*MS,warmup_bars:WARMUP},objective:{id:OBJECTIVE_ID},
    filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},admission_deadline_ms:BASE+DAY,universe:set.members};
};
const contextOf=owner=>({dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},universe_cap:20,requester_owner_id:owner.id,
  policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},objective_registry:TEST_REGISTRY,fixture_selections_allowed:true});
/** A registered and frozen selection of a fresh owner, with the fixed run of every participant inserted as a QUEUED job (before its start row) but not yet started. */
async function prepared({n=3,daysAgo=5}={}){
  const owner=await newOwner('q4a'),set=await newSet(owner,{n});
  const reg=await registerSelection(rt,{request:pastRequest(owner,set,{daysAgo}),context:contextOf(owner)});
  assert.equal(reg.ok,true,JSON.stringify(reg));
  const dataset=hex('dataset:'+reg.selection_id);
  const frozen=await freezeWindow(rt,{owner_id:owner.id,selection_id:reg.selection_id,dataset_hash:dataset});
  assert.equal(frozen.ok,true,JSON.stringify(frozen));
  const p={owner,set,id:reg.selection_id,dataset,registration:reg.registration,runs:[]};
  assert.deepEqual(reg.registration.window,{kind:'FORWARD_PAST',start_ms:BASE-daysAgo*DAY,end_ms:BASE-daysAgo*DAY+EVALUATED*MS,warmup_bars:WARMUP,evaluation_bars:EVALUATED,total_bars:WARMUP+EVALUATED});
  return p;
}
const SIZES=['10','20','5','15'];
const worldOf=(p,participant,index,over={})=>qr4FixedRunWorld({objectId:p.id,parentRunId:participant.run_id,window:p.registration.window,engine:ENGINE,datasetSha:p.dataset,owner:p.owner.id,bot:p.owner.id,
  deployment:p.owner.deployment,size:SIZES[index],...over});
/** The fixed job row of one participant, inserted QUEUED (the shape the fixed-evaluation service writes for a QR4_SELECTION run). */
async function insertRun(p,participant,index,{world=worldOf(p,participant,index),runId='ev-'+randomUUID(),contractHash=hash(canonical(world.contract))}={}){
  await db.query(`INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,phase,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED','FIXED_EVAL',$8,$8,$9)`,[runId,p.owner.id,p.owner.deployment,'fixed:'+runId,hex('submission:'+runId),contractHash,JSON.stringify(world.contract),T0,T0+900000]);
  return {runId,world,participant};
}
/** Job row first, then the exposure-first start row, for the participants in the given index list. */
async function startRuns(p,indexes=p.registration.participants.map((_,index)=>index)){
  for(const index of indexes){
    const participant=p.registration.participants[index],run=await insertRun(p,participant,index);
    const started=await startEvaluation(rt,{owner_id:p.owner.id,selection_id:p.id,export_id:participant.export_id,evaluation_run_id:run.runId});
    assert.equal(started.ok,true,JSON.stringify(started));
    p.runs[index]={...run,export_id:participant.export_id};
  }
  return p;
}
const setStatus=(run,status)=>db.query('UPDATE public.quant_jobs SET status=$2 WHERE run_id=$1',[run.runId,status]);
const succeedAll=async(p,except=[])=>{for(const [index,run] of p.runs.entries())if(!except.includes(index))await setStatus(run,'SUCCEEDED');};
const VALIDATORS={validateFixedEvalContract,validateFixedEvalResult};
/** Dependencies over the fixture worlds; every call is counted, and a hook may change the answer or throw. */
function depsOf(p,{hooks={}}={}){
  const calls={readEvaluation:0,readRows:0},byRun=new Map(p.runs.map(run=>[run.runId,run]));
  return {calls,validators:VALIDATORS,
    async readEvaluation(owner,runId){calls.readEvaluation+=1;const run=byRun.get(runId);assert.ok(run,'a run of this selection');assert.equal(owner,p.owner.id);
      if(hooks.readEvaluation)await hooks.readEvaluation(run);
      return {contract:clone(run.world.contract),binding:clone(run.world.binding),result:clone(hooks.result?hooks.result(run):run.world.result),status:'SUCCEEDED'};},
    async readRows(owner,runId,binding){calls.readRows+=1;const run=byRun.get(runId);assert.ok(run);assert.deepEqual(binding,run.world.binding,'rows come only through the binding of that run');
      if(hooks.readRows)await hooks.readRows(run);
      return clone(run.world.rows);}};
}
const finalize=(p,deps,target=rt)=>finalizeSelection(target,{owner_id:p.owner.id,selection_id:p.id},deps);
/** What rankSelection gives for the evaluations the adapter builds from the fixture worlds of the runs: the expected outcome. */
function expectedOutcome(p,statuses={}){
  const list=p.runs.map(run=>{
    const status=statuses[run.runId]??'SUCCEEDED';
    const built=selectionEvaluationOf(status==='SUCCEEDED'
      ?{registration:p.registration,evaluation_run_id:run.runId,fixed_contract:run.world.contract,binding:run.world.binding,fixed_result:run.world.result,rows:run.world.rows,run_status:'SUCCEEDED'}
      :{registration:p.registration,evaluation_run_id:run.runId,fixed_contract:run.world.contract,binding:null,fixed_result:null,rows:null,run_status:status},VALIDATORS);
    assert.equal(built.ok,true,JSON.stringify(built));
    return built.evaluation;
  });
  return rankSelection(p.registration,list,{window_dataset_hash:p.dataset});
}

/* ---- observation ---- */

const TABLES=['quant_selection_status_events','quant_selection_outcomes','quant_selection_replay_events','quant_selection_evaluation_starts','quant_selection_window_freezes'];
const rowsOf=async(target,id)=>Object.fromEntries(await Promise.all(TABLES.map(async table=>[table,(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d
  FROM public.${table} t WHERE selection_id=$1`,[id])).rows[0]])));
const eventsOf=async(target,id)=>(await target.query('SELECT seq,event,status,code,detail,outcome,completed_evaluation_run_ids FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq',[id])).rows;
const outcomeRow=async(target,id)=>(await target.query('SELECT outcome,outcome_hash,body_canonical FROM public.quant_selection_outcomes WHERE selection_id=$1',[id])).rows[0]??null;
const registerRows=async(target,id)=>(await target.query("SELECT exposure_id FROM public.quant_exposure_register WHERE kind='QR4_SELECTION' AND selection_id=$1",[id])).rows.length;
/** The research rows (parents, their exports and validations, and the fixed job rows themselves): none of them may change when the finalizer runs. */
const researchDigest=async target=>(await target.query(`SELECT encode(sha256(convert_to((SELECT COALESCE(string_agg(row_to_json(j)::text,'|' ORDER BY j.run_id),'') FROM quant_jobs j)
  ||(SELECT COALESCE(string_agg(row_to_json(e)::text,'|' ORDER BY e.export_id),'') FROM bi_exports e)
  ||(SELECT COALESCE(string_agg(row_to_json(s)::text,'|' ORDER BY s.export_id,s.seq),'') FROM bi_status_events s)
  ||(SELECT COALESCE(string_agg(row_to_json(v)::text,'|' ORDER BY v.export_id),'') FROM ql4c_validation v),'UTF8')),'hex') d`)).rows[0].d;
const refusal=(answer,code,detail)=>assert.deepEqual([answer.ok,answer.code,answer.detail],[false,code,detail],JSON.stringify(answer).slice(0,300));
const addExposure=(owner,events)=>db.transaction(async()=>appendExposures(db,{owner_id:owner.id,...MARKET,events}),{isolation:'SERIALIZABLE'});
const qr3Event=(window,tag='x')=>({kind:'QR3_COMPARISON',window,comparison_id:'cmp-'+tag+'-'+randomUUID(),participant_run_id:'run-'+tag,source_hash:hex('src:'+tag)});

/**
 * A recording wrapper: every statement is logged, then the read-only state of its transaction is probed with a separate query that is not logged. The finalizer gets this
 * handle in place of the pool.
 */
function spy(target,{fail=null}={}){
  const log=[];
  const proxy=new Proxy(target,{get(object,property){
    if(property==='query')return async(sql,params)=>{
      const text=String(sql).replace(/\s+/g,' ').trim(),entry={text,readOnly:null};
      log.push(entry);
      if(fail){const error=fail(text,params);if(error)throw error;}
      if(/^(SELECT|WITH|INSERT|UPDATE|DELETE)/i.test(text)&&object.isTransaction)entry.readOnly=(await object.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode==='on';
      return object.query(sql,params);
    };
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  return {db:proxy,log};
}
const writes=log=>log.filter(entry=>/^(INSERT|UPDATE|DELETE|LOCK)/i.test(entry.text));

/* ---- 1. the full path ---- */

test('three terminal runs end the selection COMPLETED with the outcome that rankSelection gives for the adapter evaluations; reads are READ ONLY; research rows are byte-identical; a repeat writes nothing',async()=>{
  const p=await startRuns(await prepared());
  await succeedAll(p);
  const research=await researchDigest(db),expected=expectedOutcome(p);
  assert.equal(expected.status,'SELECTION_COMPLETED',JSON.stringify(expected).slice(0,400));
  assert.equal(expected.outcome,'BEST_IN_SCOPE');
  const deps=depsOf(p),run=spy(rt);
  const answer=await finalize(p,deps,run.db);
  assert.equal(answer.ok,true,JSON.stringify(answer).slice(0,400));
  assert.deepEqual([answer.state,answer.status,answer.outcome,answer.outcome_hash],['COMPLETED','SELECTION_COMPLETED','BEST_IN_SCOPE',expected.outcome_hash]);
  assert.deepEqual(deps.calls,{readEvaluation:3,readRows:3});
  // the stored outcome is the pure ranking, byte for byte, with the frozen dataset hash inside the hashed body
  const stored=await outcomeRow(db,p.id);
  const {outcome_hash:hashed,...body}=expected;
  assert.deepEqual([stored.outcome,stored.outcome_hash,stored.body_canonical],['BEST_IN_SCOPE',expected.outcome_hash,canonical(body)]);
  assert.equal(hash(stored.body_canonical),stored.outcome_hash);
  assert.equal(JSON.parse(stored.body_canonical).window_dataset_hash,p.dataset);
  assert.deepEqual(JSON.parse(stored.body_canonical).ranking.map(item=>[item.rank,item.run_id]),[[1,p.registration.participants[1].run_id],[2,p.registration.participants[0].run_id],[3,p.registration.participants[2].run_id]]);
  assert.deepEqual((await eventsOf(db,p.id)).map(item=>[item.event,item.status,item.outcome]).slice(-1),[['ALL_EVALUATIONS_DONE','SELECTION_COMPLETED','BEST_IN_SCOPE']]);
  // the order of the log: every statement before the write transaction is a READ ONLY read; the only writes are the outcome row and the status event
  const lock=run.log.findIndex(entry=>/^LOCK TABLE public\.quant_exposure_register/.test(entry.text));
  assert.ok(lock>0,'the outcome write takes the register lock first');
  for(const entry of run.log.slice(0,lock))if(entry.readOnly!==null)assert.equal(entry.readOnly,true,entry.text);
  assert.ok(run.log.slice(0,lock).some(entry=>/quant_jobs/.test(entry.text)&&entry.readOnly===true),'the fixed runs are read in a READ ONLY snapshot');
  assert.ok(run.log.slice(0,lock).some(entry=>/^SET TRANSACTION READ ONLY/.test(entry.text)));
  assert.deepEqual(writes(run.log).map(entry=>entry.text.replace(/^(INSERT INTO public\.\w+|LOCK TABLE public\.\w+).*$/,'$1')),
    ['LOCK TABLE public.quant_exposure_register','INSERT INTO public.quant_selection_outcomes','INSERT INTO public.quant_selection_status_events']);
  assert.equal(await researchDigest(db),research,'quant_jobs (the parent runs and the fixed job rows) and the bi_* rows are byte-identical after the outcome');
  assert.equal(await registerRows(db,p.id),1,'the one exposure row of the first start; the finalizer adds none');
  // 16.2 item 7: the runs carry parent_run_id and selection_id and no search dimension
  const read=await readSelectionEvaluations(rt,{owner_id:p.owner.id,selection_id:p.id},depsOf(p));
  assert.equal(read.state,'READY',JSON.stringify(read).slice(0,300));
  assert.deepEqual(read.evaluations.map(item=>[item.selection_id,item.parent_run_id,item.mode]),p.registration.participants.map(item=>[p.id,item.run_id,'QR4_SELECTION_EVAL']));
  for(const item of p.runs){
    assert.equal(item.world.contract.lineage.object_id,p.id);assert.equal(item.world.contract.lineage.parent_run_id,item.participant.run_id);
    assert.equal(item.world.result.base.selection_id,p.id);assert.equal(item.world.result.stress.parent_run_id,item.participant.run_id);
    assert.doesNotThrow(()=>refuseSearchFields(item.world.contract));assert.doesNotThrow(()=>refuseSearchFields(item.world.result));
    const row=(await db.query('SELECT contract FROM public.quant_jobs WHERE run_id=$1',[item.runId])).rows[0];
    assert.equal(canonical(row.contract),canonical(item.world.contract));
    assert.equal(Object.hasOwn(row.contract,'source_hash'),false,'a fixed run has no top-level source hash (the reason the searched-window reader does not see it)');
  }
  // a repeat answers ALREADY_TERMINAL with the same hash and writes nothing
  const before=await rowsOf(db,p.id),again=spy(rt),deps2=depsOf(p);
  const second=await finalize(p,deps2,again.db);
  assert.deepEqual([second.ok,second.state,second.status,second.outcome_hash],[true,'ALREADY_TERMINAL','SELECTION_COMPLETED',expected.outcome_hash]);
  assert.deepEqual(writes(again.log),[]);assert.deepEqual(deps2.calls,{readEvaluation:0,readRows:0});
  assert.deepEqual(await rowsOf(db,p.id),before);
});

/* ---- 2. waiting ---- */

test('a selection that has not started, has started only some participants, or has a QUEUED or RUNNING run answers WAITING and writes nothing',async()=>{
  const none=await prepared({daysAgo:6});
  const deps0=depsOf(none),before0=await rowsOf(db,none.id);
  const registered=await finalize(none,deps0);
  assert.deepEqual([registered.ok,registered.state,registered.status,registered.pending],[true,'WAITING','SELECTION_REGISTERED',none.registration.participants.map(item=>item.export_id)]);
  assert.deepEqual(deps0.calls,{readEvaluation:0,readRows:0});assert.deepEqual(await rowsOf(db,none.id),before0);
  // two of three started: the third is pending
  const part=await startRuns(await prepared({daysAgo:7}),[0,1]);
  await succeedAll(part);
  const depsP=depsOf(part),beforeP=await rowsOf(db,part.id);
  const partial=await finalize(part,depsP);
  assert.deepEqual([partial.state,partial.status,partial.pending],['WAITING','SELECTION_EVALUATING',[part.registration.participants[2].export_id]]);
  assert.deepEqual(depsP.calls,{readEvaluation:0,readRows:0},'nothing is read before every participant has a run');
  assert.deepEqual(await rowsOf(db,part.id),beforeP);
  // all started: QUEUED, then RUNNING (the run lookup sees the status), then SUCCEEDED completes
  const all=await startRuns(await prepared({daysAgo:8}));
  await setStatus(all.runs[0],'SUCCEEDED');await setStatus(all.runs[1],'SUCCEEDED');
  const depsA=depsOf(all),beforeA=await rowsOf(db,all.id);
  const queued=await finalize(all,depsA);
  assert.deepEqual([queued.state,queued.pending],['WAITING',[all.runs[2].export_id]]);
  await setStatus(all.runs[2],'RUNNING');
  assert.deepEqual((await finalize(all,depsA)).pending,[all.runs[2].export_id]);
  assert.deepEqual(depsA.calls,{readEvaluation:0,readRows:0});assert.deepEqual(await rowsOf(db,all.id),beforeA);
  // a failed run beside a run that is still going does not end the selection early
  await setStatus(all.runs[0],'FAILED');
  const early=await finalize(all,depsA);
  assert.deepEqual([early.state,early.pending],['WAITING',[all.runs[2].export_id]]);
  assert.deepEqual(await rowsOf(db,all.id),beforeA);
  await setStatus(all.runs[0],'SUCCEEDED');await setStatus(all.runs[2],'SUCCEEDED');
  const done=await finalize(all,depsA);
  assert.deepEqual([done.ok,done.state],[true,'COMPLETED'],JSON.stringify(done).slice(0,300));
  // a cancelled selection and a foreign owner
  const cancelled=await prepared({daysAgo:9});
  assert.equal((await cancelSelection(rt,{owner_id:cancelled.owner.id,selection_id:cancelled.id,confirmed:true})).ok,true);
  const gone=await finalize(cancelled,depsOf(cancelled));
  assert.deepEqual([gone.ok,gone.state,gone.status],[true,'ALREADY_TERMINAL','SELECTION_CANCELLED']);
  const stranger=await newOwner('q4a-stranger'),foreignDeps=depsOf(all);
  refusal(await finalizeSelection(rt,{owner_id:stranger.id,selection_id:all.id},foreignDeps),'NOT_FOUND',null);
  refusal(await finalizeSelection(rt,{owner_id:all.owner.id,selection_id:randomUUID()},foreignDeps),'NOT_FOUND',null);
  assert.deepEqual(foreignDeps.calls,{readEvaluation:0,readRows:0});
});

/* ---- 3. runs that did not succeed ---- */

test('FAILED, TIMED_OUT, CANCELLED and NO_VALID_CANDIDATE runs end the selection INCOMPLETE with QR4_EVALUATION_FAILED once every run is terminal; no outcome row; a failed run is not read through the dependencies',async()=>{
  for(const [offset,status] of ['FAILED','TIMED_OUT','CANCELLED','NO_VALID_CANDIDATE'].entries()){
    const p=await startRuns(await prepared({daysAgo:10+offset}));
    await succeedAll(p,[1]);await setStatus(p.runs[1],status);
    const deps=depsOf(p);
    const answer=await finalize(p,deps);
    assert.deepEqual([answer.ok,answer.state,answer.status,answer.code,answer.event],[true,'INCOMPLETE','SELECTION_INCOMPLETE','QR4_EVALUATION_FAILED','ALL_EVALUATIONS_DONE'],status+' '+JSON.stringify(answer));
    assert.equal(answer.detail,status);
    assert.deepEqual(deps.calls,{readEvaluation:2,readRows:2},'only the runs that succeeded are read');
    const events=await eventsOf(db,p.id);
    assert.deepEqual([events.at(-1).event,events.at(-1).status,events.at(-1).code,events.at(-1).detail],['ALL_EVALUATIONS_DONE','SELECTION_INCOMPLETE','QR4_EVALUATION_FAILED',status]);
    assert.deepEqual([...events.at(-1).completed_evaluation_run_ids].sort(),[p.runs[0].runId,p.runs[2].runId].sort(),'the other results stay hidden: only their run ids are recorded');
    assert.equal(await outcomeRow(db,p.id),null);
    const again=await finalize(p,depsOf(p));
    assert.deepEqual([again.state,again.status],['ALREADY_TERMINAL','SELECTION_INCOMPLETE']);
  }
});

/* ---- 4. recovery ---- */

test('a dependency that throws is refused as transient and writes nothing; a stop at the first write statement leaves the selection open; the next call completes once with the same hash',async()=>{
  const p=await startRuns(await prepared({daysAgo:14}));
  await succeedAll(p);
  const expected=expectedOutcome(p),before=await rowsOf(db,p.id),researchBefore=await researchDigest(db);
  const boom=()=>{throw Error('connection reset');};
  const readFail=await finalize(p,depsOf(p,{hooks:{readEvaluation:run=>run===p.runs[1]?boom():undefined}}));
  assert.deepEqual([readFail.ok,readFail.code,readFail.detail,readFail.retryable],[false,'INTEGRITY_CHECK_FAILED','TRANSIENT_READ_EVALUATION',true]);
  const rowsFail=await finalize(p,depsOf(p,{hooks:{readRows:run=>run===p.runs[2]?boom():undefined}}));
  assert.deepEqual([rowsFail.ok,rowsFail.code,rowsFail.detail,rowsFail.retryable],[false,'INTEGRITY_CHECK_FAILED','TRANSIENT_READ_ROWS',true]);
  assert.deepEqual(await rowsOf(db,p.id),before);
  // the process stops after reading, at the first statement of the write transaction: the error propagates, nothing is stored
  const stopped=spy(rt,{fail:text=>/^LOCK TABLE public\.quant_exposure_register/.test(text)?Object.assign(Error('stopped after reading'),{code:'STOP'}):null});
  await assert.rejects(finalize(p,depsOf(p),stopped.db),error=>error.code==='STOP');
  assert.deepEqual(await rowsOf(db,p.id),before);assert.equal(await outcomeRow(db,p.id),null);
  // the next call completes once, with the hash of the pure ranking
  const done=await finalize(p,depsOf(p));
  assert.deepEqual([done.ok,done.state,done.outcome_hash],[true,'COMPLETED',expected.outcome_hash],JSON.stringify(done).slice(0,300));
  const after=await rowsOf(db,p.id);
  assert.equal(after.quant_selection_outcomes.n,1);
  assert.equal(after.quant_selection_status_events.n,before.quant_selection_status_events.n+1);
  assert.equal(await researchDigest(db),researchBefore);
  assert.equal((await finalize(p,depsOf(p))).state,'ALREADY_TERMINAL');
  assert.equal((await rowsOf(db,p.id)).quant_selection_outcomes.n,1);
});

test('three finalizers at the same time give one outcome row and one ALL_EVALUATIONS_DONE event; the others answer ALREADY_TERMINAL',async()=>{
  const p=await startRuns(await prepared({daysAgo:15}));
  await succeedAll(p);
  const expected=expectedOutcome(p),answers=await Promise.all([finalize(p,depsOf(p)),finalize(p,depsOf(p)),finalize(p,depsOf(p))]);
  for(const answer of answers)assert.equal(answer.ok,true,JSON.stringify(answer).slice(0,300));
  assert.deepEqual(answers.map(item=>item.state).sort(),['ALREADY_TERMINAL','ALREADY_TERMINAL','COMPLETED']);
  assert.ok(answers.every(item=>item.outcome_hash===undefined||item.outcome_hash===null||item.outcome_hash===expected.outcome_hash));
  const rows=await rowsOf(db,p.id);
  assert.equal(rows.quant_selection_outcomes.n,1);
  assert.equal((await eventsOf(db,p.id)).filter(item=>item.event==='ALL_EVALUATIONS_DONE').length,1);
  assert.equal((await outcomeRow(db,p.id)).outcome_hash,expected.outcome_hash);
});

/* ---- 5. window race at the outcome write ---- */

test('16.2 item 10: a QR-3 exposure over W that commits between the finalizer reads and the outcome write ends the selection INCOMPLETE with QR4_WINDOW_EXPOSED; no outcome row',async()=>{
  const p=await startRuns(await prepared({daysAgo:16}));
  await succeedAll(p);
  const w=p.registration.window,before=await rowsOf(db,p.id);
  let injected=false;
  const deps=depsOf(p,{hooks:{readRows:async run=>{
    if(run===p.runs.at(-1)&&!injected){injected=true;await addExposure(p.owner,[qr3Event({start_ms:w.start_ms+10*MS,end_ms:w.start_ms+20*MS},'race')]);}}}});
  const answer=await finalize(p,deps);
  assert.equal(injected,true);
  assert.deepEqual([answer.ok,answer.state,answer.status,answer.code,answer.event],[true,'INCOMPLETE','SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED','WINDOW_RECHECK_FAILED'],JSON.stringify(answer).slice(0,300));
  assert.equal(await outcomeRow(db,p.id),null);
  assert.equal((await rowsOf(db,p.id)).quant_selection_outcomes.n,0);
  assert.deepEqual((await eventsOf(db,p.id)).slice(-1).map(item=>[item.event,item.status,item.code]),[['WINDOW_RECHECK_FAILED','SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED']]);
  assert.equal(await registerRows(db,p.id),1,'the register keeps the selection exposure');
  assert.equal((await rowsOf(db,p.id)).quant_selection_status_events.n,before.quant_selection_status_events.n+1);
  // the same exposure before the call gives the same ending
  const q=await startRuns(await prepared({daysAgo:17}));
  await succeedAll(q);
  await addExposure(q.owner,[qr3Event({start_ms:q.registration.window.end_ms-5*MS,end_ms:q.registration.window.end_ms+5*MS},'early')]);
  const early=await finalize(q,depsOf(q));
  assert.deepEqual([early.ok,early.state,early.code],[true,'INCOMPLETE','QR4_WINDOW_EXPOSED']);
  assert.equal(await outcomeRow(db,q.id),null);
});

/* ---- 6. replay ---- */

test('16.2 item 8: an equal replay writes nothing; a tampered evaluation result hash writes one SELECTION_REPLAY_MISMATCH row and the stored outcome is never changed',async()=>{
  const p=await startRuns(await prepared({daysAgo:18}));
  await succeedAll(p);
  const ready=await readSelectionEvaluations(rt,{owner_id:p.owner.id,selection_id:p.id},depsOf(p));
  assert.equal(ready.state,'READY','all runs terminal: the evaluations can be built before the outcome too');
  assert.equal((await finalize(p,depsOf(p))).state,'COMPLETED');
  const stored=await outcomeRow(db,p.id),before=await rowsOf(db,p.id);
  const read=await readSelectionEvaluations(rt,{owner_id:p.owner.id,selection_id:p.id},depsOf(p));
  assert.equal(read.state,'READY');
  const equal=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:read.evaluations});
  assert.deepEqual([equal.ok,equal.match,equal.stored_outcome_hash,equal.recomputed_outcome_hash],[true,true,stored.outcome_hash,stored.outcome_hash],JSON.stringify(equal));
  assert.deepEqual(await rowsOf(db,p.id),before,'an equal replay writes no row');
  const tampered=clone(read.evaluations);tampered[0].result_hash=hex('tampered');
  const mismatch=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:tampered});
  assert.deepEqual([mismatch.ok,mismatch.match,mismatch.stored_outcome_hash,mismatch.recomputed_outcome_hash],[true,false,stored.outcome_hash,null],JSON.stringify(mismatch));
  const after=await rowsOf(db,p.id);
  assert.equal(after.quant_selection_replay_events.n,1);
  assert.deepEqual(after.quant_selection_outcomes,before.quant_selection_outcomes,'the stored outcome is not edited');
  assert.deepEqual(await outcomeRow(db,p.id),stored);
  assert.equal((await readSelection(rt,{owner_id:p.owner.id,selection_id:p.id})).selection.replay_mismatch,true,'the label is suppressed by the replay mismatch overlay');
  // a different but valid run set (another size) is a different outcome: the replay records a mismatch too
  const other=clone(read.evaluations);other[1]=selectionEvaluationOf({registration:p.registration,evaluation_run_id:p.runs[1].runId,fixed_contract:p.runs[1].world.contract,binding:p.runs[1].world.binding,
    fixed_result:worldOf(p,p.runs[1].participant,1,{size:'1'}).result,rows:p.runs[1].world.rows,run_status:'SUCCEEDED'},VALIDATORS).evaluation;
  assert.ok(other[1]);
  const changed=await replaySelectionOutcome(rt,{owner_id:p.owner.id,selection_id:p.id,evaluations:other});
  assert.deepEqual([changed.ok,changed.match],[true,false]);
  assert.equal((await rowsOf(db,p.id)).quant_selection_replay_events.n,2);
});

/* ---- 7. refusals that write nothing ---- */

test('a FAILED run whose stored contract fails validation ends the selection QR4_EVALUATION_FAILED with the real status, not as a succeeded run',async()=>{
  const p=await prepared({daysAgo:29});
  const first=p.registration.participants[0];
  const world=worldOf(p,first,0);world.contract.unknown_extra_key=1;
  const bad=await insertRun(p,first,0,{world});
  const started=await startEvaluation(rt,{owner_id:p.owner.id,selection_id:p.id,export_id:first.export_id,evaluation_run_id:bad.runId});
  assert.equal(started.ok,true,JSON.stringify(started));
  p.runs[0]={...bad,export_id:first.export_id};
  await startRuns(p,[1,2]);
  await succeedAll(p,[0]);await setStatus(p.runs[0],'FAILED');
  const direct=selectionEvaluationOf({registration:p.registration,evaluation_run_id:bad.runId,fixed_contract:world.contract,binding:null,fixed_result:null,rows:null,run_status:'FAILED'},VALIDATORS);
  assert.equal(direct.ok,false,'the adapter refuses the stored contract of the failed run: '+JSON.stringify(direct));
  const deps=depsOf(p);
  const ended=await finalize(p,deps);
  assert.deepEqual([ended.ok,ended.state,ended.status,ended.code,ended.detail],[true,'INCOMPLETE','SELECTION_INCOMPLETE','QR4_EVALUATION_FAILED','FAILED'],JSON.stringify(ended).slice(0,400));
  assert.equal(ended.adapter_refusals.length,1);
  assert.deepEqual(deps.calls,{readEvaluation:2,readRows:2},'the failed run is not read through the dependencies');
  assert.equal(await outcomeRow(db,p.id),null);
});

test('a refusal of the finalizer itself writes nothing; the selection stays open and completes once the record is right',async()=>{
  const p=await startRuns(await prepared({daysAgo:19}));
  await succeedAll(p);
  const before=await rowsOf(db,p.id);
  // a contract that differs from the stored job row
  const differs=await finalize(p,{...depsOf(p),async readEvaluation(owner,runId){
    const run=p.runs.find(item=>item.runId===runId);const contract=clone(run.world.contract);contract.deployment_id='another-deployment';
    return {contract,binding:clone(run.world.binding),result:clone(run.world.result),status:'SUCCEEDED'};}});
  refusal(differs,'INTEGRITY_CHECK_FAILED','CONTRACT_DIFFERS');
  // a read that does not report SUCCEEDED
  const status=await finalize(p,{...depsOf(p),async readEvaluation(owner,runId){
    const run=p.runs.find(item=>item.runId===runId);return {contract:clone(run.world.contract),binding:clone(run.world.binding),result:clone(run.world.result),status:'RUNNING'};}});
  refusal(status,'INTEGRITY_CHECK_FAILED','READ_EVALUATION');
  assert.deepEqual(await rowsOf(db,p.id),before);
  const done=await finalize(p,depsOf(p));
  assert.deepEqual([done.ok,done.state],[true,'COMPLETED']);
});

test('a deterministic adapter refusal of a frozen terminal record ends the selection INCOMPLETE with the section-10 code (QR-4 7.1 item 1); it does not stay EVALUATING',async()=>{
  const p=await startRuns(await prepared({daysAgo:26}));
  await succeedAll(p);
  const damaged=run=>{
    if(run!==p.runs[0])return run.world.result;
    const result=clone(run.world.result);result.base.fees_total=result.base.fees_total+'1';return result;};
  const deps=depsOf(p,{hooks:{result:damaged}});
  const listed=await readSelectionEvaluations(rt,{owner_id:p.owner.id,selection_id:p.id},depsOf(p,{hooks:{result:damaged}}));
  assert.equal(listed.state,'READY',JSON.stringify(listed).slice(0,300));
  assert.deepEqual(listed.adapter_refusals.map(item=>[item.export_id,item.evaluation_run_id,item.code,item.detail]),[[p.runs[0].export_id,p.runs[0].runId,'INTEGRITY_CHECK_FAILED','CROSS_CHECK_FEES']],'the replay list carries the refusal too');
  assert.equal(listed.evaluations[0].adapter_refusal.code,'INTEGRITY_CHECK_FAILED');
  assert.deepEqual([listed.evaluations[0].integrity.contract_hash_verified,listed.evaluations[0].integrity.report_matches_checkpoints,listed.evaluations[0].result],[false,false,null],'integrity flags of the refused evaluation');
  const ended=await finalize(p,deps);
  assert.deepEqual([ended.ok,ended.state,ended.status,ended.code],[true,'INCOMPLETE','SELECTION_INCOMPLETE','INTEGRITY_CHECK_FAILED'],JSON.stringify(ended).slice(0,400));
  assert.equal(ended.event,'ALL_EVALUATIONS_DONE');
  assert.deepEqual(ended.adapter_refusals.map(item=>[item.code,item.detail]),[['INTEGRITY_CHECK_FAILED','CROSS_CHECK_FEES']],'the adapter detail is kept');
  assert.equal(deps.calls.readEvaluation,4,'three participants plus the confirming second read of the refused run');
  assert.equal(await outcomeRow(db,p.id),null);
  const again=await finalize(p,depsOf(p));
  assert.deepEqual([again.ok,again.state,again.status],[true,'ALREADY_TERMINAL','SELECTION_INCOMPLETE']);
});

test('a number where a decimal string is required ends the selection with QR4_METRIC_MISSING; a refusal that differs between two reads does not end it',async()=>{
  const p=await startRuns(await prepared({daysAgo:27}));
  await succeedAll(p);
  const before=await rowsOf(db,p.id);
  // the first read of one run is damaged and the second is right: the refusal is not stable, nothing is written and the call is retryable
  let reads=0;
  const flaky=await finalize(p,depsOf(p,{hooks:{result:run=>{
    if(run!==p.runs[1])return run.world.result;
    reads+=1;const result=clone(run.world.result);if(reads===1)result.base.fees_total=result.base.fees_total+'1';return result;}}}));
  assert.equal(flaky.ok,false);assert.equal(flaky.retryable,true);
  refusal(flaky,'INTEGRITY_CHECK_FAILED','UNSTABLE_READ');
  assert.deepEqual(await rowsOf(db,p.id),before);
  // the same code with a different detail on the second read is unstable too
  let seen=0;
  const shifting=await finalize(p,depsOf(p,{hooks:{result:run=>{
    if(run!==p.runs[1])return run.world.result;
    seen+=1;const result=clone(run.world.result);if(seen===1)result.base.fees_total=result.base.fees_total+'1';else result.base.slippage_cost_incl_tick_total=result.base.slippage_cost_incl_tick_total+'1';return result;}}}));
  assert.equal(seen,2);
  assert.equal(shifting.ok,false);assert.equal(shifting.retryable,true);
  refusal(shifting,'INTEGRITY_CHECK_FAILED','UNSTABLE_READ');
  assert.deepEqual(await rowsOf(db,p.id),before);
  const base=depsOf(p);
  const numeric=await finalize(p,{...base,async readRows(owner,runId,binding){
    const rows=await base.readRows(owner,runId,binding);
    if(runId===p.runs[2].runId)rows[1100].close=100;
    return rows;}});
  assert.deepEqual([numeric.ok,numeric.state,numeric.code],[true,'INCOMPLETE','QR4_METRIC_MISSING'],JSON.stringify(numeric).slice(0,400));
  assert.deepEqual(numeric.adapter_refusals.map(item=>[item.code,item.detail]),[['QR4_METRIC_MISSING','NUMBER_NOT_DECIMAL_STRING']]);
});

test('an unreadable close in the frozen window ends the selection INCOMPLETE with QR4_WINDOW_DATA_GAP (the adapter never emits QR4_WINDOW_DATA_UNAVAILABLE) and keeps the cause in adapter_refusals',async()=>{
  const p=await startRuns(await prepared({daysAgo:28}));
  await succeedAll(p);
  const deps=depsOf(p);
  const gapped={...deps,async readRows(owner,runId,binding){
    const rows=await deps.readRows(owner,runId,binding);
    if(runId!==p.runs[0].runId)return rows;
    return rows.map((row,index)=>index===rows.length-2?{...row,close:null}:row);}};
  const answer=await finalize(p,gapped);
  assert.deepEqual([answer.ok,answer.state,answer.status,answer.code],[true,'INCOMPLETE','SELECTION_INCOMPLETE','QR4_WINDOW_DATA_GAP'],JSON.stringify(answer).slice(0,400));
  assert.deepEqual(answer.adapter_refusals.map(item=>[item.code,item.detail]),[['QR4_WINDOW_DATA_GAP','QR3_DATASET_UNAVAILABLE:CLOSE_UNREADABLE']]);
  assert.equal(await outcomeRow(db,p.id),null);
});

test('the runs must pair exactly with the start rows: a run without a start, two runs of one participant, a start without a run and an altered contract hash all refuse INTEGRITY_CHECK_FAILED and write nothing',async()=>{
  // a run without a start row
  const a=await startRuns(await prepared({daysAgo:20}),[0,1]);
  await succeedAll(a);
  await insertRun(a,a.registration.participants[2],2);
  const beforeA=await rowsOf(db,a.id);
  refusal(await finalize(a,depsOf(a)),'INTEGRITY_CHECK_FAILED','RUN_WITHOUT_START');
  assert.deepEqual(await rowsOf(db,a.id),beforeA);
  // two runs for one participant (the second has no start row; the lookup is ambiguous first)
  const b=await startRuns(await prepared({daysAgo:21}));
  await succeedAll(b);
  await insertRun(b,b.registration.participants[0],0);
  refusal(await finalize(b,depsOf(b)),'INTEGRITY_CHECK_FAILED','RUN_AMBIGUOUS');
  // a start row whose run row is gone (the foreign key of slice Q4-S forbids the delete, so the probe deletes with foreign-key triggers off: session_replication_role replica, this transaction only)
  const c=await startRuns(await prepared({daysAgo:22}));
  await succeedAll(c);
  await db.transaction(async()=>{await db.query('SET LOCAL session_replication_role=replica');await db.query('DELETE FROM public.quant_jobs WHERE run_id=$1',[c.runs[1].runId]);});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.quant_jobs WHERE run_id=$1',[c.runs[1].runId])).rows[0].n,0);
  const beforeC=await rowsOf(db,c.id);
  refusal(await finalize(c,depsOf(c)),'INTEGRITY_CHECK_FAILED','START_WITHOUT_RUN');
  assert.deepEqual(await rowsOf(db,c.id),beforeC);
  // the stored contract hash is not the hash of the stored contract
  const d=await startRuns(await prepared({daysAgo:23}),[0,1]);
  const altered=await insertRun(d,d.registration.participants[2],2,{contractHash:hex('altered')});
  assert.equal((await startEvaluation(rt,{owner_id:d.owner.id,selection_id:d.id,export_id:d.registration.participants[2].export_id,evaluation_run_id:altered.runId})).ok,true);
  d.runs[2]={...altered,export_id:d.registration.participants[2].export_id};
  await succeedAll(d);
  refusal(await finalize(d,depsOf(d)),'INTEGRITY_CHECK_FAILED','CONTRACT_HASH');
  // a run whose contract names another parent than the start row of its participant
  const e=await prepared({daysAgo:24});
  const first=e.registration.participants[0];
  // the start guard of slice Q4-S refuses a job naming another parent, so the job starts with its true contract and is rewritten afterwards (triggers off, this transaction only)
  const good=await insertRun(e,first,0);
  const started=await startEvaluation(rt,{owner_id:e.owner.id,selection_id:e.id,export_id:first.export_id,evaluation_run_id:good.runId});
  assert.equal(started.ok,true,JSON.stringify(started));
  const wrongWorld=worldOf(e,first,0,{parentRunId:'run-elsewhere'});
  await db.transaction(async()=>{await db.query('SET LOCAL session_replication_role=replica');
    await db.query('UPDATE public.quant_jobs SET contract=$2,contract_hash=$3 WHERE run_id=$1',[good.runId,JSON.stringify(wrongWorld.contract),hash(canonical(wrongWorld.contract))]);});
  e.runs[0]={...good,world:wrongWorld,export_id:first.export_id};
  await startRuns(e,[1,2]);
  await succeedAll(e);
  refusal(await finalize(e,depsOf(e)),'INTEGRITY_CHECK_FAILED','RUN_START_MISMATCH');
});

/* ---- 8. the searched windows today (RR-Q4-9 pin) ---- */

test('RR-Q4-9 pin: readSearchedWindows does not list the fixed-evaluation runs of a selection today (they carry no top-level source hash); the exclusion is implicit',async()=>{
  const p=await startRuns(await prepared({daysAgo:25}));
  await succeedAll(p);
  const sources=p.set.runs.map(run=>run.source);
  const entries=await readSearchedWindows(rt,{owner_id:p.owner.id,source_hashes:sources});
  assert.ok(Array.isArray(entries),'a fixed run does not make the list unreadable');
  assert.equal(entries.length,3*p.set.runs.length,'three windows (train, validation, holdout) for each research run');
  assert.deepEqual([...new Set(entries.map(item=>item.kind))],['RESEARCH_RUN']);
  const evaluationRuns=new Set(p.runs.map(run=>run.runId));
  assert.deepEqual(entries.filter(item=>evaluationRuns.has(item.run_id)),[]);
  assert.deepEqual([...new Set(entries.map(item=>item.run_id))].sort(),p.set.runs.map(run=>run.runId).sort());
  // the rule that keeps them out is the absence of source_hash: a fixed contract that carried one would be read as a research run of that source
  const probe=worldOf(p,p.registration.participants[0],0);
  const runId='ev-'+randomUUID();
  await db.query(`INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$8,$9)`,[runId,p.owner.id,p.owner.deployment,'fixed:'+runId,hex('submission:'+runId),hex('probe'),JSON.stringify({...probe.contract,source_hash:sources[0]}),T0,T0+900000]);
  const withMarker=await readSearchedWindows(rt,{owner_id:p.owner.id,source_hashes:sources});
  assert.equal(withMarker===null||withMarker.some(item=>item.run_id===runId),true,'the implicit rule: a top-level source hash would put the run into the list (or make it unreadable)');
  await db.query('DELETE FROM public.quant_jobs WHERE run_id=$1',[runId]);
  assert.equal((await readSearchedWindows(rt,{owner_id:p.owner.id,source_hashes:sources})).length,3*p.set.runs.length);
});
