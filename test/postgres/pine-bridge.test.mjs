import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {PineBridgeWorker} from '../../src/postgres/pine-bridge-worker.js';
import {receiveBridge} from '../../src/postgres/pine-bridge-receiver.js';
import {config} from '../../src/config.js';
import {fail} from '../../src/pine-bridge/source.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {activateDeployment,validateEvidence} from '../../src/postgres/pine-bridge-readiness.js';
import {setMembership} from '../../src/postgres/pine-bridge-registry.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {encryptJson} from '../../src/security.js';
import {hashPassword} from '../../src/security.js';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {httpClient} from '../helpers.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';

let admin,db,store,service,databaseName;
const source='//@version=6\nindicator("Fixture")\nlength=input.int(10, minval=1, maxval=20)\nbuy=ta.crossover(close,ta.ema(close,length))\nsell=ta.crossunder(close,ta.ema(close,length))';
const getProvider=()=>({provider:'fixture',model:'fixture',inputRate:.1,outputRate:.2,rateVersion:'fixture-v1'});
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_bridge_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
  const migration=await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8');
  // Rehearse failed migration rollback before applying the extension.
  await assert.rejects(db.transaction(async()=>{await db.query(migration);throw new Error('rollback rehearsal');}));
  assert.equal((await db.query("SELECT to_regclass('public.pine_sources') present")).rows[0].present,null);
  await db.transaction(()=>db.query(migration));store=new Store(db);service=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider});
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});
async function owner(){const row=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'});await store.setRisk(row.id,structuredClone(config.defaultRisk));return row.id;}
const enqueue=(id,operation,body,key=randomUUID())=>db.transaction(()=>service.enqueue(id,operation,body,key));
const analyze=(id,key)=>enqueue(id,'analyze',{bot_id:id,pine_source:source,source_name:'Fixture'},key);
function provider(callback){return {run:async request=>{if(callback)return callback(request);return {value:{buy:'buy',exit:'sell',diagnostics:[],...(request.operation==='analyze'?{eligible_inputs:request.analysis.inputs.map(i=>i.input_id)}:{})},usage:{input_tokens:50,output_tokens:30,cost_usd:.000011},request_id:'fixture'};}};}
async function runAll(p=provider()){const worker=new PineBridgeWorker({service,provider:p});for(let i=0;i<30&&await worker.tick();i++);}

test('extension migration preserves base schema and scoped registry rejects foreign owners',async()=>{
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14);
  const a=await owner(),b=await owner(),job=await analyze(a);
  await assert.rejects(db.transaction(()=>service.get(b,job.job_id)),{code:'NOT_FOUND'});
  await assert.rejects(enqueue(b,'analyze',{bot_id:a,pine_source:source,source_name:'foreign'}),{code:'NOT_FOUND'});
  await assert.rejects(service.source(b,a,job.pine_import_id,1),{code:'NOT_FOUND'});
  await runAll();
});
test('same idempotency key creates one job; different input conflicts and queue is bounded',async()=>{
  const a=await owner(),key=randomUUID();
  const jobs=await Promise.all(Array.from({length:6},()=>analyze(a,key)));
  assert.equal(new Set(jobs.map(j=>j.job_id)).size,1);
  await assert.rejects(enqueue(a,'analyze',{bot_id:a,pine_source:source+'\n',source_name:'Fixture'},key),{code:'IDEMPOTENCY_CONFLICT'});
  await analyze(a);await assert.rejects(analyze(a),{code:'AI_QUEUE_FULL'});await runAll();
});
test('strategy fails before provider configuration or source registration',async()=>{
  const a=await owner();const offline=new PineBridgeService(store,{getProvider:()=>{throw new Error('must not consult provider');}});
  await assert.rejects(db.transaction(()=>offline.enqueue(a,'analyze',{bot_id:a,pine_source:source.replace('indicator(', 'strategy('),source_name:'bad'},randomUUID())),{code:'INDICATOR_REQUIRED'});
  assert.equal((await db.prepare('SELECT count(*) n FROM pine_sources WHERE owner_id=?').get(a)).n,0);
});
test('durable analysis/generation produces draft and immutable server snapshot atomically',async()=>{
  const a=await owner(),job=await analyze(a);await runAll();
  const analyzed=await db.transaction(()=>service.get(a,job.job_id));assert.equal(analyzed.job_status,'SUCCEEDED');
  const input=analyzed.result.inputs[0];
  const generated=await enqueue(a,'generate',{bot_id:a,pine_import_id:job.pine_import_id,source_version:1,selected_signals:{buy:'buy',exit:'sell',timing:'bar_close'},parameter_slots:[{slot:3,input_id:input.input_id,min:5,max:20,step:1}],bridge_options:{atr_multiplier:2,rr:1.5},market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'}});
  await runAll();const done=await db.transaction(()=>service.get(a,generated.job_id));assert.equal(done.job_status,'SUCCEEDED');
  assert.equal(done.result.integrated_pine.slice(0,source.length),source);
  const deployment=await db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id);
  assert.equal(deployment.state,'DRAFT');assert.equal(deployment.snapshot.selection.bridge.rr,1.5);
  assert.equal((await db.prepare('SELECT count(*) n FROM signals WHERE user_id=?').get(a)).n,0);
  const bar=Date.now(),ref=deployment.deployment_id+':'+bar+':0';
  const event={schema_version:'bridge-exit-v1',...deployment.snapshot.market,event_id:ref+':BUY',event_type:'BUY',entry_ref:ref,bar_time:bar,sequence:0,close:100,atr:1};
  // Authenticate with a fixture-only facade; storage and authorization use real DB.
  const facade=Object.create(store);facade.userByWebhook=async()=>store.userById(a);
  await assert.rejects(receiveBridge(facade,'fixture',event),{code:'BRIDGE_NOT_READY'});
});
test('queued cancellation avoids dispatch and running cancellation discards late draft but accounts usage',async()=>{
  const a=await owner(),queued=await analyze(a);await db.transaction(()=>service.get(a,queued.job_id,true));
  let calls=0;await runAll(provider(()=>{calls++;throw new Error('unexpected');}));assert.equal(calls,0);
  const running=await analyze(a);let release,started;
  const dispatched=new Promise(r=>started=r),wait=new Promise(r=>release=r);
  const worker=new PineBridgeWorker({service,provider:provider(async request=>{started();await wait;return provider().run(request);})});
  const tick=worker.tick();await dispatched;await db.transaction(()=>service.get(a,running.job_id,true));release();await tick;
  const done=await db.transaction(()=>service.get(a,running.job_id));assert.equal(done.job_status,'CANCELLED');assert.equal(done.result,null);assert.equal(done.usage.length,1);
});
test('expired lease becomes outcome unknown with no resend; overdue queue times out',async()=>{
  const a=await owner(),job=await analyze(a),worker=new PineBridgeWorker({service,provider:provider()});
  await worker.claim();await db.prepare('UPDATE pine_bridge_jobs SET lease_until=0 WHERE job_id=?').run(job.job_id);
  await worker.tick();assert.equal((await db.transaction(()=>service.get(a,job.job_id))).job_status,'OUTCOME_UNKNOWN');
  const overdue=await analyze(a);await db.prepare('UPDATE pine_bridge_jobs SET deadline=0 WHERE job_id=?').run(overdue.job_id);await worker.tick();
  assert.equal((await db.transaction(()=>service.get(a,overdue.job_id))).job_status,'TIMED_OUT');
});
test('explicit 429 gets at most two attempts; unknown outcomes and invalid outputs never retry',async()=>{
  const a=await owner(),job=await analyze(a),worker=new PineBridgeWorker({service,provider:provider(()=>{throw Object.assign(fail('PROVIDER_RATE_LIMIT'),{retryAfter:2});})});
  await worker.tick();assert.equal((await db.transaction(()=>service.get(a,job.job_id))).job_status,'RETRY_WAIT');
  await db.prepare('UPDATE pine_bridge_jobs SET next_attempt=0 WHERE job_id=?').run(job.job_id);await worker.tick();
  const done=await db.transaction(()=>service.get(a,job.job_id));assert.equal(done.job_status,'FAILED');assert.equal(done.attempts,2);
  const unknown=await analyze(a);await new PineBridgeWorker({service,provider:provider(()=>{throw fail('OUTCOME_UNKNOWN');})}).tick();
  assert.equal((await db.transaction(()=>service.get(a,unknown.job_id))).job_status,'OUTCOME_UNKNOWN');
  const bad=await analyze(a);await new PineBridgeWorker({service,provider:provider(async request=>({...await provider().run(request),value:{buy:'injected()'}}))}).tick();
  assert.equal((await db.transaction(()=>service.get(a,bad.job_id))).job_status,'FAILED');
});

async function draft(a){
  const job=await analyze(a);await runAll();
  const generated=await enqueue(a,'generate',{bot_id:a,pine_import_id:job.pine_import_id,source_version:1,selected_signals:{buy:'buy',exit:'sell',timing:'bar_close'},parameter_slots:[],bridge_options:{atr_multiplier:2,rr:1.5},market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'}});
  await runAll();const done=await db.transaction(()=>service.get(a,generated.job_id));assert.equal(done.job_status,'SUCCEEDED');
  return db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id);
}
function evidenceFor(d){return {snapshot_hash:d.snapshot_hash,artifact_hash:d.snapshot.artifact_hash,source_hash:d.snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:10,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},references:{tradingview:'fixture-only-not-real-compilation',source_review:'fixture-only-source-review',paper_fixture:'fixture-only-gate-validation'}};}
async function ready(a,{capital=1000,maxOrder=10000}={}){
  await store.setRisk(a,{...structuredClone(config.defaultRisk),maxRiskPercent:2,maxDailyLossR:1000,pauseAfterLossStreak:100,maxOrderNotional:maxOrder,maxDailyNotional:1e7,maxTradesPerDay:10000,onePositionPerSymbol:false,blockHighVolatility:false,blockDuringNews:false,maxSignalAgeSeconds:3600,equities:{'binance-global':capital},balances:{'binance-global':capital},capPercentEquitySize:true});
  const d=await draft(a),e=evidenceFor(d);validateEvidence(e,d.snapshot_hash);
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(d.deployment_id,d.snapshot_hash,JSON.stringify(e),hash(canonical(e)),Date.now());
  await db.transaction(()=>activateDeployment(service,a,d.deployment_id));
  const secret=randomUUID();await store.setWebhookSecret(a,secret,encryptJson({secret},config.keyring,'webhook:'+a));
  return {d,secret,e};
}
async function market(time,{close=100,high=101,low=99,atr=5}={}){
  const bar={time,open:String(close),high:String(high),low:String(low),close:String(close),volume:'100',atr14:String(atr),price_tick:'0.01',quantity_step:'0.001'};
  await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run('binance-global','BTCUSDT','1D',time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'isolated fixture'}),hash(canonical(bar)));
}
function event(d,time,{type='BUY',entryTime=time,reason='NATIVE'}={}) {
  const ref=d.deployment_id+':'+entryTime+':0';
  return {schema_version:'bridge-exit-v1',...d.snapshot.market,event_id:type==='BUY'?ref+':BUY':ref+':'+time+':EXIT',event_type:type,entry_ref:ref,bar_time:time,sequence:0,...(type==='BUY'?{close:100,atr:5}:{reason})};
}
async function execute(){const worker=new ExecutionWorker({store,config});for(let i=0;i<200&&(await store.health()).queued;i++)await worker.tick();}

test('Bridge accepted fill maps one allocation; retries and scoped exits cannot affect another Bot',async()=>{
  const a=await owner(),b=await owner(),x=await ready(a),y=await ready(b),time=Date.now()-5000;
  await market(time);const buy=event(x.d,time);
  const responses=await Promise.all(Array.from({length:5},()=>receiveBridge(store,x.secret,buy)));
  assert.equal(responses.filter(r=>!r.duplicate).length,1);
  await receiveBridge(store,y.secret,event(y.d,time));await execute();
  assert.equal((await db.prepare('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?').get(x.d.deployment_id)).n,1);
  const allocation=await db.prepare('SELECT a.* FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id WHERE e.deployment_id=?').get(x.d.deployment_id);
  assert.equal(allocation.stop_loss,'90.000000000000000000');assert.equal(allocation.take_profit,'115.000000000000000000');
  await market(time+1000,{close:88,high:120,low:85});
  const exit=event(x.d,time+1000,{type:'EXIT',entryTime:time,reason:'SL'});
  await assert.rejects(receiveBridge(store,y.secret,exit),{code:'NOT_FOUND'});
  await receiveBridge(store,x.secret,exit);await execute();
  assert.equal((await store.paperAccount(b,'binance-global')).positionCost=== '0',false);
  assert.equal((await store.paperAccount(a,'binance-global')).positionCost,'0');
  assert.equal((await receiveBridge(store,x.secret,exit)).duplicate,true);
  const fills=await db.prepare('SELECT f.* FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=? ORDER BY s.id').all(a);
  assert.equal(fills.length,2);assert.equal(Number(fills[1].price),87.91);assert.ok(Number(fills[1].fee_quote)>0);
});
test('missing/mismatched market facts, unknown targets and unreviewed readiness fail closed',async()=>{
  const a=await owner(),x=await ready(a),time=Date.now()-8000;
  await assert.rejects(receiveBridge(store,x.secret,event(x.d,time)),{code:'VERIFIED_MARKET_DATA_REQUIRED'});
  await market(time);await assert.rejects(receiveBridge(store,x.secret,{...event(x.d,time),atr:4}),{code:'MARKET_FACT_MISMATCH'});
  await receiveBridge(store,x.secret,event(x.d,time,{type:'EXIT',entryTime:time-1000}));await execute();
  assert.equal((await store.listSignals(a))[0].status,'REJECTED');assert.equal((await db.prepare('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?').get(x.d.deployment_id)).n,0);
  await db.prepare('DELETE FROM pine_bridge_evidence WHERE deployment_id=?').run(x.d.deployment_id);
  await assert.rejects(receiveBridge(store,x.secret,event(x.d,time)),{code:'BRIDGE_EXECUTION_EVIDENCE_REQUIRED'});
});

test('policy and capital changes invalidate entries; queued entries recheck snapshots',async()=>{
  const a=await owner(),x=await ready(a),time=Date.now()-9000;
  await market(time);await receiveBridge(store,x.secret,event(x.d,time));
  await store.setRisk(a,{...await store.risk(a,config.defaultRisk),maxRiskPercent:1.9});
  await execute();assert.equal((await store.listSignals(a))[0].error_message,'STALE_POLICY');
  await assert.rejects(receiveBridge(store,x.secret,event(x.d,time+1)),{code:'STALE_POLICY'});
  const b=await owner(),y=await ready(b);
  const originalPolicy=await store.risk(b,config.defaultRisk);
  await store.setRisk(b,{...originalPolicy,balances:{'binance-global':900}});
  await store.setRisk(b,originalPolicy);
  await assert.rejects(receiveBridge(store,y.secret,event(y.d,time)),{code:'STALE_CAPITAL'});
});
test('source revision/effective inputs invalidate entry routes while preserving old exits',async()=>{
  const a=await owner(),x=await ready(a),time=Date.now()-10000;
  await market(time);await receiveBridge(store,x.secret,event(x.d,time));await execute();
  const analysis=(await service.source(a,a,x.d.pine_import_id,1)).analysis;
  const changed=await enqueue(a,'analyze',{bot_id:a,pine_import_id:x.d.pine_import_id,source_version:2,pine_source:source,source_name:'Revision',effective_inputs:{[analysis.inputs[0].input_id]:12}});
  await runAll();assert.equal((await db.transaction(()=>service.get(a,changed.job_id))).job_status,'SUCCEEDED');
  assert.equal((await service.source(a,a,x.d.pine_import_id,1)).analysis.inputs[0].effective_value,10);
  assert.equal((await service.source(a,a,x.d.pine_import_id,2)).analysis.inputs[0].effective_value,12);
  assert.equal((await db.prepare('SELECT state FROM pine_deployments WHERE deployment_id=?').get(x.d.deployment_id)).state,'EXIT_ONLY');
  await market(time+1000);await assert.rejects(receiveBridge(store,x.secret,event(x.d,time+1000)),{code:'BRIDGE_NOT_READY'});
  await receiveBridge(store,x.secret,event(x.d,time+1000,{type:'EXIT',entryTime:time}));await execute();
  assert.equal((await store.paperAccount(a,'binance-global')).positionCost,'0');
  await db.transaction(()=>setMembership(service,a,x.d.pine_import_id,{bot_id:a,connected:false}));
  await assert.rejects(db.transaction(()=>activateDeployment(service,a,x.d.deployment_id)),{code:'DEPLOYMENT_REPLACED'});
});
test('reference receiver/worker fixtures cover 10 SL, 10 TP, 5 both-touched and 5 native/Bridge conflicts',async()=>{
  const cases=[...Array.from({length:10},()=>({reason:'SL',close:89,low:88,high:104})),...Array.from({length:10},()=>({reason:'TP',close:117,low:96,high:120})),...Array.from({length:5},()=>({reason:'SL',close:100,low:88,high:120})),...Array.from({length:5},()=>({reason:'SL',close:95,low:89,high:102,wrong:'NATIVE'}))];
  const a=await owner(),x=await ready(a);let time=Date.now()-120000;
  for(const c of cases) {
    time+=2000;await market(time);await receiveBridge(store,x.secret,event(x.d,time));await execute();
    await market(time+1000,c);
    if(c.wrong){
      await receiveBridge(store,x.secret,event(x.d,time+1000,{type:'EXIT',entryTime:time,reason:c.wrong}));await execute();
      assert.equal((await store.listSignals(a))[0].error_message,'EXIT_PRIORITY_MISMATCH');
      // Conflicting event IDs cannot be rewritten. Close on a later valid bar.
      time+=1000;await market(time+1000,c);
    }
    const entryTime=c.wrong?time-1000:time;
    await receiveBridge(store,x.secret,event(x.d,time+1000,{type:'EXIT',entryTime,reason:c.reason}));await execute();
    const last=(await store.listSignals(a))[0];assert.equal(last.status,'FILLED',last.error_message);
  }
  assert.equal((await store.paperAccount(a,'binance-global')).positionCost,'0');
});
test('5 rejected and 5 capped BUY cases map only actual accepted quantities',async()=>{
  for(let i=0;i<5;i++) {
    const a=await owner(),x=await ready(a,{capital:1000,maxOrder:10}),time=Date.now()-20000-i*100;
    await market(time);await receiveBridge(store,x.secret,event(x.d,time));await execute();
    const allocation=await db.prepare('SELECT a.* FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id WHERE e.deployment_id=?').get(x.d.deployment_id);
    assert.ok(Number(allocation.filled_quantity)<1);assert.ok(Number(allocation.filled_quantity)>0);
    await store.setSetting('globalKill',true);
    try{await market(time+1);await receiveBridge(store,x.secret,event(x.d,time+1));await execute();}
    finally{await store.setSetting('globalKill',false);}
    assert.equal((await store.listSignals(a))[0].status,'REJECTED');
    assert.equal((await db.prepare('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?').get(x.d.deployment_id)).n,1);
  }
});

test('concurrent AI workers enforce four global/one owner leases and shutdown leaves recoverable state',async()=>{
  const owners=await Promise.all(Array.from({length:6},()=>owner()));
  for(const a of owners){await analyze(a);await analyze(a);}
  const claims=await Promise.all(Array.from({length:8},()=>new PineBridgeWorker({service}).claim()));
  const claimed=claims.filter(Boolean);assert.equal(claimed.length,4);assert.equal(new Set(claimed.map(j=>j.owner_id)).size,4);
  await db.prepare("UPDATE pine_bridge_jobs SET lease_until=0 WHERE status='RUNNING'").run();
  await runAll();
  const a=await owner(),job=await analyze(a);let dispatched;
  const started=new Promise(resolve=>dispatched=resolve);
  const worker=new PineBridgeWorker({service,provider:{run:async(_request,_source,{signal})=>new Promise((_resolve,reject)=>{dispatched();signal.addEventListener('abort',()=>reject(fail('OUTCOME_UNKNOWN')),{once:true});})}});
  worker.run();await started;await worker.stop();
  assert.equal((await db.transaction(()=>service.get(a,job.job_id))).job_status,'OUTCOME_UNKNOWN');
});
test('crash before execution commit rolls back fills and mapping together; replacement preserves old exits',async()=>{
  const a=await owner(),x=await ready(a),time=Date.now()-15000;
  await market(time);await receiveBridge(store,x.secret,event(x.d,time));
  const crash=new ExecutionWorker({store,config,beforeCommit:()=>{throw new Error('fixture crash');}});
  await assert.rejects(crash.tick(),/fixture crash/);
  assert.equal((await db.prepare('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?').get(x.d.deployment_id)).n,0);
  await execute();assert.equal((await db.prepare('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?').get(x.d.deployment_id)).n,1);
  const generated=await enqueue(a,'generate',{bot_id:a,pine_import_id:x.d.pine_import_id,source_version:1,selected_signals:{buy:'buy',exit:'sell',timing:'bar_close'},parameter_slots:[],bridge_options:{atr_multiplier:2,rr:1.5},market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'}});
  await runAll();const done=await db.transaction(()=>service.get(a,generated.job_id)),next=await db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id),e=evidenceFor(next);
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(next.deployment_id,next.snapshot_hash,JSON.stringify(e),hash(canonical(e)),Date.now());
  await db.transaction(()=>activateDeployment(service,a,next.deployment_id));
  assert.equal((await db.prepare("SELECT count(*) n FROM pine_deployments WHERE bot_id=? AND state='READY'").get(a)).n,1);
  await market(time+1000);await receiveBridge(store,x.secret,event(x.d,time+1000,{type:'EXIT',entryTime:time}));await execute();
  assert.equal((await store.paperAccount(a,'binance-global')).positionCost,'0');
});
test('Bridge HTTP endpoints enforce auth/CSRF/owner scope and strict early strategy rejection',async t=>{
  const password='isolated-test-password';
  const a=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password)}),b=await owner();
  await store.setRisk(a.id,structuredClone(config.defaultRisk));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base='http://127.0.0.1:'+port,request=httpClient(base);
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:db.pool.options.connectionString,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PINE_BRIDGE_ENABLED:'1',PINE_AI_MODEL:'gpt-4.1-mini',PINE_AI_API_KEY:'not-a-real-key',PINE_AI_INPUT_USD_PER_MILLION:'0.4',PINE_AI_OUTPUT_USD_PER_MILLION:'1.6',PINE_AI_RATE_VERSION:'test-only'}});
  const exited=once(child,'exit');child.stdout.resume();child.stderr.resume();t.after(async()=>{child.kill();await exited;});
  let ready=false;for(let i=0;i<100;i++){try{await fetch(base+'/healthz');ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}assert.ok(ready);
  const route='/api/quant/pine-bridge/analyze',body={bot_id:a.id,pine_source:source,source_name:'HTTP fixture'},headers={'Idempotency-Key':randomUUID()};
  assert.equal((await request(route,'POST',body,undefined,headers)).status,401);
  const login=await request('/api/auth/login','POST',{email:a.email,password});assert.equal(login.status,200);const session=login.session;
  assert.equal((await request(route,'POST',body,{...session,csrf:''},headers)).status,403);
  assert.equal((await request(route,'POST',{...body,bot_id:b},session,headers)).status,404);
  const strategy=await request(route,'POST',{...body,pine_source:source.replace('indicator(', 'strategy(')},session,headers);assert.equal(strategy.body.code,'INDICATOR_REQUIRED');
  const created=await request(route,'POST',body,session,headers);assert.equal(created.status,202,JSON.stringify(created.body));
  const same=await request(route,'POST',body,session,headers);assert.equal(same.body.job_id,created.body.job_id);
  assert.equal((await request('/api/quant/pine-bridge/jobs/'+created.body.job_id,'GET',undefined,session)).status,200);
  const cancelled=await request('/api/quant/pine-bridge/jobs/'+created.body.job_id+'/cancel','POST',{},session);assert.equal(cancelled.body.job_status,'CANCELLED');
});
test('protected backup restores extension records exactly and runtime cannot forge readiness or bars',async()=>{
  const target='robot_bridge_restore_'+randomUUID().replaceAll('-',''),role='bridge_runtime_'+randomUUID().replaceAll('-','');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'bridge-restore-'));let restored;
  try{
    await admin.query('CREATE DATABASE '+target);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+target;
    restored=new PostgresDatabase({connectionString:url.toString()});
    const snapshot=async connection=>{const rows={};for(const name of ['pine_sources','pine_source_revisions','pine_memberships','pine_bridge_jobs','pine_bridge_attempts','pine_deployments','pine_bridge_events','pine_bridge_entries','pine_bridge_evidence','pine_market_bars'])rows[name]=(await connection.query('SELECT * FROM '+name)).rows.map(canonical).sort();return hash(canonical(rows));};
    const before=await snapshot(db),backup=await backupPostgres(path.join(dir,'bridge.dump'),{connectionString:db.pool.options.connectionString});
    const env=postgresToolEnvironment(url.toString());
    const status=await new Promise((resolve,reject)=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});child.on('error',reject);child.on('exit',resolve);});
    assert.equal(status,0);assert.equal(await snapshot(restored),before);
    await admin.query('CREATE ROLE '+role+' NOSUPERUSER NOCREATEDB NOCREATEROLE');
    const grants=(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',role);await db.query(grants);
    for(const table of ['pine_bridge_evidence','pine_market_bars','pine_bridge_schema'])await assert.rejects(db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('DELETE FROM '+table);}),{code:'42501'});
  }finally{
    await restored?.close();await admin.query('DROP DATABASE IF EXISTS '+target);
    await db.query('DROP OWNED BY '+role).catch(()=>{});await admin.query('DROP ROLE IF EXISTS '+role);
    await fs.rm(dir,{recursive:true,force:true});
  }
});
