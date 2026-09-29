import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {validateFoundationRequestV2,foundationRequestHashV2} from '../src/quant-research/foundation-contract-v2.js';
import {validateProfileSpecV2,validateProfileResultV2} from '../src/quant-research/profile-contract-v2.js';
import {deriveClosedMetadataV2} from '../src/quant-research/data-profile-v2.js';

const clone=value=>structuredClone(value),sha=letter=>letter.repeat(64);
const start=Date.UTC(2024,0,1),minute=60000;
const policy=()=>({version:'quant-capacity-v2',environment:'local',
 scope:{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
  execution_model:'paper-close-v1',source_hash:sha('a'),settings_hash:sha('b'),evaluator_hash:sha('c')},
 evidence:{calibration_sha256:sha('d'),parity_sha256:sha('e')},max_raw_bars:50000,max_chunk_bars:1000,
 budget:{candidates:100,max_evaluations:125,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
 io:{read_bytes:1000000,write_bytes:1000000,overshoot_read_bytes:1000,overshoot_write_bytes:1000,
  cleanup_read_bytes:2000,cleanup_write_bytes:2000}});
const request=(approved=policy(),count=50000)=>{
 const model={version:'paper-close-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',
  slippage_bps:'5',risk_percent:'1',data_profile:'closed-ohlcv-atr14-v1'};
 const dataset={dataset_id:sha('1'),sha256:sha('1'),metadata:{version:'spot-dataset-v1',venue:'binance-global',
  market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:start+count*minute,
  warmup_bars:1500,total_bars:count,cutoff:start+count*minute,source:'binance-spot-klines-v1'}};
 const capacity={version:'quant-capacity-v2',environment:approved.environment,policy_hash:capacityPolicyHash(approved),
  stage:'HISTORICAL_PREFLIGHT',scope:clone(approved.scope),dataset:{raw_bars:count,seed_bars:500,
   warmup_bars:1500,evaluation_bars:count-1500,processed_bars:count-500},chunk_bars:1000,
  budget:clone(approved.budget),io:clone(approved.io)};
 const profile={raw_job_id:'11111111-1111-4111-8111-111111111111',deployment_id:'deployment-123',
  source_hash:sha('a'),effective_inputs_hash:sha('b'),execution_model:model,metadata_hash:sha('2'),
  raw_provenance_sha256:sha('3'),seed_bars:500,snapshot_hash:sha('4')};
 return {version:'quant-foundation-v2',owner_id:'owner',bot_id:'bot',kind:'PROFILE',dataset,
  engine_hash:sha('f'),snapshot_hash:sha('4'),budget:{...clone(capacity.budget),chunk_bars:1000},profile,capacity};
};
const result=contract=>{
 const metadata=deriveClosedMetadataV2(contract.dataset);
 const research={raw:{dataset_id:sha('5'),sha256:sha('5'),metadata},
  sidecar:{version:'research-atr14-chunked-v2',sha256:sha('6'),bar_count:metadata.total_bars,
   first_time:metadata.start_time,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'}};
 const evidence={source_hash:contract.profile.source_hash,effective_inputs_hash:contract.profile.effective_inputs_hash,
  evaluator_hash:contract.capacity.scope.evaluator_hash,execution_model_hash:hash(canonical(contract.profile.execution_model)),
  metadata_hash:contract.profile.metadata_hash,raw_provenance_sha256:contract.profile.raw_provenance_sha256,seed_bars:500};
 const binding={version:'research-enrollment-binding-v2',raw_dataset_sha256:contract.dataset.sha256,
  closed_dataset_sha256:research.raw.sha256,atr14_sha256:research.sidecar.sha256,
  first_closed_time:metadata.start_time,bar_count:metadata.total_bars,evidence,
  data_profile_verified:true,evaluator_admission:false};
 return {version:'research-profile-enrollment-v2',raw:clone(contract.dataset),references:research,
  binding:{...binding,binding_sha256:hash(canonical(binding))},data_profile_verified:true,
  evaluator_admission:false,acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED']};
};

test('V2 PROFILE accepts 50K only with explicit policy; outputs detached and frozen',()=>{
 const p=policy(),r=request(p),checked=validateFoundationRequestV2(r,{policy:p});
 assert.equal(checked.capacity.dataset.raw_bars,50000);
 assert.match(foundationRequestHashV2(r,{policy:p}),/^[a-f0-9]{64}$/);
 assert.equal(Object.isFrozen(checked.profile.execution_model),true);
 const completed=validateProfileResultV2(r,result(r),{policy:p});
 assert.equal(completed.evaluator_admission,false);
 assert.equal(Object.isFrozen(completed.binding.evidence),true);
 r.profile.source_hash=sha('9');
 assert.equal(checked.profile.source_hash,sha('a'));
 assert.throws(()=>validateFoundationRequestV2(request(p)),{code:'INVALID_CAPACITY_CONTRACT'});
});

test('V2 foundation rejects other kinds, unsupported models, scope, counts and budget drift',()=>{
 const p=policy(),r=request(p);
 for(const changed of [
  {...r,kind:'BACKFILL'},
  {...r,profile:{...r.profile,execution_model:{...r.profile.execution_model,version:'paper-close-cost-v2'}}},
  {...r,profile:{...r.profile,source_hash:sha('9')}},
  {...r,profile:{...r.profile,effective_inputs_hash:sha('9')}},
  {...r,engine_hash:p.scope.evaluator_hash},
  {...r,dataset:{...r.dataset,metadata:{...r.dataset.metadata,total_bars:49999}}},
  {...r,budget:{...r.budget,chunk_bars:999}},
  {...r,budget:{...r.budget,max_runtime_ms:1}},
  {...r,capacity:{...r.capacity,dataset:{...r.capacity.dataset,seed_bars:501}}},
 ])assert.throws(()=>validateFoundationRequestV2(changed,{policy:p}));
 const cap=clone(p);cap.max_raw_bars=49999;
 assert.throws(()=>validateFoundationRequestV2(r,{policy:cap}));
 assert.throws(()=>validateFoundationRequestV2(request(p,50001),{policy:p}));
});

test('V2 result binds evaluator separately from conversion and preserves blockers',()=>{
 const p=policy(),r=request(p),good=result(r);
 assert.equal(validateProfileResultV2(r,good,{policy:p}).binding.evidence.evaluator_hash,p.scope.evaluator_hash);
 const bad=clone(good);bad.binding.evidence.evaluator_hash=r.engine_hash;
 const {binding_sha256,...payload}=bad.binding;void binding_sha256;bad.binding.binding_sha256=hash(canonical(payload));
 assert.throws(()=>validateProfileResultV2(r,bad,{policy:p}),{code:'PROFILE_RESULT_INVALID'});
 for(const change of [
  value=>{value.references.sidecar.version='research-atr14-v1';},
  value=>{value.references.sidecar.bar_count--;},
  value=>{value.references.raw.metadata.start_time+=minute;},
  value=>{value.evaluator_admission=true;},
  value=>{value.acceptance_blockers=['EVALUATOR_PARITY_REQUIRED'];},
 ]){const value=clone(good);change(value);assert.throws(()=>validateProfileResultV2(r,value,{policy:p}));}
});

test('V2 rejects extra, accessor, symbol and non-JSON fields before reads',()=>{
 const p=policy(),r=request(p);
 const extra=clone(r);extra.extra=true;assert.throws(()=>validateFoundationRequestV2(extra,{policy:p}));
 const accessor=clone(r);Object.defineProperty(accessor.profile,'source_hash',{enumerable:true,get(){throw Error('getter ran');}});
 assert.throws(()=>validateFoundationRequestV2(accessor,{policy:p}),{code:'INVALID_FOUNDATION_V2'});
 const symbol=clone(r);symbol.profile[Symbol('hidden')]=1;
 assert.throws(()=>validateFoundationRequestV2(symbol,{policy:p}),{code:'INVALID_FOUNDATION_V2'});
 const nan=clone(r);nan.budget.candidates=NaN;
 assert.throws(()=>validateFoundationRequestV2(nan,{policy:p}),{code:'INVALID_FOUNDATION_V2'});
 const valid=result(r),resultAccessor=clone(valid);
 Object.defineProperty(resultAccessor.binding.evidence,'evaluator_hash',{enumerable:true,get(){throw Error('getter ran');}});
 assert.throws(()=>validateProfileResultV2(r,resultAccessor,{policy:p}),{code:'INVALID_FOUNDATION_V2'});
 assert.equal(validateProfileSpecV2(r.profile,r.dataset).seed_bars,500);
});
