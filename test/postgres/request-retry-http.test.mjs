import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {cp} from 'node:fs/promises';
import {quantDataHttpFixture} from '../helpers/quant-data-http-fixture.mjs';
import {quantResearchHttpFixture} from '../helpers/quant-research-http-fixture.mjs';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createWorld} from '../helpers/preflight-pg-fixture.mjs';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {hashPassword,hashToken,verifyPassword} from '../../src/security.js';

// CR1: a READ COMMITTED worker that commits an update to a row a SERIALIZABLE API request then locks makes the request's
// first attempt fail with 40001. The dispatcher retries it on a fresh snapshot, so the browser gets the answer, not 409.
// Real HTTP server, real PostgreSQL; the heartbeat is the real scheduler heartbeat with its health probe held open.
function latch(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Error(label+' did not settle within 15 seconds')),15000);
})]);}finally{clearTimeout(timer);}}
// The request has taken its snapshot during authentication and now waits for a row lock the held transaction owns.
async function lockWaiter(db,label){
  for(let i=0;i<300;i++){
    const {rows:[row]}=await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if(row.n>0)return;await delay(50);
  }
  throw Error(label+': no request waited for the held lock');
}
// A scheduler whose heartbeat holds the singleton lock while its health probe waits for the test.
function heldScheduler(db){
  let gate=null;
  const scheduler=new QuantFoundationScheduler({db,authorize:async()=>({ok:true}),leaseMs:30000,
    health:async({action})=>{if(action==='HEARTBEAT'&&gate){const current=gate;gate=null;current.entered.resolve();await current.release.promise;}return {ok:true};}});
  // Runs send() while one heartbeat holds the lock, then lets the heartbeat commit its lease update. A request that takes
  // no row lock (waits=false) must answer while the heartbeat still holds the lock.
  async function underHeartbeat(job,send,label,{waits=true}={}){
    const entered=latch(),release=latch();gate={entered,release};
    const beat=scheduler.heartbeat(job);
    await bounded(entered.promise,label+' heartbeat');
    const answer=send();
    try{if(waits)await lockWaiter(db,label);else await bounded(answer,label+' request');}finally{release.resolve();}
    const renewed=await bounded(beat,label+' heartbeat commit');
    return {answer:await bounded(answer,label+' request'),renewed};
  }
  return {scheduler,underHeartbeat};
}
const errors=async db=>(await db.query("SELECT count(*)::int n FROM audit WHERE event='request.error'")).rows[0].n;
const audits=async(db,event,id)=>(await db.query('SELECT count(*)::int n FROM audit WHERE event=$1 AND trade_id=$2',[event,id])).rows[0].n;
const foundation=async(db,id)=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];

// Attempt count, in process: the dispatcher logs one line per retry before it pauses. This preload, loaded into the forked
// server through NODE_OPTIONS, copies those lines to a file the test reads, so each count is exact and already written when
// the answer arrives. Database statistics are no substitute: a backend reports its counts late and can merge two attempts.
const PRELOAD='--import=data:text/javascript;base64,'+Buffer.from([
  "import {appendFileSync} from 'node:fs';",
  'const file=process.env.CR1_RETRY_LOG,warn=console.warn;',
  "console.warn=(...args)=>{if(file&&typeof args[0]==='string'&&args[0].startsWith('API request attempt '))appendFileSync(file,args[0]+'\\n');return warn.apply(console,args);};"
].join('\n')).toString('base64');
function retryLog(t){
  const file=path.join(os.tmpdir(),'cr1-retry-'+randomUUID()+'.log');
  fs.writeFileSync(file,'');t.after(()=>fs.rmSync(file,{force:true}));
  const lines=()=>fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
  let seen=0;
  return {
    // For a fixture that takes an explicit server environment.
    environment:{NODE_OPTIONS:PRELOAD,CR1_RETRY_LOG:file},
    // For a fixture that forks with the test's own environment: the preload is in process.env only while it starts.
    async inherit(start){
      const saved={NODE_OPTIONS:process.env.NODE_OPTIONS,CR1_RETRY_LOG:process.env.CR1_RETRY_LOG};
      process.env.NODE_OPTIONS=[saved.NODE_OPTIONS,PRELOAD].filter(Boolean).join(' ');process.env.CR1_RETRY_LOG=file;
      try{return await start();}
      finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
    },
    skip(){seen=lines().length;},
    // Exactly `count` retries since the last check, each after a 40001 on the attempt before it.
    expect(count,label){
      const fresh=lines().slice(seen);seen+=fresh.length;
      assert.deepEqual(fresh,Array.from({length:count},(_,i)=>`API request attempt ${i+1} rolled back with SQLSTATE 40001; retrying`),label+': retries');
    }
  };
}

test('data job GET and cancel under a committing heartbeat answer 200 instead of RETRY_TRANSACTION',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const log=retryLog(t);
  const f=await log.inherit(()=>quantDataHttpFixture(process.env.TEST_DATABASE_URL));t.after(f.close);
  const session=(await f.request('/api/auth/login','POST',{email:f.user.email,password:f.password})).session;
  const end=Math.floor(Date.now()/60000)*60000;
  const preview=await f.request('/api/quant/data/range-preview?bot_id='+f.user.id,'POST',{bot_id:f.user.id,start_time:end-120*60000,end_time:end,warmup_bars:20},session);
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  const queued=await f.request('/api/quant/data/jobs','POST',preview.body.request,session,{'Idempotency-Key':randomUUID()});
  assert.equal(queued.status,202,JSON.stringify(queued.body));
  const {scheduler,underHeartbeat}=heldScheduler(f.db),job=await scheduler.claim('cr1-worker');
  assert.equal(job?.job_id,queued.body.job_id);
  // Control: one SERIALIZABLE attempt with the request's shape fails under the same hold. This is the 409 the retry removes.
  const client=await f.db.pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query('SELECT count(*) FROM sessions');
    const control=await underHeartbeat(job,async()=>{
      await client.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
      return client.query('SELECT job_id FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[job.job_id]);
    },'control').then(()=>null,error=>error);
    assert.equal(control?.code,'40001','the held heartbeat produces the serialization failure');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  log.skip();
  const route='/api/quant/data/jobs/'+job.job_id;
  const status=await underHeartbeat(job,()=>f.request(route+'?bot_id='+f.user.id,'GET',undefined,session),'data GET');
  assert.equal(status.answer.status,200,JSON.stringify(status.answer.body));assert.equal(status.answer.body.status,'RUNNING');
  log.expect(1,'data GET');
  const cancel=await underHeartbeat(job,()=>f.request(route+'/cancel','POST',{},session),'data cancel');
  assert.equal(cancel.answer.status,200,JSON.stringify(cancel.answer.body));assert.equal(cancel.answer.body.status,'STOPPING');
  log.expect(1,'data cancel');
  const row=await foundation(f.db,job.job_id);
  assert.equal(row.status,'STOPPING');assert.equal(row.stop_reason,'CANCELLED');assert.equal(row.lease_until,null,'the cancel ran on the heartbeat\'s committed row');
  assert.equal(await errors(f.db),0,'no request.error row: every request succeeded on a retry');
});

test('Pine Bridge job GET and cancel under a committing row update answer 200 with one cancel audit row',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const log=retryLog(t);
  const f=await log.inherit(()=>quantDataHttpFixture(process.env.TEST_DATABASE_URL));t.after(f.close);
  const session=(await f.request('/api/auth/login','POST',{email:f.user.email,password:f.password})).session;
  const service=new PineBridgeService(f.store,{getProvider:()=>({provider:'fixture',model:'fixture',inputRate:.1,outputRate:.2,rateVersion:'fixture-v1'})});
  const source='//@version=6\nindicator("Fixture")\nlength=input.int(10, minval=1, maxval=20)\nbuy=ta.crossover(close,ta.ema(close,length))\nsell=ta.crossunder(close,ta.ema(close,length))';
  const job=await f.db.transaction(()=>service.enqueue(f.user.id,'analyze',{bot_id:f.user.id,pine_source:source,source_name:'Fixture'},randomUUID()));
  const id=job.job_id,route='/api/quant/pine-bridge/jobs/'+id;
  // Stands in for the Pine Bridge worker pulse: a READ COMMITTED update of the job row, held open while the request waits.
  async function underUpdate(send,label){
    const client=await f.db.pool.connect();
    try{
      await client.query('BEGIN');await client.query('UPDATE pine_bridge_jobs SET updated_at=updated_at+1 WHERE job_id=$1',[id]);
      const answer=send();
      try{await lockWaiter(f.db,label);}finally{await client.query('COMMIT');}
      return await bounded(answer,label+' request');
    }finally{client.release();}
  }
  log.skip();
  const status=await underUpdate(()=>f.request(route,'GET',undefined,session),'pine GET');
  assert.equal(status.status,200,JSON.stringify(status.body));assert.equal(status.body.job_status,'QUEUED');
  log.expect(1,'pine GET');
  const cancel=await underUpdate(()=>f.request(route+'/cancel','POST',{},session),'pine cancel');
  assert.equal(cancel.status,200,JSON.stringify(cancel.body));assert.equal(cancel.body.job_status,'CANCELLED');
  log.expect(1,'pine cancel');
  assert.equal(await audits(f.db,'pine_bridge.cancelled',id),1,'one cancel audit row: the rolled-back attempt left none');
  assert.equal(await errors(f.db),0);
});

test('research job GET and cancel under a committing heartbeat answer 200, STOPPING and one cancel audit row',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const log=retryLog(t);
  const f=await log.inherit(()=>quantResearchHttpFixture(process.env.TEST_DATABASE_URL));t.after(()=>f.close());
  const M=f.minute,start=Math.floor(Date.now()/M)*M-20000*M;
  await f.seedBars({start,count:3250});
  const owner=await f.newOwner(),session=await owner.login();
  const queued=await f.enqueue(owner,session,f.researchBody(owner,{start}));
  assert.equal(queued.status,202,JSON.stringify(queued.body));
  const runId=queued.body.run_id;
  const {scheduler,underHeartbeat}=heldScheduler(f.db),job=await scheduler.claim('cr1-worker');
  assert.ok(job,'the research foundation job is claimed');
  const route='/api/quant/research/jobs/'+runId;
  log.skip();
  const status=await underHeartbeat(job,()=>f.request(route,'GET',undefined,session),'research GET');
  assert.equal(status.answer.status,200,JSON.stringify(status.answer.body));
  // The GET waits only on the scheduler lock, which the heartbeat takes but never updates, so it answers on its first attempt.
  log.expect(0,'research GET');
  const cancel=await underHeartbeat(job,()=>f.request(route+'/cancel','POST',{},session),'research cancel');
  assert.equal(cancel.answer.status,200,JSON.stringify(cancel.answer.body));
  // The cancel updates the foundation job row the heartbeat committed.
  log.expect(1,'research cancel');
  assert.equal((await foundation(f.db,job.job_id)).status,'STOPPING');
  assert.equal(await audits(f.db,'quant.research.cancelled',runId),1);
  assert.equal(await errors(f.db),0);
});

test('preflight job GET and cancel under a committing heartbeat answer 200, STOPPING and one cancel audit row',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const log=retryLog(t);
  const base=await createPf2Base(t),scenario=base.defaultScenario;
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'test-policy',capacityPolicy:scenario.enrollment.capacity_policy,
    syntheticSourceHash:scenario.supportedSourceHash,environment:log.environment});
  t.after(()=>f.close());
  await cp(base.root,f.root,{recursive:true});
  const world=await createWorld({...f,base},{accounts:{owner:f.owner.id,bot:f.owner.id,bots:[f.owner.id]}});
  const session=await f.login(f.owner);
  const queued=await f.request('/api/quant/data/preflights','POST',world.request,session,{'Idempotency-Key':'cr1-'+randomUUID()});
  assert.equal(queued.status,202,JSON.stringify(queued.body));
  const {scheduler,underHeartbeat}=heldScheduler(f.db),job=await scheduler.claim('cr1-worker');
  assert.equal(job?.job_id,queued.body.job_id);
  const route='/api/quant/data/preflights/'+job.job_id;
  log.skip();
  // The preflight status read takes no row lock (the precedent in the audit), so it answers while the heartbeat holds the lock.
  const status=await underHeartbeat(job,()=>f.request(route,'GET',undefined,session),'preflight GET',{waits:false});
  assert.equal(status.answer.status,200,JSON.stringify(status.answer.body));
  log.expect(0,'preflight GET');
  const cancel=await underHeartbeat(job,()=>f.request(route+'/cancel','POST',{},session),'preflight cancel');
  assert.equal(cancel.answer.status,200,JSON.stringify(cancel.answer.body));assert.equal(cancel.answer.body.status,'STOPPING');
  log.expect(1,'preflight cancel');
  assert.equal((await foundation(f.db,job.job_id)).status,'STOPPING');
  assert.equal(await audits(f.db,'quant.preflight.cancelled',job.job_id),1);
  assert.equal(await errors(f.db),0);
});

test('a password change under a committing users-row update is retried and counts once in its limiter bucket',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const log=retryLog(t);
  const f=await log.inherit(()=>quantDataHttpFixture(process.env.TEST_DATABASE_URL));t.after(f.close);
  // A plain USER: no two-factor enrollment stands between the session and the password route.
  const password=randomUUID()+'-old',newPassword=randomUUID()+'-new';
  const user=await f.store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password),role:'USER'});
  const login=await f.request('/api/auth/login','POST',{email:user.email,password});
  assert.equal(login.status,200,JSON.stringify(login.body));
  log.skip();
  // Stands in for a worker's users-row update: the request reads its snapshot, then waits on the row lock in setPassword.
  const client=await f.db.pool.connect();let answer;
  try{
    await client.query('BEGIN');await client.query('UPDATE users SET label=label WHERE id=$1',[user.id]);
    const sent=f.request('/api/me/password','POST',{currentPassword:password,newPassword},login.session);
    try{await lockWaiter(f.db,'password change');}finally{await client.query('COMMIT');}
    answer=await bounded(sent,'password change request');
  }finally{client.release();}
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  log.expect(1,'password change');
  const bucket=await f.db.query('SELECT attempts FROM security_limits WHERE key_hash=$1',[hashToken('password-change:'+user.id)]);
  assert.equal(Number(bucket.rows[0]?.attempts),1,'one limiter count for one request');
  const saved=await f.db.query('SELECT password_hash FROM users WHERE id=$1',[user.id]);
  assert.ok(await verifyPassword(newPassword,saved.rows[0].password_hash),'the retried attempt committed the new password');
  assert.equal(await errors(f.db),0);
});
