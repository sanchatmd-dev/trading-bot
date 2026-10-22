import test from 'node:test';
import assert from 'node:assert/strict';
import {readCoverageSnapshot,decodeCoverageTimestamp,COVERAGE_SQL} from '../src/postgres/qr2-coverage-reader.js';
import {buildCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
const M=60000;
const budgets={union_minutes:1000,timestamp_rows:10,unique_windows:20,derivation_visits:1000,output_intervals:1000,coverage_input_bytes:1000000,coverage_output_bytes:1000000};
const account=(id,from=0,to=3*M)=>({bot_id:id,broker:'binance-global',market,resolved_range:{from,to}});
function transaction({isolation='repeatable read',readOnly='on',name='pine_market_bars',answers=[['60000','180000']]}={}){
  const calls=[];let index=0;
  return {isTransaction:true,calls,async query(sql,params){calls.push({sql,params});
    if(sql===COVERAGE_SQL.ISOLATION)return {rows:[{transaction_isolation:isolation}]};
    if(sql===COVERAGE_SQL.READ_ONLY)return {rows:[{transaction_read_only:readOnly}]};
    if(sql===COVERAGE_SQL.PROBE)return {rows:[{name}]};
    if(sql===COVERAGE_SQL.ROWS){const answer=answers[index++];if(answer instanceof Error)throw answer;return {rows:answer.map(bar_time=>({bar_time}))};}
    throw Error('unexpected SQL');
  }};
}

test('strict canonical text decoding rejects unsafe values before Number conversion',()=>{
  assert.equal(decodeCoverageTimestamp('0'),0);assert.equal(decodeCoverageTimestamp('9007199254740991'),Number.MAX_SAFE_INTEGER);
  for(const value of [0,60000,60000n,null,'','01','+1','-1',' 1','1 ','1.0','1e3','9007199254740992','10000000000000000'])assert.throws(()=>decodeCoverageTimestamp(value),{code:'QR2_REPORT_FAILED'});
});

test('transaction and budget guards precede probe or any unverified query',async()=>{
  for(const flag of [false,undefined]){const tx=transaction();tx.isTransaction=flag;await assert.rejects(readCoverageSnapshot({transaction:tx,accounts:[account('a')],budgets}),{code:'QR2_REPORT_FAILED'});assert.equal(tx.calls.length,0);}
  for(const options of [{isolation:'read committed'},{readOnly:'off'}]){const tx=transaction(options);await assert.rejects(readCoverageSnapshot({transaction:tx,accounts:[account('a')],budgets}),{code:'QR2_REPORT_FAILED'});assert.equal(tx.calls.some(c=>c.sql===COVERAGE_SQL.PROBE),false);}
  const tx=transaction();await assert.rejects(readCoverageSnapshot({transaction:tx,accounts:[],budgets:{...budgets,timestamp_rows:0}}),{code:'QR2_INPUT_INVALID'});assert.equal(tx.calls.length,0);
});

test('ordered bound SQL reads only timestamps; merged owner windows share one union',async()=>{
  const tx=transaction({isolation:'serializable'});
  const registry=await readCoverageSnapshot({transaction:tx,accounts:[account('a'),account('b')],budgets});
  assert.equal(registry.unions.length,1);assert.equal(registry.windows.length,1);assert.equal(registry.bindings.length,2);
  assert.deepEqual(tx.calls.map(c=>c.sql),[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY,COVERAGE_SQL.PROBE,COVERAGE_SQL.ROWS]);
  assert.deepEqual(tx.calls[3].params,['binance-global','BTCUSDT','1',0,180000,11]);
  assert.match(COVERAGE_SQL.ROWS,/bar_time::text/);assert.match(COVERAGE_SQL.ROWS,/ORDER BY public\.pine_market_bars\.bar_time LIMIT \$6$/);assert.ok(!/retrieved|provenance|OHLCV/i.test(COVERAGE_SQL.ROWS));
});

test('no union avoids probe; absent table differs from completed empty rows',async()=>{
  const tx=transaction();await readCoverageSnapshot({transaction:tx,accounts:[],budgets});assert.equal(tx.calls.length,2);
  const absent=transaction({name:null});const unavailable=await readCoverageSnapshot({transaction:absent,accounts:[account('a')],budgets});
  assert.deepEqual(unavailable.unions[0].fact,{state:'TABLE_ABSENT'});assert.equal(unavailable.windows[0].stored_minutes,null);assert.equal(absent.calls.length,3);
  const empty=await readCoverageSnapshot({transaction:transaction({answers:[[]]}),accounts:[account('a')],budgets});assert.equal(empty.windows[0].missing_minutes,3);assert.equal(empty.windows[0].interval_count,1);
});

test('exact row cap succeeds; sentinel and exhausted budget with later data refuse entire result',async()=>{
  const limited={...budgets,timestamp_rows:1};
  assert.ok(await readCoverageSnapshot({transaction:transaction({answers:[['60000']]}),accounts:[account('a')],budgets:limited}));
  await assert.rejects(readCoverageSnapshot({transaction:transaction(),accounts:[account('a')],budgets:limited}),{code:'QR2_RANGE_ADMISSION_REFUSED'});
  const accounts=[account('a',0,M),account('b',3*M,4*M)];
  const tx=transaction({answers:[['60000'],[]]});const result=await readCoverageSnapshot({transaction:tx,accounts,budgets:limited});
  assert.deepEqual(tx.calls.filter(c=>c.sql===COVERAGE_SQL.ROWS).map(c=>c.params[5]),[2,1]);assert.equal(result.unions[1].fact.timestamps.length,0);
  await assert.rejects(readCoverageSnapshot({transaction:transaction({answers:[['60000'],['240000']]}),accounts,budgets:limited}),{code:'QR2_RANGE_ADMISSION_REFUSED'});
});

test('misaligned, duplicate, unsorted, foreign-window rows and late query failures never yield partial registry',async()=>{
  for(const values of [['60001'],['60000','60000'],['120000','60000'],['0'],['240000'],[60000]])await assert.rejects(readCoverageSnapshot({transaction:transaction({answers:[values]}),accounts:[account('a')],budgets}),{code:'QR2_REPORT_FAILED'});
  await assert.rejects(readCoverageSnapshot({transaction:transaction({answers:[['60000'],Error('source')] }),accounts:[account('a',0,M),account('b',3*M,4*M)],budgets}),{code:'QR2_REPORT_FAILED'});
});


test('read LIMIT obeys pre-admitted input byte capacity, including zero and one-row sentinel',async()=>{
  const accounts=[account('a')];
  const empty=buildCoverageSnapshot({accounts,budgets,facts:[{state:'COMPLETE',timestamps:[]}]});
  const fixed=empty.charges.input_bytes_upper_bound;
  for(const [capacity,values] of [[0,[]],[1,['60000']]]){
    const limited={...budgets,coverage_input_bytes:fixed+capacity*17},tx=transaction({answers:[values]});
    await readCoverageSnapshot({transaction:tx,accounts,budgets:limited});
    assert.equal(tx.calls.find(c=>c.sql===COVERAGE_SQL.ROWS).params[5],capacity+1);
    const overflow=transaction({answers:[capacity?['60000','120000']:['60000']]});
    await assert.rejects(readCoverageSnapshot({transaction:overflow,accounts,budgets:limited}),{code:'QR2_RANGE_ADMISSION_REFUSED'});
  }
});
