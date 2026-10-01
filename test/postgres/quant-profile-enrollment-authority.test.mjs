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
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';
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
    'quant-research-foundation-schema.sql','quant-storage-schema.sql',
    'quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
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



import {createProfileEnrollmentTicketAuthority} from '../../src/postgres/quant-profile-enrollment-ticket.js';
import {ensureQuantProfileEnrollmentSchema,loadQuantProfileEnrollmentSchemaAssertion} from '../../src/postgres/quant-profile-enrollment-migration.js';
const serial=fn=>db.transaction(fn,{isolation:'SERIALIZABLE'});
let authority,context,contract,tickets,epoch={},assertSchema;
test('real locked enrollment authority binds current raw/deployment and performs no dataset inspection',async()=>{
 await db.transaction(()=>ensureQuantProfileEnrollmentSchema(db));assertSchema=await loadQuantProfileEnrollmentSchemaAssertion();
 const end=Math.floor(now/minute)*minute-2*minute;
 const raw=await db.transaction(()=>data.enqueue(owner,{bot_id:owner,start_time:end-20*minute,end_time:end,warmup_bars:500,cutoff:Math.floor(now/minute)*minute},randomUUID()));
 assert.equal(await worker.tick(),true);
 const body={bot_id:owner,raw_job_id:raw.job_id,deployment_id:deploymentId};
 const previous=await db.transaction(()=>profile.enqueue(owner,body,randomUUID()));
 const old=(await row(previous.job_id)).contract;await db.transaction(()=>profile.get(owner,previous.job_id,true));
 const policy=profileV2Fixture(520).policy;policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 Object.assign(policy.scope,{source_hash:old.profile.source_hash,settings_hash:old.profile.effective_inputs_hash});
 const {ingestionEngineHash}=await import('../../src/postgres/quant-data.js');
 tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:ingestionEngineHash,releaseGuard:()=>epoch,isTransaction:()=>db.isTransaction});
 authority=new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,enabled:true,supportedSourceHash:hash(source),capacityPolicy:policy,profileV2Enabled:true,enrollmentEnabled:true,enrollmentTicketVerifier:tickets.assert});
 const queued=await serial(()=>authority.enqueueEnrollment(owner,body,randomUUID()));const token=randomUUID();
 await db.query("UPDATE quant_foundation_jobs SET status='RUNNING',lease_token=$2,lease_until=$3,run_started_at=$4,worker_id='fixture-worker' WHERE job_id=$1",[queued.job_id,token,now+60000,now]);
 const active=await row(queued.job_id);contract=active.contract;
 const ticket=await tickets.prepare({job:active,leaseToken:token,operationId:'authority-operation',payloadHash:hash('fixture-payload'),policy});
 context={jobId:queued.job_id,leaseToken:token,executionTicket:ticket,phase:'BEGIN'};
 const inspect=data.datasetStore.inspect;data.datasetStore.inspect=async()=>{throw Error('Filesystem called in locked authority');};
 try{assert.deepEqual(await serial(()=>authority.authorizeEnrollmentLocked(owner,contract,context)),{ok:true});}
 finally{data.datasetStore.inspect=inspect;}
 const rollback=Error('rollback');
 for(const sql of [
  {text:"UPDATE users SET status='DISABLED' WHERE id=$1",values:[owner]},
  {text:"UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",values:[deploymentId]},
  {text:'UPDATE pine_memberships SET connected=FALSE WHERE bot_id=$1',values:[owner]},
  {text:"UPDATE pine_bridge_evidence SET evidence_hash=$2 WHERE deployment_id=$1",values:[deploymentId,hash('changed-evidence')]},
  {text:"UPDATE pine_source_revisions SET source_hash=$2 WHERE pine_import_id=(SELECT pine_import_id FROM pine_deployments WHERE deployment_id=$1)",values:[deploymentId,hash('changed-source')]},
  {text:"UPDATE pine_source_revisions SET analysis=jsonb_set(analysis,'{effective_input_review,reviewed_by}',to_jsonb('changed-reviewer'::text)) WHERE pine_import_id=(SELECT pine_import_id FROM pine_deployments WHERE deployment_id=$1)",values:[deploymentId]},
  {text:"UPDATE quant_foundation_jobs SET result=jsonb_set(result,'{dataset,sha256}',to_jsonb($2::text)) WHERE job_id=$1",values:[raw.job_id,hash('changed-raw')]},
  {text:"UPDATE quant_foundation_jobs SET result=jsonb_set(result,'{provenance,range,page_count}','999'::jsonb) WHERE job_id=$1",values:[raw.job_id]},
  {text:"UPDATE risk_profiles SET policy=jsonb_set(policy::jsonb,'{paperTrading}','false'::jsonb)::text WHERE user_id=$1",values:[owner]},
  {text:"INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,1,1,'CONFIGURATION')",values:[owner,now]},
  {text:"INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'CONFIGURATION')",values:[owner,now]}
 ])await assert.rejects(serial(async()=>{await db.query(sql.text,sql.values);assert.deepEqual(await authority.authorizeEnrollmentLocked(owner,contract,context),{ok:false});throw rollback;}),error=>error===rollback);
 const final=await tickets.refresh(ticket);context.executionTicket=final;context.phase='FINALIZE';
 await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='PROFILE_COMPLETING',lease_until=NULL,run_started_at=NULL WHERE job_id=$1",[queued.job_id]);
 assert.deepEqual(await serial(()=>authority.authorizeEnrollmentLocked(owner,contract,context)),{ok:true});
 const previousEpoch=epoch;epoch={};assert.deepEqual(await serial(()=>authority.authorizeEnrollmentLocked(owner,contract,context)),{ok:false});epoch=previousEpoch;
});
test('locked authority holds owner and deployment locks until publication transaction ends',async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;const other=new PostgresDatabase({connectionString:url.toString()});
 try{await serial(async()=>{
  assert.deepEqual(await authority.authorizeEnrollmentLocked(owner,contract,context),{ok:true});
  for(const mutation of [
   {sql:"UPDATE users SET status='DISABLED' WHERE id=$1",values:[owner]},
   {sql:"UPDATE pine_deployments SET state='REVOKED' WHERE deployment_id=$1",values:[deploymentId]}
  ])await assert.rejects(other.transaction(async()=>{await other.query("SET LOCAL lock_timeout='250ms'");await other.query(mutation.sql,mutation.values);}),error=>error.code==='55P03');
 });}finally{await other.close();}
});
test('locked authority propagates a real SQL error so publication transaction cannot commit',async()=>{
 const scope=data.scope.bind(data);data.scope=async(...args)=>{await scope(...args);await db.query('SELECT 1/0');};
 try{await assert.rejects(serial(()=>authority.authorizeEnrollmentLocked(owner,contract,context)),error=>error.code==='22012');}
 finally{data.scope=scope;}
 assert.equal((await row(context.jobId)).status,'STOPPING');
 assert.equal((await db.query('SELECT count(*)::int count FROM quant_profile_enrollment_receipts WHERE job_id=$1',[context.jobId])).rows[0].count,0);
});
test('preloaded SQL schema assertion holds immutable trigger against concurrent DDL',async()=>{
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;const other=new PostgresDatabase({connectionString:url.toString()});
 try{await serial(async()=>{
  assert.equal(await assertSchema(db),true);
  await assert.rejects(other.transaction(async()=>{await other.query("SET LOCAL lock_timeout='250ms'");await other.query('ALTER TABLE public.quant_profile_enrollment_receipts DISABLE TRIGGER quant_profile_enrollment_receipt_guard');}),error=>error.code==='55P03');
 });}finally{await other.close();}
});
