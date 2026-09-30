import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {quantResearchHttpFixture} from '../helpers/quant-research-prepare-fixture.mjs';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {source} from '../helpers/quant-research-fixture.mjs';
import {config} from '../../src/config.js';

// Real HTTP admission/cancellation and real PostgreSQL transitions. Synthetic
// market data and evaluator isolate preparation; no private source or holdout.
const M=60000, start=Math.floor(Date.now()/M)*M-20000*M;
const offline={policy:{workerUnit:'s3c-test-worker.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},
  inventory:async()=>{},settleMs:0};
function latch(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Error(label+' did not settle within 15 seconds')),15000);
})]);}finally{clearTimeout(timer);}}
async function setup(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantResearchHttpFixture(process.env.TEST_DATABASE_URL);t.after(()=>f.close());
  await f.seedBars({start,count:3250});
  const owner=await f.newOwner(),session=await owner.login();
  const budget=new StorageBudget({root:f.root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const datasetStore=new ResearchDatasetStore({root:f.root,storageBudget:budget});
  let now=Date.now(),healthy=true,evaluations=0;
  const service=new QuantResearchService({pineService:new PineBridgeService(f.store,{defaultRisk:config.defaultRisk}),
    clock:()=>now,supportedSourceHash:hash(source),foundation:true,datasetStore});
  async function evaluate(payload){
    evaluations++;
    assert.ok((await f.db.query("SELECT run_id FROM quant_research_chunks WHERE run_id=$1 AND step_id='prepare:dataset'",
      [activeRun])).rowCount,'durable binding must precede evaluator');
    assert.equal(payload.contract.version,'ql3a-research-job-v1');
    const next=(payload.checkpoint?.next_bar??0)+payload.rows.length;
    const end=payload.contract.split.validation_end;
    const metric={closed_trades:0,net_return_percent:'0',max_drawdown_percent:'0'};
    return {checkpoint:{version:'research-chunk-v1',identity:hash(canonical({contract:payload.contract,parameters:payload.parameters,kind:payload.kind})),
      integrity:'a'.repeat(64),next_bar:next,last_time:payload.rows.at(-1).time,paper:{cash:'1000'},evaluator:{index:next-1}},
      result:next===end?{parameters:payload.parameters,kind:payload.kind,train:metric,validation:metric}:null};
  }
  let activeRun;
  const worker=()=>new QuantResearchFoundationWorker({service,clock:()=>now,leaseMs:1500,
    health:async()=>({ok:healthy}),evaluateChunk:evaluate,stopUnit:async()=>true});
  async function enqueue(){const answer=await f.enqueue(owner,session,f.researchBody(owner,{start}));
    assert.equal(answer.status,202,JSON.stringify(answer.body));activeRun=answer.body.run_id;return answer.body;}
  const summary=id=>f.request('/api/quant/research/jobs/'+id,'GET',undefined,session);
  const cancel=id=>f.request('/api/quant/research/jobs/'+id+'/cancel','POST',{},session);
  const row=async id=>(await f.db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[id])).rows[0];
  const foundation=async id=>(await f.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
  const binding=async id=>(await f.db.query("SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id='prepare:dataset'",[id])).rows[0];
  return {...f,owner,session,budget,service,worker,enqueue,summary,cancel,row,foundation,binding,
    advance:ms=>{now+=ms;},health:value=>{healthy=value;},evaluations:()=>evaluations};
}
async function claim(f,w){const job=await w.claim();assert.ok(job);w.controller=new AbortController();return job;}
async function age(filename){const old=new Date(Date.now()-3*86400000);const stat=await fs.stat(filename);
  if(stat.isDirectory())for(const name of await fs.readdir(filename))await age(path.join(filename,name));
  await fs.utimes(filename,old,old);}
async function artifacts(f,parameters){
  const names=[parameters.references.raw.dataset_id,'atr14-'+parameters.references.sidecar.sha256+'.json'];
  for(const name of names)assert.ok(await fs.stat(path.join(f.root,name)));
  await f.service.datasetStore.sidecar(parameters.references.sidecar);
  await f.service.datasetStore.raw.inspect(parameters.references.raw);
  return names;
}

test('A1 HTTP queues with no artifacts/reservations; worker tick prepares before evaluator and preserves report identity',async t=>{
  const f=await setup(t),before=await f.listing(),queued=await f.enqueue();
  assert.deepEqual(await f.listing(),before);
  assert.equal(queued.dataset_prepared,false);assert.equal(queued.dataset_hash,null);
  const stored=await f.row(queued.run_id);assert.equal(stored.contract.version,'ql3a-research-job-v2');
  assert.equal(Object.hasOwn(stored.contract.dataset,'references'),false);
  assert.equal(await f.binding(queued.run_id),undefined);
  const w=f.worker(),claimedAt=Date.now();await w.tick();
  const binding=await f.binding(queued.run_id);assert.ok(binding);
  assert.equal(binding.identity_hash,hash(canonical({contract:stored.contract,parameters:binding.parameters,kind:'PREPARE'})));
  const names=await artifacts(f,binding.parameters);
  for(const name of names)assert.ok((await fs.stat(path.join(f.root,name))).mtimeMs>=claimedAt-1000);
  const done=await f.row(queued.run_id);assert.equal(done.status,'NO_VALID_CANDIDATE');
  assert.ok(f.evaluations()>0);assert.equal(done.result.contract_hash,stored.contract_hash);
  assert.equal(done.result.dataset_hash,binding.parameters.dataset_sha256);
  const chunks=(await f.db.query("SELECT * FROM quant_research_chunks WHERE run_id=$1 AND kind='CANDIDATE'",[queued.run_id])).rows;
  assert.ok(chunks.length>0);
  for(const chunk of chunks)assert.equal(chunk.identity_hash,
    hash(canonical({contract:stored.contract,parameters:chunk.parameters,kind:chunk.kind})),
    'candidate identity must use stored V2 contract');
  const answer=await f.summary(queued.run_id);assert.equal(answer.status,200);assert.equal(answer.body.dataset_prepared,true);
  assert.deepEqual(await fs.readdir(path.join(f.root,'.storage-reservations')),[]);
});

test('A2 busy slot queues without files; full queue and off-grid admission reject without writes',async t=>{
  const f=await setup(t),first=await f.enqueue(),w=f.worker();await claim(f,w);
  const before=await f.listing(),second=await f.enqueue();assert.deepEqual(await f.listing(),before);
  assert.equal(await f.worker().claim(),null);assert.equal(await f.binding(second.run_id),undefined);
  const answer=await f.request('/api/quant/research/jobs','POST',f.researchBody(f.owner,{start}),f.session,{'Idempotency-Key':'s3c-full'});
  assert.equal(answer.status,429);assert.equal(answer.body.code,'QUANT_QUEUE_FULL');assert.deepEqual(await f.listing(),before);
  await f.cancel(first.run_id);await w.reconcile();await f.cancel(second.run_id);
  const off=start+4000*M;await f.seedBars({start:off,count:3250,offGrid:[1600]});
  const count=(await f.db.query('SELECT count(*)::int n FROM quant_jobs')).rows[0].n;
  const bad=await f.request('/api/quant/research/jobs','POST',f.researchBody(f.owner,{start:off}),f.session,{'Idempotency-Key':'s3c-off-grid'});
  assert.equal(bad.status,400);assert.equal(bad.body.code,'VERIFIED_MARKET_DATA_REQUIRED');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_jobs')).rows[0].n,count);
  assert.deepEqual(await f.listing(),before);
});

test('A3 stale token publishes no binding; reclaimed token alone binds deterministic dataset',async t=>{
  const f=await setup(t),queued=await f.enqueue(),old=f.worker(),job=await claim(f,old);
  await old.scheduler.pause(job.foundation);
  const next=f.worker(),reclaimed=await claim(f,next);assert.notEqual(reclaimed.lease_token,job.lease_token);
  await assert.rejects(old.prepareResearch(job),{code:'FOUNDATION_LEASE_LOST'});
  assert.equal(await f.binding(queued.run_id),undefined);assert.equal(f.evaluations(),0);
  const names=await f.listing();const prepared=await next.prepareResearch(reclaimed);
  assert.deepEqual(await f.listing(),names,'winner reuses content-addressed artifacts from stale publication');
  assert.deepEqual((await f.binding(queued.run_id)).parameters,prepared.dataset_binding);
  await artifacts(f,prepared.dataset_binding);
});

test('A4 real HTTP cancellation during tick PREPARE prevents binding and evaluator output',async t=>{
  const f=await setup(t),queued=await f.enqueue(),entered=latch(),release=latch();
  const publish=f.service.datasetStore.publish.bind(f.service.datasetStore);
  f.service.datasetStore.publish=async(...args)=>{const refs=await publish(...args);entered.resolve();await release.promise;return refs;};
  const w=f.worker(),running=w.tick();await bounded(entered.promise,'cancel preparation');
  try{
    const cancel=await f.cancel(queued.run_id);assert.equal(cancel.status,200);
    assert.equal((await f.foundation(queued.run_id)).status,'STOPPING');
    assert.equal(await f.worker().claim(),null);assert.equal(await f.binding(queued.run_id),undefined);
  }finally{release.resolve();await running;}
  assert.equal(f.evaluations(),0);assert.equal(await f.binding(queued.run_id),undefined);
  assert.equal((await f.foundation(queued.run_id)).status,'CANCELLED');
  assert.equal((await f.summary(queued.run_id)).body.dataset_prepared,false);
  assert.deepEqual(await fs.readdir(path.join(f.root,'.storage-reservations')),[]);
});

test('A5 heartbeat health loss during PREPARE pauses; reclaim re-prepares safely',async t=>{
  const f=await setup(t),queued=await f.enqueue(),entered=latch(),aborted=latch();
  const publish=f.service.datasetStore.publish.bind(f.service.datasetStore);
  f.service.datasetStore.publish=async(...args)=>{
    entered.resolve();const signal=args[2].signal;
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));aborted.resolve();
    return publish(...args);
  };
  const w=f.worker(),running=w.tick();await bounded(entered.promise,'health preparation');f.health(false);
  await bounded(aborted.promise,'heartbeat abort');await running;
  assert.equal((await f.foundation(queued.run_id)).status,'PAUSED');assert.equal(await f.binding(queued.run_id),undefined);
  assert.equal(f.evaluations(),0);f.health(true);f.service.datasetStore.publish=publish;
  await f.worker().tick();assert.equal((await f.row(queued.run_id)).status,'NO_VALID_CANDIDATE');
  await artifacts(f,(await f.binding(queued.run_id)).parameters);
});

for(const bound of [false,true])test('A6 offline crash recovery '+(bound?'retains binding without republishing':'re-prepares published unbound artifacts'),async t=>{
  const f=await setup(t),queued=await f.enqueue(),w=f.worker(),job=await claim(f,w);
  const publish=f.service.datasetStore.publish.bind(f.service.datasetStore);let publications=0;
  f.service.datasetStore.publish=async(...args)=>{publications++;const refs=await publish(...args);
    if(!bound)throw Error('simulated worker crash after publication');return refs;};
  if(bound)await w.prepareResearch(job);else await assert.rejects(w.prepareResearch(job),/simulated worker crash/);
  const beforeBinding=await f.binding(queued.run_id),beforeFiles=await f.listing();
  f.advance(2000);assert.equal(await f.worker().claim(),null);
  assert.equal((await f.foundation(queued.run_id)).stop_reason,'LEASE_EXPIRED');
  await f.stopHttp(); // Actual HTTP child is stopped before the fake OS offline inventory.
  const recovered=await recoverQuantFoundation({db:f.db,...offline});
  assert.deepEqual(recovered.recovered,[{job_id:queued.run_id,status:'PAUSED'}]);
  assert.deepEqual(await f.binding(queued.run_id),beforeBinding);
  f.service.datasetStore.publish=async(...args)=>{publications++;return publish(...args);};
  const next=f.worker(),reclaimed=await claim(f,next);assert.notEqual(reclaimed.lease_token,job.lease_token);
  await next.prepareResearch(reclaimed);
  assert.deepEqual(await f.listing(),beforeFiles);
  assert.equal(publications,bound?1:2);
  if(bound)assert.deepEqual(await f.binding(queued.run_id),beforeBinding);
  await artifacts(f,(await f.binding(queued.run_id)).parameters);
  // Reading the now-bound artifacts performs no write. Only the reclaimed token
  // may checkpoint, regardless of whether the old worker can read the binding.
  await w.prepareResearch(job);
  await assert.rejects(w.fenced(job,()=>{}),{code:'FOUNDATION_LEASE_LOST'});
});

test('A7 offline retention keeps aged bound/reused artifacts, removes orphan, refuses deleted terminal binding',async t=>{
  const f=await setup(t),queued=await f.enqueue(),w=f.worker(),job=await claim(f,w),prepared=await w.prepareResearch(job);
  const parameters=prepared.dataset_binding,names=await artifacts(f,parameters);
  for(const name of names)await age(path.join(f.root,name));
  const mtimes=await Promise.all(names.map(async name=>(await fs.stat(path.join(f.root,name))).mtimeMs));
  await w.scheduler.pause(job.foundation);
  const next=f.worker(),reclaimed=await claim(f,next);await next.prepareResearch(reclaimed);
  assert.deepEqual(await Promise.all(names.map(async name=>(await fs.stat(path.join(f.root,name))).mtimeMs)),mtimes);
  await next.scheduler.pause(reclaimed.foundation);
  const metadata=parameters.references.raw.metadata,rows=[];
  for await(const bar of f.service.datasetStore.read(parameters.references))rows.push({...bar,
    price_tick:String(job.contract.model.price_tick),quantity_step:String(job.contract.model.quantity_step)});
  const orphan=await f.service.datasetStore.publish({...metadata,cutoff:metadata.cutoff+M},rows,{model:job.contract.model});
  const orphanName=orphan.raw.dataset_id;assert.notEqual(orphanName,names[0]);await age(path.join(f.root,orphanName));
  await f.stopHttp();
  await maintainQuantStorage({db:f.db,budget:f.budget,apply:true,...offline});
  await assert.rejects(fs.stat(path.join(f.root,orphanName)),{code:'ENOENT'});await artifacts(f,parameters);
  await f.db.query("UPDATE quant_foundation_jobs SET status='QUEUED' WHERE job_id=$1",[queued.run_id]);
  await maintainQuantStorage({db:f.db,budget:f.budget,apply:true,...offline});await artifacts(f,parameters);
  const final=f.worker(),finalJob=await claim(f,final),execution=await final.prepareResearch(finalJob);
  await final.finish(execution,'NO_VALID_CANDIDATE',{fixture:true});
  await f.db.query("DELETE FROM quant_research_chunks WHERE run_id=$1 AND step_id='prepare:dataset'",[queued.run_id]);
  const before=await f.listing();
  await assert.rejects(maintainQuantStorage({db:f.db,budget:f.budget,apply:true,...offline}),{code:'STORAGE_REFERENCE_INVALID'});
  assert.deepEqual(await f.listing(),before);await artifacts(f,parameters);
});

// These deliberately inconsistent persisted tokens isolate the two redundant
// fences. Ordinary lease replacement changes both tokens and cannot prove that
// either individual comparison remains effective by itself.
for(const fence of ['foundation','research'])test('A8 split-token '+fence+' fence refuses binding',async t=>{
  const f=await setup(t),queued=await f.enqueue(),w=f.worker(),job=await claim(f,w);
  const replacement='11111111-1111-4111-8111-111111111111';
  if(fence==='foundation')await f.db.query('UPDATE quant_foundation_jobs SET lease_token=$2 WHERE job_id=$1',[queued.run_id,replacement]);
  else await f.db.query('UPDATE quant_jobs SET lease_token=$2 WHERE run_id=$1',[queued.run_id,replacement]);
  await assert.rejects(w.prepareResearch(job),{code:fence==='foundation'?'FOUNDATION_LEASE_LOST':'RESEARCH_LEASE_LOST'});
  assert.equal(await f.binding(queued.run_id),undefined);assert.equal(f.evaluations(),0);
});

test('A8 changed valid market content after HTTP enqueue fails digest before publication',async t=>{
  const f=await setup(t),queued=await f.enqueue(),before=await f.listing();
  const time=start+1600*M,row=(await f.db.query('SELECT bar FROM pine_market_bars WHERE bar_time=$1',[time])).rows[0];
  const changed={...row.bar,close:'100.01'};
  await f.db.query('UPDATE pine_market_bars SET bar=$2,content_hash=$3 WHERE bar_time=$1',[time,JSON.stringify(changed),hash(canonical(changed))]);
  const w=f.worker(),job=await claim(f,w);
  await assert.rejects(w.prepareResearch(job),{code:'RESEARCH_DATASET_CHANGED'});
  assert.equal(await f.binding(queued.run_id),undefined);assert.deepEqual(await f.listing(),before);
});

test('A8 HTTP NULL profile and NULL bar time fail closed without admission or files',async t=>{
  const f=await setup(t),before=await f.listing(),answers=[];
  for(const field of ['profile','time']){
    const offset=field==='profile'?4000:8000,range=start+offset*M;
    await f.seedBars({start:range,count:3250});
    if(field==='profile')await f.db.query("UPDATE pine_market_bars SET provenance=provenance-'profile' WHERE bar_time=$1",[range+1600*M]);
    else await f.db.query("UPDATE pine_market_bars SET bar=bar-'time' WHERE bar_time=$1",[range+1600*M]);
    const answer=await f.request('/api/quant/research/jobs','POST',f.researchBody(f.owner,{start:range}),f.session,
      {'Idempotency-Key':'s3c-null-'+field});
    answers.push({field,status:answer.status,code:answer.body.code});
  }
  assert.deepEqual(answers,[{field:'profile',status:400,code:'VERIFIED_MARKET_DATA_REQUIRED'},
    {field:'time',status:400,code:'VERIFIED_MARKET_DATA_REQUIRED'}],'both NULL filters must refuse admission');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_jobs')).rows[0].n,0);
  assert.deepEqual(await f.listing(),before);
});
