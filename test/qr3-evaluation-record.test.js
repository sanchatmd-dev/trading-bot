import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {Money} from '../src/money.js';
import {MINUTE,CODES,QR3_VERSIONS} from '../src/comparison/common.js';
import {validateSpec,specHashOf} from '../src/comparison/ranking.js';
import {buyAndHold} from '../src/comparison/valuation.js';
import {
  EVALUATION_RECORD_VERSION,EVALUATION_RECORD_MAX_BYTES,BENCHMARK_RECORD_MAX_BYTES,BENCHMARK_ID,
  evaluationRecordBody,benchmarkRecordBody,outcomeRecord
} from '../src/comparison/evaluation-record.js';
import {buildFixedEvalContract,buildFixedEvalResult,fixedEvalBindingParameters,fixedEvalPendingMetadata} from '../src/quant-research/fixed-eval-contract.js';

// Every participant, run, price and number below is a LABELLED TEST FIXTURE. None is a research result and none is a qualified result.
// The fixture is a real fixed-eval-result-v1 built through buildFixedEvalResult, so validateFixedEvalResult accepts it. The "evaluator" figures are
// computed here with an independent Money ledger, and the base case is also derived by hand (see the comment above the fills).

const START=1_800_000_000_000; // first closed-bar timestamp of the dataset
const WARMUP=1006;
const PARTICIPANT='run-parent',OTHER='run-other',COMPARISON='cmp-1',RUN='eval-run-1';
const ENGINE=hash('engine'),PARENT_HASH=hash('parent contract'),DIGEST=hash('content digest'),CONTEXT='c'.repeat(64);
const NUMBER_DETAIL='NUMBER_NOT_DECIMAL_STRING';
const POLICY={killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,pauseAfterLossStreak:10000,
  blockHighVolatility:false,maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',
  maxOpenPositions:3,onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,
  maxDailyNotional:100000000};
const PARENT_POLICY={...POLICY,paperTrading:true,requireReduceOnlySell:true};
const INPUTS={ema_fast:3,ema_slow:8,atr_len:14,st_factor:3.2,zone_atr_mult:1.15,setup_expiry:48,cooldown:0,confirm_lookback:5,sl_atr_buffer:0.6,min_risk_atr:0.5};
const COST={version:'paper-close-v1',data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'10',risk_percent:'1'};
const CLOSES=['100','110','99'];
/*
 * Base fills (hand-derived): BUY 10 at 100.1 on scored bar 0 (fee 1.001, slippage |100.1-100|*10 = 1), SELL 10 at 98.9 on scored bar 2
 * (fee 0.989, slippage |98.9-99|*10 = 1). Cash 10000 -> 8997.999 -> 9986.01; fees 1.99; slippage 2; in market on bars 0 and 1 (2 of 3);
 * end equity 9986.01; return (9986.01/10000-1)*100 = -0.1399; peak 10097.999 on bar 1, so drawdown (10097.999-9986.01)/10097.999*100.
 * Stress fills double the cost: BUY at 100.2 (fee 2.004), SELL at 98.8 (fee 1.976); end equity 9982.02.
 */
const BASE_FILLS=[{bar:0,side:'BUY',quantity:'10',price:'100.1',fee:'1.001',cost:'1'},{bar:2,side:'SELL',quantity:'10',price:'98.9',fee:'0.989',cost:'1'}];
const STRESS_FILLS=[{bar:0,side:'BUY',quantity:'10',price:'100.2',fee:'2.004',cost:'2'},{bar:2,side:'SELL',quantity:'10',price:'98.8',fee:'1.976',cost:'2'}];

/** Independent ledger of the test: cash, inventory, mark-to-close NAV on the scored bar closes, drawdown from the initial NAV. */
function ledgerOf(closes,fills,cash0){
  let cash=new Money(cash0),held=new Money(0),peak=cash,drawdown=new Money(0),fees=new Money(0),slippage=new Money(0),inMarket=0,nav=cash;
  closes.forEach((close,bar)=>{
    for(const fill of fills.filter(item=>item.bar===bar)){
      const notional=new Money(fill.quantity).mul(fill.price);
      cash=fill.side==='BUY'?cash.minus(notional).minus(fill.fee):cash.plus(notional).minus(fill.fee);
      held=fill.side==='BUY'?held.plus(fill.quantity):held.minus(fill.quantity);
      fees=fees.plus(fill.fee);slippage=slippage.plus(fill.cost);
    }
    nav=cash.plus(held.mul(close));
    if(held.gt(0))inMarket+=1;
    if(nav.gt(peak))peak=nav;
    const down=peak.minus(nav).div(peak).mul(100);
    if(down.gt(drawdown))drawdown=down;
  });
  return {nav,fees,slippage,inMarket,held,drawdown,returnPercent:nav.div(cash0).minus(1).mul(100)};
}

/** A frozen contract, binding, dataset rows, spec and a validated fixed-eval-result-v1 for one participant. */
function build({bars=1009,cash='10000',equity=cash,quantityStep='0.001',purpose='QR3_COMPARISON',participant=PARTICIPANT,comparison=COMPARISON,cost={}}={}){
  const end=START+(bars-1)*MINUTE;
  const model={...COST,quantity_step:quantityStep,...cost};
  const contract=buildFixedEvalContract({purpose,owner_id:'owner-1',bot_id:'bot-1',deployment_id:'deployment-1',
    lineage:{parent_run_id:participant,parent_contract_hash:PARENT_HASH,object_id:comparison},engine_hash:ENGINE,
    parameters:{inputs:{...INPUTS},atr_multiplier:'2',rr:'1.5'},capital:{initial_cash:cash,initial_equity:equity,initial_inventory:'0',quote:'USDT'},
    policy:{...POLICY},parent_policy:{...PARENT_POLICY},cost_model:model,
    dataset:{start_time:START,end_time:end,warmup_bars:WARMUP,content_digest:DIGEST},
    parent_dataset_range:{start_time:START-5000*MINUTE,end_time:START-MINUTE}});
  const metadata=fixedEvalPendingMetadata(contract);
  const sidecar={sha256:hash('sidecar'),bar_count:bars,first_time:START,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:quantityStep};
  const binding=fixedEvalBindingParameters(contract,{references:{raw:{dataset_id:hash('raw'),sha256:hash('raw'),metadata},sidecar},dataset_sha256:hash('files')});
  const closes=Array.from({length:bars-WARMUP},(_,index)=>CLOSES[index%CLOSES.length]);
  const rows=Array.from({length:bars},(_,index)=>({time:START+index*MINUTE,open:'100',high:'111',low:'98',close:index<WARMUP?'100':closes[index-WARMUP],volume:'1',atr14:'1.5'}));
  const S=rows[WARMUP].time-MINUTE,E=rows[bars-1].time;
  const spec=validateSpec({mode:'STANDARDIZED',participants:[PARTICIPANT,OTHER],period:{start_ms:S,end_ms:E},objective:'qr3-obj-net-return-v1',
    risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
    uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'}}).spec;
  const step=(kind,fills)=>{
    const factor=kind==='EVALUATION_STRESS'?2:1;
    const led=ledgerOf(closes,fills,cash);
    const sells=fills.filter(fill=>fill.side==='SELL').length;
    return {version:'fixed-eval-v1',evaluator_closure:'fixed-eval-closure-v1',kind,cost_stress:{fee_multiplier:String(factor),slippage_multiplier:String(factor)},
      model:{price_tick:'0.01',quantity_step:quantityStep,fee_bps:new Money(model.fee_bps).mul(factor).toFixed(),slippage_bps:new Money(model.slippage_bps).mul(factor).toFixed(),
        risk_percent:'1',version:'paper-close-v1'},
      bridge:{atr_multiplier:'2',rr:'1.5'},initial_equity:equity,split:{warmup:WARMUP,end:bars,evaluated_bars:bars-WARMUP},engine_hash:ENGINE,
      dataset_sha256:binding.dataset_sha256,parent_run_id:participant,selection_id:purpose==='QR4_SELECTION'?comparison:null,metrics_precision:80,
      metrics:{end_equity:led.nav.toFixed(),net_return_percent:led.returnPercent.toFixed(),max_drawdown_percent:led.drawdown.toFixed(),closed_trades:sells},
      fills:fills.map((fill,index)=>({event_type:fill.side==='BUY'?'BUY':'EXIT',time:S+fill.bar*MINUTE+MINUTE,price:fill.price,quantity:fill.quantity,fee:fill.fee,sequence:index+1,
        notional:new Money(fill.quantity).mul(fill.price).toFixed(),bar_time_ms:S+fill.bar*MINUTE,side:fill.side,slippage_cost_incl_tick:fill.cost})),
      fees_total:led.fees.toFixed(),slippage_cost_incl_tick_total:led.slippage.toFixed(),
      exposure:{bars_in_market:led.inMarket,bars:bars-WARMUP,fraction:new Money(led.inMarket).div(bars-WARMUP).toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed()}, // 18 places half-even, as the evaluator reports it
      episodes:{completed_count:1,completed:[{open_bar_time_ms:S,allocations:1,close_bar_time_ms:S+2*MINUTE}]},closed_allocations:sells,
      open_position:{quantity:led.held.toFixed(),allocations:0,mark_close:closes[closes.length-1],open_episode:null},
      rejected:{total:3,intents_total:2,orphan_exits:{warmup_entry:1,refused_entry:0},
        by_event_type_and_reason:[{event_type:'BUY',reason:'MAX_OPEN_POSITIONS',count:2},{event_type:'EXIT',reason:'TARGET_NOT_OPEN',count:1}]}};
  };
  const result=buildFixedEvalResult(contract,binding,{base:step('EVALUATION',BASE_FILLS),stress:step('EVALUATION_STRESS',STRESS_FILLS)},{version:'fixed-eval-closure-v1',hash:ENGINE});
  return {contract,binding,rows,spec,specHash:specHashOf(spec),result,S,E,closes};
}

const BASE=build();
const evaluationInput=(fx=BASE,patch={})=>structuredClone({comparison_id:COMPARISON,spec_hash:fx.specHash,spec:fx.spec,participant_id:PARTICIPANT,evaluation_run_id:RUN,
  fixed_contract:fx.contract,binding:fx.binding,fixed_result:fx.result,rows:fx.rows,...patch});
const benchmarkInput=(fx=BASE,patch={})=>structuredClone({comparison_id:COMPARISON,spec_hash:fx.specHash,spec:fx.spec,fixed_contract:fx.contract,rows:fx.rows,...patch});
/** Edits a fresh evaluation input in place and returns the function result. */
const evaluate=(edit,fx=BASE)=>{const input=evaluationInput(fx);edit(input);return evaluationRecordBody(input);};
const refused=(result,code,detail)=>{assert.equal(result.ok,false,JSON.stringify(result).slice(0,300));assert.equal(result.code,code);assert.equal(result.detail,detail);};
const integrity=(result,detail)=>refused(result,CODES.QR3_INTEGRITY_FAILED,detail);
const numberRefused=result=>refused(result,CODES.QR3_SPEC_INCOMPLETE,NUMBER_DETAIL);
const bump=(value,step='1e-18')=>new Money(value).plus(step).toFixed();
const OUTCOME_FIELDS=['version','mode','spec_hash','context_key','outcome','participants','uncertainty','only_qualified_participant_id','limitations'];

const okBase=evaluationRecordBody(evaluationInput());
const okBenchmark=benchmarkRecordBody(benchmarkInput());

/* ------------------------------------------------------------------ A1 shapes, limits, determinism */
test('A1 evaluation body meets the SQL shape and the byte limit; same input, same canonical text and hash',()=>{
  assert.equal(okBase.ok,true,JSON.stringify(okBase).slice(0,300));
  const body=okBase.body;
  // quant_comparison_evaluations_body_check: object, string record_comparison_id and record_spec_hash equal to the row, numeric window.
  assert.equal(body.version,'qr3-evaluation-record-v1');
  assert.equal(EVALUATION_RECORD_VERSION,'qr3-evaluation-record-v1');
  assert.equal(body.record_comparison_id,COMPARISON);
  assert.equal(body.record_spec_hash,BASE.specHash);
  assert.deepEqual(body.window,{start_ms:BASE.S,end_ms:BASE.E});
  assert.equal(typeof body.window.start_ms,'number');assert.equal(typeof body.window.end_ms,'number');
  assert.deepEqual([body.participant_id,body.evaluation_run_id],[PARTICIPANT,RUN]);
  assert.deepEqual([body.engine_hash,body.dataset_sha256],[ENGINE,BASE.result.dataset_sha256]);
  assert.deepEqual(body.evaluation_closure,{version:'fixed-eval-closure-v1',hash:ENGINE});
  const text=canonical(body);
  assert.ok(Buffer.byteLength(text,'utf8')<=EVALUATION_RECORD_MAX_BYTES);
  assert.equal(EVALUATION_RECORD_MAX_BYTES,4194304);
  assert.deepEqual(JSON.parse(text),JSON.parse(JSON.stringify(body)));
  assert.equal(okBase.body_hash,hash(text));
  assert.match(okBase.body_hash,/^[0-9a-f]{64}$/);
  const again=evaluationRecordBody(evaluationInput());
  assert.equal(canonical(again.body),text);
  assert.equal(again.body_hash,okBase.body_hash);
  assert.deepEqual([okBase.code,okBase.detail],[null,null]);
});
test('A1 evaluation body content: base and stress valuations, six required metrics, episodes, allocations and the full rejected object',()=>{
  const body=okBase.body;
  assert.equal(body.valuation.end_nav,'9986.01');
  assert.equal(body.valuation.net_return_percent_exact,'-0.1399');
  assert.equal(body.valuation.total_fees,'1.99');
  assert.deepEqual(body.valuation.total_slippage,{value:'2',reason:null});
  assert.equal(body.valuation.exposure_percent,'66.666666666667');
  assert.equal(body.valuation.bars,3);
  assert.equal(body.valuation.max_drawdown_percent_exact,new Money('111.989').div('10097.999').mul(100).toFixed());
  assert.equal(body.stress_valuation.end_nav,'9982.02');
  assert.equal(body.stress_valuation.total_fees,'3.98');
  assert.ok(new Money(body.stress_valuation.net_return_percent_exact).lt(body.valuation.net_return_percent_exact));
  assert.deepEqual(body.metrics,{net_return_percent:'-0.1399',max_drawdown_percent:body.valuation.max_drawdown_percent,total_fees:'1.99',
    total_slippage:{value:'2',reason:null},exposure_percent:'66.666666666667',rejected_intents:2});
  assert.equal(body.metrics.rejected_intents,BASE.result.base.rejected.intents_total);
  assert.equal(body.completed_episodes,1);
  assert.equal(body.closed_allocations,1);
  assert.deepEqual(body.rejected,BASE.result.base.rejected);
  assert.deepEqual(Object.keys(body).sort(),['basis_confirmed','closed_allocations','completed_episodes','dataset_sha256','engine_hash','evaluation_closure','evaluation_run_id',
    'limitations','metrics','participant_id','record_comparison_id','record_spec_hash','rejected','stress_valuation','valuation','version','window']);
});
test('A1 evaluation body above 4194304 bytes is refused BODY_SIZE',()=>{
  refused(evaluate(input=>{
    input.fixed_result.base.rejected.by_event_type_and_reason=Array.from({length:90000},(_,index)=>({event_type:'BUY',reason:'REASON_'+index,count:1}));
  }),CODES.INVALID_FIELDS,'BODY_SIZE');
});
test('A1 benchmark body meets the SQL shape and the byte limit; same input, same canonical text and hash',()=>{
  assert.equal(okBenchmark.ok,true,JSON.stringify(okBenchmark).slice(0,300));
  const body=okBenchmark.body;
  // quant_comparison_benchmarks_body_check: object whose benchmark_id is the one fixed id.
  assert.equal(body.benchmark_id,'qr3-bh-close-same-cost-v1');
  assert.equal(BENCHMARK_ID,'qr3-bh-close-same-cost-v1');
  assert.equal(BENCHMARK_ID,QR3_VERSIONS.benchmark);
  assert.deepEqual(Object.keys(body).sort(),['benchmark_id','record_comparison_id','record_spec_hash','result','window']);
  assert.equal(body.record_comparison_id,COMPARISON);
  assert.equal(body.record_spec_hash,BASE.specHash);
  assert.deepEqual(body.window,{start_ms:BASE.S,end_ms:BASE.E});
  const text=canonical(body);
  assert.ok(Buffer.byteLength(text,'utf8')<=BENCHMARK_RECORD_MAX_BYTES);
  assert.equal(BENCHMARK_RECORD_MAX_BYTES,262144);
  assert.equal(okBenchmark.body_hash,hash(text));
  const again=benchmarkRecordBody(benchmarkInput());
  assert.equal(canonical(again.body),text);
  assert.equal(again.body_hash,okBenchmark.body_hash);
});
test('A1 evaluation body at exactly 4194304 bytes is accepted and one byte more is refused BODY_SIZE',()=>{
  // The only free text in the stored body is the rejected reason list, so a padded reason sets the canonical size byte by byte (ASCII, one byte each).
  const padded=length=>evaluate(input=>{input.fixed_result.base.rejected.by_event_type_and_reason=[{event_type:'BUY',reason:'x'.repeat(length),count:1}];});
  const one=padded(1);
  assert.equal(one.ok,true);
  const base=Buffer.byteLength(canonical(one.body),'utf8')-1;
  const exact=padded(EVALUATION_RECORD_MAX_BYTES-base);
  assert.equal(exact.ok,true,JSON.stringify(exact).slice(0,200));
  assert.equal(Buffer.byteLength(canonical(exact.body),'utf8'),EVALUATION_RECORD_MAX_BYTES);
  refused(padded(EVALUATION_RECORD_MAX_BYTES-base+1),CODES.INVALID_FIELDS,'BODY_SIZE');
});
test('A1 benchmark body for the largest admitted window (8994 scored bars) fits MAX_BENCHMARK_BYTES: no nav_series, a hash and a count instead (P1)',()=>{
  const big=build({bars:10000});
  assert.equal(big.rows.length-WARMUP,8994);
  const result=benchmarkRecordBody(benchmarkInput(big));
  assert.equal(result.ok,true,JSON.stringify(result).slice(0,300));
  const text=canonical(result.body);
  assert.ok(Buffer.byteLength(text,'utf8')<=BENCHMARK_RECORD_MAX_BYTES);
  assert.ok(Buffer.byteLength(text,'utf8')<4096,'the body no longer grows with the window');
  const stored=result.body.result.valuation;
  assert.equal(Object.hasOwn(stored,'nav_series'),false);
  assert.equal(stored.nav_points,8994);
  assert.equal(stored.bars,8994);
  // The hash is that of the canonical text of the series the S1 benchmark computes for the same grid.
  const grid=big.rows.slice(WARMUP).map(row=>({time_ms:row.time-MINUTE,close:row.close}));
  const direct=buyAndHold({initial_cash:'10000',period:{start_ms:big.S,end_ms:big.E},grid,data_model:{price_tick:'0.01',quantity_step:'0.001'},
    cost_model:{fee_bps:'10',slippage_bps:'10'},basis_confirmed:false,include_liquidation_line:false});
  assert.equal(direct.ok,true);
  assert.equal(direct.valuation.nav_series.length,8994);
  assert.equal(stored.nav_series_sha256,hash(canonical(direct.valuation.nav_series)));
  assert.match(stored.nav_series_sha256,/^[0-9a-f]{64}$/);
  // Every other figure is the S1 result, unchanged.
  const {nav_series:omitted,...kept}=direct.valuation;
  assert.ok(omitted.length>0);
  assert.deepEqual({...result.body.result},{...direct,valuation:{...kept,nav_series_sha256:stored.nav_series_sha256,nav_points:8994}});
  assert.equal(result.body_hash,hash(text));
});
test('A1 input shape: exact keys, comparison id, spec hash and spec object',()=>{
  const bad=(edit,detail)=>refused(evaluate(edit),CODES.INVALID_FIELDS,detail);
  refused(evaluationRecordBody(null),CODES.INVALID_FIELDS,'INPUT');
  refused(evaluationRecordBody([]),CODES.INVALID_FIELDS,'INPUT');
  bad(input=>{input.extra=1;},'INPUT');
  bad(input=>{delete input.rows;},'INPUT');
  bad(input=>{delete input.evaluation_run_id;},'INPUT');
  bad(input=>{input.comparison_id='bad id!';},'COMPARISON_ID');
  bad(input=>{input.comparison_id=7;},'COMPARISON_ID');
  bad(input=>{input.spec_hash='A'.repeat(64);},'SPEC_HASH');
  bad(input=>{input.spec_hash=BASE.specHash.slice(1);},'SPEC_HASH');
  bad(input=>{input.spec=null;},'SPEC');
  bad(input=>{input.spec=[];},'SPEC');
  const benchmark=edit=>{const input=benchmarkInput();edit(input);return benchmarkRecordBody(input);};
  refused(benchmark(input=>{input.extra=1;}),CODES.INVALID_FIELDS,'INPUT');
  refused(benchmark(input=>{delete input.rows;}),CODES.INVALID_FIELDS,'INPUT');
  refused(benchmark(input=>{input.participant_id=PARTICIPANT;}),CODES.INVALID_FIELDS,'INPUT');
  refused(benchmark(input=>{input.comparison_id='bad id!';}),CODES.INVALID_FIELDS,'COMPARISON_ID');
  refused(benchmark(input=>{input.spec_hash='x';}),CODES.INVALID_FIELDS,'SPEC_HASH');
  refused(benchmark(input=>{input.spec=5;}),CODES.INVALID_FIELDS,'SPEC');
  refused(outcomeRecord(null),CODES.INVALID_FIELDS,'INPUT');
});
test('A1 validateFixedEvalResult comes first: a tampered result, binding or contract is FIXED_RESULT_INVALID',()=>{
  const bad=edit=>integrity(evaluate(edit),'FIXED_RESULT_INVALID');
  bad(input=>{input.fixed_result.engine_hash='f'.repeat(64);});
  bad(input=>{input.fixed_result.base.dataset_sha256='f'.repeat(64);});
  bad(input=>{input.fixed_result.base.fees_total=1.99;}); // a number in a validated money field is a validation failure, not a number refusal
  bad(input=>{input.fixed_result.extra=1;});
  bad(input=>{input.fixed_result=null;});
  bad(input=>{input.binding.dataset_sha256='f'.repeat(64);});
  bad(input=>{input.binding=null;});
  bad(input=>{input.fixed_contract.engine_hash='f'.repeat(64);});
  bad(input=>{input.fixed_contract=null;});
  // The validated result also gates the lineage rows that a validated result can never break (the single changed input is caught first).
  bad(input=>{input.fixed_result.base.selection_id='sel-1';});
  bad(input=>{input.fixed_result.stress.selection_id='sel-1';});
  bad(input=>{input.fixed_result.evaluation_closure.version='fixed-eval-closure-v2';});
  bad(input=>{input.fixed_result.stress.split.warmup+=1;});
  bad(input=>{input.fixed_result.stress.parent_run_id=OTHER;});
  refused(benchmarkRecordBody({...benchmarkInput(),fixed_contract:null}),CODES.QR3_INTEGRITY_FAILED,'FIXED_CONTRACT_INVALID');
});

/* ------------------------------------------------------------------ A2 time translation */
test('A2 worked example of 5.3: three scored bars, grid at bar-open times, fills on the second and the last grid bar',()=>{
  // Dataset closed-bar times: index 1005 = S, 1006 = S + 60000 (first scored row), 1007 = S + 120000, 1008 = S + 180000 = E (warm-up 1006, end 1009).
  assert.equal(BASE.rows[WARMUP-1].time,BASE.S);
  assert.equal(BASE.rows[WARMUP].time,BASE.S+MINUTE);
  assert.equal(BASE.rows[WARMUP+2].time,BASE.E);
  assert.equal(BASE.E-BASE.S,3*MINUTE);
  const fills=[{bar:1,side:'BUY',quantity:'10',price:'110.1',fee:'1.101',cost:'1'},{bar:2,side:'SELL',quantity:'10',price:'98.9',fee:'0.989',cost:'1'}];
  const result=buildFixedEvalResult(BASE.contract,BASE.binding,{base:{...BASE.result.base,fills:fills.map((fill,index)=>({...BASE.result.base.fills[0],event_type:fill.side==='BUY'?'BUY':'EXIT',
    time:BASE.S+fill.bar*MINUTE+MINUTE,price:fill.price,quantity:fill.quantity,fee:fill.fee,sequence:index+1,bar_time_ms:BASE.S+fill.bar*MINUTE,side:fill.side,
    slippage_cost_incl_tick:fill.cost}))},stress:BASE.result.stress},{version:'fixed-eval-closure-v1',hash:ENGINE});
  const led=ledgerOf(BASE.closes,fills,'10000');
  const patch=input=>{
    input.fixed_result=structuredClone(result);
    const step=input.fixed_result.base;
    step.metrics.end_equity=led.nav.toFixed();step.metrics.net_return_percent=led.returnPercent.toFixed();step.metrics.max_drawdown_percent=led.drawdown.toFixed();
    step.fees_total=led.fees.toFixed();step.slippage_cost_incl_tick_total=led.slippage.toFixed();
    step.exposure={bars_in_market:led.inMarket,bars:3,fraction:new Money(led.inMarket).div(3).toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed()};
  };
  const accepted=evaluate(patch);
  assert.equal(accepted.ok,true,JSON.stringify(accepted).slice(0,300));
  assert.deepEqual(accepted.body.window,{start_ms:BASE.S,end_ms:BASE.E});
  assert.deepEqual(accepted.body.valuation.nav_series.map(point=>point.time_ms),[BASE.S,BASE.S+MINUTE,BASE.S+2*MINUTE]);
  assert.equal(accepted.body.valuation.bars,3);
  assert.equal(accepted.body.valuation.exposure_percent,'33.333333333333'); // in market on bar 1 only: BUY on bar 1, SELL on bar 2 first
  // The fill with time E has bar_time_ms E - 60000, the last grid bar, and the base fixture already holds it.
  assert.equal(BASE.result.base.fills[1].time,BASE.E);
  assert.equal(BASE.result.base.fills[1].bar_time_ms,BASE.E-MINUTE);
});
test('A2 a fill whose bar_time_ms is not time - 60000 refuses FILL_TIME_TRANSLATION (base and stress)',()=>{
  for(const step of ['base','stress']){
    for(const delta of [MINUTE,-MINUTE,1]){
      integrity(evaluate(input=>{input.fixed_result[step].fills[0].bar_time_ms+=delta;}),'FILL_TIME_TRANSLATION');
    }
    integrity(evaluate(input=>{input.fixed_result[step].fills[1].time+=MINUTE;}),'FILL_TIME_TRANSLATION');
    integrity(evaluate(input=>{delete input.fixed_result[step].fills[0].bar_time_ms;}),'FILL_TIME_TRANSLATION');
    integrity(evaluate(input=>{input.fixed_result[step].fills[0]=null;}),'FILL_TIME_TRANSLATION');
  }
});
test('A2 a warm-up fill is outside [start, end) and valueRun refuses FILL_OUTSIDE_WINDOW; the refusal is passed through',()=>{
  for(const step of ['base','stress']){
    const result=evaluate(input=>{const fill=input.fixed_result[step].fills[0];fill.time=BASE.S;fill.bar_time_ms=BASE.S-MINUTE;});
    refused(result,CODES.QR3_METRIC_UNAVAILABLE,'FILL_OUTSIDE_WINDOW');
    // A fill at time E + 60000 (bar E) is past the half-open end.
    refused(evaluate(input=>{const fill=input.fixed_result[step].fills[1];fill.time=BASE.E+MINUTE;fill.bar_time_ms=BASE.E;}),CODES.QR3_METRIC_UNAVAILABLE,'FILL_OUTSIDE_WINDOW');
  }
});
test('A2 a shifted grid or a period that differs from the spec refuses WINDOW_MISMATCH',()=>{
  const bad=edit=>integrity(evaluate(edit),'WINDOW_MISMATCH');
  bad(input=>{input.spec.period.start_ms+=MINUTE;});
  bad(input=>{input.spec.period.start_ms-=MINUTE;});
  bad(input=>{input.spec.period.end_ms+=MINUTE;});
  bad(input=>{input.spec.period.end_ms-=MINUTE;});
  bad(input=>{input.spec.period=null;});
  bad(input=>{delete input.spec.period;});
  bad(input=>{input.spec.period={start_ms:String(BASE.S),end_ms:String(BASE.E)};});
  bad(input=>{for(const row of input.rows)row.time+=MINUTE;}); // every bar one minute late: the grid is shifted by one bar
  bad(input=>{input.rows[WARMUP+1].time+=MINUTE;});
  bad(input=>{input.rows.pop();});
  bad(input=>{input.rows.push({...input.rows[0],time:input.rows[input.rows.length-1].time+MINUTE});});
  bad(input=>{input.rows[3]=null;});
  bad(input=>{input.rows='rows';});
  const benchmark=edit=>{const input=benchmarkInput();edit(input);return benchmarkRecordBody(input);};
  integrity(benchmark(input=>{input.spec.period.start_ms+=MINUTE;}),'WINDOW_MISMATCH');
  integrity(benchmark(input=>{input.spec.period.end_ms-=MINUTE;}),'WINDOW_MISMATCH');
  integrity(benchmark(input=>{for(const row of input.rows)row.time-=MINUTE;}),'WINDOW_MISMATCH');
  integrity(benchmark(input=>{input.rows.pop();}),'WINDOW_MISMATCH');
  integrity(benchmark(input=>{input.rows=null;}),'WINDOW_MISMATCH');
});
test('A2 the grid is built from the scored rows only: warm-up closes never reach the valuation',()=>{
  const changed=evaluate(input=>{for(let index=0;index<WARMUP;index+=1)input.rows[index].close='1';});
  assert.equal(changed.ok,true);
  assert.equal(changed.body_hash,okBase.body_hash);
  // The grid close of scored bar i is the close of dataset row warmup + i: the second scored close moves the peak, so the drawdown cross-check refuses.
  integrity(evaluate(input=>{input.rows[WARMUP+1].close='111';}),'CROSS_CHECK_DRAWDOWN');
});

/* ------------------------------------------------------------------ A3 exact-decimal cross-check */
test('A3 cross-check: one smallest-step change of any evaluator figure refuses with its detail, for base and for stress; nothing is repaired',()=>{
  const figures=[
    ['CROSS_CHECK_END_NAV',step=>{step.metrics.end_equity=bump(step.metrics.end_equity,'1e-18');},step=>{step.metrics.end_equity=bump(step.metrics.end_equity,'-1e-18');}],
    ['CROSS_CHECK_RETURN',step=>{step.metrics.net_return_percent=bump(step.metrics.net_return_percent,'1e-18');},step=>{step.metrics.net_return_percent=bump(step.metrics.net_return_percent,'-1e-18');}],
    ['CROSS_CHECK_DRAWDOWN',step=>{step.metrics.max_drawdown_percent=bump(step.metrics.max_drawdown_percent,'1e-18');},step=>{step.metrics.max_drawdown_percent=bump(step.metrics.max_drawdown_percent,'-1e-18');}],
    ['CROSS_CHECK_FEES',step=>{step.fees_total=bump(step.fees_total,'1e-18');},step=>{step.fees_total=bump(step.fees_total,'-1e-18');}],
    ['CROSS_CHECK_SLIPPAGE',step=>{step.slippage_cost_incl_tick_total=bump(step.slippage_cost_incl_tick_total,'1e-18');},step=>{step.slippage_cost_incl_tick_total=bump(step.slippage_cost_incl_tick_total,'-1e-18');}],
    ['CROSS_CHECK_EXPOSURE',step=>{step.exposure.bars+=1;},step=>{step.exposure.bars-=1;}],
    // exposure_percent is rounded once to 12 places, so the smallest visible step of the fraction is 1e-14 (1e-12 percentage points).
    ['CROSS_CHECK_EXPOSURE',step=>{step.exposure.fraction=bump(step.exposure.fraction,'1e-14');},step=>{step.exposure.fraction=bump(step.exposure.fraction,'-1e-14');}]
  ];
  for(const kind of ['base','stress']){
    for(const [detail,up,down] of figures){
      for(const edit of [up,down]){
        const result=evaluate(input=>edit(input.fixed_result[kind]));
        integrity(result,detail);
        assert.equal(result.body,undefined);
        assert.equal(result.body_hash,undefined);
      }
    }
  }
});
test('A3 exposure is pinned exactly (P3): the in-market count is an integer, the fraction is count / bars at 18 places, the percent is count / bars at 12',()=>{
  // The smallest 18-place change of the fraction used to hide under the 12-place rounding of the percent; it is now a difference.
  for(const kind of ['base','stress']){
    for(const step of ['1e-18','-1e-18']){
      integrity(evaluate(input=>{input.fixed_result[kind].exposure.fraction=bump(input.fixed_result[kind].exposure.fraction,step);}),'CROSS_CHECK_EXPOSURE');
    }
    for(const count of ['2',2.5,null,1,3,-2]){
      integrity(evaluate(input=>{input.fixed_result[kind].exposure.bars_in_market=count;}),'CROSS_CHECK_EXPOSURE');
    }
    integrity(evaluate(input=>{delete input.fixed_result[kind].exposure.bars_in_market;}),'CROSS_CHECK_EXPOSURE');
  }
  // A consistent 3-bar pair (count 3, fraction 1) is exact for itself but differs from the valuation (which is in market on 2 bars).
  integrity(evaluate(input=>{input.fixed_result.base.exposure.bars_in_market=3;input.fixed_result.base.exposure.fraction='1';}),'CROSS_CHECK_EXPOSURE');
  // The evaluator rounds count / bars to 18 places half-even: 2/3 is 0.666666666666666667 and a truncated 0.666666666666666666 is refused.
  assert.equal(BASE.result.base.exposure.fraction,'0.666666666666666667');
  integrity(evaluate(input=>{input.fixed_result.base.exposure.fraction='0.666666666666666666';}),'CROSS_CHECK_EXPOSURE');
  assert.equal(evaluate(input=>{input.fixed_result.base.exposure.fraction='0.6666666666666666670';}).ok,true); // spelling only
});
test('A3 a missing or unreadable evaluator figure refuses',()=>{
  integrity(evaluate(input=>{delete input.fixed_result.base.metrics.end_equity;}),'CROSS_CHECK_END_NAV');
  integrity(evaluate(input=>{input.fixed_result.stress.metrics.net_return_percent='abc';}),'CROSS_CHECK_RETURN');
  integrity(evaluate(input=>{input.fixed_result.base.metrics.max_drawdown_percent=null;}),'CROSS_CHECK_DRAWDOWN');
  integrity(evaluate(input=>{input.fixed_result.base.exposure.fraction='abc';}),'CROSS_CHECK_EXPOSURE');
  integrity(evaluate(input=>{delete input.fixed_result.base.exposure.fraction;}),'CROSS_CHECK_EXPOSURE');
  integrity(evaluate(input=>{input.fixed_result.base.exposure.bars='3';}),'CROSS_CHECK_EXPOSURE');
  // Spelling is not a difference: 9986.010 equals 9986.01.
  assert.equal(evaluate(input=>{input.fixed_result.base.metrics.end_equity='9986.0100';}).ok,true);
  // The first failure wins and base is checked before stress, table order inside a step.
  integrity(evaluate(input=>{input.fixed_result.stress.metrics.end_equity=bump(input.fixed_result.stress.metrics.end_equity);input.fixed_result.base.fees_total=bump(input.fixed_result.base.fees_total);}),'CROSS_CHECK_FEES');
  integrity(evaluate(input=>{input.fixed_result.base.fees_total=bump(input.fixed_result.base.fees_total);input.fixed_result.base.metrics.end_equity=bump(input.fixed_result.base.metrics.end_equity);}),'CROSS_CHECK_END_NAV');
});
test('A3 the stored valuation is the valueRun output, not an evaluator figure (identical here, so a copy and a recomputation cannot differ)',()=>{
  assert.equal(okBase.body.valuation.end_nav,BASE.result.base.metrics.end_equity);
  assert.equal(okBase.body.valuation.end_nav,'9986.01');
  // net_return_percent in the body metrics is the 12-place rounded valueRun figure.
  assert.equal(okBase.body.metrics.net_return_percent,okBase.body.valuation.net_return_percent);
});
test('A3 cash must equal sizing equity: a profile with another equity refuses CASH_EQUITY',()=>{
  const other=build({cash:'10000',equity:'20000'});
  integrity(evaluationRecordBody(evaluationInput(other)),'CASH_EQUITY');
  const spelled=build({cash:'10000.00',equity:'10000'}); // equal decimals, another spelling
  assert.equal(evaluationRecordBody(evaluationInput(spelled)).ok,true);
});
test('A3 the rejected count and the completed episode count must be non-negative integers',()=>{
  integrity(evaluate(input=>{delete input.fixed_result.base.rejected.intents_total;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.intents_total=-1;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.intents_total='2';}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.episodes.completed_count=1.5;}),'EPISODES_SHAPE');
  integrity(evaluate(input=>{delete input.fixed_result.base.episodes.completed_count;}),'EPISODES_SHAPE');
  // P3 consistency: intents_total is total minus the orphan exits, and completed_count is the length of the completed list.
  integrity(evaluate(input=>{input.fixed_result.base.rejected.intents_total=3;}),'REJECTED_SHAPE'); // equals total, orphans ignored
  integrity(evaluate(input=>{input.fixed_result.base.rejected.intents_total=1;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.total=4;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.total='3';}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.orphan_exits.refused_entry=1;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.orphan_exits.warmup_entry=-1;input.fixed_result.base.rejected.intents_total=4;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.orphan_exits.warmup_entry='1';}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.rejected.orphan_exits=null;}),'REJECTED_SHAPE');
  integrity(evaluate(input=>{delete input.fixed_result.base.rejected.orphan_exits;}),'REJECTED_SHAPE');
  assert.equal(evaluate(input=>{input.fixed_result.base.rejected.orphan_exits.refused_entry=1;input.fixed_result.base.rejected.intents_total=1;}).ok,true);
  integrity(evaluate(input=>{input.fixed_result.base.episodes.completed_count=0;}),'EPISODES_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.episodes.completed_count=2;}),'EPISODES_SHAPE');
  integrity(evaluate(input=>{input.fixed_result.base.episodes.completed=null;}),'EPISODES_SHAPE');
  integrity(evaluate(input=>{delete input.fixed_result.base.episodes.completed;}),'EPISODES_SHAPE');
  assert.equal(evaluate(input=>{input.fixed_result.base.episodes.completed=[];input.fixed_result.base.episodes.completed_count=0;}).ok,true);
  // Only the base step feeds the metrics, episodes and rejected counts (Q1).
  assert.equal(evaluate(input=>{input.fixed_result.stress.rejected.intents_total=99;input.fixed_result.stress.episodes.completed_count=99;}).body_hash,okBase.body_hash);
});

/* ------------------------------------------------------------------ A4 lineage and purpose */
test('A4 each row of 5.2 refuses with its detail when its single input changes',()=>{
  integrity(evaluationRecordBody(evaluationInput(build({purpose:'QR4_SELECTION'}))),'PURPOSE'); // a valid QR4_SELECTION result
  integrity(evaluate(input=>{input.comparison_id='cmp-other';}),'LINEAGE_OBJECT');
  integrity(evaluate(input=>{input.participant_id=OTHER;}),'LINEAGE_PARENT'); // in the spec, but not the run of the result
  integrity(evaluate(input=>{input.participant_id='run-unknown';}),'LINEAGE_PARENT'); // lineage is checked before spec membership
  integrity(evaluate(input=>{input.spec.participants=[OTHER,'run-third'];}),'PARTICIPANT_NOT_IN_SPEC');
  integrity(evaluate(input=>{input.spec.participants='run-parent';}),'PARTICIPANT_NOT_IN_SPEC');
  integrity(evaluate(input=>{delete input.spec.participants;}),'PARTICIPANT_NOT_IN_SPEC');
  for(const runId of ['','bad id!','-lead',7,null,'x'.repeat(129)]){
    integrity(evaluate(input=>{input.evaluation_run_id=runId;}),'EVALUATION_RUN_ID');
  }
  assert.equal(evaluate(input=>{input.evaluation_run_id='a'.repeat(128);}).ok,true);
});
test('A4 the order of 5.2: purpose, object, parent, spec membership, run id',()=>{
  const qr4=build({purpose:'QR4_SELECTION'});
  const all=evaluationInput(qr4);
  Object.assign(all,{comparison_id:'cmp-other',participant_id:'run-unknown',evaluation_run_id:'bad id!'});
  all.spec.participants=['run-third'];
  integrity(evaluationRecordBody(all),'PURPOSE');
  const object=evaluationInput(BASE);
  Object.assign(object,{comparison_id:'cmp-other',participant_id:'run-unknown',evaluation_run_id:'bad id!'});
  object.spec.participants=['run-third'];
  integrity(evaluationRecordBody(object),'LINEAGE_OBJECT');
  const parent=evaluationInput(BASE);
  Object.assign(parent,{participant_id:'run-unknown',evaluation_run_id:'bad id!'});
  parent.spec.participants=['run-third'];
  integrity(evaluationRecordBody(parent),'LINEAGE_PARENT');
  const member=evaluationInput(BASE);
  member.evaluation_run_id='bad id!';
  member.spec.participants=['run-third'];
  integrity(evaluationRecordBody(member),'PARTICIPANT_NOT_IN_SPEC');
});

/* ------------------------------------------------------------------ A5 numbers */
test('A5 a JavaScript number in a money or metric position refuses NUMBER_NOT_DECIMAL_STRING',()=>{
  const positions=[
    ['initial_equity',step=>{step.initial_equity=10000;}],
    ['end_equity',step=>{step.metrics.end_equity=9986.01;}],
    ['net_return_percent',step=>{step.metrics.net_return_percent=-0.1399;}],
    ['max_drawdown_percent',step=>{step.metrics.max_drawdown_percent=1.1;}],
    ['fraction',step=>{step.exposure.fraction=0.5;}],
    ['fill quantity',step=>{step.fills[0].quantity=10;}],
    ['fill price',step=>{step.fills[0].price=100.1;}],
    ['fill fee',step=>{step.fills[1].fee=0.989;}],
    ['fill slippage',step=>{step.fills[1].slippage_cost_incl_tick=1;}]
  ];
  for(const kind of ['base','stress']){
    for(const [name,edit] of positions){
      const result=evaluate(input=>edit(input.fixed_result[kind]));
      assert.equal(result.ok,false,`${kind} ${name}`);
      numberRefused(result);
    }
  }
  numberRefused(evaluate(input=>{input.rows[WARMUP+1].close=110;}));
  numberRefused(benchmarkRecordBody(benchmarkInput(BASE,{rows:structuredClone(BASE.rows).map((row,index)=>index===WARMUP?{...row,close:100}:row)})));
  // A number in a warm-up row is not a scored position and is not read.
  assert.equal(evaluate(input=>{input.rows[3].close=7;}).ok,true);
});
test('A5 a number in a stored evaluation metric of an outcome input refuses NUMBER_NOT_DECIMAL_STRING',()=>{
  for(const edit of [metrics=>{metrics.net_return_percent=1.5;},metrics=>{metrics.max_drawdown_percent=1;},metrics=>{metrics.total_fees=1;},metrics=>{metrics.exposure_percent=40;},
    metrics=>{metrics.total_slippage=2;},metrics=>{metrics.total_slippage={value:2,reason:null};}]){
    const input=outcomeInput();
    edit(input.participants[0].evaluation.body.metrics);
    numberRefused(outcomeRecord(input));
  }
});

/* ------------------------------------------------------------------ A6 benchmark */
test('A6 benchmark: id constant, entry derived by hand, same grid and same window',()=>{
  const result=okBenchmark.body.result;
  assert.equal(okBenchmark.body.benchmark_id,'qr3-bh-close-same-cost-v1');
  assert.equal(result.ok,true);
  assert.equal(result.version,'qr3-bh-close-same-cost-v1');
  assert.equal(result.method,'BUY_AND_HOLD_FIRST_BAR_CLOSE_SAME_COST');
  // Hand: close 100, slippage 10 bps -> 100.1 (tick 0.01); quantity floor(10000 / (100.1 * 1.001) / 0.001) * 0.001 = 99.8;
  // notional 99.8 * 100.1 = 9989.98; fee 10 bps = 9.98998; residual cash 0.03002; slippage cost 99.8 * 0.1 = 9.98; last close 99.
  assert.deepEqual(result.entry,{bar_time_ms:BASE.S,price:'100.1',quantity:'99.8',notional:'9989.98',fee:'9.98998',residual_cash:'0.03002'});
  assert.equal(result.valuation.end_nav,'9880.23002'); // 0.03002 + 99.8 * 99
  assert.equal(result.net_return_percent_exact,'-1.1976998');
  assert.equal(result.valuation.start_nav,'10000');
  assert.equal(result.valuation.bars,3);
  assert.equal(result.liquidation_line,null);
  assert.equal(result.funding,'NONE');
  assert.equal(result.valuation.end_treatment,CODES.VALUATION_BASIS_UNCONFIRMED);
  assert.equal(Object.hasOwn(result.valuation,'nav_series'),false);
  assert.equal(result.valuation.nav_points,3);
  // The series the hash covers: NAV at the three bar closes, 0.03002 + 99.8 * (100, 110, 99).
  const series=[{time_ms:BASE.S,nav:'9980.03002'},{time_ms:BASE.S+MINUTE,nav:'10978.03002'},{time_ms:BASE.S+2*MINUTE,nav:'9880.23002'}];
  assert.equal(result.valuation.nav_series_sha256,hash(canonical(series)));
});
test('A6 benchmark uses the base cost model of the frozen contract (Q4), never the doubled stress model',()=>{
  // Slippage 20 bps: price ceil(100 * 1.002) = 100.2; quantity floor(10000 / (100.2 * 1.001) / 0.001) * 0.001 = 99.7;
  // notional 99.7 * 100.2 = 9989.94; fee 10 bps = 9.98994; residual cash 10000 - 9989.94 - 9.98994 = 0.07006.
  const wide=build({cost:{slippage_bps:'20'}});
  assert.deepEqual(benchmarkRecordBody(benchmarkInput(wide)).body.result.entry,{bar_time_ms:wide.S,price:'100.2',quantity:'99.7',notional:'9989.94',fee:'9.98994',residual_cash:'0.07006'});
  // Zero cost: buy 100 units at the close 100 (tick and step are exact), no fee, no residual.
  const free=build({cost:{fee_bps:'0',slippage_bps:'0'}});
  assert.deepEqual(benchmarkRecordBody(benchmarkInput(free)).body.result.entry,{bar_time_ms:free.S,price:'100',quantity:'100',notional:'10000',fee:'0',residual_cash:'0'});
});
test('A6 unreadable bars give a null line with QR3_BENCHMARK_DATA_UNAVAILABLE, and the comparison is not refused',()=>{
  for(const close of ['abc','0','-5','',null]){
    const rows=structuredClone(BASE.rows);
    rows[WARMUP+1].close=close;
    const result=benchmarkRecordBody(benchmarkInput(BASE,{rows}));
    assert.equal(result.ok,true,String(close));
    assert.deepEqual(result.body.result,{ok:false,code:CODES.QR3_BENCHMARK_DATA_UNAVAILABLE,detail:CODES.QR3_DATASET_UNAVAILABLE,value:null});
    assert.equal(result.body.benchmark_id,'qr3-bh-close-same-cost-v1');
    assert.equal(result.body_hash,hash(canonical(result.body)));
  }
  // The first scored bar unreadable is the same null line.
  const rows=structuredClone(BASE.rows);
  rows[WARMUP].close='x';
  assert.equal(benchmarkRecordBody(benchmarkInput(BASE,{rows})).body.result.code,CODES.QR3_BENCHMARK_DATA_UNAVAILABLE);
});
test('A6 one unaffordable quantity step gives a null line with NO_UNITS_AFFORDABLE',()=>{
  const poor=build({cash:'50',quantityStep:'1'}); // 50 / 100.2001 is below one whole unit
  const result=benchmarkRecordBody(benchmarkInput(poor));
  assert.equal(result.ok,true);
  assert.deepEqual(result.body.result,{ok:false,code:CODES.QR3_METRIC_UNAVAILABLE,detail:'NO_UNITS_AFFORDABLE',value:null});
  const exact=build({cash:'101',quantityStep:'1'}); // exactly one unit is affordable: 100.1 + fee 0.1001 = 100.2001 <= 101
  const entry=benchmarkRecordBody(benchmarkInput(exact)).body.result.entry;
  assert.deepEqual([entry.quantity,entry.notional,entry.fee],['1','100.1','0.1001']);
});
test('A6 benchmark window and basis',()=>{
  assert.deepEqual(okBenchmark.body.window,{start_ms:BASE.S,end_ms:BASE.E});
  assert.deepEqual(okBenchmark.body.result.valuation.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
});

/* ------------------------------------------------------------------ A7 outcome */
const statusInput=(patch={})=>({integrity_ok:true,unavailable:false,compatibility:{compatible:true},coverage:{state:'PASS'},
  evidence:{evidence_class:'INDEPENDENT',reasons:[]},episode_gate_available:true,completed_episodes:25,...patch});
function outcomeInput(patch={}){
  const first=structuredClone(okBase.body),second=structuredClone(okBase.body);
  second.participant_id=OTHER;
  second.metrics.net_return_percent='12.5';
  return structuredClone({spec:BASE.spec,spec_hash:BASE.specHash,context_key:CONTEXT,participants:[
    {participant_id:PARTICIPANT,status_input:statusInput(),evaluation:{body:first,created_at_ms:BASE.E+1000}},
    {participant_id:OTHER,status_input:statusInput(),evaluation:{body:second,created_at_ms:BASE.E+2000}}],...patch});
}
test('A7 outcome: exactly the OUTCOME_FIELDS, version, mode, spec hash and context key, NO_QUALIFIED_RESULT',()=>{
  const result=outcomeRecord(outcomeInput());
  assert.equal(result.ok,true,JSON.stringify(result).slice(0,300));
  const record=Object.fromEntries(OUTCOME_FIELDS.map(field=>[field,result[field]]));
  assert.deepEqual(Object.keys(result).sort(),['code','detail','ok',...OUTCOME_FIELDS,'outcome_hash'].sort());
  assert.equal(record.version,'qr3-outcome-v1');
  assert.equal(record.mode,'STANDARDIZED');
  assert.equal(record.spec_hash,BASE.specHash);
  assert.equal(record.context_key,CONTEXT);
  assert.equal(record.outcome,'NO_QUALIFIED_RESULT');
  assert.equal(record.only_qualified_participant_id,null);
  assert.equal(record.uncertainty,null);
  assert.deepEqual(record.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]); // R1 is stated on the outcome too, also when no participant is evaluated
  // quant_comparison_outcomes_body_check and the digest: the writer stores exactly these nine fields and the hash of their canonical text.
  assert.equal(result.outcome_hash,hash(canonical(record)));
  assert.match(result.outcome_hash,/^[0-9a-f]{64}$/);
  assert.ok(Buffer.byteLength(canonical(record),'utf8')<=262144);
  assert.deepEqual(result.participants.map(item=>item.id).sort(),[...BASE.spec.participants].sort());
  for(const item of result.participants){
    assert.equal(item.status,'DEVELOPMENT_EVIDENCE');
    assert.deepEqual(item.reasons,[CODES.VALUATION_BASIS_UNCONFIRMED]);
    assert.equal(item.rank,null);
    assert.equal(item.label,null);
  }
  const byId=Object.fromEntries(result.participants.map(item=>[item.id,item]));
  assert.deepEqual([byId[PARTICIPANT].created_at_ms,byId[OTHER].created_at_ms],[BASE.E+1000,BASE.E+2000]); // the stored record time
  assert.deepEqual([byId[PARTICIPANT].primary_metric,byId[OTHER].primary_metric],['-0.1399','12.5']);
  assert.deepEqual(outcomeRecord(outcomeInput()),result); // deterministic
});
test('A7 inputs that would otherwise be eligible still give NO_QUALIFIED_RESULT and never SINGLE_QUALIFIED_RESULT',()=>{
  const result=outcomeRecord(outcomeInput());
  assert.notEqual(result.outcome,'SINGLE_QUALIFIED_RESULT');
  assert.equal(result.outcome,'NO_QUALIFIED_RESULT');
  // One participant that is ready in every other check, one that is not evaluated: still no qualified label and no only-qualified id.
  const single=outcomeInput();
  single.participants[1]={participant_id:OTHER,status_input:statusInput(),evaluation:null};
  const one=outcomeRecord(single);
  assert.equal(one.outcome,'NO_QUALIFIED_RESULT');
  assert.equal(one.only_qualified_participant_id,null);
  assert.ok(one.participants.every(item=>item.label===null&&item.rank===null));
  for(const item of one.participants.filter(entry=>entry.id===PARTICIPANT))assert.equal(item.status,'DEVELOPMENT_EVIDENCE');
  // Metrics that look excellent do not change that.
  const strong=outcomeInput();
  for(const entry of strong.participants){entry.evaluation.body.metrics.net_return_percent='99';entry.evaluation.body.metrics.max_drawdown_percent='1';}
  const best=outcomeRecord(strong);
  assert.equal(best.outcome,'NO_QUALIFIED_RESULT');
  assert.ok(best.participants.every(item=>item.status==='DEVELOPMENT_EVIDENCE'&&item.rank===null));
});
test('A7 participants without a stored evaluation: NOT_EVALUATED has none; excluded and unavailable participants are not ranked',()=>{
  const input=outcomeInput();
  input.participants[0].evaluation=null;
  input.participants[1].evaluation=null;
  const none=outcomeRecord(input);
  assert.equal(none.ok,true);
  assert.deepEqual(none.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
  assert.deepEqual(none.participants.map(item=>[item.status,item.created_at_ms,item.primary_metric]),[['NOT_EVALUATED',0,null],['NOT_EVALUATED',0,null]]);
  assert.equal(none.outcome,'NO_QUALIFIED_RESULT');
  const mixed=outcomeInput();
  mixed.participants[0].evaluation=null;
  mixed.participants[0].status_input=statusInput({unavailable:true});
  mixed.participants[1].status_input=statusInput({coverage:{state:'FAIL'}});
  const result=outcomeRecord(mixed);
  const byId=Object.fromEntries(result.participants.map(item=>[item.id,item]));
  assert.equal(byId[PARTICIPANT].status,'UNAVAILABLE');
  assert.equal(byId[OTHER].status,'EXCLUDED_COVERAGE'); // a stored record is allowed beside an excluded status
  assert.equal(result.outcome,'NO_QUALIFIED_RESULT');
  const incompatible=outcomeInput();
  incompatible.participants[0].status_input=statusInput({integrity_ok:false});
  incompatible.participants[1].status_input=statusInput({compatibility:{compatible:false}});
  assert.deepEqual(outcomeRecord(incompatible).participants.map(item=>item.status).sort(),['EXCLUDED_INCOMPATIBLE','EXCLUDED_INTEGRITY']);
});
test('A7 a record beside a NOT_EVALUATED evidence class is an evaluation mismatch',()=>{
  const input=outcomeInput();
  input.participants[0].status_input=statusInput({evidence:{evidence_class:'NOT_EVALUATED',reasons:[]}});
  integrity(outcomeRecord(input),'OUTCOME_EVALUATION_MISMATCH');
  const ok=outcomeInput();
  ok.participants[0].evaluation=null;
  ok.participants[0].status_input=statusInput({evidence:{evidence_class:'NOT_EVALUATED',reasons:[]}});
  assert.equal(outcomeRecord(ok).ok,true);
});
test('A7 hidden metrics (P2): an excluded or unavailable participant with a stored record keeps no primary metric',()=>{
  const cases=[
    ['EXCLUDED_INCOMPATIBLE',{compatibility:{compatible:false}}],
    ['EXCLUDED_COVERAGE',{coverage:{state:'FAIL'}}],
    ['EXCLUDED_INTEGRITY',{integrity_ok:false}],
    ['UNAVAILABLE',{unavailable:true}]
  ];
  for(const [expected,patch] of cases){
    const input=outcomeInput();
    input.participants[0].status_input=statusInput(patch); // keeps its stored record with net return -0.1399
    const result=outcomeRecord(input);
    assert.equal(result.ok,true,expected);
    const hidden=result.participants.find(item=>item.id===PARTICIPANT);
    assert.equal(hidden.status,expected);
    assert.equal(hidden.primary_metric,null,expected);
    assert.equal(hidden.created_at_ms,BASE.E+1000,expected); // the stored record time stays (the SQL time match for UNAVAILABLE with a row)
    assert.equal(JSON.stringify(result).includes('-0.1399'),false,expected);
    // The visible participant of the same outcome keeps its figure.
    assert.equal(result.participants.find(item=>item.id===OTHER).primary_metric,'12.5');
  }
  // Evaluated (visible) participants keep it, and one without a record has none.
  const shown=outcomeRecord(outcomeInput());
  assert.equal(shown.participants.find(item=>item.id===PARTICIPANT).primary_metric,'-0.1399');
});
test('A7 a stored evaluation body must belong to its entry (P3): version, participant, spec hash and basis',()=>{
  const edit=change=>{const input=outcomeInput();change(input.participants[0].evaluation.body);return outcomeRecord(input);};
  integrity(edit(body=>{body.version='qr3-evaluation-record-v2';}),'OUTCOME_EVALUATION_MISMATCH');
  integrity(edit(body=>{delete body.version;}),'OUTCOME_EVALUATION_MISMATCH');
  integrity(edit(body=>{body.participant_id=OTHER;}),'OUTCOME_EVALUATION_MISMATCH');
  integrity(edit(body=>{body.participant_id='zzz';}),'OUTCOME_EVALUATION_MISMATCH');
  integrity(edit(body=>{body.record_spec_hash='0'.repeat(64);}),'OUTCOME_EVALUATION_MISMATCH');
  integrity(edit(body=>{delete body.record_spec_hash;}),'OUTCOME_EVALUATION_MISMATCH');
  assert.equal(edit(body=>{body.record_comparison_id='cmp-other';}).ok,true); // the comparison id is not part of the ruling; the database ties it
  // The check applies to a hidden-metric participant too: a record is read for every entry that has one.
  const hidden=outcomeInput();
  hidden.participants[0].status_input=statusInput({unavailable:true});
  hidden.participants[0].evaluation.body.participant_id=OTHER;
  integrity(outcomeRecord(hidden),'OUTCOME_EVALUATION_MISMATCH');
});
test('A7 participant ids must equal spec.participants exactly',()=>{
  const missing=outcomeInput();
  missing.participants.pop();
  refused(outcomeRecord(missing),CODES.INVALID_FIELDS,'PARTICIPANTS_DIFFER_FROM_SPEC');
  const extra=outcomeInput();
  extra.participants.push({participant_id:'run-third',status_input:statusInput(),evaluation:null});
  refused(outcomeRecord(extra),CODES.INVALID_FIELDS,'PARTICIPANTS_DIFFER_FROM_SPEC');
  const renamed=outcomeInput();
  renamed.participants[1].participant_id='run-third';
  refused(outcomeRecord(renamed),CODES.INVALID_FIELDS,'PARTICIPANTS_DIFFER_FROM_SPEC');
  const duplicate=outcomeInput();
  duplicate.participants[1].participant_id=PARTICIPANT;
  refused(outcomeRecord(duplicate),CODES.DUPLICATE_RUN_ID,null);
  const bad=outcomeInput();
  bad.participants[1].participant_id='bad id!';
  refused(outcomeRecord(bad),CODES.INVALID_RUN_ID,null);
  const none=outcomeInput();
  none.participants=[];
  refused(outcomeRecord(none),CODES.INVALID_FIELDS,'PARTICIPANTS');
  none.participants='x';
  refused(outcomeRecord(none),CODES.INVALID_FIELDS,'PARTICIPANTS');
  const noList=outcomeInput();
  delete noList.spec.participants;
  noList.spec_hash=specHashOf(noList.spec);
  refused(outcomeRecord(noList),CODES.INVALID_FIELDS,'PARTICIPANTS_DIFFER_FROM_SPEC');
});
test('A7 a spec hash that differs from the recomputed hash refuses QR3_SPEC_IMMUTABLE',()=>{
  refused(outcomeRecord(outcomeInput({spec_hash:'0'.repeat(64)})),CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH');
  refused(outcomeRecord(outcomeInput({spec_hash:null})),CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH');
  const changed=outcomeInput();
  changed.spec.uncertainty.seed='seed-2'; // a changed seed changes the recomputed hash
  refused(outcomeRecord(changed),CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH');
  // A hash that matches a spec which is not the registry normal form is refused by decideOutcome and passed through.
  const loosened=outcomeInput();
  loosened.spec.risk_filter.max_drawdown_percent='30';
  loosened.spec_hash=specHashOf(loosened.spec);
  for(const entry of loosened.participants)entry.evaluation.body.record_spec_hash=loosened.spec_hash;
  refused(outcomeRecord(loosened),CODES.QR3_SPEC_INCOMPLETE,'SPEC');
});
test('A7 input shape of the outcome record',()=>{
  const bad=(patch,detail)=>refused(outcomeRecord(outcomeInput(patch)),CODES.INVALID_FIELDS,detail);
  bad({extra:1},'INPUT');
  bad({context_key:'ck'},'CONTEXT_KEY');
  bad({context_key:'C'.repeat(64)},'CONTEXT_KEY');
  bad({context_key:7},'CONTEXT_KEY');
  bad({spec:null},'SPEC');
  const input=outcomeInput();
  delete input.context_key;
  refused(outcomeRecord(input),CODES.INVALID_FIELDS,'INPUT');
  const entry=edit=>{const next=outcomeInput();edit(next.participants[0]);return outcomeRecord(next);};
  refused(entry(item=>{item.extra=1;}),CODES.INVALID_FIELDS,'PARTICIPANT_ENTRY');
  refused(entry(item=>{delete item.evaluation;}),CODES.INVALID_FIELDS,'PARTICIPANT_ENTRY');
  refused(entry(item=>{item.status_input=null;}),CODES.INVALID_FIELDS,'STATUS_INPUT');
  refused(entry(item=>{item.status_input.surprise=true;}),CODES.INVALID_FIELDS,'STATUS_INPUT');
  for(const name of ['has_evaluation','evaluation','spec'])refused(entry(item=>{item.status_input[name]=name==='has_evaluation'?true:{};}),CODES.INVALID_FIELDS,'STATUS_INPUT');
  for(const evaluation of [{},{body:{metrics:{}}},{body:{metrics:{}},created_at_ms:-1},{body:{metrics:{}},created_at_ms:1.5},{body:{metrics:{}},created_at_ms:'1'},
    {body:null,created_at_ms:1},{body:{},created_at_ms:1},{body:{metrics:{}},created_at_ms:1,extra:1},undefined,'x'])refused(entry(item=>{item.evaluation=evaluation;}),CODES.INVALID_FIELDS,'EVALUATION');
});

/* ------------------------------------------------------------------ A8 basis */
test('A8 every evaluation body states basis_confirmed false and VALUATION_BASIS_UNCONFIRMED; the end treatment is unconfirmed everywhere',()=>{
  const body=okBase.body;
  assert.equal(body.basis_confirmed,false);
  assert.deepEqual(body.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
  assert.equal(body.valuation.end_treatment,CODES.VALUATION_BASIS_UNCONFIRMED);
  assert.equal(body.stress_valuation.end_treatment,CODES.VALUATION_BASIS_UNCONFIRMED);
  assert.deepEqual(body.valuation.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
  assert.deepEqual(body.stress_valuation.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
  assert.equal(okBenchmark.body.result.valuation.end_treatment,CODES.VALUATION_BASIS_UNCONFIRMED);
  assert.equal(JSON.stringify(okBase.body).includes('MARK_AT_END_CLOSE'),false);
  assert.equal(JSON.stringify(okBenchmark.body).includes('MARK_AT_END_CLOSE'),false);
});
test('A8 an input carrying a basis_confirmed key refuses INVALID_FIELDS BASIS_CONFIRMED, whatever its value',()=>{
  for(const value of [true,false,'true',null,undefined,1]){
    refused(evaluate(input=>{input.basis_confirmed=value;}),CODES.INVALID_FIELDS,'BASIS_CONFIRMED');
    const benchmark=benchmarkInput();benchmark.basis_confirmed=value;
    refused(benchmarkRecordBody(benchmark),CODES.INVALID_FIELDS,'BASIS_CONFIRMED');
    refused(outcomeRecord(outcomeInput({basis_confirmed:value})),CODES.INVALID_FIELDS,'BASIS_CONFIRMED');
    const entry=outcomeInput();entry.participants[0].basis_confirmed=value;
    refused(outcomeRecord(entry),CODES.INVALID_FIELDS,'BASIS_CONFIRMED');
    const status=outcomeInput();status.participants[0].status_input.basis_confirmed=value;
    refused(outcomeRecord(status),CODES.INVALID_FIELDS,'BASIS_CONFIRMED');
  }
  // A stored body claiming basis_confirmed true (or missing the key) is refused (P3); S3a passes false itself in any case.
  for(const claim of [true,'false',null,undefined]){
    const claimed=outcomeInput();
    claimed.participants[0].evaluation.body.basis_confirmed=claim;
    integrity(outcomeRecord(claimed),'OUTCOME_EVALUATION_MISMATCH');
  }
  const missing=outcomeInput();
  delete missing.participants[0].evaluation.body.basis_confirmed;
  integrity(outcomeRecord(missing),'OUTCOME_EVALUATION_MISMATCH');
  const flat=outcomeInput();
  flat.participants[0].evaluation.basis_confirmed=true;
  refused(outcomeRecord(flat),CODES.INVALID_FIELDS,'BASIS_CONFIRMED');
});

/* ------------------------------------------------------------------ A9 immutability */
test('A9 inputs are deep-equal before and after each call; outputs are deep frozen and share nothing with the inputs',()=>{
  const isFrozenDeep=value=>{
    if(value===null||typeof value!=='object')return true;
    return Object.isFrozen(value)&&Object.values(value).every(isFrozenDeep);
  };
  const touched=value=>{
    if(value===null||typeof value!=='object')return false;
    return Object.isFrozen(value)||Object.values(value).some(touched);
  };
  const evaluation=evaluationInput();
  const evaluationBefore=structuredClone(evaluation);
  const evaluationResult=evaluationRecordBody(evaluation);
  assert.deepEqual(evaluation,evaluationBefore);
  assert.equal(touched(evaluation),false,'no input object was frozen');
  assert.ok(isFrozenDeep(evaluationResult));
  const benchmark=benchmarkInput();
  const benchmarkBefore=structuredClone(benchmark);
  const benchmarkResult=benchmarkRecordBody(benchmark);
  assert.deepEqual(benchmark,benchmarkBefore);
  assert.equal(touched(benchmark),false);
  assert.ok(isFrozenDeep(benchmarkResult));
  const outcome=outcomeInput();
  const outcomeBefore=structuredClone(outcome);
  const outcomeResult=outcomeRecord(outcome);
  assert.deepEqual(outcome,outcomeBefore);
  assert.equal(touched(outcome),false);
  assert.ok(isFrozenDeep(outcomeResult));
  // Refusals are frozen too, and a null-line benchmark body.
  const refusal=evaluate(input=>{input.comparison_id='cmp-other';});
  assert.ok(isFrozenDeep(refusal));
  const rows=structuredClone(BASE.rows);rows[WARMUP].close='x';
  assert.ok(isFrozenDeep(benchmarkRecordBody(benchmarkInput(BASE,{rows}))));
  // The fixed-evaluation result and the spec are the caller's own and stay writable.
  evaluation.fixed_result.base.fees_total='9';evaluation.spec.period.start_ms=1;evaluation.rows[0].close='7';
  assert.equal(evaluationResult.body.valuation.total_fees,'1.99');
  assert.equal(evaluationResult.body.window.start_ms,BASE.S);
  assert.notEqual(evaluationResult.body.rejected,evaluation.fixed_result.base.rejected);
  assert.throws(()=>{evaluationResult.body.rejected.total=99;},TypeError);
  assert.throws(()=>{evaluationResult.body.valuation.nav_series.push({});},TypeError);
  assert.throws(()=>{outcomeResult.participants[0].status='ELIGIBLE_QUALIFIED';},TypeError);
});

/* ------------------------------------------------------------------ A10 static source */
test('A10 the module source imports no file, network, process or database module, no postgres store, and reads no clock or random source',()=>{
  const source=fs.readFileSync(fileURLToPath(new URL('../src/comparison/evaluation-record.js',import.meta.url)),'utf8');
  const specifiers=[...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match=>match[1]);
  assert.deepEqual([...specifiers].sort(),['../quant-research/fixed-eval-contract.js','./common.js','./evidence.js','./ranking.js','./valuation.js']);
  for(const forbidden of [/node:fs/,/node:net/,/node:child_process/,/node:http/,/node:https/,/node:dns/,/node:tls/,/node:dgram/,/node:worker_threads/,/from\s+['"]fs['"]/,/from\s+['"]net['"]/,
    /from\s+['"]child_process['"]/,/\bpg\b/,/postgres/i,/comparison-store/,/\bDate\.now\b/,/\bnew Date\b/,/\bMath\.random\b/,/\brandomUUID\b/,/\brequire\s*\(/,/\bimport\s*\(/,/\bprocess\./,
    /\bfetch\s*\(/,/\bperformance\./,/\bsetTimeout\b/,/\bsetInterval\b/])assert.equal(forbidden.test(source),false,String(forbidden));
  // The module is not exported from the S1 index (ruling R5).
  const index=fs.readFileSync(fileURLToPath(new URL('../src/comparison/index.js',import.meta.url)),'utf8');
  assert.equal(/evaluation-record/.test(index),false);
});
