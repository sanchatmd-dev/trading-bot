import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {CANDIDATE_BLOCKERS} from '../src/quant-library/package-gates.js';
import {FOUNDATION_LIMITS} from '../src/quant-research/foundation-contract.js';
import {RULES} from '../src/quant-research/contract.js';
import {buildResearchContractV2} from '../src/quant-research/research-contract-v2.js';
import {MP_CODES,MP_CODE_LIST,MP_CODE_PATTERN,MP_MODE,MP_SAME_BAR_ORDER,MULTI_PINE_CONTRACT_VERSION,MULTI_PINE_BLOCKER} from '../src/multi-pine/codes.js';
import {buildMemberSet} from '../src/multi-pine/member-set.js';
import {buildMultiResearchContract,validateMultiResearchContract,MULTI_RUN_CONTRACT_KEYS,MULTI_RUN_INPUT_KEYS,MULTI_RUN_ACCEPTANCE_BLOCKERS} from '../src/multi-pine/run-contract.js';

/*
 * F11-01 S2 (research run contract). Every object below is a LABELLED ENGINEERING FIXTURE (fixture: true): synthetic rows, never a
 * research result. The module is pure, so no database, clock, network or file is used by it. Expected hashes are derived in this
 * file with an independent canonical-JSON writer and node:crypto, not with the module under test.
 */
const OWNER='owner-a',BOT='bot-a';
const SET_A='5b0c7a52-1d3e-4f60-8a71-2c9d4e6f8a01',SET_B='6c1d8b63-2e4f-4071-9b82-3dae5f7a9b02';
const T1='2026-10-20T10:00:00Z';

const ref=value=>Array.isArray(value)?'['+value.map(ref).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+ref(value[k])).join(',')+'}':JSON.stringify(value);
const sha=text=>createHash('sha256').update(text).digest('hex');
const clone=value=>structuredClone(value);
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reorder(value[k])])):value;

// ---------------------------------------------------------------- fixture: a frozen member set (S1 builder) and a run input

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};

function member(n,over={}) {
  return {n,pine:`pine-${n}`,version:2,sourceHash:sha('source-'+n),inputsHash:sha('inputs-'+n),dep:`dep-${n}`,pair:{atr_multiplier:2,rr:1.5},
    exit:'bridge-exit-v2',model:MODEL,artifact:sha('artifact-'+n),policy:POLICY,capital:CAPITAL,funding:7,ref:`fixture-ref-${n}`,...over};
}
function evidenceFor(m,snapshot,snapshotHash) {
  return {snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
    binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
    effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(m.model),
    references:{tradingview:m.ref+'-tv',source_review:m.ref+'-sr',paper_fixture:m.ref+'-pf'}};
}
function deployment(m,projection,ids={owner:OWNER,bot:BOT}) {
  const snapshot=structuredClone({policy:m.policy,policy_hash:sha(ref(m.policy)),capital:m.capital,funding_cutoff:m.funding,membership:projection,
    session:{state:'SETUP',run_id:null},captured_at:1,selection:{bridge:m.pair,bindings:[]},market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:m.version,...MARKET},
    source_hash:m.sourceHash,instruction_versions:{template:'fixture'},artifact_hash:m.artifact});
  const snapshotHash=sha(ref(snapshot));
  const body=evidenceFor(m,snapshot,snapshotHash);
  return {
    row:{deployment_id:m.dep,owner_id:ids.owner,bot_id:ids.bot,pine_import_id:m.pine,source_version:m.version,state:'DRAFT',snapshot,snapshot_hash:snapshotHash,exit_version:m.exit},
    evidence:{deployment_id:m.dep,snapshot_hash:snapshotHash,evidence:body,evidence_hash:sha(ref(body))}
  };
}
function world(specs,memberSetId=SET_A,ids={owner:OWNER,bot:BOT}) {
  const memberships=specs.map(m=>({pine_import_id:m.pine,owner_id:ids.owner,bot_id:ids.bot,source_version:m.version,source_hash:m.sourceHash,connected:true,
    analysis:{effective_inputs_hash:m.inputsHash,inputs:[{input_id:'i'+m.n}]}}));
  const projection=memberships.slice().sort((a,b)=>a.pine_import_id<b.pine_import_id?-1:1)
    .map(r=>({pine_import_id:r.pine_import_id,source_version:r.source_version,source_hash:r.source_hash,analysis:r.analysis}));
  const built=specs.map(m=>deployment(m,projection,ids));
  const first=specs[0];
  const bot_state={policy_hash:sha(ref(first.policy)),capital_basis_hash:sha(ref(first.capital.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance})))),funding_cutoff:first.funding};
  return {owner_id:ids.owner,bot_id:ids.bot,fixture:true,member_set_id:memberSetId,created_at:T1,bot_state,
    member_deployments:specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep})),memberships,deployments:built.map(b=>b.row),evidence:built.map(b=>b.evidence)};
}
function frozenSet(specs=[member(1),member(2)],id=SET_A,ids) {
  const out=buildMemberSet(world(specs,id,ids));
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.member_set;
}

const START=29333333*60000;
const BARS=5000;
const RULE_VALUES={...RULES};
function runInput(set=frozenSet(),over={}) {
  return {
    member_set:clone(set),member_set_id:set.member_set_id,set_hash:set.set_hash,membership_hash:set.membership_hash,pine_count:set.pine_count,members:clone(set.members),
    owner_id:set.owner_id,bot_id:set.bot_id,policy_hash:set.policy_hash,funding_cutoff:set.funding_cutoff,
    capital_accounts:clone(CAPITAL),model:clone(MODEL),rules:clone(RULE_VALUES),engine_hash:sha('engine'),
    dataset:{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,content_digest:sha('digest')},
    budget:{candidates:30},seed:42,
    bridge_domains:{atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'}},fixture:true,...over
  };
}

// Every code any call returns in this file, so the final test proves coverage and the code pattern.
const seen=new Set();
const note=out=>{if(out&&out.ok===false)seen.add(out.code);return out;};
const build=input=>note(buildMultiResearchContract(input));
const validate=value=>note(validateMultiResearchContract(value));
const good=input=>{const out=build(input);assert.equal(out.ok,true,JSON.stringify(out));return out.contract;};
const refusedBuild=(input,code,field)=>{
  const out=build(input);
  assert.equal(out.ok,false,'expected refusal '+code+' '+field);
  assert.equal(out.code,code,JSON.stringify(out));
  assert.equal(out.diagnostic.stage,'input');
  if(field!==undefined)assert.equal(out.diagnostic.field,field,JSON.stringify(out));
  return out;
};
const refusedValidate=(value,code,field)=>{
  const out=validate(value);
  assert.equal(out.ok,false,'expected refusal '+code+' '+field);
  assert.equal(out.code,code,JSON.stringify(out));
  assert.equal(out.diagnostic.stage,'contract');
  if(field!==undefined)assert.equal(out.diagnostic.field,field,JSON.stringify(out));
  return out;
};
const edit=(base,fn)=>{const copy=clone(base);fn(copy);return copy;};
const setAt=(object,pathText,value)=>{
  const parts=pathText.split('.');
  let target=object;
  for(const part of parts.slice(0,-1))target=target[part];
  target[parts.at(-1)]=value;
};
const getAt=(object,pathText)=>pathText.split('.').reduce((target,part)=>target[part],object);

const WRONG_TYPES=[null,'x',[],{},true,12345];
/** A frozen set whose members all carry these paper accounts, and the matching run input over: capital_accounts equal the set's basis. */
const withAccounts=(accounts,over={})=>{
  const set=frozenSet([member(1,{capital:accounts}),member(2,{capital:accounts})]);
  return {set,input:runInput(set,{capital_accounts:clone(accounts),...over})};
};
/** Validator input for a stored contract whose dataset has this many bars (derived fields follow). */
const withBars=(contract,bars,warmup)=>edit(contract,c=>{
  c.dataset.end_time=c.dataset.start_time+(bars-1)*60000;c.dataset.bar_count=bars;c.dataset.warmup_bars=warmup;
  const count=bars-warmup;
  c.split={warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:bars};
});

// ---------------------------------------------------------------- constants

test('constants: frozen names, key lists and the blocker list (section 5.8, RD-MP-1, RD-MP-10)',()=>{
  assert.equal(MULTI_PINE_CONTRACT_VERSION,'ql3a-research-job-multi-v1');
  assert.deepEqual([...MULTI_RUN_ACCEPTANCE_BLOCKERS],['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','MULTI_PINE_REQUIRES_APP_3B']);
  assert.deepEqual([...MULTI_RUN_ACCEPTANCE_BLOCKERS],[...CANDIDATE_BLOCKERS,MULTI_PINE_BLOCKER]);
  assert.ok(Object.isFrozen(MULTI_RUN_ACCEPTANCE_BLOCKERS)&&Object.isFrozen(MULTI_RUN_CONTRACT_KEYS)&&Object.isFrozen(MULTI_RUN_INPUT_KEYS));
  assert.equal(MULTI_RUN_CONTRACT_KEYS.length,23);
  assert.equal(new Set(MULTI_RUN_CONTRACT_KEYS).size,23);
  for(const absent of ['deployment_id','pine_import_id','source_version'])assert.ok(!MULTI_RUN_CONTRACT_KEYS.includes(absent)&&!MULTI_RUN_INPUT_KEYS.includes(absent),absent);
  assert.ok(MULTI_RUN_INPUT_KEYS.includes('capital_accounts')&&!MULTI_RUN_INPUT_KEYS.includes('capital'));
  assert.ok(!MULTI_RUN_INPUT_KEYS.includes('max_evaluations'));
  for(const needed of ['version','mode','pine_count','member_set_id','set_hash','membership_hash','members','bridge_domains','same_bar_order','fixture','acceptance_blockers',
    'owner_id','bot_id','policy_hash','capital','funding_cutoff','model','rules','engine_hash','dataset','split','budget','seed'])
    assert.ok(MULTI_RUN_CONTRACT_KEYS.includes(needed),needed);
});

// ---------------------------------------------------------------- happy path

test('happy path: two members build one contract with every section 5.8 field',()=>{
  const set=frozenSet();
  const input=runInput(set);
  const before=ref(input);
  const contract=good(input);
  assert.equal(ref(input),before,'the input is not mutated');
  assert.deepEqual(Object.keys(contract).sort(),[...MULTI_RUN_CONTRACT_KEYS].sort());
  assert.equal(contract.version,'ql3a-research-job-multi-v1');
  assert.equal(contract.mode,MP_MODE);
  assert.equal(contract.mode,'MULTI_PINE');
  assert.equal(contract.pine_count,2);
  assert.equal(contract.member_set_id,SET_A);
  assert.equal(contract.set_hash,set.set_hash);
  assert.equal(contract.membership_hash,set.membership_hash);
  assert.deepEqual(contract.members,set.members);
  assert.deepEqual(contract.members.map(m=>m.ordinal),[1,2]);
  assert.deepEqual(Object.keys(contract.members[0]).sort(),['deployment_id','deployment_snapshot_hash','effective_inputs_hash','evidence_hash','exit_version','ordinal','pine_import_id','source_hash','source_version'].sort());
  assert.equal(contract.owner_id,OWNER);
  assert.equal(contract.bot_id,BOT);
  assert.equal(contract.policy_hash,set.policy_hash);
  assert.equal(contract.funding_cutoff,7);
  assert.deepEqual(contract.capital,{equity:'1000',cash:'1000'});
  assert.deepEqual(contract.model,MODEL);
  assert.equal(sha(ref(contract.model)),set.execution_model_hash);
  assert.deepEqual(contract.rules,RULE_VALUES);
  assert.equal(contract.engine_hash,sha('engine'));
  assert.deepEqual(contract.dataset,{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,bar_count:BARS,first_time:START,
    timestamp_semantics:'verified closed-bar timestamps; half-open index end is last timestamp plus one minute',content_digest:sha('digest'),digest_version:'pine-bar-content-digest-v1'});
  assert.deepEqual(contract.split,{warmup:500,train_end:500+Math.floor(4500*.6),validation_end:500+Math.floor(4500*.8),test_end:BARS});
  assert.deepEqual(contract.split,{warmup:500,train_end:3200,validation_end:4100,test_end:5000});
  assert.deepEqual(contract.budget,{candidates:30});
  assert.equal(contract.seed,42);
  assert.deepEqual(contract.bridge_domains,{atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'}});
  assert.equal(contract.same_bar_order,MP_SAME_BAR_ORDER);
  assert.equal(contract.same_bar_order,'exit-first-ordinal-v1');
  assert.equal(contract.fixture,true);
  assert.deepEqual(contract.acceptance_blockers,['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','MULTI_PINE_REQUIRES_APP_3B']);
  for(const absent of ['deployment_id','pine_import_id','source_version','scope','source','snapshot','input_lock','plan'])assert.ok(!Object.hasOwn(contract,absent),absent);
});

test('happy path: three members, other pair and budget; the output is a copy, not the input',()=>{
  const set=frozenSet([member(1,{pair:{atr_multiplier:'2.5',rr:'3'}}),member(2,{pair:{atr_multiplier:'2.5',rr:'3'}}),member(3,{pair:{atr_multiplier:'2.5',rr:'3'}})],SET_B);
  const input=runInput(set,{budget:{candidates:100},seed:0,
    bridge_domains:{atr_multiplier:{min:'0.01',max:'5',step:'0.01'},rr:{min:'1',max:'4',step:'1'}}});
  const contract=good(input);
  assert.equal(contract.pine_count,3);
  assert.equal(contract.member_set_id,SET_B);
  assert.deepEqual(contract.members.map(m=>m.ordinal),[1,2,3]);
  assert.deepEqual(contract.budget,{candidates:100});
  assert.equal(contract.seed,0);
  contract.members[0].ordinal=99;
  contract.capital.equity='1';
  assert.equal(input.members[0].ordinal,1);
  assert.equal(input.member_set.members[0].ordinal,1);
  assert.equal(input.capital_accounts[0].configuredEquity,1000);
});

test('happy path: smallest and largest accepted values',()=>{
  const extremes=[{broker:'binance-global',configuredEquity:'0.00000001',configuredBalance:'99999999999999999999.99'}];
  const big=withAccounts(extremes,{budget:{candidates:1},seed:2147483647,dataset:{start_time:START,end_time:START+(FOUNDATION_LIMITS.admittedBars-1)*60000,warmup_bars:5000,content_digest:sha('d')}});
  assert.deepEqual(good(big.input).capital,{equity:'0.00000001',cash:'99999999999999999999.99'});
  // smallest sample: exactly 2000 compared bars after warm-up, no warm-up
  const small=good(runInput(frozenSet(),{dataset:{start_time:START,end_time:START+1999*60000,warmup_bars:0,content_digest:sha('d')},
    bridge_domains:{atr_multiplier:{min:'1',max:'1000',step:'1'},rr:{min:'0.5',max:'500',step:'0.5'}}}));
  assert.equal(small.dataset.bar_count,2000);
  assert.deepEqual(small.split,{warmup:0,train_end:1200,validation_end:1600,test_end:2000});
});

// ---------------------------------------------------------------- builder refusals

test('builder refusals: input shape, closed key list, absent one-Pine top-level keys',()=>{
  for(const bad of [null,undefined,'x',7,[],true])refusedBuild(bad,'MP_INPUT_INVALID','input');
  refusedBuild(Object.create({member_set:1}),'MP_INPUT_INVALID','input');
  for(const key of ['deployment_id','pine_import_id','source_version'])
    for(const value of ['dep-1','pine-1',2,null])refusedBuild(runInput(frozenSet(),{[key]:value}),'MP_INPUT_INVALID','input.'+key);
  for(const key of ['mode','scope','source','snapshot','plan','input_lock','extra','created_at','acceptance_blockers','dataset_ref','split','same_bar_order','version'])
    refusedBuild(runInput(frozenSet(),{[key]:'x'}),'MP_INPUT_INVALID','input.'+key);
  // a getter or a special prototype is no plain JSON
  const getter=runInput();
  Object.defineProperty(getter,'seed',{get:()=>42,enumerable:true});
  refusedBuild(getter,'MP_INPUT_INVALID','input');
  refusedBuild(runInput(frozenSet(),{dataset:Object.assign(Object.create({a:1}),runInput().dataset)}),'MP_INPUT_INVALID','input');
  refusedBuild(runInput(frozenSet(),{seed:NaN}),'MP_INPUT_INVALID','input');
  refusedBuild(runInput(frozenSet(),{rules:{...RULE_VALUES,maximum_drawdown_percent:Infinity}}),'MP_INPUT_INVALID','input');
  refusedBuild(runInput(frozenSet(),{seed:undefined}),'MP_INPUT_INVALID','input');
});

test('builder refusals: owner_id and bot_id of the frozen set must be identifiers, checked right after the freeze check',()=>{
  const odd=frozenSet([member(1),member(2)],SET_A,{owner:'owner a',bot:BOT});
  const out=refusedBuild(runInput(odd),'MP_INPUT_INVALID','owner_id');
  assert.equal(out.diagnostic.against,'member_set');
  // even a claim that equals the set is refused, and the claim loop and later fields are not reached
  refusedBuild(runInput(odd,{seed:'x'}),'MP_INPUT_INVALID','owner_id');
  const oddBot=frozenSet([member(1),member(2)],SET_A,{owner:OWNER,bot:'-bot'});
  assert.equal(refusedBuild(runInput(oddBot),'MP_INPUT_INVALID','bot_id').diagnostic.against,'member_set');
  good(runInput(frozenSet([member(1),member(2)],SET_A,{owner:'Owner_1.x:y-z',bot:'b0'})));
});

test('builder refusals: fixture must be true',()=>{
  for(const value of [false,'true',1,0,null,[],{}])refusedBuild(runInput(frozenSet(),{fixture:value}),'MP_FIXTURE_ONLY','fixture');
  // undefined is no JSON value
  refusedBuild(runInput(frozenSet(),{fixture:undefined}),'MP_INPUT_INVALID','input');
  const missing=runInput();
  delete missing.fixture;
  refusedBuild(missing,'MP_FIXTURE_ONLY','fixture');
  // a fixture refusal comes after the closed key check and before the content checks
  refusedBuild(runInput(frozenSet(),{fixture:false,extra:1}),'MP_INPUT_INVALID','input.extra');
  refusedBuild(runInput(frozenSet(),{fixture:false,seed:'x'}),'MP_FIXTURE_ONLY','fixture');
});

test('builder refusals: every key is required and every wrong type is refused',()=>{
  for(const key of MULTI_RUN_INPUT_KEYS) {
    const input=runInput();
    delete input[key];
    if(key==='fixture')refusedBuild(input,'MP_FIXTURE_ONLY','fixture');
    else refusedBuild(input,'MP_INPUT_INVALID',key);
  }
  for(const key of MULTI_RUN_INPUT_KEYS)
    for(const wrong of WRONG_TYPES) {
      if(key==='fixture'&&wrong===true)continue;
      if(key==='seed'&&wrong===12345)continue;
      const input=runInput(frozenSet(),{[key]:wrong});
      if(key==='fixture')refusedBuild(input,'MP_FIXTURE_ONLY','fixture');
      else refusedBuild(input,'MP_INPUT_INVALID',key);
    }
});

test('builder refusals: the member set must be a valid frozen S1 record',()=>{
  const set=frozenSet();
  const tamper=(fn)=>{const input=runInput(set);fn(input.member_set);return input;};
  for(const fn of [
    s=>{s.set_hash=sha('other');},
    s=>{s.content_digest=sha('other');},
    s=>{s.owner_id='owner-b';},
    s=>{s.members[0].evidence_hash=sha('other');},
    s=>{s.members.pop();s.pine_count=1;},
    s=>{s.extra=1;},
    s=>{delete s.created_at;},
    s=>{s.fixture=false;},
    s=>{s.mode='ONE_PINE';},
    s=>{s.member_set_id='not-a-uuid';},
    s=>{s.same_bar_order='other';}
  ]) {
    const out=refusedBuild(tamper(fn),'MP_INPUT_INVALID','member_set');
    assert.equal(typeof out.diagnostic.detail,'string');
  }
});

test('member-set binding: members, set_hash, membership_hash, pine_count and the other claims must equal the frozen set',()=>{
  const set=frozenSet();
  const other=frozenSet([member(1,{sourceHash:sha('different-source-1')}),member(2)],SET_B);
  assert.notEqual(other.set_hash,set.set_hash);
  // each claim differing from the frozen set is refused and named
  const claims={
    owner_id:'owner-b',bot_id:'bot-b',member_set_id:SET_B,set_hash:sha('x'),membership_hash:sha('x'),pine_count:3,policy_hash:sha('x'),funding_cutoff:8,
    members:other.members
  };
  for(const [key,value] of Object.entries(claims)) {
    const out=refusedBuild(runInput(set,{[key]:value}),'MP_INPUT_INVALID',key);
    assert.equal(out.diagnostic.against,'member_set');
  }
  // members: reorder, drop, extend, alter one field, drop one key, add one key
  for(const fn of [
    m=>m.reverse(),
    m=>m.pop(),
    m=>m.push(clone(m[0])),
    m=>{m[1].deployment_id='dep-x';},
    m=>{m[0].ordinal=2;},
    m=>{delete m[0].exit_version;},
    m=>{m[0].pine_import_id='pine-9';},
    m=>{m[1].extra=1;}
  ]) {
    const input=runInput(set);
    fn(input.members);
    const out=refusedBuild(input,'MP_INPUT_INVALID','members');
    assert.equal(out.diagnostic.against,'member_set');
  }
  // claims of another valid set with the member_set of this one
  const input=runInput(other);
  input.member_set=clone(set);
  refusedBuild(input,'MP_INPUT_INVALID','member_set_id');
  // a claim that matches but a member_set of another Bot and owner
  const foreign=runInput(set,{owner_id:'owner-b'});
  refusedBuild(foreign,'MP_INPUT_INVALID','owner_id');
  // set_hash claim is the frozen one, even when members and every other claim agree
  const swapped=runInput(set,{set_hash:other.set_hash});
  refusedBuild(swapped,'MP_INPUT_INVALID','set_hash');
  // claims that agree pass
  good(runInput(set));
});

test('builder refusals: model, capital, rules, engine hash',()=>{
  const set=frozenSet();
  // the run model is the execution model the set froze
  refusedBuild(runInput(set,{model:{...MODEL,price_tick:0.02}}),'MP_INPUT_INVALID','model');
  refusedBuild(runInput(set,{model:{...MODEL,fee_bps:1}}),'MP_INPUT_INVALID','model');
  refusedBuild(runInput(set,{model:{...MODEL,version:'paper-close-cost-v2'}}),'MP_INPUT_INVALID','model');
  refusedBuild(runInput(set,{model:{...MODEL,extra:1}}),'MP_INPUT_INVALID','model');
  const cut={...MODEL};
  delete cut.data_profile;
  refusedBuild(runInput(set,{model:cut}),'MP_INPUT_INVALID','model');
  refusedBuild(runInput(set,{model:{...MODEL,data_profile:'other'}}),'MP_INPUT_INVALID','model.version');
  refusedBuild(runInput(set,{model:{...MODEL,price_tick:'0.01'}}),'MP_INPUT_INVALID','model.price_tick');
  // rules: exactly RULES of the one-Pine contract, one refusal per key (R1)
  assert.deepEqual(RULE_VALUES,RULES);
  for(const key of Object.keys(RULES)) {
    const without={...RULE_VALUES};
    delete without[key];
    refusedBuild(runInput(set,{rules:without}),'MP_INPUT_INVALID','rules');
    refusedBuild(runInput(set,{rules:{...RULE_VALUES,[key]:RULES[key]+1}}),'MP_INPUT_INVALID','rules');
    refusedBuild(runInput(set,{rules:{...RULE_VALUES,[key]:RULES[key]-1}}),'MP_INPUT_INVALID','rules');
    refusedBuild(runInput(set,{rules:{...RULE_VALUES,[key]:String(RULES[key])}}),'MP_INPUT_INVALID','rules');
    refusedBuild(runInput(set,{rules:{...RULE_VALUES,[key]:null}}),'MP_INPUT_INVALID','rules');
  }
  refusedBuild(runInput(set,{rules:{...RULE_VALUES,extra:1}}),'MP_INPUT_INVALID','rules');
  refusedBuild(runInput(set,{rules:{}}),'MP_INPUT_INVALID','rules');
  for(const bad of ['x',sha('x').toUpperCase(),sha('x').slice(1),sha('x')+'0','',7])refusedBuild(runInput(set,{engine_hash:bad}),'MP_INPUT_INVALID','engine_hash');
});

test('capital: accounts must hash to the set capital basis; the run capital is the account of the market broker',()=>{
  const set=frozenSet();
  const acct=(equity=1000,balance=1000,broker='binance-global')=>({broker,configuredEquity:equity,configuredBalance:balance});
  const mismatch=(accounts,against='member_set.capital_basis_hash',field='capital',input=runInput(set,{capital_accounts:accounts}))=>{
    const out=refusedBuild(input,'MP_INPUT_INVALID',field);
    if(against)assert.equal(out.diagnostic.against,against);
  };
  // the recipe of the member set: hash of the canonical list of broker, configuredEquity, configuredBalance
  assert.equal(sha(ref(CAPITAL.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance})))),set.capital_basis_hash);
  assert.deepEqual(good(runInput(set)).capital,{equity:'1000',cash:'1000'});
  // a different amount, a string for a number, an extra account, a missing account: all mismatch the basis
  mismatch([acct(1001,1000)]);
  mismatch([acct(1000,999)]);
  mismatch([acct('1000',1000)]);
  mismatch([acct(1000,1000),acct(1,1,'other')]);
  mismatch([acct(1000,1000,'other')]);
  // shape problems come first and name the input key
  for(const bad of [null,'x',[],{},true,12345,Array.from({length:21},(_,i)=>acct(1,1,'b'+i))])mismatch(bad,null,'capital_accounts');
  mismatch([null],null,'capital_accounts[0]');
  mismatch([{...acct(),extra:1}],null,'capital_accounts[0]');
  mismatch([{broker:'binance-global',configuredEquity:1000}],null,'capital_accounts[0]');
  mismatch([{...acct(),configuredBalance:null}],null,'capital_accounts[0]');
  mismatch([{...acct(),configuredEquity:{}}],null,'capital_accounts[0]');
  mismatch([{...acct(),broker:''}],null,'capital_accounts[0]');
  mismatch([acct(1,1),acct(2,2)],null,'capital_accounts[1]');
  // a claimed capital is no longer an input key
  refusedBuild(runInput(set,{capital:{equity:'1000',cash:'1000'}}),'MP_INPUT_INVALID','input.capital');
  // two accounts: the account of the set's market broker, whatever its place in the list
  const two=[acct('10',2,'other'),acct('2500','2400')];
  assert.deepEqual(good(withAccounts(two).input).capital,{equity:'2500',cash:'2400'});
  const swapped=[two[1],two[0]];
  const swappedSet=frozenSet([member(1,{capital:two}),member(2,{capital:two})]);
  mismatch(swapped,'member_set.capital_basis_hash','capital',runInput(swappedSet,{capital_accounts:swapped}));
  // numbers are written as plain decimal text; decimals keep their text
  assert.deepEqual(good(withAccounts([acct(0.5,12)]).input).capital,{equity:'0.5',cash:'12'});
  assert.deepEqual(good(withAccounts([acct('1234567890.123456789','0.1')]).input).capital,{equity:'1234567890.123456789',cash:'0.1'});
  // no account for the market broker, or a non-positive or non-plain amount: refused against the market
  const unusable=[[acct(1,1,'other')],[acct(0,1)],[acct(1,0)],[acct('0.0',1)],[acct(1,'0')],[acct(-1,1)],[acct(1,'-1')],[acct(1e-7,1)],[acct(1,1e21)],[acct('1e3',1)],[acct(1,'x')],[acct(' 1',1)],[acct('1'.repeat(121),1)],[acct('100000000000000000000',1)]];
  for(const accounts of unusable) {
    const made=withAccounts(accounts);
    const out=refusedBuild(made.input,'MP_INPUT_INVALID','capital');
    assert.equal(out.diagnostic.against,'member_set.market',JSON.stringify(accounts));
  }
});

test('builder refusals: dataset, budget and seed',()=>{
  const set=frozenSet();
  const ds=over=>({start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,content_digest:sha('digest'),...over});
  refusedBuild(runInput(set,{dataset:ds({start_time:START+1})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({end_time:START+(BARS-1)*60000+1})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({end_time:START})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({end_time:START-60000})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({start_time:0})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({start_time:'1'})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({start_time:1.5})}),'MP_INPUT_INVALID','dataset.range');
  refusedBuild(runInput(set,{dataset:ds({end_time:START+FOUNDATION_LIMITS.admittedBars*60000})}),'MP_INPUT_INVALID','dataset.bar_count');
  refusedBuild(runInput(set,{dataset:ds({warmup_bars:5001})}),'MP_INPUT_INVALID','dataset.warmup_bars');
  refusedBuild(runInput(set,{dataset:ds({warmup_bars:-1})}),'MP_INPUT_INVALID','dataset.warmup_bars');
  refusedBuild(runInput(set,{dataset:ds({warmup_bars:1.5})}),'MP_INPUT_INVALID','dataset.warmup_bars');
  refusedBuild(runInput(set,{dataset:ds({end_time:START+99*60000,warmup_bars:100})}),'MP_INPUT_INVALID','dataset.range');
  // sample floor (R4): compared bars after warm-up at least 2000, border at 1999 and 2000
  const bars=(count,warmup)=>ds({end_time:START+(count-1)*60000,warmup_bars:warmup});
  refusedBuild(runInput(set,{dataset:bars(1999,0)}),'MP_INPUT_INVALID','dataset.sample');
  assert.equal(good(runInput(set,{dataset:bars(2000,0)})).dataset.bar_count,2000);
  refusedBuild(runInput(set,{dataset:bars(2499,500)}),'MP_INPUT_INVALID','dataset.sample');
  assert.equal(good(runInput(set,{dataset:bars(2500,500)})).split.warmup,500);
  refusedBuild(runInput(set,{dataset:bars(2,0)}),'MP_INPUT_INVALID','dataset.sample');
  refusedBuild(runInput(set,{dataset:bars(5000,3001)}),'MP_INPUT_INVALID','dataset.sample');
  assert.equal(good(runInput(set,{dataset:bars(5000,3000)})).split.warmup,3000);
  refusedBuild(runInput(set,{dataset:ds({content_digest:sha('d').toUpperCase()})}),'MP_INPUT_INVALID','dataset.content_digest');
  refusedBuild(runInput(set,{dataset:ds({content_digest:'x'})}),'MP_INPUT_INVALID','dataset.content_digest');
  refusedBuild(runInput(set,{dataset:{...ds(),extra:1}}),'MP_INPUT_INVALID','dataset');
  refusedBuild(runInput(set,{dataset:{...ds(),bar_count:BARS}}),'MP_INPUT_INVALID','dataset');
  const noDigest=ds();
  delete noDigest.content_digest;
  refusedBuild(runInput(set,{dataset:noDigest}),'MP_INPUT_INVALID','dataset');
  for(const bad of [0,101,1.5,-1,'30',null,NaN])
    refusedBuild(runInput(set,{budget:{candidates:bad}}),'MP_INPUT_INVALID',Number.isNaN(bad)?'input':'budget.candidates');
  // the evaluation cap is not part of this contract (R3)
  refusedBuild(runInput(set,{budget:{candidates:30,max_evaluations:39}}),'MP_INPUT_INVALID','budget');
  refusedBuild(runInput(set,{budget:{}}),'MP_INPUT_INVALID','budget');
  for(const bad of [-1,2147483648,1.5,'1',null,true])refusedBuild(runInput(set,{seed:bad}),'MP_INPUT_INVALID','seed');
});

test('builder refusals: Bridge domains follow the lockInputs rules in exact decimals, with the shared pair as baseline',()=>{
  const set=frozenSet();
  const dom=(over={})=>({atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'},...over});
  refusedBuild(runInput(set,{bridge_domains:{atr_multiplier:dom().atr_multiplier}}),'MP_INPUT_INVALID','bridge_domains');
  refusedBuild(runInput(set,{bridge_domains:{...dom(),extra:{min:'1',max:'2',step:'1'}}}),'MP_INPUT_INVALID','bridge_domains');
  refusedBuild(runInput(set,{bridge_domains:{...dom(),slot_3:dom().rr}}),'MP_INPUT_INVALID','bridge_domains');
  refusedBuild(runInput(set,{bridge_domains:{atr_multiplier:dom().atr_multiplier,tp:dom().rr}}),'MP_INPUT_INVALID','bridge_domains');
  const cases=[
    // [domain, field] for atr_multiplier (baseline 2)
    [{min:1,max:'3',step:'0.5'},'min'],[{min:'1',max:3,step:'0.5'},'max'],[{min:'1',max:'3',step:0.5},'step'],
    [{min:'1.0',max:'3',step:'0.5'},'min'],[{min:'1',max:'3.00',step:'0.5'},'max'],[{min:'1',max:'3',step:'.5'},'step'],
    [{min:'1',max:'3',step:'0'},'step'],[{min:'1',max:'3',step:'-0.5'},'step'],[{min:'1',max:'3',step:'1e0'},'step'],
    [{min:'0.001',max:'3',step:'0.5'},'min'],[{min:'0',max:'3',step:'0.5'},'min'],[{min:'1',max:'1001',step:'0.5'},'max'],
    [{min:'3',max:'3',step:'0.5'},'max'],[{min:'3',max:'1',step:'0.5'},'max'],
    [{min:'1',max:'3',step:'0.3'},'step'],[{min:'1',max:'3',step:'3'},'step'],
    [{min:'2.5',max:'3',step:'0.5'},'baseline'],[{min:'0.5',max:'1.5',step:'0.5'},'baseline'],[{min:'1.5',max:'3.5',step:'1'},'baseline'],
    [{min:'0.01',max:'1000',step:'0.01'},'step'],[{min:'1',max:'3',step:'0.5',extra:'1'},'domain'],[{min:'1',max:'3'},'domain'],['x','domain'],[null,'domain'],[[],'domain']
  ];
  for(const [domain,field] of cases) {
    refusedBuild(runInput(set,{bridge_domains:dom({atr_multiplier:domain})}),'MP_INPUT_INVALID',field==='domain'?'bridge_domains.atr_multiplier':'bridge_domains.atr_multiplier.'+field);
    // the same rules apply to rr (its baseline is 1.5, so the atr baseline cases are not repeated)
    if(field!=='baseline')refusedBuild(runInput(set,{bridge_domains:dom({rr:domain})}),'MP_INPUT_INVALID',field==='domain'?'bridge_domains.rr':'bridge_domains.rr.'+field);
  }
  for(const domain of [{min:'2',max:'3',step:'0.5'},{min:'0.5',max:'1',step:'0.5'},{min:'0.25',max:'2.25',step:'0.5'},{min:'1.75',max:'3.75',step:'0.5'}])
    refusedBuild(runInput(set,{bridge_domains:dom({rr:domain})}),'MP_INPUT_INVALID','bridge_domains.rr.baseline');
  // 1000 grid values are accepted, 1001 are not
  good(runInput(frozenSet([member(1,{pair:{atr_multiplier:'2',rr:'1.5'}}),member(2,{pair:{atr_multiplier:'2',rr:'1.5'}})]),{bridge_domains:{atr_multiplier:{min:'1',max:'10.99',step:'0.01'},rr:{min:'0.5',max:'2.5',step:'0.5'}}}));
  refusedBuild(runInput(set,{bridge_domains:dom({atr_multiplier:{min:'1',max:'11',step:'0.01'}})}),'MP_INPUT_INVALID','bridge_domains.atr_multiplier.step');
  // baseline on the border is inside the domain
  good(runInput(set,{bridge_domains:dom({atr_multiplier:{min:'2',max:'4',step:'0.5'},rr:{min:'1.5',max:'3',step:'0.5'}})}));
  good(runInput(set,{bridge_domains:dom({atr_multiplier:{min:'1',max:'2',step:'0.25'},rr:{min:'0.5',max:'1.5',step:'0.25'}})}));
});

// ---------------------------------------------------------------- validator: exact keys

test('validator: a built contract is valid; extra, missing and one-Pine top-level keys are refused',()=>{
  const contract=good(runInput());
  const out=validate(contract);
  assert.equal(out.ok,true);
  assert.deepEqual(out.contract,contract);
  for(const key of ['deployment_id','pine_import_id','source_version','foo','scope','snapshot','plan','input_lock','source','baseline_snapshot_hash','execution_backend','ledger_initialization','max_evaluations'])
    refusedValidate({...clone(contract),[key]:'x'},'MP_INPUT_INVALID',key);
  for(const key of MULTI_RUN_CONTRACT_KEYS) {
    const copy=clone(contract);
    delete copy[key];
    if(key==='fixture')refusedValidate(copy,'MP_INPUT_INVALID',key);
    else refusedValidate(copy,'MP_INPUT_INVALID',key);
  }
  for(const bad of [null,undefined,'x',7,[],true])refusedValidate(bad,'MP_INPUT_INVALID','contract');
  refusedValidate(Object.assign(Object.create({a:1}),contract),'MP_INPUT_INVALID','contract');
  const getter=clone(contract);
  Object.defineProperty(getter,'seed',{get:()=>42,enumerable:true});
  refusedValidate(getter,'MP_INPUT_INVALID','contract');
});

test('validator: a wrong type is refused for every top-level field',()=>{
  const contract=good(runInput());
  for(const key of MULTI_RUN_CONTRACT_KEYS)
    for(const wrong of WRONG_TYPES) {
      if(key==='fixture'&&wrong===true)continue;
      // these values are valid for the field
      if((key==='owner_id'||key==='bot_id')&&wrong==='x')continue;
      if((key==='seed'||key==='funding_cutoff')&&wrong===12345)continue;
      const value={...clone(contract),[key]:wrong};
      if(key==='fixture')refusedValidate(value,'MP_FIXTURE_ONLY','fixture');
      else if(key==='members'&&Array.isArray(wrong))refusedValidate(value,'MP_MEMBERSHIP_EMPTY','members');
      else refusedValidate(value,'MP_INPUT_INVALID',key);
    }
});

test('validator: wrong types and wrong values inside every nested object',()=>{
  const contract=good(runInput());
  const nested=[
    ['capital.equity',1000],['capital.cash',1000],['capital.equity','0'],['capital.cash','1e3'],['capital.equity',null],
    ['model.version',5],['model.version','other'],['model.price_tick','0.01'],['model.quantity_step',0],['model.fee_bps','0'],['model.slippage_bps',-1],['model.risk_percent',101],['model.data_profile',5],
    ['rules.minimum_closed_trades_train','5'],['rules.minimum_closed_trades_validation',null],['rules.minimum_closed_trades_test',[]],['rules.maximum_drawdown_percent','20'],['rules.sensitivity_max_drop_percentage_points',{}],
    ['dataset.start_time','x'],['dataset.end_time',1.5],['dataset.warmup_bars','500'],['dataset.bar_count','5000'],['dataset.bar_count',4999],['dataset.first_time',START+60000],
    ['dataset.timestamp_semantics',5],['dataset.timestamp_semantics','other'],['dataset.content_digest',5],['dataset.digest_version',5],['dataset.digest_version','other'],
    ['split.warmup','500'],['split.train_end',3201],['split.validation_end',null],['split.test_end',4999],
    ['budget.candidates','30'],['budget.candidates',0],['budget.candidates',101],['budget.max_evaluations',39],
    ['bridge_domains.atr_multiplier.min',1],['bridge_domains.atr_multiplier.max',3],['bridge_domains.rr.step',0.5],['bridge_domains.rr.min','0.0'],['bridge_domains.atr_multiplier','x'],
    ['members.0.ordinal','1'],['members.0.ordinal',2],['members.0.source_version','2'],['members.0.source_version',0],['members.0.pine_import_id',1],['members.0.source_hash',5],
    ['members.0.effective_inputs_hash','x'],['members.1.deployment_id',5],['members.1.deployment_snapshot_hash',null],['members.1.exit_version',5],['members.1.evidence_hash',5],['members.1','x'],['members.0',null]
  ];
  for(const [pathText,wrong] of nested) {
    const value=clone(contract);
    setAt(value,pathText,wrong);
    const out=validate(value);
    assert.equal(out.ok,false,pathText);
    assert.equal(out.code,'MP_INPUT_INVALID',pathText+' '+JSON.stringify(out));
    assert.equal(out.diagnostic.field.split(/[.[]/)[0],pathText.split('.')[0],pathText+' '+JSON.stringify(out));
  }
  // a nested object with an extra or a missing key
  for(const pathText of ['capital','model','rules','dataset','split','budget','bridge_domains','bridge_domains.atr_multiplier','bridge_domains.rr','members.0','members.1']) {
    const extra=clone(contract);
    setAt(extra,pathText+'.zz','x');
    const outExtra=validate(extra);
    assert.equal(outExtra.ok,false,pathText);
    assert.equal(outExtra.code,'MP_INPUT_INVALID',pathText);
    for(const key of Object.keys(getAt(contract,pathText))) {
      const missing=clone(contract);
      delete getAt(missing,pathText)[key];
      const outMissing=validate(missing);
      assert.equal(outMissing.ok,false,pathText+'.'+key);
      assert.equal(outMissing.code,'MP_INPUT_INVALID',pathText+'.'+key);
    }
  }
});

test('validator: rules equal RULES exactly, one refusal per key',()=>{
  const contract=good(runInput());
  assert.deepEqual(contract.rules,RULES);
  for(const key of Object.keys(RULES)) {
    refusedValidate(edit(contract,c=>{c.rules[key]=RULES[key]+1;}),'MP_INPUT_INVALID','rules');
    refusedValidate(edit(contract,c=>{c.rules[key]=String(RULES[key]);}),'MP_INPUT_INVALID','rules');
    refusedValidate(edit(contract,c=>{delete c.rules[key];}),'MP_INPUT_INVALID','rules');
  }
  refusedValidate(edit(contract,c=>{c.rules.extra=1;}),'MP_INPUT_INVALID','rules');
});

test('validator and builder: the sample floor of 2000 compared bars after warm-up (border 1999 and 2000)',()=>{
  const contract=good(runInput());
  const bad=(bars,warmup)=>refusedValidate(withBars(contract,bars,warmup),'MP_INPUT_INVALID','dataset.sample');
  bad(1999,0);bad(2499,500);bad(5000,3001);bad(2,0);
  assert.equal(validate(withBars(contract,2000,0)).ok,true);
  assert.equal(validate(withBars(contract,2500,500)).ok,true);
  assert.equal(validate(withBars(contract,5000,3000)).ok,true);
  assert.equal(validate(withBars(contract,FOUNDATION_LIMITS.admittedBars,5000)).ok,true);
});

test('one snapshot: builder and validator read a Proxy once; later reads of the caller object change nothing',()=>{
  // the get trap answers 42 once and then a value that would refuse; plainJson reads descriptors, the copy reads the get trap once
  const watch=(target)=>{
    const calls={seed:0};
    const proxy=new Proxy(target,{get(t,key,receiver) {
      if(key==='seed') {calls.seed++;return calls.seed===1?42:'x';}
      return Reflect.get(t,key,receiver);
    }});
    return {proxy,calls};
  };
  const built=watch(runInput());
  const out=build(built.proxy);
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.equal(out.contract.seed,42);
  assert.equal(built.calls.seed,1);
  const stored=watch(good(runInput()));
  const checked=validate(stored.proxy);
  assert.equal(checked.ok,true,JSON.stringify(checked));
  assert.equal(checked.contract.seed,42);
  assert.equal(stored.calls.seed,1);
});

test('validator: fixture must be true',()=>{
  const contract=good(runInput());
  for(const value of [false,'true',1,0,null,[],{}])refusedValidate({...clone(contract),fixture:value},'MP_FIXTURE_ONLY','fixture');
  assert.equal(validate(contract).ok,true);
  assert.equal(contract.fixture,true);
  // the key check comes first
  refusedValidate({...clone(contract),fixture:false,extra:1},'MP_INPUT_INVALID','extra');
});

test('validator: constants, member set binding fields and internal consistency',()=>{
  const contract=good(runInput());
  const bad=(fn,field,code='MP_INPUT_INVALID')=>refusedValidate(edit(contract,fn),code,field);
  bad(c=>{c.version='ql3a-research-job-v2';},'version');
  bad(c=>{c.version='ql3a-research-job-multi-v2';},'version');
  bad(c=>{c.mode='ONE_PINE';},'mode');
  bad(c=>{c.same_bar_order='other';},'same_bar_order');
  bad(c=>{c.member_set_id='x';},'member_set_id');
  bad(c=>{c.member_set_id=SET_A.toUpperCase();},'member_set_id');
  bad(c=>{c.set_hash=sha('x').slice(1);},'set_hash');
  bad(c=>{c.membership_hash=sha('x');},'membership_hash');
  bad(c=>{c.pine_count=3;},'pine_count');
  bad(c=>{c.pine_count=-2;},'pine_count');
  bad(c=>{c.pine_count=2.5;},'pine_count');
  bad(c=>{c.owner_id='';},'owner_id');
  bad(c=>{c.bot_id='-x';},'bot_id');
  bad(c=>{c.bot_id='a b';},'bot_id');
  bad(c=>{c.policy_hash='x';},'policy_hash');
  bad(c=>{c.funding_cutoff=-1;},'funding_cutoff');
  bad(c=>{c.funding_cutoff=1.5;},'funding_cutoff');
  bad(c=>{c.engine_hash=sha('x').toUpperCase();},'engine_hash');
  bad(c=>{c.seed=-1;},'seed');
  bad(c=>{c.seed=2147483648;},'seed');
  bad(c=>{c.seed=0.5;},'seed');
  // members: a change breaks the membership hash, a count outside 2 to 3 has its own code
  bad(c=>{c.members[0].source_hash=sha('other');},'membership_hash');
  bad(c=>{c.members[0].source_version=3;},'membership_hash');
  bad(c=>{c.members[0].pine_import_id='pine-0';},'membership_hash');
  bad(c=>{c.members.reverse();},'members[0]');
  bad(c=>{c.members[1].ordinal=3;},'members[1]');
  bad(c=>{c.members[1].pine_import_id=c.members[0].pine_import_id;},'members[1]');
  bad(c=>{c.members=[];c.pine_count=0;},'members','MP_MEMBERSHIP_EMPTY');
  bad(c=>{c.members=c.members.slice(0,1);c.pine_count=1;},'members','MP_NOT_MULTI_PINE');
  bad(c=>{c.members=[...c.members,{...c.members[0],ordinal:3,pine_import_id:'pine-3'},{...c.members[0],ordinal:4,pine_import_id:'pine-4'}];c.pine_count=4;},'members','MP_MEMBER_COUNT_EXCEEDED');
  bad(c=>{c.members[1].source_hash=c.members[0].source_hash;c.members[1].effective_inputs_hash=c.members[0].effective_inputs_hash;},'members','MP_MEMBER_DUPLICATE_LOGIC');
  bad(c=>{c.members[1].exit_version='bridge-exit-v1';},'members','MP_EXIT_VERSION_MIXED');
  // equal source hash but another effective-input hash is no duplicate logic
  const ok=edit(contract,c=>{c.members[1].source_hash=c.members[0].source_hash;c.membership_hash=sha(ref(c.members.map(m=>({pine_import_id:m.pine_import_id,source_version:m.source_version,source_hash:m.source_hash}))));});
  assert.equal(validate(ok).ok,true);
  // derived fields
  bad(c=>{c.split.train_end+=1;},'split');
  bad(c=>{c.dataset.warmup_bars=400;},'split');
  bad(c=>{c.budget.max_evaluations=c.budget.candidates+9;},'budget');
  bad(c=>{c.split.test_end=5001;},'split');
  // blockers: exactly the frozen list, in order
  bad(c=>{c.acceptance_blockers=['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED'];},'acceptance_blockers');
  bad(c=>{c.acceptance_blockers=[MULTI_PINE_BLOCKER];},'acceptance_blockers');
  bad(c=>{c.acceptance_blockers=[...c.acceptance_blockers].reverse();},'acceptance_blockers');
  bad(c=>{c.acceptance_blockers=[...c.acceptance_blockers,'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'];},'acceptance_blockers');
  bad(c=>{c.acceptance_blockers=[];},'acceptance_blockers');
  bad(c=>{c.acceptance_blockers=['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','MULTI_PINE_REQUIRES_APP_3B',7];},'acceptance_blockers');
  // domain shape rules hold without a baseline
  bad(c=>{c.bridge_domains.rr.step='0.3';},'bridge_domains.rr.step');
  bad(c=>{c.bridge_domains.rr.min='0.001';},'bridge_domains.rr.min');
  bad(c=>{c.bridge_domains.rr.max='0.5';},'bridge_domains.rr.max');
});

// ---------------------------------------------------------------- blockers

test('blocker list: candidate evidence blockers plus the APP-3B blocker; the multi contract never lists the one-Pine capability blocker',()=>{
  const contract=good(runInput());
  assert.deepEqual(contract.acceptance_blockers,[...CANDIDATE_BLOCKERS,'MULTI_PINE_REQUIRES_APP_3B']);
  assert.ok(contract.acceptance_blockers.includes(MULTI_PINE_BLOCKER));
  assert.ok(!contract.acceptance_blockers.includes('CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'));
  contract.acceptance_blockers.push('x');
  assert.deepEqual(MULTI_RUN_ACCEPTANCE_BLOCKERS.length,3,'the exported list is not shared with a built contract');
  assert.equal(good(runInput()).acceptance_blockers.length,3);
});

// ---------------------------------------------------------------- determinism, round trip

test('determinism: same input, same bytes; key order and input order do not matter; members stay in ordinal order',()=>{
  const set=frozenSet();
  const a=good(runInput(set));
  const b=good(runInput(set));
  assert.equal(ref(a),ref(b));
  assert.equal(JSON.stringify(a),JSON.stringify(b));
  assert.deepEqual(a,b);
  const shuffled=good(reorder(runInput(set)));
  assert.equal(JSON.stringify(shuffled),JSON.stringify(a));
  // top-level keys are sorted in the output
  assert.deepEqual(Object.keys(a),[...Object.keys(a)].sort());
  assert.deepEqual(a.members.map(m=>m.ordinal),[1,2]);
  assert.deepEqual(a.members.map(m=>m.pine_import_id),['pine-1','pine-2']);
  // a different set gives a different contract
  const other=good(runInput(frozenSet([member(1,{sourceHash:sha('different')}),member(2)],SET_B)));
  assert.notEqual(ref(other),ref(a));
  assert.notEqual(other.set_hash,a.set_hash);
  // each run field changes the bytes
  for(const over of [{seed:43},{budget:{candidates:31}},{engine_hash:sha('engine-2')},{dataset:{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:501,content_digest:sha('digest')}},{dataset:{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,content_digest:sha('digest-2')}}])
    assert.notEqual(ref(good(runInput(set,over))),ref(a));
});

test('canonical round trip: build, validate, serialise, parse, validate again',()=>{
  const contract=good(runInput());
  const first=validate(contract);
  assert.equal(first.ok,true);
  assert.equal(ref(first.contract),ref(contract));
  const text=JSON.stringify(contract);
  const parsed=JSON.parse(text);
  const second=validate(parsed);
  assert.equal(second.ok,true);
  assert.equal(JSON.stringify(second.contract),text);
  assert.equal(ref(second.contract),ref(contract));
  // the validator returns a copy
  second.contract.capital.equity='1';
  assert.equal(parsed.capital.equity,'1000');
  // a reordered copy validates to the same canonical bytes
  const third=validate(reorder(contract));
  assert.equal(third.ok,true);
  assert.equal(JSON.stringify(third.contract),text);
  assert.equal(sha(ref(third.contract)),sha(ref(contract)));
});

test('exact decimals: capital and Bridge domain values are strings in the output and in every accepted input',()=>{
  const contract=good(runInput());
  assert.equal(typeof contract.capital.equity,'string');
  assert.equal(typeof contract.capital.cash,'string');
  const leaves=(value,out=[])=>{
    if(value&&typeof value==='object')for(const inner of Object.values(value))leaves(inner,out);
    else out.push(value);
    return out;
  };
  for(const leaf of [...leaves(contract.capital),...leaves(contract.bridge_domains)])assert.equal(typeof leaf,'string',String(leaf));
  // the text is the same text the caller wrote (no rounding through a binary float)
  const precise=good(withAccounts([{broker:'binance-global',configuredEquity:'1234567890.123456789',configuredBalance:'0.1'}]).input);
  assert.deepEqual(precise.capital,{equity:'1234567890.123456789',cash:'0.1'});
});

// ---------------------------------------------------------------- mirror of the one-Pine v2 contract

test('mirror: shared fields and derived values equal the one-Pine ql3a-research-job-v2 contract',()=>{
  const set=frozenSet();
  const multi=good(runInput(set));
  const lock={selection:{signals:{buy:'a',exit:'b',timing:'bar_close'},bridge:{atr_multiplier:2,rr:1.5},bindings:[],fixed_inputs:[]},
    domains:{atr_multiplier:[1,1.5,2,2.5,3],rr:[0.5,1,1.5,2,2.5]},lock_hash:sha('lock')};
  // the v2 builder needs a plan to run; nothing of the plan is compared with the multi contract
  const plan={planned_candidates:30,candidates:Array.from({length:30},(_,i)=>({i}))};
  const one=buildResearchContractV2({owner_id:OWNER,bot_id:BOT,
    deployment:{deployment_id:'dep-1',pine_import_id:'pine-1',source_version:2,snapshot_hash:sha('snap')},source:{source:'x',source_hash:sha('x')},
    snapshot:{selection:lock.selection},lock,plan,model:{...MODEL},rules:{...RULE_VALUES},capital:{configuredEquity:'1000',configuredBalance:'1000'},
    engine_hash:sha('engine'),dataset:{start_time:START,end_time:START+(BARS-1)*60000,warmup_bars:500,content_digest:sha('digest')}});
  assert.equal(one.version,'ql3a-research-job-v2');
  assert.deepEqual(multi.dataset,one.dataset);
  assert.deepEqual(multi.split,one.split);
  assert.deepEqual(multi.capital,one.capital);
  assert.deepEqual(multi.rules,one.rules);
  assert.deepEqual(multi.model,one.model);
  assert.equal(multi.engine_hash,one.engine_hash);
  assert.equal(multi.owner_id,one.owner_id);
  assert.equal(multi.bot_id,one.bot_id);
  // the evaluation cap and the planned count come with the later plan slice: the multi budget is the candidate count only
  assert.deepEqual(Object.keys(multi.budget),['candidates']);
  assert.ok(!Object.hasOwn(multi,'max_evaluations'));
  assert.deepEqual(multi.rules,RULES);
  assert.deepEqual(Object.keys(lock.domains).sort(),Object.keys(multi.bridge_domains).sort());
  for(const blocker of CANDIDATE_BLOCKERS)assert.ok(one.acceptance_blockers.includes(blocker)&&multi.acceptance_blockers.includes(blocker));
  assert.ok(!one.acceptance_blockers.includes(MULTI_PINE_BLOCKER));
  assert.equal(multi.policy_hash,set.policy_hash);
  for(const key of ['deployment_id','pine_import_id','source_version'])assert.ok(Object.hasOwn(one,key)&&!Object.hasOwn(multi,key),key);
  // the budget limits are the foundation limits
  assert.equal(FOUNDATION_LIMITS.candidates,100);
  assert.equal(RULES.minimum_closed_trades_train,5);
  assert.equal(FOUNDATION_LIMITS.admittedBars,10000);
});

// ---------------------------------------------------------------- import guard and purity

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const sourcePath=path.join(root,'src','multi-pine','run-contract.js');

// The run-store module re-validates stored contracts (RD-MP-21); test/mp-run-store-static-isolation.test.js proves no runtime root reaches it.
const ALLOWED_IMPORTERS=['src/postgres/mp-run-store.js','src/multi-pine/fixture-service.js'];
test('import guard: no file under src outside src/multi-pine imports run-contract.js, except the run-store module',()=>{
  const srcDir=path.join(root,'src');
  const files=fs.readdirSync(srcDir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()&&/\.(?:js|mjs|cjs)$/.test(e.name)).map(e=>path.join(e.parentPath,e.name));
  assert.ok(files.length>50,'the walk found the source tree');
  const inside=path.join(srcDir,'multi-pine')+path.sep;
  const offenders=files.filter(file=>!file.startsWith(inside)).filter(file=>/run-contract/.test(fs.readFileSync(file,'utf8')));
  assert.deepEqual(offenders.map(f=>path.relative(root,f).split(path.sep).join('/')).filter(f=>!ALLOWED_IMPORTERS.includes(f)),[]);
  for(const allowed of ALLOWED_IMPORTERS)assert.ok(fs.existsSync(path.join(root,allowed)),allowed+' exists');
  // the module itself exists in the allowed folder and no other multi-pine file re-exports it yet
  assert.ok(fs.existsSync(sourcePath));
  const others=files.filter(file=>file.startsWith(inside)&&file!==sourcePath).filter(file=>/run-contract/.test(fs.readFileSync(file,'utf8')));
  assert.deepEqual(others.map(f=>path.relative(root,f).split(path.sep).join('/')).filter(f=>!ALLOWED_IMPORTERS.includes(f)),[]);
});

const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const IMPORT_SPECIFIER=/^[ \t]*(?:import|export)\b[^'";]*?\bfrom\s*'([^']+)'|^[ \t]*import\s*'([^']+)'/gm;
/** Relative-import closure of a module: every file reached through relative specifiers, and the external specifiers they name. */
function importClosure(entry) {
  const files=new Set(),external=new Set(),dynamic=[];
  const walk=file=>{
    if(files.has(file))return;
    files.add(file);
    const code=stripComments(fs.readFileSync(file,'utf8'));
    if(/\bimport\s*\(|\brequire\s*\(/.test(code))dynamic.push(path.relative(root,file));
    for(const match of code.matchAll(IMPORT_SPECIFIER)) {
      const specifier=match[1]??match[2];
      if(specifier.startsWith('.'))walk(path.resolve(path.dirname(file),specifier));
      else external.add(specifier);
    }
  };
  walk(entry);
  return {files:[...files].map(file=>path.relative(root,file).split(path.sep).join('/')).sort(),external:[...external].sort(),dynamic};
}

test('purity: the transitive import closure reaches only the known pure modules and two external specifiers; the module itself uses no I/O, clock, randomness, process or worker',()=>{
  const closure=importClosure(sourcePath);
  // the closure includes the modules named in the header and no database, file, timer, worker or process module
  for(const needed of ['src/multi-pine/member-set.js','src/multi-pine/codes.js','src/pine-bridge/source.js','src/quant-research/contract.js','src/quant-research/foundation-contract.js','src/quant-library/package-gates.js','src/money.js'])
    assert.ok(closure.files.includes(needed),needed);
  assert.deepEqual(closure.dynamic,[],'no dynamic import or require anywhere in the closure');
  assert.deepEqual(closure.external,['decimal.js','node:crypto']);
  for(const forbidden of ['pg','node:fs','fs','node:timers','timers','worker_threads','node:worker_threads','child_process','node:child_process','node:net','node:http','node:https','node:process'])
    assert.ok(!closure.external.includes(forbidden),forbidden);
  assert.ok(!closure.files.some(file=>/^src\/postgres\/(?:db|pool|client)/.test(file)));
  // the module's own text
  const code=stripComments(fs.readFileSync(sourcePath,'utf8'));
  assert.deepEqual([...code.matchAll(IMPORT_SPECIFIER)].map(m=>m[1]??m[2]).sort(),['../pine-bridge/source.js','../quant-library/package-gates.js','../quant-research/contract.js','../quant-research/foundation-contract.js','./codes.js','./member-set.js']);
  assert.ok(!/\bimport\s*\(/.test(code)&&!/\brequire\s*\(/.test(code));
  for(const forbidden of [/\bDate\b/,/Math\.random/,/\bprocess\b/,/\bfetch\b/,/node:/,/\bsetTimeout\b/,/\bsetInterval\b/,/performance\./,/\bBuffer\b/,/\bWorker\b/,/\bglobalThis\b/,/\bXMLHttpRequest\b/,/\bWebSocket\b/,/\bnew Function\b/,/\beval\b/])
    assert.ok(!forbidden.test(code),String(forbidden));
  // money and capital never pass through Number or a float parser
  assert.ok(!/parseFloat|Number\(|\.toFixed\(/.test(code));
});

// ---------------------------------------------------------------- coverage of refusal codes

test('refusal codes: only existing MP_ codes are returned, every one matches the pattern, and the expected set was exercised',()=>{
  // the other tests in this file ran first (node:test runs a file in order)
  for(const code of seen) {
    assert.match(code,MP_CODE_PATTERN);
    assert.ok(MP_CODE_LIST.includes(code),code);
  }
  assert.deepEqual([...seen].sort(),[MP_CODES.INPUT_INVALID,MP_CODES.FIXTURE_ONLY,MP_CODES.MEMBERSHIP_EMPTY,MP_CODES.NOT_MULTI_PINE,MP_CODES.MEMBER_COUNT_EXCEEDED,MP_CODES.MEMBER_DUPLICATE_LOGIC,MP_CODES.EXIT_VERSION_MIXED].sort());
});
