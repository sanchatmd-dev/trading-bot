export function evaluateRisk(signal,context){
  const {policy,daily,position,now=Date.now()}=context;
  const reject=reason=>({ok:false,reason});
  const isSpot=['binance-global','binance-th','innovestx'].includes(signal.broker);
  const isExit=isSpot&&signal.side==='SELL'&&signal.reduceOnly;
  if(context.globalKill||policy.killSwitch)return reject('Kill switch is active');
  if(!context.licensed)return reject('License is inactive or expired');
  if(now-signal.timestamp>policy.maxSignalAgeSeconds*1000)return reject('Signal is stale');
  if(!isExit&&daily.trades>=policy.maxTradesPerDay)return reject('Maximum trades per day reached');
  if(!isExit&&daily.realized_r<=-Math.abs(policy.maxDailyLossR))return reject('Maximum daily loss reached');
  if(!isExit&&daily.loss_streak>=policy.pauseAfterLossStreak)return reject('Trading paused after loss streak');
  if(!isExit&&policy.blockHighVolatility&&signal.volatilityPercent!==undefined&&signal.volatilityPercent>policy.maxVolatilityPercent)return reject('High volatility block is active');
  if(!isExit&&policy.blockDuringNews&&signal.newsRisk)return reject('News trading block is active');
  if(policy.allowedSymbols?.length&&!policy.allowedSymbols.includes(signal.symbol))return reject('Symbol is not allowed');
  if(policy.sideMode==='BUY_ONLY'&&signal.side!=='BUY'&&!isExit)return reject('Only BUY is allowed');
  if(policy.sideMode==='SELL_ONLY'&&signal.side!=='SELL')return reject('Only SELL is allowed');
  if(signal.side==='BUY'&&context.openPositions>=policy.maxOpenPositions)return reject('Maximum open positions reached');
  if(signal.side==='BUY'&&policy.onePositionPerSymbol&&(position.quantity>0||context.hasPendingOrder))return reject('Position or pending order already exists for symbol');
  if(isSpot&&signal.leverage!==1)return reject('Spot leverage must equal 1');
  if(isSpot&&signal.side==='SELL'&&policy.requireReduceOnlySell&&!signal.reduceOnly)return reject('Spot SELL must be reduce_only');
  if(isSpot&&signal.side==='SELL'&&position.quantity<=0)return reject('No Spot position available to sell');
  const price=signal.limitPrice||signal.referencePrice;
  if(!price)return reject('entry/reference_price is required for risk checks');
  if(signal.side==='BUY'&&signal.stopLoss&&signal.stopLoss>=price)return reject('BUY stop loss must be below entry');
  if(signal.side==='BUY'&&signal.takeProfit&&signal.takeProfit<=price)return reject('BUY take profit must be above entry');
  let quantity=signal.quantity;
  if(isSpot&&signal.side==='SELL'&&signal.reduceOnly&&!quantity&&!signal.quoteQuantity)quantity=position.quantity;
  if(!quantity&&signal.quoteQuantity)quantity=signal.quoteQuantity/price;
  if(!quantity&&signal.riskMode==='QUANTITY')quantity=signal.riskValue;
  if(!quantity&&signal.riskMode==='FIXED_NOTIONAL')quantity=signal.riskValue/price;
  if(!quantity&&signal.riskMode==='PERCENT_EQUITY'){
    if(!signal.stopLoss)return reject('stop_loss is required for Percent equity');
    if(signal.riskValue>policy.maxRiskPercent)return reject('Risk percent exceeds policy');
    const distance=Math.abs(price-signal.stopLoss); if(!distance)return reject('Stop loss must differ from entry');
    quantity=(context.equity*signal.riskValue/100)/distance;
  }
  if(!Number.isFinite(quantity)||quantity<=0)return reject('Unable to calculate quantity');
  if(isSpot&&signal.side==='SELL')quantity=Math.min(quantity,position.quantity);
  const notional=quantity*price;
  if(!isExit&&notional>policy.maxOrderNotional)return reject('Maximum order notional exceeded');
  if(!isExit&&daily.notional+notional>policy.maxDailyNotional)return reject('Maximum daily notional exceeded');
  return {ok:true,order:{...signal,quantity,price,notional}};
}
