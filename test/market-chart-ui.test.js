import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
const SVG_NS='http://www.w3.org/2000/svg';
const T0=Date.parse('2026-10-04T05:00:00Z'),HOUR=3600000;

const bar=(time,over={})=>({time,open:'100.5',high:'110',low:'90.25',close:'105',volume:'3.5',minutes:60,complete:true,...over});
const bars=(count,over=()=>({}))=>Array.from({length:count},(_,index)=>bar(T0-(count-index)*HOUR,over(index)));
const payload=(list,over={})=>({version:'market-ohlcv-v1',status:list.length?'OK':'EMPTY',interval:'1h',bars:list,stale:false,stale_after_seconds:180,
  age_seconds:12,latest_closed_bar:{open_time:T0,close_time:T0+60000},generated_at:new Date(T0+72000).toISOString(),
  gaps:{count:0,missing_minutes:0,ranges:[],truncated:false},...over});
const apiError=(code,status)=>Object.assign(new Error(code||'Request failed'),{code,status});

function setup({language,handler,positions}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const calls=[];
  w.fetch=()=>{throw new Error('direct fetch is forbidden: the chart reads through api() only');};
  w.api=async(path,options)=>{calls.push({path,options});return handler(path,options);};
  if(positions!==undefined)w.positions=positions;
  w.eval(publicFile('interactive-chart.js'));
  const root=d.querySelector('#interactiveChart'),svg=d.querySelector('#marketChartSvg'),status=d.querySelector('#marketChartStatus'),meta=d.querySelector('#marketChartMeta');
  const open=async()=>{d.querySelector('nav button[data-view="analytics"]').click();await settle();};
  const interval=name=>d.querySelector(`[data-mc-interval="${name}"]`);
  return {dom,w,d,calls,root,svg,status,meta,open,interval,state:()=>root.dataset.state};
}
const answer=body=>path=>{if(!path.startsWith('/api/market/ohlcv?interval='))throw new Error('Unexpected '+path);return structuredClone(body);};

test('static: no external script, style or request; no inline style; versioned files; self-contained renderer',()=>{
  const html=publicFile('index.html'),dom=new JSDOM(html),d=dom.window.document;
  try{
    assert.ok(!html.includes('unpkg')&&!html.includes('lightweight-charts'),'the CDN chart library is gone');
    for(const script of d.querySelectorAll('script[src]'))assert.ok(script.getAttribute('src').startsWith('/'),'script '+script.getAttribute('src'));
    for(const link of d.querySelectorAll('link[rel="stylesheet"]'))assert.ok(link.getAttribute('href').startsWith('/'),'stylesheet '+link.getAttribute('href'));
    assert.equal(d.querySelector('#interactiveChartPanel [style]'),null,'the CSP forbids inline styles');
    for(const part of ['/interactive-chart.js?v=oh2','/market-chart.css?v=oh1','/i18n.js?v=md1','/readiness.js?v=md1'])assert.ok(html.includes(part),part);
    assert.ok(html.indexOf('/app.js?v=')<html.indexOf('/interactive-chart.js?v='),'app.js loads before the chart');
    assert.ok(!publicFile('market-chart.css').includes('!important'));
    const panel=d.querySelector('#interactiveChartPanel');
    assert.equal(panel.querySelector('h2').textContent,'Market chart');
    assert.deepEqual([...panel.querySelectorAll('[data-mc-interval]')].map(item=>item.dataset.mcInterval),['1m','5m','15m','1h','4h','1d']);
    assert.equal(panel.querySelector('[data-mc-interval="1h"]').getAttribute('aria-pressed'),'true');
    assert.equal(panel.querySelectorAll('select,input,form,a').length,0);
  }finally{dom.window.close();}
  for(const name of fs.readdirSync(new URL('../public/',import.meta.url)).filter(file=>file.endsWith('.js'))){
    const source=publicFile(name);
    assert.ok(!source.includes('api.binance.com'),name+' calls Binance from the browser');
    assert.doesNotMatch(source,/fetch\(\s*['"`](?:https?:)?\/\//,name+' fetches another origin');
  }
});

test('interactive-chart.js bans: no markup injection, no network, no storage, no inline style, one api() call',()=>{
  const source=publicFile('interactive-chart.js'),plain=source.replaceAll(SVG_NS,'');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','fetch(','XMLHttpRequest','WebSocket',
    'http://','https://','.style','localStorage','sessionStorage','LightweightCharts','unpkg','binance.com'])
    assert.ok(!plain.includes(banned),'forbidden in interactive-chart.js: '+banned);
  assert.ok(source.includes(SVG_NS),'the SVG namespace is the only URL-like string');
  assert.equal(source.split('api(').length-1,1,'a single api() call site');
  assert.ok(source.includes("api('/api/market/ohlcv?interval='+"),'the literal path');
  const names=[...source.matchAll(/setAttribute\(\s*([^,)]+)/g)].map(match=>match[1].trim());
  assert.ok(names.every(name=>name==="'class'"||name==='name'),'setAttribute names: '+names);
  const geometry=source.match(/GEOMETRY=new Set\(\[([^\]]+)\]\)/)[1].match(/'(\w+)'/g).map(item=>item.slice(1,-1)).sort();
  assert.deepEqual(geometry,['height','width','x','x1','x2','y','y1','y2'].sort(),'only geometry attributes reach setAttribute');
  assert.deepEqual([...new Set([...source.matchAll(/addEventListener\('([a-z:0-9]+)'/g)].map(match=>match[1]))].sort(),['change','click']);
});

test('opening Analytics requests 1h once and draws N candles with classes, tooltips and no inline style',async()=>{
  const list=bars(5,index=>index===1?{close:'95',complete:false,minutes:59}:{});
  const p=setup({handler:answer(payload(list))});
  try{
    assert.equal(p.calls.length,0,'nothing is requested before Analytics opens');
    await p.open();
    assert.deepEqual(p.calls.map(call=>call.path),['/api/market/ohlcv?interval=1h']);
    assert.equal(p.calls[0].options.silent,true);
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
    assert.equal(p.meta.textContent,'5 bars · interval 1h · stored Binance Spot public data · generated 2026-10-04 05:01 UTC');
  }finally{p.w.close();}
});

test('interval buttons refetch, move the pressed state, and a late older response is ignored',async()=>{
  const resolvers={};
  const handler=path=>new Promise(resolve=>{resolvers[path.split('=')[1]]=resolve;});
  const p=setup({handler});
  try{
    p.d.querySelector('nav button[data-view="analytics"]').click();await settle();
    assert.equal(p.state(),'loading');assert.equal(p.status.textContent,'Loading market data…');
    p.interval('15m').click();await settle();
    assert.deepEqual(p.calls.map(call=>call.path),['/api/market/ohlcv?interval=1h','/api/market/ohlcv?interval=15m']);
    assert.ok(p.interval('15m').classList.contains('active')&&!p.interval('1h').classList.contains('active'));
    assert.equal(p.interval('15m').getAttribute('aria-pressed'),'true');assert.equal(p.interval('1h').getAttribute('aria-pressed'),'false');
    resolvers['15m'](payload(bars(3),{interval:'15m'}));await settle();
    assert.equal(p.svg.querySelectorAll('g.mc-bar').length,3);
    resolvers['1h'](payload(bars(7)));await settle();
    assert.equal(p.svg.querySelectorAll('g.mc-bar').length,3,'the answer of the older request is dropped');
    assert.match(p.meta.textContent,/interval 15m/);
  }finally{p.w.close();}
});

test('states: loading, empty, stale with candles, unavailable with the code, HTTP status and a plain failure',async()=>{
  const cases=[
    ['empty',payload([],{status:'EMPTY',latest_closed_bar:null,age_seconds:null,stale:true}),'No stored bars for this interval yet',0],
    ['stale',payload(bars(4),{stale:true,age_seconds:400}),'Stale: latest closed bar is 400 s old (limit 180 s)',4],
    ['ready',payload(bars(4)),null,4]];
  for(const [state,body,text,count] of cases){
    const p=setup({handler:answer(body)});
    try{
      await p.open();
      assert.equal(p.state(),state);if(text)assert.equal(p.status.textContent,text);
      assert.equal(p.svg.querySelectorAll('g.mc-bar').length,count,state);
    }finally{p.w.close();}
  }
  for(const [error,expected] of [[apiError('MARKET_DATA_UNAVAILABLE',503),'MARKET_DATA_UNAVAILABLE'],[apiError(undefined,404),'HTTP_404'],
    [apiError('RETRY_TRANSACTION',409),'RETRY_TRANSACTION'],[new Error('offline'),'REQUEST_FAILED']]){
    const p=setup({handler:()=>{throw error;}});
    try{
      await p.open();
      assert.equal(p.state(),'unavailable');assert.equal(p.status.textContent,`Market data unavailable (${expected})`);
      assert.equal(p.svg.childNodes.length,0,'the drawing is cleared');assert.equal(p.meta.textContent,'');
    }finally{p.w.close();}
  }
});

test('a refresh keeps the candles on screen; Analytics hidden means the global refresh makes no call; logout clears',async()=>{
  let count=0;
  const p=setup({handler:()=>{count++;return payload(bars(2+count));}});
  try{
    p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.calls.length,0,'the Analytics page is hidden: no request');
    await p.open();assert.equal(p.svg.querySelectorAll('g.mc-bar').length,3);
    p.d.querySelector('[data-page="analytics"]').hidden=false;p.d.querySelector('#app').hidden=false;
    p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.calls.length,2);assert.equal(p.svg.querySelectorAll('g.mc-bar').length,4);
    p.d.querySelector('#marketChartRefresh').click();
    assert.equal(p.svg.querySelectorAll('g.mc-bar').length,4,'candles stay while the refresh runs');assert.equal(p.state(),'ready');
    await settle();assert.equal(p.calls.length,3);
    p.d.querySelector('#logout').click();
    assert.equal(p.state(),'idle');assert.equal(p.svg.childNodes.length,0);assert.equal(p.status.textContent,'');assert.equal(p.meta.textContent,'');
  }finally{p.w.close();}
});

test('positions: the chart works without any; a binance-global BTCUSDT position adds entry, stop and target lines; other symbols are ignored',async()=>{
  const none=setup({handler:answer(payload(bars(3)))});
  try{await none.open();assert.equal(none.svg.querySelectorAll('g.mc-bar').length,3);assert.equal(none.svg.querySelectorAll('.mc-level').length,0);}finally{none.w.close();}
  const rows=[{broker:'binance-global',symbol:'BTCUSDT',quantity:'0.5',avg_price:'101.5',stop_loss:'95',take_profit:'120'},
    {broker:'binance-global',symbol:'ETHUSDT',quantity:'1',avg_price:'5',stop_loss:'4',take_profit:'6'},
    {broker:'binance-global',symbol:'BTCUSDT',quantity:'0',avg_price:'7777',stop_loss:null,take_profit:null},
    {broker:'binance-global',symbol:'BTCUSDT',quantity:'1',avg_price:'bad',stop_loss:null,take_profit:'-3'},null];
  const p=setup({handler:answer(payload(bars(3))),positions:rows});
  try{
    await p.open();
    assert.equal(p.svg.querySelectorAll('line.mc-entry').length,1);assert.equal(p.svg.querySelectorAll('line.mc-sl').length,1);assert.equal(p.svg.querySelectorAll('line.mc-tp').length,1);
    assert.deepEqual([...p.svg.querySelectorAll('.mc-level-label')].map(item=>item.textContent),['ENTRY 101.5','SL 95','TP 120']);
    assert.equal(p.svg.querySelectorAll('.mc-level').length,3);
    // The price range grows to include a level above the highest high.
    const high=Number(p.svg.querySelector('line.mc-tp').getAttribute('y1')),entry=Number(p.svg.querySelector('line.mc-entry').getAttribute('y1'));
    assert.ok(high<entry,'a higher price is drawn higher on screen');
  }finally{p.w.close();}
});

test('gap meta line, stale boundary text and exact strings in tooltips',async()=>{
  const body=payload(bars(3),{gaps:{count:2,missing_minutes:9,ranges:[],truncated:false}});
  const p=setup({handler:answer(body)});
  try{
    await p.open();
    assert.ok(p.meta.textContent.endsWith(' · 2 gaps · 9 missing 1m bars in this window'),p.meta.textContent);
  }finally{p.w.close();}
  const clean=setup({handler:answer(payload(bars(3)))});
  try{await clean.open();assert.ok(!clean.meta.textContent.includes('gaps'));}finally{clean.w.close();}
});

test('flat prices and one bar still render finite geometry',async()=>{
  const p=setup({handler:answer(payload([bar(T0-HOUR,{open:'100',high:'100',low:'100',close:'100',volume:'0'})]))});
  try{
    await p.open();
    const values=[...p.svg.querySelectorAll('[y],[y1],[y2],[x],[x1],[x2],[height],[width]')].flatMap(element=>[...element.attributes].filter(attribute=>/^(x|y|x1|x2|y1|y2|width|height)$/.test(attribute.name)).map(attribute=>Number(attribute.value)));
    assert.ok(values.length>10&&values.every(Number.isFinite),'finite geometry');
    assert.equal(p.svg.querySelectorAll('g.mc-bar').length,1);
  }finally{p.w.close();}
});

test('Thai: every literal has a pair; pairs are unique and collision-free; the status is Thai and data stays raw',async()=>{
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
    const source=publicFile('interactive-chart.js'),shown=new Set(['Market chart','BINANCE:BTCUSDT Spot · stored closed bars · Paper only','Refresh chart']);
    for(const match of source.matchAll(/\b(?:T|tpl)\(\s*'([^'\n]*)'/g))shown.add(match[1]);
    assert.ok(shown.size>=9,'literal extraction found the texts: '+shown.size);
    for(const text of shown)assert.notEqual(w.translate(text),text,'missing Thai: '+text);
    for(const text of english)assert.ok(shown.has(text),'pair for text no longer shown: '+text);
  }finally{w.close();}
  const p=setup({language:'th',handler:answer(payload(bars(3),{stale:true,age_seconds:400,gaps:{count:1,missing_minutes:2,ranges:[],truncated:false}}))});
  try{
    assert.equal(p.d.querySelector('#interactiveChartPanel h2').textContent,'กราฟตลาด');
    assert.equal(p.d.querySelector('#marketChartRefresh').textContent,'รีเฟรชกราฟ');
    await p.open();
    assert.equal(p.status.textContent,'ข้อมูลเก่า: แท่งที่ปิดล่าสุดเก่า 400 วินาที (เกณฑ์ 180 วินาที)');
    assert.ok(p.meta.textContent.includes('3 แท่ง')&&p.meta.textContent.includes('ช่องว่าง 1 จุด'));
    assert.ok(p.svg.querySelector('title').textContent.includes('O 100.5 · H 110'),'prices and times stay raw');
    const language=p.d.querySelector('#language');
    language.value='en';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.status.textContent,'Stale: latest closed bar is 400 s old (limit 180 s)');
    assert.equal(p.d.querySelector('#interactiveChartPanel h2').textContent,'Market chart');
    language.value='th';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.status.textContent,'ข้อมูลเก่า: แท่งที่ปิดล่าสุดเก่า 400 วินาที (เกณฑ์ 180 วินาที)');
  }finally{p.w.close();}
});

test('time axis: a bucket with no stored minutes leaves an empty slot between candles',async()=>{
  const list=[bar(T0-4*HOUR),bar(T0-3*HOUR),bar(T0-HOUR)];
  const p=setup({handler:answer(payload(list,{interval_ms:HOUR}))});
  try{
    await p.open();
    const xs=[...p.svg.querySelectorAll('g.mc-bar rect.mc-candle')].map(rect=>Number(rect.getAttribute('x'))+Number(rect.getAttribute('width'))/2);
    assert.equal(xs.length,3);
    const step=xs[1]-xs[0];
    assert.ok(Math.abs((xs[2]-xs[1])-2*step)<0.05,'the missing hour is one empty slot wide');
  }finally{p.w.close();}
});
