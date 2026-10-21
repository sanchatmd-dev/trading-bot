import {createHash} from 'node:crypto';
import {D} from '../money.js';
import {QR2_DAY_MS,QR2_MARKET,QR2_STATUS,Qr2Error} from '../portfolio/qr2-constants.js';
import {validateBoundaryRecord} from '../portfolio/qr2-boundaries.js';
import {resolveRange,utcMidnight,firstFundingAt} from '../portfolio/qr2-periods.js';
import {replayAccount,ledgerRuleEpochsMet,lotMethodsMet,markerCounts,targetOf} from '../portfolio/qr2-replay.js';
import {legacySeeds,runGates,unbackedEquityLine} from '../portfolio/qr2-checks.js';
import {rangePerformance,accountStatus} from '../portfolio/qr2-returns.js';

// QR-2 S2 reader (docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md 6.1, 6.6, 8.1 to 8.4).
// One owner-scoped, read-only account read: every table row of one Bot and broker is read inside ONE REPEATABLE READ, READ ONLY
// transaction, then the pure S1 library replays, gates and values it. The reader writes nothing: no users lock, no fence bump, no
// advisory lock, no audit row (the after-commit audit writer is src/postgres/qr2-audit.js), no network and no research module. No
// migration, no table, no index. Every table name in the reader's own SQL is schema-qualified (public.), like the fence, so a pg_temp
// table of the same name cannot shadow it. Two deliberate exceptions are the product calls store.paperAccount() (R4) and
// store.exposure() (R15): their SQL in ledger.js is unqualified, because R4 and R15 compare with exactly the numbers the product
// computes. The READ ONLY transaction disallows CREATE, so no temp table can be made inside it.

export const QR2_READER_METHOD='qr2-reader-v1';
// OD-Q12 provisional numbers (design 5). Refused QR2_RANGE_ADMISSION_REFUSED, never truncated; exactly at the limit is allowed. Callers may
// lower a limit and never raise it (checkArguments). Root fixes the final numbers after S3 optimises the replay.
// KNOWN RISK (root ruling QR-2 S2 round 2, 2026-10-19): ledger_rows is provisionally 5000 until S3 optimises the replay. The S2 measurement
// shows the replay compute is about quadratic in the fill count (5x the fills took 14x the time: 1000 fills p50 1.2 s, 5000 fills p50
// 17.3 s). 5000 ledger rows is about 2000 fills, which is about 1 to 3 s. The cost sits in src/portfolio/qr2-replay.js (lots are filtered
// again per call, O(fills x lots)), which S2 does not own. The compute is synchronous and blocks the Node event loop; inside an S3
// request transaction a longer compute also exceeds idle_in_transaction_session_timeout (20 s). Do not raise this number before the
// replay is amended and re-measured at 1k, 5k and 20k fills.
export const QR2_READ_LIMITS=Object.freeze({ledger_rows:5000,grid_instants:5000,audit_rows:2000,pending_orders:1000});
export const QR2_AUDIT_EVENTS=Object.freeze(['ledger.cost_clamped','ledger.cost_divergence']);
const BROKERS=Object.freeze(['binance-global','binance-th','innovestx','settrade']);
export const PENDING_STATUSES=Object.freeze(['PROCESSING','SUBMITTED','PARTIALLY_FILLED','UNKNOWN']);
const ISOLATIONS=Object.freeze(['repeatable read','serializable']);
// The own journal rows of the account: rows of the Bot (branch one) and rows on an own signal, whatever their user_id (branch two, so a
// foreign journal row on an own signal is found and refused). The pre-count and the fetch use the same statement, so the budget counts
// every row the fetch returns.
export const JOURNAL_SELECT=`SELECT j.signal_id,j.cumulative_quantity,j.user_id,j.broker,j.cash_delta,j.at,s.execution_mode,s.account_id
    FROM public.paper_cash_journal j JOIN public.signals s ON s.id=j.signal_id WHERE j.user_id=$1 AND j.broker=$2
    UNION
    SELECT j.signal_id,j.cumulative_quantity,j.user_id,j.broker,j.cash_delta,j.at,s.execution_mode,s.account_id
    FROM public.paper_cash_journal j JOIN public.signals s ON s.id=j.signal_id WHERE s.user_id=$1 AND s.broker=$2`;
// Shared exact Q2 predicates; owner admission adds positions without changing account limits.
export const QR2_LEDGER_COUNT_SQL=`SELECT
    (SELECT count(*) FROM public.paper_funding WHERE user_id=$1 AND broker=$2) AS fundings,
    (SELECT count(*) FROM (${JOURNAL_SELECT}) jr) AS journal,
    (SELECT count(*) FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 AND s.broker=$2) AS fills,
    (SELECT count(*) FROM public.ledger_position_allocations WHERE user_id=$1 AND broker=$2) AS lots,
    (SELECT count(*) FROM public.paper_snapshots WHERE user_id=$1 AND broker=$2) AS snapshots`;
// Option R only (not selected, O15): mirrors retrievedAt() of qr2-price.js exactly. A bar is skipped when provenance.retrieved_at is a JSON
// number greater than the instant. Root ruling QR-2 S2 round 3 (Z3): before that query runs, RETRIEVED_AT_NOT_SAFE finds any JSON-number
// retrieved_at that is not a non-negative safe integer (fraction, negative, tiny, above 2^53 - 1) and the read is refused QR2_INPUT_INVALID
// (detail RETRIEVED_AT), so no SQL cast ever sees an out-of-range number (a tiny number made float8 raise 22003). The test works on the text of
// the stored number and casts to numeric only after the digit count and the 2^53 - 1 bound are proven. A string or an absent retrieved_at is
// not a number: it stays usable, like retrievedAt().
const RETRIEVED_AT_NOT_SAFE=`SELECT 1 FROM public.pine_market_bars WHERE broker=$1 AND symbol=$2 AND timeframe=$3 AND jsonb_typeof(provenance->'retrieved_at')='number'
    AND NOT CASE WHEN (provenance->'retrieved_at')::text ~ '^[0-9]{1,15}$' THEN true
      WHEN (provenance->'retrieved_at')::text ~ '^[0-9]{16}$' THEN (provenance->'retrieved_at')::text::numeric<=9007199254740991 ELSE false END LIMIT 1`;
const RETRIEVED_BY_INSTANT=`AND NOT COALESCE(CASE WHEN jsonb_typeof(provenance->'retrieved_at')='number' THEN (provenance->'retrieved_at')::numeric>t.instant END,false)`;
const refusal=(code,message,detail)=>Object.assign(new Qr2Error(code,message),detail?{detail}:{});
const nowMs=()=>Number(process.hrtime.bigint()/1000n)/1000;

/* ------------------------------------------------------------------ pure fact builders (S2b) */

// The ledgerRule marker the ledger wrote into signals.broker_response (corroboration only, contract 6.2). A parse failure is null.
export function markerOf(brokerResponse){
  if(typeof brokerResponse!=='string'||brokerResponse==='')return null;
  try{
    const object=JSON.parse(brokerResponse),value=object&&typeof object==='object'?object.ledgerRule:null;
    return typeof value==='string'?value:null;
  }catch{return null;}
}

// 8.3: bridge.deployment_id, else WEBHOOK, else ATTRIBUTION_UNKNOWN. A tag never changes a number.
export function attributionOf(payload){
  let object=payload;
  if(typeof payload==='string'){try{object=JSON.parse(payload);}catch{return {tag:'ATTRIBUTION_UNKNOWN'};}}
  if(!object||typeof object!=='object'||Array.isArray(object))return {tag:'ATTRIBUTION_UNKNOWN'};
  const id=object.bridge&&typeof object.bridge==='object'?object.bridge.deployment_id:undefined;
  if(typeof id==='string'&&id!=='')return {tag:'BRIDGE',deployment_id:id};
  return {tag:'WEBHOOK'};
}

const keyOf=fill=>String(fill.signal_id)+':'+D(fill.cumulative_quantity).toFixed();

// 8.3 and 8.4 per fill. Slippage is the ledger's modeled value, already inside the fill price; it is SLIPPAGE_UNKNOWN (never zero) when
// the intent price is not recorded or the ledger stored no value. Tags and slippage are information and never change a number.
export function fillFacts(fills){
  const attribution=[],slippage=[],counts={BRIDGE:0,WEBHOOK:0,ATTRIBUTION_UNKNOWN:0},unknown={SLIPPAGE_UNKNOWN:0,MODELED_SLIPPAGE_ALREADY_INCLUDED:0};
  for(const fill of fills){
    const key=keyOf(fill),tag=attributionOf(fill.payload);
    counts[tag.tag]++;attribution.push({event_key:key,...tag});
    const known=fill.slippage_bps!==null&&fill.slippage_bps!==undefined&&fill.has_intent===true;
    const label=known?'MODELED_SLIPPAGE_ALREADY_INCLUDED':'SLIPPAGE_UNKNOWN';
    unknown[label]++;
    slippage.push({event_key:key,label,slippage_bps:known?D(fill.slippage_bps).toFixed():null});
  }
  return {attribution:{by_fill:attribution,counts},slippage:{by_fill:slippage,counts:unknown}};
}

/**
 * R14 (6.6): the ledger.cost_clamped and ledger.cost_divergence audit rows that belong to an own SELL signal of this account, listed with
 * their signal and fill keys and whether the fill is inside the resolved range. A row whose details cannot be parsed, or that names no
 * signal id, is counted and never dropped silently. A row for a signal that is not an own SELL of this account is not listed. The
 * replay also names the audit rows its epoch rule writes (expected_audit); a missing one is listed as information. The SPLIT_NULL of a
 * clamp cycle comes from the replay (RC-Q6) and is not repeated here.
 */
export function r14Listing({auditRows=[],fills=[],replay,range=null}){
  const sells=new Map();
  for(const fill of fills)if(fill.side==='SELL'){
    const id=String(fill.signal_id);
    if(!sells.has(id))sells.set(id,{symbol:fill.symbol,fills:[]});
    sells.get(id).fills.push({event_key:keyOf(fill),time:Number(fill.received_at)});
  }
  const rows=[],unparseable=[];
  for(const row of auditRows){
    let details=null;
    try{details=JSON.parse(row.details);}catch{details=null;}
    const signalId=details&&typeof details==='object'?details.signalId:undefined;
    if(!Number.isSafeInteger(signalId)){unparseable.push({id:row.id,event:row.event,reason:details===null?'DETAILS_NOT_PARSEABLE':'SIGNAL_ID_MISSING'});continue;}
    const sell=sells.get(String(signalId));
    if(!sell)continue;
    const inRange=!!range&&sell.fills.some(f=>f.time>=range.from&&f.time<range.to);
    rows.push({id:row.id,ts:row.ts,event:row.event,trade_id:row.trade_id,signal_id:signalId,symbol:details.symbol??sell.symbol,fill_keys:sell.fills.map(f=>f.event_key),in_range:inRange,details});
  }
  const present=new Set(rows.map(r=>r.signal_id+'|'+r.event)),expectedMissing=[];
  if(replay)for(const event of replay.events)if(event.kind==='FILL'&&!event.halted)for(const name of event.expected_audit||[])
    if(!present.has(event.key.split(':')[0]+'|'+name))expectedMissing.push({event_key:event.key,event:name,code:'AUDIT_ROW_MISSING_FOR_REPLAYED_EVENT'});
  return {rows,unparseable,expected_missing:expectedMissing,count:rows.length};
}

/**
 * R15 (6.6): pending orders at request time. PENDING_ORDERS_PRESENT lists them; an UNKNOWN order, feeReservationUnknown or an exposure
 * read that threw (for example a JSON parse error of a stored order intent) gives PENDING_ORDER_UNCERTAIN, never a reader failure.
 * available_cash exists only when the resolved range ends at the request time and nothing is uncertain; a historical `to` gives
 * RESERVATION_HISTORY_NOT_RECORDED because reservations are not recorded over time.
 */
export function r15Pending({pending=[],exposure=null,exposureError=false,resolvedTo=null,requestTime,cash=null}){
  const uncertain=exposureError||pending.some(o=>o.status==='UNKNOWN')||exposure?.feeReservationUnknown===true||exposure?.uncertain===true;
  const codes=[];
  if(pending.length)codes.push('PENDING_ORDERS_PRESENT');
  if(uncertain&&(pending.length||exposureError))codes.push('PENDING_ORDER_UNCERTAIN');
  const base={orders:pending.map(o=>({id:o.id,side:o.side,symbol:o.symbol,status:o.status})),count:pending.length,codes,uncertain:codes.includes('PENDING_ORDER_UNCERTAIN')};
  if(resolvedTo!==requestTime)return {...base,available_cash:null,available_cash_reason:'RESERVATION_HISTORY_NOT_RECORDED'};
  if(base.uncertain||!exposure||cash===null)return {...base,available_cash:null,available_cash_reason:'PENDING_ORDER_UNCERTAIN'};
  return {...base,available_cash:D(cash).minus(exposure.reservedNotional).minus(exposure.reservedFees??0).toFixed(),available_cash_reason:null,reserved_notional:exposure.reservedNotional,reserved_fees:exposure.reservedFees??'0'};
}

/* ------------------------------------------------------------------ inputs */

function checkArguments({ownerId,botId,broker,from,to,requestTime,boundaries,limits,option='M'}){
  const bad=message=>{throw new Qr2Error('QR2_INPUT_INVALID',message);};
  if(typeof ownerId!=='string'||ownerId==='')bad('ownerId is required');
  if(typeof botId!=='string'||botId==='')bad('botId is required');
  if(!BROKERS.includes(broker))bad('unknown broker');
  for(const [name,value] of [['from',from],['to',to],['requestTime',requestTime]])if(!Number.isSafeInteger(value))bad(name+' must be an integer epoch ms');
  if(boundaries===undefined||boundaries===null)bad('boundaries is required (use QR2_BOUNDARY_RECORD_UNRECORDED to fail closed)');
  if(option!=='M'&&option!=='R')bad('option must be M or R');
  // A caller may only lower a limit (the tests need that); an unknown name or a higher value is refused, so no request input can raise the budget.
  if(limits!==undefined&&limits!==null&&(typeof limits!=='object'||Array.isArray(limits)))bad('limits must be an object');
  for(const [name,value] of Object.entries(limits||{})){
    if(!Object.hasOwn(QR2_READ_LIMITS,name))bad('unknown limit '+name);
    if(!Number.isSafeInteger(value)||value<1)bad('limit '+name+' must be a positive integer');
    if(value>QR2_READ_LIMITS[name])bad('limit '+name+' may be lowered and never raised above '+QR2_READ_LIMITS[name]);
  }
  const merged={...QR2_READ_LIMITS,...(limits||{})};
  return {boundaries:validateBoundaryRecord(boundaries),limits:Object.freeze(merged)};
}

/* ------------------------------------------------------------------ read (one snapshot) */

// The instants where rangePerformance can ask for a price: resolved from and to, every 00:00Z inside, every fill received_at and every
// CONFIGURATION funding at in [from, to). It is a superset of gridPoints() and of the flow and fill instants of twr(); a differential
// test guards the coupling. Computed from raw rows before the replay.
// The arithmetic part of the grid limit: it depends only on the resolved range, so the reader checks it before any row is fetched.
export function assertGridMidnights({from,to,limit}){
  const midnights=Math.max(0,Math.ceil((to-(utcMidnight(from)+QR2_DAY_MS))/QR2_DAY_MS));
  if(midnights+2>limit)throw refusal('QR2_RANGE_ADMISSION_REFUSED','grid instants over the limit',{limit:'grid_instants',value:midnights+2,max:limit});
}
export function priceInstants({from,to,fills,fundings,limit}){
  assertGridMidnights({from,to,limit});
  const set=new Set([from,to]);
  for(let p=utcMidnight(from)+QR2_DAY_MS;p<to;p+=QR2_DAY_MS)set.add(p);
  for(const fill of fills){const t=Number(fill.received_at);if(t>=from&&t<to)set.add(t);}
  for(const row of fundings){const t=Number(row.at);if(row.kind==='CONFIGURATION'&&t>=from&&t<to)set.add(t);}
  if(set.size>limit)throw refusal('QR2_RANGE_ADMISSION_REFUSED','grid instants over the limit',{limit:'grid_instants',value:set.size,max:limit});
  return [...set].sort((a,b)=>a-b);
}

async function readSnapshot(store,{ownerId,botId,broker,from,to,requestTime,limits,option}){
  const db=store.db,q=(sql,params=[])=>db.query(sql,params).then(r=>r.rows);
  // Q0: the isolation is checked first, so a refused parent is left unchanged (still read-write). A joined parent that is READ COMMITTED would
  // give per-statement snapshots silently (db.transaction ignores the isolation option when it joins), so it is refused before anything is
  // set. Then READ ONLY is set and asserted.
  const isolation=(await q('SHOW transaction_isolation'))[0].transaction_isolation;
  if(!ISOLATIONS.includes(isolation))throw refusal('QR2_READER_SNAPSHOT_REQUIRED','the reader needs a READ ONLY REPEATABLE READ or SERIALIZABLE transaction',{read_only:null,isolation});
  await db.query('SET TRANSACTION READ ONLY');
  const readOnly=(await q('SHOW transaction_read_only'))[0].transaction_read_only;
  if(readOnly!=='on')throw refusal('QR2_READER_SNAPSHOT_REQUIRED','the reader needs a READ ONLY REPEATABLE READ or SERIALIZABLE transaction',{read_only:readOnly,isolation});
  // Q1 owner scope: the Bot is the owner's own account or a child Bot of the owner. Anything else is not found as far as this owner knows.
  const owner=(await q('SELECT id,parent_user_id,created_at FROM public.users WHERE id=$1 AND (id=$2 OR parent_user_id=$2)',[botId,ownerId]))[0];
  if(!owner)throw new Qr2Error('QR2_NOT_OWNER','the Bot does not belong to this owner');
  const coverageStart=Number(owner.created_at);
  const range=resolveRange({from,to,requestTime,coverageStart});
  // The grid arithmetic depends only on the resolved range: refuse before Q2 and before any row is fetched.
  if(range.resolved!==null)assertGridMidnights({from:range.resolved.from,to:range.resolved.to,limit:limits.grid_instants});
  // Q2 budget pre-count (OD-Q12), before any row fetch: the whole history counts, not the range length (8.1).
  const counts=(await q(QR2_LEDGER_COUNT_SQL,[botId,broker]))[0];
  const total=Number(counts.fundings)+Number(counts.journal)+Number(counts.fills)+Number(counts.lots)+Number(counts.snapshots);
  if(total>limits.ledger_rows)throw refusal('QR2_RANGE_ADMISSION_REFUSED','ledger rows over the limit',{limit:'ledger_rows',value:total,max:limits.ledger_rows});
  // Q3 to Q9. Every execution mode is selected (decision D4): paperAccount() sums the journal of every mode, so a PAPER filter would hide the
  // cause of an R4 mismatch; the library refuses a non-Paper row (RP) and a row of another Bot (RX).
  const fundings=await q('SELECT id,user_id,broker,at,equity_delta,cash_delta,kind FROM public.paper_funding WHERE user_id=$1 AND broker=$2 ORDER BY at,id',[botId,broker]);
  const fillRows=await q(`SELECT f.signal_id,f.cumulative_quantity,f.delta_quantity,f.price,f.fee_quote,f.quote_amount,f.legacy_float,f.received_at,
    s.user_id,s.broker,s.account_id,s.execution_mode,s.side,s.symbol,s.trade_id,s.payload,s.broker_response,s.slippage_bps,(s.order_intent IS NOT NULL) AS has_intent
    FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 AND s.broker=$2 ORDER BY f.received_at,f.signal_id,f.cumulative_quantity`,[botId,broker]);
  const fills=fillRows.map(({broker_response,...row})=>({...row,ledger_rule:markerOf(broker_response)}));
  const journal=await q(`${JOURNAL_SELECT} ORDER BY at,signal_id,cumulative_quantity`,[botId,broker]);
  const lots=await q(`SELECT position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,status,filled_quantity,remaining_quantity,entry_price,opened_at,closed_at
    FROM public.ledger_position_allocations WHERE user_id=$1 AND broker=$2 ORDER BY opened_at,position_id`,[botId,broker]);
  const positions=await q('SELECT user_id,account_id,execution_mode,broker,symbol,quantity,cost_basis,cumulative_pnl FROM public.ledger_positions WHERE user_id=$1 AND broker=$2',[botId,broker]);
  const cash=(await store.paperAccount(botId,broker)).cash;
  const snapshots=await q('SELECT id,user_id,broker,at,reason,cash,book_equity,position_cost FROM public.paper_snapshots WHERE user_id=$1 AND broker=$2 ORDER BY id',[botId,broker]);
  // Q10 R14 audit rows (sequential scan today; capped, never truncated) and Q11 R15 pending orders at the snapshot.
  const auditRows=await q('SELECT id,user_id,ts,event,trade_id,details FROM public.audit WHERE user_id=$1 AND event IN ($2,$3) ORDER BY id LIMIT $4',[botId,...QR2_AUDIT_EVENTS,limits.audit_rows+1]);
  if(auditRows.length>limits.audit_rows)throw refusal('QR2_RANGE_ADMISSION_REFUSED','audit rows over the limit',{limit:'audit_rows',value:auditRows.length,max:limits.audit_rows});
  const pending=await q(`SELECT id,side,symbol,status FROM public.signals WHERE user_id=$1 AND account_id=$2 AND execution_mode='PAPER' AND status IN (${PENDING_STATUSES.map((_,i)=>'$'+(i+3)).join(',')}) ORDER BY id LIMIT $${PENDING_STATUSES.length+3}`,
    [botId,broker+':primary',...PENDING_STATUSES,limits.pending_orders+1]);
  if(pending.length>limits.pending_orders)throw refusal('QR2_RANGE_ADMISSION_REFUSED','pending orders over the limit',{limit:'pending_orders',value:pending.length,max:limits.pending_orders});
  let exposure=null,exposureError=false;
  // Only the JSON parse failure of a stored order intent is mapped (R15 PENDING_ORDER_UNCERTAIN, design Q11). Every SQL or connection error
  // propagates: an infrastructure fault is never reported as a ledger fact, and the read transaction is never committed after it.
  // QUEUED orders are outside R15 like in store.exposure() (open root call: a QUEUED BUY reserves cash only on its next worker tick).
  try{exposure=await store.exposure({id:0,user_id:botId,account_id:broker+':primary',execution_mode:'PAPER',symbol:'',broker});}
  catch(error){if(error instanceof SyntaxError)exposureError=true;else throw error;}
  // Q12 prices: only when the account holds BTCUSDT on binance-global and the range resolved. One backward primary-key probe per instant, no
  // lower bound, so a bar older than carry_ms still shows its bar_time (RC-Q17 PRICE_OLDER_THAN_CARRY). Option R (not selected) takes the
  // newest bar with bar_time <= instant AND retrieved_at <= instant, like resolvePrice; a differential test covers both options.
  const market={checked:false,table_present:null,instants:0,rows:[],cutoff_bar_time:null};
  // The grid limit applies to every resolved range, also when no price is needed (the drawdown grid is built either way).
  const instants=range.resolved!==null?priceInstants({from:range.resolved.from,to:range.resolved.to,fills,fundings,limit:limits.grid_instants}):[];
  market.instants=instants.length;
  const needsPrice=range.resolved!==null&&broker===QR2_MARKET.broker&&fills.some(f=>f.symbol===QR2_MARKET.symbol);
  if(needsPrice){
    market.checked=true;
    market.table_present=(await q("SELECT to_regclass('public.pine_market_bars') AS present"))[0].present!==null;
    if(market.table_present){
      if(option==='R'&&(await q(RETRIEVED_AT_NOT_SAFE,[QR2_MARKET.broker,QR2_MARKET.symbol,QR2_MARKET.timeframe])).length)
        throw refusal('QR2_INPUT_INVALID','a stored retrieved_at is not a non-negative safe integer','RETRIEVED_AT');
      const found=await q(`SELECT t.instant,b.bar_time,b.bar,b.provenance,b.content_hash FROM unnest($1::bigint[]) AS t(instant)
        LEFT JOIN LATERAL (SELECT bar_time,bar,provenance,content_hash FROM public.pine_market_bars
          WHERE broker=$2 AND symbol=$3 AND timeframe=$4 AND bar_time<=t.instant ${option==='R'?RETRIEVED_BY_INSTANT:''} ORDER BY bar_time DESC LIMIT 1) b ON true`,[instants,QR2_MARKET.broker,QR2_MARKET.symbol,QR2_MARKET.timeframe]);
      const seen=new Set();
      for(const row of found){
        if(row.bar_time===null||seen.has(row.bar_time))continue;
        seen.add(row.bar_time);
        market.rows.push({broker:QR2_MARKET.broker,symbol:QR2_MARKET.symbol,timeframe:QR2_MARKET.timeframe,bar_time:row.bar_time,bar:row.bar,provenance:row.provenance,content_hash:row.content_hash});
      }
      // Q13 market-data cutoff: the newest bar at or before the request time.
      market.cutoff_bar_time=(await q('SELECT max(bar_time) AS cutoff FROM public.pine_market_bars WHERE broker=$1 AND symbol=$2 AND timeframe=$3 AND bar_time<=$4',
        [QR2_MARKET.broker,QR2_MARKET.symbol,QR2_MARKET.timeframe,requestTime]))[0].cutoff;
    }
  }
  const last=fills.length?fills[fills.length-1]:null;
  // Q13 cutoffs from the fetched rows (one snapshot, so they describe exactly the rows used).
  const cutoffs={max_funding_id:fundings.reduce((m,r)=>Math.max(m,Number(r.id)),0),max_snapshot_id:snapshots.reduce((m,r)=>Math.max(m,Number(r.id)),0),fill_count:fills.length,
    last_fill:last?{received_at:Number(last.received_at),signal_id:last.signal_id,cumulative_quantity:last.cumulative_quantity}:null,lot_count:lots.length,market_data_cutoff:market.cutoff_bar_time};
  return {isolation,read_only:readOnly==='on',owner,coverageStart,range,counts:{...counts,total},fundings,fills,journal,lots,positions,cash,snapshots,auditRows,pending,exposure,exposureError,market,cutoffs};
}

/* ------------------------------------------------------------------ compute (pure) */

function computeAccount(snapshot,{botId,broker,from,to,requestTime,boundaries,option}){
  const {fundings,fills,journal,lots,positions,cash,snapshots,range,market}=snapshot;
  // The replay receives the immutable lot fields only (design Q6); the mutable remaining_quantity and status stay with runGates (storedLots).
  const immutableLots=lots.map(({position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,filled_quantity,entry_price,opened_at})=>
    ({position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,filled_quantity,entry_price,opened_at}));
  const replayInput={fundings,journal,fills,lots:immutableLots,epochs:boundaries.epochs,lotFeeBoundary:boundaries.lot_fee_boundary,lotTableBoundary:boundaries.lot_table_boundary};
  const replay=replayAccount(replayInput);
  const seeds=legacySeeds({fundings,fills,replay,accountStart:snapshot.coverageStart});
  const gates=runGates({replay,seeds,fundings,journal,fills,storedLots:lots,stored:{positions,cash},snapshots,scope:{user_id:botId,broker},readTime:requestTime});
  // A refused view produces no number and no row: the caller gets the refusal code only (see refusedView).
  if(gates.refused)return {refused:gates.refused,gates};
  const resolved=range.resolved;
  const commitOrder=gates.gates.R3c;
  const performance=resolved?rangePerformance({replay,seeds,effects:gates.effects,from:resolved.from,to:resolved.to,rows:market.rows,option,broker,commitOrder}):null;
  const r14=r14Listing({auditRows:snapshot.auditRows,fills,replay,range:resolved});
  const r15=r15Pending({pending:snapshot.pending,exposure:snapshot.exposure,exposureError:snapshot.exposureError,resolvedTo:resolved?resolved.to:null,requestTime,cash});
  // Analytics comparison (contract 17): the analytics FIFO ignores targetTradeId. A second replay with the targets removed gives that
  // realized total; a difference is REALIZED_METHOD_DIFFERS_FROM_ANALYTICS. NAV, cash and returns do not depend on cost and are unchanged.
  const targeted=fills.filter(f=>f.side==='SELL'&&targetOf(f.payload)!==null);
  let analytics={code:null,targeted_exits:targeted.length};
  if(targeted.length){
    const plain=replayAccount({...replayInput,fills:fills.map(f=>({...f,payload:'{}'}))});
    if(replay.halted||plain.halted)analytics={code:'ANALYTICS_COMPARISON_NOT_RUN',targeted_exits:targeted.length,reason:'REPLAY_HALTED'};
    else analytics={code:D(plain.final.realized).eq(replay.final.realized)?null:'REALIZED_METHOD_DIFFERS_FROM_ANALYTICS',targeted_exits:targeted.length,realized_replay:replay.final.realized,realized_fifo_ignoring_targets:plain.final.realized};
  }
  const unresolved=[];
  if(r15.uncertain)unresolved.push('PENDING_ORDER_UNCERTAIN');
  if(range.flags.includes('COVERAGE_STARTS_AFTER_REQUEST'))unresolved.push('COVERAGE_STARTS_AFTER_REQUEST');
  const hasLedgerRows=fundings.length+journal.length+fills.length>0;
  const status=resolved?accountStatus({effects:gates.effects,performance,hasLedgerRows,unresolved,to:resolved.to}):{status:QR2_STATUS.UNAVAILABLE,overlays:[],reasons:range.reasons||['RANGE_UNRESOLVED']};
  const state=replay.final||replay.last_good_state;
  return {replay,seeds,gates,performance,commit_order:commitOrder,status,
    facts:{...fillFacts(fills),r14,r15,analytics,unbacked_equity:unbackedEquityLine(state),
      market_data:{checked:market.checked,table_present:market.table_present,instants:market.instants,bars:market.rows.length,gap:market.table_present===false?'MARKET_DATA_TABLE_ABSENT':null}}};
}

/**
 * Reads one Bot account of one owner and computes the QR-2 account view for [from, to). The caller supplies the request time and the
 * boundary record (required; QR2_BOUNDARY_RECORD_UNRECORDED fails closed). Standalone it opens its own REPEATABLE READ, READ ONLY
 * transaction and closes it before the replay; inside a request transaction it joins it and refuses anything below REPEATABLE READ.
 * Refusals are Qr2Error codes: QR2_INPUT_INVALID, QR2_BOUNDARY_RECORD_INVALID, QR2_NOT_OWNER, QR2_RANGE_INVALID,
 * QR2_RANGE_ADMISSION_REFUSED, QR2_READER_SNAPSHOT_REQUIRED. A row-scope or Paper-mode defect is not a thrown error: the view is REFUSED
 * with QR2_CROSS_BOT_ROW or QR2_NON_PAPER_ROW in status and gates.refused, and no number is produced. A refused view carries only the
 * refusal code, the counts, the own-scope identifiers and redacted findings (check, code, reason, table, count): never a row, a replay
 * or a value read from a row of another Bot or owner (rows is null).
 */
export async function readQr2Account(store,args){
  const {snapshot,input}=await readQr2Snapshot(store,args);
  return computeQr2View(snapshot,input);
}

/**
 * The database half of readQr2Account (QR-2 S3b, RC-Q35): validates the arguments, then reads the snapshot inside its own REPEATABLE READ,
 * READ ONLY transaction, which has closed when this returns; inside a request transaction it joins that parent transaction, which stays
 * open (its owner closes it). It returns {snapshot,input}: both are plain data (no handle, no function, no
 * class instance) so a worker thread can compute the view from them with no database access. input holds the validated, frozen boundaries
 * and limits and the measured read time. No SQL, limit, refusal or field differs from the former readQr2Account.
 */
export async function readQr2Snapshot(store,args){
  const {boundaries,limits}=checkArguments(args);
  const {ownerId,botId,broker,from,to,requestTime}=args,option=args.option||'M';
  const started=nowMs();
  const snapshot=await store.db.transaction(()=>readSnapshot(store,{ownerId,botId,broker,from,to,requestTime,limits,option}),{isolation:'REPEATABLE READ'});
  return {snapshot,input:{ownerId,botId,broker,from,to,requestTime,option,boundaries,limits,read_ms:nowMs()-started}};
}

/**
 * The pure half (RC-Q35): replays, gates and values one snapshot and assembles the reader view. It reads no database, clock (except the
 * compute timer), network or module state, so it gives the same view in the main thread and in a worker thread (structured clone of the
 * snapshot is lossless: see the clone-safety test).
 */
export function computeQr2View(snapshot,input){
  const {ownerId,botId,broker,from,to,requestTime,boundaries,limits,option='M',read_ms}=input;
  const computeStarted=nowMs();
  const view=computeAccount(snapshot,{botId,broker,from,to,requestTime,boundaries,option});
  const computeEnded=nowMs();
  const {replay,gates}=view;
  const common={
    reader:{method:QR2_READER_METHOD,isolation:snapshot.isolation,read_only:snapshot.read_only,read_ms,compute_ms:computeEnded-computeStarted,limits,counts:snapshot.counts},
    scope:{owner_id:ownerId,bot_id:botId,broker,account_id:broker+':primary',currency:broker==='binance-global'?'USDT':'THB'},
    boundary_record:{record_id:boundaries.record_id,evidence:boundaries.evidence},
    request:{from,to,request_time:requestTime},
    coverage_start:snapshot.coverageStart
  };
  if(view.refused)return refusedView(common,snapshot.range,view.refused,view.gates);
  return {
    ...common,
    first_funding_at:firstFundingAt(snapshot.fundings),
    range:snapshot.range,
    cutoffs:snapshot.cutoffs,
    rows:{fundings:snapshot.fundings,journal:snapshot.journal,fills:snapshot.fills,lots:snapshot.lots,positions:snapshot.positions,snapshots:snapshot.snapshots,cash:snapshot.cash,market_bars:snapshot.market.rows},
    ledger_rule_epochs:ledgerRuleEpochsMet(replay),lot_epochs:lotMethodsMet(replay),marker_counts:markerCounts(replay),
    ...view,
    audit_findings:auditFindingsOf(gates)
  };
}

// A refused view (RP, RX): the refusal code, the counts and the own-scope identifiers only. The row-scope findings are reduced to check, code,
// reason and table with a count, and the values the library kept (a foreign user_id, a mode, an amount) are dropped. No row, replay, event
// key or finding value of a foreign row leaves the reader. The audit findings carry one entry per distinct offending row (a hashed event key, see refusedAuditFindings; formerly one per check and
// table kind).
function redactedFindings(findings){
  const seen=new Map();
  for(const f of findings||[]){
    if(!f.check)continue;
    const entry={check:f.check,code:f.code??null};
    if(f.reason!==undefined)entry.reason=f.reason;
    if(f.table!==undefined)entry.table=f.table;
    const key=JSON.stringify(entry);
    if(seen.has(key))seen.get(key).count++;else seen.set(key,{...entry,count:1});
  }
  return [...seen.values()];
}
// Audit entries of a refused view (root ruling QR-2 S2 round 3, Z1). One entry per distinct offending row, at most QR2_REFUSED_AUDIT_ENTRIES:
// event_key = sha256(code, table, primary key of the row), so RX on journal and RX on fills stay distinct and a later new incident (another
// row) is a new audit key. Only the hash leaves the reader, never the key or any value of the row.
const QR2_REFUSED_AUDIT_ENTRIES=20;
function refusedAuditFindings(findings){
  const out=new Map();
  for(const f of findings||[]){
    if(!f.check||f.row_key===undefined)continue;
    const event_key='row:'+f.table+':'+createHash('sha256').update(JSON.stringify([f.code??null,f.reason??null,f.table??null,f.row_key])).digest('hex');
    if(out.has(event_key))continue;
    const entry={check:f.check,code:f.code??null,event_key};
    if(f.reason!==undefined)entry.reason=f.reason;
    if(f.table!==undefined)entry.table=f.table;
    out.set(event_key,entry);
    if(out.size>=QR2_REFUSED_AUDIT_ENTRIES)break;
  }
  return [...out.values()];
}
function refusedView(common,range,code,gates){
  const findings=redactedFindings(gates.row_scope.findings);
  return {
    ...common,
    first_funding_at:null,
    range,
    cutoffs:null,
    rows:null,
    refused:code,
    status:{status:QR2_STATUS.REFUSED,overlays:[],reasons:[code]},
    gates:{refused:code,findings:[],row_scope:{refused:gates.row_scope.refused,cross_bot:gates.row_scope.cross_bot,findings}},
    audit_findings:refusedAuditFindings(gates.row_scope.findings)
  };
}

// The findings the after-commit audit writer may write (6.7): gating findings, row-scope refusals and abnormal R3c results.
export function auditFindingsOf(gates){
  const findings=[...gates.findings,...(gates.row_scope?.findings||[])];
  const r3c=gates.gates.R3c;
  if(r3c?.status==='RUN')for(const r of r3c.results)if(r.status!=='MATCH')findings.push({check:'R3c',code:r.status,event_key:r.event_key});
  return findings.filter(f=>f.check);
}
