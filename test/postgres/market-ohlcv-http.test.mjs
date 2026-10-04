import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {ReadinessService} from '../../src/postgres/pf3-readiness-service.js';
import {Money,exact} from '../../src/money.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';

// Market OHLCV (v2), market symbols and the PF-3 market-data item over the actual application, auth and SERIALIZABLE response buffering.
// Isolated local PostgreSQL only. The stored path reads rows the market-data writer stored. The REST path runs only against a
// loopback fake upstream (MARKET_PROXY_TEST_ORIGIN, accepted only under NODE_ENV=test): the real Binance host is never reached.
const PATH='/api/market/ohlcv',SYMBOLS='/api/market/symbols',REPORT='/api/risk/readiness-report',MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const INTERVAL_MS={'1m':MINUTE,'5m':5*MINUTE,'15m':15*MINUTE,'1h':HOUR,'4h':4*HOUR,'1d':DAY,'1w':7*DAY};
const REST='binance-spot-public-rest',STORED='binance-spot-public-stored';
// MARKET_PUBLIC_PROXY is always set explicitly so an inherited value never changes a case.
async function fixture(t,environment={MARKET_PUBLIC_PROXY:'0'}){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment});t.after(()=>f.close());return f;
}
// Whole-table digests: any insert, update or delete changes the digest. request.error audit rows (written when a request is refused) are left out.
const TABLES=['pine_market_bars','risk_profiles','paper_funding','paper_snapshots','ledger_positions','ledger_position_allocations','signals','bot_sessions','audit','users','system_settings'];
async function digests(db){
  const out={};
  for(const table of TABLES){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    const where=table==='audit'?" WHERE x.event<>'request.error'":'';
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM ${table} x${where}`)).rows[0].d:null;
  }
  return out;
}
const errorRows=async db=>(await db.query("SELECT count(*)::int AS n FROM audit WHERE event='request.error'")).rows[0].n;
// Deterministic synthetic bars on the minute grid: row i opens at start+i*MINUTE and is stored with bar_time = its close time + 1.
const priceOf=index=>{
  const open=new Money(60000).plus(index%97).plus((index%100)/100);
  return {open:open.toFixed(8),high:open.plus((index%7+1)/4).toFixed(8),low:open.minus((index%5+1)/4).toFixed(8),
    close:open.plus(((index%11)-5)/10).toFixed(8),volume:new Money((index%13)+1).div(8).toFixed(8)};
};
async function seed(db,{start,count,gapFirst,gapRows=7}){
  const times=[],bars=[],hashes=[],provenance=JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'});
  for(let index=0;index<count;index++){
    if(index>=gapFirst&&index<gapFirst+gapRows)continue;
    const time=start+(index+1)*MINUTE,bar={time,...priceOf(index),atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
    times.push(time);bars.push(JSON.stringify(bar));hashes.push(hash(canonical(bar)));
  }
  await db.query("INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',x.t,x.b::jsonb,$1::jsonb,x.h FROM unnest($2::bigint[],$3::text[],$4::text[]) AS x(t,b,h)",
    [provenance,times,bars,hashes]);
  return times.map((time,at)=>({time,...JSON.parse(bars[at])}));
}
// Reference aggregation of the same rows with decimal.js: epoch aligned buckets of closed candles only. Stored bars are never forming.
function reference(rows,interval,limit){
  const ms=INTERVAL_MS[interval],latest=rows.at(-1).time,end=Math.floor(latest/ms)*ms,begin=end-limit*ms,buckets=new Map();
  for(const row of rows.filter(item=>item.time>begin&&item.time<=end)){
    const key=Math.floor((row.time-MINUTE)/ms)*ms;
    if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(row);
  }
  return [...buckets].sort((a,b)=>a[0]-b[0]).map(([time,list])=>({time,open:exact(list[0].open),
    high:exact(list.reduce((best,row)=>Money.max(best,row.high),new Money(list[0].high)).toFixed()),
    low:exact(list.reduce((best,row)=>Money.min(best,row.low),new Money(list[0].low)).toFixed()),
    close:exact(list.at(-1).close),volume:exact(list.reduce((sum,row)=>sum.plus(row.volume),new Money(0)).toFixed()),
    minutes:list.length,complete:list.length===ms/MINUTE,forming:false}));
}

async function seeded(t,environment){
  const f=await fixture(t,environment),owner=await f.login(f.owner);
  const end=Math.floor(Date.now()/MINUTE)*MINUTE-MINUTE,start=Math.floor((end-48*HOUR)/HOUR)*HOUR,count=(end-start)/MINUTE;
  // The 7 missing minutes sit inside the last day, away from every hour boundary (bar_time offsets 31..37 minutes past an hour).
  const gapFirst=Math.floor((count-300)/60)*60+30;
  const rows=await seed(f.db,{start,count,gapFirst});
  return {f,owner,rows,start,end,gap:{from_open_time:start+gapFirst*MINUTE,to_open_time:start+(gapFirst+6)*MINUTE,missing_minutes:7}};
}
const get=(f,session,query='')=>f.request(PATH+query,'GET',undefined,session);

// Loopback fake of the two public Binance paths. It records every hit (path, query, headers) and can answer klines with a status, a
// Retry-After header or a delay. Bodies it sends on purpose contain text that must never reach a browser answer.
const LEAK='upstream secret text';
async function upstream(t){
  const state={hits:[],klines:[],exchange:[],klinesStatus:200,retryAfter:null,klinesDelayMs:0};
  const symbols=[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',tick:'0.01000000'},{symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',tick:'0.01000000'}];
  for(let index=0;index<60;index++)symbols.push({symbol:`T${String(index).padStart(4,'0')}USDT`,baseAsset:`T${String(index).padStart(4,'0')}`,quoteAsset:'USDT',tick:'0.00100000'});
  const exchangeBody=JSON.stringify({symbols:symbols.map(item=>({symbol:item.symbol,status:'TRADING',baseAsset:item.baseAsset,quoteAsset:item.quoteAsset,
    isSpotTradingAllowed:true,filters:[{filterType:'PRICE_FILTER',tickSize:item.tick}]}))});
  function klinesBody(query){
    const ms=INTERVAL_MS[query.interval],limit=Number(query.limit),lastOpen=Math.floor(Date.now()/ms)*ms,rows=[];
    for(let index=0;index<limit;index++){
      const open=lastOpen-(limit-1-index)*ms,base=2000+index;
      rows.push([open,base.toFixed(2),(base+2).toFixed(2),(base-2).toFixed(2),(base+1).toFixed(2),'10.5',open+ms-1,'0',1,'0','0','0']);
    }
    return JSON.stringify(rows);
  }
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1'),seen={path:url.pathname,query:Object.fromEntries(url.searchParams),headers:req.headers};
    state.hits.push(seen);
    if(url.pathname==='/api/v3/exchangeInfo'){
      state.exchange.push(seen);res.writeHead(200,{'content-type':'application/json'});res.end(exchangeBody);return;
    }
    if(url.pathname==='/api/v3/klines'){
      state.klines.push(seen);
      const reply=()=>{
        if(state.klinesStatus!==200){
          res.writeHead(state.klinesStatus,state.retryAfter===null?{}:{'retry-after':String(state.retryAfter)});res.end(LEAK);return;
        }
        res.writeHead(200,{'content-type':'application/json'});res.end(klinesBody(seen.query));
      };
      if(state.klinesDelayMs>0)setTimeout(reply,state.klinesDelayMs);else reply();
      return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {state,origin:'http://127.0.0.1:'+server.address().port};
}
const proxyOn=up=>({MARKET_PUBLIC_PROXY:'1',MARKET_PROXY_TEST_ORIGIN:up.origin});
function assertNoLeak(body){
  const text=JSON.stringify(body);
  for(const banned of [LEAK,'127.0.0.1','binance.com','http','Retry-After','provenance','content_hash'])assert.ok(!text.includes(banned),banned);
}

test('auth and query validation: 401 without a session, strict keys, 14 intervals, per-interval stored caps, GET only',async t=>{
  const {f,owner}=await seeded(t);
  assert.equal((await f.request(PATH)).status,401);
  assert.equal((await f.request(SYMBOLS)).status,401);
  const before=await digests(f.db);
  assert.equal((await get(f,owner,'?interval=1h&source=stored')).status,200,'a stored answer for a stored interval');
  assert.equal((await get(f,owner,'?bot_id='+f.owner.id+'&interval=1h&source=stored')).status,200,'the shared api() helper appends bot_id');
  assert.equal((await get(f,owner,'?bot_id=all&interval=1h&source=stored')).status,200);
  const refused=[['?interval=7m',400,'INTERVAL_NOT_ALLOWED'],['?interval=1M',400,'INTERVAL_NOT_ALLOWED'],['?limit=0',400,'LIMIT_OUT_OF_RANGE'],
    ['?limit=1001',400,'LIMIT_OUT_OF_RANGE'],['?limit=abc',400,'LIMIT_OUT_OF_RANGE'],['?interval=4h&source=stored&limit=181',400,'SOURCE_NOT_ALLOWED'],
    ['?interval=1d&source=stored&limit=31',400,'SOURCE_NOT_ALLOWED'],['?interval=1h&source=stored&limit=721',400,'SOURCE_NOT_ALLOWED'],
    ['?interval=3d&source=stored',400,'SOURCE_NOT_ALLOWED'],['?interval=1w&source=stored',400,'SOURCE_NOT_ALLOWED'],
    ['?symbol=ETHUSDT&source=stored',400,'SOURCE_NOT_ALLOWED'],['?source=best',400,'SOURCE_NOT_ALLOWED'],
    ['?symbol=eth',400,'MARKET_SYMBOL_INVALID'],['?symbol=BTCUSDT%26limit=1',400,'MARKET_SYMBOL_INVALID'],
    ['?foo=1',400,'INVALID_FIELDS'],['?interval=1h&interval=5m',400,'INVALID_FIELDS'],['?limit=',400,'INVALID_FIELDS']];
  for(const [query,status,code] of refused){
    const answer=await get(f,owner,query);
    assert.equal(answer.status,status,query);assert.equal(answer.body.code,code,query);
  }
  for(const interval of ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w'])
    assert.notEqual((await get(f,owner,'?interval='+interval+'&limit=1')).body.code,'INTERVAL_NOT_ALLOWED',interval);
  assert.equal((await f.request(PATH,'POST',{},owner)).status,405);
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('stored 1m answer: exact normalized strings, closed bars only, v2 fields and no internal fields',async t=>{
  const {f,owner,rows,end}=await seeded(t);
  const answer=await get(f,owner,'?interval=1m&limit=5&source=stored');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body,last=rows.slice(-5);
  assert.equal(body.version,'market-ohlcv-v2');assert.equal(body.source,STORED);assert.equal(body.status,'OK');
  assert.deepEqual([body.broker,body.symbol,body.display_symbol,body.market,body.base_timeframe,body.closed_only],
    ['binance-global','BTCUSDT','BINANCE:BTCUSDT','SPOT','1m',true]);
  assert.equal(body.fallback,null);assert.equal(body.cache_age_seconds,null);assert.equal(body.price_tick,null);
  assert.equal(body.latest_closed_bar.close_time,end);assert.equal(body.latest_closed_bar.open_time,end-MINUTE);
  assert.ok(body.age_seconds>=60&&body.age_seconds<600,'age '+body.age_seconds);
  assert.deepEqual(body.bars.map(bar=>bar.time),last.map(row=>row.time-MINUTE));
  for(const [at,bar] of body.bars.entries()){
    assert.equal(bar.open,exact(last[at].open));assert.equal(bar.close,exact(last[at].close));assert.equal(bar.volume,exact(last[at].volume));
    assert.equal(bar.minutes,1);assert.equal(bar.complete,true);assert.equal(bar.forming,false);
    assert.ok(!bar.open.endsWith('0')||!bar.open.includes('.'),'trailing zeros removed');
  }
  assertNoLeak(body);
});

test('stored 5m, 15m, 1h, 4h and 1d equal a decimal.js reference aggregation of the same rows; gap ranges are exact',async t=>{
  const {f,owner,rows,gap}=await seeded(t);
  for(const [interval,limit] of [['5m',100],['15m',100],['1h',48],['4h',12],['1d',2]]){
    const answer=await get(f,owner,`?interval=${interval}&limit=${limit}&source=stored`);
    assert.equal(answer.status,200,interval+JSON.stringify(answer.body));
    const expected=reference(rows,interval,limit);
    assert.ok(expected.length>0,interval);
    assert.deepEqual(answer.body.bars,expected,interval);
    assert.ok(answer.body.bars.every((bar,at,list)=>at===0||list[at-1].time<bar.time));
    assert.ok(answer.body.bars.at(-1).time+INTERVAL_MS[interval]<=answer.body.latest_closed_bar.close_time,'the forming bucket is never returned: '+interval);
  }
  const hourly=await get(f,owner,'?interval=1h&limit=48&source=stored');
  assert.equal(hourly.body.gaps.count,1);assert.equal(hourly.body.gaps.missing_minutes,7);assert.deepEqual(hourly.body.gaps.ranges,[gap]);
  assert.equal(hourly.body.bars.filter(bar=>!bar.complete).length,1,'the bucket with the hole is flagged incomplete');
  assert.equal(hourly.body.history_partial,false,'48 hours of history cover the 48 hour window');
  const minutes=await get(f,owner,'?interval=1m&limit=1000&source=stored');
  assert.deepEqual(minutes.body.gaps.ranges,[gap]);assert.equal(minutes.body.gaps.truncated,false);
  const quiet=await get(f,owner,'?interval=1m&limit=240&source=stored');
  assert.equal(quiet.body.gaps.count,0,'240 minutes do not reach the hole');
});

test('proxy off: BTCUSDT 1d falls back to stored data with a MARKET_PROXY_DISABLED label; other symbols and the symbol list are 503 without an audit error',async t=>{
  const {f,owner}=await seeded(t,{MARKET_PUBLIC_PROXY:'0'});
  const before=await digests(f.db),errors=await errorRows(f.db);
  const fallback=await get(f,owner);
  assert.equal(fallback.status,200,JSON.stringify(fallback.body));
  const body=fallback.body;
  assert.equal(body.version,'market-ohlcv-v2');assert.equal(body.source,STORED);assert.equal(body.symbol,'BTCUSDT');assert.equal(body.interval,'1d');
  assert.deepEqual(body.fallback,{from:REST,reason:'MARKET_PROXY_DISABLED'});
  assert.equal(body.history_partial,true,'48 hours of history do not cover the default daily window');
  assert.ok(body.bars.length>0&&body.bars.every(bar=>bar.forming===false));assert.equal(body.closed_only,true);
  assert.equal((await get(f,owner,'?interval=1h')).body.fallback.reason,'MARKET_PROXY_DISABLED','a partly covered window is a labelled fallback');
  const other=await get(f,owner,'?symbol=ETHUSDT');
  assert.equal(other.status,503);assert.equal(other.body.code,'MARKET_PROXY_DISABLED');assertNoLeak(other.body);
  assert.equal((await get(f,owner,'?symbol=ETHUSDT&interval=1w')).body.code,'MARKET_PROXY_DISABLED');
  const symbols=await f.request(SYMBOLS,'GET',undefined,owner);
  assert.equal(symbols.status,503);assert.equal(symbols.body.code,'MARKET_PROXY_DISABLED');
  assert.equal((await f.request(SYMBOLS+'?bot_id='+f.owner.id,'GET',undefined,owner)).status,503,'bot_id is tolerated');
  assert.equal((await f.request(SYMBOLS+'?foo=1','GET',undefined,owner)).body.code,'INVALID_FIELDS');
  assert.equal(await errorRows(f.db),errors+1,'only the one INVALID_FIELDS refusal wrote a request.error row');
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('proxy on: symbol list and ETHUSDT klines come from the loopback upstream with a clean request, flagged forming bar and no leak',async t=>{
  const up=await upstream(t),f=await fixture(t,proxyOn(up)),owner=await f.login(f.owner);
  const before=await digests(f.db);
  const symbols=await f.request(SYMBOLS,'GET',undefined,owner);
  assert.equal(symbols.status,200,JSON.stringify(symbols.body));
  assert.equal(symbols.body.version,'market-symbols-v1');assert.equal(symbols.body.source,REST);assert.equal(symbols.body.stale,false);
  assert.equal(symbols.body.count,62);assert.equal(symbols.body.symbols.length,62);
  assert.deepEqual(symbols.body.symbols.find(item=>item[0]==='ETHUSDT'),['ETHUSDT','ETH','USDT','0.01']);
  assert.equal(up.state.exchange.length,1);assertNoLeak(symbols.body);
  const answer=await get(f,owner,'?symbol=ETHUSDT');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.equal(body.version,'market-ohlcv-v2');assert.equal(body.source,REST);assert.equal(body.closed_only,false);assert.equal(body.status,'OK');
  assert.deepEqual([body.symbol,body.display_symbol,body.interval,body.limit],['ETHUSDT','BINANCE:ETHUSDT','1d',365]);
  assert.equal(body.bars.length,365);assert.equal(body.price_tick,'0.01');assert.equal(body.fallback,null);assert.equal(body.stale,false);
  assert.equal(body.window,null);assert.equal(body.gaps,null);assert.equal(body.base_timeframe,null);
  const last=body.bars.at(-1),closed=body.bars.at(-2);
  assert.equal(last.forming,true);assert.equal(last.complete,false);
  assert.ok(body.bars.slice(0,-1).every(bar=>bar.forming===false&&bar.complete===true));
  assert.equal(body.latest_closed_bar.open_time,closed.time,'the forming bar is not the latest closed bar');
  assert.equal(body.latest_closed_bar.close_time,closed.time+DAY);
  assert.equal(up.state.klines.length,1);
  const hit=up.state.klines[0];
  assert.deepEqual(hit.query,{symbol:'ETHUSDT',interval:'1d',limit:'365'},'exactly the three keys');
  for(const header of ['authorization','x-mbx-apikey','cookie'])assert.ok(!(header in hit.headers),header);
  assertNoLeak(body);
  const again=await get(f,owner,'?symbol=ETHUSDT');
  assert.equal(again.status,200);assert.equal(up.state.klines.length,1,'the second answer comes from the cache');
  assert.equal((await get(f,owner,'?symbol=ETHUSDT&interval=1w&limit=10')).status,200);
  const unknown=await get(f,owner,'?symbol=ZZZZZZUSDT');
  assert.equal(unknown.status,400);assert.equal(unknown.body.code,'MARKET_SYMBOL_NOT_ALLOWED');
  assert.equal(up.state.klines.some(item=>item.query.symbol==='ZZZZZZUSDT'),false,'a symbol outside the allow-list never reaches the upstream');
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('proxy on: stored BTCUSDT data answers when covered; an uncovered window uses REST; a failing upstream gives the labelled stored fallback',async t=>{
  const up=await upstream(t),{f,owner,rows}=await seeded(t,proxyOn(up)),before=await digests(f.db);
  const covered=await get(f,owner,'?interval=1h&limit=24');
  assert.equal(covered.status,200);assert.equal(covered.body.source,STORED);assert.equal(covered.body.fallback,null);
  assert.deepEqual(covered.body.bars,reference(rows,'1h',24));assert.equal(up.state.hits.length,0,'full fresh stored coverage needs no upstream call');
  const rest=await get(f,owner);
  assert.equal(rest.status,200,JSON.stringify(rest.body));assert.equal(rest.body.source,REST);assert.equal(rest.body.bars.length,365);
  assert.equal(up.state.klines.length,1);assert.equal(up.state.klines[0].query.symbol,'BTCUSDT');
  assert.equal(up.state.exchange.length,0,'BTCUSDT needs no symbol list');
  up.state.klinesStatus=500;
  const failed=await get(f,owner,'?interval=4h');
  assert.equal(failed.status,200,JSON.stringify(failed.body));
  assert.equal(failed.body.source,STORED);assert.deepEqual(failed.body.fallback,{from:REST,reason:'MARKET_UPSTREAM_UNAVAILABLE'});
  assert.equal(failed.body.history_partial,true);assert.ok(failed.body.bars.length>0);assertNoLeak(failed.body);
  const eth=await get(f,owner,'?symbol=ETHUSDT&interval=4h');
  assert.equal(eth.status,503);assert.equal(eth.body.code,'MARKET_UPSTREAM_UNAVAILABLE','no stored fallback exists for another symbol');assertNoLeak(eth.body);
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('no database session is idle in a transaction while the upstream holds a klines answer',async t=>{
  const up=await upstream(t),f=await fixture(t,proxyOn(up)),owner=await f.login(f.owner);
  up.state.klinesDelayMs=2000;
  const known=up.state.klines.length;
  let settled=false;
  const pending=get(f,owner,'?symbol=ETHUSDT&interval=4h&limit=50').then(answer=>{settled=true;return answer;});
  for(let i=0;i<150&&up.state.klines.length===known;i++)await delay(20);
  assert.equal(up.state.klines.length,known+1,'the klines request reached the fake upstream');
  await delay(500);
  assert.equal(settled,false,'the upstream still holds the answer');
  const idle=(await f.db.query(`SELECT pid,state FROM pg_stat_activity WHERE datname=current_database()
    AND application_name='robot-trade-phase2' AND state LIKE 'idle in transaction%' AND pid<>pg_backend_pid()`)).rows;
  assert.deepEqual(idle,[],'the request transaction committed before the network phase');
  const answer=await pending;
  assert.equal(answer.status,200,JSON.stringify(answer.body));assert.equal(answer.body.bars.length,50);
});

test('upstream 429 with Retry-After opens the cooldown: 503 with the retry time, and no further upstream hit',async t=>{
  const up=await upstream(t),f=await fixture(t,proxyOn(up)),owner=await f.login(f.owner);
  const before=await digests(f.db);
  assert.equal((await f.request(SYMBOLS,'GET',undefined,owner)).status,200);
  up.state.klinesStatus=429;up.state.retryAfter=120;
  const first=await get(f,owner,'?symbol=ETHUSDT&interval=1h');
  assert.equal(first.status,503,JSON.stringify(first.body));
  assert.equal(first.body.code,'MARKET_UPSTREAM_COOLDOWN');assert.ok(first.body.retry_after_seconds>=119&&first.body.retry_after_seconds<=120,JSON.stringify(first.body));
  assertNoLeak(first.body);
  assert.equal(up.state.klines.length,1);
  const second=await get(f,owner,'?symbol=ETHUSDT&interval=4h');
  assert.equal(second.status,503);assert.equal(second.body.code,'MARKET_UPSTREAM_COOLDOWN');assert.ok(second.body.retry_after_seconds>0);
  assert.equal((await get(f,owner,'?symbol=BTCUSDT')).body.code,'MARKET_UPSTREAM_COOLDOWN','the cooldown covers every symbol');
  assert.equal(up.state.klines.length,1,'the cooldown makes no upstream call');
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('readiness report carries an advisory market_data item; verdict and blockers equal a service without it; nothing is written',async t=>{
  const {f,owner,gap}=await seeded(t);
  await f.store.setRisk(f.owner.id,{...structuredClone(config.defaultRisk),blockDuringNews:false,equities:{'binance-global':'1000'},balances:{'binance-global':'800'}});
  const before=await digests(f.db);
  const answer=await f.request(REPORT,'GET',undefined,owner);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const {market_data:item,...report}=answer.body;
  assert.equal(item.version,'pf3-market-data-v1');assert.equal(item.advisory,true);assert.equal(item.affects_verdict,false);assert.deepEqual(item.unlocks,[]);
  assert.equal(item.status,'WARN');assert.ok(item.reasons.includes('MARKET_DATA_GAPS'),JSON.stringify(item.reasons));
  assert.equal(item.missing_bars,7);assert.equal(item.gap_count,1);assert.deepEqual(item.gaps,[gap]);assert.equal(item.expected_bars-item.bars_available,7);
  assert.equal(item.source,STORED);assert.equal(item.window_minutes,1440);
  const plain=new ReadinessService({store:f.store,defaultRisk:config.defaultRisk,pineBridgeEnabled:true,clock:()=>Date.parse(report.generated_at)});
  const reference=await plain.report(f.owner.id,f.owner.id);
  assert.equal('market_data' in reference,false,'a service without a reader has no market_data');
  assert.equal(report.verdict,reference.verdict);assert.deepEqual(report.verdict_basis,reference.verdict_basis);assert.deepEqual(report.blockers,reference.blockers);
  assert.equal(report.rules_version,reference.rules_version);
  assert.deepEqual(await digests(f.db),before,'the report and the read-only item wrote nothing');
});

test('no stored bars: EMPTY stored answer, a labelled EMPTY fallback for the default window, and a FAIL readiness item, all without an error',async t=>{
  const f=await fixture(t),owner=await f.login(f.owner);
  const answer=await get(f,owner,'?interval=1h&source=stored');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.equal(answer.body.status,'EMPTY');assert.equal(answer.body.stale,true);assert.deepEqual(answer.body.bars,[]);assert.equal(answer.body.latest_closed_bar,null);
  const fallback=await get(f,owner);
  assert.equal(fallback.status,200,JSON.stringify(fallback.body));assert.equal(fallback.body.status,'EMPTY');assert.deepEqual(fallback.body.bars,[]);
  const report=await f.request(REPORT,'GET',undefined,owner);
  assert.equal(report.status,200,JSON.stringify(report.body));
  assert.equal(report.body.market_data.status,'FAIL');assert.deepEqual(report.body.market_data.reasons,['MARKET_DATA_EMPTY']);
});