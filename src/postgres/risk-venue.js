import {D,amount} from '../money.js';
import {fail} from '../pine-bridge/source.js';
import {fetchBinanceVenueSnapshot,validateVenueOrder} from '../pine-bridge/venue-filters.js';

const key=symbol=>'binance-spot-filters-v1:'+symbol;
export async function refreshPaperVenue(store,symbol,{now=Date.now(),fetcher}={}){
  if(symbol!=='BTCUSDT')throw fail('VENUE_REFRESH_MARKET_UNSUPPORTED');
  // Serialize refreshes independently of Bot policy. Public metadata only;
  // this endpoint never consumes account credentials or changes trading state.
  await store.db.lock('risk:venue:'+symbol);
  const cached=await store.getSetting(key(symbol),null);
  if(cached&&now>=cached.retrieved_at&&now-cached.retrieved_at<15000)return {snapshotHash:cached.hash,retrievedAt:cached.retrieved_at,cached:true};
  const snapshot=await fetchBinanceVenueSnapshot(symbol,{now,...(fetcher?{fetcher}:{})});
  await store.setSetting(key(symbol),snapshot);
  return {snapshotHash:snapshot.hash,retrievedAt:snapshot.retrieved_at,cached:false};
}

export async function checkPaperVenue(store,row,order,model,now=Date.now()){
  if(order.broker!=='binance-global'||order.symbol!=='BTCUSDT')return {status:'UNKNOWN',reasons:['VENUE_MARKET_UNSUPPORTED'],checks:[]};
  const snapshot=await store.getSetting(key(order.symbol),null);
  const positions=await store.db.prepare('SELECT symbol,quantity FROM ledger_positions WHERE user_id=? AND account_id=? AND execution_mode=?').all(row.user_id,row.account_id,'PAPER');
  const pending=await store.db.prepare("SELECT symbol,side,order_intent,applied_quantity FROM signals WHERE user_id=? AND account_id=? AND execution_mode='PAPER' AND status IN ('PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN') AND id<>?").all(row.user_id,row.account_id,row.id);
  let openBuy=D(0),unknown=false;
  for(const item of pending){
    if(item.symbol!==order.symbol||item.side!=='BUY')continue;
    const intent=item.order_intent&&JSON.parse(item.order_intent);
    if(!intent){unknown=true;continue;}
    openBuy=openBuy.plus(D(intent.quantity).minus(item.applied_quantity||0).clamp(0,Infinity));
  }
  const venue=validateVenueOrder(order,snapshot,{now,model,
    openOrders:pending.filter(item=>item.symbol===order.symbol).length,exchangeOpenOrders:pending.length,
    ...(unknown?{}:{basePosition:{free:positions.find(item=>item.symbol===order.symbol)?.quantity??'0',locked:'0',openBuyQuantity:amount(openBuy)}}),
    assetFilters:{scope:'PAPER',filters:[]}});
  return {...venue,snapshot,scope:'PAPER_PUBLIC_FILTERS',accountFilterAssumption:'Isolated Paper account; no exchange account asset filters. This is not Live venue approval.'};
}
