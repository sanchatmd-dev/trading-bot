import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Money} from '../src/money.js';
import {buildRegistration,rankSelection,OBJECTIVE_REGISTRY,QR4_VERSIONS,digest} from '../src/selection/index.js';
import {selectionEvaluationOf,TERMINAL_RUN_STATUSES,VALUATION_LIMITATION,EVALUATION_ADAPTER_VERSION,refusedEvaluation,ENDING_REFUSAL_CODES} from '../src/selection-eval/evaluation-adapter.js';
import {evaluationRecordBody,benchmarkRecordBody} from '../src/comparison/evaluation-record.js';
import {buyAndHold} from '../src/comparison/valuation.js';
import {validateSpec,specHashOf} from '../src/comparison/ranking.js';
import {FIXED_EVAL_VERSIONS,FIXED_EVAL_PURPOSES,validateFixedEvalContract,validateFixedEvalResult} from '../src/quant-research/fixed-eval-contract.js';
import {qr4FixedRunWorld} from './helpers/quant-fixed-eval-fixture.mjs';

/*
 * QR-4 slice Q4-A, the pure adapter (src/selection-eval/evaluation-adapter.js), test plan 16.1 items 4, 11 and 20 on the adapter. Every run, price and number below is a
 * LABELLED TEST FIXTURE, never a research result. The fixed-eval-result-v1 values are built through the real builders, so the real validators accept them. The
 * evaluator figures come from an independent Money ledger of the fixture helper, and the base case is also derived by hand (see HAND below). No database is used.
 */
const MS=60000,DAY=86400000,T0=Date.UTC(2026,9,20,0,0,0);
const sha=text=>createHash('sha256').update(text).digest('hex');
const ENGINE=sha('qr4-adapter-engine'),POLICY=sha('policy'),DATASET=sha('qr4-adapter-window-dataset');
const OWNER='owner-a',OBJECTIVE_ID='qr4-objective-lexi-v1',MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const REAL={validateFixedEvalContract,validateFixedEvalResult};
const clone=value=>structuredClone(value);
const TEST_REGISTRY=(()=>{const registry=clone(OBJECTIVE_REGISTRY);registry[OBJECTIVE_ID].tie_tolerances.return_pp='0.5';registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp='0.5';return registry;})();
const SCOPE={market:clone(MARKET),data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'10'},
  capital:{equity:'10000',cash:'10000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const RULES_OBJECT={maximum_drawdown_percent:'25',minimum_closed_trades_test:10};
const ref=value=>Array.isArray(value)?'['+value.map(ref).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+ref(value[k])).join(',')+'}':JSON.stringify(value);
const RULES=sha(ref(RULES_OBJECT));
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
const range=(fromDays,toDays)=>({start_ms:T0-fromDays*DAY,end_ms:T0-toDays*DAY});
function member(i){
  const run='run-'+i,exp='exp-'+i,pkgHash=sha('pkg'+i);
  const binding={mode:'ONE_PINE',fixture:false,pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i,membership:[{pine_import_id:'pi'+i,source_version:1,source_hash:'sh'+i}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:sha('lock'+i)};
  return {kind:'RESEARCH_RUN',owner_id:OWNER,run_id:run,export_id:exp,created_at_ms:T0-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:sha('src'+i),market:clone(MARKET),
    qualification:{version:'library-qualification-v2',qualified:true,label:'QUALIFIED',gates:GATES.map(gate=>({gate,name:'N_'+gate,state:'PASS',code:null}))},integrity_checked:true,
    package:{export_id:exp,package_hash:pkgHash,status:'EXPORT_VALIDATED',binding,current:{...clone(binding),dataset_available:true,bot_owner_id:OWNER},replay_mismatch:false},
    validation_records:[{run_id:run,mode:'ONE_PINE',record:{fixture:false,export_id:exp,package_hash:pkgHash,binding_hash:sha('bind'+i),validated_at_utc:'2026-10-18T10:00:00Z',
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:clone(SCOPE.data_model),cost_model:clone(SCOPE.cost_model),capital:clone(SCOPE.capital),policy:clone(SCOPE.policy),engine:ENGINE},library_class:'READY_FOR_REVIEW',
    rules_hash:RULES,rules:clone(RULES_OBJECT),data_windows:{dataset:range(40,10),train:range(40,32),validation:range(32,26),holdout:range(26,10)},registered_boundary_ms:null};
}
// Window W: 200 evaluated bars after a warm-up of 1006 bars (the warm-up floor of the fixed-evaluation contract), so 1206 bars in all.
const W={kind:'PROSPECTIVE',start_ms:T0+DAY,end_ms:T0+DAY+200*MS,warmup_bars:1006};
function registrationOf(n=3,over={}){
  const out=buildRegistration({owner_id:OWNER,selection_id:'sel-1',registered_at_ms:T0,confirmed:true,fixture:false,scope:clone(SCOPE),window:{...W},objective:{id:OBJECTIVE_ID},
    filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},admission_deadline_ms:W.end_ms+DAY,universe:Array.from({length:n},(_,k)=>member(k+1)),...over},
  {dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},exposure_register:[],searched_windows:[],universe_cap:20,requester_owner_id:OWNER,
    policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},prior_selection_ids:[],existing_registrations:[],objective_registry:TEST_REGISTRY,fixture_selections_allowed:true});
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.registration;
}
const REG=registrationOf();
assert.deepEqual(REG.window,{kind:'PROSPECTIVE',start_ms:W.start_ms,end_ms:W.end_ms,warmup_bars:1006,evaluation_bars:200,total_bars:1206});
const SIZES=['10','20','5'];
const world=(index,over={})=>qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-'+(index+1),window:REG.window,engine:ENGINE,datasetSha:DATASET,size:SIZES[index],...over});
const WORLDS=SIZES.map((_,index)=>world(index));
const inputOf=(index=0,over={},source=WORLDS)=>clone({registration:REG,evaluation_run_id:'ev-'+(index+1),fixed_contract:source[index].contract,binding:source[index].binding,fixed_result:source[index].result,
  rows:source[index].rows,run_status:'SUCCEEDED',...over});
const adapt=(index=0,over={},deps=REAL,source=WORLDS)=>selectionEvaluationOf(inputOf(index,over,source),deps);
const evaluationsOf=(source=WORLDS)=>source.map((_,index)=>{const out=adapt(index,{},REAL,source);assert.equal(out.ok,true,JSON.stringify(out));return out.evaluation;});
const FROZEN={window_dataset_hash:DATASET};
const refused=(out,code,detail)=>{assert.equal(out.ok,false,JSON.stringify(out).slice(0,300));assert.equal(out.code,code);assert.equal(out.detail,detail);return out;};
const integrity=(out,detail)=>refused(out,'INTEGRITY_CHECK_FAILED',detail);
const CODE_PATTERN=/^[A-Z][A-Z0-9_]{1,63}$/;
const seenCodes=new Set();
const note=out=>{if(out&&typeof out.code==='string')seenCodes.add(out.code);if(out&&Array.isArray(out.codes))out.codes.forEach(code=>seenCodes.add(code));return out;};
const round12=value=>new Money(value).toDecimalPlaces(12,Money.ROUND_HALF_EVEN).toFixed();

/*
 * HAND derivation of the size 10 run (6 trades, scored bar 2k closes 100 and 2k+1 closes 110): each trade buys 10 at 100.1 (notional 1001, fee 1.001, slippage 1) and sells
 * 10 at 109.9 (notional 1099, fee 1.099, slippage 1), net 1099 - 1001 - 1.001 - 1.099 = 95.9, so six trades give 575.4: end equity 10575.4, return 5.754 percent, fees 12.6,
 * slippage 12. In the market on the six buy bars of 200: 3 percent. The deepest drawdown is on the first buy bar: NAV 8997.999 + 10 * 100 = 9997.999 against 10000, 0.02001
 * percent. Under the stress cost (prices 100.2 and 109.8, fee 20 bps) a trade nets 1098 - 1002 - 2.004 - 2.196 = 91.8, six trades 550.8: return 5.508 percent.
 */
const HAND={net_return_percent:'5.754',max_drawdown_percent:'0.02001',fees:'12.6',slippage:'12',exposure_percent:'3',stress_net:'5.508'};

test('the happy path: a terminal run becomes the evaluation shape of rankSelection, with the hand-derived figures as exact decimal strings',()=>{
  const out=adapt(0);
  assert.equal(out.ok,true,JSON.stringify(out).slice(0,300));
  assert.deepEqual([out.code,out.detail],[null,null]);
  const ev=out.evaluation;
  assert.deepEqual(Object.keys(ev).sort(),['dataset_hash','engine_hash','integrity','mode','parent_run_id','result','result_hash','run_id','selection_id','status']);
  assert.deepEqual([ev.mode,ev.selection_id,ev.run_id,ev.parent_run_id,ev.status],['QR4_SELECTION_EVAL','sel-1','ev-1','run-1','SUCCEEDED']);
  assert.deepEqual(ev.integrity,{contract_hash_verified:true,report_matches_checkpoints:true});
  assert.deepEqual([ev.engine_hash,ev.dataset_hash],[ENGINE,DATASET]);
  assert.equal(ev.result_hash,digest(ev.result));
  assert.match(ev.result_hash,/^[0-9a-f]{64}$/);
  const r=ev.result;
  assert.deepEqual(r.metrics,{net_return_percent:HAND.net_return_percent,max_drawdown_percent:HAND.max_drawdown_percent,closed_trades:6});
  assert.deepEqual([r.fees,r.slippage,r.exposure_percent,r.episodes,r.rejected_intents,r.evaluation_bars],[HAND.fees,HAND.slippage,HAND.exposure_percent,6,2,200]);
  assert.equal(r.cost_stress.net_return_percent,HAND.stress_net);
  for(const value of [r.metrics.net_return_percent,r.metrics.max_drawdown_percent,r.fees,r.slippage,r.exposure_percent,r.cost_stress.net_return_percent,r.benchmark.net_return_percent])
    assert.equal(typeof value,'string','a figure is an exact decimal string, never a float');
  // the independent ledger of the fixture agrees with the hand figures (the fixture is not circular)
  assert.equal(WORLDS[0].base.returnPercent,HAND.net_return_percent);
  assert.equal(WORLDS[0].base.fees,HAND.fees);
  assert.equal(WORLDS[0].stress.returnPercent,HAND.stress_net);
  // the kept valuation figures are those of the base step and of the stress step (end equity 10575.4 and 10550.8 by the hand derivation above)
  assert.deepEqual([r.valuation.end_nav,r.valuation.net_return_percent_exact,r.valuation.bars],['10575.4','5.754',200]);
  assert.deepEqual([r.stress_valuation.end_nav,r.stress_valuation.net_return_percent_exact],['10550.8','5.508']);
  assert.equal(r.basis_confirmed,false);
  assert.deepEqual(r.limitations,[VALUATION_LIMITATION]);
  assert.equal(VALUATION_LIMITATION,'VALUATION_BASIS_UNCONFIRMED');
  assert.equal(r.adapter_version,EVALUATION_ADAPTER_VERSION);
  assert.equal(Object.isFrozen(ev)&&Object.isFrozen(ev.result)&&Object.isFrozen(ev.integrity),true);
});

test('Buy & Hold is computed on the same grid and the base cost: the figure is the QR-3 benchmark of the same rows',()=>{
  const ev=adapt(0).evaluation;
  const contract=WORLDS[0].contract,model=contract.cost_model,rows=WORLDS[0].rows;
  const grid=rows.slice(1006).map(row=>({time_ms:row.time-MS,close:row.close}));
  const direct=buyAndHold({initial_cash:contract.capital.initial_cash,period:{start_ms:REG.window.start_ms,end_ms:REG.window.end_ms},grid,
    data_model:{price_tick:model.price_tick,quantity_step:model.quantity_step},cost_model:{fee_bps:model.fee_bps,slippage_bps:model.slippage_bps},basis_confirmed:false,include_liquidation_line:false});
  assert.equal(direct.ok,true);
  assert.equal(ev.result.benchmark.net_return_percent,direct.net_return_percent);
  assert.equal(ev.result.benchmark.net_return_percent_exact,direct.net_return_percent_exact);
  // by hand: 99.8 units at 100.1 (tick rounded up), fee 9.98998, residual cash 0.03002, marked at the last close 110: 10978.03002 against 10000
  assert.equal(ev.result.benchmark.net_return_percent,'9.7803002');
  assert.equal(ev.result.benchmark.ok,true);
  assert.deepEqual(ev.result.limitations,[VALUATION_LIMITATION]);
});

test('the adapter and the QR-3 evaluation record give identical figures for one shared run (RR-Q4-5 agreement pin; closed trades = closed allocations)',()=>{
  const comparison=qr4FixedRunWorld({purpose:'QR3_COMPARISON',objectId:'cmp-1',parentRunId:'run-1',window:REG.window,engine:ENGINE,datasetSha:DATASET,size:SIZES[0]});
  const spec=validateSpec({mode:'STANDARDIZED',participants:['run-1','run-2'],period:{start_ms:REG.window.start_ms,end_ms:REG.window.end_ms},objective:'qr3-obj-net-return-v1',
    risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}});
  assert.equal(spec.ok,true,JSON.stringify(spec));
  const input={comparison_id:'cmp-1',spec_hash:specHashOf(spec.spec),spec:spec.spec,participant_id:'run-1',evaluation_run_id:'ev-1',fixed_contract:comparison.contract,binding:comparison.binding,
    fixed_result:comparison.result,rows:comparison.rows};
  const body=evaluationRecordBody(input,REAL);
  assert.equal(body.ok,true,JSON.stringify(body).slice(0,300));
  const bench=benchmarkRecordBody({comparison_id:'cmp-1',spec_hash:input.spec_hash,spec:spec.spec,fixed_contract:comparison.contract,rows:comparison.rows},REAL);
  assert.equal(bench.ok,true);
  const ev=adapt(0).evaluation.result,qr3=body.body;
  assert.equal(ev.metrics.net_return_percent,qr3.metrics.net_return_percent);
  assert.equal(ev.metrics.max_drawdown_percent,qr3.metrics.max_drawdown_percent);
  assert.equal(ev.fees,qr3.metrics.total_fees);
  assert.equal(ev.slippage,qr3.metrics.total_slippage.value);
  assert.equal(ev.exposure_percent,qr3.metrics.exposure_percent);
  assert.equal(ev.rejected_intents,qr3.metrics.rejected_intents);
  assert.equal(ev.episodes,qr3.completed_episodes);
  assert.equal(ev.metrics.closed_trades,qr3.closed_allocations,'closed trades are the closed allocations of the base step in both records');
  assert.equal(ev.cost_stress.net_return_percent,qr3.stress_valuation.net_return_percent);
  assert.equal(ev.benchmark.net_return_percent,bench.body.result.net_return_percent);
  assert.equal(ev.benchmark.net_return_percent_exact,bench.body.result.net_return_percent_exact);
  assert.deepEqual(qr3.limitations,ev.limitations);
  assert.equal(qr3.basis_confirmed,ev.basis_confirmed);
});

test('the evaluations rank: three distinct returns give BEST_IN_SCOPE in return order, and the outcome carries the adapter figures (test 4: exact decimals)',()=>{
  const list=evaluationsOf();
  const outcome=note(rankSelection(REG,list,FROZEN));
  assert.equal(outcome.status,'SELECTION_COMPLETED',JSON.stringify(outcome).slice(0,400));
  assert.equal(outcome.outcome,'BEST_IN_SCOPE');
  assert.deepEqual(outcome.ranking.map(item=>[item.rank,item.export_id]),[[1,'exp-2'],[2,'exp-1'],[3,'exp-3']]);
  const values=Object.fromEntries(outcome.evaluations.map(item=>[item.export_id,item.values]));
  for(const [index,id] of ['exp-1','exp-2','exp-3'].entries()){
    const w=WORLDS[index],v=values[id];
    assert.equal(v.net_return_percent,round12(w.base.returnPercent).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''));
    assert.equal(v.fees,w.base.fees);
    assert.equal(v.slippage,w.base.slippage);
    assert.equal(v.episodes,6);assert.equal(v.closed_trades,6);assert.equal(v.rejected_intents,2);assert.equal(v.evaluation_bars,200);
    assert.equal(v.cost_stress_net_return_percent,round12(w.stress.returnPercent).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,''));
  }
  assert.equal(values['exp-1'].net_return_percent,HAND.net_return_percent);
  assert.equal(values['exp-2'].net_return_percent,'11.508');
  assert.equal(values['exp-3'].net_return_percent,'2.877');
  assert.deepEqual(outcome.evaluations.map(item=>item.result_hash),['exp-1','exp-2','exp-3'].map((_,index)=>list[index].result_hash));
  // the whole run is deterministic: the same inputs give the same evaluations, the same outcome hash
  assert.equal(note(rankSelection(REG,evaluationsOf(),FROZEN)).outcome_hash,outcome.outcome_hash);
  assert.equal(outcome.fixture,false);
});

test('a missing frozen dataset hash or a different one ends the selection incomplete: the dataset hash of the evaluation is the dataset digest of the run',()=>{
  const list=evaluationsOf();
  assert.equal(note(rankSelection(REG,list,{window_dataset_hash:sha('other')})).code,'BI_DATASET_HASH_MISMATCH');
  const other=qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-1',window:REG.window,engine:ENGINE,datasetSha:sha('another-files'),size:'10'});
  const ev=selectionEvaluationOf(inputOf(0,{},[other]),REAL).evaluation;
  assert.equal(ev.dataset_hash,sha('another-files'));
  assert.equal(note(rankSelection(REG,[ev,list[1],list[2]],FROZEN)).code,'BI_DATASET_HASH_MISMATCH');
});

test('an engine hash that differs from the registered one reaches rankSelection as QR4_ENGINE_MISMATCH (the adapter maps, rankSelection judges)',()=>{
  const odd=qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-1',window:REG.window,engine:sha('another-engine'),datasetSha:DATASET,size:'10'});
  const out=selectionEvaluationOf(inputOf(0,{},[odd]),REAL);
  assert.equal(out.ok,true);
  assert.equal(out.evaluation.engine_hash,sha('another-engine'));
  const outcome=note(rankSelection(REG,[out.evaluation,...evaluationsOf().slice(1)],FROZEN));
  assert.equal(outcome.status,'SELECTION_INCOMPLETE');
  assert.equal(outcome.code,'QR4_ENGINE_MISMATCH');
});

test('a run that did not succeed becomes an evaluation with that status and rankSelection ends the selection QR4_EVALUATION_FAILED (test 11)',()=>{
  assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(),['CANCELLED','FAILED','NO_VALID_CANDIDATE','SUCCEEDED','TIMED_OUT']);
  for(const status of ['FAILED','TIMED_OUT','CANCELLED','NO_VALID_CANDIDATE']){
    const failed=selectionEvaluationOf(inputOf(1,{run_status:status,binding:null,fixed_result:null,rows:null}),REAL);
    assert.equal(failed.ok,true,status+' '+JSON.stringify(failed));
    assert.deepEqual([failed.evaluation.status,failed.evaluation.run_id,failed.evaluation.parent_run_id,failed.evaluation.mode],[status,'ev-2','run-2','QR4_SELECTION_EVAL']);
    assert.equal(failed.evaluation.result,null);
    const good=evaluationsOf();
    const outcome=note(rankSelection(REG,[good[0],failed.evaluation,good[2]],FROZEN));
    assert.equal(outcome.status,'SELECTION_INCOMPLETE');
    assert.equal(outcome.code,'QR4_EVALUATION_FAILED');
    assert.equal(outcome.problems[0].detail,status);
    assert.deepEqual(outcome.completed_evaluation_ids,['ev-1','ev-3'],'only a run that SUCCEEDED counts as completed');
    assert.equal(outcome.ranking,null);
  }
  // a failed run still has to be the run of a participant of this selection
  integrity(selectionEvaluationOf(inputOf(1,{run_status:'FAILED',binding:null,fixed_result:null,rows:null,fixed_contract:world(1,{parentRunId:'run-77'}).contract}),REAL),'PARTICIPANT_NOT_IN_REGISTRATION');
  integrity(selectionEvaluationOf(inputOf(1,{run_status:'FAILED',binding:null,fixed_result:null,rows:null,fixed_contract:null}),REAL),'FIXED_CONTRACT_INVALID');
  refused(selectionEvaluationOf(inputOf(1,{run_status:'QUEUED'}),REAL),'INVALID_FIELDS','RUN_STATUS');
  refused(selectionEvaluationOf(inputOf(1,{run_status:'RUNNING'}),REAL),'INVALID_FIELDS','RUN_STATUS');
  refused(selectionEvaluationOf(inputOf(1,{run_status:undefined}),REAL),'INVALID_FIELDS','RUN_STATUS');
});

test('a missing, null or mistyped count reaches rankSelection as QR4_METRIC_MISSING with the name of the figure (test 11); nothing becomes zero',()=>{
  const lax={validateFixedEvalContract:value=>value,validateFixedEvalResult:(contract,binding,result)=>result};
  const cases={
    closed_trades:result=>{delete result.base.closed_allocations;},
    closed_trades_text:result=>{result.base.closed_allocations='6';},
    closed_trades_negative:result=>{result.base.closed_allocations=-1;},
    episodes:result=>{result.base.episodes.completed_count=null;},
    episodes_list:result=>{result.base.episodes.completed.pop();},
    rejected_intents:result=>{result.base.rejected.intents_total=99;},
    rejected_missing:result=>{delete result.base.rejected;}};
  const expectDetail={closed_trades:'closed_trades',closed_trades_text:'closed_trades',closed_trades_negative:'closed_trades',episodes:'episodes',episodes_list:'episodes',
    rejected_intents:'rejected_intents',rejected_missing:'rejected_intents'};
  for(const [name,edit] of Object.entries(cases)){
    const source=clone(WORLDS[0]);edit(source.result);
    const out=selectionEvaluationOf(inputOf(0,{},[source]),lax);
    assert.equal(out.ok,true,name+' '+JSON.stringify(out));
    const outcome=note(rankSelection(REG,[out.evaluation,...evaluationsOf().slice(1)],FROZEN));
    assert.equal(outcome.status,'SELECTION_INCOMPLETE',name);
    assert.equal(outcome.code,'QR4_METRIC_MISSING',name);
    assert.equal(outcome.problems[0].detail,expectDetail[name],name);
  }
});

test('a benchmark that cannot be computed becomes a null line and rankSelection ends the selection QR4_BENCHMARK_UNAVAILABLE (contract section 10)',()=>{
  // one unit of the quantity step is not affordable: a step of 1000 units at about 100 costs ten times the cash (the fixture trades do not depend on the step)
  const poor=qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-1',window:REG.window,engine:ENGINE,datasetSha:DATASET,quantityStep:'1000'});
  const out=selectionEvaluationOf(inputOf(0,{},[poor]),REAL);
  assert.equal(out.ok,true,JSON.stringify(out).slice(0,300));
  assert.equal(out.evaluation.result.benchmark.ok,false);
  assert.equal(out.evaluation.result.benchmark.net_return_percent,null);
  assert.equal(out.evaluation.result.benchmark.code,'QR3_METRIC_UNAVAILABLE');
  assert.equal(out.evaluation.result.benchmark.detail,'NO_UNITS_AFFORDABLE');
  const outcome=note(rankSelection(REG,[out.evaluation,...evaluationsOf().slice(1)],FROZEN));
  assert.equal(outcome.status,'SELECTION_INCOMPLETE');
  assert.equal(outcome.code,'QR4_BENCHMARK_UNAVAILABLE');
});

test('a number where a decimal string is required is refused QR4_METRIC_MISSING and is never read as a number (test 11)',()=>{
  const lax={validateFixedEvalContract:value=>value,validateFixedEvalResult:(contract,binding,result)=>result};
  const edits={
    fees_total:result=>{result.base.fees_total=Number(result.base.fees_total);},
    slippage_total:result=>{result.stress.slippage_cost_incl_tick_total=12;},
    end_equity:result=>{result.base.metrics.end_equity=10575.4;},
    return_percent:result=>{result.base.metrics.net_return_percent=5.754;},
    drawdown:result=>{result.stress.metrics.max_drawdown_percent=0.02;},
    exposure_fraction:result=>{result.base.exposure.fraction=0.03;},
    initial_equity:result=>{result.base.initial_equity=10000;},
    fill_price:result=>{result.base.fills[0].price=100.1;},
    fill_quantity:result=>{result.stress.fills[1].quantity=10;},
    fill_fee:result=>{result.base.fills[2].fee=1.001;}};
  for(const [name,edit] of Object.entries(edits)){
    const source=clone(WORLDS[0]);edit(source.result);
    refused(note(selectionEvaluationOf(inputOf(0,{},[source]),lax)),'QR4_METRIC_MISSING','NUMBER_NOT_DECIMAL_STRING');
  }
  const closeAsNumber=clone(WORLDS[0]);closeAsNumber.rows[1100].close=100;
  refused(note(selectionEvaluationOf(inputOf(0,{},[closeAsNumber]),lax)),'QR4_METRIC_MISSING','NUMBER_NOT_DECIMAL_STRING');
});

test('every evaluator figure is cross-checked against the standardized valuation, exactly; one unit in the last place is a difference',()=>{
  const bump=(value,step='1e-18')=>new Money(value).plus(step).toFixed();
  const edits={
    CROSS_CHECK_END_NAV:result=>{result.base.metrics.end_equity=bump(result.base.metrics.end_equity);},
    CROSS_CHECK_RETURN:result=>{result.base.metrics.net_return_percent=bump(result.base.metrics.net_return_percent);},
    CROSS_CHECK_DRAWDOWN:result=>{result.stress.metrics.max_drawdown_percent=bump(result.stress.metrics.max_drawdown_percent);},
    CROSS_CHECK_FEES:result=>{result.base.fees_total=bump(result.base.fees_total);},
    CROSS_CHECK_SLIPPAGE:result=>{result.stress.slippage_cost_incl_tick_total=bump(result.stress.slippage_cost_incl_tick_total);},
    CROSS_CHECK_EXPOSURE:result=>{result.base.exposure.bars_in_market+=1;}};
  for(const [detail,edit] of Object.entries(edits)){
    const source=clone(WORLDS[0]);edit(source.result);
    integrity(note(adapt(0,{},REAL,[source])),detail);
  }
  // the unchanged run passes, and a trailing zero is the same decimal (1.10 equals 1.1)
  const padded=clone(WORLDS[0]);padded.result.base.fees_total=padded.result.base.fees_total+'0';padded.result.base.metrics.end_equity=padded.result.base.metrics.end_equity+'00';
  assert.equal(adapt(0,{},REAL,[padded]).ok,true);
  // the exposure fraction is the count over the bars at 18 places
  const fraction=clone(WORLDS[0]);fraction.result.base.exposure.fraction='0.03000000000000001';
  integrity(adapt(0,{},REAL,[fraction]),'CROSS_CHECK_EXPOSURE');
});

test('identity: the purpose, the selection, the participant and the closure are the ones of the registration',()=>{
  const qr3=qr4FixedRunWorld({purpose:'QR3_COMPARISON',objectId:'cmp-1',parentRunId:'run-1',window:REG.window,engine:ENGINE,datasetSha:DATASET});
  integrity(note(selectionEvaluationOf(inputOf(0,{},[qr3]),REAL)),'PURPOSE');
  const foreign=qr4FixedRunWorld({objectId:'sel-other',parentRunId:'run-1',window:REG.window,engine:ENGINE,datasetSha:DATASET});
  integrity(note(selectionEvaluationOf(inputOf(0,{},[foreign]),REAL)),'LINEAGE_OBJECT');
  const stranger=qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-9',window:REG.window,engine:ENGINE,datasetSha:DATASET});
  integrity(note(selectionEvaluationOf(inputOf(0,{},[stranger]),REAL)),'PARTICIPANT_NOT_IN_REGISTRATION');
  // the step results name another selection or another parent (the validator accepts a result whose steps agree with the contract; edit both through a lax validator)
  const lax={validateFixedEvalContract:value=>value,validateFixedEvalResult:(contract,binding,result)=>result};
  const otherSelection=clone(WORLDS[0]);otherSelection.result.stress.selection_id='sel-other';
  integrity(selectionEvaluationOf(inputOf(0,{},[otherSelection]),lax),'SELECTION_ID');
  const otherParent=clone(WORLDS[0]);otherParent.result.base.parent_run_id='run-2';
  integrity(selectionEvaluationOf(inputOf(0,{},[otherParent]),lax),'LINEAGE_PARENT');
  const closure=clone(WORLDS[0]);closure.result.evaluation_closure.version='fixed-eval-closure-v2';
  integrity(selectionEvaluationOf(inputOf(0,{},[closure]),lax),'CLOSURE_VERSION');
  const split=clone(WORLDS[0]);split.result.stress.split.evaluated_bars=199;
  integrity(selectionEvaluationOf(inputOf(0,{},[split]),lax),'SPLIT_MISMATCH');
  // the real validator refuses a result that does not agree with its contract
  const tampered=clone(WORLDS[0]);tampered.result.base.engine_hash=sha('x');
  integrity(note(adapt(0,{},REAL,[tampered])),'FIXED_RESULT_INVALID');
});

test('window: the contract dataset and the rows must be exactly the registered window; any other shape is WINDOW_MISMATCH',()=>{
  const shifted=qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-1',window:{...REG.window,start_ms:REG.window.start_ms+MS,end_ms:REG.window.end_ms+MS},engine:ENGINE,datasetSha:DATASET});
  integrity(note(selectionEvaluationOf(inputOf(0,{},[shifted]),REAL)),'WINDOW_MISMATCH');
  const shortRows=clone(WORLDS[0]);shortRows.rows.pop();
  integrity(adapt(0,{},REAL,[shortRows]),'WINDOW_MISMATCH');
  const gap=clone(WORLDS[0]);gap.rows[1200].time+=MS;
  integrity(adapt(0,{},REAL,[gap]),'WINDOW_MISMATCH');
  const reordered=clone(WORLDS[0]);[reordered.rows[1100],reordered.rows[1101]]=[reordered.rows[1101],reordered.rows[1100]];
  integrity(adapt(0,{},REAL,[reordered]),'WINDOW_MISMATCH');
  integrity(adapt(0,{rows:null}),'WINDOW_MISMATCH');
  const longer=qr4FixedRunWorld({objectId:REG.selection_id,parentRunId:'run-1',window:{...REG.window,end_ms:REG.window.end_ms+10*MS,evaluation_bars:210,total_bars:1216},engine:ENGINE,datasetSha:DATASET});
  integrity(selectionEvaluationOf(inputOf(0,{},[longer]),REAL),'WINDOW_MISMATCH');
  // a warm-up bar that is not a closed minute step
  const warm=clone(WORLDS[0]);warm.rows[10].time+=1;
  integrity(adapt(0,{},REAL,[warm]),'WINDOW_MISMATCH');
  // an unreadable close inside the scored window is a window data problem, not a repaired bar
  const unreadable=clone(WORLDS[0]);unreadable.rows[1100].close='0';
  assert.equal(note(adapt(0,{},REAL,[unreadable])).code,'QR4_WINDOW_DATA_GAP');
});

test('a refused call: missing validators, a malformed input, a basis key, an unreadable registration and a bad run id; the function never throws',()=>{
  for(const bad of [undefined,null,{},{validateFixedEvalContract:REAL.validateFixedEvalContract},{validateFixedEvalResult:REAL.validateFixedEvalResult},
    {...REAL,validateFixedEvalResult:'x'},{...REAL,validateFixedEvalContract:null}])
    integrity(note(selectionEvaluationOf(inputOf(0),bad)),'VALIDATOR_MISSING');
  for(const bad of [undefined,null,[],'x',7,{},{...inputOf(0),extra:1},(({rows,...rest})=>rest)(inputOf(0))])
    assert.equal(note(selectionEvaluationOf(bad,REAL)).ok,false);
  refused(selectionEvaluationOf({...inputOf(0),basis_confirmed:true},REAL),'INVALID_FIELDS','BASIS_CONFIRMED');
  refused(selectionEvaluationOf({...inputOf(0),basis_confirmed:false},REAL),'INVALID_FIELDS','BASIS_CONFIRMED');
  refused(selectionEvaluationOf((({rows,...rest})=>rest)(inputOf(0)),REAL),'INVALID_FIELDS','INPUT');
  for(const registration of [undefined,null,{},{...REG,selection_id:''},{...REG,window:{...REG.window,evaluation_bars:199}},{...REG,window:{...REG.window,total_bars:1000}},
    {...REG,scope:{...REG.scope,engine:'x'}},{...REG,participants:[]},{...REG,participants:[{export_id:'e'}]},{...REG,window:null}])
    integrity(selectionEvaluationOf(inputOf(0,{registration}),REAL),'REGISTRATION_UNREADABLE');
  for(const id of [undefined,'',7,'bad id; DROP','x'.repeat(129),'-leading'])integrity(selectionEvaluationOf(inputOf(0,{evaluation_run_id:id}),REAL),'EVALUATION_RUN_ID');
  // a validator or a getter that throws: refused, never thrown
  const throwing={validateFixedEvalContract(){throw Error('boom');},validateFixedEvalResult(){throw Error('boom');}};
  integrity(note(selectionEvaluationOf(inputOf(0),throwing)),'FIXED_RESULT_INVALID');
  const trap=inputOf(0);Object.defineProperty(trap,'rows',{enumerable:true,get(){throw Error('getter');}});
  assert.equal(note(selectionEvaluationOf(trap,REAL)).ok,false);
  const lax={validateFixedEvalContract:value=>value,validateFixedEvalResult:()=>null};
  integrity(note(selectionEvaluationOf(inputOf(0),lax)),'UNEXPECTED_INPUT');
});

test('the input is never mutated and the output never aliases it',()=>{
  const input=inputOf(0),before=JSON.stringify(input);
  const out=selectionEvaluationOf(input,REAL);
  assert.equal(out.ok,true);
  assert.equal(JSON.stringify(input),before);
  assert.equal(Object.isFrozen(input.rows)||Object.isFrozen(input.fixed_result),false);
  assert.notEqual(out.evaluation.result,input.fixed_result);
});

test('refusedEvaluation: a deterministic INTEGRITY_CHECK_FAILED, QR4_METRIC_MISSING or QR4_WINDOW_DATA_GAP refusal becomes an evaluation that rankSelection ends with that code; no other refusal does',()=>{
  assert.deepEqual([...ENDING_REFUSAL_CODES],['INTEGRITY_CHECK_FAILED','QR4_METRIC_MISSING','QR4_WINDOW_DATA_GAP']);
  const good=evaluationsOf();
  const identity=index=>({selection_id:REG.selection_id,run_id:'ev-'+(index+1),parent_run_id:'run-'+(index+1),engine_hash:ENGINE,dataset_hash:DATASET,expected_bars:REG.window.evaluation_bars});
  const flags={INTEGRITY_CHECK_FAILED:[false,false],QR4_METRIC_MISSING:[true,true],QR4_WINDOW_DATA_GAP:[true,true]};
  for(const [code,detail] of [['INTEGRITY_CHECK_FAILED','CROSS_CHECK_FEES'],['QR4_METRIC_MISSING','NUMBER_NOT_DECIMAL_STRING'],['QR4_WINDOW_DATA_GAP','QR3_DATASET_GAPPED:GRID_LENGTH']]){
    const made=refusedEvaluation({...identity(1),refusal:{ok:false,code,detail}});
    assert.ok(made,code);
    assert.equal(Object.isFrozen(made),true);
    assert.deepEqual(made.adapter_refusal,{code,detail});
    assert.equal(made.status,'SUCCEEDED');
    assert.deepEqual([made.integrity.contract_hash_verified,made.integrity.report_matches_checkpoints],flags[code],'integrity flags of '+code);
    assert.equal(made.result===null,code==='INTEGRITY_CHECK_FAILED');
    assert.equal(made.result_hash===null,code==='INTEGRITY_CHECK_FAILED');
    const outcome=note(rankSelection(REG,[good[0],made,good[2]],FROZEN));
    assert.equal(outcome.status,'SELECTION_INCOMPLETE');
    assert.equal(outcome.code,code,JSON.stringify(outcome).slice(0,400));
    assert.deepEqual(outcome.completed_evaluation_ids,['ev-1','ev-2','ev-3'],'the run itself succeeded; only its record was refused');
  }
  // the gap marker is a count that differs from the registered one; the registered count is required for it
  const gap=refusedEvaluation({...identity(1),refusal:{ok:false,code:'QR4_WINDOW_DATA_GAP',detail:'X'}});
  assert.equal(gap.result.evaluation_bars,REG.window.evaluation_bars+1);
  assert.equal(refusedEvaluation({...identity(1),expected_bars:undefined,refusal:{ok:false,code:'QR4_WINDOW_DATA_GAP',detail:'X'}}),null);
  assert.equal(refusedEvaluation({...identity(1),expected_bars:-1,refusal:{ok:false,code:'QR4_WINDOW_DATA_GAP',detail:'X'}}),null);
  for(const code of ['QR4_WINDOW_DATA_UNAVAILABLE','INVALID_FIELDS'])assert.equal(refusedEvaluation({...identity(1),refusal:{ok:false,code,detail:'X'}}),null,code);
  assert.equal(refusedEvaluation({...identity(1),run_id:'',refusal:{ok:false,code:'INTEGRITY_CHECK_FAILED',detail:'X'}}),null);
  assert.equal(refusedEvaluation({...identity(1),refusal:null}),null);
});

test('refusedEvaluation carries the real run status: a run that did not succeed ends the selection QR4_EVALUATION_FAILED with that status, whatever the refusal',()=>{
  const good=evaluationsOf();
  const identity=index=>({selection_id:REG.selection_id,run_id:'ev-'+(index+1),parent_run_id:'run-'+(index+1),engine_hash:ENGINE,dataset_hash:DATASET,expected_bars:REG.window.evaluation_bars});
  for(const status of ['FAILED','TIMED_OUT','CANCELLED','NO_VALID_CANDIDATE']){
    for(const code of ENDING_REFUSAL_CODES){
      const made=refusedEvaluation({...identity(1),status,refusal:{ok:false,code,detail:'X'}});
      assert.equal(made.status,status);
      const outcome=note(rankSelection(REG,[good[0],made,good[2]],FROZEN));
      assert.deepEqual([outcome.status,outcome.code,outcome.problems[0].detail],['SELECTION_INCOMPLETE','QR4_EVALUATION_FAILED',status],status+' '+code);
      assert.deepEqual(outcome.completed_evaluation_ids,['ev-1','ev-3'],'a run that did not succeed is not completed');
    }
  }
  for(const status of ['QUEUED','RUNNING','','x',null])assert.equal(refusedEvaluation({...identity(1),status,refusal:{ok:false,code:'INTEGRITY_CHECK_FAILED',detail:'X'}}),null,String(status));
});

test('constants restated from the fixed-evaluation contract are pinned to its exports',()=>{
  assert.equal(FIXED_EVAL_VERSIONS.closure,'fixed-eval-closure-v1');
  assert.equal(FIXED_EVAL_VERSIONS.mode,'FIXED_INPUT_EVAL');
  assert.ok(FIXED_EVAL_PURPOSES.includes('QR4_SELECTION'));
  assert.equal(QR4_VERSIONS.evaluation_mode,'QR4_SELECTION_EVAL');
  const ev=adapt(0).evaluation;
  assert.equal(ev.mode,QR4_VERSIONS.evaluation_mode);
  assert.equal(WORLDS[0].result.evaluation_closure.version,FIXED_EVAL_VERSIONS.closure);
  assert.equal(WORLDS[0].contract.mode,FIXED_EVAL_VERSIONS.mode);
});

test('test 20: every code the adapter and the ranking emit here matches the pattern',()=>{
  assert.ok(seenCodes.size>=8,[...seenCodes].join());
  for(const code of seenCodes)assert.match(code,CODE_PATTERN,code);
});
