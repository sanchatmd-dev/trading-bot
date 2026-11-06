import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {createDispatcher} from '../../src/postgres/request-dispatch.js';
import {preloadJson} from '../../src/postgres/http.js';
import {runMarketDeferred} from '../../src/postgres/market-ohlcv.js';
import {qr3Routes,QR3_PATH,QR3_CREATE_EVENT,QR3_CANCEL_EVENT,READ_BUDGET,REFUSAL_CODES} from '../../src/postgres/qr3-routes.js';
import {createComparison,writeEvaluation,writeBenchmark,writeOutcome,writeReplayEvent} from '../../src/postgres/comparison-store.js';
import {outcomeRecord} from '../../src/comparison/evaluation-record.js';
import {contextFields,contextKey} from '../../src/comparison/context.js';
import {validateSpec,specHashOf} from '../../src/comparison/ranking.js';
import {validateComparisonView,NO_WINNER_TEXT} from '../../src/comparison/labels.js';
import {hashPassword} from '../../src/security.js';
import {httpClient} from '../helpers.mjs';
import {hash} from '../../src/pine-bridge/source.js';
import {windowsOverlap} from '../../src/comparison/evidence.js';
import {appendExposures} from '../../src/postgres/exposure-register.js';
import {readIndependence,INDEPENDENCE_BUDGET,INDEPENDENCE_VERSION} from '../../src/postgres/qr3-independence.js';
import {gateSnapshot} from '../../src/postgres/quant-library.js';
import {marketKey} from '../../src/quant-library/derive.js';

// QR-3 S4 owner API on a real PostgreSQL cluster: the real store, the real comparison tables and exposure register, the real fixed-evaluation admission and the REAL
// dispatcher (SERIALIZABLE request transaction, buffered answer, deferred phase) for create, view and cancel; then the real application server with its real auth, CSRF
// and routing for the flag, the session and the owner scope. Every parent run is a LABELLED SYNTHETIC FIXTURE of the FE-2b fixture; nothing here is a research result.
// One file per process, one cluster. The engine hash and the dataset digest that only the evaluation closure can supply are injected exactly as the wiring slice will.
const MINUTE=60000;
const PG_ONLY=['QR3_EXPOSURE_REGISTER_UNAVAILABLE'];
let f,server,base,intruder;
const reached=new Set();
const PASSWORD='Qr3-routes-'+randomUUID();

/* ---- the in-process application: real dispatcher, real store, test identity ---- */

const identityOf=req=>req.headers['x-test-user']||null;
const testAuth={
  checkOrigin(){},async prepareSession(){},
  async require(req){const id=identityOf(req);if(!id)throw Object.assign(new Error('Unauthorized'),{status:401});return {id};}
};
let routeStore,flag=true,deps;
async function handleRequest(req,res){
  const url=new URL(req.url,'http://localhost');
  const id=identityOf(req);
  if(!id)return json(res,401,{error:'Unauthorized'});
  if(await qr3Routes(req,res,url,{id},{store:routeStore,auth:testAuth,json,enabled:flag,deps}))return;
  return json(res,404,{error:'Not found'});
}
function json(res,status,body){
  if(res.phase2Buffer){res.phase2Result={status,body};return;}
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));
}
async function api(user,method,path,body){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json',origin:'http://localhost',...(user?{'x-test-user':user}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const answer={status:response.status,body:await response.json()};
  if(answer.body?.code)reached.add(answer.body.code);
  return answer;
}

/* ---- fixtures ---- */

const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const createBody=(over={})=>{
  const w=f.registration.window,body={confirmed:true,request_key:'pg-'+randomUUID(),fixture:true,mode:'STANDARDIZED',participants:f.state.parents.map(row=>({run_id:row.run_id})),market:MARKET,
    cost_model_version:'paper-close-v1',period:{choice:'CUSTOM',start_ms:w.start_ms,end_ms:w.end_ms},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}};
  for(const [name,value] of Object.entries(over)){if(value===undefined)delete body[name];else body[name]=value;}
  return body;
};
const serial=work=>f.db.transaction(work,{isolation:'SERIALIZABLE'});
const rowsOf=async(sql,params=[])=>(await f.db.query(sql,params)).rows;
const countOf=async(table,id)=>(await rowsOf(`SELECT count(*)::int n FROM public.${table} WHERE comparison_id=$1`,[id]))[0].n;
const events=async id=>(await rowsOf('SELECT seq,status,reason_code FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq',[id])).map(row=>[Number(row.seq),row.status,row.reason_code]);
const audits=async(owner,event)=>(await rowsOf('SELECT user_id,event,trade_id,details FROM public.audit WHERE user_id=$1 AND event=$2 ORDER BY id',[owner,event])).map(row=>({...row,details:JSON.parse(row.details)}));
const digest=async table=>(await rowsOf(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`))[0];
const TABLES=['users','quant_jobs','quant_job_steps','quant_research_chunks','quant_research_foundation','quant_foundation_jobs','pine_market_bars','quant_exposure_register','audit',
  'quant_comparison_specs','quant_comparison_participants','quant_comparison_status_events','quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes','quant_comparison_replay_events'];
const everything=async()=>Promise.all(TABLES.map(digest));
/** The dispatcher itself writes a request.error audit row (user null) for a refused request; every other table is compared. */
const withoutAudit=rows=>rows.filter((_,index)=>TABLES[index]!=='audit');

/** Wraps a database handle: every statement is logged with the read-only state of its transaction (the probe is a separate, unlogged statement). */
function spy(target){
  const log=[];
  const proxy=new Proxy(target,{get(object,property){
    if(property==='query')return async(sql,params)=>{
      const text=String(sql).trim(),entry={text,readOnly:null};
      log.push(entry);
      if(/^(SELECT|WITH|INSERT|UPDATE|DELETE|LOCK)/i.test(text)&&object.isTransaction)entry.readOnly=(await object.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode==='on';
      return object.query(sql,params);
    };
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  return {db:proxy,log};
}

/**
 * A COMPLETE comparison of n labelled fixture participants written through the store writers (the finalizer is covered by its own suite): participants 1..n-1 have an
 * evaluation record, the last one is an incompatible participant without a record. Returns {id, ids}.
 */
async function completeFixture(n,{request,omit=null}={}){
  const ids=Array.from({length:n},(_,index)=>'qr3-fx-'+randomUUID().slice(0,8)+'-'+index);
  const w=f.registration.window,checked=validateSpec({mode:'STANDARDIZED',participants:ids,period:{start_ms:w.start_ms,end_ms:w.end_ms},objective:'qr3-obj-net-return-v1',
    risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}});
  assert.equal(checked.ok,true);
  const spec=checked.spec,context=structuredClone(f.context);
  context.spec_hash=specHashOf(spec);
  const normal=contextFields(ids[0],context),key=contextKey(normal.fields);
  assert.deepEqual(normal.missing,[]);
  const created=await createComparison(f.db,{owner_id:f.owner,comparison_id:randomUUID(),fixture:true,market:f.c.snapshot.market,spec,spec_hash:specHashOf(spec),context_key:key,request_key:request??'cmp-'+randomUUID(),
    participants:ids.map((id,index)=>({participant_id:id,position:index+1,source_hash:f.c.source_hash,origin:'FIXTURE',fixture:true,context_key:key,freeze:{context:structuredClone(normal.fields)}}))});
  assert.equal(created.ok,true,JSON.stringify(created));
  const id=created.comparison_id,entries=[];
  // the evaluation writers need an EVALUATING comparison (the status guard); the fixed-evaluation admission moves it there in production
  await serial(()=>f.db.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,2,'EVALUATING')",[id]));
  for(const [index,participant] of ids.entries()){
    const compatible=index<n-1;
    let evaluation=null;
    if(compatible){
      const body={version:'qr3-evaluation-record-v1',record_comparison_id:id,record_spec_hash:specHashOf(spec),window:{start_ms:w.start_ms,end_ms:w.end_ms},participant_id:participant,
        evaluation_run_id:'fx-run-'+index,basis_confirmed:false,valuation:{net_return_percent_exact:String(index+1)+'.5'},
        metrics:{net_return_percent:String(index+1)+'.5',max_drawdown_percent:'2.5',total_fees:'1.25',total_slippage:{value:'0.75'},exposure_percent:'40',rejected_intents:3},
        completed_episodes:index+1,closed_allocations:index+1,rejected:{total:3},limitations:['VALUATION_BASIS_UNCONFIRMED']};
      body.metrics.rejected_intents='3';
      if(omit&&index===0)delete body.metrics[omit];
      const stored=await writeEvaluation(f.db,{owner_id:f.owner,comparison_id:id,participant_id:participant,spec_hash:specHashOf(spec),evaluation_run_id:'fx-run-'+index,body});
      assert.equal(stored.ok,true,JSON.stringify(stored));
      evaluation={body,created_at_ms:stored.created_at_ms};
    }
    entries.push({participant_id:participant,status_input:{integrity_ok:true,unavailable:false,compatibility:{compatible},coverage:{state:'PASS'},evidence:{evidence_class:'INDEPENDENT',reasons:[]},
      episode_gate_available:false,completed_episodes:index+1},evaluation});
  }
  const bench=await writeBenchmark(f.db,{owner_id:f.owner,comparison_id:id,spec_hash:specHashOf(spec),body:{benchmark_id:'qr3-bh-close-same-cost-v1',record_comparison_id:id,record_spec_hash:specHashOf(spec),
    window:{start_ms:w.start_ms,end_ms:w.end_ms},result:{ok:true,code:null,detail:null,method:'BUY_AND_HOLD_FIRST_BAR_CLOSE_SAME_COST',net_return_percent:'1.25',net_return_percent_exact:'1.25',max_drawdown_percent:'3'}}});
  assert.equal(bench.ok,true,JSON.stringify(bench));
  const outcome=outcomeRecord({spec,spec_hash:specHashOf(spec),context_key:key,participants:entries});
  assert.equal(outcome.ok,true,JSON.stringify(outcome));
  const done=await writeOutcome(f.db,{owner_id:f.owner,comparison_id:id,outcome});
  assert.equal(done.ok,true,JSON.stringify(done));
  return {id,ids,outcome_hash:done.outcome_hash};
}

async function listen(handler){
  const instance=http.createServer(handler);
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  return {instance,url:'http://127.0.0.1:'+instance.address().port};
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL only');
  f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
  routeStore=f.store;
  deps={engineHash:async()=>f.context.engine,datasetDigest:async()=>f.freeze.dataset_hash};
  const dispatch=createDispatcher({newsWindowsPort:{handle:async()=>false},requestLimits:async()=>true,auth:testAuth,database:f.db,store:f.store,preloadJson,handleRequest,runMarketDeferred,workerIntervalMs:0});
  ({instance:server,url:base}=await listen(dispatch));
  intruder=(await f.store.createUser({email:'intruder-'+randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture-hash'})).id;
});
after(async()=>{await new Promise(resolve=>{if(!server)return resolve();server.close(resolve);server.closeAllConnections?.();});await f?.close();});

/* ---- 1. create ---- */

/** SB191 slice A: the frozen independence block of one participant freeze, with the facts every create must carry. The fixture has no boundary table until the test below installs it. */
function independenceOf(freeze,{boundary}){
  const block=freeze.independence;
  assert.equal(block.version,INDEPENDENCE_VERSION);
  assert.deepEqual(block.registered_boundary,boundary);
  assert.ok(Array.isArray(block.earlier_holdouts)&&Array.isArray(block.searched_windows),'a readable scan is a list, never null');
  assert.ok(['NONE','SET','UNAVAILABLE'].includes(block.source_holdout_state));
  assert.ok(block.source_holdout_register===null?block.source_holdout_state==='UNAVAILABLE':Array.isArray(block.source_holdout_register),'the source-holdout register is a list or an explicit null, never absent');
  // the G1 to G8 snapshot: eight gates in order, G8 never available (library-qualification-v2)
  assert.equal(block.library_gates.version,'library-qualification-v2');
  assert.deepEqual(block.library_gates.gates.map(item=>item.gate),['G1','G2','G3','G4','G5','G6','G7','G8']);
  assert.ok(block.library_gates.gates.every(item=>['PASS','FAIL','NOT_REACHED'].includes(item.state)&&(item.state==='PASS'?item.code===null:true)));
  assert.deepEqual(block.library_gates.gates[7],{gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'});
  return block;
}


test('create freezes the spec in SPEC_FROZEN with one exposure event per participant, starts nothing, audits once, and the real fixed-evaluation admission accepts the frozen contexts',async()=>{
  const owner=f.owner,before=await everything();
  const answer=await api(owner,'POST',QR3_PATH,createBody());
  assert.equal(answer.status,201,JSON.stringify(answer.body));
  const created=answer.body,id=created.comparison_id;
  assert.deepEqual([created.ok,created.existing,created.status,created.evaluation_started],[true,false,'SPEC_FROZEN',false]);
  assert.deepEqual(await events(id),[[1,'SPEC_FROZEN',null]]);
  // F2: the spec row is stamped by the database clock before any evaluation; exposure: one event per participant and window
  assert.equal(created.frozen_at_ms>0&&created.exposure_at_ms>0,true);
  const exposure=await rowsOf('SELECT participant_run_id,start_ms,end_ms,kind FROM public.quant_exposure_register WHERE comparison_id=$1 ORDER BY participant_run_id',[id]);
  assert.deepEqual(exposure.map(row=>row.participant_run_id),f.state.parents.map(row=>row.run_id).sort());
  assert.ok(exposure.every(row=>row.kind==='QR3_COMPARISON'&&Number(row.start_ms)===f.registration.window.start_ms&&Number(row.end_ms)===f.registration.window.end_ms));
  // nothing else changed: no job, no evaluation, no benchmark, no outcome
  const after=await everything();
  const changed=TABLES.filter((_,index)=>JSON.stringify(after[index])!==JSON.stringify(before[index]));
  assert.deepEqual(changed.sort(),['audit','quant_comparison_participants','quant_comparison_specs','quant_comparison_status_events','quant_exposure_register']);
  for(const table of ['quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes','quant_comparison_replay_events'])assert.equal(await countOf(table,id),0,table);
  assert.equal((await rowsOf("SELECT count(*)::int n FROM public.quant_jobs WHERE contract->>'mode'='FIXED_INPUT_EVAL'"))[0].n,0);
  // the stored spec is the contract spec; the period is the resolved one
  assert.equal(created.spec_hash,specHashOf(JSON.parse((await rowsOf('SELECT spec_canonical FROM public.quant_comparison_specs WHERE comparison_id=$1',[id]))[0].spec_canonical)));
  assert.deepEqual([created.period.choice,created.period.anchor,created.period.start_ms,created.period.end_ms,created.period.warmup_bars,created.period.total_bars,created.period.admission],
    ['CUSTOM','CUSTOM',f.registration.window.start_ms,f.registration.window.end_ms,1006,1206,'ADMITTED']);
  // one audit row, ids and codes only
  const rows=await audits(owner,QR3_CREATE_EVENT);
  const mine=rows.filter(row=>row.details.comparison_id===id);
  assert.equal(mine.length,1);
  assert.deepEqual(Object.keys(mine[0].details).sort(),['comparison_id','context_key','fixture','outcome','participant_count','spec_hash','status']);
  assert.deepEqual([mine[0].details.status,mine[0].details.outcome,mine[0].details.participant_count,mine[0].trade_id],['SPEC_FROZEN','CREATED',2,null]);
  // the participants froze their contexts (C1 to C16) and the disclosed subject; the key is the declared comparison key
  const participants=await rowsOf('SELECT participant_id,context_key,freeze_canonical FROM public.quant_comparison_participants WHERE comparison_id=$1 ORDER BY position',[id]);
  const declared=(await rowsOf('SELECT context_key FROM public.quant_comparison_specs WHERE comparison_id=$1',[id]))[0].context_key;
  for(const row of participants){
    const freeze=JSON.parse(row.freeze_canonical);
    assert.equal(row.context_key,declared);
    assert.deepEqual(Object.keys(contextFields(row.participant_id,freeze.context).fields).sort(),Object.keys(freeze.context).sort());
    assert.equal(contextFields(row.participant_id,freeze.context).missing.length,0);
    assert.equal(freeze.context.engine,f.context.engine);
    assert.equal(freeze.subject.source_hash,f.c.source_hash);
    independenceOf(freeze,{boundary:{state:'UNAVAILABLE'}});
  }
  // C1 to C16 pin against the REAL admission: it re-reads every field of every participant at enqueue and accepts them (a drift would be FIXED_EVAL_CONTEXT_MISMATCH)
  const job=await f.service.enqueue(owner,{purpose:'QR3_COMPARISON',object_id:id,participant_id:f.state.parents[0].run_id},'pg_qr3_routes_'+randomUUID().slice(0,12));
  assert.equal(job.status,'QUEUED');
  assert.deepEqual((await events(id)).map(item=>item[1]),['SPEC_FROZEN','EVALUATING']);
  await f.db.query("UPDATE public.quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[job.run_id]);
});

test('a repeat with the same request key is the same comparison and writes nothing; the same key with another spec is QR3_SPEC_IMMUTABLE',async()=>{
  const body=createBody({request_key:'pg-repeat-'+randomUUID()});
  const first=await api(f.owner,'POST',QR3_PATH,body);
  assert.equal(first.status,201,JSON.stringify(first.body));
  const state=await everything();
  const again=await api(f.owner,'POST',QR3_PATH,body);
  assert.deepEqual([again.status,again.body.existing,again.body.same_spec,again.body.comparison_id],[200,true,true,first.body.comparison_id]);
  assert.deepEqual(await everything(),state,'a repeat writes nothing, not even an audit row');
  const other=await api(f.owner,'POST',QR3_PATH,{...body,adequacy:{min_episodes_floor:6,min_episodes_ranking:20}});
  assert.deepEqual([other.status,other.body.code,other.body.detail],[409,'QR3_SPEC_IMMUTABLE','REQUEST_KEY_REUSED']);
  assert.deepEqual(await everything(),state);
  // another owner's key is another key
  assert.equal(await countOf('quant_comparison_specs',first.body.comparison_id),1);
});

test('contract 9.1 on the real database: period, dataset, scope, fixture label, admission and wiring each refuse with one input change and write nothing',async()=>{
  const state=await everything();
  const w=f.registration.window;
  const expectCode=async(body,status,code,detail=null,user=f.owner)=>{
    const answer=await api(user,'POST',QR3_PATH,body);
    assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[status,code,detail],JSON.stringify(answer.body).slice(0,300));
    return answer;
  };
  // the period against the real stored bars
  const future=await expectCode(createBody({period:{choice:'CUSTOM',start_ms:w.start_ms,end_ms:w.end_ms+MINUTE}}),400,'QR3_PERIOD_IN_FUTURE');
  assert.equal(future.body.last_completed_end_ms,w.end_ms);
  const range=await expectCode(createBody({period:{choice:'CUSTOM',start_ms:w.end_ms-9000*MINUTE,end_ms:w.end_ms}}),400,'QR3_RANGE_ADMISSION_REFUSED');
  assert.deepEqual([range.body.total_bars,range.body.limit],[10006,10000]);
  await expectCode(createBody({period:{choice:'CUSTOM',start_ms:w.end_ms,end_ms:w.start_ms}}),400,'QR3_PERIOD_INVALID','END_NOT_AFTER_START');
  // a window that starts before the stored history has a gap at the start: refused, never shortened
  const gapped=await expectCode(createBody({period:{choice:'CUSTOM',start_ms:w.start_ms-500*MINUTE,end_ms:w.end_ms}}),409,'QR3_DATASET_GAPPED');
  assert.equal(gapped.body.gaps[0].end_ms>gapped.body.gaps[0].start_ms,true);
  // scope: another owner's runs and absent runs answer one 404
  const probe=spy(f.db),previous=routeStore;
  routeStore={db:probe.db,audit:(...args)=>f.store.audit(...args)};
  let foreign;
  try{foreign=await api(intruder,'POST',QR3_PATH,createBody());}finally{routeStore=previous;}
  // every read of a parent run is scoped to the session user in the statement itself, not only after the read
  const parentReads=probe.log.filter(entry=>/FROM public\.quant_jobs/.test(entry.text));
  assert.ok(parentReads.length>=1&&parentReads.every(entry=>/owner_id=\$2/.test(entry.text)),parentReads.map(entry=>entry.text.slice(0,120)).join(' | '));
  const absent=await api(f.owner,'POST',QR3_PATH,createBody({participants:[{run_id:f.state.parents[0].run_id},{run_id:randomUUID()}]}));
  const lead=await api(f.owner,'POST',QR3_PATH,createBody({participants:[{run_id:randomUUID()},{run_id:f.state.parents[1].run_id}]}));
  assert.deepEqual([foreign.status,absent.status,lead.status],[404,404,404]);
  assert.deepEqual(foreign.body,absent.body);assert.deepEqual(lead.body,absent.body);
  assert.deepEqual(absent.body,{ok:false,code:'NOT_FOUND',detail:null});
  // a labelled synthetic parent in a comparison that is not declared a fixture
  await expectCode(createBody({fixture:false}),400,'QR3_FIXTURE_PARTICIPANT','LABELLED_PARTICIPANT');
  // the read budget: a stored research contract is immutable, so the over-budget refusal is reached on the scripted database (test/qr3-routes.test.js); here the fixture parent is inside it
  const over=await rowsOf("SELECT octet_length(contract::text) AS n FROM public.quant_jobs WHERE run_id=$1",[f.state.parents[0].run_id]);
  assert.ok(Number(over[0].n)<READ_BUDGET.max_contract_bytes,'the fixture parent is inside the budget: '+over[0].n+' bytes');
  // admission closed by the executor mode: the database refuses a mode change while executors may run, so that refusal is reached on the scripted database (test/qr3-routes.test.js)
  // fail closed without the two closure values
  const saved=deps;
  deps=undefined;
  try{await expectCode(createBody(),409,'QR3_ADMISSION_CLOSED','CREATE_NOT_WIRED');}finally{deps=saved;}
  deps={...saved,datasetDigest:async()=>null};
  try{await expectCode(createBody(),409,'QR3_DATASET_UNAVAILABLE','DIGEST');}finally{deps=saved;}
  // a bad body never reaches a read
  await expectCode(createBody({confirmed:undefined}),400,'QR3_CONFIRMATION_REQUIRED');
  await expectCode({...createBody(),owner_id:f.owner},400,'INVALID_FIELDS','BODY');
  assert.deepEqual(await everything(),state,'every refusal wrote nothing');
});

test('owner scope on a later participant: participant 1 owned, participant 2 another user\'s REAL run answers the absent 404, and every quant_jobs read carries owner_id=$2',async()=>{
  // a real succeeded run of another user, copied from the fixture parent (same contract, other owner)
  const foreignRun='qr3-foreign-'+randomUUID().slice(0,12);
  await f.db.query(`INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,result,created_at,updated_at,deadline)
    SELECT $2,$3,$3,deployment_id,'qr3-foreign-'||$2,submission_hash,contract_hash,contract,status,result,created_at,updated_at,deadline FROM public.quant_jobs WHERE run_id=$1`,[f.state.parents[0].run_id,foreignRun,intruder]);
  assert.equal((await rowsOf('SELECT owner_id FROM public.quant_jobs WHERE run_id=$1',[foreignRun]))[0].owner_id,intruder,'the foreign run is real and owned by the other user');
  const state=await everything();
  const attempt=async participants=>{
    const probe=spy(f.db),previous=routeStore;
    routeStore={db:probe.db,audit:(...args)=>f.store.audit(...args)};
    try{return {answer:await api(f.owner,'POST',QR3_PATH,createBody({participants})),log:probe.log};}finally{routeStore=previous;}
  };
  const mixed=await attempt([{run_id:f.state.parents[0].run_id},{run_id:foreignRun}]);
  const absent=await attempt([{run_id:f.state.parents[0].run_id},{run_id:randomUUID()}]);
  assert.deepEqual([mixed.answer.status,absent.answer.status],[404,404]);
  assert.deepEqual(mixed.answer.body,absent.answer.body,'a foreign run at position 2 and an absent run are one answer');
  assert.deepEqual(absent.answer.body,{ok:false,code:'NOT_FOUND',detail:null});
  // the statements themselves carry the owner scope, including the read for participant 2 (the owned participant 1 is read as well)
  const reads=mixed.log.filter(entry=>/FROM public\.quant_jobs/.test(entry.text));
  assert.ok(reads.length>=2&&reads.every(entry=>/owner_id=\$2/.test(entry.text)),reads.map(entry=>entry.text.slice(0,120)).join(' | '));
  assert.deepEqual(await everything(),state,'the refusals wrote nothing');
});

test('the exposure register and the comparison tables absent: QR3_EXPOSURE_REGISTER_UNAVAILABLE on create, QR3_SCHEMA_ABSENT on all three actions; both are restored',async()=>{
  const owner=f.owner,view=await completeFixture(2);
  await f.db.query('ALTER TABLE public.quant_exposure_register RENAME TO quant_exposure_register_hidden');
  try{
    const answer=await api(owner,'POST',QR3_PATH,createBody());
    assert.deepEqual([answer.status,answer.body.code],[503,'QR3_EXPOSURE_REGISTER_UNAVAILABLE'],JSON.stringify(answer.body));
  }finally{await f.db.query('ALTER TABLE public.quant_exposure_register_hidden RENAME TO quant_exposure_register');}
  await f.db.query('ALTER TABLE public.quant_comparison_specs RENAME TO quant_comparison_specs_hidden');
  try{
    for(const [method,path,body] of [['POST',QR3_PATH,createBody()],['GET',QR3_PATH+'/'+view.id],['POST',QR3_PATH+'/'+view.id+'/cancel',{}]]){
      const answer=await api(owner,method,path,body);
      assert.deepEqual([answer.status,answer.body.code],[503,'QR3_SCHEMA_ABSENT'],method+' '+path);
    }
  }finally{await f.db.query('ALTER TABLE public.quant_comparison_specs_hidden RENAME TO quant_comparison_specs');}
  assert.equal((await api(owner,'GET',QR3_PATH+'/'+view.id)).status,200);
});

/* ---- 1b. SB191 slice A: independence facts frozen at create ---- */

const readOnlyTx=work=>f.db.transaction(async()=>{await f.db.query('SET TRANSACTION READ ONLY');return work();},{isolation:'REPEATABLE READ'});
let runSerial=0;
/** A labelled library-like run row of an owner (same source by default): the contract fields the independence scans read, result.holdout_evaluated as given. */
async function addRun(owner,name,{start,validation_end=50,test_end=150,market=MARKET,holdout=true,mode,split,source=f.c.source_hash,bot=owner}){
  const contract={version:'ql3a-research-job-v2',...(mode?{mode}:{}),source_hash:source,snapshot:{market},split:split===undefined?{validation_end,test_end}:split,dataset:{start_time:start}};
  const at=Date.now()-1000000+(runSerial+=1);
  await f.db.query("INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'FAILED',$9,$9,$10,$11)",
    [name,owner,bot,f.state.parents[0].deployment_id,'ind:'+name,hash('submission'),hash('contract '+name),JSON.stringify(contract),at,at+900000,JSON.stringify({holdout_evaluated:holdout})]);
}
const frozenOf=async id=>(await rowsOf('SELECT participant_id,freeze_canonical FROM public.quant_comparison_participants WHERE comparison_id=$1 ORDER BY position',[id])).map(row=>({participant_id:row.participant_id,freeze:JSON.parse(row.freeze_canonical)}));

test('SB191 slice A on the real cluster: create freezes the earlier holdouts, searched windows, registered boundary and G1 to G8 snapshot of every participant; the view shows them unchanged',async()=>{
  const owner=f.owner,W=f.registration.window,m=MINUTE,parents=f.state.parents.map(row=>row.run_id);
  // a baseline create: the two fixture parents only (their windows are far from the period); the boundary table is not installed yet, so the boundary is UNAVAILABLE
  assert.equal((await rowsOf("SELECT to_regclass('public.quant_holdout_boundaries') AS t"))[0].t,null);
  const base=await api(owner,'POST',QR3_PATH,createBody());
  assert.equal(base.status,201,JSON.stringify(base.body));
  const baseBlocks=(await frozenOf(base.body.comparison_id)).map(item=>independenceOf(item.freeze,{boundary:{state:'UNAVAILABLE'}}));
  for(const block of baseBlocks){
    assert.deepEqual([block.earlier_holdouts,block.searched_windows],[[],[]]);
    assert.ok(block.scanned.holdout_rows>=2&&block.scanned.searched_rows>=2,'the two parents are scanned');
  }
  // the gate snapshot is the library's own G1 to G8 of the run, read in the same snapshot
  const direct=await readOnlyTx(()=>gateSnapshot(f.db,owner,parents[0]));
  const frozenFirst=(await frozenOf(base.body.comparison_id)).find(item=>item.participant_id===parents[0]);
  assert.deepEqual(frozenFirst.freeze.independence.library_gates,direct);
  // install the boundary table (exactly the table, its function and its trigger of the preflight schema) and register one Bot boundary
  const preflight=await fs.readFile(new URL('../../src/postgres/quant-preflight-schema.sql',import.meta.url),'utf8'),begin=preflight.indexOf('CREATE TABLE quant_holdout_boundaries('),end='EXECUTE FUNCTION quant_holdout_boundary_write_once();';
  assert.ok(begin>=0&&preflight.indexOf(end)>begin);
  await f.db.transaction(()=>f.db.query(preflight.slice(begin,preflight.indexOf(end)+end.length)));
  const boundary=W.start_ms-5000*m;
  await f.db.query('INSERT INTO public.quant_holdout_boundaries(owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8)',
    [owner,'binance-global','SPOT','BTCUSDT','1',boundary,'qr3-test',Date.now()]);
  // earlier runs of the owner: holdout windows (open times S+V*m to S+(T-1)*m) and searched windows (S to S+(V-1)*m), against the period starting at W.start_ms
  const ETH={...MARKET,symbol:'ETHUSDT'},start=W.start_ms-100*m;
  await addRun(owner,'ind-hold-over',{start});                              // holdout [W-50m, W+49m]: overlaps
  await addRun(owner,'ind-hold-touch',{start,test_end:100});                // holdout [W-50m, W-1m]: touches the period, no overlap
  await addRun(owner,'ind-hold-one',{start,test_end:101});                  // holdout [W-50m, W]: one minute of overlap
  await addRun(owner,'ind-hold-eth',{start,market:ETH});                    // other market: skipped
  await addRun(owner,'ind-hold-no',{start,holdout:false});                  // no holdout evaluated: not an earlier holdout
  await addRun(owner,'ind-hold-fixed',{start,mode:'FIXED_INPUT_EVAL'});     // a fixed evaluation is never a search or a holdout
  await addRun(owner,'ind-search-over',{start:W.start_ms-10*m,validation_end:100,test_end:120,holdout:false}); // searched [W-10m, W+89m]
  await addRun(owner,'ind-search-other',{start:W.start_ms-10*m,validation_end:100,test_end:120,holdout:false,source:hash('another source')}); // other source: not listed
  await addRun(intruder,'ind-foreign',{start});                             // another owner: never read
  const answer=await api(owner,'POST',QR3_PATH,createBody());
  assert.equal(answer.status,201,JSON.stringify(answer.body));
  const id=answer.body.comparison_id,stored=await frozenOf(id);
  const over={start_ms:W.start_ms-50*m,end_ms:W.start_ms+50*m},one={start_ms:W.start_ms-50*m,end_ms:W.start_ms+m};
  for(const [index,item] of stored.entries()){
    const block=independenceOf(item.freeze,{boundary:{state:'SET',start_ms:boundary}});
    assert.deepEqual(block.earlier_holdouts,[{run_id:'ind-hold-over',window:over},{run_id:'ind-hold-one',window:one}]);
    assert.deepEqual(block.searched_windows,[{run_id:'ind-search-over',window:{start_ms:W.start_ms-10*m,end_ms:W.start_ms+90*m}}]);
    assert.equal(block.scanned.holdout_rows,baseBlocks[index].scanned.holdout_rows+4,'over, touch, one and eth are scanned; the no-holdout, fixed and foreign rows are not');
    assert.equal(block.scanned.searched_rows,baseBlocks[index].scanned.searched_rows+6,'six same-source runs of the owner; the other source, the fixed run and the foreign run are not');
  }
  // the freeze is hash-bound
  const hashes=await rowsOf('SELECT freeze_canonical,freeze_hash FROM public.quant_comparison_participants WHERE comparison_id=$1',[id]);
  assert.ok(hashes.every(row=>hash(row.freeze_canonical)===row.freeze_hash));
  // the view shows the stored block unchanged (read only), the gate snapshot apart
  const before=await everything();
  const seen=await api(owner,'GET',QR3_PATH+'/'+id);
  assert.equal(seen.status,200,JSON.stringify(seen.body));
  for(const item of seen.body.participants){
    const freeze=stored.find(entry=>entry.participant_id===item.participant_id).freeze.independence,{library_gates:gates,...facts}=freeze;
    assert.deepEqual(item.independence,facts);
    assert.deepEqual(item.library_gates,gates);
  }
  assert.deepEqual(await everything(),before,'the view wrote nothing');
});

test('SB191 slice A, real SQL: an unreadable scan row is a null list, an unreadable own holdout is UNAVAILABLE, the boundary follows B0, and the row budget refuses',async()=>{
  const W=f.registration.window,m=MINUTE,start=W.start_ms-100*m,period={start_ms:W.start_ms,end_ms:W.end_ms};
  const fresh=async()=>(await f.store.createUser({email:'ind-'+randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture-hash'})).id;
  const read=(owner,over={})=>readOnlyTx(()=>readIndependence(f.db,{owner_id:owner,run_id:'ind-own-'+owner,bot_id:owner,source_hash:f.c.source_hash,market_key:marketKey(f.c),period,...over}));
  // an unreadable holdout row (no split) of the same market: the holdout list is null; a run of another source is not a searched row
  const a=await fresh();
  await addRun(a,'ind-bad-'+a,{start,split:null,source:hash('elsewhere')});
  let block=(await read(a)).block;
  assert.deepEqual([block.earlier_holdouts,block.searched_windows,block.source_holdout_state],[null,[],'NONE']);
  // the same row with the run's own source and no holdout is an unreadable searched row only
  const b=await fresh();
  await addRun(b,'ind-bad-'+b,{start,split:null,holdout:false});
  block=(await read(b)).block;
  assert.deepEqual([block.earlier_holdouts,block.searched_windows],[[],null]);
  // the own parent holdout cannot be read: UNAVAILABLE, and the own row is not an earlier holdout
  const c=await fresh();
  await addRun(c,'ind-own-'+c,{start,split:null});
  block=(await read(c)).block;
  assert.deepEqual([block.source_holdout_state,block.source_holdout_window,block.earlier_holdouts],['UNAVAILABLE',null,[]]);
  const d=await fresh();
  await addRun(d,'ind-own-'+d,{start});
  block=(await read(d)).block;
  assert.deepEqual([block.source_holdout_state,block.source_holdout_window,block.earlier_holdouts],['SET',{start_ms:W.start_ms-50*m,end_ms:W.start_ms+50*m},[]],'the own holdout never flags itself');
  // SB191 P2: an exposure that overlaps the parent's holdout but not the comparison period is frozen in source_holdout_register; the period-scoped prior list never holds it
  const h=await fresh();
  await addRun(h,'ind-own-'+h,{start});                                               // own holdout [W-50m, W+50m), the period starts at W
  const quiet=await read(h,{period:{start_ms:W.end_ms+500*m,end_ms:W.end_ms+600*m}});  // a period far after the holdout
  assert.deepEqual([quiet.block.source_holdout_state,quiet.block.source_holdout_register],['SET',[]],'a readable empty register is [] with a SET window');
  const exposureWindow={start_ms:W.start_ms-20*m,end_ms:W.start_ms+10*m},selection='sel-'+randomUUID().slice(0,8);
  const appended=await f.db.transaction(()=>appendExposures(f.db,{owner_id:h,...MARKET,events:[{kind:'QR4_SELECTION',window:exposureWindow,selection_id:selection}],now:()=>Date.now()+60000}),{isolation:'SERIALIZABLE'});
  assert.equal(appended.ok,true,JSON.stringify(appended));
  const otherMarket=await f.db.transaction(()=>appendExposures(f.db,{owner_id:h,broker:MARKET.broker,symbol:'ETHUSDT',timeframe:MARKET.timeframe,events:[{kind:'QR4_SELECTION',window:exposureWindow,selection_id:'sel-eth'}]}),{isolation:'SERIALIZABLE'});
  assert.equal(otherMarket.ok,true);
  const outside=await read(h,{period:{start_ms:W.end_ms+500*m,end_ms:W.end_ms+600*m}});
  assert.deepEqual(outside.block.source_holdout_register,[{kind:'QR4_SELECTION',id:selection,window:exposureWindow,at_ms:appended.rows[0].at_ms}],'overlaps the holdout, not the period; the other market is not listed');
  assert.equal(windowsOverlap(exposureWindow,{start_ms:W.end_ms+500*m,end_ms:W.end_ms+600*m}),false);
  assert.deepEqual((await read(c)).block.source_holdout_register,null,'an unreadable own holdout window: null, never []');
  assert.deepEqual((await read(a)).block.source_holdout_register,[],'no own holdout: nothing to overlap');
  // boundary: no row is NONE; the effective boundary is the earliest of the owner's Bots (B0 EFFECTIVE_BOUNDARY_SQL), read for the parent's Bot only
  const e=await fresh(),sibling=await fresh();
  assert.deepEqual((await read(e)).block.registered_boundary,{state:'NONE'});
  const insert=(owner,bot,at)=>f.db.query('INSERT INTO public.quant_holdout_boundaries(owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [owner,bot,'binance-global','SPOT','BTCUSDT','1',at,'qr3-test',Date.now()]);
  await insert(e,e,W.start_ms-1000*m);
  await insert(e,sibling,W.start_ms-3000*m);
  assert.deepEqual((await read(e)).block.registered_boundary,{state:'SET',start_ms:W.start_ms-3000*m});
  assert.deepEqual((await read(e,{bot_id:sibling})).block.registered_boundary,{state:'SET',start_ms:W.start_ms-3000*m});
  assert.deepEqual((await read(e,{bot_id:await fresh()})).block.registered_boundary,{state:'NONE'},'a Bot without its own boundary row has none');
  // budget: three scanned rows with a limit of two refuse, three with a limit of three are read
  const g=await fresh();
  for(const name of ['x1','x2','x3'])await addRun(g,'ind-'+name+'-'+g,{start:W.start_ms-9000*m});
  assert.deepEqual(await read(g,{limit:2}),{ok:false,detail:'INDEPENDENCE_ROWS'});
  assert.equal((await read(g,{limit:3})).ok,true);
  assert.ok(INDEPENDENCE_BUDGET.max_rows_per_scan>=1);
  // the scans write nothing: they run inside a READ ONLY transaction
  const mode=await readOnlyTx(async()=>{await readIndependence(f.db,{owner_id:g,run_id:'none',bot_id:g,source_hash:f.c.source_hash,market_key:marketKey(f.c),period});return (await f.db.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode;});
  assert.equal(mode,'on');
});

/* ---- 2. view ---- */

test('view of a SPEC_FROZEN comparison: spec, statuses and participants, no metric of any kind; READ ONLY, byte-identical rows, no audit',async()=>{
  const created=await api(f.owner,'POST',QR3_PATH,createBody());
  assert.equal(created.status,201);
  const id=created.body.comparison_id,state=await everything();
  const run=spy(f.db);
  const spied={db:run.db,audit:(...args)=>f.store.audit(...args)};
  const previous=routeStore;routeStore=spied;
  let answer;
  try{answer=await api(f.owner,'GET',QR3_PATH+'/'+id);}finally{routeStore=previous;}
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const view=answer.body;
  assert.deepEqual([view.status,view.derived_status,view.results,view.stale],['SPEC_FROZEN',null,null,null]);
  assert.equal(view.comparison.comparison_id,id);
  assert.equal(view.comparison.spec.objective,'qr3-obj-net-return-v1');
  assert.equal(view.comparison.frozen_at_utc,new Date(view.comparison.frozen_at_ms).toISOString());
  assert.deepEqual(view.events.map(item=>[item.seq,item.status]),[[1,'SPEC_FROZEN']]);
  assert.equal(view.participants.length,2);
  assert.ok(view.participants.every(item=>item.compatible===true&&item.context&&item.subject&&Array.isArray(item.prior_exposed_by)));
  assert.deepEqual(view.context_mismatches,[]);
  assert.equal(view.notices.length,2);
  const {spec:_spec,...comparisonRest}=view.comparison;
  const shown=JSON.stringify({...view,comparison:comparisonRest,notices:[]});
  assert.equal(/net_return|drawdown|total_fees|total_slippage|exposure_percent|winner|rank/i.test(shown),false,'no metric and no rank before the results exist: '+(shown.match(/.{30}(net_return|drawdown|total_fees|total_slippage|exposure_percent|winner|rank).{30}/i)?.[0]));
  // read only proof: every statement is a read; every read after the first is inside a READ ONLY transaction; rows are byte-identical; no audit row was added
  assert.ok(run.log.length>0);
  for(const entry of run.log){
    assert.equal(/^(INSERT|UPDATE|DELETE|LOCK|ALTER|DROP|CREATE)/i.test(entry.text),false,entry.text.slice(0,80));
    if(/^(SELECT|WITH)/i.test(entry.text))assert.equal(entry.readOnly,true,entry.text.slice(0,100));
  }
  assert.deepEqual(await everything(),state);
});

test('view of a COMPLETE comparison: stored results in the contract shape, no rank, the no-winner text, hidden metrics of the excluded participant, null shows its reason',async()=>{
  const c=await completeFixture(4);
  const state=await everything();
  const answer=await api(f.owner,'GET',QR3_PATH+'/'+c.id);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const view=answer.body;
  assert.deepEqual([view.status,view.derived_status],['COMPLETE',null]);
  assert.deepEqual(view.events.map(item=>item.status),['SPEC_FROZEN','EVALUATING','COMPLETE']);
  const results=view.results;
  assert.deepEqual([results.outcome.outcome,results.outcome.outcome_hash,results.qualified_recommendations],['NO_QUALIFIED_RESULT',c.outcome_hash,NO_WINNER_TEXT]);
  assert.deepEqual(results.outcome.limitations,['VALUATION_BASIS_UNCONFIRMED']);
  assert.equal(results.participants.length,4);
  const byId=Object.fromEntries(results.participants.map(item=>[item.participant_id,item]));
  for(const [index,id] of c.ids.entries()){
    const item=byId[id];
    if(index<3){
      assert.equal(item.status,'DEVELOPMENT_EVIDENCE');
      assert.deepEqual(item.metrics.net_return_percent,{value:String(index+1)+'.5',reason:null});
      assert.deepEqual(item.metrics.total_slippage,{value:'0.75',reason:null});
      assert.deepEqual(item.metrics.completed_episodes,{value:index+1,reason:null});
      assert.equal(item.excess_over_benchmark.value!==null,true);
      assert.equal(item.evaluation_run_id,'fx-run-'+index);
    }else{
      assert.deepEqual([item.status,item.metrics,item.metrics_hidden,item.primary_metric,item.excess_over_benchmark],['EXCLUDED_INCOMPATIBLE',null,true,null,null]);
    }
    assert.deepEqual([item.rank,item.label],[null,null],'no rank and no label for a participant that is not ELIGIBLE_QUALIFIED');
  }
  assert.deepEqual([results.benchmark.benchmark_id,results.benchmark.ok,results.benchmark.net_return_percent],['qr3-bh-close-same-cost-v1',true,{value:'1.25',reason:null}]);
  assert.deepEqual(await everything(),state,'the view wrote nothing');
  // a null shows its reason and never 0
  const gap=await completeFixture(3,{omit:'max_drawdown_percent'});
  const missing=(await api(f.owner,'GET',QR3_PATH+'/'+gap.id)).body.results.participants.find(item=>item.participant_id===gap.ids[0]);
  assert.deepEqual([missing.metrics.max_drawdown_percent,missing.metrics.net_return_percent.reason],[{value:null,reason:'METRIC_NOT_RECORDED'},null]);
  // the contract view rules (11.2) hold on the shape the route returns
  const checked=validateComparisonView({mode:view.comparison.mode,lifecycle:view.status,outcome:results.outcome.outcome,context_keys:[...new Set(view.participants.map(item=>item.context_key))],
    participants:results.participants.map(item=>({id:item.participant_id,created_at_ms:item.created_at_ms??0,mode:view.comparison.mode,status:item.status,rank:item.rank,label:item.label,highlight:false,
      metrics:item.metrics})),claim_texts:[results.qualified_recommendations]});
  assert.deepEqual(checked,{ok:true,violations:[]});
});

test('STALE is derived at read: a REPLAY_MISMATCH event shows the first differing code and the stored numbers are not rewritten',async()=>{
  const c=await completeFixture(3);
  const before=(await api(f.owner,'GET',QR3_PATH+'/'+c.id)).body;
  assert.equal(before.derived_status,null);
  const replay=await writeReplayEvent(f.db,{owner_id:f.owner,comparison_id:c.id,kind:'REPLAY_MISMATCH',prior_outcome_hash:c.outcome_hash,replay_outcome_hash:hash('another outcome'),first_differing_code:'QR3_NOT_QUALIFIED'});
  assert.equal(replay.ok,true,JSON.stringify(replay));
  const stale=(await api(f.owner,'GET',QR3_PATH+'/'+c.id)).body;
  assert.deepEqual([stale.derived_status,stale.stale],['STALE',{first_differing_code:'QR3_NOT_QUALIFIED',detail:null}]);
  assert.deepEqual([stale.results.outcome.outcome_hash,stale.results.participants],[before.results.outcome.outcome_hash,before.results.participants]);
  assert.equal(stale.results.replay_events.length,1);
});

test('foreign and absent comparison ids answer one 404 on view and cancel, with no row written and no audit',async()=>{
  const c=await completeFixture(2);
  const state=await everything();
  const answers=[];
  for(const [user,id] of [[intruder,c.id],[f.owner,randomUUID()],[f.owner,'bad id%20x'],[intruder,randomUUID()]]){
    answers.push(await api(user,'GET',QR3_PATH+'/'+id),await api(user,'POST',QR3_PATH+'/'+id+'/cancel',{}));
  }
  for(const answer of answers)assert.deepEqual([answer.status,answer.body],[404,{ok:false,code:'NOT_FOUND',detail:null}]);
  assert.deepEqual(await everything(),state);
  assert.equal((await audits(intruder,QR3_CANCEL_EVENT)).length,0);
});

/* ---- 3. cancel ---- */

test('cancel of an EVALUATING comparison: CANCELLED, exposure events stay, every fixed-evaluation fence refuses, one audit row; a second cancel is QR3_NOT_CANCELLABLE with no audit',async()=>{
  const created=await api(f.owner,'POST',QR3_PATH,createBody());
  const id=created.body.comparison_id,runs={};
  for(const [index,row] of f.state.parents.entries()){
    const job=await f.service.enqueue(f.owner,{purpose:'QR3_COMPARISON',object_id:id,participant_id:row.run_id},'pg_qr3_cancel_'+index+'_'+randomUUID().slice(0,10));
    runs[row.run_id]=job.run_id;
    await f.db.query("UPDATE public.quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[job.run_id]);
  }
  assert.deepEqual((await events(id)).map(item=>item[1]),['SPEC_FROZEN','EVALUATING']);
  const exposure=await countOf('quant_exposure_register',id);
  const jobs=(await rowsOf('SELECT run_id,status,contract_hash,updated_at FROM public.quant_jobs WHERE run_id=ANY($1::text[]) ORDER BY run_id',[Object.values(runs)]));
  const done=await api(f.owner,'POST',QR3_PATH+'/'+id+'/cancel',{});
  assert.deepEqual([done.status,done.body.ok,done.body.status,done.body.seq,done.body.exposure_events],[200,true,'CANCELLED',3,'KEPT']);
  assert.deepEqual((await events(id)).map(item=>item[1]),['SPEC_FROZEN','EVALUATING','CANCELLED']);
  assert.equal(await countOf('quant_exposure_register',id),exposure,'exposure events already written stay (RC-C32)');
  for(const action of ['CLAIM','RUN','COMMIT'])for(const [parent,run] of Object.entries(runs)){
    await assert.rejects(serial(()=>f.service.authorize(f.owner,{purpose:'QR3_COMPARISON',object_id:id,participant_id:parent},action,{run_id:run})),{code:'FIXED_EVAL_OBJECT_NOT_EVALUATING'});
  }
  assert.deepEqual(await rowsOf('SELECT run_id,status,contract_hash,updated_at FROM public.quant_jobs WHERE run_id=ANY($1::text[]) ORDER BY run_id',[Object.values(runs)]),jobs,'the cancel touched no job row');
  const rows=(await audits(f.owner,QR3_CANCEL_EVENT)).filter(row=>row.details.comparison_id===id);
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].details,{comparison_id:id,status:'CANCELLED',seq:3,outcome:'CANCELLED'});
  const again=await api(f.owner,'POST',QR3_PATH+'/'+id+'/cancel',{});
  assert.deepEqual([again.status,again.body],[409,{ok:false,code:'QR3_NOT_CANCELLABLE',detail:null}]);
  assert.equal((await audits(f.owner,QR3_CANCEL_EVENT)).filter(row=>row.details.comparison_id===id).length,1);
  // a COMPLETE comparison is not cancellable either
  const complete=await completeFixture(2);
  assert.equal((await api(f.owner,'POST',QR3_PATH+'/'+complete.id+'/cancel',{})).body.code,'QR3_NOT_CANCELLABLE');
  // the view of the cancelled comparison shows no metric (F8)
  const view=(await api(f.owner,'GET',QR3_PATH+'/'+id)).body;
  assert.deepEqual([view.status,view.results],['CANCELLED',null]);
});

/* ---- 4. read budget evidence (RR-5) ---- */

test('RD-6 / RR-5 evidence: GET p95 at most 300 ms over 50 sequential reads after 5 warm-up reads, 4 participants, COMPLETE fixture outcome, local throwaway cluster',async t=>{
  const c=await completeFixture(4);
  assert.equal(c.ids.length,4);
  for(let index=0;index<5;index++)assert.equal((await api(f.owner,'GET',QR3_PATH+'/'+c.id)).status,200);
  const samples=[];
  for(let index=0;index<50;index++){
    const started=performance.now();
    const answer=await api(f.owner,'GET',QR3_PATH+'/'+c.id);
    samples.push(performance.now()-started);
    assert.equal(answer.status,200);
  }
  const sorted=[...samples].sort((a,b)=>a-b);
  const p95=sorted[Math.ceil(0.95*sorted.length)-1],p50=sorted[Math.ceil(0.5*sorted.length)-1];
  const evidence={rr:'RR-5',reads:50,warmup:5,participants:4,outcome:'COMPLETE fixture outcome',p50_ms:Number(p50.toFixed(2)),p95_ms:Number(p95.toFixed(2)),max_ms:Number(sorted.at(-1).toFixed(2)),budget_ms:300,
    path:'in-process real dispatcher and real store over loopback HTTP, local throwaway cluster',at:new Date().toISOString()};
  t.diagnostic('read latency '+JSON.stringify(evidence));
  console.log('QR3_READ_P95 '+JSON.stringify(evidence));
  if(process.env.QR3_P95_EVIDENCE_FILE)await fs.writeFile(process.env.QR3_P95_EVIDENCE_FILE,JSON.stringify(evidence)+'\n');
  assert.ok(p95<=300,'p95 '+p95.toFixed(1)+' ms is over the 300 ms read budget');
});

/* ---- 5. the real application server: flag, session, CSRF, owner scope ---- */

async function startServer({enabled}){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,NODE_OPTIONS:'',NODE_ENV:'test',DATABASE_URL:f.connectionString,HOST:'127.0.0.1',PORT:String(port),
    PUBLIC_ORIGIN:origin,SMTP_HOST:'',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'0',PINE_CAPTURE_ENABLED:'0',QUANT_RESEARCH_ENABLED:'0',QUANT_RESEARCH_FOUNDATION_ENABLED:'0',
    QUANT_PREFLIGHT_ENABLED:'0',MARKET_PUBLIC_PROXY:'0',QR2_PERFORMANCE_ENABLED:'',QR3_COMPARISON_ENABLED:enabled?'1':''}});
  let output='',exited=false;
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  let ready=false;
  for(let index=0;index<200&&!exited;index++){
    try{ready=(await fetch(origin+'/api/auth/config')).ok;}catch{}
    if(ready)break;await delay(50);
  }
  if(!ready){child.kill('SIGTERM');throw Error('server did not start: '+output.slice(-800));}
  const request=httpClient(origin);
  const login=async(email)=>{const answer=await request('/api/auth/login','POST',{email,password:PASSWORD});assert.equal(answer.status,200,JSON.stringify(answer.body));return answer.session;};
  const close=async()=>{if(!exited){child.kill('SIGTERM');await Promise.race([exit,delay(5000).then(()=>{if(!exited)child.kill('SIGKILL');})]);await exit;}};
  return {request,login,close,pid:child.pid,output:()=>output};
}
async function accounts(){
  const hashed=await hashPassword(PASSWORD);
  const ownerEmail=(await rowsOf('SELECT email FROM public.users WHERE id=$1',[f.owner]))[0].email;
  await f.db.query('UPDATE public.users SET password_hash=$2 WHERE id=$1',[f.owner,hashed]);
  await f.db.query('UPDATE public.users SET password_hash=$2 WHERE id=$1',[intruder,hashed]);
  const intruderEmail=(await rowsOf('SELECT email FROM public.users WHERE id=$1',[intruder]))[0].email;
  return {ownerEmail,intruderEmail};
}

test('real server, flag off: every path and method answers 404 and nothing is created',async()=>{
  const {ownerEmail}=await accounts();
  const c=await completeFixture(2);
  const app=await startServer({enabled:false});
  try{
    const session=await app.login(ownerEmail),state=await everything();
    for(const [method,path,body] of [['GET',QR3_PATH+'/'+c.id],['POST',QR3_PATH,createBody()],['POST',QR3_PATH+'/'+c.id+'/cancel',{}],['GET',QR3_PATH],['POST',QR3_PATH+'/'+c.id+'/replay',{}]]){
      const answer=await app.request(path,method,body,session);
      assert.equal(answer.status,404,method+' '+path+' '+JSON.stringify(answer.body));
    }
    assert.deepEqual(withoutAudit(await everything()),withoutAudit(state));
    assert.equal((await rowsOf('SELECT status FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq DESC LIMIT 1',[c.id]))[0].status,'COMPLETE');
  }finally{await app.close();}
});

test('real server, flag on: session, canonical CSRF, owner scope, wired create (L8-W), view, cancel, replay and audit',async()=>{
  const {ownerEmail,intruderEmail}=await accounts();
  const c=await completeFixture(2);
  const open=await api(f.owner,'POST',QR3_PATH,createBody());
  const openId=open.body.comparison_id;
  const app=await startServer({enabled:true});
  try{
    const session=await app.login(ownerEmail),other=await app.login(intruderEmail);
    // no session: 401, nothing read
    assert.equal((await app.request(QR3_PATH+'/'+c.id,'GET',undefined,{cookie:{},csrf:''})).status,401);
    assert.equal((await app.request(QR3_PATH,'POST',createBody(),{cookie:{},csrf:''})).status,401);
    // CSRF on both POST routes: a missing or forged token is refused by the canonical auth before anything is written
    const state=await everything();
    for(const csrf of ['','not-the-token']){
      const bad={cookie:{...session.cookie},csrf};
      assert.equal((await app.request(QR3_PATH,'POST',createBody(),bad)).status,403);
      assert.equal((await app.request(QR3_PATH+'/'+openId+'/cancel','POST',{},bad)).status,403);
      assert.equal((await app.request(QR3_PATH+'/'+c.id+'/replay','POST',{confirmed:true},bad)).status,403);
    }
    assert.deepEqual(withoutAudit(await everything()),withoutAudit(state));
    // GET needs no token and returns the owner's view
    const view=await app.request(QR3_PATH+'/'+c.id,'GET',undefined,session);
    assert.deepEqual([view.status,view.body.status,view.body.results.outcome.outcome],[200,'COMPLETE','NO_QUALIFIED_RESULT']);
    assert.equal(JSON.stringify(view.body).includes(f.owner),false,'the owner id is not echoed');
    // owner scope: another owner's session sees a 404, equal to the absent answer, for view and cancel; the comparison is unchanged
    const foreign=[await app.request(QR3_PATH+'/'+c.id,'GET',undefined,other),await app.request(QR3_PATH+'/'+openId+'/cancel','POST',{},other)];
    const absent=[await app.request(QR3_PATH+'/'+randomUUID(),'GET',undefined,other),await app.request(QR3_PATH+'/'+randomUUID()+'/cancel','POST',{},other)];
    for(const answer of [...foreign,...absent])assert.deepEqual([answer.status,answer.body],[404,{ok:false,code:'NOT_FOUND',detail:null}]);
    assert.deepEqual((await events(openId)).map(item=>item[1]),['SPEC_FROZEN']);
    // create over the real server, now wired (L8-W): foreign participants are the absent 404; the owner's create freezes the live engine hash and the real dataset digest
    const stranger=await app.request(QR3_PATH,'POST',createBody(),other);
    assert.deepEqual([stranger.status,stranger.body],[404,{ok:false,code:'NOT_FOUND',detail:null}],'nothing about the foreign runs is revealed');
    const wired=await app.request(QR3_PATH,'POST',createBody(),session);
    assert.deepEqual([wired.status,wired.body.status,wired.body.evaluation_started],[201,'SPEC_FROZEN',false],JSON.stringify(wired.body));
    const frozen=JSON.parse((await rowsOf('SELECT freeze_canonical FROM public.quant_comparison_participants WHERE comparison_id=$1 AND position=1',[wired.body.comparison_id]))[0].freeze_canonical);
    assert.deepEqual([frozen.context.engine,frozen.context.dataset.digest],[f.context.engine,f.freeze.dataset_hash]);
    // a pure refusal and the method and path gate
    assert.equal((await app.request(QR3_PATH,'POST',createBody({confirmed:undefined}),session)).body.code,'QR3_CONFIRMATION_REQUIRED');
    assert.equal((await app.request(QR3_PATH+'/'+openId,'POST',{},session)).status,405);
    // replay (RR-12): confirm token, COMPLETE only, owner scope; this COMPLETE fixture has no stored fixed runs, so the record replay is REPRODUCTION_DISABLED
    assert.equal((await app.request(QR3_PATH+'/'+openId+'/replay','POST',{},session)).body.code,'QR3_CONFIRMATION_REQUIRED');
    const notComplete=await app.request(QR3_PATH+'/'+openId+'/replay','POST',{confirmed:true},session);
    assert.deepEqual([notComplete.status,notComplete.body.code,notComplete.body.detail],[409,'QR3_ADMISSION_CLOSED','REPLAY_NOT_COMPLETE']);
    assert.deepEqual([(await app.request(QR3_PATH+'/'+c.id+'/replay','POST',{confirmed:true},other)).status],[404]);
    const replayed=await app.request(QR3_PATH+'/'+c.id+'/replay','POST',{confirmed:true},session);
    assert.deepEqual([replayed.status,replayed.body.kind,replayed.body.outcome_unchanged],[200,'REPRODUCTION_DISABLED',true],JSON.stringify(replayed.body));
    assert.equal((await audits(f.owner,'qr3.comparison_replay_requested')).filter(row=>row.details.comparison_id===c.id).length,1);
    assert.equal(await countOf('quant_comparison_replay_events',c.id),1);
    assert.equal((await app.request(QR3_PATH+'?user_id='+intruder,'POST',createBody(),session)).body.detail,'QUERY');
    assert.equal((await app.request(QR3_PATH+'/'+c.id+'?user_id='+intruder,'GET',undefined,session)).body.detail,'QUERY');
    // cancel with the token: CANCELLED, one audit row, exposure events stay; a second cancel is refused
    const exposure=await countOf('quant_exposure_register',openId);
    const done=await app.request(QR3_PATH+'/'+openId+'/cancel','POST',{},session);
    assert.deepEqual([done.status,done.body.status],[200,'CANCELLED']);
    assert.equal(await countOf('quant_exposure_register',openId),exposure);
    assert.equal((await audits(f.owner,QR3_CANCEL_EVENT)).filter(row=>row.details.comparison_id===openId).length,1);
    assert.equal((await app.request(QR3_PATH+'/'+openId+'/cancel','POST',{},session)).body.code,'QR3_NOT_CANCELLABLE');
  }finally{await app.close();}
});

test('contract 9.1 on the real database: the codes only the store or the database reach are reached here',()=>{
  for(const code of PG_ONLY)assert.ok(REFUSAL_CODES.includes(code),code);
  const missing=PG_ONLY.filter(code=>!reached.has(code));
  assert.deepEqual(missing,[]);
});
