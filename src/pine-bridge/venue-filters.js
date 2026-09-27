import {D,exact} from '../money.js';
import {canonical,hash,fail} from './source.js';

const origin='https://api.binance.com';
const infoSource=origin+'/api/v3/exchangeInfo';
export const venueFreshnessMs=60000;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const decimal=value=>{if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value))throw new Error('Malformed decimal');return D(exact(value));};
const schemas={
  PRICE_FILTER:['minPrice','maxPrice','tickSize'],LOT_SIZE:['minQty','maxQty','stepSize'],MARKET_LOT_SIZE:['minQty','maxQty','stepSize'],
  PERCENT_PRICE:['multiplierUp','multiplierDown','avgPriceMins'],PERCENT_PRICE_BY_SIDE:['bidMultiplierUp','bidMultiplierDown','askMultiplierUp','askMultiplierDown','avgPriceMins'],
  MIN_NOTIONAL:['minNotional','applyToMarket','avgPriceMins'],NOTIONAL:['minNotional','maxNotional','applyMinToMarket','applyMaxToMarket','avgPriceMins'],
  ICEBERG_PARTS:['limit'],MAX_NUM_ORDERS:['maxNumOrders'],EXCHANGE_MAX_NUM_ORDERS:['maxNumOrders'],
  MAX_NUM_ALGO_ORDERS:['maxNumAlgoOrders'],EXCHANGE_MAX_NUM_ALGO_ORDERS:['maxNumAlgoOrders'],
  MAX_NUM_ICEBERG_ORDERS:['maxNumIcebergOrders'],EXCHANGE_MAX_NUM_ICEBERG_ORDERS:['maxNumIcebergOrders'],
  MAX_POSITION:['maxPosition'],TRAILING_DELTA:['minTrailingAboveDelta','maxTrailingAboveDelta','minTrailingBelowDelta','maxTrailingBelowDelta'],
  MAX_NUM_ORDER_AMENDS:['maxNumOrderAmends'],MAX_NUM_ORDER_LISTS:['maxNumOrderLists'],EXCHANGE_MAX_NUM_ORDER_LISTS:['maxNumOrderLists'],MAX_ASSET:['asset','limit']
};
const numericStrings=new Set(['minPrice','maxPrice','tickSize','minQty','maxQty','stepSize','multiplierUp','multiplierDown','bidMultiplierUp','bidMultiplierDown','askMultiplierUp','askMultiplierDown','minNotional','maxNotional','maxPosition']);
function inspectFilter(filter){
  if(!object(filter)||typeof filter.filterType!=='string')throw new Error('MALFORMED_FILTER');
  const fields=schemas[filter.filterType];if(!fields)throw new Error('UNSUPPORTED_FILTER_'+filter.filterType);
  if(fields.some(key=>!Object.hasOwn(filter,key))||Object.keys(filter).some(key=>key!=='filterType'&&!fields.includes(key)))throw new Error('MALFORMED_FILTER_'+filter.filterType);
  for(const key of Object.keys(filter)){
    if(key==='filterType')continue;
    if(key==='asset'){if(!/^[A-Z0-9]{1,30}$/.test(filter[key]))throw new Error('MALFORMED_FILTER');}
    else if(key.startsWith('apply')){if(typeof filter[key]!=='boolean')throw new Error('MALFORMED_FILTER');}
    else if(numericStrings.has(key)||(key==='limit'&&filter.filterType==='MAX_ASSET'))decimal(filter[key]);
    else if(!integer(filter[key]))throw new Error('MALFORMED_FILTER');
  }
  for(const [lower,upper] of [['minPrice','maxPrice'],['minQty','maxQty'],['minNotional','maxNotional'],['multiplierDown','multiplierUp'],['bidMultiplierDown','bidMultiplierUp'],['askMultiplierDown','askMultiplierUp'],['minTrailingAboveDelta','maxTrailingAboveDelta'],['minTrailingBelowDelta','maxTrailingBelowDelta']]){
    if(Object.hasOwn(filter,lower)&&Object.hasOwn(filter,upper)&&D(filter[upper]).gt(0)&&D(filter[lower]).gt(filter[upper]))throw new Error('MALFORMED_FILTER_RANGE');
  }
}
const snapshotDigest=snapshot=>{const {hash:ignored,...payload}=snapshot;return hash(canonical(payload));};

// A maximum 60-second lifetime is a local Paper preflight policy, not a venue guarantee.
// Public filters never prove account-specific live venue permission or balances.
export function validateVenueOrder(order,snapshot,{now=Date.now(),model,openOrders,exchangeOpenOrders,basePosition,referencePrices,assetFilters}={}){
  const checks=[],reasons=[];
  const add=(filter,status,reason,detail)=>{checks.push({filter,status,...(reason?{reason}:{}),...(detail?{detail}:{})});if(['UNKNOWN','BLOCKED'].includes(status))reasons.push(reason);};
  const result=()=>({status:checks.some(check=>check.status==='BLOCKED')?'BLOCKED':checks.some(check=>check.status==='UNKNOWN')?'UNKNOWN':'PASSED',reasons:[...new Set(reasons)],snapshotHash:snapshot?.hash??null,retrievedAt:snapshot?.retrieved_at??null,scope:'PAPER_PUBLIC_FILTERS',liveAccountVerified:false,checks});
  if(!integer(now)||!object(snapshot)||snapshot.version!=='binance-spot-filters-v1'||snapshot.source!==infoSource||!integer(snapshot.retrieved_at)||snapshot.retrieved_at>now||now-snapshot.retrieved_at>venueFreshnessMs){add('SNAPSHOT','UNKNOWN','VENUE_SNAPSHOT_MISSING_OR_STALE');return result();}
  try{if(snapshot.hash!==snapshotDigest(snapshot))throw new Error();}catch{add('SNAPSHOT','UNKNOWN','VENUE_SNAPSHOT_HASH_MISMATCH');return result();}
  const instrument=snapshot.instrument;
  if(!object(instrument)||typeof instrument.symbol!=='string'||!/^[A-Z0-9]{3,30}$/.test(instrument.symbol)||typeof instrument.baseAsset!=='string'||!/^[A-Z0-9]{1,30}$/.test(instrument.baseAsset)||typeof instrument.quoteAsset!=='string'||!/^[A-Z0-9]{1,30}$/.test(instrument.quoteAsset)||instrument.symbol!==snapshot.symbol||instrument.baseAsset!==snapshot.base_asset||instrument.quoteAsset!==snapshot.quote_asset||instrument.status!==snapshot.status||instrument.isSpotTradingAllowed!==snapshot.spot_allowed||instrument.baseAsset+instrument.quoteAsset!==instrument.symbol){add('IDENTITY','UNKNOWN','VENUE_IDENTITY_MALFORMED');return result();}
  if(instrument.status!=='TRADING'||instrument.isSpotTradingAllowed!==true||!Array.isArray(instrument.orderTypes)||!instrument.orderTypes.includes('MARKET'))add('IDENTITY','BLOCKED','VENUE_SPOT_MARKET_UNAVAILABLE');
  if(instrument.quoteAsset!=='USDT')add('IDENTITY','BLOCKED','VENUE_QUOTE_CURRENCY_UNSUPPORTED');
  let quantity;
  try{
    if(!object(order)||order.symbol!==snapshot.symbol||order.broker!=='binance-global'||order.orderType!=='MARKET'||!['BUY','SELL'].includes(order.side)||order.leverage!==1||(order.side==='SELL'&&order.reduceOnly!==true))throw new Error();
    if(['icebergQty','trailingDelta','orderListId','amendments','stopPrice','quoteOrderQty'].some(key=>Object.hasOwn(order,key)))throw new Error();
    quantity=D(exact(order.quantity));if(quantity.lte(0))throw new Error();
  }catch{add('ORDER','BLOCKED','UNSUPPORTED_OR_INVALID_SPOT_MARKET_ORDER');return result();}
  const fresh=value=>object(value)&&value.symbol===snapshot.symbol&&integer(value.retrieved_at)&&value.retrieved_at<=now&&now-value.retrieved_at<=venueFreshnessMs&&integer(value.timestamp)&&value.timestamp<=now&&now-value.timestamp<=venueFreshnessMs;
  const references=referencePrices??snapshot.reference_prices;
  function reference(minutes){
    if(!Array.isArray(references))return null;
    const current=references.filter(value=>value.kind==='REFERENCE');
    if(current.length!==1||!fresh(current[0])||current[0].source!==origin+'/api/v3/referencePrice')return null;
    if(current[0].price!==null){try{const price=decimal(current[0].price);return price.gt(0)?price:null;}catch{return null;}}
    const matching=references.filter(value=>value.kind===(minutes===0?'LAST':'AVERAGE')&&value.minutes===minutes);
    if(matching.length!==1||!fresh(matching[0])||matching[0].source!==origin+(minutes===0?'/api/v3/trades':'/api/v3/avgPrice'))return null;
    try{const price=decimal(matching[0].price);return price.gt(0)?price:null;}catch{return null;}
  }
  if(!Array.isArray(instrument.filters)||!Array.isArray(snapshot.exchange_filters)){add('FILTERS','UNKNOWN','VENUE_FILTER_LIST_MALFORMED');return result();}
  const filters=[...instrument.filters,...snapshot.exchange_filters],seen=new Set();
  for(const filter of filters){
    if(seen.has(filter?.filterType)){add(filter?.filterType??'FILTER','UNKNOWN','DUPLICATE_VENUE_FILTER');continue;}seen.add(filter?.filterType);
    try{inspectFilter(filter);}catch(error){add(filter?.filterType??'FILTER','UNKNOWN',error.message);continue;}
    const type=filter.filterType;
    if((type.startsWith('EXCHANGE_')&&!snapshot.exchange_filters.includes(filter))||(!type.startsWith('EXCHANGE_')&&snapshot.exchange_filters.includes(filter))||type==='MAX_ASSET'){add(type,'UNKNOWN','VENUE_FILTER_SCOPE_MISMATCH');continue;}
    if(['LOT_SIZE','MARKET_LOT_SIZE'].includes(type)){
      const min=decimal(filter.minQty),max=decimal(filter.maxQty),step=decimal(filter.stepSize);
      if((min.gt(0)&&quantity.lt(min))||(max.gt(0)&&quantity.gt(max))||(step.gt(0)&&!quantity.mod(step).isZero()))add(type,'BLOCKED','VENUE_QUANTITY_FILTER_FAILED');else add(type,'PASSED');
      if(type==='LOT_SIZE'&&model?.quantity_step!==undefined&&step.gt(0)){
        try{if(!D(model.quantity_step).eq(step))add('MODEL_QUANTITY_STEP','BLOCKED','VENUE_MODEL_STEP_MISMATCH');else add('MODEL_QUANTITY_STEP','PASSED');}catch{add('MODEL_QUANTITY_STEP','UNKNOWN','VENUE_MODEL_STEP_INVALID');}
      }
    }else if(type==='PRICE_FILTER'){
      add(type,'NOT_APPLICABLE','MARKET_HAS_NO_SUBMITTED_PRICE');
      if(model?.price_tick!==undefined&&decimal(filter.tickSize).gt(0)){
        try{if(!D(model.price_tick).eq(filter.tickSize))add('MODEL_PRICE_TICK','BLOCKED','VENUE_MODEL_TICK_MISMATCH');else add('MODEL_PRICE_TICK','PASSED');}catch{add('MODEL_PRICE_TICK','UNKNOWN','VENUE_MODEL_TICK_INVALID');}
      }
    }else if(['PERCENT_PRICE','PERCENT_PRICE_BY_SIDE'].includes(type))add(type,'NOT_APPLICABLE','MARKET_HAS_NO_SUBMITTED_PRICE');
    else if(['MIN_NOTIONAL','NOTIONAL'].includes(type)){
      const applyMin=type==='MIN_NOTIONAL'?filter.applyToMarket:filter.applyMinToMarket,applyMax=type==='NOTIONAL'&&filter.applyMaxToMarket;
      if(!applyMin&&!applyMax){add(type,'NOT_APPLICABLE','MARKET_NOTIONAL_FLAGS_DISABLED');continue;}
      const price=reference(filter.avgPriceMins);
      if(!price){add(type,'UNKNOWN','VENUE_REFERENCE_PRICE_REQUIRED',{minutes:filter.avgPriceMins});continue;}
      const notional=quantity.mul(price);
      if((applyMin&&notional.lt(filter.minNotional))||(applyMax&&notional.gt(filter.maxNotional)))add(type,'BLOCKED','VENUE_NOTIONAL_FILTER_FAILED');else add(type,'PASSED');
    }else if(['MAX_NUM_ORDERS','EXCHANGE_MAX_NUM_ORDERS'].includes(type)){
      const count=type==='MAX_NUM_ORDERS'?openOrders:exchangeOpenOrders;
      if(!integer(count))add(type,'UNKNOWN','VENUE_OPEN_ORDER_COUNT_REQUIRED');else if(count+1>filter.maxNumOrders)add(type,'BLOCKED','VENUE_OPEN_ORDER_LIMIT');else add(type,'PASSED');
    }else if(type==='MAX_POSITION'){
      if(order.side==='SELL'){add(type,'NOT_APPLICABLE','SELL_DOES_NOT_INCREASE_BASE_POSITION');continue;}
      try{if(!object(basePosition))throw new Error();const values=['free','locked','openBuyQuantity'].map(key=>D(exact(basePosition[key])));if(values.some(value=>value.lt(0)))throw new Error();
        if(values.reduce((sum,value)=>sum.plus(value),quantity).gt(filter.maxPosition))add(type,'BLOCKED','VENUE_MAX_POSITION');else add(type,'PASSED');
      }catch{add(type,'UNKNOWN','VENUE_BASE_POSITION_REQUIRED');}
    }else add(type,'NOT_APPLICABLE','SIMPLE_MARKET_NO_ALGO_ICEBERG_TRAILING_AMEND_OR_LIST');
  }
  for(const required of ['PRICE_FILTER','LOT_SIZE'])if(!seen.has(required))add(required,'UNKNOWN','VENUE_REQUIRED_FILTER_MISSING');
  if(!object(assetFilters)||assetFilters.scope!=='PAPER'||!Array.isArray(assetFilters.filters))add('ASSET_FILTERS','UNKNOWN','LIVE_VENUE_ASSET_FILTERS_UNVERIFIED');
  else{
    add('ASSET_FILTERS_SCOPE','PASSED',undefined,'Explicit Paper fixture; authenticated live-account filters remain unverified');
    const assets=new Set();
    for(const filter of assetFilters.filters){
      try{inspectFilter(filter);if(filter.filterType!=='MAX_ASSET')throw new Error('UNSUPPORTED_ASSET_FILTER');if(assets.has(filter.asset))throw new Error('DUPLICATE_ASSET_FILTER');assets.add(filter.asset);
        if(filter.asset!==snapshot.base_asset&&filter.asset!==snapshot.quote_asset){add('MAX_ASSET','NOT_APPLICABLE','ASSET_NOT_IN_SYMBOL');continue;}
        const price=filter.asset===snapshot.quote_asset?reference(0):null;
        if(filter.asset===snapshot.quote_asset&&!price){add('MAX_ASSET','UNKNOWN','VENUE_REFERENCE_PRICE_REQUIRED');continue;}
        if((price?quantity.mul(price):quantity).gt(filter.limit))add('MAX_ASSET','BLOCKED','VENUE_MAX_ASSET');else add('MAX_ASSET','PASSED');
      }catch(error){add('MAX_ASSET','UNKNOWN',error.message);}
    }
  }
  return result();
}

export async function fetchBinanceVenueSnapshot(symbol,{fetcher=fetch,now=Date.now()}={}){
  if(typeof symbol!=='string'||!/^[A-Z0-9]{3,30}$/.test(symbol)||!integer(now))throw fail('UNSUPPORTED_MARKET');
  const controller=new AbortController();let rejectDeadline;
  const deadline=new Promise((resolve,reject)=>{rejectDeadline=reject;});
  const timer=setTimeout(()=>{controller.abort();rejectDeadline(fail('VENUE_PROVIDER_TIMEOUT',503));},10000);
  const bounded=work=>Promise.race([work,deadline]);
  async function get(path){
    const response=await bounded(fetcher(origin+path,{signal:controller.signal,redirect:'error'}));
    if(!response.ok)throw fail('VENUE_PROVIDER_UNAVAILABLE',503);
    const sizeHeader=response.headers?.get('content-length');if(sizeHeader&&Number(sizeHeader)>256*1024)throw fail('VENUE_RESPONSE_TOO_LARGE');
    const reader=response.body?.getReader();if(!reader)throw fail('VENUE_RESPONSE_INVALID');
    const chunks=[];let size=0;
    try{for(;;){const part=await bounded(reader.read());if(part.done)break;size+=part.value.length;if(size>256*1024)throw fail('VENUE_RESPONSE_TOO_LARGE');chunks.push(part.value);}}
    finally{reader.cancel().catch(()=>{});}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('VENUE_RESPONSE_INVALID');}
  }
  try{
    const info=await get('/api/v3/exchangeInfo?symbol='+symbol);
    if(!Array.isArray(info.symbols)||info.symbols.length!==1||info.symbols[0]?.symbol!==symbol||!Array.isArray(info.exchangeFilters))throw fail('VENUE_RESPONSE_INVALID');
    const instrument=info.symbols[0],reference_prices=[];
    const minutes=new Set((instrument.filters??[]).filter(filter=>filter?.filterType==='MIN_NOTIONAL'&&filter.applyToMarket||filter?.filterType==='NOTIONAL'&&(filter.applyMinToMarket||filter.applyMaxToMarket)).map(filter=>filter.avgPriceMins));
    if(minutes.size){
      const ref=await get('/api/v3/referencePrice?symbol='+symbol);
      if(ref.symbol!==symbol||(ref.referencePrice!==null&&typeof ref.referencePrice!=='string')||!integer(ref.timestamp))throw fail('VENUE_REFERENCE_RESPONSE_INVALID');
      reference_prices.push({kind:'REFERENCE',source:origin+'/api/v3/referencePrice',symbol,price:ref.referencePrice,timestamp:ref.timestamp,retrieved_at:now});
      if(ref.referencePrice===null){
        if([...minutes].some(value=>integer(value)&&value>0)){
          const avg=await get('/api/v3/avgPrice?symbol='+symbol);
          if(!integer(avg.mins)||!integer(avg.closeTime)||typeof avg.price!=='string')throw fail('VENUE_REFERENCE_RESPONSE_INVALID');
          reference_prices.push({kind:'AVERAGE',source:origin+'/api/v3/avgPrice',symbol,price:avg.price,minutes:avg.mins,timestamp:avg.closeTime,retrieved_at:now});
        }
        if(minutes.has(0)){
          const trades=await get('/api/v3/trades?symbol='+symbol+'&limit=1');
          if(!Array.isArray(trades)||trades.length!==1||!integer(trades[0].time)||typeof trades[0].price!=='string')throw fail('VENUE_REFERENCE_RESPONSE_INVALID');
          reference_prices.push({kind:'LAST',source:origin+'/api/v3/trades',symbol,price:trades[0].price,minutes:0,timestamp:trades[0].time,retrieved_at:now});
        }
      }
    }
    const snapshot={version:'binance-spot-filters-v1',source:infoSource,symbol,base_asset:instrument.baseAsset,quote_asset:instrument.quoteAsset,status:instrument.status,spot_allowed:instrument.isSpotTradingAllowed,retrieved_at:now,instrument,exchange_filters:info.exchangeFilters,reference_prices};
    snapshot.hash=snapshotDigest(snapshot);return snapshot;
  }finally{clearTimeout(timer);}
}
