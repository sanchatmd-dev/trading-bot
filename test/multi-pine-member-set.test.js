import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MULTI_PINE_CONTRACT_VERSION as GATES_VERSION,MULTI_PINE_BLOCKER as GATES_BLOCKER} from '../src/quant-library/package-gates.js';
import {MP_CODES,MP_CODE_LIST,MP_S1_CODES,MP_CODE_PATTERN,MP_MAX_MEMBERS,MP_MIN_MEMBERS,MP_MEMBER_SET_VERSION,MP_COMBINED_EVALUATOR,MP_SAME_BAR_ORDER,
  MP_BRIDGE_ATR_PERIOD,MP_MODE,MULTI_PINE_CONTRACT_VERSION,MULTI_PINE_BLOCKER} from '../src/multi-pine/codes.js';
import {buildMemberSet,decideFreeze,memberSetFreshness,decimalString,FRESHNESS_FIELD_ORDER} from '../src/multi-pine/member-set.js';

/*
 * F11-01 S1. Every object below is a LABELLED ENGINEERING FIXTURE (fixture: true): synthetic rows, never a research result.
 * The module is pure, so no database, clock, network or file is used. Expected hashes are derived in this file with an
 * independent canonical-JSON writer and node:crypto, not with the module under test.
 */
const OWNER='owner-a',BOT='bot-a';
const SET_A='5b0c7a52-1d3e-4f60-8a71-2c9d4e6f8a01',SET_B='6c1d8b63-2e4f-4071-9b82-3dae5f7a9b02',SET_C='7d2e9c74-3f50-4182-8c93-4ebf608bac03';
const T1='2026-10-20T10:00:00Z',T2='2026-10-20T11:00:00.250Z';

// Independent reference canonicaliser and hash.
const ref=value=>Array.isArray(value)?'['+value.map(ref).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+ref(value[k])).join(',')+'}':JSON.stringify(value);
const sha=text=>createHash('sha256').update(text).digest('hex');
const clone=value=>structuredClone(value);
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reorder(value[k])])):value;

// Every code any call returns in this file, so the final tests prove coverage and the code pattern (T-M4).
const seen=new Set();
const note=out=>{if(out&&out.ok===false)seen.add(out.code);if(out&&out.fresh===false)seen.add(out.code);return out;};
const build=input=>note(buildMemberSet(input));
const freeze=(candidate,existing)=>note(decideFreeze(candidate,existing));
const fresh=(set,rows)=>note(memberSetFreshness(set,rows));

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};

function member(n,over={}) {
  return {n,pine:`pine-${n}`,version:2,sourceHash:sha('source-'+n),inputsHash:sha('inputs-'+n),connected:true,dep:`dep-${n}`,state:'DRAFT',
    pair:{atr_multiplier:2,rr:1.5},market:MARKET,exit:'bridge-exit-v2',model:MODEL,artifact:sha('artifact-'+n),policy:POLICY,capital:CAPITAL,funding:7,
    ref:`fixture-ref-${n}`,...over};
}
function evidenceFor(m,snapshot,snapshotHash) {
  return {snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
    binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
    effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(m.model),
    references:{tradingview:m.ref+'-tv',source_review:m.ref+'-sr',paper_fixture:m.ref+'-pf'}};
}
function deployment(m,depId,projection) {
  const snapshot=structuredClone({policy:m.policy,policy_hash:sha(ref(m.policy)),capital:m.capital,funding_cutoff:m.funding,membership:m.membership??projection,
    session:{state:'SETUP',run_id:null},captured_at:1,selection:{bridge:m.pair,bindings:[]},market:{deployment_id:depId,pine_import_id:m.pine,source_version:m.version,...m.market},
    source_hash:m.sourceHash,instruction_versions:{template:'fixture'},artifact_hash:m.artifact});
  m.editSnapshot?.(snapshot);
  const snapshotHash=sha(ref(snapshot));
  const body=evidenceFor(m,snapshot,snapshotHash);
  m.editEvidence?.(body);
  return {
    row:{deployment_id:depId,owner_id:OWNER,bot_id:BOT,pine_import_id:m.pine,source_version:m.version,state:m.state,snapshot,snapshot_hash:snapshotHash,exit_version:m.exit},
    evidence:{deployment_id:depId,snapshot_hash:snapshotHash,evidence:body,evidence_hash:sha(ref(body))}
  };
}
function world(specs,{extra=[],noEvidence=[],noDeployment=[],names={},botState}={}) {
  const memberships=specs.map(m=>({pine_import_id:m.pine,owner_id:OWNER,bot_id:BOT,source_version:m.version,source_hash:m.sourceHash,connected:m.connected,
    analysis:{effective_inputs_hash:m.inputsHash,inputs:[{input_id:'i'+m.n}]}}));
  const projection=memberships.filter(r=>r.connected).sort((a,b)=>a.pine_import_id<b.pine_import_id?-1:1)
    .map(r=>({pine_import_id:r.pine_import_id,source_version:r.source_version,source_hash:r.source_hash,analysis:r.analysis}));
  const deployments=[],evidence=[];
  for(const m of specs) {
    if(noDeployment.includes(m.n))continue;
    const d=deployment(m,m.dep,projection);
    deployments.push(d.row);
    if(!noEvidence.includes(m.n))evidence.push(d.evidence);
  }
  for(const m of extra) {const d=deployment(m,m.dep,projection);deployments.push(d.row);evidence.push(d.evidence);}
  // The caller names one deployment per connected member (root ruling M3); names[n] overrides which one.
  const member_deployments=specs.filter(m=>m.connected&&!noDeployment.includes(m.n)).map(m=>({pine_import_id:m.pine,deployment_id:names[m.n]??m.dep}));
  // The server-read Bot state (root ruling M1): by default what member 1 froze.
  const first=specs[0];
  const bot_state=botState??{policy_hash:sha(ref(first.policy)),capital_basis_hash:sha(ref(first.capital.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance})))),funding_cutoff:first.funding};
  return {owner_id:OWNER,bot_id:BOT,fixture:true,member_set_id:SET_A,created_at:T1,bot_state,member_deployments,memberships,deployments,evidence};
}
const two=(over1={},over2={})=>world([member(1,over1),member(2,over2)]);
const rowsOf=input=>{const {fixture,member_set_id,created_at,member_deployments,...rows}=structuredClone(input);return rows;};
const good=input=>{const out=build(input);assert.equal(out.ok,true,JSON.stringify(out));return out.member_set;};
const refused=(input,code,diagnostic)=>{
  const out=build(input);
  assert.equal(out.ok,false,'expected refusal '+code);
  assert.equal(out.code,code,JSON.stringify(out));
  if(diagnostic)assert.deepEqual(out.diagnostic,diagnostic);
  return out;
};

// ---------------------------------------------------------------- constants

test('constants: frozen names, limits and the package-gates link (RD-MP-1 option A, OD-MP-1, OD-MP-2)',()=>{
  assert.equal(MULTI_PINE_CONTRACT_VERSION,'ql3a-research-job-multi-v1');
  assert.equal(MULTI_PINE_CONTRACT_VERSION,GATES_VERSION);
  assert.equal(MULTI_PINE_BLOCKER,'MULTI_PINE_REQUIRES_APP_3B');
  assert.equal(MULTI_PINE_BLOCKER,GATES_BLOCKER);
  assert.equal(MP_MAX_MEMBERS,3);
  assert.equal(MP_MIN_MEMBERS,2);
  assert.equal(MP_MEMBER_SET_VERSION,'mp-member-set-v1');
  assert.equal(MP_COMBINED_EVALUATOR,'mp-combined-paper-v1');
  assert.equal(MP_SAME_BAR_ORDER,'exit-first-ordinal-v1');
  assert.equal(MP_BRIDGE_ATR_PERIOD,14);
  assert.equal(MP_MODE,'MULTI_PINE');
  assert.ok(Object.isFrozen(MP_CODES)&&Object.isFrozen(MP_CODE_LIST)&&Object.isFrozen(MP_S1_CODES));
});

test('codes: section 8.2 holds 22 contract codes plus the two S1 additions, all MP_ and unique',()=>{
  assert.equal(MP_CODE_LIST.length,24);
  assert.equal(new Set(MP_CODE_LIST).size,24);
  for(const code of MP_CODE_LIST) {assert.match(code,MP_CODE_PATTERN);assert.ok(code.startsWith('MP_'),code);}
  assert.deepEqual(MP_CODE_LIST.slice(0,22).filter(code=>['MP_INPUT_INVALID','MP_NOT_MULTI_PINE'].includes(code)),[]);
  for(const code of MP_S1_CODES)assert.ok(MP_CODE_LIST.includes(code),code);
});

// ---------------------------------------------------------------- decimal strings

test('decimalString: one decimal form per value, invalid values give null',()=>{
  const equal=[[2,'2'],['2','2'],['2.0','2'],['2.00','2'],[1.5,'1.5'],['1.50','1.5'],[0.5,'0.5'],['0.050','0.05'],[1000,'1000'],[1e-7,'0.0000001'],['1e2','100'],
    [10.25,'10.25'],['007','7'],['1.5e0','1.5'],['15e-1','1.5'],[0.1,'0.1']];
  for(const [input,expected] of equal)assert.equal(decimalString(input),expected,String(input));
  const bad=[0,'0','0.0',-1,'-1',1000.01,1001,NaN,Infinity,-Infinity,'abc','','1e999','1e-31','.5','5.',' 2','2 ',null,undefined,true,{},[],'0x10','1,5','+2'];
  for(const input of bad)assert.equal(decimalString(input),null,String(input));
});

// ---------------------------------------------------------------- F1 shared pair, T-M1, T-M2

test('F1: two members with the shared pair freeze; record fields come from server rows only',()=>{
  const set=good(two());
  assert.equal(set.version,'mp-member-set-v1');
  assert.equal(set.mode,'MULTI_PINE');
  assert.equal(set.pine_count,2);
  assert.equal(set.owner_id,OWNER);
  assert.equal(set.bot_id,BOT);
  assert.equal(set.member_set_id,SET_A);
  assert.equal(set.created_at,T1);
  assert.equal(set.fixture,true);
  assert.deepEqual(set.bridge_pair,{atr_multiplier:'2',rr:'1.5'});
  assert.equal(set.bridge_atr_period,14);
  assert.deepEqual(set.market,{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
  assert.equal(set.exit_version,'bridge-exit-v2');
  assert.equal(set.same_bar_order,'exit-first-ordinal-v1');
  assert.equal(set.funding_cutoff,7);
  assert.equal(set.policy_hash,sha(ref(POLICY)));
  assert.equal(set.capital_basis_hash,sha(ref(CAPITAL)));
  assert.equal(set.execution_model_hash,sha(ref(MODEL)));
  assert.deepEqual(set.members.map(m=>Object.keys(m).sort()),[...Array(2)].map(()=>['deployment_id','deployment_snapshot_hash','effective_inputs_hash','evidence_hash','exit_version','ordinal','pine_import_id','source_hash','source_version']));
  const input=two();
  assert.equal(set.members[0].deployment_id,'dep-1');
  assert.equal(set.members[0].deployment_snapshot_hash,input.deployments[0].snapshot_hash);
  assert.equal(set.members[0].evidence_hash,input.evidence[0].evidence_hash);
  assert.equal(set.members[1].effective_inputs_hash,sha('inputs-2'));
});

test('F1: hand-derived membership_hash, content_digest and set_hash',()=>{
  const set=good(two());
  const s1=sha('source-1'),s2=sha('source-2');
  const membershipText=`[{"pine_import_id":"pine-1","source_hash":"${s1}","source_version":2},{"pine_import_id":"pine-2","source_hash":"${s2}","source_version":2}]`;
  assert.equal(set.membership_hash,sha(membershipText));
  const content={version:'mp-member-set-v1',owner_id:OWNER,bot_id:BOT,mode:'MULTI_PINE',pine_count:2,members:set.members,membership_hash:sha(membershipText),
    bridge_pair:{atr_multiplier:'2',rr:'1.5'},bridge_atr_period:14,market:MARKET,exit_version:'bridge-exit-v2',execution_model_hash:sha(ref(MODEL)),
    policy_hash:sha(ref(POLICY)),funding_cutoff:7,capital_basis_hash:sha(ref(CAPITAL)),same_bar_order:'exit-first-ordinal-v1',fixture:true};
  assert.equal(set.content_digest,sha(ref(content)));
  // section 3.3: SHA-256 of the canonical record without set_hash and created_at (it includes member_set_id and content_digest)
  assert.equal(set.set_hash,sha(ref({...content,member_set_id:SET_A,content_digest:sha(ref(content))})));
  // member records carry the contract field list and ordinals 1..N
  assert.deepEqual(set.members.map(m=>m.ordinal),[1,2]);
  assert.deepEqual(set.members.map(m=>m.pine_import_id),['pine-1','pine-2']);
});

test('F1/T-M2: set_hash and membership_hash are stable across key order and row order',()=>{
  const base=good(two());
  const input=two();
  const shuffled=reorder(input);
  shuffled.memberships.reverse();
  shuffled.deployments.reverse();
  shuffled.evidence.reverse();
  shuffled.member_deployments.reverse();
  assert.deepEqual(good(shuffled),base);
  assert.equal(good(shuffled).set_hash,base.set_hash);
});

test('F1: equal decimal values in different spellings freeze to one stored pair',()=>{
  const set=good(two({pair:{atr_multiplier:2,rr:1.5}},{pair:{atr_multiplier:'2.00',rr:'1.50'}}));
  assert.deepEqual(set.bridge_pair,{atr_multiplier:'2',rr:'1.5'});
  const reversed=good(two({pair:{atr_multiplier:'2.0',rr:'1.5'}},{pair:{atr_multiplier:2,rr:1.5}}));
  assert.deepEqual(reversed.bridge_pair,{atr_multiplier:'2',rr:'1.5'});
});

test('T-M1: mode, count and ordinal come from server rows; a client field is refused',()=>{
  const forward=good(two());
  // rows handed in reversed order and with the ids swapped in the array: ordinal still ascends with pine_import_id
  const input=two();
  input.memberships.reverse();
  assert.deepEqual(good(input).members.map(m=>[m.ordinal,m.pine_import_id]),[[1,'pine-1'],[2,'pine-2']]);
  assert.equal(good(input).pine_count,forward.pine_count);
  // three members: mode still derived, ordinals dense
  const three=good(world([member(3),member(1),member(2)]));
  assert.equal(three.pine_count,3);
  assert.deepEqual(three.members.map(m=>m.ordinal),[1,2,3]);
  assert.deepEqual(three.members.map(m=>m.pine_import_id),['pine-1','pine-2','pine-3']);
  // a disconnected row is not a member
  const withOff=good(world([member(1),member(2),member(3,{connected:false,dep:null})],{noDeployment:[3]}));
  assert.equal(withOff.pine_count,2);
  // client-supplied mode, count, list, pair or hash is refused, never ignored
  for(const [key,value] of [['mode','MULTI_PINE'],['pine_count',2],['members',[]],['bridge_pair',{atr_multiplier:'2',rr:'1.5'}],['set_hash',sha('x')],['membership_hash',sha('x')],['pine_import_ids',['pine-1']],['deployment_id','dep-1']]) {
    const bad=two();
    bad[key]=value;
    refused(bad,'MP_INPUT_INVALID',{field:'input.'+key});
  }
});

test('T-M2: any single member field change changes set_hash and membership_hash where it is part of the membership',()=>{
  const base=good(two());
  const changed=[
    ['source_hash',two({},{sourceHash:sha('other-source')}),true],
    ['source_version',two({},{version:3}),true],
    ['pine_import_id',two({},{pine:'pine-9'}),true],
    ['effective_inputs_hash',two({},{inputsHash:sha('other-inputs')}),false],
    ['deployment_id',two({},{dep:'dep-9'}),false],
    ['deployment_snapshot_hash',two({},{artifact:sha('other-artifact')}),false],
    ['evidence_hash',two({},{ref:'fixture-ref-changed'}),false]
  ];
  for(const [name,input,membership] of changed) {
    const set=good(input);
    assert.notEqual(set.set_hash,base.set_hash,name);
    assert.notEqual(set.content_digest,base.content_digest,name);
    assert.equal(set.membership_hash===base.membership_hash,!membership,name);
  }
  // exit version moves for both members together, so the set stays valid and changes
  const exit=good(two({exit:'bridge-exit-v9'},{exit:'bridge-exit-v9'}));
  assert.notEqual(exit.set_hash,base.set_hash);
  assert.equal(exit.exit_version,'bridge-exit-v9');
  // set-level fields: pair, policy, capital, funding, execution model (all members move together; market is fixed, see M4)
  const both=over=>two(over,over);
  for(const [name,over] of [
    ['pair',{pair:{atr_multiplier:3,rr:1.5}}],['policy',{policy:{...POLICY,maxRiskPercent:3}}],
    ['capital',{capital:[{...CAPITAL[0],configuredBalance:999}]}],['funding',{funding:8}],['model',{model:{...MODEL,fee_bps:10}}]
  ]) {
    const set=good(both(over));
    assert.notEqual(set.set_hash,base.set_hash,name);
    assert.notEqual(set.content_digest,base.content_digest,name);
    assert.equal(set.membership_hash,base.membership_hash,name);
  }
});

// ---------------------------------------------------------------- RC-MP-1 content digest and idempotent re-freeze

test('RC-MP-1: member_set_id and created_at change set_hash but never content_digest',()=>{
  const a=good(two());
  const input=two();
  input.member_set_id=SET_B;
  input.created_at=T2;
  const b=good(input);
  assert.notEqual(b.member_set_id,a.member_set_id);
  assert.notEqual(b.set_hash,a.set_hash);
  assert.equal(b.content_digest,a.content_digest);
  assert.equal(b.membership_hash,a.membership_hash);
  assert.equal(b.created_at,T2);
});

test('RC-MP-1: freeze-or-load returns the existing set of the same Bot when content_digest is equal',()=>{
  const existing=good(two());
  const input=two();
  input.member_set_id=SET_B;
  input.created_at=T2;
  const candidate=good(input);
  const loaded=freeze(candidate,[existing]);
  assert.deepEqual(loaded,{ok:true,action:'LOAD',member_set:existing});
  assert.equal(loaded.member_set.member_set_id,SET_A);
  // nothing stored: freeze the candidate
  const frozen=freeze(candidate,[]);
  assert.deepEqual(frozen,{ok:true,action:'FREEZE',member_set:candidate});
  // the same record offered again loads itself
  assert.equal(freeze(existing,[existing]).action,'LOAD');
  // changed content (new pair) is a new set
  const otherInput=two({pair:{atr_multiplier:3,rr:1.5}},{pair:{atr_multiplier:3,rr:1.5}});
  otherInput.member_set_id=SET_C;
  const fresh3=good(otherInput);
  assert.equal(freeze(fresh3,[existing]).action,'FREEZE');
  assert.equal(freeze(fresh3,[existing]).member_set.member_set_id,SET_C);
});

test('RC-MP-1: several sets with equal content load the earliest; foreign, tampered or clashing stored sets refuse',()=>{
  const a=good(two());
  const bi=two();bi.member_set_id=SET_B;bi.created_at='2026-10-19T08:00:00Z';
  const early=good(bi);
  const ci=two();ci.member_set_id=SET_C;ci.created_at=T2;
  const candidate=good(ci);
  assert.equal(freeze(candidate,[a,early]).member_set.member_set_id,SET_B);
  assert.equal(freeze(candidate,[early,a]).member_set.member_set_id,SET_B);
  // tie on created_at: lowest member_set_id
  const di=two();di.member_set_id=SET_B;di.created_at=T1;
  assert.equal(freeze(candidate,[a,good(di)]).member_set.member_set_id,SET_A);
  // another owner or Bot
  const foreignOwner=clone(a);foreignOwner.owner_id='owner-b';
  assert.equal(freeze(candidate,[foreignOwner]).code,'MP_INPUT_INVALID'); // hash no longer matches the changed field
  const fb=world([member(1),member(2)]);fb.bot_id='bot-b';
  for(const row of [...fb.memberships,...fb.deployments])row.bot_id='bot-b';
  fb.member_set_id=SET_B;
  const foreignSet=good(fb);
  assert.equal(foreignSet.bot_id,'bot-b');
  refusedFreeze(candidate,[foreignSet],'MP_MEMBER_FOREIGN_BOT');
  // tampered stored set (a field changed without restamping the hashes)
  const tampered=clone(a);tampered.market.symbol='ETHUSDT';
  refusedFreeze(candidate,[tampered],'MP_INPUT_INVALID');
  const noHash=clone(a);delete noHash.set_hash;
  refusedFreeze(candidate,[noHash],'MP_INPUT_INVALID');
  // same member_set_id with other content would clash with the insert-only primary key
  const clash=two({pair:{atr_multiplier:3,rr:1.5}},{pair:{atr_multiplier:3,rr:1.5}});
  clash.member_set_id=SET_A;
  refusedFreeze(good(clash),[a],'MP_INPUT_INVALID');
  // bad shapes
  refusedFreeze(null,[a],'MP_INPUT_INVALID');
  refusedFreeze(candidate,null,'MP_INPUT_INVALID');
  refusedFreeze(candidate,[null],'MP_INPUT_INVALID');
  refusedFreeze({...candidate,fixture:false},[],'MP_INPUT_INVALID');
});
function refusedFreeze(candidate,existing,code) {
  const out=freeze(candidate,existing);
  assert.equal(out.ok,false);
  assert.equal(out.code,code,JSON.stringify(out));
}

// ---------------------------------------------------------------- F2 divergent pair and other cross-member codes

test('F2: member 2 pair differs, no set',()=>{
  refused(two({},{pair:{atr_multiplier:2,rr:2}}),'MP_BRIDGE_PAIR_DIVERGENT',{stage:'set',field:'bridge_pair',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
  refused(two({},{pair:{atr_multiplier:2.5,rr:1.5}}),'MP_BRIDGE_PAIR_DIVERGENT');
  refused(two({},{pair:{atr_multiplier:'2.01',rr:'1.5'}}),'MP_BRIDGE_PAIR_DIVERGENT');
  // three members: the first divergent ordinal is named
  refused(world([member(1),member(2),member(3,{pair:{atr_multiplier:2,rr:1.51}})]),'MP_BRIDGE_PAIR_DIVERGENT',{stage:'set',field:'bridge_pair',ordinal:3,pine_import_id:'pine-3',against_ordinal:1});
  refused(world([member(1),member(2,{pair:{atr_multiplier:3,rr:1.5}}),member(3)]),'MP_BRIDGE_PAIR_DIVERGENT');
});

test('M4: only binance-global BTCUSDT 1m is a supported market, anything else is MP_INPUT_INVALID',()=>{
  const unsupported={field:'market.unsupported'};
  // both members on the same unsupported market: a member set for it must not exist
  refused(two({market:{...MARKET,symbol:'ETHUSDT',timeframe:'5'}},{market:{...MARKET,symbol:'ETHUSDT',timeframe:'5'}}),'MP_INPUT_INVALID',unsupported);
  for(const market of [{...MARKET,symbol:'ETHUSDT'},{...MARKET,timeframe:'5'},{...MARKET,timeframe:'1m'},{...MARKET,broker:'binance-th'},{...MARKET,symbol:'btcusdt'}]) {
    refused(two({market},{market}),'MP_INPUT_INVALID',unsupported);
    // one unsupported member is refused too, whichever member it is
    refused(two({},{market}),'MP_INPUT_INVALID',unsupported);
    refused(two({market},{}),'MP_INPUT_INVALID',unsupported);
  }
  assert.equal(good(two()).market.symbol,'BTCUSDT');
  // a stored set that names another market is malformed, never "stale"
  const set=good(two());
  const other=restamped(set,{market:{...MARKET,symbol:'ETHUSDT'}});
  assert.equal(fresh(other,rowsOf(two())).code,'MP_INPUT_INVALID');
  assert.equal(freeze(other,[]).code,'MP_INPUT_INVALID');
});

test('MP_EXIT_VERSION_MIXED: members bind different exit versions',()=>{
  refused(two({},{exit:'bridge-exit-v1'}),'MP_EXIT_VERSION_MIXED',{stage:'set',field:'exit_version',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
  assert.equal(good(two({exit:'bridge-exit-v1'},{exit:'bridge-exit-v1'})).exit_version,'bridge-exit-v1');
});

test('MP_EXECUTION_MODEL_MIXED: members whose evidence uses different execution models',()=>{
  refused(two({},{model:{...MODEL,version:'paper-close-cost-v2'}}),'MP_EXECUTION_MODEL_MIXED',{stage:'set',field:'execution_model_hash',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
  refused(two({},{model:{...MODEL,risk_percent:2}}),'MP_EXECUTION_MODEL_MIXED');
  refused(two({},{model:{...MODEL,fee_bps:5}}),'MP_EXECUTION_MODEL_MIXED');
});

test('MP_MEMBER_SET_STALE at birth: members frozen from different policy, capital or funding captures',()=>{
  refused(two({},{policy:{...POLICY,maxRiskPercent:3}}),'MP_MEMBER_SET_STALE',{stage:'set',field:'policy_hash',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
  refused(two({},{capital:[{...CAPITAL[0],configuredEquity:2000}]}),'MP_MEMBER_SET_STALE',{stage:'set',field:'capital_basis_hash',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
  refused(two({},{funding:9}),'MP_MEMBER_SET_STALE',{stage:'set',field:'funding_cutoff',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
});

test('F10/F11 (pure part): a deployment snapshot whose membership differs from the current membership is stale',()=>{
  const extraMember={n:9,pine:'pine-9',version:2,sourceHash:sha('source-9'),analysis:{effective_inputs_hash:sha('inputs-9'),inputs:[]}};
  // member 2 deployment was generated before member 1 changed its source: its snapshot lists the old version of member 1
  const base=two();
  const oldList=clone(base.deployments[1].snapshot.membership);
  oldList[0].source_version=1;
  const stale=two({},{membership:oldList});
  refused(stale,'MP_MEMBER_SET_STALE',{stage:'member',ordinal:2,pine_import_id:'pine-2',field:'snapshot.membership'});
  // a snapshot that predates a later-connected member
  const short=clone(base.deployments[0].snapshot.membership).slice(0,1);
  refused(two({membership:short}),'MP_MEMBER_SET_STALE',{stage:'member',ordinal:1,pine_import_id:'pine-1',field:'snapshot.membership'});
  // a snapshot that lists a member not connected now
  const longer=clone(base.deployments[0].snapshot.membership);
  longer.push({pine_import_id:extraMember.pine,source_version:2,source_hash:extraMember.sourceHash,analysis:extraMember.analysis});
  refused(two({membership:longer}),'MP_MEMBER_SET_STALE',{stage:'member',ordinal:1,pine_import_id:'pine-1',field:'snapshot.membership'});
  // M5: membership is compared as stored, in registry order (ORDER BY pine_import_id), exactly like freshSnapshot; a reordered list is stale
  const swapped=clone(base.deployments[0].snapshot.membership).reverse();
  refused(two({membership:swapped}),'MP_MEMBER_SET_STALE',{stage:'member',ordinal:1,pine_import_id:'pine-1',field:'snapshot.membership'});
});

// ---------------------------------------------------------------- empty, count, duplicate

test('MP_MEMBERSHIP_EMPTY: no connected member',()=>{
  const none=two();none.memberships=[];none.deployments=[];none.evidence=[];
  refused(none,'MP_MEMBERSHIP_EMPTY',{stage:'set'});
  const off=world([member(1,{connected:false}),member(2,{connected:false})]);
  refused(off,'MP_MEMBERSHIP_EMPTY',{stage:'set'});
});

test('F14: MP_MAX_MEMBERS + 1 members',()=>{
  refused(world([member(1),member(2),member(3),member(4)]),'MP_MEMBER_COUNT_EXCEEDED',{stage:'set',pine_count:4,limit:3});
  assert.equal(good(world([member(1),member(2),member(3)])).pine_count,MP_MAX_MEMBERS);
});

test('MP_NOT_MULTI_PINE: one connected member is ONE_PINE and never a member set',()=>{
  refused(world([member(1)]),'MP_NOT_MULTI_PINE',{stage:'set',pine_count:1});
  refused(world([member(1),member(2,{connected:false})]),'MP_NOT_MULTI_PINE',{stage:'set',pine_count:1});
});

test('F15: equal source hash and effective-input hash is duplicate logic; one differing hash is not',()=>{
  refused(world([member(1),member(2,{sourceHash:sha('source-1'),inputsHash:sha('inputs-1')})]),'MP_MEMBER_DUPLICATE_LOGIC',{stage:'set',ordinals:[1,2]});
  refused(world([member(1),member(2),member(3,{sourceHash:sha('source-2'),inputsHash:sha('inputs-2')})]),'MP_MEMBER_DUPLICATE_LOGIC',{stage:'set',ordinals:[2,3]});
  // OD-MP-9 option A: same source, different effective inputs
  assert.equal(good(world([member(1),member(2,{sourceHash:sha('source-1')})])).pine_count,2);
  // same effective inputs, different source
  assert.equal(good(world([member(1),member(2,{inputsHash:sha('inputs-1')})])).pine_count,2);
});

// ---------------------------------------------------------------- isolation and deployments

test('MP_MEMBER_FOREIGN_BOT: a row of another Bot or owner is refused, never ignored',()=>{
  const m=two();m.memberships[1].bot_id='bot-b';
  refused(m,'MP_MEMBER_FOREIGN_BOT',{stage:'membership',row:1,pine_import_id:'pine-2'});
  const o=two();o.memberships[0].owner_id='owner-b';
  refused(o,'MP_MEMBER_FOREIGN_BOT',{stage:'membership',row:0,pine_import_id:'pine-1'});
  const d=two();d.deployments[1].bot_id='bot-b';
  refused(d,'MP_MEMBER_FOREIGN_BOT',{stage:'deployment',row:1,deployment_id:'dep-2'});
  const e=two();e.deployments[0].owner_id='owner-b';
  refused(e,'MP_MEMBER_FOREIGN_BOT',{stage:'deployment',row:0,deployment_id:'dep-1'});
  // a foreign row that is not a connected member still refuses
  const f=two();f.deployments.push({...clone(f.deployments[0]),deployment_id:'dep-x',bot_id:'bot-b'});
  refused(f,'MP_MEMBER_FOREIGN_BOT');
  // the whole input for another Bot is not foreign to itself
  const other=two();other.bot_id='bot-b';
  for(const row of [...other.memberships,...other.deployments])row.bot_id='bot-b';
  assert.equal(good(other).bot_id,'bot-b');
});

test('MP_MEMBER_DEPLOYMENT_MISSING: a member without a deployment of its current source version',()=>{
  refused(world([member(1),member(2)],{noDeployment:[2]}),'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:2,pine_import_id:'pine-2'});
  refused(world([member(1),member(2)],{noDeployment:[1,2]}),'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:1,pine_import_id:'pine-1'});
  // a deployment of an older source version is not a deployment of the member
  const input=two();
  input.deployments[1].source_version=1;
  refused(input,'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:2,pine_import_id:'pine-2'});
  // a deployment of another import does not count either
  const swapped=two();
  swapped.deployments[1].pine_import_id='pine-7';
  refused(swapped,'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:2,pine_import_id:'pine-2'});
});

test('F26/M3: the caller names one deployment per member; other rows of the member are ignored, two names are ambiguous',()=>{
  // a second DRAFT row of member 1 exists, the caller names dep-1: other rows are ignored
  const input=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1b'})]});
  const set=good(input);
  assert.deepEqual(set.members.map(m=>m.deployment_id),['dep-1','dep-2']);
  // a retired second row is ignored the same way
  const retired=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1b',state:'REVOKED'})]});
  assert.equal(good(retired).content_digest,set.content_digest);
  // a second deployment of an older version of member 1 is ignored
  const older=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1old',version:1})]});
  assert.equal(good(older).pine_count,2);
  // regeneration at the same source_version: dep-1c replaces dep-1 and the caller names it; the older DRAFT row dep-1 is ignored
  const regen=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1c',artifact:sha('artifact-1c')})],names:{1:'dep-1c'}});
  const regenerated=good(regen);
  assert.deepEqual(regenerated.members.map(m=>m.deployment_id),['dep-1c','dep-2']);
  assert.equal(regenerated.members[0].deployment_snapshot_hash,regen.deployments[2].snapshot_hash);
  assert.notEqual(regenerated.content_digest,set.content_digest);
  assert.equal(regen.deployments.filter(d=>d.pine_import_id==='pine-1'&&d.state==='DRAFT').length,2);
  // naming two deployments for one member is the ambiguity
  const both=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1b'})]});
  both.member_deployments.push({pine_import_id:'pine-1',deployment_id:'dep-1b'});
  refused(both,'MP_MEMBER_DEPLOYMENT_AMBIGUOUS',{stage:'member',ordinal:1,pine_import_id:'pine-1',deployment_ids:['dep-1','dep-1b']});
  // a named deployment that does not exist, or is another import or version, is no deployment of the member
  refused(world([member(1),member(2)],{names:{1:'dep-ghost'}}),'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:1,pine_import_id:'pine-1'});
  refused(world([member(1),member(2)],{names:{2:'dep-1'}}),'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:2,pine_import_id:'pine-2'});
  const oldVersion=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1old',version:1})],names:{1:'dep-1old'}});
  refused(oldVersion,'MP_MEMBER_DEPLOYMENT_MISSING',{stage:'member',ordinal:1,pine_import_id:'pine-1'});
  // the named deployment must itself be DRAFT even when another DRAFT row of the member exists
  const namedRevoked=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1b',state:'REVOKED'})],names:{1:'dep-1b'}});
  refused(namedRevoked,'MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE',{stage:'member',ordinal:1,pine_import_id:'pine-1',deployment_id:'dep-1b',state:'REVOKED'});
  // a name for an import that is not a connected member is a caller defect
  const stray=two();
  stray.member_deployments.push({pine_import_id:'pine-9',deployment_id:'dep-1'});
  refused(stray,'MP_INPUT_INVALID',{field:'member_deployments[2].pine_import_id'});
});

test('MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE: only DRAFT members freeze (OD-MP-7)',()=>{
  for(const state of ['EXIT_ONLY','REVOKED','READY'])
    refused(two({},{state}),'MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE',{stage:'member',ordinal:2,pine_import_id:'pine-2',deployment_id:'dep-2',state});
  assert.equal(good(two()).pine_count,2);
});

test('MP_MEMBER_EVIDENCE_MISSING: no valid Bridge evidence bound to the member deployment',()=>{
  const reason=(input,expected)=>refused(input,'MP_MEMBER_EVIDENCE_MISSING',{ordinal:2,pine_import_id:'pine-2',deployment_id:'dep-2',reason:expected});
  reason(world([member(1),member(2)],{noEvidence:[2]}),'absent');
  // F25 evidence swap: member 2 references member 1's evidence row
  const swap=two();
  swap.evidence[1]={...clone(swap.evidence[0]),deployment_id:'dep-2'};
  reason(swap,'snapshot_hash');
  // evidence row bound to another snapshot hash
  const stale=two();stale.evidence[1].snapshot_hash=sha('other');
  reason(stale,'snapshot_hash');
  // evidence body edited after the row hash was taken
  const edited=two();edited.evidence[1].evidence.references.tradingview='fixture-ref-edited-tv';
  reason(edited,'evidence_hash');
  // evidence bound to a different snapshot in its body
  reason(two({},{editEvidence:e=>{e.snapshot_hash=sha('elsewhere');}}),'STALE_EVIDENCE');
  // validateEvidence failures
  reason(two({},{editEvidence:e=>{e.compilation_errors=1;}}),'BRIDGE_EVIDENCE_FAILED');
  reason(two({},{editEvidence:e=>{e.decision_match_percent=99;}}),'BRIDGE_EVIDENCE_INCOMPLETE');
  reason(two({},{editEvidence:e=>{e.execution_model.version='unknown-model';}}),'UNSUPPORTED_EXECUTION_MODEL');
  reason(two({},{editEvidence:e=>{delete e.cases;}}),'INVALID_FIELDS');
  reason(two({},{editEvidence:e=>{e.references.tradingview='x';}}),'EVIDENCE_REFERENCE_REQUIRED');
  // evidence not bound to the deployment artifact or source
  reason(two({},{editEvidence:e=>{e.artifact_hash=sha('another-artifact');}}),'binding');
  reason(two({},{editEvidence:e=>{e.source_hash=sha('another-source');}}),'binding');
  // member 1 is checked first and named
  const first=world([member(1),member(2)],{noEvidence:[1,2]});
  refused(first,'MP_MEMBER_EVIDENCE_MISSING',{ordinal:1,pine_import_id:'pine-1',deployment_id:'dep-1',reason:'absent'});
});

test('check order: the first failing member ends the freeze and is named',()=>{
  // member 1 not eligible, member 2 has no deployment: member 1 reported
  const input=world([member(1,{state:'REVOKED'}),member(2)],{noDeployment:[2]});
  refused(input,'MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE',{stage:'member',ordinal:1,pine_import_id:'pine-1',deployment_id:'dep-1',state:'REVOKED'});
  // per-member checks run before cross-member checks
  const mixed=world([member(1),member(2,{pair:{atr_multiplier:5,rr:1.5}}),member(3)],{noEvidence:[3]});
  refused(mixed,'MP_MEMBER_EVIDENCE_MISSING',{ordinal:3,pine_import_id:'pine-3',deployment_id:'dep-3',reason:'absent'});
  // an unsupported market is a per-member input defect: it ends the freeze before any cross-member comparison
  refused(two({},{pair:{atr_multiplier:5,rr:1.5},market:{...MARKET,symbol:'ETHUSDT'}}),'MP_INPUT_INVALID',{field:'market.unsupported'});
  // pair before exit version, exit version before execution model
  refused(two({},{pair:{atr_multiplier:5,rr:1.5},exit:'bridge-exit-v1'}),'MP_BRIDGE_PAIR_DIVERGENT');
  refused(two({},{exit:'bridge-exit-v1',model:{...MODEL,fee_bps:3}}),'MP_EXIT_VERSION_MIXED');
  // member divergence before the Bot state comparison (M1)
  refused(world([member(1),member(2,{funding:9})],{botState:{policy_hash:sha('p'),capital_basis_hash:sha('c'),funding_cutoff:1}}),'MP_MEMBER_SET_STALE',{stage:'set',field:'funding_cutoff',ordinal:2,pine_import_id:'pine-2',against_ordinal:1});
  // fixture and key checks come first, foreign before empty
  const noFixture=two();noFixture.fixture=false;noFixture.memberships=[];
  refused(noFixture,'MP_FIXTURE_ONLY',{stage:'set'});
  const foreignEmpty=two();foreignEmpty.memberships.forEach(r=>{r.connected=false;});foreignEmpty.memberships[0].bot_id='bot-b';
  refused(foreignEmpty,'MP_MEMBER_FOREIGN_BOT');
});

// ---------------------------------------------------------------- fixture-only and malformed input

test('MP_FIXTURE_ONLY: the internal path requires fixture === true',()=>{
  for(const value of [false,undefined,'true',1,null,0,{}]) {
    const input=two();
    if(value===undefined)delete input.fixture;else input.fixture=value;
    refused(input,'MP_FIXTURE_ONLY',{stage:'set'});
  }
  const set=good(two());
  assert.equal(set.fixture,true);
});

test('T-M3: malformed or wrong-type input fails closed with MP_INPUT_INVALID and never throws',()=>{
  const cases=[];
  const add=(label,edit)=>{const input=two();edit(input);cases.push([label,input]);};
  add('owner empty',i=>{i.owner_id='';});
  add('owner type',i=>{i.owner_id=7;});
  add('owner long',i=>{i.owner_id='x'.repeat(201);});
  add('bot missing',i=>{delete i.bot_id;});
  add('member_set_id not uuid',i=>{i.member_set_id='not-a-uuid';});
  add('member_set_id missing',i=>{delete i.member_set_id;});
  add('member_set_id uppercase',i=>{i.member_set_id=SET_A.toUpperCase();});
  add('created_at local',i=>{i.created_at='2026-10-20 10:00:00';});
  add('created_at offset',i=>{i.created_at='2026-10-20T10:00:00+07:00';});
  add('created_at impossible',i=>{i.created_at='2026-13-45T10:00:00Z';});
  add('created_at impossible day',i=>{i.created_at='2026-02-30T10:00:00Z';});
  add('created_at hour 24',i=>{i.created_at='2026-10-20T24:00:00Z';});
  add('created_at number',i=>{i.created_at=1760000000000;});
  add('memberships object',i=>{i.memberships={};});
  add('deployments missing',i=>{delete i.deployments;});
  add('evidence null',i=>{i.evidence=null;});
  add('membership row null',i=>{i.memberships[0]=null;});
  add('membership source_version string',i=>{i.memberships[0].source_version='2';});
  add('membership source_version zero',i=>{i.memberships[0].source_version=0;});
  add('membership source_hash short',i=>{i.memberships[0].source_hash='abc';});
  add('membership source_hash upper',i=>{i.memberships[0].source_hash=sha('x').toUpperCase();});
  add('membership connected string',i=>{i.memberships[0].connected='true';});
  add('membership analysis missing',i=>{delete i.memberships[0].analysis;});
  add('membership inputs hash missing',i=>{delete i.memberships[0].analysis.effective_inputs_hash;});
  add('membership inputs hash short',i=>{i.memberships[0].analysis.effective_inputs_hash='abc';});
  add('membership duplicate import',i=>{i.memberships[1].pine_import_id='pine-1';});
  add('deployment state unknown',i=>{i.deployments[0].state='ACTIVE';});
  add('deployment snapshot null',i=>{i.deployments[0].snapshot=null;});
  add('deployment snapshot array',i=>{i.deployments[0].snapshot=[];});
  add('deployment hash short',i=>{i.deployments[0].snapshot_hash='abc';});
  add('deployment duplicate id',i=>{i.deployments[1].deployment_id='dep-1';});
  add('deployment hash mismatch',i=>{i.deployments[0].snapshot.captured_at=2;});
  add('deployment exit missing',i=>{delete i.deployments[0].exit_version;});
  add('deployment exit empty',i=>{i.deployments[0].exit_version='';});
  add('evidence row null',i=>{i.evidence[0]=null;});
  add('evidence body array',i=>{i.evidence[0].evidence=[];});
  add('evidence duplicate',i=>{i.evidence[1]={...clone(i.evidence[0])};});
  add('evidence hash short',i=>{i.evidence[0].evidence_hash='abc';});
  add('evidence for unknown deployment',i=>{i.evidence.push({...clone(i.evidence[0]),deployment_id:'dep-ghost'});});
  add('evidence only for unknown deployment',i=>{i.evidence[1].deployment_id='dep-ghost';});
  add('bot_state missing',i=>{delete i.bot_state;});
  add('bot_state policy hash short',i=>{i.bot_state.policy_hash='abc';});
  add('member_deployments missing',i=>{delete i.member_deployments;});
  add('member_deployments object',i=>{i.member_deployments={};});
  add('member_deployments row null',i=>{i.member_deployments[0]=null;});
  add('member_deployments row extra key',i=>{i.member_deployments[0].extra=1;});
  add('member_deployments row id empty',i=>{i.member_deployments[0].deployment_id='';});
  add('member_deployments exact duplicate',i=>{i.member_deployments.push({...i.member_deployments[0]});});
  const reseal=(i,index,edit)=>{ // edit a snapshot and keep every hash consistent, so the structural check is what fails
    const row=i.deployments[index];edit(row.snapshot);row.snapshot_hash=sha(ref(row.snapshot));
    i.evidence[index].snapshot_hash=row.snapshot_hash;i.evidence[index].evidence.snapshot_hash=row.snapshot_hash;i.evidence[index].evidence_hash=sha(ref(i.evidence[index].evidence));
  };
  add('snapshot market identity',i=>reseal(i,0,s=>{s.market.deployment_id='dep-other';}));
  add('snapshot market source_version',i=>reseal(i,0,s=>{s.market.source_version=9;}));
  add('snapshot market broker missing',i=>reseal(i,0,s=>{delete s.market.broker;}));
  add('snapshot selection missing',i=>reseal(i,0,s=>{delete s.selection;}));
  add('snapshot bridge missing',i=>reseal(i,0,s=>{delete s.selection.bridge;}));
  add('snapshot bridge extra key',i=>reseal(i,0,s=>{s.selection.bridge.extra=1;}));
  add('snapshot bridge text',i=>reseal(i,0,s=>{s.selection.bridge.rr='abc';}));
  add('snapshot bridge zero',i=>reseal(i,0,s=>{s.selection.bridge.rr=0;}));
  add('snapshot bridge negative',i=>reseal(i,0,s=>{s.selection.bridge.atr_multiplier=-2;}));
  add('snapshot bridge huge',i=>reseal(i,0,s=>{s.selection.bridge.atr_multiplier=1001;}));
  add('snapshot bridge null',i=>reseal(i,0,s=>{s.selection.bridge.atr_multiplier=null;}));
  add('snapshot bridge exponent',i=>reseal(i,0,s=>{s.selection.bridge.rr='1e999';}));
  add('snapshot policy_hash wrong',i=>reseal(i,0,s=>{s.policy_hash=sha('x');}));
  add('snapshot policy missing',i=>reseal(i,0,s=>{delete s.policy;}));
  add('snapshot capital object',i=>reseal(i,0,s=>{s.capital={};}));
  add('snapshot capital entry incomplete',i=>reseal(i,0,s=>{delete s.capital[0].configuredBalance;}));
  add('snapshot funding negative',i=>reseal(i,0,s=>{s.funding_cutoff=-1;}));
  add('snapshot funding text',i=>reseal(i,0,s=>{s.funding_cutoff='7';}));
  add('snapshot membership missing',i=>reseal(i,0,s=>{delete s.membership;}));
  add('snapshot source_hash other',i=>reseal(i,0,s=>{s.source_hash=sha('other');}));
  add('snapshot artifact_hash missing',i=>reseal(i,0,s=>{delete s.artifact_hash;}));
  for(const [label,input] of cases) {
    let out;
    assert.doesNotThrow(()=>{out=build(input);},label);
    assert.equal(out.ok,false,label);
    assert.equal(out.code,'MP_INPUT_INVALID',label+' '+JSON.stringify(out));
    assert.equal(typeof out.diagnostic.field,'string',label);
  }
  // not an object at all
  for(const value of [null,undefined,0,'x',[],true]) {
    const out=build(value);
    assert.equal(out.ok,false);
    assert.equal(out.code,'MP_INPUT_INVALID');
  }
  // a hostile getter cannot escape as an exception
  const hostile=two();
  Object.defineProperty(hostile,'owner_id',{get(){throw new Error('boom');},enumerable:true});
  const out=build(hostile);
  assert.deepEqual([out.ok,out.code,out.diagnostic.field],[false,'MP_INPUT_INVALID','unexpected']);
});

test('M6: evidence of a deployment that is not among the deployments is MP_INPUT_INVALID, never ignored',()=>{
  const input=two();
  input.evidence.push({...clone(input.evidence[0]),deployment_id:'dep-ghost'});
  refused(input,'MP_INPUT_INVALID',{field:'evidence[2].deployment_id'});
  // swapped onto a missing deployment: the orphan is reported before the member is looked at
  const swapped=two();
  swapped.evidence[1].deployment_id='dep-ghost';
  refused(swapped,'MP_INPUT_INVALID',{field:'evidence[1].deployment_id'});
  // evidence of an unnamed DRAFT row of a member is fine: that row is among the deployments
  const extra=world([member(1),member(2)],{extra:[member(1,{dep:'dep-1b'})]});
  assert.equal(extra.evidence.length,3);
  assert.equal(good(extra).pine_count,2);
});

test('T-M3: each S1 refusal has exactly one expected code (summary of negation cases)',()=>{
  const table=[
    ['MP_FIXTURE_ONLY',()=>{const i=two();i.fixture=false;return i;}],
    ['MP_MEMBER_FOREIGN_BOT',()=>{const i=two();i.memberships[0].bot_id='bot-b';return i;}],
    ['MP_MEMBERSHIP_EMPTY',()=>world([member(1,{connected:false}),member(2,{connected:false})])],
    ['MP_NOT_MULTI_PINE',()=>world([member(1)])],
    ['MP_MEMBER_COUNT_EXCEEDED',()=>world([member(1),member(2),member(3),member(4)])],
    ['MP_MEMBER_DUPLICATE_LOGIC',()=>world([member(1),member(2,{sourceHash:sha('source-1'),inputsHash:sha('inputs-1')})])],
    ['MP_MEMBER_DEPLOYMENT_MISSING',()=>world([member(1),member(2)],{noDeployment:[2]})],
    ['MP_MEMBER_DEPLOYMENT_AMBIGUOUS',()=>{const i=world([member(1),member(2)],{extra:[member(2,{dep:'dep-2b'})]});i.member_deployments.push({pine_import_id:'pine-2',deployment_id:'dep-2b'});return i;}],
    ['MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE',()=>two({},{state:'EXIT_ONLY'})],
    ['MP_MEMBER_EVIDENCE_MISSING',()=>world([member(1),member(2)],{noEvidence:[1]})],
    ['MP_MEMBER_SET_STALE',()=>two({},{funding:8})],
    ['MP_BRIDGE_PAIR_DIVERGENT',()=>two({},{pair:{atr_multiplier:2,rr:2}})],
    ['MP_EXIT_VERSION_MIXED',()=>two({},{exit:'bridge-exit-v3'})],
    ['MP_EXECUTION_MODEL_MIXED',()=>two({},{model:{...MODEL,slippage_bps:4}})],
    ['MP_INPUT_INVALID',()=>{const i=two();i.mode='MULTI_PINE';return i;}]
  ];
  assert.deepEqual(table.map(([code])=>code).sort(),[...MP_S1_CODES].sort());
  for(const [code,make] of table)assert.equal(build(make()).code,code,code);
});

// ---------------------------------------------------------------- purity

test('the builder is pure: input untouched, output independent of input objects, repeatable',()=>{
  const input=two();
  const before=JSON.stringify(input);
  const a=good(input);
  const b=good(input);
  assert.equal(JSON.stringify(input),before);
  assert.deepEqual(a,b);
  a.members[0].deployment_id='mutated';a.bridge_pair.rr='9';a.market.symbol='X';
  assert.equal(good(input).members[0].deployment_id,'dep-1');
  assert.equal(JSON.stringify(input),before);
  // frozen output rows of the built object do not share references with the snapshot rows
  const c=good(input);
  assert.notEqual(c.market,input.deployments[0].snapshot.market);
});

// ---------------------------------------------------------------- freshness (pure part of F10/F11, section 9.2)

test('freshness: unchanged rows are fresh',()=>{
  const input=two();
  const set=good(input);
  assert.deepEqual(fresh(set,rowsOf(input)),{ok:true,fresh:true});
  assert.deepEqual(fresh(set,reorder(rowsOf(input))),{ok:true,fresh:true});
  // also fresh for a set loaded later: rows reordered
  const shuffled=rowsOf(input);shuffled.memberships.reverse();shuffled.deployments.reverse();shuffled.evidence.reverse();
  assert.deepEqual(fresh(set,shuffled),{ok:true,fresh:true});
});

const stale=(set,rows,field,extra)=>{
  const out=fresh(set,rows);
  assert.equal(out.ok,true,JSON.stringify(out));
  assert.equal(out.fresh,false,field);
  assert.equal(out.code,'MP_MEMBER_SET_STALE');
  assert.deepEqual(out.diagnostic,{field,...extra});
};

test('F10: disconnect member 2 after freeze reads MP_MEMBER_SET_STALE',()=>{
  const input=two();
  const set=good(input);
  const rows=rowsOf(input);
  rows.memberships[1].connected=false;
  stale(set,rows,'membership_hash');
  // member removed altogether
  const removed=rowsOf(input);removed.memberships.pop();
  stale(set,removed,'membership_hash');
  // a third member connected after freeze
  const grown=rowsOf(world([member(1),member(2),member(3)]));
  stale(set,grown,'membership_hash');
});

test('F11: new source revision of member 1 reads MP_MEMBER_SET_STALE',()=>{
  const input=two();
  const set=good(input);
  const rows=rowsOf(world([member(1,{version:3,sourceHash:sha('source-1b'),dep:'dep-1c'}),member(2)]));
  stale(set,rows,'membership_hash');
  // same version number, changed source hash (cannot happen on the server, still detected)
  const rehash=rowsOf(world([member(1,{sourceHash:sha('source-1b')}),member(2)]));
  stale(set,rehash,'membership_hash');
});

test('freshness: effective inputs, deployment, state, snapshot, exit version, evidence and snapshot membership',()=>{
  const input=two();
  const set=good(input);
  const at2={ordinal:2,pine_import_id:'pine-2'},at1={ordinal:1,pine_import_id:'pine-1'};
  const variant=(over1,over2)=>rowsOf(two(over1,over2));
  const inputs=rowsOf(input);
  inputs.memberships[0].analysis={...inputs.memberships[0].analysis,effective_inputs_hash:sha('inputs-1b')};
  stale(set,inputs,'effective_inputs_hash',at1);
  // a new reviewed input for member 2 regenerates member 1 snapshot membership too (F24): first stale member is named
  stale(set,variant({},{inputsHash:sha('inputs-2b')}),'deployment_snapshot_hash',at1);
  stale(set,variant({dep:'dep-1c'}),'deployment_id',at1);
  stale(set,variant({},{state:'EXIT_ONLY'}),'deployment_state',at2);
  stale(set,variant({},{state:'REVOKED'}),'deployment_state',at2);
  stale(set,variant({},{artifact:sha('artifact-2b')}),'deployment_snapshot_hash',at2);
  stale(set,variant({},{pair:{atr_multiplier:3,rr:1.5}}),'deployment_snapshot_hash',at2);
  stale(set,variant({exit:'bridge-exit-v9'}),'exit_version',at1);
  stale(set,variant({},{ref:'fixture-ref-new'}),'evidence_hash',at2);
  const noEvidence=rowsOf(world([member(1),member(2)],{noEvidence:[2]}));
  stale(set,noEvidence,'evidence_hash',at2);
  const noDeployment=rowsOf(world([member(1),member(2)],{noDeployment:[1]}));
  stale(set,noDeployment,'deployment_id',at1);
  // M3: another DRAFT row of member 2 does not disturb a set that names dep-2
  const extra=rowsOf(world([member(1),member(2)],{extra:[member(2,{dep:'dep-2b'})]}));
  assert.deepEqual(fresh(set,extra),{ok:true,fresh:true});
  // a deployment of the member that now has another import or version is not the named one
  const moved=rowsOf(input);moved.deployments[1].source_version=1;
  stale(set,moved,'deployment_id',at2);
  // a changed analysis with the same hashes: the snapshot membership no longer equals the current membership
  const analysis=rowsOf(input);
  analysis.memberships[0].analysis={...analysis.memberships[0].analysis,inputs:[{input_id:'changed'}]};
  stale(set,analysis,'snapshot_membership',at1);
  // evidence row that no longer matches its own hash
  const broken=rowsOf(input);broken.evidence[0].evidence.references.paper_fixture='fixture-ref-1-edited';
  stale(set,broken,'evidence_hash',at1);
});

/** A stored set that differs from the current rows in one set-level field, restamped so every hash is valid. */
function restamped(set,change) {
  const next=clone(set);
  Object.assign(next,change);
  const membership=next.members.map(m=>({pine_import_id:m.pine_import_id,source_version:m.source_version,source_hash:m.source_hash}));
  next.membership_hash=sha(ref(membership));
  const keys=['version','owner_id','bot_id','mode','pine_count','members','membership_hash','bridge_pair','bridge_atr_period','market','exit_version','execution_model_hash','policy_hash','funding_cutoff','capital_basis_hash','same_bar_order','fixture'];
  const content=Object.fromEntries(keys.map(k=>[k,next[k]]));
  next.content_digest=sha(ref(content));
  next.set_hash=sha(ref({...content,member_set_id:next.member_set_id,content_digest:next.content_digest}));
  return next;
}

test('freshness: set-level fields are compared against every current member',()=>{
  const input=two();
  const set=good(input);
  const rows=rowsOf(input);
  const at={ordinal:1,pine_import_id:'pine-1'};
  assert.deepEqual(fresh(restamped(set,{}),rows),{ok:true,fresh:true}); // the restamp helper itself is exact
  stale(restamped(set,{bridge_pair:{atr_multiplier:'3',rr:'1.5'}}),rows,'bridge_pair',at);
  stale(restamped(set,{execution_model_hash:sha('model')}),rows,'execution_model_hash',at);
  stale(restamped(set,{policy_hash:sha('policy')}),rows,'policy_hash',at);
  stale(restamped(set,{capital_basis_hash:sha('capital')}),rows,'capital_basis_hash',at);
  stale(restamped(set,{funding_cutoff:8}),rows,'funding_cutoff',at);
  // the order list names every field the function can report
  for(const field of ['membership_hash','effective_inputs_hash','deployment_id','deployment_state','deployment_snapshot_hash','exit_version','evidence_hash','snapshot_membership','bridge_pair','market','execution_model_hash','policy_hash','capital_basis_hash','funding_cutoff'])
    assert.ok(FRESHNESS_FIELD_ORDER.includes(field),field);
  assert.equal(FRESHNESS_FIELD_ORDER.length,14);
});

test('M1: a Bot state change after freeze is stale; the Bot state is required and read on the server',()=>{
  const input=two();
  const set=good(input);
  const rows=rowsOf(input);
  // the Bot policy changed after the member snapshots were frozen: the snapshots still agree with the stored set
  const policy=clone(rows);policy.bot_state.policy_hash=sha('policy-after-freeze');
  stale(set,policy,'policy_hash',{against:'bot_state'});
  const capital=clone(rows);capital.bot_state.capital_basis_hash=sha('capital-after-freeze');
  stale(set,capital,'capital_basis_hash',{against:'bot_state'});
  const funding=clone(rows);funding.bot_state.funding_cutoff=8;
  stale(set,funding,'funding_cutoff',{against:'bot_state'});
  assert.deepEqual(fresh(set,rows),{ok:true,fresh:true});
  // a member-level difference is still reported first, with the member named
  const both=rowsOf(two({},{policy:{...POLICY,maxRiskPercent:3}}));
  both.bot_state.policy_hash=sha('policy-after-freeze');
  stale(set,both,'deployment_snapshot_hash',{ordinal:2,pine_import_id:'pine-2'});
  // build: the Bot moved after the snapshots were frozen, so no set is born
  for(const [field,value] of [['policy_hash',sha('p2')],['capital_basis_hash',sha('c2')],['funding_cutoff',9]]) {
    const born=two();
    born.bot_state[field]=value;
    refused(born,'MP_MEMBER_SET_STALE',{stage:'set',field,against:'bot_state'});
  }
  // a Bot policy change after freeze, then a re-freeze attempt: stale, not a new set
  const moved=world([member(1,{policy:{...POLICY,maxRiskPercent:1}}),member(2,{policy:{...POLICY,maxRiskPercent:1}})],{botState:{policy_hash:sha(ref(POLICY)),capital_basis_hash:set.capital_basis_hash,funding_cutoff:7}});
  refused(moved,'MP_MEMBER_SET_STALE',{stage:'set',field:'policy_hash',against:'bot_state'});
  // missing or malformed bot_state fails closed
  const noState=two();delete noState.bot_state;
  refused(noState,'MP_INPUT_INVALID',{field:'bot_state'});
  const noStateRows=clone(rows);delete noStateRows.bot_state;
  assert.deepEqual(fresh(set,noStateRows).diagnostic,{field:'bot_state'});
  assert.equal(fresh(set,noStateRows).code,'MP_INPUT_INVALID');
  for(const [label,edit,field] of [
    ['null',s=>null,'bot_state'],['array',s=>[],'bot_state'],['extra key',s=>({...s,extra:1}),'bot_state'],['missing key',s=>({policy_hash:s.policy_hash,capital_basis_hash:s.capital_basis_hash}),'bot_state'],
    ['short hash',s=>({...s,policy_hash:'abc'}),'bot_state.policy_hash'],['upper hash',s=>({...s,capital_basis_hash:sha('x').toUpperCase()}),'bot_state.capital_basis_hash'],
    ['negative funding',s=>({...s,funding_cutoff:-1}),'bot_state.funding_cutoff'],['text funding',s=>({...s,funding_cutoff:'7'}),'bot_state.funding_cutoff']
  ]) {
    const bad=two();bad.bot_state=edit(bad.bot_state);
    refused(bad,'MP_INPUT_INVALID',{field});
    const badRows=clone(rows);badRows.bot_state=edit(badRows.bot_state);
    const out=fresh(set,badRows);
    assert.equal(out.code,'MP_INPUT_INVALID',label);
    assert.deepEqual(out.diagnostic,{field},label);
  }
});

test('M2: the earliest created_at wins by instant, not by text, across fraction precisions',()=>{
  const make=(id,at)=>{const i=two();i.member_set_id=id;i.created_at=at;return good(i);};
  const candidate=make(SET_C,T2);
  // text order puts "...00.100Z" before "...00Z" ('.' < 'Z'), the instant order puts 10:00:00.000 first
  const whole=make(SET_B,'2026-10-20T10:00:00Z');
  const milli=make(SET_A,'2026-10-20T10:00:00.100Z');
  assert.ok('2026-10-20T10:00:00.100Z'<'2026-10-20T10:00:00Z');
  assert.equal(freeze(candidate,[milli,whole]).member_set.member_set_id,SET_B);
  assert.equal(freeze(candidate,[whole,milli]).member_set.member_set_id,SET_B);
  // one and two fraction digits against three
  const one=make(SET_B,'2026-10-20T09:00:00.5Z');
  const three=make(SET_A,'2026-10-20T09:00:00.499Z');
  assert.equal(freeze(candidate,[one,three]).member_set.member_set_id,SET_A);
  // the same instant in different spellings: lowest member_set_id wins
  const plain=make(SET_B,'2026-10-20T08:00:00Z');
  const zeros=make(SET_A,'2026-10-20T08:00:00.000Z');
  assert.equal(freeze(candidate,[plain,zeros]).member_set.member_set_id,SET_A);
  assert.equal(freeze(candidate,[zeros,plain]).member_set.member_set_id,SET_A);
});

test('freshness: another owner or Bot, tampered sets and malformed rows refuse',()=>{
  const input=two();
  const set=good(input);
  const rows=rowsOf(input);
  const otherOwner={...rows,owner_id:'owner-b'};
  assert.equal(fresh(set,otherOwner).code,'MP_MEMBER_FOREIGN_BOT');
  const otherBot={...rows,bot_id:'bot-b'};
  assert.equal(fresh(set,otherBot).code,'MP_MEMBER_FOREIGN_BOT');
  const foreignRow=clone(rows);foreignRow.memberships[0].bot_id='bot-b';
  assert.equal(fresh(set,foreignRow).code,'MP_MEMBER_FOREIGN_BOT');
  const tampered=clone(set);tampered.bridge_pair.rr='9';
  assert.equal(fresh(tampered,rows).code,'MP_INPUT_INVALID');
  assert.equal(fresh(null,rows).code,'MP_INPUT_INVALID');
  assert.equal(fresh(set,null).code,'MP_INPUT_INVALID');
  assert.equal(fresh(set,{...rows,fixture:true}).code,'MP_INPUT_INVALID');
  assert.equal(fresh(set,{...rows,member_set_id:SET_A}).code,'MP_INPUT_INVALID');
  assert.equal(fresh(set,{...rows,member_deployments:[]}).code,'MP_INPUT_INVALID');
  // M6: evidence of a deployment that is not among the rows is refused in freshness too
  const orphan=clone(rows);orphan.evidence.push({...clone(orphan.evidence[0]),deployment_id:'dep-ghost'});
  assert.deepEqual(fresh(set,orphan).diagnostic,{field:'evidence[2].deployment_id'});
  const bad=clone(rows);bad.deployments[0].snapshot.captured_at=2;
  assert.equal(fresh(set,bad).code,'MP_INPUT_INVALID');
  const noKey=clone(set);delete noKey.fixture;
  assert.equal(fresh(noKey,rows).code,'MP_INPUT_INVALID');
});

// ---------------------------------------------------------------- T-M4

test('T-M4: every emitted code matches the pattern, belongs to the contract list and each S1 code was seen',()=>{
  for(const code of seen) {
    assert.match(code,MP_CODE_PATTERN);
    assert.ok(MP_CODE_LIST.includes(code),code);
  }
  for(const code of MP_S1_CODES)assert.ok(seen.has(code),'never produced in this file: '+code);
  // nothing outside the S1 list is produced by this module
  for(const code of seen)assert.ok(MP_S1_CODES.includes(code),code);
});
