import {D,Money,exact} from '../money.js';
import {fail,keys,number} from './source.js';

export const SCHEMA_VERSION='bridge-exit-v1';
export function levels(close,atr,multiplier,rr,tick) {
  [close,atr,multiplier,rr,tick].forEach(v=>number(v,{min:Number.MIN_VALUE,max:1e12}));
  const distance=D(atr).mul(multiplier),sl=D(close).minus(distance).div(tick).floor().mul(tick),tp=D(close).plus(distance.mul(rr)).div(tick).ceil().mul(tick);
  if(sl.lte(0)||sl.gte(close)||tp.lte(close))throw fail('INVALID_ENTRY_LEVELS');
  return {sl:exact(sl),tp:exact(tp)};
}
export function exitDecision(entry,bar,nativeExit=false) {
  if(bar.time<=entry.time)return null;
  const reasons=[];
  if(D(bar.low).lte(entry.sl))reasons.push('SL');
  if(D(bar.high).gte(entry.tp))reasons.push('TP');
  if(nativeExit)reasons.push('NATIVE');
  return reasons.length?{reason:reasons[0],suppressed:reasons.slice(1),entry_ref:entry.entry_ref}:null;
}
export function executionPrice(close,side,slippageBps,tick) {
  number(close,{min:Number.MIN_VALUE});number(slippageBps,{min:0,max:1000});number(tick,{min:Number.MIN_VALUE});
  if(!['BUY','EXIT'].includes(side))throw fail('INVALID_EVENT_TYPE');
  const raw=D(close).mul(D(1).plus(D(slippageBps).div(10000).mul(side==='BUY'?1:-1)));
  return exact(raw.div(tick).toDecimalPlaces(0,side==='BUY'?Money.ROUND_CEIL:Money.ROUND_FLOOR).mul(tick));
}
export function validateEvent(body,deployment,now=Date.now(),maxAgeMs=60000) {
  const fields=['schema_version','deployment_id','pine_import_id','source_version','broker','symbol','timeframe','event_id','event_type','entry_ref','bar_time','sequence'];
  keys(body,[...fields,...(body.event_type==='BUY'?['close','atr']:['reason'])]);
  if(body.schema_version!==SCHEMA_VERSION)throw fail('UNSUPPORTED_SCHEMA_VERSION');
  for(const field of ['deployment_id','pine_import_id','source_version','broker','symbol','timeframe'])if(body[field]!==deployment[field])throw fail('DEPLOYMENT_MISMATCH',409);
  if(!['BUY','EXIT'].includes(body.event_type))throw fail('INVALID_EVENT_TYPE');
  number(body.bar_time,{min:1,max:now,integer:true});number(body.sequence,{min:0,max:10000,integer:true});
  if(now-body.bar_time>maxAgeMs)throw fail('STALE_EVENT');
  if(typeof body.entry_ref!=='string'||!new RegExp('^'+deployment.deployment_id+':\\d+:0$').test(body.entry_ref))throw fail('INVALID_ENTRY_REFERENCE');
  const reference=deployment.deployment_id+':'+body.bar_time+':0';
  const eventId=body.event_type==='BUY'?reference+':BUY':body.entry_ref+':'+body.bar_time+':EXIT';
  if(body.event_id!==eventId||(body.event_type==='BUY'&&(body.entry_ref!==reference||body.sequence!==0)))throw fail('INVALID_EVENT_ID');
  if(body.event_type==='BUY'){number(body.close,{min:Number.MIN_VALUE});number(body.atr,{min:Number.MIN_VALUE});}
  else if(!['SL','TP','NATIVE'].includes(body.reason)||Number(body.entry_ref.split(':')[1])>=body.bar_time)throw fail('INVALID_EXIT');
  return body;
}
