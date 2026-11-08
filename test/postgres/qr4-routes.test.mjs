import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {fork} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from '../../src/security.js';
import {httpClient} from '../helpers.mjs';
import {randomUUID} from 'node:crypto';
import {createQr4World,newOwner,seedSet,seedRunWithPackage,seedBars,seedEvaluationJob,registerViaStore,requestOf,testContext,readBotState,counts,tableDigest,
  SCOPE,FILTERS,POLICY_HASH,ENGINE,BASE,DAY,MS,SELECTION_TABLES,OBJECTIVE_ID} from '../helpers/qr4-selection-fixture.mjs';
import {createDispatcher} from '../../src/postgres/request-dispatch.js';
import {preloadJson} from '../../src/postgres/http.js';
import {runMarketDeferred} from '../../src/postgres/market-ohlcv.js';
import {qr4Routes,QR4_PATH,QR4_CANCEL_EVENT,QR4_REPLAY_EVENT} from '../../src/postgres/qr4-routes.js';
import {registerSelection,readSelection,freezeWindow,startEvaluation,writeOutcome,replaySelectionOutcome} from '../../src/postgres/selection-store.js';
import {readSelectionInputs} from '../../src/postgres/selection-inputs.js';
import {digest} from '../../src/selection/codes.js';
import {developmentRowViolations} from '../../src/selection/index.js';
import {hex} from '../helpers/quant-library-fixture.mjs';

// QR-4 slice Q4-B owner API on a real PostgreSQL cluster: the real store, the real selection tables and exposure register, the real inputs reader and the REAL dispatcher (SERIALIZABLE
// request transaction, buffered answer, deferred phase), as a non-owner LOGIN role with the repository grants. Every row is a LABELLED FIXTURE. A registration that succeeds needs the TEST
// registry, which no route can pass (RC-S11), so selections are registered through the store writer with the real reader and then read, cancelled and replayed through the routes.
// One file per process, one cluster. The engine hash that only the evaluation closure can supply is injected exactly as the wiring slice will.
let world,server,base;
let flag=true,deps,routeDb,fixtureAllowed=true;
const audits=[];
const identityOf=req=>req.headers['x-test-user']||null;
const testAuth={checkOrigin(){},async prepareSession(){},
  async require(req){const id=identityOf(req);if(!id)throw Object.assign(new Error('Unauthorized'),{status:401});return {id};}};
async function handleRequest(req,res){
  const url=new URL(req.url,'http://localhost');
  const id=identityOf(req);
  if(!id)return json(res,401,{error:'Unauthorized'});
  const store={db:routeDb,audit:(...args)=>world.rtStore.audit(...args)};
  if(await qr4Routes(req,res,url,{id},{store,auth:testAuth,json,enabled:flag,deps,readBotState,fixtureSelectionsAllowed:fixtureAllowed}))return;
  return json(res,404,{error:'Not found'});
}
function json(res,status,body){
  if(res.phase2Buffer){res.phase2Result={status,body};return;}
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));
}
async function api(user,method,path,body,query=''){
  const response=await fetch(base+path+query,{method,headers:{'content-type':'application/json',origin:'http://localhost',...(user?{'x-test-user':user}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
/** Wraps the route database handle: every statement is logged with the read-only state of its transaction (the probe is a separate, unlogged statement). */
function spy(target){
  const log=[];
  const proxy=new Proxy(target,{get(object,property){
    if(property==='query')return async(sql,params)=>{
      const text=String(sql).trim().replace(/\s+/g,' '),entry={text,readOnly:null};
      log.push(entry);
      if(/^(SELECT|WITH|INSERT|UPDATE|DELETE|LOCK)/i.test(text)&&object.isTransaction)entry.readOnly=(await object.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode==='on';
      return object.query(sql,params);
    };
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  return {db:proxy,log};
}
let probe;
const resetProbe=()=>{probe=spy(world.rt);routeDb=probe.db;};
const TABLES=['users','quant_jobs','quant_job_steps','bi_exports','bi_status_events','ql4c_validation','pine_deployments','pine_memberships','quant_exposure_register','risk_profiles','bot_sessions',
  'notification_outbox','signals','positions','fills',...SELECTION_TABLES];
const everything=async()=>Promise.all(TABLES.map(table=>tableDigest(world.db,table)));
/** The tables a route must never change: Bot policy, session state, the notification outbox and the trading ledger. */
const NEVER=['risk_profiles','bot_sessions','notification_outbox','signals','positions','fills','quant_jobs','quant_job_steps','bi_exports','bi_status_events','ql4c_validation'];
const never=async()=>Object.fromEntries(await Promise.all(NEVER.map(async table=>[table,await tableDigest(world.db,table)])));
const auditRows=async(owner,event)=>(await world.db.query('SELECT user_id,event,trade_id,details FROM public.audit WHERE user_id=$1 AND event=$2 ORDER BY id',[owner,event])).rows.map(row=>({...row,details:JSON.parse(row.details)}));
const NOT_FOUND={ok:false,code:'NOT_FOUND',detail:null};

before(async()=>{
  world=await createQr4World();
  resetProbe();
  const dispatch=createDispatcher({newsWindowsPort:{handle:async()=>false},requestLimits:async()=>true,auth:testAuth,database:world.rt,store:world.rtStore,preloadJson,handleRequest,runMarketDeferred,workerIntervalMs:0});
  server=http.createServer(dispatch);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(resolve=>{if(!server)return resolve();server.close(resolve);server.closeAllConnections?.();});await world?.close();});

/* ---- fixtures ---- */

let A,B,SET_A,S1,S2,COMPLETED,REGISTER_BODY;
const registerFor=async(owner,startDays,over={})=>{
  const out=await registerViaStore(world,owner,{startDays,over});
  assert.equal(out.ok,true,JSON.stringify(out));
  return out;
};
/** A FORWARD_PAST selection of a fixture set taken through freeze, both starts and the outcome write (the finalizer has its own suite). */
async function completedSelection(){
  const owner=await newOwner(world,'q4-done'),set=await seedSet(world,owner,{n:3,fixture:true});
  const start=BASE-5*DAY;
  const reg=await registerViaStore(world,owner,{fixture:true,over:{window:{kind:'FORWARD_PAST',start_ms:start,end_ms:start+1000*MS,warmup_bars:200},admission_deadline_ms:BASE+DAY}});
  assert.equal(reg.ok,true,JSON.stringify(reg));
  const id=reg.selection_id,dataset=hex('dataset:'+id);
  assert.equal((await freezeWindow(world.rt,{owner_id:owner.id,selection_id:id,dataset_hash:dataset})).ok,true);
  for(const item of reg.registration.participants){
    const parent=set.find(entry=>entry.export.exportId===item.export_id);
    assert.ok(parent,'the participant is a seeded run');
    const evaluationRunId=await seedEvaluationJob(world,owner,parent,'ev-'+randomUUID());
    const started=await startEvaluation(world.rt,{owner_id:owner.id,selection_id:id,export_id:item.export_id,evaluation_run_id:evaluationRunId});
    assert.equal(started.ok,true,JSON.stringify(started));
  }
  const evaluations=await evaluationsOf(owner,id,['3','2','1']);
  const out=await writeOutcome(world.rt,{owner_id:owner.id,selection_id:id,evaluations});
  assert.equal(out.ok,true,JSON.stringify(out));
  return {owner,set,id,registration:reg.registration,evaluations,outcome:out};
}
const evaluationOf=(registration,start,net)=>{
  const result={evaluation_bars:registration.window.evaluation_bars,metrics:{net_return_percent:net,max_drawdown_percent:'5',closed_trades:9},episodes:8,rejected_intents:0,fees:'1.2',slippage:'0.4',
    exposure_percent:'35',cost_stress:{net_return_percent:'1'},benchmark:{net_return_percent:'0.1'}};
  return {run_id:start.evaluation_run_id,parent_run_id:start.parent_run_id,selection_id:registration.selection_id,mode:'QR4_SELECTION_EVAL',status:'SUCCEEDED',
    integrity:{contract_hash_verified:true,report_matches_checkpoints:true},engine_hash:ENGINE,dataset_hash:start.dataset_hash,result,result_hash:digest(result)};
};
async function evaluationsOf(owner,id,nets){
  const read=await readSelection(world.rt,{owner_id:owner.id,selection_id:id});
  assert.equal(read.ok,true);
  return read.selection.starts.map((start,index)=>evaluationOf(read.selection.registration,start,nets[index]??'1'));
}

test('setup: owners, fixture packages, two registered selections of A (store-level, real reader) and a completed one',async()=>{
  A=await newOwner(world,'q4-a');B=await newOwner(world,'q4-b');
  SET_A=await seedSet(world,A,{n:3,fixture:true});await seedSet(world,B,{n:2,fixture:true});
  S1=await registerFor(A,60);S2=await registerFor(A,61);
  COMPLETED=await completedSelection();
  REGISTER_BODY={confirmed:true,fixture:true,scope:structuredClone(SCOPE),window:{kind:'PROSPECTIVE',start_ms:BASE+80*DAY,end_ms:BASE+80*DAY+1000*MS,warmup_bars:200},
    objective:{id:OBJECTIVE_ID},filters:structuredClone(FILTERS)};
  assert.equal(S2.registration.prior_selection_count,1);
});

/* ---- flag, methods, queries ---- */

test('flag off: every path falls through to the router 404 and the routes read nothing',async()=>{
  flag=false;resetProbe();
  try{
    const before_=await everything();
    for(const method of ['GET','POST','PUT','DELETE'])for(const path of [QR4_PATH,QR4_PATH+'/'+S1.selection_id,QR4_PATH+'/'+S1.selection_id+'/cancel',QR4_PATH+'/'+S1.selection_id+'/replay',
      QR4_PATH+'/'+S1.selection_id+'/package/'+S1.registration.participants[0].export_id,QR4_PATH+'/'+S1.selection_id+'/apply']){
      const answer=await api(A.id,method,path,method==='GET'?undefined:{confirmed:true});
      assert.deepEqual([answer.status,answer.body],[404,{error:'Not found'}],method+' '+path);
    }
    assert.equal(probe.log.length,0,'nothing was read');
    assert.deepEqual(await everything(),before_);
  }finally{flag=true;resetProbe();}
});

test('the sign-in requirement and the query rules hold on the real dispatcher: no session is 401; a query key is refused before any read',async()=>{
  assert.equal((await api(null,'GET',QR4_PATH)).status,401);
  resetProbe();
  const sorted=await api(A.id,'GET',QR4_PATH,undefined,'?sort=net_return');
  assert.deepEqual([sorted.status,sorted.body.code],[400,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE']);
  const top=await api(A.id,'GET',QR4_PATH+'/'+S1.selection_id,undefined,'?top10=1');
  assert.deepEqual([top.status,top.body.code],[400,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE']);
  const owner=await api(A.id,'GET',QR4_PATH,undefined,'?owner_id='+B.id);
  assert.deepEqual([owner.status,owner.body.code,owner.body.detail],[400,'INVALID_FIELDS','QUERY']);
  assert.equal(probe.log.length,0);
  assert.equal((await api(A.id,'PUT',QR4_PATH,{})).status,405);
});

/* ---- list and detail ---- */

test('list: the owner selections in creation order with counts, in a READ ONLY transaction; another owner sees only its own (16.2 items 5 and 9)',async()=>{
  resetProbe();
  const mine=await api(A.id,'GET',QR4_PATH);
  assert.equal(mine.status,200,JSON.stringify(mine.body));
  assert.deepEqual(mine.body.selections.map(item=>item.selection_id),[S1.selection_id,S2.selection_id],'creation order');
  assert.deepEqual([mine.body.counts.by_status.SELECTION_REGISTERED,mine.body.total,mine.body.truncated,mine.body.order],[2,2,false,'CREATION']);
  assert.ok(mine.body.selections.every(item=>item.fixture===true&&item.internal_view===true&&item.outcome===null&&item.participant_count===3));
  const statements=probe.log.filter(item=>item.readOnly!==null);
  assert.ok(statements.length>=2&&statements.every(item=>item.readOnly===true),'every statement of the list ran under SET TRANSACTION READ ONLY: '+JSON.stringify(statements.filter(item=>!item.readOnly)));
  assert.equal(probe.log.some(item=>/^(INSERT|UPDATE|DELETE)/i.test(item.text)),false);
  const other=await api(B.id,'GET',QR4_PATH);
  assert.deepEqual(other.body.selections,[]);
  const done=await api(COMPLETED.owner.id,'GET',QR4_PATH);
  assert.deepEqual(done.body.selections.map(item=>[item.status,typeof item.outcome]),[['SELECTION_COMPLETED','string']]);
  assert.equal(done.body.counts.by_outcome[done.body.selections[0].outcome],1);
});

test('detail of a registered selection: the registration, the universe with codes and progress counts only; read only; no metric',async()=>{
  resetProbe();
  const answer=await api(A.id,'GET',QR4_PATH+'/'+S1.selection_id);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.deepEqual([body.status,body.fixture,body.internal_view,body.metrics_visible,body.outcome,body.overlays,body.label_visible],['SELECTION_REGISTERED',true,true,false,null,[],false]);
  assert.deepEqual(body.progress,{participants:3,started:0,window_frozen:false});
  assert.equal(body.registration.registration_hash,S1.registration_hash);
  assert.deepEqual(body.registration.participants.map(item=>item.export_id),SET_A.map(item=>item.export.exportId).sort());
  assert.ok(body.registration.universe.every(item=>item.status==='PARTICIPANT'));
  assert.deepEqual(body.registration.scope.policy,SCOPE.policy);
  assert.equal(body.registration.window.start_ms,S1.registration.window.start_ms);
  const keys=JSON.stringify(Object.keys(body.registration));
  assert.doesNotMatch(keys,/rank|best|winner|leader/i);
  const statements=probe.log.filter(item=>item.readOnly!==null);
  assert.ok(statements.length>=5&&statements.every(item=>item.readOnly===true));
  // the stored row equals what the route shows: the registration text hashes to the hash shown
  const stored=(await world.db.query('SELECT body_canonical,registration_hash FROM public.quant_selection_registrations WHERE selection_id=$1',[S1.selection_id])).rows[0];
  assert.equal(stored.registration_hash,body.registration.registration_hash);
});

test('detail of a completed fixture selection: the stored outcome with its hash, no label, an internal view, and the overlays at read time (a replay mismatch suppresses and hides)',async()=>{
  const answer=await api(COMPLETED.owner.id,'GET',QR4_PATH+'/'+COMPLETED.id);
  assert.equal(answer.status,200,JSON.stringify(answer.body).slice(0,400));
  const body=answer.body;
  assert.deepEqual([body.status,body.metrics_visible,body.fixture,body.internal_view,body.label_visible,body.overlays],['SELECTION_COMPLETED',true,true,true,false,[]]);
  assert.equal(body.outcome.outcome_hash,COMPLETED.outcome.outcome_hash);
  assert.equal(body.outcome.label,null,'a fixture selection never gets a label (OD-S15)');
  assert.deepEqual(body.outcome.ranking.map(item=>item.rank),[1,2,3]);
  assert.equal(body.outcome.fixture,true);
  assert.equal(body.progress.started,3);
  // a tampered evaluation (a different result hash) makes the replay write one mismatch event; the view then suppresses and hides
  const tampered=structuredClone(COMPLETED.evaluations);tampered[0].result.metrics.net_return_percent='0.1';tampered[0].result_hash=digest(tampered[0].result);
  const mismatch=await replaySelectionOutcome(world.rt,{owner_id:COMPLETED.owner.id,selection_id:COMPLETED.id,evaluations:tampered});
  assert.deepEqual([mismatch.ok,mismatch.match],[true,false]);
  const after_=await api(COMPLETED.owner.id,'GET',QR4_PATH+'/'+COMPLETED.id);
  assert.deepEqual([after_.body.overlays,after_.body.replay_mismatch,after_.body.hide_recommended_values,after_.body.outcome.label],[['SELECTION_REPLAY_MISMATCH'],true,true,null]);
  assert.ok(after_.body.outcome.ranking.filter(item=>item.rank===1).every(item=>item.net_return_percent===null&&item.max_drawdown_percent===null));
});

test('owner isolation (16.2 item 5): another owner reading, cancelling, replaying or opening a package of these ids gets one identical 404 body with no value',async()=>{
  const wired={replay:async()=>{throw new Error('must not run');}};
  deps=wired;
  try{
    resetProbe();
    const before_=await everything();
    const absent=(await api(B.id,'GET',QR4_PATH+'/'+randomUUID())).body;
    assert.deepEqual(absent,NOT_FOUND);
    const exportId=S1.registration.participants[0].export_id;
    for(const [method,path,body] of [['GET',QR4_PATH+'/'+S1.selection_id],['POST',QR4_PATH+'/'+S1.selection_id+'/cancel',{confirmed:true}],['POST',QR4_PATH+'/'+S1.selection_id+'/replay',{}],
      ['GET',QR4_PATH+'/'+S1.selection_id+'/package/'+exportId],['GET',QR4_PATH+'/'+COMPLETED.id],['POST',QR4_PATH+'/'+COMPLETED.id+'/replay',{}],['GET',QR4_PATH+'/not-an-id'],['GET',QR4_PATH+'/'+S1.selection_id+'/package/'+randomUUID()]]){
      const answer=await api(B.id,method,path,body);
      assert.deepEqual([answer.status,answer.body],[404,NOT_FOUND],method+' '+path);
    }
    // the owner's own selection with an export id of another selection is the same 404
    assert.deepEqual((await api(A.id,'GET',QR4_PATH+'/'+S1.selection_id+'/package/'+randomUUID())).body,NOT_FOUND);
    assert.deepEqual(await everything(),before_,'nothing changed');
  }finally{deps=undefined;}
});

test('open_package: the export id and its state only, no link; a fixture package is never READY (409 FIXTURE); a package that is stale names its freshness code',async()=>{
  const exportId=S1.registration.participants[0].export_id;
  resetProbe();
  const answer=await api(A.id,'GET',QR4_PATH+'/'+S1.selection_id+'/package/'+exportId);
  assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[409,'QR4_PARTICIPANT_NOT_READY','FIXTURE']);
  assert.ok(probe.log.filter(item=>item.readOnly!==null).every(item=>item.readOnly===true));
  const run=SET_A.find(item=>item.export.exportId===exportId);
  await world.db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[run.importId]);
  try{
    const stale=await api(A.id,'GET',QR4_PATH+'/'+S1.selection_id+'/package/'+exportId);
    assert.deepEqual([stale.status,stale.body.code,stale.body.detail],[409,'QR4_PARTICIPANT_NOT_READY','BI_SOURCE_VERSION_STALE']);
  }finally{await world.db.query('UPDATE pine_memberships SET connected=true WHERE pine_import_id=$1',[run.importId]);}
  assert.equal(JSON.stringify(answer.body).includes('http'),false);
});

/* ---- cancel ---- */

test('cancel: the confirm token is required; the owner cancels once; a repeat is QR4_TRANSITION_INVALID; one audit row with ids and codes only; the registration and exposure rows stay',async()=>{
  const owner=A,id=S2.selection_id;
  const before_=await never();
  const unconfirmed=await api(owner.id,'POST',QR4_PATH+'/'+id+'/cancel',{});
  assert.deepEqual([unconfirmed.status,unconfirmed.body.code],[400,'CONFIRMATION_REQUIRED']);
  assert.deepEqual((await api(owner.id,'POST',QR4_PATH+'/'+id+'/cancel',{confirmed:false})).body.code,'CONFIRMATION_REQUIRED');
  const stored=(await world.db.query('SELECT count(*)::int n FROM public.quant_selection_status_events WHERE selection_id=$1',[id])).rows[0].n;
  assert.equal(stored,1,'a refused cancel wrote nothing');
  const done=await api(owner.id,'POST',QR4_PATH+'/'+id+'/cancel',{confirmed:true});
  assert.deepEqual([done.status,done.body.ok,done.body.status,done.body.seq,done.body.exposure_records],[200,true,'SELECTION_CANCELLED',2,'KEPT']);
  const again=await api(owner.id,'POST',QR4_PATH+'/'+id+'/cancel',{confirmed:true});
  assert.deepEqual([again.status,again.body.code],[409,'QR4_TRANSITION_INVALID']);
  const rows=await auditRows(owner.id,QR4_CANCEL_EVENT);
  assert.equal(rows.length,1);
  assert.deepEqual(Object.keys(rows[0].details).sort(),['outcome','selection_id','seq','status']);
  assert.deepEqual([rows[0].details.selection_id,rows[0].details.status,rows[0].details.outcome,rows[0].trade_id],[id,'SELECTION_CANCELLED','CANCELLED',null]);
  const view=await api(owner.id,'GET',QR4_PATH+'/'+id);
  assert.deepEqual([view.body.status,view.body.outcome,view.body.events.map(item=>item.status)],['SELECTION_CANCELLED',null,['SELECTION_REGISTERED','SELECTION_CANCELLED']]);
  const list=await api(owner.id,'GET',QR4_PATH);
  assert.deepEqual([list.body.counts.by_status.SELECTION_CANCELLED,list.body.counts.by_status.SELECTION_REGISTERED],[1,1]);
  assert.deepEqual(await never(),before_,'Bot policy, session state, the outbox, the ledger and the research and package rows are unchanged');
  // a completed selection cannot be cancelled
  const completed=await api(COMPLETED.owner.id,'POST',QR4_PATH+'/'+COMPLETED.id+'/cancel',{confirmed:true});
  assert.deepEqual([completed.status,completed.body.code],[409,'QR4_TRANSITION_INVALID']);
  assert.equal((await auditRows(COMPLETED.owner.id,QR4_CANCEL_EVENT)).length,0);
});

/* ---- replay ---- */

test('replay: refuses until the wiring supplies deps.replay; with it the real replay runs once, audits once and leaves the outcome unchanged',async()=>{
  const done=await completedSelection();
  const unwired=await api(done.owner.id,'POST',QR4_PATH+'/'+done.id+'/replay',{});
  assert.deepEqual([unwired.status,unwired.body.code,unwired.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','REPLAY_NOT_WIRED']);
  const open=await api(A.id,'POST',QR4_PATH+'/'+S1.selection_id+'/replay',{});
  assert.deepEqual([open.status,open.body.code,open.body.detail],[409,'QR4_TRANSITION_INVALID','NOT_COMPLETED']);
  const before_=await tableDigest(world.db,'quant_selection_outcomes');
  deps={replay:input=>replaySelectionOutcome(world.rt,{...input,evaluations:done.evaluations})};
  try{
    const match=await api(done.owner.id,'POST',QR4_PATH+'/'+done.id+'/replay',{});
    assert.deepEqual([match.status,match.body.ok,match.body.match,match.body.outcome_unchanged],[200,true,true,true],JSON.stringify(match.body));
    assert.equal(match.body.stored_outcome_hash,done.outcome.outcome_hash);
    assert.equal((await world.db.query('SELECT count(*)::int n FROM public.quant_selection_replay_events WHERE selection_id=$1',[done.id])).rows[0].n,0,'an equal replay writes no event');
    const rows=await auditRows(done.owner.id,QR4_REPLAY_EVENT);
    assert.deepEqual(rows.map(row=>[row.details.selection_id,row.details.outcome,row.details.match]),[[done.id,'REPLAY_MATCH',true]]);
    // a replay over a tampered evaluation set writes one append-only mismatch event; the stored outcome row is never changed
    const tampered=structuredClone(done.evaluations);tampered[1].result.metrics.net_return_percent='9';tampered[1].result_hash=digest(tampered[1].result);
    deps={replay:input=>replaySelectionOutcome(world.rt,{...input,evaluations:tampered})};
    const differs=await api(done.owner.id,'POST',QR4_PATH+'/'+done.id+'/replay',{});
    assert.deepEqual([differs.status,differs.body.match],[200,false]);
    assert.equal((await world.db.query('SELECT count(*)::int n FROM public.quant_selection_replay_events WHERE selection_id=$1',[done.id])).rows[0].n,1);
    assert.deepEqual(await tableDigest(world.db,'quant_selection_outcomes'),before_,'the stored outcome is never edited');
    const view=await api(done.owner.id,'GET',QR4_PATH+'/'+done.id);
    assert.deepEqual(view.body.overlays,['SELECTION_REPLAY_MISMATCH']);
  }finally{deps=undefined;}
});

/* ---- register: fail closed ---- */

test('register without the evaluation wiring: QR4_EVALUATION_MODE_UNAVAILABLE, nothing read, nothing written',async()=>{
  resetProbe();
  const before_=await everything();
  const answer=await api(A.id,'POST',QR4_PATH,REGISTER_BODY);
  assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','REGISTER_NOT_WIRED']);
  assert.equal(probe.log.length,0);
  assert.deepEqual(await everything(),before_);
  assert.equal((await auditRows(A.id,'qr4.selection_registered')).length,0);
});

test('register with an injected engine hash and the production dependencies (16.4 item 2): no eligible participant first; then QR4_QR3_CONTEXT_UNAVAILABLE for an eligible fixture set; nothing is written',async()=>{
  deps={engineHash:async()=>ENGINE};
  try{
    // a customer owner with no READY package: the first refusal of RC-S15, each member with its first failing code
    const plain=await newOwner(world,'q4-plain');
    for(const tag of ['p1','p2'])await seedRunWithPackage(world,plain,{tag:tag+'-'+randomUUID().slice(0,5),package:false});
    const ready=await newOwner(world,'q4-ready'),digest_=await seedBars(world);
    for(const tag of ['r1','r2'])await seedRunWithPackage(world,ready,{tag:tag+'-'+randomUUID().slice(0,5),digest:digest_,package:{fixture:false}});
    const before_=await everything();
    const nothing=await never();
    const none=await api(plain.id,'POST',QR4_PATH,{...REGISTER_BODY,fixture:false});
    assert.deepEqual([none.status,none.body.code],[409,'QR4_NO_ELIGIBLE_PARTICIPANT'],JSON.stringify(none.body).slice(0,300));
    assert.equal(none.body.universe.length,2);
    assert.ok(none.body.universe.every(item=>item.eligible===false&&item.failures.some(failure=>failure.check==='E2'&&failure.detail==='PACKAGE_MISSING')));
    // a customer owner with READY non-fixture packages: G8 has no source, so every member is still excluded
    const g8=await api(ready.id,'POST',QR4_PATH,{...REGISTER_BODY,fixture:false});
    assert.deepEqual([g8.status,g8.body.code],[409,'QR4_NO_ELIGIBLE_PARTICIPANT']);
    assert.ok(g8.body.universe.every(item=>item.checks.E2==='PASS'&&item.code==='QR4_DEVELOPMENT_SCORE_NOT_RANKABLE'));
    // a customer selection over a fixture set: the labelled runs are not in the universe at all (so the policy of the scope has no parent)
    const fixtureOnly=await api(A.id,'POST',QR4_PATH,{...REGISTER_BODY,fixture:false});
    assert.deepEqual([fixtureOnly.body.code,fixtureOnly.body.detail],['QR4_FILTER_INVALID','POLICY_SNAPSHOT_UNREADABLE'],'the labelled runs are not in the universe, so no parent carries the declared policy hash (the scope check comes first)');
    // a fixture selection of the eligible fixture set: the V8 hold refuses (qr3_context is false in the production context)
    const v8=await api(A.id,'POST',QR4_PATH,REGISTER_BODY);
    assert.deepEqual([v8.status,v8.body.code,v8.body.detail],[409,'QR4_QR3_CONTEXT_UNAVAILABLE','QR3_VALUATION_AND_BENCHMARK']);
    // the fixture flag is a server flag: without it the request is refused for it
    fixtureAllowed=false;
    try{
      const off=await api(A.id,'POST',QR4_PATH,REGISTER_BODY);
      assert.deepEqual([off.status,off.body.code,off.body.detail],[400,'QR4_FIXTURE_PARTICIPANT','FIXTURE_SELECTION_NOT_ALLOWED']);
    }finally{fixtureAllowed=true;}
    // the declared policy hash must be one a parent carries
    const policy=await api(A.id,'POST',QR4_PATH,{...REGISTER_BODY,scope:{...REGISTER_BODY.scope,policy:{policy_version:'risk-v1',policy_hash:hex('another policy')}}});
    assert.deepEqual([policy.status,policy.body.code,policy.body.detail],[400,'QR4_FILTER_INVALID','POLICY_SNAPSHOT_UNREADABLE']);
    // a scope that is not the one of the participants
    const scope=await api(A.id,'POST',QR4_PATH,{...REGISTER_BODY,scope:{...REGISTER_BODY.scope,cost_model:{...REGISTER_BODY.scope.cost_model,fee_bps:'11'}}});
    assert.deepEqual([scope.body.code,scope.body.detail],['QR4_NO_ELIGIBLE_PARTICIPANT',null]);
    assert.ok(scope.body.universe.every(item=>item.failures.some(failure=>failure.code==='QR4_SCOPE_INCOMPATIBLE')));
    assert.deepEqual(await everything(),before_,'every refusal wrote nothing');
    assert.deepEqual(await never(),nothing);
    assert.equal((await auditRows(A.id,'qr4.selection_registered')).length,0);
  }finally{deps=undefined;}
});

test('register refusals that need no read: a body that carries the registry, the dependencies, a tolerance, the prior selections, an apply word or weights',async()=>{
  deps={engineHash:async()=>ENGINE};
  try{
    resetProbe();
    const before_=await everything();
    const expectRefusal=async(over,status,code,detail=null)=>{
      const answer=await api(A.id,'POST',QR4_PATH,{...REGISTER_BODY,...over});
      assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[status,code,detail],JSON.stringify(over).slice(0,100));
    };
    await expectRefusal({objective_registry:{x:1}},400,'INVALID_FIELDS','BODY');
    await expectRefusal({dependencies:{qr3_context:true}},400,'INVALID_FIELDS','BODY');
    await expectRefusal({prior_selection_ids:[]},400,'INVALID_FIELDS','BODY');
    await expectRefusal({tie_tolerance:'1'},400,'INVALID_FIELDS','TOLERANCE_IN_REQUEST');
    await expectRefusal({filters:{...FILTERS,tolerance_pp:'1'}},400,'INVALID_FIELDS','TOLERANCE_IN_REQUEST');
    await expectRefusal({apply:true},403,'QR4_APPLY_REFUSED','ACTION_NOT_ALLOWED');
    await expectRefusal({start_bot:true},403,'QR4_APPLY_REFUSED','ACTION_NOT_ALLOWED');
    await expectRefusal({weights:{a:1}},400,'QR4_CUSTOM_WEIGHTS_REFUSED','weights');
    await expectRefusal({confirmed:undefined},400,'CONFIRMATION_REQUIRED');
    assert.equal(probe.log.length,0,'all of them were refused in phase one');
    assert.deepEqual(await everything(),before_);
    // a POST to an apply-like route changes nothing
    for(const name of ['apply','import','start','email','alert']){
      const answer=await api(A.id,'POST',QR4_PATH+'/'+S1.selection_id+'/'+name,{});
      assert.deepEqual([answer.status,answer.body.code],[403,'QR4_APPLY_REFUSED'],name);
    }
    assert.deepEqual(await everything(),before_);
  }finally{deps=undefined;}
});

test('the rows of the reader and the store are consistent: the stored universe of a registered selection equals the one the route shows; the read p95 is measured in the inputs suite',async()=>{
  const stored=await readSelection(world.rt,{owner_id:A.id,selection_id:S1.selection_id});
  assert.equal(stored.ok,true);
  const view=await api(A.id,'GET',QR4_PATH+'/'+S1.selection_id);
  assert.deepEqual(view.body.registration.universe.map(item=>item.run_id),stored.selection.universe.map(item=>item.run_id));
  const counted=await counts(world.db);
  assert.ok(counted.quant_selection_registrations>=4);
});

/* ---- the real application server: flag, session, canonical CSRF, owner scope, the Bot policy reader ---- */

const PASSWORD='Qr4-routes-'+randomUUID();
async function startServer({enabled,fixtures=false}){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,NODE_OPTIONS:'',NODE_ENV:'test',DATABASE_URL:world.connectionString,HOST:'127.0.0.1',PORT:String(port),
    PUBLIC_ORIGIN:origin,SMTP_HOST:'',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'0',PINE_CAPTURE_ENABLED:'0',QUANT_RESEARCH_ENABLED:'0',QUANT_RESEARCH_FOUNDATION_ENABLED:'0',
    QUANT_PREFLIGHT_ENABLED:'0',MARKET_PUBLIC_PROXY:'0',QR2_PERFORMANCE_ENABLED:'',QR3_COMPARISON_ENABLED:'',QR4_SELECTION_ENABLED:enabled?'1':'',QR4_FIXTURE_SELECTIONS_ENABLED:fixtures?'1':''}});
  let output='',exited=false;
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  let ready=false;
  for(let index=0;index<300&&!exited;index++){
    try{ready=(await fetch(origin+'/api/auth/config')).ok;}catch{}
    if(ready)break;await delay(50);
  }
  if(!ready){child.kill('SIGTERM');throw Error('server did not start: '+output.slice(-1200));}
  const request=httpClient(origin);
  const login=async email=>{const answer=await request('/api/auth/login','POST',{email,password:PASSWORD});assert.equal(answer.status,200,JSON.stringify(answer.body));return answer.session;};
  const close=async()=>{if(!exited){child.kill('SIGTERM');await Promise.race([exit,delay(5000).then(()=>{if(!exited)child.kill('SIGKILL');})]);await exit;}};
  return {request,login,close};
}
const emailOf=async owner=>{
  await world.db.query('UPDATE public.users SET password_hash=$2 WHERE id=$1',[owner.id,await hashPassword(PASSWORD)]);
  return (await world.db.query('SELECT email FROM public.users WHERE id=$1',[owner.id])).rows[0].email;
};

test('real server, flag off: every path and method answers 404 and nothing changes',async()=>{
  const email=await emailOf(A);
  const app=await startServer({enabled:false});
  try{
    const session=await app.login(email),state=await never();
    for(const [method,path,body] of [['GET',QR4_PATH],['GET',QR4_PATH+'/'+S1.selection_id],['POST',QR4_PATH,REGISTER_BODY],['POST',QR4_PATH+'/'+S1.selection_id+'/cancel',{confirmed:true}],
      ['POST',QR4_PATH+'/'+S1.selection_id+'/replay',{}],['GET',QR4_PATH+'/'+S1.selection_id+'/package/'+S1.registration.participants[0].export_id],['POST',QR4_PATH+'/'+S1.selection_id+'/apply',{}]]){
      const answer=await app.request(path,method,body,session);
      assert.equal(answer.status,404,method+' '+path+' '+JSON.stringify(answer.body));
    }
    assert.deepEqual(await never(),state);
  }finally{await app.close();}
});

test('real server, flag on: session, canonical CSRF, owner scope, the real Bot policy reader, register and replay fail closed',async()=>{
  const emailA=await emailOf(A),emailB=await emailOf(B),emailDone=await emailOf(COMPLETED.owner);
  const app=await startServer({enabled:true,fixtures:true});
  try{
    const session=await app.login(emailA),other=await app.login(emailB),doneSession=await app.login(emailDone);
    assert.equal((await app.request(QR4_PATH,'GET',undefined,{cookie:{},csrf:''})).status,401);
    assert.equal((await app.request(QR4_PATH,'POST',REGISTER_BODY,{cookie:{},csrf:''})).status,401);
    const state=await never();
    for(const csrf of ['','not-the-token']){
      const bad={cookie:{...session.cookie},csrf};
      assert.equal((await app.request(QR4_PATH,'POST',REGISTER_BODY,bad)).status,403);
      assert.equal((await app.request(QR4_PATH+'/'+S1.selection_id+'/cancel','POST',{confirmed:true},bad)).status,403);
      assert.equal((await app.request(QR4_PATH+'/'+S1.selection_id+'/replay','POST',{},bad)).status,403);
      assert.equal((await app.request(QR4_PATH+'/'+S1.selection_id+'/apply','POST',{},bad)).status,403);
    }
    assert.deepEqual(await never(),state);
    const list=await app.request(QR4_PATH,'GET',undefined,session);
    assert.deepEqual([list.status,list.body.selections.map(item=>item.selection_id)],[200,[S1.selection_id,S2.selection_id]]);
    const detail=await app.request(QR4_PATH+'/'+S1.selection_id,'GET',undefined,session);
    assert.deepEqual([detail.status,detail.body.status],[200,'SELECTION_REGISTERED']);
    // another owner: the same 404 as for an absent id
    const foreign=[await app.request(QR4_PATH+'/'+S1.selection_id,'GET',undefined,other),await app.request(QR4_PATH+'/'+S1.selection_id+'/cancel','POST',{confirmed:true},other),
      await app.request(QR4_PATH+'/'+S1.selection_id+'/replay','POST',{},other),await app.request(QR4_PATH+'/'+randomUUID(),'GET',undefined,other)];
    for(const answer of foreign)assert.deepEqual([answer.status,answer.body],[404,NOT_FOUND]);
    assert.deepEqual((await app.request(QR4_PATH,'GET',undefined,other)).body.selections,[]);
    // the real Bot policy reader runs: the stored Bot policy hash differs from the packaged one, so the package is stale, not an error
    const stale=await app.request(QR4_PATH+'/'+S1.selection_id+'/package/'+S1.registration.participants[0].export_id,'GET',undefined,session);
    assert.deepEqual([stale.status,stale.body.code,stale.body.detail],[409,'QR4_PARTICIPANT_NOT_READY','BI_POLICY_SNAPSHOT_MISMATCH'],JSON.stringify(stale.body));
    // register and replay fail closed: the server has no evaluation wiring yet
    const register=await app.request(QR4_PATH,'POST',REGISTER_BODY,session);
    assert.deepEqual([register.status,register.body.code,register.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','REGISTER_NOT_WIRED']);
    const replay=await app.request(QR4_PATH+'/'+COMPLETED.id+'/replay','POST',{},doneSession);
    assert.deepEqual([replay.status,replay.body.code,replay.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','REPLAY_NOT_WIRED']);
    // apply-like POSTs: 403 after the CSRF check, and nothing changes
    for(const name of ['apply','import','start','email','alert']){
      const answer=await app.request(QR4_PATH+'/'+S1.selection_id+'/'+name,'POST',{},session);
      assert.deepEqual([answer.status,answer.body.code],[403,'QR4_APPLY_REFUSED'],name);
    }
    assert.equal((await app.request(QR4_PATH+'?user_id='+B.id,'GET',undefined,session)).body.detail,'QUERY');
    assert.equal((await app.request(QR4_PATH+'?sort=net','GET',undefined,session)).body.code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
    assert.equal((await app.request(QR4_PATH+'/'+S1.selection_id,'POST',{},session)).status,405);
    assert.deepEqual(await never(),state,'Bot policy, session state, the outbox, the ledger and the research and package rows are unchanged');
  }finally{await app.close();}
});

/* ---- the universe and eligibility preview (Q4-C, SB213 item 3) ---- */

const PREVIEW=QR4_PATH+'/preview';
const creationOrder=set=>[...set].sort((a,b)=>(a.run.created_at-b.run.created_at)||(a.runId<b.runId?-1:a.runId>b.runId?1:0)).map(item=>item.runId);
const auditCount=async owner=>(await world.db.query('SELECT count(*)::int n FROM public.audit WHERE user_id=$1',[owner])).rows[0].n;

test('preview (fixture flag on): the universe of the owner in creation order, every member with its eligibility checks, its scope and no metric; READ ONLY; nothing is written',async()=>{
  resetProbe();
  const before_=await everything(),audits=await auditCount(A.id);
  const answer=await api(A.id,'POST',PREVIEW,{fixture:true});
  assert.equal(answer.status,200,JSON.stringify(answer.body).slice(0,400));
  const body=answer.body;
  assert.deepEqual([body.order,body.fixture,body.scope_declared,body.declared_scope,body.universe_count,body.participant_count,body.excluded_count,body.registration_wired],['CREATION',true,false,null,3,3,0,false]);
  assert.deepEqual(body.members.map(item=>item.run_id),creationOrder(SET_A),'creation order, the metrics never matter');
  for(const member of body.members){
    assert.deepEqual([member.status,member.eligible,member.code,member.failures],['PARTICIPANT',true,null,[]]);
    assert.deepEqual(member.checks,{E1:'PASS',E2:'PASS',E3:'PASS',E4:'PASS',E5:'NOT_REACHED',E6:'PASS'},'no scope was declared, so the scope check is not run');
    assert.deepEqual(member.scope,{data_model:SCOPE.data_model,cost_model:SCOPE.cost_model,capital:SCOPE.capital,policy:SCOPE.policy},'the member scope is the one the fixed evaluation compares');
    assert.ok(SET_A.some(item=>item.export.exportId===member.export_id&&item.runId===member.run_id));
    assert.deepEqual(Object.keys(member).filter(key=>/net_return|drawdown|score|rank|best|top|winner|leader|metric/i.test(key)),[]);
  }
  assert.deepEqual(developmentRowViolations(body),[]);
  const statements=probe.log.filter(item=>item.readOnly!==null);
  assert.ok(statements.length>=5&&statements.every(item=>item.readOnly===true),'every statement ran under SET TRANSACTION READ ONLY: '+JSON.stringify(statements.filter(item=>!item.readOnly).slice(0,3)));
  assert.equal(probe.log.some(item=>/^(INSERT|UPDATE|DELETE|LOCK)/i.test(item.text)),false);
  assert.deepEqual(await everything(),before_,'no table changed');
  assert.equal(await auditCount(A.id),audits,'a preview writes no audit row');
});

test('preview: a declared scope runs the scope check E5 with the registration comparison; a different fee gives QR4_SCOPE_INCOMPATIBLE with the field named; capital is compared normalised',async()=>{
  const same=await api(A.id,'POST',PREVIEW,{fixture:true,scope:{...SCOPE,capital:{equity:'1000.0',cash:'1000.00'}}});
  assert.equal(same.status,200,JSON.stringify(same.body).slice(0,300));
  assert.deepEqual([same.body.scope_declared,same.body.participant_count,same.body.declared_scope.capital],[true,3,{equity:'1000',cash:'1000'}]);
  assert.ok(same.body.members.every(item=>item.checks.E5==='PASS'&&item.mismatched_fields.length===0));
  const other=await api(A.id,'POST',PREVIEW,{fixture:true,scope:{...SCOPE,cost_model:{...SCOPE.cost_model,fee_bps:'11'}}});
  assert.equal(other.status,200);
  assert.deepEqual([other.body.participant_count,other.body.excluded_count],[0,3]);
  for(const member of other.body.members){
    assert.deepEqual([member.status,member.code,member.detail,member.mismatched_fields,member.checks.E5],['EXCLUDED','QR4_SCOPE_INCOMPATIBLE','cost_model',['cost_model'],'FAIL']);
    assert.deepEqual(member.failures,[{check:'E5',code:'QR4_SCOPE_INCOMPATIBLE',detail:'cost_model'}]);
  }
  // the risk percent is part of the cost model: an owner that leaves it out does not match the stored form
  const noRisk=await api(A.id,'POST',PREVIEW,{fixture:true,scope:{...SCOPE,cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1'}}});
  assert.deepEqual(noRisk.body.members.map(item=>item.mismatched_fields),[['cost_model'],['cost_model'],['cost_model']]);
  // the same declared scope gives the registration answer: the registration through the store accepts exactly this scope
  const unequal=await api(A.id,'POST',PREVIEW,{fixture:true,scope:{...SCOPE,policy:{policy_version:'risk-v1',policy_hash:'b'.repeat(64)}}});
  assert.ok(unequal.body.members.every(item=>item.mismatched_fields.join()==='policy'));
});

test('preview: a customer preview leaves out the labelled fixture runs; another owner sees only its own members; without the server flag a fixture preview is refused',async()=>{
  const customer=await api(A.id,'POST',PREVIEW,{});
  assert.deepEqual([customer.status,customer.body.universe_count,customer.body.members],[200,0,[]],'labelled synthetic runs are not in a customer universe');
  const other=await api(B.id,'POST',PREVIEW,{fixture:true});
  assert.equal(other.status,200);
  assert.equal(other.body.universe_count,2);
  assert.ok(other.body.members.every(item=>!SET_A.some(entry=>entry.runId===item.run_id)),'no member of another owner');
  fixtureAllowed=false;
  try{
    resetProbe();
    const refused=await api(A.id,'POST',PREVIEW,{fixture:true});
    assert.deepEqual([refused.status,refused.body.code,refused.body.detail],[400,'QR4_FIXTURE_PARTICIPANT','FIXTURE_SELECTION_NOT_ALLOWED']);
    assert.equal(probe.log.length,0,'nothing was read');
  }finally{fixtureAllowed=true;}
});

test('preview of a customer run whose package is not READY and which is not qualified: excluded with the first failing code, no metric; a Bot id in the body is refused before any read',async()=>{
  const owner=await newOwner(world,'q4-pv-customer');
  const real=await seedRunWithPackage(world,owner,{tag:'pv-real',package:{fixture:false}});
  const answer=await api(owner.id,'POST',PREVIEW,{});
  assert.equal(answer.status,200,JSON.stringify(answer.body).slice(0,300));
  assert.equal(answer.body.universe_count,1);
  const member=answer.body.members[0];
  assert.deepEqual([member.run_id,member.eligible,member.status],[real.runId,false,'EXCLUDED']);
  assert.ok(typeof member.code==='string'&&member.code.startsWith('QR4_'),'the first failing code is named: '+member.code);
  assert.equal(member.failures[0].code,member.code,'the first failure is the first failing code');
  assert.equal(answer.body.participant_count,0);
  resetProbe();
  const bot=await api(owner.id,'POST',PREVIEW,{bot_id:real.botId});
  assert.deepEqual([bot.status,bot.body.code],[403,'QR4_APPLY_REFUSED']);
  const sorted=await api(owner.id,'POST',PREVIEW,{sort:'net_return'});
  assert.deepEqual([sorted.status,sorted.body.code],[400,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE']);
  const get=await api(owner.id,'GET',PREVIEW);
  assert.equal(get.status,405);
  assert.equal(probe.log.length,0);
});
