import {canonical,hash,fail,keys} from '../pine-bridge/source.js';
import {D,amount,Money} from '../money.js';

/** Server-owned diagnosis of a completed raw history job. This does not enroll data. */
export async function rawProfileReadiness(row,store) {
  if(row.contract?.kind!=='BACKFILL'||row.status!=='SUCCEEDED'||!row.result)throw fail('BACKFILL_RESULT_UNAVAILABLE');
  const {dataset,provenance}=row.result;
  if(row.result.raw_only!==true||row.result.verified_execution_profile!==false||
     dataset.metadata.source!=='binance-spot-klines-v1'||
     provenance.range.timestamp_semantics!=='UTC open time; end exclusive')throw fail('BACKFILL_RESULT_INVALID');
  await store.inspect(dataset);
  return {
    version:'raw-profile-readiness-v1',job_id:row.job_id,dataset_id:dataset.dataset_id,
    dataset_sha256:dataset.sha256,provenance_sha256:hash(canonical(provenance)),
    raw_timestamp_semantics:'UTC open time; end exclusive',
    required_research_timestamp_semantics:'UTC closed time; end exclusive',
    metadata_verified:true,content_verified:false,verified_execution_profile:false,enrollment_ready:false,
    blockers:['CAUSAL_ATR14_NOT_VERIFIED','CLOSED_TIMESTAMP_MAPPING_NOT_VERIFIED',
      'SOURCE_SETTINGS_EVALUATOR_EVIDENCE_MISSING'],
  };
}

/** Worker-side enrollment proof. Caller must resolve evidence from trusted server state. */
export async function verifyEnrollmentBinding({rawReference,researchReference,evidence,rawStore,researchStore,signal}) {
  keys(evidence,['source_hash','effective_inputs_hash','evaluator_hash','execution_model_hash','metadata_hash','raw_provenance_sha256','seed_bars']);
  for(const field of ['source_hash','effective_inputs_hash','evaluator_hash','execution_model_hash','metadata_hash','raw_provenance_sha256'])
    if(!/^[a-f0-9]{64}$/.test(evidence[field]))throw fail('PROFILE_EVIDENCE_REQUIRED');
  if(evidence.seed_bars!==500)throw fail('PROFILE_SEED_REQUIRED');
  const raw=rawReference.metadata,derived=researchReference.raw.metadata,sidecar=researchReference.sidecar;
  if(raw.total_bars<515||raw.warmup_bars<500||derived.total_bars!==raw.total_bars-500||
     derived.start_time!==raw.start_time+501*60000||derived.end_time!==raw.end_time+60000||
     derived.warmup_bars!==raw.warmup_bars-500||derived.cutoff<derived.end_time||
     sidecar.first_time!==derived.start_time||sidecar.bar_count!==derived.total_bars||
     sidecar.profile!=='closed-ohlcv-atr14-v1')throw fail('PROFILE_TIMESTAMP_MISMATCH');
  const atr=(await researchStore.sidecar(sidecar,{signal})).atr14;
  const research=researchStore.raw.read(researchReference.raw,{signal})[Symbol.asyncIterator]();
  let priorClose=null,currentAtr=null,seed=D(0),count=0;
  // DatasetStore.read checks manifest, chunk hashes and every expected minute.
  for await(const bar of rawStore.read(rawReference,{signal})){
    const high=D(bar.high),low=D(bar.low),close=D(bar.close);
    const tr=priorClose===null?high.minus(low):Money.max(high.minus(low),high.minus(priorClose).abs(),low.minus(priorClose).abs());
    if(count<14){seed=seed.plus(tr);if(count===13)currentAtr=seed.div(14);}
    else currentAtr=currentAtr.mul(13).plus(tr).div(14);
    if(count>=500){
      const next=await research.next();
      if(next.done||next.value.time!==bar.time+60000||
        ['open','high','low','close','volume'].some(field=>String(next.value[field])!==String(bar[field]))||
        D(atr[count-500]).cmp(D(amount(currentAtr)))!==0)throw fail('PROFILE_CONTENT_MISMATCH');
    }
    priorClose=close;count++;
  }
  if(!(await research.next()).done||count!==raw.total_bars)throw fail('PROFILE_CONTENT_MISMATCH');
  const binding={version:'research-enrollment-binding-v1',raw_dataset_sha256:rawReference.sha256,
    closed_dataset_sha256:researchReference.raw.sha256,atr14_sha256:sidecar.sha256,
    first_closed_time:derived.start_time,bar_count:derived.total_bars,evidence,
    data_profile_verified:true,evaluator_admission:false};
  return {...binding,binding_sha256:hash(canonical(binding))};
}
