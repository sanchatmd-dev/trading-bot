import path from 'node:path';

const num = (name, fallback, min = 0) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
};
const bool = (name, fallback) => {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name}`);
  return value === 'true';
};

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: num('PORT', 8080, 1),
  dbPath: process.env.DB_PATH || path.resolve('data/astra-v2.db'),
  paperTrading: bool('PAPER_TRADING', true),
  workerIntervalMs: num('WORKER_INTERVAL_MS', 250, 50),
  sessionTtlHours: num('SESSION_TTL_HOURS', 24, 1),
  masterKey: process.env.MASTER_ENCRYPTION_KEY || 'development-key-change-me',
  adminEmail: String(process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase(),
  adminPassword: process.env.ADMIN_BOOTSTRAP_PASSWORD || 'change-this-immediately',
  smtp: {
    host: process.env.SMTP_HOST || '', port: num('SMTP_PORT', 587, 1), secure: bool('SMTP_SECURE', false),
    user: process.env.SMTP_USER || '', password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'Astra Trade <bot@example.com>'
  },
  defaultRisk: {
    paperTrading: bool('PAPER_TRADING', true), killSwitch: false,
    maxRiskPercent: num('MAX_RISK_PERCENT', 1, 0.01), maxOrderNotional: num('MAX_ORDER_NOTIONAL', 1000, 0.01),
    maxDailyNotional: num('MAX_DAILY_NOTIONAL', 5000, 0.01), maxTradesPerDay: num('MAX_TRADES_PER_DAY', 10, 1),
    maxDailyLossR: num('MAX_DAILY_LOSS_R', 3, 0.01), maxOpenPositions: num('MAX_OPEN_POSITIONS', 3, 1),
    onePositionPerSymbol: bool('ONE_POSITION_PER_SYMBOL', true), pauseAfterLossStreak: num('PAUSE_AFTER_LOSS_STREAK', 3, 1),
    maxSignalAgeSeconds: num('MAX_SIGNAL_AGE_SECONDS', 60, 1), maxVolatilityPercent: num('MAX_VOLATILITY_PERCENT', 5, 0),
    blockHighVolatility: bool('BLOCK_HIGH_VOLATILITY', true), blockDuringNews: bool('BLOCK_DURING_NEWS', true),
    sideMode: String(process.env.SIDE_MODE || 'BOTH').toUpperCase(), requireReduceOnlySell: bool('REQUIRE_REDUCE_ONLY_SELL', true),
    allowedSymbols: [], equities: {}
  }
};

export function assertProductionConfig() {
  if(!config.paperTrading)throw new Error('PAPER_TRADING=false is disabled in this staging release');
  if (process.env.NODE_ENV !== 'production') return;
  if (!/^[a-fA-F0-9]{64}$/.test(config.masterKey)) throw new Error('MASTER_ENCRYPTION_KEY must be 64 hex characters');
}
