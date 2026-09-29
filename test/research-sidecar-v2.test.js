import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,symlink,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../src/quant-research/storage-budget.js';
import {canonical,hash} from '../src/pine-bridge/source.js';

const model={data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'};
const metadata=count=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',
 timeframe:'1',start_time:60000,end_time:(count+1)*60000,warmup_bars:1,total_bars:count,
 cutoff:(count+1)*60000,source:'binance-spot-klines-v1'});
const rows=async function*(count,signal){
 for(let i=0;i<count;i++){
  if(i===signal?.failAt)throw Error('fixture-failure');
  if(i===signal?.abortAt)signal.controller.abort();
  yield {time:(i+1)*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:String(i+2),
   price_tick:'0.01',quantity_step:'0.001'};
 }
};
const collect=async iterable=>{const values=[];for await(const value of iterable)values.push(value);return values;};
const fixture=async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'atr-v2-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,store:new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:true})};
};

test('V2 streams 50,001 rows, verifies bounded chunks, and reads crossing range',async t=>{
 const {root,store}=await fixture(t);
 const refs=await store.publishStream(metadata(50001),rows(50001),{model});
 const manifest=await store.inspectSidecarV2(refs.sidecar);
 assert.equal(refs.sidecar.version,'research-atr14-chunked-v2');
 assert.equal(manifest.chunks.length,51);
 assert.ok(manifest.chunks.every(chunk=>chunk.count<=1000&&chunk.bytes<=chunk.count*256));
 const read=await collect(store.readV2(refs,{start:999,end:1002}));
 assert.deepEqual(read.map(row=>row.atr14),['1001','1002','1003']);
 assert.deepEqual(read.map(row=>row.time),[60000000,60060000,60120000]);
 assert.equal((await readdir(root)).some(name=>name.startsWith('.pending-')),false);
});

test('V2 cancel and producer error clean pending; no final reference',async t=>{
 const {root,store}=await fixture(t);
 const controller=new AbortController();
 await assert.rejects(store.publishStream(metadata(1500),rows(1500,{abortAt:1001,controller}),{model,signal:controller.signal}),{code:'DATASET_CANCELLED'});
 await assert.rejects(store.publishStream(metadata(1500),rows(1500,{failAt:1001}),{model}),/fixture-failure/);
 const names=await readdir(root);
 assert.equal(names.some(name=>name.startsWith('.pending-')),false);
 assert.equal(names.some(name=>name.startsWith('atr14-v2-')),false);
});

test('V2 rejects count, corruption, and preexisting partial directory',async t=>{
 const {root,store}=await fixture(t);
 await assert.rejects(store.publishStream(metadata(3),rows(2),{model}),{code:'DATASET_COUNT_MISMATCH'});
 const refs=await store.publishStream(metadata(3),rows(3),{model});
 const folder=path.join(root,'atr14-v2-'+refs.sidecar.sha256);
 const chunk=path.join(folder,'chunk-00000.jsonl');
 const original=await readFile(chunk);
 await writeFile(chunk,'{"atr14":"9"}\n{"atr14":"3"}\n{"atr14":"4"}\n');
 await assert.rejects(collect(store.readV2(refs)),{code:'RESEARCH_SIDECAR_HASH_MISMATCH'});
 await writeFile(chunk,original);
 await writeFile(chunk,original);
 const other=await fixture(t);
 const target=path.join(other.root,'atr14-v2-'+refs.sidecar.sha256);
 await mkdir(target);
 await assert.rejects(other.store.publishStream(metadata(3),rows(3),{model}),{code:'INVALID_RESEARCH_SIDECAR'});
 assert.deepEqual(await readdir(target),[]);
});

test('V2 rejects noncanonical ATR line even when manifest and chunk hashes match',async t=>{
 const {root,store}=await fixture(t);
 const refs=await store.publishStream(metadata(3),rows(3),{model});
 const manifest=await store.inspectSidecarV2(refs.sidecar);
 const bytes=Buffer.from('{"atr14": "2"}\n{"atr14":"3"}\n{"atr14":"4"}\n');
 manifest.chunks[0]={...manifest.chunks[0],bytes:bytes.length,sha256:hash(bytes)};
 const sha256=hash(canonical(manifest));
 const folder=path.join(root,'atr14-v2-'+sha256);
 await mkdir(folder);await writeFile(path.join(folder,'manifest.json'),canonical(manifest));
 await writeFile(path.join(folder,'chunk-00000.jsonl'),bytes);
 const bad={raw:refs.raw,sidecar:{...refs.sidecar,sha256}};
 await assert.rejects(collect(store.readV2(bad)),{code:'INVALID_RESEARCH_SIDECAR'});
});

test('V2 rejects invalid model, line size, range, version, and constructor option',async t=>{
 const {root,store}=await fixture(t);
 assert.throws(()=>new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:'yes'}),{code:'INVALID_RESEARCH_SIDECAR'});
 await assert.rejects(store.publishStream(metadata(3),rows(3),{model:{...model,price_tick:'0'}}),{code:'INVALID_RESEARCH_SIDECAR'});
 await assert.rejects(store.publishStream(metadata(3),rows(3),{model:{...model,quantity_step:'-1'}}),{code:'INVALID_RESEARCH_SIDECAR'});
 async function* oversized(){yield {...(await rows(1).next()).value,atr14:'1'.repeat(260)};}
 await assert.rejects(store.publishStream(metadata(2),oversized(),{model}),{code:'INVALID_RESEARCH_SIDECAR'});
 const refs=await store.publishStream(metadata(3),rows(3),{model});
 await assert.rejects(collect(store.readV2(refs,{start:-1})),{code:'INVALID_DATASET_RANGE'});
 await assert.rejects(collect(store.readV2(refs,{start:2,end:4})),{code:'INVALID_DATASET_RANGE'});
 await assert.rejects(collect(store.readV2({raw:refs.raw,sidecar:{...refs.sidecar,version:'unknown'}})),{code:'INVALID_RESEARCH_SIDECAR'});
 await assert.rejects(store.publishStream(metadata(3),rows(3),{model,chunkBars:1001}),{code:'INVALID_RESEARCH_SIDECAR'});
});

test('V2 rejects linked chunk when local symlink privilege exists',async t=>{
 const {root,store}=await fixture(t);
 const refs=await store.publishStream(metadata(3),rows(3),{model});
 const folder=path.join(root,'atr14-v2-'+refs.sidecar.sha256),chunk=path.join(folder,'chunk-00000.jsonl');
 await rm(chunk);
 try{await symlink(path.join(folder,'manifest.json'),chunk);}
 catch(error){if(error.code==='EPERM'){t.skip('Windows symlink privilege unavailable');return;}throw error;}
 await assert.rejects(collect(store.readV2(refs)),{code:'INVALID_RESEARCH_SIDECAR'});
});

test('V2 real storage reservation is released after cancel',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'atr-v2-budget-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const budget=new StorageBudget({root,diskQuotaBytes:50*1024*1024,tempQuotaBytes:50*1024*1024,freeFloorBytes:0});
 const store=new ResearchDatasetStore({root,storageBudget:budget,allowUnsupportedDirectorySyncForTests:true});
 const controller=new AbortController();
 async function* cancelledRows(){
  let index=0;
  for await(const row of rows(1500)){
   if(index++===1001){
    const active=await budget.inspect();
    assert.ok(active.reservations>=2);
    assert.ok(active.pendingBytes>0);
    controller.abort();
   }
   yield row;
  }
 }
 await assert.rejects(store.publishStream(metadata(1500),cancelledRows(),{model,signal:controller.signal}),{code:'DATASET_CANCELLED'});
 const state=await budget.inspect();
 assert.equal(state.reservations,0);assert.equal(state.pendingBytes,0);assert.equal(state.committedBytes,0);
 const refs=await store.publishStream(metadata(3),rows(3),{model});
 const committed=await budget.inspect();
 assert.equal(committed.reservations,0);assert.equal(committed.pendingBytes,0);
 assert.ok(committed.committedBytes>0);
 assert.equal((await store.inspectSidecarV2(refs.sidecar)).bar_count,3);
});

test('V2 closes raw iterator when range consumer stops early',async t=>{
 const {store}=await fixture(t);
 const refs=await store.publishStream(metadata(3),rows(3),{model});
 const original=store.raw.read.bind(store.raw);
 let closed=false;
 store.raw.read=async function* (...args){
  try{yield* original(...args);}finally{closed=true;}
 };
 const iterator=store.readV2(refs,{start:0,end:3});
 assert.equal((await iterator.next()).value.atr14,'2');
 await iterator.return();
 assert.equal(closed,true);
});

test('V2 refuses sidecar commit if raw dependency directory disappears',async t=>{
 const {root,store}=await fixture(t);
 const publish=store.raw.publish.bind(store.raw);
 store.raw.publish=async(...args)=>{
  const reference=await publish(...args);
  await rm(path.join(root,reference.dataset_id),{recursive:true});
  return reference;
 };
 await assert.rejects(store.publishStream(metadata(3),rows(3),{model}));
 const names=await readdir(root);
 assert.equal(names.some(name=>name.startsWith('atr14-v2-')),false);
 assert.equal(names.some(name=>name.startsWith('.pending-')),false);
});

test('V1 read and artifact remain independent of V2 methods',async t=>{
 const {store}=await fixture(t);
 const oldRows=await collect(rows(3));
 const old=await store.publish(metadata(3),oldRows,{model});
 const newer=await store.publishStream(metadata(3),rows(3),{model});
 assert.deepEqual(await store.publishStream(metadata(3),rows(3),{model}),newer);
 assert.deepEqual((await store.sidecar(old.sidecar)).atr14,['2','3','4']);
 assert.deepEqual((await collect(store.read(old))).map(row=>row.atr14),['2','3','4']);
 assert.equal(newer.raw.sha256,old.raw.sha256);
 await assert.rejects(collect(store.read(newer)),{code:'INVALID_FIELDS'});
});
