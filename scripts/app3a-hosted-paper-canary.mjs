// Operator-only staging rehearsal. The bundle contains private source and must
// never be committed. It is read from a separate, read-only market/source export.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {PostgresDatabase} from '../src/postgres/db.js';
import {Store} from '../src/postgres/store.js';
import {PineBridgeService} from '../src/postgres/pine-bridge.js';
import {membershipSnapshot} from '../src/postgres/pine-bridge-registry.js';
import {activateDeployment,validateEvidence} from '../src/postgres/pine-bridge-readiness.js';
import {hash,canonical} from '../src/pine-bridge/source.js';
import {validateBar} from '../src/postgres/pine-bridge-market.js';
import {levels,exitDecision} from '../src/pine-bridge/contract.js';
import {config} from '../src/config.js';
import {encryptJson} from '../src/security.js';

const [bundlePath,resultPath]=process.argv.slice(2);
assert.ok(bundlePath&&resultPath,'Supply private bundle and private result paths');
const url=new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.pathname,'/postgres');
assert.ok(url.searchParams.get('host')?.startsWith('/tmp/robot-app3a-hosted.'),'A new temporary Unix-socket cluster is required');
assert.ok(config.paperTrading);
const bundle=JSON.parse(await fs.readFile(bundlePath,'utf8'));
const original=bundle.deployment,revision=bundle.revision;
assert.equal(original.state,'DRAFT');
assert.equal(hash(revision.source),original.snapshot.source_hash);
assert.equal(hash(bundle.artifact),original.snapshot.artifact_hash);
assert.ok(bundle.artifact.startsWith(revision.source));
assert.equal(hash(canonical(original.snapshot)),original.snapshot_hash);
assert.equal(original.snapshot.market.timeframe,'1');
assert.equal(original.snapshot.market.broker,'binance-global');
for(const row of bundle.bars){
  validateBar(row.bar);assert.equal(hash(canonical(row.bar)),row.content_hash);
  assert.equal(row.provenance.profile,'closed-ohlcv-atr14-v1');
  assert.ok(row.bar.time<=bundle.exported_at);
}
const bars=bundle.bars.sort((a,b)=>a.bar_time-b.bar_time);
let pair;
for(let i=bars.length-3;i>=0;i--){
  const entry=bars[i],exit=bars[i+1];
  if(Date.now()-entry.bar_time>240000)break;
  if(exit.bar_time-entry.bar_time!==60000)continue;
  const lv=levels(Number(entry.bar.close),Number(entry.bar.atr14),2,1.5,Number(entry.bar.price_tick));
  if(!exitDecision({time:entry.bar_time,entry_ref:'selection',...lv},exit.bar)) {pair=[entry,exit];break;}
}
assert.ok(pair,'No fresh consecutive real bars with protection levels untouched');
const timeoutBar=bars.at(-1);assert.ok(timeoutBar.bar_time>pair[1].bar_time);
const admin=new PostgresDatabase({connectionString:url.toString()});
const name='robot_hosted_canary_'+randomUUID().replaceAll('-','');
let db,runtime,children=[],roleCreated=false;
const report={recorded_at:new Date().toISOString(),kind:'hosted-controlled-Paper-v2-real-Spot-bars',source_hash:original.snapshot.source_hash,artifact_hash:original.snapshot.artifact_hash,original_snapshot_hash:original.snapshot_hash,original_deployment_state:'DRAFT',market_exported_at:bundle.exported_at,market_provenance:pair.map(r=>({bar_time:r.bar_time,content_hash:r.content_hash,provenance:r.provenance})),limitations:['Controlled HTTP intents, not observed TradingView-to-Paper signals.','Exact compiled artifact replicated in a fresh database; its deployment ID is reused only in that isolated database.','Independent collector bars are deliberately held before canary insertion; latency is not a natural-feed distribution.','Quant evaluator and automatic Futures adaptation are not certified.']};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function poll(fn,timeout=10000){const until=Date.now()+timeout;while(Date.now()<until){const value=await fn();if(value)return value;await sleep(25);}throw Error('Canary observation timed out');}
async function start(file,env){
  const child=fork(new URL(file,import.meta.url),[],{silent:true,env});
  const exited=once(child,'exit');children.push({child,exited});
  // Logs stay private; never expose bearer paths or configuration in console.
  const log=await fs.open(resultPath+'.'+children.length+'.log','w',0o600);
  child.stdout.on('data',b=>log.write(b));child.stderr.on('data',b=>log.write(b));
  child.on('exit',()=>log.close());return child;
}
try{
  await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  await db.query(await fs.readFile(new URL('../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
  await db.query(await fs.readFile(new URL('../src/postgres/pine-capture-schema.sql',import.meta.url),'utf8'));
  const store=new Store(db),service=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  const bot=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'disabled-canary-login',role:'ADMIN'});
  const policy={...structuredClone(config.defaultRisk),sideMode:'BUY_ONLY',maxRiskPercent:1,maxSignalAgeSeconds:300,blockDuringNews:false,blockHighVolatility:false,equities:{'binance-global':1000},balances:{'binance-global':1000}};
  await store.setRisk(bot.id,policy);
  await store.transitionBotState(bot.id,'run',policy,await store.paperAccounts(bot.id));
  await db.transaction(async()=>{
    await db.prepare('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(original.pine_import_id,bot.id,bot.id,revision.source_version,revision.source_hash,'Approved Spot v4 canary replica',revision.source,JSON.stringify(revision.analysis),Date.now());
    await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(original.pine_import_id,revision.source_version,revision.source_hash,revision.source,JSON.stringify(revision.analysis),Date.now());
    await db.prepare('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version) VALUES(?,?,?,?)').run(original.pine_import_id,bot.id,bot.id,revision.source_version);
  });
  const session=await store.getBotSession(bot.id);
  const snapshot={...original.snapshot,policy,policy_hash:hash(canonical(policy)),capital:await store.paperAccounts(bot.id),funding_cutoff:(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(bot.id)).cutoff,membership:await membershipSnapshot(service,bot.id,bot.id),session:{state:session.state,run_id:session.run_id},captured_at:Date.now()};
  const d={...original,owner_id:bot.id,bot_id:bot.id,snapshot,snapshot_hash:hash(canonical(snapshot))};
  await db.prepare('INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').run(d.deployment_id,bot.id,bot.id,d.pine_import_id,d.source_version,JSON.stringify(snapshot),d.snapshot_hash,Date.now());
  const model={version:'paper-close-v1',price_tick:Number(pair[0].bar.price_tick),quantity_step:Number(pair[0].bar.quantity_step),fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
  const evidence={...bundle.review,snapshot_hash:d.snapshot_hash,execution_model:model};validateEvidence(evidence,d.snapshot_hash);
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(d.deployment_id,d.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),Date.now());
  report.activation=await db.transaction(()=>activateDeployment(service,bot.id,d.deployment_id));
  const secret=randomUUID();await store.setWebhookSecret(bot.id,secret,encryptJson({secret},config.keyring,'webhook:'+bot.id));
  await db.query('CREATE ROLE robot_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');roleCreated=true;
  await db.query(await fs.readFile(new URL('grant-postgres-runtime.sql',import.meta.url),'utf8'));
  const runtimeUrl=new URL(url);runtimeUrl.username='robot_app';
  runtime=new PostgresDatabase({connectionString:runtimeUrl.toString()});
  for(const table of ['pine_market_bars','pine_bridge_evidence'])await assert.rejects(runtime.query('DELETE FROM '+table),{code:'42501'});
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base='http://127.0.0.1:'+port;
  const env={...process.env,NODE_ENV:'test',DATABASE_URL:runtimeUrl.toString(),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,PINE_BRIDGE_ENABLED:'1',SMTP_HOST:'',PINE_AI_API_KEY:'',PINE_BRIDGE_CAPTURE_ENABLED:'0',PINE_CAPTURE_PUBLIC_ORIGIN:''};
  await start('../src/postgres/server.js',env);
  await start('../src/postgres/worker-main.js',env);
  await poll(async()=>{try{return (await fetch(base+'/healthz')).ok;}catch{return false;}});
  const post=async payload=>{const r=await fetch(base+'/webhooks/pine-bridge/v2/'+secret,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});return {status:r.status,body:await r.json()};};
  const entryRef=d.deployment_id+':'+pair[0].bar_time+':0';
  const payload=(row,type='BUY')=>({schema_version:'bridge-exit-v2',...snapshot.market,event_id:type==='BUY'?d.deployment_id+':'+row.bar_time+':0:BUY':entryRef+':'+row.bar_time+':EXIT',event_type:type,entry_ref:type==='BUY'?d.deployment_id+':'+row.bar_time+':0':entryRef,bar_time:row.bar_time,sequence:0,...(type==='BUY'?{close:Number(row.bar.close),atr:Number(row.bar.atr14)}:{reason:'NATIVE'})});
  const pending=p=>db.prepare('SELECT * FROM pine_bridge_pending WHERE deployment_id=? AND event_id=?').get(d.deployment_id,p.event_id);
  const signalCount=async()=>Number((await db.prepare('SELECT count(*) n FROM signals').get()).n);
  const freeze=async row=>{
    await db.transaction(()=>db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?)').run(row.broker,row.symbol,row.timeframe,row.bar_time,JSON.stringify(row.bar),JSON.stringify(row.provenance),row.content_hash));
    return Date.now();
  };
  report.timing=[];
  for(const [row,type]of [[pair[0],'BUY'],[pair[1],'EXIT']]){
    const p=payload(row,type),before=await signalCount(),response=await post(p);
    assert.equal(response.status,202,JSON.stringify(response.body));
    assert.equal((await pending(p)).status,'WAITING_MARKET');
    assert.equal(await signalCount(),before);
    assert.equal((await post(p)).body.duplicate,true);
    await sleep(200);const frozenAt=await freeze(row);
    const queued=await poll(async()=>{const r=await pending(p);return r?.status==='QUEUED'&&r;});
    const queueObserved=Date.now();assert.ok(queued.checked_at>=frozenAt);assert.ok(queued.checked_at<queued.deadline_at);
    const signal=await poll(async()=>{const r=await db.prepare('SELECT status,error_message FROM signals WHERE id=?').get(queued.signal_id);return ['FILLED','REJECTED'].includes(r?.status)&&r;});
    assert.equal(signal.status,'FILLED',signal.error_message);
    assert.equal((await post(p)).body.duplicate,true);
    report.timing.push({type,bar_time:row.bar_time,received_at:queued.received_at,deadline_at:queued.deadline_at,freeze_commit_observed_at:frozenAt,queue_checked_at:queued.checked_at,queue_commit_observed_at:queueObserved,receipt_to_freeze_ms:frozenAt-queued.received_at,freeze_to_queue_observed_ms:queueObserved-frozenAt,receipt_to_queue_observed_ms:queueObserved-queued.received_at,outcome:signal.status});
  }
  const fillsBefore=Number((await db.prepare('SELECT count(*) n FROM fills').get()).n);
  assert.equal(fillsBefore,2);
  const allocation=await db.prepare('SELECT status,remaining_quantity FROM ledger_position_allocations WHERE user_id=?').get(bot.id);
  assert.equal(allocation.status,'CLOSED');assert.equal(Number(allocation.remaining_quantity),0);
  const p=payload(timeoutBar),before=await signalCount();
  assert.equal((await post(p)).status,202);
  const expired=await poll(async()=>{const r=await pending(p);return r?.status==='REJECTED'&&r;},8000);
  assert.equal(expired.diagnostic,'MARKET_WAIT_EXPIRED');assert.equal(expired.deadline_at-expired.received_at,5000);
  assert.equal(await signalCount(),before);
  await freeze(timeoutBar);assert.equal((await post(p)).body.duplicate,true);await sleep(300);
  assert.equal(await signalCount(),before);assert.equal(Number((await db.prepare('SELECT count(*) n FROM fills').get()).n),fillsBefore);
  report.timeout={received_at:expired.received_at,deadline_at:expired.deadline_at,checked_at:expired.checked_at,check_elapsed_ms:expired.checked_at-expired.received_at,diagnostic:expired.diagnostic,signals_created:0,late_retry_revived:false};
  report.readiness={canary_bot_id:bot.id,canary_snapshot_hash:d.snapshot_hash,evidence_hash:hash(canonical(evidence)),evidence,operator_recorded:true,owner_activation_exercised:true,runtime_protected_tables:['pine_market_bars','pine_bridge_evidence'],model,bot_policy:policy};
  report.fills=await db.prepare('SELECT s.side,f.price,f.delta_quantity,f.fee_quote FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=? ORDER BY f.signal_id').all(bot.id);
  report.duplicate_extra_fills=0;report.original_activation_changed=false;
  await store.transitionBotState(bot.id,'stop',policy,await store.paperAccounts(bot.id));report.canary_final_state='STOPPED';
  report.passed=true;
  await fs.writeFile(resultPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:true,timing:report.timing,timeout:report.timeout,fills:fillsBefore,canary_final_state:report.canary_final_state,original_activation_changed:false}));
}finally{
  for(const {child}of children)child.kill('SIGTERM');
  for(const {child,exited}of children)await Promise.race([exited,sleep(5000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);
  await runtime?.close();await db?.close();
  await admin.query('DROP DATABASE IF EXISTS '+name);
  if(roleCreated)await admin.query('DROP ROLE robot_app');
  await admin.close();
}
