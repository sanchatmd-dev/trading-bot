import {D,amount,exact} from '../money.js';
import {hash,canonical,fail} from '../pine-bridge/source.js';
import {exitDecision,executionPrice,levels} from '../pine-bridge/contract.js';
import {deploymentEvidence,freshSnapshot} from './pine-bridge-readiness.js';
import {verifiedBar} from './pine-bridge-market.js';

export async function prepareBridgeExecution(store,job,signal,defaultRisk) {
  const b=signal.bridge;
  const row=await store.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND bot_id=?').get(b.deployment_id,job.user_id);
  const event=await store.db.prepare('SELECT * FROM pine_bridge_events WHERE deployment_id=? AND event_id=? AND signal_id=?').get(b.deployment_id,b.event_id,job.id);
  if(!row||!event)throw fail('BRIDGE_SCOPE_MISMATCH');
  if(row.state!=='READY'&&!(row.state==='EXIT_ONLY'&&b.event_type==='EXIT'))throw fail('BRIDGE_NOT_READY');
  const evidence=await deploymentEvidence(store.db,row),model=evidence.execution_model;
  if(hash(canonical(evidence))!==b.evidence_hash)throw fail('STALE_EVIDENCE');
  const bar=await verifiedBar(store.db,row,b.bar_time,model);
  if(bar.content_hash!==b.market_hash)throw fail('MARKET_DATA_CHANGED');
  const price=executionPrice(Number(bar.close),b.event_type,model.slippage_bps,model.price_tick);
  if(!D(price).eq(signal.referencePrice))throw fail('EXECUTION_PRICE_MISMATCH');
  if(b.event_type==='BUY') {
    const fresh=await freshSnapshot({db:store.db,store,defaultRisk},row);
    if(fresh.members.length!==1)throw fail('MULTI_PINE_REQUIRES_APP_3B');
    const frozen=levels(Number(bar.close),Number(bar.atr14),row.snapshot.selection.bridge.atr_multiplier,row.snapshot.selection.bridge.rr,model.price_tick);
    if(!D(frozen.sl).eq(signal.stopLoss)||!D(frozen.tp).eq(signal.takeProfit))throw fail('ENTRY_LEVEL_MISMATCH');
    const exits=await store.db.prepare("SELECT 1 FROM pine_bridge_events WHERE deployment_id=? AND bar_time=? AND payload->>'event_type'='EXIT' LIMIT 1").get(b.deployment_id,b.bar_time);
    if(exits)throw fail('BUY_SUPPRESSED_EXIT_BAR');
    const open=await store.db.prepare(`SELECT a.*,e.entry_ref FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id
      WHERE e.deployment_id=? AND a.status='OPEN' AND a.remaining_quantity>0`).all(b.deployment_id);
    for(const a of open)if(exitDecision({time:Number(a.entry_ref.split(':')[1]),entry_ref:a.entry_ref,sl:a.stop_loss,tp:a.take_profit},bar))throw fail('BUY_SUPPRESSED_EXIT_BAR');
  } else {
    const allocation=await store.db.prepare(`SELECT a.* FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id
      WHERE e.deployment_id=? AND e.entry_ref=? AND a.user_id=? AND a.account_id=? AND a.execution_mode='PAPER' AND a.symbol=? AND a.status='OPEN' AND a.remaining_quantity>0`).get(b.deployment_id,b.entry_ref,job.user_id,job.account_id,job.symbol);
    if(!allocation)throw fail('TARGET_NOT_OPEN');
    const decision=exitDecision({time:Number(b.entry_ref.split(':')[1]),entry_ref:b.entry_ref,sl:allocation.stop_loss,tp:allocation.take_profit},bar,b.reason==='NATIVE');
    if(!decision||decision.reason!==b.reason)throw fail('EXIT_PRIORITY_MISMATCH');
    signal.targetTradeId=allocation.position_id;
    signal.bridge.suppressed=decision.suppressed;
    // ledger.recordExecution reads the stored payload to choose the target.
    await store.db.prepare('UPDATE signals SET payload=? WHERE id=?').run(JSON.stringify(signal),job.id);
  }
  return model;
}

export function roundBridgeOrder(order,model) {
  const requested=D(order.quantity),quantity=requested.div(model.quantity_step).floor().mul(model.quantity_step);
  if(quantity.lte(0))throw fail('BELOW_QUANTITY_STEP');
  const notional=amount(quantity.mul(order.price)),fee=amount(D(notional).mul(model.fee_bps).div(10000));
  return {order:{...order,quantity:exact(quantity),notional,...(quantity.lt(requested)?{sizingAdjustment:{...order.sizingAdjustment,requestedQuantity:order.sizingAdjustment?.requestedQuantity??exact(requested),quantity:exact(quantity),reason:'Capped/rounded to verified venue quantity step'}}:{})},fee};
}
export async function completeBridgeExecution(store,job,signal,outcome) {
  const b=signal.bridge;
  if(outcome==='FILLED'&&b.event_type==='BUY') {
    const a=await store.db.prepare("SELECT position_id FROM ledger_position_allocations WHERE entry_signal_id=? AND user_id=? AND status='OPEN'").get(job.id,job.user_id);
    if(!a)throw fail('ALLOCATION_MAPPING_MISSING');
    await store.db.prepare('INSERT INTO pine_bridge_entries(deployment_id,entry_ref,allocation_id) VALUES(?,?,?)').run(b.deployment_id,b.entry_ref,a.position_id);
  }
  await store.db.prepare('UPDATE pine_bridge_events SET outcome=? WHERE deployment_id=? AND event_id=? AND signal_id=?').run(outcome,b.deployment_id,b.event_id,job.id);
}
