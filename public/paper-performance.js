/* Read-only QR-2 view. Financial values remain server decimal strings. */
(() => {
  const root = document.getElementById('paperPerformance');
  if (!root) return;
  const get = id => document.getElementById(id);
  const controls = ['ppScope', 'ppBot', 'ppBroker', 'ppCurrency', 'ppPeriod', 'ppFrom', 'ppTo'].map(get);
  const result = get('ppResult'), status = get('ppStatus'), button = get('ppLoad');
  let sequence = 0, sessionSequence = 0, controller, bots = [], botsLoaded = false, botsLoading;
  const signedIn = () => typeof authenticated !== 'undefined' && authenticated === true;
  let sessionSignedIn = signedIn();
  const label = (text, tag = 'span') => {
    const node = document.createElement(tag);
    node.dataset.uiLabel = text;
    node.textContent = typeof translate === 'function' ? translate(text) : text;
    return node;
  };
  const raw = (text, tag = 'span') => {
    const node = document.createElement(tag);
    node.className = 'no-i18n';
    node.textContent = String(text ?? '—');
    return node;
  };
  function message(text, detail) {
    status.replaceChildren(label(text));
    if (detail) status.append(raw(' · ' + detail));
  }
  function invalidate() {
    sequence++;
    controller?.abort();
    controller = null;
    result.replaceChildren();
    root.setAttribute('aria-busy', 'false');
    button.disabled = !signedIn();
    message(signedIn() ? 'Choose a scope and press Load / Refresh.' : 'Sign in to view Paper history.');
  }
  function selectionChanged() {
    invalidate();
    const owner = get('ppScope').value === 'owner';
    get('ppBot').disabled = owner;
    get('ppBroker').disabled = owner;
    get('ppCurrency').disabled = !owner;
    get('ppFrom').disabled = get('ppTo').disabled = get('ppPeriod').value !== 'CUSTOM';
    get('ppNotice').dataset.uiLabel = owner ? 'Actual Paper ledger history of the selected owner accounts. Fills are simulated, not exchange executions. These are engineering facts, not a profitability claim, a strategy evaluation or a recommendation.' : 'Actual Paper ledger history of this Bot. Fills are simulated, not exchange executions. These are engineering facts, not a profitability claim, a strategy evaluation or a recommendation.';
  }
  async function loadBots() {
    if (!signedIn() || botsLoaded) return;
    if (botsLoading) return botsLoading;
    const sessionToken = sessionSequence;
    botsLoading = (async () => {
      try {
        const response = await fetch('/api/bots', {method: 'GET', credentials: 'same-origin'});
        if (!signedIn() || sessionToken !== sessionSequence) return;
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        if (!signedIn() || sessionToken !== sessionSequence) return;
        if (!Array.isArray(body.bots)) throw new Error('QR2_BOT_LIST_INVALID');
        bots = body.bots.filter(bot => typeof bot.id === 'string');
        const select = get('ppBot'), previous = select.value;
        select.replaceChildren(label('Select a Bot', 'option'));
        select.firstChild.value = '';
        for (const bot of bots) {
          const option = raw(bot.label || bot.id, 'option');
          option.value = bot.id;
          select.append(option);
        }
        if (bots.some(bot => bot.id === previous)) select.value = previous;
        botsLoaded = true;
      } catch (error) {
        if (signedIn() && sessionToken === sessionSequence) message('Owned Bot list unavailable. Press Load / Refresh to retry.', error.message);
      } finally { botsLoading = null; }
    })();
    return botsLoading;
  }
  // Recursive server metadata stays visible without inventing valuation fallbacks.
  function serverValue(value) {
    if (value === null || typeof value !== 'object') return raw(value);
    if (Object.hasOwn(value, 'value') && Object.hasOwn(value, 'status')) {
      const node = document.createElement('div');
      node.append(raw(value.value, 'strong'));
      node.append(raw(' · ' + value.status, 'small'));
      const reasons = value.reasons;
      if (reasons.length) node.append(raw(reasons.join(' · '), 'small'));
      return node;
    }
    if (Array.isArray(value)) {
      if (!value.length) return raw('[]');
      const list = document.createElement('ul');
      for (const item of value) { const row = document.createElement('li'); row.append(serverValue(item)); list.append(row); }
      return list;
    }
    const list = document.createElement('dl');
    for (const [key, item] of Object.entries(value)) {
      const row = document.createElement('div'), term = raw(key, 'dt'), description = document.createElement('dd');
      description.append(serverValue(item)); row.append(term, description); list.append(row);
    }
    return list;
  }
  const fields = {
    cash: 'Cash', reserved_notional: 'Reserved notional', reserved_fees: 'Reserved fees', available_cash: 'Available cash',
    nav: 'Marked equity', nav_from: 'Marked equity at start', nav_to: 'Marked equity at end', market_value: 'Market value',
    position_cost: 'Position cost', exposure: 'Exposure', realized_pnl: 'Realized PnL', unrealized_pnl: 'Unrealized PnL',
    fees: 'Fees (information only)', unbacked_equity: 'Unbacked equity', flows_total: 'Capital flows', money_pnl: 'Money PnL',
    twr: 'TWR', mwr: 'Modified Dietz', max_drawdown: 'Max drawdown'
  };
  function render(body, owner) {
    const fragment = document.createDocumentFragment();
    fragment.append(label(owner ? 'Owner accounts · one currency' : 'Bot account', 'h3'));
    const identity = document.createElement('p');
    identity.append(serverValue(body.scope), raw(body.currency)); fragment.append(identity);
    const metrics = document.createElement('dl'); metrics.className = 'pp-metrics';
    const row = (name, value) => {
      const item = document.createElement('div'), description = document.createElement('dd');
      description.append(serverValue(value)); item.append(label(name, 'dt'), description); metrics.append(item);
    };
    fragment.append(label('Book equity used for sizing is a different number.', 'p'));
    fragment.append(label('Book equity is not supplied by this performance endpoint.', 'p'));
    const account = owner ? body.total : body.account;
    if (account) {
      for (const [key, title] of Object.entries(fields)) {
        // Owner returns are deliberately not offered, even if a malformed response carries one.
        if (owner && (key === 'twr' || key === 'mwr')) continue;
        if (Object.hasOwn(account, key)) row(title, account[key]);
      }
    }
    fragment.append(metrics);
    if (owner) {
      fragment.append(label('Owner aggregates require an applicable capital-model declaration. Independent Paper accounts are not an owner portfolio. Owner TWR and MWR are unavailable.', 'p'));
      fragment.append(serverValue({allocation: body.allocation ?? null, label: body.total?.label ?? null, notice: body.total?.notice ?? null}));
    }
    const details = document.createElement('details'); details.open = true;
    details.append(label('Server status, methods and range evidence', 'summary'));
    const metadata = {...body};
    delete metadata.account; delete metadata.total;
    details.append(serverValue(metadata)); fragment.append(details);
    result.replaceChildren(fragment);
  }
  function validNumbers(value) {
    if (!value || typeof value !== 'object') return true;
    if (Object.hasOwn(value, 'value')) {
      if (!Array.isArray(value.reasons) || !value.reasons.every(reason => typeof reason === 'string')) return false;
      if (!['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(value.status)) return false;
      if (value.value === null) return value.status === 'UNAVAILABLE' && value.reasons.length > 0;
      return value.status !== 'UNAVAILABLE' && typeof value.value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.value);
    }
    return Object.values(value).every(validNumbers);
  }
  function ownerAggregateAllowed(body) {
    if (!body.allocation || !body.total || body.total.twr?.value !== null || body.total.mwr?.value !== null) return false;
    const hasAggregate = ['nav_from', 'nav_to', 'flows_total', 'fees', 'money_pnl']
      .some(key => body.total[key]?.value != null);
    if (!hasAggregate) return true;
    // Only the production allocation contract permits these owner sums.
    return body.allocation.capital_model === 'INDEPENDENT_ACCOUNTS' && body.allocation.reason === null &&
      Number.isSafeInteger(body.declaration_version) && body.declaration_version > 0 &&
      body.allocation.version === body.declaration_version &&
      body.total.label === 'SUM_OF_INDEPENDENT_PAPER_ACCOUNTS' && body.total.notice === 'NOT_AN_OWNER_PORTFOLIO';
  }
  async function submit(event) {
    event.preventDefault();
    invalidate();
    if (!signedIn()) return;
    const token = sequence;
    const owner = get('ppScope').value === 'owner';
    const query = new URLSearchParams({period: get('ppPeriod').value});
    if (owner) query.set('currency', get('ppCurrency').value);
    else {
      if (!botsLoaded) await loadBots();
      if (token !== sequence || !signedIn()) return;
      if (!bots.some(bot => bot.id === get('ppBot').value)) { message('Select an owned Bot.'); return; }
      query.set('bot_id', get('ppBot').value); query.set('broker', get('ppBroker').value);
    }
    if (get('ppPeriod').value === 'CUSTOM') {
      const from = get('ppFrom').value, to = get('ppTo').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
        message('Choose valid UTC dates. End date includes the whole day.'); return;
      }
      query.set('from', from); query.set('to', to);
    }
    controller = new AbortController();
    root.setAttribute('aria-busy', 'true'); button.disabled = true; message('Loading Paper history…');
    try {
      const response = await fetch('/api/paper-performance' + (owner ? '/owner' : '') + '?' + query, {
        method: 'GET', credentials: 'same-origin', signal: controller.signal
      });
      let body; try { body = await response.json(); } catch { body = null; }
      if (token !== sequence || !signedIn()) return;
      if (!response.ok) {
        const retry = response.headers.get('Retry-After');
        message(response.status === 404 ? 'Paper performance endpoint or scope unavailable.' : response.status === 401 ? 'Sign in to view Paper history.' : retry || response.status === 429 ? 'Request unavailable. Retry manually later.' : 'Paper performance request refused.',
          ['HTTP ' + response.status, body?.code, retry ? 'Retry-After: ' + retry : ''].filter(Boolean).join(' · '));
        if (body?.detail) result.append(serverValue(body.detail));
        return;
      }
      if (!body || body.basis !== 'ACTUAL_PAPER_LEDGER' || body.execution !== 'PAPER_SIMULATED_FILLS' ||
          body.historical_simulation !== false || body.qualified_evidence !== false || body.fx !== 'NONE' ||
          !body.status || !['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'REFUSED'].includes(body.status.status) ||
          (owner ? body.scope?.kind !== 'OWNER' || body.scope.currency !== body.currency || body.currency !== query.get('currency') : body.scope?.bot_id !== query.get('bot_id') || body.scope?.broker !== query.get('broker'))) {
        message('Paper performance response unavailable.', 'QR2_RESPONSE_INVALID'); return;
      }
      if (body.status.status === 'REFUSED') {
        message('Paper performance request refused.', [body.code, ...(body.status.reasons || [])].filter(Boolean).join(' · '));
        return;
      }
      if (!validNumbers(body) || (owner && !ownerAggregateAllowed(body))) {
        message('Paper performance response unavailable.', 'QR2_RESPONSE_INVALID'); return;
      }
      message('Server report received.', [body.status.status, ...(body.status.overlays || []), ...(body.status.reasons || []), body.code].filter(Boolean).join(' · '));
      render(body, owner);
    } catch (error) {
      if (token === sequence && signedIn() && error.name !== 'AbortError') message('Paper performance unavailable. Retry manually.');
    } finally {
      if (token === sequence) { root.setAttribute('aria-busy', 'false'); button.disabled = !signedIn(); }
    }
  }
  controls.forEach(control => { control.addEventListener('input', selectionChanged); control.addEventListener('change', selectionChanged); });
  get('ppForm').addEventListener('submit', submit);
  function clearSession() {
    sessionSignedIn = false;
    sessionSequence++;
    invalidate(); bots = []; botsLoaded = false; get('ppBot').replaceChildren();
  }
  get('logout')?.addEventListener('click', clearSession);
  // Session refresh loads only the owned Bot list; report computation always needs explicit submission.
  if (typeof load === 'function') {
    const loadSession = load;
    load = async function (...args) {
      const response = await loadSession.apply(this, args);
      if (signedIn()) {
        if (!sessionSignedIn) invalidate();
        sessionSignedIn = true;
        button.disabled = root.getAttribute('aria-busy') === 'true';
        await loadBots();
      }
      else clearSession();
      return response;
    };
  }
  selectionChanged();
  loadBots();
})();
