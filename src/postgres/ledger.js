import {createHash} from 'node:crypto';
import {D,Money,amount,sum,exact} from '../money.js';
const brokers=['binance-global','binance-th','innovestx','settrade'];
const day=()=>new Date().toISOString().slice(0,10);
const scope=row=>[row.user_id,row.account_id,row.execution_mode];
const pending="('PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')";

export async function recordFunding(store,userId,policy){
  await store.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(userId);
  for(const broker of brokers){
    const current=await store.paperAccount(userId,broker),equity=D(policy.equities?.[broker]??0),cash=D(policy.balances?.[broker]??equity);
    exact(equity);exact(cash);
    if(cash.lt(0)||equity.lt(cash))throw new Error('Invalid Paper capital');
    const ed=equity.minus(current.configuredEquity),cd=cash.minus(current.configuredBalance);
    if(ed.isZero()&&cd.isZero())continue;
    const exposure=await store.exposure({id:0,user_id:userId,account_id:broker+':primary',execution_mode:'PAPER',symbol:'',broker});
    if((cd.lt(0)&&D(current.cash).plus(cd).lt(exposure.reservedNotional))||
      (ed.lt(0)&&D(current.bookEquity).plus(ed).lt(D(current.positionCost).plus(exposure.reservedNotional))))throw new Error('Paper capital withdrawal exceeds unreserved funds');
    await store.db.prepare('INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES(?,?,?,?,?,?)').run(userId,broker,Date.now(),exact(ed),exact(cd),'CONFIGURATION');
    await store.snapshotPaper(userId,broker,'FUNDING');
  }
}

export const ledgerMethods={
  async paperAccount(userId,broker,proposedPolicy){
    const funds=await this.db.prepare('SELECT COALESCE(SUM(equity_delta),0) equity,COALESCE(SUM(cash_delta),0) cash FROM paper_funding WHERE user_id=? AND broker=?').get(userId,broker);
    const {amount:movement}=await this.db.prepare('SELECT COALESCE(SUM(cash_delta),0) amount FROM paper_cash_journal WHERE user_id=? AND broker=?').get(userId,broker);
    const {amount:cost}=await this.db.prepare("SELECT COALESCE(SUM(cost_basis),0) amount FROM ledger_positions WHERE user_id=? AND broker=? AND execution_mode='PAPER'").get(userId,broker);
    const equity=proposedPolicy?D(proposedPolicy.equities?.[broker]??0):D(funds.equity);
    const cash=proposedPolicy?D(proposedPolicy.balances?.[broker]??equity):D(funds.cash);
    return {userId,broker,currency:broker==='binance-global'?'USDT':'THB',cash:amount(cash.plus(movement)),positionCost:amount(cost),bookEquity:amount(equity.plus(movement).plus(cost)),configuredEquity:equity.toFixed(),configuredBalance:cash.toFixed(),valuation:'COST_BASIS_NOT_MARK_TO_MARKET'};
  },
  async snapshotPaper(userId,broker,reason){const a=await this.paperAccount(userId,broker);await this.db.prepare('INSERT INTO paper_snapshots(user_id,broker,at,reason,cash,book_equity,position_cost) VALUES(?,?,?,?,?,?,?)').run(userId,broker,Date.now(),reason,a.cash,a.bookEquity,a.positionCost);},
  async paperAccounts(userId){return Promise.all(brokers.map(b=>this.paperAccount(userId,b)));},
  async paperFunding(userId,broker){return this.db.prepare('SELECT * FROM paper_funding WHERE user_id=? AND broker=? ORDER BY at,id').all(userId,broker);},
  async enqueue(userId,signal,mode='PAPER'){
    if(mode!=='PAPER')throw new Error('Only Paper execution is enabled');
    return this.db.transaction(async()=>{
      await this.db.lock('robot:queue-intake');
      if(await this.db.prepare('SELECT 1 FROM signals WHERE user_id=? AND trade_id=?').get(userId,signal.tradeId)){await this.audit(userId,'webhook.duplicate',signal.tradeId);return false;}
      const {n}=await this.db.prepare("SELECT count(*) n FROM signals WHERE status IN ('QUEUED','PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')").get();
      if(n>=1000)throw new Error('Execution queue is full; retry later with the same trade_id');
      const account=signal.broker+':primary',client='AT'+createHash('sha256').update(JSON.stringify([userId,account,mode,signal.tradeId])).digest('hex').slice(0,30);
      const result=await this.db.prepare(`INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,timeframe,event,side,entry_price,stop_loss,take_profit,payload,status,execution_mode,account_id,client_order_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',?,?,?) ON CONFLICT(user_id,trade_id) DO NOTHING`).run(userId,signal.tradeId,Date.now(),signal.timestamp,signal.broker,signal.symbol,signal.timeframe||'',signal.event,signal.side,signal.referencePrice||signal.limitPrice||null,signal.stopLoss||null,signal.takeProfit||null,JSON.stringify(signal),mode,account,client);
      if(result.changes)await this.audit(userId,'webhook.accepted',signal.tradeId,{mode,account});
      return result.changes===1;
    });
  },
  async ledgerPosition(row){return await this.db.prepare('SELECT * FROM ledger_positions WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=?').get(...scope(row),row.symbol)||{quantity:'0',avg_price:'0',cost_basis:'0',initial_risk:'0',cumulative_pnl:'0'};},
  async ledgerTargetAllocation(row, targetTradeId){
    if(!targetTradeId) return null;
    return await this.db.prepare(`
      SELECT * FROM ledger_position_allocations 
      WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=? 
        AND (entry_trade_id=? OR position_id=?) AND status='OPEN' AND remaining_quantity>0
      ORDER BY opened_at ASC LIMIT 1
    `).get(...scope(row), row.symbol, targetTradeId, targetTradeId);
  },
  async listAllocations(row){
    return await this.db.prepare(`
      SELECT * FROM ledger_position_allocations 
      WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=? AND status='OPEN' AND remaining_quantity>0
      ORDER BY opened_at ASC
    `).all(...scope(row), row.symbol);
  },
  async ledgerDaily(row){
    const daily=await this.db.prepare('SELECT * FROM ledger_daily WHERE user_id=? AND account_id=? AND execution_mode=? AND day=?').get(...scope(row),day())||{day:day(),trades:0,notional:'0',realized_r:'0'};
    const streak=await this.db.prepare('SELECT loss_streak FROM ledger_streak WHERE user_id=? AND account_id=? AND execution_mode=?').get(...scope(row));return {...daily,loss_streak:streak?.loss_streak||0};
  },
  async exposure(row){
    const positions=await this.db.prepare('SELECT symbol,cost_basis FROM ledger_positions WHERE user_id=? AND account_id=? AND execution_mode=? AND quantity>0').all(...scope(row));
    const orders=await this.db.prepare('SELECT symbol,side,order_intent,applied_quantity,status FROM signals WHERE user_id=? AND account_id=? AND execution_mode=? AND status IN '+pending+' AND id<>?').all(...scope(row),row.id);
    const reserved=sum(orders.filter(o=>o.side==='BUY').map(o=>{const i=o.order_intent&&JSON.parse(o.order_intent);return i?Money.max(0,D(i.quantity).minus(o.applied_quantity)).mul(i.price):'0';}));
    return {committedNotional:amount(sum(positions.map(p=>p.cost_basis)).plus(reserved)),reservedNotional:amount(reserved),reservedTrades:orders.filter(o=>D(o.applied_quantity).isZero()).length,
      openPositions:new Set([...positions.map(p=>p.symbol),...orders.filter(o=>o.side==='BUY').map(o=>o.symbol)]).size,hasPendingOrder:orders.some(o=>o.symbol===row.symbol),uncertain:orders.some(o=>o.status==='UNKNOWN')};
  },
  async persistIntent(row,order){return this.db.prepare("UPDATE signals SET order_intent=?,processed_at=? WHERE id=? AND status='PROCESSING'").run(JSON.stringify(order),Date.now(),row.id);},
  async recordExecution(row,execution,order){
    if(row.execution_mode!=='PAPER')throw new Error('Live execution is locked');
    return this.db.transaction(async()=>{
      await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(row.user_id);
      const saved=await this.db.prepare('SELECT * FROM signals WHERE id=? FOR UPDATE').get(row.id);
      if(!saved||saved.user_id!==row.user_id)throw new Error('Signal ownership mismatch');
      if(['FILLED','CANCELED','REJECTED','EXPIRED'].includes(saved.status))return;
      const total=D(execution.executedQty),quote=D(execution.quoteQty),fee=D(execution.deltaFeeQuote??0);
      if(total.lt(saved.applied_quantity)||quote.lt(saved.applied_quote)||total.gt(order.quantity)||fee.lt(0))throw new Error('Invalid or regressing cumulative broker fill');
      if(execution.status==='FILLED'&&!total.eq(order.quantity))throw new Error('FILLED response does not match order quantity');
      const qty=total.minus(saved.applied_quantity),notional=quote.minus(saved.applied_quote);
      if(qty.isZero()&&(!notional.isZero()||!fee.isZero()))throw new Error('Quote or fee change requires a new fill');
      const allowed=['NEW','SUBMITTED','PARTIALLY_FILLED','FILLED','CANCELED','REJECTED','EXPIRED'];
      if(!allowed.includes(execution.status))throw new Error('Unknown broker order status');
      let realizedR=D(0);
      if(qty.gt(0)){
        if(notional.lte(0))throw new Error('Missing fill quote amount');
        const current=await this.ledgerPosition(row),price=D(amount(notional.div(qty)));
        const cashDelta=order.side==='BUY'?notional.plus(fee).neg():notional.minus(fee);
        if(order.side==='BUY'&&D((await this.paperAccount(row.user_id,row.broker)).cash).plus(cashDelta).lt(0))throw new Error('Insufficient Paper cash including fees');
        let quantity,cost,initialRisk,pnl;
        let payloadObj = null;
        try { payloadObj = JSON.parse(saved.payload || '{}'); } catch {}
        const targetTradeId = payloadObj?.targetTradeId || null;

        if(order.side==='BUY'){
          quantity=D(current.quantity).plus(qty);
          cost=D(current.cost_basis).plus(notional).plus(fee);
          initialRisk=D(current.initial_risk).plus(qty.mul(price.minus(order.stopLoss).abs()));
          pnl=D(current.cumulative_pnl);

          // R-1B: บันทึก Lot ใหม่ลงตาราง ledger_position_allocations
          const posId = `pos_${row.id}_${Date.now()}`;
          await this.db.prepare(`
            INSERT INTO ledger_position_allocations(
              position_id,user_id,account_id,execution_mode,broker,symbol,
              entry_signal_id,entry_trade_id,status,filled_quantity,remaining_quantity,
              entry_price,stop_loss,take_profit,opened_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            posId, row.user_id, row.account_id, row.execution_mode, row.broker, row.symbol,
            row.id, row.trade_id, 'OPEN', exact(qty), exact(qty),
            amount(price), order.stopLoss || null, order.takeProfit || null, Date.now(), Date.now()
          );
        }else{
          if(qty.gt(current.quantity))throw new Error('Fill exceeds tracked position; operator reconciliation required');
          quantity=D(current.quantity).minus(qty);

          // R-1B: ค้นหา Lot ที่ตรงกับ targetTradeId หรือเลือกแบบ FIFO หากไม่ได้ระบุ
          let openAllocations = [];
          if(targetTradeId){
            openAllocations = await this.db.prepare(`
              SELECT * FROM ledger_position_allocations 
              WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=? 
                AND (entry_trade_id=? OR position_id=?) AND status='OPEN' AND remaining_quantity>0
              ORDER BY opened_at ASC
            `).all(...scope(row), row.symbol, targetTradeId, targetTradeId);
            if(!openAllocations.length){
              throw new Error('Target allocation not found or already closed');
            }
          } else {
            openAllocations = await this.db.prepare(`
              SELECT * FROM ledger_position_allocations 
              WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=? 
                AND status='OPEN' AND remaining_quantity>0
              ORDER BY opened_at ASC
            `).all(...scope(row), row.symbol);
          }

          let remainingToClose = D(qty);
          let allocatedCost = D(0);

          for(const alloc of openAllocations){
            if(remainingToClose.lte(0)) break;
            const allocRem = D(alloc.remaining_quantity);
            const take = allocRem.lte(remainingToClose) ? allocRem : remainingToClose;
            const isClosed = allocRem.minus(take).isZero();
            
            allocatedCost = allocatedCost.plus(take.mul(alloc.entry_price));
            remainingToClose = remainingToClose.minus(take);

            await this.db.prepare(`
              UPDATE ledger_position_allocations 
              SET remaining_quantity=?, status=?, closed_at=?, updated_at=?
              WHERE position_id=?
            `).run(
              exact(allocRem.minus(take)),
              isClosed ? 'CLOSED' : 'OPEN',
              isClosed ? Date.now() : null,
              Date.now(),
              alloc.position_id
            );
          }

          if(targetTradeId && remainingToClose.gt(0)){
            throw new Error('Fill exceeds remaining target allocation quantity');
          }

          const removed = allocatedCost.gt(0) 
            ? allocatedCost 
            : (quantity.isZero() ? D(current.cost_basis) : D(amount(D(current.cost_basis).mul(qty).div(current.quantity))));

          cost=D(current.cost_basis).minus(removed);
          if(cost.lt(0)) cost = D(0);
          initialRisk=D(current.initial_risk);
          const profit=notional.minus(removed).minus(fee);
          pnl=D(current.cumulative_pnl).plus(profit);
          realizedR=initialRisk.gt(0)?profit.div(initialRisk):D(0);
          if(quantity.isZero())await this.db.prepare(`INSERT INTO ledger_streak VALUES(?,?,?,?) ON CONFLICT(user_id,account_id,execution_mode)
            DO UPDATE SET loss_streak=CASE WHEN ?::numeric<0 THEN ledger_streak.loss_streak+1 ELSE 0 END`).run(...scope(row),pnl.lt(0)?1:0,amount(pnl));
        }
        let activeStop = null, activeTp = null;
        if(quantity.gt(0)){
          if(order.side==='BUY'){
            activeStop = order.stopLoss || null;
            activeTp = order.takeProfit || null;
          }else{
            const latestAlloc = await this.db.prepare(`
              SELECT stop_loss,take_profit FROM ledger_position_allocations
              WHERE user_id=? AND account_id=? AND execution_mode=? AND symbol=? AND status='OPEN' AND remaining_quantity>0
              ORDER BY opened_at DESC LIMIT 1
            `).get(...scope(row), row.symbol);
            activeStop = latestAlloc?.stop_loss ?? current.stop_loss;
            activeTp = latestAlloc?.take_profit ?? current.take_profit;
          }
        }
        await this.db.prepare('INSERT INTO paper_cash_journal(signal_id,cumulative_quantity,user_id,broker,cash_delta,at) VALUES(?,?,?,?,?,?)').run(row.id,exact(total),row.user_id,row.broker,exact(cashDelta),Date.now());
        await this.db.prepare(`INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,avg_price,stop_loss,take_profit,initial_risk,cumulative_pnl,updated_at,cost_basis)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,account_id,execution_mode,symbol) DO UPDATE SET quantity=excluded.quantity,avg_price=excluded.avg_price,stop_loss=excluded.stop_loss,take_profit=excluded.take_profit,initial_risk=excluded.initial_risk,cumulative_pnl=excluded.cumulative_pnl,updated_at=excluded.updated_at,cost_basis=excluded.cost_basis`)
          .run(...scope(row),row.broker,row.symbol,exact(quantity),quantity.gt(0)?amount(cost.div(quantity)):'0',activeStop,activeTp,quantity.gt(0)?amount(initialRisk):'0',quantity.gt(0)?amount(pnl):'0',Date.now(),exact(cost));
        await this.db.prepare('INSERT INTO fills(signal_id,cumulative_quantity,delta_quantity,price,fee_quote,realized_r,received_at,quote_amount) VALUES(?,?,?,?,?,?,?,?)').run(row.id,exact(total),exact(qty),amount(price),exact(fee),amount(realizedR),Date.now(),exact(notional));
        await this.snapshotPaper(row.user_id,row.broker,'FILL');
      }
      await this.db.prepare(`INSERT INTO ledger_daily VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,account_id,execution_mode,day) DO UPDATE SET trades=ledger_daily.trades+excluded.trades,notional=ledger_daily.notional+excluded.notional,realized_r=ledger_daily.realized_r+excluded.realized_r`).run(...scope(row),day(),D(saved.applied_quantity).isZero()&&total.gt(0)?1:0,exact(notional),amount(realizedR));
      const status=execution.status==='NEW'?'SUBMITTED':execution.status,fillPrice=total.gt(0)?quote.div(total):null;
      const slip=fillPrice?(order.side==='BUY'?fillPrice.minus(order.price):D(order.price).minus(fillPrice)).div(order.price).mul(10000):null;
      await this.complete(row.id,status,{response:execution.raw,orderId:execution.orderId||saved.order_id,fillPrice:fillPrice?amount(fillPrice):null,slippageBps:slip?amount(slip):null,appliedQuantity:exact(total),appliedQuote:exact(quote)});
      await this.audit(row.user_id,'order.updated',row.trade_id,{status,mode:'PAPER',quantity:exact(total)});
      await this.db.prepare('INSERT INTO notification_outbox(user_id,subject,body) VALUES(?,?,?)').run(row.user_id,'Robot trade '+status+': '+row.symbol,'Trade '+row.trade_id+'\nMode PAPER\nFill '+(fillPrice?amount(fillPrice):'-'));
    });
  },
  async setRejectedNote(actor,id,note){
    if(!Number.isSafeInteger(id)||id<1||typeof note!=='string'||note.length>2000)throw new Error('Invalid signal note');
    const result=await this.db.prepare("UPDATE signals SET review_note=? WHERE id=? AND user_id=? AND status='REJECTED'").run(note.trim(),id,actor.id);return result.changes===1;
  },
  async listPositions(userId,isAdmin=false){return isAdmin?this.db.prepare('SELECT * FROM ledger_positions WHERE quantity>0').all():this.db.prepare('SELECT * FROM ledger_positions WHERE user_id=? AND quantity>0').all(userId);},
  async dailyAccounts(userId,mode='PAPER'){return this.db.prepare('SELECT d.*,COALESCE(s.loss_streak,0) loss_streak FROM ledger_daily d LEFT JOIN ledger_streak s USING(user_id,account_id,execution_mode) WHERE d.user_id=? AND d.execution_mode=? AND d.day=?').all(userId,mode,day());},
  async analyticsRows(userId,broker){return this.db.prepare("SELECT s.user_id,s.trade_id,s.broker,s.symbol,s.side,s.execution_mode,f.signal_id,f.cumulative_quantity,f.delta_quantity quantity,f.price,f.quote_amount,f.legacy_float,f.fee_quote,f.received_at FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=? AND s.broker=? AND s.execution_mode='PAPER' AND f.delta_quantity>0 ORDER BY f.received_at,f.signal_id,f.cumulative_quantity").all(userId,broker);},
  async analyticsFeeBps(userId,broker){return Number((await this.db.prepare('SELECT fee_bps FROM analytics_settings WHERE user_id=? AND broker=?').get(userId,broker))?.fee_bps||0);},
  async setAnalyticsFeeBps(userId,broker,bps){return this.db.prepare('INSERT INTO analytics_settings(user_id,broker,fee_bps,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,broker) DO UPDATE SET fee_bps=excluded.fee_bps,updated_at=excluded.updated_at').run(userId,broker,bps,Date.now());},
  async health(){return this.db.prepare("SELECT count(*) queued,MIN(received_at) oldest FROM signals WHERE status='QUEUED'").get();},
  async workerLastTick(){return (await this.db.prepare("SELECT COALESCE(MAX(last_tick),0) tick FROM worker_heartbeats WHERE role='execution'").get()).tick;}
};
