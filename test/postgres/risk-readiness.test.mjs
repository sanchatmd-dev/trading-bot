import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from '../../src/security.js';
import {httpClient,enroll} from '../helpers.mjs';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {buildRiskReadiness} from '../../src/postgres/risk-readiness.js';
import {config} from '../../src/config.js';
import fs from 'node:fs/promises';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {PineBridgeWorker} from '../../src/postgres/pine-bridge-worker.js';
import {activateDeployment} from '../../src/postgres/pine-bridge-readiness.js';
import {receiveBridge} from '../../src/postgres/pine-bridge-receiver.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {D,amount} from '../../src/money.js';

let admin,db,writerDb,store,writer,databaseName;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_readiness_test_'+randomUUID().replaceAll('-','');
  assert.match(databaseName,/^robot_readiness_test_[a-f0-9]{32}$/);
  await admin.query('CREATE DATABASE '+databaseName);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:target.toString()});
  writerDb=new PostgresDatabase({connectionString:target.toString()});
  await db.migrate();
  await db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
  store=new Store(db);writer=new Store(writerDb);
});
after(async()=>{
  await writerDb?.close();await db?.close();
  if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}
});
const policy=(capital='100',overrides={})=>({...structuredClone(config.defaultRisk),maxTradesPerDay:100,maxOpenPositions:10,
  blockHighVolatility:false,blockDuringNews:false,equities:{'binance-global':capital},balances:{'binance-global':capital},...overrides});
async function account(capital='100',overrides={}){
  const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'NO_LOGIN',role:'ADMIN'});
  await store.setRisk(user.id,policy(capital,overrides));return user;
}
const raw=(overrides={})=>({trade_id:randomUUID(),broker:'binance-global',symbol:'BTCUSDT',event:'BUY',quantity:'1',entry:'10',sl:'9',timestamp:Date.now(),...overrides});
const preview=(user,signal,owner=user)=>buildRiskReadiness({store,botId:user.id,ownerId:owner.id,defaultRisk:config.defaultRisk,body:{signal}});
async function execute(user,signal){
  await store.enqueue(user.id,normalizeSignal(signal));
  assert.equal(await new ExecutionWorker({store,config}).tick(),true);
  return (await store.listSignals(user.id)).find(row=>row.trade_id===signal.trade_id);
}
async function state(user){
  const counts={};
  counts.fills=(await db.prepare('SELECT count(*) n FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=?').get(user.id)).n;
  for(const table of ['signals','paper_cash_journal','paper_funding','paper_snapshots','audit','notification_outbox']){
    counts[table]=(await db.prepare('SELECT count(*) n FROM '+table+' WHERE user_id=?').get(user.id)).n;
  }
  return {counts,account:await store.paperAccount(user.id,'binance-global'),policy:await store.risk(user.id,config.defaultRisk),session:await store.getBotSession(user.id)};
}

for(const [name,signalOverrides,expected] of [
  ['accepted',{},'ACCEPTED'],
  ['percent equity capped',{quantity:undefined,risk_mode:'PERCENT_EQUITY',risk_value:'100'},'CAPPED'],
  ['cash rejected',{quantity:'11'},'REJECTED']
])test('readiness matches real ExecutionWorker: '+name,async()=>{
  const user=await account(),signal=raw(signalOverrides),before=await state(user);
  const result=await preview(user,signal);
  assert.equal(result.calculation.status,expected);
  assert.equal(result.readiness.status,expected==='REJECTED'?'BLOCKED':'UNKNOWN');
  assert.deepEqual(await state(user),before,'readiness must not create signals, fills, funding, snapshots or audit');
  const executed=await execute(user,signal);
  if(expected==='REJECTED'){
    assert.equal(executed.status,'REJECTED');assert.equal(executed.error_message,result.calculation.reason);
  }else{
    assert.equal(executed.status,'FILLED');
    const intent=JSON.parse(executed.order_intent);
    for(const key of ['quantity','price','notional','sizingAdjustment'])assert.deepEqual(intent[key],result.calculation.order[key]);
  }
});

test('readiness reads coherent policy and capital while another connection commits funding',async()=>{
  const user=await account('100',{maxOrderNotional:100}),originalRisk=store.risk;
  let changed=false;
  store.risk=async function(...args){
    const saved=await originalRisk.apply(this,args);
    if(args[0]===user.id&&!changed){changed=true;await writer.setRisk(user.id,policy('200',{maxOrderNotional:1}));}
    return saved;
  };
  let result;
  try{result=await preview(user,raw({quantity:'5'}));}finally{store.risk=originalRisk;}
  assert.equal(changed,true);assert.equal(result.account.cash,'100');
  assert.equal(result.calculation.status,'ACCEPTED');assert.equal(result.calculation.order.notional,'50');
  assert.equal((await store.paperAccount(user.id,'binance-global')).cash,'200');
  const fresh=await preview(user,raw({quantity:'5'}));
  assert.equal(fresh.account.cash,'200');assert.equal(fresh.calculation.status,'REJECTED');
  assert.equal(fresh.calculation.reason,'Maximum order notional exceeded');
});

test('readiness target allocation stays isolated between sibling bots and matches worker rejection',async()=>{
  const owner=await account(),bot=await store.createBot(owner.id,'Second bot',policy()),foreignEntry=raw(),localEntry=raw();
  await execute(owner,foreignEntry);await execute(bot,localEntry);
  const signal=raw({event:'SELL',reduce_only:true,target_trade_id:foreignEntry.trade_id});
  const before=await state(bot),result=await preview(bot,signal,owner);
  assert.equal(result.calculation.status,'REJECTED');assert.equal(result.calculation.reason,'Target allocation not found or already closed');
  assert.deepEqual(await state(bot),before);
  const executed=await execute(bot,signal);assert.equal(executed.status,'REJECTED');assert.equal(executed.error_message,result.calculation.reason);
  const own=await preview(bot,raw({event:'SELL',reduce_only:true,target_trade_id:localEntry.trade_id}),owner);
  assert.equal(own.calculation.status,'ACCEPTED');
  await assert.rejects(preview(owner,raw(),bot),error=>error.status===403);
});

test('readiness and worker use RUNNING frozen policy rather than subsequently saved policy',async()=>{
  const user=await account(),frozen=await store.risk(user.id,config.defaultRisk);
  await store.transitionBotState(user.id,'run',frozen,await store.paperAccounts(user.id));
  await store.setRisk(user.id,policy('100',{maxOrderNotional:1}));
  const signal=raw(),result=await preview(user,signal);
  assert.equal(result.policySource,'LOCKED_SESSION');assert.equal(result.calculation.status,'ACCEPTED');
  assert.equal((await execute(user,signal)).status,'FILLED');
});

async function bridgeFixture({maxRiskPercent=2,modelVersion='paper-close-v1',capital='1000',balance=capital,feeBps=10}={}){
  const user=await account(capital,{maxRiskPercent,maxSignalAgeSeconds:3600,balances:{'binance-global':balance}});
  const service=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider:()=>({provider:'fixture',model:'fixture',inputRate:.1,outputRate:.2,rateVersion:'fixture-v1'})});
  const provider={run:async request=>({value:{buy:'buy',exit:'sell',diagnostics:[],...(request.operation==='analyze'?{eligible_inputs:request.analysis.inputs.map(input=>input.input_id)}:{})},usage:{input_tokens:50,output_tokens:30,cost_usd:.000011},request_id:'fixture'})};
  const worker=new PineBridgeWorker({service,provider});
  const source='//@version=6\nindicator("Readiness fixture")\nlength=input.int(10,minval=1,maxval=20)\nbuy=ta.crossover(close,ta.ema(close,length))\nsell=ta.crossunder(close,ta.ema(close,length))';
  const analyzed=await db.transaction(()=>service.enqueue(user.id,'analyze',{bot_id:user.id,pine_source:source,source_name:'Readiness fixture'},randomUUID()));
  while(await worker.tick());
  const generated=await db.transaction(()=>service.enqueue(user.id,'generate',{bot_id:user.id,pine_import_id:analyzed.pine_import_id,source_version:1,
    selected_signals:{buy:'buy',exit:'sell',timing:'bar_close'},parameter_slots:[],bridge_options:{atr_multiplier:2,rr:1.5},
    market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'}},randomUUID()));
  while(await worker.tick());
  const done=await db.transaction(()=>service.get(user.id,generated.job_id));assert.equal(done.job_status,'SUCCEEDED');
  const deployment=await db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id);
  const evidence={snapshot_hash:deployment.snapshot_hash,artifact_hash:deployment.snapshot.artifact_hash,source_hash:deployment.snapshot.source_hash,
    compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,
    native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,
    execution_model:{version:modelVersion,price_tick:.01,quantity_step:.001,fee_bps:feeBps,slippage_bps:10,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},
    references:{tradingview:'isolated fixture; not real compilation',source_review:'isolated fixture source review',paper_fixture:'isolated fixture gate validation'}};
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deployment.deployment_id,deployment.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),Date.now());
  await db.transaction(()=>activateDeployment(service,user.id,deployment.deployment_id));
  const secret=randomUUID();await store.setWebhookSecret(user.id,secret);
  return {user,deployment,secret};
}
async function bridgeBar(time,{close='100',low='99',high='101'}={}){
  const bar={time,open:close,high,low,close,volume:'100',atr14:'5',price_tick:'0.01',quantity_step:'0.001'};
  await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?)').run('binance-global','BTCUSDT','1D',time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'isolated fixture'}),hash(canonical(bar)));
}
const bridgePreview=(fixture,request)=>buildRiskReadiness({store,botId:fixture.user.id,ownerId:fixture.user.id,defaultRisk:config.defaultRisk,body:{bridge:{deployment_id:fixture.deployment.deployment_id,...request}}});
async function bridgeState(fixture){
  const extra={};for(const table of ['pine_bridge_events','pine_bridge_entries','pine_bridge_pending'])extra[table]=(await db.prepare('SELECT count(*) n FROM '+table+' WHERE deployment_id=?').get(fixture.deployment.deployment_id)).n;
  return {base:await state(fixture.user),extra};
}
async function bridgeExecute(fixture,time,{event_type='BUY',entryTime=time,reason='NATIVE',expectedStatus='FILLED',queueOnly=false}={}){
  const d=fixture.deployment,entry_ref=d.deployment_id+':'+entryTime+':0';
  const event_id=event_type==='BUY'?entry_ref+':BUY':entry_ref+':'+time+':EXIT';
  await receiveBridge(store,fixture.secret,{schema_version:'bridge-exit-v1',...d.snapshot.market,event_id,event_type,entry_ref,bar_time:time,sequence:0,
    ...(event_type==='BUY'?{close:100,atr:5}:{reason})});
  if(!queueOnly)assert.equal(await new ExecutionWorker({store,config}).tick(),true);
  const event=await db.prepare('SELECT signal_id FROM pine_bridge_events WHERE deployment_id=? AND event_id=?').get(d.deployment_id,event_id);
  const row=await db.prepare('SELECT * FROM signals WHERE id=?').get(event.signal_id);assert.equal(row.status,queueOnly?'QUEUED':expectedStatus);return row;
}

test('Bridge readiness matches real receiver and worker rounded quantity, fee and cash without writes',async()=>{
  const fixture=await bridgeFixture(),time=Date.now()-1000;await bridgeBar(time);
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});
  assert.ok(['ACCEPTED','CAPPED'].includes(result.calculation.status));assert.equal(result.readiness.status,'UNKNOWN');
  assert.equal(result.costs.riskLimitIncludesCosts,false);assert.equal(result.costs.model.fee_bps,10);
  assert.deepEqual(await bridgeState(fixture),before);
  const row=await bridgeExecute(fixture,time),intent=JSON.parse(row.order_intent);
  for(const key of ['quantity','price','notional','stopLoss','takeProfit'])assert.equal(intent[key],result.calculation.order[key]);
  assert.equal(amount((await db.prepare('SELECT fee_quote FROM fills WHERE signal_id=?').get(row.id)).fee_quote),result.costs.fee);
  assert.equal((await store.paperAccount(fixture.user.id,'binance-global')).cash,result.costs.cashAfterOrder);
});

test('Bridge readiness blocks estimated cost-inclusive stop loss beyond policy while worker retains price-risk behavior',async()=>{
  const fixture=await bridgeFixture({maxRiskPercent:1}),time=Date.now()-1000;await bridgeBar(time);
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});
  assert.ok(['ACCEPTED','CAPPED'].includes(result.calculation.status));
  assert.equal(result.readiness.status,'BLOCKED');
  assert.ok(result.readiness.reasons.includes('POLICY_CONFIGURATION_CONFLICT'));
  assert.ok(result.consistency.issues.some(issue=>issue.code==='ESTIMATED_STOP_LOSS_EXCEEDS_POLICY'));
  assert.ok(D(result.costs.estimatedLossAtStop).gt(D(result.account.bookEquity).mul('0.01')));
  assert.equal(result.costs.riskLimitIncludesCosts,false);assert.deepEqual(await bridgeState(fixture),before);
  const row=await bridgeExecute(fixture,time);
  assert.equal(JSON.parse(row.order_intent).quantity,result.calculation.order.quantity);
});

test('Bridge readiness scopes native EXIT and rejects BUY on protective-exit bar',async()=>{
  const fixture=await bridgeFixture(),entryTime=Date.now()-3000;await bridgeBar(entryTime);await bridgeExecute(fixture,entryTime);
  const nativeTime=entryTime+1000;await bridgeBar(nativeTime);
  const request={bar_time:nativeTime,event_type:'EXIT',entry_ref:fixture.deployment.deployment_id+':'+entryTime+':0',reason:'NATIVE'};
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,request);
  assert.equal(result.calculation.status,'ACCEPTED');assert.equal(result.calculation.order.reduceOnly,true);
  assert.deepEqual(await bridgeState(fixture),before);
  await assert.rejects(bridgePreview(fixture,{...request,entry_ref:'foreign-deployment:'+entryTime+':0'}),{code:'INVALID_ENTRY_REFERENCE'});
  const protectionTime=nativeTime+1000;await bridgeBar(protectionTime,{low:'89'});
  await assert.rejects(bridgePreview(fixture,{bar_time:protectionTime,event_type:'BUY'}),{code:'BUY_SUPPRESSED_EXIT_BAR'});
  const row=await bridgeExecute(fixture,nativeTime,{event_type:'EXIT',entryTime});
  assert.equal(JSON.parse(row.order_intent).quantity,result.calculation.order.quantity);
  assert.equal((await store.paperAccount(fixture.user.id,'binance-global')).cash,result.costs.cashAfterOrder);
});

async function venueSnapshot({stale=false,minNotional='0.01'}={}){
  const now=Date.now(),retrieved=stale?now-60001:now;
  const instrument={symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,orderTypes:['MARKET','LIMIT'],filters:[
    {filterType:'PRICE_FILTER',minPrice:'0.01',maxPrice:'1000000',tickSize:'0.01'},
    {filterType:'LOT_SIZE',minQty:'0.001',maxQty:'100',stepSize:'0.001'},
    {filterType:'MIN_NOTIONAL',minNotional,applyToMarket:true,avgPriceMins:5}]};
  const payload={version:'binance-spot-filters-v1',source:'https://api.binance.com/api/v3/exchangeInfo',symbol:'BTCUSDT',base_asset:'BTC',quote_asset:'USDT',status:'TRADING',spot_allowed:true,retrieved_at:retrieved,instrument,exchange_filters:[],reference_prices:[{kind:'REFERENCE',source:'https://api.binance.com/api/v3/referencePrice',symbol:'BTCUSDT',price:null,timestamp:retrieved,retrieved_at:retrieved},{kind:'AVERAGE',source:'https://api.binance.com/api/v3/avgPrice',symbol:'BTCUSDT',price:'100',minutes:5,timestamp:retrieved,retrieved_at:retrieved}]};
  const snapshot={...payload,hash:hash(canonical(payload))};await store.setSetting('binance-spot-filters-v1:BTCUSDT',snapshot);return snapshot;
}

test('cost-v2 readiness and worker cap inclusive risk, record fee/cash and persist venue provenance',async()=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2',maxRiskPercent:1}),time=Date.now()-1000;await bridgeBar(time);const snapshot=await venueSnapshot();
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});
  assert.equal(result.calculation.status,'CAPPED');assert.equal(result.venue.status,'PASSED');assert.equal(result.costs.riskLimitIncludesCosts,true);
  assert.ok(D(result.costs.estimatedLossAtStop).lte(D(result.account.bookEquity).mul('.01')));assert.deepEqual(await bridgeState(fixture),before);
  const row=await bridgeExecute(fixture,time),intent=JSON.parse(row.order_intent);assert.equal(intent.execution_model_version,'paper-close-cost-v2');
  for(const key of ['quantity','price','notional','stopLoss'])assert.equal(intent[key],result.calculation.order[key]);
  assert.equal(intent.venue_report.snapshotHash,snapshot.hash);assert.equal(amount((await db.prepare('SELECT fee_quote FROM fills WHERE signal_id=?').get(row.id)).fee_quote),result.costs.fee);
  assert.equal((await store.paperAccount(fixture.user.id,'binance-global')).cash,result.costs.cashAfterOrder);
});
for(const [name,settings] of [['minimum notional',{minNotional:'10000'}],['stale metadata',{stale:true}]])test('cost-v2 readiness and worker reject '+name+' without a fill',async()=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2'}),time=Date.now()-1000;await bridgeBar(time);await venueSnapshot(settings);
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});assert.equal(result.calculation.status,'REJECTED');assert.equal(result.readiness.status,'BLOCKED');assert.deepEqual(await bridgeState(fixture),before);
  const row=await bridgeExecute(fixture,time,{expectedStatus:'REJECTED'});assert.ok(result.venue.reasons.includes(row.error_message));assert.equal((await store.paperAccount(fixture.user.id,'binance-global')).cash,'1000');
  assert.equal((await db.prepare('SELECT count(*) n FROM fills WHERE signal_id=?').get(row.id)).n,0);
});
test('real PostgreSQL reserves pending V2 fees and prevents withdrawal below commitments',async()=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2'}),user=fixture.user,time=Date.now()-1000;await bridgeBar(time);await venueSnapshot();
  const pending=raw({quantity:'2',entry:'100',sl:'90'});await store.enqueue(user.id,normalizeSignal(pending));
  const row=(await store.listSignals(user.id)).find(item=>item.trade_id===pending.trade_id);
  await db.prepare("UPDATE signals SET status='SUBMITTED',order_intent=? WHERE id=?").run(JSON.stringify({quantity:'2',price:'100',execution_model_version:'paper-close-cost-v2',reserved_fee_bps:'10'}),row.id);
  const exposure=await store.exposure({id:0,user_id:user.id,account_id:'binance-global:primary',execution_mode:'PAPER',broker:'binance-global',symbol:'BTCUSDT'});
  assert.equal(exposure.reservedNotional,'200');assert.equal(exposure.reservedFees,'0.2');assert.equal(exposure.feeReservationUnknown,false);
  const before=await state(user);await assert.rejects(store.setRisk(user.id,{...await store.risk(user.id,config.defaultRisk),balances:{'binance-global':'199.9'}}),/withdrawal exceeds unreserved funds/);assert.deepEqual(await state(user),before);
  const previewBefore=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});assert.equal(result.account.cashAvailable,'799.8');assert.deepEqual(await bridgeState(fixture),previewBefore);
  const executed=await bridgeExecute(fixture,time);assert.equal(JSON.parse(executed.order_intent).quantity,result.calculation.order.quantity);
});
test('V2 worker crash rolls back fee/cash/venue intent and recovers exactly one fill',async()=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2'}),time=Date.now()-1000;await bridgeBar(time);await venueSnapshot();
  const queued=await bridgeExecute(fixture,time,{queueOnly:true}),before=await bridgeState(fixture);
  await assert.rejects(new ExecutionWorker({store,config,beforeCommit:async()=>{throw new Error('fixture rollback');}}).tick(),/fixture rollback/);assert.deepEqual(await bridgeState(fixture),before);
  assert.equal((await db.prepare('SELECT status,order_intent FROM signals WHERE id=?').get(queued.id)).status,'QUEUED');assert.equal((await db.prepare('SELECT order_intent FROM signals WHERE id=?').get(queued.id)).order_intent,null);
  assert.equal(await new ExecutionWorker({store,config}).tick(),true);assert.equal(await new ExecutionWorker({store,config}).tick(),false);
  assert.equal((await db.prepare('SELECT count(*) n FROM fills WHERE signal_id=?').get(queued.id)).n,1);
});
test('real HTTP Bridge readiness preserves scenario authority and enforces auth, CSRF, ownership and refresh validation',async t=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2'}),foreign=await bridgeFixture(),time=Date.now()-1000;await bridgeBar(time);await venueSnapshot();
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('temporary-test-password'),fixture.user.id);
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port,request=httpClient(base),target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;
  const server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:target.toString(),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1'}});
  let exited=false;server.on('exit',()=>exited=true);server.stdout.resume();server.stderr.resume();t.after(async()=>{if(!exited){const stopped=once(server,'exit');server.kill('SIGTERM');await stopped;}});
  let ready=false;for(let i=0;i<100&&!exited;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}if(ready)break;await delay(50);}assert.ok(ready,'isolated HTTP server must start');
  const login=await request('/api/auth/login','POST',{email:fixture.user.email,password:'temporary-test-password'});assert.equal(login.status,200);await enroll(request,login.session);
  const body={bridge:{deployment_id:fixture.deployment.deployment_id,bar_time:time,event_type:'BUY'}},before=await bridgeState(fixture);
  const result=await request('/api/risk/readiness','POST',body,login.session);assert.equal(result.status,200);assert.ok(['ACCEPTED','CAPPED'].includes(result.body.calculation.status));assert.equal(result.body.costs.riskLimitIncludesCosts,true);assert.deepEqual(await bridgeState(fixture),before);
  const draft={...body,scenario:{policy:await store.risk(fixture.user.id,config.defaultRisk),capital:{cash:'1500',bookEquity:'1500'}}};const hypothetical=await request('/api/risk/readiness','POST',draft,login.session);assert.equal(hypothetical.status,200);assert.equal(hypothetical.body.scenario.hypothetical,true);assert.equal(hypothetical.body.account.cash,'1500');assert.deepEqual(await bridgeState(fixture),before);
  assert.equal((await request('/api/risk/readiness','POST',body)).status,401);assert.equal((await request('/api/risk/readiness','POST',body,login.session,{'x-csrf-token':'bad'})).status,403);
  assert.equal((await request('/api/risk/readiness?bot_id='+foreign.user.id,'POST',body,login.session)).status,403);
  assert.equal((await request('/api/risk/readiness','POST',{bridge:{...body.bridge,deployment_id:foreign.deployment.deployment_id}},login.session)).status,404);
  assert.equal((await request('/api/risk/readiness','POST',{...body,policy:{}},login.session)).status,400);
  assert.equal((await request('/api/risk/venue-refresh','POST',{symbol:'ETHUSDT'},login.session)).status,400);
  assert.equal((await request('/api/risk/venue-refresh','POST',{symbol:'BTCUSDT',policy:{}},login.session)).status,400);
  assert.equal((await request('/api/risk/venue-refresh','POST',{symbol:'BTCUSDT'},login.session,{'x-csrf-token':'bad'})).status,403);
  const refresh=await request('/api/risk/venue-refresh','POST',{symbol:'BTCUSDT'},login.session);assert.equal(refresh.status,200);assert.equal(refresh.body.cached,true);assert.ok(refresh.body.snapshotHash);assert.deepEqual(await bridgeState(fixture),before);
});

test('cost-v2 fee-aware cash cap matches worker and cannot overspend small cash',async()=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2',capital:'1000',balance:'15',feeBps:1000}),time=Date.now()-1000;await bridgeBar(time);await venueSnapshot();
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});
  assert.equal(result.calculation.status,'CAPPED');assert.ok(D(result.costs.cashDebit).lte('15'));assert.ok(D(result.costs.fee).gt(0));assert.deepEqual(await bridgeState(fixture),before);
  const row=await bridgeExecute(fixture,time);assert.equal(JSON.parse(row.order_intent).quantity,result.calculation.order.quantity);assert.equal((await store.paperAccount(fixture.user.id,'binance-global')).cash,result.costs.cashAfterOrder);assert.ok(D(result.costs.cashAfterOrder).gte(0));
});
test('cost-v2 cash below the executable quantity step rejects preview and worker without a fill',async()=>{
  const fixture=await bridgeFixture({modelVersion:'paper-close-cost-v2',capital:'1000',balance:'0.01'}),time=Date.now()-1000;await bridgeBar(time);await venueSnapshot();
  const before=await bridgeState(fixture),result=await bridgePreview(fixture,{bar_time:time,event_type:'BUY'});assert.equal(result.calculation.status,'REJECTED');assert.deepEqual(await bridgeState(fixture),before);
  const row=await bridgeExecute(fixture,time,{expectedStatus:'REJECTED'});assert.equal(row.error_message,result.calculation.reason);assert.equal((await store.paperAccount(fixture.user.id,'binance-global')).cash,'0.01');assert.equal((await db.prepare('SELECT count(*) n FROM fills WHERE signal_id=?').get(row.id)).n,0);
});
