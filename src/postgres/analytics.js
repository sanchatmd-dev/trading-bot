import {D,Money,amount,sum} from '../money.js';
export {analyticsWindow,filterClosedPositions,currencyForBroker} from '../analytics.js';
import {currencyForBroker} from '../analytics.js';
const ratio=(a,b)=>D(b).isZero()?null:D(a).div(b).toDecimalPlaces(8).toNumber();
const percent=(a,b)=>ratio(D(a).mul(100),b);
const zero=()=>new Money(0);

export function fifoAnalytics(rows,{feeBps=0}={}){
  const books=new Map(),realizations=[],closedPositions=[],legacyAdjustments=[];
  const sorted=[...rows].sort((a,b)=>a.received_at-b.received_at||a.signal_id-b.signal_id||D(a.cumulative_quantity).cmp(b.cumulative_quantity));
  for(const row of sorted){
    let qty=D(row.quantity);
    const price=D(row.price),quote=D(row.quote_amount??qty.mul(price)),fee=D(row.fee_quote||0).plus(quote.mul(feeBps).div(10000));
    if(qty.lte(0)||price.lte(0)||fee.lt(0))throw new Error('Invalid analytics fill');
    const key=JSON.stringify([row.user_id,row.broker,row.execution_mode,row.symbol]);
    if(row.side==='BUY'){
      if(!books.has(key))books.set(key,{lots:[],cycleId:row.signal_id+':'+row.cumulative_quantity,qty:zero(),cost:zero(),proceeds:zero(),fees:zero(),entryFees:zero(),entryTime:zero(),holding:zero()});
      const book=books.get(key);book.legacy ||= row.legacy_float===1;
      book.lots.push({qty,cost:quote,fee,time:row.received_at});continue;
    }
    if(row.side!=='SELL')continue;
    const book=books.get(key);if(!book)throw new Error('Analytics SELL exceeds recorded FIFO inventory');
    const inventory=sum(book.lots.map(lot=>lot.qty)),difference=inventory.minus(qty);
    // Imported SQLite cycles used floating-point dust cutoffs. Preserve original
    // fills/cash; normalize only an explicitly legacy cycle's near-flat analytics.
    // No tolerance is ever used for execution or a wholly PostgreSQL-native cycle.
    if((book.legacy||row.legacy_float===1)&&!difference.isZero()&&difference.abs().lte('0.000000000001')){
      legacyAdjustments.push({signalId:row.signal_id,quantityDelta:difference.toFixed(),reason:'LEGACY_FLOAT_NEAR_FLAT',ledgerChanged:false});qty=inventory;
    }
    let remaining=qty,cost=zero(),entryFees=zero(),weightedTime=zero();
    while(remaining.gt(0)&&book.lots.length){
      const lot=book.lots[0],take=Money.min(remaining,lot.qty),allocatedFee=take.eq(lot.qty)?lot.fee:lot.fee.mul(take).div(lot.qty),allocatedCost=take.eq(lot.qty)?lot.cost:lot.cost.mul(take).div(lot.qty);
      cost=cost.plus(allocatedCost);entryFees=entryFees.plus(allocatedFee);weightedTime=weightedTime.plus(take.mul(lot.time));
      lot.qty=lot.qty.minus(take);lot.cost=lot.cost.minus(allocatedCost);lot.fee=lot.fee.minus(allocatedFee);remaining=remaining.minus(take);if(lot.qty.isZero())book.lots.shift();
    }
    if(remaining.gt(0))throw new Error('Analytics SELL exceeds recorded FIFO inventory by '+remaining.toFixed());
    const proceeds=quote,fees=entryFees.plus(fee),net=proceeds.minus(cost).minus(fees),entryAt=weightedTime.div(qty),holding=Money.max(0,new Money(row.received_at).minus(entryAt));
    const event={tradeId:row.trade_id,cycleId:book.cycleId,broker:row.broker,currency:currencyForBroker(row.broker),symbol:row.symbol,quantity:amount(qty),entryPrice:amount(cost.div(qty)),exitPrice:amount(price),entryAt:entryAt.round().toNumber(),exitAt:row.received_at,holdingMs:holding.round().toNumber(),grossPnl:amount(proceeds.minus(cost)),fees:amount(fees),netPnl:amount(net),returnPercent:percent(net,cost.plus(entryFees))};
    realizations.push(event);
    book.qty=book.qty.plus(qty);book.cost=book.cost.plus(cost);book.proceeds=book.proceeds.plus(proceeds);book.fees=book.fees.plus(fees);book.entryFees=book.entryFees.plus(entryFees);book.entryTime=book.entryTime.plus(weightedTime);book.holding=book.holding.plus(holding.mul(qty));
    if(!book.lots.length){
      const net=book.proceeds.minus(book.cost).minus(book.fees);
      closedPositions.push({...event,quantity:amount(book.qty),entryPrice:amount(book.cost.div(book.qty)),exitPrice:amount(book.proceeds.div(book.qty)),entryAt:book.entryTime.div(book.qty).round().toNumber(),holdingMs:book.holding.div(book.qty).round().toNumber(),grossPnl:amount(book.proceeds.minus(book.cost)),fees:amount(book.fees),netPnl:amount(net),returnPercent:percent(net,book.cost.plus(book.entryFees))});books.delete(key);
    }
  }
  return {realizations,closedPositions,legacyAdjustments};
}
export function analyticsCapital(funding,realizations,fills,window){
  const first=fills.reduce((n,row)=>Math.min(n,row.received_at),Infinity),basisTime=Math.max(window.from,Math.min(first,window.to));
  const unknown=funding.some(r=>r.kind==='LEGACY_BASELINE'&&r.at>window.from&&first<r.at);
  const changed=funding.some(r=>r.at>basisTime&&r.at<=window.to&&!D(r.equity_delta).isZero());
  const capital=sum(funding.filter(r=>r.at<=basisTime).map(r=>r.equity_delta)),prior=sum(realizations.filter(r=>r.exitAt<window.from).map(r=>r.netPnl));
  return {startingEquity:unknown?null:amount(capital.plus(prior)),percentagesAvailable:!unknown&&!changed,capitalBasis:unknown?'LEGACY_FUNDING_HISTORY_UNAVAILABLE':changed?'CAPITAL_CHANGED_IN_PERIOD':'RECORDED_FUNDING',drawdownBasis:'REALIZED_FIFO_EXCLUDING_CASH_FLOWS',tradeDefinition:'FLAT_TO_FLAT_PER_BOT_BROKER_SYMBOL'};
}
export function summarizeClosedPositions(closed,{startingEquity=0,currency='USDT',realizations=closed,percentagesAvailable=true}={}){
  const rows=[...closed].sort((a,b)=>a.exitAt-b.exitAt),wins=rows.filter(r=>D(r.netPnl).gt(0)),losses=rows.filter(r=>D(r.netPnl).lt(0));
  const total=list=>sum(list.map(r=>r.netPnl)),net=total(realizations),closedNet=total(rows),grossWins=total(wins),grossLosses=total(losses).abs();
  const avgWin=wins.length?grossWins.div(wins.length):zero(),avgLoss=losses.length?grossLosses.div(losses.length):zero();
  let cw=0,cl=0,mw=0,ml=0,running=zero(),peak=D(startingEquity||0),mdd=zero(),mddPercent=0;
  for(const r of rows){if(D(r.netPnl).gt(0)){cw++;cl=0;mw=Math.max(mw,cw);}else if(D(r.netPnl).lt(0)){cl++;cw=0;ml=Math.max(ml,cl);}else{cw=0;cl=0;}}
  const showPercent=percentagesAvailable&&D(startingEquity||0).gt(0);
  const equityCurve=[...realizations].sort((a,b)=>a.exitAt-b.exitAt).map(r=>{
    running=running.plus(r.netPnl);const equity=D(startingEquity||0).plus(running);peak=Money.max(peak,equity);
    const dd=Money.min(0,equity.minus(peak)),dp=peak.gt(0)?percent(dd,peak):0;mdd=Money.min(mdd,dd);mddPercent=Math.min(mddPercent,dp);
    return {time:r.exitAt,cumulativePnl:amount(running),equity:startingEquity===null?null:amount(equity),drawdown:amount(dd),drawdownPercent:showPercent?dp:null};
  });
  return {currency,totalTrades:rows.length,wins:wins.length,losses:losses.length,breakeven:rows.length-wins.length-losses.length,winRate:rows.length?wins.length/rows.length*100:0,netProfit:amount(net),closedNetProfit:amount(closedNet),netProfitPercent:showPercent?percent(net,startingEquity):null,profitFactor:ratio(grossWins,grossLosses),maxDrawdown:amount(mdd),maxDrawdownPercent:showPercent?mddPercent:null,expectancy:amount(rows.length?closedNet.div(rows.length):0),avgWin:amount(avgWin),avgLoss:amount(avgLoss),avgWinLossRatio:ratio(avgWin,avgLoss),maxConsecutiveWins:mw,maxConsecutiveLosses:ml,averageHoldingMs:rows.length?Math.round(rows.reduce((n,r)=>n+r.holdingMs,0)/rows.length):0,feeImpact:amount(sum(realizations.map(r=>r.fees))),startingEquity:startingEquity===null?null:amount(startingEquity),equityCurve};
}
export function groupClosedPositions(closed,period,options={}){
  const events=options.realizations||closed;
  const key=r=>{const d=new Date(r.exitAt);if(period==='annually')return String(d.getUTCFullYear());if(period==='monthly')return d.toISOString().slice(0,7);if(period==='weekly')d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);};
  let opening=options.startingEquity??(options.startingEquity===null?null:0);
  return [...new Set([...closed,...events].map(key))].sort().map(bucket=>{
    const realized=events.filter(r=>key(r)===bucket),{equityCurve,...metrics}=summarizeClosedPositions(closed.filter(r=>key(r)===bucket),{...options,startingEquity:opening,realizations:realized});
    if(opening!==null)opening=amount(D(opening).plus(sum(realized.map(r=>r.netPnl))));return {bucket,...metrics};
  });
}
export function breakdownClosedPositions(closed,options={}){
  const events=options.realizations||closed;
  return [...new Set([...closed,...events].map(r=>r.symbol))].map(symbol=>{const rows=closed.filter(r=>r.symbol===symbol);return {symbol,...summarizeClosedPositions(rows,{...options,realizations:events.filter(r=>r.symbol===symbol)}),closedTrades:rows.length};}).sort((a,b)=>D(b.netProfit).cmp(a.netProfit));
}
