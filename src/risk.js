import {normalizeSymbol} from './domain.js';

export function evaluateRisk(signal,context){
  const {policy,daily,position,now=Date.now()}=context;
  const reject=reason=>({ok:false,reason});
  const isSpot=['binance-global','binance-th','innovestx','settrade'].includes(signal.broker);
  if(!isSpot)return reject('Only Spot simulation is supported in this release');
  const quoteCurrency=signal.broker==='binance-global'?'USDT':'THB';
  if(signal.broker.startsWith('binance-')&&!signal.symbol.endsWith(quoteCurrency))return reject(`This account supports ${quoteCurrency} quote currency only`);
  const isExit=isSpot&&signal.side==='SELL'&&signal.reduceOnly;
  if(!isExit&&(context.globalKill||policy.killSwitch))return reject('Kill switch is active: entries paused');
  if(!isExit&&!context.licensed)return reject('License is inactive or expired');
  if(now-signal.timestamp>policy.maxSignalAgeSeconds*1000)return reject('Signal is stale');
  if(!isExit&&daily.trades+(context.reservedTrades||0)>=policy.maxTradesPerDay)return reject('Maximum trades per day reached');
  if(!isExit&&daily.realized_r<=-Math.abs(policy.maxDailyLossR))return reject('Maximum daily loss reached');
  if(!isExit&&daily.loss_streak>=policy.pauseAfterLossStreak)return reject('Trading paused after loss streak');
  if(!isExit&&policy.blockHighVolatility&&!Number.isFinite(signal.volatilityPercent))return reject('Missing volatility data');
  if(!isExit&&policy.blockHighVolatility&&signal.volatilityPercent>policy.maxVolatilityPercent)return reject('High volatility block is active');
  if(!isExit&&policy.blockDuringNews&&typeof signal.newsRisk!=='boolean')return reject('Missing news risk data');
  if(!isExit&&policy.blockDuringNews&&signal.newsRisk)return reject('News trading block is active');
  if(!isExit&&policy.allowedSymbols?.length&&!policy.allowedSymbols.some(s=>normalizeSymbol(s,signal.broker)===signal.symbol))return reject('Symbol is not allowed');
  if(policy.sideMode==='BUY_ONLY'&&signal.side!=='BUY'&&!isExit)return reject('Only BUY is allowed');
  if(policy.sideMode==='SELL_ONLY'&&signal.side!=='SELL')return reject('Only SELL is allowed');
  const opensNewSymbol=signal.side==='BUY'&&position.quantity<=0&&!context.hasPendingOrder;
  if(opensNewSymbol&&context.openPositions>=policy.maxOpenPositions)return reject('Maximum open positions reached');
  if(signal.side==='BUY'&&policy.onePositionPerSymbol&&(position.quantity>0||context.hasPendingOrder))return reject('Position or pending order already exists for symbol');
  if(isExit&&context.hasPendingOrder)return reject('Pending order already reserves this symbol');
  if(isSpot&&signal.leverage!==1)return reject('Spot leverage must equal 1');
  if(isSpot&&signal.side==='SELL'&&!signal.reduceOnly)return reject('Spot SELL must be reduce_only');
  if(isSpot&&signal.side==='SELL'&&position.quantity<=0)return reject('No Spot position available to sell');
  const price=signal.limitPrice||signal.referencePrice;
  if(!price)return reject('entry/reference_price is required for risk checks');
  if(signal.side==='BUY'&&signal.stopLoss&&signal.stopLoss>=price)return reject('BUY stop loss must be below entry');
  if(signal.side==='BUY'&&signal.takeProfit&&signal.takeProfit<=price)return reject('BUY take profit must be above entry');
  const availableBalance=Number.isFinite(context.balance)?context.balance:context.equity;
  const freeCash=context.cashAvailable ?? availableBalance-(context.committedNotional||0);
  let quantity=signal.quantity,sizingAdjustment;
  if(isSpot&&signal.side==='SELL'&&signal.reduceOnly&&!quantity&&!signal.quoteQuantity)quantity=position.quantity;
  if(!quantity&&signal.quoteQuantity)quantity=signal.quoteQuantity/price;
  if(!quantity&&signal.riskMode==='QUANTITY')quantity=signal.riskValue;
  if(!quantity&&signal.riskMode==='FIXED_NOTIONAL')quantity=signal.riskValue/price;
  if(!quantity&&signal.riskMode==='PERCENT_EQUITY'){
    if(!signal.stopLoss)return reject('stop_loss is required for Percent equity');
    if(signal.riskValue>policy.maxRiskPercent)return reject('Risk percent exceeds policy');
    const distance=Math.abs(price-signal.stopLoss); if(!distance)return reject('Stop loss must differ from entry');
    quantity=(context.equity*signal.riskValue/100)/distance;
    if(signal.side==='BUY'&&policy.capPercentEquitySize){
      const available=Math.min(context.equity-(context.committedNotional||0),freeCash,policy.maxOrderNotional,policy.maxDailyNotional-daily.notional-(context.reservedNotional||0));
      if(!Number.isFinite(available)||available<=0)return reject('No remaining Spot sizing budget');
      const requestedQuantity=quantity;
      // Round down slightly so floating-point multiplication cannot exceed any hard cap.
      quantity=Math.min(quantity,available/price*(1-1e-12));
      if(quantity<requestedQuantity)sizingAdjustment={requestedQuantity,quantity,reason:'Capped to available equity and notional limits'};
    }
  }
  if(!Number.isFinite(quantity)||quantity<=0)return reject('Unable to calculate quantity');
  if(isSpot&&signal.side==='SELL')quantity=Math.min(quantity,position.quantity);
  const notional=quantity*price;
  if(!Number.isFinite(notional)||notional<=0)return reject('Invalid notional');
  if(!isExit){
    if(!Number.isFinite(context.equity)||context.equity<=0)return reject('Positive account equity is required');
    if(!signal.stopLoss)return reject('stop_loss is required for all entry sizing modes');
    const risk=quantity*Math.abs(price-signal.stopLoss);
    if(risk>context.equity*policy.maxRiskPercent/100+1e-8)return reject('Calculated risk exceeds maximum risk percent');
    if(notional+(context.committedNotional||0)>context.equity)return reject('Order exceeds available configured Spot equity');
    if(notional>freeCash)return reject('Order exceeds available configured Spot balance');
  }
  if(!isExit&&notional>policy.maxOrderNotional)return reject('Maximum order notional exceeded');
  if(!isExit&&daily.notional+(context.reservedNotional||0)+notional>policy.maxDailyNotional)return reject('Maximum daily notional exceeded');
  return {ok:true,order:{...signal,quantity,price,notional,...(sizingAdjustment?{sizingAdjustment}:{})}};
}
