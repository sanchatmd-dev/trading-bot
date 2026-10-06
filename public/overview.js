/* Account overview: every Bot of this account on one page, kept fresh on a server-friendly schedule.
   Read only: GET requests only, so it has no path to orders. Text is set with textContent only.
   Refresh: every 20 s (longer with many Bots) while both the Overview page and the browser tab are visible,
   one cycle at a time, with back-off after errors. One GET /api/overview per cycle, revalidated with its ETag.
   A server without that endpoint (404, the SQLite runtime) falls back for the session to the earlier reads:
   one /api/me per Bot plus one /api/positions, with the Bot list re-read every fifth cycle. */
(() => {
  const page=document.querySelector('[data-page="overview"]'),grid=page&&page.querySelector('.status-grid');
  if(!page||!grid)return;
  const INTERVAL=20000,PER_BOT=2500,JITTER=1500,MAX_DELAY=300000,CONCURRENCY=2,BOTS_EVERY=5,COOLDOWN=5000;
  const STATES={RUNNING:['Running','st-running','Takes new entries'],PAUSED:['Paused','st-paused','No new entries. Open positions are still managed.'],
    STOPPED:['Stopped','st-stopped','Session ended. Reset it to trade again.'],SETUP:['Setup','st-setup','Not trading yet']};
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(_,key)=>String(values[key]??''));
  const make=(tag,cls,...children)=>{const node=document.createElement(tag);if(cls)node.className=cls;for(const child of children)if(child!==null&&child!==undefined&&child!==false)node.append(child);return node;};
  const label=(text,tag='span',cls)=>{const node=make(tag,cls);node.dataset.uiLabel=text;node.textContent=T(text);return node;};
  const data=(text,tag='span',cls)=>make(tag,'ov-data'+(cls?' '+cls:''),String(text));
  const num=value=>{const n=typeof value==='number'?value:typeof value==='string'&&value.trim()!==''?Number(value):NaN;return Number.isFinite(n)?n:null;};
  const money=new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const signedR=value=>(value>0?'+':value<0?'\u2212':'')+money.format(Math.abs(value))+' R';
  const plainR=value=>money.format(value)+' R';
  const count=value=>Number.isFinite(value)?String(value):'\u2014';
  const signedIn=()=>{try{return typeof authenticated!=='undefined'&&authenticated===true;}catch{return false;}};
  // An empty selection means the main Bot, whose id is the signed-in user id.
  const selected=()=>{try{const value=typeof selectedBot==='string'?selectedBot:'';return value||(typeof me!=='undefined'&&me?.user?.id)||'';}catch{return '';}};
  const app=document.getElementById('app');
  const visible=()=>!page.hidden&&!(app&&app.hidden)&&document.visibilityState!=='hidden';

  const state={bots:[],rows:new Map(),positions:[],cycle:0,seq:0,timer:0,ticker:0,inFlight:false,failures:0,lastOk:0,nextAt:0,paused:false,loaded:false,signedOut:false,legacy:false};

  // Static frame
  const root=make('section','ov');root.id='ovAccount';root.setAttribute('aria-labelledby','ovTitle');
  const title=label('Account overview','h2','ov-title');title.id='ovTitle';
  const conn=make('span','st st-idle ov-conn');conn.id='ovConn';conn.setAttribute('role','status');
  const updated=make('span','ov-updated');updated.id='ovUpdated';
  const toggle=label('Pause auto-refresh','button','ghost ov-btn');toggle.type='button';toggle.id='ovToggle';toggle.setAttribute('aria-pressed','false');
  const now=label('Refresh now','button','ghost ov-btn');now.type='button';now.id='ovNow';
  const cadence=make('p','ov-note');
  const kpis=make('div','ov-kpis');kpis.id='ovKpis';
  const body=make('tbody');
  const head=make('tr',null,...['Bot','Bot status','New entries','Trades today','Daily loss','Positions','Paper equity'].map(text=>label(text,'th')),label('Action','th','ov-sr-th'));
  const table=make('table','ov-table',make('thead',null,head),body);table.id='ovBots';
  const empty=make('div','ov-empty');empty.hidden=true;
  const tablePanel=make('article','panel ov-bots',make('div','ov-bots-head',label('Bots in this account','h3'),label('Every Bot of this account. Open one to manage it.','p','ov-note')),make('div','ov-scroll',table),empty);
  root.append(make('div','ov-strip',
      make('div','ov-strip-main',title,label('All bots','span','st st-info'),label('Paper only \u00b7 Live locked','span','st st-ok')),
      make('div','ov-strip-side',conn,updated,toggle,now)),
    cadence,kpis,tablePanel);
  const selectedName=make('span','ov-data ov-selected-name');
  const selectedHead=make('h2','ov-selected',label('Selected bot'),selectedName);
  grid.before(root,selectedHead);

  // Formatting
  const sinceText=ms=>{const n=num(ms);if(n===null)return '';try{return new Date(n).toLocaleString(document.documentElement.lang==='th'?'th-TH':'en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}catch{return '';}};
  const widthClass=ratio=>'ov-w-'+Math.max(0,Math.min(100,Math.round(ratio*20)*5));
  function meter(value,max,format=count){
    const ratio=Number.isFinite(value)&&Number.isFinite(max)&&max>0?value/max:null;
    const tone=ratio===null?'idle':ratio>=1?'bad':ratio>=.7?'warn':'ok';
    const bar=make('span','ov-bar',make('i',ratio===null?'ov-w-0':widthClass(ratio)));bar.setAttribute('aria-hidden','true');
    const text=make('span','ov-meter-text ov-data',(Number.isFinite(value)?format(value):'\u2014')+' / '+(Number.isFinite(max)?format(max):'\u2014'));
    return make('div','ov-meter ov-'+tone,text,bar);
  }
  function equityLines(accounts){
    const sums=new Map();
    for(const account of Array.isArray(accounts)?accounts:[]){
      const equity=num(account?.bookEquity),configured=num(account?.configuredEquity);
      if(equity===null||(equity===0&&!configured))continue;
      const currency=typeof account.currency==='string'?account.currency:'';
      sums.set(currency,(sums.get(currency)||0)+equity);
    }
    return sums;
  }
  const sumR=rows=>(Array.isArray(rows)?rows:[]).reduce((total,row)=>total+(num(row?.realized_r)??0),0);
  const ownerOf=row=>row?.bot_id??row?.user_id;
  const paperRows=ids=>state.positions.filter(row=>ids.has(ownerOf(row))&&(row?.execution_mode??'PAPER')==='PAPER');

  // Bot rows
  function entriesOf(me,session){
    const risk=me?.risk||{};
    if(me?.globalKill)return ['Paused: global kill','st-bad'];
    if(risk.killSwitch)return ['Paused: kill switch','st-bad'];
    if(session==='RUNNING')return ['Allowed','st-ok'];
    if(session==='PAUSED')return ['Paused: bot paused','st-paused'];
    return ['Not running','st-idle'];
  }
  function cell(name,...children){const td=make('td',null,...children);td.dataset.label=T(name);td.dataset.labelKey=name;return td;}
  function botRow(bot){
    const info=state.rows.get(bot.id)||{},me=info.me,slot=Number.isSafeInteger(bot.bot_slot_index)?bot.bot_slot_index+'. ':'';
    const tr=make('tr','ov-row');tr.dataset.bot=bot.id;
    if(bot.id===selected()){tr.classList.add('is-selected');tr.setAttribute('aria-current','true');}
    const name=make('div','ov-bot',data(slot+(bot.label||bot.id),'strong'));
    const inSetup=!me||!me.botSession?.state||me.botSession.state==='SETUP';
    const open=label(inSetup&&me?'Continue setup':'Open bot','button',(inSetup&&me?'primary':'ghost')+' ov-open');open.type='button';open.dataset.ovOpen=bot.id;
    open.setAttribute('aria-label',tpl('Open {bot} in Bot Manager',{bot:bot.label||bot.id}));
    if(!me){
      const reason=info.error?label('Could not load this Bot','span','st st-warn'):label('Loading\u2026','span','ov-muted');
      const wide=make('td','ov-row-note',reason);wide.colSpan=6;
      tr.append(cell('Bot',name),wide,make('td','ov-action',open));return tr;
    }
    const session=me.botSession?.state&&STATES[me.botSession.state]?me.botSession.state:'SETUP',[stateText,stateClass,consequence]=STATES[session];
    const since=session==='RUNNING'||session==='PAUSED'?sinceText(me.botSession?.started_at):'';
    if(since)name.append(make('small','ov-sub',tpl('Since {time}',{time:since})));
    const [entryText,entryClass]=entriesOf(me,session),risk=me.risk||{};
    const realized=sumR(me.dailyAccounts),used=realized<0?-realized:0;
    const equity=equityLines(me.paperAccounts);
    const loss=meter(used,num(risk.maxDailyLossR),plainR);
    loss.append(make('small','ov-sub ov-data'+(realized>0?' ov-gain':realized<0?' ov-loss':''),tpl('Realized {r}',{r:signedR(realized)})));
    tr.append(
      cell('Bot',name),
      cell('Bot status',label(stateText,'span','st '+stateClass),label(consequence,'small','ov-sub')),
      cell('New entries',label(entryText,'span','st '+entryClass)),
      cell('Trades today',meter(num(me.daily?.trades),num(risk.maxTradesPerDay))),
      cell('Daily loss',loss),
      cell('Positions',meter(paperRows(new Set([bot.id])).length,num(risk.maxOpenPositions))),
      cell('Paper equity',...(equity.size?[...equity].map(([currency,value])=>data(money.format(value)+(currency?' '+currency:''),'div','ov-equity')):[data('\u2014','div')])),
      make('td','ov-action',open));
    return tr;
  }

  // Summary tiles
  function kpi(name,value,sub,tone){
    const node=make('article','metric ov-kpi'+(tone?' ov-'+tone:''),label(name),make('strong','ov-data ov-num',value));
    if(sub)node.append(make('small','ov-sub',sub));
    return node;
  }
  function renderKpis(){
    const loaded=state.bots.map(bot=>state.rows.get(bot.id)?.me).filter(Boolean),states={RUNNING:0,PAUSED:0,STOPPED:0,SETUP:0};
    for(const me of loaded)states[STATES[me.botSession?.state]?me.botSession.state:'SETUP']++;
    const equity=new Map();
    for(const me of loaded)for(const [currency,value] of equityLines(me.paperAccounts))equity.set(currency,(equity.get(currency)||0)+value);
    const realized=loaded.reduce((total,me)=>total+sumR(me.dailyAccounts),0),trades=loaded.reduce((total,me)=>total+(num(me.daily?.trades)??0),0);
    const open=paperRows(new Set(state.bots.map(bot=>bot.id)));
    const equityValue=equity.size?[...equity].map(([currency,value])=>money.format(value)+(currency?' '+currency:'')).join(' \u00b7 '):'\u2014';
    kpis.replaceChildren(
      kpi('Bots running',state.loaded?states.RUNNING+' / '+state.bots.length:'\u2014',
        state.loaded?tpl('Paused {p} \u00b7 Stopped {s} \u00b7 Setup {u}',{p:states.PAUSED,s:states.STOPPED,u:states.SETUP}):'',states.RUNNING?'live':null),
      kpi('Paper equity',equityValue,T('Book equity at position cost, per currency')),
      kpi('Realized today',state.loaded?signedR(realized):'\u2014',state.loaded?tpl('{n} trades today',{n:trades}):'',realized>0?'gain':realized<0?'loss':null),
      kpi('Open positions',state.loaded?String(open.length):'\u2014',state.loaded?tpl('Held by {n} of {total} bots',{n:new Set(open.map(ownerOf)).size,total:state.bots.length}):''));
  }

  // Connection status
  function renderStatus(){
    const age=state.lastOk?Math.max(0,Math.round((Date.now()-state.lastOk)/1000)):null,wait=state.nextAt?Math.max(0,Math.round((state.nextAt-Date.now())/1000)):null;
    let text,tone;
    if(state.signedOut){text='Signed out';tone='st-idle';}
    else if(state.paused){text='Auto-refresh paused';tone='st-paused';}
    else if(state.failures>=3){text='Offline';tone='st-bad';}
    else if(state.failures){text='Reconnecting';tone='st-warn';}
    else if(!state.lastOk){text='Connecting\u2026';tone='st-idle';}
    else if(Date.now()-state.lastOk>3*interval()){text='Data may be stale';tone='st-warn';}
    else{text='Connected';tone='st-running';}
    const cls='st ov-conn '+tone;
    if(conn.className!==cls)conn.className=cls;
    conn.dataset.uiLabel=text;if(conn.textContent!==T(text))conn.textContent=T(text);
    let line=state.signedOut?T('Sign in to resume updates'):age===null?T('Not updated yet'):tpl('Updated {n} s ago',{n:age});
    if(state.failures&&wait!==null&&!state.paused&&!state.signedOut)line+=' \u00b7 '+tpl('Next try in {n} s',{n:wait});
    if(updated.textContent!==line)updated.textContent=line;
    const action=state.paused?'Resume auto-refresh':'Pause auto-refresh';
    toggle.dataset.uiLabel=action;if(toggle.textContent!==T(action))toggle.textContent=T(action);toggle.setAttribute('aria-pressed',String(state.paused));
    const note=tpl('Updates every {n} s while this page is open. Read only: it never sends orders.',{n:Math.round(interval()/1000)});
    if(cadence.textContent!==note)cadence.textContent=note;
  }
  function render(){
    renderStatus();renderKpis();
    // A refresh redraws the rows; keyboard focus stays on the same Bot's button.
    const focused=document.activeElement&&body.contains(document.activeElement)?document.activeElement.dataset.ovOpen:undefined;
    const rows=state.bots.map(botRow);
    body.replaceChildren(...rows);
    if(focused!==undefined)[...body.querySelectorAll('.ov-open')].find(button=>button.dataset.ovOpen===focused)?.focus();
    table.hidden=!rows.length;
    empty.hidden=!!rows.length||!state.loaded;
    if(!empty.hidden&&!empty.firstChild){
      const go=label('Open Bot Manager','button','primary');go.type='button';go.dataset.ovOpen='';
      empty.append(label('No bots yet. Create one in Bot Manager.','p'),go);
    }
    const current=state.bots.find(bot=>bot.id===selected());
    selectedName.textContent=selected()==='all'?T('All bots'):current?current.label||current.id:'';
  }

  // Scheduling
  const interval=()=>Math.max(INTERVAL,state.bots.length*PER_BOT);
  const delay=()=>state.failures?Math.min(MAX_DELAY,interval()*2**state.failures):interval()+Math.round((Math.random()*2-1)*JITTER);
  function stopTimer(){clearTimeout(state.timer);state.timer=0;state.nextAt=0;}
  function schedule(ms){stopTimer();if(state.paused||!signedIn()||!visible())return;state.nextAt=Date.now()+ms;state.timer=setTimeout(()=>{state.timer=0;refresh();},ms);}
  function startTicker(){if(!state.ticker)state.ticker=setInterval(()=>{if(visible())renderStatus();else stopTicker();},1000);}
  function stopTicker(){clearInterval(state.ticker);state.ticker=0;}
  const transient=error=>!error||!Number.isInteger(error.status)||error.status===429||error.status>=500;
  // The overview answer carries a strong ETag and cache-control: no-store, so the browser keeps nothing. The last tag
  // and body live only here, in memory, and go back as If-None-Match; a 304 reuses the body. Never stored anywhere else.
  const cache={tag:null,body:null,account:null};
  const clearCache=()=>{cache.tag=null;cache.body=null;cache.account=null;};
  const accountKey=()=>{try{return typeof me!=='undefined'&&me?.user?.id?String(me.user.id):null;}catch{return null;}};
  const failure=(response,body)=>Object.assign(new Error(body?.error||'Request failed'),{status:response.status,code:body?.code});
  // api() parses every answer as JSON and hides status and headers, so the 304 path needs this small GET-only reader.
  async function readOverview(){
    const headers={accept:'application/json'};
    try{if(typeof csrfToken==='string'&&csrfToken)headers['x-csrf-token']=csrfToken;}catch{}
    if(cache.tag&&cache.body&&cache.account===accountKey())headers['if-none-match']=cache.tag;
    const response=await fetch('/api/overview',{method:'GET',credentials:'same-origin',cache:'no-store',headers});
    if(response.status===304&&headers['if-none-match'])return cache.body;
    let body=null;try{body=await response.json();}catch{}
    if(!response.ok)throw failure(response,body);
    if(!body||!Array.isArray(body.bots)||!Array.isArray(body.positions))throw failure({status:502},body);
    cache.tag=response.headers.get('etag')||null;cache.body=body;cache.account=accountKey();
    return body;
  }
  // Fallback for a server without /api/overview. Same shape as the overview answer; a Bot that fails alone carries error.
  async function readLegacy(force){
    let bots=state.bots;
    if(!bots.length||force||state.cycle%BOTS_EVERY===0){
      const list=await api('/api/bots',{silent:true});
      bots=Array.isArray(list?.bots)?list.bots.filter(bot=>bot&&typeof bot.id==='string'):[];
    }
    const results=await pool(bots,CONCURRENCY,bot=>api('/api/me',{botId:bot.id,silent:true}).then(me=>({bot,me}),error=>({bot,error})));
    const hard=results.find(result=>result.error&&(result.error.status===401||transient(result.error)));
    if(hard)throw hard.error;
    const positions=await api('/api/positions',{botId:'all',silent:true});
    return {globalKill:results.some(result=>result.me?.globalKill),positions:Array.isArray(positions)?positions:[],
      bots:results.map(({bot,me,error})=>me?{...me,...bot}:{...bot,error:error?.code||'ERROR'})};
  }
  async function pool(items,limit,task){
    const out=new Array(items.length);let next=0;
    const worker=async()=>{while(next<items.length){const index=next++;out[index]=await task(items[index]);}};
    await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;
  }
  async function refresh({force=false}={}){
    if(state.inFlight||!signedIn())return;
    if(!force&&(state.paused||!visible()))return;
    // Refresh now and the header Refresh skip a cycle while the last good one is under 5 s old.
    if(force&&!state.failures&&state.lastOk&&Date.now()-state.lastOk<COOLDOWN)return;
    stopTimer();state.inFlight=true;state.signedOut=false;now.disabled=true;root.classList.add('is-refreshing');
    let signedOut=false;
    try{
      if(cache.account!==null&&cache.account!==accountKey())clearCache();
      let data=null;
      if(!state.legacy){
        try{data=await readOverview();}
        catch(error){if(error?.status!==404)throw error;state.legacy=true;clearCache();}
      }
      if(state.legacy)data=await readLegacy(force);
      state.cycle++;
      const bots=data.bots.filter(bot=>bot&&typeof bot.id==='string');
      state.bots=bots.map(({id,parent_user_id,bot_slot_index,label,status})=>({id,parent_user_id,bot_slot_index,label,status}));
      state.rows=new Map(bots.map(bot=>[bot.id,bot.error?{error:bot.error}:{me:{...bot,globalKill:bot.globalKill??data.globalKill===true}}]));
      state.positions=data.positions;
      state.failures=0;state.lastOk=Date.now();state.loaded=true;
    }catch(error){
      // Signed out: forget the cached answer and its time, so the next sign-in reads fresh data at once.
      if(error?.status===401){signedOut=true;state.signedOut=true;state.lastOk=0;clearCache();stopTicker();}else state.failures++;
    }finally{
      state.inFlight=false;now.disabled=false;root.classList.remove('is-refreshing');
      if(!signedOut)schedule(delay());
      render();
    }
  }
  function wake(){
    if(!signedIn()||!visible()||state.signedOut){stopTimer();renderStatus();return;}
    startTicker();renderStatus();
    if(state.paused||state.inFlight)return;
    const due=state.lastOk?state.lastOk+interval()-Date.now():0;
    if(due<=0)refresh();else if(!state.timer)schedule(due);
  }
  function sleep(){stopTimer();stopTicker();}

  async function openBot(id){
    try{if(id&&typeof switchBot==='function'&&selected()!==id){const switcher=document.getElementById('botSwitcher');if(switcher)switcher.value=id;await switchBot(id);}}catch{}
    document.querySelector('nav button[data-view="bots"]')?.click();
  }
  root.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target||!root.contains(target))return;
    if(target===toggle){state.paused=!state.paused;if(state.paused)stopTimer();else wake();renderStatus();return;}
    if(target===now){refresh({force:true});return;}
    if(target.dataset.ovOpen!==undefined)openBot(target.dataset.ovOpen);
  });
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')sleep();else wake();});
  document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',()=>setTimeout(()=>{if(page.hidden)sleep();else wake();},0)));
  document.getElementById('refresh')?.addEventListener('click',()=>{if(visible())refresh({force:true});});
  document.getElementById('language')?.addEventListener('change',render);
  document.getElementById('botSwitcher')?.addEventListener('change',()=>setTimeout(render,0));
  document.getElementById('logout')?.addEventListener('click',()=>{sleep();clearCache();state.bots=[];state.rows=new Map();state.positions=[];state.lastOk=0;state.loaded=false;});
  // app.js load() runs after sign-in and after every Bot switch. Wake once it finishes.
  try{
    if(typeof load==='function'){
      const loadSession=load;
      load=async function(...args){const result=await loadSession.apply(this,args);if(signedIn())state.signedOut=false;wake();render();return result;};
    }
  }catch{}
  render();
})();