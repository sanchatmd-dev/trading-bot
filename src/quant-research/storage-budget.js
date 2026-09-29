import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, readdir, lstat, readFile, rm, statfs, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fail} from '../pine-bridge/source.js';
import {DatasetStore} from './dataset-store.js';

const safeName=name=>typeof name==='string'&&/^(?:\.database-owner\.json|\.pending-(?:[a-f0-9-]+|atr14-[a-f0-9-]+\.json)|[a-f0-9]{64}|atr14-[a-f0-9]{64}\.json|atr14-v2-[a-f0-9]{64})$/.test(name);
const safeBytes=n=>Number.isSafeInteger(n)&&n>=0;
const READINESS_PURPOSE='quant-io-readiness-v1';
const readinessName=name=>typeof name==='string'&&/^\.pending-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name);
const validPurpose=value=>value.purpose===undefined||(value.purpose===READINESS_PURPOSE&&value.diskBytes===4096&&value.tempBytes===4096&&readinessName(value.pendingName));
const ledgerName='.storage-reservations', lockName='.storage-lock';
const MAX_SCAN_ENTRIES=100_000, MAX_SCAN_DEPTH=8;

async function entries(filename,depth,scan) {
  if(depth>MAX_SCAN_DEPTH)throw fail('STORAGE_ACCOUNTING_FAILED');
  const names=await readdir(filename);
  scan.count+=names.length;
  if(scan.count>MAX_SCAN_ENTRIES)throw fail('STORAGE_ACCOUNTING_FAILED');
  return names;
}
async function sizeOf(filename,depth=0,scan={count:0}) {
  const stat=await lstat(filename);
  if(stat.isSymbolicLink())throw fail('STORAGE_UNSAFE_PATH');
  if(stat.isFile())return stat.size;
  if(!stat.isDirectory())throw fail('STORAGE_UNSAFE_PATH');
  let total=0;
  for(const item of await entries(filename,depth,scan))total+=await sizeOf(path.join(filename,item),depth+1,scan);
  if(!Number.isSafeInteger(total))throw fail('STORAGE_ACCOUNTING_FAILED');
  return total;
}
async function newestMtime(filename,depth=0,scan={count:0}) {
  const stat=await lstat(filename);
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw fail('STORAGE_UNSAFE_PATH');
  let newest=stat.mtimeMs;
  if(stat.isDirectory())for(const name of await entries(filename,depth,scan))newest=Math.max(newest,await newestMtime(path.join(filename,name),depth+1,scan));
  return newest;
}

/** Per-root fail-closed admission ledger. Offline repair must establish no writers. */
export class StorageBudget {
  constructor({root,diskQuotaBytes,tempQuotaBytes,freeFloorBytes}={}) {
    if(typeof root!=='string'||!path.isAbsolute(root)||![diskQuotaBytes,tempQuotaBytes,freeFloorBytes].every(safeBytes)||!diskQuotaBytes||!tempQuotaBytes)throw fail('STORAGE_BUDGET_CONFIGURATION_REQUIRED');
    this.root=path.resolve(root);
    this.diskQuotaBytes=diskQuotaBytes;
    this.tempQuotaBytes=tempQuotaBytes;
    this.freeFloorBytes=freeFloorBytes;
  }
  async ready() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    await mkdir(path.join(this.root,ledgerName),{mode:0o700,recursive:true});
    for(const filename of [this.root,path.join(this.root,ledgerName)]) {
      const stat=await lstat(filename);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('STORAGE_UNSAFE_PATH');
    }
  }
  async locked(action) {
    await this.ready();
    const lock=path.join(this.root,lockName);
    let acquired=false;
    for(let attempt=0;attempt<500;attempt++) {
      try {await mkdir(lock,{mode:0o700});acquired=true;break;} catch(error) {
        if(error.code!=='EEXIST')throw error;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
    }
    if(!acquired)throw fail('STORAGE_LOCKED');
    const token=randomUUID();
    try {
      await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,createdAt:Date.now(),token}),{flag:'wx',mode:0o600});
      return await action();
    } finally {
      let owner;
      try {owner=JSON.parse(await readFile(path.join(lock,'owner.json'),'utf8'));} catch {throw fail('STORAGE_LOCK_LOST');}
      if(owner.token!==token)throw fail('STORAGE_LOCK_LOST');
      await rm(lock,{recursive:true});
    }
  }
  async snapshot() {
    await this.ready();
    let committed=0,temp=0;
    const pending=new Map();
    const scan={count:0};
    for(const name of await entries(this.root,0,scan)) {
      if(name===ledgerName||name===lockName)continue;
      if(!safeName(name))throw fail('STORAGE_UNKNOWN_ARTIFACT');
      const bytes=await sizeOf(path.join(this.root,name),1,scan);
      if(name.startsWith('.pending-')){pending.set(name,bytes);temp+=bytes;}
      else committed+=bytes;
    }
    const reservations=[];
    for(const name of await entries(path.join(this.root,ledgerName),0,scan)) {
      if(!/^[a-f0-9-]+\.json$/.test(name))throw fail('STORAGE_ACCOUNTING_FAILED');
      let value;
      try {value=JSON.parse(await readFile(path.join(this.root,ledgerName,name),'utf8'));} catch {throw fail('STORAGE_ACCOUNTING_FAILED');}
      if(!safeBytes(value.diskBytes)||!safeBytes(value.tempBytes)||!safeBytes(value.createdAt)||!safeName(value.pendingName)||!value.pendingName.startsWith('.pending-')||!validPurpose(value))throw fail('STORAGE_ACCOUNTING_FAILED');
      reservations.push(value);
    }
    // Pending bytes already occupy filesystem space. Reserve only unspent estimate.
    let reservedDisk=0,reservedTemp=0;
    for(const reservation of reservations) {
      const actual=pending.get(reservation.pendingName)||0;
      reservedDisk+=Math.max(reservation.diskBytes-actual,0);
      reservedTemp+=Math.max(reservation.tempBytes-actual,0);
    }
    if(![committed,temp,reservedDisk,reservedTemp].every(safeBytes))throw fail('STORAGE_ACCOUNTING_FAILED');
    const fs=await statfs(this.root);
    const freeBytes=fs.bavail*fs.bsize;
    if(!safeBytes(freeBytes))throw fail('STORAGE_ACCOUNTING_FAILED');
    return {committedBytes:committed,pendingBytes:temp,reservedDiskBytes:reservedDisk,reservedTempBytes:reservedTemp,freeBytes,reservations:reservations.length};
  }
  async inspect(){return this.locked(()=>this.snapshot());}
  async reserve({diskBytes,tempBytes,pendingName,purpose}={}) {
    if(!safeBytes(diskBytes)||!safeBytes(tempBytes)||!safeName(pendingName)||!pendingName.startsWith('.pending-')||!validPurpose({diskBytes,tempBytes,pendingName,purpose}))throw fail('STORAGE_BUDGET_CONFIGURATION_REQUIRED');
    const id=randomUUID(),filename=path.join(this.root,ledgerName,id+'.json');
    await this.locked(async()=>{
      const state=await this.snapshot();
      for(const name of await entries(path.join(this.root,ledgerName),0,{count:0})) {
        const existing=JSON.parse(await readFile(path.join(this.root,ledgerName,name),'utf8'));
        if(existing.pendingName===pendingName)throw fail('STORAGE_ACCOUNTING_FAILED');
      }
      if((await entries(this.root,0,{count:0})).includes(pendingName))throw fail('STORAGE_ACCOUNTING_FAILED');
      if(state.committedBytes+state.pendingBytes+state.reservedDiskBytes+diskBytes>this.diskQuotaBytes||state.pendingBytes+state.reservedTempBytes+tempBytes>this.tempQuotaBytes||state.freeBytes-state.reservedDiskBytes-diskBytes<this.freeFloorBytes)throw fail('STORAGE_CAPACITY_EXCEEDED');
      const file=await open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
      try {await file.writeFile(JSON.stringify({diskBytes,tempBytes,pendingName,createdAt:Date.now(),...(purpose?{purpose}:{})}));await file.sync();} finally {await file.close();}
    });
    let released=false;
    return {release:async()=>{if(released)return;await this.locked(async()=>{await rm(filename);});released=true;}};
  }
  /** Caller must hold an external DB maintenance lock and prove all writers stopped. */
  async maintenance({retainedNames,apply=false,exclusiveOffline=false,minAgeMs=24*60*60*1000,assertExclusive,recoverStaleLock=false}={}) {
    if(!exclusiveOffline||!Array.isArray(retainedNames)||retainedNames.some(name=>!safeName(name))||!safeBytes(minAgeMs)||minAgeMs<24*60*60*1000||
      (apply&&typeof assertExclusive!=='function')||(recoverStaleLock&&(!apply||typeof assertExclusive!=='function')))throw fail('STORAGE_MAINTENANCE_GUARD');
    const prove=async()=>{if(await assertExclusive()!==true)throw fail('STORAGE_MAINTENANCE_GUARD');};
    if(recoverStaleLock) {
      await prove();
      const lock=path.join(this.root,lockName);
      let stat;
      try {stat=await lstat(lock);} catch(error) {if(error.code!=='ENOENT')throw error;}
      if(stat) {
        if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('STORAGE_UNSAFE_PATH');
        await prove();
        const current=await lstat(lock);
        if(current.dev!==stat.dev||current.ino!==stat.ino)throw fail('STORAGE_LOCK_LOST');
        await rm(lock,{recursive:true});
      }
    }
    return this.locked(async()=>{
      const staleReservations=[],reservationsByPending=new Map();
      for(const name of await entries(path.join(this.root,ledgerName),0,{count:0})) {
        if(!/^[a-f0-9-]+\.json$/.test(name))throw fail('STORAGE_ACCOUNTING_FAILED');
        const filename=path.join(this.root,ledgerName,name);
        let reservation;
        try {reservation=JSON.parse(await readFile(filename,'utf8'));} catch {throw fail('STORAGE_ACCOUNTING_FAILED');}
        if(!safeBytes(reservation.diskBytes)||!safeBytes(reservation.tempBytes)||!safeBytes(reservation.createdAt)||!safeName(reservation.pendingName)||!validPurpose(reservation)||reservationsByPending.has(reservation.pendingName))throw fail('STORAGE_ACCOUNTING_FAILED');
        if(Date.now()-reservation.createdAt<minAgeMs)throw fail('STORAGE_MAINTENANCE_GUARD');
        reservationsByPending.set(reservation.pendingName,{name,reservation});
      }
      const retained=new Set(retainedNames),now=Date.now(),candidates=[],readinessCandidates=[],scan={count:0};
      for(const name of await entries(this.root,0,scan)) {
        if(name===ledgerName||name===lockName||retained.has(name))continue;
        // Unknown files are preserved and block deletion until separately audited.
        if(!safeName(name))continue;
        const filename=path.join(this.root,name);
        // Account V2 storage, but preserve all such artifacts until the versioned
        // enrollment reference resolver and orphan validator are integrated.
        if(/^atr14-v2-[a-f0-9]{64}$/.test(name))continue;
        const owned=reservationsByPending.get(name);
        if(owned?.reservation.purpose===READINESS_PURPOSE){
          const stat=await lstat(filename);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||now-stat.mtimeMs<minAgeMs)continue;
          candidates.push({name,bytes:stat.size});
          readinessCandidates.push({name,recordName:owned.name,identity:stat});
          continue;
        }
        if(now-await newestMtime(filename,1,scan)<minAgeMs)continue;
        if(/^[a-f0-9]{64}$/.test(name)) {
          let bytes;
          try {
            const manifestFile=path.join(filename,'manifest.json');
            const stat=await lstat(manifestFile);
            if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)continue;
            bytes=await readFile(manifestFile);
          } catch {continue;}
          if(createHash('sha256').update(bytes).digest('hex')!==name)continue;
          try {
            const manifest=JSON.parse(bytes);
            const expected=new Set(['manifest.json',...manifest.chunks.map(chunk=>chunk.file)]);
            const actual=await entries(filename,1,scan);
            if(actual.length!==expected.size||actual.some(file=>!expected.has(file)))continue;
            const store=new DatasetStore({root:this.root});
            const reference={dataset_id:name,sha256:name,metadata:manifest.metadata};
            for await(const ignored of store.read(reference)){void ignored;}
          } catch {continue;}
        } else if(/^atr14-[a-f0-9]{64}\.json$/.test(name)) {
          let bytes;
          try {
            const stat=await lstat(filename);
            if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)continue;
            bytes=await readFile(filename);
          } catch {continue;}
          if(createHash('sha256').update(bytes).digest('hex')!==name.slice(6,-5))continue;
        } else if(/^\.pending-atr14-[a-f0-9-]+\.json$/.test(name)) {
          const stat=await lstat(filename);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)continue;
        } else if(/^\.pending-[a-f0-9-]+$/.test(name)) {
          const stat=await lstat(filename);
          if(!stat.isDirectory()||stat.isSymbolicLink())continue;
          const files=await entries(filename,1,scan);
          if(files.some(file=>file!=='manifest.json'&&!/^chunk-\d{5}\.jsonl$/.test(file)))continue;
          let safe=true;
          for(const file of files){const item=await lstat(path.join(filename,file));if(!item.isFile()||item.isSymbolicLink()){safe=false;break;}}
          if(!safe)continue;
        } else continue;
        candidates.push({name,bytes:await sizeOf(filename,1,scan)});
      }
      for(const {name,reservation} of reservationsByPending.values()){
        if(reservation.purpose!==READINESS_PURPOSE){
          // Legacy regular pending files lack durable type proof. Keep their ledger record for audit.
          if(/^\.pending-[a-f0-9-]+$/.test(reservation.pendingName)){
            try {const stat=await lstat(path.join(this.root,reservation.pendingName));if(!stat.isDirectory()||stat.isSymbolicLink())continue;}
            catch(error){if(error.code!=='ENOENT')throw error;}
          }
          staleReservations.push(name);
          continue;
        }
        if(readinessCandidates.some(item=>item.recordName===name))continue;
        if(retained.has(reservation.pendingName))continue;
        try {await lstat(path.join(this.root,reservation.pendingName));}
        catch(error){if(error.code==='ENOENT'){staleReservations.push(name);continue;}throw error;}
      }
      if(apply) {
        for(const item of readinessCandidates){
          await prove();
          const current=await lstat(path.join(this.root,item.name));
          if(!current.isFile()||current.isSymbolicLink()||current.size!==item.identity.size||current.dev!==item.identity.dev||current.ino!==item.identity.ino||current.mtimeMs!==item.identity.mtimeMs)throw fail('STORAGE_UNSAFE_PATH');
          await unlink(path.join(this.root,item.name));
          await prove();
          await rm(path.join(this.root,ledgerName,item.recordName));
        }
        for(const name of staleReservations){await prove();await rm(path.join(this.root,ledgerName,name));}
        const readinessNames=new Set(readinessCandidates.map(item=>item.name));
        for(const item of candidates){if(readinessNames.has(item.name))continue;await prove();await rm(path.join(this.root,item.name),{recursive:true});}
      }
      return {applied:apply,staleReservations:staleReservations.length+readinessCandidates.length,candidates};
    });
  }
}
