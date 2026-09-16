import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticsWindow,fifoClosedPositions,groupClosedPositions,summarizeClosedPositions,currencyForBroker} from '../src/analytics.js';

const fill=(tradeId,side,quantity,price,receivedAt,symbol='BTCUSDT',broker='binance-global',fee=0)=>({trade_id:tradeId,side,quantity,price,received_at:receivedAt,symbol,broker,signal_id:receivedAt,cumulative_quantity:quantity,fee_quote:fee});

test('FIFO closes round trips with weighted entry, fees and holding time',()=>{
  const rows=[fill('b1','BUY',1,100,1000),fill('b2','BUY',2,110,2000),fill('s1','SELL',2,130,5000)];
  const [closed]=fifoClosedPositions(rows,{feeBps:10});
  assert.equal(closed.quantity,2);assert.equal(closed.entryPrice,105);assert.equal(closed.grossPnl,50);
  assert.equal(closed.fees,.47);assert.equal(closed.netPnl,49.53);assert.equal(closed.holdingMs,3500);
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
