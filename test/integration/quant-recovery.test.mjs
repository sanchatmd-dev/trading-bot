import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

test('cold restart drill preserves PostgreSQL checkpoint, fences old token and admits new lease',
 {skip:!process.env.TEST_DATABASE_URL},async()=>{
 const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 const name='quant_recovery_'+randomUUID().replaceAll('-','');
 let db;
 try{
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:5});
  await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'])
   await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  const owner='owner-'+randomUUID(),source=randomUUID(),deployment=randomUUID(),jobId=randomUUID(),token=randomUUID();
  const now=Date.now(),deadline=now+60000,first=1800000000000,digest='a'.repeat(64);
  const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',
   start_time:first,end_time:first+120000,warmup_bars:0,total_bars:2,cutoff:first+120000,source:'binance-spot-klines-v1'};
  const contract={version:'quant-foundation-v1',owner_id:owner,bot_id:owner,kind:'OPTIMIZE',
   dataset:{dataset_id:digest,sha256:digest,metadata},engine_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64),
   budget:{candidates:1,max_evaluations:1,chunk_bars:1,max_runtime_ms:900000,max_output_bytes:1024,max_state_bytes:1024}};
  const research={execution_backend:'quant-foundation-v1',marker:'immutable'};
  const checkpoint={next_bar:1,state:{cash:'1000'},dataset_id:digest,dataset_sha256:digest,
   engine_hash:contract.engine_hash,snapshot_hash:contract.snapshot_hash};
  checkpoint.sha256=hash(canonical(checkpoint));
  const unit=`robot-quant-${jobId}-${token}.service`,workerUnit='robot-quant-research-staging.service';
  await db.query('INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4)',[owner,owner+'@example.test','fixture',now]);
  await db.query('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[source,owner,digest,'fixture','fixture',JSON.stringify({}),now]);
  await db.query('INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,created_at) VALUES($1,$2,$2,$3,1,$4,$5,$6)',[deployment,owner,source,JSON.stringify({}),digest,now]);
  await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1)',[owner]);
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at,attempts,worker_id,lease_token,stop_reason,checkpoint,next_bar)
    VALUES($1,$2,$3,$4,$5,'STOPPING',$6,$7,1,'crashed-worker',$8,'LEASE_EXPIRED',$9,1)`,
   [jobId,owner,'fixture',JSON.stringify(contract),hash(canonical(contract)),now,deadline,token,JSON.stringify(checkpoint)]);
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,attempt,lease_token)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'RUNNING',$8,$8,$9,1,$10)`,
   [jobId,owner,deployment,'fixture',digest,hash(canonical(research)),JSON.stringify(research),now,deadline,token]);
  await db.query('INSERT INTO quant_research_foundation(run_id,job_id,contract_hash) VALUES($1,$2,$3)',[jobId,jobId,hash(canonical(research))]);
  const identity=hash(canonical({contract:research,parameters:{},kind:'CANDIDATE'}));
  const chunkCheckpoint={version:'research-chunk-v1',identity,integrity:'d'.repeat(64),next_bar:1,last_time:first,
   paper:{cash:'1000'}};
  await db.query('INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash,next_bar,checkpoint,checkpoint_hash,unit_name,unit_token) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9)',
   [jobId,'candidate:000','CANDIDATE',JSON.stringify({}),identity,JSON.stringify(chunkCheckpoint),hash(canonical(chunkCheckpoint)),unit,token]);
  const units=new Map([[workerUnit,{LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}],
   [unit,{LoadState:'loaded',ActiveState:'inactive',Job:'0',ControlGroup:''}]]);
  const manager={show:async name=>units.get(name),jobs:async()=>'',kill:async()=>{},stop:async()=>{},mask:async name=>{units.get(name).LoadState='masked';}};
  const result=await recoverQuantFoundation({db,policy:{workerUnit},manager,inventory:async()=>{},settleMs:0});
  assert.deepEqual(result.recovered,[{job_id:jobId,status:'PAUSED'}]);
  const paused=(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[jobId])).rows[0];
  assert.equal(paused.deadline_at,deadline);assert.deepEqual(paused.checkpoint,checkpoint);assert.equal(paused.next_bar,1);
  const stoppedChunk=(await db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1',[jobId])).rows[0];
  assert.equal(stoppedChunk.unit_name,null);assert.equal(stoppedChunk.unit_token,null);
  assert.deepEqual(stoppedChunk.checkpoint,chunkCheckpoint);assert.equal(stoppedChunk.next_bar,1);
  const scheduler=new QuantFoundationScheduler({db,authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  const resumed=await scheduler.claim('new-worker');
  assert.equal(resumed.job_id,jobId);assert.equal(resumed.attempts,2);assert.notEqual(resumed.lease_token,token);
  assert.deepEqual(resumed.checkpoint,checkpoint);assert.equal(resumed.deadline_at,deadline);
  await assert.rejects(scheduler.fenced({job_id:jobId,lease_token:token},'CHECKPOINT',async()=>{}),{code:'FOUNDATION_LEASE_LOST'});
  await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,run_started_at=NULL WHERE job_id=$1 AND lease_token=$2",[jobId,resumed.lease_token]);
  const second=await recoverQuantFoundation({db,policy:{workerUnit},manager,inventory:async()=>{},settleMs:0});
  assert.deepEqual(second.maskedUnits,[]);assert.equal(second.recovered[0].status,'PAUSED');
 }finally{
  await db?.close();
  await admin.query('DROP DATABASE IF EXISTS '+name);
  await admin.close();
 }
});
