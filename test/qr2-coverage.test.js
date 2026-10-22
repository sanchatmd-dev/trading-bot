import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBarCoverage,validateBarCoverage,QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
const M=60000;
const build=(from,to,timestamps=[],extra={})=>buildBarCoverage({resolved_range:{from,to},market,fact:{state:'COMPLETE',timestamps},...extra});
const notNeeded=(resolved_range,identity=market)=>buildBarCoverage({resolved_range,market:identity,fact:{state:'NOT_NEEDED'}});
const reject=fn=>assert.throws(fn,{code:'QR2_COVERAGE_INVALID'});
const invalid=value=>assert.equal(validateBarCoverage(value).ok,false);

test('aligned endpoints include the candle closing exactly at to; empty rows are one full gap',()=>{
  const full=build(0,3*M,[M,2*M,3*M]);
  assert.deepEqual(full,{version:'qr2-bar-coverage-v1',source:'pine_market_bars',market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},resolved_range:{from:0,to:180000},inspected_window:{from:0,to:180000},excluded_edges:[],state:'COMPLETE',reason:null,complete:true,expected_minutes:3,stored_minutes:3,missing_minutes:0,interval_count:0,intervals:[]});
  const absent=build(0,3*M);
  assert.deepEqual(absent.intervals,[{from:0,to:180000,missing_minutes:3}]);
  assert.deepEqual([absent.expected_minutes,absent.stored_minutes,absent.missing_minutes,absent.interval_count],[3,0,3,1]);
  assert.deepEqual(build(0,M).intervals,[{from:0,to:60000,missing_minutes:1}]);
  assert.deepEqual(build(0,M,[M]).intervals,[]);
});

test('unaligned boundaries exclude partial candles without anchoring to stored history',()=>{
  const result=build(1,5*M+1,[3*M]);
  assert.deepEqual(result.inspected_window,{from:60000,to:300000});
  assert.deepEqual(result.excluded_edges,[{from:1,to:60000,reason:'PARTIAL_CANDLE'},{from:300000,to:300001,reason:'PARTIAL_CANDLE'}]);
  assert.deepEqual(result.intervals,[{from:60000,to:120000,missing_minutes:1},{from:180000,to:300000,missing_minutes:2}]);
  assert.deepEqual([result.expected_minutes,result.stored_minutes,result.missing_minutes],[4,1,3]);
  assert.equal(validateBarCoverage(result).ok,true);
});

test('leading, internal and trailing gaps are maximal half-open intervals',()=>{
  const result=build(0,10*M,[2*M,3*M,6*M,9*M]);
  assert.deepEqual(result.intervals,[{from:0,to:60000,missing_minutes:1},{from:180000,to:300000,missing_minutes:2},{from:360000,to:480000,missing_minutes:2},{from:540000,to:600000,missing_minutes:1}]);
  assert.equal(result.missing_minutes,6);assert.equal(result.interval_count,4);
});

test('null and short ranges require NOT_NEEDED and preserve their exact empty domains',()=>{
  const nullRange=notNeeded(null);
  assert.equal(nullRange.reason,'RANGE_UNRESOLVED');assert.equal(nullRange.state,'EMPTY');
  assert.equal(nullRange.inspected_window,null);assert.deepEqual(nullRange.excluded_edges,[]);
  for(const range of [{from:1,to:2},{from:1,to:M},{from:1,to:M+1},{from:M,to:M+1}]){
    const value=notNeeded(range);
    assert.equal(value.reason,'NO_FULL_CANDLES');assert.equal(value.complete,true);
    assert.equal(value.inspected_window,null);assert.deepEqual(value.excluded_edges,[{...range,reason:'PARTIAL_CANDLE'}]);
    assert.deepEqual([value.expected_minutes,value.stored_minutes,value.missing_minutes,value.interval_count],[0,0,0,0]);
    assert.deepEqual(value.intervals,[]);assert.equal(validateBarCoverage(value).ok,true);
  }
});

test('unsupported market has precedence over null/short ranges, with intended bounds retained',()=>{
  for(const range of [null,{from:1,to:2},{from:1,to:3*M+1}]){
    const value=notNeeded(range,null);
    assert.equal(value.market,null);assert.equal(value.state,'UNAVAILABLE');assert.equal(value.reason,'UNSUPPORTED_MARKET');
    assert.equal(value.complete,false);
    for(const key of ['expected_minutes','stored_minutes','missing_minutes','interval_count','intervals'])assert.equal(value[key],null);
    assert.equal(validateBarCoverage(value).ok,true);
  }
  const value=notNeeded({from:1,to:3*M+1},null);
  assert.deepEqual(value.inspected_window,{from:60000,to:180000});assert.equal(value.excluded_edges.length,2);
});

test('absent table is unavailable; certified zero rows is completed inspection with gaps',()=>{
  const value=build(0,M,[],{fact:{state:'TABLE_ABSENT'}});
  assert.equal(value.reason,'MARKET_DATA_TABLE_ABSENT');assert.equal(value.complete,false);assert.equal(value.intervals,null);
  assert.equal(validateBarCoverage(value).ok,true);
  assert.equal(build(0,M).state,'COMPLETE');
});

test('closed input shapes reject contradictory facts and malformed identity/ranges',()=>{
  for(const fact of [{state:'NOT_NEEDED'},{state:'ERROR'},{state:'COMPLETE'},{state:'TABLE_ABSENT',timestamps:[]},{state:'COMPLETE',timestamps:[],extra:true},null])reject(()=>build(0,M,[],{fact}));
  for(const range of [null,{from:1,to:2}])for(const fact of [{state:'COMPLETE',timestamps:[]},{state:'TABLE_ABSENT'}])reject(()=>build(0,M,[],{resolved_range:range,fact}));
  reject(()=>build(0,M,[],{market:null}));
  for(const identity of [{...market,extra:1},{...market,symbol:'ETHUSDT'},{...market,timeframe:1},{...market,broker:'binance-th'},{}])reject(()=>build(0,M,[],{market:identity}));
  for(const range of [{from:0,to:0},{from:2,to:1},{from:-1,to:M},{from:0.5,to:M},{from:0,to:Infinity},{from:0,to:Number.MAX_SAFE_INTEGER+1},{from:'0',to:M},{from:0,to:M,extra:1}])reject(()=>build(0,M,[],{resolved_range:range}));
  reject(()=>buildBarCoverage({resolved_range:null,market:null,fact:{state:'NOT_NEEDED'},extra:1}));
});

test('timestamp facts reject unsafe, off-grid, duplicate, unsorted and out-of-window rows without coercion',()=>{
  for(const rows of [[0],[-M],[M+1],[M,M],[2*M,M],[4*M],['60000'],[60000n],[NaN],[Infinity],[Number.MAX_SAFE_INTEGER+1],new Array(1),null,{}])reject(()=>build(0,3*M,rows));
  reject(()=>build(1,3*M,[M]));
});

test('more than fifty gaps remain complete, including both edges',()=>{
  const rows=Array.from({length:60},(_,i)=>(2*i+2)*M),value=build(0,121*M,rows);
  assert.equal(value.interval_count,61);assert.equal(value.intervals.length,61);assert.equal(value.missing_minutes,61);
  assert.deepEqual(value.intervals[0],{from:0,to:60000,missing_minutes:1});
  assert.deepEqual(value.intervals[60],{from:7200000,to:7260000,missing_minutes:1});
  assert.equal(validateBarCoverage(value).ok,true);
});

test('safe-integer arithmetic accepts final aligned windows and rejects overflowing ceil',()=>{
  const upper=9007199254740000;
  const value=build(upper-2*M,upper,[upper]);
  assert.deepEqual(value.intervals,[{from:9007199254620000,to:9007199254680000,missing_minutes:1}]);
  assert.equal(validateBarCoverage(value).ok,true);
  reject(()=>notNeeded({from:upper+1,to:Number.MAX_SAFE_INTEGER}));
  reject(()=>notNeeded({from:upper+1,to:Number.MAX_SAFE_INTEGER},null));
});

test('validator rejects malformed state combinations, metadata, counts, ranges and closed shape drift',()=>{
  const source=build(0,4*M,[2*M]);
  const mutations=[v=>v.extra=1,v=>delete v.source,v=>v.version='other',v=>v.source='other',v=>v.market.symbol='ETHUSDT',v=>v.market.extra=true,
    v=>v.inspected_window.from=M,v=>v.inspected_window.extra=1,v=>v.excluded_edges=[{from:0,to:1,reason:'PARTIAL_CANDLE'}],
    v=>v.state='EMPTY',v=>v.reason='OTHER',v=>v.complete=false,v=>v.expected_minutes=5,v=>v.stored_minutes=5,v=>v.missing_minutes=0,
    v=>v.interval_count=1,v=>v.intervals=null,v=>v.intervals[0].from=1,v=>v.intervals[0].to=0,v=>v.intervals[0].extra=true,
    v=>v.intervals[0].missing_minutes=2,v=>v.intervals[1].to=5*M,v=>v.intervals.reverse(),v=>v.stored_minutes=0.5,
    v=>v.expected_minutes=Number.MAX_SAFE_INTEGER+1,v=>v.intervals[1].to=Number.MAX_SAFE_INTEGER+1];
  for(const mutate of mutations){const value=structuredClone(source);mutate(value);invalid(value);}
  for(const value of [null,[],{},notNeeded(null),notNeeded(null,null),build(0,M,[],{fact:{state:'TABLE_ABSENT'}})]){
    if(value&&value.version){const changed=structuredClone(value);changed.stored_minutes=1;invalid(changed);}else invalid(value);
  }
});

test('validator rejects adjacent uncoalesced gaps and overlapping gaps even with matching totals',()=>{
  const value=build(0,3*M);
  value.interval_count=2;value.intervals=[{from:0,to:M,missing_minutes:1},{from:M,to:3*M,missing_minutes:2}];invalid(value);
  value.intervals=[{from:0,to:2*M,missing_minutes:2},{from:M,to:2*M,missing_minutes:1}];invalid(value);
});

test('builder and validator never mutate caller objects or timestamp arrays',()=>{
  const input={resolved_range:{from:1,to:5*M+1},market:{...market},fact:{state:'COMPLETE',timestamps:[2*M,4*M]}};
  const before=structuredClone(input);Object.freeze(input.fact.timestamps);Object.freeze(input.fact);Object.freeze(input.market);Object.freeze(input.resolved_range);Object.freeze(input);
  const value=buildBarCoverage(input);assert.deepEqual(input,before);
  const saved=structuredClone(value);assert.equal(validateBarCoverage(value).ok,true);assert.deepEqual(value,saved);
  value.resolved_range.from=2;value.market.symbol='changed';assert.deepEqual(input,before);
});


test('closed arrays reject sparse exclusions, sparse intervals and extra array properties',()=>{
  const value=build(1,3*M,[2*M]);value.excluded_edges=new Array(1);invalid(value);
  const other=build(0,3*M);other.intervals.extra=true;invalid(other);
  const rows=[M];rows.extra=true;reject(()=>build(0,M,rows));
  const sparse=build(0,3*M);sparse.intervals=new Array(1);invalid(sparse);
});
