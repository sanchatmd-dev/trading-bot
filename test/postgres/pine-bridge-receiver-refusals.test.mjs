import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {PineBridgeWorker} from '../../src/postgres/pine-bridge-worker.js';
import {receiveBridge} from '../../src/postgres/pine-bridge-receiver.js';
import {PineMarketWaitWorker} from '../../src/postgres/pine-market-wait-worker.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {activateDeployment,validateEvidence} from '../../src/postgres/pine-bridge-readiness.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {encryptJson} from '../../src/security.js';
import {config} from '../../src/config.js';

/**
 * F02-03 refusal clauses of the Pine Bridge receiver (docs/PINE_BRIDGE_ADAPTER_API.md, "Versioned webhook contract"
 * table lines 101-106 and 122-123, and the v2 route row at line 190):
 *   C1b  a v1 body on the v2 route is refused (line 101 strict supported version, line 190 v2 route takes bridge-exit-v2)
 *   C2b  unknown secret, inactive Bot or inactive owner is refused with 404 NOT_FOUND (line 101 private authentication)
 *   C6c  an entry_ref of another deployment is refused INVALID_ENTRY_REFERENCE (line 106 foreign target)
 *   C6d  a new EXIT event for an already closed allocation is refused TARGET_NOT_OPEN (lines 106, 122, 123 closed target)
 *   R2   the same event_id on the v1 and the v2 route stays single effect (line 103, 123)
 * Expected codes and statuses are literals on purpose: a changed code must fail here, not follow silently.
 * Fixtures are synthetic engineering fixtures: they say nothing about strategy performance.
 */
let admin,db,store,service,databaseName;
const source='//@version=6\nindicator("Fixture")\nlength=input.int(10, minval=1, maxval=20)\nbuy=ta.crossover(close,ta.ema(close,length))\nsell=ta.crossunder(close,ta.ema(close,length))';
const getProvider=()=>({provider:'fixture',model:'fixture',inputRate:.1,outputRate:.2,rateVersion:'fixture-v1'});
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_bridge_refusal_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
  await db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8')));
  store=new Store(db);service=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider});
  await db.query(await fs.readFile(new URL('../../src/postgres/pine-capture-schema.sql',import.meta.url),'utf8'));
  await installQuantGuards(db);
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});

async function owner(){const row=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'});await store.setRisk(row.id,structuredClone(config.defaultRisk));return row.id;}
const enqueue=(id,operation,body,key=randomUUID())=>db.transaction(()=>service.enqueue(id,operation,body,key));
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'};
function provider(){return {run:async request=>({value:{buy:'buy',exit:'sell',diagnostics:[],...(request.operation==='analyze'?{eligible_inputs:request.analysis.inputs.map(i=>i.input_id)}:{})},usage:{input_tokens:50,output_tokens:30,cost_usd:.000011},request_id:'fixture'})};}
async function runAll(){const worker=new PineBridgeWorker({service,provider:provider()});for(let i=0;i<30&&await worker.tick();i++);}
const generateBody=(botId,importId)=>({bot_id:botId,pine_import_id:importId,source_version:1,selected_signals:{buy:'buy',exit:'sell',timing:'bar_close'},parameter_slots:[],bridge_options:{atr_multiplier:2,rr:1.5},market:MARKET});
async function finishJob(ownerId,job){await runAll();const done=await db.transaction(()=>service.get(ownerId,job.job_id));assert.equal(done.job_status,'SUCCEEDED');return db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id);}
async function draft(ownerId,botId=ownerId){
  const analysis=await enqueue(ownerId,'analyze',{bot_id:botId,pine_source:source,source_name:'Fixture'});await runAll();
  return finishJob(ownerId,await enqueue(ownerId,'generate',generateBody(botId,analysis.pine_import_id)));
}
function evidenceFor(d){return {snapshot_hash:d.snapshot_hash,artifact_hash:d.snapshot.artifact_hash,source_hash:d.snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:10,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},references:{tradingview:'fixture-only-not-real-compilation',source_review:'fixture-only-source-review',paper_fixture:'fixture-only-gate-validation'}};}
async function activate(ownerId,d){
  const e=evidenceFor(d);validateEvidence(e,d.snapshot_hash);
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(d.deployment_id,d.snapshot_hash,JSON.stringify(e),hash(canonical(e)),Date.now());
  await db.transaction(()=>activateDeployment(service,ownerId,d.deployment_id));
}
/** A READY Paper deployment. With botId set, the deployment belongs to that child Bot of the owner; the webhook secret and policy are the Bot's. */
async function ready(ownerId,botId=ownerId){
  await store.setRisk(botId,{...structuredClone(config.defaultRisk),maxRiskPercent:2,maxDailyLossR:1000,pauseAfterLossStreak:100,maxOrderNotional:10000,maxDailyNotional:1e7,maxTradesPerDay:10000,onePositionPerSymbol:false,blockHighVolatility:false,blockDuringNews:false,maxSignalAgeSeconds:3600,equities:{'binance-global':1000},balances:{'binance-global':1000},capPercentEquitySize:true});
  const d=await draft(ownerId,botId);await activate(ownerId,d);
  const secret=randomUUID();await store.setWebhookSecret(botId,secret,encryptJson({secret},config.keyring,'webhook:'+botId));
  return {d,secret,botId,ownerId};
}
async function childBot(ownerId){return (await store.createBot(ownerId,'Refusal Bot',structuredClone(config.defaultRisk))).id;}
// One market table serves the whole file; a test never judges on a bar another test wrote.
async function freshBars(){await db.prepare('DELETE FROM pine_market_bars').run();}
async function market(time,{close=100,high=101,low=99,atr=5}={}){
  const bar={time,open:String(close),high:String(high),low:String(low),close:String(close),volume:'100',atr14:String(atr),price_tick:'0.01',quantity_step:'0.001'};
  const content=hash(canonical(bar));
  const written=await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING bar_time').get('binance-global','BTCUSDT','1D',time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'isolated fixture'}),content);
  if(written)return;
  const existing=await db.prepare("SELECT content_hash FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1D' AND bar_time=?").get(time);
  if(existing?.content_hash!==content)throw new Error('market(): bar_time '+time+' already holds different facts');
}
function event(d,time,{type='BUY',entryTime=time,reason='NATIVE',version='bridge-exit-v1'}={}){
  const ref=d.deployment_id+':'+entryTime+':0';
  return {schema_version:version,...d.snapshot.market,event_id:type==='BUY'?ref+':BUY':ref+':'+time+':EXIT',event_type:type,entry_ref:ref,bar_time:time,sequence:0,...(type==='BUY'?{close:100,atr:5}:{reason})};
}
async function execute(){const worker=new ExecutionWorker({store,config});for(let i=0;i<200&&(await store.health()).queued;i++)await worker.tick();}
const n=async(sql,...args)=>Number((await db.prepare(sql).get(...args)).n);
/** Every table a refused event must leave untouched, for one deployment and its Bot. */
const effects=async(d,botId)=>({
  events:await n('SELECT count(*) n FROM pine_bridge_events WHERE deployment_id=?',d.deployment_id),
  pending:await n('SELECT count(*) n FROM pine_bridge_pending WHERE deployment_id=?',d.deployment_id),
  signals:await n('SELECT count(*) n FROM signals WHERE user_id=?',botId),
  fills:await n('SELECT count(*) n FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=?',botId),
  entries:await n('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?',d.deployment_id)
});
const allocation=(d,ref)=>db.prepare('SELECT a.position_id,a.status,a.remaining_quantity,a.filled_quantity FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id WHERE e.deployment_id=? AND e.entry_ref=?').get(d.deployment_id,ref);

async function startServer(t){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base='http://127.0.0.1:'+port;
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:db.pool.options.connectionString,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PINE_BRIDGE_ENABLED:'1'}});
  const exited=once(child,'exit');let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  t.after(async()=>{child.kill();await exited;});
  let listening=false;for(let i=0;i<100;i++){try{listening=(await fetch(base+'/healthz')).ok;if(listening)break;}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(listening,output);
  return async(version,secret,body)=>{const response=await fetch(base+'/webhooks/pine-bridge/'+version+'/'+secret,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
}

test('C1b: a bridge-exit-v1 body on the v2 route is refused UNSUPPORTED_SCHEMA_VERSION, and the reverse too, with no effect',async()=>{
  await freshBars();
  const a=await owner(),x=await ready(a),time=Date.now()-5000;await market(time);
  const v1=event(x.d,time),v2=event(x.d,time,{version:'bridge-exit-v2'});
  const before=await effects(x.d,a);
  // The version is checked before authentication, so a refusal cannot be a side effect of anything else in the body.
  await assert.rejects(receiveBridge(store,x.secret,v1,{contractVersion:'bridge-exit-v2'}),{code:'UNSUPPORTED_SCHEMA_VERSION',status:400});
  await assert.rejects(receiveBridge(store,x.secret,v2,{contractVersion:'bridge-exit-v1'}),{code:'UNSUPPORTED_SCHEMA_VERSION',status:400});
  await assert.rejects(receiveBridge(store,x.secret,{...v1,schema_version:'bridge-exit-v3'},{contractVersion:'bridge-exit-v2'}),{code:'UNSUPPORTED_SCHEMA_VERSION',status:400});
  assert.deepEqual(await effects(x.d,a),before);assert.deepEqual(before,{events:0,pending:0,signals:0,fills:0,entries:0});
  // Positive control: the same facts with the matching version are accepted, so the refusals above were caused by the version alone.
  const accepted=await receiveBridge(store,x.secret,v2,{contractVersion:'bridge-exit-v2'});
  assert.equal(accepted.accepted,true);assert.equal(accepted.duplicate,false);
  await execute();assert.equal((await effects(x.d,a)).fills,1);
});

test('C1b over HTTP: v1 body on /v2/ answers 400 UNSUPPORTED_SCHEMA_VERSION; C2b over HTTP: unknown secret, inactive Bot and inactive owner answer 404 NOT_FOUND',async t=>{
  await freshBars();
  const a=await owner(),bot=await childBot(a),x=await ready(a,bot),time=Date.now()-5000;await market(time);
  const post=await startServer(t);
  const v1=event(x.d,time),v2=event(x.d,time,{version:'bridge-exit-v2'});
  const before=await effects(x.d,bot);
  const wrongVersion=await post('v2',x.secret,v1);
  assert.equal(wrongVersion.status,400);assert.equal(wrongVersion.body.code,'UNSUPPORTED_SCHEMA_VERSION');
  const reverse=await post('v1',x.secret,v2);assert.equal(reverse.status,400);assert.equal(reverse.body.code,'UNSUPPORTED_SCHEMA_VERSION');
  for(const version of ['v1','v2']){
    const unknown=await post(version,randomUUID(),version==='v1'?v1:v2);assert.equal(unknown.status,404);assert.equal(unknown.body.code,'NOT_FOUND');
  }
  try{
    await store.setUserStatus(bot,'SUSPENDED');
    for(const version of ['v1','v2']){const r=await post(version,x.secret,version==='v1'?v1:v2);assert.equal(r.status,404);assert.equal(r.body.code,'NOT_FOUND');}
  }finally{await store.setUserStatus(bot,'ACTIVE');}
  try{
    await store.setUserStatus(a,'SUSPENDED');
    for(const version of ['v1','v2']){const r=await post(version,x.secret,version==='v1'?v1:v2);assert.equal(r.status,404);assert.equal(r.body.code,'NOT_FOUND');}
  }finally{await store.setUserStatus(a,'ACTIVE');}
  assert.deepEqual(await effects(x.d,bot),before);assert.deepEqual(before,{events:0,pending:0,signals:0,fills:0,entries:0});
  // Positive control after reactivation: status was the only reason for the 404 answers.
  assert.equal((await post('v2',x.secret,v2)).status,202);
});

test('C2b: unknown secret, inactive Bot and inactive owner are refused NOT_FOUND (404) with no event, pending, signal or ledger effect',async()=>{
  await freshBars();
  const a=await owner(),bot=await childBot(a),x=await ready(a,bot),time=Date.now()-5000;await market(time);
  const v1=event(x.d,time),v2=event(x.d,time,{version:'bridge-exit-v2'}),before=await effects(x.d,bot);
  assert.deepEqual(before,{events:0,pending:0,signals:0,fills:0,entries:0});
  const refuse=async label=>{
    for(const body of [v1,v2])await assert.rejects(receiveBridge(store,x.secret,body),{code:'NOT_FOUND',status:404},label+' '+body.schema_version);
    assert.deepEqual(await effects(x.d,bot),before,label+' left an effect');
  };
  // Unknown secret: a secret that belongs to no account.
  for(const body of [v1,v2])await assert.rejects(receiveBridge(store,randomUUID(),body),{code:'NOT_FOUND',status:404});
  assert.deepEqual(await effects(x.d,bot),before);
  // Inactive Bot with an active owner.
  try{await store.setUserStatus(bot,'SUSPENDED');await refuse('inactive Bot');}finally{await store.setUserStatus(bot,'ACTIVE');}
  // Active Bot under an inactive owner.
  try{await store.setUserStatus(a,'SUSPENDED');await refuse('inactive owner');}finally{await store.setUserStatus(a,'ACTIVE');}
  // A secret this Bot no longer holds is unknown: rotate, then the old secret is refused and the new one works.
  const rotated=randomUUID();await store.setWebhookSecret(bot,rotated,encryptJson({secret:rotated},config.keyring,'webhook:'+bot));
  for(const body of [v1,v2])await assert.rejects(receiveBridge(store,x.secret,body),{code:'NOT_FOUND',status:404});
  assert.deepEqual(await effects(x.d,bot),before);
  // Positive control: every status is ACTIVE again and the current secret is accepted, so the refusals were caused by status/secret.
  const accepted=await receiveBridge(store,rotated,v1);assert.equal(accepted.accepted,true);assert.equal(accepted.duplicate,false);
  assert.equal((await effects(x.d,bot)).events,1);
});

test('C6c: an entry_ref of another deployment is refused INVALID_ENTRY_REFERENCE; both allocations and the ledger stay untouched',async()=>{
  await freshBars();
  const a=await owner(),x=await ready(a),time=Date.now()-6000;
  await market(time);await receiveBridge(store,x.secret,event(x.d,time));await execute();
  // Replacement deployment on the same source: D1 becomes EXIT_ONLY, D2 becomes READY (same Bot and secret).
  const d2=await finishJob(a,await enqueue(a,'generate',generateBody(a,x.d.pine_import_id)));await activate(a,d2);
  assert.equal((await db.prepare('SELECT state FROM pine_deployments WHERE deployment_id=?').get(x.d.deployment_id)).state,'EXIT_ONLY');
  assert.equal((await db.prepare('SELECT state FROM pine_deployments WHERE deployment_id=?').get(d2.deployment_id)).state,'READY');
  await market(time+500);await receiveBridge(store,x.secret,event(d2,time+500));await execute();
  const ref1=x.d.deployment_id+':'+time+':0',ref2=d2.deployment_id+':'+(time+500)+':0';
  const open1=await allocation(x.d,ref1),open2=await allocation(d2,ref2);
  assert.equal(open1.status,'OPEN');assert.equal(open2.status,'OPEN');assert.notEqual(open1.position_id,open2.position_id);
  await market(time+1000,{close:88,high:120,low:85});
  const before=[await effects(x.d,a),await effects(d2,a)];
  const accountBefore=(await store.paperAccount(a,'binance-global')).positionCost;
  const foreignToD1=event(x.d,time+1000,{type:'EXIT',entryTime:time,reason:'SL'});
  foreignToD1.entry_ref=ref2;foreignToD1.event_id=ref2+':'+(time+1000)+':EXIT';
  const foreignToD2=event(d2,time+1000,{type:'EXIT',entryTime:time+500,reason:'SL'});
  foreignToD2.entry_ref=ref1;foreignToD2.event_id=ref1+':'+(time+1000)+':EXIT';
  for(const version of ['bridge-exit-v1','bridge-exit-v2']){
    await assert.rejects(receiveBridge(store,x.secret,{...foreignToD1,schema_version:version}),{code:'INVALID_ENTRY_REFERENCE',status:400});
    await assert.rejects(receiveBridge(store,x.secret,{...foreignToD2,schema_version:version}),{code:'INVALID_ENTRY_REFERENCE',status:400});
  }
  assert.deepEqual([await effects(x.d,a),await effects(d2,a)],before);
  await execute();
  for(const [d,ref,was] of [[x.d,ref1,open1],[d2,ref2,open2]]){
    const now=await allocation(d,ref);assert.equal(now.status,'OPEN');assert.equal(now.remaining_quantity,was.remaining_quantity);
  }
  assert.equal((await store.paperAccount(a,'binance-global')).positionCost,accountBefore);
  // Positive control: D1's own reference on D1's route is accepted and closes only that allocation.
  await receiveBridge(store,x.secret,event(x.d,time+1000,{type:'EXIT',entryTime:time,reason:'SL'}));await execute();
  assert.equal((await allocation(x.d,ref1)).status,'CLOSED');assert.equal((await allocation(d2,ref2)).status,'OPEN');
});

test('C6d: a new EXIT event for an allocation already fully closed is refused TARGET_NOT_OPEN with no extra fill and no other allocation touched',async()=>{
  await freshBars();
  const a=await owner(),x=await ready(a),time=Date.now()-8000;
  await market(time);const buy1=event(x.d,time);await receiveBridge(store,x.secret,buy1);await execute();
  await market(time+500);await receiveBridge(store,x.secret,event(x.d,time+500));await execute();
  const ref1=x.d.deployment_id+':'+time+':0',ref2=x.d.deployment_id+':'+(time+500)+':0';
  await market(time+1000,{close:88,high:120,low:85});
  const closeExit=event(x.d,time+1000,{type:'EXIT',entryTime:time,reason:'SL'});
  await receiveBridge(store,x.secret,closeExit);await execute();
  assert.equal((await allocation(x.d,ref1)).status,'CLOSED');assert.equal(Number((await allocation(x.d,ref1)).remaining_quantity),0);
  const open2=await allocation(x.d,ref2);assert.equal(open2.status,'OPEN');
  const before=await effects(x.d,a),accountBefore=(await store.paperAccount(a,'binance-global')).positionCost;
  assert.equal(before.fills,3);assert.equal(before.entries,2);
  // A later bar, a different event_id (the id includes the exit bar), the same already closed target.
  await market(time+2000);
  const closedAgain=event(x.d,time+2000,{type:'EXIT',entryTime:time,reason:'NATIVE'});
  assert.notEqual(closedAgain.event_id,closeExit.event_id);
  const received=await receiveBridge(store,x.secret,closedAgain);
  assert.equal(received.accepted,true);assert.equal(received.duplicate,false); // intake only queues; the worker owns acceptance
  await execute();
  const refused=(await store.listSignals(a))[0];
  assert.equal(refused.id,received.signal_id);assert.equal(refused.status,'REJECTED');assert.equal(refused.error_message,'TARGET_NOT_OPEN');
  assert.equal((await db.prepare('SELECT outcome FROM pine_bridge_events WHERE deployment_id=? AND event_id=?').get(x.d.deployment_id,closedAgain.event_id)).outcome,'REJECTED');
  const after=await effects(x.d,a);
  assert.equal(after.fills,before.fills);assert.equal(after.entries,before.entries);assert.equal(after.events,before.events+1);assert.equal(after.signals,before.signals+1);
  assert.equal((await allocation(x.d,ref1)).status,'CLOSED');assert.equal(Number((await allocation(x.d,ref1)).remaining_quantity),0);
  // No symbol-wide fallback: the other open long of the same Bot was not reduced and the position cost did not move.
  const still2=await allocation(x.d,ref2);assert.equal(still2.status,'OPEN');assert.equal(still2.remaining_quantity,open2.remaining_quantity);
  assert.equal((await store.paperAccount(a,'binance-global')).positionCost,accountBefore);
  // A redelivery of the refused event keeps the first outcome and creates nothing.
  const again=await receiveBridge(store,x.secret,closedAgain);assert.equal(again.duplicate,true);assert.equal(again.outcome,'REJECTED');
  await execute();assert.deepEqual(await effects(x.d,a),after);
});

test('R2: the same event_id on the v1 route and then the v2 route (and the reverse) is single effect: EVENT_CONFLICT, no second signal or fill',async()=>{
  await freshBars();
  const time=Date.now()-7000;await market(time);
  // v1 first, then v2: the stored v1 event has a different body hash than the v2 body of the same event_id.
  const a=await owner(),x=await ready(a);
  const v1=event(x.d,time),v2=event(x.d,time,{version:'bridge-exit-v2'});
  assert.equal(v1.event_id,v2.event_id);
  const first=await receiveBridge(store,x.secret,v1);assert.equal(first.accepted,true);assert.equal(first.duplicate,false);
  await assert.rejects(receiveBridge(store,x.secret,v2),{code:'EVENT_CONFLICT',status:409});
  await execute();
  assert.deepEqual(await effects(x.d,a),{events:1,pending:0,signals:1,fills:1,entries:1});
  assert.equal((await receiveBridge(store,x.secret,v1)).duplicate,true);await execute();
  assert.deepEqual(await effects(x.d,a),{events:1,pending:0,signals:1,fills:1,entries:1});
  // v2 first (bar already frozen, so admitted at once and recorded as QUEUED in both tables), then v1.
  const b=await owner(),y=await ready(b);
  const w1=event(y.d,time),w2=event(y.d,time,{version:'bridge-exit-v2'});
  const second=await receiveBridge(store,y.secret,w2);assert.equal(second.accepted,true);assert.equal(second.duplicate,false);
  await assert.rejects(receiveBridge(store,y.secret,w1),{code:'EVENT_CONFLICT',status:409});
  await execute();
  assert.deepEqual(await effects(y.d,b),{events:1,pending:1,signals:1,fills:1,entries:1});
  assert.equal((await receiveBridge(store,y.secret,w2)).duplicate,true);await execute();
  assert.deepEqual(await effects(y.d,b),{events:1,pending:1,signals:1,fills:1,entries:1});
});

test('R2 (pending window): a v2 event waiting for its bar and the same event_id sent on v1 stay single effect: v1 needs the bar, then the v2 worker row is rejected SIGNAL_ID_CONFLICT',async()=>{
  await freshBars();
  const a=await owner(),x=await ready(a),time=Date.now()-9000;
  const v1=event(x.d,time),v2=event(x.d,time,{version:'bridge-exit-v2'});
  const waiting=await receiveBridge(store,x.secret,v2);assert.equal(waiting.pending_market,true);assert.equal(waiting.outcome,'WAITING_MARKET');
  // The test fixes the pending deadline far ahead so a slow machine cannot turn this into an expiry test (that bound has its own test).
  await db.prepare('UPDATE pine_bridge_pending SET deadline_at=? WHERE deployment_id=? AND event_id=?').run(Date.now()+600000,x.d.deployment_id,v2.event_id);
  assert.deepEqual(await effects(x.d,a),{events:0,pending:1,signals:0,fills:0,entries:0});
  // The v1 route keeps immediate missing-bar rejection (docs line 190), so the waiting v2 row cannot be raced before the bar exists.
  await assert.rejects(receiveBridge(store,x.secret,v1),{code:'VERIFIED_MARKET_DATA_REQUIRED',status:409});
  assert.deepEqual(await effects(x.d,a),{events:0,pending:1,signals:0,fills:0,entries:0});
  // The bar arrives. The v1 route does not read the v2 pending table (R2), so it admits and queues one signal ...
  await market(time);
  const viaV1=await receiveBridge(store,x.secret,v1);assert.equal(viaV1.accepted,true);assert.equal(viaV1.duplicate,false);
  // ... and the v2 worker, finding the same deployment-scoped trade id, rejects its own row instead of creating a second signal.
  assert.equal(await new PineMarketWaitWorker({store,defaultRisk:config.defaultRisk}).tick(),true);
  const pending=await db.prepare('SELECT status,diagnostic,signal_id FROM pine_bridge_pending WHERE deployment_id=? AND event_id=?').get(x.d.deployment_id,v2.event_id);
  assert.equal(pending.status,'REJECTED');assert.equal(pending.diagnostic,'SIGNAL_ID_CONFLICT');assert.equal(pending.signal_id,null);
  await execute();
  assert.deepEqual(await effects(x.d,a),{events:1,pending:1,signals:1,fills:1,entries:1});
  // The v2 body hash differs from the stored v1 event, so a v2 redelivery conflicts (the events table is read before the pending table) and creates nothing.
  await assert.rejects(receiveBridge(store,x.secret,v2),{code:'EVENT_CONFLICT',status:409});
  assert.equal((await receiveBridge(store,x.secret,v1)).duplicate,true);
  assert.deepEqual(await effects(x.d,a),{events:1,pending:1,signals:1,fills:1,entries:1});
});

test('R3 (pending conflict): a v2 event waiting for its bar and the same event_id with a changed body is refused EVENT_CONFLICT (409); the pending row is unchanged; an identical redelivery stays duplicate',async()=>{
  await freshBars();
  const a=await owner(),x=await ready(a),time=Date.now()-9500;
  const v2=event(x.d,time,{version:'bridge-exit-v2'});
  const waiting=await receiveBridge(store,x.secret,v2,{contractVersion:'bridge-exit-v2'});
  assert.equal(waiting.accepted,true);assert.equal(waiting.duplicate,false);assert.equal(waiting.pending_market,true);assert.equal(waiting.outcome,'WAITING_MARKET');
  // The pending deadline is fixed far ahead so a slow machine cannot turn this into an expiry test.
  await db.prepare('UPDATE pine_bridge_pending SET deadline_at=? WHERE deployment_id=? AND event_id=?').run(Date.now()+600000,x.d.deployment_id,v2.event_id);
  const pendingRow=()=>db.prepare('SELECT * FROM pine_bridge_pending WHERE deployment_id=? AND event_id=?').get(x.d.deployment_id,v2.event_id);
  const stored=await pendingRow(),before=await effects(x.d,a);
  assert.deepEqual(before,{events:0,pending:1,signals:0,fills:0,entries:0}); // pending exists, no events row
  assert.equal(stored.status,'WAITING_MARKET');
  // Same event_id, changed body (different close), same v2 route: conflict, nothing else changes.
  const changed={...v2,close:v2.close+1};
  assert.equal(changed.event_id,v2.event_id);assert.notEqual(hash(canonical(changed)),stored.event_hash);
  await assert.rejects(receiveBridge(store,x.secret,changed,{contractVersion:'bridge-exit-v2'}),{code:'EVENT_CONFLICT',status:409});
  assert.deepEqual(await pendingRow(),stored);
  assert.deepEqual(await effects(x.d,a),before);
  // Identical redelivery: duplicate of the waiting row, no extra row or effect.
  const again=await receiveBridge(store,x.secret,v2,{contractVersion:'bridge-exit-v2'});
  assert.equal(again.accepted,true);assert.equal(again.duplicate,true);assert.equal(again.pending_market,true);assert.equal(again.outcome,'WAITING_MARKET');
  assert.deepEqual(await pendingRow(),stored);
  assert.deepEqual(await effects(x.d,a),before);
});
