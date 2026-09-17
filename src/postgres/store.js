import { transaction } from './db.js';
import { hashToken, randomId } from '../security.js';
import { ledgerMethods, recordFunding } from './ledger.js';
import { invalidateAuth } from './auth-store.js';
export class Store {
  constructor(database) {
    this.db = database;
    Object.assign(this, ledgerMethods);
  }
  async createUser({
    email,
    passwordHash,
    role = 'USER'
  }) {
    const id = randomId();
    await this.db.prepare('INSERT INTO users(id,email,password_hash,role,status,created_at) VALUES(?,?,?,?,?,?)').run(id, email.toLowerCase(), passwordHash, role, 'ACTIVE', Date.now());
    return await this.userById(id);
  }
  async userCount() {
    return Number((await this.db.prepare('SELECT count(*) n FROM users').get()).n);
  }
  async userByEmail(email) {
    return await this.db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase());
  }
  async userById(id) {
    return await this.db.prepare('SELECT id,email,role,status,webhook_hint,created_at,parent_user_id,bot_slot_index,label FROM users WHERE id=?').get(id);
  }
  async listUsers() {
    return await this.db.prepare('SELECT id,email,role,status,webhook_hint,created_at FROM users WHERE parent_user_id IS NULL ORDER BY created_at DESC').all();
  }
  async botOwner(id) {
    const bot = await this.userById(id);
    return bot ? await this.userById(bot.parent_user_id || bot.id) : null;
  }
  async listBots(ownerId) {
    return await this.db.prepare('SELECT id,parent_user_id,bot_slot_index,label,status,webhook_hint FROM users WHERE id=? OR parent_user_id=? ORDER BY bot_slot_index').all(ownerId, ownerId);
  }
  async ownsBot(ownerId, botId) {
    return (await this.listBots(ownerId)).some(bot => bot.id === botId);
  }
  async createBot(ownerId, label, defaults, initialize = () => {}) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80) throw new Error('Bot label must contain 1–80 characters');
    return await transaction(this, async () => {
      await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(ownerId);
      const owner = await this.userById(ownerId);
      if (!owner || owner.parent_user_id) throw new Error('Main account required');
      const bots = await this.listBots(ownerId),
        slot = [2, 3, 4, 5].find(index => !bots.some(bot => bot.bot_slot_index === index));
      if (!slot) throw new Error('Maximum 5 bot profiles per main account');
      const id = randomId();
      await this.db.prepare("INSERT INTO users(id,email,password_hash,role,status,created_at,parent_user_id,bot_slot_index,label) VALUES(?,?,?,'BOT','ACTIVE',?,?,?,?)").run(id, `${id}@bot.invalid`, 'NO_LOGIN', Date.now(), ownerId, slot, label.trim());
      await this.setRisk(id, structuredClone(defaults));
      await initialize(id);
      return await this.userById(id);
    });
  }
  async setUserStatus(id, status) {
    const write = async () => {
      await this.db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
      if (status !== 'ACTIVE') await this.revokeSessions(id);
    };
    return this.db.isTransaction ? write() : await transaction(this, write);
  }
  async setPassword(id, passwordHash) {
    const write = async () => {
      await this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, id);
      await invalidateAuth(this, id);
    };
    return this.db.isTransaction ? write() : await transaction(this, write);
  }
  async revokeSessions(id) {
    await invalidateAuth(this, id);
  }
  async setWebhookSecret(userId, secret, encrypted = null) {
    await this.db.prepare('UPDATE users SET webhook_secret_hash=?,webhook_hint=?,webhook_secret_encrypted=? WHERE id=?').run(hashToken(secret), secret.slice(-6), encrypted, userId);
  }
  async rememberWebhookSecret(userId, secret, encrypted) {
    return (await this.db.prepare('UPDATE users SET webhook_secret_encrypted=? WHERE id=? AND webhook_secret_hash=? AND webhook_secret_encrypted IS NULL').run(encrypted, userId, hashToken(secret))).changes > 0;
  }
  async webhookSecret(userId) {
    return await this.db.prepare('SELECT webhook_secret_hash,webhook_secret_encrypted FROM users WHERE id=?').get(userId);
  }
  async userByWebhook(secret) {
    return await this.db.prepare('SELECT id,email,role,status FROM users WHERE webhook_secret_hash=?').get(hashToken(secret));
  }
  async createSession(userId, token, expiresAt) {
    if ((await this.userById(userId))?.parent_user_id) throw new Error('Main account session required');
    await this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at,last_seen) VALUES(?,?,?,?,?)').run(hashToken(token), userId, expiresAt, Date.now(), Date.now());
  }
  async session(token) {
    return await this.db.prepare(`SELECT u.id,u.email,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token), Date.now());
  }
  async deleteSession(token) {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  }
  async createLicense({
    key,
    plan,
    expiresAt
  }) {
    const id = randomId();
    await this.db.prepare('INSERT INTO licenses(id,key_hash,key_hint,plan,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id, hashToken(key), key.slice(-6), plan, 'AVAILABLE', expiresAt, Date.now());
    return {
      id,
      key,
      plan,
      status: 'AVAILABLE',
      expires_at: expiresAt
    };
  }
  async redeemLicense(userId, key) {
    const result=await this.db.prepare("UPDATE licenses SET status='ACTIVE',assigned_user_id=? WHERE key_hash=? AND status='AVAILABLE' AND expires_at>?").run(userId,hashToken(key),Date.now());
    return result.changes===1;
  }
  async licenseForUser(userId) {
    return await this.db.prepare("SELECT id,key_hint,plan,status,expires_at FROM licenses WHERE assigned_user_id=? ORDER BY expires_at DESC LIMIT 1").get(userId);
  }
  async hasActiveLicense(userId) {
    const row = await this.db.prepare("SELECT 1 FROM licenses WHERE assigned_user_id=? AND status='ACTIVE' AND expires_at>? LIMIT 1").get(userId, Date.now());
    return Boolean(row);
  }
  async listLicenses() {
    return await this.db.prepare('SELECT l.id,l.key_hint,l.plan,l.status,l.expires_at,l.assigned_user_id,u.email FROM licenses l LEFT JOIN users u ON u.id=l.assigned_user_id ORDER BY l.created_at DESC').all();
  }
  async setLicenseStatus(id, status) {
    await this.db.prepare('UPDATE licenses SET status=? WHERE id=?').run(status, id);
  }
  async setRisk(userId, policy) {
    const write = async () => {
      await recordFunding(this, userId, policy);
      await this.db.prepare('INSERT INTO risk_profiles(user_id,policy,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at').run(userId, JSON.stringify(policy), Date.now());
    };
    return this.db.isTransaction ? write() : await transaction(this, write);
  }
  async risk(userId, defaults) {
    const row = await this.db.prepare('SELECT policy FROM risk_profiles WHERE user_id=?').get(userId);
    return row ? {
      ...defaults,
      ...JSON.parse(row.policy)
    } : {
      ...defaults
    };
  }
  async setCredential(userId, broker, encrypted, enabled = true) {
    await this.db.prepare('INSERT INTO broker_credentials(user_id,broker,encrypted_data,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,broker) DO UPDATE SET encrypted_data=excluded.encrypted_data,enabled=excluded.enabled,updated_at=excluded.updated_at').run(userId, broker, encrypted, enabled ? 1 : 0, Date.now());
  }
  async credential(userId, broker) {
    return await this.db.prepare('SELECT * FROM broker_credentials WHERE user_id=? AND broker=? AND enabled=1').get(userId, broker);
  }
  async credentialSummary(userId) {
    return await this.db.prepare('SELECT broker,enabled,updated_at FROM broker_credentials WHERE user_id=? ORDER BY broker').all(userId);
  }
  async complete(id, status, {
    error = null,
    response = null,
    orderId = null,
    fillPrice = null,
    slippageBps = null,
    appliedQuantity = 0,
    appliedQuote = 0
  } = {}) {
    await this.db.prepare('UPDATE signals SET status=?,error_message=?,broker_response=?,order_id=?,fill_price=?,slippage_bps=?,applied_quantity=?,applied_quote=?,processed_at=? WHERE id=?').run(status, error, response ? JSON.stringify(response) : null, orderId ? String(orderId) : null, fillPrice, slippageBps, appliedQuantity, appliedQuote, Date.now(), id);
  }
  async audit(userId, event, tradeId, details = {}) {
    await this.db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(?,?,?,?,?)').run(userId || null, Date.now(), event, tradeId || null, JSON.stringify(details));
  }
  async listSignals(userId, isAdmin = false, limit = 100) {
    return isAdmin ? await this.db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT ?').all(limit) : await this.db.prepare('SELECT * FROM signals WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }
  async listAudit(userId, isAdmin = false, limit = 100) {
    return isAdmin ? await this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) : await this.db.prepare('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, limit);
  }
  async getSetting(key, fallback) {
    const row = await this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  async setSetting(key, value) {
    await this.db.prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  async close() {
    await this.db.close();
  }
}
