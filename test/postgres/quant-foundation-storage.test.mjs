import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';

let admin,db,second,databaseName,root;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='foundation_storage_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString()});
  second=new PostgresDatabase({connectionString:url.toString()});
  await db.query(await readFile(new URL('../../src/postgres/quant-foundation-schema.sql',import.meta.url),'utf8'));
  root=await mkdtemp(path.join(os.tmpdir(),'quant-foundation-integration-'));
});
after(async()=>{
  await second?.close();await db?.close();
  if(databaseName)await admin.query('DROP DATABASE '+databaseName);
  await admin?.close();
  if(root)await rm(root,{recursive:true,force:true});
});

test('shared dataset plus fenced restart reproduces an uninterrupted synthetic fold',async()=>{
  const store=new DatasetStore({root}),count=24;
  const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:60000,end_time:(count+1)*60000,warmup_bars:4,total_bars:count,cutoff:(count+1)*60000,source:'binance-spot-klines-v1'};
  const bars=Array.from({length:count},(_,i)=>({time:(i+1)*60000,open:String(100+i),high:String(102+i),low:String(99+i),close:String(101+i),volume:'1'}));
  const reference=await store.publish(metadata,bars,{chunkBars:5});
  const contract={version:'quant-foundation-v1',owner_id:'integration-owner',bot_id:'integration-bot',kind:'BACKTEST',dataset:reference,engine_hash:'e'.repeat(64),snapshot_hash:'f'.repeat(64),budget:{candidates:1,max_evaluations:1,chunk_bars:4,max_runtime_ms:60000,max_output_bytes:4096,max_state_bytes:4096}};
  let now=metadata.cutoff;
  const authorize=async(owner,frozen,action)=>{
    if(owner!==contract.owner_id||frozen.bot_id!==contract.bot_id)return {ok:false};
    // Artifact resolution is trusted server work, never proof supplied by a browser.
    if(['ENQUEUE','CLAIM'].includes(action))await store.inspect(frozen.dataset);
    return {ok:true};
  };
  const scheduler=new QuantFoundationScheduler({db,authorize,health:async()=>({ok:true}),clock:()=>now,leaseMs:100});
  const queued=await scheduler.enqueue(contract.owner_id,contract,'integration-dataset-1');
  assert.equal(Object.hasOwn(queued.contract.dataset,'bars'),false);
  let job=await scheduler.claim('executor-1');
  const fold=(state,bar)=>({count:state.count+1,sum:state.sum+Number(bar.close),previous_close:bar.close});
  let state={count:0,sum:0,previous_close:null};
  for await(const bar of store.read(reference,{start:0,end:8}))state=fold(state,bar);
  await scheduler.checkpoint(job,{next_bar:8,state});
  // Fake executor is now stopped; expiry itself must not free the global slot.
  now+=101;
  const restarted=new QuantFoundationScheduler({db:second,authorize,health:async()=>({ok:true}),clock:()=>now,leaseMs:100});
  assert.equal(await restarted.claim('executor-2'),null);
  await assert.rejects(scheduler.checkpoint(job,{next_bar:12,state}),{code:'FOUNDATION_LEASE_LOST'});
  await restarted.acknowledgeStopped(job.job_id,job.lease_token);
  const resumed=await restarted.claim('executor-2');
  assert.notEqual(resumed.lease_token,job.lease_token);
  assert.equal(resumed.next_bar,8);
  assert.equal(resumed.checkpoint.dataset_sha256,reference.sha256);
  state=resumed.checkpoint.state;
  for await(const bar of store.read(reference,{start:resumed.next_bar,end:count}))state=fold(state,bar);
  await restarted.checkpoint(resumed,{next_bar:count,state});
  const completed=await restarted.finish(resumed,{fold:state});
  const expected=bars.reduce(fold,{count:0,sum:0,previous_close:null});
  assert.deepEqual(completed.result.fold,expected);
  assert.equal(completed.status,'SUCCEEDED');
  assert.equal((await db.query("SELECT count(*)::int n FROM quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')")).rows[0].n,0);
});
