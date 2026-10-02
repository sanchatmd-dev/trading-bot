/* Prototype journey: read-only P0 staging status. Shows live API data and static status text only; no fixtures.
   Uses the existing authenticated api() boundary and renders every value with textContent. */
(() => {
  const page=document.querySelector('[data-page="journey"]');if(!page)return;
  const root=page.querySelector('#journeyRoot')||page.appendChild(Object.assign(document.createElement('div'),{id:'journeyRoot'}));
  const DAY=86400000,SIGNAL_LIMIT=200,RUN_ROWS=5;
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  const make=(tag,className,...children)=>{
    const element=document.createElement(tag);if(className)element.className=className;
    for(const child of children)if(child!==null&&child!==undefined&&child!==false)element.append(child);
    return element;
  };
  const label=(text,tag='span',className)=>{const element=make(tag,className);element.dataset.uiLabel=text;element.textContent=T(text);return element;};
  const utc=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC':'—';
  const short=id=>typeof id==='string'&&id?id.slice(0,8):'—';
  const dash=value=>value===null||value===undefined||value===''?'—':String(value);
  const chip=(text,tone)=>({text,tone});
  const hash=value=>make('span','jr-hash',dash(value));
  const errorCode=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');

  // Evidence rows: a translated static label plus a value that comes from the API or the loaded session.
  const row=(key,...value)=>make('div','jr-ev',label(key,'span','jr-k'),make('span','jr-v',...value));
  const note=text=>make('div','jr-ev jr-note',label(text));
  const pendingRow=()=>note('Checking…');
  const failedRow=(...codes)=>make('div','jr-ev jr-ev-error',label('Not available'),' (',make('code','jr-code',[...new Set(codes)].join(', ')),')');

  const STEPS=[
    {n:1,title:'AI chatbot Bridge',view:'quant',bridge:true,
      now:'Quant Lab → Build Pine Bridge: inspect inputs locally (no AI), then Analyze/Generate sends the authorized indicator to the configured AI provider and returns a draft Pine with a guide.',
      next:'Re-verify one fresh end-to-end AI job on this release.'},
    {n:2,title:'Ten numeric inputs',view:'quant',bridge:true,
      now:'Contract supports 2–10 slots: up to eight selected numeric source inputs plus Bridge ATR Multiplier and RR.',
      next:'Select a supported source with eight eligible numeric inputs and round-trip all ten through UI, generated Pine and stored snapshot.'},
    {n:3,title:'Preflight and Risk settings',view:'risk',
      now:'Risk manager → Order Preview: saved or hypothetical Draft authority, Generic or Bridge mode, venue filters and cost estimates. A preview saves nothing.',
      next:'Historical Preflight on staging (PF-2/R7), PF-3 report and PF-4 deterministic recommendations with before/after values and explicit save.'},
    {n:4,title:'Real signals and Paper execution',view:'signals',
      now:'Trade log shows each signal from receipt through the Risk decision to the simulated Paper fill. Live trading stays locked.',
      next:'Trace one real TradingView BUY and targeted EXIT with ledger evidence in a bounded observation window.'},
    {n:5,title:'Quant optimizer',view:'quant',research:true,
      now:'Research job: prepare ten inputs from a preserved run, choose the dataset, then review the frozen request. Submission requires open research admission and server readiness checks.',
      next:'One owner-confirmed bounded research job with a declared budget and holdout rules. Independent historical Preflight gates remain separate; results still require acceptance.'},
    {n:6,title:'Quant Library and selection',view:'quant',library:true,
      now:'Research Library lists every preserved run with provenance, including failed, insufficient and cancelled runs. Development scores are not recommendations; no qualified winner exists.',
      next:'Full QR-3 comparison objectives and QR-4 validation-gated reporting (QL-4B/QL-4C).'}
  ];

  const pending=()=>({pending:true});
  const state={seq:0,checkedAt:null,bots:pending(),overview:pending(),history:pending(),library:pending(),readiness:null};
  // me, signals and selectedBot belong to app.js. Absent globals read as unavailable, never as empty data.
  const session=()=>({me:typeof me==='undefined'?null:me,signals:typeof signals==='undefined'?null:signals,scope:typeof selectedBot==='undefined'?'':selectedBot});

  function scopeName(current){
    if(current.scope==='all')return T('All Bots');
    const bots=state.bots.ok&&Array.isArray(state.bots.data.bots)?state.bots.data.bots:[];
    const own=bots.find(bot=>bot.id===(current.scope||current.me?.bot?.id));
    return own?.label||current.me?.bot?.label||T('Main Bot');
  }
  function signalStats(list){
    const cutoff=Date.now()-DAY;let received=0,filled=0,rejected=0,latest=null,oldest=null;
    for(const item of list){
      const at=Number(item?.received_at);if(!Number.isFinite(at))continue;
      if(latest===null||at>latest)latest=at;
      if(oldest===null||at<oldest)oldest=at;
      if(at>=cutoff){received++;if(item.status==='FILLED')filled++;if(item.status==='REJECTED')rejected++;}
    }
    return {received,filled,rejected,latest,capped:list.length>=SIGNAL_LIMIT&&oldest!==null&&oldest>=cutoff};
  }
  function gridText(values){
    if(!Array.isArray(values)||!values.length)return '—';
    return tpl('{min}–{max} ({count} values)',{min:Math.min(...values),max:Math.max(...values),count:values.length});
  }
  const candidates=run=>dash(run.candidates_completed)+' / '+dash(run.candidates_planned);

  function step1(){
    const overview=state.overview;
    if(overview.pending)return {chip:chip('Checking…','muted'),rows:[pendingRow()]};
    if(!overview.ok)return {chip:chip('Unavailable','bad'),rows:[failedRow(overview.code)]};
    const data=overview.data;
    if(data.bridge_enabled!==true)return {chip:chip('Unavailable','bad'),rows:[note('Bridge is disabled on this release.')]};
    const live=data.ai?.configured===true,sources=data.sources||{},latest=sources.latest,job=data.jobs?.latest;
    const rows=[row('AI provider',live?dash(data.ai.provider)+' · '+dash(data.ai.model):T('Not configured')),row('Analyzed sources',dash(sources.count))];
    if(latest)rows.push(row('Latest source',dash(latest.source_name)+' · v'+dash(latest.source_version)),row('Source hash',hash(latest.source_hash)));
    rows.push(row('AI jobs',Object.entries(data.jobs?.by_status||{}).map(([status,count])=>status+' '+count).join(' · ')||T('None yet')));
    if(job){
      rows.push(row('Latest job',dash(job.operation)+' · '+dash(job.job_status)+' · '+utc(job.created_at)+(job.has_draft?' · '+T('draft returned'):'')));
      // Tokens only: the screen never shows a price for an AI call, so the recorded cost_usd is not displayed.
      const usage=job.usage_summary;
      rows.push(row('AI usage (latest job)',usage?tpl('{input} in / {output} out tokens',{input:usage.input_tokens,output:usage.output_tokens}):T('Not recorded')));
      if(job.diagnostic)rows.push(row('Diagnostic',job.diagnostic));
    }
    return {chip:live?chip('Live on staging','ok'):chip('Unavailable','bad'),rows};
  }

  function step2(){
    const {history,overview}=state,partial=chip('Partial','warn');
    const run=history.ok&&Array.isArray(history.data.runs)?history.data.runs.find(item=>Array.isArray(item.source_slots)):null;
    if(run)return {chip:partial,rows:[row('Latest research run',short(run.run_id)),row('Source slots in run',String(run.source_slots.length)),
      row('ATR multiplier grid',gridText(run.bridge_domains?.atr_multiplier)),row('RR grid',gridText(run.bridge_domains?.rr))]};
    const latest=overview.ok?overview.data.sources?.latest:null,inputs=latest?.numeric_inputs;
    if(inputs)return {chip:partial,rows:[row('Latest source',dash(latest.source_name)+' · v'+dash(latest.source_version)),
      row('Numeric inputs',dash(inputs.total)),row('Eligible numeric inputs',dash(inputs.eligible)),
      row('Input review confirmed',inputs.reviewed?T('Yes'):T('No')),row('Selected source slots',dash(inputs.selected_slots))]};
    if(history.pending||overview.pending)return {chip:partial,rows:[pendingRow()]};
    const failed=[history,overview].filter(item=>!item.ok).map(item=>item.code);
    if(failed.length)return {chip:partial,rows:[failedRow(...failed)]};
    if(overview.data.bridge_enabled!==true)return {chip:partial,rows:[note('Bridge is disabled on this release.')]};
    return {chip:partial,rows:[latest?note('Input details are not available for the latest source.'):note('No analyzed source or research run yet.')]};
  }

  function step3(current){
    const rows=[];
    if(current.me){
      rows.push(row('Bot session',current.me.botSession?.state?T(current.me.botSession.state):'—'),
        row('Paper accounts',Array.isArray(current.me.paperAccounts)?String(current.me.paperAccounts.length):'—'));
    }else rows.push(note('Not available'));
    const {bots,overview}=state;
    if(bots.pending)rows.push(pendingRow());
    else if(!bots.ok)rows.push(failedRow(bots.code));
    else rows.push(row('Bots',dash(bots.data.bots?.length)+' / '+dash(bots.data.maxBots)));
    if(overview.pending)rows.push(pendingRow());
    else if(!overview.ok)rows.push(failedRow(overview.code));
    else if(overview.data.bridge_enabled!==true)rows.push(note('Bridge is disabled on this release.'));
    else{
      const ready=overview.data.deployments?.latest_ready;
      rows.push(row('Ready Bridge deployments',dash(overview.data.deployments?.by_state?.READY??0)));
      if(ready)rows.push(row('Latest ready deployment',short(ready.deployment_id)+' · v'+dash(ready.source_version)+' · '+utc(ready.created_at)),row('Snapshot hash',hash(ready.snapshot_hash)));
    }
    // The PF-3 readiness report of the Risk manager panel, once the owner has opened it. No request is made here.
    const readiness=state.readiness;
    if(readiness)rows.push(row('Readiness verdict',dash(readiness.verdict)),row('Report bot',hash(readiness.bot_id)),
      row('Report time',utc(Date.parse(readiness.generated_at))),row('Historical evidence',dash(readiness.historical_status)));
    return {chip:chip('Preview available','info'),rows};
  }

  function step4(current){
    if(!Array.isArray(current.signals))return {chip:chip('Unavailable','bad'),rows:[note('Not available')]};
    const stats=signalStats(current.signals);
    return {chip:stats.received>0?chip('Receiving','ok'):chip('Idle','muted'),rows:[
      row('Bot scope',scopeName(current)),row('Signals received (24 h)',String(stats.received)),
      row('Filled (24 h)',String(stats.filled)),row('Rejected (24 h)',String(stats.rejected)),
      row('Latest signal received',stats.latest===null?T('None yet'):utc(stats.latest)),
      ...(stats.capped?[note('Counts cover the latest 200 loaded signals.')]:[])]};
  }

  function step5(){
    const history=state.history;
    if(history.pending)return {chip:chip('Checking…','muted'),rows:[pendingRow()]};
    if(!history.ok)return {chip:chip('Unavailable','bad'),rows:[failedRow(history.code)]};
    const status=history.data.admission_enabled===true?chip('Admission open','ok'):chip('Paused — admission closed','warn');
    const run=Array.isArray(history.data.runs)?history.data.runs[0]:null;
    if(!run)return {chip:status,rows:[note('No research runs recorded yet.')]};
    const reason=run.result_summary?.completion_reason;
    return {chip:status,rows:[row('Latest run status',dash(run.status)),row('Candidates',candidates(run)),row('Run ID',short(run.run_id)),
      row('Dataset hash',hash(run.dataset_hash)),row('Created (UTC)',utc(run.created_at)),
      ...(typeof reason==='string'?[row('Completion reason',reason)]:[]),...(run.diagnostic?[row('Diagnostic',run.diagnostic)]:[])]};
  }

  // Step 6 reads the Research Library: counts per group and the class of the latest run. No view names a winner.
  const GROUPS=[['COMPLETED','Completed'],['INSUFFICIENT','Insufficient'],['FAILED','Failed'],['CANCELLED','Cancelled'],['ACTIVE','In progress']];
  const CLASS_TEXT={IN_PROGRESS:'In progress',CANCELLED:'Cancelled',TIMED_OUT:'Timed out',INSUFFICIENT_DATA:'Insufficient data',FAILED:'Failed',
    CANDIDATE_PENDING_ACCEPTANCE:'Candidate pending acceptance',INSUFFICIENT_EVIDENCE:'Insufficient evidence',NO_VALID_CANDIDATE:'No valid candidate'};
  function step6(){
    const library=state.library;
    if(library.pending)return {chip:chip('Checking…','muted'),rows:[pendingRow()]};
    if(!library.ok)return {chip:chip('Unavailable','bad'),rows:[failedRow(library.code)]};
    const data=library.data,totals=data.totals&&typeof data.totals==='object'?data.totals:{},latest=Array.isArray(data.runs)?data.runs[0]:null;
    const total=Number.isSafeInteger(totals.all)?totals.all:0;
    const rows=[make('div','jr-ev jr-note',tpl('{n} runs in library',{n:total})),
      row('Runs by group',GROUPS.map(([key,text])=>T(text)+' '+(Number.isSafeInteger(totals[key])?totals[key]:0)).join(' · ')),
      note('Qualified recommendations: none. No qualified winner.')];
    if(latest)rows.push(row('Latest run',short(latest.run_id)+' · '+(Object.hasOwn(CLASS_TEXT,latest.library_class)?T(CLASS_TEXT[latest.library_class]):dash(latest.library_class))));
    return {chip:chip('Inspection only','ok'),rows};
  }

  const stamp=make('p','jr-stamp');stamp.hidden=true;
  const cards=STEPS.map(step=>{
    const evidence=make('div','jr-evidence'),chipElement=make('span','jr-chip');
    const open=label('Open','button','ghost jr-open');open.type='button';open.dataset.step=String(step.n);
    const article=make('article','panel jr-card',
      make('div','jr-head',make('h2','jr-title',make('span','jr-num',String(step.n)),' ',label(step.title)),chipElement),
      make('section','jr-block',label('Available now','h3'),label(step.now,'p')),
      make('section','jr-block',label('Evidence','h3'),evidence),
      make('section','jr-block',label('Next dependency','h3'),label(step.next,'p')),open);
    article.dataset.step=String(step.n);
    return {article,evidence,chipElement};
  });
  root.replaceChildren(stamp,...cards.map(card=>card.article));

  // One failing card never blanks the others: unexpected API shapes degrade to a coded Not available row.
  const guard=build=>{try{return build();}catch{return {chip:chip('Unavailable','bad'),rows:[failedRow('RENDER_ERROR')]};}};
  function render(){
    const current=session(),results=[guard(step1),guard(step2),guard(()=>step3(current)),guard(()=>step4(current)),guard(step5),guard(step6)];
    cards.forEach((card,index)=>{
      const {chip:status,rows}=results[index];
      card.chipElement.className='jr-chip jr-'+status.tone;card.chipElement.dataset.uiLabel=status.text;card.chipElement.textContent=T(status.text);
      card.evidence.replaceChildren(...rows);
    });
    stamp.hidden=state.checkedAt===null;
    stamp.textContent=state.checkedAt===null?'':tpl('Status checked: {time}',{time:utc(state.checkedAt)});
  }

  const request=async path=>api(path,{silent:true,botId:''});
  async function refresh(){
    const seq=++state.seq;
    const track=(key,path)=>request(path).then(data=>({ok:true,data}),error=>({ok:false,code:errorCode(error)})).then(result=>{if(seq===state.seq){state[key]=result;render();}});
    await Promise.allSettled([track('bots','/api/bots'),track('overview','/api/quant/pine-bridge/overview'),track('history','/api/quant/research/history?limit='+RUN_ROWS),track('library','/api/quant/library?limit='+RUN_ROWS)]);
    if(seq===state.seq){state.checkedAt=Date.now();render();}
  }
  function clear(){state.seq++;state.checkedAt=null;state.bots=state.overview=state.history=state.library=pending();state.readiness=null;render();}
  // readiness.js announces each rendered report; only its plain string fields are kept.
  document.addEventListener('pf3:report',event=>{
    const detail=event?.detail,text=value=>typeof value==='string'?value.slice(0,200):null;
    state.readiness=detail&&typeof detail==='object'&&text(detail.verdict)?{bot_id:text(detail.bot_id),verdict:text(detail.verdict),
      historical_status:text(detail.historical_status),generated_at:text(detail.generated_at)}:null;
    render();
  });

  function openBridge(){
    // The panel has a fixed id; the summary text is only the fallback because it is translated.
    const panel=document.getElementById('pbPanel')||[...document.querySelectorAll('[data-page="quant"] details')].find(item=>(item.querySelector('summary')?.textContent||'').trim().startsWith('Build Pine Bridge'));
    if(!panel)return;
    panel.open=true;
    // The guided panel handles this event and scrolls to its current step; without it the whole panel scrolls into view.
    const handled=!panel.dispatchEvent(new CustomEvent('pb:reveal',{cancelable:true}));
    if(!handled&&typeof panel.scrollIntoView==='function')panel.scrollIntoView({block:'start'});
  }
  function openLibrary(){
    const panel=document.getElementById('qrlPanel');if(!panel)return;
    panel.open=true;
    // The library panel handles this event and scrolls itself; without a handler the whole panel scrolls into view.
    const handled=!panel.dispatchEvent(new CustomEvent('qrl:reveal',{cancelable:true}));
    if(!handled&&typeof panel.scrollIntoView==='function')panel.scrollIntoView({block:'start'});
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest?.('.jr-open');if(!button)return;
    const step=STEPS.find(item=>String(item.n)===button.dataset.step);if(!step)return;
    document.querySelector('nav button[data-view="'+step.view+'"]')?.click();
    if(step.bridge)openBridge();
    if(step.library)openLibrary();
    if(step.research){const panel=document.getElementById('qrjPanel');if(panel){panel.open=true;const handled=!panel.dispatchEvent(new CustomEvent('qrj:reveal',{cancelable:true}));if(!handled)panel.scrollIntoView?.({block:'start'});}}
  });
  document.querySelector('nav button[data-view="journey"]')?.addEventListener('click',refresh);
  document.getElementById('refresh')?.addEventListener('click',()=>{if(!page.hidden)refresh();});
  document.getElementById('logout')?.addEventListener('click',clear);
  document.getElementById('language')?.addEventListener('change',render);
  // app.js load() replaces me and signals asynchronously. Draw again once it finishes so Refresh never shows stale session data.
  try{
    if(typeof load==='function'){
      const loadSession=load;
      load=async function(...args){const result=await loadSession.apply(this,args);if(!page.hidden)render();return result;};
    }
  }catch{}
  render();
})();
