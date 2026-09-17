const DAY=86400000;
const round=(value,digits=8)=>Number(Number(value||0).toFixed(digits));

export const currencyForBroker=broker=>broker==='binance-global'?'USDT':'THB';

export function analyticsWindow(period='monthly',from,to,now=Date.now()){
  const end=new Date(now),start=new Date(now);end.setUTCHours(23,59,59,999);
  if(period==='daily')start.setUTCHours(0,0,0,0);
  else if(period==='weekly'){start.setTime(end.getTime()-6*DAY);start.setUTCHours(0,0,0,0);}
  else if(period==='monthly'){start.setUTCDate(1);start.setUTCHours(0,0,0,0);}
  else if(period==='annually'){start.setUTCMonth(0,1);start.setUTCHours(0,0,0,0);}
  else if(period==='custom'){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||''))throw new Error('Custom period requires valid from and to dates');
    start.setTime(Date.parse(`${from}T00:00:00.000Z`));end.setTime(Date.parse(`${to}T23:59:59.999Z`));
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end||end-start>3660*DAY)throw new Error('Invalid analytics date range');
  } else throw new Error('Invalid analytics period');
  return {from:start.getTime(),to:end.getTime(),fromDate:start.toISOString().slice(0,10),toDate:end.toISOString().slice(0,10),period};
}

export function fifoAnalytics(rows,{feeBps=0}={}){
  const queues=new Map(),cycles=new Map(),realizations=[],closedPositions=[];
  for(const row of [...rows].sort((a,b)=>a.received_at-b.received_at||a.signal_id-b.signal_id||a.cumulative_quantity-b.cumulative_quantity)){
    const quantity=Number(row.quantity),price=Number(row.price),recordedFee=Number(row.fee_quote||0);
    if(![quantity,price,recordedFee].every(Number.isFinite)||!(quantity>0&&price>0)||recordedFee<0)throw new Error('Invalid analytics fill');
    const customFee=price*quantity*feeBps/10000,effectiveFee=recordedFee+customFee;
    const key=JSON.stringify([row.user_id||'',row.broker,row.execution_mode||'PAPER',row.symbol]);
    if(row.side==='BUY'){
      if(!cycles.has(key))cycles.set(key,{quantity:0,cost:0,proceeds:0,entryFees:0,fees:0,holding:0,entryTime:0,grossPnl:0,netPnl:0,cycleId:`${row.signal_id}:${row.cumulative_quantity}`});
      const queue=queues.get(key)||[];queue.push({quantity,price,time:row.received_at,fee:effectiveFee,tradeId:row.trade_id});queues.set(key,queue);continue;
    }
    if(row.side!=='SELL')continue;
    const queue=queues.get(key)||[];let remaining=quantity,matched=0,cost=0,entryFees=0,weightedEntryTime=0;
    while(remaining>1e-12&&queue.length){
      const lot=queue[0],take=Math.min(remaining,lot.quantity),share=take/lot.quantity;
      matched+=take;cost+=take*lot.price;entryFees+=lot.fee*share;weightedEntryTime+=take*lot.time;
      lot.quantity-=take;lot.fee-=lot.fee*share;remaining-=take;if(lot.quantity<=1e-12)queue.shift();
    }
    if(remaining>1e-8)throw new Error('Analytics SELL exceeds recorded FIFO inventory');
    if(matched<=0)continue;
    const exitFee=effectiveFee*(matched/quantity),entryPrice=cost/matched,grossPnl=(price-entryPrice)*matched,fees=entryFees+exitFee,netPnl=grossPnl-fees;
    const entryAt=weightedEntryTime/matched,capital=cost+entryFees;
    const cycle=cycles.get(key),holdingMs=Math.max(0,row.received_at-entryAt);
    const realized={tradeId:row.trade_id,cycleId:cycle.cycleId,broker:row.broker,currency:currencyForBroker(row.broker),symbol:row.symbol,quantity:round(matched),entryPrice:round(entryPrice),exitPrice:round(price),entryAt:Math.round(entryAt),exitAt:row.received_at,holdingMs,grossPnl:round(grossPnl),fees:round(fees),netPnl:round(netPnl),returnPercent:capital>0?round(netPnl/capital*100):null};
    realizations.push(realized);
    cycle.quantity+=matched;cycle.cost+=cost;cycle.proceeds+=price*matched;cycle.fees+=fees;cycle.entryFees+=entryFees;
    cycle.holding+=holdingMs*matched;cycle.entryTime+=weightedEntryTime;cycle.grossPnl+=grossPnl;cycle.netPnl+=netPnl;
    if(!queue.length){
      closedPositions.push({...realized,quantity:round(cycle.quantity),entryPrice:round(cycle.cost/cycle.quantity),exitPrice:round(cycle.proceeds/cycle.quantity),
        entryAt:Math.round(cycle.entryTime/cycle.quantity),holdingMs:Math.round(cycle.holding/cycle.quantity),grossPnl:round(cycle.grossPnl),fees:round(cycle.fees),netPnl:round(cycle.netPnl),
        returnPercent:cycle.cost+cycle.entryFees>0?round(cycle.netPnl/(cycle.cost+cycle.entryFees)*100):null});
      cycles.delete(key);
    }
  }
  return {realizations,closedPositions};
}
export const fifoClosedPositions=(rows,options)=>fifoAnalytics(rows,options).closedPositions;
export const fifoRealizations=(rows,options)=>fifoAnalytics(rows,options).realizations;

// Percentages are suppressed when an opening capital basis cannot be established, or funding changes mid-period.
export function analyticsCapital(funding,realizations,fills,window){
  const firstFill=fills.reduce((earliest,row)=>Math.min(earliest,row.received_at),Infinity);
  const basisTime=Math.max(window.from,Math.min(firstFill,window.to));
  const legacyUnknown=funding.some(row=>row.kind==='LEGACY_BASELINE'&&row.at>window.from&&firstFill<row.at);
  const changed=funding.some(row=>row.at>basisTime&&row.at<=window.to&&row.equity_delta!==0);
  const capital=funding.filter(row=>row.at<=basisTime).reduce((sum,row)=>sum+row.equity_delta,0);
  const priorPnl=realizations.filter(row=>row.exitAt<window.from).reduce((sum,row)=>sum+row.netPnl,0);
  return {startingEquity:legacyUnknown?null:round(capital+priorPnl),percentagesAvailable:!legacyUnknown&&!changed,
    capitalBasis:legacyUnknown?'LEGACY_FUNDING_HISTORY_UNAVAILABLE':changed?'CAPITAL_CHANGED_IN_PERIOD':'RECORDED_FUNDING',
    drawdownBasis:'REALIZED_FIFO_EXCLUDING_CASH_FLOWS',tradeDefinition:'FLAT_TO_FLAT_PER_BOT_BROKER_SYMBOL'};
}

export function filterClosedPositions(closed,{from,to,symbol}){
  return closed.filter(row=>row.exitAt>=from&&row.exitAt<=to&&(!symbol||row.symbol===symbol));
}

export function summarizeClosedPositions(closed,{startingEquity=0,currency='USDT',realizations=closed,percentagesAvailable=true}={}){
  const rows=[...closed].sort((a,b)=>a.exitAt-b.exitAt),wins=rows.filter(x=>x.netPnl>0),losses=rows.filter(x=>x.netPnl<0);
  const sum=list=>list.reduce((total,row)=>total+row.netPnl,0),netProfit=sum(realizations),closedNetProfit=sum(rows),grossWins=sum(wins),grossLosses=sum(losses);
  const average=list=>list.length?sum(list)/list.length:0,avgWin=average(wins),avgLoss=losses.length?Math.abs(average(losses)):0;
  let consecutiveWins=0,consecutiveLosses=0,maxConsecutiveWins=0,maxConsecutiveLosses=0,running=0,peak=startingEquity||0,maxDrawdown=0,maxDrawdownPercent=0;
  for(const row of rows){
    if(row.netPnl>0){consecutiveWins++;consecutiveLosses=0;maxConsecutiveWins=Math.max(maxConsecutiveWins,consecutiveWins);}
    else if(row.netPnl<0){consecutiveLosses++;consecutiveWins=0;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,consecutiveLosses);}else{consecutiveWins=0;consecutiveLosses=0;}
  }
  const equityCurve=[...realizations].sort((a,b)=>a.exitAt-b.exitAt).map(row=>{
    running+=row.netPnl;const equity=(startingEquity||0)+running;peak=Math.max(peak,equity);const drawdown=Math.min(0,equity-peak),drawdownPercent=peak>0?drawdown/peak*100:0;
    maxDrawdown=Math.min(maxDrawdown,drawdown);maxDrawdownPercent=Math.min(maxDrawdownPercent,drawdownPercent);
    return {time:row.exitAt,cumulativePnl:round(running),equity:startingEquity===null?null:round(equity),drawdown:round(drawdown),drawdownPercent:percentagesAvailable&&startingEquity>0?round(drawdownPercent):null};
  });
  const feeImpact=realizations.reduce((total,row)=>total+row.fees,0),totalTrades=rows.length;
  return {currency,totalTrades,wins:wins.length,losses:losses.length,breakeven:totalTrades-wins.length-losses.length,
    winRate:totalTrades?round(wins.length/totalTrades*100):0,netProfit:round(netProfit),closedNetProfit:round(closedNetProfit),netProfitPercent:percentagesAvailable&&startingEquity>0?round(netProfit/startingEquity*100):null,
    profitFactor:grossLosses<0?round(grossWins/Math.abs(grossLosses)):null,maxDrawdown:round(maxDrawdown),maxDrawdownPercent:percentagesAvailable&&startingEquity>0?round(maxDrawdownPercent):null,
    expectancy:totalTrades?round(closedNetProfit/totalTrades):0,avgWin:round(avgWin),avgLoss:round(avgLoss),avgWinLossRatio:avgLoss>0?round(avgWin/avgLoss):null,
    maxConsecutiveWins,maxConsecutiveLosses,averageHoldingMs:totalTrades?Math.round(rows.reduce((total,row)=>total+row.holdingMs,0)/totalTrades):0,
    feeImpact:round(feeImpact),startingEquity:startingEquity===null?null:round(startingEquity),equityCurve};
}

const isoDay=time=>new Date(time).toISOString().slice(0,10);
export function groupClosedPositions(closed,period,{startingEquity=0,currency='USDT',realizations=closed,percentagesAvailable=true}={}){
  const keyFor=row=>{
    const date=new Date(row.exitAt);
    if(period==='annually')return String(date.getUTCFullYear());
    if(period==='monthly')return date.toISOString().slice(0,7);
    if(period==='weekly'){
      const start=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));
      start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
      return isoDay(start);
    }
    return isoDay(row.exitAt);
  };
  const buckets=[...new Set([...closed,...realizations].map(keyFor))].sort();
  let opening=startingEquity;
  return buckets.map(bucket=>{
    const rows=closed.filter(row=>keyFor(row)===bucket),events=realizations.filter(row=>keyFor(row)===bucket);
    const {equityCurve,...metrics}=summarizeClosedPositions(rows,{startingEquity:opening,currency,realizations:events,percentagesAvailable});
    if(opening!==null)opening+=events.reduce((sum,row)=>sum+row.netPnl,0);
    return {bucket,...metrics};
  });
}

export function breakdownClosedPositions(closed,{startingEquity=0,currency='USDT',realizations=closed,percentagesAvailable=true}={}){
  return [...new Set([...closed,...realizations].map(row=>row.symbol))].map(symbol=>{
    const rows=closed.filter(row=>row.symbol===symbol);
    return {symbol,...summarizeClosedPositions(rows,{startingEquity,currency,realizations:realizations.filter(row=>row.symbol===symbol),percentagesAvailable}),closedTrades:rows.length};
  }).sort((a,b)=>b.netProfit-a.netProfit);
}
