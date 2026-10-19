import {D} from '../money.js';
import {QR2_DAY_MS,QR2_MARKET,QR2_METHODS,QR2_STATUS,Qr2Error,round12} from './qr2-constants.js';
import {valuePosition} from './qr2-price.js';
import {stateAt} from './qr2-replay.js';
import {navSeeded,costSeeded,intersectsSpan,reconciliationBlocks,splitNullFor} from './qr2-checks.js';
import {numberField} from './qr2-labels.js';
import {utcMidnight} from './qr2-periods.js';

// QR-2 valuation and funding-aware returns (contract 2.5, 3). Pure: prices arrive as stored bar rows, ledger state comes from
// a replay result. Money precision is 80 digits half-even; a market value is rounded once per position per instant to 18
// places and each return once at output to 12 places. Nothing is estimated, interpolated or zero-filled: a number is either
// derived from named rows or null with a reason.

const uniq=list=>[...new Set(list)];

/* ------------------------------------------------------------------ NAV at an instant (2.5) */

/**
 * Raw NAV. Owner views must go through rangePerformance or clampCumulativeNull: a raw result holds cumulative cost balances
 * (realized, e0_clamp_total) that a clamped position cycle makes untrustworthy (RC-Q6, OD-Q10).
 *
 * NAV(t) = cash(t) + MV(t) over events with event time < t. MV is null when a needed price is UNAVAILABLE,
 * PRICE_INTEGRITY_FAILED or UNSUPPORTED_MARKET, and NAV is then null (cash, quantity and cost stay visible). Reserved cash is
 * inside cash and is never added. Before the seeded state of a legacy account NAV is RECONCILIATION_UNAVAILABLE_LEGACY.
 */
export function navAt({replay,seeds,instant,rows=[],option='M',broker=QR2_MARKET.broker,policy}){
  const base={instant,available:false,cash:null,nav:null,market_value:null,position_cost:null,realized:null,unrealized:null,e0_clamp_total:null,cost_reason:null,positions:[],reasons:[]};
  if(!navSeeded(seeds,instant))return {...base,reasons:['RECONCILIATION_UNAVAILABLE_LEGACY']};
  const at=stateAt(replay,instant);
  if(!at.available)return {...base,reasons:[at.reason||'REPLAY_HALTED']};
  const state=at.state,positions=[],reasons=[];
  let marketValue=D(0),allValued=true;
  for(const [symbol,p] of Object.entries(state.positions)){
    const valued=valuePosition({broker,symbol,quantity:p.quantity,instant,rows,option,policy});
    const mv=valued.market_value;
    positions.push({symbol,quantity:p.quantity,cost:p.cost,state:valued.state,price:valued.price,bar_time:valued.bar_time,content_hash:valued.content_hash,age_ms:valued.age_ms,retrieval:valued.retrieval,market_value:mv,unrealized:mv===null?null:D(mv).minus(p.cost).toFixed()});
    if(mv===null){allValued=false;reasons.push(valued.state);}else marketValue=marketValue.plus(mv);
    if(valued.state==='STALE')reasons.push('PRICE_STALE');
  }
  const costOk=costSeeded(seeds,instant);
  return {...base,available:true,cash:state.cash,nav:allValued?D(state.cash).plus(marketValue).toFixed():null,market_value:allValued?marketValue.toFixed():null,
    position_cost:state.position_cost,realized:costOk?state.realized:null,unrealized:allValued&&costOk?marketValue.minus(state.position_cost).toFixed():null,
    e0_clamp_total:state.e0_clamp_total,cost_reason:costOk?null:'COST_UNVERIFIED_LEGACY',positions,reasons:uniq(reasons)};
}

/**
 * SPLIT_NULL (6.6): cost basis, realized and unrealized PnL are null for the affected symbol; cash, quantity, market value,
 * NAV, money PnL and returns stay (NAV is cash + quantity x price and does not depend on cost). splitNull is the Set of
 * symbols from the gate effects; a null member (symbol unknown) affects every symbol. Pure; returns a copy.
 */
export function applySplitNull(nav,splitNull){
  if(!splitNull||!splitNull.size||!nav.available)return nav;
  const all=splitNull.has(null);
  const positions=nav.positions.map(p=>all||splitNull.has(p.symbol)?{...p,cost:null,unrealized:null}:p);
  const hit=all||nav.positions.some(p=>splitNull.has(p.symbol));
  return {...nav,positions,position_cost:hit?null:nav.position_cost,realized:hit?null:nav.realized,unrealized:hit?null:nav.unrealized};
}

// OD-Q10 cumulative values (rulings V3, W3): the cumulative realized PnL and the cumulative E0 clamp balance (e0_clamp_total)
// contain every clamped position cycle that opened at or before the instant, so both are null at every instant at or after the
// cycle's from time, also after the cycle closed. NAV, cash, market value and returns do not depend on them and stay. Pure;
// returns a copy.
export function clampCumulativeNull(nav,effects){
  if(!nav.available||!(effects.split_null_cycles||[]).some(c=>nav.instant>=c.from))return nav;
  return {...nav,realized:null,e0_clamp_total:null};
}

// Exposure (2.5): MV / NAV when both exist and NAV > 0; an account without a price shows EXPOSURE_AT_COST = cost / (cash + cost).
export function exposure(nav){
  if(nav.available&&nav.nav!==null){
    const n=D(nav.nav);
    return n.gt(0)?{value:round12(D(nav.market_value).div(n)),basis:'MARKET_VALUE_OVER_NAV'}:{value:null,basis:null,reason:'NON_POSITIVE_NAV'};
  }
  if(!nav.available)return {value:null,basis:null,reason:nav.reasons[0]};
  const denominator=D(nav.cash).plus(nav.position_cost);
  return denominator.gt(0)?{value:round12(D(nav.position_cost).div(denominator)),basis:'EXPOSURE_AT_COST'}:{value:null,basis:null,reason:'NON_POSITIVE_BASE'};
}

/* ------------------------------------------------------------------ flows and money PnL (3.1) */

/**
 * Flows in [from, to): CONFIGURATION cash_delta rows (O11), summed per distinct instant. Zero amounts are not flows (an
 * equity-only change moves only the unbacked-equity line, never NAV). LEGACY_BASELINE rows are not flows.
 */
export function flowsIn(replay,from,to){
  const byTime=new Map();
  for(const e of replay.events){
    if(e.halted||e.kind!=='FUNDING'||e.funding_kind!=='CONFIGURATION'||e.time<from||e.time>=to)continue;
    byTime.set(e.time,(byTime.get(e.time)||D(0)).plus(e.cash_delta));
  }
  return [...byTime].filter(([,amount])=>!amount.isZero()).sort((a,b)=>a[0]-b[0]).map(([time,amount])=>({time,amount:amount.toFixed()}));
}

// money-pnl-flow-v1: NAV(to) - NAV(from) - sum of flows in [from, to). Null when either NAV is null.
export function moneyPnl({navFrom,navTo,flows}){
  if(navFrom.nav===null||navTo.nav===null)return {value:null,reasons:uniq([...(navFrom.nav===null?navFrom.reasons:[]),...(navTo.nav===null?navTo.reasons:[])])};
  const value=D(navTo.nav).minus(navFrom.nav).minus(flows.reduce((t,f)=>t.plus(f.amount),D(0)));
  return {value:value.toFixed(),reasons:[]};
}

/* ------------------------------------------------------------------ chain-linked index (3.2, 3.4) */

// One chain over the cut points: factor = V_end / V_start with V_start = NAV(cut) + flow at the cut (NAV uses events before the
// cut) and V_end = NAV just before the next cut. A sub-period with start value zero is skipped only when it holds no fill
// and no position; any other start value <= 0 is NON_POSITIVE_BASE; a null boundary NAV is a boundary failure.
function chain({replay,points,flowAt,navFn}){
  let index=D(1);
  const path=[{time:points[0],index:'1'}],subperiods=[];
  for(let i=0;i<points.length-1;i++){
    const start=points[i],end=points[i+1],navStart=navFn(start);
    if(navStart.nav===null)return {ok:false,code:'BOUNDARY_UNVALUED',time:start,reasons:navStart.reasons};
    const vStart=D(navStart.nav).plus(flowAt.get(start)||0);
    const hasFill=replay.events.some(e=>e.kind==='FILL'&&!e.halted&&e.time>=start&&e.time<end);
    const hasPosition=navStart.positions.some(p=>D(p.quantity).gt(0));
    if(vStart.isZero()&&!hasFill&&!hasPosition){subperiods.push({start,end,skipped:true});path.push({time:end,index:index.toFixed()});continue;}
    if(vStart.lte(0))return {ok:false,code:'NON_POSITIVE_BASE',time:start,value:vStart.toFixed()};
    const navEnd=navFn(end);
    if(navEnd.nav===null)return {ok:false,code:'BOUNDARY_UNVALUED',time:end,reasons:navEnd.reasons};
    index=index.mul(D(navEnd.nav).div(vStart));
    subperiods.push({start,end,skipped:false,start_value:vStart.toFixed()});
    path.push({time:end,index:index.toFixed()});
  }
  return {ok:true,index,path,subperiods};
}

// NAV at an instant counting every event at that instant except funding rows: the other order of a same-millisecond flow and fill.
function navFillsFirst({replay,seeds,instant,rows,option,broker,policy}){
  const after=stateAt(replay,instant+1);
  if(!after.available||!navSeeded(seeds,instant))return null;
  const fundingCash=replay.events.filter(e=>e.kind==='FUNDING'&&!e.halted&&e.time===instant).reduce((t,e)=>t.plus(e.cash_delta),D(0));
  let total=D(after.state.cash).minus(fundingCash);
  for(const [symbol,p] of Object.entries(after.state.positions)){
    const valued=valuePosition({broker,symbol,quantity:p.quantity,instant,rows,option,policy});
    if(valued.market_value===null)return null;
    total=total.plus(valued.market_value);
  }
  return total;
}
// The replay order is proven for an instant when R3c matched every event stamped at that instant.
const orderProvenAt=(replay,commitOrder,instant)=>{
  if(!commitOrder||commitOrder.status!=='RUN')return false;
  const results=new Map(commitOrder.results.map(r=>[r.event_key,r.status]));
  return replay.events.filter(e=>e.time===instant).every(e=>results.get(e.key)==='MATCH');
};

/**
 * twr-flow-split-v1. Cuts [from, to) at each distinct flow time; TWR = product of V_end / V_start - 1, rounded once to 12
 * places. Null with TWR_BOUNDARY_UNVALUED (no partial product), NON_POSITIVE_BASE or ORDER_AMBIGUOUS. ORDER_AMBIGUOUS: a flow
 * and a non-flow event share a millisecond, R3c did not prove the order, and the other order gives a different NAV.
 */
export function twr({replay,seeds,from,to,flows,navFn,commitOrder,rows,option,broker,policy}){
  const flowAt=new Map(flows.map(f=>[f.time,D(f.amount)]));
  for(const f of flows){
    const tied=replay.events.filter(e=>e.time===f.time&&e.kind!=='FUNDING'&&!e.halted);
    if(!tied.length||orderProvenAt(replay,commitOrder,f.time))continue;
    const before=navFn(f.time),other=navFillsFirst({replay,seeds,instant:f.time,rows,option,broker,policy});
    if(before.nav!==null&&other!==null&&!D(before.nav).eq(other))return {value:null,reasons:['ORDER_AMBIGUOUS'],detail:{instant:f.time}};
  }
  const points=uniq([from,...flows.map(f=>f.time),to]).sort((a,b)=>a-b);
  const result=chain({replay,points,flowAt,navFn});
  if(!result.ok)return {value:null,reasons:[result.code==='BOUNDARY_UNVALUED'?'TWR_BOUNDARY_UNVALUED':result.code,...(result.reasons||[])],detail:{time:result.time}};
  return {value:round12(result.index.minus(1)),reasons:[],detail:{subperiods:result.subperiods}};
}

/**
 * mwr-modified-dietz-v1 ("Modified Dietz (approximation; secondary)"): w_k = (to - t_k) / (to - from);
 * MD = money_pnl / (NAV(from) + sum w_k x flow_k). A denominator <= 0 is NON_POSITIVE_BASE. Needs prices at the range ends only.
 */
export function modifiedDietz({navFrom,navTo,flows,from,to}){
  const pnl=moneyPnl({navFrom,navTo,flows});
  if(pnl.value===null)return {value:null,reasons:pnl.reasons};
  const span=D(to-from);
  const denominator=flows.reduce((t,f)=>t.plus(D(to-f.time).div(span).mul(f.amount)),D(navFrom.nav));
  if(denominator.lte(0))return {value:null,reasons:['NON_POSITIVE_BASE']};
  return {value:round12(D(pnl.value).div(denominator)),reasons:[]};
}

/* ------------------------------------------------------------------ drawdown grid qr2-grid-daily-events-v1 (3.4) */

// Resolved from, every 00:00Z inside the range, every fill and flow time in [from, to), and the range end (as_of = to).
export function gridPoints({replay,from,to,flows}){
  const points=new Set([from,to]);
  for(let p=utcMidnight(from)+QR2_DAY_MS;p<to;p+=QR2_DAY_MS)points.add(p);
  for(const e of replay.events)if(!e.halted&&e.kind==='FILL'&&e.time>=from&&e.time<to)points.add(e.time);
  for(const f of flows)points.add(f.time);
  return [...points].sort((a,b)=>a-b);
}

/**
 * Maximum peak-to-trough fall of the flow-neutral TWR index sampled on the grid, as a positive fraction rounded to 12 places.
 * Labelled sampled: intraday extremes between grid points are not included. An unvalued grid point gives
 * DRAWDOWN_GRID_UNVALUED and no gap is skipped.
 */
export function drawdown({replay,from,to,flows,navFn}){
  const points=gridPoints({replay,from,to,flows}),flowAt=new Map(flows.map(f=>[f.time,D(f.amount)]));
  const valued=points.filter(t=>navFn(t).nav!==null).length;
  const base={sampled:true,label:'sampled; intraday extremes between grid points are not included',grid:QR2_METHODS.drawdown_grid,grid_points:points.length,valued_points:valued};
  const result=chain({replay,points,flowAt,navFn});
  if(!result.ok)return {value:null,reasons:[result.code==='BOUNDARY_UNVALUED'?'DRAWDOWN_GRID_UNVALUED':result.code],detail:{...base,time:result.time}};
  let peak=D(1),worst=D(0),peakAt=points[0],worstAt=points[0],worstPeakAt=points[0];
  for(const p of result.path){
    const index=D(p.index);
    if(index.gt(peak)){peak=index;peakAt=p.time;}
    const fall=peak.minus(index).div(peak);
    if(fall.gt(worst)){worst=fall;worstAt=p.time;worstPeakAt=peakAt;}
  }
  return {value:round12(worst),reasons:[],detail:{...base,peak_time:worstPeakAt,trough_time:worstAt}};
}

/* ------------------------------------------------------------------ account status (10) */

/**
 * Account status (section 10). REFUSED: a Live or other-Bot row (RP, RX); no number exists. UNAVAILABLE: a failed reconciliation
 * that blocks the range end (reconciliationBlocks(effects, to)), ACCOUNT_UNAVAILABLE, a broken range identity
 * (QR2_IDENTITY_BROKEN), no ledger rows, or both NAV ends missing. COMPLETE: every gate passed, every number present, nothing
 * unresolved. PARTIAL: anything else, with the reasons; a range that ends at or before the failing fill of a replay closure
 * failure is PARTIAL with the information reason RECONCILIATION_FAILED_AFTER_RANGE (RC-Q3). Overlays
 * (LEDGER_INVARIANT_VIOLATED, RECONCILIATION_UNAVAILABLE_LEGACY) are shown with any level. `unresolved` carries the reasons the
 * caller knows and this library does not (legacy, rule epoch, coverage, pending-order uncertainty). `to` is the range end
 * (default performance.range.to; without any end an RT failure is treated as blocking).
 */
export function accountStatus({effects,performance,hasLedgerRows=true,unresolved=[],to}){
  if(effects.refused)return {status:QR2_STATUS.REFUSED,overlays:[],reasons:[effects.refused]};
  const overlays=[],reasons=[...unresolved];
  if(effects.ledger_invariant_violated)overlays.push('LEDGER_INVARIANT_VIOLATED');
  const legacy=[performance?.nav_from,performance?.nav_to].some(n=>n?.reasons?.includes('RECONCILIATION_UNAVAILABLE_LEGACY'));
  if(legacy)overlays.push('RECONCILIATION_UNAVAILABLE_LEGACY');
  const rangeTo=performance?.range?.to;
  if(to!==undefined&&to!==null&&rangeTo!==undefined&&rangeTo!==null&&to!==rangeTo)throw new Qr2Error('QR2_INPUT_INVALID','accountStatus to differs from performance.range.to');
  const end=to??rangeTo??Infinity;
  const identityBroken=performance?.identity?.ok===false;
  const blocked=effects.account_unavailable||identityBroken||reconciliationBlocks(effects,end)||!hasLedgerRows;
  if(blocked)
    return {status:QR2_STATUS.UNAVAILABLE,overlays,reasons:[...(effects.account_unavailable||identityBroken?['ACCOUNT_UNAVAILABLE']:[]),...(identityBroken?['QR2_IDENTITY_BROKEN']:[]),...(effects.reconciliation_failed&&reconciliationBlocks(effects,end)?['RECONCILIATION_FAILED']:[]),...(hasLedgerRows?[]:['NO_LEDGER_ROWS'])]};
  if(effects.reconciliation_failed)reasons.push('RECONCILIATION_FAILED_AFTER_RANGE');
  if(!performance||(performance.nav_from?.nav===null&&performance.nav_to?.nav===null))
    return {status:QR2_STATUS.UNAVAILABLE,overlays,reasons:['NO_VALUED_NAV']};
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])if(performance[key]?.value===null)reasons.push(...performance[key].reasons);
  // SPLIT_NULL counts for the range only: a clamped position cycle that the range does not intersect adds nothing (RC-Q6).
  // A missing range counts every clamp cycle (fail closed, ruling V1).
  const splitNull=splitNullFor(effects,performance.range?.from??-Infinity,performance.range?.to??to??Infinity);
  if(splitNull.size)reasons.push('SPLIT_NULL');
  const unique=uniq(reasons);
  return {status:unique.length?QR2_STATUS.PARTIAL:QR2_STATUS.COMPLETE,overlays,reasons:unique};
}

/* ------------------------------------------------------------------ range performance */

// A number with a value and a gating label is PARTIAL (RC-Q17); an information label such as PRICE_STALE stays COMPLETE.
const GATING_LABELS=new Set(['LEDGER_INVARIANT_VIOLATED']);
const asField=(r,info=[])=>numberField({value:r.value,reasons:r.value===null?r.reasons:[...info],status:r.value!==null&&info.some(x=>GATING_LABELS.has(x))?QR2_STATUS.PARTIAL:undefined});

/**
 * Money PnL, TWR, Modified Dietz and drawdown for [from, to) of one account. Gates first: a failed reconciliation blocks every
 * number; a start before the seeded state has no return (LEGACY_FUNDING_HISTORY_UNAVAILABLE); a period that intersects a
 * ledger-invariant violation span has no return (LEDGER_INVARIANT_VIOLATED) while money PnL stays visible and labelled.
 * The range identity money_pnl = delta R + delta U (R10) is checked when cost is seeded; an E0 clamp contributes its recorded
 * difference. A broken identity is QR2_IDENTITY_BROKEN: the account is ACCOUNT_UNAVAILABLE and has no number (RC-Q5).
 */
export function rangePerformance({replay,seeds,effects,from,to,rows=[],option='M',broker=QR2_MARKET.broker,policy,commitOrder}){
  const cache=new Map(),ctx={replay,seeds,rows,option,broker,policy};
  const rawCache=new Map();
  const rawNav=instant=>{if(!rawCache.has(instant))rawCache.set(instant,navAt({...ctx,instant}));return rawCache.get(instant);};
  const navFn=instant=>{if(!cache.has(instant))cache.set(instant,clampCumulativeNull(rawNav(instant),effects));return cache.get(instant);};
  const none=reasons=>({money_pnl:numberField({value:null,reasons}),twr:numberField({value:null,reasons}),mwr:numberField({value:null,reasons}),max_drawdown:numberField({value:null,reasons})});
  const methods={return_method:QR2_METHODS.return_method,rounding:QR2_METHODS.rounding,drawdown_grid:QR2_METHODS.drawdown_grid};
  if(effects.refused)return {range:{from,to},...none([effects.refused]),refused:effects.refused,flows:[],methods};
  if(effects.account_unavailable)return {range:{from,to},...none(['ACCOUNT_UNAVAILABLE']),flows:[],methods};
  if(reconciliationBlocks(effects,to))return {range:{from,to},...none(['RECONCILIATION_FAILED']),flows:[],methods};
  const navFrom=navFn(from),navTo=navFn(to),flows=flowsIn(replay,from,to),pnl=moneyPnl({navFrom,navTo,flows});
  // RC-Q5/RC-Q6: the identity runs on the raw NAV at both ends, so a clamp cycle never switches it off. When a clamp cycle
  // opens at or before `to`, the displayed cumulative realized is null and `expected` (dR + dU) is not shown.
  let identity={checked:false};
  const rawFrom=rawNav(from),rawTo=rawNav(to);
  if(pnl.value!==null&&rawFrom.realized!==null&&rawTo.realized!==null&&rawFrom.unrealized!==null&&rawTo.unrealized!==null){
    const expected=D(rawTo.realized).minus(rawFrom.realized).plus(D(rawTo.unrealized).minus(rawFrom.unrealized)).plus(D(rawTo.e0_clamp_total).minus(rawFrom.e0_clamp_total));
    const hidden=(effects.split_null_cycles||[]).some(c=>to>=c.from);
    // e0_clamp_delta is hidden with expected: next to the shown nav_from it would rebuild the clamped cumulative balance.
    identity={checked:true,ok:expected.eq(pnl.value),...(hidden?{}:{expected:expected.toFixed()}),actual:pnl.value,...(hidden?{}:{e0_clamp_delta:D(rawTo.e0_clamp_total).minus(rawFrom.e0_clamp_total).toFixed()})};
    if(!identity.ok)return {range:{from,to},...none(['QR2_IDENTITY_BROKEN']),account_unavailable:true,flows,identity:{...identity,code:'QR2_IDENTITY_BROKEN'},methods};
  }
  const violated=intersectsSpan(effects.ledger_invariant_spans,from,to),splitNull=splitNullFor(effects,from,to);
  let blockReason=null;
  if(from<seeds.nav_from)blockReason='LEGACY_FUNDING_HISTORY_UNAVAILABLE';
  else if(violated)blockReason='LEDGER_INVARIANT_VIOLATED';
  const returns=blockReason
    ?{twr:{value:null,reasons:[blockReason]},mwr:{value:null,reasons:[blockReason]},dd:{value:null,reasons:[blockReason]}}
    :{twr:twr({...ctx,from,to,flows,navFn,commitOrder}),mwr:modifiedDietz({navFrom,navTo,flows,from,to}),dd:drawdown({replay,from,to,flows,navFn})};
  const stale=uniq([...navFrom.reasons,...navTo.reasons]).filter(r=>r==='PRICE_STALE');
  return {range:{from,to},nav_from:applySplitNull(navFrom,splitNull),nav_to:applySplitNull(navTo,splitNull),flows,identity,
    money_pnl:asField(pnl,[...(violated?['LEDGER_INVARIANT_VIOLATED']:[]),...stale]),twr:asField(returns.twr),mwr:asField(returns.mwr),max_drawdown:asField(returns.dd),
    detail:{twr:returns.twr.detail,drawdown:returns.dd.detail},methods};
}
