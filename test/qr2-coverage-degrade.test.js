import test from 'node:test';
import assert from 'node:assert/strict';
import {planCoverage,buildCoverageSnapshot,buildDegradedCoverageSnapshot,validateCoverageSnapshot,coverageRowCapacity,COVERAGE_DEGRADABLE_LIMITS} from '../src/portfolio/qr2-coverage-snapshot.js';
import {buildBarCoverage,validateBarCoverage,QR2_COVERAGE_BUDGET_REASON,QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
import {projectPublicCoverage,projectPublicCoverageOutcome,validateOwnerCoverage,validateOwnerCoverageShape} from '../src/portfolio/qr2-coverage-public.js';
import {Qr2Error} from '../src/portfolio/qr2-constants.js';

// QR-2 option D (OD-S5-D, root ruling L2): degraded coverage registry, its independent validator, the feasibility check and the public projection.
const M=60000;
const base={union_minutes:1000,timestamp_rows:1000,unique_windows:20,derivation_visits:20000,output_intervals:20000,coverage_input_bytes:1000000,coverage_output_bytes:10000000};
const account=(bot_id,from=0,to=3*M)=>({bot_id,broker:'binance-global',market:{...market},resolved_range:from===null?null:{from,to}});
const unsupported=(bot_id,from=0,to=3*M)=>({bot_id,broker:'binance-th',market:null,resolved_range:{from,to}});
const absent={state:'TABLE_ABSENT'};
const complete=timestamps=>({state:'COMPLETE',timestamps});
const code=(fn,expected)=>assert.throws(fn,error=>error.code===expected&&!(error instanceof Qr2Error),expected);
const REFUSED='QR2_RANGE_ADMISSION_REFUSED',FAILED='QR2_REPORT_FAILED',INVALID='QR2_INPUT_INVALID';
const A=[account('a',0,20*M)];
const fixedBytes=(accounts,budgets)=>{
  const registry=buildCoverageSnapshot({accounts,budgets,facts:planCoverage({accounts,budgets}).unions.map(()=>absent)});
  return registry.charges;
};
const zero=fixedBytes(A,base);
// One context per degradable limit in which the plan alone makes the stop possible.
const CONTEXTS={
  union_minutes:{...base,union_minutes:10},
  timestamp_rows:{...base,timestamp_rows:5},
  derivation_visits:{...base,derivation_visits:5},
  output_intervals:{...base,output_intervals:2},
  coverage_output_bytes:{...base,coverage_output_bytes:zero.output_bytes_upper_bound+50}
};
const degrade=(accounts,budgets,limit)=>buildDegradedCoverageSnapshot({accounts,budgets,limit});
const publicBytes=value=>Buffer.byteLength(JSON.stringify(value));

test('the degradable set is exactly the five budgets of ruling L2; coverage_input_bytes and unique_windows are not members',()=>{
  assert.deepEqual([...COVERAGE_DEGRADABLE_LIMITS],['union_minutes','timestamp_rows','derivation_visits','output_intervals','coverage_output_bytes']);
  assert.ok(Object.isFrozen(COVERAGE_DEGRADABLE_LIMITS));
  for(const limit of ['coverage_input_bytes','unique_windows','ledger_rows','nope',undefined,null])code(()=>degrade(A,base,limit),INVALID);
});

test('stage 1: a BUDGET_EXCEEDED fact builds the exact UNAVAILABLE object with the head of a completed inspection and no count',()=>{
  const range={from:0,to:20*M};
  const built=buildBarCoverage({resolved_range:range,market,fact:{state:'BUDGET_EXCEEDED'}});
  const head=buildBarCoverage({resolved_range:range,market,fact:complete([M])});
  for(const key of ['version','source','market','resolved_range','inspected_window','excluded_edges'])assert.deepEqual(built[key],head[key],key);
  assert.equal(built.state,'UNAVAILABLE');assert.equal(built.reason,'COVERAGE_BUDGET_EXCEEDED');assert.equal(built.reason,QR2_COVERAGE_BUDGET_REASON);assert.equal(built.complete,false);
  for(const key of ['expected_minutes','stored_minutes','missing_minutes','interval_count','intervals'])assert.equal(built[key],null,key);
  assert.equal(Object.keys(built).length,14,'the public object stays closed at 14 keys');
  assert.deepEqual(Object.keys(built),Object.keys(head),'key order is part of the public bytes');
  assert.equal(validateBarCoverage(built).ok,true);
  // Contradictions: a fixed disposition accepts only NOT_NEEDED.
  for(const input of [{resolved_range:range,market:null},{resolved_range:null,market},{resolved_range:{from:1,to:2},market}])
    assert.throws(()=>buildBarCoverage({...input,fact:{state:'BUDGET_EXCEEDED'}}),{code:'QR2_COVERAGE_INVALID'});
  // Shape: no timestamps, no limit name, no extra key.
  for(const fact of [{state:'BUDGET_EXCEEDED',timestamps:[]},{state:'BUDGET_EXCEEDED',limit:'union_minutes'},{state:'BUDGET_EXCEEDED',extra:1}])
    assert.throws(()=>buildBarCoverage({resolved_range:range,market,fact}),{code:'QR2_COVERAGE_INVALID'});
});

test('stage 1 validator: the new reason passes only as the exact all-null UNAVAILABLE object on an inspected head',()=>{
  const range={from:0,to:20*M},good=buildBarCoverage({resolved_range:range,market,fact:{state:'BUDGET_EXCEEDED'}});
  const edits=[c=>{c.expected_minutes=0;},c=>{c.stored_minutes=0;},c=>{c.missing_minutes=0;},c=>{c.interval_count=0;},c=>{c.intervals=[];},c=>{c.complete=true;},c=>{c.state='COMPLETE';},c=>{c.state='EMPTY';},c=>{c.reason='OTHER';},c=>{c.reason=null;},c=>{c.reason='COVERAGE_BUDGET_EXCEEDED ';}];
  for(const edit of edits){const changed=structuredClone(good);edit(changed);assert.equal(validateBarCoverage(changed).ok,false,JSON.stringify(changed));}
  // A fixed-disposition head cannot carry the new reason.
  for(const [resolved_range,m] of [[range,null],[null,market],[{from:1,to:2},market]]){
    const fixed=buildBarCoverage({resolved_range,market:m,fact:{state:'NOT_NEEDED'}});
    assert.equal(validateBarCoverage({...fixed,state:'UNAVAILABLE',reason:'COVERAGE_BUDGET_EXCEEDED',complete:false,expected_minutes:null,stored_minutes:null,missing_minutes:null,interval_count:null,intervals:null}).ok,false);
  }
  // The old reason still validates and the two reasons are not interchangeable.
  const tableAbsent=buildBarCoverage({resolved_range:range,market,fact:absent});
  assert.equal(validateBarCoverage(tableAbsent).ok,true);
  assert.equal(validateBarCoverage({...tableAbsent,reason:'COVERAGE_BUDGET_EXCEEDED'}).ok,true,'same object shape, the reason is the only difference');
  assert.notEqual(tableAbsent.reason,good.reason);
});

test('a degraded registry builds and validates for each degradable limit: no timestamps, no counts, zero data charges',()=>{
  for(const [limit,budgets] of Object.entries(CONTEXTS)){
    const registry=degrade(A,budgets,limit);
    assert.deepEqual(Object.keys(registry),['version','unions','windows','bindings','charges'],limit);
    assert.deepEqual(registry.unions.map(u=>u.fact),[{state:'BUDGET_EXCEEDED',limit}],limit);
    const [w]=registry.windows;
    for(const key of ['start_index','end_index','expected_minutes','stored_minutes','missing_minutes','interval_count'])assert.equal(w[key],null,limit+' '+key);
    const c=registry.charges;
    assert.equal(c.union_minutes,20,limit);assert.equal(c.timestamp_rows,0,limit);assert.equal(c.unique_windows,1,limit);assert.equal(c.derivation_visits,0,limit);assert.equal(c.output_intervals,0,limit);
    const envelope=fixedBytes(A,{...budgets,union_minutes:1000});
    assert.deepEqual({in:c.input_bytes_upper_bound,out:c.output_bytes_upper_bound},{in:envelope.input_bytes_upper_bound,out:envelope.output_bytes_upper_bound},limit+' bytes are the zero-row envelope');
    assert.deepEqual(validateCoverageSnapshot(registry,{accounts:A,budgets}),{ok:true},limit);
    // The registry is plain data and survives a structured clone (the worker message).
    assert.deepEqual(validateCoverageSnapshot(structuredClone(registry),{accounts:A,budgets}),{ok:true},limit);
  }
});

test('feasibility: the worker accepts a claim only when the plan alone makes it possible (union_minutes, rows, visits, intervals, bytes)',()=>{
  // Plan under the default budgets: 20 minutes cannot stop any budget.
  for(const limit of COVERAGE_DEGRADABLE_LIMITS)code(()=>degrade(A,base,limit),FAILED);
  // A claim exported from one context is refused in a context where it is impossible.
  for(const [limit,budgets] of Object.entries(CONTEXTS)){
    const registry=degrade(A,budgets,limit);
    const other=limit==='union_minutes'?{...budgets,union_minutes:1000}:{...budgets,[limit]:limit==='coverage_output_bytes'?10000000:20000};
    assert.throws(()=>validateCoverageSnapshot(registry,{accounts:A,budgets:other}),error=>[FAILED,REFUSED].includes(error.code)&&!(error instanceof Qr2Error),limit);
  }
  // timestamp_rows: the row capacity binds, not the budget value. 7 retained rows fit the input budget; the budget says 1000.
  const fixed=zero.input_bytes_upper_bound,tight={...base,coverage_input_bytes:fixed+17*7};
  assert.equal(coverageRowCapacity({accounts:A,budgets:tight}),7);
  const accepted=degrade(A,tight,'timestamp_rows');
  assert.deepEqual(validateCoverageSnapshot(accepted,{accounts:A,budgets:tight}),{ok:true},'20 minutes > 7 rows although 20 < timestamp_rows');
  const small=[account('a',0,7*M)];
  code(()=>degrade(small,tight,'timestamp_rows'),FAILED);
  const eight=[account('a',0,8*M)];
  assert.ok(degrade(eight,tight,'timestamp_rows'),'8 minutes > 7 rows');
  // derivation_visits: a window holds at most min(expected, capacity) rows. Capacity 3 caps visits at 3.
  const rows3={...base,timestamp_rows:3};
  assert.ok(degrade(A,{...rows3,derivation_visits:2},'derivation_visits'));
  code(()=>degrade(A,{...rows3,derivation_visits:3},'derivation_visits'),FAILED);
  code(()=>degrade(A,{...rows3,derivation_visits:5},'derivation_visits'),FAILED);
  // output_intervals: at most min(ceil(expected/2), capacity + 1) per window. Capacity 3 caps one window at 4.
  assert.ok(degrade(A,{...rows3,output_intervals:3},'output_intervals'));
  code(()=>degrade(A,{...rows3,output_intervals:4},'output_intervals'),FAILED);
  assert.ok(degrade(A,{...base,output_intervals:9},'output_intervals'),'ceil(20/2) = 10 > 9');
  code(()=>degrade(A,{...base,output_intervals:10},'output_intervals'),FAILED);
  // coverage_output_bytes: only when the estimator at the interval upper bounds exceeds the budget; the zero-row envelope itself must still pass.
  assert.ok(degrade(A,{...base,coverage_output_bytes:zero.output_bytes_upper_bound},'coverage_output_bytes'));
  const bounds=fixedBytes(A,base);
  assert.equal(bounds.output_bytes_upper_bound,zero.output_bytes_upper_bound);
  // Two windows add their bounds: a budget above one window's upper bound is still exceeded by the sum.
  const two=[account('a',0,20*M),account('b',100*M,120*M)];
  const zeroTwo=fixedBytes(two,base).output_bytes_upper_bound;
  assert.ok(degrade(two,{...base,coverage_output_bytes:zeroTwo+50},'coverage_output_bytes'));
  // A budget below the zero-row envelope is a plan-time byte refusal, not a degrade.
  code(()=>degrade(A,{...base,coverage_output_bytes:zero.output_bytes_upper_bound-1},'coverage_output_bytes'),REFUSED);
  // A data-time claim in a context whose span is over budget is impossible: union_minutes is decided first.
  code(()=>degrade(A,{...base,union_minutes:10,timestamp_rows:5},'timestamp_rows'),FAILED);
});

test('feasibility: coverage_input_bytes is never a possible claim and unique_windows is not degradable',()=>{
  const registry=structuredClone(degrade(A,CONTEXTS.timestamp_rows,'timestamp_rows'));
  for(const limit of ['coverage_input_bytes','unique_windows','nope'])for(const budgets of [CONTEXTS.timestamp_rows,{...CONTEXTS.timestamp_rows,coverage_input_bytes:zero.input_bytes_upper_bound+17*2}]){
    const edited=structuredClone(registry);edited.unions[0].fact.limit=limit;
    code(()=>validateCoverageSnapshot(edited,{accounts:A,budgets}),FAILED);
  }
});

test('the validator rejects every corruption of a degraded registry; a claim in a span-exceeding context follows the span rules',()=>{
  const two=[account('a',0,20*M),account('b',100*M,120*M)];
  const budgets={...base,timestamp_rows:5},registry=degrade(two,budgets,'timestamp_rows');
  assert.equal(registry.unions.length,2);assert.deepEqual(validateCoverageSnapshot(registry,{accounts:two,budgets}),{ok:true});
  const mutations=[
    ['mixed facts',r=>{r.unions[1].fact={state:'TABLE_ABSENT'};}],
    ['complete fact beside a degraded one',r=>{r.unions[1].fact={state:'COMPLETE',timestamps:[]};}],
    ['mixed limits',r=>{r.unions[1].fact.limit='derivation_visits';}],
    ['timestamps on a degraded fact',r=>{r.unions[0].fact.timestamps=[];}],
    ['extra key',r=>{r.unions[0].fact.extra=1;}],
    ['missing limit',r=>{delete r.unions[0].fact.limit;}],
    ['unknown limit',r=>{r.unions[0].fact.limit='bogus';}],
    ['fewer facts',r=>{r.unions.pop();}],
    ['rows charge',r=>{r.charges.timestamp_rows=1;}],
    ['visits charge',r=>{r.charges.derivation_visits=1;}],
    ['intervals charge',r=>{r.charges.output_intervals=1;}],
    ['union minutes charge',r=>{r.charges.union_minutes+=1;}],
    ['input bytes charge',r=>{r.charges.input_bytes_upper_bound+=1;}],
    ['output bytes charge',r=>{r.charges.output_bytes_upper_bound-=1;}],
    ['window count',r=>{r.windows[0].stored_minutes=0;}],
    ['window expected',r=>{r.windows[0].expected_minutes=20;}],
    ['window interval count',r=>{r.windows[0].interval_count=0;}],
    ['window index',r=>{r.windows[0].start_index=0;}],
    ['binding',r=>{r.bindings[0].window_id=1;}],
    ['version',r=>{r.version='qr2-coverage-snapshot-v2';}]
  ];
  for(const [label,edit] of mutations){const changed=structuredClone(registry);edit(changed);code(()=>validateCoverageSnapshot(changed,{accounts:two,budgets}),FAILED);void label;}
  // Span claim: all facts degraded with the one limit union_minutes in a context that exceeds the span budget.
  const spanBudgets={...base,union_minutes:10},span=degrade(two,spanBudgets,'union_minutes');
  assert.deepEqual(validateCoverageSnapshot(span,{accounts:two,budgets:spanBudgets}),{ok:true});
  for(const [label,edit] of [['charges',r=>{r.charges.union_minutes=1;}],['window',r=>{r.windows[1].stored_minutes=0;}],['bytes',r=>{r.charges.output_bytes_upper_bound+=1;}]]){
    const changed=structuredClone(span);edit(changed);code(()=>validateCoverageSnapshot(changed,{accounts:two,budgets:spanBudgets}),FAILED);void label;
  }
  // Not a span claim, or not all-or-nothing: the registry cannot be a degraded span registry, so the span cap refuses it exactly as before.
  for(const edit of [r=>{r.unions[1].fact={state:'TABLE_ABSENT'};},r=>{r.unions[0].fact.limit='timestamp_rows';r.unions[1].fact.limit='timestamp_rows';}]){
    const changed=structuredClone(span);edit(changed);code(()=>validateCoverageSnapshot(changed,{accounts:two,budgets:spanBudgets}),REFUSED);
  }
  // A degraded span claim with a corrupt fact shape is a corrupt registry.
  const shaped=structuredClone(span);shaped.unions[0].fact.timestamps=[];code(()=>validateCoverageSnapshot(shaped,{accounts:two,budgets:spanBudgets}),FAILED);
  // The span claim presented to a context within the span budget is a corrupt registry.
  code(()=>validateCoverageSnapshot(span,{accounts:two,budgets:base}),FAILED);
});

test('rule 5: a COMPLETE or TABLE_ABSENT registry over union_minutes still fails as a plain refusal, as before',()=>{
  const two=[account('a',0,20*M),account('b',100*M,120*M)],budgets={...base,union_minutes:10};
  for(const facts of [[complete([M]),complete([101*M])],[absent,absent]]){
    const registry=buildCoverageSnapshot({accounts:two,budgets:base,facts});
    code(()=>validateCoverageSnapshot(registry,{accounts:two,budgets}),REFUSED);
    code(()=>projectPublicCoverageOutcome(registry,{accounts:two,budgets}),REFUSED);
  }
  // planCoverage itself is unchanged: the span cap still refuses with its detail.
  assert.throws(()=>planCoverage({accounts:two,budgets}),error=>error.code===REFUSED&&error.detail.limit==='union_minutes'&&error.detail.max===10&&error.detail.value===40);
});

test('the byte estimator reserves the longer reason: a degraded coverage fits the registry bound exactly like the absent-table coverage',()=>{
  assert.equal(QR2_COVERAGE_BUDGET_REASON.length,'MARKET_DATA_TABLE_ABSENT'.length);
  const two=[account('a',0,20*M),unsupported('t')];
  const zeroTwo=fixedBytes(two,base);
  const contexts={...CONTEXTS,coverage_output_bytes:{...base,coverage_output_bytes:zeroTwo.output_bytes_upper_bound+50}};
  for(const [limit,budgets] of Object.entries(contexts)){
    const registry=degrade(two,budgets,limit),projection=projectPublicCoverage(registry,{accounts:two,budgets});
    assert.ok(publicBytes(projection.owner)<=registry.charges.output_bytes_upper_bound,limit);
    for(const item of projection.accounts)assert.ok(publicBytes({market_data:{coverage:item.market_data.coverage}})<=registry.charges.output_bytes_upper_bound,limit);
  }
  const absentRegistry=buildCoverageSnapshot({accounts:A,budgets:base,facts:[absent]});
  const c7=projectPublicCoverage(degrade(A,CONTEXTS.output_intervals,'output_intervals'),{accounts:A,budgets:CONTEXTS.output_intervals}).accounts[0].market_data.coverage;
  const c6=projectPublicCoverage(absentRegistry,{accounts:A,budgets:base}).accounts[0].market_data.coverage;
  assert.equal(publicBytes({market_data:{coverage:c7}}),publicBytes({market_data:{coverage:c6}}),'same length reason, same bytes');
  assert.equal(absentRegistry.charges.output_bytes_upper_bound,fixedBytes(A,base).output_bytes_upper_bound);
});

test('projection: every inspected window is UNAVAILABLE / COVERAGE_BUDGET_EXCEEDED; fixed dispositions and THB keep theirs; the owner envelope validates',()=>{
  const accounts=[account('a',0,20*M),account('b',0,30*M),unsupported('t',0,20*M),account('n',null),account('p',1,2)];
  for(const [limit,budgets] of [['union_minutes',{...base,union_minutes:10}],['timestamp_rows',{...base,timestamp_rows:5}],['output_intervals',{...base,output_intervals:2}]]){
    const context={accounts,budgets},registry=degrade(accounts,budgets,limit);
    const result=projectPublicCoverage(registry,context),section=result.owner.market_coverage;
    const byBot=Object.fromEntries(result.accounts.map(a=>[a.bot_id,a.market_data.coverage]));
    for(const bot of ['a','b']){
      const c=byBot[bot];
      assert.equal(c.state,'UNAVAILABLE',limit);assert.equal(c.reason,'COVERAGE_BUDGET_EXCEEDED',limit);assert.equal(c.complete,false);
      assert.deepEqual([c.expected_minutes,c.stored_minutes,c.missing_minutes,c.interval_count,c.intervals],[null,null,null,null,null]);
      assert.ok(c.inspected_window!==null,'the inspected window and edges are reported as for a completed inspection');
      assert.equal(Object.keys(c).length,14,'the public object stays closed: no limit name');
    }
    assert.deepEqual([byBot.t.state,byBot.t.reason],['UNAVAILABLE','UNSUPPORTED_MARKET'],limit);
    assert.deepEqual([byBot.n.state,byBot.n.reason,byBot.n.complete,byBot.n.interval_count],['EMPTY','RANGE_UNRESOLVED',true,0],limit);
    assert.deepEqual([byBot.p.state,byBot.p.reason],['EMPTY','NO_FULL_CANDLES'],limit);
    assert.equal(section.entries.reduce((n,e)=>n+(e.coverage.interval_count??0),0),registry.charges.output_intervals);
    assert.equal(validateOwnerCoverage(result.owner,context).ok,true,limit);
    assert.equal(validateOwnerCoverageShape(section).ok,true,limit);
    assert.ok(Object.isFrozen(section));
    assert.deepEqual(projectPublicCoverageOutcome(registry,context),{refused:false,projection:result});
  }
});

test('owner validators: one decision per request. A mix of budget-exceeded and other inspected entries is rejected',()=>{
  const accounts=[account('a',0,20*M),account('b',100*M,120*M)],budgets={...base,timestamp_rows:5},context={accounts,budgets};
  const good=projectPublicCoverage(degrade(accounts,budgets,'timestamp_rows'),context);
  assert.equal(validateOwnerCoverage(good.owner,context).ok,true);
  const mixed=structuredClone(good.owner);
  mixed.market_coverage.entries[1].coverage=buildBarCoverage({resolved_range:accounts[1].resolved_range,market,fact:absent});
  assert.equal(validateOwnerCoverage(mixed,context).ok,false);
  assert.equal(validateOwnerCoverageShape(mixed.market_coverage).ok,false);
  const complete2=structuredClone(good.owner);
  for(const [i,entry] of complete2.market_coverage.entries.entries())entry.coverage=buildBarCoverage({resolved_range:accounts[i].resolved_range,market,fact:complete([])});
  assert.equal(validateOwnerCoverage(complete2,context).ok,true,'no budget-exceeded entry at all is the normal case');
  assert.equal(validateOwnerCoverageShape(complete2.market_coverage).ok,true);
  // Over the span budget only a fully degraded envelope passes; anything else is refused exactly as before.
  const spanBudgets={...base,union_minutes:10},spanContext={accounts,budgets:spanBudgets};
  const span=projectPublicCoverage(degrade(accounts,spanBudgets,'union_minutes'),spanContext);
  assert.equal(validateOwnerCoverage(span.owner,spanContext).ok,true);
  // The envelope has no limit name, so an all-degraded envelope passes here whatever the limit; the registry validator checks the claim itself.
  assert.equal(validateOwnerCoverage(good.owner,spanContext).ok,true);
  code(()=>validateOwnerCoverage(complete2,spanContext),REFUSED);
  code(()=>validateOwnerCoverage(mixed,spanContext),REFUSED);
  code(()=>validateOwnerCoverage({market_coverage:null},spanContext),REFUSED);
  const partial=structuredClone(span.owner);
  partial.market_coverage.entries[1].coverage=buildBarCoverage({resolved_range:accounts[1].resolved_range,market,fact:absent});
  code(()=>validateOwnerCoverage(partial,spanContext),REFUSED);
});

test('projection fails closed: a degraded registry presented to the wrong context, or with an edited fact, never projects',()=>{
  const budgets={...base,union_minutes:10},context={accounts:A,budgets},registry=degrade(A,budgets,'union_minutes');
  assert.ok(projectPublicCoverage(registry,context));
  code(()=>projectPublicCoverage(registry,{accounts:A,budgets:base}),FAILED);
  const edited=structuredClone(registry);edited.unions[0].fact={state:'COMPLETE',timestamps:[]};
  code(()=>projectPublicCoverage(edited,context),REFUSED);
  const fake=structuredClone(registry);fake.unions[0].fact.limit='coverage_input_bytes';
  code(()=>projectPublicCoverage(fake,context),REFUSED);
  const infeasible=structuredClone(degrade(A,CONTEXTS.timestamp_rows,'timestamp_rows'));
  code(()=>projectPublicCoverage(infeasible,{accounts:A,budgets:base}),FAILED);
});
