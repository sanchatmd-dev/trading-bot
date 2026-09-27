import {D,Money,amount,exact} from '../money.js';
import {fail} from '../pine-bridge/source.js';
import {executionPrice} from '../pine-bridge/contract.js';
import {roundBridgeOrder} from './pine-bridge-execution.js';

export const COST_MODEL_VERSION='paper-close-cost-v2';

// This finalizer runs after existing risk checks. It never increases quantity or
// repairs a legacy rejection. Existing paper-close-v1 decisions remain unchanged.
export function finalizeBridgeOrder(order,model,{policy,account,signal=order,exposure={}}={}) {
  if(model.version==='paper-close-v1')return roundBridgeOrder(order,model);
  if(model.version!==COST_MODEL_VERSION)throw fail('UNSUPPORTED_EXECUTION_MODEL');
  let finalized=roundBridgeOrder(order,model);
  const stamp=result=>{
    if(D(result.order.notional).lte(0))throw fail('BELOW_NOTIONAL_PRECISION');
    return {...result,order:{...result.order,execution_model_version:COST_MODEL_VERSION,reserved_fee_bps:exact(model.fee_bps)}};
  };
  if(order.side!=='BUY')return stamp(finalized);
  if(exposure.feeReservationUnknown)throw fail('PENDING_FEE_RESERVATION_UNKNOWN');
  const price=D(order.price),stop=D(order.stopLoss),feeRate=D(model.fee_bps).div(10000);
  if(stop.lte(0)||stop.gte(price))throw fail('INVALID_ENTRY_LEVELS');
  const stopPrice=D(executionPrice(Number(stop),'EXIT',model.slippage_bps,model.price_tick));
  if(stopPrice.lte(0))throw fail('INVALID_MODELED_STOP_PRICE');
  const unitLoss=price.minus(stopPrice).plus(price.plus(stopPrice).mul(feeRate));
  const percentage=signal.riskMode==='PERCENT_EQUITY'&&signal.quantity===undefined&&signal.quoteQuantity===undefined;
  const riskPercent=percentage?Money.min(D(signal.riskValue),D(policy.maxRiskPercent)):D(policy.maxRiskPercent);
  const riskBudget=D(account.bookEquity).mul(riskPercent).div(100);
  const reservedFees=D(exposure.reservedFees??0);
  const cashBudget=D(account.cash).minus(exposure.reservedNotional??0).minus(reservedFees);
  const exposureBudget=D(account.bookEquity).minus(exposure.committedNotional??0).minus(reservedFees);
  if(riskBudget.lte(0)||cashBudget.lte(0)||exposureBudget.lte(0))throw fail('NO_COST_INCLUSIVE_BUDGET');
  const metrics=result=>{
    const stopNotional=amount(D(result.order.quantity).mul(stopPrice));
    const stopFee=amount(D(stopNotional).mul(feeRate));
    return {cashDebit:amount(D(result.order.notional).plus(result.fee)),
      estimatedLossAtStop:amount(D(result.order.notional).plus(result.fee).minus(stopNotional).plus(stopFee)),
      estimatedStopExitPrice:exact(stopPrice),estimatedStopExitFee:stopFee,entryFee:result.fee,
      riskBudget:amount(riskBudget),riskLimitIncludesCosts:true,rAccounting:'PRICE_DISTANCE_V1',
      assumption:'Conditional stop-close estimate with fees, adverse slippage and tick rounding. Gaps can exceed this loss; ledger R retains price-distance semantics.'};
  };
  const violation=costs=>D(costs.estimatedLossAtStop).gt(riskBudget)?'COST_INCLUSIVE_RISK_EXCEEDED':
    D(costs.cashDebit).gt(cashBudget)?'COST_INCLUSIVE_CASH_EXCEEDED':
      D(costs.cashDebit).gt(exposureBudget)?'COST_INCLUSIVE_EXPOSURE_EXCEEDED':null;
  if(percentage){
    const maxQuantity=Money.min(D(finalized.order.quantity),riskBudget.div(unitLoss),cashBudget.div(price.mul(D(1).plus(feeRate))),exposureBudget.div(price.mul(D(1).plus(feeRate))));
    const quantity=maxQuantity.div(model.quantity_step).floor().mul(model.quantity_step);
    if(quantity.lte(0))throw fail('BELOW_QUANTITY_STEP');
    finalized=roundBridgeOrder({...order,quantity:exact(quantity)},model);
    // Decimal cash/fee rounding can cross a boundary by one quote unit. Search
    // the finite quantity grid rather than silently allowing that overspend.
    if(violation(metrics(finalized))){
      let low=D(0),high=quantity.div(model.quantity_step).floor(),best=null;
      for(let attempts=0;high.gte(low)&&attempts<256;attempts++){
        const middle=low.plus(high).div(2).floor();
        if(middle.isZero()){low=D(1);continue;}
        const candidate=roundBridgeOrder({...order,quantity:exact(middle.mul(model.quantity_step))},model);
        if(violation(metrics(candidate)))high=middle.minus(1);
        else{best=candidate;low=middle.plus(1);}
      }
      if(!best)throw fail('BELOW_QUANTITY_STEP');
      finalized=best;
    }
    if(D(finalized.order.quantity).lt(order.quantity))finalized.order.sizingAdjustment={...order.sizingAdjustment,
      requestedQuantity:order.sizingAdjustment?.requestedQuantity??exact(order.quantity),quantity:finalized.order.quantity,
      reason:'Capped to cost-inclusive stop risk, available cash and exposure, then rounded to the quantity step'};
  }
  const costs=metrics(finalized),reason=violation(costs);
  if(reason)throw fail(reason);
  return {...stamp(finalized),costs};
}
