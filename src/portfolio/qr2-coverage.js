import {assembleGaps} from '../market-gap-intervals.js';

export const QR2_COVERAGE_VERSION='qr2-bar-coverage-v1';
export const QR2_COVERAGE_MARKET=Object.freeze({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
const M=60000, MB=60000n, MAX=BigInt(Number.MAX_SAFE_INTEGER);
const KEYS=['version','source','market','resolved_range','inspected_window','excluded_edges','state','reason','complete','expected_minutes','stored_minutes','missing_minutes','interval_count','intervals'];
function invalid(path){const error=new TypeError('Invalid QR-2 coverage: '+path);error.code='QR2_COVERAGE_INVALID';error.path=path;throw error;}
function requireValue(condition,path){if(!condition)invalid(path);}
function keys(value,expected,path){
  requireValue(value!==null&&typeof value==='object'&&!Array.isArray(value),path);
  const actual=Reflect.ownKeys(value);
  requireValue(actual.length===expected.length&&expected.every(key=>Object.hasOwn(value,key)),path);
}
function array(value,path){
  requireValue(Array.isArray(value),path);
  requireValue(Reflect.ownKeys(value).length===value.length+1,path);
  for(let i=0;i<value.length;i++)requireValue(Object.hasOwn(value,i),path);
}
function integer(value,path){requireValue(Number.isSafeInteger(value)&&value>=0,path);return value;}
function checked(value,path){requireValue(value>=0n&&value<=MAX,path);return Number(value);}
function difference(to,from,path){return checked(BigInt(to)-BigInt(from),path);}
function minutes(to,from,path){const delta=difference(to,from,path);requireValue(delta%M===0,path);return delta/M;}
function marketOf(market){
  if(market===null)return null;
  keys(market,['broker','symbol','timeframe'],'market');
  requireValue(Object.entries(QR2_COVERAGE_MARKET).every(([k,v])=>market[k]===v),'market');
  return {...QR2_COVERAGE_MARKET};
}
function bounds(range){
  if(range===null)return {resolved_range:null,inspected_window:null,excluded_edges:[]};
  keys(range,['from','to'],'resolved_range');
  const from=integer(range.from,'resolved_range.from'),to=integer(range.to,'resolved_range.to');
  requireValue(from<to,'resolved_range.order');
  // BigInt prevents a rounded intermediate from passing a safe-integer check.
  const lower=checked(((BigInt(from)+MB-1n)/MB)*MB,'ceil_to_minute');
  const upper=checked((BigInt(to)/MB)*MB,'floor_to_minute');
  const resolved_range={from,to};
  if(lower>=upper)return {resolved_range,inspected_window:null,excluded_edges:[{from,to,reason:'PARTIAL_CANDLE'}]};
  const excluded_edges=[];
  if(from<lower)excluded_edges.push({from,to:lower,reason:'PARTIAL_CANDLE'});
  if(upper<to)excluded_edges.push({from:upper,to,reason:'PARTIAL_CANDLE'});
  return {resolved_range,inspected_window:{from:lower,to:upper},excluded_edges};
}
function base(range,market){
  return {version:QR2_COVERAGE_VERSION,source:'pine_market_bars',market:marketOf(market),...bounds(range)};
}
function disposition(head){
  if(head.market===null)return ['UNAVAILABLE','UNSUPPORTED_MARKET',false];
  if(head.resolved_range===null)return ['EMPTY','RANGE_UNRESOLVED',true];
  if(head.inspected_window===null)return ['EMPTY','NO_FULL_CANDLES',true];
  return null;
}
function nonComplete(head,state,reason,complete){
  const count=complete?0:null;
  return {...head,state,reason,complete,expected_minutes:count,stored_minutes:count,missing_minutes:count,interval_count:count,intervals:complete?[]:null};
}

/** Complete timestamp facts must come from a completed coverage read, never sparse valuation rows.
 * This pure function cannot certify that read. It does not inspect OHLCV integrity or compute money.
 */
export function buildBarCoverage(input){
  keys(input,['resolved_range','market','fact'],'input');
  const head=base(input.resolved_range,input.market),fact=input.fact;
  requireValue(fact!==null&&typeof fact==='object'&&!Array.isArray(fact),'fact');
  requireValue(['NOT_NEEDED','TABLE_ABSENT','COMPLETE'].includes(fact.state),'fact.state');
  keys(fact,fact.state==='COMPLETE'?['state','timestamps']:['state'],'fact');
  const fixed=disposition(head);
  if(fixed){requireValue(fact.state==='NOT_NEEDED','fact.contradiction');return nonComplete(head,...fixed);}
  requireValue(fact.state!=='NOT_NEEDED','fact.contradiction');
  if(fact.state==='TABLE_ABSENT')return nonComplete(head,'UNAVAILABLE','MARKET_DATA_TABLE_ABSENT',false);
  array(fact.timestamps,'fact.timestamps');
  const {from:lower,to:end}=head.inspected_window,internal=[];
  let previous=lower;
  for(const time of fact.timestamps){
    integer(time,'fact.timestamp');
    requireValue(time%M===0&&time>previous&&time<=end,'fact.timestamp.order_or_window');
    if(previous!==lower&&difference(time,previous,'gap.distance')>M)internal.push({prev:previous,bar_time:time});
    previous=time;
  }
  const n=fact.timestamps.length,capacity=checked(BigInt(internal.length)+2n,'gap.capacity');
  const gaps=assembleGaps({lower,end,n,first:n?fact.timestamps[0]:null,last:n?previous:null,internal,internalTotal:internal.length},capacity);
  requireValue(!gaps.truncated,'gap.truncated');
  const intervals=gaps.ranges.map(gap=>({from:integer(gap.from_open_time,'gap.from'),to:checked(BigInt(integer(gap.to_open_time,'gap.to'))+MB,'gap.exclusive_to'),missing_minutes:integer(gap.missing_minutes,'gap.missing_minutes')}));
  const output={...head,state:'COMPLETE',reason:null,complete:true,expected_minutes:minutes(end,lower,'expected_minutes'),stored_minutes:n,missing_minutes:gaps.missing_minutes,interval_count:intervals.length,intervals};
  const result=validateBarCoverage(output);
  if(!result.ok)invalid(result.errors[0].path);
  return output;
}

/** Closed structural validator. Passing does not prove the source scan completed. */
export function validateBarCoverage(value){
  try{
    keys(value,KEYS,'coverage');
    requireValue(value.version===QR2_COVERAGE_VERSION&&value.source==='pine_market_bars','version_or_source');
    const head=base(value.resolved_range,value.market);
    const equal=(a,b)=>{
      if(a===null||b===null)return a===b;
      if(Array.isArray(b)){array(a,'array_shape');return a.length===b.length&&b.every((v,i)=>equal(a[i],v));}
      if(typeof b==='object'){keys(a,Object.keys(b),'derived_shape');return Object.keys(b).every(k=>equal(a[k],b[k]));}
      return a===b;
    };
    requireValue(equal(value.inspected_window,head.inspected_window)&&equal(value.excluded_edges,head.excluded_edges),'derived_bounds');
    const fixed=disposition(head);
    if(fixed||value.state==='UNAVAILABLE'){
      const expected=fixed?nonComplete(head,...fixed):nonComplete(head,'UNAVAILABLE','MARKET_DATA_TABLE_ABSENT',false);
      requireValue(equal(value,expected),'state_fields');return {ok:true,errors:[]};
    }
    requireValue(value.state==='COMPLETE'&&value.reason===null&&value.complete===true,'state_fields');
    const window=head.inspected_window;
    requireValue(window!==null,'inspected_window');
    for(const key of ['expected_minutes','stored_minutes','missing_minutes','interval_count'])integer(value[key],key);
    requireValue(value.expected_minutes===minutes(window.to,window.from,'expected_minutes'),'expected_minutes');
    requireValue(value.stored_minutes<=value.expected_minutes&&value.expected_minutes-value.stored_minutes===value.missing_minutes,'count_identity');
    array(value.intervals,'intervals');
    requireValue(value.interval_count===value.intervals.length,'interval_count');
    let previousTo=null,total=0;
    for(const interval of value.intervals){
      keys(interval,['from','to','missing_minutes'],'interval');
      const from=integer(interval.from,'interval.from'),to=integer(interval.to,'interval.to');
      integer(interval.missing_minutes,'interval.missing_minutes');
      requireValue(from%M===0&&to%M===0&&from>=window.from&&to<=window.to&&from<to,'interval.bounds');
      requireValue(previousTo===null||previousTo<from,'interval.coalescence');
      requireValue(interval.missing_minutes===minutes(to,from,'interval.minutes'),'interval.minutes');
      total=checked(BigInt(total)+BigInt(interval.missing_minutes),'interval.total');previousTo=to;
    }
    requireValue(total===value.missing_minutes,'missing_minutes');
    return {ok:true,errors:[]};
  }catch(error){
    if(error.code!=='QR2_COVERAGE_INVALID')throw error;
    return {ok:false,errors:[{code:error.code,path:error.path}]};
  }
}
