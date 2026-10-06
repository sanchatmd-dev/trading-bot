import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {RateLimiter,clientIp} from '../src/http-safety.js';
import {hashToken} from '../src/security.js';
import {createRequestLimits,requestPathname,webhookIdentity as identityOf,API_LIMIT,WEBHOOK_SOURCE_LIMIT,WEBHOOK_IDENTITY_LIMIT} from '../src/postgres/request-limits.js';
// The dispatcher parses once and hands the canonical pathname over; tests follow the same path.
const webhookIdentity=target=>identityOf(requestPathname(target));

const secretA='a'.repeat(64),secretB='b'.repeat(64);
// Same counting rule as security_limits consumeLimit: one row per key, allowed while attempts<=limit.
function sharedStore(){
  const rows=new Map(),calls=[];
  const limit=async(key,max,windowMs)=>{calls.push({key,max,windowMs});const n=(rows.get(key)||0)+1;rows.set(key,n);return n<=max;};
  return {rows,calls,limit};
}
// Proxy collapse: TRUST_LOOPBACK_PROXY off behind nginx, so every client keys to the proxy address.
const collapsed=req=>clientIp(req,false);
const request=(url,headers={})=>({url,method:url.startsWith('/webhooks/')?'POST':'GET',headers,socket:{remoteAddress:'127.0.0.1'}});
const ui=()=>request('/api/me');
const tradingview=secret=>request('/webhooks/tradingview/'+secret);

test('webhook identity follows the router pathname and never holds the token',()=>{
  for(const [path,family] of [['/webhooks/tradingview/','tradingview'],['/webhooks/pine-bridge/v1/','pine-bridge-v1'],['/webhooks/pine-bridge/v2/','pine-bridge-v2'],['/webhooks/pine-capture/v1/','pine-capture-v1'],['/webhooks/unknown/','other']]){
    const identity=webhookIdentity(path+secretA);
    assert.equal(identity.family,family,path);
    assert.match(identity.key,new RegExp('^'+family+':[0-9a-f]{32}$'));
    assert.ok(!identity.key.includes(secretA)&&!identity.key.includes(hashToken(secretA))&&!identity.key.includes(hashToken(secretA).slice(0,32)),path);
  }
  assert.equal(webhookIdentity('/webhooks/tradingview/'+secretA+'?x=1').key,webhookIdentity('/webhooks/tradingview/'+secretA).key,'query string is not part of the identity');
  assert.equal(webhookIdentity('/webhooks/tradingview/%61'+'a'.repeat(63)).key,webhookIdentity('/webhooks/tradingview/'+secretA).key,'percent-encoding resolves like the handler');
  assert.notEqual(webhookIdentity('/webhooks/tradingview/'+secretA).key,webhookIdentity('/webhooks/tradingview/'+secretB).key);
  assert.notEqual(webhookIdentity('/webhooks/tradingview/'+secretA).key,webhookIdentity('/webhooks/pine-bridge/v2/'+secretA).key,'routes keep separate buckets');
  // A raw /webhooks/ prefix that resolves to /api/ is API traffic, so it cannot escape the API bucket.
  assert.equal(webhookIdentity('/webhooks/../api/bots'),null);
  assert.equal(webhookIdentity('/webhooks/%2e%2e/api/bots'),null);
  assert.equal(webhookIdentity('/api/../webhooks/tradingview/'+secretA).family,'tradingview');
  assert.equal(webhookIdentity('/api/me'),null);
  assert.equal(webhookIdentity('//['),null,'an unparsable target is never a webhook');
  assert.equal(requestPathname('//evil/webhooks/tradingview/'+secretA),'/webhooks/tradingview/'+secretA);
  assert.equal(requestPathname('http://localhost/api/bots'),'/api/bots');
  assert.equal(requestPathname('//'),null);
  assert.equal(webhookIdentity('/webhooks/tradingview/%zz').family,'tradingview','undecodable token still gets a bucket');
});

test('API keeps its exact bucket; webhooks never touch it',async()=>{
  const store=sharedStore(),accept=createRequestLimits({limit:store.limit,sourceKey:collapsed});
  assert.equal(await accept(ui()),true);
  assert.deepEqual(store.calls,[{key:'request:127.0.0.1',max:240,windowMs:60000}]);
  assert.deepEqual(API_LIMIT,{limit:240,windowMs:60000});
  store.calls.length=0;
  assert.equal(await accept(tradingview(secretA)),true);
  assert.deepEqual(store.calls,[{key:'webhook-source:127.0.0.1',max:WEBHOOK_SOURCE_LIMIT.limit,windowMs:WEBHOOK_SOURCE_LIMIT.windowMs}]);
  assert.ok(!store.calls.some(call=>call.key.startsWith('request:')));
});

test('a UI burst that exhausts the API bucket does not block webhook delivery',async()=>{
  const store=sharedStore(),accept=createRequestLimits({limit:store.limit,sourceKey:collapsed});
  for(let i=0;i<API_LIMIT.limit;i++)assert.equal(await accept(ui()),true);
  assert.equal(await accept(ui()),false,'UI protection unchanged: request 241 is limited');
  assert.equal(await accept(tradingview(secretA)),true);
  assert.equal(await accept(request('/webhooks/pine-bridge/v2/'+secretB)),true);
  assert.equal(await accept(ui()),false);
});

test('a webhook burst does not block the UI, and one token cannot starve another',async()=>{
  const store=sharedStore(),accept=createRequestLimits({limit:store.limit,sourceKey:collapsed});
  for(let i=0;i<WEBHOOK_IDENTITY_LIMIT.limit;i++)assert.equal(await accept(tradingview(secretA)),true);
  assert.equal(await accept(tradingview(secretA)),false,'the bursting token is limited');
  assert.equal(await accept(tradingview(secretB)),true,'another bot still delivers');
  assert.equal(await accept(request('/webhooks/pine-bridge/v2/'+secretA)),true,'another route of the same bot still delivers');
  assert.equal(await accept(ui()),true,'UI is unaffected');
  assert.equal(store.rows.get('request:127.0.0.1'),1);
});

test('source budget still stops secret guessing: once spent, even a valid token gets 429',async()=>{
  const store=sharedStore(),accept=createRequestLimits({limit:store.limit,sourceKey:collapsed});
  for(let i=0;i<WEBHOOK_SOURCE_LIMIT.limit;i++)await accept(tradingview(i.toString(16).padStart(64,'0')));
  assert.equal(await accept(tradingview(secretA)),false,'no oracle once the source budget is spent');
  assert.equal(await accept(ui()),true,'guessing on webhooks does not spend the UI budget');
  // The guesses added one database row, not one per token.
  assert.deepEqual([...store.rows.keys()].sort(),['request:127.0.0.1','webhook-source:127.0.0.1']);
});

test('sources stay separate when the proxy hop is trusted',async()=>{
  const store=sharedStore(),accept=createRequestLimits({limit:store.limit,sourceKey:req=>clientIp(req,true)});
  const from=(url,ip)=>request(url,{'x-forwarded-for':ip});
  for(let i=0;i<API_LIMIT.limit;i++)await accept(from('/api/me','198.51.100.7'));
  assert.equal(await accept(from('/api/me','198.51.100.7')),false);
  assert.equal(await accept(from('/api/me','198.51.100.8')),true);
  assert.equal(await accept(from('/webhooks/tradingview/'+secretA,'52.89.214.238')),true);
  assert.ok(store.rows.has('webhook-source:52.89.214.238'));
});

test('no bucket key or limiter call carries a secret',async()=>{
  const store=sharedStore(),identities=new RateLimiter({...WEBHOOK_IDENTITY_LIMIT,evictOldest:true});
  const accept=createRequestLimits({limit:store.limit,sourceKey:collapsed,identities});
  for(const url of ['/webhooks/tradingview/'+secretA,'/webhooks/pine-bridge/v1/'+secretA,'/webhooks/pine-bridge/v2/'+secretB,'/webhooks/pine-capture/v1/'+secretB,'/webhooks/tradingview/'+secretA+'?token='+secretB])await accept(request(url));
  const keys=[...store.calls.map(call=>call.key),...identities.entries.keys()];
  assert.ok(keys.length>=5);
  for(const key of keys)for(const secret of [secretA,secretB])assert.ok(!key.includes(secret)&&!key.includes(hashToken(secret)),key);
});

test('identity buckets evict the oldest key instead of locking out a new bot',()=>{
  const limiter=new RateLimiter({limit:1,maxKeys:2,windowMs:100,evictOldest:true});
  assert.equal(limiter.accept('a',0),true);assert.equal(limiter.accept('b',1),true);
  assert.equal(limiter.accept('c',2),true,'a full table still admits a new key');
  assert.deepEqual([...limiter.entries.keys()],['b','c']);
  assert.equal(limiter.accept('b',3),false,'surviving buckets keep their count');
  const strict=new RateLimiter({limit:1,maxKeys:1,windowMs:100});
  assert.equal(strict.accept('a',0),true);assert.equal(strict.accept('b',1),false,'default stays fail-closed');
});

test('the limiter sweep stops at the first live entry and never counts into an expired one',()=>{
  const limiter=new RateLimiter({limit:2,maxKeys:20000,windowMs:100,evictOldest:true});
  for(let i=0;i<10000;i++)limiter.accept('live-'+i,50);
  let visited=0;const entries=limiter.entries;
  limiter.entries=new Proxy(entries,{get(target,name){
    if(name===Symbol.iterator)return function*(){for(const pair of target){visited++;yield pair;}};
    const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
  }});
  assert.equal(limiter.accept('fresh',60),true);
  assert.equal(visited,1,'one look at the oldest live entry, not a walk over 10000 keys');
  limiter.entries=entries;
  // Expired heads are swept in order; live entries stay.
  const ordered=new RateLimiter({limit:1,windowMs:10});
  ordered.accept('a',0);ordered.accept('b',5);ordered.accept('c',12);
  assert.deepEqual([...ordered.entries.keys()],['b','c'],'a expired at 10 and was swept');
  assert.equal(ordered.accept('d',16),true);
  assert.deepEqual([...ordered.entries.keys()],['c','d'],'b expired at 15 and was swept');
  // Expired entry re-created later goes to the end, so order stays by expiry.
  assert.equal(ordered.accept('c',22),true);
  assert.deepEqual([...ordered.entries.keys()],['d','c']);
  // A clock step back may leave an expired entry behind a live one: it is never counted into.
  const stepped=new RateLimiter({limit:1,windowMs:10});
  stepped.accept('late',100);stepped.accept('early',50);
  assert.deepEqual([...stepped.entries.keys()],['late','early']);
  assert.equal(stepped.accept('early',70),true,'expired window starts fresh even behind a live head');
  assert.equal(stepped.accept('early',71),false);
});

test('server.js wires the extracted dispatcher and keeps no raw-target routing decision',()=>{
  const server=fs.readFileSync(new URL('../src/postgres/server.js',import.meta.url),'utf8');
  const dispatch=fs.readFileSync(new URL('../src/postgres/request-dispatch.js',import.meta.url),'utf8');
  assert.ok(!server.includes("auth.limit('request:'"),'no direct shared request bucket remains');
  for(const source of [server,dispatch])assert.ok(!/req\.url\.startsWith\(/.test(source),'no decision on the raw target');
  assert.match(server,/createRequestLimits\(\{limit: auth\.limit\.bind\(auth\), sourceKey: loginKey\}\)/);
  assert.match(server,/http\.createServer\(createDispatcher\(\{newsWindowsPort,requestLimits,auth,database,store,preloadJson,handleRequest,runMarketDeferred\}\)\)/);
});