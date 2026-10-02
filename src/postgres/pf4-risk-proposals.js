import {D} from '../money.js';
import {canonical,fail,hash} from '../pine-bridge/source.js';
import {validateRisk} from './risk-policy-validation.js';
import {reviewRiskPolicy} from './risk-policy-review.js';

/**
 * PF-4 Risk proposals (pf4-proposal-v1): pure and deterministic, no I/O, clock, randomness or AI. From the saved policy,
 * limits the owner declares, optional PF-2 evidence and the Bridge risk, it builds a list of explained changes and the
 * partial policy that a confirmed save applies through the same validator as PUT /api/risk.
 *
 * Owner decision Q1: a proposal may raise sizing settings (risk percent, order notional, daily notional) up to the
 * ceiling the owner declared, and may tighten them. It never loosens a loss guard, never touches equity or balance
 * (zero funding delta), never switches a guard off, and never exceeds a declared ceiling or the hard ranges of the
 * validator. Defaults are only lowered, never raised: nothing declares a target default and the engine ignores them.
 */
export const PF4_VERSION='pf4-proposal-v1';
export const PF4_CONFIRM='SAVE_RISK_PROPOSAL';
export const DECLARED_KEYS=Object.freeze(['loss_per_trade_percent','order_notional_ceiling','daily_notional_ceiling','allow_repeated_entries']);
// Every policy field a proposal may change; anything else must stay identical (assertMonotoneSafe).
export const ALLOW_LIST=Object.freeze(['maxRiskPercent','maxOrderNotional','maxDailyNotional','onePositionPerSymbol','capPercentEquitySize','defaults']);
export const NUMERIC_CEILINGS=Object.freeze({maxRiskPercent:'loss_per_trade_percent',maxOrderNotional:'order_notional_ceiling',maxDailyNotional:'daily_notional_ceiling'});
export const FLAG_FIELDS=Object.freeze(['onePositionPerSymbol','capPercentEquitySize']);
// Fields that carry loss protection or capital: a proposal never changes them (the generic equality check covers them).
export const LOSS_GUARDS=Object.freeze(['killSwitch','maxDailyLossR','pauseAfterLossStreak','maxTradesPerDay']);
export const CAPITAL_FIELDS=Object.freeze(['equities','balances']);
export const DEFAULT_CEILINGS=Object.freeze({riskPercent:'maxRiskPercent',tradesPerDay:'maxTradesPerDay',dailyLossR:'maxDailyLossR',
  lossStreak:'pauseAfterLossStreak',openPositions:'maxOpenPositions',signalAgeSeconds:'maxSignalAgeSeconds',
  orderNotional:'maxOrderNotional',dailyNotional:'maxDailyNotional',volatilityPercent:'maxVolatilityPercent'});
// Hard ranges of the validator (validateRisk): a declared value outside them is refused, a saved value never leaves them.
export const HARD_RANGES=Object.freeze({maxRiskPercent:['0.01','100'],maxOrderNotional:['0.01','1000000000000'],maxDailyNotional:['0.01','10000000000000']});
const DECLARED_SPEC=Object.freeze({loss_per_trade_percent:{min:'0.01',max:'100',places:4},
  order_notional_ceiling:{min:'0.01',max:'1000000000000',places:18},daily_notional_ceiling:{min:'0.01',max:'10000000000000',places:18}});
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,cap=64)=>typeof value==='string'?value.slice(0,cap):null;
const same=(a,b)=>canonical(a)===canonical(b);

/** Hash of a policy: the preimage of freshSnapshot, PF-3 and the Bridge snapshots (sha256 of the canonical JSON). */
export const policyHash=policy=>hash(canonical(policy));

const declaredError=field=>Object.assign(new Error('PF4_DECLARED_INVALID: '+field),{code:'PF4_DECLARED_INVALID',status:400});

/**
 * Validates and normalizes the limits an owner declares. Absent input means nothing is declared. An unknown key is
 * INVALID_FIELDS; a value that is not a plain decimal inside its range is PF4_DECLARED_INVALID (naming the field).
 * Numbers and decimal strings are both accepted and normalized to one plain decimal string, so 2, "2" and "2.0"
 * produce the same proposal hash. allow_repeated_entries must be a boolean.
 */
export function normalizeDeclared(input){
  if(input===undefined||input===null)return {};
  if(!isObject(input)||Object.keys(input).some(key=>!DECLARED_KEYS.includes(key)))throw fail('INVALID_FIELDS');
  const out={};
  for(const key of DECLARED_KEYS){
    if(!Object.hasOwn(input,key))continue;
    const value=input[key];
    if(key==='allow_repeated_entries'){
      if(typeof value!=='boolean')throw declaredError(key);
      out[key]=value;continue;
    }
    const spec=DECLARED_SPEC[key];
    if(!(typeof value==='string'&&value.length>0&&value.length<=64)&&!(typeof value==='number'&&Number.isFinite(value)))throw declaredError(key);
    let number;
    try{number=D(typeof value==='number'?String(value):value);}catch{throw declaredError(key);}
    if(number.decimalPlaces()>spec.places||number.lt(spec.min)||number.gt(spec.max))throw declaredError(key);
    out[key]=number.toFixed();
  }
  return out;
}

/** The PF-2 evidence summary in its canonical form (stable key set, sorted reasons), or null when it is unusable. */
export function cleanEvidence(evidence){
  if(!isObject(evidence)||text(evidence.job_id)===null||text(evidence.plan_hash)===null)return null;
  const reasons=(Array.isArray(evidence.reasons)?evidence.reasons:[]).filter(item=>isObject(item)&&typeof item.code==='string'&&
    Number.isSafeInteger(item.count)&&item.count>0).map(item=>({code:item.code.slice(0,64),count:item.count}))
    .sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0);
  return {job_id:text(evidence.job_id),plan_hash:text(evidence.plan_hash),policy_current:evidence.policy_current===true,
    capital_current:evidence.capital_current===true,
    cappable_buy_rejections:Number.isSafeInteger(evidence.cappable_buy_rejections)&&evidence.cappable_buy_rejections>=0?evidence.cappable_buy_rejections:0,
    reasons};
}

/** The READY Bridge deployment's risk percent in its canonical form, or null when it is not known. */
export function cleanBridgeRisk(bridge){
  if(!isObject(bridge)||text(bridge.deployment_id,128)===null||typeof bridge.risk_percent!=='number'||!Number.isFinite(bridge.risk_percent)||bridge.risk_percent<=0)return null;
  return {deployment_id:text(bridge.deployment_id,128),evidence_hash:text(bridge.evidence_hash),risk_percent:bridge.risk_percent};
}

/**
 * Safety check over a finished proposal. Throws PF4_PROPOSAL_UNSAFE (500: it is a defect, never a user error) unless
 * after differs from base only in the allow-list and in the permitted direction:
 *  - every other field (loss guards, side, symbols, limits...) is identical, and equities and balances are identical;
 *  - maxRiskPercent, maxOrderNotional and maxDailyNotional are inside the hard ranges and are not raised unless the
 *    owner declared a ceiling and the new value stays at or below it;
 *  - the two flags only go from false to true; defaults only go down and stay inside their ceilings.
 */
export function assertMonotoneSafe(base,after,declared,defaultRisk){
  const violations=[],bad=detail=>violations.push(detail);
  const baseDefaults={...defaultRisk.defaults,...(base.defaults||{})},afterDefaults=after.defaults||{};
  for(const key of new Set([...Object.keys(base),...Object.keys(after)])){
    if(key==='defaults'||CAPITAL_FIELDS.includes(key))continue;
    if(Object.hasOwn(NUMERIC_CEILINGS,key)){
      const before=D(base[key]),now=D(after[key]),[min,max]=HARD_RANGES[key],ceiling=declared?.[NUMERIC_CEILINGS[key]];
      if(now.lt(min)||now.gt(max))bad(key+' outside the hard range');
      if(now.gt(before)&&!(ceiling!==undefined&&now.lte(D(ceiling))))bad(key+' raised without a declared ceiling');
    }else if(FLAG_FIELDS.includes(key)){
      if(after[key]!==base[key]&&!(base[key]===false&&after[key]===true))bad(key+' loosened');
    }else if(!same(base[key],after[key]))bad(key+' changed');
  }
  for(const key of CAPITAL_FIELDS)if(!same(base[key]??{},after[key]??{}))bad(key+' changed');
  for(const key of new Set([...Object.keys(baseDefaults),...Object.keys(afterDefaults)])){
    if(!Object.hasOwn(baseDefaults,key)||!Object.hasOwn(afterDefaults,key)){bad('defaults.'+key+' added or removed');continue;}
    if(D(afterDefaults[key]).gt(D(baseDefaults[key])))bad('defaults.'+key+' raised');
    const ceiling=DEFAULT_CEILINGS[key];
    if(ceiling&&D(afterDefaults[key]).gt(D(after[ceiling])))bad('defaults.'+key+' above its ceiling');
  }
  if(after.paperTrading!==true||after.requireReduceOnlySell!==true)bad('Paper or reduce-only protection off');
  if(violations.length)throw Object.assign(fail('PF4_PROPOSAL_UNSAFE',500),{violations});
  return true;
}

// Fixed English texts, filled with numbers. The page translates them by code; these are the fallback and the record.
const fill=(template,values)=>template.replace(/[{](\w+)[}]/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
const ADVISORIES={
  LOSS_GUARDS_LOCKED:['info','The daily loss limit, the loss streak pause, the kill switch and every other guard stay exactly as saved. A proposal never loosens a loss guard. The daily loss limit is counted in R (1R is the risk of one trade), so a higher risk per trade raises its money value: for example 3R at 1.5% allows up to 4.5% of equity in one day.'],
  DAILY_LOSS_VALUE_RISES:['warn','Max risk per trade rises from {before}% to {after}%. The daily loss limit of {limit}R is counted in R, so its money value rises from up to {from}% to up to {to}% of equity per day.'],
  CAPITAL_NEVER_CHANGED:['info','Equity and balance never change. A proposal adds no funds and withdraws none.'],
  HISTORICAL_AFTER_NOT_SIMULATED:['info','The historical result after these changes is not simulated. Past Paper evidence describes the saved policy, not this proposal.'],
  SAVE_STALES_DEPLOYMENT:['warn','Saving changes the policy hash. Deployment {deployment_id} then refuses BUY events (STALE_POLICY) until a new deployment is generated and activated; historical evidence also needs a new enrollment and Preflight run.'],
  PERSISTENT_PAUSE_NOT_CHANGED:['info','The loss-streak pause stays active. A proposal never resets or re-arms a pause.'],
  DECLARED_LOSS_BELOW_BRIDGE_RISK:['warn','The declared loss per trade ({declared}%) is below the active Bridge risk ({risk}%). Saving it would reject every Bridge BUY, so the risk ceiling is left unchanged.'],
  BRIDGE_RISK_PERCENT_UNKNOWN:['info','No READY Bridge deployment gives a risk percent, so the risk ceiling cannot be checked against Bridge entries.'],
  DAILY_BELOW_ORDER_NOTIONAL:['warn','The daily notional ceiling ({daily}) is below the order notional ceiling ({order}); one order can use the whole daily allowance.'],
  REPEATED_ENTRIES_NOT_LOOSENED:['info','Repeated entries stay blocked. A proposal never switches a guard off; turn off the repeated-entry block yourself in the Risk form if you want them.'],
  BASE_POLICY_CONFLICT:['warn','The saved policy has conflicting settings ({detail}). Fix them in the Risk form first; a proposal cannot be saved on top of them.']
};
const EXPLANATIONS={
  LOSS_CEILING:{LOWER:'You declared {declared}% loss per trade. Max risk per trade falls from {before}% to {after}%.',
    RAISE:'You declared {declared}% loss per trade. Max risk per trade rises from {before}% to {after}%, the most you accept.'},
  ORDER_NOTIONAL:{LOWER:'You declared an order notional ceiling of {declared}. Max order notional falls from {before} to {after}.',
    RAISE:'You declared an order notional ceiling of {declared}. Max order notional rises from {before} to {after}, the most you accept.'},
  DAILY_NOTIONAL:{LOWER:'You declared a daily notional ceiling of {declared}. Max daily notional falls from {before} to {after}.',
    RAISE:'You declared a daily notional ceiling of {declared}. Max daily notional rises from {before} to {after}, the most you accept.'},
  REPEATED_ENTRIES:{ENABLE:'You do not allow repeated entries. Entries for a symbol that already has a position or a pending order become blocked.'},
  CAP_SIZING:{ENABLE:'Capping keeps an order inside every limit instead of rejecting it; risk per trade can only fall and no cash is added.'},
  DEFAULTS_WITHIN_CEILINGS:{LOWER:'Default {key} {before} exceeds the new ceiling {after}; it is lowered to {after}.'}
};
const FEES_NOTE='Fees, slippage and gaps can exceed a nominal stop.';

const NOTIONAL_DEFAULTS=new Set(['orderNotional','dailyNotional']);
const plainNumber=value=>D(String(value)).toFixed();
const NOTIONAL_RULES=[['ORDER_NOTIONAL','maxOrderNotional','order_notional_ceiling'],['DAILY_NOTIONAL','maxDailyNotional','daily_notional_ceiling']];

/**
 * Builds the proposal for one bot.
 *   botId, base (the saved policy as the store returns it), defaultRisk (the configured defaults of the validator),
 *   declared (limits as sent by the owner), evidence (PF-2 summary or null), bridgeRisk (READY deployment or null),
 *   context {readyDeploymentId, currentLossStreakPause}: only for advisories, not hashed.
 * Returns {proposal, after}. proposal.policy_input holds the changed keys only; after is the whole policy the same
 * validator produces from it (null when there is no change or a conflict refuses it). Nothing in the inputs is changed.
 */
export function buildProposal({botId,base,defaultRisk,declared,evidence=null,bridgeRisk=null,context={}}){
  const limits=normalizeDeclared(declared),ev=cleanEvidence(evidence),bridge=cleanBridgeRisk(bridgeRisk);
  const baseHash=policyHash(base);
  // The validator fills missing defaults from the configured ones; the rules and the review see the same merged view.
  const merged={...base,defaults:{...defaultRisk.defaults,...(base.defaults||{})}};
  const outside=reviewRiskPolicy(merged).issues.filter(issue=>!issue.field.startsWith('defaults.'));
  const changes=[],input={},notes=[];
  const add=(field,before,after,rule,direction,provenance,explanation)=>changes.push({field,before,after,rule,direction,provenance,explanation});
  const savedSource=()=>({source:'SAVED_POLICY',hash:baseHash});
  const ownerSource=field=>({source:'OWNER_DECLARED',field,value:limits[field]});
  const bridgeSource=()=>({source:'DEPLOYMENT_EVIDENCE',deployment_id:bridge.deployment_id,evidence_hash:bridge.evidence_hash,risk_percent:bridge.risk_percent});
  const evidenceSource=()=>({source:'PF2_EVIDENCE',job_id:ev.job_id,plan_hash:ev.plan_hash,reasons:ev.reasons});
  let lowered=false,notionalChanged=false;

  if(outside.length===0){
    // R1 LOSS_CEILING: the declared loss per trade becomes the risk ceiling, up or down, unless it would reject every Bridge BUY.
    if(limits.loss_per_trade_percent!==undefined){
      const wanted=D(limits.loss_per_trade_percent),now=D(merged.maxRiskPercent);
      if(bridge&&wanted.lt(bridge.risk_percent))notes.push(['DECLARED_LOSS_BELOW_BRIDGE_RISK',{declared:wanted.toFixed(),risk:plainNumber(bridge.risk_percent)}]);
      else if(!wanted.eq(now)){
        const direction=wanted.lt(now)?'LOWER':'RAISE';
        input.maxRiskPercent=Number(wanted.toFixed());
        add('maxRiskPercent',now.toFixed(),wanted.toFixed(),'LOSS_CEILING',direction,
          [savedSource(),ownerSource('loss_per_trade_percent'),...(bridge?[bridgeSource()]:[])],
          fill(EXPLANATIONS.LOSS_CEILING[direction],{declared:wanted.toFixed(),before:now.toFixed(),after:wanted.toFixed()})+
            (bridge?' The active Bridge risk is '+plainNumber(bridge.risk_percent)+'%, so entries stay possible.':'')+' '+FEES_NOTE);
        if(!bridge)notes.push(['BRIDGE_RISK_PERCENT_UNKNOWN',{}]);
        // The daily loss limit is counted in R: a higher risk per trade is a higher money value of the same limit (never a loosened guard).
        if(direction==='RAISE'){
          const limit=D(merged.maxDailyLossR),percent=value=>limit.mul(value).toDecimalPlaces(4).toFixed();
          notes.push(['DAILY_LOSS_VALUE_RISES',{before:now.toFixed(),after:wanted.toFixed(),limit:limit.toFixed(),from:percent(now),to:percent(wanted)}]);
        }
      }
    }
    // R2 ORDER_NOTIONAL and R3 DAILY_NOTIONAL: the declared ceiling becomes the policy ceiling, up or down.
    for(const [rule,field,key] of NOTIONAL_RULES){
      if(limits[key]===undefined)continue;
      const wanted=D(limits[key]),now=D(merged[field]);
      if(wanted.eq(now))continue;
      const direction=wanted.lt(now)?'LOWER':'RAISE';
      input[field]=wanted.toFixed();notionalChanged=true;lowered=lowered||direction==='LOWER';
      add(field,now.toFixed(),wanted.toFixed(),rule,direction,[savedSource(),ownerSource(key)],
        fill(EXPLANATIONS[rule][direction],{declared:wanted.toFixed(),before:now.toFixed(),after:wanted.toFixed()}));
    }
    if(notionalChanged){
      const order=D(input.maxOrderNotional??merged.maxOrderNotional),daily=D(input.maxDailyNotional??merged.maxDailyNotional);
      if(daily.lt(order))notes.push(['DAILY_BELOW_ORDER_NOTIONAL',{daily:daily.toFixed(),order:order.toFixed()}]);
    }
    // R4 REPEATED_ENTRIES: only a stricter setting is ever proposed; allowing repeats is left to the owner.
    if(limits.allow_repeated_entries===false&&merged.onePositionPerSymbol===false){
      input.onePositionPerSymbol=true;
      add('onePositionPerSymbol',false,true,'REPEATED_ENTRIES','ENABLE',[savedSource(),ownerSource('allow_repeated_entries')],EXPLANATIONS.REPEATED_ENTRIES.ENABLE);
    }else if(limits.allow_repeated_entries===true&&merged.onePositionPerSymbol===true)notes.push(['REPEATED_ENTRIES_NOT_LOOSENED',{}]);
    // R5 CAP_SIZING: capping replaces rejections that the evidence shows, and keeps orders inside lowered ceilings.
    if(merged.capPercentEquitySize===false){
      const seen=ev!==null&&ev.policy_current&&ev.capital_current&&ev.cappable_buy_rejections>0;
      if(seen||lowered){
        const sources=[savedSource()],parts=[];
        if(seen){
          sources.push(evidenceSource());
          parts.push(ev.cappable_buy_rejections+' historical BUY intents were rejected because the risk-sized order exceeded '+
            (ev.reasons.map(item=>item.code+' '+item.count).join(', ')||'a limit')+'.');
        }
        if(lowered){
          for(const [,,key] of NOTIONAL_RULES)if(limits[key]!==undefined)sources.push(ownerSource(key));
          parts.push('Lower notional ceilings with capping off would reject orders above them; capping keeps them inside the new ceilings.');
        }
        input.capPercentEquitySize=true;
        add('capPercentEquitySize',false,true,'CAP_SIZING','ENABLE',sources,parts.join(' ')+' '+EXPLANATIONS.CAP_SIZING.ENABLE);
      }
    }
    // R6 DEFAULTS_WITHIN_CEILINGS: a default above its (proposed) ceiling is lowered to it, so the validator accepts the result.
    const proposed={...merged,...input};
    for(const [key,ceilingField] of Object.entries(DEFAULT_CEILINGS)){
      let above=false;
      try{above=D(merged.defaults[key]).gt(D(proposed[ceilingField]));}catch{above=false;}
      if(!above)continue;
      const ceiling=D(proposed[ceilingField]);
      input.defaults??={};
      input.defaults[key]=NOTIONAL_DEFAULTS.has(key)?ceiling.toFixed():Number(ceiling.toFixed());
      const declaredKey=NUMERIC_CEILINGS[ceilingField],because=Object.hasOwn(input,ceilingField)&&declaredKey!==undefined&&limits[declaredKey]!==undefined;
      add('defaults.'+key,D(merged.defaults[key]).toFixed(),ceiling.toFixed(),'DEFAULTS_WITHIN_CEILINGS','LOWER',[savedSource(),...(because?[ownerSource(declaredKey)]:[])],
        fill(EXPLANATIONS.DEFAULTS_WITHIN_CEILINGS.LOWER,{key,before:D(merged.defaults[key]).toFixed(),after:ceiling.toFixed()}));
    }
  }

  let after=null,refusal=null;
  if(outside.length>0)refusal={code:'BASE_POLICY_CONFLICT',detail:outside.map(issue=>issue.code).join(', ')};
  else{
    try{after=validateRisk(input,base,defaultRisk);}catch(error){refusal={code:'BASE_POLICY_CONFLICT',detail:text(error?.message,120)};}
    if(after!==null){
      const review=reviewRiskPolicy(after);
      if(review.status!=='CONSISTENT'){refusal={code:'BASE_POLICY_CONFLICT',detail:review.issues.map(issue=>issue.code).join(', ')};after=null;}
    }
    if(after!==null)assertMonotoneSafe(base,after,limits,defaultRisk);
  }
  if(refusal!==null)notes.unshift(['BASE_POLICY_CONFLICT',{detail:refusal.detail}]);
  if(typeof context.readyDeploymentId==='string'&&context.readyDeploymentId)notes.push(['SAVE_STALES_DEPLOYMENT',{deployment_id:context.readyDeploymentId}]);
  if(context.currentLossStreakPause===true)notes.push(['PERSISTENT_PAUSE_NOT_CHANGED',{}]);
  notes.push(['LOSS_GUARDS_LOCKED',{}],['CAPITAL_NEVER_CHANGED',{}],['HISTORICAL_AFTER_NOT_SIMULATED',{}]);
  const advisories=notes.map(([code,values])=>({code,severity:ADVISORIES[code][0],explanation:fill(ADVISORIES[code][1],values),
    ...(Object.keys(values).length>0?{values}:{})}));
  // The hash covers everything the save depends on and nothing derived from the clock or the request.
  const hashed={version:PF4_VERSION,bot_id:botId,base_policy_hash:baseHash,declared:limits,evidence:ev,bridge_risk:bridge,policy_input:input};
  const proposal={version:PF4_VERSION,bot_id:botId,base_policy_hash:baseHash,declared:limits,evidence:ev,bridge_risk:bridge,changes,advisories,
    policy_input:input,after_policy_hash:after!==null&&changes.length>0?policyHash(after):null,refusal,proposal_hash:hash(canonical(hashed))};
  return {proposal,after:changes.length>0?after:null};
}

/** The policy fields a proposal changes, in rule order (defaults as defaults.key). */
export const changedFields=proposal=>proposal.changes.map(change=>change.field);
