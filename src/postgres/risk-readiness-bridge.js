import {D,amount} from '../money.js';
import {canonical,hash,keys,number,fail} from '../pine-bridge/source.js';
import {executionPrice,exitDecision,levels} from '../pine-bridge/contract.js';
import {normalizeSignal} from './domain.js';
import {deploymentEvidence,freshSnapshot} from './pine-bridge-readiness.js';
import {verifiedBar} from './pine-bridge-market.js';

// The caller owns the repeatable-read transaction and evaluates account/session
// guards. This resolver only reads persisted authority and constructs an intent.
export async function resolveBridgePreviewContext({store,ownerId,botId,request,defaultRisk,now=Date.now()}) {
  const buy=request?.event_type==='BUY';
  keys(request,['deployment_id','bar_time','event_type',...(buy?[]:['entry_ref','reason'])]);
  if(typeof request.deployment_id!=='string'||!request.deployment_id||request.deployment_id.length>200)throw fail('INVALID_DEPLOYMENT_ID');
  if(!['BUY','EXIT'].includes(request.event_type))throw fail('INVALID_EVENT_TYPE');
  number(request.bar_time,{min:1,max:now,integer:true});
  if(!buy&&(!['SL','TP','NATIVE'].includes(request.reason)||typeof request.entry_ref!=='string'||request.entry_ref.length>300))throw fail('INVALID_EXIT');
  if(!await store.ownsBot(ownerId,botId))throw fail('BOT_ACCESS_DENIED',403);
  const owner=await store.userById(ownerId),bot=await store.userById(botId);
  if(owner?.status!=='ACTIVE'||bot?.status!=='ACTIVE')throw fail('ACCOUNT_SUSPENDED',403);
  const row=await store.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=? AND bot_id=?').get(request.deployment_id,ownerId,botId);
  if(!row)throw fail('NOT_FOUND',404);
  if(hash(canonical(row.snapshot))!==row.snapshot_hash)throw fail('STALE_DEPLOYMENT_SNAPSHOT',409);
  if(row.state!=='READY'&&!(row.state==='EXIT_ONLY'&&!buy))throw fail('BRIDGE_NOT_READY',409);
  const evidence=await deploymentEvidence(store.db,row),model=evidence.execution_model;
  const session=await store.getBotSession(botId);
  const policy=session.locked_policy?JSON.parse(session.locked_policy):await store.risk(botId,defaultRisk);
  const policySource=session.locked_policy?'LOCKED_SESSION':session.state==='RUNNING'?'SAVED_POLICY_FALLBACK':'SAVED_POLICY';
  if(now-request.bar_time>policy.maxSignalAgeSeconds*1000)throw fail('STALE_EVENT');
  if(buy){
    const fresh=await freshSnapshot({db:store.db,store,defaultRisk},row);
    if(fresh.members.length!==1)throw fail('MULTI_PINE_REQUIRES_APP_3B',409);
  }
  const market=row.snapshot.market;
  if(market.deployment_id!==row.deployment_id||market.pine_import_id!==row.pine_import_id||market.source_version!==row.source_version)throw fail('DEPLOYMENT_MISMATCH',409);
  const bar=await verifiedBar(store.db,row,request.bar_time,model);
  let protection={},targetTradeId,decision;
  const entryRef=buy?row.deployment_id+':'+request.bar_time+':0':request.entry_ref;
  if(buy){
    protection=levels(Number(bar.close),Number(bar.atr14),row.snapshot.selection.bridge.atr_multiplier,row.snapshot.selection.bridge.rr,model.price_tick);
    const exits=await store.db.prepare("SELECT 1 FROM pine_bridge_events WHERE deployment_id=? AND bar_time=? AND payload->>'event_type'='EXIT' LIMIT 1").get(row.deployment_id,request.bar_time);
    if(exits)throw fail('BUY_SUPPRESSED_EXIT_BAR');
    const open=await store.db.prepare(`SELECT a.*,e.entry_ref FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id
      WHERE e.deployment_id=? AND a.status='OPEN' AND a.remaining_quantity>0`).all(row.deployment_id);
    for(const allocation of open){
      if(exitDecision({time:Number(allocation.entry_ref.split(':')[1]),entry_ref:allocation.entry_ref,sl:allocation.stop_loss,tp:allocation.take_profit},bar))throw fail('BUY_SUPPRESSED_EXIT_BAR');
    }
  }else{
    const referencePrefix=row.deployment_id+':';
    const suffix=entryRef.startsWith(referencePrefix)?entryRef.slice(referencePrefix.length):'';
    if(!/^\d+:0$/.test(suffix)||!Number.isSafeInteger(Number(suffix.split(':')[0]))||Number(suffix.split(':')[0])>=request.bar_time)throw fail('INVALID_ENTRY_REFERENCE');
    const allocation=await store.db.prepare(`SELECT a.* FROM pine_bridge_entries e JOIN ledger_position_allocations a ON a.position_id=e.allocation_id
      WHERE e.deployment_id=? AND e.entry_ref=? AND a.user_id=? AND a.account_id=? AND a.execution_mode='PAPER' AND a.symbol=? AND a.status='OPEN' AND a.remaining_quantity>0`).get(row.deployment_id,entryRef,botId,market.broker+':primary',market.symbol);
    if(!allocation)throw fail('TARGET_NOT_OPEN');
    decision=exitDecision({time:Number(suffix.split(':')[0]),entry_ref:entryRef,sl:allocation.stop_loss,tp:allocation.take_profit},bar,request.reason==='NATIVE');
    if(!decision||decision.reason!==request.reason)throw fail('EXIT_PRIORITY_MISMATCH');
    targetTradeId=allocation.position_id;
  }
  const signal=normalizeSignal({trade_id:'bridge-preview',broker:market.broker,symbol:market.symbol,timeframe:market.timeframe,
    event:buy?'BUY':'SELL',reduce_only:!buy,timestamp:request.bar_time,
    entry:executionPrice(Number(bar.close),request.event_type,model.slippage_bps,model.price_tick),
    ...(buy?{sl:protection.sl,tp:protection.tp,risk_mode:'PERCENT_EQUITY',risk_value:model.risk_percent}:{target_trade_id:targetTradeId}),
    volatility_percent:Number(D(bar.high).minus(bar.low).div(bar.close).mul(100))},now);
  const evidenceHash=hash(canonical(evidence));
  signal.bridge={deployment_id:row.deployment_id,entry_ref:entryRef,bar_time:request.bar_time,event_type:request.event_type,
    reason:request.reason??null,market_hash:bar.content_hash,evidence_hash:evidenceHash,signal_close:bar.close,signal_atr14:bar.atr14,
    ...(decision?{suppressed:decision.suppressed}:{})};
  const limitations=['POINT_IN_TIME_ONLY','PAPER_ONLY','COST_BASIS_NOT_MARK_TO_MARKET','VENUE_FILTERS_UNVERIFIED',
    'HYPOTHETICAL_BRIDGE_INTENT','COST_INCLUSIVE_RISK_LIMIT_NOT_ENFORCED','PENDING_FEE_RESERVATIONS_UNSUPPORTED'];
  if(policySource==='SAVED_POLICY_FALLBACK')limitations.push('RUNNING_LOCKED_POLICY_MISSING');
  return {signal,model,policy,policySource,session,
    deployment:{id:row.deployment_id,state:row.state,snapshotHash:row.snapshot_hash,evidenceHash},
    market:{broker:market.broker,symbol:market.symbol,timeframe:market.timeframe,barTime:bar.time,contentHash:bar.content_hash},limitations};
}

// Scenario prices assume the verified exit-bar close equals the frozen trigger.
// Real exit-bar closes and gaps can produce larger losses. No risk cap is proven.
export function previewBridgeCosts(order,model,account) {
  const quantity=D(order.quantity),price=D(order.price),feeRate=D(model.fee_bps).div(10000);
  const fee=amount(D(order.notional).mul(feeRate)),buy=order.side==='BUY';
  const result={model:{...model},fee,entryFee:buy?fee:null,
    cashDebit:buy?amount(D(order.notional).plus(fee)):null,
    cashCredit:buy?null:amount(D(order.notional).minus(fee)),
    cashAfterOrder:amount(D(account.cash).plus(buy?D(order.notional).plus(fee).neg():D(order.notional).minus(fee))),
    estimatedStopExitFee:null,estimatedTargetExitFee:null,estimatedLossAtStop:null,estimatedProfitAtTarget:null,
    costToStopRatio:null,costToTargetRatio:null,riskLimitIncludesCosts:false,
    assumption:'Conditional estimate: exit-bar close equals the frozen trigger; fees, adverse slippage and tick rounding apply. Gaps and actual exit-bar closes can increase losses.'};
  if(!buy)return result;
  for(const [kind,level]of [['Stop',order.stopLoss],['Target',order.takeProfit]]){
    if(level===undefined||level===null)continue;
    const modeled=executionPrice(Number(level),'EXIT',model.slippage_bps,model.price_tick);
    const exitNotional=amount(quantity.mul(modeled)),exitFee=amount(D(exitNotional).mul(feeRate));
    const nominal=quantity.mul(kind==='Stop'?price.minus(level):D(level).minus(price));
    const costs=D(fee).plus(exitFee).plus(quantity.mul(D(level).minus(modeled)));
    result['estimated'+kind+'ExitPrice']=modeled;
    result['estimated'+kind+'ExitFee']=exitFee;
    result['costTo'+kind+'Ratio']=nominal.gt(0)?amount(costs.div(nominal)):null;
    if(kind==='Stop')result.estimatedLossAtStop=amount(D(order.notional).plus(fee).minus(exitNotional).plus(exitFee));
    else result.estimatedProfitAtTarget=amount(D(exitNotional).minus(exitFee).minus(order.notional).minus(fee));
  }
  return result;
}
