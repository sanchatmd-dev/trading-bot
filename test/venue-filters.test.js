import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchBinanceVenueSnapshot,validateVenueOrder,venueFreshnessMs} from '../src/pine-bridge/venue-filters.js';
import {hash,canonical} from '../src/pine-bridge/source.js';

const now=1800000000000,source='https://api.binance.com/api/v3/exchangeInfo';
const instrument=()=>({symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,orderTypes:['MARKET','LIMIT'],
  filters:[{filterType:'PRICE_FILTER',minPrice:'0.01',maxPrice:'1000000',tickSize:'0.01'},
    {filterType:'LOT_SIZE',minQty:'0.001',maxQty:'100',stepSize:'0.001'},
    {filterType:'MARKET_LOT_SIZE',minQty:'0',maxQty:'50',stepSize:'0'},
    {filterType:'MIN_NOTIONAL',minNotional:'10',applyToMarket:true,avgPriceMins:5},
    {filterType:'MAX_NUM_ORDERS',maxNumOrders:5}]});
const reference=(price=null)=>({kind:'REFERENCE',source:'https://api.binance.com/api/v3/referencePrice',symbol:'BTCUSDT',price,timestamp:now,retrieved_at:now});
const average=(minutes=5)=>({kind:'AVERAGE',source:'https://api.binance.com/api/v3/avgPrice',symbol:'BTCUSDT',price:'100',minutes,timestamp:now,retrieved_at:now});
function seal(value){const {hash:ignored,...payload}=value;return {...payload,hash:hash(canonical(payload))};}
function snapshot(change=()=>{}){
  const value={version:'binance-spot-filters-v1',source,symbol:'BTCUSDT',base_asset:'BTC',quote_asset:'USDT',status:'TRADING',spot_allowed:true,retrieved_at:now,
    instrument:instrument(),exchange_filters:[{filterType:'EXCHANGE_MAX_NUM_ORDERS',maxNumOrders:20}],reference_prices:[reference(),average()]};
  change(value);return seal(value);
}
const order=(change={})=>({symbol:'BTCUSDT',broker:'binance-global',orderType:'MARKET',side:'BUY',leverage:1,quantity:'1',price:'99999999',...change});
const options=(change={})=>({now,openOrders:0,exchangeOpenOrders:0,assetFilters:{scope:'PAPER',filters:[]},...change});
const validate=(value=snapshot(),intent=order(),context=options())=>validateVenueOrder(intent,value,context);
function outcome(result,status,reason){assert.equal(result.status,status,JSON.stringify(result));if(reason)assert.ok(result.reasons.includes(reason),JSON.stringify(result));}

test('Paper scope passes public filters, ignores modeled fill as VWAP and preserves inputs',()=>{
  const value=snapshot(),intent=order(),before=structuredClone({value,intent}),result=validate(value,intent);
  outcome(result,'PASSED');assert.equal(result.scope,'PAPER_PUBLIC_FILTERS');assert.equal(result.liveAccountVerified,false);
  assert.equal(result.snapshotHash,value.hash);assert.equal(result.retrievedAt,now);
  assert.ok(result.checks.some(check=>check.filter==='PRICE_FILTER'&&check.status==='NOT_APPLICABLE'));
  assert.deepEqual({value,intent},before);
});
for(const [name,quantity,status] of [['minimum exact','0.1','PASSED'],['below notional','0.099','BLOCKED'],['lot step mismatch','0.1001','BLOCKED'],['market maximum','51','BLOCKED'],['lot maximum','101','BLOCKED'],['excess decimal scale','0.1000000000000000001','BLOCKED'],['zero','0','BLOCKED']]){
  test('quantity and notional: '+name,()=>outcome(validate(snapshot(),order({quantity})),status));
}
for(const [name,change,reason] of [
  ['unknown filter',value=>value.instrument.filters.push({filterType:'NEW_FILTER',limit:1}),'UNSUPPORTED_FILTER_NEW_FILTER'],
  ['duplicate filter',value=>value.instrument.filters.push({...value.instrument.filters[1]}),'DUPLICATE_VENUE_FILTER'],
  ['missing lot',value=>value.instrument.filters=value.instrument.filters.filter(filter=>filter.filterType!=='LOT_SIZE'),'VENUE_REQUIRED_FILTER_MISSING'],
  ['malformed negative',value=>value.instrument.filters[1].minQty='-1','Malformed decimal'],
  ['malformed range',value=>value.instrument.filters[1].maxQty='0.0001','MALFORMED_FILTER_RANGE'],
  ['malformed market flag',value=>value.instrument.filters[3].applyToMarket='true','MALFORMED_FILTER'],
  ['unknown filter field',value=>value.instrument.filters[0].newConstraint=1,'MALFORMED_FILTER_PRICE_FILTER'],
  ['unimplemented exponent field',value=>value.instrument.filters[0].priceExponent=8,'MALFORMED_FILTER_PRICE_FILTER'],
  ['wrong filter scope',value=>value.exchange_filters.push({filterType:'MAX_POSITION',maxPosition:'10'}),'VENUE_FILTER_SCOPE_MISMATCH'],
])test('fail closed: '+name,()=>outcome(validate(snapshot(change)),'UNKNOWN',reason));
test('snapshot lifetime, future timestamp and content hash fail closed',()=>{
  assert.equal(venueFreshnessMs,60000);
  outcome(validate(snapshot(),order(),options({now:now+60001})),'UNKNOWN','VENUE_SNAPSHOT_MISSING_OR_STALE');
  outcome(validate(snapshot(value=>value.retrieved_at=now+1)),'UNKNOWN');
  const altered=snapshot();altered.instrument.filters[1].maxQty='1000';outcome(validate(altered),'UNKNOWN','VENUE_SNAPSHOT_HASH_MISMATCH');
});
test('Spot trading status and order type fail closed',()=>{
  outcome(validate(snapshot(value=>{value.status='HALT';value.instrument.status='HALT';})),'BLOCKED');
  outcome(validate(snapshot(),order({orderType:'LIMIT'})),'BLOCKED');
  outcome(validate(snapshot(),order({side:'SELL',reduceOnly:false})),'BLOCKED');
});
test('no fake VWAP fallback from modeled fill, wrong minutes, stale or foreign reference',()=>{
  for(const change of [value=>value.reference_prices=[],value=>value.reference_prices[1].minutes=1,value=>value.reference_prices[0].timestamp=now-60001,value=>value.reference_prices[1].symbol='ETHUSDT']){
    outcome(validate(snapshot(change)),'UNKNOWN','VENUE_REFERENCE_PRICE_REQUIRED');
  }
});
test('non-null Binance reference price overrides average price and needs fresh explicit absence for fallback',()=>{
  outcome(validate(snapshot(value=>value.reference_prices=[reference('5'),average()])),'BLOCKED','VENUE_NOTIONAL_FILTER_FAILED');
  outcome(validate(snapshot(value=>value.reference_prices=[average()])),'UNKNOWN');
  outcome(validate(snapshot(value=>value.reference_prices=[reference('100')])),'PASSED');
});
test('zero-minute notional requires sourced last trade',()=>{
  const value=snapshot(value=>{value.instrument.filters[3].avgPriceMins=0;value.reference_prices=[reference(),{...average(0),kind:'LAST',source:'https://api.binance.com/api/v3/trades'}];});
  outcome(validate(value),'PASSED');
});
test('MIN_NOTIONAL and NOTIONAL apply market flags independently',()=>{
  const value=snapshot(value=>{value.instrument.filters[3].applyToMarket=false;value.instrument.filters.push({filterType:'NOTIONAL',minNotional:'50',maxNotional:'150',applyMinToMarket:true,applyMaxToMarket:true,avgPriceMins:5});});
  outcome(validate(value,order({quantity:'0.4'})),'BLOCKED');outcome(validate(value,order({quantity:'1.5'})),'PASSED');outcome(validate(value,order({quantity:'1.501'})),'BLOCKED');
  outcome(validate(snapshot(value=>{value.instrument.filters[3].applyToMarket=false;value.reference_prices=[];})),'PASSED');
});
test('maximum order counts require both scoped counts and include proposed order',()=>{
  outcome(validate(snapshot(),order(),options({openOrders:5})),'BLOCKED','VENUE_OPEN_ORDER_LIMIT');
  outcome(validate(snapshot(),order(),options({exchangeOpenOrders:20})),'BLOCKED');
  outcome(validate(snapshot(),order(),options({openOrders:undefined})),'UNKNOWN','VENUE_OPEN_ORDER_COUNT_REQUIRED');
});
test('MAX_POSITION includes free, locked and pending BUY quantities; SELL does not increase position',()=>{
  const value=snapshot(value=>value.instrument.filters.push({filterType:'MAX_POSITION',maxPosition:'3'}));
  outcome(validate(value),'UNKNOWN','VENUE_BASE_POSITION_REQUIRED');
  outcome(validate(value,order(),options({basePosition:{free:'1',locked:'1',openBuyQuantity:'0'}})),'PASSED');
  outcome(validate(value,order(),options({basePosition:{free:'1',locked:'1',openBuyQuantity:'0.001'}})),'BLOCKED','VENUE_MAX_POSITION');
  outcome(validate(value,order({side:'SELL',reduceOnly:true})),'PASSED');
});
test('known non-applicable MARKET filters are explicitly classified, malformed ones never skipped',()=>{
  const value=snapshot(value=>value.instrument.filters.push({filterType:'PERCENT_PRICE',multiplierUp:'1.2',multiplierDown:'0.8',avgPriceMins:5},
    {filterType:'ICEBERG_PARTS',limit:10},{filterType:'MAX_NUM_ALGO_ORDERS',maxNumAlgoOrders:5},{filterType:'MAX_NUM_ICEBERG_ORDERS',maxNumIcebergOrders:5},
    {filterType:'MAX_NUM_ORDER_AMENDS',maxNumOrderAmends:5},{filterType:'MAX_NUM_ORDER_LISTS',maxNumOrderLists:5},
    {filterType:'TRAILING_DELTA',minTrailingAboveDelta:10,maxTrailingAboveDelta:100,minTrailingBelowDelta:10,maxTrailingBelowDelta:100}));
  outcome(validate(value),'PASSED');assert.ok(validate(value).checks.filter(check=>check.status==='NOT_APPLICABLE').length>=8);
  outcome(validate(snapshot(value=>value.instrument.filters.push({filterType:'ICEBERG_PARTS'}))),'UNKNOWN');
});
test('model tick mismatch and absent live account asset evidence cannot pass',()=>{
  outcome(validate(snapshot(),order(),options({model:{price_tick:'0.1'}})),'BLOCKED','VENUE_MODEL_TICK_MISMATCH');
  outcome(validate(snapshot(),order(),options({assetFilters:undefined})),'UNKNOWN','LIVE_VENUE_ASSET_FILTERS_UNVERIFIED');
  outcome(validate(snapshot(),order(),options({model:{quantity_step:'0.01'}})),'BLOCKED','VENUE_MODEL_STEP_MISMATCH');
  outcome(validate(snapshot(),order(),options({model:{price_tick:'0.01',quantity_step:'0.001'}})),'PASSED');
});
test('unsupported quote currency is blocked even with internally coherent identity',()=>{
  const value=snapshot(value=>{value.symbol='BTCBUSD';value.quote_asset='BUSD';value.instrument.symbol='BTCBUSD';value.instrument.quoteAsset='BUSD';value.instrument.filters[3].applyToMarket=false;});
  outcome(validate(value,order({symbol:'BTCBUSD'})),'BLOCKED','VENUE_QUOTE_CURRENCY_UNSUPPORTED');
});
test('MAX_ASSET limits base quantity and quote reference notional, with strict duplicate checks',()=>{
  outcome(validate(snapshot(),order(),options({assetFilters:{scope:'PAPER',filters:[{filterType:'MAX_ASSET',asset:'BTC',limit:'0.5'}]}})),'BLOCKED','VENUE_MAX_ASSET');
  outcome(validate(snapshot(value=>value.reference_prices=[reference('100')]),order(),options({assetFilters:{scope:'PAPER',filters:[{filterType:'MAX_ASSET',asset:'USDT',limit:'50'}]}})),'BLOCKED');
  const filter={filterType:'MAX_ASSET',asset:'BTC',limit:'2'};
  outcome(validate(snapshot(),order(),options({assetFilters:{scope:'PAPER',filters:[filter,filter]}})),'UNKNOWN','DUPLICATE_ASSET_FILTER');
});

const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('bounded acquisition retains full filters and fetches reference plus matching average',async()=>{
  const calls=[];const value=await fetchBinanceVenueSnapshot('BTCUSDT',{now,fetcher:async(url,options)=>{
    calls.push(url);assert.equal(options.redirect,'error');assert.ok(options.signal);
    if(url.includes('exchangeInfo'))return json({symbols:[instrument()],exchangeFilters:[{filterType:'EXCHANGE_MAX_NUM_ORDERS',maxNumOrders:20}]});
    if(url.includes('referencePrice'))return json({symbol:'BTCUSDT',referencePrice:null,timestamp:now});
    return json({mins:5,price:'100',closeTime:now});
  }});
  assert.equal(calls.length,3);assert.ok(calls.every(url=>url.startsWith('https://api.binance.com/api/v3/')));outcome(validate(value),'PASSED');
  assert.deepEqual(value.instrument,instrument());
});
test('acquisition disallows injected URLs and rejects oversize, invalid JSON and failed providers',async()=>{
  await assert.rejects(fetchBinanceVenueSnapshot('https://evil.test'),{code:'UNSUPPORTED_MARKET'});
  await assert.rejects(fetchBinanceVenueSnapshot('BTCUSDT',{fetcher:async()=>new Response('x'.repeat(256*1024+1))}),{code:'VENUE_RESPONSE_TOO_LARGE'});
  await assert.rejects(fetchBinanceVenueSnapshot('BTCUSDT',{fetcher:async()=>new Response('{bad')}),{code:'VENUE_RESPONSE_INVALID'});
  await assert.rejects(fetchBinanceVenueSnapshot('BTCUSDT',{fetcher:async()=>new Response('',{status:429})}),{code:'VENUE_PROVIDER_UNAVAILABLE'});
});
test('absolute acquisition deadline also bounds a provider that ignores abort',async()=>{
  const started=Date.now();await assert.rejects(fetchBinanceVenueSnapshot('BTCUSDT',{fetcher:async()=>new Promise(()=>{})}),{code:'VENUE_PROVIDER_TIMEOUT'});
  assert.ok(Date.now()-started<12000);
});
