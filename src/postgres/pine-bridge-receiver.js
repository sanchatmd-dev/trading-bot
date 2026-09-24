import {validateEvent,levels,executionPrice} from '../pine-bridge/contract.js';
import {fail,hash,canonical} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {normalizeSignal} from './domain.js';
import {deploymentEvidence,freshSnapshot} from './pine-bridge-readiness.js';
import {verifiedBar} from './pine-bridge-market.js';

export const MARKET_WAIT_MS=5000;

export async function admitBridgeEvent(store,row,bot,body,eventHash,{defaultRisk={},allowWait=false,receivedAt=Date.now(),deadlineAt=Infinity}={}) {
  const now=Date.now(),session=await store.getBotSession(bot.id);
  const policy=session.locked_policy?JSON.parse(session.locked_policy):await store.risk(bot.id,defaultRisk);
  validateEvent(body,row.snapshot.market,now,policy.maxSignalAgeSeconds*1000);
  if(row.state!=='READY'&&!(row.state==='EXIT_ONLY'&&body.event_type==='EXIT'))throw fail('BRIDGE_NOT_READY',409);
  const evidence=await deploymentEvidence(store.db,row),model=evidence.execution_model;
  if(body.event_type==='BUY')await freshSnapshot({db:store.db,store,defaultRisk},row);
  const exists=await store.db.prepare('SELECT 1 FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? AND bar_time=?').get(body.broker,body.symbol,body.timeframe,body.bar_time);
  if(!exists){
    if(allowWait==='pending')return {waiting_market:true};
    if(!allowWait)throw fail('VERIFIED_MARKET_DATA_REQUIRED',409);
    const deadline=Math.min(receivedAt+MARKET_WAIT_MS,body.bar_time+policy.maxSignalAgeSeconds*1000);
    if(deadline<=now)throw fail('STALE_EVENT');
    await store.db.prepare('INSERT INTO pine_bridge_pending(deployment_id,event_id,event_hash,payload,received_at,deadline_at,status) VALUES(?,?,?,?,?,?,?)').run(row.deployment_id,body.event_id,eventHash,JSON.stringify(body),receivedAt,deadline,'WAITING_MARKET');
    return {accepted:true,duplicate:false,pending_market:true,outcome:'WAITING_MARKET',execution_mode:'PAPER',deadline_at:deadline};
  }
  const bar=await verifiedBar(store.db,row,body.bar_time,model);
  let protection={};
  if(body.event_type==='BUY') {
    // Pine uses binary floats; admit numerical noise only when rounded levels
    // are identical. This tolerance never admits a different protective tick.
    if(!D(body.close).eq(bar.close)||D(body.atr).minus(bar.atr14).abs().gt(D(bar.atr14).mul('0.0000000001')))throw fail('MARKET_FACT_MISMATCH',409);
    protection=levels(Number(bar.close),Number(bar.atr14),row.snapshot.selection.bridge.atr_multiplier,row.snapshot.selection.bridge.rr,model.price_tick);
    const proposed=levels(body.close,body.atr,row.snapshot.selection.bridge.atr_multiplier,row.snapshot.selection.bridge.rr,model.price_tick);
    if(proposed.sl!==protection.sl||proposed.tp!==protection.tp)throw fail('MARKET_FACT_MISMATCH',409);
  }
  if(Date.now()>=deadlineAt)throw fail('MARKET_WAIT_EXPIRED');
  const tradeId='pb-'+hash(row.deployment_id+':'+body.event_id).slice(0,48);
  const signal=normalizeSignal({trade_id:tradeId,broker:body.broker,symbol:body.symbol,timeframe:body.timeframe,event:body.event_type==='BUY'?'BUY':'SELL',reduce_only:body.event_type==='EXIT',timestamp:body.bar_time,entry:executionPrice(Number(bar.close),body.event_type,model.slippage_bps,model.price_tick),...(body.event_type==='BUY'?{sl:protection.sl,tp:protection.tp,risk_mode:'PERCENT_EQUITY',risk_value:model.risk_percent}:{}),volatility_percent:Number(D(bar.high).minus(bar.low).div(bar.close).mul(100))});
  // Never fabricate news data. An enabled news-risk policy blocks entries until
  // an independently supplied news policy source is available.
  signal.bridge={deployment_id:row.deployment_id,event_id:body.event_id,entry_ref:body.entry_ref,bar_time:body.bar_time,event_type:body.event_type,reason:body.reason??null,market_hash:bar.content_hash,evidence_hash:hash(canonical(evidence)),signal_close:bar.close,signal_atr14:bar.atr14};
  if(!await store.enqueue(bot.id,signal,'PAPER'))throw fail('SIGNAL_ID_CONFLICT',409);
  const saved=await store.db.prepare('SELECT id FROM signals WHERE user_id=? AND trade_id=?').get(bot.id,tradeId);
  await store.db.prepare('INSERT INTO pine_bridge_events(deployment_id,event_id,event_hash,entry_ref,bar_time,payload,signal_id,outcome) VALUES(?,?,?,?,?,?,?,?)').run(row.deployment_id,body.event_id,eventHash,body.entry_ref,body.bar_time,JSON.stringify(body),saved.id,'QUEUED');
  return {accepted:true,duplicate:false,signal_id:saved.id,execution_mode:'PAPER'};
}

export async function receiveBridge(store,secret,body,{defaultRisk={},contractVersion=body?.schema_version}={}) {
 return store.db.transaction(async()=>{
  if(body?.schema_version!==contractVersion)throw fail('UNSUPPORTED_SCHEMA_VERSION');
  const bot=await store.userByWebhook(secret);
  const owner=bot&&await store.botOwner(bot.id);
  if(!bot||bot.status!=='ACTIVE'||owner?.status!=='ACTIVE')throw fail('NOT_FOUND',404);
  await store.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner.id);
  if(bot.id!==owner.id)await store.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(bot.id);
  const authenticated=await store.userByWebhook(secret),currentOwner=await store.botOwner(bot.id);
  if(authenticated?.id!==bot.id||authenticated.status!=='ACTIVE'||currentOwner?.status!=='ACTIVE')throw fail('NOT_FOUND',404);
  const row=await store.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=? AND owner_id=? AND bot_id=?').get(body.deployment_id,owner.id,bot.id);
  if(!row)throw fail('NOT_FOUND',404);
  const eventHash=hash(canonical(body));
  const duplicate=await store.db.prepare('SELECT * FROM pine_bridge_events WHERE deployment_id=? AND event_id=?').get(row.deployment_id,body.event_id);
  if(duplicate){if(duplicate.event_hash!==eventHash)throw fail('EVENT_CONFLICT',409);return {accepted:true,duplicate:true,outcome:duplicate.outcome,signal_id:duplicate.signal_id};}
  if(contractVersion==='bridge-exit-v2'){
    const pending=await store.db.prepare('SELECT event_hash,status,diagnostic,signal_id FROM pine_bridge_pending WHERE deployment_id=? AND event_id=?').get(row.deployment_id,body.event_id);
    if(pending){if(pending.event_hash!==eventHash)throw fail('EVENT_CONFLICT',409);return {accepted:true,duplicate:true,pending_market:pending.status==='WAITING_MARKET',outcome:pending.status,diagnostic:pending.diagnostic,signal_id:pending.signal_id,execution_mode:'PAPER'};}
  }
  const receivedAt=Date.now();
  const result=await admitBridgeEvent(store,row,bot,body,eventHash,{defaultRisk,allowWait:contractVersion==='bridge-exit-v2',receivedAt});
  if(contractVersion==='bridge-exit-v2'&&!result.pending_market){
    await store.db.prepare('INSERT INTO pine_bridge_pending(deployment_id,event_id,event_hash,payload,received_at,deadline_at,checked_at,status,signal_id) VALUES(?,?,?,?,?,?,?,?,?)').run(row.deployment_id,body.event_id,eventHash,JSON.stringify(body),receivedAt,receivedAt,Date.now(),'QUEUED',result.signal_id);
  }
  return result;
 });
}
