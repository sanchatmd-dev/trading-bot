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
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {createProfileRuntimeHealth} from '../../src/postgres/quant-capacity-policy.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {buildProfileV2} from '../../src/quant-research/profile-pipeline-v2.js';
import {capacityPolicyHash,validateCapacityPolicy} from '../../src/quant-research/capacity-contract.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

const now=1800010000000;
let operationId='operation-00001';
let admin,db,name,root,store,budget,policy,contract,result,scheduler,ledger,claimed;
let revoked,malformed,overshootAfterRelease,revokeAfterRelease,growthDuringAuthorization,
  grown,launches,stops,adapter,terminal,events;
// W2 fixture switches: holdResult keeps the child frame pending until deliverFrame(); limitMs feeds
// handle.terminalLimitMs() (null: the handle has none); readyGate holds handle.ready until it resolves.
let holdResult,deliverFrame,limitMs,readyGate,authorizeGate,launcherHandle;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Waits until predicate() is truthy, or fails after limit ms. */
async function until(predicate,limit=8000,label='condition'){
  const started=Date.now();
  while(!predicate()){
    if(Date.now()-started>limit)throw new Error('timed out waiting for '+label);
    await pause(5);
  }
}
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
  // Empty research adapter tables let the actual worker reconcile its other lane without research execution.
  await db.query(`CREATE TABLE quant_jobs(run_id TEXT PRIMARY KEY,status TEXT,diagnostic TEXT,
    lease_token UUID,lease_until BIGINT,updated_at BIGINT);
    CREATE TABLE quant_research_foundation(run_id TEXT,job_id UUID);
    CREATE TABLE quant_research_chunks(run_id TEXT,unit_token UUID,unit_name TEXT);`);
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
  operationId='operation-00001';
  if(policy.terminal){delete policy.terminal;contract.capacity.policy_hash=capacityPolicyHash(policy);}
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  revoked=false;malformed=false;overshootAfterRelease=false;revokeAfterRelease=false;
  growthDuringAuthorization=false;grown=false;
  launches=0;stops=0;terminal=null;events=[];
  holdResult=false;deliverFrame=null;limitMs=null;readyGate=null;authorizeGate=null;launcherHandle=null;
  scheduler=new QuantFoundationScheduler({db,capacityPolicy:policy,profileV2Enabled:true,clock:()=>now,leaseMs:30000,
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
        let released=false,stopResult=null,terminatePromise=null,stopRequested=false;
        const proof={unitName,group,cgroupInode:23,invocationId};
        const stopOnce=()=>{
          if(!stopResult){stops++;events.push('stop');stopResult={unitName,launcherClosed:true,
            startRegistered:true,pendingStartsExcluded:true,unitStopped:true};}
          return stopResult;
        };
        const handle={payloadHash:hash(payload),ready:readyGate?readyGate.then(()=>proof):Promise.resolve(proof),
          accepted:Promise.resolve({unitName,payloadHash:hash(payload)}),
          profileResult:new Promise(resolve=>{launcher.resolveResult=resolve;}),
          async sample(){return {...proof,deviceId:'8:0',deviceInode:17,pid:4242,
            procStartTicks:'12345',readBytes:released&&overshootAfterRelease||grown?100000000:4096,
            writeBytes:4096};},
          release(){
            // A stopped unit refuses the payload, like the real launcher handle.
            if(stopResult)throw Error('unit stopped');
            assert.equal(released,false);released=true;
            if(revokeAfterRelease)revoked=true;
            const value=malformed?{jobId:'wrong',result}: {jobId:claimed.job_id,operationId,
              payloadHash:hash(payload),resultHash:hash(canonical(result)),result};
            deliverFrame=()=>launcher.resolveResult(value);
            if(!holdResult)deliverFrame();},
          // terminal.join models the real handle: a stop during terminate() joins it and shares its stop proof.
          async stop(){
            if(terminal?.join&&terminatePromise){stopRequested=true;return (await terminatePromise).stopProof;}
            return stopOnce();
          }};
        if(limitMs!==null)handle.terminalLimitMs=()=>limitMs;
        launcherHandle=handle;
        // FTR-1: scripted frozen terminal. Absent unless a test sets `terminal`.
        if(terminal){
          const script=terminal;let promise=null;
          handle.terminate=request=>{
            events.push('terminate');
            promise??=(async()=>{
              if(script.join){
                // A drain that polls until the test lets it end (drainOver) or a stop request arrives. It gives up
                // after 8 s so a missing stop shows as a failed assertion, never as a hung test run.
                const giveUp=Date.now()+8000;
                while(!stopRequested&&!script.drainOver&&Date.now()<giveUp)await pause(5);
                if(stopRequested)return Object.freeze({stopProof:stopOnce(),measured:false,reason:'STOP_REQUESTED',
                  ...(script.diagnostic?{diagnostic:script.diagnostic}:{})});
              }
              const frozen={...proof,deviceId:'8:0',deviceInode:17,pid:4242,procStartTicks:'12345',
                readBytes:script.read??8192,writeBytes:script.write??12288};
              const evidence={freezer:'frozen',windowMs:2500,reads:[{readBytes:frozen.readBytes,
                writeBytes:frozen.writeBytes},{readBytes:frozen.readBytes,writeBytes:frozen.writeBytes}],
                fileDirty:0,fileWriteback:0,maxBioBytes:1310720,
                rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288},
                ...(script.timings??{})};
              let committed=false;
              try{await request.commit(frozen,evidence);committed=true;}catch{}
              const stopProof=script.join?stopOnce():await handle.stop();
              return Object.freeze({stopProof,measured:script.measured??committed,
                postExit:script.postExit??'REMOVED',...(script.noMeasurement?{}:{frozenSample:frozen,readbackEvidence:evidence}),
                ...(script.diagnostic&&!(script.measured??committed)?{diagnostic:script.diagnostic}:{})});
            })();
            terminatePromise=promise;
            return promise;
          };
        }
        return handle;
      },async abort(){}};
    }};
  adapter=new QuantProfileRuntimeV2({db,ledger,scheduler,launcher,storageBudget:budget,clock:()=>now,
    authorizeRelease:async (binding,job)=>{
      if(growthDuringAuthorization)grown=true;
      if(authorizeGate)await authorizeGate;
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

// ---- W2: run signals, beforeTerminal, emergency stop, compute deadline, policy binding, reserve edge ----
const aborted=()=>{const controller=new AbortController();controller.abort();return controller.signal;};
const ledgerRows=async()=>(await db.query('SELECT state FROM quant_io_ledgers')).rows;
const launchRows=async()=>(await db.query('SELECT state FROM quant_io_launches')).rows;
const jobRow=async()=>(await db.query('SELECT status,result FROM quant_foundation_jobs WHERE job_id=$1',[claimed.job_id])).rows[0];
const spyCancel=()=>{
  const cancel=scheduler.cancel.bind(scheduler);
  scheduler.cancel=async(...values)=>{events.push('scheduler.cancel');return cancel(...values);};
};
const startedRun=extra=>{
  const running=adapter.run({...args(),...extra});
  running.catch(()=>{});
  return running;
};

test('measured terminal with the run hooks: beforeTerminal once, then scheduler.cancel, then the drained terminate (T-P1)',async()=>{
  // Bad arguments are refused before anything is reserved or written.
  for(const bad of [{signal:{}},{emergency:'x'},{beforeTerminal:'x'},{signal:{aborted:false}}])
    await assert.rejects(adapter.run({...args(),...bad}),{code:'QUANT_IO_LAUNCH_UNCERTAIN'},JSON.stringify(bad));
  assert.equal(launches,0);assert.equal((await ledgerRows()).length,0);assert.equal((await jobRow()).status,'RUNNING');
  terminal={};let hooks=0;spyCancel();
  const outcome=await adapter.run({...args(),signal:new AbortController().signal,emergency:new AbortController().signal,
    beforeTerminal:async()=>{hooks++;events.push('hook');}});
  assert.equal(outcome.proof,'MEASURED_FINAL_SETTLED');assert.equal(hooks,1);
  assert.deepEqual(events,['hook','scheduler.cancel','terminate','stop']);
  const stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations[0].status,'SETTLED');
  assert.deepEqual(stored.charged,{read_bytes:8192,write_bytes:12288});
  assert.equal((await jobRow()).status,'CANCELLED');assert.equal((await jobRow()).result,null);
});

test('a graceful stop mid-frame ends the frame wait, runs beforeTerminal once before scheduler.cancel, then drains (T-P2)',async()=>{
  terminal={};holdResult=true;spyCancel();
  const graceful=new AbortController();let hooks=0;
  const running=startedRun({signal:graceful.signal,beforeTerminal:async()=>{hooks++;events.push('hook');}});
  await until(()=>deliverFrame!==null,8000,'payload release');
  await pause(300);
  assert.equal(events.length,0,'the frame wait runs without any stop');
  graceful.abort();
  await assert.rejects(running,error=>{
    assert.equal(error.code,'PROFILE_STOP_REQUESTED');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'});
    return true;
  });
  assert.equal(hooks,1);assert.deepEqual(events,['hook','scheduler.cancel','terminate','stop']);
  assert.equal(stops,1);
  const job=await jobRow();assert.equal(job.status,'CANCELLED');assert.equal(job.result,null);
  const stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations[0].status,'SETTLED');
  assert.deepEqual(stored.charged,{read_bytes:8192,write_bytes:12288});
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');
  deliverFrame();await pause(50);// the abandoned frame is never admitted
  assert.equal((await jobRow()).result,null);
});

test('an emergency during the drained terminal stops the unit within one poll and charges the unknown final (T-P3)',async()=>{
  terminal={join:true};holdResult=true;
  const graceful=new AbortController(),emergency=new AbortController();
  const running=startedRun({signal:graceful.signal,emergency:emergency.signal});
  await until(()=>deliverFrame!==null,8000,'payload release');
  graceful.abort();
  await until(()=>events.includes('terminate'),8000,'terminal start');
  await pause(60);
  assert.equal(stops,0,'the drain is still polling; nothing is stopped');
  const at=Date.now();
  emergency.abort();
  await assert.rejects(running,error=>{
    assert.equal(error.code,'PROFILE_STOP_REQUESTED');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'UNKNOWN_FINAL_CHARGED'});
    return true;
  });
  assert.ok(Date.now()-at<1500,'stopped within a poll and the fallback transactions: '+(Date.now()-at));
  assert.equal(stops,1);assert.equal(events.filter(event=>event==='terminate').length,1);
  const stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.deepEqual(stored.charged,{read_bytes:97000000,write_bytes:97000000});
  assert.equal(stored.operations[0].last.devices[0].read_bytes,4096,'the frozen sample was never committed');
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');
  assert.equal((await jobRow()).status,'CANCELLED');
});

test('a stop before the reserve reserves nothing, launches nothing and leaves the job untouched (T-P4)',async()=>{
  for(const [name,extra] of [['emergency',{emergency:aborted()}],['graceful',{signal:aborted()}]]){
    await assert.rejects(adapter.run({...args(),...extra,beforeTerminal:async()=>{events.push('hook');}}),
      {code:'PROFILE_STOP_REQUESTED'},name);
    assert.equal(launches,0,name);assert.equal((await ledgerRows()).length,0,name);
    assert.equal((await launchRows()).length,0,name);assert.deepEqual(events,[],name);
    assert.equal((await jobRow()).status,'RUNNING',name);
  }
});

test('an emergency after the start and before the release never freezes: stop at once, fallback, STOP_PROVEN (T-P5)',async()=>{
  // Case A: the unit is spawned, its readiness is still pending.
  let openReady;
  readyGate=new Promise(resolve=>{openReady=resolve;});
  terminal={};
  const early=new AbortController();
  const first=startedRun({emergency:early.signal});
  await until(()=>launches===1,8000,'spawn');
  early.abort();
  await until(()=>stops===1,8000,'emergency stop');
  openReady();
  await assert.rejects(first,error=>{
    assert.equal(error.code,'PROFILE_STOP_REQUESTED');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'UNKNOWN_FINAL_CHARGED'});return true;
  });
  assert.deepEqual(events,['stop']);// no terminate, no freeze
  let stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.deepEqual(stored.charged,{read_bytes:97000000,write_bytes:97000000});
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
});

test('an emergency while the payload release is being authorized: the bound unit is stopped and the terminal never freezes (T-P5)',async()=>{
  let openAuthorization;
  authorizeGate=new Promise(resolve=>{openAuthorization=resolve;});
  terminal={};
  const emergency=new AbortController();
  const running=startedRun({emergency:emergency.signal});
  await until(()=>launches===1&&launcherHandle!==null,8000,'spawn');
  await pause(400);// bound, and waiting in the authorization callback of the release
  assert.equal(stops,0);
  emergency.abort();
  await until(()=>stops===1,8000,'emergency stop');
  openAuthorization();
  await assert.rejects(running);
  assert.equal(events.includes('terminate'),false);assert.equal(stops,1);
  assert.equal(deliverFrame,null,'the payload was never released');
  const stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.deepEqual(stored.charged,{read_bytes:97000000,write_bytes:97000000});
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
});

// The T-P6 tests carry a timeout: a deadline check that never fires must fail the test, not hang the run (W2-L3).
// deadlineRun also hands the test signal to the run. When the timeout fires the signal aborts, so the frame loop ends
// and drains instead of polling on into the next test, and t.after waits for it.
const DEADLINE_TEST={timeout:20000};
const deadlineRun=(t,runtime=adapter)=>{
  const running=runtime.run({...args(),signal:t.signal});
  running.catch(()=>{});
  t.after(()=>running.catch(()=>{}));
  return running;
};

test('the frame loop ends at the compute deadline: drained terminal, measured settle, no provisional result (T-P6)',DEADLINE_TEST,async t=>{
  terminal={};holdResult=true;limitMs=10000;
  const running=deadlineRun(t);
  await until(()=>deliverFrame!==null,8000,'payload release');
  await pause(300);
  assert.equal(events.length,0,'still computing while the limit is comfortable');
  limitMs=1100;// pollMs 100 + 1,000 ms slack: the loop needs strictly more
  await assert.rejects(running,error=>{
    assert.equal(error.code,'PROFILE_COMPUTE_DEADLINE');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'});return true;
  });
  assert.deepEqual(events,['terminate','stop']);
  const job=await jobRow();assert.equal(job.status,'CANCELLED');assert.equal(job.result,null);
  const stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations[0].status,'SETTLED');
  assert.deepEqual(stored.charged,{read_bytes:8192,write_bytes:12288});
  deliverFrame();await pause(50);
  assert.equal((await jobRow()).result,null);
});

test('one millisecond above the compute deadline slack the frame loop keeps waiting (T-P6 boundary)',DEADLINE_TEST,async t=>{
  holdResult=true;limitMs=1101;
  let settled=false;
  const running=deadlineRun(t);
  running.then(()=>{settled=true;},()=>{settled=true;});
  await until(()=>deliverFrame!==null,8000,'payload release');
  await pause(500);
  assert.equal(settled,false);assert.equal(events.length,0);
  deliverFrame();
  const outcome=await running;
  assert.equal(outcome.status,'CANCELLED');assert.equal(outcome.provisional.resultHash,hash(canonical(result)));
});

test('a limit that is not a number is not above the slack: the loop ends as if the deadline had passed (T-P6)',DEADLINE_TEST,async t=>{
  limitMs=NaN;
  await assert.rejects(deadlineRun(t),error=>{
    assert.equal(error.code,'PROFILE_COMPUTE_DEADLINE');
    assert.equal(error.terminal.status,'CANCELLED');return true;
  });
  assert.equal((await jobRow()).status,'CANCELLED');
});

test('a limit that drops to the slack during an observation ends the loop before the heartbeat and the next poll (T-P6, W2-L2)',DEADLINE_TEST,async t=>{
  // The adapter clock is skewed so a heartbeat is due as soon as the third observation returns. The limit drops during
  // that observation. Without the check right after it the loop would send the heartbeat first and end on the next pass.
  let skew=0,beats=0,observed=0;
  const beat=scheduler.heartbeat.bind(scheduler);
  scheduler.heartbeat=async(...values)=>{beats++;return beat(...values);};
  const skewed=new QuantProfileRuntimeV2({db,ledger,scheduler,launcher:adapter.launcher,storageBudget:budget,
    clock:()=>now+skew,authorizeRelease:async()=>({ok:true}),health:async()=>({ok:true})});
  terminal={};holdResult=true;limitMs=10000;
  const observe=skewed.io.observe.bind(skewed.io);
  skewed.io.observe=async(...values)=>{
    const value=await observe(...values);
    observed++;
    if(observed===3){skew=6000;limitMs=1100;}
    return value;
  };
  const running=deadlineRun(t,skewed);
  await assert.rejects(running,error=>{
    assert.equal(error.code,'PROFILE_COMPUTE_DEADLINE');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'});return true;
  });
  assert.equal(observed,3);assert.equal(beats,0,'no heartbeat after the limit dropped');
  assert.deepEqual(events,['terminate','stop']);
  assert.equal((await jobRow()).status,'CANCELLED');assert.equal((await jobRow()).result,null);
});

test('a limit that drops during the observation that completes the frame does not discard the frame (T-P6, W2-L2)',DEADLINE_TEST,async t=>{
  // Pass 1 carries the acceptance and pass 2 the result. The limit falls to the slack while pass 2 observes. The frame is
  // then complete: the loop ends normally with the provisional result and the terminal follows as usual.
  terminal={};limitMs=10000;
  let observed=0;
  const observe=adapter.io.observe.bind(adapter.io);
  adapter.io.observe=async(...values)=>{
    const value=await observe(...values);
    observed++;
    if(observed===2)limitMs=1100;
    return value;
  };
  const outcome=await deadlineRun(t);
  assert.equal(observed,2);
  assert.equal(outcome.status,'CANCELLED');assert.equal(outcome.proof,'MEASURED_FINAL_SETTLED');
  assert.equal(outcome.provisional.resultHash,hash(canonical(result)));
  assert.equal((await jobRow()).status,'CANCELLED');
});

test('the ledger policy must be the contract policy and the launcher terminal block the policy block, before any reserve (T-P7)',async()=>{
  const devices=[{device_id:'8:0',device_inode:17}];
  const build=(policyValue,launcherConfig=null)=>{
    const base=adapter.launcher;
    const launcher=launcherConfig?Object.assign(Object.create(base),{terminalConfig:Object.freeze(launcherConfig)}):base;
    return new QuantProfileRuntimeV2({db,scheduler,launcher,storageBudget:budget,clock:()=>now,
      ledger:new QuantIoLedger({db,policy:policyValue,devices,authorizeTerminal:async()=>({ok:true}),clock:()=>now}),
      authorizeRelease:async()=>({ok:true}),health:async()=>({ok:true})});
  };
  const untouched=async(name)=>{
    assert.equal(launches,0,name);assert.equal((await ledgerRows()).length,0,name);
    assert.equal((await launchRows()).length,0,name);assert.equal((await jobRow()).status,'RUNNING',name);
    assert.deepEqual(events,[],name);
  };
  const block={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:0,tail_margin_ms:5000};
  const different={...policy,max_raw_bars:policy.max_raw_bars-1};
  await assert.rejects(build(different).run(args()),{code:'QUANT_PROFILE_POLICY_MISMATCH'});await untouched('other policy');
  const withBlock={...policy,terminal:block};
  await assert.rejects(build(withBlock).run(args()),{code:'QUANT_PROFILE_POLICY_MISMATCH'});await untouched('block, launcher has none');
  await assert.rejects(build(policy,block).run(args()),{code:'QUANT_PROFILE_POLICY_MISMATCH'});await untouched('launcher block, policy has none');
  await assert.rejects(build(withBlock,{...block,tail_margin_ms:7500}).run(args()),
    {code:'QUANT_PROFILE_POLICY_MISMATCH'});await untouched('other tail');
  // An equal block passes the binding (the run then stops at the next check: the wrong owner), and so does no block on both sides.
  await assert.rejects(build(withBlock,{...block}).run({...args(),ownerId:'wrong-owner'}),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await untouched('equal block');
  await assert.rejects(build(policy).run({...args(),ownerId:'wrong-owner'}),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await untouched('no block');
});

test('an owner cancel during RUNNING is seen by the poll loop: the terminal still drains and settles (W2 3.3)',async()=>{
  terminal={};holdResult=true;
  let hooks=0;
  const running=startedRun({beforeTerminal:async()=>{hooks++;}});
  await until(()=>deliverFrame!==null,8000,'payload release');
  await pause(200);
  await scheduler.cancel('owner-a',claimed.job_id);
  await assert.rejects(running,error=>{
    assert.equal(error.code,'QUANT_IO_LEASE_LOST');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'});return true;
  });
  assert.equal(hooks,1);assert.deepEqual(events,['terminate','stop']);
  assert.equal((await ledgerRows())[0].state.operations[0].status,'SETTLED');
});

/** Wraps the runtime database so one runtime transaction can commit-then-fail or roll back. */
function faultyRuntimeDb(mode){
  let inject=true;
  adapter.io.db={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:async callback=>{
      if(mode==='lost-ack'){
        const value=await db.transaction(callback);
        if(inject&&(await db.query('SELECT count(*)::int AS n FROM quant_io_launches')).rows[0].n===1){
          inject=false;throw Error('commit acknowledgement lost');
        }
        return value;
      }
      return db.transaction(async()=>{
        const value=await callback();
        if(inject){inject=false;throw Error('reserve rolled back');}
        return value;
      });
    }};
}

test('a reserve whose commit outcome is unknown still gets its terminal: no-start proof for the intent, crash charge, CANCELLED (T-P9)',async()=>{
  faultyRuntimeDb('lost-ack');
  await assert.rejects(adapter.run(args()),error=>{
    assert.equal(error.code,'QUANT_IO_ACCOUNTING_UNAVAILABLE');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'UNKNOWN_FINAL_CHARGED'});return true;
  });
  assert.equal(launches,0);
  const stored=(await ledgerRows())[0].state;
  assert.equal(stored.operations.length,1);assert.equal(stored.operations[0].status,'CRASHED');
  assert.deepEqual(stored.charged,{read_bytes:97000000,write_bytes:97000000});
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');
  assert.equal((await jobRow()).status,'CANCELLED');
});

test('a reserve that rolled back leaves no intent and no operation: no-start proof, ACK, nothing charged (T-P9)',async()=>{
  faultyRuntimeDb('rollback');
  await assert.rejects(adapter.run(args()),error=>{
    assert.equal(error.code,'QUANT_IO_ACCOUNTING_UNAVAILABLE');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'NO_START_PROVEN'});return true;
  });
  assert.equal(launches,0);assert.equal((await launchRows()).length,0);
  const stored=(await ledgerRows())[0].state;// ledger.open committed on its own
  assert.equal(stored.operations.length,0);assert.deepEqual(stored.charged,{read_bytes:0,write_bytes:0});
  assert.equal((await jobRow()).status,'CANCELLED');
  assert.equal(stops,0);
});

const hostRefusal=cause=>Object.assign(Error('refused'),{code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED',
  ioDiagnostic:Object.freeze({phase:'PRE_RESERVE',cause})});

test('the drain host gate refuses before anything is written: no ledger, no launch row, the job stays RUNNING (L1)',async()=>{
  let prepares=0,gates=0;
  const prepare=adapter.launcher.prepare;
  adapter.launcher.prepare=async(...values)=>{prepares++;return prepare(...values);};
  adapter.launcher.assertDrainHost=async()=>{gates++;throw hostRefusal('DRAIN_UNDERSIZED');};
  await assert.rejects(adapter.run(args()),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
    assert.deepEqual(error.ioDiagnostic,{phase:'PRE_RESERVE',cause:'DRAIN_UNDERSIZED'});
    assert.equal(error.terminal,undefined);return true;
  });
  assert.equal(gates,1);assert.equal(prepares,0);assert.equal(launches,0);
  assert.equal((await ledgerRows()).length,0);assert.equal((await launchRows()).length,0);
  assert.equal((await jobRow()).status,'RUNNING');assert.deepEqual(events,[]);
  // Any other failure of the gate carries the same fixed code and none of its own detail.
  adapter.launcher.assertDrainHost=async()=>{throw Object.assign(Error('secret /srv/path'),{code:'EIO'});};
  await assert.rejects(adapter.run(args()),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
    assert.equal(error.ioDiagnostic,undefined);assert.equal(String(error.message).includes('secret'),false);return true;
  });
  assert.equal((await ledgerRows()).length,0);assert.equal((await jobRow()).status,'RUNNING');
  // The gate passes: the run is unchanged (gate called by the run and again by the reserve).
  gates=0;adapter.launcher.assertDrainHost=async()=>{gates++;};
  assert.equal((await adapter.run(args())).status,'CANCELLED');
  assert.equal(gates,2);assert.equal(prepares,1);
});

test('a host that changes after the run gate is refused by the reserve gate: no ledger row, no-start proof, CANCELLED (L1)',async()=>{
  let gates=0;
  adapter.launcher.assertDrainHost=async()=>{if(++gates>=2)throw hostRefusal('FS_NOT_EXT4');};
  await assert.rejects(adapter.run(args()),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
    assert.deepEqual(error.terminal,{status:'CANCELLED',proof:'NO_START_PROVEN'});return true;
  });
  assert.equal(gates,2);assert.equal(launches,0);
  assert.equal((await ledgerRows()).length,0);assert.equal((await launchRows()).length,0);
  assert.equal((await jobRow()).status,'CANCELLED');
});

test('the fallback diagnostic never reaches the ledger, the launch rows or the job (T-P10)',async()=>{
  const diagnostic=Object.freeze({version:'quant-io-terminal-diagnostic-v2',stage:'DRAIN',fileDirty:8192,fileWriteback:0,
    memoryReads:9,sinceFreezeMs:10000,barrierMs:40,requiredDrainMs:7000,
    drain:{enabled:true,durationMs:10000,polls:9,maxDirty:12288,maxWriteback:0,firstZeroMs:null,series:[[0,8192,0]]}});
  terminal={measured:false,diagnostic};
  const outcome=await adapter.run(args());
  assert.equal(outcome.proof,'UNKNOWN_FINAL_CHARGED');assert.deepEqual(Object.keys(outcome),['status','proof','provisional']);
  const dump=JSON.stringify([(await db.query('SELECT * FROM quant_io_ledgers')).rows,
    (await db.query('SELECT * FROM quant_io_launches')).rows,(await db.query('SELECT * FROM quant_foundation_jobs')).rows]);
  for(const marker of ['quant-io-terminal-diagnostic','sinceFreezeMs','firstZeroMs','maxDirty','requiredDrainMs','memoryReads'])
    assert.equal(dump.includes(marker),false,marker);
  // The jobs table has its own diagnostic column (a different, older field): it stays empty.
  assert.equal((await db.query('SELECT diagnostic FROM quant_foundation_jobs')).rows[0].diagnostic,null);
});

test('a failing beforeTerminal never blocks the terminal: the unit is still stopped and charged (W2 3.4)',async()=>{
  terminal={};
  const outcome=await adapter.run({...args(),beforeTerminal:async()=>{throw Error('heartbeat join failed');}});
  assert.equal(outcome.status,'CANCELLED');assert.equal(outcome.proof,'MEASURED_FINAL_SETTLED');
  assert.equal((await jobRow()).status,'CANCELLED');assert.equal(stops,1);
});

test('a graceful stop is seen at once by the frame wait, not at the next poll (W2 3.3)',async()=>{
  // A 1,000 ms poll: without racing the signal the loop would notice the stop only when the poll timer fires.
  const slow=new QuantProfileRuntimeV2({db,ledger,scheduler,launcher:adapter.launcher,storageBudget:budget,clock:()=>now,
    pollMs:1000,authorizeRelease:async()=>({ok:true}),health:async()=>({ok:true})});
  terminal={};holdResult=true;
  let observed=0;
  const observe=slow.io.observe.bind(slow.io);
  slow.io.observe=async(...values)=>{const value=await observe(...values);observed++;return value;};
  const graceful=new AbortController();
  const running=slow.run({...args(),signal:graceful.signal});running.catch(()=>{});
  await until(()=>observed>=1,8000,'first observation');
  await pause(30);// the next iteration is now waiting on its 1,000 ms poll timer
  const at=Date.now();
  graceful.abort();
  await assert.rejects(running,{code:'PROFILE_STOP_REQUESTED'});
  assert.ok(Date.now()-at<700,'stop took '+(Date.now()-at)+' ms');
  assert.equal((await jobRow()).status,'CANCELLED');
});

async function productWorker({health=async()=>({ok:true}),leaseMs=60}={}){
  // The initial legacy-shaped row has not launched. Cancel it under trusted no-start proof,
  // then enqueue the policy-bound product contract before claiming; never mutate immutable contracts.
  await scheduler.cancel(claimed.owner_id,claimed.job_id);
  await scheduler.acknowledgeStopped(claimed.job_id,claimed.lease_token);
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
  contract.capacity.policy_hash=capacityPolicyHash(policy);
  scheduler.capacityPolicy=validateCapacityPolicy(policy);
  const queued=await scheduler.enqueue(contract.owner_id,contract,randomUUID());
  claimed=await scheduler.claim('product-profile-worker-test');assert.equal(claimed.job_id,queued.job_id);
  operationId='op-'+claimed.lease_token;
  ledger.policy=validateCapacityPolicy(policy);adapter.launcher.terminalConfig=ledger.policy.terminal;
  const logs=[],worker=new QuantResearchFoundationWorker({service:{db,foundation:true,storageBudget:budget},
    profileService:{authorize:async()=>({ok:true})},health,clock:()=>now,leaseMs,capacityPolicy:policy,
    profileV2Enabled:true,profileRuntimeV2:adapter,terminalLog:line=>logs.push(JSON.parse(line))});
  scheduler=worker.scheduler;adapter.scheduler=scheduler;adapter.io.scheduler=scheduler;
  adapter.io.profile.health=createProfileRuntimeHealth(health);
  worker.claim=async()=>({kind:'PROFILE',foundation:claimed});
  let heartbeats=0;
  const heartbeat=scheduler.heartbeat.bind(scheduler);
  scheduler.heartbeat=async(...values)=>{heartbeats++;return heartbeat(...values);};
  return {worker,logs,heartbeats:()=>heartbeats};
}

test('product worker happy path quiets heartbeat throughout a long terminal and logs bounded timings (T-W3)',{timeout:15000},async()=>{
  const f=await productWorker();terminal={join:true,timings:{drainMs:80,barrierMs:7}};holdResult=true;
  const tick=f.worker.tick();await until(()=>deliverFrame!==null);await pause(55);deliverFrame();
  await until(()=>events.includes('terminate'));const atTerminal=f.heartbeats();
  await pause(180);assert.equal(f.heartbeats(),atTerminal,'no heartbeat during STOPPING drain');
  terminal.drainOver=true;assert.equal(await tick,true);
  assert.equal((await jobRow()).status,'CANCELLED');assert.equal(stops,1);
  assert.equal(f.logs.length,1);assert.equal(f.logs[0].proof,'MEASURED_FINAL_SETTLED');
  assert.equal(f.logs[0].drainMs,80);assert.equal(f.logs[0].barrierMs,7);
  assert.ok(Number.isSafeInteger(f.logs[0].elapsedMs));assert.ok(f.logs[0].elapsedMs>=180);
  assert.deepEqual(Object.keys(f.logs[0]).sort(),['barrierMs','childDiagnostic','drainMs','elapsedMs','jobId','proof','reason']);
  // This synthetic launcher has no stderr observer. Unknown observation cannot assert launcher or kernel exit.
  assert.deepEqual(f.logs[0].childDiagnostic,{version:'profile-child-diagnostic-v1',code:'UNKNOWN',byteCount:0,
    byteCountExact:false,truncated:false,closeObserved:false,exitStatus:null,exitStatusKnown:false,
    exitSignal:null,exitSignalKnown:false,exitScope:'LAUNCHER_PROCESS',childKernelStatusKnown:false});
});

test('product worker health loss mid-frame drains and cancels one attempt (T-W4)',{timeout:15000},async()=>{
  let healthy=true;
  const f=await productWorker({health:async()=>({ok:healthy})});terminal={};holdResult=true;
  const tick=f.worker.tick();await until(()=>deliverFrame!==null);healthy=false;
  assert.equal(await tick,true);const job=await jobRow();assert.equal(job.status,'CANCELLED');
  assert.equal(job.result,null);assert.equal(stops,1);assert.equal(f.logs[0].proof,'MEASURED_FINAL_SETTLED');
  assert.equal((await db.query('SELECT attempts FROM quant_foundation_jobs WHERE job_id=$1',[claimed.job_id])).rows[0].attempts,1);
});

test('product worker stop mid-frame uses emergency fallback and proves stop (T-W5)',{timeout:15000},async()=>{
  const f=await productWorker();terminal={};holdResult=true;
  const tick=f.worker.tick();await until(()=>deliverFrame!==null);
  const at=Date.now();await f.worker.stop();await tick;
  assert.ok(Date.now()-at<2000);assert.equal(stops,1);
  assert.equal(events.includes('terminate'),false,'emergency does not freeze');
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
  assert.equal(f.logs[0].proof,'UNKNOWN_FINAL_CHARGED');assert.equal(f.worker.profileOperations.size,0);
});

test('production start/stop loop waits for terminal proof before stop resolves (T-W5 loop)',{timeout:15000},async()=>{
  const f=await productWorker();terminal={};holdResult=true;
  let admitted=false,loopDone=false;
  f.worker.claim=async()=>{if(admitted)return null;admitted=true;return {kind:'PROFILE',foundation:claimed};};
  f.worker.start();f.worker.loop.then(()=>{loopDone=true;});
  await until(()=>deliverFrame!==null);assert.equal(loopDone,false);
  await f.worker.stop();
  assert.equal(loopDone,true);assert.equal(f.worker.running,false);assert.equal(stops,1);
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
  assert.equal(f.worker.controller,null);assert.equal(f.worker.emergencyController,null);
});

test('product worker stop mid-drain joins one physical stop and charges fallback (T-W6)',{timeout:15000},async()=>{
  const f=await productWorker();terminal={join:true};
  const tick=f.worker.tick();await until(()=>events.includes('terminate'));
  await f.worker.stop();await tick;
  assert.equal(stops,1);assert.equal(events.filter(event=>event==='terminate').length,1);
  assert.equal((await launchRows())[0].state,'STOP_PROVEN');assert.equal((await jobRow()).status,'CANCELLED');
  assert.equal(f.logs[0].proof,'UNKNOWN_FINAL_CHARGED');assert.equal(adapter.io.emergency.size,0);
});

test('empty-memory product reconciliation keeps unresolved I/O STOPPING then acknowledges durable proof (T-W7)',{timeout:15000},async()=>{
  const f=await productWorker();await adapter.io.reserve(args());await scheduler.cancel(claimed.owner_id,claimed.job_id);
  assert.equal(f.worker.stopped.size,0);assert.equal(f.worker.profileOperations.size,0);
  await f.worker.reconcile();assert.equal((await jobRow()).status,'STOPPING');
  await adapter.io.cancel(args());assert.equal((await jobRow()).status,'CANCELLED');
  // Model a parent crash after durable terminal proof, before the ACK mutation. No in-memory stop set is retained.
  await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',lease_token=$2,stop_reason='HEALTH_UNAVAILABLE' WHERE job_id=$1",[claimed.job_id,claimed.lease_token]);
  await f.worker.reconcile();assert.equal((await jobRow()).status,'CANCELLED');
});

test('product worker pre-reserve host refusal tears down heartbeat and reconciles no-start proof (T-W10 carry)',{timeout:15000},async()=>{
  const f=await productWorker();adapter.launcher.assertDrainHost=async()=>{throw hostRefusal('FS_NOT_EXT4');};
  await f.worker.tick();const count=f.heartbeats();await pause(70);assert.equal(f.heartbeats(),count);
  assert.equal(launches,0);assert.equal((await ledgerRows()).length,0);assert.equal((await launchRows()).length,0);
  assert.equal((await jobRow()).status,'CANCELLED');assert.equal(f.logs[0].reason,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
});

test('product worker unconfirmed stop retains durable quarantine for offline recovery (T-W8)',{timeout:15000},async()=>{
  const f=await productWorker();holdResult=true;
  const tick=f.worker.tick();await until(()=>launcherHandle&&deliverFrame!==null);
  launcherHandle.stop=async()=>({unitName:quantIoUnitName(claimed.job_id,operationId),launcherClosed:true,
    startRegistered:true,pendingStartsExcluded:true,unitStopped:false});
  await f.worker.stop();await tick;
  assert.equal((await jobRow()).status,'STOPPING');assert.equal((await launchRows())[0].state,'RELEASED');
  assert.equal((await ledgerRows())[0].state.operations[0].status,'ACTIVE');
  await f.worker.reconcile();assert.equal((await jobRow()).status,'STOPPING');
  assert.equal(f.logs.length,1);assert.equal(f.logs[0].proof,'UNCONFIRMED');
});

test('measured readback without a committed settle does not log COMPLETE',async()=>{
  const logs=[];terminal={};adapter.io.settleMeasured=async()=>false;
  const answer=await adapter.run({...args(),onTerminalDiagnostic:value=>logs.push(value)});
  assert.equal(answer.proof,'UNKNOWN_FINAL_CHARGED');assert.equal(logs[0].reason,'UNKNOWN');
});

test('terminal diagnostic callback omits arbitrary metadata and cannot change result or accounting',async()=>{
  const logs=[];terminal={measured:false,noMeasurement:true,diagnostic:{drain:{durationMs:19},barrierMs:3,
    source:'/private/source',result:'secret',elapsedMs:-1}};
  const answer=await adapter.run({...args(),onTerminalDiagnostic:record=>{logs.push(record);throw Error('log unavailable');}});
  assert.equal(answer.proof,'UNKNOWN_FINAL_CHARGED');assert.equal(logs.length,1);
  assert.deepEqual(Object.keys(logs[0]).sort(),['barrierMs','drainMs','elapsedMs','proof','reason']);
  assert.equal(logs[0].drainMs,19);assert.equal(logs[0].barrierMs,3);assert.ok(logs[0].elapsedMs>=0);
  assert.equal((await jobRow()).status,'CANCELLED');assert.equal((await ledgerRows())[0].state.operations[0].status,'CRASHED');
});
