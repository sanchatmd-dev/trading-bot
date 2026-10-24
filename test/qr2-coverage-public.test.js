import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planCoverage,buildCoverageSnapshot,validateCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {buildBarCoverage,validateBarCoverage,QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
import {projectPublicCoverage,validateOwnerCoverage,admitSerializedBytes,OWNER_COVERAGE_VERSION,projectPublicCoverageOutcome,validateOwnerCoverageShape} from '../src/portfolio/qr2-coverage-public.js';
const M=60000;
const budgets={union_minutes:1000,timestamp_rows:1000,unique_windows:20,derivation_visits:20000,output_intervals:20000,coverage_input_bytes:1000000,coverage_output_bytes:10000000};
const account=(bot_id,from=0,to=3*M)=>({bot_id,broker:'binance-global',market:{...market},resolved_range:from===null?null:{from,to}});
const unsupported=(bot_id,from=0,to=3*M)=>({bot_id,broker:'binance-th',market:null,resolved_range:{from,to}});
const complete=timestamps=>({state:'COMPLETE',timestamps});
const absent={state:'TABLE_ABSENT'};
const refused=fn=>assert.throws(fn,{code:'QR2_RANGE_ADMISSION_REFUSED'});
const invalid=fn=>assert.throws(fn,{code:'QR2_INPUT_INVALID'});
const failed=fn=>assert.throws(fn,{code:'QR2_REPORT_FAILED'});
const ctx=(accounts,b=budgets)=>({accounts,budgets:b});
function registryOf(accounts,factOf,b=budgets){
  const plan=planCoverage({accounts,budgets:b});
  return buildCoverageSnapshot({accounts,budgets:b,facts:plan.unions.map(factOf)});
}
function deepFreeze(value){
  if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}
  return value;
}
// Independent oracle: Stage 1 builder over an explicit array slice, and the owner mapping recomputed from context.accounts.
function oracleEntries(registry){
  return registry.windows.map(w=>{
    let fact={state:'NOT_NEEDED'};
    if(w.union_id!==null){const source=registry.unions[w.union_id].fact;fact=source.state==='TABLE_ABSENT'?{state:'TABLE_ABSENT'}:complete(source.timestamps.slice(w.start_index,w.end_index));}
    return buildBarCoverage({market:w.market,resolved_range:w.resolved_range,fact});
  });
}
function checkAgainstOracle(registry,context,result){
  const expected=oracleEntries(registry),section=result.owner.market_coverage;
  assert.equal(section.version,OWNER_COVERAGE_VERSION);
  assert.deepEqual(Object.keys(result.owner),['market_coverage']);
  assert.deepEqual(Object.keys(section),['version','entries','accounts']);
  assert.equal(section.entries.length,expected.length);
  expected.forEach((coverage,i)=>{
    assert.equal(section.entries[i].id,'coverage:'+i);
    assert.deepEqual(Object.keys(section.entries[i]),['id','coverage']);
    assert.deepEqual(section.entries[i].coverage,coverage);
    assert.equal(JSON.stringify(section.entries[i].coverage),JSON.stringify(coverage),'key order is part of the public bytes');
    assert.equal(validateBarCoverage(section.entries[i].coverage).ok,true);
  });
  const sameWindow=(w,a)=>JSON.stringify([w.market,w.resolved_range])===JSON.stringify([a.market,a.resolved_range===undefined?null:a.resolved_range]);
  const mapping=context.accounts.map(a=>({bot_id:a.bot_id,broker:a.broker,coverage_ids:['coverage:'+registry.windows.findIndex(w=>sameWindow(w,{market:a.market===null?null:{...a.market},resolved_range:a.resolved_range}))]}))
    .sort((a,b)=>a.bot_id<b.bot_id?-1:a.bot_id>b.bot_id?1:a.broker<b.broker?-1:a.broker>b.broker?1:0);
  assert.deepEqual(section.accounts,mapping);
  assert.equal(result.accounts.length,mapping.length);
  result.accounts.forEach((item,i)=>{
    assert.deepEqual(Object.keys(item),['bot_id','broker','market_data']);
    assert.deepEqual(Object.keys(item.market_data),['coverage']);
    assert.equal(item.bot_id,mapping[i].bot_id);
    assert.equal(item.market_data.coverage,section.entries[Number(mapping[i].coverage_ids[0].slice(9))].coverage);
  });
  assert.equal(section.entries.reduce((n,e)=>n+(e.coverage.interval_count??0),0),registry.charges.output_intervals);
  registry.windows.forEach((w,i)=>{for(const k of ['expected_minutes','stored_minutes','missing_minutes','interval_count'])assert.equal(section.entries[i].coverage[k],w[k]);});
  assert.ok(Buffer.byteLength(JSON.stringify(result.owner))<=registry.charges.output_bytes_upper_bound);
  for(const e of section.entries)assert.ok(Buffer.byteLength(JSON.stringify({market_data:{coverage:e.coverage}}))<=registry.charges.output_bytes_upper_bound);
  assert.equal(validateOwnerCoverage(result.owner,context).ok,true);
}
function project(accounts,factOf,b=budgets){
  const registry=registryOf(accounts,factOf,b),context=ctx(accounts,b),result=projectPublicCoverage(registry,context);
  checkAgainstOracle(registry,context,result);
  return {registry,context,result};
}
const only=result=>{assert.equal(result.owner.market_coverage.entries.length,1);return result.owner.market_coverage.entries[0].coverage;};

test('unsupported market projects UNAVAILABLE with null counts and no union',()=>{
  const {registry,result}=project([unsupported('x')],()=>assert.fail('no union expected'));
  assert.equal(registry.unions.length,0);
  const c=only(result);
  assert.equal(c.state,'UNAVAILABLE');assert.equal(c.reason,'UNSUPPORTED_MARKET');assert.equal(c.complete,false);assert.equal(c.market,null);
  assert.equal(c.intervals,null);assert.equal(c.interval_count,null);
});

test('null resolved range projects EMPTY RANGE_UNRESOLVED with zero counts',()=>{
  const {result}=project([account('n',null)],()=>assert.fail('no union expected'));
  const c=only(result);
  assert.equal(c.state,'EMPTY');assert.equal(c.reason,'RANGE_UNRESOLVED');assert.equal(c.complete,true);assert.deepEqual(c.intervals,[]);assert.equal(c.expected_minutes,0);
});

test('range without a full candle projects EMPTY NO_FULL_CANDLES with the partial edge',()=>{
  const {result}=project([account('s',1,2)],()=>assert.fail('no union expected'));
  const c=only(result);
  assert.equal(c.state,'EMPTY');assert.equal(c.reason,'NO_FULL_CANDLES');assert.equal(c.inspected_window,null);
  assert.deepEqual(c.excluded_edges,[{from:1,to:2,reason:'PARTIAL_CANDLE'}]);
});

test('TABLE_ABSENT projects UNAVAILABLE MARKET_DATA_TABLE_ABSENT without intervals',()=>{
  const {result}=project([account('t',0,5*M)],()=>absent);
  const c=only(result);
  assert.equal(c.state,'UNAVAILABLE');assert.equal(c.reason,'MARKET_DATA_TABLE_ABSENT');assert.equal(c.complete,false);assert.equal(c.intervals,null);assert.equal(c.missing_minutes,null);
});

test('COMPLETE with zero rows projects one all-missing interval',()=>{
  const {result}=project([account('z',0,5*M)],()=>complete([]));
  const c=only(result);
  assert.equal(c.state,'COMPLETE');assert.equal(c.stored_minutes,0);assert.equal(c.expected_minutes,5);assert.equal(c.missing_minutes,5);
  assert.deepEqual(c.intervals,[{from:0,to:5*M,missing_minutes:5}]);
});

test('mixed internal, leading and trailing gaps in exact order',()=>{
  const {result}=project([account('m',0,10*M)],()=>complete([2*M,3*M,7*M]));
  const c=only(result);
  assert.deepEqual(c.intervals,[{from:0,to:M,missing_minutes:1},{from:3*M,to:6*M,missing_minutes:3},{from:7*M,to:10*M,missing_minutes:3}]);
  assert.equal(c.stored_minutes,3);assert.equal(c.missing_minutes,7);assert.equal(c.interval_count,3);
});

test('a complete window without gaps projects an empty interval list',()=>{
  const {result}=project([account('f',0,3*M)],()=>complete([M,2*M,3*M]));
  const c=only(result);
  assert.equal(c.state,'COMPLETE');assert.deepEqual(c.intervals,[]);assert.equal(c.missing_minutes,0);
});

test('more than fifty gaps are listed without truncation',()=>{
  const timestamps=[];for(let i=2;i<=198;i+=2)timestamps.push(i*M);
  const {registry,result}=project([account('g',0,200*M)],()=>complete(timestamps),{...budgets,union_minutes:200,timestamp_rows:200});
  const c=only(result);
  assert.equal(c.interval_count,100);assert.equal(c.intervals.length,100);assert.ok(c.intervals.length>50);
  assert.equal(registry.charges.output_intervals,100);
});

test('equal windows share one entry and nested windows keep their own entry from the same union array',()=>{
  const accounts=[account('a',0,5*M),account('b',0,5*M),account('c',M,3*M)];
  const timestamps=[M,2*M,4*M,5*M];
  const {registry,result}=project(accounts,()=>complete(timestamps));
  const section=result.owner.market_coverage;
  assert.equal(registry.unions.length,1);assert.equal(registry.windows.length,2);assert.equal(section.entries.length,2);
  assert.deepEqual(section.accounts.map(a=>[a.bot_id,a.coverage_ids[0]]),[['a','coverage:0'],['b','coverage:0'],['c','coverage:1']]);
  assert.equal(result.accounts[0].market_data.coverage,result.accounts[1].market_data.coverage,'one built object per window');
  assert.equal(section.entries[0].coverage.interval_count,1);assert.equal(section.entries[1].coverage.interval_count,1);
  assert.deepEqual(section.entries[1].coverage.intervals,[{from:2*M,to:3*M,missing_minutes:1}]);
});

test('different partial edges give distinct entries',()=>{
  const accounts=[account('a',0,3*M),account('b',1,3*M),account('c',0,3*M+5)];
  const {result}=project(accounts,()=>complete([M,2*M,3*M]));
  const entries=result.owner.market_coverage.entries;
  assert.equal(entries.length,3);
  assert.equal(new Set(entries.map(e=>JSON.stringify(e.coverage.excluded_edges))).size,3);
  assert.equal(new Set(result.owner.market_coverage.accounts.map(a=>a.coverage_ids[0])).size,3);
});

test('five-member owner maps every member to exactly one entry in registry order',()=>{
  const accounts=[account('e',2*M,8*M),account('d',0,10*M),account('c',null),unsupported('b'),account('a',0,10*M)];
  const {registry,result}=project(accounts,()=>complete([M,2*M,5*M,9*M]));
  const section=result.owner.market_coverage;
  assert.equal(section.accounts.length,5);
  assert.deepEqual(section.accounts.map(a=>[a.bot_id,a.broker,a.coverage_ids.join()]),[['a','binance-global','coverage:2'],['b','binance-th','coverage:0'],['c','binance-global','coverage:1'],['d','binance-global','coverage:2'],['e','binance-global','coverage:3']]);
  assert.deepEqual(section.entries.map(e=>e.coverage.reason),['UNSUPPORTED_MARKET','RANGE_UNRESOLVED',null,null]);
  assert.deepEqual(registry.windows.map(w=>w.id),[0,1,2,3]);
});

test('zero accounts give empty entries and accounts',()=>{
  const {result}=project([],()=>assert.fail('no union expected'));
  assert.deepEqual(result.owner,{market_coverage:{version:OWNER_COVERAGE_VERSION,entries:[],accounts:[]}});
  assert.deepEqual(result.accounts,[]);
});

test('single-account form is the same coverage object as the entry',()=>{
  const {result}=project([account('solo',0,5*M)],()=>complete([2*M]));
  assert.equal(result.accounts.length,1);
  assert.equal(result.accounts[0].market_data.coverage,result.owner.market_coverage.entries[0].coverage);
  assert.deepEqual(Object.keys(result.accounts[0].market_data),['coverage']);
});

test('owner validator rejects duplicate, orphan, unresolved and mismatched references',()=>{
  const accounts=[account('a',0,5*M),account('b',M,4*M)],{context,result}=project(accounts,()=>complete([M,3*M]));
  const edit=fn=>{const owner=structuredClone(result.owner);fn(owner.market_coverage);return validateOwnerCoverage(owner,context);};
  const path=(fn)=>{const r=edit(fn);assert.equal(r.ok,false);assert.equal(r.errors.length,1);assert.equal(r.errors[0].code,'QR2_OWNER_COVERAGE_INVALID');return r.errors[0].path;};
  assert.deepEqual(validateOwnerCoverage(result.owner,context),{ok:true,errors:[]});
  assert.equal(path(s=>s.accounts.push({...s.accounts[0]})),'accounts.2.duplicate');
  assert.equal(path(s=>{s.accounts[1].coverage_ids=['coverage:0'];}),'entries.orphan');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=['coverage:9'];}),'accounts.0.coverage_ids.unresolved');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=['coverage:00'];}),'accounts.0.coverage_ids.unresolved');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=['coverage:-1'];}),'accounts.0.coverage_ids.unresolved');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=[7];}),'accounts.0.coverage_ids.unresolved');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=[];}),'accounts.0.coverage_ids');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=['coverage:0','coverage:1'];}),'accounts.0.coverage_ids');
  assert.equal(path(s=>{s.accounts[0].coverage_ids=['coverage:1'];s.accounts[1].coverage_ids=['coverage:0'];}),'accounts.0.mapping');
  assert.equal(path(s=>s.accounts.pop()),'entries.orphan');
  assert.equal(path(s=>{s.accounts[1].bot_id='x';}),'accounts.1.set');
  assert.equal(path(s=>{s.accounts.reverse();}),'accounts.0.set');
  assert.equal(path(s=>{s.accounts[0].coverage=s.entries[0].coverage;}),'accounts.0');
  assert.equal(path(s=>{s.entries[0].id='coverage:1';}),'entries.0.id');
  assert.equal(path(s=>{s.entries.reverse();}),'entries.0.id');
  assert.equal(path(s=>{s.entries[1].coverage.stored_minutes+=1;}),'entries.1.coverage');
  assert.equal(path(s=>{s.entries[0].coverage=structuredClone(s.entries[1].coverage);}),'entries.0.window');
  assert.equal(path(s=>{s.entries.pop();}),'entries.length');
  assert.equal(path(s=>{s.version='qr2-owner-bar-coverage-v0';}),'version');
  assert.equal(path(s=>{s.extra=1;}),'market_coverage');
  assert.equal(path(s=>{s.entries[0].extra=1;}),'entries.0');
  assert.equal(validateOwnerCoverage({market_coverage:result.owner.market_coverage,extra:1},context).errors[0].path,'envelope');
  assert.equal(validateOwnerCoverage(null,context).errors[0].path,'envelope');
});

test('owner validator checks the set against context.accounts, not against itself',()=>{
  const accounts=[account('a',0,5*M),account('b',M,4*M)],{result}=project(accounts,()=>complete([M,3*M]));
  for(const other of [[account('a',0,5*M)],[account('a',0,5*M),account('c',M,4*M)],[account('a',0,5*M),account('b',M,5*M)],[]]){
    assert.equal(validateOwnerCoverage(result.owner,ctx(other)).ok,false);
  }
  invalid(()=>validateOwnerCoverage(result.owner,null));
  invalid(()=>validateOwnerCoverage(result.owner,{accounts}));
  invalid(()=>validateOwnerCoverage(result.owner,ctx([{...accounts[0],extra:1}])));
});

test('projection fails closed on a corrupt registry or a context that disagrees with it',()=>{
  const accounts=[account('a',0,5*M)],registry=registryOf(accounts,()=>complete([M,3*M])),context=ctx(accounts);
  const mutations=[r=>r.extra=1,r=>r.unions.push(r.unions[0]),r=>r.unions[0].fact.timestamps.push(4*M),r=>r.unions[0].fact.timestamps=[M,M],r=>r.windows[0].start_index=1,r=>r.windows[0].interval_count=0,r=>r.windows[0].union_id=null,r=>r.bindings[0].window_id=9,r=>r.charges.output_intervals=1,r=>r.charges.output_bytes_upper_bound=1,r=>r.windows[0].extra=1,r=>{r.version='x';}];
  for(const edit of mutations){const changed=structuredClone(registry);edit(changed);failed(()=>projectPublicCoverage(changed,context));}
  failed(()=>projectPublicCoverage(null,context));
  failed(()=>projectPublicCoverage([],context));
  failed(()=>projectPublicCoverage(registry,ctx([account('a',M,5*M)])));
  failed(()=>projectPublicCoverage(registry,ctx([account('b',0,5*M)])));
  failed(()=>projectPublicCoverage(registry,ctx([])));
  failed(()=>projectPublicCoverage(registry,ctx(accounts,{...budgets,coverage_output_bytes:registry.charges.output_bytes_upper_bound-1})));
  failed(()=>projectPublicCoverage(registry,ctx(accounts,{...budgets,output_intervals:1})));
  assert.ok(projectPublicCoverage(registry,ctx(accounts,{...budgets,coverage_output_bytes:registry.charges.output_bytes_upper_bound})));
});

test('invalid context or byte limit is an input error before any registry work',()=>{
  const accounts=[account('a')],registry=registryOf(accounts,()=>complete([M]));
  for(const bad of [undefined,null,[],{},{accounts},{budgets},{...ctx(accounts),extra:1},'x'])invalid(()=>projectPublicCoverage(registry,bad));
  const getter={accounts,get budgets(){return budgets;}};
  invalid(()=>projectPublicCoverage(registry,getter));
  invalid(()=>projectPublicCoverage(registry,ctx(accounts,{...budgets,timestamp_rows:0})));
  invalid(()=>projectPublicCoverage(registry,ctx([{...accounts[0],broker:'invented'}])));
  for(const limit of [0,-1,0.5,'1',null,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{},[]])invalid(()=>projectPublicCoverage(registry,ctx(accounts),limit));
  invalid(()=>projectPublicCoverage({},ctx(accounts),0));
  assert.ok(projectPublicCoverage(registry,ctx(accounts),undefined));
});

test('byte limit accepts exactly the actual size and refuses one byte less',()=>{
  const accounts=[account('a',0,5*M),account('b',M,4*M),unsupported('c')],registry=registryOf(accounts,()=>complete([M,3*M])),context=ctx(accounts);
  const base=projectPublicCoverage(registry,context);
  const sizes=[Buffer.byteLength(JSON.stringify(base.owner)),...base.owner.market_coverage.entries.map(e=>Buffer.byteLength(JSON.stringify({market_data:{coverage:e.coverage}})))];
  const actual=Math.max(...sizes);
  assert.equal(actual,sizes[0],'owner envelope is the largest object');
  assert.ok(actual<registry.charges.output_bytes_upper_bound,'estimate is an upper bound, not equal');
  assert.deepEqual(projectPublicCoverage(registry,context,actual),base);
  refused(()=>projectPublicCoverage(registry,context,actual-1));
  refused(()=>projectPublicCoverage(registry,context,1));
  // The seam only lowers: a larger value leaves the budget as the limit.
  assert.deepEqual(projectPublicCoverage(registry,context,Number.MAX_SAFE_INTEGER),base);
  assert.deepEqual(projectPublicCoverage(registry,ctx(accounts,{...budgets,coverage_output_bytes:registry.charges.output_bytes_upper_bound}),actual),base);
  // A single-account wrapper is measured too: the smallest wrapper still fits, the owner envelope sets the limit.
  const wrapper=Math.min(...sizes.slice(1));
  assert.ok(wrapper<actual);
});

test('serialized size gate checks the estimate first: overrun is a defect, only a lowered limit refuses',()=>{
  admitSerializedBytes(100,100,100);
  admitSerializedBytes(99,100,100);
  admitSerializedBytes(100,200,100);
  refused(()=>admitSerializedBytes(101,200,100));
  failed(()=>admitSerializedBytes(101,100,100),'above both estimate and limit is an estimator defect');
  failed(()=>admitSerializedBytes(101,100,50));
  failed(()=>admitSerializedBytes(101,100,200));
  failed(()=>admitSerializedBytes(150,149,150));
});

test('outputs are deep-frozen and the shared entry object is frozen once',()=>{
  const accounts=[account('a',0,5*M),account('b',0,5*M),unsupported('u')],{result}=project(accounts,()=>complete([M,3*M]));
  const seen=new Set(),walk=value=>{if(value!==null&&typeof value==='object'){assert.ok(Object.isFrozen(value),'frozen');seen.add(value);for(const item of Object.values(value))walk(item);}};
  walk(result);
  const shared=result.accounts[0].market_data.coverage;
  assert.equal(shared,result.accounts[1].market_data.coverage);
  assert.equal(shared,result.owner.market_coverage.entries.find(e=>e.coverage===shared).coverage);
  assert.throws(()=>{shared.state='EMPTY';},TypeError);
  assert.throws(()=>{shared.intervals.push({});},TypeError);
  assert.throws(()=>{result.owner.market_coverage.entries.push({});},TypeError);
  assert.throws(()=>{result.accounts[0].market_data.extra=1;},TypeError);
  assert.throws(()=>{result.accounts.pop();},TypeError);
});

test('multibyte and escaped identifiers stay within the estimate and the byte limit is exact in UTF-8',()=>{
  const ids=['บอท- -"\\\n-😀-\u0000','😀'.repeat(20),'\ud800lone','ก'.repeat(40)];
  const accounts=ids.map((id,i)=>account(id,i*M,(i+4)*M)),{registry,context,result}=project(accounts,()=>complete([2*M,3*M,6*M]));
  const text=JSON.stringify(result.owner),actual=Buffer.byteLength(text);
  assert.ok(actual>text.length,'multibyte output: bytes exceed UTF-16 length');
  assert.ok(actual<=registry.charges.output_bytes_upper_bound);
  assert.deepEqual(result.owner.market_coverage.accounts.map(a=>a.bot_id).sort(),[...ids].sort());
  assert.deepEqual(projectPublicCoverage(registry,context,actual),result);
  refused(()=>projectPublicCoverage(registry,context,actual-1));
});

test('owner validator rejects accessors, sparse arrays, subclasses, foreign prototypes and symbol keys without running getters',()=>{
  const accounts=[account('a',0,5*M),account('b',M,4*M)],{context,result}=project(accounts,()=>complete([M,3*M]));
  const bad=(fn,path)=>{
    const owner=structuredClone(result.owner);fn(owner.market_coverage);
    const r=validateOwnerCoverage(owner,context);
    assert.equal(r.ok,false);assert.equal(r.errors.length,1);assert.equal(r.errors[0].code,'QR2_OWNER_COVERAGE_INVALID');
    if(path!==undefined)assert.equal(r.errors[0].path,path);
    return r;
  };
  const sparse=length=>{const a=new Array(length);return a;};
  let ran=false;
  const getter=(target,key)=>Object.defineProperty(target,key,{enumerable:true,configurable:true,get(){ran=true;throw new Error('must not run');}});
  bad(s=>getter(s.accounts[0],'bot_id'));
  bad(s=>getter(s.entries[0].coverage,'state'));
  bad(s=>getter(s.entries[0].coverage,'intervals'));
  bad(s=>getter(s.entries[1],'coverage'));
  bad(s=>getter(s,'version'));
  bad(s=>Object.defineProperty(s.accounts[0],'broker',{enumerable:true,configurable:true,get:()=>'binance-global'}));
  bad(s=>Object.defineProperty(s.entries[0].coverage,'state',{enumerable:true,configurable:true,set(){} ,get:undefined}));
  assert.equal(ran,false,'no getter was invoked');
  bad(s=>{s.accounts[0].coverage_ids=sparse(1);});
  bad(s=>{s.entries[0].coverage.intervals=sparse(2);});
  bad(s=>{assert.equal(s.entries[0].coverage.intervals.length,2);delete s.entries[0].coverage.intervals[0];});
  class Sub extends Array{}
  bad(s=>{s.accounts[0].coverage_ids=Sub.from(s.accounts[0].coverage_ids);});
  bad(s=>{s.entries=Sub.from(s.entries);},'envelope.market_coverage.entries');
  bad(s=>{s.accounts=Sub.from(s.accounts);},'envelope.market_coverage.accounts');
  bad(s=>{s.entries[0].coverage.excluded_edges=Sub.from(s.entries[0].coverage.excluded_edges);});
  bad(s=>{Object.setPrototypeOf(s.entries[0],{});});
  bad(s=>{Object.setPrototypeOf(s.entries[0].coverage,Array.prototype);});
  bad(s=>{Object.setPrototypeOf(s.accounts[0],{inherited:1});});
  bad(s=>{s.entries[0].coverage[Symbol('x')]=1;});
  bad(s=>{s.accounts[0][Symbol('x')]=1;});
  bad(s=>{s.entries[0].coverage.market={...s.entries[0].coverage.market,symbol:'x'};});
  bad(s=>{s.entries[0].coverage.stored_minutes=()=>1;});
  bad(s=>{s.entries[0].coverage.stored_minutes=1n;});
  // A cyclic envelope is rejected without a stack overflow escaping.
  bad(s=>{s.entries[0].coverage.self=s.entries[0].coverage;});
  bad(s=>{s.accounts[0].coverage_ids.push(s.accounts[0].coverage_ids);});
  for(const hostile of [new Proxy({},{ownKeys(){throw new Error('trap');}}),new Proxy([],{get(){throw new Error('trap');}}),{get market_coverage(){throw new Error('trap');}}]){
    const r=validateOwnerCoverage(hostile,context);
    assert.deepEqual(r,{ok:false,errors:[{code:'QR2_OWNER_COVERAGE_INVALID',path:'envelope'}]});
  }
  const throwing=structuredClone(result.owner);
  Object.defineProperty(throwing.market_coverage.entries[0].coverage,'state',{enumerable:true,configurable:true,get(){throw new Error('secret-detail');}});
  const r=validateOwnerCoverage(throwing,context);
  assert.equal(r.ok,false);assert.ok(!JSON.stringify(r).includes('secret-detail'));
  assert.equal(validateOwnerCoverage(result.owner,context).ok,true,'control: untouched envelope still valid');
  // Context problems still throw; they are caller input, not envelope content.
  invalid(()=>validateOwnerCoverage(result.owner,{accounts}));
  refused(()=>validateOwnerCoverage(result.owner,ctx(accounts,{...budgets,coverage_output_bytes:1})));
});

test('interval counts match registry window fields and charges.output_intervals',()=>{
  const accounts=[account('a',0,10*M),account('b',0,10*M),account('c',2*M,6*M),account('d',3*M,9*M)];
  const {registry,result}=project(accounts,()=>complete([M,4*M,5*M,9*M]));
  const entries=result.owner.market_coverage.entries;
  assert.equal(entries.reduce((n,e)=>n+e.coverage.interval_count,0),registry.charges.output_intervals);
  assert.equal(entries.reduce((n,e)=>n+e.coverage.intervals.length,0),registry.charges.output_intervals);
  assert.ok(registry.charges.output_intervals>0);
  entries.forEach((e,i)=>assert.equal(e.coverage.interval_count,registry.windows[i].interval_count));
});

test('output is deterministic across repeated runs and account order',()=>{
  const accounts=[account('b',M,4*M),unsupported('u'),account('a',0,2*M),account('c',null)],factOf=()=>complete([M,4*M]);
  const registry=registryOf(accounts,factOf),context=ctx(accounts);
  const first=projectPublicCoverage(registry,context),second=projectPublicCoverage(registry,context);
  assert.deepEqual(first,second);assert.equal(JSON.stringify(first),JSON.stringify(second));
  const reversed=[...accounts].reverse(),again=projectPublicCoverage(registryOf(reversed,factOf),ctx(reversed));
  assert.equal(JSON.stringify(again),JSON.stringify(first));
  assert.notEqual(first.owner,second.owner,'fresh objects each call');
});

test('deep-frozen inputs are read without mutation and without copying the union array',()=>{
  const accounts=[account('a',0,5*M),account('b',M,4*M)],timestamps=[M,3*M,4*M];
  const registry=registryOf(accounts,()=>complete(timestamps)),context=ctx(accounts);
  const savedRegistry=JSON.stringify(registry),savedContext=JSON.stringify(context);
  const expected=projectPublicCoverage(structuredClone(registry),structuredClone(context));
  deepFreeze(registry);deepFreeze(context);
  assert.ok(Object.isFrozen(registry.unions[0].fact.timestamps));
  const result=projectPublicCoverage(registry,context);
  assert.deepEqual(result,expected);
  assert.equal(JSON.stringify(registry),savedRegistry);assert.equal(JSON.stringify(context),savedContext);
  assert.equal(registry.unions[0].fact.timestamps,timestamps);
  assert.equal(validateCoverageSnapshot(registry,context).ok,true);
  assert.equal(validateOwnerCoverage(deepFreeze(structuredClone(result.owner)),context).ok,true);
});

test('seeded random registries match the Stage 1 oracle and the owner mapping',()=>{
  const rng=seed=>{let s=seed>>>0;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};};
  let intervals=0,states=new Set();
  for(let seed=1;seed<=60;seed++){
    const r=rng(seed*7919),count=1+Math.floor(r()*5),accounts=[];
    for(let i=0;i<count;i++){
      const kind=r(),from=Math.floor(r()*20*M)+(r()<0.5?Math.floor(r()*M):0),to=from+1+Math.floor(r()*30*M);
      accounts.push(kind<0.12?unsupported('bot'+i,from,to):kind<0.25?account('bot'+i,null):account('bot'+i,from,to));
    }
    const factOf=union=>{
      if(r()<0.15)return absent;
      const p=0.1+r()*0.85,timestamps=[];
      for(let t=union.window.from+M;t<=union.window.to;t+=M)if(r()<p)timestamps.push(t);
      return complete(timestamps);
    };
    const {registry,result}=project(accounts,factOf);
    intervals+=registry.charges.output_intervals;
    for(const e of result.owner.market_coverage.entries)states.add(e.coverage.state+'/'+e.coverage.reason);
  }
  assert.ok(intervals>0);
  for(const s of ['COMPLETE/null','UNAVAILABLE/MARKET_DATA_TABLE_ABSENT','UNAVAILABLE/UNSUPPORTED_MARKET','EMPTY/RANGE_UNRESOLVED'])assert.ok(states.has(s),s);
});

test('errors carry fixed codes only and no coverage, account or count data',()=>{
  const accounts=[account('secret-bot',0,5*M)],registry=registryOf(accounts,()=>complete([M]));
  const bad=structuredClone(registry);bad.windows[0].stored_minutes=4;
  for(const run of [()=>projectPublicCoverage(bad,ctx(accounts)),()=>projectPublicCoverage(registry,null),()=>projectPublicCoverage(registry,ctx(accounts),1),()=>projectPublicCoverage(registry,ctx(accounts),0)]){
    try{run();assert.fail('must throw');}catch(error){
      assert.match(error.code,/^QR2_/);assert.equal(error.message,error.code);
      assert.deepEqual(Object.keys(error),['code']);
      assert.ok(!/secret-bot|[0-9]{3}/.test(error.message+JSON.stringify(error)));
    }
  }
});

test('new module imports only the allowlist and avoids array copies',()=>{
  const source=readFileSync(new URL('../src/portfolio/qr2-coverage-public.js',import.meta.url),'utf8');
  const imports=[...source.matchAll(/^\s*import[^;]*?from\s+'([^']+)'/gm)].map(m=>m[1]).sort();
  assert.deepEqual(imports,['../market-gap-intervals.js','./qr2-coverage-limits.js','./qr2-coverage-snapshot.js','./qr2-coverage.js']);
  const allowed=new Set(['./qr2-coverage.js','./qr2-coverage-snapshot.js','./qr2-coverage-limits.js','../market-gap-intervals.js']);
  for(const spec of imports)assert.ok(allowed.has(spec),spec);
  assert.equal(source.match(/\bimport\b/g).length,imports.length+0,'no other import syntax');
  assert.ok(!/\bimport\s*\(|\brequire\s*\(|\bprocess\b|\bfs\b|child_process|worker_threads|\bfetch\b/.test(source));
  assert.ok(!/postgres|\bpg\b|db\.js|\bstore\b|\bserver\b|\broutes?\b|dispatcher/i.test(source.replace(/^.*Unwired.*$/gm,'')),'no persistence, server or routing reference');
  assert.ok(!/\.slice\(|\.sort\(|\.concat\(|\.splice\(|structuredClone|Array\.from|\[\.\.\./.test(source),'no array copy or reorder');
});

/* ------------------------------------------------------------------ O6 additive exports */

const sizeLimits={unique_windows:20,output_intervals:4096};
const shapeAccounts=()=>[account('a',0,3*M),account('b',0,5*M),unsupported('c',0,3*M)];
const shapeFacts=()=>complete([M,2*M,4*M,5*M]);
const envelopeOf=(accounts=shapeAccounts(),factOf=shapeFacts)=>projectPublicCoverage(registryOf(accounts,factOf),ctx(accounts)).owner.market_coverage;
const shapeOk=value=>validateOwnerCoverageShape(value);

test('validateOwnerCoverageShape accepts every Stage 3A projection without context',()=>{
  const scenarios=[
    [[unsupported('x')],()=>assert.fail('no union expected')],
    [[account('n',null)],()=>assert.fail('no union expected')],
    [shapeAccounts(),shapeFacts],
    [[account('a',0,3*M),account('b',0,3*M)],()=>complete([M,3*M])],
    [[account('a',0,3*M),account('b',0,5*M)],()=>absent],
    [[account('a',0,3*M),account('b',1,3*M-1),unsupported('c',0,3*M),account('d',null)],()=>complete([2*M])],
    [[],()=>assert.fail('no windows expected')]
  ];
  for(const [accounts,factOf] of scenarios){
    const envelope=envelopeOf(accounts,factOf),result=shapeOk(envelope);
    assert.deepEqual(result,{ok:true,errors:[]},JSON.stringify(accounts));
    assert.equal(validateOwnerCoverage({market_coverage:envelope},ctx(accounts)).ok,true);
  }
  assert.deepEqual(shapeOk({version:OWNER_COVERAGE_VERSION,entries:[],accounts:[]}),{ok:true,errors:[]});
  // A projection frozen by the Stage 3A lock passes, and so does an unfrozen deep clone.
  assert.equal(shapeOk(structuredClone(envelopeOf())).ok,true);
});

test('validateOwnerCoverageShape rejects each rule violation with a fixed code and path',()=>{
  const base=envelopeOf();
  assert.equal(base.entries.length,3);assert.equal(base.entries[0].coverage.market,null,'unsupported entry sorts first');
  assert.deepEqual(base.accounts.map(a=>a.coverage_ids[0]),['coverage:1','coverage:2','coverage:0']);
  const extra=(index,range)=>({id:'coverage:'+index,coverage:buildBarCoverage({resolved_range:range,market,fact:{state:'TABLE_ABSENT'}})});
  const accessor=(object,key,counter)=>Object.defineProperty(object,key,{get(){counter.hit=true;return object[key];},enumerable:true});
  const many=(n,make)=>Array.from({length:n},(_,i)=>make(i));
  const huge=buildBarCoverage({resolved_range:{from:0,to:8210*M},market,fact:complete(many(4100,k=>(2*k+2)*M))});
  assert.ok(huge.interval_count>4096);
  const mutations={
    version:e=>{e.version='qr2-owner-bar-coverage-v0';},
    top_extra_key:e=>{e.extra=1;},
    top_missing_key:e=>{delete e.accounts;},
    entry_extra_key:e=>{e.entries[0].extra=1;},
    entry_id:e=>{e.entries[1].id='coverage:5';},
    entry_id_gap:e=>{e.entries[0].id='coverage:1';e.entries[1].id='coverage:0';},
    coverage_invalid:e=>{e.entries[1].coverage.state='UNAVAILABLE';},
    coverage_extra_key:e=>{e.entries[1].coverage.extra=1;},
    entries_reversed:e=>{e.entries.reverse();e.entries.forEach((entry,i)=>{entry.id='coverage:'+i;});},
    duplicate_entry:e=>{e.entries.push({id:'coverage:3',coverage:structuredClone(e.entries[2].coverage)});},
    orphan_entry:e=>{e.entries.push(extra(3,{from:0,to:9*M}));},
    entry_range_order:e=>{e.entries.push(extra(3,{from:0,to:4*M}));e.accounts.push({bot_id:'d',broker:'binance-global',coverage_ids:['coverage:3']});},
    accounts_reversed:e=>{e.accounts.reverse();},
    duplicate_account:e=>{e.accounts.push(structuredClone(e.accounts[2]));},
    account_extra_key:e=>{e.accounts[0].extra=1;},
    account_not_string:e=>{e.accounts[0].bot_id=7;},
    ids_two:e=>{e.accounts[0].coverage_ids=['coverage:1','coverage:1'];},
    ids_none:e=>{e.accounts[0].coverage_ids=[];},
    id_unresolved:e=>{e.accounts[0].coverage_ids=['coverage:9'];},
    id_noncanonical:e=>{e.accounts[0].coverage_ids=['coverage:01'];},
    id_not_string:e=>{e.accounts[0].coverage_ids=[1];},
    market_mismatch_supported_broker_on_null_entry:e=>{e.accounts[2].broker='binance-global';},
    market_mismatch_other_broker_on_market_entry:e=>{e.accounts[0].broker='binance-th';},
    too_many_accounts:e=>{e.accounts=many(21,i=>({bot_id:'a'+String(i).padStart(2,'0'),broker:'binance-global',coverage_ids:['coverage:1']}));},
    too_many_entries:e=>{e.entries=many(21,i=>({id:'coverage:'+i,coverage:buildBarCoverage({resolved_range:{from:0,to:(i+1)*M},market,fact:{state:'TABLE_ABSENT'}})}));e.accounts=many(21,i=>({bot_id:'a'+String(i).padStart(2,'0'),broker:'binance-global',coverage_ids:['coverage:'+i]})).slice(0,20);},
    interval_sum:e=>{e.entries=[{id:'coverage:0',coverage:huge}];e.accounts=[{bot_id:'a',broker:'binance-global',coverage_ids:['coverage:0']}];},
    sparse_entries:e=>{delete e.entries[0];},
    entries_not_array:e=>{e.entries={length:0};},
    symbol_key:e=>{e[Symbol('x')]=1;},
    class_instance:e=>{e.entries[0]=Object.assign(new (class Entry{})(),e.entries[0]);},
    null_value:e=>{e.entries[0].coverage.market=undefined;},
    deep_nesting:e=>{let node=e.entries[0];for(let i=0;i<12;i++){node.x={};node=node.x;}}
  };
  for(const [name,mutate] of Object.entries(mutations)){
    const copy=structuredClone(base);mutate(copy);
    const result=shapeOk(copy);
    assert.equal(result.ok,false,name);
    assert.equal(result.errors.length,1,name);
    assert.equal(result.errors[0].code,'QR2_OWNER_COVERAGE_INVALID',name);
    assert.equal(typeof result.errors[0].path,'string',name);
    assert.equal(JSON.stringify(result).includes('binance'),false,name+': the verdict carries no value');
  }
  for(const bad of [null,undefined,[],'x',1,true,()=>1,new Map()])assert.equal(shapeOk(bad).ok,false,String(bad));
  assert.equal(shapeOk({market_coverage:base}).ok,false,'the wrapper object is not the envelope');
  // No accessor is invoked, and no getter can hide a value.
  const counter={hit:false},hostile=structuredClone(base);accessor(hostile.entries[0],'id',counter);
  assert.equal(shapeOk(hostile).ok,false);assert.equal(counter.hit,false);
  // The input is never mutated.
  const frozen=deepFreeze(structuredClone(base));
  assert.equal(shapeOk(frozen).ok,true);
});

test('validateOwnerCoverageShape orders entries by market key then range and accounts by code unit',()=>{
  const accounts=[account('Z'),account('a'),account('b',0,5*M),unsupported('m')];
  const envelope=envelopeOf(accounts,()=>complete([M,2*M,3*M,4*M,5*M]));
  assert.deepEqual(envelope.accounts.map(a=>a.bot_id),['Z','a','b','m'],'uppercase sorts before lowercase');
  assert.equal(shapeOk(envelope).ok,true);
  const swapped=structuredClone(envelope);[swapped.accounts[0],swapped.accounts[1]]=[swapped.accounts[1],swapped.accounts[0]];
  assert.equal(shapeOk(swapped).ok,false);
  // Strict order proves deduplication: two entries with the same market and range cannot both be present.
  const twin=structuredClone(envelope);twin.entries.push({id:'coverage:'+twin.entries.length,coverage:structuredClone(twin.entries.at(-1).coverage)});
  assert.equal(shapeOk(twin).ok,false);
});

test('projectPublicCoverageOutcome returns the same projection as projectPublicCoverage',()=>{
  for(const [accounts,factOf] of [[shapeAccounts(),shapeFacts],[[unsupported('x')],()=>assert.fail('no union')],[[],()=>assert.fail('no windows')],[[account('a',0,3*M)],()=>absent]]){
    const registry=registryOf(accounts,factOf),context=ctx(accounts);
    const outcome=projectPublicCoverageOutcome(registry,context),plain=projectPublicCoverage(registry,context);
    assert.deepEqual(Object.keys(outcome).sort(),['projection','refused']);
    assert.equal(outcome.refused,false);
    assert.deepEqual(outcome.projection,plain);
    assert.equal(JSON.stringify(outcome.projection),JSON.stringify(plain));
    assert.equal(Object.isFrozen(outcome.projection),true);
    assert.equal(projectPublicCoverageOutcome(registry,context,Number.MAX_SAFE_INTEGER).refused,false);
  }
});

test('projectPublicCoverageOutcome returns refused only for the post-build admission refusal and throws for everything else',()=>{
  const accounts=shapeAccounts(),registry=registryOf(accounts,shapeFacts),context=ctx(accounts);
  assert.deepEqual(projectPublicCoverageOutcome(registry,context,1),{refused:true},'a lowered limit below the actual size');
  refused(()=>projectPublicCoverage(registry,context,1));
  assert.deepEqual(projectPublicCoverageOutcome(registry,context,1),{refused:true});
  // A context-level overflow raised by planCoverage is a throw, not an outcome.
  const tiny=ctx(accounts,{...budgets,coverage_output_bytes:100});
  assert.throws(()=>projectPublicCoverageOutcome(registry,tiny),{code:'QR2_RANGE_ADMISSION_REFUSED'});
  const windows=ctx(accounts,{...budgets,unique_windows:1});
  assert.throws(()=>projectPublicCoverageOutcome(registry,windows),{code:'QR2_RANGE_ADMISSION_REFUSED'});
  // Corrupt registry, invalid context and invalid limits throw the same plain coverage errors.
  const corrupt=structuredClone(registry);corrupt.windows[0].stored_minutes+=1;
  failed(()=>projectPublicCoverageOutcome(corrupt,context));
  invalid(()=>projectPublicCoverageOutcome(registry,{accounts}));
  invalid(()=>projectPublicCoverageOutcome(registry,context,0));
  invalid(()=>projectPublicCoverageOutcome(registry,context,1.5));
  // An estimator defect (measured size above the registry bound) is a report failure, never a refusal outcome.
  const original=Buffer.byteLength;
  try{Buffer.byteLength=()=>2**40;failed(()=>projectPublicCoverageOutcome(registry,context));failed(()=>projectPublicCoverageOutcome(registry,context,1));}finally{Buffer.byteLength=original;}
  // Errors are plain Errors from coverageError, not Qr2Error.
  try{projectPublicCoverageOutcome(registry,tiny);assert.fail('expected a throw');}catch(error){assert.equal(error.name,'Error');assert.equal(error.message,'QR2_RANGE_ADMISSION_REFUSED');}
});

test('the existing Stage 3A projection keeps its exact behavior after the shared implementation',()=>{
  const accounts=shapeAccounts(),registry=registryOf(accounts,shapeFacts),context=ctx(accounts);
  const result=projectPublicCoverage(registry,context);
  assert.deepEqual(Object.keys(result),['owner','accounts']);
  refused(()=>projectPublicCoverage(registry,context,1));
  assert.deepEqual(projectPublicCoverage(registry,context,Number.MAX_SAFE_INTEGER),result);
});

test('validateOwnerCoverageShape fix-r1 M13: a duplicate entry that an account references is rejected by strict order, not by the orphan rule',()=>{
  const base=envelopeOf(),copy=structuredClone(base);
  copy.entries.push({id:'coverage:'+copy.entries.length,coverage:structuredClone(copy.entries.at(-1).coverage)});
  copy.accounts.push({bot_id:'d',broker:'binance-global',coverage_ids:['coverage:'+(copy.entries.length-1)]});
  const result=shapeOk(copy);
  assert.equal(result.ok,false);assert.equal(result.errors[0].path,'entries.'+(copy.entries.length-1)+'.order');
  const unique=structuredClone(base);
  assert.equal(shapeOk(unique).ok,true);
});

test('validateOwnerCoverageShape fix-r1 M15: the entry interval sum is accepted at exactly 4096 and rejected at 4097, single entry and across entries',()=>{
  const many=(n,make)=>Array.from({length:n},(_,i)=>make(i));
  // m even-minute rows and an end of 2m+2 give m+1 intervals (odd minutes missing, one trailing run).
  const entry=(index,m)=>({id:'coverage:'+index,coverage:buildBarCoverage({resolved_range:{from:0,to:(2*m+2+2*index)*M},market,fact:complete(many(m,k=>(2*k+2)*M))})});
  const envelope=counts=>({version:OWNER_COVERAGE_VERSION,entries:counts.map((n,i)=>entry(i,n-1)),accounts:counts.map((_,i)=>({bot_id:'a'+i,broker:'binance-global',coverage_ids:['coverage:'+i]}))});
  const sumOf=value=>value.entries.reduce((n,e)=>n+e.coverage.interval_count,0);
  for(const [counts,sum,ok] of [[[4096],4096,true],[[4097],4097,false],[[2048,2048],4096,true],[[2048,2049],4097,false]]){
    const value=envelope(counts);
    assert.equal(sumOf(value),sum);
    const result=shapeOk(value);
    assert.equal(result.ok,ok,JSON.stringify(counts));
    if(!ok)assert.deepEqual(result.errors,[{code:'QR2_OWNER_COVERAGE_INVALID',path:'entries.intervals'}]);
  }
});