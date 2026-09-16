import test from 'node:test';import assert from 'node:assert/strict';import {evaluateRisk} from '../src/risk.js';
const policy={maxRiskPercent:1,maxOrderNotional:10000,maxDailyNotional:50000,maxTradesPerDay:10,maxDailyLossR:3,maxOpenPositions:3,onePositionPerSymbol:true,pauseAfterLossStreak:3,maxSignalAgeSeconds:60,maxVolatilityPercent:5,blockHighVolatility:true,blockDuringNews:true,sideMode:'BOTH',requireReduceOnlySell:true,allowedSymbols:[]};
const signal={tradeId:'t',broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',timestamp:Date.now(),riskMode:'PERCENT_EQUITY',riskValue:1,referencePrice:60000,stopLoss:59000,takeProfit:65000,leverage:1,volatilityPercent:0,newsRisk:false};
const ctx={policy,daily:{trades:0,notional:0,realized_r:0,loss_streak:0},position:{quantity:0},equity:10000,licensed:true,globalKill:false,openPositions:0,hasPendingOrder:false};
test('calculates percent equity size',()=>{const r=evaluateRisk(signal,ctx);assert.equal(r.ok,true);assert.equal(r.order.quantity,.1);});
test('explicit quantity and fixed notional cannot bypass max risk',()=>{
  for(const sizing of [{quantity:1},{riskMode:'QUANTITY',riskValue:1},{riskMode:'FIXED_NOTIONAL',riskValue:60000}])
    assert.match(evaluateRisk({...signal,...sizing},ctx).reason,/risk percent/i);
  assert.match(evaluateRisk({...signal,quantity:.01,stopLoss:undefined},ctx).reason,/stop_loss/);
});
test('entry guards fail closed on absent data and protect pending exits',()=>{
  assert.match(evaluateRisk({...signal,volatilityPercent:undefined},ctx).reason,/Missing volatility/);
  assert.match(evaluateRisk({...signal,newsRisk:undefined},ctx).reason,/Missing news/);
  assert.equal(evaluateRisk({...signal,side:'SELL',reduceOnly:true},{...ctx,position:{quantity:1},hasPendingOrder:true}).ok,false);
});
test('pause entries and expired license still allow reduce-only exits',()=>{
  assert.equal(evaluateRisk({...signal,side:'SELL',reduceOnly:true},{...ctx,licensed:false,globalKill:true,position:{quantity:.01},policy:{...policy,killSwitch:true,allowedSymbols:['OTHER']}}).ok,true);
});
test('quote currency and already committed capital are checked',()=>{
  assert.match(evaluateRisk({...signal,symbol:'ETHBTC'},ctx).reason,/quote currency/);
  assert.match(evaluateRisk(signal,{...ctx,committedNotional:9000}).reason,/equity/);
});
test('blocks license, loss streak, volatility, news, and max positions',()=>{assert.match(evaluateRisk(signal,{...ctx,licensed:false}).reason,/License/);assert.match(evaluateRisk(signal,{...ctx,daily:{...ctx.daily,loss_streak:3}}).reason,/loss streak/);assert.match(evaluateRisk({...signal,volatilityPercent:6},ctx).reason,/volatility/);assert.match(evaluateRisk({...signal,newsRisk:true},ctx).reason,/News/);assert.match(evaluateRisk(signal,{...ctx,openPositions:3}).reason,/open positions/);});
test('TP or SL without quantity closes the full Spot position',()=>{const exit={...signal,event:'TP',side:'SELL',reduceOnly:true,quantity:undefined,quoteQuantity:undefined,riskMode:'PERCENT_EQUITY'},r=evaluateRisk(exit,{...ctx,position:{quantity:.025,avg_price:59000}});assert.equal(r.ok,true);assert.equal(r.order.quantity,.025);});
test('risk-reducing Spot exits bypass entry and daily notional limits',()=>{const exit={...signal,event:'SL',side:'SELL',reduceOnly:true,quantity:undefined,riskMode:'QUANTITY'},strict={...ctx,policy:{...policy,maxOrderNotional:1,maxDailyNotional:1,sideMode:'BUY_ONLY'},daily:{...ctx.daily,trades:99,notional:999999,loss_streak:99,realized_r:-99},position:{quantity:.02,avg_price:59000}};assert.equal(evaluateRisk(exit,strict).ok,true);});
test('USD allowlist aliases match USDT equity without bypassing capital limits',()=>{
  const context={...ctx,policy:{...policy,maxRiskPercent:100,allowedSymbols:['BTCUSD']}};
  assert.equal(evaluateRisk(signal,context).ok,true);
  assert.match(evaluateRisk({...signal,quantity:1},context).reason,/equity/);
});
test('opt-in Percent Equity sizing caps to free equity, order and daily budgets',()=>{
  const s={...signal,referencePrice:75992.88,stopLoss:75958.38,takeProfit:80000,riskValue:.5};
  const c={...ctx,policy:{...policy,capPercentEquitySize:true,maxOrderNotional:10000,maxDailyNotional:5000}};
  const result=evaluateRisk(s,c);
  assert.equal(result.ok,true);assert.ok(result.order.notional<=5000);
  assert.ok(result.order.sizingAdjustment.requestedQuantity>result.order.quantity);
  const used=evaluateRisk(s,{...c,committedNotional:9800});
  assert.equal(used.ok,true);assert.ok(used.order.notional<=200);
  const reserved=evaluateRisk(s,{...c,reservedNotional:4900});
  assert.equal(reserved.ok,true);assert.ok(reserved.order.notional<=100);
  assert.equal(evaluateRisk(s,{...c,committedNotional:10000}).ok,false);
  assert.match(evaluateRisk({...s,quantity:1},c).reason,/equity/);
  assert.match(evaluateRisk(s,{...c,policy:{...c.policy,capPercentEquitySize:false}}).reason,/equity/);
  assert.equal(evaluateRisk({...s,newsRisk:true},c).ok,false);
});
test('Spot Balance caps automatic sizing and rejects oversized explicit quantity',()=>{
  const s={...signal,referencePrice:100,stopLoss:99,takeProfit:110,riskValue:50};
  const c={...ctx,equity:10000,balance:1200,policy:{...policy,maxRiskPercent:100,maxOrderNotional:10000,maxDailyNotional:100000,capPercentEquitySize:true}};
  const result=evaluateRisk(s,c);
  assert.equal(result.ok,true);assert.ok(result.order.notional<=1200);
  assert.equal(result.order.sizingAdjustment.reason,'Capped to available equity and notional limits');
  assert.match(evaluateRisk({...s,quantity:20},c).reason,/balance/);
});
