import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSignal} from '../src/domain.js';

test('normalizeSignal parses target_trade_id and position_id correctly', () => {
  const base = {
    trade_id: 'exit-order-1',
    broker: 'binance',
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