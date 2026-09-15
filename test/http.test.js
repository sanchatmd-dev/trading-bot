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
  async function request(route,method='GET',body,token) {
    const response=await fetch(base+route,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  assert.equal((await request('/api/me')).status,401);
  const login=await request('/api/auth/login','POST',{email:'admin@example.test',password:'temporary-test-password'});
  assert.equal(login.status,200);const token=login.body.token;
  assert.equal((await request('/api/risk','PUT',{paperTrading:false},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{killSwitch:'false'},token)).status,400);
  assert.equal((await request('/api/brokers/binance-global','PUT',{credentials:{apiKey:'a',apiSecret:'b',baseUrl:'http://127.0.0.1'}},token)).status,400);
  assert.equal((await request('/api/risk','PUT',{equities:{'binance-global':10000}},token)).status,200);
  const secret=(await request('/api/me/webhook-secret','POST',{},token)).body.urlPath;
  const payload={trade_id:'http-buy',broker:'Binance Global',symbol:'BTCUSDT',event:'BUY',quantity:10,entry:100,sl:90,timestamp:Date.now(),news_risk:false,volatility_percent:0};
  const accepted=await request(secret,'POST',payload);assert.equal(accepted.status,202);assert.equal(accepted.body.execution_mode,'PAPER');
  assert.equal((await request(secret,'POST',payload)).status,409);
  assert.match((await request(secret,'POST',{...payload,trade_id:'old',timestamp:Date.now()-120000})).body.error,/stale/);
  for(let i=0;i<50;i++){
    const log=(await request('/api/signals','GET',undefined,token)).body;
    if(log[0]?.status==='FILLED')break;await delay(30);
  }
  assert.equal((await request('/api/signals','GET',undefined,token)).body[0].status,'FILLED');
  await request('/api/admin/global-kill','POST',{enabled:true},token);
  assert.equal((await request(secret,'POST',{...payload,trade_id:'exit',event:'SL',quantity:10,entry:90,timestamp:Date.now()})).status,202);
  await delay(350);
  assert.equal((await request('/api/positions','GET',undefined,token)).body.length,0);
  await request('/api/admin/users','POST',{email:'user@example.test',password:'temporary-user-password'},token);
  const userToken=(await request('/api/auth/login','POST',{email:'user@example.test',password:'temporary-user-password'})).body.token;
  assert.equal((await request('/api/admin/users','GET',undefined,userToken)).status,403);
  assert.deepEqual((await request('/api/signals','GET',undefined,userToken)).body,[]);
  assert.equal((await request('/api/me/password','POST',{currentPassword:'temporary-user-password',newPassword:'new-temporary-password'},userToken)).status,200);
  assert.equal((await request('/api/me','GET',undefined,userToken)).status,401);
});
