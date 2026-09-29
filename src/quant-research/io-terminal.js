import {canonical,hash} from '../pine-bridge/source.js';

const fail=code=>Object.assign(new Error(code),{code});
const unavailable=()=>fail('QUANT_IO_TELEMETRY_UNAVAILABLE');

/** One bounded newline JSON frame. Any bytes after its terminator invalidate it. */
export class TerminalFrame {
  constructor(limit=2*1024*1024){this.limit=limit;this.bytes=Buffer.alloc(0);this.result=null;this.complete=false;this.invalid=false;}
  push(chunk){
    if(this.invalid)return null;
    if(this.complete){this.invalid=true;throw fail('INVALID_EVALUATION_RESPONSE');}
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    if(this.bytes.length+data.length>this.limit+1){this.invalid=true;throw fail('EVALUATION_OUTPUT_TOO_LARGE');}
    this.bytes=Buffer.concat([this.bytes,data]);
    const end=this.bytes.indexOf(10);
    if(end<0)return null;
    if(end!==this.bytes.length-1||end===0||end>this.limit){this.invalid=true;throw fail('INVALID_EVALUATION_RESPONSE');}
    let parsed;
    try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.bytes.subarray(0,end)));}
    catch{this.invalid=true;throw fail('INVALID_EVALUATION_RESPONSE');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length!==2||
      !Object.hasOwn(parsed,'checkpoint')||!Object.hasOwn(parsed,'result')||Object.hasOwn(parsed,'error')){
      this.invalid=true;throw fail('INVALID_EVALUATION_RESPONSE');
    }
    this.result=parsed;this.complete=true;this.bytes=Buffer.alloc(0);
    return parsed;
  }
}

/** Final readback while child remains alive. All checks fail closed. */
export async function verifyTerminalIo({group,getIdentity,pending,readLimits,readCounters,live}){
  try{
    if(pending)await pending;
    if(!live())throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    const identity=getIdentity();
    if(!identity||!Number.isSafeInteger(identity.inode)||!Number.isSafeInteger(identity.readBytes)||
      !Number.isSafeInteger(identity.writeBytes))throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    const limits=await readLimits(group);
    if(!live()||limits.inode!==identity.inode)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    const counters=await readCounters(group);
    if(!live()||counters.inode!==identity.inode||counters.readBytes<identity.readBytes||
      counters.writeBytes<identity.writeBytes)throw fail('QUANT_IO_TELEMETRY_UNAVAILABLE');
    return counters;
  }catch(error){
    if(error.code==='QUANT_IO_TELEMETRY_UNAVAILABLE')throw error;
    throw Object.assign(fail('QUANT_IO_TELEMETRY_UNAVAILABLE'),{ioDiagnostic:error.ioDiagnostic});
  }
}

/** FTR-1 frozen terminal readback helpers. Pure; every rejection fails closed. */
export const FROZEN_TERMINAL_VERSION='quant-io-frozen-terminal-v1';
export const DEFAULT_MAX_SECTORS_KB=1280;
export const MIN_QUIESCENCE_MS=250;
export const POST_EXIT_MEASURED=Object.freeze(['REMOVED','RETAINED_EQUAL']);
const isCount=value=>Number.isSafeInteger(value)&&value>=0;
const isPositive=value=>Number.isSafeInteger(value)&&value>0;
const decimal=/^(?:0|[1-9]\d*)$/;

/** cgroup.events: every non-empty line is exactly "key 0|1"; keys unique; populated and frozen required. */
export function parseCgroupEvents(source){
  if(typeof source!=='string')throw unavailable();
  const seen=new Map();
  for(const line of source.split('\n')){
    if(line==='')continue;
    const match=/^([a-z_]+) ([01])$/.exec(line);
    if(!match||seen.has(match[1]))throw unavailable();
    seen.set(match[1],Number(match[2]));
  }
  if(!seen.has('populated')||!seen.has('frozen'))throw unavailable();
  return {populated:seen.get('populated'),frozen:seen.get('frozen')};
}

/** Accepts only a populated cgroup whose tasks all reached the freezer trap. */
export function inspectCgroupFrozen(source){
  const events=parseCgroupEvents(source);
  if(events.frozen!==1||events.populated!==1)throw unavailable();
  return events;
}

/** memory.stat: exactly one decimal file_dirty and one file_writeback row. Values may be nonzero. */
export function parseMemoryWriteback(source){
  if(typeof source!=='string')throw unavailable();
  const found={file_dirty:[],file_writeback:[]};
  for(const line of source.split('\n')){
    const [name,...rest]=line.trim().split(/\s+/);
    if(Object.hasOwn(found,name)){
      if(rest.length!==1||!decimal.test(rest[0]))throw unavailable();
      const value=Number(rest[0]);
      if(!Number.isSafeInteger(value))throw unavailable();
      found[name].push(value);
    }
  }
  if(found.file_dirty.length!==1||found.file_writeback.length!==1)throw unavailable();
  return {fileDirty:found.file_dirty[0],fileWriteback:found.file_writeback[0]};
}

/** memory.stat must prove no page cache is dirty or under writeback for the unit. */
export function inspectMemoryWriteback(source){
  const {fileDirty,fileWriteback}=parseMemoryWriteback(source);
  if(fileDirty!==0||fileWriteback!==0)throw unavailable();
  return {fileDirty:0,fileWriteback:0};
}

/** FTR-1b frozen drain. Poll while frozen until page cache is clean and DRAIN_SETTLE_MS have passed.
 * DRAIN_SETTLE_MS = jbd2 commit 5,000 + memcg stat flush 2,000 + 500 margin. STAT_FRESH_MS is the
 * minimum age of the final stable read after freeze. MAX_DRAIN_MS caps the launcher option.
 */
export const DRAIN_SETTLE_MS=7500;
export const DRAIN_POLL_MS=500;
export const MAX_DRAIN_MS=45000;
export const STAT_FRESH_MS=2500;
export const TERMINAL_DIAGNOSTIC_VERSION='quant-io-terminal-diagnostic-v1';
const SERIES_EDGE=16;
const wholeMs=value=>Number.isFinite(value)?Math.max(0,Math.round(value)):0;

/** Bounded drain sample recorder. Keeps the first and last SERIES_EDGE points, so 32 at most. */
export function createDrainRecorder(){
  const head=[],tail=[];
  const state={polls:0,maxDirty:0,maxWriteback:0,firstZeroMs:null};
  return {
    record(ms,fileDirty,fileWriteback){
      if(!isCount(fileDirty)||!isCount(fileWriteback))throw unavailable();
      const at=wholeMs(ms);
      state.polls+=1;
      state.maxDirty=Math.max(state.maxDirty,fileDirty);
      state.maxWriteback=Math.max(state.maxWriteback,fileWriteback);
      if(state.firstZeroMs===null&&fileDirty===0&&fileWriteback===0)state.firstZeroMs=at;
      (head.length<SERIES_EDGE?head:tail).push([at,fileDirty,fileWriteback]);
      if(tail.length>SERIES_EDGE)tail.shift();
    },
    snapshot(){return {...state,series:[...head,...tail]};}
  };
}

/** Fallback-only evidence. Integers, booleans and fixed enum strings only. Never digested or stored in SQL. */
export function buildTerminalDiagnostic({stage,fileDirty=null,fileWriteback=null,memoryReads=0,sinceFreezeMs=0,
  drain={}}={}){
  const count=value=>isCount(value)?value:null;
  const series=(Array.isArray(drain.series)?drain.series:[]).slice(0,2*SERIES_EDGE).map(point=>
    Object.freeze([0,1,2].map(index=>count(Array.isArray(point)?point[index]:null)??0)));
  return Object.freeze({version:TERMINAL_DIAGNOSTIC_VERSION,stage:stage==='QUIESCENCE'?'QUIESCENCE':'DRAIN',
    fileDirty:count(fileDirty),fileWriteback:count(fileWriteback),
    memoryReads:count(memoryReads)??0,sinceFreezeMs:wholeMs(sinceFreezeMs),
    drain:Object.freeze({enabled:drain.enabled!==false,durationMs:wholeMs(drain.durationMs),
      polls:count(drain.polls)??0,maxDirty:count(drain.maxDirty)??0,maxWriteback:count(drain.maxWriteback)??0,
      firstZeroMs:count(drain.firstZeroMs),series:Object.freeze(series)})});
}

/** W = max(250 ms, ceil(maxBioBytes / min(rbps,wbps))). Fallback bio size is 1,280 KiB. */
export function quiescenceWindowMs({maxSectorsKb,rates,budgetMs}={}){
  const kilobytes=maxSectorsKb===undefined||maxSectorsKb===null?DEFAULT_MAX_SECTORS_KB:maxSectorsKb;
  if(!Number.isSafeInteger(kilobytes)||kilobytes<1||kilobytes>1048576||!rates||
    !isPositive(rates.readBytesPerSecond)||!isPositive(rates.writeBytesPerSecond)||
    typeof budgetMs!=='number'||!Number.isFinite(budgetMs)||budgetMs<0)throw unavailable();
  const maxBioBytes=kilobytes*1024;
  const windowMs=Math.max(MIN_QUIESCENCE_MS,
    Math.ceil(maxBioBytes*1000/Math.min(rates.readBytesPerSecond,rates.writeBytesPerSecond)));
  return {windowMs,maxBioBytes,overBudget:windowMs>budgetMs};
}

const sameCounters=(a,b)=>a.inode===b.inode&&a.readBytes===b.readBytes&&a.writeBytes===b.writeBytes;
function cleanRead(value){
  if(!value||typeof value!=='object'||typeof value.atMs!=='number'||!Number.isFinite(value.atMs)||
    !isPositive(value.inode)||!isCount(value.readBytes)||!isCount(value.writeBytes))throw unavailable();
  return {atMs:value.atMs,inode:value.inode,readBytes:value.readBytes,writeBytes:value.writeBytes};
}

/** Two identical reads at least windowMs apart while frozen. `last` is the last accepted sample.
 * Returns {stable:true,first,second}, or {stable:false,nextReadAtMs} while another window still fits
 * before deadlineMs. Regression, inode change, or instability without time left throw.
 */
export function evaluateQuiescence({reads,windowMs,last=null,deadlineMs=null}={}){
  if(!Array.isArray(reads)||reads.length===0||!isPositive(windowMs)||
    deadlineMs!==null&&(typeof deadlineMs!=='number'||!Number.isFinite(deadlineMs)))throw unavailable();
  const clean=reads.map(cleanRead);
  if(last!==null&&(!last||typeof last!=='object'||!isCount(last.readBytes)||!isCount(last.writeBytes)||
    last.inode!==undefined&&!isPositive(last.inode)))throw unavailable();
  clean.forEach((read,index)=>{
    const previous=clean[index-1];
    if(previous&&(read.atMs<previous.atMs||read.inode!==previous.inode||
      read.readBytes<previous.readBytes||read.writeBytes<previous.writeBytes))throw unavailable();
    if(last&&(read.readBytes<last.readBytes||read.writeBytes<last.writeBytes||
      last.inode!==undefined&&read.inode!==last.inode))throw unavailable();
  });
  let start=clean.length-1;
  while(start>0&&sameCounters(clean[start-1],clean[start]))start--;
  const first=clean[start],second=clean[clean.length-1];
  if(clean.length>start+1&&second.atMs-first.atMs>=windowMs)return {stable:true,first,second};
  const nextReadAtMs=first.atMs+windowMs;
  if(deadlineMs!==null&&nextReadAtMs<=deadlineMs)return {stable:false,nextReadAtMs};
  throw unavailable();
}

/** Post-exit cgroup disposition. Only REMOVED and RETAINED_EQUAL keep a measured charge. */
export function reconcilePostExit({frozen,read}={}){
  if(!frozen||!isPositive(frozen.inode)||!isCount(frozen.readBytes)||!isCount(frozen.writeBytes))throw unavailable();
  if(read?.error!==undefined)return ['ENOENT','ENODEV'].includes(read.error?.code)?'REMOVED':'UNKNOWN';
  if(!read||read.populated!==0||!isPositive(read.inode)||read.inode!==frozen.inode||
    !isCount(read.readBytes)||!isCount(read.writeBytes)||
    read.readBytes<frozen.readBytes||read.writeBytes<frozen.writeBytes)return 'UNKNOWN';
  return read.readBytes===frozen.readBytes&&read.writeBytes===frozen.writeBytes?'RETAINED_EQUAL':'TAIL_OBSERVED';
}

const DIGEST_KEYS=['jobId','operationId','unitName','group','cgroupInode','invocationId','pid',
  'procStartTicks','deviceId','deviceInode','reads','windowMs','fileDirty','fileWriteback','freezer','postExit'];
const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;

/** Digest of the frozen terminal readback evidence. Exact key set, no extras, no optional fields. */
export function terminalReadbackDigest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw unavailable();
  const own=Reflect.ownKeys(input);
  if(own.length!==DIGEST_KEYS.length||own.some(key=>!DIGEST_KEYS.includes(key)))throw unavailable();
  for(const key of DIGEST_KEYS){
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw unavailable();
  }
  const {reads}=input;
  if(!text(input.jobId)||!text(input.operationId)||!text(input.unitName)||!text(input.group)||
    !isPositive(input.cgroupInode)||typeof input.invocationId!=='string'||!/^[a-f0-9]{32}$/.test(input.invocationId)||
    !isPositive(input.pid)||typeof input.procStartTicks!=='string'||!/^\d+$/.test(input.procStartTicks)||
    typeof input.deviceId!=='string'||!/^\d+:\d+$/.test(input.deviceId)||
    !isPositive(input.deviceInode)||!Array.isArray(reads)||reads.length!==2||
    !Number.isSafeInteger(input.windowMs)||input.windowMs<MIN_QUIESCENCE_MS||
    input.fileDirty!==0||input.fileWriteback!==0||input.freezer!=='frozen'||
    !POST_EXIT_MEASURED.includes(input.postExit))throw unavailable();
  const cleaned=reads.map(read=>{
    if(!read||typeof read!=='object'||Array.isArray(read)||Reflect.ownKeys(read).length!==2||
      !Object.hasOwn(read,'readBytes')||!Object.hasOwn(read,'writeBytes')||
      !isCount(read.readBytes)||!isCount(read.writeBytes))throw unavailable();
    return {readBytes:read.readBytes,writeBytes:read.writeBytes};
  });
  if(canonical(cleaned[0])!==canonical(cleaned[1]))throw unavailable();
  return hash(canonical({version:FROZEN_TERMINAL_VERSION,...Object.fromEntries(DIGEST_KEYS.map(key=>
    [key,key==='reads'?cleaned:input[key]]))}));
}
