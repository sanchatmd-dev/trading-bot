import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker,MailWorker} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {evaluateRisk} from '../../src/postgres/risk.js';
import {D,exact,amount} from '../../src/money.js';
import {config} from '../../src/config.js';
import {hashPassword,encryptJson,hashToken} from '../../src/security.js';
import {httpClient,enroll} from '../helpers.mjs';
import {fifoAnalytics,summarizeClosedPositions,analyticsCapital} from '../../src/postgres/analytics.js';
let adminDb,db,store,databaseName,url;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  adminDb=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_phase2_test_'+randomUUID().replaceAll('-','');
  assert.match(databaseName,/^robot_phase2_test_[a-f0-9]{32}$/);
  await adminDb.query('CREATE DATABASE '+databaseName);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;url=target.toString();
  db=new PostgresDatabase({connectionString:url,max:12});await db.migrate();store=new Store(db);
});
after(async()=>{await db?.close();if(adminDb){if(databaseName)await adminDb.query('DROP DATABASE '+databaseName);await adminDb.close();}});
const policy=(capital='100')=>({...structuredClone(config.defaultRisk),maxTradesPerDay:100,maxOpenPositions:10,blockHighVolatility:false,blockDuringNews:false,equities:{'binance-global':Number(capital)},balances:{'binance-global':Number(capital)}});
async function account(capital='100',role='ADMIN'){
  const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword('temporary-test-password'),role});
  await store.setRisk(user.id,policy(capital));return user;
}
function signal(tradeId= randomUUID(),overrides={}){return normalizeSignal({trade_id:tradeId,broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'1',entry:'0.1',sl:'0.09',timestamp:Date.now(),...overrides});}
async function drain(){
  const workers=Array.from({length:4},()=>new ExecutionWorker({store,config}));
  for(let i=0;i<100&&(await store.health()).queued;i++)await Promise.all(workers.map(w=>w.tick()));
  assert.equal((await store.health()).queued,0);
}
test('decimal input preserves strings and exact cap boundaries without float epsilon',()=>{
  assert.equal(amount(D('0.1').plus('0.2')),'0.3');
  assert.equal(signal('precision',{entry:'123456789.123456789123456789',sl:'1'}).referencePrice,'123456789.123456789123456789');
  assert.throws(()=>exact('0.0000000000000000001'));
  assert.throws(()=>exact('1e40'));
  const s=signal('cap',{risk_mode:'PERCENT_EQUITY',risk_value:'100',quantity:undefined,entry:'3',sl:'2'});
  const result=evaluateRisk(s,{policy:policy('1'),daily:{trades:0,notional:'0',realized_r:'0',loss_streak:0},position:{quantity:'0'},equity:'1',balance:'1',licensed:true,openPositions:0});
  assert.equal(result.ok,true);assert.equal(result.order.quantity,'0.333333333333333333');assert.ok(D(result.order.notional).lte(1));
});
test('concurrent duplicate intake creates exactly one row per bot',async()=>{
  const a=await account(),b=await account(),s=signal('same-id');
  const result=await Promise.all(Array.from({length:20},()=>store.enqueue(a.id,s)));
  assert.equal(result.filter(Boolean).length,1);assert.equal(await store.enqueue(b.id,s),true);await drain();
  assert.equal((await store.listSignals(a.id)).length,1);assert.equal((await store.listSignals(b.id)).length,1);
});
test('four workers never overspend and decimal cash reaches exact zero',async()=>{
  const a=await account('0.3');
  for(let i=0;i<12;i++)await store.enqueue(a.id,signal('cash-'+i));await drain();
  const rows=await store.listSignals(a.id);assert.equal(rows.filter(r=>r.status==='FILLED').length,3);assert.equal(rows.filter(r=>r.status==='REJECTED').length,9);
  assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'0');
  assert.equal((await db.prepare('SELECT count(*) n FROM paper_cash_journal WHERE user_id=?').get(a.id)).n,3);
});
test('parallel bot creation respects five slots and isolates funds',async()=>{
  const a=await account('10');
  const result=await Promise.allSettled(Array.from({length:8},(_,i)=>store.createBot(a.id,'Bot '+i,policy('0'))));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,4);assert.equal((await store.listBots(a.id)).length,5);
  const bot=result.find(r=>r.status==='fulfilled').value;await store.enqueue(bot.id,signal());await drain();
  assert.equal((await store.listSignals(bot.id))[0].status,'REJECTED');assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'10');
});
test('crash before commit rolls back claim, fill and cash; retry books once',async()=>{
  const a=await account('1');await store.enqueue(a.id,signal());
  const worker=new ExecutionWorker({store,config,beforeCommit:()=>{throw new Error('simulated crash');}});
  await assert.rejects(worker.tick(),/simulated crash/);
  assert.equal((await store.listSignals(a.id))[0].status,'QUEUED');assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'1');
  await drain();assert.equal((await store.listSignals(a.id))[0].status,'FILLED');assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'0.9');
});
test('repeated cumulative fill snapshots cannot double-book fees or cash',async()=>{
  const a=await account('10'),s=signal();await store.enqueue(a.id,s);
  const row=(await store.listSignals(a.id))[0],order={...s,quantity:'1',price:'0.1',notional:'0.1'};
  await db.prepare("UPDATE signals SET status='PROCESSING' WHERE id=?").run(row.id);
  const fill={status:'PARTIALLY_FILLED',executedQty:'0.5',quoteQty:'0.05',deltaFeeQuote:'0',raw:{}};
  await Promise.all(Array.from({length:8},()=>store.recordExecution(row,fill,order)));
  assert.equal((await db.prepare('SELECT count(*) n FROM fills WHERE signal_id=?').get(row.id)).n,1);
  await store.recordExecution(row,{...fill,status:'FILLED',executedQty:'1',quoteQty:'0.1'},order);
  assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'9.9');
});
test('fractional sells allocate remaining cost exactly and end flat',async()=>{
  const a=await account('10');await store.enqueue(a.id,signal('entry',{quantity:'3',entry:'0.1',sl:'0.09'}));await drain();
  for(let i=0;i<3;i++){await store.enqueue(a.id,signal('exit-'+i,{event:'SELL',quantity:'1',entry:'0.2',reduce_only:true}));await drain();}
  assert.equal((await store.listPositions(a.id)).length,0);
  const book=await store.paperAccount(a.id,'binance-global');assert.equal(book.cash,'10.3');assert.equal(book.bookEquity,'10.3');
});
test('pending reservations prevent withdrawal; funding retry stays idempotent',async()=>{
  const a=await account('10'),s=signal('reserve',{quantity:'5',entry:'1',sl:'0.9'});await store.enqueue(a.id,s);
  const row=(await store.listSignals(a.id))[0];await db.prepare("UPDATE signals SET status='PROCESSING',order_intent=? WHERE id=?").run(JSON.stringify({quantity:'5',price:'1'}),row.id);
  await assert.rejects(store.setRisk(a.id,policy('4')),/withdrawal/);
  await store.complete(row.id,'CANCELED');await store.setRisk(a.id,policy('7'));await store.setRisk(a.id,policy('7'));
  assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'7');
});
test('expired signals and suspended owners remain rejected across workers',async()=>{
  const a=await account();await store.enqueue(a.id,signal('old',{timestamp:Date.now()-120000}));await drain();assert.match((await store.listSignals(a.id))[0].error_message,/stale/);
  await store.enqueue(a.id,signal('suspended'));await store.setUserStatus(a.id,'SUSPENDED');await drain();assert.match((await store.listSignals(a.id))[0].error_message,/suspended/);
});
test('outbox leases allow only one concurrent SMTP attempt',async()=>{
  const a=await account();const row=await db.prepare('INSERT INTO security_mail(user_id,encrypted_body,expires_at) VALUES(?,?,?) RETURNING id').get(a.id,encryptJson({subject:'test',body:'test'},config.keyring,'security-mail:'+a.id),Date.now()+60000);
  let sent=0;const notifier={send:async()=>{sent++;await delay(30);return true;}};
  const workers=Array.from({length:3},()=>new MailWorker({store,config:{...config,smtp:{host:'fixture'}},notifier}));
  await Promise.all(workers.map(w=>w.deliver('security_mail')));assert.equal(sent,1);assert.equal(await db.prepare('SELECT id FROM security_mail WHERE id=?').get(row.id),undefined);
});
test('decimal FIFO keeps tiny lots and drawdown; currency and capital stay separate',()=>{
  const rows=[{user_id:'a',broker:'binance-global',symbol:'BTCUSDT',side:'BUY',quantity:'0.00000000000001',price:'100000',fee_quote:'0',signal_id:1,cumulative_quantity:'0.00000000000001',received_at:1},
    {user_id:'a',broker:'binance-global',symbol:'BTCUSDT',side:'SELL',quantity:'0.00000000000001',price:'200000',fee_quote:'0',signal_id:2,cumulative_quantity:'0.00000000000001',received_at:2}];
  const result=fifoAnalytics(rows);assert.equal(result.closedPositions.length,1);assert.equal(result.closedPositions[0].netPnl,'0.000000001');
  const metric=summarizeClosedPositions([{netPnl:'0.1',fees:'0',holdingMs:0,exitAt:1},{netPnl:'-0.3',fees:'0',holdingMs:0,exitAt:2}],{startingEquity:'1'});
  assert.equal(metric.netProfit,'-0.2');assert.equal(metric.maxDrawdown,'-0.3');assert.equal(metric.equityCurve[1].equity,'0.8');
  assert.equal(summarizeClosedPositions([]).profitFactor,null);
  const capital=analyticsCapital([{at:0,equity_delta:'0.1',kind:'CONFIGURATION'},{at:0,equity_delta:'0.2',kind:'CONFIGURATION'}],[],[],{from:0,to:10});assert.equal(capital.startingEquity,'0.3');
  assert.throws(()=>fifoAnalytics([...rows,{...rows[1],user_id:'b'}]),/exceeds/);
  const legacy=[{...rows[0],quantity:'0.1',price:'1',quote_amount:'0.1',legacy_float:1},{...rows[1],quantity:'0.10000000000000003',price:'2',quote_amount:'0.2',legacy_float:1}];
  const history=fifoAnalytics(legacy);assert.equal(history.closedPositions[0].netPnl,'0.1');assert.equal(history.legacyAdjustments.length,1);
  assert.throws(()=>fifoAnalytics(legacy.map(r=>({...r,legacy_float:0}))),/exceeds/);
});
test('PostgreSQL HTTP keeps cookie/MFA/CSRF, all bot pages and tenant isolation',async t=>{
  const a=await account(),other=await account();
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port,request=httpClient(base);
  const server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:url,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PAPER_TRADING:'true'}});
  let output='',exited=false;server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);server.on('exit',()=>exited=true);server.on('error',e=>output+=e.stack);
  t.after(async()=>{if(exited)console.error(output);if(!exited){server.kill('SIGTERM');await once(server,'exit');}});
  let ready=false;for(let i=0;i<100&&!exited;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}if(ready)break;await delay(50);}assert.ok(ready,output);
  const login=await request('/api/auth/login','POST',{email:a.email,password:'temporary-test-password'});assert.equal(login.status,200,JSON.stringify(login.body));
  assert.ok(login.cookies.some(c=>c.includes('HttpOnly')));const mfa=await enroll(request,login.session);
  const parallel=await Promise.all(['/api/me','/api/signals','/api/positions','/api/me/webhook-secret','/api/analytics/summary'].map(endpoint=>request(endpoint,'GET',undefined,login.session)));
  assert.deepEqual(parallel.map(r=>r.status),[200,200,200,200,200],JSON.stringify(parallel.map(r=>r.body)));
  for(const endpoint of ['/api/me','/api/bots','/api/signals','/api/positions','/api/risk','/api/brokers','/api/analytics/summary','/api/admin/health']){
    const result=await request(endpoint,'GET',undefined,login.session);assert.equal(result.status,200,endpoint+' '+JSON.stringify(result.body));
  }
  assert.equal((await request('/api/me?bot_id='+other.id,'GET',undefined,login.session)).status,403);
  const webhook='test-'+randomUUID();await store.setWebhookSecret(a.id,webhook,encryptJson({secret:webhook},config.keyring,'webhook:'+a.id));
  const body={trade_id:'http-duplicate',broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'1',entry:'0.1',sl:'0.09',timestamp:Date.now()};
  const burst=await Promise.all(Array.from({length:12},()=>fetch(base+'/webhooks/tradingview/'+webhook,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})));
  assert.equal(burst.filter(r=>r.status===202).length,1);assert.equal(burst.filter(r=>r.status===409).length,11);
  await drain();assert.equal((await store.listSignals(a.id)).length,1);
  const funding=await request('/api/risk','PUT',{equities:{'binance-global':'100.000000000000000001'},balances:{'binance-global':'100.000000000000000001'}},login.session);
  assert.equal(funding.status,200,JSON.stringify(funding.body));assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'99.900000000000000001');
  const preview=await request('/api/risk/preview','POST',{calculator:{broker:'binance-global',symbol:'BTCUSD',entry:'3.123456789123456789',stopLoss:'3',riskPercent:'1',volatilityPercent:0}},login.session);
  assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.ok,true);assert.equal(preview.body.order.price,'3.123456789123456789');
  await assert.rejects(db.transaction(()=>db.maintenanceLock()),/Stop every/);
  assert.equal((await request('/api/risk','PUT',{},login.session,{'x-csrf-token':'invalid'})).status,403);
  await request('/api/auth/logout','POST',{},login.session);
  const next=await request('/api/auth/login','POST',{email:a.email,password:'temporary-test-password'});assert.equal(next.body.mfaRequired,true);
  assert.equal((await request('/api/auth/mfa/login','POST',{code:mfa.recoveryCodes[0]},next.session)).status,200);
  assert.equal((await request('/api/me','GET',undefined,next.session)).status,200);
  await db.prepare('UPDATE user_security SET last_step=-1 WHERE user_id=?').run(a.id);
  const token='c'.repeat(64);await db.prepare('INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token),a.id,Date.now()+60000);
  const reset=await request('/api/auth/reset-password','POST',{token,newPassword:'replacement-test-password',code:mfa.recoveryCodes[1]});assert.equal(reset.status,200,JSON.stringify(reset.body));
  assert.equal((await request('/api/me','GET',undefined,next.session)).status,401);
  assert.ok((await db.prepare('SELECT mfa_secret FROM user_security WHERE user_id=?').get(a.id)).mfa_secret);
  assert.equal((await request('/api/auth/reset-password','POST',{token,newPassword:'another-test-password',code:mfa.recoveryCodes[2]})).status,400);
});

test('independent OS workers share the queue; SIGKILL before commit never double-spends',async t=>{
  const a=await account('2');await store.enqueue(a.id,signal('crash-process'));
  const children=[];t.after(async()=>{await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(async c=>{c.kill('SIGKILL');await once(c,'exit');}));});
  const launch=crash=>{const c=fork(new URL('./worker-fixture.mjs',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:url,TEST_CRASH:String(crash)}});children.push(c);return c;};
  const doomed=launch(true);assert.equal((await once(doomed,'message'))[0],'before-commit');doomed.kill('SIGKILL');await once(doomed,'exit');
  assert.equal((await store.listSignals(a.id))[0].status,'QUEUED');assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'2');
  for(let i=0;i<19;i++)await store.enqueue(a.id,signal('process-'+i));
  const peers=Array.from({length:4},()=>launch(false));
  const exits=await Promise.all(peers.map(c=>once(c,'exit')));assert.ok(exits.every(([code])=>code===0),JSON.stringify(exits));
  assert.equal((await store.listSignals(a.id)).filter(r=>r.status==='FILLED').length,20);assert.equal((await store.paperAccount(a.id,'binance-global')).cash,'0');
  assert.equal((await db.prepare('SELECT count(*) n FROM paper_cash_journal WHERE user_id=?').get(a.id)).n,20);
});
