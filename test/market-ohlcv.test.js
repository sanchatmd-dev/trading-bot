import test,{describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {
  OHLCV_PATH,MARKET,SOURCE,INTERVALS,STALE_AFTER_SECONDS,HEALTH,GAP_RANGE_CAP,SQL,parseOhlcvQuery,ohlcvWindow,historyLower,
  assembleGaps,shapeOhlcv,classifyMarketHealth,MarketDataReader,marketOhlcvRoutes} from '../src/postgres/market-ohlcv.js';
import {ReadinessService} from '../src/postgres/pf3-readiness-service.js';

// No test in this file may reach a network: the stored-data path never calls Binance.
// The guard is scoped to this describe block: npm test runs every file in one process (--test-isolation=none).
describe('market-ohlcv (no network)',()=>{
const realFetch=globalThis.fetch;
before(()=>{globalThis.fetch=()=>{throw new Error('network call forbidden in market-ohlcv tests');};});
after(()=>{globalThis.fetch=realFetch;});

const M=60000,H=60*M,D=24*H;
const L=Date.parse('2026-10-04T00:00:00Z');
const LATEST=Date.parse('2026-10-04T05:07:00Z'),NOW=LATEST+30000;
const query=text=>new URLSearchParams(text);
const code=fn=>{try{fn();}catch(error){return error;}return null;};
const codeOf=async operation=>{try{await operation();}catch(error){return error;}return null;};

// Fake database: records every statement and answers from the scenario by statement identity.
function fakeDb(scenario={}){
  const statements=[];
  const db={statements,
    async query(sql,params=[]){
      statements.push({sql,params});
      if(sql.startsWith('SET TRANSACTION'))return {rows:[]};
      if(sql===SQL.PROBE)return {rows:[{name:Object.hasOwn(scenario,'probe')?scenario.probe:'pine_market_bars'}]};
      if(sql===SQL.SPAN)return {rows:[{latest:scenario.latest??null,first:scenario.first??null}]};
      // BARS rows carry the edge facts of the window on every row, as the window functions in the SQL do.
      if(sql===SQL.BARS){const edge=scenario.edge??{n:0,first:null,last:null};return {rows:(scenario.bars??[]).map(row=>({...row,n:edge.n,first:edge.first,last:edge.last}))};}
      if(sql===SQL.EDGE)return {rows:[scenario.edge??{n:0,first:null,last:null}]};
      if(sql===SQL.GAPS)return {rows:scenario.internal??[]};
      throw new Error('unexpected statement '+sql.slice(0,40));
    },
    transaction(fn){return fn();}};
  return db;
}
const bucketRow=(bucket,minutes,price='62000.01000000')=>({bucket,minutes,open:price,high:'62100.50000000',low:'61900.00000000',close:'62050.20000000',volume:'12.50000000'});

test('constants: interval table, health thresholds and the SQL are frozen',()=>{
  assert.deepEqual(Object.keys(INTERVALS),['1m','5m','15m','1h','4h','1d']);
  assert.deepEqual(INTERVALS['1h'],{ms:H,limit:168,cap:720});assert.deepEqual(INTERVALS['4h'],{ms:4*H,limit:180,cap:180});
  assert.deepEqual(INTERVALS['1d'],{ms:D,limit:30,cap:30});assert.deepEqual(INTERVALS['1m'],{ms:M,limit:240,cap:1000});
  assert.ok(Object.isFrozen(INTERVALS)&&Object.isFrozen(INTERVALS['1h'])&&Object.isFrozen(SQL)&&Object.isFrozen(HEALTH)&&Object.isFrozen(MARKET));
  assert.equal(OHLCV_PATH,'/api/market/ohlcv');assert.equal(SOURCE,'binance-spot-public-stored');
  assert.equal(STALE_AFTER_SECONDS,180);assert.equal(GAP_RANGE_CAP,50);
  assert.deepEqual({...MARKET},{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
});

test('parse: defaults per interval, strict keys, no clamping',()=>{
  assert.deepEqual(parseOhlcvQuery(query('')),{interval:'1h',ms:H,limit:168});
  for(const [interval,spec] of Object.entries(INTERVALS))
    assert.deepEqual(parseOhlcvQuery(query('interval='+interval)),{interval,ms:spec.ms,limit:spec.limit});
  for(const [interval,spec] of Object.entries(INTERVALS)){
    assert.equal(parseOhlcvQuery(query(`interval=${interval}&limit=${spec.cap}`)).limit,spec.cap,'cap accepted '+interval);
    assert.equal(code(()=>parseOhlcvQuery(query(`interval=${interval}&limit=${spec.cap+1}`))).code,'LIMIT_OUT_OF_RANGE','cap+1 '+interval);
  }
  assert.equal(parseOhlcvQuery(query('limit=1')).limit,1);
  for(const bad of ['0','-1','1.5','abc','01','10000','1e3',' 5','5 '])
    assert.equal(code(()=>parseOhlcvQuery(query('limit='+encodeURIComponent(bad)))).code,'LIMIT_OUT_OF_RANGE','limit '+JSON.stringify(bad));
  const invalid=[['unknown key','foo=1'],['duplicate interval','interval=1h&interval=5m'],['duplicate limit','limit=5&limit=6'],
    ['empty limit','limit='],['empty interval','interval='],['empty bot_id','bot_id='],['long bot_id','bot_id='+'a'.repeat(129)],
    ['case of key','Interval=1h'],['bot_id twice','bot_id=a&bot_id=b']];
  for(const [name,text] of invalid){
    const error=code(()=>parseOhlcvQuery(query(text)));
    assert.equal(error?.code,'INVALID_FIELDS',name);assert.equal(error.status,400);
  }
  assert.deepEqual(parseOhlcvQuery(query('bot_id=all')),{interval:'1h',ms:H,limit:168},'bot_id is accepted and ignored');
  assert.equal(parseOhlcvQuery(query('bot_id='+'a'.repeat(128))).interval,'1h');
  for(const bad of ['2h','1H','1m ','60m','__proto__','toString'])
    assert.equal(code(()=>parseOhlcvQuery(query('interval='+encodeURIComponent(bad)))).code,'INTERVAL_NOT_ALLOWED','interval '+JSON.stringify(bad));
});

test('parse: a failed parse issues zero SQL',async()=>{
  const db=fakeDb({latest:LATEST,first:L}),reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  for(const text of ['interval=2h','limit=0','foo=1','limit=9999']){
    const error=await codeOf(()=>reader.ohlcv(query(text)));
    assert.equal(error.status,400,text);
  }
  assert.equal(db.statements.length,0);
});

test('window: end is the last close boundary at or before the newest stored bar; start is exclusive',()=>{
  assert.deepEqual(ohlcvWindow(LATEST,M,240),{start:LATEST-240*M,end:LATEST},'1m ends at latest');
  assert.equal(ohlcvWindow(LATEST,5*M,10).end,Date.parse('2026-10-04T05:05:00Z'));
  assert.equal(ohlcvWindow(LATEST,15*M,10).end,Date.parse('2026-10-04T05:00:00Z'));
  assert.equal(ohlcvWindow(LATEST,H,10).end,Date.parse('2026-10-04T05:00:00Z'));
  const four=ohlcvWindow(LATEST,4*H,180);
  assert.equal(four.end,Date.parse('2026-10-04T04:00:00Z'));assert.equal(four.start,four.end-180*4*H);
  const day=ohlcvWindow(LATEST,D,30);
  assert.equal(day.end,Date.parse('2026-10-04T00:00:00Z'));assert.equal(day.start,day.end-30*D);
  for(const [interval,spec] of Object.entries(INTERVALS)){
    const window=ohlcvWindow(LATEST,spec.ms,spec.limit);
    assert.equal(window.start%spec.ms,0,'start aligned '+interval);assert.equal(window.end%spec.ms,0,'end aligned '+interval);
    assert.ok(window.end<=LATEST,'only closed buckets '+interval);assert.equal(window.end-window.start,spec.limit*spec.ms);
  }
  assert.equal(historyLower(L-100*M,L+5*M),L+4*M,'history starts at the first stored open time');
  assert.equal(historyLower(L+10*M,L+5*M),L+10*M,'a window inside the history keeps its start');
});

test('window through the reader: SPAN gets now; BARS gets the aligned window and the table bucket size',async()=>{
  const db=fakeDb({latest:LATEST,first:LATEST-3*D,bars:[bucketRow(Date.parse('2026-10-04T00:00:00Z'),240)],edge:{n:240,first:L+M,last:L+240*M},internal:[]});
  const reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  const answer=await reader.ohlcv(query('interval=4h'));
  const span=db.statements.find(item=>item.sql===SQL.SPAN),bars=db.statements.find(item=>item.sql===SQL.BARS);
  assert.deepEqual(span.params,[MARKET.broker,MARKET.symbol,NOW]);
  const end=Date.parse('2026-10-04T04:00:00Z');
  assert.deepEqual(bars.params,[MARKET.broker,MARKET.symbol,end-180*4*H,end,4*H]);
  assert.equal(answer.window.end_close_time,end);assert.equal(answer.interval,'4h');assert.equal(answer.limit,180);
  assert.equal(answer.latest_closed_bar.close_time,LATEST);assert.equal(answer.latest_closed_bar.open_time,LATEST-M);
  assert.equal(answer.window.history_start_open_time,LATEST-3*D-M);
});

const G=(overrides={})=>assembleGaps({lower:L,end:L+10*M,n:10,first:L+M,last:L+10*M,internal:[],internalTotal:0,...overrides});

test('gaps: none, leading, internal, trailing and a whole empty window; every time is an open time',()=>{
  assert.deepEqual(G(),{count:0,missing_minutes:0,ranges:[],truncated:false});
  assert.deepEqual(G({n:7,first:L+4*M}),{count:1,missing_minutes:3,truncated:false,
    ranges:[{from_open_time:L,to_open_time:L+2*M,missing_minutes:3}]},'leading: the first bar closes at +4m, so opens +0..+2m are missing');
  assert.deepEqual(G({n:7,internal:[{prev:L+3*M,bar_time:L+7*M}],internalTotal:1}),{count:1,missing_minutes:3,truncated:false,
    ranges:[{from_open_time:L+3*M,to_open_time:L+5*M,missing_minutes:3}]},'internal');
  assert.deepEqual(G({n:7,last:L+7*M}),{count:1,missing_minutes:3,truncated:false,
    ranges:[{from_open_time:L+7*M,to_open_time:L+9*M,missing_minutes:3}]},'trailing');
  assert.deepEqual(G({n:0,first:null,last:null}),{count:1,missing_minutes:10,truncated:false,
    ranges:[{from_open_time:L,to_open_time:L+9*M,missing_minutes:10}]},'whole window empty');
  assert.deepEqual(G({n:0,first:null,last:null,end:L}),{count:0,missing_minutes:0,ranges:[],truncated:false},'an empty window of no length is not a gap');
  // A single missing minute keeps from=to.
  assert.deepEqual(G({n:9,internal:[{prev:L+2*M,bar_time:L+4*M}],internalTotal:1}).ranges,[{from_open_time:L+2*M,to_open_time:L+2*M,missing_minutes:1}]);
});

test('gaps: all kinds together keep their order leading, internal, trailing and exact totals',()=>{
  const gaps=assembleGaps({lower:L,end:L+20*M,n:11,first:L+3*M,last:L+15*M,internal:[{prev:L+6*M,bar_time:L+9*M}],internalTotal:1});
  assert.deepEqual(gaps.ranges.map(item=>[item.from_open_time,item.to_open_time,item.missing_minutes]),
    [[L,L+M,2],[L+6*M,L+7*M,2],[L+15*M,L+19*M,5]]);
  assert.equal(gaps.count,3);assert.equal(gaps.missing_minutes,20-11,'missing = expected - stored');
  assert.equal(gaps.ranges.reduce((total,item)=>total+item.missing_minutes,0),9,'ranges add up when not truncated');
});

test('gaps: history shorter than the window has no leading gap before the first stored bar',async()=>{
  // The newest bar is at L+10m and the stored history starts at L+5m: a 1000 minute window reaches far before that.
  const latest=L+10*M,first=L+5*M;
  const db=fakeDb({latest,first,bars:[bucketRow(L,6)],edge:{n:6,first,last:latest},internal:[]});
  const reader=new MarketDataReader({db,enabled:true,clock:()=>latest+1000});
  const answer=await reader.ohlcv(query('interval=1m&limit=1000'));
  assert.deepEqual(answer.gaps,{count:0,missing_minutes:0,ranges:[],truncated:false});
  assert.equal(answer.window.expected_minutes,6);assert.equal(answer.window.stored_minutes,6);
  assert.equal(answer.window.history_start_open_time,first-M);
  const barsParams=db.statements.find(item=>item.sql===SQL.BARS).params;
  assert.equal(barsParams[2],latest-1000*M,'the read window still spans the requested range');
  assert.equal(db.statements.some(item=>item.sql===SQL.EDGE),false,'the OHLCV request folds the edge read into BARS: two window scans, not three');
});

test('gaps: 60 internal gaps with a cap of 50 truncate and keep exact totals',()=>{
  const internal=Array.from({length:50},(_,index)=>({prev:L+(index*4+1)*M,bar_time:L+(index*4+3)*M}));
  const gaps=assembleGaps({lower:L,end:L+400*M,n:340,first:L+M,last:L+400*M,internal,internalTotal:60},50);
  assert.equal(gaps.count,60);assert.equal(gaps.ranges.length,50);assert.equal(gaps.truncated,true);assert.equal(gaps.missing_minutes,60);
  assert.deepEqual(gaps.ranges[0],{from_open_time:L+M,to_open_time:L+M,missing_minutes:1});
  const small=assembleGaps({lower:L,end:L+400*M,n:340,first:L+M,last:L+400*M,internal:internal.slice(0,3),internalTotal:3},50);
  assert.equal(small.truncated,false);assert.equal(small.count,3);
  const edge=assembleGaps({lower:L,end:L+400*M,n:340,first:L+4*M,last:L+390*M,internal:internal.slice(0,49),internalTotal:49},50);
  assert.equal(edge.count,51);assert.equal(edge.ranges.length,50);assert.equal(edge.truncated,true,'leading + 49 internal + trailing cut at the cap');
});

test('shape: exact decimal strings, bucket open time, complete flag, ascending order',()=>{
  const rows=[bucketRow(L,60),bucketRow(L+H,59,'62000.00000000')];
  const result=shapeOhlcv({now:NOW,interval:'1h',ms:H,limit:168,latest:LATEST,first:L-D,window:{start:L-168*H,end:L+2*H,expected:100},edge:{n:119},rows,
    gaps:{count:1,missing_minutes:1,ranges:[{from_open_time:L+H,to_open_time:L+H,missing_minutes:1}],truncated:false}});
  assert.equal(result.version,'market-ohlcv-v1');assert.equal(result.source,SOURCE);assert.equal(result.status,'OK');
  assert.deepEqual([result.broker,result.symbol,result.market,result.base_timeframe,result.closed_only],['binance-global','BTCUSDT','SPOT','1m',true]);
  assert.equal(result.generated_at,new Date(NOW).toISOString());
  assert.deepEqual(result.bars[0],{time:L,open:'62000.01',high:'62100.5',low:'61900',close:'62050.2',volume:'12.5',minutes:60,complete:true});
  assert.equal(result.bars[1].complete,false,'59 of 60 minutes');assert.equal(result.bars[1].open,'62000');
  assert.ok(result.bars.every((bar,index,list)=>index===0||list[index-1].time<bar.time));
  assert.equal(result.window.stored_minutes,119);assert.equal(result.gaps.count,1);
  assert.equal(result.interval_ms,H);assert.equal(result.limit,168);
  const text=JSON.stringify(result);
  for(const banned of ['provenance','content_hash','http','://'])assert.ok(!text.includes(banned),'response contains '+banned);
});

test('shape: EMPTY (no stored row), an empty window, and the stale boundary',()=>{
  const empty=shapeOhlcv({now:NOW,interval:'1h',ms:H,limit:168});
  assert.deepEqual(empty,{version:'market-ohlcv-v1',source:SOURCE,broker:'binance-global',symbol:'BTCUSDT',market:'SPOT',base_timeframe:'1m',
    interval:'1h',interval_ms:H,limit:168,closed_only:true,generated_at:new Date(NOW).toISOString(),status:'EMPTY',latest_closed_bar:null,
    age_seconds:null,stale:true,stale_after_seconds:180,window:null,bars:[],gaps:{count:0,missing_minutes:0,ranges:[],truncated:false}});
  const base={interval:'1m',ms:M,limit:1,latest:LATEST,first:L,window:{start:LATEST-M,end:LATEST,expected:1},edge:{n:1},rows:[bucketRow(LATEST-M,1)]};
  assert.equal(shapeOhlcv({...base,now:LATEST+180000}).age_seconds,180);
  assert.equal(shapeOhlcv({...base,now:LATEST+180000}).stale,false,'age 180 is fresh');
  assert.equal(shapeOhlcv({...base,now:LATEST+181000}).stale,true,'age 181 is stale');
  assert.equal(shapeOhlcv({...base,now:LATEST-5000}).age_seconds,0,'a skewed clock never gives a negative age');
  const none=shapeOhlcv({...base,now:NOW,rows:[]});
  assert.equal(none.status,'EMPTY');assert.equal(none.bars.length,0);assert.ok(none.latest_closed_bar,'the newest bar is still reported');
});

test('reader EMPTY: no stored row answers EMPTY without reading bars',async()=>{
  const db=fakeDb({latest:null}),reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  const answer=await reader.ohlcv(query('interval=15m'));
  assert.equal(answer.status,'EMPTY');assert.equal(answer.latest_closed_bar,null);assert.equal(answer.stale,true);
  assert.equal(db.statements.some(item=>item.sql===SQL.BARS),false);
});

test('SQL safety: SET TRANSACTION READ ONLY first, then SELECT or WITH only, with bound parameters and no write or lock',async()=>{
  const bars=[bucketRow(L,60)];
  const db=fakeDb({latest:LATEST,first:L-D,bars,edge:{n:60,first:L+M,last:L+60*M},internal:[{total:1,prev:L+5*M,bar_time:L+8*M}]});
  const reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  await reader.ohlcv(query('interval=1h'));await reader.health();
  assert.ok(db.statements.length>=10);
  assert.equal(db.statements[0].sql,'SET TRANSACTION READ ONLY');
  const forbidden=/\b(INSERT|UPDATE|DELETE|MERGE|LOCK|TRUNCATE|CREATE|ALTER|DROP|NEXTVAL|PG_ADVISORY\w*)\b/i,lockClause=/\bFOR\s+(UPDATE|SHARE|NO\s+KEY|KEY\s+SHARE)\b/i;
  for(const {sql,params} of db.statements){
    if(sql.startsWith('SET TRANSACTION'))assert.equal(sql,'SET TRANSACTION READ ONLY');
    else assert.match(sql,/^\s*(SELECT|WITH)\b/);
    assert.doesNotMatch(sql,forbidden,sql);assert.doesNotMatch(sql,lockClause,sql);
    for(const value of params)if(typeof value==='string')assert.ok(!sql.includes(value),'a parameter appears in the SQL text: '+value);
  }
  for(const name of ['SPAN','BARS','EDGE','GAPS'])
    assert.deepEqual(db.statements.find(item=>item.sql===SQL[name]).params.slice(0,2),['binance-global','BTCUSDT'],name+' binds broker and symbol');
  for(const text of Object.values(SQL)){assert.doesNotMatch(text,/binance-global|BTCUSDT/);assert.match(text,/^\s*(SELECT|WITH)\b/);}
  assert.ok(SQL.BARS.includes('$5::bigint'),'the bucket size is a parameter');
});

const ROUTE='https://x.test/api/market/ohlcv';
const UNAVAILABLE={error:'Market data unavailable',code:'MARKET_DATA_UNAVAILABLE'};

test('route: other path false, POST 405, unavailable is a 503 body without a throw, SQLSTATE errors are rethrown',async()=>{
  const sent=[],json=(res,status,body)=>sent.push({status,body});
  const call=(method,target,reader)=>marketOhlcvRoutes({method},{},new URL(target),reader,json);
  const ready=new MarketDataReader({db:fakeDb({latest:LATEST,first:L,bars:[bucketRow(L,60)],edge:{n:60,first:L+M,last:L+60*M}}),enabled:true,clock:()=>NOW});
  assert.equal(await call('GET','https://x.test/api/other',ready),false);
  assert.equal(await call('GET',ROUTE+'/extra',ready),false);
  assert.equal(sent.length,0);
  const post=await codeOf(()=>call('POST',ROUTE,ready));
  assert.equal(post.code,'METHOD_NOT_ALLOWED');assert.equal(post.status,405);
  assert.equal(await call('GET',ROUTE+'?interval=1m&bot_id=bot-1',ready),true);
  assert.equal(sent.at(-1).status,200);assert.equal(sent.at(-1).body.interval,'1m');
  const disabled=new MarketDataReader({db:fakeDb(),enabled:false,clock:()=>NOW});
  assert.equal(await call('GET',ROUTE,disabled),true);
  assert.deepEqual(sent.at(-1),{status:503,body:UNAVAILABLE});
  const missing=new MarketDataReader({db:fakeDb({probe:null}),enabled:true,clock:()=>NOW});
  assert.equal(await call('GET',ROUTE,missing),true);
  assert.deepEqual(sent.at(-1),{status:503,body:UNAVAILABLE});
  // Validation errors keep the existing 400 mapping: they throw.
  const bad=await codeOf(()=>call('GET',ROUTE+'?interval=2h',ready));
  assert.equal(bad.code,'INTERVAL_NOT_ALLOWED');assert.equal(bad.status,400);
  const sqlstate=Object.assign(new Error('could not serialize'),{code:'40001'});
  const failing={...fakeDb({latest:LATEST}),query:async()=>{throw sqlstate;}};
  const broken=new MarketDataReader({db:failing,enabled:true,clock:()=>NOW});
  assert.equal(await codeOf(()=>call('GET',ROUTE,broken)),sqlstate);
});

test('reader: constructor validates its database and clock',()=>{
  for(const options of [{},{db:{}},{db:{query(){}}},{db:{transaction(){}}},{db:fakeDb(),clock:'now'}])
    assert.equal(code(()=>new MarketDataReader(options))?.code,'MARKET_DATA_CONFIGURATION_INVALID');
  assert.equal(new MarketDataReader({db:fakeDb()}).enabled,false,'off unless enabled');
});

// Health fixture: a 24 hour window ending at the newest bar; age and missing minutes are the knobs.
const health=({age=0,missing=0,first=LATEST-3*D,expected=1440,count=missing>0?1:0,ranges=[]}={})=>classifyMarketHealth({
  now:LATEST+age*1000,latest:LATEST,first,edge:{n:expected-missing,first:LATEST-D+M,last:LATEST},
  gaps:{count,missing_minutes:missing,ranges,truncated:false}});

test('health: the PASS/WARN/FAIL boundary matrix of age and missing bars',()=>{
  const cases=[[{},'PASS',[]],[{age:180},'PASS',[]],[{age:181},'WARN',['MARKET_DATA_STALE']],[{age:900},'WARN',['MARKET_DATA_STALE']],
    [{age:901},'FAIL',['MARKET_DATA_STALE_FAIL']],[{missing:1},'WARN',['MARKET_DATA_GAPS']],[{missing:59},'WARN',['MARKET_DATA_GAPS']],
    [{missing:60},'FAIL',['MARKET_DATA_GAPS_EXCESSIVE']],
    [{age:1000,missing:3},'FAIL',['MARKET_DATA_STALE_FAIL','MARKET_DATA_GAPS']],
    [{age:200,missing:3},'WARN',['MARKET_DATA_STALE','MARKET_DATA_GAPS']],
    [{age:200,missing:70},'FAIL',['MARKET_DATA_STALE','MARKET_DATA_GAPS_EXCESSIVE']],
    [{age:2000,missing:70},'FAIL',['MARKET_DATA_STALE_FAIL','MARKET_DATA_GAPS_EXCESSIVE']]];
  for(const [options,status,reasons] of cases){
    const item=health(options);
    assert.equal(item.status,status,JSON.stringify(options));assert.deepEqual(item.reasons,reasons,JSON.stringify(options));
  }
  assert.equal(health({age:180}).age_seconds,180);assert.equal(health({age:181}).age_seconds,181);
});

test('health: item shape is advisory, never unlocks and carries the evidence',()=>{
  const ranges=[{from_open_time:L,to_open_time:L+2*M,missing_minutes:3}];
  const item=health({missing:3,ranges});
  assert.deepEqual(item,{version:'pf3-market-data-v1',advisory:true,affects_verdict:false,unlocks:[],source:SOURCE,scope:'BINANCE_GLOBAL_BTCUSDT_SPOT_1M',
    status:'WARN',reasons:['MARKET_DATA_GAPS'],unavailable_code:null,latest_closed_bar:{open_time:LATEST-M,close_time:LATEST},age_seconds:0,
    window_minutes:1440,expected_bars:1440,bars_available:1437,missing_bars:3,gap_count:1,gaps:ranges,gaps_truncated:false,
    thresholds:{pass_max_age_seconds:180,fail_age_seconds:900,fail_missing_bars:60}});
  const many=Array.from({length:12},(_,index)=>({from_open_time:L+index*M,to_open_time:L+index*M,missing_minutes:1}));
  const capped=health({missing:12,count:12,ranges:many});
  assert.equal(capped.gaps.length,10);assert.equal(capped.gaps_truncated,true);assert.equal(capped.gap_count,12);
  const short=health({first:LATEST-99*M,expected:100});
  assert.equal(short.expected_bars,100,'history shorter than 24 hours lowers the expectation instead of reporting gaps');
});

test('health: unavailable and empty items are FAIL with zero evidence',()=>{
  const zero={window_minutes:1440,expected_bars:0,bars_available:0,missing_bars:0,gap_count:0,gaps:[],gaps_truncated:false,latest_closed_bar:null,age_seconds:null};
  const unavailable=classifyMarketHealth({now:NOW,unavailable:'MARKET_DATA_UNAVAILABLE'});
  assert.deepEqual({...unavailable},{...unavailable,...zero,status:'FAIL',reasons:['MARKET_DATA_UNAVAILABLE'],unavailable_code:'MARKET_DATA_UNAVAILABLE'});
  const empty=classifyMarketHealth({now:NOW});
  assert.deepEqual({...empty},{...empty,...zero,status:'FAIL',reasons:['MARKET_DATA_EMPTY'],unavailable_code:null});
  for(const item of [unavailable,empty]){assert.equal(item.advisory,true);assert.equal(item.affects_verdict,false);assert.deepEqual(item.unlocks,[]);}
});

test('health through the reader: disabled and missing store give items; gaps and age come from the stored window',async()=>{
  const off=new MarketDataReader({db:fakeDb(),enabled:false,clock:()=>NOW});
  assert.equal((await off.health()).unavailable_code,'MARKET_DATA_UNAVAILABLE');
  assert.equal((await new MarketDataReader({db:fakeDb({probe:null}),enabled:true,clock:()=>NOW}).health()).status,'FAIL');
  assert.deepEqual((await new MarketDataReader({db:fakeDb({latest:null}),enabled:true,clock:()=>NOW}).health()).reasons,['MARKET_DATA_EMPTY']);
  const db=fakeDb({latest:LATEST,first:LATEST-3*D,edge:{n:1437,first:LATEST-D+M,last:LATEST},
    internal:[{total:1,prev:LATEST-100*M,bar_time:LATEST-96*M}]});
  const item=await new MarketDataReader({db,enabled:true,clock:()=>NOW}).health();
  assert.equal(item.status,'WARN');assert.deepEqual(item.reasons,['MARKET_DATA_GAPS']);assert.equal(item.missing_bars,3);
  assert.deepEqual(item.gaps,[{from_open_time:LATEST-100*M,to_open_time:LATEST-98*M,missing_minutes:3}]);
  const edge=db.statements.find(statement=>statement.sql===SQL.EDGE),gaps=db.statements.find(statement=>statement.sql===SQL.GAPS);
  assert.deepEqual(edge.params,['binance-global','BTCUSDT',LATEST-D,LATEST]);assert.equal(gaps.params[4],10,'the PF-3 read asks for at most 10 ranges');
});

// ReadinessService wiring.
const fakeStore={db:{transaction:fn=>fn(),query:async()=>({rows:[]})},risk(){}};
const stubReport=()=>({verdict:'X',blockers:[{code:'B'}]});
const serviceOf=extra=>{const service=new ReadinessService({store:fakeStore,defaultRisk:{},clock:()=>NOW,...extra});service.collect=async()=>stubReport();return service;};

test('PF-3 service: market_data is appended after collect; everything else equals a service without it',async()=>{
  const item=classifyMarketHealth({now:NOW,latest:LATEST,first:L,edge:{n:10},gaps:{count:0,missing_minutes:0,ranges:[],truncated:false}});
  const withData=await serviceOf({marketData:{health:async()=>item}}).report('owner','bot');
  const without=await serviceOf({}).report('owner','bot');
  assert.deepEqual(withData.market_data,item);assert.ok(!('market_data' in without),'no reader means no key');
  const {market_data,...rest}=withData;
  assert.deepEqual(rest,without,'verdict and blockers are identical with and without the item');
  assert.equal(market_data.affects_verdict,false);
});

test('PF-3 service: configuration, application failures and platform errors',async()=>{
  const error=code(()=>new ReadinessService({store:fakeStore,defaultRisk:{},marketData:{}}));
  assert.equal(error.code,'PF3_CONFIGURATION_INVALID');assert.equal(error.status,500);
  const failing=Object.assign(new Error('MARKET_DATA_CONFIGURATION_INVALID'),{code:'MARKET_DATA_CONFIGURATION_INVALID',status:500});
  const item=(await serviceOf({marketData:{health:async()=>{throw failing;}}}).report('owner','bot')).market_data;
  assert.equal(item.status,'FAIL');assert.equal(item.unavailable_code,'MARKET_DATA_CONFIGURATION_INVALID');assert.deepEqual(item.reasons,['MARKET_DATA_UNAVAILABLE']);
  const unknown=(await serviceOf({marketData:{health:async()=>{throw new Error('boom');}}}).report('owner','bot')).market_data;
  assert.equal(unknown.unavailable_code,'READ_FAILED');assert.equal(unknown.status,'FAIL');
  const sqlstate=Object.assign(new Error('serialization'),{code:'40001'});
  const rethrown=await codeOf(()=>serviceOf({marketData:{health:async()=>{throw sqlstate;}}}).report('owner','bot'));
  assert.equal(rethrown,sqlstate);
});
});
