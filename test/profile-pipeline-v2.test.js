import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {buildProfileV2} from '../src/quant-research/profile-pipeline-v2.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';

test('50K raw PROFILE pipeline preserves separate evaluator identity and denies enrollment',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'profile-pipeline-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:true});
  const {policy,contract}=profileV2Fixture();
  async function* rows(){for(let i=0;i<50000;i++)yield {time:contract.dataset.metadata.start_time+i*60000,open:'100',high:'102',low:'99',close:'101',volume:'2'};}
  contract.dataset=await store.raw.publish(contract.dataset.metadata,rows(),{chunkBars:1000});
  const result=await buildProfileV2({contract,policy,rawStore:store.raw,researchStore:store,now:contract.dataset.metadata.cutoff});
  assert.equal(result.binding.bar_count,49500);
  assert.equal(result.evaluator_admission,false);
  assert.equal(result.binding.evidence.evaluator_hash,policy.scope.evaluator_hash);
  assert.notEqual(result.binding.evidence.evaluator_hash,contract.engine_hash);
  assert.equal(Object.isFrozen(result.binding.evidence),true);
  assert.equal(result.references.sidecar.version,'research-atr14-chunked-v2');
});

test('PROFILE pipeline rejects missing policy, open bars and cancellation before publication',async()=>{
  const {policy,contract}=profileV2Fixture(515);
  const researchStore={publishStream:()=>{throw Error('must not publish');}};
  await assert.rejects(buildProfileV2({contract,researchStore}),{code:'INVALID_CAPACITY_CONTRACT'});
  await assert.rejects(buildProfileV2({contract,policy,researchStore,now:0}),{code:'PROFILE_OPEN_BAR'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(buildProfileV2({contract,policy,researchStore,signal:controller.signal}),{code:'DATASET_CANCELLED'});
});
