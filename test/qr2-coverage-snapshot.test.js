import test from 'node:test';
import assert from 'node:assert/strict';
import {planCoverage,buildCoverageSnapshot,validateCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {buildBarCoverage,QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
const M=60000;
const budgets={union_minutes:1000,timestamp_rows:1000,unique_windows:20,derivation_visits:20000,output_intervals:20000,coverage_input_bytes:1000000,coverage_output_bytes:10000000};
const account=(bot_id,from=0,to=3*M)=>({bot_id,broker:'binance-global',market:{...market},resolved_range:from===null?null:{from,to}});
const complete=timestamps=>({state:'COMPLETE',timestamps});
const refused=fn=>assert.throws(fn,{code:'QR2_RANGE_ADMISSION_REFUSED'});
const invalid=fn=>assert.throws(fn,{code:'QR2_INPUT_INVALID'});
function envelopes(registry){
  const entries=registry.windows.map(w=>{
    let fact={state:'NOT_NEEDED'};
    if(w.union_id!==null){const source=registry.unions[w.union_id].fact;fact=source.state==='TABLE_ABSENT'?source:complete(source.timestamps.slice(w.start_index,w.end_index));}
    return {id:'coverage:'+w.id,coverage:buildBarCoverage({market:w.market,resolved_range:w.resolved_range,fact})};
  });
  return [{market_coverage:{version:'qr2-owner-bar-coverage-v1',entries,accounts:registry.bindings.map(b=>({bot_id:b.bot_id,broker:b.broker,coverage_ids:['coverage:'+b.window_id]}))}},...entries.map(e=>({market_data:{coverage:e.coverage}}))];
}
function checkBounds(registry){
  assert.ok(Buffer.byteLength(JSON.stringify(registry))<=registry.charges.input_bytes_upper_bound);
  for(const envelope of envelopes(registry))assert.ok(Buffer.byteLength(JSON.stringify(envelope))<=registry.charges.output_bytes_upper_bound);
}

test('deterministic full-range deduplication, touching unions and exact indexed slices',()=>{
  const accounts=[account('b',M,4*M),account('a',0,2*M),account('c',0,2*M),account('d',1,2*M),account('e',4*M,5*M)];
  const plan=planCoverage({accounts,budgets});assert.equal(plan.unions.length,1);assert.equal(plan.windows.length,4);
  assert.deepEqual(plan.unions[0].window,{from:0,to:5*M});
  assert.deepEqual(plan,planCoverage({accounts:[...accounts].reverse(),budgets}));
  const timestamps=[M,2*M,4*M,5*M],registry=buildCoverageSnapshot({accounts,budgets,facts:[complete(timestamps)]});
  assert.equal(registry.unions[0].fact.timestamps,timestamps,'one union storage, no member array');
  assert.deepEqual(registry.windows.map(w=>[w.start_index,w.end_index,w.expected_minutes,w.stored_minutes,w.missing_minutes,w.interval_count]),[[0,2,2,2,0,0],[1,2,1,1,0,0],[1,3,3,2,1,1],[3,4,1,1,0,0]]);
  assert.equal(registry.charges.timestamp_rows,4);assert.equal(registry.charges.derivation_visits,6);
  assert.equal(validateCoverageSnapshot(registry,{accounts,budgets}).ok,true);checkBounds(registry);
});

test('closed states and conservative bytes include empty overhead and escaped UTF-8 references',()=>{
  const cases=[[],[account('null',null)],[account('short',1,2)],[{...account('อื่น\\"\n'),broker:'binance-th',market:null}],[account('a')]];
  for(const accounts of cases){
    const plan=planCoverage({accounts,budgets});
    for(const state of ['COMPLETE','TABLE_ABSENT']){
      const facts=plan.unions.map(()=>state==='COMPLETE'?complete([]):{state});
      const registry=buildCoverageSnapshot({accounts,budgets,facts});checkBounds(registry);
      assert.ok(registry.charges.input_bytes_upper_bound>0&&registry.charges.output_bytes_upper_bound>0);
      assert.equal(validateCoverageSnapshot(registry,{accounts,budgets}).ok,true);
    }
  }
  const empty=buildCoverageSnapshot({accounts:[],budgets,facts:[]});
  for(const k of ['union_minutes','timestamp_rows','unique_windows','derivation_visits','output_intervals'])assert.equal(empty.charges[k],0);
  refused(()=>planCoverage({accounts:[],budgets:{...budgets,coverage_input_bytes:1}}));
  refused(()=>planCoverage({accounts:[],budgets:{...budgets,coverage_output_bytes:1}}));
});

test('twenty-window planner stress is separate from five reachable supported owner bindings',()=>{
  for(const size of [5,20]){
    const accounts=Array.from({length:size},(_,i)=>account('bot'+i,i*M,(i+3)*M));
    const registry=buildCoverageSnapshot({accounts,budgets,facts:[complete(Array.from({length:size+2},(_,i)=>(i+1)*M))]});
    assert.equal(registry.windows.length,size);assert.equal(registry.unions.length,1);assert.equal(registry.charges.derivation_visits,3*size);checkBounds(registry);
  }
  refused(()=>planCoverage({accounts:Array.from({length:21},(_,i)=>account('bot'+i)),budgets}));
});

test('mandatory budgets, exact metadata, identity mapping and duplicate accounts reject before work',()=>{
  invalid(()=>planCoverage({accounts:[],budgets:undefined}));
  for(const value of [0,-1,0.5,'1',Infinity,Number.MAX_SAFE_INTEGER+1])invalid(()=>planCoverage({accounts:[],budgets:{...budgets,timestamp_rows:value}}));
  invalid(()=>planCoverage({accounts:[],budgets:{...budgets,extra:1}}));
  for(const item of [{...account('a'),extra:1},{...account('a'),broker:'invented',market:null},{...account('a'),market:null},{...account('a'),broker:'binance-th'},{...account('a'),bot_id:''}])invalid(()=>planCoverage({accounts:[item],budgets}));
  invalid(()=>planCoverage({accounts:[account('a'),account('a')],budgets}));
  refused(()=>planCoverage({accounts:[account('a')],budgets:{...budgets,union_minutes:1}}));
  refused(()=>planCoverage({accounts:[account('a'),account('b',M,4*M)],budgets:{...budgets,unique_windows:1}}));
});

test('row, canonical visit, interval and final byte admission is aggregate and exact at boundary',()=>{
  const accounts=[account('a'),account('b',M,4*M)],facts=[complete([M,2*M,3*M,4*M])];
  const registry=buildCoverageSnapshot({accounts,budgets,facts});
  for(const [key,value] of [['timestamp_rows',4],['derivation_visits',6]]){
    assert.ok(buildCoverageSnapshot({accounts,budgets:{...budgets,[key]:value},facts}));
    refused(()=>buildCoverageSnapshot({accounts,budgets:{...budgets,[key]:value-1},facts}));
  }
  const gaps=[account('x',0,5*M)],gapFacts=[complete([2*M,4*M])];
  assert.equal(buildCoverageSnapshot({accounts:gaps,budgets:{...budgets,output_intervals:3},facts:gapFacts}).charges.output_intervals,3);
  refused(()=>buildCoverageSnapshot({accounts:gaps,budgets:{...budgets,output_intervals:2},facts:gapFacts}));
  for(const [key,charge] of [['coverage_input_bytes','input_bytes_upper_bound'],['coverage_output_bytes','output_bytes_upper_bound']]){
    assert.ok(buildCoverageSnapshot({accounts,budgets:{...budgets,[key]:registry.charges[charge]},facts}));
    refused(()=>buildCoverageSnapshot({accounts,budgets:{...budgets,[key]:registry.charges[charge]-1},facts}));
  }
});

test('validator checks registry against independent metadata and detects all reference/count corruption',()=>{
  const accounts=[account('a')],registry=buildCoverageSnapshot({accounts,budgets,facts:[complete([M,3*M])]});
  const mutations=[r=>r.extra=1,r=>r.unions.push(r.unions[0]),r=>r.unions[0].id=1,r=>r.unions[0].window.to=4*M,r=>r.unions[0].fact.timestamps=[M,M],r=>r.windows[0].start_index=1,r=>r.windows[0].missing_minutes=0,r=>r.windows[0].union_id=null,r=>r.bindings[0].window_id=9,r=>r.bindings[0].broker='binance-th',r=>r.charges.derivation_visits=1,r=>r.windows[0].extra=1];
  for(const edit of mutations){const changed=structuredClone(registry);edit(changed);assert.throws(()=>validateCoverageSnapshot(changed,{accounts,budgets}),{code:'QR2_REPORT_FAILED'});}
  assert.throws(()=>validateCoverageSnapshot(registry,{accounts:[account('a',M,3*M)],budgets}),{code:'QR2_REPORT_FAILED'});
});

test('builder and validator leave caller data unchanged',()=>{
  const accounts=[account('a')],facts=[complete([M])],saved=structuredClone({accounts,budgets,facts});
  Object.freeze(facts[0].timestamps);Object.freeze(facts[0]);Object.freeze(facts);
  const registry=buildCoverageSnapshot({accounts,budgets,facts});validateCoverageSnapshot(registry,{accounts,budgets});
  assert.deepEqual({accounts,budgets,facts},saved);
});

test('validator maps corrupt or context-oversized registry resources to report failure without changing build admission',()=>{
  const accounts=[account('a',0,5*M)],facts=[complete([M,3*M,5*M])];
  const valid=buildCoverageSnapshot({accounts,budgets,facts});
  const limited={...budgets,timestamp_rows:1};
  const corrupt=buildCoverageSnapshot({accounts,budgets:limited,facts:[complete([M])]});
  corrupt.unions[0].fact.timestamps.push(3*M);
  assert.throws(()=>validateCoverageSnapshot(corrupt,{accounts,budgets:limited}),{code:'QR2_REPORT_FAILED'});
  for(const stricter of [limited,{...budgets,derivation_visits:2},{...budgets,output_intervals:1},
    {...budgets,coverage_input_bytes:valid.charges.input_bytes_upper_bound-1},
    {...budgets,coverage_output_bytes:valid.charges.output_bytes_upper_bound-1}]){
    assert.throws(()=>validateCoverageSnapshot(valid,{accounts,budgets:stricter}),{code:'QR2_REPORT_FAILED'});
    refused(()=>buildCoverageSnapshot({accounts,budgets:stricter,facts}));
  }
  // An over-budget array must be rejected by length before any element getter can run.
  const oversized=structuredClone(valid);let visited=false;
  Object.defineProperty(oversized.unions[0].fact.timestamps,0,{get(){visited=true;throw Error('must not traverse');}});
  assert.throws(()=>validateCoverageSnapshot(oversized,{accounts,budgets:limited}),{code:'QR2_REPORT_FAILED'});
  assert.equal(visited,false);
  invalid(()=>validateCoverageSnapshot(valid,{accounts,budgets:{...budgets,timestamp_rows:0}}));
  invalid(()=>validateCoverageSnapshot(valid,{accounts:[{...accounts[0],broker:'invented'}],budgets}));
});
