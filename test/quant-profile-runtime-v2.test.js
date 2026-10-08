import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {prepareProfileIo,runProfilePayload} from '../src/quant-research/io-profile-worker.js';
import {QuantProfileRuntimeV2} from '../src/postgres/quant-profile-runtime-v2.js';
import {sanitizeProfileChildDiagnostic,PROFILE_CHILD_DIAGNOSTIC_VERSION} from '../src/quant-research/profile-child-diagnostic.js';
import {prepareEnrollmentAttempt} from '../src/postgres/quant-profile-enrollment.js';
import {quantIoUnitName} from '../src/postgres/quant-io-runtime.js';

test('actual runtime finally preserves terminal proof permutations, handle lifetime and original errors',async()=>{
 for(const phase of ['start','release','accepted','missing','snapshot'])for(const callbackThrows of [false,true])
 for(const proof of ['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED','UNCONFIRMED']){
  const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
  contract.capacity.policy_hash=capacityPolicyHash(policy);
  const job={job_id:'job',owner_id:contract.owner_id,status:'RUNNING',lease_token:'lease',contract,contract_hash:hash(canonical(contract))};
  const db={isTransaction:true,transaction:async fn=>fn(),query:async()=>({rows:[job]})};
  const scheduler={cancel:async()=>{}};
  const runtime=new QuantProfileRuntimeV2({db,ledger:{policy,db,open:async()=>{}},scheduler,
   launcher:{terminalConfig:policy.terminal,spawnPrepared(){}},
   storageBudget:{root:path.resolve('local-fixture')},authorizeRelease:async()=>({ok:true}),health:async()=>({ok:true})});
  const failure=Object.assign(new Error('private original'),{code:'QUANT_IO_LAUNCH_UNCERTAIN'}),events=[],key='job:operation';
  const diagnostic=sanitizeProfileChildDiagnostic({version:PROFILE_CHILD_DIAGNOSTIC_VERSION,code:'PROFILE_OPEN_BAR',byteCount:17,
   byteCountExact:true,truncated:false,closeObserved:true,exitStatus:1,exitStatusKnown:true,exitSignal:null,exitSignalKnown:true});
  const handle={childDiagnostic:()=>{events.push('snapshot');if(phase==='snapshot')throw Error('snapshot private');return diagnostic;},
   accepted:Promise.resolve({}),profileResult:new Promise(()=>{})};
  const io={handles:new Map(),payloads:new Map(),assertHost:async()=>{},reserve:async()=>{},ready:async()=>{},bind:async()=>{},observe:async()=>{},
   start:async()=>{if(phase==='missing')throw failure;io.handles.set(key,handle);if(phase==='start')throw failure;},
   release:async()=>{if(phase==='release'||phase==='snapshot')throw failure;if(phase==='accepted')handle.accepted=Promise.reject(failure);},
   cancel:async({onTerminalDiagnostic})=>{events.push('cancel');if(proof!=='UNCONFIRMED')io.handles.delete(key);
    const terminal={status:proof==='UNCONFIRMED'?'STOPPING':'CANCELLED',proof};onTerminalDiagnostic(terminal);return terminal;}};
  runtime.io=io;let captured,terminalDiagnostic;
  await assert.rejects(runtime.run({jobId:'job',leaseToken:'lease',operationId:'operation',ownerId:contract.owner_id,
   onTerminalDiagnostic:value=>{terminalDiagnostic=value;},
   onChildDiagnostic:value=>{events.push('callback');captured=value;if(callbackThrows)throw Error('callback private');}}),error=>error===failure);
  assert.equal(io.handles.size,phase==='missing'||proof!=='UNCONFIRMED'?0:1);
  assert.deepEqual(failure.terminal,{status:proof==='UNCONFIRMED'?'STOPPING':'CANCELLED',proof});
  assert.deepEqual(terminalDiagnostic,failure.terminal);
  if(phase==='snapshot'){assert.equal(captured,undefined);assert.deepEqual(events,['cancel','snapshot']);}
  else{
   assert.equal(captured.code,phase==='missing'?'UNKNOWN':'PROFILE_OPEN_BAR');
   assert.deepEqual(events,phase==='missing'?['cancel','callback']:['cancel','snapshot','callback']);
  }
 }
});

test('fixed PROFILE child primes exact scratch bytes before any payload work',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'profile-io-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const filename=path.join(root,'.pending-'+randomUUID());
  const environment={QUANT_IO_READY_FILE:filename,QUANT_IO_READY_DEVICE:'8:0',
    QUANT_IO_READY_RBPS:'1024',QUANT_IO_READY_WBPS:'1024'};
  const reader=async name=>name==='/proc/self/cgroup'?'0::/unit.service\n':
    name.endsWith('/io.max')?'8:0 rbps=1024 wbps=1024\n':
    name.endsWith('/io.stat')?'8:0 rbytes=0 wbytes=4096\n':assert.fail(name);
  await prepareProfileIo({environment,reader,linkstat:stat,statter:async()=>({ino:17}),
    resolver:async()=>'/approved/device'});
  const bytes=await readFile(filename);
  assert.equal(bytes.length,4096);
  assert.equal(bytes.every(value=>value===0x51),true);
});

test('actual child pipeline and runtime completion retain child diagnostics across completeProfile deletion',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'profile-runtime-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new ResearchDatasetStore({root,allowUnsupportedDirectorySyncForTests:true});
  const {policy,contract}=profileV2Fixture(600);
  policy.environment='staging';contract.capacity.environment='staging';
  policy.max_raw_bars=10000;
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:0,tail_margin_ms:5000};
  contract.completion_mode='pf2-enrollment-v1';
  contract.capacity.policy_hash=capacityPolicyHash(policy);
  async function* rows(){for(let i=0;i<600;i++)yield {time:contract.dataset.metadata.start_time+i*60000,
    open:'100',high:'102',low:'99',close:'101',volume:'2'};}
  contract.dataset=await store.raw.publish(contract.dataset.metadata,rows(),{chunkBars:1000});
  const payload=canonical({version:'profile-v2-provisional',jobId:randomUUID(),
    operationId:'operation-00001',contract,policy,storage:{root,diskQuotaBytes:32*1024*1024,
      tempQuotaBytes:16*1024*1024,freeFloorBytes:0}});
  const output=[];
  const frame=await runProfilePayload(payload,{storeFactory:()=>({rawStore:store.raw,researchStore:store}),
    now:()=>contract.dataset.metadata.cutoff,write:async chunk=>{output.push(chunk);}});
  assert.equal(output.length,2);
  assert.equal(output[0],`QUANT_PROFILE_ACCEPTED_V2 ${hash(payload)}\n`);
  assert.equal(JSON.parse(output[1]).resultHash,frame.resultHash);
  assert.equal(frame.result.binding.bar_count,100);
  assert.equal(frame.result.evaluator_admission,false);
  assert.equal(frame.resultHash,hash(canonical(frame.result)));
  // Actual adapter and registered attempt with real pipeline output. Terminal/authority seams remain synthetic;
  // this checks callback lifetime across completeProfile deletion, not SQL enrollment or stop authority.
  for(const callbackThrows of [false,true]){
   const leaseToken='lease',key=frame.jobId+':'+frame.operationId,events=[];
   const job={job_id:frame.jobId,owner_id:contract.owner_id,status:'RUNNING',lease_token:leaseToken,
    contract,contract_hash:hash(canonical(contract))};
   const db={isTransaction:true,transaction:async fn=>fn(),query:async()=>({rows:[job]})};
   const enrollment={enabled:true,tickets:{prepare:async()=>Object.freeze({synthetic:true})},
    authorizeLocked:async()=>({ok:true}),assertSchemaLocked:async()=>{}};
   const scheduler={cancel:async()=>{},beginProfileCompletion:async()=>{events.push('begin');return {};}};
   const adapter=new QuantProfileRuntimeV2({db,ledger:{policy,db,open:async()=>{}},scheduler,enrollment,
    launcher:{terminalConfig:policy.terminal,spawnPrepared(){}},storageBudget:{root},
    authorizeRelease:async()=>({ok:true}),health:async()=>({ok:true})});
   const diagnostic=sanitizeProfileChildDiagnostic({version:PROFILE_CHILD_DIAGNOSTIC_VERSION,byteCount:0,byteCountExact:true,
    closeObserved:true,exitStatusKnown:true,exitStatus:0,exitSignalKnown:true,exitSignal:null});
   const io={handles:new Map([[key,{accepted:Promise.resolve({unitName:quantIoUnitName(frame.jobId,frame.operationId),
    payloadHash:hash(payload)}),profileResult:Promise.resolve(frame),childDiagnostic:()=>{events.push('snapshot');return diagnostic;}}]]),
    payloads:new Map([[key,payload]]),assertHost:async()=>{},reserve:async()=>{},start:async()=>{},ready:async()=>{},
    bind:async()=>{},release:async()=>{},observe:async()=>{},
    prepareEnrollment:args=>prepareEnrollmentAttempt({...args,policy,enrollment}),
    completeProfile:async({onTerminalDiagnostic})=>{events.push('complete');io.handles.delete(key);
     const terminal={status:'SUCCEEDED',proof:'MEASURED_FINAL_SETTLED'};onTerminalDiagnostic(terminal);return terminal;},
    cancel:async()=>assert.fail('successful completion must not cancel')};
   adapter.io=io;let captured,terminalDiagnostic;
   const answer=await adapter.run({jobId:frame.jobId,operationId:frame.operationId,leaseToken,ownerId:contract.owner_id,
    onTerminalDiagnostic:value=>{terminalDiagnostic=value;},onChildDiagnostic:value=>{events.push('callback');captured=value;
     if(callbackThrows)throw Error('synthetic callback failure');}});
   assert.deepEqual(answer,{status:'SUCCEEDED',proof:'MEASURED_FINAL_SETTLED'});assert.deepEqual(terminalDiagnostic,answer);
   assert.equal(io.handles.size,0);assert.deepEqual(captured,diagnostic);
   assert.deepEqual(events,['begin','complete','snapshot','callback']);
  }
});

test('fixed child rejects non-staging and malformed payload before receipt',async()=>{
  const output=[];
  await assert.rejects(runProfilePayload('{}',{write:async item=>{output.push(item);}}),
    {code:'QUANT_PROFILE_PAYLOAD_INVALID'});
  assert.deepEqual(output,[]);
});
