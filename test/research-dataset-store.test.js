import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,mkdir,open} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
const model={data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'};
const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:60000,end_time:240000,warmup_bars:1,total_bars:3,cutoff:240000,source:'binance-spot-klines-v1'};
const bars=Array.from({length:3},(_,i)=>({time:(i+1)*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:String(i+2),price_tick:'0.01',quantity_step:'0.001'}));
const collect=async stream=>{const rows=[];for await(const row of stream)rows.push(row);return rows;};
test('research sidecar preserves frozen ATR14 and leaves raw DatasetStore free of model data',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'research-store-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new ResearchDatasetStore({root});
 const refs=await store.publish(metadata,bars,{model,chunkBars:2});
 assert.deepEqual(await collect(store.raw.read(refs.raw)),bars.map(({time,open,high,low,close,volume})=>({time,open,high,low,close,volume})));
 const rows=await collect(store.read(refs,{start:1,end:3}));assert.deepEqual(rows.map(r=>r.atr14),['3','4']);assert.equal(rows[0].time,120000);
 assert.deepEqual(await store.publish(metadata,bars,{model,chunkBars:2}),refs);
 await assert.rejects(store.publish(metadata,bars.map((r,i)=>i===1?{...r,price_tick:'1'}:r),{model}),{code:'MARKET_METADATA_MISMATCH'});
 await writeFile(path.join(root,'atr14-'+refs.sidecar.sha256+'.json'),'{}');
 await assert.rejects(collect(store.read(refs)),{code:'RESEARCH_SIDECAR_HASH_MISMATCH'});
 await assert.rejects(store.publish(metadata,bars,{model,chunkBars:2}),{code:'RESEARCH_SIDECAR_HASH_MISMATCH'});
 assert.equal(await readFile(path.join(root,'atr14-'+refs.sidecar.sha256+'.json'),'utf8'),'{}');
 assert.equal((await readdir(root)).some(name=>name.startsWith('.pending-atr14-')),false);
});

test('concurrent sidecar publishers expose only complete content and verify the winner',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'research-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stores=Array.from({length:24},()=>new ResearchDatasetStore({root}));
 const raw=await stores[0].raw.publish(metadata,bars.map(({time,open,high,low,close,volume})=>({time,open,high,low,close,volume})),{chunkBars:2});
 // Synchronize the sidecar race after the independently tested raw publication.
 for(const store of stores)store.raw.publish=async()=>raw;
 const refs=await Promise.all(stores.map(store=>store.publish(metadata,bars,{model,chunkBars:2})));
 for(const reference of refs)assert.deepEqual(reference,refs[0]);
 for(const store of stores)assert.deepEqual((await store.sidecar(refs[0].sidecar)).atr14,['2','3','4']);
 const files=await readdir(root);
 assert.equal(files.filter(name=>name.startsWith('atr14-')).length,1);
 assert.equal(files.some(name=>name.startsWith('.pending-')),false);
});

test('sidecar reads accumulate short reads and reject nonregular and oversized files',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'research-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new ResearchDatasetStore({root});const refs=await store.publish(metadata,bars,{model});
 const filename=path.join(root,'atr14-'+refs.sidecar.sha256+'.json');
 const handle=await open(filename,'r');const prototype=Object.getPrototypeOf(handle);await handle.close();
 const original=prototype.read;let reads=0;
 const mocked=t.mock.method(prototype,'read',async function(buffer,offset,length,position){reads++;return original.call(this,buffer,offset,Math.min(length,7),position);});
 assert.deepEqual((await store.sidecar(refs.sidecar)).atr14,['2','3','4']);
 assert.ok(reads>1);mocked.mock.restore();
 await rm(filename);await mkdir(filename);
 await assert.rejects(store.sidecar(refs.sidecar),{code:'INVALID_RESEARCH_SIDECAR'});
 await rm(filename,{recursive:true});await writeFile(filename,Buffer.alloc(2*1024*1024+1));
 await assert.rejects(store.sidecar(refs.sidecar),{code:'INVALID_RESEARCH_SIDECAR'});
});

test('large bounded sidecars are read completely',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'research-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new ResearchDatasetStore({root});await store.raw.ready();
 const value={version:'research-atr14-v1',first_time:60000,profile:model.data_profile,price_tick:model.price_tick,quantity_step:model.quantity_step,atr14:Array.from({length:10000},(_,i)=>String(10000+i))};
 const content=canonical(value),sha256=hash(content);
 assert.ok(Buffer.byteLength(content)>64*1024);
 await writeFile(path.join(root,'atr14-'+sha256+'.json'),content);
 assert.deepEqual(await store.sidecar({sha256,bar_count:10000,first_time:60000,profile:model.data_profile,price_tick:model.price_tick,quantity_step:model.quantity_step}),value);
});

test('abort during sidecar writes and reads leaves no partial final or temporary files',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'research-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new ResearchDatasetStore({root});const refs=await store.publish(metadata,bars,{model});
 const controller=new AbortController();controller.abort();
 await assert.rejects(store.publish(metadata,bars,{model,signal:controller.signal}),{code:'DATASET_CANCELLED'});
 await assert.rejects(store.sidecar(refs.sidecar,{signal:controller.signal}),{code:'DATASET_CANCELLED'});
 await assert.rejects(collect(store.read(refs,{signal:controller.signal})),{code:'DATASET_CANCELLED'});
 const filename=path.join(root,'atr14-'+refs.sidecar.sha256+'.json');
 const handle=await open(filename,'r');const prototype=Object.getPrototypeOf(handle);await handle.close();
 const original=prototype.read;const reading=new AbortController();
 const readMock=t.mock.method(prototype,'read',async function(buffer,offset,length,position){const result=await original.call(this,buffer,offset,Math.min(length,7),position);reading.abort();return result;});
 await assert.rejects(store.sidecar(refs.sidecar,{signal:reading.signal}),{code:'DATASET_CANCELLED'});readMock.mock.restore();
 const writing=new AbortController();const originalSync=prototype.sync;
 const syncMock=t.mock.method(prototype,'sync',async function(){const result=await originalSync.call(this);writing.abort();return result;});
 // Isolate the sidecar boundary after raw publication so this cancellation reaches the new temp file.
 store.raw.publish=async()=>refs.raw;
 await assert.rejects(store.publish(metadata,bars.map(bar=>({...bar,atr14:String(Number(bar.atr14)+10)})),{model,signal:writing.signal}),{code:'DATASET_CANCELLED'});syncMock.mock.restore();
 assert.equal((await readdir(root)).some(name=>name.startsWith('.pending-')),false);
 assert.equal((await readdir(root)).filter(name=>name.startsWith('atr14-')).length,1);
 assert.deepEqual((await store.sidecar(refs.sidecar)).atr14,['2','3','4']);
});
