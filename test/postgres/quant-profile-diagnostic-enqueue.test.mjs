import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantDataService,ingestionEngineHash} from '../../src/postgres/quant-data.js';
import {QuantProfileService} from '../../src/postgres/quant-profile.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantProfileRuntimeV2} from '../../src/postgres/quant-profile-runtime-v2.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {buildProfileV2} from '../../src/quant-research/profile-pipeline-v2.js';
import {capacityPolicyHash} from '../../src/quant-research/capacity-contract.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';
import {fixture,source} from '../helpers/quant-research-fixture.mjs';
import {enqueueQuantProfileDiagnostic,runQuantProfileDiagnostic,diagnosticReport}
  from '../../scripts/enqueue-quant-profile-diagnostic.mjs';

const minute=60000;
const code=expected=>error=>error.code===expected;
let admin,db,databaseUrl,name,root,store,pine,data,researchStore,budget,rawStore,now,owner,foreign,deploymentId,
  rawJobId,policy,diag,enrollment,worker,researchService,input;
const serial=fn=>db.transaction(fn,{isolation:'SERIALIZABLE'});
const row=async id=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
const request=(extra={})=>({owner_id:owner,bot_id:owner,raw_job_id:rawJobId,deployment_id:deploymentId,
  idempotency_key:'diag-'+randomUUID(),...extra});
const run=(options={})=>enqueueQuantProfileDiagnostic({db,profileService:diag,policy,request:options.request,
  clock:()=>now,...options});

/** Row count and content digest of every public table: a write anywhere changes the fingerprint. */
async function fingerprint(){
  const tables=(await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows;
  const result={};
  for(const {table_name} of tables)result[table_name]=(await db.query(
    `SELECT count(*)::int n,md5(COALESCE(string_agg(t::text,'|' ORDER BY t::text),'')) digest FROM public."${table_name}" t`)).rows[0];
  return result;
}
async function unchanged(label,action){
  const before=await fingerprint();
  try{return await action();}finally{assert.deepEqual(await fingerprint(),before,label+' changed the database');}
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_diag_enqueue_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;databaseUrl=url.toString();
  db=new PostgresDatabase({connectionString:databaseUrl});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
    'quant-research-foundation-schema.sql','quant-storage-schema.sql','quant-io-ledger-schema.sql',
    'quant-io-runtime-schema.sql','quant-profile-enrollment-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  root=await fs.mkdtemp(path.join(os.tmpdir(),'quant-diag-pg-'));
  await db.transaction(()=>bindQuantStorage(db,root));
  budget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  rawStore=new DatasetStore({root,storageBudget:budget});
  researchStore=new ResearchDatasetStore({root,storageBudget:budget,allowUnsupportedDirectorySyncForTests:true});
  store=new Store(db);pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  now=Math.floor(Date.now()/minute)*minute+4*minute;
  data=new QuantDataService({pineService:pine,datasetStore:rawStore,clock:()=>now,enabled:true});
  owner=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  foreign=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  const risk={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,
    equities:{'binance-global':1000},balances:{'binance-global':1000}};
  await store.setRisk(owner,risk);
  input=fixture();const importId=randomUUID();deploymentId=randomUUID();
  await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,owner,owner,1,
    hash(source),'Profile fixture',source,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,
    hash(source),source,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,owner,owner,1);
  const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
  const capital=await store.paperAccounts(owner);
  const funding=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(owner)).cutoff;
  const snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),
    market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy:risk,
    policy_hash:hash(canonical(risk)),capital,funding_cutoff:funding,membership:members,
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
  researchService={foundation:true,db,store,datasetStore:researchStore,storageBudget:budget,executorMode:()=>data.ready()};
  const fetchHistory=(range,{onPage}={})=>{
    const first=range.start_time-range.warmup_bars*minute;
    onPage?.({start_time:first,end_time:range.end_time,count:(range.end_time-first)/minute,
      sha256:hash('profile-page'),retrieved_at:now,source:'https://api.binance.com/api/v3/klines',
      timestamp_semantics:'UTC open time; end exclusive'});
    return (async function*(){for(let time=first;time<range.end_time;time+=minute)
      yield {time,open:'100',high:'102',low:'99',close:'101',volume:'1'};})();
  };
  const backfill=new QuantResearchFoundationWorker({service:researchService,dataService:data,
    health:async()=>({ok:true}),clock:()=>now,fetchHistory,stopUnit:async()=>true});
  const end=Math.floor(now/minute)*minute-2*minute;
  const raw=await serial(()=>data.enqueue(owner,{bot_id:owner,start_time:end-20*minute,end_time:end,warmup_bars:500,
    cutoff:Math.floor(now/minute)*minute},randomUUID()));
  assert.equal(await backfill.tick(),true);
  rawJobId=raw.job_id;assert.equal((await row(rawJobId)).status,'SUCCEEDED');
  policy=profileV2Fixture(520).policy;policy.environment='staging';
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
  Object.assign(policy.scope,{source_hash:hash(source),settings_hash:input.analysis.effective_inputs_hash});
  const service=enrolled=>new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,
    enabled:true,supportedSourceHash:hash(source),capacityPolicy:policy,profileV2Enabled:true,enrollmentEnabled:enrolled});
  diag=service(false);enrollment=service(true);
});
after(async()=>{
  await worker?.stop();await db?.close();if(name)await admin.query('DROP DATABASE '+name);
  await admin?.close();if(root)await fs.rm(root,{recursive:true,force:true});
});

let plan,unmarked,marked;
test('dry run prints a deterministic plan, changes nothing and matches the enrollment contract without its mode',async()=>{
  const selection=request();
  plan=await unchanged('dry run',()=>run({request:selection}));
  assert.deepEqual([plan.ok,plan.mode,plan.outcome,plan.refusal,plan.raw_bars,plan.claim_window_ms,plan.completion_mode,
    plan.evaluator_admission,plan.job_id,plan.job_status,plan.reused],
    [true,'dry-run','WOULD_ENQUEUE',null,520,825000,null,false,null,null,false]);
  assert.equal(plan.policy_hash,capacityPolicyHash(policy));assert.equal(plan.engine_hash,await ingestionEngineHash());
  assert.equal(plan.request_sha256,hash(canonical(selection)));
  assert.deepEqual(await unchanged('second dry run',()=>run({request:selection})),plan);
  // The server-built enrollment contract and the diagnostic contract differ only by the completion mode.
  const rollback=Error('rollback');
  await assert.rejects(serial(async()=>{
    const queued=await enrollment.enqueueEnrollment(owner,{bot_id:owner,raw_job_id:rawJobId,deployment_id:deploymentId},randomUUID());
    marked=(await row(queued.job_id)).contract;throw rollback;
  }),error=>error===rollback);
  const {completion_mode,...rest}=marked;unmarked=rest;
  assert.equal(completion_mode,'pf2-enrollment-v1');
  assert.equal(hash(canonical(unmarked)),plan.contract_hash);
  assert.equal(unmarked.version,'quant-foundation-v2');assert.equal(unmarked.capacity.environment,'staging');
  assert.equal(unmarked.budget.candidates,1);assert.equal(unmarked.budget.max_evaluations,1);
});

test('a write without the reviewed hash, with a stale hash or with an INSERT fault changes nothing',async()=>{
  const selection=request();
  await unchanged('missing hash',()=>assert.rejects(run({request:selection,enqueue:true}),code('QUANT_DIAGNOSTIC_PLAN_REQUIRED')));
  await unchanged('stale hash',()=>assert.rejects(run({request:selection,enqueue:true,expectContractHash:'0'.repeat(64)}),
    error=>error.code==='QUANT_DIAGNOSTIC_PLAN_MISMATCH'&&error.plan.contract_hash===plan.contract_hash));
  const original=db.query;
  db.query=function(sql,params){
    if(/^\s*INSERT INTO quant_foundation_jobs/.test(sql))return Promise.reject(Object.assign(Error('injected fault'),{code:'XX000'}));
    return original.call(this,sql,params);
  };
  try{
    await unchanged('insert fault',()=>assert.rejects(run({request:selection,enqueue:true,expectContractHash:plan.contract_hash}),
      error=>error.code==='XX000'));
  }finally{delete db.query;}
  assert.equal(Object.hasOwn(db,'query'),false);
});

let created;
test('two concurrent writes under different keys create exactly one unmarked queued job',async()=>{
  const first=request(),second=request(),before=await fingerprint();
  const settled=await Promise.allSettled([first,second].map(selection=>
    run({request:selection,enqueue:true,expectContractHash:plan.contract_hash})));
  const won=settled.filter(item=>item.status==='fulfilled'),lost=settled.filter(item=>item.status==='rejected');
  assert.equal(won.length,1);assert.equal(lost.length,1);
  // The second command waits for the table lock for one second at most. After a commit within that time it sees the
  // first job and refuses with BOT_ACTIVE. On a slow host it refuses with LOCK_TIMEOUT instead. Nothing is written.
  assert.ok(['QUANT_DIAGNOSTIC_BOT_ACTIVE','QUANT_DIAGNOSTIC_LOCK_TIMEOUT'].includes(lost[0].reason.code),lost[0].reason.code);
  const stored=await row(won[0].value.job_id);
  created={...won[0].value,selection:stored.idempotency_key===first.idempotency_key?first:second};
  assert.deepEqual([created.mode,created.outcome,created.job_status,created.reused,created.contract_hash],
    ['enqueue','ENQUEUED','QUEUED',false,plan.contract_hash]);
  assert.deepEqual([stored.status,stored.attempts,stored.result,stored.checkpoint,stored.next_bar,stored.stop_reason,
    stored.diagnostic,stored.worker_id,stored.lease_token,stored.owner_id],['QUEUED',0,null,null,0,null,null,null,null,owner]);
  assert.equal(stored.contract_hash,plan.contract_hash);assert.equal(hash(canonical(stored.contract)),stored.contract_hash);
  assert.equal(Object.hasOwn(stored.contract,'completion_mode'),false);
  assert.deepEqual(stored.contract,unmarked);
  assert.deepEqual([stored.created_at,stored.deadline_at-stored.created_at],[now,900000]);
  const after=await fingerprint();
  assert.equal(after.quant_foundation_jobs.n,before.quant_foundation_jobs.n+1);
  assert.equal(after.quant_foundation_owners.n,before.quant_foundation_owners.n);
  for(const table of ['quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts'])
    assert.equal(after[table].n,0,table);
});

test('the same key returns the existing job and nothing is written; other keys and selections are refused',async()=>{
  for(const enqueue of [false,true]){
    const result=await unchanged('repeat',()=>run({request:created.selection,enqueue,
      expectContractHash:enqueue?plan.contract_hash:null}));
    assert.deepEqual([result.outcome,result.reused,result.job_id,result.job_status,result.contract_hash],
      ['EXISTING',true,created.job_id,'QUEUED',plan.contract_hash]);
  }
  await unchanged('stale hash on repeat',()=>assert.rejects(
    run({request:created.selection,enqueue:true,expectContractHash:'0'.repeat(64)}),code('QUANT_DIAGNOSTIC_PLAN_MISMATCH')));
  for(const changed of [{deployment_id:randomUUID()},{raw_job_id:randomUUID()}])
    await unchanged('conflict',()=>assert.rejects(run({request:{...created.selection,...changed}}),code('IDEMPOTENCY_CONFLICT')));
  // A key already bound to an enrollment (marked) contract is never reused as a diagnostic.
  const markedKey='marked-'+randomUUID();
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
    VALUES($1,$2,$3,$4,$5,'CANCELLED',$6,$7)`,[randomUUID(),owner,markedKey,JSON.stringify(marked),hash(canonical(marked)),now,now+900000]);
  await unchanged('marked conflict',()=>assert.rejects(run({request:{...created.selection,idempotency_key:markedKey}}),code('IDEMPOTENCY_CONFLICT')));
  // While the job waits, no other key can add work for the bot.
  for(const enqueue of [false,true])
    await unchanged('second job',()=>assert.rejects(run({request:request(),enqueue,expectContractHash:enqueue?plan.contract_hash:null}),
      error=>error.code==='QUANT_DIAGNOSTIC_BOT_ACTIVE'&&error.plan.contract_hash===null&&
        error.plan.policy_hash===plan.policy_hash));
});

const operations=[];
test('the product worker claims the helper job and diagnostic mode cancels it with a null result',async()=>{
  const logs=[],seen=[];let releases=0,builds=0,stops=0;
  worker=new QuantResearchFoundationWorker({service:researchService,dataService:data,profileService:diag,
    profileV2Enabled:true,capacityPolicy:policy,health:async()=>({ok:true}),clock:()=>now,
    terminalLog:line=>logs.push(JSON.parse(line)),stopUnit:async()=>true});
  const ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],clock:()=>now,
    authorizeTerminal:async({job,action,input:operation})=>{
      const own=worker.profileOperations.get(job.job_id);
      return {ok:db.isTransaction&&['settle','crash','acknowledgeCrashStop'].includes(action)&&
        own?.leaseToken===job.lease_token&&own?.operationId===operation?.operation_id};}});
  const launcher={terminalConfig:policy.terminal,async assertDrainHost(){/* Explicit synthetic host gate. */},
    spawnPrepared(){throw Error('prepare required');},
    async prepare({unitName,payload}){
      const envelope=JSON.parse(payload);
      seen.push({marked:Object.hasOwn(envelope.contract,'completion_mode'),contract:envelope.contract});
      const {jobId,operationId}=envelope;
      return {spawnPrepared(){
        const proof={unitName,group:'/user.slice/'+unitName,cgroupInode:23,invocationId:'1'.repeat(32)};
        let resolve,reject,stopProof;
        const sample=()=>({...proof,deviceId:'8:0',deviceInode:17,pid:4242,procStartTicks:'12345',readBytes:4096,writeBytes:4096});
        const stop=async()=>{if(!stopProof){stops++;stopProof={unitName,launcherClosed:true,startRegistered:true,
          pendingStartsExcluded:true,unitStopped:true};}return stopProof;};
        return {payloadHash:hash(payload),ready:Promise.resolve(proof),accepted:Promise.resolve({unitName,payloadHash:hash(payload)}),
          profileResult:new Promise((yes,no)=>{resolve=yes;reject=no;}),sample:async()=>sample(),stop,
          release(){
            releases++;
            buildProfileV2({contract:envelope.contract,policy,rawStore,researchStore,now:()=>now}).then(result=>{builds++;
              resolve({jobId,operationId,payloadHash:hash(payload),resultHash:hash(canonical(result)),result});},reject);
          },
          async terminate({commit}){
            const frozen=sample(),evidence={freezer:'frozen',windowMs:2500,reads:[{readBytes:4096,writeBytes:4096},
              {readBytes:4096,writeBytes:4096}],fileDirty:0,fileWriteback:0,maxBioBytes:1310720,
              rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}};
            await commit(frozen,evidence);
            return {stopProof:await stop(),measured:true,frozenSample:frozen,readbackEvidence:evidence,postExit:'REMOVED'};
          }};
      },async abort(){}};
    }};
  worker.profileRuntimeV2=new QuantProfileRuntimeV2({db,ledger,scheduler:worker.scheduler,launcher,storageBudget:budget,
    clock:()=>now,health:async()=>({ok:true}),
    authorizeRelease:(_identity,job)=>diag.authorize(job.owner_id,job.contract,'CHECKPOINT',
      {job_id:job.job_id,lease_token:job.lease_token})});
  assert.equal(await worker.tick(),true);
  const job=await row(created.job_id);
  assert.deepEqual([job.status,job.result,job.checkpoint,job.next_bar,job.stop_reason,job.diagnostic,job.attempts,
    job.worker_id,job.lease_token,job.lease_until],['CANCELLED',null,null,0,null,null,1,null,null,null]);
  assert.deepEqual(job.contract,unmarked);
  // The child saw exactly the unmarked contract the helper stored, and built a real provisional result from it.
  assert.deepEqual(seen.map(item=>item.marked),[false]);assert.deepEqual(seen[0].contract,unmarked);
  assert.deepEqual([releases,builds,stops],[1,1,1]);
  const launch=(await db.query('SELECT * FROM quant_io_launches')).rows,ledgers=(await db.query('SELECT * FROM quant_io_ledgers')).rows;
  assert.deepEqual([launch.length,launch[0].state,ledgers.length,ledgers[0].state.operations.length,
    ledgers[0].state.operations[0].status],[1,'STOP_PROVEN',1,1,'SETTLED']);
  assert.deepEqual(ledgers[0].state.operations[0].charge,{read_bytes:4096,write_bytes:4096});
  assert.equal((await db.query('SELECT count(*)::int n FROM quant_profile_enrollment_receipts')).rows[0].n,0);
  assert.deepEqual(logs.map(line=>[line.jobId,line.proof,line.reason]),[[created.job_id,'MEASURED_FINAL_SETTLED','COMPLETE']]);
  assert.equal(await worker.tick(),false);
  operations.push(...ledgers[0].state.operations);
});

test('after the job ran, the same key still returns it and nothing else can be created from the key',async()=>{
  for(const enqueue of [false,true]){
    const result=await unchanged('repeat after run',()=>run({request:created.selection,enqueue,
      expectContractHash:enqueue?plan.contract_hash:null}));
    assert.deepEqual([result.outcome,result.reused,result.job_id,result.job_status],['EXISTING',true,created.job_id,'CANCELLED']);
  }
});

async function refused(label,selection,expected,options={}){
  return unchanged(label,()=>assert.rejects(run({request:selection,...options}),error=>{
    assert.equal(error.code,expected,label);assert.ok(Number.isInteger(error.status),label);
    assert.equal(error.plan.request_sha256,hash(canonical(selection)),label);
    return true;
  },label));
}

test('owner, bot, raw job and deployment refusals use the product codes and write nothing',async()=>{
  const end=Math.floor(now/minute)*minute-2*minute;
  await refused('unknown raw job',request({raw_job_id:randomUUID()}),'NOT_FOUND');
  await refused('raw job of another kind',request({raw_job_id:created.job_id}),'NOT_FOUND');
  const waiting=await serial(()=>data.enqueue(owner,{bot_id:owner,start_time:end-30*minute,end_time:end,warmup_bars:500,
    cutoff:Math.floor(now/minute)*minute},randomUUID()));
  await serial(()=>data.get(owner,waiting.job_id,true));
  assert.equal((await row(waiting.job_id)).status,'CANCELLED');
  await refused('raw job not succeeded',request({raw_job_id:waiting.job_id}),'BACKFILL_RESULT_UNAVAILABLE');
  await refused('other owner, bot not theirs',request({owner_id:foreign}),'NOT_FOUND');
  await refused('other owner and bot, raw job not theirs',request({owner_id:foreign,bot_id:foreign}),'NOT_FOUND');
  await refused('unknown deployment',request({deployment_id:randomUUID()}),'NOT_FOUND');
  const stored=(await db.query('SELECT * FROM pine_deployments WHERE deployment_id=$1',[deploymentId])).rows[0];
  const revoked=randomUUID();
  await db.query(`INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'REVOKED',$8)`,[revoked,owner,owner,stored.pine_import_id,stored.source_version,
    JSON.stringify(stored.snapshot),stored.snapshot_hash,now]);
  await refused('deployment not READY',request({deployment_id:revoked}),'RESEARCH_DEPLOYMENT_NOT_READY');
  await db.query('UPDATE pine_deployments SET snapshot_hash=$2 WHERE deployment_id=$1',[deploymentId,hash('other-snapshot')]);
  try{await refused('snapshot hash mismatch',request(),'SNAPSHOT_HASH_MISMATCH');}
  finally{await db.query('UPDATE pine_deployments SET snapshot_hash=$2 WHERE deployment_id=$1',[deploymentId,stored.snapshot_hash]);}
  await db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[stored.pine_import_id]);
  try{await refused('stale membership',request(),'STALE_MEMBERSHIP');}
  finally{await db.query('UPDATE pine_memberships SET connected=TRUE WHERE pine_import_id=$1',[stored.pine_import_id]);}
  await run({request:request()});
});

test('wrong wiring or policy refuses before any database work',async()=>{
  const selection=request();
  const other=structuredClone(policy);other.scope.source_hash='7'.repeat(64);
  const mismatched=new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,enabled:true,
    supportedSourceHash:hash(source),capacityPolicy:other,profileV2Enabled:true,enrollmentEnabled:false});
  await unchanged('policy scope for another source',()=>assert.rejects(
    run({request:selection,profileService:mismatched,policy:other}),code('INVALID_FOUNDATION_V2')));
  await unchanged('enrollment service',()=>assert.rejects(run({request:selection,profileService:enrollment}),
    code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED')));
  await unchanged('service policy differs',()=>assert.rejects(run({request:selection,policy:other}),
    code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED')));
  for(const bad of [{...policy,environment:'local'},(({terminal,...rest})=>rest)(policy)])
    await unchanged('invalid policy',()=>assert.rejects(run({request:selection,policy:bad}),code('QUANT_CAPACITY_POLICY_INVALID')));
  await unchanged('request with execution fields',()=>assert.rejects(
    run({request:{...selection,completion_mode:'pf2-enrollment-v1'}}),code('QUANT_DIAGNOSTIC_REQUEST_INVALID')));
  await unchanged('transaction owned by caller',()=>serial(()=>assert.rejects(run({request:selection}),
    code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED'))));
});

async function fixtureJob({status,bot='other-bot'}){
  const id=randomUUID(),contract={version:'quant-foundation-v1',kind:'BACKFILL',owner_id:owner,bot_id:bot};
  const leased=['RUNNING','STOPPING'].includes(status);
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,
    deadline_at,worker_id,lease_token,lease_until,run_started_at,stop_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,owner,'fixture-'+randomUUID(),JSON.stringify(contract),hash(canonical(contract)),status,now,now+900000,
      leased?'fixture-worker':null,leased?randomUUID():null,status==='RUNNING'?now+30000:null,
      status==='RUNNING'?now:null,status==='STOPPING'?'CANCELLED':null]);
  return id;
}
const blocked=(label,expected,options={})=>unchanged(label,()=>assert.rejects(
  run({request:request(),enqueue:true,expectContractHash:plan.contract_hash,...options}),error=>{
    // The gate runs before the contract is built, so a refused plan has no contract hash.
    assert.equal(error.code,expected,label);assert.equal(error.plan.contract_hash,null,label);return true;
  },label));

test('an executor, a waiting job, an unresolved launch or operation and an invalid ledger each block the write',async()=>{
  for(const [status,expected] of [['RUNNING','QUANT_DIAGNOSTIC_NOT_IDLE'],['STOPPING','QUANT_DIAGNOSTIC_NOT_IDLE'],
    ['QUEUED','QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY'],['PAUSED','QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY']]){
    const id=await fixtureJob({status});
    try{
      await blocked(status,expected);
      await unchanged(status+' dry run',()=>assert.rejects(run({request:request()}),code(expected)));
    }finally{await db.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[id]);}
  }
  // A job of the same owner and bot reports its own code first, even next to other blockers.
  const same=await fixtureJob({status:'QUEUED',bot:owner}),running=await fixtureJob({status:'RUNNING'});
  try{await blocked('same bot',"QUANT_DIAGNOSTIC_BOT_ACTIVE");}
  finally{for(const id of [same,running])await db.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[id]);}
  const jobId=await fixtureJob({status:'CANCELLED'}),token=randomUUID();
  await db.query('INSERT INTO quant_io_ledgers(job_id,policy_hash,lease_token,revision,state,state_hash) VALUES($1,$2,$3,0,$4,$5)',
    [jobId,hash('policy'),token,JSON.stringify({operations:[]}),hash('state-0')]);
  await db.query(`INSERT INTO quant_io_launches(job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at)
    VALUES($1,'fixture-operation',$2,$3,$4,'STARTING',$5)`,[jobId,token,'fixture-unit-'+randomUUID()+'.service',hash('payload'),now]);
  await blocked('unresolved launch','QUANT_DIAGNOSTIC_NOT_IDLE');
  await db.query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1",[jobId]);
  let revision=0;
  const ledgerState=async state=>{
    revision++;
    await db.query('UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4 WHERE job_id=$1',
      [jobId,revision,JSON.stringify(state),hash(canonical(state))]);
  };
  await ledgerState({operations:'not-an-array'});await blocked('invalid ledger','QUANT_DIAGNOSTIC_NOT_IDLE');
  await ledgerState({operations:[{status:'RESERVED'}]});await blocked('unresolved operation','QUANT_DIAGNOSTIC_NOT_IDLE');
  await ledgerState({operations:[{status:'CRASHED'},{status:'SETTLED'}]});
  // Everything resolved: the same request is accepted again and still writes nothing in a dry run.
  const selection=request();
  const again=await unchanged('resolved dry run',()=>run({request:selection}));
  assert.deepEqual([again.outcome,again.contract_hash,again.request_sha256],
    ['WOULD_ENQUEUE',plan.contract_hash,hash(canonical(selection))]);
});

test('a busy system is refused right after the idempotency lookup, before any raw, deployment or contract work',async()=>{
  const trace=[],original=db.query;
  const traced=async action=>{
    trace.length=0;
    db.query=function(sql,params){trace.push(sql.replace(/\s+/g,' ').trim());return original.call(this,sql,params);};
    try{return await action();}finally{delete db.query;}
  };
  const busy=await fixtureJob({status:'QUEUED'});
  try{
    await traced(()=>assert.rejects(run({request:request(),enqueue:true,expectContractHash:plan.contract_hash}),
      code('QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY')));
  }finally{await db.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[busy]);}
  // The lock wait is bounded right before the lock, and the gate is the last statement the refused command runs.
  assert.match(trace[1],/^SET LOCAL lock_timeout='1000ms'$/);
  assert.match(trace[2],/^LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE$/);
  assert.match(trace.at(-1),/bot_active/);
  assert.equal(trace.filter(sql=>/pine_deployments|pine_bridge_evidence|pine_source_revisions|WHERE job_id=\$1/.test(sql)).length,0,
    'no deployment or raw job read before the gate refuses');
  // On an idle system the order holds: lookup, gate, then the raw job read, then the deployment reads.
  await traced(()=>run({request:request()}));
  const lookup=trace.findIndex(sql=>/idempotency_key=\$2/.test(sql));
  const gate=trace.findIndex(sql=>/bot_active/.test(sql));
  const rawJob=trace.findIndex(sql=>/^SELECT \* FROM quant_foundation_jobs WHERE job_id=\$1$/.test(sql));
  const deployment=trace.findIndex((sql,index)=>index>lookup&&/FROM pine_deployments/.test(sql));
  assert.ok(lookup>2&&gate===lookup+1&&gate<rawJob&&rawJob<deployment,JSON.stringify([lookup,gate,rawJob,deployment]));
  // SET LOCAL ends with the transaction: the pooled connection that ran the command has the default timeout again.
  assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout,'0');
});

/** Holds ROW SHARE on the scheduler in a transaction of its own, as a worker does while it claims or commits. */
async function holdScheduler(){
  const holder=new PostgresDatabase({connectionString:databaseUrl,max:2});
  let release,acquired;
  const released=new Promise(resolve=>{release=resolve;}),held=new Promise(resolve=>{acquired=resolve;});
  const transaction=holder.transaction(async()=>{
    await holder.query('LOCK TABLE quant_foundation_scheduler IN ROW SHARE MODE');acquired();await released;
  });
  await Promise.race([held,transaction]);
  return async()=>{release();await transaction;await holder.close();};
}
const queuedForScheduler=async()=>(await db.query(`SELECT count(*)::int n FROM pg_locks l
  JOIN pg_class c ON c.oid=l.relation WHERE c.relname='quant_foundation_scheduler' AND l.mode='ExclusiveLock' AND NOT l.granted
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).rows[0].n;

test('a worker holding the scheduler is waited for about a second and never blocks the next worker request longer',async()=>{
  const release=await holdScheduler();
  let waited=null,elapsed=null;
  try{
    await unchanged('lock timeout',async()=>{
      const started=Date.now();
      const command=run({request:request()}).catch(error=>error);
      for(const limit=Date.now()+5000;await queuedForScheduler()===0;await new Promise(resolve=>setTimeout(resolve,20)))
        if(Date.now()>limit)assert.fail('the command never queued for the scheduler lock');
      // A worker terminal commit arrives now. It queues behind the command's pending EXCLUSIVE request, and without
      // the lock timeout it would wait there for as long as the first worker holds the table.
      const next=new PostgresDatabase({connectionString:databaseUrl,max:2});
      try{
        const arrived=Date.now();
        await next.transaction(()=>next.query('LOCK TABLE quant_foundation_scheduler IN ROW SHARE MODE'));
        waited=Date.now()-arrived;
      }finally{await next.close();}
      const refusal=await command;elapsed=Date.now()-started;
      assert.equal(refusal.code,'QUANT_DIAGNOSTIC_LOCK_TIMEOUT');assert.ok(Number.isInteger(refusal.status));
      assert.equal(refusal.plan.contract_hash,null);
      const line=JSON.parse(diagnosticReport({error:refusal,mode:'dry-run'}));
      assert.deepEqual([line.ok,line.outcome,line.refusal,line.sqlstate],[false,'REFUSED','QUANT_DIAGNOSTIC_LOCK_TIMEOUT',null]);
    });
  }finally{await release();}
  // The first worker held the table the whole time, so the second request was freed by the timeout alone.
  assert.ok(elapsed>=900&&elapsed<4000,'the command refused after '+elapsed+' ms');
  assert.ok(waited<2500,'the next request waited '+waited+' ms');
  // Once the worker is gone the same command works again.
  assert.equal((await run({request:request()})).outcome,'WOULD_ENQUEUE');
});

test('a real server fault reports only its SQLSTATE and never its message',async()=>{
  for(const [sql,sqlstate] of [['SELECT 1/0','22012'],['SELECT 1 FROM diagnostic_table_that_does_not_exist','42P01']]){
    const error=await db.query(sql).then(()=>null,failure=>failure);
    assert.equal(typeof error?.severity,'string',sql);
    const line=diagnosticReport({error,mode:'dry-run'}),report=JSON.parse(line);
    assert.deepEqual([report.ok,report.outcome,report.refusal,report.sqlstate],
      [false,'REFUSED','QUANT_DIAGNOSTIC_FAILED',sqlstate],sql);
    assert.doesNotMatch(line,/division|zero|relation|exist|diagnostic_table/i);
  }
});

test('the command prints one redacted plan from the real records and refuses a write without the plan hash',async()=>{
  const selection=request(),file='/home/owner/private/request.json';
  const environment={PINE_BRIDGE_ENV:'staging',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1',QUANT_RESEARCH_ENABLED:'1',
    QUANT_RESEARCH_FOUNDATION_ENABLED:'1',QUANT_PROFILE_V2_ENABLED:'1',QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'0',
    QUANT_PREFLIGHT_ENABLED:'0',DATABASE_URL:'postgres://fixture',QUANT_CAPACITY_POLICY_FILE:'/etc/robot/capacity.json',
    QUANT_STORAGE_LIMITS_FILE:'/etc/robot/storage.json',QUANT_RESEARCH_DATASET_ROOT:root};
  let closed=0;
  const command=argv=>runQuantProfileDiagnostic({argv,environment,platform:'linux',readRequest:async()=>selection,
    loadPolicy:async()=>policy,openDependencies:async()=>({db,profileService:diag,close:async()=>{closed++;}}),clock:()=>now});
  const dry=await unchanged('command dry run',()=>command([file]));
  const output=JSON.parse(dry.output);
  assert.equal(dry.exitCode,0);
  assert.deepEqual([output.ok,output.mode,output.outcome,output.refusal,output.contract_hash,output.policy_hash,output.raw_bars],
    [true,'dry-run','WOULD_ENQUEUE',null,plan.contract_hash,plan.policy_hash,520]);
  assert.equal((await unchanged('repeat',()=>command([file]))).output,dry.output);
  for(const secret of [owner,foreign,deploymentId,rawJobId,selection.idempotency_key,root,file,'/etc/robot'])
    assert.equal(dry.output.includes(secret),false,'the plan leaks a record identifier or a path');
  const refusedWrite=await unchanged('write without hash',()=>command([file,'--enqueue']));
  assert.deepEqual([refusedWrite.exitCode,JSON.parse(refusedWrite.output).refusal],[2,'QUANT_DIAGNOSTIC_PLAN_REQUIRED']);
  const busy=await fixtureJob({status:'QUEUED'});
  try{
    const result=await unchanged('write while busy',()=>command([file,'--enqueue','--expect-contract-hash='+plan.contract_hash]));
    assert.deepEqual([result.exitCode,JSON.parse(result.output).refusal,JSON.parse(result.output).contract_hash],
      [2,'QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY',null]);
  }finally{await db.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[busy]);}
  // The refused write stops at argument parsing, before any database is opened.
  assert.equal(closed,3);
  // The whole file created exactly one unmarked PROFILE V2 job, and the worker finished it CANCELLED.
  const unmarkedJobs=(await db.query(`SELECT job_id,status,result FROM quant_foundation_jobs
    WHERE contract->>'version'='quant-foundation-v2' AND contract->'completion_mode' IS NULL`)).rows;
  assert.deepEqual(unmarkedJobs.map(item=>[item.job_id,item.status,item.result]),[[created.job_id,'CANCELLED',null]]);
});

test('the default production dependencies connect, lock, wire the product services and stop at the source gate',async t=>{
  // The production constructors pin the supported source hash, so a synthetic fixture source must be refused
  // there. Reaching that refusal proves the connection, runtime lock, schema check, ready, scope and raw checks ran.
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quant-diag-env-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const limits=path.join(directory,'storage.json');
  await fs.writeFile(limits,JSON.stringify({diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0}));
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  const names=['DATABASE_URL','QUANT_STORAGE_LIMITS_FILE','QUANT_RESEARCH_DATASET_ROOT'];
  const saved=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{DATABASE_URL:url.toString(),QUANT_STORAGE_LIMITS_FILE:limits,QUANT_RESEARCH_DATASET_ROOT:root});
  const environment={PINE_BRIDGE_ENV:'staging',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1',QUANT_RESEARCH_ENABLED:'1',
    QUANT_RESEARCH_FOUNDATION_ENABLED:'1',QUANT_PROFILE_V2_ENABLED:'1',QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'0',
    QUANT_PREFLIGHT_ENABLED:'0',DATABASE_URL:'configured',QUANT_CAPACITY_POLICY_FILE:'/etc/robot/capacity.json',
    QUANT_STORAGE_LIMITS_FILE:'configured',QUANT_RESEARCH_DATASET_ROOT:'configured'};
  const selection=request();
  try{
    const result=await unchanged('production wiring',()=>runQuantProfileDiagnostic({argv:['/home/owner/request.json'],
      environment,platform:'linux',readRequest:async()=>selection,loadPolicy:async()=>policy,clock:()=>now}));
    const output=JSON.parse(result.output);
    assert.deepEqual([result.exitCode,output.ok,output.mode,output.outcome,output.refusal,output.policy_hash],
      [2,false,'dry-run','REFUSED','UNSUPPORTED_SOURCE_HASH',plan.policy_hash]);
    for(const secret of [owner,rawJobId,deploymentId,selection.idempotency_key,root,directory])
      assert.equal(result.output.includes(secret),false,'the output leaks a record identifier or a path');
  }finally{
    for(const key of names){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  }
});
