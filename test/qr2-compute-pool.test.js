import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn as spawnProcess} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {D} from '../src/money.js';
import {computeQr2View} from '../src/postgres/qr2-reader.js';
import {resolveRange} from '../src/portfolio/qr2-periods.js';
import {validateBoundaryRecord} from '../src/portfolio/qr2-boundaries.js';
import {Qr2Error} from '../src/portfolio/qr2-constants.js';
import {composePerformanceResponse} from '../src/portfolio/qr2-response.js';
import {executeQr2Job,QR2_WORKER_ROLE as WORKER_ROLE} from '../src/postgres/qr2-compute-worker.js';
import {createQr2ComputePool,Qr2ComputeFailure,QR2_COMPUTE_DEADLINE_MS,QR2_COMPUTE_RESOURCE_LIMITS,QR2_WORKER_ROLE as POOL_ROLE} from '../src/postgres/qr2-compute-pool.js';
import {qr2PerformanceRoute,createQr2Slot} from '../src/postgres/qr2-routes.js';

// QR-2 S3b (RC-Q35): worker-thread compute pool and route mapping. No database: the snapshot is hand-built in the exact shape readQr2Snapshot
// returns, the route runs on a stub store, and test workers are small eval scripts (pool spawn seam). Timing bounds are generous (thread
// start and terminate differ between Windows and Linux).
const here=path.dirname(fileURLToPath(import.meta.url));
const SRC=path.join(here,'..','src');
const B=1790812800000,MIN=60000,DAY=86400000;
const BOT='bot-1',OWNER='owner-1',BROKER='binance-global',ACCOUNT=BROKER+':primary';
const NOW=B+2*60*MIN;
const BOUNDARIES=validateBoundaryRecord({record_id:'LOCAL_FIXTURE_E2',epochs:[{epoch:'E2',from:0,to:null}],lot_fee_boundary:0,lot_table_boundary:0,evidence:'docs/evidence/local-test-record.json'});
const LIMITS=Object.freeze({ledger_rows:5000,grid_instants:5000,audit_rows:2000,pending_orders:1000});
const sortedJson=v=>Array.isArray(v)?'['+v.map(sortedJson).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+sortedJson(v[k])).join(',')+'}':JSON.stringify(v);
const sha=text=>createHash('sha256').update(text).digest('hex');

function bar(barTime,close){
  const b={time:barTime,open:String(close),high:String(close),low:String(close),close:String(close),volume:'1',atr14:'1',price_tick:'0.01',quantity_step:'0.00001'};
  return {broker:BROKER,symbol:'BTCUSDT',timeframe:'1',bar_time:barTime,bar:b,provenance:{profile:'closed-ohlcv-atr14-v1'},content_hash:sha(sortedJson(b))};
}
const own={user_id:BOT,broker:BROKER,account_id:ACCOUNT,execution_mode:'PAPER'};
function fill(signal,side,qty,price,quote,at,{payload='{}',mode='PAPER',trade}={}){
  return {signal_id:signal,cumulative_quantity:qty,delta_quantity:qty,price,fee_quote:'0',quote_amount:quote,legacy_float:0,received_at:at,...own,execution_mode:mode,side,symbol:'BTCUSDT',
    trade_id:trade??'T'+signal,payload,slippage_bps:null,has_intent:false,ledger_rule:'paper-exit-cost-v2'};
}
const journalOf=(f,cash)=>({signal_id:f.signal_id,cumulative_quantity:f.cumulative_quantity,user_id:f.user_id,broker:BROKER,cash_delta:cash,at:f.received_at,execution_mode:f.execution_mode,account_id:ACCOUNT});

// One snapshot: a BUY of 0.01 at 60000 and a SELL of 0.004 at 61000 (cash 9644, 0.006 BTC left, cost 360), BTCUSDT bars every minute.
function snapshotOf({targeted=false,mode='PAPER',oversell=false,unresolved=false}={}){
  const buy=fill(1,'BUY','0.01','60000','600',B+MIN,{mode});
  const sell=oversell?fill(2,'SELL','1','61000','61000',B+2*MIN):fill(2,'SELL','0.004','61000','244',B+2*MIN,{payload:targeted?'{"targetTradeId":"T1"}':'{}'});
  const fundings=[{id:1,user_id:BOT,broker:BROKER,at:B,equity_delta:'10000',cash_delta:'10000',kind:'CONFIGURATION'}];
  const fills=[buy,sell];
  const journal=[journalOf(buy,'-600'),journalOf(sell,oversell?'61000':'244')];
  const lots=[{position_id:'L1',...own,broker:BROKER,symbol:'BTCUSDT',entry_signal_id:1,entry_trade_id:'T1',status:'OPEN',filled_quantity:'0.01',remaining_quantity:'0.006',entry_price:'60000',opened_at:B+MIN,closed_at:null}];
  const positions=[{...own,symbol:'BTCUSDT',quantity:'0.006',cost_basis:'360',cumulative_pnl:'4'}];
  const market={checked:true,table_present:true,instants:0,rows:[],cutoff_bar_time:null};
  for(let t=B;t<=NOW;t+=MIN)market.rows.push(bar(t,60000+((t-B)/MIN)%7));
  market.cutoff_bar_time=NOW;
  const range=unresolved?resolveRange({from:NOW,to:NOW+DAY,requestTime:NOW,coverageStart:B}):resolveRange({from:B,to:NOW+DAY,requestTime:NOW,coverageStart:B});
  const snapshot={isolation:'repeatable read',read_only:true,owner:{id:BOT,parent_user_id:OWNER,created_at:B},coverageStart:B,range,
    counts:{fundings:'1',journal:'2',fills:'2',lots:'1',snapshots:'0',total:6},fundings,fills,journal,lots,positions,cash:'9644',snapshots:[],auditRows:[],pending:[],
    exposure:{reservedNotional:'0',reservedFees:'0',feeReservationUnknown:false,uncertain:false},exposureError:false,market:{...market,instants:market.rows.length},
    cutoffs:{max_funding_id:1,max_snapshot_id:0,fill_count:2,last_fill:{received_at:sell.received_at,signal_id:2,cumulative_quantity:sell.cumulative_quantity},lot_count:1,market_data_cutoff:NOW}};
  return snapshot;
}
const inputOf=(over={})=>({ownerId:OWNER,botId:BOT,broker:BROKER,from:B,to:NOW+DAY,requestTime:NOW,option:'M',boundaries:BOUNDARIES,limits:LIMITS,read_ms:3.5,...over});
const FIXTURES={
  complete:{snapshot:snapshotOf(),input:inputOf()},
  targeted:{snapshot:snapshotOf({targeted:true}),input:inputOf()},
  refusedNonPaper:{snapshot:snapshotOf({mode:'LIVE'}),input:inputOf()},
  unavailable:{snapshot:snapshotOf({unresolved:true}),input:inputOf({from:NOW,to:NOW+DAY})},
  halted:{snapshot:snapshotOf({oversell:true}),input:inputOf()}
};
// compute_ms and read_ms are timers; everything else must be identical, byte for byte as JSON. The copy is a JSON round trip, never a
// structured clone, so a non-plain value cannot be hidden by the copy (callers assert nonPlain() on the raw value first).
const zeroTimers=body=>{const copy=JSON.parse(JSON.stringify(body));if(copy.reader){copy.reader.compute_ms=0;copy.reader.read_ms=0;}return copy;};
const stable=body=>JSON.stringify(zeroTimers(body));
const stableResult=result=>JSON.stringify({...result,body:zeroTimers(result.body),compute_ms:0});

// Eval test workers (CommonJS). They post the same ready message the real worker posts, unless a case says otherwise.
const READY="require('node:worker_threads').parentPort.postMessage({type:'ready'});";
const HEAD="const {parentPort}=require('node:worker_threads');";
const WORKERS={
  echo:HEAD+"parentPort.on('message',m=>parentPort.postMessage({id:m.id,ok:true,body:{echo:true},auditFindings:[],compute_ms:0}));"+READY,
  slowEcho:HEAD+"parentPort.on('message',m=>setTimeout(()=>parentPort.postMessage({id:m.id,ok:true,body:{slow:true},auditFindings:[],compute_ms:0}),400));"+READY,
  loop:HEAD+"parentPort.on('message',()=>{for(;;){}});"+READY,
  throwOnMessage:HEAD+"parentPort.on('message',()=>{throw new Error('boom-secret-text');});"+READY,
  throwAtLoad:"throw new Error('load-failure');",
  exitOnMessage:HEAD+"parentPort.on('message',()=>process.exit(3));"+READY,
  oom:HEAD+"parentPort.on('message',()=>{const keep=[];for(;;)keep.push(new Array(100000).fill(Math.random()));});"+READY,
  sleeper:HEAD+"parentPort.on('message',m=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);parentPort.postMessage({id:m.id,ok:true,body:{slept:true},auditFindings:[],compute_ms:1200});});"+READY,
  garbage:HEAD+"parentPort.on('message',m=>{parentPort.postMessage('nonsense');parentPort.postMessage({id:m.id+1000,ok:true});parentPort.postMessage({id:m.id,ok:'yes'});});"+READY
};
// A pool whose Nth spawn uses the named test worker (the last name repeats). Returns the pool and a log of the spawned workers.
function poolWith(names,options={}){
  const log=[];
  const spawn=(url,spawnOptions)=>{
    const name=names[Math.min(log.length,names.length-1)];
    const worker=new Worker(WORKERS[name],{...spawnOptions,eval:true});
    const entry={name,worker,exited:false,options:spawnOptions};
    worker.on('exit',()=>{entry.exited=true;});
    log.push(entry);
    return worker;
  };
  const pool=createQr2ComputePool({spawn,...options});
  return {pool,log};
}
const failureKind=promise=>promise.then(()=>null,error=>error instanceof Qr2ComputeFailure?error.kind:'NOT_A_FAILURE:'+error);

/* ------------------------------------------------------------------ parity and clone safety */

test('parity: the worker body equals the in-thread body for complete, targeted-SELL, refused, unavailable and halted views',async()=>{
  const pool=createQr2ComputePool({deadlineMs:20000});
  try{
    const kinds={};
    for(const [name,{snapshot,input}] of Object.entries(FIXTURES)){
      const inThread=executeQr2Job({snapshot,input});
      const direct=composePerformanceResponse(computeQr2View(snapshot,input),{requestTime:input.requestTime});
      assert.equal(nonPlain(inThread),null,name+': the in-thread result holds plain data only');
      assert.equal(nonPlain(direct),null,name+': the in-thread body holds plain data only');
      const viaWorker=await pool.run(snapshot,input);
      assert.equal(viaWorker.ok,true,name+' '+JSON.stringify(viaWorker));
      assert.equal(nonPlain(viaWorker),null,name+': the worker result holds plain data only');
      assert.equal(stableResult(viaWorker),stableResult(inThread),name+': worker result JSON equals the in-thread result JSON');
      assert.equal(stable(viaWorker.body),stable(direct),name+': worker body JSON equals compose(computeQr2View()) JSON');
      kinds[name]=viaWorker.body.status;
    }
    assert.equal(kinds.complete.status,'COMPLETE');
    assert.equal(kinds.refusedNonPaper.status,'REFUSED');
    assert.equal(kinds.unavailable.status,'UNAVAILABLE');
    assert.notEqual(kinds.halted.status,'COMPLETE','a halted replay never reports COMPLETE');
    const targeted=await pool.run(FIXTURES.targeted.snapshot,FIXTURES.targeted.input);
    assert.ok(targeted.body.analytics_comparison,'the targeted SELL fixture runs the analytics comparison');
    assert.equal(targeted.body.analytics_comparison.targeted_exits,1);
    const refused=await pool.run(FIXTURES.refusedNonPaper.snapshot,FIXTURES.refusedNonPaper.input);
    assert.ok(refused.auditFindings.length>0,'a refused view carries its audit findings across the thread boundary');
    assert.equal(pool.counters.completed,Object.keys(FIXTURES).length+2);
  }finally{await pool.close();}
});

function nonPlain(value,pathOf='$',seen=new Set()){
  if(value===null)return null;
  const type=typeof value;
  if(type==='function'||type==='symbol'||type==='bigint'||type==='undefined')return type==='undefined'?null:pathOf+' is '+type;
  if(type!=='object')return null;
  if(seen.has(value))return pathOf+' is cyclic';
  seen.add(value);
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==Array.prototype)return pathOf+' is a '+(proto?.constructor?.name||'null-prototype object');
  for(const key of Object.keys(value)){const found=nonPlain(value[key],pathOf+'.'+key,seen);if(found)return found;}
  return null;
}

test('clone safety: every fixture snapshot and input holds plain data only, and a structured clone computes the same view',()=>{
  for(const [name,{snapshot,input}] of Object.entries(FIXTURES)){
    assert.equal(nonPlain(snapshot),null,name+' snapshot');
    assert.equal(nonPlain({...input,boundaries:undefined,limits:undefined}),null,name+' input');
    assert.equal(nonPlain(input.boundaries),null,name+' boundaries');
    assert.equal(nonPlain(input.limits),null,name+' limits');
    const a=computeQr2View(snapshot,input),b=computeQr2View(structuredClone(snapshot),structuredClone(input));
    assert.equal(stable(composePerformanceResponse(a,{requestTime:NOW})),stable(composePerformanceResponse(b,{requestTime:NOW})),name);
  }
  // The scan itself works: a Decimal, a Date, a function and a class instance are each reported.
  assert.match(nonPlain({a:D('1')}),/Decimal|Money|object/i);
  assert.match(nonPlain({a:new Date(0)}),/Date/);
  assert.match(nonPlain({a:()=>1}),/function/);
  assert.match(nonPlain({a:new (class Row{})()}),/Row/);
});

test('a snapshot with a function cannot be posted: clone failure is its own kind, the worker lives on and no job stays',async()=>{
  const {pool,log}=poolWith(['echo']);
  try{
    assert.equal(await failureKind(pool.run({bad:()=>1},{})),'clone');
    assert.equal(pool.busy,false);
    assert.equal(pool.counters.crash,0);
    const ok=await pool.run({},{});
    assert.equal(ok.ok,true);
    assert.equal(log.length,1,'the same worker served both runs');
  }finally{await pool.close();}
});

/* ------------------------------------------------------------------ job result mapping (worker side) */

test('executeQr2Job maps a Qr2Error, a composer failure and any other throw to plain results with no message, stack or row value',()=>{
  const secret='FOREIGN-ROW-VALUE-9917';
  const job={snapshot:{},input:{requestTime:NOW}};
  const qr2=executeQr2Job(job,{compute:()=>{throw Object.assign(new Qr2Error('QR2_INPUT_INVALID',secret),{detail:{limit:'ledger_rows',value:5001,max:5000}});}});
  assert.deepEqual(qr2,{ok:false,kind:'qr2',code:'QR2_INPUT_INVALID',detail:{limit:'ledger_rows',value:5001,max:5000}});
  const cyclic={};cyclic.self=cyclic;
  assert.deepEqual(executeQr2Job(job,{compute:()=>{throw Object.assign(new Qr2Error('QR2_NOT_OWNER',secret),{detail:cyclic});}}),{ok:false,kind:'qr2',code:'QR2_NOT_OWNER'},'a detail that is not JSON-safe is dropped');
  const response=executeQr2Job(job,{compute:()=>({reader:{compute_ms:1}}),compose:()=>{throw new Qr2Error('QR2_RESPONSE_INVALID',secret);}});
  assert.deepEqual(response,{ok:false,kind:'response'});
  const other=executeQr2Job(job,{compute:()=>{throw Object.assign(new TypeError(secret),{stack:secret});}});
  assert.deepEqual(other,{ok:false,kind:'other'});
  for(const answer of [qr2,response,other])assert.equal(JSON.stringify(answer).includes(secret),false);
  const ok=executeQr2Job(job,{compute:()=>({audit_findings:[{check:'RX',code:'X',event_key:'k'}],reader:{compute_ms:2.5},rows:[{secret}]}),compose:()=>({status:'COMPLETE'})});
  assert.deepEqual(ok,{ok:true,body:{status:'COMPLETE'},auditFindings:[{check:'RX',code:'X',event_key:'k'}],compute_ms:2.5});
  assert.equal(JSON.stringify(ok).includes(secret),false,'view.rows never leave the worker');
  assert.deepEqual(executeQr2Job(job,{compute:()=>({reader:{}}),compose:()=>({})}).auditFindings,[],'no findings array gives an empty list');
});

test('a real worker answers a bad snapshot with kind other and no text, then keeps serving',async()=>{
  const pool=createQr2ComputePool({deadlineMs:20000});
  try{
    const bad=await pool.run({},inputOf());
    assert.deepEqual(bad,{ok:false,kind:'other'});
    const ok=await pool.run(FIXTURES.complete.snapshot,FIXTURES.complete.input);
    assert.equal(ok.ok,true);
    assert.equal(pool.counters.crash,0);
  }finally{await pool.close();}
});

/* ------------------------------------------------------------------ pool lifecycle */

test('lazy and unref: creating a pool spawns nothing; the first run spawns one worker with the resource limits and the role',async()=>{
  const {pool,log}=poolWith(['echo']);
  try{
    assert.equal(log.length,0);assert.equal(pool.alive,false);assert.equal(pool.busy,false);
    await pool.run({},{});
    assert.equal(log.length,1);assert.equal(pool.alive,true);
    assert.deepEqual(log[0].options.resourceLimits,{...QR2_COMPUTE_RESOURCE_LIMITS});
    assert.equal(log[0].options.resourceLimits.maxOldGenerationSizeMb,256);
    assert.deepEqual(log[0].options.workerData,{role:WORKER_ROLE});
    assert.deepEqual(log[0].options.env,{},'the worker gets an empty environment, not a copy of process.env');
    assert.equal(POOL_ROLE,WORKER_ROLE,'pool and worker agree on the role');
    await pool.run({},{});
    assert.equal(log.length,1,'one warm worker is reused');
    assert.deepEqual(pool.counters,{timeout:0,crash:0,heap:0,spawn:0,completed:2});
  }finally{await pool.close();}
});

test('the pool never keeps the process alive: a child that runs one real job and never closes the pool exits by itself',async()=>{
  const poolUrl=new URL('../src/postgres/qr2-compute-pool.js',import.meta.url).href;
  // A script file, not -e: a worker inherits execArgv and an inline -e is not valid there. The file lives in the OS temp directory, outside the repository.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr2-pool-'));
  const script=path.join(dir,'child.mjs');
  fs.writeFileSync(script,`import {createQr2ComputePool} from ${JSON.stringify(poolUrl)};const pool=createQr2ComputePool();const r=await pool.run({},{});console.log(JSON.stringify(r));`);
  const child=spawnProcess(process.execPath,[script],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
  const killer=setTimeout(()=>child.kill(),30000);
  const exit=await new Promise(resolve=>child.on('exit',(c,s)=>resolve({c,s})));
  clearTimeout(killer);
  fs.rmSync(dir,{recursive:true,force:true});
  assert.deepEqual(exit,{c:0,s:null},'the child ended on its own: '+err);
  assert.equal(out.trim(),'{"ok":false,"kind":"other"}');
});

test('deadline: a looping worker is terminated, the promise settles only after the thread is gone, and the next run spawns a new worker',async()=>{
  const {pool,log}=poolWith(['loop','echo'],{deadlineMs:1000});
  try{
    const started=Date.now();
    const kind=await failureKind(pool.run({},{}));
    const elapsed=Date.now()-started;
    assert.equal(kind,'timeout');
    assert.ok(elapsed>=900,'not before the deadline: '+elapsed);
    assert.ok(elapsed<8000,'within a generous bound after it: '+elapsed);
    assert.equal(log[0].exited,true,'the thread had exited when the promise settled');
    assert.equal(pool.counters.timeout,1);assert.equal(pool.busy,false);assert.equal(pool.alive,false);
    const ok=await pool.run({},{});
    assert.equal(ok.ok,true);assert.equal(log.length,2,'a fresh worker');
  }finally{await pool.close();}
});

test('busy stays true until the terminated worker is gone, and a run in that window is refused',async()=>{
  const {pool}=poolWith(['loop','echo'],{deadlineMs:200});
  try{
    const first=failureKind(pool.run({},{}));
    await new Promise(r=>setTimeout(r,120));
    assert.equal(pool.busy,true);
    assert.equal(await failureKind(pool.run({},{})),'busy');
    assert.equal(await first,'timeout');
    assert.equal(pool.busy,false);
  }finally{await pool.close();}
});

test('crash: an uncaught throw and a process.exit in the worker both give crash with no message; recovery spawns a fresh worker',async()=>{
  const {pool,log}=poolWith(['throwOnMessage','exitOnMessage','echo']);
  try{
    const thrown=await pool.run({},{}).then(()=>null,error=>error);
    assert.ok(thrown instanceof Qr2ComputeFailure);assert.equal(thrown.kind,'crash');
    assert.equal(JSON.stringify([thrown.message,thrown.kind]).includes('boom-secret-text'),false);
    assert.equal(log[0].exited,true);
    assert.equal(await failureKind(pool.run({},{})),'crash');
    assert.equal(pool.counters.crash,2);assert.equal(pool.counters.heap,0);
    const ok=await pool.run({},{});
    assert.equal(ok.ok,true);assert.equal(log.length,3);
  }finally{await pool.close();}
});

test('heap limit: a worker that allocates past maxOldGenerationSizeMb gives heap (also counted as crash); recovery works',async()=>{
  const {pool,log}=poolWith(['oom','echo'],{resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4,stackSizeMb:4},deadlineMs:20000});
  try{
    assert.equal(await failureKind(pool.run({},{})),'heap');
    assert.equal(pool.counters.heap,1);assert.equal(pool.counters.crash,1);assert.equal(pool.counters.timeout,0);
    assert.equal(log[0].exited,true);
    assert.equal((await pool.run({},{})).ok,true);
  }finally{await pool.close();}
});

test('spawn failures: a module-load failure and a throwing spawn both count spawn; the next run recovers',async()=>{
  const {pool,log}=poolWith(['throwAtLoad','echo']);
  try{
    assert.equal(await failureKind(pool.run({},{})),'spawn');
    assert.equal(pool.counters.spawn,1);assert.equal(pool.counters.crash,0);assert.equal(log[0].exited,true);
    assert.equal((await pool.run({},{})).ok,true);
  }finally{await pool.close();}
  let calls=0;
  const failing=createQr2ComputePool({spawn:()=>{calls++;throw new Error('EAGAIN secret');}});
  const thrown=await failing.run({},{}).then(()=>null,error=>error);
  assert.equal(thrown.kind,'spawn');assert.equal(thrown.message.includes('secret'),false);
  assert.equal(await failureKind(failing.run({},{})),'spawn');
  assert.equal(calls,2,'no retry inside one run, a new attempt on the next run');
  assert.equal(failing.counters.spawn,2);assert.equal(failing.busy,false);
  const missing=createQr2ComputePool({workerUrl:new URL('file:///nonexistent-qr2-worker.js')});
  assert.equal(await failureKind(missing.run({},{})),'spawn','a missing worker file is a spawn failure');
  await missing.close();
});

test('busy guard: a second concurrent run is refused at once and never queued; the first completes',async()=>{
  const {pool}=poolWith(['slowEcho']);
  try{
    const first=pool.run({},{});
    const started=Date.now();
    assert.equal(await failureKind(pool.run({},{})),'busy');
    assert.ok(Date.now()-started<200,'refused without waiting');
    assert.equal((await first).body.slow,true);
    assert.equal(pool.counters.completed,1,'the refused run did not become a job');
    assert.equal((await pool.run({},{})).ok,true);
  }finally{await pool.close();}
});

test('messages that are not the answer of the running job are ignored; an answer without a boolean ok becomes kind other',async()=>{
  const {pool}=poolWith(['garbage']);
  try{
    const result=await pool.run({},{});
    assert.deepEqual(result,{ok:false,kind:'other'});
    assert.equal(pool.counters.completed,1);
  }finally{await pool.close();}
});

test('close(): terminates the worker, rejects a running job as closed, refuses later runs, and is idempotent',async()=>{
  const {pool,log}=poolWith(['echo','loop']);
  await pool.run({},{});
  await pool.close();
  assert.equal(log[0].exited,true);assert.equal(pool.alive,false);
  assert.equal(await failureKind(pool.run({},{})),'closed');
  await pool.close();
  const running=poolWith(['loop'],{deadlineMs:20000});
  const pending=failureKind(running.pool.run({},{}));
  await new Promise(r=>setTimeout(r,100));
  await running.pool.close();
  assert.equal(await pending,'closed');
  assert.equal(running.log[0].exited,true);
  assert.deepEqual(running.pool.counters,{timeout:0,crash:0,heap:0,spawn:0,completed:0},'a close is not counted as a failure');
  const idle=createQr2ComputePool();
  await idle.close();
  assert.equal(idle.alive,false);
});

test('configuration: the deadline is a pool option with default 10000 ms (no environment override), and a bad option throws',async()=>{
  assert.equal(QR2_COMPUTE_DEADLINE_MS,10000);
  assert.equal(Object.hasOwn(await import('../src/postgres/qr2-compute-pool.js'),'deadlineFromEnv'),false);
  assert.equal(fs.readFileSync(path.join(SRC,'postgres','qr2-compute-pool.js'),'utf8').includes('process.env'),false,'the pool reads no environment');
  assert.throws(()=>createQr2ComputePool({deadlineMs:0}),TypeError);
  assert.throws(()=>createQr2ComputePool({deadlineMs:1.5}),TypeError);
  assert.deepEqual({...QR2_COMPUTE_RESOURCE_LIMITS},{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32,stackSizeMb:4});
});

// A fake worker for what the eval workers cannot stage: a terminate that takes a chosen time, and a messageerror event.
function fakeWorker({terminateMs=0}={}){
  const worker=new EventEmitter();
  worker.log={terminated:0,exited:false};
  worker.postMessage=()=>{};
  worker.ref=()=>{};worker.unref=()=>{};
  worker.terminate=()=>{
    worker.log.terminated++;
    return new Promise(resolve=>setTimeout(()=>{worker.log.exited=true;worker.emit('exit',1);resolve(1);},terminateMs));
  };
  setImmediate(()=>worker.emit('message',{type:'ready'}));
  return worker;
}

test('close() during a pending terminate waits for it and leaves the failing job its own kind (not closed)',async()=>{
  const fake=fakeWorker({terminateMs:300});
  const pool=createQr2ComputePool({spawn:()=>fake,deadlineMs:50});
  const run=failureKind(pool.run({},{}));
  await new Promise(r=>setTimeout(r,120));   // the deadline fired, terminate is pending
  assert.equal(fake.log.terminated,1);assert.equal(fake.log.exited,false);assert.equal(pool.busy,true);
  const started=Date.now();
  await pool.close();
  assert.equal(fake.log.exited,true,'close() resolved only after the thread was gone');
  assert.ok(Date.now()-started>=100,'close() did wait for the delayed terminate: '+(Date.now()-started));
  assert.equal(await run,'timeout','a job already failing is not rewritten to closed');
  assert.equal(pool.busy,false);
  assert.equal(pool.counters.timeout,1);
  assert.equal(fake.log.terminated,1,'no second terminate for the same worker');
});

test('close() of a running job with a delayed terminate also waits for the thread, then rejects closed',async()=>{
  const fake=fakeWorker({terminateMs:200});
  const pool=createQr2ComputePool({spawn:()=>fake,deadlineMs:20000});
  const run=failureKind(pool.run({},{}));
  await new Promise(r=>setTimeout(r,50));
  await pool.close();
  assert.equal(fake.log.exited,true);
  assert.equal(await run,'closed');
  assert.equal(pool.busy,false);
});

test('two concurrent close() calls both resolve only after the thread is gone; the job rejects closed; one terminate',async()=>{
  const fake=fakeWorker({terminateMs:200});
  const pool=createQr2ComputePool({spawn:()=>fake,deadlineMs:20000});
  const run=failureKind(pool.run({},{}));
  await new Promise(r=>setTimeout(r,50));
  const exitedAt=[];
  const c1=pool.close().then(()=>exitedAt.push(fake.log.exited));
  const c2=pool.close().then(()=>exitedAt.push(fake.log.exited));
  await Promise.all([c1,c2]);
  assert.deepEqual(exitedAt,[true,true],'neither close() resolved before the thread exited');
  assert.equal(await run,'closed');
  assert.equal(fake.log.terminated,1);
  assert.equal(pool.busy,false);
});

test('messageerror: an answer that cannot be deserialized ends the running job as a crash, the worker is dropped, and the next run spawns a new one',async()=>{
  const fakes=[];
  const pool=createQr2ComputePool({spawn:()=>{const w=fakeWorker({terminateMs:20});fakes.push(w);return w;},deadlineMs:20000});
  try{
    const first=failureKind(pool.run({},{}));
    await new Promise(r=>setTimeout(r,30));
    fakes[0].emit('messageerror',new Error('secret-deserialize-text'));
    assert.equal(await first,'crash');
    assert.equal(fakes[0].log.exited,true,'the promise settled after the thread was gone');
    assert.equal(pool.counters.crash,1);assert.equal(pool.busy,false);assert.equal(pool.alive,false);
    const second=failureKind(pool.run({},{}));
    await new Promise(r=>setTimeout(r,30));
    assert.equal(fakes.length,2,'a fresh worker');
    fakes[1].emit('messageerror',new Error('x'));
    assert.equal(await second,'crash');
    assert.equal(pool.counters.crash,2);
  }finally{await pool.close();}
});

/* ------------------------------------------------------------------ event loop */

test('event loop: while a worker blocks its own thread for 1.2 s the main thread keeps running (largest timer gap well under the block)',async()=>{
  const {pool}=poolWith(['sleeper'],{deadlineMs:20000});
  try{
    await pool.run({},{}); // warm: the first run includes thread start
    let last=Date.now(),maxGap=0;
    const beat=setInterval(()=>{const now=Date.now();maxGap=Math.max(maxGap,now-last);last=now;},10);
    const result=await pool.run({},{});
    clearInterval(beat);
    assert.equal(result.body.slept,true);
    assert.ok(maxGap<400,'largest main-thread gap '+maxGap+' ms during a 1200 ms worker block');
  }finally{await pool.close();}
});

/* ------------------------------------------------------------------ import guard */

// [^'"]*? crosses newlines, so a multi-line import list is found.
function importSpecs(text){
  const out=[];
  for(const m of text.matchAll(/(?:^|[;\n])\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g))out.push(m[1]||m[2]);
  for(const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))out.push(m[1]);
  return out;
}
const importsOf=file=>importSpecs(fs.readFileSync(file,'utf8'));

test('import guard scanner: it finds multi-line imports and exports, side-effect imports and dynamic imports',()=>{
  const text="import a from './a.js';\nimport {\n  b,\n  c\n} from './b.js';\nexport {\n  d\n} from 'node:crypto';\nimport './side.js';\nconst x=await import('./dyn.js');\nexport const k=1;\nimport{e}from'./e.js';\n";
  assert.deepEqual(importSpecs(text).sort(),['./a.js','./b.js','./dyn.js','./e.js','./side.js','node:crypto']);
  // a compact import alone, with no earlier export that could reach its from clause
  assert.deepEqual(importSpecs("import{e}from'./e.js';\n"),['./e.js']);
  assert.deepEqual(importSpecs("const y=1;export{f}from'./f.js';\n"),['./f.js']);
});
function graphOf(entry){
  const files=new Set(),bare=new Set(),queue=[entry];
  while(queue.length){
    const file=queue.pop();
    if(files.has(file))continue;
    files.add(file);
    for(const spec of importsOf(file)){
      if(spec.startsWith('.'))queue.push(path.resolve(path.dirname(file),spec));else bare.add(spec);
    }
  }
  return {files:[...files].map(f=>path.relative(SRC,f).split(path.sep).join('/')),bare:[...bare].sort()};
}

test('import guard: the worker module graph holds no pg, db, store, server or dispatcher module, and only worker_threads, crypto and decimal.js from outside',()=>{
  const {files,bare}=graphOf(path.join(SRC,'postgres','qr2-compute-worker.js'));
  assert.ok(files.includes('postgres/qr2-reader.js')&&files.includes('portfolio/qr2-response.js'),'the walk reaches the compute code: '+files.join(','));
  for(const forbidden of ['postgres/db.js','postgres/store.js','postgres/server.js','postgres/request-dispatch.js','postgres/qr2-routes.js','postgres/qr2-audit.js','postgres/ledger.js'])
    assert.equal(files.includes(forbidden),false,forbidden+' must not be imported');
  assert.equal(files.some(f=>/db|store|server|dispatch|pool|route/i.test(path.basename(f))&&!/pine-bridge-market/.test(f)),false,'no database-like module in the graph: '+files.join(','));
  assert.deepEqual(bare,['decimal.js','node:crypto','node:worker_threads']);
  assert.equal(bare.includes('pg'),false);
  // The pool module is main-thread code and imports only worker_threads.
  assert.deepEqual(graphOf(path.join(SRC,'postgres','qr2-compute-pool.js')).bare,['node:worker_threads']);
});

/* ------------------------------------------------------------------ route mapping (stub store, no database) */

const stubStore=()=>({ownsBot:async()=>true,userById:async()=>({id:BOT,parent_user_id:OWNER,created_at:B}),activePlan:async()=>'ENTERPRISE',audit:async()=>{}});
async function driveRoute(compute,{snapshotOf:snapshotArgs=FIXTURES.complete,slot=createQr2Slot(),readSnapshot,writeAudit,setHeader=true}={}){
  const headers={};
  const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null,phase2AfterCommit:null};
  if(setHeader)res.setHeader=(name,value)=>{headers[name]=value;};
  const json=(r,status,body)=>{r.phase2Result={status,body};};
  const reads=[];
  const deps={store:stubStore(),auth:{sensitive:async()=>{}},json,enabled:true,slot,boundaries:BOUNDARIES,compute,clock:()=>NOW,
    readSnapshot:readSnapshot||(async(store,args)=>{reads.push(args);return {snapshot:snapshotArgs.snapshot,input:{...snapshotArgs.input,requestTime:args.requestTime,from:args.from,to:args.to}};})};
  if(writeAudit)deps.writeAudit=writeAudit;
  await qr2PerformanceRoute({method:'GET',headers:{}},res,new URL('http://localhost/api/paper-performance?bot_id='+BOT+'&period=DAY'),{id:OWNER,permissions:[]},deps);
  assert.equal(typeof res.phase2Deferred,'function','phase 1 passed: '+JSON.stringify(res.phase2Result));
  const answer=await res.phase2Deferred();
  return {answer,headers,res,slot,reads};
}
const REPORT_FAILED={code:'QR2_REPORT_FAILED',error:'Performance report could not be produced'};
const fakeCompute=run=>({run:async(...args)=>run(...args)});
const failing=kind=>fakeCompute(async()=>{throw new Qr2ComputeFailure(kind);});

test('route: a successful compute answers 200 with the body and registers the audit writer only when findings exist',async()=>{
  const inline=fakeCompute(async(snapshot,input)=>executeQr2Job({snapshot,input}));
  const ok=await driveRoute(inline);
  assert.equal(ok.answer.status,200);assert.equal(ok.answer.body.status.status,'COMPLETE');
  assert.equal(ok.slot.busy,0);
  const quiet=await driveRoute(fakeCompute(async()=>({ok:true,body:{plain:true},auditFindings:[],compute_ms:1})));
  assert.deepEqual(quiet.answer,{status:200,body:{plain:true}});
  assert.equal(quiet.res.phase2AfterCommit,null,'no findings, no audit writer');
  const writes=[];
  const refused=await driveRoute(inline,{snapshotOf:FIXTURES.refusedNonPaper,writeAudit:async(store,arg)=>{writes.push(arg);}});
  assert.equal(refused.answer.status,200);assert.equal(refused.answer.body.status.status,'REFUSED');
  assert.equal(typeof refused.res.phase2AfterCommit,'function');
  assert.equal(writes.length,0,'not run before the dispatcher runs it');
  await refused.res.phase2AfterCommit();
  assert.equal(writes.length,1);assert.equal(writes[0].botId,BOT);assert.ok(writes[0].findings.length>0);
});

test('route: timeout, crash, heap and spawn answer 503 QR2_REPORT_FAILED with Retry-After 2; busy, closed and clone answer 503 without it; no audit writer ever',async()=>{
  for(const kind of ['timeout','crash','heap','spawn']){
    const r=await driveRoute(failing(kind),{snapshotOf:FIXTURES.refusedNonPaper});
    assert.equal(r.answer.status,503,kind);assert.deepEqual(r.answer.body,REPORT_FAILED,kind);
    assert.deepEqual(r.headers,{'Retry-After':'2'},kind);
    assert.equal(r.res.phase2AfterCommit,null,kind+': no audit after a failed compute');
    assert.equal(r.slot.busy,0,kind+': slot released');
  }
  for(const kind of ['busy','closed','clone']){
    const r=await driveRoute(failing(kind));
    assert.equal(r.answer.status,503,kind);assert.deepEqual(r.answer.body,REPORT_FAILED,kind);assert.deepEqual(r.headers,{},kind);
  }
  // A response object without setHeader does not break the answer.
  assert.equal((await driveRoute(failing('timeout'),{setHeader:false})).answer.status,503);
});

test('route: a missing or broken pool, or a malformed result, is a fixed 503 and the slot is released',async()=>{
  for(const compute of [undefined,{},{run:null},fakeCompute(async()=>{throw new TypeError('secret internals');}),fakeCompute(async()=>null),fakeCompute(async()=>({ok:'yes'})),fakeCompute(async()=>({ok:true,body:null})),fakeCompute(async()=>({ok:false,kind:'other'})),fakeCompute(async()=>({ok:false,kind:'mystery'}))]){
    const r=await driveRoute(compute);
    assert.equal(r.answer.status,503);assert.deepEqual(r.answer.body,REPORT_FAILED);
    assert.equal(JSON.stringify(r.answer).includes('secret'),false);
    assert.equal(r.slot.busy,0);
  }
});

test('route: a worker Qr2Error keeps the S3a mapping (input invalid is 503, admission refusal keeps its detail), a composer failure is 500',async()=>{
  const input=await driveRoute(fakeCompute(async()=>({ok:false,kind:'qr2',code:'QR2_INPUT_INVALID',detail:'x'})));
  assert.equal(input.answer.status,503);assert.deepEqual(input.answer.body,REPORT_FAILED);
  const admission=await driveRoute(fakeCompute(async()=>({ok:false,kind:'qr2',code:'QR2_RANGE_ADMISSION_REFUSED',detail:{limit:'ledger_rows',value:5001,max:5000}})));
  assert.equal(admission.answer.status,422);assert.deepEqual(admission.answer.body.detail,{limit:'ledger_rows',value:5001,max:5000});
  const owner=await driveRoute(fakeCompute(async()=>({ok:false,kind:'qr2',code:'QR2_NOT_OWNER'})));
  assert.equal(owner.answer.status,404);
  const unknown=await driveRoute(fakeCompute(async()=>({ok:false,kind:'qr2',code:'QR2_READER_SNAPSHOT_REQUIRED'})));
  assert.equal(unknown.answer.status,503);assert.deepEqual(unknown.answer.body,REPORT_FAILED);
  const bad=await driveRoute(fakeCompute(async()=>({ok:false,kind:'response'})));
  assert.equal(bad.answer.status,500);assert.equal(bad.answer.body.code,'QR2_RESPONSE_INVALID');
  assert.equal(bad.res.phase2AfterCommit,null);
});

test('route: the slot is held until the compute settles (a second request is refused 429), and a reader failure never reaches the compute',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  let computes=0;
  const slow=fakeCompute(async(snapshot,input)=>{computes++;await gate;return executeQr2Job({snapshot,input});});
  const slot=createQr2Slot();
  const first=driveRoute(slow,{slot});
  while(computes===0)await new Promise(r=>setTimeout(r,5));
  assert.equal(slot.busy,1);
  const second=await driveRoute(slow,{slot});
  assert.equal(second.answer.status,429);assert.deepEqual(second.answer.body.detail,{limit:'concurrency',max:1});assert.equal(computes,1);
  release();
  assert.equal((await first).answer.status,200);assert.equal(slot.busy,0);
  let ran=0;
  const reader=await driveRoute(fakeCompute(async()=>{ran++;}),{readSnapshot:async()=>{throw new Qr2Error('QR2_RANGE_ADMISSION_REFUSED','x');}});
  assert.equal(reader.answer.status,422);assert.equal(ran,0);
  const down=await driveRoute(fakeCompute(async()=>{ran++;}),{readSnapshot:async()=>{throw new Error('db down');}});
  assert.equal(down.answer.status,503);assert.equal(ran,0);
});

test('route with the real pool: a deadline frees the slot, answers 503 with Retry-After and the next request is served by a new worker',async()=>{
  const {pool}=poolWith(['loop','echo'],{deadlineMs:1000});
  try{
    const slot=createQr2Slot();
    const timedOut=await driveRoute(pool,{slot});
    assert.equal(timedOut.answer.status,503);assert.deepEqual(timedOut.headers,{'Retry-After':'2'});assert.equal(slot.busy,0);
    assert.equal(pool.counters.timeout,1);
    const next=await driveRoute(pool,{slot});
    assert.equal(next.answer.status,200,'the second worker answered '+JSON.stringify(next.answer)+JSON.stringify(pool.counters));
    assert.deepEqual(next.answer.body,{echo:true});
  }finally{await pool.close();}
});
