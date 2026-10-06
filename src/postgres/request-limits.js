import {hashToken} from '../security.js';
import {RateLimiter} from '../http-safety.js';

// Per-source budget of the UI/API pipeline: same key and numbers as before the webhook split.
export const API_LIMIT=Object.freeze({limit:240,windowMs:60000});
// Webhooks never draw from the API bucket. This per-source budget caps secret guessing and garbage;
// it is wide because TradingView sends every user's alerts from a few shared addresses.
export const WEBHOOK_SOURCE_LIMIT=Object.freeze({limit:1200,windowMs:60000});
// One bucket per webhook route and token, so one bot's burst never starves another bot's signals.
export const WEBHOOK_IDENTITY_LIMIT=Object.freeze({limit:120,windowMs:60000});

const families=[
  ['/webhooks/tradingview/','tradingview'],
  ['/webhooks/pine-bridge/v1/','pine-bridge-v1'],
  ['/webhooks/pine-bridge/v2/','pine-bridge-v2'],
  ['/webhooks/pine-capture/v1/','pine-capture-v1']
];

// The router's parse. Every pipeline decision uses this pathname, never the raw target:
// //host/api/x, absolute-form, /./webhooks/x and /webhooks/../api/x route by their canonical path.
export function requestPathname(target) {
  try{return new URL(String(target),'http://localhost').pathname;}catch{return null;}
}

export function webhookIdentity(pathname) {
  if(typeof pathname!=='string'||!pathname.startsWith('/webhooks/'))return null;
  const [prefix,family]=families.find(([start])=>pathname.startsWith(start))||['/webhooks/','other'];
  let token=pathname.slice(prefix.length);
  try{token=decodeURIComponent(token);}catch{}
  // Domain-separated and truncated: the key holds neither the token nor its stored credential hash.
  return {family,key:family+':'+hashToken('webhook-bucket:'+family+':'+token).slice(0,32)};
}

// limit(key,limit,windowMs) is the shared database limiter. Identity buckets stay in memory per
// replica on purpose: a random-token flood must not add one security_limits row per guess, because
// that table is capped and a full table answers 429 to every new API client.
export function createRequestLimits({limit,sourceKey,identities=new RateLimiter({...WEBHOOK_IDENTITY_LIMIT,evictOldest:true})}) {
  return async(req,pathname=requestPathname(req.url))=>{
    const webhook=webhookIdentity(pathname),source=sourceKey(req);
    if(!webhook)return await limit('request:'+source,API_LIMIT.limit,API_LIMIT.windowMs);
    if(!await limit('webhook-source:'+source,WEBHOOK_SOURCE_LIMIT.limit,WEBHOOK_SOURCE_LIMIT.windowMs))return false;
    return identities.accept(webhook.key);
  };
}