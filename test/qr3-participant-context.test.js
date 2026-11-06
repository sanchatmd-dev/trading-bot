import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {fixedEvalFixture} from './helpers/quant-fixed-eval-fixture.mjs';
import {fixedEvalComparisonPolicyHash,fixedEvalComparisonProtocolHash} from '../src/postgres/quant-fixed-eval.js';
import {FIXED_EVAL_POLICY_KEYS,FIXED_EVAL_LIMITS,FIXED_EVAL_VERSIONS,buildFixedEvalContract,fixedEvalParametersFromParent,projectFixedEvalPolicy}
  from '../src/quant-research/fixed-eval-contract.js';
import {CONTEXT_FIELDS,contextFields,contextKey} from '../src/comparison/context.js';
import {QR3_VERSIONS,CODES} from '../src/comparison/common.js';
import {lockInputs,candidatePlan,RULES} from '../src/quant-research/contract.js';
import {buildResearchContractV2} from '../src/quant-research/research-contract-v2.js';
import {buildResearchContractV3} from '../src/quant-research/research-contract-v3.js';
import {fixture,source as FIXTURE_SOURCE} from './helpers/quant-research-fixture.mjs';
import {POLICY_KEYS,FIXED_EVAL_CONTRACT_VERSION,DATASET_TIMESTAMPS,EXECUTION_CONTEXT,VALUATION_CONTEXT,WARMUP_FLOOR,WARMUP_EMA_MULTIPLE,WARMUP_MAX,projectPolicy,
  comparisonPolicyHash,comparisonProtocolHash,warmupBarsOf,buildParticipantContext} from '../src/postgres/qr3-participant-context.js';

// QR-3 S4 frozen participant context (C1 to C16). The module restates two formulas of the fixed-evaluation admission, the 16-name policy projection, the warm-up
// rule and a few literals, because it must stay outside the evaluation closure (S3AP section 13). Every restated item is pinned here against the exports of
// the closure. The real-admission pin (the admission accepts a context built here) runs on PostgreSQL in test/postgres/qr3-routes.test.mjs.
const MINUTE=60000;
const settle=work=>{try{return {ok:true,value:work()};}catch{return {ok:false};}};
const world=()=>fixedEvalFixture();

test('the restated literals equal the exports and outputs of the evaluation closure',()=>{
  assert.deepEqual([...POLICY_KEYS],[...FIXED_EVAL_POLICY_KEYS]);
  assert.equal(FIXED_EVAL_CONTRACT_VERSION,FIXED_EVAL_VERSIONS.contract);
  assert.deepEqual([WARMUP_FLOOR,WARMUP_EMA_MULTIPLE,WARMUP_MAX],[FIXED_EVAL_LIMITS.warmupFloor,FIXED_EVAL_LIMITS.warmupEmaMultiple,FIXED_EVAL_LIMITS.warmupMax]);
  assert.equal(VALUATION_CONTEXT.grid_id,QR3_VERSIONS.grid);
  // the timestamp text is the one the fixed-evaluation contract writes into every dataset
  const f=world();
  const contract=buildFixedEvalContract({purpose:'QR3_COMPARISON',owner_id:f.owner,bot_id:f.owner,deployment_id:f.parent.deployment_id,
    lineage:{parent_run_id:f.parent.run_id,parent_contract_hash:f.parent.contract_hash,object_id:'cmp-1'},engine_hash:hash('e'),
    parameters:fixedEvalParametersFromParent({fixedInputs:f.c.input_lock.selection.fixed_inputs,selected:f.parent.result.selected.parameters}),
    capital:{initial_cash:'1000',initial_equity:'1000',initial_inventory:'0',quote:'USDT'},policy:projectFixedEvalPolicy(f.c.snapshot.policy),parent_policy:f.c.snapshot.policy,
    cost_model:{data_profile:'closed-ohlcv-atr14-v1',version:'paper-close-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},
    dataset:{start_time:f.comparison.start_ms-1005*MINUTE,end_time:f.comparison.end_ms,warmup_bars:1006,content_digest:hash('c')},
    parent_dataset_range:{start_time:f.c.dataset.start_time,end_time:f.c.dataset.end_time}});
  assert.equal(contract.dataset.timestamp_semantics,DATASET_TIMESTAMPS);
  // the execution and valuation literals are the ones of the context the admission suites already accept
  assert.deepEqual(EXECUTION_CONTEXT,f.context.execution);
  assert.deepEqual(VALUATION_CONTEXT,f.context.valuation);
});

test('C11 and C16 restated formulas equal the admission exports for the fixture parent and for varied policy, risk and rules inputs',()=>{
  const f=world(),spec=JSON.parse(f.comparison.spec_canonical);
  assert.equal(comparisonPolicyHash(f.c),fixedEvalComparisonPolicyHash(f.c));
  assert.equal(comparisonProtocolHash(f.c,spec),fixedEvalComparisonProtocolHash(f.c,spec));
  assert.equal(comparisonPolicyHash(f.c),f.context.risk_policy);
  assert.equal(comparisonProtocolHash(f.c,spec),f.context.validation_protocol);
  const variants=[];
  for(const name of FIXED_EVAL_POLICY_KEYS){
    const value=f.c.snapshot.policy[name];
    const alternative=typeof value==='boolean'?!value:typeof value==='number'?value+1:Array.isArray(value)?['ETHUSDT']:value==='BOTH'?'BUY_ONLY':'12.5';
    variants.push({name,policy:{...f.c.snapshot.policy,[name]:alternative}});
    const missing={...f.c.snapshot.policy};delete missing[name];variants.push({name:name+' missing',policy:missing});
    variants.push({name:name+' wrong type',policy:{...f.c.snapshot.policy,[name]:{nested:true}}});
    variants.push({name:name+' negative',policy:{...f.c.snapshot.policy,[name]:-1}});
  }
  variants.push({name:'extra keys are dropped',policy:{...f.c.snapshot.policy,extra:1,equities:{x:1}}},{name:'number as decimal',policy:{...f.c.snapshot.policy,maxOrderNotional:'10.5'}},
    {name:'exponent text',policy:{...f.c.snapshot.policy,maxOrderNotional:'1e3'}},{name:'not an object',policy:null},{name:'array',policy:[]});
  let accepted=0,refused=0;
  for(const variant of variants){
    const mine=settle(()=>projectPolicy(variant.policy)),theirs=settle(()=>projectFixedEvalPolicy(variant.policy));
    assert.equal(mine.ok,theirs.ok,variant.name);
    if(mine.ok){accepted+=1;assert.equal(canonical(mine.value),canonical(theirs.value),variant.name);}else refused+=1;
  }
  assert.ok(accepted>10&&refused>20,'both outcomes are exercised: '+accepted+' accepted, '+refused+' refused');
  for(const risk of ['1',1,0.5,'0.25','2.50']){
    const c=structuredClone(f.c);c.model.risk_percent=risk;
    assert.equal(comparisonPolicyHash(c),fixedEvalComparisonPolicyHash(c),'risk '+risk);
  }
  for(const drop of [2,0.5,'3','1.50']){
    const c=structuredClone(f.c);c.rules.sensitivity_max_drop_percentage_points=drop;
    assert.equal(comparisonProtocolHash(c,spec),fixedEvalComparisonProtocolHash(c,spec),'drop '+drop);
  }
  const loose=structuredClone(f.c);loose.ledger_initialization='another ledger text';
  assert.equal(comparisonProtocolHash(loose,spec),fixedEvalComparisonProtocolHash(loose,spec));
  assert.notEqual(comparisonProtocolHash(loose,spec),comparisonProtocolHash(f.c,spec));
  const other=structuredClone(spec);other.risk_filter={max_drawdown_percent:'10'};
  assert.equal(comparisonProtocolHash(f.c,other),fixedEvalComparisonProtocolHash(f.c,other));
  assert.notEqual(comparisonProtocolHash(f.c,other),comparisonProtocolHash(f.c,spec));
});

test('the warm-up rule equals the admission rule: max(1006, 5 times the slow EMA) from the selected value or else the fixed input',()=>{
  const f=world(),fixed=f.c.input_lock.selection.fixed_inputs,selected=f.parent.result.selected.parameters;
  const real=({fixedInputs,chosen})=>{
    const inputs=fixedEvalParametersFromParent({fixedInputs,selected:chosen}).inputs;
    return Math.max(WARMUP_FLOOR,WARMUP_EMA_MULTIPLE*inputs.ema_slow);
  };
  const without=fixed.filter(item=>item.pine_variable!=='emaSlowInput');
  const moved=slow=>fixed.map(item=>item.pine_variable==='emaSlowInput'?{...item,effective_value:slow}:item);
  const cases=[{name:'fixed 200',fixedInputs:fixed,chosen:selected},{name:'fixed 250',fixedInputs:moved(250),chosen:selected},{name:'fixed 1000',fixedInputs:moved(1000),chosen:selected},
    {name:'selected 300',fixedInputs:without,chosen:{...selected,emaSlowInput:300}},{name:'selected 150',fixedInputs:without,chosen:{...selected,emaSlowInput:150}}];
  for(const item of cases){
    assert.equal(warmupBarsOf({fixed_inputs:item.fixedInputs,selected:item.chosen}),real(item),item.name);
  }
  assert.equal(warmupBarsOf({fixed_inputs:fixed,selected}),1006);
  // an unreadable slow EMA has no warm-up, as the real function refuses the parameters
  assert.equal(warmupBarsOf({fixed_inputs:without,selected}),null);
  assert.throws(()=>fixedEvalParametersFromParent({fixedInputs:without,selected}));
  assert.equal(warmupBarsOf({fixed_inputs:moved(2000),selected}),null);
  assert.equal(warmupBarsOf({fixed_inputs:moved('200'),selected}),null);
});

test('the builder reproduces the context the admission suites already accept, and its key is the key of that context',()=>{
  const f=world(),spec=JSON.parse(f.comparison.spec_canonical);
  const built=buildParticipantContext({participant_id:f.parent.run_id,contract:f.c,selected:f.parent.result.selected.parameters,
    run:{run_id:f.parent.run_id,contract_hash:f.parent.contract_hash,bot_id:f.owner,deployment_id:f.parent.deployment_id},spec,spec_hash:f.comparison.spec_hash,
    period:{start_ms:f.comparison.start_ms,end_ms:f.comparison.end_ms},warmup_bars:1006,dataset_digest:f.context.dataset.digest,engine_hash:f.context.engine});
  assert.equal(built.ok,true,JSON.stringify(built));
  assert.deepEqual(built.fields,contextFields(f.parent.run_id,f.context).fields);
  assert.equal(built.context_key,f.comparison.context_key);
  assert.equal(built.context_key,contextKey(built.fields));
  assert.deepEqual(built.missing,[]);
  assert.deepEqual(Object.keys(built.fields),[...CONTEXT_FIELDS]);
  assert.equal(Object.keys(built.fields).length,16);
  // the frozen value: the context, the disclosed subject and the parent pin; no prior exposure (the store adds it)
  assert.deepEqual(Object.keys(built.freeze).sort(),['context','parent','subject']);
  assert.deepEqual(built.freeze.context,built.fields);
  assert.deepEqual(built.freeze.parent,{run_id:f.parent.run_id,contract_hash:f.parent.contract_hash});
  assert.equal(built.freeze.subject.source_hash,f.c.source_hash);
  assert.equal(built.freeze.subject.warmup_bars,1006);
  assert.deepEqual(built.freeze.subject.bridge_atr_rr,{atr_multiplier:f.parent.result.selected.parameters.atr_multiplier,rr:f.parent.result.selected.parameters.rr});
  // one change per context input changes the key
  const base=built.context_key;
  const key=over=>buildParticipantContext({participant_id:f.parent.run_id,contract:f.c,selected:f.parent.result.selected.parameters,
    run:{run_id:f.parent.run_id,contract_hash:f.parent.contract_hash,bot_id:f.owner,deployment_id:f.parent.deployment_id},spec,spec_hash:f.comparison.spec_hash,
    period:{start_ms:f.comparison.start_ms,end_ms:f.comparison.end_ms},warmup_bars:1006,dataset_digest:f.context.dataset.digest,engine_hash:f.context.engine,...over});
  assert.notEqual(key({dataset_digest:hash('other')}).context_key,base);
  assert.notEqual(key({engine_hash:hash('other engine')}).context_key,base);
  assert.notEqual(key({warmup_bars:1100}).context_key,base);
  assert.notEqual(key({period:{start_ms:f.comparison.start_ms,end_ms:f.comparison.end_ms-MINUTE}}).context_key,base);
  const rich=structuredClone(f.c);rich.model.fee_bps=11;
  assert.notEqual(key({contract:rich}).context_key,base);
});

test('the builder fails closed: no engine, no digest, a policy gap, cash not equal to equity, a bad period or a short warm-up',()=>{
  const f=world(),spec=JSON.parse(f.comparison.spec_canonical);
  const call=over=>buildParticipantContext({participant_id:f.parent.run_id,contract:f.c,selected:f.parent.result.selected.parameters,
    run:{run_id:f.parent.run_id,contract_hash:f.parent.contract_hash,bot_id:f.owner,deployment_id:f.parent.deployment_id},spec,spec_hash:f.comparison.spec_hash,
    period:{start_ms:f.comparison.start_ms,end_ms:f.comparison.end_ms},warmup_bars:1006,dataset_digest:f.context.dataset.digest,engine_hash:f.context.engine,...over});
  const refused=(answer,code,detail)=>assert.deepEqual([answer.ok,answer.code,answer.detail],[false,code,detail],JSON.stringify(answer));
  refused(call({engine_hash:undefined}),CODES.QR3_DATASET_UNAVAILABLE,'ENGINE_HASH');
  refused(call({engine_hash:'ABC'}),CODES.QR3_DATASET_UNAVAILABLE,'ENGINE_HASH');
  refused(call({dataset_digest:null}),CODES.QR3_DATASET_UNAVAILABLE,'DATASET_DIGEST');
  refused(call({warmup_bars:5}),CODES.INVALID_FIELDS,'WARMUP_BARS');
  refused(call({period:{start_ms:f.comparison.start_ms+1,end_ms:f.comparison.end_ms}}),CODES.QR3_PERIOD_INVALID,'CONTEXT_PERIOD');
  refused(call({period:{start_ms:f.comparison.end_ms,end_ms:f.comparison.start_ms}}),CODES.QR3_PERIOD_INVALID,'CONTEXT_PERIOD');
  refused(call({spec_hash:undefined}),CODES.INVALID_FIELDS,'CONTEXT_FIELDS:spec_hash');
  const gap=structuredClone(f.c);delete gap.snapshot.policy.sideMode;
  refused(call({contract:gap}),CODES.INVALID_FIELDS,'CONTEXT_SOURCE');
  const split=structuredClone(f.c);split.capital.cash='900';
  refused(call({contract:split}),CODES.INVALID_FIELDS,'CASH_NOT_EQUITY');
  refused(call({contract:null}),CODES.INVALID_FIELDS,'CONTEXT_INPUT');
  refused(buildParticipantContext(null),CODES.INVALID_FIELDS,'CONTEXT_INPUT');
});

test('RD-3: C1 to C16 are the contract list and every source path the builder reads exists in the output of both research contract builders',async()=>{
  assert.equal(CONTEXT_FIELDS.length,16);
  assert.deepEqual([...CONTEXT_FIELDS],['mode','scope','market','data_model','period','dataset','engine','execution','cost_model','capital','risk_policy','ledger_initialization',
    'valuation','benchmark','spec_hash','validation_protocol']);
  const START=1_800_000_000_000,TOTAL=20,WARMUP=5,source=FIXTURE_SOURCE;
  const f=fixture(),lock=lockInputs(f.analysis,f.selection,f.slots,f.bridge_domains),plan=candidatePlan(lock,25,27);
  const policy={paperTrading:true,requireReduceOnlySell:true};
  const snapshot={source_hash:hash(source),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital:[],membership:[]};
  const bars=Array.from({length:TOTAL},(_,index)=>({time:START+index*MINUTE,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'}));
  const common={owner_id:'owner-a',bot_id:'owner-a',deployment:{deployment_id:'3c1d0a52-7b9e-4c1a-9a26-0f1e2d3c4b5a',pine_import_id:'8a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e',source_version:1,snapshot_hash:hash('baseline')},
    source:{source,source_hash:hash(source)},snapshot,lock,plan,model:{version:'paper-close-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},
    rules:RULES,capital:{configuredEquity:'1000',configuredBalance:'1000'},engine_hash:hash('engine')};
  const v3=buildResearchContractV3({...common,dataset:{start_time:START,end_time:START+(TOTAL-1)*MINUTE,warmup_bars:WARMUP,bars,sha256:hash('bars')}});
  let v2=null;
  try{v2=buildResearchContractV2({...common,dataset:{start_time:START,end_time:START+(TOTAL-1)*MINUTE,warmup_bars:WARMUP,content_digest:hash('digest')}});}catch{v2=null;}
  assert.ok(v2!==null,'the foundation (v2) builder accepts the labelled fixture input');
  // the source paths of the builder, by context field
  const paths={scope:[['scope']],market:[['snapshot','market']],data_model:[['model','data_profile'],['model','price_tick'],['model','quantity_step']],
    cost_model:[['model','version'],['model','fee_bps'],['model','slippage_bps']],capital:[['capital','cash'],['capital','equity']],
    risk_policy:[['snapshot','policy'],['model','risk_percent']],ledger_initialization:[['ledger_initialization']],validation_protocol:[['rules','sensitivity_max_drop_percentage_points'],['ledger_initialization']],
    subject:[['source_hash'],['source_version'],['version'],['snapshot','policy_hash'],['input_lock','selection','fixed_inputs']]};
  for(const [name,contract] of [['v2',v2],['v3',v3]]){
    for(const [field,list] of Object.entries(paths))for(const path of list){
      const value=path.reduce((node,key)=>node?.[key],contract);
      assert.ok(value!==undefined&&value!==null,name+' contract lacks '+path.join('.')+' (context field '+field+')');
    }
    // the same value shapes feed the decimal readers: a number or a string, never an object
    for(const path of [['model','price_tick'],['model','quantity_step'],['model','fee_bps'],['model','slippage_bps'],['model','risk_percent'],['capital','cash'],['capital','equity'],
      ['rules','sensitivity_max_drop_percentage_points']]){
      const value=path.reduce((node,key)=>node[key],contract);
      assert.ok(['string','number'].includes(typeof value),name+' '+path.join('.'));
    }
  }
  // the fixture policy of these builders is the two-key paper policy, which has no evaluator policy: a context from it is refused, not guessed
  const spec={mode:'STANDARDIZED',adequacy:{min_episodes_floor:5,min_episodes_ranking:20},risk_filter:{max_drawdown_percent:'20'}};
  for(const contract of [v2,v3]){
    const refused=buildParticipantContext({participant_id:'run-1',contract,selected:{},run:{run_id:'run-1',contract_hash:hash('x'),bot_id:'owner-a',deployment_id:'d'},spec,spec_hash:hash('s'),
      period:{start_ms:START,end_ms:START+10*MINUTE},warmup_bars:1006,dataset_digest:hash('d'),engine_hash:hash('e')});
    assert.deepEqual([refused.ok,refused.code,refused.detail],[false,CODES.INVALID_FIELDS,'CONTEXT_SOURCE']);
  }
  // no import of the evaluation closure: the module text names none of the guarded modules
  const text=await fs.readFile(new URL('../src/postgres/qr3-participant-context.js',import.meta.url),'utf8');
  assert.equal(/fixed-eval-contract|quant-fixed-eval-engine|quant-fixed-eval-worker|quant-fixed-eval\.js/.test(text),false);
});
