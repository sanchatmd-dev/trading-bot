import {D} from '../money.js';
import {QR2_METHODS,QR2_STATUS,Qr2Error} from './qr2-constants.js';
import {fillQuote,fillKey,stateAt,isFlat,ZERO_STATE,markerCounts} from './qr2-replay.js';

// QR-2 legacy seeds, ledger-versus-valuation gates, commit-order check R3c and ledger-invariant gates N1/N2 (contract 6.3 to
// 6.6). Pure functions over a replay result and plain stored rows. No gate corrects a number: each failure returns the
// check id, the first failing event and both compared values, so a tester can reproduce it from the tables.

export const EFFECT=Object.freeze({
  RECONCILIATION_FAILED:'RECONCILIATION_FAILED',
  LEDGER_INVARIANT_VIOLATED:'LEDGER_INVARIANT_VIOLATED',
  SPLIT_NULL:'SPLIT_NULL',
  ACCOUNT_UNAVAILABLE:'ACCOUNT_UNAVAILABLE'
});
const failure=(check,effect,extra)=>({check,effect,code:extra.code||effect,...extra});

/* ------------------------------------------------------------------ legacy seeds (6.3, O7) */

/**
 * legacy-two-seed-v1. Markers: M1 fills with legacy_float = 1; M2 a LEGACY_BASELINE funding row; M3 a fill without a journal
 * row or the reverse (gate R1). S_cash = the `at` of the last M2 row, else the account start. S_cost = the first instant t
 * with t >= S_cash and t > the last M1 fill at which every replayed quantity is exactly zero (no epsilon), else null.
 * nav_from is the first instant whose state is seeded: S_cash itself, or S_cash + 1 when an M2 row sits at S_cash because
 * the state at an instant uses events strictly before it (2.6) and so excludes the baseline row at S_cash.
 */
export function legacySeeds({fundings=[],fills=[],replay,accountStart=null}){
  const m1=fills.filter(f=>Number(f.legacy_float)===1);
  const m2=fundings.filter(f=>f.kind==='LEGACY_BASELINE').slice().sort((a,b)=>Number(a.at)-Number(b.at)||D(a.id).cmp(b.id));
  const lastM2=m2.length?m2[m2.length-1]:null;
  const sCash=lastM2?Number(lastM2.at):(accountStart??0);
  const lastM1Time=m1.length?Math.max(...m1.map(f=>Number(f.received_at))):null;
  const candidates=[sCash,...replay.events.map(e=>e.time+1)].filter(t=>t>=sCash&&(lastM1Time===null||t>lastM1Time)).sort((a,b)=>a-b);
  let sCost=null;
  for(const t of candidates){
    const at=stateAt(replay,t);
    if(at.available&&isFlat(at.state)){sCost=t;break;}
  }
  return {method:QR2_METHODS.legacy_method,s_cash:sCash,s_cost:sCost,nav_from:lastM2?sCash+1:sCash,has_m1:m1.length>0,has_m2:m2.length>0,m1_count:m1.length,m2_count:m2.length,last_m1_time:lastM1Time};
}
export const navSeeded=(seeds,instant)=>instant>=seeds.nav_from;
export const costSeeded=(seeds,instant)=>seeds.s_cost!==null&&instant>=seeds.s_cost;

/* ------------------------------------------------------------------ R1, R2, R11, RC, RP, RX (row level) */

function pairRows(fills,journal){
  const journalByKey=new Map(),dupes=[];
  for(const row of journal){
    const key=fillKey(row.signal_id,row.cumulative_quantity);
    if(journalByKey.has(key))dupes.push({event_key:key,reason:'DUPLICATE_JOURNAL_KEY',time:Number(row.at)});else journalByKey.set(key,row);
  }
  const seen=new Set(),pairs=[],fillsWithout=[];
  for(const fill of fills){
    const key=fillKey(fill.signal_id,fill.cumulative_quantity);
    if(seen.has(key)){dupes.push({event_key:key,reason:'DUPLICATE_FILL_KEY',time:Number(fill.received_at)});continue;}
    seen.add(key);
    const paired=journalByKey.get(key);
    if(paired)pairs.push({key,fill,journal:paired});else fillsWithout.push({key,fill});
  }
  const journalWithout=[...journalByKey].filter(([key])=>!seen.has(key)).map(([key,row])=>({key,journal:row}));
  return {pairs,fillsWithout,journalWithout,dupes};
}

// R1 (after S_cash): every fill has exactly one journal row with the same (signal_id, cumulative_quantity) and the reverse,
// and the rows belong to the account. Findings before S_cash are information only, duplicate keys included
// (RC-Q8: by the time of the duplicate row).
export function checkR1({fills,journal,scope,sCash}){
  const {fillsWithout,journalWithout,dupes}=pairRows(fills,journal);
  const failures=[],information=[];
  const target=(time,item)=>(time>=sCash?failures:information).push(item);
  for(const {key,fill} of fillsWithout)target(Number(fill.received_at),failure('R1',EFFECT.RECONCILIATION_FAILED,{reason:'FILL_WITHOUT_JOURNAL',marker:'M3',event_key:key,time:Number(fill.received_at),expected:'journal row',actual:null}));
  for(const {key,journal:row} of journalWithout)target(Number(row.at),failure('R1',EFFECT.RECONCILIATION_FAILED,{reason:'JOURNAL_WITHOUT_FILL',marker:'M3',event_key:key,time:Number(row.at),expected:'fill row',actual:null}));
  for(const d of dupes)target(d.time,failure('R1',EFFECT.RECONCILIATION_FAILED,{reason:d.reason,event_key:d.event_key,time:d.time}));
  for(const row of journal){
    if(scope&&((row.user_id!==undefined&&row.user_id!==scope.user_id)||(row.broker!==undefined&&row.broker!==scope.broker)))
      failures.push(failure('R1',EFFECT.RECONCILIATION_FAILED,{reason:'FOREIGN_JOURNAL_ROW',event_key:fillKey(row.signal_id,row.cumulative_quantity),time:Number(row.at),expected:scope.user_id+'/'+scope.broker,actual:row.user_id+'/'+row.broker}));
  }
  failures.sort((a,b)=>(a.time??-1)-(b.time??-1));information.sort((a,b)=>a.time-b.time);
  return {id:'R1',ok:failures.length===0,effect:EFFECT.RECONCILIATION_FAILED,failures,information};
}

// R2 (after S_cash): journal cash_delta = BUY -(quote_amount + fee_quote), SELL quote_amount - fee_quote.
export function checkR2({fills,journal,sCash}){
  const {pairs}=pairRows(fills,journal);
  const failures=[],information=[];
  for(const {key,fill,journal:row} of pairs){
    const quote=fillQuote(fill),fee=D(fill.fee_quote),expected=fill.side==='BUY'?quote.plus(fee).neg():quote.minus(fee);
    if(!expected.eq(row.cash_delta)){
      const item=failure('R2',EFFECT.RECONCILIATION_FAILED,{event_key:key,time:Number(fill.received_at),expected:expected.toFixed(),actual:D(row.cash_delta).toFixed()});
      (Number(fill.received_at)>=sCash?failures:information).push(item);
    }
  }
  return {id:'R2',ok:failures.length===0,effect:EFFECT.RECONCILIATION_FAILED,failures,information};
}

// R11 (after S_cash): the sum of fills.fee_quote equals the replayed fees. The analytics fee_bps overlay is never part of
// QR-2: a caller that passes one is refused QR2_FEE_OVERLAY_REFUSED.
export function refuseFeeOverlay(feeOverlayBps){
  if(feeOverlayBps!==undefined&&feeOverlayBps!==null)throw new Qr2Error('QR2_FEE_OVERLAY_REFUSED','the analytics fee_bps overlay is not allowed in QR-2');
}
export function checkR11({fills,replay,sCash,feeOverlayBps}){
  refuseFeeOverlay(feeOverlayBps);
  // A halted replay has not seen every fill: RT already reports it.
  if(replay.halted)return {id:'R11',ok:null,not_run:'REPLAY_HALTED',effect:EFFECT.RECONCILIATION_FAILED,failures:[],information:[]};
  const stored=fills.filter(f=>Number(f.received_at)>=sCash).reduce((t,f)=>t.plus(f.fee_quote),D(0));
  const replayed=replay.events.filter(e=>e.kind==='FILL'&&!e.halted&&e.time>=sCash).reduce((t,e)=>t.plus(e.fee),D(0));
  const ok=stored.eq(replayed);
  return {id:'R11',ok,effect:EFFECT.RECONCILIATION_FAILED,failures:ok?[]:[failure('R11',EFFECT.RECONCILIATION_FAILED,{event_key:null,expected:stored.toFixed(),actual:replayed.toFixed()})],information:[]};
}

// RC (2.4): FUTURE_TIMESTAMP, a ledger row stamped after the report read time, and FILL_BEFORE_BAR (RC-Q17, S2), a fill whose received_at is
// earlier than the close of the signal bar. The signal bar close is payload.bridge.bar_time (a Pine Bridge signal; bar_time is the bar close
// and a verified bar is never in the future, so a later fill is expected). A fill whose signal has no bar time (a webhook signal, an
// unparseable payload) cannot be checked: one FILL_BEFORE_BAR_UNCHECKED information item carries the count and the first fill key (D7).
export function signalBarTime(payload){
  let object=payload;
  if(typeof payload==='string'){try{object=JSON.parse(payload||'{}');}catch{return null;}}
  const time=object&&typeof object==='object'?object.bridge?.bar_time:undefined;
  return Number.isSafeInteger(time)&&time>0?time:null;
}
export function checkRC({fundings=[],journal=[],fills=[],snapshots=[],lots=[],readTime}){
  const failures=[],information=[];
  const probe=(rows,field,label,keyOf)=>{for(const row of rows)if(Number(row[field])>readTime)failures.push(failure('RC',EFFECT.RECONCILIATION_FAILED,{code:'FUTURE_TIMESTAMP',event_key:keyOf(row),table:label,time:Number(row[field]),expected:'<= '+readTime,actual:Number(row[field])}));};
  probe(fundings,'at','paper_funding',r=>'F:'+r.id);
  probe(journal,'at','paper_cash_journal',r=>fillKey(r.signal_id,r.cumulative_quantity));
  probe(fills,'received_at','fills',r=>fillKey(r.signal_id,r.cumulative_quantity));
  probe(snapshots,'at','paper_snapshots',r=>'S:'+r.id);
  probe(lots,'opened_at','ledger_position_allocations',r=>'P:'+r.position_id);
  let unchecked=0,firstUnchecked=null;
  for(const fill of fills){
    const barTime=signalBarTime(fill.payload),key=fillKey(fill.signal_id,fill.cumulative_quantity);
    if(barTime===null){unchecked++;if(firstUnchecked===null)firstUnchecked=key;continue;}
    if(Number(fill.received_at)<barTime)failures.push(failure('RC',EFFECT.RECONCILIATION_FAILED,{code:'FILL_BEFORE_BAR',event_key:key,table:'fills',time:Number(fill.received_at),bar_time:barTime,expected:'>= '+barTime,actual:Number(fill.received_at)}));
  }
  if(unchecked)information.push({check:'RC',code:'FILL_BEFORE_BAR_UNCHECKED',effect:null,event_key:firstUnchecked,count:unchecked});
  return {id:'RC',ok:failures.length===0,effect:EFFECT.RECONCILIATION_FAILED,failures,information};
}

// RP: no Live or non-Paper row enters any number; the whole view is refused QR2_NON_PAPER_ROW.
// RX (row part): every counted row belongs to that Bot; a row of another Bot is QR2_CROSS_BOT_ROW. The total-equals-sum
// part of RX belongs to the owner total (S4) and is not implemented here.
// RC-Q19 fail closed: a row of a counted table (fundings, journal, fills, lots) must name its Bot, that is user_id and one of
// broker or account_id (the account id carries the broker). A counted row that does not is QR2_CROSS_BOT_ROW with the reason
// SCOPE_FIELD_MISSING; a missing column never passes as "no mismatch". Positions and snapshots are compared, not counted.
const COUNTED_TABLES=new Set(['fundings','journal','fills','lots']);
const present=value=>value!==undefined&&value!==null;
// Primary key of an offending row (table-specific). Only the reader hashes it into an audit event key; it never leaves the reader as a value.
const rowKeyOf=row=>String(row.id??row.position_id??(row.signal_id!==undefined?row.signal_id+':'+row.cumulative_quantity:null)??(String(row.account_id)+'|'+String(row.symbol)+'|'+String(row.execution_mode)));
export function checkRowScope({scope,tables}){
  const refused=[],crossBot=[];
  for(const [table,rows] of Object.entries(tables)){
    for(const row of rows||[]){
      if(row.execution_mode!==undefined&&row.execution_mode!=='PAPER')refused.push({check:'RP',code:'QR2_NON_PAPER_ROW',table,actual:row.execution_mode,row_key:rowKeyOf(row)});
      if((row.user_id!==undefined&&row.user_id!==scope.user_id)||(row.broker!==undefined&&row.broker!==scope.broker)||(row.account_id!==undefined&&row.account_id!==scope.broker+':primary'))
        crossBot.push({check:'RX',code:'QR2_CROSS_BOT_ROW',table,expected:scope.user_id+'/'+scope.broker,actual:(row.user_id??'?')+'/'+(row.broker??'?'),row_key:rowKeyOf(row)});
      else if(COUNTED_TABLES.has(table)&&!(present(row.user_id)&&(present(row.broker)||present(row.account_id))))
        crossBot.push({check:'RX',code:'QR2_CROSS_BOT_ROW',reason:'SCOPE_FIELD_MISSING',table,expected:scope.user_id+'/'+scope.broker,actual:(row.user_id??'?')+'/'+(row.broker??row.account_id??'?'),row_key:rowKeyOf(row)});
    }
  }
  return {refused:refused.length?'QR2_NON_PAPER_ROW':null,cross_bot:crossBot.length>0,findings:[...refused,...crossBot]};
}
// RX across views of one total: no signal, journal key, funding id or position key appears in two Bot views.
export function checkCrossViewKeys(views){
  const owner=new Map(),findings=[];
  const claim=(view,key)=>{
    if(owner.has(key)&&owner.get(key)!==view)findings.push({check:'RX',code:'QR2_CROSS_BOT_ROW',key,views:[owner.get(key),view]});
    else owner.set(key,view);
  };
  for(const view of views){
    for(const f of view.fills||[]){claim(view.id,'S:'+f.signal_id);}
    for(const j of view.journal||[])claim(view.id,'J:'+fillKey(j.signal_id,j.cumulative_quantity));
    for(const f of view.fundings||[])claim(view.id,'F:'+f.id);
    for(const l of view.lots||[])claim(view.id,'P:'+l.position_id);
  }
  return {ok:findings.length===0,code:findings.length?'QR2_CROSS_BOT_ROW':null,findings};
}

/* ------------------------------------------------------------------ R4, R5, R6, R7, R8, R13 (cutoff state) */

const storedPositions=stored=>new Map((stored?.positions||[]).map(p=>[p.symbol,p]));

// R4 (always): replayed quantity per symbol = ledger_positions.quantity and replayed cash = paperAccount().cash at the cutoff.
// A non-zero replayed quantity where the ledger shows zero is LEGACY_DUST with the exact amount (no epsilon) only when the
// account carries an M1 marker (seeds.has_m1, RC-Q7); otherwise it is a plain R4 quantity failure.
export function checkR4({replay,stored,seeds}){
  if(replay.halted)return {id:'R4',ok:null,not_run:'REPLAY_HALTED',effect:EFFECT.RECONCILIATION_FAILED,failures:[],information:[]};
  const failures=[],map=storedPositions(stored),final=replay.final;
  const symbols=new Set([...map.keys(),...Object.keys(final.positions)]);
  for(const symbol of [...symbols].sort()){
    const replayed=D(final.positions[symbol]?.quantity??0),ledger=D(map.get(symbol)?.quantity??0);
    if(replayed.eq(ledger))continue;
    const dust=seeds?.has_m1===true&&ledger.isZero()&&!replayed.isZero();
    failures.push(failure('R4',EFFECT.RECONCILIATION_FAILED,{...(dust?{code:'LEGACY_DUST',amount:replayed.toFixed()}:{}),symbol,event_key:null,expected:ledger.toFixed(),actual:replayed.toFixed()}));
  }
  if(stored&&stored.cash!==undefined&&!D(final.cash).eq(stored.cash))failures.push(failure('R4',EFFECT.RECONCILIATION_FAILED,{symbol:null,field:'cash',event_key:null,expected:D(stored.cash).toFixed(),actual:D(final.cash).toFixed()}));
  return {id:'R4',ok:failures.length===0,effect:EFFECT.RECONCILIATION_FAILED,failures,information:[]};
}

// R5 (after S_cost): sum of stored open lot remaining + replayed unlotted = ledger_positions.quantity. SPLIT_NULL per symbol.
export function checkR5({replay,stored,storedLots,seeds}){
  if(replay.halted||seeds.s_cost===null)return {id:'R5',ok:null,not_run:replay.halted?'REPLAY_HALTED':'S_COST_UNAVAILABLE',effect:EFFECT.SPLIT_NULL,failures:[],information:[]};
  const failures=[],map=storedPositions(stored),bySymbol=new Map();
  for(const lot of storedLots){
    bySymbol.set(lot.symbol,(bySymbol.get(lot.symbol)||D(0)).plus(lot.remaining_quantity));
  }
  const symbols=new Set([...map.keys(),...bySymbol.keys(),...Object.keys(replay.unlotted)]);
  for(const symbol of [...symbols].sort()){
    const total=(bySymbol.get(symbol)||D(0)).plus(replay.unlotted[symbol]||0),ledger=D(map.get(symbol)?.quantity??0);
    if(!total.eq(ledger))failures.push(failure('R5',EFFECT.SPLIT_NULL,{symbol,event_key:null,expected:ledger.toFixed(),actual:total.toFixed()}));
  }
  return {id:'R5',ok:failures.length===0,effect:EFFECT.SPLIT_NULL,failures,information:[]};
}

// R6 (after S_cost): replayed remaining and status per position_id = stored; L1 holds; no ORPHAN_LOT. SPLIT_NULL.
// Lots of one symbol with the same opened_at are a tie group: the database orders them by opened_at only, so the group's summed
// remaining is compared instead of each position_id (RC-Q17). A tie consumed in part at different entry prices is SPLIT_NULL
// from the replay (LOT_ORDER_AMBIGUOUS); equal prices are information.
export function checkR6({replay,storedLots,seeds}){
  if(replay.halted||seeds.s_cost===null)return {id:'R6',ok:null,not_run:replay.halted?'REPLAY_HALTED':'S_COST_UNAVAILABLE',effect:EFFECT.SPLIT_NULL,failures:[],information:[]};
  const failures=replay.binding.findings.filter(f=>f.effect==='SPLIT_NULL').map(f=>failure('R6',EFFECT.SPLIT_NULL,{...f}));
  const replayed=new Map(replay.lots.map(l=>[l.position_id,l]));
  const groups=new Map();
  for(const lot of storedLots){
    if(lot.opened_at===undefined||lot.opened_at===null)continue;
    const key=lot.symbol+'|'+lot.opened_at;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(lot);
  }
  const tied=new Set();
  for(const group of groups.values())if(group.length>1)for(const lot of group)tied.add(lot.position_id);
  for(const lot of storedLots){
    const r=replayed.get(lot.position_id);
    if(!r||!r.opened||tied.has(lot.position_id))continue;
    if(!D(r.remaining_quantity).eq(lot.remaining_quantity)||r.status!==lot.status)
      failures.push(failure('R6',EFFECT.SPLIT_NULL,{code:'LOT_REMAINING_MISMATCH',position_id:lot.position_id,symbol:lot.symbol,event_key:null,expected:D(lot.remaining_quantity).toFixed()+'/'+lot.status,actual:r.remaining_quantity+'/'+r.status}));
  }
  for(const group of groups.values()){
    if(group.length<2)continue;
    const members=group.filter(lot=>replayed.get(lot.position_id)?.opened);
    if(!members.length)continue;
    const stored=members.reduce((t,lot)=>t.plus(lot.remaining_quantity),D(0)),replayedSum=members.reduce((t,lot)=>t.plus(replayed.get(lot.position_id).remaining_quantity),D(0));
    if(!stored.eq(replayedSum))failures.push(failure('R6',EFFECT.SPLIT_NULL,{code:'LOT_REMAINING_MISMATCH',tie_group:true,opened_at:Number(group[0].opened_at),symbol:group[0].symbol,position_id:null,event_key:null,expected:stored.toFixed(),actual:replayedSum.toFixed()}));
  }
  return {id:'R6',ok:failures.length===0,effect:EFFECT.SPLIT_NULL,failures,information:[]};
}

// R7 (after S_cost): replayed cost per symbol = ledger_positions.cost_basis (COST_DRIFT). SPLIT_NULL.
export function checkR7({replay,stored,seeds}){
  if(replay.halted||seeds.s_cost===null)return {id:'R7',ok:null,not_run:replay.halted?'REPLAY_HALTED':'S_COST_UNAVAILABLE',effect:EFFECT.SPLIT_NULL,failures:[],information:[]};
  const failures=[],map=storedPositions(stored),final=replay.final;
  const symbols=new Set([...map.keys(),...Object.keys(final.positions)]);
  for(const symbol of [...symbols].sort()){
    const replayed=D(final.positions[symbol]?.cost??0),ledger=D(map.get(symbol)?.cost_basis??0);
    if(!replayed.eq(ledger))failures.push(failure('R7',EFFECT.SPLIT_NULL,{code:'COST_DRIFT',symbol,event_key:null,expected:ledger.toFixed(),actual:replayed.toFixed()}));
  }
  return {id:'R7',ok:failures.length===0,effect:EFFECT.SPLIT_NULL,failures,information:[]};
}

// R8 (information): unbacked configured equity = sum equity_delta - sum cash_delta, outside NAV on its own line (QR-2 O3).
// The identity bookEquity - cash - positionCost = that line is checked on the replayed state.
export function unbackedEquityLine(state){
  const line=D(state.equity_sum).minus(state.f_cash),identity=D(state.book_equity).minus(state.cash).minus(state.position_cost);
  return {value:line.toFixed(),identity_ok:identity.eq(line)};
}

// R13 (information): sum of open lot remaining x entry_price against cost_basis per symbol, with the stated bound
// 0.5e-18 x sum of filled quantity since the symbol was last flat. A symbol with unlotted quantity is flagged, not compared.
export function checkR13({replay,storedLots}){
  if(replay.halted)return {id:'R13',ok:null,not_run:'REPLAY_HALTED',rows:[]};
  const rows=[];
  for(const symbol of Object.keys(replay.final.positions).sort()){
    const position=replay.final.positions[symbol];
    if(D(position.quantity).isZero())continue;
    let lotCost=D(0);
    for(const lot of replay.lots)if(lot.symbol===symbol&&lot.opened){
      const stored=storedLots.find(l=>l.position_id===lot.position_id);
      lotCost=lotCost.plus(D(lot.remaining_quantity).mul(stored.entry_price));
    }
    const bound=D('0.5e-18').mul(replay.final.filled_since_flat[symbol]||0),difference=D(position.cost).minus(lotCost);
    const unlotted=D(replay.unlotted[symbol]||0);
    rows.push({symbol,lot_cost:lotCost.toFixed(),position_cost:position.cost,difference:difference.toFixed(),bound:bound.toFixed(),unlotted_quantity:unlotted.toFixed(),within_bound:unlotted.isZero()?difference.abs().lte(bound):null});
  }
  return {id:'R13',ok:rows.every(r=>r.within_bound!==false),rows};
}

/* ------------------------------------------------------------------ RI: identity (6.6) */

/**
 * RI: cash + cost = F_cash + R after every replay event at or after S_cost (cash part after S_cash). An E0 clamp breaks the
 * identity by exactly the clamped amount; that amount is recorded as a labelled E0 difference, not a failure. Any other
 * difference is QR2_IDENTITY_BROKEN and the account is ACCOUNT_UNAVAILABLE.
 */
export function checkIdentity({replay,seeds}){
  if(seeds.s_cost===null)return {id:'RI',ok:null,not_run:'S_COST_UNAVAILABLE',effect:EFFECT.ACCOUNT_UNAVAILABLE,failures:[],e0_differences:[]};
  const failures=[],e0=[];
  for(const e of replay.events){
    if(e.halted||e.time<seeds.s_cost)continue;
    const diff=D(e.state.identity_diff),allowed=D(e.state.e0_clamp_total);
    if(!diff.eq(allowed))failures.push(failure('RI',EFFECT.ACCOUNT_UNAVAILABLE,{code:'QR2_IDENTITY_BROKEN',event_key:e.key,time:e.time,expected:allowed.toFixed(),actual:diff.toFixed()}));
    const clamp=e.epoch==='E0'?e.findings.find(f=>f.code==='COST_CLAMPED'):null;
    if(clamp)e0.push({event_key:e.key,time:e.time,amount:clamp.amount,label:'E0_CLAMP_DIFFERENCE'});
  }
  return {id:'RI',ok:failures.length===0,effect:EFFECT.ACCOUNT_UNAVAILABLE,failures,e0_differences:e0};
}

// R9: NAV = cash + the sum of the rounded market values. A failure is a library fault, REPORT_INTERNAL_ERROR.
export function checkNavSelf(nav){
  if(nav.nav===null)return {id:'R9',ok:null};
  const total=nav.positions.reduce((t,p)=>t.plus(p.market_value??0),D(nav.cash));
  return {id:'R9',ok:total.eq(nav.nav),code:total.eq(nav.nav)?null:'REPORT_INTERNAL_ERROR',expected:total.toFixed(),actual:nav.nav};
}

/* ------------------------------------------------------------------ N1, N2 (6.5) */

/**
 * N1 cash floor (replayed cash >= 0 after every event) and N2 configured-equity floor (sum equity_delta + sum journal
 * cash_delta >= 0 after every CONFIGURATION row), over replay order at or after S_cash. A span opens only at an event where N1
 * or N2 fires (RC-Q1: N2 is evaluated at CONFIGURATION rows only) and closes at the first later event after which cash >= 0 and
 * the equity floor >= 0 (end inclusive: the state at that event's own time still excludes it); an unrecovered span has to =
 * null. A later recovery keeps the recorded violations (O16). A LEGACY_BASELINE row adds its (cash_delta - equity_delta) to the
 * equity floor as configured equity (RC-Q1 extension), so a cash-only legacy seed is not an invariant violation.
 */
export function checkLedgerInvariants({replay,seeds}){
  const violations=[],spans=[];
  let open=null,seeded=D(0);
  for(const e of replay.events){
    if(e.halted)break;
    if(e.kind==='FUNDING'&&e.funding_kind==='LEGACY_BASELINE')seeded=seeded.plus(e.cash_delta).minus(e.equity_delta);
    if(e.time<seeds.s_cash)continue;
    const cash=D(e.state.cash),floor=D(e.state.equity_floor).plus(seeded);
    const n1=cash.lt(0),n2Config=e.kind==='FUNDING'&&e.funding_kind==='CONFIGURATION'&&floor.lt(0);
    if(n1)violations.push(failure('N1',EFFECT.LEDGER_INVARIANT_VIOLATED,{event_key:e.key,time:e.time,value:cash.toFixed(),expected:'>= 0',actual:cash.toFixed()}));
    if(n2Config)violations.push(failure('N2',EFFECT.LEDGER_INVARIANT_VIOLATED,{event_key:e.key,time:e.time,value:floor.toFixed(),expected:'>= 0',actual:floor.toFixed()}));
    const holds=!cash.lt(0)&&!floor.lt(0);
    if(!open&&(n1||n2Config))open={from:e.time,start_event_key:e.key};
    else if(holds&&open){spans.push({from:open.from,to:e.time,start_event_key:open.start_event_key,end_event_key:e.key});open=null;}
  }
  if(open)spans.push({from:open.from,to:null,start_event_key:open.start_event_key,end_event_key:null});
  return {id:'N1N2',ok:violations.length===0,effect:EFFECT.LEDGER_INVARIANT_VIOLATED,violations,spans};
}
// A period [from, to) intersects a span [span.from, span.to] when from <= span.to and to > span.from.
export const intersectsSpan=(spans,from,to)=>spans.some(s=>(s.to===null||from<=s.to)&&to>s.from);

// SPLIT_NULL symbols that apply to the range [from, to): the unscoped symbols plus the symbol of every position cycle
// (cycle.from = the opening fill time, cycle.to = the flat time or null while open) that the range intersects, by the same
// inclusive-end rule as a span (RC-Q6, OD-Q10). A range wholly outside a clamped cycle keeps its cost and PnL.
export function splitNullFor(effects,from,to){
  const symbols=new Set(effects.split_null);
  for(const c of effects.split_null_cycles||[])if((c.to===null||from<=c.to)&&to>c.from)symbols.add(c.symbol);
  return symbols;
}
// The position cycle each FILL event belongs to: {symbol, from: time of the fill that opened the symbol, to: time of the fill
// that made it flat, null while open}. Events of one cycle share one object.
function positionCycles(replay){
  const open=new Map(),byEvent=new Map();
  for(const e of replay.events){
    if(e.kind!=='FILL'||e.halted)continue;
    let cycle=open.get(e.symbol);
    if(!cycle){cycle={symbol:e.symbol,from:e.time,to:null};open.set(e.symbol,cycle);}
    byEvent.set(e.key,cycle);
    if(D(e.state.positions[e.symbol]?.quantity??0).isZero()){cycle.to=e.time;open.delete(e.symbol);}
  }
  return byEvent;
}

/* ------------------------------------------------------------------ R3c: commit-order snapshot check (6.4) */

const snapshotMatches=(state,snapshot)=>D(state.cash).eq(snapshot.cash)&&D(state.book_equity).eq(snapshot.book_equity)&&D(state.position_cost).eq(snapshot.position_cost);

// The F4 signature: a FUNDING snapshot that equals the state before the fill or fills committed just before it, with only
// this funding row applied (a funding request that decided on a snapshot older than those fills).
function staleCandidates(replay,event){
  const result=[];
  let k=0;
  for(let j=event.index-1;j>=0;j--){
    const prior=replay.events[j];
    if(prior.kind!=='FILL'||prior.halted)break;
    k++;
    const base=(j>0?replay.events[j-1].state:null)||ZERO_STATE;
    const equity=D(base.equity_sum).plus(event.equity_delta);
    result.push({k,cash:D(base.f_cash).plus(event.cash_delta).plus(base.j_cash).toFixed(),book_equity:equity.plus(base.j_cash).plus(base.position_cost).toFixed(),position_cost:base.position_cost});
  }
  return result;
}

/**
 * commit-order-snapshot-id-v1. Every ledger event writes exactly one paper_snapshots row (FILL or FUNDING); snapshot id order
 * is commit order. Each event at or after S_cost is compared with the snapshot at the same position from the end of the
 * id-ordered snapshots. Results: MATCH, FUNDING_SNAPSHOT_STALE (the F4 signature), FILL_SNAPSHOT_MISMATCH, ORDER_UNPROVEN
 * (reason or position cannot be aligned, or an event whose time ties with a neighbour does not match), FUNDING_SNAPSHOT_MISMATCH
 * (a FUNDING snapshot that differs without the F4 signature). Diagnostic only. A halted replay is NOT_RUN / REPLAY_HALTED.
 */
export function checkCommitOrder({replay,snapshots,seeds}){
  const base={id:'R3c',method:QR2_METHODS.order_method,effect:null};
  // RC-Q16: after a replay halt the stream stops at the halting fill while snapshots go on, so nothing aligns.
  if(replay.halted)return {...base,status:'NOT_RUN',reason:'REPLAY_HALTED',results:[],diagnostics:[],ok:null};
  if(seeds.s_cost===null)return {...base,status:'NOT_RUN',reason:'S_COST_UNAVAILABLE',results:[],diagnostics:[],ok:null};
  const stream=replay.events.filter(e=>!e.halted&&(e.kind==='FILL'||(e.kind==='FUNDING'&&e.funding_kind==='CONFIGURATION'))&&e.time>=seeds.s_cost);
  const snaps=snapshots.filter(s=>s.reason==='FILL'||s.reason==='FUNDING').slice().sort((a,b)=>D(a.id).cmp(b.id));
  const offset=snaps.length-stream.length;
  // RC-Q17: alignment is by the tail of the id order. When the snapshot count differs from the event count, one
  // SNAPSHOT_COUNT_MISMATCH is reported besides the per-event results.
  const eventCount=replay.events.filter(e=>!e.halted&&(e.kind==='FILL'||(e.kind==='FUNDING'&&e.funding_kind==='CONFIGURATION'))).length;
  const diagnostics=snaps.length===eventCount?[]:[{code:'SNAPSHOT_COUNT_MISMATCH',snapshots:snaps.length,events:eventCount}];
  const results=[];
  stream.forEach((event,i)=>{
    const snap=offset+i>=0?snaps[offset+i]:null;
    const result={event_key:event.key,time:event.time,snapshot_id:snap?String(snap.id):null};
    const tie=[replay.events[event.index-1],replay.events[event.index+1]].some(n=>n&&n.time===event.time);
    if(!snap){results.push({...result,status:'ORDER_UNPROVEN',reason:'NO_SNAPSHOT'});return;}
    const wantedReason=event.kind==='FILL'?'FILL':'FUNDING';
    if(snap.reason!==wantedReason){results.push({...result,status:'ORDER_UNPROVEN',reason:'SNAPSHOT_REASON_ORDER',expected:wantedReason,actual:snap.reason});return;}
    if(snapshotMatches(event.state,snap)){results.push({...result,status:'MATCH'});return;}
    const compared={expected:{cash:event.state.cash,book_equity:event.state.book_equity,position_cost:event.state.position_cost},actual:{cash:D(snap.cash).toFixed(),book_equity:D(snap.book_equity).toFixed(),position_cost:D(snap.position_cost).toFixed()}};
    if(tie){results.push({...result,status:'ORDER_UNPROVEN',reason:'EQUAL_EVENT_TIME',...compared});return;}
    if(event.kind==='FUNDING'){
      const stale=staleCandidates(replay,event).find(c=>D(c.cash).eq(snap.cash)&&D(c.book_equity).eq(snap.book_equity)&&D(c.position_cost).eq(snap.position_cost));
      if(stale){results.push({...result,status:'FUNDING_SNAPSHOT_STALE',stale_over_fills:stale.k,...compared});return;}
    }
    // A FUNDING snapshot that mismatches without the F4 signature has its own diagnostic code (RC-Q17).
    results.push({...result,status:event.kind==='FUNDING'?'FUNDING_SNAPSHOT_MISMATCH':'FILL_SNAPSHOT_MISMATCH',snapshot_reason:snap.reason,...compared});
  });
  return {...base,status:'RUN',results,diagnostics,ok:diagnostics.length===0&&results.every(r=>r.status==='MATCH')};
}

/* ------------------------------------------------------------------ gate runner and effects */

/**
 * Runs every pure gate for one account and returns the gates, the flat findings and the graded effects (6.6):
 * RECONCILIATION_FAILED, LEDGER_INVARIANT_VIOLATED spans, SPLIT_NULL symbols and ACCOUNT_UNAVAILABLE. Nothing is corrected.
 * stored = {positions:[{symbol, quantity, cost_basis}], cash}; storedLots = full allocation rows incl. remaining_quantity, status.
 */
export function runGates({replay,seeds,fundings=[],journal=[],fills=[],storedLots=[],stored,snapshots=[],scope,readTime,feeOverlayBps}){
  refuseFeeOverlay(feeOverlayBps);
  const rowScope=checkRowScope({scope,tables:{fundings,journal,fills,lots:storedLots,positions:stored?.positions||[],snapshots}});
  const gates={
    R1:checkR1({fills,journal,scope,sCash:seeds.s_cash}),
    R2:checkR2({fills,journal,sCash:seeds.s_cash}),
    R4:checkR4({replay,stored,seeds}),
    R5:checkR5({replay,stored,storedLots,seeds}),
    R6:checkR6({replay,storedLots,seeds}),
    R7:checkR7({replay,stored,seeds}),
    R11:checkR11({fills,replay,sCash:seeds.s_cash}),
    RC:readTime===undefined?{id:'RC',ok:null,not_run:'NO_READ_TIME',failures:[],information:[]}:checkRC({fundings,journal,fills,snapshots,lots:storedLots,readTime}),
    RI:checkIdentity({replay,seeds}),
    N:checkLedgerInvariants({replay,seeds}),
    R3c:checkCommitOrder({replay,snapshots,seeds})
  };
  const information=[],unrunR6=[];
  // RC-Q17: a tie group consumed in part at different entry prices is order-dependent: SPLIT_NULL for the symbol. Equal
  // prices are information (R6 compares the group's summed remaining). The SPLIT_NULL finding is an R6 failure: it joins
  // gates.R6.failures and ok is recomputed. When R6 did not run (ok null) the gate stays NOT_RUN and the finding is listed on
  // its own.
  for(const f of replay.findings){
    if(f.code!=='LOT_ORDER_AMBIGUOUS')continue;
    if(f.cost_changes){
      const item=failure('R6',EFFECT.SPLIT_NULL,{code:'LOT_ORDER_AMBIGUOUS',symbol:f.symbol??null,event_key:f.event_key,opened_at:f.opened_at});
      if(gates.R6.ok===null)unrunR6.push(item);
      else{gates.R6.failures.push(item);gates.R6.ok=false;}
    }else information.push({...f});
  }
  // RC-Q13 / RC-Q17: when R6 is NOT_RUN with S_COST_UNAVAILABLE its binding SPLIT_NULL findings (LOT_EPOCH_UNKNOWN,
  // LOT_BINDING_MISMATCH, ORPHAN_LOT) are still recorded, as information.
  if(gates.R6.ok===null&&gates.R6.not_run==='S_COST_UNAVAILABLE')
    information.push(...replay.binding.findings.filter(f=>f.effect===EFFECT.SPLIT_NULL).map(f=>({...f,check:'R6',not_run:'S_COST_UNAVAILABLE'})));
  const findings=[];
  for(const key of ['R1','R2','R4','R5','R6','R7','R11','RC','RI'])findings.push(...gates[key].failures);
  findings.push(...gates.N.violations);
  // Closure failures of the replay (RT): from the failing fill onward.
  findings.push(...replay.findings.filter(f=>f.check==='RT'));
  // RC-Q6 / OD-Q10: a replayed COST_CLAMPED is SPLIT_NULL for its position cycle (symbol, cycle open time, flat time or null
  // while open); a range that does not intersect that cycle keeps its cost and PnL. The R14 audit-row listing stays with S2.
  const cycles=replay.findings.some(f=>f.code==='COST_CLAMPED')?positionCycles(replay):new Map();
  for(const f of replay.findings)if(f.code==='COST_CLAMPED'){
    const cycle=cycles.get(f.event_key);
    findings.push(failure('R14',EFFECT.SPLIT_NULL,{code:'COST_CLAMPED',symbol:f.symbol??null,event_key:f.event_key,amount:f.amount,...(cycle?{cycle:{...cycle}}:{})}));
  }
  findings.push(...unrunR6);
  information.push(...gates.R1.information,...gates.R2.information,...(gates.RC.information||[]));
  // RC-Q2: a row of another Bot refuses the whole view like a non-Paper row (fail closed); no number is produced.
  const refused=rowScope.refused??(rowScope.cross_bot?'QR2_CROSS_BOT_ROW':null);
  const effects=effectsOf({findings,spans:gates.N.spans,replay,refused});
  return {gates,findings,information,effects,refused,row_scope:rowScope,marker_counts:markerCounts(replay),method:{legacy_method:seeds.method,order_method:QR2_METHODS.order_method}};
}

/**
 * Graded effects (6.6). failed_from = the time from which numbers are null: null for a whole-account failure, the failing
 * fill's time for an RT failure (RECONCILIATION_FAILED from that fill onward).
 */
export function effectsOf({findings,spans,replay,refused=null}){
  const reconciliation=findings.filter(f=>f.effect===EFFECT.RECONCILIATION_FAILED);
  const whole=reconciliation.filter(f=>f.check!=='RT');
  const rt=reconciliation.filter(f=>f.check==='RT');
  const rtTime=rt.length&&replay.halted?replay.halted.time:null;
  return {
    refused:refused??null,
    reconciliation_failed:reconciliation.length>0,
    failed_whole_account:whole.length>0,
    failed_from:whole.length>0?null:rtTime,
    first_failure:reconciliation[0]||null,
    account_unavailable:findings.some(f=>f.effect===EFFECT.ACCOUNT_UNAVAILABLE),
    ledger_invariant_spans:spans,
    ledger_invariant_violated:spans.length>0,
    // A SPLIT_NULL finding with a position cycle (COST_CLAMPED, RC-Q6) applies only to ranges that intersect that cycle
    // (splitNullFor); every other SPLIT_NULL finding applies to its symbol in every range.
    split_null:new Set(findings.filter(f=>f.effect===EFFECT.SPLIT_NULL&&!f.cycle).map(f=>f.symbol??null)),
    split_null_cycles:findings.filter(f=>f.effect===EFFECT.SPLIT_NULL&&f.cycle).map(f=>({...f.cycle}))
  };
}
// Numbers of an account are blocked for the interval [.., to) when reconciliation failed for the whole account, or from the
// failing fill onward for an RT failure.
export const reconciliationBlocks=(effects,to)=>effects.account_unavailable||(effects.reconciliation_failed&&(effects.failed_from===null||to>effects.failed_from));

/* ------------------------------------------------------------------ status roll-up (10) */
const ORDER=[QR2_STATUS.COMPLETE,QR2_STATUS.PARTIAL,QR2_STATUS.UNAVAILABLE];
// Worst of a list of COMPLETE / PARTIAL / UNAVAILABLE (account to Bot to owner total).
export function worstStatus(statuses){
  if(!statuses.length)return QR2_STATUS.UNAVAILABLE;
  return statuses.reduce((w,s)=>{if(!ORDER.includes(s))throw new Qr2Error('QR2_INPUT_INVALID','unknown status '+s);return ORDER.indexOf(s)>ORDER.indexOf(w)?s:w;},QR2_STATUS.COMPLETE);
}
