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
const fixtureLauncher=(sampleOverride,readyOverride)=>({spawnPrepared({unitName}){
  spawned++;
  let released=false,stops=0;
  const group='/user.slice/'+unitName;
  const sample={unitName,group,cgroupInode:23,deviceId:'8:0',deviceInode:17,
    pid:4242,procStartTicks:'12345',invocationId:'1'.repeat(32),
    readBytes:3,writeBytes:4};
  return {payloadHash:QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,
    ready:Promise.resolve(readyOverride?readyOverride({unitName,group,cgroupInode:23,
      invocationId:'1'.repeat(32)}):{unitName,group,cgroupInode:23,invocationId:'1'.repeat(32)}),
    async sample(){return sampleOverride?sampleOverride(sample):sample;},
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

test('prepared diagnostic spawn occurs only after final live lease check',async()=>{
  const original=fixtureLauncher();
  let prepared=0,aborted=0;
  launcher={spawnPrepared:original.spawnPrepared,
    async prepare({unitName}){
      prepared++;
      return {spawnPrepared:()=>original.spawnPrepared({unitName}),async abort(){aborted++;}};
    }};
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());
  assert.equal(prepared,1);assert.equal(spawned,1);assert.equal(aborted,0);
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('lease lost during async preparation aborts reservation without spawning',async()=>{
  let aborted=0;
  launcher={spawnPrepared(){throw Error('unexpected spawn');},
    async prepare(){
      await scheduler.cancel('owner-a',claimed.job_id);
      return {spawnPrepared(){throw Error('unexpected spawn');},async abort(){aborted++;}};
    }};
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await assert.rejects(runtime.start(args()),{code:'QUANT_IO_LEASE_LOST'});
  assert.equal(spawned,0);assert.equal(aborted,1);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STARTING');
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

test('synthetic trusted sample binds birth counters from zero before release; bound cancel burns allowance',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.ready(args());
  const bound=await runtime.bind(args());
  const operation=bound.operations[0];
  assert.equal(operation.status,'ACTIVE');
  assert.deepEqual(operation.baseline,{devices:[{device_id:'8:0',device_inode:17,read_bytes:0,write_bytes:0}]});
  assert.deepEqual(operation.last,{devices:[{device_id:'8:0',device_inode:17,read_bytes:3,write_bytes:4}]});
  await runtime.release(args());
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'RELEASED');
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].cgroup_inode,23);
  assert.equal(stored.operations[0].status,'CRASHED');
});

test('missing kernel counter row denies bind and payload',async()=>{
  launcher=fixtureLauncher(()=>{throw Object.assign(Error('no io.stat row'),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});});
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'RESERVED');
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('wrong enrolled device denies trusted binding',async()=>{
  launcher=fixtureLauncher(sample=>({...sample,deviceId:'8:1'}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('changed cgroup inode denies trusted binding',async()=>{
  launcher=fixtureLauncher(sample=>({...sample,cgroupInode:24}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('bound overshoot persists STOP_REQUIRED before stop and charges observed bytes',async()=>{
  launcher=fixtureLauncher(sample=>({...sample,readBytes:31}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const pending=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(pending.operations[0].status,'STOP_REQUIRED');
  assert.equal(pending.operations[0].last.devices[0].read_bytes,31);
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.charged,
    {read_bytes:31,write_bytes:30});
});

test('cancel between sampled identity and bind commit leaves reservation, no payload',async()=>{
  launcher=fixtureLauncher(async sample=>{await scheduler.cancel('owner-a',claimed.job_id);return sample;});
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LEASE_LOST'});
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'RESERVED');
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
});

test('lost bind commit acknowledgement stops the owned handle and forbids release',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.ready(args());
  let inject=true;
  const committedDb={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:async callback=>{
      const value=await db.transaction(callback);
      if(inject){inject=false;throw Error('commit acknowledgement lost');}
      return value;
    }};
  runtime.db=committedDb;
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'ACTIVE');
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
});

test('last fresh overshoot is persisted before payload denial and final charge',async()=>{
  let samples=0;
  launcher=fixtureLauncher(sample=>({...sample,readBytes:++samples===3?40:3}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.bind(args());
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const pending=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(pending.operations[0].status,'STOP_REQUIRED');
  assert.equal(pending.operations[0].last.devices[0].read_bytes,40);
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.charged.read_bytes,40);
});

test('diagnostic enrollment denies a second operation for the same job',async()=>{
  const {state}=await runtime.reserve({...args(),expectedRevision:0,allowance});
  await assert.rejects(runtime.reserve({...args(),operationId:'operation-00002',
    expectedRevision:state.revision,allowance}),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM quant_io_launches')).rows[0].n,1);
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('nested owned quant unit path denies binding',async()=>{
  const ancestor='robot-quant-'+'f'.repeat(64)+'.service';
  const nested=unitName=>'/user.slice/'+ancestor+'/'+unitName;
  launcher=fixtureLauncher(sample=>({...sample,group:nested(sample.unitName)}),
    ready=>({...ready,group:nested(ready.unitName)}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
});
