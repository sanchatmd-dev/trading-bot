import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Decimal from 'decimal.js';
import {MP_CODES,MP_SAME_BAR_ORDER} from '../src/multi-pine/codes.js';
import {runCombinedOracle,runOracleWithOrder,compareCombined,createCombinedLedger,orderBarIntents,deriveFunnel,sumFunnels,entryOwner,PYTHON_FUNNEL_MAP,pythonFunnelView,
  ORACLE_VERSION,BASELINE_VERSION,CASH_TOLERANCE} from '../src/multi-pine/combined-oracle.js';

/*
 * F11 S2 (pure part). Every series below is a LABELLED ENGINEERING FIXTURE (scripted-signals-v1, mechanics only): synthetic bars and explicit
 * per-member boolean vectors, never a research result. The module under test is pure, so no database, network or Python process is used.
 * Expected numbers are derived by hand in the comments (and re-derived in the test with plain decimal.js), not copied from the module.
 */
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const REFERENCE=path.join(root,'scripts','quant-bridge-reference.mjs');
const D=value=>new Decimal(value);

const T0=1_700_000_040_000; // 2023-11-14T22:14:00Z, a whole minute
const MIN=60_000;
const POLICY=Object.freeze({killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,pauseAfterLossStreak:10000,blockHighVolatility:false,
  maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',maxOpenPositions:1,onePositionPerSymbol:false,capPercentEquitySize:true,
  maxRiskPercent:100,maxOrderNotional:10000,maxDailyNotional:100000000});
const MODEL=Object.freeze({price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'0',risk_percent:'1',version:'paper-close-v1'});
const PAIR=Object.freeze({atr_multiplier:'1',rr:'2'}); // close 100, atr 2: distance 2, SL 98, TP 104 on every flat bar

const bar=(index,over={})=>({time:T0+index*MIN,open:'100',high:'100.5',low:'99.5',close:'100',atr14:'2',...over});
const bars=(count,over={})=>Array.from({length:count},(_,i)=>bar(i,over[i]??{}));
/** Signal vector with BUY at the listed bar indexes and native exit at the others listed. */
const vector=(count,{buy=[],exit=[]}={})=>Array.from({length:count},(_,i)=>[buy.includes(i),exit.includes(i)]);
const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;};
const memberOf=(ordinal,count,signals)=>({ordinal,deployment_id:'dep-'+ordinal,signals:vector(count,signals)});
function input(count,memberSignals,{over={},model={},policy={},start_time=T0,pair=PAIR,equity='1000',cash='1000'}={}){
  return deepFreeze({
    members:memberSignals.map((signals,i)=>memberOf(i+1,count,signals)),bars:bars(count,over),pair:{...pair},model:{...MODEL,...model},policy:{...POLICY,...policy},
    equity,cash,broker:'binance-global',symbol:'BTCUSDT',start_time,same_bar_order:MP_SAME_BAR_ORDER});
}
const at=index=>T0+index*MIN;
const refOf=(ordinal,index)=>'dep-'+ordinal+':'+at(index)+':0';
const decisionsOf=result=>result.ledger.decisions;
const find=(result,ordinal,index,type)=>result.ledger.decisions.find(d=>d.entry_ref===refOf(ordinal,index)&&d.event_type===type);
const sequence=result=>result.ledger.events.map(e=>e.event_type+':'+e.entry_ref.split(':')[0]);

/** Independent re-derivation of the running cash from the booked fills (plain decimal.js, no code of the module). */
function assertCashConservation(result,startCash){
  let cash=D(startCash);
  for(const d of result.ledger.decisions){
    if(d.outcome!=='FILLED')continue;
    cash=d.event_type==='BUY'?cash.minus(d.notional).minus(d.fee):cash.plus(d.notional).minus(d.fee);
    assert.ok(cash.eq(d.cash),'running cash equals the fill cash at '+d.entry_ref+' '+d.event_type);
    assert.ok(D(d.price).mul(d.quantity).eq(d.notional),'notional = price x quantity');
  }
  assert.ok(cash.eq(result.ledger.final_cash),'final cash');
}
function assertFunnelSums(result){
  const bot=result.diagnostics.bot,sum=sumFunnels(result.diagnostics.members);
  assert.deepEqual(bot,sum);
  const d=result.ledger.decisions;
  assert.equal(bot.accepted_buy+bot.capped_buy,d.filter(x=>x.event_type==='BUY'&&x.outcome==='FILLED').length);
  assert.equal(Object.values(bot.rejected_buy).reduce((a,b)=>a+b,0),d.filter(x=>x.event_type==='BUY'&&x.outcome==='REJECTED').length);
  assert.equal(Object.values(bot.exits_filled).reduce((a,b)=>a+b,0),d.filter(x=>x.event_type==='EXIT'&&x.outcome==='FILLED').length);
  assert.equal(Object.values(bot.exits_rejected).reduce((a,b)=>a+b,0),d.filter(x=>x.event_type==='EXIT'&&x.outcome==='REJECTED').length);
}
const run=value=>{const result=runCombinedOracle(value);assertFunnelSums(result);assertCashConservation(result,value.cash);return result;};

/* ---------------------------------------------------------------- stand-in for the Python result */

/** Python writes decimals as `str(Decimal)`/`amount()`: trailing zeros appear. The stand-in reformats every decimal so the tests prove decimal compare. */
const pad=text=>typeof text!=='string'?text:text.includes('.')?text+'00':text+'.00';
const DECIMAL_FIELDS=['sl','tp','quantity','price','notional','fee','cash','cost','realized_r'];
function reformat(record){
  const out={...record};
  for(const field of DECIMAL_FIELDS)if(typeof out[field]==='string')out[field]=pad(out[field]);
  if(out.sizing_adjustment)out.sizing_adjustment={...out.sizing_adjustment,requestedQuantity:pad(out.sizing_adjustment.requestedQuantity),quantity:pad(out.sizing_adjustment.quantity)};
  return out;
}
/**
 * Python-style diagnostics row for one member. Its own names (accepted/capped/rejected/exit_fills/suppressed_buys/skipped_buys/pre_start_intents, intents split
 * into buy and exit totals). Counts that a ledger can show are re-derived here FROM THE LEDGER RECORDS (not copied from the oracle funnel); only the signal-side
 * counts (native, suppressed, skipped) come from the oracle funnel, because no ledger record shows them.
 */
const groupReasons=list=>{const out={};for(const record of list)out[record.reason]=(out[record.reason]??0)+1;return out;};
function pythonRow(result,m){
  const own=record=>entryOwner(record.entry_ref)===m.deployment_id,start=result.meta.start_time;
  const events=result.ledger.events.filter(own),decisions=result.ledger.decisions.filter(own);
  const buyFills=decisions.filter(d=>d.event_type==='BUY'&&d.outcome==='FILLED');
  return {ordinal:m.ordinal,deployment_id:m.deployment_id,native_buy:m.native_buy,native_exit:m.native_exit,
    intents_buy:events.filter(e=>e.event_type==='BUY').length,intents_exit:events.filter(e=>e.event_type==='EXIT').length,
    pre_start_intents:events.filter(e=>start!==null&&e.time<start).length,
    accepted:buyFills.filter(d=>d.sizing_outcome==='ACCEPTED').length,capped:buyFills.filter(d=>d.sizing_outcome==='CAPPED').length,
    rejected:groupReasons(decisions.filter(d=>d.outcome==='REJECTED')),exit_fills:groupReasons(decisions.filter(d=>d.event_type==='EXIT'&&d.outcome==='FILLED')),
    suppressed_buys:m.suppressed_buy.exit_bar,skipped_buys:m.suppressed_buy.no_atr+m.suppressed_buy.invalid_levels};
}
/** Python `bot`: the field-wise sum of the member rows (counts added, reason maps merged). */
function pythonBot(rows){
  const bot={};
  for(const key of ['native_buy','native_exit','intents_buy','intents_exit','pre_start_intents','accepted','capped','suppressed_buys','skipped_buys'])bot[key]=rows.reduce((a,row)=>a+row[key],0);
  for(const key of ['rejected','exit_fills']){bot[key]={};for(const row of rows)for(const [reason,n] of Object.entries(row[key]))bot[key][reason]=(bot[key][reason]??0)+n;}
  return bot;
}
/** Python-like result built from an oracle result: its own formatting and its own diagnostics shape (members as an array, funnel under other names). */
function pythonLike(result){
  const copy=JSON.parse(JSON.stringify(result));
  const rows=copy.diagnostics.members.map(m=>pythonRow(copy,m));
  return {
    ledger:{events:copy.ledger.events.map(reformat),decisions:copy.ledger.decisions.map(reformat),fills:copy.ledger.fills.map(reformat),
      final_cash:pad(copy.ledger.final_cash),position_quantity:pad(copy.ledger.position_quantity),position_cost:pad(copy.ledger.position_cost),open_allocations:copy.ledger.open_allocations},
    diagnostics:{version:'mp-combined-paper-v1',same_bar_order:MP_SAME_BAR_ORDER,members:rows,bot:pythonBot(rows),cross_source_target:0,duplicate_intents:0}
  };
}
const edit=(python,mutate)=>{const copy=structuredClone(python);mutate(copy);return copy;};
function firstFilled(python,type='BUY'){return python.ledger.decisions.findIndex(d=>d.outcome==='FILLED'&&d.event_type===type);}
/** Apply a change to a decision and to the fill that mirrors it. */
function mutateDecision(python,index,change){
  const d=python.ledger.decisions[index];
  change(d);
  const fill=python.ledger.fills.find(f=>f.entry_ref===d.entry_ref&&f.event_type===d.event_type);
  if(fill&&fill!==d)change(fill);
}

/* ---------------------------------------------------------------- scripted cases */

// F3 cash contention. Both members BUY on bar 5, ledger starts at bar 0. Hand derivation (price 100, SL 98, no slippage, fee 10 bps, step 0.001):
//  m1: equity 1000, risk 1% = 10, distance 2, quantity 5, notional 500, fee 0.5, cash 499.5, cost 500.5.
//  m2: equity = 1000 + (499.5 - 1000) + 500.5 = 1000; room = min(1000 - 500.5, 499.5 / 1.001) = 499.000999; quantity 4.990009 -> step 4.990,
//      notional 499, fee 0.499, cash 0.001, cost 999.999. m2 is CAPPED (a policy skip attributed to m2), not an isolation defect.
function f3(){return input(12,[{buy:[5]},{buy:[5]}]);}
test('F3 cash contention: ordinal 1 accepted in full, ordinal 2 capped to the remaining cash, both in ordinal order',()=>{
  const r=run(f3());
  assert.deepEqual(sequence(r),['BUY:dep-1','BUY:dep-2']);
  const a=find(r,1,5,'BUY'),b=find(r,2,5,'BUY');
  assert.equal(a.sizing_outcome,'ACCEPTED');assert.equal(a.quantity,'5');assert.equal(a.cash,'499.5');
  assert.equal(b.sizing_outcome,'CAPPED');assert.equal(b.quantity,'4.99');assert.equal(b.cash,'0.001');assert.equal(b.cost,'999.999');
  assert.equal(b.sizing_adjustment.requestedQuantity,'5');assert.equal(b.sizing_adjustment.quantity,'4.99');
  assert.equal(r.ledger.open_allocations,2);
  assert.deepEqual([r.diagnostics.members[0].accepted_buy,r.diagnostics.members[1].capped_buy],[1,1]);
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});
test('F3 variant: a one-position-per-symbol policy rejects ordinal 2 and creates no allocation; its Pine entry stays and later exits as TARGET_NOT_OPEN',()=>{
  const r=run(input(14,[{buy:[5]},{buy:[5],exit:[10]}],{policy:{onePositionPerSymbol:true}}));
  const b=find(r,2,5,'BUY');
  assert.equal(b.outcome,'REJECTED');assert.equal(b.reason,'Position or pending order already exists for symbol');assert.equal(b.quantity,'0');
  const exit=find(r,2,5,'EXIT');
  assert.equal(exit.outcome,'REJECTED');assert.equal(exit.reason,'TARGET_NOT_OPEN');
  assert.equal(r.ledger.open_allocations,1);
  const m2=r.diagnostics.members[1];
  assert.equal(m2.rejected_buy['Position or pending order already exists for symbol'],1);assert.equal(m2.orphan_exits.refused_entry,1);assert.equal(m2.orphan_exits.warmup_entry,0);
});

// F4 exit-first. Risk 2%: m2 BUY on bar 3 alone: quantity 10 capped by cash 999.000999 -> 9.990, notional 999, fee 0.999, cash 0.001, cost 999.999
//  (entry price (999 + 0.999) / 9.99 = 100.1). Bar 8: m2 native EXIT and m1 BUY together. Exit first: sells 9.99 at 100 = 999, fee 0.999, cash 998.002;
//  the BUY then sees equity 998.002 and cash 998.002: risk 19.96 / 2 = 9.98, room 998.002 / 1.001 = 997.0049 -> 9.97, accepted (capped).
//  BUY first (wrong): room = 1000 - 999.999 = 0.001 -> 0.00001 -> below the 0.001 step -> rejected.
function f4(){return input(14,[{buy:[8]},{buy:[3],exit:[8]}],{model:{risk_percent:'2'}});}
test('F4 exit-first: ordinal 2 EXIT runs before ordinal 1 BUY on the same bar and frees the cash',()=>{
  const r=run(f4());
  const onBar8=r.ledger.events.filter(e=>e.time===at(8)).map(e=>e.event_type+':'+e.entry_ref.split(':')[0]);
  assert.deepEqual(onBar8,['EXIT:dep-2','BUY:dep-1']);
  const exit=find(r,2,3,'EXIT');
  assert.equal(exit.outcome,'FILLED');assert.equal(exit.reason,'NATIVE');assert.equal(exit.quantity,'9.99');assert.equal(exit.cash,'998.002');
  const buy=find(r,1,8,'BUY');
  assert.equal(buy.outcome,'FILLED');assert.equal(buy.quantity,'9.97');assert.equal(buy.sizing_outcome,'CAPPED');
  assert.equal(r.diagnostics.members[0].suppressed_buy.exit_bar,0,'an EXIT of member 2 never suppresses a BUY of member 1');
});
test('F4 mutation: processing in member-major generation order rejects the BUY and the comparison fails',()=>{
  const value=f4(),good=run(value);
  const generation=stepped=>stepped.flatMap(item=>item.intents.map(intent=>({member:item.member,intent})));
  const wrong=runOracleWithOrder(value,generation);
  const buy=find(wrong,1,8,'BUY');
  assert.equal(buy.outcome,'REJECTED');assert.equal(buy.reason,'BELOW_QUANTITY_STEP');
  // generation order is member 1 BUY then member 2 EXIT
  assert.deepEqual(wrong.ledger.events.filter(e=>e.time===at(8)).map(e=>e.event_type),['BUY','EXIT']);
  const record=compareCombined(pythonLike(wrong),good);
  assert.equal(record.matched,false);
  assert.ok(record.differences.event_identity_or_reason>0&&record.differences.accept_reject>0);
});

// F7 shared daily cap. maxTradesPerDay 2. Bar 2 m2 BUY (trade 1), bar 3 m1 BUY (trade 2, the Bot limit), bar 5 m2 BUY refused, bar 8 m2 native EXIT:
//  m2 exits its two Pine entries in descending order: the refused bar-5 entry first (TARGET_NOT_OPEN), then the filled bar-2 entry (accepted, reduce-only,
//  although the Bot already holds 2 trades).
test('F7 shared daily cap: ordinal 1 reaches the Bot limit, ordinal 2 BUY is rejected, ordinal 2 EXIT is still accepted',()=>{
  const r=run(input(14,[{buy:[3]},{buy:[2,5],exit:[8]}],{policy:{maxTradesPerDay:2}}));
  assert.equal(find(r,2,2,'BUY').outcome,'FILLED');assert.equal(find(r,1,3,'BUY').outcome,'FILLED');
  const refused=find(r,2,5,'BUY');
  assert.equal(refused.outcome,'REJECTED');assert.equal(refused.reason,'Maximum trades per day reached');
  const bar8=r.ledger.events.filter(e=>e.time===at(8));
  assert.deepEqual(bar8.map(e=>[e.entry_ref,e.sequence]),[[refOf(2,5),0],[refOf(2,2),1]],'descending traversal with its own sequence numbers');
  assert.equal(find(r,2,5,'EXIT').reason,'TARGET_NOT_OPEN');
  assert.equal(find(r,2,2,'EXIT').outcome,'FILLED');
  assert.equal(r.ledger.open_allocations,1);
  assert.equal(r.diagnostics.members[1].rejected_buy['Maximum trades per day reached'],1);
});

// F8 loss guard (Bot level). pauseAfterLossStreak 1. Bar 3 both BUY; bar 6 both stop out (low 97.4, close 97.5): m1 exits first (Bot not flat), m2 exits
//  last and the Bot is flat with a negative cumulative pnl -> streak 1. Every later BUY of every member is refused; no event resets the guard.
const LOSS_BAR={6:{low:'97.4',close:'97.5'}};
test('F8 loss guard: combined losses trip the Bot guard at Bot flat, entries of every member stop, nothing resets it',()=>{
  const r=run(input(20,[{buy:[3,8,15]},{buy:[3,8,15]}],{policy:{pauseAfterLossStreak:1},over:LOSS_BAR}));
  assert.equal(find(r,1,3,'BUY').outcome,'FILLED');assert.equal(find(r,2,3,'BUY').outcome,'FILLED');
  const e1=find(r,1,3,'EXIT'),e2=find(r,2,3,'EXIT');
  assert.equal(e1.outcome,'FILLED');assert.equal(e1.reason,'SL');assert.equal(e2.outcome,'FILLED');assert.equal(e2.reason,'SL');
  assert.ok(r.ledger.events.findIndex(e=>e.entry_ref===refOf(1,3)&&e.event_type==='EXIT')<r.ledger.events.findIndex(e=>e.entry_ref===refOf(2,3)&&e.event_type==='EXIT'),'ordinal order within the exits');
  for(const index of [8,15])for(const ordinal of [1,2]){
    const d=find(r,ordinal,index,'BUY');
    assert.equal(d.outcome,'REJECTED',ordinal+'@'+index);assert.equal(d.reason,'Trading paused after loss streak');
  }
  assert.equal(r.ledger.position_quantity,'0');assert.equal(r.ledger.open_allocations,0);
  // each refused entry stays in the member's Pine array, so the guard keeps refusing and never manufactures an allocation
  assert.equal(r.diagnostics.members[0].rejected_buy['Trading paused after loss streak'],2);
});
test('F8 (known behaviour): a losing exit of one member does not move the streak while another member holds',()=>{
  // Bar 3 both BUY; bar 6 close 99.6 (no SL at 98, no TP at 104): only m1 has a native exit and loses (exit 99.6 < entry price 100.1). m2 still holds, so the
  // Bot is not flat and the streak stays 0: the BUY of m1 on bar 8 is accepted although pauseAfterLossStreak is 1.
  const r=run(input(14,[{buy:[3,8],exit:[6]},{buy:[3]}],{policy:{pauseAfterLossStreak:1},over:{6:{close:'99.6'}}}));
  assert.equal(find(r,1,3,'EXIT').outcome,'FILLED');
  assert.ok(D(find(r,1,3,'EXIT').realized_r).lt(0));
  assert.equal(find(r,1,8,'BUY').outcome,'FILLED');
});

test('F8 (streak moves only at Bot flat): a winning flat resets the streak and the position pnl restarts at every flat',()=>{
  // pauseAfterLossStreak 2. Trade 1 (bars 2 to 4) loses at the stop: streak 1. Trade 2 (bars 6 to 8) wins about 1.50 USDT on a native exit at 100.5
  // (profit 5 x 100.5 - 5 x 100.1 - 0.5025 = 1.4975): streak 0. If the pnl of trade 1 (about -13.5) were carried over, trade 2 would count as a loss.
  // Trade 3 (bars 10 to 12) loses: streak 1, below the limit, so the BUY on bar 14 is accepted.
  const r=run(input(18,[{buy:[2,6,10,14],exit:[8]}],{policy:{pauseAfterLossStreak:2},over:{4:{low:'97.4',close:'97.5'},8:{close:'100.5'},12:{low:'97.4',close:'97.5'}}}));
  assert.equal(find(r,1,2,'EXIT').reason,'SL');assert.ok(D(find(r,1,2,'EXIT').realized_r).lt(0));
  assert.equal(find(r,1,6,'EXIT').reason,'NATIVE');assert.ok(D(find(r,1,6,'EXIT').realized_r).gt(0));
  assert.equal(find(r,1,10,'EXIT').reason,'SL');
  assert.equal(find(r,1,14,'BUY').outcome,'FILLED');
});

// F13 three members, contention on one bar (hand derivation as F3): m1 5.000 accepted, m2 4.990 capped (cash 0.001 left), m3 room 0.001 / 100 -> 0 steps.
test('F13 three members: deterministic order 1, 2, 3 with accept, cap and reject',()=>{
  const r=run(input(12,[{buy:[5]},{buy:[5]},{buy:[5]}]));
  assert.deepEqual(sequence(r),['BUY:dep-1','BUY:dep-2','BUY:dep-3']);
  assert.deepEqual(decisionsOf(r).map(d=>d.sizing_outcome??d.outcome),['ACCEPTED','CAPPED','REJECTED']);
  assert.equal(find(r,3,5,'BUY').reason,'BELOW_QUANTITY_STEP');
  assert.deepEqual(r.diagnostics.members.map(m=>m.ordinal),[1,2,3]);
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});
test('three-member contention with exits: all EXITs by ordinal, then BUYs by ordinal; a member never has a BUY on its own exit bar',()=>{
  // Bar 2: m1 and m3 BUY (m1 5, m3 4.99). Bar 7: m1 and m3 native EXIT, m2 BUY, m1 and m3 BUY (suppressed on their own exit bar).
  const r=run(input(12,[{buy:[2,7],exit:[7]},{buy:[7]},{buy:[2,7],exit:[7]}]));
  assert.deepEqual(r.ledger.events.filter(e=>e.time===at(7)).map(e=>e.event_type+':'+e.entry_ref.split(':')[0]),['EXIT:dep-1','EXIT:dep-3','BUY:dep-2']);
  assert.equal(find(r,2,7,'BUY').outcome,'FILLED');
  assert.equal(r.diagnostics.members[0].suppressed_buy.exit_bar,1);assert.equal(r.diagnostics.members[2].suppressed_buy.exit_bar,1);assert.equal(r.diagnostics.members[1].suppressed_buy.exit_bar,0);
  assert.equal(find(r,1,2,'EXIT').outcome,'FILLED');assert.equal(find(r,3,2,'EXIT').outcome,'FILLED');
  // m3's entry was capped to 4.99: its EXIT sells exactly that allocation, not the Bot position
  assert.equal(find(r,3,2,'EXIT').quantity,'4.99');
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});
test('swapping the ordinals changes the outcome (the order rule is what decides contention)',()=>{
  const value=f3();
  const swapped=deepFreeze({...structuredClone(value),members:[{...value.members[1],ordinal:1},{...value.members[0],ordinal:2}]});
  const r=runCombinedOracle(swapped);
  assert.equal(find(r,2,5,'BUY').quantity,'5','dep-2 now owns ordinal 1 and takes the full size');
  assert.equal(find(r,1,5,'BUY').sizing_outcome,'CAPPED');
});

/* ---------------------------------------------------------------- warm-up, state and input rules */

test('warm-up: intents before the ledger start stay in events only, Pine entries survive, and their exit is a TARGET_NOT_OPEN orphan',()=>{
  const r=run(input(16,[{buy:[5,12],exit:[10]}],{start_time:at(8)}));
  assert.equal(r.ledger.events.filter(e=>e.event_type==='BUY').length,2);
  assert.ok(r.ledger.events.some(e=>e.entry_ref===refOf(1,5)&&e.event_type==='BUY'));
  assert.ok(!r.ledger.decisions.some(d=>d.entry_ref===refOf(1,5)&&d.event_type==='BUY'));
  const orphan=find(r,1,5,'EXIT');
  assert.equal(orphan.outcome,'REJECTED');assert.equal(orphan.reason,'TARGET_NOT_OPEN');
  const m=r.diagnostics.members[0];
  assert.equal(m.pre_start_intents,1);assert.equal(m.orphan_exits.warmup_entry,1);assert.equal(m.native_buy,2,'native counts cover the warm-up rows too');
  assert.equal(find(r,1,12,'BUY').outcome,'FILLED');
  assert.ok(r.ledger.decisions.every(d=>d.time>=at(8)));
});
test('the oracle is deterministic and never mutates a frozen input',()=>{
  const value=f4();
  assert.deepEqual(runCombinedOracle(value),runCombinedOracle(value));
});
test('input rules: unsupported or missing order, ordinals, ids, member count, signal types and lengths, policy, model and pair',()=>{
  const base=f3();
  const code=(change,expected)=>assert.throws(()=>runCombinedOracle(change(structuredClone(base))),error=>expected?error.code===expected||error.message===expected:true);
  code(v=>{v.same_bar_order='arrival-v1';return v;},MP_CODES.EVENT_ORDER_UNDEFINED);
  code(v=>{delete v.same_bar_order;return v;},MP_CODES.EVENT_ORDER_UNDEFINED);
  code(v=>{v.members[1].ordinal=3;return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.members[1].deployment_id=v.members[0].deployment_id;return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.members=[];return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.members=[...v.members,{...v.members[0],ordinal:3,deployment_id:'x3'},{...v.members[0],ordinal:4,deployment_id:'x4'}];return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.members[0].signals[2]=[1,0];return v;},'BOOLEAN_SIGNAL_REQUIRED');
  code(v=>{v.members[0].signals.pop();return v;},MP_CODES.INPUT_INVALID);
  code(v=>{delete v.policy.maxDailyNotional;return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.model.version='paper-close-v2';return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.model.quantity_step='0';return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.pair.extra='1';return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.pair.rr='0';return v;},MP_CODES.INPUT_INVALID);
  code(v=>{v.bars[3].time=v.bars[2].time;return v;},'NON_MONOTONIC_CLOSED_BARS');
  code(v=>{v.bars[3].low='101';return v;},MP_CODES.INPUT_INVALID);
  // the three accepted signal shapes give one result
  const pairs=runCombinedOracle(base);
  const objects=structuredClone(base);objects.members.forEach(m=>{m.signals=m.signals.map(([buy,native_exit])=>({buy,native_exit}));});
  const columns=structuredClone(base);columns.members.forEach(m=>{m.signals={buy:m.signals.map(s=>s[0]),native_exit:m.signals.map(s=>s[1])};});
  assert.deepEqual(runCombinedOracle(objects).ledger,pairs.ledger);assert.deepEqual(runCombinedOracle(columns).ledger,pairs.ledger);
});
test('the entry reference owner is the key prefix (rsplit of the last two segments)',()=>{
  assert.equal(entryOwner('dep-1:1700000040000:0'),'dep-1');assert.equal(entryOwner('a:b:1:0'),'a:b');
  assert.equal(entryOwner('x'),null);assert.equal(entryOwner(':1:0'),null);assert.equal(entryOwner(5),null);
});

/* ---------------------------------------------------------------- forged producers (counters that must stay 0) */

function forgedLedger(){
  const members=[{ordinal:1,deployment_id:'dep-1'},{ordinal:2,deployment_id:'dep-2'}];
  return {members,ledger:createCombinedLedger({members,model:{...MODEL},policy:{...POLICY},equity:'1000',cash:'1000',broker:'binance-global',symbol:'BTCUSDT',start_time:T0})};
}
const buyIntent=(ref,time)=>({event_type:'BUY',time,entry_ref:ref,sequence:0,reason:null,sl:'98',tp:'104'});
test('cross-source target: an intent whose entry_ref prefix is not its producer raises MP_CROSS_SOURCE_TARGET before any ledger change',()=>{
  const {members,ledger}=forgedLedger();
  assert.throws(()=>ledger.processBar(bar(1),[{member:members[0],intent:buyIntent(refOf(2,1),at(1))}]),error=>error.code===MP_CODES.CROSS_SOURCE_TARGET);
  const out=ledger.result();
  assert.equal(out.ledger.events.length,0);assert.equal(out.ledger.final_cash,'1000');
});
test('duplicate intent: an exact repeat of (deployment, event type, entry_ref) is dropped and counted, with 0 extra effects',()=>{
  const {members,ledger}=forgedLedger();
  const intent=buyIntent(refOf(1,1),at(1));
  ledger.processBar(bar(1),[{member:members[0],intent}]);
  const once=ledger.result();
  ledger.processBar(bar(1),[{member:members[0],intent}]);
  const twice=ledger.result();
  assert.equal(twice.counters.duplicate_intents,1);assert.deepEqual(twice.ledger,once.ledger);
  // the same reference text from the other member is a different effect and fails as a foreign producer
  assert.throws(()=>ledger.processBar(bar(1),[{member:members[1],intent}]),error=>error.code===MP_CODES.CROSS_SOURCE_TARGET);
});
test('the comparison fails when either side reports a non-zero counter',()=>{
  const r=run(f3()),python=pythonLike(r);
  for(const key of ['cross_source_target','duplicate_intents']){
    assert.equal(compareCombined(edit(python,p=>{p.diagnostics[key]=1;}),r).matched,false,key);
    const forged=structuredClone(r);forged.diagnostics[key]=1;
    assert.equal(compareCombined(python,forged).matched,false,key+' on the oracle side');
    assert.equal(compareCombined(edit(python,p=>{delete p.diagnostics[key];}),r).matched,false,key+' missing');
  }
});

/* ---------------------------------------------------------------- comparison: pass conditions and mutations */

const caseResult=()=>run(f3());
test('compare: a Python-formatted result (trailing zeros, own diagnostics shape) matches as decimals and the record has the baseline shape',()=>{
  const r=caseResult(),record=compareCombined(pythonLike(r),r);
  assert.equal(record.version,BASELINE_VERSION);assert.equal(record.evaluator_oracle,ORACLE_VERSION);assert.equal(record.matched,true);
  assert.ok(Object.values(record.differences).every(n=>n===0));
  assert.deepEqual(record.pair,{atr_multiplier:'1',rr:'2'});assert.equal(record.range.rows,12);assert.equal(record.compared_decisions,2);
  assert.deepEqual(record.members,[{ordinal:1,deployment_id:'dep-1'},{ordinal:2,deployment_id:'dep-2'}]);
  assert.equal(record.cash_tolerance,CASH_TOLERANCE);assert.equal(record.final_cash_delta,'0');assert.equal(record.max_quantity_step_delta,'0');
  for(const key of ['oracle_events_hash','oracle_decisions_hash','oracle_ledger_hash','received_events_hash','received_decisions_hash','bars_hash','policy_hash'])assert.match(record[key],/^[0-9a-f]{64}$/,key);
  // the received hash identifies Python-formatted bytes; it differs from the oracle's hash while the decimals match (a hash is never a pass condition)
  assert.notEqual(record.received_decisions_hash,record.oracle_decisions_hash);
  assert.deepEqual(Object.keys(record.differences).sort(),['accept_reject','allocation_targets','cross_source_target','decision_count','decision_identity','duplicate_intents','event_count',
    'event_identity_or_reason','fee','fill_content','fill_count','final_cash','final_position_cost','input_shape','level_ticks','member_funnel','member_tags','notional','open_allocation_count','price_ticks',
    'quantity_steps','realized_r','remaining_quantity','same_bar_order','sizing_outcome_or_reason','sizing_quantities'].sort());
});
test('mutation: one quantity step on a fill fails the comparison and is reported as one venue step',()=>{
  const r=caseResult(),python=pythonLike(r);
  const i=firstFilled(python);
  const bad=edit(python,p=>mutateDecision(p,i,d=>{d.quantity=D(d.quantity).plus('0.001').toFixed();}));
  const record=compareCombined(bad,r);
  assert.equal(record.matched,false);assert.equal(record.differences.quantity_steps,1);assert.equal(record.max_quantity_step_delta,'1');
});
test('mutation: swapped same-bar order of the two BUYs fails the comparison',()=>{
  const r=caseResult(),python=pythonLike(r);
  const swapped=edit(python,p=>{p.ledger.events.reverse();p.ledger.decisions.reverse();p.ledger.fills.reverse();});
  const record=compareCombined(swapped,r);
  assert.equal(record.matched,false);
  assert.ok(record.differences.event_identity_or_reason>0&&record.differences.allocation_targets>0);
  // and a real wrong-order run (ordinals reversed in processing) fails for the outcome too
  const value=f3(),wrong=runOracleWithOrder(value,stepped=>orderBarIntents([...stepped].reverse()));
  const wrongRecord=compareCombined({ledger:wrong.ledger,diagnostics:pythonLike(r).diagnostics},r);
  assert.equal(wrongRecord.matched,false);assert.ok(wrongRecord.differences.accept_reject+wrongRecord.differences.quantity_steps>0||wrongRecord.differences.event_identity_or_reason>0);
});
test('mutation: 0.02 USDT of cash drift fails, 0.01 passes (per entry and final)',()=>{
  const r=caseResult(),python=pythonLike(r);
  const i=firstFilled(python);
  const drift=amount=>edit(python,p=>mutateDecision(p,i,d=>{d.cash=D(d.cash).plus(amount).toFixed();}));
  const bad=compareCombined(drift('0.02'),r);
  assert.equal(bad.matched,false);assert.equal(bad.per_entry_cash_max_delta,'0.02');assert.ok(Object.values(bad.differences).every(n=>n===0),'only the cash bound fails');
  assert.equal(compareCombined(drift('0.01'),r).matched,true);
  assert.equal(compareCombined(drift('-0.02'),r).matched,false);
  const finalDrift=amount=>edit(python,p=>{p.ledger.final_cash=D(p.ledger.final_cash).plus(amount).toFixed();});
  assert.equal(compareCombined(finalDrift('0.02'),r).matched,false);assert.equal(compareCombined(finalDrift('0.02'),r).final_cash_delta,'0.02');
  assert.equal(compareCombined(finalDrift('0.01'),r).matched,true);
  const costDrift=amount=>edit(python,p=>{p.ledger.position_cost=D(p.ledger.position_cost).plus(amount).toFixed();});
  assert.equal(compareCombined(costDrift('0.02'),r).matched,false);assert.equal(compareCombined(costDrift('0.01'),r).matched,true);
});
test('mutation: a wrong member tag fails the comparison (entry_ref prefix, ordinal, deployment id, unknown prefix)',()=>{
  const r=caseResult(),python=pythonLike(r);
  const retag=edit(python,p=>{const i=firstFilled(python);mutateDecision(p,i,d=>{d.entry_ref=d.entry_ref.replace('dep-1','dep-2');});p.ledger.events[0].entry_ref=p.ledger.events[0].entry_ref.replace('dep-1','dep-2');});
  const a=compareCombined(retag,r);assert.equal(a.matched,false);assert.ok(a.differences.allocation_targets>0);
  const ordinals=edit(python,p=>{p.diagnostics.members[0].ordinal=2;p.diagnostics.members[1].ordinal=1;});
  assert.equal(compareCombined(ordinals,r).differences.member_tags>0,true);
  const ids=edit(python,p=>{p.diagnostics.members[0].deployment_id='dep-2';p.diagnostics.members[1].deployment_id='dep-1';});
  assert.equal(compareCombined(ids,r).matched,false);
  const unknown=edit(python,p=>{mutateDecision(p,firstFilled(python),d=>{d.entry_ref='dep-9:'+d.entry_ref.split(':').slice(1).join(':');});});
  const u=compareCombined(unknown,r);assert.equal(u.matched,false);assert.ok(u.differences.member_tags>0);
  // the member list is an array of rows (S1 diagnostics); a deployment_id -> ordinal map carries no funnel and is not a member list
  const map=edit(python,p=>{p.diagnostics.members=Object.fromEntries(p.diagnostics.members.map(m=>[m.deployment_id,m.ordinal]));});
  const m=compareCombined(map,r);assert.equal(m.matched,false);assert.ok(m.differences.member_tags>0&&m.differences.member_funnel>0);
});
test('mutation: each other pass condition fails on its own',()=>{
  const r=caseResult(),python=pythonLike(r),i=firstFilled(python);
  const expectFail=(label,mutate,key)=>{
    const record=compareCombined(edit(python,mutate),r);
    assert.equal(record.matched,false,label);
    if(key)assert.ok(record.differences[key]>0,label+' -> '+key);
  };
  expectFail('fee',p=>mutateDecision(p,i,d=>{d.fee=D(d.fee).plus('0.000001').toFixed();}),'fee');
  expectFail('price of one tick',p=>mutateDecision(p,i,d=>{d.price=D(d.price).plus('0.01').toFixed();}),'price_ticks');
  expectFail('sl level',p=>{p.ledger.events[0].sl=D(p.ledger.events[0].sl).plus('0.01').toFixed();},'level_ticks');
  expectFail('tp level',p=>{p.ledger.events[0].tp=D(p.ledger.events[0].tp).minus('0.01').toFixed();},'level_ticks');
  expectFail('accept to reject',p=>mutateDecision(p,i,d=>{d.outcome='REJECTED';d.reason='Maximum trades per day reached';}),'accept_reject');
  expectFail('reject reason text',p=>mutateDecision(p,1,d=>{d.reason='x';}),'accept_reject');
  expectFail('cap to accept',p=>mutateDecision(p,1,d=>{d.sizing_outcome='ACCEPTED';}),'sizing_outcome_or_reason');
  expectFail('cap reason',p=>mutateDecision(p,1,d=>{d.sizing_adjustment.reason='other';}),'sizing_outcome_or_reason');
  expectFail('cap requested quantity',p=>mutateDecision(p,1,d=>{d.sizing_adjustment.requestedQuantity='6';}),'sizing_quantities');
  expectFail('event removed',p=>{p.ledger.events.pop();},'event_count');
  expectFail('decision removed',p=>{p.ledger.decisions.pop();},'decision_count');
  expectFail('fill removed',p=>{p.ledger.fills.pop();},'fill_count');
  expectFail('event reason',p=>{p.ledger.events[0].reason='SL';},'event_identity_or_reason');
  expectFail('event sequence',p=>{p.ledger.events[0].sequence=1;},'event_identity_or_reason');
  expectFail('decision time',p=>{p.ledger.decisions[0].time+=MIN;},'decision_identity');
  expectFail('position quantity',p=>{p.ledger.position_quantity='9';},'remaining_quantity');
  expectFail('open allocations',p=>{p.ledger.open_allocations=1;},'open_allocation_count');
  expectFail('same bar order label',p=>{p.diagnostics.same_bar_order='arrival-v1';},'same_bar_order');
  expectFail('malformed decimal',p=>mutateDecision(p,i,d=>{d.quantity='abc';}),'quantity_steps');
  // a wrong funnel tag: a capped entry presented as accepted only in the stand-in's own funnel numbers is not enough, the derived funnel catches a flipped outcome
  expectFail('funnel (flipped sizing outcome)',p=>mutateDecision(p,1,d=>{d.sizing_outcome='ACCEPTED';}),'member_funnel');
  expectFail('python native count',p=>{p.diagnostics.members[0].native_buy=7;},'member_funnel');
});
test('compare never throws on a malformed Python result and does not match it',()=>{
  const r=caseResult();
  for(const bad of [null,undefined,{},{ledger:null},{ledger:{events:[],decisions:[],fills:[]}},{ledger:{events:[null],decisions:[null],fills:[null],final_cash:null},diagnostics:{}},'x',[]]){
    let record;
    assert.doesNotThrow(()=>{record=compareCombined(bad,r);});
    assert.equal(record.matched,false);
  }
  assert.ok(compareCombined(null,r).differences.input_shape>0);
});
test('compare: a Python-style funnel in the diagnostics is ignored; the derived funnel needs only ledger records and the start time',()=>{
  const r=run(input(16,[{buy:[5,12],exit:[10]},{buy:[6]}],{start_time:at(8)}));
  const derived=deriveFunnel(r.ledger,at(8));
  assert.deepEqual([...derived.keys()].sort(),['dep-1','dep-2']);
  assert.equal(derived.get('dep-1').pre_start_intents,1);assert.equal(derived.get('dep-1').exits_rejected.TARGET_NOT_OPEN,1);
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});

/* ---------------------------------------------------------------- fix round S2-2: realized R, funnel map, fills, notional, tags, scale, binding */

// B1. Two members overlap. Risk 0.5% of 1000 = 5 per entry, distance 2, quantity 2.5, notional 250, fee 0.25, entry price (250 + 0.25) / 2.5 = 100.1.
//  Bar 2 m1 BUY: cash 749.75, initial risk 5.00. Bar 4 m2 BUY: equity 1000 + (749.75 - 1000) + 250.25 = 1000, same size: cash 499.5, initial risk 5 + 5 = 10.00.
//  Bar 8 m1 native EXIT at 101: notional 252.5, fee 0.2525, profit 252.5 - 2.5 x 100.1 - 0.2525 = 1.9975. The Bot still holds m2, so the initial risk is 10, not 5:
//  R = 1.9975 / 10 = 0.19975 (a per-member risk would give 0.3995). Bar 10 m2 native EXIT at 102: notional 255, fee 0.255, profit 255 - 250.25 - 0.255 = 4.495, R = 0.4495.
//  Final cash 499.5 + 252.5 - 0.2525 + 255 - 0.255 = 1006.4925.
const overlap=()=>input(14,[{buy:[2],exit:[8]},{buy:[4],exit:[10]}],{model:{risk_percent:'0.5'},over:{8:{close:'101',high:'101.5'},10:{close:'102',high:'102.5'}}});
test('B1 two-member overlap: the realized R of each EXIT uses the Bot initial risk (hand derivation)',()=>{
  const r=run(overlap());
  const e1=find(r,1,2,'EXIT'),e2=find(r,2,4,'EXIT');
  assert.equal(e1.quantity,'2.5');assert.equal(e1.notional,'252.5');assert.equal(e1.fee,'0.2525');assert.equal(e1.realized_r,'0.19975');
  assert.equal(e2.notional,'255');assert.equal(e2.fee,'0.255');assert.equal(e2.realized_r,'0.4495');
  assert.equal(r.ledger.final_cash,'1006.4925');assert.equal(find(r,1,2,'BUY').realized_r,'0');
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});
test('B1 mutation: a wrong realized R on one FILLED decision fails the comparison even when every cash value matches',()=>{
  const r=run(overlap()),python=pythonLike(r);
  const i=firstFilled(python,'EXIT');
  // decision only: the fills list still equals the oracle, so only the R count moves
  const bad=compareCombined(edit(python,p=>{p.ledger.decisions[i].realized_r=D(p.ledger.decisions[i].realized_r).plus('0.001').toFixed();}),r);
  assert.equal(bad.matched,false);assert.equal(bad.differences.realized_r,1);assert.equal(bad.max_realized_r_delta,'0.001');
  assert.equal(Object.entries(bad.differences).filter(([key,n])=>n>0).length,1,'nothing else moves: cash, price and quantity are unchanged');
  // the R a per-member risk would book (0.3995 against 0.19975)
  const single=compareCombined(edit(python,p=>mutateDecision(p,i,d=>{d.realized_r='0.3995';})),r);
  assert.equal(single.matched,false);assert.ok(single.differences.realized_r>0);
  // a BUY row with a non-zero R fails as well; a delta inside 1e-12 passes; a malformed R fails
  assert.equal(compareCombined(edit(python,p=>{p.ledger.decisions[0].realized_r='0.001';}),r).differences.realized_r,1);
  assert.equal(compareCombined(edit(python,p=>mutateDecision(p,i,d=>{d.realized_r=D(d.realized_r).plus('0.0000000000001').toFixed();})),r).matched,true);
  assert.equal(compareCombined(edit(python,p=>mutateDecision(p,i,d=>{d.realized_r=D(d.realized_r).plus('0.00000000001').toFixed();})),r).matched,false);
  assert.equal(compareCombined(edit(python,p=>{delete p.ledger.decisions[i].realized_r;}),r).differences.realized_r,1);
});

// B2. Rich funnel case. Ledger starts at bar 4; onePositionPerSymbol; bar 7 has no ATR, bar 9 an ATR so large that SL <= 0.
//  m1 BUY: bar 2 (before the start, intent only), bar 5 (accepted, quantity 5), bar 7 (no_atr, no intent), bar 9 (invalid_levels, no intent), bar 12 on its own native EXIT
//  (suppressed, exit_bar). Bar 12 EXITs run in descending Pine order: bar 5 entry (filled, NATIVE) then bar 2 entry (a warm-up entry, TARGET_NOT_OPEN).
//  m2 BUY on bar 6 while m1 holds: rejected by the one-position rule; its Pine entry never exits.
const RICH=()=>input(20,[{buy:[2,5,7,9,12],exit:[12]},{buy:[6]}],{start_time:at(4),policy:{onePositionPerSymbol:true},over:{7:{atr14:null},9:{atr14:'200'}}});
const ONE_POSITION='Position or pending order already exists for symbol';
const RICH_M1={native_buy:5,native_exit:1,intents_buy:2,intents_exit:2,pre_start_intents:1,accepted:1,capped:0,rejected:{TARGET_NOT_OPEN:1},exit_fills:{NATIVE:1},suppressed_buys:1,skipped_buys:2};
const RICH_M2={native_buy:1,native_exit:0,intents_buy:1,intents_exit:0,pre_start_intents:0,accepted:0,capped:0,rejected:{[ONE_POSITION]:1},exit_fills:{},suppressed_buys:0,skipped_buys:0};
const RICH_BOT={native_buy:6,native_exit:1,intents_buy:3,intents_exit:2,pre_start_intents:1,accepted:1,capped:0,rejected:{TARGET_NOT_OPEN:1,[ONE_POSITION]:1},exit_fills:{NATIVE:1},suppressed_buys:1,skipped_buys:2};
const nonZero=map=>Object.fromEntries(Object.entries(map).filter(([,n])=>n>0));
const viewOf=funnel=>{const view=pythonFunnelView(funnel);return {...view,rejected:nonZero(view.rejected),exit_fills:nonZero(view.exit_fills)};};
test('B2 funnel map: the oracle funnel maps onto the Python diagnostics keys over ALL input rows (hand-derived counts)',()=>{
  const r=run(RICH());
  assert.deepEqual(viewOf(r.diagnostics.members[0]),RICH_M1);assert.deepEqual(viewOf(r.diagnostics.members[1]),RICH_M2);assert.deepEqual(viewOf(r.diagnostics.bot),RICH_BOT);
  assert.deepEqual(Object.keys(PYTHON_FUNNEL_MAP).sort(),Object.keys(RICH_BOT).sort());
  // the label split behind the two Python totals
  assert.deepEqual(r.diagnostics.members[0].suppressed_buy,{exit_bar:1,no_atr:1,invalid_levels:1});
  assert.equal(find(r,1,2,'BUY'),undefined,'the pre-start intent has no decision');
  assert.ok(r.ledger.events.some(e=>e.entry_ref===refOf(1,2)&&e.event_type==='BUY'));
  assert.equal(find(r,1,2,'EXIT').reason,'TARGET_NOT_OPEN');
  // the stand-in (ledger-derived counts) equals the literals, and the comparison accepts it
  const python=pythonLike(r);
  assert.deepEqual(python.diagnostics.members[0],{ordinal:1,deployment_id:'dep-1',...RICH_M1});assert.deepEqual(python.diagnostics.bot,RICH_BOT);
  const record=compareCombined(python,r);assert.equal(record.matched,true,JSON.stringify(record.differences));assert.equal(record.differences.member_funnel,0);
});
test('B2 mutation: every mapped key, missing or off by one, in a member row or in the bot row, fails the comparison',()=>{
  const r=run(RICH()),python=pythonLike(r);
  assert.equal(compareCombined(python,r).matched,true);
  for(const key of Object.keys(PYTHON_FUNNEL_MAP)){
    const bump=value=>typeof value==='number'?value+1:{...value,'a reason that never happened':1};
    for(const [label,mutate] of [
      ['member row missing',p=>{delete p.diagnostics.members[0][key];}],['member row changed',p=>{p.diagnostics.members[1][key]=bump(p.diagnostics.members[1][key]);}],
      ['bot missing',p=>{delete p.diagnostics.bot[key];}],['bot changed',p=>{p.diagnostics.bot[key]=bump(p.diagnostics.bot[key]);}]]){
      const record=compareCombined(edit(python,mutate),r);
      assert.equal(record.matched,false,key+' '+label);assert.ok(record.differences.member_funnel>0,key+' '+label);
      // a missing key is a difference by itself (row or bot against the oracle) and again in the sum check
      if(label.endsWith('missing'))assert.ok(record.differences.member_funnel>=2,key+' '+label+' counted twice');
    }
  }
  assert.equal(compareCombined(edit(python,p=>{delete p.diagnostics.bot;}),r).matched,false,'no bot row');
  assert.equal(compareCombined(edit(python,p=>{p.diagnostics.members.pop();}),r).matched,false,'member row dropped');
  // reason strings are exact, and the old shape (only an accepted count) is no longer enough
  assert.equal(compareCombined(edit(python,p=>{p.diagnostics.members[1].rejected={'position already exists':1};}),r).matched,false);
  assert.equal(compareCombined(edit(python,p=>{p.diagnostics.members=p.diagnostics.members.map(m=>({ordinal:m.ordinal,deployment_id:m.deployment_id,accepted:m.accepted}));}),r).matched,false);
  // errors that cancel in the sum: each row is wrong, the bot row still equals both the oracle bot and the sum of the rows
  const cancel=compareCombined(edit(python,p=>{p.diagnostics.members[0].native_buy+=1;p.diagnostics.members[1].native_buy-=1;}),r);
  assert.equal(cancel.matched,false);assert.equal(cancel.differences.member_funnel,2,'one per wrong row');
  // a zero entry in a reason map is the same as an absent reason
  assert.equal(compareCombined(edit(python,p=>{p.diagnostics.members[1].exit_fills={SL:0};p.diagnostics.bot.exit_fills={NATIVE:1,TP:0};}),r).matched,true);
});
test('B2 window mutation: native counts that skip the warm-up rows (the old live-only window) fail',()=>{
  const r=run(RICH()),python=pythonLike(r);
  const live=edit(python,p=>{p.diagnostics.members[0].native_buy=4;p.diagnostics.bot.native_buy=5;}); // bar 2 is before the start
  assert.equal(compareCombined(live,r).matched,false);
  const intents=edit(python,p=>{p.diagnostics.members[0].intents_buy=1;p.diagnostics.bot.intents_buy=2;}); // intents without the pre-start BUY
  assert.equal(compareCombined(intents,r).matched,false);
});
test('B2 bot row: it must equal the field-wise sum of the Python member rows, not only the oracle Bot funnel',()=>{
  const r=run(RICH()),python=pythonLike(r);
  const forged=structuredClone(r);forged.diagnostics.bot.native_buy+=1; // the oracle side forged to agree with a wrong Python bot
  const bad=edit(python,p=>{p.diagnostics.bot.native_buy+=1;});
  const record=compareCombined(bad,forged);
  assert.equal(record.matched,false);assert.equal(record.differences.member_funnel,1,'only the sum check sees this');
  const mapForged=structuredClone(r);mapForged.diagnostics.bot.exits_rejected.TARGET_NOT_OPEN+=1;
  assert.equal(compareCombined(edit(python,p=>{p.diagnostics.bot.rejected.TARGET_NOT_OPEN+=1;}),mapForged).differences.member_funnel,1);
});

// N2, N3, N4, N1, N5
test('N2 fills content: a wrong fills record fails even when the decisions list matches',()=>{
  const r=caseResult(),python=pythonLike(r);
  const one=mutate=>compareCombined(edit(python,mutate),r);
  for(const [label,mutate] of [
    ['quantity',p=>{p.ledger.fills[0].quantity=D(p.ledger.fills[0].quantity).plus('0.001').toFixed();}],
    ['price',p=>{p.ledger.fills[0].price=D(p.ledger.fills[0].price).plus('0.01').toFixed();}],
    ['fee',p=>{p.ledger.fills[1].fee=D(p.ledger.fills[1].fee).plus('0.000001').toFixed();}],
    ['notional',p=>{p.ledger.fills[0].notional=D(p.ledger.fills[0].notional).plus('0.01').toFixed();}],
    ['entry_ref',p=>{p.ledger.fills[0].entry_ref=p.ledger.fills[1].entry_ref;}],
    ['sizing outcome',p=>{p.ledger.fills[1].sizing_outcome='ACCEPTED';}],
    ['sizing quantity',p=>{p.ledger.fills[1].sizing_adjustment.quantity='4.989';}],
    ['sl',p=>{p.ledger.fills[0].sl=D(p.ledger.fills[0].sl).plus('0.01').toFixed();}],
    ['realized_r',p=>{p.ledger.fills[0].realized_r='0.5';}],
    ['swapped fills',p=>{p.ledger.fills.reverse();}]]){
    const record=one(mutate);
    assert.equal(record.matched,false,label);assert.ok(record.differences.fill_content>0,label+' -> fill_content');
  }
  assert.equal(one(p=>{p.ledger.fills[0].cash=D(p.ledger.fills[0].cash).plus('0.02').toFixed();}).matched,false,'fill cash beyond the bound');
  assert.equal(one(p=>{p.ledger.fills[0].cash=D(p.ledger.fills[0].cash).plus('0.01').toFixed();}).matched,true,'fill cash inside the bound');
  assert.equal(one(p=>{p.ledger.fills=[null,...p.ledger.fills.slice(1)];}).matched,false,'malformed fill record');
});
test('N3 notional: a decision notional that differs by the least amount fails (decimal compare, trailing zeros are fine)',()=>{
  const r=caseResult(),python=pythonLike(r),i=firstFilled(python);
  const record=compareCombined(edit(python,p=>{p.ledger.decisions[i].notional=D(p.ledger.decisions[i].notional).plus('0.00000001').toFixed();}),r);
  assert.equal(record.matched,false);assert.equal(record.differences.notional,1);
  assert.equal(compareCombined(edit(python,p=>{p.ledger.decisions[i].notional='abc';}),r).differences.notional,1);
  assert.equal(compareCombined(python,r).differences.notional,0,'the padded stand-in decimals still compare equal');
});
test('N4 member tags: the member list is sorted by ordinal on both sides before the compare',()=>{
  const r=run(input(12,[{buy:[5]},{buy:[5]},{buy:[5]}])),python=pythonLike(r);
  for(const order of [[2,1,0],[1,2,0],[0,2,1]]){
    const shuffled=edit(python,p=>{p.diagnostics.members=order.map(k=>python.diagnostics.members[k]);});
    const record=compareCombined(shuffled,r);assert.equal(record.matched,true,order.join());assert.equal(record.differences.member_tags,0);
  }
  const forgedOrder=structuredClone(r);forgedOrder.diagnostics.members.reverse(); // the oracle side listed out of order as well
  assert.equal(compareCombined(python,forgedOrder).differences.member_tags,0);
  // sorting does not hide a wrong tag
  assert.ok(compareCombined(edit(python,p=>{p.diagnostics.members[2].ordinal=1;}),r).differences.member_tags>0);
  assert.ok(compareCombined(edit(python,p=>{p.diagnostics.members[0].deployment_id='dep-7';}),r).differences.member_tags>0);
});
test('N1 model scale: step + tick + fee bps decimals + 4 above 18 are refused with MP_INPUT_INVALID, 18 is accepted',()=>{
  const over=(model)=>runCombinedOracle(input(10,[{buy:[3]}],{model}));
  assert.doesNotThrow(()=>over({quantity_step:'0.00000001',price_tick:'0.000001',fee_bps:'0'}),'8 + 6 + 0 + 4 = 18');
  assert.throws(()=>over({quantity_step:'0.00000001',price_tick:'0.0000001',fee_bps:'0'}),error=>error.code===MP_CODES.INPUT_INVALID,'8 + 7 + 0 + 4 = 19');
  assert.throws(()=>over({quantity_step:'0.0001',price_tick:'0.01',fee_bps:'10.123456789012'}),error=>error.code===MP_CODES.INPUT_INVALID,'4 + 2 + 12 + 4 = 22');
  assert.doesNotThrow(()=>over({quantity_step:'0.0001',price_tick:'0.01',fee_bps:'10.5'}));
});
test('N5 binding: an optional {run_id, contract_hash} is copied into the record and changes no ledger value',()=>{
  const base=f3(),binding={run_id:'run-1',contract_hash:'a'.repeat(64)};
  const plain=runCombinedOracle(base),bound=runCombinedOracle({...base,binding});
  assert.deepEqual(bound.ledger,plain.ledger);assert.deepEqual(bound.diagnostics,plain.diagnostics);
  const record=compareCombined(pythonLike(bound),bound);
  assert.deepEqual(record.binding,binding);assert.equal(record.matched,true);
  assert.equal(compareCombined(pythonLike(plain),plain).binding,null);
  assert.equal(compareCombined(pythonLike(bound),bound).oracle_ledger_hash,compareCombined(pythonLike(plain),plain).oracle_ledger_hash,'the binding is not part of the ledger identity');
  for(const bad of [{run_id:'r'},{contract_hash:'h'},{run_id:'',contract_hash:'h'},{run_id:'r',contract_hash:5},{run_id:'r',contract_hash:'h',extra:1},'x',[]])
    assert.throws(()=>runCombinedOracle({...base,binding:bad}),error=>error.code===MP_CODES.INPUT_INVALID,JSON.stringify(bad));
});

// Tester gaps. G1 daily loss guard: m1 BUY bar 2 (quantity 5, entry price 100.1, initial risk 10); bar 4 stop out at close 97.5: notional 487.5, fee 0.4875,
//  profit 487.5 - 500.5 - 0.4875 = -13.4875, R = -1.34875. A BUY on bar 8 is refused when maxDailyLossR <= 1.34875 (the guard is <= -limit), accepted above.
const lossCase=limit=>input(14,[{buy:[2,8]}],{policy:{maxDailyLossR:limit},over:{4:{low:'97.4',close:'97.5'}}});
test('G1 maxDailyLossR binds: a BUY after the day loses past the limit is refused, at the exact boundary too, and a looser limit accepts',()=>{
  const r=run(lossCase(1));
  assert.equal(find(r,1,2,'EXIT').realized_r,'-1.34875');
  const refused=find(r,1,8,'BUY');
  assert.equal(refused.outcome,'REJECTED');assert.equal(refused.reason,'Maximum daily loss reached');
  assert.equal(find(run(lossCase(1.34875)),1,8,'BUY').reason,'Maximum daily loss reached','R equal to the limit trips the guard');
  assert.equal(find(run(lossCase(1.34876)),1,8,'BUY').outcome,'FILLED','a hair above the loss does not');
  assert.equal(find(run(lossCase(2)),1,8,'BUY').outcome,'FILLED');
  const record=compareCombined(pythonLike(r),r);assert.equal(record.matched,true);
  assert.equal(r.diagnostics.members[0].rejected_buy['Maximum daily loss reached'],1);
});
// G2. maxTradesPerDay 3, onePositionPerSymbol. Bar 2 m1 BUY (trade 1). Bar 4 m2 BUY refused (position exists): a refusal is not a trade. Bar 6 m1 EXIT (trade 2: exits count).
//  Bar 8 m2 BUY filled (trade 3: it would be refused if the bar 4 refusal had counted). Bar 10 m1 BUY refused by the cap (3 >= 3), the cap check runs before the position rule.
test('G2 a refusal before the daily cap does not consume a trade, an accepted EXIT does, and the cap then binds',()=>{
  const r=run(input(14,[{buy:[2,10],exit:[6]},{buy:[4,8]}],{policy:{maxTradesPerDay:3,onePositionPerSymbol:true}}));
  assert.equal(find(r,1,2,'BUY').outcome,'FILLED');
  assert.equal(find(r,2,4,'BUY').reason,ONE_POSITION);
  assert.equal(find(r,1,2,'EXIT').outcome,'FILLED');
  assert.equal(find(r,2,8,'BUY').outcome,'FILLED');
  const last=find(r,1,10,'BUY');
  assert.equal(last.outcome,'REJECTED');assert.equal(last.reason,'Maximum trades per day reached');
  assert.equal(r.diagnostics.members[1].rejected_buy[ONE_POSITION],1);
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});
test('G3 warm-up boundary: an intent exactly on the start bar is a decision, one bar earlier is not, and native counts cover the warm-up',()=>{
  const r=run(input(12,[{buy:[3,4],exit:[2]}],{start_time:at(4)}));
  assert.deepEqual(r.ledger.events.map(e=>e.time),[at(3),at(4)]);
  assert.deepEqual(r.ledger.decisions.map(d=>[d.time,d.event_type,d.outcome]),[[at(4),'BUY','FILLED']]);
  const m=r.diagnostics.members[0];
  assert.equal(m.native_buy,2);assert.equal(m.native_exit,1,'the native EXIT on bar 2 counts although no entry is open');
  assert.equal(m.intents_buy,2);assert.equal(m.pre_start_intents,1);
  assert.deepEqual(viewOf(m),{native_buy:2,native_exit:1,intents_buy:2,intents_exit:0,pre_start_intents:1,accepted:1,capped:0,rejected:{},exit_fills:{},suppressed_buys:0,skipped_buys:0});
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
  // without a start the same series has no pre-start intent
  assert.equal(run(input(12,[{buy:[3,4],exit:[2]}],{start_time:null})).diagnostics.members[0].pre_start_intents,0);
});
test('G4 suppression labels: no_atr, invalid_levels and exit_bar are told apart (exit bar wins over a missing ATR)',()=>{
  const r=run(input(14,[{buy:[3,6]},{buy:[2,9],exit:[9]}],{over:{3:{atr14:null},6:{atr14:'200'},9:{atr14:null}}}));
  assert.deepEqual(r.diagnostics.members[0].suppressed_buy,{exit_bar:0,no_atr:1,invalid_levels:1});
  assert.deepEqual(r.diagnostics.members[1].suppressed_buy,{exit_bar:1,no_atr:0,invalid_levels:0});
  assert.equal(r.ledger.events.filter(e=>e.entry_ref.startsWith('dep-1:')).length,0,'a suppressed or skipped BUY makes no intent');
  assert.deepEqual([viewOf(r.diagnostics.members[0]).skipped_buys,viewOf(r.diagnostics.members[0]).suppressed_buys],[2,0]);
  assert.deepEqual([viewOf(r.diagnostics.members[1]).skipped_buys,viewOf(r.diagnostics.members[1]).suppressed_buys],[0,1]);
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});
// G5. Equity 2000 and cash 1000: risk 1% of 2000 = 20, requested quantity 10 (notional 1000 + fee 1 exceeds the cash), capped to cash 1000 / 1.001 = 999.000999 -> 9.990:
//  notional 999, fee 0.999, cash 0.001, cost 999.999. With equity = cash = 1000 the same BUY is the full 5.
test('G5 equity different from cash: the risk is sized on the equity and capped by the cash',()=>{
  const r=run(input(10,[{buy:[3]}],{equity:'2000',cash:'1000'})),b=find(r,1,3,'BUY');
  assert.equal(b.sizing_outcome,'CAPPED');assert.equal(b.quantity,'9.99');assert.equal(b.sizing_adjustment.requestedQuantity,'10');
  assert.equal(b.notional,'999');assert.equal(b.fee,'0.999');assert.equal(b.cash,'0.001');assert.equal(b.cost,'999.999');
  assert.equal(find(run(input(10,[{buy:[3]}],{equity:'1000',cash:'1000'})),1,3,'BUY').quantity,'5');
  assert.equal(compareCombined(pythonLike(r),r).matched,true);
});

/* ---------------------------------------------------------------- one-member equality with scripts/quant-bridge-reference.mjs */

function lcg(seed){let state=seed;return()=>{state=(state*1103515245+12345)%2147483648;return state/2147483648;};}
/** Deterministic synthetic series: random walk, bars 1 minute apart from T0, crossing the UTC day boundary, with ATR proportional to price. */
function series(count,seed,{buyRate=0.06,exitRate=0.03}={}){
  const random=lcg(seed),rows=[],buy=[],exit=[];
  let price=30000;
  for(let i=0;i<count;i++){
    const open=price,move=(random()-0.5)*120;
    const close=Math.max(1000,open+move);
    const high=Math.max(open,close)+random()*30,low=Math.min(open,close)-random()*30;
    price=close;
    rows.push({time:T0+i*MIN,open:open.toFixed(2),high:high.toFixed(2),low:low.toFixed(2),close:close.toFixed(2),atr14:i<14?null:(close*0.004).toFixed(2)});
    buy.push(random()<buyRate);exit.push(random()<exitRate);
  }
  return {rows,buy,exit};
}
function referenceReplay(request){
  const out=execFileSync(process.execPath,[REFERENCE],{input:JSON.stringify({operation:'replay',...request}),encoding:'utf8',cwd:root,maxBuffer:64*1024*1024});
  return JSON.parse(out);
}
const STRESS={...MODEL,fee_bps:'20',slippage_bps:'2',quantity_step:'0.00001',risk_percent:'0.1'};
const REAL_MODEL={...MODEL,slippage_bps:'10',quantity_step:'0.00001',risk_percent:'0.1'};
// risk 0.1% of 10000 USDT over a ~0.8% stop is about 1250 USDT per entry, so several entries are open together and the budget, caps and guards bind.
const ONE_CASES=[
  {name:'M1-like defaults at pair 2/1.5',pair:{atr_multiplier:'2',rr:'1.5'},model:REAL_MODEL,policy:{},seed:11},
  {name:'M2-like at pair 1/3',pair:{atr_multiplier:'1',rr:'3'},model:REAL_MODEL,policy:{},seed:23},
  {name:'STRESS model (fee and slippage x2)',pair:{atr_multiplier:'2',rr:'1.5'},model:{...REAL_MODEL,fee_bps:'20',slippage_bps:'20'},policy:{},seed:11},
  {name:'cap-heavy: risk 1% sizes every entry to the whole cash',pair:{atr_multiplier:'2',rr:'1.5'},model:{...REAL_MODEL,risk_percent:'1'},policy:{},seed:11,expect:['BELOW_QUANTITY_STEP']},
  {name:'daily trade cap and daily notional',pair:{atr_multiplier:'1',rr:'2'},model:REAL_MODEL,policy:{maxTradesPerDay:6,maxDailyNotional:6000},seed:5,expect:['Maximum trades per day reached']},
  {name:'loss-streak pause',pair:{atr_multiplier:'0.5',rr:'0.8'},model:REAL_MODEL,policy:{pauseAfterLossStreak:2},seed:31,expect:['Trading paused after loss streak']},
  {name:'one position per symbol, order cap and risk cap',pair:{atr_multiplier:'1.5',rr:'2'},model:STRESS,policy:{onePositionPerSymbol:true,maxOrderNotional:300,maxRiskPercent:2},seed:41,
    expect:['Position or pending order already exists for symbol']},
  {name:'high-volatility block',pair:{atr_multiplier:'1',rr:'2'},model:REAL_MODEL,policy:{blockHighVolatility:true,maxVolatilityPercent:0.25},seed:61,expect:['High volatility block is active']},
  {name:'ledger start after warm-up with orphan exits',pair:{atr_multiplier:'1',rr:'2'},model:REAL_MODEL,policy:{},seed:53,startAfter:60}
];
let aggregate={fills:0,rejects:0,capped:0,orphan:0,exits:0,days:new Set()};
for(const c of ONE_CASES){
  test('one-member equality with scripts/quant-bridge-reference.mjs replay: '+c.name,()=>{
    const count=420,s=series(count,c.seed),start_time=c.startAfter?T0+c.startAfter*MIN:undefined;
    const value=deepFreeze({members:[{ordinal:1,deployment_id:'dep-solo',signals:s.rows.map((_,i)=>[s.buy[i],s.exit[i]])}],bars:s.rows,pair:c.pair,model:c.model,policy:{...POLICY,...c.policy},
      equity:'10000',cash:'10000',broker:'binance-global',symbol:'BTCUSDT',start_time,same_bar_order:MP_SAME_BAR_ORDER});
    const oracle=runCombinedOracle(value);
    const reference=referenceReplay({deployment_id:'dep-solo',multiplier:Number(c.pair.atr_multiplier),rr:Number(c.pair.rr),model:c.model,policy:{...POLICY,...c.policy},equity:'10000',cash:'10000',
      broker:'binance-global',symbol:'BTCUSDT',start_time,bars:s.rows.map((b,i)=>({...b,buy:s.buy[i],native_exit:s.exit[i]}))});
    assert.deepEqual(JSON.parse(JSON.stringify(oracle.ledger)),reference,'byte-equal ledger');
    assertCashConservation(oracle,'10000');assertFunnelSums(oracle);
    const fills=oracle.ledger.fills;
    for(const f of fills)aggregate.days.add(new Date(f.time).toISOString().slice(0,10));
    aggregate.fills+=fills.length;aggregate.rejects+=oracle.ledger.decisions.length-fills.length;aggregate.capped+=fills.filter(f=>f.sizing_outcome==='CAPPED').length;
    aggregate.orphan+=oracle.ledger.decisions.filter(d=>d.reason==='TARGET_NOT_OPEN').length;aggregate.exits+=fills.filter(f=>f.event_type==='EXIT').length;
    const reasons=new Set(oracle.ledger.decisions.map(d=>d.reason));
    for(const reason of c.expect??[])assert.ok(reasons.has(reason),'the series reaches '+reason);
    assert.equal(compareCombined({ledger:reference,diagnostics:pythonLike(oracle).diagnostics},oracle).matched,true,'the reference output is a valid comparison input');
  });
}
test('the one-member equality cases exercise fills, exits, caps, rejections and orphan exits',()=>{
  assert.ok(aggregate.fills>40,'fills '+aggregate.fills);assert.ok(aggregate.exits>15,'exits '+aggregate.exits);assert.ok(aggregate.rejects>5,'rejections '+aggregate.rejects);
  assert.ok(aggregate.capped>0,'capped '+aggregate.capped);assert.equal(aggregate.days.size,2,'fills on both sides of the UTC day boundary');assert.ok(aggregate.orphan>0,'orphan exits '+aggregate.orphan);
});
test('the one-member oracle does not depend on the ordinal sort: reversing the order function leaves the one-member ledger unchanged',()=>{
  const s=series(300,77),value=deepFreeze({members:[{ordinal:1,deployment_id:'solo',signals:s.rows.map((_,i)=>[s.buy[i],s.exit[i]])}],bars:s.rows,pair:{atr_multiplier:'1',rr:'2'},model:REAL_MODEL,
    policy:{...POLICY},equity:'10000',cash:'10000',broker:'binance-global',symbol:'BTCUSDT',start_time:T0,same_bar_order:MP_SAME_BAR_ORDER});
  assert.deepEqual(runCombinedOracle(value).ledger,runOracleWithOrder(value,stepped=>orderBarIntents([...stepped].reverse())).ledger);
});

/* ---------------------------------------------------------------- larger multi-member runs: invariants and self-consistency */

test('two and three member synthetic runs keep every ledger invariant and never book a foreign target',()=>{
  for(const [members,seed] of [[2,101],[3,202]]){
    const s=Array.from({length:members},(_,k)=>series(400,seed+k,{buyRate:0.05,exitRate:0.025}));
    const value=deepFreeze({members:s.map((x,k)=>({ordinal:k+1,deployment_id:'m'+(k+1),signals:x.rows.map((_,i)=>[x.buy[i],x.exit[i]])})),bars:s[0].rows,pair:{atr_multiplier:'1',rr:'2'},model:REAL_MODEL,
      policy:{...POLICY,maxTradesPerDay:40},equity:'10000',cash:'10000',broker:'binance-global',symbol:'BTCUSDT',start_time:T0+30*MIN,same_bar_order:MP_SAME_BAR_ORDER});
    const r=run(value);
    assert.equal(r.diagnostics.cross_source_target,0);assert.equal(r.diagnostics.duplicate_intents,0);
    for(const d of r.ledger.decisions)assert.ok(['m1','m2','m3'].includes(entryOwner(d.entry_ref)));
    // per bar, every EXIT precedes every BUY and each class is in ascending ordinal
    const byTime=new Map();
    for(const e of r.ledger.events){const list=byTime.get(e.time)??[];list.push(e);byTime.set(e.time,list);}
    for(const list of byTime.values()){
      const kinds=list.map(e=>e.event_type),firstBuy=kinds.indexOf('BUY');
      if(firstBuy>=0)assert.ok(kinds.slice(firstBuy).every(k=>k==='BUY'),'no EXIT after a BUY on a bar');
      for(const type of ['EXIT','BUY']){const owners=list.filter(e=>e.event_type===type).map(e=>entryOwner(e.entry_ref));assert.deepEqual(owners.filter((o,i)=>owners.indexOf(o)===i),[...owners.filter((o,i)=>owners.indexOf(o)===i)].sort());}
    }
    // every open allocation of the final book is a filled BUY without a filled EXIT
    const open=new Set(r.ledger.fills.filter(f=>f.event_type==='BUY').map(f=>f.entry_ref));
    for(const f of r.ledger.fills.filter(x=>x.event_type==='EXIT'))open.delete(f.entry_ref);
    assert.equal(open.size,r.ledger.open_allocations);
    assert.ok(r.ledger.fills.length>30,'the run is not trivial: '+r.ledger.fills.length);
    assert.equal(compareCombined(pythonLike(r),r).matched,true);
  }
});

/* ---------------------------------------------------------------- purity and isolation of the module itself */

test('the module is pure, imports only the production decision functions, and names none of the forbidden writers',()=>{
  const code=fs.readFileSync(path.join(root,'src','multi-pine','combined-oracle.js'),'utf8');
  const strip=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  const body=strip(code);
  const imports=[...body.matchAll(/^import\b[^'"]*from\s*'([^']+)'/gm)].map(m=>m[1]).sort();
  assert.deepEqual(imports,['../money.js','../pine-bridge/contract.js','../pine-bridge/source.js','../postgres/pine-bridge-execution.js','../postgres/risk.js','./codes.js']);
  assert.ok(/import \{evaluateRisk\} from '..\/postgres\/risk.js'/.test(body)&&/import \{roundBridgeOrder\} from/.test(body));
  for(const forbidden of [/prepareBridgeExecution\s*\(/,/\bfs\b/,/node:/,/Date\.now/,/Math\.random/,/\bprocess\b/,/\bfetch\b/,/setTimeout|setInterval/,/\brequire\s*\(/,/\bimport\s*\(/,/child_process/,/recordExecution/,/run-contract|mp-run-store/])
    assert.ok(!forbidden.test(body),String(forbidden));
  assert.ok(!/\bnew Date\(\)/.test(body),'no clock');
});
const own=(map,key,value)=>{Object.defineProperty(map,key,{value,enumerable:true,configurable:true,writable:true});};
test('count maps keyed by Python reason strings: __proto__, constructor and toString are plain own keys',()=>{
  const r=run(RICH()),python=pythonLike(r);
  // zero entries are the same as absent ones, including through the member -> Bot sum
  const zeros=edit(python,p=>{
    for(const row of [...p.diagnostics.members,p.diagnostics.bot])for(const key of ['rejected','exit_fills'])
      for(const reason of ['__proto__','constructor','toString'])own(row[key],reason,0);
  });
  assert.ok(Object.hasOwn(zeros.diagnostics.bot.rejected,'__proto__'),'fixture carries an own __proto__ key');
  const same=compareCombined(zeros,r);assert.equal(same.matched,true,JSON.stringify(same.differences));
  // a hostile key with a count is a reason the oracle never produced: member row and Bot row both differ
  for(const reason of ['__proto__','constructor','toString'])for(const key of ['rejected','exit_fills']){
    const hostile=edit(python,p=>{for(const row of [p.diagnostics.members[1],p.diagnostics.bot])own(row[key],reason,1);});
    assert.equal(compareCombined(hostile,r).matched,false,reason+' '+key);
  }
  // a count under a hostile key in one member row only
  const split=edit(python,p=>{own(p.diagnostics.members[0].rejected,'constructor',1);});
  assert.equal(compareCombined(split,r).matched,false,'constructor count in a member row, not in the Bot row');
  // the Node side counts the same reasons as own keys
  const decisions=['__proto__','constructor','toString'].flatMap(reason=>[
    {event_type:'BUY',outcome:'REJECTED',reason,entry_ref:refOf(1,3)},{event_type:'EXIT',outcome:'REJECTED',reason,entry_ref:refOf(1,3)},
    {event_type:'EXIT',outcome:'FILLED',reason,entry_ref:refOf(1,3)}]);
  const funnel=deriveFunnel({events:[],decisions},null).get('dep-1');
  for(const reason of ['__proto__','constructor','toString'])for(const key of ['rejected_buy','exits_rejected','exits_filled'])
    assert.equal(Object.getOwnPropertyDescriptor(funnel[key],reason)?.value,1,key+' '+reason);
  assert.equal(Object.keys(funnel.rejected_buy).join(),'__proto__,constructor,toString');
  // the Bot-level sum keeps them too
  const bot=sumFunnels([funnel,funnel]);
  assert.equal(Object.getOwnPropertyDescriptor(bot.rejected_buy,'__proto__')?.value,2);assert.equal(bot.exits_filled.constructor,2);
});
