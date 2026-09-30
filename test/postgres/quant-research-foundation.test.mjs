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
test('real research enqueue publishes references and persists one shared scheduler binding',async()=>{
 const x=await baseline(),queued=await enqueue(x),row=(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0];
 assert.equal(row.contract.execution_backend,'quant-foundation-v1');assert.equal(Object.hasOwn(row.contract.dataset,'bars'),false);
 assert.equal(row.contract.dataset.first_time,x.body.dataset.start_time);assert.equal(row.contract.dataset.references.sidecar.profile,'closed-ohlcv-atr14-v1');
 const refs=row.contract.dataset.references;const stream=service.datasetStore.read(refs,{start:0,end:1});assert.equal((await stream.next()).value.atr14,'2');
 const binding=(await db.query('SELECT * FROM quant_research_foundation WHERE run_id=$1',[queued.run_id])).rows[0];assert.equal(binding.contract_hash,row.contract_hash);
 assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[binding.job_id])).rows[0].status,'QUEUED');
 await assert.rejects(new QuantResearchWorker({service}).claim(),{code:'RESEARCH_FOUNDATION_WORKER_REQUIRED'});
 await assert.rejects(db.query("UPDATE quant_research_executor_mode SET mode='LEGACY'"),/drain/);
 await db.transaction(()=>service.get(x.a,queued.run_id,true));
});
test('durable real step checkpoint resumes without prefix replay; old lease cannot publish',async()=>{
 const x=await baseline(),queued=await enqueue(x);let calls=0;
 const first=worker(payload=>{if(++calls===2)throw Object.assign(Error('fixture interruption'),{stopped:true});return continuation(payload);});
 const old=await first.claim();first.controller=new AbortController();
 await assert.rejects(first.step(old,'candidate:000','CANDIDATE',old.contract.plan.candidates[0]),/fixture interruption/);
 const chunk=(await db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0];assert.equal(chunk.next_bar,1000);assert.equal(chunk.checkpoint.paper.cash,'1000');
 assert.equal((await db.query('SELECT evaluations_started FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0].evaluations_started,1);
 await first.scheduler.pause(old.foundation);
 const starts=[],second=worker(payload=>{starts.push(payload.rows[0].time);return continuation(payload);});
 const resumed=await second.claim();second.controller=new AbortController();assert.notEqual(resumed.lease_token,old.lease_token);
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
 const job=await first.claim();first.controller=new AbortController();
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
 const x=await baseline();await enqueue(x);const first=worker(continuation),job=await first.claim();
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
 const job=await actual.claim();actual.controller=new AbortController();
 assert.equal(job.contract.dataset.bar_count,4533);assert.equal(Object.hasOwn(job.contract.dataset,'bars'),false);
 assert.deepEqual(job.contract.input_lock.baseline,approved.input_lock.baseline);
 const parameters=job.contract.input_lock.baseline;
 const expected=await pythonEvaluation({...job.contract,dataset:{...job.contract.dataset,bars:exposed}},parameters,'CANDIDATE',new AbortController().signal,{python});
 const result=await actual.step(job,'candidate:000','CANDIDATE',parameters);
 assert.deepEqual(result,expected);assert.equal(Object.hasOwn(result,'test'),false);
 const steps=await actual.steps(job);assert.equal(steps.length,1);assert.equal(steps[0].kind,'CANDIDATE');
 const chunk=(await db.query('SELECT next_bar,unit_name,checkpoint FROM quant_research_chunks WHERE run_id=$1',[queued.run_id])).rows[0];
 assert.equal(chunk.next_bar,job.contract.split.validation_end);assert.equal(chunk.unit_name,null);assert.equal(chunk.checkpoint.next_bar,job.contract.split.validation_end);
 assert.equal((await db.query('SELECT evaluations_started FROM quant_jobs WHERE run_id=$1',[queued.run_id])).rows[0].evaluations_started,1);
 await actual.finish(job,'NO_VALID_CANDIDATE',{scope:'BASELINE_ADAPTER_ENGINEERING_CHECK_ONLY',holdout_evaluated:false,owner_recommendation_ready:false});
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
