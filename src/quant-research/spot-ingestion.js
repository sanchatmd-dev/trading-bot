import {D,exact} from '../money.js';
import {canonical,fail,hash} from '../pine-bridge/source.js';
import {planIngestionRange} from './ingestion-range.js';

const ORIGIN='https://api.binance.com';
const abort=signal=>{if(signal?.aborted)throw fail('INGESTION_CANCELLED');};
async function boundedJson(response,signal) {
  if(!response.ok)throw fail(response.status===429||response.status===418?'INGESTION_RATE_LIMITED':'INGESTION_HTTP_FAILED');
  const reader=response.body?.getReader();if(!reader)throw fail('INVALID_INGESTION_RESPONSE');
  let length=0;const buffers=[];
  try{
    while(true){abort(signal);const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1024*1024)throw fail('INGESTION_PAGE_TOO_LARGE');buffers.push(value);}
  }finally{await reader.cancel();}
  try{return JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{throw fail('INVALID_INGESTION_RESPONSE');}
}

/** Internal ingestion primitive only. The caller must hold a shared scheduler
 * lease, revalidate it through beforePage, and publish via the budgeted store.
 * No public endpoint or standalone unscheduled download command is exposed.
 */
export async function* readSpotHistory(request,{fetcher=fetch,signal,beforePage,onPage=()=>{},clock=Date.now}={}) {
  if(typeof beforePage!=='function')throw fail('INGESTION_ADMISSION_REQUIRED');
  const plan=planIngestionRange(request,{now:clock()});let next=plan.metadata.start_time,index=0;
  while(next<plan.metadata.end_time){
    abort(signal);if(await beforePage({page:index,next_time:next,plan})!==true)throw fail('INGESTION_ADMISSION_DENIED');abort(signal);
    const count=Math.min(1000,(plan.metadata.end_time-next)/60000);
    const url=new URL('/api/v3/klines',ORIGIN);url.search=new URLSearchParams({symbol:request.symbol,interval:'1m',startTime:String(next),endTime:String(next+count*60000-1),limit:String(count),timeZone:'0'}).toString();
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000);
    const response=await fetcher(url,{signal:combined,redirect:'error'});
    const rows=await boundedJson(response,signal);
    if(!Array.isArray(rows)||rows.length!==count)throw fail('INGESTION_MISSING_BARS');
    const parsed=[];
    for(let i=0;i<count;i++){
      const row=rows[i],time=next+i*60000;
      if(!Array.isArray(row)||row.length!==12||row[0]!==time||row[6]!==time+59999||row[6]>=request.cutoff)throw fail('INGESTION_BAR_SEQUENCE_MISMATCH');
      const bar={time,open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5]};
      for(const name of ['open','high','low','close','volume']){if(typeof bar[name]!=='string')throw fail('INVALID_INGESTION_PRICE');exact(bar[name]);if(D(bar[name]).lt(0)||(name!=='volume'&&!D(bar[name]).gt(0)))throw fail('INVALID_INGESTION_PRICE');}
      if(D(bar.high).lt(bar.low)||D(bar.high).lt(bar.open)||D(bar.high).lt(bar.close)||D(bar.low).gt(bar.open)||D(bar.low).gt(bar.close))throw fail('INVALID_INGESTION_PRICE');
      parsed.push(bar);
    }
    await onPage({page:index,start_time:next,end_time:next+count*60000,count,sha256:hash(canonical(rows)),retrieved_at:clock(),source:ORIGIN+'/api/v3/klines',timestamp_semantics:plan.timestamp_semantics});
    for(const bar of parsed){abort(signal);yield bar;}
    next+=count*60000;index++;
  }
}

/** Returns a complete immutable raw dataset and the page provenance to persist
 * with its admitted job. It cannot enroll raw OHLCV as a verified ATR14 profile.
 */
export async function ingestSpotDataset(request,{store,...options}={}) {
  if(!store?.storageBudget||typeof store.publish!=='function')throw fail('INGESTION_STORAGE_BUDGET_REQUIRED');
  const plan=planIngestionRange(request,{now:(options.clock??Date.now)()}),pages=[];
  const bars=readSpotHistory(request,{...options,onPage:async page=>{pages.push(page);await options.onPage?.(page);}});
  const dataset=await store.publish(plan.metadata,bars,{signal:options.signal,chunkBars:1000});
  return {dataset,provenance:{version:'spot-ingestion-v1',range:plan,pages,raw_only:true,verified_execution_profile:false}};
}
