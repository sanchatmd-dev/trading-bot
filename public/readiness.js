/* PF-3 readiness report (Risk manager): read-only diagnostic. Diagnostic only: saves nothing, starts nothing, is not approval to Run.
   Uses the existing authenticated api() boundary with one GET and renders every value with textContent. */
(() => {
  const panel=document.getElementById('pf3Panel');if(!panel)return;
  const root=panel.querySelector('#pf3Root')||panel.appendChild(Object.assign(document.createElement('div'),{id:'pf3Root'}));
  const page=document.querySelector('[data-page="risk"]');
  const T=text=>typeof translate==='function'?translate(text):text;
  const tpl=(text,values)=>T(text).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  const make=(tag,className,...children)=>{
    const element=document.createElement(tag);if(className)element.className=className;
    for(const child of children)if(child!==null&&child!==undefined&&child!==false)element.append(child);
    return element;
  };
  const label=(text,tag='span',className)=>{const element=make(tag,className);element.dataset.uiLabel=text;element.textContent=T(text);return element;};
  const utc=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,19).replace('T',' ')+' UTC':'—';
  const dash=value=>value===null||value===undefined||value===''?'—':String(value);
  const yesNo=value=>value===true?T('Yes'):value===false?T('No'):'—';
  const code=value=>make('code','pf3-code',dash(value));
  const errorCode=error=>error?.code||(error?.status?'HTTP_'+error.status:'REQUEST_FAILED');
  const row=(key,...value)=>make('div','pf3-ev',label(key,'span','pf3-k'),make('span','pf3-v',...value));
  const note=text=>make('div','pf3-ev pf3-note',label(text));
  const group=(title,...children)=>make('section','pf3-block',label(title,'h3'),make('div','pf3-evidence',...children));

  // Verdict labels and tones. The code itself is always shown next to the label.
  const VERDICTS={
    CONFIGURATION_FAILURE:['Configuration failure','bad','A setting or the current state blocks Bridge entries. Fix the listed items first.'],
    EXECUTION_FAULT_REVIEW_REQUIRED:['Execution fault — review required','bad','Past Paper evidence contains faults or unknown results. Review them before relying on it.'],
    CAPABILITY_UNAVAILABLE:['Capability unavailable','warn','Evidence or a capability needed for a readiness claim is missing, stale or disabled.'],
    INSUFFICIENT_ACTIVITY:['Insufficient activity','warn','The evidence window shows too few closed episodes, or a pause is active.'],
    READY_TO_START_PAPER:['Ready to start Paper collection','ok','Evidence for starting a bounded Paper collection is complete. This is not approval to Run.']};
  const CATEGORIES=[['CONFIGURATION','Configuration'],['FAULT','Execution fault review'],['CAPABILITY','Capability'],['ACTIVITY','Activity']];
  const CLASSES={CONFIGURATION_FAILURE:'Configuration failure',EXPECTED_POLICY_SKIP:'Expected policy skip',LOSS_PROTECTION_PAUSE:'Loss protection pause',
    EXECUTION_FAULT:'Execution fault',UNKNOWN:'Unknown'};
  const STATUSES={NOT_AVAILABLE:'Not available',NO_ETA_PERSISTENT_PAUSE:'No ETA: a persistent pause is active',
    NO_ETA_NO_EPISODES:'No ETA: no closed episodes in the window',NO_RATE:'Too few closed episodes for a rate',ESTIMATED:'Estimate'};
  const TARGETS={FIRST_CLOSED_EPISODE:'First closed episode',ENGINEERING_PARTITION_MINIMUM:'Engineering minimum (5 episodes)',
    PLANNING_TRAIN_TARGET:'Planning target (30 episodes)'};
  const ASSUMPTIONS={SAME_SOURCE_INPUTS_POLICY_CAPITAL:'Same source inputs, policy and capital as the evidence',
    STATIONARY_ACTIVITY_RATE:'Signal activity stays at the rate seen in the window',V1_CLOSE_FILL_MODEL:'V1 close-price fill model',
    NO_NEW_PERSISTENT_PAUSE:'No new persistent pause starts',SHORT_DEVELOPMENT_WINDOW:'The development window is short (about 7 days at most)',
    NATURAL_SIGNALS_ONLY:'Natural signals only: CSV or backfill adds no fills',NOT_A_GUARANTEE:'Not a guarantee'};
  const LIMITS={DIAGNOSTIC_ONLY:'Diagnostic only',PAPER_ONLY:'Paper only; Live is locked',
    POINT_IN_TIME_CURRENT_FACTS:'Current facts are a point-in-time snapshot',COST_BASIS_NOT_MARK_TO_MARKET:'Capital uses position cost, not market prices',
    HISTORICAL_EVIDENCE_IS_DEVELOPMENT_WINDOW_ONLY:'Historical evidence covers the development window only',
    V1_EXECUTION_MODEL_ONLY:'V1 execution model only',COLLECTION_ESTIMATE_IS_NOT_A_GUARANTEE:'The collection estimate is not a guarantee',
    READY_IS_NOT_RUN_APPROVAL:'READY is not approval to Run',ENVELOPE_ACCEPTANCE_BLOCKERS_INFORMATIONAL:'Envelope acceptance blockers are information only'};
  // What each blocker code means for the owner; an unknown code (a newer server) shows its raw code and detail only.
  const BLOCKERS={
    ACCOUNT_SUSPENDED:'The owner or bot account is suspended.',
    LICENSE_INACTIVE:'The license is inactive or expired.',
    POLICY_CONFIGURATION_CONFLICT:'The effective Risk policy has conflicting settings.',
    KILL_SWITCH_ACTIVE:'The kill switch is on, so new entries are paused.',
    SIDE_MODE_BLOCKS_BUY:'Side mode SELL_ONLY blocks every BUY.',
    NEWS_BLOCK_WITHOUT_NEWS_DATA:'Block during news is on, but Bridge intents carry no news data, so every BUY is rejected.',
    SYMBOL_NOT_ALLOWED:'Allowed symbols do not include BTCUSDT.',
    PAPER_CAPITAL_NOT_FUNDED:'Binance Global Paper equity is not funded.',
    BRIDGE_RISK_EXCEEDS_POLICY:'The Bridge risk per trade is above the policy maximum.',
    DEPLOYMENT_SNAPSHOT_STALE:'The READY deployment no longer matches the saved policy, capital or sources. Generate and activate again.',
    HISTORICAL_CONFIGURATION_REJECTIONS:'The evidence window rejected orders because of configuration.',
    HISTORICAL_EXECUTION_FAULTS:'The evidence window has execution faults.',
    HISTORICAL_UNKNOWN_REJECTIONS:'The evidence window has rejections with unknown or unverified causes.',
    EXIT_REJECTED_NON_TARGET:'An EXIT was rejected for a reason other than a missing target.',
    EVIDENCE_INTEGRITY_FAILED:'Stored evidence failed its integrity checks.',
    BRIDGE_DISABLED:'The Pine Bridge is disabled on this release.',
    NO_READY_DEPLOYMENT:'This bot has no READY Bridge deployment.',
    DEPLOYMENT_EVIDENCE_MISSING:'The READY deployment has no valid execution evidence.',
    MULTI_PINE_REQUIRES_APP_3B:'More than one Pine source is connected; this needs the later multi-Pine release.',
    AMBIGUOUS_READY_DEPLOYMENT:'More than one READY deployment exists for this bot.',
    GLOBAL_KILL_ACTIVE:'The administrator global kill is on.',
    ORDER_OUTCOME_UNCERTAIN:'An order outcome is unresolved and needs operator reconciliation.',
    PF2_DISABLED:'Historical Preflight (PF-2) is disabled on this release.',
    NO_SUCCEEDED_PREFLIGHT:'No successful PF-2 job exists for this bot yet.',
    PREFLIGHT_UNAVAILABLE:'PF-2 evidence could not be read.',
    HISTORICAL_ENGINE_CHANGED:'The quant engine changed after the evidence was produced.',
    HISTORICAL_POLICY_STALE:'The saved policy changed after the evidence was produced.',
    HISTORICAL_CAPITAL_STALE:'The configured capital changed after the evidence was produced.',
    HISTORICAL_DEPLOYMENT_NOT_CURRENT:'The evidence belongs to a deployment that is not the READY one.',
    CURRENT_LOSS_STREAK_PAUSE:'The loss-streak pause is active now, so no estimate is possible.',
    HISTORICAL_PERSISTENT_PAUSE:'A persistent pause was active in the evidence window.',
    CLOSED_EPISODES_BELOW_MINIMUM:'The window has fewer than 5 closed episodes.'};
  // A known code shows its translated sentence; an unknown code (a newer server) shows the raw code.
  const known=(table,value)=>Object.hasOwn(table,value)?label(table[value]):code(value);
  const codeList=list=>Array.isArray(list)&&list.length?list.map(item=>String(item)).join(', '):T('None');

  const state={seq:0,loading:false,report:null,error:null,notice:null};
  const scope=()=>typeof selectedBot==='undefined'?'':selectedBot;

  function verdictSection(report){
    const [name,tone,meaning]=VERDICTS[report.verdict]||[null,'muted',null];
    const chip=make('span','pf3-chip pf3-'+tone,name?label(name):code(report.verdict));
    return make('section','pf3-verdict',
      make('div','pf3-head',chip,name?code(report.verdict):null),
      meaning?label(meaning,'p','pf3-meaning'):null,
      label('Diagnostic only. Not approval to Run. Saves nothing.','p','pf3-fixed'),
      make('div','pf3-evidence',row('Report time',utc(Date.parse(report.generated_at))),row('Report bot',make('span','pf3-hash',dash(report.bot_id)))));
  }

  function blockersSection(report){
    const blockers=Array.isArray(report.blockers)?report.blockers:[];
    if(!blockers.length)return group('Blockers',note('No blockers.'));
    const sections=[];
    // A category this page does not know (a newer server) still lists its blockers, under Other: nothing is hidden.
    const groups=[...CATEGORIES,['','Other']].map(([key,title])=>[title,blockers.filter(item=>key===''?!CATEGORIES.some(([known])=>known===item.category):item.category===key)]);
    for(const [title,items] of groups){
      if(!items.length)continue;
      const list=make('ul','pf3-blockers');
      for(const item of items)list.append(make('li','pf3-blocker',code(item.code),
        label(item.source==='HISTORICAL'?'Historical':'Current','span','pf3-tag'),
        Object.hasOwn(BLOCKERS,item.code)?label(BLOCKERS[item.code],'span','pf3-reason'):null,
        item.detail?make('span','pf3-detail',item.detail):null));
      sections.push(make('div','pf3-cat',label(title,'h4'),list));
    }
    return group('Blockers',...sections);
  }

  function currentSection(report){
    const current=report.current||{},policy=current.policy||{},account=current.account||{},exposure=current.exposure||{},
      guards=current.guards||{},deployment=current.deployment;
    const rows=[row('Policy source',dash(policy.source)),row('Policy hash',make('span','pf3-hash',dash(policy.hash))),
      row('Saved policy hash',make('span','pf3-hash',dash(policy.saved_hash))),row('Policy check',code(policy.consistency?.status)),
      row('Bot session',dash(current.session?.state?T(current.session.state):null)),
      row('Cash',dash(account.cash)),row('Cash available',dash(account.cash_available)),row('Reserved by orders',dash(account.reserved_notional)),
      row('Reserved fees',dash(account.reserved_fees)),row('Book equity (cost basis)',dash(account.book_equity)),row('Position cost',dash(account.position_cost)),
      row('Configured equity',dash(account.configured_equity)),row('Configured balance',dash(account.configured_balance)),
      row('Open positions',dash(exposure.open_positions)),row('Pending order',yesNo(exposure.has_pending_order)),
      row('Order outcome uncertain',yesNo(exposure.uncertain)),row('Fee reservation unknown',yesNo(exposure.fee_reservation_unknown)),
      row('Kill switch',yesNo(guards.kill_switch)),row('Global kill',yesNo(guards.global_kill)),
      row('Loss streak',dash(guards.loss_streak)+' / '+dash(guards.loss_streak_limit)),
      row('Trades today',dash(guards.daily_trades)+' / '+dash(guards.max_trades_per_day)),
      row('Realized R today',dash(guards.daily_realized_r)+' / '+dash(guards.max_daily_loss_r)),
      row('Day-scoped pauses',codeList(guards.day_scoped_pauses))];
    if(deployment)rows.push(row('READY deployment',make('span','pf3-hash',dash(deployment.deployment_id))),
      row('Deployment is current',yesNo(deployment.fresh)),...(deployment.stale_code?[row('Stale reason',code(deployment.stale_code))]:[]),
      row('Execution model',dash(deployment.model_version)),row('Bridge risk %',dash(deployment.bridge_risk_percent)));
    else rows.push(note('No READY Bridge deployment.'));
    return group('Current state (PF-1)',...rows);
  }

  function table(headers,rows){
    const head=make('tr','',...headers.map(text=>label(text,'th')));
    const body=rows.map(cells=>make('tr','',...cells.map(cell=>make('td','',cell))));
    return make('div','pf3-table-wrap',make('table','pf3-table',make('thead','',head),make('tbody','',...body)));
  }

  function funnelRows(history){
    const f=history.funnel,w=history.window||{},slash=(...values)=>values.map(dash).join(' / ');
    return [row('Window (UTC)',utc(w.evaluation_start_time)+' → '+utc(w.last_time)),row('Evaluated bars',dash(w.evaluated_bars)+' ('+dash(w.evaluated_days)+' '+T('days')+')'),
      row('Native signals (BUY / exit)',slash(f.native_signals.buy,f.native_signals.native_exit)),
      row('Bridge intents (BUY / SL / TP / native)',slash(f.bridge_intents.buy,f.bridge_intents.exit_sl,f.bridge_intents.exit_tp,f.bridge_intents.exit_native)),
      row('Warm-up intents (BUY / exit)',slash(f.warmup_intents.buy,f.warmup_intents.exit)),
      row('Orders accepted',dash(f.orders.accepted)),
      row('Accepted with size adjustment, includes quantity-step rounding',dash(f.orders.capped)),
      row('Orders rejected (BUY / EXIT)',dash(f.orders.rejected)+' ('+slash(f.orders.buy_rejected,f.orders.exit_rejected)+')'),
      row('Fills (BUY / EXIT)',slash(f.fills.buy,f.fills.exit)),row('Closed allocations',dash(f.closed_allocations)),
      row('Episodes (closed / losing / non-losing)',slash(f.episodes.closed,f.episodes.losing,f.episodes.non_losing))];
  }

  function rejectionRows(history){
    const r=history.rejections,target=r.target_not_open;
    const out=[];
    if(r.items.length)out.push(table(['Reason','Count','Class','Code','Side'],r.items.map(item=>[item.reason,String(item.count),
      Object.hasOwn(CLASSES,item.category)?label(CLASSES[item.category]):code(item.category),code(item.code),dash(item.attribution)])));
    else out.push(note('No rejected orders.'));
    out.push(row('TARGET_NOT_OPEN (total / verified / unverified)',[target.total,target.verified,target.unverified].map(dash).join(' / ')),
      row('Rejected BUY that capping would turn into a fill',dash(r.cappable_buy_rejections)));
    return out;
  }

  function pauseRows(history){
    const p=history.pauses,minutes=p.paused_minutes_by_kind||{};
    return [row('Persistent pause in the window',yesNo(p.persistent)),row('Active guards at the end',codeList(p.active_kinds)),
      row('Paused minutes by guard',Object.entries(minutes).map(([kind,value])=>kind+' '+value).join(' · ')),
      ...(p.partial?[note('Pause periods are partial: the list was truncated.')]:[])];
  }

  function historicalSection(report){
    const h=report.historical||{};
    const rows=[row('Status',code(h.status))];
    if(h.latest_job)rows.push(row('Latest PF-2 job',make('span','pf3-hash',dash(h.latest_job.job_id)),' · '+dash(h.latest_job.status)+' · '+utc(h.latest_job.created_at)));
    if(h.status!=='AVAILABLE'){
      rows.push(row('Unavailable because',code(h.unavailable_code)),note('No historical evidence is used for readiness.'));
      return group('Historical evidence (PF-2)',...rows);
    }
    const e=h.evidence||{},a=h.account_end||{};
    rows.push(row('Evidence job',make('span','pf3-hash',dash(e.job_id))),row('Evidence plan hash',make('span','pf3-hash',dash(e.plan_hash))),
      row('Engine unchanged since evidence',yesNo(e.engine_current)),row('Policy unchanged since evidence',yesNo(e.policy_current)),
      row('Capital unchanged since evidence',yesNo(e.capital_current)),row('Deployment is the READY one',yesNo(e.deployment_current)),
      row('Execution model',dash(e.execution_model_version)),...funnelRows(h),...rejectionRows(h),...pauseRows(h),
      row('End cash',dash(a.cash)),row('End position cost',dash(a.position_cost)),row('Open allocations at the end',dash(a.open_allocations)),
      row('Initial capital (cash / equity)',a.initial?dash(a.initial.cash)+' / '+dash(a.initial.equity):'—'),
      row('Acceptance blockers (information only)',codeList(e.acceptance_blockers)),row('Evidence limitations',codeList(e.limitations)));
    return group('Historical evidence (PF-2)',...rows);
  }

  function projectionSection(report){
    const p=report.activity_projection||{};
    const rows=[row('Estimate status',known(STATUSES,p.status)),row('Basis',label('PF-2 development window')),
      row('Window days',dash(p.window_days)),row('Closed episodes in the window',dash(p.closed_episodes))];
    if(p.low_evidence)rows.push(note('Low evidence: fewer than 5 closed episodes in the window.'));
    if(p.status==='ESTIMATED'){
      rows.push(row('Closed episodes per day',dash(p.rate_per_day)));
      for(const item of p.targets||[])rows.push(row(TARGETS[item.label]||item.label,tpl('about {days} days',{days:dash(item.days)})));
    }
    rows.push(make('div','pf3-ev',label('Assumptions','span','pf3-k'),make('ul','pf3-list',...(p.assumptions||[]).map(item=>make('li','',known(ASSUMPTIONS,item))))));
    return group('Collection estimate',...rows);
  }

  function limitationsSection(report){
    const items=Array.isArray(report.limitations)?report.limitations:[];
    return group('Limitations',make('ul','pf3-list',...items.map(item=>make('li','',known(LIMITS,item)))));
  }

  // One failing section never blanks the others: an unexpected shape shows a coded Not available row.
  const guard=(title,build)=>{
    try{return build();}
    catch{return group(title,make('div','pf3-ev pf3-ev-error',label('Not available'),' (',code('RENDER_ERROR'),')'));}
  };

  function render(){
    if(state.loading&&!state.report){root.replaceChildren(make('p','pf3-note',label('Loading…')));return;}
    if(state.notice){root.replaceChildren(make('p','pf3-note',label(state.notice)));return;}
    if(state.error){root.replaceChildren(make('p','pf3-ev-error',label('Not available'),' (',code(state.error),')'));return;}
    if(!state.report){root.replaceChildren(make('p','pf3-note',label('Open the report to check readiness.')));return;}
    const report=state.report;
    root.replaceChildren(guard('Verdict',()=>verdictSection(report)),guard('Blockers',()=>blockersSection(report)),
      guard('Current state (PF-1)',()=>currentSection(report)),guard('Historical evidence (PF-2)',()=>historicalSection(report)),
      guard('Collection estimate',()=>projectionSection(report)),guard('Limitations',()=>limitationsSection(report)));
  }

  // The journey view reads the verdict from this event; nothing else leaves this module. A null detail says the report is gone
  // (logout, bot switch, All Bots, failed read), so the journey never keeps the verdict of a report this panel no longer shows.
  function announce(report){
    document.dispatchEvent(new CustomEvent('pf3:report',{detail:report===null?null:{bot_id:report.bot_id,verdict:report.verdict,
      historical_status:report.historical?.status??null,generated_at:report.generated_at}}));
  }

  async function refresh(){
    const requested=scope(),seq=++state.seq;
    state.report=null;state.error=null;state.notice=null;
    if(requested==='all'){state.loading=false;state.notice='Select one bot for this operation';render();announce(null);return;}
    state.loading=true;render();
    try{
      const report=await api('/api/risk/readiness-report',{silent:true});
      if(seq!==state.seq||requested!==scope())return;
      state.loading=false;state.report=report;render();announce(report);
    }catch(error){
      if(seq!==state.seq||requested!==scope())return;
      state.loading=false;state.error=errorCode(error);render();announce(null);
    }
  }
  function clear(){state.seq++;state.loading=false;state.report=null;state.error=null;state.notice=null;render();announce(null);}
  const visible=()=>!page||!page.hidden;

  document.getElementById('pf3Refresh')?.addEventListener('click',refresh);
  document.querySelector('nav button[data-view="risk"]')?.addEventListener('click',refresh);
  document.getElementById('refresh')?.addEventListener('click',()=>{if(visible())refresh();});
  document.getElementById('logout')?.addEventListener('click',clear);
  document.getElementById('language')?.addEventListener('change',render);
  // The bot changes in bots.js after this listener runs: drop the old report now, read the new bot on the next turn.
  document.getElementById('botSwitcher')?.addEventListener('change',()=>{clear();if(visible())setTimeout(refresh,0);});
  render();
})();
