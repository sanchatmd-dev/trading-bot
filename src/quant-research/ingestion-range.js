import {canonical,fail,keys} from '../pine-bridge/source.js';
import {FOUNDATION_LIMITS,validateDatasetMetadata} from './foundation-contract.js';

const MINUTE=60000;
export const INGESTION_CAPABILITY=Object.freeze({version:'spot-ingestion-v1',broker:'binance-global',symbol:'BTCUSDT',market:'SPOT',timeframe:'1',interval_ms:MINUTE,max_total_bars:FOUNDATION_LIMITS.admittedBars,max_page_bars:1000,timestamp_semantics:'UTC open time; end exclusive',raw_only:true});
const instant=value=>Number.isSafeInteger(value)&&value>0&&value<=8_640_000_000_000_000&&value%MINUTE===0;

/** Exact requested evaluation range. Warm-up is additional, never silently
 * subtracted from the requested period. A range exceeding capability rejects.
 */
export function planIngestionRange(request,{now=Date.now()}={}) {
  keys(request,['broker','symbol','timeframe','start_time','end_time','warmup_bars','cutoff']);
  const {broker,symbol,timeframe,start_time:start,end_time:end,warmup_bars:warmup,cutoff}=request;
  if(broker!==INGESTION_CAPABILITY.broker||symbol!==INGESTION_CAPABILITY.symbol||timeframe!=='1')throw fail('INGESTION_CAPABILITY_UNAVAILABLE');
  if(!instant(start)||!instant(end)||start>=end||!Number.isSafeInteger(now)||!Number.isSafeInteger(cutoff)||cutoff<=0||cutoff>now||end>cutoff)throw fail('INVALID_INGESTION_RANGE');
  if(!Number.isSafeInteger(warmup)||warmup<0||warmup>5000)throw fail('INVALID_INGESTION_WARMUP');
  const evaluation=(end-start)/MINUTE,total=evaluation+warmup,first=start-warmup*MINUTE;
  if(total>INGESTION_CAPABILITY.max_total_bars)throw fail('INGESTION_CAPABILITY_LIMIT');
  if(first<=0)throw fail('INVALID_INGESTION_RANGE');
  const metadata=validateDatasetMetadata({version:'spot-dataset-v1',venue:broker,market:'SPOT',symbol,timeframe,start_time:first,end_time:end,warmup_bars:warmup,total_bars:total,cutoff,source:'binance-spot-klines-v1'});
  return JSON.parse(canonical({version:INGESTION_CAPABILITY.version,evaluation_start:start,evaluation_end:end,evaluation_bars:evaluation,warmup_bars:warmup,total_bars:total,page_count:Math.ceil(total/1000),timestamp_semantics:INGESTION_CAPABILITY.timestamp_semantics,metadata}));
}

/** UTC calendar periods; month/year subtraction clamps to the final valid day.
 * Resolving a period does not grant data/evaluator admission.
 */
export function calendarRange(period,endTime,{customStart,registeredStart,availableStart}={}) {
  if(!instant(endTime))throw fail('INVALID_INGESTION_RANGE');
  const end=new Date(endTime);let start;
  if(period==='1W')start=endTime-7*24*60*MINUTE;
  else if(['1M','3M','6M','1Y','2Y','3Y'].includes(period)){
    const months=({'1M':1,'3M':3,'6M':6,'1Y':12,'2Y':24,'3Y':36})[period];
    const day=end.getUTCDate();end.setUTCDate(1);end.setUTCMonth(end.getUTCMonth()-months);
    const last=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()+1,0)).getUTCDate();end.setUTCDate(Math.min(day,last));start=end.getTime();
  }else if(period==='YTD')start=Date.UTC(end.getUTCFullYear(),0,1);
  else if(period==='CUSTOM')start=customStart;
  else if(period==='ALL_REGISTERED')start=registeredStart;
  else if(period==='ALL_AVAILABLE')start=availableStart;
  else throw fail('UNSUPPORTED_RESEARCH_PERIOD');
  if(!instant(start)||start>=endTime)throw fail('INVALID_INGESTION_RANGE');
  return {start_time:start,end_time:endTime};
}
