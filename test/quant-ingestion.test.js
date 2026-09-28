import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarRange,planIngestionRange} from '../src/quant-research/ingestion-range.js';
import {readSpotHistory,ingestSpotDataset} from '../src/quant-research/spot-ingestion.js';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatasetStore} from '../src/quant-research/dataset-store.js';
import {StorageBudget} from '../src/quant-research/storage-budget.js';
const start=Date.UTC(2026,8,1),end=start+1001*60000;
const request={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:end,warmup_bars:2,cutoff:end};
function page(url){const p=new URL(url).searchParams;const count=Number(p.get('limit')),first=Number(p.get('startTime'));return Array.from({length:count},(_,i)=>[first+i*60000,'100.0','102.0','99.0','101.0','12.0',first+i*60000+59999,'0',1,'0','0','0']);}
const collect=async options=>{const result=[];for await(const row of readSpotHistory(request,{clock:()=>end,beforePage:async()=>true,...options}))result.push(row);return result;};
test('UTC calendar range clamps leap/month ends and never substitutes a smaller interval',()=>{
  assert.equal(calendarRange('1M',Date.UTC(2024,2,31)).start_time,Date.UTC(2024,1,29));
  assert.equal(calendarRange('1Y',Date.UTC(2024,1,29)).start_time,Date.UTC(2023,1,28));
  assert.equal(calendarRange('YTD',Date.UTC(2026,8,1)).start_time,Date.UTC(2026,0,1));
  assert.throws(()=>calendarRange('ALL_AVAILABLE',end),{code:'INVALID_INGESTION_RANGE'});
  const plan=planIngestionRange(request,{now:end});assert.equal(plan.total_bars,1003);assert.equal(plan.evaluation_bars,1001);assert.equal(plan.metadata.start_time,start-120000);
  assert.throws(()=>planIngestionRange({...request,...calendarRange('1W',end)},{now:end}),{code:'INGESTION_CAPABILITY_LIMIT'});
  assert.throws(()=>planIngestionRange({...request,timeframe:'5'},{now:end}),{code:'INGESTION_CAPABILITY_UNAVAILABLE'});
  assert.throws(()=>planIngestionRange({...request,cutoff:end-1},{now:end}),{code:'INVALID_INGESTION_RANGE'});
});
test('pagination admits every page and preserves exact open timestamps/decimals without overlap',async()=>{
  const requests=[],proofs=[];let admissions=0;
  const rows=await collect({beforePage:async()=>{admissions++;return true;},fetcher:async url=>{requests.push(new URL(url));return Response.json(page(url));},onPage:value=>proofs.push(value)});
  assert.equal(rows.length,1003);assert.equal(admissions,2);assert.equal(requests[0].searchParams.get('limit'),'1000');assert.equal(requests[1].searchParams.get('limit'),'3');
  assert.equal(rows[0].time,start-120000);assert.equal(rows.at(-1).time,end-60000);assert.equal(rows[0].open,'100.0');assert.equal(proofs.length,2);assert.match(proofs[0].sha256,/^[a-f0-9]{64}$/);
});
test('ingestion rejects partial/gapped/duplicate/future rows and rate limits without retry',async()=>{
  for(const corrupt of [rows=>rows.slice(1),rows=>{rows[1][0]=rows[0][0];return rows;},rows=>{rows[0][6]++;return rows;},rows=>{rows[0][2]='1';return rows;}]){
    await assert.rejects(collect({fetcher:async url=>Response.json(corrupt(page(url)))}));
  }
  let calls=0;await assert.rejects(collect({fetcher:async()=>{calls++;return new Response('',{status:429});}}),{code:'INGESTION_RATE_LIMITED'});assert.equal(calls,1);
  await assert.rejects(collect({fetcher:async()=>new Response('x'.repeat(1024*1024+1))}),{code:'INGESTION_PAGE_TOO_LARGE'});
});
test('lease denial and cancellation stop before the next network call',async()=>{
  let calls=0;await assert.rejects(collect({beforePage:async()=>false,fetcher:async()=>{calls++;}}),{code:'INGESTION_ADMISSION_DENIED'});assert.equal(calls,0);
  const controller=new AbortController();await assert.rejects(collect({signal:controller.signal,fetcher:async url=>{calls++;return Response.json(page(url));},onPage:()=>controller.abort()}),{code:'INGESTION_CANCELLED'});assert.equal(calls,1);
});
test('budgeted ingestion publishes complete referenced raw data and removes failed partial pages',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-ingest-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storageBudget=new StorageBudget({root,diskQuotaBytes:16*1024*1024,tempQuotaBytes:8*1024*1024,freeFloorBytes:0});
  const store=new DatasetStore({root,storageBudget});
  const options={store,clock:()=>end,beforePage:async()=>true,fetcher:async url=>Response.json(page(url))};
  const result=await ingestSpotDataset(request,options);
  assert.equal(result.provenance.pages.length,2);assert.equal(result.provenance.verified_execution_profile,false);
  let count=0;for await(const bar of store.read(result.dataset)){void bar;count++;}assert.equal(count,1003);
  await assert.rejects(ingestSpotDataset(request,{...options,beforePage:async({page})=>page===0}),{code:'INGESTION_ADMISSION_DENIED'});
  assert.equal((await readdir(root)).filter(name=>name.startsWith('.pending-')).length,0);
  assert.equal((await storageBudget.inspect()).reservations,0);
});
