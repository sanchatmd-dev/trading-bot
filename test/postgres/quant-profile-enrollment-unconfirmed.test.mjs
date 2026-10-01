import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {chargeProfileCompletionRuntime} from '../../src/postgres/quant-profile-enrollment.js';
import {createEnrollmentRuntimeFixture} from '../helpers/quant-profile-enrollment-runtime-fixture.mjs';

let admin;
before(()=>{assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});});
after(async()=>{await admin?.close();});
async function fixture(t){const f=await createEnrollmentRuntimeFixture(admin);t.after(()=>f.dispose());return f;}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function bounded(promise,label,ms=20000){let timer;
 try{return await Promise.race([promise,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}
 finally{clearTimeout(timer);}}
async function until(predicate){const end=Date.now()+15000;
 while(!await predicate()){if(Date.now()>=end)throw Error('condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}}
const coherentRead=sql=>sql.includes('LEFT JOIN public.quant_profile_enrollment_receipts')&&sql.includes('x.operation_id=$2');
function captureCompletion(f){let completion;const begin=f.scheduler.beginProfileCompletion.bind(f.scheduler);
 f.scheduler.beginProfileCompletion=async request=>{completion=await begin(request);return completion;};return ()=>completion;}
// BEGIN reads the monotonic clock inside beginProfileCompletion, right after authorizeLocked('BEGIN') starts, and every charge
// counts from that reading. The marks are that authority call and the last charge statement. No honest charge exceeds the time
// between them, while a doubled charge does once the terminal has run for a while.
function markCharge(f){const marks={},push=f.authorityCalls.push.bind(f.authorityCalls),query=f.db.query.bind(f.db);
 f.authorityCalls.push=phase=>{if(phase==='BEGIN')marks.begin=performance.now();return push(phase);};
 f.db.query=async(sql,params)=>{if(sql.startsWith('UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST'))marks.charge=performance.now();
  return query(sql,params);};
 return marks;}
function settledPayload(params){for(const value of params??[]){if(typeof value!=='string'||!value.startsWith('{'))continue;
 try{const state=JSON.parse(value);if(state.operations?.some(operation=>operation.status==='SETTLED'))return state;}catch{}}
 return null;}
// The two UNCONFIRMED exits of the terminal that leave a profile completion STOPPING with its lease token.
const EXITS={
 // The unit is reported stopped with another unit's proof, so the terminal cannot trust the stop.
 'untrusted stop':f=>{
  const launcher=f.runtime.io.launcher,prepare=launcher.prepare.bind(launcher);
  launcher.prepare=async request=>{const preparation=await prepare(request);
   return {...preparation,spawnPrepared(){const handle=preparation.spawnPrepared();
    return {...handle,async terminate(options){const outcome=await handle.terminate(options);
     return {...outcome,stopProof:{...outcome.stopProof,unitName:'robot-quant-untrusted.service'}};}};}};};
 },
 // The settlement fails after its proof is recorded and the durable readback then conflicts with the launch row.
 'settle UNCERTAIN':f=>{
  const query=f.db.query.bind(f.db);let failed=false;
  f.db.query=async(sql,params)=>{const answer=await query(sql,params);
   if(!failed&&sql.startsWith('UPDATE quant_io_ledgers')&&settledPayload(params)){failed=true;throw Error('injected after settlement SQL');}
   if(coherentRead(sql)){const rows=structuredClone(answer.rows);rows[0].launch.payload_hash='0'.repeat(64);return {...answer,rows};}
   return answer;};
 }
};

test('an UNCONFIRMED terminal charges the runtime since BEGIN once, keeps the quarantine and later charges never double it',async t=>{
 for(const kind of Object.keys(EXITS))await t.test(kind,async st=>{
  const f=await fixture(st),gate=deferred(),completion=captureCompletion(f),marks=markCharge(f);let crashes=0;
  const transition=f.ledger.transition.bind(f.ledger);
  f.ledger.transition=async request=>{if(request.action==='crash')crashes++;return transition(request);};
  f.knobs.terminalGate=gate.promise;EXITS[kind](f);
  const running=f.runtime.run(f.args);running.catch(()=>{});
  try{
   let began;
   await until(async()=>{began=await f.job();return began.stop_reason==='PROFILE_COMPLETING';});
   // The terminal waits at its gate for a known time after BEGIN, and that time is the least runtime that can be charged.
   const heldAt=performance.now();await new Promise(resolve=>setTimeout(resolve,300));
   gate.resolve();const releasedAt=performance.now(),heldMs=releasedAt-heldAt;
   await assert.rejects(bounded(running,kind),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
   const job=await f.job(),evidence=await f.evidence(),charged=job.runtime_used_ms-began.runtime_used_ms,chargedAt=marks.charge;
   // Neither cancel nor acknowledge ran: the job stays STOPPING with its token, nothing is enrolled, nothing is crash charged.
   assert.equal(job.status,'STOPPING');assert.equal(job.stop_reason,'PROFILE_COMPLETING');
   assert.equal(job.lease_token,f.claimed.lease_token);assert.equal(job.result,null);assert.equal(evidence.receipt,null);
   assert.equal(evidence.ledger.state.operations[0].status,'ACTIVE');assert.equal(crashes,0);
   // BEGIN stopped the runtime clock and offline recovery charges only RUNNING jobs, so this charge is the only one.
   assert.ok(charged>=Math.floor(heldMs),'runtime since BEGIN charged: '+charged+' ms, held '+heldMs+' ms');
   assert.ok(charged<=Math.ceil(chargedAt-marks.begin),'runtime since BEGIN charged once: '+charged+' ms');
   // A later charge for the same job and lease token is an absolute total: it adds only the time since the first charge.
   const later=await chargeProfileCompletionRuntime({db:f.db,completion:completion()}),after=performance.now();
   const stored=(await f.job()).runtime_used_ms;
   assert.equal(stored,later);assert.ok(stored>=job.runtime_used_ms);
   assert.ok(stored-job.runtime_used_ms<=Math.ceil(after-releasedAt),'later charge added '+(stored-job.runtime_used_ms)+' ms');
  }finally{gate.resolve();await running.catch(()=>{});}
 });
});
