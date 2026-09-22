import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../../src/postgres/db.js';
import { Store } from '../../src/postgres/store.js';
import { hashPassword } from '../../src/security.js';

describe('Bot lifecycle & session management', () => {
  let adminDb, db, store, userId, databaseName;

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
    adminDb = new PostgresDatabase({ connectionString: process.env.TEST_DATABASE_URL });
    databaseName = 'robot_lifecycle_test_' + randomUUID().replaceAll('-', '');
    await adminDb.query('CREATE DATABASE ' + databaseName);
    const target = new URL(process.env.TEST_DATABASE_URL);
    target.pathname = '/' + databaseName;
    db = new PostgresDatabase({ connectionString: target.toString(), max: 5 });
    await db.migrate();
    store = new Store(db);
    const user = await store.createUser({ email: `lifecycle-${randomUUID()}@test.invalid`, passwordHash: await hashPassword('temporary-test-password'), role: 'USER' });
    userId = user.id;
    await store.setRisk(userId, {
      paperTrading: true,
      maxRiskPercent: 2, maxOrderNotional: '5000', maxDailyNotional: '50000',
      maxTradesPerDay: 10, maxDailyLossR: 5, pauseAfterLossStreak: 3,
      maxSignalAgeSeconds: 120, maxOpenPositions: 5, maxVolatilityPercent: 5,
      killSwitch: false, onePositionPerSymbol: false,
      blockHighVolatility: true, blockDuringNews: true,
      requireReduceOnlySell: true, capPercentEquitySize: true,
      sideMode: 'BOTH', allowedSymbols: [], defaults: {},
      equities: { 'binance-global': '10000', 'binance-th': '0', 'innovestx': '0', 'settrade': '0' },
      balances: { 'binance-global': '10000', 'binance-th': '0', 'innovestx': '0', 'settrade': '0' },
    });
  });

  after(async () => {
    await db?.close();
    if (adminDb) {
      if (databaseName) await adminDb.query('DROP DATABASE ' + databaseName);
      await adminDb.close();
    }
  });

  test('initial state is SETUP', async () => {
    const session = await store.getBotSession(userId);
    assert.equal(session.state, 'SETUP');
    assert.equal(session.run_id, null);
  });

  test('SETUP → pause is invalid', async () => {
    await assert.rejects(() => store.transitionBotState(userId, 'pause', {}, []), /Cannot pause from state SETUP/);
  });

  test('SETUP → stop is invalid', async () => {
    await assert.rejects(() => store.transitionBotState(userId, 'stop', {}, []), /Cannot stop from state SETUP/);
  });

  test('SETUP → reset is invalid', async () => {
    await assert.rejects(() => store.transitionBotState(userId, 'reset', {}, []), /Cannot reset from state SETUP/);
  });

  test('SETUP → run transitions to RUNNING and freezes policy', async () => {
    const policy = await store.risk(userId, {});
    const accounts = await store.paperAccounts(userId);
    const result = await store.transitionBotState(userId, 'run', policy, accounts);
    assert.equal(result.state, 'RUNNING');
    assert.ok(result.run_id);
    const session = await store.getBotSession(userId);
    assert.equal(session.state, 'RUNNING');
    assert.ok(session.locked_policy);
    const frozen = JSON.parse(session.locked_policy);
    assert.equal(frozen.maxRiskPercent, policy.maxRiskPercent);
  });

  test('RUNNING → run again is invalid', async () => {
    await assert.rejects(() => store.transitionBotState(userId, 'run', {}, []), /Cannot run from state RUNNING/);
  });

  test('RUNNING → pause transitions to PAUSED', async () => {
    const result = await store.transitionBotState(userId, 'pause', {}, []);
    assert.equal(result.state, 'PAUSED');
    const session = await store.getBotSession(userId);
    assert.equal(session.state, 'PAUSED');
    assert.ok(session.locked_policy);
  });

  test('PAUSED → run resumes to RUNNING preserving run_id', async () => {
    const before = await store.getBotSession(userId);
    const result = await store.transitionBotState(userId, 'run', {}, []);
    assert.equal(result.state, 'RUNNING');
    assert.equal(result.run_id, before.run_id);
  });

  test('RUNNING → stop transitions to STOPPED', async () => {
    const result = await store.transitionBotState(userId, 'stop', {}, []);
    assert.equal(result.state, 'STOPPED');
    const session = await store.getBotSession(userId);
    assert.equal(session.state, 'STOPPED');
    assert.ok(session.stopped_at);
  });

  test('STOPPED → reset archives and returns to SETUP', async () => {
    const archiveBefore = await store.listSessionArchive(userId);
    const result = await store.transitionBotState(userId, 'reset', {}, []);
    assert.equal(result.state, 'SETUP');
    const session = await store.getBotSession(userId);
    assert.equal(session.state, 'SETUP');
    assert.equal(session.run_id, null);
    assert.equal(session.locked_policy, null);
    const archiveAfter = await store.listSessionArchive(userId);
    assert.equal(archiveAfter.length, archiveBefore.length + 1);
  });

  test('SETUP → run again after reset works cleanly', async () => {
    const policy = await store.risk(userId, {});
    const accounts = await store.paperAccounts(userId);
    const result = await store.transitionBotState(userId, 'run', policy, accounts);
    assert.equal(result.state, 'RUNNING');
    assert.ok(result.run_id);
  });

  test('run_id is unique across sessions', async () => {
    const s1 = await store.getBotSession(userId);
    await store.transitionBotState(userId, 'stop', {}, []);
    await store.transitionBotState(userId, 'reset', {}, []);
    const policy = await store.risk(userId, {});
    const accounts = await store.paperAccounts(userId);
    const result = await store.transitionBotState(userId, 'run', policy, accounts);
    assert.notEqual(result.run_id, s1.run_id);
  });

  test('listSessionArchive returns records in desc order', async () => {
    const archive = await store.listSessionArchive(userId);
    assert.ok(archive.length >= 1);
    if (archive.length >= 2) assert.ok(archive[0].archived_at >= archive[1].archived_at);
  });
});
