import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hashToken, randomId } from './security.js';
import { migrateLedger, transaction } from './ledger.js';
import {recordFunding} from './paper-accounting.js';
import {invalidateAuth} from './auth-store.js';

export class Store {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'USER',status TEXT NOT NULL DEFAULT 'ACTIVE',webhook_secret_hash TEXT UNIQUE,webhook_hint TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS licenses(id TEXT PRIMARY KEY,key_hash TEXT NOT NULL UNIQUE,key_hint TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,assigned_user_id TEXT,created_at INTEGER NOT NULL,FOREIGN KEY(assigned_user_id) REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS broker_credentials(user_id TEXT NOT NULL,broker TEXT NOT NULL,encrypted_data TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,broker),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS risk_profiles(user_id TEXT PRIMARY KEY,policy TEXT NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS signals(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,trade_id TEXT NOT NULL,received_at INTEGER NOT NULL,signal_time INTEGER NOT NULL,broker TEXT NOT NULL,symbol TEXT NOT NULL,timeframe TEXT,event TEXT NOT NULL,side TEXT NOT NULL,entry_price REAL,stop_loss REAL,take_profit REAL,payload TEXT NOT NULL,status TEXT NOT NULL,error_message TEXT,broker_response TEXT,order_id TEXT,fill_price REAL,slippage_bps REAL,applied_quantity REAL NOT NULL DEFAULT 0,applied_quote REAL NOT NULL DEFAULT 0,processed_at INTEGER,UNIQUE(user_id,trade_id),FOREIGN KEY(user_id) REFERENCES users(id));
      CREATE INDEX IF NOT EXISTS idx_signals_queue ON signals(status,id); CREATE INDEX IF NOT EXISTS idx_signals_user ON signals(user_id,id DESC);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,ts INTEGER NOT NULL,event TEXT NOT NULL,trade_id TEXT,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions(user_id TEXT NOT NULL,broker TEXT NOT NULL,symbol TEXT NOT NULL,quantity REAL NOT NULL DEFAULT 0,avg_price REAL NOT NULL DEFAULT 0,stop_loss REAL,take_profit REAL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,broker,symbol));
      CREATE TABLE IF NOT EXISTS daily_stats(user_id TEXT NOT NULL,day TEXT NOT NULL,trades INTEGER NOT NULL DEFAULT 0,notional REAL NOT NULL DEFAULT 0,realized_r REAL NOT NULL DEFAULT 0,loss_streak INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,day));
      CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    migrateLedger(this);
  }

  createUser({ email, passwordHash, role = 'USER' }) {
    const id = randomId();
    this.db.prepare('INSERT INTO users(id,email,password_hash,role,status,created_at) VALUES(?,?,?,?,?,?)').run(id,email.toLowerCase(),passwordHash,role,'ACTIVE',Date.now());
    return this.userById(id);
  }
  userCount() { return Number(this.db.prepare('SELECT count(*) n FROM users').get().n); }
  userByEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase()); }
  userById(id) { return this.db.prepare('SELECT id,email,role,status,webhook_hint,created_at,parent_user_id,bot_slot_index,label FROM users WHERE id=?').get(id); }
  listUsers() { return this.db.prepare('SELECT id,email,role,status,webhook_hint,created_at FROM users WHERE parent_user_id IS NULL ORDER BY created_at DESC').all(); }
  botOwner(id){const bot=this.userById(id);return bot?this.userById(bot.parent_user_id||bot.id):null;}
  listBots(ownerId){return this.db.prepare('SELECT id,parent_user_id,bot_slot_index,label,status,webhook_hint FROM users WHERE id=? OR parent_user_id=? ORDER BY bot_slot_index').all(ownerId,ownerId);}
  ownsBot(ownerId,botId){return this.listBots(ownerId).some(bot=>bot.id===botId);}
  createBot(ownerId,label,defaults,initialize=()=>{}){
    if(typeof label!=='string'||!label.trim()||label.trim().length>80)throw new Error('Bot label must contain 1–80 characters');
    return transaction(this,()=>{
      const owner=this.userById(ownerId);if(!owner||owner.parent_user_id)throw new Error('Main account required');
      const bots=this.listBots(ownerId),slot=[2,3,4,5].find(index=>!bots.some(bot=>bot.bot_slot_index===index));
      if(!slot)throw new Error('Maximum 5 bot profiles per main account');
      const id=randomId();
      this.db.prepare("INSERT INTO users(id,email,password_hash,role,status,created_at,parent_user_id,bot_slot_index,label) VALUES(?,?,?,'BOT','ACTIVE',?,?,?,?)").run(id,`${id}@bot.invalid`,'NO_LOGIN',Date.now(),ownerId,slot,label.trim());
      this.setRisk(id,structuredClone(defaults));initialize(id);return this.userById(id);
    });
  }
  setUserStatus(id,status) { const write=()=>{this.db.prepare('UPDATE users SET status=? WHERE id=?').run(status,id);if(status!=='ACTIVE')this.revokeSessions(id);};return this.db.isTransaction?write():transaction(this,write); }
  setPassword(id,passwordHash) { const write=()=>{this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,id);invalidateAuth(this,id);}; return this.db.isTransaction?write():transaction(this,write); }
  revokeSessions(id) { invalidateAuth(this,id); }
  setWebhookSecret(userId, secret, encrypted=null) { this.db.prepare('UPDATE users SET webhook_secret_hash=?,webhook_hint=?,webhook_secret_encrypted=? WHERE id=?').run(hashToken(secret),secret.slice(-6),encrypted,userId); }
  rememberWebhookSecret(userId,secret,encrypted) { return this.db.prepare('UPDATE users SET webhook_secret_encrypted=? WHERE id=? AND webhook_secret_hash=? AND webhook_secret_encrypted IS NULL').run(encrypted,userId,hashToken(secret)).changes>0; }
  webhookSecret(userId) { return this.db.prepare('SELECT webhook_secret_hash,webhook_secret_encrypted FROM users WHERE id=?').get(userId); }
  userByWebhook(secret) { return this.db.prepare('SELECT id,email,role,status FROM users WHERE webhook_secret_hash=?').get(hashToken(secret)); }

  createSession(userId, token, expiresAt) { if(this.userById(userId)?.parent_user_id)throw new Error('Main account session required');this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at,last_seen) VALUES(?,?,?,?,?)').run(hashToken(token),userId,expiresAt,Date.now(),Date.now()); }
  session(token) { return this.db.prepare(`SELECT u.id,u.email,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token),Date.now()); }
  deleteSession(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }

  createLicense({ key, plan, expiresAt }) { const id=randomId(); this.db.prepare('INSERT INTO licenses(id,key_hash,key_hint,plan,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,hashToken(key),key.slice(-6),plan,'AVAILABLE',expiresAt,Date.now()); return {id,key,plan,status:'AVAILABLE',expires_at:expiresAt}; }
  redeemLicense(userId,key) { const row=this.db.prepare("SELECT * FROM licenses WHERE key_hash=? AND status='AVAILABLE' AND expires_at>?").get(hashToken(key),Date.now()); if(!row)return false; this.db.prepare("UPDATE licenses SET status='ACTIVE',assigned_user_id=? WHERE id=?").run(userId,row.id); return true; }
  licenseForUser(userId) { return this.db.prepare("SELECT id,key_hint,plan,status,expires_at FROM licenses WHERE assigned_user_id=? ORDER BY expires_at DESC LIMIT 1").get(userId); }
  hasActiveLicense(userId) { const row=this.db.prepare("SELECT 1 FROM licenses WHERE assigned_user_id=? AND status='ACTIVE' AND expires_at>? LIMIT 1").get(userId,Date.now()); return Boolean(row); }
  listLicenses() { return this.db.prepare('SELECT l.id,l.key_hint,l.plan,l.status,l.expires_at,l.assigned_user_id,u.email FROM licenses l LEFT JOIN users u ON u.id=l.assigned_user_id ORDER BY l.created_at DESC').all(); }
  setLicenseStatus(id,status) { this.db.prepare('UPDATE licenses SET status=? WHERE id=?').run(status,id); }

  setRisk(userId, policy) {
    const write = () => {
      recordFunding(this,userId,policy);
      this.db.prepare('INSERT INTO risk_profiles(user_id,policy,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at').run(userId,JSON.stringify(policy),Date.now());
    };
    return this.db.isTransaction ? write() : transaction(this,write);
  }
  risk(userId, defaults) { const row=this.db.prepare('SELECT policy FROM risk_profiles WHERE user_id=?').get(userId); return row?{...defaults,...JSON.parse(row.policy)}:{...defaults}; }
  setCredential(userId,broker,encrypted,enabled=true) { this.db.prepare('INSERT INTO broker_credentials(user_id,broker,encrypted_data,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,broker) DO UPDATE SET encrypted_data=excluded.encrypted_data,enabled=excluded.enabled,updated_at=excluded.updated_at').run(userId,broker,encrypted,enabled?1:0,Date.now()); }
  credential(userId,broker) { return this.db.prepare('SELECT * FROM broker_credentials WHERE user_id=? AND broker=? AND enabled=1').get(userId,broker); }
  credentialSummary(userId) { return this.db.prepare('SELECT broker,enabled,updated_at FROM broker_credentials WHERE user_id=? ORDER BY broker').all(userId); }

  claimNext(){const row=this.db.prepare("SELECT * FROM signals WHERE status='QUEUED' ORDER BY id LIMIT 1").get();if(!row)return null;const result=this.db.prepare("UPDATE signals SET status='PROCESSING' WHERE id=? AND status='QUEUED'").run(row.id);return result.changes?{...row,payload:JSON.parse(row.payload)}:null;}
  complete(id,status,{error=null,response=null,orderId=null,fillPrice=null,slippageBps=null,appliedQuantity=0,appliedQuote=0}={}){this.db.prepare('UPDATE signals SET status=?,error_message=?,broker_response=?,order_id=?,fill_price=?,slippage_bps=?,applied_quantity=?,applied_quote=?,processed_at=? WHERE id=?').run(status,error,response?JSON.stringify(response):null,orderId?String(orderId):null,fillPrice,slippageBps,appliedQuantity,appliedQuote,Date.now(),id);}
  audit(userId,event,tradeId,details={}){this.db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(?,?,?,?,?)').run(userId||null,Date.now(),event,tradeId||null,JSON.stringify(details));}
  listSignals(userId,isAdmin=false,limit=100){return isAdmin?this.db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT ?').all(limit):this.db.prepare('SELECT * FROM signals WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId,limit);}
  listAudit(userId,isAdmin=false,limit=100){return isAdmin?this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit):this.db.prepare('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId,limit);}
  getSetting(key,fallback){const row=this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  setSetting(key,value){this.db.prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  close(){this.db.close();}
}
