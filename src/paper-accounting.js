// Paper book values, not market-valued equity. All writes run inside the caller's transaction.
const brokers = ['binance-global', 'binance-th', 'innovestx', 'settrade'];
const configured = (policy, broker) => ({
  equity: Number(policy.equities?.[broker] ?? 0),
  cash: Number(policy.balances?.[broker] ?? policy.equities?.[broker] ?? 0)
});

export function migratePaperAccounting(store) {
  store.db.exec(`
    CREATE TABLE paper_funding(
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), broker TEXT NOT NULL,
      at INTEGER NOT NULL, equity_delta REAL NOT NULL, cash_delta REAL NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('CONFIGURATION','LEGACY_BASELINE')));
    CREATE INDEX idx_paper_funding_account ON paper_funding(user_id,broker,at,id);
    CREATE TABLE paper_cash_journal(
      signal_id INTEGER NOT NULL REFERENCES signals(id), cumulative_quantity REAL NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id), broker TEXT NOT NULL,
      cash_delta REAL NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(signal_id,cumulative_quantity));
    CREATE INDEX idx_paper_cash_account ON paper_cash_journal(user_id,broker,at);
    CREATE TABLE paper_snapshots(
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), broker TEXT NOT NULL,
      at INTEGER NOT NULL, reason TEXT NOT NULL, cash REAL NOT NULL,
      book_equity REAL NOT NULL, position_cost REAL NOT NULL);
    CREATE INDEX idx_paper_snapshots_account ON paper_snapshots(user_id,broker,at,id);
  `);
  const now = Date.now();
  for (const row of store.db.prepare('SELECT user_id,policy FROM risk_profiles').all()) {
    const policy = JSON.parse(row.policy);
    for (const broker of brokers) {
      const funds = configured(policy, broker);
      // Old funding edits were not journaled. Preserve the current baseline, never invent historical dates.
      store.db.prepare('INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES(?,?,?,?,?,?)')
        .run(row.user_id, broker, now, funds.equity, funds.cash, 'LEGACY_BASELINE');
    }
  }
  if (store.db.prepare('SELECT count(*) n FROM fills').get().n) store.db.exec(`INSERT INTO paper_cash_journal
    SELECT f.signal_id,f.cumulative_quantity,s.user_id,s.broker,
      CASE WHEN s.side='BUY' THEN -f.delta_quantity*f.price-f.fee_quote
           ELSE f.delta_quantity*f.price-f.fee_quote END,f.received_at
    FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.execution_mode='PAPER';`);
  for (const row of store.db.prepare('SELECT DISTINCT user_id,broker FROM paper_funding UNION SELECT DISTINCT user_id,broker FROM paper_cash_journal').all())
    snapshotPaper(store, row.user_id, row.broker, 'MIGRATION', now);
}

export function paperAccount(store, userId, broker, proposedPolicy) {
  const funding = store.db.prepare(`SELECT COALESCE(SUM(equity_delta),0) equity,COALESCE(SUM(cash_delta),0) cash
    FROM paper_funding WHERE user_id=? AND broker=?`).get(userId, broker);
  const movements = store.db.prepare('SELECT COALESCE(SUM(cash_delta),0) amount FROM paper_cash_journal WHERE user_id=? AND broker=?').get(userId, broker).amount;
  const positionCost = store.db.prepare(`SELECT COALESCE(SUM(quantity*avg_price),0) amount FROM ledger_positions
    WHERE user_id=? AND broker=? AND execution_mode='PAPER'`).get(userId, broker).amount;
  let equityAdjustment = 0, cashAdjustment = 0;
  if (proposedPolicy) {
    const next = configured(proposedPolicy, broker);
    equityAdjustment = next.equity - funding.equity;
    cashAdjustment = next.cash - funding.cash;
  }
  // Never round spendable cash upward. Formatting belongs in the UI, not the risk budget.
  const cash = funding.cash + cashAdjustment + movements;
  return {userId, broker, currency: broker === 'binance-global' ? 'USDT' : 'THB',
    cash, positionCost,
    bookEquity: funding.equity + equityAdjustment + movements + positionCost,
    configuredEquity: funding.equity + equityAdjustment,
    configuredBalance: funding.cash + cashAdjustment,
    valuation: 'COST_BASIS_NOT_MARK_TO_MARKET'};
}

export function snapshotPaper(store, userId, broker, reason, at = Date.now()) {
  const account = paperAccount(store, userId, broker);
  store.db.prepare('INSERT INTO paper_snapshots(user_id,broker,at,reason,cash,book_equity,position_cost) VALUES(?,?,?,?,?,?,?)')
    .run(userId, broker, at, reason, account.cash, account.bookEquity, account.positionCost);
}

export function recordFunding(store, userId, policy) {
  for (const broker of brokers) {
    const current = paperAccount(store, userId, broker), next = configured(policy, broker);
    const equityDelta = next.equity - current.configuredEquity, cashDelta = next.cash - current.configuredBalance;
    if (!equityDelta && !cashDelta) continue;
    if (![next.equity, next.cash].every(Number.isFinite) || next.cash < 0 || next.equity < next.cash)
      throw new Error('Invalid Paper capital');
    const reserved = store.db.prepare(`SELECT order_intent,applied_quantity FROM signals WHERE user_id=? AND broker=?
      AND execution_mode='PAPER' AND side='BUY' AND status IN ('PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')`).all(userId, broker)
      .reduce((sum, row) => {const order = row.order_intent && JSON.parse(row.order_intent);return sum + (order ? Math.max(0, order.quantity-row.applied_quantity)*order.price : 0);}, 0);
    if ((cashDelta < 0 && current.cash + cashDelta < reserved - 1e-8) ||
        (equityDelta < 0 && current.bookEquity + equityDelta < current.positionCost + reserved - 1e-8))
      throw new Error('Paper capital withdrawal exceeds unreserved funds');
    const now = Date.now();
    store.db.prepare('INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES(?,?,?,?,?,?)')
      .run(userId, broker, now, equityDelta, cashDelta, 'CONFIGURATION');
    snapshotPaper(store, userId, broker, 'FUNDING', now);
  }
}

export const paperMethods = {
  paperAccount(userId, broker, proposedPolicy) { return paperAccount(this, userId, broker, proposedPolicy); },
  paperAccounts(userId) { return brokers.map(broker => paperAccount(this, userId, broker)); },
  paperFunding(userId, broker) { return this.db.prepare('SELECT * FROM paper_funding WHERE user_id=? AND broker=? ORDER BY at,id').all(userId, broker); }
};
