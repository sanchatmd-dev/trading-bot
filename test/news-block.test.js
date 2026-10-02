import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRisk as legacy} from '../src/risk.js';
import {evaluateRisk as postgres} from '../src/postgres/risk.js';

// The news block rejects a new entry only inside an active news window (newsRisk===true). The same vectors run on both
// Node evaluators; quant_lab/tests/test_parity_risk.py and test_node_direct_parity.py hold the Python side of the contract.
const now=Date.UTC(2024,0,1);
const policy={maxRiskPercent:5,maxOrderNotional:100000,maxDailyNotional:500000,maxTradesPerDay:10,maxDailyLossR:3,maxOpenPositions:3,onePositionPerSymbol:false,
  pauseAfterLossStreak:3,maxSignalAgeSeconds:60,maxVolatilityPercent:5,blockHighVolatility:true,blockDuringNews:true,sideMode:'BOTH',requireReduceOnlySell:true,allowedSymbols:[]};
const buy={tradeId:'t',broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',timestamp:now,riskMode:'PERCENT_EQUITY',riskValue:1,
  referencePrice:60000,stopLoss:59000,takeProfit:65000,leverage:1,volatilityPercent:0};
const exit={tradeId:'x',broker:'binance-global',symbol:'BTCUSDT',event:'SELL',side:'SELL',orderType:'MARKET',timestamp:now,riskMode:'QUANTITY',quantity:0.01,referencePrice:61000,
  leverage:1,volatilityPercent:0,reduceOnly:true};
const context=(extra={})=>({policy,daily:{trades:0,notional:0,realized_r:0,loss_streak:0},position:{quantity:0},equity:10000,licensed:true,globalKill:false,openPositions:0,
  hasPendingOrder:false,now,...extra});
const open=(extra={})=>context({position:{quantity:0.01},...extra});
const BLOCKED='News trading block is active';

for(const [name,evaluate] of [['src/risk.js',legacy],['src/postgres/risk.js',postgres]]){
  test(name+': an active news window rejects a new entry with the existing reason',()=>{
    const result=evaluate({...buy,newsRisk:true},context());
    assert.equal(result.ok,false);assert.equal(result.reason,BLOCKED);
  });
  test(name+': an EXIT is never news-blocked, even inside an active window',()=>{
    assert.equal(evaluate({...exit,newsRisk:true},open()).ok,true);
    assert.equal(evaluate({...exit,newsRisk:true},open({policy:{...policy,killSwitch:true}})).ok,true,'exits also pass the other entry guards');
  });
  test(name+': missing or non-boolean news data never rejects an entry',()=>{
    for(const value of [undefined,null,'true','false',1,0,{}])
      assert.equal(evaluate({...buy,newsRisk:value},context()).ok,true,String(value));
    const absent={...buy};delete absent.newsRisk;
    assert.equal(evaluate(absent,context()).ok,true);
    assert.notEqual(evaluate(absent,context()).reason,'Missing news risk data');
  });
  test(name+': no window, or the switch off, allows the entry',()=>{
    assert.equal(evaluate({...buy,newsRisk:false},context()).ok,true);
    assert.equal(evaluate({...buy,newsRisk:true},context({policy:{...policy,blockDuringNews:false}})).ok,true);
    assert.equal(evaluate({...buy,newsRisk:true},context({policy:{...policy,blockDuringNews:undefined}})).ok,true,'an unset switch is off');
  });
  test(name+': after the window the same bot and run trade again without any reset',()=>{
    const during=evaluate({...buy,newsRisk:true},context()),after=evaluate({...buy,newsRisk:false,tradeId:'t2'},context());
    assert.equal(during.ok,false);assert.equal(after.ok,true);
  });
}
test('both Node evaluators agree on every news vector',()=>{
  const vectors=[[{...buy,newsRisk:true},context()],[{...buy,newsRisk:false},context()],[{...buy},context()],[{...buy,newsRisk:'true'},context()],
    [{...exit,newsRisk:true},open()],[{...buy,newsRisk:true},context({policy:{...policy,blockDuringNews:false}})]];
  for(const [signal,ctx] of vectors){
    const a=legacy(signal,ctx),b=postgres(signal,ctx);
    assert.equal(a.ok,b.ok);assert.equal(a.reason,b.reason);
  }
});
