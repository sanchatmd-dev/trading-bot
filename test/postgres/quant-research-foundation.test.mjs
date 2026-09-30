import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker,pythonEvaluation} from '../../src/postgres/quant-research-worker.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {fixture,source} from '../helpers/quant-research-fixture.mjs';
import {CONTENT_DIGEST_SQL,contentDigest,DATASET_BINDING_STEP_ID,datasetBindingIdentity,
 materializeExecutionContract} from '../../src/quant-research/research-contract-v2.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';
let admin,db,store,pine,service,databaseName,datasetRoot,now=Date.now();
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 databaseName='research_adapter_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+databaseName);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
 db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
 for(const filename of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'])await db.query(await fs.readFile(new URL('../../src/postgres/'+filename,import.meta.url),'utf8'));
 assert.deepEqual((await db.query('SELECT version FROM quant_research_foundation_schema')).rows,[{version:1}]);
 assert.equal((await db.query('SELECT mode FROM quant_research_executor_mode')).rows[0].mode,'LEGACY');
 await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
 datasetRoot=await fs.mkdtemp(path.join(os.tmpdir(),'research-adapter-'));
 store=new Store(db);pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
 service=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(source),foundation:true,datasetStore:new ResearchDatasetStore({root:datasetRoot})});
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}if(datasetRoot)await fs.rm(datasetRoot,{recursive:true,force:true});});
async function baseline({approved,marketBars}={}){
 const a=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
 const policy={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':1000}};await store.setRisk(a,policy);
 const f=fixture(),importId=randomUUID(),deploymentId=randomUUID(),pineSource=approved?.source??source;
 if(approved){
  f.analysis=structuredClone(approved.snapshot.membership.find(row=>row.source_hash===approved.source_hash).analysis);
  f.selection=structuredClone(approved.input_lock.selection);
  f.slots=f.selection.bindings.map(input=>({slot:input.slot,input_id:input.input_id,...input.search_domain}));
  f.bridge_domains=Object.fromEntries(['atr_multiplier','rr'].map(name=>{const grid=approved.input_lock.domains[name];return [name,{min:grid[0],max:grid.at(-1),step:Number((grid[1]-grid[0]).toPrecision(12))}];}));
 }
 await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,a,a,1,hash(pineSource),'Local adapter test only',pineSource,JSON.stringify(f.analysis),now);
 await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,hash(pineSource),pineSource,JSON.stringify(f.analysis),now);
 await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,a,a,1);
 const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
 const capital=await store.paperAccounts(a),snapshot={source_hash:hash(pineSource),artifact_hash:hash('fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:0,membership:members,selection:{...f.selection,bindings:[],fixed_inputs:f.analysis.inputs}};
 snapshot.funding_cutoff=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(a)).cutoff;
 await db.prepare('INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,\'READY\',?)').run(deploymentId,a,a,importId,1,JSON.stringify(snapshot),hash(canonical(snapshot)),now);
 const evidence={snapshot_hash:hash(canonical(snapshot)),artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
 if(approved)evidence.execution_model=structuredClone(approved.model);
 await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,evidence.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),now);
 const start=marketBars?.[0].time??1800000000000,count=marketBars?.length??3250;
 // Decimal strings mirror real verified market storage, rather than JS numbers.
 for(let i=0;i<count;i++){
  const bar=marketBars?.[i]??{time:start+i*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
  await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run('binance-global','BTCUSDT','1',bar.time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'}),hash(canonical(bar)));
 }
 now=Math.max(now,start+count*60000+1000);
 return {a,body:{bot_id:a,deployment_id:deploymentId,parameter_slots:f.slots,bridge_domains:f.bridge_domains,dataset:{start_time:start,end_time:start+(count-1)*60000,warmup_bars:1250},budget:25,seed:27}};
}
const enqueue=x=>db.transaction(()=>service.enqueue(x.a,x.body,randomUUID()));
const metric={closed_trades:5,net_return_percent:'1',max_drawdown_percent:'1'};
// Synthetic source and deterministic evaluator isolate adapter fencing and IO.
// Actual Python parity uses the separately frozen, private source fixture.
function continuation(payload){
 const {contract,parameters,kind,rows}=payload,end=kind==='HOLDOUT'?contract.split.test_end:contract.split.validation_end;
 const next=(payload.checkpoint?.next_bar??0)+rows.length;
 const checkpoint={version:'research-chunk-v1',identity:hash(canonical({contract,parameters,kind})),integrity:'a'.repeat(64),next_bar:next,last_time:rows.at(-1).time,paper:{cash:'1000'},evaluator:{index:next-1}};
 return {checkpoint,result:next===end?{parameters,kind,train:metric,validation:metric,...(kind==='HOLDOUT'?{test:metric}:{})}:null};
}
const worker=evaluateChunk=>new QuantResearchFoundationWorker({service,clock:()=>now,health:async()=>({ok:true}),evaluateChunk,stopUnit:async()=>true});
async function preparedClaim(first){
 const job=await first.claim();first.controller=new AbortController();
 return first.prepareResearch(job);
}
test('default legacy mode accepts contracts without execution_backend and rejects foundation jobs',async()=>{
 await db.query("UPDATE quant_research_executor_mode SET mode='LEGACY'");
 const x=await baseline(),legacy=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(source),foundation:false});
 const queued=await db.transaction(()=>legacy.enqueue(x.a,x.body,randomUUID()));
 const row=(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0];
 assert.equal(Object.hasOwn(row.contract,'execution_backend'),false);assert.equal(row.status,'QUEUED');assert.equal(row.contract.dataset.bars.length,3250);
 const claimed=await new QuantResearchWorker({service:legacy,clock:()=>now}).claim();assert.equal(claimed.run_id,queued.run_id);
 await assert.rejects(enqueue(x),{code:'RESEARCH_EXECUTOR_MODE_MISMATCH'});
 await db.transaction(()=>legacy.get(x.a,queued.run_id,true));
 await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
});
test('real research enqueue stores range/digest without files; claim prepares immutable references',async()=>{
 const x=await baseline(),files=await datasetListing();
 let publications=0;const publish=service.datasetStore.publish.bind(service.datasetStore);
 service.datasetStore.publish=async(...args)=>{publications++;return publish(...args);};
 let queued,statements;
 try{statements=await recordSql(async()=>{queued=await enqueue(x);});}
 finally{service.datasetStore.publish=publish;}
 assert.equal(publications,0);assert.deepEqual(await datasetListing(),files);
 assert.equal(statements.some(sql=>sql.includes('SELECT * FROM pine_market_bars')),false);
 const row=(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0];
 assert.equal(row.contract.execution_backend,'quant-foundation-v1');assert.equal(Object.hasOwn(row.contract.dataset,'bars'),false);
 assert.equal(row.contract.version,'ql3a-research-job-v2');assert.equal(Object.hasOwn(row.contract.dataset,'references'),false);
 assert.equal(queued.dataset_hash,null);assert.equal(queued.dataset_prepared,false);
 assert.equal(row.contract.dataset.first_time,x.body.dataset.start_time);
 const binding=(await db.query('SELECT * FROM quant_research_foundation WHERE run_id=$1',[queued.run_id])).rows[0];assert.equal(binding.contract_hash,row.contract_hash);
 assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[binding.job_id])).rows[0].status,'QUEUED');
 await assert.rejects(new QuantResearchWorker({service}).claim(),{code:'RESEARCH_FOUNDATION_WORKER_REQUIRED'});
 await assert.rejects(db.query("UPDATE quant_research_executor_mode SET mode='LEGACY'"),/drain/);
 const first=worker(continuation),claimed=await first.claim();first.controller=new AbortController();
 assert.equal(claimed.phase,'PREPARE');
 await assert.rejects(first.step(claimed,'candidate:000','CANDIDATE',claimed.contract.plan.candidates[0]),
  {code:'RESEARCH_DATASET_BINDING_REQUIRED'});
 const prepared=await first.prepareResearch(claimed),refs=prepared.contract.dataset.references;
 assert.equal(refs.sidecar.profile,'closed-ohlcv-atr14-v1');
 const stream=service.datasetStore.read(refs,{start:0,end:1});assert.equal((await stream.next()).value.atr14,'2');
 const datasetBinding=(await db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',
  [queued.run_id,DATASET_BINDING_STEP_ID])).rows[0];
 assert.equal(datasetBinding.identity_hash,datasetBindingIdentity(row.contract,datasetBinding.parameters));
 const summary=await db.transaction(()=>service.get(x.a,queued.run_id));
 assert.equal(summary.dataset_prepared,true);assert.equal(summary.dataset_hash,datasetBinding.parameters.dataset_sha256);
 await db.transaction(()=>service.get(x.a,queued.run_id,true));
 await first.reconcile();
});
test('durable real step checkpoint resumes without prefix replay; old lease cannot publish',async()=>{
 const x=await baseline(),queued=await enqueue(x);let calls=0;
 const first=worker(payload=>{if(++calls===2)throw Object.assign(Error('fixture interruption'),{stopped:true});return continuation(payload);});
 const old=await preparedClaim(first);
 await assert.rejects(first.step(old,'candidate:000','CANDIDATE',old.contract.plan.candidates[0]),/fixture interruption/);
 const chunk=(await db.query("SELECT * FROM quant_research_chunks WHERE run_id=$1 AND kind='CANDIDATE'",[queued.run_id])).rows[0];assert.equal(chunk.next_bar,1000);assert.equal(chunk.checkpoint.paper.cash,'1000');
 assert.equal((await db.query('SELECT evaluations_started FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0].evaluations_started,1);
 await first.scheduler.pause(old.foundation);
 const starts=[],second=worker(payload=>{starts.push(payload.rows[0].time);return continuation(payload);});
 const resumed=await preparedClaim(second);assert.notEqual(resumed.lease_token,old.lease_token);
 await assert.rejects(first.fenced(old,()=>{}),{code:'FOUNDATION_LEASE_LOST'});
 const result=await second.step(resumed,'candidate:000','CANDIDATE',resumed.contract.plan.candidates[0]);
 assert.equal(starts[0],old.contract.dataset.first_time+1000*60000);assert.equal(result.validation.closed_trades,5);
 assert.equal((await second.steps(resumed)).length,1);
 await second.finish(resumed,'NO_VALID_CANDIDATE',{fixture:true});
 assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[resumed.foundation.job_id])).rows[0].status,'SUCCEEDED');
});
test('cancel reserves shared slot until physical stop; late output cannot checkpoint',async()=>{
 const x=await baseline(),queued=await enqueue(x);let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const first=worker(async payload=>{started();await new Promise(resolve=>{release=resolve;});return continuation(payload);});
 const job=await preparedClaim(first);
 const pending=first.step(job,'candidate:000','CANDIDATE',job.contract.plan.candidates[0]);await ready;
 await db.transaction(()=>service.get(x.a,queued.run_id,true));
 assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[job.foundation.job_id])).rows[0].status,'STOPPING');
 assert.equal(await first.scheduler.claim('other'),null);
 const restarted=worker(continuation);await restarted.reconcile();
 assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[job.foundation.job_id])).rows[0].status,'STOPPING','a missing/stopped unit does not prove its launcher settled');
 release();await assert.rejects(pending,{code:'FOUNDATION_LEASE_LOST'});
 assert.equal((await first.steps(job)).length,0);await first.reconcile();
 assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[job.foundation.job_id])).rows[0].status,'CANCELLED');
});
test('queued deadline cancellation becomes terminal in original research API',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation);
 now=queued.deadline+1;assert.equal(await first.claim(),null);
 const summary=await db.transaction(()=>service.get(x.a,queued.run_id));assert.equal(summary.status,'TIMED_OUT');assert.equal(summary.diagnostic,'JOB_DEADLINE_EXCEEDED');
 const legacy=new QuantResearchService({pineService:pine,foundation:false});
 await assert.rejects(db.transaction(()=>legacy.get(x.a,queued.run_id)),{code:'RESEARCH_EXECUTOR_MODE_MISMATCH'});
});
test('stop during awaited claim never launches an evaluator or leaves a reserved slot',async()=>{
 const x=await baseline(),queued=await enqueue(x);let entered,release,calls=0;
 const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const first=new QuantResearchFoundationWorker({service,clock:()=>now,health:async()=>{entered();await gate;return {ok:true};},evaluateChunk:payload=>{calls++;return continuation(payload);},stopUnit:async()=>true});
 first.start();await ready;const stopping=first.stop();release();await stopping;
 assert.equal(calls,0);
 const row=(await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[queued.run_id])).rows[0];
 assert.ok(!['RUNNING','STOPPING'].includes(row.status));
 assert.equal((await db.query('SELECT count(*)::int total FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0].total,0);
});
test('finish holds owner lock across current baseline check and result publication',async()=>{
 const x=await baseline();await enqueue(x);const first=worker(continuation),job=await preparedClaim(first);
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const current=first.current.bind(first);first.current=async row=>{await current(row);entered();await gate;};
 const finish=first.finish(job,'NO_VALID_CANDIDATE',{fixture:true});await ready;
 const second=new PostgresDatabase({connectionString:db.pool.options.connectionString,max:4});let attempting,mutationComplete=false,pid;
 const attempted=new Promise(resolve=>{attempting=resolve;});
 const mutation=second.transaction(async()=>{
  pid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;attempting();
  await second.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[x.a]);
  await second.query("UPDATE users SET status='INACTIVE' WHERE id=$1",[x.a]);mutationComplete=true;
 });
 try{
  await attempted;let blocked=false;
  for(let i=0;i<100&&!blocked;i++){
   blocked=(await db.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(blocked,true);assert.equal(mutationComplete,false);
 }finally{release();await finish;await mutation;await second.close();}
 assert.equal((await db.query('SELECT status FROM quant_jobs WHERE run_id=$1',[job.run_id])).rows[0].status,'NO_VALID_CANDIDATE');
 assert.equal((await db.query('SELECT status FROM users WHERE id=$1',[x.a])).rows[0].status,'INACTIVE');
});
test('private baseline Python step matches original evaluator exactly without search or holdout',{skip:!process.env.QUANT_REAL_CONTRACT_FILE},async()=>{
 const filename=path.resolve(process.env.QUANT_REAL_CONTRACT_FILE);
 const approved=JSON.parse(await fs.readFile(filename,'utf8'));
 const exposed=JSON.parse(await fs.readFile(path.join(path.dirname(filename),'ql3a-engine-smoke-bars-private.json'),'utf8'));
 assert.equal(exposed.length,4533);assert.equal(approved.split.validation_end,4533);assert.ok(approved.split.test_end>exposed.length);
 assert.equal(hash(approved.source),approved.source_hash);
 // The isolated service forms its own 60/20/20 split inside the already exposed
 // preholdout range. It never receives any original reserved holdout candle.
 const x=await baseline({approved,marketBars:exposed});
 const actualService=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:approved.source_hash,foundation:true,datasetStore:service.datasetStore});
 const queued=await db.transaction(()=>actualService.enqueue(x.a,x.body,randomUUID()));
 const python=process.env.QUANT_TEST_PYTHON??path.resolve('quant_lab/.venv/Scripts/python.exe');
 const actual=new QuantResearchFoundationWorker({service:actualService,clock:()=>now,health:async()=>({ok:true}),python,allowUnsupportedPlatformForTests:true});
 const job=await preparedClaim(actual);
 assert.equal(job.contract.dataset.bar_count,4533);assert.equal(Object.hasOwn(job.contract.dataset,'bars'),false);
 assert.deepEqual(job.contract.input_lock.baseline,approved.input_lock.baseline);
 const parameters=job.contract.input_lock.baseline;
 const expected=await pythonEvaluation({...job.contract,dataset:{...job.contract.dataset,bars:exposed}},parameters,'CANDIDATE',new AbortController().signal,{python});
 const result=await actual.step(job,'candidate:000','CANDIDATE',parameters);
 assert.deepEqual(result,expected);assert.equal(Object.hasOwn(result,'test'),false);
 const steps=await actual.steps(job);assert.equal(steps.length,1);assert.equal(steps[0].kind,'CANDIDATE');
 const chunk=(await db.query("SELECT next_bar,unit_name,checkpoint FROM quant_research_chunks WHERE run_id=$1 AND kind='CANDIDATE'",[queued.run_id])).rows[0];
 assert.equal(chunk.next_bar,job.contract.split.validation_end);assert.equal(chunk.unit_name,null);assert.equal(chunk.checkpoint.next_bar,job.contract.split.validation_end);
 assert.equal((await db.query('SELECT evaluations_started FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0].evaluations_started,1);
 await actual.finish(job,'NO_VALID_CANDIDATE',{scope:'BASELINE_ADAPTER_ENGINEERING_CHECK_ONLY',holdout_evaluated:false,owner_recommendation_ready:false});
});
test('P0 ordered PostgreSQL digest equals JS; empty range returns null',async()=>{
 const x=await baseline(),d=x.body.dataset;
 const rows=(await db.query("SELECT * FROM pine_market_bars WHERE bar_time>=$1 AND bar_time<=$2 ORDER BY bar_time",[d.start_time,d.end_time])).rows;
 const aggregate=(await db.query(CONTENT_DIGEST_SQL,[d.start_time,d.end_time,'closed-ohlcv-atr14-v1'])).rows[0];
 assert.equal(aggregate.digest,contentDigest(rows));assert.equal(aggregate.n,3250);assert.equal(aggregate.bad,0);
 const empty=(await db.query(CONTENT_DIGEST_SQL,[d.end_time+1,d.end_time+2,'closed-ohlcv-atr14-v1'])).rows[0];
 assert.equal(empty.n,0);assert.equal(empty.digest,null);
});

test('P1b NULL-safe profile/time/hash filters reject before publication',async()=>{
 const x=await baseline(),time=x.body.dataset.start_time;
 const original=(await db.query('SELECT * FROM pine_market_bars WHERE bar_time=$1',[time])).rows[0];
 const files=await datasetListing();
 const mutations=[{...original,provenance:{}},
  {...original,bar:{...original.bar,time:time+1}}, {...original,content_hash:'INVALID'}];
 try{
  for(const changed of mutations){
   await db.query('UPDATE pine_market_bars SET bar=$2,provenance=$3,content_hash=$4 WHERE bar_time=$1',
    [time,JSON.stringify(changed.bar),JSON.stringify(changed.provenance),changed.content_hash]);
   await assert.rejects(enqueue(x),{code:'VERIFIED_MARKET_DATA_REQUIRED'});
   assert.deepEqual(await datasetListing(),files);
  }
 }finally{await db.query('UPDATE pine_market_bars SET bar=$2,provenance=$3,content_hash=$4 WHERE bar_time=$1',
  [time,JSON.stringify(original.bar),JSON.stringify(original.provenance),original.content_hash]);}
});

test('P2 busy global slot still queues research without files',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation);
 const running=await first.claim(),files=await datasetListing();
 const other=await baseline(),waiting=await enqueue(other);
 assert.equal(waiting.status,'QUEUED');assert.deepEqual(await datasetListing(),files);
 assert.equal(await first.scheduler.claim('busy'),null);
 await db.transaction(()=>service.get(other.a,waiting.run_id,true));
 await db.transaction(()=>service.get(x.a,queued.run_id,true));await first.reconcile();
 assert.equal(running.phase,'PREPARE');
});

test('P3 tick sends V1 payloads while keeping stored V2 identity and bound report digest',async()=>{
 const x=await baseline(),queued=await enqueue(x);let evaluations=0;
 const first=worker(payload=>{
  evaluations++;assert.equal(payload.contract.version,'ql3a-research-job-v1');
  assert.ok(payload.contract.dataset.references);assert.match(payload.contract.dataset.sha256,/^[a-f0-9]{64}$/);
  return continuation(payload);
 });
 assert.equal(await first.tick(),true);assert.ok(evaluations>0);
 const row=(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0];
 assert.ok(['SUCCEEDED','NO_VALID_CANDIDATE'].includes(row.status),row.diagnostic);
 assert.equal(row.contract.version,'ql3a-research-job-v2');assert.equal(row.result.contract_hash,row.contract_hash);
 const binding=(await db.query('SELECT parameters FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',
  [queued.run_id,DATASET_BINDING_STEP_ID])).rows[0].parameters;
 assert.equal(row.result.dataset_hash,binding.dataset_sha256);
 assert.equal(hash(canonical(materializeExecutionContract(row.contract,binding))),binding.execution_contract_hash);
});

test('P4 market mutation after enqueue refuses before publish or binding',async()=>{
 const x=await baseline(),queued=await enqueue(x),time=x.body.dataset.start_time;
 const original=(await db.query('SELECT * FROM pine_market_bars WHERE bar_time=$1',[time])).rows[0];
 const changed={...original.bar,volume:'2'},files=await datasetListing();
 try{
  await db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',
   [time,JSON.stringify(changed),hash(canonical(changed))]);
  assert.equal(await worker(continuation).tick(),true);
  const row=(await db.query('SELECT status,diagnostic FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0];
  assert.equal(row.status,'FAILED');assert.equal(row.diagnostic,'RESEARCH_DATASET_CHANGED');
  assert.equal((await db.query('SELECT count(*)::int n FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0].n,0);
  assert.deepEqual(await datasetListing(),files);
 }finally{await db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',
  [time,JSON.stringify(original.bar),original.content_hash]);}
});

test('P5 stale token cannot bind; successor republishes identical references',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation),second=worker(continuation);
 const old=await first.claim();first.controller=new AbortController();second.controller=new AbortController();
 const publish=service.datasetStore.publish.bind(service.datasetStore);let refs,successor;
 service.datasetStore.publish=async(...args)=>{
  refs=await publish(...args);await first.scheduler.pause(old.foundation);successor=await second.claim();return refs;
 };
 try{await assert.rejects(first.prepareResearch(old),{code:'FOUNDATION_LEASE_LOST'});}
 finally{service.datasetStore.publish=publish;}
 assert.equal((await db.query('SELECT count(*)::int n FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0].n,0);
 const prepared=await second.prepareResearch(successor);assert.deepEqual(prepared.dataset_binding.references,refs);
 await db.transaction(()=>service.get(x.a,queued.run_id,true));await second.reconcile();
});

test('P6 owner cancel after publish forbids binding and releases after proof',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation),job=await first.claim();
 first.controller=new AbortController();const publish=service.datasetStore.publish.bind(service.datasetStore);
 service.datasetStore.publish=async(...args)=>{
  const refs=await publish(...args);await db.transaction(()=>service.get(x.a,queued.run_id,true));return refs;
 };
 try{await assert.rejects(first.prepareResearch(job),{code:'FOUNDATION_LEASE_LOST'});}
 finally{service.datasetStore.publish=publish;}
 assert.equal((await db.query('SELECT count(*)::int n FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0].n,0);
 await first.reconcile();assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[queued.run_id])).rows[0].status,'CANCELLED');
});

test('P7/P8 reprepare is deterministic; bound resume never republishes and missing sidecar refuses',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation),old=await first.claim();
 first.controller=new AbortController();const publish=service.datasetStore.publish.bind(service.datasetStore);let published;
 service.datasetStore.publish=async(...args)=>{published=await publish(...args);throw Error('crash-after-publish');};
 try{await assert.rejects(first.prepareResearch(old),/crash-after-publish/);}
 finally{service.datasetStore.publish=publish;}
 const files=await datasetListing();await first.scheduler.pause(old.foundation);
 const second=worker(continuation),prepared=await preparedClaim(second);
 assert.deepEqual(prepared.dataset_binding.references,published);assert.deepEqual(await datasetListing(),files);
 await second.scheduler.pause(prepared.foundation);
 const third=worker(continuation),resumed=await third.claim();third.controller=new AbortController();
 service.datasetStore.publish=async()=>{throw Error('must-not-republish');};
 try{
  const reused=await third.prepareResearch(resumed);
  assert.deepEqual(reused.dataset_binding,prepared.dataset_binding);
  const filename=path.join(datasetRoot,'atr14-'+published.sidecar.sha256+'.json'),bytes=await fs.readFile(filename);
  await fs.unlink(filename);
  try{await assert.rejects(third.prepareResearch(resumed),{code:'RESEARCH_DATASET_BINDING_INVALID'});}
  finally{await fs.writeFile(filename,bytes);}
 }finally{service.datasetStore.publish=publish;}
 await db.transaction(()=>service.get(x.a,queued.run_id,true));await third.reconcile();
});

test('P9 revoked engine cancels cleanly and next valid research row claims',async()=>{
 const x=await baseline(),queued=await enqueue(x),other=await baseline(),next=await enqueue(other);
 const first=worker(continuation),engine=first.engineHash.bind(first);
 first.engineHash=async()=> '0'.repeat(64);
 assert.equal(await first.claim(),null);
 assert.equal((await db.query('SELECT diagnostic FROM quant_foundation_jobs WHERE job_id=$1',[queued.run_id])).rows[0].diagnostic,'AUTHORIZATION_REVOKED');
 assert.equal((await db.query('SELECT diagnostic FROM quant_foundation_jobs WHERE job_id=$1',[next.run_id])).rows[0].diagnostic,'AUTHORIZATION_REVOKED');
 first.engineHash=engine;
 const valid=await enqueue(other);assert.equal((await first.claim()).run_id,valid.run_id);
 await db.transaction(()=>service.get(other.a,valid.run_id,true));await first.reconcile();
});

test('P9 managed V1 rows refuse without wedging; request field mutation cannot authorize',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation),prepared=await preparedClaim(first);
 const request=prepared.foundation.contract;
 for(const change of [r=>{r.bot_id='foreign';},r=>{r.pending_dataset.content_digest='0'.repeat(64);},
  r=>{r.engine_hash='0'.repeat(64);},r=>{r.budget.candidates++;}]){
  const changed=structuredClone(request);change(changed);
  assert.deepEqual(await db.transaction(()=>first.authorize(x.a,changed,'CLAIM',{})),{ok:false});
 }
 await db.transaction(()=>service.get(x.a,queued.run_id,true));await first.reconcile();
 const id=randomUUID(),contract=prepared.contract,contractHash=hash(canonical(contract));
 const {pending_dataset,...rest}=request;
 const oldRequest={...rest,version:'quant-foundation-v1',dataset:contract.dataset.references.raw};
 await db.transaction(async()=>{
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,
   submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
   VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$8,$9)`,
   [id,x.a,contract.deployment_id,randomUUID(),hash('managed-v1'),contractHash,JSON.stringify(contract),now-1,now+900000]);
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,
   status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)`,
   [id,x.a,randomUUID(),JSON.stringify(oldRequest),hash(canonical(oldRequest)),now-1,now+900000]);
  await db.query('INSERT INTO quant_research_foundation VALUES($1,$2,$3)',[id,id,contractHash]);
 });
 const valid=await enqueue(x),claimed=await first.claim();assert.equal(claimed.run_id,valid.run_id);
 const refused=(await db.query('SELECT status,diagnostic FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
 assert.equal(refused.status,'CANCELLED');assert.equal(refused.diagnostic,'AUTHORIZATION_REVOKED');
 await db.transaction(()=>service.get(x.a,valid.run_id,true));await first.reconcile();
});

test('P10 abort after raw publication leaves no binding or pending temporary files',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(continuation),job=await first.claim();
 first.controller=new AbortController();const publish=service.datasetStore.raw.publish.bind(service.datasetStore.raw);
 service.datasetStore.raw.publish=async(...args)=>{const refs=await publish(...args);first.controller.abort();return refs;};
 try{await assert.rejects(first.prepareResearch(job),{code:'DATASET_CANCELLED'});}
 finally{service.datasetStore.raw.publish=publish;}
 assert.equal((await db.query('SELECT count(*)::int n FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0].n,0);
 assert.equal((await datasetListing()).some(name=>name.split(/[\\/]/).some(part=>part.startsWith('.pending-'))),false);
 await db.transaction(()=>service.get(x.a,queued.run_id,true));await first.reconcile();
});

test('P12 capacity policy does not classify research V2 as PROFILE V2',async()=>{
 const x=await baseline(),queued=await enqueue(x),{policy}=profileV2Fixture();
 const first=new QuantResearchFoundationWorker({service,clock:()=>now,health:async()=>({ok:true}),
  evaluateChunk:continuation,stopUnit:async()=>true,capacityPolicy:policy});
 const job=await first.claim();assert.equal(job.run_id,queued.run_id);
 assert.equal(job.foundation.contract.version,'quant-foundation-research-v2');
 await db.transaction(()=>service.get(x.a,queued.run_id,true));await first.reconcile();
});

// QS heavy-path S1: cheap rejections happen before the JSON bar load and before any dataset publication.
const recordSql=async fn=>{
 const sql=[],query=db.query.bind(db);db.query=(text,...rest)=>{sql.push(String(text));return query(text,...rest);};
 try{await fn();}finally{delete db.query;}
 return sql;
};
const datasetListing=async()=>(await fs.readdir(datasetRoot,{recursive:true})).sort();
test('gapped range is rejected by the SQL precheck before bar rows load or files publish',async()=>{
 const start=1800000000000+40000*60000,times=[...Array(3300).keys()].filter(i=>i!==1600);
 const marketBars=times.map(i=>({time:start+i*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'}));
 const x=await baseline({marketBars}),files=await datasetListing();
 const sql=await recordSql(()=>assert.rejects(enqueue(x),{code:'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'}));
 assert.ok(sql.some(text=>text.includes('min(bar_time)')),'range precheck ran');
 assert.ok(!sql.some(text=>text.includes('SELECT * FROM pine_market_bars')),'no bar row was loaded');
 assert.deepEqual(await datasetListing(),files);
 assert.equal((await db.query('SELECT count(*)::int n FROM quant_jobs WHERE owner_id=$1',[x.a])).rows[0].n,0);
});
test('foundation queue full is 429 and precedes every bar read and dataset publication',async()=>{
 const x=await baseline(),files=await datasetListing();
 await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[x.a]);
 for(let i=0;i<20;i++){
  const contract=JSON.stringify({placeholder:i});
  await db.query("INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)",[randomUUID(),x.a,'seed:'+i,contract,hash(contract),now,now+900000]);
 }
 try{
  const sql=await recordSql(()=>assert.rejects(enqueue(x),{code:'FOUNDATION_QUEUE_FULL',status:429}));
  assert.ok(!sql.some(text=>text.includes('pine_market_bars')),'no bar was read');
  assert.deepEqual(await datasetListing(),files);
  assert.equal((await db.query('SELECT count(*)::int n FROM quant_jobs WHERE owner_id=$1',[x.a])).rows[0].n,0);
 }finally{await db.query('DELETE FROM quant_foundation_jobs WHERE owner_id=$1',[x.a]);}
});
test('per-owner research limit precedes every bar read',async()=>{
 const x=await baseline();await enqueue(x);await enqueue(x);
 const sql=await recordSql(()=>assert.rejects(enqueue(x),{code:'QUANT_QUEUE_FULL',status:429}));
 assert.ok(!sql.some(text=>text.includes('pine_market_bars')),'no bar was read');
});
