import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,writeFile,readFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatasetStore} from '../src/quant-research/dataset-store.js';

const metadata=(count=7)=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:60000,end_time:(count+1)*60000,warmup_bars:1,total_bars:count,cutoff:(count+1)*60000,source:'binance-spot-klines-v1'});
const bar=index=>({time:(index+1)*60000,open:'100.000000000000000001',high:'102',low:'99',close:'101',volume:'0.123456789123456789'});
async function* bars(count=7){for(let i=0;i<count;i++)yield bar(i);}
async function collect(stream){const output=[];for await(const row of stream)output.push(row);return output;}
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'quant-store-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,store:new DatasetStore({root})};}
const code=expected=>error=>error.code===expected;

test('dataset stores bounded chunks, preserves decimal strings and explicit half-open ranges',async t=>{
  const {store}=await fixture(t),reference=await store.publish(metadata(),bars(),{chunkBars:3});
  assert.deepEqual(Object.keys(reference).sort(),['dataset_id','metadata','sha256']);
  const manifest=await store.inspect(reference);
  assert.deepEqual(manifest.chunks.map(chunk=>chunk.count),[3,3,1]);
  assert.deepEqual(await collect(store.read(reference,{start:2,end:5})),[bar(2),bar(3),bar(4)]);
  assert.deepEqual(await collect(store.read(reference,{start:7,end:7})),[]);
  for(const range of [{start:-1},{end:8},{start:4,end:3},{start:1.5}])await assert.rejects(collect(store.read(reference,range)),code('INVALID_DATASET_RANGE'));
});

test('publication rejects gaps, duplicates, boundaries, count and malformed raw bars; cleans temporary files',async t=>{
  const {root,store}=await fixture(t);
  const good=await collect(bars());
  const inputs=[good.map((row,i)=>i===3?bar(4):row),good.map((row,i)=>i===3?bar(2):row),good.slice(1),[...good,bar(7)],good.map((row,i)=>i===2?{...row,high:'1'}:row),good.map((row,i)=>i===2?{...row,atr14:'1'}:row),good.map((row,i)=>i===2?{...row,volume:'NaN'}:row)];
  for(const input of inputs)await assert.rejects(store.publish(metadata(),input,{chunkBars:2}));
  assert.deepEqual(await readdir(root),[]);
  await assert.rejects(store.publish({...metadata(),cutoff:metadata().end_time-1},bars()));
  await assert.rejects(store.publish(metadata(),bars(),{chunkBars:50001}),code('INVALID_DATASET_CHUNK_SIZE'));
});

test('cancellation removes unpublished chunks and cancels range reading',async t=>{
  const {root,store}=await fixture(t),controller=new AbortController();
  async function* interrupted(){yield bar(0);yield bar(1);controller.abort();yield bar(2);}
  await assert.rejects(store.publish(metadata(),interrupted(),{chunkBars:1,signal:controller.signal}),code('DATASET_CANCELLED'));
  assert.deepEqual(await readdir(root),[]);
  const reference=await store.publish(metadata(),bars());
  await assert.rejects(collect(store.read(reference,{signal:controller.signal})),code('DATASET_CANCELLED'));
  const during=new AbortController(),stream=store.read(reference,{signal:during.signal});
  await stream.next();during.abort();await assert.rejects(stream.next(),code('DATASET_CANCELLED'));
});

test('concurrent identical publishers share immutable winner and leave no staging artifacts',async t=>{
  const {root,store}=await fixture(t);
  const references=await Promise.all(Array.from({length:4},()=>store.publish(metadata(),bars(),{chunkBars:2})));
  for(const reference of references)assert.deepEqual(reference,references[0]);
  assert.deepEqual(await readdir(root),[references[0].dataset_id]);
  assert.deepEqual(await collect(store.read(references[0])),await collect(bars()));
});

test('hash validation rejects chunk or manifest tampering and cannot overwrite evidence',async t=>{
  const {root,store}=await fixture(t),reference=await store.publish(metadata(),bars(),{chunkBars:2});
  const chunk=path.join(root,reference.dataset_id,'chunk-00000.jsonl');
  const content=await readFile(chunk,'utf8');await writeFile(chunk,content.replace('102','103'));
  await assert.rejects(collect(store.read(reference)),code('DATASET_HASH_MISMATCH'));
  await assert.rejects(store.publish(metadata(),bars(),{chunkBars:2}),code('DATASET_HASH_MISMATCH'));
  assert.equal(await readFile(chunk,'utf8'),content.replace('102','103'));
  await writeFile(path.join(root,reference.dataset_id,'manifest.json'),'{}');
  await assert.rejects(store.inspect(reference),code('DATASET_HASH_MISMATCH'));
  await assert.rejects(store.inspect({...reference,dataset_id:'../escape',sha256:'../escape'}));
});

test('dataset rejects linked dataset directories',async t=>{
  const {root,store}=await fixture(t),reference=await store.publish(metadata(),bars());
  const folder=path.join(root,reference.dataset_id),other=path.join(root,'other');
  const {rename}=await import('node:fs/promises');await rename(folder,other);
  await symlink(other,folder,process.platform==='win32'?'junction':'dir');
  await assert.rejects(store.inspect(reference),code('UNSAFE_DATASET_PATH'));
});
