import test,{beforeEach} from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker,classifyExecutionFault} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {config} from '../../src/config.js';

// W1: a deterministic failure of one signal delays only its own owner, for a bounded number of attempts.
// Faults are injected with beforeCommit (a plain Error is deterministic; an error carrying a SQLSTATE or network
// code is transient) and the worker clock is a fake, so no test waits on a real timer.
let adminDb,db,store,databaseName;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  adminDb=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_w1_test_'+randomUUID().replaceAll('-','');
  assert.match(databaseName,/^robot_w1_test_[a-f0-9]{32}$/);
  await adminDb.query('CREATE DATABASE '+databaseName);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:target.toString(),max:12});await db.migrate();store=new Store(db);
  await db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8')));
  await installQuantGuards(db);
});
// Every test starts with an empty queue, so an earlier test cannot leave a signal for the next one to claim.
beforeEach(async()=>{const clean=new ExecutionWorker({store,config});for(let i=0;i<50&&await clean.tick();i++);});
after(async()=>{await db?.close();if(adminDb){if(databaseName)await adminDb.query('DROP DATABASE '+databaseName);await adminDb.close();}});

const policy=(capital='100')=>({...structuredClone(config.defaultRisk),maxTradesPerDay:100,maxOpenPositions:10,blockHighVolatility:false,blockDuringNews:false,equities:{'binance-global':Number(capital)},balances:{'binance-global':Number(capital)}});
let ownerSeq=0;
// Owners are served oldest first, so each fixture owner gets an explicit, increasing created_at.
async function account(capital='100'){
  const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'});
  await store.setRisk(user.id,policy(capital));
  await db.prepare('UPDATE users SET created_at=? WHERE id=?').run(1000+ownerSeq++,user.id);
  return user;
}
const signal=(tradeId=randomUUID(),overrides={})=>normalizeSignal({trade_id:tradeId,broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'1',entry:'0.1',sl:'0.09',timestamp:Date.now(),...overrides});
async function queue(user,overrides){const s=signal(randomUUID(),overrides);await store.enqueue(user.id,s);return (await db.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(user.id,s.tradeId));}
const status=async id=>db.prepare('SELECT status,error_message FROM signals WHERE id=?').get(id);
const accounting=async userId=>{
  const count=async sql=>Number((await db.prepare(sql).get(userId)).n);
  return {cash:(await store.paperAccount(userId,'binance-global')).cash,
    journal:await count('SELECT count(*) n FROM paper_cash_journal WHERE user_id=?'),fills:await count('SELECT count(*) n FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=?'),
    funding:await count('SELECT count(*) n FROM paper_funding WHERE user_id=?'),positions:await count('SELECT count(*) n FROM ledger_positions WHERE user_id=?'),
    lots:await count('SELECT count(*) n FROM ledger_position_allocations WHERE user_id=?')};
};
const faultAudit=async userId=>db.prepare("SELECT * FROM audit WHERE user_id=? AND event='order.execution_fault' ORDER BY id").all(userId);
const outbox=async userId=>db.prepare("SELECT * FROM notification_outbox WHERE user_id=? AND subject LIKE 'Robot trade rejected%'").all(userId);
// A worker with a fake clock; returns the worker and a handle on the clock.
function harness({failing=()=>false,error=()=>new Error('injected deterministic fault'),faultPolicy,workerStore=store}={}){
  const clock={t:5_000_000};
  const worker=new ExecutionWorker({store:workerStore,config,now:()=>clock.t,faultPolicy,beforeCommit:job=>{if(failing(job))throw error(job);}});
  return {worker,clock};
}
const cycle=async worker=>{worker.run();await worker.active;};
function muteErrors(t){const lines=[];t.mock.method(console,'error',(...parts)=>{lines.push(parts.join(' '));});return lines;}

test('classification: SQLSTATE connection and transaction classes and network errors are transient; the rest are not',()=>{
  const transient=error=>classifyExecutionFault(error).transient;
  for(const code of ['08006','40001','40P01','53300','55P03','57014','57P01','58030'])assert.equal(transient(Object.assign(new Error('x'),{code})),true,code);
  for(const code of ['ECONNRESET','ETIMEDOUT','EPIPE'])assert.equal(transient(Object.assign(new Error('x'),{code})),true,code);
  assert.equal(transient(new Error('Connection terminated unexpectedly')),true);
  assert.equal(transient(new Error('timeout exceeded when trying to connect')),true);
  for(const code of ['23505','22003','22P02'])assert.equal(transient(Object.assign(new Error('x'),{code})),false,code);
  // Code, schema, privilege and server faults are not transient either, but they are never about the signal.
  for(const code of ['42P01','42703','42501','28000','3D000','3F000','0A000','25P02','XX000']){
    assert.deepEqual(classifyExecutionFault(Object.assign(new Error('x'),{code})),{transient:false,sqlstate:code,faultClass:'ENVIRONMENT'},code);
  }
  for(const code of ['23505','22003','22P02'])assert.equal(classifyExecutionFault(Object.assign(new Error('x'),{code})).faultClass,'OTHER',code);
  // Bridge rejection codes are plain strings, several start with E, and none is a network error.
  for(const code of ['EXECUTION_PRICE_MISMATCH','EVIDENCE_REFERENCE_REQUIRED','ALLOCATION_MAPPING_MISSING'])assert.equal(transient(Object.assign(new Error(code),{code})),false,code);
  assert.equal(transient(new Error('Fill exceeds tracked position')),false);
  assert.deepEqual(classifyExecutionFault(new Error('Maximum decimal scale is 18')),{transient:false,sqlstate:null,faultClass:'DECIMAL_SCALE'});
  assert.equal(classifyExecutionFault(new Error('Fill exceeds tracked position')).faultClass,'LEDGER');
  assert.equal(classifyExecutionFault(new Error('Target allocation not found or already closed')).faultClass,'LEDGER');
  assert.equal(classifyExecutionFault(Object.assign(new Error('BRIDGE_NOT_READY'),{code:'BRIDGE_NOT_READY'})).faultClass,'BRIDGE');
  assert.equal(classifyExecutionFault(Object.assign(new Error('dup'),{code:'23505'})).sqlstate,'23505');
  assert.equal(classifyExecutionFault(new Error('anything else')).faultClass,'OTHER');
});

test('W-T1 isolation: a failing signal of the oldest owner does not delay another owner',async t=>{
  muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  const {worker}=harness({failing:job=>job.id===signalA.id});
  await cycle(worker);
  assert.equal((await status(signalA.id)).status,'QUEUED');assert.equal((await status(signalB.id)).status,'QUEUED');
  assert.equal(worker.faults.get(signalA.id).count,1);
  await cycle(worker); // A is inside its backoff window, so B is the next claim
  assert.equal((await status(signalB.id)).status,'FILLED');assert.equal((await status(signalA.id)).status,'QUEUED');
  assert.equal(worker.faults.get(signalA.id).count,1,'a quarantined owner is not retried inside its backoff window');
  await cycle(worker);await cycle(worker); // idle cycles: only the quarantined owner has work
  assert.equal(worker.faults.get(signalA.id).count,1);assert.equal((await status(signalA.id)).status,'QUEUED');
});

test('W-T2 terminal: after the bound the signal is REJECTED with a reason, one audit row and one notification; accounting is untouched',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),laterA=await queue(a),signalB=await queue(b);
  const before=await accounting(a.id);
  const {worker,clock}=harness({failing:job=>job.id===signalA.id});
  await cycle(worker);                    // attempt 1 fails, A isolated for 1 s
  await cycle(worker);                    // B fills meanwhile
  assert.equal((await status(signalB.id)).status,'FILLED');
  clock.t+=999;await cycle(worker);       // still inside the 1 s window: no attempt
  assert.equal(worker.faults.get(signalA.id).count,1);
  clock.t+=1;await cycle(worker);         // attempt 2 fails, A isolated for 5 s
  assert.equal(worker.faults.get(signalA.id).count,2);
  assert.equal((await status(laterA.id)).status,'QUEUED','per-owner order: the later signal waits behind the failing one');
  clock.t+=4999;await cycle(worker);assert.equal(worker.faults.get(signalA.id).count,2);
  clock.t+=1;await cycle(worker);         // attempt 3 fails: terminal
  assert.deepEqual(await status(signalA.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal(worker.faults.size,0);assert.equal(worker.quarantine.size,0);
  const audit=await faultAudit(a.id);assert.equal(audit.length,1);
  assert.deepEqual(JSON.parse(audit[0].details),{signalId:signalA.id,attempts:3,faultClass:'OTHER',sqlstate:null});
  const mails=await outbox(a.id);assert.equal(mails.length,1);assert.equal(mails[0].body,'EXECUTION_FAULT: OTHER');
  assert.deepEqual(await accounting(a.id),before,'the terminal write books no cash, fill, lot or funding row');
  assert.equal(lines.filter(line=>line.includes('signal='+signalA.id+' ')).length,3);
  await cycle(worker);                    // the owner's next signal now runs in id order
  assert.equal((await status(laterA.id)).status,'FILLED');
  assert.equal((await accounting(a.id)).journal,before.journal+1);
});

// A Pine Bridge signal with its deployment rows and a QUEUED Bridge event row.
async function bridgedSignal(owner){
  const now=Date.now(),importId='imp-'+randomUUID(),deploymentId='dep-'+randomUUID(),eventId=deploymentId+':'+now+':0:BUY';
  await db.prepare('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(importId,owner.id,owner.id,1,'h','fixture','//@version=6',JSON.stringify({}),now);
  await db.prepare('INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(deploymentId,owner.id,owner.id,importId,1,JSON.stringify({}),'h','READY',now);
  const bridged=signal(randomUUID());
  bridged.bridge={deployment_id:deploymentId,event_id:eventId,entry_ref:deploymentId+':'+now+':0',bar_time:now,event_type:'BUY',reason:null,market_hash:'m',evidence_hash:'e',signal_close:'100',signal_atr14:'5'};
  assert.equal(await store.enqueue(owner.id,bridged),true);
  const row=await db.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(owner.id,bridged.tradeId);
  await db.prepare('INSERT INTO pine_bridge_events(deployment_id,event_id,event_hash,entry_ref,bar_time,payload,signal_id,outcome) VALUES(?,?,?,?,?,?,?,?)')
    .run(deploymentId,eventId,'eh',bridged.bridge.entry_ref,now,JSON.stringify({}),row.id,'QUEUED');
  return {row,deploymentId,eventId};
}
const bridgeOutcome=async ({deploymentId,eventId})=>(await db.prepare('SELECT outcome FROM pine_bridge_events WHERE deployment_id=? AND event_id=?').get(deploymentId,eventId)).outcome;

test('W-T2b Bridge: the terminal write also marks the Bridge event REJECTED',async t=>{
  muteErrors(t);
  const a=await account(),bridge=await bridgedSignal(a),{row}=bridge;
  const before=await accounting(a.id);
  const {worker,clock}=harness({failing:job=>job.id===row.id});
  for(const step of [0,1000,5000]){clock.t+=step;await cycle(worker);}
  assert.deepEqual(await status(row.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal(await bridgeOutcome(bridge),'REJECTED');
  assert.equal((await faultAudit(a.id)).length,1);assert.equal((await outbox(a.id)).length,1);
  assert.deepEqual(await accounting(a.id),before);
});

test('W-T3 transient: connection and transaction errors never count; the owner steps aside for the first window and another owner is served',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  const errors=[Object.assign(new Error('could not serialize access'),{code:'40001'}),Object.assign(new Error('terminating connection'),{code:'57P01'}),
    Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'}),Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'}),new Error('Connection terminated unexpectedly')];
  let remaining=15;
  const {worker,clock}=harness({failing:job=>job.id===signalA.id&&remaining-->0,error:()=>errors[remaining%errors.length]});
  const start=clock.t;
  await cycle(worker);
  assert.equal(worker.faults.size,0);assert.equal(worker.quarantine.get(a.id),start+1000);
  await cycle(worker); // a persistent transient fault on the oldest owner does not hold the next owner back
  assert.equal((await status(signalB.id)).status,'FILLED');assert.equal((await status(signalA.id)).status,'QUEUED');
  for(let i=0;i<14;i++){clock.t+=1000;await cycle(worker);assert.equal(worker.faults.size,0);assert.equal((await status(signalA.id)).status,'QUEUED');}
  assert.equal(remaining,0);
  assert.ok(lines.length===15&&lines.every(line=>line.includes('transient=true')&&!line.includes('attempt=')),'every line is marked transient and uncounted');
  clock.t+=1000;await cycle(worker);assert.equal((await status(signalA.id)).status,'FILLED');
  assert.equal(worker.quarantine.size,0);
});

test('a deterministic-looking error is transient when the pool no longer answers',async t=>{
  muteErrors(t);
  const a=await account(),signalA=await queue(a);
  let fail=true;
  const {worker}=harness({failing:job=>job.id===signalA.id&&fail});
  worker.poolResponds=async()=>false;
  for(let i=0;i<5;i++)await cycle(worker);
  assert.equal(worker.faults.size,0);assert.equal((await status(signalA.id)).status,'QUEUED');
  fail=false;await cycle(worker);assert.equal((await status(signalA.id)).status,'FILLED');
});

test('a success clears the counter and the quarantine of the signal',async t=>{
  muteErrors(t);
  const a=await account(),signalA=await queue(a);
  let fail=true;
  const {worker,clock}=harness({failing:job=>job.id===signalA.id&&fail});
  await cycle(worker);clock.t+=1000;await cycle(worker);assert.equal(worker.faults.get(signalA.id).count,2);
  fail=false;clock.t+=5000;await cycle(worker);
  assert.equal((await status(signalA.id)).status,'FILLED');assert.equal(worker.faults.size,0);assert.equal(worker.quarantine.size,0);
});

test('a success clears the counter and the quarantine even when the heartbeat write after the commit fails',async t=>{
  const lines=muteErrors(t);
  const a=await account(),signalA=await queue(a);
  let heartbeatDown=false;
  const faultyDb=Object.create(db,{prepare:{value:sql=>/worker_heartbeats/.test(sql)&&heartbeatDown?{run:async()=>{throw new Error('heartbeat fixture failure');}}:db.prepare(sql)}});
  const faulty=Object.create(store);Object.defineProperty(faulty,'db',{value:faultyDb});
  let fail=true;
  const {worker,clock}=harness({workerStore:faulty,failing:job=>job.id===signalA.id&&fail});
  await cycle(worker);clock.t+=1000;await cycle(worker);assert.equal(worker.faults.get(signalA.id).count,2);
  fail=false;heartbeatDown=true;clock.t+=5000;await cycle(worker);
  assert.equal((await status(signalA.id)).status,'FILLED','the tick committed');
  assert.ok(lines.some(line=>line.includes('message=heartbeat fixture failure')));
  assert.equal(worker.faults.size,0);assert.equal(worker.quarantine.size,0);
});

test('W-T7 environment: a schema fault on one owner is never counted or rejected and does not stop another owner',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  let broken=true;
  const {worker,clock}=harness({failing:job=>job.id===signalA.id&&broken,error:()=>Object.assign(new Error('relation "fixture_missing" does not exist'),{code:'42P01'})});
  const start=clock.t;
  await cycle(worker);
  assert.equal(worker.quarantine.get(a.id),start+5000,'the owner waits the longest backoff window');
  assert.ok(lines[0].includes('sqlstate=42P01 class=ENVIRONMENT transient=false message='));assert.ok(!lines[0].includes('attempt='));
  await cycle(worker);assert.equal((await status(signalB.id)).status,'FILLED');
  for(let i=0;i<20;i++){
    clock.t+=5000;await cycle(worker);
    assert.equal(worker.faults.size,0);assert.equal((await status(signalA.id)).status,'QUEUED');
  }
  assert.equal(lines.length,21);assert.ok(lines.every(line=>line.includes('class=ENVIRONMENT')));
  assert.equal((await faultAudit(a.id)).length,0);assert.equal((await outbox(a.id)).length,0);
  broken=false;clock.t+=5000;await cycle(worker);
  assert.equal((await status(signalA.id)).status,'FILLED','the signal runs normally once the environment is repaired');
});

test('W-T8 systemic: the same fault for two owners holds both signals QUEUED while a healthy owner fills; a single-owner fault is rejected once it stops matching',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),c=await account(),signalA=await queue(a),signalB=await queue(b);
  const bad=new Set([signalA.id,signalB.id]);
  const {worker,clock}=harness({failing:job=>bad.has(job.id)});
  for(let round=0;round<6;round++){
    const healthy=await queue(c);
    await cycle(worker);await cycle(worker); // A fails, B fails
    assert.equal(worker.suspendedKeys.has('OTHER:NONE'),true,'terminal writes are suspended while both owners fail');
    await cycle(worker); // C fills; another owner's commit does not lift the suspension
    assert.equal((await status(healthy.id)).status,'FILLED','a healthy owner is served in round '+round);
    assert.equal(worker.suspendedKeys.has('OTHER:NONE'),true,'a healthy commit leaves the suspension in place in round '+round);
    for(const id of bad)assert.equal((await status(id)).status,'QUEUED','held, not rejected, in round '+round);
    for(const id of bad)assert.ok(worker.faults.get(id).count<=3,'the count never grows past the bound');
    clock.t+=5000;
  }
  assert.equal(worker.faults.get(signalA.id).count,3);assert.equal(worker.faults.get(signalB.id).count,3);
  assert.equal((await faultAudit(a.id)).length+(await faultAudit(b.id)).length,0);
  assert.equal((await outbox(a.id)).length+(await outbox(b.id)).length,0);
  assert.ok(lines.some(line=>line.includes('systemic fault suspected key=OTHER:NONE owners=2')&&line.includes('terminal writes of this key suspended')));
  // The shared fault goes away: both signals fill, the breaker clears and nothing was rejected.
  bad.clear();
  await cycle(worker);await cycle(worker);
  assert.equal((await status(signalA.id)).status,'FILLED');assert.equal((await status(signalB.id)).status,'FILLED');
  assert.equal(worker.suspendedKeys.size,0);assert.equal(worker.faults.size,0);assert.equal(worker.systemic.size,0);
  // A fault that only one owner has still reaches REJECTED after the bound.
  const lone=await queue(a);bad.add(lone.id);
  for(const step of [0,1000,5000]){clock.t+=step;await cycle(worker);}
  assert.deepEqual(await status(lone.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal((await faultAudit(a.id)).length,1);assert.equal((await outbox(a.id)).length,1);assert.equal(worker.suspendedKeys.size,0);
});

// The breaker is scoped to the fault key: a pair held on one key never delays the terminal write of another key.
test('W-T9 per-key breaker: a lone fault of a different key reaches REJECTED while a same-key pair stays held; its terminal retry is not skipped',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),d=await account(),signalA=await queue(a),signalB=await queue(b),signalD=await queue(d);
  const {worker,clock}=harness({failing:()=>true,error:job=>job.id===signalD.id?new Error('Maximum decimal scale is 18'):new Error('injected deterministic fault')});
  // D's first terminal write fails, so its retry has to run while the OTHER:NONE key is suspended.
  const writeFault=worker.writeFault.bind(worker);let writes=0;
  worker.writeFault=async(...args)=>{if(writes++===0)throw Object.assign(new Error('terminal fixture failure'),{code:'23505'});return writeFault(...args);};
  for(let round=0;round<3;round++){clock.t+=5000;for(let i=0;i<3;i++)await cycle(worker);} // A, B, D fail once per round
  assert.deepEqual([...worker.suspendedKeys],['OTHER:NONE'],'only the shared key is suspended');
  assert.equal(worker.faults.get(signalA.id).count,3);assert.equal(worker.faults.get(signalB.id).count,3);
  assert.equal((await status(signalD.id)).status,'QUEUED','the first terminal write of the lone fault failed');
  assert.equal(writes,1);assert.equal(worker.faults.get(signalD.id).terminalDue,clock.t+30000);
  clock.t+=30000;await cycle(worker);
  assert.equal(writes,2);
  assert.deepEqual(await status(signalD.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: DECIMAL_SCALE'});
  for(const id of [signalA.id,signalB.id])assert.equal((await status(id)).status,'QUEUED','the pair stays held');
  assert.equal((await faultAudit(a.id)).length+(await faultAudit(b.id)).length,0);
  assert.equal((await faultAudit(d.id)).length,1);assert.equal((await outbox(d.id)).length,1);
  assert.equal(lines.filter(line=>line.includes('systemic fault suspected')).length,1,'one line per key transition');
  assert.ok(!lines.some(line=>line.includes('resumed')));
});

test('W-T9b F3 audit: a suspension writes one audit row per owner in the evidence, naming only that owner\'s signal; it is written again for the next suspension',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),c=await account(),signalA=await queue(a),signalB=await queue(b);
  const bad=new Set([signalA.id,signalB.id]);
  const {worker,clock}=harness({failing:job=>bad.has(job.id)});
  const suspensions=async userId=>db.prepare("SELECT * FROM audit WHERE user_id=? AND event='worker.systemic_suspected' ORDER BY id").all(userId);
  for(let round=0;round<4;round++){await cycle(worker);await cycle(worker);clock.t+=5000;}
  assert.ok(worker.suspendedKeys.has('OTHER:NONE'));
  for(const [owner,own,other] of [[a,signalA,signalB],[b,signalB,signalA]]){
    const rows=await suspensions(owner.id);
    assert.equal(rows.length,1,'one row per owner for one suspension start, however long the hold lasts');
    assert.deepEqual(JSON.parse(rows[0].details),{key:'OTHER:NONE',ownerCount:2,signalId:own.id});
    assert.ok(!rows[0].details.includes(other.id)&&!rows[0].details.includes(other.user_id),'no data of the other owner');
    assert.equal(rows[0].trade_id,null);
  }
  assert.equal((await suspensions(c.id)).length,0);
  assert.equal((await status(signalA.id)).status,'QUEUED');assert.equal((await status(signalB.id)).status,'QUEUED');
  assert.equal((await outbox(a.id)).length+(await outbox(b.id)).length,0,'no notification');
  // Both commit: the key resumes. The same shared fault later starts a second suspension with new rows.
  bad.clear();await cycle(worker);await cycle(worker);
  assert.equal(worker.suspendedKeys.size,0);
  assert.equal(lines.filter(line=>line.includes('terminal writes resumed key=OTHER:NONE')).length,1);
  const again=[await queue(a),await queue(b)];again.forEach(row=>bad.add(row.id));
  for(let round=0;round<2;round++){clock.t+=5000;await cycle(worker);await cycle(worker);}
  assert.ok(worker.suspendedKeys.has('OTHER:NONE'));
  assert.equal((await suspensions(a.id)).length,2);assert.equal((await suspensions(b.id)).length,2);
  assert.equal(JSON.parse((await suspensions(a.id))[1].details).signalId,again[0].id);
  assert.equal(lines.filter(line=>line.includes('systemic fault suspected')).length,2);
});

test('a failing audit write for a suspension is logged and never breaks the loop',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  const faulty=Object.create(store);
  faulty.audit=async(userId,event,...rest)=>{if(event==='worker.systemic_suspected')throw new Error('audit fixture failure');return store.audit(userId,event,...rest);};
  const {worker,clock}=harness({workerStore:faulty,failing:job=>job.id===signalA.id||job.id===signalB.id});
  await cycle(worker);await cycle(worker);
  assert.ok(worker.suspendedKeys.has('OTHER:NONE'));
  assert.equal(lines.filter(line=>line.startsWith('Execution worker systemic audit write failed key=OTHER:NONE')).length,2);
  clock.t+=5000;await cycle(worker);await cycle(worker); // the loop keeps running and holding
  assert.equal(worker.faults.get(signalA.id).count,2);assert.equal(worker.faults.get(signalB.id).count,2);
  assert.equal((await status(signalA.id)).status,'QUEUED');
});

test('a suspension ends when evidence ages out of the window',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  const {worker,clock}=harness({failing:job=>job.id===signalA.id||job.id===signalB.id});
  await cycle(worker);await cycle(worker);
  assert.ok(worker.suspendedKeys.has('OTHER:NONE'));
  clock.t+=60001;worker.refreshSuspension(clock.t);
  assert.equal(worker.suspendedKeys.size,0);assert.equal(worker.systemic.size,0);
  assert.equal(lines.filter(line=>line.includes('terminal writes resumed key=OTHER:NONE')).length,1);
});

test('F4: an owner whose signal was rejected is no evidence, so one live owner is not held for it',async t=>{
  const lines=muteErrors(t);
  const x=await account(),y=await account(),signalX=await queue(x);
  const {worker,clock}=harness({failing:()=>true});
  for(const step of [0,1000,5000]){clock.t+=step;await cycle(worker);}
  assert.equal((await status(signalX.id)).status,'REJECTED');
  assert.equal(worker.systemic.size,0,'the rejected owner left the evidence');
  const signalY=await queue(y); // a different owner starts to fail 6 s later, well inside the window
  for(const step of [1000,1000,5000]){clock.t+=step;await cycle(worker);}
  assert.deepEqual(await status(signalY.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal(worker.suspendedKeys.size,0);assert.ok(!lines.some(line=>line.includes('systemic fault suspected')));
});

test('F1: on a database without the Pine Bridge schema a plain and a malformed-payload fault both reach REJECTED after the bound',async t=>{
  muteErrors(t);
  const name='robot_w1_nobridge_'+randomUUID().replaceAll('-','');
  await adminDb.query('CREATE DATABASE '+name);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+name;
  const plainDb=new PostgresDatabase({connectionString:target.toString(),max:6});
  try{
    await plainDb.migrate();const plainStore=new Store(plainDb);
    assert.equal((await plainDb.prepare("SELECT to_regclass('pine_bridge_events')::text AS name").get()).name,null,'the fixture has no Bridge table');
    const owner=await plainStore.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'});
    await plainStore.setRisk(owner.id,policy());
    const pick=async(id)=>(await plainDb.prepare('SELECT status,error_message FROM signals WHERE id=?').get(id));
    const enqueue=async()=>{const s=signal();await plainStore.enqueue(owner.id,s);return plainDb.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(owner.id,s.tradeId);};
    const run=async(failing)=>{ // a fresh worker per fault; every cycle is past any backoff
      let now=9_000_000;
      const worker=new ExecutionWorker({store:plainStore,config,now:()=>(now+=6000),beforeCommit:job=>{if(failing?.(job))throw new Error('injected deterministic fault');}});
      for(let i=0;i<4;i++)await cycle(worker);
      return worker;
    };
    const plain=await enqueue();
    const plainWorker=await run(job=>job.id===plain.id);
    assert.deepEqual(await pick(plain.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
    assert.equal(plainWorker.faults.size,0);
    const malformed=await enqueue();
    await plainDb.prepare('UPDATE signals SET payload=? WHERE id=?').run('{"broken', malformed.id);
    const malformedWorker=await run();
    assert.deepEqual(await pick(malformed.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
    assert.equal(malformedWorker.faults.size,0);
    assert.equal(Number((await plainDb.prepare("SELECT count(*) n FROM audit WHERE event='order.execution_fault'").get()).n),2);
  }finally{await plainDb.close();await adminDb.query('DROP DATABASE '+name);}
});

test('backoff and fault times count from the failure, not from the start of the cycle',async t=>{
  muteErrors(t);
  const a=await account(),signalA=await queue(a);
  const clock={t:5_000_000};
  const worker=new ExecutionWorker({store,config,now:()=>clock.t,beforeCommit:job=>{if(job.id===signalA.id){clock.t+=2000;throw new Error('slow fault');}}});
  const start=clock.t;
  await cycle(worker);
  assert.equal(worker.faults.get(signalA.id).lastAt,start+2000);
  assert.equal(worker.quarantine.get(a.id),start+2000+1000);
  clock.t=start+3000;await cycle(worker);
  assert.equal(worker.faults.get(signalA.id).count,2);assert.equal(worker.quarantine.get(a.id),start+3000+2000+5000);
  // A terminal write that fails after taking time schedules its retry from the failure.
  worker.writeFault=async()=>{clock.t+=3000;throw new Error('terminal fixture failure');};
  clock.t=start+10000;await cycle(worker);
  assert.equal(worker.faults.get(signalA.id).count,3);
  assert.equal(worker.faults.get(signalA.id).terminalDue,start+10000+2000+3000+30000);
});

test('W-T4 race: a signal filled by another worker before the terminal write stays untouched',async t=>{
  muteErrors(t);
  const a=await account(),signalA=await queue(a);
  const {worker,clock}=harness({failing:job=>job.id===signalA.id});
  const other=new ExecutionWorker({store,config}),writeFault=worker.writeFault.bind(worker);
  worker.writeFault=async(...args)=>{assert.equal(await other.tick(),true);return writeFault(...args);}; // fills between failure 3 and the terminal transaction
  await cycle(worker);clock.t+=1000;await cycle(worker);clock.t+=5000;await cycle(worker);
  assert.equal((await status(signalA.id)).status,'FILLED');assert.equal((await status(signalA.id)).error_message,null);
  assert.equal((await faultAudit(a.id)).length,0);assert.equal((await outbox(a.id)).length,0);
  assert.equal(worker.faults.size,0,'the worker forgets a signal that already left QUEUED');
});

test('a failed terminal write keeps the owner isolated, lets other owners run, and is retried',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  const {worker,clock}=harness({failing:job=>job.id===signalA.id});
  const writeFault=worker.writeFault.bind(worker);let writes=0;
  worker.writeFault=async(...args)=>{if(writes++===0)throw Object.assign(new Error('terminal fixture failure'),{code:'23505'});return writeFault(...args);};
  await cycle(worker);clock.t+=1000;await cycle(worker);clock.t+=5000;await cycle(worker);
  assert.equal(writes,1);assert.equal((await status(signalA.id)).status,'QUEUED');
  assert.ok(lines.some(line=>line.startsWith('Execution worker terminal write failed signal='+signalA.id)));
  const fault=worker.faults.get(signalA.id);assert.equal(fault.terminalDue,clock.t+30000);
  await cycle(worker);assert.equal((await status(signalB.id)).status,'FILLED','other owners run while the terminal step waits');
  assert.equal(worker.faults.get(signalA.id).count,3,'the isolated owner is not ticked again');
  clock.t+=29999;await cycle(worker);assert.equal(writes,1);
  clock.t+=1;await cycle(worker);assert.equal(writes,2);
  assert.deepEqual(await status(signalA.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal(worker.faults.size,0);assert.equal((await faultAudit(a.id)).length,1);
});

test('W-T5 DECIMAL_SCALE: an exit that cannot be priced is REJECTED after the bound and does not stall another owner',async t=>{
  muteErrors(t);
  const a=await account(),b=await account(),signalA=await queue(a),signalB=await queue(b);
  // The O3 failure is the ledger's own error text. The ledger fix is a separate change, so the throw is injected at
  // recordExecution here instead of being rebuilt from legacy lots.
  const faulty=Object.create(store);
  faulty.recordExecution=async(job,...rest)=>{if(job.id===signalA.id)throw new Error('Maximum decimal scale is 18');return store.recordExecution(job,...rest);};
  const {worker,clock}=harness({workerStore:faulty});
  await cycle(worker);await cycle(worker);
  assert.equal((await status(signalB.id)).status,'FILLED');
  clock.t+=1000;await cycle(worker);clock.t+=5000;await cycle(worker);
  assert.deepEqual(await status(signalA.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: DECIMAL_SCALE'});
  assert.equal(JSON.parse((await faultAudit(a.id))[0].details).faultClass,'DECIMAL_SCALE');
  assert.equal((await accounting(a.id)).journal,0);
});

test('a malformed payload is isolated end to end without injection; its log line quotes no payload text',async t=>{
  const lines=muteErrors(t);
  const a=await account(),b=await account(),broken=await queue(a),signalB=await queue(b);
  await db.prepare('UPDATE signals SET payload=? WHERE id=?').run('{"secret":"LEAK-'+broken.id+'", broken',broken.id);
  const worker=new ExecutionWorker({store,config,now:(()=>{let t=9_000_000;return ()=>(t+=6000);})()}); // every cycle is past any backoff
  for(let i=0;i<4;i++)await cycle(worker);
  assert.equal((await status(signalB.id)).status,'FILLED');
  assert.deepEqual(await status(broken.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.ok(lines.length>=3);
  assert.ok(lines.every(line=>!line.includes('LEAK-')&&!line.includes('secret')));
});

test('a malformed payload of a Bridge signal still closes its Bridge event as REJECTED',async t=>{
  muteErrors(t);
  const a=await account(),bridge=await bridgedSignal(a),{row}=bridge,before=await accounting(a.id);
  await db.prepare('UPDATE signals SET payload=? WHERE id=?').run('{"bridge": broken',row.id);
  const worker=new ExecutionWorker({store,config,now:(()=>{let t=9_000_000;return ()=>(t+=6000);})()}); // every cycle is past any backoff
  for(let i=0;i<3;i++)await cycle(worker);
  assert.deepEqual(await status(row.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal(await bridgeOutcome(bridge),'REJECTED');
  assert.equal((await faultAudit(a.id)).length,1);assert.deepEqual(await accounting(a.id),before);
});

test('the Bridge event fallback runs only for an unparsable payload',async t=>{
  muteErrors(t);
  const a=await account(),bridge=await bridgedSignal(a),{row}=bridge;
  // A payload that parses but carries no bridge field is not the fault the fallback exists for.
  await db.prepare('UPDATE signals SET payload=? WHERE id=?').run(JSON.stringify(signal()),row.id);
  const worker=new ExecutionWorker({store,config,now:(()=>{let t=9_000_000;return ()=>(t+=6000);})(),beforeCommit:job=>{if(job.id===row.id)throw new Error('injected deterministic fault');}});
  for(let i=0;i<3;i++)await cycle(worker);
  assert.deepEqual(await status(row.id),{status:'REJECTED',error_message:'EXECUTION_FAULT: OTHER'});
  assert.equal(await bridgeOutcome(bridge),'QUEUED');
});

test('W-T6 log hygiene: a line names signal, owner, SQLSTATE and class, never payload text or an email',async t=>{
  const lines=muteErrors(t);
  const a=await account(),signalA=await queue(a);
  const email=(await store.userById(a.id)).email;
  const {worker}=harness({failing:job=>job.id===signalA.id,error:()=>Object.assign(new Error('failed for '+email+' '+'x'.repeat(400)),{code:'23505'})});
  await cycle(worker);
  assert.equal(lines.length,1);
  const [line]=lines;
  assert.ok(line.startsWith('Execution worker transaction failed signal='+signalA.id+' owner='+a.id+' sqlstate=23505 class=OTHER transient=false attempt=1/3 message='));
  assert.ok(!line.includes(email)&&!line.includes('@'));
  assert.ok(!line.includes('BTCUSD')&&!line.includes(signalA.trade_id),'the payload is not logged');
  assert.equal(line.slice(line.indexOf('message=')+8).length,200,'the message is cut at 200 characters');
});

test('failures before a signal is claimed are logged and never counted',async t=>{
  const lines=muteErrors(t);
  const failingStore=Object.create(store);
  Object.defineProperty(failingStore,'db',{value:Object.create(db,{transaction:{value:async()=>{throw new Error('failure before any claim');}}})});
  const {worker}=harness({workerStore:failingStore});
  await cycle(worker);await cycle(worker);
  assert.equal(worker.faults.size,0);assert.equal(worker.quarantine.size,0);
  assert.equal(lines.length,2);assert.ok(lines.every(line=>line.includes('signal=NONE')&&line.includes('transient=true')));
});

test('tick() keeps its contract: a failure still throws and rolls back, and run() is a no-op while stopping',async t=>{
  muteErrors(t);
  const a=await account(),signalA=await queue(a);
  const worker=new ExecutionWorker({store,config,beforeCommit:()=>{throw new Error('fixture rollback');}});
  await assert.rejects(worker.tick(),/fixture rollback/);
  assert.equal((await status(signalA.id)).status,'QUEUED');
  await worker.stop();worker.run();assert.equal(worker.active,undefined);
  assert.equal(await new ExecutionWorker({store,config}).tick(),true);
  assert.equal((await status(signalA.id)).status,'FILLED');
});
