import {D,exact} from '../money.js';
import {supportedBrokers} from '../adapters/registry.js';
import {booleanValue} from '../http-safety.js';

export function validateRisk(input, current, defaultRisk) {
  const next = {
    ...current,
    paperTrading: true,
    equities: {
      ...(current.equities || {})
    },
    balances: {
      ...(current.balances || {})
    },
    defaults: {
      ...defaultRisk.defaults,
      ...(current.defaults || {})
    }
  };
  const ranges = {
    maxRiskPercent: [.01, 100],
    maxOrderNotional: [.01, 1e12],
    maxDailyNotional: [.01, 1e13],
    maxTradesPerDay: [1, 10000],
    maxDailyLossR: [.01, 1000],
    maxOpenPositions: [1, 1000],
    pauseAfterLossStreak: [1, 100],
    maxSignalAgeSeconds: [1, 3600],
    maxVolatilityPercent: [0, 1000]
  };
  for (const [k, [min, max]] of Object.entries(ranges)) {
    if (input[k] === undefined) continue;
    const n = input[k];
    if(['maxOrderNotional','maxDailyNotional'].includes(k)){
      const value=exact(n);if(D(value).lt(min)||D(value).gt(max))throw new Error(`Invalid ${k}`);next[k]=value;continue;
    }
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${k}`);
    if (['maxTradesPerDay', 'maxOpenPositions', 'pauseAfterLossStreak', 'maxSignalAgeSeconds'].includes(k) && !Number.isInteger(n)) throw new Error(`${k} must be an integer`);
    next[k] = n;
  }
  const defaultFields = {
    riskPercent: ['maxRiskPercent', .01],
    tradesPerDay: ['maxTradesPerDay', 1],
    dailyLossR: ['maxDailyLossR', .01],
    lossStreak: ['pauseAfterLossStreak', 1],
    openPositions: ['maxOpenPositions', 1],
    signalAgeSeconds: ['maxSignalAgeSeconds', 1],
    orderNotional: ['maxOrderNotional', .01],
    dailyNotional: ['maxDailyNotional', .01],
    volatilityPercent: ['maxVolatilityPercent', 0]
  };
  if (input.defaults !== undefined) {
    if (!input.defaults || typeof input.defaults !== 'object' || Array.isArray(input.defaults)) throw new Error('Invalid defaults');
    for (const [key, [maxKey, min]] of Object.entries(defaultFields)) {
      if (input.defaults[key] === undefined) continue;
      const n = input.defaults[key];
      if(['orderNotional','dailyNotional'].includes(key)){
        const value=exact(n);if(D(value).lt(min)||D(value).gt(next[maxKey]))throw new Error(`Default ${key} must not exceed ${maxKey}`);next.defaults[key]=value;continue;
      }
      if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > next[maxKey]) throw new Error(`Default ${key} must not exceed ${maxKey}`);
      if (['tradesPerDay', 'lossStreak', 'openPositions', 'signalAgeSeconds'].includes(key) && !Number.isInteger(n)) throw new Error(`Default ${key} must be an integer`);
      next.defaults[key] = n;
    }
  }
  for (const [key, [maxKey]] of Object.entries(defaultFields)) if (D(next.defaults[key]).gt(next[maxKey])) throw new Error(`Default ${key} must not exceed ${maxKey}`);
  for (const key of ['paperTrading', 'killSwitch', 'onePositionPerSymbol', 'blockHighVolatility', 'blockDuringNews', 'requireReduceOnlySell', 'capPercentEquitySize']) if (input[key] !== undefined) next[key] = booleanValue(input[key], key);
  if (!next.paperTrading) throw new Error('Live is locked in this Paper staging release');
  if (!next.requireReduceOnlySell) throw new Error('Spot reduce-only protection cannot be disabled');
  if (input.sideMode !== undefined) {
    if (!['BOTH', 'BUY_ONLY', 'SELL_ONLY'].includes(input.sideMode)) throw new Error('Invalid sideMode');
    next.sideMode = input.sideMode;
  }
  if (input.allowedSymbols !== undefined) {
    if (!Array.isArray(input.allowedSymbols) || input.allowedSymbols.length > 500 || input.allowedSymbols.some(x => typeof x !== 'string' || !/^[A-Z0-9._-]{1,30}$/.test(x))) throw new Error('Invalid allowedSymbols');
    next.allowedSymbols = [...new Set(input.allowedSymbols)];
  }
  if (input.equities !== undefined) {
    if (!input.equities || typeof input.equities !== 'object' || Array.isArray(input.equities)) throw new Error('Invalid equities');
    for (const [broker, n] of Object.entries(input.equities)) {
      const value=exact(n);if (!supportedBrokers.includes(broker) || D(value).lt(0) || D(value).gt('1000000000000')) throw new Error('Invalid equity');
      next.equities[broker] = value;
    }
  }
  if (input.balances !== undefined) {
    if (!input.balances || typeof input.balances !== 'object' || Array.isArray(input.balances)) throw new Error('Invalid balances');
    for (const [broker, n] of Object.entries(input.balances)) {
      const value=exact(n);if (!supportedBrokers.includes(broker) || D(value).lt(0) || D(value).gt('1000000000000')) throw new Error('Invalid balance');
      if (D(value).gt(next.equities[broker] ?? 0)) throw new Error('Balance cannot exceed Total Equity');
      next.balances[broker] = value;
    }
  }
  for (const [broker, balance] of Object.entries(next.balances)) if (D(balance).gt(next.equities[broker] ?? 0)) throw new Error('Balance cannot exceed Total Equity');
  return next;
}
