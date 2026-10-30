/* Read-only QR-2 view. Financial values remain server decimal strings. */
(() => {
  const root = document.getElementById('paperPerformance');
  if (!root) return;
  const get = id => document.getElementById(id);
  const controls = ['ppScope', 'ppBot', 'ppBroker', 'ppCurrency', 'ppPeriod', 'ppFrom', 'ppTo'].map(get);
  const result = get('ppResult'), status = get('ppStatus'), button = get('ppLoad');
  let sequence = 0, sessionSequence = 0, controller, bots = [], botsLoaded = false, botsLoading;
  const signedIn = () => typeof authenticated !== 'undefined' && authenticated === true;
  const activeOwner = () => typeof me !== 'undefined' && typeof me?.user?.id === 'string' && me.user.id ? me.user.id : null;
  let sessionSignedIn = signedIn(), sessionOwner = activeOwner();
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
    const sessionToken = sessionSequence, ownerId = activeOwner();
    botsLoading = (async () => {
      try {
        const response = await fetch('/api/bots', {method: 'GET', credentials: 'same-origin'});
        if (!signedIn() || sessionToken !== sessionSequence || ownerId !== activeOwner()) return;
        if (response.status === 401) { authenticationFailed(); return; }
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json();
        if (!signedIn() || sessionToken !== sessionSequence || ownerId !== activeOwner()) return;
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
      description.append(serverValue(item));
      if (key === 'price_retrieval' && item === 'RETRIEVED_AFTER_INSTANT') {
        description.append(document.createTextNode(' · '), label('Price recorded later.'));
      }
      row.append(term, description); list.append(row);
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
  // QR-2 reconciliation note (RC-Q47). Each listed first-failure reason has one fixed sentence. A reason that is not a key of this map (an unknown
  // or hostile string) gets the generic sentence and is never used as a label key. The note holds text only: no number of the response is shown.
  const RECONCILE_NOTES = {
    EPOCH_UNKNOWN: 'Stopped by design: no ledger rule period is recorded for this fill time. Values from this fill on stay unavailable. Later ledger rows are not checked.',
    FILL_WITHOUT_JOURNAL: 'A fill has no matching cash journal row.',
    JOURNAL_WITHOUT_FILL: 'A cash journal row has no matching fill.',
    DUPLICATE_FILL_KEY: 'Two fills share one fill key.',
    DUPLICATE_JOURNAL_KEY: 'Two cash journal rows share one key.',
    FOREIGN_JOURNAL_ROW: 'A cash journal row in this account names another account.'
  };
  const RECONCILE_GENERIC = 'The first failed check is listed in the server details below.';
  function reconcileNote(reconciliation) {
    const failure = reconciliation.first_failure && typeof reconciliation.first_failure === 'object' ? reconciliation.first_failure : null;
    const reason = typeof failure?.reason === 'string' ? failure.reason : null;
    const section = document.createElement('section');
    section.className = 'pp-reconcile-note';
    section.append(label('Why reconciliation failed', 'h4'),
      label(reason !== null && Object.hasOwn(RECONCILE_NOTES, reason) ? RECONCILE_NOTES[reason] : RECONCILE_GENERIC, 'p'));
    const code = reason ?? (typeof failure?.code === 'string' ? failure.code : null);
    if (code !== null) {
      const line = document.createElement('p');
      line.append(label('Reason code'), ' ', raw(code));
      section.append(line);
    }
    return section;
  }
  // QR-2 O7 bar coverage. Server coverage is shown as reported: no arithmetic, no merging, no filling of gaps.
  const COVERAGE_VERSION = 'qr2-bar-coverage-v1', OWNER_COVERAGE_VERSION = 'qr2-owner-bar-coverage-v1', EPOCH_LIMIT = 8640000000000000;
  const COVERAGE_NOTICES = [
    'Bar gaps are listed as the server reports them. No gap is filled or interpolated. Only a gap at a needed valuation point changes a number.',
    'The valuation check (market_data.checked and market_data.gap) covers only the bars needed at valuation points. Bar coverage covers every complete 1-minute candle in the range. The two can differ.',
    'Only complete 1-minute candles are inspected. Partial candles at the range edges are excluded.',
    'Inspection completed means every 1-minute slot in the inspected window was checked for a stored candle. Partial edge candles are outside this check.',
    'Each time is shown as UTC epoch milliseconds followed by the same instant in ISO 8601 UTC in parentheses.'
  ];
  const OWNER_COVERAGE_NOTICE = 'Coverage is shown per market and range. Accounts with the same market and range share one coverage entry. Coverage is never summed across accounts.';
  const COVERAGE_CLASS_LABEL = {
    C1: 'Inspection completed; gaps found.',
    C2: 'Inspection completed; no stored candle is missing from the inspected window.',
    C3: 'No inspection: the range for this coverage is unresolved.',
    C4: 'No inspection: the range holds no complete 1-minute candle.',
    C5: 'Inspection unavailable: bar coverage is reported only for the one supported Binance Global spot 1-minute market.',
    C6: 'Inspection unavailable: the market data table is absent. This is not stored history with no bars.',
    C7: 'Inspection unavailable: this range is over the bar coverage check limit, so bar coverage was not checked. The financial figures and their price checks are not affected. Choose a shorter range, for example Week, to see bar coverage.'
  };
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const epochOk = value => Number.isSafeInteger(value) && value >= -EPOCH_LIMIT && value <= EPOCH_LIMIT;
  const countOk = value => Number.isSafeInteger(value) && value >= 0;
  const rangeOk = value => value === null || (isObject(value) && epochOk(value.from) && epochOk(value.to));
  const timeForm = value => String(value) + ' (' + new Date(value).toISOString() + ')';
  // Returns the class C1 to C7 of one coverage object, or null when the object is not a well-formed coverage.
  function coverageClass(c) {
    if (!isObject(c) || c.version !== COVERAGE_VERSION) return null;
    const m = c.market;
    if (m !== null && !(isObject(m) && typeof m.broker === 'string' && typeof m.symbol === 'string' && typeof m.timeframe === 'string')) return null;
    if (!rangeOk(c.resolved_range) || !rangeOk(c.inspected_window)) return null;
    if (!Array.isArray(c.excluded_edges) || !c.excluded_edges.every(edge => isObject(edge) && epochOk(edge.from) && epochOk(edge.to) && typeof edge.reason === 'string')) return null;
    let cls = null;
    if (c.state === 'COMPLETE' && c.reason === null) cls = Number.isSafeInteger(c.interval_count) && c.interval_count > 0 ? 'C1' : c.interval_count === 0 ? 'C2' : null;
    else if (c.state === 'EMPTY' && c.reason === 'RANGE_UNRESOLVED') cls = 'C3';
    else if (c.state === 'EMPTY' && c.reason === 'NO_FULL_CANDLES') cls = 'C4';
    else if (c.state === 'UNAVAILABLE' && c.reason === 'UNSUPPORTED_MARKET') cls = 'C5';
    else if (c.state === 'UNAVAILABLE' && c.reason === 'MARKET_DATA_TABLE_ABSENT') cls = 'C6';
    else if (c.state === 'UNAVAILABLE' && c.reason === 'COVERAGE_BUDGET_EXCEEDED') cls = 'C7';
    if (!cls) return null;
    const counts = [c.expected_minutes, c.stored_minutes, c.missing_minutes];
    if (cls === 'C5' || cls === 'C6' || cls === 'C7') return counts.every(value => value === null) && c.interval_count === null && c.intervals === null ? cls : null;
    if (!Array.isArray(c.intervals)) return null;
    if (cls === 'C3' || cls === 'C4') return counts.every(value => value === 0) && c.interval_count === 0 && c.intervals.length === 0 ? cls : null;
    if (!counts.every(countOk)) return null;
    if (cls === 'C2') return c.intervals.length === 0 ? cls : null;
    if (c.intervals.length !== c.interval_count) return null;
    return c.intervals.every(item => isObject(item) && epochOk(item.from) && epochOk(item.to) && Number.isSafeInteger(item.missing_minutes)) ? cls : null;
  }
  // Light structural check plus the render model. Returns null when the coverage keys are malformed (the report then fails closed).
  function coverageModel(body, owner) {
    if (!owner) {
      const block = body.market_data;
      if (!isObject(block) || !Object.hasOwn(block, 'coverage')) return {blocks: [], notice: 'Bar coverage not supplied by this response.'};
      const cls = coverageClass(block.coverage);
      return cls ? {blocks: [{coverage: block.coverage, cls, accounts: null}], notice: null} : null;
    }
    const unresolved = body.resolved_range === null;
    if (!Object.hasOwn(body, 'market_coverage')) return {blocks: [], notice: unresolved ? 'No bar coverage: the report range is unresolved.' : 'Bar coverage not supplied by this response.'};
    const section = body.market_coverage;
    if (unresolved || !isObject(section) || section.version !== OWNER_COVERAGE_VERSION || !Array.isArray(section.entries) || !Array.isArray(section.accounts)) return null;
    const index = new Map(), blocks = [];
    for (let position = 0; position < section.entries.length; position++) {
      const entry = section.entries[position];
      if (!isObject(entry) || entry.id !== 'coverage:' + position) return null;
      const cls = coverageClass(entry.coverage);
      if (!cls) return null;
      index.set(entry.id, blocks.length);
      blocks.push({coverage: entry.coverage, cls, accounts: []});
    }
    const pairs = new Set(), referenced = new Set();
    for (const account of section.accounts) {
      if (!isObject(account) || typeof account.bot_id !== 'string' || typeof account.broker !== 'string') return null;
      if (!Array.isArray(account.coverage_ids) || account.coverage_ids.length !== 1 || typeof account.coverage_ids[0] !== 'string' || !index.has(account.coverage_ids[0])) return null;
      const key = JSON.stringify([account.bot_id, account.broker]);
      if (pairs.has(key)) return null;
      pairs.add(key);
      referenced.add(account.coverage_ids[0]);
      blocks[index.get(account.coverage_ids[0])].accounts.push(account);
    }
    return referenced.size === blocks.length ? {blocks, notice: null} : null;
  }
  // A fixed sub-label followed by a raw server value; field is a fixed name for tests and styling.
  function covPair(name, value, field) {
    const node = document.createElement('span'), valueNode = raw(value);
    node.className = 'pp-cov-pair'; valueNode.dataset.covField = field;
    node.append(label(name), ' ', valueNode);
    return node;
  }
  function covRow(name, key, ...content) {
    const row = document.createElement('div'), description = document.createElement('dd');
    row.dataset.covRow = key; description.append(...content);
    row.append(label(name, 'dt'), description);
    return row;
  }
  const covRangeNodes = range => range === null ? [raw(null)] : [covPair('From', timeForm(range.from), 'from'), ' ', covPair('To', timeForm(range.to), 'to')];
  function coverageBlock(entry, owner) {
    const c = entry.coverage, block = document.createElement('div'), rows = document.createElement('dl');
    block.className = 'pp-cov-block'; block.dataset.covClass = entry.cls; rows.className = 'pp-cov-rows';
    const classNode = label(COVERAGE_CLASS_LABEL[entry.cls]);
    classNode.className = 'pp-cov-class';
    rows.append(covRow('Inspection result', 'result', classNode, ' ', covPair('State code', c.state, 'state'), ' ', covPair('Reason code', c.reason, 'reason')));
    rows.append(covRow('Market', 'market', ...(c.market === null ? [raw(null)] :
      [covPair('Broker', c.market.broker, 'broker'), ' ', covPair('Symbol', c.market.symbol, 'symbol'), ' ', covPair('Timeframe (minutes)', c.market.timeframe, 'timeframe')])));
    rows.append(covRow('Coverage range', 'range', ...covRangeNodes(c.resolved_range)));
    rows.append(covRow('Inspected window', 'window', ...covRangeNodes(c.inspected_window)));
    let edges;
    if (c.excluded_edges.length) {
      edges = document.createElement('ul');
      for (const edge of c.excluded_edges) {
        const item = document.createElement('li');
        item.append(covPair('From', timeForm(edge.from), 'from'), ' ', covPair('To', timeForm(edge.to), 'to'), ' ', covPair('Reason', edge.reason, 'edge-reason'));
        edges.append(item);
      }
    } else edges = label('None');
    rows.append(covRow('Excluded partial candles', 'edges', edges));
    for (const [name, key, value] of [['Expected minutes', 'expected', c.expected_minutes], ['Stored minutes', 'stored', c.stored_minutes], ['Missing minutes', 'missing', c.missing_minutes], ['Gap intervals', 'count', c.interval_count]]) {
      const valueNode = raw(value);
      valueNode.dataset.covField = 'value';
      rows.append(covRow(name, key, valueNode, ...(value === null ? [raw(' · ' + c.reason)] : [])));
    }
    block.append(rows);
    if (entry.cls === 'C1') {
      const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul');
      details.className = 'pp-cov-intervals'; details.open = c.interval_count <= 10;
      summary.append(label('Gap interval list, count:'), ' ', raw(c.interval_count));
      list.className = 'pp-cov-interval-list';
      const items = document.createDocumentFragment();
      for (const item of c.intervals) items.append(raw(timeForm(item.from) + ' - ' + timeForm(item.to) + ' : ' + String(item.missing_minutes), 'li'));
      list.append(items);
      details.append(summary, label('Each row: start - end : missing minutes. Start inclusive, end exclusive.', 'p'), list);
      block.append(details);
    }
    if (owner) {
      const accounts = document.createElement('ul'), wrapper = document.createElement('dl');
      accounts.className = 'pp-cov-accounts';
      for (const account of entry.accounts) {
        const item = document.createElement('li');
        item.append(covPair('Bot', account.bot_id, 'bot'), ' ', covPair('Broker', account.broker, 'account-broker'));
        accounts.append(item);
      }
      wrapper.append(covRow('Accounts using this coverage', 'accounts', accounts));
      block.append(wrapper);
    }
    return block;
  }
  function coverageSection(model, owner) {
    const section = document.createElement('section');
    section.className = 'pp-coverage';
    section.append(label('Market bar coverage', 'h4'));
    const notices = owner ? [...COVERAGE_NOTICES, OWNER_COVERAGE_NOTICE] : COVERAGE_NOTICES;
    for (const text of model.notice ? [...notices, model.notice] : notices) {
      const notice = label(text, 'p');
      notice.className = 'pp-cov-notice';
      section.append(notice);
    }
    for (const entry of model.blocks) section.append(coverageBlock(entry, owner));
    return section;
  }
  function render(body, owner, book, coverage) {
    const fragment = document.createDocumentFragment();
    fragment.append(label(owner ? 'Owner accounts · one currency' : 'Bot account', 'h3'));
    const identity = document.createElement('p');
    identity.append(serverValue(body.scope), raw(body.currency)); fragment.append(identity);
    if (!owner && body.reconciliation && typeof body.reconciliation === 'object' && body.reconciliation.state === 'RECONCILIATION_FAILED') fragment.append(reconcileNote(body.reconciliation));
    const metrics = document.createElement('dl'); metrics.className = 'pp-metrics';
    const row = (name, value) => {
      const item = document.createElement('div'), description = document.createElement('dd');
      description.append(serverValue(value)); item.append(label(name, 'dt'), description); metrics.append(item);
    };
    fragment.append(label('Book equity used for sizing is a different number.', 'p'));
    if (!owner) {
      const comparison = document.createElement('div'); comparison.className = 'pp-equity-comparison';
      const bookCard = document.createElement('section'); bookCard.className = 'pp-equity-card pp-book';
      bookCard.append(label('Book equity (cost basis)', 'h4'), raw('BOOK_EQUITY_COST_BASIS', 'small'),
        raw(book?.value ?? '—', 'strong'), raw(body.currency, 'small'),
        label('Used for sizing; not portfolio value.', 'p'),
        label('Current account snapshot fetched for this Load / Refresh.', 'p'),
        label('Book valuation time unavailable.', 'p'));
      if (book?.reason) bookCard.append(label('Book equity unavailable.', 'p'), raw(book.reason, 'small'));
      const markedCard = document.createElement('section'); markedCard.className = 'pp-equity-card pp-marked';
      markedCard.append(label('Marked equity', 'h4'), serverValue(body.account?.nav_to ?? body.account?.nav ?? null),
        raw(body.currency, 'small'), label('Historical marked report: server range and as_of only.', 'p'),
        serverValue({requested_range: body.requested_range, resolved_range: body.resolved_range, as_of: body.as_of}));
      comparison.append(bookCard, markedCard); fragment.append(comparison,
        label('Separate reads and snapshots; values may reflect different times. Refresh explicitly for a new snapshot.', 'p'));
    }
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
    fragment.append(coverageSection(coverage, owner));
    const details = document.createElement('details'); details.open = true;
    details.append(label('Server status, methods and range evidence', 'summary'));
    const metadata = {...body};
    delete metadata.account; delete metadata.total;
    delete metadata.market_coverage; if (metadata.market_data && typeof metadata.market_data === 'object' && !Array.isArray(metadata.market_data)) metadata.market_data = Object.fromEntries(Object.entries(metadata.market_data).filter(([key]) => key !== 'coverage'));
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
  function bookValue(body, botId, broker, currency, ownerId) {
    if (typeof body?.user?.id === 'string' && body.user.id !== ownerId) return {identityFailure: true};
    if (body?.user?.id !== ownerId || body.moneyFormat !== 'decimal-string' || body.bot?.id !== botId || body.allBots !== false || !Array.isArray(body.paperAccounts))
      return {reason: 'BOOK_RESPONSE_INVALID'};
    const expectedCurrency = {'binance-global': 'USDT', 'binance-th': 'THB', innovestx: 'THB', settrade: 'THB'}[broker];
    if (!expectedCurrency || currency !== expectedCurrency) return {reason: 'BOOK_CURRENCY_MISMATCH'};
    const rows = body.paperAccounts.filter(row => row?.bot_id === botId && row.userId === botId && row.broker === broker && row.currency === currency);
    if (rows.length !== 1) return {reason: 'BOOK_ACCOUNT_NOT_UNIQUE'};
    const row = rows[0];
    if (row.valuation !== 'COST_BASIS_NOT_MARK_TO_MARKET' || typeof row.bookEquity !== 'string' ||
        !/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(row.bookEquity)) return {reason: 'BOOK_VALUE_INVALID'};
    return {value: row.bookEquity};
  }
  function authenticationFailed() {
    clearSession(); button.disabled = true; message('Sign in to view Paper history.');
  }
  // A 422 range refusal tells the person what to change, in generic words that name no limit or day count.
  function rangeHint() {
    // timestamp_rows and union_minutes no longer refuse a request (OD-S5-D): they degrade bar coverage to class C7. Only the generic hint remains.
    const hint = document.createElement('p');
    hint.append(label('The chosen range is too long for the performance report (a report size limit was reached). A shorter range, for example Week or a Custom range, should work.'));
    return hint;
  }
  async function submit(event) {
    event.preventDefault();
    invalidate();
    if (!signedIn()) return;
    const token = sequence, ownerId = activeOwner();
    const current = () => {
      if (token !== sequence || !signedIn()) return false;
      if (activeOwner() !== ownerId) { invalidate(); return false; }
      return true;
    };
    const owner = get('ppScope').value === 'owner';
    if (!owner && !ownerId) { message('Paper performance response unavailable.', 'BOOK_OWNER_UNKNOWN'); return; }
    const query = new URLSearchParams({period: get('ppPeriod').value});
    if (owner) query.set('currency', get('ppCurrency').value);
    else {
      if (!botsLoaded) await loadBots();
      if (!current()) return;
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
      if (!current()) return;
      if (response.status === 401) { authenticationFailed(); return; }
      let body; try { body = await response.json(); } catch { body = null; }
      if (!current()) return;
      if (!response.ok) {
        const retry = response.headers.get('Retry-After');
        message(response.status === 404 ? 'Paper performance endpoint or scope unavailable.' : response.status === 401 ? 'Sign in to view Paper history.' : retry || response.status === 429 ? 'Request unavailable. Retry manually later.' : 'Paper performance request refused.',
          ['HTTP ' + response.status, body?.code, retry ? 'Retry-After: ' + retry : ''].filter(Boolean).join(' · '));
        if (response.status === 422 && body?.code === 'QR2_RANGE_ADMISSION_REFUSED') result.append(rangeHint());
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
      const coverage = coverageModel(body, owner);
      if (!coverage) { message('Paper performance response unavailable.', 'QR2_RESPONSE_INVALID'); return; }
      let book;
      if (!owner) {
        try {
          const bookResponse = await fetch('/api/me?' + new URLSearchParams({bot_id: query.get('bot_id')}), {
            method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal
          });
          if (!current()) return;
          if (bookResponse.status === 401) { authenticationFailed(); return; }
          if (!bookResponse.ok) book = {reason: 'BOOK_REQUEST_REFUSED · HTTP ' + bookResponse.status};
          else {
            let accountBody; try { accountBody = await bookResponse.json(); } catch { accountBody = null; }
            if (!current()) return;
            book = accountBody ? bookValue(accountBody, query.get('bot_id'), query.get('broker'), body.currency, ownerId) : {reason: 'BOOK_RESPONSE_INVALID'};
            if (book.identityFailure) { authenticationFailed(); return; }
          }
        } catch (error) {
          if (!current() || error.name === 'AbortError') return;
          book = {reason: 'BOOK_REQUEST_UNAVAILABLE'};
        }
      }
      if (!current()) return;
      message('Server report received.', [body.status.status, ...(body.status.overlays || []), ...(body.status.reasons || []), body.code].filter(Boolean).join(' · '));
      render(body, owner, book, coverage);
    } catch (error) {
      if (current() && error.name !== 'AbortError') message('Paper performance unavailable. Retry manually.');
    } finally {
      if (token === sequence) { root.setAttribute('aria-busy', 'false'); button.disabled = !signedIn(); }
    }
  }
  controls.forEach(control => { control.addEventListener('input', selectionChanged); control.addEventListener('change', selectionChanged); });
  get('ppForm').addEventListener('submit', submit);
  function clearSession() {
    sessionSignedIn = false; sessionOwner = null;
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
        if (!sessionSignedIn || sessionOwner !== activeOwner()) {
          invalidate(); bots = []; botsLoaded = false; get('ppBot').replaceChildren();
        }
        sessionSignedIn = true; sessionOwner = activeOwner();
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
