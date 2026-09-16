import { createHash } from 'node:crypto';

const pending = "('PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')";
const day = () => new Date().toISOString().slice(0, 10);
const scope = row => [row.user_id, row.account_id, row.execution_mode];
export const accountId = broker => `${broker}:primary`;

// Synchronous transactions only: never hold a SQLite lock across a broker call.
export function transaction(store, fn) {
  store.db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); store.db.exec('COMMIT'); return value; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export function migrateLedger(store) {
  const version = store.db.prepare('PRAGMA user_version').get().user_version;
  if (version > 7) throw new Error('Database is newer than this application');
  if (version < 3) transaction(store, () => {
    store.db.exec(`
      ALTER TABLE signals ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'LEGACY';
      ALTER TABLE signals ADD COLUMN account_id TEXT NOT NULL DEFAULT 'legacy';
      ALTER TABLE signals ADD COLUMN client_order_id TEXT;
      ALTER TABLE signals ADD COLUMN order_intent TEXT;
      ALTER TABLE signals ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE ledger_positions(
        user_id TEXT NOT NULL, account_id TEXT NOT NULL, execution_mode TEXT NOT NULL,
        broker TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
        avg_price REAL NOT NULL DEFAULT 0, stop_loss REAL, take_profit REAL,
        initial_risk REAL NOT NULL DEFAULT 0, cumulative_pnl REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,account_id,execution_mode,symbol));
      CREATE TABLE ledger_daily(
        user_id TEXT NOT NULL, account_id TEXT NOT NULL, execution_mode TEXT NOT NULL,
        day TEXT NOT NULL, trades INTEGER NOT NULL DEFAULT 0, notional REAL NOT NULL DEFAULT 0,
        realized_r REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,account_id,execution_mode,day));
      CREATE TABLE ledger_streak(
        user_id TEXT NOT NULL, account_id TEXT NOT NULL, execution_mode TEXT NOT NULL,
        loss_streak INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(user_id,account_id,execution_mode));
      CREATE TABLE fills(
        signal_id INTEGER NOT NULL, cumulative_quantity REAL NOT NULL,
        delta_quantity REAL NOT NULL, price REAL NOT NULL, fee_quote REAL NOT NULL,
        realized_r REAL NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY(signal_id,cumulative_quantity));
      CREATE TABLE notification_outbox(
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'PENDING');
      UPDATE signals SET status='REJECTED',error_message='Legacy queued signal quarantined during migration'
        WHERE status='QUEUED';
      PRAGMA user_version=3;
    `);
    // Legacy positions/stats remain intact for operator review; never guess Paper vs Live.
  });
  if (version < 4) transaction(store, () => {
    store.db.exec("ALTER TABLE signals ADD COLUMN review_note TEXT NOT NULL DEFAULT ''; PRAGMA user_version=4;");
  });
  if (version < 5) transaction(store, () => {
    store.db.exec("ALTER TABLE users ADD COLUMN webhook_secret_encrypted TEXT; PRAGMA user_version=5;");
  });
  if (version < 6) transaction(store, () => {
    for(const row of store.db.prepare('SELECT user_id,policy FROM risk_profiles').all()){
      const policy=JSON.parse(row.policy);policy.onePositionPerSymbol=false;
      store.db.prepare('UPDATE risk_profiles SET policy=?,updated_at=? WHERE user_id=?').run(JSON.stringify(policy),Date.now(),row.user_id);
    }
    store.db.exec('PRAGMA user_version=6;');
  });
  if (version < 7) transaction(store, () => {
    store.db.exec(`CREATE TABLE IF NOT EXISTS analytics_settings(
      user_id TEXT NOT NULL,broker TEXT NOT NULL,fee_bps REAL NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id,broker),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      PRAGMA user_version=7;`);
  });
  store.db.exec(`UPDATE signals SET status='UNKNOWN',
    error_message='Interrupted execution: verify broker outcome; automatic resend disabled'
    WHERE status='PROCESSING'`);
  Object.assign(store, methods);
}

const methods = {
  setRejectedNote(actor, id, note) {
    if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid signal ID');
    if(typeof note!=='string'||note.length>2000)throw new Error('Note must be at most 2000 characters');
    return transaction(this, () => {
      const row=this.db.prepare('SELECT user_id,trade_id,status FROM signals WHERE id=?').get(id);
      if(!row||(actor.role!=='ADMIN'&&row.user_id!==actor.id))return false;
      if(row.status!=='REJECTED')throw new Error('Notes are available for Rejected signals only');
      this.db.prepare('UPDATE signals SET review_note=? WHERE id=?').run(note.trim(),id);
      this.audit(actor.id,'signal.note.updated',row.trade_id,{signalId:id,ownerId:row.user_id});
      return true;
    });
  },
  enqueue(userId, signal, mode = 'PAPER') {
    if (!['PAPER', 'LIVE'].includes(mode)) throw new Error('Invalid execution mode');
    return transaction(this, () => {
      if (this.db.prepare('SELECT 1 FROM signals WHERE user_id=? AND trade_id=?').get(userId, signal.tradeId)) {
        this.audit(userId,'webhook.duplicate',signal.tradeId,{});
        return false;
      }
      if (this.db.prepare(`SELECT count(*) n FROM signals WHERE status IN ('QUEUED',${pending.slice(1, -1)})`).get().n >= 1000)
        throw new Error('Execution queue is full; retry later with the same trade_id');
      const account = accountId(signal.broker);
      const clientId = `AT${createHash('sha256').update(JSON.stringify([userId, account, mode, signal.tradeId])).digest('hex').slice(0,30)}`;
      this.db.prepare(`INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,timeframe,event,side,
        entry_price,stop_loss,take_profit,payload,status,execution_mode,account_id,client_order_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?)`).run(userId, signal.tradeId, Date.now(), signal.timestamp,
        signal.broker, signal.symbol, signal.timeframe || '', signal.event, signal.side,
        signal.referencePrice || signal.limitPrice || null, signal.stopLoss || null, signal.takeProfit || null,
        JSON.stringify(signal), mode, account, clientId);
      this.audit(userId, 'webhook.accepted', signal.tradeId, {mode, account});
      return true;
    });
  },
  ledgerPosition(row) {
    return this.db.prepare(`SELECT * FROM ledger_positions WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=?`)
      .get(...scope(row), row.symbol) || {quantity:0,avg_price:0,initial_risk:0,cumulative_pnl:0};
  },
  ledgerDaily(row) {
    const daily = this.db.prepare('SELECT * FROM ledger_daily WHERE user_id=? AND account_id=? AND execution_mode=? AND day=?')
      .get(...scope(row), day()) || {day:day(),trades:0,notional:0,realized_r:0};
    const streak = this.db.prepare('SELECT loss_streak FROM ledger_streak WHERE user_id=? AND account_id=? AND execution_mode=?').get(...scope(row));
    return {...daily,loss_streak:streak?.loss_streak || 0};
  },
  exposure(row) {
    const positions = this.db.prepare('SELECT symbol FROM ledger_positions WHERE user_id=? AND account_id=? AND execution_mode=? AND quantity>0').all(...scope(row));
    const orders = this.db.prepare(`SELECT symbol,side,order_intent,applied_quantity,received_at FROM signals WHERE user_id=? AND account_id=? AND execution_mode=? AND status IN ${pending} AND id<>?`).all(...scope(row), row.id);
    const reservedNotional=orders.filter(p=>p.side==='BUY').reduce((sum,p)=>{
      const intent=p.order_intent?JSON.parse(p.order_intent):null;
      return sum+(intent?Math.max(0,intent.quantity-p.applied_quantity)*intent.price:0);
    },0);
    return {
      committedNotional:Number(this.db.prepare('SELECT COALESCE(SUM(quantity*avg_price),0) n FROM ledger_positions WHERE user_id=? AND account_id=? AND execution_mode=?').get(...scope(row)).n)+reservedNotional,
      reservedNotional,
      reservedTrades:orders.filter(p=>p.applied_quantity===0).length,
      openPositions:new Set([...positions.map(p => p.symbol), ...orders.filter(p => p.side==='BUY').map(p => p.symbol)]).size,
      hasPendingOrder:orders.some(p => p.symbol===row.symbol),
      uncertain:this.db.prepare("SELECT 1 FROM signals WHERE user_id=? AND broker=? AND status='UNKNOWN' LIMIT 1").get(row.user_id,row.broker)
    };
  },
  persistIntent(row, order) {
    this.db.prepare('UPDATE signals SET order_intent=?,processed_at=? WHERE id=? AND status=\'PROCESSING\'')
      .run(JSON.stringify(order), Date.now(), row.id);
  },
  pendingForReview() {
    const row = this.db.prepare(`SELECT * FROM signals WHERE status IN ('SUBMITTED','PARTIALLY_FILLED','UNKNOWN')
      AND execution_mode<>'PAPER' ORDER BY checked_at,id LIMIT 1`).get();
    return row ? {...row,payload:JSON.parse(row.payload)} : null;
  },
  touchPending(id) { this.db.prepare('UPDATE signals SET checked_at=? WHERE id=?').run(Date.now(),id); },
  // Broker quantities are cumulative; replaying the same snapshot cannot book a second fill.
  recordExecution(row, execution, order) {
    return transaction(this, () => {
      const saved = this.db.prepare('SELECT * FROM signals WHERE id=?').get(row.id);
      if (['FILLED','CANCELED','REJECTED','EXPIRED'].includes(saved.status)) return;
      const total = Number(execution.executedQty), quote = Number(execution.quoteQty);
      if (!Number.isFinite(total) || !Number.isFinite(quote) || total < saved.applied_quantity || quote < saved.applied_quote)
        throw new Error('Invalid or regressing cumulative broker fill');
      if (total > order.quantity + 1e-10) throw new Error('Broker fill exceeds order intent');
      if(execution.status==='FILLED'&&Math.abs(total-order.quantity)>1e-10)throw new Error('FILLED response does not match order quantity');
      const qty = total - saved.applied_quantity, notional = quote - saved.applied_quote;
      if (qty > 0 && row.execution_mode !== 'PAPER' && execution.feesVerified !== true)
        throw new Error('Live fee accounting is not verified; manual reconciliation required');
      let realizedR = 0;
      if (qty > 0) {
        if (notional <= 0) throw new Error('Missing fill quote amount');
        const current = this.ledgerPosition(row), price = notional / qty;
        const fee = Number(execution.deltaFeeQuote ?? 0);
        if (!Number.isFinite(fee) || fee < 0) throw new Error('Invalid fill fee');
        let quantity, avg, initialRisk, pnl;
        if (order.side === 'BUY') {
          quantity = current.quantity + qty;
          avg = (current.quantity * current.avg_price + notional + fee) / quantity;
          initialRisk = current.initial_risk + qty * Math.abs(price - order.stopLoss);
          pnl = current.cumulative_pnl;
        } else {
          if (qty > current.quantity + 1e-10) throw new Error('Fill exceeds tracked position; operator reconciliation required');
          quantity = Math.max(0,current.quantity-qty);
          avg = current.avg_price;
          initialRisk = current.initial_risk;
          const deltaPnl = (price-avg)*qty-fee;
          pnl = current.cumulative_pnl+deltaPnl;
          realizedR = initialRisk > 0 ? deltaPnl/initialRisk : 0;
          if (quantity < 1e-10) {
            quantity = 0;
            this.db.prepare(`INSERT INTO ledger_streak VALUES(?,?,?,?) ON CONFLICT(user_id,account_id,execution_mode)
              DO UPDATE SET loss_streak=CASE WHEN ?<0 THEN loss_streak+1 ELSE 0 END`).run(...scope(row),pnl<0?1:0,pnl);
          }
        }
        this.db.prepare(`INSERT INTO ledger_positions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id,account_id,execution_mode,symbol) DO UPDATE SET quantity=excluded.quantity,
          avg_price=excluded.avg_price,stop_loss=excluded.stop_loss,take_profit=excluded.take_profit,
          initial_risk=excluded.initial_risk,cumulative_pnl=excluded.cumulative_pnl,updated_at=excluded.updated_at`)
          .run(...scope(row),row.broker,row.symbol,quantity,quantity?avg:0,
            order.side==='BUY'?order.stopLoss:current.stop_loss,order.side==='BUY'?(order.takeProfit||null):current.take_profit,
            quantity?initialRisk:0,quantity?pnl:0,Date.now());
        this.db.prepare('INSERT INTO fills VALUES(?,?,?,?,?,?,?)').run(row.id,total,qty,price,fee,realizedR,Date.now());
      }
      const first = saved.applied_quantity === 0 && total > 0;
      this.db.prepare(`INSERT INTO ledger_daily VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,account_id,execution_mode,day)
        DO UPDATE SET trades=trades+excluded.trades,notional=notional+excluded.notional,realized_r=realized_r+excluded.realized_r`)
        .run(...scope(row),day(),first?1:0,notional,realizedR);
      const allowed = ['NEW','SUBMITTED','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED','EXPIRED'];
      if (!allowed.includes(execution.status)) throw new Error('Unknown broker order status');
      const status = execution.status==='NEW'?'SUBMITTED':execution.status;
      const fillPrice = total ? quote/total : null;
      const slip = fillPrice ? (order.side==='BUY'?fillPrice-order.price:order.price-fillPrice)/order.price*10000 : null;
      this.complete(row.id,status,{response:execution.raw,orderId:execution.orderId||saved.order_id,
        fillPrice,slippageBps:slip,appliedQuantity:total,appliedQuote:quote});
      this.audit(row.user_id,'order.updated',row.trade_id,{status,mode:row.execution_mode,quantity:total});
      this.db.prepare('INSERT INTO notification_outbox(user_id,subject,body) VALUES(?,?,?)')
        .run(row.user_id,`Astra ${status}: ${row.symbol}`,`Trade ${row.trade_id}\nMode ${row.execution_mode}\nFill ${fillPrice??'-'}`);
    });
  },
  markUnknown(row, error) {
    this.db.prepare("UPDATE signals SET status='UNKNOWN',error_message=?,processed_at=? WHERE id=?")
      .run(String(error),Date.now(),row.id);
    this.audit(row.user_id,'order.unknown',row.trade_id,{message:String(error)});
  },
  listPositions(userId,isAdmin=false) {
    return isAdmin ? this.db.prepare('SELECT * FROM ledger_positions WHERE quantity>0').all()
      : this.db.prepare('SELECT * FROM ledger_positions WHERE user_id=? AND quantity>0').all(userId);
  },
  dailyAccounts(userId, mode='PAPER') {
    return this.db.prepare(`SELECT d.*,COALESCE(s.loss_streak,0) loss_streak FROM ledger_daily d
      LEFT JOIN ledger_streak s USING(user_id,account_id,execution_mode)
      WHERE d.user_id=? AND d.execution_mode=? AND d.day=?`).all(userId,mode,day());
  },
  analyticsRows(userId,broker){
    return this.db.prepare(`SELECT s.user_id,s.trade_id,s.broker,s.symbol,s.side,s.execution_mode,
      f.signal_id,f.cumulative_quantity,f.delta_quantity quantity,f.price,f.fee_quote,f.received_at
      FROM fills f JOIN signals s ON s.id=f.signal_id
      WHERE s.user_id=? AND s.broker=? AND s.execution_mode='PAPER' AND f.delta_quantity>0
      ORDER BY f.received_at,f.signal_id,f.cumulative_quantity`).all(userId,broker);
  },
  analyticsFeeBps(userId,broker){return Number(this.db.prepare('SELECT fee_bps FROM analytics_settings WHERE user_id=? AND broker=?').get(userId,broker)?.fee_bps||0);},
  setAnalyticsFeeBps(userId,broker,feeBps){this.db.prepare(`INSERT INTO analytics_settings(user_id,broker,fee_bps,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id,broker) DO UPDATE SET fee_bps=excluded.fee_bps,updated_at=excluded.updated_at`).run(userId,broker,feeBps,Date.now());},
  health() {
    this.db.prepare('SELECT 1').get();
    return this.db.prepare(`SELECT count(*) queued, MIN(received_at) oldest FROM signals WHERE status='QUEUED'`).get();
  }
};
