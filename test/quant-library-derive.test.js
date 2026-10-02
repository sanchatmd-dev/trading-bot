import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {LIBRARY_CLASSES,LIBRARY_GROUPS,COMPATIBILITY_FIELDS,GATE_NAMES,classify,candidateAggregates,developmentScore,compatibilityFields,compatibilityKey,
  compatibilityMismatches,holdoutWindow,windowsOverlap,marketKey,qualification,contractHashVerified,resultSha256,stepsDigest,reportMatchesCheckpoints,
  metrics,candidateView,selectedView,holdoutTooFewTrades,selectedReasons,QUALIFIED_TOTAL,QUALIFIED_WINNER} from '../src/quant-library/derive.js';
import {contractOf,outcomeOf,runOf,hex,metricsOf,parameters,MINUTE,T0,FIXTURE_LABEL} from './helpers/quant-library-fixture.mjs';

// Every run below is a LABELLED FIXTURE (see test/helpers/quant-library-fixture.mjs). None is a research result.
const OWNER='owner-a',IMPORT='import-1',DEPLOY='deploy-1';
const base={owner:OWNER,deployment:DEPLOY,importId:IMPORT};
const clone=value=>JSON.parse(JSON.stringify(value));

test('the fixtures are labelled and every class maps to exactly one group',()=>{
  assert.match(FIXTURE_LABEL,/LABELLED TEST FIXTURE/);
  assert.deepEqual(Object.keys(LIBRARY_CLASSES).sort(),['CANCELLED','CANDIDATE_PENDING_ACCEPTANCE','FAILED','INSUFFICIENT_DATA','INSUFFICIENT_EVIDENCE','IN_PROGRESS','NO_VALID_CANDIDATE','TIMED_OUT']);
  assert.deepEqual([...LIBRARY_GROUPS],['ACTIVE','COMPLETED','INSUFFICIENT','FAILED','CANCELLED']);
  for(const group of Object.values(LIBRARY_CLASSES))assert.ok(LIBRARY_GROUPS.includes(group));
  assert.equal(QUALIFIED_TOTAL,0);assert.equal(QUALIFIED_WINNER,null);
});

test('classification: all eight classes, first match wins, raw diagnostic decides the data class',()=>{
  const cases=[
    [{status:'QUEUED'},'IN_PROGRESS','ACTIVE'],[{status:'RUNNING',diagnostic:'RECOVERING_FROM_CHECKPOINT'},'IN_PROGRESS','ACTIVE'],
    [{status:'CANCELLED'},'CANCELLED','CANCELLED'],[{status:'TIMED_OUT',diagnostic:'JOB_DEADLINE_EXCEEDED'},'TIMED_OUT','FAILED'],
    [{status:'FAILED',diagnostic:'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET'},'INSUFFICIENT_DATA','INSUFFICIENT'],
    [{status:'FAILED',diagnostic:'VERIFIED_MARKET_DATA_REQUIRED'},'INSUFFICIENT_DATA','INSUFFICIENT'],
    [{status:'FAILED',diagnostic:'MARKET_METADATA_MISMATCH'},'INSUFFICIENT_DATA','INSUFFICIENT'],
    [{status:'FAILED',diagnostic:'QUANT_ENGINE_CHANGED'},'FAILED','FAILED'],[{status:'FAILED',diagnostic:null},'FAILED','FAILED'],[{status:'FAILED'},'FAILED','FAILED'],
    [{status:'SUCCEEDED'},'CANDIDATE_PENDING_ACCEPTANCE','COMPLETED'],[{status:'SUCCEEDED',holdoutTooFewTrades:true},'CANDIDATE_PENDING_ACCEPTANCE','COMPLETED'],
    [{status:'NO_VALID_CANDIDATE'},'NO_VALID_CANDIDATE','COMPLETED'],[{status:'NO_VALID_CANDIDATE',holdoutTooFewTrades:false},'NO_VALID_CANDIDATE','COMPLETED'],
    [{status:'NO_VALID_CANDIDATE',holdoutTooFewTrades:true},'INSUFFICIENT_EVIDENCE','INSUFFICIENT'],
    [{status:'NO_VALID_CANDIDATE',diagnostic:'VERIFIED_MARKET_DATA_REQUIRED'},'NO_VALID_CANDIDATE','COMPLETED'],
    [{status:'QUEUED',diagnostic:'VERIFIED_MARKET_DATA_REQUIRED'},'IN_PROGRESS','ACTIVE'],
    [{status:'SOMETHING_NEW'},'FAILED','FAILED'],[{},'FAILED','FAILED']];
  for(const [input,cls,group] of cases)assert.deepEqual(classify(input),{library_class:cls,library_group:group},JSON.stringify(input));
  assert.deepEqual(classify(),{library_class:'FAILED',library_group:'FAILED'});
});

test('root decision 1: the historical shape (no selection, every candidate short of validation trades) is NO_VALID_CANDIDATE in COMPLETED',()=>{
  const outcome=outcomeOf(contractOf({...base,candidates:100}),'NO_VALID');
  assert.equal(outcome.result.selected,null);
  assert.equal(outcome.result.candidates.length,100);
  assert.ok(outcome.result.candidates.every(item=>item.screen_reasons.join()==='INSUFFICIENT_VALIDATION_TRADES'));
  assert.deepEqual(classify({status:outcome.status,diagnostic:null,holdoutTooFewTrades:holdoutTooFewTrades(outcome.result)}),{library_class:'NO_VALID_CANDIDATE',library_group:'COMPLETED'});
  assert.deepEqual(candidateAggregates(outcome.result.candidates),{candidate_count:100,screen_passed:0,reason_counts:{INSUFFICIENT_VALIDATION_TRADES:100}});
  for(const [scenario,expected] of [['PENDING',['SUCCEEDED','CANDIDATE_PENDING_ACCEPTANCE']],['ROBUSTNESS',['NO_VALID_CANDIDATE','NO_VALID_CANDIDATE']],
    ['HOLDOUT_FEW',['NO_VALID_CANDIDATE','INSUFFICIENT_EVIDENCE']],['HOLDOUT_NEGATIVE',['NO_VALID_CANDIDATE','NO_VALID_CANDIDATE']]]){
    const done=outcomeOf(contractOf(base),scenario);
    assert.equal(done.status,expected[0],scenario);
    assert.equal(classify({status:done.status,holdoutTooFewTrades:holdoutTooFewTrades(done.result)}).library_class,expected[1],scenario);
  }
  assert.deepEqual(selectedReasons(outcomeOf(contractOf(base),'HOLDOUT_FEW').result),['INSUFFICIENT_TEST_TRADES']);
  assert.deepEqual(selectedReasons({selected:{screen_reasons:'INSUFFICIENT_TEST_TRADES'}}),[],'a reason list must be an array');
  assert.equal(holdoutTooFewTrades(null),false);assert.equal(holdoutTooFewTrades({selected:null}),false);
});

test('candidate aggregates count only well-formed reason lists and tolerate malformed rows',()=>{
  assert.deepEqual(candidateAggregates(undefined),{candidate_count:0,screen_passed:0,reason_counts:{}});
  assert.deepEqual(candidateAggregates([]),{candidate_count:0,screen_passed:0,reason_counts:{}});
  const mixed=[{screen_reasons:[]},{screen_reasons:['B','A']},{screen_reasons:['A']},{},null,'x',{screen_reasons:'A'},{screen_reasons:[7,'C']}];
  assert.deepEqual(candidateAggregates(mixed),{candidate_count:8,screen_passed:1,reason_counts:{A:2,B:1,C:1}});
  assert.deepEqual(Object.keys(candidateAggregates(mixed).reason_counts),['A','B','C'],'reason counts are sorted');
});

test('development score: the stored decimal string of the selected candidate, null with a reason otherwise, never zero',()=>{
  const pending=outcomeOf(contractOf(base),'PENDING',{bestReturn:'3.20'}).result;
  assert.deepEqual(developmentScore({status:'SUCCEEDED',result:pending}),{value:'3.20',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null},'trailing zero kept');
  assert.equal(developmentScore({status:'NO_VALID_CANDIDATE',result:outcomeOf(contractOf(base),'ROBUSTNESS').result}).value,'3.2','a selected candidate that failed later checks still has a development score');
  const none=reason=>({value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason});
  assert.deepEqual(developmentScore({status:'NO_VALID_CANDIDATE',result:outcomeOf(contractOf(base),'NO_VALID').result}),none('NO_SCREENED_CANDIDATE'));
  assert.deepEqual(developmentScore({status:'FAILED',result:null}),none('NOT_EVALUATED'));
  assert.deepEqual(developmentScore({status:'RUNNING',result:pending}),none('NOT_EVALUATED'));
  assert.deepEqual(developmentScore({status:'SUCCEEDED',result:null}),none('NO_RESULT'));
  assert.deepEqual(developmentScore({status:'SUCCEEDED',result:pending,integrityFailed:true}),none('INTEGRITY_CHECK_FAILED'));
  assert.deepEqual(developmentScore({status:'SUCCEEDED',result:{selected:{result:{validation:{}}}}}),none('SCORE_NOT_RECORDED'));
  assert.equal(developmentScore({status:'SUCCEEDED',result:{selected:{result:{validation:{net_return_percent:1.5}}}}}).value,'1.5','a stored JSON number becomes its text');
  assert.equal(developmentScore({status:'SUCCEEDED',result:{selected:{result:{validation:{net_return_percent:''}}}}}).value,null);
  assert.equal(developmentScore().value,null);
  // A candidate that failed screening never supplies a score, although its validation return is the highest.
  const failed=clone(pending);failed.selected=null;failed.candidates[3].result.validation.net_return_percent='99';
  assert.equal(developmentScore({status:'NO_VALID_CANDIDATE',result:failed}).value,null);
});

test('views keep stored decimal strings, drop unknown keys and cap what they return',()=>{
  const raw={bars:10,closed_trades:3,net_return_percent:'0.10',max_drawdown_percent:'0E+18',profit_factor:null,start_equity:'1000.00',secret:'LEAK',extra:{x:1}};
  assert.deepEqual(metrics(raw),{bars:10,closed_trades:3,start_equity:'1000.00',net_return_percent:'0.10',max_drawdown_percent:'0E+18',profit_factor:null});
  assert.equal(metrics(null),null);assert.equal(metrics([]),null);assert.deepEqual(metrics({}),{});
  const result=outcomeOf(contractOf(base),'PENDING').result;
  const candidate=candidateView({...result.candidates[1],note:'LEAK'},1);
  assert.deepEqual(Object.keys(candidate),['index','parameters','train','validation','screen_reasons']);
  assert.deepEqual(candidate.parameters,parameters(1));
  const selected=selectedView(result.selected);
  assert.deepEqual(Object.keys(selected),['parameters','train','validation','screen_reasons','sensitivity','cost_stress','test']);
  assert.equal(selected.sensitivity.length,2);assert.equal(selected.test.closed_trades,9);assert.deepEqual(Object.keys(selected.cost_stress),['train','validation']);
  assert.equal(selectedView(null),null);
  assert.ok(!JSON.stringify([candidate,selected]).includes('LEAK'));
});

test('compatibility: runs with the same context share one key; the search configuration, the Bot and the deployment may differ',()=>{
  const a=compatibilityFields('run-a',contractOf({...base,seed:7,budget:6,candidates:6}));
  const b=compatibilityFields('run-b',contractOf({...base,bot:'bot-2',deployment:'deploy-2',seed:99,budget:9,candidates:9,domains:{atr_multiplier:[1,2],rr:[1,2],emaFastInput:[30,50]}}));
  assert.deepEqual(a.missing,[]);assert.deepEqual(Object.keys(a.fields),[...COMPATIBILITY_FIELDS]);assert.equal(COMPATIBILITY_FIELDS.length,13);
  assert.equal(compatibilityKey(a.fields),compatibilityKey(b.fields),'seed, budget, planned candidates, domain values, Bot and deployment are not hard fields');
  assert.deepEqual(compatibilityMismatches([{run_id:'a',fields:a.fields},{run_id:'b',fields:b.fields}]),[]);
  assert.match(compatibilityKey(a.fields),/^[a-f0-9]{64}$/);
  const other=compatibilityFields('run-c',contractOf({...base,tag:'other'}));
  assert.notEqual(compatibilityKey(other.fields),compatibilityKey(a.fields),'another dataset digest changes the key');
});

test('compatibility: each of the 13 hard fields alone makes two runs incomparable and is named in the mismatches',()=>{
  const reference=contractOf(base),ref=compatibilityFields('ref',reference);
  const variants={
    scope:c=>{c.scope='OTHER_SCOPE';},market:c=>{c.snapshot.market.symbol='ETHUSDT';},data_model:c=>{c.model.price_tick=0.1;},
    dataset:c=>{c.dataset.sha256=hex('another-dataset');},split:c=>{c.split.train_end+=1;},engine:c=>{c.engine_hash=hex('another-engine');},
    source:c=>{c.source_hash=hex('another-source');},fixed_strategy:c=>{c.input_lock.selection.fixed_inputs[0].effective_value=false;},
    dimension_set:c=>{delete c.input_lock.domains.emaFastInput;},cost_model:c=>{c.model.fee_bps=11;},capital:c=>{c.capital.cash='999';},
    policy:c=>{c.snapshot.policy_hash=hex('another-policy');},validation_protocol:c=>{c.rules.minimum_closed_trades_test=6;}};
  assert.deepEqual(Object.keys(variants),[...COMPATIBILITY_FIELDS]);
  for(const [field,change] of Object.entries(variants)){
    const changed=clone(reference);change(changed);
    const fields=compatibilityFields('other',changed);
    assert.notEqual(compatibilityKey(fields.fields),compatibilityKey(ref.fields),field);
    const mismatches=compatibilityMismatches([{run_id:'ref',fields:ref.fields},{run_id:'other',fields:fields.fields}]);
    assert.deepEqual(mismatches.map(item=>item.field),[field],field);
    assert.deepEqual(mismatches[0].values.map(item=>item.run_id),['ref','other']);
    assert.ok(mismatches[0].values.every(item=>typeof item.value==='string'&&item.value.length<=300));
  }
});

test('compatibility: a field that cannot be read is unique to its run, so a malformed run is never comparable',()=>{
  const good=compatibilityFields('good',contractOf(base));
  const empty=compatibilityFields('x1',{}),again=compatibilityFields('x2',{});
  assert.deepEqual(empty.missing,[...COMPATIBILITY_FIELDS]);
  assert.deepEqual(Object.values(empty.fields),COMPATIBILITY_FIELDS.map(()=>'MISSING:x1'));
  assert.notEqual(compatibilityKey(empty.fields),compatibilityKey(again.fields),'two malformed runs never share a key');
  assert.equal(compatibilityMismatches([{run_id:'x1',fields:empty.fields},{run_id:'x2',fields:again.fields}]).length,13);
  for(const bad of [null,undefined,'text',7,[]])assert.equal(compatibilityFields('r',bad).missing.length,13,String(bad));
  // One unreadable part names exactly that field.
  const partial=contractOf(base);delete partial.model.price_tick;delete partial.capital.cash;partial.rules='x';
  assert.deepEqual(compatibilityFields('p',partial).missing,['data_model','capital','validation_protocol']);
  assert.notEqual(compatibilityFields('p',partial).fields.capital,good.fields.capital);
  // Null counts as unreadable too, and a numeric string differs from the number.
  const nulled=contractOf(base);nulled.engine_hash=null;assert.deepEqual(compatibilityFields('n',nulled).missing,['engine']);
  const typed=contractOf(base);typed.model.price_tick='0.01';assert.notEqual(canonical(compatibilityFields('t',typed).fields.data_model),canonical(good.fields.data_model));
});

test('compatibility: FOUNDATION (v2) and legacy (v1) runs of the same market are never comparable; the slim list projection yields the same fields',()=>{
  const v1=contractOf(base),v2=contractOf({...base,version:'v2',tag:'a'});
  const f1=compatibilityFields('v1',v1),f2=compatibilityFields('v2',v2);
  assert.equal(f1.fields.dataset.digest_kind,'ql3a-dataset-sha256-v1');assert.equal(f2.fields.dataset.digest_kind,'pine-bar-content-digest-v1');
  const names=compatibilityMismatches([{run_id:'v1',fields:f1.fields},{run_id:'v2',fields:f2.fields}]).map(item=>item.field);
  assert.ok(names.includes('dataset')&&names.includes('engine'),names.join());
  // The list reads a slim copy: no source, no bars, no candidate plan, domain values replaced by markers.
  const slim=clone(v1);delete slim.source;delete slim.dataset.bars;delete slim.plan.candidates;
  slim.input_lock.domains=Object.fromEntries(Object.keys(slim.input_lock.domains).map(key=>[key,true]));
  slim.snapshot={market:slim.snapshot.market,policy_hash:slim.snapshot.policy_hash};
  assert.deepEqual(compatibilityFields('v1',slim),f1);
});

test('holdout window: the bar times of the last split; the windows of a v1 and a v2 run on the same bars overlap',()=>{
  const v1=contractOf({...base,total:1000,warmup:300}),v2=contractOf({...base,version:'v2',total:1000,warmup:300});
  const window=holdoutWindow(v1);
  assert.deepEqual(window,{start_time:T0+v1.split.validation_end*MINUTE,end_time:T0+999*MINUTE});
  assert.deepEqual(holdoutWindow(v2),window,'the same bars give the same window in either contract version');
  assert.equal(windowsOverlap(holdoutWindow(v1),holdoutWindow(v2)),true);
  const later=contractOf({...base,start:T0+2000*MINUTE});
  assert.equal(windowsOverlap(window,holdoutWindow(later)),false,'a later dataset is independent');
  const shifted={...window,start_time:window.end_time};
  assert.equal(windowsOverlap(window,shifted),true,'one shared bar is an overlap');
  assert.equal(windowsOverlap(window,{start_time:window.end_time+MINUTE,end_time:window.end_time+5*MINUTE}),false);
  for(const bad of [null,{},{dataset:{start_time:1},split:{validation_end:5,test_end:5}},{dataset:{start_time:'1'},split:{validation_end:1,test_end:5}},{dataset:{start_time:1},split:{validation_end:-1,test_end:5}}])assert.equal(holdoutWindow(bad),null);
  assert.equal(windowsOverlap(null,window),false);assert.equal(windowsOverlap(window,null),false);
  assert.equal(marketKey(v1),canonical({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'}));assert.equal(marketKey({}),null);assert.equal(marketKey(null),null);
});

const passing=(overrides={})=>{
  const result=outcomeOf(contractOf(base),'PENDING').result;
  return {status:'SUCCEEDED',result,blockers:[],integrity:{contract_hash_verified:true,report_matches_checkpoints:true},holdoutOverlap:{overlaps:false},...overrides};
};
const states=q=>q.gates.map(gate=>gate.state).join(' ');

test('qualification: the eight gates in order with fixed names and reason codes',()=>{
  const q=qualification(passing());
  assert.deepEqual(q.gates.map(gate=>gate.gate),['G1','G2','G3','G4','G5','G6','G7','G8']);
  assert.deepEqual(q.gates.map(gate=>gate.name),[...GATE_NAMES]);
  assert.equal(GATE_NAMES.length,8);assert.equal(q.version,'library-qualification-v1');
  // Every gate except G7 and G8 passes in this fixture (G7 needs owner_recommendation_ready).
  assert.equal(states(q),'PASS PASS PASS PASS PASS PASS FAIL FAIL');
  assert.deepEqual(q.gates.map(gate=>gate.code),[null,null,null,null,null,null,'OWNER_RECOMMENDATION_NOT_READY','QL4C_VALIDATION_NOT_AVAILABLE']);
  assert.equal(q.qualified,false);assert.equal(q.label,'DEVELOPMENT_ONLY');
});

test('qualification: a fixture that passes G1 to G7 is still not qualified, because G8 has no source',()=>{
  const ready=passing();ready.result={...ready.result,owner_recommendation_ready:true};
  const q=qualification(ready);
  assert.equal(states(q),'PASS PASS PASS PASS PASS PASS PASS FAIL');
  assert.equal(q.gates[7].code,'QL4C_VALIDATION_NOT_AVAILABLE');
  assert.equal(q.qualified,false);assert.notEqual(q.label,'QUALIFIED');assert.equal(q.label,'DEVELOPMENT_ONLY');
  // No input changes G8.
  for(const extra of [{status:'SUCCEEDED'},{blockers:[]},{holdoutOverlap:{overlaps:false}},{integrity:null}])assert.equal(qualification({...ready,...extra}).gates[7].state,'FAIL');
});

test('qualification: G1 to G5 stop at the first failure and later gates are NOT_REACHED; G6 to G8 are always evaluated',()=>{
  const skip='NOT_REACHED NOT_REACHED NOT_REACHED NOT_REACHED';
  const cases=[
    ['status not completed',{status:'FAILED',result:null},'FAIL '+skip+' PASS FAIL FAIL','STATUS_NOT_COMPLETED','NOT_EVALUATED'],
    ['running',{status:'RUNNING',result:null},'FAIL '+skip+' PASS FAIL FAIL','STATUS_NOT_COMPLETED','NOT_EVALUATED'],
    ['no result',{result:null},'FAIL '+skip+' PASS FAIL FAIL','NO_RESULT','NOT_EVALUATED'],
    ['hash mismatch',{integrity:{contract_hash_verified:false,report_matches_checkpoints:true}},'FAIL '+skip+' PASS FAIL FAIL','INTEGRITY_CHECK_FAILED','NOT_EVALUATED'],
    ['checkpoint mismatch',{integrity:{contract_hash_verified:true,report_matches_checkpoints:false}},'FAIL '+skip+' PASS FAIL FAIL','INTEGRITY_CHECK_FAILED','NOT_EVALUATED'],
    ['checkpoint check absent',{integrity:{contract_hash_verified:true,report_matches_checkpoints:null}},'FAIL '+skip+' PASS FAIL FAIL','INTEGRITY_CHECK_FAILED','NOT_EVALUATED'],
    ['no screened candidate',{status:'NO_VALID_CANDIDATE',result:outcomeOf(contractOf(base),'NO_VALID').result},'PASS FAIL NOT_REACHED NOT_REACHED NOT_REACHED PASS FAIL FAIL','NO_SCREENED_CANDIDATE','NO_SCREENED_CANDIDATE'],
    ['cost stress failed',{status:'NO_VALID_CANDIDATE',result:outcomeOf(contractOf(base),'ROBUSTNESS').result},'PASS PASS FAIL NOT_REACHED NOT_REACHED PASS FAIL FAIL','COST_STRESS_FAILED','DEVELOPMENT_ONLY'],
    ['holdout too few trades',{status:'NO_VALID_CANDIDATE',result:outcomeOf(contractOf(base),'HOLDOUT_FEW').result},'PASS PASS PASS FAIL NOT_REACHED PASS FAIL FAIL','INSUFFICIENT_TEST_TRADES','DEVELOPMENT_ONLY'],
    ['negative holdout',{status:'NO_VALID_CANDIDATE',result:outcomeOf(contractOf(base),'HOLDOUT_NEGATIVE').result},'PASS PASS PASS FAIL NOT_REACHED PASS FAIL FAIL','NEGATIVE_HOLDOUT_RETURN','DEVELOPMENT_ONLY'],
    ['holdout reused',{holdoutOverlap:{overlaps:true}},'PASS PASS PASS PASS FAIL PASS FAIL FAIL','HOLDOUT_WINDOW_REUSED','DEVELOPMENT_ONLY'],
    ['independence not checked',{holdoutOverlap:null},'PASS PASS PASS PASS FAIL PASS FAIL FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED','DEVELOPMENT_ONLY'],
    ['blockers present',{blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED']},'PASS PASS PASS PASS PASS FAIL FAIL FAIL','ACCEPTANCE_BLOCKERS_PRESENT','DEVELOPMENT_ONLY'],
    ['blockers unknown',{blockers:null},'PASS PASS PASS PASS PASS FAIL FAIL FAIL','BLOCKERS_UNKNOWN','DEVELOPMENT_ONLY']];
  for(const [name,change,expected,code,label] of cases){
    const q=qualification(passing(change));
    assert.equal(states(q),expected,name);
    assert.ok(q.gates.some(gate=>gate.code&&gate.code.includes(code)),name+': '+code);
    assert.equal(q.label,label,name);assert.equal(q.qualified,false,name);
  }
  const holdoutOff=passing();holdoutOff.result={...holdoutOff.result,holdout_evaluated:false};
  assert.equal(qualification(holdoutOff).gates[3].code,'HOLDOUT_NOT_EVALUATED');
  const both=outcomeOf(contractOf(base),'ROBUSTNESS').result;both.selected.screen_reasons=['SENSITIVITY_FAILED','COST_STRESS_FAILED'];
  assert.equal(qualification(passing({status:'NO_VALID_CANDIDATE',result:both})).gates[2].code,'SENSITIVITY_FAILED,COST_STRESS_FAILED');
  assert.equal(qualification({}).gates.length,8);assert.equal(qualification().qualified,false);
});

test('qualification: the list reads no integrity and no earlier run, and still never qualifies',()=>{
  const q=qualification({status:'SUCCEEDED',result:passing().result,blockers:[]});
  assert.equal(states(q),'PASS PASS PASS PASS FAIL PASS FAIL FAIL');
  assert.equal(q.gates[4].code,'HOLDOUT_INDEPENDENCE_NOT_CHECKED');assert.equal(q.label,'DEVELOPMENT_ONLY');
});

test('integrity: contract hash, result digest and checkpoint digest are deterministic and sensitive to every edit',()=>{
  const run=runOf({...base,scenario:'PENDING'});
  assert.equal(contractHashVerified(run.contract,run.contract_hash),true);
  const edited=clone(run.contract);edited.capital.cash='1001';
  assert.equal(contractHashVerified(edited,run.contract_hash),false);
  assert.equal(contractHashVerified(run.contract,null),false);assert.equal(contractHashVerified(run.contract,'x'),false);
  assert.equal(resultSha256(null),null);assert.equal(resultSha256(undefined),null);
  assert.equal(resultSha256(run.result),hash(canonical(run.result)));
  const reversed=[...run.steps].reverse();
  assert.deepEqual(stepsDigest(reversed),stepsDigest(run.steps),'the digest is taken in step id order, whatever the read order');
  const digest=stepsDigest(run.steps);
  assert.equal(digest.steps_count,run.steps.length);assert.match(digest.steps_digest,/^[a-f0-9]{64}$/);
  assert.deepEqual(stepsDigest([]).steps_count,0);
  for(const [name,change] of Object.entries({
    kind:steps=>{steps[0].kind='SENSITIVITY';},completed:steps=>{steps[0].completed_at+=1;},parameters:steps=>{steps[1].parameters.rr=9;},
    result:steps=>{steps[2].result.validation.net_return_percent='9';},extra:steps=>{steps.push({step_id:'candidate:999',kind:'CANDIDATE',parameters:{},result:{},completed_at:1});},
    removed:steps=>{steps.pop();}})){
    const steps=clone(run.steps);change(steps);
    assert.notEqual(stepsDigest(steps).steps_digest,digest.steps_digest,name);
  }
});

test('integrity: every fixture report matches its checkpoints, and a missing report is not a mismatch',()=>{
  for(const scenario of ['NO_VALID','PENDING','ROBUSTNESS','HOLDOUT_FEW','HOLDOUT_NEGATIVE']){
    const {result,steps}=runOf({...base,scenario,candidates:scenario==='NO_VALID'?20:6});
    assert.deepEqual(reportMatchesCheckpoints(result,steps),{ok:true,problems:[]},scenario);
  }
  for(const result of [null,undefined,'x',[]])assert.deepEqual(reportMatchesCheckpoints(result,[]),{ok:null,problems:[]});
  const pending=runOf({...base,scenario:'PENDING'});
  assert.equal(pending.steps.filter(step=>step.kind==='SENSITIVITY').length,1,'one sensitivity check has its own checkpoint, the other reuses a candidate');
  assert.equal(pending.result.selected.sensitivity.length,2);
});

test('integrity: an edited report, an edited checkpoint set or a flipped holdout flag is named by its problem code',()=>{
  const fresh=scenario=>{const run=runOf({...base,scenario});return {result:clone(run.result),steps:clone(run.steps)};};
  const check=(scenario,change,code)=>{
    const {result,steps}=fresh(scenario);change(result,steps);
    const answer=reportMatchesCheckpoints(result,steps);
    assert.equal(answer.ok,false,code);assert.ok(answer.problems.includes(code),code+' in '+answer.problems.join());
  };
  check('PENDING',result=>{result.candidates[3].result.validation.net_return_percent='50';},'CANDIDATE_MISMATCH');
  check('PENDING',result=>{result.candidates[0].parameters.rr=9;},'CANDIDATE_MISMATCH');
  check('PENDING',result=>{result.candidates.pop();},'CANDIDATE_COUNT_MISMATCH');
  check('PENDING',result=>{result.candidate_count=99;},'CANDIDATE_COUNT_MISMATCH');
  check('PENDING',result=>{delete result.candidates;},'CANDIDATES_MISSING');
  check('PENDING',result=>{result.selected.result.validation.net_return_percent='99';},'SELECTED_MISMATCH');
  check('PENDING',result=>{result.selected.cost_stress.validation.net_return_percent='99';},'STRESS_MISMATCH');
  check('PENDING',result=>{delete result.selected.cost_stress;},'STRESS_MISMATCH');
  check('PENDING',result=>{result.selected.sensitivity[1].result.validation.net_return_percent='99';},'SENSITIVITY_MISMATCH');
  check('PENDING',result=>{result.selected.sensitivity[0].result.validation.net_return_percent='99';},'SENSITIVITY_MISMATCH');
  check('PENDING',result=>{result.selected.test.net_return_percent='99';},'HOLDOUT_MISMATCH');
  check('PENDING',result=>{result.holdout_evaluated=false;},'HOLDOUT_MISMATCH');
  check('NO_VALID',result=>{result.holdout_evaluated=true;},'HOLDOUT_MISMATCH');
  check('PENDING',(result,steps)=>{steps.splice(steps.findIndex(step=>step.step_id==='holdout:selected'),1);},'HOLDOUT_MISMATCH');
  check('PENDING',(result,steps)=>{steps.splice(steps.findIndex(step=>step.step_id==='stress:selected'),1);},'STRESS_MISMATCH');
  check('PENDING',(result,steps)=>{steps.push({step_id:'sensitivity:extra:1',kind:'SENSITIVITY',parameters:{a:1},result:{},completed_at:1});},'UNREFERENCED_STEP');
  check('NO_VALID',(result,steps)=>{steps.push({step_id:'holdout:selected',kind:'HOLDOUT',parameters:{},result:{},completed_at:1});},'HOLDOUT_MISMATCH');
  check('NO_VALID',(result,steps)=>{steps.splice(5,1);},'CANDIDATE_MISMATCH');
  check('ROBUSTNESS',result=>{result.selected=null;},'UNREFERENCED_STEP');
  check('PENDING',result=>{result.selected={...result.selected,parameters:{...result.selected.parameters,rr:9}};},'SELECTED_MISMATCH');
});

test('derive.js is a pure module: it imports only the hash helpers and touches no clock, file or database',()=>{
  const source=fs.readFileSync(new URL('../src/quant-library/derive.js',import.meta.url),'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match=>match[1]),['../pine-bridge/source.js']);
  for(const banned of ['Date.now','new Date','Math.random','process.','fs.','await ','fetch(','.query(','require(','localStorage'])assert.ok(!source.includes(banned),'forbidden in derive.js: '+banned);
});

// The pattern is written with ~ for the backslash and ~x27 for the apostrophe.
const IMPORTS=new RegExp('(?:~bfrom~s*|~bimport~s*~(~s*|~bimport~s*)["~x27](~.[^"~x27]+)["~x27]'.split('~').join(String.fromCharCode(92)),'g');

test('the library modules are outside every engine hash and outside the reviewed import closure, so the engine hashes cannot change with them',async()=>{
  const {FOUNDATION_ENGINE_FILES,LEGACY_ENGINE_FILES}=await import('../src/postgres/quant-research.js');
  const {INGESTION_ENGINE_FILES}=await import('../src/postgres/quant-data.js');
  const {PF2_ENGINE_FILES}=await import('../src/quant-research/preflight-resolver.js');
  const {QUANT_RUNTIME_ENGINE_FILES}=await import('../src/quant-research/runtime-engine-files.js');
  const mine=['src/quant-library/derive.js','src/postgres/quant-library.js','src/postgres/server.js'];
  for(const files of [LEGACY_ENGINE_FILES,FOUNDATION_ENGINE_FILES,INGESTION_ENGINE_FILES,PF2_ENGINE_FILES,QUANT_RUNTIME_ENGINE_FILES])for(const file of mine)assert.ok(!files.includes(file),file+' is in an engine file list');
  // The same closure the engine-files test walks from the worker and API roots.
  const roots=['src/postgres/quant-research-main.js','src/quant-research/io-profile-worker.js','src/postgres/quant-preflight-wiring.js','src/postgres/quant-preflight-routes.js'];
  const visited=new Set();
  const visit=file=>{
    if(visited.has(file))return;visited.add(file);
    const text=fs.readFileSync(file,'utf8');
    for(const match of text.matchAll(IMPORTS)){const parts=file.split('/').slice(0,-1);for(const part of match[1].split('/')){if(part==='..')parts.pop();else if(part!=='.')parts.push(part);}visit(parts.join('/'));}
  };
  for(const root of roots)visit(root);
  assert.ok(visited.size>30,'the closure was walked: '+visited.size);
  for(const file of mine)assert.ok(!visited.has(file),file+' is reachable from an engine root');
});
