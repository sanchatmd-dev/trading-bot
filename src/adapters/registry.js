import crypto from 'node:crypto';

export const supportedBrokers=['binance-global','binance-th','innovestx','mt5','settrade','future-http'];
export const capabilities=Object.fromEntries(supportedBrokers.map(broker=>[broker,{
  paper:['binance-global','binance-th','innovestx','settrade'].includes(broker),
  live:false,
  reason:'Live locked: native protection, authoritative balances, fee ledger and broker contract tests pending'
}]));

export function assertLiveEnabled(broker) {
  throw new Error(`Live execution is disabled for ${broker}; this release is Paper staging only`);
}

export function validateCredentials(broker,value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Credential object required');
  // No tenant-controlled endpoints or redirects; legacy credentials cannot override this either.
  const fields=broker.startsWith('binance-')?['apiKey','apiSecret']:
    broker==='innovestx'?['accessToken']:['bridgeToken'];
  for(const key of Object.keys(value))if(!fields.includes(key))throw new Error(`Credential field not allowed: ${key}`);
  for(const key of fields)if(typeof value[key]!=='string'||!value[key]||value[key].length>4096)
    throw new Error(`Invalid credential field: ${key}`);
  return value;
}

export async function executeOrder(broker) { assertLiveEnabled(broker); }

// Read-only recovery lookup. A timeout/not-found is UNKNOWN, never permission to resend.
export async function fetchOrderStatus(broker,credentials,row) {
  if(broker!=='binance-global')throw new Error('Broker recovery requires manual review');
  if(credentials.baseUrl||credentials.bridgeUrl)throw new Error('Legacy custom endpoint rejected; re-save credentials');
  validateCredentials(broker,credentials);
  if(!row.order_id&&!row.client_order_id)throw new Error('No broker or client order id');
  const params=new URLSearchParams({symbol:row.symbol,recvWindow:'5000',timestamp:String(Date.now())});
  params.set(row.order_id?'orderId':'origClientOrderId',String(row.order_id||row.client_order_id));
  params.set('signature',crypto.createHmac('sha256',credentials.apiSecret).update(params.toString()).digest('hex'));
  const response=await fetch(`https://api.binance.com/api/v3/order?${params}`,{
    headers:{'X-MBX-APIKEY':credentials.apiKey},redirect:'error',signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)throw new Error(`Broker recovery HTTP ${response.status}; outcome unresolved`);
  const raw=await response.json();
  return {status:raw.status,orderId:raw.orderId,executedQty:Number(raw.executedQty),
    quoteQty:Number(raw.cummulativeQuoteQty),feesVerified:false,raw};
}
