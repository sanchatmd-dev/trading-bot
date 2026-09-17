import {normalizeSignal as legacyNormalize,normalizeSymbol} from '../domain.js';
import {exact,D} from '../money.js';
export {normalizeSymbol};
export function normalizeSignal(body,now=Date.now()){
  const signal=legacyNormalize(body,now);
  const values={riskValue:body.risk_value,quantity:body.quantity??body.volume,quoteQuantity:body.quote_quantity,
    referencePrice:body.reference_price??body.entry??body.entry_price,limitPrice:body.limit_price??body.price,
    stopLoss:body.stop_loss??body.sl,takeProfit:body.take_profit??body.tp};
  for(const [key,value]of Object.entries(values))if(value!==undefined&&value!==null&&value!==''){
    signal[key]=exact(value);if(D(signal[key]).lte(0))throw new Error(key+' must be greater than 0');
  }
  return signal;
}
