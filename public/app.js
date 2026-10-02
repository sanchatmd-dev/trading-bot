const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=v=>new Intl.NumberFormat('en-US',{maximumSignificantDigits:10}).format(v||0);let authenticated=false,csrfToken='',me,webhook={},signals=[],positions=[],users=[],licenses=[];
let selectedBot='',botProfiles=[];
async function api(path,o={}){
  const {silent=false,botId,...request}=o;
  if(!path.startsWith('/api/auth/')&&!path.startsWith('/api/admin/')&&!path.startsWith('/api/bots')){
    const url=new URL(path,location.origin),scope=botId??selectedBot;
    if(scope==='all'&&!['/api/me','/api/signals','/api/positions'].includes(url.pathname)&&botId===undefined){
      if(request.method&&request.method!=='GET')throw new Error(translate('Select one bot for this operation'));
    }else if(scope)url.searchParams.set('bot_id',scope);
    path=url.pathname+url.search;
  }
  const r=await fetch(path,{...request,credentials:'same-origin',headers:{'content-type':'application/json',...(csrfToken?{'x-csrf-token':csrfToken}:{}),...(request.headers||{})}}),d=await r.json();if(!r.ok){if(d.code==='STEP_UP_REQUIRED'&&typeof openStepUp==='function')openStepUp();if(d.code==='MFA_ENROLLMENT_REQUIRED')document.querySelector('[data-view="account"]').click();throw Object.assign(new Error(d.error||'Request failed'),{status:r.status,code:d.code});}if(!silent&&request.method&&request.method!=='GET'&&!path.startsWith('/api/auth/'))showSaved();return d;
}
async function login(){if(typeof mfaChallenge!=='undefined'&&mfaChallenge)return;try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});if(d.mfaRequired){showMfaLogin();return;}csrfToken=d.csrfToken;authenticated=true;$('#password').value='';$('#loginError').textContent='';await load();}catch(e){$('#loginError').textContent=e.message;}}
async function loadAdmin(){[users,licenses]=await Promise.all([api('/api/admin/users'),me.security.permissions.includes('licenses:read')?api('/api/admin/licenses'):Promise.resolve([])]);renderAdmin();if(typeof applyAdminPermissions==='function')applyAdminPermissions();}
async function load(){try{[me,signals,positions,webhook]=await Promise.all([api('/api/me'),api('/api/signals?limit=200'),api('/api/positions'),api('/api/me/webhook-secret')]);$('#login').hidden=true;$('#app').hidden=false;$('#logout').hidden=false;$('#serverDot').className='dot online';$('#serverText').textContent=me.user.email;render();if(typeof renderSecurity==='function')renderSecurity();$('#adminNav').hidden=!me.security.permissions.includes('users:read')||me.security.mfaEnrollmentRequired;if(me.security.mfaEnrollmentRequired)document.querySelector('[data-view="account"]').click();if(me.security.permissions.includes('users:read')&&!me.security.mfaEnrollmentRequired&&me.security.elevatedUntil>Date.now()){await loadAdmin();}}catch(e){if(e.status===401){authenticated=false;csrfToken='';$('#login').hidden=false;$('#app').hidden=true;$('#logout').hidden=true;$('#adminNav').hidden=true;}$('#loginError').textContent=e.message;}}
function render(){const p=me.risk,l=me.license||{};$('#modeValue').textContent='PAPER · LIVE LOCKED';$('#killValue').textContent=me.globalKill||p.killSwitch?'ENTRIES PAUSED':'PAPER RUNNING';$('#licenseValue').textContent=l.status||'NONE';$('#licenseExpiry').textContent=l.expires_at?new Date(l.expires_at).toLocaleDateString():'';$('#tradesValue').textContent=me.daily.trades;$('#dailyStats').textContent=(me.dailyAccounts||[]).map(x=>`${botProfiles.find(bot=>bot.id===x.bot_id)?.label||x.bot_id||''} ${x.account_id}: ${fmt(x.notional)} · ${fmt(x.realized_r)}R · streak ${x.loss_streak}`).join(' | ')||'UTC · แยกยอดตามบัญชี';$('#recentSignals').innerHTML=signals.slice(0,8).map(x=>`<div class="list-row"><span>${esc(x.symbol)} <small>${esc(x.bot_label||'')} · ${esc(x.event)} · ${esc(x.broker)} · ${esc(x.execution_mode||'LEGACY')}</small><time datetime="${new Date(x.received_at).toISOString()}" title="${esc(new Date(x.received_at).toISOString())}">${esc(new Date(x.received_at).toLocaleString())}</time></span><span class="pill ${esc(x.status)}">${esc(x.status)}</span></div>`).join('')||'<p>ยังไม่มี Signal</p>';$('#positions').innerHTML=positions.map(x=>`<div class="list-row"><span>${esc(x.symbol)} <small>${esc(x.bot_label||'')} · ${esc(x.broker)} · ${esc(x.execution_mode||'LEGACY')}</small></span><span>${fmt(x.quantity)} @ ${fmt(x.avg_price)}</span></div>`).join('')||'<p>ยังไม่มี Position</p>';renderSignals();renderWebhook();fillRisk(p);$('#accountInfo').innerHTML=`<p><strong>${esc(me.user.email)}</strong><br>${esc(me.user.role)} · ${esc(me.user.status)}<br>Webhook: ••••••${esc(me.bot?.webhook_hint||me.user.webhook_hint||'-')}</p>`;const set=new Map(me.brokers.map(x=>[x.broker,x]));$('#brokerList').innerHTML=['binance-global','binance-th','innovestx','mt5','settrade','future-http'].map(b=>`<div class="list-row"><span>${b}</span><span>${set.has(b)?(set.get(b).enabled?'SAVED · LIVE LOCKED':'DISABLED'):'NOT SET'}</span></div>`).join('');}
function renderSignals(){
  $('#signalRows').innerHTML=signals.map(x=>`<tr>
    <td><time datetime="${new Date(x.received_at).toISOString()}">${esc(new Date(x.received_at).toLocaleString())}</time></td>
    <td><strong>${esc(x.symbol)}</strong><small>${esc(x.event)} · ${esc(x.timeframe||'-')}</small></td>
    <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td>
    <td>${x.status==='REJECTED'?`<p class="rejection-help" data-rejection="${esc(x.error_message||'')}">${esc(explainRejection(x.error_message))}</p><small class="raw-reason">${esc(x.error_message||'')}</small>`:'—'}</td>
    <td><details><summary data-ui-label="Details / Notes">${esc(translate('Details / Notes'))}</summary><dl class="order-details">
    <dt>Trade ID</dt><dd>${esc(x.trade_id)}</dd><dt>Bot</dt><dd>${esc(x.bot_label||x.user_id)}</dd>
    <dt>Account / Mode</dt><dd>${esc(x.account_id||'legacy')} / ${esc(x.execution_mode||'LEGACY')}</dd>
    <dt>Entry / SL / TP</dt><dd>${fmt(x.entry_price)} / ${fmt(x.stop_loss)} / ${fmt(x.take_profit)}</dd>
    <dt>Order ID</dt><dd>${esc(x.order_id||'-')}</dd><dt>Fill / Slippage</dt><dd>${fmt(x.fill_price)} / ${x.slippage_bps==null?'-':fmt(x.slippage_bps)+' bps'}</dd>
    </dl><pre>${esc(x.broker_response||x.error_message||'-')}</pre>
    ${x.status==='REJECTED'?`<label>${esc(translate('Rejected notes'))}<textarea class="review-note" data-id="${x.id}" maxlength="2000" aria-label="Rejected notes">${esc(x.review_note||'')}</textarea></label><button type="button" class="mini save-note" data-id="${x.id}">${esc(translate('Save note'))}</button><span class="note-error" role="alert"></span>`:''}
    </details></td></tr>`).join('');
}
function renderWebhook(){
  const input=$('#webhookResult');
  input.value=webhook.urlPath?location.origin+webhook.urlPath:'';
  $('#copyWebhook').disabled=!input.value;
  $('#recoverWebhookForm').hidden=!webhook.recoveryRequired;
  $('#webhookStatus').textContent=translate(webhook.urlPath?'Current URL is ready to copy.':webhook.recoveryRequired?'Waiting for the next authenticated signal, or paste your existing URL below. No rotation is needed.':'Create a webhook to begin.');
}

const riskDefaultsMap={defaultRiskPercent:'riskPercent',defaultTradesPerDay:'tradesPerDay',defaultDailyLossR:'dailyLossR',defaultLossStreak:'lossStreak',defaultOpenPositions:'openPositions',defaultSignalAgeSeconds:'signalAgeSeconds',defaultOrderNotional:'orderNotional',defaultDailyNotional:'dailyNotional',defaultVolatilityPercent:'volatilityPercent'};
const riskMaxFields=['maxRiskPercent','maxTradesPerDay','maxDailyLossR','pauseAfterLossStreak','maxOpenPositions','maxSignalAgeSeconds','maxOrderNotional','maxDailyNotional','maxVolatilityPercent'];
const riskBooleanFields=['capPercentEquitySize','paperTrading','killSwitch','onePositionPerSymbol','requireReduceOnlySell','blockHighVolatility','blockDuringNews'];
const fundFields=[['equityGlobal','balanceGlobal','binance-global'],['equityTh','balanceTh','binance-th'],['equityInnovestx','balanceInnovestx','innovestx'],['equitySettrade','balanceSettrade','settrade']];
function fillRisk(p){
  const runtimeLabel=document.querySelector('.brand small');if(runtimeLabel&&me.moneyFormat==='decimal-string')runtimeLabel.textContent='VPS v2.2 · PostgreSQL · Paper';
  const f=$('#riskForm').elements;
  $('#paperAccountRows').innerHTML=(me.paperAccounts||[]).map(account=>`<div class="list-row"><span>${esc(account.broker)} · ${esc(account.currency)}</span><span><span data-ui-label="Cash">${esc(translate('Cash'))}</span>: ${fmt(account.cash)} · <span data-ui-label="Book equity">${esc(translate('Book equity'))}</span>: ${fmt(account.bookEquity)}</span></div>`).join('');
  for(const k of riskMaxFields)f[k].value=p[k];
  for(const[input,key]of Object.entries(riskDefaultsMap))f[input].value=p.defaults?.[key]??p[({riskPercent:'maxRiskPercent',tradesPerDay:'maxTradesPerDay',dailyLossR:'maxDailyLossR',lossStreak:'pauseAfterLossStreak',openPositions:'maxOpenPositions',signalAgeSeconds:'maxSignalAgeSeconds',orderNotional:'maxOrderNotional',dailyNotional:'maxDailyNotional',volatilityPercent:'maxVolatilityPercent'})[key]];
  for(const k of riskBooleanFields)f[k].checked=!!p[k];
  f.paperTrading.checked=true;f.paperTrading.disabled=true;f.requireReduceOnlySell.checked=true;f.requireReduceOnlySell.disabled=true;
  f.sideMode.value=p.sideMode;f.allowedSymbols.value=(p.allowedSymbols||[]).join(',');
  for(const[equityInput,balanceInput,broker]of fundFields){const equity=p.equities?.[broker]||0;f[equityInput].value=equity;f[balanceInput].value=p.balances?.[broker]??equity;}
  if(!f.previewRiskPercent.value)f.previewRiskPercent.value=p.defaults?.riskPercent??1;
  window._riskDirty=false;
  if(typeof lockRiskForm==='function')lockRiskForm(['RUNNING','PAUSED'].includes(me?.botSession?.state));
  updatePreviewControls();scheduleRiskPreview();if(me.moneyFormat!=='decimal-string')updatePositionSlots();
}
function collectRiskPolicy(){
  const f=$('#riskForm').elements,n=k=>me?.moneyFormat==='decimal-string'&&(/^(equity|balance)/.test(k)||['maxOrderNotional','maxDailyNotional','defaultOrderNotional','defaultDailyNotional'].includes(k))?f[k].value:+f[k].value,p={defaults:{},equities:{},balances:{}};
  for(const k of riskMaxFields)p[k]=n(k);
  for(const[input,key]of Object.entries(riskDefaultsMap))p.defaults[key]=n(input);
  for(const k of riskBooleanFields)p[k]=f[k].checked;
  p.sideMode=f.sideMode.value;p.allowedSymbols=f.allowedSymbols.value.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
  for(const[equityInput,balanceInput,broker]of fundFields){p.equities[broker]=n(equityInput);p.balances[broker]=n(balanceInput);}
  return p;
}
function updatePositionSlots(){
  if(!me)return;
  const f=$('#riskForm').elements,broker=f.previewBroker.value,open=positions.filter(x=>x.user_id===(me.bot?.id||me.user.id)&&x.broker===broker&&x.execution_mode==='PAPER').length,max=+f.maxOpenPositions.value||0;
  $('#previewSlots').textContent=`${open} / ${Math.max(0,max-open)}`;
}
let riskPreviewTimer,riskPreviewSequence=0;
function invalidateRiskPreview(){
  ++riskPreviewSequence;clearTimeout(riskPreviewTimer);
  $('#riskPreviewStatus').textContent='Preview needs checking';$('#riskPreviewStatus').className='preview-badge';
  for(const id of ['previewRisk','previewQuantity','previewNotional','previewBalance','previewSlots','previewCapacity'])$('#'+id).textContent='—';
  for(const id of ['riskPreviewReason','riskPreviewProvenance','riskPreviewCapital','riskPreviewCosts','riskPreviewVenue'])$('#'+id).textContent='';
}
function updatePreviewControls(){
  const f=$('#riskForm').elements,postgres=me?.moneyFormat==='decimal-string',bridge=f.previewSource.value==='BRIDGE';
  $('#previewDraftFields').hidden=!postgres||f.previewAuthority.value!=='DRAFT';
  $('#previewBridgeFields').hidden=!bridge;$('#previewGenericFields').hidden=bridge;
  f.previewAuthority.disabled=!postgres;f.previewSource.disabled=!postgres;
  $('#previewRefreshVenue').disabled=!postgres||(!bridge&&f.previewBroker.value!=='binance-global');
}
function scheduleRiskPreview(){invalidateRiskPreview();riskPreviewTimer=setTimeout(previewRisk,250);}
function previewAmount(value){return value==null?'—':fmt(value);}
function previewVenueText(venue){
  if(!venue)return 'Venue filters have not been verified.';
  const status={PASSED:'Cached filters passed for this preview',BLOCKED:'Venue filters blocked this preview',UNKNOWN:'Venue filters are not verified'}[venue.status]||'Venue status unknown';
  const reasons=(venue.reasons||[]).map(readinessMeaning);
  const checks=(venue.checks||[]).map(check=>typeof check==='string'?readinessMeaning(check):`${readinessMeaning(check.name||check.filter||check.type||'filter check')}: ${readinessMeaning(check.status||check.code||'unknown')}${check.reason?' ('+readinessMeaning(check.reason)+')':''}`);
  const retrieved=venue.retrievedAt?new Date(venue.retrievedAt):null;
  return [status,...reasons,...checks,venue.snapshotHash?'Metadata hash: '+venue.snapshotHash:null,retrieved&&!Number.isNaN(retrieved.getTime())?'Retrieved: '+retrieved.toISOString():null,venue.accountFilterAssumption,venue.liveAccountVerified===false?'This is not Live venue approval.':null,'Metadata cache lasts 60 seconds; execution rechecks filters.'].filter(Boolean).join(' · ');
}
function readinessMeaning(code){
  const meanings={POINT_IN_TIME_ONLY:'This check is a point-in-time snapshot.',PAPER_ONLY:'Paper trading only.',COST_BASIS_NOT_MARK_TO_MARKET:'Capital uses position cost, not live market valuation.',INPUT_MARKET_DATA_UNVERIFIED:'Input market data has not been verified.',VENUE_FILTERS_UNVERIFIED:'Venue quantity and price filters have not been verified.',EXECUTION_COSTS_UNVERIFIED:'Execution costs have not been verified.',BRIDGE_PREFLIGHT_UNSUPPORTED:'Bridge preflight is unsupported in this generic Spot preview.',RUNNING_LOCKED_POLICY_MISSING:'The running session has no locked policy; the saved policy was used.',POLICY_CONFIGURATION_CONFLICT:'Saved policy has conflicting settings.',POLICY_VALUE_OUT_OF_RANGE:'Value is outside the allowed policy range.',POLICY_VALUE_INVALID:'Policy value is invalid.',POLICY_BOOLEAN_REQUIRED:'A policy switch must be true or false.',POLICY_SIDE_MODE_INVALID:'Policy side mode is invalid.',SPOT_PAPER_PROTECTION_REQUIRED:'Spot Paper protections must remain enabled.',DEFAULT_OUTSIDE_POLICY:'Default value exceeds or falls outside the policy limit.',DEFAULT_VALUE_INVALID:'Default value is invalid.',CAPITAL_CONFIGURATION_INVALID:'Configured funding is invalid or balance exceeds equity.',ESTIMATED_STOP_LOSS_EXCEEDS_POLICY:'Estimated stop-loss risk exceeds the saved policy limit.',ACCOUNT_SUSPENDED:'The account or bot is suspended.',BOT_STOPPED:'The bot is stopped.',BOT_PAUSED:'The bot is paused; only reduce-only exits are accepted.',SESSION_STATE_UNSUPPORTED:'The session state is unsupported.',ORDER_OUTCOME_UNCERTAIN:'An order outcome needs operator reconciliation.',RISK_REJECTED:'The saved risk policy rejects this order.',COST_INCLUSIVE_RISK_LIMIT_NOT_ENFORCED:'The risk limit does not enforce all execution costs.',HYPOTHETICAL_BRIDGE_INTENT:'This Bridge intent is hypothetical.',HYPOTHETICAL_POLICY_AND_CAPITAL:'Draft policy and capital are hypothetical; actual positions, reservations and session guards still apply.',PENDING_FEE_RESERVATIONS_UNSUPPORTED:'Pending fee reservations are not supported by this estimate.',VENUE_MARKET_UNSUPPORTED:'Cached venue checks support Binance Global BTCUSDT only.'};
  return meanings[code]||String(code).toLowerCase().replaceAll('_',' ');
}
function renderSavedRiskPreview(result){
  const calculation=result.calculation||{},order=calculation.order,account=result.account||{},capacity=result.capacity||{};
  const blocked=result.readiness?.status==='BLOCKED';
  const hypothetical=result.scenario?.hypothetical===true||result.policy?.hypothetical===true;
  $('#riskPreviewStatus').textContent=(hypothetical?'Hypothetical draft — ':'')+(blocked?'BLOCKED':'Not verified')+' — '+(calculation.status||'UNKNOWN');
  $('#riskPreviewStatus').className='preview-badge '+(blocked?'bad':'');
  $('#previewRisk').textContent=order?.stopLoss!=null?previewAmount(Number(order.quantity)*Math.abs(Number(order.price)-Number(order.stopLoss))):'—';
  $('#previewQuantity').textContent=previewAmount(order?.quantity);$('#previewNotional').textContent=previewAmount(order?.notional);
  $('#previewBalance').textContent=previewAmount(account.cashAvailable);
  $('#previewSlots').textContent=capacity.uniqueSymbolsCommitted!=null&&capacity.remainingUniqueSymbols!=null?`${capacity.uniqueSymbolsCommitted} / ${capacity.remainingUniqueSymbols}`:'—';
  $('#previewCapacityLabel').textContent='Daily execution allowance';
  $('#previewCapacity').textContent=previewAmount(capacity.remainingDailyExecutions);
  const source=result.policy?.source||result.policySource;
  const provenance=hypothetical?'Hypothetical draft policy':({LOCKED_SESSION:'Locked session policy',SAVED_POLICY:'Saved bot policy',SAVED_POLICY_FALLBACK:'Saved policy fallback'}[source]||'Unknown policy source');
  $('#riskPreviewProvenance').textContent=`Policy: ${provenance} · Bot: ${result.botId||'UNKNOWN'} · Session: ${result.session?.state||'UNKNOWN'} · As of: ${result.asOf||'UNKNOWN'}${result.policy?.hash?' · Hash: '+result.policy.hash:''}. ${hypothetical?'Draft inputs are hypothetical. Policy, funding and orders are not saved.':'Unsaved policy and funding changes are not used.'}`;
  const reserved=account.cash!=null&&account.cashAvailable!=null?Number(account.cash)-Number(account.cashAvailable):null;
  $('#riskPreviewCapital').textContent=`${hypothetical?'Hypothetical capital':'Server capital'} · Cash: ${previewAmount(account.cash)} · Available: ${previewAmount(account.cashAvailable)} · Reserved: ${previewAmount(reserved)} · Book equity: ${previewAmount(account.bookEquity)} · Position cost: ${previewAmount(account.positionCost)}. Book equity uses cost basis.${result.scenario?.note?' '+result.scenario.note:''}`;
  const costs=result.costs;
  $('#riskPreviewCosts').textContent=costs?`Execution cost estimates · Fee: ${previewAmount(costs.fee)} · Cash debit: ${previewAmount(costs.cashDebit)} · Cash credit: ${previewAmount(costs.cashCredit)} · Cash after order: ${previewAmount(costs.cashAfterOrder)} · Loss at stop: ${previewAmount(costs.estimatedLossAtStop)} · Profit at target: ${previewAmount(costs.estimatedProfitAtTarget)} · Cost / stop: ${previewAmount(costs.costToStopRatio)} · Cost / target: ${previewAmount(costs.costToTargetRatio)}. ${costs.assumption||'Conditional estimates; execution costs are not guaranteed.'}`:'Execution costs are not verified for this preview.';
  const market=result.market,deployment=result.deployment;
  const venue=previewVenueText(result.venue);
  $('#riskPreviewVenue').textContent=[deployment?`Deployment: ${deployment.id} · State: ${deployment.state} · Snapshot: ${deployment.snapshotHash||'unknown'} · Evidence: ${deployment.evidenceHash||'unknown'}`:null,market?`Market: ${market.broker} ${market.symbol} ${market.timeframe} · Bar: ${market.barTime} · Source hash: ${market.contentHash||'unknown'}`:null,venue].filter(Boolean).join(' · ');
  const conflicts=(result.consistency?.issues||[]).map(issue=>`Policy conflict (${issue.field}): ${readinessMeaning(issue.code)}`);
  const limits=[...new Set([...(result.readiness?.reasons||[]),...(result.limitations||[])])].map(readinessMeaning);
  $('#riskPreviewReason').textContent=[calculation.reason,order?.sizingAdjustment?'Order size is capped by saved limits.':null,...conflicts,...limits,capacity.remainingDailyExecutions!=null?'Daily execution allowance counts entries and exits; it does not guarantee future BUY orders.':null,capacity.allocationLimitEnforced===false?'Separate allocation limits are not enforced.':null].filter(Boolean).join(' · ');
}
// The {signal} or {bridge} half of an Order Preview request, read from the Order Preview fields. null when the form cannot build one
// (not signed in, legacy money format, or a generic BUY without entry and Stop Loss). previewRisk and the PF-4 sizing preview share it.
function riskPreviewRequest(){
  if(!authenticated||!me||me.moneyFormat!=='decimal-string')return null;
  const f=$('#riskForm').elements,entry=f.previewEntry.value,stopLoss=f.previewStopLoss.value,side=f.previewSide.value;
  if(f.previewSource.value!=='BRIDGE'&&side==='BUY'&&!(entry>0&&stopLoss>0))return null;
  const signal={account_type:'SPOT',trade_id:'preview-'+Date.now(),broker:f.previewBroker.value,symbol:f.previewSymbol.value,event:side,order_type:'MARKET',risk_mode:f.previewSizeMode.value,risk_value:f.previewRiskPercent.value,timestamp:Date.now(),reduce_only:side==='SELL'};
  if(entry!=='')signal.entry=entry;if(stopLoss!=='')signal.sl=stopLoss;
  if(f.previewSizeMode.value==='QUANTITY')signal.quantity=f.previewRiskPercent.value;
  if(f.previewTargetTradeId.value.trim())signal.target_trade_id=f.previewTargetTradeId.value.trim();
  if(f.previewVolatilityPercent.value!=='')signal.volatility_percent=Number(f.previewVolatilityPercent.value);
  if(f.previewNewsRisk.value!=='')signal.news_risk=f.previewNewsRisk.value==='true';
  if(f.previewSource.value==='BRIDGE'){
    const intent={deployment_id:f.previewDeploymentId.value.trim(),bar_time:Number(f.previewBarTime.value),event_type:f.previewBridgeEvent.value};
    if(intent.event_type==='EXIT'){intent.entry_ref=f.previewEntryRef.value.trim();intent.reason=f.previewExitReason.value;}
    return {bridge:intent};
  }
  return {signal};
}
async function previewRisk(){
  if(!authenticated||!me)return;
  const f=$('#riskForm').elements,entry=me.moneyFormat==='decimal-string'?f.previewEntry.value:+f.previewEntry.value,stopLoss=me.moneyFormat==='decimal-string'?f.previewStopLoss.value:+f.previewStopLoss.value;
  if(me.moneyFormat!=='decimal-string')updatePositionSlots();
  const saved=me.moneyFormat==='decimal-string',side=f.previewSide.value,bridge=saved&&f.previewSource.value==='BRIDGE';
  if(!saved&&(side!=='BUY'||f.previewSizeMode.value!=='PERCENT_EQUITY')){invalidateRiskPreview();$('#riskPreviewReason').textContent='Legacy preview supports BUY percent-equity only.';return;}
  if(!bridge&&(!saved||side==='BUY')&&!(entry>0&&stopLoss>0)){invalidateRiskPreview();$('#riskPreviewStatus').textContent=translate('Enter price and Stop Loss');return;}
  const sequence=++riskPreviewSequence,botScope=selectedBot;$('#riskPreviewStatus').textContent=translate('Checking…');
  try{
    if(saved){
      const body=riskPreviewRequest();
      if(f.previewAuthority.value==='DRAFT')body.scenario={policy:collectRiskPolicy(),capital:{cash:f.previewCash.value,bookEquity:f.previewBookEquity.value}};
      const result=await api('/api/risk/readiness',{method:'POST',silent:true,body:JSON.stringify(body)});
      if(sequence!==riskPreviewSequence||botScope!==selectedBot)return;
      renderSavedRiskPreview(result);return;
    }
    const result=await api('/api/risk/preview',{method:'POST',silent:true,body:JSON.stringify({policy:collectRiskPolicy(),calculator:{broker:f.previewBroker.value,symbol:f.previewSymbol.value,entry,stopLoss,riskPercent:+f.previewRiskPercent.value,...(f.previewVolatilityPercent.value!==''?{volatilityPercent:+f.previewVolatilityPercent.value}:{})}})});
    if(sequence!==riskPreviewSequence||botScope!==selectedBot)return;
    $('#riskPreviewStatus').textContent='Hypothetical draft — '+translate(result.ok?'Likely accepted':'Would be rejected');
    $('#riskPreviewStatus').className='preview-badge '+(result.ok?'ok':'bad');
    $('#previewRisk').textContent=result.ok?fmt(result.order.quantity*Math.abs(result.order.price-result.order.stopLoss)):'—';
    $('#previewQuantity').textContent=result.ok?fmt(result.order.quantity):'—';
    $('#previewNotional').textContent=result.ok?fmt(result.order.notional):'—';
    $('#previewBalance').textContent=fmt(result.freeBalance);
    $('#previewSlots').textContent=`${result.positionsOpen} / ${result.positionsRemaining}`;
    $('#previewCapacity').textContent=result.ok?fmt(result.positionCapacity):'0';
    $('#previewCapacityLabel').textContent='Hypothetical positions this size';
    $('#riskPreviewProvenance').textContent='Legacy hypothetical sizing uses unsaved draft inputs. Server readiness is not verified. BUY percent-equity only.';
    $('#riskPreviewReason').textContent=result.ok?'Sizing estimate only. Venue, costs and Bridge readiness are not verified.':explainRejection(result.reason);
  }catch(error){if(sequence===riskPreviewSequence&&botScope===selectedBot){$('#riskPreviewStatus').textContent=translate('Check input');$('#riskPreviewStatus').className='preview-badge bad';$('#riskPreviewReason').textContent=error.message;}}
}
function renderAdmin(){$('#userCount').textContent=users.length;$('#licenseCount').textContent=licenses.length;$('#globalKillValue').textContent=me.globalKill?'ENTRIES PAUSED':'PAPER RUNNING';$('#userRows').innerHTML=users.map(u=>`<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.status)}</td><td>••••••${esc(u.webhook_hint||'-')}</td><td><button class="mini user-status" data-id="${esc(u.id)}" data-status="${u.status==='ACTIVE'?'SUSPENDED':'ACTIVE'}">Toggle</button></td></tr>`).join('');$('#licenseRows').innerHTML=licenses.map(l=>`<tr><td>••••••${esc(l.key_hint)}</td><td>${esc(l.plan)}</td><td>${esc(l.email||'-')}</td><td>${esc(l.status)}</td><td>${new Date(l.expires_at).toLocaleDateString()}</td><td><button class="mini license-status" data-id="${esc(l.id)}" data-status="${l.status==='SUSPENDED'?'ACTIVE':'SUSPENDED'}">Toggle</button></td></tr>`).join('');document.querySelectorAll('.user-status').forEach(b=>b.onclick=()=>changeStatus('users',b));document.querySelectorAll('.license-status').forEach(b=>b.onclick=()=>changeStatus('licenses',b));if(typeof renderAnalyticsUsers==='function')renderAnalyticsUsers();}
$('#loginBtn').onclick=login;
$('#password').addEventListener('keydown',event=>{
  // Returning false from an onkeydown property cancels native typing and deletion.
  // Leave editing, mobile keyboard composition and held keys to the browser.
  if(event.key!=='Enter'||event.isComposing||event.keyCode===229||event.repeat)return;
  event.preventDefault();
  login();
});
$('#logout').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}authenticated=false;csrfToken='';location.reload();};$('#refresh').onclick=()=>{load();if(!document.querySelector('[data-page="analytics"]').hidden&&typeof loadAnalytics==='function')loadAnalytics();};document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('[data-page]').forEach(x=>x.hidden=x.dataset.page!==b.dataset.view);$('#pageTitle').textContent=b.textContent;if(b.dataset.view==='analytics'&&typeof loadAnalytics==='function'){if(typeof renderAnalyticsUsers==='function')renderAnalyticsUsers();loadAnalytics();}});
$('#riskForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/risk',{method:'PUT',body:JSON.stringify(collectRiskPolicy())});window._riskDirty=false;$('#riskMessage').textContent=translate('Saved');load();}catch(x){$('#riskMessage').textContent=x.message;}};

function riskInputChanged(event){if(event.target.matches('input,select')){if(!event.target.name.startsWith('preview'))window._riskDirty=true;updatePreviewControls();scheduleRiskPreview();}}
$('#riskForm').addEventListener('input',riskInputChanged);
$('#riskForm').addEventListener('change',riskInputChanged);
$('#riskForm').addEventListener('keydown',event=>{
  if(event.key==='Enter'&&event.target.name?.startsWith('preview')){event.preventDefault();previewRisk();}
});
$('#botSwitcher').addEventListener('change',()=>{const f=$('#riskForm').elements;f.previewDeploymentId.value='';f.previewEntryRef.value='';f.previewCash.value='';f.previewBookEquity.value='';f.previewAuthority.value='SAVED';updatePreviewControls();invalidateRiskPreview();},true);
$('#previewRefreshVenue').onclick=async()=>{
  const f=$('#riskForm').elements,bridge=f.previewSource.value==='BRIDGE';
  if(!bridge&&f.previewBroker.value!=='binance-global')return;
  invalidateRiskPreview();const sequence=riskPreviewSequence,botScope=selectedBot;
  $('#riskPreviewVenue').textContent='Refreshing venue metadata…';
  try{
    const result=await api('/api/risk/venue-refresh',{method:'POST',silent:true,body:JSON.stringify({symbol:(bridge?f.previewBridgeSymbol.value:f.previewSymbol.value).trim()})});
    if(sequence!==riskPreviewSequence||botScope!==selectedBot)return;
    $('#riskPreviewVenue').textContent=previewVenueText(result.venue||result)+' Preview needs checking again.';
  }catch(error){if(sequence===riskPreviewSequence&&botScope===selectedBot)$('#riskPreviewVenue').textContent=error.message;}
};
// Lock / unlock risk form inputs while bot is active (RUNNING, PAUSED, STOPPED)
function lockRiskForm(locked){
  const f=$('#riskForm');
  if(!f)return;
  const fields=f.querySelectorAll('input:not([name="paperTrading"]):not([name="requireReduceOnlySell"]):not([name^="preview"]),select:not([name^="preview"]),textarea');
  fields.forEach(el=>{el.disabled=locked;});
  const saveBtn=f.querySelector('button[type="submit"],button.primary:not([data-preview])');
  if(saveBtn)saveBtn.disabled=locked;
  const notice=f.querySelector('#riskLockNotice');
  if(locked&&!notice){const n=document.createElement('p');n.id='riskLockNotice';n.className='warn';n.textContent=translate('Bot is running');n.style.cssText='color:#ffd36b;font-size:12px;margin:8px 0';f.insertBefore(n,f.firstChild);}
  else if(!locked&&notice)notice.remove();
}
$('#brokerForm').onsubmit=async e=>{e.preventDefault();try{await api(`/api/brokers/${$('#brokerName').value}`,{method:'PUT',body:JSON.stringify({credentials:JSON.parse($('#brokerCredentials').value),enabled:$('#brokerEnabled').checked})});$('#brokerCredentials').value='';$('#brokerMessage').textContent='เข้ารหัสและบันทึกแล้ว';load();}catch(x){$('#brokerMessage').textContent=x.message;}};$('#rotateSecret').onclick=async()=>{if(!confirm(translate('The previous secret will stop working. Continue?')))return;const d=await api('/api/me/webhook-secret',{method:'POST'});webhook=d;renderWebhook();load();};$('#licenseForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/me/license/redeem',{method:'POST',body:JSON.stringify({licenseKey:$('#licenseKey').value})});$('#licenseMessage').textContent='เปิดใช้งานแล้ว';load();}catch(x){$('#licenseMessage').textContent=x.message;}};
$('#createUserForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({email:$('#newUserEmail').value,password:$('#newUserPassword').value,role:$('#newUserRole').value})});$('#userMessage').textContent='สร้างแล้ว';load();}catch(x){$('#userMessage').textContent=x.message;}};$('#createLicenseForm').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/admin/licenses',{method:'POST',body:JSON.stringify({plan:$('#newLicensePlan').value,days:+$('#newLicenseDays').value})});$('#newLicenseResult').textContent=d.key;load();}catch(x){$('#newLicenseResult').textContent=x.message;}};$('#globalKillToggle').onclick=async()=>{try{await api('/api/admin/global-kill',{method:'POST',body:JSON.stringify({enabled:!me.globalKill})});await load();}catch(error){$('#adminStatus').textContent=error.message;}};async function changeStatus(kind,b){try{await api(`/api/admin/${kind}/${b.dataset.id}/status`,{method:'PUT',body:JSON.stringify({status:b.dataset.status})});await load();}catch(error){$('#adminStatus').textContent=error.message;}}
document.querySelector('#signalRows').addEventListener('click',async event=>{
  const button=event.target.closest('.save-note');if(!button)return;
  const cell=button.closest('td'),input=cell.querySelector('textarea'),error=cell.querySelector('.note-error');
  button.disabled=true;error.textContent='';
  try{await api('/api/signals/'+button.dataset.id+'/note',{method:'PUT',body:JSON.stringify({note:input.value})});const row=signals.find(x=>String(x.id)===button.dataset.id);if(row)row.review_note=input.value.trim();}
  catch(e){error.textContent=e.message;}finally{button.disabled=false;}
});
$('#copyWebhook').onclick=async()=>{
  const input=$('#webhookResult');if(!input.value)return;
  try{await navigator.clipboard.writeText(input.value);$('#webhookStatus').textContent=translate('Copied');}
  catch{input.focus();input.select();$('#webhookStatus').textContent=translate('Select the URL and copy it with Ctrl+C or Command+C.');}
};
$('#recoverWebhookForm').onsubmit=async event=>{
  event.preventDefault();
  try{webhook=await api('/api/me/webhook-secret',{method:'PUT',body:JSON.stringify({url:$('#existingWebhook').value})});$('#existingWebhook').value='';renderWebhook();}
  catch(error){$('#webhookStatus').textContent=error.message;}
};
