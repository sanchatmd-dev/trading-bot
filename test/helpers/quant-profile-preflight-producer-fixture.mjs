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
import {fixture} from './quant-research-fixture.mjs';
import {reviewedAnalysis} from './pf2-fixture.js';

const minute=60000;

export async function createProducerWorld(admin){
  let db,name,root,store,pine,data,profile,researchStore,budget,now,owner,foreign,deploymentId,worker;
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  name='quant_profile_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  try{
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
    'quant-research-foundation-schema.sql','quant-storage-schema.sql',
    'quant-io-ledger-schema.sql','quant-io-runtime-schema.sql','quant-profile-enrollment-schema.sql','quant-preflight-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  root=await fs.mkdtemp(path.join(os.tmpdir(),'quant-profile-pg-'));
  await db.transaction(()=>bindQuantStorage(db,root));
  budget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,
    tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const rawStore=new DatasetStore({root,storageBudget:budget});
  researchStore=new ResearchDatasetStore({root,storageBudget:budget,allowUnsupportedDirectorySyncForTests:true});
  store=new Store(db);pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  now=Math.floor(Date.now()/minute)*minute+4*minute;
  data=new QuantDataService({pineService:pine,datasetStore:rawStore,clock:()=>now,enabled:true});
  owner=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  foreign=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  const risk={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,
    equities:{'binance-global':1000},balances:{'binance-global':1000}};
  await store.setRisk(owner,risk);
  const input=fixture(),importId=randomUUID();deploymentId=randomUUID();
  // Declare all 58 settings, then inspect and review with the production parser.
  const source=['//@version=6','indicator("PF2 synthetic")','// E4 producer fixture: synthetic source, never source parity proof',
    ...input.analysis.inputs.map(item=>item.pine_variable+' = input.'+item.type+'('+JSON.stringify(item.effective_value)+', '+JSON.stringify(item.pine_variable)+')'),
    'buySignal = false','sellSignal = false','plot(close)'].join('\n');
  input.analysis=reviewedAnalysis(source);
  profile=new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,enabled:true,supportedSourceHash:hash(source)});
  await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,owner,owner,1,
    hash(source),'Profile fixture',source,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,
    hash(source),source,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,owner,owner,1);
  const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
  const capital=await store.paperAccounts(owner);
  const funding=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(owner)).cutoff;
  const snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),
    market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',deployment_id:deploymentId,pine_import_id:importId,source_version:1},policy:risk,
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
  const researchService={foundation:true,db,store,datasetStore:researchStore,executorMode:async()=>{}};
  const fetchHistory=(range,{onPage}={})=>{
    const first=range.start_time-range.warmup_bars*minute;
    onPage?.({start_time:first,end_time:range.end_time,count:(range.end_time-first)/minute,
      sha256:hash('profile-page'),retrieved_at:now,
      source:'https://api.binance.com/api/v3/klines',
      timestamp_semantics:'UTC open time; end exclusive'});
    return (async function*(){for(let time=first;time<range.end_time;time+=minute)
      yield {time,open:'100',high:'102',low:'99',close:'101',volume:'1'};})();
  };
  worker=new QuantResearchFoundationWorker({service:researchService,dataService:data,profileService:profile,
    health:async()=>({ok:true}),clock:()=>now,fetchHistory,stopUnit:async()=>true});

  const tx=fn=>db.transaction(fn,{isolation:'SERIALIZABLE'});
  const end=Math.floor(now/minute)*minute-2*minute;
  const raw=await tx(()=>data.enqueue(owner,{bot_id:owner,start_time:end-8400*minute,end_time:end,warmup_bars:1600,cutoff:Math.floor(now/minute)*minute},randomUUID()));
  assert.equal(await worker.tick(),true);
  const rawJob=(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[raw.job_id])).rows[0];
  assert.equal(rawJob.status,'SUCCEEDED');
  const policy=profileV2Fixture(10000).policy;
  policy.environment='staging';policy.max_raw_bars=10000;
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
  Object.assign(policy.scope,{source_hash:hash(source),settings_hash:input.analysis.effective_inputs_hash});
  const epoch={};
  const tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:ingestionEngineHash,releaseGuard:()=>epoch,isTransaction:()=>db.isTransaction});
  profile=new QuantProfileService({pineService:pine,dataService:data,researchStore,clock:()=>now,enabled:true,supportedSourceHash:hash(source),capacityPolicy:policy,profileV2Enabled:true,enrollmentEnabled:true,enrollmentTicketVerifier:tickets.assert});
  const body={bot_id:owner,raw_job_id:raw.job_id,deployment_id:deploymentId};
  const key=randomUUID(),queued=await tx(()=>profile.enqueueEnrollment(owner,body,key));
  const profileJob=(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  let builds=0,releases=0,stops=0,replayLaunches=0,replayActive=0,maxReplayActive=0,checkpoints=0;
  const python=path.resolve('quant_lab/.venv/Scripts/python.exe');
  // The existing shim substitutes source enrollment only; evaluator, Risk, Paper and IPC stay real.
  const local=createLocalPythonRunner({python,developmentOnly:true,shim:path.resolve('test/helpers/pf2_replay_shim.py')});
  const service=new QuantPreflightService({pineService:pine,dataService:data,stores:{raw:rawStore,research:researchStore},capacityPolicy:policy,clock:()=>now,enabled:true,supportedSourceHash:hash(source)});
  worker=new QuantResearchFoundationWorker({service:{...researchService,storageBudget:budget,executorMode:()=>data.ready()},dataService:data,profileService:profile,preflightService:service,profileV2Enabled:true,capacityPolicy:policy,health:async()=>({ok:true}),clock:()=>now,terminalLog:()=>{},python,allowUnsupportedPlatformForTests:true,stopUnit:async()=>true,
    supervisor:async options=>{
      assert.equal(options.module,'robot_quant.pf2_replay');replayLaunches++;maxReplayActive=Math.max(maxReplayActive,++replayActive);
      // The worker persists the unit before supervised execution. Job identity is asserted below via unit lookup.
      assert.equal((await db.query('SELECT count(*)::int count FROM quant_preflight_jobs WHERE unit_name=$1 AND unit_token IS NOT NULL',[options.unitName])).rows[0].count,1);
      try{const answer=await local(Buffer.from(canonical(options.payload)+'\n'),{signal:options.signal});
        if(answer.exitCode!==0)throw Object.assign(Error('RESEARCH_INTERRUPTED'),{code:'RESEARCH_INTERRUPTED',stopped:true});
        return JSON.parse(answer.stdout.toString('utf8'));}finally{replayActive--;}
    }});
  const scheduler=worker.scheduler,checkpoint=scheduler.checkpoint.bind(scheduler);
  scheduler.checkpoint=async(...args)=>{const answer=await checkpoint(...args);checkpoints++;return answer;};
  const ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],clock:()=>now,authorizeTerminal:async({job,action,input})=>{const own=worker.profileOperations.get(job.job_id);return {ok:db.isTransaction&&['settle','crash','acknowledgeCrashStop'].includes(action)&&own?.leaseToken===job.lease_token&&own?.operationId===input?.operation_id};}});
  // Explicit fake OS supervision/telemetry. Product pipeline runs only after runtime release.
  const launcher={terminalConfig:policy.terminal,async assertDrainHost(){/* Explicit synthetic host gate; no physical drain proof. */},spawnPrepared(){throw Error("prepare required");},async prepare({unitName,payload}){
    const envelope=JSON.parse(payload);assert.equal(envelope.contract.completion_mode,'pf2-enrollment-v1');
    const {jobId,operationId}=envelope;
    return {spawnPrepared(){
      const proof={unitName,group:'/user.slice/'+unitName,cgroupInode:23,invocationId:'1'.repeat(32)};
      let resolve,reject,stopProof;
      const sample=()=>({...proof,deviceId:'8:0',deviceInode:17,pid:4242,procStartTicks:'12345',readBytes:4096,writeBytes:4096});
      const stop=async()=>{if(!stopProof){stops++;stopProof={unitName,launcherClosed:true,startRegistered:true,pendingStartsExcluded:true,unitStopped:true};}return stopProof;};
      return {payloadHash:hash(payload),ready:Promise.resolve(proof),accepted:Promise.resolve({unitName,payloadHash:hash(payload)}),
        profileResult:new Promise((yes,no)=>{resolve=yes;reject=no;}),sample:async()=>sample(),stop,
        release(){releases++;builds++;buildProfileV2({contract:envelope.contract,policy,rawStore,researchStore,now:()=>now}).then(result=>resolve({jobId,operationId,payloadHash:hash(payload),resultHash:hash(canonical(result)),result}),reject);},
        async terminate({commit}){const frozen=sample(),evidence={freezer:'frozen',windowMs:2500,reads:[{readBytes:4096,writeBytes:4096},{readBytes:4096,writeBytes:4096}],fileDirty:0,fileWriteback:0,maxBioBytes:1310720,rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}};
          await commit(frozen,evidence);return {stopProof:await stop(),measured:true,frozenSample:frozen,readbackEvidence:evidence,postExit:'REMOVED'};}
      };
    },async abort(){}};
  }};
  const enrollment={enabled:true,tickets,assertSchemaLocked:await loadQuantProfileEnrollmentSchemaAssertion(),authorizeLocked:(who,value,context)=>profile.authorizeEnrollmentLocked(who,value,context)};
  const runtime=new QuantProfileRuntimeV2({db,ledger,scheduler,launcher,storageBudget:budget,clock:()=>now,health:async()=>({ok:true}),enrollment,
    authorizeRelease:(_identity,job)=>profile.authorize(job.owner_id,job.contract,'CHECKPOINT',{job_id:job.job_id,lease_token:job.lease_token})});
  worker.profileRuntimeV2=runtime;
  return {db,name,root,profile,service,policy,owner,deploymentId,profileJob,body,key,tx,now,stats:()=>({builds,releases,stops}),replayStats:()=>({replayLaunches,maxReplayActive,checkpoints}),worker,
    run:()=>worker.tick(),runPreflight:()=>worker.tick(),
    async dispose(){await worker.stop();await db.close();await admin.query('DROP DATABASE '+name);await fs.rm(root,{recursive:true,force:true});}};
  }catch(error){await db?.close();await admin.query('DROP DATABASE IF EXISTS '+name);if(root)await fs.rm(root,{recursive:true,force:true});throw error;}
}

import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantProfileRuntimeV2} from '../../src/postgres/quant-profile-runtime-v2.js';
import {createProfileEnrollmentTicketAuthority} from '../../src/postgres/quant-profile-enrollment-ticket.js';
import {loadQuantProfileEnrollmentSchemaAssertion} from '../../src/postgres/quant-profile-enrollment-migration.js';
import {ingestionEngineHash} from '../../src/postgres/quant-data.js';
import {buildProfileV2} from '../../src/quant-research/profile-pipeline-v2.js';
import {QuantPreflightService} from '../../src/postgres/quant-preflight.js';

import {createLocalPythonRunner} from '../../src/quant-research/preflight-replay.js';
