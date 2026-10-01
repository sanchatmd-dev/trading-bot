import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {validateProfileEnrollmentReceipt} from '../../src/quant-research/profile-contract-v2.js';
import {createEnrollmentRuntimeFixture} from '../helpers/quant-profile-enrollment-runtime-fixture.mjs';

let admin;
before(()=>{assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});});
after(async()=>{await admin?.close();});
async function fixture(t){const value=await createEnrollmentRuntimeFixture(admin);t.after(()=>value.dispose());return value;}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function until(predicate){const deadline=Date.now()+15000;
 while(!await predicate()){if(Date.now()>=deadline)throw Error('condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
async function settledOnly(f){const evidence=await f.evidence();assert.equal(evidence.job.status,'CANCELLED');
 assert.equal(evidence.job.result,null);assert.equal(evidence.receipt,null);
 assert.equal(evidence.launch.state,'STOP_PROVEN');assert.equal(evidence.ledger.state.operations[0].status,'SETTLED');}

test('marked runtime publishes measured settlement, stop proof, receipt and success atomically',async t=>{
 const f=await fixture(t),answer=await f.runtime.run(f.args),evidence=await f.evidence();
 assert.deepEqual(answer,{status:'SUCCEEDED',proof:'MEASURED_FINAL_SETTLED'});
 assert.equal(evidence.job.lease_token,null);validateProfileEnrollmentReceipt(evidence);
 assert.deepEqual(f.authorityCalls,['BEGIN','FINALIZE']);assert.equal(f.stats().stops,1);assert.equal(f.stats().hashReads,2);
 assert.equal(evidence.ledger.state.charged.read_bytes,4096);assert.equal(evidence.ledger.state.charged.write_bytes,4096);
});

test('fresh poststop health and executable refresh denial preserve measured settlement',async t=>{
 for(const field of ['healthy','hashMismatch'])await t.test(field,async st=>{
  const f=await fixture(st),gate=deferred();f.knobs.terminalGate=gate.promise;
  const running=f.runtime.run(f.args);running.catch(()=>{});
  try{await until(async()=>(await f.job()).stop_reason==='PROFILE_COMPLETING');
   f.knobs[field]=field==='healthy'?false:true;gate.resolve();await running;await settledOnly(f);
  }finally{gate.resolve();await running.catch(()=>{});}
 });
});

test('owner cancel during drain vetoes publication without losing measured accounting',async t=>{
 const f=await fixture(t),gate=deferred();f.knobs.terminalGate=gate.promise;
 const running=f.runtime.run(f.args);running.catch(()=>{});
 try{await until(async()=>(await f.job()).stop_reason==='PROFILE_COMPLETING');
  await f.scheduler.cancel(f.claimed.owner_id,f.claimed.job_id);gate.resolve();await running;await settledOnly(f);
 }finally{gate.resolve();await running.catch(()=>{});}
});

test('signal arriving while receipt INSERT awaits rolls publication back to savepoint only',async t=>{
 const f=await fixture(t),signal=new AbortController(),query=f.db.query.bind(f.db);
 f.db.query=async(sql,...args)=>{const answer=await query(sql,...args);
  if(sql.startsWith('INSERT INTO public.quant_profile_enrollment_receipts'))signal.abort();return answer;};
 await f.runtime.run({...f.args,signal:signal.signal});await settledOnly(f);
});

test('terminal time exhausts runtime budget; measured settlement stays committed without enrollment',async t=>{
 const f=await fixture(t);f.knobs.advanceTerminal=f.claimed.contract.budget.max_runtime_ms;
 await f.runtime.run(f.args);await settledOnly(f);
 assert.ok((await f.job()).runtime_used_ms>=f.claimed.contract.budget.max_runtime_ms);
});

test('lost success COMMIT response reads exact cleared-token enrollment without crash charging',async t=>{
 const f=await fixture(t);f.knobs.dropSuccessCommit=true;
 const answer=await f.runtime.run(f.args),evidence=await f.evidence();
 assert.equal(answer.status,'SUCCEEDED');assert.equal(answer.proof,'MEASURED_FINAL_SETTLED');
 validateProfileEnrollmentReceipt(evidence);assert.equal(evidence.ledger.state.operations[0].status,'SETTLED');
 assert.equal(evidence.ledger.state.charged.read_bytes,4096);assert.equal(f.stats().stops,1);
});

test('beforeTerminal throw vetoes marked enrollment and forged completion cannot start publication',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.scheduler.beginProfileCompletion({job_id:f.claimed.job_id,lease_token:f.claimed.lease_token,attempt:{}}),
  {code:'PROFILE_ENROLLMENT_DENIED'});
 await assert.rejects(f.runtime.run({...f.args,beforeTerminal:async()=>{throw Error('private');}}),{code:'PROFILE_ENROLLMENT_DENIED'});
 const evidence=await f.evidence();assert.equal(evidence.job.status,'CANCELLED');assert.equal(evidence.job.result,null);
 assert.equal(evidence.receipt,null);
});

test('duplicate settled-only completion joins cancellation retry without a second terminal or crash charge',async t=>{
 const f=await fixture(t);let completion,attempts=0;
 const begin=f.scheduler.beginProfileCompletion.bind(f.scheduler),ack=f.scheduler.acknowledgeStopped.bind(f.scheduler);
 f.scheduler.beginProfileCompletion=async args=>{completion=await begin(args);return completion;};
 f.scheduler.acknowledgeStopped=async(...args)=>{if(++attempts===1)throw Error('temporary acknowledgement failure');return ack(...args);};
 // Pre-frame observations pass. Fresh health after the stop denies publication.
 f.runtime.io.profile.health=async()=>({ok:(await f.job()).status==='RUNNING'});
 await assert.rejects(f.runtime.run(f.args),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
 assert.ok(completion);assert.equal((await f.job()).status,'STOPPING');
 const before=(await f.evidence()).ledger.state;
 const answers=await Promise.all([f.runtime.io.completeProfile({...f.args,completion}),f.runtime.io.completeProfile({...f.args,completion})]);
 assert.deepEqual(answers,[{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'},{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'}]);
 const after=(await f.evidence()).ledger.state;assert.deepEqual(after.charged,before.charged);
 assert.equal(after.revision,before.revision);assert.equal(f.stats().stops,1);assert.equal(attempts,2);
});

function countCrashes(f){let crashes=0;const transition=f.ledger.transition.bind(f.ledger);
 f.ledger.transition=async request=>{if(request.action==='crash')crashes++;return transition(request);};return ()=>crashes;}
// The synthetic unit freezes at the given counters instead of its constant 4,096 bytes, so the frozen observation latches
// the stop reason through the real ledger transition. Preparation, release and stop stay the fixture's own.
function freezeAt(f,{readBytes,writeBytes}){
 const launcher=f.runtime.io.launcher,prepare=launcher.prepare.bind(launcher);
 launcher.prepare=async request=>{
  const preparation=await prepare(request);
  return {...preparation,spawnPrepared(){
   const handle=preparation.spawnPrepared();
   return {...handle,async terminate({commit}){
    const frozen={...await handle.sample(),readBytes,writeBytes};
    await commit(frozen);
    return {stopProof:await handle.stop(),measured:true,frozenSample:frozen,postExit:'REMOVED',
     readbackEvidence:{freezer:'frozen',windowMs:2500,reads:[{readBytes,writeBytes},{readBytes,writeBytes}],fileDirty:0,
      fileWriteback:0,maxBioBytes:1310720,rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}}};
   }};
  }};
 };
}

test('settled operation that latched a stop reason is never enrolled; measured settlement and runtime stay committed',async t=>{
 // Reading exactly the compute allowance exhausts it; one byte past the total minus the cleanup reserve puts that reserve at risk.
 const readFor={
  ALLOWANCE_EXHAUSTED:io=>io.read_bytes-io.overshoot_read_bytes-io.cleanup_read_bytes,
  CLEANUP_RESERVE_AT_RISK:io=>io.read_bytes-io.cleanup_read_bytes+1
 };
 for(const reason of Object.keys(readFor))await t.test(reason,async st=>{
  const f=await fixture(st),crashes=countCrashes(f),readBytes=readFor[reason](f.claimed.contract.capacity.io);
  freezeAt(f,{readBytes,writeBytes:4096});
  const answer=await f.runtime.run(f.args);
  assert.equal(answer.status,'CANCELLED');assert.equal(answer.proof,'MEASURED_FINAL_SETTLED');
  await settledOnly(f);
  const evidence=await f.evidence(),operation=evidence.ledger.state.operations[0];
  assert.equal(operation.stop_reason,reason);assert.equal(operation.charge.read_bytes,readBytes);
  assert.deepEqual(evidence.ledger.state.charged,operation.charge);
  // A measured denial, never a crash charge: one stop, no crash transition, and the terminal runtime stays charged.
  assert.equal(crashes(),0);assert.equal(f.stats().stops,1);assert.deepEqual(f.authorityCalls,['BEGIN','FINALIZE']);
  assert.ok(evidence.job.runtime_used_ms>0);
 });
});
