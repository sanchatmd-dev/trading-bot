import {D,exact} from '../money.js';
import {keys,number,fail,hash,canonical} from '../pine-bridge/source.js';

export function validateBar(bar) {
  keys(bar,['time','open','high','low','close','volume','atr14','price_tick','quantity_step']);
  number(bar.time,{min:1,max:Number.MAX_SAFE_INTEGER,integer:true});
  for(const k of ['open','high','low','close','atr14','price_tick','quantity_step']){if(D(bar[k]).lte(0))throw fail('INVALID_MARKET_BAR');exact(bar[k]);}
  if(D(bar.volume).lt(0)||D(bar.high).lt(bar.low)||D(bar.high).lt(bar.open)||D(bar.high).lt(bar.close)||D(bar.low).gt(bar.open)||D(bar.low).gt(bar.close))throw fail('INVALID_MARKET_BAR');
  return bar;
}
export async function verifiedBar(db,deployment,time,model) {
  const market=deployment.snapshot.market;
  const row=await db.prepare('SELECT * FROM pine_market_bars WHERE broker=? AND symbol=? AND timeframe=? AND bar_time=?').get(market.broker,market.symbol,market.timeframe,time);
  if(!row||row.provenance.profile!==model.data_profile||hash(canonical(row.bar))!==row.content_hash)throw fail('VERIFIED_MARKET_DATA_REQUIRED',409);
  const bar=validateBar(row.bar);
  if(bar.time!==time||time>Date.now()||!D(bar.price_tick).eq(model.price_tick)||!D(bar.quantity_step).eq(model.quantity_step))throw fail('MARKET_METADATA_MISMATCH',409);
  return {...bar,content_hash:row.content_hash,provenance:row.provenance};
}
