import {constants} from 'node:fs';
import {lstat,link,mkdir,open,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {canonical,hash,fail,keys} from '../pine-bridge/source.js';
import {D,exact} from '../money.js';
import {validateDatasetMetadata} from './foundation-contract.js';

const VERSION='research-atr14-chunked-v2';
const MAX_BARS=999500, MAX_CHUNKS=1000, MAX_CHUNK_BARS=1000;
const MAX_LINE_BYTES=256, MAX_MANIFEST_BYTES=2*1024*1024;
const HEX=/^[a-f0-9]{64}$/;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const aborted=signal=>{if(signal?.aborted)throw fail('DATASET_CANCELLED');};
const name=sha=>`atr14-v2-${sha}`;
const chunkName=index=>`chunk-${String(index).padStart(5,'0')}.jsonl`;

function validateReference(reference){
 keys(reference,['version','sha256','bar_count','first_time','profile','price_tick','quantity_step']);
 if(reference.version!==VERSION||!HEX.test(reference.sha256)||!integer(reference.bar_count,1,MAX_BARS)||
    !integer(reference.first_time,1,Number.MAX_SAFE_INTEGER)||reference.profile!=='closed-ohlcv-atr14-v1'||
    typeof reference.price_tick!=='string'||typeof reference.quantity_step!=='string')throw fail('INVALID_RESEARCH_SIDECAR');
 try{exact(reference.price_tick);exact(reference.quantity_step);if(!D(reference.price_tick).gt(0)||!D(reference.quantity_step).gt(0))throw Error();}
 catch{throw fail('INVALID_RESEARCH_SIDECAR');}
 return reference;
}

async function directory(filename){
 let stat;
 try{stat=await lstat(filename);}catch(error){if(error.code==='ENOENT')throw fail('INVALID_RESEARCH_SIDECAR');throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('INVALID_RESEARCH_SIDECAR');
 return stat;
}

async function readBounded(filename,maxBytes,signal){
 aborted(signal);
 let before;
 try{before=await lstat(filename);}catch(error){if(error.code==='ENOENT')throw fail('INVALID_RESEARCH_SIDECAR');throw error;}
 if(!before.isFile()||before.isSymbolicLink()||!integer(before.size,1,maxBytes))throw fail('INVALID_RESEARCH_SIDECAR');
 const file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const current=await file.stat();
  if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size)throw fail('INVALID_RESEARCH_SIDECAR');
  const bytes=Buffer.alloc(current.size);
  let offset=0;
  while(offset<bytes.length){
   aborted(signal);
   const {bytesRead}=await file.read(bytes,offset,Math.min(64*1024,bytes.length-offset),offset);
   if(!bytesRead)throw fail('INVALID_RESEARCH_SIDECAR');
   offset+=bytesRead;
  }
  aborted(signal);
  if((await file.stat()).size!==bytes.length)throw fail('INVALID_RESEARCH_SIDECAR');
  return bytes;
 }finally{await file.close();}
}

async function writeExclusive(filename,bytes){
 const file=await open(filename,'wx',0o600);
 try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}

async function syncDirectory(filename,allowUnsupportedDirectorySyncForTests){
 const before=await directory(filename);
 try{
  const file=await open(filename,constants.O_RDONLY|(constants.O_DIRECTORY||0)|(constants.O_NOFOLLOW||0));
  try{
   const current=await file.stat();
   if(!current.isDirectory()||current.dev!==before.dev||current.ino!==before.ino)throw fail('INVALID_RESEARCH_SIDECAR');
   await file.sync();
  }finally{await file.close();}
 }catch(error){
  if(!(allowUnsupportedDirectorySyncForTests&&process.platform==='win32'&&
       ['EACCES','EPERM','EINVAL','EBADF','EISDIR'].includes(error.code)))throw error;
 }
}

function checkedAtr(value,model){
 try{
  if(!D(value.price_tick).eq(model.price_tick)||!D(value.quantity_step).eq(model.quantity_step))throw Error();
  if(typeof value.atr14!=='string')throw Error();
  exact(value.atr14);
  if(!D(value.atr14).gt(0))throw Error();
  const line=canonical({atr14:value.atr14})+'\n';
  if(Buffer.byteLength(line)>MAX_LINE_BYTES)throw Error();
  return line;
 }catch{throw fail('INVALID_RESEARCH_SIDECAR');}
}

function parseChunk(bytes,chunk){
 if(bytes.length!==chunk.bytes||hash(bytes)!==chunk.sha256)throw fail('RESEARCH_SIDECAR_HASH_MISMATCH');
 const lines=bytes.toString('utf8').split('\n');
 if(lines.pop()!==''||lines.length!==chunk.count)throw fail('INVALID_RESEARCH_SIDECAR');
 return lines.map(line=>{
  let value;
  try{
   value=JSON.parse(line);keys(value,['atr14']);if(typeof value.atr14!=='string')throw Error();exact(value.atr14);
   if(!D(value.atr14).gt(0)||canonical(value)!==line||Buffer.byteLength(line+'\n')>MAX_LINE_BYTES)throw Error();
  }catch{throw fail('INVALID_RESEARCH_SIDECAR');}
  return value.atr14;
 });
}

export async function inspectAtr14V2(rawStore,root,value,{signal,verifyChunks=false}={}){
 aborted(signal);
 const reference=validateReference(value);
 await rawStore.ready();
 const folder=path.join(root,name(reference.sha256));
 await directory(folder);
 const bytes=await readBounded(path.join(folder,'manifest.json'),MAX_MANIFEST_BYTES,signal);
 if(hash(bytes)!==reference.sha256)throw fail('RESEARCH_SIDECAR_HASH_MISMATCH');
 let manifest;
 try{manifest=JSON.parse(bytes.toString('utf8'));}catch{throw fail('INVALID_RESEARCH_SIDECAR');}
 keys(manifest,['version','first_time','profile','price_tick','quantity_step','bar_count','chunks']);
 if(manifest.version!==VERSION||manifest.first_time!==reference.first_time||manifest.profile!==reference.profile||
    manifest.price_tick!==reference.price_tick||manifest.quantity_step!==reference.quantity_step||
    manifest.bar_count!==reference.bar_count||!Array.isArray(manifest.chunks)||
    !integer(manifest.chunks.length,1,MAX_CHUNKS)||canonical(manifest)!==bytes.toString('utf8'))throw fail('INVALID_RESEARCH_SIDECAR');
 let start=0;
 for(const [index,chunk] of manifest.chunks.entries()){
  keys(chunk,['file','start','count','bytes','sha256']);
  if(chunk.file!==chunkName(index)||chunk.start!==start||!integer(chunk.count,1,MAX_CHUNK_BARS)||
     !integer(chunk.bytes,1,chunk.count*MAX_LINE_BYTES)||!HEX.test(chunk.sha256))throw fail('INVALID_RESEARCH_SIDECAR');
  if(verifyChunks){
   const chunkBytes=await readBounded(path.join(folder,chunk.file),chunk.bytes,signal);
   parseChunk(chunkBytes,chunk);
  }
  start+=chunk.count;
 }
 if(start!==reference.bar_count)throw fail('INVALID_RESEARCH_SIDECAR');
 return manifest;
}

export async function publishAtr14V2({rawStore,root,storageBudget,metadata:input,rows,model,signal,chunkBars=1000,allowUnsupportedDirectorySyncForTests=false}){
 aborted(signal);
 const metadata=validateDatasetMetadata(input);
 if(!integer(metadata.total_bars,1,MAX_BARS)||!integer(chunkBars,1,MAX_CHUNK_BARS)||
    Math.ceil(metadata.total_bars/chunkBars)>MAX_CHUNKS||model?.data_profile!=='closed-ohlcv-atr14-v1'||
    !rows?.[Symbol.asyncIterator]&&!rows?.[Symbol.iterator])throw fail('INVALID_RESEARCH_SIDECAR');
 for(const field of ['price_tick','quantity_step']){
  try{exact(model[field]);if(!D(model[field]).gt(0))throw Error();}
  catch{throw fail('INVALID_RESEARCH_SIDECAR');}
 }
 await rawStore.ready();
 const pendingName='.pending-'+randomUUID(),temporary=path.join(root,pendingName);
 const estimated=metadata.total_bars*MAX_LINE_BYTES+MAX_MANIFEST_BYTES;
 const reservation=storageBudget?await storageBudget.reserve({diskBytes:estimated,tempBytes:estimated,pendingName}):null;
 let created=false;
 try{
  await mkdir(temporary,{mode:0o700});created=true;
  const chunks=[];let lines=[],count=0,chunkStart=0;
  const flush=async()=>{
   aborted(signal);
   const bytes=Buffer.from(lines.join(''));
   const file=chunkName(chunks.length);
   await writeExclusive(path.join(temporary,file),bytes);
   chunks.push({file,start:chunkStart,count:lines.length,bytes:bytes.length,sha256:hash(bytes)});
   chunkStart=count;lines=[];
  };
  async function* rawRows(){
   for await(const row of rows){
    aborted(signal);
    if(count>=metadata.total_bars)throw fail('DATASET_COUNT_MISMATCH');
    lines.push(checkedAtr(row,model));
    count++;
    if(lines.length===chunkBars)await flush();
    if(count%1000===0){await setImmediate();aborted(signal);}
    const {time,open,high,low,close,volume}=row;
    yield {time,open,high,low,close,volume};
   }
  }
  const raw=await rawStore.publish(metadata,rawRows(),{signal,chunkBars});
  aborted(signal);
  await rawStore.inspect(raw);
  await syncDirectory(path.join(root,raw.dataset_id),allowUnsupportedDirectorySyncForTests);
  aborted(signal);
  if(count!==metadata.total_bars)throw fail('DATASET_COUNT_MISMATCH');
  if(lines.length)await flush();
  const manifest={version:VERSION,first_time:metadata.start_time,profile:model.data_profile,
   price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),bar_count:count,chunks};
  const bytes=canonical(manifest);
  if(Buffer.byteLength(bytes)>MAX_MANIFEST_BYTES)throw fail('INVALID_RESEARCH_SIDECAR');
  const sha256=hash(bytes),sidecar={version:VERSION,sha256,bar_count:count,first_time:metadata.start_time,
   profile:model.data_profile,price_tick:manifest.price_tick,quantity_step:manifest.quantity_step};
  await writeExclusive(path.join(temporary,'manifest.json'),bytes);
  await syncDirectory(temporary,allowUnsupportedDirectorySyncForTests);
  aborted(signal);
  const final=path.join(root,name(sha256));
  let winner=false;
  try{await mkdir(final,{mode:0o700});}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   // Never replace an existing directory, including an incomplete publication.
   await inspectAtr14V2(rawStore,root,sidecar,{signal,verifyChunks:true});
   winner=true;
  }
  if(!winner){
   // Manifest is the commit marker. Incomplete directories have no valid reference.
   for(const chunk of chunks){aborted(signal);await link(path.join(temporary,chunk.file),path.join(final,chunk.file));}
   await syncDirectory(final,allowUnsupportedDirectorySyncForTests);
   aborted(signal);
   await link(path.join(temporary,'manifest.json'),path.join(final,'manifest.json'));
   await syncDirectory(final,allowUnsupportedDirectorySyncForTests);
   await syncDirectory(root,allowUnsupportedDirectorySyncForTests);
  }else{
   await syncDirectory(final,allowUnsupportedDirectorySyncForTests);
   await syncDirectory(root,allowUnsupportedDirectorySyncForTests);
  }
  aborted(signal);
  return {raw,sidecar};
 }finally{
  if(created)await rm(temporary,{recursive:true,force:true});
  await reservation?.release();
 }
}

export async function* readAtr14V2(store,reference,{start=0,end,signal}={}){
 aborted(signal);
 keys(reference,['raw','sidecar']);
 const sidecar=validateReference(reference.sidecar);
 if(reference.raw?.metadata?.total_bars!==sidecar.bar_count||reference.raw.metadata.start_time!==sidecar.first_time)
  throw fail('RESEARCH_SIDECAR_DATASET_MISMATCH');
 if(end===undefined)end=sidecar.bar_count;
 if(!integer(start,0,sidecar.bar_count)||!integer(end,start,sidecar.bar_count))throw fail('INVALID_DATASET_RANGE');
 const manifest=await inspectAtr14V2(store.raw,store.root,sidecar,{signal});
 const raw=store.raw.read(reference.raw,{start,end,signal})[Symbol.asyncIterator]();
 try{
  for(const chunk of manifest.chunks){
   aborted(signal);
   if(chunk.start>=end||chunk.start+chunk.count<=start)continue;
   const bytes=await readBounded(path.join(store.root,name(sidecar.sha256),chunk.file),chunk.bytes,signal);
   const values=parseChunk(bytes,chunk);
   for(let i=0;i<values.length;i++){
    const index=chunk.start+i;
    if(index<start||index>=end)continue;
    aborted(signal);
    const row=await raw.next();
    if(row.done||row.value.time!==sidecar.first_time+index*60000)throw fail('RESEARCH_SIDECAR_DATASET_MISMATCH');
    yield {...row.value,atr14:values[i]};
   }
   await setImmediate();
  }
  if(!(await raw.next()).done)throw fail('RESEARCH_SIDECAR_DATASET_MISMATCH');
 }finally{await raw.return?.();}
}
