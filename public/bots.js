// ─── Helpers ────────────────────────────────────────────────────────────────
const botT = (en, th) => uiLanguage === 'th' ? th : en;

// ─── State ──────────────────────────────────────────────────────────────────
let maxBots = 5;
let botSessions = {};      // { [botId]: { state, run_id, started_at, stopped_at } }
let accountSnapshots = {}; // { [botId]: { accounts: [], ts: number } }
let lifecyclePending = {}; // { [botId]: boolean } — block duplicate submissions

let pollTimer = null;
let pollActiveBotId = null;
let pollSequence = 0;      // detect stale poll responses

// ─── Polling ─────────────────────────────────────────────────────────────────
function startPolling(botId) {
  stopPolling();
  pollActiveBotId = botId;
  const seq = ++pollSequence;
  pollTimer = setInterval(async () => {
    if (pollSequence !== seq) return; // cancelled
    if (document.hidden) return;      // skip hidden tab
    await refreshBotAccounts(botId, seq);
  }, 4000);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  pollActiveBotId = null;
}

// Resume poll on tab visibility
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollActiveBotId) {
    refreshBotAccounts(pollActiveBotId, pollSequence);
  }
});

async function refreshBotAccounts(botId, seq) {
  try {
    const session = await api('/api/bot/session', { botId, silent: true });
    if (pollSequence !== seq) return; // bot switched
    botSessions[botId] = session;
    // paperAccounts come from /api/me — re-fetch lightweight
    const me2 = await api('/api/me', { botId, silent: true });
    if (pollSequence !== seq) return;
    accountSnapshots[botId] = { accounts: me2.paperAccounts || [], ts: Date.now() };
    updateAccountCards(botId);
    updateTCPButtons(botId);
  } catch { /* silent — mark stale on next render */ }
}

// ─── Main refresh ─────────────────────────────────────────────────────────────
async function refreshBots() {
  if (!authenticated) return;
  try {
    const result = await api('/api/bots');
    botProfiles = result.bots;
    maxBots = result.maxBots || 1;
    // Parallel session fetch
    const sessions = await Promise.all(
      botProfiles.map(bot => api('/api/bot/session', { botId: bot.id, silent: true })
        .catch(() => ({ state: 'SETUP', run_id: null }))
      )
    );
    botProfiles.forEach((bot, i) => { botSessions[bot.id] = sessions[i]; });
    renderBots();
    // Resume polling for any RUNNING bot
    const running = botProfiles.find(b => botSessions[b.id]?.state === 'RUNNING');
    if (running && running.id !== pollActiveBotId) startPolling(running.id);
    else if (!running) stopPolling();
  } catch (err) { $('#botMessage').textContent = err.message; }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderBots() {
  const current = selectedBot || me?.user?.id || botProfiles[0]?.id;
  $('#botSwitcher').innerHTML =
    botProfiles.map(bot => `<option value="${esc(bot.id)}">${bot.bot_slot_index}. ${esc(bot.label)}</option>`).join('') +
    `<option value="all">${translate('All Bots')}</option>`;
  $('#botSwitcher').value = current;

  if (maxBots > 10) $('#botSlots').classList.add('enterprise-grid');
  else $('#botSlots').classList.remove('enterprise-grid');

  if (selectedBot === 'all') {
    renderAllBotsCard();
    return;
  }

  const bot = botProfiles.find(row => row.id === current);
  if (!bot) {
    $('#botSlots').innerHTML = `<p class="error">${translate('Select one bot for this operation')}</p>`;
    return;
  }
  $('#botSlots').innerHTML = renderBotCard(bot);
  $('#botScopeNotice').textContent = `${translate('Settings and webhook apply to the selected bot.')} ${bot.label}`;
}

function renderAllBotsCard() {
  const totalEquity = (me?.paperAccounts || []).reduce((sum, a) => sum + parseFloat(a.bookEquity || 0), 0);
  const dailyPnl = (me?.dailyAccounts || []).reduce((sum, a) => sum + (a.realized_r || 0), 0);
  const pnlPos = dailyPnl >= 0;
  $('#botSlots').innerHTML = `<article class="all-bots-card panel">
    <div class="all-bots-header">
      <span class="all-bots-title">${translate('All Bots')}</span>
      <span class="all-bots-readonly-badge">${translate('Read-Only')}</span>
    </div>
    <div class="all-bots-stat"><span>${translate('Total portfolio value')}</span>
      <strong>${fmt(totalEquity)}</strong></div>
    <div class="all-bots-pnl ${pnlPos ? 'positive-text' : 'negative-text'}">
      ${translate('Combined daily P/L')}: ${pnlPos ? '+' : ''}${fmt(dailyPnl)} R
    </div>
    <p class="muted" style="margin-top:10px;font-size:12px">${translate('All Bots: overview and trade log only. Select a bot to edit settings.')}</p>
  </article>`;
  $('#botScopeNotice').textContent = translate('All Bots: overview and trade log only. Select a bot to edit settings.');
}

function renderBotCard(bot) {
  const session = botSessions[bot.id] || { state: 'SETUP' };
  const state = session.state || 'SETUP';
  const stateClass = { SETUP: 'state-setup', RUNNING: 'state-running', PAUSED: 'state-paused', STOPPED: 'state-stopped' }[state] || 'state-setup';
  const stateLabel = translate(state);
  const mode = me?.risk?.paperTrading !== false ? 'PAPER' : 'LIVE';
  const modeClass = mode === 'LIVE' ? 'mode-live' : 'mode-paper';

  // Account cards from snapshot or me.paperAccounts
  const accts = (accountSnapshots[bot.id]?.accounts || me?.paperAccounts || [])
    .filter(a => a.bot_id === bot.id || (!a.bot_id && bot.id === (me?.bot?.id || me?.user?.id)));
  const ts = accountSnapshots[bot.id]?.ts;
  const ageStr = ts ? relativeTime(ts) : '';
  const stale = ts && (Date.now() - ts > 30000);

  // Risk summary
  const risk = me?.risk || {};
  const cap = risk.maxRiskPercent ? `${risk.maxRiskPercent}%` : '—';
  const pertrade = risk.defaults?.riskPercent ? `${risk.defaults.riskPercent}%` : '—';
  const dailyloss = risk.maxDailyLossR ? `-${risk.maxDailyLossR}R` : '—';

  return `<article class="panel bot-card" data-bot-card="${esc(bot.id)}">
    <div class="bot-card-header">
      <div class="bot-card-icon" aria-hidden="true">🤖</div>
      <div class="bot-card-title">
        <div class="bot-card-name">${esc(bot.label)}</div>
        <div class="bot-card-badges">
          <span class="state-badge ${stateClass}">${stateLabel}</span>
          <span class="mode-badge ${modeClass}">${translate(mode)}</span>
        </div>
      </div>
      <button class="mini" data-bot-save="${esc(bot.id)}" title="${translate('Save')}" style="margin-left:auto">✏️</button>
    </div>

    <div class="account-cards-row" id="acct-${esc(bot.id)}">
      ${accts.length?accts.flatMap(acct=>[renderAccountCard('EQUITY',acct,stale),renderAccountCard('BALANCE',acct,stale)]).join(''):renderAccountCard('EQUITY',null,stale)+renderAccountCard('BALANCE',null,stale)}
    </div>

    ${renderTCP(bot, session, risk)}

    <div class="risk-summary-row">
      <div class="risk-summary-items">
        <span>${translate('Capital')}: <span class="risk-summary-item"><span>${cap}</span></span></span>
        <span>${translate('Per-trade')}: <span class="risk-summary-item"><span>${pertrade}</span></span></span>
        <span>${translate('Daily Loss')}: <span class="risk-summary-item"><span>${dailyloss}</span></span></span>
      </div>
      <button class="risk-edit-btn" data-bot-open="${esc(bot.id)}" title="${translate('Save')}">⚙</button>
    </div>

    <label style="display:none">${botT('Label', 'ชื่อ Bot')}<input data-bot-label="${esc(bot.id)}" maxlength="80" value="${esc(bot.label)}"></label>
    <div class="bot-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" class="mini" data-bot-copy="${esc(bot.id)}">${translate('Copy webhook')}</button>
      <button type="button" class="mini" data-bot-open="${esc(bot.id)}">${botT('Open', 'เปิด')}</button>
    </div>
  </article>`;
}

function renderAccountCard(type, acct, stale) {
  const label = translate(type); // EQUITY or BALANCE
  const amount = acct ? fmt(type === 'EQUITY' ? acct.bookEquity : acct.cash) : '—';
  const currency = acct?.currency || '';
  const broker = acct?.broker || '';
  const iconClass = stale ? 'warn' : 'ok';
  const icon = stale ? '⚠' : '✓';
  return `<div class="account-card${stale ? ' stale' : ''}" data-acct-type="${type}" data-account-key="${esc(acct?.broker||'none')}">
    <div class="account-card-label">
      <span class="account-card-status-icon ${iconClass}">${icon}</span>${label}
    </div>
    <div class="account-card-amount" data-acct-amount>${amount}<span class="account-card-currency">${esc(currency)}</span></div>
    <div class="account-card-meta">
      <span class="account-card-broker">${esc(broker)}</span>
      ${acct ? `<span class="account-card-age" data-acct-ts="${Date.now()}">${translate('just now')}</span>` : ''}
    </div>
  </div>`;
}

function renderTCP(bot, session, risk) {
  const state = session.state || 'SETUP';
  const pending = lifecyclePending[bot.id];
  const { ready, reason } = runReadiness(state, risk);
  const lockedThreshold = Number(session.locked_pause_after_loss_streak);
  const rearmAccounts = state === 'STOPPED' ? (session.loss_streaks || []).filter(row =>
    row.account_id?.endsWith(':primary') && lockedThreshold > 0 && Number(row.loss_streak) >= lockedThreshold
  ) : [];

  // Button availability
  const avail = {
    SETUP:   { run: ready, pause: false, stop: false, reset: false },
    RUNNING: { run: false, pause: true,  stop: true,  reset: false },
    PAUSED:  { run: true,  pause: false, stop: true,  reset: false },
    STOPPED: { run: false, pause: false, stop: false, reset: true  },
  }[state] || { run: false, pause: false, stop: false, reset: false };

  // Disabled reasons
  const disabledReason = {
    run:   !avail.run   ? (state === 'SETUP' ? reason || translate('Save and fix settings to run') : translate('Bot is running')) : '',
    pause: !avail.pause ? translate(state === 'SETUP' ? 'Not available in SETUP state' : state === 'STOPPED' ? 'Not available in STOPPED state' : 'Not available while running') : '',
    stop:  !avail.stop  ? translate(state === 'SETUP' ? 'Not available in SETUP state' : 'Not available in STOPPED state') : '',
    reset: !avail.reset ? translate(state === 'RUNNING' ? 'Not available while running' : state === 'PAUSED' ? 'Not available while paused' : 'Not available in SETUP state') : '',
  };

  const btn = (action, labelEn, labelTh, icon, extraClass) => {
    const enabled = avail[action] && !pending;
    return `<button type="button"
      class="tcp-btn tcp-btn--${action}${pending ? ' loading' : ''}"
      data-bot-lifecycle="${action}" data-bot-id="${esc(bot.id)}"
      ${enabled ? '' : 'disabled'}
      ${disabledReason[action] ? `title="${esc(disabledReason[action])}" aria-label="${esc(disabledReason[action])}"` : ''}
    ><span class="tcp-btn-icon">${icon}</span>
      <span class="tcp-btn-en">${translate(labelEn)}</span>
      <span class="tcp-btn-th">${uiLanguage === 'th' ? labelTh : ''}</span>
    </button>`;
  };

  // Status message
  let statusClass = 'info', statusMsg = '';
  if (pending) { statusClass = 'info'; statusMsg = translate('Loading…'); }
  else if (state === 'SETUP')   { statusClass = ready ? 'ready' : 'warn'; statusMsg = ready ? `✔ ${translate('Ready to start')} · ${translate('Connections verified')}` : `⚠ ${reason}`; }
  else if (state === 'RUNNING') { statusClass = 'ready'; statusMsg = `● ${translate('Bot is running')}`; }
  else if (state === 'PAUSED')  { statusClass = 'warn';  statusMsg = `⏸ ${translate('Bot is paused')}`; }
  else if (state === 'STOPPED') { statusClass = 'err';   statusMsg = `■ ${translate('Bot is stopped')}`; }

  return `<div class="trading-control-panel">
    <div class="tcp-header">
      <span class="tcp-title">${translate('Trading Control Panel')}</span>
    </div>
    <div class="tcp-buttons" role="group" aria-label="${translate('Trading Control Panel')}">
      ${btn('run',   'Run',   'รัน',       '▶', '')}
      ${btn('pause', 'Pause', 'พัก',       '⏸', '')}
      ${btn('stop',  'Stop',  'หยุดทันที', '⏹', '')}
      ${btn('reset', 'Reset', 'รีเซ็ต',   '↺', '')}
    </div>
    <div class="tcp-status ${statusClass}" role="status" aria-live="polite">${statusMsg}</div>
    ${rearmAccounts.map(row => {
      const broker = row.account_id.slice(0, -8);
      const waiting = row.has_today_activity;
      return `<button type="button" class="mini" data-bot-rearm="${esc(broker)}" data-bot-id="${esc(bot.id)}" ${pending || waiting ? 'disabled' : ''} title="${waiting ? esc(botT('Available next UTC day after account activity', 'ใช้ได้วัน UTC ถัดจากวันที่บัญชีมีรายการ')) : ''}">${botT('Review and re-arm entries', 'ตรวจแล้วเปิดรับ BUY ใหม่')} · ${esc(broker)} (${esc(row.loss_streak)}/${esc(lockedThreshold)})</button>`;
    }).join('')}
  </div>`;
}

// ─── Readiness check ─────────────────────────────────────────────────────────
function runReadiness(state, risk) {
  if (!['SETUP', 'PAUSED'].includes(state)) return { ready: false, reason: '' };
  if (window._riskDirty) return { ready: false, reason: translate('Unsaved changes — save first') };
  // Required fields
  const required = ['maxRiskPercent', 'maxTradesPerDay', 'maxDailyLossR', 'pauseAfterLossStreak', 'maxOpenPositions'];
  for (const k of required) {
    const v = risk?.[k];
    if (v == null || v === 0 || v === '') return { ready: false, reason: translate('Save settings first') };
  }
  // At least one broker funded
  const equities = risk?.equities || {};
  const funded = Object.values(equities).some(v => parseFloat(v) > 0);
  if (!funded) return { ready: false, reason: translate('Cannot start: no funded broker') };
  return { ready: true, reason: '' };
}

// ─── Account card live update (animation) ─────────────────────────────────────
function updateAccountCards(botId) {
  const card = document.querySelector(`[data-bot-card="${botId}"]`);
  if (!card) return;
  const snap = accountSnapshots[botId];
  if (!snap) return;
  const accts = snap.accounts.filter(a => a.bot_id === botId || !a.bot_id);
  const stale = Date.now() - snap.ts > 30000;

  accts.forEach(acct => ['EQUITY', 'BALANCE'].forEach(type => {
    const el = card.querySelector(`[data-acct-type="${type}"][data-account-key="${CSS.escape(acct.broker)}"] [data-acct-amount]`);
    if (!el) return;
    const newVal = fmt(type === 'EQUITY' ? acct.bookEquity : acct.cash);
    const currency = acct.currency || '';
    const oldText = el.textContent.trim();
    if (oldText !== newVal + currency) {
      el.textContent = newVal;
      const currEl = el.querySelector('.account-card-currency') || document.createElement('span');
      currEl.className = 'account-card-currency';
      currEl.textContent = currency;
      el.appendChild(currEl);
      el.classList.remove('value-flash');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('value-flash');
    }
    const cardEl = card.querySelector(`[data-acct-type="${type}"][data-account-key="${CSS.escape(acct.broker)}"]`);
    if (cardEl) cardEl.classList.toggle('stale', stale);
  }));
}

function updateTCPButtons(botId) {
  const card = document.querySelector(`[data-bot-card="${botId}"]`);
  if (!card) return;
  const session = botSessions[botId] || { state: 'SETUP' };
  const tcp = card.querySelector('.trading-control-panel');
  if (!tcp) return;
  // Re-render TCP section only
  const bot = botProfiles.find(b => b.id === botId);
  if (!bot) return;
  const newTCP = renderTCP(bot, session, me?.risk || {});
  tcp.outerHTML = newTCP;
}

function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return translate('just now');
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── Lifecycle confirm dialog ─────────────────────────────────────────────────
function confirmLifecycle(action, botName) {
  return new Promise(resolve => {
    const dialog = $('#lifecycleConfirmDialog');
    const title = $('#lifecycleConfirmTitle');
    const msg = $('#lifecycleConfirmMsg');
    const warning = $('#lifecycleConfirmWarning');
    const okBtn = $('#lifecycleConfirmOk');
    const cancelBtn = $('#lifecycleConfirmCancel');

    if (action === 'stop') {
      title.textContent = translate('Stop bot?');
      msg.innerHTML = `${translate('Stop bot?')} <strong>${esc(botName)}</strong>`;
      warning.textContent = translate('Stopping blocks all incoming signals, including protective exit signals. Open positions are NOT automatically closed.');
      warning.hidden = false;
      okBtn.textContent = translate('Yes, stop bot');
      okBtn.className = 'confirm-proceed danger';
    } else if (action === 'reset') {
      title.textContent = translate('Reset session?');
      msg.innerHTML = `${translate('Reset session?')} <strong>${esc(botName)}</strong>`;
      warning.textContent = translate('This archives the current session. Trade history, balances, and PnL are preserved. The bot returns to SETUP state.');
      warning.hidden = false;
      okBtn.textContent = translate('Yes, reset session');
      okBtn.className = 'confirm-proceed neutral';
    }

    cancelBtn.textContent = translate('Cancel');

    const cleanup = confirmed => {
      dialog.close();
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
      resolve(confirmed);
    };

    $('#lifecycleConfirmOk').addEventListener('click', () => cleanup(true), { once: true });
    $('#lifecycleConfirmCancel').addEventListener('click', () => cleanup(false), { once: true });
    dialog.addEventListener('cancel', () => cleanup(false), { once: true });
    dialog.showModal();
  });
}

// ─── Lifecycle action handler ─────────────────────────────────────────────────
$('#botSlots').onclick = async event => {
  const button = event.target.closest('button');
  if (!button) return;

  // Bot create
  if (button.dataset.botCreate) {
    button.disabled = true;
    try {
      await api('/api/bots', { method: 'POST', body: JSON.stringify({ label: `Bot ${button.dataset.botCreate}` }) });
      await refreshBots();
    } catch (err) { $('#botMessage').textContent = err.message; }
    finally { button.disabled = false; }
    return;
  }

  // Bot save label (hidden input pattern preserved)
  if (button.dataset.botSave) {
    const id = button.dataset.botSave;
    const labelInput = document.querySelector(`[data-bot-label="${id}"]`);
    if (!labelInput) return;
    button.disabled = true;
    try {
      await api('/api/bots/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ label: labelInput.value }) });
      await refreshBots();
    } catch (err) { $('#botMessage').textContent = err.message; }
    finally { button.disabled = false; }
    return;
  }

  // Open bot
  if (button.dataset.botOpen) { await switchBot(button.dataset.botOpen); return; }

  // Explicit owner review after a loss-streak pause. Session reset alone never clears it.
  if (button.dataset.botRearm) {
    const botId = button.dataset.botId, broker = button.dataset.botRearm;
    if (!botId || lifecyclePending[botId]) return;
    const reason = window.prompt(botT(
      `Review ${broker} Paper losses before re-arming BUY entries. Resolve positions while exits are possible, then stop the Bot. Re-arm is available on the next UTC day after account activity. The daily loss guard remains active. Enter your review reason (10–500 characters):`,
      `ตรวจผลขาดทุน Paper ของ ${broker} ก่อนเปิดรับ BUY ใหม่ จัดการสถานะขณะยังส่ง EXIT ได้ แล้วจึงหยุด Bot การ re-arm ทำได้ในวัน UTC ถัดจากวันที่บัญชีมีรายการ กฎขาดทุนรายวันยังทำงานอยู่ ระบุเหตุผลการตรวจ (10–500 ตัวอักษร):`
    ));
    if (reason === null) return;
    lifecyclePending[botId] = true;
    button.disabled = true;
    try {
      const result = await api('/api/bot/session/rearm-loss-streak', {
        method: 'POST', body: JSON.stringify({ broker, reason }), botId
      });
      $('#botMessage').textContent = botT(
        `Entry pause re-armed for ${broker}. Streak ${result.previous_loss_streak} → 0. Reset the stopped session before starting a new run.`,
        `เปิดรับ BUY ของ ${broker} ได้อีกครั้ง: streak ${result.previous_loss_streak} → 0 รีเซ็ต session ที่หยุดอยู่ก่อนเริ่มรอบใหม่`
      );
    } catch (err) { $('#botMessage').textContent = err.message; }
    finally { lifecyclePending[botId] = false; await refreshBots(); }
    return;
  }

  // Copy webhook
  if (button.dataset.botCopy) {
    const id = button.dataset.botCopy;
    button.disabled = true;
    try {
      const result = await api('/api/me/webhook-secret', { botId: id });
      if (!result.urlPath) throw new Error(botT('Open this bot and create or recover its webhook in Account and License.', 'เปิด Bot แล้วสร้างหรือกู้คืน Webhook ในหน้าบัญชีและ License'));
      const url = location.origin + result.urlPath;
      try { await navigator.clipboard.writeText(url); $('#botMessage').textContent = translate('Copied'); }
      catch { $('#botCopyFallback').hidden = false; $('#botCopyFallback').value = url; $('#botCopyFallback').select(); }
    } catch (err) { $('#botMessage').textContent = err.message; }
    finally { button.disabled = false; }
    return;
  }

  // Lifecycle actions
  if (button.dataset.botLifecycle) {
    const action = button.dataset.botLifecycle;
    const botId = button.dataset.botId;
    if (!botId || lifecyclePending[botId]) return;

    // Confirmation for stop / reset
    if (['stop', 'reset'].includes(action)) {
      const bot = botProfiles.find(b => b.id === botId);
      const confirmed = await confirmLifecycle(action, bot?.label || botId);
      if (!confirmed) return;
    }

    lifecyclePending[botId] = true;
    $('#botMessage').textContent = '';
    updateTCPButtons(botId);

    try {
      const result = await api('/api/bot/session/' + action, { method: 'POST', body: '{}', botId });
      botSessions[botId] = result;
      $('#botMessage').textContent = `Bot is now ${result.state}.`;

      if (result.state === 'RUNNING') startPolling(botId);
      else if (['STOPPED', 'SETUP'].includes(result.state)) {
        if (pollActiveBotId === botId) stopPolling();
      }
      // Lock/unlock risk form
      if (typeof lockRiskForm === 'function') lockRiskForm(result.state !== 'SETUP');
    } catch (err) { $('#botMessage').textContent = err.message; }
    finally {
      lifecyclePending[botId] = false;
      await refreshBots();
    }
  }
};

// ─── Bot switch ───────────────────────────────────────────────────────────────
$('#botSwitcher').onchange = event => switchBot(event.target.value);

async function switchBot(id) {
  if (pollActiveBotId && pollActiveBotId !== id) stopPolling();
  ++pollSequence; // invalidate any in-flight polls for old bot
  $('#app').inert = true;
  try {
    selectedBot = id;
    renderBots();
    await load();
    if (selectedBot === 'all') document.querySelector('[data-view="overview"]').click();
    else if (!document.querySelector('[data-page="analytics"]').hidden) await loadAnalytics();
    // Resume poll if switched bot is RUNNING
    const session = botSessions[id];
    if (session?.state === 'RUNNING') startPolling(id);
  } finally { $('#app').inert = false; }
}

// ─── Nav hooks ────────────────────────────────────────────────────────────────
document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.view === 'bots') refreshBots();
  if (selectedBot === 'all' && !['bots', 'overview', 'signals'].includes(button.dataset.view)) {
    $('#botMessage').textContent = translate('Select one bot for this operation');
    document.querySelector('[data-view="bots"]').click();
  }
}));

$('#language').addEventListener('change', renderBots);

// Stop polling on logout
const _origLogout = $('#logout').onclick;
$('#logout').addEventListener('click', () => stopPolling());

// ─── Boot ─────────────────────────────────────────────────────────────────────
const originalLoad = load;
load = async function () {
  await originalLoad();
  if (authenticated) await refreshBots();
};
if (authenticated) refreshBots();
