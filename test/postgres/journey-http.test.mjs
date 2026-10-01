import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {bridgeOverview,pineBridgeOverviewRoutes} from '../../src/postgres/pine-bridge-overview.js';
import {researchHistory,quantResearchHistoryRoutes} from '../../src/postgres/quant-research-history.js';
import {providerConfig} from '../../src/pine-bridge/provider.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {hash,canonical,fail} from '../../src/pine-bridge/source.js';
import {httpClient} from '../helpers.mjs';
import {fixture,source as fixtureSource} from '../helpers/quant-research-fixture.mjs';

// Journey view APIs (P0 staging preview): read-only, owner-scoped, available while research admission and the Bridge are closed.
const T=Date.UTC(2026,8,1),AI={PINE_AI_MODEL:'gpt-4.1-mini',PINE_AI_API_KEY:'journey-test-not-a-key',PINE_AI_INPUT_USD_PER_MILLION:'0.4',PINE_AI_OUTPUT_USD_PER_MILLION:'1.6',PINE_AI_RATE_VERSION:'journey-test'};
const HIDDEN=['SECRET_SOURCE_TEXT','SECRET_DRAFT_PINE','SECRET_GUIDE','REQUEST_BODY_SECRET','provider-req-secret','idem-secret','idem-run-','journey-test-not-a-key','api.openai.com','SECRET_CONTRACT_SOURCE','BAR_SECRET','STEP_PAYLOAD_SECRET','NESTED_RESULT_SECRET','LEAK_TITLE','FIXED_INPUT_LEAK','PLAN_LEAK','POLICY_SECRET'];
let admin,db,store,databaseName;const children=[];

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_journey_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
  await db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8')));
  store=new Store(db);
});
after(async()=>{
  for(const child of children)if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
  await db?.close();
  if(admin){if(databaseName)await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.close();}
});
const installQuantSchema=async()=>db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/quant-research-schema.sql',import.meta.url),'utf8')));

async function startServer(env){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:db.pool.options.connectionString,HOST:'127.0.0.1',PORT:String(port),
    PUBLIC_ORIGIN:base,SMTP_HOST:'',PINE_BRIDGE_ENABLED:'',QUANT_RESEARCH_ENABLED:'',PINE_AI_MODEL:'',PINE_AI_API_KEY:'',...env}});
  children.push(child);let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let ready=false;
  for(let i=0;i<200&&child.exitCode===null&&!ready;i++){try{await fetch(base+'/healthz');ready=true;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.ok(ready,'server did not start: '+output.slice(-1500));
  return {base,request:httpClient(base),child};
}
async function newOwner(label){
  const password='journey-'+randomUUID(),user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword(password)});
  await store.setRisk(user.id,structuredClone(config.defaultRisk));
  return {id:user.id,email:user.email,password};
}
async function login(server,owner){
  const answer=await server.request('/api/auth/login','POST',{email:owner.email,password:owner.password});
  assert.equal(answer.status,200,JSON.stringify(answer.body));return answer.session;
}

// Seeders write rows directly. Rows carry marker strings in every column the views must never return.
const sourceText=label=>'//@version=6\n// SECRET_SOURCE_TEXT '+label+'\nindicator("x")';
function analysisFor(sourceHash,{reviewed=true}={}){
  const {analysis}=fixture(),copy=structuredClone(analysis);
  if(!reviewed)delete copy.effective_input_review;else copy.effective_input_review.source_hash=sourceHash;
  return copy;
}
async function seedImport(ownerId,name,versions){
  const importId=randomUUID(),first=versions[0];
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,ownerId,first.hash,name,sourceText(name),JSON.stringify(first.analysis),first.at]);
  for(const version of versions)await db.query('INSERT INTO pine_source_revisions VALUES($1,$2,$3,$4,$5,$6)',[importId,version.version,version.hash,sourceText(name+version.version),JSON.stringify(version.analysis),version.at]);
  await db.query('INSERT INTO pine_memberships VALUES($1,$2,$2,$3,TRUE)',[importId,ownerId,versions.at(-1).version]);
  return importId;
}
const revision=(version,at,options)=>{const sourceHash=hash('journey-source-'+version+'-'+at);return {version,at,hash:sourceHash,analysis:analysisFor(sourceHash,options)};};
async function seedDeployment(ownerId,importId,{version=1,state='READY',at,slots=3,bindings}){
  const id=randomUUID(),snapshot={policy:{marker:'POLICY_SECRET'},selection:{signals:{buy:'buy',exit:'sell',timing:'bar_close'},bindings:bindings??Array.from({length:slots},(_,i)=>({slot:i+3,input_id:'in'+i}))},market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'}};
  await db.query('INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8)',
    [id,ownerId,importId,version,JSON.stringify(snapshot),hash(canonical(snapshot)),state,at]);
  return {id,snapshotHash:hash(canonical(snapshot))};
}
async function seedJob(ownerId,importId,{operation,status,at,usage=[],diagnostic=null,result=null,attempt=1}){
  const id=randomUUID();
  await db.query('INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,attempt,result,diagnostic,usage) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14)',
    [id,ownerId,operation,'idem-secret-'+id,hash(id),JSON.stringify({marker:'REQUEST_BODY_SECRET'}),importId,status,at,at+300000,attempt,result&&JSON.stringify(result),diagnostic,JSON.stringify(usage)]);
  await db.query('INSERT INTO pine_bridge_attempts(attempt_id,job_id,dispatched_at,finished_at,outcome,usage,provider_request_id) VALUES($1,$2,$3,$3,$4,$5,$6)',
    [randomUUID(),id,at,'RESPONSE_RECEIVED',JSON.stringify(usage[0]??null),'provider-req-secret-'+id]);
  return id;
}
// Owner A has older rows, B has newer rows (so an unscoped "latest" would leak B), C has nothing.
async function seedBridge(){
  const A=await newOwner('journey-a'),B=await newOwner('journey-b'),C=await newOwner('journey-c');
  const older=await seedImport(A.id,'Older indicator',[revision(1,T)]);
  const mine=await seedImport(A.id,'My indicator',[revision(1,T+1000)]);
  await seedDeployment(A.id,mine,{state:'DRAFT',at:T+1500,slots:1});
  const ready=await seedDeployment(A.id,mine,{state:'READY',at:T+2000,slots:3});
  await seedDeployment(A.id,older,{state:'REVOKED',at:T+500,slots:2});
  await seedJob(A.id,older,{operation:'analyze',status:'FAILED',at:T+100,diagnostic:'INVALID_AI_OUTPUT',usage:[{input_tokens:100,output_tokens:5,cost_usd:0.0001,rate_version:'v1'}]});
  await seedJob(A.id,mine,{operation:'analyze',status:'SUCCEEDED',at:T+1100,result:{kind:'indicator',inputs:[]}});
  const generate=await seedJob(A.id,mine,{operation:'generate',status:'SUCCEEDED',at:T+3000,attempt:2,
    result:{integrated_pine:'SECRET_DRAFT_PINE',webhook_setup:'SECRET_GUIDE'},
    usage:[{input_tokens:1000,output_tokens:400,cost_usd:0.0012,rate_version:'v1'},{input_tokens:200,output_tokens:100,cost_usd:0.0003,rate_version:'v1',note:'extra'}]});
  const theirs=await seedImport(B.id,'B indicator',[revision(1,T+50000)]);
  const theirReady=await seedDeployment(B.id,theirs,{at:T+51000,slots:5});
  await seedJob(B.id,theirs,{operation:'generate',status:'QUEUED',at:T+52000});
  return {A,B,C,older,mine,ready,generate,theirs,theirReady};
}

const noMarkers=(body,seed)=>{
  const text=JSON.stringify(body);
  for(const marker of HIDDEN)assert.ok(!text.includes(marker),'leaked '+marker);
  if(seed)for(const id of seed)assert.ok(!text.includes(id),'leaked another owner value '+id);
};
let seed,bridgeServer;

test('overview: owner-scoped whitelist for a configured Bridge; bot_id ignored; GET only',async()=>{
  seed=await seedBridge();
  bridgeServer=await startServer({PINE_BRIDGE_ENABLED:'1',...AI});
  const server=bridgeServer,path='/api/quant/pine-bridge/overview';
  assert.equal((await server.request(path)).status,401);
  const session=await login(server,seed.A);
  const answer=await server.request(path,'GET',undefined,session);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.deepEqual(Object.keys(body).sort(),['ai','bridge_enabled','capture_enabled','deployments','jobs','sources']);
  assert.deepEqual(body.ai,{provider:'openai-chat',model:'gpt-4.1-mini',configured:true});
  assert.equal(body.bridge_enabled,true);assert.equal(body.capture_enabled,false);
  assert.equal(body.sources.count,2);
  assert.deepEqual(Object.keys(body.sources.latest).sort(),['created_at','numeric_inputs','pine_import_id','source_hash','source_name','source_version']);
  assert.equal(body.sources.latest.pine_import_id,seed.mine);assert.equal(body.sources.latest.source_name,'My indicator');
  assert.equal(body.sources.latest.source_version,1);assert.equal(body.sources.latest.created_at,T+1000);
  assert.match(body.sources.latest.source_hash,/^[a-f0-9]{64}$/);
  assert.deepEqual(body.sources.latest.numeric_inputs,{total:10,eligible:8,reviewed:true,selected_slots:3});
  assert.deepEqual(body.jobs.by_status,{FAILED:1,SUCCEEDED:2});
  assert.deepEqual(Object.keys(body.jobs.latest).sort(),['attempts','created_at','diagnostic','has_draft','job_id','job_status','operation','updated_at','usage_summary']);
  assert.equal(body.jobs.latest.job_id,seed.generate);assert.equal(body.jobs.latest.operation,'generate');assert.equal(body.jobs.latest.job_status,'SUCCEEDED');
  assert.equal(body.jobs.latest.attempts,2);assert.equal(body.jobs.latest.has_draft,true);assert.equal(body.jobs.latest.diagnostic,null);
  assert.deepEqual(body.jobs.latest.usage_summary,{input_tokens:1200,output_tokens:500,cost_usd:0.0015});
  assert.deepEqual(body.deployments.by_state,{DRAFT:1,READY:1,REVOKED:1});
  assert.deepEqual(body.deployments.latest_ready,{deployment_id:seed.ready.id,source_version:1,snapshot_hash:seed.ready.snapshotHash,created_at:T+2000});
  noMarkers(body,[seed.B.id,seed.theirs,seed.theirReady.id]);
  // Another owner sees only its own, newer rows; an owner without rows gets explicit empty values.
  const other=await server.request(path,'GET',undefined,await login(server,seed.B));
  assert.equal(other.body.sources.count,1);assert.equal(other.body.sources.latest.pine_import_id,seed.theirs);
  assert.deepEqual(other.body.sources.latest.numeric_inputs,{total:10,eligible:8,reviewed:true,selected_slots:5});
  assert.deepEqual(other.body.jobs.by_status,{QUEUED:1});assert.equal(other.body.jobs.latest.has_draft,false);assert.equal(other.body.jobs.latest.usage_summary,null);
  assert.equal(other.body.deployments.latest_ready.deployment_id,seed.theirReady.id);
  noMarkers(other.body,[seed.A.id,seed.mine,seed.older,seed.ready.id,seed.generate]);
  const empty=await server.request(path,'GET',undefined,await login(server,seed.C));
  assert.deepEqual(empty.body.sources,{count:0,latest:null});assert.deepEqual(empty.body.jobs,{by_status:{},latest:null});
  assert.deepEqual(empty.body.deployments,{by_state:{},latest_ready:null});
  // The shared api() helper adds bot_id: ignored. Anything else is rejected before a query runs.
  assert.deepEqual((await server.request(path+'?bot_id='+seed.B.id,'GET',undefined,session)).body,body);
  const unknown=await server.request(path+'?limit=5','GET',undefined,session);
  assert.equal(unknown.status,400);assert.equal(unknown.body.code,'INVALID_FIELDS');
  const counts=async()=>(await db.query('SELECT (SELECT count(*)::int FROM pine_bridge_jobs) jobs,(SELECT count(*)::int FROM pine_sources) sources,(SELECT count(*)::int FROM pine_deployments) deployments,(SELECT count(*)::int FROM audit WHERE event LIKE $1) writes',['pine_bridge.%'])).rows[0];
  const before=await counts();
  for(const method of ['POST','PUT','PATCH','DELETE']){
    const refused=await server.request(path,method,{},session);
    assert.equal(refused.status,405,method);assert.equal(refused.body.code,'METHOD_NOT_ALLOWED');
  }
  assert.deepEqual(await counts(),before,'no write');
  // Existing Bridge routes keep their own behavior behind the overview route.
  assert.equal((await server.request('/api/quant/pine-bridge/jobs/00000000-0000-4000-8000-000000000000','GET',undefined,session)).body.code,'NOT_FOUND');
});

test('overview: a closed Bridge answers {bridge_enabled:false}; other Bridge routes stay closed',async()=>{
  const server=await startServer({});
  assert.equal((await server.request('/api/quant/pine-bridge/overview')).status,401);
  const session=await login(server,seed.A);
  const answer=await server.request('/api/quant/pine-bridge/overview','GET',undefined,session);
  assert.equal(answer.status,200);assert.deepEqual(answer.body,{bridge_enabled:false});
  const closed=await server.request('/api/quant/pine-bridge/jobs/00000000-0000-4000-8000-000000000000','GET',undefined,session);
  assert.equal(closed.status,503);assert.equal(closed.body.code,'PINE_BRIDGE_DISABLED');
  assert.equal((await server.request('/api/quant/pine-bridge/overview','POST',{},session)).status,405);
});

test('overview: an unconfigured AI provider reports configured:false without values from the environment',async()=>{
  const server=await startServer({PINE_BRIDGE_ENABLED:'1',PINE_AI_MODEL:'gpt-4.1-mini'});
  const answer=await server.request('/api/quant/pine-bridge/overview','GET',undefined,await login(server,seed.A));
  assert.equal(answer.status,200);assert.deepEqual(answer.body.ai,{provider:null,model:null,configured:false});
  assert.equal(answer.body.bridge_enabled,true);assert.equal(answer.body.sources.count,2);
});

// Contracts hold the Pine source and market bars. Markers prove the history never reads them.
const bindings=count=>Array.from({length:count},(_,i)=>({slot:i+3,input_id:'in'+i,pine_variable:'variable'+i,effective_value:10+i,search_domain:{min:1,max:20,step:1,extra:'LEAK_TITLE'},
  source_span:{start:1,end:2},input_title:'LEAK_TITLE',default:5}));
const lockOf=count=>({lock_hash:'1'.repeat(64),selection:{signals:{buy:'buySignal'},bindings:bindings(count),fixed_inputs:[{marker:'FIXED_INPUT_LEAK'}]},domains:{atr_multiplier:[1.5,2,2.5],rr:[1,1.5,2]}});
const legacyContract=()=>({version:'ql3a-research-job-v1',scope:'SPT_CUSTOM_ENGINEERING_ONLY',source:'SECRET_CONTRACT_SOURCE',source_hash:'e'.repeat(64),baseline_snapshot_hash:'f'.repeat(64),
  input_lock:lockOf(3),plan:{planned_candidates:25,candidates:[{marker:'PLAN_LEAK'}]},dataset:{start_time:1,end_time:2,bar_count:1,bars:[{time:1,close:'BAR_SECRET'}],sha256:'d'.repeat(64)}});
const v2Contract=()=>({version:'ql3a-research-job-v2',execution_backend:'quant-foundation-v1',source_hash:'e'.repeat(64),baseline_snapshot_hash:'f'.repeat(64),
  input_lock:lockOf(8),plan:{planned_candidates:100},dataset:{start_time:1,end_time:2,content_digest:'9'.repeat(64)}});
async function seedRun(ownerId,deploymentId,{at,status,contract,result=null,diagnostic=null,steps=[],phase='COMPLETE',attempt=1,evaluations=0}){
  const id=randomUUID();
  await db.query('INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,phase,attempt,evaluations_started,result,diagnostic) VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14,$15)',
    [id,ownerId,deploymentId,'idem-run-'+id,hash(id),hash(canonical(contract)),JSON.stringify(contract),status,at,at+900000,phase,attempt,evaluations,result&&JSON.stringify(result),diagnostic]);
  let index=0;
  for(const kind of steps)await db.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[id,kind.toLowerCase()+':'+index,kind,JSON.stringify({index}),JSON.stringify({payload:'STEP_PAYLOAD_SECRET'}),at+index++]);
  return id;
}
const RUN_KEYS=['attempts','baseline_snapshot_hash','bot_id','bridge_domains','candidates_completed','candidates_planned','contract_hash','created_at','dataset_hash','deployment_id',
  'diagnostic','evaluations_started','input_lock_hash','owner_recommendation_ready','phase','result_summary','run_id','source_hash','source_slots','status','updated_at'];
const bad=async(server,session,query,code)=>{
  const answer=await server.request('/api/quant/research/history'+query,'GET',undefined,session);
  assert.equal(answer.status,400,query);assert.equal(answer.body.code,code,query);
};

test('history: absent research tables read as empty while admission is closed; limit and parameters are validated first',async()=>{
  const server=bridgeServer,path='/api/quant/research/history';
  assert.equal((await server.request(path)).status,401);
  const session=await login(server,seed.A);
  assert.equal((await db.query("SELECT to_regclass('quant_jobs') present")).rows[0].present,null);
  const answer=await server.request(path,'GET',undefined,session);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.deepEqual(answer.body,{admission_enabled:false,total_runs:0,runs:[]});
  const closed=await server.request('/api/quant/research/jobs/00000000-0000-4000-8000-000000000000','GET',undefined,session);
  assert.equal(closed.status,503);assert.equal(closed.body.code,'QUANT_RESEARCH_DISABLED');
  for(const query of ['?limit=0','?limit=21','?limit=-1','?limit=abc','?limit=1.5','?limit=','?limit=1e1','?limit=5&limit=6','?limit=%205','?limit=1000'])await bad(server,session,query,'INVALID_LIMIT');
  await bad(server,session,'?owner_id='+seed.B.id,'INVALID_FIELDS');await bad(server,session,'?limit=5&offset=1','INVALID_FIELDS');
  for(const query of ['?limit=1','?limit=20','?limit=005','?bot_id='+seed.A.id+'&limit=5','?bot_id=all'])assert.equal((await server.request(path+query,'GET',undefined,session)).status,200,query);
  for(const method of ['POST','PUT','DELETE'])assert.equal((await server.request(path,method,{},session)).body.code,'METHOD_NOT_ALLOWED',method);
});

let runIds;
test('history: owner-scoped summaries with whitelisted fields, newest first, bounded by limit',async()=>{
  await installQuantSchema();
  const noisy={completion_reason:'NO_VALID_TRAIN_VALIDATION_CANDIDATE',candidate_count:3,holdout_evaluated:false,owner_recommendation_ready:false,
    candidates:[{note:'NESTED_RESULT_SECRET'}],selected:{note:'NESTED_RESULT_SECRET'},acceptance_blockers:['NESTED_RESULT_SECRET'],
    ...Object.fromEntries(Array.from({length:25},(_,i)=>['extra_'+String(i).padStart(2,'0'),i]))};
  runIds={
    legacy:await seedRun(seed.A.id,seed.ready.id,{at:T+1000,status:'FAILED',contract:legacyContract(),diagnostic:'WORKER_FAILED',result:noisy,attempt:2,evaluations:7,
      steps:['CANDIDATE','CANDIDATE','SENSITIVITY','HOLDOUT','STRESS']}),
    v2:await seedRun(seed.A.id,seed.ready.id,{at:T+2000,status:'NO_VALID_CANDIDATE',contract:v2Contract(),result:{completion_reason:'DONE',nested:{a:'NESTED_RESULT_SECRET'}},steps:['CANDIDATE','CANDIDATE','CANDIDATE']}),
    minimal:await seedRun(seed.A.id,seed.ready.id,{at:T+3000,status:'QUEUED',phase:'CANDIDATES',contract:{version:'ql3a-research-job-v1'},attempt:0}),
    other:await seedRun(seed.B.id,seed.theirReady.id,{at:T+9000,status:'SUCCEEDED',contract:legacyContract(),result:{completion_reason:'B_ONLY'},steps:['CANDIDATE']})};
  const server=bridgeServer,path='/api/quant/research/history';
  const session=await login(server,seed.A);
  const answer=await server.request(path,'GET',undefined,session);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.deepEqual(Object.keys(body).sort(),['admission_enabled','runs','total_runs']);
  assert.equal(body.admission_enabled,false);assert.equal(body.total_runs,3);
  assert.deepEqual(body.runs.map(run=>run.run_id),[runIds.minimal,runIds.v2,runIds.legacy],'newest first, owner A only');
  for(const run of body.runs)assert.deepEqual(Object.keys(run).sort(),RUN_KEYS);
  const [minimal,v2,legacy]=body.runs;
  assert.equal(legacy.status,'FAILED');assert.equal(legacy.phase,'COMPLETE');assert.equal(legacy.attempts,2);assert.equal(legacy.evaluations_started,7);assert.equal(legacy.diagnostic,'WORKER_FAILED');
  assert.equal(legacy.bot_id,seed.A.id);assert.equal(legacy.deployment_id,seed.ready.id);assert.equal(legacy.created_at,T+1000);assert.equal(legacy.updated_at,T+1000);
  assert.equal(legacy.source_hash,'e'.repeat(64));assert.equal(legacy.baseline_snapshot_hash,'f'.repeat(64));assert.equal(legacy.input_lock_hash,'1'.repeat(64));
  assert.match(legacy.contract_hash,/^[a-f0-9]{64}$/);
  assert.equal(legacy.dataset_hash,'d'.repeat(64),'legacy contracts carry dataset.sha256');
  assert.equal(legacy.candidates_completed,2,'only CANDIDATE steps count');assert.equal(legacy.candidates_planned,25);assert.equal(legacy.owner_recommendation_ready,false);
  assert.equal(legacy.source_slots.length,3);
  assert.deepEqual(legacy.source_slots[0],{slot:3,input_id:'in0',pine_variable:'variable0',effective_value:10,search_domain:{min:1,max:20,step:1}});
  assert.deepEqual(legacy.bridge_domains,{atr_multiplier:[1.5,2,2.5],rr:[1,1.5,2]});
  assert.equal(Object.keys(legacy.result_summary).length,20,'at most 20 top-level scalar keys');
  assert.ok(Object.values(legacy.result_summary).every(value=>['string','number','boolean'].includes(typeof value)));
  assert.equal(legacy.result_summary.completion_reason,'NO_VALID_TRAIN_VALIDATION_CANDIDATE');assert.equal(legacy.result_summary.candidate_count,3);
  for(const nested of ['candidates','selected','acceptance_blockers'])assert.ok(!(nested in legacy.result_summary));
  assert.equal(v2.dataset_hash,'9'.repeat(64),'foundation contracts fall back to content_digest');
  assert.equal(v2.source_slots.length,8);assert.equal(v2.candidates_completed,3);assert.equal(v2.candidates_planned,100);
  assert.deepEqual(v2.result_summary,{completion_reason:'DONE'});assert.equal(v2.diagnostic,null);
  assert.deepEqual([minimal.source_slots,minimal.bridge_domains,minimal.dataset_hash,minimal.source_hash,minimal.input_lock_hash,minimal.baseline_snapshot_hash,minimal.candidates_planned,minimal.result_summary],
    [null,null,null,null,null,null,null,null],'absent contract parts read as null');
  assert.equal(minimal.status,'QUEUED');assert.equal(minimal.phase,'CANDIDATES');assert.equal(minimal.candidates_completed,0);assert.equal(minimal.attempts,0);
  noMarkers(body,[seed.B.id,seed.theirs,seed.theirReady.id,runIds.other,'B_ONLY']);
  // limit bounds the list but not the total; other owners see only their own run.
  const one=(await server.request(path+'?limit=1','GET',undefined,session)).body;
  assert.deepEqual([one.runs.length,one.runs[0].run_id,one.total_runs],[1,runIds.minimal,3]);
  assert.equal((await server.request(path+'?limit=2','GET',undefined,session)).body.runs.length,2);
  const other=(await server.request(path,'GET',undefined,await login(server,seed.B))).body;
  assert.deepEqual([other.total_runs,other.runs.map(run=>run.run_id)],[1,[runIds.other]]);
  noMarkers(other,[seed.A.id,seed.ready.id,runIds.legacy,runIds.v2,runIds.minimal]);
  assert.deepEqual((await server.request(path,'GET',undefined,await login(server,seed.C))).body,{admission_enabled:false,total_runs:0,runs:[]});
});

test('history: admission_enabled follows the server flag, and the route is served ahead of the research routes',async()=>{
  const server=await startServer({PINE_BRIDGE_ENABLED:'1',PINE_BRIDGE_ENV:'staging',PAPER_TRADING:'true',QUANT_RESEARCH_ENABLED:'1',...AI});
  const session=await login(server,seed.A);
  const answer=await server.request('/api/quant/research/history','GET',undefined,session);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.equal(answer.body.admission_enabled,true);assert.equal(answer.body.total_runs,3);
  const loose=await db.transaction(()=>researchHistory(db,seed.A.id,10,{admissionEnabled:'yes'}));
  assert.equal(loose.admission_enabled,false,'only a true flag opens admission');
  const unknown=await server.request('/api/quant/research/jobs/00000000-0000-4000-8000-000000000000','GET',undefined,session);
  assert.equal(unknown.status,404);assert.equal(unknown.body.code,'NOT_FOUND');
});

test('both views are read-only: SELECT statements only, no lock, no executor-mode check, valid in a READ ONLY transaction',async()=>{
  const statements=[],client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    const spy={query:(sql,params)=>{statements.push(sql);return client.query(sql,params);}};
    const service=new PineBridgeService({db:spy},{getProvider:()=>({provider:'openai-chat',model:'gpt-4.1-mini'})});
    const overview=await bridgeOverview(service,seed.A.id,{captureEnabled:true});
    const history=await researchHistory(spy,seed.A.id,10,{admissionEnabled:true});
    assert.equal(overview.sources.count,2);assert.equal(overview.capture_enabled,true);assert.equal(history.total_runs,3);
    // The route functions answer through the same adapter.
    const out={},json=(res,status,body)=>{res.out={status,body};};
    assert.equal(await quantResearchHistoryRoutes({method:'GET'},out,new URL('http://x/api/quant/research/history?limit=2&bot_id=z'),{id:seed.A.id},spy,json,{admissionEnabled:true}),true);
    assert.deepEqual([out.out.status,out.out.body.runs.length,out.out.body.admission_enabled],[200,2,true]);
    assert.equal(await pineBridgeOverviewRoutes({method:'GET'},out,new URL('http://x/api/quant/pine-bridge/overview'),{id:seed.A.id},service,json,{enabled:true}),true);
    assert.equal(out.out.body.jobs.latest.job_id,seed.generate);
    for(const [routes,path,args] of [[quantResearchHistoryRoutes,'/api/quant/research/history',[spy]],[pineBridgeOverviewRoutes,'/api/quant/pine-bridge/overview',[service]]]){
      assert.equal(await routes({method:'GET'},out,new URL('http://x/api/quant/other'),{id:seed.A.id},...args,json,{}),false,'other paths fall through');
      await assert.rejects(routes({method:'POST'},out,new URL('http://x'+path),{id:seed.A.id},...args,json,{}),{code:'METHOD_NOT_ALLOWED',status:405});
    }
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  assert.ok(statements.length>=12,'statements were observed');
  for(const sql of statements){
    assert.match(sql,/^\s*SELECT\b/i);
    assert.doesNotMatch(sql,/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b|pg_advisory|\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b|executor_mode/i);
  }
});

test('overview AI status mirrors the Bridge provider configuration and never exposes its values',async()=>{
  const ai=async getProvider=>(await bridgeOverview(new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider}),seed.C.id)).ai;
  const off={provider:null,model:null,configured:false};
  assert.deepEqual(await ai(()=>({provider:'gemini',model:'gemini-3.8-flash',inputRate:1,outputRate:2,rateVersion:'x',apiKey:'LEAK_KEY',url:'https://LEAK_URL'})),{provider:'gemini',model:'gemini-3.8-flash',configured:true});
  const env={PINE_AI_PROVIDER:'openai-chat',PINE_AI_MODEL:'gpt-4.1-mini',PINE_AI_API_KEY:'k',PINE_AI_INPUT_USD_PER_MILLION:'0.4',PINE_AI_OUTPUT_USD_PER_MILLION:'1.6',PINE_AI_RATE_VERSION:'v1'};
  assert.deepEqual(await ai(()=>providerConfig(env)),{provider:'openai-chat',model:'gpt-4.1-mini',configured:true});
  for(const broken of [{PINE_AI_API_KEY:''},{PINE_AI_MODEL:'gpt-9'},{PINE_AI_RATE_VERSION:''},{PINE_AI_PROVIDER:'other'},{PINE_AI_INPUT_USD_PER_MILLION:'x'}])
    assert.deepEqual(await ai(()=>providerConfig({...env,...broken})),off,Object.keys(broken)[0]);
  assert.deepEqual(await ai(()=>{throw fail('AI_PROVIDER_NOT_CONFIGURED',503);}),off);
  assert.deepEqual(await ai(()=>null),off,'a provider without names is not a configuration');
});

test('overview source facts: newest revision wins; counts come only from stored analysis, review and deployments; unknown stays null',async()=>{
  const service=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider:()=>({provider:'openai-chat',model:'gpt-4.1-mini'})});
  const latest=async ownerId=>(await bridgeOverview(service,ownerId)).sources.latest;
  const ownerWith=async(build,deploy)=>{
    const owner=await newOwner('journey-n'),versions=build(),importId=await seedImport(owner.id,'Facts',versions);
    if(deploy)await deploy(owner.id,importId,versions);
    return owner.id;
  };
  const withReview=(version,change)=>{const item=revision(version,T+20+version);change(item.analysis.effective_input_review,item);return item;};
  // Two revisions of one import: the newer revision is "latest", named after the import.
  const multi=await ownerWith(()=>[revision(1,T+100),revision(2,T+200,{reviewed:false})],async(id,importId)=>{await seedDeployment(id,importId,{version:1,at:T+300,slots:4});});
  const second=await latest(multi);
  assert.equal(second.source_version,2);assert.equal(second.source_name,'Facts');assert.equal(second.created_at,T+200);
  assert.deepEqual(second.numeric_inputs,{total:10,eligible:8,reviewed:false,selected_slots:null},'a deployment of version 1 says nothing about version 2');
  const reviewed=await ownerWith(()=>[withReview(1,()=>{})],async(id,importId)=>{await seedDeployment(id,importId,{version:1,at:T+300,slots:0,bindings:[]});});
  assert.deepEqual((await latest(reviewed)).numeric_inputs,{total:10,eligible:8,reviewed:true,selected_slots:0});
  const staleHash=await ownerWith(()=>[withReview(1,review=>{review.source_hash='0'.repeat(64);})]);
  assert.equal((await latest(staleHash)).numeric_inputs.reviewed,false,'review of different source bytes');
  const staleInputs=await ownerWith(()=>[withReview(1,review=>{review.effective_inputs_hash='0'.repeat(64);})]);
  assert.equal((await latest(staleInputs)).numeric_inputs.reviewed,false,'review of different effective inputs');
  const noTime=await ownerWith(()=>[withReview(1,review=>{delete review.reviewed_at;})]);
  assert.equal((await latest(noTime)).numeric_inputs.reviewed,false);
  const oddBindings=await ownerWith(()=>[revision(1,T+400)],async(id,importId)=>{
    const deployment=await seedDeployment(id,importId,{version:1,at:T+500});
    await db.query("UPDATE pine_deployments SET snapshot=jsonb_set(snapshot,'{selection,bindings}','\"oops\"') WHERE deployment_id=$1",[deployment.id]);
  });
  assert.equal((await latest(oddBindings)).numeric_inputs.selected_slots,null,'non-array bindings are unknown');
  const noInputs=await ownerWith(()=>{const item=revision(1,T+600);item.analysis={unrelated:true};return [item];});
  assert.equal((await latest(noInputs)).numeric_inputs,null,'unrecognized analysis stays null');
  const nonNumeric=await ownerWith(()=>{const item=revision(1,T+700);item.analysis.inputs=item.analysis.inputs.map(input=>({...input,type:'string'}));return [item];});
  assert.equal((await latest(nonNumeric)).numeric_inputs.total,0);
  // Job and deployment summaries without usage, drafts or ready deployments.
  const bare=await newOwner('journey-bare'),importId=await seedImport(bare.id,'Bare',[revision(1,T+800)]);
  await seedJob(bare.id,importId,{operation:'analyze',status:'FAILED',at:T+900,diagnostic:'PROVIDER_REJECTED'});
  await seedDeployment(bare.id,importId,{state:'DRAFT',at:T+950});
  const bareOverview=await bridgeOverview(service,bare.id);
  assert.deepEqual(bareOverview.jobs.latest,{job_id:bareOverview.jobs.latest.job_id,operation:'analyze',job_status:'FAILED',created_at:T+900,updated_at:T+900,attempts:1,usage_summary:null,diagnostic:'PROVIDER_REJECTED',has_draft:false});
  assert.equal(bareOverview.deployments.latest_ready,null);assert.deepEqual(bareOverview.deployments.by_state,{DRAFT:1});
});
