import {describe,it,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {
  UPSTREAM_ORIGIN,KLINES_PATH,EXCHANGE_INFO_PATH,EXCHANGE_INFO_QUERY,EXCHANGE_INFO_FALLBACK_QUERY,SYMBOL_RE,LIMITS,KLINE_INTERVALS,
  parseProxyConfig,parseExchangeInfo,parseKlines,PublicMarketProxy} from '../src/postgres/market-proxy.js';

// No test in this file may reach a network: every proxy gets an injected fetcher. The guard is scoped to this describe block
// because npm test runs every file in one process (--test-isolation=none).
describe('market-proxy (no network)',()=>{
const realFetch=globalThis.fetch;
before(()=>{globalThis.fetch=()=>{throw new Error('network call forbidden in market-proxy tests');};});
after(()=>{globalThis.fetch=realFetch;});

const T0=Date.UTC(2026,9,4,12,0,10);
const SECRET='SECRET-UPSTREAM-TEXT';
const reply=(body,{status=200,headers={}}={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers});
const codeOf=async operation=>{try{await operation();}catch(error){return error;}return null;};
const syncCode=fn=>{try{fn();}catch(error){return error;}return null;};

const symbolRow=(base,quote='USDT',extra={})=>({symbol:base+quote,status:'TRADING',baseAsset:base,quoteAsset:quote,isSpotTradingAllowed:true,
  filters:[{filterType:'PRICE_FILTER',minPrice:'0.01000000',maxPrice:'1000000.00000000',tickSize:'0.01000000'}],...extra});
const exchange=(count=60)=>({timezone:'UTC',symbols:[symbolRow('BTC'),symbolRow('ETH'),
  ...Array.from({length:count},(_,index)=>symbolRow('T'+String(index).padStart(4,'0')))]});

// klines rows for interval ms: the last row is the bar open at "now".
const klineRows=(now,ms,count)=>{
  const last=Math.floor(now/ms)*ms;
  return Array.from({length:count},(_,index)=>{
    const open=last-(count-1-index)*ms;
    return [open,'100.5','101.5','99.5','100.75','12.5',open+ms-1,'1250',10,'6','600','0'];
  });
};

// A scripted upstream. handler(url,init,count) returns a Response, or undefined for the default answer: the symbol list, or 3 klines rows.
function upstream({handler=null,clock}={}){
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url:String(url),init});
    if(handler){const answer=await handler(String(url),init,calls.length);if(answer!==undefined)return answer;}
    const parsed=new URL(url);
    if(parsed.pathname===EXCHANGE_INFO_PATH)return reply(exchange());
    const ms=KLINE_INTERVALS[parsed.searchParams.get('interval')].ms;
    return reply(klineRows(clock(),ms,Math.min(3,Number(parsed.searchParams.get('limit')))));
  };
  return {calls,fetcher};
}
function setup({handler=null,limits={},enabled=true,origin=UPSTREAM_ORIGIN}={}){
  const state={now:T0},logs=[];
  const clock=()=>state.now;
  const {calls,fetcher}=upstream({handler,clock});
  const proxy=new PublicMarketProxy({enabled,origin,fetcher,clock,limits:{...LIMITS,...limits},log:line=>logs.push(line)});
  return {proxy,calls,logs,state,advance:ms=>{state.now+=ms;}};
}
const ask=(proxy,over={})=>proxy.klines({symbol:'BTCUSDT',interval:'1h',limit:100,actorId:'user-1',...over});
const klinesCalls=calls=>calls.filter(call=>call.url.includes(KLINES_PATH));

describe('config',()=>{
  it('MARKET_PUBLIC_PROXY=0 is the only kill switch; unset or any other value enables',()=>{
    assert.deepEqual(parseProxyConfig({}),{enabled:true,origin:UPSTREAM_ORIGIN});
    assert.deepEqual(parseProxyConfig({MARKET_PUBLIC_PROXY:''}),{enabled:true,origin:UPSTREAM_ORIGIN});
    assert.deepEqual(parseProxyConfig({MARKET_PUBLIC_PROXY:'1'}),{enabled:true,origin:UPSTREAM_ORIGIN});
    assert.deepEqual(parseProxyConfig({MARKET_PUBLIC_PROXY:'yes'}),{enabled:true,origin:UPSTREAM_ORIGIN});
    assert.deepEqual(parseProxyConfig({MARKET_PUBLIC_PROXY:'0'}),{enabled:false,origin:UPSTREAM_ORIGIN});
    assert.deepEqual(parseProxyConfig({MARKET_PUBLIC_PROXY:'0',NODE_ENV:'production'}),{enabled:false,origin:UPSTREAM_ORIGIN});
  });
  it('a NODE_ENV=test process never reaches the public host: the proxy stays off without a loopback test origin',()=>{
    assert.deepEqual(parseProxyConfig({NODE_ENV:'test'}),{enabled:false,origin:UPSTREAM_ORIGIN});
    assert.deepEqual(parseProxyConfig({NODE_ENV:'production'}),{enabled:true,origin:UPSTREAM_ORIGIN});
  });
  it('the test origin works only under NODE_ENV=test on 127.0.0.1; every other case throws at startup',()=>{
    assert.deepEqual(parseProxyConfig({NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1:45678'}),{enabled:true,origin:'http://127.0.0.1:45678'});
    assert.deepEqual(parseProxyConfig({NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1:45678',MARKET_PUBLIC_PROXY:'0'}),{enabled:false,origin:UPSTREAM_ORIGIN});
    for(const env of [{MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1:45678'},{NODE_ENV:'production',MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1:45678'},
      {NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'https://127.0.0.1:45678'},{NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://localhost:45678'},
      {NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1:45678/x'},{NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1.evil.test:80'},
      {NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://api.binance.com'},{NODE_ENV:'test',MARKET_PROXY_TEST_ORIGIN:'http://127.0.0.1'}])
      assert.throws(()=>parseProxyConfig(env),/MARKET_PROXY_TEST_ORIGIN/,JSON.stringify(env));
  });
  it('the proxy constructor refuses any origin but the fixed host or a loopback test origin',()=>{
    for(const origin of ['https://evil.test','http://api.binance.com','https://api.binance.com/','http://127.0.0.1','http://localhost:1234'])
      assert.throws(()=>new PublicMarketProxy({enabled:true,origin,fetcher:async()=>{}}),/origin/,origin);
    assert.doesNotThrow(()=>new PublicMarketProxy({enabled:true,origin:'http://127.0.0.1:9999',fetcher:async()=>{}}));
  });
  it('constants: fixed paths, frozen limits and the 14 intervals',()=>{
    assert.equal(UPSTREAM_ORIGIN,'https://api.binance.com');assert.equal(KLINES_PATH,'/api/v3/klines');assert.equal(EXCHANGE_INFO_PATH,'/api/v3/exchangeInfo');
    assert.equal(EXCHANGE_INFO_QUERY,'permissions=SPOT&showPermissionSets=false&symbolStatus=TRADING');assert.equal(EXCHANGE_INFO_FALLBACK_QUERY,'permissions=SPOT');
    assert.ok(Object.isFrozen(LIMITS)&&Object.isFrozen(KLINE_INTERVALS));
    assert.deepEqual(Object.keys(KLINE_INTERVALS),['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w']);
    const pinned={weightPerMinute:600,usedWeightGuard:3000,userRequestsPerMinute:60,userMissesPerMinute:20,concurrency:4,klinesTimeoutMs:4000,
      klinesMaxBytes:1048576,exchangeInfoTimeoutMs:8000,exchangeInfoMaxBytes:16777216,cacheEntries:128,cacheBytes:16777216};
    for(const [key,value] of Object.entries(pinned))assert.equal(LIMITS[key],value,key);
  });
});

describe('URL discipline',()=>{
  it('every upstream URL is a fixed-origin klines or exchangeInfo URL; every request is keyless, redirect-free and signal-bound',async()=>{
    const {proxy,calls}=setup();
    await proxy.symbols({});
    await proxy.klines({symbol:'ETHUSDT',interval:'1d',limit:365,actorId:'a'});
    await ask(proxy,{interval:'1w',limit:260});
    assert.equal(calls.length,3);
    for(const {url,init} of calls){
      if(url.includes(KLINES_PATH)){
        assert.ok(url.startsWith('https://api.binance.com/api/v3/klines?'),url);
        assert.deepEqual([...new URL(url).searchParams.keys()],['symbol','interval','limit']);
      }else assert.equal(url,'https://api.binance.com/api/v3/exchangeInfo?'+EXCHANGE_INFO_QUERY);
      assert.equal(init.redirect,'error');assert.equal(init.method,'GET');assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(Object.keys(init.headers),['accept']);
      assert.deepEqual(Object.keys(init).sort(),['headers','method','redirect','signal']);
    }
    assert.equal(new URL(calls[1].url).searchParams.get('symbol'),'ETHUSDT');assert.equal(new URL(calls[1].url).searchParams.get('limit'),'365');
  });
  it('hostile symbols, intervals and limits are refused before any fetch',async()=>{
    const {proxy,calls}=setup();
    for(const symbol of ['../x','BTCUSDT&limit=1','btcusdt','ABCD','A'.repeat(21),'BTC%2F','\u00c9THUSDT','BTC/USDT','BTCUSDT\n','',null,undefined,5])
      assert.equal((await codeOf(()=>ask(proxy,{symbol}))).code,'MARKET_SYMBOL_INVALID',String(symbol));
    for(const interval of ['2m','1H','__proto__','toString','1d&x=1','',null])
      assert.equal((await codeOf(()=>ask(proxy,{interval}))).code,'INTERVAL_NOT_ALLOWED',String(interval));
    for(const limit of [0,-1,1001,1.5,'5',NaN,undefined])
      assert.equal((await codeOf(()=>ask(proxy,{limit}))).code,'LIMIT_OUT_OF_RANGE',String(limit));
    assert.equal(calls.length,0);
    assert.ok(SYMBOL_RE.test('BTCUSDT')&&!SYMBOL_RE.test('btcusdt'));
  });
  it('a symbol that is not on the allow-list is refused after one allow-list load and no klines fetch',async()=>{
    const {proxy,calls}=setup();
    const error=await codeOf(()=>ask(proxy,{symbol:'ZZZZZUSDT'}));
    assert.equal(error.code,'MARKET_SYMBOL_NOT_ALLOWED');assert.equal(error.status,400);
    assert.equal(calls.length,1);assert.ok(calls[0].url.includes(EXCHANGE_INFO_PATH));
  });
  it('the loopback test origin is used as given and no other host is ever called',async()=>{
    const {proxy,calls}=setup({origin:'http://127.0.0.1:45678'});
    await ask(proxy);
    assert.ok(calls[0].url.startsWith('http://127.0.0.1:45678/api/v3/klines?'));
  });
  it('a proxy built without a fetcher resolves globalThis.fetch at call time (the describe guard) and never reaches a network',async()=>{
    const proxy=new PublicMarketProxy({enabled:true,clock:()=>T0,log:()=>{}});
    const error=await codeOf(()=>ask(proxy));
    assert.equal(error.code,'MARKET_UPSTREAM_UNAVAILABLE');assert.ok(!error.message.includes('forbidden'));
  });
  it('a disabled proxy refuses everything before any fetch',async()=>{
    const {proxy,calls}=setup({enabled:false});
    assert.equal(proxy.enabled,false);
    assert.equal((await codeOf(()=>ask(proxy))).code,'MARKET_PROXY_DISABLED');
    assert.equal((await codeOf(()=>proxy.symbols({}))).code,'MARKET_PROXY_DISABLED');
    assert.equal(calls.length,0);
  });
});

describe('allow-list',()=>{
  it('keeps only TRADING Spot symbols with clean names and matching base plus quote, sorted, with the tick',()=>{
    const good=exchange(60);
    const bad=[symbolRow('BAD','USDT',{status:'BREAK'}),symbolRow('NOSPOT','USDT',{isSpotTradingAllowed:false}),
      {...symbolRow('MISMA'),symbol:'MISMBUSDT'},symbolRow('lower'),symbolRow('S','BT'),symbolRow('TOOLONGASSETNAME1X','USDT'),
      {...symbolRow('NOFLAG'),isSpotTradingAllowed:undefined,permissions:['MARGIN']},{...symbolRow('PERMOK'),isSpotTradingAllowed:undefined,permissions:['SPOT']},
      symbolRow('\u00c9TH'),null,'x',{symbol:5}];
    const parsed=parseExchangeInfo({symbols:[...bad,...good.symbols,good.symbols[0]]});
    assert.equal(parsed.list.length,63,'62 good rows plus PERMOK; duplicates collapse');
    assert.ok(parsed.set.has('BTCUSDT')&&parsed.set.has('PERMOKUSDT'));
    for(const name of ['BADUSDT','NOSPOTUSDT','MISMBUSDT','lowerUSDT','SBT','NOFLAGUSDT','\u00c9THUSDT'])assert.ok(!parsed.set.has(name),name);
    assert.deepEqual(parsed.list[0],['BTCUSDT','BTC','USDT','0.01']);
    assert.deepEqual(parsed.list.map(item=>item[0]),[...parsed.list.map(item=>item[0])].sort());
    const noTick=parseExchangeInfo({symbols:[...good.symbols,{...symbolRow('ZZTOP'),filters:[]},{...symbolRow('ZZTOQ'),filters:[{filterType:'PRICE_FILTER',tickSize:'0.00000000'}]}]});
    assert.equal(noTick.list.find(item=>item[0]==='ZZTOPUSDT')[3],null);assert.equal(noTick.list.find(item=>item[0]==='ZZTOQUSDT')[3],null);
  });
  it('fewer than 50 valid symbols, a missing list or a non-object payload is MARKET_UPSTREAM_INVALID',()=>{
    for(const payload of [{symbols:exchange(46).symbols},{symbols:[]},{},null,[],'x',{symbols:'x'}])
      assert.equal(syncCode(()=>parseExchangeInfo(payload)).code,'MARKET_UPSTREAM_INVALID');
    assert.doesNotThrow(()=>parseExchangeInfo({symbols:exchange(48).symbols}));
  });
  it('BTCUSDT is admitted before the first load without fetching the list',async()=>{
    const {proxy,calls}=setup();
    await ask(proxy);
    assert.equal(calls.length,1);assert.ok(calls[0].url.includes(KLINES_PATH));
  });
  it('HTTP 400 on the full exchangeInfo query retries once with the fallback query',async()=>{
    const {proxy,calls}=setup({handler:(url,init,count)=>count===1?reply('bad',{status:400}):undefined});
    const snapshot=await proxy.symbols({});
    assert.equal(snapshot.set.has('ETHUSDT'),true);assert.equal(calls.length,2);
    assert.equal(calls[0].url,'https://api.binance.com/api/v3/exchangeInfo?'+EXCHANGE_INFO_QUERY);
    assert.equal(calls[1].url,'https://api.binance.com/api/v3/exchangeInfo?'+EXCHANGE_INFO_FALLBACK_QUERY);
  });
  it('the list is cached for 6 h, kept as last good for 24 h (stale after 6 h while refresh fails) and then unavailable',async()=>{
    let failing=false;
    const {proxy,calls,advance}=setup({handler:()=>failing?reply(SECRET,{status:500}):undefined,limits:{failureThreshold:99}});
    const first=await proxy.symbols({});
    assert.equal(first.stale,false);assert.equal(first.retrieved_at,T0);assert.equal(proxy.tick('ETHUSDT'),'0.01');assert.equal(proxy.tick('NOPE'),null);
    advance(6*3600*1000-1);assert.equal((await proxy.symbols({})).stale,false);assert.equal(calls.length,1);
    failing=true;advance(2);
    const stale=await proxy.symbols({});
    assert.equal(stale.stale,true);assert.equal(stale.retrieved_at,T0);assert.equal(calls.length,2);
    advance(60*1000);assert.equal((await proxy.symbols({})).stale,true);assert.equal(calls.length,3);
    advance(24*3600*1000);
    const error=await codeOf(()=>proxy.symbols({}));
    assert.equal(error.code,'MARKET_SYMBOLS_UNAVAILABLE');assert.equal(error.status,503);assert.ok(!error.message.includes(SECRET));
    failing=false;advance(20*60*1000);
    const fresh=await proxy.symbols({});
    assert.equal(fresh.stale,false);assert.ok(fresh.retrieved_at>T0);
  });
  it('a failed load backs off 60 s, doubling to 600 s, and a success resets',async()=>{
    let failing=true;
    const {proxy,calls,advance}=setup({handler:()=>failing?reply('x',{status:500}):undefined,limits:{failureThreshold:99}});
    const waits=[];
    for(const expected of [60,120,240,480,600,600]){
      assert.equal((await codeOf(()=>proxy.symbols({}))).code,'MARKET_SYMBOLS_UNAVAILABLE');
      const before=calls.length;
      advance(expected*1000-1);
      assert.equal((await codeOf(()=>proxy.symbols({}))).code,'MARKET_SYMBOLS_UNAVAILABLE');
      assert.equal(calls.length,before,'no fetch inside the backoff of '+expected);waits.push(expected);
      advance(1);
    }
    failing=false;
    assert.equal((await proxy.symbols({})).stale,false);
    assert.deepEqual(waits,[60,120,240,480,600,600]);
  });
  it('a caller waiting on an in-flight list load gets the same MARKET_SYMBOLS_UNAVAILABLE as the first caller, never a raw upstream code',async()=>{
    const {proxy}=setup({handler:()=>reply(SECRET,{status:400})});
    const [first,second]=await Promise.all([codeOf(()=>proxy.symbols({})),codeOf(()=>proxy.symbols({}))]);
    for(const error of [first,second]){assert.equal(error.code,'MARKET_SYMBOLS_UNAVAILABLE');assert.equal(error.status,503);}
    const klines=await Promise.all([codeOf(()=>ask(proxy,{symbol:'ETHUSDT'})),codeOf(()=>ask(proxy,{symbol:'ETHUSDT',actorId:'user-2'}))]);
    for(const error of klines)assert.notEqual(error.code,'MARKET_UPSTREAM_REJECTED');
  });
  it('a klines HTTP 400 removes a listed symbol until the next list refresh',async()=>{
    let reject=true;
    const {proxy,calls,advance}=setup({handler:url=>reject&&url.includes('symbol=ETHUSDT')&&url.includes(KLINES_PATH)?reply(SECRET,{status:400}):undefined});
    const first=await codeOf(()=>ask(proxy,{symbol:'ETHUSDT'}));
    assert.equal(first.code,'MARKET_SYMBOL_NOT_ALLOWED');assert.equal(first.status,400);
    const before=calls.length;
    assert.equal((await codeOf(()=>ask(proxy,{symbol:'ETHUSDT'}))).code,'MARKET_SYMBOL_NOT_ALLOWED');assert.equal(calls.length,before,'refused without a fetch');
    reject=false;advance(6*3600*1000+1);
    assert.equal((await ask(proxy,{symbol:'ETHUSDT'})).stale,false,'the refresh restores the symbol');
  });
});

describe('klines validation',()=>{
  const M=3600000,now=T0;
  const rows=(count=3,ms=M)=>klineRows(now,ms,count);
  const parse=(json,over={})=>parseKlines(json,{intervalMs:M,limit:100,now,...over});
  const bad=(json,over)=>assert.equal(syncCode(()=>parse(json,over))?.code,'MARKET_UPSTREAM_INVALID');
  it('normalizes a valid payload: exact decimals, ascending, forming flag on the open bar',()=>{
    const bars=parse(rows(3));
    assert.equal(bars.length,3);
    assert.deepEqual(bars[0],{time:Math.floor(now/M)*M-2*M,open:'100.5',high:'101.5',low:'99.5',close:'100.75',volume:'12.5',complete:true,forming:false,minutes:null});
    assert.equal(bars[2].forming,true);assert.equal(bars[2].complete,false);assert.equal(bars[1].forming,false);
    assert.deepEqual(parse([]),[]);
    const exactBar=parseKlines([[0,'1.00000000','2.50000000','0.50000000','1.50000000','0.00000000',M-1]],{intervalMs:M,limit:5,now:M*5});
    assert.deepEqual([exactBar[0].open,exactBar[0].high,exactBar[0].low,exactBar[0].volume],['1','2.5','0.5','0']);
  });
  it('forming flag: a bar whose close time reaches now is forming, an earlier one is complete',()=>{
    const open=Math.floor(now/M)*M;
    const row=[open,'1','2','1','2','1',open+M-1];
    assert.equal(parseKlines([row],{intervalMs:M,limit:1,now:open+M-1}).at(0).forming,true);
    assert.equal(parseKlines([row],{intervalMs:M,limit:1,now:open+M}).at(0).forming,false);
  });
  it('rejects the whole payload on any defect',()=>{
    const r=rows(3);
    const mutate=(index,field,value)=>r.map((row,i)=>i===index?row.map((cell,j)=>j===field?value:cell):row);
    bad(mutate(1,6,r[1][0]+M));                       // duration mismatch
    bad(mutate(1,6,r[1][0]+M-2));                     // duration mismatch (short)
    bad(mutate(1,0,r[1][0]+1));                       // misaligned open
    bad([r[0],r[0],r[2]]);                            // duplicate open
    bad([r[1],r[0],r[2]]);                            // descending
    for(const text of ['1e5','abc','-1','','1.','.5',' 1',null,5,{}])bad(mutate(0,1,text));
    bad(mutate(0,2,'99'));                            // high below open
    bad(mutate(0,3,'102'));                           // low above high
    bad(mutate(0,3,'0'));                             // low zero
    bad(mutate(0,5,'-1'));                            // negative volume
    bad(mutate(0,0,1.5));bad(mutate(0,6,'x'));        // non integer times
    bad(r.map(row=>row.slice(0,6)));                  // short rows
    bad([null,r[1]]);bad(['x']);
    bad(rows(3),{limit:2});                           // too many rows
    for(const payload of [{},null,'x',5,undefined,{symbols:[]}])bad(payload);
  });
  it('calendar-anchored 3d and 1w bars are checked only for a monotonic open and close after open',()=>{
    const week=7*24*M,day3=3*24*M;
    for(const ms of [week,day3]){
      const open=1759708800000,rowsA=[[open,'1','2','1','2','1',open+ms-1],[open+ms,'1','2','1','2','1',open+2*ms-1]];
      assert.equal(parseKlines(rowsA,{intervalMs:ms,limit:5,now}).length,2);
      assert.equal(parseKlines([[open+12345,'1','2','1','2','1',open+12345+ms-1]],{intervalMs:ms,limit:5,now}).length,1,'no epoch alignment for '+ms);
      assert.equal(syncCode(()=>parseKlines([[open+ms,'1','2','1','2','1',open+ms-1]],{intervalMs:ms,limit:5,now})).code,'MARKET_UPSTREAM_INVALID');
      assert.equal(syncCode(()=>parseKlines([rowsA[1],rowsA[0]],{intervalMs:ms,limit:5,now})).code,'MARKET_UPSTREAM_INVALID');
    }
  });
  it('through the proxy: invalid JSON, an object, or a bad row is MARKET_UPSTREAM_INVALID with no cache write and no upstream text',async()=>{
    for(const body of [SECRET+' not json','{"a":1}',JSON.stringify([[1,2,3]]),JSON.stringify(klineRows(T0,M,3).map(row=>row.map((cell,i)=>i===2?'1':cell)))]){
      const {proxy,calls}=setup({handler:()=>reply(body)});
      const error=await codeOf(()=>ask(proxy));
      assert.equal(error.code,'MARKET_UPSTREAM_INVALID');assert.equal(error.status,503);assert.ok(!error.message.includes(SECRET));
      assert.equal(proxy.status().cache_entries,0);assert.equal(calls.length,1);
    }
  });
  it('the result carries bars, the fetch time and the cache age',async()=>{
    const {proxy,advance}=setup();
    const first=await ask(proxy);
    assert.deepEqual([first.fetched_at,first.cache_age_seconds,first.stale,first.bars.length],[T0,0,false,3]);
    advance(20000);
    const second=await ask(proxy);
    assert.deepEqual([second.fetched_at,second.cache_age_seconds,second.stale],[T0,20,false]);
  });
});
describe('cache, dedupe and bounds',()=>{
  it('serves from the cache inside the TTL and fetches again at the TTL, per interval',async()=>{
    for(const [interval,spec] of Object.entries(KLINE_INTERVALS)){
      const {proxy,calls,advance}=setup();
      await ask(proxy,{interval});await ask(proxy,{interval});
      assert.equal(calls.length,1,interval+' hit');
      advance(spec.ttl*1000-1);await ask(proxy,{interval});
      assert.equal(calls.length,1,interval+' still fresh at TTL-1ms');
      advance(1);await ask(proxy,{interval});
      assert.equal(calls.length,2,interval+' miss at TTL');
    }
  });
  it('keys by symbol, interval and limit',async()=>{
    const {proxy,calls}=setup();
    await ask(proxy);await ask(proxy,{limit:101});await ask(proxy,{interval:'4h'});await ask(proxy,{symbol:'ETHUSDT'});
    assert.equal(klinesCalls(calls).length,4);
    await ask(proxy);await ask(proxy,{symbol:'ETHUSDT'});
    assert.equal(klinesCalls(calls).length,4);
  });
  it('evicts least recently used entries beyond the entry bound',async()=>{
    const {proxy,calls}=setup({limits:{cacheEntries:3}});
    for(const limit of [10,11,12])await ask(proxy,{limit});
    await ask(proxy,{limit:10});                      // touch 10: 11 is now the oldest
    await ask(proxy,{limit:13});                      // evicts 11
    assert.equal(proxy.status().cache_entries,3);
    const before=calls.length;
    await ask(proxy,{limit:10});await ask(proxy,{limit:12});await ask(proxy,{limit:13});
    assert.equal(calls.length,before,'10, 12 and 13 stay cached');
    await ask(proxy,{limit:11});
    assert.equal(calls.length,before+1,'11 was evicted');
  });
  it('evicts by serialized size',async()=>{
    const {proxy}=setup({limits:{cacheBytes:900}});
    for(const limit of [10,11,12,13,14])await ask(proxy,{limit});
    const {cache_entries}=proxy.status();
    assert.ok(cache_entries>=1&&cache_entries<5,'bounded: '+cache_entries);
  });
  it('dedupes concurrent callers of one key into one upstream call',async()=>{
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const {proxy,calls}=setup({handler:async()=>{await gate;}});
    const waiting=Array.from({length:50},(_,index)=>ask(proxy,{actorId:'u'+index}));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls.length,1);
    release();
    const results=await Promise.all(waiting);
    assert.equal(calls.length,1);assert.ok(results.every(result=>result.bars.length===3&&result.stale===false));
  });
  it('allows 4 upstream calls in flight, then MARKET_PROXY_BUSY without a fetch',async()=>{
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const {proxy,calls}=setup({handler:async()=>{await gate;}});
    const running=[10,11,12,13].map(limit=>ask(proxy,{limit}));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls.length,4);
    const busy=await codeOf(()=>ask(proxy,{limit:14}));
    assert.equal(busy.code,'MARKET_PROXY_BUSY');assert.equal(busy.status,503);assert.ok(busy.retry_after_seconds>=1);assert.equal(calls.length,4);
    release();await Promise.all(running);
    await ask(proxy,{limit:14});assert.equal(calls.length,5,'a slot is free again');
  });
  it('a stale copy answers when the proxy is busy',async()=>{
    let hold=false,release;const gate=new Promise(resolve=>{release=resolve;});
    const {proxy,advance}=setup({handler:async()=>{if(hold)await gate;}});
    await ask(proxy,{limit:20});
    advance(61000);hold=true;
    const running=[10,11,12,13].map(limit=>ask(proxy,{limit}));
    await new Promise(resolve=>setTimeout(resolve,10));
    const stale=await ask(proxy,{limit:20});
    assert.equal(stale.stale,true);assert.equal(stale.cache_age_seconds,61);
    release();await Promise.all(running);
  });
});

describe('budgets',()=>{
  it('weight bucket: 300 klines calls at weight 2 fit in one minute, the 301st is refused, and the bucket refills',async()=>{
    const {proxy,calls,advance}=setup({limits:{userMissesPerMinute:100000,cacheEntries:1000}});
    for(let limit=1;limit<=300;limit++)await ask(proxy,{limit});
    assert.equal(calls.length,300);
    const refused=await codeOf(()=>ask(proxy,{limit:301}));
    assert.equal(refused.code,'MARKET_PROXY_BUSY');assert.ok(refused.retry_after_seconds>=1);assert.equal(calls.length,300);
    advance(30000);
    for(let limit=302;limit<=451;limit++)await ask(proxy,{limit});
    assert.equal(calls.length,450,'half a minute refills 300 weight = 150 calls');
    assert.equal((await codeOf(()=>ask(proxy,{limit:452}))).code,'MARKET_PROXY_BUSY');
  });
  it('an exchangeInfo call costs 20 weight',async()=>{
    const {proxy,calls}=setup({limits:{userMissesPerMinute:100000,cacheEntries:1000,weightPerMinute:44}});
    await proxy.symbols({});                          // 20 of 44
    await ask(proxy,{limit:5});await ask(proxy,{limit:6});   // 4 more: 24 of 44
    for(let i=0;i<10;i++)await ask(proxy,{limit:20+i});      // 20 more: 44 of 44
    assert.equal(calls.length,13);
    assert.equal((await codeOf(()=>ask(proxy,{limit:99}))).code,'MARKET_PROXY_BUSY');
  });
  it('used-weight guard: a header at 3000 blocks new upstream calls until the next UTC minute and a stale copy answers',async()=>{
    let header=null;
    const {proxy,calls,advance,state}=setup({handler:()=>{
      if(header===null)return undefined;
      return reply(klineRows(state.now,60000,3),{headers:{'x-mbx-used-weight-1m':header}});}});
    await ask(proxy,{interval:'1m',limit:5});
    header='3000';
    advance(11000);                                     // 1m TTL is 10 s: this call fetches and reads the header
    const guarded=await ask(proxy,{interval:'1m',limit:5});
    assert.equal(guarded.stale,false);assert.equal(calls.length,2);
    advance(11000);
    const stale=await ask(proxy,{interval:'1m',limit:5});
    assert.equal(stale.stale,true);assert.equal(calls.length,2,'no new upstream call inside the blocked minute');
    const blocked=await codeOf(()=>ask(proxy,{interval:'1m',limit:6}));
    assert.equal(blocked.code,'MARKET_UPSTREAM_COOLDOWN');assert.ok(blocked.retry_after_seconds>=1&&blocked.retry_after_seconds<=60);
    assert.equal(calls.length,2);
    header='10';advance(60000);
    assert.equal((await ask(proxy,{interval:'1m',limit:6})).stale,false);assert.equal(calls.length,3);
    header='2999';advance(11000);await ask(proxy,{interval:'1m',limit:6});
    advance(11000);assert.equal((await ask(proxy,{interval:'1m',limit:6})).stale,false,'2999 does not block');
  });
  it('per-user: 60 requests per minute with retry_after_seconds, another actor unaffected, window resets',()=>{
    const {proxy,advance}=setup();
    for(let i=0;i<60;i++)assert.deepEqual(proxy.admit('a'),{ok:true});
    const refused=proxy.admit('a');
    assert.equal(refused.ok,false);assert.equal(refused.code,'MARKET_RATE_LIMITED');assert.ok(refused.retry_after_seconds>=1&&refused.retry_after_seconds<=60);
    assert.deepEqual(proxy.admit('b'),{ok:true});
    advance(60000);
    assert.deepEqual(proxy.admit('a'),{ok:true});
    assert.equal(proxy.admit('').ok,false);assert.equal(proxy.admit(undefined).ok,false);
  });
  it('per-user keys are bounded: a full table refuses new actors until windows expire',()=>{
    const {proxy,advance}=setup({limits:{userKeys:2}});
    assert.equal(proxy.admit('a').ok,true);assert.equal(proxy.admit('b').ok,true);
    assert.equal(proxy.admit('c').ok,false);assert.equal(proxy.admit('a').ok,true);
    advance(61000);
    assert.equal(proxy.admit('c').ok,true);
  });
  it('per-user misses: 20 cache misses per minute, then a stale copy or MARKET_RATE_LIMITED; hits are free; another actor is unaffected',async()=>{
    const {proxy,calls,advance}=setup({limits:{cacheEntries:1000}});
    for(let limit=1;limit<=20;limit++)await ask(proxy,{limit,interval:'1m'});
    assert.equal(calls.length,20);
    for(let i=0;i<30;i++)await ask(proxy,{limit:1,interval:'1m'});
    assert.equal(calls.length,20,'cache hits are free');
    const limited=await codeOf(()=>ask(proxy,{limit:21,interval:'1m'}));
    assert.equal(limited.code,'MARKET_RATE_LIMITED');assert.equal(limited.status,429);assert.ok(limited.retry_after_seconds>=1);assert.equal(calls.length,20);
    advance(11000);                                    // key 1 is expired but inside its stale window
    const stale=await ask(proxy,{limit:1,interval:'1m'});
    assert.equal(stale.stale,true);assert.equal(calls.length,20);
    const other=await ask(proxy,{limit:21,interval:'1m',actorId:'user-2'});
    assert.equal(other.stale,false);assert.equal(calls.length,21);
    advance(60000);
    assert.equal((await ask(proxy,{limit:22,interval:'1m'})).stale,false,'the window reset');
  });
});

describe('circuit',()=>{
  const status=code=>reply(SECRET,{status:code});
  it('HTTP 429 with Retry-After 120 opens the circuit 120 s: zero fetches, stale copy served, then it closes',async()=>{
    let mode='ok';
    const {proxy,calls,advance,logs}=setup({handler:()=>mode==='429'?reply(SECRET,{status:429,headers:{'retry-after':'120'}}):undefined});
    await ask(proxy,{interval:'1m'});
    advance(11000);mode='429';
    const stale=await ask(proxy,{interval:'1m'});
    assert.equal(stale.stale,true);assert.equal(calls.length,2);
    const other=await codeOf(()=>ask(proxy,{interval:'1m',limit:50}));
    assert.equal(other.code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(other.retry_after_seconds,120);assert.equal(other.status,503);
    advance(60000);
    const during=await codeOf(()=>ask(proxy,{interval:'1m',limit:50}));
    assert.equal(during.code,'MARKET_UPSTREAM_COOLDOWN');assert.ok(during.retry_after_seconds<=60&&during.retry_after_seconds>=59);
    assert.equal(calls.length,2,'no fetch while the circuit is open');
    assert.equal(proxy.status().circuit,'open');
    advance(60000);mode='ok';
    assert.equal(proxy.status().circuit,'closed');
    assert.equal((await ask(proxy,{interval:'1m',limit:50})).stale,false);assert.equal(calls.length,3);
    assert.ok(logs.some(line=>/circuit open: HTTP_429 120s/.test(line))&&logs.some(line=>/circuit closed/.test(line)));
  });
  it('HTTP 429 without the header opens 60 s; Retry-After above the cap is capped at 3600 s',async()=>{
    const first=setup({handler:()=>status(429)});
    assert.equal((await codeOf(()=>ask(first.proxy))).retry_after_seconds,60);
    const second=setup({handler:()=>reply('x',{status:429,headers:{'retry-after':'99999'}})});
    assert.equal((await codeOf(()=>ask(second.proxy))).retry_after_seconds,3600);
    const third=setup({handler:()=>reply('x',{status:429,headers:{'retry-after':'10'}})});
    assert.equal((await codeOf(()=>ask(third.proxy))).retry_after_seconds,60,'at least 60 s');
  });
  it('HTTP 418 opens at least 600 s and honours a longer Retry-After up to 72 h',async()=>{
    const first=setup({handler:()=>status(418)});
    assert.equal((await codeOf(()=>ask(first.proxy))).retry_after_seconds,600);
    const second=setup({handler:()=>reply('x',{status:418,headers:{'retry-after':'5000'}})});
    assert.equal((await codeOf(()=>ask(second.proxy))).retry_after_seconds,5000);
    const third=setup({handler:()=>reply('x',{status:418,headers:{'retry-after':'99999999'}})});
    assert.equal((await codeOf(()=>ask(third.proxy))).retry_after_seconds,72*3600);
    const retry=await codeOf(()=>ask(first.proxy,{limit:7}));
    assert.equal(retry.code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(first.calls.length,1);
  });
  it('three consecutive 5xx open the circuit 30 s, then 60 s on the next failure; one success resets',async()=>{
    let failing=true;
    const {proxy,calls,advance}=setup({limits:{userMissesPerMinute:1000},handler:()=>failing?status(503):undefined});
    for(const limit of [1,2,3]){
      const error=await codeOf(()=>ask(proxy,{limit}));
      assert.equal(error.code,'MARKET_UPSTREAM_UNAVAILABLE');assert.equal(error.status,503);assert.ok(!error.message.includes(SECRET));
    }
    assert.equal(calls.length,3);
    const open=await codeOf(()=>ask(proxy,{limit:4}));
    assert.equal(open.code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(open.retry_after_seconds,30);assert.equal(calls.length,3);
    advance(30000);
    assert.equal((await codeOf(()=>ask(proxy,{limit:4}))).code,'MARKET_UPSTREAM_UNAVAILABLE');assert.equal(calls.length,4);
    const again=await codeOf(()=>ask(proxy,{limit:5}));
    assert.equal(again.code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(again.retry_after_seconds,60);
    advance(60000);failing=false;
    assert.equal((await ask(proxy,{limit:5})).stale,false);
    failing=true;
    for(const limit of [6,7])assert.equal((await codeOf(()=>ask(proxy,{limit}))).code,'MARKET_UPSTREAM_UNAVAILABLE');
    const before=calls.length;
    assert.equal((await codeOf(()=>ask(proxy,{limit:8}))).code,'MARKET_UPSTREAM_UNAVAILABLE');
    assert.equal(calls.length,before+1,'a success reset the counter: only the third new failure opens again');
    assert.equal((await codeOf(()=>ask(proxy,{limit:9}))).retry_after_seconds,30,'delay restarted at 30 s');
  });
  it('a 4xx other than 429, 418, 403, 451 and 400 is MARKET_UPSTREAM_UNAVAILABLE and does not trip the circuit',async()=>{
    const {proxy,calls}=setup({limits:{userMissesPerMinute:1000},handler:()=>status(404)});
    for(const limit of [1,2,3,4,5])assert.equal((await codeOf(()=>ask(proxy,{limit}))).code,'MARKET_UPSTREAM_UNAVAILABLE');
    assert.equal(calls.length,5);
  });
  it('HTTP 403 and 451 open the circuit at once (60 s floor, Retry-After honoured): zero further fetches, stale copy served',async()=>{
    for(const code of [403,451]){
      let mode='ok';
      const {proxy,calls,advance,logs}=setup({limits:{userMissesPerMinute:1000},handler:()=>mode==='block'?reply(SECRET,{status:code}):undefined});
      await ask(proxy,{interval:'1m'});
      advance(11000);mode='block';
      const stale=await ask(proxy,{interval:'1m'});
      assert.equal(stale.stale,true);assert.equal(calls.length,2,code+' made one upstream hit');
      for(const limit of [2,3,4,5]){
        const error=await codeOf(()=>ask(proxy,{interval:'1m',limit}));
        assert.equal(error.code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(error.status,503);assert.ok(error.retry_after_seconds>=1&&error.retry_after_seconds<=60);assert.ok(!error.message.includes(SECRET));
      }
      assert.equal(calls.length,2,code+': no fetch during the cooldown');
      assert.equal(proxy.status().circuit,'open');
      assert.ok(logs.some(line=>line.includes('circuit open: HTTP_'+code+' 60s')));
      advance(60000);mode='ok';
      assert.equal(proxy.status().circuit,'closed');
      assert.equal((await ask(proxy,{interval:'1m',limit:2})).stale,false);
    }
    const header=setup({handler:()=>reply('x',{status:403,headers:{'retry-after':'900'}})});
    assert.equal((await codeOf(()=>ask(header.proxy))).retry_after_seconds,900);
  });
  it('an open circuit answers before a miss is charged: no stale copy gives the cooldown, not MARKET_RATE_LIMITED',async()=>{
    const {proxy,calls}=setup({limits:{cacheEntries:1000},handler:()=>status(429)});
    assert.equal((await codeOf(()=>ask(proxy,{interval:'1m',limit:1}))).code,'MARKET_UPSTREAM_COOLDOWN');
    for(let limit=2;limit<=30;limit++){
      const error=await codeOf(()=>ask(proxy,{interval:'1m',limit}));
      assert.equal(error.code,'MARKET_UPSTREAM_COOLDOWN');assert.ok(error.retry_after_seconds>=1);
    }
    assert.equal(calls.length,1);
  });
  it('a stale copy answers inside min(3600, max(300, 10 x TTL)) seconds after the fetch and not beyond',async()=>{
    for(const [interval,windowSeconds] of [['1m',300],['1h',600],['4h',1200],['1d',3000],['1w',3600]]){
      let failing=false;
      const {proxy,advance}=setup({handler:()=>failing?status(503):undefined});
      await ask(proxy,{interval});
      failing=true;
      advance(windowSeconds*1000);
      assert.equal((await ask(proxy,{interval})).stale,true,interval+' inside the window');
      advance(1001);
      assert.equal((await codeOf(()=>ask(proxy,{interval}))).code.startsWith('MARKET_'),true,interval+' beyond the window');
    }
  });
});

describe('transport bounds',()=>{
  it('a timeout gives MARKET_UPSTREAM_TIMEOUT and aborts the signal',async()=>{
    let signal;
    const {proxy}=setup({limits:{klinesTimeoutMs:50},handler:(url,init)=>{signal=init.signal;return new Promise(()=>{});}});
    const error=await codeOf(()=>ask(proxy));
    assert.equal(error.code,'MARKET_UPSTREAM_TIMEOUT');assert.equal(error.status,503);assert.equal(signal.aborted,true);
  });
  it('a body that stalls is cut by the same deadline and the reader is cancelled',async()=>{
    let cancelled=false;
    const stalled={ok:true,status:200,headers:{get:()=>null},body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{cancelled=true;}})}};
    const {proxy}=setup({limits:{klinesTimeoutMs:50},handler:()=>stalled});
    assert.equal((await codeOf(()=>ask(proxy))).code,'MARKET_UPSTREAM_TIMEOUT');assert.equal(cancelled,true);
  });
  it('the call deadline caps the timeout and a spent deadline is a timeout without a fetch',async()=>{
    const {proxy,calls,state}=setup({handler:()=>new Promise(()=>{})});
    assert.equal((await codeOf(()=>ask(proxy,{deadline:state.now-1}))).code,'MARKET_UPSTREAM_TIMEOUT');assert.equal(calls.length,0);
    const started=Date.now();
    assert.equal((await codeOf(()=>ask(proxy,{deadline:state.now+40}))).code,'MARKET_UPSTREAM_TIMEOUT');
    assert.ok(Date.now()-started<1500,'cut at about 40 ms, not the 4 s own timeout');
  });
  it('a content-length above the cap and streamed bytes above the cap give MARKET_UPSTREAM_TOO_LARGE',async()=>{
    let cancelled=false;
    const sized={ok:true,status:200,headers:{get:name=>name==='content-length'?'2000000':null},body:{getReader:()=>({read:async()=>{throw new Error('must not read');},cancel:async()=>{cancelled=true;}})}};
    const first=setup({handler:()=>sized});
    const error=await codeOf(()=>ask(first.proxy));
    assert.equal(error.code,'MARKET_UPSTREAM_TOO_LARGE');assert.equal(error.status,503);
    const streamed=setup({limits:{klinesMaxBytes:200},handler:()=>reply(JSON.stringify(klineRows(T0,3600000,3)))});
    assert.equal((await codeOf(()=>ask(streamed.proxy))).code,'MARKET_UPSTREAM_TOO_LARGE');
    const info=setup({limits:{exchangeInfoMaxBytes:500}});
    assert.equal((await codeOf(()=>info.proxy.symbols({}))).code,'MARKET_SYMBOLS_UNAVAILABLE');
    assert.equal(cancelled,false,'a header-only rejection never creates a reader');
  });
  it('a network error is MARKET_UPSTREAM_UNAVAILABLE and counts toward the circuit',async()=>{
    const {proxy,calls}=setup({limits:{userMissesPerMinute:1000},handler:()=>{throw new Error('connect ECONNREFUSED https://api.binance.com '+SECRET);}});
    for(const limit of [1,2,3]){
      const error=await codeOf(()=>ask(proxy,{limit}));
      assert.equal(error.code,'MARKET_UPSTREAM_UNAVAILABLE');assert.ok(!error.message.includes(SECRET)&&!error.message.includes('binance'));
    }
    assert.equal((await codeOf(()=>ask(proxy,{limit:4}))).code,'MARKET_UPSTREAM_COOLDOWN');assert.equal(calls.length,3);
  });
  it('errors, results, status and log lines never contain a URL, host, Retry-After text or upstream body text',async()=>{
    const collected=[];
    const scenarios=[()=>reply(SECRET,{status:429,headers:{'retry-after':'7'}}),()=>reply(SECRET,{status:500}),()=>reply(SECRET),()=>{throw new Error(SECRET);}];
    for(const handler of scenarios){
      const {proxy,logs}=setup({handler});
      const error=await codeOf(()=>ask(proxy));
      collected.push(JSON.stringify({code:error.code,message:error.message,status:error.status,retry:error.retry_after_seconds}),...logs,JSON.stringify(proxy.status()));
    }
    const {proxy}=setup();
    collected.push(JSON.stringify(await ask(proxy)),JSON.stringify(proxy.status()),JSON.stringify((await proxy.symbols({})).list.slice(0,3)));
    for(const text of collected)for(const banned of ['http','binance.com','Retry-After','retry-after',SECRET])assert.ok(!text.includes(banned),banned+' in '+text.slice(0,120));
  });
  it('status() is diagnostics only',async()=>{
    const {proxy}=setup();
    assert.deepEqual(proxy.status(),{enabled:true,circuit:'closed',cooldown_until:null,symbols_count:0,cache_entries:0});
    await proxy.symbols({});await ask(proxy);
    assert.deepEqual(proxy.status(),{enabled:true,circuit:'closed',cooldown_until:null,symbols_count:62,cache_entries:1});
  });
});
});