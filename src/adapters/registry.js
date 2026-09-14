import crypto from 'node:crypto';

const floorStep=(value,step)=>Math.floor((value+Number.EPSILON)/step)*step;
const jsonFetch=async(url,options={})=>{const response=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});const data=await response.json().catch(()=>({message:'Invalid response'}));if(!response.ok)throw new Error(`Broker ${response.status}: ${data.msg||data.message||'request rejected'}`);return data;};
const binanceCache=new Map();
async function binance(credentials,order,thai=false){
  const baseUrl=credentials.baseUrl||(thai?'https://api.binance.th':'https://api.binance.com');
  const prefix=thai?'/api/v1':'/api/v3';
  if(!credentials.apiKey||!credentials.apiSecret)throw new Error('Broker API credentials are incomplete');
  const cacheKey=`${baseUrl}:${order.symbol}`;let rules=binanceCache.get(cacheKey);
  if(!rules||rules.expires<Date.now()){const info=await jsonFetch(`${baseUrl}${prefix}/exchangeInfo?symbol=${encodeURIComponent(order.symbol)}`);const filters=Object.fromEntries(info.symbols[0].filters.map(x=>[x.filterType,x]));rules={filters,expires:Date.now()+3600000};binanceCache.set(cacheKey,rules);}
  const lot=rules.filters.LOT_SIZE;const quantity=lot?floorStep(order.quantity,Number(lot.stepSize)):order.quantity;
  if(!quantity||lot&&(quantity<Number(lot.minQty)||quantity>Number(lot.maxQty)))throw new Error('Quantity violates broker LOT_SIZE');
  const pf=rules.filters.PRICE_FILTER;const limitPrice=order.orderType==='LIMIT'&&pf?floorStep(order.limitPrice,Number(pf.tickSize)):order.limitPrice;
  const minNotional=Number((rules.filters.NOTIONAL||rules.filters.MIN_NOTIONAL||{}).minNotional||0);if(quantity*(limitPrice||order.price)<minNotional)throw new Error('Order is below broker minimum notional');
  const params=new URLSearchParams({symbol:order.symbol,side:order.side,type:order.orderType,quantity:String(Number(quantity.toFixed(12))),newClientOrderId:`AT${crypto.createHash('sha256').update(order.tradeId).digest('hex').slice(0,30)}`,newOrderRespType:'FULL',recvWindow:'5000',timestamp:String(Date.now())});
  if(order.orderType==='LIMIT'){params.set('price',String(Number(limitPrice.toFixed(12))));params.set('timeInForce','GTC');}
  params.set('signature',crypto.createHmac('sha256',credentials.apiSecret).update(params.toString()).digest('hex'));
  const raw=await jsonFetch(`${baseUrl}${prefix}/order?${params}`,{method:'POST',headers:{'X-MBX-APIKEY':credentials.apiKey}});
  const qty=Number(raw.executedQty||0),quote=Number(raw.cummulativeQuoteQty||0);return {status:raw.status||'SUBMITTED',orderId:raw.orderId||raw.clientOrderId,executedQty:qty,quoteQty:quote,fillPrice:qty&&quote?quote/qty:undefined,raw};
}
async function innovestx(credentials,order){
  if(!credentials.accessToken||!credentials.baseUrl)throw new Error('InnovestX baseUrl/accessToken is missing');
  const raw=await jsonFetch(`${credentials.baseUrl.replace(/\/$/,'')}/api/v1/digital-asset/order/send`,{method:'POST',headers:{authorization:`Bearer ${credentials.accessToken}`,'content-type':'application/json'},body:JSON.stringify({symbol:order.symbol,timeInForce:1,clientOrderID:Number.parseInt(crypto.createHash('sha256').update(order.tradeId).digest('hex').slice(0,12),16),side:order.side==='BUY'?0:1,quantity:order.quantity,orderType:order.orderType==='MARKET'?1:2,limitPrice:order.limitPrice})});
  return {status:raw.status||'SUBMITTED',orderId:raw.orderId||raw.orderID||raw.id,executedQty:Number(raw.executedQuantity||0),fillPrice:Number(raw.averagePrice||0)||undefined,raw};
}
async function bridge(credentials,order,broker){
  if(!credentials.bridgeUrl||!credentials.bridgeToken)throw new Error(`${broker} bridgeUrl/bridgeToken is missing`);
  const raw=await jsonFetch(`${credentials.bridgeUrl.replace(/\/$/,'')}/orders`,{method:'POST',headers:{authorization:`Bearer ${credentials.bridgeToken}`,'content-type':'application/json','idempotency-key':order.tradeId},body:JSON.stringify({...order,broker})});
  return {status:raw.status||'SUBMITTED',orderId:raw.orderId||raw.order||raw.ticket,executedQty:Number(raw.executedQty||raw.volume||0),quoteQty:Number(raw.quoteQty||0),fillPrice:Number(raw.fillPrice||raw.price||0)||undefined,raw};
}
export async function executeOrder(broker,credentials,order){
  if(broker==='binance-global')return binance(credentials,order,false);
  if(broker==='binance-th')return binance(credentials,order,true);
  if(broker==='innovestx')return innovestx(credentials,order);
  if(['mt5','settrade','future-http'].includes(broker))return bridge(credentials,order,broker);
  throw new Error('No execution adapter registered');
}
async function binanceStatus(credentials,row,thai=false){const baseUrl=credentials.baseUrl||(thai?'https://api.binance.th':'https://api.binance.com'),prefix=thai?'/api/v1':'/api/v3',params=new URLSearchParams({symbol:row.symbol,orderId:String(row.order_id),recvWindow:'5000',timestamp:String(Date.now())});params.set('signature',crypto.createHmac('sha256',credentials.apiSecret).update(params.toString()).digest('hex'));const raw=await jsonFetch(`${baseUrl}${prefix}/order?${params}`,{headers:{'X-MBX-APIKEY':credentials.apiKey}});const qty=Number(raw.executedQty||0),quote=Number(raw.cummulativeQuoteQty||0);return{status:raw.status,executedQty:qty,quoteQty:quote,fillPrice:qty&&quote?quote/qty:undefined,raw};}
export async function fetchOrderStatus(broker,credentials,row){if(broker==='binance-global')return binanceStatus(credentials,row,false);if(broker==='binance-th')return binanceStatus(credentials,row,true);if(['mt5','settrade','future-http'].includes(broker)){const raw=await jsonFetch(`${credentials.bridgeUrl.replace(/\/$/,'')}/orders/${encodeURIComponent(row.order_id)}?symbol=${encodeURIComponent(row.symbol)}`,{headers:{authorization:`Bearer ${credentials.bridgeToken}`}});return{status:raw.status||'SUBMITTED',executedQty:Number(raw.executedQty||raw.volume||0),quoteQty:Number(raw.quoteQty||0),fillPrice:Number(raw.fillPrice||raw.price||0)||undefined,raw};}return null;}
export const supportedBrokers=['binance-global','binance-th','innovestx','mt5','settrade','future-http'];
