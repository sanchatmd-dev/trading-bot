import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {validateFoundationRequest,validateBackfillState,validateBackfillResult} from '../src/quant-research/foundation-contract.js';
import {QuantResearchFoundationWorker} from '../src/postgres/quant-research-foundation.js';

const start=1_760_000_040_000;
function contract(total=2100,warmup=100){
  const range={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',start_time:start+warmup*60000,
    end_time:start+total*60000,warmup_bars:warmup,cutoff:start+total*60000};
  return validateFoundationRequest({version:'quant-foundation-v1',owner_id:'owner',bot_id:'bot',kind:'BACKFILL',
    range,engine_hash:'a'.repeat(64),snapshot_hash:hash(canonical(range)),budget:{candidates:1,max_evaluations:1,
      chunk_bars:Math.min(1000,total),max_runtime_ms:900000,max_output_bytes:1024*1024,max_state_bytes:1024*1024}});
}
function harness(){
  const saved=new Map(),checkpoints=[],fetched=[];
  const store={storageBudget:{},async publish(metadata,bars){
    const rows=[];for await(const bar of bars)rows.push(bar);
    assert.equal(rows.length,metadata.total_bars);
    const digest=hash(canonical({metadata,rows}));saved.set(digest,rows);
    return {dataset_id:digest,sha256:digest,metadata};
  },async *read(reference){yield* saved.get(reference.dataset_id);}};
  const worker=Object.create(QuantResearchFoundationWorker.prototype);
  worker.dataService={datasetStore:store};worker.clock=()=>start+3000*60000;
  worker.stopped=new Set();worker.activeLaunches=new Set();
  worker.fetchHistory=async function*(request,{beforePage,onPage}){
    fetched.push(request.start_time);
    assert.equal(await beforePage(),true);
    const count=(request.end_time-request.start_time)/60000;
    await onPage({page:0,start_time:request.start_time,end_time:request.end_time,count,
      sha256:'b'.repeat(64),retrieved_at:start+3000*60000,source:'https://api.binance.com/api/v3/klines',
      timestamp_semantics:'UTC open time; end exclusive'});
    for(let i=0;i<count;i++)yield {time:request.start_time+i*60000,open:'1',high:'1',low:'1',close:'1',volume:'0'};
  };
  worker.scheduler={fenced:async(job,action,callback)=>callback(job),checkpoint:async(job,value)=>{
    checkpoints.push(value);if(checkpoints.length===1)throw Object.assign(new Error('simulated interruption'),{code:'INTERRUPTED'});
  },finish:async(job,result)=>{validateBackfillResult(job.contract,checkpoints.at(-1),result);worker.result=result;}};
  return {worker,checkpoints,fetched,saved};
}

test('BACKFILL contract admits actual range, then rejects corrupt page/result bindings',()=>{
  const value=contract(1,0);
  assert.equal(value.kind,'BACKFILL');assert.equal(value.range.start_time,start);
  assert.throws(()=>validateFoundationRequest({...value,range:{...value.range,symbol:'ETHUSDT'}}),{code:'INGESTION_CAPABILITY_UNAVAILABLE'});
  assert.throws(()=>validateFoundationRequest({...value,snapshot_hash:'c'.repeat(64)}),{code:'INVALID_FOUNDATION_HASH'});
});

test('backfill resumes published pages and assembles raw dataset with original warmup',async()=>{
  const value=contract(),{worker,checkpoints,fetched}=harness();
  const foundation={job_id:'job',lease_token:'token',contract:value,next_bar:0,checkpoint:null};
  await assert.rejects(worker.runBackfill({foundation},new AbortController().signal),{code:'INTERRUPTED'});
  assert.equal(checkpoints[0].next_bar,1000);
  validateBackfillState(value,1000,checkpoints[0].state);
  assert.deepEqual(fetched,[start]);
  worker.scheduler.checkpoint=async(job,checkpoint)=>{checkpoints.push(checkpoint);};
  await worker.runBackfill({foundation:{...foundation,next_bar:1000,checkpoint:{state:checkpoints[0].state}}},new AbortController().signal);
  assert.equal(checkpoints.at(-1).next_bar,2100);
  assert.deepEqual(fetched,[start,start+1000*60000,start+2000*60000]);
  assert.equal(worker.result.dataset.metadata.warmup_bars,100);
  assert.equal(worker.result.dataset.metadata.total_bars,2100);
  assert.equal(worker.result.raw_only,true);
  assert.equal(worker.result.verified_execution_profile,false);
  assert.throws(()=>validateBackfillResult(value,checkpoints.at(-1),{...worker.result,raw_only:false}),{code:'BACKFILL_RESULT_INVALID'});
  assert.equal(worker.activeLaunches.size,0);
  assert.equal(worker.stopped.size,0);
});
