import {constants} from 'node:fs';
import {open,lstat,link,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {DatasetStore} from './dataset-store.js';
import {canonical,hash,fail,keys} from '../pine-bridge/source.js';
import {D,exact} from '../money.js';
import {publishAtr14V2,inspectAtr14V2,readAtr14V2} from './atr14-chunk-store.js';

const MAX_SIDECAR_BYTES=2*1024*1024;
const aborted=signal=>{if(signal?.aborted)throw fail('DATASET_CANCELLED');};

/** Raw OHLCV remains reusable. Frozen market ATR14 is a separate immutable artifact.
 * Timestamps are the verified closed-bar timestamps, not exchange open times.
 * Metadata's half-open index range ends one minute after the last timestamp.
 */
export class ResearchDatasetStore {
 constructor({root,storageBudget,allowUnsupportedDirectorySyncForTests=false}){if(typeof allowUnsupportedDirectorySyncForTests!=='boolean')throw fail('INVALID_RESEARCH_SIDECAR');this.raw=new DatasetStore({root,storageBudget});this.root=this.raw.root;this.storageBudget=storageBudget;this.allowUnsupportedDirectorySyncForTests=allowUnsupportedDirectorySyncForTests;}
 async publishStream(metadata,rows,{model,signal,chunkBars=1000}={}){
  return publishAtr14V2({rawStore:this.raw,root:this.root,storageBudget:this.storageBudget,metadata,rows,model,signal,chunkBars,allowUnsupportedDirectorySyncForTests:this.allowUnsupportedDirectorySyncForTests});
 }
 async inspectSidecarV2(reference,{signal}={}){
  return inspectAtr14V2(this.raw,this.root,reference,{signal});
 }
 async *readV2(reference,{start=0,end,signal}={}){
  yield* readAtr14V2(this,reference,{start,end,signal});
 }
 async sidecar(reference,{signal}={}){
  aborted(signal);
  keys(reference,['sha256','bar_count','first_time','profile','price_tick','quantity_step']);
  if(!/^[a-f0-9]{64}$/.test(reference.sha256)||!Number.isSafeInteger(reference.bar_count)||reference.bar_count<1||reference.bar_count>10000||reference.profile!=='closed-ohlcv-atr14-v1')throw fail('INVALID_RESEARCH_SIDECAR');
  await this.raw.ready();aborted(signal);const filename=path.join(this.root,'atr14-'+reference.sha256+'.json');
  const stat=await lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_SIDECAR_BYTES)throw fail('INVALID_RESEARCH_SIDECAR');
  const file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  let bytes;
  try{
   const current=await file.stat();
   if(!current.isFile()||current.size!==stat.size||current.size>MAX_SIDECAR_BYTES||current.dev!==stat.dev||current.ino!==stat.ino)throw fail('INVALID_RESEARCH_SIDECAR');
   bytes=Buffer.alloc(current.size);let offset=0;
   while(offset<bytes.length){
    aborted(signal);
    const {bytesRead}=await file.read(bytes,offset,Math.min(64*1024,bytes.length-offset),offset);
    if(!bytesRead)throw fail('INVALID_RESEARCH_SIDECAR');
    offset+=bytesRead;
   }
   aborted(signal);
   const final=await file.stat();
   if(!final.isFile()||final.size!==bytes.length)throw fail('INVALID_RESEARCH_SIDECAR');
  }finally{await file.close();}
  if(hash(bytes)!==reference.sha256)throw fail('RESEARCH_SIDECAR_HASH_MISMATCH');
  const value=JSON.parse(bytes);keys(value,['version','first_time','profile','price_tick','quantity_step','atr14']);
  if(value.version!=='research-atr14-v1'||value.first_time!==reference.first_time||value.profile!==reference.profile||value.price_tick!==reference.price_tick||value.quantity_step!==reference.quantity_step||!Array.isArray(value.atr14)||value.atr14.length!==reference.bar_count||canonical(value)!==bytes.toString())throw fail('INVALID_RESEARCH_SIDECAR');
  for(const atr of value.atr14){exact(atr);if(!D(atr).gt(0))throw fail('INVALID_RESEARCH_SIDECAR');}
  return value;
 }
 async publish(metadata,bars,{model,signal,chunkBars=1000}={}){
  aborted(signal);
  if(!Array.isArray(bars)||bars.length!==metadata.total_bars||bars.length>10000||model?.data_profile!=='closed-ohlcv-atr14-v1')throw fail('INVALID_RESEARCH_SIDECAR');
  const atr14=[];
  for(const bar of bars){aborted(signal);if(!D(bar.price_tick).eq(model.price_tick)||!D(bar.quantity_step).eq(model.quantity_step)||!D(bar.atr14).gt(0))throw fail('MARKET_METADATA_MISMATCH');exact(bar.atr14);atr14.push(bar.atr14);}
  const raw=await this.raw.publish(metadata,bars.map(({time,open,high,low,close,volume})=>({time,open,high,low,close,volume})),{signal,chunkBars});
  const value={version:'research-atr14-v1',first_time:bars[0].time,profile:model.data_profile,price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),atr14};
  const bytes=canonical(value),sha256=hash(bytes),sidecar={sha256,bar_count:bars.length,first_time:bars[0].time,profile:model.data_profile,price_tick:value.price_tick,quantity_step:value.quantity_step};
  const filename=path.join(this.root,'atr14-'+sha256+'.json');
  if(Buffer.byteLength(bytes)>MAX_SIDECAR_BYTES)throw fail('INVALID_RESEARCH_SIDECAR');
  const pendingName='.pending-atr14-'+randomUUID()+'.json';
  const temporary=path.join(this.root,pendingName);
  const reservation=this.storageBudget?await this.storageBudget.reserve({diskBytes:MAX_SIDECAR_BYTES,tempBytes:MAX_SIDECAR_BYTES,pendingName}):null;
  let created=false;
  try{
   aborted(signal);
   const file=await open(temporary,'wx',0o600);created=true;
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   aborted(signal);
   // A hard link publishes only the fully written, synced file and never replaces a winner.
   try{await link(temporary,filename);}
   catch(error){if(error.code!=='EEXIST')throw error;await this.sidecar(sidecar,{signal});}
  }finally{if(created)await rm(temporary,{force:true});await reservation?.release();}
  aborted(signal);
  return {raw,sidecar};
 }
 async *read(reference,{start=0,end,signal}={}){
  aborted(signal);keys(reference,['raw','sidecar']);const sidecar=await this.sidecar(reference.sidecar,{signal});
  if(reference.raw.metadata.total_bars!==reference.sidecar.bar_count||reference.raw.metadata.start_time!==reference.sidecar.first_time)throw fail('RESEARCH_SIDECAR_DATASET_MISMATCH');
  let index=start;
  for await(const row of this.raw.read(reference.raw,{start,end,signal}))yield {...row,atr14:sidecar.atr14[index++]};
 }
}
