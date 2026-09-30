import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
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
function countCrashes(f){let crashes=0;const transition=f.ledger.transition.bind(f.ledger);
 f.ledger.transition=async request=>{if(request.action==='crash')crashes++;return transition(request);};return ()=>crashes;}
// Another backend of this fixture database waits on a lock of the scheduler table (the settlement's first statement).
const schedulerWaiters=async f=>(await f.db.query(`SELECT count(*)::int n FROM pg_stat_activity
 WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
 AND query LIKE '%quant_foundation_scheduler%'`)).rows[0].n;

test('owner cancel that commits while settlement waits for the scheduler keeps measured settlement',async t=>{
 const f=await fixture(t),terminal=deferred(),entered=deferred(),hold=deferred(),crashes=countCrashes(f);
 f.knobs.terminalGate=terminal.promise;
 // The owner cancel takes the scheduler and job locks, then pauses inside its transaction at authorization.
 const authorize=f.scheduler.authorize;let gated=true;
 f.scheduler.authorize=async(...args)=>{
  if(gated&&args[2]==='CANCEL'){gated=false;entered.resolve();await hold.promise;}
  return authorize(...args);
 };
 const running=f.runtime.run(f.args);running.catch(()=>{});
 let cancelling=null;
 try{
  await until(async()=>(await f.job()).stop_reason==='PROFILE_COMPLETING');
  cancelling=f.scheduler.cancel(f.claimed.owner_id,f.claimed.job_id);cancelling.catch(()=>{});
  await bounded(entered.promise,'cancel holds the scheduler');
  terminal.resolve();
  await until(async()=>await schedulerWaiters(f)===1);
  hold.resolve();
  const cancelled=await bounded(cancelling,'owner cancel');
  assert.equal(cancelled.status,'STOPPING');assert.equal(cancelled.stop_reason,'CANCELLED');
  const answer=await bounded(running,'settlement after cancel'),evidence=await f.evidence();
  assert.equal(answer.status,'CANCELLED');assert.equal(answer.proof,'MEASURED_FINAL_SETTLED');
  assert.equal(evidence.job.status,'CANCELLED');assert.equal(evidence.job.result,null);assert.equal(evidence.receipt,null);
  assert.equal(evidence.launch.state,'STOP_PROVEN');
  const state=evidence.ledger.state;assert.equal(state.operations[0].status,'SETTLED');
  assert.equal(state.charged.read_bytes,4096);assert.equal(state.charged.write_bytes,4096);
  assert.deepEqual(state.charged,state.operations[0].charge);
  assert.equal(crashes(),0);assert.equal(f.stats().stops,1);
 }finally{terminal.resolve();hold.resolve();await running.catch(()=>{});await cancelling?.catch(()=>{});}
});

// Nothing is written before the settle body records its proof, so a failure there must select the ordinary
// unknown-final fallback: one crash charge, CANCELLED, no receipt, and the global slot free for the next job.
test('failure before the settlement body takes the unknown-final fallback and releases the slot',async t=>{
 for(const kind of ['connection checkout','first statement'])await t.test(kind,async st=>{
  const f=await fixture(st),terminal=deferred(),crashes=countCrashes(f);let armed=false,hits=0;
  f.knobs.terminalGate=terminal.promise;
  if(kind==='connection checkout'){
   const transaction=f.db.transaction.bind(f.db);
   f.db.transaction=async(callback,options)=>{
    if(armed&&options?.isolation==='SERIALIZABLE'){armed=false;hits++;throw Error('timeout exceeded when trying to connect');}
    return transaction(callback,options);
   };
  }else{
   // Fail the first statement inside the next SERIALIZABLE transaction (the settlement), whatever its text.
   const transaction=f.db.transaction.bind(f.db),query=f.db.query.bind(f.db);let target=false;
   f.db.transaction=async(callback,options)=>transaction(async()=>{
    if(armed&&options?.isolation==='SERIALIZABLE'){armed=false;target=true;}
    return callback();
   },options);
   f.db.query=async(sql,params)=>{
    if(target){target=false;hits++;throw Object.assign(Error('canceling statement due to lock timeout'),{code:'55P03'});}
    return query(sql,params);
   };
  }
  const running=f.runtime.run(f.args);running.catch(()=>{});
  try{
   await until(async()=>(await f.job()).stop_reason==='PROFILE_COMPLETING');
   armed=true;terminal.resolve();
   const answer=await bounded(running,kind),evidence=await f.evidence();
   assert.equal(hits,1);
   assert.equal(answer.status,'CANCELLED');assert.equal(answer.proof,'UNKNOWN_FINAL_CHARGED');
   assert.equal(evidence.job.status,'CANCELLED');assert.equal(evidence.job.result,null);assert.equal(evidence.receipt,null);
   assert.equal(evidence.launch.state,'STOP_PROVEN');
   const state=evidence.ledger.state,operation=state.operations[0];
   assert.equal(operation.status,'CRASHED');assert.deepEqual(state.charged,operation.charge);
   assert.equal(crashes(),1);assert.equal(f.stats().stops,1);
   const next=await f.scheduler.enqueue(f.claimed.owner_id,f.claimed.contract,randomUUID());
   assert.equal((await f.scheduler.claim('next-worker'))?.job_id,next.job_id);
  }finally{terminal.resolve();await running.catch(()=>{});}
 });
});
