const aliases = new Map([
  ['binance global','binance-global'],['binance','binance-global'],['binance-global','binance-global'],
  ['binance th','binance-th'],['binance-th','binance-th'],['innovestx','innovestx'],
  ['mt5','mt5'],['metatrader 5','mt5'],['settrade','settrade'],['future','future-http'],['future-http','future-http']
]);
const text=(value,name,max=100,optional=false)=>{if(optional&&(value===undefined||value===null||value===''))return '';if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${name} is required`);return value.trim();};
const positive=(value,name,optional=false)=>{if(optional&&(value===undefined||value===null||value===''))return undefined;const n=Number(value);if(!Number.isFinite(n)||n<=0)throw new Error(`${name} must be greater than 0`);return n;};
const flag=value=>{if(value===undefined)return undefined;if(typeof value!=='boolean')throw new Error('Boolean fields must be true or false');return value;};

// USD is a TradingView symbol alias, not an FX conversion. Never rewrite non-crypto brokers.
export function normalizeSymbol(value, broker) {
  const symbol=text(value,'symbol',60).toUpperCase().split(':').at(-1).replaceAll('/','');
  if(!/^[A-Z0-9._-]{1,30}$/.test(symbol))throw new Error('Invalid symbol');
  return broker==='binance-global' && symbol.length>3 && symbol.endsWith('USD') ? symbol+'T' : symbol;
}

export function normalizeSignal(body,now=Date.now()){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('JSON object required');
  if(body.account_type!==undefined&&String(body.account_type).toUpperCase()!=='SPOT')throw new Error('Only Spot accounts are supported');
  const tradeId=text(body.trade_id??body.id,'trade_id',80);
  const broker=aliases.get(text(body.broker,'broker',40).toLowerCase());
  if(!broker)throw new Error('Unsupported broker');
  const symbol=normalizeSymbol(body.symbol,broker);
  if(!symbol)throw new Error('Invalid symbol');
  const event=text(body.event??body.action??body.side,'event',20).toUpperCase();
  if(!['BUY','SELL','TP','SL'].includes(event))throw new Error('event must be BUY, SELL, TP or SL');
  const side=String(body.side||(event==='BUY'?'BUY':'SELL')).toUpperCase();
  if(!['BUY','SELL'].includes(side))throw new Error('side must be BUY or SELL');
  if(side!==(event==='BUY'?'BUY':'SELL'))throw new Error('event and side conflict');
  const orderType=String(body.order_type??body.type??'MARKET').toUpperCase();
  if(!['MARKET','LIMIT'].includes(orderType))throw new Error('order_type must be MARKET or LIMIT');
  let timestamp=Number(body.timestamp);
  if(!Number.isFinite(timestamp)&&typeof body.timestamp==='string')timestamp=Date.parse(body.timestamp);
  if(Number.isFinite(timestamp)&&timestamp>0&&timestamp<1e12)timestamp*=1000;
  if(!Number.isFinite(timestamp))throw new Error('timestamp must be Unix time or ISO datetime');
  if(timestamp>now+30000)throw new Error('timestamp is too far in the future');
  const riskMode=String(body.risk_mode||'QUANTITY').toUpperCase().replaceAll(' ','_');
  if(!['QUANTITY','FIXED_NOTIONAL','PERCENT_EQUITY'].includes(riskMode))throw new Error('Unsupported risk_mode');
  return {tradeId,broker,symbol,event,side,orderType,timestamp,timeframe:text(body.timeframe??body.interval,'timeframe',20,true),riskMode,
    riskValue:positive(body.risk_value,'risk_value',riskMode==='QUANTITY'),quantity:positive(body.quantity??body.volume,'quantity',true),quoteQuantity:positive(body.quote_quantity,'quote_quantity',true),
    referencePrice:positive(body.reference_price??body.entry??body.entry_price,'entry',true),limitPrice:positive(body.limit_price??body.price,'limit_price',orderType!=='LIMIT'),
    stopLoss:positive(body.stop_loss??body.sl,'stop_loss',true),takeProfit:positive(body.take_profit??body.tp,'take_profit',true),
    reduceOnly:flag(body.reduce_only)||['TP','SL'].includes(event),leverage:positive(body.leverage??1,'leverage'),
    volatilityPercent:body.volatility_percent===0?0:positive(body.volatility_percent,'volatility_percent',true),newsRisk:flag(body.news_risk??body.high_impact_news)
  };
}
