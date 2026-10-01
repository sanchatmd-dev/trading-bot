/**
 * PF-3 rejection classes: pure table, classification, BUY/EXIT attribution and TARGET_NOT_OPEN verification.
 * No I/O, clock or randomness. Input is a PF-2 envelope result that validatePreflightEnvelope already accepted;
 * the counters are still cross-checked here, so a defect becomes EVIDENCE_INTEGRITY_FAILED and never a silent
 * number. The keys of orders.rejected_by_reason are the exact strings of the Risk evaluator (risk.js and
 * quant_lab risk_evaluator.py), TARGET_NOT_OPEN (paper_state.py), BELOW_QUANTITY_STEP (bridge_replay.py) and the
 * overflow bucket OTHER. Every key lands in exactly one class; an unlisted key is UNKNOWN, never dropped.
 */
export const PF3_RULES_VERSION='pf3-rules-v1';

export const CATEGORY=Object.freeze({CONFIGURATION:'CONFIGURATION_FAILURE',POLICY_SKIP:'EXPECTED_POLICY_SKIP',
  LOSS_PAUSE:'LOSS_PROTECTION_PAUSE',FAULT:'EXECUTION_FAULT',UNKNOWN:'UNKNOWN'});
const C=CATEGORY.CONFIGURATION,S=CATEGORY.POLICY_SKIP,L=CATEGORY.LOSS_PAUSE,F=CATEGORY.FAULT;

export const TARGET_NOT_OPEN='TARGET_NOT_OPEN';
export const BELOW_QUANTITY_STEP='BELOW_QUANTITY_STEP';
export const OVERFLOW_REASON='OTHER';

// [reason, category, code, side, cappable]. side: BUY = only a BUY intent can be rejected for it, EXIT = only an
// EXIT, BOTH = either. cappable: with Percent equity sizing the cap would turn this rejection into a smaller fill.
const ROWS=[
  // BUY entry guards and sizing checks.
  ['Kill switch is active: entries paused',C,'KILL_SWITCH','BUY'],
  ['License is inactive or expired',C,'LICENSE_INACTIVE','BUY'],
  ['Maximum trades per day reached',S,'MAX_TRADES_PER_DAY','BUY'],
  ['Maximum daily loss reached',L,'MAX_DAILY_LOSS','BUY'],
  ['Trading paused after loss streak',L,'LOSS_STREAK','BUY'],
  ['Missing volatility data',F,'MISSING_VOLATILITY_DATA','BUY'],
  ['High volatility block is active',S,'HIGH_VOLATILITY_BLOCK','BUY'],
  ['Missing news risk data',C,'NEWS_BLOCK_WITHOUT_NEWS_DATA','BUY'],
  ['News trading block is active',S,'NEWS_BLOCK_ACTIVE','BUY'],
  ['Symbol is not allowed',C,'SYMBOL_NOT_ALLOWED','BUY'],
  ['Only SELL is allowed',C,'SIDE_MODE_BLOCKS_BUY','BUY'],
  ['Maximum open positions reached',S,'MAX_OPEN_POSITIONS','BUY'],
  ['Position or pending order already exists for symbol',S,'REPEATED_ENTRY_BLOCKED','BUY'],
  ['Risk percent exceeds policy',C,'BRIDGE_RISK_EXCEEDS_POLICY','BUY'],
  ['Calculated risk exceeds maximum risk percent',C,'CALCULATED_RISK_EXCEEDS_POLICY','BUY'],
  ['Positive account equity is required',C,'EQUITY_NOT_POSITIVE','BUY'],
  ['No remaining Spot sizing budget',S,'SIZING_BUDGET_EXHAUSTED','BUY'],
  ['Order exceeds available configured Spot equity',S,'EQUITY_LIMIT','BUY',true],
  ['Order exceeds available configured Spot balance',S,'CASH_LIMIT','BUY',true],
  ['Maximum order notional exceeded',S,'ORDER_NOTIONAL_LIMIT','BUY',true],
  ['Maximum daily notional exceeded',S,'DAILY_NOTIONAL_LIMIT','BUY',true],
  ['stop_loss is required for Percent equity',F,'STOP_LOSS_REQUIRED','BUY'],
  ['Stop loss must differ from entry',F,'STOP_EQUALS_ENTRY','BUY'],
  ['BUY stop loss must be below entry',F,'BUY_STOP_NOT_BELOW_ENTRY','BUY'],
  ['BUY take profit must be above entry',F,'BUY_TARGET_NOT_ABOVE_ENTRY','BUY'],
  ['stop_loss is required for all entry sizing modes',F,'STOP_LOSS_REQUIRED_ALL_MODES','BUY'],
  // EXIT only. TARGET_NOT_OPEN is verified separately and split into two classes.
  [TARGET_NOT_OPEN,S,'TARGET_OF_UNFILLED_ENTRY','EXIT'],
  ['Target allocation not found or already closed',F,'TARGET_ALLOCATION_CLOSED','EXIT'],
  ['No Spot position available to sell',F,'EXIT_WITHOUT_INVENTORY','EXIT'],
  ['Pending order already reserves this symbol',F,'PENDING_ORDER_RESERVES_SYMBOL','EXIT'],
  // Either side.
  ['Only Spot simulation is supported in this release',C,'UNSUPPORTED_BROKER','BOTH'],
  ['This account supports USDT quote currency only',C,'QUOTE_CURRENCY_MISMATCH','BOTH'],
  ['This account supports THB quote currency only',C,'QUOTE_CURRENCY_MISMATCH','BOTH'],
  ['Signal is stale',F,'SIGNAL_STALE','BOTH'],
  ['Spot leverage must equal 1',F,'LEVERAGE_NOT_ONE','BOTH'],
  ['Spot SELL must be reduce_only',F,'SELL_NOT_REDUCE_ONLY','BOTH'],
  ['Only BUY is allowed',F,'ONLY_BUY_ALLOWED','BOTH'],
  ['entry/reference_price is required for risk checks',F,'REFERENCE_PRICE_REQUIRED','BOTH'],
  ['Unable to calculate quantity',F,'QUANTITY_UNCALCULABLE','BOTH'],
  ['Invalid notional',F,'INVALID_NOTIONAL','BOTH'],
  [BELOW_QUANTITY_STEP,S,'ORDER_BELOW_QUANTITY_STEP','BOTH']
];

export const REJECTION_TABLE=new Map(ROWS.map(([reason,category,code,side,cappable=false])=>
  [reason,Object.freeze({category,code,side,cappable})]));

/** Table entry of an exact reason string, or null. */
export const classifyReason=reason=>typeof reason==='string'&&REJECTION_TABLE.has(reason)?REJECTION_TABLE.get(reason):null;

/** Evidence that cannot be explained by its own counters. The service maps it to EVIDENCE_INTEGRITY_FAILED. */
export class Pf3IntegrityError extends Error{
  constructor(detail){super('EVIDENCE_INTEGRITY_FAILED');this.code='EVIDENCE_INTEGRITY_FAILED';this.detail=detail;}
}
const broken=detail=>{throw new Pf3IntegrityError(detail);};
const count=value=>Number.isSafeInteger(value)&&value>=0;
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/**
 * Exact side attribution from the validated counters (design 2.4). B and X are the rejected BUY and EXIT intents.
 * Keys whose rule can reject only one side are summed; the rest (BOTH keys, OTHER, unlisted strings) share the
 * remainder, so a BOTH key is attributed to BUY or EXIT only when the counters leave no other possibility.
 */
export function attributeSides({intents,fills,byReason}){
  if(!isObject(intents)||!isObject(fills)||!isObject(byReason))broken('SHAPE');
  const exits=[intents.exit_sl,intents.exit_tp,intents.exit_native];
  if(![intents.buy,fills.buy,fills.exit,...exits].every(count))broken('COUNTERS');
  const buyRejected=intents.buy-fills.buy,exitRejected=exits.reduce((sum,value)=>sum+value,0)-fills.exit;
  if(buyRejected<0||exitRejected<0)broken('FILLS_EXCEED_INTENTS');
  let rejected=0,buyOnly=0,exitOnly=0;
  for(const [reason,value] of Object.entries(byReason)){
    if(!Number.isSafeInteger(value)||value<1)broken('REASON_COUNT');
    rejected+=value;
    const entry=classifyReason(reason);
    if(entry?.side==='BUY')buyOnly+=value;
    else if(entry?.side==='EXIT')exitOnly+=value;
  }
  if(rejected!==buyRejected+exitRejected)broken('REJECTED_SUM');
  if(buyOnly>buyRejected||exitOnly>exitRejected)broken('SIDE_ONLY_EXCEEDS_SIDE');
  const dualBuy=buyRejected-buyOnly,dualExit=exitRejected-exitOnly;
  return {buy_rejected:buyRejected,exit_rejected:exitRejected,dual_buy:dualBuy,dual_exit:dualExit,
    dual:dualExit===0?'BUY':dualBuy===0?'EXIT':'MIXED'};
}

/** entry_ref of a Bridge intent is <deployment_id>:<bar_time>:0 (risk-readiness-bridge.js, bridge_replay.py). */
export function parseEntryRef(entryRef,deploymentId=null){
  if(typeof entryRef!=='string'||entryRef.length>256)return null;
  const match=/^([A-Za-z0-9-]{8,128}):(\d{1,16}):0$/.exec(entryRef);
  if(!match||(deploymentId!==null&&match[1]!==deploymentId))return null;
  return {deployment_id:match[1],time:Number(match[2])};
}

/**
 * TARGET_NOT_OPEN means an EXIT found no open target. It is explained only when the sampled evidence shows why:
 * (a) the entry came from a warm-up bar, which never reaches the Paper ledger; (b) a BUY rejection sample has the
 * same entry_ref, so the entry never filled; (c) an EXIT fill sample closed the same entry earlier. The samples
 * keep only the first 200 rejections, so everything the samples do not explain stays unverified. Counts only.
 */
export function verifyTargets({total,samples,window,deploymentId=null}){
  if(!count(total))broken('TARGET_TOTAL');
  const rejections=Array.isArray(samples?.rejections)?samples.rejections:[],fills=Array.isArray(samples?.fills)?samples.fills:[];
  const buyRejectedAt=new Map(),exitFilledAt=new Map();
  const earliest=(map,ref,time)=>{if(!map.has(ref)||time<map.get(ref))map.set(ref,time);};
  for(const item of rejections)if(item?.event_type==='BUY')earliest(buyRejectedAt,item.entry_ref,item.time);
  for(const item of fills)if(item?.event_type==='EXIT')earliest(exitFilledAt,item.entry_ref,item.time);
  const basis={WARMUP_ENTRY:0,REJECTED_BUY:0,CLOSED_EARLIER:0};
  const start=window?.evaluation_start_time;
  for(const item of rejections){
    if(item?.reason!==TARGET_NOT_OPEN||item.event_type!=='EXIT')continue;
    const ref=parseEntryRef(item.entry_ref,deploymentId);
    if(ref!==null&&Number.isSafeInteger(start)&&ref.time<start)basis.WARMUP_ENTRY++;
    else if(buyRejectedAt.has(item.entry_ref)&&buyRejectedAt.get(item.entry_ref)<=item.time)basis.REJECTED_BUY++;
    else if(exitFilledAt.has(item.entry_ref)&&exitFilledAt.get(item.entry_ref)<item.time)basis.CLOSED_EARLIER++;
  }
  const verified=Math.min(total,basis.WARMUP_ENTRY+basis.REJECTED_BUY+basis.CLOSED_EARLIER);
  return {total,verified,unverified:total-verified,basis};
}

const CLASS_ORDER=[CATEGORY.CONFIGURATION,CATEGORY.FAULT,CATEGORY.UNKNOWN,CATEGORY.LOSS_PAUSE,CATEGORY.POLICY_SKIP];

/**
 * Classifies every key of orders.rejected_by_reason. Returns the items {reason,count,category,code,side,attribution}
 * (their counts add up to the rejected total), counts per category, the side attribution, the TARGET_NOT_OPEN
 * verification and the number of cappable BUY rejections. Throws Pf3IntegrityError when the counters disagree.
 */
export function classifyRejections({byReason,intents,fills,samples,window,deploymentId=null}){
  const sides=attributeSides({intents,fills,byReason});
  const items=[];
  let cappableBuy=0,targets={total:0,verified:0,unverified:0,basis:{WARMUP_ENTRY:0,REJECTED_BUY:0,CLOSED_EARLIER:0}};
  const push=(reason,value,category,code,side,attribution)=>{if(value>0)items.push({reason,count:value,category,code,side,attribution});};
  for(const [reason,value] of Object.entries(byReason)){
    const entry=classifyReason(reason);
    if(reason===TARGET_NOT_OPEN){
      targets=verifyTargets({total:value,samples,window,deploymentId});
      push(reason,targets.verified,S,'TARGET_OF_UNFILLED_ENTRY','EXIT','EXIT');
      push(reason,targets.unverified,CATEGORY.UNKNOWN,'TARGET_RELATIONSHIP_UNVERIFIED','EXIT','EXIT');
      continue;
    }
    if(entry===null){
      push(reason,value,CATEGORY.UNKNOWN,reason===OVERFLOW_REASON?'OTHER_REASON_OVERFLOW':'UNLISTED_REASON','UNKNOWN',sides.dual);
      continue;
    }
    const attribution=entry.side==='BOTH'?sides.dual:entry.side;
    if(reason===BELOW_QUANTITY_STEP&&attribution!=='BUY'){
      push(reason,value,CATEGORY.UNKNOWN,'BELOW_STEP_SIDE_UNVERIFIED',entry.side,attribution);
      continue;
    }
    if(entry.cappable)cappableBuy+=value;
    push(reason,value,entry.category,entry.code,entry.side,attribution);
  }
  items.sort((a,b)=>b.count-a.count||(a.reason<b.reason?-1:a.reason>b.reason?1:a.code<b.code?-1:a.code>b.code?1:0));
  const byCategory=Object.fromEntries(CLASS_ORDER.map(name=>[name,0]));
  for(const item of items)byCategory[item.category]+=item.count;
  return {items,by_category:byCategory,side_attribution:{buy_rejected:sides.buy_rejected,exit_rejected:sides.exit_rejected,
    dual_buy:sides.dual_buy,dual_exit:sides.dual_exit},target_not_open:targets,cappable_buy_rejections:cappableBuy};
}
