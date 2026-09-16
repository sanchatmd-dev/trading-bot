import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {Store} from '../src/database.js';
import {Worker,NotificationWorker} from '../src/worker.js';
import {config} from '../src/config.js';
import {readJson,RateLimiter,booleanValue,clientIp} from '../src/http-safety.js';
import {encryptJson,decryptJson} from '../src/security.js';
import {executeOrder,validateCredentials} from '../src/adapters/registry.js';
import {DatabaseSync} from 'node:sqlite';
import {backupDatabase} from '../scripts/backup.mjs';
import {acquireProcessLock} from '../src/process-lock.js';
import {resetPassword} from '../scripts/reset-password.mjs';
import {hashPassword,verifyPassword} from '../src/security.js';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'astra-hardening-'));
  const filename=path.join(dir,'db.sqlite');
  const store=new Store(filename);
  const user=store.createUser({email:'test@example.test',passwordHash:'not-used',role:'ADMIN'});
  store.setRisk(user.id,{...config.defaultRisk,equities:{'binance-global':10000}});
  t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  return {store,user,filename};
}
const signal=(tradeId='buy')=>({tradeId,broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',
  timestamp:Date.now(),riskMode:'QUANTITY',quantity:10,referencePrice:100,stopLoss:90,leverage:1,newsRisk:false,volatilityPercent:0});
function claim(store,user,s,mode='PAPER') {store.enqueue(user.id,s,mode);return store.claimNext();}
function fill(store,row,qty,quote,status='FILLED',extra={}) {
  const order={...row.payload,quantity:row.payload.quantity,price:row.payload.referencePrice};
  store.recordExecution(row,{status,orderId:'test-order',executedQty:qty,quoteQty:quote,raw:{status},...extra},order);
}

test('paper processing freezes mode even after profile changes',async t=>{
  const {store,user}=fixture(t);
  store.enqueue(user.id,signal(),'PAPER');
  store.setRisk(user.id,{...config.defaultRisk,paperTrading:false,equities:{'binance-global':10000}});
  await new Worker({store,config}).tick();
  const row=store.listSignals(user.id)[0];
  assert.equal(row.status,'FILLED');assert.equal(row.execution_mode,'PAPER');
  assert.equal(store.ledgerPosition({...row,execution_mode:'LIVE'}).quantity,0);
});

test('worker rejects live jobs without calling a broker',async t=>{
  const {store,user}=fixture(t);store.enqueue(user.id,signal(),'LIVE');
  await new Worker({store,config}).tick();
  assert.match(store.listSignals(user.id)[0].error_message,/Live execution is disabled/);
});

test('restart quarantines processing orders instead of resending',t=>{
  const {store,user,filename}=fixture(t);
  const row=claim(store,user,signal());store.persistIntent(row,{quantity:10});store.close();
  const reopened=new Store(filename);
  try{assert.equal(reopened.claimNext(),null);assert.equal(reopened.listSignals(user.id)[0].status,'UNKNOWN');}
  finally{reopened.close();}
});

test('cumulative fills are idempotent; partial losses add to exactly one R',t=>{
  const {store,user}=fixture(t),buy=claim(store,user,signal());fill(store,buy,10,1000);
  const sell=claim(store,user,{...signal('sell'),side:'SELL',event:'SL',reduceOnly:true,referencePrice:90});
  fill(store,sell,5,450,'PARTIALLY_FILLED');
  fill(store,sell,5,450,'PARTIALLY_FILLED');
  assert.equal(store.ledgerDaily(sell).realized_r,-.5);
  assert.equal(store.ledgerDaily(sell).loss_streak,0);
  fill(store,sell,10,900);
  assert.equal(store.ledgerDaily(sell).realized_r,-1);
  assert.equal(store.ledgerDaily(sell).loss_streak,1);
  assert.equal(store.ledgerPosition(sell).quantity,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM fills').get().n,3);
});

test('fill, position and statistics roll back together on invalid response',t=>{
  const {store,user}=fixture(t),row=claim(store,user,signal());
  assert.throws(()=>fill(store,row,10,1000,'SURPRISE'),/Unknown broker/);
  assert.equal(store.ledgerPosition(row).quantity,0);
  assert.equal(store.ledgerDaily(row).trades,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM fills').get().n,0);
});

test('pending buys count toward exposure and reserve symbols',t=>{
  const {store,user}=fixture(t),row=claim(store,user,signal());
  store.complete(row.id,'SUBMITTED',{orderId:'pending'});
  const other={...row,id:999,symbol:'ETHUSDT'};
  assert.equal(store.exposure(other).openPositions,1);
  assert.equal(store.exposure({...row,id:999}).hasPendingOrder,true);
});

test('unique trade ids can scale into one aggregated Spot position',async t=>{
  const {store,user}=fixture(t);
  assert.equal(store.enqueue(user.id,signal('scale-1')),true);await new Worker({store,config}).tick();
  assert.equal(store.enqueue(user.id,signal('scale-2')),true);await new Worker({store,config}).tick();
  assert.equal(store.enqueue(user.id,signal('scale-2')),false);
  const position=store.listPositions(user.id)[0],logs=store.listSignals(user.id);
  assert.equal(position.symbol,'BTCUSDT');assert.equal(position.quantity,20);
  assert.deepEqual(logs.map(x=>x.status),['FILLED','FILLED']);
});

test('suspended user cannot execute already queued signal',async t=>{
  const {store,user}=fixture(t);store.enqueue(user.id,signal());store.setUserStatus(user.id,'SUSPENDED');
  await new Worker({store,config}).tick();
  assert.match(store.listSignals(user.id)[0].error_message,/suspended/);
});

test('failed reconciliation rotates and still processes queue',async t=>{
  const {store,user}=fixture(t);
  const first=claim(store,user,signal('old-1'),'LIVE');store.complete(first.id,'SUBMITTED',{orderId:'one'});
  const second=claim(store,user,signal('old-2'),'LIVE');store.complete(second.id,'SUBMITTED',{orderId:'two'});
  store.enqueue(user.id,{...signal('new'),broker:'binance-th',symbol:'BTCTHB'});
  const worker=new Worker({store,config});await worker.tick();
  assert.equal(store.pendingForReview().id,second.id);
  assert.notEqual(store.listSignals(user.id)[0].status,'QUEUED');
});

test('password change and suspension revoke existing sessions',t=>{
  const {store,user}=fixture(t);store.createSession(user.id,'token',Date.now()+100000);
  store.setPassword(user.id,'new-hash');assert.equal(store.session('token'),undefined);
  store.createSession(user.id,'token2',Date.now()+100000);store.setUserStatus(user.id,'SUSPENDED');
  assert.equal(store.session('token2'),undefined);
});

test('credentials are bound to tenant and custom URLs are rejected',()=>{
  const cipher=encryptJson({apiKey:'key'},'master','tenant-a:broker');
  assert.throws(()=>decryptJson(cipher,'master','tenant-b:broker'));
  assert.equal(decryptJson(cipher,'master','tenant-a:broker').apiKey,'key');
  assert.throws(()=>validateCredentials('binance-global',{apiKey:'a',apiSecret:'b',baseUrl:'http://127.0.0.1'}),/not allowed/);
});

test('all broker live entry points are disabled',async()=>{
  for(const broker of ['binance-global','binance-th','innovestx','mt5','settrade','future-http'])
    await assert.rejects(executeOrder(broker),/disabled/);
});

test('bounded request parser and limiter reject abuse',async()=>{
  const request=new PassThrough(),read=readJson(request);
  request.end(Buffer.alloc(65537));await assert.rejects(read,/too large/);
  const array=new PassThrough(),parsed=readJson(array);array.end('[]');await assert.rejects(parsed,/object/);
  const limiter=new RateLimiter({limit:1,maxKeys:1,windowMs:10});
  assert.equal(limiter.accept('a',0),true);assert.equal(limiter.accept('a',1),false);
  assert.equal(limiter.accept('b',2),false);assert.equal(limiter.accept('b',11),true);
  assert.throws(()=>booleanValue('false','flag'),/true or false/);
});

test('proxy address is trusted only from loopback and takes the last hop',()=>{
  assert.equal(clientIp({socket:{remoteAddress:'8.8.8.8'},headers:{'x-forwarded-for':'1.1.1.1'}},true),'8.8.8.8');
  assert.equal(clientIp({socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'spoofed, 1.1.1.1'}},true),'1.1.1.1');
  assert.equal(clientIp({socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'1.1.1.1'}},false),'127.0.0.1');
});

test('notification failure is persisted and retried without affecting fills',async t=>{
  const {store,user}=fixture(t),row=claim(store,user,signal());fill(store,row,10,1000);
  const worker=new NotificationWorker({store,notifier:{config:{host:'fake'},send:async()=>false}});
  await worker.tick();
  const outbox=store.db.prepare('SELECT * FROM notification_outbox').get();
  assert.equal(outbox.attempts,1);assert.equal(outbox.status,'PENDING');assert.equal(store.ledgerPosition(row).quantity,10);
});

test('backup restores fills and encrypted secrets and refuses overwrite',t=>{
  const {store,user,filename}=fixture(t),row=claim(store,user,signal());fill(store,row,10,1000);
  store.setCredential(user.id,'binance-global',encryptJson({apiKey:'test-only',apiSecret:'test-only'},'master',`${user.id}:binance-global`));
  const target=path.join(path.dirname(filename),'snapshot.db');
  backupDatabase(filename,target);
  assert.throws(()=>backupDatabase(filename,target),/new file/);
  const restored=new Store(target);
  try{
    assert.equal(restored.ledgerPosition(row).quantity,10);
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(decryptJson(restored.credential(user.id,'binance-global').encrypted_data,'master',`${user.id}:binance-global`).apiKey,'test-only');
  }finally{restored.close();}
});

test('backup CLI recognizes a symlink-style argv path',async t=>{
  const {filename}=fixture(t),dir=path.dirname(filename),target=path.join(dir,'cli.db');
  const originalArgv=process.argv,originalDb=process.env.DB_PATH;
  process.argv=[process.execPath,'/release/current/scripts/backup.mjs',target];process.env.DB_PATH=filename;
  try{await import(`../scripts/backup.mjs?test=${Date.now()}`);}finally{process.argv=originalArgv;if(originalDb===undefined)delete process.env.DB_PATH;else process.env.DB_PATH=originalDb;}
  assert.equal(fs.existsSync(target),true);
});

test('legacy migration preserves old positions and quarantines ambiguous orders',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'astra-migration-')),filename=path.join(dir,'old.db');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const old=new DatabaseSync(filename);
  old.exec(`CREATE TABLE signals(id INTEGER PRIMARY KEY,user_id TEXT,trade_id TEXT,status TEXT,payload TEXT,error_message TEXT);
    INSERT INTO signals VALUES(1,'legacy-user','queued','QUEUED','{}',NULL);
    INSERT INTO signals VALUES(2,'legacy-user','interrupted','PROCESSING','{}',NULL);
    CREATE TABLE positions(user_id TEXT,broker TEXT,symbol TEXT,quantity REAL);
    INSERT INTO positions VALUES('legacy-user','binance-global','BTCUSDT',2);`);
  old.close();
  const store=new Store(filename);
  try{
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,8);
    assert.equal(store.db.prepare('SELECT quantity FROM positions').get().quantity,2);
    assert.equal(store.listPositions('legacy-user').length,0);
    assert.equal(store.db.prepare('SELECT status FROM signals WHERE id=1').get().status,'REJECTED');
    assert.equal(store.db.prepare('SELECT status FROM signals WHERE id=2').get().status,'UNKNOWN');
  }finally{store.close();}
});

test('schema 6 enables repeated-symbol entries and schema 7 adds tenant fee settings',t=>{
  const {store,user,filename}=fixture(t);
  store.setRisk(user.id,{...config.defaultRisk,onePositionPerSymbol:true});
  store.db.exec('DROP TRIGGER bot_parent_guard; DROP INDEX idx_bot_slot; DROP INDEX idx_bot_parent; ALTER TABLE users DROP COLUMN parent_user_id; ALTER TABLE users DROP COLUMN bot_slot_index; ALTER TABLE users DROP COLUMN label; PRAGMA user_version=5');store.close();
  const reopened=new Store(filename);
  try{assert.equal(reopened.risk(user.id,config.defaultRisk).onePositionPerSymbol,false);assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,8);reopened.setAnalyticsFeeBps(user.id,'binance-global',7.5);assert.equal(reopened.analyticsFeeBps(user.id,'binance-global'),7.5);}
  finally{reopened.close();}
});

test('single-instance lock prevents competing workers and releases cleanly',t=>{
  const {filename}=fixture(t),release=acquireProcessLock(filename);
  assert.throws(()=>acquireProcessLock(filename),/Another process/);
  release();acquireProcessLock(filename)();
});

test('daily loss streak survives day rollover',t=>{
  const {store,user}=fixture(t),buy=claim(store,user,signal());fill(store,buy,10,1000);
  const sell=claim(store,user,{...signal('sell'),side:'SELL',event:'SL',reduceOnly:true,referencePrice:90});fill(store,sell,10,900);
  store.db.prepare("UPDATE ledger_daily SET day='2000-01-01'").run();
  assert.equal(store.ledgerDaily(sell).trades,0);assert.equal(store.ledgerDaily(sell).loss_streak,1);
});

test('graceful stop waits for the active worker',async t=>{
  const {store}=fixture(t),worker=new Worker({store,config});
  let release;
  worker.tick=()=>new Promise(resolve=>{release=resolve;});worker.run();
  let stopped=false;const stopping=worker.stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);release();await stopping;assert.equal(stopped,true);
});

test('admin password reset changes hash, revokes sessions and audits',async t=>{
  const {store,user,filename}=fixture(t);
  store.setPassword(user.id,await hashPassword('old-password-value'));
  store.createSession(user.id,'old-session',Date.now()+100000);
  await resetPassword({databasePath:filename,email:user.email,password:'new-password-value'});
  assert.equal(store.session('old-session'),undefined);
  assert.equal(await verifyPassword('new-password-value',store.userByEmail(user.email).password_hash),true);
  assert.equal(store.db.prepare("SELECT count(*) n FROM audit WHERE event='account.password.admin_reset'").get().n,1);
});
