import {fail} from '../pine-bridge/source.js';
import {exact} from '../money.js';

/**
 * Stored public market data for the Analytics chart and the PF-3 market-data readiness item.
 *
 * Source: closed BINANCE:BTCUSDT Spot 1m bars that the market-data writer already stored in pine_market_bars from the public,
 * keyless Binance REST/WebSocket feed. This module only reads those rows: no Binance call, no API key, no write, no
 * lock. Every read starts with SET TRANSACTION READ ONLY, so a write would fail loudly.
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
// ms = bucket size; limit = default bar count; cap = largest accepted bar count.
export const INTERVALS=Object.freeze({
  '1m':Object.freeze({ms:MINUTE,limit:240,cap:1000}),
  '5m':Object.freeze({ms:5*MINUTE,limit:288,cap:1000}),
  '15m':Object.freeze({ms:15*MINUTE,limit:192,cap:1000}),
  '1h':Object.freeze({ms:60*MINUTE,limit:168,cap:720}),
  '4h':Object.freeze({ms:240*MINUTE,limit:180,cap:180}),
  '1d':Object.freeze({ms:1440*MINUTE,limit:30,cap:30})});
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

const KEYS=new Set(['interval','limit','bot_id']);
const LIMIT_TEXT=/^[1-9][0-9]{0,3}$/;

/** Strict query parsing. Throws fail(code,400); nothing is clamped. bot_id is tolerated and ignored (public venue data, never bot-scoped). */
export function parseOhlcvQuery(searchParams){
  const seen=new Map();
  for(const [key,value] of searchParams.entries()){
    if(!KEYS.has(key)||seen.has(key)||value==='')throw fail('INVALID_FIELDS');
    seen.set(key,value);
  }
  // The page's api() helper appends the selected bot id; this data is global and the value is never used.
  if(seen.has('bot_id')&&seen.get('bot_id').length>128)throw fail('INVALID_FIELDS');
  const interval=seen.has('interval')?seen.get('interval'):'1h';
  if(!Object.hasOwn(INTERVALS,interval))throw fail('INTERVAL_NOT_ALLOWED');
  const spec=INTERVALS[interval];
  let limit=spec.limit;
  if(seen.has('limit')){
    const text=seen.get('limit');
    if(!LIMIT_TEXT.test(text)||Number(text)>spec.cap)throw fail('LIMIT_OUT_OF_RANGE');
    limit=Number(text);
  }
  return {interval,ms:spec.ms,limit};
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

  /** The OHLCV answer. Throws fail(...,400) for a bad query (before any SQL) and MARKET_DATA_UNAVAILABLE (503) when the store is off. */
  async ohlcv(searchParams){
    const query=parseOhlcvQuery(searchParams);
    if(!this.enabled)throw fail('MARKET_DATA_UNAVAILABLE',503);
    const {db}=this,now=this.clock();
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

/** GET /api/market/ohlcv. Any other path returns false; an unavailable store is a 503 body (no throw, so no audit row per poll). */
export async function marketOhlcvRoutes(req,res,url,reader,json){
  if(url.pathname!==OHLCV_PATH)return false;
  if(req.method!=='GET')throw fail('METHOD_NOT_ALLOWED',405);
  try{
    json(res,200,await reader.ohlcv(url.searchParams));
  }catch(error){
    if(error?.code!=='MARKET_DATA_UNAVAILABLE')throw error;
    json(res,503,{error:'Market data unavailable',code:'MARKET_DATA_UNAVAILABLE'});
  }
  return true;
}
