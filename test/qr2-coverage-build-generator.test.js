import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import * as live from '../src/portfolio/qr2-coverage-snapshot.js';
import * as old from './helpers/qr2-coverage-snapshot-oracle-95e6cec.js';
import {readCoverageSnapshot,readCoverageSnapshotWithChunkRows,COVERAGE_SQL} from '../src/postgres/qr2-coverage-reader.js';
import * as oracleReader from './helpers/qr2-coverage-reader-oracle-95e6cec.js';
import {QR2_COVERAGE_LIMITS} from '../src/portfolio/qr2-coverage-limits.js';
import {projectPublicCoverage} from '../src/portfolio/qr2-coverage-public.js';
import {QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
import {Qr2Error} from '../src/portfolio/qr2-constants.js';
import {PostgresDatabase} from '../src/postgres/db.js';

// QR-2 product change (b), slice b-1b: the coverage build as ONE shared generator. The synchronous drain (every builder caller and the worker validator) and the
// cooperative drain (the coverage reader only) must give byte-identical registries and identical refusals, and both must equal the frozen 95e6cec snapshot module
// (test/helpers/qr2-coverage-snapshot-oracle-95e6cec.js, a pure copy; it holds no tests) and, end to end, the frozen 95e6cec reader.
// A refusal is compared by name, code, detail, message. The generator yields only at the start of a work unit, so a cap that follows its computation is checked
// before the next yield; the cap-position tests below count the yields before each refusal against that model.
const M=60000;
const SLICE=live.COVERAGE_SLICE_UNITS;
const sha=text=>createHash('sha256').update(text).digest('hex');
const account=(id,from,to)=>({bot_id:id,broker:'binance-global',market,resolved_range:{from,to}});
const budgetsOf=over=>({...QR2_COVERAGE_LIMITS,...over});
const dense=(first,count,step=1)=>Array.from({length:count},(_,i)=>(first+i*step)*M);
const failure=error=>({ok:false,name:error?.name,code:error?.code,detail:error?.detail===undefined?undefined:JSON.stringify(error.detail),message:error?.message});
const runSync=fn=>{try{return {ok:true,text:JSON.stringify(fn())};}catch(error){return failure(error);}};
const runAsync=async fn=>{try{return {ok:true,text:JSON.stringify(await fn())};}catch(error){return failure(error);}};
const yieldsFor=units=>units>0?Math.floor((units-1)/SLICE):0;

/** The same build through the frozen module, the synchronous drain and the cooperative drain; all three must agree. Returns the frozen outcome. */
async function triple(args){
  const frozen=runSync(()=>old.buildCoverageSnapshot(args));
  assert.deepEqual(runSync(()=>live.buildCoverageSnapshot(args)),frozen,'synchronous drain');
  assert.deepEqual(await runAsync(()=>live.buildCoverageSnapshotCooperative(args)),frozen,'cooperative drain');
  return frozen;
}
/** Steps the shared generator by hand: the number of yields before it returns or throws, and what it did. */
function trace(args){
  const steps=live.buildCoverageSnapshotSteps(args);let yields=0;
  try{for(;;){const step=steps.next();if(step.done)return {yields,ok:true,value:step.value};yields++;}}
  catch(error){return {yields,ok:false,error};}
}
const refused=(result,code,limit)=>{
  assert.equal(result.ok,false);assert.equal(result.error.code,code);
  if(limit!==undefined)assert.equal(result.error.detail?.limit,limit);
};

function prng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}

test('frozen snapshot oracle is the 95e6cec module: only its first import line differs, proved by hashes of the original blob',()=>{
  const text=fs.readFileSync(new URL('./helpers/qr2-coverage-snapshot-oracle-95e6cec.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const lines=text.split('\n');
  assert.equal(lines[0],"import {buildBarCoverage,QR2_COVERAGE_BUDGET_REASON} from '../../src/portfolio/qr2-coverage.js';");
  const original=["import {buildBarCoverage,QR2_COVERAGE_BUDGET_REASON} from './qr2-coverage.js';",...lines.slice(1)].join('\n');
  assert.equal(sha(original),'e49771d9806ee6100c7dc6ed1dcae8c0d38bb5b91033cdda572eab3516c54af4','sha256 of git blob 95e6cec:src/portfolio/qr2-coverage-snapshot.js');
  const buffer=Buffer.from(original,'utf8');
  assert.equal(createHash('sha1').update('blob '+buffer.length+'\0').update(buffer).digest('hex'),'eb72b3ead76495c71552f0144684d6a6dec4e828','git blob id at 95e6cec');
});

// ---------------------------------------------------------------------------------------------------------------- source shape
const sourceOf=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8').replaceAll('\r\n','\n');
const LIVE=sourceOf('../src/portfolio/qr2-coverage-snapshot.js'),FROZEN=sourceOf('./helpers/qr2-coverage-snapshot-oracle-95e6cec.js');
/** One top-level declaration (function or const arrow), from its first line to the line that closes its braces. */
function declaration(source,name){
  const lines=source.split('\n');
  const start=lines.findIndex(line=>new RegExp('^(export )?(async )?(function\\*? ?'+name+'\\(|const '+name+'=)').test(line));
  assert.ok(start>=0,'declaration '+name);
  let depth=0,end=start;
  for(let i=start;i<lines.length;i++){
    for(const ch of lines[i]){if(ch==='{')depth++;else if(ch==='}')depth--;}
    end=i;if(depth===0&&/[;}]\s*$/.test(lines[i]))break;
  }
  return lines.slice(start,end+1).join('\n');
}
const squash=text=>text.replace(/\s+/g,'');
const METER=squash('if(meter.units===COVERAGE_SLICE_UNITS){meter.units=0;yield;}meter.units++;');

test('source: every unchanged function is textually the 95e6cec function; the three changed ones differ only by the counter statements, the generator syntax and the drain',()=>{
  for(const name of ['fail','input','report','safe','add','multiply','cap','shape','array','validateCoverageBudgets','jsonBound','text','cmp','rangeCompare','marketKey','sameRange','domain','makePlan','fields','estimates','checkBytes','zeroEnvelope','planCoverage','planCoverageUncapped','assertUnionMinutes','assertZeroEnvelope','rowCapacity','claimPossible','upperBound','buildDegradedCoverageSnapshot','same','validateCoverageSnapshot','admitCoverageRows','coverageRowCapacity','coverageError'])
    assert.equal(declaration(LIVE,name),declaration(FROZEN,name),name);
  // unionFactsSteps -> unionFacts
  let union=squash(declaration(LIVE,'unionFactsSteps'));
  assert.equal(union.split(METER).length,2,'one counter statement in the union check loop');
  union=union.replace(METER,'').replace('function*unionFactsSteps(plan,facts,budgets,check,meter)','functionunionFacts(plan,facts,budgets,check)');
  assert.equal(union,squash(declaration(FROZEN,'unionFacts')));
  // deriveSteps -> derive: two counter statements (window loop, gap loop)
  let derive=squash(declaration(LIVE,'deriveSteps'));
  assert.equal(derive.split(METER).length,3,'one counter statement in the window loop and one in the gap loop');
  derive=derive.replaceAll(METER,'').replace('function*deriveSteps(plan,facts,budgets,check=report,meter={units:0})','functionderive(plan,facts,budgets,check=report)').replace('yield*unionFactsSteps(plan,facts,budgets,check,meter)','unionFacts(plan,facts,budgets,check)');
  assert.equal(derive,squash(declaration(FROZEN,'derive')));
  // buildCoverageSnapshotSteps -> buildCoverageSnapshot
  const build=squash(declaration(LIVE,'buildCoverageSnapshotSteps')).replace('exportfunction*buildCoverageSnapshotSteps','exportfunctionbuildCoverageSnapshot').replace('yield*deriveSteps(plan,facts,budgets)','derive(plan,facts,budgets)');
  assert.equal(build,squash(declaration(FROZEN,'buildCoverageSnapshot')));
  // derive is the synchronous drain of deriveSteps.
  assert.equal(squash(declaration(LIVE,'derive')),squash('const derive=(plan,facts,budgets,check)=>drain(deriveSteps(plan,facts,budgets,check));'));
});

test('source: exactly three yield statements, each the counter statement at the start of a work unit; the residual hasOwn block is named; only the reader uses the cooperative drain',()=>{
  const code=LIVE.replace(/\/\*[\s\S]*?\*\//g,'').split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
  assert.equal(code.match(/\byield\b/g).length,3+code.match(/yield\*/g).length,'three plain yields besides the delegations');
  assert.equal(squash(code).split(METER).length,4,'each plain yield is the counter statement');
  assert.equal(code.match(/yield\*/g).length,2);
  assert.match(LIVE,/Residual block, not sliced[^]*hasOwn loop/);
  assert.equal(live.COVERAGE_SLICE_UNITS,8192);
  assert.equal(Object.hasOwn(QR2_COVERAGE_LIMITS,'COVERAGE_SLICE_UNITS'),false,'not a budget key');
  const repo=fileURLToPath(new URL('..',import.meta.url)),users=[];
  const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(m?js|cjs|ts)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('buildCoverageSnapshotCooperative'))users.push(path.relative(repo,full).split(path.sep).join('/'));}};
  for(const top of ['src','scripts'])if(fs.existsSync(path.join(repo,top)))walk(path.join(repo,top));
  assert.deepEqual(users.sort(),['src/portfolio/qr2-coverage-snapshot.js','src/postgres/qr2-coverage-reader.js']);
  const reader=sourceOf('../src/postgres/qr2-coverage-reader.js');
  assert.equal(reader.match(/buildCoverageSnapshotCooperative\(/g).length,1,'one call');
  assert.match(reader,/return await buildCoverageSnapshotCooperative\(\{accounts,budgets,facts\}\);/,'awaited inside the try block');
  assert.equal(reader.match(/\bbuildCoverageSnapshot\(/g).length,2,'the empty and TABLE_ABSENT results stay synchronous');
});

// ---------------------------------------------------------------------------------------------------------------- generator equality (build level)
function randomCase(random){
  const accounts=[],count=1+Math.floor(random()*4);
  for(let i=0;i<count;i++){
    const base=random()<0.55?0:Math.floor(random()*3)*400,edge=random()<0.3;
    const from=(base+Math.floor(random()*30))*M+(edge?Math.floor(random()*M):0);
    const to=from+(3+Math.floor(random()*300))*M+(edge?Math.floor(random()*M):0);
    accounts.push(account('bot'+i,from,to));
  }
  return accounts;
}
function randomFacts(random,plan){
  const facts=[];
  const limits=['union_minutes','timestamp_rows','derivation_visits','output_intervals','coverage_output_bytes'],all=random()<0.07,limit=limits[Math.floor(random()*limits.length)];
  for(const union of plan.unions){
    const roll=random();
    if(all||roll>0.93){facts.push({state:'BUDGET_EXCEEDED',limit:random()<0.1?limits[Math.floor(random()*limits.length)]:limit});continue;}
    if(roll>0.84){facts.push({state:'TABLE_ABSENT'});continue;}
    const density=[1,0.7,0.3,0.05][Math.floor(random()*4)],timestamps=[];
    for(let t=union.window.from+M;t<=union.window.to;t+=M)if(random()<density)timestamps.push(t);
    if(timestamps.length>2&&random()<0.05){
      const at=1+Math.floor(random()*(timestamps.length-1)),kind=Math.floor(random()*4);
      if(kind===0)timestamps[at]+=1;else if(kind===1)timestamps[at]=timestamps[at-1];else if(kind===2)timestamps.push(union.window.to+M);else{const t=timestamps[at];timestamps[at]=timestamps[at-1];timestamps[at-1]=t;}
    }
    facts.push({state:'COMPLETE',timestamps});
  }
  return facts;
}
const BUDGET_OF_CHARGE={union_minutes:'union_minutes',timestamp_rows:'timestamp_rows',unique_windows:'unique_windows',derivation_visits:'derivation_visits',output_intervals:'output_intervals',input_bytes_upper_bound:'coverage_input_bytes',output_bytes_upper_bound:'coverage_output_bytes'};
/** Budgets at the edge of the charges of a first successful build: charge - 1, charge, charge + 1 for one or two keys. */
function edgeBudgets(random,charges,base){
  const budgets={...base},keys=Object.keys(BUDGET_OF_CHARGE),picks=random()<0.3?2:1;
  for(let i=0;i<picks;i++){const key=keys[Math.floor(random()*keys.length)],value=charges[key]+Math.floor(random()*3)-1;if(value>=1)budgets[BUDGET_OF_CHARGE[key]]=value;}
  return budgets;
}

test('generator equality, seeded matrix: frozen module, synchronous drain and cooperative drain give the same registry bytes or the same refusal for 1500 cases; the validator agrees on registries and tampered registries',async t=>{
  const random=prng(0xB1B),seen={ok:0};
  const tamper=(registry,random)=>{
    const copy=JSON.parse(JSON.stringify(registry)),kind=Math.floor(random()*9);
    const fact=copy.unions.find(u=>u.fact.state==='COMPLETE'&&u.fact.timestamps.length>2);
    if(kind===0)copy.charges.derivation_visits+=1;
    else if(kind===1&&copy.windows.length)copy.windows[0].interval_count=(copy.windows[0].interval_count??0)+1;
    else if(kind===2&&fact)fact.fact.timestamps[1]+=1;
    else if(kind===3&&fact)fact.fact.timestamps.splice(1,1);
    else if(kind===4&&fact)fact.fact.timestamps[1]=fact.fact.timestamps[0];
    else if(kind===5)copy.bindings.reverse();
    else if(kind===6)copy.version='x';
    else if(kind===7)copy.extra=1;
    else copy.charges.timestamp_rows+=1;
    return copy;
  };
  for(let n=0;n<1500;n++){
    const accounts=randomCase(random);
    let plan;try{plan=old.planCoverage({accounts,budgets:budgetsOf({})});}catch{continue;}
    const facts=randomFacts(random,plan);
    let budgets=budgetsOf({});
    const first=runSync(()=>old.buildCoverageSnapshot({accounts,budgets,facts}));
    if(first.ok&&random()<0.75)budgets=edgeBudgets(random,JSON.parse(first.text).charges,budgets);
    else if(random()<0.2)budgets=budgetsOf({[['derivation_visits','output_intervals','timestamp_rows'][Math.floor(random()*3)]]:1+Math.floor(random()*4)});
    const args={accounts,budgets,facts};
    const result=await triple(args);
    const key=result.ok?'ok':result.code+':'+(result.detail?JSON.parse(result.detail).limit:'-');
    seen[key]=(seen[key]??0)+1;
    // The worker validator: the live module and the frozen module on the same registry, and on a tampered copy of it.
    if(result.ok){
      const registry=JSON.parse(result.text);
      assert.deepEqual(runSync(()=>live.validateCoverageSnapshot(registry,{accounts,budgets})),runSync(()=>old.validateCoverageSnapshot(registry,{accounts,budgets})));
      const bad=tamper(registry,random);
      assert.deepEqual(runSync(()=>live.validateCoverageSnapshot(bad,{accounts,budgets})),runSync(()=>old.validateCoverageSnapshot(bad,{accounts,budgets})),'tampered kind');
    }
    // The degraded builder runs through the same shared derive.
    for(const limit of ['union_minutes','derivation_visits'])
      assert.deepEqual(runSync(()=>live.buildDegradedCoverageSnapshot({accounts,budgets,limit})),runSync(()=>old.buildDegradedCoverageSnapshot({accounts,budgets,limit})));
  }
  t.diagnostic(JSON.stringify(seen));
  for(const key of ['ok','QR2_REPORT_FAILED:-','QR2_RANGE_ADMISSION_REFUSED:timestamp_rows','QR2_RANGE_ADMISSION_REFUSED:derivation_visits','QR2_RANGE_ADMISSION_REFUSED:output_intervals','QR2_RANGE_ADMISSION_REFUSED:coverage_output_bytes','QR2_RANGE_ADMISSION_REFUSED:coverage_input_bytes'])
    assert.ok(seen[key]>=8,'outcome class '+key+' is exercised: '+JSON.stringify(seen));
});

function largeCase(shape,count){
  if(shape==='dense')return {accounts:[account('a',0,(count+2)*M)],times:dense(1,count)};
  if(shape==='gappy'){const times=[];for(let m=1;times.length<count;m++)if(m%7!==0)times.push(m*M);return {accounts:[account('a',0,(times.at(-1)/M+2)*M)],times};}
  const end=count+2,mid=Math.floor(count/3);
  return {accounts:[account('a',0,Math.floor(count/2+5)*M),account('b',mid*M,end*M),account('c',5*M,(end-7)*M)],times:dense(1,count)};
}
test('generator equality across slice boundaries: 8191..21600 timestamps, three shapes, budgets at the edge of every data-time cap (the cap fires deep inside a sliced loop)',async()=>{
  let refusals=0,oks=0;
  for(const count of [8191,8192,8193,16384,16385,21600])for(const shape of ['dense','gappy','windows']){
    const {accounts,times}=largeCase(shape,count);
    const facts=[{state:'COMPLETE',timestamps:times}];
    const base=budgetsOf({});
    const full=await triple({accounts,budgets:base,facts});
    assert.equal(full.ok,true,shape+count);oks++;
    const charges=JSON.parse(full.text).charges;
    for(const [key,charge] of [['derivation_visits',charges.derivation_visits],['output_intervals',charges.output_intervals],['coverage_output_bytes',charges.output_bytes_upper_bound],['timestamp_rows',charges.timestamp_rows]])for(const delta of [-1,0]){
      if(charge+delta<1)continue;
      const result=await triple({accounts,budgets:{...base,[key]:charge+delta},facts});
      if(result.ok)oks++;else{refusals++;assert.equal(result.code,'QR2_RANGE_ADMISSION_REFUSED');assert.equal(JSON.parse(result.detail).limit,key);}
    }
    // The worker validator accepts the registry built by the cooperative drain and equals the frozen validator on a tampered copy.
    const registry=JSON.parse(full.text);
    assert.deepEqual(live.validateCoverageSnapshot(registry,{accounts,budgets:base}),{ok:true});
    registry.unions[0].fact.timestamps[5]+=1;
    assert.deepEqual(runSync(()=>live.validateCoverageSnapshot(registry,{accounts,budgets:base})),runSync(()=>old.validateCoverageSnapshot(registry,{accounts,budgets:base})));
  }
  assert.ok(refusals>=36&&oks>=18,refusals+'/'+oks);
});

// ---------------------------------------------------------------------------------------------------------------- cap positions
/** One union per size, windows disjoint, one bot each; every union is COMPLETE with its timestamps on consecutive minutes. */
function unions(sizes){
  const accounts=[],facts=[];let base=0;
  sizes.forEach((n,i)=>{accounts.push(account('bot'+i,base*M,(base+n+1)*M));facts.push({state:'COMPLETE',timestamps:Array.from({length:n},(_,k)=>(base+1+k)*M)});base+=n+10;});
  return {accounts,facts};
}
/** One union of T timestamps two minutes apart (one interval each); an optional TABLE_ABSENT union before it adds one window unit. Units at the end: 2T+1 (+1). */
function sparse(T,withAbsent){
  const base=withAbsent?10:0,accounts=[account('main',base*M,(base+2*T+1)*M)],facts=[{state:'COMPLETE',timestamps:Array.from({length:T},(_,k)=>(base+2*(k+1))*M)}];
  if(withAbsent){accounts.unshift(account('absent',0,5*M));facts.unshift({state:'TABLE_ABSENT'});}
  return {accounts,facts};
}
async function sameBothWays(args,expected){
  const frozen=runSync(()=>old.buildCoverageSnapshot(args));
  assert.equal(frozen.ok,false);assert.equal(frozen.code,expected.code);if(expected.limit)assert.equal(JSON.parse(frozen.detail).limit,expected.limit);
  assert.deepEqual(runSync(()=>live.buildCoverageSnapshot(args)),frozen);
  assert.deepEqual(await runAsync(()=>live.buildCoverageSnapshotCooperative(args)),frozen);
}

test('cap position: timestamp_rows and coverage_input_bytes (union loop) refuse before the first unit of the next union, with no yield between the computation and the cap',async()=>{
  // The cap is computed when union 1 starts; the units before it are the n0 timestamps of union 0. A yield falls at the start of unit 8193 and never after unit 8192.
  for(const n0 of [8191,8192,8193]){
    const {accounts,facts}=unions([n0,5]);
    const rows=budgetsOf({timestamp_rows:n0+4});
    const rowResult=trace({accounts,budgets:rows,facts});
    refused(rowResult,'QR2_RANGE_ADMISSION_REFUSED','timestamp_rows');
    assert.deepEqual(rowResult.error.detail,{limit:'timestamp_rows',value:n0+5,max:n0+4});
    assert.equal(rowResult.yields,yieldsFor(n0),'timestamp_rows after '+n0+' units');
    await sameBothWays({accounts,facts,budgets:rows},{code:'QR2_RANGE_ADMISSION_REFUSED',limit:'timestamp_rows'});
    // Smallest input-byte budget that admits n0 + 4 rows: the 5 rows of union 1 refuse at the byte check, after the row cap passed.
    let low=1,high=QR2_COVERAGE_LIMITS.coverage_input_bytes;
    const admits=bytes=>{try{live.admitCoverageRows({accounts,budgets:budgetsOf({coverage_input_bytes:bytes}),rowCount:n0+4});return true;}catch{return false;}};
    while(low<high){const mid=Math.floor((low+high)/2);if(admits(mid))high=mid;else low=mid+1;}
    const bytes=budgetsOf({coverage_input_bytes:low});
    const byteResult=trace({accounts,budgets:bytes,facts});
    refused(byteResult,'QR2_RANGE_ADMISSION_REFUSED','coverage_input_bytes');
    assert.equal(byteResult.yields,yieldsFor(n0),'coverage_input_bytes after '+n0+' units');
    await sameBothWays({accounts,facts,budgets:bytes},{code:'QR2_RANGE_ADMISSION_REFUSED',limit:'coverage_input_bytes'});
  }
});

test('cap position: derivation_visits refuses at the window top, before its gap loop, after exactly the units counted so far',async()=>{
  // One union of T minutes, two windows (n_a = T-k, n_b = T values). Units at the cap: T (check loop) + 1 + n_a (window A) + 1 (window B top) = 2T+2-k.
  const T=4096;
  for(const k of [3,2,1]){
    const accounts=[account('a',0,(T-k)*M),account('b',0,T*M)],facts=[{state:'COMPLETE',timestamps:dense(1,T)}];
    const budgets=budgetsOf({derivation_visits:(T-k)+T-1});
    const result=trace({accounts,budgets,facts});
    refused(result,'QR2_RANGE_ADMISSION_REFUSED','derivation_visits');
    assert.deepEqual(result.error.detail,{limit:'derivation_visits',value:(T-k)+T,max:(T-k)+T-1});
    assert.equal(result.yields,yieldsFor(2*T+2-k),'units '+(2*T+2-k));
    await sameBothWays({accounts,facts,budgets},{code:'QR2_RANGE_ADMISSION_REFUSED',limit:'derivation_visits'});
  }
});

test('cap position: output_intervals and the final byte check refuse right after the last unit, never after a yield that follows it',async()=>{
  // Total units: 2T+1 (T check units, 1 window unit, T gap units), +1 for an absent-union window. 8191, 8192 and 8193 units.
  for(const [T,withAbsent,units] of [[4095,false,8191],[4095,true,8192],[4096,false,8193]]){
    const args=sparse(T,withAbsent),base=budgetsOf({output_intervals:20000,coverage_output_bytes:8388608});
    const clean=trace({...args,budgets:base});
    assert.equal(clean.ok,true);assert.equal(clean.yields,yieldsFor(units),'a clean build of '+units+' units');
    const charges=clean.value.charges;
    const intervals=trace({...args,budgets:{...base,output_intervals:charges.output_intervals-1}});
    refused(intervals,'QR2_RANGE_ADMISSION_REFUSED','output_intervals');
    assert.deepEqual(intervals.error.detail,{limit:'output_intervals',value:charges.output_intervals,max:charges.output_intervals-1});
    assert.equal(intervals.yields,yieldsFor(units),'output_intervals after '+units+' units');
    const bytes=trace({...args,budgets:{...base,coverage_output_bytes:charges.output_bytes_upper_bound-1}});
    refused(bytes,'QR2_RANGE_ADMISSION_REFUSED','coverage_output_bytes');
    assert.equal(bytes.yields,yieldsFor(units),'coverage_output_bytes after '+units+' units');
    await sameBothWays({...args,budgets:{...base,output_intervals:charges.output_intervals-1}},{code:'QR2_RANGE_ADMISSION_REFUSED',limit:'output_intervals'});
    await sameBothWays({...args,budgets:{...base,coverage_output_bytes:charges.output_bytes_upper_bound-1}},{code:'QR2_RANGE_ADMISSION_REFUSED',limit:'coverage_output_bytes'});
    // The registry is the same bytes through the three paths.
    assert.equal((await triple({...args,budgets:base})).ok,true);
  }
});

test('cap position: a corrupt timestamp fails in the unit that holds it, after the yield that precedes that unit and not before',()=>{
  // Unit p + 1 holds the p-th timestamp (0-based). The failure follows the yield at the start of unit 8193 and precedes none that would come after unit 8192.
  for(const index of [8189,8190,8191,8192]){
    const timestamps=dense(1,9000);timestamps[index]+=1;
    const result=trace({accounts:[account('a',0,9002*M)],budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps}]});
    refused(result,'QR2_REPORT_FAILED');
    assert.equal(result.yields,yieldsFor(index+1),'bad timestamp at index '+index);
  }
});

test('yield count of a clean build is floor((units - 1) / 8192): the meter runs across the union loop, the window loop and the gap loop, and no yield follows the last unit',()=>{
  for(const count of [1,100,4095,4096,8191,8192,8193,12288,16384,16385,21600]){
    const args={accounts:[account('a',0,(count+2)*M)],budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps:dense(1,count)}]};
    const result=trace(args);
    assert.equal(result.ok,true);
    // count check units + 1 window unit + count gap units.
    assert.equal(result.yields,yieldsFor(2*count+1),String(count));
    assert.equal(JSON.stringify(result.value),JSON.stringify(old.buildCoverageSnapshot(args)));
  }
  // Literal pin of the slice size (independent of the exported constant): units are 2 * count + 1, one yield at the start of unit 8193, 16385, ...
  for(const [count,yields] of [[4095,0],[4096,1],[8191,1],[8192,2],[12288,3],[21600,5]])
    assert.equal(trace({accounts:[account('a',0,(count+2)*M)],budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps:dense(1,count)}]}).yields,yields,'literal '+count);
  // A synchronous drain never waits: a build of 40000 units returns in the turn that called it.
  const args={accounts:[account('a',0,20002*M)],budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps:dense(1,20000)}]};
  let turns=0,armed=true;const tick=()=>{turns++;if(armed)setImmediate(tick);};setImmediate(tick);
  live.buildCoverageSnapshot(args);armed=false;
  assert.equal(turns,0);
});

test('the cooperative drain gives the event loop one macrotask turn per yield and rejects with the synchronous refusal',async()=>{
  const args={accounts:[account('a',0,20002*M)],budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps:dense(1,20000)}]};
  const yields=trace(args).yields;
  assert.equal(yields,yieldsFor(40001));assert.ok(yields>=4);
  let turns=0,armed=true;const tick=()=>{turns++;if(armed)setImmediate(tick);};setImmediate(tick);
  const built=await live.buildCoverageSnapshotCooperative(args);armed=false;
  assert.ok(turns>=yields,'ticks '+turns+' >= yields '+yields);
  assert.equal(JSON.stringify(built),JSON.stringify(old.buildCoverageSnapshot(args)));
  // A refusal inside the sliced loop rejects with the plain Error the synchronous build throws; nothing is thrown synchronously.
  const refusedArgs={...args,budgets:budgetsOf({derivation_visits:19999})};
  const promise=live.buildCoverageSnapshotCooperative(refusedArgs);
  assert.ok(promise instanceof Promise);
  await assert.rejects(promise,error=>error.code==='QR2_RANGE_ADMISSION_REFUSED'&&error.name==='Error'&&!(error instanceof Qr2Error)&&error.detail.limit==='derivation_visits');
  await assert.rejects(live.buildCoverageSnapshotCooperative({accounts:null,budgets:{},facts:[]}));
});

// ---------------------------------------------------------------------------------------------------------------- reader end to end
function database(times,{isolation='repeatable read'}={}){
  const sorted=[...times].sort((a,b)=>a-b),calls=[];
  return {isTransaction:true,calls,async query(sql,params){
    calls.push({sql,params});
    if(sql===COVERAGE_SQL.ISOLATION)return {rows:[{transaction_isolation:isolation}]};
    if(sql===COVERAGE_SQL.READ_ONLY)return {rows:[{transaction_read_only:'on'}]};
    if(sql===COVERAGE_SQL.PROBE)return {rows:[{name:'pine_market_bars'}]};
    if(sql!==COVERAGE_SQL.ROWS)throw new Error('unexpected SQL');
    const [,,,cursor,to,limit]=params;
    let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>1;if(sorted[mid]>cursor)hi=mid;else lo=mid+1;}
    const rows=[];for(let i=lo;i<sorted.length&&rows.length<limit&&sorted[i]<=to;i++)rows.push({bar_time:String(sorted[i])});
    return {rows};
  }};
}
async function outcome(read,tx,args){
  try{const value=await read({transaction:tx,...args});return {ok:true,text:JSON.stringify(value),value};}
  catch(error){return {ok:false,name:error?.name,code:error?.code,detail:error?.detail===undefined?undefined:JSON.stringify(error.detail),qr2:error instanceof Qr2Error,message:error?.message};}
}
const strip=o=>o.ok?{ok:true,text:o.text}:o;
async function sameReads(times,args,chunk){
  const a=await outcome(oracleReader.readCoverageSnapshot,database(times),args);
  const b=await outcome(chunk===undefined?readCoverageSnapshot:x=>readCoverageSnapshotWithChunkRows(x,chunk),database(times),args);
  assert.deepEqual(strip(b),strip(a),'chunk '+chunk+', '+times.length+' rows');
  return a;
}

test('cooperative build equals the synchronous drain end to end through the frozen 95e6cec reader (equality to 95e6cec itself: matrix and golden digests) at 8191..21601 rows, with caps firing inside the sliced build (degraded registries equal)',async()=>{
  let degraded=0,complete=0;
  for(const count of [8191,8192,8193,16385,20000,21600,21601])for(const shape of ['dense','gappy','windows']){
    const {accounts,times}=largeCase(shape,Math.min(count,21600));
    const data=count===21601?dense(1,21601):times;
    const args={accounts,budgets:budgetsOf({})};
    const full=await sameReads(data,args,undefined);
    if(!full.ok)continue;
    if(JSON.parse(full.text).unions[0].fact.state!=='COMPLETE'){degraded++;continue;}
    complete++;
    const charges=JSON.parse(full.text).charges;
    for(const [key,value] of [['derivation_visits',charges.derivation_visits-1],['output_intervals',charges.output_intervals-1],['coverage_output_bytes',charges.output_bytes_upper_bound-1]]){
      if(value<1)continue;
      const result=await sameReads(data,{accounts,budgets:budgetsOf({[key]:value})},undefined);
      assert.equal(result.ok,true);
      assert.deepEqual(JSON.parse(result.text).unions[0].fact,{state:'BUDGET_EXCEEDED',limit:key},'the data-time cap of the build degrades: '+key+' '+shape+count);
      degraded++;
    }
  }
  assert.ok(complete>=15&&degraded>=40,complete+'/'+degraded);
});

// Golden digests: sha256 of the registry JSON and of the projected public coverage produced by the 95e6cec reader (copied from the b-1a test; a drift fails here).
const GOLDEN_CASES={
  dense8191:()=>({times:dense(1,8191),accounts:[account('a',0,8193*M)]}),
  dense8192:()=>({times:dense(1,8192),accounts:[account('a',0,8194*M)]}),
  dense8193:()=>({times:dense(1,8193),accounts:[account('a',0,8195*M)]}),
  dense16385:()=>({times:dense(1,16385),accounts:[account('a',0,16387*M)]}),
  dense21600:()=>({times:dense(1,21600),accounts:[account('a',0,21602*M)]}),
  dense21601Degraded:()=>({times:dense(1,21601),accounts:[account('a',0,21603*M)]}),
  gappy:()=>({times:Array.from({length:21600},(_,i)=>i+1).filter(m=>m%7!==0).map(m=>m*M),accounts:[account('a',0,21601*M)]}),
  ownerTwoWindowsOneUnion:()=>({times:dense(1,15000),accounts:[account('a',0,9000*M),account('b',4000*M,15001*M)]}),
  ownerTwoUnions:()=>({times:dense(1,8193).concat(dense(20000,9000)),accounts:[account('a',0,8194*M),account('b',19999*M,29001*M)]}),
  offGridFailure:()=>({times:dense(1,10000).concat([5000*M+3]),accounts:[account('a',0,10002*M)]})
};
const GOLDEN={
  dense8191:{registry:'177438996b961baa4d20a14b5aa3ca9a65d45a01795f3ab0d737fb91b6907f2d',public:'3eb43cd3c8fb57e9407f8157fc3022e28ccb0054435e72841ff2c5e8c53ef6b0'},
  dense8192:{registry:'9eaf606870dc94ffd5303ba631e2934e9747a48dfba9dbbfd64ffb97dfb65f2b',public:'cade85a8a37a0d0cf951997ce5d8bc4cd855c309d3f640db357cdaf1cbd3eb57'},
  dense8193:{registry:'709f079de7c1fb8565d4fa4424456a13e5617858cd178b79df79acd542061699',public:'1cc98b3c01f5d9b8f78db7aaa0c88bf85f3bbe4e4f76891a83cf3a74c0a66a26'},
  dense16385:{registry:'77577d584b856708b8e64b08b3fad76692d91350bfab59e4b26224ee6916feed',public:'a127e62a6e769a869d7dd7768d06fd6c14110020698e62b8bd6e7f5c0bcb6341'},
  dense21600:{registry:'60c6d9d2286ecd7e73d2f8325f68270e7b25f4d45fc4040017c70bf131a5ded7',public:'7b7a077109f950d6b06c754a341dbe5d9c0997907bd4dd6894fc7b6ee746a43a'},
  dense21601Degraded:{registry:'d212074e70f311416ed98dcd3156fe625231e585561cdc6428fe4866f9da21ff',public:'09305a1d7091f82c4591297e4ca58c5968cb92191f95b3a9c43a87e67b36b4dd'},
  gappy:{registry:'122aaa1c525f1cac41794749bcef92efb7b2bb17e271d2ab0033b9cc4a185797',public:'c857f0b236cf9587833c43ceb19fba3f3b3fb6bdf3d78524f0782467402ef7bf'},
  ownerTwoWindowsOneUnion:{registry:'bb34fd2748e929b59f1f0fac192030240315a7731a5f4e44fff0240e49424db3',public:'b409df1aa500eb3191058e8bba40d3fefb66dfeddf840935e29bd3b9037a2df3'},
  ownerTwoUnions:{registry:'866436f1cc1a67f02c56d92bc771935db62f17133a84bd94afdf55df07487ea3',public:'9623e2f5ae37bb72efaaf6edfcf354478af95f51f913899fc76dca23d1f44cd9'},
  offGridFailure:{registry:'a0969e9a5344ed85f607b38d19ee08b0b38e42895e6a50bc17641acdee71c290',public:'3973e022e93220f9212c18d0d0c543ae7c309e46640da93a4a0314de999f5112'}
};
function digestsOf(registryOutcome,context){
  const registry=registryOutcome.ok?registryOutcome.text:'ERR '+registryOutcome.code+' '+registryOutcome.detail;
  let publicText;
  if(!registryOutcome.ok)publicText='-';
  else{try{publicText=JSON.stringify(projectPublicCoverage(registryOutcome.value,context));}catch(error){publicText='ERR '+error.code;}}
  return {registry:sha(registry),public:sha(publicText)};
}
test('golden digests from the 95e6cec reader: the cooperative reader gives the same registry and projected public coverage for every golden case (some over 8192 build units)',async()=>{
  const actual={};
  for(const [name,make] of Object.entries(GOLDEN_CASES)){
    const {times,accounts}=make(),args={accounts,budgets:budgetsOf({})},context=args;
    const fromOracle=digestsOf(await outcome(oracleReader.readCoverageSnapshot,database(times),args),context);
    actual[name]=fromOracle;
    for(const chunk of [undefined,4096,1000]){
      const fromNew=digestsOf(await outcome(chunk===undefined?readCoverageSnapshot:x=>readCoverageSnapshotWithChunkRows(x,chunk),database(times),args),context);
      assert.deepEqual(fromNew,fromOracle,name+' chunk '+chunk);
    }
  }
  assert.deepEqual(actual,GOLDEN);
});

// ---------------------------------------------------------------------------------------------------------------- ALS and the per-Bot path
test('ALS after the build yields: the per-Bot facade keeps its transaction through a cooperative build of more than one slice, and interleaved builds keep their own store',async()=>{
  const db=new PostgresDatabase({connectionString:'postgres://unused:unused@127.0.0.1:1/unused'});
  const real=db.pool,log=[],rows=20000,double=database(dense(1,rows));
  const client={async query(sql,params){log.push(sql.slice(0,40));if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return {rows:[]};if(sql==='SELECT after the build')return {rows:[{ok:1}]};return double.query(sql,params);},release(){log.push('RELEASE');}};
  db.pool={connect:async()=>client};
  try{
    let turns=0,armed=true;const tick=()=>{turns++;if(armed)setImmediate(tick);};
    const registry=await db.transaction(async()=>{
      setImmediate(tick);
      const result=await readCoverageSnapshot({transaction:db,accounts:[account('a',0,(rows+2)*M)],budgets:budgetsOf({})});
      armed=false;
      assert.equal(db.isTransaction,true,'the ALS store survives the reader yield and every build yield');
      assert.deepEqual((await db.query('SELECT after the build')).rows,[{ok:1}]);
      return result;
    },{isolation:'REPEATABLE READ'});
    assert.equal(registry.unions[0].fact.timestamps.length,rows);
    assert.ok(turns>=1+yieldsFor(2*rows+1),'macrotask turns during the read: '+turns+' (one reader yield and '+yieldsFor(2*rows+1)+' build yields)');
    assert.equal(log[0],'BEGIN ISOLATION LEVEL REPEATABLE READ');
    assert.deepEqual(log.slice(-3),['SELECT after the build','COMMIT','RELEASE']);
    assert.equal(db.isTransaction,false);
  }finally{db.pool=real;await real.end();await db.limitPool.end();}
  // Two interleaved cooperative builds in two AsyncLocalStorage contexts.
  const als=new AsyncLocalStorage(),args={accounts:[account('a',0,20002*M)],budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps:dense(1,20000)}]};
  const seen=[];
  await Promise.all(['one','two'].map(name=>als.run(name,async()=>{
    const steps=live.buildCoverageSnapshotSteps(args);let step=steps.next();
    while(!step.done){await new Promise(resolve=>setImmediate(resolve));seen.push([name,als.getStore()]);step=steps.next();}
    seen.push([name,'built:'+als.getStore()]);
    assert.equal(als.getStore(),name);
    assert.equal((await live.buildCoverageSnapshotCooperative(args)).charges.timestamp_rows,20000);
    assert.equal(als.getStore(),name);
  })));
  assert.ok(seen.length>=10&&seen.every(([name,store])=>store===name||store==='built:'+name),JSON.stringify(seen));
  assert.ok(seen.slice(0,6).some(([name])=>name==='one')&&seen.slice(0,6).some(([name])=>name==='two'),'the two builds interleave');
});

// ---------------------------------------------------------------------------------------------------------------- deadline record
test('deadline record (evidence, not a guarantee): largest block of the cooperative build and the worker validation time at option-A and owner shaped sizes',async t=>{
  const shapes={
    optionA44640:{accounts:[account('a',0,44642*M)],times:dense(1,44640),budgets:budgetsOf({union_minutes:44700,timestamp_rows:44640,coverage_input_bytes:1048576,derivation_visits:223200})},
    ownerFiveWindows:(()=>{const accounts=[0,1,2,3,4].map(i=>account('w'+i,i*10*M,(44640-i)*M));return {accounts,times:dense(1,44640),budgets:budgetsOf({union_minutes:44640,timestamp_rows:44640,coverage_input_bytes:1048576,derivation_visits:223200})};})()
  };
  const record={};
  for(const [name,{accounts,times,budgets}] of Object.entries(shapes)){
    const args={accounts,budgets,facts:[{state:'COMPLETE',timestamps:times}]};
    let syncMs=Infinity,blockMs=Infinity,steps=0;
    for(let run=0;run<5;run++){
      let start=performance.now();const built=live.buildCoverageSnapshot(args);syncMs=Math.min(syncMs,performance.now()-start);
      const generator=live.buildCoverageSnapshotSteps(args);let longest=0,count=0,step;
      for(;;){start=performance.now();step=generator.next();longest=Math.max(longest,performance.now()-start);if(step.done)break;count++;}
      blockMs=Math.min(blockMs,longest);steps=count;
      assert.equal(JSON.stringify(step.value),JSON.stringify(built));
    }
    const registry=live.buildCoverageSnapshot(args);
    let liveValidateMs=Infinity,frozenValidateMs=Infinity;
    for(let run=0;run<5;run++){
      let start=performance.now();live.validateCoverageSnapshot(registry,{accounts,budgets});liveValidateMs=Math.min(liveValidateMs,performance.now()-start);
      start=performance.now();old.validateCoverageSnapshot(registry,{accounts,budgets});frozenValidateMs=Math.min(frozenValidateMs,performance.now()-start);
    }
    const start=performance.now();await live.buildCoverageSnapshotCooperative(args);const cooperativeMs=performance.now()-start;
    record[name]={rows:times.length,units:'~'+(2*times.length+accounts.length),yields:steps,sync_build_ms:+syncMs.toFixed(1),cooperative_build_wall_ms:+cooperativeMs.toFixed(1),longest_block_between_yields_ms:+blockMs.toFixed(1),worker_validate_live_ms:+liveValidateMs.toFixed(1),worker_validate_frozen_ms:+frozenValidateMs.toFixed(1)};
    assert.ok(liveValidateMs<10000&&frozenValidateMs<10000,'far below the 10000 ms worker deadline');
  }
  t.diagnostic(JSON.stringify(record));
});
