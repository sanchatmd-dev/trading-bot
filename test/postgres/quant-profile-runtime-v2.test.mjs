import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {canReleaseQuantIo,quantIoUnitName} from '../../src/postgres/quant-io-runtime.js';
import {QuantProfileRuntimeV2} from '../../src/postgres/quant-profile-runtime-v2.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {buildProfileV2} from '../../src/quant-research/profile-pipeline-v2.js';
import {capacityPolicyHash} from '../../src/quant-research/capacity-contract.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

const now=1800010000000,operationId='operation-00001';
let admin,db,name,root,store,budget,policy,contract,result,scheduler,ledger,claimed;
let revoked,malformed,overshootAfterRelease,revokeAfterRelease,growthDuringAuthorization,
  grown,launches,stops,adapter,terminal,events;
const args=()=>({jobId:claimed.job_id,leaseToken:claimed.lease_token,operationId,
  ownerId:claimed.owner_id,expectedRevision:0});

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_profile_runtime_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  for(const file of ['quant-foundation-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-runtime-pg-'));
  budget=new StorageBudget({root,diskQuotaBytes:32*1024*1024,tempQuotaBytes:16*1024*1024,freeFloorBytes:0});
  store=new ResearchDatasetStore({root,storageBudget:budget,allowUnsupportedDirectorySyncForTests:true});
  ({policy,contract}=profileV2Fixture(600));
  policy.environment='staging';contract.capacity.environment='staging';
  contract.capacity.policy_hash=capacityPolicyHash(policy);
  async function* rows(){for(let i=0;i<600;i++)yield {time:contract.dataset.metadata.start_time+i*60000,
    open:'100',high:'102',low:'99',close:'101',volume:'2'};}
  contract.dataset=await store.raw.publish(contract.dataset.metadata,rows(),{chunkBars:1000});
  result=await buildProfileV2({contract,policy,rawStore:store.raw,researchStore:store,
    now:contract.dataset.metadata.cutoff});
});
after(async()=>{
  await db?.close();if(admin){if(name)await admin.query('DROP DATABASE '+name);await admin.close();}
  if(root)await fs.rm(root,{recursive:true,force:true});
});
beforeEach(async()=>{
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  revoked=false;malformed=false;overshootAfterRelease=false;revokeAfterRelease=false;
  growthDuringAuthorization=false;grown=false;
  launches=0;stops=0;terminal=null;events=[];
  scheduler=new QuantFoundationScheduler({db,capacityPolicy:policy,clock:()=>now,leaseMs:30000,
    authorize:async(_owner,_contract,action)=>({ok:action==='CANCEL'||action==='ACKNOWLEDGE_STOPPED'||!revoked}),
    health:async()=>({ok:true}),canRelease:row=>canReleaseQuantIo(db,row)});
  const queued=await scheduler.enqueue('owner-a',contract,randomUUID());
  claimed=await scheduler.claim('profile-runtime-test');assert.equal(claimed.job_id,queued.job_id);
  ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],
    authorizeTerminal:async()=>({ok:true}),clock:()=>now});
  const launcher={spawnPrepared(){throw Error('prepare required');},
    async prepare({unitName,payload}){
      assert.equal(unitName,quantIoUnitName(claimed.job_id,operationId));
      const envelope=JSON.parse(payload);
      assert.equal(envelope.contract.dataset.sha256,contract.dataset.sha256);
      return {spawnPrepared(){
        launches++;
        const group='/user.slice/'+unitName,invocationId='1'.repeat(32);
        let released=false,stopResult=null;
        const proof={unitName,group,cgroupInode:23,invocationId};
        const handle={payloadHash:hash(payload),ready:Promise.resolve(proof),
          accepted:Promise.resolve({unitName,payloadHash:hash(payload)}),
          profileResult:new Promise(resolve=>{launcher.resolveResult=resolve;}),
          async sample(){return {...proof,deviceId:'8:0',deviceInode:17,pid:4242,
            procStartTicks:'12345',readBytes:released&&overshootAfterRelease||grown?100000000:4096,
            writeBytes:4096};},
          release(){assert.equal(released,false);released=true;
            if(revokeAfterRelease)revoked=true;
            const value=malformed?{jobId:'wrong',result}: {jobId:claimed.job_id,operationId,
              payloadHash:hash(payload),resultHash:hash(canonical(result)),result};
            launcher.resolveResult(value);},
          async stop(){
            if(!stopResult){stops++;events.push('stop');stopResult={unitName,launcherClosed:true,
              startRegistered:true,pendingStartsExcluded:true,unitStopped:true};}
            return stopResult;
          }};
        // FTR-1: scripted frozen terminal. Absent unless a test sets `terminal`.
        if(terminal){
          const script=terminal;let promise=null;
          handle.terminate=request=>{
            events.push('terminate');
            promise??=(async()=>{
              const frozen={...proof,deviceId:'8:0',deviceInode:17,pid:4242,procStartTicks:'12345',
                readBytes:script.read??8192,writeBytes:script.write??12288};
              const evidence={freezer:'frozen',windowMs:2500,reads:[{readBytes:frozen.readBytes,
                writeBytes:frozen.writeBytes},{readBytes:frozen.readBytes,writeBytes:frozen.writeBytes}],
                fileDirty:0,fileWriteback:0,maxBioBytes:1310720,
                rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}};
              let committed=false;
              try{await request.commit(frozen,evidence);committed=true;}catch{}
              const stopProof=await handle.stop();
              return Object.freeze({stopProof,measured:script.measured??committed,
                postExit:script.postExit??'REMOVED',frozenSample:frozen,readbackEvidence:evidence});
            })();
            return promise;
          };
        }
        return handle;
      },async abort(){}};
    }};
  adapter=new QuantProfileRuntimeV2({db,ledger,scheduler,launcher,storageBudget:budget,clock:()=>now,
    authorizeRelease:async (binding,job)=>{
      if(growthDuringAuthorization)grown=true;
      return {ok:db.isTransaction&&!revoked&&
      binding.jobId===claimed.job_id&&binding.ownerId==='owner-a'&&
      binding.contractHash===hash(canonical(job.contract))&&
      binding.policyHash===contract.capacity.policy_hash&&
      binding.sourceHash===contract.profile.source_hash&&
      binding.deploymentId===contract.profile.deployment_id};},
    health:async()=>({ok:true})});
});

test('actual V2 result stays provisional; trusted stop charges allowance and SQL result stays null',async()=>{
  const outcome=await adapter.run(args());
  assert.equal(outcome.status,'CANCELLED');assert.equal(outcome.provisional.resultHash,hash(canonical(result)));
  assert.equal(outcome.provisional.evaluator_admission,false);
  assert.equal(launches,1);assert.equal(stops,1);
  const job=(await db.query('SELECT status,result FROM quant_foundation_jobs WHERE job_id=$1',[claimed.job_id])).rows[0];
  assert.equal(job.status,'CANCELLED');assert.equal(job.result,null);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'CRASHED');
});

test('revocation after ACTIVE denies payload release and preserves conservative stop',async()=>{
  const request=args();
  await adapter.io.reserve(request);await adapter.io.start(request);
  await adapter.io.ready(request);await adapter.io.bind(request);
  revoked=true;
  await assert.rejects(adapter.io.release(request));
  const stopped=await adapter.io.cancel(request);
  assert.equal(stopped.status,'CANCELLED');assert.equal(stops>=1,true);
  assert.equal((await db.query('SELECT result FROM quant_foundation_jobs')).rows[0].result,null);
});

test('malformed child frame never becomes a foundation result',async()=>{
  malformed=true;
  await assert.rejects(adapter.run(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal((await db.query('SELECT status,result FROM quant_foundation_jobs')).rows[0].status,'CANCELLED');
  assert.equal((await db.query('SELECT result FROM quant_foundation_jobs')).rows[0].result,null);
});

test('wrong owner cannot create intent or child',async()=>{
  await assert.rejects(adapter.run({...args(),ownerId:'wrong-owner'}),
    {code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal(launches,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM quant_io_launches')).rows[0].n,0);
});

test('one-shot launch rejects duplicate start before payload release',async()=>{
  const request=args();
  await adapter.io.reserve(request);await adapter.io.start(request);
  await assert.rejects(adapter.io.start(request),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal(launches,1);
  await adapter.io.cancel(request);
});

test('observed overshoot persists before child stop and conservative charge',async()=>{
  overshootAfterRelease=true;
  await assert.rejects(adapter.run(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const operation=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0];
  assert.equal(operation.last.devices[0].read_bytes,100000000);
  assert.equal(operation.status,'CRASHED');
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'CANCELLED');
});

test('growth during locked authorization persists before payload denial',async()=>{
  const request=args();
  await adapter.io.reserve(request);await adapter.io.start(request);
  await adapter.io.ready(request);await adapter.io.bind(request);
  growthDuringAuthorization=true;
  await assert.rejects(adapter.io.release(request),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const operation=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0];
  assert.equal(operation.last.devices[0].read_bytes,100000000);
  assert.equal(operation.status,'STOP_REQUIRED');
  await adapter.io.cancel(request);
});

test('revocation after release stops child before accepting provisional result',async()=>{
  revokeAfterRelease=true;
  await assert.rejects(adapter.run(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal(stops>=1,true);
  assert.equal((await db.query('SELECT status,result FROM quant_foundation_jobs')).rows[0].status,'CANCELLED');
  assert.equal((await db.query('SELECT result FROM quant_foundation_jobs')).rows[0].result,null);
});

// ---- FTR-1: measured terminal. `terminal` scripts handle.terminate(); default runs keep the fallback ----

test('measured frozen terminal settles exact deltas; result stays provisional and SQL result null',async()=>{
  terminal={};
  const outcome=await adapter.run(args());
  assert.equal(outcome.status,'CANCELLED');assert.equal(outcome.proof,'MEASURED_FINAL_SETTLED');
  assert.equal(outcome.provisional.evaluator_admission,false);
  assert.equal(outcome.provisional.resultHash,hash(canonical(result)));
  assert.equal(launches,1);assert.equal(stops,1);
  assert.deepEqual(events,['terminate','stop']);// no raw stop before the terminal
  const job=(await db.query('SELECT status,result,checkpoint FROM quant_foundation_jobs WHERE job_id=$1',[claimed.job_id])).rows[0];
  assert.equal(job.status,'CANCELLED');assert.equal(job.result,null);assert.equal(job.checkpoint,null);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state,operation=stored.operations[0];
  assert.equal(operation.status,'SETTLED');
  assert.deepEqual(operation.charge,{read_bytes:8192,write_bytes:12288});
  assert.deepEqual(stored.charged,{read_bytes:8192,write_bytes:12288});
  assert.equal(stored.operations.some(item=>item.status==='CRASHED'||item.stop_reason==='UNKNOWN_FINAL_ACCOUNTING'),false);
});

test('terminal not measured keeps unknown-final charge and provisional result',async()=>{
  terminal={measured:false};
  const outcome=await adapter.run(args());
  assert.equal(outcome.proof,'UNKNOWN_FINAL_CHARGED');assert.equal(outcome.provisional.evaluator_admission,false);
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.deepEqual(stored.charged,{read_bytes:97000000,write_bytes:97000000});
  assert.equal((await db.query('SELECT status,result FROM quant_foundation_jobs')).rows[0].result,null);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
});

test('measured overshoot observed by the poll loop is settled exactly, never admitted as a result',async()=>{
  overshootAfterRelease=true;terminal={read:100000500,write:5000};
  await assert.rejects(adapter.run(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(stored.operations[0].status,'SETTLED');
  assert.equal(stored.operations[0].stop_reason,'CLEANUP_RESERVE_AT_RISK');
  assert.deepEqual(stored.charged,{read_bytes:100000500,write_bytes:5000});
  const job=(await db.query('SELECT status,result FROM quant_foundation_jobs')).rows[0];
  assert.equal(job.status,'CANCELLED');assert.equal(job.result,null);
});

test('terminal below the last observation is rejected and falls back',async()=>{
  overshootAfterRelease=true;terminal={read:8192,write:12288};
  await assert.rejects(adapter.run(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.equal(stored.operations[0].last.devices[0].read_bytes,100000000);
});

test('terminal failure before a proven stop still stops the child and stays unresolved',async()=>{
  terminal={};
  scheduler.cancel=async()=>{throw Error('cancel unavailable');};
  await assert.rejects(adapter.run(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal(stops,1);assert.deepEqual(events,['stop']);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'RELEASED');
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(stored.operations[0].status,'ACTIVE');
  assert.equal((await db.query('SELECT result FROM quant_foundation_jobs')).rows[0].result,null);
});
