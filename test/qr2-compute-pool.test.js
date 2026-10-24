import {buildCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {coverageReadBudgets} from '../src/portfolio/qr2-coverage-limits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn as spawnProcess,execFileSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {D} from '../src/money.js';
import {computeQr2View} from '../src/postgres/qr2-reader.js';
import {resolveRange} from '../src/portfolio/qr2-periods.js';
import {validateBoundaryRecord} from '../src/portfolio/qr2-boundaries.js';
import {Qr2Error} from '../src/portfolio/qr2-constants.js';
import {composePerformanceResponse,refusalAnswer} from '../src/portfolio/qr2-response.js';
import {projectPublicCoverage,projectPublicCoverageOutcome} from '../src/portfolio/qr2-coverage-public.js';
import {buildBarCoverage} from '../src/portfolio/qr2-coverage.js';
import {executeQr2Job,QR2_WORKER_ROLE as WORKER_ROLE} from '../src/postgres/qr2-compute-worker.js';
import {createQr2ComputePool,Qr2ComputeFailure,QR2_COMPUTE_DEADLINE_MS,QR2_COMPUTE_RESOURCE_LIMITS,QR2_WORKER_ROLE as POOL_ROLE,setsProcessHeapLimit} from '../src/postgres/qr2-compute-pool.js';
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
function attachCoverage(job){
  const {snapshot,input}=job;
  const resolved_range=resolveRange({from:input.from,to:input.to,requestTime:input.requestTime,coverageStart:snapshot.coverageStart}).resolved;
  const accounts=[{bot_id:input.botId,broker:input.broker,market:{broker:BROKER,symbol:'BTCUSDT',timeframe:'1'},resolved_range}];
  input.coverage_context={accounts,budgets:coverageReadBudgets()};
  // Independent synthetic recipe: every closed minute in the two-hour range is present.
  const timestamps=resolved_range?Array.from({length:120},(_,i)=>B+(i+1)*MIN):[];
  snapshot.coverage=buildCoverageSnapshot({...input.coverage_context,facts:resolved_range?[{state:'COMPLETE',timestamps}]:[]});
  snapshot.coverage_window_id=0;
  return job;
}
for(const job of Object.values(FIXTURES))attachCoverage(job);
// The market_data.coverage the worker publishes for one account job: the projected account entry whose (bot_id, broker) equals the request.
function projectedCoverage(snapshot,input){
  const entries=projectPublicCoverage(snapshot.coverage,input.coverage_context).accounts.filter(a=>a.bot_id===input.botId&&a.broker===input.broker);
  assert.equal(entries.length,1);
  return entries[0].market_data.coverage;
}
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
      const direct=composePerformanceResponse(computeQr2View(snapshot,input),{requestTime:input.requestTime,coverage:projectedCoverage(snapshot,input)});
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
  const job=structuredClone(FIXTURES.complete);
  const qr2=executeQr2Job(job,{compute:()=>{throw Object.assign(new Qr2Error('QR2_INPUT_INVALID',secret),{detail:{limit:'ledger_rows',value:5001,max:5000}});}});
  assert.deepEqual(qr2,{ok:false,kind:'qr2',code:'QR2_INPUT_INVALID',detail:{limit:'ledger_rows',value:5001,max:5000}});
  const cyclic={};cyclic.self=cyclic;
  assert.deepEqual(executeQr2Job(job,{compute:()=>{throw Object.assign(new Qr2Error('QR2_NOT_OWNER',secret),{detail:cyclic});}}),{ok:false,kind:'qr2',code:'QR2_NOT_OWNER'},'a detail that is not JSON-safe is dropped');
  const response=executeQr2Job(job,{compute:()=>({reader:{compute_ms:1}}),compose:()=>{throw new Qr2Error('QR2_RESPONSE_INVALID',secret);}});
  assert.deepEqual(response,{ok:false,kind:'response'});
  const other=executeQr2Job(job,{compute:()=>{throw Object.assign(new TypeError(secret),{stack:secret});}});
  assert.deepEqual(other,{ok:false,kind:'other'});
  for(const answer of [qr2,response,other])assert.equal(JSON.stringify(answer).includes(secret),false);
  // The seam echoes its coverage option: the worker post-check needs the projected coverage object in a non-REFUSED body.
  let offered;
  const echo=(view,{coverage})=>{offered=coverage;return {status:{status:'COMPLETE'},market_data:{coverage}};};
  const projected=projectedCoverage(job.snapshot,job.input);
  const ok=executeQr2Job(job,{compute:()=>({audit_findings:[{check:'RX',code:'X',event_key:'k'}],reader:{compute_ms:2.5},rows:[{secret}]}),compose:echo});
  assert.deepEqual(ok,{ok:true,body:{status:{status:'COMPLETE'},market_data:{coverage:projected}},auditFindings:[{check:'RX',code:'X',event_key:'k'}],compute_ms:2.5});
  assert.equal(ok.body.market_data.coverage,offered,'the body holds the projected coverage object itself');
  assert.equal(JSON.stringify(ok).includes(secret),false,'view.rows never leave the worker');
  assert.deepEqual(executeQr2Job(job,{compute:()=>({reader:{}}),compose:echo}).auditFindings,[],'no findings array gives an empty list');
  assert.deepEqual(executeQr2Job(job,{compute:()=>({reader:{}}),compose:()=>({status:'COMPLETE'})}),{ok:false,kind:'response'},'the literal old seam without coverage now fails the post-check');
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
  // The only environment read is NODE_OPTIONS, for the heap-flag refusal; no pool setting comes from the environment.
  const codeLines=fs.readFileSync(path.join(SRC,'postgres','qr2-compute-pool.js'),'utf8').split('\n').filter(line=>!/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
  const envReads=codeLines.match(/process\.env\b[.\[]?\w*/g)??[];
  assert.deepEqual(envReads,['process.env.NODE_OPTIONS'],'the pool reads no environment except NODE_OPTIONS for the heap-flag refusal');
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

/* ------------------------------------------------------------------ process-wide heap flag (fail closed) */

// --max-old-space-size is process-wide in V8 and overrides Worker resourceLimits.maxOldGenerationSizeMb, so the heap cap would be silently off.
// The pool refuses with the existing kind spawn before any worker is created.
test('heap flag detection: both spellings, with or without a value, in execArgv or NODE_OPTIONS; near misses and clean input pass',()=>{
  // Node 24.22 experiment (worker resourceLimits vs heap_size_limit in the worker): these flags override the worker cap. --max-old-space-size,
  // --max-old-space-size-percentage and --max-heap-size lift the old-generation cap; --max-semi-space-size lifts the young-generation cap.
  for(const flag of ['--max-old-space-size=512','--max_old_space_size=512','--max-old-space-size','--max_old_space_size','-max-old-space-size=64','--max-old_space-size=1',
    '--max-old-space-size-percentage=50','--max_old_space_size_percentage=50','--max-old-space-size-percentage','--max_old_space_size_percentage',
    '--max-heap-size=2048','--max_heap_size=2048','--max-heap-size','--max_heap_size',
    '--max-semi-space-size=64','--max_semi_space_size=64','--max-semi-space-size','--max_semi_space_size']){
    assert.equal(setsProcessHeapLimit([flag],undefined),true,'execArgv '+flag);
    assert.equal(setsProcessHeapLimit(['--no-warnings',flag,'7'],''),true,'execArgv among others '+flag);
    assert.equal(setsProcessHeapLimit([],flag),true,'NODE_OPTIONS '+flag);
    assert.equal(setsProcessHeapLimit(undefined,'--no-warnings   '+flag+'  --trace-uncaught'),true,'NODE_OPTIONS among others '+flag);
    assert.equal(setsProcessHeapLimit(undefined,'"'+flag+'"'),true,'NODE_OPTIONS quoted '+flag);
  }
  for(const clean of [[undefined,undefined],[[],''],[['--no-warnings','--stack-size=512'],'--no-warnings --trace-uncaught'],[['--max-http-header-size=16384'],'--max-http-header-size=16384'],
    [['--experimental-vm-modules'],'--title=max-old-space-size'],[['--min-semi-space-size=16','--semi-space-growth-factor=4','--initial-heap-size=64','--initial-old-space-size=64'],'--stack-trace-limit=50'],
    [['--max-old-space-sizes=1','--max-heap-sizes=1','--max-heap-size-x=1'],'--title=max-heap-size --title=max-semi-space-size']]){
    assert.equal(setsProcessHeapLimit(...clean),false,JSON.stringify(clean));
  }
});

test('heap flag refusal: the pool refuses before spawn, creates no worker, counts spawn and recovers when the flag is gone',async()=>{
  for(const seam of [{execArgv:['--max-old-space-size=4096']},{execArgv:['--max_old_space_size=4096']},{nodeOptions:'--max-old-space-size=4096'},{nodeOptions:'--no-warnings --max_old_space_size'},
    {execArgv:['--max-old-space-size-percentage=50']},{nodeOptions:'--max_old_space_size_percentage=50'},{execArgv:['--max-heap-size=2048']},{nodeOptions:'--max_heap_size=2048'},
    {execArgv:['--max-semi-space-size=64']},{nodeOptions:'--no-warnings --max_semi_space_size'}]){
    const {pool,log}=poolWith(['echo'],seam);
    try{
      let thrown=null;
      try{await pool.run({},{});}catch(error){thrown=error;}
      assert.ok(thrown instanceof Qr2ComputeFailure,'a Qr2ComputeFailure');
      assert.equal(thrown.kind,'spawn');
      assert.equal(thrown.message,'QR-2 compute spawn','no flag text, value, path or secret in the message');
      assert.equal(log.length,0,'spawn was never called: no half-started worker');
      assert.equal(pool.alive,false);assert.equal(pool.busy,false);
      assert.equal(await failureKind(pool.run({},{})),'spawn','refused again, not cached as success');
      assert.deepEqual(pool.counters,{timeout:0,crash:0,heap:0,spawn:2,completed:0});
    }finally{await pool.close();}
  }
  // The same pool class with clean seams spawns and answers, and the cap still reaches the worker options.
  const {pool,log}=poolWith(['echo'],{execArgv:['--no-warnings'],nodeOptions:'--no-warnings'});
  try{
    assert.equal((await pool.run({},{})).ok,true);
    assert.equal(log.length,1);assert.equal(log[0].options.resourceLimits.maxOldGenerationSizeMb,256);
  }finally{await pool.close();}
});

test('heap flag refusal: the route answers 503 with Retry-After 2 and the slot is freed',async()=>{
  const {pool,log}=poolWith(['echo'],{nodeOptions:'--max-old-space-size=4096'});
  try{
    const slot=createQr2Slot();
    const refused=await driveRoute(pool,{slot});
    assert.equal(refused.answer.status,503);assert.deepEqual(refused.headers,{'Retry-After':'2'});assert.equal(slot.busy,0);
    assert.equal(log.length,0);
  }finally{await pool.close();}
});

test('heap flag refusal in a real process: the default pool reads process.execArgv and NODE_OPTIONS and refuses without creating a worker',async()=>{
  const poolUrl=new URL('../src/postgres/qr2-compute-pool.js',import.meta.url).href;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qr2-pool-'));
  const script=path.join(dir,'child.mjs');
  fs.writeFileSync(script,`import {createQr2ComputePool} from ${JSON.stringify(poolUrl)};const pool=createQr2ComputePool();let kind='none';try{await pool.run({},{});}catch(error){kind=error.kind;}console.log(JSON.stringify({kind,alive:pool.alive,counters:pool.counters}));`);
  const runChild=(args,nodeOptions)=>new Promise(resolve=>{
    const env={...process.env};
    if(nodeOptions===undefined)delete env.NODE_OPTIONS;else env.NODE_OPTIONS=nodeOptions;
    const child=spawnProcess(process.execPath,[...args,script],{stdio:['ignore','pipe','pipe'],env});
    let out='',err='';child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
    const killer=setTimeout(()=>child.kill(),30000);
    child.on('exit',(code,signal)=>{clearTimeout(killer);resolve({code,signal,out:out.trim(),err});});
  });
  try{
    const refusedShape='{"kind":"spawn","alive":false,"counters":{"timeout":0,"crash":0,"heap":0,"spawn":1,"completed":0}}';
    for(const [label,args,nodeOptions] of [['execArgv',['--max-old-space-size=512'],undefined],['execArgv underscore',['--max_old_space_size=512'],undefined],
      ['NODE_OPTIONS',[],'--max-old-space-size=512'],['NODE_OPTIONS underscore',[],'--max_old_space_size=512'],
      ['execArgv percentage',['--max-old-space-size-percentage=50'],undefined],['NODE_OPTIONS percentage underscore',[],'--max_old_space_size_percentage=50'],
      ['execArgv max-heap-size',['--max-heap-size=2048'],undefined],['NODE_OPTIONS max_heap_size',[],'--max_heap_size=2048'],
      ['execArgv semi-space',['--max-semi-space-size=64'],undefined],['NODE_OPTIONS semi-space underscore',[],'--max_semi_space_size=64']]){
      const result=await runChild(args,nodeOptions);
      assert.equal(result.code,0,label+': '+result.err);
      assert.equal(result.out,refusedShape,label);
    }
    const clean=await runChild([],undefined);
    assert.equal(clean.code,0,clean.err);
    assert.equal(clean.out,'{"kind":"none","alive":true,"counters":{"timeout":0,"crash":0,"heap":0,"spawn":0,"completed":1}}','without the flag the real worker starts and answers (other)');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('static: no tracked deploy file, script, unit, package.json script or Dockerfile sets max-old-space-size, max-heap-size or max-semi-space-size',()=>{
  const root=path.join(here,'..');
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0').filter(Boolean);
  assert.ok(tracked.length>50,'git ls-files returned the tracked tree: '+tracked.length);
  // Excluded by rule: test files, docs and Markdown. The pool module names the flag only to refuse it.
  const exempt=file=>/^test\//.test(file)||/(^|\/)[^/]*\.test\.[cm]?js$/.test(file)||/^docs\//.test(file)||/\.md$/i.test(file)||file==='src/postgres/qr2-compute-pool.js';
  const flag=/max[-_](?:old[-_]space|heap[-_]size|semi[-_]space)/i;
  const hits=[];let scanned=0;
  for(const file of tracked){
    if(exempt(file))continue;
    let text;
    try{
      const full=path.join(root,file);
      const stat=fs.statSync(full);
      if(!stat.isFile()||stat.size>8*1024*1024)continue;
      const buffer=fs.readFileSync(full);
      if(buffer.includes(0))continue;
      text=buffer.toString('utf8');
    }catch{continue;}
    scanned++;
    if(flag.test(text))hits.push(file);
  }
  assert.ok(scanned>20,'scanned text files: '+scanned);
  assert.deepEqual(hits,[],'a tracked file sets the process-wide heap flag, which would disable the QR-2 worker heap cap');
});

// Path-aware leak walk. The keys below never appear at any depth; `coverage` appears only where the published contract places it.
const INTERNAL_COVERAGE_KEYS=['coverage_context','coverage_window_id','coverage_input_bytes','coverage_output_bytes','budgets','unions','windows','bindings','charges'];
const OWNER_COVERAGE_PATH=/^\$\.body\.market_coverage\.entries\[\d+\]\.coverage$/;
const ACCOUNT_COVERAGE_PATH=/^\$\.body\.market_data\.coverage$/;
function leakedCoverageKeys(value,allowedPath,pathOf='$',found=[]){
  if(value===null||typeof value!=='object')return found;
  if(Array.isArray(value)){value.forEach((item,i)=>leakedCoverageKeys(item,allowedPath,pathOf+'['+i+']',found));return found;}
  for(const [key,item] of Object.entries(value)){
    const here=pathOf+'.'+key;
    if(INTERNAL_COVERAGE_KEYS.includes(key)||(key==='coverage'&&!allowedPath.test(here)))found.push(here);
    leakedCoverageKeys(item,allowedPath,here,found);
  }
  return found;
}

/* Coverage qualification is independent of financial replay. */
function ownerCoverageJob(empty=false){
  const member=structuredClone(FIXTURES.complete);
  const context=member.input.coverage_context;
  delete member.input.coverage_context;delete member.snapshot.coverage;
  const accounts=empty?[]:[member];
  const input={kind:'owner',ownerId:OWNER,currency:'USDT',from:B,to:NOW+DAY,requestTime:NOW,limits:LIMITS,
    coverage_context:{accounts:empty?[]:context.accounts,budgets:coverageReadBudgets()}};
  const snapshot={kind:'owner',currency:'USDT',ownerBots:[{bot_id:OWNER,created_at:B},{bot_id:BOT,created_at:B}],declarations:[],accounts,
    range:resolveRange({from:B,to:NOW+DAY,requestTime:NOW,coverageStart:B}),
    counts:{ledger_rows:empty?0:6,grid_instants:empty?0:121,audit_rows:0,pending_orders:0,accounts:accounts.length,bots:2,declarations:0}};
  snapshot.coverage=buildCoverageSnapshot({...input.coverage_context,facts:empty?[]:[{state:'COMPLETE',timestamps:Array.from({length:120},(_,i)=>B+(i+1)*MIN)}]});
  return {snapshot,input};
}
test('coverage: invalid standalone associations fail before compute with fixed redaction',()=>{
  const changes=[
    j=>delete j.input.coverage_context,j=>delete j.snapshot.coverage,
    j=>delete j.input.coverage_context.budgets.timestamp_rows,j=>j.input.coverage_context.budgets.timestamp_rows=0,
    j=>j.input.coverage_context.budgets.timestamp_rows=21601,j=>j.input.coverage_context.budgets.extra=1,
    j=>j.input.ownerId='foreign',j=>j.input.botId='foreign',j=>j.input.broker='settrade',
    j=>j.snapshot.owner.parent_user_id='foreign',j=>j.snapshot.owner.created_at=String(B)+'0',
    j=>j.snapshot.range.resolved.from++,j=>j.input.requestTime--,
    j=>j.input.coverage_context.accounts[0].bot_id='foreign',j=>j.input.coverage_context.accounts.push(structuredClone(j.input.coverage_context.accounts[0])),
    j=>delete j.snapshot.coverage_window_id,j=>j.snapshot.coverage_window_id=1,j=>j.snapshot.coverage_window_id=null,
    j=>j.snapshot.coverage.windows[0].union_id=99
  ];
  for(const change of changes){
    const job=structuredClone(FIXTURES.complete);change(job);let computed=false;
    assert.deepEqual(executeQr2Job(job,{compute(){computed=true;throw Error('secret');}}),{ok:false,kind:'other'});
    assert.equal(computed,false);
  }
  const valid=structuredClone(FIXTURES.complete);valid.snapshot.owner.created_at=String(B);
  assert.equal(valid.snapshot.coverage_window_id,0);assert.equal(executeQr2Job(valid).ok,true);
});
test('coverage: owner association, empty owner and one registry validation per job',()=>{
  for(const empty of [false,true]){
    const job=ownerCoverageJob(empty),before=JSON.stringify(job),result=executeQr2Job(job);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(JSON.stringify(job),before);
    assert.deepEqual(leakedCoverageKeys(result,OWNER_COVERAGE_PATH),[],'no internal coverage key; coverage only at the published entry path');
    assert.equal(Object.hasOwn(result.body,'market_coverage'),true);
  }
  const changes=[
    j=>j.input.currency='THB',j=>j.snapshot.currency='THB',j=>j.snapshot.ownerBots.shift(),
    j=>j.snapshot.ownerBots.push(j.snapshot.ownerBots[0]),j=>j.snapshot.accounts.push(j.snapshot.accounts[0]),
    j=>j.snapshot.accounts=[],j=>j.input.coverage_context.accounts=[],
    j=>j.snapshot.accounts[0].input.ownerId='foreign',j=>j.snapshot.accounts[0].input.from++,
    j=>j.snapshot.accounts[0].snapshot.coverageStart++,j=>j.snapshot.accounts[0].snapshot.coverage_window_id=1,
    j=>j.snapshot.accounts[0].snapshot.coverage={},j=>j.snapshot.accounts[0].input.coverage_context={}
  ];
  for(const change of changes){
    const job=ownerCoverageJob();let financialRead=false;
    Object.defineProperty(job.snapshot.accounts[0].snapshot,'fundings',{get(){financialRead=true;throw Error('financial path reached');}});
    change(job);assert.deepEqual(executeQr2Job(job),{ok:false,kind:'other'});assert.equal(financialRead,false);
  }
  const source=fs.readFileSync(path.join(SRC,'postgres','qr2-compute-worker.js'),'utf8');
  assert.equal((source.match(/validateCoverageSnapshot\(/g)||[]).length,0,'the worker validates the registry only inside the projection');
  assert.equal((source.match(/projectPublicCoverage\(/g)||[]).length,0,'the worker calls the outcome variant only');
  assert.equal((source.match(/projectPublicCoverageOutcome\(/g)||[]).length,1,'one projection call site: one validation and one build of each entry');
});

test('coverage metadata bounds reject before serialization, map lookup and long timestamp regex',()=>{
  const job=structuredClone(FIXTURES.complete);
  job.input.coverage_context.budgets.coverage_input_bytes=60;
  job.input.ownerId='x'.repeat(11);
  let touched=false;
  Object.defineProperty(job.snapshot,'owner',{get(){touched=true;throw Error('must not inspect financial metadata');}});
  assert.deepEqual(executeQr2Job(job),{ok:false,kind:'other'});assert.equal(touched,false);
  for(const change of [
    j=>j.input.coverage_context.accounts[0].bot_id='x'.repeat(11),
    j=>j.snapshot.ownerBots[0].bot_id='x'.repeat(11),
    j=>j.snapshot.accounts[0].input.botId='x'.repeat(11)
  ]){
    const owner=structuredClone(ownerCoverageJob());owner.input.coverage_context.budgets.coverage_input_bytes=60;change(owner);
    let serialized=false;const stringify=JSON.stringify;
    JSON.stringify=(...args)=>{serialized=true;return stringify(...args);};
    let answer;try{answer=executeQr2Job(owner);}finally{JSON.stringify=stringify;}
    assert.deepEqual(answer,{ok:false,kind:'other'});assert.equal(serialized,false);
  }
  const timestamp=structuredClone(FIXTURES.complete);timestamp.snapshot.owner.created_at='1'.repeat(17);
  const test=RegExp.prototype.test;let decimalRegex=false;
  RegExp.prototype.test=function(value){if(value===timestamp.snapshot.owner.created_at)decimalRegex=true;return test.call(this,value);};
  let answer;try{answer=executeQr2Job(timestamp);}finally{RegExp.prototype.test=test;}
  assert.deepEqual(answer,{ok:false,kind:'other'});assert.equal(decimalRegex,false);
});

/* ------------------------------------------------------------------ O6: coverage response wiring in the worker */

const readOnlyBody=job=>executeQr2Job(structuredClone(job));
const refusedAdmission={ok:false,kind:'qr2',code:'QR2_RANGE_ADMISSION_REFUSED'};

test('O6 coverage: the account job body coverage equals the Stage 1 build over the same stored minutes',()=>{
  const {snapshot,input}=FIXTURES.complete,result=readOnlyBody(FIXTURES.complete);
  assert.equal(result.ok,true);
  const resolved=snapshot.range.resolved;
  const expected=buildBarCoverage({resolved_range:resolved,market:{broker:BROKER,symbol:'BTCUSDT',timeframe:'1'},fact:{state:'COMPLETE',timestamps:Array.from({length:120},(_,i)=>B+(i+1)*MIN)}});
  assert.deepEqual(result.body.market_data.coverage,expected);
  assert.equal(JSON.stringify(result.body.market_data.coverage),JSON.stringify(expected),'key order is part of the public bytes');
  assert.deepEqual(Object.keys(result.body.market_data),['checked','table_present','instants','bars','gap','coverage']);
  assert.deepEqual(result.body.market_data.coverage,projectedCoverage(snapshot,input));
  assert.deepEqual(leakedCoverageKeys(result,ACCOUNT_COVERAGE_PATH),[]);
  // The unavailable fixture publishes a coverage with the unresolved range and no interval list.
  const unavailable=readOnlyBody(FIXTURES.unavailable);
  assert.equal(unavailable.ok,true);assert.equal(unavailable.body.market_data.coverage.state,'EMPTY');assert.equal(unavailable.body.market_data.coverage.resolved_range,null);
});

test('O6 coverage: the leak walk reports internal keys and a misplaced coverage key',()=>{
  assert.deepEqual(leakedCoverageKeys({body:{market_data:{coverage:{}}}},ACCOUNT_COVERAGE_PATH),[]);
  assert.deepEqual(leakedCoverageKeys({body:{coverage:{}}},ACCOUNT_COVERAGE_PATH),['$.body.coverage']);
  assert.deepEqual(leakedCoverageKeys({body:{market_data:{coverage:{coverage:1}}}},ACCOUNT_COVERAGE_PATH),['$.body.market_data.coverage.coverage']);
  for(const key of INTERNAL_COVERAGE_KEYS)assert.deepEqual(leakedCoverageKeys({body:{deep:[{[key]:1}]}},OWNER_COVERAGE_PATH),['$.body.deep[0].'+key],key);
  assert.deepEqual(leakedCoverageKeys({body:{market_coverage:{entries:[{id:'coverage:0',coverage:{}}]}}},OWNER_COVERAGE_PATH),[]);
  assert.deepEqual(leakedCoverageKeys({body:{market_data:{coverage:{}}}},OWNER_COVERAGE_PATH),['$.body.market_data.coverage']);
});

test('O6 coverage: the owner job carries market_coverage built once, frozen entries shared before cloning, and a plain clone after',()=>{
  const result=executeQr2Job(ownerCoverageJob());
  assert.equal(result.ok,true);
  const section=result.body.market_coverage;
  assert.equal(section.version,'qr2-owner-bar-coverage-v1');assert.equal(section.entries.length,1);
  assert.equal(Object.isFrozen(section),true);assert.equal(Object.isFrozen(section.entries[0].coverage),true,'projection output is shared, never copied or mutated');
  assert.deepEqual(section.accounts,[{bot_id:BOT,broker:BROKER,coverage_ids:['coverage:0']}]);
  const clone=structuredClone(result);
  assert.deepEqual(clone,result);assert.equal(Object.isFrozen(clone.body.market_coverage),false,'the pool message copy is unfrozen');
  assert.equal(nonPlain(result),null);
  const empty=executeQr2Job(ownerCoverageJob(true));
  assert.deepEqual(empty.body.market_coverage,{version:'qr2-owner-bar-coverage-v1',entries:[],accounts:[]});
});

test('O6 coverage: a lowered limit seam refuses with the code only; the route mapping gives 422 with no detail',()=>{
  const account=executeQr2Job(structuredClone(FIXTURES.complete),{coverageOutputLimit:1});
  assert.deepEqual(account,refusedAdmission);
  assert.equal(Object.hasOwn(account,'detail'),false);
  let computed=false;
  assert.deepEqual(executeQr2Job(structuredClone(FIXTURES.complete),{coverageOutputLimit:1,compute(){computed=true;throw Error('must not compute');}}),refusedAdmission);
  assert.equal(computed,false,'a refusal comes before any financial compute');
  assert.deepEqual(executeQr2Job(ownerCoverageJob(),{coverageOutputLimit:1}),refusedAdmission);
  const mapped=refusalAnswer(account.code,account.detail);
  assert.equal(mapped.status,422);assert.deepEqual(mapped.body,{code:'QR2_RANGE_ADMISSION_REFUSED',error:'The request is over a limit'});
  // The limit only lowers: a value above the context budget changes nothing.
  assert.equal(executeQr2Job(structuredClone(FIXTURES.complete),{coverageOutputLimit:2**40}).ok,true);
  for(const bad of [0,-1,1.5,'1',null,Number.NaN])assert.deepEqual(executeQr2Job(structuredClone(FIXTURES.complete),{coverageOutputLimit:bad}),{ok:false,kind:'other'},String(bad));
});

test('O6 coverage: a context-level overflow and an estimator defect map to kind other, never kind qr2',()=>{
  const overflow=structuredClone(FIXTURES.complete);
  overflow.input.coverage_context.budgets.coverage_output_bytes=100;
  assert.throws(()=>projectPublicCoverageOutcome(overflow.snapshot.coverage,overflow.input.coverage_context),{code:'QR2_RANGE_ADMISSION_REFUSED'},'planCoverage raises the overflow itself');
  assert.deepEqual(executeQr2Job(overflow),{ok:false,kind:'other'});
  // An estimator defect: the measured size is above the registry upper bound. Buffer.byteLength is raised for this one synchronous call.
  const original=Buffer.byteLength;let answer;
  try{Buffer.byteLength=()=>2**40;answer=executeQr2Job(structuredClone(FIXTURES.complete));}finally{Buffer.byteLength=original;}
  assert.deepEqual(answer,{ok:false,kind:'other'});
  let ownerAnswer;
  try{Buffer.byteLength=()=>2**40;ownerAnswer=executeQr2Job(ownerCoverageJob());}finally{Buffer.byteLength=original;}
  assert.deepEqual(ownerAnswer,{ok:false,kind:'other'});
});

test('O6 coverage: a corrupt registry gives kind other before any compute call',()=>{
  for(const corrupt of [j=>j.snapshot.coverage.windows[0].stored_minutes++,j=>j.snapshot.coverage.charges.output_intervals++,j=>j.snapshot.coverage.unions[0].fact.timestamps.pop(),j=>{j.snapshot.coverage={};}]){
    const job=structuredClone(FIXTURES.complete);corrupt(job);let computed=false;
    assert.deepEqual(executeQr2Job(job,{compute(){computed=true;throw Error('must not compute');}}),{ok:false,kind:'other'});
    assert.equal(computed,false);
  }
});

test('O6 coverage: the post-check fails a composer that drops coverage or returns another coverage object, and passes a refused body without market_data',()=>{
  const job=()=>structuredClone(FIXTURES.complete),view=()=>({reader:{compute_ms:1}});
  assert.deepEqual(executeQr2Job(job(),{compute:view,compose:()=>({status:{status:'COMPLETE'},market_data:{}})}),{ok:false,kind:'response'},'dropped');
  assert.deepEqual(executeQr2Job(job(),{compute:view,compose:(_,{coverage})=>({status:{status:'COMPLETE'},market_data:{coverage:structuredClone(coverage)}})}),{ok:false,kind:'response'},'equal but not the same object');
  assert.deepEqual(executeQr2Job(job(),{compute:view,compose:()=>({status:{status:'COMPLETE'},market_data:{coverage:null}})}),{ok:false,kind:'response'},'null coverage');
  assert.deepEqual(executeQr2Job(job(),{compute:view,compose:()=>null}),{ok:false,kind:'response'},'no body');
  assert.deepEqual(executeQr2Job(job(),{compute:view,compose:()=>({})}),{ok:false,kind:'response'},'no status');
  assert.deepEqual(executeQr2Job(job(),{compute:view,compose:()=>({status:{status:'REFUSED'},market_data:{}})}),{ok:false,kind:'response'},'a refused body must carry no market_data');
  const refused=executeQr2Job(job(),{compute:view,compose:()=>({status:{status:'REFUSED'},code:'QR2_NON_PAPER_ROW'})});
  assert.equal(refused.ok,true);assert.equal(Object.hasOwn(refused.body,'market_data'),false);
  const real=readOnlyBody(FIXTURES.refusedNonPaper);
  assert.equal(real.ok,true);assert.equal(real.body.status.status,'REFUSED');assert.equal(Object.hasOwn(real.body,'market_data'),false);
  assert.equal(JSON.stringify(real).includes('qr2-bar-coverage'),false);
});

test('O6 coverage: a coverageOutputLimit field in a message, top level or inside input, has no effect in the function or the real pool',async()=>{
  const base=FIXTURES.complete,baseline=executeQr2Job(structuredClone(base));
  assert.equal(baseline.ok,true);
  const topLevel=executeQr2Job({...structuredClone(base),coverageOutputLimit:1});
  assert.equal(stableResult(topLevel),stableResult(baseline));
  const inner=structuredClone(base);inner.input.coverageOutputLimit=1;
  assert.equal(stableResult(executeQr2Job(inner)),stableResult(baseline));
  const ownerBase=executeQr2Job(ownerCoverageJob()),ownerInner=ownerCoverageJob();ownerInner.input.coverageOutputLimit=1;
  assert.equal(stableResult(executeQr2Job(ownerInner)),stableResult(ownerBase));
  const pool=createQr2ComputePool({deadlineMs:20000});
  try{
    const viaPool=await pool.run(structuredClone(base.snapshot),{...structuredClone(base.input),coverageOutputLimit:1});
    assert.equal(viaPool.ok,true);assert.equal(stableResult(viaPool),stableResult(baseline));
    const owner=ownerCoverageJob(),ownerPool=await pool.run(owner.snapshot,{...owner.input,coverageOutputLimit:1});
    assert.equal(ownerPool.ok,true);assert.equal(stableResult(ownerPool),stableResult(ownerBase));
    assert.deepEqual(leakedCoverageKeys(viaPool,ACCOUNT_COVERAGE_PATH),[]);
    assert.deepEqual(leakedCoverageKeys(ownerPool,OWNER_COVERAGE_PATH),[]);
  }finally{await pool.close();}
});

test('O6 coverage: actual serialized body sizes at the 4096-interval synthetic maximum (observation only)',t=>{
  const {snapshot,input}=FIXTURES.complete,view=computeQr2View(snapshot,input);
  const to=B+8200*MIN,timestamps=Array.from({length:4095},(_,k)=>B+(2*k+2)*MIN);
  const coverage=buildBarCoverage({resolved_range:{from:B,to},market:{broker:BROKER,symbol:'BTCUSDT',timeframe:'1'},fact:{state:'COMPLETE',timestamps}});
  assert.equal(coverage.interval_count,4096);
  const body=composePerformanceResponse({...view,range:{...view.range,resolved:{from:B,to}}},{requestTime:NOW,coverage});
  const wrapper=Buffer.byteLength(JSON.stringify({market_data:{coverage}})),whole=Buffer.byteLength(JSON.stringify(body));
  t.diagnostic('coverage wrapper bytes '+wrapper+'; whole account body bytes '+whole);
  assert.ok(wrapper>0&&whole>wrapper);
});

test('O6 fix-r1 M03: an owner job with a null resolved range carries no market_coverage and passes the worker post-check',()=>{
  const job=ownerCoverageJob(true);
  job.input.from=NOW;job.input.to=NOW+DAY;
  job.snapshot.range=resolveRange({from:job.input.from,to:job.input.to,requestTime:NOW,coverageStart:B});
  assert.equal(job.snapshot.range.resolved,null);
  const result=executeQr2Job(job);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.body.status.status!=='REFUSED',true,'not refused, so only the null range omits the section');
  assert.equal(result.body.resolved_range,null);assert.equal(Object.hasOwn(result.body,'market_coverage'),false);
});