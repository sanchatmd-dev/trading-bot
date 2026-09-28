import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantDataService} from '../../src/postgres/quant-data.js';
import {QuantProfileService} from '../../src/postgres/quant-profile.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {bindQuantStorage,maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {fixture,source} from '../helpers/quant-research-fixture.mjs';

const minute=60000;
let admin,db,name,root,store,pine,data,profile,researchStore,budget,now,owner,foreign,deploymentId,worker;
const offline={policy:{workerUnit:'qdqs-profile-test.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},
  inventory:async()=>{},settleMs:0};
const row=async id=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_profile_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
    'quant-research-foundation-schema.sql','quant-storage-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  root=await fs.mkdtemp(path.join(os.tmpdir(),'quant-profile-pg-'));
  await db.transaction(()=>bindQuantStorage(db,root));
  budget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,
    tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const rawStore=new DatasetStore({root,storageBudget:budget});
  researchStore=new ResearchDatasetStore({root,storageBudget:budget});
  store=new Store(db);pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  now=Math.floor(Date.now()/minute)*minute+4*minute;
  data=new QuantDataService({pineService:pine,datasetStore:rawStore,clock:()=>now,enabled:true});
  profile=new QuantProfileService({pineService:pine,dataService:data,researchStore,
    clock:()=>now,enabled:true,supportedSourceHash:hash(source)});
  owner=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  foreign=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  const policy={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,
    equities:{'binance-global':1000},balances:{'binance-global':1000}};
  await store.setRisk(owner,policy);
  const input=fixture(),importId=randomUUID();deploymentId=randomUUID();
  await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,owner,owner,1,
    hash(source),'Profile fixture',source,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,
    hash(source),source,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,owner,owner,1);
  const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
  const capital=await store.paperAccounts(owner);
  const funding=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(owner)).cutoff;
  const snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),
    market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,
    policy_hash:hash(canonical(policy)),capital,funding_cutoff:funding,membership:members,
    selection:{...input.selection,bindings:[],fixed_inputs:input.analysis.inputs}};
  const snapshotHash=hash(canonical(snapshot));
  await db.prepare("INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,'READY',?)").run(
    deploymentId,owner,owner,importId,1,JSON.stringify(snapshot),snapshotHash,now);
  const evidence={snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,
    source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
    binding_coverage:100,source_changed_bytes:0,unresolved_references:0,
    identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
    effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,
      buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,
    duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,
    execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,
      fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},
    references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',
      paper_fixture:'synthetic-fixture-only'}};
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,
    snapshotHash,JSON.stringify(evidence),hash(canonical(evidence)),now);
  const service={foundation:true,db,store,datasetStore:researchStore,executorMode:async()=>{}};
  const fetchHistory=(range,{onPage}={})=>{
    const first=range.start_time-range.warmup_bars*minute;
    onPage?.({start_time:first,end_time:range.end_time,count:(range.end_time-first)/minute,
      sha256:hash('profile-page'),retrieved_at:now,
      source:'https://api.binance.com/api/v3/klines',
      timestamp_semantics:'UTC open time; end exclusive'});
    return (async function*(){for(let time=first;time<range.end_time;time+=minute)
      yield {time,open:'100',high:'102',low:'99',close:'101',volume:'1'};})();
  };
  worker=new QuantResearchFoundationWorker({service,dataService:data,profileService:profile,
    health:async()=>({ok:true}),clock:()=>now,fetchHistory,stopUnit:async()=>true});
});
after(async()=>{await db?.close();if(name)await admin.query('DROP DATABASE '+name);
  await admin?.close();if(root)await fs.rm(root,{recursive:true,force:true});});

test('real PostgreSQL schedules raw to PROFILE, fences proof, scopes status, idempotency and cancellation',async()=>{
  const end=Math.floor(now/minute)*minute-2*minute;
  const rawRequest={bot_id:owner,start_time:end-20*minute,end_time:end,warmup_bars:500,cutoff:Math.floor(now/minute)*minute};
  const rawJob=await db.transaction(()=>data.enqueue(owner,rawRequest,randomUUID()));
  assert.equal(await worker.tick(),true);
  assert.equal((await row(rawJob.job_id)).status,'SUCCEEDED');
  const request={bot_id:owner,raw_job_id:rawJob.job_id,deployment_id:deploymentId};
  const key=randomUUID(),queued=await db.transaction(()=>profile.enqueue(owner,request,key));
  assert.equal(queued.status,'QUEUED');
  assert.equal((await db.transaction(()=>profile.enqueue(owner,request,key))).job_id,queued.job_id);
  await assert.rejects(db.transaction(()=>profile.enqueue(owner,{...request,deployment_id:randomUUID()},key)),
    {code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(db.transaction(()=>profile.get(foreign,queued.job_id)),{code:'NOT_FOUND'});
  await assert.rejects(db.transaction(()=>profile.get(owner,queued.job_id,false,foreign)),{code:'NOT_FOUND'});
  const claimed=await worker.scheduler.claim('profile-checkpoint-test');
  assert.equal(claimed.contract.kind,'PROFILE');
  await assert.rejects(worker.scheduler.checkpoint(claimed,{next_bar:1,state:{}}),
    {code:'PROFILE_CHECKPOINT_INVALID'});
  await db.transaction(()=>db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',lease_until=NULL,run_started_at=NULL WHERE job_id=$1",[claimed.job_id]));
  worker.stopped.add(claimed.job_id+':'+claimed.lease_token);
  await worker.reconcile();
  assert.equal((await row(claimed.job_id)).status,'CANCELLED');
  const success=await db.transaction(()=>profile.enqueue(owner,request,randomUUID()));
  assert.equal(await worker.tick(),true);
  const done=await row(success.job_id);
  assert.equal(done.status,'SUCCEEDED',done.diagnostic);
  assert.equal(done.result.data_profile_verified,true);
  assert.equal(done.result.evaluator_admission,false);
  assert.equal(done.result.references.raw.metadata.total_bars,20);
  assert.equal((await db.transaction(()=>profile.get(owner,success.job_id))).status,'SUCCEEDED');
  const retention=await maintainQuantStorage({db,budget,...offline});
  assert.deepEqual(retention.candidates,[]);
});

test('PROFILE cancellation retains the slot until work settles; offline recovery fences the old lease',async()=>{
  const raw=(await db.query("SELECT job_id FROM quant_foundation_jobs WHERE contract->>'kind'='BACKFILL' AND status='SUCCEEDED'")).rows[0];
  const request={bot_id:owner,raw_job_id:raw.job_id,deployment_id:deploymentId};
  const queued=await db.transaction(()=>profile.enqueue(owner,request,randomUUID()));
  assert.equal((await db.transaction(()=>profile.get(owner,queued.job_id,true))).status,'CANCELLED');

  const running=await db.transaction(()=>profile.enqueue(owner,request,randomUUID()));
  const publish=researchStore.publish.bind(researchStore);
  let reached,release;
  const entered=new Promise(resolve=>{reached=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  researchStore.publish=async(...args)=>{reached();await held;return publish(...args);};
  const tick=worker.tick();
  try{
    await entered;
    assert.equal((await db.transaction(()=>profile.get(owner,running.job_id,true))).status,'STOPPING');
    await worker.reconcile();
    assert.equal((await row(running.job_id)).status,'STOPPING');
    assert.equal(await worker.scheduler.claim('blocked-until-stopped'),null);
  }finally{release();await tick;researchStore.publish=publish;}
  assert.equal((await row(running.job_id)).status,'CANCELLED');
  assert.equal((await row(running.job_id)).result,null);

  const recoverable=await db.transaction(()=>profile.enqueue(owner,request,randomUUID()));
  const old=await worker.scheduler.claim('simulated-crashed-worker');
  assert.equal(old.job_id,recoverable.job_id);
  const before=await row(old.job_id);
  const recovered=await recoverQuantFoundation({db,...offline});
  assert.deepEqual(recovered.recovered,[{job_id:old.job_id,status:'PAUSED'}]);
  const paused=await row(old.job_id);
  assert.equal(paused.deadline_at,before.deadline_at);
  assert.deepEqual(paused.contract,before.contract);
  assert.equal(paused.next_bar,0);
  assert.equal(paused.checkpoint,null);
  await assert.rejects(worker.scheduler.heartbeat(old),{code:'FOUNDATION_LEASE_LOST'});
  assert.equal(await worker.tick(),true);
  assert.equal((await row(old.job_id)).status,'SUCCEEDED');
  assert.equal((await row(old.job_id)).attempts,2);
});

test('membership revocation during held PROFILE conversion blocks fenced FINISH and result',async()=>{
  const raw=(await db.query("SELECT job_id FROM quant_foundation_jobs WHERE contract->>'kind'='BACKFILL' AND status='SUCCEEDED'")).rows[0];
  const request={bot_id:owner,raw_job_id:raw.job_id,deployment_id:deploymentId};
  const queued=await db.transaction(()=>profile.enqueue(owner,request,randomUUID()));
  const publish=researchStore.publish.bind(researchStore);
  let reached,release;
  const entered=new Promise(resolve=>{reached=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  researchStore.publish=async(...args)=>{reached();await held;return publish(...args);};
  const tick=worker.tick();
  try{
    await entered;
    assert.equal((await row(queued.job_id)).status,'RUNNING');
    await db.query('UPDATE pine_memberships SET connected=FALSE WHERE owner_id=$1 AND bot_id=$1',[owner]);
    assert.equal(await worker.scheduler.claim('revocation-blocked'),null);
  }finally{release();await tick;researchStore.publish=publish;}
  const result=await row(queued.job_id);
  assert.equal(result.status,'CANCELLED');
  assert.equal(result.result,null);
  assert.equal(result.next_bar,0);
  assert.equal(result.checkpoint,null);
});
