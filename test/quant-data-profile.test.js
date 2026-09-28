import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatasetStore} from '../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {barsFromKlines} from '../src/pine-bridge/market-data.js';
import {hash} from '../src/pine-bridge/source.js';
import {rawProfileReadiness,verifyEnrollmentBinding} from '../src/quant-research/data-profile.js';
import {calendarRange,periodPreview} from '../src/quant-research/ingestion-range.js';

const minute=60000,start=Date.UTC(2024,0,1),length=520;
const model={data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'};
const evidence={source_hash:hash('source'),effective_inputs_hash:hash('settings'),evaluator_hash:hash('evaluator'),execution_model_hash:hash('model'),metadata_hash:hash('metadata'),raw_provenance_sha256:hash('provenance'),seed_bars:500};
const metadata=(first,count,warmup,cutoff)=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:first,end_time:first+count*minute,warmup_bars:warmup,total_bars:count,cutoff,source:'binance-spot-klines-v1'});
const candles=Array.from({length},(_,i)=>{
  const open=start+i*minute,base=100+i%13;
  return [open,String(base),String(base+2),String(base-1),String(base+1),'2',open+minute-1];
});
const rawBars=candles.map(k=>({time:k[0],open:k[1],high:k[2],low:k[3],close:k[4],volume:k[5]}));

test('UTC period boundaries, unsupported timezone and unsupported history fail closed',()=>{
  assert.equal(calendarRange('1M',Date.UTC(2024,2,31),{timezone:'UTC'}).start_time,Date.UTC(2024,1,29));
  assert.equal(calendarRange('1Y',Date.UTC(2024,1,29),{timezone:'UTC'}).start_time,Date.UTC(2023,1,28));
  assert.equal(periodPreview({period:'1W',end_time:Date.UTC(2024,2,31),warmup_bars:10}).total_bars,10090);
  assert.equal(periodPreview({period:'1W',end_time:Date.UTC(2024,2,31)}).admission,'OVER_RAW_LIMIT');
  assert.throws(()=>periodPreview({period:'1M',end_time:Date.UTC(2024,2,31),timezone:'Asia/Bangkok'}),{code:'UNSUPPORTED_REPORT_TIMEZONE'});
  assert.throws(()=>periodPreview({period:'ALL_AVAILABLE',end_time:Date.UTC(2024,2,31)}),{code:'INVALID_INGESTION_RANGE'});
  assert.throws(()=>periodPreview({period:'ALL_REGISTERED',end_time:Date.UTC(2024,2,31)}),{code:'UNSUPPORTED_RESEARCH_PERIOD'});
});

test('raw readiness stays false; trusted worker binding checks causal ATR and timestamps',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-profile-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const rawStore=new DatasetStore({root}),researchStore=new ResearchDatasetStore({root});
  const rawReference=await rawStore.publish(metadata(start,length,510,start+length*minute),rawBars,{chunkBars:100});
  const derived=barsFromKlines(candles,{price_tick:model.price_tick,quantity_step:model.quantity_step},start+length*minute);
  const derivedMetadata=metadata(start+501*minute,length-500,10,start+(length+1)*minute);
  const researchReference=await researchStore.publish(derivedMetadata,derived.bars,{model});
  const row={job_id:'job',status:'SUCCEEDED',contract:{kind:'BACKFILL'},result:{raw_only:true,verified_execution_profile:false,dataset:rawReference,provenance:{range:{timestamp_semantics:'UTC open time; end exclusive'}}}};
  const readiness=await rawProfileReadiness(row,rawStore);
  assert.equal(readiness.enrollment_ready,false);assert.equal(readiness.content_verified,false);
  assert.equal(readiness.blockers.length,3);
  const args={rawReference,researchReference,evidence,rawStore,researchStore};
  const binding=await verifyEnrollmentBinding(args);
  assert.equal(binding.data_profile_verified,true);assert.equal(binding.evaluator_admission,false);
  assert.match(binding.binding_sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(verifyEnrollmentBinding({...args,evidence:{...evidence,source_hash:'x'}}),{code:'PROFILE_EVIDENCE_REQUIRED'});
  await assert.rejects(verifyEnrollmentBinding({...args,evidence:{...evidence,seed_bars:499}}),{code:'PROFILE_SEED_REQUIRED'});
  await assert.rejects(verifyEnrollmentBinding({...args,researchReference:{...researchReference,raw:{...researchReference.raw,metadata:{...researchReference.raw.metadata,start_time:researchReference.raw.metadata.start_time-minute}}}}),{code:'PROFILE_TIMESTAMP_MISMATCH'});
  const badBars=derived.bars.map((bar,i)=>i===1?{...bar,atr14:'999'}:bar);
  const tampered=await researchStore.publish(derivedMetadata,badBars,{model});
  await assert.rejects(verifyEnrollmentBinding({...args,researchReference:tampered}),{code:'PROFILE_CONTENT_MISMATCH'});
  const manifest=path.join(root,rawReference.dataset_id,'manifest.json');
  await writeFile(manifest,'{}');
  await assert.rejects(rawProfileReadiness(row,rawStore),{code:'DATASET_HASH_MISMATCH'});
});
