import {randomUUID} from 'node:crypto';
import {canonical} from '../pine-bridge/source.js';

/**
 * QR-3 S2a exposure register: the one writer, the one reader and the two adapters that turn register rows into the entry shapes the
 * committed pure modules take. The pure modules (src/comparison/evidence.js, src/selection/window.js, src/quant-library/package-gates.js)
 * are unchanged and stay database-free; this module is the only place a register row is converted.
 *
 * Windows are half-open [start_ms, end_ms) in epoch milliseconds, minute aligned, warm-up excluded. The comparison shape (QR-3 and QR-4)
 * keeps that window. The package shape (B0, OD-19) is inclusive: end_time is the last covered bar open time, end_ms - 60000.
 *
 * Writer protocol (RO-12). The caller opens its own SERIALIZABLE transaction (db.transaction(fn,{isolation:'SERIALIZABLE'})) and
 * runs no statement other than SET before appendExposures (a read, an advisory-lock SELECT or an INSERT all take the snapshot, and the
 * outcome is then 40001 instead of CHECK_REFUSED): the first statement here is LOCK TABLE ... SHARE ROW EXCLUSIVE, which takes no snapshot,
 * serializes register writers, and leaves readers unaffected, so the register read that follows already sees every committed
 * writer. The caller retries a 40001 failure from the start and reruns its checks. A writer that read first still cannot corrupt
 * the register: PostgreSQL then fails it with 40001 (serialization) instead of letting it append a stale decision.
 * Accepted residual risk (root ruling, 2026-10-20): the runtime role keeps table UPDATE only to carry that LOCK, and the privilege also allows
 * LOCK TABLE ... ACCESS EXCLUSIVE, which blocks readers. A row is never changed (trigger QR002); the hold is bounded by the statement and
 * idle-in-transaction timeouts of PostgresDatabase, the same trade-off as quant_foundation_scheduler.
 * A database guard refuses an INSERT outside SERIALIZABLE (SQLSTATE QR003); UPDATE, DELETE and TRUNCATE are refused (QR002).
 */
export const EXPOSURE_KINDS=Object.freeze(['QR3_COMPARISON','QR4_SELECTION']);
export const EXPOSURE_CODES=Object.freeze({UNAVAILABLE:'EXPOSURE_REGISTER_UNAVAILABLE',ROW_INVALID:'EXPOSURE_REGISTER_ROW_INVALID',INPUT_INVALID:'EXPOSURE_REGISTER_INPUT_INVALID',
  EVENT_INVALID:'EXPOSURE_EVENT_INVALID',CHECK_REFUSED:'EXPOSURE_CHECK_REFUSED'});
export const MAX_EVENTS_PER_APPEND=500;
const MINUTE=60000,MAX_AT_MS=253402300799999,MAX_END_MS=253402300800000;
const TABLE='public.quant_exposure_register';
const COLUMNS='exposure_id,kind,owner_id,broker,symbol,timeframe,start_ms,end_ms,comparison_id,participant_run_id,source_hash,selection_id,at_ms';
const SHA256=/^[0-9a-f]{64}$/;
const text=value=>typeof value==='string'&&value.length>0?value:null;
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// bigint arrives as a number from the product pool parser and as a string from a plain client; both are accepted, nothing else is.
const integer=value=>{
  if(typeof value==='number')return Number.isSafeInteger(value)?value:null;
  if(typeof value==='string'&&/^\d{1,16}$/.test(value)){const parsed=Number(value);return Number.isSafeInteger(parsed)?parsed:null;}
  return null;
};
const aligned=value=>value!==null&&value>=0&&value%MINUTE===0;

/** Normalizes one stored row; null when it breaks any rule the table CHECK constraints state (so a tampered row is never trusted). */
function normalizeRow(row){
  if(!isObject(row))return null;
  const start=integer(row.start_ms),end=integer(row.end_ms),at=integer(row.at_ms);
  if(!EXPOSURE_KINDS.includes(row.kind)||!text(row.owner_id)||!text(row.broker)||!text(row.symbol)||!text(row.timeframe))return null;
  if(!aligned(start)||!aligned(end)||end<=start||end>MAX_END_MS||at===null||at<0||at>MAX_AT_MS)return null;
  const base={exposure_id:row.exposure_id??null,kind:row.kind,owner_id:row.owner_id,broker:row.broker,symbol:row.symbol,timeframe:row.timeframe,start_ms:start,end_ms:end,at_ms:at};
  if(row.kind==='QR3_COMPARISON'){
    if(!text(row.comparison_id)||!text(row.participant_run_id)||typeof row.source_hash!=='string'||!SHA256.test(row.source_hash)||row.selection_id!=null)return null;
    return {...base,comparison_id:row.comparison_id,participant_run_id:row.participant_run_id,source_hash:row.source_hash,selection_id:null};
  }
  if(!text(row.selection_id)||row.comparison_id!=null||row.participant_run_id!=null||row.source_hash!=null)return null;
  return {...base,comparison_id:null,participant_run_id:null,source_hash:null,selection_id:row.selection_id};
}

/**
 * Reads the exposure events of one owner and market inside the caller's transaction. {ok:true, rows} or {ok:false, code}: an absent
 * register (table or marker missing) and a row that breaks the table rules are both ok:false, never an empty list. An empty register
 * is valid. The relation is schema-qualified, so a session TEMP table with the same name is never read in its place.
 * The marker must hold exactly one row, version 1. A missing SELECT grant (SQLSTATE 42501, the grant script not reapplied after the install)
 * throws: the install window includes the grant reapply, and a throw fails closed.
 */
export async function readExposures(db,{owner_id:owner,broker,symbol,timeframe}={}){
  if(!db||typeof db.query!=='function'||!text(owner)||!text(broker)||!text(symbol)||!text(timeframe))return {ok:false,code:EXPOSURE_CODES.INPUT_INVALID,rows:null};
  const present=(await db.query("SELECT to_regclass('public.quant_exposure_register') AS register,to_regclass('public.quant_exposure_register_schema') AS marker")).rows[0];
  if(!present||present.register===null||present.marker===null)return {ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null};
  const marker=(await db.query('SELECT version FROM public.quant_exposure_register_schema')).rows;
  if(marker.length!==1||marker[0].version!==1)return {ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null};
  const stored=(await db.query('SELECT '+COLUMNS+' FROM '+TABLE+' WHERE owner_id=$1 AND broker=$2 AND symbol=$3 AND timeframe=$4 ORDER BY at_ms,start_ms,end_ms,exposure_id',[owner,broker,symbol,timeframe])).rows;
  const rows=stored.map(normalizeRow);
  if(rows.includes(null))return {ok:false,code:EXPOSURE_CODES.ROW_INVALID,rows:null};
  return {ok:true,code:null,rows};
}

const rowsOf=input=>Array.isArray(input)?input:(isObject(input)&&input.ok===true&&Array.isArray(input.rows)?input.rows:null);
function normalizedRows(input){
  const rows=rowsOf(input);
  if(rows===null)return null;
  const out=rows.map(normalizeRow);
  return out.includes(null)?null:out;
}

/**
 * Register rows to the QR-3 and QR-4 pure-module entry shape: {owner_id, market_key (canonical market object), window:{start_ms,end_ms}
 * half-open, comparison_id | selection_id, kind, at_ms}. Returns null for an unavailable read or any invalid row, so the pure module
 * reports its own unavailable code (QR3_EXPOSURE_REGISTER_UNAVAILABLE, QR4_EXPOSURE_REGISTRY_UNAVAILABLE).
 */
export function toComparisonEntries(input){
  const rows=normalizedRows(input);
  if(rows===null)return null;
  return rows.map(row=>({owner_id:row.owner_id,market_key:canonical({broker:row.broker,symbol:row.symbol,timeframe:row.timeframe}),
    window:{start_ms:row.start_ms,end_ms:row.end_ms},kind:row.kind,at_ms:row.at_ms,
    ...(row.kind==='QR3_COMPARISON'?{comparison_id:row.comparison_id}:{selection_id:row.selection_id})}));
}

/**
 * Register rows to the B0 package-gate entry shape (OD-19): a QR-3 event {owner_id, market:{broker,symbol,timeframe}, source_hash,
 * window:{start_time,end_time}, comparison_id, at_utc} or a QR-4 record {owner_id, market, window, selection_id, at_utc}. The window is
 * inclusive (end_time = end_ms - 60000, the last covered bar) and at_utc is an ISO-8601 UTC string with three fraction digits.
 * Returns null for an unavailable read or any invalid row, so B0 reports BI_EXPOSURE_REGISTER_UNAVAILABLE.
 */
export function toPackageEntries(input){
  const rows=normalizedRows(input);
  if(rows===null)return null;
  return rows.map(row=>({owner_id:row.owner_id,market:{broker:row.broker,symbol:row.symbol,timeframe:row.timeframe},
    window:{start_time:row.start_ms,end_time:row.end_ms-MINUTE},at_utc:new Date(row.at_ms).toISOString(),
    ...(row.kind==='QR3_COMPARISON'?{source_hash:row.source_hash,comparison_id:row.comparison_id}:{selection_id:row.selection_id})}));
}

function normalizeEvent(event,market,at){
  if(!isObject(event)||!EXPOSURE_KINDS.includes(event.kind)||!isObject(event.window))return null;
  const row=normalizeRow({exposure_id:randomUUID(),kind:event.kind,owner_id:market.owner_id,broker:market.broker,symbol:market.symbol,timeframe:market.timeframe,
    start_ms:event.window.start_ms,end_ms:event.window.end_ms,comparison_id:event.comparison_id,participant_run_id:event.participant_run_id,source_hash:event.source_hash,
    selection_id:event.selection_id,at_ms:at});
  // Only a number is accepted here: the writer never converts a string window or clock value.
  const numeric=[event.window.start_ms,event.window.end_ms,at].every(value=>typeof value==='number');
  return row!==null&&numeric?row:null;
}

/**
 * The one register writer. Runs inside the caller's SERIALIZABLE transaction (see the module comment). Order: validate the events
 * (pure, before any statement), LOCK TABLE ... SHARE ROW EXCLUSIVE, confirm the transaction is SERIALIZABLE, read the owner's rows
 * for the market, run the optional check(read) and append only when it returns null, undefined or false. A truthy check result is a
 * refusal: {ok:false, code:'EXPOSURE_CHECK_REFUSED', refusal, appended:0} and nothing is written; that is the only return after the
 * lock that is not a success, so the caller reads ok and rolls back or reports. An unreadable register (absent marker, bad marker version or
 * a row that breaks a table rule) throws an Error whose code is EXPOSURE_REGISTER_UNAVAILABLE or EXPOSURE_REGISTER_ROW_INVALID, so the
 * caller's transaction aborts and cannot commit spec rows without an exposure. An absent table throws 42P01 at the LOCK (fail closed).
 *
 * events: [{kind:'QR3_COMPARISON', window:{start_ms,end_ms}, comparison_id, participant_run_id, source_hash} |
 *          {kind:'QR4_SELECTION', window, selection_id}]. One at_ms = now() is read once per call (the application clock that also stamps
 *          quant_jobs.created_at) and stamps every event; an at_ms on an event is ignored, so one append never carries mixed clocks.
 *          owner_id, broker, symbol and timeframe apply to every event of the call.
 */
export async function appendExposures(db,{owner_id:owner,broker,symbol,timeframe,events,check=null,now=Date.now}={}){
  if(!db||typeof db.query!=='function'||db.isTransaction!==true)throw Error('Exposure register writes require the caller transaction');
  const market={owner_id:owner,broker,symbol,timeframe};
  const at=now();
  const rows=Array.isArray(events)&&events.length>0&&events.length<=MAX_EVENTS_PER_APPEND&&text(owner)&&text(broker)&&text(symbol)&&text(timeframe)?events.map(event=>normalizeEvent(event,market,at)):null;
  if(rows===null||rows.includes(null))return {ok:false,code:EXPOSURE_CODES.EVENT_INVALID,appended:0,rows:[]};
  await db.query('LOCK TABLE '+TABLE+' IN SHARE ROW EXCLUSIVE MODE');
  const isolation=(await db.query("SELECT current_setting('transaction_isolation') AS level")).rows[0].level;
  if(isolation!=='serializable')throw Object.assign(Error('Quant exposure register writes require a SERIALIZABLE transaction'),{code:'QR003'});
  const read=await readExposures(db,market);
  if(!read.ok)throw Object.assign(Error('Exposure register is not readable: '+read.code),{code:read.code});
  if(typeof check==='function'){
    const refusal=await check(read);
    if(refusal!==null&&refusal!==undefined&&refusal!==false)return {ok:false,code:EXPOSURE_CODES.CHECK_REFUSED,refusal,appended:0,rows:[]};
  }
  const stored=[];
  for(const row of rows){
    const result=await db.query('INSERT INTO '+TABLE+'('+COLUMNS+') VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING '+COLUMNS,
      [row.exposure_id,row.kind,row.owner_id,row.broker,row.symbol,row.timeframe,row.start_ms,row.end_ms,row.comparison_id,row.participant_run_id,row.source_hash,row.selection_id,row.at_ms]);
    stored.push(normalizeRow(result.rows[0]));
  }
  return {ok:true,code:null,appended:stored.length,rows:stored};
}
