import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {hash} from '../../src/pine-bridge/source.js';
import {quantIoUnitName} from '../../src/postgres/quant-io-runtime.js';
import {validateProfileEnrollmentReceipt} from '../../src/quant-research/profile-contract-v2.js';
import {readProfileCompletionOutcome} from '../../src/postgres/quant-profile-enrollment.js';
import {reserveIoOperation} from '../../src/quant-research/io-budget-ledger.js';
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
// BEGIN reads the monotonic clock inside beginProfileCompletion, right after authorizeLocked('BEGIN') starts, and every charge
// counts from that reading. The marks are that authority call and the last charge statement. No honest charge exceeds the time
// between them, while a doubled charge does once the terminal has run for a while.
function markCharge(f){const marks={},push=f.authorityCalls.push.bind(f.authorityCalls),query=f.db.query.bind(f.db);
 f.authorityCalls.push=phase=>{if(phase==='BEGIN')marks.begin=performance.now();return push(phase);};
 f.db.query=async(sql,params)=>{if(sql.startsWith('UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST'))marks.charge=performance.now();
  return query(sql,params);};
 return marks;}
function captureCompletion(f){let completion;const begin=f.scheduler.beginProfileCompletion.bind(f.scheduler);
 f.scheduler.beginProfileCompletion=async request=>{completion=await begin(request);return completion;};return ()=>completion;}
function settledPayload(params){for(const value of params??[]){if(typeof value!=='string'||!value.startsWith('{'))continue;
 try{const state=JSON.parse(value);if(state.operations?.some(operation=>operation.status==='SETTLED'))return state;}catch{}}
 return null;}
const stages={
 settlement:(sql,params)=>sql.startsWith('UPDATE quant_io_ledgers')&&!!settledPayload(params),
 launch:sql=>sql.startsWith("UPDATE quant_io_launches SET state='STOP_PROVEN'"),
 receipt:sql=>sql.startsWith('INSERT INTO public.quant_profile_enrollment_receipts'),
 success:sql=>sql.startsWith("UPDATE quant_foundation_jobs SET status='SUCCEEDED'")
};
function injectAfterWrite(f,stage){let hit=false;const query=f.db.query.bind(f.db);
 f.db.query=async(sql,params)=>{const answer=await query(sql,params);
  if(!hit&&stages[stage](sql,params)){hit=true;throw Error('injected after '+stage+' SQL');}return answer;};
 return ()=>hit;
}

test('unexpected failure after each publication write rolls back all enrollment and falls back once',async t=>{
 for(const stage of Object.keys(stages))await t.test(stage,async st=>{
  const f=await fixture(st),hit=injectAfterWrite(f,stage),actions=[];
  const transition=f.ledger.transition.bind(f.ledger);
  f.ledger.transition=async request=>{actions.push(request.action);return transition(request);};
  const marks=markCharge(f),answer=await bounded(f.runtime.run(f.args),stage),evidence=await f.evidence();
  assert.equal(hit(),true);assert.equal(answer.status,'CANCELLED');assert.equal(answer.proof,'UNKNOWN_FINAL_CHARGED');
  // The rolled-back transaction charged nothing. The fallback charges the terminal runtime once (BEGIN stopped the
  // clock, so cancel and acknowledge add none): the fixture wall clock does not move, so this is the monotonic floor,
  // and it stays within the time from BEGIN to that charge. A doubled charge does not.
  assert.ok(evidence.job.runtime_used_ms>0&&evidence.job.runtime_used_ms<=Math.ceil(marks.charge-marks.begin));
  assert.equal(evidence.job.result,null);assert.equal(evidence.receipt,null);assert.equal(evidence.launch.state,'STOP_PROVEN');
  const state=evidence.ledger.state,operation=state.operations[0];assert.equal(operation.status,'CRASHED');
  assert.deepEqual(state.charged,operation.charge);
  assert.equal(actions.filter(action=>action==='crash').length,1);
  for(const direction of ['read','write'])assert.equal(operation.charge[direction+'_bytes'],
   Math.max(operation.allowance[direction+'_bytes'],operation.last.devices[0][direction+'_bytes']));
  assert.equal(f.stats().stops,1);
 });
});

test('unreadable or conflicting unknown success COMMIT readback never crash charges committed success',async t=>{
 for(const kind of ['unreadable','conflicting'])await t.test(kind,async st=>{
  const f=await fixture(st),query=f.db.query.bind(f.db);let hits=0,crashes=0;
  f.knobs.dropSuccessCommit=true;
  const transition=f.ledger.transition.bind(f.ledger);f.ledger.transition=async request=>{
   if(request.action==='crash')crashes++;return transition(request);};
  f.db.query=async(sql,params)=>{
   if(coherentRead(sql)&&kind==='unreadable'){hits++;throw Error('readback unavailable');}
   const answer=await query(sql,params);
   if(coherentRead(sql)&&kind==='conflicting'){hits++;const rows=structuredClone(answer.rows);
    rows[0].receipt.result_hash='0'.repeat(64);return {...answer,rows};}return answer;
  };
  await assert.rejects(bounded(f.runtime.run(f.args),kind),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const evidence=await f.evidence();assert.equal(hits,1);assert.equal(crashes,0);
  assert.equal(evidence.job.status,'SUCCEEDED');validateProfileEnrollmentReceipt(evidence);
  assert.equal(evidence.ledger.state.operations[0].status,'SETTLED');assert.equal(f.stats().stops,1);
 });
});

test('conflicting unresolved readback identity quarantines without fallback accounting',async t=>{
 const f=await fixture(t),hit=injectAfterWrite(f,'settlement'),query=f.db.query.bind(f.db);let crashes=0;
 const transition=f.ledger.transition.bind(f.ledger);f.ledger.transition=async request=>{
  if(request.action==='crash')crashes++;return transition(request);};
 f.db.query=async(sql,params)=>{const answer=await query(sql,params);
  if(coherentRead(sql)){const rows=structuredClone(answer.rows);rows[0].launch.payload_hash='0'.repeat(64);return {...answer,rows};}
  return answer;};
 await assert.rejects(bounded(f.runtime.run(f.args),'conflicting unresolved readback'),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
 const evidence=await f.evidence();assert.equal(hit(),true);assert.equal(crashes,0);
 assert.equal(evidence.job.status,'STOPPING');assert.equal(evidence.job.result,null);assert.equal(evidence.receipt,null);
 assert.equal(evidence.ledger.state.operations[0].status,'ACTIVE');assert.equal(evidence.ledger.state.charged.read_bytes,0);
 assert.equal(evidence.launch.state,'RELEASED');
});

test('extra unresolved launch preserves current measured settlement and the global quarantine',async t=>{
 const f=await fixture(t),gate=deferred();f.knobs.terminalGate=gate.promise;
 const running=f.runtime.run(f.args);running.catch(()=>{});
 try{
  await until(async()=>(await f.job()).stop_reason==='PROFILE_COMPLETING');
  const operationId='extra-operation-fixture',unit=quantIoUnitName(f.claimed.job_id,operationId);
  await f.db.query(`INSERT INTO quant_io_launches(job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at)
   VALUES($1,$2,$3,$4,$5,'INTENT_RECORDED',$6)`,[f.claimed.job_id,operationId,f.claimed.lease_token,unit,hash('extra-fixture'),Date.now()]);
  gate.resolve();await assert.rejects(bounded(running,'extra launch'),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const job=await f.job(),ledger=(await f.db.query('SELECT state FROM quant_io_ledgers WHERE job_id=$1',[job.job_id])).rows[0].state;
  assert.equal(job.status,'STOPPING');assert.equal(job.result,null);assert.equal(ledger.operations[0].status,'SETTLED');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_profile_enrollment_receipts')).rows[0].n,0);
  assert.equal(await f.scheduler.claim('must-stay-blocked'),null);
 }finally{gate.resolve();await running.catch(()=>{});}
});

test('wall clock reversal during terminal denies enrollment while measured accounting commits',async t=>{
 const f=await fixture(t);f.knobs.advanceTerminal=-1;
 const answer=await bounded(f.runtime.run(f.args),'clock reversal'),evidence=await f.evidence();
 assert.equal(answer.status,'CANCELLED');assert.equal(answer.proof,'MEASURED_FINAL_SETTLED');
 assert.equal(evidence.receipt,null);assert.equal(evidence.job.result,null);assert.equal(evidence.ledger.state.operations[0].status,'SETTLED');
 // The fixture wall clock never advanced before the reversal, so only the monotonic terminal runtime can be charged.
 assert.ok(evidence.job.runtime_used_ms>0,'denied terminal runtime is charged from the monotonic clock');
});

test('extra valid reserved operation retains measured settlement and prevents receipt and slot release',async t=>{
 const f=await fixture(t),settle=f.ledger.settleLocked.bind(f.ledger);
 f.ledger.settleLocked=async request=>{
  const measured=await settle(request);
  const reserved=reserveIoOperation(measured,{operation_id:'extra-reservation-fixture',lease_token:f.args.leaseToken,
   domain_id:'extra-domain-fixture',cgroup_id:'robot-quant-extra-reservation.service',
   allowance:{read_bytes:1,write_bytes:0}});
  return f.ledger.write(f.claimed.job_id,measured.revision,reserved);
 };
 await assert.rejects(bounded(f.runtime.run(f.args),'extra operation'),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
 const evidence=await f.evidence();assert.equal(evidence.job.status,'STOPPING');assert.equal(evidence.job.result,null);
 assert.equal(evidence.receipt,null);assert.equal(evidence.launch.state,'STOP_PROVEN');
 assert.deepEqual(evidence.ledger.state.operations.map(operation=>operation.status),['SETTLED','RESERVED']);
 assert.deepEqual(evidence.ledger.state.charged,evidence.ledger.state.operations[0].charge);
 assert.equal(await f.scheduler.claim('must-remain-quarantined'),null);
});

test('deadline reached during awaited FINALIZE authority vetoes publication after the await',async t=>{
 const f=await fixture(t),gate=deferred();f.knobs.authorityGate=gate.promise;
 const running=f.runtime.run(f.args);running.catch(()=>{});
 try{
  await until(()=>f.authorityCalls.includes('FINALIZE'));
  f.advanceClock(f.claimed.deadline_at-f.scheduler.clock());gate.resolve();
  const answer=await bounded(running,'deadline during authority'),evidence=await f.evidence();
  assert.equal(answer.status,'CANCELLED');assert.equal(answer.proof,'MEASURED_FINAL_SETTLED');
  assert.equal(evidence.receipt,null);assert.equal(evidence.job.result,null);
  assert.equal(evidence.ledger.state.operations[0].status,'SETTLED');
 }finally{gate.resolve();await running.catch(()=>{});}
});

test('duplicate completed enrollment rereads the exact immutable receipt without terminal work',async t=>{
 const f=await fixture(t),completion=captureCompletion(f);
 await bounded(f.runtime.run(f.args),'first enrollment');const before=await f.evidence();
 const answers=await Promise.all([f.runtime.io.completeProfile({...f.args,completion:completion()}),
  f.runtime.io.completeProfile({...f.args,completion:completion()})]);
 assert.deepEqual(answers,[{status:'SUCCEEDED',proof:'MEASURED_FINAL_SETTLED'},{status:'SUCCEEDED',proof:'MEASURED_FINAL_SETTLED'}]);
 const after=await f.evidence();assert.equal(after.receipt.receipt_hash,before.receipt.receipt_hash);
 assert.equal(after.ledger.revision,before.ledger.revision);assert.deepEqual(after.ledger.state.charged,before.ledger.state.charged);
 assert.equal(f.stats().stops,1);
});

test('completion readback waits for an outstanding singleton transaction before deciding',async t=>{
 const f=await fixture(t),completion=captureCompletion(f);await bounded(f.runtime.run(f.args),'enrollment');
 const held=deferred(),release=deferred();let transactionDone=false;
 const pending=f.db.transaction(async()=>{
  await f.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');held.resolve();await release.promise;
 }).finally(()=>{transactionDone=true;});
 await held.promise;let readDone=false;
 const reading=readProfileCompletionOutcome({db:f.db,jobId:f.claimed.job_id,completion:completion()}).then(value=>{readDone=true;return value;});
 try{
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(transactionDone,false);assert.equal(readDone,false);
  release.resolve();await bounded(pending,'outstanding transaction');
  assert.equal((await bounded(reading,'readback lock')).kind,'ENROLLED');
 }finally{release.resolve();await pending.catch(()=>{});await reading.catch(()=>{});}
});

test('changed expected terminal proof is uncertain and cannot identify a committed enrollment',async t=>{
 const f=await fixture(t),completion=captureCompletion(f);await bounded(f.runtime.run(f.args),'enrollment');
 const before=await f.evidence(),proof=structuredClone(before.ledger.state.operations[0].terminal_proof);
 proof.stop_proof_sha256='0'.repeat(64);
 const read=await readProfileCompletionOutcome({db:f.db,jobId:f.claimed.job_id,completion:completion(),expectedTerminalProof:proof});
 assert.equal(read.kind,'UNCERTAIN');const after=await f.evidence();
 assert.equal(after.receipt.receipt_hash,before.receipt.receipt_hash);assert.equal(after.ledger.revision,before.ledger.revision);
 assert.deepEqual(after.ledger.state.charged,before.ledger.state.charged);
});
