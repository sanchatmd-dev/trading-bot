import {D,amount,exact} from '../money.js';
import {canonical,hash} from '../pine-bridge/source.js';
import {evaluateRisk} from '../postgres/risk.js';
import {levels,exitDecision,executionPrice} from '../pine-bridge/contract.js';
import {roundBridgeOrder} from '../postgres/pine-bridge-execution.js';
import {MP_CODES,MP_SAME_BAR_ORDER,MP_MAX_MEMBERS} from './codes.js';

/*
 * F11 S2: pure Node oracle for the combined multi-Pine Paper ledger (docs/MULTI_PINE_CONTRACT.md 5.4 to 5.7, RD-MP-24 to RD-MP-30).
 *
 * Signals in, ledger out. Per-member Bridge intents are regenerated here from the member signal vectors with the production
 * `levels`, `exitDecision` and `executionPrice`, ordered by `exit-first-ordinal-v1`, decided with the production `evaluateRisk`
 * and `roundBridgeOrder`, and booked into ONE Bot account by the Node ledger rules (the same statements as the one-member
 * reference loop in scripts/quant-bridge-reference.mjs, generalised to many members). Nothing here calls prepareBridgeExecution,
 * the ledger or the Risk Manager, and no Python output is read to produce the oracle result: only `compareCombined` reads both.
 *
 * Pure: no database, file, network, clock, randomness or process state. Nothing in a runtime root may import this module.
 */

export const ORACLE_VERSION='mp-combined-oracle-v1';
export const BASELINE_VERSION='mp-combined-baseline-v1';
/** Per-entry and final cash (and cost) bound of the baseline: one minor unit of the quote currency (RD-MP-30, ql2a.compare_replays). */
export const CASH_TOLERANCE='0.01';
const MODEL_VERSION='paper-close-v1';
const BRIDGE_CAPACITY=1000;
const MAX_SCALE=18;
export const REALIZED_R_TOLERANCE='0.000000000001';
const POLICY_KEYS=['killSwitch','maxSignalAgeSeconds','maxTradesPerDay','maxDailyLossR','pauseAfterLossStreak','blockHighVolatility','maxVolatilityPercent',
  'blockDuringNews','allowedSymbols','sideMode','maxOpenPositions','onePositionPerSymbol','capPercentEquitySize','maxRiskPercent','maxOrderNotional','maxDailyNotional'];
const EXIT_REASONS=['SL','TP','NATIVE'];

const refuse=(code,detail)=>Object.assign(new Error(detail?code+':'+detail:code),{code});
const invalid=detail=>refuse(MP_CODES.INPUT_INVALID,detail);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isDecimalInput=value=>(typeof value==='string'||typeof value==='number');
/** Positive finite decimal accepted by production `D` (string or number). */
function positive(value,label){
  try{if(!isDecimalInput(value)||!D(value).gt(0))throw 0;}catch{throw invalid(label);}
  return value;
}
function nonNegative(value,label,max){
  try{if(!isDecimalInput(value))throw 0;const d=D(value);if(d.lt(0)||(max!==undefined&&d.gt(max)))throw 0;}catch{throw invalid(label);}
  return value;
}

/** Entry reference owner, derived from the key: `<deployment_id>:<bar time>:0` (CODE: BridgeReplay), exactly Python `rsplit(":", 2)[0]`. */
export function entryOwner(entryRef){
  if(typeof entryRef!=='string')return null;
  const last=entryRef.lastIndexOf(':');
  if(last<1)return null;
  const middle=entryRef.lastIndexOf(':',last-1);
  return middle<1?null:entryRef.slice(0,middle);
}

/* ------------------------------------------------------------------ input normalisation */

function normalizeModel(model){
  if(!isObject(model))throw invalid('model');
  if(model.version!==undefined&&model.version!==MODEL_VERSION)throw invalid('model.version');
  positive(model.price_tick,'model.price_tick');positive(model.quantity_step,'model.quantity_step');positive(model.risk_percent,'model.risk_percent');
  if(D(model.risk_percent).gt(100))throw invalid('model.risk_percent');
  nonNegative(model.fee_bps,'model.fee_bps',1000);nonNegative(model.slippage_bps,'model.slippage_bps',1000);
  // fee = notional x bps / 10000 is rounded at 18 places by the production ledger; a model whose own scale exceeds that is not representable (N1)
  if(D(model.quantity_step).decimalPlaces()+D(model.price_tick).decimalPlaces()+D(model.fee_bps).decimalPlaces()+4>MAX_SCALE)throw invalid('model.scale');
  return {price_tick:model.price_tick,quantity_step:model.quantity_step,fee_bps:model.fee_bps,slippage_bps:model.slippage_bps,risk_percent:model.risk_percent,version:MODEL_VERSION};
}

/** N5: optional run binding, passed through to the baseline record unread (S3 supplies it); never used by the ledger. */
function normalizeBinding(binding){
  if(binding===undefined||binding===null)return null;
  if(!isObject(binding)||Object.keys(binding).sort().join()!=='contract_hash,run_id'||typeof binding.run_id!=='string'||!binding.run_id||typeof binding.contract_hash!=='string'||!binding.contract_hash)throw invalid('binding');
  return {run_id:binding.run_id,contract_hash:binding.contract_hash};
}

function normalizePolicy(policy){
  if(!isObject(policy))throw invalid('policy');
  const missing=POLICY_KEYS.filter(key=>!Object.hasOwn(policy,key));
  if(missing.length)throw invalid('INCOMPLETE_NODE_POLICY:'+missing.sort().join(','));
  return policy;
}

function normalizePair(pair){
  if(!isObject(pair))throw invalid('pair');
  const keysOf=Object.keys(pair).sort();
  if(keysOf.length!==2||keysOf[0]!=='atr_multiplier'||keysOf[1]!=='rr')throw invalid('pair');
  positive(pair.atr_multiplier,'pair.atr_multiplier');positive(pair.rr,'pair.rr');
  return {atr_multiplier:String(pair.atr_multiplier),rr:String(pair.rr)};
}

function normalizeBars(bars){
  if(!Array.isArray(bars)||bars.length===0)throw invalid('bars');
  let previous=0;
  return bars.map(bar=>{
    if(!isObject(bar)||!Number.isSafeInteger(bar.time)||bar.time<=0)throw invalid('bars.time');
    if(bar.time<=previous)throw refuse('NON_MONOTONIC_CLOSED_BARS');
    previous=bar.time;
    for(const field of ['open','high','low','close'])positive(bar[field],'bars.'+field);
    if(!(D(bar.low).lte(D(bar.open).lt(bar.close)?bar.open:bar.close)&&D(bar.high).gte(D(bar.open).gt(bar.close)?bar.open:bar.close)))throw invalid('bars.range');
    if(bar.atr14!==null&&bar.atr14!==undefined)nonNegative(bar.atr14,'bars.atr14');
    return {time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,atr14:bar.atr14??null};
  });
}

/**
 * Accepted member signal vectors, one entry per bar, both values strict booleans:
 *   [[buy, native_exit], ...]  |  [{buy, native_exit}, ...]  |  {buy:[...], native_exit:[...]}
 */
function normalizeSignals(signals,count){
  let pairs;
  if(Array.isArray(signals))pairs=signals.map(item=>Array.isArray(item)?[item[0],item[1]]:isObject(item)?[item.buy,item.native_exit]:[undefined,undefined]);
  else if(isObject(signals)&&Array.isArray(signals.buy)&&Array.isArray(signals.native_exit)&&signals.buy.length===signals.native_exit.length)
    pairs=signals.buy.map((buy,index)=>[buy,signals.native_exit[index]]);
  else throw invalid('signals');
  if(pairs.length!==count)throw invalid('signals.length');
  if(pairs.some(([buy,exit])=>typeof buy!=='boolean'||typeof exit!=='boolean'))throw refuse('BOOLEAN_SIGNAL_REQUIRED');
  return {buy:pairs.map(pair=>pair[0]),native_exit:pairs.map(pair=>pair[1])};
}

function normalizeMembers(members,count){
  if(!Array.isArray(members)||members.length<1||members.length>MP_MAX_MEMBERS)throw invalid('members');
  const ids=new Set();
  return members.map((member,index)=>{
    if(!isObject(member)||member.ordinal!==index+1)throw invalid('members.ordinal');
    if(typeof member.deployment_id!=='string'||member.deployment_id.length===0||ids.has(member.deployment_id))throw invalid('members.deployment_id');
    ids.add(member.deployment_id);
    const signals=normalizeSignals(member.signals,count);
    return {ordinal:member.ordinal,deployment_id:member.deployment_id,buy:signals.buy,native_exit:signals.native_exit};
  });
}

/* ------------------------------------------------------------------ per-member Pine entry arrays (BridgeReplay) */

/** Node form of one member's Bridge replay: Pine entry array, descending EXIT traversal, BUY suppression on an own exit bar. */
export class MemberReplay{
  constructor(deploymentId,pair,model){
    this.deploymentId=deploymentId;this.pair=pair;this.model=model;this.entries=[];this.lastTime=0;
  }
  step(bar,buy,nativeExit){
    if(typeof buy!=='boolean'||typeof nativeExit!=='boolean')throw refuse('BOOLEAN_SIGNAL_REQUIRED');
    if(bar.time<=this.lastTime)throw refuse('NON_MONOTONIC_CLOSED_BARS');
    this.lastTime=bar.time;
    const intents=[];let exitBar=nativeExit,suppressed=null;
    for(let i=this.entries.length-1;i>=0;i--){
      const entry=this.entries[i],decision=exitDecision(entry,bar,nativeExit);
      if(decision){intents.push({event_type:'EXIT',time:bar.time,entry_ref:entry.entry_ref,sequence:intents.length,reason:decision.reason,sl:null,tp:null});this.entries.splice(i,1);exitBar=true;}
    }
    if(buy&&exitBar)suppressed='exit_bar';
    else if(buy&&bar.atr14===null)suppressed='no_atr';
    else if(buy){
      let protection;
      try{protection=levels(Number(bar.close),Number(bar.atr14),Number(this.pair.atr_multiplier),Number(this.pair.rr),Number(this.model.price_tick));}
      catch(error){if(error.code==='INVALID_ENTRY_LEVELS')protection=null;else throw error;}
      if(protection===null)suppressed='invalid_levels';
      else{
        if(this.entries.length>=BRIDGE_CAPACITY)throw refuse('BRIDGE_INTENT_CAPACITY_REACHED');
        const entry_ref=this.deploymentId+':'+bar.time+':0';
        this.entries.push({time:bar.time,entry_ref,...protection});
        intents.push({event_type:'BUY',time:bar.time,entry_ref,sequence:0,reason:null,...protection});
      }
    }
    return {intents,suppressed};
  }
}

/* ------------------------------------------------------------------ same-bar order */

/**
 * exit-first-ordinal-v1 (RD-MP-26): every member's EXIT intents first, ascending ordinal, each member in its own traversal order;
 * then every member's BUY intents, ascending ordinal. `stepped` is in ascending ordinal.
 */
export function orderBarIntents(stepped){
  const ordered=[];
  for(const item of stepped)for(const intent of item.intents)if(intent.event_type==='EXIT')ordered.push({member:item.member,intent});
  for(const item of stepped)for(const intent of item.intents)if(intent.event_type==='BUY')ordered.push({member:item.member,intent});
  return ordered;
}

/* ------------------------------------------------------------------ Bot ledger (one account, many members) */

const emptyReasons=()=>Object.fromEntries(EXIT_REASONS.map(reason=>[reason,0]));
const bump=(map,key)=>{map[key]=(map[key]??0)+1;};
const newFunnel=member=>({ordinal:member.ordinal,deployment_id:member.deployment_id,native_buy:0,native_exit:0,intents_buy:0,intents_exit:emptyReasons(),pre_start_intents:0,
  suppressed_buy:{exit_bar:0,no_atr:0,invalid_levels:0},accepted_buy:0,capped_buy:0,rejected_buy:{},exits_filled:emptyReasons(),exits_rejected:{},orphan_exits:{warmup_entry:0,refused_entry:0}});

/**
 * Bot state by the Node ledger rules (ledger.js: position quantity and cost, initial risk and pnl reset at Bot flat, loss streak moves only
 * at Bot flat, UTC-day map with accepted BUY and EXIT counted; allocations keyed by entry_ref, owner = key prefix).
 */
export function createCombinedLedger({members,model,policy,equity,cash,broker,symbol,start_time}){
  const startingCash=D(cash),feeRatio=D(model.fee_bps).div(10000);
  const positions=new Map(),daily=new Map(),seen=new Set(),funnels=new Map(),warmupRefs=new Set(),refusedRefs=new Set(),owners=new Map();
  for(const member of members){funnels.set(member.deployment_id,newFunnel(member));owners.set(member.deployment_id,member);}
  const events=[],decisions=[],fills=[];
  let money=D(cash),cost=D(0),quantity=D(0),initialRisk=D(0),pnl=D(0),lossStreak=0,duplicates=0;

  function book(bar,member,event){
    const funnel=funnels.get(member.deployment_id);
    if(entryOwner(event.entry_ref)!==member.deployment_id)throw refuse(MP_CODES.CROSS_SOURCE_TARGET);
    const key=member.deployment_id+'\u0000'+event.event_type+'\u0000'+event.entry_ref;
    if(seen.has(key)){duplicates++;return;}
    seen.add(key);
    events.push(event);
    const warmup=start_time!==undefined&&start_time!==null&&event.time<start_time;
    // intents count over ALL input rows (pre-start included); pre_start_intents is the part before the ledger start (RD-MP-24 window rule)
    if(event.event_type==='BUY')funnel.intents_buy++;else bump(funnel.intents_exit,event.reason);
    if(warmup){funnel.pre_start_intents++;if(event.event_type==='BUY')warmupRefs.add(event.entry_ref);return;}
    const day=new Date(event.time).toISOString().slice(0,10);
    const stats=daily.get(day)??{trades:0,notional:'0',realized_r:'0',loss_streak:0};stats.loss_streak=lossStreak;
    const target=positions.get(event.entry_ref);
    let reason=event.event_type==='EXIT'&&!target?'TARGET_NOT_OPEN':null;
    const signal={broker,symbol,timeframe:'1',event:event.event_type==='BUY'?'BUY':'SELL',side:event.event_type==='BUY'?'BUY':'SELL',reduceOnly:event.event_type==='EXIT',leverage:1,timestamp:event.time,
      referencePrice:executionPrice(Number(bar.close),event.event_type,Number(model.slippage_bps),Number(model.price_tick)),
      ...(event.event_type==='BUY'?{stopLoss:event.sl,takeProfit:event.tp,riskMode:'PERCENT_EQUITY',riskValue:model.risk_percent}:{targetTradeId:event.entry_ref}),
      volatilityPercent:D(bar.high).minus(bar.low).div(bar.close).mul(100).toNumber()};
    const context={policy,daily:stats,position:{quantity:exact(quantity)},targetAllocation:target?{remaining_quantity:target.quantity}:null,now:event.time,
      equity:amount(D(equity).plus(money.minus(startingCash)).plus(cost)),balance:exact(money),cashAvailable:amount(event.event_type==='BUY'?money.div(D(1).plus(feeRatio)):money),
      committedNotional:exact(cost),reservedNotional:'0',reservedTrades:0,openPositions:quantity.gt(0)?1:0,licensed:true,globalKill:false,hasPendingOrder:false};
    const risk=reason?{ok:false,reason}:evaluateRisk(signal,context);
    let order,fee;
    if(risk.ok){try{({order,fee}=roundBridgeOrder(risk.order,model));}catch(error){reason=error.code??error.message;}}
    else reason=risk.reason;
    if(reason){
      decisions.push({...event,outcome:'REJECTED',reason,quantity:'0',fee:'0'});
      if(event.event_type==='BUY'){refusedRefs.add(event.entry_ref);bump(funnel.rejected_buy,reason);}
      else{
        bump(funnel.exits_rejected,reason);
        if(reason==='TARGET_NOT_OPEN')funnel.orphan_exits[warmupRefs.has(event.entry_ref)?'warmup_entry':'refused_entry']++;
      }
      return;
    }
    const q=D(order.quantity),notional=D(order.notional),f=D(fee);
    let realizedR=D(0);
    if(event.event_type==='BUY'){
      money=money.minus(notional).minus(f);cost=cost.plus(notional).plus(f);quantity=quantity.plus(q);
      initialRisk=D(amount(initialRisk.plus(q.mul(D(order.price).minus(event.sl).abs()))));
      positions.set(event.entry_ref,{quantity:exact(q),entry_price:amount(notional.plus(f).div(q))});
    }else{
      const removed=q.mul(target.entry_price),profit=notional.minus(removed).minus(f);
      money=money.plus(notional).minus(f);cost=cost.minus(removed);quantity=quantity.minus(q);pnl=D(amount(pnl.plus(profit)));
      realizedR=initialRisk.gt(0)?profit.div(initialRisk):D(0);
      positions.delete(event.entry_ref);
      if(quantity.isZero()){lossStreak=pnl.lt(0)?lossStreak+1:0;initialRisk=D(0);pnl=D(0);}
    }
    if(money.lt(0)||quantity.lt(0)||cost.lt(0))throw refuse('NEGATIVE_SPOT_LEDGER');
    stats.trades++;stats.notional=amount(D(stats.notional).plus(notional));stats.realized_r=amount(D(stats.realized_r).plus(amount(realizedR)));daily.set(day,stats);
    const capped=Boolean(order.sizingAdjustment);
    const fill={...event,outcome:'FILLED',sizing_outcome:capped?'CAPPED':'ACCEPTED',sizing_adjustment:order.sizingAdjustment??null,quantity:exact(q),price:order.price,
      notional:exact(notional),fee:exact(f),cash:amount(money),cost:amount(cost),realized_r:amount(realizedR)};
    fills.push(fill);decisions.push(fill);
    if(event.event_type==='BUY')funnel[capped?'capped_buy':'accepted_buy']++;else bump(funnel.exits_filled,event.reason);
  }

  return {
    funnels,
    /** `ordered` is [{member:{ordinal,deployment_id},intent}] in processing order. Intents are copied before booking. */
    processBar(bar,ordered){for(const {member,intent} of ordered)book(bar,member,{...intent});},
    result(){
      return {
        ledger:{events,decisions,fills,final_cash:amount(money),position_quantity:exact(quantity),position_cost:amount(cost),open_allocations:positions.size},
        // a foreign producer throws before any ledger change, so a returned result always carries cross_source_target 0
        counters:{cross_source_target:0,duplicate_intents:duplicates}
      };
    }
  };
}

/* ------------------------------------------------------------------ oracle run */

const ZERO_FUNNEL_SUM=()=>({native_buy:0,native_exit:0,intents_buy:0,intents_exit:emptyReasons(),pre_start_intents:0,suppressed_buy:{exit_bar:0,no_atr:0,invalid_levels:0},
  accepted_buy:0,capped_buy:0,rejected_buy:{},exits_filled:emptyReasons(),exits_rejected:{},orphan_exits:{warmup_entry:0,refused_entry:0}});
function addInto(target,source){
  for(const [key,value] of Object.entries(source)){
    if(key==='ordinal'||key==='deployment_id')continue;
    if(typeof value==='number')target[key]=(target[key]??0)+value;
    else{target[key]??={};addInto(target[key],value);}
  }
}
/** Bot-level funnel: the field-wise sum of the member funnels (MPC 5.7 "they sum to the Bot-level counts"). */
export function sumFunnels(list){const bot=ZERO_FUNNEL_SUM();for(const funnel of list)addInto(bot,funnel);return bot;}

/**
 * Same as `runCombinedOracle` with the same-bar order function injected. Exists so a test can build a wrong-order ledger and prove the
 * comparison rejects it; the executor uses `runCombinedOracle` only.
 */
export function runOracleWithOrder(input,orderFunction){
  if(!isObject(input))throw invalid('input');
  if(input.same_bar_order!==MP_SAME_BAR_ORDER)throw refuse(MP_CODES.EVENT_ORDER_UNDEFINED);
  const bars=normalizeBars(input.bars),members=normalizeMembers(input.members,bars.length);
  const pair=normalizePair(input.pair),model=normalizeModel(input.model),policy=normalizePolicy(input.policy);
  positive(input.equity,'equity');positive(input.cash,'cash');
  if(typeof input.broker!=='string'||typeof input.symbol!=='string'||!input.broker||!input.symbol)throw invalid('broker/symbol');
  if(input.start_time!==undefined&&input.start_time!==null&&!Number.isSafeInteger(input.start_time))throw invalid('start_time');
  const startTime=input.start_time??null;
  const binding=normalizeBinding(input.binding);
  const replays=members.map(member=>new MemberReplay(member.deployment_id,pair,model));
  const ledger=createCombinedLedger({members,model,policy,equity:input.equity,cash:input.cash,broker:input.broker,symbol:input.symbol,start_time:startTime??undefined});
  bars.forEach((bar,index)=>{
    const stepped=members.map((member,k)=>{
      const out=replays[k].step(bar,member.buy[index],member.native_exit[index]);
      // native signals and suppressed/skipped BUYs count over ALL input rows, warm-up included (the Python diagnostics window)
      const funnel=ledger.funnels.get(member.deployment_id);
      if(member.buy[index])funnel.native_buy++;
      if(member.native_exit[index])funnel.native_exit++;
      if(out.suppressed)funnel.suppressed_buy[out.suppressed]++;
      return {member:{ordinal:member.ordinal,deployment_id:member.deployment_id},intents:out.intents};
    });
    ledger.processBar(bar,orderFunction(stepped));
  });
  const {ledger:book,counters}=ledger.result();
  const funnels=members.map(member=>ledger.funnels.get(member.deployment_id));
  return {
    version:ORACLE_VERSION,
    ledger:book,
    diagnostics:{
      version:ORACLE_VERSION,same_bar_order:MP_SAME_BAR_ORDER,
      members:funnels,bot:sumFunnels(funnels),
      cross_source_target:counters.cross_source_target,duplicate_intents:counters.duplicate_intents
    },
    meta:{
      binding,pair,model,policy_hash:hash(canonical(policy)),start_time:startTime,cash:String(input.cash),equity:String(input.equity),broker:input.broker,symbol:input.symbol,
      rows:bars.length,first_time:bars[0].time,last_time:bars[bars.length-1].time,bars_hash:hash(canonical(bars)),
      signals_hash:members.map(member=>({ordinal:member.ordinal,deployment_id:member.deployment_id,signals_hash:hash(canonical([member.buy,member.native_exit]))}))
    }
  };
}

/**
 * Oracle entry point.
 * input = {
 *   members: [{ordinal, deployment_id, signals}]      1 to 3, dense ascending ordinals from 1, distinct non-empty deployment ids
 *     signals: [[buy, native_exit], ...] | [{buy, native_exit}, ...] | {buy:[...], native_exit:[...]}   one strict-boolean entry per bar
 *   bars:   [{time, open, high, low, close, atr14}]   closed 1m bars (UTC ms), strictly increasing; decimal strings or numbers; atr14 may be null
 *   pair:   {atr_multiplier, rr}                      one shared pair (members carry none)
 *   model:  {price_tick, quantity_step, fee_bps, slippage_bps, risk_percent, version?:'paper-close-v1'}
 *   policy: the 16-key Node risk policy (killSwitch ... maxDailyNotional), as node_policy expects
 *   equity, cash: positive decimals; broker, symbol; start_time: ledger start in UTC ms (events before it stay in `events` only)
 *   binding (optional): {run_id, contract_hash}, copied unread into meta and the baseline record (S3 fills it); it changes no ledger value
 *   same_bar_order: 'exit-first-ordinal-v1' (any other value, or none, throws MP_EVENT_ORDER_UNDEFINED)
 * }
 * Returns {version, ledger, diagnostics, meta}; `ledger` has exactly the seven keys of the one-member reference replay.
 */
export function runCombinedOracle(input){return runOracleWithOrder(input,orderBarIntents);}

/* ------------------------------------------------------------------ comparison (mp-combined-baseline-v1) */

const dec=value=>{try{return value===null||value===undefined?null:D(value);}catch{return null;}};
/** Decimal equality; two nulls are equal, a malformed or one-sided value is not. */
const decEq=(a,b)=>{if((a===null||a===undefined)&&(b===null||b===undefined))return true;const x=dec(a),y=dec(b);return x!==null&&y!==null&&x.eq(y);};
/** Absolute difference as a decimal, or null when either side is not a decimal. */
const decDelta=(a,b)=>{const x=dec(a),y=dec(b);return x===null||y===null?null:x.minus(y).abs();};
const maxOf=(current,next)=>next!==null&&next.gt(current)?next:current;
const arrayOf=value=>Array.isArray(value)?value:null;
const plain=value=>JSON.parse(JSON.stringify(value??null));

/** Python member rows: `diagnostics.members` as an array of {ordinal, deployment_id, ...funnel}. Any other shape is not a member list. */
const memberRows=diagnostics=>Array.isArray(diagnostics?.members)?diagnostics.members:null;
const ordinalOf=row=>Number.isInteger(row.ordinal)?row.ordinal:Number.POSITIVE_INFINITY;
/** Ordinal order, then deployment id: both sides are sorted before the member tags are compared (N4). */
const byOrdinal=(a,b)=>ordinalOf(a)<ordinalOf(b)?-1:ordinalOf(a)>ordinalOf(b)?1:String(a.deployment_id)<String(b.deployment_id)?-1:String(a.deployment_id)>String(b.deployment_id)?1:0;

/* ---- funnel name map: the Python diagnostics keys on one side, the oracle funnel on the other (B2) */
const sumValues=map=>Object.values(map).reduce((a,b)=>a+b,0);
const mergeCounts=(...maps)=>{const out={};for(const map of maps)for(const [key,value] of Object.entries(map))out[key]=(out[key]??0)+value;return out;};
/**
 * Python diagnostics key -> value derived from one oracle funnel. Every key is required in every Python member row and in `bot`; a missing key is a difference.
 * Windows: all counts cover ALL rows of the step input, warm-up included; `pre_start_intents` is the part of the intents with time < start_time.
 *   accepted/capped: BUY fills (capped includes quantity-step rounding); rejected: exact reason strings, BUY and EXIT rejections together;
 *   exit_fills: by reason; suppressed_buys: BUY dropped on the member's own exit bar; skipped_buys: native BUY with no intent (no ATR or invalid levels).
 */
export const PYTHON_FUNNEL_MAP=Object.freeze({
  native_buy:f=>f.native_buy,
  native_exit:f=>f.native_exit,
  intents_buy:f=>f.intents_buy,
  intents_exit:f=>sumValues(f.intents_exit),
  pre_start_intents:f=>f.pre_start_intents,
  accepted:f=>f.accepted_buy,
  capped:f=>f.capped_buy,
  rejected:f=>mergeCounts(f.rejected_buy,f.exits_rejected),
  exit_fills:f=>f.exits_filled,
  suppressed_buys:f=>f.suppressed_buy.exit_bar,
  skipped_buys:f=>f.suppressed_buy.no_atr+f.suppressed_buy.invalid_levels
});
const MAP_KEYS=new Set(['rejected','exit_fills']);
export const pythonFunnelView=funnel=>Object.fromEntries(Object.entries(PYTHON_FUNNEL_MAP).map(([key,from])=>[key,from(funnel)]));
/** A count map {reason: n} compares without its zero entries; anything but non-negative integers is invalid (null). */
const countMap=value=>isObject(value)&&Object.values(value).every(n=>Number.isInteger(n)&&n>=0)?canonical(Object.fromEntries(Object.entries(value).filter(([,n])=>n>0))):null;
const sameCount=(key,left,right)=>{
  if(MAP_KEYS.has(key)){const a=countMap(left),b=countMap(right);return a!==null&&a===b;}
  return Number.isInteger(left)&&left>=0&&left===right;
};
/** Number of mapped keys of a Python funnel object that are absent or differ from the expected view. */
function funnelMismatches(row,expected){
  let count=0;
  for(const key of Object.keys(PYTHON_FUNNEL_MAP))if(!isObject(row)||!Object.hasOwn(row,key)||!sameCount(key,row[key],expected[key]))count++;
  return count;
}
/** Field-wise sum of Python member rows per mapped key (int sum, or merged count map); null where a row's value is not valid. */
function sumPythonRows(rows){
  const out={};
  for(const key of Object.keys(PYTHON_FUNNEL_MAP)){
    if(MAP_KEYS.has(key)){const maps=rows.map(row=>row[key]);out[key]=maps.every(map=>countMap(map)!==null)?mergeCounts(...maps):null;}
    else out[key]=rows.every(row=>Number.isInteger(row[key]))?rows.reduce((a,row)=>a+row[key],0):null;
  }
  return out;
}

/**
 * Per-member funnel derived from ledger records only, by entry_ref owner (an extra check beside the diagnostics comparison: it shows the
 * two ledgers carry the same intents, fills and rejections per member). Intents count over all events; `pre_start_intents` is the part before the start.
 */
export function deriveFunnel(ledger,startTime){
  const byMember=new Map();
  const slot=id=>{if(!byMember.has(id))byMember.set(id,{intents_buy:0,intents_exit:emptyReasons(),pre_start_intents:0,accepted_buy:0,capped_buy:0,rejected_buy:{},exits_filled:emptyReasons(),exits_rejected:{}});return byMember.get(id);};
  const warm=time=>startTime!==null&&startTime!==undefined&&time<startTime;
  for(const event of ledger.events){
    const funnel=slot(entryOwner(event.entry_ref));
    if(event.event_type==='BUY')funnel.intents_buy++;else bump(funnel.intents_exit,event.reason);
    if(warm(event.time))funnel.pre_start_intents++;
  }
  for(const decision of ledger.decisions){
    const funnel=slot(entryOwner(decision.entry_ref));
    if(decision.event_type==='BUY'){
      if(decision.outcome==='FILLED')funnel[decision.sizing_outcome==='CAPPED'?'capped_buy':'accepted_buy']++;
      else bump(funnel.rejected_buy,decision.reason);
    }else if(decision.outcome==='FILLED')bump(funnel.exits_filled,decision.reason);
    else bump(funnel.exits_rejected,decision.reason);
  }
  return byMember;
}
const sorted=value=>canonical(value);

/** One fills record against the oracle fill: identity, sizing, levels, exact decimals and R within its tolerance (N2). Cash and cost go to the shared cash bound. */
function sameFill(left,right,rTolerance){
  if(!isObject(left)||!isObject(right))return false;
  if(['event_type','time','entry_ref','sequence','reason','outcome','sizing_outcome'].some(key=>left[key]!==right[key]))return false;
  const la=left.sizing_adjustment,ra=right.sizing_adjustment;
  if(Boolean(la)!==Boolean(ra))return false;
  if(la&&ra&&(la.reason!==ra.reason||!decEq(la.requestedQuantity,ra.requestedQuantity)||!decEq(la.quantity,ra.quantity)))return false;
  if(right.event_type==='BUY'&&(!decEq(left.sl,right.sl)||!decEq(left.tp,right.tp)))return false;
  for(const key of ['quantity','price','notional','fee'])if(!decEq(left[key],right[key]))return false;
  const rDelta=decDelta(left.realized_r,right.realized_r);
  return rDelta!==null&&rDelta.lte(rTolerance);
}

/**
 * compareCombined(pythonResult, oracleResult) -> mp-combined-baseline-v1 record (RD-MP-30).
 *   pythonResult = {ledger:{events,decisions,fills,final_cash,position_quantity,position_cost,open_allocations},
 *                   diagnostics:{members:[{ordinal,deployment_id,...PYTHON_FUNNEL_MAP keys}], bot:{PYTHON_FUNNEL_MAP keys}, cross_source_target, duplicate_intents, same_bar_order}}
 *   oracleResult = the value `runCombinedOracle` returned.
 * Decimals compare as decimals. Hashes in the record are Node hashes of the data as received and identify it only; they are never a pass
 * condition. `matched` is true only when every difference count is 0 and the cash bounds hold. Never throws on a malformed pythonResult:
 * a missing or mistyped part is counted under `differences.input_shape` and the record is not matched.
 */
export function compareCombined(pythonResult,oracleResult){
  const oracle=oracleResult.ledger,diagnostics=oracleResult.diagnostics,meta=oracleResult.meta;
  const python=isObject(pythonResult)&&isObject(pythonResult.ledger)?pythonResult.ledger:{};
  const pythonDiagnostics=isObject(pythonResult)&&isObject(pythonResult.diagnostics)?pythonResult.diagnostics:null;
  const pe=arrayOf(python.events),pd=arrayOf(python.decisions),pf=arrayOf(python.fills);
  const differences={
    input_shape:(pe&&pd&&pf?0:1)+(pythonDiagnostics?0:1),
    event_count:0,event_identity_or_reason:0,level_ticks:0,decision_count:0,decision_identity:0,fill_count:0,accept_reject:0,quantity_steps:0,price_ticks:0,fee:0,
    allocation_targets:0,sizing_outcome_or_reason:0,sizing_quantities:0,remaining_quantity:0,open_allocation_count:0,
    realized_r:0,notional:0,fill_content:0,
    member_tags:0,member_funnel:0,cross_source_target:0,duplicate_intents:0,same_bar_order:0,final_cash:0,final_position_cost:0
  };
  const tolerance=D(CASH_TOLERANCE);
  const rTolerance=D(REALIZED_R_TOLERANCE);
  let perEntryCash=D(0),perEntryCost=D(0),maxQuantity=D(0),maxPrice=D(0),maxFee=D(0),maxRealizedR=D(0);
  const step=D(meta.model.quantity_step);
  if(pe&&pd&&pf){
    differences.event_count=Math.abs(pe.length-oracle.events.length);
    differences.decision_count=Math.abs(pd.length-oracle.decisions.length);
    differences.fill_count=Math.abs(pf.length-oracle.fills.length);
    const events=Math.min(pe.length,oracle.events.length);
    for(let i=0;i<events;i++){
      const left=pe[i],right=oracle.events[i];
      if(!isObject(left)){differences.event_identity_or_reason++;continue;}
      if(['event_type','time','entry_ref','sequence','reason'].some(key=>left[key]!==right[key]))differences.event_identity_or_reason++;
      if(right.event_type==='BUY')for(const field of ['sl','tp'])if(!decEq(left[field],right[field]))differences.level_ticks++;
    }
    const decisions=Math.min(pd.length,oracle.decisions.length);
    for(let i=0;i<decisions;i++){
      const left=pd[i],right=oracle.decisions[i];
      if(!isObject(left)){differences.accept_reject++;continue;}
      if(['event_type','time','sequence'].some(key=>left[key]!==right[key]))differences.decision_identity++;
      if(left.outcome!==right.outcome||left.reason!==right.reason)differences.accept_reject++;
      if(left.entry_ref!==right.entry_ref)differences.allocation_targets++;
      const quantityDelta=decDelta(left.quantity,right.quantity);
      if(quantityDelta===null||!quantityDelta.isZero())differences.quantity_steps++;
      maxQuantity=maxOf(maxQuantity,quantityDelta===null?null:quantityDelta.div(step));
      const feeDelta=decDelta(left.fee,right.fee);
      if(feeDelta===null||!feeDelta.isZero())differences.fee++;
      maxFee=maxOf(maxFee,feeDelta);
      if(left.outcome==='FILLED'&&right.outcome==='FILLED'){
        const la=left.sizing_adjustment,ra=right.sizing_adjustment;
        if(left.sizing_outcome!==right.sizing_outcome||Boolean(la)!==Boolean(ra)||(la&&ra&&la.reason!==ra.reason))differences.sizing_outcome_or_reason++;
        if(la&&ra)for(const key of ['requestedQuantity','quantity'])if(!decEq(la[key],ra[key]))differences.sizing_quantities++;
        const priceDelta=decDelta(left.price,right.price);
        if(priceDelta===null||!priceDelta.isZero())differences.price_ticks++;
        maxPrice=maxOf(maxPrice,priceDelta);
        // B1: realized R of every both-FILLED decision, as decimals (the per-entry cash bound cannot see a wrong R)
        const rDelta=decDelta(left.realized_r,right.realized_r);
        if(rDelta===null||rDelta.gt(rTolerance))differences.realized_r++;
        maxRealizedR=maxOf(maxRealizedR,rDelta);
        // N3: the notional is exact, as a decimal
        const notionalDelta=decDelta(left.notional,right.notional);
        if(notionalDelta===null||!notionalDelta.isZero())differences.notional++;
        const cashDelta=decDelta(left.cash,right.cash),costDelta=decDelta(left.cost,right.cost);
        if(cashDelta===null)differences.final_cash++;else perEntryCash=maxOf(perEntryCash,cashDelta);
        if(costDelta===null)differences.final_position_cost++;else perEntryCost=maxOf(perEntryCost,costDelta);
      }
    }
    // N2: the `fills` list is compared record by record as well (a decision list that matches does not vouch for a different fills list)
    const fillCount=Math.min(pf.length,oracle.fills.length);
    for(let i=0;i<fillCount;i++){
      if(!sameFill(pf[i],oracle.fills[i],rTolerance))differences.fill_content++;
      const cashDelta=decDelta(pf[i]?.cash,oracle.fills[i].cash),costDelta=decDelta(pf[i]?.cost,oracle.fills[i].cost);
      if(cashDelta===null)differences.final_cash++;else perEntryCash=maxOf(perEntryCash,cashDelta);
      if(costDelta===null)differences.final_position_cost++;else perEntryCost=maxOf(perEntryCost,costDelta);
    }
  }
  if(!decEq(python.position_quantity,oracle.position_quantity))differences.remaining_quantity=1;
  differences.open_allocation_count=Number.isInteger(python.open_allocations)?Math.abs(python.open_allocations-oracle.open_allocations):1;
  const finalCash=decDelta(python.final_cash,oracle.final_cash),finalCost=decDelta(python.position_cost,oracle.position_cost);
  if(finalCash===null)differences.final_cash++;
  if(finalCost===null)differences.final_position_cost++;

  // Multi-only: member tags, per-member funnel counts, the zero counters and the order rule.
  const oracleMembers=diagnostics.members.map(member=>({ordinal:member.ordinal,deployment_id:member.deployment_id}));
  const pythonRows=pythonDiagnostics?memberRows(pythonDiagnostics):null;
  if(pythonRows===null){differences.member_tags=1;differences.member_funnel++;}
  else{
    if(pythonRows.some(row=>!isObject(row)))differences.member_tags++;
    const rows=pythonRows.filter(isObject);
    const tag=row=>({ordinal:row.ordinal,deployment_id:row.deployment_id});
    const left=rows.map(tag).sort(byOrdinal),right=[...oracleMembers].sort(byOrdinal);
    if(sorted(left)!==sorted(right))differences.member_tags++;
    const known=new Set(rows.map(row=>row.deployment_id));
    for(const record of [...(pe??[]),...(pd??[]),...(pf??[])])if(!known.has(entryOwner(record?.entry_ref)))differences.member_tags++;
    // B2: every Python member row against the oracle funnel of the same deployment, through PYTHON_FUNNEL_MAP; a missing key is a difference
    for(const mine of diagnostics.members){
      const row=rows.find(item=>item.deployment_id===mine.deployment_id);
      differences.member_funnel+=row?funnelMismatches(row,pythonFunnelView(mine)):1;
    }
    // Python bot row: equal to the oracle Bot funnel and to the field-wise sum of its own member rows
    const bot=pythonDiagnostics.bot;
    differences.member_funnel+=funnelMismatches(bot,pythonFunnelView(diagnostics.bot));
    if(isObject(bot)){
      const total=sumPythonRows(rows);
      for(const key of Object.keys(PYTHON_FUNNEL_MAP))if(total[key]===null||!Object.hasOwn(bot,key)||!sameCount(key,bot[key],total[key]))differences.member_funnel++;
    }
  }
  if(pe&&pd){
    const left=deriveFunnel({events:pe.filter(isObject),decisions:pd.filter(isObject)},meta.start_time);
    const right=deriveFunnel(oracle,meta.start_time);
    const ids=new Set([...left.keys(),...right.keys()]);
    for(const id of ids)if(sorted(left.get(id)??null)!==sorted(right.get(id)??null))differences.member_funnel++;
  }
  const zero=value=>value===0;
  if(!pythonDiagnostics||!zero(pythonDiagnostics.cross_source_target))differences.cross_source_target++;
  if(!pythonDiagnostics||!zero(pythonDiagnostics.duplicate_intents))differences.duplicate_intents++;
  if(!zero(diagnostics.cross_source_target))differences.cross_source_target++;
  if(!zero(diagnostics.duplicate_intents))differences.duplicate_intents++;
  if(!pythonDiagnostics||pythonDiagnostics.same_bar_order!==MP_SAME_BAR_ORDER||diagnostics.same_bar_order!==MP_SAME_BAR_ORDER)differences.same_bar_order=1;

  const withinCash=perEntryCash.lte(tolerance)&&perEntryCost.lte(tolerance)&&finalCash!==null&&finalCash.lte(tolerance)&&finalCost!==null&&finalCost.lte(tolerance);
  const clean=Object.values(differences).every(count=>count===0);
  const none=value=>value===null?'NaN':value.toFixed();
  return {
    version:BASELINE_VERSION,
    evaluator_oracle:ORACLE_VERSION,
    binding:plain(meta.binding),
    same_bar_order:MP_SAME_BAR_ORDER,
    pair:plain(meta.pair),
    range:{first_time:meta.first_time,last_time:meta.last_time,rows:meta.rows,start_time:meta.start_time},
    members:plain(oracleMembers),
    counts:{events:oracle.events.length,decisions:oracle.decisions.length,fills:oracle.fills.length,open_allocations:oracle.open_allocations,
      received_events:pe?pe.length:null,received_decisions:pd?pd.length:null,received_fills:pf?pf.length:null},
    compared_decisions:oracle.decisions.length,
    // Node hashes of Node data (oracle) and of the data as received (python): identities, never pass conditions (hashes are one-language only).
    oracle_events_hash:hash(canonical(oracle.events)),oracle_decisions_hash:hash(canonical(oracle.decisions)),oracle_ledger_hash:hash(canonical(oracle)),
    received_events_hash:pe?hash(canonical(pe)):null,received_decisions_hash:pd?hash(canonical(pd)):null,
    bars_hash:meta.bars_hash,policy_hash:meta.policy_hash,signals:plain(meta.signals_hash),
    differences,
    per_entry_cash_max_delta:perEntryCash.toFixed(),per_entry_cost_max_delta:perEntryCost.toFixed(),
    final_cash_delta:none(finalCash),final_position_cost_delta:none(finalCost),
    max_quantity_step_delta:maxQuantity.toFixed(),max_price_delta:maxPrice.toFixed(),max_fee_delta:maxFee.toFixed(),max_realized_r_delta:maxRealizedR.toFixed(),
    realized_r_tolerance:REALIZED_R_TOLERANCE,
    cash_tolerance:CASH_TOLERANCE,quantity_step:String(meta.model.quantity_step),price_tick:String(meta.model.price_tick),
    matched:clean&&withinCash
  };
}
