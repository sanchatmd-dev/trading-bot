/* Quant Research Library (P1-E): read-only inspection of every preserved research run. Uses the existing authenticated
   api() boundary with GET requests only and renders every value with textContent. It never applies settings, starts a
   Bot, starts research, exports or saves anything. Development scores are in-sample selection, not recommendations. */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const PAGE=20;
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  // Null, undefined and false children are skipped everywhere: append and replaceChildren would print them as text.
  const keep=child=>child!==null&&child!==undefined&&child!==false;
  const make=(tag,className,...children)=>{
    const element=document.createElement(tag);if(className)element.className=className;
    element.append(...children.filter(keep));
    return element;
  };
  const fill=(element,children)=>element.replaceChildren(...children.filter(keep));
  const label=(text,tag='span',className)=>{const element=make(tag,className);element.dataset.uiLabel=text;element.textContent=T(text);return element;};
  const utc=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC':'—';
  const short=id=>typeof id==='string'&&id?id.slice(0,8):'—';
  const dash=value=>value===null||value===undefined||value===''||(typeof value==='number'&&!Number.isFinite(value))?'—':typeof value==='object'?JSON.stringify(value):String(value);
  const errorCode=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');
  const code=text=>make('code','qrl-code',dash(text));
  const hash=value=>make('span','qrl-hash',dash(value));

  // Known codes map to translated labels. A code the page does not know is shown as it is, never with an invented meaning.
  const known=(table,value)=>typeof value==='string'&&Object.hasOwn(table,value)?label(table[value]):code(value);
  const CLASSES={IN_PROGRESS:'In progress',CANCELLED:'Cancelled',TIMED_OUT:'Timed out',INSUFFICIENT_DATA:'Insufficient data',FAILED:'Failed',
    CANDIDATE_PENDING_ACCEPTANCE:'Candidate pending acceptance',INSUFFICIENT_EVIDENCE:'Insufficient evidence',NO_VALID_CANDIDATE:'No valid candidate'};
  const GROUP_TONE={ACTIVE:'muted',COMPLETED:'info',INSUFFICIENT:'warn',FAILED:'bad',CANCELLED:'muted'};
  const FILTERS=[['ALL','All'],['COMPLETED','Completed'],['INSUFFICIENT','Insufficient'],['FAILED','Failed'],['CANCELLED','Cancelled'],['ACTIVE','In progress']];
  const LABELS={NOT_EVALUATED:'Not evaluated',NO_SCREENED_CANDIDATE:'No screened candidate',DEVELOPMENT_ONLY:'Development only',QUALIFIED:'Qualified'};
  const REASONS={NOT_EVALUATED:'Not evaluated',NO_RESULT:'No result',INTEGRITY_CHECK_FAILED:'Integrity check failed',NO_SCREENED_CANDIDATE:'No screened candidate',SCORE_NOT_RECORDED:'Score not recorded'};
  const GATES={COMPLETED_EVALUATION:'Completed evaluation',SCREENED_CANDIDATE:'Screened candidate',ROBUSTNESS:'Robustness',HOLDOUT_RESULT:'Holdout result',
    HOLDOUT_INDEPENDENT:'Holdout independent',BLOCKERS_CLEARED:'Blockers cleared',OWNER_RECOMMENDATION_READY:'Owner recommendation ready',QL4C_VALIDATION:'QL-4C validation'};
  const STATES={PASS:'Pass',FAIL:'Fail',NOT_REACHED:'Not reached'};
  const FIELDS={scope:'Scope',market:'Market',data_model:'Data model',dataset:'Dataset',split:'Split',engine:'Engine',source:'Source',fixed_strategy:'Fixed strategy',
    dimension_set:'Dimension set',cost_model:'Cost model',capital:'Capital',policy:'Policy',validation_protocol:'Validation protocol'};
  const GAPS={NO_EFFECTIVE_INPUT_REVIEW_HASH:'The run does not record a hash of the reviewed effective inputs.',ENGINE_RELEASE_UNKNOWN:'The release that produced the engine hash is not recorded.',
    NO_DATA_COLLECTION_TIMESTAMP:'The dataset records no separate collection cutoff; it is covered by the dataset digest only.',
    NO_PARITY_REPAINT_EVIDENCE:'No TradingView parity or repaint evidence is linked to this run.',NO_IMMUTABLE_FINISH_TIME:'The finish time is the last update time, not an immutable record.',
    RESULT_NOT_DB_FROZEN:'The database does not freeze the stored result; it is cross-checked against the checkpoints at read time.',
    NO_BENCHMARK_OR_COMPARISON_OBJECTIVE:'No buy-and-hold benchmark and no registered comparison objective exist yet.'};
  const MISSING={NO_RESULT:'The run has no stored result.',NO_FOUNDATION_ROW:'No FOUNDATION execution row is bound to this run.',NO_DATASET_BINDING:'The dataset binding was not recorded.'};

  const pending=()=>({pending:true});
  const state={seq:0,viewSeq:0,loaded:false,loading:false,list:pending(),runs:[],next:null,filter:'ALL',selected:[],detail:null,compare:null,busy:false,opener:null,firstNew:null};
  const request=async path=>api(path,{silent:true,botId:''});

  // Static markup. Every label comes from the i18n pairs; API data is only ever placed with textContent.
  const panel=make('details','panel qrl');panel.id='qrlPanel';
  const banner=label('Inspection only. Development scores are not recommendations. Applying settings or starting a Bot is a separate owner action.','p','qrl-banner');banner.setAttribute('role','note');
  const scopeNote=label('Runs from every Bot of this account. Inspect a run to see its Bot.','p','qrl-scope');
  const winner=label('Qualified recommendations: none. No qualified winner.','p','qrl-winner');winner.setAttribute('role','status');
  const chips=make('div','qrl-chips');chips.setAttribute('role','group');
  const refresh=label('Refresh library','button','ghost qrl-refresh');refresh.type='button';
  const status=make('p','qrl-status');status.setAttribute('role','status');
  const integrityNote=label('Integrity is checked when a run is opened.','p','qrl-note qrl-integrity-note');integrityNote.hidden=true;
  const listBox=make('div','qrl-list');
  const more=label('Load more','button','ghost qrl-more');more.type='button';more.hidden=true;
  const compareButton=label('Compare selected','button','ghost qrl-compare');compareButton.type='button';compareButton.disabled=true;
  const selectedNote=make('span','qrl-selected');
  const compareView=make('section','qrl-view qrl-compare-view');compareView.hidden=true;
  const detailView=make('section','qrl-view qrl-detail-view');detailView.hidden=true;
  // The views sit directly above the list, so Inspect and Compare show their answer at the top of the panel, not below every card.
  panel.append(label('Research Library','summary','qrl-summary'),banner,scopeNote,winner,make('div','qrl-toolbar',chips,refresh),status,integrityNote,compareView,detailView,
    listBox,more,make('div','qrl-compare-bar',compareButton,selectedNote));
  host.append(panel);

  const chip=(text,tone,raw)=>{const element=raw?make('span','qrl-chip qrl-'+tone,text):label(text,'span','qrl-chip qrl-'+tone);return element;};
  const row=(key,...value)=>make('div','qrl-ev',label(key,'span','qrl-k'),make('span','qrl-v',...value));
  const note=text=>make('p','qrl-note',label(text));
  const failed=value=>make('p','qrl-error',label('Not available'),' (',code(value),')');
  const classChip=run=>make('span','qrl-chip qrl-'+(GROUP_TONE[run.library_group]||'muted'),known(CLASSES,run.library_class));
  const scoreOf=score=>score&&typeof score==='object'&&score.value!==null&&score.value!==undefined?make('span','qrl-score',dash(score.value)):
    make('span','qrl-score qrl-none','— ',score&&score.reason?make('span','qrl-reason',known(REASONS,score.reason)):'');
  const qualOf=quality=>make('span','qrl-qual',chip('Not qualified','warn'),' ',known(LABELS,quality?.label));
  const contextKey=id=>state.runs.find(run=>run.run_id===id)?.compatibility_key;
  // What a result was measured on, shown before any score: market and timeframe, data window, and the cost model.
  const grouped=new Intl.NumberFormat('en-US');
  const minute=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,16).replace('T',' '):'—';
  const timeframe=value=>typeof value==='string'&&/^\d+$/.test(value)?(Number(value)%1440===0?Number(value)/1440+'D':Number(value)%60===0?Number(value)/60+'h':value+'m'):dash(value);
  function provenanceLine(run){
    const market=run?.market,data=run?.dataset,cost=run?.cost,parts=[];
    if(market)parts.push(make('span','qrl-pv',[dash(market.broker),dash(market.symbol),timeframe(market.timeframe)].join(' · ')));
    if(data)parts.push(make('span','qrl-pv',minute(data.start_time)+' → '+minute(data.end_time)+' UTC · '+tpl('{n} bars',{n:Number.isFinite(data.bar_count)?grouped.format(data.bar_count):'—'})));
    if(cost)parts.push(make('span','qrl-pv',tpl('Fee {fee} bps · Slippage {slip} bps',{fee:dash(cost.fee_bps),slip:dash(cost.slippage_bps)})));
    return parts.length?make('div','qrl-prov',...parts):null;
  }
  // The library lists runs of every Bot of the account; a run names its Bot by label when the Bot list knows it.
  const botName=id=>{try{const bot=typeof botProfiles!=='undefined'&&Array.isArray(botProfiles)?botProfiles.find(item=>item.id===id):null;return bot?.label||dash(id);}catch{return dash(id);}};
  const currentBot=()=>{try{return (typeof selectedBot==='string'&&selectedBot)||(typeof me!=='undefined'&&me?.user?.id)||'';}catch{return '';}};
  const botLine=id=>make('p','qrl-botline',label('Bot of this run'),': ',make('span','qrl-v',botName(id)),' ',id&&id===currentBot()?chip('Selected bot','info'):chip('Another Bot of this account','muted'));

  function card(run){
    const pick=make('input','qrl-pick');pick.type='checkbox';pick.dataset.run=run.run_id;pick.checked=state.selected.includes(run.run_id);
    pick.disabled=!pick.checked&&state.selected.length>=4;
    const first=state.selected.length&&!state.selected.includes(run.run_id)?contextKey(state.selected[0]):null;
    const inspect=label('Inspect','button','ghost qrl-inspect');inspect.type='button';inspect.dataset.run=run.run_id;
    const article=make('article','qrl-card',
      make('div','qrl-card-head',classChip(run),make('code','qrl-status-raw',dash(run.status)),make('span','qrl-time',utc(run.created_at)),make('span','qrl-id',short(run.run_id))),
      provenanceLine(run),
      row('Candidates',dash(run.candidates?.evaluated)+' / '+dash(run.candidates?.planned)),
      row('Development score',scoreOf(run.development_score)),
      row('Qualification',qualOf(run.qualification)),
      make('p','qrl-note',label('Development score: in-sample selection, not a recommendation')),
      row('Context key',hash(run.compatibility_key)),
      make('div','qrl-card-actions',inspect,make('label','qrl-pick-label',pick,label('Compare','span'),
        first&&first!==run.compatibility_key?make('span','qrl-ctx',label('Different context')):null)));
    article.dataset.run=run.run_id;
    return article;
  }
  const controlKey=element=>{
    if(!element||!element.classList||!panel.contains(element))return null;
    if(element.classList.contains('qrl-pick'))return {kind:'pick',run:element.dataset.run};
    if(element.classList.contains('qrl-inspect'))return {kind:'inspect',run:element.dataset.run};
    if(element.classList.contains('qrl-filter'))return {kind:'filter',group:element.dataset.group};
    return null;
  };
  const findControl=key=>{
    if(!key)return null;
    if(key.kind==='compare')return compareButton;
    if(key.kind==='filter')return [...chips.querySelectorAll('.qrl-filter')].find(item=>item.dataset.group===key.group)||null;
    return [...listBox.querySelectorAll(key.kind==='pick'?'.qrl-pick':'.qrl-inspect')].find(item=>item.dataset.run===key.run)||null;
  };
  const focusControl=(key,options)=>{const target=findControl(key);if(!target||target.disabled||target.hidden)return false;target.focus(options);return true;};
  function renderChips(){
    chips.setAttribute('aria-label',T('Filter by group'));
    const totals=state.list.ok?state.list.data.totals||{}:{};
    chips.replaceChildren(...FILTERS.map(([group,text])=>{
      const button=make('button','ghost qrl-filter',label(text),make('span','qrl-count',' '+dash(group==='ALL'?totals.all:totals[group])));
      button.type='button';button.dataset.group=group;button.setAttribute('aria-pressed',String(state.filter===group));
      return button;
    }));
  }
  function renderList(){
    const key=controlKey(document.activeElement),wasMore=document.activeElement===more;
    renderChips();
    const list=state.list;
    status.replaceChildren();
    if(list.pending)status.append(label('Checking…'));
    else if(!list.ok)status.append(failed(list.code));
    else if(list.data.schema_present===false)status.append(label('The research tables are not installed on this release.'));
    else if(!state.runs.length)status.append(label('No research runs in the library yet.'));
    else status.append(tpl('{n} runs in library',{n:dash(list.data.totals?.all)}));
    integrityNote.hidden=!(list.ok&&state.runs.length>0);
    const shown=state.filter==='ALL'?state.runs:state.runs.filter(run=>run.library_group===state.filter);
    listBox.replaceChildren(...shown.map(card));
    if(!shown.length&&state.filter!=='ALL'){
      const total=list.ok?list.data.totals?.[state.filter]:null;
      if(Number.isSafeInteger(total)&&total>0)listBox.append(make('p','qrl-note qrl-unloaded',tpl('{n} runs in this group are not loaded yet. Use Load more.',{n:total})));
      else if(state.runs.length)listBox.append(note('No runs in this group.'));
    }
    more.hidden=!state.next;
    compareButton.disabled=state.selected.length<2||state.busy;
    fill(selectedNote,[state.selected.length?tpl('{n} selected',{n:state.selected.length}):null]);
    // Load more disappears with the last page: the focus moves to the first run it added instead of falling to the page.
    if(wasMore&&more.hidden){if(!focusControl({kind:'inspect',run:state.firstNew})&&!focusControl({kind:'inspect',run:state.runs.at(-1)?.run_id}))refresh.focus();}
    else if(key)focusControl(key,{preventScroll:true});
  }

  const pairs=value=>value&&typeof value==='object'?Object.entries(value).map(([key,item])=>key+'='+dash(item)).join(', ')||'—':'—';
  const range=(min,max)=>Number.isFinite(min)&&Number.isFinite(max)?min+'–'+max:'—';
  const yes=value=>value===true?T('Yes'):value===false?T('No'):'—';
  const codes=list=>Array.isArray(list)&&list.length?make('span','qrl-codes',...list.map(item=>code(item))):'—';
  const section=(title,open,...children)=>{const element=make('details','qrl-sec',make('summary','qrl-sec-title',label(title,'span')),...children);element.open=open;return element;};
  const withBadge=(element,selector,badge)=>{if(badge)element.querySelector(selector)?.append(badge);return element;};
  const block=(title,...rows)=>make('div','qrl-block',make('div','qrl-subhead',label(title,'h4','qrl-sub')),...rows);
  function table(heads,rows){
    const head=make('tr',null,...heads.map(text=>label(text,'th'))),body=rows.map(cells=>make('tr',null,...cells.map(cell=>make('td',null,cell))));
    return make('div','qrl-scroll',make('table','qrl-table',make('thead',null,head),make('tbody',null,...body)));
  }
  const metricCells=item=>[dash(item?.net_return_percent),dash(item?.closed_trades),dash(item?.max_drawdown_percent)];

  function outcome(body){
    const {run,evaluation:e,qualification:q}=body,sel=e.selected;
    const badge=e.stored_values_verified===false?chip('Unverified stored values','warn'):null;
    const reasons=e.reason_counts?Object.entries(e.reason_counts).map(([key,count])=>key+' ×'+count).join(', ')||'—':'—';
    return section('Outcome',true,row('Run ID',hash(run.run_id)),row('Status',code(run.status)),row('Group',classChip(run)),row('Created (UTC)',utc(run.created_at)),
      row('Finished (UTC)',utc(run.finished_at)),row('Completion reason',code(run.completion_reason)),row('Diagnostic',code(run.diagnostic)),
      row('Candidates',tpl('{evaluated} evaluated, {passed} passed screening',{evaluated:dash(e.candidate_count??body.completeness.candidates_recorded),passed:dash(e.screen_passed)})),
      row('Screening reasons',reasons),row('Holdout evaluated',yes(e.holdout_evaluated)),row('Development score',scoreOf(e.development_score)),
      make('p','qrl-note',label('Development score: in-sample selection, not a recommendation')),
      note('Basis: validation net return of the engine-selected candidate that passed train and validation screening.'),
      row('Qualification',qualOf(q)),
      withBadge(block('Selected candidate',sel?row('Selected parameters',pairs(sel.parameters)):row('Selected parameters',label('No screened candidate')),
        sel?row('Selected validation',tpl('{ret} % return, {trades} trades, {dd} % drawdown',{ret:dash(sel.validation?.net_return_percent),trades:dash(sel.validation?.closed_trades),dd:dash(sel.validation?.max_drawdown_percent)})):null),'.qrl-subhead',badge));
  }
  function provenance(body){
    const p=body.provenance,d=p.dataset,i=p.input,c=p.cost_policy,v=p.validation,f=p.foundation;
    const binding=make('div','qrl-scroll',make('table','qrl-table',make('tbody',null,...(i.bindings||[]).map(item=>make('tr',null,make('td',null,dash(item.slot)),
      make('td',null,dash(item.pine_variable)),make('td',null,dash(item.effective_value)),make('td',null,range(item.search_domain?.min,item.search_domain?.max)+' / '+dash(item.search_domain?.step)))))));
    return section('Provenance',false,
      block('Source',row('Source hash',hash(p.source.source_hash)),row('Snapshot hash',hash(p.source.baseline_snapshot_hash)),row('Scope',code(p.source.scope)),row('Source version',dash(p.source.source_version))),
      block('Inputs',row('Input lock hash',hash(i.lock_hash)),row('Signals',pairs(i.signals)),row('Bridge values',pairs(i.bridge)),i.bindings?.length?binding:null,
        row('Fixed inputs',dash(i.fixed_inputs_count)),row('Search plan',pairs(i.search)),
        row('Search domains',(i.domains||[]).map(item=>dash(item.dimension)+' '+range(item.min,item.max)+' ('+dash(item.count)+')').join('; ')||'—')),
      block('Dataset',row('Market',pairs(d.market)),row('Start (UTC)',utc(d.start_time)),row('End (UTC)',utc(d.end_time)),row('Warm-up bars',dash(d.warmup_bars)),row('Bars',dash(d.bar_count)),
        row('Digest kind',code(d.digest_kind)),row('Dataset hash',hash(d.digest)),row('Data cutoff (UTC)',utc(d.collection_cutoff)),row('Dataset binding hash',hash(d.binding_sha256))),
      block('Engine',row('Engine hash',hash(p.engine.engine_hash)),row('Engine family',code(p.engine.engine_family)),row('Contract version',code(p.engine.contract_version))),
      block('Cost and policy',row('Cost model',pairs(c.model)),row('Cost stress',label('Engine-defined: twice the fee and slippage')),row('Policy hash',hash(c.policy_hash)),
        row('Capital',pairs(c.capital)),row('Ledger initialization',dash(c.ledger_initialization))),
      block('Validation rules',row('Split (bars)',pairs(v.split)),row('Rules',pairs(v.rules)),row('Maximum evaluations',dash(v.max_evaluations)),
        row('Holdout window (UTC)',v.holdout_window?utc(v.holdout_window.start_time)+' → '+utc(v.holdout_window.end_time):'—')),
      f?block('FOUNDATION execution',row('Job ID',hash(f.job_id)),row('Job status',code(f.status)),row('Attempts',dash(f.attempts)),row('Runtime (ms)',dash(f.runtime_used_ms)),
        row('Stop reason',code(f.stop_reason)),row('Budget',pairs(f.budget)),row('Chunk rows',dash(f.chunk_rows))):null);
  }

  function integrity(body){
    const i=body.integrity,verified=i.contract_hash_verified===true;
    return section('Integrity',!(body.integrity.warnings||[]).length?false:true,
      row('Contract hash',hash(i.contract_hash),' ',chip(verified?'Verified':'Mismatch',verified?'ok':'bad')),row('Result digest',hash(i.result_sha256)),
      row('Checkpoints',dash(i.steps_count)),row('Checkpoint digest',hash(i.steps_digest)),row('Report matches checkpoints',yes(i.report_matches_checkpoints)),
      row('Problems',codes(i.checkpoint_problems)),row('Identity protection',code(i.identity_protection)),row('Result protection',code(i.result_protection)),row('Warnings',codes(i.warnings)));
  }
  function gaps(body){
    const l=body.limitations,m=body.completeness.missing||[];
    const sentence=(table,item)=>make('li','qrl-gap',code(item),' ',Object.hasOwn(table,item)?label(table[item]):'');
    return section('Gaps',true,note('These gaps are shown as they are. An absent value is never read as zero.'),
      make('ul','qrl-gaps',...(l.provenance_gaps||[]).map(item=>sentence(GAPS,item)),...m.map(item=>sentence(MISSING,item))),
      block('Acceptance blockers',row('Blockers',codes(l.acceptance_blockers))));
  }
  function candidates(body){
    const e=body.evaluation,rows=(e.candidates||[]).map(item=>[dash(item.index),pairs(item.parameters),...metricCells(item.train),...metricCells(item.validation),codes(item.screen_reasons)]);
    const badge=e.stored_values_verified===false?chip('Unverified stored values','warn'):null;
    return withBadge(section('All candidates',false,rows.length?table(['#','Parameters','Train return %','Train trades','Train drawdown %','Validation return %','Validation trades','Validation drawdown %','Screening reasons'],rows):note('No candidates are recorded.'),
      e.candidates_truncated?note('Only the first 100 candidates are shown.'):null),'.qrl-sec-title',badge);
  }
  function gates(body){
    const q=body.qualification,o=q.holdout_overlap||{};
    const rows=(q.gates||[]).map(gate=>[gate.gate,known(GATES,gate.name),make('span','qrl-chip qrl-'+(gate.state==='PASS'?'ok':gate.state==='FAIL'?'bad':'muted'),known(STATES,gate.state)),code(gate.code)]);
    return section('Qualification gates',true,make('p','qrl-winner',label('Qualified recommendations: none. No qualified winner.')),row('Qualification',qualOf(q)),
      table(['Gate','Name','State','Reason'],rows),o.checked?row('Earlier runs with an overlapping holdout',(o.run_ids||[]).map(short).join(', ')||'—'):null);
  }
  function renderDetail(body){
    const run=body.run,warn=(body.integrity.warnings||[]).length;
    const back=label('Back to list','button','ghost qrl-back');back.type='button';
    const heading=make('h3','qrl-title',label('Research run'),' ',make('span','qrl-id',short(run.run_id)),' ',classChip(run),' ',make('code','qrl-status-raw',dash(run.status)));
    heading.tabIndex=-1;
    fill(detailView,[back,heading,botLine(run.bot_id),
      warn?make('p','qrl-alert',label('Integrity check failed. The stored values do not match the preserved record; the development score is withheld.')):null,
      outcome(body),provenance(body),integrity(body),gaps(body),candidates(body),gates(body)]);
    if(warn)detailView.querySelector('.qrl-alert').setAttribute('role','alert');
    detailView.hidden=false;compareView.hidden=true;
  }
  function renderCompare(body){
    const back=label('Back to list','button','ghost qrl-back');back.type='button';
    const runs=body.runs||[],ok=body.verdict==='COMPATIBLE';
    const head=make('h3','qrl-title',label(ok?'Comparison':'Not comparable'));head.tabIndex=-1;
    const nodes=[back,head,make('p','qrl-winner',label('Qualified recommendations: none. No qualified winner.'))];
    if(!ok){
      nodes.push(note('These runs differ in a fixed context field, so no metrics are compared.'));
      for(const item of body.mismatches||[])nodes.push(make('div','qrl-block',make('h4','qrl-sub',known(FIELDS,item.field)),
        ...(item.values||[]).map(value=>row('Run ID',hash(short(value.run_id)),' ',make('span','qrl-v-text',dash(value.value))))));
      nodes.push(table(['Run ID','Group','Status','Qualification'],runs.map(run=>[short(run.run_id),known(CLASSES,run.library_class),dash(run.status),qualOf(run.qualification)])));
    }else{
      const cols=runs.map(run=>short(run.run_id)),cell=(run,get)=>{const value=get(run);return value===null||value===undefined?'—':value;};
      const selected=run=>run.metrics?.selected;
      const lines=[['Group',run=>known(CLASSES,run.library_class)],['Status',run=>dash(run.status)],['Created (UTC)',run=>utc(run.created_at)],
        ['Candidates evaluated',run=>dash(run.metrics?.candidates?.evaluated)],['Candidates passed screening',run=>dash(run.metrics?.candidates?.screen_passed)],
        ['Development score',run=>scoreOf(run.metrics?.development_score||{value:null,reason:run.metrics_reason})],
        ['Validation return %',run=>dash(selected(run)?.validation?.net_return_percent)],['Validation trades',run=>dash(selected(run)?.validation?.closed_trades)],
        ['Validation drawdown %',run=>dash(selected(run)?.validation?.max_drawdown_percent)],['Train return %',run=>dash(selected(run)?.train?.net_return_percent)],
        ['Qualification',run=>qualOf(run.qualification)],['Seed',run=>dash(run.disclosed?.search?.seed)],['Requested budget',run=>dash(run.disclosed?.search?.requested_budget)],
        ['Search algorithm',run=>dash(run.disclosed?.search?.algorithm)]];
      const table2=make('div','qrl-scroll',make('table','qrl-table',make('thead',null,make('tr',null,label('Metric','th'),...cols.map(text=>make('th',null,text)))),
        make('tbody',null,...lines.map(([name,get])=>make('tr',null,label(name,'th'),...runs.map(run=>make('td',null,cell(run,get))))))));
      nodes.push(note('Runs share one context and are listed by creation time. Development scores are in-sample selection; no run is ranked.'),
        make('div','qrl-block qrl-shared',make('h4','qrl-sub',label('Shared context')),provenanceLine(runs[0])),table2);
    }
    fill(compareView,nodes);compareView.hidden=false;detailView.hidden=true;
  }

  async function load(append=false){
    const seq=++state.seq;state.loading=true;
    if(!append){state.list=pending();state.runs=[];state.next=null;}
    renderList();
    try{
      const data=await request('/api/quant/library?limit='+PAGE+(append&&state.next?'&before='+encodeURIComponent(state.next):''));
      if(seq!==state.seq)return;
      state.list={ok:true,data};state.runs=append?state.runs.concat(data.runs||[]):(data.runs||[]);
      state.next=typeof data.next_before==='string'?data.next_before:null;state.loaded=true;
      state.firstNew=append&&Array.isArray(data.runs)&&data.runs.length?data.runs[0].run_id:null;
    }catch(error){if(seq!==state.seq)return;state.list={ok:false,code:errorCode(error)};}
    state.loading=false;renderList();
  }
  // A view opens above the list: it scrolls to the top of the panel and its heading takes the focus. Back returns the focus to the
  // control that opened it (found again by run id and kind, because the list is rebuilt), or to the panel summary.
  function reveal(view){
    if(typeof view.scrollIntoView==='function')view.scrollIntoView({block:'start'});
    view.querySelector('.qrl-title')?.focus({preventScroll:true});
  }
  function failView(view,title,value){
    const back=label('Back to list','button','ghost qrl-back');back.type='button';
    const heading=make('h3','qrl-title',label(title));heading.tabIndex=-1;
    fill(view,[back,heading,failed(value)]);view.hidden=false;(view===detailView?compareView:detailView).hidden=true;
  }
  function closeViews(){
    detailView.hidden=compareView.hidden=true;
    if(!focusControl(state.opener))panel.querySelector('.qrl-summary')?.focus();
    state.opener=null;
  }
  async function show(path,render,view,opener){
    const seq=++state.viewSeq,target=view==='detail'?detailView:compareView;
    state.busy=true;state.opener=opener;renderList();
    try{
      const data=await request(path);
      if(seq!==state.viewSeq)return;
      state[view]=data;render(data);reveal(target);
    }catch(error){
      if(seq!==state.viewSeq)return;
      failView(target,view==='detail'?'Research run':'Comparison',errorCode(error));reveal(target);
    }finally{if(seq===state.viewSeq){state.busy=false;renderList();}}
  }
  const inspect=id=>show('/api/quant/library/runs/'+encodeURIComponent(id),renderDetail,'detail',{kind:'inspect',run:id});
  const compare=()=>show('/api/quant/library/compare?'+state.selected.map(id=>'run_id='+encodeURIComponent(id)).join('&'),renderCompare,'compare',{kind:'compare'});
  function clear(){
    state.seq++;state.viewSeq++;state.loaded=false;state.loading=false;state.list=pending();state.runs=[];state.next=null;state.filter='ALL';state.selected=[];state.detail=null;state.compare=null;state.busy=false;state.opener=null;state.firstNew=null;
    detailView.replaceChildren();compareView.replaceChildren();detailView.hidden=compareView.hidden=true;renderList();
  }
  function redraw(){renderList();if(state.detail&&!detailView.hidden)renderDetail(state.detail);if(state.compare&&!compareView.hidden)renderCompare(state.compare);}

  panel.addEventListener('click',event=>{
    const target=event.target.closest?.('button');if(!target||!panel.contains(target))return;
    if(target.classList.contains('qrl-inspect'))inspect(target.dataset.run);
    else if(target.classList.contains('qrl-back'))closeViews();
    else if(target.classList.contains('qrl-filter')){state.filter=target.dataset.group;renderList();}
    else if(target===more)load(true);
    else if(target===refresh)load();
    else if(target===compareButton&&state.selected.length>=2)compare();
  });
  panel.addEventListener('change',event=>{
    const pick=event.target;if(!pick.classList?.contains('qrl-pick'))return;
    const id=pick.dataset.run;
    state.selected=pick.checked?(state.selected.includes(id)||state.selected.length>=4?state.selected:[...state.selected,id]):state.selected.filter(item=>item!==id);
    renderList();
  });
  panel.addEventListener('toggle',()=>{if(panel.open&&!state.loaded&&!state.loading)load();});
  // The journey page asks the panel to show itself; a handled request leaves the scrolling to the panel.
  panel.addEventListener('qrl:reveal',event=>{
    event.preventDefault();panel.open=true;
    if(!state.loaded&&!state.loading)load();
    if(typeof panel.scrollIntoView==='function')panel.scrollIntoView({block:'start'});
  });
  document.getElementById('refresh')?.addEventListener('click',()=>{if(panel.open&&!host.hidden)load();});
  document.getElementById('logout')?.addEventListener('click',clear);
  document.getElementById('language')?.addEventListener('change',redraw);
  renderList();
})();
