import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {QUALIFIED_TOTAL,QUALIFIED_WINNER,qualification} from '../src/quant-library/derive.js';
import {EPISODE_GATE_VERSION} from '../src/quant-library/package-gates.js';
import * as selection from '../src/selection/index.js';
// The label builder and the filter function are internal to the module (index.js does not export them); the tests reach them by path.
import {buildLabel} from '../src/selection/labels.js';
import {applyFilters,rankPassed} from '../src/selection/ranking.js';

const {buildRegistration,evaluateEligibility,recheckWindow,validateWindow,validateObjective,transitionSelection,TRANSITIONS,
  OBJECTIVE_REGISTRY,CODE_LIST,CODE_PATTERN,deriveOverlays,checkDevelopmentViewRequest,developmentRowViolations,validateEvaluationRequest,checkRouteAction,
  checkCancel,registrationHashOf,metricsVisible,refuseRegistrationChange,scopeStatement,keyTokens,digest,INCOMPLETE_CODES,INCOMPLETE_PRIORITY,EVALUATION_REQUEST_KEYS,overlapsSearchedData}=selection;

/*
 * QR-4 S1, test plan 16.1. Every object below is a LABELLED ENGINEERING FIXTURE: synthetic rows, never a research result. The
 * module is pure, so no database, clock, network or file is used. Hashes in expectations come from an independent canonical JSON
 * writer and node:crypto in this file. The golden outcome_hash pin is a regression pin of the implementation output, checked
 * against that independent writer in the same test.
 */
const MS=60000,DAY=86400000;
const OWNER='owner-a',T0=Date.UTC(2026,9,20,0,0,0);
const ref=value=>Array.isArray(value)?'['+value.map(ref).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+ref(value[k])).join(',')+'}':JSON.stringify(value);
const sha=text=>createHash('sha256').update(text).digest('hex');
const clone=value=>structuredClone(value);
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(k=>[k,reorder(value[k])])):value;
const ENGINE=sha('engine'),POLICY=sha('policy'),DATASET=sha('window-dataset');
const RULES_OBJECT={maximum_drawdown_percent:'25',minimum_closed_trades_test:10};
const RULES=sha(ref(RULES_OBJECT));
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MARKET_KEY=ref(MARKET);

// The codes of one result (test 20). The coverage test at the end builds its own results and does not depend on test order.
const codesOf=out=>{
  const found=new Set();
  if(out&&typeof out==='object'){
    if(typeof out.code==='string')found.add(out.code);
    if(Array.isArray(out.codes))out.codes.forEach(code=>found.add(code));
    if(Array.isArray(out.failures))out.failures.forEach(item=>found.add(item.code));
    if(Array.isArray(out.not_passed))out.not_passed.forEach(item=>item.filter_codes.forEach(code=>found.add(code)));
  }
  return found;
};
const note=out=>out;

// OD-S3: the tie tolerances are registry constants that the owner has not set yet, so the product registry holds null and refuses.
// Every registration test injects a TEST registry (labelled engineering fixture values, never the owner's decision).
const OBJECTIVE_ID='qr4-objective-lexi-v1';
const testRegistry=(returnPp='0.5',drawdownPp='0.5')=>{
  const registry=clone(OBJECTIVE_REGISTRY);
  registry[OBJECTIVE_ID].tie_tolerances.return_pp=returnPp;
  registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp=drawdownPp;
  return registry;
};
const TEST_REGISTRY=testRegistry();
const SCOPE={market:clone(MARKET),data_model:{data_profile:'spot-klines-1m',price_tick:'0.01',quantity_step:'0.00001'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'5'},
  capital:{equity:'10000',cash:'10000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const W={kind:'PROSPECTIVE',start_ms:T0+DAY,end_ms:T0+DAY+1000*MS,warmup_bars:200};
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
const qual=()=>({version:'library-qualification-v1',qualified:true,label:'QUALIFIED',gates:GATES.map(gate=>({gate,name:'N_'+gate,state:'PASS',code:null}))});
const range=(fromDays,toDays)=>({start_ms:T0-fromDays*DAY,end_ms:T0-toDays*DAY});

function member(i,over={}){
  const run='run-'+i,exp='exp-'+i,pkgHash=sha('pkg'+i);
  const binding={mode:'ONE_PINE',fixture:false,pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i,membership:[{pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:sha('lock'+i)};
  const current={...clone(binding),dataset_available:true,bot_owner_id:OWNER};
  return {kind:'RESEARCH_RUN',owner_id:OWNER,run_id:run,export_id:exp,created_at_ms:T0-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:sha('src'+i),market:clone(MARKET),
    qualification:qual(),integrity_checked:true,
    package:{export_id:exp,package_hash:pkgHash,status:'EXPORT_VALIDATED',binding,current,replay_mismatch:false},
    validation_records:[{run_id:run,mode:'ONE_PINE',record:{fixture:false,export_id:exp,package_hash:pkgHash,binding_hash:sha('bind'+i),validated_at_utc:'2026-10-18T10:00:00Z',
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:clone(SCOPE.data_model),cost_model:clone(SCOPE.cost_model),capital:clone(SCOPE.capital),policy:clone(SCOPE.policy),engine:ENGINE},
    library_class:'READY_FOR_REVIEW',
    rules_hash:RULES,rules:clone(RULES_OBJECT),
    data_windows:{dataset:range(40,10),train:range(40,32),validation:range(32,26),holdout:range(26,10)},registered_boundary_ms:null,...over};
}
const DEPS={qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'};
const OBJECTIVE={id:OBJECTIVE_ID};
const FILTERS={drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false};
const request=(members,over={})=>({owner_id:OWNER,selection_id:'sel-1',registered_at_ms:T0,confirmed:true,fixture:false,scope:clone(SCOPE),window:{...W},objective:{...OBJECTIVE},
  filters:{...FILTERS},admission_deadline_ms:W.end_ms+DAY,universe:members,...over});
// The server-read facts: the requester, the policy snapshot of the registered policy hash, the earlier selections, the earlier registrations.
const context=(over={})=>({dependencies:{...DEPS},exposure_register:[],searched_windows:[],universe_cap:20,requester_owner_id:OWNER,
  policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},prior_selection_ids:[],existing_registrations:[],objective_registry:TEST_REGISTRY,fixture_selections_allowed:true,...over});
const members=(n,fix)=>Array.from({length:n},(_,k)=>member(k+1,fix?fix(k+1):{}));
// A fixture package (OD-S15): its binding and validation record carry fixture true, and its run never qualifies in the library (G8 fails).
const fixtureOver=i=>{
  const base=member(i);
  base.package.binding.fixture=true;base.package.current.fixture=true;base.validation_records[0].record.fixture=true;
  const q=qual();q.label='DEVELOPMENT_ONLY';q.qualified=false;q.gates[7]={gate:'G8',name:'N_G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'};
  return {package:base.package,validation_records:base.validation_records,qualification:q};
};
const register=(n=3,over={},ctx={},fix=null)=>note(buildRegistration(request(members(n,fix),over),context(ctx)));
const regOf=(n=3,over={},ctx={},fix=null)=>{const out=register(n,over,ctx,fix);assert.equal(out.ok,true,JSON.stringify(out));return out.registration;};

// Evaluation fixtures: one per participant, built from the registration.
function evaluation(reg,i,v={}){
  const result={evaluation_bars:reg.window.evaluation_bars,metrics:{net_return_percent:v.net??'2',max_drawdown_percent:v.dd??'5',closed_trades:v.trades??9},
    episodes:v.episodes??8,rejected_intents:v.rejected??0,fees:'1.2',slippage:'0.4',exposure_percent:'35',cost_stress:{net_return_percent:v.stress??'1'},
    benchmark:v.bench===null?null:{net_return_percent:v.bench??'0.1'},...v.extra};
  return {run_id:'ev-'+i,parent_run_id:'run-'+i,selection_id:reg.selection_id,mode:'QR4_SELECTION_EVAL',status:'SUCCEEDED',
    integrity:{contract_hash_verified:true,report_matches_checkpoints:true},engine_hash:ENGINE,dataset_hash:DATASET,result,result_hash:sha(ref(result)),...v.over};
}
const evaluations=(reg,list)=>list.map((v,k)=>evaluation(reg,k+1,v));
// The frozen W dataset hash comes from the freeze record of W (M4); every wrapper below passes it unless a test says otherwise.
const FROZEN={window_dataset_hash:DATASET};
const rankSelection=(reg,list,options=FROZEN)=>selection.rankSelection(reg,list,options);
const replayOutcome=(reg,list,stored,options=FROZEN)=>selection.replayOutcome(reg,list,stored,options);
const rank=(reg,list)=>note(rankSelection(reg,evaluations(reg,list)));
const rehash=ev=>{ev.result_hash=sha(ref(ev.result));return ev;};

test('codes: the list is unique and every code matches the pattern (test 20 part 1)',()=>{
  assert.equal(new Set(CODE_LIST).size,CODE_LIST.length);
  assert.ok(CODE_LIST.every(code=>/^[A-Z][A-Z0-9_]{1,63}$/.test(code)));
  assert.equal(String(CODE_PATTERN),String(/^[A-Z][A-Z0-9_]{1,63}$/));
});

test('registry: qr4-objective-lexi-v1 is frozen with exact ids and key order (test 19)',()=>{
  assert.deepEqual(Object.keys(OBJECTIVE_REGISTRY),['qr4-objective-lexi-v1']);
  const expected='{"qr4-objective-lexi-v1":{"id":"qr4-objective-lexi-v1","kind":"LEXICOGRAPHIC","filters":['+
    '{"id":"F1","code":"FILTER_DRAWDOWN_LIMIT","metric":"max_drawdown_percent","test":"AT_MOST_REGISTERED_LIMIT","required":true},'+
    '{"id":"F2","code":"FILTER_EPISODE_FLOOR","metric":"episodes","test":"AT_LEAST_REGISTERED_FLOOR","required":true},'+
    '{"id":"F3","code":"FILTER_COST_STRESS","metric":"cost_stress_net_return_percent","test":"NOT_NEGATIVE","required":true},'+
    '{"id":"F4","code":"FILTER_NET_RETURN_POSITIVE","metric":"net_return_percent","test":"GREATER_THAN_ZERO","required":true},'+
    '{"id":"F5","code":"FILTER_BEATS_BUY_AND_HOLD","metric":"net_return_percent","test":"GREATER_THAN_BUY_AND_HOLD","required":false}],'+
    '"primary":{"metric":"net_return_percent","direction":"HIGHER_IS_BETTER"},'+
    '"secondary":{"metric":"max_drawdown_percent","direction":"LOWER_IS_BETTER","use":"INSIDE_PRIMARY_TIE_GROUP_ONLY"},'+
    '"third_key":null,"weights":null,"tie_tolerances":{"return_pp":null,"drawdown_pp":null,"unit":"PERCENTAGE_POINTS"},'+
    '"uncertainty":"qr4-uncertainty-disclosure-v1","arithmetic":"EXACT_DECIMAL"}}';
  assert.equal(JSON.stringify(OBJECTIVE_REGISTRY),expected);
  assert.ok(Object.isFrozen(OBJECTIVE_REGISTRY)&&Object.isFrozen(OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'].filters[0]));
  assert.throws(()=>{'use strict';OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'].third_key='x';});
  assert.throws(()=>{'use strict';OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'].tie_tolerances.return_pp='0.5';});
  // OD-S3: the owner has not set the tolerances, so the product registry holds null and no registration can pass it.
  assert.deepEqual(OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'].tie_tolerances,{return_pp:null,drawdown_pp:null,unit:'PERCENTAGE_POINTS'});
});

test('golden: three participants with distinct returns give BEST_IN_SCOPE, expected ranks and outcome_hash (test 1)',()=>{
  const reg=regOf(3);
  const out=rank(reg,[{net:'3.2',dd:'6'},{net:'1.4',dd:'3'},{net:'2.1',dd:'4'}]);
  assert.equal(out.status,'SELECTION_COMPLETED');
  assert.equal(out.outcome,'BEST_IN_SCOPE');
  assert.deepEqual(out.ranking.map(item=>[item.rank,item.export_id,item.decided_by]),[[1,'exp-1','PRIMARY'],[2,'exp-3','PRIMARY'],[3,'exp-2','PRIMARY']]);
  assert.equal(out.participant_count,3);
  assert.equal(out.label.label_text,'Best of 3 compared strategies within the selected scope');
  assert.deepEqual(out.label.participants,['exp-1']);
  const {outcome_hash:stored,...rest}=out;
  assert.equal(stored,sha(ref(JSON.parse(JSON.stringify(rest)))));
  assert.match(stored,/^[a-f0-9]{64}$/);
  assert.equal(stored,'a71e1445466db14254b4fa9399bfd7d0f0201638fa71f637274d76e874e984fe');
  assert.equal(out.registration_hash,reg.registration_hash);
  assert.equal(reg.registration_hash,'72e4213d73d7964e8d92c4c3831927243674c07d395b5bc7a87252e620724b87');
  assert.equal(reg.registration_hash,sha(ref(JSON.parse(JSON.stringify((({registration_hash,...body})=>body)(reg))))));
  // The same inputs rank to the same hash again (no clock, no random source).
  assert.equal(rank(reg,[{net:'3.2',dd:'6'},{net:'1.4',dd:'3'},{net:'2.1',dd:'4'}]).outcome_hash,stored);
  assert.ok(Object.isFrozen(out)&&Object.isFrozen(out.ranking));
});

test('ties: a primary tie is separated by drawdown (SECONDARY); equal on both keys is TIED_IN_SCOPE with the full set (test 2)',()=>{
  const reg=regOf(3);
  const bySecondary=rank(reg,[{net:'3.2',dd:'6'},{net:'3.0',dd:'2'},{net:'1',dd:'1'}]);
  assert.equal(bySecondary.outcome,'BEST_IN_SCOPE');
  assert.deepEqual(bySecondary.ranking.map(item=>[item.rank,item.export_id,item.decided_by]),[[1,'exp-2','SECONDARY'],[2,'exp-1','PRIMARY'],[3,'exp-3','PRIMARY']]);
  const tied=rank(reg,[{net:'3.2',dd:'2'},{net:'3.0',dd:'2'},{net:'1',dd:'1'}]);
  assert.equal(tied.outcome,'TIED_IN_SCOPE');
  assert.deepEqual(tied.ranking.filter(item=>item.rank===1).map(item=>item.export_id).sort(),['exp-1','exp-2']);
  assert.ok(tied.ranking.filter(item=>item.rank===1).every(item=>item.decided_by==='TIE'));
  assert.equal(tied.label.label_text,'Tied for best of 3 compared strategies within the selected scope');
  assert.deepEqual([...tied.label.participants].sort(),['exp-1','exp-2']);
  assert.equal(tied.ranking.find(item=>item.export_id==='exp-3').rank,2);
});

test('boundary: a difference equal to the tolerance is a tie; one decimal unit above is not (test 3)',()=>{
  const reg=regOf(2);
  const exact=rank(reg,[{net:'3.5',dd:'5'},{net:'3.0',dd:'5'}]);
  assert.equal(exact.outcome,'TIED_IN_SCOPE');
  const above=rank(reg,[{net:'3.500000000000000001',dd:'5'},{net:'3.0',dd:'5'}]);
  assert.equal(above.outcome,'BEST_IN_SCOPE');
  assert.equal(above.ranking[0].export_id,'exp-1');
  assert.equal(above.ranking[0].decided_by,'PRIMARY');
  // Drawdown tolerance boundary inside a primary tie group.
  const ddExact=rank(reg,[{net:'3.0',dd:'5.5'},{net:'3.0',dd:'5.0'}]);
  assert.equal(ddExact.outcome,'TIED_IN_SCOPE');
  const ddAbove=rank(reg,[{net:'3.0',dd:'5.500000000000000001'},{net:'3.0',dd:'5.0'}]);
  assert.equal(ddAbove.outcome,'BEST_IN_SCOPE');
  assert.equal(ddAbove.ranking[0].export_id,'exp-2');
  assert.equal(ddAbove.ranking[0].decided_by,'SECONDARY');
});

test('exact decimal: 1.10 equals 1.1 and 1.1 minus 1.0 is exactly 0.1 (test 4)',()=>{
  assert.ok(1.1-1.0>0.1,'binary floating point would call this a non-tie');
  const regTight=regOf(2,{},{objective_registry:testRegistry('0.1','0')});
  const exact=rank(regTight,[{net:'1.1',dd:'4'},{net:'1.0',dd:'4'}]);
  assert.equal(exact.outcome,'TIED_IN_SCOPE');
  const zero=regOf(2,{},{objective_registry:testRegistry('0','0')});
  const same=rank(zero,[{net:'1.10',dd:'4.0'},{net:'1.1',dd:'4'}]);
  assert.equal(same.outcome,'TIED_IN_SCOPE');
  assert.equal(same.evaluations.find(item=>item.export_id==='exp-1').values.net_return_percent,'1.1');
  const tenths=rank(zero,[{net:'0.3',dd:'1'},{net:'0.30000000000000004',dd:'1'}]);
  assert.equal(tenths.outcome,'BEST_IN_SCOPE');
  assert.equal(tenths.ranking[0].export_id,'exp-2');
  // 0.1 + 0.2 is not 0.3 in binary floating point; as decimals the two spellings of one value tie.
  const sum=rank(zero,[{net:'0.3',dd:'1'},{net:'0.30',dd:'1'}]);
  assert.equal(sum.outcome,'TIED_IN_SCOPE');
});

test('no qualifying strategy: every participant fails a strategy filter (test 5)',()=>{
  const reg=regOf(3);
  const out=rank(reg,[{net:'-1'},{net:'0'},{net:'2',dd:'30'}]);
  assert.equal(out.status,'SELECTION_COMPLETED');
  assert.equal(out.outcome,'NO_QUALIFYING_STRATEGY');
  assert.deepEqual(out.ranking,[]);
  assert.equal(out.label,null);
  assert.equal(out.text,'No qualifying strategy within the selected scope.');
  assert.equal(out.no_winner_text,'Qualified recommendations: none. No qualified winner.');
});

test('inadequate evidence: all fail only F2; a mix with another failure is NO_QUALIFYING_STRATEGY (test 6)',()=>{
  const reg=regOf(3);
  const inadequate=rank(reg,[{episodes:2},{episodes:0},{episodes:4}]);
  assert.equal(inadequate.outcome,'INADEQUATE_EVIDENCE');
  assert.equal(inadequate.label,null);
  assert.deepEqual(inadequate.ranking,[]);
  assert.ok(inadequate.evaluations.every(item=>item.result==='EVIDENCE_INADEQUATE'));
  assert.equal(inadequate.text,'Evidence is not adequate to rank within the selected scope.');
  const mixed=rank(reg,[{episodes:2},{episodes:0},{episodes:9,net:'-1'}]);
  assert.equal(mixed.outcome,'NO_QUALIFYING_STRATEGY');
  assert.equal(mixed.evaluations.find(item=>item.export_id==='exp-1').result,'EVIDENCE_INADEQUATE');
  // A participant that fails F2 together with another filter is not "only F2".
  const both=rank(reg,[{episodes:2,net:'-1'},{episodes:1},{episodes:0}]);
  assert.equal(both.outcome,'NO_QUALIFYING_STRATEGY');
});

test('filters: each negation gives exactly its filter code; a participant that fails two lists both (test 7)',()=>{
  const reg=regOf(2,{filters:{...FILTERS,beats_buy_and_hold:true}});
  const codesOf=(v)=>rank(reg,[v,{net:'4',dd:'2',bench:'1'}]).not_passed.find(item=>item.export_id==='exp-1')?.filter_codes;
  assert.deepEqual(codesOf({net:'2',dd:'20.000001',bench:'1'}),['FILTER_DRAWDOWN_LIMIT']);
  assert.deepEqual(codesOf({net:'2',episodes:4,bench:'1'}),['FILTER_EPISODE_FLOOR']);
  assert.deepEqual(codesOf({net:'2',stress:'-0.000001',bench:'1'}),['FILTER_COST_STRESS']);
  assert.deepEqual(codesOf({net:'0',bench:'-1'}),['FILTER_NET_RETURN_POSITIVE']);
  assert.deepEqual(codesOf({net:'2',bench:'2'}),['FILTER_BEATS_BUY_AND_HOLD']);
  assert.deepEqual(codesOf({net:'2',dd:'25',episodes:1,bench:'1'}),['FILTER_DRAWDOWN_LIMIT','FILTER_EPISODE_FLOOR']);
  // Equality edges: drawdown at the limit, episodes at the floor and stress at zero all pass.
  const edge=rank(reg,[{net:'2',dd:'20',episodes:5,stress:'0',bench:'1.999'},{net:'4',dd:'2',bench:'1'}]);
  assert.deepEqual(edge.ranking.map(item=>item.export_id),['exp-2','exp-1']);
  // F5 is optional: without it, a participant that does not beat Buy & Hold still passes.
  const optional=regOf(2);
  assert.equal(rank(optional,[{net:'2',bench:'9'},{net:'1',bench:'9'}]).outcome,'BEST_IN_SCOPE');
});

const shuffle=(list,seed)=>{
  const out=[...list];let s=seed*2654435761%4294967296;
  for(let i=out.length-1;i>0;i--){s=(s*1664525+1013904223)%4294967296;const j=s%(i+1);[out[i],out[j]]=[out[j],out[i]];}
  return out;
};
test('permutation invariance: shuffled participants, evaluations and object keys give one outcome_hash over 100 permutations (test 8)',()=>{
  const reg=regOf(4);
  const list=evaluations(reg,[{net:'3.2',dd:'6'},{net:'3.0',dd:'2'},{net:'2.9',dd:'2.2'},{net:'-1'}]);
  const base=rankSelection(reg,list).outcome_hash;
  assert.match(base,/^[a-f0-9]{64}$/);
  for(let k=1;k<=100;k++){
    const copy=clone(reg);
    copy.participants=shuffle(copy.participants,k);
    copy.universe=shuffle(copy.universe,k+7);
    const registration=k%2?reorder(copy):copy;
    const evals=shuffle(list,k+13).map(item=>k%3?reorder(clone(item)):clone(item));
    const out=rankSelection(registration,evals);
    assert.equal(out.outcome_hash,base,'permutation '+k);
  }
});

test('independence: a participant that fails a filter never changes the ranks or the outcome of the others (test 9)',()=>{
  const four=regOf(4);
  const withFailing=rank(four,[{net:'3.2',dd:'6'},{net:'1.4',dd:'3'},{net:'2.1',dd:'4'},{net:'9',dd:'50'}]);
  assert.equal(withFailing.outcome,'BEST_IN_SCOPE');
  assert.deepEqual(withFailing.ranking.map(item=>[item.rank,item.export_id]),[[1,'exp-1'],[2,'exp-3'],[3,'exp-2']]);
  const failingElsewhere=rank(four,[{net:'3.2',dd:'6'},{net:'1.4',dd:'3'},{net:'2.1',dd:'4'},{net:'-9',dd:'1'}]);
  assert.deepEqual(failingElsewhere.ranking,withFailing.ranking);
  assert.deepEqual(withFailing.not_passed.map(item=>item.export_id),['exp-4']);
});

test('no third tiebreak: equal on both keys stays tied across different ids, creation times and parameters (test 10)',()=>{
  const reg=regOf(3,{},{},null);
  const early=clone(reg);
  const out=rank(reg,[{net:'2',dd:'4'},{net:'2',dd:'4'},{net:'2',dd:'4'}]);
  assert.equal(out.outcome,'TIED_IN_SCOPE');
  assert.equal(out.ranking.length,3);
  assert.ok(out.ranking.every(item=>item.rank===1));
  // Creation time and ids differ between participants (member fixtures use distinct run ids and creation times) and are not read.
  assert.ok(new Set(early.participants.map(item=>item.created_at_ms)).size===3);
  assert.equal(rank(reg,[{net:'2',dd:'4'},{net:'2.4',dd:'4'},{net:'2',dd:'4'}]).outcome,'TIED_IN_SCOPE');
});

test('incomplete: a gap ends SELECTION_INCOMPLETE with the section 10 code, never a partial ranking, never throws (test 11)',()=>{
  const reg=regOf(3);
  const ok=[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}];
  const mutate=(index,fn)=>{const list=evaluations(reg,ok);fn(list[index]);return note(rankSelection(reg,list));};
  const expect=(out,code)=>{
    assert.equal(out.status,'SELECTION_INCOMPLETE');
    assert.equal(out.outcome,null);
    assert.equal(out.ranking,null);
    assert.equal(out.label,null);
    assert.ok(out.codes.includes(code),JSON.stringify(out.codes)+' expected '+code);
    assert.equal(out.outcome_hash,undefined);
  };
  expect(note(rankSelection(reg,evaluations(reg,ok).slice(0,2))),'QR4_EVALUATION_FAILED');
  expect(mutate(0,ev=>{ev.status='FAILED';}),'QR4_EVALUATION_FAILED');
  expect(mutate(0,ev=>{ev.status='TIMED_OUT';}),'QR4_EVALUATION_FAILED');
  expect(mutate(0,ev=>{ev.status='CANCELLED';}),'QR4_EVALUATION_FAILED');
  expect(mutate(1,ev=>{delete ev.result.metrics.net_return_percent;rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(1,ev=>{ev.result.metrics.max_drawdown_percent=null;rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(1,ev=>{ev.result.metrics.net_return_percent=2;rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(1,ev=>{ev.result.metrics.net_return_percent='abc';rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(1,ev=>{ev.result.episodes='8';rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(1,ev=>{delete ev.result.cost_stress;rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(1,ev=>{ev.result.metrics.max_drawdown_percent='-1';rehash(ev);}),'QR4_METRIC_MISSING');
  expect(mutate(2,ev=>{ev.result.benchmark=null;rehash(ev);}),'QR4_BENCHMARK_UNAVAILABLE');
  expect(mutate(2,ev=>{ev.integrity.contract_hash_verified=false;}),'INTEGRITY_CHECK_FAILED');
  expect(mutate(2,ev=>{ev.integrity=null;}),'INTEGRITY_CHECK_FAILED');
  expect(mutate(2,ev=>{ev.result.metrics.net_return_percent='9';}),'INTEGRITY_CHECK_FAILED');
  expect(mutate(2,ev=>{ev.selection_id='other-selection';}),'INTEGRITY_CHECK_FAILED');
  expect(mutate(2,ev=>{ev.engine_hash=sha('other-engine');}),'QR4_ENGINE_MISMATCH');
  expect(mutate(0,ev=>{ev.dataset_hash=sha('other-window-data');}),'BI_DATASET_HASH_MISMATCH');
  expect(mutate(0,ev=>{ev.result.evaluation_bars+=1;rehash(ev);}),'QR4_WINDOW_DATA_GAP');
  const duplicate=evaluations(reg,ok);duplicate.push(clone(duplicate[0]));
  expect(note(rankSelection(reg,duplicate)),'INTEGRITY_CHECK_FAILED');
  const stranger=evaluations(reg,ok);stranger.push({...clone(stranger[0]),parent_run_id:'run-unknown'});
  expect(note(rankSelection(reg,stranger)),'INTEGRITY_CHECK_FAILED');
  // The registration is frozen: a changed copy no longer matches its hash.
  // An altered or unreadable registration is INTEGRITY_CHECK_FAILED (section 10); QR4_REGISTRATION_IMMUTABLE is a change request.
  const tampered=clone(reg);tampered.filters.drawdown_limit_percent='99';
  const tamperedOut=note(rankSelection(tampered,evaluations(reg,ok)));
  expect(tamperedOut,'INTEGRITY_CHECK_FAILED');
  assert.deepEqual([tamperedOut.codes.includes('QR4_REGISTRATION_IMMUTABLE'),tamperedOut.problems[0].detail],[false,'REGISTRATION_HASH']);
  const unreadableOut=note(rankSelection({},evaluations(reg,ok)));
  expect(unreadableOut,'INTEGRITY_CHECK_FAILED');
  assert.equal(unreadableOut.problems[0].detail,'REGISTRATION_UNREADABLE');
  // M4: the evaluations must equal the FROZEN W dataset hash. Evaluations that agree with each other on the same wrong data are not enough.
  const sameWrong=evaluations(reg,ok).map(ev=>({...ev,dataset_hash:sha('same-wrong-data')}));
  const wrongOut=note(rankSelection(reg,sameWrong));
  expect(wrongOut,'BI_DATASET_HASH_MISMATCH');
  assert.deepEqual(wrongOut.problems.map(item=>[item.participant,item.detail]),[['exp-1','DATASET_HASH_DIFFERS'],['exp-2','DATASET_HASH_DIFFERS'],['exp-3','DATASET_HASH_DIFFERS']]);
  for(const options of [{},null,{window_dataset_hash:'zz'},{window_dataset_hash:null},{window_dataset_hash:7}]){
    const missing=note(rankSelection(reg,evaluations(reg,ok),options));
    expect(missing,'BI_DATASET_HASH_MISMATCH');
    assert.equal(missing.problems[0].detail,'FROZEN_DATASET_HASH_MISSING');
  }
  assert.equal(rankSelection(reg,evaluations(reg,ok),{window_dataset_hash:DATASET}).status,'SELECTION_COMPLETED');
  // L13: completed_evaluation_ids lists only SUCCEEDED evaluations.
  for(const status of ['FAILED','TIMED_OUT','CANCELLED']){
    const partial=evaluations(reg,ok);partial[0].status=status;
    assert.deepEqual(rankSelection(reg,partial).completed_evaluation_ids,['ev-2','ev-3'],status);
  }
  assert.deepEqual(rankSelection(reg,evaluations(reg,ok).slice(0,2)).completed_evaluation_ids,['ev-1','ev-2']);
  // A drawdown of negative zero is a valid zero drawdown, not a missing metric.
  const negZero=rank(reg,[{net:'3',dd:'-0'},{net:'2',dd:'3'},{net:'1',dd:'3'}]);
  assert.equal(negZero.status,'SELECTION_COMPLETED');
  assert.equal(negZero.ranking[0].max_drawdown_percent,'0');
  for(const bad of [[null,null],[reg,null],[reg,'x'],[undefined,[]],[{},{}],[reg,[null,1,'x']],[reg,[{}]]]){
    assert.doesNotThrow(()=>note(rankSelection(...bad)));
    assert.equal(rankSelection(...bad).status,'SELECTION_INCOMPLETE');
  }
  // Several problems: every code is listed and the primary code follows the fixed priority.
  const many=evaluations(reg,ok);many[0].status='FAILED';many[1].engine_hash=sha('x');
  const manyOut=note(rankSelection(reg,many));
  assert.equal(manyOut.code,'QR4_EVALUATION_FAILED');
  assert.deepEqual([...manyOut.codes].sort(),['QR4_ENGINE_MISMATCH','QR4_EVALUATION_FAILED'].sort());
});

// ---- eligibility (tests 12, 13, 14) ----
const CTX={owner_id:OWNER,requester_owner_id:OWNER,scope:SCOPE};
const eligibility=(m)=>note(evaluateEligibility(m,CTX));
test('eligibility: a clean READY qualified member is a participant with its validation binding (E1 to E6)',()=>{
  const out=eligibility(member(1));
  assert.equal(out.eligible,true);
  assert.equal(out.status,'PARTICIPANT');
  assert.deepEqual(Object.values(out.checks),['PASS','PASS','PASS','PASS','PASS','PASS']);
  assert.deepEqual(out.validation_binding,{export_id:'exp-1',package_hash:sha('pkg1'),validated_at_utc:'2026-10-18T10:00:00Z'});
  assert.equal(out.code,null);
});
test('eligibility: one negation per check gives the expected code (test 12)',()=>{
  const gateFail=member(1);gateFail.qualification.gates[2]={gate:'G3',name:'ROBUSTNESS',state:'FAIL',code:'COST_STRESS_FAILED'};
  let out=eligibility(gateFail);
  assert.deepEqual([out.code,out.detail,out.checks.E1],['QR4_PARTICIPANT_NOT_QUALIFIED','COST_STRESS_FAILED','FAIL']);
  out=eligibility({...member(1),integrity_checked:false});
  assert.deepEqual([out.code,out.detail],['QR4_PARTICIPANT_NOT_QUALIFIED','INTEGRITY_NOT_CHECKED']);
  out=eligibility({...member(1),package:{...member(1).package,status:'EXPORT_INTERNAL'}});
  assert.deepEqual([out.code,out.detail,out.checks.E2],['QR4_PARTICIPANT_NOT_READY','EXPORT_INTERNAL','FAIL']);
  for(const status of ['EXPORT_CANDIDATE','EXPORT_REFUSED','NO_VALID_CANDIDATE']){
    out=eligibility({...member(1),package:{...member(1).package,status}});
    assert.deepEqual([out.code,out.detail,out.eligible],['QR4_PARTICIPANT_NOT_READY',status,false]);
  }
  const wrongBot=member(1);wrongBot.package.current.bot_owner_id='someone-else';
  out=eligibility(wrongBot);
  assert.deepEqual([out.code,out.detail],['QR4_PARTICIPANT_NOT_READY','BOT_NOT_OWNED']);
  const unknownReplay=member(1);delete unknownReplay.package.replay_mismatch;
  out=eligibility(unknownReplay);
  assert.deepEqual([out.code,out.detail],['QR4_PARTICIPANT_NOT_READY','BI_REPLAY_STATE_UNAVAILABLE']);
  const noRecord=member(1,{validation_records:[]});
  out=eligibility(noRecord);
  assert.deepEqual([out.code,out.detail,out.checks.E3],['QR4_VALIDATION_BINDING_MISMATCH','G8_RECORD_MISSING','FAIL']);
  const wrongMarket=member(1,{market:{...MARKET,symbol:'ETHUSDT'}});
  out=eligibility(wrongMarket);
  assert.deepEqual([out.code,out.checks.E4],['BI_MARKET_SCOPE_INVALID','FAIL']);
  const costs=member(1);costs.scope.cost_model={...costs.scope.cost_model,fee_bps:'20'};
  out=eligibility(costs);
  assert.deepEqual([out.code,out.checks.E5,out.mismatched_fields],['QR4_SCOPE_INCOMPATIBLE','FAIL',['cost_model']]);
  const manyFields=member(1);manyFields.scope.capital={equity:'1',cash:'1'};manyFields.scope.data_model={...manyFields.scope.data_model,price_tick:'0.1'};
  assert.deepEqual(eligibility(manyFields).mismatched_fields,['data_model','capital']);
  // M1: the engine of the participant's own research run is not compared. After an engine update older packages stay eligible.
  const oldEngine=member(1);oldEngine.scope.engine=sha('old-engine');
  assert.deepEqual([eligibility(oldEngine).eligible,eligibility(oldEngine).mismatched_fields],[true,[]]);
  const noEngine=member(1);delete noEngine.scope.engine;
  assert.equal(eligibility(noEngine).eligible,true);
  assert.equal(selection.SCOPE_FIELDS.includes('engine'),false);
  const missingField=member(1);delete missingField.scope.policy;
  assert.deepEqual(eligibility(missingField).mismatched_fields,['policy']);
  const fixture=member(1);fixture.package.binding.fixture=true;fixture.package.current.fixture=true;
  out=eligibility(fixture);
  assert.deepEqual([out.code,out.checks.E6],['QR4_FIXTURE_PARTICIPANT','FAIL']);
  const multi=member(1);multi.package.binding.mode='MULTI_PINE';multi.package.status='EXPORT_INTERNAL';
  out=eligibility(multi);
  assert.equal(out.code,'QR4_MULTI_PINE_PARTICIPANT');
  assert.ok(out.failures.some(item=>item.code==='QR4_PARTICIPANT_NOT_READY'),'the general package failure is listed as well');
});
test('eligibility: never-participants are refused (test 12)',()=>{
  const real=qualification({status:'SUCCEEDED',result:{holdout_evaluated:true,selected:{screen_reasons:[]}},blockers:[],integrity:{contract_hash_verified:true,report_matches_checkpoints:true},
    holdoutOverlap:{overlaps:false},contractVersion:'none'});
  assert.equal(real.qualified,false,'DERIVE G8 always fails');
  const devOnly=member(1,{qualification:real});
  const out=eligibility(devOnly);
  assert.deepEqual([out.code,out.eligible],['QR4_DEVELOPMENT_SCORE_NOT_RANKABLE',false]);
  assert.equal(out.detail,real.gates.find(gate=>gate.state!=='PASS').code);
  for(const label of ['NOT_EVALUATED','NO_SCREENED_CANDIDATE','DEVELOPMENT_ONLY']){
    const q=qual();q.label=label;q.qualified=false;q.gates[7]={gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'};
    assert.equal(eligibility(member(1,{qualification:q})).code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
  }
  assert.deepEqual([eligibility(member(1,{run_status:'NO_VALID_CANDIDATE'})).code,eligibility(member(1,{run_status:'NO_VALID_CANDIDATE'})).detail],['QR4_PARTICIPANT_NOT_QUALIFIED','NO_VALID_CANDIDATE']);
  for(const status of ['FAILED','CANCELLED','TIMED_OUT','INSUFFICIENT_DATA'])assert.equal(eligibility(member(1,{run_status:status})).code,'QR4_PARTICIPANT_NOT_QUALIFIED');
  assert.equal(eligibility(member(1,{kind:'IMPORTED_BUNDLE'})).code,'QR4_PARTICIPANT_NOT_READY');
  assert.equal(eligibility(member(1,{kind:'ACTUAL_HISTORY'})).code,'QR4_ACTUAL_HISTORY_NOT_RANKABLE');
  assert.equal(eligibility(member(1,{kind:'EVALUATION_RUN'})).code,'QR4_PARTICIPANT_NOT_QUALIFIED');
  assert.equal(eligibility(member(1,{kind:'SOMETHING'})).code,'QR4_PARTICIPANT_NOT_QUALIFIED');
  assert.equal(eligibility(member(1,{owner_id:'owner-b'})).code,'NOT_FOUND');
  assert.equal(eligibility(null).eligible,false);
});
test('eligibility: a STALE package of a qualified run is listed as QUALIFIED_STALE and never ranked (test 12)',()=>{
  const stale=member(1);stale.package.current.deployment_id='dep-changed';
  const out=eligibility(stale);
  assert.deepEqual([out.status,out.eligible,out.code,out.detail],['QUALIFIED_STALE',false,'QR4_PARTICIPANT_NOT_READY','BI_DEPLOYMENT_CHANGED']);
  const replay=member(1);replay.package.replay_mismatch=true;
  assert.deepEqual([eligibility(replay).status,eligibility(replay).detail],['QUALIFIED_STALE','REPLAY_MISMATCH']);
  // A stale package that also fails another check is EXCLUDED, never QUALIFIED_STALE (only freshness may fail).
  const staleScope=member(1);staleScope.package.current.deployment_id='dep-changed';staleScope.scope.capital={equity:'1',cash:'1'};
  assert.deepEqual([eligibility(staleScope).status,eligibility(staleScope).checks.E5],['EXCLUDED','FAIL']);
  const staleMarket=member(1,{market:{...MARKET,symbol:'ETHUSDT'}});staleMarket.package.current.deployment_id='dep-changed';
  assert.equal(eligibility(staleMarket).status,'EXCLUDED');
  const staleBinding=member(1,{validation_records:[]});staleBinding.package.current.deployment_id='dep-changed';
  assert.equal(eligibility(staleBinding).status,'EXCLUDED');
  const staleGate=member(1);staleGate.package.current.deployment_id='dep-changed';staleGate.integrity_checked=false;
  assert.equal(eligibility(staleGate).status,'EXCLUDED');
  const registration=register(2,{},{},k=>k===1?{package:stale.package}:{});
  assert.equal(registration.ok,false);
  assert.equal(registration.code,'QR4_TOO_FEW_PARTICIPANTS');
  assert.equal(registration.universe.find(item=>item.run_id==='run-1').status,'QUALIFIED_STALE');
});
test('E3: a G8 record that names another package_hash gives QR4_VALIDATION_BINDING_MISMATCH (test 13)',()=>{
  const other=member(1);other.validation_records[0].record.package_hash=sha('some-other-package');
  const out=eligibility(other);
  assert.deepEqual([out.code,out.detail],['QR4_VALIDATION_BINDING_MISMATCH','PACKAGE_HASH_OR_EXPORT_DIFFERS']);
  const otherExport=member(1);otherExport.validation_records[0].record.export_id='exp-other';
  assert.equal(eligibility(otherExport).code,'QR4_VALIDATION_BINDING_MISMATCH');
  const noTime=member(1);delete noTime.validation_records[0].record.validated_at_utc;
  assert.equal(eligibility(noTime).code,'QR4_VALIDATION_BINDING_MISMATCH');
  const fixtureRecord=member(1);fixtureRecord.validation_records[0].record.fixture=true;
  assert.equal(eligibility(fixtureRecord).detail,'G8_RECORD_MISSING');
});
test('current real state: DERIVE gate G8 always fails, so every registration gives QR4_NO_ELIGIBLE_PARTICIPANT (test 14)',()=>{
  const real=qualification({status:'SUCCEEDED',result:{holdout_evaluated:true,selected:{screen_reasons:[]}},blockers:[],integrity:{contract_hash_verified:true,report_matches_checkpoints:true},
    holdoutOverlap:{overlaps:false},contractVersion:'none'});
  assert.equal(real.gates[7].code,'QL4C_VALIDATION_NOT_AVAILABLE');
  const out=register(3,{},{},()=>({qualification:real}));
  assert.equal(out.ok,false);
  assert.equal(out.code,'QR4_NO_ELIGIBLE_PARTICIPANT');
  assert.ok(out.universe.every(item=>item.code==='QR4_DEVELOPMENT_SCORE_NOT_RANKABLE'&&item.status==='EXCLUDED'));
  assert.equal(note(buildRegistration(request([]),context())).code,'QR4_NO_ELIGIBLE_PARTICIPANT');
  assert.equal(QUALIFIED_TOTAL,0);
  assert.equal(QUALIFIED_WINNER,null);
  // The episode gate does not exist yet: today every registration is also refused for that dependency.
  assert.equal(EPISODE_GATE_VERSION,null);
  assert.equal(note(buildRegistration(request(members(3)),context({dependencies:{...DEPS,episode_gate_version:EPISODE_GATE_VERSION}}))).code,'QR4_EPISODE_GATE_UNAVAILABLE');
});

// ---- registration refusals (tests 15, 16, 18 and section 9) ----
test('registration: a clean request freezes scope, W, objective copies, universe and participants',()=>{
  const reg=regOf(3,{},{prior_selection_ids:['sel-0']});
  assert.equal(reg.version,'qr4-registration-v1');
  assert.deepEqual([reg.window.evaluation_bars,reg.window.warmup_bars,reg.window.total_bars],[1000,200,1200]);
  assert.equal(reg.participant_count,3);
  assert.equal(reg.prior_selection_count,1);
  assert.deepEqual(reg.participants.map(item=>item.export_id),['exp-1','exp-2','exp-3']);
  assert.deepEqual(reg.universe.map(item=>item.run_id),['run-1','run-2','run-3']);
  assert.deepEqual([reg.objective.tie_tolerance_return_pp,reg.objective.tie_tolerance_drawdown_pp],['0.5','0.5']);
  // The registration keeps copies of the registry values and not the registry shape or a reference to it.
  assert.deepEqual([reg.objective.tie_tolerances,reg.objective.tolerance_parameters],[undefined,undefined]);
  assert.equal(reg.scope.policy_max_drawdown_percent,null);
  assert.deepEqual(reg.prior_selection_ids,['sel-0']);
  assert.equal(reg.filters.cost_stress_min_return_percent,'0');
  assert.equal(reg.filters.net_return_min_exclusive_percent,'0');
  assert.equal(reg.registration_hash,registrationHashOf(reg));
  assert.match(reg.registration_key,/^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(reg)&&Object.isFrozen(reg.participants[0]));
  assert.equal(reg.market.symbol,'BTCUSDT');
});
test('registration: the same registration key returns QR4_SELECTION_EXISTS with the existing id',()=>{
  const reg=regOf(3);
  const again=register(3,{selection_id:'sel-2'},{existing_registrations:[{owner_id:OWNER,registration_key:reg.registration_key,selection_id:'sel-1'}]});
  assert.deepEqual([again.ok,again.code,again.selection_id],[false,'QR4_SELECTION_EXISTS','sel-1']);
  assert.equal(register(3,{selection_id:'sel-2'},{existing_registrations:[{owner_id:'owner-b',registration_key:reg.registration_key,selection_id:'sel-9'}]}).ok,true);
  assert.equal(register(3,{},{existing_registrations:'x'}).code,'INVALID_FIELDS');
  // The key ignores the selection id and the registration time.
  assert.equal(regOf(3,{selection_id:'sel-5',registered_at_ms:T0+MS}).registration_key,reg.registration_key);
});
test('registration: confirmation, dependencies and request shape are refused first',()=>{
  assert.equal(register(3,{confirmed:false}).code,'CONFIRMATION_REQUIRED');
  assert.equal(register(3,{confirmed:undefined}).code,'CONFIRMATION_REQUIRED');
  assert.equal(register(3,{},{dependencies:{...DEPS,qr3_context:false}}).code,'QR4_QR3_CONTEXT_UNAVAILABLE');
  assert.equal(register(3,{},{dependencies:{...DEPS,evaluation_mode:undefined}}).code,'QR4_EVALUATION_MODE_UNAVAILABLE');
  assert.equal(register(3,{},{dependencies:{...DEPS,episode_gate_version:null}}).code,'QR4_EPISODE_GATE_UNAVAILABLE');
  assert.equal(register(3,{},{dependencies:undefined}).code,'QR4_QR3_CONTEXT_UNAVAILABLE');
  assert.equal(note(buildRegistration(null,context())).code,'INVALID_FIELDS');
  assert.equal(register(3,{surprise:1}).code,'INVALID_FIELDS');
  assert.equal(register(3,{owner_id:''}).code,'INVALID_FIELDS');
  assert.equal(register(3,{registered_at_ms:T0+1}).ok,true,'a real clock reading need not be minute aligned');
  assert.equal(register(3,{registered_at_ms:'x'}).code,'INVALID_FIELDS');
  assert.equal(register(3,{universe:[{get kind(){throw new Error('boom');}}]}).code,'INVALID_FIELDS');
  assert.equal(register(3,{},{universe_cap:undefined}).code,'INVALID_FIELDS');
  assert.equal(register(3,{},{universe_cap:2}).code,'QR4_UNIVERSE_TOO_LARGE');
  assert.equal(register(3,{ranking_basis:'DEVELOPMENT_SCORE'}).code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
  assert.equal(register(3,{ranking_basis:'OWN_HOLDOUT'}).code,'QR4_OWN_HOLDOUT_NOT_COMPARABLE');
  assert.equal(register(3,{ranking_basis:'SOMETHING'}).code,'INVALID_FIELDS');
  assert.equal(register(3,{ranking_basis:'QR4_SELECTION_EVAL'}).ok,true);
});
test('registration: scope fields are validated',()=>{
  const scoped=(patch)=>register(3,{scope:{...clone(SCOPE),...patch}});
  assert.equal(scoped({market:{...MARKET,symbol:'ETHUSDT'}}).code,'BI_MARKET_SCOPE_INVALID');
  assert.equal(scoped({market:{...MARKET,timeframe:'5'}}).code,'BI_MARKET_SCOPE_INVALID');
  assert.equal(scoped({cost_model:{...SCOPE.cost_model,version:'paper-close-v2'}}).code,'QR4_SCOPE_INCOMPATIBLE');
  assert.equal(scoped({valuation:{valuation:'other',benchmark:SCOPE.valuation.benchmark}}).code,'QR4_QR3_CONTEXT_UNAVAILABLE');
  assert.equal(scoped({engine:'x'}).code,'QR4_SCOPE_INCOMPATIBLE');
  assert.equal(scoped({capital:{equity:10000,cash:'1'}}).code,'QR4_SCOPE_INCOMPATIBLE');
  assert.equal(scoped({extra:1}).code,'INVALID_FIELDS');
  assert.equal(scoped({policy:{policy_version:'risk-v1',policy_hash:'zz'}}).code,'QR4_SCOPE_INCOMPATIBLE');
  // A participant whose policy snapshot differs is excluded (E5), and the selection then lacks participants.
  const out=register(3,{},{},k=>k===3?{scope:{...member(3).scope,policy:{policy_version:'risk-v2',policy_hash:sha('p2')}}}:{});
  assert.equal(out.ok,true,'two participants remain');
  const dropped=out.registration.universe.find(item=>item.run_id==='run-3');
  assert.deepEqual([dropped.status,dropped.code,dropped.mismatched_fields],['EXCLUDED','QR4_SCOPE_INCOMPATIBLE',['policy']]);
  assert.equal(out.registration.participant_count,2);
});
test('registration: participant count and basis rules (section 4.3 and 9)',()=>{
  assert.equal(register(1).code,'QR4_TOO_FEW_PARTICIPANTS');
  assert.equal(register(5).code,'QR4_TOO_MANY_PARTICIPANTS');
  assert.equal(register(4).ok,true);
  assert.equal(register(2).ok,true);
  const dup=request(members(3));dup.universe[1]=member(2,{export_id:'exp-1'});
  assert.equal(note(buildRegistration(dup,context())).code,'QR4_DUPLICATE_PARTICIPANT');
  const mixed=request([...members(3),member(9,{kind:'ACTUAL_HISTORY'})]);
  assert.equal(note(buildRegistration(mixed,context())).code,'QR4_MIXED_BASIS');
  const onlyActual=request([member(8,{kind:'ACTUAL_HISTORY'}),member(9,{kind:'ACTUAL_HISTORY'})]);
  assert.equal(note(buildRegistration(onlyActual,context())).code,'QR4_ACTUAL_HISTORY_NOT_RANKABLE');
  // A STALE or development-only member is shown in the universe with its code and never becomes a participant.
  const out=register(4,{},{},k=>k===4?{run_status:'FAILED'}:{});
  assert.equal(out.ok,true);
  assert.equal(out.registration.participant_count,3);
  assert.equal(out.registration.universe.find(item=>item.run_id==='run-4').code,'QR4_PARTICIPANT_NOT_QUALIFIED');
});
test('registered thresholds win; a filter weaker than a participant rule is refused (test 15)',()=>{
  assert.equal(register(3,{filters:{...FILTERS,drawdown_limit_percent:'25.000001'}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{...FILTERS,drawdown_limit_percent:'25'}}).ok,true);
  assert.equal(register(3,{filters:{...FILTERS,drawdown_limit_percent:'100.1'}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{...FILTERS,episode_floor:4}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{...FILTERS,episode_floor:5.5}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{...FILTERS,drawdown_limit_percent:20}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{...FILTERS,beats_buy_and_hold:'yes'}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{episode_floor:5}}).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{filters:{...FILTERS,extra:1}}).code,'QR4_FILTER_INVALID');
  // M6: the scope policy drawdown limit is read from the policy snapshot of the server, never from a request key.
  assert.equal(register(3,{scope:{...clone(SCOPE),policy_max_drawdown_percent:'15'}}).code,'INVALID_FIELDS');
  const snapshot=value=>({policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:value}});
  const weaker=register(3,{},snapshot('15'));
  assert.deepEqual([weaker.code,weaker.detail],['QR4_FILTER_INVALID','FILTER_DRAWDOWN_LIMIT_WEAKER_THAN_POLICY']);
  assert.equal(register(3,{},snapshot('20')).ok,true,'equal to the policy limit passes');
  assert.equal(register(3,{},snapshot('19.999999')).code,'QR4_FILTER_INVALID');
  assert.equal(register(3,{},snapshot('30')).ok,true);
  assert.equal(regOf(3,{},snapshot('30')).scope.policy_max_drawdown_percent,'30');
  assert.equal(register(3,{},snapshot(null)).ok,true,'a policy that defines no limit adds none');
  for(const bad of [undefined,null,'x',{},{policy_hash:POLICY},{policy_hash:sha('other-policy'),max_drawdown_percent:null},{policy_hash:POLICY,max_drawdown_percent:15},
    {policy_hash:POLICY,max_drawdown_percent:'abc'},{policy_hash:POLICY,max_drawdown_percent:'-1'}]){
    const out=register(3,{},{policy_snapshot:bad});
    assert.deepEqual([out.code,out.detail],['QR4_FILTER_INVALID','POLICY_SNAPSHOT_UNREADABLE'],JSON.stringify(bad));
  }
  const unreadableRules=register(3,{},{},()=>({rules:{},rules_hash:sha(ref({}))}));
  assert.equal(unreadableRules.code,'QR4_FILTER_INVALID');
  // The ranking judges by the registration's own copy: the same evaluations pass a loose limit and fail a tight one.
  const loose=regOf(2,{filters:{...FILTERS,drawdown_limit_percent:'20'}}),tight=regOf(2,{filters:{...FILTERS,drawdown_limit_percent:'4'}});
  const values=[{net:'3',dd:'8'},{net:'2',dd:'3'}];
  assert.deepEqual(rank(loose,values).ranking.map(item=>item.export_id),['exp-1','exp-2']);
  assert.deepEqual(rank(tight,values).ranking.map(item=>item.export_id),['exp-2']);
  assert.equal(rank(tight,values).outcome,'BEST_IN_SCOPE');
  assert.equal(rank(tight,values).passed_note,'1 of 2 participants passed the filters');
});
test('mixed frozen rules hashes give QR4_RULES_VERSION_MIXED (test 16)',()=>{
  const otherRules={maximum_drawdown_percent:'24',minimum_closed_trades_test:10};
  const out=register(3,{},{},k=>k===2?{rules:otherRules,rules_hash:sha(ref(otherRules))}:{});
  assert.equal(out.code,'QR4_RULES_VERSION_MIXED');
  assert.equal(out.detail,null);
  assert.equal(register(3,{},{},k=>k===2?{rules_hash:'nothex'}:{}).code,'QR4_RULES_VERSION_MIXED');
  // The same new rules for every participant, with the matching hash, are uniform.
  assert.equal(register(3,{},{},()=>({rules:otherRules,rules_hash:sha(ref(otherRules))})).ok,true);
  // L12: one hash for all, but not the hash of the rules object that the "not weaker" check reads.
  const forged=register(3,{},{},()=>({rules:otherRules}));
  assert.deepEqual([forged.code,forged.detail],['QR4_RULES_VERSION_MIXED','RULES_HASH_MISMATCH']);
  assert.equal(digest(RULES_OBJECT),RULES);
});
test('adversarial input: weights, sort and rank fields are refused before any evaluation (test 18)',()=>{
  for(const key of ['weights','sort','rank','sort_by','order_by','score','formula']){
    assert.equal(register(3,{[key]:1}).code,'QR4_CUSTOM_WEIGHTS_REFUSED',key);
    assert.equal(register(3,{objective:{...OBJECTIVE,[key]:{a:1}}}).code,'QR4_CUSTOM_WEIGHTS_REFUSED',key);
    assert.equal(register(3,{filters:{...FILTERS,[key]:'x'}}).code,'QR4_CUSTOM_WEIGHTS_REFUSED',key);
  }
  assert.equal(register(3,{objective:{...OBJECTIVE,id:'qr4-objective-custom'}}).code,'QR4_OBJECTIVE_UNKNOWN');
  assert.equal(register(3,{objective:{...OBJECTIVE,id:'__proto__'}}).code,'QR4_OBJECTIVE_UNKNOWN');
  assert.equal(register(3,{objective:{...OBJECTIVE,id:undefined}}).code,'QR4_OBJECTIVE_UNKNOWN');
  assert.equal(register(3,{objective:{...OBJECTIVE,extra:1}}).code,'INVALID_FIELDS');
  // H1 and OD-S3: a tie tolerance is a registry constant. A tolerance key in the request is INVALID_FIELDS, even with a valid value.
  assert.equal(register(3,{objective:{id:OBJECTIVE.id}}).ok,true);
  for(const key of ['tie_tolerance_return_pp','tie_tolerance_drawdown_pp'])for(const value of ['0.5','0','-0.1','abc',0.5,null]){
    const out=register(3,{objective:{...OBJECTIVE,[key]:value}});
    assert.deepEqual([out.code,out.detail],['INVALID_FIELDS','OBJECTIVE_KEYS'],key+' '+String(value));
  }
  assert.equal(register(3,{objective:{...OBJECTIVE,tie_tolerances:{return_pp:'0',drawdown_pp:'0'}}}).code,'INVALID_FIELDS');
  assert.equal(validateObjective(null,null).code,'INVALID_FIELDS');
  assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry:TEST_REGISTRY}).ok,true);
  assert.equal(validateObjective({...OBJECTIVE,tie_tolerance_return_pp:'0.5'},{...FILTERS},{registry:TEST_REGISTRY}).code,'INVALID_FIELDS');
});
test('registration change requests are refused (QR4_REGISTRATION_IMMUTABLE)',()=>{
  assert.equal(note(refuseRegistrationChange()).code,'QR4_REGISTRATION_IMMUTABLE');
});

// ---- window checks (tests 17, 17a) ----
test('window checks: each failure gives its own code (test 17)',()=>{
  const withWindow=(over,ctx={},fix=null)=>register(3,{window:{...W,...over},admission_deadline_ms:W.start_ms+30000*MS},ctx,fix);
  assert.equal(withWindow({}).ok,true);
  const train=withWindow({}, {}, k=>k===1?{data_windows:{...member(1).data_windows,train:{start_ms:W.start_ms+10*MS,end_ms:W.start_ms+20*MS}}}:{});
  assert.deepEqual([train.code,train.detail],['QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA','train:exp-1']);
  for(const name of ['validation','holdout','dataset']){
    const out=withWindow({},{},k=>k===2?{data_windows:{...member(2).data_windows,[name]:{start_ms:W.end_ms-5*MS,end_ms:W.end_ms+5*MS}}}:{});
    assert.deepEqual([out.code,out.detail],['QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA',name+':exp-2']);
  }
  const evidence=withWindow({},{},k=>k===3?{data_windows:{...member(3).data_windows,evidence:[{start_ms:W.start_ms,end_ms:W.start_ms+MS}]}}:{});
  assert.equal(evidence.code,'QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA');
  assert.equal(withWindow({},{},k=>k===1?{data_windows:{dataset:range(40,10)}}:{}).code,'QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA');
  // Windows that only touch do not overlap (half-open).
  assert.equal(withWindow({},{},k=>k===1?{data_windows:{...member(1).data_windows,train:{start_ms:W.start_ms-10*MS,end_ms:W.start_ms}}}:{}).ok,true);
  // Warm-up bars may overlap: this train window lies wholly inside the warm-up before W.
  const warm=withWindow({},{},k=>k===1?{data_windows:{...member(1).data_windows,train:{start_ms:W.start_ms-100*MS,end_ms:W.start_ms-50*MS}}}:{});
  assert.equal(warm.ok,true);
  const entry=(over={})=>({owner_id:OWNER,source_hash:sha('src1'),run_id:'run-other',kind:'RESEARCH_RUN',window:{start_ms:W.start_ms+5*MS,end_ms:W.start_ms+9*MS},...over});
  const searched=withWindow({},{searched_windows:[entry()]});
  assert.deepEqual([searched.code,searched.detail],['QR4_WINDOW_OVERLAPS_SEARCHED_DATA','run-other']);
  assert.equal(withWindow({},{searched_windows:[entry({source_hash:sha('unrelated')})]}).ok,true);
  assert.equal(withWindow({},{searched_windows:[entry({owner_id:'owner-b'})]}).ok,true);
  assert.equal(withWindow({},{searched_windows:[entry({kind:'EVALUATION_RUN'})]}).ok,true);
  // An unreadable searched list is not an observed overlap: it is refused like an unreadable register, without an overlap code.
  for(const unreadable of ['unreadable',undefined,null,[{kind:'RESEARCH_RUN'}],[{...entry(),window:{start_ms:1}}]]){
    const out=withWindow({},{searched_windows:unreadable});
    assert.deepEqual([out.code,out.detail],['QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE'],JSON.stringify(unreadable));
  }
  const exposure=(over={})=>({owner_id:OWNER,market_key:MARKET_KEY,window:{start_ms:W.start_ms+MS,end_ms:W.start_ms+2*MS},comparison_id:'cmp-1',kind:'QR3_COMPARISON',at_ms:T0-DAY,...over});
  const exposed=withWindow({},{exposure_register:[exposure()]});
  assert.deepEqual([exposed.code,exposed.detail],['QR4_WINDOW_EXPOSED','cmp-1']);
  assert.equal(withWindow({},{exposure_register:[{...exposure(),comparison_id:undefined,selection_id:'sel-9',kind:'QR4_SELECTION'}]}).code,'QR4_WINDOW_EXPOSED');
  assert.equal(withWindow({},{exposure_register:[exposure({owner_id:'owner-b'})]}).ok,true);
  assert.equal(withWindow({},{exposure_register:[exposure({market_key:ref({...MARKET,symbol:'ETHUSDT'})})]}).ok,true);
  assert.equal(withWindow({},{exposure_register:[exposure({window:{start_ms:W.end_ms,end_ms:W.end_ms+MS}})]}).ok,true);
  assert.equal(withWindow({},{exposure_register:[]}).ok,true);
  assert.equal(withWindow({},{exposure_register:null}).code,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE');
  assert.equal(withWindow({},{exposure_register:undefined}).code,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE');
  assert.equal(withWindow({},{exposure_register:[{owner_id:OWNER}]}).code,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE');
  const before=withWindow({},{},k=>k===2?{registered_boundary_ms:W.start_ms+MS}:{});
  assert.equal(before.code,'QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY');
  assert.equal(withWindow({},{},k=>k===2?{registered_boundary_ms:W.start_ms}:{}).ok,true);
  assert.equal(withWindow({},{},k=>k===2?{registered_boundary_ms:undefined}:{}).code,'QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY');
  assert.equal(withWindow({end_ms:W.start_ms+9801*MS}).code,'QR4_WINDOW_OVER_CAPACITY');
  assert.equal(withWindow({end_ms:W.start_ms+9800*MS}).ok,true);
  assert.equal(withWindow({warmup_bars:9001}).code,'QR4_WINDOW_OVER_CAPACITY');
  assert.equal(register(3,{window:{...W,end_ms:W.start_ms+10001*MS,warmup_bars:0}}).code,'QR4_WINDOW_OVER_CAPACITY');
  assert.equal(register(3,{window:{...W}},{capacity_bars:1199}).code,'QR4_WINDOW_OVER_CAPACITY');
  for(const over of [{start_ms:W.start_ms+1},{end_ms:W.end_ms+1},{end_ms:W.start_ms},{end_ms:W.start_ms-MS},{warmup_bars:-1},{warmup_bars:1.5},{kind:'ANY_PAST'},{kind:undefined}])
    assert.equal(withWindow(over).code,'QR4_WINDOW_INVALID',JSON.stringify(over));
  assert.equal(register(3,{window:{start_ms:W.start_ms,end_ms:W.end_ms,warmup_bars:200}}).code,'QR4_WINDOW_INVALID');
  assert.equal(register(3,{window:null}).code,'QR4_WINDOW_INVALID');
  // PROSPECTIVE must start after the registration time.
  assert.equal(register(3,{window:{...W,start_ms:T0,end_ms:T0+500*MS}}).code,'QR4_WINDOW_INVALID');
  // FORWARD_PAST: a completed window at or after the latest participant dataset end.
  const past={kind:'FORWARD_PAST',start_ms:T0-9*DAY,end_ms:T0-9*DAY+500*MS,warmup_bars:100};
  assert.equal(register(3,{window:past}).ok,true);
  assert.equal(register(3,{window:{...past,start_ms:T0-10*DAY,end_ms:T0-10*DAY+500*MS}}).ok,true);
  assert.equal(register(3,{window:{...past,start_ms:T0-10*DAY-MS,end_ms:T0-10*DAY+499*MS}}).code,'QR4_WINDOW_INVALID');
  assert.equal(register(3,{window:{...past,start_ms:T0-100*MS,end_ms:T0+MS}}).code,'QR4_WINDOW_INVALID');
  assert.equal(register(3,{window:{...past,start_ms:T0-100*MS,end_ms:T0}}).ok,true);
});
test('window validation: bar counts are exact and the view shows evaluation plus warm-up equals total',()=>{
  const ok=validateWindow({...W},{registered_at_ms:T0});
  assert.deepEqual([ok.window.evaluation_bars,ok.window.warmup_bars,ok.window.total_bars],[1000,200,1200]);
  assert.equal(validateWindow({...W},{registered_at_ms:T0,capacity_bars:0}).code,'QR4_WINDOW_INVALID');
  assert.equal(validateWindow({...W},{registered_at_ms:T0+1}).ok,true);
  assert.equal(validateWindow({...W},{registered_at_ms:'x'}).code,'QR4_WINDOW_INVALID');
  assert.equal(validateWindow({...W,extra:1},{registered_at_ms:T0}).code,'QR4_WINDOW_INVALID');
});
test('window race: the recheck ends the selection before any ranking (test 17a)',()=>{
  const reg=regOf(3);
  const exposure=(over={})=>({owner_id:OWNER,market_key:MARKET_KEY,window:{start_ms:reg.window.start_ms+MS,end_ms:reg.window.start_ms+2*MS},comparison_id:'cmp-late',kind:'QR3_COMPARISON',at_ms:T0+1,...over});
  const research=(over={})=>({owner_id:OWNER,source_hash:sha('src2'),run_id:'run-late',kind:'RESEARCH_RUN',window:{start_ms:reg.window.start_ms,end_ms:reg.window.start_ms+MS},...over});
  for(const stage of ['EVALUATION_START','OUTCOME_WRITE']){
    assert.deepEqual(note(recheckWindow({registration:reg,exposure_register:[],searched_windows:[],stage})).ok,true);
    const qr3=note(recheckWindow({registration:reg,exposure_register:[exposure()],searched_windows:[],stage}));
    assert.deepEqual([qr3.ok,qr3.ends_selection,qr3.status,qr3.code,qr3.ranking,qr3.stage],[false,true,'SELECTION_INCOMPLETE','QR4_WINDOW_EXPOSED',false,stage]);
    const qr4=note(recheckWindow({registration:reg,exposure_register:[exposure({comparison_id:undefined,selection_id:'sel-other',kind:'QR4_SELECTION'})],searched_windows:[],stage}));
    assert.equal(qr4.code,'QR4_WINDOW_EXPOSED');
    const searched=note(recheckWindow({registration:reg,exposure_register:[],searched_windows:[research()],stage}));
    assert.deepEqual([searched.ok,searched.ends_selection,searched.code,searched.status],[false,true,'QR4_WINDOW_OVERLAPS_SEARCHED_DATA','SELECTION_INCOMPLETE']);
    // The selection's own exposure record and its own evaluation runs never fail its recheck.
    const own=recheckWindow({registration:reg,exposure_register:[exposure({comparison_id:undefined,selection_id:reg.selection_id,kind:'QR4_SELECTION'})],
      searched_windows:[research({kind:'EVALUATION_RUN',run_id:'ev-1',source_hash:sha('src1')})],stage});
    assert.equal(own.ok,true);
    assert.equal(own.ranking,true);
    // An unreadable register or an unreadable searched list blocks the guarded step and never ends the selection (it is retried).
    for(const unreadable of [null,'x',undefined,[{kind:'RESEARCH_RUN'}]]){
      const blockedSearched=note(recheckWindow({registration:reg,exposure_register:[],searched_windows:unreadable,stage}));
      assert.deepEqual([blockedSearched.ok,blockedSearched.ends_selection,blockedSearched.code,blockedSearched.status,blockedSearched.detail,blockedSearched.ranking],
        [false,false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE',null,'SEARCHED_WINDOWS_UNREADABLE',false],JSON.stringify(unreadable));
    }
    const blocked=note(recheckWindow({registration:reg,exposure_register:null,searched_windows:[],stage}));
    assert.deepEqual([blocked.ok,blocked.ends_selection,blocked.code,blocked.status,blocked.detail],[false,false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE',null,'REGISTRY_UNREADABLE']);
    // An observed overlap still ends the selection when the other source is unreadable only after the exposure judgement.
    const both=recheckWindow({registration:reg,exposure_register:[exposure()],searched_windows:null,stage});
    assert.deepEqual([both.code,both.ends_selection],['QR4_WINDOW_EXPOSED',true]);
    // Exposure is judged first when both apply.
    assert.equal(recheckWindow({registration:reg,exposure_register:[exposure()],searched_windows:[research()],stage}).code,'QR4_WINDOW_EXPOSED');
  }
  assert.equal(recheckWindow({registration:reg,exposure_register:[],searched_windows:[],stage:'LATER'}).ok,false);
  const unreadableRegistration=recheckWindow({registration:{},exposure_register:[],searched_windows:[],stage:'OUTCOME_WRITE'});
  assert.deepEqual([unreadableRegistration.code,unreadableRegistration.detail,unreadableRegistration.ends_selection],['INTEGRITY_CHECK_FAILED','REGISTRATION_UNREADABLE',false]);
  assert.equal(recheckWindow().ok,false);
});

// ---- lifecycle, labels, guards ----
test('transitions: exactly the diagram of section 8.1 is legal (test plan 16.2 item 2, pure part)',()=>{
  const statuses=[null,'SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED'];
  const events=['REGISTER','FIRST_EVALUATION_START','OWNER_CANCEL','PARTICIPANT_INELIGIBLE','WINDOW_RECHECK_FAILED','ALL_EVALUATIONS_DONE','DEADLINE_PASSED','WINDOW_DATA_UNAVAILABLE','OTHER'];
  // Nine rows are the diagram of 8.1. The last three are the M2 rows: sections 4.3, 5.4 and 10 require these endings and root adds them to 8.1.
  const legal=new Set(['null|REGISTER','SELECTION_REGISTERED|FIRST_EVALUATION_START','SELECTION_REGISTERED|OWNER_CANCEL','SELECTION_REGISTERED|PARTICIPANT_INELIGIBLE',
    'SELECTION_REGISTERED|WINDOW_RECHECK_FAILED','SELECTION_EVALUATING|ALL_EVALUATIONS_DONE','SELECTION_EVALUATING|OWNER_CANCEL','SELECTION_EVALUATING|DEADLINE_PASSED',
    'SELECTION_EVALUATING|WINDOW_RECHECK_FAILED',
    'SELECTION_EVALUATING|PARTICIPANT_INELIGIBLE','SELECTION_REGISTERED|DEADLINE_PASSED','SELECTION_REGISTERED|WINDOW_DATA_UNAVAILABLE']);
  assert.equal(TRANSITIONS.length,legal.size);
  const good={REGISTER:{},FIRST_EVALUATION_START:{},OWNER_CANCEL:{},PARTICIPANT_INELIGIBLE:{code:'QR4_PARTICIPANT_STALE'},WINDOW_RECHECK_FAILED:{code:'QR4_WINDOW_EXPOSED'},
    ALL_EVALUATIONS_DONE:{to:'SELECTION_COMPLETED',outcome:'BEST_IN_SCOPE'},DEADLINE_PASSED:{code:'QR4_ADMISSION_REFUSED'},WINDOW_DATA_UNAVAILABLE:{code:'QR4_WINDOW_DATA_UNAVAILABLE'},OTHER:{}};
  for(const from of statuses)for(const kind of events){
    const out=note(transitionSelection(from,{kind,...good[kind]}));
    if(legal.has(from+'|'+kind))assert.equal(out.ok,true,from+'|'+kind);
    else assert.deepEqual([out.ok,out.code],[false,'QR4_TRANSITION_INVALID'],from+'|'+kind);
  }
  assert.equal(transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_INCOMPLETE',code:'QR4_METRIC_MISSING'}).ok,true);
  assert.equal(transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_CANCELLED'}).code,'QR4_TRANSITION_INVALID');
  assert.equal(transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_COMPLETED'}).code,'QR4_TRANSITION_INVALID');
  assert.equal(transitionSelection('SELECTION_REGISTERED',{kind:'WINDOW_RECHECK_FAILED',code:'QR4_METRIC_MISSING'}).code,'QR4_TRANSITION_INVALID');
  assert.equal(transitionSelection('SELECTION_EVALUATING',{kind:'DEADLINE_PASSED',code:'QR4_WINDOW_EXPOSED'}).code,'QR4_TRANSITION_INVALID');
  // M2: the three endings that sections 4.3, 5.4 and 10 require, each with its own code and no other.
  const ended=(from,kind,code)=>transitionSelection(from,{kind,code});
  assert.deepEqual([ended('SELECTION_EVALUATING','PARTICIPANT_INELIGIBLE','QR4_PARTICIPANT_STALE').to,ended('SELECTION_EVALUATING','PARTICIPANT_INELIGIBLE','QR4_PARTICIPANT_STALE').code],['SELECTION_INCOMPLETE','QR4_PARTICIPANT_STALE']);
  assert.deepEqual([ended('SELECTION_REGISTERED','DEADLINE_PASSED','QR4_ADMISSION_REFUSED').to,ended('SELECTION_REGISTERED','WINDOW_DATA_UNAVAILABLE','QR4_WINDOW_DATA_UNAVAILABLE').to],['SELECTION_INCOMPLETE','SELECTION_INCOMPLETE']);
  // Mutation survivor 31: a participant-ineligible ending from REGISTERED or EVALUATING allows QR4_PARTICIPANT_STALE only.
  for(const from of ['SELECTION_REGISTERED','SELECTION_EVALUATING'])for(const code of ['QR4_WINDOW_EXPOSED','QR4_METRIC_MISSING','QR4_ADMISSION_REFUSED','',undefined,null]){
    const out=ended(from,'PARTICIPANT_INELIGIBLE',code);
    assert.deepEqual([out.ok,out.code,out.detail],[false,'QR4_TRANSITION_INVALID','CODE_NOT_ALLOWED'],from+' '+String(code));
  }
  for(const [from,kind,code] of [['SELECTION_REGISTERED','DEADLINE_PASSED','QR4_EVALUATION_FAILED'],['SELECTION_REGISTERED','DEADLINE_PASSED','QR4_WINDOW_EXPOSED'],
    ['SELECTION_REGISTERED','WINDOW_DATA_UNAVAILABLE','QR4_WINDOW_DATA_GAP'],['SELECTION_REGISTERED','WINDOW_DATA_UNAVAILABLE',undefined],['SELECTION_EVALUATING','WINDOW_DATA_UNAVAILABLE','QR4_WINDOW_DATA_UNAVAILABLE'],
    ['SELECTION_COMPLETED','PARTICIPANT_INELIGIBLE','QR4_PARTICIPANT_STALE'],['SELECTION_CANCELLED','DEADLINE_PASSED','QR4_ADMISSION_REFUSED']])
    assert.equal(ended(from,kind,code).code,'QR4_TRANSITION_INVALID',from+' '+kind+' '+String(code));
  assert.equal(transitionSelection('NOPE',{kind:'REGISTER'}).code,'QR4_TRANSITION_INVALID');
  assert.equal(transitionSelection(null,null).code,'QR4_TRANSITION_INVALID');
  assert.equal(checkCancel('SELECTION_EVALUATING',false).code,'CONFIRMATION_REQUIRED');
  assert.equal(note(checkCancel('SELECTION_COMPLETED',true)).code,'QR4_TRANSITION_INVALID');
  assert.equal(checkCancel('SELECTION_REGISTERED',true).to,'SELECTION_CANCELLED');
  assert.deepEqual(['SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_INCOMPLETE','SELECTION_CANCELLED','SELECTION_COMPLETED'].map(metricsVisible),[false,false,false,false,true]);
});
test('labels: a label exists only on a completed best or tied outcome, never on a fixture selection, with its fixed sentences',()=>{
  const reg=regOf(3);
  const best=rank(reg,[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}]);
  assert.equal(best.label.exposure_sentence,'This selection used the period W. That period is now development evidence. A claim about another period needs new independent data.');
  assert.equal(best.label.no_significance_sentence,'No statistical significance is claimed.');
  assert.equal(best.label.no_profitability_sentence,'This is not a profitability claim or a forecast.');
  const scope=best.label.scope_statement;
  assert.equal(scope.asset,'binance-global:BTCUSDT 1m');
  assert.deepEqual([scope.window.evaluation_bars,scope.window.warmup_bars,scope.window.total_bars],[1000,200,1200]);
  assert.equal(scope.window.start_utc,new Date(W.start_ms).toISOString());
  assert.equal(scope.objective_id,'qr4-objective-lexi-v1');
  assert.equal(scope.participant_count,3);
  assert.equal(scope.universe.length,3);
  assert.equal(scope.prior_selection_count,0);
  assert.equal(scope.risk_profile,'risk-v1');
  // Coverage (11.2 item 4): the compared participants, the universe size and the evaluation bars of each evaluation.
  assert.deepEqual(scope.coverage,{participants_compared:3,universe_runs:3,evaluation_bars_each:1000});
  assert.equal(scopeStatement(null).coverage.participants_compared,null);
  const fixture=regOf(3,{fixture:true},{},fixtureOver);
  const fixtureOut=rank(fixture,[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}]);
  assert.equal(fixtureOut.outcome,'BEST_IN_SCOPE');
  assert.equal(fixtureOut.label,null);
  assert.equal(fixtureOut.fixture,true);
  const done='SELECTION_COMPLETED';
  assert.equal(buildLabel(reg,{status:done,outcome:'NO_QUALIFYING_STRATEGY',ranking:[],participant_count:3}),null);
  assert.equal(buildLabel(reg,{status:done,outcome:'BEST_IN_SCOPE',ranking:[{rank:1,export_id:'a'},{rank:1,export_id:'b'}],participant_count:3}),null);
  assert.equal(buildLabel(null,null),null);
  // Mutation survivor 34: a tied outcome needs at least two rank 1 entries when the builder is called directly.
  assert.equal(buildLabel(reg,{status:done,outcome:'TIED_IN_SCOPE',ranking:[{rank:1,export_id:'a'},{rank:2,export_id:'b'}],participant_count:3}),null);
  assert.equal(buildLabel(reg,{status:done,outcome:'TIED_IN_SCOPE',ranking:[{rank:2,export_id:'b'}],participant_count:3}),null);
  const tiedLabel=buildLabel(reg,{status:done,outcome:'TIED_IN_SCOPE',ranking:[{rank:1,export_id:'a'},{rank:1,export_id:'b'},{rank:2,export_id:'c'}],participant_count:3});
  assert.deepEqual([tiedLabel.label_text,tiedLabel.participants],['Tied for best of 3 compared strategies within the selected scope',['a','b']]);
  const bestLabel=buildLabel(reg,{status:done,outcome:'BEST_IN_SCOPE',ranking:[{rank:1,export_id:'a'},{rank:2,export_id:'b'}],participant_count:3});
  assert.equal(bestLabel.label_text,'Best of 3 compared strategies within the selected scope');
  // L7: only the body of a completed outcome gets a label. A body without that status, or with another one, never does.
  for(const status of [undefined,'SELECTION_INCOMPLETE','SELECTION_EVALUATING','SELECTION_REGISTERED','SELECTION_CANCELLED'])
    assert.equal(buildLabel(reg,{status,outcome:'BEST_IN_SCOPE',ranking:[{rank:1,export_id:'a'}],participant_count:3}),null,String(status));
  assert.equal(buildLabel(fixture,{status:done,outcome:'BEST_IN_SCOPE',ranking:[{rank:1,export_id:'a'}],participant_count:3}),null);
  // The sentence "no statistical significance is claimed" travels with every non-empty ranking, with a label or without one.
  assert.equal(best.no_significance_sentence,'No statistical significance is claimed.');
  assert.equal(fixtureOut.no_significance_sentence,'No statistical significance is claimed.');
  assert.equal(rank(reg,[{net:'2',dd:'4'},{net:'2',dd:'4'},{net:'-1'}]).no_significance_sentence,'No statistical significance is claimed.');
  assert.equal(rank(reg,[{net:'-1'},{net:'-2'},{net:'-3'}]).no_significance_sentence,null);
  assert.equal(rank(reg,[{episodes:1},{episodes:2},{episodes:3}]).no_significance_sentence,null);
  // The word "best" or "tied" appears only inside the scoped label text.
  const none=rank(reg,[{net:'-1'},{net:'-2'},{net:'-3'}]);
  assert.doesNotMatch(none.text,/best|top|winner|optimal/i);
  assert.equal(none.no_winner_text,'Qualified recommendations: none. No qualified winner.');
  assert.equal(best.text,null);
  assert.equal(best.no_winner_text,null);
});
test('overlays: WINNER_NOT_READY and SELECTION_REPLAY_MISMATCH suppress the label; RULESET_SUPERSEDED is information only',()=>{
  const reg=regOf(3);
  const best=rank(reg,[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}]);
  const facts=(over={})=>({packages_ready:{'exp-1':true,'exp-2':true,'exp-3':true},replay_mismatch:false,current_versions:{objective:'qr4-objective-lexi-v1',scope:'qr4-scope-v1'},...over});
  let view=deriveOverlays(reg,best,facts());
  assert.deepEqual([view.overlays,view.label_visible,view.hide_recommended_values,view.hide_package_links],[[],true,false,false]);
  view=deriveOverlays(reg,best,facts({packages_ready:{'exp-1':false,'exp-2':true,'exp-3':true}}));
  assert.deepEqual([view.overlays,view.label_visible,view.hide_recommended_values,view.hide_package_links],[['WINNER_NOT_READY'],false,true,true]);
  assert.deepEqual(deriveOverlays(reg,best,facts({packages_ready:{}})).overlays,['WINNER_NOT_READY']);
  view=deriveOverlays(reg,best,facts({replay_mismatch:true}));
  assert.deepEqual([view.overlays,view.label_visible],[['SELECTION_REPLAY_MISMATCH'],false]);
  assert.deepEqual(deriveOverlays(reg,best,facts({replay_mismatch:undefined})).overlays,['SELECTION_REPLAY_MISMATCH']);
  view=deriveOverlays(reg,best,facts({current_versions:{objective:'qr4-objective-lexi-v2',scope:'qr4-scope-v1'}}));
  assert.deepEqual([view.overlays,view.label_visible],[['RULESET_SUPERSEDED'],true]);
  assert.deepEqual(deriveOverlays(reg,best,undefined).overlays.includes('WINNER_NOT_READY'),true);
});
test('outcome replay: an equal outcome_hash writes no event; a tampered result hash writes one and suppresses the label',()=>{
  const reg=regOf(3);
  const list=evaluations(reg,[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}]);
  const stored=rankSelection(reg,list).outcome_hash;
  const same=replayOutcome(reg,list,stored);
  assert.deepEqual([same.match,same.event],[true,null]);
  const tampered=clone(list);tampered[1].result_hash=sha('tampered');
  const mismatch=replayOutcome(reg,tampered,stored);
  assert.equal(mismatch.match,false);
  assert.deepEqual(mismatch.event,{kind:'SELECTION_REPLAY_MISMATCH',stored_outcome_hash:stored,recomputed_outcome_hash:null,label_suppressed:true});
  const changed=clone(list);changed[0].result.metrics.net_return_percent='0.5';rehash(changed[0]);
  const different=replayOutcome(reg,changed,stored);
  assert.equal(different.match,false);
  assert.equal(different.event.label_suppressed,true);
  assert.equal(replayOutcome(reg,list,'not-a-hash').event.stored_outcome_hash,null);
});
test('development view and route guards (sections 3.3, 5.4 and 12.2)',()=>{
  for(const key of ['sort','order_by','rank','top','best','SORT'])assert.equal(note(checkDevelopmentViewRequest({[key]:'score'})).code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
  // D1 matches words in the name: sort_by, order, ranking, camelCase and kebab-case names are refused too.
  for(const key of ['sort_by','sortBy','order','orderBy','ordering','ranking','ranked','top_n','topN','best-score','Winner','sort.direction','sorted'])
    assert.equal(checkDevelopmentViewRequest({[key]:1}).code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE',key);
  for(const key of ['limit','offset','page_size','include_gates'])
    assert.equal(checkDevelopmentViewRequest({[key]:1}),null,key);
  // Round 2 (D1 allow-list): every key off the allow-list is refused, joined and digit-suffixed forms included, and a mixed query is refused.
  for(const key of ['sortby','rankby','top10','best3','leader','Leader','sort2','winnerid','stop_loss','desktop','ordinal','border','Limit','limit ','unknown'])
    assert.equal(checkDevelopmentViewRequest({[key]:1}).code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE',key);
  assert.equal(checkDevelopmentViewRequest({limit:5,top10:1}).code,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
  assert.equal(checkDevelopmentViewRequest({limit:5,offset:0,page_size:10,include_gates:true}),null);
  assert.equal(checkDevelopmentViewRequest({}),null);
  assert.deepEqual(keyTokens('sortBy-topN.rank_2'),['sort','by','top','n','rank']);
  assert.deepEqual(keyTokens('top10'),['top']);
  assert.deepEqual(keyTokens('best3x_Leader'),['best','x','leader']);
  assert.equal(checkDevelopmentViewRequest({limit:5}),null);
  assert.equal(checkDevelopmentViewRequest(undefined),null);
  assert.deepEqual(developmentRowViolations({run_id:'r',development_score:{value:'1',kind:'DEVELOPMENT_ONLY'},qualified_winner:null}),[]);
  // D2 matches words, not substrings: stop_loss and desktop are ordinary names; rank, best, top and winner words are not.
  assert.deepEqual(developmentRowViolations({stop_loss:'1',desktop:true,take_profit:'2',sort_order:3,bestEffort:1,top_n:2,topValue:3,final_rank:1,winners:[{id:1}]}).sort(),
    ['row.bestEffort','row.final_rank','row.topValue','row.top_n','row.winners']);
  assert.deepEqual(developmentRowViolations({rows:[{rank:1,nested:{best_value:1}}],qualified_winner:'x'}).sort(),['row.qualified_winner','row.rows[0].nested.best_value','row.rows[0].rank']);
  for(const key of ['search_dimension','dimensions','domain','domains','bounds','budget','free_dimensions'])assert.equal(note(validateEvaluationRequest({[key]:1})).code,'QR4_EVALUATION_SEARCH_REFUSED',key);
  assert.equal(validateEvaluationRequest({}).ok,true);
  assert.equal(validateEvaluationRequest({weights:{a:1}}).code,'QR4_CUSTOM_WEIGHTS_REFUSED');
  assert.equal(validateEvaluationRequest(null).code,'INVALID_FIELDS');
  // L6: an allow-list. Every name outside it is refused, even one that avoids every blocked word, and a name is read as given.
  for(const action of ['apply','import','start_bot','email','alert','deploy','optimize','rerun','','x','delete','update','write','new_action','Register','REGISTER','register ',
    'list_all','cancel_all','replay','open','detail/1',' list',null,5,{},['register']]){
    const out=note(checkRouteAction(action));
    assert.deepEqual([out.ok,out.code,out.status],[false,'QR4_APPLY_REFUSED',403],action);
  }
  assert.equal(checkRouteAction(undefined).code,'QR4_APPLY_REFUSED');
  for(const action of ['register','cancel','replay_outcome','open_package','list','detail'])assert.equal(checkRouteAction(action).ok,true,action);
});
test('module purity: nothing under src/selection reads a clock, random source, file, network or database',async()=>{
  const {readdirSync,readFileSync}=await import('node:fs');
  const dir=new URL('../src/selection/',import.meta.url);
  const files=readdirSync(dir).filter(name=>name.endsWith('.js'));
  assert.ok(files.length>=8);
  for(const name of files){
    const source=readFileSync(new URL(name,dir),'utf8');
    assert.doesNotMatch(source,/Date\.now|new Date\(\)|Math\.random|randomUUID|randomBytes|node:fs|node:net|node:http|fetch\(|process\.|require\(|from 'pg'/,name);
    assert.doesNotMatch(source,/parseFloat|Number\(/,name+' uses no binary floating point conversion');
  }
  // The scan above covers this directory. The imports are followed here: every package outside the repository that the module reaches,
  // directly or through the files it imports, is node:crypto or decimal.js (nothing that reads a clock, a file, a network or a database).
  const {existsSync}=await import('node:fs');
  const {fileURLToPath}=await import('node:url');
  const seenFiles=new Set(),packages=new Set();
  const selectionDir=fileURLToPath(dir);
  const visit=url=>{
    const path=fileURLToPath(url);
    if(seenFiles.has(path)||!existsSync(path))return;
    seenFiles.add(path);
    const code=readFileSync(path,'utf8');
    // Round 2: the clock, random and I/O scan runs on every file reached, not only on src/selection. Number( is exempt outside src/selection
    // (package-gates.js uses it for integer checks); parseFloat is refused everywhere.
    assert.doesNotMatch(code,/Date\.now|new Date\(\)|Math\.random|randomUUID|randomBytes|node:fs|node:net|node:http|fetch\(|process\.|require\(|from 'pg'/,path);
    assert.doesNotMatch(code,/parseFloat/,path+' uses no parseFloat');
    if(path.startsWith(selectionDir))assert.doesNotMatch(code,/Number\(/,path+' uses no Number(');
    const specifiers=[...code.matchAll(/^(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm),...code.matchAll(/^import\s*['"]([^'"]+)['"]/gm),...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)];
    for(const match of specifiers){
      const target=match[1];
      if(target.startsWith('.'))visit(new URL(target,url));else packages.add(target);
    }
  };
  for(const name of files)visit(new URL(name,dir));
  assert.ok(seenFiles.size>=files.length+3,'the imports were followed: '+seenFiles.size);
  assert.deepEqual([...packages].sort(),['decimal.js','node:crypto']);
});

// ---- fix round 1: root rulings H1, M1 to M8, L-items and the mutation survivors ----
test('OD-S3: tie tolerances are registry constants; the product registry holds null and refuses; the registry bounds are exact (H1, mutation survivor 38)',()=>{
  // Product registry (no injection): every tolerance is null until the owner sets it, so every registration is refused with the detail.
  const product=register(3,{},{objective_registry:undefined});
  assert.deepEqual([product.ok,product.code,product.detail],[false,'QR4_OBJECTIVE_UNKNOWN','TIE_TOLERANCES_NOT_SET']);
  assert.equal(register(3,{},{objective_registry:undefined,universe_cap:20}).detail,'TIE_TOLERANCES_NOT_SET');
  const direct=validateObjective({...OBJECTIVE},{...FILTERS});
  assert.deepEqual([direct.ok,direct.code,direct.detail],[false,'QR4_OBJECTIVE_UNKNOWN','TIE_TOLERANCES_NOT_SET']);
  // One tolerance null is as unset as both.
  for(const [r,d] of [[null,'0.5'],['0.5',null],[null,null]])assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry(r,d)}).detail,'TIE_TOLERANCES_NOT_SET',String([r,d]));
  // The cap is 100 pp: 100 is accepted, one hundredth above is refused, for the return tolerance and for the drawdown tolerance alike.
  const at100=validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry('100','100')});
  assert.deepEqual([at100.ok,at100.objective.tie_tolerance_return_pp,at100.objective.tie_tolerance_drawdown_pp],[true,'100','100']);
  assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry('100.00','0')}).ok,true);
  for(const [r,d] of [['100.01','0'],['0','100.01'],['100.000001','100'],['101','1']]){
    const out=validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry(r,d)});
    assert.deepEqual([out.ok,out.code,out.detail],[false,'QR4_OBJECTIVE_UNKNOWN','TIE_TOLERANCES_INVALID'],String([r,d]));
  }
  for(const bad of ['-0.1','abc','',0.5,{},true])for(const [r,d] of [[bad,'0'],['0',bad]]){
    const out=validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry(r,d)});
    assert.equal(out.ok,false,String(bad));
  }
  for(const key of ['return_pp','drawdown_pp']){
    const gone=testRegistry();delete gone[OBJECTIVE_ID].tie_tolerances[key];
    assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry:gone}).detail,'TIE_TOLERANCES_INVALID',key);
  }
  assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry('0','0')}).ok,true);
  assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry:testRegistry('-0','0')}).objective.tie_tolerance_return_pp,'0');
  // The registry argument itself is checked: a missing, null or malformed entry is an unknown objective, never a pass.
  for(const registry of [null,{},{[OBJECTIVE_ID]:null},{[OBJECTIVE_ID]:'x'},'x'])assert.equal(validateObjective({...OBJECTIVE},{...FILTERS},{registry}).code,'QR4_OBJECTIVE_UNKNOWN');
  // Checks that come before the tolerance check still win: unknown id, weights, tolerance keys in the request.
  assert.equal(validateObjective({id:'nope'},{...FILTERS}).code,'QR4_OBJECTIVE_UNKNOWN');
  assert.equal(validateObjective({id:'nope'},{...FILTERS}).detail,'nope');
  assert.equal(validateObjective({...OBJECTIVE,weights:{a:1}},{...FILTERS}).code,'QR4_CUSTOM_WEIGHTS_REFUSED');
  assert.equal(validateObjective({...OBJECTIVE,tie_tolerance_return_pp:'0.5'},{...FILTERS}).code,'INVALID_FIELDS');
  // The shape-only call (the early registration step) does not need the tolerances and returns null copies.
  const shape=validateObjective({...OBJECTIVE},{...FILTERS},{require_tolerances:false});
  assert.deepEqual([shape.ok,shape.objective.tie_tolerance_return_pp,shape.objective.tie_tolerance_drawdown_pp],[true,null,null]);
  // The registration and the ranking use the registration's own copies: a later registry change relabels nothing.
  const first=regOf(2,{},{objective_registry:testRegistry('0.5','0.5')});
  const list=[{net:'3.4',dd:'5'},{net:'3.0',dd:'5'}];
  const before=rank(first,list);
  assert.equal(before.outcome,'TIED_IN_SCOPE');
  const changed=regOf(2,{},{objective_registry:testRegistry('0.1','0.5')});
  assert.equal(rank(changed,list).outcome,'BEST_IN_SCOPE');
  assert.equal(rank(first,list).outcome_hash,before.outcome_hash);
  assert.notEqual(first.registration_hash,changed.registration_hash);
});

test('refusal order follows the table of 1.3: no eligible participant first, then the dependencies, then the tolerances (L10, 16.4 item 2)',()=>{
  const real=qualification({status:'SUCCEEDED',result:{holdout_evaluated:true,selected:{screen_reasons:[]}},blockers:[],integrity:{contract_hash_verified:true,report_matches_checkpoints:true},
    holdoutOverlap:{overlaps:false},contractVersion:'none'});
  // Staging today: no G8 source, no episode gate, no QR-3 facts, no registry values, an unreadable register. The first row of 1.3 wins.
  const staging=register(3,{},{dependencies:{},exposure_register:null,objective_registry:undefined},()=>({qualification:real}));
  assert.deepEqual([staging.ok,staging.code],[false,'QR4_NO_ELIGIBLE_PARTICIPANT']);
  assert.ok(staging.universe.every(item=>item.code==='QR4_DEVELOPMENT_SCORE_NOT_RANKABLE'));
  // With eligible participants the dependency codes follow in the order of the table, then the registry values.
  assert.equal(register(3,{},{dependencies:{},exposure_register:null,objective_registry:undefined}).code,'QR4_QR3_CONTEXT_UNAVAILABLE');
  assert.equal(register(3,{},{dependencies:{...DEPS,evaluation_mode:false},exposure_register:null}).code,'QR4_EVALUATION_MODE_UNAVAILABLE');
  assert.equal(register(3,{},{dependencies:{...DEPS,episode_gate_version:null},exposure_register:null}).code,'QR4_EPISODE_GATE_UNAVAILABLE');
  assert.equal(register(3,{},{exposure_register:null,objective_registry:undefined}).code,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE');
  assert.equal(register(3,{},{objective_registry:undefined}).detail,'TIE_TOLERANCES_NOT_SET');
  assert.equal(register(1,{},{objective_registry:undefined}).detail,'TIE_TOLERANCES_NOT_SET');
  assert.equal(register(1).code,'QR4_TOO_FEW_PARTICIPANTS');
  assert.equal(register(3,{},{objective_registry:undefined},()=>({run_status:'FAILED'})).code,'QR4_NO_ELIGIBLE_PARTICIPANT');
});

test('the server-read facts are required and never defaulted: requester, earlier selections, earlier registrations (M3, L2, L3)',()=>{
  // M3: the earlier selection ids come from the context. A request value is not a field of the request.
  const viaRequest=register(3,{prior_selection_ids:['sel-0']});
  assert.deepEqual([viaRequest.code,viaRequest.detail],['INVALID_FIELDS','REQUEST_KEYS']);
  for(const bad of [undefined,null,'sel-0',{},[1],[''],['a','a'],[null]]){
    const out=register(3,{},{prior_selection_ids:bad});
    assert.deepEqual([out.code,out.detail],['INVALID_FIELDS','PRIOR_SELECTIONS_UNREADABLE'],JSON.stringify(bad));
  }
  const prior=regOf(3,{},{prior_selection_ids:['sel-9','sel-0','sel-3']});
  assert.deepEqual([prior.prior_selection_count,prior.prior_selection_ids],[3,['sel-0','sel-3','sel-9']]);
  assert.equal(regOf(3).prior_selection_count,0);
  assert.equal(scopeStatement(prior).prior_selection_count,3);
  // The count and the ids sit in the registration hash.
  assert.notEqual(prior.registration_hash,regOf(3).registration_hash);
  // L2: the requester is read by the server and must be the owner (OD-S18). There is no default.
  for(const [bad,detail] of [[undefined,'REQUESTER_UNREADABLE'],[null,'REQUESTER_UNREADABLE'],['','REQUESTER_UNREADABLE'],[7,'REQUESTER_UNREADABLE'],['owner-b','REQUESTER_NOT_OWNER']]){
    const out=register(3,{},{requester_owner_id:bad});
    assert.deepEqual([out.code,out.detail],['INVALID_FIELDS',detail],String(bad));
  }
  assert.equal(register(3,{owner_id:'owner-b'},{requester_owner_id:OWNER}).detail,'REQUESTER_NOT_OWNER');
  assert.equal(register(3,{},{requester_owner_id:OWNER}).ok,true);
  assert.equal(buildRegistration(request(members(3)),{...context(),requester_owner_id:undefined}).detail,'REQUESTER_UNREADABLE');
  // L3: the earlier registrations must be an array, so the idempotency check can never be skipped.
  for(const bad of [undefined,null,'x',{},7]){
    const out=register(3,{},{existing_registrations:bad});
    assert.deepEqual([out.code,out.detail],['INVALID_FIELDS','EXISTING_REGISTRATIONS_UNREADABLE'],JSON.stringify(bad));
  }
  assert.equal(register(3,{},{existing_registrations:[]}).ok,true);
  assert.equal(register(3,{},{existing_registrations:[null,1,'x',{owner_id:OWNER}]}).ok,true);
});

test('fixture selections (OD-S15): fixture packages only, never a label, internal view only; a customer selection still refuses them (M7)',()=>{
  const reg=regOf(3,{fixture:true},{},fixtureOver);
  assert.deepEqual([reg.fixture,reg.participant_count,reg.universe.every(item=>item.status==='PARTICIPANT')],[true,3,true]);
  assert.ok(reg.participants.every(item=>item.validation_binding&&item.validation_binding.export_id===item.export_id));
  // A fixture selection runs through every outcome and never produces a label.
  const outcomes={
    BEST_IN_SCOPE:[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}],
    TIED_IN_SCOPE:[{net:'3',dd:'3'},{net:'3',dd:'3'},{net:'1',dd:'3'}],
    NO_QUALIFYING_STRATEGY:[{net:'-1'},{net:'-2'},{net:'-3'}],
    INADEQUATE_EVIDENCE:[{episodes:1},{episodes:2},{episodes:3}]};
  for(const [name,list] of Object.entries(outcomes)){
    const out=rank(reg,list);
    assert.deepEqual([out.status,out.outcome,out.label,out.fixture],['SELECTION_COMPLETED',name,null,true],name);
  }
  // The view layer hides the label of a fixture selection as well, whatever the facts say.
  const facts={packages_ready:{'exp-1':true,'exp-2':true,'exp-3':true},replay_mismatch:false,current_versions:{objective:'qr4-objective-lexi-v1',scope:'qr4-scope-v1'}};
  assert.equal(deriveOverlays(reg,rank(reg,outcomes.BEST_IN_SCOPE),facts).label_visible,false);
  // A customer selection refuses every fixture package, and a fixture selection refuses every customer package.
  const customer=register(3,{},{},fixtureOver);
  assert.deepEqual([customer.ok,customer.code],[false,'QR4_NO_ELIGIBLE_PARTICIPANT']);
  assert.ok(customer.universe.every(item=>item.code==='QR4_FIXTURE_PARTICIPANT'&&item.detail==='FIXTURE'));
  const wrongWay=register(3,{fixture:true});
  assert.deepEqual([wrongWay.ok,wrongWay.code],[false,'QR4_NO_ELIGIBLE_PARTICIPANT']);
  assert.ok(wrongWay.universe.every(item=>item.code==='QR4_FIXTURE_PARTICIPANT'&&item.detail==='NOT_FIXTURE_IN_FIXTURE_SELECTION'));
  // Mixed universe: the customer package is excluded, the three fixture packages take part.
  const mixed=regOf(4,{fixture:true},{},k=>k===4?{}:fixtureOver(k));
  assert.deepEqual([mixed.participant_count,mixed.universe.find(item=>item.run_id==='run-4').code],[3,'QR4_FIXTURE_PARTICIPANT']);
  // The fixture path relaxes the fixture flag only. Every other check of E1 to E6 still applies to a fixture package.
  const FX={...CTX,fixture:true};
  const fixtureEligibility=m=>evaluateEligibility(m,FX);
  const base=()=>({...member(1),...fixtureOver(1)});
  assert.equal(fixtureEligibility(base()).eligible,true);
  assert.deepEqual(fixtureEligibility({...base(),run_status:'FAILED'}).code,'QR4_PARTICIPANT_NOT_QUALIFIED');
  assert.deepEqual([fixtureEligibility({...base(),integrity_checked:false}).code,fixtureEligibility({...base(),integrity_checked:false}).detail],['QR4_PARTICIPANT_NOT_QUALIFIED','INTEGRITY_NOT_CHECKED']);
  assert.equal(fixtureEligibility({...base(),qualification:null}).code,'QR4_PARTICIPANT_NOT_QUALIFIED');
  const noRecord={...base(),validation_records:[]};
  assert.deepEqual([fixtureEligibility(noRecord).code,fixtureEligibility(noRecord).checks.E3],['QR4_VALIDATION_BINDING_MISMATCH','FAIL']);
  const customerRecord=base();customerRecord.validation_records[0].record.fixture=false;
  assert.equal(fixtureEligibility(customerRecord).checks.E3,'FAIL');
  const otherPackage=base();otherPackage.validation_records[0].record.package_hash=sha('other');
  assert.equal(fixtureEligibility(otherPackage).code,'QR4_VALIDATION_BINDING_MISMATCH');
  const failedGate=base();failedGate.validation_records[0].record.gate_results[0].state='FAIL';
  assert.equal(fixtureEligibility(failedGate).checks.E3,'FAIL');
  const stale=base();stale.package.current.deployment_id='dep-changed';
  assert.equal(fixtureEligibility(stale).checks.E2,'FAIL');
  const foreignBot=base();foreignBot.package.current.bot_owner_id='someone-else';
  assert.deepEqual([fixtureEligibility(foreignBot).checks.E2,fixtureEligibility(foreignBot).failures.find(item=>item.check==='E2').detail],['FAIL','BOT_NOT_OWNED']);
  const draft=base();draft.package.status='EXPORT_INTERNAL';
  assert.equal(fixtureEligibility(draft).checks.E2,'FAIL');
  const multi=base();multi.package.binding.mode='MULTI_PINE';
  assert.equal(fixtureEligibility(multi).code,'QR4_MULTI_PINE_PARTICIPANT');
  const wrongMarket={...base(),market:{...MARKET,symbol:'ETHUSDT'}};
  assert.equal(fixtureEligibility(wrongMarket).checks.E4,'FAIL');
  const scoped=base();scoped.scope.capital={equity:'1',cash:'1'};
  assert.deepEqual(fixtureEligibility(scoped).mismatched_fields,['capital']);
  const unreadable=base();delete unreadable.package.binding.fixture;
  assert.equal(fixtureEligibility(unreadable).checks.E6,'FAIL');
  assert.equal(fixtureEligibility({...base(),kind:'IMPORTED_BUNDLE'}).eligible,false);
  assert.equal(fixtureEligibility({...base(),owner_id:'owner-b'}).code,'NOT_FOUND');
  // The same fixture member is not eligible for a customer selection (E1 passes nothing for it either: G8 fails).
  assert.equal(eligibility(base()).eligible,false);
  // The flag is read as a boolean only: a truthy string is a customer selection.
  assert.equal(evaluateEligibility(base(),{...CTX,fixture:'yes'}).eligible,false);
  assert.equal(register(3,{fixture:'yes'},{},fixtureOver).code,'INVALID_FIELDS');
});

test('universe snapshot rows carry the library class, the qualification label and the package status (M8, 3.4)',()=>{
  const out=register(3,{},{},k=>k===3?{library_class:undefined,qualification:{...qual(),label:'DEVELOPMENT_ONLY',qualified:false},package:{...member(3).package,status:'EXPORT_INTERNAL'}}:{});
  assert.equal(out.ok,true);
  const rows=out.registration.universe;
  assert.deepEqual(rows.map(item=>[item.run_id,item.library_class,item.qualification_label,item.package_status,item.status]),
    [['run-1','READY_FOR_REVIEW','QUALIFIED','EXPORT_VALIDATED','PARTICIPANT'],['run-2','READY_FOR_REVIEW','QUALIFIED','EXPORT_VALIDATED','PARTICIPANT'],
     ['run-3',null,'DEVELOPMENT_ONLY','EXPORT_INTERNAL','EXCLUDED']]);
  // The new fields sit inside the registration hash.
  const other=register(3,{},{},k=>k===3?{library_class:'OTHER',qualification:{...qual(),label:'DEVELOPMENT_ONLY',qualified:false},package:{...member(3).package,status:'EXPORT_INTERNAL'}}:{});
  assert.notEqual(other.registration.registration_hash,out.registration.registration_hash);
  assert.deepEqual(eligibility(null).library_class,null);
  assert.deepEqual([eligibility(member(1)).library_class,eligibility(member(1)).qualification_label,eligibility(member(1)).package_status],['READY_FOR_REVIEW','QUALIFIED','EXPORT_VALIDATED']);
});

test('E1 is FAIL, not NOT_REACHED, for a never-participant kind and for a foreign run (L9)',()=>{
  for(const m of [member(1,{kind:'ACTUAL_HISTORY'}),member(1,{kind:'IMPORTED_BUNDLE'}),member(1,{kind:'EVALUATION_RUN'}),member(1,{kind:'OTHER'}),member(1,{owner_id:'owner-b'}),member(1,{run_id:''})]){
    const out=eligibility(m);
    assert.deepEqual([out.eligible,out.checks.E1,out.failures[0].check],[false,'FAIL','E1']);
    assert.deepEqual(Object.values(out.checks).slice(1),['NOT_REACHED','NOT_REACHED','NOT_REACHED','NOT_REACHED','NOT_REACHED']);
  }
  assert.equal(evaluateEligibility(member(1),{owner_id:OWNER,requester_owner_id:OWNER,scope:SCOPE}).checks.E1,'PASS');
});

test('module surface: the generic ranker, the filter function and the label builder are not exported from index.js (L7)',()=>{
  for(const name of ['rankPassed','applyFilters','buildLabel','bestLabelText','tiedLabelText'])assert.equal(selection[name],undefined,name);
  for(const name of ['rankSelection','replayOutcome','buildRegistration','evaluateEligibility','recheckWindow','transitionSelection','deriveOverlays','scopeStatement','outcomeText'])
    assert.equal(typeof selection[name],'function',name);
  assert.equal(typeof applyFilters,'function');
  assert.equal(typeof rankPassed,'function');
  assert.equal(typeof buildLabel,'function');
});

test('mutation survivors 2 and 7: negative zero passes F3; a primary tie inside the drawdown tolerance orders by lower drawdown first',()=>{
  const read={limit:'20',floor:5,beats:false};
  const values=(over={})=>({max_drawdown_percent:'1',episodes:5,cost_stress_net_return_percent:'0',net_return_percent:'1',benchmark_net_return_percent:'0',...over});
  assert.deepEqual(applyFilters(values(),read),[]);
  assert.deepEqual(applyFilters(values({cost_stress_net_return_percent:'-0'}),read),[]);
  assert.deepEqual(applyFilters(values({cost_stress_net_return_percent:'-0.0'}),read),[]);
  assert.deepEqual(applyFilters(values({cost_stress_net_return_percent:'-0.0000001'}),read),['FILTER_COST_STRESS']);
  assert.deepEqual(applyFilters(values({cost_stress_net_return_percent:'0.0000001'}),read),[]);
  assert.deepEqual(applyFilters(values({net_return_percent:'-0'}),read),['FILTER_NET_RETURN_POSITIVE']);
  // Survivor 7: both are inside the primary tolerance (equal return) and inside the drawdown tolerance (0.3 pp). Rank 1 is shared and
  // the array lists the lower drawdown first, whatever the input order.
  const reg=regOf(2);
  const forward=rank(reg,[{net:'3',dd:'5.3'},{net:'3',dd:'5'}]);
  assert.equal(forward.outcome,'TIED_IN_SCOPE');
  assert.deepEqual(forward.ranking.map(item=>[item.rank,item.export_id,item.max_drawdown_percent,item.decided_by]),[[1,'exp-2','5','TIE'],[1,'exp-1','5.3','TIE']]);
  const backward=rank(reg,[{net:'3',dd:'5'},{net:'3',dd:'5.3'}]);
  assert.deepEqual(backward.ranking.map(item=>[item.rank,item.export_id,item.max_drawdown_percent]),[[1,'exp-1','5'],[1,'exp-2','5.3']]);
  assert.notEqual(forward.outcome_hash,backward.outcome_hash);
  // The higher return comes first; equal return and equal drawdown fall back to the export id for the ORDER of the list only.
  const three=regOf(3);
  const mixedOrder=rank(three,[{net:'1',dd:'1'},{net:'3',dd:'5.3'},{net:'3',dd:'5'}]);
  assert.deepEqual(mixedOrder.ranking.map(item=>item.export_id),['exp-3','exp-2','exp-1']);
  const direct=rankPassed([{export_id:'b',net_return_percent:'3',max_drawdown_percent:'5.3'},{export_id:'a',net_return_percent:'3',max_drawdown_percent:'5'},
    {export_id:'c',net_return_percent:'1',max_drawdown_percent:'0'}],{return_pp:'0.5',drawdown_pp:'0.5'});
  assert.deepEqual(direct.map(item=>[item.rank,item.export_id]),[[1,'a'],[1,'b'],[2,'c']]);
  const equalAll=rankPassed([{export_id:'b',net_return_percent:'3',max_drawdown_percent:'5'},{export_id:'a',net_return_percent:'3',max_drawdown_percent:'5'}],{return_pp:'0',drawdown_pp:'0'});
  assert.deepEqual(equalAll.map(item=>item.export_id),['a','b']);
});

test('outcome replay binds the frozen W dataset hash: a replay on another frozen hash is a mismatch (M4)',()=>{
  const reg=regOf(3);
  const list=evaluations(reg,[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}]);
  const done=rankSelection(reg,list);
  assert.equal(done.window_dataset_hash,DATASET);
  const stored=done.outcome_hash;
  assert.equal(replayOutcome(reg,list,stored).match,true);
  const other=replayOutcome(reg,list,stored,{window_dataset_hash:sha('another-dataset')});
  assert.deepEqual([other.match,other.recomputed_outcome_hash,other.event.label_suppressed],[false,null,true]);
  const missing=replayOutcome(reg,list,stored,{});
  assert.deepEqual([missing.match,missing.event.kind],[false,'SELECTION_REPLAY_MISMATCH']);
  assert.equal(replayOutcome(reg,list,stored,null).match,false);
});

test('code coverage: every listed code is triggered here by its own call; every emitted code matches the pattern and is listed (test 20 part 2)',()=>{
  // Self-contained: each entry builds its own inputs, so the test does not depend on the order or the success of any other test.
  const reg=regOf(3),two=regOf(2),ok3=[{net:'3',dd:'3'},{net:'2',dd:'3'},{net:'1',dd:'3'}];
  const real=qualification({status:'SUCCEEDED',result:{holdout_evaluated:true,selected:{screen_reasons:[]}},blockers:[],integrity:{contract_hash_verified:true,report_matches_checkpoints:true},
    holdoutOverlap:{overlaps:false},contractVersion:'none'});
  const mutated=fn=>{const list=evaluations(reg,ok3);fn(list[0]);return rankSelection(reg,list);};
  const withWindow=(ctx,fix=null)=>buildRegistration(request(members(3,fix),{admission_deadline_ms:W.start_ms+30000*MS}),context(ctx));
  const research=(over={})=>({owner_id:OWNER,source_hash:sha('src2'),run_id:'run-late',kind:'RESEARCH_RUN',window:{start_ms:reg.window.start_ms,end_ms:reg.window.start_ms+MS},...over});
  const exposure={owner_id:OWNER,market_key:MARKET_KEY,window:{start_ms:W.start_ms+MS,end_ms:W.start_ms+2*MS},comparison_id:'cmp-1',kind:'QR3_COMPARISON',at_ms:T0-DAY};
  const triggers={
    NOT_FOUND:()=>evaluateEligibility(member(1,{owner_id:'owner-b'}),CTX),
    CONFIRMATION_REQUIRED:()=>buildRegistration(request(members(3),{confirmed:false}),context()),
    INVALID_FIELDS:()=>buildRegistration(null,context()),
    QR4_NO_ELIGIBLE_PARTICIPANT:()=>buildRegistration(request([]),context()),
    QR4_PARTICIPANT_NOT_READY:()=>evaluateEligibility(member(1,{kind:'IMPORTED_BUNDLE'}),CTX),
    QR4_PARTICIPANT_NOT_QUALIFIED:()=>evaluateEligibility(member(1,{run_status:'FAILED'}),CTX),
    QR4_VALIDATION_BINDING_MISMATCH:()=>evaluateEligibility(member(1,{validation_records:[]}),CTX),
    QR4_FIXTURE_PARTICIPANT:()=>evaluateEligibility(member(1,fixtureOver(1)),CTX),
    QR4_MULTI_PINE_PARTICIPANT:()=>{const m=member(1);m.package.binding.mode='MULTI_PINE';return evaluateEligibility(m,CTX);},
    QR4_DEVELOPMENT_SCORE_NOT_RANKABLE:()=>buildRegistration(request(members(3),{ranking_basis:'DEVELOPMENT_SCORE'}),context()),
    QR4_OWN_HOLDOUT_NOT_COMPARABLE:()=>buildRegistration(request(members(3),{ranking_basis:'OWN_HOLDOUT'}),context()),
    QR4_ACTUAL_HISTORY_NOT_RANKABLE:()=>buildRegistration(request([member(8,{kind:'ACTUAL_HISTORY'}),member(9,{kind:'ACTUAL_HISTORY'})]),context()),
    QR4_MIXED_BASIS:()=>buildRegistration(request([...members(3),member(9,{kind:'ACTUAL_HISTORY'})]),context()),
    QR4_TOO_FEW_PARTICIPANTS:()=>buildRegistration(request(members(1)),context()),
    QR4_TOO_MANY_PARTICIPANTS:()=>buildRegistration(request(members(5)),context()),
    QR4_DUPLICATE_PARTICIPANT:()=>{const dup=request(members(3));dup.universe[1]=member(2,{export_id:'exp-1'});return buildRegistration(dup,context());},
    QR4_UNIVERSE_TOO_LARGE:()=>buildRegistration(request(members(3)),context({universe_cap:2})),
    QR4_SCOPE_INCOMPATIBLE:()=>buildRegistration(request(members(3),{scope:{...clone(SCOPE),engine:'x'}}),context()),
    QR4_RULES_VERSION_MIXED:()=>buildRegistration(request(members(3,k=>k===2?{rules_hash:sha('other')}:{})),context()),
    BI_MARKET_SCOPE_INVALID:()=>evaluateEligibility(member(1,{market:{...MARKET,symbol:'ETHUSDT'}}),CTX),
    QR4_OBJECTIVE_UNKNOWN:()=>buildRegistration(request(members(3),{objective:{id:'custom'}}),context()),
    QR4_CUSTOM_WEIGHTS_REFUSED:()=>buildRegistration(request(members(3),{weights:{a:1}}),context()),
    QR4_FILTER_INVALID:()=>buildRegistration(request(members(3),{filters:{...FILTERS,episode_floor:4}}),context()),
    QR4_REGISTRATION_IMMUTABLE:()=>refuseRegistrationChange(),
    QR4_WINDOW_INVALID:()=>buildRegistration(request(members(3),{window:null}),context()),
    QR4_WINDOW_OVER_CAPACITY:()=>buildRegistration(request(members(3)),context({capacity_bars:10})),
    QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA:()=>withWindow({},k=>k===1?{data_windows:{...member(1).data_windows,train:{start_ms:W.start_ms+10*MS,end_ms:W.start_ms+20*MS}}}:{}),
    QR4_WINDOW_OVERLAPS_SEARCHED_DATA:()=>recheckWindow({registration:reg,exposure_register:[],searched_windows:[research()],stage:'EVALUATION_START'}),
    QR4_WINDOW_EXPOSED:()=>withWindow({exposure_register:[exposure]}),
    QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY:()=>withWindow({},k=>k===2?{registered_boundary_ms:W.start_ms+MS}:{}),
    QR4_QR3_CONTEXT_UNAVAILABLE:()=>buildRegistration(request(members(3)),context({dependencies:{...DEPS,qr3_context:false}})),
    QR4_EVALUATION_MODE_UNAVAILABLE:()=>buildRegistration(request(members(3)),context({dependencies:{...DEPS,evaluation_mode:false}})),
    QR4_EPISODE_GATE_UNAVAILABLE:()=>buildRegistration(request(members(3)),context({dependencies:{...DEPS,episode_gate_version:EPISODE_GATE_VERSION}})),
    QR4_EXPOSURE_REGISTRY_UNAVAILABLE:()=>buildRegistration(request(members(3)),context({exposure_register:null})),
    QR4_EVALUATION_SEARCH_REFUSED:()=>validateEvaluationRequest({budget:1}),
    QR4_SELECTION_EXISTS:()=>buildRegistration(request(members(3),{selection_id:'sel-2'}),context({existing_registrations:[{owner_id:OWNER,registration_key:reg.registration_key,selection_id:'sel-1'}]})),
    QR4_APPLY_REFUSED:()=>checkRouteAction('apply'),
    QR4_TRANSITION_INVALID:()=>transitionSelection('SELECTION_COMPLETED',{kind:'OWNER_CANCEL'}),
    QR4_EVALUATION_FAILED:()=>mutated(ev=>{ev.status='FAILED';}),
    QR4_METRIC_MISSING:()=>mutated(ev=>{delete ev.result.metrics.net_return_percent;rehash(ev);}),
    INTEGRITY_CHECK_FAILED:()=>mutated(ev=>{ev.integrity=null;}),
    QR4_ENGINE_MISMATCH:()=>mutated(ev=>{ev.engine_hash=sha('other-engine');}),
    QR4_BENCHMARK_UNAVAILABLE:()=>mutated(ev=>{ev.result.benchmark=null;rehash(ev);}),
    BI_DATASET_HASH_MISMATCH:()=>mutated(ev=>{ev.dataset_hash=sha('other');}),
    QR4_WINDOW_DATA_GAP:()=>mutated(ev=>{ev.result.evaluation_bars+=1;rehash(ev);}),
    FILTER_DRAWDOWN_LIMIT:()=>rank(two,[{dd:'30'},{}]),
    FILTER_EPISODE_FLOOR:()=>rank(two,[{episodes:1},{}]),
    FILTER_COST_STRESS:()=>rank(two,[{stress:'-1'},{}]),
    FILTER_NET_RETURN_POSITIVE:()=>rank(two,[{net:'0'},{}]),
    FILTER_BEATS_BUY_AND_HOLD:()=>rank(regOf(2,{filters:{...FILTERS,beats_buy_and_hold:true}}),[{net:'1',bench:'2'},{net:'5',bench:'1'}])
  };
  // Codes that only the isolated database slices and the evaluation worker emit are listed by the contract and reserved in CODE_LIST;
  // the pure module does not emit them (they appear in transition events as the codes of a terminal status).
  const reserved=['QR4_WINDOW_DATA_UNAVAILABLE','QR4_PARTICIPANT_STALE','QR4_ADMISSION_REFUSED'];
  for(const [code,run] of Object.entries(triggers)){
    assert.ok(CODE_LIST.includes(code),code+' is not in CODE_LIST');
    assert.match(code,/^[A-Z][A-Z0-9_]{1,63}$/,code);
    const found=codesOf(run());
    assert.ok(found.has(code),code+' was not emitted by its own trigger: '+[...found].join(','));
    for(const emitted of found){
      assert.match(emitted,/^[A-Z][A-Z0-9_]{1,63}$/,emitted);
      assert.ok(CODE_LIST.includes(emitted),emitted+' is not in CODE_LIST');
    }
  }
  // Every other listed code is either reserved above or a TRIGGER, so a code added to the list without a call here fails this test.
  for(const code of CODE_LIST)assert.ok(code in triggers||reserved.includes(code),code+' has no trigger and is not reserved');
  assert.ok(Object.keys(triggers).length>=48,'triggers: '+Object.keys(triggers).length);
  // Transition events carry the reserved codes.
  assert.equal(transitionSelection('SELECTION_REGISTERED',{kind:'WINDOW_DATA_UNAVAILABLE',code:'QR4_WINDOW_DATA_UNAVAILABLE'}).code,'QR4_WINDOW_DATA_UNAVAILABLE');
  assert.equal(transitionSelection('SELECTION_EVALUATING',{kind:'PARTICIPANT_INELIGIBLE',code:'QR4_PARTICIPANT_STALE'}).code,'QR4_PARTICIPANT_STALE');
  assert.equal(transitionSelection('SELECTION_EVALUATING',{kind:'DEADLINE_PASSED',code:'QR4_ADMISSION_REFUSED'}).code,'QR4_ADMISSION_REFUSED');
  assert.ok(real.gates.length===8);
});

// ---- fix round 2: root rulings QR-4 S1 round 2 (audit defects and mutation survivors) ----
test('round 2 M: ALL_EVALUATIONS_DONE to INCOMPLETE takes only a section 10 code; an unreadable register never ends a selection',()=>{
  assert.deepEqual([...INCOMPLETE_PRIORITY],[...INCOMPLETE_CODES]);
  assert.equal(INCOMPLETE_CODES.length,10);
  assert.ok(INCOMPLETE_CODES.every(code=>CODE_LIST.includes(code)));
  for(const code of INCOMPLETE_CODES){
    const out=transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_INCOMPLETE',code});
    assert.deepEqual([out.ok,out.to,out.code],[true,'SELECTION_INCOMPLETE',code],code);
  }
  for(const code of ['FOO','QR4_EXPOSURE_REGISTRY_UNAVAILABLE','QR4_WINDOW_EXPOSED','QR4_TRANSITION_INVALID','',null,undefined,5]){
    const out=transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_INCOMPLETE',code});
    assert.deepEqual([out.ok,out.code,out.detail],[false,'QR4_TRANSITION_INVALID','CODE_NOT_ALLOWED'],String(code));
  }
  // The completed branch is unchanged: an outcome, no code.
  const done=transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_COMPLETED',outcome:'BEST_IN_SCOPE'});
  assert.deepEqual([done.ok,done.to,done.code,done.outcome],[true,'SELECTION_COMPLETED',null,'BEST_IN_SCOPE']);
});

test('round 2 L1/L2: D2 matches word-token prefixes after splitting on every non-letter; the evaluation request is an allow-list',()=>{
  assert.deepEqual(developmentRowViolations({top10:1,bestscore:2,winnerid:3,leader:4,leaderBoard:5,best3:6,rank2:7,stop_loss:8,desktop:9,topology_free:0}).sort(),
    ['row.best3','row.bestscore','row.leader','row.leaderBoard','row.rank2','row.top10','row.topology_free','row.winnerid']);
  assert.deepEqual(developmentRowViolations({stop_loss:1,desktop:2,bottom:3,restop:4,sort_order:5,ordinal:6}),[]);
  assert.deepEqual(developmentRowViolations({a:{leader_id:1},b:[{Top10:1}]}).sort(),['row.a.leader_id','row.b[0].Top10']);
  // Evaluation request allow-list: an unknown key is INVALID_FIELDS, the named search keys keep their code, weights keep theirs.
  assert.equal(EVALUATION_REQUEST_KEYS.length,10);
  assert.equal(validateEvaluationRequest({selection_id:'s',parent_run_id:'r',mode:'QR4_SELECTION_EVAL'}).ok,true);
  for(const key of EVALUATION_REQUEST_KEYS)assert.equal(validateEvaluationRequest({[key]:'x'}).ok,true,key);
  for(const key of ['param_range','inputs_override','params','parameters','override','tweak','Selection_Id']){
    const out=validateEvaluationRequest({[key]:1});
    assert.deepEqual([out.code,out.detail.startsWith('REQUEST_KEYS')],['INVALID_FIELDS',true],key);
  }
  assert.equal(validateEvaluationRequest({selection_id:'s',param_range:[1,2]}).code,'INVALID_FIELDS');
  assert.equal(validateEvaluationRequest({selection_id:'s',inputs_override:{}}).code,'INVALID_FIELDS');
  assert.equal(validateEvaluationRequest({budget:1,param_range:1}).code,'QR4_EVALUATION_SEARCH_REFUSED');
  assert.equal(validateEvaluationRequest({param_range:1,weights:{a:1}}).code,'QR4_CUSTOM_WEIGHTS_REFUSED');
});

test('round 2 L3: a tolerance key in the filters is INVALID_FIELDS, like one in the objective',()=>{
  for(const key of ['tie_tolerance_return_pp','tolerance','Tolerance','tieToleranceDrawdownPp','return_tolerance'])
    for(const options of [{registry:TEST_REGISTRY},{require_tolerances:false}]){
      const out=validateObjective({...OBJECTIVE},{...FILTERS,[key]:'0.5'},options);
      assert.deepEqual([out.ok,out.code,out.detail],[false,'INVALID_FIELDS','TOLERANCE_IN_REQUEST'],key);
    }
  const viaRequest=register(3,{filters:{...FILTERS,tie_tolerance_return_pp:'0.5'}});
  assert.deepEqual([viaRequest.ok,viaRequest.code,viaRequest.detail],[false,'INVALID_FIELDS','TOLERANCE_IN_REQUEST']);
  // Another unknown filter key keeps its own code.
  const other=validateObjective({...OBJECTIVE},{...FILTERS,extra:1},{registry:TEST_REGISTRY});
  assert.deepEqual([other.code,other.detail],['QR4_FILTER_INVALID','FILTER_KEYS']);
});

test('round 2 L4: the recheck verifies registration_hash before it judges the stored window or participants',()=>{
  const reg=regOf(3);
  const run=registration=>recheckWindow({registration,exposure_register:[],searched_windows:[],stage:'EVALUATION_START'});
  assert.equal(run(reg).ok,true);
  const hashFail=out=>assert.deepEqual([out.ok,out.ends_selection,out.status,out.code,out.detail,out.ranking],[false,false,null,'INTEGRITY_CHECK_FAILED','REGISTRATION_HASH',false]);
  // An altered window, an altered participant list, a dropped participant, a changed owner and a wrong or missing hash all block the step.
  const moved=clone(reg);moved.window.start_ms+=MS;hashFail(run(moved));
  const swapped=clone(reg);swapped.participants[0].source_hash=sha('other-source');hashFail(run(swapped));
  const dropped=clone(reg);dropped.participants.pop();hashFail(run(dropped));
  const owner=clone(reg);owner.owner_id='owner-b';hashFail(run(owner));
  const wrong=clone(reg);wrong.registration_hash=sha('x');hashFail(run(wrong));
  const none=clone(reg);delete none.registration_hash;hashFail(run(none));
  // Neutral list order does not matter, and an unreadable registration is still REGISTRATION_UNREADABLE.
  const reordered=clone(reg);reordered.participants.reverse();reordered.universe.reverse();
  assert.equal(run(reordered).ok,true);
  assert.equal(run({...reg,participants:[]}).detail,'REGISTRATION_UNREADABLE');
  assert.equal(reg.registration_hash,registrationHashOf(reg));
});

test('round 2 L5: a fixture selection needs the server flag; the request flag alone never admits fixture packages',()=>{
  for(const flag of [undefined,false,'true',1,0,null,{}]){
    const out=register(3,{fixture:true},{fixture_selections_allowed:flag},fixtureOver);
    assert.deepEqual([out.ok,out.code,out.detail],[false,'QR4_FIXTURE_PARTICIPANT','FIXTURE_SELECTION_NOT_ALLOWED'],String(flag));
  }
  assert.equal(register(3,{fixture:true},{fixture_selections_allowed:true},fixtureOver).ok,true);
  // A customer selection does not need the flag, and the flag does not turn a customer selection into a fixture one.
  assert.equal(register(3,{},{fixture_selections_allowed:undefined}).ok,true);
  assert.equal(register(3,{fixture:false},{fixture_selections_allowed:true}).ok,true);
  assert.equal(regOf(3,{},{fixture_selections_allowed:true}).fixture,false);
  // The refusal comes before any package is read: not a NO_ELIGIBLE_PARTICIPANT list.
  assert.equal(register(3,{fixture:true},{fixture_selections_allowed:false}).universe,undefined);
});

test('round 2 survivors N12 and N12b: an unknown entry kind or a non-text source hash makes the searched list unreadable',()=>{
  const reg=regOf(3);
  const evaluation={start_ms:reg.window.start_ms,end_ms:reg.window.end_ms};
  const good=(over={})=>({owner_id:OWNER,source_hash:sha('src1'),run_id:'run-x',kind:'RESEARCH_RUN',window:{start_ms:T0-30*DAY,end_ms:T0-29*DAY},...over});
  const unreadable=out=>assert.deepEqual([out.ok,out.code,out.detail],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE']);
  const sources=[sha('src1'),sha('src2')];
  assert.equal(overlapsSearchedData(evaluation,{owner_id:OWNER,source_hashes:sources,entries:[good()]}),null);
  // N12: an entry kind outside RESEARCH_RUN and EVALUATION_RUN, even with a window that overlaps nothing, is unreadable and never skipped.
  for(const kind of ['OTHER','research_run','',null,undefined,5])
    unreadable(overlapsSearchedData(evaluation,{owner_id:OWNER,source_hashes:sources,entries:[good({kind})]}));
  // Both known kinds are readable.
  assert.equal(overlapsSearchedData(evaluation,{owner_id:OWNER,source_hashes:sources,entries:[good({kind:'EVALUATION_RUN'})]}),null);
  // N12b: any source hash that is not text (or empty) makes the participant source list unreadable.
  for(const bad of [5,null,undefined,'',{},['x']])
    unreadable(overlapsSearchedData(evaluation,{owner_id:OWNER,source_hashes:[sha('src1'),bad],entries:[good()]}));
  unreadable(overlapsSearchedData(evaluation,{owner_id:OWNER,source_hashes:[],entries:[good()]}));
  unreadable(overlapsSearchedData(evaluation,{owner_id:'',source_hashes:sources,entries:[good()]}));
  // At registration the same input refuses the whole registration.
  const badKind=register(3,{},{searched_windows:[good({kind:'OTHER'})]});
  assert.deepEqual([badKind.ok,badKind.code,badKind.detail],[false,'QR4_EXPOSURE_REGISTRY_UNAVAILABLE','SEARCHED_WINDOWS_UNREADABLE']);
  // In a recheck an unknown kind blocks the step and does not end the selection.
  const blocked=recheckWindow({registration:reg,exposure_register:[],searched_windows:[good({kind:'OTHER'})],stage:'OUTCOME_WRITE'});
  assert.deepEqual([blocked.ok,blocked.ends_selection,blocked.detail],[false,false,'SEARCHED_WINDOWS_UNREADABLE']);
});

test('round 2 survivors N6 and N10c: a customer package in a fixture selection fails E2 with NOT_FIXTURE; a missing requester is REQUESTER_UNREADABLE',()=>{
  const FX={...CTX,fixture:true};
  const customer=evaluateEligibility(member(1),FX);
  assert.equal(customer.eligible,false);
  assert.deepEqual([customer.checks.E2,customer.checks.E6],['FAIL','FAIL']);
  assert.deepEqual(customer.failures.filter(item=>item.check==='E2').map(item=>[item.code,item.detail]),[['QR4_PARTICIPANT_NOT_READY','NOT_FIXTURE']]);
  assert.deepEqual(customer.failures.filter(item=>item.check==='E6').map(item=>[item.code,item.detail]),[['QR4_FIXTURE_PARTICIPANT','NOT_FIXTURE_IN_FIXTURE_SELECTION']]);
  // The fixture member passes the same E2 predicate.
  assert.equal(evaluateEligibility({...member(1),...fixtureOver(1)},FX).checks.E2,'PASS');
  // N10c: no requester is a named failure, never a silent read.
  for(const requester of [undefined,null,'',5]){
    for(const fixture of [false,true]){
      const m=fixture?{...member(1),...fixtureOver(1)}:member(1);
      const out=evaluateEligibility(m,{...CTX,fixture,requester_owner_id:requester});
      assert.equal(out.eligible,false);
      assert.deepEqual(out.failures.filter(item=>item.check==='E2').map(item=>[item.code,item.detail]),[['QR4_PARTICIPANT_NOT_READY','REQUESTER_UNREADABLE']],String(requester)+fixture);
    }
  }
});


// Open items that are not decisions of this slice. The contract questions that root decides are in the fix notes under .qa-local, not here.
test.todo('QR-4 OD-S3 (OWNER): the owner sets the tie tolerance values in the objective registry (example 0.5 pp return, 0.5 pp drawdown, not decided). Until then the product registry holds null and every registration is refused.');
test.todo('QR-4 4.1 E3 (DEFERRED SLICE): pin the name of the validated_at_utc field to the QL4 5.5 record schema when the G8 source lands.');
