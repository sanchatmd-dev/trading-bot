/* PF-3 readiness report (Risk manager): read-only diagnostic. Diagnostic only: saves nothing, starts nothing, is not approval to Run.
   Uses the existing authenticated api() boundary with one GET and renders every value with textContent.
   The PF-4 Risk proposal form at the end of this file is a separate part with its own marker and its own two POST calls. */
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

  /* PF-4 risk proposals (Risk manager): deterministic proposals with a preview and an explicit, confirmed save.
     Two POST calls only: /api/risk/proposals/preview (saves nothing) and /api/risk/proposals/apply (only from the Save button,
     only with the confirmation box ticked, only for a proposal that is not stale). Every value is rendered with textContent. */
  const pf4Form=document.getElementById('pf4Form'),pf4Root=document.getElementById('pf4Root');
  const pf4Confirm=document.getElementById('pf4Confirm'),pf4Save=document.getElementById('pf4Save');
  const p4={seq:0,busy:false,preview:null,declared:null,stale:false,error:null,notice:null,done:null,asked:false};
  const riskDirty=()=>window._riskDirty===true;

  const P4_FIELDS={maxRiskPercent:'Max risk per trade (%)',maxOrderNotional:'Max order notional',maxDailyNotional:'Max daily notional',
    onePositionPerSymbol:'Block repeated entries',capPercentEquitySize:'Cap Percent Equity size'};
  const P4_RULES={LOSS_CEILING:'Risk ceiling',ORDER_NOTIONAL:'Order notional ceiling',DAILY_NOTIONAL:'Daily notional ceiling',
    REPEATED_ENTRIES:'Repeated entries',CAP_SIZING:'Capping',DEFAULTS_WITHIN_CEILINGS:'Default inside ceiling'};
  const P4_DIRECTIONS={LOWER:'Lower',RAISE:'Raise',ENABLE:'Turn on'};
  const P4_SOURCES={SAVED_POLICY:'Saved policy',OWNER_DECLARED:'You declared',PF2_EVIDENCE:'PF-2 evidence',DEPLOYMENT_EVIDENCE:'Bridge deployment'};
  const P4_EXPLAIN={
    'LOSS_CEILING:LOWER':'You declared {declared}% loss per trade. Max risk per trade falls from {before}% to {after}%.',
    'LOSS_CEILING:RAISE':'You declared {declared}% loss per trade. Max risk per trade rises from {before}% to {after}%, the most you accept.',
    'ORDER_NOTIONAL:LOWER':'You declared an order notional ceiling of {declared}. Max order notional falls from {before} to {after}.',
    'ORDER_NOTIONAL:RAISE':'You declared an order notional ceiling of {declared}. Max order notional rises from {before} to {after}, the most you accept.',
    'DAILY_NOTIONAL:LOWER':'You declared a daily notional ceiling of {declared}. Max daily notional falls from {before} to {after}.',
    'DAILY_NOTIONAL:RAISE':'You declared a daily notional ceiling of {declared}. Max daily notional rises from {before} to {after}, the most you accept.',
    'REPEATED_ENTRIES:ENABLE':'You do not allow repeated entries. Entries for a symbol that already has a position or a pending order become blocked.',
    'CAP_SIZING:ENABLE':'Capping keeps an order inside every limit instead of rejecting it; risk per trade can only fall and no cash is added.',
    'DEFAULTS_WITHIN_CEILINGS:LOWER':'Default {key} {before} exceeds the new ceiling {after}; it is lowered to {after}.'};
  const P4_ADVISORIES={
    LOSS_GUARDS_LOCKED:'The daily loss limit, the loss streak pause, the kill switch and every other guard stay exactly as saved. A proposal never loosens a loss guard. The daily loss limit is counted in R (1R is the risk of one trade), so a higher risk per trade raises its money value: for example 3R at 1.5% allows up to 4.5% of equity in one day.',
    DAILY_LOSS_VALUE_RISES:'Max risk per trade rises from {before}% to {after}%. The daily loss limit of {limit}R is counted in R, so its money value rises from up to {from}% to up to {to}% of equity per day.',
    CAPITAL_NEVER_CHANGED:'Equity and balance never change. A proposal adds no funds and withdraws none.',
    HISTORICAL_AFTER_NOT_SIMULATED:'The historical result after these changes is not simulated. Past Paper evidence describes the saved policy, not this proposal.',
    SAVE_STALES_DEPLOYMENT:'Saving changes the policy hash. The READY deployment then refuses BUY events (STALE_POLICY) until a new deployment is generated and activated; historical evidence also needs a new enrollment and Preflight run.',
    PERSISTENT_PAUSE_NOT_CHANGED:'The loss-streak pause stays active. A proposal never resets or re-arms a pause.',
    DECLARED_LOSS_BELOW_BRIDGE_RISK:'The declared loss per trade is below the active Bridge risk. Saving it would reject every Bridge BUY, so the risk ceiling is left unchanged.',
    BRIDGE_RISK_PERCENT_UNKNOWN:'No READY Bridge deployment gives a risk percent, so the risk ceiling cannot be checked against Bridge entries.',
    DAILY_BELOW_ORDER_NOTIONAL:'The daily notional ceiling is below the order notional ceiling; one order can use the whole daily allowance.',
    REPEATED_ENTRIES_NOT_LOOSENED:'Repeated entries stay blocked. A proposal never switches a guard off; turn off the repeated-entry block yourself in the Risk form if you want them.',
    NEWS_BLOCK_WITHOUT_NEWS_DATA:'Bridge alerts carry no news data; turn off Block during news yourself in the Risk form, then save and generate again.',
    BASE_POLICY_CONFLICT:'The saved policy has conflicting settings. Fix them in the Risk form first; a proposal cannot be saved on top of them.'};
  const P4_CONSEQUENCES={DEPLOYMENT_SNAPSHOT_STALE:'The READY Bridge deployment becomes stale: generate and activate again before trading.',
    PF2_EVIDENCE_STALE:'The PF-2 evidence no longer matches the saved policy: enroll and run Preflight again.'};
  const P4_REFUSALS={RISK_POLICY_FROZEN:'The Risk policy is frozen while the bot is running or paused. Stop the bot first.',
    BASE_POLICY_CONFLICT:'The saved policy has conflicting settings. Fix them in the Risk form first.',
    PROPOSAL_EMPTY:'These limits change nothing: the saved policy already matches them.',
    CAPITAL_DRIFT:'The saved capital differs from the funding ledger, so a save would add funds. It is refused.',
    STALE_POLICY_STATE:'The saved policy changed after this proposal was computed. Compute it again.',
    PROPOSAL_STALE:'The inputs of this proposal changed (policy, evidence or limits). Compute it again.',
    CONFIRMATION_REQUIRED:'Confirmation is required to save.',PF4_DECLARED_INVALID:'A declared limit is not valid. Use a plain number inside its range.',
    INVALID_FIELDS:'The request was not accepted.',PF4_INTENT_UNSUPPORTED:'The Order Preview must be a Binance Global BTCUSDT signal or the READY Bridge deployment.',
    RETRY_TRANSACTION:'Another change was in progress. Compute the proposal again.',PF4_PREVIEW_UNAVAILABLE:'The proposal could not be computed now. Try again.',
    PF4_FUNDING_INVARIANT:'The save was cancelled because it would have changed funding.',PF4_SAVE_MISMATCH:'The save was cancelled because the saved policy did not match the proposal.',
    BOT_ACCESS_DENIED:'This bot is not available to you.',SIZING_PREVIEW_REFUSED:'The Order Preview was refused for this proposal.',
    PF4_SIZING_POLICY_SOURCE:'The effective policy is not the saved policy, so the sizes are not shown.'};

  const short=(value,size=12)=>typeof value==='string'?value.slice(0,size):dash(value);
  const flag=value=>value===true?T('On'):value===false?T('Off'):dash(value);
  const meaning=(table,value)=>Object.hasOwn(table,value)?label(table[value]):code(value);
  const fieldName=name=>Object.hasOwn(P4_FIELDS,name)?label(P4_FIELDS[name]):String(name).startsWith('defaults.')?
    make('span','',label('Default'),' ',code(String(name).slice(9))):code(name);
  const DECLARED_FOR={LOSS_CEILING:'loss_per_trade_percent',ORDER_NOTIONAL:'order_notional_ceiling',DAILY_NOTIONAL:'daily_notional_ceiling'};

  function provenance(list){
    return make('div','pf4-prov',...(Array.isArray(list)?list:[]).map(entry=>{
      const bits=[meaning(P4_SOURCES,entry.source),' '];
      if(entry.source==='SAVED_POLICY')bits.push(make('span','pf3-hash',short(entry.hash)));
      else if(entry.source==='OWNER_DECLARED')bits.push(code(entry.field+' = '+String(entry.value)));
      else if(entry.source==='PF2_EVIDENCE')bits.push(make('span','pf3-hash',short(entry.job_id,8)),' ',
        code((entry.reasons||[]).map(item=>item.code+' '+item.count).join(', ')||'—'));
      else if(entry.source==='DEPLOYMENT_EVIDENCE')bits.push(make('span','pf3-hash',short(entry.deployment_id)),' ',code(dash(entry.risk_percent)+'%'));
      return make('div','pf4-prov-item',...bits);
    }));
  }

  // The explanation is built here from the structured change so that it follows the language; an unknown rule shows the server text.
  function explanation(item,proposal){
    const key=item.rule+':'+item.direction;
    if(!Object.hasOwn(P4_EXPLAIN,key))return make('span','',typeof item.explanation==='string'?item.explanation:'—');
    const declared=DECLARED_FOR[item.rule]?proposal.declared?.[DECLARED_FOR[item.rule]]:'';
    const parts=[];
    if(item.rule==='CAP_SIZING'){
      const sources=(item.provenance||[]).map(entry=>entry.source);
      if(sources.includes('PF2_EVIDENCE'))parts.push(tpl('{count} historical BUY intents were rejected because the risk-sized order exceeded a limit.',
        {count:proposal.evidence?.cappable_buy_rejections??'?'}));
      if(sources.includes('OWNER_DECLARED'))parts.push(T('Lower notional ceilings with capping off would reject orders above them; capping keeps them inside the new ceilings.'));
    }
    parts.push(tpl(P4_EXPLAIN[key],{declared,before:item.before,after:item.after,key:String(item.field).slice(9)}));
    if(item.rule==='LOSS_CEILING'){
      if(proposal.bridge_risk)parts.push(tpl('The active Bridge risk is {risk}%, so entries stay possible.',{risk:proposal.bridge_risk.risk_percent}));
      parts.push(T('Fees, slippage and gaps can exceed a nominal stop.'));
    }
    return make('span','',parts.join(' '));
  }

  const asText=value=>value===null||value===undefined?'—':String(value);
  function sizingColumn(side){
    const calc=side?.calculation||{},order=calc.order||{};
    return [code(calc.status),asText(calc.reason),asText(order.quantity),asText(order.notional),order.sizingAdjustment?T('Yes'):T('No'),asText(side?.policy_source)];
  }
  function sizingSection(sizing){
    if(!sizing||sizing.status==='NOT_REQUESTED')return null;
    if(sizing.status!=='COMPUTED')return group('Sizing before and after',row('Status',code(sizing.status)),
      row('Reason',meaning(P4_REFUSALS,sizing.code),sizing.detail?' ('+sizing.detail+')':''));
    const before=sizingColumn(sizing.before),after=sizingColumn(sizing.after),capital=sizing.capital||{};
    const names=['Calculation','Reason','Sized quantity','Sized notional','Capped to limits','Policy source'];
    const sizes=table(['Item','Before','After'],names.map((name,at)=>[label(name),before[at],after[at]]));
    sizes.querySelector('table').classList.add('pf4-sizing');
    return group('Sizing before and after',row('Capital used',code(capital.source),' · ',T('Cash'),' ',asText(capital.cash),' · ',T('Book equity (cost basis)'),' ',asText(capital.book_equity)),sizes);
  }

  function staticSection(preview){
    const view=preview.static||{},check=view.consistency||{},capacity=view.capacity||{};
    const pair=(before,after,pick)=>asText(before?pick(before):null)+' → '+asText(after?pick(after):null);
    return group('Policy before and after',row('Policy check',code(asText(check.before?.status)+' → '+asText(check.after?.status))),
      row('Remaining daily notional',pair(capacity.before,capacity.after,item=>item.remainingDailyNotional)),
      row('Remaining daily executions',pair(capacity.before,capacity.after,item=>item.remainingDailyExecutions)));
  }
  function changesSection(proposal){
    const changes=Array.isArray(proposal.changes)?proposal.changes:[];
    if(!changes.length)return group('Proposed changes',note('No changes are proposed with these limits.'));
    const grid=table(['Setting','Before','After','Rule','Provenance','Explanation'],changes.map(item=>[fieldName(item.field),flag(item.before),
      flag(item.after),make('span','',meaning(P4_RULES,item.rule),' · ',meaning(P4_DIRECTIONS,item.direction)),provenance(item.provenance),explanation(item,proposal)]));
    grid.querySelector('table').classList.add('pf4-changes');
    return group('Proposed changes',grid);
  }
  function advisoriesSection(proposal){
    const items=Array.isArray(proposal.advisories)?proposal.advisories:[];
    return group('Advisories',make('ul','pf3-list',...items.map(item=>make('li','pf4-advisory pf4-'+(item.severity==='warn'?'warn':'info'),code(item.code),' ',
      !Object.hasOwn(P4_ADVISORIES,item.code)?make('span','',asText(item.explanation)):item.values&&typeof item.values==='object'?
        make('span','',tpl(P4_ADVISORIES[item.code],item.values)):label(P4_ADVISORIES[item.code])))));
  }
  function consequencesSection(list){
    if(!Array.isArray(list)||!list.length)return null;
    return group('What a save changes',make('ul','pf3-list',...list.map(item=>make('li','pf4-advisory pf4-warn',code(item.code),' ',meaning(P4_CONSEQUENCES,item.code),' ',
      make('span','pf3-hash',short(item.deployment_id??item.job_id,16))))));
  }
  function previewView(){
    const preview=p4.preview,proposal=preview.proposal,save=preview.save||{};
    const gate=[];
    if(p4.stale)gate.push(make('p','pf3-ev-error',label('The limits changed after this proposal was computed. Compute it again.')));
    if(riskDirty())gate.push(make('p','pf3-ev-error',label('Save or discard your Risk form changes first.')));
    if(save.allowed!==true)gate.push(make('p','pf3-ev-error',label('This proposal cannot be saved'),': ',meaning(P4_REFUSALS,save.refusal_code)));
    return [make('div','pf3-evidence',row('Proposal',make('span','pf3-hash',short(proposal.proposal_hash,16))),row('Readiness verdict',code(preview.report_verdict)),
      row('Declared limits',code(JSON.stringify(proposal.declared||{})))),...gate,guard('Proposed changes',()=>changesSection(proposal)),
      guard('Policy before and after',()=>staticSection(preview)),guard('Sizing before and after',()=>sizingSection(preview.sizing)),
      guard('Advisories',()=>advisoriesSection(proposal)),guard('What a save changes',()=>consequencesSection(save.consequences))];
  }
  function outcomeView(){
    const done=p4.done;
    return [make('p','pf3-fixed',label('Saved. The Risk policy now matches the proposal.')),
      make('div','pf3-evidence',row('Policy hash before',make('span','pf3-hash',dash(done.policy_hash_before))),row('Policy hash after',make('span','pf3-hash',dash(done.policy_hash_after))),
        row('Changed settings',make('span','pf3-v',...(done.changed_fields||[]).map(name=>code(name)).flatMap(item=>[item,' '])))),
      consequencesSection(done.consequences),make('p','pf3-note',label('The Risk form and the readiness report were refreshed.'))];
  }
  function renderPf4(){
    if(!pf4Root)return;
    let view;
    if(p4.busy)view=[make('p','pf3-note',label('Loading…'))];
    else if(p4.notice)view=[make('p','pf3-note',label(p4.notice))];
    else if(p4.error)view=[make('p','pf3-ev-error',meaning(P4_REFUSALS,p4.error.code),' (',code(p4.error.code),')',
      p4.error.field?make('span','pf3-detail',' '+p4.error.field):null),make('p','pf3-note',label('Compute the proposal again.'))];
    else if(p4.done)view=outcomeView();
    else if(p4.preview)view=previewView();
    else view=[make('p','pf3-note',label(p4.asked?'No proposal.':'Declare your limits, then compute a proposal.'))];
    pf4Root.replaceChildren(...view.filter(Boolean));
    gatePf4();
  }
  let pf4Open=false;
  function gatePf4(){
    if(!pf4Save||!pf4Confirm)return;
    const open=!!p4.preview&&p4.preview.save?.allowed===true&&!p4.stale&&!p4.busy&&scope()!=='all'&&!riskDirty();
    pf4Confirm.disabled=!open;
    // The confirmation never survives a closed gate: whenever the save opens again the owner confirms again.
    if(!open||!pf4Open)pf4Confirm.checked=false;
    pf4Open=open;
    pf4Save.disabled=!(open&&pf4Confirm.checked);
  }

  const declaredInputs=()=>{
    const out={};
    for(const name of ['loss_per_trade_percent','order_notional_ceiling','daily_notional_ceiling']){
      const value=pf4Form.elements[name].value.trim();
      if(value!=='')out[name]=value;
    }
    const repeat=pf4Form.elements.allow_repeated_entries.value;
    if(repeat==='true'||repeat==='false')out.allow_repeated_entries=repeat==='true';
    return out;
  };
  // A server refusal becomes a code the page can explain; PF4_DECLARED_INVALID names the field after the colon.
  const refusalOf=error=>({code:errorCode(error),field:error?.code==='PF4_DECLARED_INVALID'&&typeof error.message==='string'?(error.message.split(': ')[1]??null):null});
  const reset=extra=>Object.assign(p4,{busy:false,preview:null,declared:null,stale:false,error:null,notice:null,done:null,...extra});

  // withSizing adds the Order Preview intent of the Risk form (riskPreviewRequest in app.js). Neither call saves anything.
  async function computePf4(withSizing){
    const requested=scope(),seq=++p4.seq;
    reset({asked:true});
    if(requested==='all'){p4.notice='Select one bot for this operation';renderPf4();return;}
    const declared=declaredInputs(),body={declared};
    if(withSizing){
      const intent=typeof riskPreviewRequest==='function'?riskPreviewRequest():null;
      if(!intent){p4.notice='Fill in the Order Preview above first: price and Stop Loss for a generic BUY, or a deployed Bridge intent.';renderPf4();return;}
      body.intent=intent;
    }
    p4.busy=true;renderPf4();
    try{
      const answer=await api('/api/risk/proposals/preview',{method:'POST',silent:true,body:JSON.stringify(body)});
      if(seq!==p4.seq||requested!==scope())return;
      if(!answer||typeof answer!=='object'||!answer.proposal||typeof answer.proposal!=='object')throw new Error('REQUEST_FAILED');
      Object.assign(p4,{busy:false,preview:answer,declared});
    }catch(error){
      if(seq!==p4.seq||requested!==scope())return;
      Object.assign(p4,{busy:false,error:refusalOf(error)});
    }
    renderPf4();
  }

  // The only save. It needs a computed proposal that is allowed, not stale, a ticked confirmation and a clean Risk form. Any 400 or 409
  // clears the proposal: it is never retried and never recomputed on its own.
  async function savePf4(){
    const preview=p4.preview;
    if(!preview||p4.stale||p4.busy||riskDirty()||!pf4Confirm.checked||preview.save?.allowed!==true||scope()==='all')return;
    const requested=scope(),seq=++p4.seq,declared=p4.declared,proposal=preview.proposal;
    p4.busy=true;renderPf4();
    try{
      const answer=await api('/api/risk/proposals/apply',{method:'POST',body:JSON.stringify({base_policy_hash:proposal.base_policy_hash,
        proposal_hash:proposal.proposal_hash,declared,confirm:'SAVE_RISK_PROPOSAL'})});
      if(seq!==p4.seq||requested!==scope())return;
      if(!answer||typeof answer!=='object')throw new Error('REQUEST_FAILED');
      reset({done:answer});renderPf4();
      try{if(typeof load==='function')await load();}catch{}
      if(seq===p4.seq&&requested===scope())refresh();
    }catch(error){
      if(seq!==p4.seq||requested!==scope())return;
      reset({error:refusalOf(error)});renderPf4();
    }
  }
  function clearPf4(){p4.seq++;reset({asked:false});renderPf4();}
  const staleOnEdit=event=>{if(event.target!==pf4Confirm&&p4.preview&&!p4.stale){p4.stale=true;renderPf4();}};
  const riskFormEdited=()=>{gatePf4();if(p4.preview)renderPf4();};
  if(pf4Form&&pf4Root&&pf4Confirm&&pf4Save){
    document.getElementById('pf4Compute')?.addEventListener('click',()=>computePf4(false));
    document.getElementById('pf4Sizing')?.addEventListener('click',()=>computePf4(true));
    pf4Save.addEventListener('click',savePf4);
    pf4Confirm.addEventListener('change',gatePf4);
    pf4Form.addEventListener('submit',event=>{event.preventDefault();computePf4(false);});
    pf4Form.addEventListener('input',staleOnEdit);
    document.getElementById('riskForm')?.addEventListener('input',riskFormEdited);
    document.getElementById('riskForm')?.addEventListener('change',riskFormEdited);
    document.getElementById('logout')?.addEventListener('click',clearPf4);
    document.getElementById('language')?.addEventListener('change',renderPf4);
    document.getElementById('botSwitcher')?.addEventListener('change',clearPf4);
    // A reload refills the Risk form and clears its unsaved flag. Re-run the gate afterwards so the notice about unsaved Risk
    // changes goes away without a new Compute. Guarded, so a second copy of this script never wraps twice.
    if(typeof load==='function'&&!load.pf4Gate){
      const reload=load;
      const reloadThenGate=async function(...args){try{return await reload.apply(this,args);}finally{riskFormEdited();}};
      reloadThenGate.pf4Gate=true;
      window.load=reloadThenGate;
    }
  }
  renderPf4();
  render();
})();
