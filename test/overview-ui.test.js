import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const publicFile=name=>fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8');
const settle=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
const HOUR=3600000,NOW=Date.now();
// Visible words of a cell: the text of each leaf element, joined by single spaces.
const squash=node=>[...node.querySelectorAll('*')].filter(element=>!element.children.length).map(element=>element.textContent.trim()).filter(Boolean).join(' ');

// Test fixtures only: two Bots of one owner, shaped like GET /api/overview (and, for the fallback, /api/bots, /api/me, /api/positions).
const BOTS=[{id:'bot-1',parent_user_id:null,label:'Momentum BTC',bot_slot_index:1,status:'ACTIVE'},{id:'bot-2',parent_user_id:'bot-1',label:'Mean Revert ETH',bot_slot_index:2,status:'ACTIVE'}];
const botOf=(id,{state='RUNNING',kill=false,trades=3,realized='0.85',equity='10186.4',maxTrades=10,maxLoss=3,maxOpen=3}={})=>({
  botSession:{state,run_id:state==='SETUP'?null:'run-7',started_at:state==='SETUP'?null:NOW-5*HOUR,stopped_at:null},
  risk:{killSwitch:kill,maxTradesPerDay:maxTrades,maxDailyLossR:maxLoss,maxOpenPositions:maxOpen,paperTrading:true},daily:{trades},
  dailyAccounts:realized===null?[]:[{bot_id:id,account_id:'binance-global:primary',realized_r:realized}],
  paperAccounts:[{bot_id:id,broker:'binance-global',currency:'USDT',bookEquity:equity,configuredEquity:'10000'},{bot_id:id,broker:'binance-th',currency:'THB',bookEquity:'0',configuredEquity:'0'}]});
const SECOND={state:'SETUP',trades:0,realized:null,equity:'5000',maxTrades:6,maxLoss:2,maxOpen:2};
const POSITIONS=[{bot_id:'bot-1',user_id:'bot-1',execution_mode:'PAPER',symbol:'BTCUSDT',bot_label:'Momentum BTC'},{bot_id:'bot-1',user_id:'bot-1',execution_mode:'PAPER',symbol:'ETHUSDT',bot_label:'Momentum BTC'}];
const overviewOf=({first={},second={},globalKill=false,bots=BOTS}={})=>({moneyFormat:'decimal-string',globalKill,positions:POSITIONS,
  bots:bots.map((bot,index)=>({...bot,webhook_hint:'ab12',...botOf(bot.id,index===0?first:{...SECOND,...second})}))});
const ok=(body,etag='"'+'a'.repeat(32)+'"')=>({status:200,body,etag});

function setup({language,overview=()=>ok(overviewOf()),legacy=()=>{throw new Error('legacy reads are not expected');}}={}){
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  if(language)w.localStorage.setItem('robotLanguage',language);
  w.eval(publicFile('i18n.js'));
  const requests=[],calls=[],switched=[];
  // The page's own reader uses fetch for /api/overview; api() serves only the fallback for a server without it.
  w.fetch=async(url,init={})=>{
    requests.push({url,method:init.method,credentials:init.credentials,cache:init.cache,ifNoneMatch:init.headers?.['if-none-match']??null});
    const answer=await overview({url,init,count:requests.length});
    return {status:answer.status,ok:answer.status>=200&&answer.status<300,headers:{get:name=>name.toLowerCase()==='etag'?answer.etag??null:null},
      json:async()=>{if(answer.body===undefined)throw new SyntaxError('Unexpected end of JSON input');return structuredClone(answer.body);}};
  };
  w.api=async(path,options={})=>{calls.push({path,botId:options.botId,method:options.method||'GET'});return legacy(path,options);};
  w.switchBot=async id=>{switched.push(id);};
  // The globals app.js owns, as they stand after sign-in with the main Bot selected.
  w.eval('var authenticated=true,selectedBot="",me={user:{id:"bot-1"}},csrfToken="csrf-1";var load=async function(){};');
  d.querySelector('#app').hidden=false;
  w.eval(publicFile('overview.js'));
  const rows=()=>[...d.querySelectorAll('#ovBots tbody tr')];
  const cellOf=(row,key)=>row.querySelector('td[data-label-key="'+key+'"]');
  const kpis=()=>[...d.querySelectorAll('#ovKpis .ov-kpi')].map(tile=>tile.querySelector('.ov-num').textContent);
  const boot=async()=>{await w.load();await settle();};
  // The page clock moves only when a test moves it, so runner speed never changes a rendered age or wait (a loaded run
  // once rendered "Updated 1 s ago"). Refresh now waits 5 s after a good cycle; tests move the clock past that.
  const later=()=>{let now=w.Date.now();w.Date.now=()=>now;return ms=>{now+=ms;};};
  const advance=later();
  const refreshNow=async()=>{advance(6000);d.querySelector('#ovNow').click();await settle();};
  return {dom,w,d,requests,calls,switched,rows,cellOf,kpis,boot,refreshNow,advance};
}

test('Overview: the account section sits above the Selected bot tiles, and the chart still follows the tiles',()=>{
  const p=setup();
  try{
    const page=p.d.querySelector('[data-page="overview"]'),account=p.d.querySelector('#ovAccount'),grid=page.querySelector('.status-grid');
    assert.equal(account.parentElement,page);
    assert.ok(account.compareDocumentPosition(grid)&p.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(grid.previousElementSibling.className,'ov-selected');
    assert.equal(grid.nextElementSibling.id,'interactiveChartPanel');
    assert.equal(p.d.querySelector('#ovTitle').textContent,'Account overview');
    assert.equal(p.d.querySelector('#ovConn').textContent,'Connecting…');
    assert.equal(p.requests.length+p.calls.length,0,'nothing is requested before sign-in finishes');
  }finally{p.w.close();}
});

test('One GET /api/overview per cycle lists every Bot with state, new-entry status, limit meters and paper equity',async()=>{
  const p=setup();
  try{
    await p.boot();
    assert.deepEqual(p.requests,[{url:'/api/overview',method:'GET',credentials:'same-origin',cache:'no-store',ifNoneMatch:null}]);
    assert.equal(p.calls.length,0,'no per-Bot reads');
    const [first,second]=p.rows();
    assert.equal(p.rows().length,2);
    assert.match(squash(p.cellOf(first,'Bot')),/^1\. Momentum BTC Since /);
    assert.equal(p.cellOf(first,'Bot status').querySelector('.st').textContent,'Running');
    assert.ok(p.cellOf(first,'Bot status').querySelector('.st').classList.contains('st-running'));
    assert.equal(squash(p.cellOf(first,'New entries')),'Allowed');
    assert.equal(squash(p.cellOf(first,'Trades today')),'3 / 10');
    assert.equal(squash(p.cellOf(first,'Daily loss')),'0.00 R / 3.00 R Realized +0.85 R');
    assert.equal(squash(p.cellOf(first,'Positions')),'2 / 3');
    assert.equal(squash(p.cellOf(first,'Paper equity')),'10,186.40 USDT','zero-funded THB accounts are left out');
    assert.ok(first.classList.contains('is-selected'),'an empty selection means the main Bot');
    assert.equal(p.cellOf(second,'Bot status').querySelector('.st').textContent,'Setup');
    assert.equal(squash(p.cellOf(second,'New entries')),'Not running');
    assert.equal(squash(p.cellOf(second,'Trades today')),'0 / 6');
    assert.deepEqual(p.kpis(),['1 / 2','15,186.40 USDT','+0.85 R','2']);
    assert.equal(p.d.querySelector('#ovConn').textContent,'Connected');
    assert.match(p.d.querySelector('#ovUpdated').textContent,/^Updated \d+ s ago$/);
    assert.equal(p.d.querySelector('.ov-selected-name').textContent,'Momentum BTC');
    assert.equal(p.d.querySelector('#ovBots .ov-bar i').className,'ov-w-30','meter widths are classes, never style attributes');
  }finally{p.w.close();}
});

test('The ETag goes back as If-None-Match; a 304 reuses the cached body and counts as a good cycle',async()=>{
  const TAG='"'+'b'.repeat(32)+'"';
  const p=setup({overview:({count})=>count===1?ok(overviewOf(),TAG):{status:304,etag:TAG}});
  try{
    await p.boot();
    p.advance(60000);
    await p.refreshNow();
    assert.equal(p.requests.length,2);assert.equal(p.requests[1].ifNoneMatch,TAG);
    assert.equal(p.rows().length,2);assert.equal(p.cellOf(p.rows()[0],'Bot status').querySelector('.st').textContent,'Running');
    assert.equal(p.d.querySelector('#ovConn').textContent,'Connected');
    assert.match(p.d.querySelector('#ovUpdated').textContent,/^Updated 0 s ago$/,'the 304 cycle refreshed the good-cycle time');
    assert.deepEqual(p.kpis(),['1 / 2','15,186.40 USDT','+0.85 R','2']);
  }finally{p.w.close();}
});

test('A new 200 replaces the cached body; a changed account drops the cached tag',async()=>{
  const p=setup({overview:({count})=>count===1?ok(overviewOf()):ok(overviewOf({first:{state:'PAUSED'}}),'"'+'c'.repeat(32)+'"')});
  try{
    await p.boot();
    await p.refreshNow();
    assert.equal(p.cellOf(p.rows()[0],'Bot status').querySelector('.st').textContent,'Paused');
    p.w.eval('me={user:{id:"someone-else"}}');
    await p.refreshNow();
    assert.equal(p.requests[1].ifNoneMatch,'"'+'a'.repeat(32)+'"');assert.equal(p.requests[2].ifNoneMatch,null,'another account never revalidates this one');
  }finally{p.w.close();}
});

test('Kill switch, global kill and paused sessions read as separate facts; meters warn near a limit',async()=>{
  const p=setup({overview:()=>ok(overviewOf({first:{kill:true,trades:10,realized:'-2.4'},second:{state:'PAUSED'}}))});
  try{
    await p.boot();
    const [first,second]=p.rows();
    assert.equal(squash(p.cellOf(first,'Bot status')),'Running Takes new entries');
    assert.equal(squash(p.cellOf(first,'New entries')),'Paused: kill switch');
    assert.ok(p.cellOf(first,'New entries').querySelector('.st').classList.contains('st-bad'));
    assert.ok(p.cellOf(first,'Trades today').firstChild.classList.contains('ov-bad'));
    assert.equal(squash(p.cellOf(first,'Daily loss')),'2.40 R / 3.00 R Realized −2.40 R');
    assert.ok(p.cellOf(first,'Daily loss').firstChild.classList.contains('ov-warn'));
    assert.equal(squash(p.cellOf(second,'Bot status')),'Paused No new entries. Open positions are still managed.');
    assert.equal(squash(p.cellOf(second,'New entries')),'Paused: bot paused');
    assert.equal(p.kpis()[2],'−2.40 R');
  }finally{p.w.close();}
  const g=setup({overview:()=>ok(overviewOf({globalKill:true}))});
  try{
    await g.boot();
    assert.deepEqual(g.rows().map(row=>squash(g.cellOf(row,'New entries'))),['Paused: global kill','Paused: global kill'],'the account-wide kill applies to every Bot');
  }finally{g.w.close();}
});

test('Errors back off (40, 80, 160 s), Refresh now has a 5 s cooldown after a good cycle, and no request ever writes',async()=>{
  let mode='down';
  const p=setup({overview:()=>mode==='down'?{status:503,body:{error:'Service unavailable'}}:mode==='retry'?{status:409,body:{code:'RETRY_TRANSACTION'}}:ok(overviewOf())});
  try{
    await p.boot();
    assert.equal(p.d.querySelector('#ovConn').textContent,'Reconnecting');
    assert.match(p.d.querySelector('#ovUpdated').textContent,/^Not updated yet · Next try in (39|40) s$/);
    assert.equal(p.rows().length,0,'no figures before a good cycle');
    const now=p.d.querySelector('#ovNow');
    now.click();await settle();assert.match(p.d.querySelector('#ovUpdated').textContent,/Next try in 80 s$/);
    mode='retry';now.click();await settle();assert.equal(p.d.querySelector('#ovConn').textContent,'Offline');
    assert.match(p.d.querySelector('#ovUpdated').textContent,/Next try in (159|160) s$/,'409 RETRY_TRANSACTION backs off like 503');
    mode='up';now.click();await settle();
    assert.equal(p.d.querySelector('#ovConn').textContent,'Connected');assert.equal(p.rows().length,2);
    const before=p.requests.length;now.click();p.d.querySelector('#refresh').click();await settle();
    assert.equal(p.requests.length,before,'Refresh now and the header Refresh wait 5 s after a good cycle');
    assert.ok(p.requests.every(request=>request.method==='GET'));assert.equal(p.calls.length,0);
  }finally{p.w.close();}
});

test('A 401 clears the cached tag, stops the schedule and the ticker, and shows Signed out until load() succeeds again',async()=>{
  let signedOut=false;
  const p=setup({overview:()=>signedOut?{status:401,body:{error:'Sign in'}}:ok(overviewOf())});
  try{
    await p.boot();
    signedOut=true;await p.refreshNow();
    assert.equal(p.d.querySelector('#ovConn').textContent,'Signed out');
    assert.equal(p.d.querySelector('#ovUpdated').textContent,'Sign in to resume updates');
    const count=p.requests.length;
    p.d.querySelector('nav button[data-view="overview"]').click();await settle();
    assert.equal(p.requests.length,count,'showing the page again does not retry while signed out');
    signedOut=false;await p.boot();
    assert.equal(p.requests.length,count+1,'signing in again reads at once');
    assert.equal(p.d.querySelector('#ovConn').textContent,'Connected');assert.equal(p.rows().length,2);
    assert.equal(p.requests.at(-1).ifNoneMatch,null,'the tag cached before the 401 is gone');
  }finally{p.w.close();}
});

test('A server without /api/overview (404) falls back to the per-Bot reads for the rest of the session',async()=>{
  const me=(id,options)=>({...botOf(id,options),user:{id},globalKill:false});
  const p=setup({overview:()=>({status:404,body:{error:'Not found'}}),legacy:(path,options)=>{
    if(path==='/api/bots')return {bots:BOTS,maxBots:3};
    if(path==='/api/me')return options.botId==='bot-1'?me('bot-1'):me('bot-2',SECOND);
    if(path==='/api/positions')return POSITIONS;
    throw new Error('Unexpected '+path);
  }});
  try{
    await p.boot();
    assert.equal(p.requests.length,1);
    assert.deepEqual(p.calls.map(call=>[call.path,call.botId??null,call.method]),[['/api/bots',null,'GET'],['/api/me','bot-1','GET'],['/api/me','bot-2','GET'],['/api/positions','all','GET']]);
    assert.equal(p.rows().length,2);assert.deepEqual(p.kpis(),['1 / 2','15,186.40 USDT','+0.85 R','2']);
    await p.refreshNow();
    assert.equal(p.requests.length,1,'the missing endpoint is not asked again');assert.equal(p.calls.length,8);
  }finally{p.w.close();}
});

test('Nothing is requested while the Overview page is hidden or auto-refresh is paused',async()=>{
  const p=setup();
  try{
    p.d.querySelector('[data-page="overview"]').hidden=true;
    await p.boot();assert.equal(p.requests.length,0,'hidden page');
    p.d.querySelector('[data-page="overview"]').hidden=false;
    const toggle=p.d.querySelector('#ovToggle');
    toggle.click();await settle();
    assert.equal(toggle.getAttribute('aria-pressed'),'true');assert.equal(toggle.textContent,'Resume auto-refresh');
    assert.equal(p.d.querySelector('#ovConn').textContent,'Auto-refresh paused');
    await p.boot();assert.equal(p.requests.length,0,'paused');
    toggle.click();await settle();
    assert.equal(p.requests.length,1,'resuming refreshes once');
    assert.equal(p.d.querySelector('#ovConn').textContent,'Connected');
  }finally{p.w.close();}
});

test('Refresh now is disabled while a cycle runs',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const p=setup({overview:async()=>{await gate;return ok(overviewOf());}});
  try{
    await p.boot();
    assert.equal(p.d.querySelector('#ovNow').disabled,true);
    release();await settle();
    assert.equal(p.d.querySelector('#ovNow').disabled,false);assert.equal(p.rows().length,2);
  }finally{p.w.close();}
});

test('A refresh keeps keyboard focus on the same Bot button',async()=>{
  const p=setup();
  try{
    await p.boot();
    p.rows()[1].querySelector('.ov-open').focus();
    const language=p.d.querySelector('#language');language.value='th';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.d.activeElement.dataset.ovOpen,'bot-2');assert.ok(p.rows()[1].contains(p.d.activeElement),'focus moved to the redrawn row');
  }finally{p.w.close();}
});

test('Open bot switches to that Bot and opens Bot Manager',async()=>{
  const p=setup();
  try{
    await p.boot();
    const views=[];p.d.querySelectorAll('#primaryNav button').forEach(button=>button.addEventListener('click',()=>views.push(button.dataset.view)));
    const open=p.rows()[1].querySelector('.ov-open');
    assert.equal(open.getAttribute('aria-label'),'Open Mean Revert ETH in Bot Manager');
    open.click();await settle();
    assert.deepEqual(p.switched,['bot-2']);assert.deepEqual(views,['bots']);
  }finally{p.w.close();}
});

test('Thai: every label is translated, Bot names are never translated, and the language switch redraws',async()=>{
  const named=[{...BOTS[0],label:'Running'},BOTS[1]];
  const p=setup({language:'th',overview:()=>ok(overviewOf({bots:named}))});
  try{
    await p.boot();
    assert.equal(p.d.querySelector('#ovTitle').textContent,'ภาพรวมบัญชี');
    assert.equal(p.d.querySelector('#ovConn').textContent,'เชื่อมต่อแล้ว');
    const [first]=p.rows();
    assert.equal(p.cellOf(first,'Bot').querySelector('strong').textContent,'1. Running','user data stays as typed');
    assert.equal(p.cellOf(first,'Bot status').querySelector('.st').textContent,'ทำงานอยู่');
    assert.equal(squash(p.cellOf(first,'New entries')),'อนุญาต');
    assert.equal(p.cellOf(first,'Trades today').dataset.label,'เทรดวันนี้');
    assert.match(p.d.querySelector('#ovUpdated').textContent,/^อัปเดตเมื่อ \d+ วินาทีก่อน$/);
    const language=p.d.querySelector('#language');language.value='en';language.dispatchEvent(new p.w.Event('change'));await settle();
    assert.equal(p.d.querySelector('#ovTitle').textContent,'Account overview');
    assert.equal(p.cellOf(p.rows()[0],'Trades today').dataset.label,'Trades today');
  }finally{p.w.close();}
});
test('Selected bot tiles: Bot state and kill switch are separate facts',()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window,d=w.document;
  try{
    // app.js keeps me and selectedBot in script-level bindings, so the test reaches them from inside the same evaluation.
    w.eval(publicFile('i18n.js'));w.eval(publicFile('app.js')+'\nwindow.tiles=(session,selection,policy)=>{me=session;selectedBot=selection;renderSelectedBotTiles(policy);};');
    w.tiles({botSession:{state:'PAUSED'},globalKill:false},'bot-1',{killSwitch:false});
    assert.equal(d.querySelector('#botStateValue').textContent,'PAUSED');
    assert.equal(d.querySelector('#botStateNote').textContent,'No new entries. Open positions are still managed.');
    assert.equal(d.querySelector('#killValue').textContent,'Off');
    w.tiles({botSession:{state:'RUNNING'},globalKill:true},'bot-1',{killSwitch:false});
    assert.equal(d.querySelector('#killValue').textContent,'On · global');
    assert.equal(d.querySelector('#killNote').textContent,'New entries paused. Position-reducing orders still allowed.');
    w.tiles({botSession:{state:'RUNNING'},globalKill:false},'all',{killSwitch:true});
    assert.equal(d.querySelector('#botStateValue').textContent,'All bots');assert.equal(d.querySelector('#killValue').textContent,'On');
  }finally{w.close();}
});

test('Sources: overview.js reads with GET only, keeps the ETag in memory only, and ships no style attribute the CSP would drop',()=>{
  const source=publicFile('overview.js');
  for(const banned of ['innerHTML','outerHTML','insertAdjacentHTML','document.write','eval(','new Function','XMLHttpRequest','WebSocket','.style','localStorage','sessionStorage','indexedDB','caches.','http://','https://'])
    assert.ok(!source.includes(banned),'overview.js must not contain '+banned);
  assert.deepEqual([...source.matchAll(/fetch\(([^,]+),/g)].map(match=>match[1]),["'/api/overview'"],'one fetch site, for the overview only');
  assert.deepEqual([...source.matchAll(/method:'([A-Z]+)'/g)].map(match=>match[1]),['GET']);
  assert.deepEqual([...source.matchAll(/api\('([^']+)'/g)].map(match=>match[1]),['/api/bots','/api/me','/api/positions'],'the 404 fallback keeps the earlier reads');
  for(const name of fs.readdirSync(new URL('../public/',import.meta.url)).filter(file=>/\.(js|html)$/.test(file)))
    assert.doesNotMatch(publicFile(name),/\sstyle="/,name+' has a style attribute; production CSP style-src \'self\' ignores it');
  const html=publicFile('index.html');
  assert.ok(html.indexOf('/market-chart.css')<html.indexOf('/theme-hud.css'),'theme loads after the other stylesheets');
  assert.ok(html.indexOf('/journey.js')<html.indexOf('/overview.js'),'overview.js loads after journey.js');
});
test('New pairs round-trip: each Thai string maps back to its own English and collides with no existing pair',()=>{
  const dom=new JSDOM(publicFile('index.html'),{url:'https://robot.test',runScripts:'outside-only'}),w=dom.window;
  try{
    w.eval(publicFile('i18n.js')+';window.__all=uiPairs;window.__mine=overviewPairs;window.__map=uiTranslations;');
    const mine=[...w.__mine],others=w.__all.filter(pair=>!w.__mine.includes(pair)),problems=[];
    assert.equal(new Set(mine.map(pair=>pair[0])).size,mine.length,'duplicate English key in overviewPairs');
    assert.equal(new Set(mine.map(pair=>pair[1])).size,mine.length,'duplicate Thai text in overviewPairs');
    for(const [en,th] of mine){
      if(w.__map.get(th)?.en!==en)problems.push('Thai "'+th+'" reads back as "'+w.__map.get(th)?.en+'", not "'+en+'"');
      if(w.__map.get(en)?.th!==th)problems.push('English "'+en+'" no longer reads "'+th+'"');
      for(const [otherEn,otherTh] of others){
        if(otherTh===th)problems.push('Thai "'+th+'" is also the Thai of "'+otherEn+'"');
        if(otherEn===en)problems.push('English "'+en+'" already has a pair');
        if(otherEn===th||otherTh===en)problems.push('"'+en+'" crosses the pair "'+otherEn+'"');
      }
    }
    assert.deepEqual(problems,[]);
  }finally{w.close();}
});
