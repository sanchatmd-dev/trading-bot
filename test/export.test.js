import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSignal} from '../src/postgres/domain.js';
import {evaluateRisk} from '../src/postgres/risk.js';

test('normalizeSignal parses QL-4 export metadata fields', () => {
  const now = 1700000000000;
  const payload = {
    trade_id: 'EXP-BUY-101',
    broker: 'Binance Global',
    symbol: 'BTCUSDT',
    event: 'BUY',
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 100,
    timestamp: now,
    alert_source: 'alert_calls',
    strategy_id: 'synthetic-ema-v1',
    strategy_version: '1.0.0',
    deployment_id: 'dep_opt_42'
  };

  const signal = normalizeSignal(payload, now);
  assert.equal(signal.tradeId, 'EXP-BUY-101');
  assert.equal(signal.broker, 'binance-global');
  assert.equal(signal.symbol, 'BTCUSDT');
  assert.equal(signal.event, 'BUY');
  assert.equal(signal.alertSource, 'alert_calls');
  assert.equal(signal.strategyId, 'synthetic-ema-v1');
  assert.equal(signal.strategyVersion, '1.0.0');
  assert.equal(signal.deploymentId, 'dep_opt_42');
});

test('exported alert_calls payload format parses and evaluates risk', () => {
  const now = 1700000000000;
  const buyPayload = {
    trade_id: 'ENTRY-1700000000',
    broker: 'binance-global',
    symbol: 'BTCUSDT',
    event: 'BUY',
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 100.0,
    entry_price: 64000.00,
    stop_loss: 62000.50,
    take_profit: 68000.00,
    timestamp: now,
    alert_source: 'alert_calls'
  };

  const buySignal = normalizeSignal(buyPayload, now);
  assert.equal(buySignal.event, 'BUY');
  assert.equal(buySignal.stopLoss, '62000.5');
  assert.equal(buySignal.takeProfit, '68000');
  assert.equal(buySignal.referencePrice, '64000');
  assert.equal(buySignal.alertSource, 'alert_calls');

  const tpPayload = {
    trade_id: 'TP-ENTRY-1700000000',
    broker: 'binance-global',
    symbol: 'BTCUSDT',
    event: 'TP',
    target_trade_id: 'ENTRY-1700000000',
    entry_price: 68000.00,
    take_profit: 68000.00,
    timestamp: now,
    alert_source: 'alert_calls'
  };

  const tpSignal = normalizeSignal(tpPayload, now);
  assert.equal(tpSignal.event, 'TP');
  assert.equal(tpSignal.targetTradeId, 'ENTRY-1700000000');
  assert.equal(tpSignal.referencePrice, '68000');
  assert.equal(tpSignal.reduceOnly, true);

  const context = {
    now,
    policy: {maxSignalAgeSeconds: 60},
    daily: {},
    position: {quantity: '0.5'},
    targetAllocation: {
      position_id: 'ENTRY-1700000000',
      entry_trade_id: 'ENTRY-1700000000',
      remaining_quantity: '0.5'
    },
    equity: '10000',
    balance: '10000',
    hasPendingOrder: false
  };

  const riskResult = evaluateRisk(tpSignal, context);
  assert.equal(riskResult.ok, true);
  assert.equal(riskResult.order.quantity, '0.5');
});

test('exported order_fills payload format parses correctly with simulated TradingView order ID', () => {
  const now = 1700000000000;
  const fillPayload = {
    trade_id: 'ORD-1700000000',
    broker: 'binance-global',
    symbol: 'BTCUSDT',
    event: 'BUY',
    risk_mode: 'PERCENT_EQUITY',
    risk_value: 100.0,
    entry_price: 64000.00,
    stop_loss: 61500.00,
    take_profit: 67500.00,
    timestamp: now,
    alert_source: 'order_fills'
  };

  const signal = normalizeSignal(fillPayload, now);
  assert.equal(signal.tradeId, 'ORD-1700000000');
  assert.equal(signal.alertSource, 'order_fills');
  assert.equal(signal.stopLoss, '61500');
});
