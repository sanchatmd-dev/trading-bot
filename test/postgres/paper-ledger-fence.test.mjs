import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {D} from '../../src/money.js';
import {config} from '../../src/config.js';
import {hashPassword} from '../../src/security.js';
import {httpClient,enroll} from '../helpers.mjs';

// F4 fence call sites (design FD1-r2 slice S4, T1-T10 and T5b). A SERIALIZABLE request takes its snapshot during
// authentication; when a READ COMMITTED worker fill commits while the request waits for the Bot's users row lock, the request
// must not decide on cash that misses the fill. The fence turns that case into 40001. The dispatcher (CR1 b) then retries on
// a fresh snapshot, so the final answer is the one the true state gives; until slice S6 tightens them, the races accept
// either that answer or 409 RETRY_TRANSACTION, while the money assertions are exact. Ordering is deterministic: the worker
// is held before its commit and the request is seen waiting for the lock it holds. No sleep is used as synchronization.
let adminDb,db,store,databaseName,url,server,base,request,serverOut='',retryFile;

// The dispatcher logs one line per retry before it pauses (same preload as request-retry-http.test.mjs): every line here is
// written before the answer it belongs to arrives, so the count per request is exact.
const PRELOAD='--import=data:text/javascript;base64,'+Buffer.from([
  "import {appendFileSync} from 'node:fs';",
  'const file=process.env.FENCE_RETRY_LOG,warn=console.warn;',
  "console.warn=(...args)=>{if(file&&typeof args[0]==='string'&&args[0].startsWith('API request attempt '))appendFileSync(file,args[0]+'\\n');return warn.apply(console,args);};"
].join('\n')).toString('base64');
let retriesSeen=0;
// Retry lines since the last call; each must report the serialization failure the fence raises.
function retries(){
  const lines=fs.readFileSync(retryFile,'utf8').split('\n').filter(Boolean),fresh=lines.slice(retriesSeen);retriesSeen=lines.length;
  fresh.forEach((line,index)=>assert.equal(line,`API request attempt ${index+1} rolled back with SQLSTATE 40001; retrying`));
  return fresh.length;
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  adminDb=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_fence_test_'+randomUUID().replaceAll('-','');
  assert.match(databaseName,/^robot_fence_test_[a-f0-9]{32}$/);
  await adminDb.query('CREATE DATABASE '+databaseName);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;url=target.toString();
  db=new PostgresDatabase({connectionString:url,max:12});await db.migrate();store=new Store(db);
  await installQuantGuards(db);
  retryFile=path.join(os.tmpdir(),'fence-retry-'+randomUUID()+'.log');fs.writeFileSync(retryFile,'');
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  base='http://127.0.0.1:'+port;request=httpClient(base);
  const nodeOptions=[process.env.NODE_OPTIONS,PRELOAD].filter(Boolean).join(' ');
  server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:url,HOST:'127.0.0.1',PORT:String(port),
    PUBLIC_ORIGIN:base,SMTP_HOST:'',PAPER_TRADING:'true',NODE_OPTIONS:nodeOptions,FENCE_RETRY_LOG:retryFile}});
  server.stdout.on('data',chunk=>serverOut+=chunk);server.stderr.on('data',chunk=>serverOut+=chunk);
  let ready=false;
  for(let i=0;i<200&&server.exitCode===null;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}if(ready)break;await delay(50);}
  assert.ok(ready,serverOut);
});
after(async()=>{
  if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}
  await db?.close();
  if(adminDb){if(databaseName)await adminDb.query('DROP DATABASE '+databaseName);await adminDb.close();}
  if(retryFile)fs.rmSync(retryFile,{force:true});
});

const BROKER='binance-global';
const policy=(equity,cash=equity,overrides={})=>({...structuredClone(config.defaultRisk),maxTradesPerDay:100,maxOpenPositions:10,blockHighVolatility:false,
  blockDuringNews:false,equities:{[BROKER]:equity},balances:{[BROKER]:cash},...overrides});
async function account(equity='100',cash=equity,overrides){
  const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword('temporary-test-password'),role:'ADMIN'});
  await store.setRisk(user.id,policy(equity,cash,overrides));
  const login=await request('/api/auth/login','POST',{email:user.email,password:'temporary-test-password'});assert.equal(login.status,200);
  await enroll(request,login.session);return {user,session:login.session};
}
// BUY 400 at 0.1: notional 40, so a Bot funded with 100 cash holds 60 after the fill.
const buy=(tradeId,overrides={})=>normalizeSignal({trade_id:tradeId,broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'400',entry:'0.1',sl:'0.09',timestamp:Date.now(),...overrides});
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Error(label+' did not settle within 15 seconds\n'+serverOut.slice(-2000))),15000);})]);}finally{clearTimeout(timer);}}
// A worker tick that stops after its fill is written and before COMMIT, holding the Bot's users row lock.
function heldWorker(){
  let release,reached;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>reached=resolve);
  const worker=new ExecutionWorker({store,config,beforeCommit:async()=>{reached();await gate;}});
  return {tick:worker.tick(),entered,release};
}
// The request has its snapshot and now waits for a lock the held transaction owns.
async function lockWaiter(label){
  for(let i=0;i<300;i++){
    const {rows:[row]}=await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if(row.n>0)return;await delay(25);
  }
  throw Error(label+': no request waited for the held Bot lock');
}
// Runs send() while a worker holds a written, uncommitted fill of the Bot's oldest queued signal, then lets the fill commit.
async function underHeldFill(send,label){
  const worker=heldWorker();
  await bounded(worker.entered,label+' worker');
  const answer=send();
  try{await lockWaiter(label);}finally{worker.release();}
  assert.equal(await bounded(worker.tick,label+' worker commit'),true);
  return await bounded(answer,label+' request');
}
const fenceVersion=async id=>{const row=(await db.query('SELECT version FROM public.paper_ledger_fence WHERE user_id=$1',[id])).rows[0];return row?Number(row.version):null;};
const cash=async id=>(await store.paperAccount(id,BROKER)).cash;
const funding=id=>db.prepare('SELECT equity_delta,cash_delta,kind FROM paper_funding WHERE user_id=? AND broker=? ORDER BY id').all(id,BROKER);
const fundingSnapshots=id=>db.prepare("SELECT cash,book_equity,position_cost FROM paper_snapshots WHERE user_id=? AND broker=? AND reason='FUNDING' ORDER BY id").all(id,BROKER);
const signalRow=(id,tradeId)=>db.prepare('SELECT status,error_message FROM signals WHERE user_id=? AND trade_id=?').get(id,tradeId);
// NUMERIC columns come back with 18 places; compare values, not spellings.
const same=(a,b,label)=>assert.equal(D(String(a)).toFixed(),D(String(b)).toFixed(),label);
// A race either ends with the answer the true state gives, after at least one 40001 retry, or with 409 RETRY_TRANSACTION.
function raced(t,answer,retryCount,expected,label){
  t.diagnostic(label+': answer '+answer.status+(answer.body?.code?' '+answer.body.code:'')+' after '+retryCount+' retries');
  assert.ok(retryCount>=1,label+': the fence raised 40001 at least once (answer '+answer.status+' '+JSON.stringify(answer.body)+')');
  if(answer.status===409){assert.equal(answer.body.code,'RETRY_TRANSACTION',label);return false;}
  expected(answer);return true;
}
const refusedWithdrawal=answer=>{assert.equal(answer.status,400,JSON.stringify(answer.body));assert.match(answer.body.error,/withdrawal exceeds unreserved funds/);};
const withdraw={equities:{[BROKER]:'20'},balances:{[BROKER]:'20'}};

test('T1 a cash withdrawal that waited for the Bot lock behind a fill is refused on the cash after the fill',async t=>{
  const {user,session}=await account('100');
  assert.equal(await store.enqueue(user.id,buy('t1-buy')),true);
  const rows=await funding(user.id),snapshots=await fundingSnapshots(user.id),version=await fenceVersion(user.id);retries();
  const answer=await underHeldFill(()=>request('/api/risk','PUT',withdraw,session),'T1');
  raced(t,answer,retries(),refusedWithdrawal,'T1');
  same(await cash(user.id),'60');
  assert.deepEqual(await funding(user.id),rows,'no funding row');
  assert.deepEqual(await fundingSnapshots(user.id),snapshots,'no FUNDING snapshot');
  assert.equal(await fenceVersion(user.id),version+1,'only the fill moved the fence; every request attempt rolled back');
  assert.equal((await signalRow(user.id,'t1-buy')).status,'FILLED');
});

test('T2 control: the same withdrawal after the fill committed is refused at once, with no retry',async()=>{
  const {user,session}=await account('100');
  assert.equal(await store.enqueue(user.id,buy('t2-buy')),true);
  assert.equal(await new ExecutionWorker({store,config}).tick(),true);
  const rows=await funding(user.id),version=await fenceVersion(user.id);retries();
  refusedWithdrawal(await request('/api/risk','PUT',withdraw,session));
  assert.equal(retries(),0);
  same(await cash(user.id),'60');assert.deepEqual(await funding(user.id),rows);
  assert.equal(await fenceVersion(user.id),version,'a refused request leaves the fence as it was');
});

test('T3 an equity-only withdrawal during a fill is decided and snapshotted on the state after the fill',async t=>{
  // Equity 100 with 50 cash; the fill moves 40 cash into position cost. Book equity minus position cost is configured equity
  // plus the cash movement and never below cash, so once the cash check passes the equity check cannot refuse: this race is
  // accepted either way. Before the fence the FUNDING snapshot recorded the stale state (cash 50, position cost 0).
  const {user,session}=await account('100','50');
  assert.equal(await store.enqueue(user.id,buy('t3-buy')),true);
  const version=await fenceVersion(user.id);retries();
  const answer=await underHeldFill(()=>request('/api/risk','PUT',{equities:{[BROKER]:'60'},balances:{[BROKER]:'50'}},session),'T3');
  const applied=raced(t,answer,retries(),result=>assert.equal(result.status,200,JSON.stringify(result.body)),'T3');
  same(await cash(user.id),'10');
  if(applied){
    const last=(await funding(user.id)).at(-1);same(last.equity_delta,'-40');same(last.cash_delta,'0');
    const snapshot=(await fundingSnapshots(user.id)).at(-1);
    assert.deepEqual([snapshot.cash,snapshot.book_equity,snapshot.position_cost].map(Number),[10,60,40],'the FUNDING snapshot includes the fill');
    assert.equal(await fenceVersion(user.id),version+2,'the fill and the accepted request');
  }
});

test('T4 a deposit during a fill is written once, on the state after the fill',async t=>{
  const {user,session}=await account('100');
  assert.equal(await store.enqueue(user.id,buy('t4-buy')),true);
  const before=(await funding(user.id)).length;retries();
  const deposit={equities:{[BROKER]:'150'},balances:{[BROKER]:'150'}};
  let answer=await underHeldFill(()=>request('/api/risk','PUT',deposit,session),'T4');
  if(!raced(t,answer,retries(),result=>assert.equal(result.status,200,JSON.stringify(result.body)),'T4')){
    // A client retry after 409 starts a new snapshot that already includes the fill.
    answer=await request('/api/risk','PUT',deposit,session);assert.equal(answer.status,200,JSON.stringify(answer.body));
  }
  const rows=await funding(user.id);
  assert.equal(rows.length,before+1,'exactly one deposit row');same(rows.at(-1).equity_delta,'50');same(rows.at(-1).cash_delta,'50');
  same(await cash(user.id),'110');
  const snapshot=(await fundingSnapshots(user.id)).at(-1);
  assert.deepEqual([snapshot.cash,snapshot.position_cost].map(Number),[110,40],'the FUNDING snapshot includes the fill');
});

test('T5 a run from SETUP during a fill stores initial_capital equal to the cash after the fill',async t=>{
  const {user,session}=await account('100');
  assert.equal(await store.enqueue(user.id,buy('t5-buy')),true);retries();
  let answer=await underHeldFill(()=>request('/api/bot/session/run','POST',{},session),'T5');
  if(!raced(t,answer,retries(),result=>assert.equal(result.status,200,JSON.stringify(result.body)),'T5')){
    answer=await request('/api/bot/session/run','POST',{},session);assert.equal(answer.status,200,JSON.stringify(answer.body));
  }
  const stored=await store.getBotSession(user.id);
  assert.equal(stored.state,'RUNNING');
  same(JSON.parse(stored.initial_capital)[BROKER],'60');
});

test('T5b a resume from PAUSED during a reduce-only exit fill takes no fence and answers 200 without a retry',async()=>{
  const {user,session}=await account('100');
  assert.equal(await store.enqueue(user.id,buy('t5b-buy')),true);
  assert.equal(await new ExecutionWorker({store,config}).tick(),true);
  assert.equal((await request('/api/bot/session/run','POST',{},session)).status,200);
  assert.equal((await request('/api/bot/session/pause','POST',{},session)).status,200);
  const paused=await store.getBotSession(user.id);
  same(JSON.parse(paused.initial_capital)[BROKER],'60');
  assert.equal(await store.enqueue(user.id,buy('t5b-exit',{event:'SELL',reduce_only:true,quantity:undefined})),true);retries();
  const answer=await underHeldFill(()=>request('/api/bot/session/run','POST',{},session),'T5b');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.equal(retries(),0,'a resume reads no Paper state, so the exit fill cannot make it retry');
  const resumed=await store.getBotSession(user.id);
  assert.equal(resumed.state,'RUNNING');assert.equal(resumed.run_id,paused.run_id);assert.equal(resumed.initial_capital,paused.initial_capital);
  assert.equal((await signalRow(user.id,'t5b-exit')).status,'FILLED');
  same(await cash(user.id),'100');
});

test('T6 a child Bot: the fence is keyed by the child, for funding and for run, and the owner fence does not move',async t=>{
  const {user:owner,session}=await account('100');
  const child=await store.createBot(owner.id,'Fence child',policy('100'));
  const ownerVersion=await fenceVersion(owner.id),childVersion=await fenceVersion(child.id);
  assert.equal(await store.enqueue(child.id,buy('t6-buy')),true);retries();
  const answer=await underHeldFill(()=>request('/api/risk?bot_id='+child.id,'PUT',withdraw,session),'T6 funding');
  raced(t,answer,retries(),refusedWithdrawal,'T6 funding');
  same(await cash(child.id),'60');
  assert.equal(await fenceVersion(child.id),childVersion+1);
  assert.equal(await store.enqueue(child.id,buy('t6-buy-2')),true);
  let run=await underHeldFill(()=>request('/api/bot/session/run?bot_id='+child.id,'POST',{},session),'T6 run');
  if(!raced(t,run,retries(),result=>assert.equal(result.status,200,JSON.stringify(result.body)),'T6 run')){
    run=await request('/api/bot/session/run?bot_id='+child.id,'POST',{},session);assert.equal(run.status,200,JSON.stringify(run.body));
  }
  same(JSON.parse((await store.getBotSession(child.id)).initial_capital)[BROKER],'20');
  assert.ok(childVersion>=1,'the child Bot got its own fence row at creation');
  assert.equal(await fenceVersion(owner.id),ownerVersion,'the owner fence is untouched');
  same(await cash(owner.id),'100');
});

test('T7 reverse order: a worker that waited for the Bot lock behind a committed withdrawal refuses the BUY on the new cash',async()=>{
  // A child Bot, so the worker locks the owner first and then waits on the child row (the owner row is taken SKIP LOCKED).
  const {user:owner}=await account('100');
  const child=await store.createBot(owner.id,'Reverse child',policy('100'));
  assert.equal(await store.enqueue(child.id,buy('t7-buy')),true);
  const version=await fenceVersion(child.id);
  let release,held;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>held=resolve);
  const saving=db.transaction(async()=>{await store.setRisk(child.id,policy('20'));held();await gate;},{isolation:'SERIALIZABLE'});
  await bounded(entered,'T7 request');
  const tick=new ExecutionWorker({store,config}).tick();
  try{await lockWaiter('T7');}finally{release();}
  await bounded(saving,'T7 request commit');
  assert.equal(await bounded(tick,'T7 worker'),true);
  const row=await signalRow(child.id,'t7-buy');
  assert.equal(row.status,'REJECTED','the worker read the committed withdrawal after its lock');
  same(await cash(child.id),'20');
  assert.equal(await fenceVersion(child.id),version+1,'the withdrawal moved the fence; the refused BUY wrote no fill');
});

test('T8 with the Bot fence row deleted, the fill inserts it and the waiting request still fails with 40001',async t=>{
  const {user,session}=await account('100');
  assert.equal(await store.enqueue(user.id,buy('t8-buy')),true);
  assert.equal((await db.query('DELETE FROM public.paper_ledger_fence WHERE user_id=$1',[user.id])).rowCount,1);
  const rows=await funding(user.id);retries();
  const answer=await underHeldFill(()=>request('/api/risk','PUT',withdraw,session),'T8');
  raced(t,answer,retries(),refusedWithdrawal,'T8');
  same(await cash(user.id),'60');assert.deepEqual(await funding(user.id),rows);
  assert.equal(await fenceVersion(user.id),1,'the fill inserted the row; the request insert rolled back');
  // No race: a funding save on a Bot without a fence row (an imported or pre-fence Bot) creates the row.
  const other=await account('100');
  await db.query('DELETE FROM public.paper_ledger_fence WHERE user_id=$1',[other.user.id]);
  const deposit=await request('/api/risk','PUT',{equities:{[BROKER]:'120'},balances:{[BROKER]:'120'}},other.session);
  assert.equal(deposit.status,200,JSON.stringify(deposit.body));assert.equal(retries(),0);
  assert.equal(await fenceVersion(other.user.id),1);
});

test('T9 a PF-4 apply that waited behind a fill is never saved on the state before the fill',async t=>{
  const LIMITS={loss_per_trade_percent:'1',order_notional_ceiling:'500',daily_notional_ceiling:'30000',allow_repeated_entries:false};
  const {user,session}=await account('1000','800',{capPercentEquitySize:false,maxRiskPercent:5,maxOrderNotional:'2000',maxDailyNotional:'20000'});
  const preview=await request('/api/risk/proposals/preview','POST',{declared:LIMITS},session);
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  const proposal=preview.body.proposal;
  assert.ok(proposal.changes.length>0&&proposal.after_policy_hash,'the proposal changes the policy');
  const body={base_policy_hash:proposal.base_policy_hash,proposal_hash:proposal.proposal_hash,declared:LIMITS,confirm:'SAVE_RISK_PROPOSAL'};
  assert.equal(await store.enqueue(user.id,buy('t9-buy')),true);
  const policyBefore=JSON.stringify(await store.risk(user.id,config.defaultRisk)),rows=await funding(user.id);retries();
  const answer=await underHeldFill(()=>request('/api/risk/proposals/apply','POST',body,session),'T9');
  const count=retries();
  t.diagnostic('T9: answer '+answer.status+(answer.body?.code?' '+answer.body.code:'')+' after '+count+' retries');
  assert.ok(count>=1,'the fence raised 40001 at least once (answer '+answer.status+' '+JSON.stringify(answer.body)+')');
  if(answer.status===200){
    // Applied on a retry whose snapshot includes the fill: the PF-4 funding invariant held on the true state.
    assert.equal(answer.body.saved,true);
  }else{
    assert.equal(answer.status,409,JSON.stringify(answer.body));
    assert.ok(['RETRY_TRANSACTION','STALE_POLICY_STATE','PROPOSAL_STALE','CAPITAL_DRIFT'].includes(answer.body.code),JSON.stringify(answer.body));
    assert.equal(JSON.stringify(await store.risk(user.id,config.defaultRisk)),policyBefore,'policy unchanged');
  }
  assert.deepEqual(await funding(user.id),rows,'a PF-4 save never writes funding');
  same(await cash(user.id),'760');
});
