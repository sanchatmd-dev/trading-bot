import {normalizeSignal} from './domain.js';
import {evaluateRisk} from './risk.js';
import {D,amount} from '../money.js';
import {hash,canonical} from '../pine-bridge/source.js';
import {reviewRiskPolicy,readinessCapacity} from './risk-policy-review.js';
import {resolveBridgePreviewContext,previewBridgeCosts} from './risk-readiness-bridge.js';
import {finalizeBridgeOrder} from './paper-cost-model.js';
import {checkPaperVenue} from './risk-venue.js';
import {riskScenario} from './risk-scenario.js';

// Generic signal fields only. Bridge previews use a separate server-resolved
// request; trusted context must never be accepted through raw signal fields.
const signalFields=new Set([
  'account_type','trade_id','id','broker','symbol','event','action','side',
  'order_type','type','timestamp','timeframe','interval','risk_mode','risk_value',
  'quantity','volume','quote_quantity','reference_price','entry','entry_price',
  'limit_price','price','stop_loss','sl','take_profit','tp','reduce_only','leverage',
  'target_trade_id','position_id','target_id','volatility_percent','news_risk',
  'high_impact_news','alert_source','strategy_id','strategy_version'
]);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>{throw Object.assign(new Error(message),{status:400});};

export async function buildRiskReadiness({store,botId,ownerId,defaultRisk,body,now=Date.now()}){
  if(!object(body)||Object.keys(body).some(key=>!['signal','bridge','scenario'].includes(key))||Number(Object.hasOwn(body,'signal'))+Number(Object.hasOwn(body,'bridge'))!==1){
    invalid('Readiness requires exactly one signal or bridge property; use scenario for hypothetical policy and capital');
  }
  const bridgeMode=Object.hasOwn(body,'bridge');
  let signal;
  if(!bridgeMode){
    if(!object(body.signal))invalid('signal must be a raw signal object');
    for(const key of Object.keys(body.signal))if(!signalFields.has(key))invalid('Unsupported readiness signal field: '+key);
    try{signal=normalizeSignal(body.signal,now);}catch(error){error.status=400;throw error;}
  }
  return store.db.transaction(async()=>{
    if(!await store.ownsBot(ownerId,botId))throw Object.assign(new Error('Bot access denied'),{status:403});
    const owner=await store.userById(ownerId),bot=await store.userById(botId);
    const bridge=bridgeMode?await resolveBridgePreviewContext({store,ownerId,botId,request:body.bridge,defaultRisk,now}):null;
    if(bridge)signal=bridge.signal;
    const session=bridge?.session??await store.getBotSession(botId);
    const locked=session.state==='RUNNING'&&session.locked_policy;
    let policy=bridge?.policy??(locked?JSON.parse(session.locked_policy):await store.risk(botId,defaultRisk));
    let policySource=bridge?.policySource??(locked?'LOCKED_SESSION':session.state==='RUNNING'?'SAVED_POLICY_FALLBACK':'SAVED_POLICY');
    const row={id:0,user_id:botId,account_id:signal.broker+':primary',execution_mode:'PAPER',symbol:signal.symbol,broker:signal.broker};
    let account=await store.paperAccount(botId,signal.broker);
    const exposure=await store.exposure(row);
    let scenario,actual;
    if(Object.hasOwn(body,'scenario')){
      const current=await buildRiskReadiness({store,botId,ownerId,defaultRisk,body:bridgeMode?{bridge:body.bridge}:{signal:body.signal},now});
      actual={readiness:current.readiness,calculation:current.calculation,policyHash:current.policy.hash,policySource:current.policySource};
      try{({policy,account,scenario}=riskScenario(body.scenario,policy,account,defaultRisk,exposure));}
      catch(error){error.status=400;throw error;}
      policySource='HYPOTHETICAL_DRAFT';
    }
    const cashAvailable=amount(D(account.cash).minus(exposure.reservedNotional||0).minus(exposure.reservedFees||0));
    const limitations=bridge?.limitations??[
      'POINT_IN_TIME_ONLY','PAPER_ONLY','COST_BASIS_NOT_MARK_TO_MARKET','INPUT_MARKET_DATA_UNVERIFIED',
      'VENUE_FILTERS_UNVERIFIED','EXECUTION_COSTS_UNVERIFIED','BRIDGE_PREFLIGHT_UNSUPPORTED'
    ];
    if(scenario)limitations.push('HYPOTHETICAL_POLICY_AND_CAPITAL');
    if(policySource==='SAVED_POLICY_FALLBACK'&&!limitations.includes('RUNNING_LOCKED_POLICY_MISSING'))limitations.push('RUNNING_LOCKED_POLICY_MISSING');
    const daily=await store.ledgerDaily(row),consistency=reviewRiskPolicy(policy);
    const capacity=consistency.status==='CONSISTENT'?readinessCapacity(policy,daily,exposure):null;
    const response={version:'pf1-readiness-v1',asOf:new Date(now).toISOString(),botId,
      scope:'POINT_IN_TIME_PAPER_RISK',readiness:{status:'UNKNOWN',reasons:bridge?[
        'VENUE_FILTERS_UNVERIFIED','COST_INCLUSIVE_RISK_LIMIT_NOT_ENFORCED','HYPOTHETICAL_BRIDGE_INTENT'
      ]:[
        'VENUE_FILTERS_UNVERIFIED','EXECUTION_COSTS_UNVERIFIED','BRIDGE_PREFLIGHT_UNSUPPORTED'
      ]},calculation:null,policySource,session:{state:session.state,runId:session.run_id??null},
      account:{...account,cashAvailable},limitations,consistency,capacity,
      policy:{source:policySource,hash:hash(canonical(policy)),effective:policy,hypothetical:!!scenario},...(scenario?{scenario,actual}:{}),
      ...(bridge?{deployment:bridge.deployment,market:bridge.market}:{})};
    const reject=(code,reason)=>({...response,readiness:{status:'BLOCKED',reasons:[code]},calculation:{status:'REJECTED',reason}});
    if(owner?.status!=='ACTIVE'||bot?.status!=='ACTIVE')return reject('ACCOUNT_SUSPENDED','User or main account is suspended');
    if(session.state==='STOPPED')return reject('BOT_STOPPED','Bot is stopped: no signals accepted');
    if(session.state==='PAUSED'&&(signal.side!=='SELL'||!signal.reduceOnly))return reject('BOT_PAUSED','Bot is paused: only reduce-only exits are accepted');
    if(!['SETUP','RUNNING','PAUSED','STOPPED'].includes(session.state))return reject('SESSION_STATE_UNSUPPORTED','Bot session state is unsupported');
    if(signal.side==='BUY'&&exposure.feeReservationUnknown&&bridge?.model.version==='paper-close-cost-v2')return reject('PENDING_FEE_RESERVATION_UNKNOWN','Pending fee authority is unavailable');
    if(exposure.uncertain)return reject('ORDER_OUTCOME_UNCERTAIN','Unresolved order outcome: operator reconciliation required');
    const targetAllocation=signal.targetTradeId?await store.ledgerTargetAllocation(row,signal.targetTradeId):null;
    const sizingCashBudget=amount(D(cashAvailable).div(bridge&&signal.side==='BUY'?D(1).plus(D(bridge.model.fee_bps).div(10000)):1));
    const context={policy,daily,position:await store.ledgerPosition(row),
      targetAllocation,equity:account.bookEquity,balance:account.cash,...exposure,cashAvailable:sizingCashBudget,
      licensed:owner.role==='ADMIN'||await store.hasActiveLicense(ownerId),globalKill:await store.getSetting('globalKill',false),now};
    let result;
    try{result=evaluateRisk(signal,context);}
    catch(error){
      if(consistency.status!=='CONFLICT')throw error;
      return reject('POLICY_CONFIGURATION_CONFLICT','Saved policy is invalid; this calculation cannot be evaluated');
    }
    if(!result.ok)return reject('RISK_REJECTED',result.reason);
    let order=result.order,costs,venue;
    if(bridge){
      try{
        order=finalizeBridgeOrder(order,bridge.model,{policy,account,signal,exposure}).order;
        costs=previewBridgeCosts(order,bridge.model,account);
        costs.riskLimitIncludesCosts=bridge.model.version==='paper-close-cost-v2';
        if(costs.riskLimitIncludesCosts){
          venue=await checkPaperVenue(store,row,order,bridge.model,now);
          response.venue=venue;response.costs=costs;response.sizingCashBudget=sizingCashBudget;
          if(venue.status!=='PASSED')return reject(venue.reasons[0]||'VENUE_FILTERS_UNAVAILABLE',venue.reasons.join(', '));
          order.venue_report=venue;
          response.readiness.reasons=['HYPOTHETICAL_BRIDGE_INTENT'];
          for(const item of ['VENUE_FILTERS_UNVERIFIED','COST_INCLUSIVE_RISK_LIMIT_NOT_ENFORCED','PENDING_FEE_RESERVATIONS_UNSUPPORTED']){const i=limitations.indexOf(item);if(i>=0)limitations.splice(i,1);}
          limitations.push('PAPER_PUBLIC_FILTERS_ONLY','CONDITIONAL_STOP_LOSS_NOT_GUARANTEED','LEGACY_INITIAL_R_ACCOUNTING');
        }
      }
      catch(error){if(!error.code)throw error;return reject(error.code,error.message);}
      if(costs.estimatedLossAtStop!==null&&D(costs.estimatedLossAtStop).gt(D(account.bookEquity).mul(policy.maxRiskPercent).div(100))){
        consistency.status='CONFLICT';
        consistency.issues.push({field:'maxRiskPercent',code:'ESTIMATED_STOP_LOSS_EXCEEDS_POLICY',severity:'ERROR'});
      }
    }
    if(consistency.status==='CONFLICT')response.readiness={status:'BLOCKED',reasons:['POLICY_CONFIGURATION_CONFLICT',...consistency.issues.map(issue=>issue.code)]};
    return {...response,calculation:{status:order.sizingAdjustment?'CAPPED':'ACCEPTED',order},...(bridge?{costs,sizingCashBudget}:{})};
  },{isolation:'REPEATABLE READ'});
}
