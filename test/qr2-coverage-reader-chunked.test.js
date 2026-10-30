import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readCoverageSnapshot,readCoverageSnapshotWithChunkRows,COVERAGE_SQL} from '../src/postgres/qr2-coverage-reader.js';
import * as oracle from './helpers/qr2-coverage-reader-oracle-95e6cec.js';
import {QR2_COVERAGE_CHUNK_ROWS,QR2_COVERAGE_LIMITS,coverageReadBudgets} from '../src/portfolio/qr2-coverage-limits.js';
import {projectPublicCoverage} from '../src/portfolio/qr2-coverage-public.js';
import {QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
import {Qr2Error} from '../src/portfolio/qr2-constants.js';
import {PostgresDatabase} from '../src/postgres/db.js';

// QR-2 product change (b), slice b-1a: the keyset chunked coverage reader against the frozen 95e6cec reader (the oracle).
// The fake transaction below behaves like the database for the pinned SQL: it honours $4 (cursor, exclusive), $5 (window end, inclusive)
// and $6 (limit), sorts by bar time and never returns a row twice. Every differential test compares the oracle and the new reader on the
// same data: results byte-equal (JSON text) and refusals equal (name, code, detail, class, message).
const M=60000;
const sha=text=>createHash('sha256').update(text).digest('hex');
const account=(id,from,to)=>({bot_id:id,broker:'binance-global',market,resolved_range:{from,to}});
const budgetsOf=over=>({...QR2_COVERAGE_LIMITS,...over});
const dense=(first,count,step=1)=>Array.from({length:count},(_,i)=>(first+i*step)*M);

/** Database double. times: BIGINT bar times (any order; the double sorts). hook(rows,params,index) may replace the answer (driver-level corruption). */
function database(times,{hook,isolation='repeatable read',readOnly='on'}={}){
  const sorted=[...times].sort((a,b)=>a-b),calls=[];let rowQueries=0;
  const tx={isTransaction:true,calls,async query(sql,params){
    calls.push({sql,params});
    if(sql===COVERAGE_SQL.ISOLATION)return {rows:[{transaction_isolation:isolation}]};
    if(sql===COVERAGE_SQL.READ_ONLY)return {rows:[{transaction_read_only:readOnly}]};
    if(sql===COVERAGE_SQL.PROBE)return {rows:[{name:'pine_market_bars'}]};
    if(sql!==COVERAGE_SQL.ROWS)throw new Error('unexpected SQL');
    const [,,,cursor,to,limit]=params,index=rowQueries++;
    assert.ok(Number.isSafeInteger(limit)&&limit>=1,'LIMIT is a positive integer');
    let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>1;if(sorted[mid]>cursor)hi=mid;else lo=mid+1;}
    const rows=[];for(let i=lo;i<sorted.length&&rows.length<limit&&sorted[i]<=to;i++)rows.push({bar_time:String(sorted[i])});
    return hook?hook(rows,params,index):{rows};
  }};
  return tx;
}
const rowsCalls=tx=>tx.calls.filter(c=>c.sql===COVERAGE_SQL.ROWS);

async function outcome(read,tx,args){
  try{const value=await read({transaction:tx,...args});return {ok:true,text:JSON.stringify(value),value};}
  catch(error){return {ok:false,name:error?.name,code:error?.code,detail:error?.detail===undefined?undefined:JSON.stringify(error.detail),qr2:error instanceof Qr2Error,message:error?.message};}
}
const strip=o=>o.ok?{ok:true,text:o.text}:o;
/** Oracle and new reader on identical fresh doubles. chunk undefined means the product entry point. */
async function same(times,args,chunk,{hook}={}){
  const a=await outcome(oracle.readCoverageSnapshot,database(times,{hook}),args);
  const b=await outcome(chunk===undefined?readCoverageSnapshot:x=>readCoverageSnapshotWithChunkRows(x,chunk),database(times,{hook}),args);
  assert.deepEqual(strip(b),strip(a),'chunk '+chunk+', '+times.length+' rows');
  return a;
}

test('frozen oracle is the 95e6cec reader: only its two import lines differ, proved by hashes of the original blob',()=>{
  const bytes=fs.readFileSync(new URL('./helpers/qr2-coverage-reader-oracle-95e6cec.js',import.meta.url));
  // A Windows checkout may turn LF into CRLF; the pins are for the LF text.
  const text=bytes.toString('utf8').replaceAll('\r\n','\n'),lines=text.split('\n');
  assert.match(lines[0],/^import \{planCoverage,.*\} from '\.\.\/\.\.\/src\/portfolio\/qr2-coverage-snapshot\.js';$/);
  assert.equal(lines[1],"import {Qr2Error} from '../../src/portfolio/qr2-constants.js';");
  const original=[lines[0].replace("'../../src/portfolio/","'../portfolio/"),lines[1].replace("'../../src/portfolio/","'../portfolio/"),...lines.slice(2)].join('\n');
  assert.equal(sha(original),'1144123ec60607efd94a51824934ad72dc6154c2d8663ee63f8e5511ccf6b352','sha256 of git blob 95e6cec:src/postgres/qr2-coverage-reader.js');
  const buffer=Buffer.from(original,'utf8');
  assert.equal(createHash('sha1').update('blob '+buffer.length+'\0').update(buffer).digest('hex'),'c2523fc8b2621df4396e5e6997cd7f10c0a95dde','git blob id at 95e6cec');
  // Lines 3 to the end are byte-identical to the original blob (the reconstruction above only rewrote lines 1 and 2).
  assert.equal(sha(lines.slice(2).join('\n')),'25e3373f04e007d34a2f35cffa2f77fcbdb6ba06be5b5975424f6cdbd1d6d711');
  // The oracle has the single-statement shape: it passes the sentinel limit as $6 and never a cursor other than the window start.
  assert.match(text,/window\.to,limit\]\),limit\)/);
});

test('constant and SQL: the chunk size is frozen, is not a budget key, and the SQL text is unchanged',()=>{
  assert.equal(QR2_COVERAGE_CHUNK_ROWS,8192);
  assert.equal(Object.hasOwn(QR2_COVERAGE_LIMITS,'QR2_COVERAGE_CHUNK_ROWS'),false);
  assert.throws(()=>coverageReadBudgets({QR2_COVERAGE_CHUNK_ROWS:1}),{code:'QR2_INPUT_INVALID'});
  assert.throws(()=>coverageReadBudgets({chunk_rows:1}),{code:'QR2_INPUT_INVALID'});
  assert.deepEqual(COVERAGE_SQL,oracle.COVERAGE_SQL);
  assert.equal(sha(COVERAGE_SQL.ROWS),sha('SELECT bar_time::text AS bar_time FROM public.pine_market_bars WHERE broker=$1 AND symbol=$2 AND timeframe=$3 AND bar_time>$4::bigint AND bar_time<=$5::bigint ORDER BY public.pine_market_bars.bar_time LIMIT $6'));
});

test('seam: a chunk size outside [1, 8192] or not a safe integer is QR2_INPUT_INVALID before any query; the product entry point takes no chunk argument',async()=>{
  for(const bad of [0,-1,1.5,8193,2**53,Infinity,NaN,'8',null,undefined,{},[8]]){
    const tx=database(dense(1,3));
    await assert.rejects(readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,5*M)],budgets:budgetsOf({})},bad),{code:'QR2_INPUT_INVALID'},String(bad));
    assert.equal(tx.calls.length,0);
  }
  // The product entry point ignores a chunkRows property: product code cannot lower or raise the chunk.
  for(const extra of [1,2,8192,99999]){
    const tx=database(dense(1,3));
    await readCoverageSnapshot({transaction:tx,accounts:[account('a',0,5*M)],budgets:budgetsOf({}),chunkRows:extra});
    assert.deepEqual(rowsCalls(tx).map(c=>c.params[5]),[8192]);
  }
});

test('every product read at default budgets sends $6 = 8192 (not 21601); a read under the chunk size is one statement',async()=>{
  const tx=database(dense(1,10));
  const registry=await readCoverageSnapshot({transaction:tx,accounts:[account('a',0,12*M)],budgets:budgetsOf({})});
  assert.equal(registry.unions[0].fact.timestamps.length,10);
  assert.deepEqual(rowsCalls(tx).map(c=>c.params),[['binance-global','BTCUSDT','1',0,12*M,8192]]);
  // The sentinel limit itself is still remaining + 1 = 21601; only the per-statement limit is the chunk.
  const small=database(dense(1,10));
  await readCoverageSnapshotWithChunkRows({transaction:small,accounts:[account('a',0,12*M)],budgets:budgetsOf({timestamp_rows:5})},8192);
  assert.deepEqual(rowsCalls(small).map(c=>c.params[5]),[6]);
});

test('statement sequence: $4 advances to the last time read, $6 = min(chunk, sentinel limit - fetched), a short chunk ends the union, an exact multiple adds one empty statement',async()=>{
  const budgets=budgetsOf({timestamp_rows:10});
  // 7 rows, chunk 3: statements 3,3,1 (short) -> stop.
  let tx=database(dense(1,7));await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,9*M)],budgets},3);
  assert.deepEqual(rowsCalls(tx).map(c=>[c.params[3],c.params[5]]),[[0,3],[3*M,3],[6*M,3]]);
  // 6 rows, chunk 3: 3,3 then the empty third statement.
  tx=database(dense(1,6));await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,9*M)],budgets},3);
  assert.deepEqual(rowsCalls(tx).map(c=>[c.params[3],c.params[5]]),[[0,3],[3*M,3],[6*M,3]]);
  // 11 rows (sentinel, limit 11), chunk 4: 4,4,3 then no statement after fetched === limit.
  tx=database(dense(1,11));const degraded=await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,13*M)],budgets},4);
  assert.deepEqual(rowsCalls(tx).map(c=>[c.params[3],c.params[5]]),[[0,4],[4*M,4],[8*M,3]]);
  assert.deepEqual(degraded.unions[0].fact,{state:'BUDGET_EXCEEDED',limit:'timestamp_rows'});
  // The market, window end and window are the same in every statement.
  assert.ok(rowsCalls(tx).every(c=>c.params[0]==='binance-global'&&c.params[1]==='BTCUSDT'&&c.params[2]==='1'&&c.params[4]===13*M));
  // Chunk 1, capacity 10 (sentinel limit 11): a read over the capacity sends exactly 11 statements, and a complete read of 10 rows sends 11 as well (ten rows, then one empty statement).
  tx=database(dense(1,10));await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,12*M)],budgets},1);
  assert.equal(rowsCalls(tx).length,11);
  tx=database(dense(1,40));await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,45*M)],budgets},1);
  assert.equal(rowsCalls(tx).length,11);
  // A second union starts at its own window start with its own remaining capacity.
  tx=database(dense(1,5).concat(dense(100,2)));
  await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,6*M),account('b',99*M,103*M)],budgets},2);
  assert.deepEqual(rowsCalls(tx).map(c=>[c.params[3],c.params[5]]),[[0,2],[2*M,2],[4*M,2],[99*M,2],[101*M,2]]);
});

test('byte-derived capacity: the admission byte estimate and the order sentinel agree at the exact edge, with and without a latched decode failure',async()=>{
  // coverage_input_bytes 3400 over a zero-row envelope of 3322 gives capacity floor(78 / 17) = 4 rows; admitCoverageRows refuses from 5 rows (3407 > 3400).
  // The sentinel limit is capacity + 1, so a row count that passes the sentinel always passes the byte estimate: admitCoverageRows is a guard that never fires
  // in the reader (the mutant "admit call removed" is equivalent, recorded by the audit round). This test pins the edge instead: 4 rows complete, 5 degrade,
  // and the sentinel outranks a latched failure while a failure at 4 fetched rows is admitted and then thrown.
  const budgets=budgetsOf({coverage_input_bytes:3400});
  const state=r=>JSON.parse(r.text).unions[0].fact.state;
  for(const chunk of [undefined,2,8192]){
    const at=await same(dense(1,4),{accounts:[account('a',0,7*M)],budgets},chunk);
    assert.equal(at.ok,true);assert.equal(state(at),'COMPLETE');
    const over=await same(dense(1,5),{accounts:[account('a',0,7*M)],budgets},chunk);
    assert.equal(over.ok,true);assert.equal(state(over),'BUDGET_EXCEEDED');
    // 5 fetched rows, the last one off the minute grid: the sentinel fires first, so the answer is a degraded registry, not 503.
    const sentinelFirst=await same(dense(1,4).concat([4*M+1]),{accounts:[account('a',0,7*M)],budgets},chunk);
    assert.equal(sentinelFirst.ok,true);assert.equal(state(sentinelFirst),'BUDGET_EXCEEDED');
    // 4 fetched rows (the capacity), the last one off the grid: admitted, then the latched failure is thrown.
    const latched=await same(dense(1,3).concat([3*M+1]),{accounts:[account('a',0,7*M)],budgets},chunk);
    assert.equal(latched.ok,false);assert.equal(latched.code,'QR2_REPORT_FAILED');
  }
});

test('differential at and across chunk boundaries (default budgets, default chunk): 0, 1, 8191, 8192, 8193, 16384, 16385, 21600, 21601 dense rows',async()=>{
  for(const count of [0,1,8191,8192,8193,16384,16385,21600,21601]){
    const result=await same(dense(1,count),{accounts:[account('a',0,(count+2)*M)],budgets:budgetsOf({})},undefined);
    assert.equal(result.ok,true);
    assert.equal(JSON.parse(result.text).unions[0].fact.state,count>21600?'BUDGET_EXCEEDED':'COMPLETE',String(count));
  }
});

test('differential across chunk boundaries with lowered chunk sizes: 1, 2, 3, 7, 59, 60, 61, 4096, 8192 on 8191..16385 rows and a gappy union',async()=>{
  for(const chunk of [1,2,3,7,59,60,61,4096,8192]){
    // Small chunks on large data would issue tens of thousands of statements; they run on the small data below. Large data uses the larger chunk sizes.
    if(chunk<4096)continue;
    for(const count of [8191,8192,8193,16384,16385])await same(dense(1,count),{accounts:[account('a',0,(count+2)*M)],budgets:budgetsOf({})},chunk);
  }
  // Every fifth minute is missing: a gap per five stored minutes.
  const gappy=Array.from({length:12000},(_,i)=>(i+1+Math.floor(i/5))*M);
  for(const chunk of [1000,4096,8192])await same(gappy,{accounts:[account('a',0,(gappy.at(-1)/M+2)*M)],budgets:budgetsOf({})},chunk);
});

test('differential matrix: chunk sizes x capacities x row counts x one or two unions, on small data',async()=>{
  let complete=0,degraded=0;
  for(const chunk of [1,2,3,7,59,60,61,8192])for(const capacity of [1,2,5,7,60])for(const count of [0,1,capacity-1,capacity,capacity+1,capacity+2,2*chunk,2*chunk+1,chunk-1,chunk,chunk+1].filter(c=>c>=0&&c<=200)){
    const budgets=budgetsOf({timestamp_rows:capacity});
    const one=await same(dense(1,count),{accounts:[account('a',0,(count+3)*M)],budgets},chunk);
    JSON.parse(one.text).unions[0].fact.state==='COMPLETE'?complete++:degraded++;
    // Two unions share the capacity; the second window starts after the first rows.
    const split=Math.floor(count/2),times=dense(1,split).concat(dense(1000,count-split));
    await same(times,{accounts:[account('a',0,(split+3)*M),account('b',999*M,(1000+count)*M)],budgets},chunk);
    // The same windows merged into one union (overlapping owner windows).
    await same(times,{accounts:[account('a',0,1000*M+count*M),account('b',0,1000*M+count*M)],budgets},chunk);
  }
  assert.ok(complete>50&&degraded>50,'both outcome classes are exercised: '+complete+'/'+degraded);
});

function prng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
test('seeded differential: random data with off-grid rows, random capacity and chunk, one or two unions (oracle equal in result and in refusal)',async()=>{
  const random=prng(0x95E6CEC),seen={ok:0,degraded:0,failed:0};
  for(let n=0;n<600;n++){
    const capacity=1+Math.floor(random()*12),chunk=1+Math.floor(random()*9),count=Math.floor(random()*(capacity*2+3));
    let minute=0;const times=[];
    for(let i=0;i<count;i++){minute+=1+Math.floor(random()*3);times.push(minute*M+(random()<0.04?1+Math.floor(random()*59999):0));}
    const budgets=budgetsOf({timestamp_rows:capacity,union_minutes:500});
    const accounts=random()<0.5?[account('a',0,(minute+3)*M)]:[account('a',0,(Math.floor(minute/2)+1)*M),account('b',(Math.floor(minute/2)+1)*M,(minute+3)*M)];
    const result=await same(times,{accounts,budgets},chunk);
    if(!result.ok)seen.failed++;else if(JSON.parse(result.text).unions.some(u=>u.fact.state==='BUDGET_EXCEEDED'))seen.degraded++;else seen.ok++;
  }
  assert.ok(seen.ok>100&&seen.degraded>100&&seen.failed>20,JSON.stringify(seen));
});

test('latched decode failure keeps the oracle precedence: sentinel first, then admission, then the first failure; an earlier union ends before a later one',async()=>{
  const budgets=budgetsOf({timestamp_rows:5});
  const offGridEarly=[M,2*M+1,3*M,4*M,5*M,6*M,7*M];                    // off-grid row in the first chunk, overflow (7 rows > capacity 5) later
  for(const chunk of [1,2,3,4,7,8192]){
    const over=await same(offGridEarly,{accounts:[account('a',0,9*M)],budgets},chunk);
    assert.equal(over.ok,true);assert.deepEqual(JSON.parse(over.text).unions[0].fact,{state:'BUDGET_EXCEEDED',limit:'timestamp_rows'});
    const noOver=await same(offGridEarly.slice(0,4),{accounts:[account('a',0,9*M)],budgets},chunk);
    assert.equal(noOver.ok,false);assert.equal(noOver.code,'QR2_REPORT_FAILED');assert.equal(noOver.detail,undefined);
    // Union 1 has the off-grid row and union 2 overflows: union 1 ends first, so 503.
    const first=await same([M,2*M+1,3*M].concat(dense(100,9)),{accounts:[account('a',0,4*M),account('b',99*M,110*M)],budgets},chunk);
    assert.equal(first.ok,false);assert.equal(first.code,'QR2_REPORT_FAILED');
    // Union 1 overflows (degrades the entire result) before union 2 would fail.
    const second=await same(dense(1,7).concat([100*M+1]),{accounts:[account('a',0,8*M),account('b',99*M,110*M)],budgets},chunk);
    assert.equal(second.ok,true);
    // Off-grid row after the sentinel point of a long union.
    await same(dense(1,9).concat([20*M+7]),{accounts:[account('a',0,25*M)],budgets},chunk);
    // The off-grid row is the LAST row of a full chunk: it is the cursor (integer decode only), never a grid failure by itself.
    const cursorRow=await same([M,2*M,3*M+1,4*M,5*M,6*M,7*M],{accounts:[account('a',0,9*M)],budgets},chunk);
    assert.equal(cursorRow.ok,true);
  }
});

test('a fixed driver stream with corrupt rows (duplicate, unsorted, before the window, after it) in union 1 and an overflow in union 2: 503 at the end of union 1, as the oracle',async()=>{
  // The stream double ignores the cursor and serves each window from its own list, front to back; it is a driver, not a database, so it is outside the
  // equality domain by itself. These streams are chosen so that no corrupt row is the last row of a full chunk (the cursor), and the answer is the oracle's.
  const make=lists=>{const taken={};return (_rows,params)=>{const key=params[4],list=lists[key]??[],at=taken[key]??0,out=list.slice(at,at+params[5]);taken[key]=at+out.length;return {rows:out.map(bar_time=>({bar_time}))};};};
  const budgets=budgetsOf({timestamp_rows:5});
  const accounts=[account('a',0,20*M),account('b',99*M,110*M)];
  const overflow=dense(100,7).map(String);
  const corrupt={
    duplicate:['60000','120000','120000','240000','300000'],
    unsorted:['60000','180000','120000','240000','300000'],
    beforeWindow:['0','60000','120000','240000','300000'],
    afterWindow:['60000','120000','180000','240000',String(21*M)],
    firstRowAtFrom:['0','120000','180000','240000','300000']
  };
  for(const [name,list] of Object.entries(corrupt))for(const chunk of [1,2,4,8192]){
    const lists={[20*M]:list,[110*M]:overflow};
    const a=await outcome(oracle.readCoverageSnapshot,database([],{hook:make(lists)}),{accounts,budgets});
    const b=await outcome(x=>readCoverageSnapshotWithChunkRows(x,chunk),database([],{hook:make(lists)}),{accounts,budgets});
    assert.equal(a.ok,false,name);assert.equal(a.code,'QR2_REPORT_FAILED',name);
    assert.deepEqual(strip(b),strip(a),name+' chunk '+chunk);
  }
});

test('statements are on the driver contract: a source error in any chunk, a non-array, an over-want chunk and a short chunk beyond the window all answer as the oracle does in the equality domain',async()=>{
  const budgets=budgetsOf({timestamp_rows:20});
  const accounts=[account('a',0,30*M)];
  const failAt=target=>(rows,_params,index)=>{if(index===target)throw new Error('SECRET SQL');return {rows};};
  for(const target of [0,1,2,3]){
    const a=await outcome(oracle.readCoverageSnapshot,database(dense(1,15),{hook:target===0?failAt(0):undefined}),{accounts,budgets});
    const b=await outcome(x=>readCoverageSnapshotWithChunkRows(x,4),database(dense(1,15),{hook:failAt(target)}),{accounts,budgets});
    assert.equal(b.ok,false);assert.equal(b.code,'QR2_REPORT_FAILED');assert.equal(b.message,'QR2_REPORT_FAILED');
    if(target===0)assert.deepEqual(strip(b),strip(a));
  }
  for(const bad of [null,{},{rows:null},{rows:'x'},undefined]){
    const b=await outcome(x=>readCoverageSnapshotWithChunkRows(x,4),database(dense(1,15),{hook:(rows,_p,index)=>index===1?bad:{rows}}),{accounts,budgets});
    assert.equal(b.code,'QR2_REPORT_FAILED');assert.equal(b.ok,false);
  }
  // A chunk over its own LIMIT (want, not the sentinel limit) is a corrupt result: 503, never a 422.
  const over=await outcome(x=>readCoverageSnapshotWithChunkRows(x,4),database(dense(1,15),{hook:(rows,params)=>({rows:[...rows,{bar_time:String(params[3]+9*M)}].slice(0,params[5]+1)})}),{accounts,budgets});
  assert.equal(over.ok,false);assert.equal(over.code,'QR2_REPORT_FAILED');assert.equal(over.qr2,false);
});

test('outside the equality domain (non-conforming driver results, test doubles only): the documented 503 class, the first check that fires',async()=>{
  const budgets=budgetsOf({timestamp_rows:5}),accounts=[account('a',0,12*M)];
  const text=(values)=>(rows,params,index)=>({rows:(index<values.length?values[index]:rows).map(bar_time=>({bar_time}))});
  // The cursor (last row of a full chunk) must pass the integer decode: an undecodable cursor is 503 at once, even when the oracle would degrade on the overflow.
  const cursorBad=text([['60000','120000','0180000'],['240000','300000','360000']]);
  const oracleSees=await outcome(oracle.readCoverageSnapshot,database([],{hook:(_r,params)=>({rows:['60000','120000','0180000','240000','300000','360000'].slice(0,params[5]).map(bar_time=>({bar_time}))})}),{accounts,budgets});
  assert.equal(oracleSees.ok,true,'the oracle degrades on the overflow before it decodes any row');
  const cursorOut=await outcome(x=>readCoverageSnapshotWithChunkRows(x,3),database([],{hook:cursorBad}),{accounts,budgets});
  assert.equal(cursorOut.ok,false);assert.equal(cursorOut.code,'QR2_REPORT_FAILED');
  // A non-last undecodable text is latched: the overflow still wins, like the oracle.
  const middle=text([['60000','0120000','180000'],['240000','300000','360000']]);
  const out=await outcome(x=>readCoverageSnapshotWithChunkRows(x,3),database([],{hook:middle}),{accounts,budgets});
  assert.equal(out.ok,true);assert.deepEqual(JSON.parse(out.text).unions[0].fact,{state:'BUDGET_EXCEEDED',limit:'timestamp_rows'});
  // Shape failures: null, array, extra key, wrong key in a non-last row latch; in the cursor row they fail at once.
  for(const bad of [null,[],{bar_time:'60000',extra:1},{other:'60000'},'60000',60000]){
    const hook=(rows,_p,index)=>({rows:index===0?[{bar_time:'60000'},bad,{bar_time:'180000'}]:rows});
    const latchedOnly=await outcome(x=>readCoverageSnapshotWithChunkRows(x,3),database(dense(1,4),{hook}),{accounts:[account('a',0,12*M)],budgets:budgetsOf({timestamp_rows:20})});
    assert.equal(latchedOnly.code,'QR2_REPORT_FAILED',JSON.stringify(bad));
    const asCursor=await outcome(x=>readCoverageSnapshotWithChunkRows(x,3),database(dense(1,4),{hook:(rows,_p,index)=>({rows:index===0?[{bar_time:'60000'},{bar_time:'120000'},bad]:rows})}),{accounts:[account('a',0,12*M)],budgets:budgetsOf({timestamp_rows:20})});
    assert.equal(asCursor.code,'QR2_REPORT_FAILED',JSON.stringify(bad));
    // The same bad row as the cursor of a full chunk, followed by an overflow: 503 at once (the oracle would have degraded on the overflow).
    const withOverflow=await outcome(x=>readCoverageSnapshotWithChunkRows(x,3),database([],{hook:(_r,params,index)=>({rows:(index===0?[{bar_time:'60000'},{bar_time:'120000'},bad]:[{bar_time:'240000'},{bar_time:'300000'},{bar_time:'360000'}]).slice(0,params[5])})}),{accounts:[account('a',0,12*M)],budgets:budgetsOf({timestamp_rows:5})});
    assert.equal(withOverflow.ok,false,JSON.stringify(bad));assert.equal(withOverflow.code,'QR2_REPORT_FAILED',JSON.stringify(bad));
  }
});

// Golden digests: sha256 of the oracle registry JSON and of the projected public coverage, produced by the 95e6cec reader. The new reader must produce them
// at the default chunk and at lowered chunk sizes; the oracle must still produce them (a drifted fixture or oracle fails here, not silently).
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
test('golden digests from the oracle: registry and projected public coverage are byte-equal for every chunk size',async()=>{
  const actual={};
  for(const [name,make] of Object.entries(GOLDEN_CASES)){
    const {times,accounts}=make(),args={accounts,budgets:budgetsOf({})},context=args;
    const fromOracle=digestsOf(await outcome(oracle.readCoverageSnapshot,database(times),args),context);
    actual[name]=fromOracle;
    for(const chunk of [undefined,8192,4096,1000]){
      const fromNew=digestsOf(await outcome(chunk===undefined?readCoverageSnapshot:x=>readCoverageSnapshotWithChunkRows(x,chunk),database(times),args),context);
      assert.deepEqual(fromNew,fromOracle,name+' chunk '+chunk);
    }
  }
  assert.deepEqual(actual,GOLDEN);
});

test('yield: the reader gives the event loop one macrotask turn between the last statement and the build',async()=>{
  let ticks=0,atLastRows=-1,active=true;
  const tick=()=>{ticks++;if(active)setImmediate(tick);};setImmediate(tick);
  const tx=database(dense(1,20),{hook:rows=>{atLastRows=ticks;return {rows};}});
  try{await readCoverageSnapshotWithChunkRows({transaction:tx,accounts:[account('a',0,25*M)],budgets:budgetsOf({})},8);}finally{active=false;}
  assert.ok(atLastRows>=0);
  assert.ok(ticks-atLastRows>=1,'a macrotask ran after the last statement answered and before the read returned: '+atLastRows+' -> '+ticks);
});

test('ALS after the yield: the per-Bot facade (AsyncLocalStorage transaction of PostgresDatabase) keeps its transaction between chunks and after the build yield',async()=>{
  const db=new PostgresDatabase({connectionString:'postgres://unused:unused@127.0.0.1:1/unused'});
  const real=db.pool;
  const log=[];const double=database(dense(1,20));
  const client={async query(sql,params){log.push(sql.slice(0,40));if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return {rows:[]};if(sql==='SELECT after the yield')return {rows:[{ok:1}]};return double.query(sql,params);},release(){log.push('RELEASE');}};
  db.pool={connect:async()=>client};
  try{
    assert.equal(db.isTransaction,false);
    // Outside a transaction the facade is not a transaction: the reader refuses (503) and issues nothing. This makes the positive case below non-vacuous.
    await assert.rejects(readCoverageSnapshot({transaction:db,accounts:[account('a',0,25*M)],budgets:budgetsOf({})}),{code:'QR2_REPORT_FAILED'});
    for(const chunk of [undefined,3]){
      log.length=0;
      const registry=await db.transaction(async()=>{
        const result=await (chunk===undefined?readCoverageSnapshot:x=>readCoverageSnapshotWithChunkRows(x,chunk))({transaction:db,accounts:[account('a',0,25*M)],budgets:budgetsOf({})});
        assert.equal(db.isTransaction,true,'the ALS store survives the macrotask yield');
        assert.deepEqual((await db.query('SELECT after the yield')).rows,[{ok:1}]);
        return result;
      },{isolation:'REPEATABLE READ'});
      assert.equal(registry.unions[0].fact.timestamps.length,20);
      assert.equal(log[0],'BEGIN ISOLATION LEVEL REPEATABLE READ');
      assert.equal(log.filter(s=>s.startsWith('SELECT bar_time::text')).length,chunk===undefined?1:7);
      assert.deepEqual(log.slice(-3),['SELECT after the yield','COMMIT','RELEASE']);
    }
  }finally{db.pool=real;await real.end();await db.limitPool.end();}
  // The Node primitive itself: a store set before setImmediate is visible after it.
  const als=new AsyncLocalStorage();
  assert.equal(await als.run('store',async()=>{await new Promise(r=>setImmediate(r));return als.getStore();}),'store');
});
