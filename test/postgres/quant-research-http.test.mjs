import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {quantResearchHttpFixture} from '../helpers/quant-research-http-fixture.mjs';

// Real HTTP against the unchanged PostgreSQL server in FOUNDATION mode (QS heavy-path S1 containment).
// Ranges live in the recent past on the minute grid; each block has one purpose.
const M=60000,top=Math.floor(Date.now()/M)*M-30000*M;
const blocks={main:top,gap:top+5000*M,off:top+9000*M,short:top+13000*M,edge:top+17000*M,ownerFull:top+21000*M,globalFull:top+25000*M};
let f;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  f=await quantResearchHttpFixture(process.env.TEST_DATABASE_URL);
  await f.seedBars({start:blocks.main,count:3250});
  await f.seedBars({start:blocks.gap,count:3250,skip:[1600]});
  await f.seedBars({start:blocks.off,count:3250,offGrid:[1600]});
  await f.seedBars({start:blocks.short,count:3000});
  await f.seedBars({start:blocks.edge,count:3250,offGrid:[0]});
  // Never published by another test, so an early publish would add files to the dataset root.
  await f.seedBars({start:blocks.ownerFull,count:3250});
  await f.seedBars({start:blocks.globalFull,count:3250});
});
after(async()=>{await f?.close();});
const state=async()=>(await f.db.query('SELECT (SELECT count(*)::int FROM quant_jobs) jobs,(SELECT count(*)::int FROM quant_foundation_jobs) foundation,(SELECT count(*)::int FROM quant_research_foundation) bindings')).rows[0];
async function assertNoWrite(label,before,answer,status,code) {
  assert.deepEqual(await f.listing(),before.files,label+': dataset root must stay unchanged');
  assert.deepEqual(await state(),before.state,label+': no job or binding row');
  assert.equal(answer.status,status,label+' '+JSON.stringify(answer.body));assert.equal(answer.body.code,code,label);
}

test('idle owner is queued with range/digest and no files; the per-owner research limit rejects before any write',async()=>{
  const owner=await f.newOwner(),session=await owner.login(),body=f.researchBody(owner,{start:blocks.main});
  const empty=await f.listing();
  const first=await f.enqueue(owner,session,body);
  assert.equal(first.status,202,JSON.stringify(first.body));assert.equal(first.body.status,'QUEUED');
  const row=(await f.db.query('SELECT status,contract FROM quant_jobs WHERE run_id=$1',[first.body.run_id])).rows[0];
  assert.equal(row.status,'QUEUED');assert.equal(row.contract.execution_backend,'quant-foundation-v1');
  assert.equal(Object.hasOwn(row.contract.dataset,'bars'),false);
  assert.equal(row.contract.version,'ql3a-research-job-v2');
  assert.equal(Object.hasOwn(row.contract.dataset,'references'),false);
  assert.equal(first.body.dataset_hash,null);assert.equal(first.body.dataset_prepared,false);
  assert.match(first.body.dataset_content_digest,/^[a-f0-9]{64}$/);
  assert.equal(row.contract.dataset.first_time,blocks.main);
  const binding=(await f.db.query('SELECT job_id FROM quant_research_foundation WHERE run_id=$1',[first.body.run_id])).rows[0];
  assert.equal((await f.db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[binding.job_id])).rows[0].status,'QUEUED');
  assert.deepEqual(await f.listing(),empty,'enqueue never publishes a dataset');
  const second=await f.enqueue(owner,session,body);
  assert.equal(second.status,202,JSON.stringify(second.body));assert.notEqual(second.body.run_id,first.body.run_id);
  const before={files:await f.listing(),state:await state()};
  await assertNoWrite('third job of one owner',before,await f.enqueue(owner,session,body),429,'QUANT_QUEUE_FULL');
});

test('gapped, short, insufficient and off-grid ranges are rejected with no files or rows',async()=>{
  const owner=await f.newOwner(),session=await owner.login();
  const cases=[
    ['hole inside the range',{start:blocks.gap},400,'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'],
    ['range ends after the stored bars',{start:blocks.short},400,'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'],
    ['fewer than 2000 evaluation bars',{start:blocks.main,count:3000},400,'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'],
    ['off-grid bar inside a full-count range',{start:blocks.off},400,'VERIFIED_MARKET_DATA_REQUIRED'],
    ['off-grid first bar',{start:blocks.edge},400,'VERIFIED_MARKET_DATA_REQUIRED']];
  for(const [label,range,status,code] of cases){
    const before={files:await f.listing(),state:await state()};
    await assertNoWrite(label,before,await f.enqueue(owner,session,f.researchBody(owner,range)),status,code);
  }
});

test('owner foundation queue full returns 429 before the dataset is published',async()=>{
  const owner=await f.newOwner(),session=await owner.login();
  await f.seedFoundationJobs(owner.id,20);
  try{
    const before={files:await f.listing(),state:await state()};
    await assertNoWrite('owner at 20 scheduler jobs',before,await f.enqueue(owner,session,f.researchBody(owner,{start:blocks.ownerFull})),429,'FOUNDATION_QUEUE_FULL');
  }finally{await f.db.query('DELETE FROM quant_foundation_jobs WHERE owner_id=$1',[owner.id]);}
});

test('global foundation queue full returns 429 before the dataset is published',async()=>{
  const owner=await f.newOwner(),session=await owner.login();
  for(let i=0;i<5;i++)await f.seedFoundationJobs('queue-fill-'+i,20);
  try{
    const before={files:await f.listing(),state:await state()};
    assert.ok(before.state.foundation>=100);
    await assertNoWrite('scheduler at 100 jobs',before,await f.enqueue(owner,session,f.researchBody(owner,{start:blocks.globalFull})),429,'FOUNDATION_QUEUE_FULL');
  }finally{await f.db.query("DELETE FROM quant_foundation_jobs WHERE owner_id LIKE 'queue-fill-%'");}
});
