/* QR-3 fair comparison (S5, contract section 11): the owner view of one frozen comparison. It uses the authenticated api() boundary
   with the three owner actions of the API (create, view, cancel) and the replay request, never with a Bot, an apply, an import or an
   email action. Every value is placed with textContent. The API is behind a default-off flag, so a 404 without a code is shown as an
   unavailable release, not as an error. Rules that hold in this file:
   - the specification block is built before any metric, and no metric is built unless the stored status is COMPLETE;
   - a participant that is not compatible, or whose status hides metrics, shows no metric;
   - a null metric shows an em dash and its reason code, never 0;
   - no rank, best, winner or highlight is ever built (a qualified rank display is out of scope of this release). */
(() => {
  const host=document.querySelector('[data-page="quant"]');if(!host)return;
  const PATH='/api/quant/comparisons',LIBRARY_COMPARE='/api/quant/library/compare',PROBE_ID='availability-check';
  const COMPARISON_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
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
  const known=(table,value)=>typeof value==='string'&&Object.hasOwn(table,value)?label(table[value]):code(value);
  // The route answers 404 without a code only when the flag is off (the router's own fallback); an absent comparison answers the code NOT_FOUND.
  const isUnavailable=error=>error?.status===404&&!error?.code;
  const request=(path,options={})=>api(path,{silent:true,botId:'',...options});

  // Fixed texts. test/qr3-comparison-ui.test.js pins each of them against the module that owns it.
  const OBJECTIVE_ID='qr3-obj-net-return-v1',BENCHMARK_ID='qr3-bh-close-same-cost-v1',UNCERTAINTY_ID='qr3-unc-paired-daily-block-bootstrap-v1';
  const OBJECTIVE_RULES={[OBJECTIVE_ID]:'Net return percent over the evaluation window after costs, higher is better; participants above the drawdown limit are filtered; no composite score and no tie-break.'};
  const BENCHMARKS={[BENCHMARK_ID]:'Buy & Hold at bar close with the same cost model and the same bars'};
  const NOTICE_SIMULATED='Simulated research on historical data. Not actual Paper execution, not a profitability claim and not a recommendation.';
  const NOTICE_DEVELOPMENT='Development results are never qualified recommendations. No qualified winner is a valid result. Viewing this report changes nothing.';
  const NO_WINNER='Qualified recommendations: none. No qualified winner.';
  const EXPOSURE_NOTE='This window is now development data for later selection.';
  const REGISTRY={max_drawdown_percent:'20',min_episodes_floor:'5',min_episodes_ranking:'20',tie_band_pp:'0.50'};
  const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
  const COST_MODEL='paper-close-v1';
  const PERIODS=['1W','1M','3M','6M','1Y','2Y','3Y','YTD','ALL','CUSTOM'];
  const PERIOD_LABELS={ALL:'All available history',CUSTOM:'Custom range'};
  const HIDDEN_STATUSES=['EXCLUDED_INCOMPATIBLE','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','UNAVAILABLE','NOT_EVALUATED'];
  const MODES={STANDARDIZED:'Simulated standardized evaluation',ACTUAL_BOT:'Actual Paper history'};
  const STATUSES={SPEC_FROZEN:'Specification frozen',EVALUATING:'Evaluating',COMPLETE:'Complete',FAILED:'Failed',CANCELLED:'Cancelled'};
  const PARTICIPANT_STATUSES={ELIGIBLE_QUALIFIED:'Qualified',DEVELOPMENT_EVIDENCE:'Development evidence',INADEQUATE_SAMPLE:'Inadequate sample',
    FILTERED_RISK:'Filtered by the risk limit',EXCLUDED_INCOMPATIBLE:'Excluded: incompatible context',EXCLUDED_COVERAGE:'Excluded: incomplete coverage',
    EXCLUDED_INTEGRITY:'Excluded: integrity check failed',NOT_EVALUATED:'Not evaluated',UNAVAILABLE:'Unavailable'};
  const REFUSALS={NOT_FOUND:'Comparison or run not found for this account.',QR3_NOT_CANCELLABLE:'This comparison can no longer be cancelled.',
    QR3_CONFIRMATION_REQUIRED:'Confirm the specification before creating the comparison.',QR3_SCHEMA_ABSENT:'The comparison tables are not installed on this release.',
    QR3_ADMISSION_CLOSED:'Comparison admission is closed on this release.',QR3_ACTUAL_BOT_UNAVAILABLE:'Comparison of Actual Paper history is not available yet.',
    RETRY_TRANSACTION:'The database was busy. Try again.'};
  const REPLAY_REFUSALS={QR3_CONFIRMATION_REQUIRED:'Replay is not available now.',QR3_ADMISSION_CLOSED:'Replay is not available now.'};
  const METRICS=[['net_return_percent','Net return (%)'],['buy_hold','Buy & Hold return (%)'],['excess','Excess over Buy & Hold (percentage points)'],
    ['max_drawdown_percent','Maximum drawdown (%)'],['total_fees','Total fees'],['total_slippage','Total modeled slippage'],['exposure_percent','Time in market (%)'],
    ['completed_episodes','Completed episodes'],['closed_allocations','Closed allocations (information)'],['rejected_intents','Rejected intents']];
  const CONTEXT_FIELDS=['mode','scope','market','data_model','period','dataset','engine','execution','cost_model','capital','risk_policy','ledger_initialization','valuation',
    'benchmark','spec_hash','validation_protocol'];

  const state={availability:'unknown',probeSeq:0,viewSeq:0,view:null,viewId:null,viewError:null,busy:false,confirming:null,message:null,library:null,requestKey:null,created:null};

  // Static markup. Every label comes from the i18n pairs; API data is only ever placed with textContent.
  const panel=make('details','panel qrl qr3');panel.id='qr3Panel';
  const banner=label('Fair comparison is simulated research on historical data. Applying settings or starting a Bot is a separate owner action.','p','qrl-banner qr3-banner');banner.setAttribute('role','note');
  const status=make('p','qrl-status qr3-status');status.setAttribute('role','status');
  const refresh=label('Check again','button','ghost qrl-refresh qr3-refresh');refresh.type='button';refresh.hidden=true;
  const tools=make('div','qr3-tools');
  const lookup=make('form','qr3-lookup');lookup.noValidate=true;
  const idInput=make('input','qr3-id');idInput.type='text';idInput.name='comparison_id';idInput.autocomplete='off';idInput.spellcheck=false;idInput.maxLength=128;
  const viewButton=label('View comparison','button','ghost qr3-view-button');viewButton.type='submit';
  const viewBox=make('section','qrl-view qr3-view');viewBox.hidden=true;

  // The create form shows every value it sends. The registry values are filled in; the uncertainty settings have no default and stay empty.
  const input=(name,value='',type='text')=>{const element=make('input','qr3-input');element.type=type;element.name=name;element.value=value;element.autocomplete='off';element.spellcheck=false;return element;};
  const field=(text,control,className)=>make('label','qr3-field'+(className?' '+className:''),label(text),control);
  const runInputs=[1,2,3,4].map(n=>input('run_id_'+n));
  const periodSelect=make('select','qr3-input');periodSelect.name='period_choice';
  for(const choice of PERIODS){const option=make('option');option.value=choice;if(Object.hasOwn(PERIOD_LABELS,choice)){option.dataset.uiLabel=PERIOD_LABELS[choice];option.textContent=T(PERIOD_LABELS[choice]);}else option.textContent=choice;periodSelect.append(option);}
  const customStart=input('custom_start'),customEnd=input('custom_end');
  const drawdown=input('max_drawdown_percent',REGISTRY.max_drawdown_percent),floor=input('min_episodes_floor',REGISTRY.min_episodes_floor),ranking=input('min_episodes_ranking',REGISTRY.min_episodes_ranking);
  const tie=input('tie_band_pp',REGISTRY.tie_band_pp);
  const methodSelect=make('select','qr3-input');methodSelect.name='uncertainty_method';
  for(const [value,text] of [[UNCERTAINTY_ID,'Paired daily block bootstrap'],['NONE','No uncertainty interval (recorded as a limitation)']]){const option=make('option');option.value=value;option.dataset.uiLabel=text;option.textContent=T(text);methodSelect.append(option);}
  const seed=input('uncertainty_seed'),resamples=input('uncertainty_resamples'),block=input('uncertainty_block_length'),confidence=input('uncertainty_confidence');
  const confirmBox=make('input','qrl-pick qr3-confirm');confirmBox.type='checkbox';confirmBox.name='confirmed';
  const createButton=label('Freeze specification and create','button','primary qr3-create-button');createButton.type='submit';
  const createMessage=make('p','qrl-note qr3-create-message');createMessage.setAttribute('role','status');
  const customBox=make('div','qr3-custom',field('Custom start (UTC, YYYY-MM-DD HH:MM)',customStart),field('Custom end (UTC, YYYY-MM-DD HH:MM)',customEnd));customBox.hidden=true;
  const uncertaintyBox=make('div','qr3-uncertainty',field('Uncertainty seed',seed),field('Resamples',resamples),field('Block length (days)',block),field('Confidence (0 to 1)',confidence));
  const createForm=make('form','qr3-create');createForm.noValidate=true;
  fill(createForm,[label('Run IDs (2 to 4 finished research runs of this account)','p','qrl-note'),make('div','qr3-runs',...runInputs.map((element,at)=>make('label','qr3-field',make('span',null,label('Run ID'),' '+(at+1)),element))),
    field('Period',periodSelect),customBox,
    label('The specification below is frozen at creation. The objective and the benchmark are fixed.','p','qrl-note'),
    make('div','qrl-ev',label('Objective','span','qrl-k'),make('span','qrl-v',code(OBJECTIVE_ID))),
    make('div','qrl-ev',label('Benchmark','span','qrl-k'),make('span','qrl-v',code(BENCHMARK_ID))),
    field('Maximum drawdown limit (%)',drawdown),field('Minimum episodes (floor)',floor),field('Minimum episodes (ranking)',ranking),field('Tie band (percentage points)',tie),
    field('Uncertainty method',methodSelect),uncertaintyBox,
    make('label','qrl-pick-label',confirmBox,label('I confirm the specification cannot change after creation and the window becomes development data for later selection.')),
    make('div','qrl-card-actions',createButton),createMessage]);
  const createSection=make('details','qrl-sec qr3-create-section',make('summary','qrl-sec-title',label('New comparison')),createForm);
  fill(lookup,[field('Comparison ID',idInput),make('div','qrl-card-actions',viewButton)]);
  fill(tools,[lookup,createSection]);
  panel.append(label('Fair comparison','summary','qrl-summary'),banner,status,refresh,tools,viewBox);
  host.append(panel);

  const newKey=()=>{
    try{if(globalThis.crypto?.randomUUID)return 'ui-'+globalThis.crypto.randomUUID();}catch{/* falls through to the time based key */}
    return 'ui-'+Date.now().toString(16)+'-'+Math.floor(Math.random()*0xffffffff).toString(16);
  };
  const refusalLine=error=>{const reason=errorCode(error);return make('p','qrl-error qr3-error',Object.hasOwn(REFUSALS,reason)?label(REFUSALS[reason]):label('The request was refused.'),' (',code(reason),')');};

  /* ---- the answer to the owner ---- */
  const chip=(text,tone)=>label(text,'span','qrl-chip qrl-'+tone);
  // A known value shows its translated label; an unknown one shows its code as it is, never an invented meaning.
  const badge=(table,value,tone)=>typeof value==='string'&&Object.hasOwn(table,value)?chip(table[value],tone):make('span','qrl-chip qrl-muted',code(value));
  const row=(key,...value)=>make('div','qrl-ev',label(key,'span','qrl-k'),make('span','qrl-v',...value));
  const note=text=>make('p','qrl-note',label(text));
  const section=(title,open,className,...children)=>{const element=make('details','qrl-sec '+className,make('summary','qrl-sec-title',label(title,'span')),...children);element.open=open;return element;};
  function table(heads,rows){
    // A string head is a fixed label; a node head carries API text and is never looked up for a translation.
    const head=make('tr',null,...heads.map(text=>typeof text==='string'?label(text,'th'):make('th',null,text))),body=rows.map(cells=>make('tr',null,...cells.map(cell=>make('td',null,cell))));
    return make('div','qrl-scroll',make('table','qrl-table',make('thead',null,head),make('tbody',null,...body)));
  }
  const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':isObject(value)?'{'+Object.keys(value).sort().map(name=>JSON.stringify(name)+':'+stable(value[name])).join(',')+'}':JSON.stringify(value===undefined?null:value);
  const pairs=value=>isObject(value)?Object.entries(value).map(([key,item])=>key+'='+dash(item)).join(', ')||'—':'—';

  function specBlock(body){
    const c=body.comparison,spec=isObject(c.spec)?c.spec:{};
    const unc=isObject(spec.uncertainty)?spec.uncertainty:{};
    const rest=Object.fromEntries(Object.entries(unc).filter(([name])=>name!=='method'));
    const rule=Object.hasOwn(OBJECTIVE_RULES,spec.objective)?make('p','qrl-note qr3-rule',label(OBJECTIVE_RULES[spec.objective])):null;
    return section('Specification',true,'qr3-spec',
      row('Mode',badge(MODES,c.mode,'info')),row('Comparison ID',hash(c.comparison_id)),row('Frozen at (UTC)',utc(c.frozen_at_ms)),row('Specification hash',hash(c.spec_hash)),
      row('Objective',code(spec.objective)),rule,
      row('Risk filter: maximum drawdown limit (%)',dash(spec.risk_filter?.max_drawdown_percent)),
      row('Adequacy: minimum episodes (floor)',dash(spec.adequacy?.min_episodes_floor)),row('Adequacy: minimum episodes (ranking)',dash(spec.adequacy?.min_episodes_ranking)),
      row('Tie band (percentage points)',dash(spec.tie?.band_pp)),
      row('Uncertainty method',code(unc.method)),row('Uncertainty settings',pairs(rest)),
      row('Benchmark',code(spec.benchmark),' ',Object.hasOwn(BENCHMARKS,spec.benchmark)?label(BENCHMARKS[spec.benchmark]):null));
  }
  function periodBlock(body){
    const c=body.comparison,p=isObject(c.spec?.period)?c.spec.period:null;
    const start=p?.start_ms??c.window?.start_ms,end=p?.end_ms??c.window?.end_ms;
    const history=isObject(p?.available_history)?utc(p.available_history.start_ms)+' → '+utc(p.available_history.end_ms):'—';
    return section('Period',true,'qr3-period',
      row('Requested period',known(PERIOD_LABELS,p?.choice)),row('Resolved interval (UTC)',utc(start)+' → '+utc(end)),
      row('Evaluation bars',dash(p?.evaluation_bars)),row('Warm-up bars',dash(p?.warmup_bars)),row('Total bars',dash(p?.total_bars)),row('Bar limit',dash(p?.limit)),
      row('Available history (UTC)',history),row('Admission',code(p?.admission)));
  }
  function contextBlock(body){
    const list=body.participants||[],mismatches=Array.isArray(body.context_mismatches)?body.context_mismatches:[];
    const nodes=[row('QR-3 context key',hash(body.comparison.context_key))];
    if(mismatches.length){
      nodes.push(make('p','qrl-alert qr3-mismatch-alert',label('The participants differ in a fixed context field. They cannot be compared, so no metric is shown.')));
      for(const item of mismatches)nodes.push(make('div','qrl-block qr3-mismatch',make('h4','qrl-sub',code(item.field)),
        ...(item.values||[]).map(value=>row('Run ID',hash(short(value.participant_id)),' ',make('span','qrl-v-text',dash(value.value))))));
    }else{
      const first=list[0]?.context;
      nodes.push(isObject(first)?table(['Context field','Value'],CONTEXT_FIELDS.filter(name=>Object.hasOwn(first,name)).map(name=>[code(name),make('span','qrl-v',dash(first[name]))])):note('The shared context is not available.'));
    }
    return section('Shared context',true,'qr3-context',...nodes);
  }
  function subjectBlock(body){
    const list=body.participants||[];
    const names=[...new Set(list.flatMap(item=>Object.keys(isObject(item.subject)?item.subject:{})))].sort();
    const differing=names.filter(name=>new Set(list.map(item=>stable(item.subject?.[name]))).size>1);
    return section('Differences between the strategies under test',false,'qr3-subject',
      note('These differences are disclosed. They do not decide whether the participants are compatible.'),
      differing.length?table(['Field',...list.map(item=>make('span',null,short(item.participant_id)))],differing.map(name=>[code(name),...list.map(item=>make('span','qrl-v',dash(item.subject?.[name])))])):note('No difference is recorded.'));
  }
  const metricRow=(key,text,entry)=>{
    const shown=isObject(entry)&&entry.value!==null&&entry.value!==undefined&&!entry.reason;
    const element=make('div','qrl-ev qr3-metric',label(text,'span','qrl-k'),make('span','qrl-v',shown?dash(entry.value):make('span','qr3-null','—',' ',code(isObject(entry)&&entry.reason?entry.reason:'METRIC_NOT_RECORDED'))));
    element.dataset.metric=key;if(!shown)element.dataset.null='true';
    return element;
  };
  function participantCard(body,item,result,complete){
    const keys=state.library;
    const libraryKey=keys&&!keys.error&&keys.byRun?.[item.participant_id]?keys.byRun[item.participant_id]:null;
    const compatible=item.compatible!==false;
    const prior=Array.isArray(item.prior_exposed_by)?item.prior_exposed_by:[];
    const statusChip=complete&&result?badge(PARTICIPANT_STATUSES,result.status,'info'):null;
    const metrics=[];
    if(complete&&result){
      const hidden=!compatible||result.metrics_hidden===true||HIDDEN_STATUSES.includes(result.status)||!isObject(result.metrics);
      if(hidden)metrics.push(note('Metrics are not shown for this participant.'),result.reasons?.length?row('Reason codes',make('span','qrl-codes',...result.reasons.map(reason=>code(reason)))):null);
      else{
        const benchmark=isObject(body.results?.benchmark)?body.results.benchmark:null;
        const entries={...result.metrics,buy_hold:benchmark?benchmark.net_return_percent:null,excess:result.excess_over_benchmark};
        metrics.push(row('Reason codes',result.reasons?.length?make('span','qrl-codes',...result.reasons.map(reason=>code(reason))):'—'),...METRICS.map(([key,text])=>metricRow(key,text,entries[key])));
      }
    }
    const article=make('article','qrl-card qr3-participant',
      make('div','qrl-card-head',make('span','qrl-id',String(item.position??'—')),hash(short(item.participant_id)),statusChip,
        compatible?chip('Compatible','ok'):chip('Not compatible','bad'),item.fixture===true?chip('Labelled fixture','warn'):null),
      row('Run ID',hash(item.participant_id)),row('QR-3 context key',hash(item.context_key)),
      row('Library context key (library-compat-v1)',libraryKey?hash(libraryKey):make('span','qr3-null','—',' ',label(keys===null?'Checking…':'Not available'))),
      row('Source hash',hash(item.source_hash)),row('Origin',code(item.origin)),
      row('Prior searches and exposed windows',prior.length?make('span','qr3-prior',...prior.map(entry=>make('span','qr3-prior-item',dash(entry.kind)+' '+short(entry.id)+' '+utc(entry.window?.start_ms)+' → '+utc(entry.window?.end_ms)))):label('None recorded')),
      ...metrics);
    article.dataset.participant=item.participant_id;
    return article;
  }
  function resultsSummary(body){
    const results=body.results;
    const eligible=(results.participants||[]).some(item=>item.status==='ELIGIBLE_QUALIFIED');
    // The uncertainty interval is a difference between participants: it is shown only when every participant is compatible and none has hidden metrics.
    const allVisible=(body.participants||[]).every(item=>item.compatible!==false)&&(results.participants||[]).every(item=>!HIDDEN_STATUSES.includes(item.status)&&item.metrics_hidden!==true);
    const benchmark=isObject(results.benchmark)?results.benchmark:null;
    const outcome=isObject(results.outcome)?results.outcome:{};
    const events=Array.isArray(results.replay_events)?results.replay_events:[];
    const metric=(key,text,entry)=>metricRow(key,text,entry);
    return section('Result',true,'qr3-result',
      eligible?null:make('p','qrl-winner qr3-no-winner',label(NO_WINNER)),
      row('Outcome',code(outcome.outcome)),row('Outcome hash',hash(outcome.outcome_hash)),
      benchmark?metric('benchmark_net_return','Buy & Hold return (%)',benchmark.net_return_percent):null,
      benchmark?metric('benchmark_drawdown','Buy & Hold maximum drawdown (%)',benchmark.max_drawdown_percent):null,
      row('Uncertainty interval',allVisible&&isObject(outcome.uncertainty)?code(JSON.stringify(outcome.uncertainty)):'—'),
      row('Limitations',outcome.limitations?.length?make('span','qrl-codes',...outcome.limitations.map(item=>code(item))):'—'),
      events.length?row('Replay events',make('span','qrl-codes',...events.map(item=>code(dash(item.kind))))):null);
  }
  function timeline(body){
    return section('Status history',false,'qr3-history',table(['Sequence','Status','Reason','Time'],(body.events||[]).map(item=>[dash(item.seq),known(STATUSES,item.status),code(item.reason_code),utc(item.at_ms)])));
  }
  function actions(body){
    const id=body.comparison_id,cancellable=body.status==='SPEC_FROZEN'||body.status==='EVALUATING',complete=body.status==='COMPLETE';
    const nodes=[];
    const ask=(kind,askText,confirmText)=>{
      if(state.confirming===kind){
        const yes=label(confirmText,'button','ghost qr3-confirm-yes');yes.type='button';yes.dataset.action=kind;yes.disabled=state.busy;
        const no=label('Keep','button','ghost qr3-confirm-no');no.type='button';
        nodes.push(make('div','qr3-confirm-row',note(kind==='cancel'?'Cancel this evaluation? The exposure records stay.':'Request a replay of the stored result? The stored outcome does not change.'),yes,no));
      }else{
        const open=label(askText,'button','ghost qr3-ask');open.type='button';open.dataset.ask=kind;open.disabled=state.busy;nodes.push(open);
      }
    };
    if(cancellable)ask('cancel','Cancel evaluation','Confirm cancel');
    if(complete)ask('replay','Request replay','Confirm replay');
    return nodes.length?make('div','qrl-card-actions qr3-actions',...nodes):null;
  }

  function renderView(){
    const body=state.view;
    if(state.viewError){
      const heading=make('h3','qrl-title',label('Comparison'));heading.tabIndex=-1;
      fill(viewBox,[heading,state.viewError]);viewBox.hidden=false;return;
    }
    if(!body){viewBox.replaceChildren();viewBox.hidden=true;return;}
    if(body.derived_status==='STALE'&&!body.comparison){
      const heading=make('h3','qrl-title',label('Comparison'),' ',make('span','qrl-id',short(body.comparison_id)),' ',chip('Stale','warn'));heading.tabIndex=-1;
      fill(viewBox,[heading,make('p','qrl-alert',label('The stored comparison could not be read back. Stored numbers are not shown.'),' ',code(body.stale?.first_differing_code)),
        note(NOTICE_SIMULATED),note(NOTICE_DEVELOPMENT)]);viewBox.hidden=false;return;
    }
    const complete=body.status==='COMPLETE'&&isObject(body.results);
    const results=new Map((complete?body.results.participants||[]:[]).map(item=>[item.participant_id,item]));
    const heading=make('h3','qrl-title',label('Comparison'),' ',make('span','qrl-id',short(body.comparison_id)),' ',badge(MODES,body.comparison.mode,'info'),' ',
      badge(STATUSES,body.status,'info'),body.derived_status==='STALE'?chip('Stale','warn'):null,
      body.comparison.fixture===true?chip('Labelled fixture','warn'):null);
    heading.tabIndex=-1;
    // The specification comes first; nothing below it exists before its block does.
    const nodes=[heading,state.message,specBlock(body),periodBlock(body),contextBlock(body)];
    if(body.derived_status==='STALE')nodes.push(make('p','qrl-alert qr3-stale',label('A later record changed the standing of this report. The stored numbers are shown unchanged.'),' ',code(body.stale?.first_differing_code)));
    if(complete)nodes.push(resultsSummary(body));
    else if(body.status==='SPEC_FROZEN'||body.status==='EVALUATING')nodes.push(note('Results appear only after the evaluation is complete.'));
    else nodes.push(note('No results were stored for this comparison.'));
    nodes.push(make('div','qr3-participants',...(body.participants||[]).map(item=>participantCard(body,item,results.get(item.participant_id)??null,complete))),
      subjectBlock(body),timeline(body),label(EXPOSURE_NOTE,'p','qrl-note qr3-exposure'),label(NOTICE_SIMULATED,'p','qrl-note qr3-notice'),label(NOTICE_DEVELOPMENT,'p','qrl-note qr3-notice'),actions(body));
    fill(viewBox,nodes);viewBox.hidden=false;
  }
  function renderStatus(){
    status.replaceChildren();
    const mode=state.availability;
    if(mode==='checking'||mode==='unknown')status.append(label('Checking…'));
    else if(mode==='unavailable')status.append(label('Fair comparison is not available on this release.'));
    else if(mode==='schema')status.append(label('The comparison tables are not installed on this release.'));
    else if(mode==='error')status.append(label('Not available'),' (',code(state.probeCode),')');
    refresh.hidden=!(mode==='error'||mode==='unavailable'||mode==='schema');
    tools.hidden=mode!=='available';
    createButton.disabled=state.busy;viewButton.disabled=state.busy;
  }
  function redraw(){renderStatus();renderView();}

  async function probe(){
    const seq=++state.probeSeq;state.availability='checking';renderStatus();
    try{await request(PATH+'/'+PROBE_ID);if(seq===state.probeSeq)state.availability='available';}
    catch(error){
      if(seq!==state.probeSeq)return;
      const reason=errorCode(error);
      if(isUnavailable(error))state.availability='unavailable';
      else if(reason==='QR3_SCHEMA_ABSENT')state.availability='schema';
      else if(reason==='NOT_FOUND')state.availability='available';
      else{state.availability='error';state.probeCode=reason;}
    }
    renderStatus();
  }
  async function loadLibraryKeys(body,seq){
    const ids=(body.participants||[]).map(item=>item.participant_id).filter(id=>typeof id==='string');
    if(ids.length<2){state.library={error:'NOT_APPLICABLE'};return;}
    try{
      const data=await request(LIBRARY_COMPARE+'?'+ids.map(id=>'run_id='+encodeURIComponent(id)).join('&'));
      if(seq!==state.viewSeq)return;
      state.library={byRun:Object.fromEntries((data.runs||[]).filter(item=>typeof item.compatibility_key==='string').map(item=>[item.run_id,item.compatibility_key]))};
    }catch(error){if(seq!==state.viewSeq)return;state.library={error:errorCode(error)};}
    renderView();
  }
  async function open(id,message=null){
    if(typeof id!=='string'||!COMPARISON_ID.test(id)){state.view=null;state.viewError=make('p','qrl-error',label('Enter a valid comparison ID.'));renderView();return;}
    const seq=++state.viewSeq;state.busy=true;state.viewId=id;state.confirming=null;state.library=null;state.viewError=null;state.message=message;renderStatus();
    try{
      const body=await request(PATH+'/'+encodeURIComponent(id));
      if(seq!==state.viewSeq)return;
      if(!isObject(body)||body.ok!==true||(!isObject(body.comparison)&&!(body.derived_status==='STALE'&&body.comparison===null))||(body.comparison&&typeof body.status!=='string'))throw Object.assign(new Error('unreadable'),{code:'ANSWER_UNREADABLE'});
      state.view=body;
      if(body.comparison)loadLibraryKeys(body,seq);
    }catch(error){
      if(seq!==state.viewSeq)return;
      state.view=null;
      if(isUnavailable(error)){state.availability='unavailable';state.viewError=null;}
      else state.viewError=refusalLine(error);
    }finally{if(seq===state.viewSeq){state.busy=false;redraw();viewBox.querySelector('.qrl-title')?.focus({preventScroll:true});}}
  }

  /* ---- create ---- */
  const DECIMAL=/^\d+(?:\.\d+)?$/,INTEGER=/^\d+$/,CUSTOM_TIME=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;
  const parseTime=text=>{
    const match=CUSTOM_TIME.exec(text.trim());if(!match)return null;
    const [year,month,day,hour,minute]=match.slice(1).map(Number),ms=Date.UTC(year,month-1,day,hour,minute);
    const date=new Date(ms);
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day&&date.getUTCHours()===hour&&date.getUTCMinutes()===minute?ms:null;
  };
  /** Builds the create body from the form, or returns {error:'text'} naming the first problem. Nothing is sent when there is one. */
  function buildBody(){
    const ids=runInputs.map(element=>element.value.trim()).filter(Boolean);
    if(ids.length<2||ids.length>4)return {error:'Enter 2 to 4 run IDs.'};
    if(new Set(ids).size!==ids.length)return {error:'Each run ID may appear once.'};
    const choice=periodSelect.value,period={choice};
    if(choice==='CUSTOM'){
      const start=parseTime(customStart.value),end=parseTime(customEnd.value);
      if(start===null||end===null)return {error:'Enter the custom times as YYYY-MM-DD HH:MM in UTC.'};
      period.start_ms=start;period.end_ms=end;
    }
    if(!DECIMAL.test(drawdown.value.trim())||!DECIMAL.test(tie.value.trim())||!INTEGER.test(floor.value.trim())||!INTEGER.test(ranking.value.trim()))return {error:'Enter numbers in the specification fields.'};
    let uncertainty={method:null};
    if(methodSelect.value!=='NONE'){
      if(!seed.value.trim()||!INTEGER.test(resamples.value.trim())||!INTEGER.test(block.value.trim())||!DECIMAL.test(confidence.value.trim()))return {error:'Enter every uncertainty setting.'};
      uncertainty={method:methodSelect.value,seed:seed.value.trim(),resamples:Number(resamples.value.trim()),block_length:Number(block.value.trim()),confidence:confidence.value.trim()};
    }
    if(!confirmBox.checked)return {error:'Confirm the specification before creating the comparison.'};
    state.requestKey=state.requestKey||newKey();
    return {body:{confirmed:true,request_key:state.requestKey,mode:'STANDARDIZED',participants:ids.map(run_id=>({run_id})),market:{...MARKET},cost_model_version:COST_MODEL,period,
      objective:OBJECTIVE_ID,risk_filter:{max_drawdown_percent:drawdown.value.trim()},adequacy:{min_episodes_floor:Number(floor.value.trim()),min_episodes_ranking:Number(ranking.value.trim())},
      tie:{band_pp:tie.value.trim()},benchmark:BENCHMARK_ID,uncertainty}};
  }
  async function create(){
    const built=buildBody();
    if(built.error){fill(createMessage,[make('span','qrl-error',label(built.error))]);return;}
    state.busy=true;createMessage.replaceChildren();renderStatus();
    try{
      const answer=await request(PATH,{method:'POST',body:JSON.stringify(built.body)});
      state.requestKey=null;
      if(!isObject(answer)||typeof answer.comparison_id!=='string')throw Object.assign(new Error('unreadable'),{code:'ANSWER_UNREADABLE'});
      idInput.value=answer.comparison_id;state.busy=false;
      fill(createMessage,[label(answer.existing===true?'This request was already created.':'Comparison created. No evaluation has started.')]);
      await open(answer.comparison_id);
    }catch(error){
      state.busy=false;
      if(isUnavailable(error)){state.availability='unavailable';redraw();return;}
      fill(createMessage,[refusalLine(error)]);renderStatus();
    }
  }
  async function act(kind){
    const id=state.viewId;if(!id||state.busy)return;
    const suffix=kind==='cancel'?'/cancel':'/replay';
    state.busy=true;state.confirming=null;renderView();renderStatus();
    let message=null;
    try{
      await request(PATH+'/'+encodeURIComponent(id)+suffix,{method:'POST',body:kind==='replay'?JSON.stringify({confirmed:true}):'{}'});
      message=note(kind==='cancel'?'The evaluation was cancelled.':'Replay requested.');
    }catch(error){
      if(kind==='replay'&&isUnavailable(error))message=make('p','qrl-error qr3-error',label('Replay is not available on this release.'));
      else if(isUnavailable(error)){state.busy=false;state.availability='unavailable';redraw();return;}
      else if(kind==='replay'&&Object.hasOwn(REPLAY_REFUSALS,errorCode(error)))message=make('p','qrl-error qr3-error',label(REPLAY_REFUSALS[errorCode(error)]),' (',code(errorCode(error)),')');
      else message=refusalLine(error);
    }
    state.busy=false;
    await open(id,message);
  }

  /* ---- events ---- */
  lookup.addEventListener('submit',event=>{event.preventDefault();if(!state.busy)open(idInput.value.trim());});
  createForm.addEventListener('submit',event=>{event.preventDefault();if(!state.busy)create();});
  createForm.addEventListener('input',()=>{state.requestKey=null;});
  createForm.addEventListener('change',()=>{state.requestKey=null;});
  periodSelect.addEventListener('change',()=>{customBox.hidden=periodSelect.value!=='CUSTOM';});
  methodSelect.addEventListener('change',()=>{uncertaintyBox.hidden=methodSelect.value==='NONE';});
  refresh.addEventListener('click',()=>{probe();});
  viewBox.addEventListener('click',event=>{
    const target=event.target.closest?.('button');if(!target||!viewBox.contains(target))return;
    if(target.dataset.ask){state.confirming=target.dataset.ask;renderView();viewBox.querySelector('.qr3-confirm-yes')?.focus();}
    else if(target.classList.contains('qr3-confirm-no')){state.confirming=null;renderView();}
    else if(target.classList.contains('qr3-confirm-yes'))act(target.dataset.action);
  });
  panel.addEventListener('toggle',()=>{if(panel.open&&(state.availability==='unknown'||state.availability==='error'))probe();});
  function clear(){
    state.probeSeq++;state.viewSeq++;state.availability='unknown';state.view=null;state.viewId=null;state.viewError=null;state.busy=false;state.confirming=null;state.message=null;state.library=null;state.requestKey=null;
    idInput.value='';createMessage.replaceChildren();for(const element of runInputs)element.value='';confirmBox.checked=false;
    viewBox.replaceChildren();viewBox.hidden=true;renderStatus();
  }
  document.getElementById('refresh')?.addEventListener('click',()=>{if(panel.open&&!host.hidden&&state.viewId&&!state.busy)open(state.viewId);});
  document.getElementById('logout')?.addEventListener('click',clear);
  document.getElementById('language')?.addEventListener('change',redraw);
  renderStatus();
})();
