const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmt=v=>new Intl.NumberFormat('en-US',{maximumSignificantDigits:10}).format(v||0);let token=sessionStorage.getItem('astraV2Token')||'',me,webhook={},signals=[],positions=[],users=[],licenses=[];
async function api(path,o={}){const {silent=false,...request}=o,r=await fetch(path,{...request,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} :{}),...(request.headers||{})}}),d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');if(!silent&&request.method&&request.method!=='GET'&&!path.startsWith('/api/auth/'))showSaved();return d;}
async function login(){try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:$('#email').value,password:$('#password').value})});token=d.token;sessionStorage.setItem('astraV2Token',token);load();}catch(e){$('#loginError').textContent=e.message;}}
async function load(){try{[me,signals,positions,webhook]=await Promise.all([api('/api/me'),api('/api/signals?limit=200'),api('/api/positions'),api('/api/me/webhook-secret')]);$('#login').hidden=true;$('#app').hidden=false;$('#logout').hidden=false;$('#serverDot').className='dot online';$('#serverText').textContent=me.user.email;render();if(me.user.role==='ADMIN'){$('#adminNav').hidden=false;[users,licenses]=await Promise.all([api('/api/admin/users'),api('/api/admin/licenses')]);renderAdmin();}}catch(e){token='';sessionStorage.removeItem('astraV2Token');$('#login').hidden=false;$('#app').hidden=true;$('#loginError').textContent=e.message;}}
function render(){const p=me.risk,l=me.license||{};$('#modeValue').textContent='PAPER · LIVE LOCKED';$('#killValue').textContent=me.globalKill||p.killSwitch?'ENTRIES PAUSED':'PAPER RUNNING';$('#licenseValue').textContent=l.status||'NONE';$('#licenseExpiry').textContent=l.expires_at?new Date(l.expires_at).toLocaleDateString():'';$('#tradesValue').textContent=me.daily.trades;$('#dailyStats').textContent=(me.dailyAccounts||[]).map(x=>`${x.account_id}: ${fmt(x.notional)} · ${fmt(x.realized_r)}R · streak ${x.loss_streak}`).join(' | ')||'UTC · แยกยอดตามบัญชี';$('#recentSignals').innerHTML=signals.slice(0,8).map(x=>`<div class="list-row"><span>${esc(x.symbol)} <small>${esc(x.event)} · ${esc(x.broker)} · ${esc(x.execution_mode||'LEGACY')}</small><time datetime="${new Date(x.received_at).toISOString()}" title="${esc(new Date(x.received_at).toISOString())}">${esc(new Date(x.received_at).toLocaleString())}</time></span><span class="pill ${esc(x.status)}">${esc(x.status)}</span></div>`).join('')||'<p>ยังไม่มี Signal</p>';$('#positions').innerHTML=positions.map(x=>`<div class="list-row"><span>${esc(x.symbol)} <small>${esc(x.broker)} · ${esc(x.execution_mode||'LEGACY')}</small></span><span>${fmt(x.quantity)} @ ${fmt(x.avg_price)}</span></div>`).join('')||'<p>ยังไม่มี Position</p>';renderSignals();renderWebhook();fillRisk(p);$('#accountInfo').innerHTML=`<p><strong>${esc(me.user.email)}</strong><br>${esc(me.user.role)} · ${esc(me.user.status)}<br>Webhook: ••••••${esc(me.user.webhook_hint||'-')}</p>`;const set=new Map(me.brokers.map(x=>[x.broker,x]));$('#brokerList').innerHTML=['binance-global','binance-th','innovestx','mt5','settrade','future-http'].map(b=>`<div class="list-row"><span>${b}</span><span>${set.has(b)?(set.get(b).enabled?'SAVED · LIVE LOCKED':'DISABLED'):'NOT SET'}</span></div>`).join('');}
function renderSignals(){
  $('#signalRows').innerHTML=signals.map(x=>`<tr>
    <td><time datetime="${new Date(x.received_at).toISOString()}">${esc(new Date(x.received_at).toLocaleString())}</time></td>
    <td><strong>${esc(x.symbol)}</strong><small>${esc(x.event)} · ${esc(x.timeframe||'-')}</small></td>
    <td><span class="pill ${esc(x.status)}">${esc(x.status)}</span></td>
    <td>${x.status==='REJECTED'?`<p class="rejection-help" data-rejection="${esc(x.error_message||'')}">${esc(explainRejection(x.error_message))}</p><small class="raw-reason">${esc(x.error_message||'')}</small>`:'—'}</td>
    <td><details><summary data-ui-label="Details / Notes">${esc(translate('Details / Notes'))}</summary><dl class="order-details">
    <dt>Trade ID</dt><dd>${esc(x.trade_id)}</dd><dt>User</dt><dd>${esc(x.user_id)}</dd>
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
  const f=$('#riskForm').elements;
  for(const k of riskMaxFields)f[k].value=p[k];
  for(const[input,key]of Object.entries(riskDefaultsMap))f[input].value=p.defaults?.[key]??p[({riskPercent:'maxRiskPercent',tradesPerDay:'maxTradesPerDay',dailyLossR:'maxDailyLossR',lossStreak:'pauseAfterLossStreak',openPositions:'maxOpenPositions',signalAgeSeconds:'maxSignalAgeSeconds',orderNotional:'maxOrderNotional',dailyNotional:'maxDailyNotional',volatilityPercent:'maxVolatilityPercent'})[key]];
  for(const k of riskBooleanFields)f[k].checked=!!p[k];
  f.paperTrading.checked=true;f.paperTrading.disabled=true;f.requireReduceOnlySell.checked=true;f.requireReduceOnlySell.disabled=true;
  f.sideMode.value=p.sideMode;f.allowedSymbols.value=(p.allowedSymbols||[]).join(',');
  for(const[equityInput,balanceInput,broker]of fundFields){const equity=p.equities?.[broker]||0;f[equityInput].value=equity;f[balanceInput].value=p.balances?.[broker]??equity;}
  if(!f.previewRiskPercent.value)f.previewRiskPercent.value=p.defaults?.riskPercent??1;
  if(!f.previewVolatilityPercent.value)f.previewVolatilityPercent.value=p.defaults?.volatilityPercent??0;
  updatePositionSlots();scheduleRiskPreview();
}
function collectRiskPolicy(){
  const f=$('#riskForm').elements,n=k=>+f[k].value,p={defaults:{},equities:{},balances:{}};
  for(const k of riskMaxFields)p[k]=n(k);
  for(const[input,key]of Object.entries(riskDefaultsMap))p.defaults[key]=n(input);
  for(const k of riskBooleanFields)p[k]=f[k].checked;
  p.sideMode=f.sideMode.value;p.allowedSymbols=f.allowedSymbols.value.split(',').map(x=>x.trim().toUpperCase()).filter(Boolean);
  for(const[equityInput,balanceInput,broker]of fundFields){p.equities[broker]=n(equityInput);p.balances[broker]=n(balanceInput);}
  return p;
}
function updatePositionSlots(){
  if(!me)return;
  const f=$('#riskForm').elements,broker=f.previewBroker.value,open=positions.filter(x=>x.user_id===me.user.id&&x.broker===broker&&x.execution_mode==='PAPER').length,max=+f.maxOpenPositions.value||0;
  $('#previewSlots').textContent=`${open} / ${Math.max(0,max-open)}`;
}
let riskPreviewTimer,riskPreviewSequence=0;
function scheduleRiskPreview(){clearTimeout(riskPreviewTimer);riskPreviewTimer=setTimeout(previewRisk,250);}
async function previewRisk(){
  if(!token||!me)return;
  const f=$('#riskForm').elements,entry=+f.previewEntry.value,stopLoss=+f.previewStopLoss.value;
  updatePositionSlots();
  if(!(entry>0&&stopLoss>0)){ $('#riskPreviewStatus').textContent=translate('Enter price and Stop Loss');$('#riskPreviewReason').textContent='';return; }
  const sequence=++riskPreviewSequence;$('#riskPreviewStatus').textContent=translate('Checking…');
  try{
    const result=await api('/api/risk/preview',{method:'POST',silent:true,body:JSON.stringify({policy:collectRiskPolicy(),calculator:{broker:f.previewBroker.value,symbol:f.previewSymbol.value,entry,stopLoss,riskPercent:+f.previewRiskPercent.value,volatilityPercent:+f.previewVolatilityPercent.value}})});
    if(sequence!==riskPreviewSequence)return;
    $('#riskPreviewStatus').textContent=translate(result.ok?'Likely accepted':'Would be rejected');
    $('#riskPreviewStatus').className='preview-badge '+(result.ok?'ok':'bad');
    $('#previewRisk').textContent=result.ok?fmt(result.order.quantity*Math.abs(result.order.price-result.order.stopLoss)):'—';
    $('#previewQuantity').textContent=result.ok?fmt(result.order.quantity):'—';
    $('#previewNotional').textContent=result.ok?fmt(result.order.notional):'—';
    $('#previewBalance').textContent=fmt(result.freeBalance);
    $('#previewSlots').textContent=`${result.positionsOpen} / ${result.positionsRemaining}`;
    $('#previewCapacity').textContent=result.ok?fmt(result.positionCapacity):'0';
    $('#riskPreviewReason').textContent=result.ok?(result.order.sizingAdjustment?translate('Order size will be reduced to remain within available funds and limits.'):translate('All current checks passed.')):explainRejection(result.reason);
  }catch(error){if(sequence===riskPreviewSequence){$('#riskPreviewStatus').textContent=translate('Check input');$('#riskPreviewStatus').className='preview-badge bad';$('#riskPreviewReason').textContent=error.message;}}
}
function renderAdmin(){$('#userCount').textContent=users.length;$('#licenseCount').textContent=licenses.length;$('#globalKillValue').textContent=me.globalKill?'ENTRIES PAUSED':'PAPER RUNNING';$('#userRows').innerHTML=users.map(u=>`<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(u.status)}</td><td>••••••${esc(u.webhook_hint||'-')}</td><td><button class="mini user-status" data-id="${esc(u.id)}" data-status="${u.status==='ACTIVE'?'SUSPENDED':'ACTIVE'}">Toggle</button></td></tr>`).join('');$('#licenseRows').innerHTML=licenses.map(l=>`<tr><td>••••••${esc(l.key_hint)}</td><td>${esc(l.plan)}</td><td>${esc(l.email||'-')}</td><td>${esc(l.status)}</td><td>${new Date(l.expires_at).toLocaleDateString()}</td><td><button class="mini license-status" data-id="${esc(l.id)}" data-status="${l.status==='SUSPENDED'?'ACTIVE':'SUSPENDED'}">Toggle</button></td></tr>`).join('');document.querySelectorAll('.user-status').forEach(b=>b.onclick=()=>changeStatus('users',b));document.querySelectorAll('.license-status').forEach(b=>b.onclick=()=>changeStatus('licenses',b));if(typeof renderAnalyticsUsers==='function')renderAnalyticsUsers();}
$('#loginBtn').onclick=login;$('#password').onkeydown=e=>e.key==='Enter'&&login();$('#logout').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});}catch{}sessionStorage.clear();location.reload();};$('#refresh').onclick=()=>{load();if(!document.querySelector('[data-page="analytics"]').hidden&&typeof loadAnalytics==='function')loadAnalytics();};document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('[data-page]').forEach(x=>x.hidden=x.dataset.page!==b.dataset.view);$('#pageTitle').textContent=b.textContent;if(b.dataset.view==='analytics'&&typeof loadAnalytics==='function'){if(typeof renderAnalyticsUsers==='function')renderAnalyticsUsers();loadAnalytics();}});
$('#riskForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/risk',{method:'PUT',body:JSON.stringify(collectRiskPolicy())});$('#riskMessage').textContent=translate('Saved');load();}catch(x){$('#riskMessage').textContent=x.message;}};
$('#riskForm').addEventListener('input',event=>{if(event.target.matches('input,select'))scheduleRiskPreview();});
$('#riskForm').addEventListener('change',event=>{if(event.target.matches('input,select'))scheduleRiskPreview();});
$('#brokerForm').onsubmit=async e=>{e.preventDefault();try{await api(`/api/brokers/${$('#brokerName').value}`,{method:'PUT',body:JSON.stringify({credentials:JSON.parse($('#brokerCredentials').value),enabled:$('#brokerEnabled').checked})});$('#brokerCredentials').value='';$('#brokerMessage').textContent='เข้ารหัสและบันทึกแล้ว';load();}catch(x){$('#brokerMessage').textContent=x.message;}};$('#rotateSecret').onclick=async()=>{if(!confirm(translate('The previous secret will stop working. Continue?')))return;const d=await api('/api/me/webhook-secret',{method:'POST'});webhook=d;renderWebhook();load();};$('#licenseForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/me/license/redeem',{method:'POST',body:JSON.stringify({licenseKey:$('#licenseKey').value})});$('#licenseMessage').textContent='เปิดใช้งานแล้ว';load();}catch(x){$('#licenseMessage').textContent=x.message;}};
$('#createUserForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/users',{method:'POST',body:JSON.stringify({email:$('#newUserEmail').value,password:$('#newUserPassword').value,role:$('#newUserRole').value})});$('#userMessage').textContent='สร้างแล้ว';load();}catch(x){$('#userMessage').textContent=x.message;}};$('#createLicenseForm').onsubmit=async e=>{e.preventDefault();try{const d=await api('/api/admin/licenses',{method:'POST',body:JSON.stringify({plan:$('#newLicensePlan').value,days:+$('#newLicenseDays').value})});$('#newLicenseResult').textContent=d.key;load();}catch(x){$('#newLicenseResult').textContent=x.message;}};$('#globalKillToggle').onclick=async()=>{await api('/api/admin/global-kill',{method:'POST',body:JSON.stringify({enabled:!me.globalKill})});load();};async function changeStatus(kind,b){await api(`/api/admin/${kind}/${b.dataset.id}/status`,{method:'PUT',body:JSON.stringify({status:b.dataset.status})});load();}if(token)load();
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
