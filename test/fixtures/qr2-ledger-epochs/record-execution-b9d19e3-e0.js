// FROZEN READ-ONLY COPY for QR-2 replay parity only. Do not edit, do not import from product code.
// Source: git show b9d19e3:src/postgres/ledger.js, lines 99-241 (the recordExecution method, ledger rule epoch E0), copied verbatim.
// The only additions are this header, the imports and the two helper constants below, taken from the same file at that commit.
// Contract: docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md 6.2 (RC-Q4). The parity test runs it against a mock store with no database.
import {D,amount,exact} from '../../../src/money.js';
const day=()=>new Date().toISOString().slice(0,10);
const scope=row=>[row.user_id,row.account_id,row.execution_mode];

export const frozenLedgerE0={
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

          // F10 Fix: entry_price includes fee for accurate cost removal on exit
          const posId = `pos_${row.id}_${Date.now()}`;
          const lotCostPerUnit = notional.plus(fee).div(qty);
          await this.db.prepare(`
            INSERT INTO ledger_position_allocations(
              position_id,user_id,account_id,execution_mode,broker,symbol,
              entry_signal_id,entry_trade_id,status,filled_quantity,remaining_quantity,
              entry_price,stop_loss,take_profit,opened_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            posId, row.user_id, row.account_id, row.execution_mode, row.broker, row.symbol,
            row.id, row.trade_id, 'OPEN', exact(qty), exact(qty),
            amount(lotCostPerUnit), order.stopLoss || null, order.takeProfit || null, Date.now(), Date.now()
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

          // F10 Fix: Exits deduct precise lot cost (allocatedCost) 
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
};
