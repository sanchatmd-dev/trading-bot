import {D,Money,amount,down,exact} from '../money.js';
import {normalizeSymbol} from '../domain.js';

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
  if(!isExit&&D(daily.realized_r).lte(D(policy.maxDailyLossR).abs().neg()))return reject('Maximum daily loss reached');
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

  try {
    const price=D(signal.limitPrice||signal.referencePrice||0);
    if(price.lte(0))return reject('entry/reference_price is required for risk checks');
    const stop=signal.stopLoss===undefined?null:D(signal.stopLoss);
    if(signal.side==='BUY'&&stop&&stop.gte(price))return reject('BUY stop loss must be below entry');
    if(signal.side==='BUY'&&signal.takeProfit&&D(signal.takeProfit).lte(price))return reject('BUY take profit must be above entry');
    const equity=D(context.equity),balance=D(context.balance??context.equity);
    const committed=D(context.committedNotional||0),reserved=D(context.reservedNotional||0);
    const freeCash=D(context.cashAvailable??balance.minus(committed));
    let quantity=signal.quantity===undefined?null:D(signal.quantity),sizingAdjustment;
    if(isExit&&!quantity&&!signal.quoteQuantity)quantity=D(position.quantity);
    if(!quantity&&signal.quoteQuantity)quantity=D(down(D(signal.quoteQuantity).div(price)));
    if(!quantity&&signal.riskMode==='QUANTITY')quantity=D(signal.riskValue);
    if(!quantity&&signal.riskMode==='FIXED_NOTIONAL')quantity=D(down(D(signal.riskValue).div(price)));
    if(!quantity&&signal.riskMode==='PERCENT_EQUITY'){
      if(!stop)return reject('stop_loss is required for Percent equity');
      if(D(signal.riskValue).gt(policy.maxRiskPercent))return reject('Risk percent exceeds policy');
      const distance=price.minus(stop).abs();
      if(distance.isZero())return reject('Stop loss must differ from entry');
      quantity=D(down(equity.mul(signal.riskValue).div(100).div(distance)));
      if(signal.side==='BUY'&&policy.capPercentEquitySize){
        const available=Money.min(equity.minus(committed),freeCash,D(policy.maxOrderNotional),D(policy.maxDailyNotional).minus(daily.notional).minus(reserved));
        if(available.lte(0))return reject('No remaining Spot sizing budget');
        const requestedQuantity=quantity.toFixed();
        quantity=Money.min(quantity,D(down(available.div(price))));
        if(quantity.lt(requestedQuantity))sizingAdjustment={requestedQuantity,quantity:quantity.toFixed(),reason:'Capped to available equity and notional limits'};
      }
    }
    if(!quantity||quantity.lte(0))return reject('Unable to calculate quantity');
    if(isExit)quantity=Money.min(quantity,D(position.quantity));
    // Quantity and cash debit have an explicit 18-decimal contract.
    exact(quantity);
    const notional=D(amount(quantity.mul(price)));
    if(notional.lte(0))return reject('Invalid notional');
    if(!isExit){
      if(equity.lte(0))return reject('Positive account equity is required');
      if(!stop)return reject('stop_loss is required for all entry sizing modes');
      if(quantity.mul(price.minus(stop).abs()).gt(equity.mul(policy.maxRiskPercent).div(100)))return reject('Calculated risk exceeds maximum risk percent');
      if(notional.plus(committed).gt(equity))return reject('Order exceeds available configured Spot equity');
      if(notional.gt(freeCash))return reject('Order exceeds available configured Spot balance');
      if(notional.gt(policy.maxOrderNotional))return reject('Maximum order notional exceeded');
      if(notional.plus(daily.notional).plus(reserved).gt(policy.maxDailyNotional))return reject('Maximum daily notional exceeded');
    }
    return {ok:true,order:{...signal,quantity:quantity.toFixed(),price:exact(price),notional:notional.toFixed(),...(sizingAdjustment?{sizingAdjustment}:{})}};
  }catch(error){return reject(error.message);}
}
