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


const serial=fn=>db.transaction(fn,{isolation:'SERIALIZABLE'});
let enrollment,body,capacityPolicy;
test('offline enrollment extension installs exactly and admission builds marked staging contract',async()=>{
 const {ensureQuantProfileEnrollmentSchema,assertQuantProfileEnrollmentSchema}=await import('../../src/postgres/quant-profile-enrollment-migration.js');
 await assert.rejects(ensureQuantProfileEnrollmentSchema(db),{code:'QUANT_PROFILE_ENROLLMENT_OFFLINE_TRANSACTION_REQUIRED'});
 await assert.rejects(assertQuantProfileEnrollmentSchema(db),{code:'QUANT_PROFILE_ENROLLMENT_SCHEMA_UNSUPPORTED'});
 await db.transaction(()=>ensureQuantProfileEnrollmentSchema(db));
 assert.equal(await assertQuantProfileEnrollmentSchema(db),true);
 await db.transaction(()=>ensureQuantProfileEnrollmentSchema(db));
 const end=Math.floor(now/minute)*minute-2*minute;
 const raw=await db.transaction(()=>data.enqueue(owner,{bot_id:owner,start_time:end-20*minute,end_time:end,warmup_bars:500,cutoff:Math.floor(now/minute)*minute},randomUUID()));
 assert.equal(await worker.tick(),true);
 body={bot_id:owner,raw_job_id:raw.job_id,deployment_id:deploymentId};
 const old=await db.transaction(()=>profile.enqueue(owner,body,randomUUID()));
 const contract=(await row(old.job_id)).contract;
 await db.transaction(()=>profile.get(owner,old.job_id,true));
 capacityPolicy=profileV2Fixture(520).policy;capacityPolicy.environment='staging';
 capacityPolicy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 Object.assign(capacityPolicy.scope,{source_hash:contract.profile.source_hash,settings_hash:contract.profile.effective_inputs_hash});
 enrollment=new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,enabled:true,supportedSourceHash:hash(source),capacityPolicy,profileV2Enabled:true,enrollmentEnabled:true});
 await assert.rejects(enrollment.enqueueEnrollment(owner,body,randomUUID()),{code:'PROFILE_ENROLLMENT_TRANSACTION_REQUIRED'});
 await assert.rejects(db.transaction(()=>enrollment.enqueueEnrollment(owner,body,randomUUID())),{code:'PROFILE_ENROLLMENT_TRANSACTION_REQUIRED'});
 const key=randomUUID(),queued=await serial(()=>enrollment.enqueueEnrollment(owner,body,key));
 const stored=await row(queued.job_id);assert.equal(stored.contract.completion_mode,'pf2-enrollment-v1');
 assert.equal(stored.contract.capacity.environment,'staging');assert.equal(stored.contract.capacity.dataset.raw_bars,520);
 assert.equal(stored.contract.budget.candidates,1);assert.equal(stored.contract.budget.max_evaluations,1);
 assert.equal(stored.contract_hash,hash(canonical(stored.contract)));
 assert.equal((await serial(()=>enrollment.enqueueEnrollment(owner,body,key))).job_id,queued.job_id);
 await assert.rejects(serial(()=>enrollment.enqueueEnrollment(owner,{...body,deployment_id:randomUUID()},key)),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(serial(()=>profile.enqueue(owner,body,key)),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(serial(()=>enrollment.enqueueEnrollment(foreign,body,randomUUID())),{code:'NOT_FOUND'});
 await assert.rejects(serial(()=>enrollment.enqueueEnrollment(owner,{...body,completion_mode:'pf2-enrollment-v1'},randomUUID())));
 const disabled=new QuantProfileService({capacityPolicy});assert.equal(disabled.profileV2Enabled,false);assert.equal(disabled.enrollmentEnabled,false);
 await assert.rejects(disabled.enqueueEnrollment(owner,body,randomUUID()),{code:'PROFILE_ENROLLMENT_DISABLED'});
 await db.transaction(()=>enrollment.get(owner,queued.job_id,true));
 // Unmarked PROFILE rows fill the queue; marked rows would meet the one-active-enrollment guard before the queue cap.
 const {completion_mode:ignored,...unmarked}=stored.contract;void ignored;
 const rollback=Error('rollback');
 await assert.rejects(serial(async()=>{
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
   SELECT gen_random_uuid(),$1,'limit-fixture-'||n,$2,$3,'QUEUED',$4,$5 FROM generate_series(1,20) n`,
   [owner,JSON.stringify(unmarked),stored.contract_hash,now,now+900000]);
  await assert.rejects(enrollment.enqueueEnrollment(owner,body,randomUUID()),{code:'FOUNDATION_QUEUE_FULL'});
  throw rollback;
 }),error=>error===rollback);
 for(const mutate of [p=>p.environment='local',p=>delete p.terminal]){
  const changed=structuredClone(capacityPolicy);mutate(changed);
  const rejected=new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,
   enabled:true,supportedSourceHash:hash(source),capacityPolicy:changed,profileV2Enabled:true,enrollmentEnabled:true});
  await assert.rejects(serial(()=>rejected.enqueueEnrollment(owner,body,randomUUID())),{code:'QUANT_CAPACITY_POLICY_INVALID'});
 }
});
test('one active enrollment per owner and bot: a new key is refused with 409, the same key replays, terminal states free the slot',async()=>{
 const refusal=error=>error.code==='PROFILE_ENROLLMENT_ALREADY_ACTIVE'&&error.status===409;
 const activeEnrollments=async()=>(await db.query(`SELECT count(*)::int n FROM quant_foundation_jobs WHERE owner_id=$1
  AND status IN ('QUEUED','PAUSED','RUNNING','STOPPING') AND contract->>'completion_mode'='pf2-enrollment-v1'`,[owner])).rows[0].n;
 const footprint=async()=>(await db.query(`SELECT (SELECT count(*) FROM quant_foundation_jobs)::int jobs,
  (SELECT count(*) FROM quant_io_ledgers)::int ledgers,(SELECT count(*) FROM quant_io_launches)::int launches`)).rows[0];
 const set=(id,sql,...values)=>db.query('UPDATE quant_foundation_jobs SET '+sql+' WHERE job_id=$1',[id,...values]);
 const cancelQueued=()=>db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE owner_id=$1 AND status='QUEUED'",[owner]);
 assert.equal(await activeEnrollments(),0);
 const key=randomUUID(),first=await serial(()=>enrollment.enqueueEnrollment(owner,body,key));
 const before=await footprint(),token=randomUUID();
 // Every active status blocks a new key and creates no job, ledger or launch; the original key keeps replaying its job.
 for(const [status,move] of [['QUEUED',null],['PAUSED',()=>set(first.job_id,"status='PAUSED'")],
  ['RUNNING',()=>set(first.job_id,"status='RUNNING',lease_token=$2,lease_until=$3,run_started_at=$4,worker_id='fixture-worker'",token,now+60000,now)],
  ['STOPPING',()=>set(first.job_id,"status='STOPPING',stop_reason='CANCELLED',lease_until=NULL")]]){
  if(move)await move();
  assert.equal((await row(first.job_id)).status,status);
  await assert.rejects(serial(()=>enrollment.enqueueEnrollment(owner,body,randomUUID())),refusal);
  assert.equal((await serial(()=>enrollment.enqueueEnrollment(owner,body,key))).job_id,first.job_id);
  assert.deepEqual(await footprint(),before);
 }
 await set(first.job_id,"status='CANCELLED',lease_token=NULL,lease_until=NULL,stop_reason=NULL");
 assert.equal(await activeEnrollments(),0);
 assert.equal((await serial(()=>enrollment.enqueueEnrollment(owner,body,key))).job_id,first.job_id);
 const second=await serial(()=>enrollment.enqueueEnrollment(owner,body,randomUUID()));
 assert.notEqual(second.job_id,first.job_id);assert.equal(await activeEnrollments(),1);
 await assert.rejects(serial(()=>enrollment.enqueueEnrollment(owner,body,randomUUID())),refusal);
 // A succeeded enrollment frees the slot, and an active unmarked (diagnostic) PROFILE job neither blocks nor counts.
 await set(second.job_id,"status='SUCCEEDED'");
 const {completion_mode:ignored,...unmarked}=(await row(second.job_id)).contract;void ignored;
 await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
  VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)`,[randomUUID(),owner,randomUUID(),JSON.stringify(unmarked),hash(canonical(unmarked)),now,now+900000]);
 await serial(()=>enrollment.enqueueEnrollment(owner,body,randomUUID()));
 assert.equal(await activeEnrollments(),1);
 await cancelQueued();assert.equal(await activeEnrollments(),0);
 // Two simultaneous new keys: the scheduler lock and the SERIALIZABLE commit leave exactly one active job.
 const race=await Promise.allSettled([serial(()=>enrollment.enqueueEnrollment(owner,body,randomUUID())),
  serial(()=>enrollment.enqueueEnrollment(owner,body,randomUUID()))]);
 assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
 const loser=race.find(result=>result.status==='rejected').reason;
 assert.ok(refusal(loser)||loser.code==='40001',String(loser.code));
 assert.equal(await activeEnrollments(),1);
 await cancelQueued();
});test('exact schema verification rejects shape, trigger, function, constraint and shadow FK drift',async()=>{
 const {assertQuantProfileEnrollmentSchema}=await import('../../src/postgres/quant-profile-enrollment-migration.js');
 const rollback=Error('rollback');
 for(const sql of [
  'ALTER TABLE public.quant_profile_enrollment_receipts DISABLE TRIGGER quant_profile_enrollment_receipt_guard',
  'ALTER TABLE public.quant_profile_enrollment_receipts ALTER COLUMN payload_hash DROP NOT NULL',
  'ALTER TABLE public.quant_profile_enrollment_receipts ADD COLUMN extra TEXT',
  'ALTER TABLE public.quant_profile_enrollment_schema DROP CONSTRAINT quant_profile_enrollment_schema_version_check',
  "CREATE OR REPLACE FUNCTION public.quant_profile_enrollment_receipt_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
  "ALTER TABLE public.quant_foundation_jobs DROP CONSTRAINT quant_foundation_jobs_stop_reason_check",
  "CREATE SCHEMA evil; CREATE TABLE evil.quant_foundation_jobs(job_id UUID PRIMARY KEY); ALTER TABLE public.quant_profile_enrollment_receipts DROP CONSTRAINT quant_profile_enrollment_receipts_job_id_fkey; ALTER TABLE public.quant_profile_enrollment_receipts ADD FOREIGN KEY(job_id) REFERENCES evil.quant_foundation_jobs(job_id); SET LOCAL search_path=evil,public"
 ])await assert.rejects(db.transaction(async()=>{await db.query(sql);await assert.rejects(assertQuantProfileEnrollmentSchema(db),{code:'QUANT_PROFILE_ENROLLMENT_SCHEMA_UNSUPPORTED'});throw rollback;}),error=>error===rollback);
 assert.equal(await assertQuantProfileEnrollmentSchema(db),true);
});
test('receipt table forbids update and delete, and enforces hashes and launch relationship',async()=>{
 const id=randomUUID(),operation='fixture-operation',token=randomUUID();
 await db.query("INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'CANCELLED',$6,$7)",[id,owner,randomUUID(),JSON.stringify({kind:'PROFILE'}),hash('fixture-contract'),now,now+900000]);
 const state={operations:[]};
 await db.query('INSERT INTO quant_io_ledgers(job_id,policy_hash,lease_token,revision,state,state_hash) VALUES($1,$2,$3,0,$4,$5)',[id,hash('policy'),token,JSON.stringify(state),hash(canonical(state))]);
 await db.query("INSERT INTO quant_io_launches(job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at) VALUES($1,$2,$3,$4,$5,'STOP_PROVEN',$6)",[id,operation,token,'fixture-unit.service',hash('fixture-payload'),now]);
 const values=['profile-enrollment-receipt-v1',id,operation,token,...Array(4).fill(hash('fixture-hash')),JSON.stringify(capacityPolicy),hash('stop'),hash('readback'),now,hash('receipt')];
 const insert='INSERT INTO quant_profile_enrollment_receipts VALUES('+values.map((_,i)=>'$'+(i+1)).join(',')+')';
 const malformed=[...values];malformed[4]='bad';await assert.rejects(db.query(insert,malformed));
 const crossed=[...values];crossed[2]='missing-operation';await assert.rejects(db.query(insert,crossed));
 await db.query(insert,values);
 await assert.rejects(db.query('UPDATE quant_profile_enrollment_receipts SET completed_at=completed_at+1 WHERE job_id=$1',[id]),/immutable/);
 await assert.rejects(db.query('DELETE FROM quant_profile_enrollment_receipts WHERE job_id=$1',[id]),/immutable/);
});
