import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeLauncherStderr,STDERR_CODE_ALLOWLIST,STDERR_CAPTURE_LIMIT,sanitizeProfileChildDiagnostic,
 PROFILE_CHILD_DIAGNOSTIC_VERSION} from '../src/quant-research/profile-child-diagnostic.js';

test('sanitizer rejects varying selected accessors without evaluating or retaining their values',()=>{
 for(const [name,first,privateValue] of [['code','PROFILE_OPEN_BAR','PRIVATE_SENTINEL'],
  ['exitSignal','SIGTERM','PRIVATE_SENTINEL'],['byteCount',17,'PRIVATE_SENTINEL'],
  ['exitStatus',1,'PRIVATE_SENTINEL']]){
  let reads=0;
  const value={version:PROFILE_CHILD_DIAGNOSTIC_VERSION,code:'PROFILE_OPEN_BAR',byteCount:17,
   byteCountExact:true,truncated:false,closeObserved:true,exitStatus:1,exitStatusKnown:true,exitSignal:'SIGTERM',exitSignalKnown:true};
  Object.defineProperty(value,name,{enumerable:true,get(){return ++reads===1?first:privateValue;}});
  const result=sanitizeProfileChildDiagnostic(value);
  assert.equal(result.code,'UNKNOWN',name);assert.equal(reads,0,name);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SENTINEL/);assert.equal(result.childKernelStatusKnown,false);
 }
});

function fixture(){
 const child=new EventEmitter();child.stderr=new EventEmitter();child.stdout=new EventEmitter();
 const originalEvents=[];
 child.stderr.on('data',()=>originalEvents.push('product-data'));
 child.on('close',()=>originalEvents.push('product-close'));
 return {child,originalEvents,observer:observeLauncherStderr(child)};
}
const send=(child,text)=>child.stderr.emit('data',Buffer.from(text));
const finish=async(f,status=1,signal=null)=>{f.child.emit('close',status,signal);return f.observer.snapshot();};

test('fragmented allowlisted LF/CRLF codes preserve original consumers and stdout',async()=>{
 for(const code of STDERR_CODE_ALLOWLIST)for(const newline of ['\n','\r\n']){
  const f=fixture(),stdout=[];f.child.stdout.on('data',value=>stdout.push(value));
  for(const byte of Buffer.from(code+newline))f.child.stderr.emit('data',Buffer.from([byte]));
  f.child.stdout.emit('data','protocol frame');
  const result=await finish(f);
  assert.equal(result.code,code);assert.equal(result.byteCount,Buffer.byteLength(code+newline));
  assert.equal(result.truncated,false);assert.deepEqual(stdout,['protocol frame']);
  assert.equal(f.originalEvents.at(-1),'product-close');
  assert.equal(f.originalEvents.filter(value=>value==='product-data').length,result.byteCount);
  assert.equal(f.child.stderr.listenerCount('data'),1);
 }
});

test('multiple lines, arbitrary messages, paths, secrets and malformed endings remain UNKNOWN',async()=>{
 for(const text of ['QUANT_PROFILE_PAYLOAD_INVALID\nQUANT_PROFILE_PAYLOAD_INVALID\n',
  'QUANT_PROFILE_PAYLOAD_INVALID /private/secret\n','/private/secret token=SECRET\n',
  'QUANT_PROFILE_PAYLOAD_INVALID','QUANT_PROFILE_PAYLOAD_INVALID\rX\n',
  'QUANT_PROFILE_PAYLOAD_INVALID\nSECRET','é/private/secret\n']){
  const f=fixture();send(f.child,text);const result=await finish(f);
  assert.equal(result.code,'UNKNOWN');assert.doesNotMatch(JSON.stringify(result),/private|SECRET|token=|secret/);
  assert.equal(result.byteCount,Buffer.byteLength(text));
 }
});

test('retained input is capped before matching; overflow and absent stderr stay UNKNOWN',async()=>{
 const f=fixture();send(f.child,'QUANT_PROFILE_PAYLOAD_INVALID\n');
 send(f.child,'SECRET'.repeat(2000));const result=await finish(f);
 assert.equal(STDERR_CAPTURE_LIMIT,4096);assert.equal(result.truncated,true);
 assert.equal(result.byteCount,12030);assert.equal(result.code,'UNKNOWN');
 assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 const absent=fixture();assert.equal(absent.observer.snapshot().closeObserved,false);
 const empty=await finish(absent,0);assert.equal(empty.byteCount,0);assert.equal(empty.code,'UNKNOWN');
 assert.equal(empty.exitStatus,0);assert.equal(empty.exitStatusKnown,true);
});

test('status/signal evidence describes launcher only; duplicate close and later data do not overwrite',async()=>{
 const f=fixture();send(f.child,'QUANT_PROFILE_PAYLOAD_INVALID\n');
 const result=await finish(f,null,'SIGTERM');
 f.child.emit('close',0,null);send(f.child,'SECRET');
 assert.deepEqual(f.observer.snapshot(),result);
 assert.equal(result.exitStatusKnown,false);assert.equal(result.exitStatus,null);
 assert.equal(result.exitSignalKnown,true);assert.equal(result.exitSignal,'SIGTERM');
 assert.equal(result.exitScope,'LAUNCHER_PROCESS');assert.equal(result.childKernelStatusKnown,false);
 const unknown=await finish(fixture(),undefined,'SECRET/private');
 assert.equal(unknown.exitSignalKnown,false);assert.equal(unknown.exitSignal,null);
 assert.doesNotMatch(JSON.stringify(unknown),/SECRET|private/);
});

test('observer requires an existing stderr consumer and accepts already decoded ASCII events',async()=>{
 const child=new EventEmitter();child.stderr=new EventEmitter();
 assert.throws(()=>observeLauncherStderr(child),/OBSERVER_REQUIRES_EXISTING_STDERR_CONSUMER/);
 const f=fixture();f.child.stderr.emit('data','QUANT_PROFILE_PAYLOAD_INVALID\n');
 assert.equal((await finish(f)).code,'QUANT_PROFILE_PAYLOAD_INVALID');
});


test('code is UNKNOWN before close, byte counts saturate safely without raw retention',()=>{
 const f=fixture();send(f.child,'PROFILE_OPEN_BAR\n');assert.equal(f.observer.snapshot().code,'UNKNOWN');
 const huge=new Uint8Array(0);Object.defineProperty(huge,'byteLength',{value:Number.MAX_SAFE_INTEGER});
 f.child.stderr.emit('data',huge);f.child.stderr.emit('data',huge);f.child.emit('close',1,null);
 const result=f.observer.snapshot();assert.equal(result.byteCount,Number.MAX_SAFE_INTEGER);
 assert.equal(result.byteCountExact,false);assert.equal(result.truncated,true);assert.equal(result.code,'UNKNOWN');
 assert.equal(Object.isFrozen(result),true);
});
