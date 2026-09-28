import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatasetStore} from '../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {validateFoundationRequest} from '../src/quant-research/foundation-contract.js';
import {validateProfileResult} from '../src/quant-research/profile-contract.js';
import {buildProfile} from '../src/postgres/quant-profile.js';
import {ingestionEngineHash} from '../src/postgres/quant-data.js';

const minute=60000,hex='a'.repeat(64);
const model={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,
  fee_bps:10,slippage_bps:5,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const bar=i=>({time:(i+1)*minute,open:'100',high:'102',low:'99',close:'101',volume:'1'});
const metadata=count=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
  symbol:'BTCUSDT',timeframe:'1',start_time:minute,end_time:(count+1)*minute,
  warmup_bars:500,total_bars:count,cutoff:(count+1)*minute,source:'binance-spot-klines-v1'});
const code=expected=>error=>error.code===expected;

async function fixture(t,count=520){
  const root=await mkdtemp(path.join(os.tmpdir(),'quant-profile-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const rawStore=new DatasetStore({root}),researchStore=new ResearchDatasetStore({root});
  const dataset=await rawStore.publish(metadata(count),Array.from({length:count},(_,i)=>bar(i)));
  const contract=validateFoundationRequest({version:'quant-foundation-v1',owner_id:'owner',
    bot_id:'bot',kind:'PROFILE',dataset,engine_hash:hex,snapshot_hash:hex,
    profile:{raw_job_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      deployment_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',source_hash:hex,
      effective_inputs_hash:hex,execution_model:model,metadata_hash:hex,
      raw_provenance_sha256:hex,seed_bars:500,snapshot_hash:hex},
    budget:{candidates:1,max_evaluations:1,chunk_bars:count,max_runtime_ms:900000,
      max_output_bytes:1024*1024,max_state_bytes:1024*1024}});
  return {rawStore,researchStore,contract};
}

test('PROFILE freezes bounded server evidence and rejects unseeded raw history',async t=>{
  const {contract}=await fixture(t);
  assert.equal(contract.profile.seed_bars,500);
  assert.throws(()=>validateFoundationRequest({...contract,profile:{...contract.profile,seed_bars:499}}),
    code('PROFILE_SPEC_INVALID'));
  assert.throws(()=>validateFoundationRequest({...contract,profile:{...contract.profile,
    raw_provenance_sha256:'client'}}),code('PROFILE_SPEC_INVALID'));
  assert.throws(()=>validateFoundationRequest({...contract,dataset:{...contract.dataset,
    metadata:{...contract.dataset.metadata,warmup_bars:499}}}),code('PROFILE_RAW_UNSUPPORTED'));
});

test('PROFILE converts 500 seed bars into causal closed-bar ATR14 and verifies content',async t=>{
  const {rawStore,researchStore,contract}=await fixture(t);
  const result=await buildProfile({rawStore,researchStore,contract,
    now:contract.dataset.metadata.end_time});
  validateProfileResult(contract,result);
  assert.equal(result.data_profile_verified,true);
  assert.equal(result.evaluator_admission,false);
  assert.equal(result.references.raw.metadata.total_bars,20);
  assert.equal(result.references.raw.metadata.warmup_bars,0);
  assert.equal(result.references.raw.metadata.start_time,502*minute);
  const derived=[];for await(const row of researchStore.read(result.references))derived.push(row);
  assert.equal(derived.length,20);
  assert.equal(derived[0].time,bar(500).time+minute);
  assert.equal(derived[0].atr14,'3');
  assert.equal(result.binding.evidence.raw_provenance_sha256,hex);
  assert.throws(()=>validateProfileResult(contract,{...result,evaluator_admission:true}),
    code('PROFILE_RESULT_INVALID'));
});

test('PROFILE rejects open final bar and cancelled conversion before publish',async t=>{
  const {rawStore,researchStore,contract}=await fixture(t);
  await assert.rejects(buildProfile({rawStore,researchStore,contract,
    now:contract.dataset.metadata.end_time-1}),code('PROFILE_OPEN_BAR'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(buildProfile({rawStore,researchStore,contract,
    signal:controller.signal,now:contract.dataset.metadata.end_time+minute}),code('DATASET_CANCELLED'));
});

test('PROFILE engine identity includes monetary math and research artifact serialization',async()=>{
  const baseline=await ingestionEngineHash(async url=>url.pathname);
  for(const dependency of ['/src/money.js','/src/quant-research/research-dataset-store.js']){
    let observed=false;
    const changed=await ingestionEngineHash(async url=>{
      if(url.pathname.endsWith(dependency)){observed=true;return url.pathname+' changed';}
      return url.pathname;
    });
    assert.equal(observed,true,dependency);
    assert.notEqual(changed,baseline,dependency);
  }
});
