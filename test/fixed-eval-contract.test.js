import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,delimiter,isAbsolute} from 'node:path';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {
  FIXED_EVAL_INPUT_FIELDS,FIXED_EVAL_POLICY_KEYS,FIXED_EVAL_PURPOSES,FIXED_EVAL_SEARCH_FRAGMENTS,FIXED_EVAL_STEPS,FIXED_EVAL_VERSIONS,
  buildFixedEvalContract,buildFixedEvalResult,expectedFixedEvalRequest,fixedEvalBindingIdentity,fixedEvalBindingParameters,
  fixedEvalContractHash,fixedEvalJobRequest,fixedEvalParametersFromParent,fixedEvalPendingMetadata,fixedEvalPolicyHash,
  fixedEvalSelectionId,fixedEvalWindow,projectFixedEvalPolicy,refuseSearchFields,validateFixedEvalBinding,validateFixedEvalContract,
  validateFixedEvalRequest,validateFixedEvalResult,validateFixedEvalStepResult
} from '../src/quant-research/fixed-eval-contract.js';

const MINUTE=60000;
const START=1_800_000_000_000; // first closed-bar timestamp of the dataset
const WARMUP=1006;
const BARS=1206;
const END=START+(BARS-1)*MINUTE;
const ENGINE=hash('engine');
const PARENT_HASH=hash('parent contract');
const DIGEST=hash('content digest');
const SEARCH='QR4_EVALUATION_SEARCH_REFUSED';
const POLICY={killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,pauseAfterLossStreak:10000,
  blockHighVolatility:false,maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',
  maxOpenPositions:3,onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,
  maxDailyNotional:100000000};
const PARENT_POLICY={...POLICY,paperTrading:true,requireReduceOnlySell:true};
const INPUTS={ema_fast:3,ema_slow:8,atr_len:14,st_factor:3.2,zone_atr_mult:1.15,setup_expiry:48,cooldown:0,confirm_lookback:5,
  sl_atr_buffer:0.6,min_risk_atr:0.5};
const COST={version:'paper-close-v1',data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'10',risk_percent:'1'};

const clone=value=>JSON.parse(JSON.stringify(value));
function input(overrides={}){
  return {purpose:'QR4_SELECTION',owner_id:'owner-1',bot_id:'bot-1',deployment_id:'deployment-1',
    lineage:{parent_run_id:'run-parent',parent_contract_hash:PARENT_HASH,object_id:'sel-1'},engine_hash:ENGINE,
    parameters:{inputs:{...INPUTS},atr_multiplier:'2',rr:'1.5'},
    capital:{initial_cash:'10000',initial_equity:'10000',initial_inventory:'0',quote:'USDT'},
    policy:{...POLICY},parent_policy:{...PARENT_POLICY},cost_model:{...COST},
    dataset:{start_time:START,end_time:END,warmup_bars:WARMUP,content_digest:DIGEST},
    parent_dataset_range:{start_time:START-5000*MINUTE,end_time:START-MINUTE},...overrides};
}
const contract=(overrides)=>buildFixedEvalContract(input(overrides));
const code=(work,expected)=>assert.throws(work,error=>{assert.equal(error.code,expected);return true;});

function binding(c=contract(),extra={}){
  const metadata=fixedEvalPendingMetadata(c);
  const raw={dataset_id:hash('raw'),sha256:hash('raw'),metadata};
  const sidecar={sha256:hash('sidecar'),bar_count:BARS,first_time:START,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'};
  return fixedEvalBindingParameters(c,{references:{raw,sidecar},dataset_sha256:hash('files'),...extra});
}
function rows(count=BARS){
  let state=12345n,price=30000,atr=40;
  return Array.from({length:count},(_,index)=>{
    state=(state*1103515245n+12345n)%(2n**31n);
    const close=Math.max(1000,price+40*Math.sin(index/90)+(Number(state)/2**31-0.5)*60);
    const high=Math.max(price,close)+5,low=Math.min(price,close)-5;
    atr=Math.max(high-low,Math.abs(high-price),Math.abs(low-price))/14+13/14*atr;
    const row={time:START+index*MINUTE,open:price.toFixed(2),high:high.toFixed(2),low:low.toFixed(2),close:close.toFixed(2),volume:'1',atr14:(atr*1.7).toFixed(6)};
    price=Number(close.toFixed(2));
    return row;
  });
}
function step(c,b,kind,overrides={}){
  const factor=kind==='EVALUATION_STRESS'?2:1;
  return {version:'fixed-eval-v1',evaluator_closure:'fixed-eval-closure-v1',kind,cost_stress:{fee_multiplier:String(factor),slippage_multiplier:String(factor)},
    model:{price_tick:'0.01',quantity_step:'0.001',fee_bps:String(10*factor),slippage_bps:String(10*factor),risk_percent:'1',version:'paper-close-v1'},
    bridge:{atr_multiplier:'2',rr:'1.5'},initial_equity:'10000',split:{warmup:WARMUP,end:BARS,evaluated_bars:BARS-WARMUP},engine_hash:c.engine_hash,
    dataset_sha256:b.dataset_sha256,parent_run_id:c.lineage.parent_run_id,selection_id:c.purpose==='QR4_SELECTION'?c.lineage.object_id:null,
    metrics_precision:80,metrics:{closed_trades:0},fills:[],fees_total:'0.000000000000000000',slippage_cost_incl_tick_total:'0.000000000000000000',
    exposure:{bars_in_market:0,bars:BARS-WARMUP,fraction:'0.000000000000000000'},episodes:{completed_count:0,completed:[]},closed_allocations:0,
    open_position:{quantity:'0.000000000000000000',allocations:0,mark_close:'1',open_episode:null},
    rejected:{total:0,intents_total:0,orphan_exits:{warmup_entry:0,refused_entry:0},by_event_type_and_reason:[]},...overrides};
}
const closure=c=>({version:'fixed-eval-closure-v1',hash:c.engine_hash});

test('a built contract carries mode, purpose, lineage and derived fields inside one immutable object',()=>{
  const c=contract();
  assert.equal(c.version,'fixed-eval-job-v1');
  assert.equal(c.mode,'FIXED_INPUT_EVAL');
  assert.equal(c.purpose,'QR4_SELECTION');
  assert.deepEqual(c.lineage,{parent_run_id:'run-parent',parent_contract_hash:PARENT_HASH,object_kind:'QR4_SELECTION',object_id:'sel-1'});
  assert.equal(c.execution_backend,'quant-foundation-v1');
  assert.equal(c.dataset.bar_count,BARS);
  assert.equal(c.dataset.first_time,START);
  assert.equal(c.policy_hash,hash(canonical(POLICY)));
  assert.equal(c.capital.initial_inventory,'0');
  assert.deepEqual(fixedEvalWindow(c),{warmup:WARMUP,end:BARS});
  assert.deepEqual(validateFixedEvalContract(c),c);
  assert.equal(fixedEvalContractHash(c),hash(canonical(c)));
  assert.equal(fixedEvalContractHash(contract()),fixedEvalContractHash(c));
  assert.deepEqual(FIXED_EVAL_PURPOSES,['QR4_SELECTION','QR3_COMPARISON']);
  assert.deepEqual(FIXED_EVAL_STEPS.map(s=>s.kind),['EVALUATION','EVALUATION_STRESS']);
});

test('the stored contract holds no search field, so the same walk that guards enqueue accepts it',()=>{
  refuseSearchFields(contract());
  refuseSearchFields(fixedEvalJobRequest(contract(),binding(),'EVALUATION',rows()));
  refuseSearchFields(expectedFixedEvalRequest(contract(),900000).pending_dataset);
});

test('the QR-3 comparison purpose builds the same job with no selection id',()=>{
  const c=contract({purpose:'QR3_COMPARISON',lineage:{parent_run_id:'run-parent',parent_contract_hash:PARENT_HASH,object_id:'cmp-1'}});
  assert.equal(c.lineage.object_kind,'QR3_COMPARISON');
  assert.equal(fixedEvalSelectionId(c),null);
  assert.equal(fixedEvalSelectionId(contract()),'sel-1');
  assert.notEqual(fixedEvalContractHash(c),fixedEvalContractHash(contract()));
  code(()=>contract({purpose:'OWNER_BACKTEST_PERIOD'}),'INVALID_FIXED_EVAL_CONTRACT');
  const forged=clone(c);forged.lineage.object_kind='QR4_SELECTION';
  code(()=>validateFixedEvalContract(forged),'INVALID_FIXED_EVAL_CONTRACT');
});

test('every search fragment is refused at any depth before anything else is read',()=>{
  for(const fragment of FIXED_EVAL_SEARCH_FRAGMENTS){
    for(const name of [fragment,fragment.toUpperCase(),'my_'+fragment+'_x']){
      code(()=>buildFixedEvalContract(input({[name]:1})),SEARCH);
      code(()=>buildFixedEvalContract(input({parameters:{inputs:{...INPUTS},atr_multiplier:'2',rr:'1.5',[name]:[1]}})),SEARCH);
      code(()=>buildFixedEvalContract(input({dataset:{start_time:START,end_time:END,warmup_bars:WARMUP,content_digest:DIGEST,extra:[{deep:{[name]:0}}]}})),SEARCH);
    }
  }
  // Search wins over a malformed remainder.
  code(()=>buildFixedEvalContract({purpose:42,seed:1}),SEARCH);
  code(()=>buildFixedEvalContract(null),'INVALID_FIXED_EVAL_CONTRACT');
});

test('the search walk is iterative, cycle safe and runs no getter',()=>{
  let deep={},node=deep;
  for(let index=0;index<200000;index++){node.next={};node=node.next;}
  refuseSearchFields(deep);
  node.budget=1;
  code(()=>refuseSearchFields(deep),SEARCH);
  const cyclic={};cyclic.self=cyclic;
  refuseSearchFields(cyclic);
  let ran=false;
  const trap={};
  Object.defineProperty(trap,'value',{enumerable:true,get(){ran=true;return {budget:1};}});
  refuseSearchFields(trap);
  assert.equal(ran,false);
  refuseSearchFields([{a:1},[{b:[2]}]]);
});

test('policy must be the parent policy projected to the 16 node names (v1 equality)',()=>{
  assert.deepEqual(Object.keys(projectFixedEvalPolicy(PARENT_POLICY)).sort(),[...FIXED_EVAL_POLICY_KEYS].sort());
  assert.equal(fixedEvalPolicyHash(PARENT_POLICY),hash(canonical(POLICY)));
  code(()=>contract({policy:{...POLICY,maxTradesPerDay:999}}),'FIXED_EVAL_POLICY_MISMATCH');
  code(()=>contract({parent_policy:{...PARENT_POLICY,sideMode:'BUY_ONLY'}}),'FIXED_EVAL_POLICY_MISMATCH');
  const missing={...POLICY};delete missing.maxDailyNotional;
  code(()=>contract({policy:missing}),'FIXED_EVAL_POLICY_INVALID');
  code(()=>contract({parent_policy:{...PARENT_POLICY,killSwitch:'no'}}),'FIXED_EVAL_POLICY_INVALID');
  // Policy values are bounded even when parent and child agree.
  for(const bad of [{maxTradesPerDay:-5},{sideMode:'LONG'},{allowedSymbols:['ETHUSDT']},{allowedSymbols:['BTCUSDT','ETHUSDT']}]){
   code(()=>contract({policy:{...POLICY,...bad},parent_policy:{...PARENT_POLICY,...bad}}),'FIXED_EVAL_POLICY_INVALID');
  }
  // No getter on the input runs: a top-level getter or a getter in parent_policy is refused without being called.
  let calls=0;
  const trap={};Object.defineProperty(trap,'purpose',{enumerable:true,get(){calls++;return 'QR4_SELECTION';}});
  code(()=>buildFixedEvalContract(trap),'INVALID_FIXED_EVAL_CONTRACT');
  const parentTrap={...PARENT_POLICY};Object.defineProperty(parentTrap,'killSwitch',{enumerable:true,get(){calls++;return false;}});
  code(()=>contract({parent_policy:parentTrap}),'FIXED_EVAL_POLICY_INVALID');
  assert.equal(calls,0);
  code(()=>contract({parent_policy:undefined}),'FIXED_EVAL_POLICY_INVALID');
  const forged=clone(contract());forged.policy.maxTradesPerDay=5;
  code(()=>validateFixedEvalContract(forged),'INVALID_FIXED_EVAL_CONTRACT');
  const extra=clone(contract());extra.policy.paperTrading=true;
  code(()=>validateFixedEvalContract(extra),'INVALID_FIXED_EVAL_CONTRACT');
});

test('parent inputs map to the ten evaluator fields and cannot be overridden',()=>{
  const fixedInputs=[
    {pine_variable:'emaFastInput',effective_value:3},{pine_variable:'emaSlowInput',effective_value:8},{pine_variable:'atrLenInput',effective_value:14},
    {pine_variable:'stFactorInput',effective_value:3.2},{pine_variable:'zoneAtrMultInput',effective_value:1.15},{pine_variable:'setupExpiryInput',effective_value:48},
    {pine_variable:'cooldownInput',effective_value:0},{pine_variable:'confirmLookback',effective_value:5},{pine_variable:'otherToggle',effective_value:true}];
  const selected={slAtrBufferInput:0.6,minRiskATRInput:0.5,atr_multiplier:2,rr:1.5};
  const parameters=fixedEvalParametersFromParent({fixedInputs,selected});
  assert.deepEqual(parameters,{inputs:INPUTS,atr_multiplier:'2',rr:'1.5'});
  assert.deepEqual(Object.values(FIXED_EVAL_INPUT_FIELDS).map(f=>f[0]).sort(),Object.keys(INPUTS).sort());
  const bad=value=>code(()=>fixedEvalParametersFromParent(value),'FIXED_EVAL_INPUTS_INVALID');
  bad({fixedInputs,selected:{...selected,emaFastInput:4}});          // fixed input cannot be overridden
  bad({fixedInputs:fixedInputs.slice(1),selected});                  // catalog input missing
  bad({fixedInputs,selected:{...selected,extraDim:1}});              // unknown selected name
  bad({fixedInputs,selected:{slAtrBufferInput:0.6,minRiskATRInput:0.5,rr:1.5}}); // bridge value missing
  bad({fixedInputs,selected:{...selected,rr:'abc'}});
  bad({fixedInputs,selected:{...selected,rr:0}});
  bad({fixedInputs,selected:{...selected,atr_multiplier:1001}});
  bad({fixedInputs:[...fixedInputs,{pine_variable:'emaFastInput',effective_value:3}],selected});
  bad({fixedInputs:fixedInputs.map(i=>i.pine_variable==='emaFastInput'?{...i,effective_value:9}:i),selected}); // fast >= slow
  bad({fixedInputs:fixedInputs.map(i=>i.pine_variable==='emaSlowInput'?{...i,effective_value:8.5}:i),selected}); // integer field
  bad({fixedInputs:fixedInputs.map(i=>i.pine_variable==='stFactorInput'?{...i,effective_value:0.05}:i),selected}); // below bound
  bad({fixedInputs:'x',selected});
  bad({fixedInputs,selected:null});
});

test('parameters, capital and cost model are exact positive decimal text',()=>{
  const bad=overrides=>code(()=>contract(overrides),'INVALID_FIXED_EVAL_CONTRACT');
  const capital=changes=>({initial_cash:'10000',initial_equity:'10000',initial_inventory:'0',quote:'USDT',...changes});
  bad({capital:capital({initial_inventory:'1'})});
  bad({capital:capital({initial_inventory:0})});
  bad({capital:capital({quote:'BUSD'})});
  for(const value of ['0','0.0','-1','1e3',' 5','5 ','05','',10000,'1'.repeat(21)])bad({capital:capital({initial_cash:value})});
  bad({capital:capital({initial_equity:'0'})});
  bad({capital:{initial_cash:'1',initial_equity:'1',initial_inventory:'0'}});
  for(const changes of [{fee_bps:'1001'},{slippage_bps:'-1'},{risk_percent:'101'},{risk_percent:'0'},{price_tick:'0'},{quantity_step:'0.0'},
    {version:'paper-close-v2'},{data_profile:'other'},{fee_bps:10}])bad({cost_model:{...COST,...changes}});
  bad({cost_model:{...COST,extra:'x'}});
  assert.equal(contract({cost_model:{...COST,fee_bps:'0',slippage_bps:'0'}}).cost_model.fee_bps,'0');
  bad({parameters:{inputs:{...INPUTS,ema_fast:8},atr_multiplier:'2',rr:'1.5'}});
  bad({parameters:{inputs:{...INPUTS,cooldown:1.5},atr_multiplier:'2',rr:'1.5'}});
  bad({parameters:{inputs:{...INPUTS,st_factor:'3'},atr_multiplier:'2',rr:'1.5'}});
  bad({parameters:{inputs:{...INPUTS,st_factor:Infinity},atr_multiplier:'2',rr:'1.5'}});
  bad({parameters:{inputs:{...INPUTS,ema_fast:undefined},atr_multiplier:'2',rr:'1.5'}});
  bad({parameters:{inputs:{...INPUTS},atr_multiplier:'0.001',rr:'1.5'}});
  bad({parameters:{inputs:{...INPUTS},atr_multiplier:2,rr:'1.5'}});
  bad({owner_id:'bad owner'});
  bad({deployment_id:''});
  bad({engine_hash:'E'.repeat(64)});
  bad({lineage:{parent_run_id:'run-parent',parent_contract_hash:'abc',object_id:'sel-1'}});
  bad({lineage:{parent_run_id:'run-parent',parent_contract_hash:PARENT_HASH,object_id:'sel-1',object_kind:'QR4_SELECTION'}});
  bad({unexpected:1});
});

test('window: warm-up floor, bar cap, minute alignment and the parent dataset overlap rule',()=>{
  const dataset=changes=>({start_time:START,end_time:END,warmup_bars:WARMUP,content_digest:DIGEST,...changes});
  const bad=overrides=>code(()=>contract(overrides),'INVALID_FIXED_EVAL_CONTRACT');
  bad({dataset:dataset({warmup_bars:1005})});
  bad({dataset:dataset({warmup_bars:BARS})});
  bad({dataset:dataset({warmup_bars:5001,end_time:START+7000*MINUTE})});
  // 5 x emaSlow raises the floor above 1006.
  const slow={inputs:{...INPUTS,ema_slow:300},atr_multiplier:'2',rr:'1.5'};
  bad({parameters:slow});
  assert.equal(contract({parameters:slow,dataset:dataset({warmup_bars:1500,end_time:START+1700*MINUTE})}).dataset.warmup_bars,1500);
  // Total bars, including the warm-up, stay within 10000.
  assert.equal(contract({dataset:dataset({end_time:START+9999*MINUTE,warmup_bars:5000})}).dataset.bar_count,10000);
  bad({dataset:dataset({end_time:START+10000*MINUTE,warmup_bars:5000})});
  bad({dataset:dataset({end_time:START})});
  bad({dataset:dataset({start_time:START+1})});
  bad({dataset:dataset({content_digest:'x'})});
  bad({dataset:{start_time:START,end_time:END,warmup_bars:WARMUP}});
  const scoredStart=START+WARMUP*MINUTE;
  // The scored part may not overlap the parent dataset; the warm-up part may.
  code(()=>contract({parent_dataset_range:{start_time:scoredStart,end_time:scoredStart+10*MINUTE}}),'FIXED_EVAL_WINDOW_OVERLAPS_PARENT');
  code(()=>contract({parent_dataset_range:{start_time:END,end_time:END+MINUTE}}),'FIXED_EVAL_WINDOW_OVERLAPS_PARENT');
  code(()=>contract({parent_dataset_range:{start_time:START-50*MINUTE,end_time:END+50*MINUTE}}),'FIXED_EVAL_WINDOW_OVERLAPS_PARENT');
  contract({parent_dataset_range:{start_time:START-100*MINUTE,end_time:scoredStart-MINUTE}});   // touches the warm-up only
  contract({parent_dataset_range:{start_time:END+MINUTE,end_time:END+9*MINUTE}});             // starts after the window
  bad({parent_dataset_range:{start_time:START+1,end_time:START+MINUTE}});
  bad({parent_dataset_range:{start_time:START-MINUTE,end_time:START-2*MINUTE}});
  // A stored contract that overlaps keeps the same refusal on validation.
  const stored=clone(contract());stored.parent_dataset_range={start_time:scoredStart,end_time:scoredStart};
  code(()=>validateFixedEvalContract(stored),'FIXED_EVAL_WINDOW_OVERLAPS_PARENT');
});

test('every stored field is pinned: a missing, extra or changed field fails validation',()=>{
  const base=contract();
  const fail=value=>code(()=>validateFixedEvalContract(value),'INVALID_FIXED_EVAL_CONTRACT');
  for(const name of Object.keys(base)){
    const dropped=clone(base);delete dropped[name];fail(dropped);
  }
  for(const section of ['lineage','parameters','capital','cost_model','dataset','parent_dataset_range']){
    const extra=clone(base);extra[section].extra=1;fail(extra);
    for(const name of Object.keys(base[section])){
      const dropped=clone(base);delete dropped[section][name];fail(dropped);
    }
  }
  const extra=clone(base);extra.extra=1;fail(extra);
  for(const [path,value] of [['version','fixed-eval-job-v2'],['mode','OTHER'],['scope','OTHER'],['execution_backend','other'],['purpose','OTHER'],
    ['dataset.timestamp_semantics','open times'],['dataset.digest_version','v0'],['dataset.first_time',START+MINUTE],['dataset.bar_count',BARS+1]]){
    const changed=clone(base);const [a,b]=path.split('.');
    if(b)changed[a][b]=value;else changed[a]=value;
    fail(changed);
  }
  fail(null);fail([]);fail('x');
  const accessor={};for(const [name,v] of Object.entries(base))Object.defineProperty(accessor,name,{enumerable:true,get:()=>v});
  fail(accessor);
  const proto=Object.create({inherited:1},Object.getOwnPropertyDescriptors(base));
  fail(proto);
});

test('validation does not mutate its input and returns an independent canonical copy',()=>{
  const base=contract();
  const before=canonical(base);
  const copy=validateFixedEvalContract(base);
  copy.parameters.inputs.ema_fast=2;
  assert.equal(canonical(base),before);
});

test('foundation request: routed on its own version, kind BACKTEST, snapshot is the parent contract hash',()=>{
  const c=contract();
  const request=expectedFixedEvalRequest(c,900000);
  assert.equal(request.version,'quant-foundation-fixed-eval-v1');
  assert.equal(request.kind,'BACKTEST');
  assert.equal(request.snapshot_hash,PARENT_HASH);
  assert.equal(request.engine_hash,ENGINE);
  assert.deepEqual(request.pending_dataset.metadata,fixedEvalPendingMetadata(c));
  assert.equal(request.pending_dataset.metadata.total_bars,BARS);
  assert.equal(request.pending_dataset.metadata.end_time,END+MINUTE);
  assert.deepEqual(request.budget,{candidates:1,max_evaluations:2,chunk_bars:BARS,max_runtime_ms:900000,max_output_bytes:8*1024*1024,max_state_bytes:1024*1024});
  assert.deepEqual(validateFixedEvalRequest(request,c),request);
  assert.deepEqual(validateFixedEvalRequest(request),request);
  assert.deepEqual(expectedFixedEvalRequest(c,1000).budget.max_runtime_ms,1000);
  const drift=(mutate,expected)=>{const value=clone(request);mutate(value);code(()=>validateFixedEvalRequest(value,c),expected);};
  drift(v=>{v.owner_id='owner-2';},'FIXED_EVAL_REQUEST_MISMATCH');
  drift(v=>{v.engine_hash=hash('other');},'FIXED_EVAL_REQUEST_MISMATCH');
  drift(v=>{v.snapshot_hash=hash('other');},'FIXED_EVAL_REQUEST_MISMATCH');
  drift(v=>{v.pending_dataset.content_digest=hash('other');},'FIXED_EVAL_REQUEST_MISMATCH');
  // The runtime cap is the one value read from the request itself: the contract does not store the job deadline.
  assert.equal(validateFixedEvalRequest(expectedFixedEvalRequest(c,899999),c).budget.max_runtime_ms,899999);
  drift(v=>{v.version='quant-foundation-v2';},'UNSUPPORTED_FOUNDATION_VERSION');
  drift(v=>{v.kind='OPTIMIZE';},'INVALID_FOUNDATION_KIND');
  drift(v=>{v.budget.max_evaluations=3;},'INVALID_FOUNDATION_BUDGET');
  drift(v=>{v.budget.candidates=2;},'INVALID_FOUNDATION_BUDGET');
  drift(v=>{v.budget.max_runtime_ms=900001;},'INVALID_FOUNDATION_BUDGET');
  drift(v=>{v.budget.chunk_bars=BARS+1;},'INVALID_FOUNDATION_BUDGET');
  drift(v=>{v.extra=1;},'INVALID_FIELDS');
  drift(v=>{v.pending_dataset.metadata.total_bars=BARS+1;},'INVALID_DATASET_INTERVAL');
  code(()=>expectedFixedEvalRequest(c,0),'INVALID_FOUNDATION_BUDGET');
  code(()=>expectedFixedEvalRequest(c,900001),'INVALID_FOUNDATION_BUDGET');
});

test('dataset binding is write-once data checked against the contract, tick, step and digest',()=>{
  const c=contract(),b=binding(c);
  assert.equal(b.version,'fixed-eval-dataset-binding-v1');
  assert.deepEqual(validateFixedEvalBinding(c,b),b);
  assert.equal(fixedEvalBindingIdentity(c,b),fixedEvalBindingIdentity(c,clone(b)));
  assert.equal(fixedEvalBindingIdentity(c,b),hash(canonical({contract:c,parameters:b,kind:'PREPARE'})));
  assert.notEqual(fixedEvalBindingIdentity(c,b),fixedEvalBindingIdentity(c,binding(c,{dataset_sha256:hash('other files')})));
  const bad=mutate=>{const value=clone(b);mutate(value);code(()=>validateFixedEvalBinding(c,value),'FIXED_EVAL_DATASET_BINDING_INVALID');};
  bad(v=>{v.version='x';});
  bad(v=>{v.dataset_sha256=hash('forged');});
  bad(v=>{v.content_digest=hash('forged');});
  bad(v=>{v.bar_count=BARS-1;});
  bad(v=>{v.execution_contract_hash=hash('forged');});
  bad(v=>{v.references.sidecar.price_tick='0.1';});
  bad(v=>{v.references.sidecar.quantity_step='0.01';});
  bad(v=>{v.references.sidecar.profile='other';});
  bad(v=>{v.references.sidecar.bar_count=BARS-1;});
  bad(v=>{v.references.sidecar.first_time=START+MINUTE;});
  bad(v=>{v.references.raw.metadata.warmup_bars=WARMUP-1;});
  bad(v=>{v.references.raw.sha256=hash('other');});
  bad(v=>{v.extra=1;});
  const other=contract({capital:{initial_cash:'20000',initial_equity:'20000',initial_inventory:'0',quote:'USDT'}});
  code(()=>validateFixedEvalBinding(other,b),'FIXED_EVAL_DATASET_BINDING_INVALID');
  code(()=>fixedEvalBindingParameters(c,{references:b.references}),'FIXED_EVAL_DATASET_BINDING_INVALID');
  code(()=>fixedEvalBindingParameters(c,{references:b.references,dataset_sha256:'x'}),'FIXED_EVAL_DATASET_BINDING_INVALID');
});

test('the job request has exactly the keys of the Python evaluator and echoes the frozen identities',()=>{
  const c=contract(),b=binding(c),data=rows();
  const request=fixedEvalJobRequest(c,b,'EVALUATION',data);
  assert.deepEqual(Object.keys(request).sort(),['contract','kind','parameters','split']);
  assert.deepEqual(request.split,{warmup:WARMUP,end:BARS});
  assert.deepEqual(request.parameters,c.parameters);
  assert.equal(request.contract.rows.length,BARS);
  assert.deepEqual(request.contract.model,{price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'10',risk_percent:'1',version:'paper-close-v1'});
  assert.deepEqual(request.contract.policy,POLICY);
  assert.equal(request.contract.engine_hash,ENGINE);
  assert.equal(request.contract.dataset_sha256,b.dataset_sha256);
  assert.equal(request.contract.parent_run_id,'run-parent');
  assert.equal(request.contract.selection_id,'sel-1');
  assert.equal(request.contract.broker,'binance-global');
  assert.equal(request.contract.symbol,'BTCUSDT');
  assert.equal(request.contract.initial_cash,'10000');
  assert.equal(fixedEvalJobRequest(c,b,'EVALUATION_STRESS',data).kind,'EVALUATION_STRESS');
  const comparison=contract({purpose:'QR3_COMPARISON',lineage:{parent_run_id:'run-parent',parent_contract_hash:PARENT_HASH,object_id:'cmp-1'}});
  assert.equal(fixedEvalJobRequest(comparison,binding(comparison),'EVALUATION',data).contract.selection_id,null);
  // Extra row keys are dropped, not forwarded.
  const withExtra=data.map(row=>({...row,price_tick:'0.01',quantity_step:'0.001'}));
  assert.deepEqual(fixedEvalJobRequest(c,b,'EVALUATION',withExtra).contract.rows,data);
  const bad=(mutate,rowsValue=clone(data),kind='EVALUATION')=>{mutate(rowsValue);code(()=>fixedEvalJobRequest(c,b,kind,rowsValue),'FIXED_EVAL_ROWS_INVALID');};
  bad(()=>{},data.slice(1));
  bad(()=>{},[...data,data[0]]);
  bad(r=>{r[5].time+=MINUTE;});
  bad(r=>{r[5].time=r[4].time;});
  bad(r=>{delete r[5].atr14;});
  bad(r=>{r[5].close=null;});
  bad(r=>{r[5].open='1e3';});
  bad(r=>{r[5].high=true;});
  bad(()=>{},clone(data),'EVALUATE');
  bad(()=>{},'rows');
  code(()=>fixedEvalJobRequest(c,{...b,dataset_sha256:hash('x')},'EVALUATION',data),'FIXED_EVAL_DATASET_BINDING_INVALID');
});

test('a step result must echo the contract: closure constant, identities, window, stress and model',()=>{
  const c=contract(),b=binding(c);
  const ok=step(c,b,'EVALUATION');
  assert.deepEqual(validateFixedEvalStepResult(c,b,'EVALUATION',ok),ok);
  assert.deepEqual(validateFixedEvalStepResult(c,b,'EVALUATION_STRESS',step(c,b,'EVALUATION_STRESS')).kind,'EVALUATION_STRESS');
  const bad=(overrides,kind='EVALUATION')=>code(()=>validateFixedEvalStepResult(c,b,kind,step(c,b,kind,overrides)),'FIXED_EVAL_RESULT_INVALID');
  bad({evaluator_closure:'NOT_IN_ENGINE_CLOSURE'});
  bad({evaluator_closure:'fixed-eval-closure-v2'});
  bad({version:'fixed-eval-v2'});
  bad({kind:'EVALUATION_STRESS'});
  bad({engine_hash:hash('other')});
  bad({engine_hash:null});
  bad({dataset_sha256:hash('other')});
  bad({parent_run_id:'run-other'});
  bad({selection_id:null});
  bad({selection_id:'sel-2'});
  bad({split:{warmup:WARMUP-1,end:BARS,evaluated_bars:BARS-WARMUP+1}});
  bad({split:{warmup:WARMUP,end:BARS-1,evaluated_bars:BARS-WARMUP-1}});
  bad({cost_stress:{fee_multiplier:'2',slippage_multiplier:'2'}});
  bad({cost_stress:{fee_multiplier:'1',slippage_multiplier:'2'}},'EVALUATION_STRESS');
  bad({model:{...ok.model,fee_bps:'20'}});
  bad({model:{...ok.model,slippage_bps:'11'}});
  bad({model:{...ok.model,price_tick:'0.1'}});
  bad({model:{...ok.model,version:'paper-close-v2'}});
  bad({bridge:{atr_multiplier:'3',rr:'1.5'}});
  bad({initial_equity:'9999'});
  bad({metrics_precision:28});
  bad({fills:{}});
  bad({closed_allocations:1});
  bad({extra:1});
  const dropped=step(c,b,'EVALUATION');delete dropped.rejected;
  code(()=>validateFixedEvalStepResult(c,b,'EVALUATION',dropped),'FIXED_EVAL_RESULT_INVALID');
  code(()=>validateFixedEvalStepResult(c,b,'OTHER',ok),'FIXED_EVAL_RESULT_INVALID');
  // Numeric echo compares as decimals: 20.0 is the doubled 10 fee.
  const doubled=step(c,b,'EVALUATION_STRESS');doubled.model.fee_bps='20.00';
  validateFixedEvalStepResult(c,b,'EVALUATION_STRESS',doubled);
});

test('the stored result pairs both steps and the evaluation closure that equals the frozen engine hash',()=>{
  const c=contract(),b=binding(c);
  const base=step(c,b,'EVALUATION'),stress=step(c,b,'EVALUATION_STRESS');
  const result=buildFixedEvalResult(c,b,{base,stress},closure(c));
  assert.equal(result.version,'fixed-eval-result-v1');
  assert.deepEqual(result.evaluation_closure,{version:'fixed-eval-closure-v1',hash:ENGINE});
  assert.deepEqual(result.lineage,c.lineage);
  assert.deepEqual(validateFixedEvalResult(c,b,result),result);
  code(()=>buildFixedEvalResult(c,b,{base,stress},{version:'fixed-eval-closure-v1',hash:hash('other')}),'FIXED_EVAL_RESULT_INVALID');
  code(()=>buildFixedEvalResult(c,b,{base,stress},{version:'fixed-eval-closure-v2',hash:ENGINE}),'FIXED_EVAL_RESULT_INVALID');
  code(()=>buildFixedEvalResult(c,b,{base:stress,stress:base},closure(c)),'FIXED_EVAL_RESULT_INVALID');
  code(()=>buildFixedEvalResult(c,b),'FIXED_EVAL_RESULT_INVALID');
  code(()=>buildFixedEvalResult(c,b,null,closure(c)),'FIXED_EVAL_RESULT_INVALID');
  const forged=clone(result);forged.stress.metrics.closed_trades=9;
  validateFixedEvalResult(c,b,forged); // metric values are the valuation layer's concern, not this contract's
  const swapped=clone(result);swapped.purpose='QR3_COMPARISON';
  code(()=>validateFixedEvalResult(c,b,swapped),'FIXED_EVAL_RESULT_INVALID');
  const moved=clone(result);moved.lineage.object_id='sel-2';
  code(()=>validateFixedEvalResult(c,b,moved),'FIXED_EVAL_RESULT_INVALID');
  const closed=clone(result);closed.evaluation_closure.hash=hash('other');
  code(()=>validateFixedEvalResult(c,b,closed),'FIXED_EVAL_RESULT_INVALID');
});

// --- the real Python evaluator through the job wrapper ---
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const configuredPython=process.env.QUANT_RESEARCH_PYTHON;
const python=configuredPython?(isAbsolute(configuredPython)?configuredPython:null):(existsSync(localPython)?localPython:null);
const environment={...process.env,PYTHONPATH:[resolve(root,'quant_lab','src'),process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
const probe=python===null?null:spawnSync(python,['-B','-s','-c','import robot_quant.fixed_eval_job'],{encoding:'utf8',timeout:180000,env:environment});
const pythonReady=probe!==null&&!probe.error&&probe.status===0;
const NO_PYTHON='python runtime or quant dependencies unavailable here (set QUANT_RESEARCH_PYTHON to an absolute path or create quant_lab/.venv)';
// PF2_REQUIRE_PYTHON=1 (the Quant Lab CI job) turns a would-be skip into a failure.
const needPython=t=>{if(pythonReady)return false;assert.notEqual(process.env.PF2_REQUIRE_PYTHON,'1','PF2_REQUIRE_PYTHON=1: '+NO_PYTHON);t.skip(NO_PYTHON);return true;};
function runJob(request){
  const child=spawnSync(python,['-B','-s','-m','robot_quant.fixed_eval_job'],{input:JSON.stringify(request),encoding:'utf8',timeout:180000,env:environment,maxBuffer:64*1024*1024});
  assert.equal(child.stderr,'');
  return {status:child.status,frame:JSON.parse(child.stdout)};
}

test('real evaluator: contract to job request to step result to stored result validates end to end',t=>{
  if(needPython(t))return;
  const c=contract(),b=binding(c),data=rows();
  const results={};
  for(const {kind} of FIXED_EVAL_STEPS){
    const {status,frame}=runJob(fixedEvalJobRequest(c,b,kind,data));
    assert.equal(status,0);
    assert.deepEqual(Object.keys(frame).sort(),['checkpoint','result']);
    assert.equal(frame.checkpoint,null);
    assert.equal(frame.result.evaluator_closure,FIXED_EVAL_VERSIONS.closure);
    results[kind]=validateFixedEvalStepResult(c,b,kind,frame.result);
  }
  const stored=buildFixedEvalResult(c,b,{base:results.EVALUATION,stress:results.EVALUATION_STRESS},closure(c));
  assert.equal(stored.base.split.evaluated_bars,BARS-WARMUP);
  assert.notEqual(stored.stress.fees_total,undefined);
  // Cost stress changes cost only: the same bars give the same fills count at 2x fees.
  assert.equal(results.EVALUATION_STRESS.fills.length,results.EVALUATION.fills.length);
  // A QR-3 comparison echoes no selection id.
  const comparison=contract({purpose:'QR3_COMPARISON',lineage:{parent_run_id:'run-parent',parent_contract_hash:PARENT_HASH,object_id:'cmp-1'}});
  const bound=binding(comparison);
  const run=runJob(fixedEvalJobRequest(comparison,bound,'EVALUATION',data));
  assert.equal(run.frame.result.selection_id,null);
  validateFixedEvalStepResult(comparison,bound,'EVALUATION',run.frame.result);
  // The result of one contract does not validate under another.
  code(()=>validateFixedEvalStepResult(c,b,'EVALUATION',run.frame.result),'FIXED_EVAL_RESULT_INVALID');
});

test('real evaluator refuses a search field and a mismatched identity as an error frame',t=>{
  if(needPython(t))return;
  const c=contract(),b=binding(c);
  const request=fixedEvalJobRequest(c,b,'EVALUATION',rows());
  const searched=clone(request);searched.parameters.seed=1;
  const refused=runJob(searched);
  assert.equal(refused.status,1);
  assert.deepEqual(refused.frame,{error:SEARCH});
  const noEngine=clone(request);noEngine.contract.engine_hash=null;
  assert.deepEqual(runJob(noEngine).frame,{error:'QR4_EVALUATION_INPUT_INVALID:contract.engine_hash'});
});
