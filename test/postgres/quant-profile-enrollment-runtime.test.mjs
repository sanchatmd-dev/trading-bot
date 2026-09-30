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
