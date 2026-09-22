import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertProductionConfig } from '../config.js';
import { Store } from './store.js';
import { hashPassword, verifyPassword, randomToken, encryptJson, decryptJson, hashToken } from '../security.js';
import { normalizeSignal, normalizeSymbol } from './domain.js';
import { evaluateRisk } from './risk.js';
import { analyticsWindow, fifoAnalytics, analyticsCapital, filterClosedPositions, summarizeClosedPositions, breakdownClosedPositions, groupClosedPositions, currencyForBroker } from './analytics.js';
import { supportedBrokers, capabilities, validateCredentials } from '../adapters/registry.js';
import {booleanValue, clientIp} from '../http-safety.js';
import {readJson,preloadJson} from './http.js';
import { PostgresDatabase } from './db.js';
import {Auth} from './auth.js';
import {D,Money,amount,exact} from '../money.js';
import { hasPermission, adminPermission } from '../permissions.js';
import { getQuota } from './quotas.js';
assertProductionConfig();
const database = new PostgresDatabase();
await database.runtimeLock();
await database.verifySchema();
const store = new Store(database);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
await database.transaction(async()=>{
await database.lock('robot:bootstrap');
if (!(await store.userCount())) {
  if (process.env.NODE_ENV === 'production' && config.adminPassword === 'change-this-immediately') throw new Error('ADMIN_BOOTSTRAP_PASSWORD must be changed for first boot');
  const admin = await store.createUser({
    email: config.adminEmail,
    passwordHash: await hashPassword(config.adminPassword),
    role: 'ADMIN'
  });
  await store.setRisk(admin.id, {
    ...config.defaultRisk,
    paperTrading: true
  });
  console.log(`Bootstrap admin created: ${admin.email}`);
}
});
const worker = {
  stopping: false,
  lastTick: Date.now(),
  lastError: null,
  stop: async () => {
    worker.stopping = true;
  }
};
const json = (res, status, body) => {
  if(res.phase2Buffer){res.phase2Result={status,body};return;}
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
};
const auth = new Auth(store, config, json);
const requireSession = async req => await auth.require(req);
const requireAdmin = async (req, res, url) => {
  const user = await auth.require(req),
    permission = adminPermission(req.method, url.pathname);
  if (!permission || !hasPermission(user, permission)) {
    json(res, 403, {
      error: 'Permission denied'
    });
    return null;
  }
  await auth.sensitive(req);
  return user;
};
const safeLimit = url => Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
// Trust only the right-most address from the explicitly configured loopback proxy.
const loginKey = req => clientIp(req, config.trustLoopbackProxy);
const analyticsBrokers = ['binance-global', 'binance-th', 'innovestx', 'settrade'];
async function analyticsData(url, targetUserId) {
  const broker = String(url.searchParams.get('broker') || 'binance-global');
  if (!analyticsBrokers.includes(broker)) throw new Error('Analytics requires a supported Spot broker');
  const period = String(url.searchParams.get('period') || 'monthly').toLowerCase();
  const window = analyticsWindow(period, url.searchParams.get('from'), url.searchParams.get('to'));
  const rawSymbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (rawSymbol && !/^[A-Z0-9._:/-]{1,40}$/.test(rawSymbol)) throw new Error('Invalid analytics symbol');
  const symbol = rawSymbol ? normalizeSymbol(rawSymbol, broker) : '';
  const feeBps = await store.analyticsFeeBps(targetUserId, broker),
    currency = currencyForBroker(broker);
  const fills = await store.analyticsRows(targetUserId, broker),
    all = fifoAnalytics(fills, {
      feeBps
    });
  const basis = analyticsCapital(await store.paperFunding(targetUserId, broker), all.realizations, fills, window);
  basis.legacyPrecisionAdjustments = all.legacyAdjustments;
  const closed = filterClosedPositions(all.closedPositions, {
    ...window,
    symbol
  });
  const realizations = filterClosedPositions(all.realizations, {
    ...window,
    symbol
  });
  const options = {
    ...basis,
    currency,
    realizations
  };
  return {
    targetUserId,
    broker,
    currency,
    symbol: symbol || null,
    feeBps,
    startingEquity: basis.startingEquity,
    basis,
    options,
    window,
    closed,
    summary: summarizeClosedPositions(closed, options)
  };
}
function validateRisk(input, current) {
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
      ...config.defaultRisk.defaults,
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
async function userRoutes(req, res, url) {
  const actor = await requireSession(req, res);
  if (!actor) return;
  if (!hasPermission(actor, req.method === 'GET' ? 'own:read' : 'own:write')) return json(res, 403, {
    error: 'Permission denied'
  });
  if (req.method !== 'GET' && (url.pathname === '/api/me/webhook-secret' || url.pathname.startsWith('/api/brokers/')) || url.pathname === '/api/me/password') await auth.sensitive(req);
  if (req.method === 'GET' && url.pathname === '/api/bots') {
    const plan = await store.activePlan(actor.id);
    const quota = getQuota(plan);
    return json(res, 200, {
      bots: await store.listBots(actor.id),
      maxBots: quota.maxBots
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/bots') {
    const plan = await store.activePlan(actor.id);
    const quota = getQuota(plan);
    const bots = await store.listBots(actor.id);
    if (bots.length >= quota.maxBots) {
      return json(res, 403, { error: `Bot limit reached. Your ${plan} plan allows up to ${quota.maxBots} bots.` });
    }
    const body = await readJson(req),
      secret = randomToken();
    const bot = await store.createBot(actor.id, body.label, {
      ...config.defaultRisk,
      paperTrading: true
    }, async id => await store.setWebhookSecret(id, secret, encryptJson({
      secret
    }, config.keyring, `webhook:${id}`)));
    await store.audit(actor.id, 'bot.created', null, {
      botId: bot.id
    });
    return json(res, 201, bot);
  }
  const botRoute = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
  if (req.method === 'PATCH' && botRoute) {
    const id = botRoute[1];
    if (!(await store.ownsBot(actor.id, id))) return json(res, 404, {
      error: 'Bot not found'
    });
    const body = await readJson(req);
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 80) throw new Error('Bot label must contain 1–80 characters');
    await store.db.prepare('UPDATE users SET label=? WHERE id=?').run(body.label.trim(), id);
    await store.audit(actor.id, 'bot.renamed', null, {
      botId: id
    });
    return json(res, 200, await store.userById(id));
  }
  // --- Bot Lifecycle ---
  const lifecycleBotId = String(url.searchParams.get('bot_id') || actor.id);
  if (url.pathname.startsWith('/api/bot/session') && !(await store.ownsBot(actor.id, lifecycleBotId))) return json(res, 403, { error: 'Bot access denied' });
  if (req.method === 'GET' && url.pathname === '/api/bot/session') {
    const session = await store.getBotSession(lifecycleBotId);
    return json(res, 200, { state: session.state, run_id: session.run_id, started_at: session.started_at, stopped_at: session.stopped_at });
  }
  const lifecycleAction = { '/api/bot/session/run': 'run', '/api/bot/session/pause': 'pause', '/api/bot/session/stop': 'stop', '/api/bot/session/reset': 'reset' }[url.pathname];
  if (req.method === 'POST' && lifecycleAction) {
    const currentPolicy = await store.risk(lifecycleBotId, config.defaultRisk);
    if (lifecycleAction === 'run' && !Object.values(currentPolicy.equities || {}).some(value => D(exact(value)).gt(0))) {
      return json(res, 409, { error: 'Cannot run a bot without funded Paper capital' });
    }
    const paperAccounts = await store.paperAccounts(lifecycleBotId);
    const result = await store.transitionBotState(lifecycleBotId, lifecycleAction, currentPolicy, paperAccounts);
    await store.audit(actor.id, `bot.lifecycle.${lifecycleAction}`, null, { botId: lifecycleBotId, state: result.state, run_id: result.run_id });
    return json(res, 200, result);
  }
  if (req.method === 'GET' && url.pathname === '/api/bot/session/archive') {
    return json(res, 200, { archive: await store.listSessionArchive(lifecycleBotId) });
  }
  const requestedBot = String(url.searchParams.get('bot_id') || actor.id),
    allBots = requestedBot === 'all';
  if (!allBots && !(await store.ownsBot(actor.id, requestedBot))) return json(res, 403, {
    error: 'Bot access denied'
  });
  if (allBots && !['/api/signals', '/api/positions', '/api/me'].includes(url.pathname)) return json(res, 400, {
    error: 'Select one bot for this operation'
  });
  const selected = allBots ? actor.id : requestedBot;
  // Authentication and subscription operations always address the main account.
  const accountRoute = ['/api/me/password', '/api/me/license/redeem'].includes(url.pathname);
  const user = {
      ...actor,
      id: accountRoute ? actor.id : selected
    },
    admin = actor.role === 'ADMIN';
  if (url.pathname.startsWith('/api/analytics/')) {
    const requested = String(url.searchParams.get('user_id') || user.id),
      targetUserId = requested;
    if (!hasPermission(actor, 'analytics:any') && !(await store.ownsBot(actor.id, requested))) return json(res, 403, {
      error: 'Cannot access another user analytics'
    });
    if (!(await store.ownsBot(actor.id, requested))) await auth.sensitive(req);
    if (!(await store.userById(targetUserId))) return json(res, 404, {
      error: 'Analytics user not found'
    });
    if (req.method === 'PUT' && url.pathname === '/api/analytics/settings') {
      const body = await readJson(req),
        broker = String(body.broker || '');
      if (!analyticsBrokers.includes(broker)) return json(res, 400, {
        error: 'Analytics requires a supported Spot broker'
      });
      const feeBps = body.feeBps;
      if (typeof feeBps !== 'number' || !Number.isFinite(feeBps) || feeBps < 0 || feeBps > 1000) return json(res, 400, {
        error: 'feeBps must be between 0 and 1000'
      });
      await store.setAnalyticsFeeBps(targetUserId, broker, feeBps);
      await store.audit(user.id, 'analytics.settings.updated', null, {
        targetUserId,
        broker,
        feeBps
      });
      return json(res, 200, {
        userId: targetUserId,
        broker,
        feeBps
      });
    }
    if (req.method === 'GET' && ['/api/analytics/summary', '/api/analytics/equity-curve', '/api/analytics/breakdown'].includes(url.pathname)) {
      const plan = await store.activePlan(actor.id);
      const quota = getQuota(plan);
      
      const data = await analyticsData(url, targetUserId);
      
      if (quota.historyDays > 0) {
        const minTime = Date.now() - (quota.historyDays * 86400000);
        const reqFromTime = new Date(data.window.fromDate).getTime();
        if (reqFromTime < minTime) {
          return json(res, 403, { error: `Analytics history is limited to ${quota.historyDays} days on the ${plan} plan.` });
        }
      }

      const meta = {
          userId: targetUserId,
          broker: data.broker,
          currency: data.currency,
          symbol: data.symbol,
          period: data.window.period,
          from: data.window.fromDate,
          to: data.window.toDate,
          feeBps: data.feeBps,
          ...data.basis
        };
      if (url.pathname === '/api/analytics/summary') {
        const {
          equityCurve,
          ...summary
        } = data.summary;
        const groups = groupClosedPositions(data.closed, data.window.period, data.options);
        return json(res, 200, {
          ...meta,
          ...summary,
          groups,
          closedPositions: [...data.closed].sort((a, b) => b.exitAt - a.exitAt).slice(0, 50)
        });
      }
      if (url.pathname === '/api/analytics/equity-curve') return json(res, 200, {
        ...meta,
        startingEquity: data.startingEquity,
        series: data.summary.equityCurve
      });
      const assets = breakdownClosedPositions(data.closed, data.options).map(({
        equityCurve,
        ...asset
      }) => asset);
      return json(res, 200, {
        ...meta,
        assets
      });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/me') {
    const dailyAccounts = (await Promise.all((allBots ? await store.listBots(actor.id) : [{
      id: user.id
    }]).map(async bot => (await store.dailyAccounts(bot.id)).map(row => ({
      ...row,
      bot_id: bot.id
    }))))).flat();
    const paperAccounts = (await Promise.all((allBots ? await store.listBots(actor.id) : [{
      id: user.id
    }]).map(async bot => (await store.paperAccounts(bot.id)).map(row => ({
      ...row,
      bot_id: bot.id
    }))))).flat();
    const plan = await store.activePlan(actor.id);
    const quota = getQuota(plan);
    return json(res, 200, {
      user: {
        ...(await store.userById(actor.id))
      },
      security: await auth.state(actor),
      moneyFormat: 'decimal-string',
      bot: await store.userById(user.id),
      allBots,
      plan,
      quota,
      license: admin ? {
        plan: 'ADMIN',
        status: 'ACTIVE',
        expires_at: null
      } : await store.licenseForUser(actor.id),
      risk: {
        ...(await store.risk(user.id, config.defaultRisk)),
        paperTrading: true
      },
      brokers: await store.credentialSummary(user.id),
      globalKill: await store.getSetting('globalKill', false),
      capabilities,
      paperAccounts,
      dailyAccounts,
      daily: {
        trades: dailyAccounts.reduce((sum, x) => sum + x.trades, 0)
      },
      botSession: (({ state, run_id, started_at, stopped_at }) => ({ state, run_id, started_at, stopped_at }))(await store.getBotSession(user.id))
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/me/webhook-secret') {
    const saved = await store.webhookSecret(user.id);
    if (!saved?.webhook_secret_encrypted) return json(res, 200, {
      urlPath: null,
      configured: !!saved?.webhook_secret_hash,
      recoveryRequired: !!saved?.webhook_secret_hash
    });
    const {
      secret
    } = decryptJson(saved.webhook_secret_encrypted, config.keyring, `webhook:${user.id}`);
    if (hashToken(secret) !== saved.webhook_secret_hash) throw new Error('Saved webhook verification failed');
    return json(res, 200, {
      urlPath: `/webhooks/tradingview/${secret}`,
      configured: true,
      recoveryRequired: false
    });
  }
  if (req.method === 'PUT' && url.pathname === '/api/me/webhook-secret') {
    const body = await readJson(req);
    if (typeof body.url !== 'string' || body.url.length > 2048) throw new Error('Invalid webhook URL');
    const match = body.url.trim().match(/(?:^|\/)webhooks\/tradingview\/([a-f0-9]{64})$/);
    const saved = await store.webhookSecret(user.id),
      secret = match?.[1];
    if (!secret || hashToken(secret) !== saved?.webhook_secret_hash) return json(res, 400, {
      error: 'URL does not match your current webhook'
    });
    await store.rememberWebhookSecret(user.id, secret, encryptJson({
      secret
    }, config.keyring, `webhook:${user.id}`));
    await store.audit(user.id, 'webhook.secret.recovered', null, {});
    return json(res, 200, {
      urlPath: `/webhooks/tradingview/${secret}`
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/me/webhook-secret') {
    const secret = randomToken();
    await store.setWebhookSecret(user.id, secret, encryptJson({
      secret
    }, config.keyring, `webhook:${user.id}`));
    await store.audit(actor.id, 'webhook.secret.rotated', null, {
      botId: user.id
    });
    return json(res, 200, {
      secret,
      urlPath: `/webhooks/tradingview/${secret}`
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/me/license/redeem') {
    const body = await readJson(req);
    if (!(await store.redeemLicense(user.id, String(body.licenseKey || '')))) return json(res, 400, {
      error: 'License is invalid, assigned, or expired'
    });
    await store.audit(user.id, 'license.redeemed', null, {});
    return json(res, 200, {
      license: await store.licenseForUser(user.id)
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/me/password') {
    if (!(await auth.limit('password-change:' + actor.id, 10))) return json(res, 429, {
      error: 'Too many verification attempts'
    });
    const body = await readJson(req),
      full = await store.userByEmail(user.email);
    if (!(await verifyPassword(body.currentPassword, full.password_hash))) return json(res, 400, {
      error: 'Current password is incorrect'
    });
    const passwordHash = await hashPassword(body.newPassword);
    await req.validateAuth();
    await store.setPassword(user.id, passwordHash);
    auth.writeCookie(res, auth.cookieName, '', 0);
    await store.audit(actor.id, 'account.password.changed', null, {});
    return json(res, 200, {
      ok: true
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/risk') return json(res, 200, {
    ...(await store.risk(user.id, config.defaultRisk)),
    paperTrading: true
  });
  if (req.method === 'PUT' && url.pathname === '/api/risk') {
    const session = await store.getBotSession(user.id);
    if (session.state === 'RUNNING' || session.state === 'PAUSED') return json(res, 409, { error: `Risk profile is frozen while bot is ${session.state.toLowerCase()}. Stop the bot first.` });
    const policy = validateRisk(await readJson(req), await store.risk(user.id, config.defaultRisk));
    await store.setRisk(user.id, policy);
    await store.audit(user.id, 'risk.updated', null, {
      policy
    });
    return json(res, 200, policy);
  }
  if (req.method === 'POST' && url.pathname === '/api/risk/preview') {
    const body = await readJson(req),
      policy = validateRisk(body.policy || {}, await store.risk(user.id, config.defaultRisk));
    const calculator = body.calculator || {},
      broker = String(calculator.broker || 'binance-global');
    const entry = exact(calculator.entry),
      stopLoss = exact(calculator.stopLoss),
      riskValue = exact(calculator.riskPercent);
    const signal = normalizeSignal({
      trade_id: 'risk-preview',
      broker,
      symbol: String(calculator.symbol || ''),
      event: 'BUY',
      risk_mode: 'PERCENT_EQUITY',
      risk_value: riskValue,
      entry,
      sl: stopLoss,
      volatility_percent: Number(calculator.volatilityPercent ?? 0),
      news_risk: false,
      timestamp: Date.now()
    });
    const row = {
      id: 0,
      user_id: user.id,
      account_id: `${signal.broker}:primary`,
      execution_mode: 'PAPER',
      symbol: signal.symbol,
      broker: signal.broker
    };
    const exposure = await store.exposure(row),
      daily = await store.ledgerDaily(row),
      position = await store.ledgerPosition(row);
    const account = await store.paperAccount(user.id, signal.broker, policy),
      equity = account.bookEquity,
      balance = account.cash;
    const cashAvailable = amount(D(balance).minus(exposure.reservedNotional || 0));
    const result = evaluateRisk(signal, {
      policy,
      daily,
      position,
      equity,
      balance,
      cashAvailable,
      licensed: actor.role === 'ADMIN' || (await store.hasActiveLicense(actor.id)),
      globalKill: await store.getSetting('globalKill', false),
      ...exposure
    });
    const positionsRemaining = Math.max(0, policy.maxOpenPositions - exposure.openPositions);
    const freeBalance = amount(Money.max(0,Money.min(D(equity).minus(exposure.committedNotional || 0),D(cashAvailable))));
    const positionCapacity = result.ok && D(result.order.notional).gt(0) ? Math.min(positionsRemaining,D(freeBalance).div(result.order.notional).floor().toNumber()) : 0;
    return json(res, 200, {
      ...result,
      equity,
      balance,
      freeBalance,
      positionsOpen: exposure.openPositions,
      positionsRemaining,
      positionCapacity,
      dailyRemaining: amount(Money.max(0,D(policy.maxDailyNotional).minus(daily.notional).minus(exposure.reservedNotional || 0)))
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/brokers') return json(res, 200, {
    supported: supportedBrokers,
    capabilities,
    configured: await store.credentialSummary(user.id)
  });
  if (req.method === 'PUT' && url.pathname.startsWith('/api/brokers/')) {
    const broker = decodeURIComponent(url.pathname.slice('/api/brokers/'.length));
    if (!supportedBrokers.includes(broker)) return json(res, 400, {
      error: 'Unsupported broker'
    });
    const body = await readJson(req),
      credentials = validateCredentials(broker, body.credentials);
    const enabled = body.enabled === undefined ? true : booleanValue(body.enabled, 'enabled');
    await store.setCredential(user.id, broker, encryptJson(credentials, config.keyring, `${user.id}:${broker}`), enabled);
    await store.audit(user.id, 'broker.credentials.updated', null, {
      broker,
      enabled
    });
    return json(res, 200, {
      broker,
      configured: true,
      enabled,
      live: false
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/signals') {
    const rows = (await Promise.all((allBots ? await store.listBots(actor.id) : (await store.listBots(actor.id)).filter(bot => bot.id === user.id)).map(async bot => (await store.listSignals(bot.id, false, safeLimit(url))).map(row => ({
      ...row,
      bot_id: bot.id,
      bot_label: bot.label
    }))))).flat();
    return json(res, 200, rows.sort((a, b) => b.id - a.id).slice(0, safeLimit(url)));
  }
  const noteRoute = url.pathname.match(/^\/api\/signals\/(\d+)\/note$/);
  if (req.method === 'PUT' && noteRoute) {
    const body = await readJson(req);
    if (!(await store.setRejectedNote({
      ...user,
      role: 'USER'
    }, Number(noteRoute[1]), body.note))) return json(res, 404, {
      error: 'Signal not found'
    });
    return json(res, 200, {
      ok: true
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/audit') return json(res, 200, await store.listAudit(user.id, false, safeLimit(url)));
  if (req.method === 'GET' && url.pathname === '/api/positions') return json(res, 200, (await Promise.all((allBots ? await store.listBots(actor.id) : (await store.listBots(actor.id)).filter(bot => bot.id === user.id)).map(async bot => (await store.listPositions(bot.id)).map(row => ({
    ...row,
    bot_id: bot.id,
    bot_label: bot.label
  }))))).flat());
  return json(res, 404, {
    error: 'Not found'
  });
}
async function adminRoutes(req, res, url) {
  const admin = await requireAdmin(req, res, url);
  if (!admin) return;
  if (req.method === 'GET' && url.pathname === '/api/admin/health') return json(res, 200, {
    ...(await store.health()),
    workerLastTick: await store.workerLastTick(),
    workerError: worker.lastError || null,
    unknown: (await store.db.prepare("SELECT count(*) n FROM signals WHERE status='UNKNOWN'").get()).n,
    notifications: await store.db.prepare('SELECT status,count(*) count FROM notification_outbox GROUP BY status').all(),
    liveEnabled: false
  });
  if (req.method === 'GET' && url.pathname === '/api/admin/users') return json(res, 200, await store.listUsers());
  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    const body = await readJson(req),
      email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(res, 400, {
      error: 'Valid email required'
    });
    const role = body.role || 'USER';
    if (!['USER', 'SUPPORT', 'ADMIN'].includes(role)) return json(res, 400, {
      error: 'Invalid role'
    });
    const passwordHash = await hashPassword(body.password);
    await req.validateAuth();
    const user = await store.createUser({
      email,
      passwordHash,
      role
    });
    await store.setRisk(user.id, {
      ...config.defaultRisk,
      paperTrading: true
    });
    await store.audit(admin.id, 'admin.user.created', null, {
      userId: user.id,
      email,
      role
    });
    return json(res, 201, user);
  }
  if (req.method === 'PUT' && /^\/api\/admin\/users\/[^/]+\/role$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4],
      body = await readJson(req),
      target = await store.userById(id);
    if (!target || target.parent_user_id) return json(res, 404, {
      error: 'User not found'
    });
    if (id === admin.id) return json(res, 400, {
      error: 'Cannot change your own role'
    });
    if (!['USER', 'SUPPORT', 'ADMIN'].includes(body.role)) return json(res, 400, {
      error: 'Invalid role'
    });
    await store.db.transaction(async () => {
      await store.db.prepare('UPDATE users SET role=? WHERE id=?').run(body.role, id);
      await store.revokeSessions(id);
      await store.audit(admin.id, 'admin.user.role_changed', null, {
        userId: id,
        role: body.role
      });
    });
    return json(res, 200, {
      id,
      role: body.role
    });
  }
  if (req.method === 'PUT' && /^\/api\/admin\/users\/[^/]+\/status$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4],
      body = await readJson(req),
      status = String(body.status).toUpperCase(),
      target = await store.userById(id);
    if (!target || target.parent_user_id) return json(res, 404, {
      error: 'User not found'
    });
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) return json(res, 400, {
      error: 'Invalid status'
    });
    if (id === admin.id && status !== 'ACTIVE') return json(res, 400, {
      error: 'Cannot suspend current admin'
    });
    await store.setUserStatus(id, status);
    await store.audit(admin.id, 'admin.user.status_changed', null, {
      userId: id,
      status
    });
    return json(res, 200, {
      id,
      status
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/licenses') return json(res, 200, await store.listLicenses());
  if (req.method === 'POST' && url.pathname === '/api/admin/licenses') {
    const body = await readJson(req),
      days = Math.min(3650, Math.max(1, Number(body.days || 30))),
      key = `ASTRA-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}-${randomToken(4).toUpperCase()}`,
      license = await store.createLicense({
        key,
        plan: String(body.plan || 'PERSONAL').toUpperCase(),
        expiresAt: Date.now() + days * 86400000
      });
    await store.audit(admin.id, 'admin.license.created', null, {
      licenseId: license.id,
      plan: license.plan,
      days
    });
    return json(res, 201, license);
  }
  if (req.method === 'PUT' && /^\/api\/admin\/licenses\/[^/]+\/status$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4],
      body = await readJson(req),
      status = String(body.status).toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(status)) return json(res, 400, {
      error: 'Invalid status'
    });
    await store.setLicenseStatus(id, status);
    return json(res, 200, {
      id,
      status
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/global-kill') {
    const body = await readJson(req),
      enabled = booleanValue(body.enabled, 'enabled');
    await store.setSetting('globalKill', enabled);
    await store.audit(admin.id, 'admin.global_kill', null, {
      enabled
    });
    return json(res, 200, {
      globalKill: enabled,
      semantics: 'PAUSE_ENTRIES'
    });
  }
  return json(res, 404, {
    error: 'Not found'
  });
}
function serve(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1),
    file = path.resolve(publicDir, requested);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json'
  }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public,max-age=3600'
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
async function handleRequest(req, res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  if (config.secureCookies) res.setHeader('strict-transport-security', 'max-age=31536000');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      worker.lastTick = await store.workerLastTick();
      const health = await store.health(),
        ok = !worker.stopping && !worker.lastError && Date.now() - worker.lastTick < 30000 && (!health.oldest || Date.now() - health.oldest < 300000);
      return json(res, ok ? 200 : 503, {
        ok,
        version: '2.2.0',
        mode: 'PAPER_ONLY',
        queued: health.queued
      });
    }
    if (url.pathname.startsWith('/api/')) auth.checkOrigin(req);
    if (url.pathname.startsWith('/api/auth/')) return await auth.routes(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/webhooks/tradingview/')) {
      const secret = decodeURIComponent(url.pathname.slice('/webhooks/tradingview/'.length)),
        user = await store.userByWebhook(secret);
      if (!user || user.status !== 'ACTIVE') return json(res, 404, {
        error: 'Not found'
      });
      let owner = await store.botOwner(user.id);
      if (!owner || owner.status !== 'ACTIVE') return json(res, 404, {
        error: 'Not found'
      });
      // READ COMMITTED plus explicit owner/bot locks orders intake with
      // suspension and webhook rotation without SERIALIZABLE burst failures.
      await store.db.prepare('SELECT id FROM users WHERE id=? FOR SHARE').get(owner.id);
      if(user.id!==owner.id)await store.db.prepare('SELECT id FROM users WHERE id=? FOR SHARE').get(user.id);
      // Recover legacy hash-only secrets from authenticated requests without rotating URLs.
      if (!(await store.webhookSecret(user.id))?.webhook_secret_encrypted) await store.rememberWebhookSecret(user.id, secret, encryptJson({
        secret
      }, config.keyring, `webhook:${user.id}`));
      const signal = normalizeSignal(await readJson(req));
      const current = await store.userByWebhook(secret);
      owner = await store.botOwner(user.id);
      if (current?.id !== user.id || current.status !== 'ACTIVE' || owner?.status !== 'ACTIVE') return json(res, 404, {
        error: 'Not found'
      });
      if (!capabilities[signal.broker]?.paper) throw new Error('Broker does not support Spot simulation');
      const isExit = signal.side === 'SELL' && signal.reduceOnly;
      if (!isExit && owner.role !== 'ADMIN' && !(await store.hasActiveLicense(owner.id))) return json(res, 403, {
        error: 'License inactive or expired'
      });
      const policy = await store.risk(user.id, config.defaultRisk);
      if (Date.now() - signal.timestamp > policy.maxSignalAgeSeconds * 1000) throw new Error('Signal is stale');
      if (!(await store.enqueue(user.id, signal, 'PAPER'))) return json(res, 409, {
        accepted: false,
        error: 'Duplicate trade_id'
      });
      return json(res, 202, {
        accepted: true,
        trade_id: signal.tradeId,
        execution_mode: 'PAPER'
      });
    }
    if (url.pathname.startsWith('/api/admin/')) return await adminRoutes(req, res, url);
    if (url.pathname.startsWith('/api/')) return await userRoutes(req, res, url);
    if (!serve(res, url.pathname)) json(res, 404, {
      error: 'Not found'
    });
  } catch (error) {
    if(res.phase2Buffer)throw error;
    const authPath = url.pathname.startsWith('/api/auth/');
    await store.audit(null, 'request.error', null, {
      message: authPath ? 'Authentication request failed' : error.message,
      path: url.pathname.startsWith('/webhooks/') ? '/webhooks/[redacted]' : authPath ? '/api/auth/[redacted]' : '/api/[redacted]'
    });
    if (!res.headersSent) json(res, error.status || 400, {
      error: error.message,
      ...(error.code ? {
        code: error.code
      } : {})
    });
  }
}
const server=http.createServer(async(req,res)=>{
  const transactional=req.url.startsWith('/api/')||req.url.startsWith('/webhooks/');
  if(!transactional){try{return await handleRequest(req,res);}catch{if(!res.headersSent)json(res,503,{ok:false,error:'Service unavailable'});return;}}
  try{
    // Shared across API replicas; outside the request transaction so failed requests count too.
    if(!await auth.limit('request:'+loginKey(req),240,60000))return json(res,429,{error:'Request limit reached'});
    if(req.url.startsWith('/api/'))auth.checkOrigin(req);
    if(!['GET','HEAD','OPTIONS'].includes(req.method))await preloadJson(req);
    await auth.prepareSession(req);
    res.phase2Buffer=true;
    await database.transaction(()=>handleRequest(req,res),{isolation:req.url.startsWith('/webhooks/')?'READ COMMITTED':'SERIALIZABLE'});
    res.phase2Buffer=false;
    const result=res.phase2Result;
    if(result)json(res,result.status,result.body);
  }catch(error){
    res.phase2Buffer=false;res.removeHeader('set-cookie');
    const retry=['40001','40P01','55P03'].includes(error.code);
    const internal=error.code&&/^[0-9A-Z]{5}$/.test(error.code);
    await store.audit(null,'request.error',null,{message:retry?'Concurrent request rolled back':internal?'Database request failed':'Request validation failed'}).catch(()=>{});
    if(!res.headersSent)json(res,error.status||(retry?409:internal?503:400),{error:retry?'Concurrent update; retry the request':internal?'Request could not be completed':error.message,...(retry?{code:'RETRY_TRANSACTION'}:error.code&&!internal?{code:error.code}:{})});
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.maxRequestsPerSocket = 100;
server.listen(config.port, config.host, () => console.log(`Robot trade v2.2 PostgreSQL Paper listening on :${config.port}`));
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections();
  await Promise.all([worker.stop(), closed]);
  await store.close();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
