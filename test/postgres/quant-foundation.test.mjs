import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';

let admin,db,second,databaseName,scheduler,other,now,health,denied,supervisor,deniedOwner;
const digest='a'.repeat(64);
function request(owner='owner-a',changes={}) {
  const start=1800000000000,total=100;
  return {version:'quant-foundation-v1',owner_id:owner,bot_id:'fixture-bot',kind:'BACKTEST',
    dataset:{dataset_id:digest,sha256:digest,metadata:{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
      symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:start+total*60000,warmup_bars:10,total_bars:total,
      cutoff:start+total*60000,source:'binance-spot-klines-v1'}},engine_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64),
    budget:{candidates:1,max_evaluations:1,chunk_bars:100,max_runtime_ms:900000,max_output_bytes:1024,max_state_bytes:1024},...changes};
}
const authorize=async(owner,contract,action)=>({ok:owner===contract.owner_id && !denied && owner!==deniedOwner &&
  (action!=='ACKNOWLEDGE_STOPPED' || supervisor)});
const make=database=>new QuantFoundationScheduler({db:database,authorize,health:async()=>{
  if (health instanceof Error) throw health;
  return health;
},clock:()=>now,leaseMs:100});
const enqueue=(owner='owner-a',key=randomUUID(),changes={})=>{
  now+=1;
  return scheduler.enqueue(owner,request(owner,changes),key);
};
const get=async id=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='quant_foundation_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  second=new PostgresDatabase({connectionString:url.toString(),max:4});
  const schema=await fs.readFile(new URL('../../src/postgres/quant-foundation-schema.sql',import.meta.url),'utf8');
  await assert.rejects(db.transaction(async()=>{await db.query(schema);throw Error('rollback');}));
  assert.equal((await db.query("SELECT to_regclass('quant_foundation_jobs') present")).rows[0].present,null);
  await db.query(schema);
  assert.equal((await db.query("SELECT to_regclass('quant_jobs') present")).rows[0].present,null);
});
beforeEach(async()=>{
  await db.query('TRUNCATE quant_foundation_jobs,quant_foundation_owners');
  await db.query('UPDATE quant_foundation_scheduler SET service_counter=0');
  now=1800010000000;health={ok:true};denied=false;deniedOwner=null;supervisor=true;
  scheduler=make(db);other=make(second);
});
after(async()=>{
  await Promise.all([db?.close(),second?.close()]);
  if (admin) {if (databaseName) await admin.query('DROP DATABASE '+databaseName);await admin.close();}
});

test('immutable idempotent contracts, owner checks and queue bounds',async()=>{
  const key=randomUUID(),one=await enqueue('owner-a',key),two=await enqueue('owner-a',key);
  assert.equal(one.job_id,two.job_id);assert.ok(Object.isFrozen(one.contract.budget));
  await assert.rejects(enqueue('owner-a',key,{snapshot_hash:'d'.repeat(64)}),{code:'FOUNDATION_IDEMPOTENCY_CONFLICT'});
  await assert.rejects(scheduler.enqueue('stranger',request(),randomUUID()),{code:'FOUNDATION_FORBIDDEN'});
  await assert.rejects(scheduler.cancel('stranger',one.job_id),{code:'FOUNDATION_NOT_FOUND'});
  await assert.rejects(db.query("UPDATE quant_foundation_jobs SET contract='{}' WHERE job_id=$1",[one.job_id]),/immutable/);
  for (let i=0;i<19;i++) await enqueue();
  await assert.rejects(enqueue(),{code:'FOUNDATION_QUEUE_FULL'});
  assert.equal((await enqueue('owner-a',key)).job_id,one.job_id);
});

test('two connections claim one global slot; persistent fairness rotates owners across restart',async()=>{
  const a=await enqueue(),a2=await enqueue(),b=await enqueue('owner-b');
  const claims=await Promise.all([scheduler.claim('worker-a'),other.claim('worker-b')]);
  assert.equal(claims.filter(Boolean).length,1);
  const first=claims.find(Boolean);assert.equal(first.owner_id,'owner-a');
  await scheduler.finish(first,{done:true});
  scheduler=make(db);
  const secondJob=await scheduler.claim('worker-c');assert.equal(secondJob.job_id,b.job_id);
  await scheduler.finish(secondJob,{done:true});
  assert.equal((await other.claim('worker-d')).job_id,[a.job_id,a2.job_id].find(id=>id!==first.job_id));
});

test('expired executor stays quarantined until trusted physical stop; old tokens cannot publish',async()=>{
  const queued=await enqueue();await enqueue('owner-b');
  const old=await scheduler.claim('old-worker');now+=101;
  assert.equal(await other.claim('new-worker'),null);
  assert.equal((await get(queued.job_id)).status,'STOPPING');
  await assert.rejects(scheduler.heartbeat(old),{code:'FOUNDATION_LEASE_LOST'});
  await assert.rejects(scheduler.checkpoint(old,{next_bar:1,state:{}}),{code:'FOUNDATION_LEASE_LOST'});
  await assert.rejects(scheduler.finish(old,{late:true}),{code:'FOUNDATION_LEASE_LOST'});
  supervisor=false;
  await assert.rejects(scheduler.acknowledgeStopped(old.job_id,old.lease_token),{code:'FOUNDATION_FORBIDDEN'});
  assert.equal(await other.claim('new-worker'),null);
  supervisor=true;await scheduler.acknowledgeStopped(old.job_id,old.lease_token);
  const next=await other.claim('new-worker');assert.equal(next.owner_id,'owner-b');
  await assert.rejects(scheduler.acknowledgeStopped(old.job_id,old.lease_token),{code:'FOUNDATION_LEASE_LOST'});
});

test('running cancellation keeps slot and fences late results until supervisor acknowledgement',async()=>{
  const queued=await enqueue();await enqueue('owner-b');
  const old=await scheduler.claim('worker');
  assert.equal((await scheduler.cancel('owner-a',queued.job_id)).status,'STOPPING');
  assert.equal(await other.claim('next'),null);
  await assert.rejects(scheduler.finish(old,{late:true}),{code:'FOUNDATION_LEASE_LOST'});
  assert.equal((await get(old.job_id)).result,null);
  await scheduler.acknowledgeStopped(old.job_id,old.lease_token);
  assert.equal((await get(old.job_id)).status,'CANCELLED');assert.ok(await other.claim('next'));
});

test('bounded monotonic checkpoint resumes with identity, hashes and new token',async()=>{
  await enqueue();const old=await scheduler.claim('worker');
  const saved=await scheduler.checkpoint(old,{next_bar:10,state:{cash:'100',position:null}});
  assert.equal(saved.checkpoint.dataset_id,digest);assert.equal(saved.checkpoint.engine_hash,old.contract.engine_hash);
  assert.match(saved.checkpoint.sha256,/^[0-9a-f]{64}$/);
  await assert.rejects(scheduler.checkpoint(old,{next_bar:9,state:{}}),{code:'FOUNDATION_INVALID_CHECKPOINT'});
  await assert.rejects(scheduler.checkpoint(old,{next_bar:101,state:{}}),{code:'FOUNDATION_INVALID_CHECKPOINT'});
  await assert.rejects(scheduler.checkpoint(old,{next_bar:11,state:'x'.repeat(1025)}),{code:'FOUNDATION_STATE_TOO_LARGE'});
  await scheduler.pause(old);
  const resumed=await other.claim('resumed');assert.equal(resumed.next_bar,10);
  assert.deepEqual(resumed.checkpoint,saved.checkpoint);assert.notEqual(resumed.lease_token,old.lease_token);
  await assert.rejects(scheduler.finish(old,{}),{code:'FOUNDATION_LEASE_LOST'});
  await assert.rejects(other.finish(resumed,'x'.repeat(1025)),{code:'FOUNDATION_OUTPUT_TOO_LARGE'});
  denied=true;await assert.rejects(other.checkpoint(resumed,{next_bar:20,state:{}}),{code:'FOUNDATION_FORBIDDEN'});
  denied=false;assert.equal((await other.finish(resumed,{done:true})).status,'SUCCEEDED');
});

test('unknown, unhealthy or throwing health blocks execution and quarantines heartbeat',async()=>{
  await enqueue();
  for (const value of [undefined,{ok:false},{ok:'true'},new Error('unknown')]) {
    health=value;assert.equal(await scheduler.claim('worker'),null);
  }
  health={ok:true};const old=await scheduler.claim('worker');health=undefined;
  await assert.rejects(scheduler.heartbeat(old),{code:'FOUNDATION_LEASE_LOST'});
  assert.equal((await get(old.job_id)).status,'STOPPING');assert.equal(await other.claim('next'),null);
  await scheduler.acknowledgeStopped(old.job_id,old.lease_token);
  assert.equal(await other.claim('next'),null);
  health={ok:true};assert.ok(await other.claim('next'));
});

test('expired writes commit quarantine, attempts bounded, enqueue deadline never resets',async()=>{
  const queued=await enqueue();const deadline=queued.deadline_at;
  for (let i=0;i<3;i++) {
    const job=await scheduler.claim('worker');assert.equal(job.attempts,i+1);assert.equal(job.deadline_at,deadline);
    now+=101;await assert.rejects(scheduler.checkpoint(job,{next_bar:1,state:{}}),{code:'FOUNDATION_LEASE_LOST'});
    assert.equal((await get(job.job_id)).status,'STOPPING');
    await scheduler.acknowledgeStopped(job.job_id,job.lease_token);
  }
  assert.equal((await get(queued.job_id)).status,'CANCELLED');assert.equal(await scheduler.claim('worker'),null);
  const expired=await enqueue();now=expired.deadline_at;
  assert.equal(await scheduler.claim('worker'),null);assert.equal((await get(expired.job_id)).status,'CANCELLED');
});

test('revoked queued owner cannot block others; revoked running owner cannot block quarantine',async()=>{
  const blocked=await enqueue();await enqueue('owner-b');deniedOwner='owner-a';
  const job=await scheduler.claim('worker');assert.equal(job.owner_id,'owner-b');
  assert.equal((await get(blocked.job_id)).diagnostic,'AUTHORIZATION_REVOKED');
  deniedOwner='owner-b';now+=101;
  assert.equal(await other.claim('new-worker'),null);assert.equal((await get(job.job_id)).status,'STOPPING');
});

test('non-JSON state/results rejected rather than silently normalized',async()=>{
  await enqueue();const job=await scheduler.claim('worker');
  for (const state of [{number:NaN},{number:Infinity},{missing:undefined},[undefined],new Date(),{fn:()=>1}]) {
    await assert.rejects(scheduler.checkpoint(job,{next_bar:1,state}),{code:'FOUNDATION_STATE_TOO_LARGE'});
    await assert.rejects(scheduler.finish(job,state),{code:'FOUNDATION_OUTPUT_TOO_LARGE'});
  }
  assert.equal((await get(job.job_id)).next_bar,0);
});

test('corrupt checkpoint rejected before resume without blocking other owners',async()=>{
  await enqueue();const job=await scheduler.claim('worker');
  await scheduler.checkpoint(job,{next_bar:1,state:{cash:'100'}});await scheduler.pause(job);
  await db.query(`UPDATE quant_foundation_jobs SET checkpoint=jsonb_set(checkpoint,'{state,cash}','"999"') WHERE job_id=$1`,[job.job_id]);
  await enqueue('owner-b');const next=await scheduler.claim('new-worker');assert.equal(next.owner_id,'owner-b');
  await scheduler.finish(next,{});assert.equal(await scheduler.claim('worker'),null);
  assert.equal((await get(job.job_id)).diagnostic,'INTEGRITY_FAILED');
});

test('slow trusted callbacks cannot start after deadline or renew an expired lease',async()=>{
  const queued=await enqueue();
  const delayed=new QuantFoundationScheduler({db,authorize:async(...args)=>{
    const result=await authorize(...args);if (args[2]==='CLAIM') now=queued.deadline_at;return result;
  },health:async()=>({ok:true}),clock:()=>now,leaseMs:100});
  assert.equal(await delayed.claim('worker'),null);assert.equal((await get(queued.job_id)).diagnostic,'DEADLINE_EXCEEDED');
  await enqueue();const job=await scheduler.claim('worker');
  const slowHeartbeat=new QuantFoundationScheduler({db,authorize,health:async()=>{now=job.lease_until;return {ok:true};},clock:()=>now,leaseMs:100});
  await assert.rejects(slowHeartbeat.heartbeat(job),{code:'FOUNDATION_LEASE_LOST'});
  assert.equal((await get(job.job_id)).status,'STOPPING');
});

test('external transactions rejected so caller rollback cannot undo STOPPING',async()=>{
  await enqueue();const job=await scheduler.claim('worker');now+=101;
  await assert.rejects(db.transaction(()=>scheduler.heartbeat(job)),{code:'FOUNDATION_EXTERNAL_TRANSACTION_FORBIDDEN'});
  await assert.rejects(scheduler.heartbeat(job),{code:'FOUNDATION_LEASE_LOST'});
  assert.equal((await get(job.job_id)).status,'STOPPING');
});

test('authorization infrastructure failure preserves queued job for retry',async()=>{
  const queued=await enqueue();
  const unavailable=new QuantFoundationScheduler({db,authorize:async()=>{throw Error('authorization unavailable');},
    health:async()=>({ok:true}),clock:()=>now,leaseMs:100});
  await assert.rejects(unavailable.claim('worker'),/authorization unavailable/);
  assert.equal((await get(queued.job_id)).status,'QUEUED');
  assert.equal((await scheduler.claim('worker')).job_id,queued.job_id);
});
