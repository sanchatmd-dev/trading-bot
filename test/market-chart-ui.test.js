import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {INTERVALS as SERVER_INTERVALS,MARKET} from '../src/postgres/market-ohlcv.js';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
const SVG_NS='http://www.w3.org/2000/svg';
const T0=Date.parse('2026-10-04T05:00:00Z'),HOUR=3600000,KEY='robotMarketChart.v1';
const limitFor=(symbol,interval)=>symbol==='BTCUSDT'&&interval==='1h'?720:symbol==='BTCUSDT'&&interval==='2h'?360:1000;
const INTERVALS=['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w'];

const bar=(time,over={})=>({time,open:'100.5',high:'110',low:'90.25',close:'105',volume:'3.5',minutes:60,complete:true,...over});
const bars=(count,over=()=>({}))=>Array.from({length:count},(_,index)=>bar(T0-(count-index)*HOUR,over(index)));
// Stored answer (bot feed) and REST answer (public proxy) of GET /api/market/ohlcv (version market-ohlcv-v2).
const payload=(list,over={})=>({version:'market-ohlcv-v2',source:'binance-spot-public-stored',symbol:'BTCUSDT',interval:'1h',bars:list,
  status:list.length?'OK':'EMPTY',closed_only:true,stale:false,stale_reason:null,stale_after_seconds:180,fallback:null,history_partial:false,
  age_seconds:12,latest_closed_bar:{open_time:T0,close_time:T0+60000},generated_at:new Date(T0+72000).toISOString(),
  gaps:{count:0,missing_minutes:0,ranges:[],truncated:false},...over});
const rest=(list,over={})=>payload(list,{source:'binance-spot-public-rest',closed_only:false,interval:'1d',cache_age_seconds:7,age_seconds:null,
  latest_closed_bar:null,stale_after_seconds:null,gaps:null,price_tick:'0.01',...over});
const lot=(number,over={})=>({lot:number,opened_at:new Date(T0).toISOString(),quantity:'0.5',entry_price:'101.5',entry_basis:'fill',stop_loss:'95',take_profit:'120',...over});
const position=(over={})=>({bot_id:'b1',bot_label:'Bot A',broker:'binance-global',symbol:'BTCUSDT',chart_symbol:'BTCUSDT',execution_mode:'paper',side:'LONG',
  quantity:'0.5',avg_price:'101.5',stop_loss:'95',take_profit:'120',updated_at:new Date(T0).toISOString(),lots_match_position:true,lots:[lot(1)],...over});
const levelsBody=(positions,over={})=>({version:'position-levels-v1',generated_at:new Date(T0).toISOString(),scope:'bot',truncated:false,positions,...over});
const SYMBOLS=[['BTCUSDT','BTC','USDT','0.01'],['ETHUSDT','ETH','USDT','0.01'],['ETHBTC','ETH','BTC','0.00001'],['ETHFDUSD','ETH','FDUSD','0.01'],
  ['ETHWUSDT','ETHW','USDT','0.001'],['METHUSDT','METH','USDT','0.0001'],['BNBUSDT','BNB','USDT','0.1'],['SOLUSDT','SOL','USDT','0.01']];
const symbolsBody=(rows=SYMBOLS)=>({version:'market-symbols-v1',source:'binance-spot-public-rest',generated_at:new Date(T0).toISOString(),
  retrieved_at:new Date(T0).toISOString(),stale:false,count:rows.length,symbols:rows});
const apiError=(code,status)=>Object.assign(new Error(code||'Request failed'),{code,status});
const many=count=>Array.from({length:count},(_,index)=>['A'+String(index).padStart(3,'0')+'USDT','A'+String(index).padStart(3,'0'),'USDT','0.01']);

/**
 * One jsdom page with the chart script. The three server reads are stubbed per kind; setInterval is captured so a test
 * drives the 5 s scheduler by hand; Date.now of this window only is a manual clock. Nothing global of the test process is touched.
 */
function setup({language,ohlcv,symbols,levels,prefs,scope,visible=true,storage,indicators=true}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  if(prefs!==undefined)w.localStorage.setItem(KEY,typeof prefs==='string'?prefs:JSON.stringify(prefs));
  if(storage==='throw'){
    for(const name of ['getItem','setItem'])w.Storage.prototype[name]=()=>{throw new Error('storage blocked');};
  }
  w.eval(publicFile('i18n.js'));
  if(scope)w.eval(`var selectedBot=${JSON.stringify(scope)};`);
  const calls=[],clock={now:T0},timer={};
  w.Date.now=()=>clock.now;
  w.setInterval=(fn,ms)=>{timer.fn=fn;timer.ms=ms;return 1;};
  w.fetch=()=>{throw new Error('direct network access is forbidden: the chart reads through api() only');};
  const answer=(handler,fallback)=>typeof handler==='function'?handler:()=>structuredClone(handler??fallback);
  const handlers={ohlcv:answer(ohlcv,payload(bars(5))),symbols:answer(symbols,symbolsBody()),levels:answer(levels,levelsBody([]))};
  w.api=async(path,options)=>{
    calls.push({path,options});
    const kind=path.startsWith('/api/market/ohlcv?')?'ohlcv':path==='/api/market/symbols'?'symbols':path==='/api/positions/levels'?'levels':null;
    if(kind===null)throw new Error('Unexpected '+path);
    return handlers[kind](path,options);
  };
  if(indicators)w.eval(publicFile('chart-indicators.js'));
  w.eval(publicFile('interactive-chart.js'));
  if(visible)d.querySelector('#app').hidden=false;
  const q=selector=>d.querySelector(selector);
  const p={dom,w,d,calls,clock,timer,handlers,q,
    root:q('#interactiveChart'),svg:q('#marketChartSvg'),status:q('#marketChartStatus'),meta:q('#marketChartMeta'),input:q('#mcSymbolInput'),
    list:q('#mcSymbolList'),select:q('#mcInterval'),legend:q('#marketChartLevels'),badge:q('#marketChartSource'),symbolBadge:q('#mcSymbolBadge'),
    chips:q('#mcHeldChips'),state:()=>q('#interactiveChart').dataset.state,
    paths:kind=>calls.map(call=>call.path).filter(path=>kind===undefined||path.startsWith(kind)),
    tick:async(advance=0)=>{clock.now+=advance;timer.fn();await settle();},
    key:(name,target=q('#mcSymbolInput'))=>{target.dispatchEvent(new w.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true}));},
    type:text=>{const input=q('#mcSymbolInput');input.value=text;input.dispatchEvent(new w.Event('input',{bubbles:true}));},
    options:()=>[...d.querySelectorAll('#mcSymbolList [role="option"]')].map(item=>item.querySelector('.mc-opt-symbol').textContent),
    interval:name=>q(`[data-mc-interval="${name}"]`),
    candles:()=>p.svg.querySelectorAll('g.mc-bar').length,
    lines:selector=>[...p.svg.querySelectorAll(selector)],
    labels:()=>[...p.svg.querySelectorAll('.mc-level-label')].map(item=>item.textContent),
    legendRows:()=>[...p.legend.querySelectorAll('li')].map(item=>item.textContent)};
  return p;
}
const withPage=async(options,body)=>{const p=setup(options);try{await body(p);}finally{p.w.close();}};
const sourceOf=name=>publicFile(name);
const DEFAULT_INDICATORS={v:1,ema1:{on:true,period:50},ema2:{on:true,period:200},atr:{on:true,period:14,multiplier:2},rsi:{on:false,period:14},macd:{on:false,fast:12,slow:26,signal:9}};

test('static: panel on Overview after the status grid, 14 timeframes with 1d, quick buttons, no external script, no inline style',()=>{
  const html=publicFile('index.html'),dom=new JSDOM(html),d=dom.window.document;
  try{
    assert.ok(!html.includes('unpkg')&&!html.includes('lightweight-charts'),'the CDN chart library is gone');
    for(const script of d.querySelectorAll('script[src]'))assert.ok(script.getAttribute('src').startsWith('/'),'script '+script.getAttribute('src'));
    for(const link of d.querySelectorAll('link[rel="stylesheet"]'))assert.ok(link.getAttribute('href').startsWith('/'),'stylesheet '+link.getAttribute('href'));
    assert.equal(d.querySelectorAll('#interactiveChartPanel').length,1,'one panel only');
    assert.equal(d.querySelector('#interactiveChartPanel [style]'),null,'the CSP forbids inline styles');
    for(const part of ['/interactive-chart.js?v=mc3','/chart-indicators.js?v=mc3','/market-chart.css?v=mc3','/i18n.js?v=r7ui5','/readiness.js?v=r7ui1'])assert.ok(html.includes(part),part);
    assert.ok(html.indexOf('/app.js?v=')<html.indexOf('/chart-indicators.js?v=')&&html.indexOf('/chart-indicators.js?v=')<html.indexOf('/interactive-chart.js?v='),'app.js, then the indicator module, then the chart');
    assert.ok(!publicFile('market-chart.css').includes('!important'));
    const panel=d.querySelector('#interactiveChartPanel');
    assert.ok(d.querySelector('section[data-page="overview"] > #interactiveChartPanel'),'on Overview');
    assert.equal(d.querySelector('section[data-page="analytics"] #interactiveChartPanel'),null,'not on Analytics any more');
    assert.ok(panel.previousElementSibling.classList.contains('status-grid'),'directly after the status grid');
    assert.equal(panel.querySelector('h2').textContent,'Market chart');
    assert.deepEqual([...panel.querySelectorAll('#mcInterval option')].map(item=>item.value),INTERVALS);
    assert.deepEqual([...panel.querySelectorAll('#mcInterval option')].map(item=>item.textContent),INTERVALS,'option text is the code');
    assert.equal(panel.querySelector('#mcInterval').value,'1d');
    assert.deepEqual([...panel.querySelectorAll('[data-mc-interval]')].map(item=>item.dataset.mcInterval),['15m','1h','4h','1d','1w']);
    assert.deepEqual([...panel.querySelectorAll('[data-mc-interval][aria-pressed="true"]')].map(item=>item.dataset.mcInterval),['1d']);
    assert.equal(panel.querySelectorAll('form,a').length,0);
    const input=panel.querySelector('#mcSymbolInput');
    assert.equal(input.getAttribute('role'),'combobox');assert.equal(input.getAttribute('aria-controls'),'mcSymbolList');assert.equal(input.getAttribute('aria-expanded'),'false');
    assert.equal(panel.querySelector('label[for="mcSymbolInput"]').textContent,'Search symbol');
    assert.equal(panel.querySelector('#mcSymbolList').getAttribute('role'),'listbox');assert.ok(panel.querySelector('#mcSymbolList').hidden);
    assert.ok(panel.querySelector('#mcHeld').hidden);
    assert.equal(panel.querySelectorAll('.mc-data').length>=5,true);
    assert.equal(panel.querySelectorAll('button').length,7,'five quick buttons, refresh and reset indicators: no order, alert or trade control');
  }finally{dom.window.close();}
  for(const name of fs.readdirSync(new URL('../public/',import.meta.url)).filter(file=>file.endsWith('.js'))){
    const source=publicFile(name);
    assert.ok(!source.includes('api.binance.com'),name+' calls Binance from the browser');
    assert.doesNotMatch(source,/fetch\(\s*['"`](?:https?:)?\/\//,name+' fetches another origin');
  }
});

test('interactive-chart.js bans: no markup injection, no network, one guarded storage pair, no inline style, three api() sites, fixed attribute and listener sets',()=>{
  const source=sourceOf('interactive-chart.js'),plain=source.replaceAll(SVG_NS,'');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket',
    'http://','https://','.style','sessionStorage','indexedDB','LightweightCharts','unpkg','binance.com','sendBeacon','cookie'])
    assert.ok(!plain.includes(banned),'forbidden in interactive-chart.js: '+banned);
  assert.ok(source.includes(SVG_NS),'the SVG namespace is the only URL-like string');
  // Storage: exactly one read and one write, each inside try/catch.
  const uses=[...source.matchAll(/localStorage/g)].map(match=>match.index);
  assert.equal(uses.length,2,'two storage uses');
  for(const at of uses)assert.ok(/try\{[^}]*$/.test(source.slice(Math.max(0,at-90),at)),'storage use inside a try block');
  // Requests: three same-origin reads, literal paths.
  assert.equal(source.split('api(').length-1,3,'three api() call sites');
  assert.ok(source.includes("api('/api/market/ohlcv?symbol='+encodeURIComponent(state.symbol)+'&interval='+state.interval+'&limit='+fetchLimit(),{silent:true})"));
  assert.ok(source.includes("api('/api/market/symbols',{silent:true})"));
  assert.ok(source.includes("api('/api/positions/levels',{silent:true,botId:scopeAll()?'all':undefined})"));
  assert.ok(source.includes("typeof selectedBot!=='undefined'&&selectedBot==='all'"));
  // Attributes: class, SVG geometry and the fixed ARIA helper set only.
  const names=[...source.matchAll(/setAttribute\(\s*([^,)]+)/g)].map(match=>match[1].trim());
  assert.ok(names.every(name=>name==="'class'"||name==='name'),'setAttribute names: '+names);
  const geometry=source.match(/GEOMETRY=new Set\(\[([^\]]+)\]\)/)[1].match(/'(\w+)'/g).map(item=>item.slice(1,-1)).sort();
  assert.deepEqual(geometry,['height','points','width','x','x1','x2','y','y1','y2'].sort(),'only geometry attributes reach the SVG');
  const aria=source.match(/ARIA=new Set\(\[([^\]]+)\]\)/)[1].match(/'([\w-]+)'/g).map(item=>item.slice(1,-1)).sort();
  assert.deepEqual(aria,['aria-activedescendant','aria-expanded','aria-pressed','aria-selected','id','role'],'the fixed ARIA, id and role set');
  assert.deepEqual([...new Set([...source.matchAll(/addEventListener\('([a-z:0-9]+)'/g)].map(match=>match[1]))].sort(),
    ['change','click','focusout','input','keydown','visibilitychange']);
  assert.equal(source.split('setInterval(').length-1,1,'one scheduler');
  assert.ok(source.includes('setInterval(tick,5000)'));
  assert.ok(!/\b(?:place|cancel|close)Order|\/api\/(?:orders|trade)/i.test(source),'the chart has no order control');
});
test('scheduler: nothing before the page is visible; the first visible tick reads the chart at BTCUSDT 1d, the symbols and the levels',async()=>{
  await withPage({visible:false},async p=>{
    assert.equal(p.timer.ms,5000,'one 5 s scheduler');
    await p.tick();assert.equal(p.calls.length,0,'the app is hidden (before login): no request');
    p.q('#app').hidden=false;p.q('[data-page="overview"]').hidden=true;
    await p.tick();assert.equal(p.calls.length,0,'another page is on screen: no request');
    p.q('[data-page="overview"]').hidden=false;
    await p.tick();
    assert.deepEqual(p.paths().sort(),['/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000','/api/market/symbols','/api/positions/levels']);
    assert.ok(p.calls.every(call=>call.options.silent===true));
    assert.equal(p.calls.find(call=>call.path==='/api/positions/levels').options.botId,undefined,'no explicit bot: the page helper adds the selected bot');
  });
});

test('Overview navigation, the global refresh and the chart refresh read right away; a hidden Overview does not',async()=>{
  await withPage({},async p=>{
    p.q('nav button[data-view="overview"]').click();await settle();
    assert.equal(p.paths('/api/market/ohlcv').length,1);assert.equal(p.paths('/api/positions/levels').length,1);assert.equal(p.paths('/api/market/symbols').length,1);
    p.q('#refresh').click();await settle();
    assert.equal(p.paths('/api/market/ohlcv').length,2);assert.equal(p.paths('/api/market/symbols').length,1,'the symbol list loads once');
    p.q('#marketChartRefresh').click();assert.equal(p.candles(),5,'candles stay while the refresh runs');assert.equal(p.state(),'ready');
    await settle();assert.equal(p.paths('/api/market/ohlcv').length,3);
    p.q('[data-page="overview"]').hidden=true;
    p.q('#refresh').click();p.q('nav button[data-view="overview"]').click();await settle();
    assert.equal(p.paths('/api/market/ohlcv').length,3,'hidden: no request');
  });
});

test('stored answer: candles with classes, tooltips, texts and no inline style',async()=>{
  const list=bars(5,index=>index===1?{close:'95',complete:false,minutes:59}:{});
  await withPage({ohlcv:payload(list)},async p=>{
    await p.tick();
    const groups=[...p.svg.querySelectorAll('g.mc-bar')];
    assert.equal(groups.length,5);
    assert.equal(p.svg.querySelectorAll('rect.mc-candle').length,5);assert.equal(p.svg.querySelectorAll('line.mc-wick').length,5);assert.equal(p.svg.querySelectorAll('rect.mc-vol').length,5);
    assert.ok(groups[0].querySelector('rect.mc-candle').classList.contains('mc-up'));
    assert.ok(groups[1].querySelector('rect.mc-candle').classList.contains('mc-down'),'close below open is down');
    assert.ok(groups[1].classList.contains('mc-incomplete'));assert.ok(!groups[0].classList.contains('mc-incomplete'));
    assert.equal(groups[0].querySelector('title').textContent,'2026-10-04 00:00 UTC · O 100.5 · H 110 · L 90.25 · C 105 · V 3.5 · 60 min');
    assert.equal(p.svg.querySelectorAll('.mc-grid').length,5);assert.ok(p.svg.querySelector('line.mc-last'));
    assert.equal(p.svg.querySelector('.mc-last-label').textContent,'105','the last close is the server string');
    for(const rect of p.svg.querySelectorAll('rect')){assert.ok(Number(rect.getAttribute('height'))>=0);assert.ok(Number(rect.getAttribute('width'))>0);}
    assert.equal(p.d.querySelectorAll('#interactiveChartPanel [style],#interactiveChartPanel [onload],#interactiveChartPanel [onerror],#interactiveChartPanel [onclick]').length,0);
    for(const element of p.svg.querySelectorAll('*'))assert.equal(element.namespaceURI,SVG_NS);
    assert.equal(p.state(),'ready');
    assert.equal(p.status.textContent,'Latest closed bar 2026-10-04 05:01 UTC · age 12 s');
    assert.equal(p.meta.textContent,'5 bars · 1h · generated 2026-10-04 05:01 UTC');
    assert.equal(p.symbolBadge.textContent,'BINANCE:BTCUSDT');
    assert.equal(p.badge.dataset.source,'stored');assert.equal(p.badge.textContent,'Source: stored Binance bars (bot feed)');
    assert.ok(!/live/i.test(p.badge.textContent+p.status.textContent+p.q('#interactiveChartPanel').textContent.replace(/Live is locked/gi,'')),'never the word live');
  });
});

test('REST answer: source badge, cache age, forming bar flagged and drawn distinct, axis decimals from the tick, no minutes in the tooltip',async()=>{
  const list=bars(4,index=>({minutes:null,complete:index!==3,forming:index===3}));
  await withPage({prefs:{symbol:'ETHUSDT',interval:'1d'},ohlcv:rest(list,{symbol:'ETHUSDT',price_tick:'0.01000000'})},async p=>{
    await p.tick();
    assert.equal(p.paths('/api/market/ohlcv')[0],'/api/market/ohlcv?symbol=ETHUSDT&interval=1d&limit=1000');
    assert.equal(p.badge.dataset.source,'rest');assert.equal(p.badge.textContent,'Source: Binance public REST (cached 7 s)');
    assert.equal(p.status.textContent,'Updated 2026-10-04 05:01 UTC · cache age 7 s');assert.equal(p.state(),'ready');
    assert.equal(p.meta.textContent,'4 bars · 1d · generated 2026-10-04 05:01 UTC');
    const groups=[...p.svg.querySelectorAll('g.mc-bar')];
    assert.ok(groups[3].classList.contains('mc-forming')&&groups[3].classList.contains('mc-incomplete'));
    assert.ok(!groups[2].classList.contains('mc-forming'));
    assert.ok(groups[3].querySelector('title').textContent.endsWith(' · Forming bar'));
    assert.ok(!groups[0].querySelector('title').textContent.includes(' min'),'REST bars carry no minutes');
    const grid=[...p.svg.querySelectorAll('.mc-grid-group text')].map(item=>item.textContent);
    assert.ok(grid.every(text=>/^\d+\.\d{2}$/.test(text)),'two decimals from the 0.01 tick: '+grid);
    assert.equal(p.symbolBadge.textContent,'BINANCE:ETHUSDT');
  });
});

test('axis decimals without a tick follow the price level; time labels follow the interval',async()=>{
  const cases=[['1d','2026-10-0',{open:'5000',high:'5100',low:'4900',close:'5050'},/^\d+\.\d{2}$/],['4h','10-0',{open:'5',high:'6',low:'4',close:'5.5'},/^\d+\.\d{4}$/],
    ['15m',':',{open:'0.5',high:'0.6',low:'0.4',close:'0.55'},/^\d+\.\d{8}$/]];
  for(const [interval,time,prices,pattern] of cases){
    await withPage({prefs:{symbol:'BTCUSDT',interval},ohlcv:rest(bars(3,()=>({...prices,minutes:null})),{interval,price_tick:null})},async p=>{
      await p.tick();
      const grid=[...p.svg.querySelectorAll('.mc-grid-group text')].map(item=>item.textContent);
      assert.ok(grid.every(text=>pattern.test(text)),interval+' '+grid);
      const labels=[...p.svg.querySelectorAll('.mc-axis-mid')].map(item=>item.textContent);
      assert.ok(labels.length>0&&labels.every(text=>text.includes(time)),interval+' time labels '+labels);
      if(interval==='1d')assert.ok(labels.every(text=>/^\d{4}-\d\d-\d\d$/.test(text)));
      if(interval==='4h')assert.ok(labels.every(text=>/^\d\d-\d\d \d\d:\d\d$/.test(text)));
      if(interval==='15m')assert.ok(labels.every(text=>/^\d\d:\d\d$/.test(text)));
    });
  }
});

test('visible-bar budget: about one bar per 4 px with a floor of 40; without a measured width every bar is drawn',async()=>{
  const list=bars(200);
  for(const [width,expected] of [[0,200],[360,90],[100,40],[2000,200]]){
    const p=setup({ohlcv:payload(list)});
    try{
      p.svg.getBoundingClientRect=()=>({width});
      await p.tick();
      assert.equal(p.candles(),expected,'width '+width);
    }finally{p.w.close();}
  }
});

test('timeframe: the select and the quick buttons stay in sync, a change clears the candles and reloads, the interval is kept by a chip',async()=>{
  await withPage({levels:levelsBody([position({chart_symbol:'ETHUSDT',symbol:'ETHUSDT'})])},async p=>{
    await p.tick();
    assert.equal(p.select.value,'1d');assert.ok(p.interval('1d').classList.contains('active'));
    p.interval('15m').click();
    assert.equal(p.select.value,'15m');assert.equal(p.candles(),0,'nothing of the old interval stays on screen');assert.equal(p.state(),'loading');
    await settle();
    assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=BTCUSDT&interval=15m&limit=1000');
    assert.equal(p.interval('15m').getAttribute('aria-pressed'),'true');assert.equal(p.interval('1d').getAttribute('aria-pressed'),'false');
    p.select.value='2h';p.select.dispatchEvent(new p.w.Event('change',{bubbles:true}));await settle();
    assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=BTCUSDT&interval=2h&limit=360');
    assert.ok(p.d.querySelectorAll('[data-mc-interval][aria-pressed="true"]').length===0,'no quick button for 2h is pressed');
    assert.equal(p.select.value,'2h');
    for(const name of INTERVALS){p.select.value=name;p.select.dispatchEvent(new p.w.Event('change',{bubbles:true}));await settle();assert.ok(p.paths('/api/market/ohlcv').at(-1).includes('&interval='+name+'&limit='),name);}
    p.chips.querySelector('button').click();await settle();
    assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=ETHUSDT&interval=1w&limit=1000','the chip keeps the timeframe');
    assert.equal(p.select.value,'1w');
  });
});

test('late answers are dropped: an older interval, symbol or levels read never overwrites the newer view',async()=>{
  const resolvers={};
  await withPage({ohlcv:path=>new Promise(resolve=>{resolvers[path.split('?')[1]]=resolve;}),
    levels:()=>new Promise(resolve=>{(resolvers.levels??=[]).push(resolve);})},async p=>{
    await p.tick();
    assert.equal(p.state(),'loading');assert.equal(p.status.textContent,'Loading market data…');
    p.interval('15m').click();await settle();
    resolvers['symbol=BTCUSDT&interval=15m&limit=1000'](payload(bars(3),{interval:'15m'}));await settle();
    assert.equal(p.candles(),3);
    resolvers['symbol=BTCUSDT&interval=1d&limit=1000'](payload(bars(7)));await settle();
    assert.equal(p.candles(),3,'the answer of the older request is dropped');assert.match(p.meta.textContent,/ · 15m · /);
    // A late levels answer after a bot switch is dropped as well.
    p.w.eval("var selectedBot='b2';");
    p.q('#botSwitcher').dispatchEvent(new p.w.Event('change'));
    resolvers.levels[0](levelsBody([position({chart_symbol:'BTCUSDT'})]));await settle();
    assert.equal(p.lines('.mc-level').length,0,'the old bot lines do not come back');
  });
});

test('states: loading, empty, stale with candles, unavailable with the code, limited, and a plain failure',async()=>{
  const cases=[
    ['empty',payload([],{status:'EMPTY',latest_closed_bar:null,age_seconds:null,stale:true}),'No bars for this symbol and timeframe',0],
    ['stale',payload(bars(4),{stale:true,age_seconds:400}),'Stale: latest closed bar is 400 s old (limit 180 s)',4],
    ['ready',payload(bars(4)),null,4]];
  for(const [state,body,text,count] of cases){
    await withPage({ohlcv:body},async p=>{
      await p.tick();
      assert.equal(p.state(),state);if(text)assert.equal(p.status.textContent,text);
      assert.equal(p.candles(),count,state);
    });
  }
  for(const [error,expected] of [[apiError('MARKET_DATA_UNAVAILABLE',503),'MARKET_DATA_UNAVAILABLE'],[apiError(undefined,404),'HTTP_404'],
    [apiError('MARKET_UPSTREAM_TIMEOUT',503),'MARKET_UPSTREAM_TIMEOUT'],[new Error('offline'),'REQUEST_FAILED']]){
    await withPage({ohlcv:()=>{throw error;}},async p=>{
      await p.tick();
      assert.equal(p.state(),'unavailable');assert.equal(p.status.textContent,`Market data unavailable (${expected})`);
      assert.equal(p.svg.childNodes.length,0,'the drawing is cleared');assert.equal(p.meta.textContent,'');assert.equal(p.badge.textContent,'');
    });
  }
  await withPage({ohlcv:()=>{throw apiError('MARKET_RATE_LIMITED',429);}},async p=>{
    await p.tick();
    assert.equal(p.state(),'limited');assert.equal(p.status.textContent,'Too many chart requests; retrying in 60 s');assert.equal(p.svg.childNodes.length,0);
  });
});

test('source badges: fallback, stale copy of REST data, history partial; an error during a refresh keeps the candles and shows the code',async()=>{
  await withPage({ohlcv:payload(bars(3),{interval:'1d',fallback:{from:'binance-spot-public-rest',reason:'MARKET_PROXY_DISABLED'},history_partial:true,
    window:{history_start_open_time:T0-5*86400000}})},async p=>{
    await p.tick();
    assert.equal(p.badge.dataset.source,'fallback');
    assert.equal(p.badge.textContent,'Fallback: stored bars, Binance REST unavailable (MARKET_PROXY_DISABLED)');
    assert.ok(p.meta.textContent.endsWith(' · Partial history: stored bars start 2026-09-29 05:00 UTC'),p.meta.textContent);
  });
  await withPage({ohlcv:rest(bars(3),{stale:true,stale_reason:'UPSTREAM_UNAVAILABLE',cache_age_seconds:900})},async p=>{
    await p.tick();
    assert.equal(p.badge.dataset.source,'stale');assert.equal(p.state(),'stale');
    assert.equal(p.badge.textContent,'Stale copy: 900 s old, Binance REST unavailable (UPSTREAM_UNAVAILABLE)');
  });
  let fail=false;
  await withPage({prefs:{symbol:'BTCUSDT',interval:'1m'},ohlcv:()=>{if(fail)throw apiError('MARKET_UPSTREAM_COOLDOWN',503);return rest(bars(3),{interval:'1m'});}},async p=>{
    await p.tick();assert.equal(p.state(),'ready');
    fail=true;await p.tick(16000);
    assert.equal(p.candles(),3,'the candles stay');assert.equal(p.state(),'stale');
    assert.equal(p.badge.dataset.source,'stale');assert.equal(p.badge.textContent,'Stale copy: 23 s old, Binance REST unavailable (MARKET_UPSTREAM_COOLDOWN)');
    fail=false;await p.tick(120000);
    assert.equal(p.state(),'ready');assert.equal(p.badge.dataset.source,'rest');
  });
});

test('cadence: per-interval poll, levels 15 s while held and 60 s otherwise, fixed back-off per code, paused while hidden, resumed on visibilitychange',async()=>{
  const levels=levelsBody([position()]);
  await withPage({prefs:{symbol:'BTCUSDT',interval:'1m'},levels},async p=>{
    await p.tick();assert.equal(p.calls.length,3);
    await p.tick(5000);assert.equal(p.calls.length,3,'nothing is due yet');
    await p.tick(11000);assert.equal(p.paths('/api/positions/levels').length,2,'levels 15 s while a position is held');assert.equal(p.paths('/api/market/ohlcv').length,2,'1m chart 15 s');
    assert.equal(p.paths('/api/market/symbols').length,1,'symbols once');
    Object.defineProperty(p.d,'hidden',{configurable:true,get:()=>true});
    const before=p.calls.length;await p.tick(600000);assert.equal(p.calls.length,before,'paused while the tab is hidden');
    Object.defineProperty(p.d,'hidden',{configurable:true,get:()=>false});
    p.d.dispatchEvent(new p.w.Event('visibilitychange'));await settle();
    assert.ok(p.calls.length>before,'resumed at once');
  });
  await withPage({ohlcv:payload(bars(3)),levels:levelsBody([])},async p=>{
    await p.tick();await p.tick(30000);assert.equal(p.paths('/api/positions/levels').length,1,'no position: levels every 60 s');
    await p.tick(31000);assert.equal(p.paths('/api/positions/levels').length,2);
    assert.equal(p.paths('/api/market/ohlcv').length,1,'1d chart 300 s: 61 s is not enough');
    await p.tick(250000);assert.equal(p.paths('/api/market/ohlcv').length,2);
  });
  // Errors: rate limit waits 60 s, cooldown 120 s, other codes double the cadence.
  const outcomes=[['MARKET_RATE_LIMITED',60000],['MARKET_UPSTREAM_COOLDOWN',120000]];
  for(const [code,wait] of outcomes){
    await withPage({ohlcv:()=>{throw apiError(code,code==='MARKET_RATE_LIMITED'?429:503);}},async p=>{
      await p.tick();assert.equal(p.paths('/api/market/ohlcv').length,1);
      await p.tick(wait-1000);assert.equal(p.paths('/api/market/ohlcv').length,1,code+' still waiting');
      await p.tick(2000);assert.equal(p.paths('/api/market/ohlcv').length,2,code+' retried after '+wait);
    });
  }
  await withPage({prefs:{symbol:'BTCUSDT',interval:'1m'},ohlcv:()=>{throw apiError('MARKET_UPSTREAM_TIMEOUT',503);}},async p=>{
    await p.tick();await p.tick(29000);assert.equal(p.paths('/api/market/ohlcv').length,1);
    await p.tick(2000);assert.equal(p.paths('/api/market/ohlcv').length,2,'first retry after 30 s');
    await p.tick(59000);assert.equal(p.paths('/api/market/ohlcv').length,2);
    await p.tick(2000);assert.equal(p.paths('/api/market/ohlcv').length,3,'second retry after 60 s');
  });
});

test('logout clears the chart and stops every request',async()=>{
  await withPage({levels:levelsBody([position()])},async p=>{
    await p.tick();assert.equal(p.candles(),5);assert.ok(p.lines('.mc-level').length>0);
    p.q('#logout').click();
    assert.equal(p.state(),'idle');assert.equal(p.svg.childNodes.length,0);assert.equal(p.status.textContent,'');assert.equal(p.meta.textContent,'');
    assert.equal(p.legend.childNodes.length,0);assert.ok(p.q('#mcHeld').hidden);assert.equal(p.badge.textContent,'');
    const count=p.calls.length;await p.tick(900000);p.q('#marketChartRefresh').click();p.q('#refresh').click();await settle();
    assert.equal(p.calls.length,count,'no request after logout');
  });
});
test('picker ranking: exact, symbol prefix, base prefix, substring; quote order breaks ties; slash, dash, underscore, case and the BINANCE prefix are ignored',async()=>{
  await withPage({},async p=>{
    await p.tick();
    p.type('eth');assert.deepEqual(p.options(),['ETHUSDT','ETHWUSDT','ETHFDUSD','ETHBTC','METHUSDT']);
    p.type('eth/usdt');assert.equal(p.options()[0],'ETHUSDT');
    p.type('BINANCE:eth-usdt');assert.equal(p.options()[0],'ETHUSDT');
    p.type('eth_usdt');assert.equal(p.options()[0],'ETHUSDT');
    p.type('ethw');assert.equal(p.options()[0],'ETHWUSDT','base prefix');
    p.type('so');assert.deepEqual(p.options(),['SOLUSDT']);
    p.type('zzz');assert.deepEqual(p.options(),[]);
    assert.equal(p.list.textContent,'No matching symbol');assert.equal(p.list.querySelectorAll('[role="option"]').length,0,'the empty row is not selectable');
    p.type('');assert.equal(p.options().length,SYMBOLS.length,'an empty query lists symbols');
  });
});

test('picker cap: at most 50 options; options carry role, id and a base / quote hint, set with textContent only',async()=>{
  await withPage({symbols:symbolsBody(many(120))},async p=>{
    await p.tick();
    p.type('a');assert.equal(p.options().length,50);
    const option=p.list.querySelector('[role="option"]');
    assert.equal(option.id,'mcOpt-0');assert.equal(option.querySelector('.mc-opt-pair').textContent.trim(),'A000 / USDT');
    assert.equal(p.list.querySelectorAll('[role="option"] [style],[role="option"] a,[role="option"] img').length,0);
    assert.equal(p.list.hidden,false);assert.equal(p.input.getAttribute('aria-expanded'),'true');
  });
});

test('picker keyboard: arrows wrap, PageDown/PageUp move 10, Home/End, Enter selects, Escape restores, Tab closes, aria state follows',async()=>{
  await withPage({symbols:symbolsBody([...many(30),SYMBOLS[0]])},async p=>{
    await p.tick();
    p.type('a');
    const active=()=>p.input.getAttribute('aria-activedescendant');
    assert.equal(active(),'mcOpt-0');assert.equal(p.list.querySelector('#mcOpt-0').getAttribute('aria-selected'),'true');
    p.key('ArrowDown');assert.equal(active(),'mcOpt-1');assert.equal(p.list.querySelector('#mcOpt-0').getAttribute('aria-selected'),'false');
    p.key('ArrowUp');p.key('ArrowUp');assert.equal(active(),'mcOpt-29','wraps from the first to the last');
    p.key('ArrowDown');assert.equal(active(),'mcOpt-0','wraps from the last to the first');
    p.key('PageDown');assert.equal(active(),'mcOpt-10');p.key('PageDown');p.key('PageDown');p.key('PageDown');assert.equal(active(),'mcOpt-29','stops at the end');
    p.key('PageUp');assert.equal(active(),'mcOpt-19');
    p.key('Home');assert.equal(active(),'mcOpt-0');p.key('End');assert.equal(active(),'mcOpt-29');
    p.key('Escape');
    assert.equal(p.list.hidden,true);assert.equal(p.input.getAttribute('aria-expanded'),'false');assert.equal(p.input.value,'BTCUSDT','Escape restores the current symbol');
    assert.equal(p.input.getAttribute('aria-activedescendant'),null);assert.equal(p.paths('/api/market/ohlcv').length,1,'nothing changed');
    p.type('a');p.key('Tab');assert.equal(p.list.hidden,true);assert.equal(p.input.value,'BTCUSDT');assert.equal(p.paths('/api/market/ohlcv').length,1);
    p.key('ArrowDown');assert.equal(p.list.hidden,false,'ArrowDown opens the list');
    assert.equal(p.list.querySelector('[aria-selected="true"]').dataset.symbol,'BTCUSDT','the list opens at the symbol on screen');
    p.key('Enter');await settle();
    assert.equal(p.list.hidden,true);assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000','the current symbol stays selected');
    p.type('a003');p.key('Enter');await settle();
    assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=A003USDT&interval=1d&limit=1000');
    assert.equal(p.input.value,'A003USDT');assert.equal(p.symbolBadge.textContent,'BINANCE:A003USDT');
    assert.equal(p.candles(),5);
  });
});

test('picker mouse and focus: a click selects, focus leaving the picker closes and restores, a selection clears the old candles',async()=>{
  const resolvers=[];
  await withPage({},async p=>{
    await p.tick();
    p.input.dispatchEvent(new p.w.Event('click',{bubbles:true}));
    assert.equal(p.list.hidden,false);assert.equal(p.list.querySelector('[aria-selected="true"]').dataset.symbol,'BTCUSDT','the list starts at the symbol on screen');
    p.type('eth');
    p.input.dispatchEvent(new p.w.FocusEvent('focusout',{bubbles:true,relatedTarget:p.list.querySelector('[role="option"]')}));
    assert.equal(p.list.hidden,false,'focus moved inside the picker');
    p.input.dispatchEvent(new p.w.FocusEvent('focusout',{bubbles:true,relatedTarget:p.q('#refresh')}));
    assert.equal(p.list.hidden,true);assert.equal(p.input.value,'BTCUSDT');
    p.handlers.ohlcv=()=>new Promise(resolve=>resolvers.push(resolve));
    p.type('sol');p.list.querySelector('[role="option"]').click();
    assert.equal(p.candles(),0,'the old symbol is not mixed in');assert.equal(p.state(),'loading');assert.equal(p.symbolBadge.textContent,'BINANCE:SOLUSDT');
    assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=SOLUSDT&interval=1d&limit=1000');
    resolvers[0](payload(bars(2),{symbol:'SOLUSDT'}));await settle();assert.equal(p.candles(),2);
  });
});

test('symbol list unavailable: only BTCUSDT and held assets; loading and failure notes; retried later; once loaded never again',async()=>{
  let fail=true;
  await withPage({symbols:()=>{if(fail)throw apiError('MARKET_PROXY_DISABLED',503);return symbolsBody();},levels:levelsBody([position({chart_symbol:'ETHUSDT',symbol:'ETHUSDT'})])},async p=>{
    await p.tick();
    p.type('');assert.deepEqual(p.options(),['ETHUSDT','BTCUSDT'],'held first, then BTCUSDT');
    assert.ok(p.list.textContent.includes('Symbol list unavailable (MARKET_PROXY_DISABLED); BTCUSDT and held assets only'));
    p.type('sol');assert.deepEqual(p.options(),[]);assert.ok(p.list.textContent.includes('No matching symbol'));
    p.key('Escape');
    await p.tick(30000);assert.equal(p.paths('/api/market/symbols').length,1,'retry after 60 s');
    fail=false;await p.tick(31000);assert.equal(p.paths('/api/market/symbols').length,2);
    p.type('sol');assert.deepEqual(p.options(),['SOLUSDT']);
    await p.tick(700000);assert.equal(p.paths('/api/market/symbols').length,2,'loaded once');
  });
  const resolvers=[];
  await withPage({symbols:()=>new Promise(resolve=>resolvers.push(resolve))},async p=>{
    await p.tick();p.type('btc');
    assert.ok(p.list.textContent.includes('Loading symbol list…'));
    resolvers[0](symbolsBody());await settle();
    assert.ok(!p.list.textContent.includes('Loading symbol list…'),'the open list refreshes when the symbols arrive');
  });
});

test('held-asset chips: one per held symbol, bot count or bot label, current symbol pressed, hidden when nothing is held',async()=>{
  const rows=[position({bot_id:'b1',bot_label:'Bot A',chart_symbol:'ETHUSDT',symbol:'ETHUSDT'}),position({bot_id:'b2',bot_label:'Bot B',chart_symbol:'ETHUSDT',symbol:'ETHUSDT'}),
    position({bot_id:'b1',bot_label:'Bot A'}),position({bot_id:'b3',bot_label:'Bot C',broker:'binance-th',symbol:'BTCTHB',chart_symbol:null})];
  await withPage({levels:levelsBody(rows)},async p=>{
    assert.ok(p.q('#mcHeld').hidden,'nothing is held before the first read');
    await p.tick();
    const chips=[...p.chips.querySelectorAll('button')];
    assert.deepEqual(chips.map(item=>item.textContent),['BTCUSDT','ETHUSDT · 2 bots']);
    assert.deepEqual(chips.map(item=>item.getAttribute('aria-pressed')),['true','false']);
    assert.equal(p.q('#mcHeld').hidden,false);assert.equal(p.svg.querySelectorAll('g.mc-bar').length,5,'the chart renders without any held asset too');
    assert.ok(p.legendRows().includes('Positions on other brokers have no Binance chart'));
    const first=chips[0];
    await p.tick(20000);assert.ok(p.chips.contains(first),'the chip nodes survive a quiet refresh');
    chips[1].click();await settle();
    assert.equal(p.symbolBadge.textContent,'BINANCE:ETHUSDT');
    assert.deepEqual([...p.chips.querySelectorAll('button')].map(item=>item.getAttribute('aria-pressed')),['false','true']);
    assert.ok(p.q('#mcHeld').querySelector('.mc-label').textContent==='Held assets');
  });
  await withPage({scope:'all',levels:levelsBody([position({chart_symbol:'ETHUSDT',symbol:'ETHUSDT',bot_label:'Scalper'})],{scope:'all'})},async p=>{
    await p.tick();
    assert.equal(p.calls.find(call=>call.path==='/api/positions/levels').options.botId,'all','scope all asks for all bots');
    assert.deepEqual([...p.chips.querySelectorAll('button')].map(item=>item.textContent),['ETHUSDT · Scalper']);
  });
});

test('lines: two lots of one bot draw two entries with #1 and #2 plus the average; the legend repeats every line',async()=>{
  const lots=[lot(1,{entry_price:'100',stop_loss:'95',take_profit:'112'}),lot(2,{entry_price:'102',stop_loss:'96',take_profit:'115'})];
  await withPage({levels:levelsBody([position({quantity:'1.0',avg_price:'101',lots})])},async p=>{
    await p.tick();
    assert.equal(p.lines('line.mc-entry').length,2);assert.equal(p.lines('line.mc-sl').length,2);assert.equal(p.lines('line.mc-tp').length,2);assert.equal(p.lines('line.mc-avg').length,1);
    const labels=p.labels();
    assert.ok(labels.includes('Bot A · LONG 0.5 · ENTRY 100 #1')&&labels.includes('Bot A · LONG 0.5 · ENTRY 102 #2'),labels.join('|'));
    assert.ok(labels.includes('Bot A · SL 95 #1')&&labels.includes('Bot A · TP 115 #2')&&labels.includes('Bot A · AVG 101'));
    assert.equal(p.q('#marketChartLevelsTitle').hidden,false);assert.equal(p.q('#marketChartLevelsTitle').textContent,'Open position lines');
    assert.equal(p.legendRows().length,7);assert.ok(p.legendRows().includes('Bot A · AVG 101'));
    assert.deepEqual(p.legendRows().slice(0,2),['Bot A · TP 115 #2','Bot A · TP 112 #1'],'the legend runs from the highest price down');
    for(const element of p.svg.querySelectorAll('*'))assert.equal(element.getAttribute('style'),null);
  });
});

test('lines: one lot, cost basis suffix, null and zero levels omitted, legacy position without lots, other symbols ignored',async()=>{
  const rows=[position({lots:[lot(1,{entry_basis:'cost',stop_loss:null,take_profit:'0'})]}),
    position({bot_id:'b2',bot_label:'Legacy',lots:[],avg_price:'103',stop_loss:'92',take_profit:'111',quantity:'2'}),
    position({bot_id:'b3',bot_label:'Eth bot',chart_symbol:'ETHUSDT',symbol:'ETHUSDT',lots:[lot(1,{entry_price:'5',stop_loss:'4',take_profit:'6'})]})];
  await withPage({levels:levelsBody(rows)},async p=>{
    await p.tick();
    const labels=p.labels();
    assert.deepEqual(labels.sort(),['Bot A · LONG 0.5 · ENTRY 101.5 cost incl. fee','Legacy · LONG 2 · ENTRY 103','Legacy · SL 92','Legacy · TP 111'].sort());
    assert.equal(p.lines('line.mc-avg').length,0,'one lot needs no average line');
    assert.equal(p.legend.textContent.includes('Eth bot'),false);
  });
  await withPage({language:'th',levels:levelsBody([position({lots:[lot(1,{entry_basis:'cost'})]})])},async p=>{
    await p.tick();const entry=p.labels().find(label=>label.includes('ENTRY'));assert.ok(entry.endsWith(' ต้นทุนรวมค่าธรรมเนียม'),entry);
  });
});

test('lines: coincident lines of several bots merge into one label; a lot mismatch adds the average and a warning',async()=>{
  const rows=['A','B','C','D','E'].map((name,index)=>position({bot_id:'b'+index,bot_label:'Bot '+name,lots:[lot(1,{entry_price:String(100+index),stop_loss:'95',take_profit:'120'})]}));
  await withPage({levels:levelsBody(rows)},async p=>{
    await p.tick();
    assert.equal(p.lines('line.mc-sl').length,1,'five equal stops are one line');assert.equal(p.lines('line.mc-tp').length,1);assert.equal(p.lines('line.mc-entry').length,5);
    assert.ok(p.labels().includes('Bot A, Bot B, Bot C +2 · SL 95'),p.labels().join('|'));
    assert.ok(p.legendRows().includes('Bot A, Bot B, Bot C +2 · TP 120'));
  });
  await withPage({levels:levelsBody([position({lots_match_position:false,avg_price:'100.9'})])},async p=>{
    await p.tick();
    assert.equal(p.lines('line.mc-avg').length,1);assert.ok(p.legendRows().includes('Lot quantities do not match the position; average line shown'));
  });
});

test('lines: a far level becomes an edge marker, the price range keeps at least half of the plot for the candles, nothing is dropped',async()=>{
  await withPage({levels:levelsBody([position({lots:[lot(1,{entry_price:'101.5',stop_loss:'1',take_profit:'300'})]})])},async p=>{
    await p.tick();
    const edges=p.lines('line.mc-edge');
    assert.equal(edges.length,2);
    assert.ok(edges.some(item=>item.classList.contains('mc-tp'))&&edges.some(item=>item.classList.contains('mc-sl')));
    const labels=p.labels();
    assert.ok(labels.includes('▲ Bot A · TP 300 · above range'),labels.join('|'));assert.ok(labels.includes('▼ Bot A · SL 1 · below range'));
    assert.ok(p.legendRows().includes('Bot A · TP 300 · above range')&&p.legendRows().includes('Bot A · SL 1 · below range'));
    const grid=[...p.svg.querySelectorAll('.mc-grid-group text')].map(item=>Number(item.textContent));
    assert.ok(Math.max(...grid)<112&&Math.min(...grid)>88,'the grid still follows the candles: '+grid);
    assert.equal(p.lines('line.mc-entry').length,1,'the near entry is a normal line');
    const ys=p.labels().length;assert.equal(ys,3);
  });
  await withPage({levels:levelsBody([position({lots:[lot(1,{entry_price:'101.5',stop_loss:'95',take_profit:'120'})]})])},async p=>{
    await p.tick();
    assert.equal(p.lines('line.mc-edge').length,0,'a nearby target widens the range instead');
    const grid=[...p.svg.querySelectorAll('.mc-grid-group text')].map(item=>Number(item.textContent));assert.ok(Math.max(...grid)>=120);
    const tp=Number(p.svg.querySelector('line.mc-tp').getAttribute('y1')),entry=Number(p.svg.querySelector('line.mc-entry').getAttribute('y1'));assert.ok(tp<entry,'a higher price is drawn higher');
  });
});

test('lines: labels never overlap, at most 30 lines are drawn and the rest is counted in the legend',async()=>{
  const lots=Array.from({length:12},(_,index)=>lot(index+1,{entry_price:String(100+index*0.5),stop_loss:String(91+index*0.5),take_profit:String(106+index*0.5)}));
  await withPage({levels:levelsBody([position({quantity:'6',avg_price:'103',lots})])},async p=>{
    await p.tick();
    assert.equal(p.lines('.mc-level').length,30);
    assert.equal(p.legendRows().length,37+1);assert.equal(p.legendRows().at(-1),'more lines not drawn: 7');
    const ys=[...p.svg.querySelectorAll('.mc-level-label')].map(item=>Number(item.getAttribute('y'))).sort((a,b)=>a-b);
    assert.equal(ys.length,30);
    const gaps=ys.slice(1).map((value,index)=>value-ys[index]);
    assert.ok(Math.min(...gaps)>=9.5,'label spacing: '+Math.min(...gaps));
  });
  await withPage({levels:levelsBody([position({lots:[lot(1,{entry_price:'100',stop_loss:'100.1',take_profit:'100.2'})]})])},async p=>{
    await p.tick();
    const ys=[...p.svg.querySelectorAll('.mc-level-label')].map(item=>Number(item.getAttribute('y'))).sort((a,b)=>a-b);
    assert.deepEqual(ys.length,3);assert.ok(ys[1]-ys[0]>=11.99&&ys[2]-ys[1]>=11.99,'close prices keep readable labels: '+ys);
  });
});

test('lifecycle: a closed position leaves the next levels answer, so its lines, legend rows and chip go; the chart stays',async()=>{
  let held=true;
  await withPage({levels:()=>levelsBody(held?[position()]:[])},async p=>{
    await p.tick();
    assert.ok(p.lines('.mc-level').length>0);assert.equal(p.chips.querySelectorAll('button').length,1);
    held=false;await p.tick(16000);
    assert.equal(p.lines('.mc-level').length,0);assert.equal(p.legend.querySelectorAll('li').length,0);assert.equal(p.q('#marketChartLevelsTitle').hidden,true);
    assert.equal(p.chips.querySelectorAll('button').length,0);assert.ok(p.q('#mcHeld').hidden);
    assert.equal(p.candles(),5,'the chart is always visible');
    await p.tick(20000);assert.equal(p.paths('/api/positions/levels').length,2,'with nothing held the levels cadence is 60 s');
  });
});

test('lines: a failed levels read keeps the chart, drops the lines and says why; a bot switch clears lines at once and reloads',async()=>{
  let mode='ok';
  await withPage({levels:()=>{if(mode==='fail')throw apiError('RETRY_TRANSACTION',409);return levelsBody([position()]);}},async p=>{
    await p.tick();assert.ok(p.lines('.mc-level').length>0);
    mode='fail';await p.tick(16000);
    assert.equal(p.lines('.mc-level').length,0,'no line without a current answer');assert.equal(p.candles(),5);
    assert.ok(p.legendRows().includes('Position lines unavailable (RETRY_TRANSACTION)'));
    mode='ok';await p.tick(130000);assert.ok(p.lines('.mc-level').length>0);
    assert.ok(!p.legendRows().some(row=>row.includes('unavailable')));
    // Bot switch.
    const before=p.paths('/api/positions/levels').length;
    p.w.eval("var selectedBot='b9';");
    p.q('#botSwitcher').dispatchEvent(new p.w.Event('change'));
    assert.equal(p.lines('.mc-level').length,0,'lines go at once');assert.equal(p.chips.querySelectorAll('button').length,0);
    assert.equal(p.paths('/api/positions/levels').length,before,'the reload waits one turn');
    await settle();assert.equal(p.paths('/api/positions/levels').length,before+1);assert.ok(p.lines('.mc-level').length>0);
    p.w.eval("var selectedBot='all';");p.q('#botSwitcher').dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.calls.filter(call=>call.path==='/api/positions/levels').at(-1).options.botId,'all');
  });
});
test('persistence: the last symbol and interval are restored; garbage is ignored; a blocked storage still renders the defaults',async()=>{
  await withPage({prefs:{symbol:'ETHUSDT',interval:'4h'}},async p=>{
    assert.equal(p.input.value,'ETHUSDT');assert.equal(p.select.value,'4h');assert.equal(p.interval('4h').getAttribute('aria-pressed'),'true');assert.equal(p.symbolBadge.textContent,'BINANCE:ETHUSDT');
    await p.tick();assert.equal(p.paths('/api/market/ohlcv')[0],'/api/market/ohlcv?symbol=ETHUSDT&interval=4h&limit=1000');
    p.select.value='1w';p.select.dispatchEvent(new p.w.Event('change',{bubbles:true}));
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem(KEY)),{symbol:'ETHUSDT',interval:'1w',indicators:DEFAULT_INDICATORS});
    p.type('sol');p.key('Enter');
    assert.deepEqual(JSON.parse(p.w.localStorage.getItem(KEY)),{symbol:'SOLUSDT',interval:'1w',indicators:DEFAULT_INDICATORS});
    await settle();
  });
  for(const garbage of ['not json','null','[]','{"symbol":"eth/usdt","interval":"2w"}','{"symbol":"../x","interval":7}','{"symbol":"ABC","interval":"1d"}']){
    await withPage({prefs:garbage},async p=>{
      await p.tick();
      assert.equal(p.paths('/api/market/ohlcv')[0],'/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000',garbage);assert.equal(p.select.value,'1d');
    });
  }
  await withPage({storage:'throw'},async p=>{
    await p.tick();
    assert.equal(p.paths('/api/market/ohlcv')[0],'/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000');assert.equal(p.candles(),5);
    p.type('eth');p.key('Enter');await settle();
    assert.equal(p.paths('/api/market/ohlcv').at(-1),'/api/market/ohlcv?symbol=ETHUSDT&interval=1d&limit=1000','selecting still works without storage');
    await settle();
  });
});

test('gap meta line, partial history text and exact strings in tooltips',async()=>{
  await withPage({ohlcv:payload(bars(3),{gaps:{count:2,missing_minutes:9,ranges:[],truncated:false}})},async p=>{
    await p.tick();
    assert.ok(p.meta.textContent.endsWith(' · 2 gaps · 9 missing 1m bars in this window'),p.meta.textContent);
  });
  await withPage({},async p=>{await p.tick();assert.ok(!p.meta.textContent.includes('gaps'));assert.ok(!p.meta.textContent.includes('Partial'));});
});

test('flat prices and one bar still render finite geometry',async()=>{
  await withPage({ohlcv:payload([bar(T0-HOUR,{open:'100',high:'100',low:'100',close:'100',volume:'0'})])},async p=>{
    await p.tick();
    const values=[...p.svg.querySelectorAll('[y],[y1],[y2],[x],[x1],[x2],[height],[width]')].flatMap(element=>[...element.attributes].filter(attribute=>/^(x|y|x1|x2|y1|y2|width|height)$/.test(attribute.name)).map(attribute=>Number(attribute.value)));
    assert.ok(values.length>10&&values.every(Number.isFinite),'finite geometry');
    assert.equal(p.candles(),1);
  });
});

test('time axis: a bucket with no stored minutes leaves an empty slot between candles',async()=>{
  const list=[bar(T0-4*HOUR),bar(T0-3*HOUR),bar(T0-HOUR)];
  await withPage({ohlcv:payload(list,{interval_ms:HOUR})},async p=>{
    await p.tick();
    const xs=[...p.svg.querySelectorAll('g.mc-bar rect.mc-candle')].map(rect=>Number(rect.getAttribute('x'))+Number(rect.getAttribute('width'))/2);
    assert.equal(xs.length,3);
    const step=xs[1]-xs[0];
    assert.ok(Math.abs((xs[2]-xs[1])-2*step)<0.05,'the missing hour is one empty slot wide');
  });
});

test('Thai: every literal has a pair and every pair is shown; pairs are unique and collision-free',async()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.localStorage.setItem('robotLanguage','th');
    w.eval(publicFile('i18n.js')+';window.__pairs=uiPairs;window.__mine=marketChartPairs;');
    const mine=[...w.__mine],others=w.__pairs.filter(pair=>!w.__mine.includes(pair));
    const english=new Set(mine.map(pair=>pair[0])),thai=new Set(mine.map(pair=>pair[1]));
    assert.equal(english.size,mine.length,'duplicate English key');assert.equal(thai.size,mine.length,'duplicate Thai text');
    for(const [en,th] of mine){
      assert.notEqual(en,th);
      assert.deepEqual([...en.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...th.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),'placeholders differ: '+en);
    }
    for(const [en,th] of others)for(const text of [en,th])assert.ok(!english.has(text)&&!thai.has(text),'collides with an existing pair: '+text);
    for(const bare of ['Symbol','Source','TF','Timeframe'])assert.ok(!english.has(bare),'bare word would collide with existing pairs: '+bare);
    // Shown texts: literals in the chart script, plus the static texts and placeholder of the panel.
    const source=publicFile('interactive-chart.js'),literals=new Set(['above range','below range']);
    for(const match of source.matchAll(/\b(?:T|tpl)\(\s*'([^'\n]*)'/g))literals.add(match[1]);
    assert.ok(literals.size>=20,'literal extraction found the texts: '+literals.size);
    for(const text of literals)assert.ok(english.has(text),'missing pair for literal: '+text);
    // The static texts come from the untranslated markup.
    const plain=new JSDOM(publicFile('index.html')).window,statics=new Set(),panel=plain.document.querySelector('#interactiveChartPanel');
    const walker=plain.document.createTreeWalker(panel,plain.NodeFilter.SHOW_TEXT);
    for(let item=walker.nextNode();item;item=walker.nextNode())if(item.textContent.trim())statics.add(item.textContent.trim());
    statics.add(panel.querySelector('#mcSymbolInput').getAttribute('placeholder'));
    for(const text of english)assert.ok(literals.has(text)||statics.has(text),'pair for text that is not shown: '+text);
    for(const text of statics)if(english.has(text))assert.notEqual(w.translate(text),text,'static text translated: '+text);
    plain.close();
  }finally{w.close();}
});

test('Thai page: static texts, status, badges and legend are Thai after a language switch; data stays raw',async()=>{
  const rows=[position({bot_label:'Held assets',lots:[lot(1,{entry_basis:'cost'}),lot(2,{entry_price:'102'})]})];
  await withPage({language:'th',prefs:{symbol:'BTCUSDT',interval:'1d'},ohlcv:payload(bars(3),{interval:'1d',stale:true,age_seconds:400,history_partial:true,
    gaps:{count:1,missing_minutes:2,ranges:[],truncated:false}}),levels:levelsBody(rows)},async p=>{
    assert.equal(p.q('#interactiveChartPanel h2').textContent,'กราฟตลาด');
    assert.equal(p.q('#marketChartRefresh').textContent,'รีเฟรชกราฟ');
    assert.equal(p.input.getAttribute('placeholder'),'พิมพ์เพื่อค้นหาสัญลักษณ์ Binance Spot');
    assert.equal(p.q('label[for="mcSymbolInput"]').textContent,'ค้นหาสัญลักษณ์');
    assert.equal(p.q('.mc-note').textContent,'ดูอย่างเดียว กราฟนี้ส่ง แก้ไข หรือปิดคำสั่งซื้อขายไม่ได้');
    await p.tick();await settle();
    assert.equal(p.status.textContent,'ข้อมูลเก่า: แท่งที่ปิดล่าสุดเก่า 400 วินาที (เกณฑ์ 180 วินาที)');
    assert.ok(p.meta.textContent.includes('3 แท่ง')&&p.meta.textContent.includes('ช่องว่าง 1 จุด')&&p.meta.textContent.includes('ประวัติไม่ครบ'));
    assert.equal(p.badge.textContent,'แหล่งข้อมูล: แท่ง Binance ที่เก็บไว้ (ฟีดของบอท)');
    assert.equal(p.q('#marketChartLevelsTitle').textContent,'เส้นของสถานะที่เปิดอยู่');
    assert.ok(p.svg.querySelector('title').textContent.includes('O 100.5 · H 110'),'prices and times stay raw');
    assert.ok(p.legendRows().some(row=>row.startsWith('Held assets · LONG 0.5 · ENTRY 101.5 #1 ')),'the bot label stays raw: '+p.legendRows());
    assert.ok(p.legendRows().includes('Held assets · AVG 101.5'));
    const language=p.q('#language');
    language.value='en';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.status.textContent,'Stale: latest closed bar is 400 s old (limit 180 s)');
    assert.equal(p.q('#interactiveChartPanel h2').textContent,'Market chart');assert.equal(p.q('#marketChartLevelsTitle').textContent,'Open position lines');
    assert.equal(p.badge.textContent,'Source: stored Binance bars (bot feed)');
    language.value='th';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.status.textContent,'ข้อมูลเก่า: แท่งที่ปิดล่าสุดเก่า 400 วินาที (เกณฑ์ 180 วินาที)');
    // Chart data is never translated: a chip or badge that equals an English pair stays as it is, a normal node still translates.
    p.symbolBadge.textContent='Held assets';p.q('#mcHeld .mc-label').textContent='Held assets';
    const control=p.d.createElement('p');control.textContent='Held assets';p.q('#mcHeld').after(control);await settle();
    assert.equal(p.symbolBadge.textContent,'Held assets','.mc-data is skipped by translateUI');
    assert.equal(control.textContent,'สินทรัพย์ที่ถืออยู่','a normal node is translated');
  });
});
test('a read that never answers does not block the scheduler for ever',async()=>{
  await withPage({ohlcv:()=>new Promise(()=>{})},async p=>{
    await p.tick();assert.equal(p.paths('/api/market/ohlcv').length,1);assert.equal(p.state(),'loading');
    await p.tick(30000);assert.equal(p.paths('/api/market/ohlcv').length,1,'still waiting inside the minute');
    await p.tick(31000);assert.equal(p.paths('/api/market/ohlcv').length,2,'a new read starts after a minute');
  });
});
// ---- Chart v3: indicators (two EMAs, ATR stop line, RSI, MACD), each on or off --------------------------------------------------
const REF=vm.runInNewContext(publicFile('chart-indicators.js')+'\n;ChartIndicators',{});
const DAY=86400000;
/** One bar per day ending at T0: a sine wave around 100, open = previous close. The forming variant is a REST answer with an open last bar. */
const trend=(count,{forming=false}={})=>{
  const closes=Array.from({length:count},(_,index)=>100+10*Math.sin(index/20));
  return closes.map((close,index)=>{
    const open=index===0?close:closes[index-1],last=forming&&index===count-1;
    return {time:T0-(count-index)*DAY,open:open.toFixed(2),high:(Math.max(open,close)+2).toFixed(2),low:(Math.min(open,close)-2).toFixed(2),close:close.toFixed(2),
      volume:'1',minutes:last?null:1440,complete:!last,...(last?{forming:true}:{})};
  });
};
const trendBody=(count,options)=>{
  const list=trend(count,options);
  return options?.forming?rest(list,{interval:'1d',price_tick:'0.01'}):payload(list,{interval:'1d',price_tick:'0.01'});
};
const numbersOf=(list,field)=>list.map(item=>Number(item[field]));
const fire=(p,element)=>element.dispatchEvent(new p.w.Event('change',{bubbles:true}));
const toggle=(p,id,on)=>{const box=p.q('#'+id);box.checked=on;fire(p,box);};
const edit=(p,id,value)=>{const field=p.q('#'+id);field.value=value;fire(p,field);};
const rowsOf=p=>[...p.d.querySelectorAll('#mcIndValues li')].map(item=>item.textContent);
const pointsOf=(root,selector)=>[...root.querySelectorAll(selector)].flatMap(item=>item.getAttribute('points').split(' ').map(pair=>pair.split(',').map(Number)));
const pointCount=(root,selector)=>pointsOf(root,selector).length;
const stored=p=>JSON.parse(p.w.localStorage.getItem(KEY));

test('drift: the display and fetch tables mirror the server intervals; the control markup mirrors the module limits and defaults',()=>{
  const source=sourceOf('interactive-chart.js');
  const table=pattern=>JSON.parse(source.match(pattern)[1].replaceAll("'",'"'));
  const display=table(/DISPLAY_BARS=Object\.freeze\((\{[^}]*\})\)/),btc=table(/BTC_STORED_LIMIT=Object\.freeze\((\{[^}]*\})\)/);
  const fetchLimit=Number(source.match(/FETCH_LIMIT=(\d+)/)[1]);
  assert.equal(MARKET.symbol,'BTCUSDT');assert.ok(source.includes("DEFAULT_SYMBOL='BTCUSDT'"));
  assert.deepEqual(Object.keys(display).sort(),Object.keys(SERVER_INTERVALS).sort());
  for(const [name,spec] of Object.entries(SERVER_INTERVALS)){
    assert.equal(display[name],spec.limit,'display bars '+name);
    assert.equal(fetchLimit,spec.cap,'fetch limit '+name);
    const wanted=spec.stored&&spec.limit<=spec.storedCap?Math.min(spec.cap,spec.storedCap):spec.cap;
    assert.equal(Object.hasOwn(btc,name)?btc[name]:fetchLimit,wanted,'BTCUSDT limit '+name);
    assert.equal(limitFor('BTCUSDT',name),wanted);
  }
  const dom=new JSDOM(publicFile('index.html')),d=dom.window.document;
  try{
    for(const field of d.querySelectorAll('[data-mc-ind-field]')){
      const limit=REF.LIMITS[field.dataset.mcIndField],[group,name]=field.dataset.mcIndField.split('.');
      assert.deepEqual([Number(field.getAttribute('min')),Number(field.getAttribute('max')),Number(field.getAttribute('step'))],[limit.min,limit.max,limit.step],field.id);
      assert.equal(field.getAttribute('value'),String(REF.DEFAULTS[group][name]),field.id+' default');
    }
    assert.equal(d.querySelectorAll('[data-mc-ind-field]').length,Object.keys(REF.LIMITS).length,'one input per limit');
    for(const box of d.querySelectorAll('[data-mc-ind-on]'))assert.equal(box.hasAttribute('checked'),REF.DEFAULTS[box.dataset.mcIndOn].on,box.id+' default');
  }finally{dom.window.close();}
});

test('indicator markup: a closed disclosure outside the data area, labelled controls, hidden panes, the value list before the chart, no inline style',()=>{
  const dom=new JSDOM(publicFile('index.html')),d=dom.window.document;
  try{
    const box=d.querySelector('#mcIndicators');
    assert.equal(box.tagName,'DETAILS');assert.ok(!box.open,'closed by default');assert.equal(box.closest('.mc-data'),null);
    assert.equal(box.querySelectorAll('fieldset').length,5);
    for(const checkbox of box.querySelectorAll('input[type="checkbox"]'))assert.ok(checkbox.closest('legend > label'),checkbox.id+' sits in its legend label');
    for(const field of box.querySelectorAll('input[type="number"]'))assert.ok(field.closest('label'),field.id+' has a label');
    assert.equal(new Set([...d.querySelectorAll('[id]')].map(item=>item.id)).size,d.querySelectorAll('[id]').length,'unique ids');
    assert.ok(d.querySelector('#mcRsiPane').hidden&&d.querySelector('#mcMacdPane').hidden);
    assert.equal(d.querySelector('#mcRsiSvg').getAttribute('viewBox'),'0 0 900 150');assert.equal(d.querySelector('#mcMacdSvg').getAttribute('viewBox'),'0 0 900 170');
    const values=d.querySelector('#interactiveChart #mcIndValues'),chart=d.querySelector('#marketChartSvg');
    assert.ok(values&&(values.compareDocumentPosition(chart)&dom.window.Node.DOCUMENT_POSITION_FOLLOWING),'the value list comes before the chart');
    assert.equal(d.querySelector('#interactiveChartPanel [style]'),null);
    assert.equal(box.querySelectorAll('form,a').length,0);
    assert.equal(box.querySelector('#mcIndNote').getAttribute('role'),'status');
  }finally{dom.window.close();}
});

test('requests: the limit follows the symbol and interval; toggling or editing an indicator never reads again',async()=>{
  await withPage({ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    assert.ok(p.paths('/api/market/ohlcv').includes('/api/market/ohlcv?symbol=BTCUSDT&interval=1d&limit=1000'));
    const before=p.calls.length;
    toggle(p,'mcIndEma1On',false);toggle(p,'mcIndRsiOn',true);toggle(p,'mcIndMacdOn',true);edit(p,'mcIndEma2Period','150');edit(p,'mcIndAtrMult','3.5');edit(p,'mcIndRsiPeriod','1');
    p.q('#mcIndReset').click();await settle();
    assert.equal(p.calls.length,before,'no request for an indicator change');
  });
  for(const [symbol,interval,limit] of [['BTCUSDT','1h',720],['BTCUSDT','2h',360],['ETHUSDT','2h',1000],['BTCUSDT','1w',1000],['BTCUSDT','1m',1000]]){
    await withPage({prefs:{symbol,interval}},async p=>{
      await p.tick();
      assert.equal(p.paths('/api/market/ohlcv')[0],'/api/market/ohlcv?symbol='+symbol+'&interval='+interval+'&limit='+limit);
    });
  }
});

test('defaults on 1000 daily bars: 365 candles, EMA 50, EMA 200 and the ATR stop line cover every visible bar, three value rows, panes hidden',async()=>{
  const list=trend(1000);
  await withPage({ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    assert.equal(p.candles(),365);assert.ok(p.meta.textContent.startsWith('365 bars'),p.meta.textContent);
    for(const kind of ['ema1','ema2','atr'])assert.equal(pointCount(p.svg,'polyline.mc-ind-'+kind),365,kind+' covers all visible bars');
    assert.ok(p.q('#mcRsiPane').hidden&&p.q('#mcMacdPane').hidden);
    const closes=numbersOf(list,'close'),highs=numbersOf(list,'high'),lows=numbersOf(list,'low');
    const atr=REF.atr(highs,lows,closes,14);
    assert.deepEqual(rowsOf(p),['EMA 50 · '+REF.ema(closes,50).at(-1).toFixed(2),'EMA 200 · '+REF.ema(closes,200).at(-1).toFixed(2),
      'ATR SL 2.0×ATR14 · '+(closes.at(-1)-2*atr.at(-1)).toFixed(2)]);
    for(const element of p.svg.querySelectorAll('polyline'))assert.match(element.getAttribute('points'),/^-?\d+(\.\d+)?,-?\d+(\.\d+)?( -?\d+(\.\d+)?,-?\d+(\.\d+)?)+$/);
    for(const [x,y] of pointsOf(p.svg,'polyline')){assert.ok(y>=10&&y<=300,'y '+y);assert.ok(x>=8&&x<=820,'x '+x);}
    const tooltip=p.svg.querySelector('g.mc-bar:last-of-type title').textContent;
    assert.ok(tooltip.includes(' · EMA 50 '+REF.ema(closes,50).at(-1).toFixed(2)+' · EMA 200 '+REF.ema(closes,200).at(-1).toFixed(2)+' · ATR SL '),tooltip);
    assert.ok(!tooltip.includes('RSI')&&!tooltip.includes('MACD'),'only indicators that are on');
    assert.equal(p.d.querySelectorAll('#interactiveChartPanel [style]').length,0);
    for(const element of p.svg.querySelectorAll('polyline'))assert.equal(element.getAttribute('style'),null);
  });
});

test('short history: nothing is drawn before the first defined bar and each row says how many bars it needs',async()=>{
  await withPage({},async p=>{
    await p.tick();
    assert.equal(p.svg.querySelectorAll('.mc-ind-line').length,0);
    assert.deepEqual(rowsOf(p),['EMA 50 · — · needs 50 bars','EMA 200 · — · needs 200 bars','ATR SL 2.0×ATR14 · — · needs 14 bars']);
    assert.equal(p.svg.querySelector('g.mc-bar title').textContent,'2026-10-04 00:00 UTC · O 100.5 · H 110 · L 90.25 · C 105 · V 3.5 · 60 min','no indicator text in the tooltip');
  });
});

test('toggles: each indicator has its own switch; the choice is stored per browser and restored',async()=>{
  await withPage({ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    const before=p.calls.length;
    toggle(p,'mcIndEma1On',false);
    assert.equal(p.svg.querySelectorAll('.mc-ind-ema1').length,0);assert.ok(p.svg.querySelectorAll('.mc-ind-ema2').length>0);
    assert.equal(rowsOf(p).length,2);assert.ok(rowsOf(p)[0].startsWith('EMA 200'));
    assert.equal(stored(p).indicators.ema1.on,false);assert.equal(p.calls.length,before);
    toggle(p,'mcIndEma2On',false);toggle(p,'mcIndAtrOn',false);
    assert.equal(p.svg.querySelectorAll('.mc-ind-line').length,0);assert.equal(rowsOf(p).length,0);
    toggle(p,'mcIndAtrOn',true);assert.ok(p.svg.querySelectorAll('.mc-ind-atr').length>0);
  });
  await withPage({ohlcv:trendBody(1000),prefs:{symbol:'BTCUSDT',interval:'1d',indicators:{...DEFAULT_INDICATORS,ema1:{on:false,period:50}}}},async p=>{
    assert.equal(p.q('#mcIndEma1On').checked,false);assert.equal(p.q('#mcIndEma2On').checked,true);assert.equal(p.q('#mcIndRsiOn').checked,false);
    await p.tick();
    assert.equal(p.svg.querySelectorAll('.mc-ind-ema1').length,0);assert.ok(p.svg.querySelectorAll('.mc-ind-ema2').length>0);
  });
});

test('inputs: a valid length is used at once; an invalid one is replaced by the last valid value with a note; a later valid change clears the note',async()=>{
  const closes=numbersOf(trend(1000),'close');
  await withPage({ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    edit(p,'mcIndEma1Period','20');
    assert.equal(rowsOf(p)[0],'EMA 20 · '+REF.ema(closes,20).at(-1).toFixed(2));assert.equal(stored(p).indicators.ema1.period,20);assert.equal(p.q('#mcIndNote').textContent,'');
    edit(p,'mcIndEma1Period','1');
    assert.equal(p.q('#mcIndEma1Period').value,'20');assert.equal(p.q('#mcIndNote').textContent,'Allowed range 2–500; kept 20');assert.equal(stored(p).indicators.ema1.period,20);
    edit(p,'mcIndEma1Period','abc');assert.equal(p.q('#mcIndEma1Period').value,'20');assert.equal(p.q('#mcIndNote').textContent,'Allowed range 2–500; kept 20');
    edit(p,'mcIndAtrMult','3');
    assert.ok(rowsOf(p)[2].startsWith('ATR SL 3.0×ATR14 · '),rowsOf(p)[2]);assert.equal(p.q('#mcIndNote').textContent,'');
    edit(p,'mcIndAtrMult','0.4');
    assert.equal(p.q('#mcIndAtrMult').value,'3');assert.equal(p.q('#mcIndNote').textContent,'Allowed range 0.5–10; kept 3');assert.equal(stored(p).indicators.atr.multiplier,3);
    edit(p,'mcIndAtrMult','2.35');assert.equal(stored(p).indicators.atr.multiplier,2.4);assert.equal(p.q('#mcIndAtrMult').value,'2.4');assert.ok(rowsOf(p)[2].startsWith('ATR SL 2.4×ATR14 · '));
    toggle(p,'mcIndMacdOn',true);
    edit(p,'mcIndMacdFast','30');
    assert.equal(p.q('#mcIndMacdFast').value,'12');assert.equal(p.q('#mcIndNote').textContent,'Fast length must be below slow length');assert.equal(stored(p).indicators.macd.fast,12);
    edit(p,'mcIndMacdSlow','12');assert.equal(p.q('#mcIndMacdSlow').value,'26','slow may not drop to the fast length');
    edit(p,'mcIndMacdSlow','40');
    assert.equal(p.q('#mcIndNote').textContent,'');assert.equal(stored(p).indicators.macd.slow,40);
    assert.ok(p.svg.querySelectorAll('polyline').length>0,'the chart is intact after bad input');
  });
});

test('RSI pane: 70 and 30 guides, a title with the length, values inside the pane; MACD pane: histogram bars aligned with the candles, also on a narrow chart',async()=>{
  const closes=numbersOf(trend(1000),'close');
  await withPage({ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    toggle(p,'mcIndRsiOn',true);
    const pane=p.q('#mcRsiPane'),svg=p.q('#mcRsiSvg');
    assert.equal(pane.hidden,false);assert.equal(svg.querySelectorAll('line.mc-ind-guide').length,2);
    assert.equal(svg.querySelector('.mc-ind-title').textContent,'RSI 14');
    assert.deepEqual([...svg.querySelectorAll('text.mc-axis')].map(item=>item.textContent),['70','50','30']);
    assert.equal(pointCount(svg,'polyline.mc-ind-rsi'),365);
    for(const [,y] of pointsOf(svg,'polyline'))assert.ok(y>=8&&y<=142,'rsi y '+y);
    assert.equal(rowsOf(p).at(-1),'RSI 14 · '+REF.rsi(closes,14).at(-1).toFixed(2));
    toggle(p,'mcIndRsiOn',false);assert.equal(pane.hidden,true);assert.equal(svg.childNodes.length,0);
    toggle(p,'mcIndMacdOn',true);
    const macdPane=p.q('#mcMacdPane'),macdSvg=p.q('#mcMacdSvg'),macd=REF.macd(closes,12,26,9);
    assert.equal(macdPane.hidden,false);assert.equal(macdSvg.querySelector('.mc-ind-title').textContent,'MACD 12 26 9');
    assert.equal(macdSvg.querySelectorAll('rect.mc-ind-hist').length,macd.histogram.slice(-365).filter(value=>value!==null).length);
    assert.equal(macdSvg.querySelectorAll('polyline.mc-ind-macd').length,1);assert.equal(macdSvg.querySelectorAll('polyline.mc-ind-signal').length,1);
    assert.ok(macdSvg.querySelector('.mc-ind-zero'));
    for(const [,y] of pointsOf(macdSvg,'polyline'))assert.ok(y>=8&&y<=162,'macd y '+y);
    assert.ok(rowsOf(p).at(-1).startsWith('MACD 12 26 9 · '));
    const mid=item=>Number(item.getAttribute('x'))+Number(item.getAttribute('width'))/2;
    assert.ok(Math.abs(mid([...macdSvg.querySelectorAll('rect.mc-ind-hist')].at(-1))-mid([...p.svg.querySelectorAll('g.mc-bar rect.mc-candle')].at(-1)))<=0.02,'last histogram bar sits under the last candle');
  });
  const narrow=setup({ohlcv:trendBody(1000),prefs:{symbol:'BTCUSDT',interval:'1d',indicators:{...DEFAULT_INDICATORS,macd:{on:true,fast:12,slow:26,signal:9}}}});
  try{
    narrow.svg.getBoundingClientRect=()=>({width:360});
    await narrow.tick();
    assert.equal(narrow.candles(),90);
    const mid=item=>Number(item.getAttribute('x'))+Number(item.getAttribute('width'))/2,rects=[...narrow.q('#mcMacdSvg').querySelectorAll('rect.mc-ind-hist')];
    assert.equal(rects.length,90);
    assert.ok(Math.abs(mid(rects.at(-1))-mid([...narrow.svg.querySelectorAll('g.mc-bar rect.mc-candle')].at(-1)))<=0.02);
    assert.ok(Math.abs(mid(rects[0])-mid(narrow.svg.querySelector('g.mc-bar rect.mc-candle')))<=0.02);
  }finally{narrow.w.close();}
});

test('panes that are on but too short say how many bars they need',async()=>{
  await withPage({prefs:{symbol:'BTCUSDT',interval:'1d',indicators:{...DEFAULT_INDICATORS,rsi:{on:true,period:14},macd:{on:true,fast:12,slow:26,signal:9}}}},async p=>{
    await p.tick();
    assert.equal(p.q('#mcRsiPane').hidden,false);assert.equal(p.q('#mcMacdPane').hidden,false);
    assert.equal(p.q('#mcRsiSvg').querySelector('.mc-ind-needs').textContent,'needs 15 bars');
    assert.equal(p.q('#mcMacdSvg').querySelector('.mc-ind-needs').textContent,'needs 34 bars');
    assert.equal(p.q('#mcRsiSvg').querySelectorAll('polyline').length,0);assert.equal(p.q('#mcMacdSvg').querySelectorAll('rect').length,0);
    assert.deepEqual(rowsOf(p).slice(-2),['RSI 14 · — · needs 15 bars','MACD 12 26 9 · — · needs 34 bars']);
  });
});

test('forming bar: the last segment of every line is dashed and separate, the rows say so, the last histogram bar is faded',async()=>{
  await withPage({ohlcv:trendBody(1000,{forming:true}),prefs:{symbol:'BTCUSDT',interval:'1d',indicators:{...DEFAULT_INDICATORS,macd:{on:true,fast:12,slow:26,signal:9},rsi:{on:true,period:14}}}},async p=>{
    await p.tick();
    for(const kind of ['ema1','ema2','atr']){
      assert.equal(p.svg.querySelectorAll('polyline.mc-ind-forming.mc-ind-'+kind).length,1,kind);
      assert.equal(pointCount(p.svg,'polyline.mc-ind-forming.mc-ind-'+kind),2);
      assert.equal(pointCount(p.svg,'polyline.mc-ind-'+kind),366,'the dashed segment repeats the second-to-last point');
    }
    for(const row of p.d.querySelectorAll('#mcIndValues li')){assert.ok(row.classList.contains('mc-iv-forming'));assert.ok(row.textContent.endsWith(' · Forming bar'),row.textContent);}
    const hist=[...p.q('#mcMacdSvg').querySelectorAll('rect.mc-ind-hist')];
    assert.ok(hist.at(-1).classList.contains('mc-incomplete'));assert.ok(!hist.at(-2).classList.contains('mc-incomplete'));
    assert.equal(p.q('#mcMacdSvg').querySelectorAll('polyline.mc-ind-forming').length,2);assert.equal(p.q('#mcRsiSvg').querySelectorAll('polyline.mc-ind-forming').length,1);
    assert.ok(p.svg.querySelector('g.mc-bar:last-of-type title').textContent.includes(' · Forming bar'));
  });
});

test('range: an indicator far from the candles is left out instead of squeezing them; drawn points stay inside the plot',async()=>{
  const closes=Array.from({length:1000},(_,index)=>index<900?200:100);
  const list=closes.map((close,index)=>({time:T0-(1000-index)*DAY,open:close.toFixed(2),high:(close+2).toFixed(2),low:(close-2).toFixed(2),close:close.toFixed(2),volume:'1',minutes:1440,complete:true}));
  await withPage({ohlcv:payload(list,{interval:'1d',price_tick:'0.01'})},async p=>{
    p.svg.getBoundingClientRect=()=>({width:400});
    await p.tick();
    assert.equal(p.candles(),100);
    assert.equal(p.svg.querySelectorAll('polyline.mc-ind-ema2').length,0,'EMA 200 is far above the visible candles');
    for(const [,y] of pointsOf(p.svg,'polyline'))assert.ok(y>=10&&y<=300,'y '+y);
    const wicks=[...p.svg.querySelectorAll('line.mc-wick')].flatMap(item=>[Number(item.getAttribute('y1')),Number(item.getAttribute('y2'))]);
    assert.ok(Math.max(...wicks)-Math.min(...wicks)>=130,'the candles keep at least about half of the plot: '+(Math.max(...wicks)-Math.min(...wicks)));
    assert.equal(rowsOf(p)[1].startsWith('EMA 200 · '),true,'the value row still shows the value');
  });
});

test('reset: every control, the stored choice and the note go back to the defaults',async()=>{
  await withPage({ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    toggle(p,'mcIndEma1On',false);edit(p,'mcIndEma2Period','120');toggle(p,'mcIndRsiOn',true);toggle(p,'mcIndMacdOn',true);edit(p,'mcIndAtrMult','4');edit(p,'mcIndAtrPeriod','1');
    assert.notEqual(p.q('#mcIndNote').textContent,'');
    p.q('#mcIndReset').click();
    assert.deepEqual(stored(p).indicators,DEFAULT_INDICATORS);assert.equal(p.q('#mcIndNote').textContent,'');
    assert.equal(p.q('#mcIndEma1On').checked,true);assert.equal(p.q('#mcIndEma2Period').value,'200');assert.equal(p.q('#mcIndRsiOn').checked,false);assert.equal(p.q('#mcIndMacdOn').checked,false);
    assert.equal(p.q('#mcIndAtrMult').value,'2');assert.equal(p.q('#mcIndAtrPeriod').value,'14');
    assert.ok(p.q('#mcRsiPane').hidden&&p.q('#mcMacdPane').hidden);assert.equal(rowsOf(p).length,3);
  });
});

test('garbage in storage falls back to the defaults field by field; blocked storage still renders and toggles',async()=>{
  for(const indicators of ['x',{v:2},{v:1,ema1:{on:'yes',period:9999}},[],null,{v:1,macd:{on:true,fast:40,slow:26,signal:9}}]){
    await withPage({prefs:{symbol:'BTCUSDT',interval:'1d',indicators}},async p=>{
      const macd=indicators?.macd;
      assert.equal(p.q('#mcIndEma1On').checked,true,JSON.stringify(indicators));assert.equal(p.q('#mcIndEma1Period').value,'50');assert.equal(p.q('#mcIndEma2Period').value,'200');
      assert.equal(p.q('#mcIndRsiOn').checked,false);assert.equal(p.q('#mcIndMacdOn').checked,Boolean(macd));
      assert.equal(p.q('#mcIndMacdFast').value,'12','an impossible fast and slow pair is reset');assert.equal(p.q('#mcIndMacdSlow').value,'26');
      await p.tick();assert.equal(p.candles(),5);
    });
  }
  await withPage({storage:'throw',ohlcv:trendBody(1000)},async p=>{
    await p.tick();
    assert.equal(p.candles(),365);assert.ok(p.svg.querySelectorAll('polyline.mc-ind-ema1').length>0);
    assert.doesNotThrow(()=>toggle(p,'mcIndEma1On',false));
    assert.equal(p.svg.querySelectorAll('polyline.mc-ind-ema1').length,0,'the toggle works without storage');
  });
});

test('without the indicator module the plain chart still works and nothing indicator-related is stored',async()=>{
  await withPage({indicators:false},async p=>{
    assert.equal(p.q('#mcIndicators').hidden,true);assert.ok(p.q('#mcRsiPane').hidden&&p.q('#mcMacdPane').hidden);
    await p.tick();
    assert.equal(p.candles(),5);assert.equal(p.q('#mcIndValues').childNodes.length,0);assert.equal(p.svg.querySelectorAll('polyline').length,0);
    p.interval('15m').click();await settle();
    assert.deepEqual(stored(p),{symbol:'BTCUSDT',interval:'15m'});
  });
});

test('Thai: the indicator texts and notes are Thai, the value rows keep their technical names, a language switch redraws the note',async()=>{
  await withPage({language:'th',ohlcv:trendBody(1000)},async p=>{
    assert.equal(p.q('#mcIndicators summary').textContent,'อินดิเคเตอร์');
    assert.equal(p.q('#mcIndEma1On').closest('label').textContent.trim(),'EMA เส้นที่ 1');
    assert.equal(p.q('#mcIndEma1Period').closest('label').querySelector('span').textContent,'ความยาว');
    assert.equal(p.q('#mcIndReset').textContent,'รีเซ็ตอินดิเคเตอร์');
    assert.equal(p.q('#mcIndAtrMult').closest('label').querySelector('span').textContent,'ตัวคูณ (× ATR)');
    await p.tick();await settle();
    assert.ok(rowsOf(p)[0].startsWith('EMA 50 · '),'value rows keep the raw name');
    edit(p,'mcIndEma1Period','1');
    assert.equal(p.q('#mcIndNote').textContent,'ช่วงที่ใช้ได้ 2–500 คงค่า 50');
    const language=p.q('#language');
    language.value='en';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.q('#mcIndNote').textContent,'Allowed range 2–500; kept 50');assert.equal(p.q('#mcIndicators summary').textContent,'Indicators');
    language.value='th';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.q('#mcIndNote').textContent,'ช่วงที่ใช้ได้ 2–500 คงค่า 50');
    toggle(p,'mcIndMacdOn',true);edit(p,'mcIndMacdFast','30');
    assert.equal(p.q('#mcIndNote').textContent,'ความยาวเส้นเร็วต้องน้อยกว่าความยาวเส้นช้า');
  });
});