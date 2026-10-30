import test from 'node:test';
import assert from 'node:assert/strict';
import {readCoverageSnapshot,COVERAGE_SQL} from '../src/postgres/qr2-coverage-reader.js';
import {planCoverage,buildCoverageSnapshot,buildDegradedCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {projectPublicCoverageOutcome} from '../src/portfolio/qr2-coverage-public.js';
import {QR2_COVERAGE_LIMITS} from '../src/portfolio/qr2-coverage-limits.js';
import {QR2_COVERAGE_MARKET as market} from '../src/portfolio/qr2-coverage.js';
import {Qr2Error} from '../src/portfolio/qr2-constants.js';
import {refusalAnswer} from '../src/portfolio/qr2-response.js';
import {qr2PerformanceRoute,createQr2Slot,answerOfError} from '../src/postgres/qr2-routes.js';
import {qr2OwnerPerformanceRoute} from '../src/postgres/qr2-owner-route.js';

// Reader path to HTTP answer. A range over a read limit that is not degradable is the contract refusal 422 QR2_RANGE_ADMISSION_REFUSED with the limit in the
// detail. A stop over a degradable coverage budget (OD-S5-D) returns a degraded registry instead: the financial report goes on and only bar coverage reads
// UNAVAILABLE. The worker path keeps its plain Error and its 503 (Stage 3B). The SQL transaction is a fake; the real one is in the PostgreSQL test.
const M=60000,DAY=86400000;
const NOW=Date.UTC(2026,9,27,12,0,0);
const BOT='bot-1',OWNER='owner-1';
const REFUSED_TEXT='The request is over a limit';
const REPORT_FAILED={code:'QR2_REPORT_FAILED',error:'Performance report could not be produced'};

function transaction({isolation='repeatable read',readOnly='on',table='pine_market_bars',rowsOf=(limit,params)=>Array.from({length:limit},(_,i)=>String(params[3]+(i+1)*M)),fail,over}={}){   // honours the keyset cursor $4: the reader reads in chunks (QR-2 product change (b))
  const calls=[];
  return {isTransaction:true,calls,async query(sql,params){
    calls.push({sql,params});
    if(fail&&fail(sql))throw new Error('SECRET SQL');
    // over names a fixed query whose driver result carries two rows against its one-row LIMIT.
    const twice=rows=>over===sql?[rows[0],rows[0]]:rows;
    if(sql===COVERAGE_SQL.ISOLATION)return {rows:twice([{transaction_isolation:isolation}])};
    if(sql===COVERAGE_SQL.READ_ONLY)return {rows:twice([{transaction_read_only:readOnly}])};
    if(sql===COVERAGE_SQL.PROBE)return {rows:twice([{name:table}])};
    if(sql===COVERAGE_SQL.ROWS)return {rows:rowsOf(params[5],params).filter(t=>!(Number(t)>params[4])).map(bar_time=>({bar_time}))};   // clips at $5 (window end, inclusive) like the database; the LIMIT $6 is deliberately not enforced so a driver that ignores it can be simulated
    throw new Error('unexpected SQL');
  }};
}
const accountOf=(botId,from,to)=>({bot_id:botId,broker:'binance-global',market:{...market},resolved_range:{from,to}});
const budgetsOf=over=>({...QR2_COVERAGE_LIMITS,...over});
// The reader seam of each route: the real coverage reader on a fake transaction, in place of the database readers. The range is clipped at the
// request time, as the real readers do when they resolve it. A refusal propagates from the reader. A returned registry is kept on the seam as `registry`
// and the seam then stops the read, so no compute runs in these tests (the worker side is covered in the compute tests).
const accountReader=(budgets,tx)=>{
  const read=async(_store,args)=>{
    read.registry=await readCoverageSnapshot({transaction:tx,accounts:[accountOf(args.botId,args.from,Math.min(args.to,args.requestTime))],budgets});
    throw new Error('the read stops after the registry');
  };
  return read;
};
const ownerReader=(budgets,tx)=>{
  const read=async(_store,args)=>{
    read.registry=await readCoverageSnapshot({transaction:tx,accounts:[accountOf('owner-bot',args.from,Math.min(args.to,args.requestTime))],budgets});
    throw new Error('the read stops after the registry');
  };
  return read;
};
const SHOWS=[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY];
const degradedWith=(registry,limit)=>{
  assert.ok(registry,'a registry was returned');
  assert.deepEqual(registry.unions.map(u=>u.fact),registry.unions.map(()=>({state:'BUDGET_EXCEEDED',limit})));
  assert.equal(registry.charges.timestamp_rows,0);assert.equal(registry.charges.derivation_visits,0);assert.equal(registry.charges.output_intervals,0);
  assert.ok(registry.windows.every(w=>w.stored_minutes===null&&w.interval_count===null&&w.expected_minutes===null),'no count survives a degrade');
};

async function driveAccount(readSnapshot,query='period=DAY'){
  const res={phase2Result:null,phase2Deferred:null};
  const json=(r,status,body)=>{r.phase2Result={status,body};};
  const store={ownsBot:async()=>true,userById:async()=>({id:BOT,parent_user_id:OWNER,created_at:NOW-400*DAY}),activePlan:async()=>'ENTERPRISE',audit:async()=>{}};
  const deps={store,auth:{sensitive:async()=>{}},json,enabled:true,slot:createQr2Slot(),compute:{run:async()=>{throw new Error('compute must not run');}},clock:()=>NOW,readSnapshot};
  await qr2PerformanceRoute({method:'GET',headers:{}},res,new URL('http://localhost/api/paper-performance?bot_id='+BOT+'&'+query),{id:OWNER,permissions:[]},deps);
  assert.equal(res.phase2Result,null,'phase 1 passed: '+JSON.stringify(res.phase2Result));
  assert.equal(typeof res.phase2Deferred,'function');
  return res.phase2Deferred();
}
async function driveOwner(readSnapshot,query='currency=USDT&period=DAY'){
  const res={setHeader(){}};
  const writes=[];
  const store={userById:async id=>({id,parent_user_id:null,created_at:NOW-400*DAY}),activePlan:async()=>'ENTERPRISE'};
  const deps={store,json:(_r,status,body)=>writes.push({status,body}),enabled:true,slot:createQr2Slot(),clock:()=>NOW,readSnapshot,
    compute:{run:async()=>{throw new Error('compute must not run');}}};
  await qr2OwnerPerformanceRoute({method:'GET'},res,new URL('http://localhost/api/paper-performance/owner?'+query),{id:OWNER},deps);
  assert.equal(writes.length,0,'phase 1 passed: '+JSON.stringify(writes));
  return res.phase2Deferred();
}
const drivers=[['per-Bot route',driveAccount,accountReader],['owner route',driveOwner,ownerReader]];

for(const [name,drive,reader] of drivers){
  test(name+': a row cap stop returns a degraded registry after one sentinel read',async()=>{
    const tx=transaction(),read=reader(budgetsOf({timestamp_rows:5}),tx);
    await drive(read);
    degradedWith(read.registry,'timestamp_rows');
    // The sentinel read asked for capacity plus one row and nothing more.
    assert.deepEqual(tx.calls.map(c=>c.sql),[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY,COVERAGE_SQL.PROBE,COVERAGE_SQL.ROWS]);
    assert.equal(tx.calls.find(c=>c.sql===COVERAGE_SQL.ROWS).params[5],6);
  });

  test(name+': a span stop returns a degraded registry after the two SHOW checks and no other query',async()=>{
    const tx=transaction(),read=reader(budgetsOf({union_minutes:100}),tx);
    await drive(read);
    degradedWith(read.registry,'union_minutes');
    assert.ok(read.registry.charges.union_minutes>100);
    assert.deepEqual(tx.calls.map(c=>c.sql),SHOWS,'no probe and no rows query');
  });

  test(name+': the default limits degrade a Month-sized row count and an All-Time-sized span',async()=>{
    const monthTx=transaction(),month=reader(budgetsOf({}),monthTx);
    await drive(month,name==='owner route'?'currency=USDT&period=MONTH':'period=MONTH');
    degradedWith(month.registry,'timestamp_rows');
    const custom='period=CUSTOM&from=2026-08-01&to=2026-10-26',spanTx=transaction(),span=reader(budgetsOf({}),spanTx);
    await drive(span,name==='owner route'?'currency=USDT&'+custom:custom);
    degradedWith(span.registry,'union_minutes');
    assert.ok(span.registry.charges.union_minutes>QR2_COVERAGE_LIMITS.union_minutes);
    assert.deepEqual(spanTx.calls.map(c=>c.sql),SHOWS);
  });

  test(name+': every other reader error class still answers 503 QR2_REPORT_FAILED',async()=>{
    const cases=[
      ['isolation below repeatable read',transaction({isolation:'read committed'}),budgetsOf({})],
      ['read-write transaction',transaction({readOnly:'off'}),budgetsOf({})],
      ['query failure',transaction({fail:sql=>sql===COVERAGE_SQL.ROWS}),budgetsOf({})],
      ['misaligned row',transaction({rowsOf:()=>['60001']}),budgetsOf({})],
      ['invalid budgets',transaction(),budgetsOf({timestamp_rows:0})]
    ];
    for(const [label,tx,budgets] of cases){
      const answer=await drive(reader(budgets,tx));
      assert.equal(answer.status,503,label);
      assert.deepEqual(answer.body,REPORT_FAILED,label);
    }
  });
  // Build-stage and span caps on the reader path. The rows sit inside the requested window so decoding succeeds and the cap, not the data, refuses.
  const inWindow=(step,count)=>(limit,params)=>Array.from({length:Math.min(limit,count,Math.floor((params[4]-params[3])/(step*M)))},(_,i)=>String(params[3]+(i+1)*step*M));
  const refusedWith=(answer,limit,max)=>{
    assert.equal(answer.status,422,JSON.stringify(answer.body));
    assert.equal(answer.body.code,'QR2_RANGE_ADMISSION_REFUSED');assert.equal(answer.body.error,REFUSED_TEXT);
    assert.equal(answer.body.detail.limit,limit);assert.equal(answer.body.detail.max,max);
    for(const key of Object.keys(answer.body.detail))assert.ok(['limit','value','max'].includes(key),key);
    if(answer.body.detail.value!==undefined)assert.ok(Number.isSafeInteger(answer.body.detail.value)&&answer.body.detail.value>max);
  };

  test(name+': derivation_visits stop while building returns a degraded registry',async()=>{
    const tx=transaction({rowsOf:inWindow(1,50)}),read=reader(budgetsOf({derivation_visits:1}),tx);
    await drive(read);
    degradedWith(read.registry,'derivation_visits');
    assert.equal(tx.calls.filter(c=>c.sql===COVERAGE_SQL.ROWS).length,1,'the rows were read, so the stop came from the build');
  });

  test(name+': output_intervals stop while building returns a degraded registry',async()=>{
    const tx=transaction({rowsOf:inWindow(2,50)}),read=reader(budgetsOf({output_intervals:1}),tx);
    await drive(read);
    degradedWith(read.registry,'output_intervals');
    assert.equal(tx.calls.filter(c=>c.sql===COVERAGE_SQL.ROWS).length,1,'the rows were read, so the stop came from the build');
  });

  test(name+': the zero-row byte envelope refusals stay 422 with the limit in the detail',async()=>{
    const output=await drive(reader(budgetsOf({coverage_output_bytes:1500}),transaction({rowsOf:inWindow(1,5)})));
    refusedWith(output,'coverage_output_bytes',1500);
    const input=await drive(reader(budgetsOf({coverage_input_bytes:1500}),transaction({rowsOf:inWindow(1,5)})));
    refusedWith(input,'coverage_input_bytes',1500);
  });

  test(name+': an ALL_TIME request for a Bot older than 30 days degrades to union_minutes before any query beyond the SHOW checks',async()=>{
    const tx=transaction(),read=reader(budgetsOf({}),tx);
    await drive(read,name==='owner route'?'currency=USDT&period=ALL_TIME':'period=ALL_TIME');
    degradedWith(read.registry,'union_minutes');
    assert.ok(read.registry.charges.union_minutes>=400*24*60-1,'the registered span of about 400 days: '+read.registry.charges.union_minutes);
    assert.deepEqual(tx.calls.map(c=>c.sql),SHOWS);
  });

  test(name+': a span stop with a broken transaction answers 503 and returns no degraded registry',async()=>{
    for(const [label,options] of [['isolation below repeatable read',{isolation:'read committed'}],['read-write transaction',{readOnly:'off'}]]){
      const tx=transaction(options),read=reader(budgetsOf({union_minutes:100}),tx),answer=await drive(read);
      assert.equal(answer.status,503,label);assert.deepEqual(answer.body,REPORT_FAILED,label);
      assert.equal(read.registry,undefined,label);
    }
  });

  test(name+': a zero-row byte refusal beside a span stop keeps 422 and issues no query',async()=>{
    const tx=transaction();
    const bytes=await drive(reader(budgetsOf({union_minutes:100,coverage_output_bytes:1500}),tx));
    refusedWith(bytes,'coverage_output_bytes',1500);
    assert.equal(tx.calls.length,0,'a plan-time byte refusal beside a span stop issues no query');
  });

  test(name+': a driver result over a LIMIT is a corrupt result and answers 503 QR2_REPORT_FAILED, never 422',async()=>{
    for(const sql of [COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY,COVERAGE_SQL.PROBE]){
      const answer=await drive(reader(budgetsOf({}),transaction({over:sql})));
      assert.equal(answer.status,503,sql);assert.deepEqual(answer.body,REPORT_FAILED,sql);
    }
    // The row query asked for capacity plus one row; one row more than that comes from a driver that ignored its LIMIT.
    const answer=await drive(reader(budgetsOf({timestamp_rows:5}),transaction({rowsOf:(limit,params)=>Array.from({length:limit+1},(_,i)=>String(params[3]+(i+1)*M))})));
    assert.equal(answer.status,503);assert.deepEqual(answer.body,REPORT_FAILED);
  });
}

const attempt=async(budgets,tx,accounts=[accountOf('a',0,3*M)])=>{try{return await readCoverageSnapshot({transaction:tx,accounts,budgets});}catch(error){return error;}};
const expectDegraded=(registry,limit)=>{assert.equal(registry instanceof Error,false,String(registry));degradedWith(registry,limit);};

test('the reader error is a Qr2Error only for a non-degradable read-limit refusal; every other code keeps its plain Error',async()=>{
  const windows=await attempt(budgetsOf({unique_windows:1}),transaction(),[accountOf('a',0,3*M),accountOf('b',0,4*M)]);
  assert.ok(windows instanceof Qr2Error);assert.equal(windows.code,'QR2_RANGE_ADMISSION_REFUSED');assert.deepEqual(windows.detail,{limit:'unique_windows',value:2,max:1});
  const input=await attempt(budgetsOf({coverage_input_bytes:1500}),transaction());
  assert.ok(input instanceof Qr2Error);assert.deepEqual(input.detail,{limit:'coverage_input_bytes',value:input.detail.value,max:1500});
  const failed=await attempt(budgetsOf({}),transaction({isolation:'read committed'}));
  assert.equal(failed instanceof Qr2Error,false);assert.equal(failed.name,'Error');assert.equal(failed.code,'QR2_REPORT_FAILED');
  const invalid=await attempt(budgetsOf({timestamp_rows:0}),transaction());
  assert.equal(invalid instanceof Qr2Error,false);assert.equal(invalid.code,'QR2_INPUT_INVALID');
  // The degradable stops are results, not errors.
  expectDegraded(await attempt(budgetsOf({timestamp_rows:2}),transaction()),'timestamp_rows');
  expectDegraded(await attempt(budgetsOf({union_minutes:2}),transaction()),'union_minutes');
});

test('the reader throws a plain QR2_REPORT_FAILED for a driver result over a one-row LIMIT; the timestamp sentinel degrades',async()=>{
  for(const sql of [COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY,COVERAGE_SQL.PROBE]){
    const error=await attempt(budgetsOf({}),transaction({over:sql}));
    assert.equal(error instanceof Qr2Error,false,sql);assert.equal(error.name,'Error',sql);assert.equal(error.code,'QR2_REPORT_FAILED',sql);assert.equal(error.detail,undefined,sql);
  }
  const ignored=await attempt(budgetsOf({timestamp_rows:2}),transaction({rowsOf:(limit,params)=>Array.from({length:limit+1},(_,i)=>String(params[3]+(i+1)*M))}),[accountOf('a',0,10*M)]);
  assert.equal(ignored instanceof Qr2Error,false);assert.equal(ignored.code,'QR2_REPORT_FAILED');
  expectDegraded(await attempt(budgetsOf({timestamp_rows:2}),transaction()),'timestamp_rows');
});

test('query sequences are pinned for a span stop, a broken transaction and a non-degradable plan refusal',async()=>{
  const sequence=async(budgets,tx,accounts)=>{const result=await attempt(budgets,tx,accounts);return {result,sql:tx.calls.map(c=>c.sql)};};
  const span=await sequence(budgetsOf({union_minutes:2}),transaction());
  expectDegraded(span.result,'union_minutes');assert.deepEqual(span.sql,[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY]);
  const nonRepeatable=await sequence(budgetsOf({union_minutes:2}),transaction({isolation:'read committed'}));
  assert.equal(nonRepeatable.result.code,'QR2_REPORT_FAILED');assert.equal(nonRepeatable.result instanceof Qr2Error,false);assert.deepEqual(nonRepeatable.sql,[COVERAGE_SQL.ISOLATION]);
  const readWrite=await sequence(budgetsOf({union_minutes:2}),transaction({readOnly:'off'}));
  assert.equal(readWrite.result.code,'QR2_REPORT_FAILED');assert.equal(readWrite.result instanceof Qr2Error,false);assert.deepEqual(readWrite.sql,[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY]);
  const broken=transaction({isolation:'read committed'});
  const windows=await sequence(budgetsOf({unique_windows:1,union_minutes:2}),broken,[accountOf('a',0,3*M),accountOf('b',0,4*M)]);
  assert.ok(windows.result instanceof Qr2Error);assert.equal(windows.result.detail.limit,'unique_windows');assert.deepEqual(windows.sql,[],'unique_windows keeps the plan-first precedence: no query');
  const notTransaction=transaction();notTransaction.isTransaction=false;
  const missing=await sequence(budgetsOf({union_minutes:2}),notTransaction);
  assert.equal(missing.result.code,'QR2_REPORT_FAILED');assert.deepEqual(missing.sql,[]);
  // A plan-time byte refusal beside a span stop raises its own refusal with no query (the degraded registry is built before any check).
  const bytes=await sequence(budgetsOf({union_minutes:2,coverage_output_bytes:200}),transaction());
  assert.ok(bytes.result instanceof Qr2Error);assert.equal(bytes.result.detail.limit,'coverage_output_bytes');assert.deepEqual(bytes.sql,[]);
});

test('C7 before C6: a span stop with the market-data table absent degrades without a probe; within the span an absent table is still TABLE_ABSENT',async()=>{
  const tx=transaction({table:null});
  expectDegraded(await attempt(budgetsOf({union_minutes:2}),tx),'union_minutes');
  assert.deepEqual(tx.calls.map(c=>c.sql),[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY],'the table probe never runs for a span stop');
  const within=transaction({table:null}),registry=await attempt(budgetsOf({}),within);
  assert.deepEqual(registry.unions.map(u=>u.fact),[{state:'TABLE_ABSENT'}]);
  assert.deepEqual(within.calls.map(c=>c.sql),[COVERAGE_SQL.ISOLATION,COVERAGE_SQL.READ_ONLY,COVERAGE_SQL.PROBE]);
});

test('a data-time output byte stop degrades; a zero-row byte refusal does not',async()=>{
  const accounts=[accountOf('a',0,2000*M)];
  const zero=buildDegradedCoverageSnapshot({accounts,budgets:budgetsOf({union_minutes:10}),limit:'union_minutes'}).charges.output_bytes_upper_bound;
  const rowsOf=(limit,params)=>Array.from({length:Math.min(limit,300)},(_,i)=>String(params[3]+(i+1)*2*M));
  const registry=await attempt(budgetsOf({coverage_output_bytes:zero+200}),transaction({rowsOf}),accounts);
  expectDegraded(registry,'coverage_output_bytes');
  const refused=await attempt(budgetsOf({coverage_output_bytes:zero-1}),transaction({rowsOf}),accounts);
  assert.ok(refused instanceof Qr2Error);assert.equal(refused.detail.limit,'coverage_output_bytes');
});

test('status guard: a plain coverage Error answers 503 whatever its code; only a Qr2Error carries a request refusal',()=>{
  const plain=code=>Object.assign(new Error(code),{code});
  for(const code of ['QR2_RANGE_ADMISSION_REFUSED','QR2_REPORT_FAILED','QR2_INPUT_INVALID']){
    for(const phase of [1,2]){const answer=answerOfError(plain(code),phase);assert.equal(answer.status,503,code);assert.deepEqual(answer.body,REPORT_FAILED,code);}
  }
  // A Qr2Error mapping is unchanged by this fix (contract 10).
  const table=[['QR2_NOT_OWNER',404],['QR2_RANGE_INVALID',400],['QR2_INPUT_INVALID',400],['QR2_FEE_OVERLAY_REFUSED',400],['QR2_CURRENCY_MIX',422],['QR2_REPORT_FAILED',503],['QR2_RESPONSE_INVALID',503],['QR2_UNKNOWN',503]];
  for(const [code,status] of table)assert.equal(answerOfError(new Qr2Error(code)).status,status,code);
  assert.equal(answerOfError(new Qr2Error('QR2_INPUT_INVALID'),2).status,503);
  const admission=(detail)=>Object.assign(new Qr2Error('QR2_RANGE_ADMISSION_REFUSED'),{detail});
  assert.equal(answerOfError(admission({limit:'timestamp_rows',max:5}),2).status,422);
  assert.equal(answerOfError(admission({limit:'history_days',max:30}),2).status,403);
  assert.equal(answerOfError(admission({limit:'concurrency',max:1}),2).status,429);
  assert.equal(answerOfError(admission(undefined),2).status,422);
  assert.equal(refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'union_minutes',value:3,max:2,secret:'x'}).body.detail.secret,undefined);
});

test('worker path unchanged: planCoverage and the projection throw plain Errors that never become a request refusal',()=>{
  const accounts=[accountOf('a',0,3*M)];
  const registry=buildCoverageSnapshot({accounts,budgets:budgetsOf({}),facts:[{state:'COMPLETE',timestamps:[M]}]});
  const tiny={accounts,budgets:budgetsOf({coverage_output_bytes:100})};
  const windows={accounts:[accountOf('a',0,3*M),accountOf('b',0,4*M)],budgets:budgetsOf({unique_windows:1})};
  for(const context of [tiny,windows]){
    try{projectPublicCoverageOutcome(registry,context);assert.fail('expected a throw');}
    catch(error){assert.equal(error instanceof Qr2Error,false);assert.equal(error.name,'Error');assert.equal(error.code,'QR2_RANGE_ADMISSION_REFUSED');assert.equal(answerOfError(error,2).status,503);}
  }
  try{planCoverage(windows);assert.fail('expected a throw');}
  catch(error){assert.equal(error instanceof Qr2Error,false);assert.equal(error.name,'Error');assert.deepEqual(error.detail,{limit:'unique_windows',value:2,max:1});}
});