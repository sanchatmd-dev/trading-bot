import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {createQr2Database} from '../helpers/qr2-reader-fixture.mjs';
import {readCoverageSnapshot,readCoverageSnapshotWithChunkRows,COVERAGE_SQL} from '../../src/postgres/qr2-coverage-reader.js';
import * as oracle from '../helpers/qr2-coverage-reader-oracle-95e6cec.js';
import {QR2_COVERAGE_LIMITS} from '../../src/portfolio/qr2-coverage-limits.js';
import {QR2_COVERAGE_MARKET as market} from '../../src/portfolio/qr2-coverage.js';
import {Qr2Error} from '../../src/portfolio/qr2-constants.js';

// QR-2 product change (b), slice b-1a, on real PostgreSQL: the keyset chunked reader against the frozen 95e6cec reader (the oracle) on the same
// database, the primary-key plan of the chunk statement, and snapshot consistency across chunks. Synthetic rows only; nothing here is evidence.
const M=60000;let f;
before(async()=>{f=await createQr2Database('robot_qr2_coverage_chunked');});
after(async()=>{await f?.dispose();});
const account=(id,from,to)=>({bot_id:id,broker:'binance-global',market,resolved_range:{from,to}});
const budgetsOf=over=>({...QR2_COVERAGE_LIMITS,...over});
async function clearBars(){await f.db.query('DELETE FROM public.pine_market_bars');}
/** Bulk insert of minute grid times (bar_time = minute * 60000) and optional extra raw times. Labelled synthetic rows: the bar JSON is a placeholder. */
async function insertMinutes(minutes,extraTimes=[]){
  const times=[...minutes.map(m=>m*M),...extraTimes];
  for(let i=0;i<times.length;i+=5000){
    await f.db.query("INSERT INTO public.pine_market_bars(broker,symbol,timeframe,bar_time,bar,provenance,content_hash) SELECT 'binance-global','BTCUSDT','1',t,'{}'::jsonb,'{}'::jsonb,'synthetic' FROM unnest($1::bigint[]) AS t",[times.slice(i,i+5000)]);
  }
}
const range=(from,to)=>Array.from({length:to-from+1},(_,i)=>from+i);
/** One REPEATABLE READ READ ONLY transaction on the shared facade, as the reader requires. */
const inSnapshot=fn=>f.db.transaction(async()=>{await f.db.query('SET TRANSACTION READ ONLY');return fn();},{isolation:'REPEATABLE READ'});
async function outcome(read,args){
  try{const value=await inSnapshot(()=>read({transaction:f.db,...args}));return {ok:true,text:JSON.stringify(value)};}
  catch(error){return {ok:false,name:error?.name,code:error?.code,detail:error?.detail===undefined?undefined:JSON.stringify(error.detail),qr2:error instanceof Qr2Error,message:error?.message};}
}
async function same(args,chunks,label){
  const expected=await outcome(oracle.readCoverageSnapshot,args);
  assert.deepEqual(await outcome(readCoverageSnapshot,args),expected,label+' product entry point');
  for(const chunk of chunks)assert.deepEqual(await outcome(x=>readCoverageSnapshotWithChunkRows(x,chunk),args),expected,label+' chunk '+chunk);
  return expected;
}

test('schema pin: the keyset statement relies on the primary key (broker, symbol, timeframe, bar_time)',async()=>{
  const {rows}=await f.db.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid='public.pine_market_bars'::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[],a.attnum)`);
  assert.deepEqual(rows.map(r=>r.attname),['broker','symbol','timeframe','bar_time']);
  const column=await f.db.query("SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='pine_market_bars' AND column_name='bar_time'");
  assert.deepEqual(column.rows,[{data_type:'bigint',is_nullable:'NO'}]);
});

test('plan: a chunk statement with a mid-window cursor walks the primary key in order, with no sort and no sequential scan',{timeout:60000},async()=>{
  await clearBars();await insertMinutes(range(1,21600));
  await f.db.query('ANALYZE public.pine_market_bars');
  const params=['binance-global','BTCUSDT','1',8192*M,21601*M,8192];
  const {rows}=await inSnapshot(()=>f.db.query('EXPLAIN (FORMAT JSON) '+COVERAGE_SQL.ROWS,params));
  const plan=rows[0]['QUERY PLAN'][0].Plan,nodes=[];(function walk(node){nodes.push(node);for(const child of node.Plans??[])walk(child);})(plan);
  const types=nodes.map(n=>n['Node Type']);
  assert.ok(types.some(t=>/Index (Only )?Scan/.test(t)),'an index scan: '+types.join(' > '));
  assert.ok(!types.some(t=>/Sort|Seq Scan/.test(t)),'no sort, no sequential scan: '+types.join(' > '));
  assert.ok(nodes.some(n=>n['Index Name']==='pine_market_bars_pkey'),'the primary key index');
  assert.ok(nodes.every(n=>n['Relation Name']===undefined||n['Relation Name']==='pine_market_bars'));
});

test('differential on real rows: 21600 dense, 21601 (sentinel), a gappy history, and an off-grid row, chunked at 8192, 4096, 1000 and 7',{timeout:300000},async()=>{
  const accounts=[account('a',0,21700*M)];
  const cases=[
    ['dense 8191',range(1,8191),[]],['dense 8192',range(1,8192),[]],['dense 8193',range(1,8193),[]],['dense 16385',range(1,16385),[]],
    ['dense 21600',range(1,21600),[]],['dense 21601',range(1,21601),[]],
    ['gappy',range(1,21700).filter(m=>m%7!==0),[]],
    ['off-grid early, within capacity',range(1,9000),[2*M+13]],
    ['off-grid early, overflow later',range(1,21601),[2*M+13]],
    ['off-grid as the cursor row of chunk 1, overflow later',range(1,21602).filter(m=>m!==8192),[8192*M+5]]
  ];
  const seen={complete:0,degraded:0,failed:0};
  for(const [label,minutes,extra] of cases){
    await clearBars();await insertMinutes(minutes,extra);
    const result=await same({accounts,budgets:budgetsOf({})},[8192,4096,1000],label);
    if(!result.ok)seen.failed++;else if(JSON.parse(result.text).unions[0].fact.state==='COMPLETE')seen.complete++;else seen.degraded++;
  }
  assert.deepEqual(seen,{complete:6,degraded:3,failed:1});
});

test('differential on real rows at small chunk sizes (7, 60, 61) with a lowered row budget, one and two unions, merged owner windows',{timeout:120000},async()=>{
  await clearBars();await insertMinutes(range(1,150).filter(m=>m%9!==0),[40*M+1]);
  for(const capacity of [30,100,135])for(const accounts of [
    [account('a',0,60*M)],[account('a',0,80*M),account('b',100*M,160*M)],[account('a',0,155*M),account('b',50*M,155*M)]
  ])await same({accounts,budgets:budgetsOf({timestamp_rows:capacity,union_minutes:200})},[1,7,60,61,8192],'capacity '+capacity+' '+accounts.length+' windows');
});

test('snapshot consistency: bars committed by another connection between chunks are never seen, whatever the chunk size',{timeout:120000},async()=>{
  for(const chunk of [4096,1000,7]){
    await clearBars();await insertMinutes(range(1,9000).filter(m=>m%2===1));
    const accounts=[account('a',0,9100*M)],args={accounts,budgets:budgetsOf({})};
    const before=await outcome(oracle.readCoverageSnapshot,args);
    let rowQueries=0;
    const wrapper={get isTransaction(){return f.db.isTransaction;},async query(sql,params){
      const answer=await f.db.query(sql,params);
      if(sql===COVERAGE_SQL.ROWS&&++rowQueries===1){
        // Autocommit on the pool, outside this REPEATABLE READ transaction: new even minutes inside the window, below and above the first cursor.
        await f.db.pool.query("INSERT INTO public.pine_market_bars(broker,symbol,timeframe,bar_time,bar,provenance,content_hash) SELECT 'binance-global','BTCUSDT','1',m*60000,'{}'::jsonb,'{}'::jsonb,'late' FROM generate_series(2,8998,2) AS m");
      }
      return answer;
    }};
    const read=await inSnapshot(()=>readCoverageSnapshotWithChunkRows({transaction:wrapper,...args},chunk));
    assert.ok(rowQueries>=2,'the read spans several chunks: '+rowQueries);
    assert.equal(JSON.stringify(read),before.text,'the registry equals the pre-insert read');
    const fresh=await outcome(oracle.readCoverageSnapshot,args);
    assert.notEqual(fresh.text,before.text,'a fresh snapshot sees the new bars');
  }
});

test('an empty table answers one empty chunk statement and the oracle result',async()=>{
  await clearBars();
  const args={accounts:[account('a',0,10*M)],budgets:budgetsOf({})};
  const issued=[];const wrapper={get isTransaction(){return f.db.isTransaction;},async query(sql,params){issued.push(sql===COVERAGE_SQL.ROWS?params:sql);return f.db.query(sql,params);}};
  const empty=await inSnapshot(()=>readCoverageSnapshotWithChunkRows({transaction:wrapper,...args},3));
  assert.equal(empty.unions[0].fact.timestamps.length,0);
  assert.deepEqual(issued.filter(x=>Array.isArray(x)),[['binance-global','BTCUSDT','1',0,10*M,3]]);
  assert.deepEqual(JSON.stringify(empty),(await outcome(oracle.readCoverageSnapshot,args)).text);
});
