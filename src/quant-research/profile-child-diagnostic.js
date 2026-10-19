// Observation only. Fixed child readiness/payload and tested pipeline/store errors.
export const STDERR_CODE_ALLOWLIST=Object.freeze(['QUANT_IO_TELEMETRY_UNAVAILABLE',
 'QUANT_IO_READINESS_CONFIGURATION_REQUIRED','QUANT_IO_STORAGE_DEVICE_MISMATCH',
 'QUANT_PROFILE_PAYLOAD_INVALID','FOUNDATION_OUTPUT_TOO_LARGE','QUANT_PROFILE_WORKER_FAILED',
 'PROFILE_OPEN_BAR','PROFILE_RAW_UNSUPPORTED','DATASET_CANCELLED','INVALID_RESEARCH_SIDECAR',
 'RESEARCH_SIDECAR_HASH_MISMATCH']);
export const STDERR_CAPTURE_LIMIT=4096;
const codeBytes=STDERR_CODE_ALLOWLIST.map(code=>Buffer.from(code,'ascii'));
const signals=new Set(['SIGABRT','SIGALRM','SIGBUS','SIGFPE','SIGHUP','SIGILL','SIGINT','SIGKILL',
 'SIGPIPE','SIGQUIT','SIGSEGV','SIGTERM','SIGTRAP','SIGUSR1','SIGUSR2','SIGXCPU','SIGXFSZ','SIGBREAK']);

/** Append after an existing stderr consumer; never changes stdout, stream mode or process control.
 * Match bytes against finite known tokens without retaining input text, buffers, paths or messages.
 * Exactly one complete LF/CRLF line is required. Additional bytes/lines or overflow produce UNKNOWN.
 */
export function observeLauncherStderr(child){
 if(!child?.stderr?.on||typeof child.stderr.listenerCount!=='function'||!child.stderr.listenerCount('data')||
  typeof child.on!=='function')throw new Error('OBSERVER_REQUIRES_EXISTING_STDERR_CONSUMER');
 let byteCount=0,byteCountExact=true,parsedBytes=0,truncated=false,invalid=false,closed=false;
 let candidates=codeBytes.map((_,index)=>index),offset=0,carriageReturn=false,lineComplete=false,code='UNKNOWN';
 let exitStatus=null,exitStatusKnown=false,exitSignal=null,exitSignalKnown=false;
 const snapshot=()=>Object.freeze({version:PROFILE_CHILD_DIAGNOSTIC_VERSION,code:!closed||truncated||invalid||!lineComplete?'UNKNOWN':code,
  byteCount,byteCountExact,truncated,closeObserved:closed,exitStatus,exitStatusKnown,exitSignal,exitSignalKnown,
  exitScope:'LAUNCHER_PROCESS',childKernelStatusKnown:false});
 const acceptByte=byte=>{
  if(invalid)return;
  if(lineComplete){invalid=true;return;}
  if(byte===10){
   const match=candidates.find(index=>codeBytes[index].length===offset);
   lineComplete=true;code=match===undefined?'UNKNOWN':STDERR_CODE_ALLOWLIST[match];
   if(match===undefined)invalid=true;
   return;
  }
  if(carriageReturn){invalid=true;return;}
  if(byte===13){carriageReturn=true;return;}
  candidates=candidates.filter(index=>codeBytes[index][offset]===byte);offset++;
  if(!candidates.length)invalid=true;
 };
 const onData=chunk=>{
  if(closed)return;
  const isText=typeof chunk==='string',isBytes=chunk instanceof Uint8Array;
  if(!isText&&!isBytes){invalid=true;return;}
  const length=isText?Buffer.byteLength(chunk):chunk.byteLength;
  if(length>Number.MAX_SAFE_INTEGER-byteCount){byteCount=Number.MAX_SAFE_INTEGER;byteCountExact=false;}
  else byteCount+=length;
  const inspect=Math.min(length,STDERR_CAPTURE_LIMIT-parsedBytes);
  if(inspect<length)truncated=true;
  // Non-ASCII text cannot match any code. Do not encode/copy arbitrary text into retained buffers.
  if(isText){
   for(let i=0;i<inspect;i++){
    const byte=chunk.charCodeAt(i);
    if(byte>127||Number.isNaN(byte)){invalid=true;break;}
    acceptByte(byte);
   }
  }else for(let i=0;i<inspect;i++)acceptByte(chunk[i]);
  parsedBytes+=inspect;
 };
 const onClose=(status,signal)=>{
  if(closed)return;
  closed=true;
  exitStatusKnown=Number.isSafeInteger(status)&&status>=0&&status<=0xffffffff;
  exitStatus=exitStatusKnown?status:null;
  exitSignalKnown=signal===null||signals.has(signal);
  exitSignal=signals.has(signal)?signal:null;
  child.stderr.removeListener('data',onData);
  child.removeListener('close',onClose);
 };
 child.stderr.on('data',onData);
 child.on('close',onClose);
 return Object.freeze({snapshot});
}


export const PROFILE_CHILD_DIAGNOSTIC_VERSION='profile-child-diagnostic-v1';

/** Rebuild fixed safe metadata. Untrusted callback fields never enter worker logs. */
export function sanitizeProfileChildDiagnostic(value){
 const safe={version:PROFILE_CHILD_DIAGNOSTIC_VERSION,code:'UNKNOWN',byteCount:0,byteCountExact:false,
  truncated:false,closeObserved:false,exitStatus:null,exitStatusKnown:false,exitSignal:null,
  exitSignalKnown:false,exitScope:'LAUNCHER_PROCESS',childKernelStatusKnown:false};
 try{
  if(!value||typeof value!=='object')return Object.freeze(safe);
  // Snapshot each selected own data property once. Accessors never execute during validation or copying.
  const selected=Object.create(null);
  for(const name of ['version','code','byteCount','byteCountExact','truncated','closeObserved',
   'exitStatus','exitStatusKnown','exitSignal','exitSignalKnown']){
   const descriptor=Object.getOwnPropertyDescriptor(value,name);
   if(descriptor&&!Object.hasOwn(descriptor,'value'))return Object.freeze(safe);
   selected[name]=descriptor?.value;
  }
  value=selected;
  if(value?.version!==PROFILE_CHILD_DIAGNOSTIC_VERSION)return Object.freeze(safe);
  for(const name of ['byteCountExact','truncated','closeObserved'])safe[name]=value[name]===true;
  if(Number.isSafeInteger(value.byteCount)&&value.byteCount>=0)safe.byteCount=value.byteCount;
  else safe.byteCountExact=false;
  if(safe.closeObserved&&!safe.truncated&&safe.byteCountExact&&STDERR_CODE_ALLOWLIST.includes(value.code))safe.code=value.code;
  if(safe.closeObserved&&value.exitStatusKnown===true&&Number.isSafeInteger(value.exitStatus)&&value.exitStatus>=0&&value.exitStatus<=0xffffffff){
   safe.exitStatus=value.exitStatus;safe.exitStatusKnown=true;
  }
  if(safe.closeObserved&&value.exitSignalKnown===true&&(value.exitSignal===null||signals.has(value.exitSignal))){
   safe.exitSignal=value.exitSignal;safe.exitSignalKnown=true;
  }
 }catch{return Object.freeze({...safe,code:'UNKNOWN'});}
 return Object.freeze(safe);
}
