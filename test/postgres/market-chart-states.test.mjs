import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {JSDOM} from 'jsdom';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {Money} from '../../src/money.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

// PM-1 row F04-02 gap round 3, server side: the chart states over the real application, auth and SERIALIZABLE response buffering.
// Isolated local PostgreSQL only. The page under test is the real public/index.html with the real public/app.js api() helper and the real
// public/interactive-chart.js; its fetch is bridged to the actual HTTP server of the fixture, so the answer body that shapes each state is the
// real route body. The REST path runs only against a loopback fake upstream (MARKET_PROXY_TEST_ORIGIN, accepted only under NODE_ENV=test).
// Clauses: STALE_AFTER_SECONDS=180 (src/postgres/market-ohlcv.js l.43; stored answer stale when age_seconds > 180, stale_reason STORED_AGE);
// per-user 60 requests a minute gives 429 MARKET_RATE_LIMITED (market-proxy.js admit, l.205-209; docs/ROADMAP.md MD-1 "limited or stale
// states"); the global per-source limit is 240 requests a minute and answers 429 {error:'Request limit reached'} without a code
// (src/postgres/request-limits.js API_LIMIT; src/postgres/request-dispatch.js l.75). Label texts are pinned from public/interactive-chart.js.
const MINUTE=60000,HOUR=60*MINUTE,DAY=24*HOUR;
const OHLCV='/api/market/ohlcv',SYMBOLS='/api/market/symbols';
const STORED='binance-spot-public-stored',REST='binance-spot-public-rest';
const RETRY_TEXT='Too many chart requests; retrying in 60 s';
const publicFile=name=>fs.readFileSync(new URL('../../public/'+name,import.meta.url),'utf8');

// MARKET_PUBLIC_PROXY is always set explicitly so an inherited value never changes a case.
async function fixture(t,environment={MARKET_PUBLIC_PROXY:'0'}){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment});t.after(()=>f.close());return f;
}
const priceOf=index=>{
  const open=new Money(60000).plus(index%97).plus((index%100)/100);
  return {open:open.toFixed(8),high:open.plus((index%7+1)/4).toFixed(8),low:open.minus((index%5+1)/4).toFixed(8),
    close:open.plus(((index%11)-5)/10).toFixed(8),volume:new Money((index%13)+1).div(8).toFixed(8)};
};
/** 48 hours of gap-free 1m bars; the latest stored row (bar_time = its close time) is `ageMinutes` whole minutes before the current minute. */
async function seedBars(db,ageMinutes){
  const end=Math.floor(Date.now()/MINUTE)*MINUTE-ageMinutes*MINUTE,start=Math.floor((end-48*HOUR)/HOUR)*HOUR,count=(end-start)/MINUTE;
  const times=[],bars=[],hashes=[],provenance=JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'});
  for(let index=0;index<count;index++){
    const time=start+(index+1)*MINUTE,bar={time,...priceOf(index),atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
    times.push(time);bars.push(JSON.stringify(bar));hashes.push(hash(canonical(bar)));
  }
  await db.query("INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',x.t,x.b::jsonb,$1::jsonb,x.h FROM unnest($2::bigint[],$3::text[],$4::text[]) AS x(t,b,h)",
    [provenance,times,bars,hashes]);
  return end;
}

// Loopback fake of the two public Binance paths used here (same behaviour as test/postgres/market-ohlcv-http.test.mjs).
const INTERVAL_MS={'1m':MINUTE,'1h':HOUR,'1d':DAY};
async function upstream(t){
  const state={klines:[]};
  const symbols=[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',tick:'0.01000000'},{symbol:'ETHUSDT',baseAsset:'ETH',quoteAsset:'USDT',tick:'0.01000000'}];
  // The proxy refuses a short symbol list as unusable, so the fake lists 62 symbols like the fake of market-ohlcv-http.test.mjs.
  for(let index=0;index<60;index++)symbols.push({symbol:`T${String(index).padStart(4,'0')}USDT`,baseAsset:`T${String(index).padStart(4,'0')}`,quoteAsset:'USDT',tick:'0.00100000'});
  const exchangeBody=JSON.stringify({symbols:symbols.map(item=>({symbol:item.symbol,status:'TRADING',baseAsset:item.baseAsset,quoteAsset:item.quoteAsset,
    isSpotTradingAllowed:true,filters:[{filterType:'PRICE_FILTER',tickSize:item.tick}]}))});
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1'),query=Object.fromEntries(url.searchParams);
    if(url.pathname==='/api/v3/exchangeInfo'){res.writeHead(200,{'content-type':'application/json'});res.end(exchangeBody);return;}
    if(url.pathname==='/api/v3/klines'){
      state.klines.push(query);
      const ms=INTERVAL_MS[query.interval],limit=Number(query.limit),lastOpen=Math.floor(Date.now()/ms)*ms,rows=[];
      for(let index=0;index<limit;index++){
        const open=lastOpen-(limit-1-index)*ms,base=2000+index;
        rows.push([open,base.toFixed(2),(base+2).toFixed(2),(base-2).toFixed(2),(base+1).toFixed(2),'10.5',open+ms-1,'0',1,'0','0','0']);
      }
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(rows));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {state,origin:'http://127.0.0.1:'+server.address().port};
}

/**
 * The real Overview page for the fixture's owner. api() is the real helper cut out of public/app.js; its fetch goes to the real server, and
 * the answers (status, body) are recorded in `seen`. The 5 s scheduler and the page clock are driven by hand: Date.now is a manual clock (skew.ms, starts at real time) so waits are exact.
 */
function openPage(f,owner,{prefs}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document;
  if(prefs!==undefined)w.localStorage.setItem('robotMarketChart.v1',JSON.stringify(prefs));
  w.eval(publicFile('i18n.js'));
  const skew={ms:Date.now()},timer={},seen=[];
  w.Date.now=()=>skew.ms;
  w.setInterval=(fn,ms)=>{timer.fn=fn;timer.ms=ms;return 1;};
  w.fetch=async path=>{
    const answer=await f.request(path,'GET',undefined,owner);
    seen.push({path,status:answer.status,body:answer.body});
    return {ok:answer.status>=200&&answer.status<300,status:answer.status,json:async()=>answer.body};
  };
  const source=publicFile('app.js'),start=source.indexOf('async function api('),end=source.indexOf('\nasync function login(');
  assert.ok(start>=0&&end>start,'api() found in public/app.js');
  w.eval("var csrfToken='',selectedBot='';");
  w.eval(source.slice(start,end));
  w.eval(publicFile('chart-indicators.js'));
  w.eval(publicFile('interactive-chart.js'));
  d.querySelector('#app').hidden=false;
  const q=selector=>d.querySelector(selector);
  const p={dom,w,q,seen,skew,timer,svg:q('#marketChartSvg'),status:q('#marketChartStatus'),meta:q('#marketChartMeta'),badge:q('#marketChartSource'),
    state:()=>q('#interactiveChart').dataset.state,
    candles:()=>p.svg.querySelectorAll('g.mc-bar').length,
    chart:()=>seen.filter(item=>item.path.startsWith(OHLCV+'?')),
    // One scheduler tick, then wait for the chart read it started (all reads of the real server are real HTTP, so wait on the condition).
    tick:async(advanceMs=0)=>{
      skew.ms+=advanceMs;const before=seen.length;timer.fn();
      for(let i=0;i<400&&seen.length<=before;i++)await delay(10);
      await p.settled();
    },
    // A scheduler tick that must not start a chart read (still waiting): no wait for traffic.
    quiet:async advanceMs=>{skew.ms+=advanceMs;timer.fn();await delay(150);},
    settled:async()=>{for(let i=0;i<400&&q('#interactiveChart').dataset.state==='loading';i++)await delay(10);await delay(50);}
  };
  return p;
}
async function withPage(f,owner,options,body){const p=openPage(f,owner,options);try{await body(p);}finally{p.w.close();}}

// ---- U3: a stale stored answer through the HTTP route ------------------------------------------------------------------------

test('U3: stored answer older than 180 s is stale over HTTP (stale_reason STORED_AGE) and the chart shows the stale state; a fresh one is ready',async t=>{
  // Stale: latest closed bar is 10 minutes old.
  const f=await fixture(t),owner=await f.login(f.owner);
  const end=await seedBars(f.db,10);
  const answer=await f.request(OHLCV+'?interval=1m&limit=5&source=stored','GET',undefined,owner);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.equal(body.version,'market-ohlcv-v2');assert.equal(body.source,STORED);assert.equal(body.status,'OK');assert.equal(body.closed_only,true);
  assert.equal(body.stale,true);assert.equal(body.stale_reason,'STORED_AGE');assert.equal(body.stale_after_seconds,180);assert.equal(body.fallback,null);
  assert.ok(body.age_seconds>180,'age '+body.age_seconds);assert.ok(body.age_seconds>=600&&body.age_seconds<720,'10 minutes old: '+body.age_seconds);
  assert.equal(body.latest_closed_bar.close_time,end);assert.equal(body.bars.length,5);
  // The same stale data through the default (auto) request the chart makes: BTCUSDT 1d with the proxy off is the labelled stored fallback.
  const auto=await f.request(OHLCV+'?interval=1h&limit=24','GET',undefined,owner);
  assert.equal(auto.status,200,JSON.stringify(auto.body));
  assert.equal(auto.body.source,STORED);assert.deepEqual(auto.body.fallback,{from:REST,reason:'MARKET_PROXY_DISABLED'});
  assert.equal(auto.body.stale,true);assert.equal(auto.body.stale_reason,'STORED_AGE');
  // The chart (default BTCUSDT 1d) draws the stored bars and shows the stale state with the server age and the 180 s limit.
  await withPage(f,owner,{},async p=>{
    await p.tick();
    const reply=p.chart()[0];
    assert.equal(reply.path,OHLCV+'?symbol=BTCUSDT&interval=1d&limit=1000');assert.equal(reply.status,200);
    assert.equal(reply.body.source,STORED);assert.equal(reply.body.stale,true);assert.equal(reply.body.stale_reason,'STORED_AGE');
    assert.equal(p.state(),'stale');
    assert.equal(p.status.textContent,`Stale: latest closed bar is ${reply.body.age_seconds} s old (limit 180 s)`);
    assert.ok(reply.body.age_seconds>180);
    assert.ok(p.candles()>0&&p.candles()===reply.body.bars.length,'the stale candles stay on screen: '+p.candles());
  });
  // Fresh control (1 minute old, 60 s to 119 s): not stale, state ready, no stale_reason.
  const g=await fixture(t),guest=await g.login(g.owner);
  await seedBars(g.db,1);
  const fresh=await g.request(OHLCV+'?interval=1m&limit=5&source=stored','GET',undefined,guest);
  assert.equal(fresh.status,200,JSON.stringify(fresh.body));
  assert.equal(fresh.body.stale,false);assert.equal(fresh.body.stale_reason,null);assert.ok(fresh.body.age_seconds>=60&&fresh.body.age_seconds<=180,'age '+fresh.body.age_seconds);
  await withPage(g,guest,{},async p=>{
    await p.tick();
    assert.equal(p.chart()[0].body.stale,false);assert.equal(p.state(),'ready');
    assert.match(p.status.textContent,new RegExp(`^Latest closed bar \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC · age ${p.chart()[0].body.age_seconds} s$`));
    assert.ok(!p.status.textContent.startsWith('Stale'));assert.ok(p.candles()>0);
  });
});

// ---- U2: HTTP 429 of the global request limiter, real server ----------------------------------------------------------------

test('U2: the global request limiter answers 429 {error} without a code after 240 requests a minute, and the chart shows the limited state',async t=>{
  const f=await fixture(t),owner=await f.login(f.owner);
  let refused=null,sent=0;
  for(;sent<300&&refused===null;sent++){
    const answer=await f.request(OHLCV+'?interval=1m&limit=1&source=stored','GET',undefined,owner);
    if(answer.status===429)refused=answer;
    else assert.notEqual(answer.status,500,JSON.stringify(answer.body));
  }
  assert.ok(refused!==null,'the limiter refused within 300 requests');
  assert.deepEqual(refused.body,{error:'Request limit reached'},'no code in the body: the chart sees HTTP_429');
  assert.ok(sent>=200&&sent<=241,'about 240 allowed requests a minute, refused at request '+sent);
  await withPage(f,owner,{},async p=>{
    await p.tick();
    assert.ok(p.chart().length>=1&&p.chart().every(item=>item.status===429&&item.body.code===undefined),'the page read was refused with a code-less 429');
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,RETRY_TEXT);assert.equal(p.candles(),0);
    const reads=p.chart().length;
    await p.quiet(59000);assert.equal(p.chart().length,reads,'fixed 60 s wait');
    await p.tick(2000);assert.equal(p.chart().length,reads+1,'retried after 60 s');assert.equal(p.state(),'limited');
  });
});

// ---- C8 and U1: per-user MARKET_RATE_LIMITED, real server, candles already shown --------------------------------------------

test('C8/U1: after 60 market requests a minute the route answers 429 MARKET_RATE_LIMITED; a chart that shows candles keeps them and is limited with a 60 s back-off',async t=>{
  const up=await upstream(t),f=await fixture(t,{MARKET_PUBLIC_PROXY:'1',MARKET_PROXY_TEST_ORIGIN:up.origin}),owner=await f.login(f.owner);
  await withPage(f,owner,{prefs:{symbol:'ETHUSDT',interval:'1d'}},async p=>{
    await p.tick();
    const first=p.chart()[0];
    assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.source,REST);assert.equal(first.body.symbol,'ETHUSDT');
    assert.equal(p.state(),'ready');const shown=p.candles();assert.ok(shown>0);
    const admitted=p.seen.filter(item=>item.path.startsWith(OHLCV)||item.path===SYMBOLS).length;
    assert.equal(admitted,2,'the page spent two of the 60 per-user slots: the chart read and the symbol list');
    // Spend the rest of the per-user minute with cached ETHUSDT 1d reads.
    let limited=null,ok=0;
    for(let index=0;index<80&&limited===null;index++){
      const answer=await f.request(OHLCV+'?symbol=ETHUSDT&interval=1d&limit=5','GET',undefined,owner);
      if(answer.status===429)limited=answer;else{assert.equal(answer.status,200,JSON.stringify(answer.body));ok++;}
    }
    assert.ok(limited!==null,'refused within 80 requests');
    assert.equal(ok,58,'60 slots a minute, 2 already spent by the page');
    assert.equal(limited.body.code,'MARKET_RATE_LIMITED');assert.equal(limited.body.error,'Too many market requests');
    assert.ok(Number.isInteger(limited.body.retry_after_seconds)&&limited.body.retry_after_seconds>=1&&limited.body.retry_after_seconds<=60,JSON.stringify(limited.body));
    assert.ok(!JSON.stringify(limited.body).includes('127.0.0.1'),'no upstream text');
    // The scheduled refresh of the 1d chart (300 s poll) is refused by the route: limited, candles kept, then a 60 s back-off.
    await p.tick(301000);
    const refusal=p.chart().at(-1);
    assert.equal(refusal.status,429);assert.equal(refusal.body.code,'MARKET_RATE_LIMITED');
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,RETRY_TEXT);
    assert.equal(p.candles(),shown,'the candles stay on screen');
    const reads=p.chart().length;
    await p.quiet(59000);assert.equal(p.chart().length,reads,'60 s wait: nothing at 59 s');
    await p.tick(2000);assert.equal(p.chart().length,reads+1,'retried after 60 s');
  });
});
