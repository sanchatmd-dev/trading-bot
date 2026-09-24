import {D,amount,Money} from '../money.js';
import {hash,canonical,fail} from './source.js';

export const intervals=Object.freeze({'1':'1m','3':'3m','5':'5m','15':'15m','30':'30m','60':'1h','120':'2h','240':'4h','360':'6h','480':'8h','720':'12h','1D':'1d','3D':'3d','1W':'1w'});
const metadataProfile='binance-spot-identity-v1';
function spotIdentity(instrument,symbol) {
  const tick=instrument?.filters?.find(f=>f.filterType==='PRICE_FILTER')?.tickSize;
  const step=instrument?.filters?.find(f=>f.filterType==='LOT_SIZE')?.stepSize;
  if(!tick||!step||instrument.symbol!==symbol||instrument.status!=='TRADING'||instrument.isSpotTradingAllowed!==true||instrument.quoteAsset!=='USDT'||instrument.baseAsset+instrument.quoteAsset!==symbol)throw fail('UNSUPPORTED_MARKET');
  return {symbol:instrument.symbol,base_asset:instrument.baseAsset,quote_asset:instrument.quoteAsset,status:instrument.status,spot_allowed:true,price_tick:tick,quantity_step:step};
}
export function extendBarsFromKlines(klines,previous,metadata,now=Date.now()) {
  if(!Array.isArray(klines)||klines.length>1000||!previous||!Number.isSafeInteger(previous.time))throw fail('MARKET_SEED_REQUIRED');
  let close=D(previous.close),atr=D(previous.atr14),end=previous.time-1;
  const bars=[];
  for(const k of klines){
    if(!Array.isArray(k)||k.length<7||!Number.isSafeInteger(k[0])||!Number.isSafeInteger(k[6])||k[0]!==end+1||k[6]<k[0])throw fail('MARKET_DATA_GAP');
    const open=D(k[1]),high=D(k[2]),low=D(k[3]),nextClose=D(k[4]),volume=D(k[5]);
    if(low.lte(0)||high.lt(low)||high.lt(nextClose)||low.gt(nextClose)||high.lt(open)||low.gt(open)||volume.lt(0))throw fail('INVALID_MARKET_BAR');
    if(k[6]+1>now)break;
    const tr=Money.max(high.minus(low),high.minus(close).abs(),low.minus(close).abs());
    atr=atr.mul(13).plus(tr).div(14);close=nextClose;end=k[6];
    bars.push({time:end+1,open:String(k[1]),high:String(k[2]),low:String(k[3]),close:String(k[4]),volume:String(k[5]),atr14:amount(atr),...metadata});
  }
  return bars;
}
export function barsFromKlines(klines,metadata,now=Date.now()) {
  if(!Array.isArray(klines)||klines.length<515||klines.length>1000)throw fail('MARKET_WARMUP_REQUIRED');
  let previousClose=null,previousEnd=null,atr=null,seed=D(0);const bars=[];
  for(let i=0;i<klines.length;i++) {
    const k=klines[i];
    if(!Array.isArray(k)||k.length<7||!Number.isSafeInteger(k[0])||!Number.isSafeInteger(k[6])||k[6]<k[0]||(previousEnd!==null&&k[0]!==previousEnd+1))throw fail('MARKET_DATA_GAP');
    const open=D(k[1]),high=D(k[2]),low=D(k[3]),close=D(k[4]),volume=D(k[5]);
    if(low.lte(0)||high.lt(low)||high.lt(close)||low.gt(close)||high.lt(open)||low.gt(open)||volume.lt(0))throw fail('INVALID_MARKET_BAR');
    const tr=previousClose===null?high.minus(low):Money.max(high.minus(low),high.minus(previousClose).abs(),low.minus(previousClose).abs());
    if(i<14){seed=seed.plus(tr);if(i===13)atr=seed.div(14);}else atr=atr.mul(13).plus(tr).div(14);
    previousClose=close;previousEnd=k[6];
    if(i>=500&&k[6]+1<=now)bars.push({time:k[6]+1,open:String(k[1]),high:String(k[2]),low:String(k[3]),close:String(k[4]),volume:String(k[5]),atr14:amount(atr),...metadata});
  }
  return {bars,seed_hash:hash(canonical(klines)),warmup:500,atr_period:14};
}
export async function fetchBinanceBars(symbol,timeframe,{fetcher=fetch,now=Date.now()}={}) {
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!intervals[timeframe])throw fail('UNSUPPORTED_MARKET');
  async function get(path){
    const response=await fetcher('https://api.binance.com'+path,{signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw fail('MARKET_PROVIDER_UNAVAILABLE',503);
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw fail('MARKET_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const info=await get('/api/v3/exchangeInfo?symbol='+symbol),instrument=info.symbols?.find(s=>s.symbol===symbol);
  const identity=spotIdentity(instrument,symbol),tick=identity.price_tick,step=identity.quantity_step;
  const klines=await get('/api/v3/klines?symbol='+symbol+'&interval='+intervals[timeframe]+'&limit=1000');
  const result=barsFromKlines(klines,{price_tick:tick,quantity_step:step},now);
  return {...result,provenance:{profile:'closed-ohlcv-atr14-v1',source:'https://api.binance.com/api/v3/klines',metadata_profile:metadataProfile,metadata_hash:hash(canonical(identity)),seed_hash:result.seed_hash,warmup:500,atr_period:14,retrieved_at:now}};
}

export async function fetchBinanceNextBars(symbol,timeframe,previous,priorProvenance,{fetcher=fetch,now=Date.now()}={}) {
  if(!/^[A-Z0-9]{3,30}$/.test(symbol)||!intervals[timeframe])throw fail('UNSUPPORTED_MARKET');
  const infoResponse=await fetcher('https://api.binance.com/api/v3/exchangeInfo?symbol='+symbol,{signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!infoResponse.ok)throw fail('MARKET_PROVIDER_UNAVAILABLE',503);
  const infoBody=await infoResponse.text();
  if(Buffer.byteLength(infoBody)>2*1024*1024)throw fail('MARKET_RESPONSE_TOO_LARGE');
  const instrument=JSON.parse(infoBody).symbols?.find(s=>s.symbol===symbol);
  const identity=spotIdentity(instrument,symbol),tick=identity.price_tick,step=identity.quantity_step;
  if(!D(tick).eq(previous.price_tick)||!D(step).eq(previous.quantity_step))throw fail('MARKET_METADATA_MISMATCH');
  const metadataHash=hash(canonical(identity));
  if(priorProvenance?.metadata_profile===metadataProfile&&priorProvenance.metadata_hash!==metadataHash)throw fail('MARKET_METADATA_MISMATCH');
  const response=await fetcher('https://api.binance.com/api/v3/klines?symbol='+symbol+'&interval='+intervals[timeframe]+'&startTime='+previous.time+'&limit=1000',{signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!response.ok)throw fail('MARKET_PROVIDER_UNAVAILABLE',503);
  const body=await response.text();
  if(Buffer.byteLength(body)>2*1024*1024)throw fail('MARKET_RESPONSE_TOO_LARGE');
  const klines=JSON.parse(body);
  const metadata={price_tick:previous.price_tick,quantity_step:previous.quantity_step};
  return {bars:extendBarsFromKlines(klines,previous,metadata,now),provenance:{profile:'closed-ohlcv-atr14-v1',source:'https://api.binance.com/api/v3/klines',metadata_profile:metadataProfile,metadata_hash:metadataHash,...(priorProvenance?.metadata_profile===metadataProfile?{}:{legacy_metadata_hash:priorProvenance?.metadata_hash??null}),continuation_from:previous.time,retrieved_at:now}};
}
