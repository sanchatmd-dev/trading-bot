import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantIoRuntime,canReleaseQuantIo,QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH} from '../../src/postgres/quant-io-runtime.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

const now=1800010000000,operationId='operation-00001';
let admin,db,second,name,ledger,scheduler,claimed,runtime,launcher,spawned;
const allowance={read_bytes:30,write_bytes:30};
const args=()=>({jobId:claimed.job_id,leaseToken:claimed.lease_token,operationId});
const fixtureLauncher=()=>({spawnPrepared({unitName}){
  spawned++;
  let released=false,stops=0;
  return {payloadHash:QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,ready:Promise.resolve({unitName}),
    release(){assert.equal(released,false);released=true;},
    async stop(){stops++;return {unitName,launcherClosed:true,startRegistered:true,
      pendingStartsExcluded:true,unitStopped:true,stops};}};
}});

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_io_runtime_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  second=new PostgresDatabase({connectionString:url.toString(),max:4});
  for(const file of ['quant-foundation-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
});
beforeEach(async()=>{
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  const {policy,contract}=profileV2Fixture(2000);
  scheduler=new QuantFoundationScheduler({db,capacityPolicy:policy,clock:()=>now,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true}),
    canRelease:row=>canReleaseQuantIo(db,row)});
  const queued=await scheduler.enqueue('owner-a',contract,randomUUID());
  claimed=await scheduler.claim('io-runtime-test');assert.equal(claimed.job_id,queued.job_id);
  ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],
    authorizeTerminal:async()=>({ok:true}),clock:()=>now});
  spawned=0;launcher=fixtureLauncher();runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
});
after(async()=>{
  await Promise.all([db?.close(),second?.close()]);
  if(admin){if(name)await admin.query('DROP DATABASE '+name);await admin.close();}
});

test('atomic reservation and intent, one start, held payload, then cancel charges unknown final',async()=>{
  const {state,unitName}=await runtime.reserve({...args(),expectedRevision:0,allowance});
  assert.equal(state.operations[0].cgroup_id,unitName);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'INTENT_RECORDED');
  await assert.rejects(runtime.reserve({...args(),expectedRevision:state.revision,allowance}),
    {code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.start(args());assert.equal(spawned,1);
  await assert.rejects(runtime.start(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.ready(args());
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await assert.rejects(scheduler.pause(claimed),{code:'FOUNDATION_IO_UNRESOLVED'});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
  assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
  assert.equal((await db.query('SELECT result FROM quant_foundation_jobs')).rows[0].result,null);
});

test('SQL guard blocks alternate scheduler release and lease replacement',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  const alternate=new QuantFoundationScheduler({db:second,capacityPolicy:profileV2Fixture(2000).policy,
    clock:()=>now,authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  await assert.rejects(alternate.pause(claimed),/Foundation I\/O launch unresolved/);
  await assert.rejects(db.query('UPDATE quant_foundation_jobs SET lease_token=$2 WHERE job_id=$1',
    [claimed.job_id,randomUUID()]),/Foundation I\/O launch unresolved/);
  await alternate.cancel('owner-a',claimed.job_id);
  await assert.rejects(alternate.acknowledgeStopped(claimed.job_id,claimed.lease_token),
    /Foundation I\/O launch unresolved/);
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
});

test('cancel before start claim proves no launch; STARTING without handle remains quarantined',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  const completed=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(completed.status,'CANCELLED');assert.equal(spawned,0);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  const {policy,contract}=profileV2Fixture(2000);
  const next=new QuantFoundationScheduler({db,capacityPolicy:policy,clock:()=>now,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  await next.enqueue('owner-a',contract,randomUUID());claimed=await next.claim('io-runtime-next');
  ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],
    authorizeTerminal:async()=>({ok:true}),clock:()=>now});
  runtime=new QuantIoRuntime({db,ledger,scheduler:next,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await db.query("UPDATE quant_io_launches SET state='STARTING' WHERE job_id=$1",[claimed.job_id]);
  const blocked=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(blocked.status,'STOPPING');assert.equal(blocked.proof,'UNCONFIRMED');
  await assert.rejects(next.acknowledgeStopped(claimed.job_id,claimed.lease_token),
    /Foundation I\/O launch unresolved/);
});

test('postspawn transaction rollback stops owned handle; STARTING intent can close only with that proof',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  let inject=true;
  const rollbackDb={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:callback=>db.transaction(async()=>{
      const value=await callback();
      if(inject&&spawned>0){inject=false;throw Error('postspawn transaction rolled back');}
      return value;
    })};
  const uncertainRuntime=new QuantIoRuntime({db:rollbackDb,ledger,scheduler,launcher,clock:()=>now});
  await assert.rejects(uncertainRuntime.start(args()),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.equal(spawned,1);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STARTING');
  const completed=await uncertainRuntime.cancel({ownerId:'owner-a',...args()});
  assert.equal(completed.status,'CANCELLED');
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
});
