import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {QuantFixedEvalService} from '../../src/postgres/quant-fixed-eval.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {fixedEvalEngineHash} from '../../src/postgres/quant-fixed-eval-engine.js';
import {datasetBindingIdentity} from '../../src/quant-research/research-contract-v2.js';
import {expectedFoundationRequestV2} from '../../src/quant-research/research-contract-v2.js';
import {qr3Routes,QR3_PATH,QR3_REPLAY_EVENT} from '../../src/postgres/qr3-routes.js';
import {createComparison,readComparison,readComparisonResults,cancelComparison} from '../../src/postgres/comparison-store.js';
import {Qr3EvaluationDriver,createQr3ApiDeps,createFinalizerDeps,replayComparison,admissionKey,ADMISSION_REFUSED_REASON} from '../../src/postgres/qr3-comparison-wiring.js';
import {contextFields,contextKey} from '../../src/comparison/context.js';
import {validateSpec,specHashOf} from '../../src/comparison/ranking.js';
import {CODES} from '../../src/comparison/common.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

// L8-W end to end on a real PostgreSQL cluster (owner GO OG-1; Root rulings SB180 RR-2, RR-3 and SB184 RR-10, RR-11, RR-12). The comparison is created through the
// wired owner API (real engine hash and real dataset digest), the REAL driver admits one fixed run per participant through the REAL fixed-evaluation service, the
// REAL foundation worker runs base and stress with the actual Python evaluator (an injected bounded subprocess supervisor, not native systemd/QS-1 evidence),
// and the REAL finalizer, store and record replay finish the comparison. Every parent run and every bar is a LABELLED SYNTHETIC FIXTURE of the FE-2b fixture;
// nothing here is a research result. The worker main itself is not started (it requires Linux and the Paper staging environment); its flag gate is pinned
// statically in test/qr3-wiring-static.test.js. One file per process, one cluster.
const MINUTE=60000;
let f,worker,api,directory,stopped=new Set(),pythonCalls=[],extraParents=[];
const logs=[];
const log=event=>logs.push(event);

/* ---- the real worker with the actual Python evaluator ---- */

/** Actual bounded Python subprocess (the pattern of test/postgres/quant-fixed-eval-worker.test.mjs). This injected test supervisor is not native QS/systemd evidence. */
function pythonSupervisor(){
  return ({payload,module,signal,unitName,timeoutMs})=>new Promise((resolve,reject)=>{
    assert.equal(module,'robot_quant.fixed_eval_job');pythonCalls.push(payload.kind);
    const repo=fileURLToPath(new URL('../../',import.meta.url));
    const python=process.env.QUANT_RESEARCH_PYTHON??path.join(repo,'quant_lab/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    assert.ok(path.isAbsolute(python)&&existsSync(python),'Actual Python evidence requires the configured interpreter or repository virtual environment');
    const child=spawn(python,['-m',module],{cwd:repo,env:{...process.env,PYTHONPATH:path.join(repo,'quant_lab/src')},stdio:['pipe','pipe','pipe']});
    let output='',reason=null,settled=false;
    const abort=()=>{reason='RESEARCH_INTERRUPTED';child.kill('SIGKILL');};
    const timer=setTimeout(()=>{reason='EVALUATION_TIMED_OUT';child.kill('SIGKILL');},Math.min(timeoutMs,30000));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.on('data',bytes=>{output+=bytes;if(Buffer.byteLength(output)>8*1024*1024){reason='EVALUATION_OUTPUT_TOO_LARGE';child.kill('SIGKILL');}});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>{reason='QUANT_PYTHON_UNAVAILABLE';});
    child.on('close',code=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);stopped.add(unitName);
      if(reason||code!==0){reject(Object.assign(Error(reason??'EVALUATION_FAILED'),{code:reason??'EVALUATION_FAILED',stopped:true}));return;}
      try{resolve(JSON.parse(output));}catch{reject(Object.assign(Error('INVALID_EVALUATION_RESPONSE'),{code:'INVALID_EVALUATION_RESPONSE',stopped:true}));}
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
/** Claims and runs every queued fixed job, one at a time (the single heavy executor). Returns the run ids it finished. */
async function runQueued(){
  const done=[];
  for(;;){
    const job=await worker.claim();
    if(!job)return done;
    assert.equal(job.kind,'FIXED_EVAL');
    await worker.run(job);done.push(job.run_id);
  }
}

/* ---- the wired owner API, called as the dispatcher does (phase one, then the deferred phase after COMMIT) ---- */

async function route(method,pathName,body){
  const req=Readable.from([Buffer.from(JSON.stringify(body??{}))]);req.method=method;req.headers={};
  const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null};
  const json=(target,status,value)=>{target.phase2Result={status,body:value};};
  const handled=await qr3Routes(req,res,new URL(pathName,'http://localhost'),{id:f.owner},{store:f.store,auth:{require:async()=>({id:f.owner})},json,enabled:true,deps:api});
  assert.equal(handled,true);
  return typeof res.phase2Deferred==='function'?res.phase2Deferred():res.phase2Result;
}
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const createBody=ids=>{
  const w=f.registration.window;
  return {confirmed:true,request_key:'e2e-'+randomUUID(),fixture:true,mode:'STANDARDIZED',participants:ids.map(run_id=>({run_id})),market:MARKET,cost_model_version:'paper-close-v1',
    period:{choice:'CUSTOM',start_ms:w.start_ms,end_ms:w.end_ms},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}};
};
async function createViaApi(ids){
  const answer=await route('POST',QR3_PATH,createBody(ids));
  assert.equal(answer.status,201,JSON.stringify(answer.body));
  return answer.body.comparison_id;
}
/** A comparison created through the store directly with a chosen engine hash in every frozen context (for the old-hash cases). */
async function createWithEngine(engine,ids=participants(2)){
  const w=f.registration.window;
  const spec=validateSpec({mode:'STANDARDIZED',participants:ids,period:{start_ms:w.start_ms,end_ms:w.end_ms},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}}).spec;
  const context=structuredClone(f.context);
  Object.assign(context,{engine,spec_hash:specHashOf(spec)});context.dataset.digest=f.freeze.dataset_hash;
  const {fixedEvalComparisonProtocolHash}=await import('../../src/postgres/quant-fixed-eval.js');
  context.validation_protocol=fixedEvalComparisonProtocolHash(f.c,spec);
  const fields=contextFields(ids[0],context).fields,key=contextKey(fields);
  const created=await createComparison(f.db,{owner_id:f.owner,fixture:true,market:f.c.snapshot.market,spec,spec_hash:specHashOf(spec),context_key:key,request_key:'e2e-old-'+randomUUID(),
    participants:ids.map((id,index)=>({participant_id:id,position:index+1,source_hash:f.c.source_hash,origin:'FIXTURE',fixture:true,context_key:key,freeze:{context:structuredClone(fields)}}))});
  assert.equal(created.ok,true,JSON.stringify(created));
  return created.comparison_id;
}

/* ---- observation ---- */

const rowsOf=async(sql,params=[])=>(await f.db.query(sql,params)).rows;
const events=async id=>(await rowsOf('SELECT seq,status,reason_code FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq',[id])).map(row=>[Number(row.seq),row.status,row.reason_code]);
const statusOf=async id=>(await events(id)).at(-1);
const runsOf=async id=>rowsOf(`SELECT run_id,status,contract#>>'{lineage,parent_run_id}' AS participant_id,idempotency_key,contract_hash FROM public.quant_jobs
  WHERE contract->>'mode'='FIXED_INPUT_EVAL' AND contract#>>'{lineage,object_id}'=$1 ORDER BY 3`,[id]);
const fixedJobCount=async()=>(await rowsOf("SELECT count(*)::int n FROM public.quant_jobs WHERE contract->>'mode'='FIXED_INPUT_EVAL'"))[0].n;
const digest=async table=>(await rowsOf(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`))[0];
const RESEARCH=['users','quant_jobs','quant_job_steps','quant_research_chunks','quant_research_foundation','quant_foundation_jobs','pine_market_bars','quant_exposure_register',
  'quant_comparison_specs','quant_comparison_participants','quant_comparison_status_events','quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes'];
const research=async()=>Object.fromEntries(await Promise.all(RESEARCH.map(async table=>[table,await digest(table)])));
const participants=n=>[...f.state.parents.map(row=>row.run_id),...extraParents].slice(0,n);
const driverOf=(options={})=>new Qr3EvaluationDriver({fixedEvalService:f.service,log,...options});
const item=id=>({comparison_id:id,owner_id:f.owner});
/** Ends every open comparison of this file and retires every queued fixed foundation job, so the next test starts with an empty queue. */
async function closeOpen(){
  const open=await rowsOf(`SELECT s.comparison_id FROM public.quant_comparison_specs s WHERE (SELECT status FROM public.quant_comparison_status_events e
    WHERE e.comparison_id=s.comparison_id ORDER BY seq DESC LIMIT 1) IN ('SPEC_FROZEN','EVALUATING')`);
  for(const row of open)assert.equal((await cancelComparison(f.db,{owner_id:f.owner,comparison_id:row.comparison_id})).ok,true);
  await f.db.query("UPDATE public.quant_foundation_jobs SET status='CANCELLED' WHERE status='QUEUED'");
  assert.equal((await rowsOf("SELECT count(*)::int n FROM public.quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')"))[0].n,0,'no running job is left behind');
}

/** Two more labelled synthetic parents, inserted exactly as the fixture inserts its own two (so 4-participant comparisons exist). */
async function addParents(count){
  for(let index=0;index<count;index++){
    const parent={...structuredClone(f.parent),run_id:randomUUID()},now=parent.updated_at,request=expectedFoundationRequestV2(f.c,900000);
    await f.db.transaction(async()=>{
      await f.db.query("INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline) VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$8,$9)",
        [parent.run_id,f.owner,f.c.deployment_id,'parent:'+parent.run_id,hash('parent-submission'),parent.contract_hash,JSON.stringify(f.c),now,now+900000]);
      for(const step of f.parentSteps)await f.db.query('INSERT INTO public.quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
        [parent.run_id,step.step_id,step.kind,JSON.stringify(step.parameters),JSON.stringify(step.result),step.completed_at]);
      await f.db.query("INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7)",
        [parent.run_id,f.owner,'parent:'+parent.run_id,JSON.stringify(request),hash(canonical(request)),now,now+900000]);
      await f.db.query('INSERT INTO public.quant_research_foundation VALUES($1,$2,$3)',[parent.run_id,parent.run_id,parent.contract_hash]);
      await f.db.query("INSERT INTO public.quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'prepare:dataset','PREPARE',$2,$3)",
        [parent.run_id,JSON.stringify(f.parentBinding),datasetBindingIdentity(f.c,f.parentBinding)]);
      await f.db.query("UPDATE public.quant_jobs SET status='SUCCEEDED',phase='COMPLETE',result=$2 WHERE run_id=$1",[parent.run_id,JSON.stringify(parent.result)]);
    });
    extraParents.push(parent.run_id);
  }
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL only');
  f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
  assert.equal(f.context.engine,await fixedEvalEngineHash(),'the fixture freezes the live engine hash');
  await addParents(2);
  // dataset storage: QR3_E2E_DATASET_PARENT lets a local run keep the files inside its own evidence folder; CI uses the system temporary folder
  directory=await fs.mkdtemp(path.join(process.env.QR3_E2E_DATASET_PARENT??os.tmpdir(),'qr3-e2e-'));
  await f.db.query(await fs.readFile(new URL('../../src/postgres/quant-storage-schema.sql',import.meta.url),'utf8'));
  const root=path.join(directory,'datasets');await f.db.transaction(()=>bindQuantStorage(f.db,root));
  const pine=new PineBridgeService(f.store);
  const service={foundation:true,db:f.db,pine,store:f.store,datasetStore:new ResearchDatasetStore({root}),executorMode:async()=>{
    assert.equal((await f.db.query('SELECT mode FROM public.quant_research_executor_mode WHERE singleton')).rows[0]?.mode,'FOUNDATION');
  }};
  worker=new QuantResearchFoundationWorker({service,fixedEvalService:f.service,health:async()=>({ok:true}),supervisor:pythonSupervisor()});
  worker.controller=new AbortController();worker.stopUnit=async unit=>stopped.has(unit);
  // the API dependencies exactly as server.js builds them, with the fixture's fixed-evaluation service (its labelled source hash) for the record replay
  api=createQr3ApiDeps({pineService:pine,fixedEvalService:f.service});
});
after(async()=>{await f?.close();if(directory)await fs.rm(directory,{recursive:true,force:true});});

/* ---- E10, E1: wired create and admission ---- */

test('E10 the wired create freezes the real engine hash and the real dataset digest, which the real admission accepts',async()=>{
  const w=f.registration.window,warmup=1006,first=w.start_ms-warmup*MINUTE+MINUTE,count=(w.end_ms-w.start_ms)/MINUTE+warmup;
  assert.equal(await api.engineHash(),await fixedEvalEngineHash());
  const span=(await rowsOf("SELECT count(*)::int n FROM public.pine_market_bars WHERE bar_time BETWEEN $1 AND $2",[first,w.end_ms]))[0];
  assert.equal(span.n,count);
  const {CONTENT_DIGEST_SQL}=await import('../../src/quant-research/research-contract-v2.js');
  const content=(await rowsOf(CONTENT_DIGEST_SQL,[first,w.end_ms,'closed-ohlcv-atr14-v1']))[0].digest;
  const digest=await f.db.transaction(async()=>{await f.db.query('SET TRANSACTION READ ONLY');
    return api.datasetDigest({db:f.db,first_close_ms:first,last_close_ms:w.end_ms,bar_count:count,data_profile:'closed-ohlcv-atr14-v1',content_digest:content});},{isolation:'REPEATABLE READ'});
  // the restated digest formula equals the immutable fixture authority (the selection freeze uses the worker's own formula)
  assert.equal(digest,f.freeze.dataset_hash);
  // a wrong content digest, a short range or another profile fails closed with null
  for(const input of [{content_digest:hash('other')},{bar_count:count-1,first_close_ms:first+MINUTE},{data_profile:'other-profile'},{last_close_ms:w.end_ms+MINUTE}]){
    const value=await f.db.transaction(async()=>{await f.db.query('SET TRANSACTION READ ONLY');
      return api.datasetDigest({db:f.db,first_close_ms:first,last_close_ms:w.end_ms,bar_count:count,data_profile:'closed-ohlcv-atr14-v1',content_digest:content,...input});},{isolation:'REPEATABLE READ'});
    assert.equal(value,null,JSON.stringify(input));
  }
  const id=await createViaApi(participants(2));
  const stored=await readComparison(f.db,{owner_id:f.owner,comparison_id:id});
  for(const row of stored.participants){
    assert.equal(row.freeze.context.engine,await fixedEvalEngineHash());
    assert.equal(row.freeze.context.dataset.digest,f.freeze.dataset_hash);
  }
  // the real admission accepts the frozen contexts (FES.resolve re-checks every field)
  const summary=await driverOf().drive(item(id));
  assert.deepEqual([summary.result,summary.enqueued.length],['WAITING',2]);
  await closeOpen();
});

test('E1 a driver tick admits exactly one fixed run per participant (2 and 4 participants), idempotently, and moves SPEC_FROZEN to EVALUATING once',async()=>{
  for(const n of [2,4]){
    const id=await createViaApi(participants(n));
    assert.deepEqual(await events(id),[[1,'SPEC_FROZEN',null]]);
    const driver=driverOf();
    const first=await driver.tick();
    const mine=first.find(entry=>entry.comparison_id===id);
    assert.deepEqual([mine.result,mine.enqueued.length],['WAITING',n]);
    let runs=await runsOf(id);
    assert.equal(runs.length,n);
    assert.deepEqual(runs.map(row=>row.participant_id).sort(),participants(n).sort());
    for(const row of runs)assert.equal(row.idempotency_key,'fixed:'+hash(admissionKey(id,row.participant_id)));
    assert.deepEqual(await events(id),[[1,'SPEC_FROZEN',null],[2,'EVALUATING',null]]);
    // repeated ticks, and a new driver (a restart), admit nothing more
    await driver.tick();await driverOf().tick();
    assert.deepEqual((await runsOf(id)).map(row=>row.run_id),runs.map(row=>row.run_id));
    assert.deepEqual(await events(id),[[1,'SPEC_FROZEN',null],[2,'EVALUATING',null]]);
    await closeOpen();
  }
  // a stop between two admissions: one participant admitted by hand with the driver's own key, then the driver completes the rest with the same keys
  const id=await createViaApi(participants(4));
  const [p1]=participants(4);
  const job=await f.service.enqueue(f.owner,{purpose:'QR3_COMPARISON',object_id:id,participant_id:p1},admissionKey(id,p1));
  const summary=await driverOf().drive(item(id));
  assert.deepEqual([summary.result,summary.enqueued.length],['WAITING',3]);
  const runs=await runsOf(id);
  assert.equal(runs.length,4);assert.equal(runs.find(row=>row.participant_id===p1).run_id,job.run_id);
  assert.deepEqual(await events(id),[[1,'SPEC_FROZEN',null],[2,'EVALUATING',null]]);
  await closeOpen();
});

/* ---- E2, E8, E9: the real worker, the finalizer and the record replay ---- */

let complete=null;
test('E2 the real worker runs base and stress for every participant and the driver finalizes to COMPLETE with NO_QUALIFIED_RESULT, basis unconfirmed',async()=>{
  const id=await createViaApi(participants(2));
  const driver=driverOf();
  assert.equal((await driver.drive(item(id))).result,'WAITING');
  pythonCalls=[];
  const ran=await runQueued();
  assert.equal(ran.length,2);
  assert.deepEqual(pythonCalls,['EVALUATION','EVALUATION_STRESS','EVALUATION','EVALUATION_STRESS']);
  for(const row of await runsOf(id))assert.equal(row.status,'SUCCEEDED');
  const before=await research();
  const done=await driver.drive(item(id));
  assert.equal(done.result,'COMPLETE',JSON.stringify({done,logs:logs.slice(-3)}));
  assert.equal((await statusOf(id))[1],'COMPLETE');
  const results=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:id});
  assert.equal(results.outcome.outcome,'NO_QUALIFIED_RESULT');
  assert.equal(results.outcome.only_qualified_participant_id,null);
  assert.deepEqual(results.outcome.record.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
  assert.equal(results.evaluations.length,2);
  for(const view of results.evaluations){
    assert.equal(view.body.basis_confirmed,false);
    assert.equal(view.body.engine_hash,await fixedEvalEngineHash());
    assert.equal(view.body.dataset_sha256,f.freeze.dataset_hash);
    assert.ok(view.body.limitations.includes(CODES.VALUATION_BASIS_UNCONFIRMED));
  }
  // V8 hold: every evaluated participant is development evidence, never ranked or labelled qualified
  for(const entry of results.outcome.record.participants){
    assert.equal(entry.status,'DEVELOPMENT_EVIDENCE');
    assert.ok(entry.reasons.includes(CODES.VALUATION_BASIS_UNCONFIRMED));
    assert.equal(entry.rank??null,null);
  }
  // the finalizer writes only the comparison result rows and the COMPLETE event
  const afterward=await research();
  const changed=RESEARCH.filter(table=>JSON.stringify(before[table])!==JSON.stringify(afterward[table]));
  assert.deepEqual(changed.sort(),['quant_comparison_benchmarks','quant_comparison_evaluations','quant_comparison_outcomes','quant_comparison_status_events']);
  // the view shows the stored outcome
  const view=await route('GET',QR3_PATH+'/'+id);
  assert.deepEqual([view.status,view.body.status,view.body.results.outcome.outcome,view.body.derived_status],[200,'COMPLETE','NO_QUALIFIED_RESULT',null]);
  // a later tick does not touch a COMPLETE comparison
  assert.equal((await driver.tick()).some(entry=>entry.comparison_id===id),false);
  complete={id,outcome_hash:results.outcome.outcome_hash,evaluations:results.evaluations.map(view=>[view.participant_id,view.body_hash]),benchmark:results.benchmark.body_hash};
});

test('E8 E9 record replay: MATCH through the owner route with one audit row and no job; MISMATCH shows STALE; REPRODUCTION_DISABLED; refusals; p95 recorded',async()=>{
  assert.ok(complete,'E2 produced a COMPLETE comparison');
  const id=complete.id,jobs=await fixedJobCount();
  const before=await research();
  const answer=await route('POST',QR3_PATH+'/'+id+'/replay',{confirmed:true});
  assert.deepEqual([answer.status,answer.body.ok,answer.body.kind,answer.body.first_differing_code,answer.body.outcome_unchanged],[200,true,'REPLAY_MATCH',null,true],JSON.stringify(answer.body));
  const audit=await rowsOf('SELECT event,details FROM public.audit WHERE user_id=$1 AND event=$2',[f.owner,QR3_REPLAY_EVENT]);
  assert.equal(audit.length,1);
  assert.deepEqual(JSON.parse(audit[0].details),{comparison_id:id,status:'COMPLETE',kind:'REPLAY_MATCH',first_differing_code:null,outcome:'REPLAYED'});
  // E9: nothing but the replay event was written; no job row
  assert.deepEqual(await research(),before);
  assert.equal(await fixedJobCount(),jobs);
  let results=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:id});
  assert.deepEqual(results.replay_events.map(event=>[event.kind,event.prior_outcome_hash,event.replay_outcome_hash]),[['REPLAY_MATCH',complete.outcome_hash,complete.outcome_hash]]);
  // the replay rebuilt exactly the stored hashes (determinism of the RR-3 inputs)
  assert.deepEqual(results.evaluations.map(view=>[view.participant_id,view.body_hash]),complete.evaluations);
  // MISMATCH: one participant input changed (compatibility) through the same deps; the outcome row never changes and the read shows STALE
  const deps=createFinalizerDeps({fixedEvalService:f.service});
  const changed={...deps,participantInputs:async(...args)=>({...await deps.participantInputs(...args),compatibility:{compatible:false}})};
  const mismatch=await replayComparison(f.db,{owner_id:f.owner,comparison_id:id},changed);
  assert.deepEqual([mismatch.ok,mismatch.kind,mismatch.first_differing_code],[true,'REPLAY_MISMATCH','OUTCOME_MISMATCH']);
  assert.notEqual(mismatch.replay_outcome_hash,complete.outcome_hash);
  const rows=changed.readRows;
  const tampered={...deps,readRows:async(...args)=>{const value=await rows(...args);value[value.length-1]={...value[value.length-1],close:'101'};return value;}};
  const evaluation=await replayComparison(f.db,{owner_id:f.owner,comparison_id:id},tampered);
  assert.deepEqual([evaluation.kind,typeof evaluation.first_differing_code],['REPLAY_MISMATCH','string']);
  assert.notEqual(evaluation.replay_outcome_hash,complete.outcome_hash);
  // REPRODUCTION_DISABLED: a run or its bars cannot be read
  const unreadable=await replayComparison(f.db,{owner_id:f.owner,comparison_id:id},{...deps,readRows:async()=>{throw Object.assign(Error('bars gone'),{code:'VERIFIED_MARKET_DATA_REQUIRED',status:409});}});
  assert.deepEqual([unreadable.kind,unreadable.first_differing_code,unreadable.replay_outcome_hash],['REPRODUCTION_DISABLED',null,null]);
  results=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:id});
  assert.equal(results.outcome.outcome_hash,complete.outcome_hash,'the outcome row never changes');
  assert.deepEqual(results.replay_events.map(event=>event.kind),['REPLAY_MATCH','REPLAY_MISMATCH','REPLAY_MISMATCH','REPRODUCTION_DISABLED']);
  const view=await route('GET',QR3_PATH+'/'+id);
  assert.deepEqual([view.body.status,view.body.derived_status,view.body.stale.first_differing_code,view.body.results.outcome.outcome_hash],['COMPLETE','STALE','OUTCOME_MISMATCH',complete.outcome_hash]);
  // refusals: not COMPLETE, absent, foreign (another owner), busy (single flight)
  const open=await createViaApi(participants(2));
  const notComplete=await route('POST',QR3_PATH+'/'+open+'/replay',{confirmed:true});
  assert.deepEqual([notComplete.status,notComplete.body.code,notComplete.body.detail],[409,'QR3_ADMISSION_CLOSED','REPLAY_NOT_COMPLETE']);
  assert.equal((await route('POST',QR3_PATH+'/'+randomUUID()+'/replay',{confirmed:true})).status,404);
  const foreign=await api.replay({owner_id:'another-owner',comparison_id:id});
  assert.deepEqual([foreign.ok,foreign.code],[false,'NOT_FOUND']);
  const [one,two]=await Promise.all([route('POST',QR3_PATH+'/'+id+'/replay',{confirmed:true}),route('POST',QR3_PATH+'/'+id+'/replay',{confirmed:true})]);
  assert.deepEqual([one.status,one.body.kind],[200,'REPLAY_MATCH']);
  assert.deepEqual([two.status,two.body.code,two.body.detail],[409,'QR3_ADMISSION_CLOSED','REPLAY_BUSY']);
  assert.equal((await rowsOf('SELECT count(*)::int n FROM public.audit WHERE user_id=$1 AND event=$2',[f.owner,QR3_REPLAY_EVENT]))[0].n,2,'refused replays write no audit row');
  assert.equal(await fixedJobCount(),jobs,'replay admits no job (the open comparison above is only created)');
  // replay latency: 20 sequential record replays (evidence only, not a budget)
  const times=[];
  for(let index=0;index<20;index++){const start=performance.now();assert.equal((await api.replay({owner_id:f.owner,comparison_id:id})).kind,'REPLAY_MATCH');times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);
  console.log('L8W_REPLAY_P95_MS '+times[Math.ceil(0.95*times.length)-1].toFixed(1)+' median '+times[10].toFixed(1));
  await closeOpen();
});

/* ---- E3, E5: participant failure and owner cancel ---- */

test('E3 RR-2: a participant run that ends FAILED, TIMED_OUT, NO_VALID_CANDIDATE or CANCELLED fails the whole comparison; siblings are refused at their next fence',async()=>{
  for(const status of ['FAILED','TIMED_OUT','NO_VALID_CANDIDATE','CANCELLED']){
    const id=await createViaApi(participants(2));
    await driverOf().drive(item(id));
    const [mine,sibling]=await runsOf(id);
    if(status==='CANCELLED')assert.equal((await f.service.cancel(f.owner,mine.run_id)).status,'CANCELLED');
    else{
      // LABELLED: the terminal status of one queued run is set directly; its foundation row is retired so the sibling is the only queued job
      await f.db.query("UPDATE public.quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[mine.run_id]);
      await f.db.query('UPDATE public.quant_jobs SET status=$2 WHERE run_id=$1',[mine.run_id,status]);
    }
    const exposures=(await rowsOf('SELECT count(*)::int n FROM public.quant_exposure_register WHERE comparison_id=$1',[id]))[0].n;
    const done=await driverOf().drive(item(id));
    const reason=status==='CANCELLED'?'PARTICIPANT_RUN_CANCELLED':'PARTICIPANT_RUN_FAILED';
    assert.deepEqual([done.result,done.reason_code],['FAILED',reason],status);
    assert.deepEqual(await statusOf(id),[3,'FAILED',reason]);
    for(const table of ['quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes'])
      assert.equal((await rowsOf(`SELECT count(*)::int n FROM public.${table} WHERE comparison_id=$1`,[id]))[0].n,0,table);
    assert.equal((await rowsOf('SELECT count(*)::int n FROM public.quant_exposure_register WHERE comparison_id=$1',[id]))[0].n,exposures,'exposure events stay');
    // the sibling's claim fence re-reads the comparison status and refuses: nothing is claimed or launched
    pythonCalls=[];
    assert.equal(await worker.claim(),null,status);
    assert.deepEqual(pythonCalls,[]);
    assert.notEqual((await rowsOf('SELECT status FROM public.quant_jobs WHERE run_id=$1',[sibling.run_id]))[0].status,'SUCCEEDED');
    await closeOpen();
  }
});

test('E5 owner cancel while QUEUED and while RUNNING ends CANCELLED; the fences refuse and the finalizer answers ALREADY_TERMINAL',async()=>{
  const queued=await createViaApi(participants(2));
  await driverOf().drive(item(queued));
  const cancel=await route('POST',QR3_PATH+'/'+queued+'/cancel',{});
  assert.deepEqual([cancel.status,cancel.body.status],[200,'CANCELLED']);
  assert.equal(await worker.claim(),null);
  assert.deepEqual(await driverOf().drive(item(queued)),{comparison_id:queued,result:'TERMINAL'});
  const {finalizeComparison}=await import('../../src/postgres/comparison-finalizer.js');
  assert.equal((await finalizeComparison(f.db,item(queued),createFinalizerDeps({fixedEvalService:f.service}))).state,'ALREADY_TERMINAL');
  await closeOpen();
  const running=await createViaApi(participants(2));
  await driverOf().drive(item(running));
  const job=await worker.claim();
  assert.equal(job.kind,'FIXED_EVAL');
  await worker.fixedEval.prepare(job);
  assert.equal((await route('POST',QR3_PATH+'/'+running+'/cancel',{})).body.status,'CANCELLED');
  pythonCalls=[];
  // the RUN fence re-reads the comparison: the scheduler denies the authority (its own code for a refused fixed-evaluation authority)
  await assert.rejects(worker.run(job),{code:'FOUNDATION_FORBIDDEN'});
  assert.deepEqual(pythonCalls,[],'the RUN fence refuses before any launch');
  // release the slot through the real stop path (owner job cancel, then the token-matched stop acknowledgement)
  const state=(await rowsOf('SELECT status FROM public.quant_foundation_jobs WHERE job_id=$1',[job.run_id]))[0].status;
  if(state==='RUNNING')assert.equal((await f.service.cancel(f.owner,job.run_id)).status,'STOPPING');
  await worker.fixedEval.reconcile(job.foundation);
  assert.equal((await rowsOf('SELECT status FROM public.quant_jobs WHERE run_id=$1',[job.run_id]))[0].status,'CANCELLED');
  assert.equal((await finalizeComparison(f.db,item(running),createFinalizerDeps({fixedEvalService:f.service}))).state,'ALREADY_TERMINAL');
  assert.deepEqual((await events(running)).map(row=>row[1]),['SPEC_FROZEN','EVALUATING','CANCELLED']);
  await closeOpen();
});

/* ---- E4, E7, E11: admission refusal classes and the compatibility matrix ---- */

test('E4 RR-10: retry with no status change, no-op, and a deterministic refusal that fails the comparison (one input change each)',async()=>{
  // retry: one immutable-authority guard disabled (LABELLED test-only DDL); nothing admitted, status unchanged; the next tick admits once it is back
  const id=await createViaApi(participants(2));
  await f.db.query('ALTER TABLE public.quant_jobs DISABLE TRIGGER quant_job_terminal_freeze');
  let summary;
  try{summary=await driverOf().drive(item(id));}finally{await f.db.query('ALTER TABLE public.quant_jobs ENABLE ALWAYS TRIGGER quant_job_terminal_freeze');}
  assert.deepEqual([summary.result,summary.code],['ADMISSION_RETRY','FIXED_EVAL_IMMUTABLE_AUTHORITY_REQUIRED']);
  assert.deepEqual(await events(id),[[1,'SPEC_FROZEN',null]]);
  assert.equal((await runsOf(id)).length,0);
  const admitted=await driverOf().drive(item(id));
  assert.equal(admitted.enqueued?.length,2,JSON.stringify(admitted));
  await closeOpen();
  // retry: a missing or changed closure member makes the engine hash unreadable; admission fails closed with no status change
  const broken=await createViaApi(participants(2));
  const unreadable=new QuantFixedEvalService({pineService:new PineBridgeService(f.store),supportedSourceHash:f.c.source_hash,engineHash:async()=>{throw Object.assign(new Error('missing member'),{code:'ENOENT'});}});
  const retry=await new Qr3EvaluationDriver({fixedEvalService:unreadable,log}).drive(item(broken));
  assert.deepEqual([retry.result,retry.code],['ADMISSION_RETRY','ENOENT']);
  assert.deepEqual(await events(broken),[[1,'SPEC_FROZEN',null]]);
  await closeOpen();
  // no-op: the run was admitted by a concurrent driver (FIXED_EVAL_ALREADY_STARTED from the real admission), or the comparison ended (FIXED_EVAL_OBJECT_NOT_EVALUATING)
  const raced=await createViaApi(participants(2));
  const [p1]=participants(2);
  let first=true;
  const racing=Object.create(f.service,{enqueue:{value:async(owner,body,key)=>{
    if(first&&body.participant_id===p1){first=false;await f.service.enqueue(owner,body,'concurrent-driver-key-0001');}
    return f.service.enqueue(owner,body,key);
  }}});
  const noop=await new Qr3EvaluationDriver({fixedEvalService:racing,log}).drive(item(raced));
  assert.deepEqual([noop.result,noop.enqueued.length],['WAITING',1]);
  assert.equal((await runsOf(raced)).length,2);
  assert.equal((await statusOf(raced))[1],'EVALUATING');
  await closeOpen();
  const ended=await createViaApi(participants(2));
  const cancelling=Object.create(f.service,{enqueue:{value:async(owner,body,key)=>{await cancelComparison(f.db,{owner_id:owner,comparison_id:body.object_id});return f.service.enqueue(owner,body,key);}}});
  const terminal=await new Qr3EvaluationDriver({fixedEvalService:cancelling,log}).drive(item(ended));
  assert.deepEqual([terminal.result,terminal.enqueued.length],['ALREADY_TERMINAL',0]);
  assert.deepEqual((await events(ended)).map(row=>row[1]),['SPEC_FROZEN','CANCELLED']);
  // deterministic: an application refusal (FIXED_EVAL_CONTEXT_MISMATCH) fails the comparison with PARTICIPANT_ADMISSION_REFUSED
  const mismatch=await createWithEngine(hash('another engine closure'));
  const failed=await driverOf().drive(item(mismatch));
  assert.deepEqual([failed.result,failed.reason_code,failed.cause],['FAILED',ADMISSION_REFUSED_REASON,'FIXED_EVAL_CONTEXT_MISMATCH']);
  assert.deepEqual(await statusOf(mismatch),[2,'FAILED',ADMISSION_REFUSED_REASON]);
  assert.equal((await runsOf(mismatch)).length,0);
  await closeOpen();
});

test('E7 compatibility matrix: an old-hash comparison and an old-hash job refuse and are never rewritten',async()=>{
  const old=hash('engine identity before the L8-W rotation');
  const id=await createWithEngine(old);
  const frozen=await rowsOf('SELECT participant_id,freeze_canonical,freeze_hash FROM public.quant_comparison_participants WHERE comparison_id=$1 ORDER BY 1',[id]);
  const failed=await driverOf().drive(item(id));
  assert.deepEqual([failed.result,failed.reason_code,failed.cause],['FAILED',ADMISSION_REFUSED_REASON,'FIXED_EVAL_CONTEXT_MISMATCH']);
  assert.deepEqual(await rowsOf('SELECT participant_id,freeze_canonical,freeze_hash FROM public.quant_comparison_participants WHERE comparison_id=$1 ORDER BY 1',[id]),frozen,'never rewritten');
  // an old-hash job: admitted while the old closure was live, refused at the claim fence by the current closure
  const second=await createWithEngine(old);
  const oldService=new QuantFixedEvalService({pineService:new PineBridgeService(f.store),supportedSourceHash:f.c.source_hash,engineHash:async()=>old});
  assert.equal((await new Qr3EvaluationDriver({fixedEvalService:oldService,log}).drive(item(second))).enqueued.length,2);
  const jobs=await rowsOf("SELECT run_id,contract,contract_hash FROM public.quant_jobs WHERE contract#>>'{lineage,object_id}'=$1 ORDER BY run_id",[second]);
  assert.ok(jobs.every(row=>row.contract.engine_hash===old));
  pythonCalls=[];
  assert.equal(await worker.claim(),null);
  assert.deepEqual(pythonCalls,[]);
  assert.deepEqual(await rowsOf("SELECT run_id,contract,contract_hash FROM public.quant_jobs WHERE contract#>>'{lineage,object_id}'=$1 ORDER BY run_id",[second]),jobs,'stored contracts and hashes are never rewritten');
  await closeOpen();
});

test('E11 queue caps and tick bounds: at most 8 comparisons per tick, oldest freeze first; the owner queue cap refuses as a retry',async()=>{
  const ids=[];
  for(let index=0;index<10;index++)ids.push(await createViaApi(participants(2)));
  const driver=driverOf();
  const first=await driver.tick();
  assert.equal(first.length,8);
  const order=await rowsOf('SELECT comparison_id FROM public.quant_comparison_specs WHERE comparison_id=ANY($1::text[]) ORDER BY frozen_at_ms,comparison_id',[ids]);
  assert.deepEqual(first.map(entry=>entry.comparison_id),order.slice(0,8).map(row=>row.comparison_id));
  // recorded limitation: while the 8 oldest stay open, the newer comparisons wait outside the window (no admission, no status change)
  await driver.tick();
  for(const row of order.slice(8)){assert.equal((await runsOf(row.comparison_id)).length,0);assert.deepEqual(await events(row.comparison_id),[[1,'SPEC_FROZEN',null]]);}
  for(const row of order.slice(8))assert.equal((await driver.drive(item(row.comparison_id))).enqueued.length,2);
  assert.equal((await rowsOf("SELECT count(*)::int n FROM public.quant_foundation_jobs WHERE status='QUEUED' AND owner_id=$1",[f.owner]))[0].n,20);
  // the 21st owner job is refused by the admission cap (fewer than 20 active per owner): a retry with no status change
  const late=await createViaApi(participants(2));
  const refused=await driver.drive(item(late));
  assert.deepEqual([refused.result,refused.code],['ADMISSION_RETRY','FOUNDATION_QUEUE_FULL']);
  assert.deepEqual(await events(late),[[1,'SPEC_FROZEN',null]]);
  await closeOpen();
});

/* ---- E6: restart and RR-11 ---- */

test('E6 a restart after the first stored records completes with the same hashes; RR-11 retries a transient dependency refusal up to 5 times, a deterministic one fails',async()=>{
  const id=await createViaApi(participants(2));
  await driverOf().drive(item(id));
  await runQueued();
  const deps=createFinalizerDeps({fixedEvalService:f.service});
  // the participant inputs cannot be read: the evaluations and the benchmark are stored, the outcome is not (a stop after the first writes)
  const failing={...deps,participantInputs:async()=>{throw Object.assign(new Error('connection lost'),{code:'08006'});}};
  const bounded=new Qr3EvaluationDriver({fixedEvalService:f.service,deps:failing,log});
  const answers=[];
  for(let attempt=0;attempt<5;attempt++)answers.push(await bounded.drive(item(id)));
  assert.deepEqual(answers.map(entry=>entry.result),['FINALIZE_RETRY','FINALIZE_RETRY','FINALIZE_RETRY','FINALIZE_RETRY','HELD']);
  assert.ok(answers.every(entry=>entry.code===CODES.QR3_INTEGRITY_FAILED&&entry.detail==='PARTICIPANT_INPUTS'));
  assert.equal(bounded.held.has(id),true);
  assert.equal((await bounded.tick()).some(entry=>entry.comparison_id===id),false,'a held comparison is left for owner cancel');
  assert.equal((await statusOf(id))[1],'EVALUATING');
  const partial=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:id});
  assert.deepEqual([partial.evaluations.length,!!partial.benchmark,partial.outcome],[2,true,null]);
  // a restart (a new driver with the real dependencies) completes from the stored records, which it reads back unchanged
  const restarted=await driverOf().drive(item(id));
  assert.equal(restarted.result,'COMPLETE');
  const final=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:id});
  assert.deepEqual(final.evaluations.map(view=>[view.body_hash,view.created_at_ms]),partial.evaluations.map(view=>[view.body_hash,view.created_at_ms]));
  assert.equal(final.benchmark.body_hash,partial.benchmark.body_hash);
  // the same participants and the same bars give the same evaluation and benchmark hashes as the E2 comparison, except the comparison id inside each body
  assert.equal((await api.replay({owner_id:f.owner,comparison_id:id})).kind,'REPLAY_MATCH');
  // deterministic: stored evaluations that the rebuild cannot reproduce fail the comparison with QR3_INTEGRITY_FAILED
  const other=await createViaApi(participants(2));
  await driverOf().drive(item(other));
  await runQueued();
  const stop={...deps,participantInputs:async()=>{throw new Error('stop after the writes');}};
  assert.equal((await new Qr3EvaluationDriver({fixedEvalService:f.service,deps:stop,log}).drive(item(other))).result,'FINALIZE_RETRY');
  const tampered={...deps,readRows:async(...args)=>{const value=await deps.readRows(...args);value[value.length-1]={...value[value.length-1],close:'101'};return value;}};
  const failed=await new Qr3EvaluationDriver({fixedEvalService:f.service,deps:tampered,log}).drive(item(other));
  assert.deepEqual([failed.result,failed.reason_code],['FAILED',CODES.QR3_INTEGRITY_FAILED]);
  assert.match(failed.cause,/^(?:EVALUATION_MISMATCH|BENCHMARK_MISMATCH|CROSS_CHECK_[A-Z_]+)$/);
  assert.deepEqual(await statusOf(other),[3,'FAILED',CODES.QR3_INTEGRITY_FAILED]);
  await closeOpen();
});

test('flag off: the routes answer nothing and nothing is built; without the wiring, create and replay stay fail closed',async()=>{
  const req=Readable.from([Buffer.from('{}')]);req.method='POST';req.headers={};
  const res={phase2Buffer:true};
  assert.equal(await qr3Routes(req,res,new URL(QR3_PATH+'/x/replay','http://localhost'),{id:f.owner},{store:f.store,auth:{require:async()=>({id:f.owner})},json:()=>{},enabled:false,deps:api}),false);
  const saved=api;
  try{
    api=undefined;
    const create=await route('POST',QR3_PATH,createBody(participants(2)));
    assert.deepEqual([create.status,create.body.code,create.body.detail],[409,'QR3_ADMISSION_CLOSED','CREATE_NOT_WIRED']);
    const replay=await route('POST',QR3_PATH+'/'+(complete?.id??randomUUID())+'/replay',{confirmed:true});
    assert.deepEqual([replay.status,replay.body.code,replay.body.detail],[409,'QR3_ADMISSION_CLOSED','REPLAY_NOT_WIRED']);
  }finally{api=saved;}
});
