/* Setup guide: the seven steps from AI analysis to a running Paper Bot, for the selected Bot in Bot Manager.
   It reads status only (GET) and never starts, activates or saves anything: each button opens the screen where the
   owner does that step, or copies this Bot's webhook. Status loads when Bot Manager opens, when the Bot changes and on
   Check again; it is not polled. Text is set with textContent only. */
(() => {
  const page=document.querySelector('[data-page="bots"]'),slots=document.getElementById('botSlots');
  if(!page||!slots)return;
  const STEPS=[
    {key:'bot',title:'Create the Bot',text:'Each Bot has its own webhook, risk policy and Paper funds.'},
    {key:'analyze',title:'Analyze your indicator with AI',text:'Quant Lab, Build Pine Bridge: add your Pine indicator, check its inputs, then run Analyze.',action:'Open Pine Bridge',go:'bridge'},
    {key:'draft',title:'Generate the draft Pine',text:'Choose the BUY and exit variables, the ATR multiplier and RR, then generate the draft and its setup guide.',action:'Open Pine Bridge',go:'bridge'},
    {key:'activate',title:'Activate the draft for Paper',text:'Activation makes the draft the READY Bridge of this Bot. No real orders are sent.',action:'Open Pine Bridge',go:'bridge'},
    {key:'alert',title:'Connect the TradingView alert',text:'Add the generated Pine to your TradingView chart and paste the webhook of this Bot into its alert. Done when the first signal arrives.',action:'Copy webhook',go:'copy'},
    {key:'risk',title:'Set risk limits and check readiness',text:'Save the risk policy and Paper funding of this Bot, then read its readiness report.',action:'Open Risk manager',go:'risk'},
    {key:'run',title:'Run the Bot in Paper',text:'Use Run on the Bot card below. You confirm before it starts. Live trading stays locked.',action:'Go to Run',go:'run'}];
  const VERDICTS={READY_TO_START_PAPER:'Ready to start Paper collection',INSUFFICIENT_ACTIVITY:'Insufficient activity',CAPABILITY_UNAVAILABLE:'Capability unavailable',
    CONFIGURATION_FAILURE:'Configuration failure',EXECUTION_FAULT_REVIEW_REQUIRED:'Execution fault \u2014 review required'};
  const BLOCKING=['CONFIGURATION_FAILURE','EXECUTION_FAULT_REVIEW_REQUIRED'];
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(_,key)=>String(values[key]??''));
  const make=(tag,cls,...children)=>{const node=document.createElement(tag);if(cls)node.className=cls;for(const child of children)if(child!==null&&child!==undefined&&child!==false)node.append(child);return node;};
  const label=(text,tag='span',cls)=>{const node=make(tag,cls);node.dataset.uiLabel=text;node.textContent=T(text);return node;};
  const botId=()=>{try{const value=typeof selectedBot==='string'?selectedBot:'';return value||(typeof me!=='undefined'&&me?.user?.id)||'';}catch{return '';}};
  const sessionOf=id=>{try{const known=typeof botSessions!=='undefined'?botSessions[id]?.state:null;return known||(typeof me!=='undefined'&&me?.botSession?.state)||'SETUP';}catch{return 'SETUP';}};
  const riskOf=()=>{try{return typeof me!=='undefined'&&me?.risk?me.risk:null;}catch{return null;}};
  const state={seq:0,loading:false,data:null,checkedAt:0};

  const panel=make('section','panel sg');panel.id='sgPanel';panel.setAttribute('aria-labelledby','sgTitle');
  const title=label('Setup guide','h2','sg-title');title.id='sgTitle';
  const count=make('span','sg-count');count.setAttribute('role','status');
  const stamp=make('span','sg-stamp');
  const check=label('Check again','button','ghost sg-check');check.type='button';
  const bar=make('ol','sg-bar');bar.setAttribute('aria-hidden','true');
  const list=make('ol','sg-steps');
  const scopeNote=label('Select one Bot to see its setup steps.','p','sg-note');scopeNote.hidden=true;
  panel.append(make('div','sg-head',make('div',null,title,label('From AI analysis to a running Paper Bot. Each button opens the screen for that step; nothing starts by itself.','p','sg-sub')),
    make('div','sg-meta',count,stamp,check)),bar,list,scopeNote);
  slots.before(panel);

  function statuses(data){
    const bridge=data?.bridge,by=bridge?.deployments?.by_state||{},jobs=bridge?.jobs||{};
    const drafted=!!jobs.latest?.has_draft||(by.DRAFT||0)>0||(by.READY||0)>0||(by.EXIT_ONLY||0)>0;
    const analyzed=drafted||((bridge?.sources?.count||0)>0&&(jobs.by_status?.SUCCEEDED||0)>0);
    const policy=typeof runReadiness==='function'?runReadiness('SETUP',riskOf()):{ready:!!riskOf()};
    const verdict=data?.report?.verdict,session=sessionOf(data?.id);
    const bridgeState=done=>!data?'loading':data.bridgeError?'unknown':done?'done':'todo';
    return {
      bot:'done',analyze:bridgeState(analyzed),draft:bridgeState(drafted),activate:bridgeState((by.READY||0)>0),
      alert:!data?'loading':data.signalsError?'unknown':Array.isArray(data.signals)&&data.signals.length?'done':'todo',
      risk:!data?'loading':!policy.ready||BLOCKING.includes(verdict)?'todo':verdict==='READY_TO_START_PAPER'?'done':'warn',
      run:session==='RUNNING'?'done':session==='PAUSED'||session==='STOPPED'?'warn':'todo',
      verdict,policyReason:policy.ready?'':policy.reason,session};
  }
  function chipOf(key,status,current,info){
    if(status==='done')return label('Done','span','st st-ok');
    if(status==='loading')return label('Checking\u2026','span','st st-idle');
    if(status==='unknown')return label('Unavailable','span','st st-idle');
    if(status==='warn'){
      if(key==='risk')return label(info.verdict&&VERDICTS[info.verdict]?VERDICTS[info.verdict]:'Not checked','span','st st-warn');
      return label(info.session==='PAUSED'?'Paused':'Stopped','span','st st-warn');
    }
    return current?label('Do this now','span','st st-info'):label('Not yet','span','st st-idle');
  }
  function render(){
    const id=botId(),all=id==='all';
    scopeNote.hidden=!all;bar.hidden=list.hidden=all;check.hidden=all;
    if(all){count.textContent='';stamp.textContent='';return;}
    const info=statuses(state.data&&state.data.id===id?state.data:null);
    const current=STEPS.findIndex(step=>['todo','unknown'].includes(info[step.key]));
    const done=STEPS.filter(step=>info[step.key]==='done').length;
    count.textContent=done===STEPS.length?T('Setup complete'):tpl('{n} of {total} steps done',{n:done,total:STEPS.length});
    stamp.textContent=state.loading?T('Checking\u2026'):state.checkedAt?tpl('Checked {time}',{time:new Date(state.checkedAt).toLocaleTimeString(document.documentElement.lang==='th'?'th-TH':'en-GB',{hour:'2-digit',minute:'2-digit'})}):'';
    bar.replaceChildren(...STEPS.map((step,index)=>make('li','sg-seg sg-'+(info[step.key]==='done'?'done':index===current?'current':info[step.key]==='warn'?'warn':'todo'))));
    list.replaceChildren(...STEPS.map((step,index)=>{
      const status=info[step.key],isCurrent=index===current;
      const item=make('li','sg-step sg-'+(status==='done'?'done':isCurrent?'current':status==='warn'?'warn':'todo'));item.dataset.step=step.key;
      if(isCurrent)item.setAttribute('aria-current','step');
      const body=make('div','sg-body',make('div','sg-line',label(step.title,'strong','sg-name'),chipOf(step.key,status,isCurrent,info)));
      if(status!=='done'||isCurrent)body.append(label(step.text,'p','sg-text'));
      if(step.key==='risk'&&info.policyReason&&status!=='done')body.append(make('p','sg-reason',info.policyReason));
      if(status==='unknown')body.append(label('Could not read this status.','p','sg-reason'));
      // Buttons only where they help now: the current step, a step needing attention, or an independent step not covered by the current button.
      const useful=isCurrent||status==='warn'||(status==='todo'&&step.key!=='run'&&step.go!==STEPS[current]?.go);
      if(step.action&&status!=='done'&&useful){const go=label(step.action,'button',isCurrent?'primary sg-go':'ghost sg-go');go.type='button';go.dataset.sgGo=step.go;body.append(go);}
      item.append(make('span','sg-num',String(index+1)),body);
      return item;
    }));
  }
  const settled=result=>result.status==='fulfilled'?result.value:null;
  async function refresh(){
    const id=botId();
    if(!id||id==='all'||page.hidden||typeof api!=='function'){render();return;}
    const seq=++state.seq;state.loading=true;render();
    const [bridge,signals,report]=await Promise.allSettled([
      api('/api/quant/pine-bridge/overview',{botId:id,silent:true}),
      api('/api/signals?limit=1',{botId:id,silent:true}),
      api('/api/risk/readiness-report',{botId:id,silent:true})]);
    if(seq!==state.seq)return;
    state.data={id,bridge:settled(bridge),bridgeError:bridge.status==='rejected',signals:settled(signals),signalsError:signals.status==='rejected',report:settled(report)};
    state.loading=false;state.checkedAt=Date.now();render();
  }

  function openBridge(){
    document.querySelector('nav button[data-view="quant"]')?.click();
    const bridge=document.getElementById('pbPanel');if(!bridge)return;
    bridge.open=true;
    const handled=!bridge.dispatchEvent(new CustomEvent('pb:reveal',{cancelable:true}));
    if(!handled&&typeof bridge.scrollIntoView==='function')bridge.scrollIntoView({block:'start'});
  }
  function act(go){
    const id=botId();
    if(go==='bridge')openBridge();
    else if(go==='copy')slots.querySelector('[data-bot-copy="'+CSS.escape(id)+'"]')?.click();
    else if(go==='risk'){document.querySelector('nav button[data-view="risk"]')?.click();document.getElementById('pf3Panel')?.scrollIntoView?.({block:'start'});}
    else if(go==='run'){const run=slots.querySelector('[data-bot-card="'+CSS.escape(id)+'"] .tcp-btn--run');if(run){run.scrollIntoView?.({block:'center'});run.focus();}}
  }
  panel.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target||!panel.contains(target))return;
    if(target===check){refresh();return;}
    if(target.dataset.sgGo)act(target.dataset.sgGo);
  });
  document.querySelectorAll('nav button').forEach(button=>button.addEventListener('click',()=>setTimeout(()=>{if(!page.hidden)refresh();},0)));
  document.getElementById('botSwitcher')?.addEventListener('change',()=>setTimeout(()=>{state.data=null;if(!page.hidden)refresh();else render();},0));
  document.getElementById('language')?.addEventListener('change',render);
  // Session state changes (Run, Pause, Stop) reach botSessions through refreshBots(); draw again afterwards.
  try{
    if(typeof refreshBots==='function'){
      const loadBots=refreshBots;
      refreshBots=async function(...args){const result=await loadBots.apply(this,args);render();return result;};
    }
  }catch{}
  render();
})();