import test,{mock} from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService,pineBridgeRoutes} from '../../src/postgres/pine-bridge.js';
import {PineBridgeWorker} from '../../src/postgres/pine-bridge-worker.js';
import {DirectProvider} from '../../src/pine-bridge/gemini.js';
import {fail} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {smallSource,SMALL_SIGNALS,PROVIDER_CONFIG} from '../helpers/pine-bridge-selection-gates-fixture.mjs';
import {sha256Hex,canonicalForm,bridgePrefix,fakeHttpsRequest,chatBody,routeRequest,jsonSink} from '../helpers/pine-bridge-generation-gaps-fixture.mjs';

/**
 * PM-1 F02-01 gap tests (docs/PINE_BRIDGE_ADAPTER_API.md, "Durable AI jobs and bounded cost", "Lightweight authenticated API"):
 *   C1  analyze route: a source revision must be exactly the next version (SOURCE_VERSION_CONFLICT, 409); a version without an import
 *       is INVALID_SOURCE_VERSION; refusals write nothing;
 *   C5  assembly refusals reach the worker: the job ends FAILED with the refusal code and no deployment row exists;
 *   C6  the guide text survives into the stored job result;
 *   C7  artifact_hash is the SHA-256 of the integrated Pine, and the snapshot hash and identity fields are what the doc lists;
 *   C8  PROVIDER_BUDGET_VIOLATION and PROVIDER_CONFIG_CHANGED end a job FAILED without retry; the OpenAI-compatible HTTP mapping runs
 *       through the real worker and DirectProvider against a fake node:https request, never a real provider;
 *   C9  worker branches: the deadline reached inside finish(), and Retry-After limits (more than 30 s, no room before the deadline).
 * Hashes are computed in the test with node:crypto, not through the code under test. Expected codes are literals.
 * Synthetic fixtures only; no provider call, no provider key, no network beyond the isolated 127.0.0.1 PostgreSQL.
 */
let admin,db,store,pine,databaseName;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='pine_bridge_gaps_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','pine-capture-schema.sql'])await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  store=new Store(db);
  pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider:()=>PROVIDER_CONFIG});
  await installQuantGuards(db);
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});

// ---- helpers ------------------------------------------------------------------------------------------------------------------
async function newOwner(){
  const id=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  await store.setRisk(id,{...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2,equities:{'binance-global':1000},balances:{'binance-global':1000}});
  return id;
}
const one=async(sql,...args)=>db.prepare(sql).get(...args);
const count=async(sql,...args)=>Number((await one(sql,...args)).n);
const enqueue=(owner,operation,body,key=randomUUID(),service=pine)=>db.transaction(()=>service.enqueue(owner,operation,body,key));
const view=(owner,jobId,service=pine)=>db.transaction(()=>service.get(owner,jobId));
/** A queued job is cancelled so it never counts toward the shared queue limit of a later test. */
const settle=async(owner,jobId,service=pine)=>{await db.transaction(()=>service.get(owner,jobId,true));};
const answer=(request,over={})=>({
  value:{buy:'buy',exit:'sell',diagnostics:[],...(request.operation==='analyze'?{eligible_inputs:request.analysis.inputs.filter(i=>i.eligible).map(i=>i.input_id)}:{})},
  usage:{input_tokens:50,output_tokens:30,cost_usd:.000011},request_id:'fixture',...over
});
/** Provider stub: `calls` lists the operation of every dispatch; `behave(request)` may return a response or throw. */
function stub(behave){
  const calls=[];
  return {calls,run:async(request,source,options)=>{calls.push(request.operation);return behave?behave(request,source,options):answer(request);}};
}
async function drain(worker){for(let i=0;i<30&&await worker.tick();i++);}
const runAll=async(provider,clock)=>drain(new PineBridgeWorker({service:pine,provider,...(clock?{clock}:{})}));
/** Analyse a source through the real enqueue and worker path; returns the registered import id. */
async function analysed(owner,{source=smallSource,provider=stub()}={}){
  const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:source,source_name:'F02-01 gaps'});
  await runAll(provider);
  assert.equal((await view(owner,job.job_id)).job_status,'SUCCEEDED');
  return job.pine_import_id;
}
const generateBody=(owner,importId,over={})=>({bot_id:owner,pine_import_id:importId,source_version:1,selected_signals:SMALL_SIGNALS,parameter_slots:[],bridge_options:{atr_multiplier:2,rr:1.5},market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'},...over});
async function withEnv(vars,callback){
  const saved={};
  for(const key of Object.keys(vars)){saved[key]=process.env[key];if(vars[key]===undefined)delete process.env[key];else process.env[key]=vars[key];}
  try{return await callback();}
  finally{for(const key of Object.keys(saved)){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
}
async function route(owner,operation,body,{key=randomUUID()}={}){
  const {sink,json}=jsonSink(),path='/api/quant/pine-bridge/'+operation;
  await db.transaction(()=>pineBridgeRoutes(routeRequest({path,body,key}),{},new URL('http://localhost'+path),{id:owner},pine,json,{enabled:true}));
  return sink;
}

// ---- C1: analyze route, source versioning ----------------------------------------------------------------------------------------
test('analyze route: a revision must be exactly the next version, and every refusal writes nothing',async()=>{
  const owner=await newOwner();
  const first=await route(owner,'analyze',{bot_id:owner,pine_source:smallSource,source_name:'v1'});
  assert.equal(first.status,202);assert.equal(first.body.source_version,1);
  const importId=first.body.pine_import_id;
  await runAll(stub());
  const revision=(version,over={})=>({bot_id:owner,pine_source:smallSource+'\n// revision '+version,source_name:'revision',pine_import_id:importId,source_version:version,...over});
  const state=async()=>({
    jobs:await count('SELECT count(*) n FROM pine_bridge_jobs WHERE owner_id=?',owner),
    revisions:await count('SELECT count(*) n FROM pine_source_revisions WHERE pine_import_id=?',importId),
    current:(await one('SELECT source_version FROM pine_memberships WHERE pine_import_id=?',importId)).source_version
  });
  assert.deepEqual(await state(),{jobs:1,revisions:1,current:1});

  // Current version is 1, so only 2 is next. A skipped version is a conflict (409); a repeated or invalid number fails number validation.
  await assert.rejects(route(owner,'analyze',revision(3)),{code:'SOURCE_VERSION_CONFLICT',status:409});
  await assert.rejects(route(owner,'analyze',revision(100)),{code:'SOURCE_VERSION_CONFLICT',status:409});
  for(const bad of [1,0,-1,1.5,'2',null,2147483648])
    await assert.rejects(route(owner,'analyze',revision(bad)),{code:'INVALID_NUMERIC_VALUE',status:400},JSON.stringify(bad));
  const missing=revision(2);delete missing.source_version;
  await assert.rejects(route(owner,'analyze',missing),{code:'INVALID_NUMERIC_VALUE',status:400});
  assert.deepEqual(await state(),{jobs:1,revisions:1,current:1},'refusals leave jobs, revisions and the current version untouched');

  // The next version is accepted and moves the current version; the same number is then a conflict, the one after it is accepted.
  const second=await route(owner,'analyze',revision(2));
  assert.equal(second.status,202);assert.equal(second.body.source_version,2);assert.equal(second.body.pine_import_id,importId);
  await runAll(stub());
  assert.deepEqual(await state(),{jobs:2,revisions:2,current:2});
  await assert.rejects(route(owner,'analyze',revision(2)),{code:'SOURCE_VERSION_CONFLICT',status:409});
  await assert.rejects(route(owner,'analyze',revision(4)),{code:'SOURCE_VERSION_CONFLICT',status:409});
  const third=await route(owner,'analyze',revision(3));
  assert.equal(third.status,202);assert.equal(third.body.source_version,3);
  await runAll(stub());
  assert.deepEqual(await state(),{jobs:3,revisions:3,current:3});

  // Revisions are immutable: version 1 still carries the bytes first submitted.
  const original=await one('SELECT source,source_hash FROM pine_source_revisions WHERE pine_import_id=? AND source_version=1',importId);
  assert.equal(original.source,smallSource);assert.equal(original.source_hash,sha256Hex(smallSource));
});
test('analyze route: a version without an import is INVALID_SOURCE_VERSION; an unknown or foreign import is NOT_FOUND',async()=>{
  const owner=await newOwner(),other=await newOwner();
  const importId=await analysed(owner);
  const sources=()=>count('SELECT count(*) n FROM pine_sources WHERE owner_id=?',owner);
  const before={sources:await sources(),jobs:await count('SELECT count(*) n FROM pine_bridge_jobs WHERE owner_id=?',owner)};
  for(const version of [1,2,5,null])
    await assert.rejects(route(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// new '+version,source_name:'new',source_version:version}),{code:'INVALID_SOURCE_VERSION',status:400},JSON.stringify(version));
  await assert.rejects(route(owner,'analyze',{bot_id:owner,pine_source:smallSource,source_name:'unknown',pine_import_id:randomUUID(),source_version:2}),{code:'NOT_FOUND',status:404});
  await assert.rejects(route(other,'analyze',{bot_id:other,pine_source:smallSource,source_name:'foreign',pine_import_id:importId,source_version:2}),{code:'NOT_FOUND',status:404});
  assert.deepEqual({sources:await sources(),jobs:await count('SELECT count(*) n FROM pine_bridge_jobs WHERE owner_id=?',owner)},before);
  assert.equal(await count('SELECT count(*) n FROM pine_sources WHERE owner_id=?',other),0);
});

// ---- C5/C7/C6: generation result, snapshot identity, guide text, assembly refusals through the worker ------------------------------------
test('generation stores a DRAFT whose artifact_hash is the SHA-256 of the integrated Pine and whose snapshot carries the registered identity',async()=>{
  const owner=await newOwner(),importId=await analysed(owner);
  const job=await enqueue(owner,'generate',generateBody(owner,importId));
  await runAll(stub());
  const done=await view(owner,job.job_id);
  assert.equal(done.job_status,'SUCCEEDED');
  const result=done.result,deployment=await one('SELECT * FROM pine_deployments WHERE deployment_id=?',result.deployment_id);
  assert.equal(deployment.state,'DRAFT');assert.equal(result.artifact_status,'DRAFT');
  assert.equal(deployment.snapshot.artifact_hash,sha256Hex(result.integrated_pine),'artifact_hash is the SHA-256 of integrated_pine, recomputed here');
  assert.notEqual(deployment.snapshot.artifact_hash,sha256Hex(smallSource),'the artifact is the source plus the Bridge block, not the source alone');
  assert.equal(deployment.snapshot.source_hash,sha256Hex(smallSource));assert.equal(result.source_hash,sha256Hex(smallSource));
  assert.equal(deployment.snapshot_hash,sha256Hex(canonicalForm(deployment.snapshot)),'snapshot_hash is the SHA-256 of the canonical snapshot');
  assert.deepEqual(deployment.snapshot.market,{deployment_id:result.deployment_id,pine_import_id:importId,source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'});
  assert.deepEqual(deployment.snapshot.instruction_versions,{prompt:'bridge-prompt-v3',guide:'bridge-guide-v4',template:'bridge-exit-v3',parser:'pine-static-v1',bridge:'indicator-bridge-v2',quant:'quant-evaluator-v1'});
  assert.deepEqual(deployment.snapshot.selection.signals,SMALL_SIGNALS);
  for(const key of ['policy','policy_hash','capital','membership','selection','market','source_hash','instruction_versions','artifact_hash'])assert.ok(Object.hasOwn(deployment.snapshot,key),'snapshot has '+key);
  // The namespaced identifiers in the block and the two Bridge bindings use the prefix derived from the stored deployment id.
  const prefix=bridgePrefix(result.deployment_id);
  assert.ok(result.integrated_pine.startsWith(smallSource));
  assert.ok(result.integrated_pine.slice(smallSource.length).includes(prefix+'atrMult = input.float(2,'));
  assert.deepEqual(result.bindings.slice(0,2).map(b=>[b.slot,b.origin,b.pine_variable]),[[1,'bridge',prefix+'atrMult'],[2,'bridge',prefix+'rr']]);
  assert.deepEqual(result.source_diff,{changed_original_bytes:0,appended_bytes:Buffer.byteLength(result.integrated_pine.slice(smallSource.length))});
  assert.equal(await count("SELECT count(*) n FROM signals WHERE user_id=?",owner),0,'generation creates no signal');
});
test('the stored job result carries the integration guide with its reviewed instructions',async()=>{
  const owner=await newOwner(),importId=await analysed(owner);
  const job=await enqueue(owner,'generate',generateBody(owner,importId));
  await runAll(stub());
  const guide=(await view(owner,job.job_id)).result.webhook_setup;
  for(const phrase of [
    'DRAFT — do not activate an alert yet.','Compile this complete indicator in TradingView and review every warning.',
    'Use standard BINANCE:BTCUSDT Spot candles at chart timeframe 1D.','disable native alert() calls through existing inputs','Any alert() function call',
    'private /webhooks/pine-bridge/v2/ URL','Missing verified bars wait up to five seconds without creating a Paper order',
    'Protection is observed at bar close, starting the next bar; SL wins over TP and native exits.','Replacing alerts requires a new deployment and preserved old exits.','No Quant support is implied.'
  ])assert.ok(guide.includes(phrase),'guide lacks: '+phrase);
});
test('an assembly refusal during generation fails the job with its code and stores no deployment',async()=>{
  const COLLIDING_ID='aaaaaaaa-1111-2222-3333-444444444444';
  const collidingSource=smallSource+'\n'+bridgePrefix(COLLIDING_ID)+'atr = 1';
  const cases=[
    {code:'INVALID_MARKET',path:'{deployment,symbol}',value:'"btc"'},
    {code:'INVALID_MARKET',path:'{deployment,broker}',value:'"binance-futures"'},
    {code:'INVALID_DEPLOYMENT_ID',path:'{deployment,pine_import_id}',value:'"not-a-uuid"'},
    {code:'IDENTIFIER_COLLISION',path:'{deployment,deployment_id}',value:JSON.stringify(COLLIDING_ID),source:collidingSource}
  ];
  for(const item of cases) {
    const owner=await newOwner(),importId=await analysed(owner,{source:item.source});
    const job=await enqueue(owner,'generate',generateBody(owner,importId));
    // The service validates the market before it freezes the job, so the refusal reaches assembly only through a changed frozen request.
    await db.prepare('UPDATE pine_bridge_jobs SET request=jsonb_set(request,?::text[],?::jsonb) WHERE job_id=?').run(item.path,item.value,job.job_id);
    const provider=stub();await runAll(provider);
    const done=await view(owner,job.job_id);
    assert.equal(done.job_status,'FAILED',item.code);assert.equal(done.diagnostic,item.code);assert.equal(done.result,null);
    assert.equal(done.attempts,1,item.code+': no retry');assert.deepEqual(provider.calls,['generate'],item.code+': one dispatch');
    assert.equal(done.usage.length,1,item.code+': usage of the dispatch stays accounted');
    assert.equal(await count('SELECT count(*) n FROM pine_deployments WHERE owner_id=?',owner),0,item.code+': no deployment row');
  }
});

// ---- C8: PROVIDER_BUDGET_VIOLATION -----------------------------------------------------------------------------------------------
test('usage beyond the frozen budget, or unusable usage, fails the job with PROVIDER_BUDGET_VIOLATION without retry',async()=>{
  const cases=[
    ['input tokens above the counted input',b=>({input_tokens:b.input_tokens+1,output_tokens:30,cost_usd:.000011})],
    ['output tokens above 4000',()=>({input_tokens:50,output_tokens:4001,cost_usd:.000011})],
    ['cost above half the reserved USD',b=>({input_tokens:50,output_tokens:30,cost_usd:b.reserved_usd/2+.000001})],
    ['negative input tokens',()=>({input_tokens:-1,output_tokens:30,cost_usd:.000011})],
    ['negative output tokens',()=>({input_tokens:50,output_tokens:-1,cost_usd:.000011})],
    ['fractional output tokens',()=>({input_tokens:50,output_tokens:1.5,cost_usd:.000011})],
    ['negative cost',()=>({input_tokens:50,output_tokens:30,cost_usd:-0.000001})],
    ['cost not a number',()=>({input_tokens:50,output_tokens:30,cost_usd:NaN})],
    ['no usage at all',()=>undefined]
  ];
  for(const [label,usageFor] of cases) {
    const owner=await newOwner(),importId=await analysed(owner);
    const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// '+label,source_name:'budget',pine_import_id:importId,source_version:2});
    const provider=stub(request=>answer(request,{usage:usageFor(request.budget)}));
    await runAll(provider);
    const done=await view(owner,job.job_id);
    assert.equal(done.job_status,'FAILED',label);assert.equal(done.diagnostic,'PROVIDER_BUDGET_VIOLATION',label);assert.equal(done.result,null,label);
    assert.equal(done.attempts,1,label);assert.deepEqual(provider.calls,['analyze'],label+': never resent');
    assert.equal(done.attempt_details[0].outcome,'RESPONSE_RECEIVED',label);
    assert.equal(done.usage.length,label==='no usage at all'?0:1,label+': a reported usage is kept even when refused');
  }
});
test('usage exactly at the frozen budget is accepted, and an over-budget generation stores no deployment',async()=>{
  const owner=await newOwner(),importId=await analysed(owner);
  const edge=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// edge',source_name:'edge',pine_import_id:importId,source_version:2});
  await runAll(stub(request=>answer(request,{usage:{input_tokens:request.budget.input_tokens,output_tokens:4000,cost_usd:request.budget.reserved_usd/2}})));
  assert.equal((await view(owner,edge.job_id)).job_status,'SUCCEEDED');
  const job=await enqueue(owner,'generate',generateBody(owner,importId,{source_version:2}));
  await runAll(stub(request=>answer(request,{usage:{input_tokens:request.budget.input_tokens+1,output_tokens:30,cost_usd:.000011}})));
  const done=await view(owner,job.job_id);
  assert.equal(done.job_status,'FAILED');assert.equal(done.diagnostic,'PROVIDER_BUDGET_VIOLATION');
  assert.equal(await count('SELECT count(*) n FROM pine_deployments WHERE owner_id=?',owner),0);
});

// ---- C8: real DirectProvider through the worker: PROVIDER_CONFIG_CHANGED and the OpenAI-compatible HTTP mapping --------------------------
const OPENAI_CONFIG={provider:'openai-chat',model:'gpt-4.1-mini',inputRate:.4,outputRate:1.6,rateVersion:'fixture-v1'};
const GEMINI_CONFIG={provider:'gemini',model:'gemini-3.8-flash',inputRate:.75,outputRate:3.75,rateVersion:'fixture-v1'};
const OPENAI_ENV={PINE_AI_PROVIDER:'openai-chat',PINE_AI_MODEL:'gpt-4.1-mini',PINE_AI_API_KEY:'fixture-not-real'};
const serviceFor=configuration=>new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider:()=>configuration});
/** One queued analysis for the service, then run the real DirectProvider worker with a controllable clock. */
async function directJob(service,plan,{env=OPENAI_ENV,clock=()=>Date.now(),passes=1}={}){
  const owner=await newOwner();
  const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource,source_name:'direct'},randomUUID(),service);
  const fake=fakeHttpsRequest(plan);
  const spy=mock.method(https,'request',fake.impl);
  const fetched=mock.method(globalThis,'fetch',async()=>{throw new Error('no network in this test');});
  const worker=new PineBridgeWorker({service,clock});
  try{await withEnv(env,async()=>{for(let i=0;i<passes;i++)await drain(worker);});}
  finally{spy.mock.restore();fetched.mock.restore();}
  return {owner,job,service,fake,fetched:fetched.mock.callCount(),done:await view(owner,job.job_id,service)};
}
test('a model or provider changed after the job was frozen fails the job with PROVIDER_CONFIG_CHANGED before any request',async()=>{
  const changed=await directJob(serviceFor(OPENAI_CONFIG),[{status:200,body:chatBody()}],{env:{...OPENAI_ENV,PINE_AI_MODEL:'gpt-4.1'}});
  assert.equal(changed.done.job_status,'FAILED');assert.equal(changed.done.diagnostic,'PROVIDER_CONFIG_CHANGED');
  assert.equal(changed.done.attempts,1);assert.equal(changed.done.result,null);assert.equal(changed.fake.calls.length,0);assert.equal(changed.fetched,0);
  assert.equal(changed.done.attempt_details[0].outcome,'PROVIDER_CONFIG_CHANGED');assert.equal(changed.done.usage.length,0);
  const gemini=await directJob(serviceFor(GEMINI_CONFIG),[{status:200,body:chatBody()}],{env:{...OPENAI_ENV,PINE_AI_PROVIDER:'openai-chat'}});
  assert.equal(gemini.done.job_status,'FAILED');assert.equal(gemini.done.diagnostic,'PROVIDER_CONFIG_CHANGED');
  assert.equal(gemini.fake.calls.length,0);assert.equal(gemini.fetched,0);
});
test('a provider the service does not know fails the job with AI_PROVIDER_NOT_CONFIGURED and makes no request',async()=>{
  const unknown=await directJob(serviceFor({...OPENAI_CONFIG,provider:'fixture-unknown'}),[{status:200,body:chatBody()}]);
  assert.equal(unknown.done.job_status,'FAILED');assert.equal(unknown.done.diagnostic,'AI_PROVIDER_NOT_CONFIGURED');
  assert.equal(unknown.fake.calls.length,0);assert.equal(unknown.fetched,0);
});
test('HTTP 5xx from an OpenAI-compatible provider ends OUTCOME_UNKNOWN and is never resent',async()=>{
  const run=await directJob(serviceFor(OPENAI_CONFIG),[{status:503,body:'busy'},{status:200,body:chatBody()}],{passes:3});
  assert.equal(run.done.job_status,'OUTCOME_UNKNOWN');assert.equal(run.done.diagnostic,'OUTCOME_UNKNOWN');
  assert.equal(run.fake.calls.length,1,'one dispatch in three worker passes');assert.equal(run.done.attempts,1);assert.equal(run.done.result,null);
});
test('HTTP 429 with Retry-After retries once after the delay; more than 30 seconds ends FAILED',async()=>{
  let now=Date.now();
  const retried=await directJob(serviceFor(OPENAI_CONFIG),[{status:429,headers:{'retry-after':'3'},body:''},{status:200,body:chatBody({content:{buy:'buy',exit:'sell',diagnostics:[],eligible_inputs:[]}})}],{clock:()=>now});
  assert.equal(retried.done.job_status,'RETRY_WAIT');assert.equal(retried.done.attempts,1);
  assert.equal((await one('SELECT next_attempt FROM pine_bridge_jobs WHERE job_id=?',retried.job.job_id)).next_attempt,now+3000);
  assert.equal(retried.fake.calls.length,1);
  // Before the delay the job is not claimed; after it the second dispatch succeeds.
  const worker=new PineBridgeWorker({service:pine,clock:()=>now}),second=fakeHttpsRequest([{status:200,body:chatBody({content:{buy:'buy',exit:'sell',diagnostics:[],eligible_inputs:[]}})}]);
  const spy=mock.method(https,'request',second.impl);
  try{
    await withEnv(OPENAI_ENV,async()=>{
      // The first service froze OPENAI_CONFIG; this worker uses the same store and the real DirectProvider.
      now+=2999;await drain(worker);assert.equal(second.calls.length,0,'not claimed before next_attempt');
      now+=1;await drain(worker);
    });
  }finally{spy.mock.restore();}
  const done=await view(retried.owner,retried.job.job_id);
  assert.equal(done.job_status,'SUCCEEDED');assert.equal(done.attempts,2);assert.equal(second.calls.length,1);
  const long=await directJob(serviceFor(OPENAI_CONFIG),[{status:429,headers:{'retry-after':'31'},body:''},{status:200,body:chatBody()}],{passes:3});
  assert.equal(long.done.job_status,'FAILED');assert.equal(long.done.diagnostic,'PROVIDER_RATE_LIMIT');assert.equal(long.done.attempts,1);
  assert.equal(long.fake.calls.length,1);
  await settle(retried.owner,retried.job.job_id);
});
test('HTTP 400, a non-stop finish and missing usage end the job without retry and keep what was reported',async()=>{
  const rejected=await directJob(serviceFor(OPENAI_CONFIG),[{status:400,body:'bad'},{status:200,body:chatBody()}],{passes:3});
  assert.equal(rejected.done.job_status,'FAILED');assert.equal(rejected.done.diagnostic,'PROVIDER_REJECTED');assert.equal(rejected.fake.calls.length,1);assert.equal(rejected.done.attempts,1);
  const truncated=await directJob(serviceFor(OPENAI_CONFIG),[{status:200,body:chatBody({finish:'length'})},{status:200,body:chatBody()}],{passes:3});
  assert.equal(truncated.done.job_status,'FAILED');assert.equal(truncated.done.diagnostic,'INVALID_AI_OUTPUT');assert.equal(truncated.fake.calls.length,1);
  assert.equal(truncated.done.usage.length,1,'usage of the truncated answer is accounted');
  assert.equal(truncated.done.usage[0].input_tokens,100);assert.equal(truncated.done.usage[0].output_tokens,50);assert.equal(truncated.done.result,null);
  const noUsage=await directJob(serviceFor(OPENAI_CONFIG),[{status:200,body:chatBody({usage:undefined})},{status:200,body:chatBody()}],{passes:3});
  assert.equal(noUsage.done.job_status,'OUTCOME_UNKNOWN');assert.equal(noUsage.done.diagnostic,'PROVIDER_USAGE_UNKNOWN');assert.equal(noUsage.fake.calls.length,1);
});

// ---- C9: worker branches ---------------------------------------------------------------------------------------------------------------
/** Worker clock that follows real time until a provider callback pins it. */
function pinnedClock(){const state={at:null};return {state,clock:()=>state.at??Date.now()};}
async function deadlineOf(jobId){return Number((await one('SELECT deadline FROM pine_bridge_jobs WHERE job_id=?',jobId)).deadline);}

test('a deadline reached inside finish() times the job out even when the provider answered; one millisecond earlier it succeeds',async()=>{
  for(const [label,offset,expected] of [['past the deadline',1000,'TIMED_OUT'],['exactly at the deadline',0,'TIMED_OUT'],['one millisecond before the deadline',-1,'SUCCEEDED']]) {
    const owner=await newOwner(),importId=await analysed(owner);
    const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// '+label,source_name:'deadline',pine_import_id:importId,source_version:2});
    const deadline=await deadlineOf(job.job_id),{state,clock}=pinnedClock();
    const provider=stub(request=>{state.at=deadline+offset;return answer(request);});
    await runAll(provider,clock);
    const done=await view(owner,job.job_id);
    assert.equal(done.job_status,expected,label);
    assert.equal(done.usage.length,1,label+': usage of the answer is accounted');assert.equal(done.attempt_details[0].outcome,'RESPONSE_RECEIVED',label);
    if(expected==='TIMED_OUT') {
      assert.equal(done.diagnostic,'JOB_DEADLINE_EXCEEDED',label);assert.equal(done.result,null,label);
      assert.deepEqual(provider.calls,['analyze'],label+': a timed-out job is never dispatched again');
    }
  }
});
test('a generation answered after the deadline stores no deployment',async()=>{
  const owner=await newOwner(),importId=await analysed(owner);
  const job=await enqueue(owner,'generate',generateBody(owner,importId));
  const deadline=await deadlineOf(job.job_id),{state,clock}=pinnedClock();
  await runAll(stub(request=>{state.at=deadline+1;return answer(request);}),clock);
  const done=await view(owner,job.job_id);
  assert.equal(done.job_status,'TIMED_OUT');assert.equal(done.diagnostic,'JOB_DEADLINE_EXCEEDED');assert.equal(done.result,null);
  assert.equal(await count('SELECT count(*) n FROM pine_deployments WHERE owner_id=?',owner),0);
});
test('past the deadline a rate limit or unknown outcome is a timeout, not a retry or an unknown outcome',async()=>{
  for(const [label,error] of [['rate limit',()=>Object.assign(fail('PROVIDER_RATE_LIMIT'),{retryAfter:2})],['unknown outcome',()=>fail('OUTCOME_UNKNOWN')]]) {
    const owner=await newOwner(),importId=await analysed(owner);
    const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// '+label,source_name:'late error',pine_import_id:importId,source_version:2});
    const deadline=await deadlineOf(job.job_id),{state,clock}=pinnedClock();
    await runAll(stub(()=>{state.at=deadline+1;throw error();}),clock);
    const done=await view(owner,job.job_id);
    assert.equal(done.job_status,'TIMED_OUT',label);assert.equal(done.diagnostic,'JOB_DEADLINE_EXCEEDED',label);
    assert.equal((await one('SELECT next_attempt FROM pine_bridge_jobs WHERE job_id=?',job.job_id)).next_attempt,0,label);
  }
});
test('Retry-After: up to 30 seconds waits at least 2 seconds; above 30, unusable, or without room before the deadline ends FAILED',async()=>{
  const rateLimit=retryAfter=>()=>{throw Object.assign(fail('PROVIDER_RATE_LIMIT'),{retryAfter});};
  const cases=[
    ['30 seconds',30,null,'RETRY_WAIT',30000],['2 seconds',2,null,'RETRY_WAIT',2000],['1 second is raised to 2',1,null,'RETRY_WAIT',2000],['0 is raised to 2',0,null,'RETRY_WAIT',2000],
    ['30.5 seconds',30.5,null,'FAILED',0],['31 seconds',31,null,'FAILED',0],['120 seconds',120,null,'FAILED',0],
    ['NaN',NaN,null,'FAILED',0],['Infinity',Infinity,null,'FAILED',0],['no value',undefined,null,'FAILED',0],
    ['room for 2 s before the deadline, one ms to spare',2,-2001,'RETRY_WAIT',2000],['retry lands exactly on the deadline',2,-2000,'FAILED',0],['less than the delay left',2,-1500,'FAILED',0],['0 is raised to 2 before the room check',0,-2000,'FAILED',0],['1 is raised to 2 before the room check',1,-1500,'FAILED',0]
  ];
  for(const [label,retryAfter,beforeDeadline,status,delay] of cases) {
    const owner=await newOwner(),importId=await analysed(owner);
    const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// '+label,source_name:'retry after',pine_import_id:importId,source_version:2});
    const deadline=await deadlineOf(job.job_id),{state,clock}=pinnedClock(),start=Date.now();
    const provider=stub(()=>{state.at=beforeDeadline===null?start:deadline+beforeDeadline;return rateLimit(retryAfter)();});
    const worker=new PineBridgeWorker({service:pine,provider,clock});
    await drain(worker);
    const done=await view(owner,job.job_id),row=await one('SELECT next_attempt FROM pine_bridge_jobs WHERE job_id=?',job.job_id);
    assert.equal(done.job_status,status,label);assert.equal(done.attempts,1,label);
    if(status==='RETRY_WAIT')assert.equal(Number(row.next_attempt),state.at+delay,label+': next attempt');
    else {assert.equal(done.diagnostic,'PROVIDER_RATE_LIMIT',label);assert.equal(Number(row.next_attempt),0,label);assert.equal(done.result,null,label);}
    assert.equal(provider.calls.length,1,label+': one dispatch so far');
    if(status==='FAILED'){state.at=deadline-1;await drain(worker);assert.equal(provider.calls.length,1,label+': a failed job is never dispatched again');}
    await settle(owner,job.job_id);
  }
});
test('other provider errors end the job at once: unusable usage is OUTCOME_UNKNOWN, a rejection is FAILED, neither is resent',async()=>{
  for(const [label,code,status] of [['usage unknown','PROVIDER_USAGE_UNKNOWN','OUTCOME_UNKNOWN'],['rejected','PROVIDER_REJECTED','FAILED'],['response too large','PROVIDER_RESPONSE_TOO_LARGE','FAILED'],['token budget','SOURCE_TOKEN_BUDGET_EXCEEDED','FAILED'],['config changed','PROVIDER_CONFIG_CHANGED','FAILED']]) {
    const owner=await newOwner(),importId=await analysed(owner);
    const job=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// '+label,source_name:'errors',pine_import_id:importId,source_version:2});
    const provider=stub(()=>{throw fail(code);});
    const worker=new PineBridgeWorker({service:pine,provider});
    await drain(worker);await drain(worker);
    const done=await view(owner,job.job_id);
    assert.equal(done.job_status,status,label);assert.equal(done.diagnostic,code,label);assert.equal(done.attempts,1,label);assert.equal(provider.calls.length,1,label);
    assert.equal(done.attempt_details[0].outcome,code,label);
  }
});
