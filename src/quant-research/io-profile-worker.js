/** Fixed internal PROFILE V2 child. No dataset module loads before release. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {readFile,realpath,lstat,stat,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fail=code=>Object.assign(new Error(code),{code});
const digest=value=>createHash('sha256').update(value).digest('hex');
const pending=/^\.pending-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const device=/^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/;
const numeric=value=>/^(?:0|[1-9]\d*)$/.test(value||'');
const numbers=value=>{
  const bits=BigInt(value);
  return `${((bits>>8n)&0xfffn)|((bits>>32n)&~0xfffn)}:${(bits&0xffn)|((bits>>12n)&~0xffn)}`;
};
function fields(source,deviceId){
  const rows=source.trim().split(/\n/).map(line=>line.trim().split(/\s+/)).filter(row=>row[0]===deviceId);
  if(rows.length!==1)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  const values={};
  for(const token of rows[0].slice(1)){
    const [key,value,...extra]=token.split('=');
    if(!key||!value||extra.length||Object.hasOwn(values,key))throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    values[key]=value;
  }
  return values;
}
export async function prepareProfileIo({environment=process.env,reader=readFile,statter=stat,
  linkstat=lstat,resolver=realpath,opener=open,now=Date.now,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const filename=environment.QUANT_IO_READY_FILE,deviceId=environment.QUANT_IO_READY_DEVICE;
  const rbps=environment.QUANT_IO_READY_RBPS,wbps=environment.QUANT_IO_READY_WBPS;
  if(typeof filename!=='string'||!path.isAbsolute(filename)||!pending.test(path.basename(filename))||
    !device.test(deviceId||'')||!numeric(rbps)||!numeric(wbps)||Number(rbps)<1024||Number(wbps)<1024)
    throw fail('QUANT_IO_READINESS_CONFIGURATION_REQUIRED');
  const root=path.dirname(filename),rootIdentity=await linkstat(root);
  if(!rootIdentity.isDirectory()||rootIdentity.isSymbolicLink())throw fail('QUANT_IO_READINESS_CONFIGURATION_REQUIRED');
  const actual=await resolver(`/sys/dev/block/${numbers(rootIdentity.dev)}`);
  const approved=await resolver(`/sys/dev/block/${deviceId}`);
  if(actual!==approved&&!actual.startsWith(approved+'/'))throw fail('QUANT_IO_STORAGE_DEVICE_MISMATCH');
  const groups=(await reader('/proc/self/cgroup','utf8')).trim().split(/\n/).filter(line=>line.startsWith('0::'));
  if(groups.length!==1)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  const group=groups[0].slice(3),parts=group.split('/');
  if(!group.startsWith('/')||parts.some((part,index)=>index>0&&(!part||part==='.'||part==='..')))
    throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  const location=path.posix.resolve('/sys/fs/cgroup','.'+group);
  if(!location.startsWith('/sys/fs/cgroup/'))throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  const inode=(await statter(location)).ino,deadline=now()+2000;
  const limits=async()=>{
    if((await statter(location)).ino!==inode)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    const max=fields(await reader(path.posix.join(location,'io.max'),'utf8'),deviceId);
    if(max.rbps!==rbps||max.wbps!==wbps)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
  };
  await limits();
  const file=await opener(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{
    const written=await file.write(Buffer.alloc(4096,0x51));
    if(written.bytesWritten!==4096)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    await file.sync();
  }finally{await file.close();}
  while(now()<deadline){
    await limits();
    let counters;
    try{counters=fields(await reader(path.posix.join(location,'io.stat'),'utf8'),deviceId);}
    catch(error){if(error.code!=='QUANT_IO_TELEMETRY_UNAVAILABLE')throw error;}
    if(counters&&numeric(counters.rbytes)&&numeric(counters.wbytes)&&now()<deadline)return;
    await delay(25);
  }
  throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
}

export async function runProfilePayload(payloadText,{builder,storeFactory,write=chunk=>new Promise((resolve,reject)=>
  process.stdout.write(chunk,error=>error?reject(error):resolve())),now=Date.now}={}){
  if(typeof payloadText!=='string'||Buffer.byteLength(payloadText)>65536)throw fail('QUANT_PROFILE_PAYLOAD_INVALID');
  const payload=JSON.parse(payloadText);
  if(payload?.version!=='profile-v2-provisional'||payload.policy?.environment!=='staging'||
    !/^[a-f0-9-]{36}$/.test(payload.jobId)||
    typeof payload.operationId!=='string'||!payload.contract||!payload.policy||!payload.storage)
    throw fail('QUANT_PROFILE_PAYLOAD_INVALID');
  const payloadHash=digest(payloadText);
  await write(`QUANT_PROFILE_ACCEPTED_V2 ${payloadHash}\n`);
  const {buildProfileV2}=builder?{buildProfileV2:builder}:await import('./profile-pipeline-v2.js');
  let stores;
  if(storeFactory)stores=storeFactory(payload.storage);
  else{
    const [{StorageBudget},{ResearchDatasetStore}]=await Promise.all([
      import('./storage-budget.js'),import('./research-dataset-store.js')]);
    const budget=new StorageBudget(payload.storage);
    const researchStore=new ResearchDatasetStore({root:budget.root,storageBudget:budget});
    stores={rawStore:researchStore.raw,researchStore};
  }
  const result=await buildProfileV2({contract:payload.contract,policy:payload.policy,
    rawStore:stores.rawStore,researchStore:stores.researchStore,now});
  const [{canonical,hash},{validateProfileResultV2}]=await Promise.all([
    import('../pine-bridge/source.js'),import('./profile-contract-v2.js')]);
  validateProfileResultV2(payload.contract,result,{policy:payload.policy});
  const serialized=canonical(result);
  if(Buffer.byteLength(serialized)>Math.min(8*1024*1024,payload.contract.budget.max_output_bytes))
    throw fail('FOUNDATION_OUTPUT_TOO_LARGE');
  const frame={jobId:payload.jobId,operationId:payload.operationId,payloadHash,
    resultHash:hash(serialized),result};
  await write(canonical(frame)+'\n');
  return frame;
}

async function main(){
  await prepareProfileIo();
  let data='',bytes=0;
  for await(const chunk of process.stdin){
    bytes+=chunk.length;
    if(bytes>65536+1)throw fail('QUANT_PROFILE_PAYLOAD_INVALID');
    data+=chunk.toString('utf8');
  }
  if(!data.endsWith('\n')||data.indexOf('\n')!==data.length-1)
    throw fail('QUANT_PROFILE_PAYLOAD_INVALID');
  await runProfilePayload(data.slice(0,-1));
  setInterval(()=>{},1000);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{process.stderr.write(`${error?.code||'QUANT_PROFILE_WORKER_FAILED'}\n`);process.exitCode=1;});
