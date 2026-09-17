import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsWindow,fifoClosedPositions,fifoRealizations,fifoAnalytics,analyticsCapital,groupClosedPositions,summarizeClosedPositions,currencyForBroker} from '../src/analytics.js';

const fill=(tradeId,side,quantity,price,receivedAt,symbol='BTCUSDT',broker='binance-global',fee=0)=>({trade_id:tradeId,side,quantity,price,received_at:receivedAt,symbol,broker,signal_id:receivedAt,cumulative_quantity:quantity,fee_quote:fee});

test('FIFO realizes partial exits with weighted entry, fees and holding time without completing a round trip',()=>{
  const rows=[fill('b1','BUY',1,100,1000),fill('b2','BUY',2,110,2000),fill('s1','SELL',2,130,5000)];
  const [closed]=fifoRealizations(rows,{feeBps:10});
  assert.equal(fifoClosedPositions(rows).length,0);
  assert.equal(closed.quantity,2);assert.equal(closed.entryPrice,105);assert.equal(closed.grossPnl,50);
  assert.equal(closed.fees,.47);assert.equal(closed.netPnl,49.53);assert.equal(closed.holdingMs,3500);
});

test('round trips count only flat-to-flat; partial losses remain visible before the final close',()=>{
  const rows=[fill('b1','BUY',1,100,1000),fill('b2','BUY',1,110,2000),fill('s1','SELL',.5,90,3000)];
  const partial=fifoAnalytics(rows);
  const metrics=summarizeClosedPositions(partial.closedPositions,{startingEquity:1000,realizations:partial.realizations});
  assert.equal(metrics.totalTrades,0);assert.equal(metrics.netProfit,-5);assert.equal(metrics.maxDrawdown,-5);
  rows.push(fill('s2','SELL',1.5,120,4000));
  const all=fifoAnalytics(rows),summary=summarizeClosedPositions(all.closedPositions,{startingEquity:1000,realizations:all.realizations});
  assert.equal(summary.totalTrades,1);assert.equal(summary.wins,1);assert.equal(summary.netProfit,15);assert.equal(summary.maxDrawdown,-5);
  assert.equal(all.closedPositions[0].quantity,2);assert.equal(all.closedPositions[0].entryPrice,105);
});

test('analytics percent basis uses historical funding and does not change after future capital edits',()=>{
  const rows=[fill('b','BUY',1,100,20),fill('s','SELL',1,110,30)];
  const realized=fifoRealizations(rows),funding=[{at:10,equity_delta:1000,kind:'CONFIGURATION'}];
  const window={from:0,to:40},before=analyticsCapital(funding,realized,rows,window);
  funding.push({at:50,equity_delta:2000,kind:'CONFIGURATION'});
  assert.deepEqual(analyticsCapital(funding,realized,rows,window),before);assert.equal(before.startingEquity,1000);
  assert.equal(analyticsCapital(funding,realized,rows,{from:40,to:60}).percentagesAvailable,false);
  const legacy=analyticsCapital([{at:50,equity_delta:1000,kind:'LEGACY_BASELINE'}],realized,rows,window);
  assert.equal(legacy.startingEquity,null);assert.equal(legacy.percentagesAvailable,false);
  const unknown=summarizeClosedPositions(fifoClosedPositions(rows),{...legacy,realizations:realized});
  assert.equal(unknown.netProfit,10);assert.equal(unknown.netProfitPercent,null);assert.equal(unknown.maxDrawdownPercent,null);
});

test('FIFO rejects unmatched sells and isolates identical symbols across users',()=>{
  assert.throws(()=>fifoAnalytics([fill('s','SELL',1,100,1000)]),/exceeds recorded FIFO/);
  const rows=[{...fill('a','BUY',1,100,1000),user_id:'a'}, {...fill('b','SELL',1,100,2000),user_id:'b'}];
  assert.throws(()=>fifoAnalytics(rows),/exceeds recorded FIFO/);
});

test('analytics metrics are zero-safe and compute MDD, streaks and realized R:R',()=>{
  const empty=summarizeClosedPositions([],{startingEquity:0});
  assert.equal(empty.totalTrades,0);assert.equal(empty.winRate,0);assert.equal(empty.profitFactor,null);assert.equal(empty.maxDrawdownPercent,null);
  const rows=[100,-40,-80,50].map((netPnl,index)=>({netPnl,fees:index+1,holdingMs:1000,exitAt:index+1}));
  const out=summarizeClosedPositions(rows,{startingEquity:1000});
  assert.equal(out.netProfit,30);assert.equal(out.profitFactor,1.25);assert.equal(out.maxDrawdown,-120);assert.equal(out.maxDrawdownPercent,-10.90909091);
  assert.equal(out.maxConsecutiveLosses,2);assert.equal(out.avgWinLossRatio,1.25);assert.equal(out.feeImpact,10);
});

test('date windows and grouping are deterministic UTC',()=>{
  const now=Date.parse('2026-09-17T12:00:00Z'),window=analyticsWindow('weekly',null,null,now);
  assert.equal(window.fromDate,'2026-09-11');assert.equal(window.toDate,'2026-09-17');
  const rows=[{netPnl:1,fees:0,holdingMs:1,exitAt:Date.parse('2026-09-14T01:00:00Z')},{netPnl:2,fees:0,holdingMs:1,exitAt:Date.parse('2026-09-17T01:00:00Z')}];
  assert.deepEqual(groupClosedPositions(rows,'weekly',{startingEquity:100}).map(x=>x.bucket),['2026-09-14']);
  assert.throws(()=>analyticsWindow('custom','2026-10-01','2026-09-01',now),/Invalid analytics date range/);
});

test('broker currency mapping never combines USDT and THB',()=>{
  assert.equal(currencyForBroker('binance-global'),'USDT');
  for(const broker of ['binance-th','innovestx','settrade'])assert.equal(currencyForBroker(broker),'THB');
});
