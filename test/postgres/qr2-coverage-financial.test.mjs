import test from 'node:test';
import assert from 'node:assert/strict';
import {createQr2Database,createOwner,createBot,book,insertBars,barOf,ledgerDigest,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {readQr2Snapshot} from '../../src/postgres/qr2-reader.js';
import {createQr2ComputePool} from '../../src/postgres/qr2-compute-pool.js';
import {validateResponse} from '../../src/portfolio/qr2-labels.js';
import {buildBarCoverage} from '../../src/portfolio/qr2-coverage.js';
const MINUTE=60000,DAY=86400000;
const stableBody=body=>{const copy=structuredClone(body);copy.reader.read_ms=0;copy.reader.compute_ms=0;delete copy.market_data.coverage;return copy;};
const coverageOf=read=>{
  const registry=read.snapshot.coverage,window=registry.windows[read.snapshot.coverage_window_id],union=registry.unions[window.union_id];
  assert.equal(union.fact.state,'COMPLETE');
  return buildBarCoverage({market:window.market,resolved_range:window.resolved_range,fact:{state:'COMPLETE',timestamps:union.fact.timestamps.slice(window.start_index,window.end_index)}});
};

test('coverage financial differential: unused interior timestamp changes coverage only through the actual worker',{timeout:45000},async()=>{
  const fixture=await createQr2Database('robot_qr2_coverage_financial');
  const pool=createQr2ComputePool();
  try{
    const {db,store}=fixture,owner=await createOwner(store),bot=await createBot(store,owner,10000);
    // Existing live recordExecution producer: no fixture rewrites of funding/fill timestamps or amounts.
    await book(store,bot,'coverage-financial-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
    await book(store,bot,'coverage-financial-partial-sell',{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
    const fills=(await db.query('SELECT f.received_at FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 ORDER BY f.received_at',[bot.id])).rows;
    assert.equal(fills.length,2);
    const from=Number(bot.created_at),lastFill=Math.max(...fills.map(f=>Number(f.received_at)));
    assert.ok(Number.isSafeInteger(from)&&Number.isSafeInteger(lastFill)&&lastFill>=from);
    // Explicit synthetic reporting clock six closed minutes beyond the actual last fill.
    // The database, funding chronology, fill chronology and worker deadline remain unchanged.
    const to=Math.ceil(lastFill/MINUTE)*MINUTE+6*MINUTE,requestTime=to;
    assert.ok(fills.every(f=>Number(f.received_at)>=from&&Number(f.received_at)<to));
    const firstBar=Math.floor(from/MINUTE)*MINUTE-MINUTE;
    const barTimes=[];for(let t=firstBar;t<=to;t+=MINUTE)barTimes.push(t);
    assert.ok(barTimes.length>=8&&barTimes.length<=100,'bounded synthetic source recipe');
    await insertBars(db,barTimes.map(t=>barOf(t,'62000')));
    const args={ownerId:owner.id,botId:bot.id,broker:'binance-global',from,to,requestTime,boundaries:LOCAL_FIXTURE_E2};
    const digestBefore=await ledgerDigest(db,bot);
    const before=await readQr2Snapshot(store,args);
    assert.equal(before.snapshot.market.checked,true);
    assert.ok(before.snapshot.market.rows.length>0);
    const fullFrom=Math.ceil(from/MINUTE)*MINUTE,expectedMinutes=(to-fullFrom)/MINUTE;
    const coveredTimes=barTimes.filter(t=>t>fullFrom&&t<=to);
    assert.equal(coveredTimes.length,expectedMinutes);
    assert.deepEqual(before.snapshot.coverage.unions[0].fact.timestamps,coveredTimes);
    const full=coverageOf(before);
    assert.deepEqual([full.state,full.expected_minutes,full.stored_minutes,full.missing_minutes],['COMPLETE',expectedMinutes,expectedMinutes,0]);
    assert.deepEqual(full.intervals,[]);

    // Independently enumerate every valuation instant and ask PostgreSQL for each predecessor.
    const instants=new Set([from,to]);
    for(let t=Math.floor(from/DAY)*DAY+DAY;t<to;t+=DAY)instants.add(t);
    for(const fill of before.snapshot.fills)if(Number(fill.received_at)>=from&&Number(fill.received_at)<to)instants.add(Number(fill.received_at));
    for(const funding of before.snapshot.fundings)if(funding.kind==='CONFIGURATION'&&Number(funding.at)>=from&&Number(funding.at)<to)instants.add(Number(funding.at));
    assert.equal(instants.size,before.snapshot.market.instants);
    const predecessors=(await db.query(`SELECT DISTINCT (SELECT max(b.bar_time) FROM public.pine_market_bars b
      WHERE b.broker='binance-global' AND b.symbol='BTCUSDT' AND b.timeframe='1' AND b.bar_time<=t.instant) AS bar_time
      FROM unnest($1::bigint[]) AS t(instant)`,[[...instants]])).rows.map(r=>Number(r.bar_time)).sort((a,b)=>a-b);
    const selected=before.snapshot.market.rows.map(r=>Number(r.bar_time)).sort((a,b)=>a-b);
    assert.deepEqual(selected,predecessors);
    const removed=[to-4*MINUTE,to-3*MINUTE,to-2*MINUTE].find(t=>!predecessors.includes(t));
    assert.ok(Number.isSafeInteger(removed),'fixture must supply an unused interior timestamp; never skip');
    assert.ok(removed>fullFrom&&removed<to&&removed-MINUTE>=fullFrom);
    assert.ok(coveredTimes.includes(removed)&&!selected.includes(removed));

    const first=await pool.run(before.snapshot,before.input);
    assert.equal(first.ok,true,JSON.stringify(first));
    assert.equal(validateResponse(first.body).ok,true);
    assert.deepEqual(first.body.market_data.coverage,coverageOf(before),'COMPLETE coverage with no interval before the deletion');
    const a=first.body.account;
    assert.deepEqual([a.cash.value,a.nav.value,a.market_value.value,a.position_cost.value,a.realized_pnl.value,a.unrealized_pnl.value,a.fees.value,a.money_pnl.value,a.twr.value],
      ['9644','10016','372','360','4','12','0','16','0.0016']);
    // The only source mutation: one exact synthetic market row, never a ledger mutation.
    const deletion=await db.query("DELETE FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1 RETURNING bar_time",[removed]);
    assert.deepEqual(deletion.rows.map(r=>Number(r.bar_time)),[removed]);
    const after=await readQr2Snapshot(store,args);
    assert.deepEqual(after.snapshot.coverage.unions[0].fact.timestamps,coveredTimes.filter(t=>t!==removed));
    const gap=coverageOf(after);
    assert.deepEqual([gap.state,gap.expected_minutes,gap.stored_minutes,gap.missing_minutes],['COMPLETE',expectedMinutes,expectedMinutes-1,1]);
    assert.deepEqual(gap.intervals,[{from:removed-MINUTE,to:removed,missing_minutes:1}]);
    assert.deepEqual(after.input.coverage_context,before.input.coverage_context);
    assert.deepEqual(after.snapshot.market,before.snapshot.market,'all valuation rows, instants and cutoff remain identical');
    assert.deepEqual(after.snapshot.cutoffs,before.snapshot.cutoffs);
    const second=await pool.run(after.snapshot,after.input);
    assert.equal(second.ok,true,JSON.stringify(second));
    assert.equal(validateResponse(second.body).ok,true);
    assert.deepEqual(second.body.market_data.coverage,coverageOf(after),'exactly one one-minute interval at the removed bar');
    assert.deepEqual(stableBody(second.body),stableBody(first.body),'whole financial response differs only in the two established reader timers');
    assert.deepEqual(second.auditFindings,first.auditFindings);
    assert.deepEqual(await ledgerDigest(db,bot),digestBefore,'all ledger/audit/fence tables unchanged');
    assert.equal(pool.counters.completed,2);
    assert.equal(pool.counters.timeout+pool.counters.crash+pool.counters.spawn,0);
  }finally{
    try{await pool.close();}finally{await fixture.dispose();}
  }
});

test('coverage degrade differential (spec D item 9): lowering a degradable coverage budget changes only market_data.coverage, never a financial field',{timeout:45000},async()=>{
  const fixture=await createQr2Database('robot_qr2_coverage_degrade_fin');
  const pool=createQr2ComputePool();
  try{
    const {db,store}=fixture,owner=await createOwner(store),bot=await createBot(store,owner,10000);
    await book(store,bot,'coverage-degrade-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
    await book(store,bot,'coverage-degrade-partial-sell',{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
    const fills=(await db.query('SELECT f.received_at FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 ORDER BY f.received_at',[bot.id])).rows;
    assert.equal(fills.length,2);
    const from=Number(bot.created_at),lastFill=Math.max(...fills.map(f=>Number(f.received_at)));
    const to=Math.ceil(lastFill/MINUTE)*MINUTE+6*MINUTE,requestTime=to;
    const firstBar=Math.floor(from/MINUTE)*MINUTE-MINUTE;
    const barTimes=[];for(let t=firstBar;t<=to;t+=MINUTE)barTimes.push(t);
    assert.ok(barTimes.length>=8&&barTimes.length<=100,'bounded synthetic source recipe');
    await insertBars(db,barTimes.map(t=>barOf(t,'62000')));
    const args={ownerId:owner.id,botId:bot.id,broker:'binance-global',from,to,requestTime,boundaries:LOCAL_FIXTURE_E2};
    const digestBefore=await ledgerDigest(db,bot);

    // Default budgets: coverage completes. Lowered timestamp_rows (the existing test seam; it can only lower a limit): the read stops and the registry degrades.
    const normal=await readQr2Snapshot(store,args);
    const lowered=await readQr2Snapshot(store,{...args,coverageBudgets:{timestamp_rows:2}});
    assert.equal(normal.snapshot.coverage.unions[0].fact.state,'COMPLETE');
    assert.deepEqual(lowered.snapshot.coverage.unions.map(u=>u.fact),[{state:'BUDGET_EXCEEDED',limit:'timestamp_rows'}]);
    // The financial rows read and the valuation inputs do not depend on the coverage outcome.
    assert.deepEqual(lowered.snapshot.market,normal.snapshot.market);
    assert.deepEqual(lowered.snapshot.fills,normal.snapshot.fills);
    assert.deepEqual(lowered.snapshot.fundings,normal.snapshot.fundings);
    assert.deepEqual(lowered.snapshot.range,normal.snapshot.range);

    const full=await pool.run(normal.snapshot,normal.input);
    const degraded=await pool.run(lowered.snapshot,lowered.input);
    assert.equal(full.ok,true,JSON.stringify(full));
    assert.equal(degraded.ok,true,JSON.stringify(degraded));
    assert.equal(validateResponse(full.body).ok,true);
    assert.equal(validateResponse(degraded.body).ok,true);
    assert.equal(full.body.market_data.coverage.state,'COMPLETE');

    // Financial equality: the whole body is equal once the coverage object is removed (and the two reader timers are zeroed).
    assert.deepEqual(stableBody(degraded.body),stableBody(full.body),'every financial field and status is equal with and without the degrade');
    assert.deepEqual(degraded.auditFindings,full.auditFindings);
    const a=degraded.body.account;
    assert.deepEqual([a.cash.value,a.nav.value,a.market_value.value,a.position_cost.value,a.realized_pnl.value,a.unrealized_pnl.value,a.fees.value,a.money_pnl.value,a.twr.value],
      ['9644','10016','372','360','4','12','0','16','0.0016'],'the same absolute values as the complete-coverage run');

    // The degraded coverage is exactly the C7 object: same head as the complete object, every count and the interval list null, one reason.
    const c=degraded.body.market_data.coverage,k=full.body.market_data.coverage;
    const window=lowered.snapshot.coverage.windows[lowered.snapshot.coverage_window_id];
    assert.deepEqual(c,buildBarCoverage({market:window.market,resolved_range:window.resolved_range,fact:{state:'BUDGET_EXCEEDED'}}));
    assert.deepEqual([c.state,c.reason,c.complete,c.expected_minutes,c.stored_minutes,c.missing_minutes,c.interval_count,c.intervals],['UNAVAILABLE','COVERAGE_BUDGET_EXCEEDED',false,null,null,null,null,null]);
    assert.deepEqual(c.inspected_window,k.inspected_window);
    assert.deepEqual(c.resolved_range,k.resolved_range);
    assert.deepEqual(c.excluded_edges,k.excluded_edges);
    assert.deepEqual(c.market,k.market);
    assert.deepEqual(await ledgerDigest(db,bot),digestBefore,'all ledger/audit/fence tables unchanged');
    assert.equal(pool.counters.completed,2);
    assert.equal(pool.counters.timeout+pool.counters.crash+pool.counters.spawn,0);
  }finally{
    try{await pool.close();}finally{await fixture.dispose();}
  }
});
