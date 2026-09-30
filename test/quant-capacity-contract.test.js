import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCapacityPolicy,validateCapacityRequest,capacityPolicyHash,validateTerminalPolicy} from '../src/quant-research/capacity-contract.js';
import {TERMINAL_BUDGET_MS,SPAWN_MARGIN_MS,MIN_DRAIN_MS,MAX_DRAIN_MS,MAX_RUNTIME_MS,TAIL_MARGIN_MS} from '../src/quant-research/io-terminal.js';

const clone=value=>structuredClone(value);
const policy=()=>({version:'quant-capacity-v2',environment:'staging',
  scope:{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
    execution_model:'paper-close-v1',source_hash:'a'.repeat(64),settings_hash:'b'.repeat(64),evaluator_hash:'c'.repeat(64)},
  evidence:{calibration_sha256:'d'.repeat(64),parity_sha256:'e'.repeat(64)},max_raw_bars:1000000,max_chunk_bars:1000,
  budget:{candidates:100,max_evaluations:125,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
  io:{read_bytes:1000000,write_bytes:1000000,overshoot_read_bytes:1000,overshoot_write_bytes:1000,
    cleanup_read_bytes:2000,cleanup_write_bytes:2000}});
const terminal=(patch={})=>({version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,
  tail_margin_ms:5000,...patch});
const withTerminal=(patch)=>({...policy(),terminal:terminal(patch)});
const request=(p=policy(),raw=50000,stage='HISTORICAL_PREFLIGHT')=>({version:'quant-capacity-v2',environment:p.environment,
  policy_hash:capacityPolicyHash(p),stage,scope:clone(p.scope),
  dataset:{raw_bars:raw,seed_bars:500,warmup_bars:1500,evaluation_bars:raw-1500,processed_bars:raw-500},
  chunk_bars:1000,budget:clone(p.budget),io:clone(p.io)});
const rejected=fn=>assert.throws(fn,{code:'INVALID_CAPACITY_CONTRACT'});

test('policy and request return detached deeply frozen canonical copies and stable hashes',()=>{
  const p=policy(),r=request(p),approved=validateCapacityPolicy(p),checked=validateCapacityRequest(r,{policy:p});
  assert.equal(capacityPolicyHash(p),capacityPolicyHash(Object.fromEntries(Object.entries(p).reverse())));
  assert.equal(JSON.stringify(approved),JSON.stringify(validateCapacityPolicy(Object.fromEntries(Object.entries(p).reverse()))));
  p.budget.candidates=1;r.dataset.raw_bars=3;
  assert.equal(approved.budget.candidates,100);assert.equal(checked.dataset.raw_bars,50000);
  for(const value of [approved,approved.scope,approved.io,checked,checked.dataset,checked.budget])assert.equal(Object.isFrozen(value),true);
  assert.throws(()=>{checked.io.read_bytes=1;},TypeError);
});

test('all stage ceilings count seed in raw total and permit smaller declared studies',()=>{
  const p=policy();
  for(const [stage,ceiling] of Object.entries({PARITY_DEBUG:20000,HISTORICAL_PREFLIGHT:50000,BROAD_SEARCH:250000,EXTENDED_VALIDATION:500000,FINAL_VALIDATION:1000000})){
    const r=request(p,ceiling,stage);
    assert.equal(validateCapacityRequest(r,{policy:p}).dataset.processed_bars,ceiling-500);
    rejected(()=>validateCapacityRequest(request(p,ceiling+1,stage),{policy:p}));
    assert.equal(validateCapacityRequest(request(p,2000,stage),{policy:p}).dataset.evaluation_bars,500);
  }
});

test('measured policy is distinct from planned stage maxima and initial chunk ceiling',()=>{
  const p=policy();p.max_raw_bars=20000;p.max_chunk_bars=500;
  const r=request(p,20000,'FINAL_VALIDATION');r.chunk_bars=500;
  assert.equal(validateCapacityRequest(r,{policy:p}).dataset.raw_bars,20000);
  rejected(()=>validateCapacityRequest({...r,dataset:request(p,20001).dataset},{policy:p}));
  rejected(()=>validateCapacityRequest({...r,chunk_bars:501},{policy:p}));
  rejected(()=>validateCapacityPolicy({...p,max_chunk_bars:1001}));
  const tiny=policy();tiny.max_raw_bars=501;tiny.max_chunk_bars=1;
  const one=request(tiny,501,'PARITY_DEBUG');Object.assign(one.dataset,{warmup_bars:500,evaluation_bars:1});one.chunk_bars=1;
  assert.equal(validateCapacityRequest(one,{policy:tiny}).dataset.processed_bars,1);
  rejected(()=>validateCapacityRequest({...one,chunk_bars:2},{policy:tiny}));
});

test('unknown scope, production, policy substitutions and request overrides fail closed',()=>{
  const p=policy(),r=request(p);
  for(const patch of [{version:'quant-capacity-v1'},{environment:'production'},{stage:'DEEP_RESEARCH'},
    {stage:'toString'},{policy_hash:'f'.repeat(64)},{policy:p},{max_raw_bars:1000000},{evaluator_admission:true}])
    rejected(()=>validateCapacityRequest({...r,...patch},{policy:p}));
  for(const patch of [{timeframe:'5'},{market:'FUTURES'},{venue:'other'},{symbol:'ETHUSDT'},
    {source_profile:'SPT_DEFAULT'},{execution_model:'paper-close-cost-v2'},{source_hash:'f'.repeat(64)},
    {settings_hash:'f'.repeat(64)},{evaluator_hash:'f'.repeat(64)}])
    rejected(()=>validateCapacityRequest({...r,scope:{...r.scope,...patch}},{policy:p}));
  rejected(()=>validateCapacityPolicy({...p,environment:'production'}));
  rejected(()=>validateCapacityRequest(r));
  const changed=clone(p);changed.evidence.parity_sha256='f'.repeat(64);
  rejected(()=>validateCapacityRequest(r,{policy:changed}));
  const local={...p,environment:'local'};
  assert.equal(validateCapacityRequest(request(local),{policy:local}).environment,'local');
});

test('seed, warm-up and exact bar arithmetic cannot omit or double count seed',()=>{
  const p=policy(),r=request(p);
  for(const patch of [{seed_bars:0},{seed_bars:501},{warmup_bars:499},{warmup_bars:50000},
    {evaluation_bars:48501},{processed_bars:50000},{raw_bars:50000.5},{evaluation_bars:NaN},
    {warmup_bars:'1500'},{processed_bars:Infinity}])
    rejected(()=>validateCapacityRequest({...r,dataset:{...r.dataset,...patch}},{policy:p}));
});

test('compute budgets enforce absolute and measured ceilings with safe positive integers',()=>{
  for(const [name,limit] of Object.entries(policy().budget)){
    for(const value of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1,limit+1]){
      const p=policy();p.budget[name]=value;rejected(()=>validateCapacityPolicy(p));
    }
    const p=policy(),r=request(p);r.budget[name]=limit+1;
    rejected(()=>validateCapacityRequest(r,{policy:p}));
  }
  const p=policy();p.budget={candidates:2,max_evaluations:4,max_runtime_ms:60000,max_output_bytes:8192,max_state_bytes:4096};
  const r=request(p);assert.equal(validateCapacityRequest(r,{policy:p}).budget.candidates,2);
  for(const name of Object.keys(p.budget)){const changed=clone(r);changed.budget[name]++;rejected(()=>validateCapacityRequest(changed,{policy:p}));}
  const invalid=policy();invalid.budget.max_evaluations=99;rejected(()=>validateCapacityPolicy(invalid));
});

test('I/O totals include fixed overshoot and cleanup reserves with no integer overflow',()=>{
  const p=policy(),r=request(p);
  r.io.read_bytes=3001;r.io.write_bytes=3001;
  assert.equal(validateCapacityRequest(r,{policy:p}).io.read_bytes,3001);
  for(const name of Object.keys(p.io)){
    const tooLarge=request(p);tooLarge.io[name]++;rejected(()=>validateCapacityRequest(tooLarge,{policy:p}));
    for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
      const bad=policy();bad.io[name]=value;rejected(()=>validateCapacityPolicy(bad));
    }
    if(name.startsWith('overshoot')||name.startsWith('cleanup')){
      const tooSmall=request(p);tooSmall.io[name]--;rejected(()=>validateCapacityRequest(tooSmall,{policy:p}));
    }
  }
  for(const total of [2000,3000]){const bad=clone(r);bad.io.read_bytes=total;rejected(()=>validateCapacityRequest(bad,{policy:p}));}
  const huge=policy();huge.io.read_bytes=Number.MAX_SAFE_INTEGER;huge.io.cleanup_read_bytes=Number.MAX_SAFE_INTEGER-1;
  rejected(()=>validateCapacityPolicy(huge));
});

test('strict JSON data shapes reject missing, extra, symbolic and accessor fields',()=>{
  const p=policy(),r=request(p);
  for(const name of Object.keys(p)){const bad=clone(p);delete bad[name];rejected(()=>validateCapacityPolicy(bad));}
  for(const name of Object.keys(r)){const bad=clone(r);delete bad[name];rejected(()=>validateCapacityRequest(bad,{policy:p}));}
  for(const name of ['scope','evidence','budget','io']){const bad=policy();bad[name].extra=true;rejected(()=>validateCapacityPolicy(bad));}
  for(const name of ['scope','dataset','budget','io']){const bad=request(p);bad[name].extra=true;rejected(()=>validateCapacityRequest(bad,{policy:p}));}
  const symbol=policy();symbol[Symbol('hidden')]=1;rejected(()=>validateCapacityPolicy(symbol));
  const getter=policy();Object.defineProperty(getter,'version',{enumerable:true,get(){throw Error('getter must not run');}});
  rejected(()=>validateCapacityPolicy(getter));
  for(const evidence of ['', 'A'.repeat(64), 'path/to/evidence', 'a'.repeat(63)]){
    const bad=policy();bad.evidence.parity_sha256=evidence;rejected(()=>validateCapacityPolicy(bad));
  }
});

test('legacy eight-key policies keep their pinned hashes and shape',()=>{
  assert.equal(capacityPolicyHash(policy()),'176b7bf9630fb7dc31361a020e4ab027e0af479ec3c42f40f8c5481a9df543b9');
  assert.equal(capacityPolicyHash({...policy(),environment:'local'}),
    'f5f364b527eac91e45a982e4f3941bed2440355b4eb3809b6580b5be7d5e82af');
  const measured=policy();measured.max_raw_bars=20000;measured.max_chunk_bars=500;
  assert.equal(capacityPolicyHash(measured),'87dfaae6365d4dfd72000e14d4df681f5e8236fe44aaab7f80261941fa586689');
  assert.equal(Object.hasOwn(validateCapacityPolicy(policy()),'terminal'),false);
});

test('terminal block is optional, rotates the policy hash and is part of the frozen copy',()=>{
  const legacy=capacityPolicyHash(policy()),p=withTerminal();
  const approved=validateCapacityPolicy(p),hashed=capacityPolicyHash(p);
  assert.equal(hashed,'15bca30ddd46a2a97e1c3cc74a013861ec2eb7a819da15f11bdb130bc7e2e9fb');
  assert.notEqual(hashed,legacy);
  assert.deepEqual(approved.terminal,terminal());
  for(const value of [approved,approved.terminal])assert.equal(Object.isFrozen(value),true);
  assert.throws(()=>{approved.terminal.runtime_max_ms=1;},TypeError);
  p.terminal.runtime_max_ms=60000;p.terminal.terminal_drain_ms=44999;
  assert.equal(approved.terminal.runtime_max_ms,70000);
  assert.equal(approved.terminal.terminal_drain_ms,45000);
  // Every value is pinned by the hash, and key order does not matter.
  for(const patch of [{runtime_max_ms:69000},{terminal_drain_ms:40000},{tail_margin_ms:6000}])
    assert.notEqual(capacityPolicyHash(withTerminal(patch)),hashed);
  const reversed=withTerminal();reversed.terminal=Object.fromEntries(Object.entries(reversed.terminal).reverse());
  assert.equal(capacityPolicyHash(reversed),hashed);
  for(const environment of ['local','staging'])
    assert.equal(validateCapacityPolicy({...withTerminal(),environment}).terminal.tail_margin_ms,5000);
  rejected(()=>validateCapacityPolicy({...withTerminal(),environment:'production'}));
});

test('capacity requests bind to the policy hash that includes the terminal block',()=>{
  const p=withTerminal(),r=request(p);
  assert.equal(r.policy_hash,capacityPolicyHash(p));
  assert.equal(validateCapacityRequest(r,{policy:p}).policy_hash,r.policy_hash);
  rejected(()=>validateCapacityRequest({...r,policy_hash:capacityPolicyHash(policy())},{policy:p}));
  rejected(()=>validateCapacityRequest(request(policy()),{policy:p}));
  rejected(()=>validateCapacityRequest({...r,terminal:terminal()},{policy:p}));
  rejected(()=>validateCapacityRequest(r,{policy:withTerminal({terminal_drain_ms:40000})}));
});

test('fixed terminal constants stay the values the policy boundaries are written against',()=>{
  assert.deepEqual([TERMINAL_BUDGET_MS,SPAWN_MARGIN_MS,MIN_DRAIN_MS,MAX_DRAIN_MS,MAX_RUNTIME_MS,TAIL_MARGIN_MS],
    [5000,5000,5000,45000,70000,5000]);
});

test('terminal runtime accepts multiples of 1,000 from 10,000 to 70,000 that leave a compute window',()=>{
  for(const runtime_max_ms of [9000,10000,70500,71000,69999,70001,80000,0,-1000,1.5,NaN,Infinity,
    Number.MAX_SAFE_INTEGER+1,'70000',null,undefined,[],{},true])
    rejected(()=>validateTerminalPolicy(terminal({runtime_max_ms,terminal_drain_ms:0})));
  for(const runtime_max_ms of [16000,17000,60000,69000,70000])
    assert.equal(validateTerminalPolicy(terminal({runtime_max_ms,terminal_drain_ms:0})).runtime_max_ms,runtime_max_ms);
  assert.equal(validateTerminalPolicy(terminal()).runtime_max_ms,70000);
  // 10,000 is inside the range but cannot hold budget, spawn margin and tail margin.
  rejected(()=>validateTerminalPolicy(terminal({runtime_max_ms:10000,terminal_drain_ms:0})));
  rejected(()=>validateTerminalPolicy(terminal({runtime_max_ms:15000,terminal_drain_ms:0})));
});

test('terminal drain is zero or inside the launcher bounds',()=>{
  for(const terminal_drain_ms of [4999,45001,1,-1,-0,-5000,5000.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0','5000',
    null,undefined,false,[],{}])
    rejected(()=>validateTerminalPolicy(terminal({terminal_drain_ms})));
  for(const terminal_drain_ms of [0,5000,5001,20000,44999])
    assert.equal(validateTerminalPolicy(terminal({terminal_drain_ms,runtime_max_ms:70000})).terminal_drain_ms,terminal_drain_ms);
  assert.equal(validateTerminalPolicy(terminal({terminal_drain_ms:45000})).terminal_drain_ms,45000);
});

test('terminal tail margin stays between the snapshot, commit and kill floor and 15,000',()=>{
  for(const tail_margin_ms of [4999,15001,0,-5000,5000.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'5000',null,undefined,[],{}])
    rejected(()=>validateTerminalPolicy(terminal({tail_margin_ms,terminal_drain_ms:0})));
  for(const tail_margin_ms of [5000,5001,10000,15000])
    assert.equal(validateTerminalPolicy(terminal({tail_margin_ms,terminal_drain_ms:0})).tail_margin_ms,tail_margin_ms);
});

test('terminal runtime must be strictly above budget, drain, spawn margin and tail margin',()=>{
  const fits=({runtime_max_ms,terminal_drain_ms,tail_margin_ms})=>
    TERMINAL_BUDGET_MS+terminal_drain_ms+SPAWN_MARGIN_MS+tail_margin_ms<runtime_max_ms;
  const accepted=[[70000,45000,5000],[70000,45000,10000],[70000,44999,15000],[70000,35000,15000],[60000,44999,5000],
    [60000,0,15000],[16000,0,5000],[26000,10000,5000],[26000,5000,10000]];
  for(const [runtime_max_ms,terminal_drain_ms,tail_margin_ms] of accepted){
    const block={runtime_max_ms,terminal_drain_ms,tail_margin_ms};
    assert.equal(fits(block),true,JSON.stringify(block));
    assert.equal(validateTerminalPolicy(terminal(block)).runtime_max_ms,runtime_max_ms);
    assert.equal(validateCapacityPolicy(withTerminal(block)).terminal.terminal_drain_ms,terminal_drain_ms);
  }
  // 60,000 is not above 60,000: the equal sum is rejected, and so is any larger sum.
  const refused=[[60000,45000,5000],[70000,45000,15000],[70000,45000,15001],[60000,45000,6000],[59000,45000,5000],
    [15000,0,5000],[25000,10000,5000],[26000,11000,5000],[26000,10000,6000],[20000,45000,5000]];
  for(const [runtime_max_ms,terminal_drain_ms,tail_margin_ms] of refused){
    const block={runtime_max_ms,terminal_drain_ms,tail_margin_ms};
    assert.equal(fits(block),false,JSON.stringify(block));
    rejected(()=>validateTerminalPolicy(terminal(block)));
    rejected(()=>validateCapacityPolicy(withTerminal(block)));
  }
  // The policy validator applies the same rule to a nested block, not only the exported validator.
  assert.equal(validateCapacityPolicy(withTerminal({runtime_max_ms:70000,terminal_drain_ms:44999,tail_margin_ms:15000})).terminal.tail_margin_ms,15000);
});

test('terminal block requires the exact version and exact keys',()=>{
  for(const version of ['quant-io-terminal-policy-v2','quant-io-terminal-policy-v0','','QUANT-IO-TERMINAL-POLICY-V1',
    'quant-capacity-v2',null,undefined,1])
    rejected(()=>validateTerminalPolicy(terminal({version})));
  for(const name of Object.keys(terminal())){
    const bad=terminal();delete bad[name];
    rejected(()=>validateTerminalPolicy(bad));
    const policyBad=withTerminal();delete policyBad.terminal[name];
    rejected(()=>validateCapacityPolicy(policyBad));
  }
  for(const extra of [{extra:true},{terminal_drain:1},{runtimeMaxMs:70000},{evaluator_admission:true}]){
    rejected(()=>validateTerminalPolicy(terminal(extra)));
    rejected(()=>validateCapacityPolicy({...policy(),terminal:terminal(extra)}));
  }
  const symbol=terminal();symbol[Symbol('hidden')]=1;
  rejected(()=>validateTerminalPolicy(symbol));
  rejected(()=>validateCapacityPolicy({...policy(),terminal:symbol}));
  // A present but empty or non-object terminal key is refused, never treated as absent.
  for(const value of [undefined,null,{},[],'',0,false,'quant-io-terminal-policy-v1',()=>terminal(),[terminal()],
    new Map(Object.entries(terminal()))])
    rejected(()=>validateCapacityPolicy({...policy(),terminal:value}));
  // A block cannot ride beside the eight legacy keys under another name.
  rejected(()=>validateCapacityPolicy({...policy(),terminal_policy:terminal()}));
  rejected(()=>validateCapacityPolicy({...policy(),terminal:terminal(),extra:true}));
  const missing=policy();delete missing.scope;
  rejected(()=>validateCapacityPolicy({...missing,terminal:terminal()}));
});

test('terminal block rejects getters, accessors, class instances and non-plain prototypes',()=>{
  const getter=(target,name)=>Object.defineProperty(target,name,
    {enumerable:true,get(){throw Error('getter must not run');}});
  for(const name of Object.keys(terminal())){
    rejected(()=>validateTerminalPolicy(getter(terminal(),name)));
    rejected(()=>validateCapacityPolicy({...policy(),terminal:getter(terminal(),name)}));
  }
  const accessor=policy();Object.defineProperty(accessor,'terminal',
    {enumerable:true,get(){throw Error('getter must not run');}});
  rejected(()=>validateCapacityPolicy(accessor));
  const hidden=terminal();Object.defineProperty(hidden,'runtime_max_ms',{enumerable:false,value:70000});
  rejected(()=>validateTerminalPolicy(hidden));
  class Block{constructor(){Object.assign(this,terminal());}}
  rejected(()=>validateTerminalPolicy(new Block()));
  rejected(()=>validateTerminalPolicy(Object.create({},Object.getOwnPropertyDescriptors(terminal()))));
  rejected(()=>validateTerminalPolicy(Object.setPrototypeOf(terminal(),{inherited:true})));
  for(const value of [undefined,null,1,'terminal',true,[terminal()],[]])rejected(()=>validateTerminalPolicy(value));
  // A null-prototype data object is plain data like everywhere else in this contract.
  const bare=Object.assign(Object.create(null),terminal());
  assert.deepEqual(validateTerminalPolicy(bare),terminal());
  assert.equal(Object.getPrototypeOf(validateTerminalPolicy(bare)),Object.prototype);
});

test('terminal validator returns a detached frozen canonical copy',()=>{
  const input=terminal(),checked=validateTerminalPolicy(input);
  input.runtime_max_ms=1;input.extra=true;
  assert.deepEqual(checked,terminal());
  assert.equal(Object.isFrozen(checked),true);
  assert.equal(JSON.stringify(validateTerminalPolicy(Object.fromEntries(Object.entries(terminal()).reverse()))),
    JSON.stringify(checked));
});
