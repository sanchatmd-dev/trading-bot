import {normalizeSignal} from './domain.js';
import {evaluateRisk} from './risk.js';
import {D,amount} from '../money.js';

// Raw generic signals only. Bridge references and trusted context must never be
// silently discarded by normalizeSignal or accepted as readiness evidence.
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
  if(!object(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'signal')){
    invalid('Readiness requires only a signal property; draft policy and capital are unsupported');
  }
  if(!object(body.signal))invalid('signal must be a raw signal object');
  for(const key of Object.keys(body.signal)){
    if(!signalFields.has(key))invalid('Unsupported readiness signal field: '+key);
  }
  let signal;
  try{signal=normalizeSignal(body.signal,now);}catch(error){error.status=400;throw error;}
  return store.db.transaction(async()=>{
    if(!await store.ownsBot(ownerId,botId))throw Object.assign(new Error('Bot access denied'),{status:403});
    const owner=await store.userById(ownerId),bot=await store.userById(botId);
    const session=await store.getBotSession(botId);
    const locked=session.state==='RUNNING'&&session.locked_policy;
    const policy=locked?JSON.parse(session.locked_policy):await store.risk(botId,defaultRisk);
    const policySource=locked?'LOCKED_SESSION':session.state==='RUNNING'?'SAVED_POLICY_FALLBACK':'SAVED_POLICY';
    const row={id:0,user_id:botId,account_id:signal.broker+':primary',execution_mode:'PAPER',symbol:signal.symbol,broker:signal.broker};
    const account=await store.paperAccount(botId,signal.broker);
    const exposure=await store.exposure(row);
    const cashAvailable=amount(D(account.cash).minus(exposure.reservedNotional||0));
    const limitations=[
      'POINT_IN_TIME_ONLY','PAPER_ONLY','COST_BASIS_NOT_MARK_TO_MARKET','INPUT_MARKET_DATA_UNVERIFIED',
      'VENUE_FILTERS_UNVERIFIED','EXECUTION_COSTS_UNVERIFIED','BRIDGE_PREFLIGHT_UNSUPPORTED'
    ];
    if(policySource==='SAVED_POLICY_FALLBACK')limitations.push('RUNNING_LOCKED_POLICY_MISSING');
    const response={version:'pf1-readiness-v1',asOf:new Date(now).toISOString(),botId,
      scope:'POINT_IN_TIME_PAPER_RISK',readiness:{status:'UNKNOWN',reasons:[
        'VENUE_FILTERS_UNVERIFIED','EXECUTION_COSTS_UNVERIFIED','BRIDGE_PREFLIGHT_UNSUPPORTED'
      ]},calculation:null,policySource,session:{state:session.state,runId:session.run_id??null},
      account:{...account,cashAvailable},limitations};
    const reject=(code,reason)=>({...response,readiness:{status:'BLOCKED',reasons:[code]},calculation:{status:'REJECTED',reason}});
    if(owner?.status!=='ACTIVE'||bot?.status!=='ACTIVE')return reject('ACCOUNT_SUSPENDED','User or main account is suspended');
    if(session.state==='STOPPED')return reject('BOT_STOPPED','Bot is stopped: no signals accepted');
    if(session.state==='PAUSED'&&(signal.side!=='SELL'||!signal.reduceOnly))return reject('BOT_PAUSED','Bot is paused: only reduce-only exits are accepted');
    if(!['SETUP','RUNNING','PAUSED','STOPPED'].includes(session.state))return reject('SESSION_STATE_UNSUPPORTED','Bot session state is unsupported');
    if(exposure.uncertain)return reject('ORDER_OUTCOME_UNCERTAIN','Unresolved order outcome: operator reconciliation required');
    const targetAllocation=signal.targetTradeId?await store.ledgerTargetAllocation(row,signal.targetTradeId):null;
    const result=evaluateRisk(signal,{policy,daily:await store.ledgerDaily(row),position:await store.ledgerPosition(row),
      targetAllocation,equity:account.bookEquity,balance:account.cash,...exposure,cashAvailable,
      licensed:owner.role==='ADMIN'||await store.hasActiveLicense(ownerId),globalKill:await store.getSetting('globalKill',false),now});
    if(!result.ok)return reject('RISK_REJECTED',result.reason);
    return {...response,calculation:{status:result.order.sizingAdjustment?'CAPPED':'ACCEPTED',order:result.order}};
  },{isolation:'REPEATABLE READ'});
}
