import test,{describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {
  OHLCV_PATH,SYMBOLS_PATH,REST_SOURCE,DEFAULT_INTERVAL,DEFERRED_DEADLINE_MS,STORED_FALLBACK_MIN_MS,MARKET,SOURCE,INTERVALS,STALE_AFTER_SECONDS,
  HEALTH,GAP_RANGE_CAP,SQL,parseOhlcvQuery,parseSymbolsQuery,ohlcvWindow,historyLower,assembleGaps,shapeOhlcv,shapeStoredV2,shapeRest,
  chooseSource,classifyMarketHealth,MarketDataReader,marketOhlcvRoutes,runMarketDeferred,marketError} from '../src/postgres/market-ohlcv.js';
import {PublicMarketProxy,LIMITS,KLINE_INTERVALS} from '../src/postgres/market-proxy.js';
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
// The stored answer of a query text, as the route builds it from the reader.
const answerOf=async(reader,text)=>{
  const parsed=parseOhlcvQuery(query(text));
  return shapeStoredV2(await reader.stored({interval:parsed.interval,ms:parsed.ms,limit:parsed.limit}));
};

test('constants: interval table, health thresholds and the SQL are frozen',()=>{
  assert.deepEqual(Object.keys(INTERVALS),['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w']);
  // [ms, default limit, cache ttl s, ui poll s, stored, storedCap]
  const table={'1m':[M,360,10,15,true,1000],'3m':[3*M,320,15,30,true,1000],'5m':[5*M,288,15,30,true,1000],'15m':[15*M,288,30,60,true,1000],
    '30m':[30*M,336,30,60,true,1000],'1h':[H,336,60,120,true,720],'2h':[2*H,360,60,120,true,360],'4h':[4*H,360,120,300,true,180],
    '6h':[6*H,360,120,300,true,120],'8h':[8*H,360,120,300,true,90],'12h':[12*H,360,180,300,true,60],'1d':[D,365,300,300,true,30],
    '3d':[3*D,243,600,600,false,null],'1w':[7*D,260,600,600,false,null]};
  for(const [name,[ms,limit,ttl,poll,stored,storedCap]] of Object.entries(table))
    assert.deepEqual({...INTERVALS[name]},{ms,limit,cap:1000,ttl,poll,stored,storedCap},name);
  for(const [name,spec] of Object.entries(INTERVALS)){
    assert.ok(Object.isFrozen(spec),name);
    if(spec.stored)assert.equal(spec.storedCap,Math.min(1000,Math.floor(43200/(spec.ms/M))),'storedCap formula '+name);
  }
  assert.ok(Object.isFrozen(INTERVALS)&&Object.isFrozen(SQL)&&Object.isFrozen(HEALTH)&&Object.isFrozen(MARKET));
  assert.equal(OHLCV_PATH,'/api/market/ohlcv');assert.equal(SYMBOLS_PATH,'/api/market/symbols');assert.equal(SOURCE,'binance-spot-public-stored');
  assert.equal(REST_SOURCE,'binance-spot-public-rest');assert.equal(DEFAULT_INTERVAL,'1d');
  assert.equal(STALE_AFTER_SECONDS,180);assert.equal(GAP_RANGE_CAP,50);assert.equal(DEFERRED_DEADLINE_MS,11000);assert.equal(STORED_FALLBACK_MIN_MS,1000);
  assert.deepEqual({...MARKET},{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
});

test('parse: defaults BTCUSDT, 1d, 365, source auto; every interval default and cap; no clamping',()=>{
  assert.deepEqual(parseOhlcvQuery(query('')),{symbol:'BTCUSDT',interval:'1d',ms:D,limit:365,source:'auto'});
  for(const [interval,spec] of Object.entries(INTERVALS))
    assert.deepEqual(parseOhlcvQuery(query('interval='+interval)),{symbol:'BTCUSDT',interval,ms:spec.ms,limit:spec.limit,source:'auto'});
  for(const [interval,spec] of Object.entries(INTERVALS)){
    assert.equal(parseOhlcvQuery(query(`interval=${interval}&limit=${spec.cap}`)).limit,spec.cap,'cap accepted '+interval);
    assert.equal(code(()=>parseOhlcvQuery(query(`interval=${interval}&limit=${spec.cap+1}`))).code,'LIMIT_OUT_OF_RANGE','cap+1 '+interval);
  }
  assert.equal(parseOhlcvQuery(query('limit=1')).limit,1);
  for(const bad of ['0','-1','1.5','abc','01','10000','1e3',' 5','5 '])
    assert.equal(code(()=>parseOhlcvQuery(query('limit='+encodeURIComponent(bad)))).code,'LIMIT_OUT_OF_RANGE','limit '+JSON.stringify(bad));
  for(const interval of ['2m','1H','1m ','60m','__proto__','toString','1D','10d'])
    assert.equal(code(()=>parseOhlcvQuery(query('interval='+encodeURIComponent(interval)))).code,'INTERVAL_NOT_ALLOWED','interval '+JSON.stringify(interval));
});

test('parse: strict keys, symbol shape, source rules and bot_id tolerance',()=>{
  const invalid=[['unknown key','foo=1'],['duplicate interval','interval=1h&interval=5m'],['duplicate limit','limit=5&limit=6'],
    ['duplicate symbol','symbol=ETHUSDT&symbol=BTCUSDT'],['duplicate source','source=auto&source=stored'],
    ['empty limit','limit='],['empty interval','interval='],['empty symbol','symbol='],['empty source','source='],['empty bot_id','bot_id='],
    ['long bot_id','bot_id='+'a'.repeat(129)],['case of key','Interval=1h'],['bot_id twice','bot_id=a&bot_id=b']];
  for(const [name,text] of invalid){
    const error=code(()=>parseOhlcvQuery(query(text)));
    assert.equal(error?.code,'INVALID_FIELDS',name);assert.equal(error.status,400);
  }
  assert.equal(parseOhlcvQuery(query('symbol=ETHUSDT')).symbol,'ETHUSDT');
  for(const bad of ['eth/usdt','BINANCE:ETHUSDT','ethusdt','ABCD','A'.repeat(21),'ETH-USDT','..%2Fx','BTCUSDT%20','%C3%89THUSDT']){
    const error=code(()=>parseOhlcvQuery(query('symbol='+bad)));
    assert.equal(error?.code,'MARKET_SYMBOL_INVALID',bad);assert.equal(error.status,400);
  }
  assert.equal(parseOhlcvQuery(query('symbol=ETHUSDT&interval=1w&limit=260')).limit,260);
  assert.equal(parseOhlcvQuery(query('bot_id=all')).interval,'1d','bot_id is accepted and ignored');
  assert.equal(parseOhlcvQuery(query('bot_id='+'a'.repeat(128))).interval,'1d');
  assert.equal(parseOhlcvQuery(query('source=auto')).source,'auto');
  const stored=parseOhlcvQuery(query('interval=1h&source=stored'));
  assert.deepEqual(stored,{symbol:'BTCUSDT',interval:'1h',ms:H,limit:336,source:'stored'});
  assert.equal(parseOhlcvQuery(query('interval=1d&source=stored')).limit,30,'no limit: the default is lowered to the stored cap');
  assert.equal(parseOhlcvQuery(query('interval=4h&source=stored')).limit,180);
  assert.equal(parseOhlcvQuery(query('interval=1d&source=stored&limit=30')).limit,30);
  for(const text of ['source=bogus','source=STORED','symbol=ETHUSDT&source=stored','interval=3d&source=stored','interval=1w&source=stored',
    'interval=1d&source=stored&limit=31','interval=1h&source=stored&limit=721','interval=4h&source=stored&limit=181'])
    assert.equal(code(()=>parseOhlcvQuery(query(text)))?.code,'SOURCE_NOT_ALLOWED',text);
  assert.deepEqual(parseSymbolsQuery(query('')),{});assert.deepEqual(parseSymbolsQuery(query('bot_id=all')),{});
  for(const text of ['symbol=ETHUSDT','bot_id=','bot_id=a&bot_id=b','bot_id='+'a'.repeat(129),'x=1'])
    assert.equal(code(()=>parseSymbolsQuery(query(text)))?.code,'INVALID_FIELDS',text);
});

test('parse: a failed parse issues zero SQL and zero fetches through the route',async()=>{
  const db=fakeDb({latest:LATEST,first:L}),reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  for(const text of ['interval=2x','limit=0','foo=1','limit=9999','symbol=eth','source=x','symbol=ETHUSDT&source=stored']){
    const error=await codeOf(()=>marketOhlcvRoutes({method:'GET'},{phase2Buffer:true},new URL(ROUTE+'?'+text),reader,()=>{},{actor:{id:'u'},proxy:null}));
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
  const answer=await answerOf(reader,'interval=4h&limit=180');
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
  const answer=await answerOf(reader,'interval=1m&limit=1000');
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
  const answer=await answerOf(reader,'interval=15m');
  assert.equal(answer.status,'EMPTY');assert.equal(answer.latest_closed_bar,null);assert.equal(answer.stale,true);
  assert.equal(db.statements.some(item=>item.sql===SQL.BARS),false);
});

test('SQL safety: SET TRANSACTION READ ONLY first, then SELECT or WITH only, with bound parameters and no write or lock',async()=>{
  const bars=[bucketRow(L,60)];
  const db=fakeDb({latest:LATEST,first:L-D,bars,edge:{n:60,first:L+M,last:L+60*M},internal:[{total:1,prev:L+5*M,bar_time:L+8*M}]});
  const reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  await answerOf(reader,'interval=1h');await reader.health();
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
const SYMBOLS='https://x.test/api/market/symbols';
const UNAVAILABLE={error:'Market data unavailable',code:'MARKET_DATA_UNAVAILABLE'};
const SECRET='SECRET-UPSTREAM-TEXT';

// Instrumented fake database: isTransaction is true only inside the (outermost) transaction, and begin/end events are recorded.
function txDb(scenario={}){
  const base=fakeDb(scenario),events=[];
  let depth=0;
  return {statements:base.statements,events,query:base.query,
    get isTransaction(){return depth>0;},
    async transaction(fn){
      if(depth>0)return fn();
      depth++;events.push('begin');
      try{return await fn();}finally{depth--;events.push('end');}
    }};
}
const reply=(body,{status=200,headers={}}={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers});
const symbolRow=base=>({symbol:base+'USDT',status:'TRADING',baseAsset:base,quoteAsset:'USDT',isSpotTradingAllowed:true,
  filters:[{filterType:'PRICE_FILTER',tickSize:'0.01000000'}]});
const exchange=()=>({symbols:[symbolRow('BTC'),symbolRow('ETH'),...Array.from({length:60},(_,index)=>symbolRow('T'+String(index).padStart(4,'0')))]});
const klineRows=(now,ms,count)=>{
  const last=Math.floor(now/ms)*ms;
  return Array.from({length:count},(_,index)=>{const open=last-(count-1-index)*ms;return [open,'100.5','101.5','99.5','100.75','12.5',open+ms-1];});
};
const FULL={latest:LATEST,first:LATEST-3*D,bars:[bucketRow(LATEST-M,1)],edge:{n:1,first:LATEST,last:LATEST},internal:[]};

// One request through a model of the server pipeline: the route runs inside the transaction; the deferred function, if any, runs
// after COMMIT through runMarketDeferred; otherwise the buffered json() result is the answer.
function rig({scenario={},proxyOn=true,upstream=null,enabled=true,limits={}}={}){
  const db=txDb(scenario),fetches=[],state={now:NOW};
  const fetcher=async(url)=>{
    fetches.push({url:String(url),inTransaction:db.isTransaction});db.events.push('fetch');
    if(upstream){const answer=await upstream(String(url),state,fetches.length);if(answer!==undefined)return answer;}
    const parsed=new URL(url);
    if(parsed.pathname==='/api/v3/exchangeInfo')return reply(exchange());
    const ms=KLINE_INTERVALS[parsed.searchParams.get('interval')].ms;
    return reply(klineRows(state.now,ms,Math.min(3,Number(parsed.searchParams.get('limit')))));
  };
  const proxy=new PublicMarketProxy({enabled:proxyOn,fetcher,clock:()=>state.now,limits:{...LIMITS,...limits},log:()=>{}});
  const reader=new MarketDataReader({db,enabled,clock:()=>state.now});
  return {db,fetches,proxy,reader,state};
}
async function call(r,url,{buffer=true,actor={id:'user-1'},...rest}={}){
  const proxy='proxy' in rest?rest.proxy:r.proxy;
  const res={phase2Buffer:buffer,phase2Result:null,phase2Deferred:null};
  const json=(target,status,body)=>{target.phase2Result={status,body};};
  let handled;
  await r.db.transaction(async()=>{handled=await marketOhlcvRoutes({method:'GET'},res,new URL(url),r.reader,json,{actor,proxy});});
  res.phase2Buffer=false;
  const during=res.phase2Result,deferred=res.phase2Deferred;res.phase2Deferred=null;
  const result=deferred?await runMarketDeferred(deferred):res.phase2Result;
  return {handled,deferred:deferred!==null,bufferedDuringTransaction:during,result};
}

test('chooseSource: the section 7 matrix',()=>{
  const q=text=>parseOhlcvQuery(query(text));
  const window=ohlcvWindow(LATEST,H,336);
  const cover=(over={})=>({available:true,latest:LATEST,first:window.start+M,...over});
  const pick=(text,{coverage=cover(),proxyEnabled=true,now=NOW}={})=>chooseSource({query:q(text),coverage,proxyEnabled,now});
  assert.deepEqual(pick('interval=1h'),{kind:'stored'},'full fresh coverage');
  assert.deepEqual(pick('interval=1h',{proxyEnabled:false}),{kind:'stored'},'full coverage does not need the proxy');
  assert.deepEqual(pick('interval=1h',{coverage:cover({first:window.start+2*M})}),{kind:'proxy',fallback:true},'one minute short of the window start');
  assert.deepEqual(pick('interval=1h',{coverage:cover({first:window.start+M})}),{kind:'stored'},'coverage exactly at the window start');
  assert.deepEqual(pick('interval=1h',{now:LATEST+180000}),{kind:'stored'},'age 180 is fresh');
  assert.deepEqual(pick('interval=1h',{now:LATEST+181000}),{kind:'proxy',fallback:true},'age 181 is stale');
  assert.deepEqual(pick('interval=1h',{coverage:cover({first:window.start+2*M}),proxyEnabled:false}),{kind:'stored-fallback',reason:'MARKET_PROXY_DISABLED'});
  assert.deepEqual(pick('interval=1h',{coverage:{available:false,latest:null,first:null}}),{kind:'proxy',fallback:true});
  assert.deepEqual(pick('interval=1h',{coverage:{available:true,latest:null,first:null}}),{kind:'proxy',fallback:true},'empty store');
  assert.deepEqual(pick('interval=1h',{coverage:null}),{kind:'proxy',fallback:true});
  assert.deepEqual(pick('interval=1d'),{kind:'proxy',fallback:true},'the default 365 bars exceed the stored cap of 30');
  assert.deepEqual(pick('interval=1d',{proxyEnabled:false}),{kind:'stored-fallback',reason:'MARKET_PROXY_DISABLED'});
  assert.deepEqual(pick('interval=1d&limit=30',{coverage:cover({first:LATEST-40*D})}),{kind:'stored'},'30 daily bars fit the stored cap');
  assert.deepEqual(pick('interval=1h&limit=721'),{kind:'proxy',fallback:true},'above the stored cap');
  for(const interval of ['3d','1w']){
    assert.deepEqual(pick('interval='+interval),{kind:'proxy',fallback:false},interval+' proxy only');
    assert.deepEqual(pick('interval='+interval,{proxyEnabled:false}),{kind:'unavailable',code:'MARKET_PROXY_DISABLED'},interval+' without a proxy');
  }
  assert.deepEqual(pick('symbol=ETHUSDT&interval=1h'),{kind:'proxy',fallback:false},'other symbols never use the store');
  assert.deepEqual(pick('symbol=ETHUSDT&interval=1h',{proxyEnabled:false}),{kind:'unavailable',code:'MARKET_PROXY_DISABLED'});
  assert.deepEqual(pick('interval=1h&source=stored',{coverage:cover({first:window.start+9*M}),proxyEnabled:false}),{kind:'stored'},'explicit stored ignores coverage and the proxy');
});

test('shapeStoredV2 and shapeRest: exact v2 shapes',()=>{
  const v1=shapeOhlcv({now:NOW,interval:'1h',ms:H,limit:3,latest:LATEST,first:L-10*H,window:{start:L-3*H,end:L,expected:100},edge:{n:100},rows:[bucketRow(L-H,60)]});
  const stored=shapeStoredV2(v1);
  assert.equal(stored.version,'market-ohlcv-v2');assert.equal(stored.display_symbol,'BINANCE:BTCUSDT');assert.equal(stored.closed_only,true);
  assert.deepEqual([stored.fallback,stored.history_partial,stored.stale_reason,stored.cache_age_seconds,stored.price_tick],[null,false,null,null,null]);
  assert.deepEqual(stored.bars[0],{...v1.bars[0],forming:false});assert.equal(stored.base_timeframe,'1m');assert.ok(stored.gaps&&stored.window);
  const partial=shapeStoredV2(shapeOhlcv({...{now:NOW,interval:'1h',ms:H,limit:3,latest:LATEST,first:L+5*H,window:{start:L-3*H,end:L,expected:100},edge:{n:100},rows:[]}}),
    {fallback:{from:REST_SOURCE,reason:'MARKET_PROXY_DISABLED'}});
  assert.equal(partial.history_partial,true);assert.deepEqual(partial.fallback,{from:REST_SOURCE,reason:'MARKET_PROXY_DISABLED'});
  const aged=shapeStoredV2(shapeOhlcv({now:LATEST+181000,interval:'1h',ms:H,limit:3,latest:LATEST,first:L-10*H,window:{start:L-3*H,end:L,expected:100},edge:{n:100},rows:[]}));
  assert.equal(aged.stale,true);assert.equal(aged.stale_reason,'STORED_AGE');
  const empty=shapeStoredV2(shapeOhlcv({now:NOW,interval:'1h',ms:H,limit:3}));
  assert.deepEqual([empty.status,empty.history_partial,empty.bars.length],['EMPTY',false,0]);

  const open=Math.floor(NOW/H)*H;
  const bar=(time,forming)=>({time,open:'1',high:'2',low:'0.5',close:'1.5',volume:'3',complete:!forming,forming,minutes:null});
  const query3={symbol:'ETHUSDT',interval:'1h',ms:H,limit:3,source:'auto'};
  const bars=[bar(open-2*H,false),bar(open-H,false),bar(open,true)];
  const rest=shapeRest({now:NOW,query:query3,result:{bars,cache_age_seconds:4,stale:false},tick:'0.01'});
  assert.deepEqual({...rest,bars:undefined},{version:'market-ohlcv-v2',source:'binance-spot-public-rest',broker:'binance-global',symbol:'ETHUSDT',
    display_symbol:'BINANCE:ETHUSDT',market:'SPOT',interval:'1h',interval_ms:H,limit:3,generated_at:new Date(NOW).toISOString(),status:'OK',
    closed_only:false,latest_closed_bar:{open_time:open-H,close_time:open},age_seconds:Math.floor((NOW-open)/1000),stale:false,stale_reason:null,
    stale_after_seconds:null,cache_age_seconds:4,price_tick:'0.01',history_partial:false,fallback:null,window:null,gaps:null,base_timeframe:null,bars:undefined});
  assert.deepEqual(rest.bars,bars);assert.notEqual(rest.bars[0],bars[0],'bars are copied');assert.equal(rest.bars[2].forming,true);
  const stale=shapeRest({now:NOW,query:query3,result:{bars,cache_age_seconds:400,stale:true}});
  assert.deepEqual([stale.stale,stale.stale_reason,stale.price_tick],[true,'UPSTREAM_UNAVAILABLE',null]);
  const only=shapeRest({now:NOW,query:query3,result:{bars:[bar(open,true)],cache_age_seconds:0,stale:false}});
  assert.deepEqual([only.status,only.latest_closed_bar,only.age_seconds,only.bars.length],['OK',null,null,1],'a forming bar alone has no closed-bar facts');
  const none=shapeRest({now:NOW,query:query3,result:{bars:[],cache_age_seconds:0,stale:false}});
  assert.deepEqual([none.status,none.latest_closed_bar],['EMPTY',null]);
  assert.equal(JSON.stringify(rest).includes('http'),false);
});

test('reader coverage and stored: PROBE and SPAN only, read-only first; disabled and missing stores',async()=>{
  const db=fakeDb({latest:LATEST,first:LATEST-D}),reader=new MarketDataReader({db,enabled:true,clock:()=>NOW});
  assert.deepEqual(await reader.coverage(),{available:true,latest:LATEST,first:LATEST-D});
  assert.deepEqual(db.statements.map(item=>item.sql),['SET TRANSACTION READ ONLY',SQL.PROBE,SQL.SPAN]);
  assert.deepEqual(db.statements[2].params,[MARKET.broker,MARKET.symbol,NOW]);
  const off=fakeDb(),disabled=new MarketDataReader({db:off,enabled:false,clock:()=>NOW});
  assert.deepEqual(await disabled.coverage(),{available:false,latest:null,first:null});assert.equal(off.statements.length,0);
  assert.equal((await codeOf(()=>disabled.stored({interval:'1h',ms:H,limit:3}))).code,'MARKET_DATA_UNAVAILABLE');
  const missing=new MarketDataReader({db:fakeDb({probe:null}),enabled:true,clock:()=>NOW});
  assert.deepEqual(await missing.coverage(),{available:false,latest:null,first:null});
  const error=await codeOf(()=>missing.stored({interval:'1h',ms:H,limit:3}));
  assert.equal(error.code,'MARKET_DATA_UNAVAILABLE');assert.equal(error.status,503);
});

test('stored bucket math for 3m, 2h, 6h, 8h and 12h: aligned windows and the table bucket size',async()=>{
  const ends={'3m':'2026-10-04T05:06:00Z','2h':'2026-10-04T04:00:00Z','6h':'2026-10-04T00:00:00Z','8h':'2026-10-04T00:00:00Z','12h':'2026-10-04T00:00:00Z'};
  for(const [interval,end] of Object.entries(ends)){
    const spec=INTERVALS[interval],window=ohlcvWindow(LATEST,spec.ms,spec.storedCap);
    assert.equal(window.end,Date.parse(end),interval);assert.equal(window.start,window.end-spec.storedCap*spec.ms);assert.equal(window.start%spec.ms,0);
    const db=fakeDb({latest:LATEST,first:LATEST-30*D,bars:[bucketRow(window.end-spec.ms,spec.ms/M)],edge:{n:spec.ms/M,first:window.end-spec.ms+M,last:window.end}});
    const answer=await new MarketDataReader({db,enabled:true,clock:()=>NOW}).stored({interval,ms:spec.ms,limit:spec.storedCap});
    assert.deepEqual(db.statements.find(item=>item.sql===SQL.BARS).params,[MARKET.broker,MARKET.symbol,window.start,window.end,spec.ms],interval);
    assert.equal(answer.interval,interval);assert.equal(answer.limit,spec.storedCap);assert.equal(answer.bars[0].complete,true);
  }
});

test('route: other path false, POST 405, SQLSTATE errors are rethrown, parse errors throw 400 before any SQL',async()=>{
  const sent=[],json=(res,status,body)=>sent.push({status,body});
  const run=(method,target,reader,options)=>marketOhlcvRoutes({method},{phase2Buffer:true},new URL(target),reader,json,options);
  const ready=new MarketDataReader({db:fakeDb(FULL),enabled:true,clock:()=>NOW});
  assert.equal(await run('GET','https://x.test/api/other',ready),false);
  assert.equal(await run('GET',ROUTE+'/extra',ready),false);
  assert.equal(await run('GET',SYMBOLS+'/extra',ready),false);
  assert.equal(sent.length,0);
  for(const target of [ROUTE,SYMBOLS]){
    const post=await codeOf(()=>run('POST',target,ready));
    assert.equal(post.code,'METHOD_NOT_ALLOWED');assert.equal(post.status,405);
  }
  assert.equal(await run('GET',ROUTE+'?interval=1m&bot_id=bot-1',ready),true);
  assert.equal(sent.at(-1).status,200);assert.equal(sent.at(-1).body.interval,'1m');assert.equal(sent.at(-1).body.version,'market-ohlcv-v2');
  const bad=await codeOf(()=>run('GET',ROUTE+'?interval=2x',ready));
  assert.equal(bad.code,'INTERVAL_NOT_ALLOWED');assert.equal(bad.status,400);
  const sqlstate=Object.assign(new Error('could not serialize'),{code:'40001'});
  const broken=new MarketDataReader({db:{...fakeDb(FULL),query:async()=>{throw sqlstate;}},enabled:true,clock:()=>NOW});
  assert.equal(await codeOf(()=>run('GET',ROUTE+'?interval=1m',broken)),sqlstate);
});

test('route: BTCUSDT with full fresh coverage is answered from the store inside the transaction (no deferral, no fetch)',async()=>{
  const r=rig({scenario:FULL});
  const out=await call(r,ROUTE+'?interval=1m');
  assert.equal(out.handled,true);assert.equal(out.deferred,false);assert.equal(out.result.status,200);
  const body=out.result.body;
  assert.equal(body.version,'market-ohlcv-v2');assert.equal(body.source,SOURCE);assert.equal(body.interval,'1m');assert.equal(body.limit,360);
  assert.deepEqual([body.symbol,body.display_symbol,body.closed_only,body.fallback,body.history_partial,body.stale_reason],['BTCUSDT','BINANCE:BTCUSDT',true,null,false,null]);
  assert.equal(body.bars[0].forming,false);
  assert.equal(r.fetches.length,0);assert.deepEqual(r.db.events,['begin','end']);
  const explicit=await call(rig({scenario:FULL}),ROUTE+'?interval=1d&source=stored');
  assert.equal(explicit.result.body.limit,30);assert.equal(explicit.result.body.fallback,null);
});

test('route: a proxy answer is deferred until after COMMIT; no fetch starts while a transaction is open',async()=>{
  const r=rig();
  const out=await call(r,ROUTE+'?symbol=ETHUSDT&interval=1d');
  assert.equal(out.handled,true);assert.equal(out.deferred,true);assert.equal(out.bufferedDuringTransaction,null,'json() was not called inside the transaction');
  assert.equal(out.result.status,200);
  const body=out.result.body;
  assert.equal(body.version,'market-ohlcv-v2');assert.equal(body.source,REST_SOURCE);assert.equal(body.closed_only,false);
  assert.deepEqual([body.symbol,body.display_symbol,body.interval,body.limit,body.price_tick,body.fallback,body.window,body.gaps],
    ['ETHUSDT','BINANCE:ETHUSDT','1d',365,'0.01',null,null,null]);
  assert.equal(body.bars.at(-1).forming,true);assert.equal(body.bars.at(-2).forming,false);
  assert.equal(r.fetches.length,2);assert.ok(r.fetches.every(item=>item.inTransaction===false));
  assert.deepEqual(r.db.events,['begin','end','fetch','fetch'],'the transaction ended before the first fetch');
  assert.equal(r.db.statements.length,0,'another symbol never touches the database');
  const again=await call(r,ROUTE+'?symbol=ETHUSDT&interval=1d');
  assert.equal(again.result.body.cache_age_seconds,0);assert.equal(r.fetches.length,2,'the second view is a cache hit');
});

test('route: BTCUSDT without full stored coverage goes to the proxy after reading only PROBE and SPAN',async()=>{
  const partial=rig({scenario:{...FULL,first:LATEST-100*H}});
  const out=await call(partial,ROUTE+'?interval=1h');
  assert.equal(out.deferred,true);assert.equal(out.result.body.source,REST_SOURCE);
  assert.deepEqual(partial.db.statements.map(item=>item.sql),['SET TRANSACTION READ ONLY',SQL.PROBE,SQL.SPAN]);
  assert.ok(partial.fetches.every(item=>!item.inTransaction));
  const stale=rig({scenario:{...FULL,latest:NOW-400000}});
  assert.equal((await call(stale,ROUTE+'?interval=1h')).deferred,true);
});

test('route: the BTCUSDT fallback opens a NEW read-only transaction after the failed fetch and labels the answer',async()=>{
  const r=rig({scenario:{...FULL,first:LATEST-5*D},upstream:()=>reply(SECRET,{status:503})});
  const out=await call(r,ROUTE+'?interval=1d');
  assert.equal(out.deferred,true);assert.equal(out.result.status,200);
  const body=out.result.body;
  assert.equal(body.source,SOURCE);assert.deepEqual(body.fallback,{from:REST_SOURCE,reason:'MARKET_UPSTREAM_UNAVAILABLE'});
  assert.equal(body.history_partial,true);assert.equal(body.limit,30);assert.equal(body.closed_only,true);
  assert.deepEqual(r.db.events,['begin','end','fetch','begin','end'],'request transaction, failed fetch, then a fresh transaction');
  const end=Math.floor(LATEST/D)*D;
  assert.deepEqual(r.db.statements.find(item=>item.sql===SQL.BARS).params,[MARKET.broker,MARKET.symbol,end-30*D,end,D]);
  assert.equal(r.db.statements.at(0).sql,'SET TRANSACTION READ ONLY');
  assert.ok(!JSON.stringify(body).includes(SECRET));
});

test('route: the fallback is skipped when too little time is left, or when the store has no bars or is off',async()=>{
  const slow=rig({scenario:{...FULL,first:LATEST-5*D},upstream:(url,state)=>{state.now+=10500;return reply('x',{status:503});}});
  const late=await call(slow,ROUTE+'?interval=1d');
  assert.deepEqual([late.result.status,late.result.body.code],[503,'MARKET_UPSTREAM_UNAVAILABLE']);assert.deepEqual(slow.db.events,['begin','end','fetch']);
  const empty=rig({scenario:{latest:LATEST,first:LATEST-5*D,bars:[],edge:{n:0,first:null,last:null}},upstream:()=>reply('x',{status:503})});
  assert.deepEqual((await call(empty,ROUTE+'?interval=1d')).result.body,{error:'Market data unavailable',code:'MARKET_UPSTREAM_UNAVAILABLE'});
  const off=rig({enabled:false,upstream:()=>reply('x',{status:503})});
  assert.deepEqual((await call(off,ROUTE+'?interval=1d')).result.body,{error:'Market data unavailable',code:'MARKET_UPSTREAM_UNAVAILABLE'});
  const threeDay=rig({upstream:()=>reply('x',{status:503})});
  assert.equal((await call(threeDay,ROUTE+'?interval=3d')).result.body.code,'MARKET_UPSTREAM_UNAVAILABLE');assert.equal(threeDay.db.statements.length,0,'no stored fallback for 3d');
});

test('route: without a buffered pipeline a proxy request fails loudly and counts nothing; stored answers still work',async()=>{
  const r=rig();
  for(const url of [ROUTE+'?symbol=ETHUSDT&interval=1d',SYMBOLS]){
    const error=await codeOf(()=>call(r,url,{buffer:false}));
    assert.equal(error.code,'MARKET_PIPELINE_INVALID');assert.equal(error.status,500);
  }
  assert.equal(r.fetches.length,0);
  for(let i=0;i<60;i++)assert.equal(r.proxy.admit('user-1').ok,true,'no request was counted');
  const missingActor=await codeOf(()=>call(rig(),SYMBOLS,{actor:null}));
  assert.equal(missingActor.code,'MARKET_PIPELINE_INVALID');
  const stored=await call(rig({scenario:FULL}),ROUTE+'?interval=1m',{buffer:false});
  assert.equal(stored.result.status,200);
});

test('route: proxy off or missing: other symbols and 3d/1w are 503 MARKET_PROXY_DISABLED bodies; BTCUSDT falls back to labelled stored bars',async()=>{
  const body=code=>({status:503,body:{error:'Market data unavailable',code}});
  for(const options of [{proxyOn:false},{proxy:null}]){
    const r=rig({scenario:{...FULL,first:LATEST-5*D},...(options.proxy===null?{}:options)});
    const extra=options.proxy===null?{proxy:null}:{};
    for(const target of ['?symbol=ETHUSDT&interval=1d','?interval=3d','?interval=1w','?symbol=ETHUSDT&interval=1m']){
      const out=await call(r,ROUTE+target,extra);
      assert.deepEqual(out.result,body('MARKET_PROXY_DISABLED'),target);assert.equal(out.deferred,false);
    }
    assert.equal(r.db.statements.length,0,'no database read and no fetch');assert.equal(r.fetches.length,0);
    const fallback=await call(r,ROUTE+'?interval=1d',extra);
    assert.equal(fallback.result.status,200);assert.equal(fallback.result.body.source,SOURCE);assert.equal(fallback.result.body.limit,30);
    assert.deepEqual(fallback.result.body.fallback,{from:REST_SOURCE,reason:'MARKET_PROXY_DISABLED'});assert.equal(fallback.result.body.history_partial,true);
    assert.equal(r.fetches.length,0);
    const symbols=await call(r,SYMBOLS,extra);
    assert.deepEqual(symbols.result,body('MARKET_PROXY_DISABLED'));assert.equal(symbols.deferred,false);
  }
  assert.deepEqual((await call(rig({enabled:false,proxyOn:false}),ROUTE+'?interval=1d')).result,{status:503,body:UNAVAILABLE});
  assert.deepEqual((await call(rig({scenario:{probe:null},proxyOn:false}),ROUTE+'?interval=1m')).result,{status:503,body:UNAVAILABLE});
});

test('route: GET /api/market/symbols is deferred, rate limited per actor and answers v1 symbols',async()=>{
  const r=rig();
  const out=await call(r,SYMBOLS+'?bot_id=all');
  assert.equal(out.deferred,true);assert.equal(out.bufferedDuringTransaction,null);assert.equal(out.result.status,200);
  const body=out.result.body;
  assert.deepEqual([body.version,body.source,body.stale,body.count,body.generated_at,body.retrieved_at],
    ['market-symbols-v1',REST_SOURCE,false,62,new Date(NOW).toISOString(),new Date(NOW).toISOString()]);
  assert.deepEqual(body.symbols[0],['BTCUSDT','BTC','USDT','0.01']);assert.equal(body.symbols.length,62);
  assert.ok(r.fetches.every(item=>!item.inTransaction));assert.deepEqual(r.db.events,['begin','end','fetch']);
  assert.equal((await codeOf(()=>call(r,SYMBOLS+'?symbol=ETHUSDT'))).code,'INVALID_FIELDS');
  const limited=rig();
  for(let i=0;i<60;i++)limited.proxy.admit('user-1');
  for(const url of [SYMBOLS,ROUTE+'?symbol=ETHUSDT&interval=1d']){
    const refused=await call(limited,url);
    assert.equal(refused.deferred,false);assert.equal(refused.result.status,429);
    assert.equal(refused.result.body.code,'MARKET_RATE_LIMITED');assert.ok(refused.result.body.retry_after_seconds>=1);
    assert.deepEqual(Object.keys(refused.result.body),['error','code','retry_after_seconds']);
  }
  assert.equal(limited.fetches.length,0);
  assert.equal((await call(limited,SYMBOLS,{actor:{id:'user-2'}})).result.status,200,'another actor is unaffected');
  const down=rig({upstream:()=>reply('x',{status:503})});
  assert.deepEqual((await call(down,SYMBOLS)).result,{status:503,body:{error:'Market data unavailable',code:'MARKET_SYMBOLS_UNAVAILABLE'}});
});

test('route: deferred errors map to fixed bodies: 400 not allowed, cooldown with retry_after_seconds, and no upstream text',async()=>{
  const r=rig();
  const unlisted=await call(r,ROUTE+'?symbol=ZZZZZUSDT&interval=1d');
  assert.deepEqual(unlisted.result,{status:400,body:{error:'Market request rejected',code:'MARKET_SYMBOL_NOT_ALLOWED'}});
  const cool=rig({upstream:()=>reply(SECRET,{status:429,headers:{'retry-after':'90'}})});
  const out=await call(cool,ROUTE+'?interval=3d');
  assert.deepEqual(out.result,{status:503,body:{error:'Market data unavailable',code:'MARKET_UPSTREAM_COOLDOWN',retry_after_seconds:90}});
  assert.ok(!JSON.stringify(out.result).includes('http')&&!JSON.stringify(out.result).includes(SECRET));
  const again=await call(cool,ROUTE+'?interval=3d&limit=100');
  assert.equal(again.result.body.code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(cool.fetches.length,1,'the open circuit stops further fetches');
});

test('runMarketDeferred and marketError: never throw; map known codes; hide everything else',async()=>{
  const failed={status:503,body:{error:'Market data unavailable',code:'MARKET_PROXY_FAILED'}};
  assert.deepEqual(await runMarketDeferred(async()=>{throw new Error(SECRET);}),failed);
  assert.deepEqual(await runMarketDeferred(()=>{throw Object.assign(new Error('x'),{code:'40001'});}),failed);
  assert.deepEqual(await runMarketDeferred(async()=>undefined),failed);
  assert.deepEqual(await runMarketDeferred(async()=>({status:'200',body:{}})),failed);
  assert.deepEqual(await runMarketDeferred(async()=>({status:200,body:null})),failed);
  assert.deepEqual(await runMarketDeferred(async()=>({status:200,body:{ok:1}})),{status:200,body:{ok:1}});
  assert.deepEqual(marketError(Object.assign(new Error(SECRET),{code:'MARKET_PROXY_BUSY',status:503,retry_after_seconds:3})),
    {status:503,body:{error:'Market data unavailable',code:'MARKET_PROXY_BUSY',retry_after_seconds:3}});
  assert.deepEqual(marketError(Object.assign(new Error('x'),{code:'MARKET_RATE_LIMITED',status:429})),
    {status:429,body:{error:'Too many market requests',code:'MARKET_RATE_LIMITED'}});
  for(const error of [new Error(SECRET),Object.assign(new Error('x'),{code:'40001',status:503}),Object.assign(new Error('x'),{code:'MARKET_X',status:500}),null,undefined,'x'])
    assert.deepEqual(marketError(error),failed);
  const stub={enabled:true,admit:()=>({ok:true}),now:()=>NOW,klines:async()=>{throw new TypeError(SECRET);},symbols:async()=>{throw new TypeError(SECRET);},tick:()=>null};
  const r=rig();
  for(const url of [ROUTE+'?symbol=ETHUSDT&interval=1d',SYMBOLS])assert.deepEqual((await call(r,url,{proxy:stub})).result,failed,url);
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
