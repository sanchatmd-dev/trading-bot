import test from 'node:test';
import assert from 'node:assert/strict';
import {createIoBudgetLedger,reserveIoOperation,bindIoOperation,getIoStopDecision,observeIoOperation,settleIoOperation,
  crashIoOperation,acknowledgeIoCrashStop,fenceIoLedgerLease} from '../src/quant-research/io-budget-ledger.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';

const policy=()=>({version:'quant-capacity-v2',environment:'staging',
  scope:{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
    execution_model:'paper-close-v1',source_hash:'a'.repeat(64),settings_hash:'b'.repeat(64),evaluator_hash:'c'.repeat(64)},
  evidence:{calibration_sha256:'d'.repeat(64),parity_sha256:'e'.repeat(64)},max_raw_bars:50000,max_chunk_bars:1000,
  budget:{candidates:100,max_evaluations:125,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
  io:{read_bytes:100,write_bytes:100,overshoot_read_bytes:10,overshoot_write_bytes:10,
    cleanup_read_bytes:20,cleanup_write_bytes:20}});
const request=p=>({version:'quant-capacity-v2',environment:p.environment,policy_hash:capacityPolicyHash(p),stage:'HISTORICAL_PREFLIGHT',
  scope:structuredClone(p.scope),dataset:{raw_bars:2000,seed_bars:500,warmup_bars:1500,evaluation_bars:500,processed_bars:1500},
  chunk_bars:1000,budget:structuredClone(p.budget),io:structuredClone(p.io)});
const sample=(read=0,write=0,device_inode=17)=>({devices:[{device_id:'8:0',device_inode,read_bytes:read,write_bytes:write}]});
const fixture=()=>{const p=policy(),r=request(p);return {p,r};};
const denied=fn=>assert.throws(fn,{code:'INVALID_IO_BUDGET_LEDGER'});
const start=()=>{const {p,r}=fixture();return createIoBudgetLedger({request:r,policy:p,job_id:'job-00001',
  lease_token:'lease-00001',devices:[{device_id:'8:0',device_inode:17}]});};
const op=(operation_id='operation-00001',read=30,write=30)=>({operation_id,lease_token:'lease-00001',
  domain_id:'domain-'+operation_id,cgroup_id:'cgroup-'+operation_id,
  allowance:{read_bytes:read,write_bytes:write}});
const key=input=>({operation_id:input.operation_id,lease_token:input.lease_token,
  cgroup_id:input.cgroup_id,cgroup_inode:23});
const bind=(state,input,first=sample())=>bindIoOperation(state,{...key(input),domain_id:input.domain_id,
  domain_relation:'DISJOINT',domain_proof_sha256:'f'.repeat(64),
  identity_proof_sha256:'e'.repeat(64),counter_origin:'CGROUP_BIRTH',sample:first});
const proof=(input,read,write)=>({...key(input),stopped:true,stop_proof_sha256:'a'.repeat(64),
  final_readback:true,readback_proof_sha256:'b'.repeat(64),sample:sample(read,write)});

test('module exports ledger transitions',()=>{
  assert.equal(typeof createIoBudgetLedger,'function');
  assert.equal(typeof reserveIoOperation,'function');
  assert.equal(typeof bindIoOperation,'function');
  assert.equal(typeof getIoStopDecision,'function');
  assert.equal(typeof observeIoOperation,'function');
  assert.equal(typeof settleIoOperation,'function');
  assert.equal(typeof crashIoOperation,'function');
  assert.equal(typeof acknowledgeIoCrashStop,'function');
  assert.equal(typeof fenceIoLedgerLease,'function');
});

test('prelaunch allowance is recorded before cgroup inode exists and first lifetime counters charge bootstrap',()=>{
  const planned={operation_id:'operation-00001',lease_token:'lease-00001',domain_id:'domain-operation-00001',
    cgroup_id:'cgroup-operation-00001',allowance:{read_bytes:30,write_bytes:30}};
  const reserved=reserveIoOperation(start(),planned);
  assert.equal(reserved.version,'quant-io-ledger-v2');
  assert.equal(reserved.operations[0].status,'RESERVED');
  assert.equal(reserved.operations[0].cgroup_inode,null);
  const bound=bindIoOperation(reserved,{operation_id:planned.operation_id,lease_token:planned.lease_token,
    domain_id:planned.domain_id,cgroup_id:planned.cgroup_id,cgroup_inode:23,
    domain_relation:'DISJOINT',domain_proof_sha256:'f'.repeat(64),
    identity_proof_sha256:'e'.repeat(64),counter_origin:'CGROUP_BIRTH',sample:sample(2,3)});
  assert.deepEqual(getIoStopDecision(bound,{operation_id:planned.operation_id,lease_token:planned.lease_token,
    cgroup_id:planned.cgroup_id,cgroup_inode:23}).observed,{read_bytes:2,write_bytes:3});
  denied(()=>bindIoOperation(reserved,{operation_id:planned.operation_id,lease_token:planned.lease_token,
    domain_id:'wrong-domain',cgroup_id:planned.cgroup_id,cgroup_inode:23,
    domain_relation:'DISJOINT',domain_proof_sha256:'f'.repeat(64),
    identity_proof_sha256:'e'.repeat(64),counter_origin:'CGROUP_BIRTH',sample:sample()}));
  denied(()=>observeIoOperation(reserved,{...key(planned),sample:sample(1,1)}));
  denied(()=>settleIoOperation(reserved,proof(planned,1,1)));
});

test('bootstrap can require stop at bind; observations latch and escalate through fixed overshoot',()=>{
  const input=op('operation-00001',70,70);
  const reserved=reserveIoOperation(start(),input);
  const bound=bind(reserved,input,sample(70,0));
  assert.equal(bound.operations[0].status,'STOP_REQUIRED');
  assert.deepEqual(getIoStopDecision(bound,key(input)),{
    stop_required:true,reason:'ALLOWANCE_EXHAUSTED',
    observed:{read_bytes:70,write_bytes:0},overshoot_used:{read_bytes:0,write_bytes:0}});
  denied(()=>reserveIoOperation(bound,op('operation-00002',1,1)));
  const excess=observeIoOperation(bound,{...key(input),sample:sample(81,0)});
  assert.equal(excess.operations[0].stop_reason,'CLEANUP_RESERVE_AT_RISK');
  assert.equal(getIoStopDecision(excess,key(input)).overshoot_used.read_bytes,11);
  assert.equal(getIoStopDecision(excess,key(input)).reason,'CLEANUP_RESERVE_AT_RISK');
});

test('global cleanup pressure stops every active domain and preserves new counters',()=>{
  const first=op('operation-00001',40,1),second=op('operation-00002',30,1);
  let state=reserveIoOperation(start(),first);
  state=reserveIoOperation(state,second);
  state=bind(state,first);state=bind(state,second);
  const pressured=observeIoOperation(state,{...key(first),sample:sample(51,0)});
  assert.equal(pressured.operations[0].last.devices[0].read_bytes,51);
  assert.deepEqual(pressured.operations.map(value=>value.status),['STOP_REQUIRED','STOP_REQUIRED']);
  assert.equal(getIoStopDecision(pressured,key(second)).reason,'CLEANUP_RESERVE_AT_RISK');
  const settled=settleIoOperation(pressured,proof(first,51,0));
  assert.equal(settled.charged.read_bytes,51);
  assert.equal(settled.operations[1].status,'STOP_REQUIRED');
  const crashed=crashIoOperation(pressured,{...key(first),crash_evidence_sha256:'c'.repeat(64)});
  assert.equal(crashed.charged.read_bytes,51);
  assert.equal(crashed.operations[1].status,'STOP_REQUIRED');
});

test('terminal readback growth latches stop on other active domains',()=>{
  const first=op('operation-00001',40,1),second=op('operation-00002',30,1);
  let state=reserveIoOperation(start(),first);
  state=reserveIoOperation(state,second);
  state=bind(state,first);state=bind(state,second);
  const settled=settleIoOperation(state,proof(first,51,0));
  assert.equal(settled.charged.read_bytes,51);
  assert.equal(settled.operations[1].status,'STOP_REQUIRED');
});

test('fixed compute ceiling retains overshoot and cleanup; reservations precede observations',()=>{
  const initial=start();
  assert.deepEqual(initial.limits,{read_bytes:100,write_bytes:100,compute_read_bytes:70,
    compute_write_bytes:70,overshoot_read_bytes:10,overshoot_write_bytes:10,
    cleanup_read_bytes:20,cleanup_write_bytes:20});
  const first=op(),reserved=reserveIoOperation(initial,first);
  assert.equal(initial.operations.length,0);
  denied(()=>reserveIoOperation(reserved,op('operation-00002',41,1)));
  denied(()=>reserveIoOperation(reserved,op('operation-00002',1,41)));
  const second=reserveIoOperation(reserved,op('operation-00002',40,40));
  denied(()=>reserveIoOperation(second,op('operation-00003',1,0)));
  const running=bind(second,first);
  const observed=observeIoOperation(running,{...key(first),sample:sample(11,13)});
  assert.equal(observed.operations[0].last.devices[0].read_bytes,11);
  assert.equal(observeIoOperation(observed,{...key(first),sample:sample(11,13)}),observed);
  assert.equal(running.operations[0].last.devices[0].read_bytes,0);
});

test('settlement needs stop and terminal readback, refunds only observed unused allowance',()=>{
  const input=op(),reserved=bind(reserveIoOperation(start(),input),input);
  const observed=observeIoOperation(reserved,{...key(input),sample:sample(10,8)});
  denied(()=>settleIoOperation(observed,{...proof(input,10,8),stopped:false}));
  denied(()=>settleIoOperation(observed,{...proof(input,10,8),final_readback:false}));
  denied(()=>settleIoOperation(observed,{...proof(input,10,8),stop_proof_sha256:'bad'}));
  const final=proof(input,12,9),settled=settleIoOperation(observed,final);
  assert.deepEqual(settled.charged,{read_bytes:12,write_bytes:9});
  assert.equal(settleIoOperation(settled,final),settled);
  denied(()=>settleIoOperation(settled,{...final,readback_proof_sha256:'c'.repeat(64)}));
  denied(()=>settleIoOperation(settled,{...final,sample:sample(13,9)}));
  assert.equal(reserveIoOperation(settled,op('operation-00002',58,61)).operations.length,2);
});

test('unknown crash burns full allowance, survives lease change, and never resets charged history',()=>{
  const input=op(),reserved=reserveIoOperation(start(),input);
  const crash={...key(input),cgroup_inode:null,crash_evidence_sha256:'c'.repeat(64)};
  const failed=crashIoOperation(reserved,crash);
  assert.deepEqual(failed.charged,{read_bytes:30,write_bytes:30});
  assert.equal(crashIoOperation(failed,crash),failed);
  denied(()=>crashIoOperation(failed,{...crash,crash_evidence_sha256:'d'.repeat(64)}));
  denied(()=>settleIoOperation(failed,proof(input,101,201)));
  denied(()=>reserveIoOperation(failed,op('operation-00002')));
  denied(()=>fenceIoLedgerLease(failed,{previous_lease_token:'lease-00001',new_lease_token:'lease-00002'}));
  const stopped=acknowledgeIoCrashStop(failed,{...key(input),cgroup_inode:null,stop_proof_sha256:'e'.repeat(64)});
  assert.equal(stopped.charged.read_bytes,30);
  const fenced=fenceIoLedgerLease(stopped,{previous_lease_token:'lease-00001',new_lease_token:'lease-00002'});
  assert.deepEqual(fenced.charged,failed.charged);
  denied(()=>reserveIoOperation(fenced,op('operation-00002')));
  denied(()=>reserveIoOperation(fenced,{...op('operation-00002'),lease_token:'lease-00002'}));
  denied(()=>fenceIoLedgerLease(reserved,{previous_lease_token:'lease-00001',new_lease_token:'lease-00002'}));
});

test('unknown final counters permanently block pending bind and later compute leases',()=>{
  const first=op('operation-00001',20,20),pending=op('operation-00002',20,20);
  let state=reserveIoOperation(start(),first);
  state=reserveIoOperation(state,pending);
  state=crashIoOperation(state,{...key(first),cgroup_inode:null,crash_evidence_sha256:'c'.repeat(64)});
  state=acknowledgeIoCrashStop(state,{...key(first),cgroup_inode:null,stop_proof_sha256:'d'.repeat(64)});
  assert.deepEqual(state.charged,{read_bytes:20,write_bytes:20});
  denied(()=>bind(state,pending));
  denied(()=>reserveIoOperation(state,op('operation-00003',1,1)));
  state=crashIoOperation(state,{...key(pending),cgroup_inode:null,crash_evidence_sha256:'e'.repeat(64)});
  state=acknowledgeIoCrashStop(state,{...key(pending),cgroup_inode:null,stop_proof_sha256:'f'.repeat(64)});
  assert.deepEqual(state.charged,{read_bytes:40,write_bytes:40});
  state=fenceIoLedgerLease(state,{previous_lease_token:'lease-00001',new_lease_token:'lease-00002'});
  denied(()=>reserveIoOperation(state,{...op('operation-00003',1,1),lease_token:'lease-00002'}));
});

test('unknown final crash latches stop on active siblings while permitting cleanup accounting',()=>{
  const first=op('operation-00001',20,20),sibling=op('operation-00002',20,20);
  let state=reserveIoOperation(start(),first);
  state=reserveIoOperation(state,sibling);
  state=bind(state,first);state=bind(state,sibling);
  state=crashIoOperation(state,{...key(first),crash_evidence_sha256:'c'.repeat(64)});
  assert.equal(state.operations[1].status,'STOP_REQUIRED');
  assert.equal(getIoStopDecision(state,key(sibling)).reason,'UNKNOWN_FINAL_ACCOUNTING');
  denied(()=>reserveIoOperation(state,op('operation-00003',1,1)));
  state=observeIoOperation(state,{...key(sibling),sample:sample(3,4)});
  state=settleIoOperation(state,proof(sibling,4,5));
  assert.deepEqual(state.charged,{read_bytes:24,write_bytes:25});
});

test('stale token, missing/device/inode change, and counter regression reject',()=>{
  const input=op(),reserved=bind(reserveIoOperation(start(),input),input);
  denied(()=>observeIoOperation(reserved,{...key(input),lease_token:'lease-stale1',sample:sample(1,0)}));
  denied(()=>observeIoOperation(reserved,{...key(input),sample:{devices:[]}}));
  denied(()=>observeIoOperation(reserved,{...key(input),sample:sample(1,0,18)}));
  const progressed=observeIoOperation(reserved,{...key(input),sample:sample(1,1)});
  denied(()=>observeIoOperation(progressed,{...key(input),sample:sample(0,1)}));
  denied(()=>settleIoOperation(reserved,proof(input,0,-1)));
  denied(()=>reserveIoOperation(reserved,{...op('operation-00002'),domain_id:input.domain_id}));
  denied(()=>reserveIoOperation(reserved,{...op('operation-00002'),cgroup_id:input.cgroup_id}));
  denied(()=>bindIoOperation(reserveIoOperation(start(),op()),{...key(input),domain_id:input.domain_id,
    domain_relation:'ANCESTOR',domain_proof_sha256:'f'.repeat(64),
    identity_proof_sha256:'e'.repeat(64),counter_origin:'CGROUP_BIRTH',sample:sample()}));
});

test('validated input and state are detached, frozen, strict, and safe integer bounded',()=>{
  const {p,r}=fixture();
  const devices=[{device_id:'8:0',device_inode:17}];
  const state=createIoBudgetLedger({request:r,policy:p,job_id:'job-00001',lease_token:'lease-00001',devices});
  devices[0].device_inode=99;r.io.read_bytes=999;
  assert.equal(state.devices[0].device_inode,17);assert.equal(state.limits.read_bytes,100);
  for(const value of [state,state.limits,state.devices,state.devices[0],state.charged,state.operations])
    assert.equal(Object.isFrozen(value),true);
  const input=op(),reserved=reserveIoOperation(state,input);
  input.allowance.read_bytes=1;input.domain_id='changed-domain';
  assert.equal(reserved.operations[0].allowance.read_bytes,30);
  assert.equal(reserved.operations[0].domain_id,'domain-operation-00001');
  denied(()=>reserveIoOperation(state,{...op(),extra:1}));
  denied(()=>reserveIoOperation(state,{...op(),allowance:{read_bytes:Number.MAX_SAFE_INTEGER,write_bytes:1}}));
  denied(()=>bindIoOperation(reserved,{...key(op()),domain_id:'domain-operation-00001',
    domain_relation:'DISJOINT',domain_proof_sha256:'f'.repeat(64),
    identity_proof_sha256:'e'.repeat(64),counter_origin:'CGROUP_BIRTH',
    sample:sample(Number.MAX_SAFE_INTEGER+1,0)}));
  denied(()=>observeIoOperation(reserved,{...key(op()),sample:sample(1,1),extra:1}));
  denied(()=>reserveIoOperation({...state,extra:true},op()));
  assert.throws(()=>createIoBudgetLedger({request:{...request(p),extra:true},policy:p,job_id:'job-00001',
    lease_token:'lease-00001',devices:[{device_id:'8:0',device_inode:17}]}),{code:'INVALID_CAPACITY_CONTRACT'});
  denied(()=>createIoBudgetLedger({request:request(p),policy:p,job_id:'job-00001',
    lease_token:'lease-00001',devices:[{device_id:'8:0',device_inode:17}],extra:true}));
  const extra=[{device_id:'8:0',device_inode:17}];extra.hidden=true;
  denied(()=>createIoBudgetLedger({request:request(p),policy:p,job_id:'job-00001',
    lease_token:'lease-00001',devices:extra}));
});

test('observed physical excess spends overshoot and blocks further compute admission',()=>{
  const input=op('operation-00001',70,70),reserved=bind(reserveIoOperation(start(),input),input);
  const observed=observeIoOperation(reserved,{...key(input),sample:sample(75,70)});
  denied(()=>reserveIoOperation(observed,op('operation-00002',1,0)));
  assert.equal(getIoStopDecision(observed,key(input)).stop_required,true);
  const settled=settleIoOperation(observed,proof(input,75,70));
  assert.deepEqual(settled.charged,{read_bytes:75,write_bytes:70});
  denied(()=>reserveIoOperation(settled,op('operation-00002',1,0)));
  assert.equal(settled.limits.cleanup_read_bytes,20);
});

test('many-device delta overflow rejects before storing a corrupt sample',()=>{
  const {p,r}=fixture();
  const initial=createIoBudgetLedger({request:r,policy:p,job_id:'job-00001',lease_token:'lease-00001',
    devices:[{device_id:'8:0',device_inode:17},{device_id:'8:1',device_inode:18}]});
  const input=op();
  const reserved=bind(reserveIoOperation(initial,input),input,{devices:[
    {device_id:'8:0',device_inode:17,read_bytes:0,write_bytes:0},
    {device_id:'8:1',device_inode:18,read_bytes:0,write_bytes:0}]});
  denied(()=>observeIoOperation(reserved,{...key(input),sample:{devices:[
    {device_id:'8:0',device_inode:17,read_bytes:Number.MAX_SAFE_INTEGER,write_bytes:0},
    {device_id:'8:1',device_inode:18,read_bytes:1,write_bytes:0}]}}));
});

test('operation count bound rejects without deleting charged history',()=>{
  const input=op(),settled=settleIoOperation(bind(reserveIoOperation(start(),input),input),proof(input,0,0));
  const full=structuredClone(settled);
  full.operations=Array.from({length:1024},(_,index)=>{
    const operation=structuredClone(settled.operations[0]);
    const suffix=String(index).padStart(4,'0');
    operation.operation_id='operation-'+suffix;
    operation.domain_id='domain-'+suffix;
    operation.cgroup_id='cgroup-'+suffix;
    operation.terminal_proof.operation_id=operation.operation_id;
    operation.terminal_proof.cgroup_id=operation.cgroup_id;
    return operation;
  });
  full.revision=1024;
  denied(()=>reserveIoOperation(full,op('operation-new01',1,1)));
  assert.equal(full.operations.length,1024);
});
