import test from 'node:test';
import assert from 'node:assert/strict';
import {D} from '../src/money.js';
import {finalizeBridgeOrder,COST_MODEL_VERSION} from '../src/postgres/paper-cost-model.js';
import {roundBridgeOrder} from '../src/postgres/pine-bridge-execution.js';
import {ledgerMethods,recordFunding} from '../src/postgres/ledger.js';
import {validateEvidence} from '../src/postgres/pine-bridge-readiness.js';

const model={version:COST_MODEL_VERSION,price_tick:.01,quantity_step:.01,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const order={side:'BUY',quantity:'10',price:'100',notional:'1000',stopLoss:'99',takeProfit:'102',riskMode:'PERCENT_EQUITY',riskValue:'1'};
function context(overrides={}){
  return {policy:{maxRiskPercent:1},account:{bookEquity:'1000',cash:'1000'},
    signal:{side:'BUY',riskMode:'PERCENT_EQUITY',riskValue:'1'},exposure:{reservedNotional:'0',reservedFees:'0',committedNotional:'0'},...overrides};
}

test('V1 preserves exact existing roundBridgeOrder output without requiring new context',()=>{
  const legacy={...model,version:'paper-close-v1'},input={...order,quantity:'10.009'};
  assert.deepEqual(finalizeBridgeOrder(input,legacy),roundBridgeOrder(input,legacy));
  assert.equal(finalizeBridgeOrder(input,legacy).order.execution_model_version,undefined);
});
test('unknown execution model fails closed',()=>{
  assert.throws(()=>finalizeBridgeOrder(order,{...model,version:'future'},context()),error=>error.code==='UNSUPPORTED_EXECUTION_MODEL');
});
test('V2 Percent Equity shrinks for adverse stop price and both fees',()=>{
  const before=structuredClone(order),result=finalizeBridgeOrder(order,model,context());
  assert.equal(result.order.quantity,'8.27');assert.equal(result.fee,'0.827');
  assert.ok(D(result.costs.estimatedLossAtStop).lte(10));assert.equal(result.costs.estimatedStopExitPrice,'98.99');
  assert.equal(result.costs.riskBudget,'10');assert.equal(result.costs.riskLimitIncludesCosts,true);
  assert.equal(result.costs.rAccounting,'PRICE_DISTANCE_V1');assert.match(result.costs.assumption,/Gaps/);
  assert.equal(result.order.execution_model_version,COST_MODEL_VERSION);assert.equal(result.order.reserved_fee_bps,'10');
  assert.equal(result.order.sizingAdjustment.requestedQuantity,'10');assert.deepEqual(order,before);
});
test('V2 respects requested risk below policy ceiling',()=>{
  const result=finalizeBridgeOrder(order,model,context({policy:{maxRiskPercent:100}}));
  assert.equal(result.order.quantity,'8.27');assert.equal(result.costs.riskBudget,'10');
});
test('V2 preserves original cap provenance while applying smaller cost-aware quantity',()=>{
  const result=finalizeBridgeOrder({...order,sizingAdjustment:{requestedQuantity:'20',quantity:'10',reason:'Existing cap'}},model,context());
  assert.equal(result.order.sizingAdjustment.requestedQuantity,'20');assert.equal(result.order.sizingAdjustment.quantity,'8.27');
});
for(const signal of [{side:'BUY',riskMode:'QUANTITY',quantity:'10'},
  {side:'BUY',riskMode:'FIXED_NOTIONAL',riskValue:'1000'},
  {side:'BUY',riskMode:'PERCENT_EQUITY',riskValue:'1',quantity:'10'},
  {side:'BUY',riskMode:'PERCENT_EQUITY',riskValue:'1',quoteQuantity:'1000'}]){
  test('V2 explicit '+JSON.stringify(signal)+' rejects risk excess instead of shrinking',()=>{
    assert.throws(()=>finalizeBridgeOrder(order,model,context({signal})),error=>error.code==='COST_INCLUSIVE_RISK_EXCEEDED');
  });
}
test('V2 quantity rounding can make explicit quantity feasible without a risk cap',()=>{
  const result=finalizeBridgeOrder({...order,quantity:'8.279',notional:'827.9'},model,context({signal:{riskMode:'QUANTITY',quantity:'8.279'}}));
  assert.equal(result.order.quantity,'8.27');assert.ok(D(result.costs.estimatedLossAtStop).lte(10));
});
test('V2 cash cap includes pending notional and fee reservations',()=>{
  const result=finalizeBridgeOrder(order,model,context({policy:{maxRiskPercent:100},signal:{riskMode:'PERCENT_EQUITY',riskValue:100},
    account:{bookEquity:'10000',cash:'500'},exposure:{reservedNotional:'100',reservedFees:'2',committedNotional:'100'}}));
  assert.equal(result.order.quantity,'3.97');assert.equal(result.costs.cashDebit,'397.397');
});
test('V2 exposure cap also includes entry and pending fees',()=>{
  const result=finalizeBridgeOrder(order,model,context({policy:{maxRiskPercent:100},signal:{riskMode:'PERCENT_EQUITY',riskValue:100},
    exposure:{reservedNotional:'0',reservedFees:'2',committedNotional:'900'}}));
  assert.equal(result.order.quantity,'0.97');assert.ok(D(result.costs.cashDebit).lte(98));
});
test('V2 explicit cash excess rejects even with high risk limit',()=>{
  assert.throws(()=>finalizeBridgeOrder(order,model,context({policy:{maxRiskPercent:100},signal:{riskMode:'QUANTITY',quantity:10},
    account:{bookEquity:'10000',cash:'1000'}})),error=>error.code==='COST_INCLUSIVE_CASH_EXCEEDED');
});
test('V2 pending fee authority unknown blocks BUY but not reduce-only EXIT',()=>{
  const options=context({exposure:{feeReservationUnknown:true}});
  assert.throws(()=>finalizeBridgeOrder(order,model,options),error=>error.code==='PENDING_FEE_RESERVATION_UNKNOWN');
  const result=finalizeBridgeOrder({...order,side:'SELL',reduceOnly:true},model,options);
  assert.equal(result.order.quantity,'10');assert.equal(result.fee,'1');assert.equal(result.costs,undefined);
});
test('V2 size below step rejects without changing protection',()=>{
  assert.throws(()=>finalizeBridgeOrder(order,{...model,quantity_step:10},context()),error=>error.code==='BELOW_QUANTITY_STEP');
  assert.equal(order.stopLoss,'99');assert.equal(order.takeProfit,'102');
});
test('V2 zero fees and slippage reproduce nominal risk size when funds permit',()=>{
  const result=finalizeBridgeOrder(order,{...model,fee_bps:0,slippage_bps:0},context());
  assert.equal(result.order.quantity,'10');assert.equal(result.costs.estimatedLossAtStop,'10');assert.equal(result.fee,'0');
});
test('V2 rejects a stop rounded to zero',()=>{
  assert.throws(()=>finalizeBridgeOrder({...order,stopLoss:'.01'},{...model,slippage_bps:1000},context()),error=>error.code==='INVALID_MODELED_STOP_PRICE');
});
test('V2 shrink cannot create a zero-notional ledger fill at decimal precision boundary',()=>{
  const tinyOrder={...order,price:'0.000000000001',notional:'0.00000000001',stopLoss:'0.0000000000005'};
  assert.throws(()=>finalizeBridgeOrder(tinyOrder,{...model,price_tick:1e-15,quantity_step:1e-18,fee_bps:0,slippage_bps:0},
    context({account:{bookEquity:'0.000000000000000001',cash:'1000'}})),error=>error.code==='BELOW_NOTIONAL_PRECISION');
});

async function exposure(orders){
  const db={prepare(sql){assert.match(sql,/^SELECT /);return {async all(){return sql.includes('FROM signals')?orders:[];}};}};
  return ledgerMethods.exposure.call({db},{id:99,user_id:'bot',account_id:'binance-global:primary',execution_mode:'PAPER',symbol:'BTCUSDT'});
}
const pending=(intent,extra={})=>({side:'BUY',symbol:'BTCUSDT',order_intent:intent===null?null:JSON.stringify(intent),
  applied_quantity:'4',status:'PARTIALLY_FILLED',payload:'{}',...extra});
test('pending V2 partially filled quantity reserves remaining notional plus fees separately',async()=>{
  const result=await exposure([pending({quantity:'10',price:'100',execution_model_version:COST_MODEL_VERSION,reserved_fee_bps:'10'})]);
  assert.equal(result.reservedNotional,'600');assert.equal(result.reservedFees,'0.6');assert.equal(result.committedNotional,'600');
  assert.equal(result.feeReservationUnknown,false);
});
test('pending generic legacy order retains zero fee reservation',async()=>{
  const result=await exposure([pending({quantity:'10',price:'100'})]);
  assert.equal(result.reservedFees,'0');assert.equal(result.feeReservationUnknown,false);
});
for(const [name,item]of [
  ['old Bridge',pending({quantity:'10',price:'100'},{payload:JSON.stringify({bridge:{}})})],
  ['missing V2 fee',pending({quantity:'10',price:'100',execution_model_version:COST_MODEL_VERSION})],
  ['invalid V2 fee',pending({quantity:'10',price:'100',execution_model_version:COST_MODEL_VERSION,reserved_fee_bps:'-1'})],
  ['missing intent',pending(null)],
  ['unknown version',pending({quantity:'10',price:'100',execution_model_version:'future'})]
])test(name+' never assumes verified zero pending fees',async()=>{assert.equal((await exposure([item])).feeReservationUnknown,true);});
test('SELL does not reserve acquisition fees',async()=>{
  const result=await exposure([pending({quantity:'10',price:'100',execution_model_version:COST_MODEL_VERSION,reserved_fee_bps:'10'},{side:'SELL'})]);
  assert.equal(result.reservedNotional,'0');assert.equal(result.reservedFees,'0');assert.equal(result.feeReservationUnknown,false);
});
for(const uncertain of [false,true])test('withdrawal preserves reserved fees'+(uncertain?' when authority is unknown':''),async()=>{
  let writes=0;
  const store={db:{prepare(){return {async get(){return {id:'bot'};},async run(){writes++;}};}},
    async paperAccount(){return {configuredEquity:'100',configuredBalance:'100',cash:'100',bookEquity:'100',positionCost:'0'};},
    async exposure(){return {reservedNotional:'90',reservedFees:'5',feeReservationUnknown:uncertain};}};
  await assert.rejects(recordFunding(store,'bot',{equities:{'binance-global':'100'},balances:{'binance-global':'90'}}),/withdrawal exceeds unreserved funds/);
  assert.equal(writes,0);
});

test('evidence validator explicitly accepts V2 and continues rejecting unknown versions',()=>{
  const evidence={snapshot_hash:'snapshot',artifact_hash:'artifact',source_hash:'source',compilation_errors:0,warnings:0,reviewed_warnings:0,
    binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
    effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{...model},
    references:{tradingview:'fixture-reference',source_review:'fixture-reference',paper_fixture:'fixture-reference'}};
  assert.equal(validateEvidence(evidence,'snapshot').execution_model.version,COST_MODEL_VERSION);
  assert.throws(()=>validateEvidence({...evidence,execution_model:{...model,version:'future'}},'snapshot'),error=>error.code==='UNSUPPORTED_EXECUTION_MODEL');
});
