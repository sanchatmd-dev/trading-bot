import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSignal} from '../src/postgres/domain.js';
import {evaluateRisk} from '../src/postgres/risk.js';
import {ledgerMethods} from '../src/postgres/ledger.js';
import {D, exact, amount} from '../src/money.js';

test('normalizeSignal parses target_trade_id and position_id correctly', () => {
  const base = {
    trade_id: 'exit-order-1',
    broker: 'binance-global',
    symbol: 'BTCUSDT',
    event: 'TP',
    side: 'SELL',
    timestamp: Date.now(),
    quantity: 0.5,
    target_trade_id: 'entry-order-1'
  };

  const parsed1 = normalizeSignal(base);
  assert.equal(parsed1.targetTradeId, 'entry-order-1');

  const parsed2 = normalizeSignal({
    ...base,
    target_trade_id: undefined,
    position_id: 'pos_custom_123'
  });
  assert.equal(parsed2.targetTradeId, 'pos_custom_123');

  const parsed3 = normalizeSignal({
    ...base,
    target_trade_id: undefined
  });
  assert.equal(parsed3.targetTradeId, '');
});

test('evaluateRisk (Postgres) sizes to targetAllocation and rejects missing/closed allocation', () => {
  const baseExit = {
    tradeId: 'tp-1',
    broker: 'binance-global',
    symbol: 'BTCUSDT',
    event: 'TP',
    side: 'SELL',
    reduceOnly: true,
    orderType: 'MARKET',
    timestamp: Date.now(),
    riskMode: 'PERCENT_EQUITY',
    referencePrice: 65000,
    leverage: 1,
    volatilityPercent: 0,
    newsRisk: false,
    targetTradeId: 'buy-p1'
  };

  const policy = {
    maxRiskPercent: 1,
    maxOrderNotional: 100000,
    maxDailyNotional: 500000,
    maxTradesPerDay: 50,
    maxDailyLossR: 5,
    maxOpenPositions: 5,
    onePositionPerSymbol: false,
    pauseAfterLossStreak: 5,
    maxSignalAgeSeconds: 60,
    blockHighVolatility: false,
    blockDuringNews: false,
    sideMode: 'BOTH'
  };

  const context = {
    policy,
    daily: {trades: 0, notional: '0', realized_r: '0', loss_streak: 0},
    position: {quantity: '3.000000000000000000', avg_price: '60000.000000000000000000'},
    targetAllocation: {position_id: 'pos_1', remaining_quantity: '1.000000000000000000'},
    equity: '100000',
    balance: '100000',
    cashAvailable: '100000',
    licensed: true,
    globalKill: false,
    openPositions: 1,
    hasPendingOrder: false
  };

  // 1. Valid target allocation with omitted quantity -> defaults to targetAllocation remaining quantity
  const res = evaluateRisk(baseExit, context);
  assert.equal(res.ok, true);
  assert.equal(res.order.quantity, '1');

  // 2. Missing target allocation -> rejected
  const missing = evaluateRisk(baseExit, {...context, targetAllocation: null});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'Target allocation not found or already closed');

  // 3. Target allocation with 0 remaining -> rejected
  const closed = evaluateRisk(baseExit, {...context, targetAllocation: {position_id: 'pos_1', remaining_quantity: '0'}});
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'Target allocation not found or already closed');

  // 4. Oversized exit quantity capped to targetAllocation remaining quantity
  const oversized = evaluateRisk({...baseExit, quantity: 2.5}, context);
  assert.equal(oversized.ok, true);
  assert.equal(oversized.order.quantity, '1');
  assert.equal(oversized.order.sizingAdjustment.reason, 'Capped to available target allocation quantity');

  // 5. Untargeted exit (general SELL/TP/SL without targetTradeId) -> closes aggregate position
  const untargeted = evaluateRisk({...baseExit, targetTradeId: ''}, context);
  assert.equal(untargeted.ok, true);
  assert.equal(untargeted.order.quantity, '3');
});

test('multi-entry ledger lifecycle: P1 and P2 independent positions and targeted exits', async () => {
  // In-memory mock store for Postgres ledgerMethods
  const tables = {
    signals: new Map(),
    allocations: [],
    positions: new Map(),
    cashJournal: [],
    fills: [],
    daily: new Map()
  };

  const store = {
    db: {
      isTransaction: true,
      transaction: async fn => fn(),
      prepare(sql) {
        return {
          get: async (...params) => {
            if (sql.includes('FROM users WHERE id=?')) return {id: params[0]};
            if (sql.includes('FROM signals WHERE id=?')) return tables.signals.get(params[0]);
            if (sql.includes('SUM(cost_basis)')) return {amount: '0'};
            if (sql.includes('FROM ledger_positions WHERE user_id=? AND account_id=?')) {
              const [userId, accountId, mode, symbol] = params;
              const key = `${userId}:${accountId}:${mode}:${symbol}`;
              return tables.positions.get(key);
            }
            if (sql.includes('FROM paper_funding')) return {equity: '500000', cash: '500000'};
            if (sql.includes('FROM paper_cash_journal')) {
              const sum = tables.cashJournal.reduce((acc, row) => acc.plus(row.cash_delta), D(0));
              return {amount: sum.toFixed()};
            }
            if (sql.includes('SELECT stop_loss,take_profit FROM ledger_position_allocations')) {
              const open = tables.allocations.filter(a => a.status === 'OPEN' && D(a.remaining_quantity).gt(0));
              return open.length ? open[open.length - 1] : undefined;
            }
            return undefined;
          },
          all: async (...params) => {
            if (sql.includes('FROM ledger_position_allocations')) {
              const [userId, accountId, mode, symbol] = params.slice(0, 4);
              let list = tables.allocations.filter(a =>
                a.user_id === userId && a.account_id === accountId &&
                a.execution_mode === mode && a.symbol === symbol &&
                a.status === 'OPEN' && D(a.remaining_quantity).gt(0)
              );
              if (params.length > 4) {
                const target = params[4];
                list = list.filter(a => a.entry_trade_id === target || a.position_id === target);
              }
              return list;
            }
            return [];
          },
          run: async (...params) => {
            if (sql.includes('INSERT INTO ledger_position_allocations')) {
              const [
                position_id, user_id, account_id, execution_mode, broker, symbol,
                entry_signal_id, entry_trade_id, status, filled_quantity, remaining_quantity,
                entry_price, stop_loss, take_profit, opened_at, updated_at
              ] = params;
              tables.allocations.push({
                position_id, user_id, account_id, execution_mode, broker, symbol,
                entry_signal_id, entry_trade_id, status, filled_quantity, remaining_quantity,
                entry_price, stop_loss, take_profit, opened_at, updated_at
              });
              return {changes: 1};
            }
            if (sql.includes('UPDATE ledger_position_allocations')) {
              const [rem, st, closedAt, updAt, posId] = params;
              const alloc = tables.allocations.find(a => a.position_id === posId);
              if (alloc) {
                alloc.remaining_quantity = rem;
                alloc.status = st;
                alloc.closed_at = closedAt;
                alloc.updated_at = updAt;
              }
              return {changes: 1};
            }
            if (sql.includes('INSERT INTO paper_cash_journal')) {
              tables.cashJournal.push({cash_delta: params[4]});
              return {changes: 1};
            }
            if (sql.includes('INSERT INTO ledger_positions')) {
              const [userId, accountId, mode, broker, symbol, qty, avgPrice, sl, tp, initRisk, pnl, updAt, cost] = params;
              const key = `${userId}:${accountId}:${mode}:${symbol}`;
              tables.positions.set(key, {
                user_id: userId, account_id: accountId, execution_mode: mode, broker, symbol,
                quantity: qty, avg_price: avgPrice, stop_loss: sl, take_profit: tp,
                initial_risk: initRisk, cumulative_pnl: pnl, updated_at: updAt, cost_basis: cost
              });
              return {changes: 1};
            }
            return {changes: 1};
          }
        };
      }
    },
    ...ledgerMethods,
    snapshotPaper: async () => {},
    complete: async () => {},
    audit: async () => {}
  };

  const userId = 'u1';
  const broker = 'binance-global';
  const accountId = 'binance-global:primary';
  const symbol = 'BTCUSDT';

  // 1. Entry P1: BUY 1.0 BTC @ 60,000, SL=58000, TP=65000
  const job1 = {
    id: 1,
    user_id: userId,
    trade_id: 'BUY-P1',
    execution_mode: 'PAPER',
    broker,
    symbol,
    account_id: accountId,
    client_order_id: 'c1',
    applied_quantity: '0',
    applied_quote: '0',
    status: 'PROCESSING',
    payload: JSON.stringify({tradeId: 'BUY-P1'})
  };
  tables.signals.set(1, job1);

  const order1 = {side: 'BUY', quantity: '1.000000000000000000', price: '60000.000000000000000000', stopLoss: 58000, takeProfit: 65000};
  await store.recordExecution(job1, {
    status: 'FILLED',
    executedQty: '1.000000000000000000',
    quoteQty: '60000.000000000000000000',
    deltaFeeQuote: '0',
    raw: {paper: true}
  }, order1);

  assert.equal(tables.allocations.length, 1);
  assert.equal(tables.allocations[0].entry_trade_id, 'BUY-P1');
  assert.equal(tables.allocations[0].remaining_quantity, '1');
  assert.equal(tables.allocations[0].status, 'OPEN');

  const pos1 = await store.ledgerPosition(job1);
  assert.equal(pos1.quantity, '1');
  assert.equal(pos1.cost_basis, '60000');
  assert.equal(pos1.stop_loss, 58000);
  assert.equal(pos1.take_profit, 65000);

  // 2. Entry P2: Scale-in BUY 2.0 BTC @ 61,000, SL=59000, TP=66000
  const job2 = {
    id: 2,
    user_id: userId,
    trade_id: 'BUY-P2',
    execution_mode: 'PAPER',
    broker,
    symbol,
    account_id: accountId,
    client_order_id: 'c2',
    applied_quantity: '0',
    applied_quote: '0',
    status: 'PROCESSING',
    payload: JSON.stringify({tradeId: 'BUY-P2'})
  };
  tables.signals.set(2, job2);

  const order2 = {side: 'BUY', quantity: '2.000000000000000000', price: '61000.000000000000000000', stopLoss: 59000, takeProfit: 66000};
  await store.recordExecution(job2, {
    status: 'FILLED',
    executedQty: '2.000000000000000000',
    quoteQty: '122000.000000000000000000',
    deltaFeeQuote: '0',
    raw: {paper: true}
  }, order2);

  assert.equal(tables.allocations.length, 2);
  assert.equal(tables.allocations[1].entry_trade_id, 'BUY-P2');
  assert.equal(tables.allocations[1].remaining_quantity, '2');

  const pos2 = await store.ledgerPosition(job2);
  assert.equal(pos2.quantity, '3');
  assert.equal(pos2.cost_basis, '182000');

  // 3. Targeted TP for P1: closes 1.0 BTC @ 65,000
  const jobExitP1 = {
    id: 3,
    user_id: userId,
    trade_id: 'TP-P1',
    execution_mode: 'PAPER',
    broker,
    symbol,
    account_id: accountId,
    client_order_id: 'c3',
    applied_quantity: '0',
    applied_quote: '0',
    status: 'PROCESSING',
    payload: JSON.stringify({tradeId: 'TP-P1', targetTradeId: 'BUY-P1'})
  };
  tables.signals.set(3, jobExitP1);

  const orderExitP1 = {side: 'SELL', quantity: '1.000000000000000000', price: '65000.000000000000000000'};
  await store.recordExecution(jobExitP1, {
    status: 'FILLED',
    executedQty: '1.000000000000000000',
    quoteQty: '65000.000000000000000000',
    deltaFeeQuote: '0',
    raw: {paper: true}
  }, orderExitP1);

  // Verification: P1 is CLOSED, P2 is still OPEN with 2.0 BTC!
  assert.equal(tables.allocations[0].status, 'CLOSED');
  assert.equal(tables.allocations[0].remaining_quantity, '0');

  assert.equal(tables.allocations[1].status, 'OPEN');
  assert.equal(tables.allocations[1].remaining_quantity, '2');

  const posAfterP1Exit = await store.ledgerPosition(jobExitP1);
  assert.equal(posAfterP1Exit.quantity, '2');
  assert.equal(posAfterP1Exit.cost_basis, '122000');
  assert.equal(posAfterP1Exit.stop_loss, 59000);
  assert.equal(posAfterP1Exit.take_profit, 66000);

  // 4. Attempt exit targeting already closed P1 -> MUST THROW ERROR (no fallback to closing P2)
  const jobExitInvalid = {
    id: 4,
    user_id: userId,
    trade_id: 'TP-P1-REPLAY',
    execution_mode: 'PAPER',
    broker,
    symbol,
    account_id: accountId,
    client_order_id: 'c4',
    applied_quantity: '0',
    applied_quote: '0',
    status: 'PROCESSING',
    payload: JSON.stringify({tradeId: 'TP-P1-REPLAY', targetTradeId: 'BUY-P1'})
  };
  tables.signals.set(4, jobExitInvalid);

  await assert.rejects(
    async () => {
      await store.recordExecution(jobExitInvalid, {
        status: 'FILLED',
        executedQty: '1.000000000000000000',
        quoteQty: '65000.000000000000000000',
        deltaFeeQuote: '0',
        raw: {paper: true}
      }, orderExitP1);
    },
    /Target allocation not found or already closed/
  );

  // P2 remains completely OPEN and unaffected!
  assert.equal(tables.allocations[1].status, 'OPEN');
  assert.equal(tables.allocations[1].remaining_quantity, '2');

  // 5. Targeted SL for P2: closes remaining 2.0 BTC @ 59,000
  const jobExitP2 = {
    id: 5,
    user_id: userId,
    trade_id: 'SL-P2',
    execution_mode: 'PAPER',
    broker,
    symbol,
    account_id: accountId,
    client_order_id: 'c5',
    applied_quantity: '0',
    applied_quote: '0',
    status: 'PROCESSING',
    payload: JSON.stringify({tradeId: 'SL-P2', targetTradeId: 'BUY-P2'})
  };
  tables.signals.set(5, jobExitP2);

  const orderExitP2 = {side: 'SELL', quantity: '2.000000000000000000', price: '59000.000000000000000000'};
  await store.recordExecution(jobExitP2, {
    status: 'FILLED',
    executedQty: '2.000000000000000000',
    quoteQty: '118000.000000000000000000',
    deltaFeeQuote: '0',
    raw: {paper: true}
  }, orderExitP2);

  assert.equal(tables.allocations[1].status, 'CLOSED');
  assert.equal(tables.allocations[1].remaining_quantity, '0');

  const posAfterP2Exit = await store.ledgerPosition(jobExitP2);
  assert.equal(posAfterP2Exit.quantity, '0');
  assert.equal(posAfterP2Exit.cost_basis, '0');
  assert.equal(posAfterP2Exit.stop_loss, null);
  assert.equal(posAfterP2Exit.take_profit, null);
});