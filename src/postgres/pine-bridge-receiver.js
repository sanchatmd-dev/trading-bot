import {validateEvent,levels,executionPrice} from '../pine-bridge/contract.js';
import {fail,hash,canonical} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {normalizeSignal} from './domain.js';
import {deploymentEvidence,freshSnapshot} from './pine-bridge-readiness.js';
import {verifiedBar} from './pine-bridge-market.js';

export async function receiveBridge(store,secret,body,{defaultRisk={}}={}) {
 return store.db.transaction(async()=>{
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
  const session=await store.getBotSession(bot.id);
  const policy=session.locked_policy?JSON.parse(session.locked_policy):await store.risk(bot.id,defaultRisk);
  validateEvent(body,row.snapshot.market,Date.now(),policy.maxSignalAgeSeconds*1000);
  if(row.state!=='READY'&&!(row.state==='EXIT_ONLY'&&body.event_type==='EXIT'))throw fail('BRIDGE_NOT_READY',409);
  const evidence=await deploymentEvidence(store.db,row),model=evidence.execution_model;
  if(body.event_type==='BUY')await freshSnapshot({db:store.db,store,defaultRisk},row);
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
  const tradeId='pb-'+hash(row.deployment_id+':'+body.event_id).slice(0,48);
  const signal=normalizeSignal({trade_id:tradeId,broker:body.broker,symbol:body.symbol,timeframe:body.timeframe,event:body.event_type==='BUY'?'BUY':'SELL',reduce_only:body.event_type==='EXIT',timestamp:body.bar_time,entry:executionPrice(Number(bar.close),body.event_type,model.slippage_bps,model.price_tick),...(body.event_type==='BUY'?{sl:protection.sl,tp:protection.tp,risk_mode:'PERCENT_EQUITY',risk_value:model.risk_percent}:{}),volatility_percent:Number(D(bar.high).minus(bar.low).div(bar.close).mul(100))});
  // Never fabricate news data. An enabled news-risk policy blocks entries until
  // an independently supplied news policy source is available.
  signal.bridge={deployment_id:row.deployment_id,event_id:body.event_id,entry_ref:body.entry_ref,bar_time:body.bar_time,event_type:body.event_type,reason:body.reason??null,market_hash:bar.content_hash,evidence_hash:hash(canonical(evidence)),signal_close:bar.close,signal_atr14:bar.atr14};
  if(!await store.enqueue(bot.id,signal,'PAPER'))throw fail('SIGNAL_ID_CONFLICT',409);
  const saved=await store.db.prepare('SELECT id FROM signals WHERE user_id=? AND trade_id=?').get(bot.id,tradeId);
  await store.db.prepare('INSERT INTO pine_bridge_events(deployment_id,event_id,event_hash,entry_ref,bar_time,payload,signal_id,outcome) VALUES(?,?,?,?,?,?,?,?)').run(row.deployment_id,body.event_id,eventHash,body.entry_ref,body.bar_time,JSON.stringify(body),saved.id,'QUEUED');
  return {accepted:true,duplicate:false,signal_id:saved.id,execution_mode:'PAPER'};
 });
}
