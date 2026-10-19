import {Money,MINUTE,DAY,QR3_VERSIONS,CODES,NUMBER_DETAIL,isObject,isInt,isAligned,isNumber,dec,deepFreeze,refuse,numberRefusal,round18,round12,out,nullMetric} from './common.js';

/**
 * Standardized valuation qr3-valuation-std-v1 (section 5.1) and Buy & Hold benchmark qr3-bh-close-same-cost-v1 (5.3),
 * test plan 13.1 items 7 and 8. The valuation turns a flat start, the evaluator's recorded fills and the shared dataset
 * closes into NAV on the bar-close grid qr3-grid-bar-close-v1 (V4): price is the close of each bar (V1), the run starts flat
 * with initial_cash (V2), no flows exist (V3), an open position is marked at the last close and not liquidated (V5), fees and
 * slippage come only from the recorded fills and are never subtracted again (V6), money is rounded to 18 places half-even per
 * position per instant and a return only once at output to 12 places (V7). It computes from fills; it does not run the
 * evaluator. Whether the evaluator can emit those fills, the grid, fees, exposure and rejected intents is the open RD-5/V8
 * question, so `end_treatment` is VALUATION_BASIS_UNCONFIRMED unless the caller passes basis_confirmed === true.
 */
/*
 * V4 grid: the start NAV (initial cash, before the first fill) is the first drawdown point, so a first-bar loss counts; the bar closes follow.
 * Tick rounding is adverse (a buy price rounds up, a sell price rounds down) until RD-5 confirms the evaluator's rule.
 * Money and metric inputs are decimal strings; a number is refused QR3_SPEC_INCOMPLETE with detail NUMBER_NOT_DECIMAL_STRING (RC-C10).
 * Every *_exact output is the unrounded value at 80 digits (src/money.js), not a rational (RC-C14).
 */
const HUNDRED=new Money(100);
const BPS=new Money(10000);

/** Grid check: exactly one positive close for every minute in [start, end), in order. */
export function checkGrid(grid,period){
  if(!isObject(period)||!isAligned(period.start_ms)||!isAligned(period.end_ms)||period.end_ms<=period.start_ms)return refuse(CODES.QR3_PERIOD_INVALID,'PERIOD');
  if(!Array.isArray(grid))return refuse(CODES.QR3_DATASET_UNAVAILABLE,'GRID');
  const bars=(period.end_ms-period.start_ms)/MINUTE;
  if(grid.length!==bars)return refuse(CODES.QR3_DATASET_GAPPED,'GRID_LENGTH',{expected_bars:bars,actual_bars:grid.length});
  for(let index=0;index<grid.length;index+=1){
    const bar=grid[index];
    if(!isObject(bar)||bar.time_ms!==period.start_ms+index*MINUTE)return refuse(CODES.QR3_DATASET_GAPPED,'GRID_ORDER',{index});
    const close=dec(bar.close);
    if(!close||!close.gt(0))return refuse(CODES.QR3_DATASET_UNAVAILABLE,'CLOSE_UNREADABLE',{index});
  }
  return deepFreeze({ok:true,code:null,detail:null,bars});
}

const SIDES=Object.freeze(['BUY','SELL']);
function readFill(fill){
  if(!isObject(fill)||!SIDES.includes(fill.side)||!isInt(fill.bar_time_ms))return null;
  const quantity=dec(fill.quantity),price=dec(fill.price),fee=dec(fill.fee);
  if(!quantity||!price||!fee||!quantity.gt(0)||!price.gt(0)||fee.lt(0))return null;
  let slippage=null;
  if(fill.slippage_cost!==undefined&&fill.slippage_cost!==null){slippage=dec(fill.slippage_cost);if(!slippage)return null;}
  return {side:fill.side,time:fill.bar_time_ms,quantity,price,fee,slippage,sequence:isInt(fill.sequence)?fill.sequence:null};
}
const gridHasNumber=grid=>Array.isArray(grid)&&grid.some(bar=>isObject(bar)&&isNumber(bar.close));
const fillHasNumber=fill=>isObject(fill)&&[fill.quantity,fill.price,fill.fee,fill.slippage_cost].some(isNumber);

/**
 * Value one run on the grid.
 * input: {initial_cash, period:{start_ms,end_ms}, grid:[{time_ms,close}], fills:[{bar_time_ms,side,quantity,price,fee,slippage_cost?,sequence?}],
 *   flows:[], basis_confirmed}
 * A fill executes at the close of the bar whose open time is bar_time_ms and is in the NAV of that same bar close. Fills of one bar
 * apply in execution order given by the integer sequence field; two or more fills on one bar without distinct sequences refuse
 * QR3_METRIC_UNAVAILABLE with detail FILL_ORDER_UNKNOWN. Any flow, a fill outside the window, a negative inventory or a negative cash
 * refuses; nothing is repaired.
 */
export function valueRun(input){
  const request=isObject(input)?input:{};
  if(isNumber(request.initial_cash)||gridHasNumber(request.grid)||(Array.isArray(request.fills)&&request.fills.some(fillHasNumber)))return numberRefusal();
  const cash0=dec(request.initial_cash);
  if(!cash0||!cash0.gt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'INITIAL_CASH');
  if(!Array.isArray(request.flows))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'FLOWS_UNREADABLE');
  if(request.flows.length>0)return refuse(CODES.QR3_FLOW_IN_WINDOW);
  const gridCheck=checkGrid(request.grid,request.period);
  if(!gridCheck.ok)return gridCheck;
  if(!Array.isArray(request.fills))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'FILLS_UNREADABLE');
  const byBar=new Map();
  let slippageKnown=true;
  for(const raw of request.fills){
    const fill=readFill(raw);
    if(!fill)return refuse(CODES.QR3_METRIC_UNAVAILABLE,'FILL_UNREADABLE');
    if(fill.time<request.period.start_ms||fill.time>=request.period.end_ms||fill.time%MINUTE!==0)return refuse(CODES.QR3_METRIC_UNAVAILABLE,'FILL_OUTSIDE_WINDOW');
    if(fill.slippage===null)slippageKnown=false;
    if(!byBar.has(fill.time))byBar.set(fill.time,[]);
    byBar.get(fill.time).push(fill);
  }
  for(const list of byBar.values()){
    if(list.length<2)continue;
    if(list.some(fill=>fill.sequence===null)||new Set(list.map(fill=>fill.sequence)).size!==list.length)return refuse(CODES.QR3_METRIC_UNAVAILABLE,'FILL_ORDER_UNKNOWN');
    list.sort((x,y)=>x.sequence-y.sequence);
  }
  let cash=cash0,inventory=new Money(0),peak=cash0,maxDrawdown=new Money(0),fees=new Money(0),slippage=new Money(0),inMarket=0;
  const series=[];
  for(const bar of request.grid){
    for(const fill of byBar.get(bar.time_ms)||[]){
      const notional=round18(fill.quantity.mul(fill.price));
      if(fill.side==='BUY'){cash=cash.minus(notional).minus(fill.fee);inventory=inventory.plus(fill.quantity);}
      else{cash=cash.plus(notional).minus(fill.fee);inventory=inventory.minus(fill.quantity);}
      fees=fees.plus(fill.fee);
      if(fill.slippage!==null)slippage=slippage.plus(fill.slippage);
      if(inventory.lt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'NEGATIVE_INVENTORY');
      if(cash.lt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'NEGATIVE_CASH');
    }
    const nav=cash.plus(round18(inventory.mul(bar.close)));
    if(inventory.gt(0))inMarket+=1;
    if(nav.gt(peak))peak=nav;
    const drawdown=peak.minus(nav).div(peak).mul(HUNDRED);
    if(drawdown.gt(maxDrawdown))maxDrawdown=drawdown;
    series.push({time_ms:bar.time_ms,nav});
  }
  const last=series[series.length-1].nav;
  const returnFraction=last.div(cash0).minus(1);
  const returnPercent=returnFraction.mul(HUNDRED);
  const lastClose=request.grid[request.grid.length-1].close;
  return deepFreeze({ok:true,code:null,detail:null,version:QR3_VERSIONS.valuation,grid_id:QR3_VERSIONS.grid,
    end_treatment:request.basis_confirmed===true?'MARK_AT_END_CLOSE':CODES.VALUATION_BASIS_UNCONFIRMED,
    limitations:request.basis_confirmed===true?[]:[CODES.VALUATION_BASIS_UNCONFIRMED],
    bars:series.length,start_nav:out(cash0),end_nav:out(last),
    net_return_fraction:out(round12(returnFraction)),net_return_percent:out(round12(returnPercent)),net_return_percent_exact:out(returnPercent),
    max_drawdown_percent:out(round12(maxDrawdown)),max_drawdown_percent_exact:out(maxDrawdown),
    total_fees:out(fees),total_slippage:slippageKnown?{value:out(slippage),reason:null}:nullMetric(CODES.METRIC_NOT_RECORDED),
    exposure_percent:out(round12(new Money(inMarket).div(series.length).mul(HUNDRED))),
    end_position:{quantity:out(inventory),mark_close:out(dec(lastClose)),value:out(round18(inventory.mul(lastClose)))},
    nav_series:series.map(item=>({time_ms:item.time_ms,nav:out(item.nav)}))});
}

/** Daily returns on the UTC day grid: last NAV of each UTC day against the previous day's last NAV (the first against initial NAV). */
export function dailyReturns(navSeries,initialNav){
  if(isNumber(initialNav)||(Array.isArray(navSeries)&&navSeries.some(item=>isObject(item)&&isNumber(item.nav))))return numberRefusal();
  const start=dec(initialNav);
  if(!Array.isArray(navSeries)||navSeries.length===0||!start||!start.gt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'DAILY_INPUT');
  const days=new Map(),points=[];
  for(const item of navSeries){
    const nav=dec(item?.nav);
    if(!isObject(item)||!isInt(item.time_ms)||!nav||!nav.gt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'DAILY_POINT');
    points.push({time:item.time_ms,nav});
  }
  points.sort((x,y)=>x.time-y.time);
  for(const point of points)days.set(Math.floor(point.time/DAY),point.nav);
  const keys=[...days.keys()].sort((a,b)=>a-b);
  let previous=start;
  const returns=keys.map(day=>{const nav=days.get(day);const value=nav.div(previous).minus(1);previous=nav;return {day,value};});
  return deepFreeze({ok:true,code:null,detail:null,days:returns.map(item=>item.day),returns:returns.map(item=>out(item.value))});
}

const ceilTo=(value,step)=>value.div(step).toDecimalPlaces(0,Money.ROUND_CEIL).mul(step);
const floorTo=(value,step)=>value.div(step).toDecimalPlaces(0,Money.ROUND_FLOOR).mul(step);

/**
 * Buy & Hold benchmark (5.3). B1: one buy at the first evaluation bar, verified close of that bar plus adverse slippage,
 * rounded up to the price tick (adverse for a buy, assumption A1 of the build notes); quantity is all initial_cash after fee,
 * rounded down to the quantity step; the residual stays cash. B2: no further trades, marked on the same grid and end
 * treatment, no exit fee in the main line. B3: no funding. B6: unreadable bars give a null row with
 * QR3_BENCHMARK_DATA_UNAVAILABLE. The liquidation line is separate, labelled and off by default (OD-C12).
 * input: {initial_cash, period, grid, data_model:{price_tick,quantity_step}, cost_model:{fee_bps,slippage_bps}, basis_confirmed,
 *   include_liquidation_line}
 */
export function buyAndHold(input){
  const request=isObject(input)?input:{};
  const unavailable=(detail)=>refuse(CODES.QR3_BENCHMARK_DATA_UNAVAILABLE,detail,{value:null});
  if([request.initial_cash,request.data_model?.price_tick,request.data_model?.quantity_step,request.cost_model?.fee_bps,request.cost_model?.slippage_bps].some(isNumber)||
    gridHasNumber(request.grid))return numberRefusal({value:null});
  const gridCheck=checkGrid(request.grid,request.period);
  if(!gridCheck.ok)return unavailable(gridCheck.code);
  const cash=dec(request.initial_cash),tick=dec(request.data_model?.price_tick),step=dec(request.data_model?.quantity_step);
  const feeBps=dec(request.cost_model?.fee_bps),slipBps=dec(request.cost_model?.slippage_bps);
  if(!cash||!tick||!step||!feeBps||!slipBps||!cash.gt(0)||!tick.gt(0)||!step.gt(0)||feeBps.lt(0)||slipBps.lt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'BENCHMARK_INPUT');
  const first=request.grid[0];
  const close0=dec(first.close);
  const price=ceilTo(close0.mul(BPS.plus(slipBps)).div(BPS),tick);
  let quantity=floorTo(cash.div(price.mul(BPS.plus(feeBps).div(BPS))),step);
  let notional=null,fee=null;
  for(let attempt=0;quantity.gt(0)&&attempt<3;attempt+=1){
    notional=round18(quantity.mul(price));
    fee=round18(notional.mul(feeBps).div(BPS));
    if(cash.minus(notional).minus(fee).gte(0))break;
    quantity=quantity.minus(step);
  }
  if(!quantity.gt(0)||cash.minus(notional).minus(fee).lt(0))return refuse(CODES.QR3_METRIC_UNAVAILABLE,'NO_UNITS_AFFORDABLE',{value:null});
  const slippageCost=round18(quantity.mul(price.minus(close0)));
  const valued=valueRun({initial_cash:request.initial_cash,period:request.period,grid:request.grid,flows:[],basis_confirmed:request.basis_confirmed,
    fills:[{bar_time_ms:first.time_ms,side:'BUY',quantity:out(quantity),price:out(price),fee:out(fee),slippage_cost:out(slippageCost)}]});
  if(!valued.ok)return valued;
  let liquidation=null;
  if(request.include_liquidation_line===true){
    const lastClose=dec(request.grid[request.grid.length-1].close);
    const sellPrice=floorTo(lastClose.mul(BPS.minus(slipBps)).div(BPS),tick);
    const proceeds=round18(quantity.mul(sellPrice));
    const exitFee=round18(proceeds.mul(feeBps).div(BPS));
    const cashAfter=cash.minus(notional).minus(fee).plus(proceeds).minus(exitFee);
    liquidation={label:'SIMULATED_LIQUIDATION_NOT_IN_MAIN_LINE',price:out(sellPrice),proceeds:out(proceeds),exit_fee:out(exitFee),end_nav:out(cashAfter),
      net_return_percent:out(round12(cashAfter.div(cash).minus(1).mul(HUNDRED)))};
  }
  return deepFreeze({ok:true,code:null,detail:null,version:QR3_VERSIONS.benchmark,method:'BUY_AND_HOLD_FIRST_BAR_CLOSE_SAME_COST',
    entry:{bar_time_ms:first.time_ms,price:out(price),quantity:out(quantity),notional:out(notional),fee:out(fee),residual_cash:out(cash.minus(notional).minus(fee))},
    valuation:valued,net_return_percent:valued.net_return_percent,net_return_percent_exact:valued.net_return_percent_exact,
    max_drawdown_percent:valued.max_drawdown_percent,liquidation_line:liquidation,funding:'NONE'});
}

/**
 * B5: excess = participant return minus benchmark return, both on the 5.1 basis, in percentage points; null when the benchmark row is
 * null. A refused benchmark keeps its own code and detail in the null (QR3_BENCHMARK_DATA_UNAVAILABLE for unreadable bars,
 * QR3_METRIC_UNAVAILABLE with NO_UNITS_AFFORDABLE when one quantity step is not affordable); the comparison itself is never refused for it.
 */
export function excessReturn(participantExact,benchmark){
  if(isNumber(participantExact)||(isObject(benchmark)&&isNumber(benchmark.net_return_percent_exact)))return deepFreeze({...nullMetric(CODES.QR3_SPEC_INCOMPLETE),detail:NUMBER_DETAIL});
  const a=dec(participantExact);
  if(!a)return nullMetric(CODES.QR3_METRIC_UNAVAILABLE);
  if(!isObject(benchmark)||benchmark.ok!==true){
    const known=isObject(benchmark)&&[CODES.QR3_BENCHMARK_DATA_UNAVAILABLE,CODES.QR3_METRIC_UNAVAILABLE].includes(benchmark.code);
    return deepFreeze({value:null,reason:known?benchmark.code:CODES.QR3_BENCHMARK_DATA_UNAVAILABLE,detail:known?benchmark.detail??null:null});
  }
  const b=dec(benchmark.net_return_percent_exact);
  if(!b)return nullMetric(CODES.QR3_BENCHMARK_DATA_UNAVAILABLE);
  const excess=a.minus(b);
  return deepFreeze({value:out(round12(excess)),exact:out(excess),reason:null});
}
