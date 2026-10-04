import {fail} from '../pine-bridge/source.js';
import {exact} from '../money.js';
import {SYMBOL_RE,KLINE_INTERVALS} from './market-proxy.js';

/**
 * Public market data for the Overview chart and the PF-3 market-data readiness item.
 *
 * Two sources. Stored: closed BINANCE:BTCUSDT Spot 1m bars that the market-data writer already stored in pine_market_bars from the public,
 * keyless Binance REST/WebSocket feed. This module only reads those rows: no Binance call, no API key, no write, no
 * lock. Every read starts with SET TRANSACTION READ ONLY, so a write would fail loudly. REST: any Binance Spot symbol through the
 * bounded keyless PublicMarketProxy (market-proxy.js), answered in a deferred phase AFTER the request transaction has committed, so
 * no database connection or snapshot is held during network I/O.
 *
 * Time convention: pine_market_bars.bar_time is the kline close time + 1, which equals the candle OPEN time + 60000. A row
 * with bar_time T covers the open-time interval [T-60000, T). Every time this module returns is a candle OPEN time unless the
 * field says close_time. A stored bar_time that is not a multiple of 60000 is out of contract (the writer never produces one)
 * and is not handled here.
 */
export const OHLCV_PATH='/api/market/ohlcv';
export const MARKET=Object.freeze({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
export const SOURCE='binance-spot-public-stored';
const MINUTE=60000;
// ms/ttl come from the proxy table (one source of truth). limit = default bar count when a request names none (the chart UI asks for
// one fixed limit per symbol and interval, so all viewers share one proxy cache entry); cap = largest accepted bar count; poll = UI
// refresh seconds while visible;
// stored = BTCUSDT stored aggregation offered; storedCap = min(1000, floor(43200 / minutes)), the stored read bound per request.
const bucketSpec=(name,limit,poll,stored)=>{
  const {ms,ttl}=KLINE_INTERVALS[name];
  return Object.freeze({ms,limit,cap:1000,ttl,poll,stored,storedCap:stored?Math.min(1000,Math.floor(43200/(ms/MINUTE))):null});
};
export const INTERVALS=Object.freeze({
  '1m':bucketSpec('1m',360,15,true),'3m':bucketSpec('3m',320,30,true),'5m':bucketSpec('5m',288,30,true),
  '15m':bucketSpec('15m',288,60,true),'30m':bucketSpec('30m',336,60,true),'1h':bucketSpec('1h',336,120,true),
  '2h':bucketSpec('2h',360,120,true),'4h':bucketSpec('4h',360,300,true),'6h':bucketSpec('6h',360,300,true),
  '8h':bucketSpec('8h',360,300,true),'12h':bucketSpec('12h',360,300,true),'1d':bucketSpec('1d',365,300,true),
  '3d':bucketSpec('3d',243,600,false),'1w':bucketSpec('1w',260,600,false)});
export const SYMBOLS_PATH='/api/market/symbols';
export const REST_SOURCE='binance-spot-public-rest';
export const DEFAULT_INTERVAL='1d';
// The deferred (proxy) phase must answer inside this budget; the stored fallback starts only with enough time left.
export const DEFERRED_DEADLINE_MS=11000;
export const STORED_FALLBACK_MIN_MS=1000;
export const STALE_AFTER_SECONDS=180;
// First guesses, to be tuned after staging observation. The REST fallback timer runs every 5 minutes, so a dead stream shows
// WARN, and more than failAgeSeconds means the stream and its fallback both failed.
export const HEALTH=Object.freeze({windowMinutes:1440,passMaxAgeSeconds:180,failAgeSeconds:900,failMissingBars:60,gapRanges:10});
export const GAP_RANGE_CAP=50;

// Constant statements; broker, symbol, times and the bucket size are bound parameters (the bucket size comes only from INTERVALS).
export const SQL=Object.freeze({
  PROBE:"SELECT to_regclass('public.pine_market_bars') AS name",
  // $3 = now: rows of a skewed clock in the future are ignored. Both reads are primary-key index edge reads.
  SPAN:`SELECT (SELECT bar_time FROM pine_market_bars WHERE broker=$1 AND symbol=$2 AND timeframe='1' AND bar_time<=$3
      ORDER BY bar_time DESC LIMIT 1) AS latest,
    (SELECT bar_time FROM pine_market_bars WHERE broker=$1 AND symbol=$2 AND timeframe='1' AND bar_time<=$3
      ORDER BY bar_time ASC LIMIT 1) AS first`,
  // $3 = window start (exclusive), $4 = window end (inclusive), $5 = bucket size in ms. Aggregated in NUMERIC, so no float.
  // n, first and last repeat on every row (window functions over the groups), so one scan also yields the edge facts of the window.
  BARS:`WITH m AS (
      SELECT bar_time, ((bar_time-60000)/$5::bigint)*$5::bigint AS bucket,
        (bar->>'open')::numeric AS o, (bar->>'high')::numeric AS h, (bar->>'low')::numeric AS l,
        (bar->>'close')::numeric AS c, (bar->>'volume')::numeric AS v
      FROM pine_market_bars
      WHERE broker=$1 AND symbol=$2 AND timeframe='1' AND bar_time>$3 AND bar_time<=$4)
    SELECT bucket, count(*)::int AS minutes,
      ((array_agg(o ORDER BY bar_time))[1])::text AS open, max(h)::text AS high, min(l)::text AS low,
      ((array_agg(c ORDER BY bar_time DESC))[1])::text AS close, sum(v)::text AS volume,
      (sum(count(*)) OVER ())::int AS n, min(min(bar_time)) OVER () AS first, max(max(bar_time)) OVER () AS last
    FROM m GROUP BY bucket ORDER BY bucket`,
  EDGE:`SELECT count(*)::int AS n, min(bar_time) AS first, max(bar_time) AS last FROM pine_market_bars
    WHERE broker=$1 AND symbol=$2 AND timeframe='1' AND bar_time>$3 AND bar_time<=$4`,
  // The window count runs after the outer WHERE and before LIMIT, so total is the number of all internal gaps.
  GAPS:`SELECT count(*) OVER () AS total, prev, bar_time FROM (
      SELECT bar_time, lag(bar_time) OVER (ORDER BY bar_time) AS prev FROM pine_market_bars
      WHERE broker=$1 AND symbol=$2 AND timeframe='1' AND bar_time>$3 AND bar_time<=$4) x
    WHERE bar_time-prev>60000 ORDER BY bar_time LIMIT $5`});

const KEYS=new Set(['symbol','interval','limit','source','bot_id']);
const LIMIT_TEXT=/^[1-9][0-9]{0,3}$/;
const SOURCES=new Set(['auto','stored']);

// Each key at most once, never empty. The page's api() helper appends the selected bot id; this data is global and the value is
// never used (public venue data, never bot-scoped).
function strictEntries(searchParams,allowed){
  const seen=new Map();
  for(const [key,value] of searchParams.entries()){
    if(!allowed.has(key)||seen.has(key)||value==='')throw fail('INVALID_FIELDS');
    seen.set(key,value);
  }
  if(seen.has('bot_id')&&seen.get('bot_id').length>128)throw fail('INVALID_FIELDS');
  return seen;
}

/**
 * Strict query parsing. Throws fail(code,400); nothing is clamped. The symbol is plain ('ETHUSDT', no prefix or slash). Returns
 * {symbol,interval,ms,limit,source}. With source=stored and no limit the default limit is lowered to the stored cap of the interval.
 */
export function parseOhlcvQuery(searchParams){
  const seen=strictEntries(searchParams,KEYS);
  const symbol=seen.has('symbol')?seen.get('symbol'):MARKET.symbol;
  if(!SYMBOL_RE.test(symbol))throw fail('MARKET_SYMBOL_INVALID');
  const interval=seen.has('interval')?seen.get('interval'):DEFAULT_INTERVAL;
  if(!Object.hasOwn(INTERVALS,interval))throw fail('INTERVAL_NOT_ALLOWED');
  const spec=INTERVALS[interval];
  let limit=spec.limit;
  if(seen.has('limit')){
    const text=seen.get('limit');
    if(!LIMIT_TEXT.test(text)||Number(text)>spec.cap)throw fail('LIMIT_OUT_OF_RANGE');
    limit=Number(text);
  }
  const source=seen.has('source')?seen.get('source'):'auto';
  if(!SOURCES.has(source))throw fail('SOURCE_NOT_ALLOWED');
  if(source==='stored'){
    if(symbol!==MARKET.symbol||!spec.stored)throw fail('SOURCE_NOT_ALLOWED');
    if(!seen.has('limit'))limit=Math.min(limit,spec.storedCap);
    if(limit>spec.storedCap)throw fail('SOURCE_NOT_ALLOWED');
  }
  return {symbol,interval,ms:spec.ms,limit,source};
}

/** GET /api/market/symbols accepts only the tolerated bot_id. */
export function parseSymbolsQuery(searchParams){
  strictEntries(searchParams,new Set(['bot_id']));
  return {};
}

/**
 * Window of closed buckets ending at the newest stored close boundary. end is the last included bar_time (a bucket close
 * boundary at or before latest), start is exclusive. Only closed buckets fit: the forming bucket is never returned.
 */
export function ohlcvWindow(latest,ms,limit){
  const end=Math.floor(latest/ms)*ms;
  return {start:end-limit*ms,end};
}

/** Minutes before the oldest stored bar are "no history", not gaps: the gap window starts at the stored history. */
export const historyLower=(start,first)=>Math.max(start,first-MINUTE);

/**
 * Gap ranges of one window. lower/end bound the gap window (bar_time in (lower,end]); n, first and last come from the EDGE
 * read; internal rows are {prev,bar_time} pairs with bar_time-prev>60000 and internalTotal is the exact number of them.
 * All range times are candle OPEN times.
 */
export function assembleGaps({lower,end,n,first,last,internal=[],internalTotal=0},cap=GAP_RANGE_CAP){
  const expected=Math.max(0,(end-lower)/MINUTE);
  const all=[];
  let count=0;
  if(n===0){
    if(expected>0){all.push({from_open_time:lower,to_open_time:end-MINUTE,missing_minutes:expected});count=1;}
  }else{
    if(first>lower+MINUTE){
      all.push({from_open_time:lower,to_open_time:first-2*MINUTE,missing_minutes:(first-lower)/MINUTE-1});count++;
    }
    for(const row of internal)all.push({from_open_time:row.prev,to_open_time:row.bar_time-2*MINUTE,missing_minutes:(row.bar_time-row.prev)/MINUTE-1});
    count+=internalTotal;
    if(last<end){all.push({from_open_time:last,to_open_time:end-MINUTE,missing_minutes:(end-last)/MINUTE});count++;}
  }
  const ranges=all.slice(0,cap);
  return {count,missing_minutes:Math.max(0,expected-n),ranges,truncated:count>ranges.length};
}

const emptyGaps=()=>({count:0,missing_minutes:0,ranges:[],truncated:false});
const ageSeconds=(now,closeTime)=>Math.max(0,Math.floor((now-closeTime)/1000));

/** The response object; pure. latest/first are stored bar_time values (close times); rows are the BARS rows. */
export function shapeOhlcv({now,interval,ms,limit,latest=null,first=null,window=null,edge=null,rows=[],gaps=null}){
  const head={version:'market-ohlcv-v1',source:SOURCE,broker:MARKET.broker,symbol:MARKET.symbol,market:'SPOT',base_timeframe:'1m',
    interval,interval_ms:ms,limit,closed_only:true,generated_at:new Date(now).toISOString()};
  if(latest===null)
    return {...head,status:'EMPTY',latest_closed_bar:null,age_seconds:null,stale:true,stale_after_seconds:STALE_AFTER_SECONDS,window:null,bars:[],gaps:emptyGaps()};
  const age=ageSeconds(now,latest);
  const bars=rows.map(row=>({time:row.bucket,open:exact(row.open),high:exact(row.high),low:exact(row.low),close:exact(row.close),
    volume:exact(row.volume),minutes:row.minutes,complete:row.minutes===ms/MINUTE}));
  return {...head,status:bars.length===0?'EMPTY':'OK',latest_closed_bar:{open_time:latest-MINUTE,close_time:latest},age_seconds:age,
    stale:age>STALE_AFTER_SECONDS,stale_after_seconds:STALE_AFTER_SECONDS,
    window:{start_open_time:window.start,end_close_time:window.end,history_start_open_time:first-MINUTE,
      expected_minutes:window.expected,stored_minutes:edge.n},
    bars,gaps:gaps??emptyGaps()};
}

/**
 * The v2 stored answer: the v1 shape plus the v2 fields. latest_closed_bar and the window keep the stored time convention (close
 * time = open time + interval). history_partial is true when the stored history starts after the window start.
 */
export function shapeStoredV2(answer,{fallback=null}={}){
  const partial=answer.window!==null&&answer.window.history_start_open_time>answer.window.start_open_time;
  return {...answer,version:'market-ohlcv-v2',display_symbol:'BINANCE:'+answer.symbol,stale_reason:answer.stale?'STORED_AGE':null,
    cache_age_seconds:null,price_tick:null,history_partial:partial,fallback,
    bars:answer.bars.map(bar=>({...bar,forming:false}))};
}

/**
 * The v2 REST answer from a proxy result {bars,cache_age_seconds,stale}. REST keeps the forming last bar, flagged forming:true;
 * closed-bar facts (latest_closed_bar, age_seconds) ignore it. closed_only is false. No URL or upstream text appears in the body.
 */
export function shapeRest({now,query,result,tick=null,fallback=null}){
  const bars=result.bars.map(bar=>({...bar}));
  const closed=bars.filter(bar=>bar.complete===true).at(-1)??null;
  const closeTime=closed===null?null:closed.time+query.ms;
  return {version:'market-ohlcv-v2',source:REST_SOURCE,broker:MARKET.broker,symbol:query.symbol,display_symbol:'BINANCE:'+query.symbol,
    market:'SPOT',interval:query.interval,interval_ms:query.ms,limit:query.limit,generated_at:new Date(now).toISOString(),
    status:bars.length===0?'EMPTY':'OK',closed_only:false,
    latest_closed_bar:closed===null?null:{open_time:closed.time,close_time:closeTime},
    age_seconds:closeTime===null?null:ageSeconds(now,closeTime),
    stale:result.stale===true,stale_reason:result.stale===true?'UPSTREAM_UNAVAILABLE':null,stale_after_seconds:null,
    cache_age_seconds:result.cache_age_seconds,price_tick:tick,history_partial:false,fallback,window:null,gaps:null,base_timeframe:null,bars};
}

/**
 * Which source answers (pure). query is parseOhlcvQuery output; coverage is {available,latest,first} (only needed for BTCUSDT).
 * Returns one of: {kind:'stored'}, {kind:'proxy',fallback:boolean} (fallback = a labelled stored answer may replace a failed proxy
 * answer), {kind:'stored-fallback',reason} (proxy off, answered from the store) or {kind:'unavailable',code}.
 */
export function chooseSource({query,coverage=null,proxyEnabled=false,now}){
  const spec=INTERVALS[query.interval];
  if(query.source==='stored')return {kind:'stored'};
  if(query.symbol!==MARKET.symbol)return proxyEnabled?{kind:'proxy',fallback:false}:{kind:'unavailable',code:'MARKET_PROXY_DISABLED'};
  if(spec.stored&&query.limit<=spec.storedCap&&coverage?.available===true&&coverage.latest!==null){
    const window=ohlcvWindow(coverage.latest,query.ms,query.limit);
    // Full coverage: the oldest stored candle opens at or before the window start, and the newest bar is fresh.
    if(coverage.first-MINUTE<=window.start&&ageSeconds(now,coverage.latest)<=STALE_AFTER_SECONDS)return {kind:'stored'};
  }
  if(proxyEnabled)return {kind:'proxy',fallback:spec.stored};
  return spec.stored?{kind:'stored-fallback',reason:'MARKET_PROXY_DISABLED'}:{kind:'unavailable',code:'MARKET_PROXY_DISABLED'};
}

/**
 * PF-3 market-data item: advisory only, never part of the verdict and never an unlock. Pure.
 * latest/first are stored bar_time values; edge is the EDGE read of the 24 hour window ending at latest; gaps is assembleGaps.
 */
export function classifyMarketHealth({now,unavailable=null,latest=null,first=null,edge=null,gaps=null}){
  const thresholds={pass_max_age_seconds:HEALTH.passMaxAgeSeconds,fail_age_seconds:HEALTH.failAgeSeconds,fail_missing_bars:HEALTH.failMissingBars};
  const base={version:'pf3-market-data-v1',advisory:true,affects_verdict:false,unlocks:[],source:SOURCE,scope:'BINANCE_GLOBAL_BTCUSDT_SPOT_1M'};
  const rest={latest_closed_bar:null,age_seconds:null,window_minutes:HEALTH.windowMinutes,expected_bars:0,bars_available:0,missing_bars:0,
    gap_count:0,gaps:[],gaps_truncated:false,thresholds};
  if(unavailable)return {...base,status:'FAIL',reasons:['MARKET_DATA_UNAVAILABLE'],unavailable_code:String(unavailable),...rest};
  if(latest===null)return {...base,status:'FAIL',reasons:['MARKET_DATA_EMPTY'],unavailable_code:null,...rest};
  const lower=historyLower(latest-HEALTH.windowMinutes*MINUTE,first);
  const age=ageSeconds(now,latest),expected=Math.max(0,(latest-lower)/MINUTE),missing=gaps.missing_minutes;
  const staleFail=age>HEALTH.failAgeSeconds,stale=age>HEALTH.passMaxAgeSeconds&&!staleFail;
  const excessive=missing>=HEALTH.failMissingBars,gapped=missing>=1&&!excessive;
  const reasons=[];
  if(staleFail)reasons.push('MARKET_DATA_STALE_FAIL');
  if(stale)reasons.push('MARKET_DATA_STALE');
  if(excessive)reasons.push('MARKET_DATA_GAPS_EXCESSIVE');
  if(gapped)reasons.push('MARKET_DATA_GAPS');
  return {...base,status:staleFail||excessive?'FAIL':reasons.length>0?'WARN':'PASS',reasons,unavailable_code:null,
    latest_closed_bar:{open_time:latest-MINUTE,close_time:latest},age_seconds:age,window_minutes:HEALTH.windowMinutes,
    expected_bars:expected,bars_available:edge.n,missing_bars:missing,gap_count:gaps.count,gaps:gaps.ranges.slice(0,HEALTH.gapRanges),
    gaps_truncated:gaps.truncated||gaps.ranges.length>HEALTH.gapRanges,thresholds};
}

const gapsOf=({lower,end,edge,internal},cap)=>assembleGaps({lower,end,n:edge.n,first:edge.first,last:edge.last,internal,
  internalTotal:internal.length>0?internal[0].total:0},cap);

export class MarketDataReader{
  constructor({db,enabled=false,clock=Date.now}={}){
    if(!db||typeof db.query!=='function'||typeof db.transaction!=='function'||typeof clock!=='function')
      throw fail('MARKET_DATA_CONFIGURATION_INVALID',500);
    this.db=db;this.enabled=enabled===true;this.clock=clock;
  }

  // Inside the request transaction this runs in it; the report pipeline of PF-3 does the same on staging.
  #readOnly(operation){
    const {db}=this;
    return db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');return operation();},{isolation:'REPEATABLE READ'});
  }

  async #present(){
    const probe=(await this.db.query(SQL.PROBE)).rows[0];
    return probe?.name!==null&&probe?.name!==undefined;
  }

  async #span(now){
    const row=(await this.db.query(SQL.SPAN,[MARKET.broker,MARKET.symbol,now])).rows[0]??{};
    return {latest:row.latest??null,first:row.first??null};
  }

  // Internal gaps of bar_time in (start,end]; gapLimit bounds the internal gap rows read. edge comes from the caller.
  async #edgeAndGaps(start,end,first,gapLimit,knownEdge=null){
    const {db}=this,identity=[MARKET.broker,MARKET.symbol];
    const edge=knownEdge??(await db.query(SQL.EDGE,[...identity,start,end])).rows[0];
    const internal=(await db.query(SQL.GAPS,[...identity,start,end,gapLimit])).rows;
    return {edge,internal,lower:historyLower(start,first)};
  }

  /** Presence and span of the stored history: {available,latest,first} (bar_time values). No bars are read. */
  async coverage(now=this.clock()){
    const none={available:false,latest:null,first:null};
    if(!this.enabled)return none;
    return this.#readOnly(async()=>{
      if(!await this.#present())return none;
      const {latest,first}=await this.#span(now);
      return {available:true,latest,first};
    });
  }

  /**
   * The stored v1-shaped answer for already validated input {interval,ms,limit,now}. Throws MARKET_DATA_UNAVAILABLE (503) when the
   * store is off or missing.
   */
  async stored({interval,ms,limit,now=this.clock()}){
    if(!this.enabled)throw fail('MARKET_DATA_UNAVAILABLE',503);
    const {db}=this,query={interval,ms,limit};
    return this.#readOnly(async()=>{
      if(!await this.#present())throw fail('MARKET_DATA_UNAVAILABLE',503);
      const {latest,first}=await this.#span(now);
      if(latest===null)return shapeOhlcv({now,...query});
      const window=ohlcvWindow(latest,query.ms,query.limit);
      const rows=(await db.query(SQL.BARS,[MARKET.broker,MARKET.symbol,window.start,window.end,query.ms])).rows;
      // The BARS rows carry the edge facts, so the request scans the window twice (BARS, GAPS), not three times.
      const edge=rows.length>0?{n:rows[0].n,first:rows[0].first,last:rows[0].last}:{n:0,first:null,last:null};
      const found=await this.#edgeAndGaps(window.start,window.end,first,GAP_RANGE_CAP,edge);
      const gaps=gapsOf({...found,end:window.end},GAP_RANGE_CAP);
      return shapeOhlcv({now,...query,latest,first,window:{...window,expected:Math.max(0,(window.end-found.lower)/MINUTE)},
        edge:found.edge,rows,gaps});
    });
  }

  /** The PF-3 market-data item. Disabled or missing data becomes an item, not an error; platform errors propagate. */
  async health(){
    const now=this.clock(),unavailable='MARKET_DATA_UNAVAILABLE';
    if(!this.enabled)return classifyMarketHealth({now,unavailable});
    return this.#readOnly(async()=>{
      if(!await this.#present())return classifyMarketHealth({now,unavailable});
      const {latest,first}=await this.#span(now);
      if(latest===null)return classifyMarketHealth({now});
      const {start,end}=ohlcvWindow(latest,MINUTE,HEALTH.windowMinutes);
      const found=await this.#edgeAndGaps(start,end,first,HEALTH.gapRanges);
      return classifyMarketHealth({now,latest,first,edge:found.edge,gaps:gapsOf({...found,end},HEALTH.gapRanges)});
    });
  }
}

const UNAVAILABLE={error:'Market data unavailable',code:'MARKET_DATA_UNAVAILABLE'};
const ERROR_TEXT=Object.freeze({400:'Market request rejected',429:'Too many market requests',503:'Market data unavailable'});
const FAILED={status:503,body:{error:ERROR_TEXT[503],code:'MARKET_PROXY_FAILED'}};

/**
 * A market error as a {status,body} answer. Only MARKET_*, interval and limit codes with status 400, 429 or 503 pass through (code
 * and optional retry_after_seconds); anything else, including database errors, becomes MARKET_PROXY_FAILED. Upstream text never
 * appears: the message is fixed per status.
 */
export function marketError(error){
  const code=error?.code,status=error?.status;
  if(typeof code!=='string'||!(code.startsWith('MARKET_')||code==='INTERVAL_NOT_ALLOWED'||code==='LIMIT_OUT_OF_RANGE')||!(status in ERROR_TEXT))return FAILED;
  const retry=Number.isInteger(error.retry_after_seconds)&&error.retry_after_seconds>0?{retry_after_seconds:error.retry_after_seconds}:{};
  return {status,body:{error:ERROR_TEXT[status],code,...retry}};
}

/** Runs a deferred phase function. Never throws: any exception becomes 503 MARKET_PROXY_FAILED with no upstream text. */
export async function runMarketDeferred(fn){
  try{
    const result=await fn();
    if(Number.isInteger(result?.status)&&result.body!==null&&typeof result.body==='object')return result;
    return FAILED;
  }catch{return FAILED;}
}

// The deferred OHLCV phase: runs after COMMIT, holds no database client, and reads the store (its own short read-only
// transaction) only for the labelled BTCUSDT fallback after the network attempt failed.
function ohlcvDeferred({reader,proxy,actorId,query,fallback}){
  return async()=>{
    const deadline=proxy.now()+DEFERRED_DEADLINE_MS;
    let failure;
    try{
      const result=await proxy.klines({symbol:query.symbol,interval:query.interval,limit:query.limit,actorId,deadline});
      return {status:200,body:shapeRest({now:proxy.now(),query,result,tick:proxy.tick(query.symbol)})};
    }catch(error){failure=error;}
    if(fallback&&deadline-proxy.now()>=STORED_FALLBACK_MIN_MS){
      try{
        const spec=INTERVALS[query.interval];
        const stored=await reader.stored({interval:query.interval,ms:query.ms,limit:Math.min(query.limit,spec.storedCap),now:reader.clock()});
        const reason=typeof failure?.code==='string'&&failure.code.startsWith('MARKET_')?failure.code:'MARKET_PROXY_FAILED';
        if(stored.bars.length>0)return {status:200,body:shapeStoredV2(stored,{fallback:{from:REST_SOURCE,reason}})};
      }catch{/* the proxy error stays the answer */}
    }
    return marketError(failure);
  };
}

function symbolsDeferred({proxy}){
  return async()=>{
    try{
      const snapshot=await proxy.symbols({deadline:proxy.now()+DEFERRED_DEADLINE_MS});
      const now=proxy.now();
      return {status:200,body:{version:'market-symbols-v1',source:REST_SOURCE,generated_at:new Date(now).toISOString(),
        retrieved_at:new Date(snapshot.retrieved_at).toISOString(),stale:snapshot.stale,count:snapshot.list.length,symbols:snapshot.list}};
    }catch(error){return marketError(error);}
  };
}

// Defers the answer until after COMMIT. Only valid inside the buffered request pipeline; otherwise the setup is wrong and the
// request fails loudly instead of holding a transaction during network I/O.
function defer(res,fn){
  if(res.phase2Buffer!==true)throw fail('MARKET_PIPELINE_INVALID',500);
  res.phase2Deferred=fn;
}

/**
 * GET /api/market/ohlcv and GET /api/market/symbols. Any other path returns false; any other method is 405. options =
 * {actor,proxy}; a missing proxy means the proxy is disabled. A proxy answer sets res.phase2Deferred and returns true without
 * calling json(); stored answers and refusals are json() bodies (no throw, so a poll never writes an audit row).
 */
export async function marketOhlcvRoutes(req,res,url,reader,json,{actor=null,proxy=null}={}){
  const ohlcv=url.pathname===OHLCV_PATH,symbols=url.pathname===SYMBOLS_PATH;
  if(!ohlcv&&!symbols)return false;
  if(req.method!=='GET')throw fail('METHOD_NOT_ALLOWED',405);
  const proxyOn=proxy?.enabled===true;
  const refuse=(status,code,extra={})=>json(res,status,{error:ERROR_TEXT[status],code,...extra});
  const admit=()=>{
    if(!actor?.id)throw fail('MARKET_PIPELINE_INVALID',500);
    const admitted=proxy.admit(actor.id);
    if(admitted.ok)return true;
    refuse(429,admitted.code,{retry_after_seconds:admitted.retry_after_seconds});
    return false;
  };
  if(symbols){
    parseSymbolsQuery(url.searchParams);
    if(!proxyOn)refuse(503,'MARKET_PROXY_DISABLED');
    else if(res.phase2Buffer!==true)throw fail('MARKET_PIPELINE_INVALID',500);
    else if(admit())defer(res,symbolsDeferred({proxy}));
    return true;
  }
  const query=parseOhlcvQuery(url.searchParams),spec=INTERVALS[query.interval],now=reader.clock();
  // Coverage matters only for BTCUSDT on a stored interval; every other request skips the database entirely.
  const needsCoverage=query.source==='auto'&&query.symbol===MARKET.symbol&&spec.stored&&query.limit<=spec.storedCap;
  const coverage=needsCoverage?await reader.coverage(now):null;
  const choice=chooseSource({query,coverage,proxyEnabled:proxyOn,now});
  if(choice.kind==='unavailable'){refuse(503,choice.code);return true;}
  if(choice.kind==='proxy'){
    if(res.phase2Buffer!==true)throw fail('MARKET_PIPELINE_INVALID',500);
    if(admit())defer(res,ohlcvDeferred({reader,proxy,actorId:actor.id,query,fallback:choice.fallback}));
    return true;
  }
  try{
    const direct=choice.kind==='stored';
    const limit=direct?query.limit:Math.min(query.limit,spec.storedCap);
    const answer=await reader.stored({interval:query.interval,ms:query.ms,limit,now});
    json(res,200,shapeStoredV2(answer,{fallback:direct?null:{from:REST_SOURCE,reason:choice.reason}}));
  }catch(error){
    if(error?.code!=='MARKET_DATA_UNAVAILABLE')throw error;
    json(res,503,UNAVAILABLE);
  }
  return true;
}
