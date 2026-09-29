import path from 'node:path';
import {readFile,stat,realpath,open,lstat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
const filesystemMarkers=new Set(['EACCES','EPERM','ENOENT','EIO','ENOTDIR','ESTALE','ELOOP','EBUSY','EMFILE','ENFILE']);
const ioFail=(phase,cause,error)=>Object.assign(fail('QUANT_IO_TELEMETRY_UNAVAILABLE'),{
  ioDiagnostic:{phase,cause,...(filesystemMarkers.has(error?.code)?{filesystem_marker:error.code}:{})}
});
const cgroupRoot='/sys/fs/cgroup';
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

/** Operator-reviewed, versioned limits. Bytes are physical cgroup I/O, not logical file bytes. */
export function validateIoControls(value){
  const keys=['version','device','devicePath','main','evaluator'];
  const validRate=limits=>exactKeys(limits,['readBytesPerSecond','writeBytesPerSecond'])&&
    Object.values(limits).every(rate=>Number.isSafeInteger(rate)&&rate>=1024&&rate<=1024*1024*1024);
  if(!exactKeys(value,keys)||value.version!=='quant-io-v1'||
    !/^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/.test(value.device)||
    !path.posix.isAbsolute(value.devicePath)||value.devicePath.includes('\0')||
    !validRate(value.main)||!validRate(value.evaluator))throw fail('QUANT_IO_CONTROLS_REQUIRED');
  return Object.freeze({...value,main:Object.freeze({...value.main}),evaluator:Object.freeze({...value.evaluator})});
}

function deviceLine(source,device){
  if(typeof source!=='string')return null;
  const rows=source.trim().split(/\n/).map(line=>line.trim()).filter(Boolean);
  const matches=rows.filter(line=>line.split(/\s+/)[0]===device);
  return matches.length===1?matches[0]:null;
}
function field(line,key){
  const matches=[...line.matchAll(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`,'g'))];
  if(matches.length!==1||!/^(?:0|[1-9]\d*)$/.test(matches[0][1]))return null;
  const value=Number(matches[0][1]);
  return Number.isSafeInteger(value)?value:null;
}

/** Empty io.stat, unlimited or mismatched io.max, and malformed counters are unknown. */
export function inspectCgroupIo({max,stat,device,limits}){
  const maxLine=deviceLine(max,device),statLine=deviceLine(stat,device);
  if(!maxLine||field(maxLine,'rbps')!==limits.readBytesPerSecond||
    field(maxLine,'wbps')!==limits.writeBytesPerSecond)throw ioFail('limits','limits_mismatch');
  if(!statLine)throw ioFail('counters','counter_row_missing');
  const readBytes=field(statLine,'rbytes'),writeBytes=field(statLine,'wbytes');
  if(readBytes===null||writeBytes===null)throw ioFail('counters','counter_parse');
  return {readBytes,writeBytes};
}

export function inspectCgroupIoLimits({max,device,limits}){
  const line=deviceLine(max,device);
  if(!line||field(line,'rbps')!==limits.readBytesPerSecond||field(line,'wbps')!==limits.writeBytesPerSecond)
    throw ioFail('limits','limits_mismatch');
}

function deviceNumbers(device){
  const value=BigInt(device);
  return `${((value>>8n)&0xfffn)|((value>>32n)&~0xfffn)}:${(value&0xffn)|((value>>12n)&~0xffn)}`;
}

/** A partition is acceptable only when sysfs proves it belongs to the reviewed block device. */
export async function assertIoStorageDevice(root,device,{statter=stat,resolver=realpath}={}){
  try{
    const identity=await Promise.resolve().then(()=>statter(root)).catch(error=>{throw {cause:'filesystem_stat',error};});
    const actual=await Promise.resolve().then(()=>resolver(`/sys/dev/block/${deviceNumbers(identity.dev)}`)).catch(error=>{throw {cause:'filesystem_resolve',error};});
    const approved=await Promise.resolve().then(()=>resolver(`/sys/dev/block/${device}`)).catch(error=>{throw {cause:'filesystem_resolve',error};});
    if(actual!==approved&&!actual.startsWith(approved+'/'))throw {cause:'storage_device_mismatch'};
  }catch(error){
    const cause=['filesystem_stat','filesystem_resolve','storage_device_mismatch'].includes(error?.cause)?error.cause:'storage_identity_invalid';
    const marker=error?.error?.code;
    throw Object.assign(fail('QUANT_IO_STORAGE_DEVICE_MISMATCH'),{
      ioDiagnostic:{phase:'storage',cause,...(filesystemMarkers.has(marker)?{filesystem_marker:marker}:{})}
    });
  }
}

export async function readCgroupIoLimits(group,controls,scope='main',{reader=readFile,statter=stat}={}){
  const approved=validateIoControls(controls);
  if(typeof group!=='string'||!group.startsWith('/')||group.includes('..')||group.includes('\0'))throw ioFail('limits','invalid_group');
  const location=path.posix.resolve(cgroupRoot,'.'+group);
  if(!location.startsWith(cgroupRoot+'/'))throw ioFail('limits','invalid_group');
  try{
    const [max,identity]=await Promise.all([
      Promise.resolve().then(()=>reader(path.posix.join(location,'io.max'),'utf8')).catch(error=>{throw ioFail('limits','filesystem_read',error);}),
      Promise.resolve().then(()=>statter(location)).catch(error=>{throw ioFail('inode','filesystem_stat',error);})]);
    if(!Number.isSafeInteger(identity.ino)||identity.ino<=0)throw ioFail('inode','identity_invalid');
    inspectCgroupIoLimits({max,device:approved.device,limits:approved[scope]});
    return {inode:identity.ino};
  }catch(error){throw error?.ioDiagnostic?error:ioFail('limits','unknown');}
}

export async function currentCgroupGroup({reader=readFile}={}){
  if(process.platform!=='linux')throw fail('QUANT_OS_ISOLATION_REQUIRED');
  const source=await reader('/proc/self/cgroup','utf8');
  const groups=source.trim().split(/\n/).filter(line=>line.startsWith('0::'));
  if(groups.length!==1)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  return groups[0].slice(3);
}

/** Writes one owned, reserved block in this cgroup before requiring actual kernel counters. */
export async function prepareCgroupIo(group,controls,scope,storageBudget,{reader=readFile,statter=stat,
  resolver=realpath,writeSize=4096,pollMs=25,timeoutMs=2000}={}){
  if(!storageBudget||!Number.isSafeInteger(writeSize)||writeSize<4096||writeSize>4096||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>3000)throw fail('QUANT_IO_READINESS_CONFIGURATION_REQUIRED');
  const deadline=Date.now()+timeoutMs;
  const approved=validateIoControls(controls);
  const first=await readCgroupIoLimits(group,approved,scope,{reader,statter});
  await assertIoStorageDevice(storageBudget.root,approved.device,{statter,resolver});
  const pendingName='.pending-'+randomUUID(),filename=path.join(storageBudget.root,pendingName);
  const reservation=await storageBudget.reserve({diskBytes:writeSize,tempBytes:writeSize,pendingName,purpose:'quant-io-readiness-v1'});
  let handle=null,identity=null,result=null,error=null;
  try{
    if(Date.now()>=deadline)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    handle=await open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    identity=await handle.stat();
    await handle.writeFile(Buffer.alloc(writeSize,0x51));
    await handle.sync();
    await handle.close();handle=null;
    while(Date.now()<deadline){
      const limits=await readCgroupIoLimits(group,approved,scope,{reader,statter});
      if(limits.inode!==first.inode)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
      let sample;
      try{sample=await readCgroupIo(group,approved,scope,{reader,statter});}
      catch(e){if(e.code!=='QUANT_IO_TELEMETRY_UNAVAILABLE')throw e;}
      if(sample){
        if(sample.inode!==first.inode||Date.now()>=deadline)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
        result={group,...sample};break;
      }
      await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
    if(!result)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  }catch(e){error=e;
  }finally{
    try{
      if(handle)await handle.close();
      if(identity){
        const current=await lstat(filename);
        if(!current.isFile()||current.isSymbolicLink()||current.ino!==identity.ino||current.dev!==identity.dev)throw fail('QUANT_IO_READINESS_CLEANUP_FAILED');
        await unlink(filename);
      }
      await reservation.release();
    }catch{error=fail('QUANT_IO_READINESS_CLEANUP_FAILED');}
  }
  if(error)throw error;
  if(Date.now()>=deadline)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  return result;
}

export function systemdIoProperties(controls,scope='evaluator'){
  const approved=validateIoControls(controls),limits=approved[scope];
  if(!limits)throw fail('QUANT_IO_CONTROLS_REQUIRED');
  return [`--property=IOAccounting=yes`,
    `--property=IOReadBandwidthMax=${approved.devicePath} ${limits.readBytesPerSecond}`,
    `--property=IOWriteBandwidthMax=${approved.devicePath} ${limits.writeBytesPerSecond}`];
}

export async function readCgroupIo(group,controls,scope='main',{reader=readFile,statter=stat}={}){
  const approved=validateIoControls(controls);
  if(typeof group!=='string'||!group.startsWith('/')||group.includes('..')||group.includes('\0'))throw ioFail('counters','invalid_group');
  const location=path.posix.resolve(cgroupRoot,'.'+group);
  if(!location.startsWith(cgroupRoot+'/'))throw ioFail('counters','invalid_group');
  try{
    const [max,counters,identity]=await Promise.all([
      Promise.resolve().then(()=>reader(path.posix.join(location,'io.max'),'utf8')).catch(error=>{throw ioFail('limits','filesystem_read',error);}),
      Promise.resolve().then(()=>reader(path.posix.join(location,'io.stat'),'utf8')).catch(error=>{throw ioFail('counters','filesystem_read',error);}),
      Promise.resolve().then(()=>statter(location)).catch(error=>{throw ioFail('inode','filesystem_stat',error);})]);
    if(!Number.isSafeInteger(identity.ino)||identity.ino<=0)throw ioFail('inode','identity_invalid');
    return {inode:identity.ino,...inspectCgroupIo({max,stat:counters,device:approved.device,limits:approved[scope]})};
  }catch(error){throw error?.ioDiagnostic?error:ioFail('counters','unknown');}
}

export async function readCurrentCgroupIo(controls,options={}){
  const reader=options.reader??readFile;
  const group=await currentCgroupGroup({reader});
  return {group,...await readCgroupIo(group,controls,'main',{reader,statter:options.statter??stat})};
}
