import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,delimiter} from 'node:path';
import {Money} from '../src/money.js';
import {valueRun} from '../src/comparison/valuation.js';

/**
 * Parity of the Python fixed-input evaluator (quant_lab fixed_eval.py) with the QR-3 S1 valuation.
 * The evaluator runs the real SPT Custom signal and the Paper engine on synthetic bars. Its fills, in the adapter
 * view (bar open time, BUY or SELL, per-fill slippage_cost_incl_tick), go to valueRun on the same bar-close grid.
 * End NAV, net return and max drawdown must match exactly (as decimals); fees, slippage and exposure must match too.
 */
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.QUANT_RESEARCH_PYTHON || (existsSync(localPython)?localPython:'python');
const modulePath=resolve(root,'quant_lab','src','robot_quant','fixed_eval.py');
const MINUTE=60000;
const T0=1_800_000_000_000; // open time of bar 0; the engine time of bar i is T0+(i+1)*MINUTE

const POLICY={killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,pauseAfterLossStreak:10000,
  blockHighVolatility:false,maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',
  maxOpenPositions:3,onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,
  maxDailyNotional:100000000};
const MODEL={price_tick:'0.01',quantity_step:'0.00001',fee_bps:'10',slippage_bps:'1',risk_percent:'1'};
const INPUTS={ema_fast:3,ema_slow:8,atr_len:14,st_factor:3.2,zone_atr_mult:1.15,setup_expiry:48,cooldown:0,
  confirm_lookback:5,sl_atr_buffer:0.6,min_risk_atr:0.5};

/**
 * Deterministic synthetic bars: linear congruential noise on a slow wave (BigInt keeps the arithmetic exact).
 * Every row carries the frozen market ATR(14) the evaluator requires: Wilder's ATR seeded at 40 and scaled by 1.7,
 * so it is deliberately unlike a cold-started ATR.
 */
function syntheticRows(count,seed,amplitude){
  let state=BigInt(seed),price=30000,atr=40;
  const rows=[];
  for(let index=0;index<count;index+=1){
    state=(state*1103515245n+12345n)%(2n**31n);
    const noise=(Number(state)/2**31-0.5)*amplitude;
    const close=Math.max(1000,price+40*Math.sin(index/90)+noise);
    const high=Math.max(price,close)+5,low=Math.min(price,close)-5;
    atr=Math.max(high-low,Math.abs(high-price),Math.abs(low-price))/14+13/14*atr;
    rows.push({time:T0+(index+1)*MINUTE,open:price.toFixed(2),high:high.toFixed(2),low:low.toFixed(2),close:close.toFixed(2),volume:'1',atr14:(atr*1.7).toFixed(6)});
    price=Number(close.toFixed(2));
  }
  return rows;
}

function evaluate(contract,kind,split){
  const request={contract,parameters:{inputs:INPUTS,atr_multiplier:'2',rr:'1.5'},kind,split};
  const child=spawnSync(python,[modulePath],{input:JSON.stringify(request),encoding:'utf8',timeout:120000,
    env:{...process.env,PYTHONPATH:[resolve(root,'quant_lab','src'),process.env.PYTHONPATH].filter(Boolean).join(delimiter)}});
  assert.ok(!child.error,`Python evaluator launch failed: ${child.error?.code}`);
  assert.equal(child.status,0,`Python evaluator exited ${child.status}: ${child.stderr?.slice(-400)}`);
  const parsed=JSON.parse(child.stdout);
  assert.equal(parsed.error,undefined,`Python evaluator refused: ${parsed.error}`);
  return parsed.result;
}

/** Adapter view: engine close time to bar open time is already done by the evaluator (bar_time_ms). */
function valuationInput(result,rows,cash,warmup,end){
  const window=rows.slice(warmup,end);
  return {initial_cash:cash,period:{start_ms:window[0].time-MINUTE,end_ms:window[window.length-1].time},
    grid:window.map(row=>({time_ms:row.time-MINUTE,close:row.close})),
    fills:result.fills.map(fill=>({bar_time_ms:fill.bar_time_ms,side:fill.side,quantity:fill.quantity,price:fill.price,fee:fill.fee,
      sequence:fill.sequence,slippage_cost:fill.slippage_cost_incl_tick})),
    flows:[],basis_confirmed:true};
}

const same=(actual,expected,label)=>assert.ok(new Money(actual).eq(new Money(expected)),`${label}: ${actual} != ${expected}`);
const round18=value=>new Money(value).toDecimalPlaces(18,Money.ROUND_HALF_EVEN);

/**
 * Recompute every fill from the rows and the model alone, without the evaluator's own numbers except quantity and side:
 * fill price (close moved by the adverse slippage, tick rounded up for BUY and down for SELL), notional, fee and the
 * slippage cost |price - close| x quantity. Returns the independent totals and the in-market bar count.
 */
function independentLedger(result,rows,model,factor,warmup,end){
  const closeByTime=new Map(rows.map(row=>[row.time,new Money(row.close)]));
  const tick=new Money(model.price_tick),bps=new Money(10000);
  const slippage=new Money(model.slippage_bps).mul(factor).div(bps),feeRate=new Money(model.fee_bps).mul(factor).div(bps);
  let fees=new Money(0),slippageTotal=new Money(0);
  const bySequence=new Map();
  result.fills.forEach((fill,index)=>{
    const close=closeByTime.get(fill.time),buy=fill.side==='BUY';
    assert.ok(close,`fill ${index}: no row at ${fill.time}`);
    const raw=close.mul(new Money(1).plus(buy?slippage:slippage.neg())).div(tick);
    const price=(buy?raw.ceil():raw.floor()).mul(tick);
    same(fill.price,price,`fill ${index} price`);
    const quantity=new Money(fill.quantity),notional=round18(quantity.mul(price));
    same(fill.notional,notional,`fill ${index} notional`);
    const fee=round18(notional.mul(feeRate));
    same(fill.fee,fee,`fill ${index} fee`);
    const cost=round18(price.minus(close).abs().mul(quantity));
    same(fill.slippage_cost_incl_tick,cost,`fill ${index} slippage`);
    fees=fees.plus(fee);slippageTotal=slippageTotal.plus(cost);
    bySequence.set(fill.time,[...(bySequence.get(fill.time)||[]),fill]);
  });
  let held=new Money(0),inMarket=0;
  for(const row of rows.slice(warmup,end)){
    for(const fill of (bySequence.get(row.time)||[]).sort((a,b)=>a.sequence-b.sequence)){
      held=fill.side==='BUY'?held.plus(fill.quantity):held.minus(fill.quantity);
    }
    if(held.gt(0))inMarket+=1;
  }
  return {fees,slippageTotal,inMarket,held};
}

const DATASETS=[
  {name:'open-at-end',count:3000,seed:7,amplitude:160,warmup:1006,end:2000},
  {name:'noisy',count:3000,seed:11,amplitude:260,warmup:600,end:2400},
  {name:'wide-window-end-cut',count:4000,seed:23,amplitude:150,warmup:400,end:3500},
];

for(const dataset of DATASETS){
  for(const kind of ['EVALUATION','EVALUATION_STRESS']){
    test(`fixed evaluator equals QR-3 valueRun: ${dataset.name} ${kind}`,()=>{
      const rows=syntheticRows(dataset.count,dataset.seed,dataset.amplitude);
      const contract={rows,model:MODEL,policy:POLICY,initial_cash:'10000',initial_equity:'10000',broker:'binance-global',symbol:'BTCUSDT',deployment_id:'fe1',
        engine_hash:'e'.repeat(64),dataset_sha256:'d'.repeat(64),parent_run_id:'parent-1',selection_id:'selection-1'};
      const result=evaluate(contract,kind,{warmup:dataset.warmup,end:dataset.end});
      assert.ok(result.fills.length>=2,`${dataset.name}: scenario must trade (fills ${result.fills.length})`);
      assert.deepEqual([result.parent_run_id,result.selection_id,result.engine_hash,result.dataset_sha256],['parent-1','selection-1','e'.repeat(64),'d'.repeat(64)]);
      for(const fill of result.fills){
        assert.equal(fill.bar_time_ms,fill.time-MINUTE);
        assert.ok(['BUY','SELL'].includes(fill.side));
      }
      const valued=valueRun(valuationInput(result,rows,'10000',dataset.warmup,dataset.end));
      assert.equal(valued.ok,true,`${valued.code}:${valued.detail}`);
      assert.equal(valued.bars,dataset.end-dataset.warmup);
      same(valued.end_nav,result.metrics.end_equity,'end NAV');
      same(valued.net_return_percent_exact,result.metrics.net_return_percent,'net return percent');
      same(valued.max_drawdown_percent_exact,result.metrics.max_drawdown_percent,'max drawdown percent');
      same(valued.total_fees,result.fees_total,'total fees');
      same(valued.total_slippage.value,result.slippage_cost_incl_tick_total,'total slippage');
      const ledger=independentLedger(result,rows,MODEL,kind==='EVALUATION_STRESS'?2:1,dataset.warmup,dataset.end);
      same(result.fees_total,ledger.fees,'independent total fees');
      same(result.slippage_cost_incl_tick_total,ledger.slippageTotal,'independent total slippage');
      assert.equal(result.exposure.bars,dataset.end-dataset.warmup);
      assert.equal(result.exposure.bars,valued.bars);
      assert.equal(result.exposure.bars_in_market,ledger.inMarket);
      same(result.exposure.fraction,new Money(ledger.inMarket).div(result.exposure.bars).toDecimalPlaces(18,Money.ROUND_HALF_EVEN),'exposure fraction');
      same(result.open_position.quantity,ledger.held,'independent end position');
      assert.equal(result.evaluator_closure,'NOT_IN_ENGINE_CLOSURE');
      assert.equal(result.metrics_precision,80);
      same(valued.exposure_percent,new Money(result.exposure.fraction).mul(100).toDecimalPlaces(12,Money.ROUND_HALF_EVEN),'exposure percent');
      same(valued.end_position.quantity,result.open_position.quantity,'end position quantity');
      assert.equal(result.closed_allocations,result.fills.filter(fill=>fill.side==='SELL').length);
      assert.ok(result.episodes.completed_count<=result.closed_allocations);
    });
  }
}

test('open position at the cut is marked, not liquidated',()=>{
  const dataset=DATASETS[0];
  const rows=syntheticRows(dataset.count,dataset.seed,dataset.amplitude);
  const contract={rows,model:MODEL,policy:POLICY,initial_cash:'10000',initial_equity:'10000',broker:'binance-global',symbol:'BTCUSDT',deployment_id:'fe1'};
  const result=evaluate(contract,'EVALUATION',{warmup:dataset.warmup,end:dataset.end});
  assert.ok(new Money(result.open_position.quantity).gt(0));
  assert.equal(result.open_position.mark_close,rows[dataset.end-1].close);
  assert.ok(result.open_position.open_episode!==null);
});

test('stress run charges more cost than the plain run on the same signals',()=>{
  const dataset=DATASETS[1];
  const rows=syntheticRows(dataset.count,dataset.seed,dataset.amplitude);
  const contract={rows,model:MODEL,policy:POLICY,initial_cash:'10000',initial_equity:'10000',broker:'binance-global',symbol:'BTCUSDT',deployment_id:'fe1'};
  const split={warmup:dataset.warmup,end:dataset.end};
  const plain=evaluate(contract,'EVALUATION',split),stress=evaluate(contract,'EVALUATION_STRESS',split);
  assert.deepEqual([stress.model.fee_bps,stress.model.slippage_bps],['20','2']);
  assert.ok(new Money(stress.metrics.net_return_percent).lt(plain.metrics.net_return_percent));
});
