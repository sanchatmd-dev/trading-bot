import {D,Money,amount} from '../money.js';

const ranges={maxRiskPercent:[.01,100],maxOrderNotional:[.01,1e12],maxDailyNotional:[.01,1e13],
  maxTradesPerDay:[1,10000],maxDailyLossR:[.01,1000],maxOpenPositions:[1,1000],
  pauseAfterLossStreak:[1,100],maxSignalAgeSeconds:[1,3600],maxVolatilityPercent:[0,1000]};
const integers=new Set(['maxTradesPerDay','maxOpenPositions','pauseAfterLossStreak','maxSignalAgeSeconds']);
const defaults={riskPercent:'maxRiskPercent',tradesPerDay:'maxTradesPerDay',dailyLossR:'maxDailyLossR',
  lossStreak:'pauseAfterLossStreak',openPositions:'maxOpenPositions',signalAgeSeconds:'maxSignalAgeSeconds',
  orderNotional:'maxOrderNotional',dailyNotional:'maxDailyNotional',volatilityPercent:'maxVolatilityPercent'};

// Diagnostic only: never save, repair or relax a policy to make a preview pass.
export function reviewRiskPolicy(policy){
  const issues=[];
  const error=(field,code)=>issues.push({field,code,severity:'ERROR'});
  for(const [field,[min,max]] of Object.entries(ranges)){
    try{const value=D(policy[field]);if(!value.isFinite()||value.lt(min)||value.gt(max)||(integers.has(field)&&!value.isInteger()))error(field,'POLICY_VALUE_OUT_OF_RANGE');}
    catch{error(field,'POLICY_VALUE_INVALID');}
  }
  for(const field of ['paperTrading','requireReduceOnlySell'])if(policy[field]!==true)error(field,'SPOT_PAPER_PROTECTION_REQUIRED');
  for(const field of ['killSwitch','onePositionPerSymbol','capPercentEquitySize','blockHighVolatility','blockDuringNews']){
    if(typeof policy[field]!=='boolean')error(field,'POLICY_BOOLEAN_REQUIRED');
  }
  if(!['BOTH','BUY_ONLY','SELL_ONLY'].includes(policy.sideMode))error('sideMode','POLICY_SIDE_MODE_INVALID');
  if(!Array.isArray(policy.allowedSymbols)||policy.allowedSymbols.length>500||policy.allowedSymbols.some(symbol=>typeof symbol!=='string'||!/^[A-Z0-9._-]{1,30}$/.test(symbol)))error('allowedSymbols','POLICY_SYMBOL_LIST_INVALID');
  for(const [field,ceiling] of Object.entries(defaults)){
    try{
      const value=D(policy.defaults?.[field]),limit=D(policy[ceiling]);
      if(!value.isFinite()||value.lt(ranges[ceiling][0])||value.gt(limit)||(integers.has(ceiling)&&!value.isInteger()))error('defaults.'+field,'DEFAULT_OUTSIDE_POLICY');
    }catch{error('defaults.'+field,'DEFAULT_VALUE_INVALID');}
  }
  for(const broker of new Set([...Object.keys(policy.equities||{}),...Object.keys(policy.balances||{})])){
    try{const equity=D(policy.equities?.[broker]??0),balance=D(policy.balances?.[broker]??equity);
      if(!equity.isFinite()||!balance.isFinite()||equity.lt(0)||balance.lt(0)||balance.gt(equity))error('capital.'+broker,'CAPITAL_CONFIGURATION_INVALID');
    }catch{error('capital.'+broker,'CAPITAL_CONFIGURATION_INVALID');}
  }
  return {status:issues.length?'CONFLICT':'CONSISTENT',issues};
}

export function readinessCapacity(policy,daily,exposure){
  const remaining=(limit,...used)=>amount(Money.max(0,used.reduce((value,item)=>value.minus(item??0),D(limit))));
  return {
    dailyExecutionCount:daily.trades,reservedExecutions:exposure.reservedTrades??0,
    remainingDailyExecutions:Number(remaining(policy.maxTradesPerDay,daily.trades,exposure.reservedTrades)),
    dailyNotionalUsed:daily.notional,reservedNotional:exposure.reservedNotional??'0',
    remainingDailyNotional:remaining(policy.maxDailyNotional,daily.notional,exposure.reservedNotional),
    uniqueSymbolsCommitted:exposure.openPositions,remainingUniqueSymbols:Number(remaining(policy.maxOpenPositions,exposure.openPositions)),
    allocationLimitEnforced:false,
    note:'Execution counts include entries and exits. Pending intents follow worker reservations; these are not guaranteed future BUY slots.'
  };
}
