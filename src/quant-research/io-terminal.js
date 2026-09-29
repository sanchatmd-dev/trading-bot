const fail=code=>Object.assign(new Error(code),{code});

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
