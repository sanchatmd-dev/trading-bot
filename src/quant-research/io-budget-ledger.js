import {canonical,fail} from '../pine-bridge/source.js';
import {validateCapacityRequest} from './capacity-contract.js';

const VERSION='quant-io-ledger-v2';
const MAX_OPERATIONS=1024;
const invalid=()=>{throw fail('INVALID_IO_BUDGET_LEDGER');};
const names=(value,expected)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid();
  const own=Reflect.ownKeys(value);
  if(own.length!==expected.length||own.some(key=>!expected.includes(key)))invalid();
  for(const key of expected){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))invalid();
  }
};
const integer=(value,min=0)=>{if(!Number.isSafeInteger(value)||value<min)invalid();};
const identifier=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9._:-]{8,128}$/.test(value))invalid();};
const sha=value=>{if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))invalid();};
const add=(a,b)=>{const total=a+b;if(!Number.isSafeInteger(total))invalid();return total;};
const copy=value=>JSON.parse(canonical(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const detached=value=>freeze(copy(value));
function strictArray(value){
  if(!Array.isArray(value))invalid();
  const own=Reflect.ownKeys(value);
  if(own.length!==value.length+1||own.some(key=>key!=='length'&&
    (!/^(0|[1-9][0-9]*)$/.test(String(key))||Number(key)>=value.length)))invalid();
  for(let index=0;index<value.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))invalid();
  }
}
const bytes=value=>{names(value,['read_bytes','write_bytes']);integer(value.read_bytes);integer(value.write_bytes);};
const device=value=>{names(value,['device_id','device_inode']);
  if(typeof value.device_id!=='string'||! /^[0-9]+:[0-9]+$/.test(value.device_id))invalid();
  integer(value.device_inode,1);
};
function devices(values){
  strictArray(values);if(values.length<1||values.length>16)invalid();
  const seen=new Set();
  for(const value of values){device(value);if(seen.has(value.device_id))invalid();seen.add(value.device_id);}
  if(values.some((value,index)=>index>0&&values[index-1].device_id>=value.device_id))invalid();
}
function sample(value,approved){
  names(value,['devices']);
  strictArray(value.devices);if(value.devices.length!==approved.length)invalid();
  for(let index=0;index<approved.length;index++){
    const counter=value.devices[index];
    names(counter,['device_id','device_inode','read_bytes','write_bytes']);
    if(counter.device_id!==approved[index].device_id||counter.device_inode!==approved[index].device_inode)invalid();
    integer(counter.read_bytes);integer(counter.write_bytes);
  }
}
function deltas(baseline,current){
  let read=0,write=0;
  for(let index=0;index<baseline.devices.length;index++){
    const before=baseline.devices[index],after=current.devices[index];
    if(after.read_bytes<before.read_bytes||after.write_bytes<before.write_bytes)invalid();
    read=add(read,after.read_bytes-before.read_bytes);
    write=add(write,after.write_bytes-before.write_bytes);
  }
  return {read_bytes:read,write_bytes:write};
}
const zeroSample=approved=>({devices:approved.map(value=>({...value,read_bytes:0,write_bytes:0}))});
const unresolved=operation=>['RESERVED','ACTIVE','STOP_REQUIRED'].includes(operation.status);
const unknownFinal=state=>state.operations.some(operation=>
  operation.status==='CRASHED_UNCONFIRMED'||operation.status==='CRASHED');
const observed=operation=>operation.last?deltas(operation.baseline,operation.last):
  {read_bytes:0,write_bytes:0};
function exposure(state,direction){
  let total=state.charged[direction+'_bytes'];
  for(const operation of state.operations)if(unresolved(operation))
    total=add(total,Math.max(operation.allowance[direction+'_bytes'],observed(operation)[direction+'_bytes']));
  return total;
}
function stopReason(state,operation){
  const current=observed(operation);
  for(const direction of ['read','write'])
    if(exposure(state,direction)>state.limits[direction+'_bytes']-state.limits['cleanup_'+direction+'_bytes'])
      return 'CLEANUP_RESERVE_AT_RISK';
  for(const direction of ['read','write']){
    const allowance=operation.allowance[direction+'_bytes'];
    if(current[direction+'_bytes']>allowance||allowance>0&&current[direction+'_bytes']===allowance)
      return 'ALLOWANCE_EXHAUSTED';
  }
  return null;
}
function latchStops(state){
  const quarantine=unknownFinal(state);
  for(const operation of state.operations)if(['ACTIVE','STOP_REQUIRED'].includes(operation.status)){
    if(quarantine){operation.stop_reason='UNKNOWN_FINAL_ACCOUNTING';operation.status='STOP_REQUIRED';continue;}
    const current=stopReason(state,operation);
    operation.stop_reason=current==='CLEANUP_RESERVE_AT_RISK'?current:
      operation.stop_reason??current;
    if(operation.stop_reason)operation.status='STOP_REQUIRED';
  }
  return state;
}
function totals(io){
  return {read_bytes:io.read_bytes,write_bytes:io.write_bytes,
    compute_read_bytes:io.read_bytes-io.overshoot_read_bytes-io.cleanup_read_bytes,
    compute_write_bytes:io.write_bytes-io.overshoot_write_bytes-io.cleanup_write_bytes,
    overshoot_read_bytes:io.overshoot_read_bytes,overshoot_write_bytes:io.overshoot_write_bytes,
    cleanup_read_bytes:io.cleanup_read_bytes,cleanup_write_bytes:io.cleanup_write_bytes};
}
function validateState(state){
  names(state,['version','job_id','policy_hash','lease_token','revision','limits','devices','charged','operations']);
  if(state.version!==VERSION)invalid();
  identifier(state.job_id);sha(state.policy_hash);identifier(state.lease_token);integer(state.revision);
  names(state.limits,['read_bytes','write_bytes','compute_read_bytes','compute_write_bytes',
    'overshoot_read_bytes','overshoot_write_bytes','cleanup_read_bytes','cleanup_write_bytes']);
  for(const value of Object.values(state.limits))integer(value,1);
  for(const direction of ['read','write']){
    const total=state.limits[direction+'_bytes'];
    const compute=state.limits['compute_'+direction+'_bytes'];
    const overshoot=state.limits['overshoot_'+direction+'_bytes'];
    const cleanup=state.limits['cleanup_'+direction+'_bytes'];
    if(compute+overshoot+cleanup!==total)invalid();
  }
  devices(state.devices);bytes(state.charged);
  strictArray(state.operations);if(state.operations.length>MAX_OPERATIONS||state.revision<state.operations.length)invalid();
  const operationIds=new Set(),domainIds=new Set(),cgroupIds=new Set();
  let read=0,write=0;
  for(const operation of state.operations){
    names(operation,['operation_id','lease_token','domain_id','domain_relation','domain_proof_sha256',
      'cgroup_id','cgroup_inode','identity_proof_sha256','counter_origin','allowance',
      'baseline','last','status','stop_reason','charge','terminal_proof','stop_confirmation']);
    for(const key of ['operation_id','lease_token','domain_id','cgroup_id'])identifier(operation[key]);
    bytes(operation.allowance);
    if(operation.allowance.read_bytes===0&&operation.allowance.write_bytes===0)invalid();
    if(operationIds.has(operation.operation_id)||domainIds.has(operation.domain_id)||
      cgroupIds.has(operation.cgroup_id))invalid();
    operationIds.add(operation.operation_id);domainIds.add(operation.domain_id);
    cgroupIds.add(operation.cgroup_id);
    if(!['RESERVED','ACTIVE','STOP_REQUIRED','SETTLED','CRASHED_UNCONFIRMED','CRASHED'].includes(operation.status))invalid();
    if(operation.cgroup_inode===null){
      if(!['RESERVED','CRASHED_UNCONFIRMED','CRASHED'].includes(operation.status)||
        operation.domain_relation!==null||operation.domain_proof_sha256!==null||
        operation.identity_proof_sha256!==null||operation.counter_origin!==null||
        operation.baseline!==null||operation.last!==null)invalid();
    }else{
      integer(operation.cgroup_inode,1);
      if(operation.domain_relation!=='DISJOINT'||operation.counter_origin!=='CGROUP_BIRTH')invalid();
      sha(operation.domain_proof_sha256);sha(operation.identity_proof_sha256);
      sample(operation.baseline,state.devices);sample(operation.last,state.devices);
      if(canonical(operation.baseline)!==canonical(zeroSample(state.devices)))invalid();
      observed(operation);
    }
    if(operation.status==='STOP_REQUIRED'){
      if(!['ALLOWANCE_EXHAUSTED','CLEANUP_RESERVE_AT_RISK','UNKNOWN_FINAL_ACCOUNTING'].includes(operation.stop_reason))invalid();
    }else if(operation.status==='ACTIVE'||operation.status==='RESERVED'){
      if(operation.stop_reason!==null)invalid();
    }else if(operation.stop_reason!==null&&
      !['ALLOWANCE_EXHAUSTED','CLEANUP_RESERVE_AT_RISK','UNKNOWN_FINAL_ACCOUNTING'].includes(operation.stop_reason))invalid();
    if(unresolved(operation)){
      if(operation.terminal_proof!==null||operation.charge!==null||operation.stop_confirmation!==null)invalid();
    }else{
      if(operation.status==='SETTLED'){
        names(operation.terminal_proof,['operation_id','lease_token','cgroup_id','cgroup_inode',
          'stopped','stop_proof_sha256','final_readback','readback_proof_sha256','sample']);
        if(operation.terminal_proof.stopped!==true||operation.terminal_proof.final_readback!==true)invalid();
        sha(operation.terminal_proof.stop_proof_sha256);sha(operation.terminal_proof.readback_proof_sha256);
        sample(operation.terminal_proof.sample,state.devices);
        if(operation.cgroup_inode===null||canonical(operation.terminal_proof.sample)!==canonical(operation.last)||
          operation.stop_confirmation!==operation.terminal_proof.stop_proof_sha256)invalid();
      }else{
        names(operation.terminal_proof,['operation_id','lease_token','cgroup_id','cgroup_inode','crash_evidence_sha256']);
        sha(operation.terminal_proof.crash_evidence_sha256);
        if(operation.status==='CRASHED'){sha(operation.stop_confirmation);}
        else if(operation.stop_confirmation!==null)invalid();
      }
      for(const key of ['operation_id','lease_token','cgroup_id','cgroup_inode'])
        if(operation.terminal_proof[key]!==operation[key])invalid();
      bytes(operation.charge);
      const spent=observed(operation);
      for(const direction of ['read','write']){
        const minimum=operation.status==='SETTLED'?spent[direction+'_bytes']:
          Math.max(spent[direction+'_bytes'],operation.allowance[direction+'_bytes']);
        if(operation.charge[direction+'_bytes']!==minimum)invalid();
      }
      read=add(read,operation.charge.read_bytes);write=add(write,operation.charge.write_bytes);
    }
  }
  if(read!==state.charged.read_bytes||write!==state.charged.write_bytes)invalid();
  if(unknownFinal(state)&&state.operations.some(operation=>
    operation.status==='ACTIVE'||operation.status==='STOP_REQUIRED'&&
    operation.stop_reason!=='UNKNOWN_FINAL_ACCOUNTING'))invalid();
  for(const operation of state.operations)if(operation.status==='ACTIVE'&&stopReason(state,operation))invalid();
  return state;
}
function update(state){return detached(validateState(state));}
function next(state){if(state.revision===Number.MAX_SAFE_INTEGER)invalid();return {...copy(state),revision:state.revision+1};}
function target(state,input,keys){
  validateState(state);names(input,keys);
  for(const key of ['operation_id','lease_token','cgroup_id'])identifier(input[key]);
  if(input.cgroup_inode!==null)integer(input.cgroup_inode,1);
  if(input.lease_token!==state.lease_token)invalid();
  const operation=state.operations.find(item=>item.operation_id===input.operation_id);
  if(!operation||operation.lease_token!==input.lease_token||operation.cgroup_id!==input.cgroup_id||
    operation.cgroup_inode!==input.cgroup_inode)invalid();
  return operation;
}
function replace(state,operation){
  const result=next(state);
  result.operations=result.operations.map(item=>item.operation_id===operation.operation_id?operation:item);
  result.charged={read_bytes:0,write_bytes:0};
  for(const item of result.operations)if(!unresolved(item)){
    result.charged.read_bytes=add(result.charged.read_bytes,item.charge.read_bytes);
    result.charged.write_bytes=add(result.charged.write_bytes,item.charge.write_bytes);
  }
  return update(latchStops(result));
}

/** The caller must durably commit each returned state under a lease/revision CAS before any I/O.
 * Domain IDs represent externally proven disjoint cgroup accounting domains.
 * This module does not infer cgroup ancestry or establish physical stop proof.
 */
export function createIoBudgetLedger(input){
  names(input,['request','policy','job_id','lease_token','devices']);
  const {request,policy,job_id,lease_token,devices:approvedDevices}=input;
  const checked=validateCapacityRequest(request,{policy});
  identifier(job_id);identifier(lease_token);devices(approvedDevices);
  return update({version:VERSION,job_id,policy_hash:checked.policy_hash,lease_token,revision:0,
    limits:totals(checked.io),devices:approvedDevices,charged:{read_bytes:0,write_bytes:0},operations:[]});
}

/** Persist this reservation before cgroup creation or any job-owned bootstrap I/O. */
export function reserveIoOperation(state,input){
  validateState(state);
  names(input,['operation_id','lease_token','domain_id','cgroup_id','allowance']);
  for(const key of ['operation_id','lease_token','domain_id','cgroup_id'])identifier(input[key]);
  bytes(input.allowance);
  if(input.allowance.read_bytes===0&&input.allowance.write_bytes===0||
    input.lease_token!==state.lease_token||state.operations.length>=MAX_OPERATIONS||
    state.operations.some(operation=>operation.status==='STOP_REQUIRED')||unknownFinal(state))invalid();
  if(state.operations.some(operation=>operation.operation_id===input.operation_id||
    operation.domain_id===input.domain_id||
    operation.cgroup_id===input.cgroup_id))invalid();
  for(const direction of ['read','write']){
    if(add(exposure(state,direction),input.allowance[direction+'_bytes'])>
      state.limits['compute_'+direction+'_bytes'])invalid();
  }
  const result=next(state);
  result.operations.push({operation_id:input.operation_id,lease_token:input.lease_token,
    domain_id:input.domain_id,domain_relation:null,domain_proof_sha256:null,
    cgroup_id:input.cgroup_id,cgroup_inode:null,identity_proof_sha256:null,counter_origin:null,
    allowance:copy(input.allowance),baseline:null,last:null,status:'RESERVED',stop_reason:null,
    charge:null,terminal_proof:null,stop_confirmation:null});
  return update(result);
}

/** Bind a verified disjoint cgroup after creation. Its lifetime counters include bootstrap. */
export function bindIoOperation(state,input){
  validateState(state);
  names(input,['operation_id','lease_token','domain_id','cgroup_id','cgroup_inode',
    'domain_relation','domain_proof_sha256','identity_proof_sha256','counter_origin','sample']);
  for(const key of ['operation_id','lease_token','domain_id','cgroup_id'])identifier(input[key]);
  integer(input.cgroup_inode,1);sha(input.domain_proof_sha256);sha(input.identity_proof_sha256);
  if(input.domain_relation!=='DISJOINT'||input.counter_origin!=='CGROUP_BIRTH'||
    input.lease_token!==state.lease_token)invalid();
  sample(input.sample,state.devices);
  const operation=state.operations.find(item=>item.operation_id===input.operation_id);
  if(!operation||operation.status!=='RESERVED'||operation.lease_token!==input.lease_token||
    operation.domain_id!==input.domain_id||operation.cgroup_id!==input.cgroup_id)invalid();
  if(state.operations.some(item=>item.status==='STOP_REQUIRED')||unknownFinal(state))invalid();
  const changed={...copy(operation),domain_relation:input.domain_relation,
    domain_proof_sha256:input.domain_proof_sha256,cgroup_inode:input.cgroup_inode,
    identity_proof_sha256:input.identity_proof_sha256,counter_origin:input.counter_origin,
    baseline:zeroSample(state.devices),last:copy(input.sample),status:'ACTIVE'};
  const result=next(state);
  result.operations=result.operations.map(item=>item.operation_id===changed.operation_id?changed:item);
  return update(latchStops(result));
}

/** Caller must stop immediately when stop_required; this pure decision cannot stop a process. */
export function getIoStopDecision(state,input){
  const operation=target(state,input,['operation_id','lease_token','cgroup_id','cgroup_inode']);
  if(!['ACTIVE','STOP_REQUIRED'].includes(operation.status))invalid();
  const reason=operation.stop_reason==='UNKNOWN_FINAL_ACCOUNTING'?operation.stop_reason:
    stopReason(state,operation)??operation.stop_reason;
  const spent=observed(operation);
  return detached({stop_required:reason!==null,reason,observed:spent,
    overshoot_used:{read_bytes:Math.max(0,spent.read_bytes-operation.allowance.read_bytes),
      write_bytes:Math.max(0,spent.write_bytes-operation.allowance.write_bytes)}});
}

export function observeIoOperation(state,input){
  const operation=target(state,input,['operation_id','lease_token','cgroup_id','cgroup_inode','sample']);
  if(!['ACTIVE','STOP_REQUIRED'].includes(operation.status))invalid();
  sample(input.sample,state.devices);
  for(const direction of ['read','write'])for(let index=0;index<state.devices.length;index++)
    if(input.sample.devices[index][direction+'_bytes']<operation.last.devices[index][direction+'_bytes'])invalid();
  if(canonical(input.sample)===canonical(operation.last))return state;
  const changed={...copy(operation),last:copy(input.sample)};
  const result=next(state);
  result.operations=result.operations.map(item=>item.operation_id===changed.operation_id?changed:item);
  return update(latchStops(result));
}

export function settleIoOperation(state,input){
  const operation=target(state,input,['operation_id','lease_token','cgroup_id','cgroup_inode',
    'stopped','stop_proof_sha256','final_readback','readback_proof_sha256','sample']);
  if(input.stopped!==true||input.final_readback!==true)invalid();
  sha(input.stop_proof_sha256);sha(input.readback_proof_sha256);sample(input.sample,state.devices);
  if(operation.status==='SETTLED'){
    if(canonical(input)!==canonical(operation.terminal_proof))invalid();
    return state;
  }
  if(!['ACTIVE','STOP_REQUIRED'].includes(operation.status))invalid();
  for(const direction of ['read','write'])for(let index=0;index<state.devices.length;index++)
    if(input.sample.devices[index][direction+'_bytes']<operation.last.devices[index][direction+'_bytes'])invalid();
  const changed={...copy(operation),last:copy(input.sample),status:'SETTLED',
    charge:deltas(operation.baseline,input.sample),terminal_proof:copy(input),
    stop_confirmation:input.stop_proof_sha256};
  return replace(state,changed);
}

/** Lost final readback burns full reservation and permanently quarantines compute
 * in this job ledger. An unobserved stop tail may have consumed shared overshoot.
 */
export function crashIoOperation(state,input){
  const operation=target(state,input,['operation_id','lease_token','cgroup_id','cgroup_inode','crash_evidence_sha256']);
  sha(input.crash_evidence_sha256);
  if(operation.status==='CRASHED'||operation.status==='CRASHED_UNCONFIRMED'){
    if(canonical(input)!==canonical(operation.terminal_proof))invalid();
    return state;
  }
  if(!unresolved(operation))invalid();
  const spent=observed(operation);
  const changed={...copy(operation),status:'CRASHED_UNCONFIRMED',terminal_proof:copy(input),
    charge:{read_bytes:Math.max(spent.read_bytes,operation.allowance.read_bytes),
      write_bytes:Math.max(spent.write_bytes,operation.allowance.write_bytes)}};
  return replace(state,changed);
}

/** Confirm physical stop after an unknown crash. This does not reopen compute. */
export function acknowledgeIoCrashStop(state,input){
  const operation=target(state,input,['operation_id','lease_token','cgroup_id','cgroup_inode','stop_proof_sha256']);
  sha(input.stop_proof_sha256);
  if(operation.status==='CRASHED'){
    if(operation.stop_confirmation!==input.stop_proof_sha256)invalid();
    return state;
  }
  if(operation.status!=='CRASHED_UNCONFIRMED')invalid();
  return replace(state,{...copy(operation),status:'CRASHED',stop_confirmation:input.stop_proof_sha256});
}

/** Fence prior lease after terminal accounting. Unknown-final history still blocks compute. */
export function fenceIoLedgerLease(state,input){
  validateState(state);names(input,['previous_lease_token','new_lease_token']);
  identifier(input.previous_lease_token);identifier(input.new_lease_token);
  if(input.previous_lease_token!==state.lease_token||input.new_lease_token===state.lease_token||
    state.operations.some(operation=>unresolved(operation)||operation.status==='CRASHED_UNCONFIRMED'))invalid();
  const result=next(state);result.lease_token=input.new_lease_token;
  return update(result);
}
