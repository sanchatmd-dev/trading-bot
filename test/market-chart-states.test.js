import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

// PM-1 row F04-02 gap round 3: the LIMITED and STALE states of the Overview chart (public/interactive-chart.js), asserted decisively.
// Clauses (docs/ROADMAP.md MD-1: the proxy "degrades charts to limited or stale states"; the per-user limits are 60 requests and
// 20 cache misses a minute; the stored answer is stale after 180 s, STALE_AFTER_SECONDS in src/postgres/market-ohlcv.js). The docs
// fix no label text, so the code strings below are pinned from public/interactive-chart.js and public/i18n.js:
//   retry text   "Too many chart requests; retrying in {seconds} s"   (retryText, ~l.454; seconds = retryIn / 1000)
//   limited      limited(code): MARKET_RATE_LIMITED or HTTP_429          (l.82)
//   back-off     limited code waits a fixed 60 s, never doubled          (backoff, ~l.478)
//   state        render(): error present gives limited (candles kept) or stale (~l.473)
// jsdom page with stubbed reads; no browser, no network, no database.
const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
const T0=Date.parse('2026-10-04T05:00:00Z'),HOUR=3600000;
const RETRY_TEXT='Too many chart requests; retrying in 60 s';
const OHLCV_1D='/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000';

const bar=(time,over={})=>({time,open:'100.5',high:'110',low:'90.25',close:'105',volume:'3.5',minutes:60,complete:true,...over});
const bars=(count,over=()=>({}))=>Array.from({length:count},(_,index)=>bar(T0-(count-index)*HOUR,over(index)));
const payload=(list,over={})=>({version:'market-ohlcv-v2',source:'binance-spot-public-stored',symbol:'BTCUSDT',interval:'1h',bars:list,
  status:list.length?'OK':'EMPTY',closed_only:true,stale:false,stale_reason:null,stale_after_seconds:180,fallback:null,history_partial:false,
  age_seconds:12,latest_closed_bar:{open_time:T0,close_time:T0+60000},generated_at:new Date(T0+72000).toISOString(),
  gaps:{count:0,missing_minutes:0,ranges:[],truncated:false},...over});
const rest=(list,over={})=>payload(list,{source:'binance-spot-public-rest',closed_only:false,interval:'1d',cache_age_seconds:7,age_seconds:null,
  latest_closed_bar:null,stale_after_seconds:null,gaps:null,price_tick:'0.01',...over});
const levelsBody=positions=>({version:'position-levels-v1',generated_at:new Date(T0).toISOString(),scope:'bot',truncated:false,positions});
const symbolsBody=()=>({version:'market-symbols-v1',source:'binance-spot-public-rest',generated_at:new Date(T0).toISOString(),
  retrieved_at:new Date(T0).toISOString(),stale:false,count:1,symbols:[['BTCUSDT','BTC','USDT','0.01']]});
const apiError=(code,status)=>Object.assign(new Error(code||'Request failed'),{code,status});

/** One jsdom page with the chart script; the 5 s scheduler and Date.now of this window are driven by hand (same method as market-chart-ui.test.js). */
function setup({ohlcv,prefs}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document;
  if(prefs!==undefined)w.localStorage.setItem('robotMarketChart.v1',JSON.stringify(prefs));
  w.eval(publicFile('i18n.js'));
  const calls=[],clock={now:T0},timer={};
  w.Date.now=()=>clock.now;
  w.setInterval=(fn,ms)=>{timer.fn=fn;timer.ms=ms;return 1;};
  w.fetch=()=>{throw new Error('direct network access is forbidden');};
  w.api=async(path,options)=>{
    calls.push({path,options});
    if(path.startsWith('/api/market/ohlcv?'))return typeof ohlcv==='function'?ohlcv(path,options):structuredClone(ohlcv);
    if(path==='/api/market/symbols')return symbolsBody();
    if(path==='/api/positions/levels')return levelsBody([]);
    throw new Error('Unexpected '+path);
  };
  w.eval(publicFile('chart-indicators.js'));
  w.eval(publicFile('interactive-chart.js'));
  d.querySelector('#app').hidden=false;
  const q=selector=>d.querySelector(selector);
  const p={dom,w,d,calls,clock,timer,q,svg:q('#marketChartSvg'),status:q('#marketChartStatus'),meta:q('#marketChartMeta'),badge:q('#marketChartSource'),
    state:()=>q('#interactiveChart').dataset.state,
    chartPaths:()=>calls.map(call=>call.path).filter(path=>path.startsWith('/api/market/ohlcv?')),
    candles:()=>p.svg.querySelectorAll('g.mc-bar').length,
    tick:async(advance=0)=>{clock.now+=advance;timer.fn();await settle();}};
  return p;
}
const withPage=async(options,body)=>{const p=setup(options);try{await body(p);}finally{p.w.close();}};

/**
 * Replaces the stubbed api() of the page with the real api() of public/app.js, cut out of the served file, over a stubbed fetch.
 * The real helper turns a refused HTTP answer into Error{status,code:body.code}; this is what the chart sees in production.
 */
function useRealApi(p,answerFor){
  const source=publicFile('app.js'),start=source.indexOf('async function api('),end=source.indexOf('\nasync function login(');
  assert.ok(start>=0&&end>start,'api() found in public/app.js');
  p.w.eval("var csrfToken='',selectedBot='';");
  p.w.eval(source.slice(start,end));
  assert.equal(p.w.api.toString().includes('d.code'),true,'the real helper is in place');
  const fetched=[];
  p.w.fetch=async path=>{
    fetched.push(path);
    if(path==='/api/market/symbols')return {ok:true,status:200,json:async()=>symbolsBody()};
    if(path==='/api/positions/levels')return {ok:true,status:200,json:async()=>levelsBody([])};
    return answerFor(path);
  };
  return fetched;
}
const refused=(status,body)=>({ok:false,status,json:async()=>structuredClone(body)});
const accepted=body=>({ok:true,status:200,json:async()=>structuredClone(body)});

/**
 * After the first limited answer: the retry waits a fixed 60 s (not the doubling of other codes) and a second limited answer keeps it at 60 s.
 * `count` is the number of chart reads so far, `p` has just shown the limited state at the current clock.
 */
async function assertFixedSixtySecondBackoff(p,count,label){
  assert.equal(p.chartPaths().length,count,label+' reads so far');
  await p.tick(59000);assert.equal(p.chartPaths().length,count,label+': 59 s later still waiting');
  await p.tick(2000);assert.equal(p.chartPaths().length,count+1,label+': retried after 60 s');
  assert.equal(p.state(),'limited',label+': still limited after the second refusal');assert.equal(p.status.textContent,RETRY_TEXT,label+': text stays 60 s');
  await p.tick(59000);assert.equal(p.chartPaths().length,count+1,label+': second wait is 60 s too, not doubled to 120 s');
  await p.tick(2000);assert.equal(p.chartPaths().length,count+2,label+': second retry after 60 s');
}

// ---- U1 and C8: limited state, with and without candles ---------------------------------------------------------------------

test('U1: a rate-limit refusal while candles are shown keeps the candles and shows the limited state with the retry text, for stored and REST data',async()=>{
  const variants=[['stored',()=>payload(bars(3),{interval:'1m'}),'3 bars · 1m · generated 2026-10-04 05:01 UTC'],
    ['REST',()=>rest(bars(3,()=>({minutes:null})),{interval:'1m'}),'3 bars · 1m · generated 2026-10-04 05:01 UTC']];
  for(const [name,answer,meta] of variants){
    for(const code of ['MARKET_RATE_LIMITED','HTTP_429']){
      let refuse=false;
      await withPage({prefs:{symbol:'BTCUSDT',interval:'1m'},ohlcv:()=>{
        if(refuse)throw code==='HTTP_429'?apiError(undefined,429):apiError('MARKET_RATE_LIMITED',429);
        return answer();
      }},async p=>{
        await p.tick();
        assert.equal(p.state(),'ready',name+' '+code+': first answer');assert.equal(p.candles(),3);
        refuse=true;await p.tick(16000);
        assert.equal(p.chartPaths().length,2,name+' '+code+': the 15 s poll of a 1m chart ran');
        assert.equal(p.state(),'limited',name+' '+code+': limited, not stale and not unavailable');
        assert.equal(p.status.textContent,RETRY_TEXT);
        assert.equal(p.candles(),3,name+' '+code+': the candles stay on screen');
        assert.equal(p.meta.textContent,meta,name+' '+code+': the meta line stays');
        assert.ok(p.badge.textContent!=='','the source badge is not blanked while candles stay');
        assert.ok(!p.status.textContent.includes('unavailable'));
        // Recovery: the next answer clears the limited state again.
        refuse=false;await p.tick(61000);
        assert.equal(p.state(),'ready',name+' '+code+': ready again after the 60 s wait');assert.equal(p.status.textContent.includes('Too many'),false);
        assert.equal(p.candles(),3);
      });
    }
  }
});

test('C8: MARKET_RATE_LIMITED gives the limited state, the retry text and a fixed 60 s back-off, with and without candles',async()=>{
  // No candles (first read refused).
  await withPage({ohlcv:()=>{throw apiError('MARKET_RATE_LIMITED',429);}},async p=>{
    await p.tick();
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,RETRY_TEXT);assert.equal(p.candles(),0);assert.equal(p.svg.childNodes.length,0);
    await assertFixedSixtySecondBackoff(p,1,'no candles');
  });
  // Candles shown, 1d chart: the refusal on a 300 s poll still schedules the retry 60 s later (not 300 s, not 600 s).
  let refuse=false;
  await withPage({ohlcv:()=>{if(refuse)throw apiError('MARKET_RATE_LIMITED',429);return rest(bars(4,()=>({minutes:null})));}},async p=>{
    await p.tick();assert.equal(p.state(),'ready');
    refuse=true;await p.tick(301000);
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,RETRY_TEXT);assert.equal(p.candles(),4);
    await assertFixedSixtySecondBackoff(p,2,'candles shown');
  });
  // The retry text is the translated one in Thai as well.
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only',pretendToBeVisual:true});
  try{
    dom.window.localStorage.setItem('robotLanguage','th');dom.window.eval(publicFile('i18n.js'));
    assert.equal(dom.window.translate('Too many chart requests; retrying in {seconds} s'),'คำขอกราฟมากเกินไป จะลองใหม่ใน {seconds} วินาที');
  }finally{dom.window.close();}
});

// ---- U2: HTTP_429 of the global request limiter -----------------------------------------------------------------------------

test('U2: HTTP 429 from the global request limiter (body without a code) is the limited state, over the real api() helper of app.js',async()=>{
  // src/postgres/request-dispatch.js l.75 and src/server.js l.266 answer 429 with exactly this body.
  const limiter=refused(429,{error:'Request limit reached'});
  // Mapping of the real helper: no body code, status 429.
  await withPage({},async p=>{
    useRealApi(p,()=>limiter);
    await assert.rejects(()=>p.w.api('/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000',{silent:true}),error=>error.status===429&&error.code===undefined&&error.message==='Request limit reached');
  });
  // First read refused: no candles.
  await withPage({},async p=>{
    const fetched=useRealApi(p,()=>limiter);
    await p.tick();
    assert.deepEqual(fetched.filter(path=>path.startsWith('/api/market/ohlcv?')),[OHLCV_1D]);
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,RETRY_TEXT);assert.equal(p.candles(),0);assert.equal(p.svg.childNodes.length,0);
    const reads=()=>fetched.filter(path=>path.startsWith('/api/market/ohlcv?')).length;
    await p.tick(59000);assert.equal(reads(),1,'60 s wait: nothing at 59 s');
    await p.tick(2000);assert.equal(reads(),2,'retried after 60 s');
    assert.equal(p.state(),'limited');
  });
  // Candles shown, then the global limiter refuses the poll.
  let limit=false;
  await withPage({prefs:{symbol:'BTCUSDT',interval:'1m'}},async p=>{
    const fetched=useRealApi(p,()=>limit?limiter:accepted(rest(bars(3,()=>({minutes:null})),{interval:'1m'})));
    await p.tick();assert.equal(p.state(),'ready');assert.equal(p.candles(),3);
    limit=true;await p.tick(16000);
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,RETRY_TEXT);assert.equal(p.candles(),3,'candles stay');
    const reads=()=>fetched.filter(path=>path.startsWith('/api/market/ohlcv?')).length;
    assert.equal(reads(),2);await p.tick(59000);assert.equal(reads(),2);await p.tick(2000);assert.equal(reads(),3,'retry after 60 s');
    limit=false;await p.tick(61000);assert.equal(p.state(),'ready');
  });
  // Contrast: only 429 is limited. Other refusals without a code are unavailable with their HTTP code.
  for(const status of [400,401,403,404,418,500,503]){
    await withPage({},async p=>{
      useRealApi(p,()=>refused(status,{error:'Request failed'}));
      await p.tick();
      assert.equal(p.state(),'unavailable','HTTP '+status);assert.equal(p.status.textContent,`Market data unavailable (HTTP_${status})`);
    });
  }
});
