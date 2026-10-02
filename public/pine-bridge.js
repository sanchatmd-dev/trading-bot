/* Private draft builder. Uses the existing authenticated api() and CSRF boundary.
   Guided panel: six steps unlock in the real fill order. bridge-wizard.js (optional) animates the steps and shows coach marks. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  // Static markup only. Every label comes from the i18n pairs; API data is never placed into this template.
  const step=(n,title,help,body)=>`<section class="pbw-step" id="pbStep${n}" data-step="${n}" data-state="locked" aria-labelledby="pbStep${n}Title"><header class="pbw-head"><span class="pbw-num" aria-hidden="true">${n}</span><h3 class="pbw-title" id="pbStep${n}Title" tabindex="-1" data-ui-label="${title}"></h3><span class="pbw-chip" data-ui-label="Locked"></span><button class="pbw-edit ghost" type="button" hidden data-ui-label="Edit"></button></header><p class="pbw-help" data-ui-label="${help}"></p><p class="pbw-summary" hidden></p><div class="pbw-collapse"><div class="pbw-inner"><div class="pbw-pad">${body}<button class="pbw-back ghost" type="button" hidden data-ui-label="Back to the current step"></button></div></div></div></section>`;
  const note=text=>`<p class="pbw-note" data-ui-label="${text}"></p>`;
  // Neutral wording only: the screen never states a price or a dollar estimate for an AI call.
  const COST="Each AI analysis or generation uses paid AI processing and counts toward your plan's limited quota.";
  const panel=document.createElement('details');panel.className='panel pbw';panel.id='pbPanel';
  panel.innerHTML=`<summary data-ui-label="Build Pine Bridge — draft preview"></summary>
    <p class="pbw-intro" data-ui-label="Submit an authorized Pine v5/v6 indicator. Convert strategies before uploading. Generated drafts need compilation and Paper checks."></p>
    <p class="pbw-intro" data-ui-label="Follow the steps in order. Each step unlocks when the one before it is done."></p>
    <button id="pbwTips" class="pbw-tips ghost" type="button" data-ui-label="Show tips again"></button>
    <p id="pbwNotice" class="pbw-notice" role="status" aria-live="polite" hidden></p>
    <div class="pbw-steps"><form id="pbAnalyze" class="pbw-form">
    ${step(1,'Choose Bot','Pick the Bot that will own this Bridge. A single Bot is selected for you.',`<label><span data-ui-label="Bot to use"></span><select id="pbBot" required></select></label><button id="pbLoadBots" class="ghost" type="button" data-ui-label="Load my Bots"></button>
      <div id="pbwActivity" class="pbw-activity"><p id="pbStatus" class="pbw-status" role="status" aria-live="polite"></p>
      <div id="pbwProgress" class="pbw-progress" hidden><div class="pbw-bar" aria-hidden="true"><span></span></div><p class="pbw-phase"><span id="pbwPhase"></span> · <span id="pbwElapsed"></span></p></div>
      <button id="pbCancel" class="ghost" type="button" hidden data-ui-label="Cancel job"></button>
      <div id="pbwFail" class="pbw-fail" role="alert" hidden><p class="pbw-fail-title" data-ui-label="The AI job did not finish"></p><p class="pbw-fail-code"><span data-ui-label="Code"></span>: <code id="pbwFailCode"></code></p><p id="pbwFailWhy" class="pbw-fail-why"></p><button id="pbwRetry" class="primary" type="button" data-ui-label="Try again"></button></div></div>`)}
    ${step(2,'Paste indicator','Paste the full Pine v5 or v6 indicator you are allowed to use, then inspect it. Inspect does not call AI.',`<label><span data-ui-label="Source name"></span><input id="pbName" maxlength="120" value="My indicator" required></label>
      <label><span data-ui-label="Original indicator"></span><textarea id="pbSource" rows="8" required spellcheck="false"></textarea></label>
      <p id="pbStrategyHint" class="pbw-warn" role="note" hidden data-ui-label="This looks like a strategy. Convert strategies to indicators first."></p>
      <button id="pbInspect" class="primary" type="button" data-ui-label="Inspect inputs (no AI)"></button>${note('Inspect only lists the inputs of the pasted source. It sends nothing to AI.')}`)}
    ${step(3,'Review inputs','Compare every value with TradingView, then confirm. Defaults are only suggestions.',`<section id="pbInputReview" hidden aria-label="Effective Pine input review"><p id="pbInputReviewStatus"></p>
      <button id="pbSptCustom" class="ghost" type="button" hidden data-ui-label="Fill SPT Custom reference values"></button>
      <h4 class="pbw-sub" data-ui-label="Review every Pine input"></h4><div id="pbInputFields"></div>
      <label class="pbw-confirm"><input id="pbInputsConfirmed" type="checkbox"><span data-ui-label="I checked every value against the TradingView indicator settings for this source and Bot."></span></label></section>`)}
    ${step(4,'Analyze with AI','The AI reads the indicator and proposes the BUY and EXIT signals.',`${note('Analyze sends the authorized source to the configured AI provider.')}${note(COST)}
      <button id="pbAnalyzeButton" class="primary" type="submit" disabled data-ui-label="Analyze indicator with AI"></button>`)}
    </form>
    ${step(5,'Configure Bridge and Generate','Set the Bridge values, check Risk settings, then generate the Pine draft and setup guide.',`<form id="pbGenerate" class="pbw-form" hidden>
      <ul id="pbwWarnings" class="pbw-warnings"></ul><div class="form-grid">
      <label><span data-ui-label="BUY variable"></span><select id="pbBuy" required></select><small class="pbw-hint" data-ui-label="A BUY opens when this variable is true at a bar close."></small></label>
      <label><span data-ui-label="Native exit variable"></span><select id="pbExit" required></select><small class="pbw-hint" data-ui-label="The Bridge closes the position when this variable is true at a bar close (reduce-only)."></small></label>
      <label><span data-ui-label="Bridge ATR Multiplier for SL"></span><input id="pbAtr" type="number" min="0.000001" max="1000" step="any" value="2.0" required><small class="pbw-hint" data-ui-label="Stop-loss distance = ATR × this value. Check the cost-to-stop in Risk manager → Order Preview before you generate."></small></label>
      <label><span data-ui-label="Bridge RR"></span><input id="pbRR" type="number" min="0.000001" max="1000" step="any" value="1.5" required><small class="pbw-hint" data-ui-label="Take-profit distance = stop distance × this value."></small></label>
      <label><span data-ui-label="Broker"></span><select id="pbBroker"><option value="binance-global">Binance Global</option><option value="binance-th">Binance TH</option><option value="innovestx">InnovestX</option><option value="settrade">Settrade</option></select></label>
      <label><span data-ui-label="Symbol"></span><input id="pbSymbol" value="BTCUSDT" pattern="[A-Z0-9]{3,30}" required></label>
      <label><span data-ui-label="Pine chart timeframe (1 = 1 minute)"></span><input id="pbTimeframe" value="1" required><small class="pbw-hint" data-ui-label="Prototype scope: BINANCE:BTCUSDT Spot, 1 minute (timeframe 1)."></small></label></div>
      <details class="pbw-adv"><summary data-ui-label="Advanced: Quant search slots (optional, does not change Pine)"></summary>
      ${note('Slots 3–10 only feed the later Quant search and the stored snapshot. They do not change the Pine draft.')}
      ${note('Select up to eight numeric inputs. Empty slots stay unused. Other inputs stay at the reviewed TradingView values recorded above. The Pine draft preserves the original source; set its TradingView inputs to those reviewed values.')}
      <div id="pbSlots"></div></details>
      <button id="pbGenerateButton" class="primary" type="submit" data-ui-label="Generate draft and setup guide"></button>${note(COST)}</form>`)}
    ${step(6,'Install in TradingView','Replace the script in TradingView and create the Bridge alert.',`<div id="pbDownloads"></div>`)}
    </div>
    <details id="pbReport" class="pbw-report" hidden><summary data-ui-label="Analysis report (not Pine code)"></summary>${note('Technical details from the AI. Do not paste this into TradingView.')}<pre id="pbDiagnostics"></pre></details>`;
  host.append(panel);
  const el=id=>document.getElementById(id);
  for(const node of panel.querySelectorAll('[data-ui-label]'))node.textContent=T(node.dataset.uiLabel);
  const WARNINGS=[
    'Settle Risk settings before Generate; saving Risk later requires a new Generate.',
    'Each Generate creates a new deployment id; use the newest draft.'
  ];
  const CHECKLIST=[
    'Open the Pine Editor in TradingView, select everything and REPLACE the whole script with bridge-draft.pine. Do not append it to the original indicator.',
    'Click Save.',
    'Click Add to chart.',
    'Set every input to the values you reviewed in step 3.',
    'Create the TradingView alert from setup-guide.txt. Use the Bridge alert only; do not use the alertcondition alerts of the original indicator.',
    'Optional: create a staging capture URL below to check that webhooks arrive. It records evidence only and does not trade.'
  ];
  const DOWNLOADS=[['bridge-draft.pine','Download bridge-draft.pine'],['setup-guide.txt','Download setup-guide.txt'],['bindings.json','Download bindings.json']];
  const PHASE={QUEUED:'Waiting in the queue',RUNNING:'The AI is reading your indicator',VALIDATING:'Checking the AI answer',RETRY_WAIT:'The AI provider asked us to wait; retrying'};
  // Plain explanations for the codes a job or a request can end with. Any other code is shown as it is, with the server text.
  const WHY={
    INDICATOR_REQUIRED:'This source is a strategy. Convert it to an indicator first.',
    UNSUPPORTED_BRIDGE_SOURCE:'The source needs one //@version=5 or //@version=6 line and exactly one indicator() call.',
    SOURCE_TOO_LARGE:'The source is too large for one AI call. Shorten it and try again.',
    SOURCE_TOKEN_BUDGET_EXCEEDED:'The source is too large for one AI call. Shorten it and try again.',
    AI_PROVIDER_NOT_CONFIGURED:'The AI provider is not configured on this server.',
    PROVIDER_RATE_LIMIT:'The AI provider is busy. Wait a minute, then try again.',
    AI_QUEUE_FULL:'Too many AI jobs are waiting. Wait a moment, then try again.',
    AI_QUOTA_EXCEEDED:"Your plan's AI limit for the last 24 hours is used up. Try again later.",
    INVALID_AI_OUTPUT:'The AI answer did not pass the safety checks. Trying again starts a new AI call.',
    JOB_DEADLINE_EXCEEDED:'The job did not finish within five minutes. Trying again starts a new AI call.',
    TIMED_OUT:'The job did not finish within five minutes. Trying again starts a new AI call.',
    OUTCOME_UNKNOWN:'The result of the AI call is unknown. Check the AI usage before you try again.',
    CANCELLED:'You cancelled this job.',
    FAILED:'The job did not finish. Nothing was generated. Trying again starts a new AI call.',
    STATUS_CHECK_FAILED:'The status check failed. The job may still be running. Try again to check the same job.'
  };
  // Codes and types come from the server: only own entries of these tables count, never inherited ones such as constructor.
  const own=(table,key)=>typeof key==='string'&&Object.hasOwn(table,key)?table[key]:undefined;
  const explain=(code,jobStatus,detail)=>{const text=own(WHY,code)??own(WHY,jobStatus);return text?T(text):detail||T('The job did not finish. Nothing was generated.');};
  const HINTS={source:'Find it in TradingView: indicator Settings → Inputs → Source (for example close).',int:'Whole number, for example 14.',float:'Decimal number, for example 2.5.',bool:'On or Off, as shown in TradingView.',string:'Text exactly as shown in TradingView.'};
  const hintFor=type=>own(HINTS,type)??'Copy the value exactly as TradingView shows it.';
  const hasStrategy=text=>/\bstrategy\s*(?:\(|\.)/.test(text.replace(/\/\/.*$/gm,''));
  for(const text of WARNINGS){const item=document.createElement('li');item.dataset.uiLabel=text;item.textContent=T(text);el('pbwWarnings').append(item);}
  const wizard=window.PbWizard?window.PbWizard.create(panel):null;
  const state={source:null,inspection:null,inspectedSource:null,inspectedBot:null,job:null,timer:null,busy:false,requests:new Map(),urls:[],bot:null,epoch:0,
    draft:null,pending:'',editing:null,frontier:1,lastOpen:0,loading:false,ready:false,op:'',fingerprint:'',failed:new Set(),started:0,clock:null};
  const status=text=>{el('pbStatus').textContent=text;};
  const option=(value,label)=>{const node=document.createElement('option');node.value=value;node.textContent=label;return node;};
  const tickClock=()=>{el('pbwElapsed').textContent=tpl('{seconds} s elapsed',{seconds:Math.max(0,Math.floor((Date.now()-state.started)/1000))});};
  const setPhase=jobStatus=>{el('pbwPhase').textContent=T(own(PHASE,jobStatus)??'Submitting…');};
  const setReport=text=>{el('pbDiagnostics').textContent=text;el('pbReport').hidden=!text;};
  const hideFailure=()=>{el('pbwFail').hidden=true;};
  function showFailure(code,jobStatus,detail){
    el('pbwFailCode').textContent=code;el('pbwFailWhy').textContent=explain(code,jobStatus,detail);el('pbwFail').hidden=false;
  }
  const setBusy=value=>{
    state.busy=value;el('pbAnalyzeButton').disabled=value||!el('pbInputsConfirmed').checked;el('pbInspect').disabled=value;el('pbGenerateButton').disabled=value;
    el('pbBot').disabled=value;el('pbSource').disabled=value;el('pbName').disabled=value;el('pbInputsConfirmed').disabled=value;
    for(const input of el('pbInputFields').querySelectorAll('input,select'))input.disabled=value;
    el('pbCancel').hidden=!value;el('pbwProgress').hidden=!value;
    clearInterval(state.clock);state.clock=null;
    if(value){state.started=Date.now();setPhase('');tickClock();state.clock=setInterval(tickClock,1000);}
    sync();
  };
  const showNotice=text=>{if(wizard)wizard.notice(T(text));else{el('pbwNotice').textContent=T(text);el('pbwNotice').hidden=false;}};
  const clearNotice=()=>{if(wizard)wizard.clearNotice();else{el('pbwNotice').textContent='';el('pbwNotice').hidden=true;}};
  // The body of a Generate request. Its JSON is also the key of a finished draft, so a later edit marks the draft stale.
  const generateBody=()=>{
    const slots=[...el('pbSlots').querySelectorAll('fieldset')].filter(row=>row.querySelector('select').value).map(row=>({slot:Number(row.querySelector('select').dataset.slot),input_id:row.querySelector('select').value,...Object.fromEntries([...row.querySelectorAll('input')].map(i=>[i.dataset.field,Number(i.value)]))}));
    return {bot_id:state.bot,pine_import_id:state.source.id,source_version:state.source.version,selected_signals:{buy:el('pbBuy').value,exit:el('pbExit').value,timing:'bar_close'},parameter_slots:slots,bridge_options:{atr_multiplier:Number(el('pbAtr').value),rr:Number(el('pbRR').value)},market:{broker:el('pbBroker').value,symbol:el('pbSymbol').value,timeframe:el('pbTimeframe').value}};
  };
  // A step is done when the facts it needs still hold. The first step that is not done is the current step.
  function completion(){
    const bot=el('pbBot').value,inspected=!!state.inspection&&state.inspectedSource===el('pbSource').value&&state.inspectedBot===bot;
    const one=bot!=='',two=one&&inspected&&el('pbName').value.trim()!=='',three=two&&el('pbInputsConfirmed').checked;
    const four=three&&!!state.source&&state.bot===bot,five=four&&!!state.draft&&state.draft.key===JSON.stringify(generateBody());
    return [one,two,three,four,five];
  }
  const botLabel=()=>el('pbBot').options[el('pbBot').selectedIndex]?.textContent||'—';
  function summaryOf(n){
    if(n===1)return tpl('Bot: {bot}',{bot:botLabel()});
    if(n===2)return tpl('{name} · {characters} characters · {count} inputs found',{name:el('pbName').value.trim(),characters:el('pbSource').value.length,count:state.inspection?.input_count??'—'});
    if(n===3)return tpl('{count} inputs reviewed',{count:state.inspection?.input_count??'—'});
    if(n===4)return tpl('Analysis ready: BUY {buy}, EXIT {exit}',{buy:state.source?.result?.proposal?.buy??'—',exit:state.source?.result?.proposal?.exit??'—'});
    return tpl('Draft generated for {symbol} timeframe {timeframe}',{symbol:state.draft?.symbol??'—',timeframe:state.draft?.timeframe??'—'});
  }
  function focusFor(n){
    if(n===1)return el('pbBot').options.length>0?el('pbBot'):el('pbLoadBots');
    if(n===2)return el('pbSource');
    if(n===3)return el('pbInputFields').querySelector('input,select')||el('pbInputsConfirmed');
    if(n===4)return el('pbAnalyzeButton');
    if(n===5)return el('pbBuy');
    return el('pbDownloads').querySelector('a');
  }
  function coachFor(n){
    if(n===1)return el('pbBot').options.length>1?{id:'bot',target:el('pbBot'),text:'Next: choose the Bot for this Bridge.'}:{id:'load',target:el('pbLoadBots'),text:'Next: load your Bots.'};
    if(n===2)return el('pbSource').value.trim()===''?{id:'source',target:el('pbSource'),text:'Next: paste your Pine indicator here. It must be an indicator, not a strategy.'}:{id:'inspect',target:el('pbInspect'),text:'Next: click Inspect inputs. This does not call AI.'};
    if(n===3)return {id:'confirm',target:el('pbInputsConfirmed'),text:'Next: compare every value with TradingView, then tick this box.'};
    if(n===4)return {id:'analyze',target:el('pbAnalyzeButton'),text:"Next: click Analyze. It makes one AI call and counts toward your plan's limited quota."};
    if(n===5)return {id:'generate',target:el('pbGenerateButton'),text:'Next: check the values above, then click Generate. Each Generate makes a new draft.'};
    const link=el('pbDownloads').querySelector('a');
    return link?{id:'install',target:link,host:el('pbDownloads').querySelector('.pbw-downloads'),text:'Next: download bridge-draft.pine, then replace the whole script in TradingView.'}:null;
  }
  const PRIMARY={4:'pbAnalyzeButton',5:'pbGenerateButton'};
  function sync({notify,enter=false}={}){
    const flags=completion(),stop=flags.indexOf(false),frontier=stop<0?6:stop+1;
    if(state.editing!==null&&state.editing>=frontier)state.editing=null;
    const open=state.editing??frontier;
    if(notify&&frontier<state.frontier)showNotice(notify);
    else if(frontier>state.frontier)clearNotice();
    state.frontier=frontier;
    const steps=[1,2,3,4,5,6].map(n=>({state:n<frontier?'done':n===frontier?'current':'locked',summary:n<frontier?summaryOf(n):'',edit:tpl('Edit step {n}',{n})}));
    const view={frontier,open,steps,focusEl:focusFor(open)};
    // The status line, progress and failure card live in the open step, next to the control that caused them.
    const box=el('pbwActivity'),pad=el('pbStep'+open).querySelector('.pbw-pad');
    if(box.parentElement!==pad)pad.insertBefore(box,pad.querySelector('.pbw-back'));
    wizard?.apply(view,{force:enter});
    // Inspect stays clickable (it explains what is missing) but looks idle until a Bot and a source exist.
    const ready=el('pbSource').value.trim()!==''&&el('pbBot').value!=='';
    el('pbInspect').classList.toggle('is-idle',!ready);
    if(ready)el('pbInspect').removeAttribute('aria-disabled');else el('pbInspect').setAttribute('aria-disabled','true');
    if(wizard){
      if(ready&&!state.ready&&frontier===2)wizard.pulse(el('pbInspect'));
      if(open!==state.lastOpen&&open===frontier){const target=el(PRIMARY[open]??'');if(target&&!target.disabled)wizard.pulse(target);}
      const want=state.busy||state.loading||open!==frontier?null:coachFor(open);
      if(want)wizard.coach(want.id,want.target,T(want.text),want.host);else wizard.hideCoach();
    }
    // A status line belongs to the step it was written for; a new step starts without the old one.
    if(state.lastOpen!==0&&open!==state.lastOpen)status('');
    state.ready=ready;state.lastOpen=open;
  }
  const RELOCK='Changes require a new review. Later steps are locked again.',STALE='Settings changed. Generate again to refresh the draft.';
  function invalidateInspection(notify){
    state.inspection=null;state.inspectedSource=null;state.inspectedBot=null;state.source=null;state.draft=null;el('pbInputsConfirmed').checked=false;el('pbInputReview').hidden=true;el('pbInputFields').replaceChildren();
    el('pbGenerate').hidden=true;el('pbDownloads').replaceChildren();el('pbAnalyzeButton').disabled=true;hideFailure();setReport('');
    sync(notify?{notify:RELOCK}:{});
  }
  function clearPrivateState(){
    state.epoch++;clearTimeout(state.timer);state.editing=null;state.loading=false;state.fingerprint='';state.failed.clear();wizard?.hideCoach();clearNotice();
    invalidateInspection();state.job=null;state.bot=null;state.requests.clear();state.urls.forEach(URL.revokeObjectURL);state.urls=[];
    el('pbSource').value='';el('pbStrategyHint').hidden=true;el('pbBot').replaceChildren();setReport('');setBusy(false);status('');
  }
  document.getElementById('logout')?.addEventListener('click',clearPrivateState);
  document.getElementById('language')?.addEventListener('change',()=>sync());
  el('pbSource').addEventListener('input',()=>{el('pbStrategyHint').hidden=!hasStrategy(el('pbSource').value);invalidateInspection(true);});
  el('pbName').addEventListener('input',()=>sync());
  el('pbBot').addEventListener('change',()=>invalidateInspection(true));
  el('pbInputsConfirmed').addEventListener('change',()=>{el('pbAnalyzeButton').disabled=state.busy||!el('pbInputsConfirmed').checked;sync();});
  function inputEdited(){
    state.source=null;state.draft=null;el('pbGenerate').hidden=true;el('pbDownloads').replaceChildren();el('pbInputsConfirmed').checked=false;el('pbAnalyzeButton').disabled=true;hideFailure();setReport('');
    sync({notify:RELOCK});
  }
  el('pbInputFields').addEventListener('input',inputEdited);
  el('pbInputFields').addEventListener('change',inputEdited);
  // A Generate field edited after a draft exists makes that draft stale; the finished files stay on the page until the next draft replaces them.
  el('pbGenerate').addEventListener('input',()=>sync({notify:STALE}));
  el('pbGenerate').addEventListener('change',()=>sync({notify:STALE}));
  // Enter in a text field must never start an AI call by accident.
  for(const form of [el('pbAnalyze'),el('pbGenerate')])form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('input:not([type=checkbox])'))event.preventDefault();});
  const sptHash='0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a';
  function showInspection(inspection){
    state.inspection=inspection;state.inspectedSource=el('pbSource').value;state.inspectedBot=el('pbBot').value;
    el('pbInputFields').replaceChildren();
    for(const item of inspection.inputs){
      const label=document.createElement('label');label.textContent=`${item.pine_variable} — ${item.input_title} (${item.type})`;
      let input;
      if(item.type==='bool'){
        input=document.createElement('select');input.append(option('',T('Select')),option('true',T('On')),option('false',T('Off')));
        input.value=item.default_hint===null?'':String(item.default_hint);
      }else{
        input=document.createElement('input');input.type=['int','float','time'].includes(item.type)?'number':'text';
        if(input.type==='number'){
          input.step=item.type==='float'?'any':'1';
          if(item.type!=='time'){if(item.declared_domain.min!==null)input.min=String(item.declared_domain.min);if(item.declared_domain.max!==null)input.max=String(item.declared_domain.max);}
        }
        input.value=item.default_hint===null?'':String(item.default_hint);
        input.placeholder=item.default_hint===null?T('Enter actual TradingView value'):'';
      }
      input.dataset.inputId=item.input_id;input.dataset.inputType=item.type;
      if(item.default_hint===null)input.dataset.manualRequired='1';
      label.append(input);
      const hint=document.createElement('small');hint.className='pbw-hint';
      if(item.type==='time')hint.textContent=item.default_hint===null?T('Unix milliseconds UTC'):`${T('Unix milliseconds UTC')} · ${new Date(item.default_hint).toISOString()}`;
      else{const text=hintFor(item.type);hint.dataset.uiLabel=text;hint.textContent=T(text);}
      label.append(hint);
      el('pbInputFields').append(label);
    }
    el('pbInputReviewStatus').textContent=tpl('{count} inputs · source SHA-256 {hash}. Defaults below are suggestions; verify all values in TradingView before AI analysis.',{count:inspection.input_count,hash:inspection.source_hash});
    el('pbSptCustom').hidden=inspection.source_hash!==sptHash;
    el('pbInputReview').hidden=false;el('pbInputsConfirmed').checked=false;el('pbAnalyzeButton').disabled=true;
    sync();
  }
  el('pbSptCustom').addEventListener('click',()=>{
    if(state.inspection?.source_hash!==sptHash)return;
    const values={preset:'Custom',stFactorInput:3.2,zoneAtrMultInput:1.15,setupExpiryInput:48,cooldownInput:8,slAtrBufferInput:0.6,notifyEnabled:false};
    for(const item of state.inspection.inputs){
      if(!Object.hasOwn(values,item.pine_variable))continue;
      const input=[...el('pbInputFields').querySelectorAll('[data-input-id]')].find(node=>node.dataset.inputId===item.input_id);
      input.value=String(values[item.pine_variable]);
    }
    inputEdited();
    status(T('SPT Custom reference values filled. Set the same values in TradingView, review all inputs, then confirm.'));
  });
  el('pbInspect').addEventListener('click',async()=>{
    if(state.busy)return;
    const source=el('pbSource').value,bot=el('pbBot').value,epoch=state.epoch;
    if(!source||!bot){status(T('Select a Bot and paste a Pine indicator first.'));return;}
    invalidateInspection();el('pbInspect').disabled=true;status(T('Inspecting Pine inputs locally…'));
    try{
      const inspection=await api('/api/quant/pine-bridge/inspect',{method:'POST',botId:bot,silent:true,body:JSON.stringify({bot_id:bot,pine_source:source})});
      if(epoch!==state.epoch||source!==el('pbSource').value||bot!==el('pbBot').value)return;
      showInspection(inspection);status(T('Review the effective input values below. No AI request has been sent.'));
    }catch(error){if(epoch===state.epoch)status(own(WHY,error.code)?T(own(WHY,error.code)):error.message);}
    finally{el('pbInspect').disabled=state.busy;}
  });
  function reviewedValues(){
    if(!state.inspection||state.inspectedSource!==el('pbSource').value||state.inspectedBot!==el('pbBot').value||!el('pbInputsConfirmed').checked)throw new Error(T('Inspect and confirm the current source, Bot and TradingView inputs first.'));
    const values={};
    for(const input of el('pbInputFields').querySelectorAll('[data-input-id]')){
      const {inputId,inputType,manualRequired}=input.dataset;
      if((manualRequired&&input.value==='')||(['int','float','time','bool'].includes(inputType)&&input.value===''))throw new Error(T('Every input needs its reviewed TradingView value.'));
      const value=inputType==='bool'?input.value==='true':['int','float','time'].includes(inputType)?Number(input.value):input.value;
      if(typeof value==='number'&&(!Number.isFinite(value)||(['int','time'].includes(inputType)&&!Number.isSafeInteger(value))))throw new Error(T('Invalid numeric TradingView input.'));
      values[inputId]=value;
    }
    if(Object.keys(values).length!==state.inspection.input_count)throw new Error(T('Input review is incomplete.'));
    return values;
  }
  // One Bot is selected for the owner; several Bots need an explicit choice. A Bot that is still in the list stays selected.
  async function loadBots(){
    const epoch=state.epoch;state.loading=true;sync();
    try{
      const response=await api('/api/bots');if(epoch!==state.epoch)return;
      const bots=Array.isArray(response?.bots)?response.bots:[],keep=el('pbBot').value;
      const pick=bots.some(b=>b.id===keep)?keep:bots.length===1?bots[0].id:'';
      el('pbBot').replaceChildren(...(bots.length===1?[]:[option('',T('Select a Bot'))]),...bots.map(b=>option(b.id,b.label)));
      el('pbBot').value=pick;
      if(!bots.length)status(T('No Bots found. Create one in Bot Manager first.'));
      if(pick!==keep)invalidateInspection(true);
    }catch(e){if(epoch===state.epoch)status(e.message);}
    finally{
      if(epoch===state.epoch){
        state.loading=false;sync();
        // Several Bots: the list is the control that needs the owner next, not the Load button that was focused.
        if(wizard&&panel.open&&state.frontier===1&&state.editing===null&&el('pbBot').options.length>1)wizard.focus(el('pbBot'),el('pbStep1'));
      }
    }
  }
  el('pbLoadBots').addEventListener('click',()=>{if(!state.busy)loadBots();});
  function duplicates(){const selects=[...el('pbSlots').querySelectorAll('select')],used=new Set(selects.map(s=>s.value).filter(Boolean));for(const select of selects)for(const o of select.options)o.disabled=!!o.value&&o.value!==select.value&&used.has(o.value);}
  function showAnalysis(result,job) {
    state.source={id:job.pine_import_id,version:job.source_version,result};state.bot=el('pbBot').value;state.draft=null;
    for(const id of ['pbBuy','pbExit'])el(id).replaceChildren(option('',T('Select a boolean variable')),...result.declarations.map(v=>option(v,v)));
    el('pbBuy').value=result.proposal.buy??'';el('pbExit').value=result.proposal.exit??'';
    const candidates=result.inputs.filter(i=>i.eligible&&result.proposal.eligible_inputs.includes(i.input_id));
    el('pbSlots').replaceChildren();
    for(let i=3;i<=10;i++) {
      const row=document.createElement('fieldset');row.className='form-grid';const label=document.createElement('label');label.textContent='Slot '+i;
      const select=document.createElement('select');select.dataset.slot=i;select.append(option('',T('Unused')),...candidates.map(c=>option(c.input_id,`${c.pine_variable} (${c.type}, ${c.effective_value}) — Quant pending`)));label.append(select);row.append(label);
      for(const field of ['min','max','step']){const l=document.createElement('label');l.textContent=field;const input=document.createElement('input');input.type='number';input.step='any';input.dataset.field=field;input.disabled=true;l.append(input);row.append(l);}
      select.addEventListener('change',()=>{const c=candidates.find(c=>c.input_id===select.value);for(const input of row.querySelectorAll('input')){input.disabled=!c;input.required=!!c;input.value=c?(c.declared_domain[input.dataset.field]??(input.dataset.field==='step'?(c.type==='int'?1:.1):c.effective_value)):'';}duplicates();});
      el('pbSlots').append(row);
    }
    el('pbGenerate').hidden=false;
    setReport(JSON.stringify({bridge:result.bridge_capability,quant:result.quant_capability,diagnostics:result.proposal.diagnostics},null,2));
    sync();
  }
  function showDraft(result){
    state.urls.forEach(URL.revokeObjectURL);state.urls=[];el('pbDownloads').replaceChildren();
    const files=[result.integrated_pine,result.webhook_setup,JSON.stringify({bindings:result.bindings,fixed_inputs:result.fixed_inputs,source_hash:result.source_hash,effective_inputs_hash:state.source?.result?.effective_inputs_hash,effective_input_review:state.source?.result?.effective_input_review,instruction_versions:result.instruction_versions},null,2)];
    const links=document.createElement('div');links.className='pbw-downloads';
    DOWNLOADS.forEach(([name,text],index)=>{
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([files[index]],{type:'text/plain;charset=utf-8'}));state.urls.push(a.href);a.download=name;a.dataset.uiLabel=text;a.textContent=T(text);
      const p=document.createElement('p');p.append(a);links.append(p);
    });
    const heading=document.createElement('h4'),list=document.createElement('ol');heading.className='pbw-sub';heading.dataset.uiLabel='Do this in TradingView, in order';heading.textContent=T('Do this in TradingView, in order');list.className='pbw-checklist';
    for(const text of CHECKLIST){const item=document.createElement('li');item.dataset.uiLabel=text;item.textContent=T(text);list.append(item);}
    el('pbDownloads').append(links,heading,list);
    setReport(JSON.stringify({status:result.artifact_status,bridge:result.bridge_capability,quant:result.quant_capability,diagnostics:result.diagnostics},null,2));
    const capture=document.createElement('button');capture.type='button';capture.className='ghost';capture.dataset.uiLabel='Create staging capture URL';capture.textContent=T('Create staging capture URL');
    const captureNote=document.createElement('p');captureNote.className='pbw-note';captureNote.dataset.uiLabel='Capture records webhook evidence only. It does not execute trades or make the draft ready.';captureNote.textContent=T(captureNote.dataset.uiLabel);
    el('pbDownloads').append(captureNote,capture);
    const market=state.pending?JSON.parse(state.pending).market:{};
    state.draft={key:state.pending,symbol:market.symbol,timeframe:market.timeframe};
    capture.addEventListener('click',async()=>{
      const epoch=state.epoch;capture.disabled=true;
      try{
        const session=await api('/api/quant/pine-bridge/deployments/'+result.deployment_id+'/capture',{method:'POST',botId:state.bot,silent:true,body:JSON.stringify({ttl_seconds:604800})});
        if(epoch!==state.epoch)return;
        const url=document.createElement('input');url.readOnly=true;url.value=session.capture_url??session.capture_path;url.setAttribute('aria-label',T(session.capture_url?'Private staging capture URL':'Capture path; public staging origin is not configured'));
        const resultBox=document.createElement('pre'),refresh=document.createElement('button'),close=document.createElement('button');refresh.type=close.type='button';refresh.className=close.className='ghost';refresh.dataset.uiLabel='Refresh capture evidence';refresh.textContent=T('Refresh capture evidence');close.dataset.uiLabel='Close capture';close.textContent=T('Close capture');
        const check=async(stop=false)=>{
          try{
            const record=await api('/api/quant/pine-bridge/captures/'+session.capture_id+(stop?'/close':''),stop?{method:'POST',botId:state.bot,silent:true,body:'{}'}:undefined);
            if(epoch!==state.epoch)return;
            resultBox.textContent=JSON.stringify(record,null,2);if(stop){url.value='';refresh.disabled=close.disabled=true;}
          }catch(error){if(epoch===state.epoch)status(error.message);}
        };
        refresh.addEventListener('click',()=>check());close.addEventListener('click',()=>check(true));
        el('pbDownloads').append(url,refresh,close,resultBox);await check();
      }catch(error){if(epoch===state.epoch){status(error.message);capture.disabled=false;}}
    });
    sync();
  }
  async function poll(){
    const epoch=state.epoch;
    try{
      const job=await api('/api/quant/pine-bridge/jobs/'+state.job);if(epoch!==state.epoch)return;status(job.job_status+(job.diagnostic?' — '+job.diagnostic:''));
      if(['QUEUED','RUNNING','VALIDATING','RETRY_WAIT'].includes(job.job_status)){setPhase(job.job_status);state.timer=setTimeout(poll,2000);return;}
      setBusy(false);
      if(job.job_status==='SUCCEEDED'){if(job.result.integrated_pine)showDraft(job.result);else showAnalysis(job.result,job);}
      // A finished job keeps its idempotency key on the server: trying again must send a new key to start a new job.
      else{state.failed.add(state.fingerprint);showFailure(job.diagnostic||job.job_status,job.job_status,null);}
    }catch(e){if(epoch!==state.epoch)return;if(e.status===401){clearPrivateState();return;}setBusy(false);status(e.message+' — refresh status with the same job ID: '+state.job);showFailure(e.code||'STATUS_CHECK_FAILED',null,e.code?e.message:null);}
  }
  async function submit(operation,body){
    const epoch=state.epoch;
    const fingerprint=operation+JSON.stringify(body);
    if(state.failed.delete(fingerprint))state.requests.delete(fingerprint);
    let key=state.requests.get(fingerprint);if(!key){key=crypto.randomUUID();state.requests.set(fingerprint,key);}
    state.op=operation;state.fingerprint=fingerprint;hideFailure();
    setBusy(true);status(T('Submitting…'));
    try{const job=await api('/api/quant/pine-bridge/'+operation,{method:'POST',botId:body.bot_id,silent:true,headers:{'Idempotency-Key':key},body:JSON.stringify(body)});if(epoch!==state.epoch)return;state.job=job.job_id;clearTimeout(state.timer);await poll();}
    catch(e){if(epoch===state.epoch){setBusy(false);status(e.message);showFailure(e.code||'REQUEST_FAILED',null,e.message);}}
  }
  function runAnalyze(){
    if(state.busy)return;
    try{
      const values=reviewedValues();el('pbGenerate').hidden=true;state.source=null;state.draft=null;
      submit('analyze',{bot_id:el('pbBot').value,pine_source:el('pbSource').value,source_name:el('pbName').value,effective_inputs:values,input_review:{source_hash:state.inspection.source_hash,confirmed:true}});
    }catch(error){status(error.message);}
  }
  function runGenerate(){
    if(state.busy||!state.source)return;
    if(el('pbBot').value!==state.bot){status(T('Bot changed. Analyze source for the selected Bot.'));return;}
    const body=generateBody();state.pending=JSON.stringify(body);
    submit('generate',body);
  }
  el('pbAnalyze').addEventListener('submit',event=>{event.preventDefault();runAnalyze();});
  el('pbGenerate').addEventListener('submit',event=>{event.preventDefault();runGenerate();});
  el('pbwRetry').addEventListener('click',()=>{hideFailure();if(state.op==='generate')runGenerate();else runAnalyze();});
  el('pbCancel').addEventListener('click',async()=>{if(!state.job)return;try{await api('/api/quant/pine-bridge/jobs/'+state.job+'/cancel',{method:'POST',botId:el('pbBot').value,silent:true,body:'{}'});clearTimeout(state.timer);await poll();}catch(e){status(e.message);}});
  panel.addEventListener('click',event=>{
    const edit=event.target.closest('.pbw-edit'),back=event.target.closest('.pbw-back');
    if(edit){state.editing=Number(edit.closest('.pbw-step').dataset.step);sync({enter:true});}
    else if(back){state.editing=null;sync({enter:true});}
  });
  el('pbwTips').addEventListener('click',()=>{wizard?.resetTips();sync();});
  // Opening the panel loads the Bots once and moves the focus to the first step that needs the owner.
  panel.addEventListener('toggle',()=>{
    if(!panel.open)return;
    sync({enter:true});
    if(!state.busy&&!state.loading&&el('pbBot').options.length===0)loadBots();
  });
  // The journey page asks the panel to show its current step. Without this handler it scrolls to the whole panel instead.
  panel.addEventListener('pb:reveal',event=>{
    event.preventDefault();panel.open=true;sync();
    const card=el('pbStep'+(state.editing??state.frontier));
    if(wizard)wizard.reveal(card,focusFor(state.editing??state.frontier));
    else if(typeof card.scrollIntoView==='function')card.scrollIntoView({block:'start'});
    if(!state.loading&&el('pbBot').options.length===0)loadBots();
  });
  sync();
})();
