import {D,amount} from '../money.js';
import {QR2_EPOCHS,QR2_MARKER_EPOCH,QR2_METHODS,Qr2Error} from './qr2-constants.js';

// QR-2 ledger replay with rule epochs E0 to E2 (contract 6.2). Pure function over plain ledger rows (decimal strings, as
// the NUMERIC(38,18) columns arrive) for ONE account: Bot user_id, broker, PAPER. Replay is the reporting source of quantity,
// cost, realized PnL and fees at any instant. It never tries another epoch to make a fill reconcile.
//
// Inputs (all arrays of plain rows):
//   fundings  paper_funding      {id, at, equity_delta, cash_delta, kind}
//   journal   paper_cash_journal {signal_id, cumulative_quantity, cash_delta, at}
//   fills     fills joined to signals {signal_id, cumulative_quantity, delta_quantity, price, fee_quote, quote_amount,
//             received_at, legacy_float, side, symbol, trade_id, payload, ledger_rule?}
//   lots      ledger_position_allocations, immutable fields only {position_id, entry_signal_id, entry_trade_id,
//             filled_quantity, entry_price, opened_at, symbol}
//   epochs    [{epoch:'E0'|'E1'|'E2', from:int|null (inclusive), to:int|null (exclusive)}] root-recorded boundaries (OD-Q6),
//             matched against fills.received_at. A fill that no row (or more than one row) covers has an unknown epoch.
//   lotFeeBoundary    int|null  root-recorded instant (RC-Q13): lots opened before it carry entry_price =
//             round18(quote / delta) (fee excluded, 9a87ab6); lots opened at or after it carry round18((quote + fee) / delta)
//             (b74ba50). Absent: a lot that fails the current formula is LOT_EPOCH_UNKNOWN (SPLIT_NULL for the symbol).
//   lotTableBoundary  int|null  root-recorded instant (RC-Q14): an E0 fill received before it replays with targetTradeId
//             ignored, as the ledger booked it before targeted exits existed. Absent: the target is honoured (the halt stays).
//             It is also the lot-table cutoff of L1 binding (RC-Q17): an unbound BUY at or after min(earliest lot opened_at,
//             lotTableBoundary) is LOT_BINDING_MISMATCH, so a lost lot table cannot hide as NO_LOT.

const ZERO=D(0);
const RANK={FUNDING:0,FILL:1,JOURNAL:2};

export const fillKey=(signalId,cumulativeQuantity)=>`${String(signalId)}:${D(cumulativeQuantity).toFixed()}`;
const fundingKey=id=>`F:${String(id)}`;
const lotOrder=(a,b)=>Number(a.opened_at)-Number(b.opened_at)||(a.position_id<b.position_id?-1:a.position_id>b.position_id?1:0);

// Notional of a fill. A legacy fill (legacy_float = 1) can lack quote_amount; like the analytics code it then falls back to
// quantity x price. A non-legacy fill without quote_amount is a malformed input.
export function fillQuote(fill){
  if(fill.quote_amount!==null&&fill.quote_amount!==undefined)return D(fill.quote_amount);
  if(Number(fill.legacy_float)===1)return D(fill.delta_quantity).mul(fill.price);
  throw new Qr2Error('QR2_INPUT_INVALID','fill '+fillKey(fill.signal_id,fill.cumulative_quantity)+' has no quote_amount');
}
// RC-Q17: a legacy fill without quote_amount uses quantity x price unrounded and is labelled QUOTE_FROM_PRICE_LEGACY.
export const quoteFromPrice=fill=>(fill.quote_amount===null||fill.quote_amount===undefined)&&Number(fill.legacy_float)===1;
export const targetOf=payload=>{
  let object=null;
  try{object=typeof payload==='string'?JSON.parse(payload||'{}'):payload;}catch{object=null;}
  const target=object?.targetTradeId||null;
  return target?String(target):null;
};

export function validateEpochs(epochs){
  if(!Array.isArray(epochs))throw new Qr2Error('QR2_INPUT_INVALID','epochs must be an array');
  for(const row of epochs){
    if(!row||!QR2_EPOCHS.includes(row.epoch))throw new Qr2Error('QR2_INPUT_INVALID','unknown epoch');
    for(const bound of [row.from,row.to])if(bound!==null&&bound!==undefined&&!Number.isSafeInteger(bound))throw new Qr2Error('QR2_INPUT_INVALID','epoch bound must be an integer or null');
  }
}
function validateBoundary(value,name){
  if(value!==null&&value!==undefined&&!Number.isSafeInteger(value))throw new Qr2Error('QR2_INPUT_INVALID',name+' must be an integer or null');
}
// The epoch of a fill by its received_at (6.2). null = unknown (no row covers it, or more than one does).
export function epochOfFill(receivedAt,epochs){
  const hits=epochs.filter(row=>(row.from==null||receivedAt>=row.from)&&(row.to==null||receivedAt<row.to));
  return hits.length===1?hits[0].epoch:null;
}
// The marker is corroboration only: it is per signal and can be overwritten or absent (section 5).
export function markerCorroboration(marker,epoch){
  if(!marker)return 'ABSENT';
  return QR2_MARKER_EPOCH[marker]===epoch?'AGREES':'DISAGREES';
}

// L1 binding: per signal, BUY fills by cumulative_quantity bind pairwise to its lots by (opened_at, position_id). More lots than
// BUY fills: the surplus lots are ORPHAN_LOT. Fewer lots than BUY fills: the lots bind to the LAST fills (RC-Q17). The lot-table
// cutoff is min(earliest lot opened_at, lotTableBoundary when recorded) (RC-Q17 L1). An unbound BUY received strictly before the
// cutoff is NO_LOT (booked before the lot table; not a failure); an unbound BUY at or after it is LOT_BINDING_MISMATCH
// (SPLIT_NULL), so a lost lot cannot hide as NO_LOT, also when the whole lot table is lost. The entry_price formula follows the
// lot-fee epoch (RC-Q13, option lotFeeBoundary).
export function bindLots(fills,lots,{lotFeeBoundary=null,lotTableBoundary=null}={}){
  validateBoundary(lotFeeBoundary,'lotFeeBoundary');validateBoundary(lotTableBoundary,'lotTableBoundary');
  const bySignalFills=new Map(),bySignalLots=new Map(),bound=new Map(),findings=[];
  const earliestLot=lots.length?Math.min(...lots.map(l=>Number(l.opened_at))):Infinity;
  const cutoff=Math.min(earliestLot,lotTableBoundary??Infinity);
  for(const fill of fills)if(fill.side==='BUY'){
    const key=String(fill.signal_id);
    if(!bySignalFills.has(key))bySignalFills.set(key,[]);
    bySignalFills.get(key).push(fill);
  }
  for(const lot of lots){
    const key=String(lot.entry_signal_id);
    if(!bySignalLots.has(key))bySignalLots.set(key,[]);
    bySignalLots.get(key).push(lot);
  }
  const signals=new Set([...bySignalFills.keys(),...bySignalLots.keys()]);
  for(const signal of signals){
    const buys=(bySignalFills.get(signal)||[]).slice().sort((a,b)=>D(a.cumulative_quantity).cmp(b.cumulative_quantity));
    const owned=(bySignalLots.get(signal)||[]).slice().sort(lotOrder);
    const paired=Math.min(buys.length,owned.length);
    for(let i=0;i<buys.length-paired;i++){
      const fill=buys[i],key=fillKey(fill.signal_id,fill.cumulative_quantity);
      if(Number(fill.received_at)<cutoff)findings.push({check:'R6',code:'NO_LOT',effect:null,symbol:fill.symbol,event_key:key});
      else findings.push({check:'R6',code:'LOT_BINDING_MISMATCH',effect:'SPLIT_NULL',event_key:key,symbol:fill.symbol,field:'lot',expected:'lot row',actual:null});
    }
    for(let i=0;i<paired;i++){
      const fill=buys[buys.length-paired+i],lot=owned[i],key=fillKey(fill.signal_id,fill.cumulative_quantity);
      bound.set(key,lot);
      const quote=fillQuote(fill),withFee=amount(quote.plus(fill.fee_quote).div(fill.delta_quantity)),withoutFee=amount(quote.div(fill.delta_quantity));
      const feeEpoch=lotFeeBoundary===null||lotFeeBoundary===undefined?null:(Number(lot.opened_at)<lotFeeBoundary?'LOT_PRICE_EXCLUDES_FEE':'LOT_PRICE_INCLUDES_FEE');
      const expectedPrice=feeEpoch==='LOT_PRICE_EXCLUDES_FEE'?withoutFee:withFee;
      if(!D(lot.filled_quantity).eq(fill.delta_quantity))findings.push({check:'R6',code:'LOT_BINDING_MISMATCH',effect:'SPLIT_NULL',event_key:key,symbol:fill.symbol,position_id:lot.position_id,field:'filled_quantity',expected:D(fill.delta_quantity).toFixed(),actual:D(lot.filled_quantity).toFixed()});
      if(!D(lot.entry_price).eq(expectedPrice))findings.push({check:'R6',code:feeEpoch===null?'LOT_EPOCH_UNKNOWN':'LOT_BINDING_MISMATCH',effect:'SPLIT_NULL',event_key:key,symbol:fill.symbol,position_id:lot.position_id,field:'entry_price',expected:expectedPrice,actual:D(lot.entry_price).toFixed(),...(feeEpoch?{lot_price_epoch:feeEpoch}:{})});
    }
    for(const lot of owned.slice(paired))findings.push({check:'R6',code:'ORPHAN_LOT',effect:'SPLIT_NULL',event_key:null,symbol:lot.symbol,position_id:lot.position_id});
  }
  return {bound,findings};
}

function buildEvents({fundings,journal,fills}){
  const journalByKey=new Map(),duplicates=[],events=[];
  for(const row of journal){
    const key=fillKey(row.signal_id,row.cumulative_quantity);
    if(journalByKey.has(key)){duplicates.push({check:'R1',code:'RECONCILIATION_FAILED',reason:'DUPLICATE_JOURNAL_KEY',event_key:key});continue;}
    journalByKey.set(key,row);
  }
  const usedJournal=new Set(),seenFills=new Set();
  for(const row of fundings)events.push({kind:'FUNDING',time:Number(row.at),key:fundingKey(row.id),row});
  for(const row of fills){
    const key=fillKey(row.signal_id,row.cumulative_quantity);
    if(seenFills.has(key)){duplicates.push({check:'R1',code:'RECONCILIATION_FAILED',reason:'DUPLICATE_FILL_KEY',event_key:key});continue;}
    seenFills.add(key);
    const paired=journalByKey.get(key)||null;
    if(paired)usedJournal.add(key);
    events.push({kind:'FILL',time:Number(row.received_at),key,row,journal:paired});
  }
  for(const [key,row] of journalByKey)if(!usedJournal.has(key))events.push({kind:'JOURNAL',time:Number(row.at),key,row});
  events.sort((a,b)=>{
    if(a.time!==b.time)return a.time-b.time;
    if(a.kind!==b.kind)return RANK[a.kind]-RANK[b.kind];
    if(a.kind==='FUNDING')return D(a.row.id).cmp(b.row.id);
    return D(a.row.signal_id).cmp(b.row.signal_id)||D(a.row.cumulative_quantity).cmp(b.row.cumulative_quantity);
  });
  events.forEach((event,index)=>{event.index=index;});
  return {events,duplicates};
}

export const ZERO_STATE=Object.freeze({
  cash:'0',f_cash:'0',j_cash:'0',equity_sum:'0',equity_floor:'0',book_equity:'0',position_cost:'0',realized:'0',fees:'0',identity_diff:'0',e0_clamp_total:'0',
  positions:Object.freeze({}),realized_by_symbol:Object.freeze({}),filled_since_flat:Object.freeze({}),unbacked_equity:'0'
});

/**
 * Replays one account in event-time order (funding events before fills at equal time, fills by signal_id and
 * cumulative_quantity; R3c checks the order against commit order). Returns
 * {events, findings, halted, unreplayable_from, lots, final, binding, method}.
 * A closure failure (RT) halts the replay at that fill: no state exists from that fill onward.
 */
export function replayAccount({fundings=[],journal=[],fills=[],lots=[],epochs=[],lotFeeBoundary=null,lotTableBoundary=null}={}){
  validateEpochs(epochs);
  validateBoundary(lotFeeBoundary,'lotFeeBoundary');validateBoundary(lotTableBoundary,'lotTableBoundary');
  for(const fill of fills){
    if(fill.side!=='BUY'&&fill.side!=='SELL')throw new Qr2Error('QR2_INPUT_INVALID','fill side must be BUY or SELL');
    if(!D(fill.delta_quantity).gt(0)||D(fill.fee_quote).lt(0))throw new Qr2Error('QR2_INPUT_INVALID','fill quantity must be positive and fee not negative');
    fillQuote(fill); // a non-legacy fill without quote_amount is QR2_INPUT_INVALID before any event is replayed
  }
  const binding=bindLots(fills,lots,{lotFeeBoundary,lotTableBoundary});
  // RC-Q17 L1: a BUY that bindLots classified as a lost lot is noted LOT_MISSING, never NO_LOT.
  const lostLot=new Set(binding.findings.filter(f=>f.code==='LOT_BINDING_MISMATCH'&&f.field==='lot').map(f=>f.event_key));
  const {events,duplicates}=buildEvents({fundings,journal,fills});
  const findings=[...binding.findings,...duplicates];
  // Running state. Decimals are exact (80 digits); strings are produced once per event.
  // jExpected = the cash movement the fills imply (BUY -(quote+fee), SELL quote-fee). It feeds the identity only, so a journal
  // fault is reported by R1/R2 and not a second time as a broken identity (RI checks the replay arithmetic).
  let fCash=ZERO,jCash=ZERO,jExpected=ZERO,equitySum=ZERO,fees=ZERO,realized=ZERO,e0Clamp=ZERO,unbacked=ZERO;
  const position=new Map(),realizedBySymbol=new Map(),filledSinceFlat=new Map();
  const lotState=new Map();
  for(const lot of lots)lotState.set(lot.position_id,{lot,opened:false,remaining:null});
  const lotsOf=symbol=>[...lotState.values()].filter(l=>l.opened&&l.lot.symbol===symbol);
  const pos=symbol=>position.get(symbol)||{quantity:ZERO,cost:ZERO};
  const unlotted=symbol=>pos(symbol).quantity.minus(lotsOf(symbol).reduce((total,l)=>total.plus(l.remaining),ZERO));
  const snapshot=()=>{
    const positions={};let cost=ZERO;
    for(const [symbol,p] of position){positions[symbol]={quantity:p.quantity.toFixed(),cost:p.cost.toFixed()};cost=cost.plus(p.cost);}
    const cash=fCash.plus(jCash);
    const realizedMap={};for(const [symbol,v] of realizedBySymbol)realizedMap[symbol]=v.toFixed();
    const sinceFlat={};for(const [symbol,v] of filledSinceFlat)sinceFlat[symbol]=v.toFixed();
    return {cash:cash.toFixed(),f_cash:fCash.toFixed(),j_cash:jCash.toFixed(),equity_sum:equitySum.toFixed(),equity_floor:equitySum.plus(jCash).toFixed(),
      book_equity:equitySum.plus(jCash).plus(cost).toFixed(),position_cost:cost.toFixed(),realized:realized.toFixed(),fees:fees.toFixed(),
      identity_diff:fCash.plus(jExpected).plus(cost).minus(fCash.plus(realized)).toFixed(),e0_clamp_total:e0Clamp.toFixed(),positions,realized_by_symbol:realizedMap,filled_since_flat:sinceFlat,
      unbacked_equity:unbacked.toFixed()};
  };
  const out=[];
  let halted=null,unreplayableFrom=null;
  const halt=(event,code,extra={})=>{
    halted={index:event.index,time:event.time,key:event.key,code};
    // LEDGER_RULE_UNREPLAYABLE (RC-Q17): an unknown epoch or a closure failure (RT) at this fill.
    unreplayableFrom={index:event.index,time:event.time,key:event.key,reason:extra.reason||code};
    const finding={check:'RT',code,effect:'RECONCILIATION_FAILED',event_key:event.key,...extra};
    findings.push(finding);
    out.push({index:event.index,kind:event.kind,time:event.time,key:event.key,halted:true,code,state:null,findings:[finding]});
  };
  for(const event of events){
    if(event.kind==='FUNDING'){
      fCash=fCash.plus(event.row.cash_delta);equitySum=equitySum.plus(event.row.equity_delta);
      unbacked=equitySum.minus(fCash);
      out.push({index:event.index,kind:'FUNDING',time:event.time,key:event.key,funding_kind:event.row.kind,cash_delta:D(event.row.cash_delta).toFixed(),equity_delta:D(event.row.equity_delta).toFixed(),findings:[],state:snapshot()});
      continue;
    }
    if(event.kind==='JOURNAL'){
      jCash=jCash.plus(event.row.cash_delta);
      out.push({index:event.index,kind:'JOURNAL',time:event.time,key:event.key,cash_delta:D(event.row.cash_delta).toFixed(),findings:[],state:snapshot()});
      continue;
    }
    const fill=event.row,epoch=epochOfFill(event.time,epochs);
    if(!epoch){
      halt(event,'LEDGER_RULE_UNREPLAYABLE',{reason:'EPOCH_UNKNOWN'});
      break;
    }
    const symbol=fill.symbol,q=D(fill.delta_quantity),quote=fillQuote(fill),fee=D(fill.fee_quote);
    const notes=[],note=(code,extra={})=>{const f={check:'EVENT',code,effect:null,event_key:event.key,symbol,...extra};notes.push(f);findings.push(f);};
    if(quoteFromPrice(fill))note('QUOTE_FROM_PRICE_LEGACY',{amount:quote.toFixed()});
    const p=pos(symbol);
    const unlottedBefore=unlotted(symbol);
    let realizedDelta=ZERO,removedCost=null,expectedAudit=[],consumed=[];
    if(fill.side==='BUY'){
      const cost=p.cost.plus(quote).plus(fee);
      if(cost.decimalPlaces()>18){halt(event,'SCALE_DIVERGENCE',{value:cost.toFixed()});break;}
      position.set(symbol,{quantity:p.quantity.plus(q),cost});
      filledSinceFlat.set(symbol,(filledSinceFlat.get(symbol)||ZERO).plus(q));
      const lot=binding.bound.get(event.key);
      if(lot){const s=lotState.get(lot.position_id);s.opened=true;s.remaining=D(lot.filled_quantity);}
      else note(lostLot.has(event.key)?'LOT_MISSING':'NO_LOT');
    }else{
      if(q.gt(p.quantity)){halt(event,'SELL_EXCEEDS_POSITION',{expected:p.quantity.toFixed(),actual:q.toFixed()});break;}
      // RC-Q14: an E0 fill received before the recorded lot-table boundary ignores targetTradeId, as the ledger booked it.
      const target=epoch==='E0'&&lotTableBoundary!==null&&lotTableBoundary!==undefined&&event.time<lotTableBoundary?null:targetOf(fill.payload);
      let candidates;
      if(target){
        candidates=lotsOf(symbol).filter(l=>l.remaining.gt(0)&&(l.lot.entry_trade_id===target||l.lot.position_id===target));
        if(!candidates.length){halt(event,'TARGET_UNRESOLVED',{target});break;}
      }else candidates=lotsOf(symbol).filter(l=>l.remaining.gt(0));
      candidates.sort((a,b)=>lotOrder(a.lot,b.lot));
      let still=q,allocated=ZERO;
      const takes=new Map();
      for(const c of candidates){
        if(still.lte(0))break;
        const take=c.remaining.lte(still)?c.remaining:still;
        takes.set(c.lot.position_id,take);consumed.push({position_id:c.lot.position_id,take:take.toFixed()});
        allocated=allocated.plus(take.mul(c.lot.entry_price));still=still.minus(take);
      }
      if(target&&still.gt(0)){halt(event,'TARGET_OVERFILL',{target,uncovered:still.toFixed()});break;}
      // LOT_ORDER_AMBIGUOUS (G5): lots with the same opened_at are consumed in position_id order here, the ledger orders by
      // opened_at only. A tie group that is consumed in part is order-dependent.
      const groups=new Map();
      for(const c of candidates){const k=String(c.lot.opened_at);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c);}
      for(const [openedAt,group] of groups){
        if(group.length<2)continue;
        const total=group.reduce((t,c)=>t.plus(c.remaining),ZERO),taken=group.reduce((t,c)=>t.plus(takes.get(c.lot.position_id)||ZERO),ZERO);
        if(taken.gt(0)&&taken.lt(total))note('LOT_ORDER_AMBIGUOUS',{opened_at:Number(openedAt),cost_changes:new Set(group.map(c=>D(c.lot.entry_price).toFixed())).size>1});
      }
      const newQty=p.quantity.minus(q),costBefore=p.cost;
      let removed,cost;
      if(epoch==='E0'){
        if(allocated.gt(0)){
          removed=allocated;
          if(still.gt(0))note('PARTIAL_LOT_COVERAGE',{uncovered:still.toFixed()});
        }else{
          note('NO_LOT_FALLBACK');
          removed=newQty.isZero()?costBefore:D(amount(costBefore.mul(q).div(p.quantity)));
        }
        cost=costBefore.minus(removed);
        if(cost.lt(0)){note('COST_CLAMPED',{amount:cost.neg().toFixed()});e0Clamp=e0Clamp.plus(cost.neg());cost=ZERO;}
        if(cost.decimalPlaces()>18){halt(event,'SCALE_DIVERGENCE',{value:cost.toFixed()});break;}
        if(newQty.isZero()&&cost.gt(0))note('RESIDUAL_COST_AT_FLAT',{amount:cost.toFixed()});
      }else{
        // E1 (a577689) and E2 (current code). E1 has no G1 term.
        if(newQty.isZero())removed=costBefore;
        else if(epoch==='E2'&&still.gt(0)&&allocated.gt(0)){
          const unlottedQty=newQty.plus(still),unlottedCost=costBefore.minus(allocated);
          removed=D(amount(allocated.plus(unlottedCost.mul(still).div(unlottedQty))));
          note('G1_UNLOTTED_CHARGED',{uncovered:still.toFixed()});
        }else if(allocated.gt(0)){
          removed=D(amount(allocated));
          if(still.gt(0))note('PARTIAL_LOT_COVERAGE',{uncovered:still.toFixed()});
        }else{
          removed=D(amount(costBefore.mul(q).div(p.quantity)));
          note('NO_LOT_FALLBACK');
        }
        // Audit rows the ledger of this epoch wrote: expected in the audit table, never read here.
        if(newQty.isZero()&&allocated.gt(0)){
          const difference=epoch==='E2'?(still.isZero()?allocated.minus(costBefore).abs():allocated.minus(costBefore)):allocated.minus(costBefore).abs();
          if(difference.gt('1e-12'))expectedAudit.push('ledger.cost_divergence');
        }
        cost=costBefore.minus(removed);
        if(cost.lt(0)){note('COST_CLAMPED',{amount:cost.neg().toFixed()});expectedAudit.push('ledger.cost_clamped');cost=ZERO;removed=costBefore;}
      }
      removedCost=removed;
      realizedDelta=quote.minus(removed).minus(fee);
      realized=realized.plus(realizedDelta);
      realizedBySymbol.set(symbol,(realizedBySymbol.get(symbol)||ZERO).plus(realizedDelta));
      position.set(symbol,{quantity:newQty,cost});
      if(newQty.isZero())filledSinceFlat.set(symbol,ZERO);
      for(const [id,take] of takes){const s=lotState.get(id);s.remaining=s.remaining.minus(take);}
    }
    fees=fees.plus(fee);
    jExpected=jExpected.plus(fill.side==='BUY'?quote.plus(fee).neg():quote.minus(fee));
    if(event.journal)jCash=jCash.plus(event.journal.cash_delta);
    const unlottedAfter=unlotted(symbol);
    if(unlottedAfter.gt(0)&&!unlottedAfter.eq(unlottedBefore))note('UNLOTTED_QUANTITY',{amount:unlottedAfter.toFixed()});
    out.push({index:event.index,kind:'FILL',time:event.time,key:event.key,epoch,side:fill.side,symbol,marker:fill.ledger_rule||null,marker_check:markerCorroboration(fill.ledger_rule,epoch),
      quantity:q.toFixed(),quote:quote.toFixed(),fee:fee.toFixed(),cash_delta:event.journal?D(event.journal.cash_delta).toFixed():null,
      removed_cost:removedCost?removedCost.toFixed():null,realized_delta:fill.side==='SELL'?realizedDelta.toFixed():null,consumed,expected_audit:expectedAudit,findings:notes,state:snapshot()});
  }
  const finalLots=lots.map(lot=>{
    const s=lotState.get(lot.position_id);
    return {position_id:lot.position_id,symbol:lot.symbol,opened:s.opened,filled_quantity:D(lot.filled_quantity).toFixed(),remaining_quantity:s.opened?s.remaining.toFixed():null,status:s.opened?(s.remaining.gt(0)?'OPEN':'CLOSED'):null};
  });
  const lastGood=[...out].reverse().find(e=>e.state);
  return {method:{lot_method:QR2_METHODS.lot_method,epochs,lot_fee_boundary:lotFeeBoundary,lot_table_boundary:lotTableBoundary},events:out,findings,halted,unreplayable_from:unreplayableFrom,lots:finalLots,final:halted?null:(lastGood?.state||ZERO_STATE),
    last_good_state:lastGood?.state||ZERO_STATE,binding,unlotted:Object.fromEntries([...position.keys()].map(symbol=>[symbol,unlotted(symbol).toFixed()]))};
}

// State at instant t: the state after the last event with event time < t (2.6). available = false once the replay has halted
// at or before t (no state exists from the halting fill onward).
export function stateAt(replay,instant){
  const events=replay.events;
  let low=0,high=events.length-1,found=-1;
  while(low<=high){const mid=(low+high)>>1;if(events[mid].time<instant){found=mid;low=mid+1;}else high=mid-1;}
  if(found<0)return {available:true,event_index:-1,state:ZERO_STATE};
  if(events[found].halted)return {available:false,event_index:found,state:null,reason:events[found].code};
  return {available:true,event_index:found,state:events[found].state};
}

// The lot method ids of the epochs the replayed fills met, for the response header (7.4: "the epochs met").
export const lotMethodsMet=replay=>QR2_EPOCHS.filter(epoch=>replay.events.some(e=>e.kind==='FILL'&&e.epoch===epoch)).map(epoch=>QR2_METHODS.lot_method[epoch]);

// The ledger rule epochs the replayed fills met, for the response header (ledger_rule_epochs).
export const ledgerRuleEpochsMet=replay=>QR2_EPOCHS.filter(epoch=>replay.events.some(e=>e.kind==='FILL'&&e.epoch===epoch));
// Marker corroboration counts over replayed fills (RC-Q17: boundary wins; DISAGREES is information and counted).
export function markerCounts(replay){
  const counts={AGREES:0,DISAGREES:0,ABSENT:0};
  for(const e of replay.events)if(e.kind==='FILL'&&e.marker_check)counts[e.marker_check]++;
  return counts;
}

export const stateQuantity=(state,symbol)=>D(state.positions[symbol]?.quantity??0);
export const openSymbols=state=>Object.entries(state.positions).filter(([,p])=>D(p.quantity).gt(0)).map(([symbol])=>symbol);
export const isFlat=state=>openSymbols(state).length===0;
