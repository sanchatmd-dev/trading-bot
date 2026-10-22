import {buildBarCoverage} from './qr2-coverage.js';

export const COVERAGE_SNAPSHOT_VERSION='qr2-coverage-snapshot-v1';
export const COVERAGE_BUDGET_KEYS=Object.freeze(['union_minutes','timestamp_rows','unique_windows','derivation_visits','output_intervals','coverage_input_bytes','coverage_output_bytes']);
const MAX=Number.MAX_SAFE_INTEGER,M=60000;
const CHARGES=['union_minutes','timestamp_rows','unique_windows','derivation_visits','output_intervals','input_bytes_upper_bound','output_bytes_upper_bound'];
export function coverageError(code){const error=new Error(code);error.code=code;return error;}
const fail=code=>{throw coverageError(code);};
const input=condition=>{if(!condition)fail('QR2_INPUT_INVALID');};
const report=condition=>{if(!condition)fail('QR2_REPORT_FAILED');};
const safe=n=>Number.isSafeInteger(n)&&n>=0;
function add(a,b){const n=BigInt(a)+BigInt(b);if(n>BigInt(MAX))fail('QR2_RANGE_ADMISSION_REFUSED');return Number(n);}
function multiply(a,b){const n=BigInt(a)*BigInt(b);if(n>BigInt(MAX))fail('QR2_RANGE_ADMISSION_REFUSED');return Number(n);}
function cap(n,limit){if(n>limit)fail('QR2_RANGE_ADMISSION_REFUSED');return n;}
function shape(value,names,check=input){
  check(value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null));
  check(Reflect.ownKeys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)));
  for(const key of names)check(Object.getOwnPropertyDescriptor(value,key)?.get===undefined&&Object.getOwnPropertyDescriptor(value,key)?.set===undefined);
}
function array(value,limit,check=input){
  check(Array.isArray(value));if(check===report)check(value.length<=limit);else cap(value.length,limit);
  check(Reflect.ownKeys(value).length===value.length+1);
  for(let i=0;i<value.length;i++)check(Object.hasOwn(value,i));
}
export function validateCoverageBudgets(budgets){
  shape(budgets,COVERAGE_BUDGET_KEYS);
  for(const key of COVERAGE_BUDGET_KEYS)input(safe(budgets[key])&&budgets[key]>0);
  return budgets;
}
// A JSON string uses at most six bytes per UTF-16 code unit, plus quotes. Numeric slots use 16 bytes.
// This includes keys, escaped/non-ASCII identifiers, punctuation and all charge slots, without serialization.
function jsonBound(value){
  if(value===null)return 4;
  if(typeof value==='string')return add(2,multiply(6,value.length));
  if(typeof value==='number')return 16;
  if(typeof value==='boolean')return value?4:5;
  let total=2;
  if(Array.isArray(value)){for(let i=0;i<value.length;i++)total=add(total,add(i?1:0,jsonBound(value[i])));return total;}
  const entries=Object.entries(value);
  for(let i=0;i<entries.length;i++){const [key,item]=entries[i];total=add(total,add(i?1:0,add(jsonBound(key),add(1,jsonBound(item)))));}
  return total;
}
function text(value,budgets){input(typeof value==='string'&&value.length>0);cap(value.length,Math.floor(Math.min(budgets.coverage_input_bytes,budgets.coverage_output_bytes)/6));return value;}
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const rangeCompare=(a,b)=>a===null?(b===null?0:-1):b===null?1:a.from-b.from||a.to-b.to;
const marketKey=market=>market===null?'':market.broker+'\u0000'+market.symbol+'\u0000'+market.timeframe;
const sameRange=(a,b)=>a===null?b===null:b!==null&&a.from===b.from&&a.to===b.to;
function domain(resolved_range,market){
  try{
    // Stage 1 owns exact market/range validation and partial-edge derivation. No rows or intervals are allocated.
    const empty=resolved_range===null||market===null;
    if(empty)return buildBarCoverage({resolved_range,market,fact:{state:'NOT_NEEDED'}});
    const from=resolved_range?.from,to=resolved_range?.to;
    const hasWindow=safe(from)&&safe(to)&&Math.ceil(from/M)*M<Math.floor(to/M)*M;
    return buildBarCoverage({resolved_range,market,fact:{state:hasWindow?'TABLE_ABSENT':'NOT_NEEDED'}});
  }catch{fail('QR2_INPUT_INVALID');}
}
function makePlan(accounts,budgets){
  validateCoverageBudgets(budgets);array(accounts,20);
  const normalized=[];
  for(const account of accounts){
    shape(account,['bot_id','broker','market','resolved_range']);
    const bot_id=text(account.bot_id,budgets),broker=text(account.broker,budgets);
    const d=domain(account.resolved_range,account.market);
    input(['binance-global','binance-th','innovestx','settrade'].includes(broker));
    input((broker==='binance-global')===(d.market!==null));
    input(!normalized.some(a=>a.bot_id===bot_id&&a.broker===broker));
    normalized.push({bot_id,broker,market:d.market,resolved_range:d.resolved_range});
  }
  const distinct=[];
  for(const account of normalized)if(!distinct.some(w=>marketKey(w.market)===marketKey(account.market)&&sameRange(w.resolved_range,account.resolved_range)))distinct.push({market:account.market,resolved_range:account.resolved_range});
  cap(distinct.length,budgets.unique_windows);
  distinct.sort((a,b)=>cmp(marketKey(a.market),marketKey(b.market))||rangeCompare(a.resolved_range,b.resolved_range));
  const windows=distinct.map((w,id)=>({id,...w,union_id:null}));
  const candidates=windows.map(w=>({id:w.id,market:w.market,window:domain(w.resolved_range,w.market).inspected_window})).filter(w=>w.market!==null&&w.window!==null);
  candidates.sort((a,b)=>cmp(marketKey(a.market),marketKey(b.market))||rangeCompare(a.window,b.window));
  const unions=[];
  for(const item of candidates){
    let union=unions.at(-1);
    if(!union||marketKey(union.market)!==marketKey(item.market)||union.window.to<item.window.from){union={id:unions.length,market:{...item.market},window:{...item.window}};unions.push(union);}
    else union.window.to=Math.max(union.window.to,item.window.to);
    windows[item.id].union_id=union.id;
  }
  const bindings=normalized.map(a=>({bot_id:a.bot_id,broker:a.broker,window_id:windows.find(w=>marketKey(w.market)===marketKey(a.market)&&sameRange(w.resolved_range,a.resolved_range)).id})).sort((a,b)=>cmp(a.bot_id,b.bot_id)||cmp(a.broker,b.broker));
  let minutes=0;for(const union of unions)minutes=add(minutes,(union.window.to-union.window.from)/M);cap(minutes,budgets.union_minutes);
  return {unions,windows,bindings};
}
const fields=(w,counts)=>({...w,start_index:null,end_index:null,expected_minutes:null,stored_minutes:null,missing_minutes:null,interval_count:null,...counts});
function estimates(plan,windows,rows,intervals){
  // Reserve COMPLETE fact wrappers even for absent unions; every numeric slot reserves MAX width.
  const skeleton={version:COVERAGE_SNAPSHOT_VERSION,unions:plan.unions.map(u=>({...u,fact:{state:'COMPLETE',timestamps:[]}})),windows:windows.map(w=>({...w,start_index:MAX,end_index:MAX,expected_minutes:MAX,stored_minutes:MAX,missing_minutes:MAX,interval_count:MAX})),bindings:plan.bindings,charges:Object.fromEntries(CHARGES.map(k=>[k,MAX]))};
  const inputBytes=add(jsonBound(skeleton),multiply(rows,17)); // up to sixteen digits and one comma per timestamp
  const coverageBytes=windows.map((w,index)=>{
    const c=domain(w.resolved_range,w.market);
    // Largest legal scalar variants, including full COMPLETE counts and reason strings from unavailable states.
    const fixed={...c,state:'UNAVAILABLE',reason:'MARKET_DATA_TABLE_ABSENT',complete:false,expected_minutes:MAX,stored_minutes:MAX,missing_minutes:MAX,interval_count:MAX,intervals:[]};
    const scalar=Math.max(jsonBound(fixed),jsonBound(c));
    return add(scalar,multiply(intervals[index],add(1,jsonBound({from:MAX,to:MAX,missing_minutes:MAX}))));
  });
  const owner={market_coverage:{version:'qr2-owner-bar-coverage-v1',entries:windows.map(w=>({id:'coverage:'+w.id,coverage:null})),accounts:plan.bindings.map(b=>({bot_id:b.bot_id,broker:b.broker,coverage_ids:['coverage:'+b.window_id]}))}};
  let ownerBytes=jsonBound(owner);for(const bytes of coverageBytes)ownerBytes=add(ownerBytes,bytes-4);
  let outputBytes=ownerBytes;
  for(const bytes of coverageBytes)outputBytes=Math.max(outputBytes,add(jsonBound({market_data:{coverage:null}}),bytes-4));
  return {input_bytes_upper_bound:inputBytes,output_bytes_upper_bound:outputBytes};
}
function checkBytes(bytes,budgets){cap(bytes.input_bytes_upper_bound,budgets.coverage_input_bytes);cap(bytes.output_bytes_upper_bound,budgets.coverage_output_bytes);}
export function planCoverage({accounts,budgets}){
  const plan=makePlan(accounts,budgets);
  // Minimum safe envelope before any source read, including nonzero empty-registry overhead.
  checkBytes(estimates(plan,plan.windows.map(w=>fields(w,{})),0,plan.windows.map(()=>0)),budgets);
  return plan;
}
function upperBound(values,target){let lo=0,hi=values.length;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(values[mid]<=target)lo=mid+1;else hi=mid;}return lo;}
function unionFacts(plan,facts,budgets,check){
  array(facts,plan.unions.length,check);check(facts.length===plan.unions.length);
  let total=0;
  for(let i=0;i<facts.length;i++){
    const fact=facts[i];check(fact!==null&&typeof fact==='object');
    check(fact.state==='COMPLETE'||fact.state==='TABLE_ABSENT');shape(fact,fact.state==='COMPLETE'?['state','timestamps']:['state'],check);
    if(fact.state==='TABLE_ABSENT')continue;
    check(Array.isArray(fact.timestamps));total=add(total,fact.timestamps.length);cap(total,budgets.timestamp_rows);
    checkBytes(estimates(plan,plan.windows.map(w=>fields(w,{})),total,plan.windows.map(()=>0)),budgets);
    array(fact.timestamps,fact.timestamps.length,check);
    let previous=plan.unions[i].window.from;
    for(const time of fact.timestamps){check(safe(time)&&time%M===0&&time>previous&&time<=plan.unions[i].window.to);previous=time;}
  }
  return total;
}
function derive(plan,facts,budgets,check=report){
  const rows=unionFacts(plan,facts,budgets,check),windows=[];
  let visits=0,outputIntervals=0,unionMinutes=0;
  for(const union of plan.unions)unionMinutes=add(unionMinutes,(union.window.to-union.window.from)/M);
  for(const w of plan.windows){
    const d=domain(w.resolved_range,w.market);
    if(w.union_id===null){windows.push(fields(w,w.market===null?{}:{expected_minutes:0,stored_minutes:0,missing_minutes:0,interval_count:0}));continue;}
    const fact=facts[w.union_id];
    if(fact.state==='TABLE_ABSENT'){windows.push(fields(w,{}));continue;}
    const values=fact.timestamps,{from,to}=d.inspected_window;
    const start=upperBound(values,from),end=upperBound(values,to),n=end-start;
    visits=add(visits,n);cap(visits,budgets.derivation_visits);
    let count=0,previous=from;
    for(let i=start;i<end;i++){if(values[i]-previous>M)count++;previous=values[i];}
    if(previous<to)count++;
    outputIntervals=add(outputIntervals,count);cap(outputIntervals,budgets.output_intervals);
    const expected=(to-from)/M;
    windows.push(fields(w,{start_index:start,end_index:end,expected_minutes:expected,stored_minutes:n,missing_minutes:expected-n,interval_count:count}));
  }
  const bytes=estimates(plan,windows,rows,windows.map(w=>w.interval_count??0));checkBytes(bytes,budgets);
  return {windows,charges:{union_minutes:unionMinutes,timestamp_rows:rows,unique_windows:windows.length,derivation_visits:visits,output_intervals:outputIntervals,...bytes}};
}
/** No final recursive build/validate: construction performs one union pass and one per-window slice pass. */
export function buildCoverageSnapshot({accounts,budgets,facts}){
  const plan=planCoverage({accounts,budgets}),derived=derive(plan,facts,budgets);
  // Arrays are retained once by union; windows contain only indexes. Caller transfers ownership of facts.
  return {version:COVERAGE_SNAPSHOT_VERSION,unions:plan.unions.map((u,i)=>({...u,fact:facts[i]})),windows:derived.windows,bindings:plan.bindings,charges:derived.charges};
}
function same(value,expected){
  if(expected===null||typeof expected!=='object'){report(value===expected);return;}
  if(Array.isArray(expected)){array(value,expected.length,report);report(value.length===expected.length);for(let i=0;i<expected.length;i++)same(value[i],expected[i]);return;}
  shape(value,Object.keys(expected),report);for(const key of Object.keys(expected))same(value[key],expected[key]);
}
/** Independent recomputation: one union validation and one per-window derivation, no timestamp copy. */
export function validateCoverageSnapshot(registry,{accounts,budgets}){
  const plan=planCoverage({accounts,budgets});
  try{
  shape(registry,['version','unions','windows','bindings','charges'],report);report(registry.version===COVERAGE_SNAPSHOT_VERSION);
  array(registry.unions,plan.unions.length,report);report(registry.unions.length===plan.unions.length);
  array(registry.windows,plan.windows.length,report);array(registry.bindings,20,report);
  const facts=[];
  for(let i=0;i<plan.unions.length;i++){
    const union=registry.unions[i];shape(union,['id','market','window','fact'],report);
    same(union.id,plan.unions[i].id);same(union.market,plan.unions[i].market);same(union.window,plan.unions[i].window);facts.push(union.fact);
  }
  const expected=derive(plan,facts,budgets);same(registry.windows,expected.windows);same(registry.bindings,plan.bindings);same(registry.charges,expected.charges);
  return {ok:true};
  }catch(error){
    // Independent metadata and budgets were qualified above. Any registry exceeding this
    // context is corrupt for validation, without traversing it to infer intent.
    if(error?.code==='QR2_RANGE_ADMISSION_REFUSED')fail('QR2_REPORT_FAILED');
    throw error;
  }
}
/** Pre-decode envelope check for bounded driver results; no timestamp traversal or allocation. */
export function admitCoverageRows({accounts,budgets,rowCount}){
  const plan=planCoverage({accounts,budgets});input(safe(rowCount));cap(rowCount,budgets.timestamp_rows);
  checkBytes(estimates(plan,plan.windows.map(w=>fields(w,{})),rowCount,plan.windows.map(()=>0)),budgets);
}

/** Retained numeric rows admitted before issuing SQL. The extra sentinel row is temporary, not retained.
 * JSON bytes are not a driver-object or heap bound; those remain a later measurement responsibility.
 */
export function coverageRowCapacity({accounts,budgets}){
  const plan=planCoverage({accounts,budgets});
  const fixed=estimates(plan,plan.windows.map(w=>fields(w,{})),0,plan.windows.map(()=>0)).input_bytes_upper_bound;
  return Math.min(budgets.timestamp_rows,Math.floor((budgets.coverage_input_bytes-fixed)/17));
}
