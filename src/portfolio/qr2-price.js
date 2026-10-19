import {validateBar} from '../postgres/pine-bridge-market.js';
import {hash,canonical} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {QR2_MARKET,QR2_PRICE_POLICY,QR2_METHODS,round18} from './qr2-constants.js';

// QR-2 price resolver (contract 2). Pure: it receives stored pine_market_bars rows as plain data and never reads a database,
// the clock or the network. Nothing is substituted: a price that fails verification or is older than carry_ms is unavailable.

export const PRICE_STATES=Object.freeze(['FRESH','STALE','UNAVAILABLE','PRICE_INTEGRITY_FAILED','UNSUPPORTED_MARKET','NO_POSITION']);
export const RETRIEVAL=Object.freeze({BY:'RETRIEVED_BY_INSTANT',AFTER:'RETRIEVED_AFTER_INSTANT',UNKNOWN:'RETRIEVAL_TIME_UNKNOWN',HISTORICAL:'HISTORICAL_RECOMPUTE'});

const isIntegerLike=value=>(typeof value==='number'&&Number.isSafeInteger(value))||(typeof value==='string'&&/^\d{1,16}$/.test(value)&&Number.isSafeInteger(Number(value)));
const toInteger=value=>Number(value);
const retrievedAt=row=>{
  const value=row?.provenance?.retrieved_at;
  return Number.isSafeInteger(value)?value:null;
};

// 2.1 verification per use: the bar parses, content_hash equals the hash of the canonical bar, the bar rules hold
// (validateBar: low > 0, low <= open and close <= high, volume >= 0, exact field set) and bar.time agrees with bar_time.
export function verifyBarRow(row){
  try{
    if(!row||!isIntegerLike(row.bar_time))return {ok:false,reason:'BAR_TIME_INVALID'};
    let bar=row.bar;
    if(typeof bar==='string'){try{bar=JSON.parse(bar);}catch{return {ok:false,reason:'BAR_NOT_PARSEABLE'};}}
    if(!bar||typeof bar!=='object'||Array.isArray(bar))return {ok:false,reason:'BAR_NOT_PARSEABLE'};
    // Same order as verifiedBar(): the hash first, then the bar rules, then the time.
    if(typeof row.content_hash!=='string'||hash(canonical(bar))!==row.content_hash)return {ok:false,reason:'CONTENT_HASH_MISMATCH'};
    try{validateBar(bar);}catch{return {ok:false,reason:'BAR_RULE_VIOLATED'};}
    if(bar.time!==toInteger(row.bar_time))return {ok:false,reason:'BAR_TIME_MISMATCH'};
    return {ok:true,bar};
  }catch{return {ok:false,reason:'BAR_NOT_PARSEABLE'};}
}

/**
 * Price of one market at instant T (UTC epoch ms): the stored bar with the largest bar_time <= T.
 * rows: stored rows {bar_time, bar, content_hash, provenance, broker?, symbol?, timeframe?}. A row of another market is ignored.
 * option 'M' (selected, O15): the bar whatever its retrieved_at; retrieval is information only and never changes the number.
 * option 'R' (not selected): only bars with retrieved_at <= T are candidates; a bar without retrieved_at is usable and
 * labelled HISTORICAL_RECOMPUTE.
 */
export function resolvePrice({broker=QR2_MARKET.broker,symbol=QR2_MARKET.symbol,instant,rows=[],option='M',policy=QR2_PRICE_POLICY}){
  if(!Number.isSafeInteger(instant))throw new TypeError('instant must be an integer epoch ms');
  if(option!=='M'&&option!=='R')throw new TypeError('option must be M or R');
  const method=option==='M'?QR2_METHODS.valuation_method:QR2_METHODS.valuation_method_option_r;
  const base={method,instant,fresh_ms:policy.fresh_ms,carry_ms:policy.carry_ms,symbol,broker};
  if(broker!==QR2_MARKET.broker||symbol!==QR2_MARKET.symbol)return {...base,state:'UNSUPPORTED_MARKET',price:null,bar_time:null,content_hash:null,age_ms:null,retrieval:null,reasons:['UNSUPPORTED_MARKET']};
  const candidates=[];
  for(const row of rows){
    if(!row)continue;
    if((row.broker!==undefined&&row.broker!==QR2_MARKET.broker)||(row.symbol!==undefined&&row.symbol!==QR2_MARKET.symbol)||(row.timeframe!==undefined&&String(row.timeframe)!==QR2_MARKET.timeframe))continue;
    if(!isIntegerLike(row.bar_time)){candidates.push({row,barTime:Number.NaN,malformed:true});continue;}
    const barTime=toInteger(row.bar_time);
    if(barTime>instant)continue;
    if(option==='R'){const at=retrievedAt(row);if(at!==null&&at>instant)continue;}
    candidates.push({row,barTime,malformed:false});
  }
  // A malformed bar_time can never be ordered; it makes the price integrity-failed rather than being skipped silently. RC-Q9: this
  // stays a conservative whole-set failure (fail closed): one malformed row of the market makes every instant PRICE_INTEGRITY_FAILED.
  const malformed=candidates.find(c=>c.malformed);
  if(malformed)return {...base,state:'PRICE_INTEGRITY_FAILED',price:null,bar_time:null,content_hash:null,age_ms:null,retrieval:null,reasons:['PRICE_INTEGRITY_FAILED','BAR_TIME_INVALID']};
  if(!candidates.length)return {...base,state:'UNAVAILABLE',price:null,bar_time:null,content_hash:null,age_ms:null,retrieval:null,reasons:['NO_PRICE_ROW']};
  let best=candidates[0];
  for(const c of candidates)if(c.barTime>best.barTime)best=c;
  const age=instant-best.barTime;
  // Beyond carry_ms no price is used, so nothing is verified and nothing is carried (A1).
  if(age>policy.carry_ms)return {...base,state:'UNAVAILABLE',price:null,bar_time:best.barTime,content_hash:null,age_ms:age,retrieval:null,reasons:['PRICE_OLDER_THAN_CARRY']};
  const verified=verifyBarRow(best.row);
  if(!verified.ok)return {...base,state:'PRICE_INTEGRITY_FAILED',price:null,bar_time:best.barTime,content_hash:null,age_ms:age,retrieval:null,reasons:['PRICE_INTEGRITY_FAILED',verified.reason]};
  const at=retrievedAt(best.row);
  const retrieval=at===null?(option==='R'?RETRIEVAL.HISTORICAL:RETRIEVAL.UNKNOWN):at<=instant?RETRIEVAL.BY:RETRIEVAL.AFTER;
  return {...base,state:age<=policy.fresh_ms?'FRESH':'STALE',price:D(verified.bar.close).toFixed(),bar_time:best.barTime,content_hash:best.row.content_hash,age_ms:age,retrieval,reasons:age<=policy.fresh_ms?[]:['PRICE_STALE']};
}

/**
 * Market value of one position at an instant (2.5). Quantity zero is NO_POSITION and needs no price (value exactly 0);
 * an unsupported market keeps quantity and cost visible and has no market value (O6).
 */
export function valuePosition({broker,symbol,quantity,instant,rows,option,policy}){
  const q=D(quantity);
  if(q.lt(0))throw new TypeError('quantity must not be negative');
  if(q.isZero())return {state:'NO_POSITION',symbol,broker,quantity:'0',market_value:'0',price:null,bar_time:null,content_hash:null,age_ms:null,retrieval:null,reasons:[]};
  const priced=resolvePrice({broker,symbol,instant,rows,option,policy});
  const usable=priced.state==='FRESH'||priced.state==='STALE';
  return {...priced,quantity:q.toFixed(),market_value:usable?round18(q.mul(priced.price)):null};
}

// The reference of a used price for inputs_hash (7.3): (bar_time, content_hash) or 'UNPRICED'.
export const priceReference=valued=>valued.state==='FRESH'||valued.state==='STALE'?[valued.bar_time,valued.content_hash]:'UNPRICED';
