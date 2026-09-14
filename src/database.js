import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { hashToken, randomId } from './security.js';

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
    this.db.exec("UPDATE signals SET status='QUEUED' WHERE status='PROCESSING'");
  }

  createUser({ email, passwordHash, role = 'USER' }) {
    const id = randomId();
    this.db.prepare('INSERT INTO users(id,email,password_hash,role,status,created_at) VALUES(?,?,?,?,?,?)').run(id,email.toLowerCase(),passwordHash,role,'ACTIVE',Date.now());
    return this.userById(id);
  }
  userCount() { return Number(this.db.prepare('SELECT count(*) n FROM users').get().n); }
  userByEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase()); }
  userById(id) { return this.db.prepare('SELECT id,email,role,status,webhook_hint,created_at FROM users WHERE id=?').get(id); }
  listUsers() { return this.db.prepare('SELECT id,email,role,status,webhook_hint,created_at FROM users ORDER BY created_at DESC').all(); }
  setUserStatus(id,status) { this.db.prepare('UPDATE users SET status=? WHERE id=?').run(status,id); }
  setPassword(id,passwordHash) { this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,id); }
  setWebhookSecret(userId, secret) { this.db.prepare('UPDATE users SET webhook_secret_hash=?,webhook_hint=? WHERE id=?').run(hashToken(secret),secret.slice(-6),userId); }
  userByWebhook(secret) { return this.db.prepare('SELECT id,email,role,status FROM users WHERE webhook_secret_hash=?').get(hashToken(secret)); }

  createSession(userId, token, expiresAt) { this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),userId,expiresAt,Date.now()); }
  session(token) { return this.db.prepare(`SELECT u.id,u.email,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token),Date.now()); }
  deleteSession(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }

  createLicense({ key, plan, expiresAt }) { const id=randomId(); this.db.prepare('INSERT INTO licenses(id,key_hash,key_hint,plan,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,hashToken(key),key.slice(-6),plan,'AVAILABLE',expiresAt,Date.now()); return {id,key,plan,status:'AVAILABLE',expires_at:expiresAt}; }
  redeemLicense(userId,key) { const row=this.db.prepare("SELECT * FROM licenses WHERE key_hash=? AND status='AVAILABLE' AND expires_at>?").get(hashToken(key),Date.now()); if(!row)return false; this.db.prepare("UPDATE licenses SET status='ACTIVE',assigned_user_id=? WHERE id=?").run(userId,row.id); return true; }
  licenseForUser(userId) { return this.db.prepare("SELECT id,key_hint,plan,status,expires_at FROM licenses WHERE assigned_user_id=? ORDER BY expires_at DESC LIMIT 1").get(userId); }
  hasActiveLicense(userId) { const row=this.db.prepare("SELECT 1 FROM licenses WHERE assigned_user_id=? AND status='ACTIVE' AND expires_at>? LIMIT 1").get(userId,Date.now()); return Boolean(row); }
  listLicenses() { return this.db.prepare('SELECT l.id,l.key_hint,l.plan,l.status,l.expires_at,l.assigned_user_id,u.email FROM licenses l LEFT JOIN users u ON u.id=l.assigned_user_id ORDER BY l.created_at DESC').all(); }
  setLicenseStatus(id,status) { this.db.prepare('UPDATE licenses SET status=? WHERE id=?').run(status,id); }

  setRisk(userId, policy) { this.db.prepare('INSERT INTO risk_profiles(user_id,policy,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at').run(userId,JSON.stringify(policy),Date.now()); }
  risk(userId, defaults) { const row=this.db.prepare('SELECT policy FROM risk_profiles WHERE user_id=?').get(userId); return row?{...defaults,...JSON.parse(row.policy)}:{...defaults}; }
  setCredential(userId,broker,encrypted,enabled=true) { this.db.prepare('INSERT INTO broker_credentials(user_id,broker,encrypted_data,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,broker) DO UPDATE SET encrypted_data=excluded.encrypted_data,enabled=excluded.enabled,updated_at=excluded.updated_at').run(userId,broker,encrypted,enabled?1:0,Date.now()); }
  credential(userId,broker) { return this.db.prepare('SELECT * FROM broker_credentials WHERE user_id=? AND broker=? AND enabled=1').get(userId,broker); }
  credentialSummary(userId) { return this.db.prepare('SELECT broker,enabled,updated_at FROM broker_credentials WHERE user_id=? ORDER BY broker').all(userId); }

  enqueue(userId,signal) { try { this.db.prepare(`INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,timeframe,event,side,entry_price,stop_loss,take_profit,payload,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId,signal.tradeId,Date.now(),signal.timestamp,signal.broker,signal.symbol,signal.timeframe,signal.event,signal.side,signal.referencePrice||signal.limitPrice||null,signal.stopLoss||null,signal.takeProfit||null,JSON.stringify(signal),'QUEUED'); this.audit(userId,'webhook.accepted',signal.tradeId,{broker:signal.broker,symbol:signal.symbol,event:signal.event}); return true; } catch(error){ if(String(error.message).includes('UNIQUE')){this.audit(userId,'webhook.duplicate',signal.tradeId,{});return false;} throw error;} }
  claimNext(){const row=this.db.prepare("SELECT * FROM signals WHERE status='QUEUED' ORDER BY id LIMIT 1").get();if(!row)return null;const result=this.db.prepare("UPDATE signals SET status='PROCESSING' WHERE id=? AND status='QUEUED'").run(row.id);return result.changes?{...row,payload:JSON.parse(row.payload)}:null;}
  complete(id,status,{error=null,response=null,orderId=null,fillPrice=null,slippageBps=null,appliedQuantity=0,appliedQuote=0}={}){this.db.prepare('UPDATE signals SET status=?,error_message=?,broker_response=?,order_id=?,fill_price=?,slippage_bps=?,applied_quantity=?,applied_quote=?,processed_at=? WHERE id=?').run(status,error,response?JSON.stringify(response):null,orderId?String(orderId):null,fillPrice,slippageBps,appliedQuantity,appliedQuote,Date.now(),id);}
  nextPending(){const row=this.db.prepare("SELECT * FROM signals WHERE status IN ('SUBMITTED','PARTIALLY_FILLED') AND order_id IS NOT NULL ORDER BY processed_at LIMIT 1").get();return row?{...row,payload:JSON.parse(row.payload)}:null;}
  updateExecution(id,status,{response,fillPrice,slippageBps,appliedQuantity,appliedQuote,error=null}){this.db.prepare('UPDATE signals SET status=?,error_message=?,broker_response=?,fill_price=?,slippage_bps=?,applied_quantity=?,applied_quote=?,processed_at=? WHERE id=?').run(status,error,response?JSON.stringify(response):null,fillPrice||null,slippageBps,appliedQuantity,appliedQuote,Date.now(),id);}
  audit(userId,event,tradeId,details={}){this.db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(?,?,?,?,?)').run(userId||null,Date.now(),event,tradeId||null,JSON.stringify(details));}
  listSignals(userId,isAdmin=false,limit=100){return isAdmin?this.db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT ?').all(limit):this.db.prepare('SELECT * FROM signals WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId,limit);}
  listAudit(userId,isAdmin=false,limit=100){return isAdmin?this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit):this.db.prepare('SELECT * FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId,limit);}
  position(userId,broker,symbol){return this.db.prepare('SELECT * FROM positions WHERE user_id=? AND broker=? AND symbol=?').get(userId,broker,symbol)||{quantity:0,avg_price:0};}
  setPosition(userId,broker,symbol,quantity,avgPrice,sl,tp){this.db.prepare(`INSERT INTO positions(user_id,broker,symbol,quantity,avg_price,stop_loss,take_profit,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,broker,symbol) DO UPDATE SET quantity=excluded.quantity,avg_price=excluded.avg_price,stop_loss=excluded.stop_loss,take_profit=excluded.take_profit,updated_at=excluded.updated_at`).run(userId,broker,symbol,quantity,avgPrice,sl||null,tp||null,Date.now());}
  listPositions(userId,isAdmin=false){return isAdmin?this.db.prepare('SELECT * FROM positions WHERE quantity>0 ORDER BY updated_at DESC').all():this.db.prepare('SELECT * FROM positions WHERE user_id=? AND quantity>0 ORDER BY updated_at DESC').all(userId);}
  openPositionCount(userId){return Number(this.db.prepare('SELECT count(*) n FROM positions WHERE user_id=? AND quantity>0').get(userId).n);}
  hasPendingOrder(userId,broker,symbol){return Boolean(this.db.prepare("SELECT 1 FROM signals WHERE user_id=? AND broker=? AND symbol=? AND status IN ('SUBMITTED','PARTIALLY_FILLED') LIMIT 1").get(userId,broker,symbol));}
  today(userId){const day=new Date().toISOString().slice(0,10);return this.db.prepare('SELECT * FROM daily_stats WHERE user_id=? AND day=?').get(userId,day)||{day,trades:0,notional:0,realized_r:0,loss_streak:0};}
  addDaily(userId,notional,realizedR=0,isClosed=false){const day=new Date().toISOString().slice(0,10);this.db.prepare(`INSERT INTO daily_stats(user_id,day,trades,notional,realized_r,loss_streak) VALUES(?,?,1,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET trades=trades+1,notional=notional+excluded.notional,realized_r=realized_r+excluded.realized_r,loss_streak=CASE WHEN ?=0 THEN loss_streak WHEN excluded.realized_r<0 THEN loss_streak+1 ELSE 0 END`).run(userId,day,notional,realizedR,isClosed&&realizedR<0?1:0,isClosed?1:0);}
  addRealized(userId,realizedR){const day=new Date().toISOString().slice(0,10);this.db.prepare(`INSERT INTO daily_stats(user_id,day,trades,notional,realized_r,loss_streak) VALUES(?,?,0,0,?,?) ON CONFLICT(user_id,day) DO UPDATE SET realized_r=realized_r+excluded.realized_r,loss_streak=CASE WHEN excluded.realized_r<0 THEN loss_streak+1 ELSE 0 END`).run(userId,day,realizedR,realizedR<0?1:0);}
  getSetting(key,fallback){const row=this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  setSetting(key,value){this.db.prepare('INSERT INTO system_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  close(){this.db.close();}
}
