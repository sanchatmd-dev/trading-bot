import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,delimiter} from 'node:path';
import {finalizeBridgeOrder} from '../src/postgres/paper-cost-model.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.QUANT_RESEARCH_PYTHON || (existsSync(localPython)?localPython:'python');
const modulePath=resolve(root,'quant_lab','src','robot_quant','paper_cost_model.py');
const model={version:'paper-close-cost-v2',price_tick:.01,quantity_step:.01,fee_bps:10,slippage_bps:1};
const order={side:'BUY',quantity:'10',price:'100',notional:'1000',stopLoss:'99',takeProfit:'102',riskMode:'PERCENT_EQUITY',riskValue:'1'};
const context={policy:{maxRiskPercent:1},account:{bookEquity:'1000',cash:'1000'},
  signal:{side:'BUY',riskMode:'PERCENT_EQUITY',riskValue:'1'},
  exposure:{reservedNotional:'0',reservedFees:'0',committedNotional:'0'}};
const vector=(changes={})=>({order,model,...context,...changes});
const vectors=[
  vector(),
  vector({signal:{riskMode:'QUANTITY',quantity:'10'}}),
  vector({policy:{maxRiskPercent:100},signal:{riskMode:'PERCENT_EQUITY',riskValue:100},
    account:{bookEquity:'10000',cash:'500'},exposure:{reservedNotional:'100',reservedFees:'2',committedNotional:'100'}}),
  vector({policy:{maxRiskPercent:100},signal:{riskMode:'PERCENT_EQUITY',riskValue:100},
    exposure:{reservedNotional:'0',reservedFees:'2',committedNotional:'900'}}),
  vector({model:{...model,fee_bps:0,slippage_bps:0}}),
  vector({order:{...order,quantity:'8.279',notional:'827.9'},signal:{riskMode:'QUANTITY',quantity:'8.279'}}),
  vector({order:{...order,side:'SELL',reduceOnly:true},exposure:{feeReservationUnknown:true}}),
  vector({exposure:{feeReservationUnknown:true}}),
  vector({model:{...model,quantity_step:11}}),
  vector({order:{...order,stopLoss:'.01'},model:{...model,slippage_bps:1000}}),
  vector({policy:{maxRiskPercent:100},signal:{riskMode:'QUANTITY',quantity:'10'},account:{bookEquity:'10000',cash:'1000'}}),
  vector({order:{...order,stopLoss:'99.000000000000000001'}}),
  vector({order:{...order,sizingAdjustment:{requestedQuantity:'20',quantity:'10',reason:'Existing cap'}}}),
  vector({model:{...model,version:'future'}}),
  vector({order:{...order,price:'0.000000000001',notional:'0.00000000001',stopLoss:'0.0000000000005'},
    model:{...model,price_tick:1e-15,quantity_step:1e-18,fee_bps:0,slippage_bps:0},
    account:{bookEquity:'0.000000000000000001',cash:'1000'}}),
  vector({order:{...order,quantity:'10.0000000000000000000'}}),
  vector({order:{...order,sizingAdjustment:{requestedQuantity:null}},
    exposure:{reservedNotional:null,reservedFees:null,committedNotional:null}}),
];

function nodeOutcome(v){
  try{return {result:finalizeBridgeOrder(v.order,v.model,{policy:v.policy,account:v.account,signal:v.signal,exposure:v.exposure})};}
  catch(error){return {error:error.code??error.message};}
}

test('isolated Python cost-v2 finalizer matches production Node outcomes',()=>{
  const child=spawnSync(python,[modulePath],{input:JSON.stringify(vectors),encoding:'utf8',timeout:10000,
    env:{...process.env,PYTHONPATH:[resolve(root,'quant_lab','src'),process.env.PYTHONPATH].filter(Boolean).join(delimiter)}});
  assert.equal(child.status,0,child.stderr);
  const actual=JSON.parse(child.stdout);
  const expected=vectors.map(nodeOutcome);
  assert.deepEqual(actual,expected);
  assert.equal(actual[0].result.order.quantity,'8.27');
  assert.equal(actual[0].result.fee,'0.827');
  assert.equal(actual[0].result.costs.estimatedStopExitPrice,'98.99');
  assert.equal(actual[1].error,'COST_INCLUSIVE_RISK_EXCEEDED');
  assert.equal(actual[11].result.costs.estimatedStopExitPrice,'98.99');
  assert.equal(actual[12].result.order.sizingAdjustment.requestedQuantity,'20');
  assert.equal(actual[13].error,'UNSUPPORTED_EXECUTION_MODEL');
  assert.equal(actual[14].error,'BELOW_NOTIONAL_PRECISION');
  assert.equal(actual[15].result.order.sizingAdjustment.requestedQuantity,'10');
  assert.equal(actual[16].result.order.sizingAdjustment.requestedQuantity,'10');
});
