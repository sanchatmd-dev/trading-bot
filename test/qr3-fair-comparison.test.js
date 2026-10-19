import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  MINUTE,DAY,CODES,CODE_PATTERN,QR3_VERSIONS,REGISTRY_DEFAULTS,
  CONTEXT_FIELDS,SUBJECT_FIELDS,contextFields,contextKey,contextMismatches,compareToDeclared,splitParticipant,subjectDifferences,declaredContextProblems,validateRequest,
  resolvePeriod,addMonths,checkDatasetGaps,checkCoverage,
  checkGrid,valueRun,dailyReturns,buyAndHold,excessReturn,
  classifyEvidence,holdoutExposure,exposuresOverlapping,adequacy,evaluationCheck,metricsView,participantStatus,
  BEST_LABEL,TIED_BEST_LABEL,ONLY_QUALIFIED_LABEL,NO_WINNER_TEXT,FIXED_NOTICES,scopeString,validateComparisonView,storedResultView,
  validateSpec,specChangeRefusal,specThresholds,seededRandom,pairedBootstrapInterval,decideOutcome,round18,specHashOf,normaliseDeclared
} from '../src/comparison/index.js';

// Every participant, run and number below is a LABELLED TEST FIXTURE. None is a research result and none is a qualified result.
// Expected values are hand-derived (see the comment above each golden case); the exact-decimal cases were cross-checked with an
// independent BigInt rational oracle that does not use decimal.js.

const U=(y,m,d,h=0,mi=0)=>Date.UTC(y,m-1,d,h,mi);
const iso=ms=>new Date(ms).toISOString();
const T0=U(2026,3,30);
const clone=value=>JSON.parse(JSON.stringify(value));
const grid=(start,closes)=>closes.map((close,index)=>({time_ms:start+index*MINUTE,close}));

/* ------------------------------------------------------------------ 1, 2 context key, mismatches, subject */
const baseContext={mode:'STANDARDIZED',scope:'SPT_CUSTOM_ENGINEERING_ONLY',market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},
  data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.00001'},period:{start_ms:T0,end_ms:T0+1440*MINUTE,evaluation_bars:1440},
  dataset:{digest_kind:'ql3a-dataset-sha256-v1',digest:'d'.repeat(64),first_bar:T0-60*MINUTE,last_bar:T0+1439*MINUTE,bar_count:1500,timestamp_semantics:'bar-open-utc-ms'},
  engine:'e'.repeat(64),execution:{fill_model:'close-adverse-v1',exit_semantics_version:'reduce-only-exit-v3'},
  cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'5'},capital:{initial_cash:'1000',initial_inventory:'0',quote:'USDT'},
  risk_policy:'r'.repeat(64),ledger_initialization:'flat-historical-paper-v1',
  valuation:{price_series:'DATASET_CLOSE',grid_id:'qr3-grid-bar-close-v1',currency:'USDT',fx:'NONE',end_treatment:'MARK_AT_END_CLOSE'},
  benchmark:'qr3-bh-close-same-cost-v1',spec_hash:'s'.repeat(64),validation_protocol:'v'.repeat(64)};
const changes={
  mode:()=>'ACTUAL_BOT',scope:c=>c.scope+'_X',market:c=>({...c.market,symbol:'ETHUSDT'}),data_model:c=>({...c.data_model,price_tick:'0.1'}),
  period:c=>({...c.period,end_ms:c.period.end_ms+MINUTE,evaluation_bars:1441}),dataset:c=>({...c.dataset,digest:'f'.repeat(64)}),engine:c=>c.engine.replace('e','f'),
  execution:c=>({...c.execution,exit_semantics_version:'reduce-only-exit-v4'}),cost_model:c=>({...c.cost_model,fee_bps:'11'}),capital:c=>({...c.capital,initial_cash:'2000'}),
  risk_policy:c=>c.risk_policy.replace('r','q'),ledger_initialization:c=>c.ledger_initialization+'-x',valuation:c=>({...c.valuation,end_treatment:'LIQUIDATE_AT_END'}),
  benchmark:c=>c.benchmark+'-x',spec_hash:c=>c.spec_hash.replace('s','t'),validation_protocol:c=>c.validation_protocol.replace('v','w')};
const ctx=(id,raw=baseContext)=>splitParticipant(id,raw,{});

test('1 context key: contract lists C1 to C16 and each one-field change changes the key and appears in mismatches',()=>{
  assert.equal(CONTEXT_FIELDS.length,16);
  assert.deepEqual([...CONTEXT_FIELDS],['mode','scope','market','data_model','period','dataset','engine','execution','cost_model','capital','risk_policy','ledger_initialization','valuation','benchmark','spec_hash','validation_protocol']);
  const same=[ctx('p1'),ctx('p2')];
  assert.equal(same[0].context_key,same[1].context_key);
  assert.deepEqual(contextMismatches(same),[]);
  for(const field of CONTEXT_FIELDS){
    const raw=clone(baseContext);
    raw[field]=changes[field](baseContext);
    const changed=ctx('p2',raw);
    if(field==='mode'){assert.ok(changed.missing.includes('mode'));continue;}// STANDARDIZED context cannot carry another mode: it reads as MISSING
    assert.deepEqual(changed.missing,[],field);
    assert.notEqual(changed.context_key,same[0].context_key,field);
    const found=contextMismatches([same[0],changed]);
    assert.deepEqual(found.map(item=>item.field),[field],field);
    assert.deepEqual(found[0].values.map(item=>item.participant_id),['p1','p2']);
  }
});
test('1 decimal spelling is not a difference: 10, 10.0 and 1e1 give one key',()=>{
  const a=clone(baseContext),b=clone(baseContext),c=clone(baseContext);
  a.cost_model.fee_bps='10.0';b.cost_model.fee_bps='10.00';c.cost_model.fee_bps='1e1';
  assert.equal(ctx('p',a).context_key,ctx('p').context_key);
  assert.equal(ctx('p',b).context_key,ctx('p').context_key);
  assert.equal(ctx('p',c).context_key,ctx('p').context_key);
});
test('1 subject fields differ and are disclosed but never change the key (source, strategy, parameters, lineage, Bot)',()=>{
  const subject={source_hash:'a',fixed_strategy:'f1',parameters:{atr:2,rr:3},lineage:{seed:'7'},bot_id:'bot-1',library_class:'COMPLETED'};
  const a=splitParticipant('p1',baseContext,subject),b=splitParticipant('p2',baseContext,{...subject,source_hash:'b',fixed_strategy:'f2',parameters:{atr:3,rr:3},bot_id:'bot-2'});
  assert.equal(a.context_key,b.context_key);
  const diffs=subjectDifferences([a,b]);
  assert.deepEqual(diffs.map(item=>item.field).sort(),['bot_id','fixed_strategy','parameters','source_hash']);
  for(const field of SUBJECT_FIELDS){
    const one=splitParticipant('p1',baseContext,{[field]:'x'}),two=splitParticipant('p2',baseContext,{[field]:'y'});
    assert.equal(one.context_key,two.context_key,field);
    assert.deepEqual(subjectDifferences([one,two]).map(item=>item.field),[field],field);
  }
});
test('2 a missing or unreadable field is MISSING:<id> and never matches, even for two missing participants',()=>{
  for(const field of CONTEXT_FIELDS){
    const raw=clone(baseContext);delete raw[field];
    const a=ctx('p1',raw),b=ctx('p2',raw);
    assert.equal(a.fields[field],'MISSING:p1',field);
    assert.deepEqual(a.missing,[field]);
    assert.notEqual(a.context_key,b.context_key,field);
    assert.deepEqual(contextMismatches([a,b]).map(item=>item.field),[field],field);
  }
  const unreadable=clone(baseContext);unreadable.cost_model.fee_bps='abc';unreadable.capital.initial_cash='-5';unreadable.period.evaluation_bars=7;
  assert.deepEqual([...ctx('p',unreadable).missing].sort(),['capital','cost_model','period']);
  assert.deepEqual(contextFields('p',null).missing.length,16);
});
test('2 a participant is judged against the declared context; an incomplete declared context is QR3_SPEC_INCOMPLETE',()=>{
  const declared=ctx('declared').fields,good=ctx('p1'),raw=clone(baseContext);raw.engine='x'.repeat(64);
  assert.equal(compareToDeclared(declared,good).compatible,true);
  const bad=compareToDeclared(declared,ctx('p2',raw));
  assert.equal(bad.compatible,false);assert.equal(bad.code,CODES.QR3_CONTEXT_MISMATCH);assert.deepEqual(bad.mismatches.map(item=>item.field),['engine']);
  assert.equal(bad.mismatches[0].values[0].participant_id,'DECLARED');
  const missing=clone(baseContext);delete missing.scope;
  assert.equal(compareToDeclared(ctx('d',missing).fields,good).code,CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(compareToDeclared(declared,ctx('p3',missing)).compatible,false);
});
test('2 declared context problems: market, timeframe, cost model V2, inventory',()=>{
  assert.deepEqual(declaredContextProblems(ctx('d').fields),[]);
  const with_=(patch)=>declaredContextProblems(ctx('d',{...clone(baseContext),...patch}).fields).map(item=>item.code);
  assert.deepEqual(with_({market:{broker:'binance-global',symbol:'ETHUSDT',timeframe:'1'}}),[CODES.QR3_MARKET_UNSUPPORTED]);
  assert.deepEqual(with_({market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'5'}}),[CODES.QR3_TIMEFRAME_UNSUPPORTED]);
  assert.deepEqual(with_({cost_model:{version:'paper-close-cost-v2',fee_bps:'10',slippage_bps:'5'}}),[CODES.QR3_COST_MODEL_UNSUPPORTED]);
  assert.deepEqual(with_({capital:{initial_cash:'1000',initial_inventory:'1',quote:'USDT'}}),[CODES.QR3_SPEC_INCOMPLETE]);
});

/* ------------------------------------------------------------------ 3 mode, request */
const goodRequest=()=>({mode:'STANDARDIZED',participants:[{id:'run-a'},{id:'run-b'}],market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},cost_model_version:'paper-close-v1'});
test('3 request refusals, each reachable with one input change',()=>{
  assert.equal(validateRequest(goodRequest()).ok,true);
  const code=(patch)=>validateRequest({...goodRequest(),...patch}).code;
  assert.equal(code({mode:undefined}),CODES.QR3_MODE_REQUIRED);
  assert.equal(code({mode:'RANKED'}),CODES.QR3_MODE_REQUIRED);
  assert.equal(code({participants:[{id:'run-a',mode:'STANDARDIZED'},{id:'run-b',mode:'ACTUAL_BOT'}]}),CODES.QR3_MODE_MIX);
  assert.equal(code({participants:[{id:'run-a'}]}),CODES.QR3_PARTICIPANT_COUNT);
  assert.equal(code({participants:['a','b','c','d','e'].map(id=>({id:'run-'+id}))}),CODES.QR3_PARTICIPANT_COUNT);
  assert.equal(validateRequest({...goodRequest(),participants:['a','b','c','d'].map(id=>({id:'run-'+id}))}).ok,true);
  assert.equal(code({participants:[{id:'run-a'},{id:'bad id'}]}),CODES.INVALID_RUN_ID);
  assert.equal(code({participants:[{id:'run-a'},{id:'run-a'}]}),CODES.DUPLICATE_RUN_ID);
  assert.equal(code({market:{broker:'binance-global',symbol:'ETHUSDT',timeframe:'1'}}),CODES.QR3_MARKET_UNSUPPORTED);
  assert.equal(code({market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'5'}}),CODES.QR3_TIMEFRAME_UNSUPPORTED);
  assert.equal(code({cost_model_version:'paper-close-cost-v2'}),CODES.QR3_COST_MODEL_UNSUPPORTED);
  assert.equal(code({participants:[{id:'run-a'},{id:'run-b',fixture:true}]}),CODES.QR3_FIXTURE_PARTICIPANT);
  assert.equal(validateRequest({...goodRequest(),participants:[{id:'run-a'},{id:'run-b',fixture:true}],fixture_comparison:true}).ok,true);
  assert.equal(code({participants:'x'}),CODES.INVALID_FIELDS);
});
test('3 ACTUAL_BOT rejects an objective, validateSpec refuses spec fields in that mode, and the outcome never ranks',()=>{
  assert.equal(validateRequest({...goodRequest(),mode:'ACTUAL_BOT',objective:'qr3-obj-net-return-v1'}).code,CODES.QR3_OBJECTIVE_NOT_ALLOWED);
  assert.equal(validateRequest({...goodRequest(),mode:'ACTUAL_BOT'}).ok,true);
  assert.equal(validateSpec({mode:'ACTUAL_BOT',objective:'qr3-obj-net-return-v1'}).code,CODES.QR3_OBJECTIVE_NOT_ALLOWED);
  const spec=validateSpec({mode:'ACTUAL_BOT',participants:['b','a'],period:{start_ms:1,end_ms:2}});
  assert.equal(spec.ok,true);assert.deepEqual(spec.spec.participants,['a','b']);
  const outcome=decideOutcome({mode:'ACTUAL_BOT',participants:[{id:'b',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',primary_metric:'9'},{id:'a',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',primary_metric:'1'}]});
  assert.equal(outcome.outcome,'ACTUAL_HISTORY_SIDE_BY_SIDE');
  assert.deepEqual(outcome.participants.map(item=>[item.id,item.rank,item.label]),[['a',null,null],['b',null,null]]);
});

/* ------------------------------------------------------------------ 4 period golden cases */
const L=U(2026,3,31);
const period=(patch)=>resolvePeriod({last_completed_end_ms:L,warmup_bars:100,max_total_bars:2000000,...patch});
test('4 period: 1W ends at the last completed bar and looks back seven days; default runtime refuses it, never truncates',()=>{
  const ok=period({choice:'1W'});
  assert.equal(ok.ok,true);assert.equal(ok.period.start_utc,'2026-03-24T00:00:00.000Z');assert.equal(ok.period.end_utc,'2026-03-31T00:00:00.000Z');
  assert.equal(ok.period.evaluation_bars,7*1440);assert.equal(ok.period.total_bars,7*1440+100);assert.equal(ok.period.anchor,'END');
  const refused=resolvePeriod({choice:'1W',last_completed_end_ms:L,warmup_bars:100});
  assert.equal(refused.code,CODES.QR3_RANGE_ADMISSION_REFUSED);
  assert.deepEqual([refused.evaluation_bars,refused.warmup_bars,refused.total_bars,refused.limit],[10080,100,10180,10000]);
  assert.equal(refused.candidate.start_ms,U(2026,3,24));
});
test('4 period: 1M month-end clamp, forward from 31 January and back from 31 March, leap year',()=>{
  const forward=period({choice:'1M',start_ms:U(2026,1,31)});
  assert.equal(forward.period.end_utc,'2026-02-28T00:00:00.000Z');assert.equal(forward.period.anchor,'START');assert.equal(forward.period.evaluation_bars,28*1440);
  assert.equal(period({choice:'1M',start_ms:U(2024,1,31)}).period.end_utc,'2024-02-29T00:00:00.000Z');
  const back=period({choice:'1M'});
  assert.equal(back.period.start_utc,'2026-02-28T00:00:00.000Z');assert.equal(back.period.end_utc,'2026-03-31T00:00:00.000Z');
  assert.equal(addMonths(U(2026,5,31),1),U(2026,6,30));assert.equal(addMonths(U(2026,1,15,13,7),-2),U(2025,11,15,13,7));
  assert.equal(addMonths(U(2026,12,31),2),U(2027,2,28));
});
test('4 period: 3M, 6M, 1Y, 2Y, 3Y calendar boundaries',()=>{
  const start=choice=>period({choice}).period.start_utc;
  assert.equal(start('3M'),'2025-12-31T00:00:00.000Z');assert.equal(start('6M'),'2025-09-30T00:00:00.000Z');assert.equal(start('1Y'),'2025-03-31T00:00:00.000Z');
  assert.equal(start('2Y'),'2024-03-31T00:00:00.000Z');assert.equal(start('3Y'),'2023-03-31T00:00:00.000Z');
  assert.equal(period({choice:'1Y',start_ms:U(2024,2,29)}).period.end_utc,'2025-02-28T00:00:00.000Z');
});
test('4 period: YTD starts January 1 UTC of the end year',()=>{
  const ytd=period({choice:'YTD'});
  assert.equal(ytd.period.start_utc,'2026-01-01T00:00:00.000Z');assert.equal(ytd.period.evaluation_bars,89*1440);
  assert.equal(period({choice:'YTD',start_ms:U(2026,2,1)}).code,CODES.QR3_PERIOD_INVALID);
});
test('4 period: All Available keeps the warm-up inside available history and is bounded, never truncated',()=>{
  const all=period({choice:'ALL',available_start_ms:U(2026,3,1),warmup_bars:100});
  assert.equal(all.period.start_utc,'2026-03-01T01:40:00.000Z');assert.equal(all.period.evaluation_bars,43100);assert.equal(all.period.total_bars,43200);
  assert.deepEqual(all.period.available_history,{start_ms:U(2026,3,1),end_ms:L});
  assert.equal(resolvePeriod({choice:'ALL',available_start_ms:U(2026,3,1),last_completed_end_ms:L,warmup_bars:100}).code,CODES.QR3_RANGE_ADMISSION_REFUSED);
  assert.equal(resolvePeriod({choice:'ALL',last_completed_end_ms:L,warmup_bars:100}).code,CODES.QR3_PERIOD_INVALID);
});
test('4 period: Custom half-open bounds, future end, end <= start, alignment, admission boundary 10000',()=>{
  const custom=(start,end,warmup=60)=>resolvePeriod({choice:'CUSTOM',start_ms:start,end_ms:end,last_completed_end_ms:L,warmup_bars:warmup});
  const ok=custom(U(2026,3,30),L);
  assert.equal(ok.ok,true);assert.equal(ok.period.evaluation_bars,1440);assert.equal(ok.period.total_bars,1500);assert.equal(ok.period.end_utc,iso(L));
  assert.equal(custom(U(2026,3,30),L+MINUTE).code,CODES.QR3_PERIOD_IN_FUTURE);
  assert.equal(custom(U(2026,3,30),L).ok,true);
  assert.equal(custom(L,L).code,CODES.QR3_PERIOD_INVALID);assert.equal(custom(L,L-MINUTE).code,CODES.QR3_PERIOD_INVALID);
  assert.equal(custom(U(2026,3,30)+1000,L).code,CODES.QR3_PERIOD_INVALID);assert.equal(custom(U(2026,3,30),L-1).code,CODES.QR3_PERIOD_INVALID);
  assert.equal(custom('x',L).code,CODES.QR3_PERIOD_INVALID);
  assert.equal(period({choice:'WEEK'}).code,CODES.QR3_PERIOD_INVALID);assert.equal(period({}).code,CODES.QR3_PERIOD_INVALID);
  assert.equal(period({choice:'1W',warmup_bars:-1}).code,CODES.QR3_PERIOD_INVALID);
  const edge=(bars,warmup)=>resolvePeriod({choice:'CUSTOM',start_ms:L-bars*MINUTE,end_ms:L,last_completed_end_ms:L,warmup_bars:warmup});
  assert.equal(edge(10000,0).ok,true);assert.equal(edge(9900,100).ok,true);
  const over=edge(9901,100);
  assert.equal(over.code,CODES.QR3_RANGE_ADMISSION_REFUSED);assert.equal(over.total_bars,10001);
  assert.equal(edge(10001,0).code,CODES.QR3_RANGE_ADMISSION_REFUSED);
});

/* ------------------------------------------------------------------ 5 dataset gaps, 6 coverage */
const barsFor=(from,to)=>{const out=[];for(let t=from;t<to;t+=MINUTE)out.push({time_ms:t,complete:true});return out;};
test('5 a gap inside [start - W_max, end) refuses QR3_DATASET_GAPPED with intervals; a gap before start - W_max does not',()=>{
  const start=T0,end=T0+10*MINUTE,warmup=3,from=start-3*MINUTE;
  assert.equal(checkDatasetGaps({bars:barsFor(from,end),start_ms:start,end_ms:end,warmup_bars:warmup}).ok,true);
  assert.equal(checkDatasetGaps({bars:barsFor(from-100*MINUTE,end),start_ms:start,end_ms:end,warmup_bars:warmup}).ok,true);
  const inner=barsFor(from,end).filter(bar=>![T0+2*MINUTE,T0+3*MINUTE,T0+7*MINUTE].includes(bar.time_ms));
  const refused=checkDatasetGaps({bars:inner,start_ms:start,end_ms:end,warmup_bars:warmup});
  assert.equal(refused.code,CODES.QR3_DATASET_GAPPED);
  assert.deepEqual(refused.gaps,[{start_ms:T0+2*MINUTE,end_ms:T0+4*MINUTE},{start_ms:T0+7*MINUTE,end_ms:T0+8*MINUTE}]);
  const leading=checkDatasetGaps({bars:barsFor(start-MINUTE,end),start_ms:start,end_ms:end,warmup_bars:warmup});
  assert.deepEqual(leading.gaps,[{start_ms:from,end_ms:start-MINUTE}]);
  const trailing=checkDatasetGaps({bars:barsFor(from,end-2*MINUTE),start_ms:start,end_ms:end,warmup_bars:warmup});
  assert.deepEqual(trailing.gaps,[{start_ms:end-2*MINUTE,end_ms:end}]);
});
test('5 duplicates, incomplete and unaligned bars in range refuse; unreadable input is DATASET_UNAVAILABLE',()=>{
  const start=T0,end=T0+5*MINUTE,args={start_ms:start,end_ms:end,warmup_bars:0};
  const dup=[...barsFor(start,end),{time_ms:start+MINUTE,complete:true}];
  assert.deepEqual(checkDatasetGaps({bars:dup,...args}).duplicates,[start+MINUTE]);
  const inc=barsFor(start,end);inc[2]={time_ms:start+2*MINUTE,complete:false};
  const incomplete=checkDatasetGaps({bars:inc,...args});
  assert.deepEqual(incomplete.incomplete,[start+2*MINUTE]);assert.deepEqual(incomplete.gaps,[{start_ms:start+2*MINUTE,end_ms:start+3*MINUTE}]);
  assert.deepEqual(checkDatasetGaps({bars:[...barsFor(start,end),{time_ms:start+30000}],...args}).unaligned,[start+30000]);
  assert.equal(checkDatasetGaps({bars:null,...args}).code,CODES.QR3_DATASET_UNAVAILABLE);
  assert.equal(checkDatasetGaps({bars:[{time_ms:'x'}],...args}).code,CODES.QR3_DATASET_UNAVAILABLE);
});
test('6 a participant covering less than the period is EXCLUDED_COVERAGE with its covered interval; the period never shrinks',()=>{
  const p={start_ms:T0,end_ms:T0+100*MINUTE};
  assert.equal(checkCoverage({period:p,covered:{start_ms:T0-MINUTE,end_ms:T0+100*MINUTE}}).state,'PASS');
  assert.equal(checkCoverage({period:p,covered:{start_ms:T0,end_ms:T0+100*MINUTE}}).state,'PASS');
  const late=checkCoverage({period:p,covered:{start_ms:T0+MINUTE,end_ms:T0+100*MINUTE}});
  assert.deepEqual([late.state,late.participant_status,late.code],['FAIL','EXCLUDED_COVERAGE',CODES.QR3_COVERAGE_INCOMPLETE]);
  assert.deepEqual(late.covered_interval,{start_ms:T0+MINUTE,end_ms:T0+100*MINUTE});assert.deepEqual(late.period,p);
  assert.equal(checkCoverage({period:p,covered:{start_ms:T0,end_ms:T0+99*MINUTE}}).state,'FAIL');
  assert.equal(checkCoverage({period:p,covered:null}).state,'FAIL');assert.equal(checkCoverage({period:null,covered:p}).state,'FAIL');
});

/* ------------------------------------------------------------------ 7 valuation golden */
const P4={start_ms:T0,end_ms:T0+4*MINUTE};
test('7 valuation golden, fee 0: buy 10 at 90 (cash 100), closes 90 100 80 95 give NAV 1000 1100 900 1050',()=>{
  // cash 1000 - 900 = 100. NAV = 100 + 10*close: 1000, 1100, 900, 1050. Return 1050/1000-1 = 0.05 = 5 percent.
  // Max drawdown on the bar-close grid: peak 1100, trough 900: 200/1100 = 2/11 = 18.181818181818 percent (12 places). Exposure 4 of 4 bars.
  const run=valueRun({initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],basis_confirmed:true,
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'10',price:'90',fee:'0',slippage_cost:'0'}]});
  assert.equal(run.ok,true);
  assert.deepEqual(run.nav_series.map(item=>item.nav),['1000','1100','900','1050']);
  assert.equal(run.net_return_fraction,'0.05');assert.equal(run.net_return_percent,'5');
  assert.equal(run.max_drawdown_percent,'18.181818181818');
  assert.equal(run.exposure_percent,'100');assert.equal(run.total_fees,'0');assert.deepEqual(run.total_slippage,{value:'0',reason:null});
  assert.equal(run.end_treatment,'MARK_AT_END_CLOSE');assert.deepEqual(run.limitations,[]);
  assert.equal(run.version,QR3_VERSIONS.valuation);assert.equal(run.grid_id,'qr3-grid-bar-close-v1');
});
test('7 valuation V5: an open position is marked at the last close and not liquidated; the position stays in the end line',()=>{
  const run=valueRun({initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],basis_confirmed:true,
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'10',price:'90',fee:'0'}]});
  assert.deepEqual(run.end_position,{quantity:'10',mark_close:'95',value:'950'});assert.equal(run.end_nav,'1050');
});
test('7 valuation with fee: cash 99, NAV 999 1099 899 1049, return 4.9 percent, drawdown 200/1099 = 18.198362147407 percent',()=>{
  const run=valueRun({initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],basis_confirmed:true,
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'10',price:'90',fee:'1',slippage_cost:'0.5'}]});
  assert.deepEqual(run.nav_series.map(item=>item.nav),['999','1099','899','1049']);
  assert.equal(run.net_return_percent,'4.9');assert.equal(run.max_drawdown_percent,'18.198362147407');
  assert.equal(run.total_fees,'1');assert.deepEqual(run.total_slippage,{value:'0.5',reason:null});
});
test('7 valuation round trip: sell on the last bar leaves 3 of 4 bars in market and flat inventory',()=>{
  const run=valueRun({initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],basis_confirmed:true,
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'10',price:'90',fee:'0'},{bar_time_ms:T0+3*MINUTE,side:'SELL',quantity:'10',price:'95',fee:'0'}]});
  assert.equal(run.exposure_percent,'75');assert.equal(run.end_position.quantity,'0');assert.equal(run.end_nav,'1050');
  assert.deepEqual(run.total_slippage,nullSlippage());
  function nullSlippage(){return {value:null,reason:CODES.METRIC_NOT_RECORDED};}
});
test('7 valuation V7 rounding: half-even at 18 places per position per instant, one rounding of the return at 12 places',()=>{
  // 3e-18 * 0.5 = 1.5e-18 -> 2e-18 (half-even to even). Cash 10 - 2e-18, position value rounds to 2e-18 again, NAV = 10 exactly.
  const tiny=valueRun({initial_cash:'10',period:{start_ms:T0,end_ms:T0+2*MINUTE},grid:grid(T0,['0.5','0.5']),flows:[],
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'0.000000000000000003',price:'0.5',fee:'0'}]});
  assert.deepEqual(tiny.nav_series.map(item=>item.nav),['10','10']);
  // 1e-18 * 0.5 = 5e-19 -> 0 (half-even keeps the even 0).
  const half=valueRun({initial_cash:'10',period:{start_ms:T0,end_ms:T0+2*MINUTE},grid:grid(T0,['0.5','0.5']),flows:[],
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'0.000000000000000001',price:'0.5',fee:'0'}]});
  assert.deepEqual(half.nav_series.map(item=>item.nav),['10','10']);
  // Position value 5e-18 * 0.5 = 2.5e-18 rounds half-even to 2e-18 (half-up would give 3e-18): NAV = 10 - 5e-18 + 2e-18.
  const even=valueRun({initial_cash:'10',period:{start_ms:T0,end_ms:T0+2*MINUTE},grid:grid(T0,['0.5','0.5']),flows:[],
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'0.000000000000000005',price:'1',fee:'0'}]});
  assert.deepEqual(even.nav_series.map(item=>item.nav),['9.999999999999999997','9.999999999999999997']);
  // Return 1.5e-12 rounds to 2e-12 (half-even), 2.5e-12 rounds to 2e-12; the percent is 100 times the unrounded value.
  const ret=lastClose=>valueRun({initial_cash:'1000000',period:{start_ms:T0,end_ms:T0+2*MINUTE},grid:grid(T0,['1000000',lastClose]),flows:[],
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'1',price:'1000000',fee:'0'}]});
  const a=ret('1000000.0000015'),b=ret('1000000.0000025');
  assert.equal(a.net_return_fraction,'0.000000000002');assert.equal(b.net_return_fraction,'0.000000000002');
  assert.equal(a.net_return_percent,'0.00000000015');assert.equal(a.net_return_percent_exact,'0.00000000015');assert.equal(b.net_return_percent,'0.00000000025');
});
test('7 valuation refusals: flows, fills outside the window, short or negative cash, gapped grid, unconfirmed basis',()=>{
  const args={initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],fills:[]};
  assert.equal(valueRun({...args,flows:[{kind:'DEPOSIT',amount:'5'}]}).code,CODES.QR3_FLOW_IN_WINDOW);
  assert.equal(valueRun({...args,flows:undefined}).code,CODES.QR3_METRIC_UNAVAILABLE);
  assert.equal(valueRun({...args,fills:[{bar_time_ms:T0-MINUTE,side:'BUY',quantity:'1',price:'90',fee:'0'}]}).detail,'FILL_OUTSIDE_WINDOW');
  assert.equal(valueRun({...args,fills:[{bar_time_ms:T0+4*MINUTE,side:'BUY',quantity:'1',price:'90',fee:'0'}]}).detail,'FILL_OUTSIDE_WINDOW');
  assert.equal(valueRun({...args,fills:[{bar_time_ms:T0,side:'SELL',quantity:'1',price:'90',fee:'0'}]}).detail,'NEGATIVE_INVENTORY');
  assert.equal(valueRun({...args,fills:[{bar_time_ms:T0,side:'BUY',quantity:'100',price:'90',fee:'0'}]}).detail,'NEGATIVE_CASH');
  assert.equal(valueRun({...args,grid:args.grid.slice(0,3)}).code,CODES.QR3_DATASET_GAPPED);
  assert.equal(valueRun({...args,grid:[args.grid[0],args.grid[2],args.grid[1],args.grid[3]]}).code,CODES.QR3_DATASET_GAPPED);
  assert.equal(valueRun({...args,grid:args.grid.map((bar,i)=>i===1?{...bar,close:'0'}:bar)}).code,CODES.QR3_DATASET_UNAVAILABLE);
  const unconfirmed=valueRun(args);
  assert.equal(unconfirmed.end_treatment,CODES.VALUATION_BASIS_UNCONFIRMED);assert.deepEqual(unconfirmed.limitations,[CODES.VALUATION_BASIS_UNCONFIRMED]);
  assert.equal(checkGrid(args.grid,P4).bars,4);
});
test('7 daily returns on the UTC day grid: last NAV of each day against the previous day (first against initial NAV)',()=>{
  const series=[{time_ms:U(2026,3,30,23,58),nav:'1005'},{time_ms:U(2026,3,30,23,59),nav:'1010'},{time_ms:U(2026,3,31,0,0),nav:'1020'},{time_ms:U(2026,3,31,23,59),nav:'1030.2'}];
  const daily=dailyReturns(series,'1000');
  assert.deepEqual(daily.returns,['0.01','0.02']);assert.deepEqual(daily.days,[Math.floor(U(2026,3,30)/DAY),Math.floor(U(2026,3,31)/DAY)]);
  assert.equal(dailyReturns([],'1000').code,CODES.QR3_METRIC_UNAVAILABLE);assert.equal(dailyReturns(series,'0').code,CODES.QR3_METRIC_UNAVAILABLE);
});

/* ------------------------------------------------------------------ 8 benchmark golden */
const P3={start_ms:T0,end_ms:T0+3*MINUTE};
const bhArgs=()=>({initial_cash:'1000',period:P3,grid:grid(T0,['100','110','99']),data_model:{price_tick:'0.01',quantity_step:'0.001'},cost_model:{fee_bps:'10',slippage_bps:'20'},basis_confirmed:true});
test('8 benchmark golden B1 to B5: adverse slippage, tick rounding, quantity step, residual cash, no exit fee',()=>{
  // Entry price 100 * 1.002 = 100.20 (already on the 0.01 tick). Units = floor(1000 / (100.20 * 1.001) / 0.001) * 0.001 = 9.970
  // (1000 / 100.3002 = 9.97007...). Notional 9.970 * 100.20 = 998.994, fee 998.994 * 0.001 = 0.998994, residual cash 0.007006.
  // NAV: 0.007006 + 9.970 * {100, 110, 99} = 997.007006, 1096.707006, 987.037006. Return 987.037006/1000 - 1 = -1.2962994 percent.
  // Drawdown: peak 1096.707006, trough 987.037006: 109.67 / 1096.707006 = 9.999936117851 percent. Slippage 9.970 * 0.20 = 1.994.
  const bh=buyAndHold(bhArgs());
  assert.equal(bh.ok,true);assert.equal(bh.version,QR3_VERSIONS.benchmark);
  assert.deepEqual(bh.entry,{bar_time_ms:T0,price:'100.2',quantity:'9.97',notional:'998.994',fee:'0.998994',residual_cash:'0.007006'});
  assert.deepEqual(bh.valuation.nav_series.map(item=>item.nav),['997.007006','1096.707006','987.037006']);
  assert.equal(bh.net_return_percent,'-1.2962994');assert.equal(bh.max_drawdown_percent,'9.999936117851');
  assert.equal(bh.valuation.total_fees,'0.998994');assert.deepEqual(bh.valuation.total_slippage,{value:'1.994',reason:null});assert.equal(bh.valuation.exposure_percent,'100');
  assert.equal(bh.liquidation_line,null);assert.equal(bh.funding,'NONE');
  // B5: excess = participant return minus benchmark return: -0.5 - (-1.2962994) = 0.7962994.
  assert.equal(excessReturn('-0.5',bh).value,'0.7962994');
  assert.equal(excessReturn('1',{ok:false}).reason,CODES.QR3_BENCHMARK_DATA_UNAVAILABLE);assert.equal(excessReturn('1',{ok:false}).value,null);
});
test('8 benchmark B2 liquidation line is separate, labelled and off by default',()=>{
  // Sell price 99 * 0.998 = 98.802 rounded DOWN to the tick = 98.80. Proceeds 9.970 * 98.80 = 985.036, exit fee 0.985036,
  // end cash 0.007006 + 985.036 - 0.985036 = 984.05797, return -1.594203 percent. The main line stays -1.2962994.
  const bh=buyAndHold({...bhArgs(),include_liquidation_line:true});
  assert.deepEqual(bh.liquidation_line,{label:'SIMULATED_LIQUIDATION_NOT_IN_MAIN_LINE',price:'98.8',proceeds:'985.036',exit_fee:'0.985036',end_nav:'984.05797',net_return_percent:'-1.594203'});
  assert.equal(bh.net_return_percent,'-1.2962994');
});
test('8 benchmark tick rounding is upward for a buy (A1): 100.003 * 1.002 = 100.203006 becomes 100.21',()=>{
  const bh=buyAndHold({...bhArgs(),grid:grid(T0,['100.003','100','100'])});
  assert.equal(bh.entry.price,'100.21');
});
test('8 benchmark with fee 0 and slippage 0 and exact units: cash 1000 at 100 buys 10, return follows the closes',()=>{
  const bh=buyAndHold({...bhArgs(),cost_model:{fee_bps:'0',slippage_bps:'0'},grid:grid(T0,['100','110','99'])});
  assert.deepEqual([bh.entry.quantity,bh.entry.fee,bh.entry.residual_cash],['10','0','0']);assert.equal(bh.net_return_percent,'-1');assert.equal(bh.max_drawdown_percent,'10');
});
test('8 benchmark B6: unreadable bars give a null row with QR3_BENCHMARK_DATA_UNAVAILABLE and no replacement candle',()=>{
  const args=bhArgs();
  for(const grid_ of [args.grid.slice(0,2),[args.grid[0],args.grid[2],args.grid[1]],[],null,args.grid.map((bar,i)=>i===0?{...bar,close:'x'}:bar)]){
    const bh=buyAndHold({...args,grid:grid_});
    assert.equal(bh.code,CODES.QR3_BENCHMARK_DATA_UNAVAILABLE);assert.equal(bh.value,null);assert.equal(bh.ok,false);
  }
  assert.equal(buyAndHold({...args,initial_cash:'0.05'}).detail,'NO_UNITS_AFFORDABLE');
  assert.equal(buyAndHold({...args,data_model:{price_tick:'0',quantity_step:'0.001'}}).code,CODES.QR3_METRIC_UNAVAILABLE);
});

/* ------------------------------------------------------------------ evidence fixtures */
const gatesAllPass=()=>['G1','G2','G3','G4','G5','G6','G7','G8'].map(gate=>({gate,state:'PASS',pass:true,codes:[]}));
const W={start_ms:T0,end_ms:T0+1440*MINUTE};
const evidenceInput=(patch={})=>({participant_id:'p1',owner_id:'o1',market_key:'M',source_hash:'S',window:W,record_created_at_ms:2000,frozen_at_ms:1000,as_of_ms:null,comparison_id:'c-now',
  spec_hash:'h',record_comparison_id:'c-now',record_spec_hash:'h',
  viewable_before_freeze:false,from_stored_view:false,imported:false,no_screened_candidate:false,earlier_holdouts:[],searched_windows:[],source_holdout_window:null,
  exposure_register:[],registered_boundary_ms:null,library_gates:gatesAllPass(),...patch});
const shiftW=(by)=>({start_ms:W.start_ms+by*MINUTE,end_ms:W.end_ms+by*MINUTE});

test('9 freeze order: a record created before the freeze (or at the same instant) is QR3_RESULT_PREDATES_SPEC and DEVELOPMENT_EVIDENCE',()=>{
  const ok=classifyEvidence(evidenceInput());
  assert.equal(ok.evidence_class,'INDEPENDENT');assert.deepEqual(ok.reasons,[]);
  for(const created of [999,1000]){
    const early=classifyEvidence(evidenceInput({record_created_at_ms:created}));
    assert.equal(early.evidence_class,'DEVELOPMENT_EVIDENCE');assert.deepEqual(early.reasons,[CODES.QR3_RESULT_PREDATES_SPEC]);
  }
  assert.equal(classifyEvidence(evidenceInput({viewable_before_freeze:true})).evidence_class,'DEVELOPMENT_EVIDENCE');
  assert.equal(classifyEvidence(evidenceInput({viewable_before_freeze:undefined})).evidence_class,'DEVELOPMENT_EVIDENCE');
  assert.equal(classifyEvidence(evidenceInput({record_created_at_ms:null})).evidence_class,'NOT_EVALUATED');
});
test('10 evidence class: earlier holdout (same owner and market), searched data (same owner and source), exposures, registered boundary',()=>{
  const hold=(owner,market,window)=>({owner_id:owner,market_key:market,window,run_id:'r'});
  let r=classifyEvidence(evidenceInput({earlier_holdouts:[hold('o1','M',shiftW(10))]}));
  assert.deepEqual(r.reasons,[CODES.QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT]);
  assert.deepEqual(classifyEvidence(evidenceInput({earlier_holdouts:[hold('o1','OTHER',shiftW(10))]})).reasons,[]);
  assert.deepEqual(classifyEvidence(evidenceInput({earlier_holdouts:[hold('o2','M',shiftW(10))]})).reasons,[]);
  const search=(owner,source,window)=>({owner_id:owner,source_hash:source,window});
  r=classifyEvidence(evidenceInput({searched_windows:[search('o1','S',shiftW(-5))]}));
  assert.deepEqual(r.reasons,[CODES.QR3_WINDOW_OVERLAPS_SEARCHED_DATA]);
  assert.deepEqual(classifyEvidence(evidenceInput({searched_windows:[search('o1','OTHER',shiftW(-5))]})).reasons,[]);
  const exposure=(kind,id,owner,market,window)=>({owner_id:owner,market_key:market,window,kind,[kind==='QR3_COMPARISON'?'comparison_id':'selection_id']:id,at_ms:500});
  for(const kind of ['QR3_COMPARISON','QR4_SELECTION']){
    r=classifyEvidence(evidenceInput({exposure_register:[exposure(kind,'x1','o1','M',shiftW(1))]}));
    assert.deepEqual(r.reasons,[CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED]);
    assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[exposure(kind,'x1','o1','OTHER',shiftW(1))]})).reasons,[]);
    assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[exposure(kind,'x1','o2','M',shiftW(1))]})).reasons,[]);
  }
  assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[exposure('QR3_COMPARISON','c-now','o1','M',shiftW(1))]})).reasons,[],'own comparison is ignored');
  assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[{...exposure('QR3_COMPARISON','x1','o1','M',shiftW(1)),at_ms:5000}],as_of_ms:3000})).reasons,[],'later event ignored');
  assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[exposure('QR3_COMPARISON','x1','o1','M',shiftW(1440))]})).reasons,[],'touching windows are disjoint');
  assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[exposure('QR3_COMPARISON','x1','o1','M',shiftW(1439))]})).reasons,[CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED]);
  assert.deepEqual(classifyEvidence(evidenceInput({registered_boundary_ms:W.start_ms+1})).reasons,[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]);
  assert.deepEqual(classifyEvidence(evidenceInput({registered_boundary_ms:W.start_ms})).reasons,[]);
  assert.deepEqual(classifyEvidence(evidenceInput({registered_boundary_ms:undefined})).reasons,[CODES.QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY]);
});
test('10 exposure register: empty is valid, absent or unreadable refuses QR3_EXPOSURE_REGISTER_UNAVAILABLE',()=>{
  assert.equal(classifyEvidence(evidenceInput({exposure_register:[]})).evidence_class,'INDEPENDENT');
  for(const bad of [null,undefined,'x',{},[{owner_id:'o1'}],[{owner_id:'o1',market_key:'M',window:W,comparison_id:'x',kind:'OTHER',at_ms:1}]]){
    const r=classifyEvidence(evidenceInput({exposure_register:bad}));
    assert.equal(r.ok,false);assert.equal(r.code,CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE);
    assert.equal(holdoutExposure({exposure_register:bad,owner_id:'o1',market_key:'M',holdout_window:W}).code,CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE);
  }
  assert.equal(exposuresOverlapping({register:[],owner_id:'o1',market_key:'M',window:W}).ids.length,0);
});
test('10 HOLDOUT_EXPOSED_BY_COMPARISON: the source holdout overlaps an exposure of the same owner and market, listed by id',()=>{
  const register=[{owner_id:'o1',market_key:'M',window:shiftW(100),comparison_id:'cmp-2',kind:'QR3_COMPARISON',at_ms:10},
    {owner_id:'o1',market_key:'M',window:shiftW(200),selection_id:'sel-1',kind:'QR4_SELECTION',at_ms:11},
    {owner_id:'o1',market_key:'OTHER',window:shiftW(100),comparison_id:'cmp-9',kind:'QR3_COMPARISON',at_ms:12}];
  const exposed=holdoutExposure({exposure_register:register,owner_id:'o1',market_key:'M',holdout_window:W});
  assert.deepEqual([exposed.exposed,exposed.code,exposed.ids],[true,CODES.HOLDOUT_EXPOSED_BY_COMPARISON,['cmp-2','sel-1']]);
  assert.equal(holdoutExposure({exposure_register:register,owner_id:'o2',market_key:'M',holdout_window:W}).exposed,false);
  const evidence=classifyEvidence(evidenceInput({source_holdout_window:W,exposure_register:[register[2]]}));
  assert.equal(evidence.evidence_class,'INDEPENDENT');
  const hit=classifyEvidence(evidenceInput({source_holdout_window:W,exposure_register:[{...register[0],window:W}],comparison_id:'cmp-new',record_comparison_id:'cmp-new'}));
  assert.equal(hit.evidence_class,'DEVELOPMENT_EVIDENCE');
  assert.deepEqual(hit.reasons,[CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED,CODES.HOLDOUT_EXPOSED_BY_COMPARISON]);assert.deepEqual(hit.exposed_by,['cmp-2']);
});
test('10 imported and NO_VALID_CANDIDATE participants, unreadable lists and fail-closed unknowns',()=>{
  assert.deepEqual(classifyEvidence(evidenceInput({imported:true})).reasons,[CODES.QR3_NOT_QUALIFIED]);
  const none=classifyEvidence(evidenceInput({no_screened_candidate:true}));
  assert.deepEqual([none.evidence_class,none.reasons],['NOT_EVALUATED',[CODES.QR3_NO_SCREENED_CANDIDATE]]);
  assert.deepEqual(classifyEvidence(evidenceInput({earlier_holdouts:null})).reasons,[CODES.QR3_INTEGRITY_FAILED]);
  assert.deepEqual(classifyEvidence(evidenceInput({owner_id:null})).reasons,[CODES.QR3_INTEGRITY_FAILED]);
  assert.deepEqual(classifyEvidence(evidenceInput({from_stored_view:true})).reasons,[CODES.QR3_RESULT_PREDATES_SPEC]);
  assert.deepEqual(classifyEvidence(evidenceInput({library_gates:undefined})).failing_gates,['G1','G2','G3','G4','G5','G6','G7','G8']);
});

/* ------------------------------------------------------------------ 11, 12, 13 today's blockers */
const gatesToday=()=>gatesAllPass().map(item=>item.gate==='G6'||item.gate==='G7'?{...item,state:'FAIL',pass:false}:item.gate==='G8'?{...item,state:'FAIL',pass:false,codes:[CODES.QL4C_VALIDATION_NOT_AVAILABLE]}:item);
const metricsFull=(patch={})=>({net_return_percent:'12.5',max_drawdown_percent:'8',total_fees:'3',total_slippage:'1',exposure_percent:'40',rejected_intents:0,completed_episodes:25,closed_allocations:60,...patch});
const statusInput=(patch={})=>({integrity_ok:true,unavailable:false,compatibility:{compatible:true},coverage:{state:'PASS'},has_evaluation:true,
  evaluation:{basis_confirmed:true,metrics:metricsFull()},evidence:{evidence_class:'INDEPENDENT',reasons:[]},completed_episodes:25,episode_gate_available:true,
  spec:{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:'20'},...patch});
test('11 qualification today: G6, G7, G8 fail, every participant is QR3_NOT_QUALIFIED with QL4C_VALIDATION_NOT_AVAILABLE; outcome NO_QUALIFIED_RESULT',()=>{
  const evidence=classifyEvidence(evidenceInput({library_gates:gatesToday()}));
  assert.equal(evidence.evidence_class,'DEVELOPMENT_EVIDENCE');assert.deepEqual(evidence.reasons,[CODES.QR3_NOT_QUALIFIED]);
  assert.deepEqual(evidence.failing_gates,['G6','G7','G8']);assert.deepEqual(evidence.gate_codes,[CODES.QL4C_VALIDATION_NOT_AVAILABLE]);
  const status=participantStatus(statusInput({evidence}));
  assert.equal(status.status,'DEVELOPMENT_EVIDENCE');assert.deepEqual(status.reasons,[CODES.QR3_NOT_QUALIFIED]);
  const outcome=decideOutcome({mode:'STANDARDIZED',spec:validateSpec(specIn()).spec,spec_hash:validateSpec(specIn()).spec_hash,participants:['a','b','c'].map((id,i)=>({id,created_at_ms:i,status:status.status,primary_metric:'9'}))});
  assert.equal(outcome.outcome,'NO_QUALIFIED_RESULT');assert.ok(outcome.participants.every(item=>item.rank===null&&item.label===null));
});
test('12 episode gate absent: adequacy FAILs with QR3_EPISODE_GATE_NOT_AVAILABLE; closed allocations never count',()=>{
  const spec={min_episodes_floor:5,min_episodes_ranking:20};
  for(const patch of [{episode_gate_available:false,completed_episodes:50},{episode_gate_available:undefined,completed_episodes:50}]){
    const r=adequacy({spec,closed_allocations:500,...patch});
    assert.deepEqual([r.state,r.participant_status,r.code],['FAIL','INADEQUATE_SAMPLE',CODES.QR3_EPISODE_GATE_NOT_AVAILABLE]);
  }
  const status=participantStatus(statusInput({episode_gate_available:false}));
  assert.equal(status.status,'INADEQUATE_SAMPLE');assert.deepEqual(status.reasons,[CODES.QR3_EPISODE_GATE_NOT_AVAILABLE]);
  assert.equal(status.checks.adequacy,'FAIL');assert.equal(status.checks.risk,'NOT_REACHED');
});
test('13 unconfirmed valuation basis (V8, RC-C2): DEVELOPMENT_EVIDENCE with VALUATION_BASIS_UNCONFIRMED, recorded metrics visible, no rank',()=>{
  const status=participantStatus(statusInput({evaluation:{basis_confirmed:false,metrics:metricsFull()}}));
  assert.deepEqual([status.status,status.reasons],['DEVELOPMENT_EVIDENCE',[CODES.VALUATION_BASIS_UNCONFIRMED]]);
  assert.equal(status.metrics_visible,true);assert.equal(status.checks.evaluation,'FAIL');
  assert.deepEqual(['evidence','adequacy','risk'].map(name=>status.checks[name]),['NOT_REACHED','NOT_REACHED','NOT_REACHED']);
  assert.deepEqual(status.metrics.net_return_percent,{value:'12.5',reason:null});
  const missing=evaluationCheck({basis_confirmed:true,metrics:metricsFull({total_fees:null,exposure_percent:{value:null},rejected_intents:undefined})});
  assert.deepEqual([missing.state,missing.codes,missing.missing],['FAIL',[CODES.METRIC_NOT_RECORDED],['total_fees','exposure_percent','rejected_intents']]);
  assert.equal(evaluationCheck({basis_confirmed:true,metrics:metricsFull({rejected_intents:0})}).state,'PASS');
  const both=evaluationCheck({metrics:{}});
  assert.deepEqual(both.codes,[CODES.VALUATION_BASIS_UNCONFIRMED,CODES.METRIC_NOT_RECORDED]);
  const view=metricsView(metricsFull({total_fees:null}));
  assert.deepEqual(view.total_fees,{value:null,reason:CODES.METRIC_NOT_RECORDED});assert.deepEqual(view.rejected_intents,{value:0,reason:null});
});

/* ------------------------------------------------------------------ 14 labelled fixture forcing every gate PASS */
test('14 adequacy boundaries 4, 5, 19, 20 against floor 5 and ranking 20',()=>{
  const at=(n)=>adequacy({completed_episodes:n,episode_gate_available:true,spec:{min_episodes_floor:5,min_episodes_ranking:20}});
  assert.deepEqual([at(4).participant_status,at(4).code],['INADEQUATE_SAMPLE',CODES.QR3_SAMPLE_INADEQUATE]);
  assert.deepEqual([at(5).participant_status,at(5).code],['DEVELOPMENT_EVIDENCE',CODES.QR3_SAMPLE_INADEQUATE]);
  assert.deepEqual([at(19).participant_status,at(19).state],['DEVELOPMENT_EVIDENCE','FAIL']);
  assert.deepEqual([at(20).state,at(20).participant_status,at(20).code],['PASS',null,null]);
  assert.equal(at(0).participant_status,'INADEQUATE_SAMPLE');
  assert.equal(adequacy({completed_episodes:25,episode_gate_available:true,spec:{min_episodes_floor:5,min_episodes_ranking:30}}).participant_status,'DEVELOPMENT_EVIDENCE');
  assert.equal(adequacy({completed_episodes:25,episode_gate_available:true,spec:{min_episodes_floor:5}}).code,CODES.QR3_SPEC_INCOMPLETE);
  for(const [episodes,expected] of [[4,'INADEQUATE_SAMPLE'],[5,'DEVELOPMENT_EVIDENCE'],[19,'DEVELOPMENT_EVIDENCE'],[20,'ELIGIBLE_QUALIFIED']])
    assert.equal(participantStatus(statusInput({completed_episodes:episodes})).status,expected,String(episodes));
});
test('14 risk filter boundary: at the limit passes, above it is FILTERED_RISK',()=>{
  const at=(drawdown)=>participantStatus(statusInput({max_drawdown_percent_exact:drawdown}));
  assert.equal(at('20').status,'ELIGIBLE_QUALIFIED');assert.equal(at('20.0').status,'ELIGIBLE_QUALIFIED');assert.equal(at('19.999999999999').status,'ELIGIBLE_QUALIFIED');
  const over=at('20.000000000001');
  assert.deepEqual([over.status,over.reasons],['FILTERED_RISK',[CODES.QR3_RISK_FILTER_FAILED]]);
  assert.equal(participantStatus(statusInput({spec:{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:'8'}})).status,'ELIGIBLE_QUALIFIED');
  assert.equal(participantStatus(statusInput({spec:{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:'7.9'}})).status,'FILTERED_RISK');
  const unreadable=participantStatus(statusInput({evaluation:{basis_confirmed:true,metrics:metricsFull({max_drawdown_percent:'abc'})}}));
  assert.deepEqual([unreadable.status,unreadable.reasons],['FILTERED_RISK',[CODES.QR3_METRIC_UNAVAILABLE]]);
});
test('14 status chain order and statuses: first failing check decides, the rest are NOT_REACHED, unknown is FAIL',()=>{
  assert.equal(participantStatus(statusInput()).status,'ELIGIBLE_QUALIFIED');
  assert.deepEqual(Object.values(participantStatus(statusInput()).checks),['PASS','PASS','PASS','PASS','PASS','PASS','PASS']);
  assert.equal(participantStatus(statusInput({unavailable:true})).status,'UNAVAILABLE');
  const integrity=participantStatus(statusInput({integrity_ok:false,compatibility:{compatible:false}}));
  assert.deepEqual([integrity.status,integrity.reasons],['EXCLUDED_INTEGRITY',[CODES.QR3_INTEGRITY_FAILED]]);
  assert.equal(participantStatus(statusInput({integrity_ok:undefined})).status,'EXCLUDED_INTEGRITY');
  const incompatible=participantStatus(statusInput({compatibility:{compatible:false},coverage:{state:'FAIL'}}));
  assert.deepEqual([incompatible.status,incompatible.checks.coverage,incompatible.metrics_visible],['EXCLUDED_INCOMPATIBLE','NOT_REACHED',false]);
  assert.equal(participantStatus(statusInput({coverage:{state:'FAIL'}})).status,'EXCLUDED_COVERAGE');
  assert.equal(participantStatus(statusInput({has_evaluation:false,evidence:{evidence_class:'NOT_EVALUATED',reasons:[CODES.QR3_NO_SCREENED_CANDIDATE]}})).status,'NOT_EVALUATED');
  assert.equal(participantStatus(statusInput({evidence:{evidence_class:'DEVELOPMENT_EVIDENCE',reasons:[CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED]}})).status,'DEVELOPMENT_EVIDENCE');
  assert.equal(participantStatus(statusInput()).metrics_visible,true);
  assert.equal(participantStatus(statusInput({compatibility:undefined})).status,'EXCLUDED_INCOMPATIBLE');
});

const specIn=(patch={})=>({mode:'STANDARDIZED',participants:['b','a'],period:{start_ms:T0,end_ms:T0+1440*MINUTE},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
  adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
  uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'},...patch});
const elig=(id,metric,created=1)=>({id,created_at_ms:created,status:'ELIGIBLE_QUALIFIED',primary_metric:metric,reasons:[]});
const decide=(participants,{daily,spec=specIn(),limitations=[]}={})=>decideOutcome({mode:'STANDARDIZED',spec:validateSpec(spec).spec,spec_hash:validateSpec(spec).spec_hash,
  context_key:'ck',participants,daily_returns_by_id:daily,limitations});
const separated={a:['0.01','0.01','0.01'],b:['-0.01','-0.01','-0.01']};
test('14 sole best needs a gap of at least the tie band and an interval strictly above zero',()=>{
  // Constant daily returns: every resample compounds to the same value, so the interval is a point:
  // 1.01^3 - 1 = 0.030301, 0.99^3 - 1 = -0.029701, difference 0.060002 = 6.0002 percentage points.
  const r=decide([elig('a','10.00'),elig('b','9.50'),elig('c','2')],{daily:separated});
  assert.equal(r.outcome,'QUALIFIED_RANKING');
  assert.deepEqual(r.participants.map(item=>[item.id,item.rank,item.label]),[['a',1,BEST_LABEL],['b',2,null],['c',3,null]]);
  assert.equal(r.uncertainty.lower_pp,'6.0002');assert.equal(r.uncertainty.upper_pp,'6.0002');assert.equal(r.uncertainty.observed_difference_pp,'6.0002');
  assert.equal(r.uncertainty.includes_zero,false);assert.equal(r.uncertainty.approximation,true);assert.equal(r.uncertainty.method,QR3_VERSIONS.uncertainty);
});
test('14 tie band boundary: a gap below 0.50 ties, exactly 0.50 does not (then the interval decides)',()=>{
  const tied=decide([elig('a','10.00'),elig('b','9.51'),elig('c','5')],{daily:separated});
  assert.equal(tied.outcome,'QUALIFIED_TIE');
  assert.deepEqual(tied.participants.map(item=>[item.id,item.rank,item.label]),[['a',1,TIED_BEST_LABEL],['b',1,TIED_BEST_LABEL],['c',3,null]]);
  assert.equal(tied.uncertainty,null);
  assert.equal(decide([elig('a','10.00'),elig('b','9.50')],{daily:separated}).outcome,'QUALIFIED_RANKING');
  assert.equal(decide([elig('a','10.00'),elig('b','9.4999999999')],{daily:separated}).outcome,'QUALIFIED_RANKING');
});
test('14 exact decimals: 1.50 equals 1.5, so two participants with those metrics tie at rank 1',()=>{
  const r=decide([elig('a','1.50'),elig('b','1.5')],{daily:separated});
  assert.equal(r.outcome,'QUALIFIED_TIE');assert.deepEqual(r.participants.map(item=>item.rank),[1,1]);
  const same=decide([elig('b','1.5'),elig('a','1.50')],{daily:separated});
  assert.deepEqual(same.participants.map(item=>[item.id,item.primary_metric]),[['a','1.5'],['b','1.5']]);
});
test('14 an interval that includes zero gives QUALIFIED_TIE even when the metric gap exceeds the band',()=>{
  const identical={a:['0.01','-0.02','0.03'],b:['0.01','-0.02','0.03']};
  const r=decide([elig('a','10'),elig('b','5')],{daily:identical});
  assert.equal(r.outcome,'QUALIFIED_TIE');assert.equal(r.uncertainty.includes_zero,true);assert.equal(r.uncertainty.lower_pp,'0');assert.deepEqual(r.participants.map(item=>item.rank),[1,1]);
  const reversed={a:['-0.01','-0.01','-0.01'],b:['0.01','0.01','0.01']};
  assert.equal(decide([elig('a','10'),elig('b','5')],{daily:reversed}).outcome,'QUALIFIED_TIE','a negative interval does not separate a leader (fail closed)');
  assert.equal(decide([elig('a','10'),elig('b','5')],{daily:{a:['0.01'],b:['0']}}).outcome,'QUALIFIED_TIE','one day cannot be bootstrapped');
  assert.equal(decide([elig('a','10'),elig('b','5')],{}).outcome,'QUALIFIED_TIE','no daily series');
});
test('14 no approved uncertainty method: no sole best label, limitation UNCERTAINTY_METHOD_NOT_APPROVED',()=>{
  const spec=specIn({uncertainty:{method:null}});
  const v=validateSpec(spec);
  assert.deepEqual(v.limitations,[CODES.UNCERTAINTY_METHOD_NOT_APPROVED]);
  const r=decide([elig('a','10'),elig('b','5')],{daily:separated,spec});
  assert.equal(r.outcome,'QUALIFIED_TIE');assert.ok(r.limitations.includes(CODES.UNCERTAINTY_METHOD_NOT_APPROVED));assert.equal(r.uncertainty,null);
  assert.ok(r.participants.every(item=>item.label!==BEST_LABEL));
});
test('14 one eligible participant gets only the R5 label and no winner; zero eligible give NO_QUALIFIED_RESULT or INADEQUATE_EVIDENCE',()=>{
  const one=decide([{id:'c',created_at_ms:3,status:'DEVELOPMENT_EVIDENCE'},elig('a','10'),{id:'b',created_at_ms:2,status:'FILTERED_RISK'}],{});
  assert.equal(one.outcome,'NO_QUALIFIED_RESULT');assert.equal(one.only_qualified_participant_id,'a');
  assert.deepEqual(one.participants.map(item=>[item.id,item.rank,item.label]),[['a',null,ONLY_QUALIFIED_LABEL],['b',null,null],['c',null,null]]);
  const inadequate=decide(['a','b'].map((id,i)=>({id,created_at_ms:i,status:'INADEQUATE_SAMPLE'})),{});
  assert.equal(inadequate.outcome,'INADEQUATE_EVIDENCE');
  assert.equal(decide([{id:'a',created_at_ms:1,status:'INADEQUATE_SAMPLE'},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE'}],{}).outcome,'NO_QUALIFIED_RESULT');
  assert.equal(decide([{id:'a',created_at_ms:1,status:'NOT_EVALUATED'},{id:'b',created_at_ms:2,status:'EXCLUDED_INCOMPATIBLE'}],{}).outcome,'NO_QUALIFIED_RESULT');
  assert.equal(decide([elig('a','x'),elig('b','1')],{}).code,CODES.QR3_METRIC_UNAVAILABLE);
});

/* ------------------------------------------------------------------ 15 uncertainty determinism, spec hash */
test('15 the generator and the bootstrap are deterministic for a given seed',()=>{
  const seq=seed=>{const r=seededRandom(seed);return Array.from({length:12},()=>r.below(1000));};
  assert.deepEqual(seq('seed-1'),seq('seed-1'));assert.notDeepEqual(seq('seed-1'),seq('seed-2'));
  assert.ok(seq('seed-1').every(value=>Number.isInteger(value)&&value>=0&&value<1000));
  assert.equal(seededRandom('x').below(1),0);
  const spec={seed:'seed-1',resamples:300,block_length:2,confidence:'0.9'};
  const a=['0.01','-0.02','0.03','0.005','-0.01'],b=['0.0','0.01','-0.01','0.02','-0.02'];
  const one=pairedBootstrapInterval({daily_a:a,daily_b:b,spec}),two=pairedBootstrapInterval({daily_a:a,daily_b:b,spec});
  assert.deepEqual(one,two);
  assert.ok(Number(one.lower_pp)<=Number(one.upper_pp));
  const numberConfidence=pairedBootstrapInterval({daily_a:a,daily_b:b,spec:{...spec,confidence:0.9}});
  assert.deepEqual([numberConfidence.ok,numberConfidence.code,numberConfidence.detail],[false,CODES.QR3_SPEC_INCOMPLETE,'NUMBER_NOT_DECIMAL_STRING']);
  assert.equal(pairedBootstrapInterval({daily_a:['0.01'],daily_b:['0.01'],spec}).code,CODES.QR3_METRIC_UNAVAILABLE);
  assert.equal(pairedBootstrapInterval({daily_a:a,daily_b:b.slice(1),spec}).code,CODES.QR3_METRIC_UNAVAILABLE);
  assert.equal(pairedBootstrapInterval({daily_a:a,daily_b:b,spec:{...spec,resamples:0}}).code,CODES.QR3_SPEC_INCOMPLETE);
});
test('15 the interval of identical series is the point 0 and includes zero; opposite constant series give the hand-derived point',()=>{
  const spec={seed:7,resamples:50,block_length:3,confidence:'0.95'};
  const zero=pairedBootstrapInterval({daily_a:['0.01','0.02','0.03'],daily_b:['0.01','0.02','0.03'],spec});
  assert.deepEqual([zero.lower_pp,zero.upper_pp,zero.includes_zero,zero.separates_positive],['0','0',true,false]);
  const point=pairedBootstrapInterval({daily_a:['0.01','0.01','0.01'],daily_b:['-0.01','-0.01','-0.01'],spec});
  assert.deepEqual([point.lower_pp,point.upper_pp,point.separates_positive],['6.0002','6.0002',true]);
});
test('15 another seed gives another spec hash; the same spec gives the same hash; decimal spelling does not matter',()=>{
  const base=validateSpec(specIn());
  assert.equal(base.ok,true);
  assert.equal(validateSpec(specIn()).spec_hash,base.spec_hash);
  const other=validateSpec(specIn({uncertainty:{...specIn().uncertainty,seed:'seed-2'}}));
  assert.notEqual(other.spec_hash,base.spec_hash);
  assert.equal(validateSpec(specIn({tie:{band_pp:'0.5'},uncertainty:{...specIn().uncertainty,confidence:'0.950'}})).spec_hash,base.spec_hash);
  assert.notEqual(validateSpec(specIn({uncertainty:{...specIn().uncertainty,resamples:201}})).spec_hash,base.spec_hash);
  assert.notEqual(validateSpec(specIn({risk_filter:{max_drawdown_percent:'15'}})).spec_hash,base.spec_hash);
  assert.equal(validateSpec(specIn({participants:['a','b']})).spec_hash,base.spec_hash,'participant order does not change the section 6 hash');
  assert.deepEqual(base.spec.participants,['a','b']);assert.deepEqual(specThresholds(base.spec),{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:'20',tie_band_pp:'0.5'});
  assert.equal(specChangeRefusal().code,'QR3_SPEC_IMMUTABLE');
});

/* ------------------------------------------------------------------ 16 label validator */
const viewOf=(patch={},participants)=>({mode:'STANDARDIZED',lifecycle:'COMPLETE',outcome:'QUALIFIED_RANKING',context_keys:['ck'],claim_texts:[],
  participants:participants||[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:1,label:BEST_LABEL,metrics:{net_return_percent:{value:'10',reason:null}}},
    {id:'b',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',rank:2,label:null,metrics:null},
    {id:'c',created_at_ms:3,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null,metrics:{net_return_percent:{value:'50',reason:null}}}],...patch});
const rulesOf=view=>validateComparisonView(view).violations.map(item=>item.rule);
test('16 label validator accepts the three allowed labels in their one allowed place',()=>{
  assert.deepEqual(validateComparisonView(viewOf()),{ok:true,violations:[]});
  const tie=viewOf({outcome:'QUALIFIED_TIE'},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:1,label:TIED_BEST_LABEL},{id:'b',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',rank:1,label:TIED_BEST_LABEL}]);
  assert.equal(validateComparisonView(tie).ok,true);
  const only=viewOf({outcome:'NO_QUALIFIED_RESULT'},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:null,label:ONLY_QUALIFIED_LABEL},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
  assert.equal(validateComparisonView(only).ok,true);
  assert.equal(validateComparisonView(viewOf({claim_texts:[...FIXED_NOTICES,NO_WINNER_TEXT]})).ok,true,'fixed notices may say profitability claim');
});
test('16 label validator refuses best, top or winner text and any rank for a non-qualified participant',()=>{
  const dev=(patch)=>viewOf({outcome:'NO_QUALIFIED_RESULT'},[{id:'a',created_at_ms:1,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null,...patch},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
  assert.deepEqual(rulesOf(dev({rank:1})),['X1']);
  for(const label of ['best','Top performer','winner','Best within the selected scope','first place','#1'])assert.deepEqual(rulesOf(dev({label})),['X1'],label);
  assert.deepEqual(rulesOf(dev({highlight:true})),['X1']);
  assert.deepEqual(validateComparisonView(dev({label:'Development evidence'})).violations.map(item=>[item.rule,item.detail]),[['X1','LABEL']],'any non-allowed label on a non-eligible row is X1');
});
test('16 label validator refuses best without within the selected scope and labels in the wrong outcome',()=>{
  const one=(label,outcome='QUALIFIED_RANKING',rank=1)=>viewOf({outcome},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank,label},{id:'b',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',rank:2,label:null}]);
  assert.deepEqual(rulesOf(one('best')),['R3']);assert.deepEqual(rulesOf(one('Winner')),['R3']);assert.deepEqual(rulesOf(one('best in the scope')),['R3']);
  assert.deepEqual(rulesOf(one(BEST_LABEL,'QUALIFIED_TIE')),['R3']);assert.deepEqual(rulesOf(one(BEST_LABEL,'QUALIFIED_RANKING',2)),['R3']);
  assert.deepEqual(rulesOf(one(TIED_BEST_LABEL)),['T3']);
  assert.deepEqual(rulesOf(one(ONLY_QUALIFIED_LABEL)),['R5']);
  assert.deepEqual(rulesOf(viewOf({outcome:'QUALIFIED_RANKING'},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:1,label:null},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}])),['R5']);
});
test('16 label validator refuses a 0 where the status says null, a null without reason, and universal or profit claims',()=>{
  const m=(entry)=>viewOf({},[{id:'a',created_at_ms:1,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null,metrics:{total_fees:entry}},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
  assert.deepEqual(rulesOf(m({value:'0',reason:'METRIC_NOT_RECORDED'})),['NULL_SHOWN_AS_ZERO']);
  assert.deepEqual(rulesOf(m({value:0,reason:'METRIC_NOT_RECORDED'})),['NULL_SHOWN_AS_ZERO']);
  assert.deepEqual(rulesOf(m({value:'0.000',reason:'QR3_METRIC_UNAVAILABLE'})),['NULL_SHOWN_AS_ZERO']);
  assert.deepEqual(rulesOf(m({value:null,reason:null})),['NULL_WITHOUT_REASON']);
  assert.equal(validateComparisonView(m({value:null,reason:'METRIC_NOT_RECORDED'})).ok,true);
  assert.equal(validateComparisonView(m({value:'0',reason:null})).ok,true,'a real zero is allowed');
  for(const claim of ['This is the universally best strategy','global optimum found','guaranteed profit','exhaustive search proved it','a profitable setup'])
    assert.ok(rulesOf(viewOf({claim_texts:[claim]})).includes('X6'),claim);
  assert.deepEqual(rulesOf(viewOf({claim_texts:['the top strategy']})),['R3']);
});
test('16 label validator: ACTUAL_BOT never ranks, excluded metrics are hidden, no metrics before the freeze completes, no mixed modes or keys',()=>{
  const actual=viewOf({mode:'ACTUAL_BOT',outcome:'ACTUAL_HISTORY_SIDE_BY_SIDE'},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:1,label:BEST_LABEL},{id:'b',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',rank:null,label:null,highlight:true}]);
  assert.deepEqual(rulesOf(actual),['X4','X4','X4']);
  const hidden=viewOf({},[{id:'a',created_at_ms:1,status:'EXCLUDED_INCOMPATIBLE',rank:null,label:null,metrics:{net_return_percent:{value:'1',reason:null}}},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
  assert.deepEqual(rulesOf(hidden),['11.2']);
  assert.ok(rulesOf(viewOf({lifecycle:'EVALUATING'})).includes('F8'));assert.ok(rulesOf(viewOf({lifecycle:'SPEC_FROZEN'})).includes('F8'));
  assert.ok(rulesOf(viewOf({context_keys:['k1','k2']})).includes('X2'));
  assert.ok(rulesOf(viewOf({},[{id:'a',created_at_ms:1,mode:'ACTUAL_BOT',status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}])).includes('X2'));
  assert.equal(validateComparisonView(null).ok,false);assert.equal(validateComparisonView({participants:'x'}).ok,false);
  assert.ok(CODE_PATTERN.test(CODES.QR3_CONTEXT_MISMATCH));
});
test('16 scope string lists asset, resolved period, risk profile, cost model and context key',()=>{
  const scope=scopeString({market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},period:{start_ms:T0,end_ms:L},risk_policy:'rp1',cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'5'},context_key:'ck1'});
  assert.equal(scope,'binance-global:BTCUSDT 1m; 2026-03-30T00:00:00.000Z/2026-03-31T00:00:00.000Z; risk rp1; cost paper-close-v1 fee_bps 10 slippage_bps 5; context ck1');
  assert.equal(scopeString({}),null);
});

/* ------------------------------------------------------------------ 17, 18, 19 */
test('17 development tier order is creation time then id, whatever the metrics',()=>{
  const rows=[['z',5,'99'],['b',5,'1'],['a',5,'50'],['m',1,'-5']].map(([id,created,metric])=>({id,created_at_ms:created,status:'DEVELOPMENT_EVIDENCE',primary_metric:metric}));
  const r=decide(rows,{});
  assert.deepEqual(r.participants.map(item=>item.id),['m','a','b','z']);
  assert.ok(r.participants.every(item=>item.rank===null&&item.label===null));
  assert.equal(validateComparisonView({mode:'STANDARDIZED',lifecycle:'COMPLETE',outcome:r.outcome,participants:r.participants}).ok,true);
  assert.ok(rulesOf({mode:'STANDARDIZED',lifecycle:'COMPLETE',outcome:'NO_QUALIFIED_RESULT',participants:[...r.participants].reverse()}).includes('X7'));
  const byMetric=[...r.participants].sort((x,y)=>Number(rows.find(i=>i.id===y.id).primary_metric)-Number(rows.find(i=>i.id===x.id).primary_metric));
  assert.ok(rulesOf({mode:'STANDARDIZED',lifecycle:'COMPLETE',outcome:'NO_QUALIFIED_RESULT',participants:byMetric}).includes('X7'));
});
test('18 filter tightening is allowed, loosening is refused QR3_FILTER_LOOSENED',()=>{
  assert.equal(REGISTRY_DEFAULTS.max_drawdown_percent,'20');
  const code=patch=>validateSpec(specIn(patch)).code;
  assert.equal(validateSpec(specIn({risk_filter:{max_drawdown_percent:'10'}})).ok,true);
  assert.equal(validateSpec(specIn({risk_filter:{max_drawdown_percent:'20.0'}})).ok,true);
  assert.equal(code({risk_filter:{max_drawdown_percent:'20.000001'}}),CODES.QR3_FILTER_LOOSENED);
  assert.equal(validateSpec(specIn({adequacy:{min_episodes_floor:6,min_episodes_ranking:25}})).ok,true);
  assert.equal(code({adequacy:{min_episodes_floor:4,min_episodes_ranking:20}}),CODES.QR3_FILTER_LOOSENED);
  assert.equal(code({adequacy:{min_episodes_floor:5,min_episodes_ranking:19}}),CODES.QR3_FILTER_LOOSENED);
  assert.equal(code({tie:{band_pp:'0.4'}}),CODES.QR3_FILTER_LOOSENED);
});
test('18 spec refusals: incomplete fields and unknown objective, each with one change',()=>{
  const code=patch=>validateSpec(specIn(patch)).code;
  assert.equal(validateSpec(specIn()).ok,true);
  assert.equal(code({mode:undefined}),CODES.QR3_MODE_REQUIRED);
  assert.equal(code({objective:'qr3-obj-sharpe-v1'}),CODES.QR3_OBJECTIVE_UNKNOWN);assert.equal(code({objective:'__proto__'}),CODES.QR3_OBJECTIVE_UNKNOWN);
  for(const name of ['objective','risk_filter','adequacy','tie','benchmark','uncertainty'])assert.equal(code({[name]:undefined}),CODES.QR3_SPEC_INCOMPLETE,name);
  assert.equal(code({risk_filter:{max_drawdown_percent:'x'}}),CODES.QR3_SPEC_INCOMPLETE);assert.equal(code({risk_filter:{max_drawdown_percent:'-1'}}),CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(code({adequacy:{min_episodes_floor:5}}),CODES.QR3_SPEC_INCOMPLETE);assert.equal(code({tie:{}}),CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(code({benchmark:'other'}),CODES.QR3_SPEC_INCOMPLETE);assert.equal(code({uncertainty:{seed:'x'}}),CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(code({uncertainty:{...specIn().uncertainty,seed:''}}),CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(code({uncertainty:{...specIn().uncertainty,resamples:20001}}),CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(code({uncertainty:{...specIn().uncertainty,confidence:'1'}}),CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(validateSpec(specIn({uncertainty:{method:'qr3-unc-other'}})).ok,true);
  assert.deepEqual(validateSpec(specIn({uncertainty:{method:'qr3-unc-other'}})).limitations,[CODES.UNCERTAINTY_METHOD_NOT_APPROVED]);
});
test('19 determinism: the same frozen inputs give the same outcome_hash; a changed input changes it',()=>{
  const rows=[elig('a','10'),elig('b','4'),{id:'c',created_at_ms:9,status:'DEVELOPMENT_EVIDENCE',primary_metric:'3'}];
  const one=decide(rows,{daily:separated}),two=decide(rows.map(item=>({...item})),{daily:separated});
  assert.equal(one.outcome_hash,two.outcome_hash);assert.match(one.outcome_hash,/^[0-9a-f]{64}$/);
  assert.notEqual(decide([elig('a','10'),elig('b','4.1'),rows[2]],{daily:separated}).outcome_hash,one.outcome_hash);
  assert.notEqual(decide(rows,{daily:separated,spec:specIn({uncertainty:{...specIn().uncertainty,seed:'other'}})}).outcome_hash,one.outcome_hash);
  assert.equal(Object.isFrozen(one),true);assert.equal(Object.isFrozen(one.participants[0]),true);
});
test('19 property: ranking is a total preorder consistent with the objective (seeded cases, no binary floats in the order)',()=>{
  const random=seededRandom('property-19');
  const pool=['10','9.9','9.50','9.5','1.50','1.5','0','-0.4','-3','12.25','7','7.0','100'];
  for(let round=0;round<120;round+=1){
    const count=2+random.below(3);
    const metrics=Array.from({length:count},()=>pool[random.below(pool.length)]);
    const rows=metrics.map((metric,i)=>elig('p'+i,metric,random.below(5)));
    const spec=specIn({uncertainty:{method:null}});
    const r=decide(rows,{spec});
    const ranked=r.participants.filter(item=>item.rank!==null);
    assert.equal(ranked.length,count);
    const metricOf=id=>Number(rows.find(item=>item.id===id).primary_metric);
    assert.equal(ranked[0].rank,1);
    for(const x of ranked)for(const y of ranked){
      if(metricOf(x.id)>metricOf(y.id))assert.ok(x.rank<=y.rank,'monotone');
      if(metricOf(x.id)===metricOf(y.id))assert.equal(x.rank,y.rank,'equal metrics share a rank');
    }
    for(let i=1;i<ranked.length;i+=1)assert.ok(ranked[i].rank>=ranked[i-1].rank&&metricOf(ranked[i].id)<=metricOf(ranked[i-1].id));
    const shuffled=decide([...rows].reverse(),{spec});
    assert.equal(shuffled.outcome_hash,r.outcome_hash,'input order does not change the outcome');
  }
});

/* ------------------------------------------------------------------ 20 stored-result view (M4) */
const stored=(id,created,validation,test_,extra={})=>({id,created_at_ms:created,partitions:{validation:{...validation,metrics:{bars:100,closed_trades:7,net_return_percent:'3.5',profit_factor:null,...extra}},test:test_}});
test('20 stored-result view: aligned period resolves, block is DEVELOPMENT_EVIDENCE, unranked, neutral order',()=>{
  const val={start_ms:T0,end_ms:T0+100*MINUTE},tst={start_ms:T0+100*MINUTE,end_ms:T0+200*MINUTE,metrics:{bars:100,closed_trades:3,net_return_percent:'-1'}};
  const view=storedResultView({period:val,participants:[stored('b',5,val,tst),stored('a',5,val,tst)]});
  assert.equal(view.ok,true);assert.equal(view.view,'qr3-period-partition-aligned-v1');
  assert.deepEqual([view.evidence_class,view.ranked,view.full_comparison],['DEVELOPMENT_EVIDENCE',false,false]);
  assert.deepEqual(view.participants.map(item=>[item.id,item.partition,item.rank,item.evidence_class]),[['a','validation',null,'DEVELOPMENT_EVIDENCE'],['b','validation',null,'DEVELOPMENT_EVIDENCE']]);
  assert.deepEqual(view.participants[0].metrics.profit_factor,{value:null,reason:CODES.METRIC_NOT_RECORDED});assert.deepEqual(view.participants[0].metrics.net_return_percent,{value:'3.5',reason:null});
  const asTest=storedResultView({period:tst,participants:[stored('a',1,val,tst),stored('b',2,val,tst)]});
  assert.deepEqual(asTest.participants.map(item=>item.partition),['test','test']);
  const mixed=storedResultView({period:val,participants:[stored('a',1,val,tst),stored('b',2,{start_ms:T0+100*MINUTE,end_ms:T0+200*MINUTE},val)]});
  assert.equal(mixed.ok,true);assert.deepEqual(mixed.participants.map(item=>item.partition),['validation','test']);
});
test('20 stored-result view: off by one bar refuses QR3_PERIOD_NOT_PARTITION_ALIGNED and lists the windows; no ranking even for a good view',()=>{
  const val={start_ms:T0,end_ms:T0+100*MINUTE},tst={start_ms:T0+100*MINUTE,end_ms:T0+200*MINUTE};
  const input=(period)=>({period,participants:[stored('a',1,val,tst),stored('b',2,val,tst)]});
  for(const period of [{start_ms:T0+MINUTE,end_ms:val.end_ms},{start_ms:T0,end_ms:val.end_ms+MINUTE},{start_ms:T0,end_ms:val.end_ms-MINUTE},{start_ms:T0-MINUTE,end_ms:val.end_ms}]){
    const r=storedResultView(input(period));
    assert.equal(r.code,CODES.QR3_PERIOD_NOT_PARTITION_ALIGNED);
    assert.deepEqual(r.windows.filter(item=>item.participant_id==='a').map(item=>[item.partition,item.start_ms,item.end_ms]),[['validation',val.start_ms,val.end_ms],['test',tst.start_ms,tst.end_ms]]);
  }
  const oneOff=storedResultView({period:val,participants:[stored('a',1,val,tst),stored('b',2,{start_ms:T0,end_ms:T0+101*MINUTE},tst)]});
  assert.equal(oneOff.code,CODES.QR3_PERIOD_NOT_PARTITION_ALIGNED);
  assert.equal(storedResultView({period:null,participants:[]}).code,CODES.QR3_PERIOD_INVALID);
  assert.equal(storedResultView({period:val,participants:[{id:'a'}]}).code,CODES.QR3_PERIOD_INVALID);
});

/* ------------------------------------------------------------------ module hygiene */
test('module is pure: no database, network, file, clock or random access in src/comparison; codes match the contract pattern',()=>{
  const dir=fileURLToPath(new URL('../src/comparison/',import.meta.url));
  for(const name of fs.readdirSync(dir)){
    const source=fs.readFileSync(dir+name,'utf8');
    const code=source.split('\n').filter(line=>!line.trim().startsWith('*')&&!line.trim().startsWith('/*')&&!line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code,/Date\.now|new Date\(\)|Math\.random|performance\.now|from 'node:(fs|net|http|https|child_process|dns|os)'|process\.env|fetch\(|from 'pg'|XMLHttpRequest/,name);
    assert.doesNotMatch(source,/from '\.\.\/portfolio/,name);
  }
  for(const code of Object.values(CODES))assert.match(code,CODE_PATTERN);
});

/* ------------------------------------------------------------------ fix round 1: root rulings of 2026-10-19 (A, B, C, E) */
// Golden bootstrap bounds below were produced by an independent BigInt rational oracle (own sfc32, own sorting, no decimal.js, no module import).
test('R1 A1 no approved uncertainty method: the top two merge, ranks are 1, 1, 3 and both top labels are the tied label',()=>{
  const spec=specIn({uncertainty:{method:null}});
  const r=decide([elig('a','10'),elig('b','5'),elig('c','2')],{daily:separated,spec});
  assert.equal(r.outcome,'QUALIFIED_TIE');
  assert.deepEqual(r.participants.map(item=>[item.id,item.rank,item.label]),[['a',1,TIED_BEST_LABEL],['b',1,TIED_BEST_LABEL],['c',3,null]]);
  assert.ok(r.limitations.includes(CODES.UNCERTAINTY_METHOD_NOT_APPROVED));
  assert.equal(validateComparisonView({mode:'STANDARDIZED',lifecycle:'COMPLETE',outcome:r.outcome,participants:r.participants}).ok,true);
  const already=decide([elig('a','10'),elig('b','9.8'),elig('c','2')],{spec});
  assert.deepEqual(already.participants.map(item=>item.rank),[1,1,3],'an existing tie group is not widened');
});
test('R1 C tie chaining is single-linkage over adjacent sorted gaps with competition ranks',()=>{
  const chain=decide([elig('a','10.00'),elig('b','9.60'),elig('c','9.20'),elig('d','5')],{daily:separated});
  assert.equal(chain.outcome,'QUALIFIED_TIE');
  assert.deepEqual(chain.participants.map(item=>[item.id,item.rank,item.label]),[['a',1,TIED_BEST_LABEL],['b',1,TIED_BEST_LABEL],['c',1,TIED_BEST_LABEL],['d',4,null]]);
  const two=decide([elig('a','10'),elig('b','9.6'),elig('c','5'),elig('d','4.7')],{daily:separated});
  assert.deepEqual(two.participants.map(item=>item.rank),[1,1,3,3]);
});
test('R1 D F7 tie band: narrower than 0.50 is QR3_FILTER_LOOSENED, wider is QR3_SPEC_INCOMPLETE with TIE_BAND_FIXED (owner open)',()=>{
  for(const band of ['0.49','0.4','0']){const r=validateSpec(specIn({tie:{band_pp:band}}));assert.deepEqual([r.code,r.detail],[CODES.QR3_FILTER_LOOSENED,'tie_band_pp'],band);}
  for(const band of ['0.51','0.6','5']){const r=validateSpec(specIn({tie:{band_pp:band}}));assert.deepEqual([r.ok,r.code,r.detail],[false,CODES.QR3_SPEC_INCOMPLETE,'TIE_BAND_FIXED'],band);}
  assert.equal(validateSpec(specIn({tie:{band_pp:'0.500'}})).ok,true);
});
test('R1 E episode minimums: floor equal to ranking is accepted, floor above ranking is refused',()=>{
  assert.equal(validateSpec(specIn({adequacy:{min_episodes_floor:20,min_episodes_ranking:20}})).ok,true);
  assert.equal(validateSpec(specIn({adequacy:{min_episodes_floor:21,min_episodes_ranking:20}})).code,CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(validateSpec(specIn({adequacy:{min_episodes_floor:5.5,min_episodes_ranking:20}})).code,CODES.QR3_SPEC_INCOMPLETE);
});
test('R1 E resample and block limits: 20000 and 3650 accepted, one more refused, in validateSpec and in the bootstrap itself',()=>{
  const unc=patch=>({uncertainty:{...specIn().uncertainty,...patch}});
  assert.equal(validateSpec(specIn(unc({resamples:20000}))).ok,true);assert.equal(validateSpec(specIn(unc({resamples:20001}))).code,CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(validateSpec(specIn(unc({block_length:3650}))).ok,true);assert.equal(validateSpec(specIn(unc({block_length:3651}))).code,CODES.QR3_SPEC_INCOMPLETE);
  const base={seed:'s',resamples:10,block_length:2,confidence:'0.9'},a=['0.01','0.02'],b=['0.0','0.01'];
  assert.equal(pairedBootstrapInterval({daily_a:a,daily_b:b,spec:base}).ok,true);
  for(const patch of [{resamples:20001},{block_length:3651},{confidence:'0'},{confidence:'1'},{confidence:'1.5'},{confidence:'-0.1'},{confidence:'x'},{block_length:0}]){
    const r=pairedBootstrapInterval({daily_a:a,daily_b:b,spec:{...base,...patch}});
    assert.deepEqual([r.ok,r.code],[false,CODES.QR3_SPEC_INCOMPLETE],JSON.stringify(patch));
  }
  assert.equal(pairedBootstrapInterval({daily_a:a,daily_b:b,spec:null}).code,CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(pairedBootstrapInterval({daily_a:a,daily_b:b,spec:{...base,resamples:20000,block_length:3650}}).ok,true);
});
test('R1 C bootstrap goldens: stationary restart with probability 1/block_length, circular, paired, difference of compounded returns',()=>{
  const a=['0.01','-0.02','0.03','0.005'],b=['0','0.01','-0.01','0.02'],spec=block_length=>({seed:'golden-1',resamples:20,block_length,confidence:'0.9'});
  const at=block=>{const r=pairedBootstrapInterval({daily_a:a,daily_b:b,spec:spec(block)});return [r.observed_difference_pp,r.lower_pp,r.upper_pp];};
  assert.deepEqual(at(2),['0.469347','-5.1081255','5.18394825']);
  assert.deepEqual(at(1),['0.469347','-9.128403','13.335527'],'block length 1 restarts on every step');
  assert.deepEqual(at(4),['0.469347','-5.1081255','0.469347'],'block length 4 mostly continues the block');
  // 999 resamples at 0.95: tail count floor(999*0.05/2) = 24, so the bounds are sorted elements 24 and 974 (zero based).
  const a8=['0.011','-0.021','0.032','0.005','-0.013','0.017','0.008','-0.004'],b8=['0.001','0.012','-0.011','0.021','-0.022','0.004','-0.007','0.013'];
  const wide=pairedBootstrapInterval({daily_a:a8,daily_b:b8,spec:{seed:'tail-1',resamples:999,block_length:2,confidence:'0.95'}});
  assert.deepEqual([wide.days,wide.observed_difference_pp,wide.lower_pp,wide.upper_pp],[8,'2.417609704333','-6.458328687004','10.779906347629']);
  assert.equal(wide.includes_zero,true);assert.equal(wide.separates_positive,false);assert.equal(wide.approximation,true);
  assert.match(wide.lower_exact,/^-6\.4583286870/);
});
test('R1 B bootstrap, outcome and valuation refuse a number where a decimal string belongs (NUMBER_NOT_DECIMAL_STRING)',()=>{
  const spec={seed:'s',resamples:10,block_length:2,confidence:'0.9'};
  const refused=r=>[r.ok===false?r.code:null,r.detail];
  const NUM=[CODES.QR3_SPEC_INCOMPLETE,'NUMBER_NOT_DECIMAL_STRING'];
  assert.deepEqual(refused(pairedBootstrapInterval({daily_a:[0.01,0.02],daily_b:['0','0.01'],spec})),NUM);
  assert.deepEqual(refused(decide([elig('a',10),elig('b','5')],{daily:separated})),NUM);
  const args={initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],fills:[]};
  assert.deepEqual(refused(valueRun({...args,initial_cash:1000})),NUM);
  assert.deepEqual(refused(valueRun({...args,fills:[{bar_time_ms:T0,side:'BUY',quantity:10,price:'90',fee:'0'}]})),NUM);
  assert.deepEqual(refused(valueRun({...args,grid:grid(T0,['90',100,'80','95'])})),NUM);
  assert.deepEqual(refused(dailyReturns([{time_ms:T0,nav:1000}],'1000')),NUM);assert.deepEqual(refused(dailyReturns([{time_ms:T0,nav:'1000'}],1000)),NUM);
  assert.deepEqual(refused(buyAndHold({...bhArgs(),cost_model:{fee_bps:10,slippage_bps:'20'}})),NUM);
  assert.deepEqual(refused(buyAndHold({...bhArgs(),initial_cash:1000})),NUM);assert.equal(buyAndHold({...bhArgs(),initial_cash:1000}).value,null);
  const excess=excessReturn(1,{ok:false});assert.deepEqual([excess.value,excess.reason,excess.detail],[null,CODES.QR3_SPEC_INCOMPLETE,'NUMBER_NOT_DECIMAL_STRING']);
  assert.deepEqual(refused(validateSpec(specIn({owner_max_drawdown_percent:15}))),NUM);
  assert.equal(participantStatus(statusInput({max_drawdown_percent_exact:8})).status,'FILTERED_RISK');
});
test('R1 B decideOutcome refuses a duplicate participant id, a missing spec and a spec_hash that is not the hash of the spec',()=>{
  const spec=validateSpec(specIn());
  const base={mode:'STANDARDIZED',spec:spec.spec,spec_hash:spec.spec_hash,context_key:'ck',participants:[elig('a','10'),elig('b','4')],daily_returns_by_id:separated};
  assert.equal(decideOutcome(base).ok,true);
  assert.equal(decideOutcome({...base,participants:[elig('a','10'),elig('a','4')]}).code,CODES.DUPLICATE_RUN_ID);
  const bad=decideOutcome({...base,spec_hash:'0'.repeat(64)});assert.deepEqual([bad.ok,bad.code,bad.detail],[false,CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH']);
  const tampered=decideOutcome({...base,spec:{...spec.spec,tie:{band_pp:'0.1'}}});assert.equal(tampered.code,CODES.QR3_SPEC_IMMUTABLE);
  assert.equal(decideOutcome({mode:'STANDARDIZED',participants:[elig('a','10'),elig('b','4')]}).code,CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(specHashOf(spec.spec),spec.spec_hash);assert.equal(specHashOf(null),null);
  assert.equal(CODES.QR3_SPEC_IMMUTABLE,'QR3_SPEC_IMMUTABLE');assert.equal(specChangeRefusal().code,CODES.QR3_SPEC_IMMUTABLE);
  const actual=validateSpec({mode:'ACTUAL_BOT',participants:['b','a'],period:{start_ms:1,end_ms:2}});
  assert.equal(decideOutcome({mode:'ACTUAL_BOT',spec:actual.spec,spec_hash:actual.spec_hash,participants:[{id:'a',created_at_ms:1},{id:'b',created_at_ms:2}]}).ok,true);
  assert.equal(decideOutcome({mode:'ACTUAL_BOT',spec:actual.spec,spec_hash:'x',participants:[{id:'a',created_at_ms:1},{id:'b',created_at_ms:2}]}).code,CODES.QR3_SPEC_IMMUTABLE);
});
test('R1 B registry drawdown default is the lower of 20 and the owner limit',()=>{
  const code=(owner,limit)=>validateSpec(specIn({owner_max_drawdown_percent:owner,risk_filter:{max_drawdown_percent:limit}}));
  assert.equal(code('15','15').ok,true);assert.deepEqual([code('15','18').code,code('15','18').detail],[CODES.QR3_FILTER_LOOSENED,'max_drawdown_percent']);
  assert.equal(code('15','15.000001').code,CODES.QR3_FILTER_LOOSENED);
  assert.equal(code('25','20').ok,true);assert.equal(code('25','22').code,CODES.QR3_FILTER_LOOSENED,'the registry default 20 still caps a higher owner limit');
  assert.equal(code('x','10').code,CODES.QR3_SPEC_INCOMPLETE);assert.equal(code('101','10').code,CODES.QR3_SPEC_INCOMPLETE);
  assert.equal(code(undefined,'20').ok,true);assert.equal(code(null,'20').ok,true);
  assert.equal(code('15','15').spec_hash,validateSpec(specIn({risk_filter:{max_drawdown_percent:'15'}})).spec_hash,'the owner limit is a check input, not part of the hash');
});

test('R1 A2 label text must match exactly: any case or spacing variant is R3 LABEL_WITHOUT_SELECTED_SCOPE',()=>{
  const one=(label,outcome='QUALIFIED_RANKING',rank=1)=>viewOf({outcome},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank,label},{id:'b',created_at_ms:2,status:'ELIGIBLE_QUALIFIED',rank:2,label:null}]);
  for(const label of ['Best within the selected scope','BEST WITHIN THE SELECTED SCOPE',' best within the selected scope','best within the selected scope ','best  within the selected scope','best within  the selected scope',
    'best within the selected scope\n','best\twithin the selected scope'])
    assert.deepEqual(validateComparisonView(one(label)).violations.map(item=>[item.rule,item.detail]),[['R3','LABEL_WITHOUT_SELECTED_SCOPE']],JSON.stringify(label));
  assert.deepEqual(rulesOf(one('Best within the selected scope','QUALIFIED_RANKING',2)),['R3']);
  assert.deepEqual(rulesOf(one('Tied best within the selected scope','QUALIFIED_TIE')),['R3']);
  assert.deepEqual(rulesOf(viewOf({outcome:'NO_QUALIFIED_RESULT'},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:null,label:'Only qualified participant within the selected scope'},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}])),['R3']);
  assert.deepEqual(rulesOf(viewOf({claim_texts:['Best within the selected scope']})),['R3']);
  assert.equal(validateComparisonView(viewOf({claim_texts:[BEST_LABEL]})).ok,true);
  assert.equal(validateComparisonView(viewOf()).ok,true);
});
test('R1 B label validator allows participant metrics only when lifecycle is COMPLETE (F8)',()=>{
  for(const lifecycle of [undefined,null,'FAILED','CANCELLED','SPEC_FROZEN','EVALUATING','DRAFT','complete'])assert.ok(rulesOf(viewOf({lifecycle})).includes('F8'),String(lifecycle));
  assert.equal(validateComparisonView(viewOf({lifecycle:'COMPLETE'})).ok,true);
  const noMetrics=viewOf({lifecycle:'FAILED'},[{id:'a',created_at_ms:1,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null,metrics:null},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
  assert.equal(validateComparisonView(noMetrics).ok,true,'a view without metrics is fine in any lifecycle');
});

test('R1 A3 F3: the evaluation record must reference this comparison and this frozen spec, and be created strictly after the freeze',()=>{
  assert.equal(classifyEvidence(evidenceInput({record_created_at_ms:1001})).evidence_class,'INDEPENDENT');
  assert.deepEqual(classifyEvidence(evidenceInput({record_created_at_ms:1000})).reasons,[CODES.QR3_RESULT_PREDATES_SPEC]);
  const other=classifyEvidence(evidenceInput({record_comparison_id:'c-other'}));
  assert.deepEqual([other.evidence_class,other.reasons],['DEVELOPMENT_EVIDENCE',[CODES.QR3_RESULT_PREDATES_SPEC]]);
  assert.deepEqual(classifyEvidence(evidenceInput({record_spec_hash:'other'})).reasons,[CODES.QR3_RESULT_PREDATES_SPEC]);
  for(const patch of [{record_comparison_id:null},{record_comparison_id:undefined},{record_spec_hash:null},{record_spec_hash:''},{comparison_id:null,record_comparison_id:null},{spec_hash:undefined,record_spec_hash:undefined}]){
    const r=classifyEvidence(evidenceInput(patch));
    assert.deepEqual([r.evidence_class,r.reasons],['DEVELOPMENT_EVIDENCE',[CODES.QR3_INTEGRITY_FAILED]],JSON.stringify(patch));
  }
});
test('R1 E library gate state: PASS with pass false is FAIL, PASS without a pass flag passes, FAIL with pass true fails',()=>{
  const gates=patch=>gatesAllPass().map(item=>item.gate==='G1'?{...item,...patch}:item);
  const r=classifyEvidence(evidenceInput({library_gates:gates({state:'PASS',pass:false})}));
  assert.deepEqual([r.evidence_class,r.failing_gates,r.reasons],['DEVELOPMENT_EVIDENCE',['G1'],[CODES.QR3_NOT_QUALIFIED]]);
  assert.equal(classifyEvidence(evidenceInput({library_gates:gates({state:'PASS',pass:undefined})})).evidence_class,'INDEPENDENT');
  assert.deepEqual(classifyEvidence(evidenceInput({library_gates:gates({state:'FAIL',pass:true})})).failing_gates,['G1']);
  assert.deepEqual(classifyEvidence(evidenceInput({library_gates:gates({state:'pass'})})).failing_gates,['G1']);
});
test('R1 E an exposure event at exactly as_of_ms is counted, a later one is not',()=>{
  const event={owner_id:'o1',market_key:'M',window:shiftW(1),comparison_id:'x1',kind:'QR3_COMPARISON',at_ms:3000};
  const ids=asOf=>exposuresOverlapping({register:[event],owner_id:'o1',market_key:'M',window:W,as_of_ms:asOf}).ids;
  assert.deepEqual(ids(3000),['x1']);assert.deepEqual(ids(3001),['x1']);assert.deepEqual(ids(2999),[]);assert.deepEqual(ids(null),['x1']);
  assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[event],as_of_ms:3000})).reasons,[CODES.QR3_WINDOW_PREVIOUSLY_EXPOSED]);
  assert.deepEqual(classifyEvidence(evidenceInput({exposure_register:[event],as_of_ms:2999})).reasons,[]);
});
test('R1 C HOLDOUT_EXPOSED_BY_COMPARISON alone keeps the class DEVELOPMENT_EVIDENCE',()=>{
  const holdout={start_ms:W.end_ms+1000*MINUTE,end_ms:W.end_ms+2000*MINUTE};
  const entry={owner_id:'o1',market_key:'M',window:holdout,comparison_id:'cmp-2',kind:'QR3_COMPARISON',at_ms:10};
  const r=classifyEvidence(evidenceInput({source_holdout_window:holdout,exposure_register:[entry]}));
  assert.deepEqual([r.evidence_class,r.reasons,r.exposed_by],['DEVELOPMENT_EVIDENCE',[CODES.HOLDOUT_EXPOSED_BY_COMPARISON],['cmp-2']]);
  assert.equal(classifyEvidence(evidenceInput({exposure_register:[entry]})).evidence_class,'INDEPENDENT','without the source holdout window the exposure does not touch the participant');
});
test('R1 B malformed adequacy spec is QR3_SPEC_INCOMPLETE, an absent episode gate is QR3_EPISODE_GATE_NOT_AVAILABLE',()=>{
  for(const spec of [undefined,null,{},{min_episodes_floor:5},{min_episodes_floor:'5',min_episodes_ranking:20},{min_episodes_floor:0,min_episodes_ranking:20},{min_episodes_floor:30,min_episodes_ranking:20}]){
    const r=adequacy({completed_episodes:25,episode_gate_available:true,spec});
    assert.deepEqual([r.state,r.participant_status,r.code],['FAIL','INADEQUATE_SAMPLE',CODES.QR3_SPEC_INCOMPLETE],JSON.stringify(spec));
  }
  assert.equal(adequacy({completed_episodes:25,episode_gate_available:false,spec:{min_episodes_floor:5,min_episodes_ranking:20}}).code,CODES.QR3_EPISODE_GATE_NOT_AVAILABLE);
});

test('R1 A4 V8: a participant whose record exists but fails the evaluation check is DEVELOPMENT_EVIDENCE, metrics visible, never ranked',()=>{
  const missing=participantStatus(statusInput({evaluation:{basis_confirmed:true,metrics:metricsFull({total_fees:null,exposure_percent:undefined})}}));
  assert.deepEqual([missing.status,missing.reasons,missing.metrics_visible],['DEVELOPMENT_EVIDENCE',[CODES.METRIC_NOT_RECORDED],true]);
  assert.deepEqual(missing.metrics.total_fees,{value:null,reason:CODES.METRIC_NOT_RECORDED});assert.deepEqual(missing.metrics.exposure_percent,{value:null,reason:CODES.METRIC_NOT_RECORDED});
  assert.deepEqual(missing.metrics.net_return_percent,{value:'12.5',reason:null});
  assert.deepEqual(Object.values(missing.checks),['PASS','PASS','PASS','FAIL','NOT_REACHED','NOT_REACHED','NOT_REACHED']);
  const both=participantStatus(statusInput({evaluation:{metrics:{net_return_percent:'1'}}}));
  assert.deepEqual([both.status,both.reasons],['DEVELOPMENT_EVIDENCE',[CODES.VALUATION_BASIS_UNCONFIRMED,CODES.METRIC_NOT_RECORDED]]);
  assert.deepEqual(both.metrics.net_return_percent,{value:'1',reason:null});assert.equal(both.metrics.max_drawdown_percent.value,null);
  const nothing=participantStatus(statusInput({evaluation:null}));
  assert.deepEqual([nothing.status,nothing.reasons],['DEVELOPMENT_EVIDENCE',[CODES.VALUATION_BASIS_UNCONFIRMED,CODES.METRIC_NOT_RECORDED]]);
  const noRecord=participantStatus(statusInput({has_evaluation:false,evaluation:undefined,evidence:{evidence_class:'NOT_EVALUATED',reasons:[]}}));
  assert.deepEqual([noRecord.status,noRecord.metrics_visible,noRecord.metrics,noRecord.checks.evaluation],['NOT_EVALUATED',false,null,'FAIL']);
  const rows=[{id:'a',created_at_ms:1,status:both.status,primary_metric:'12.5'},{id:'b',created_at_ms:2,status:both.status,primary_metric:'3'}];
  const outcome=decide(rows,{daily:separated});
  assert.equal(outcome.outcome,'NO_QUALIFIED_RESULT');assert.ok(outcome.participants.every(item=>item.rank===null&&item.label===null));
  const eligible=participantStatus(statusInput());
  assert.deepEqual(eligible.metrics.rejected_intents,{value:0,reason:null});
});
test('R1 C metrics are hidden for EXCLUDED_INCOMPATIBLE, EXCLUDED_COVERAGE, EXCLUDED_INTEGRITY and UNAVAILABLE',()=>{
  const hidden=patch=>{const r=participantStatus(statusInput(patch));return [r.status,r.metrics_visible,r.metrics];};
  assert.deepEqual(hidden({coverage:{state:'FAIL'}}),['EXCLUDED_COVERAGE',false,null]);
  assert.deepEqual(hidden({compatibility:{compatible:false}}),['EXCLUDED_INCOMPATIBLE',false,null]);
  assert.deepEqual(hidden({integrity_ok:false}),['EXCLUDED_INTEGRITY',false,null]);
  assert.deepEqual(hidden({unavailable:true}),['UNAVAILABLE',false,null]);
  for(const status of ['EXCLUDED_COVERAGE','EXCLUDED_INCOMPATIBLE','EXCLUDED_INTEGRITY','UNAVAILABLE'])
    assert.deepEqual(rulesOf(viewOf({},[{id:'a',created_at_ms:1,status,rank:null,label:null,metrics:{net_return_percent:{value:'1',reason:null}}},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}])),['11.2'],status);
});

test('R1 B context: an unlisted sub-key makes the field unreadable (MISSING:<id>) until RD-3 is decided',()=>{
  const with_=(field,extra)=>{const raw=clone(baseContext);raw[field]={...raw[field],...extra};return ctx('p',raw);};
  assert.deepEqual(with_('cost_model',{risk_percent:'1'}).missing,['cost_model']);assert.equal(with_('cost_model',{risk_percent:'1'}).fields.cost_model,'MISSING:p');
  assert.deepEqual(with_('capital',{equity:'5'}).missing,['capital']);assert.deepEqual(with_('market',{venue:'x'}).missing,['market']);
  assert.deepEqual(with_('period',{note:'x'}).missing,['period']);assert.deepEqual(with_('dataset',{extra:1}).missing,['dataset']);
  assert.deepEqual(with_('valuation',{extra:1}).missing,['valuation']);assert.deepEqual(with_('data_model',{extra:1}).missing,['data_model']);assert.deepEqual(with_('execution',{extra:1}).missing,['execution']);
  assert.deepEqual(with_('cost_model',{}).missing,[]);
});
test('R1 B compareToDeclared reads the declared context through the same readers as a participant',()=>{
  const raw=clone(baseContext);raw.cost_model.fee_bps='10.0';raw.capital.initial_cash='1000.00';raw.data_model.price_tick='0.010';
  const good=compareToDeclared(raw,ctx('p1'));
  assert.deepEqual([good.compatible,good.code,good.mismatches],[true,null,[]]);
  const numeric=clone(baseContext);numeric.cost_model.fee_bps='10';
  assert.equal(compareToDeclared(numeric,ctx('p1')).compatible,true);
  const differs=clone(baseContext);differs.cost_model.fee_bps='10.5';
  assert.deepEqual(compareToDeclared(differs,ctx('p1')).mismatches.map(item=>item.field),['cost_model']);
  const extra=clone(baseContext);extra.cost_model.risk_percent='1';
  const unreadable=compareToDeclared(extra,ctx('p1'));assert.deepEqual([unreadable.compatible,unreadable.code,unreadable.declared_missing],[false,CODES.QR3_SPEC_INCOMPLETE,['cost_model']]);
  const missing=clone(baseContext);delete missing.scope;
  assert.deepEqual(compareToDeclared(missing,ctx('p1')).declared_missing,['scope']);
  assert.equal(compareToDeclared(null,ctx('p1')).code,CODES.QR3_SPEC_INCOMPLETE);
  assert.deepEqual(normaliseDeclared(raw).missing,[]);assert.equal(normaliseDeclared(raw).fields.cost_model.fee_bps,'10');
  assert.deepEqual(declaredContextProblems(raw),[]);
  assert.equal(declaredContextProblems(null).length,1);
});
test('R1 E initial inventory: 2 and 0.5 are QR3_SPEC_INCOMPLETE, 0 and 0.0 are accepted',()=>{
  const problems=inventory=>declaredContextProblems(ctx('d',{...clone(baseContext),capital:{initial_cash:'1000',initial_inventory:inventory,quote:'USDT'}}).fields).map(item=>item.code);
  assert.deepEqual(problems('2'),[CODES.QR3_SPEC_INCOMPLETE]);assert.deepEqual(problems('0.5'),[CODES.QR3_SPEC_INCOMPLETE]);assert.deepEqual(problems('-1'),[CODES.QR3_SPEC_INCOMPLETE]);
  assert.deepEqual(problems('0'),[]);assert.deepEqual(problems('0.0'),[]);
});

test('R1 B dataset: a bar counts only when complete is true; duplicate bars at end_ms are ignored',()=>{
  const start=T0,end=T0+5*MINUTE,args={start_ms:start,end_ms:end,warmup_bars:0};
  const noFlag=barsFor(start,end);delete noFlag[1].complete;
  const r=checkDatasetGaps({bars:noFlag,...args});
  assert.deepEqual([r.code,r.incomplete,r.gaps],[CODES.QR3_DATASET_GAPPED,[start+MINUTE],[{start_ms:start+MINUTE,end_ms:start+2*MINUTE}]]);
  assert.deepEqual(checkDatasetGaps({bars:barsFor(start,end).map(bar=>({time_ms:bar.time_ms,complete:'yes'})),...args}).incomplete.length,5);
  const atEnd=[...barsFor(start,end),{time_ms:end,complete:true},{time_ms:end,complete:true},{time_ms:end+MINUTE,complete:true}];
  assert.equal(checkDatasetGaps({bars:atEnd,...args}).ok,true);
  const warm=checkDatasetGaps({bars:[{time_ms:start-MINUTE},...barsFor(start,end)],start_ms:start,end_ms:end,warmup_bars:1});
  assert.equal(warm.code,CODES.QR3_DATASET_GAPPED,'a warm-up bar without the complete flag is incomplete too');
});
test('R1 C period: relative choices anchor at the last completed bar end or at start_ms, and the anchor is frozen in the result',()=>{
  for(const choice of ['1W','1M','3M','6M','1Y','2Y','3Y']){
    const back=period({choice}),forward=period({choice,start_ms:U(2020,1,10)});
    assert.deepEqual([back.period.anchor,back.period.end_ms],['END',L],choice);
    assert.equal(forward.period.anchor,'START',choice);assert.equal(forward.period.start_ms,U(2020,1,10));
    assert.equal(Object.isFrozen(back.period),true);
  }
});
test('R1 C period: YTD with the last completed bar end exactly at January 1 00:00 UTC is QR3_PERIOD_INVALID',()=>{
  const ytd=end=>resolvePeriod({choice:'YTD',last_completed_end_ms:end,warmup_bars:0,max_total_bars:2000000});
  const r=ytd(U(2027,1,1));assert.deepEqual([r.ok,r.code,r.detail],[false,CODES.QR3_PERIOD_INVALID,'END_NOT_AFTER_START']);
  const next=ytd(U(2027,1,1,0,1));assert.equal(next.ok,true);assert.equal(next.period.start_utc,'2027-01-01T00:00:00.000Z');assert.equal(next.period.evaluation_bars,1);
});

test('R1 B valuation: same-bar fills apply in explicit sequence order; a missing or repeated sequence is FILL_ORDER_UNKNOWN',()=>{
  const args={initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],basis_confirmed:true};
  const sell={bar_time_ms:T0,side:'SELL',quantity:'4',price:'90',fee:'0'},buy={bar_time_ms:T0,side:'BUY',quantity:'10',price:'90',fee:'0'};
  const ok=valueRun({...args,fills:[{...sell,sequence:2},{...buy,sequence:1}]});
  assert.equal(ok.ok,true);assert.equal(ok.end_position.quantity,'6');assert.equal(ok.nav_series[0].nav,'1000');
  assert.equal(valueRun({...args,fills:[{...buy,sequence:1},{...sell,sequence:2}]}).end_nav,ok.end_nav,'input order does not matter');
  for(const fills of [[sell,buy],[{...sell,sequence:2},buy],[{...sell,sequence:1},{...buy,sequence:1}],[{...sell,sequence:'2'},{...buy,sequence:1}]]){
    const r=valueRun({...args,fills});assert.deepEqual([r.ok,r.code,r.detail],[false,CODES.QR3_METRIC_UNAVAILABLE,'FILL_ORDER_UNKNOWN']);
  }
  assert.equal(valueRun({...args,fills:[buy]}).ok,true,'one fill on a bar needs no sequence');
  assert.equal(valueRun({...args,fills:[{...sell,sequence:1},{...buy,sequence:2}]}).detail,'NEGATIVE_INVENTORY','a sell sequenced first is a negative inventory');
});
test('R1 E valuation SELL with a fee: cash 99 after the buy, 1047 after the sell, fees 3',()=>{
  const run=valueRun({initial_cash:'1000',period:P4,grid:grid(T0,['90','100','80','95']),flows:[],basis_confirmed:true,
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'10',price:'90',fee:'1'},{bar_time_ms:T0+3*MINUTE,side:'SELL',quantity:'10',price:'95',fee:'2'}]});
  assert.deepEqual(run.nav_series.map(item=>item.nav),['999','1099','899','1047']);
  assert.deepEqual([run.end_nav,run.total_fees,run.net_return_percent,run.end_position.quantity,run.exposure_percent],['1047','3','4.7','0','75']);
  assert.equal(run.max_drawdown_percent,'18.198362147407');
});
test('R1 C valuation V4: the start NAV (initial cash) is the first drawdown point, so a first-bar loss counts',()=>{
  const run=valueRun({initial_cash:'1000',period:{start_ms:T0,end_ms:T0+2*MINUTE},grid:grid(T0,['90','95']),flows:[],basis_confirmed:true,
    fills:[{bar_time_ms:T0,side:'BUY',quantity:'10',price:'100',fee:'0'}]});
  assert.deepEqual(run.nav_series.map(item=>item.nav),['900','950']);assert.equal(run.max_drawdown_percent,'10');assert.equal(run.net_return_percent,'-5');
  const flat=valueRun({initial_cash:'1000',period:{start_ms:T0,end_ms:T0+2*MINUTE},grid:grid(T0,['90','95']),flows:[],fills:[]});
  assert.deepEqual([flat.max_drawdown_percent,flat.net_return_percent,flat.exposure_percent],['0','0','0']);
});
test('R1 E daily returns take the last NAV of each UTC day by time, whatever the input order',()=>{
  const sorted=[{time_ms:U(2026,3,30,23,58),nav:'1005'},{time_ms:U(2026,3,30,23,59),nav:'1010'},{time_ms:U(2026,3,31,0,0),nav:'1020'},{time_ms:U(2026,3,31,23,59),nav:'1030.2'}];
  const want=dailyReturns(sorted,'1000');
  assert.deepEqual(want.returns,['0.01','0.02']);
  assert.deepEqual(dailyReturns([...sorted].reverse(),'1000'),want);
  assert.deepEqual(dailyReturns([sorted[3],sorted[1],sorted[2],sorted[0]],'1000'),want);
  assert.deepEqual(dailyReturns([sorted[1],sorted[0]],'1000').returns,['0.01'],'the later time wins inside one day');
});
test('R1 E round18 rounds half-even at the 19th decimal',()=>{
  const r=value=>round18(value).toFixed();
  assert.equal(r('0.0000000000000000025'),'0.000000000000000002');assert.equal(r('0.0000000000000000035'),'0.000000000000000004');
  assert.equal(r('0.0000000000000000015'),'0.000000000000000002');assert.equal(r('0.0000000000000000045'),'0.000000000000000004');
  assert.equal(r('-0.0000000000000000025'),'-0.000000000000000002');assert.equal(r('0.00000000000000000251'),'0.000000000000000003');
});
test('R1 C benchmark: initial cash below one quantity step is a null row NO_UNITS_AFFORDABLE, excess return null, comparison not refused',()=>{
  const bh=buyAndHold({...bhArgs(),initial_cash:'0.05'});
  assert.deepEqual([bh.ok,bh.code,bh.detail,bh.value],[false,CODES.QR3_METRIC_UNAVAILABLE,'NO_UNITS_AFFORDABLE',null]);
  const excess=excessReturn('1.5',bh);
  assert.deepEqual([excess.value,excess.reason,excess.detail],[null,CODES.QR3_METRIC_UNAVAILABLE,'NO_UNITS_AFFORDABLE']);
  const unreadable=excessReturn('1.5',buyAndHold({...bhArgs(),grid:null}));
  assert.deepEqual([unreadable.value,unreadable.reason],[null,CODES.QR3_BENCHMARK_DATA_UNAVAILABLE]);
  const oneStep=buyAndHold({...bhArgs(),cost_model:{fee_bps:'0',slippage_bps:'0'},initial_cash:'0.1',data_model:{price_tick:'0.01',quantity_step:'0.001'}});
  assert.equal(oneStep.ok,true);assert.equal(oneStep.entry.quantity,'0.001');assert.equal(oneStep.entry.residual_cash,'0');
});
test('R1 C tick rounding is adverse: a buy rounds up, a liquidation sell rounds down (until RD-5 confirms the evaluator)',()=>{
  assert.equal(buyAndHold({...bhArgs(),cost_model:{fee_bps:'0',slippage_bps:'20'},grid:grid(T0,['100.001','100','100'])}).entry.price,'100.21');
  const sell=buyAndHold({...bhArgs(),cost_model:{fee_bps:'0',slippage_bps:'20'},grid:grid(T0,['100','100','100.009']),include_liquidation_line:true});
  assert.equal(sell.liquidation_line.price,'99.8','100.009 * 0.998 = 99.808982 rounds down to the tick');
});

/* ------------------------------------------------------------------ round 2 fixes (G1 to G5, G8) */
test('R2 G1 adequacy: gate not available is QR3_EPISODE_GATE_NOT_AVAILABLE; gate available with an unreadable count is QR3_METRIC_UNAVAILABLE',()=>{
  const spec={min_episodes_floor:5,min_episodes_ranking:20};
  for(const completed of [null,undefined,'30',-1,2.5,NaN,{}]){
    const r=adequacy({spec,episode_gate_available:true,completed_episodes:completed});
    assert.deepEqual([r.state,r.participant_status,r.code],['FAIL','INADEQUATE_SAMPLE',CODES.QR3_METRIC_UNAVAILABLE],String(completed));
  }
  for(const gate of [false,undefined,null,'true',1]){
    const r=adequacy({spec,episode_gate_available:gate,completed_episodes:null});
    assert.deepEqual([r.state,r.participant_status,r.code],['FAIL','INADEQUATE_SAMPLE',CODES.QR3_EPISODE_GATE_NOT_AVAILABLE],String(gate));
  }
  assert.equal(adequacy({spec,episode_gate_available:true,completed_episodes:0}).code,CODES.QR3_SAMPLE_INADEQUATE,'a readable zero is a short sample, not an unreadable count');
  const status=participantStatus(statusInput({completed_episodes:null}));
  assert.equal(status.status,'INADEQUATE_SAMPLE');assert.deepEqual(status.reasons,[CODES.QR3_METRIC_UNAVAILABLE]);assert.equal(status.checks.risk,'NOT_REACHED');
});
test('R2 G2 decideOutcome re-validates the frozen spec: a forged spec whose hash matches is QR3_SPEC_INCOMPLETE with detail SPEC',()=>{
  const good=validateSpec(specIn()).spec;
  const base=spec=>({mode:'STANDARDIZED',spec,spec_hash:specHashOf(spec),context_key:'ck',participants:[elig('a','10'),elig('b','4')],daily_returns_by_id:separated});
  assert.equal(decideOutcome(base(good)).ok,true);
  const refusedSpec=spec=>{const r=decideOutcome(base(spec));return [r.ok,r.code,r.detail];};
  const expected=[false,CODES.QR3_SPEC_INCOMPLETE,'SPEC'];
  assert.deepEqual(refusedSpec({...good,tie:{band_pp:'-1'}}),expected,'negative tie band');
  assert.deepEqual(refusedSpec({...good,risk_filter:{max_drawdown_percent:'90'}}),expected,'loosened drawdown limit');
  assert.deepEqual(refusedSpec({...good,adequacy:{min_episodes_floor:1,min_episodes_ranking:2}}),expected,'loosened episode minimums');
  assert.deepEqual(refusedSpec({...good,objective:'unknown'}),expected,'unknown objective');
  const actual=validateSpec({mode:'ACTUAL_BOT',participants:['a','b'],period:{start_ms:1,end_ms:2}});
  assert.deepEqual(refusedSpec(actual.spec),expected,'an ACTUAL_BOT spec cannot decide a STANDARDIZED outcome');
});
test('R2 G3 any non-allowed label is refused: X1 for a non-eligible row, R3 LABEL_NOT_ALLOWED for an eligible one',()=>{
  const row=(status,label)=>viewOf({outcome:'NO_QUALIFIED_RESULT'},[{id:'a',created_at_ms:1,status,rank:null,label},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
  const found=view=>validateComparisonView(view).violations.map(item=>[item.rule,item.detail]);
  assert.deepEqual(found(row('DEVELOPMENT_EVIDENCE','strongest performer, recommended')),[['X1','LABEL']]);
  assert.deepEqual(found(row('ELIGIBLE_QUALIFIED','strongest performer, recommended')),[['R3','LABEL_NOT_ALLOWED']]);
  assert.deepEqual(found(row('ELIGIBLE_QUALIFIED','Top performer')),[['R3','LABEL_WITHOUT_SELECTED_SCOPE']]);
  assert.deepEqual(found(row('ELIGIBLE_QUALIFIED','')),[['R3','LABEL_NOT_ALLOWED']]);
  assert.equal(validateComparisonView(row('DEVELOPMENT_EVIDENCE',null)).ok,true);
});
test('R2 G4 a number is refused where money or a threshold is read (NUMBER_NOT_DECIMAL_STRING)',()=>{
  const NUM=[CODES.QR3_SPEC_INCOMPLETE,'NUMBER_NOT_DECIMAL_STRING'];
  const refused=r=>[r.ok===false?r.code:null,r.detail];
  assert.deepEqual(refused(validateSpec(specIn({risk_filter:{max_drawdown_percent:20}}))),NUM);
  assert.deepEqual(refused(validateSpec(specIn({tie:{band_pp:0.5}}))),NUM);
  assert.deepEqual(refused(validateSpec(specIn({uncertainty:{...specIn().uncertainty,confidence:0.95}}))),NUM);
  assert.equal(validateSpec(specIn()).ok,true);
  for(const [group,name] of [['capital','initial_cash'],['cost_model','fee_bps'],['cost_model','slippage_bps']]){
    const raw=clone(baseContext);raw[group][name]=group==='capital'?1000:10;
    const entry=ctx('p',raw);
    assert.deepEqual(entry.missing,[group],name);assert.equal(entry.fields[group],'MISSING:p');
    const declared=compareToDeclared(raw,ctx('q'));
    assert.deepEqual([declared.compatible,declared.code,declared.detail,declared.declared_missing],[false,CODES.QR3_SPEC_INCOMPLETE,'NUMBER_NOT_DECIMAL_STRING',[group]],name);
  }
  const stringFee=clone(baseContext);stringFee.cost_model.fee_bps='10';
  assert.equal(compareToDeclared(stringFee,ctx('q')).detail,null);
  const absent=clone(baseContext);delete absent.scope;
  assert.equal(compareToDeclared(absent,ctx('q')).detail,null,'a missing field is not a number refusal');
});
test('R2 G5 a participant reason QR3_SPEC_INCOMPLETE refuses the outcome: a malformed adequacy spec never becomes INADEQUATE_EVIDENCE',()=>{
  const bad=participantStatus(statusInput({spec:{min_episodes_floor:'5',min_episodes_ranking:20,max_drawdown_percent:'20'}}));
  assert.deepEqual([bad.status,bad.reasons],['INADEQUATE_SAMPLE',[CODES.QR3_SPEC_INCOMPLETE]]);
  const r=decide([{id:'a',created_at_ms:1,status:bad.status,reasons:bad.reasons,primary_metric:'1'},{id:'b',created_at_ms:2,status:'INADEQUATE_SAMPLE',reasons:[CODES.QR3_SAMPLE_INADEQUATE],primary_metric:'1'}]);
  assert.deepEqual([r.ok,r.code,r.detail],[false,CODES.QR3_SPEC_INCOMPLETE,'PARTICIPANT_REASON']);
  const fine=decide([{id:'a',created_at_ms:1,status:'INADEQUATE_SAMPLE',reasons:[CODES.QR3_SAMPLE_INADEQUATE],primary_metric:'1'},{id:'b',created_at_ms:2,status:'INADEQUATE_SAMPLE',reasons:[CODES.QR3_SAMPLE_INADEQUATE],primary_metric:'1'}]);
  assert.equal(fine.outcome,'INADEQUATE_EVIDENCE');
});
test('R2 G8 ONLY_QUALIFIED_LABEL with a trailing newline or space is R3 LABEL_WITHOUT_SELECTED_SCOPE',()=>{
  for(const label of [ONLY_QUALIFIED_LABEL+'\n',ONLY_QUALIFIED_LABEL+' ',' '+ONLY_QUALIFIED_LABEL,ONLY_QUALIFIED_LABEL+'\t']){
    const view=viewOf({outcome:'NO_QUALIFIED_RESULT'},[{id:'a',created_at_ms:1,status:'ELIGIBLE_QUALIFIED',rank:null,label},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',rank:null,label:null}]);
    assert.deepEqual(validateComparisonView(view).violations.map(item=>[item.rule,item.detail]),[['R3','LABEL_WITHOUT_SELECTED_SCOPE']],JSON.stringify(label));
  }
});

/* ------------------------------------------------------------------ round 3 rulings H1 to H7 */
test('R3 H1 participantStatus risk step: a number or unreadable threshold is FILTERED_RISK with QR3_SPEC_INCOMPLETE and decideOutcome refuses',()=>{
  const reasonOf=patch=>{const r=participantStatus(statusInput(patch));return [r.status,r.reasons];};
  const incomplete=['FILTERED_RISK',[CODES.QR3_SPEC_INCOMPLETE]];
  assert.deepEqual(reasonOf({spec:{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:20}}),incomplete,'numeric limit');
  assert.deepEqual(reasonOf({spec:{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:null}}),incomplete,'null limit');
  assert.deepEqual(reasonOf({spec:{min_episodes_floor:5,min_episodes_ranking:20}}),incomplete,'absent limit');
  assert.deepEqual(reasonOf({max_drawdown_percent_exact:8}),incomplete,'numeric exact drawdown');
  assert.deepEqual(reasonOf({evaluation:{basis_confirmed:true,metrics:metricsFull({max_drawdown_percent:8})}}),incomplete,'numeric recorded drawdown');
  assert.deepEqual(reasonOf({evaluation:{basis_confirmed:true,metrics:metricsFull({max_drawdown_percent:'abc'})}}),['FILTERED_RISK',[CODES.QR3_METRIC_UNAVAILABLE]],'unreadable drawdown with a good limit stays METRIC_UNAVAILABLE');
  const status=participantStatus(statusInput({spec:{min_episodes_floor:5,min_episodes_ranking:20,max_drawdown_percent:20}}));
  const r=decide([{id:'a',created_at_ms:1,status:status.status,reasons:status.reasons,primary_metric:'1'},{id:'b',created_at_ms:2,status:'DEVELOPMENT_EVIDENCE',reasons:[],primary_metric:'1'}]);
  assert.deepEqual([r.ok,r.code,r.detail],[false,CODES.QR3_SPEC_INCOMPLETE,'PARTICIPANT_REASON']);
});
test('R3 H3 declaredContextProblems sets NUMBER_NOT_DECIMAL_STRING when a declared money field is a number',()=>{
  const raw=clone(baseContext);raw.capital.initial_cash=1000;
  const problems=declaredContextProblems(raw);
  assert.deepEqual(problems.map(item=>[item.code,item.fields,item.detail]),[[CODES.QR3_SPEC_INCOMPLETE,['capital'],'NUMBER_NOT_DECIMAL_STRING']]);
  const absent=clone(baseContext);delete absent.scope;
  assert.equal(declaredContextProblems(absent)[0].detail,undefined,'a missing field carries no number detail');
});
test('R3 H4 decideOutcome STANDARDIZED needs the normalised spec to equal the request spec (version, participants, period)',()=>{
  const good=validateSpec(specIn()).spec;
  const base=spec=>({mode:'STANDARDIZED',spec,spec_hash:specHashOf(spec),context_key:'ck',participants:[elig('a','10'),elig('b','4')],daily_returns_by_id:separated});
  const expected=[false,CODES.QR3_SPEC_INCOMPLETE,'SPEC'];
  const refusedSpec=spec=>{const r=decideOutcome(base(spec));return [r.ok,r.code,r.detail];};
  const old={...good,version:'qr3-spec-v0'};
  assert.equal(specHashOf(old),specHashOf(good),'the hash ignores the version');
  assert.deepEqual(refusedSpec(old),expected,'old version with a matching hash');
  assert.deepEqual(refusedSpec({...good,participants:['b','a']}),expected,'unsorted participants: raw hash matches, normalised form differs');
  assert.deepEqual(refusedSpec({...good,period:{start_ms:1,end_ms:2}}),[true,null,null],'a different period that validateSpec keeps is still a valid frozen spec');
  assert.equal(decideOutcome(base(good)).ok,true);
});
test('R3 H5 an ACTUAL_BOT row with any label, including empty or whitespace, is X4 LABEL',()=>{
  for(const label of ['',' ','	','Top performer']){
    const view={mode:'ACTUAL_BOT',lifecycle:'COMPLETE',outcome:'ACTUAL_HISTORY_SIDE_BY_SIDE',participants:[{id:'a',created_at_ms:1,mode:'ACTUAL_BOT',status:'UNAVAILABLE',rank:null,label}],context_keys:[],claim_texts:[]};
    assert.ok(validateComparisonView(view).violations.some(item=>item.rule==='X4'&&item.detail==='LABEL'),JSON.stringify(label));
  }
});
test('R3 H7 validateSpec: an invalid adequacy with a numeric tie band reports adequacy first',()=>{
  const r=validateSpec(specIn({adequacy:{min_episodes_floor:0,min_episodes_ranking:20},tie:{band_pp:0.5}}));
  assert.deepEqual([r.ok,r.code,r.detail],[false,CODES.QR3_SPEC_INCOMPLETE,'adequacy']);
  const n=validateSpec(specIn({tie:{band_pp:0.5}}));
  assert.deepEqual([n.code,n.detail],[CODES.QR3_SPEC_INCOMPLETE,'NUMBER_NOT_DECIMAL_STRING']);
});

/* ------------------------------------------------------------------ open questions kept as todo (fail closed meanwhile) */
const todo=(name,question)=>test(name,{todo:question},()=>{});
todo('todo OWNER 6.1 F7 wider tie band','OWNER decision open: a tie band narrower than 0.50 is QR3_FILTER_LOOSENED; a wider band is refused QR3_SPEC_INCOMPLETE with detail TIE_BAND_FIXED. Is a wider band an allowed tightening an owner may set?');
todo('todo OWNER 6.6 R5 outcome for one eligible participant','OWNER decision open: with exactly one ELIGIBLE_QUALIFIED participant the module gives no rank and the R5 label only, only_qualified_participant_id set, outcome NO_QUALIFIED_RESULT as built. Does the owner add a new outcome SINGLE_QUALIFIED_RESULT?');
todo('todo 8.1 STALE derived at read (slice S2)','Not in the S1 module (RC-C27). STALE is derived at read from stored rows; it belongs to slice S2 (insert-only tables and reads).');
todo('todo 6.2 REPLAY_MISMATCH (slice S4)','Not in the S1 module (RC-C27). REPLAY_MISMATCH is appended by an explicit replay job; it belongs to slice S4 (runner).');
todo('todo 3.3 ACTUAL_BOT checks (QR-2 S3)','Not in the S1 module (RC-C27). The ACTUAL_BOT context and history checks depend on the QR-2 view header and belong to QR-2 slice S3.');
