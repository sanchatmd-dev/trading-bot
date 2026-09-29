import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCapacityPolicy,validateCapacityRequest,capacityPolicyHash} from '../src/quant-research/capacity-contract.js';

const clone=value=>structuredClone(value);
const policy=()=>({version:'quant-capacity-v2',environment:'staging',
  scope:{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
    execution_model:'paper-close-v1',source_hash:'a'.repeat(64),settings_hash:'b'.repeat(64),evaluator_hash:'c'.repeat(64)},
  evidence:{calibration_sha256:'d'.repeat(64),parity_sha256:'e'.repeat(64)},max_raw_bars:1000000,max_chunk_bars:1000,
  budget:{candidates:100,max_evaluations:125,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
  io:{read_bytes:1000000,write_bytes:1000000,overshoot_read_bytes:1000,overshoot_write_bytes:1000,
    cleanup_read_bytes:2000,cleanup_write_bytes:2000}});
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
