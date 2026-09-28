import {constants} from 'node:fs';
import {mkdir, lstat, open, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {canonical, hash, fail, keys} from '../pine-bridge/source.js';
import {D, exact} from '../money.js';
import {validateDatasetMetadata, validateDatasetReference} from './foundation-contract.js';

const MAX_CHUNKS=10000, MAX_BAR_BYTES=1024, MAX_MANIFEST_BYTES=2*1024*1024;
const HEX=/^[a-f0-9]{64}$/;
const aborted=signal=>{if(signal?.aborted)throw fail('DATASET_CANCELLED');};
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;

async function directory(filename) {
  const stat=await lstat(filename);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('UNSAFE_DATASET_PATH');
}

async function readFileBounded(filename,maxBytes) {
  const stat=await lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw fail('INVALID_DATASET_FILE');
  const file=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try {
    const actual=await file.stat();
    if(!actual.isFile()||actual.size>maxBytes)throw fail('INVALID_DATASET_FILE');
    // An exact-size read avoids allocation growth if a corrupt file is appended concurrently.
    const buffer=Buffer.alloc(actual.size);
    let offset=0;
    while(offset<buffer.length) {
      const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,offset);
      if(!bytesRead)throw fail('INVALID_DATASET_FILE');
      offset+=bytesRead;
    }
    if((await file.stat()).size!==actual.size)throw fail('INVALID_DATASET_FILE');
    return buffer;
  } finally {await file.close();}
}

async function writeExclusive(filename,content) {
  const file=await open(filename,'wx',0o600);
  try {await file.writeFile(content);await file.sync();} finally {await file.close();}
}

function checkedBar(value,metadata,index) {
  try {
    keys(value,['time','open','high','low','close','volume']);
    if(!integer(value.time,1,Number.MAX_SAFE_INTEGER))throw fail('INVALID_DATASET_BAR');
    for(const field of ['open','high','low','close','volume'])if(!['number','string'].includes(typeof value[field]))throw fail('INVALID_DATASET_BAR');
    for(const field of ['open','high','low','close']){if(D(value[field]).lte(0))throw fail('INVALID_DATASET_BAR');exact(value[field]);}
    exact(value.volume);
    if(D(value.volume).lt(0)||D(value.high).lt(value.low)||D(value.high).lt(value.open)||D(value.high).lt(value.close)||D(value.low).gt(value.open)||D(value.low).gt(value.close))throw fail('INVALID_DATASET_BAR');
  } catch {throw fail('INVALID_DATASET_BAR');}
  if(value.time!==metadata.start_time+index*60000||value.time+60000>metadata.cutoff)throw fail('DATASET_CONTINUITY_MISMATCH');
  const line=canonical(value)+'\n';
  if(Buffer.byteLength(line)>MAX_BAR_BYTES)throw fail('DATASET_BAR_TOO_LARGE');
  return line;
}

/** Shared immutable market cache. Trusted callers must authorize access before use. */
export class DatasetStore {
  constructor({root,storageBudget}={}) {
    if(typeof root!=='string'||!path.isAbsolute(root))throw fail('INVALID_DATASET_ROOT');
    this.root=path.resolve(root);
    if(storageBudget&&storageBudget.root!==this.root)throw fail('STORAGE_BUDGET_CONFIGURATION_REQUIRED');
    this.storageBudget=storageBudget;
  }

  async ready() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    await directory(this.root);
    // Reject linked ancestors too. The root must remain protected from other writers.
    let ancestor=path.dirname(this.root);
    while(ancestor!==path.dirname(ancestor)){await directory(ancestor);ancestor=path.dirname(ancestor);}
  }

  async publish(value,bars,{signal,chunkBars=50000}={}) {
    const metadata=validateDatasetMetadata(value);
    if(!integer(chunkBars,1,50000)||Math.ceil(metadata.total_bars/chunkBars)>MAX_CHUNKS)throw fail('INVALID_DATASET_CHUNK_SIZE');
    aborted(signal);await this.ready();aborted(signal);
    const pendingName='.pending-'+randomUUID();
    const temporary=path.join(this.root,pendingName);
    const estimatedBytes=metadata.total_bars*MAX_BAR_BYTES+MAX_MANIFEST_BYTES;
    const reservation=this.storageBudget?await this.storageBudget.reserve({diskBytes:estimatedBytes,tempBytes:estimatedBytes,pendingName}):null;
    try {
      await mkdir(temporary,{mode:0o700});
      const chunks=[];
      let lines=[],count=0,chunkStart=0;
      const flush=async()=>{
        const bytes=Buffer.from(lines.join(''));
        const filename=`chunk-${String(chunks.length).padStart(5,'0')}.jsonl`;
        await writeExclusive(path.join(temporary,filename),bytes);
        chunks.push({file:filename,start:chunkStart,count:lines.length,bytes:bytes.length,sha256:hash(bytes)});
        chunkStart=count;lines=[];
      };
      for await(const bar of bars) {
        aborted(signal);
        if(count>=metadata.total_bars)throw fail('DATASET_COUNT_MISMATCH');
        lines.push(checkedBar(bar,metadata,count++));
        if(lines.length===chunkBars)await flush();
      }
      aborted(signal);
      if(count!==metadata.total_bars)throw fail('DATASET_COUNT_MISMATCH');
      if(lines.length)await flush();
      const manifest={version:'dataset-manifest-v1',metadata,chunks};
      const serialized=canonical(manifest);
      if(Buffer.byteLength(serialized)>MAX_MANIFEST_BYTES)throw fail('DATASET_MANIFEST_TOO_LARGE');
      const dataset_id=hash(serialized),reference={dataset_id,sha256:dataset_id,metadata};
      await writeExclusive(path.join(temporary,'manifest.json'),serialized);
      aborted(signal);
      try {await rename(temporary,path.join(this.root,dataset_id));}
      catch(error) {
        if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;
        // A concurrent winner is reusable only after verifying its complete content.
        for await(const ignored of this.read(reference,{signal})) {void ignored;}
      }
      return reference;
    } finally {await rm(temporary,{recursive:true,force:true});await reservation?.release();}
  }

  async inspect(value) {
    const reference=validateDatasetReference(value);
    await this.ready();
    const folder=path.join(this.root,reference.dataset_id);
    await directory(folder);
    const bytes=await readFileBounded(path.join(folder,'manifest.json'),MAX_MANIFEST_BYTES);
    if(hash(bytes)!==reference.sha256)throw fail('DATASET_HASH_MISMATCH');
    let manifest;
    try {manifest=JSON.parse(bytes.toString('utf8'));} catch {throw fail('INVALID_DATASET_MANIFEST');}
    keys(manifest,['version','metadata','chunks']);
    if(manifest.version!=='dataset-manifest-v1'||canonical(validateDatasetMetadata(manifest.metadata))!==canonical(reference.metadata)||!Array.isArray(manifest.chunks)||manifest.chunks.length<1||manifest.chunks.length>MAX_CHUNKS)throw fail('INVALID_DATASET_MANIFEST');
    let start=0;
    for(const [index,chunk] of manifest.chunks.entries()) {
      keys(chunk,['file','start','count','bytes','sha256']);
      if(chunk.file!==`chunk-${String(index).padStart(5,'0')}.jsonl`||chunk.start!==start||!integer(chunk.count,1,50000)||!integer(chunk.bytes,1,chunk.count*MAX_BAR_BYTES)||typeof chunk.sha256!=='string'||!HEX.test(chunk.sha256))throw fail('INVALID_DATASET_MANIFEST');
      start+=chunk.count;
    }
    if(start!==reference.metadata.total_bars)throw fail('INVALID_DATASET_MANIFEST');
    return manifest;
  }

  async *read(value,{start=0,end,signal}={}) {
    aborted(signal);
    const reference=validateDatasetReference(value);
    if(end===undefined)end=reference.metadata.total_bars;
    if(!integer(start,0,reference.metadata.total_bars)||!integer(end,start,reference.metadata.total_bars))throw fail('INVALID_DATASET_RANGE');
    const manifest=await this.inspect(reference);
    for(const chunk of manifest.chunks) {
      aborted(signal);
      if(chunk.start>=end||chunk.start+chunk.count<=start)continue;
      const bytes=await readFileBounded(path.join(this.root,reference.dataset_id,chunk.file),chunk.bytes);
      if(bytes.length!==chunk.bytes||hash(bytes)!==chunk.sha256)throw fail('DATASET_HASH_MISMATCH');
      const lines=bytes.toString('utf8').split('\n');
      if(lines.pop()!==''||lines.length!==chunk.count)throw fail('INVALID_DATASET_CHUNK');
      for(let offset=0;offset<lines.length;offset++) {
        aborted(signal);
        let bar;
        try {bar=JSON.parse(lines[offset]);} catch {throw fail('INVALID_DATASET_CHUNK');}
        const index=chunk.start+offset;
        if(checkedBar(bar,reference.metadata,index)!==lines[offset]+'\n')throw fail('INVALID_DATASET_CHUNK');
        if(index>=start&&index<end)yield bar;
      }
    }
  }
}
