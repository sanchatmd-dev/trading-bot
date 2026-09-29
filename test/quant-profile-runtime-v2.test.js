import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {prepareProfileIo,runProfilePayload} from '../src/quant-research/io-profile-worker.js';

test('fixed PROFILE child primes exact scratch bytes before any payload work',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'profile-io-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const filename=path.join(root,'.pending-'+randomUUID());
  const environment={QUANT_IO_READY_FILE:filename,QUANT_IO_READY_DEVICE:'8:0',
    QUANT_IO_READY_RBPS:'1024',QUANT_IO_READY_WBPS:'1024'};
  const reader=async name=>name==='/proc/self/cgroup'?'0::/unit.service\n':
    name.endsWith('/io.max')?'8:0 rbps=1024 wbps=1024\n':
    name.endsWith('/io.stat')?'8:0 rbytes=0 wbytes=4096\n':assert.fail(name);
  await prepareProfileIo({environment,reader,linkstat:stat,statter:async()=>({ino:17}),
    resolver:async()=>'/approved/device'});
  const bytes=await readFile(filename);
  assert.equal(bytes.length,4096);
  assert.equal(bytes.every(value=>value===0x51),true);
});

test('fixed child computes actual V2 PROFILE then returns bounded hashed provisional frame',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'profile-runtime-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:true});
  const {policy,contract}=profileV2Fixture(600);
  policy.environment='staging';contract.capacity.environment='staging';
  contract.capacity.policy_hash=capacityPolicyHash(policy);
  async function* rows(){for(let i=0;i<600;i++)yield {time:contract.dataset.metadata.start_time+i*60000,
    open:'100',high:'102',low:'99',close:'101',volume:'2'};}
  contract.dataset=await store.raw.publish(contract.dataset.metadata,rows(),{chunkBars:1000});
  const payload=canonical({version:'profile-v2-provisional',jobId:randomUUID(),
    operationId:'operation-00001',contract,policy,storage:{root,diskQuotaBytes:32*1024*1024,
      tempQuotaBytes:16*1024*1024,freeFloorBytes:0}});
  const output=[];
  const frame=await runProfilePayload(payload,{storeFactory:()=>({rawStore:store.raw,researchStore:store}),
    now:()=>contract.dataset.metadata.cutoff,write:async chunk=>{output.push(chunk);}});
  assert.equal(output.length,2);
  assert.equal(output[0],`QUANT_PROFILE_ACCEPTED_V2 ${hash(payload)}\n`);
  assert.equal(JSON.parse(output[1]).resultHash,frame.resultHash);
  assert.equal(frame.result.binding.bar_count,100);
  assert.equal(frame.result.evaluator_admission,false);
  assert.equal(frame.resultHash,hash(canonical(frame.result)));
});

test('fixed child rejects non-staging and malformed payload before receipt',async()=>{
  const output=[];
  await assert.rejects(runProfilePayload('{}',{write:async item=>{output.push(item);}}),
    {code:'QUANT_PROFILE_PAYLOAD_INVALID'});
  assert.deepEqual(output,[]);
});
