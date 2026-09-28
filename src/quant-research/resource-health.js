import os from 'node:os';
import {statfs} from 'node:fs/promises';
import path from 'node:path';
import {readCurrentCgroupIo,validateIoControls} from './io-controls.js';

const fail=code=>Object.assign(new Error(code),{code});
const required=['maxDbMs','maxApiMs','maxQueueAgeMs','maxQueueDepth','minMemoryBytes','minDiskBytes','maxLoad1','maxDiskUsedFraction'];
export function validateHealthLimits(limits) {
  if(!limits||Object.keys(limits).length!==required.length||required.some(key=>!Object.hasOwn(limits,key)||
    typeof limits[key]!=='number'||!Number.isFinite(limits[key])||limits[key]<=0)||limits.maxDiskUsedFraction>=1)throw fail('QUANT_HEALTH_LIMITS_REQUIRED');
  return Object.freeze({...limits});
}

export function loopbackHealthProbe(url,{fetcher=fetch}={}) {
  const target=new URL(url);
  if(target.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(target.hostname)||target.pathname!=='/healthz'||target.username||target.password||target.search||target.hash)throw fail('INVALID_QUANT_HEALTH_ENDPOINT');
  return async()=>{
    const response=await fetcher(target,{redirect:'error',signal:AbortSignal.timeout(2000)});
    const reader=response.body?.getReader();if(!reader)return {ok:false};
    let bytes=0,parts=[];
    try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>4096)throw fail('HEALTH_RESPONSE_TOO_LARGE');parts.push(chunk.value);}}
    finally{await reader.cancel();}
    const value=JSON.parse(Buffer.concat(parts).toString());
    return {ok:response.ok&&value.ok===true&&value.mode==='PAPER_ONLY'};
  };
}

/** Fail closed unless current local host, DB, Paper queue and Web/API all pass.
 * Limits are reviewed operator inputs, never inferred or relaxed automatically.
 */
export function createResourceHealth({db,tradingDb=db,probe,limits,storageRoot,clock=Date.now,sample,ioControls,ioSample,ioIdentity}={}) {
  const bounds=validateHealthLimits(limits);
  const ioBounds=ioControls===undefined?null:validateIoControls(ioControls);
  if(ioSample&&!ioBounds)throw fail('QUANT_IO_CONTROLS_REQUIRED');
  if(!db?.query||!tradingDb?.query||typeof probe!=='function'||typeof storageRoot!=='string'||!path.isAbsolute(storageRoot))throw fail('QUANT_HEALTH_CONFIGURATION_REQUIRED');
  const readHost=sample??(async()=>{
    if(process.platform!=='linux')throw fail('QUANT_OS_ISOLATION_REQUIRED');
    const disk=await statfs(storageRoot);
    return {availableMemory:os.freemem(),freeDisk:disk.bavail*disk.bsize,totalDisk:disk.blocks*disk.bsize,load1:os.loadavg()[0]};
  });
  const readIo=ioBounds?(ioSample??(()=>readCurrentCgroupIo(ioBounds))):null;
  let previousIo=null;
  return async()=>{
    try{
      let began=clock();
      if(tradingDb!==db)await db.query('SELECT 1');
      const {rows:[queue]}=await tradingDb.query("SELECT count(*)::int depth,min(received_at) oldest FROM signals WHERE status IN ('QUEUED','PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN')");
      const dbMs=clock()-began;
      began=clock();const api=await probe();const apiMs=clock()-began;
      const host=await readHost(),now=clock();
      const io=readIo?await readIo():null;
      if(readIo){
        if(!io||typeof io.group!=='string'||!io.group.startsWith('/')||
          !Number.isSafeInteger(io.inode)||io.inode<=0||
          !Number.isSafeInteger(io.readBytes)||io.readBytes<0||
          !Number.isSafeInteger(io.writeBytes)||io.writeBytes<0||
          (ioIdentity&&(ioIdentity.group!==io.group||ioIdentity.inode!==io.inode))||
          (previousIo&&(previousIo.group!==io.group||previousIo.inode!==io.inode||io.readBytes<previousIo.readBytes||io.writeBytes<previousIo.writeBytes)))
          return {ok:false,reason:'UNKNOWN_IO'};
        previousIo=io;
      }
      if(!host||['availableMemory','freeDisk','totalDisk','load1'].some(key=>typeof host[key]!=='number'||!Number.isFinite(host[key]))||
        !Number.isSafeInteger(queue.depth)||queue.depth<0||(queue.depth>0&&!Number.isSafeInteger(queue.oldest))||
        (queue.oldest!==null&&(!Number.isSafeInteger(queue.oldest)||queue.oldest<0))||
        host.freeDisk<0||host.totalDisk<=0||host.freeDisk>host.totalDisk||host.availableMemory<0||host.load1<0||
        dbMs<0||apiMs<0||!Number.isSafeInteger(now)||(queue.oldest!==null&&queue.oldest>now))return {ok:false,reason:'UNKNOWN_HEALTH'};
      const queueAgeMs=queue.oldest===null?0:now-queue.oldest;
      const reasons=[];
      if(api?.ok!==true||apiMs>bounds.maxApiMs)reasons.push('API_UNHEALTHY');
      if(dbMs>bounds.maxDbMs)reasons.push('DATABASE_PRESSURE');
      if(queue.depth>bounds.maxQueueDepth||queueAgeMs>bounds.maxQueueAgeMs)reasons.push('TRADING_QUEUE_PRESSURE');
      if(host.availableMemory<bounds.minMemoryBytes)reasons.push('MEMORY_PRESSURE');
      if(host.freeDisk<bounds.minDiskBytes||1-host.freeDisk/host.totalDisk>=bounds.maxDiskUsedFraction)reasons.push('DISK_PRESSURE');
      if(host.load1>bounds.maxLoad1)reasons.push('CPU_PRESSURE');
      return {ok:reasons.length===0,reasons,observed_at:now,dbMs,apiMs,queueAgeMs,queueDepth:queue.depth,...host,...(io?{io}: {})};
    }catch(error){return {ok:false,reason:error?.code==='QUANT_IO_TELEMETRY_UNAVAILABLE'?'UNKNOWN_IO':'UNKNOWN_HEALTH'};}
  };
}
