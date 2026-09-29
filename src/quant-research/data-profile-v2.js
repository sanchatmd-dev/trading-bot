import {setImmediate} from 'node:timers/promises';
import {canonical,hash,fail,keys} from '../pine-bridge/source.js';
import {D,amount,Money,exact} from '../money.js';
import {validateDatasetReference} from './foundation-contract.js';

const minute=60000, seedBars=500, maxRawBars=1000000, maxDerivedBars=999500;
const HEX=/^[a-f0-9]{64}$/;
const aborted=signal=>{if(signal?.aborted)throw fail('DATASET_CANCELLED');};
const detached=value=>JSON.parse(canonical(value));
const deepFreeze=value=>{
 if(value&&typeof value==='object'){
  for(const child of Object.values(value))deepFreeze(child);
  Object.freeze(value);
 }
 return value;
};

function rawProfile(reference){
 const raw=validateDatasetReference(reference).metadata;
 if(raw.venue!=='binance-global'||raw.market!=='SPOT'||raw.symbol!=='BTCUSDT'||
    raw.timeframe!=='1'||raw.source!=='binance-spot-klines-v1'||raw.total_bars<515||
    raw.total_bars>maxRawBars||raw.warmup_bars<seedBars||
    raw.total_bars-seedBars>maxDerivedBars)throw fail('PROFILE_RAW_UNSUPPORTED');
 return raw;
}

export function deriveClosedMetadataV2(rawReference){
 const raw=rawProfile(rawReference);
 return {...raw,start_time:raw.start_time+(seedBars+1)*minute,
  end_time:raw.end_time+minute,cutoff:raw.cutoff+minute,
  warmup_bars:raw.warmup_bars-seedBars,total_bars:raw.total_bars-seedBars};
}

function checkModel(model){
 if(model?.version!=='paper-close-v1'||model.data_profile!=='closed-ohlcv-atr14-v1')throw fail('PROFILE_MODEL_UNSUPPORTED');
 for(const field of ['price_tick','quantity_step']){
  try{exact(model[field]);if(!D(model[field]).gt(0))throw Error();}
  catch{throw fail('PROFILE_MODEL_UNSUPPORTED');}
 }
}

/** Worker-side conversion only. First 500 raw bars seed ATR; no rows buffered. */
export async function* streamClosedProfileRowsV2({rawReference,rawStore,model,signal}){
 aborted(signal);
 const rawRef=validateDatasetReference(rawReference);
 const raw=rawProfile(rawRef);
 checkModel(model);
 const frozenModel=detached(model);
 let previousClose=null,currentAtr=null,seed=D(0),count=0,emitted=0;
 for await(const bar of rawStore.read(rawRef,{signal})){
  aborted(signal);
  if(count>=raw.total_bars)throw fail('PROFILE_CONTENT_MISMATCH');
  if(bar.time!==raw.start_time+count*minute)throw fail('PROFILE_CONTENT_MISMATCH');
  const high=D(bar.high),low=D(bar.low),close=D(bar.close);
  const tr=previousClose===null?high.minus(low):Money.max(high.minus(low),
   high.minus(previousClose).abs(),low.minus(previousClose).abs());
  if(count<14){seed=seed.plus(tr);if(count===13)currentAtr=seed.div(14);}
  else currentAtr=currentAtr.mul(13).plus(tr).div(14);
  if(count>=seedBars){
   emitted++;
   yield {...bar,time:bar.time+minute,atr14:amount(currentAtr),
    price_tick:String(frozenModel.price_tick),quantity_step:String(frozenModel.quantity_step)};
  }
  previousClose=close;
  count++;
  if(count%1000===0){await setImmediate();aborted(signal);}
 }
 if(count!==raw.total_bars||emitted!==raw.total_bars-seedBars)throw fail('PROFILE_CONTENT_MISMATCH');
}

function checkEvidence(evidence){
 keys(evidence,['source_hash','effective_inputs_hash','evaluator_hash','execution_model_hash',
  'metadata_hash','raw_provenance_sha256','seed_bars']);
 for(const field of ['source_hash','effective_inputs_hash','evaluator_hash',
  'execution_model_hash','metadata_hash','raw_provenance_sha256'])
  if(typeof evidence[field]!=='string'||!HEX.test(evidence[field]))throw fail('PROFILE_EVIDENCE_REQUIRED');
 if(evidence.seed_bars!==seedBars)throw fail('PROFILE_SEED_REQUIRED');
}

/** Content binding only. Trusted evidence resolution and enrollment are caller duties. */
export async function verifyEnrollmentBindingV2({rawReference,researchReference,evidence,rawStore,researchStore,signal}){
 aborted(signal);
 checkEvidence(evidence);
 const frozenEvidence=detached(evidence);
 const rawRef=validateDatasetReference(rawReference);
 const raw=rawProfile(rawRef),expected=deriveClosedMetadataV2(rawRef);
 keys(researchReference,['raw','sidecar']);
 const researchRaw=validateDatasetReference(researchReference.raw);
 const derived=researchRaw.metadata;
 const sidecar=detached(researchReference.sidecar);
 const researchRef={raw:researchRaw,sidecar};
 if(canonical(derived)!==canonical(expected)||sidecar?.version!=='research-atr14-chunked-v2'||
    sidecar.first_time!==derived.start_time||sidecar.bar_count!==derived.total_bars||
    sidecar.profile!=='closed-ohlcv-atr14-v1'||
    typeof sidecar.price_tick!=='string'||typeof sidecar.quantity_step!=='string')
  throw fail('PROFILE_TIMESTAMP_MISMATCH');
 await rawStore.inspect(rawRef);
 await researchStore.raw.inspect(researchRaw);
 await researchStore.inspectSidecarV2(sidecar,{signal});
 const rawRows=rawStore.read(rawRef,{signal})[Symbol.asyncIterator]();
 const closedRows=researchStore.readV2(researchRef,{signal})[Symbol.asyncIterator]();
 let previousClose=null,currentAtr=null,seed=D(0),count=0,closedCount=0;
 try{
  while(true){
   aborted(signal);
   const next=await rawRows.next();
   if(next.done)break;
   if(count>=raw.total_bars)throw fail('PROFILE_CONTENT_MISMATCH');
   const bar=next.value,high=D(bar.high),low=D(bar.low),close=D(bar.close);
   if(bar.time!==raw.start_time+count*minute)throw fail('PROFILE_CONTENT_MISMATCH');
   const tr=previousClose===null?high.minus(low):Money.max(high.minus(low),
    high.minus(previousClose).abs(),low.minus(previousClose).abs());
   if(count<14){seed=seed.plus(tr);if(count===13)currentAtr=seed.div(14);}
   else currentAtr=currentAtr.mul(13).plus(tr).div(14);
   if(count>=seedBars){
    const current=await closedRows.next();
    if(current.done||current.value.time!==bar.time+minute||
       ['open','high','low','close','volume'].some(field=>String(current.value[field])!==String(bar[field]))||
       D(current.value.atr14).cmp(D(amount(currentAtr)))!==0)throw fail('PROFILE_CONTENT_MISMATCH');
    closedCount++;
   }
   previousClose=close;count++;
   if(count%1000===0){await setImmediate();aborted(signal);}
  }
  if(count!==raw.total_bars||closedCount!==derived.total_bars||!(await closedRows.next()).done)
   throw fail('PROFILE_CONTENT_MISMATCH');
 }finally{await Promise.allSettled([rawRows.return?.(),closedRows.return?.()]);}
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:rawRef.sha256,
  closed_dataset_sha256:researchRaw.sha256,atr14_sha256:sidecar.sha256,
  first_closed_time:derived.start_time,bar_count:derived.total_bars,evidence:frozenEvidence,
  data_profile_verified:true,evaluator_admission:false};
 return deepFreeze({...binding,binding_sha256:hash(canonical(binding))});
}
