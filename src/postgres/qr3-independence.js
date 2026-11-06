import {holdoutWindow,marketKey,MINUTE} from '../quant-library/derive.js';
import {searchedWindow} from '../quant-library/package-gates.js';
import {windowsOverlap} from '../comparison/evidence.js';
import {isObject,REQUIRED_MARKET} from '../comparison/common.js';
import {readExposures,toComparisonEntries} from './exposure-register.js';

/**
 * QR-3 create-time independence facts (hardening packet SB191, slice A; contract section 7 INDEPENDENT row, 13.1 item 10; S3AP section 11 Q3: never derived or
 * defaulted). The create route freezes one block per participant in the same REPEATABLE READ READ ONLY snapshot as the parent reads, so a later replay reads the
 * stored facts and never a live table (determinism, I3). The block holds:
 *   earlier_holdouts  every non-FIXED_INPUT_EVAL run of the owner that evaluated a holdout, except the participant's own parent run, whose holdout window overlaps the
 *                     frozen period (same owner and same market; B0 market rule). Null when any row of the scan cannot be read.
 *   searched_windows  every non-FIXED_INPUT_EVAL run of the owner with the participant's source hash (any status, the parent included: its own search is in-sample data),
 *                     whose searched train and validation window overlaps the frozen period. Null when any row cannot be read.
 *   registered_boundary {state:'NONE'} | {state:'SET', start_ms} | {state:'UNAVAILABLE'} (parent Bot scope, B0 parity; an absent table or an unreadable value is UNAVAILABLE).
 *   source_holdout_window / source_holdout_state  the holdout window of the participant's own parent run (NONE: the parent evaluated no holdout; SET; UNAVAILABLE).
 *   source_holdout_register  the register entries of the same owner and REQUIRED_MARKET that overlap source_holdout_window, in the comparison shape {kind,id,window,at_ms}
 *                     (SB191 finding P2: prior_exposed_by only holds entries that overlap the comparison period, so an exposure of the parent's holdout outside the period would be
 *                     missed). Every entry counts whatever its time: the freeze is the as-of instant. [] only when no holdout window exists (NONE) or none overlaps; null when the
 *                     window is UNAVAILABLE or the register cannot be read (never []).
 *   scanned           rows read by each scan, so the stored lists can be audited against the filter.
 * library_gates (the G1 to G8 snapshot of the library) is added by the caller, which owns the library service.
 *
 * Windows are half-open [start_ms, end_ms) in epoch milliseconds. The library windows are inclusive bar open times, so end_ms is the last open time plus one minute; that
 * is the overlap rule of G5 itself (derive.js windowsOverlap). Only entries that overlap the frozen period are stored: the evidence classifier asks for an overlap
 * with that period alone, so the verdict equals the verdict over the full list, and the freeze stays far below its size limit.
 *
 * This module is outside the reviewed evaluation closure (it names no closure module and no closure module imports it). The three queries are restated from
 * the B0 holdout lookups of the Best Inputs package gate (one-Pine) without the run and time cutoffs (a replay and a comparison have no "earlier than this run"); test/qr3-independence.test.js pins
 * each of them against those B0 constants.
 */
export const INDEPENDENCE_VERSION='qr3-independence-v1';
/** Fixed read budget (root ruling SB187/SB191): rows one scan may return for one participant. Above it the create refuses QR3_READ_BUDGET_EXCEEDED (INDEPENDENCE_ROWS). */
export const INDEPENDENCE_BUDGET=Object.freeze({max_rows_per_scan:1000});
export const BOUNDARY_SCOPE=Object.freeze({venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1'});

export const EARLIER_HOLDOUTS_SQL=`WITH earlier AS MATERIALIZED (SELECT j.run_id,j.created_at,
 CASE WHEN jsonb_typeof(j.contract)='object' THEN j.contract - 'source' #- '{dataset,bars}' #- '{plan,candidates}' END AS k
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND (j.contract->>'mode') IS DISTINCT FROM 'FIXED_INPUT_EVAL' AND j.result->'holdout_evaluated'='true'::jsonb)
 SELECT run_id,k#>'{snapshot,market}' AS market,k->'split' AS split,k#>'{dataset,start_time}' AS start_time FROM earlier ORDER BY created_at,run_id`;
export const SEARCHED_SQL=`SELECT j.run_id,j.contract#>'{snapshot,market}' AS market,j.contract->'split' AS split,j.contract#>'{dataset,start_time}' AS start_time
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND (j.contract->>'mode') IS DISTINCT FROM 'FIXED_INPUT_EVAL' AND j.contract->>'source_hash'=ANY($2::text[]) ORDER BY j.created_at,j.run_id`;
export const BOUNDARY_SQL=`SELECT (SELECT min(sibling.holdout_start_time)
  FROM public.quant_holdout_boundaries sibling WHERE sibling.owner_id=own.owner_id
  AND sibling.venue=own.venue AND sibling.market=own.market
  AND sibling.symbol=own.symbol AND sibling.timeframe=own.timeframe) holdout_start_time
  FROM public.quant_holdout_boundaries own WHERE own.owner_id=$1 AND own.bot_id=$2
  AND own.venue=$3 AND own.market=$4 AND own.symbol=$5 AND own.timeframe=$6`;
const BOUNDARY_TABLE_SQL="SELECT to_regclass('public.quant_holdout_boundaries') AS boundaries";

/** An inclusive library window (bar open times) as the half-open window of the evidence classifier; null when the library window is unreadable. */
export function halfOpen(window){
  if(!isObject(window)||!Number.isSafeInteger(window.start_time)||!Number.isSafeInteger(window.end_time)||window.end_time<window.start_time)return null;
  const converted={start_ms:window.start_time,end_ms:window.end_time+MINUTE};
  return Number.isSafeInteger(converted.end_ms)?converted:null;
}
const shapeOf=row=>({snapshot:{market:row.market},split:row.split,dataset:{start_time:row.start_time}});
const integer=value=>{const parsed=typeof value==='number'?value:typeof value==='string'&&/^-?[0-9]{1,18}$/.test(value)?Number(value):Number.NaN;return Number.isSafeInteger(parsed)?parsed:null;};

/**
 * Reads and builds the independence block of one participant on the given handle (the caller's READ ONLY snapshot).
 * input: {owner_id, run_id (the participant's own parent run), bot_id (the parent's Bot), source_hash, market_key (marketKey of the parent contract), period:{start_ms,end_ms}, limit?}
 * Returns {ok:true, block} or {ok:false, detail:'INDEPENDENCE_ROWS'} when a scan returns more rows than the budget. A database error passes through.
 */
export async function readIndependence(db,{owner_id:owner,run_id:parentId,bot_id:bot,source_hash:source,market_key:ownKey,period,limit=INDEPENDENCE_BUDGET.max_rows_per_scan}){
  if(typeof owner!=='string'||typeof parentId!=='string'||typeof source!=='string'||!isObject(period)||!Number.isSafeInteger(limit)||limit<1)throw new Error('QR3_INDEPENDENCE_INPUT');
  const holdoutRows=(await db.query(EARLIER_HOLDOUTS_SQL+' LIMIT $2',[owner,limit+1])).rows;
  if(holdoutRows.length>limit)return {ok:false,detail:'INDEPENDENCE_ROWS'};
  const searchedRows=(await db.query(SEARCHED_SQL+' LIMIT $3',[owner,[source],limit+1])).rows;
  if(searchedRows.length>limit)return {ok:false,detail:'INDEPENDENCE_ROWS'};
  let holdoutsOk=true,searchedOk=true,sourceState='NONE',sourceWindow=null;
  const holdouts=[],searched=[];
  for(const row of holdoutRows){
    const shape=shapeOf(row),window=halfOpen(holdoutWindow(shape));
    if(row.run_id===parentId){
      // The participant's own parent holdout never flags itself (SB191 binding note); it is the source window for the exposure register check.
      if(window===null)sourceState='UNAVAILABLE';else{sourceState='SET';sourceWindow=window;}
      continue;
    }
    const key=marketKey(shape);
    if(key!==null&&key!==ownKey)continue;
    if(window===null)holdoutsOk=false;
    else if(windowsOverlap(window,period))holdouts.push({run_id:row.run_id,window});
  }
  for(const row of searchedRows){
    const shape=shapeOf(row),key=marketKey(shape),window=halfOpen(searchedWindow(shape));
    if(key!==null&&key!==ownKey)continue;
    if(window===null)searchedOk=false;
    else if(windowsOverlap(window,period))searched.push({run_id:row.run_id,window});
  }
  const sourceRegister=sourceState==='NONE'?[]:sourceState==='SET'?await sourceRegisterOf(db,owner,sourceWindow):null;
  return {ok:true,block:{version:INDEPENDENCE_VERSION,earlier_holdouts:holdoutsOk?holdouts:null,searched_windows:searchedOk?searched:null,
    registered_boundary:await boundaryOf(db,owner,bot),source_holdout_state:sourceState,source_holdout_window:sourceWindow,source_holdout_register:sourceRegister,
    scanned:{holdout_rows:holdoutRows.length,searched_rows:searchedRows.length}}};
}

/** Register entries that overlap the parent's holdout window, deduplicated and ordered like the comparison store's prior list; null when the register cannot be read. */
async function sourceRegisterOf(db,owner,window){
  const read=await readExposures(db,{owner_id:owner,...REQUIRED_MARKET});
  const entries=read.ok===true?toComparisonEntries(read):null;
  if(entries===null)return null;
  const found=new Map();
  for(const entry of entries){
    const item={kind:entry.kind,id:entry.kind==='QR3_COMPARISON'?entry.comparison_id:entry.selection_id,window:entry.window,at_ms:entry.at_ms};
    if(windowsOverlap(item.window,window))found.set([item.kind,item.id,item.window.start_ms,item.window.end_ms,item.at_ms].join('|'),item);
  }
  return [...found.values()].sort((a,b)=>a.at_ms-b.at_ms||(a.id<b.id?-1:a.id>b.id?1:0)||a.window.start_ms-b.window.start_ms);
}

/** B0 parity (the one-Pine holdout lookup of the package gate): no table or an unreadable value is UNAVAILABLE, no row is NONE. A Bot id that is not text cannot be looked up. */
async function boundaryOf(db,owner,bot){
  const present=(await db.query(BOUNDARY_TABLE_SQL)).rows[0];
  if(present?.boundaries===null||present?.boundaries===undefined||typeof bot!=='string')return {state:'UNAVAILABLE'};
  const rows=(await db.query(BOUNDARY_SQL,[owner,bot,...Object.values(BOUNDARY_SCOPE)])).rows;
  if(rows.length===0)return {state:'NONE'};
  const start=integer(rows[0].holdout_start_time);
  return start===null?{state:'UNAVAILABLE'}:{state:'SET',start_ms:start};
}
