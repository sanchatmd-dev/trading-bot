import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatasetStore} from '../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {barsFromKlines} from '../src/pine-bridge/market-data.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {deriveClosedMetadataV2,streamClosedProfileRowsV2,verifyEnrollmentBindingV2} from '../src/quant-research/data-profile-v2.js';

const minute=60000,start=Date.UTC(2024,0,1);
const model={version:'paper-close-v1',data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'};
const evidence={source_hash:hash('source'),effective_inputs_hash:hash('settings'),evaluator_hash:hash('evaluator'),
 execution_model_hash:hash('model'),metadata_hash:hash('metadata'),raw_provenance_sha256:hash('provenance'),seed_bars:500};
const metadata=(count,warmup=500)=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
 symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:start+count*minute,warmup_bars:warmup,
 total_bars:count,cutoff:start+count*minute,source:'binance-spot-klines-v1'});
const bar=i=>({time:start+i*minute,open:String(100+i%13),high:String(102+i%13),
 low:String(99+i%13),close:String(101+i%13),volume:'2'});
async function* bars(count){for(let i=0;i<count;i++)yield bar(i);}
const collect=async source=>{const result=[];for await(const value of source)result.push(value);return result;};
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'profile-v2-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,rawStore:new DatasetStore({root}),researchStore:new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:true})};
}
async function makePair(t,count){
 const setup=await fixture(t);
 const rawReference=await setup.rawStore.publish(metadata(count),bars(count),{chunkBars:1000});
 const derived=deriveClosedMetadataV2(rawReference);
 const researchReference=await setup.researchStore.publishStream(derived,
  streamClosedProfileRowsV2({rawReference,rawStore:setup.rawStore,model}),{model});
 return {...setup,rawReference,researchReference};
}

test('V2 conversion matches V1 causal ATR and timestamps on 1,000 raw bars',async t=>{
 const {rawStore,researchStore,rawReference,researchReference}=await makePair(t,1000);
 const candles=Array.from({length:1000},(_,i)=>{
  const row=bar(i);
  return [row.time,row.open,row.high,row.low,row.close,row.volume,row.time+minute-1];
 });
 const legacy=barsFromKlines(candles,{price_tick:model.price_tick,quantity_step:model.quantity_step},start+1000*minute);
 const rows=await collect(researchStore.readV2(researchReference));
 assert.equal(rows.length,legacy.bars.length);
 for(let i=0;i<rows.length;i++){
  const {price_tick,quantity_step,...expected}=legacy.bars[i];
  void price_tick;void quantity_step;
  assert.deepEqual(rows[i],expected,`legacy mismatch at ${i}`);
 }
 const binding=await verifyEnrollmentBindingV2({rawReference,researchReference,evidence,rawStore,researchStore});
 assert.equal(binding.version,'research-enrollment-binding-v2');
 assert.equal(binding.data_profile_verified,true);
 assert.equal(binding.evaluator_admission,false);
 assert.match(binding.binding_sha256,/^[a-f0-9]{64}$/);
});

test('V2 streams 50,501 raw rows into 50,001 derived rows without input array',async t=>{
 const {rawStore,researchStore,rawReference,researchReference}=await makePair(t,50501);
 assert.equal(researchReference.sidecar.bar_count,50001);
 const range=await collect(researchStore.readV2(researchReference,{start:999,end:1002}));
 assert.equal(range.length,3);
 assert.equal(range[0].time,start+(501+999)*minute);
 const binding=await verifyEnrollmentBindingV2({rawReference,researchReference,evidence,rawStore,researchStore});
 assert.equal(binding.bar_count,50001);
});

test('V2 rejects evidence, timestamp, content mismatch, and corrupt chunk',async t=>{
 const {root,rawStore,researchStore,rawReference,researchReference}=await makePair(t,520);
 const args={rawReference,researchReference,evidence,rawStore,researchStore};
 await assert.rejects(verifyEnrollmentBindingV2({...args,evidence:{...evidence,source_hash:'bad'}}),{code:'PROFILE_EVIDENCE_REQUIRED'});
 await assert.rejects(verifyEnrollmentBindingV2({...args,evidence:{...evidence,seed_bars:499}}),{code:'PROFILE_SEED_REQUIRED'});
 await assert.rejects(verifyEnrollmentBindingV2({...args,researchReference:{...researchReference,
  sidecar:{...researchReference.sidecar,first_time:researchReference.sidecar.first_time+minute}}}),{code:'PROFILE_TIMESTAMP_MISMATCH'});
 const derived=deriveClosedMetadataV2(rawReference);
 async function* badRows(){
  let index=0;
  for await(const row of streamClosedProfileRowsV2({rawReference,rawStore,model})){
   yield index++===1?{...row,atr14:'999'}:row;
  }
 }
 const bad=await researchStore.publishStream(derived,badRows(),{model});
 await assert.rejects(verifyEnrollmentBindingV2({...args,researchReference:bad}),{code:'PROFILE_CONTENT_MISMATCH'});
 const folder=path.join(root,'atr14-v2-'+researchReference.sidecar.sha256);
 const chunk=path.join(folder,'chunk-00000.jsonl');
 const original=await readFile(chunk);
 await writeFile(chunk,Buffer.from(original.toString().replace(/"atr14":"(\d)/,'"atr14":"9')));
 await assert.rejects(verifyEnrollmentBindingV2(args),{code:'RESEARCH_SIDECAR_HASH_MISMATCH'});
});

test('V2 conversion rejects gaps, short input, and cancel; closes reader',async t=>{
 const {rawStore,rawReference}=await makePair(t,520);
 const original=rawStore.read.bind(rawStore);
 let closed=false;
 rawStore.read=async function* (...args){
  try{yield* original(...args);}
  finally{closed=true;}
 };
 const partial=streamClosedProfileRowsV2({rawReference,rawStore,model});
 await partial.next();await partial.return();assert.equal(closed,true);
 rawStore.read=async function* (...args){let index=0;for await(const row of original(...args)){if(index++===10)yield {...row,time:row.time+minute};else yield row;}};
 await assert.rejects(collect(streamClosedProfileRowsV2({rawReference,rawStore,model})),{code:'PROFILE_CONTENT_MISMATCH'});
 rawStore.read=async function* (...args){let index=0;for await(const row of original(...args)){if(index++>=519)break;yield row;}};
 await assert.rejects(collect(streamClosedProfileRowsV2({rawReference,rawStore,model})),{code:'PROFILE_CONTENT_MISMATCH'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(collect(streamClosedProfileRowsV2({rawReference,rawStore,model,signal:controller.signal})),{code:'DATASET_CANCELLED'});
 await assert.rejects(collect(streamClosedProfileRowsV2({rawReference,rawStore,model:{...model,version:'paper-close-cost-v2'}})),{code:'PROFILE_MODEL_UNSUPPORTED'});
 await assert.rejects(collect(streamClosedProfileRowsV2({rawReference,rawStore,model:{...model,version:'unknown'}})),{code:'PROFILE_MODEL_UNSUPPORTED'});
});

test('V2 detaches inputs before delayed reader and freezes returned binding',async t=>{
 const {rawStore,researchStore,rawReference,researchReference}=await makePair(t,520);
 const rawInput=structuredClone(rawReference),researchInput=structuredClone(researchReference);
 const evidenceInput={...evidence},modelInput={...model};
 const original=rawStore.read.bind(rawStore);
 let entered;
 const started=new Promise(resolve=>{entered=resolve;});
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 rawStore.read=async function* (...args){entered();await gate;yield* original(...args);};
 const bindingPromise=verifyEnrollmentBindingV2({rawReference:rawInput,researchReference:researchInput,
  evidence:evidenceInput,rawStore,researchStore});
 await started;
 rawInput.sha256='0'.repeat(64);
 researchInput.raw.sha256='0'.repeat(64);
 researchInput.sidecar.sha256='0'.repeat(64);
 evidenceInput.source_hash='0'.repeat(64);
 release();
 const binding=await bindingPromise;
 assert.equal(binding.raw_dataset_sha256,rawReference.sha256);
 assert.equal(binding.closed_dataset_sha256,researchReference.raw.sha256);
 assert.equal(binding.atr14_sha256,researchReference.sidecar.sha256);
 assert.equal(binding.evidence.source_hash,evidence.source_hash);
 const {binding_sha256,...payload}=binding;
 assert.equal(binding_sha256,hash(canonical(payload)));
 assert.throws(()=>{binding.evidence.source_hash='1'.repeat(64);},TypeError);
 assert.throws(()=>{binding.bar_count=1;},TypeError);
 const conversionInput=structuredClone(rawReference);
 let enteredConvert;
 const convertStarted=new Promise(resolve=>{enteredConvert=resolve;});
 let releaseConvert;
 const convertGate=new Promise(resolve=>{releaseConvert=resolve;});
 rawStore.read=async function* (...args){enteredConvert();await convertGate;yield* original(...args);};
 const conversion=streamClosedProfileRowsV2({rawReference:conversionInput,rawStore,model:modelInput});
 const firstPromise=conversion.next();
 await convertStarted;
 conversionInput.sha256='0'.repeat(64);
 modelInput.price_tick='9';
 releaseConvert();
 const first=await firstPromise;
 assert.equal(first.value.price_tick,'0.01');
 await conversion.return();
});
