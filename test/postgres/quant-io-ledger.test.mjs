import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

const now=1800010000000;
let admin,db,other,name,jobId,leaseToken,ledger,scheduler,claimed;
const enrolled=()=>({devices:[{device_id:'8:0',device_inode:17}],
  authorizeTerminal:async()=>({ok:true}),clock:()=>now});
const operation=(id='operation-00001')=>({operation_id:id,lease_token:leaseToken,
  domain_id:'domain-'+id,cgroup_id:'cgroup-'+id,allowance:{read_bytes:30,write_bytes:30}});
const reserve=(state,input=operation(),adapter=ledger)=>adapter.reserveBeforeLaunch({jobId,leaseToken,
  expectedRevision:state.revision,input});
const transition=(state,action,input,adapter=ledger)=>adapter.transition({jobId,leaseToken,
  expectedRevision:state.revision,action,input});

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_io_ledger_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  other=new PostgresDatabase({connectionString:url.toString(),max:4});
  await db.query(await fs.readFile(new URL('../../src/postgres/quant-foundation-schema.sql',import.meta.url),'utf8'));
  await db.query(await fs.readFile(new URL('../../src/postgres/quant-io-ledger-schema.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{
  await db.query('TRUNCATE quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  const {policy,contract}=profileV2Fixture(2000);
  scheduler=new QuantFoundationScheduler({db,capacityPolicy:policy,clock:()=>now,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  const queued=await scheduler.enqueue('owner-a',contract,randomUUID());
  claimed=await scheduler.claim('io-test-worker');
  assert.equal(claimed.job_id,queued.job_id);
  jobId=claimed.job_id;leaseToken=claimed.lease_token;
  ledger=new QuantIoLedger({db,policy,...enrolled()});
});
after(async()=>{
  await Promise.all([db?.close(),other?.close()]);
  if(admin){if(name)await admin.query('DROP DATABASE '+name);await admin.close();}
});

test('reservation commits before caller can launch; reopen retains exposure and duplicate is denied',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const reserved=await reserve(initial);
  assert.equal(reserved.operations[0].status,'RESERVED');
  const restarted=new QuantIoLedger({db:other,policy:profileV2Fixture(2000).policy,...enrolled()});
  const reopened=await restarted.open({jobId,leaseToken});
  assert.equal(reopened.revision,1);
  assert.deepEqual(reopened.operations[0].allowance,{read_bytes:30,write_bytes:30});
  await assert.rejects(reserve(reopened,operation(),restarted),{code:'INVALID_IO_BUDGET_LEDGER'});
  assert.equal((await db.query('SELECT count(*)::int n FROM quant_io_ledgers')).rows[0].n,1);
  await assert.rejects(db.query('DELETE FROM quant_io_ledgers WHERE job_id=$1',[jobId]),/cannot be deleted/);
});

test('two connections cannot spend same revision or reuse reservation',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const peer=new QuantIoLedger({db:other,policy:profileV2Fixture(2000).policy,...enrolled()});
  const outcomes=await Promise.allSettled([reserve(initial,operation('operation-00001')),
    reserve(initial,operation('operation-00002'),peer)]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(outcomes.find(result=>result.status==='rejected').reason.code,'QUANT_IO_LEDGER_REVISION_CONFLICT');
  assert.equal((await ledger.read({jobId,leaseToken})).operations.length,1);
});

test('unconfirmed crash survives restart, charges allowance and blocks new lease',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const reserved=await reserve(initial);
  const crashed=await transition(reserved,'crash',{operation_id:'operation-00001',lease_token:leaseToken,
    cgroup_id:'cgroup-operation-00001',cgroup_inode:null,crash_evidence_sha256:'f'.repeat(64)});
  assert.deepEqual(crashed.charged,{read_bytes:30,write_bytes:30});
  const newLease=randomUUID();
  await db.query('UPDATE quant_foundation_jobs SET lease_token=$2,lease_until=$3 WHERE job_id=$1',
    [jobId,newLease,now+30000]);
  const restarted=new QuantIoLedger({db:other,policy:profileV2Fixture(2000).policy,...enrolled()});
  await assert.rejects(restarted.open({jobId,leaseToken:newLease}),{code:'INVALID_IO_BUDGET_LEDGER'});
  assert.equal((await db.query('SELECT revision FROM quant_io_ledgers WHERE job_id=$1',[jobId])).rows[0].revision,2);
});

test('scheduler token and expiry fence even current ledger revision',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  await db.query('UPDATE quant_foundation_jobs SET lease_until=$2 WHERE job_id=$1',[jobId,now]);
  await assert.rejects(reserve(initial),{code:'QUANT_IO_LEASE_LOST'});
  await db.query('UPDATE quant_foundation_jobs SET lease_until=$2 WHERE job_id=$1',[jobId,now+30000]);
  await db.query('UPDATE quant_foundation_jobs SET lease_token=$2 WHERE job_id=$1',[jobId,randomUUID()]);
  await assert.rejects(reserve(initial),{code:'QUANT_IO_LEASE_LOST'});
  assert.equal((await ledger.read({jobId,leaseToken}).catch(error=>error)).code,'QUANT_IO_LEASE_LOST');
});

test('outer transaction and database loss fail before reservation',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  await assert.rejects(db.transaction(()=>reserve(initial)),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  const broken=new QuantIoLedger({db:{isTransaction:false,transaction:async fn=>fn(),
    query:async()=>{throw Error('database unavailable');}},policy:profileV2Fixture(2000).policy,...enrolled()});
  await assert.rejects(reserve(initial,operation(),broken),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.equal((await ledger.read({jobId,leaseToken})).revision,0);
});

test('trusted policy mismatch denies initialization',async()=>{
  const alternate=profileV2Fixture(2000).policy;
  alternate.io.read_bytes+=1;
  const wrong=new QuantIoLedger({db,policy:alternate,...enrolled()});
  await assert.rejects(wrong.open({jobId,leaseToken}),{code:'INVALID_CAPACITY_CONTRACT'});
});

test('STOPPING forbids new compute but trusted crash accounting retains allowance',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const reserved=await reserve(initial);
  await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',lease_until=NULL WHERE job_id=$1",[jobId]);
  await assert.rejects(reserve(reserved,operation('operation-00002')),{code:'QUANT_IO_LEASE_LOST'});
  const denied=new QuantIoLedger({db,policy:profileV2Fixture(2000).policy,
    ...enrolled(),authorizeTerminal:async()=>({ok:false})});
  const crash={operation_id:'operation-00001',lease_token:leaseToken,
    cgroup_id:'cgroup-operation-00001',cgroup_inode:null,crash_evidence_sha256:'f'.repeat(64)};
  await assert.rejects(transition(reserved,'crash',crash,denied),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  const charged=await transition(reserved,'crash',crash);
  assert.equal(charged.operations[0].status,'CRASHED_UNCONFIRMED');
  assert.deepEqual(charged.charged,{read_bytes:30,write_bytes:30});
});

test('lost commit acknowledgement leaves reservation durable and retry cannot issue it again',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const lostAckDb={get isTransaction(){return db.isTransaction;},query:(...args)=>db.query(...args),
    transaction:async callback=>{await db.transaction(callback);throw Error('commit acknowledgement lost');}};
  const uncertain=new QuantIoLedger({db:lostAckDb,policy:profileV2Fixture(2000).policy,...enrolled()});
  await assert.rejects(reserve(initial,operation(),uncertain),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  const persisted=await ledger.read({jobId,leaseToken});
  assert.equal(persisted.revision,1);
  assert.equal(persisted.operations[0].status,'RESERVED');
  await assert.rejects(reserve(persisted),{code:'INVALID_IO_BUDGET_LEDGER'});
});

test('revoked policy does not block trusted STOPPING terminal accounting',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const reserved=await reserve(initial);
  await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',lease_until=NULL WHERE job_id=$1",[jobId]);
  const terminal=new QuantIoLedger({db:other,clock:()=>now,
    authorizeTerminal:async({job,action,input})=>({ok:job.job_id===jobId&&
      job.lease_token===leaseToken&&action==='crash'&&input.operation_id==='operation-00001'})});
  const charged=await transition(reserved,'crash',{operation_id:'operation-00001',lease_token:leaseToken,
    cgroup_id:'cgroup-operation-00001',cgroup_inode:null,crash_evidence_sha256:'f'.repeat(64)},terminal);
  assert.deepEqual(charged.charged,{read_bytes:30,write_bytes:30});
  assert.equal((await terminal.read({jobId,leaseToken})).revision,charged.revision);
  await assert.rejects(terminal.open({jobId,leaseToken}),{code:'QUANT_IO_LEASE_LOST'});
});

test('persisted bind, observe and settle carry exact charge into next scheduler lease',async()=>{
  const initial=await ledger.open({jobId,leaseToken});
  const reserved=await reserve(initial);
  const identity={operation_id:'operation-00001',lease_token:leaseToken,
    cgroup_id:'cgroup-operation-00001',cgroup_inode:23};
  const sample=(read,write)=>({devices:[{device_id:'8:0',device_inode:17,
    read_bytes:read,write_bytes:write}]});
  const bound=await transition(reserved,'bind',{...identity,domain_id:'domain-operation-00001',
    domain_relation:'DISJOINT',domain_proof_sha256:'f'.repeat(64),
    identity_proof_sha256:'e'.repeat(64),counter_origin:'CGROUP_BIRTH',sample:sample(0,0)});
  const observed=await transition(bound,'observe',{...identity,sample:sample(3,4)});
  const proof={...identity,stopped:true,
    stop_proof_sha256:'a'.repeat(64),final_readback:true,
    readback_proof_sha256:'b'.repeat(64),sample:sample(5,6)};
  const settled=await transition(observed,'settle',proof);
  assert.deepEqual(settled.charged,{read_bytes:5,write_bytes:6});
  assert.equal((await transition(settled,'settle',proof)).revision,settled.revision);
  await scheduler.pause(claimed);
  const resumed=await scheduler.claim('io-test-worker-next');
  assert.equal(resumed.job_id,jobId);
  assert.notEqual(resumed.lease_token,leaseToken);
  const newLedger=new QuantIoLedger({db:other,policy:profileV2Fixture(2000).policy,...enrolled()});
  const reopened=await newLedger.open({jobId,leaseToken:resumed.lease_token});
  assert.equal(reopened.revision,settled.revision+1);
  assert.deepEqual(reopened.charged,{read_bytes:5,write_bytes:6});
  await assert.rejects(ledger.read({jobId,leaseToken}),{code:'QUANT_IO_LEASE_LOST'});
  const next=await newLedger.reserveBeforeLaunch({jobId,leaseToken:resumed.lease_token,
    expectedRevision:reopened.revision,input:{operation_id:'operation-00002',lease_token:resumed.lease_token,
      domain_id:'domain-operation-00002',cgroup_id:'cgroup-operation-00002',
      allowance:{read_bytes:30,write_bytes:30}}});
  assert.deepEqual(next.charged,{read_bytes:5,write_bytes:6});
  assert.equal(next.operations.length,2);
});
