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

export function fifoClosedPositions(rows,{feeBps=0}={}){
  const queues=new Map(),closed=[];
  for(const row of [...rows].sort((a,b)=>a.received_at-b.received_at||a.signal_id-b.signal_id||a.cumulative_quantity-b.cumulative_quantity)){
    const quantity=Number(row.quantity),price=Number(row.price),recordedFee=Number(row.fee_quote||0);
    if(!(quantity>0&&price>0))continue;
    const customFee=price*quantity*feeBps/10000,effectiveFee=recordedFee+customFee,key=row.symbol;
    if(row.side==='BUY'){
      const queue=queues.get(key)||[];queue.push({quantity,price,time:row.received_at,fee:effectiveFee,tradeId:row.trade_id});queues.set(key,queue);continue;
    }
    if(row.side!=='SELL')continue;
    const queue=queues.get(key)||[];let remaining=quantity,matched=0,cost=0,entryFees=0,weightedEntryTime=0;
    while(remaining>1e-12&&queue.length){
      const lot=queue[0],take=Math.min(remaining,lot.quantity),share=take/lot.quantity;
      matched+=take;cost+=take*lot.price;entryFees+=lot.fee*share;weightedEntryTime+=take*lot.time;
      lot.quantity-=take;lot.fee-=lot.fee*share;remaining-=take;if(lot.quantity<=1e-12)queue.shift();
    }
    if(matched<=0)continue;
    const exitFee=effectiveFee*(matched/quantity),entryPrice=cost/matched,grossPnl=(price-entryPrice)*matched,fees=entryFees+exitFee,netPnl=grossPnl-fees;
    const entryAt=weightedEntryTime/matched,capital=cost+entryFees;
    closed.push({tradeId:row.trade_id,broker:row.broker,currency:currencyForBroker(row.broker),symbol:row.symbol,quantity:round(matched),entryPrice:round(entryPrice),exitPrice:round(price),entryAt:Math.round(entryAt),exitAt:row.received_at,holdingMs:Math.max(0,row.received_at-entryAt),grossPnl:round(grossPnl),fees:round(fees),netPnl:round(netPnl),returnPercent:capital>0?round(netPnl/capital*100):null});
  }
  return closed;
}

export function filterClosedPositions(closed,{from,to,symbol}){
  return closed.filter(row=>row.exitAt>=from&&row.exitAt<=to&&(!symbol||row.symbol===symbol));
}

export function summarizeClosedPositions(closed,{startingEquity=0,currency='USDT'}={}){
  const rows=[...closed].sort((a,b)=>a.exitAt-b.exitAt),wins=rows.filter(x=>x.netPnl>0),losses=rows.filter(x=>x.netPnl<0);
  const sum=list=>list.reduce((total,row)=>total+row.netPnl,0),netProfit=sum(rows),grossWins=sum(wins),grossLosses=sum(losses);
  const average=list=>list.length?sum(list)/list.length:0,avgWin=average(wins),avgLoss=losses.length?Math.abs(average(losses)):0;
  let consecutiveWins=0,consecutiveLosses=0,maxConsecutiveWins=0,maxConsecutiveLosses=0,running=0,peak=startingEquity,maxDrawdown=0,maxDrawdownPercent=0;
  const equityCurve=rows.map(row=>{
    running+=row.netPnl;const equity=startingEquity+running;peak=Math.max(peak,equity);const drawdown=Math.min(0,equity-peak),drawdownPercent=peak>0?drawdown/peak*100:0;
    maxDrawdown=Math.min(maxDrawdown,drawdown);maxDrawdownPercent=Math.min(maxDrawdownPercent,drawdownPercent);
    if(row.netPnl>0){consecutiveWins++;consecutiveLosses=0;maxConsecutiveWins=Math.max(maxConsecutiveWins,consecutiveWins);}
    else if(row.netPnl<0){consecutiveLosses++;consecutiveWins=0;maxConsecutiveLosses=Math.max(maxConsecutiveLosses,consecutiveLosses);}else{consecutiveWins=0;consecutiveLosses=0;}
    return {time:row.exitAt,cumulativePnl:round(running),equity:round(equity),drawdown:round(drawdown),drawdownPercent:round(drawdownPercent)};
  });
  const feeImpact=rows.reduce((total,row)=>total+row.fees,0),totalTrades=rows.length;
  return {currency,totalTrades,wins:wins.length,losses:losses.length,breakeven:totalTrades-wins.length-losses.length,
    winRate:totalTrades?round(wins.length/totalTrades*100):0,netProfit:round(netProfit),netProfitPercent:startingEquity>0?round(netProfit/startingEquity*100):null,
    profitFactor:grossLosses<0?round(grossWins/Math.abs(grossLosses)):null,maxDrawdown:round(maxDrawdown),maxDrawdownPercent:startingEquity>0?round(maxDrawdownPercent):null,
    expectancy:totalTrades?round(netProfit/totalTrades):0,avgWin:round(avgWin),avgLoss:round(avgLoss),avgWinLossRatio:avgLoss>0?round(avgWin/avgLoss):null,
    maxConsecutiveWins,maxConsecutiveLosses,averageHoldingMs:totalTrades?Math.round(rows.reduce((total,row)=>total+row.holdingMs,0)/totalTrades):0,
    feeImpact:round(feeImpact),startingEquity:round(startingEquity),equityCurve};
}

const isoDay=time=>new Date(time).toISOString().slice(0,10);
export function groupClosedPositions(closed,period,{startingEquity=0,currency='USDT'}={}){
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
  const groups=new Map();
  for(const row of closed){const key=keyFor(row),rows=groups.get(key)||[];rows.push(row);groups.set(key,rows);}
  return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([bucket,rows])=>{
    const {equityCurve,...metrics}=summarizeClosedPositions(rows,{startingEquity,currency});
    return {bucket,...metrics};
  });
}

export function breakdownClosedPositions(closed,{startingEquity=0,currency='USDT'}={}){
  const groups=new Map();for(const row of closed){const group=groups.get(row.symbol)||[];group.push(row);groups.set(row.symbol,group);}
  return [...groups.entries()].map(([symbol,rows])=>({symbol,...summarizeClosedPositions(rows,{startingEquity,currency}),closedTrades:rows.length})).sort((a,b)=>b.netProfit-a.netProfit);
}
