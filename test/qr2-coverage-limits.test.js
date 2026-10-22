import test from 'node:test';
import assert from 'node:assert/strict';
import {QR2_COVERAGE_LIMITS,coverageReadBudgets} from '../src/portfolio/qr2-coverage-limits.js';
import {readQr2Snapshot,QR2_LEDGER_COUNT_SQL,QR2_READ_LIMITS} from '../src/postgres/qr2-reader.js';
import {readQr2OwnerSnapshot} from '../src/postgres/qr2-owner-reader.js';
import {COVERAGE_SQL} from '../src/postgres/qr2-coverage-reader.js';
import {validateCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED as boundaries} from '../src/portfolio/qr2-boundaries.js';

test('local coverage envelope is exact, frozen and lowering only',()=>{
  assert.deepEqual(QR2_COVERAGE_LIMITS,{union_minutes:43200,timestamp_rows:21600,unique_windows:20,derivation_visits:100000,output_intervals:4096,coverage_input_bytes:524288,coverage_output_bytes:1048576});
  assert.ok(Object.isFrozen(QR2_COVERAGE_LIMITS));
  for(const [key,max] of Object.entries(QR2_COVERAGE_LIMITS)){
    assert.equal(coverageReadBudgets({[key]:1})[key],1);
    for(const value of [0,-1,1.5,max+1,Infinity,'1'])assert.throws(()=>coverageReadBudgets({[key]:value}),{code:'QR2_INPUT_INVALID'});
  }
  for(const value of [null,[],{unknown:1},{[Symbol('x')]:1},Object.create({timestamp_rows:1})])assert.throws(()=>coverageReadBudgets(value),{code:'QR2_INPUT_INVALID'});
  assert.throws(()=>coverageReadBudgets({get timestamp_rows(){throw Error('must not execute');}}),{code:'QR2_INPUT_INVALID'});
  const override={timestamp_rows:1};const result=coverageReadBudgets(override);assert.deepEqual(override,{timestamp_rows:1});assert.ok(Object.isFrozen(result));
});
const args={ownerId:'owner',botId:'a',broker:'binance-global',from:0,to:180000,requestTime:180000,boundaries};
function fixture({audit=0,pending=0,grid=2,table=true,corrupt=false,secondAudit=0}={}){
  const queries=[];
  const db={isTransaction:false,async transaction(fn){this.isTransaction=true;try{return await fn();}finally{this.isTransaction=false;}},async query(sql,values=[]){
    queries.push({sql,values});let rows;
    if(sql==='SHOW transaction_isolation')rows=[{transaction_isolation:'repeatable read'}];
    else if(sql==='SHOW transaction_read_only')rows=[{transaction_read_only:'on'}];
    else if(sql==='SET TRANSACTION READ ONLY')rows=[];
    else if(sql===COVERAGE_SQL.PROBE)rows=[{name:table?'public.pine_market_bars':null}];
    else if(sql===COVERAGE_SQL.ROWS)rows=[{bar_time:'60000'},{bar_time:'180000'}];
    else if(sql.startsWith('SELECT id,created_at FROM public.users'))rows=[{id:'a',created_at:0},{id:'b',created_at:0}];
    else if(sql.startsWith('SELECT id,parent_user_id'))rows=[{id:values[0],parent_user_id:values[0]==='owner'?null:'owner',created_at:0}];
    else if(sql===QR2_LEDGER_COUNT_SQL)rows=[{fundings:'1',journal:'0',fills:'0',lots:'0',snapshots:'0'}];
    else if(sql.startsWith('SELECT count(*) AS n FROM public.audit'))rows=[{n:values[0]==='b'?secondAudit:audit}];
    else if(sql.startsWith('SELECT count(*) AS n FROM public.signals'))rows=[{n:pending}];
    else if(sql.includes(') grid'))rows=[{n:grid}];
    else if(sql.startsWith('SELECT count(*)'))rows=[{n:0}];
    else if(sql.startsWith('SELECT id,user_id,broker,at,equity_delta'))rows=corrupt?[]:[{id:1,user_id:values[0],broker:values[1],at:0,kind:'INITIAL',cash_delta:'100',equity_delta:'100'}];
    else if(sql.startsWith('SELECT '))rows=[];
    else throw Error('Unexpected query '+sql);
    return {rows};
  }};
  return {queries,db,store:{db,paperAccount:async()=>({cash:'100'}),exposure:async()=>({})}};
}
test('standalone reads coverage with no fills; context independent and public limits unchanged',async()=>{
  const f=fixture(),r=await readQr2Snapshot(f.store,args);
  assert.equal(r.snapshot.coverage.unions.length,1);assert.equal(r.snapshot.coverage_window_id,r.snapshot.coverage.bindings[0].window_id);
  assert.deepEqual(r.input.coverage_context.accounts,[{bot_id:'a',broker:'binance-global',market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},resolved_range:{from:0,to:180000}}]);
  assert.deepEqual(r.input.limits,QR2_READ_LIMITS);assert.deepEqual(validateCoverageSnapshot(r.snapshot.coverage,r.input.coverage_context),{ok:true});
  const source=f.queries.findIndex(q=>q.sql===COVERAGE_SQL.ROWS),detail=f.queries.findIndex(q=>q.sql.startsWith('SELECT id,user_id,broker,at,equity_delta'));
  assert.ok(source<detail);assert.ok(f.queries.slice(0,source).some(q=>q.sql.includes(') grid')));structuredClone(r);
});
test('audit and precise grid refusal happen before coverage or detail reads',async()=>{
  for(const settings of [{audit:2001},{grid:5001}]){
    const f=fixture(settings);await assert.rejects(readQr2Snapshot(f.store,args),{code:'QR2_RANGE_ADMISSION_REFUSED'});
    assert.ok(!f.queries.some(q=>q.sql===COVERAGE_SQL.PROBE||q.sql.startsWith('SELECT id,user_id,broker,at,equity_delta')));
  }
});
test('detail/count mismatch fails closed; unsupported and absent table remain distinct',async()=>{
  await assert.rejects(readQr2Snapshot(fixture({corrupt:true}).store,args),{code:'QR2_REPORT_FAILED'});
  const f=fixture();await readQr2Snapshot(f.store,{...args,broker:'settrade'});assert.ok(!f.queries.some(q=>q.sql===COVERAGE_SQL.PROBE));
  const absent=fixture({table:false}),r=await readQr2Snapshot(absent.store,args);assert.equal(r.snapshot.coverage.unions[0].fact.state,'TABLE_ABSENT');
});
test('owner reads one shared registry after all members pass; members hold references only',async()=>{
  const f=fixture(),r=await readQr2OwnerSnapshot(f.store,{...args,currency:'USDT'});
  assert.equal(r.snapshot.accounts.length,2);assert.equal(f.queries.filter(q=>q.sql===COVERAGE_SQL.ROWS).length,1);
  assert.equal(r.snapshot.coverage.windows.length,1);assert.equal(r.input.coverage_context.accounts.length,2);
  for(const member of r.snapshot.accounts){assert.equal(member.snapshot.coverage_window_id,r.snapshot.coverage.windows[0].id);assert.ok(!Object.hasOwn(member.snapshot,'coverage'));assert.ok(!Object.hasOwn(member.input,'coverage_context'));}
  const source=f.queries.findIndex(q=>q.sql===COVERAGE_SQL.ROWS);assert.ok(f.queries.slice(0,source).some(q=>q.sql.includes(') grid')&&q.values[0]==='b'));
  assert.deepEqual(validateCoverageSnapshot(r.snapshot.coverage,r.input.coverage_context),{ok:true});
});
test('later owner member refusal prevents every coverage and detail read',async()=>{
  const f=fixture({secondAudit:2001});await assert.rejects(readQr2OwnerSnapshot(f.store,{...args,currency:'USDT'}),{code:'QR2_RANGE_ADMISSION_REFUSED'});
  assert.ok(!f.queries.some(q=>q.sql===COVERAGE_SQL.PROBE||q.sql.startsWith('SELECT id,user_id,broker,at,equity_delta')));
});

test('31-day coverage union refuses whole request before source/detail reads',async()=>{
  const f=fixture({grid:32});await assert.rejects(readQr2Snapshot(f.store,{...args,to:31*86400000,requestTime:31*86400000}),{code:'QR2_RANGE_ADMISSION_REFUSED'});
  assert.ok(!f.queries.some(q=>q.sql===COVERAGE_SQL.PROBE||q.sql.startsWith('SELECT id,user_id,broker,at,equity_delta')));
});

test('non-enumerable overrides retain validated lowering and reject raised values or accessors',()=>{
  const given=Object.defineProperty({},'timestamp_rows',{value:1});
  const result=coverageReadBudgets(given);
  assert.equal(result.timestamp_rows,1);
  assert.ok(Object.isFrozen(result));
  assert.equal(Object.getOwnPropertyDescriptor(given,'timestamp_rows').enumerable,false);
  assert.equal(given.timestamp_rows,1);
  assert.throws(()=>coverageReadBudgets(Object.defineProperty({},'timestamp_rows',{value:21601})),{code:'QR2_INPUT_INVALID'});
  let called=false;
  const accessor=Object.defineProperty({},'timestamp_rows',{get(){called=true;return 1;}});
  assert.throws(()=>coverageReadBudgets(accessor),{code:'QR2_INPUT_INVALID'});
  assert.equal(called,false);
});

test('pre-admission preserves original refusal messages and bounded detail values',async()=>{
  for(const [settings,message,detail] of [
    [{grid:5007},'grid instants over the limit',{limit:'grid_instants',value:5007,max:5000}],
    [{audit:2017},'audit rows over the limit',{limit:'audit_rows',value:2001,max:2000}],
    [{pending:1017},'pending orders over the limit',{limit:'pending_orders',value:1001,max:1000}]
  ]){
    const f=fixture(settings);
    await assert.rejects(readQr2Snapshot(f.store,args),error=>{assert.equal(error.code,'QR2_RANGE_ADMISSION_REFUSED');assert.equal(error.message,message);assert.deepEqual(error.detail,detail);return true;});
    assert.ok(!f.queries.some(q=>q.sql===COVERAGE_SQL.PROBE||q.sql.startsWith('SELECT id,user_id,broker,at,equity_delta')));
  }
});
