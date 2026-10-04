import {fail} from '../pine-bridge/source.js';
import {D,exact} from '../money.js';

/**
 * Bounded, keyless proxy for PUBLIC Binance Spot market data (klines and the symbol list). View-only chart data.
 *
 * Safety contract: the origin is fixed (or the loopback test origin under NODE_ENV=test), the two paths are constants, and
 * nothing from a request ever reaches the host, the path or the protocol. No API key, signature, cookie or credential is sent.
 * No upstream URL, header or body text is ever returned or logged. All state is per process and in memory; this module has no
 * database, no store and no write path. Every upstream call is bounded by a timeout, a byte cap, a concurrency cap, a weight
 * budget and a circuit breaker; Retry-After is honoured.
 */
export const UPSTREAM_ORIGIN='https://api.binance.com';
export const KLINES_PATH='/api/v3/klines';
export const EXCHANGE_INFO_PATH='/api/v3/exchangeInfo';
export const EXCHANGE_INFO_QUERY='permissions=SPOT&showPermissionSets=false&symbolStatus=TRADING';
export const EXCHANGE_INFO_FALLBACK_QUERY='permissions=SPOT';
export const SYMBOL_RE=/^[A-Z0-9]{5,20}$/;
export const ALWAYS_ALLOWED_SYMBOL='BTCUSDT';
const ASSET_RE=/^[A-Z0-9]{1,15}$/;
const TEST_ORIGIN_RE=/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/;
const DECIMAL_RE=/^\d+(\.\d+)?$/;
const SECOND=1000,MINUTE=60*SECOND,HOUR=60*MINUTE,DAY=24*HOUR,MIB=1024*1024;

// First values, accepted by the owner for later tuning after staging observation. Durations are milliseconds unless the key
// says Seconds.
export const LIMITS=Object.freeze({
  klinesTimeoutMs:4*SECOND,klinesMaxBytes:MIB,
  exchangeInfoTimeoutMs:8*SECOND,exchangeInfoMaxBytes:16*MIB,
  symbolsTtlMs:6*HOUR,symbolsKeepMs:24*HOUR,symbolsRetryMinMs:MINUTE,symbolsRetryMaxMs:10*MINUTE,minSymbols:50,
  staleMinSeconds:300,staleMaxSeconds:3600,staleTtlFactor:10,
  cacheEntries:128,cacheBytes:16*MIB,
  concurrency:4,
  weightPerMinute:600,weightKlines:2,weightExchangeInfo:20,usedWeightGuard:3000,
  userRequestsPerMinute:60,userMissesPerMinute:20,userKeys:10000,
  circuit429MinSeconds:60,circuit429MaxSeconds:3600,circuit418MinSeconds:600,circuit418MaxSeconds:72*3600,
  failureThreshold:3,failureOpenMinSeconds:30,failureOpenMaxSeconds:300,
  klinesMaxLimit:1000});

// ms = nominal bar length; ttl = klines cache TTL in seconds. The interval sent upstream comes only from these keys.
const interval=(ms,ttl)=>Object.freeze({ms,ttl});
export const KLINE_INTERVALS=Object.freeze({
  '1m':interval(MINUTE,10),'3m':interval(3*MINUTE,15),'5m':interval(5*MINUTE,15),'15m':interval(15*MINUTE,30),
  '30m':interval(30*MINUTE,30),'1h':interval(HOUR,60),'2h':interval(2*HOUR,60),'4h':interval(4*HOUR,120),
  '6h':interval(6*HOUR,120),'8h':interval(8*HOUR,120),'12h':interval(12*HOUR,180),
  '1d':interval(DAY,300),'3d':interval(3*DAY,600),'1w':interval(7*DAY,600)});
// 3d and 1w bars are calendar anchored upstream, so only intervals up to this length are checked against epoch alignment.
const ALIGNED_MAX_MS=DAY;

/**
 * MARKET_PUBLIC_PROXY=0 is the kill switch; unset or any other value enables the proxy. MARKET_PROXY_TEST_ORIGIN is a test-only
 * loopback origin: set in any other case it throws at startup. A process with NODE_ENV=test and no test origin never reaches the
 * public host, so the proxy stays off there.
 */
export function parseProxyConfig(env={}){
  const test=env.MARKET_PROXY_TEST_ORIGIN;
  const hasTest=test!==undefined&&test!=='';
  if(hasTest&&(env.NODE_ENV!=='test'||typeof test!=='string'||!TEST_ORIGIN_RE.test(test)))
    throw new Error('MARKET_PROXY_TEST_ORIGIN is allowed only with NODE_ENV=test and a http://127.0.0.1:PORT origin');
  if(env.MARKET_PUBLIC_PROXY==='0')return {enabled:false,origin:UPSTREAM_ORIGIN};
  if(hasTest)return {enabled:true,origin:test};
  if(env.NODE_ENV==='test')return {enabled:false,origin:UPSTREAM_ORIGIN};
  return {enabled:true,origin:UPSTREAM_ORIGIN};
}

const invalid=()=>fail('MARKET_UPSTREAM_INVALID',503);
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function tickOf(symbol){
  const filter=Array.isArray(symbol.filters)?symbol.filters.find(item=>isObject(item)&&item.filterType==='PRICE_FILTER'):null;
  if(!filter||typeof filter.tickSize!=='string'||!DECIMAL_RE.test(filter.tickSize))return null;
  try{const tick=exact(filter.tickSize);return D(tick).gt(0)?tick:null;}catch{return null;}
}

function spotAllowed(symbol){
  if(symbol.isSpotTradingAllowed!==undefined)return symbol.isSpotTradingAllowed===true;
  return Array.isArray(symbol.permissions)&&symbol.permissions.includes('SPOT');
}

/** Allow-list from an exchangeInfo payload: TRADING Spot symbols with plain ASCII names only. Throws MARKET_UPSTREAM_INVALID. */
export function parseExchangeInfo(json){
  if(!isObject(json)||!Array.isArray(json.symbols))throw invalid();
  const list=[];
  for(const symbol of json.symbols){
    if(!isObject(symbol)||symbol.status!=='TRADING'||!spotAllowed(symbol))continue;
    const {symbol:name,baseAsset:base,quoteAsset:quote}=symbol;
    if(typeof name!=='string'||typeof base!=='string'||typeof quote!=='string')continue;
    if(!SYMBOL_RE.test(name)||!ASSET_RE.test(base)||!ASSET_RE.test(quote)||name!==base+quote)continue;
    list.push([name,base,quote,tickOf(symbol)]);
  }
  list.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const unique=list.filter((item,index)=>index===0||list[index-1][0]!==item[0]);
  if(unique.length<LIMITS.minSymbols)throw invalid();
  return {list:unique,set:new Set(unique.map(item=>item[0]))};
}

const decimalText=value=>{if(typeof value!=='string'||!DECIMAL_RE.test(value))throw invalid();return value;};

/** Validate and normalize a klines payload. The whole payload is rejected on any defect (MARKET_UPSTREAM_INVALID). */
export function parseKlines(json,{intervalMs,limit,now}){
  if(!Array.isArray(json)||json.length>limit)throw invalid();
  const calendar=intervalMs>ALIGNED_MAX_MS;
  const bars=[];
  let previous=-Infinity;
  for(const k of json){
    if(!Array.isArray(k)||k.length<7)throw invalid();
    const open=k[0],close=k[6];
    if(!Number.isSafeInteger(open)||!Number.isSafeInteger(close)||open<=previous)throw invalid();
    if(calendar){if(close<=open)throw invalid();}
    else if(open%intervalMs!==0||close-open+1!==intervalMs)throw invalid();
    previous=open;
    let text;
    try{
      const [o,h,l,c,v]=[k[1],k[2],k[3],k[4],k[5]].map(value=>D(decimalText(value)));
      if(l.lte(0)||h.lt(o)||h.lt(c)||l.gt(o)||l.gt(c)||v.lt(0))throw invalid();
      text=[o,h,l,c,v].map(value=>exact(value.toFixed()));
    }catch(error){throw error?.code==='MARKET_UPSTREAM_INVALID'?error:invalid();}
    const forming=close>=now;
    bars.push({time:open,open:text[0],high:text[1],low:text[2],close:text[3],volume:text[4],complete:!forming,forming,minutes:null});
  }
  return bars;
}

const withRetry=(error,seconds)=>Object.assign(error,{retry_after_seconds:Math.max(1,Math.ceil(seconds))});
const parseSeconds=text=>typeof text==='string'&&/^\d{1,9}$/.test(text.trim())?Number(text.trim()):null;

/**
 * One bounded GET. Returns {status,ok,retryAfter,usedWeight,json}; json only for a 2xx answer. Never exposes the URL, headers or
 * body in an error. A deadline races the response and every read; the reader is cancelled in finally.
 */
async function boundedGet(fetcher,url,{timeoutMs,maxBytes}){
  const controller=new AbortController();
  let timer;
  const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('MARKET_UPSTREAM_TIMEOUT',503));},timeoutMs);});
  deadline.catch(()=>{});
  const bounded=work=>Promise.race([work,deadline]);
  let reader=null,response=null;
  try{
    try{response=await bounded(Promise.resolve().then(()=>fetcher(url,{method:'GET',signal:controller.signal,redirect:'error',headers:{accept:'application/json'}})));}
    catch(error){throw error?.code==='MARKET_UPSTREAM_TIMEOUT'?error:fail('MARKET_UPSTREAM_UNAVAILABLE',503);}
    const header=name=>{try{return response.headers?.get?.(name)??null;}catch{return null;}};
    const meta={status:Number(response.status),ok:response.ok===true,retryAfter:parseSeconds(header('retry-after')),
      usedWeight:parseSeconds(header('x-mbx-used-weight-1m'))};
    if(!meta.ok){try{response.body?.cancel?.().catch?.(()=>{});}catch{}return {...meta,json:null};}
    const length=header('content-length');
    if(length!==null&&Number(length)>maxBytes)throw fail('MARKET_UPSTREAM_TOO_LARGE',503);
    reader=response.body?.getReader?.();
    if(!reader)throw invalid();
    const chunks=[];let size=0;
    for(;;){
      const part=await bounded(reader.read());
      if(part.done)break;
      size+=part.value.length;
      if(size>maxBytes)throw fail('MARKET_UPSTREAM_TOO_LARGE',503);
      chunks.push(part.value);
    }
    let json;
    try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw invalid();}
    return {...meta,json};
  }finally{
    clearTimeout(timer);
    if(reader)reader.cancel().catch(()=>{});
  }
}

const nextUtcMinute=now=>Math.floor(now/MINUTE)*MINUTE+MINUTE;

export class PublicMarketProxy{
  #enabled;#origin;#fetcher;#clock;#limits;#log;
  #cache=new Map();#cacheBytes=0;#pending=new Map();
  #symbols=null;#removed=new Set();#symbolsPending=null;#symbolsFailure={delayMs:0,nextAt:0};
  #circuit={openUntil:0,failures:0,delaySeconds:0};
  #weightBlockedUntil=0;#tokens;#tokensAt;#active=0;
  #users=new Map();

  constructor({enabled=false,origin=UPSTREAM_ORIGIN,fetcher,clock=Date.now,limits=LIMITS,log=console.warn}={}){
    if(origin!==UPSTREAM_ORIGIN&&!TEST_ORIGIN_RE.test(origin))throw new Error('Invalid market proxy origin');
    this.#enabled=enabled===true;this.#origin=origin;
    // Resolved at call time, so a test-scoped replacement of globalThis.fetch is honoured and never captured at construction.
    this.#fetcher=fetcher??((...args)=>globalThis.fetch(...args));
    this.#clock=clock;this.#limits=limits;this.#log=log;
    this.#tokens=limits.weightPerMinute;this.#tokensAt=clock();
  }

  get enabled(){return this.#enabled;}
  now(){return this.#clock();}

  // ---- per-user counters ----

  #userRecord(actorId,now){
    let record=this.#users.get(actorId);
    if(!record){
      if(this.#users.size>=this.#limits.userKeys){
        for(const [key,item] of this.#users)if(now-item.requestStart>=MINUTE&&now-item.missStart>=MINUTE)this.#users.delete(key);
        if(this.#users.size>=this.#limits.userKeys)return null;
      }
      record={requestStart:now,requests:0,missStart:now,misses:0};
      this.#users.set(actorId,record);
    }
    return record;
  }

  /** Counts one market request of an actor. Synchronous. The window is a fixed minute that starts at the first request. */
  admit(actorId){
    const now=this.#clock(),limit=this.#limits.userRequestsPerMinute;
    const record=typeof actorId==='string'&&actorId!==''?this.#userRecord(actorId,now):null;
    if(!record)return {ok:false,code:'MARKET_RATE_LIMITED',retry_after_seconds:60};
    if(now-record.requestStart>=MINUTE){record.requestStart=now;record.requests=0;}
    if(record.requests>=limit)return {ok:false,code:'MARKET_RATE_LIMITED',retry_after_seconds:Math.max(1,Math.ceil((record.requestStart+MINUTE-now)/SECOND))};
    record.requests++;
    return {ok:true};
  }

  // Returns 0 when the miss is allowed (and counts it), else the seconds until the window resets.
  #takeMiss(actorId,now){
    const record=typeof actorId==='string'&&actorId!==''?this.#userRecord(actorId,now):null;
    if(!record)return 60;
    if(now-record.missStart>=MINUTE){record.missStart=now;record.misses=0;}
    if(record.misses>=this.#limits.userMissesPerMinute)return Math.max(1,Math.ceil((record.missStart+MINUTE-now)/SECOND));
    record.misses++;
    return 0;
  }

  // ---- budget and circuit ----

  // Token bucket with continuous refill. Returns 0 when the weight was taken, else the seconds to wait.
  #takeWeight(weight,now){
    const rate=this.#limits.weightPerMinute/MINUTE;
    this.#tokens=Math.min(this.#limits.weightPerMinute,this.#tokens+Math.max(0,now-this.#tokensAt)*rate);
    this.#tokensAt=now;
    if(this.#tokens<weight)return Math.max(1,Math.ceil((weight-this.#tokens)/rate/SECOND));
    this.#tokens-=weight;
    return 0;
  }

  #open(seconds,reason,now){
    const wasOpen=this.#circuit.openUntil>now;
    this.#circuit.openUntil=Math.max(this.#circuit.openUntil,now+seconds*SECOND);
    if(!wasOpen)this.#log(`market proxy circuit open: ${reason} ${Math.round(seconds)}s`);
  }

  // The time until which no upstream call may start, or 0.
  #cooldown(now){
    const until=Math.max(this.#circuit.openUntil,this.#weightBlockedUntil);
    return until>now?until:0;
  }

  #recordSuccess(){
    if(this.#circuit.openUntil>0)this.#log('market proxy circuit closed');
    this.#circuit={openUntil:0,failures:0,delaySeconds:0};
  }

  // Consecutive 5xx, timeout and network failures: the third opens the circuit 30 s, then doubling up to 300 s.
  #recordFailure(now){
    const limits=this.#limits,circuit=this.#circuit;
    circuit.failures++;
    if(circuit.failures>=limits.failureThreshold){
      circuit.delaySeconds=circuit.delaySeconds===0?limits.failureOpenMinSeconds:Math.min(limits.failureOpenMaxSeconds,circuit.delaySeconds*2);
      this.#open(circuit.delaySeconds,'UPSTREAM_FAILURES',now);
    }
  }

  // One HTTP exchange with all accounting. Throws fail(code,status) with retry_after_seconds where it applies.
  async #exchange(url,{weight,timeoutMs,maxBytes,deadline}){
    const now=this.#clock();
    const cooling=this.#cooldown(now);
    if(cooling)throw withRetry(fail('MARKET_UPSTREAM_COOLDOWN',503),(cooling-now)/SECOND);
    if(this.#active>=this.#limits.concurrency)throw withRetry(fail('MARKET_PROXY_BUSY',503),1);
    const remaining=deadline===undefined?Infinity:deadline-now;
    if(remaining<=0)throw fail('MARKET_UPSTREAM_TIMEOUT',503);
    const wait=this.#takeWeight(weight,now);
    if(wait)throw withRetry(fail('MARKET_PROXY_BUSY',503),wait);
    this.#active++;
    let result;
    try{
      result=await boundedGet(this.#fetcher,url,{timeoutMs:Math.min(timeoutMs,remaining),maxBytes});
    }catch(error){
      if(error?.code==='MARKET_UPSTREAM_TIMEOUT'||error?.code==='MARKET_UPSTREAM_UNAVAILABLE')this.#recordFailure(this.#clock());
      throw error;
    }finally{this.#active--;}
    const after=this.#clock();
    if(result.usedWeight!==null&&result.usedWeight>=this.#limits.usedWeightGuard){
      this.#weightBlockedUntil=nextUtcMinute(after);
      this.#log(`market proxy used-weight guard: ${Math.ceil((this.#weightBlockedUntil-after)/SECOND)}s`);
    }
    // 403 (WAF block) and 451 (restricted location) are blocking signals like 429: stop sending, using the 429 floor and cap.
    if(result.status===429||result.status===418||result.status===403||result.status===451){
      const teapot=result.status===418,limits=this.#limits;
      const floor=teapot?limits.circuit418MinSeconds:limits.circuit429MinSeconds,cap=teapot?limits.circuit418MaxSeconds:limits.circuit429MaxSeconds;
      const seconds=Math.min(cap,Math.max(floor,result.retryAfter??0));
      this.#open(seconds,'HTTP_'+result.status,after);
      throw withRetry(fail('MARKET_UPSTREAM_COOLDOWN',503),seconds);
    }
    if(result.status===400)throw fail('MARKET_UPSTREAM_REJECTED',400);
    if(!result.ok){
      if(result.status>=500)this.#recordFailure(after);
      throw fail('MARKET_UPSTREAM_UNAVAILABLE',503);
    }
    this.#recordSuccess();
    return result;
  }

  // ---- symbol allow-list ----

  /** Price tick of a listed symbol from the loaded list, else null. Synchronous; axis decimals only. */
  tick(symbol){return this.#symbols?.ticks.get(symbol)??null;}

  #symbolsView(stale){
    const snapshot=this.#symbols;
    return {list:snapshot.list,set:snapshot.set,retrieved_at:snapshot.retrievedAt,stale};
  }

  async #refreshSymbols(deadline){
    const base=this.#origin+EXCHANGE_INFO_PATH+'?';
    const options={weight:this.#limits.weightExchangeInfo,timeoutMs:this.#limits.exchangeInfoTimeoutMs,maxBytes:this.#limits.exchangeInfoMaxBytes,deadline};
    let result;
    try{result=await this.#exchange(base+EXCHANGE_INFO_QUERY,options);}
    catch(error){
      if(error?.code!=='MARKET_UPSTREAM_REJECTED')throw error;
      result=await this.#exchange(base+EXCHANGE_INFO_FALLBACK_QUERY,options);
    }
    const parsed=parseExchangeInfo(result.json);
    const ticks=new Map(parsed.list.map(item=>[item[0],item[3]]));
    this.#symbols={list:parsed.list,set:parsed.set,ticks,retrievedAt:this.#clock()};
    this.#removed.clear();
    this.#symbolsFailure={delayMs:0,nextAt:0};
  }

  /**
   * The allow-list snapshot {list,set,retrieved_at,stale}. Refreshes after the TTL; serves the last good list (stale:true) for up
   * to 24 h while refresh fails. Throws MARKET_PROXY_DISABLED, MARKET_UPSTREAM_COOLDOWN or MARKET_SYMBOLS_UNAVAILABLE (503).
   */
  async symbols({deadline}={}){
    this.#assertEnabled();
    const now=this.#clock(),limits=this.#limits;
    const current=this.#symbols&&now-this.#symbols.retrievedAt<=limits.symbolsKeepMs?this.#symbols:null;
    if(current&&now-current.retrievedAt<limits.symbolsTtlMs)return this.#symbolsView(false);
    const lastGood=()=>current?this.#symbolsView(true):null;
    if(this.#symbolsPending){
      try{await this.#symbolsPending;}
      catch(error){
        const copy=lastGood();
        if(copy)return copy;
        if(error?.code==='MARKET_UPSTREAM_COOLDOWN')throw error;
        throw fail('MARKET_SYMBOLS_UNAVAILABLE',503);
      }
      return this.#symbolsView(false);
    }
    if(this.#symbolsFailure.nextAt>now){
      const copy=lastGood();
      if(copy)return copy;
      const cooling=this.#cooldown(now);
      if(cooling)throw withRetry(fail('MARKET_UPSTREAM_COOLDOWN',503),(cooling-now)/SECOND);
      throw fail('MARKET_SYMBOLS_UNAVAILABLE',503);
    }
    this.#symbolsPending=this.#refreshSymbols(deadline).finally(()=>{this.#symbolsPending=null;});
    try{await this.#symbolsPending;}
    catch(error){
      const failure=this.#symbolsFailure;
      failure.delayMs=failure.delayMs===0?limits.symbolsRetryMinMs:Math.min(limits.symbolsRetryMaxMs,failure.delayMs*2);
      failure.nextAt=this.#clock()+failure.delayMs;
      const copy=lastGood();
      if(copy)return copy;
      if(error?.code==='MARKET_UPSTREAM_COOLDOWN')throw error;
      throw fail('MARKET_SYMBOLS_UNAVAILABLE',503);
    }
    return this.#symbolsView(false);
  }

  async #allowed(symbol,deadline){
    if(symbol===ALWAYS_ALLOWED_SYMBOL)return true;
    const snapshot=await this.symbols({deadline});
    return snapshot.set.has(symbol)&&!this.#removed.has(symbol);
  }

  // ---- klines ----

  #staleSeconds(ttl){return Math.min(this.#limits.staleMaxSeconds,Math.max(this.#limits.staleMinSeconds,this.#limits.staleTtlFactor*ttl));}

  #result(entry,now,stale){
    return {bars:entry.bars,fetched_at:entry.at,cache_age_seconds:Math.max(0,Math.floor((now-entry.at)/SECOND)),stale};
  }

  // Least recently used eviction by entry count and by serialized size; the entry just stored is never evicted.
  #store(key,entry){
    const old=this.#cache.get(key);
    if(old){this.#cacheBytes-=old.bytes;this.#cache.delete(key);}
    this.#cache.set(key,entry);this.#cacheBytes+=entry.bytes;
    for(const [name,item] of this.#cache){
      if(this.#cache.size<=this.#limits.cacheEntries&&this.#cacheBytes<=this.#limits.cacheBytes)break;
      if(name===key)continue;
      this.#cacheBytes-=item.bytes;this.#cache.delete(name);
    }
  }

  async #fetchKlines({symbol,interval,limit,spec,key,deadline,old}){
    const url=this.#origin+KLINES_PATH+'?'+new URLSearchParams({symbol,interval,limit:String(limit)}).toString();
    try{
      const result=await this.#exchange(url,{weight:this.#limits.weightKlines,timeoutMs:this.#limits.klinesTimeoutMs,maxBytes:this.#limits.klinesMaxBytes,deadline});
      const now=this.#clock();
      const bars=parseKlines(result.json,{intervalMs:spec.ms,limit,now});
      const entry={bars,at:now,ttlMs:spec.ttl*SECOND,staleMs:this.#staleSeconds(spec.ttl)*SECOND,bytes:JSON.stringify(bars).length};
      this.#store(key,entry);
      return this.#result(entry,now,false);
    }catch(error){
      if(error?.code==='MARKET_UPSTREAM_REJECTED'){
        if(symbol!==ALWAYS_ALLOWED_SYMBOL)this.#removed.add(symbol);
        throw fail('MARKET_SYMBOL_NOT_ALLOWED',400);
      }
      const now=this.#clock();
      // A stale copy answers only for upstream trouble (503): never for a rejected symbol or a bad request.
      if(old&&error?.status===503&&now-old.at<=old.staleMs)return this.#result(old,now,true);
      throw error;
    }
  }

  /** Klines of one allow-listed symbol: {bars,fetched_at,cache_age_seconds,stale}. Throws fail(code,status). */
  async klines({symbol,interval,limit,actorId,deadline}={}){
    this.#assertEnabled();
    if(typeof symbol!=='string'||!SYMBOL_RE.test(symbol))throw fail('MARKET_SYMBOL_INVALID',400);
    if(typeof interval!=='string'||!Object.hasOwn(KLINE_INTERVALS,interval))throw fail('INTERVAL_NOT_ALLOWED',400);
    if(!Number.isInteger(limit)||limit<1||limit>this.#limits.klinesMaxLimit)throw fail('LIMIT_OUT_OF_RANGE',400);
    const spec=KLINE_INTERVALS[interval];
    if(!await this.#allowed(symbol,deadline))throw fail('MARKET_SYMBOL_NOT_ALLOWED',400);
    const key=symbol+'|'+interval+'|'+limit;
    const now=this.#clock();
    let entry=this.#cache.get(key);
    if(entry&&now-entry.at>entry.staleMs){this.#cacheBytes-=entry.bytes;this.#cache.delete(key);entry=undefined;}
    if(entry&&now-entry.at<entry.ttlMs){this.#cache.delete(key);this.#cache.set(key,entry);return this.#result(entry,now,false);}
    const shared=this.#pending.get(key);
    if(shared)return shared;
    // An open circuit answers before a miss is charged: a stale copy, else the cooldown with its own retry hint.
    const cooling=this.#cooldown(now);
    if(cooling){
      if(entry)return this.#result(entry,now,true);
      throw withRetry(fail('MARKET_UPSTREAM_COOLDOWN',503),(cooling-now)/SECOND);
    }
    const wait=this.#takeMiss(actorId,now);
    if(wait){
      if(entry)return this.#result(entry,now,true);
      throw withRetry(fail('MARKET_RATE_LIMITED',429),wait);
    }
    const promise=this.#fetchKlines({symbol,interval,limit,spec,key,deadline,old:entry}).finally(()=>{this.#pending.delete(key);});
    this.#pending.set(key,promise);
    return promise;
  }

  #assertEnabled(){if(!this.#enabled)throw fail('MARKET_PROXY_DISABLED',503);}

  /** Diagnostics only: no URL, no host. */
  status(){
    const now=this.#clock(),cooling=this.#cooldown(now);
    return {enabled:this.#enabled,circuit:cooling?'open':'closed',cooldown_until:cooling||null,
      symbols_count:this.#symbols?this.#symbols.list.length:0,cache_entries:this.#cache.size};
  }
}