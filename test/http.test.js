import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Worker as TestServer} from 'node:worker_threads';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';

test('HTTP integration: auth, paper webhook, duplicate, stale, risk, tenant isolation and secrets',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'astra-http-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=new TestServer(new URL('../src/server.js',import.meta.url),{
    env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:path.join(dir,'db.sqlite'),
      NODE_ENV:'production',PAPER_TRADING:'true',MASTER_ENCRYPTION_KEY:'a'.repeat(64),
      ADMIN_EMAIL:'admin@example.test',ADMIN_BOOTSTRAP_PASSWORD:'temporary-test-password',SMTP_HOST:''},
    stdout:true,stderr:true
  });
  let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const exited=once(child,'exit');
  let exitCode=null;child.on('exit',code=>{exitCode=code;});
  t.after(async()=>{if(exitCode===null){await child.terminate();await exited;}fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<100;i++){
    try{ready=(await fetch(base+'/healthz')).ok;}catch{}
    if(ready)break;if(exitCode!==null)break;await delay(50);
  }
  assert.equal(ready,true,output);
  const loginPage=await (await fetch(base+'/')).text();
  assert.match(loginPage,/showLoginPassword/);
  assert.match(loginPage,/autocomplete="current-password"/);
  assert.match(loginPage,/<title>Robot trade<\/title>/);
  assert.match(loginPage,/id="forgotPassword"/);
  assert.match(loginPage,/id="language"/);
  async function request(route,method='GET',body,token) {
    const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  assert.equal((await request('/api/me')).status,401);
  const login=await request('/api/auth/login','POST',{email:'admin@example.test',password:'temporary-test-password'});
  assert.equal(login.status,200);const token=login.body.token;
  assert.equal((await request('/api/risk','GET',undefined,token)).body.maxRiskPercent,100);
  assert.equal((await request('/api/risk','GET',undefined,token)).body.defaults.riskPercent,1);
  assert.equal((await request('/api/risk','GET',undefined,token)).body.maxOrderNotional,10000);
  assert.equal((await request('/api/risk','GET',undefined,token)).body.maxDailyNotional,100000);
  assert.equal((await request('/api/risk','PUT',{maxOrderNotional:9000,maxDailyNotional:90000,capPercentEquitySize:true},token)).status,200);
  assert.equal((await request('/api/risk','GET',undefined,token)).body.maxDailyNotional,90000);
  assert.equal((await request('/api/risk','PUT',{capPercentEquitySize:'true'},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{maxRiskPercent:1,defaults:{riskPercent:2}},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{maxRiskPercent:101},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{paperTrading:false},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{killSwitch:'false'},token)).status,400);
  assert.equal((await request('/api/brokers/binance-global','PUT',{credentials:{apiKey:'a',apiSecret:'b',baseUrl:'http://127.0.0.1'}},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{equities:{'binance-global':10000},balances:{'binance-global':2500}},token)).status,200);
  assert.equal((await request('/api/risk','PUT',{balances:{'binance-global':10001}},token)).status,400);
  const preview=await request('/api/risk/preview','POST',{calculator:{broker:'binance-global',symbol:'BTCUSD',entry:100,stopLoss:99,riskPercent:50,volatilityPercent:0}},token);
  assert.equal(preview.status,200);assert.equal(preview.body.ok,true);
  assert.ok(preview.body.order.notional<=2500);assert.equal(preview.body.balance,2500);
  assert.equal(typeof preview.body.positionsRemaining,'number');assert.equal(typeof preview.body.positionCapacity,'number');
  const secret=(await request('/api/me/webhook-secret','POST',{},token)).body.urlPath;
  assert.equal((await request('/api/me/webhook-secret')).status,401);
  const savedWebhook=await request('/api/me/webhook-secret','GET',undefined,token);
  assert.equal(savedWebhook.body.urlPath,secret);
  assert.equal((await request('/api/me/webhook-secret','PUT',{url:'https://robot.test'+secret},token)).status,200);
  assert.equal((await request('/api/me/webhook-secret','PUT',{url:'https://robot.test/webhooks/tradingview/'+'f'.repeat(64)},token)).status,400);
  const payload={trade_id:'http-buy',broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:10,entry:100,sl:90,timestamp:Date.now(),news_risk:false,volatility_percent:0};
  const accepted=await request(secret,'POST',payload);assert.equal(accepted.status,202);assert.equal(accepted.body.execution_mode,'PAPER');
  assert.equal((await request(secret,'POST',payload)).status,409);
  assert.match((await request(secret,'POST',{...payload,trade_id:'old',timestamp:Date.now()-120000})).body.error,/stale/);
  for(let i=0;i<50;i++){
    const log=(await request('/api/signals','GET',undefined,token)).body;
    if(log[0]?.status==='FILLED')break;await delay(30);
  }
  assert.equal((await request('/api/signals','GET',undefined,token)).body[0].status,'FILLED');
  assert.equal((await request('/api/signals','GET',undefined,token)).body[0].symbol,'BTCUSDT');
  await request('/api/admin/global-kill','POST',{enabled:true},token);
  assert.equal((await request(secret,'POST',{...payload,symbol:'BTCUSDT',trade_id:'exit',event:'SL',quantity:10,entry:90,timestamp:Date.now()})).status,202);
  await delay(350);
  assert.equal((await request('/api/positions','GET',undefined,token)).body.length,0);
  const funds=(await request('/api/me','GET',undefined,token)).body.paperAccounts.find(row=>row.broker==='binance-global');
  assert.equal(funds.cash,2400);assert.equal(funds.bookEquity,9900);
  const afterLossPreview=await request('/api/risk/preview','POST',{calculator:{broker:'binance-global',symbol:'BTCUSDT',entry:100,stopLoss:90,riskPercent:1,volatilityPercent:0}},token);
  assert.equal(afterLossPreview.body.freeBalance,2400);assert.equal(afterLossPreview.body.balance,2400);
  const analytics=await request('/api/analytics/summary?broker=binance-global&period=daily','GET',undefined,token);
  assert.equal(analytics.status,200);assert.equal(analytics.body.currency,'USDT');assert.equal(analytics.body.totalTrades,1);assert.ok(analytics.body.netProfit<0);
  assert.equal(analytics.body.tradeDefinition,'FLAT_TO_FLAT_PER_BOT_BROKER_SYMBOL');
  assert.equal(analytics.body.drawdownBasis,'REALIZED_FIFO_EXCLUDING_CASH_FLOWS');
  assert.equal((await request('/api/analytics/summary?broker=binance-th&period=daily','GET',undefined,token)).body.totalTrades,0);
  assert.equal((await request('/api/analytics/settings','PUT',{broker:'binance-global',feeBps:12.5},token)).status,200);
  assert.equal((await request('/api/analytics/summary?broker=binance-global&period=custom&from=invalid&to=2026-01-01','GET',undefined,token)).status,400);
  await request('/api/admin/users','POST',{email:'user@example.test',password:'temporary-user-password'},token);
  const userToken=(await request('/api/auth/login','POST',{email:'user@example.test',password:'temporary-user-password'})).body.token;
  assert.equal((await request('/api/me/webhook-secret','GET',undefined,userToken)).body.urlPath,null);
  assert.equal((await request('/api/me/webhook-secret','PUT',{url:'https://robot.test'+secret},userToken)).status,400);
  assert.equal((await request('/api/admin/users','GET',undefined,userToken)).status,403);
  assert.deepEqual((await request('/api/signals','GET',undefined,userToken)).body,[]);
  assert.equal((await request('/api/analytics/summary?broker=binance-global&period=daily&user_id=not-this-user','GET',undefined,userToken)).status,403);
  const createdBot=await request('/api/bots','POST',{label:'Scalp BTC'},token);
  assert.equal(createdBot.status,201);const botId=createdBot.body.id;
  assert.equal((await request('/api/risk?bot_id='+botId,'PUT',{equities:{'binance-global':1000},balances:{'binance-global':1000}},token)).status,200);
  const botWebhook=(await request('/api/me/webhook-secret?bot_id='+botId,'GET',undefined,token)).body.urlPath;
  assert.notEqual(botWebhook,secret);assert.ok(botWebhook);
  for(const route of ['/api/me','/api/me/webhook-secret','/api/risk','/api/signals','/api/positions','/api/analytics/summary']){
    assert.equal((await request(route+'?bot_id='+botId,'GET',undefined,userToken)).status,403,route);
  }
  assert.equal((await request('/api/risk?bot_id='+botId,'PUT',{killSwitch:true},userToken)).status,403);
  assert.equal((await request('/api/bots/'+botId,'PATCH',{label:'stolen'},userToken)).status,404);
  assert.equal((await request('/api/risk?bot_id=all','PUT',{killSwitch:true},token)).status,400);
  assert.equal((await request('/api/bots/'+botId,'PATCH',{label:'Bot A: BTC'},token)).status,200);
  await request('/api/admin/global-kill','POST',{enabled:false},token);
  assert.equal((await request(botWebhook,'POST',{...payload,trade_id:'http-buy',quantity:1,timestamp:Date.now()})).status,202);
  for(let i=0;i<50;i++){const rows=(await request('/api/signals?bot_id='+botId,'GET',undefined,token)).body;if(rows[0]?.status==='FILLED')break;await delay(30);}
  assert.equal((await request('/api/signals?bot_id='+botId,'GET',undefined,token)).body[0].status,'FILLED',JSON.stringify((await request('/api/signals?bot_id='+botId,'GET',undefined,token)).body));
  assert.equal((await request('/api/positions?bot_id='+botId,'GET',undefined,token)).body[0].quantity,1);
  const childFunds=(await request('/api/me?bot_id='+botId,'GET',undefined,token)).body.paperAccounts.find(row=>row.broker==='binance-global');
  assert.equal(childFunds.cash,900);assert.equal(childFunds.bookEquity,1000);
  assert.equal((await request('/api/positions','GET',undefined,token)).body.length,0);
  assert.equal((await request('/api/positions?bot_id=all','GET',undefined,token)).body[0].bot_id,botId);
  for(let i=0;i<3;i++)assert.equal((await request('/api/bots','POST',{label:'Extra '+i},token)).status,201);
  assert.equal((await request('/api/bots','POST',{label:'Over quota'},token)).status,400);
  assert.equal((await request('/api/bots','GET',undefined,token)).body.bots.length,5);
  await request('/api/admin/global-kill','POST',{enabled:true},token);
  assert.equal((await request(secret,'POST',{...payload,trade_id:'blocked',timestamp:Date.now()})).status,202);
  let rejected;
  for(let i=0;i<50;i++){rejected=(await request('/api/signals','GET',undefined,token)).body.find(x=>x.trade_id==='blocked');if(rejected?.status==='REJECTED')break;await delay(30);}
  assert.equal(rejected.status,'REJECTED');
  const notePath='/api/signals/'+rejected.id+'/note';
  assert.equal((await request(notePath,'PUT',{note:'review'})).status,401);
  assert.equal((await request(notePath,'PUT',{note:'review'},userToken)).status,404);
  assert.equal((await request(notePath,'PUT',{note:'x'.repeat(2001)},token)).status,400);
  assert.equal((await request(notePath,'PUT',{note:'Reviewed kill switch'},token)).status,200);
  assert.equal((await request('/api/signals','GET',undefined,token)).body.find(x=>x.id===rejected.id).review_note,'Reviewed kill switch');
  assert.equal((await request('/api/me/password','POST',{currentPassword:'temporary-user-password',newPassword:'new-temporary-password'},userToken)).status,200);
  assert.equal((await request('/api/me','GET',undefined,userToken)).status,401);
});
