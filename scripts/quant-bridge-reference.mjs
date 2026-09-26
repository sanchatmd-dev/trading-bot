// Offline oracle using production risk/Bridge functions. No server, database,
// provider, network connection, credentials or Bot activation is involved.
import {evaluateRisk} from '../src/postgres/risk.js';
import {levels,exitDecision,executionPrice} from '../src/pine-bridge/contract.js';
import {roundBridgeOrder} from '../src/postgres/pine-bridge-execution.js';
import {D,amount,exact} from '../src/money.js';
import {canonical,hash} from '../src/pine-bridge/source.js';

function intents(request){
  const entries=[],events=[];let previous=0;
  for(const bar of request.bars){
    if(bar.time<=previous)throw Error('NON_MONOTONIC_CLOSED_BARS');previous=bar.time;
    let exitBar=bar.native_exit,sequence=0;
    for(let i=entries.length-1;i>=0;i--){
      const entry=entries[i],decision=exitDecision(entry,bar,bar.native_exit);
      if(decision){events.push({event_type:'EXIT',time:bar.time,entry_ref:entry.entry_ref,sequence:sequence++,reason:decision.reason,sl:null,tp:null});entries.splice(i,1);exitBar=true;}
    }
    if(bar.buy&&!exitBar&&bar.atr14!==null){
      let protection;
      try{protection=levels(Number(bar.close),Number(bar.atr14),Number(request.multiplier),Number(request.rr),Number(request.model.price_tick));}
      catch(error){if(error.code==='INVALID_ENTRY_LEVELS')continue;throw error;}
      if(entries.length>=1000)throw Error('BRIDGE_INTENT_CAPACITY_REACHED');
      const entry_ref=request.deployment_id+':'+bar.time+':0';
      entries.push({time:bar.time,entry_ref,...protection});events.push({event_type:'BUY',time:bar.time,entry_ref,sequence:0,reason:null,...protection});
    }
  }
  return events;
}

function replay(request){
  const events=intents(request),byTime=new Map(request.bars.map(b=>[b.time,b]));
  const positions=new Map(),daily=new Map(),decisions=[],fills=[];
  let cash=D(request.cash),cost=D(0),quantity=D(0),initialRisk=D(0),pnl=D(0),lossStreak=0;
  const model=request.model,feeRatio=D(model.fee_bps).div(10000);
  for(const event of events){
    if(request.start_time!==undefined&&event.time<request.start_time)continue;
    const bar=byTime.get(event.time),day=new Date(event.time).toISOString().slice(0,10);
    const stats=daily.get(day)??{trades:0,notional:'0',realized_r:'0',loss_streak:0};stats.loss_streak=lossStreak;
    const target=positions.get(event.entry_ref);
    let reason=event.event_type==='EXIT'&&!target?'TARGET_NOT_OPEN':null;
    const signal={broker:request.broker,symbol:request.symbol,timeframe:'1',event:event.event_type==='BUY'?'BUY':'SELL',side:event.event_type==='BUY'?'BUY':'SELL',reduceOnly:event.event_type==='EXIT',leverage:1,timestamp:event.time,referencePrice:executionPrice(Number(bar.close),event.event_type,Number(model.slippage_bps),Number(model.price_tick)),...(event.event_type==='BUY'?{stopLoss:event.sl,takeProfit:event.tp,riskMode:'PERCENT_EQUITY',riskValue:model.risk_percent}:{targetTradeId:event.entry_ref}),volatilityPercent:D(bar.high).minus(bar.low).div(bar.close).mul(100).toNumber()};
    const context={policy:request.policy,daily:stats,position:{quantity:exact(quantity)},targetAllocation:target?{remaining_quantity:target.quantity}:null,now:event.time,equity:amount(D(request.equity).plus(cash.minus(request.cash)).plus(cost)),balance:exact(cash),cashAvailable:amount(event.event_type==='BUY'?cash.div(D(1).plus(feeRatio)):cash),committedNotional:exact(cost),reservedNotional:'0',reservedTrades:0,openPositions:quantity.gt(0)?1:0,licensed:true,globalKill:false,hasPendingOrder:false};
    const risk=reason?{ok:false,reason}:evaluateRisk(signal,context);
    let order,fee;
    if(risk.ok){try{({order,fee}=roundBridgeOrder(risk.order,model));}catch(error){reason=error.code??error.message;}}
    else reason=risk.reason;
    if(reason){decisions.push({...event,outcome:'REJECTED',reason,quantity:'0',fee:'0'});continue;}
    const q=D(order.quantity),notional=D(order.notional),f=D(fee);
    let realizedR=D(0);
    if(event.event_type==='BUY'){
      cash=cash.minus(notional).minus(f);cost=cost.plus(notional).plus(f);quantity=quantity.plus(q);
      initialRisk=D(amount(initialRisk.plus(q.mul(D(order.price).minus(event.sl).abs()))));
      positions.set(event.entry_ref,{quantity:exact(q),entry_price:amount(notional.plus(f).div(q))});
    }else{
      const removed=q.mul(target.entry_price),profit=notional.minus(removed).minus(f);
      cash=cash.plus(notional).minus(f);cost=cost.minus(removed);quantity=quantity.minus(q);pnl=D(amount(pnl.plus(profit)));
      realizedR=initialRisk.gt(0)?profit.div(initialRisk):D(0);
      positions.delete(event.entry_ref);
      if(quantity.isZero()){lossStreak=pnl.lt(0)?lossStreak+1:0;initialRisk=D(0);pnl=D(0);}
    }
    stats.trades++;stats.notional=amount(D(stats.notional).plus(notional));stats.realized_r=amount(D(stats.realized_r).plus(amount(realizedR)));daily.set(day,stats);
    const fill={...event,outcome:'FILLED',sizing_outcome:order.sizingAdjustment?'CAPPED':'ACCEPTED',sizing_adjustment:order.sizingAdjustment??null,quantity:exact(q),price:order.price,notional:exact(notional),fee:exact(f),cash:amount(cash),cost:amount(cost),realized_r:amount(realizedR)};
    fills.push(fill);decisions.push(fill);
  }
  return {events,decisions,fills,final_cash:amount(cash),position_quantity:exact(quantity),position_cost:amount(cost),open_allocations:positions.size};
}

let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>32*1024*1024)throw Error('REFERENCE_INPUT_TOO_LARGE');}
const request=JSON.parse(raw);
const result=request.operation==='hash'?{hash:hash(canonical(request.value))}:request.operation==='risk'?evaluateRisk(request.signal,request.context):request.operation==='replay'?replay(request):(()=>{throw Error('UNKNOWN_REFERENCE_OPERATION');})();
process.stdout.write(JSON.stringify(result));
