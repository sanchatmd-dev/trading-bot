import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {D,amount} from '../src/money.js';
import {ledgerMethods} from '../src/postgres/ledger.js';
import {QR2_METHODS,QR2_PRICE_POLICY,QR2_WEEK_LABEL,round12} from '../src/portfolio/qr2-constants.js';
import {resolvePrice,valuePosition,priceReference,verifyBarRow} from '../src/portfolio/qr2-price.js';
import {replayAccount,bindLots,stateAt,epochOfFill,lotMethodsMet,ledgerRuleEpochsMet,markerCounts} from '../src/portfolio/qr2-replay.js';
import {legacySeeds,navSeeded,costSeeded,runGates,checkR1,checkR4,checkIdentity,checkLedgerInvariants,checkCommitOrder,
  checkRowScope,checkCrossViewKeys,effectsOf,reconciliationBlocks,intersectsSpan,splitNullFor,worstStatus,unbackedEquityLine,checkR13,checkR6} from '../src/portfolio/qr2-checks.js';
import {navAt,clampCumulativeNull,exposure,flowsIn,moneyPnl,twr,modifiedDietz,gridPoints,rangePerformance,applySplitNull,accountStatus} from '../src/portfolio/qr2-returns.js';
import {periodWindow,customWindow,resolveRange,allTimeWindow,firstFundingAt} from '../src/portfolio/qr2-periods.js';
import {numberField,buildHeader,validateResponse,inputsHash,rowsDigest,auditDedupKey,selectAuditKeys} from '../src/portfolio/qr2-labels.js';
import {frozenLedgerE0} from './fixtures/qr2-ledger-epochs/record-execution-b9d19e3-e0.js';
import {frozenLedgerE1} from './fixtures/qr2-ledger-epochs/record-execution-a577689-e1.js';

// QR-2 S1 pure library (docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md, section 13 unit items 1-10 and 12). Expected values are
// hand-computed literals (derivations in the comments); the exception is the parity tests, whose references are the real ledger
// code of this tree (E2) and the frozen read-only recordExecution copies of b9d19e3 (E0) and a577689 (E1). Fixture hashes use an
// independent canonical-JSON implementation, not the code under test. Root rulings RC-Q1 to RC-Q19 (contract section 15) are
// pinned in the "fix round" blocks near the end (round 3 rulings T1-T9 in the last one); only the four S2/S4 items stay todo.

const sortedJson=v=>Array.isArray(v)?'['+v.map(sortedJson).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+sortedJson(v[k])).join(',')+'}':JSON.stringify(v);
const sha=text=>createHash('sha256').update(text).digest('hex');
const B=1790812800000; // 2026-10-01T00:00:00Z
const m=n=>B+n*60000;

/* ------------------------------------------------------------------ fixture builders */

function barRow(barTime,close,{retrievedAt,open,high,low,timeOverride}={}){
  const bar={time:timeOverride??barTime,open:String(open??close),high:String(high??close),low:String(low??close),close:String(close),volume:'1',atr14:'1',price_tick:'0.01',quantity_step:'0.00001'};
  return {broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',bar_time:barTime,bar,content_hash:sha(sortedJson(bar)),
    provenance:retrievedAt===undefined?{profile:'closed-ohlcv-atr14-v1'}:{profile:'closed-ohlcv-atr14-v1',retrieved_at:retrievedAt}};
}
const fund=(id,at,equity,cash,kind='CONFIGURATION')=>({id,user_id:'u1',broker:'binance-global',at,equity_delta:equity,cash_delta:cash,kind});
// One fill with its journal row and optional lot. cash and lot price are literals chosen by the case.
function trade(o){
  const cum=o.cum??o.qty,symbol=o.symbol??'BTCUSDT',tradeId=o.trade??'T'+o.s;
  const f={signal_id:o.s,cumulative_quantity:cum,delta_quantity:o.qty,price:o.price??'1',fee_quote:o.fee??'0',quote_amount:o.quote,received_at:o.at,legacy_float:o.legacy??0,side:o.side,symbol,trade_id:tradeId,payload:o.payload??'{}',ledger_rule:o.marker,user_id:'u1',broker:'binance-global',execution_mode:'PAPER'};
  const j=o.nojournal?null:{signal_id:o.s,cumulative_quantity:cum,cash_delta:o.cash,at:o.jat??o.at,user_id:'u1',broker:'binance-global'};
  const l=o.lot?{position_id:o.lot.id,entry_signal_id:o.s,entry_trade_id:tradeId,filled_quantity:o.lot.qty??o.qty,entry_price:o.lot.price,opened_at:o.lot.at??o.at,symbol,user_id:'u1',account_id:'binance-global:primary',execution_mode:'PAPER'}:null;
  return {f,j,l};
}
const set=(fundings,trades)=>({fundings,fills:trades.map(t=>t.f),journal:trades.map(t=>t.j).filter(Boolean),lots:trades.map(t=>t.l).filter(Boolean)});
const EP=epoch=>[{epoch,from:null,to:null}];
// Tests assume the current lot formula (every lot at or after the lot-fee boundary); a case may pass its own boundary in `extra`.
const run=(data,epoch,extra={})=>replayAccount({lotFeeBoundary:0,...data,epochs:typeof epoch==='string'?EP(epoch):epoch,...extra});
const ev=(replay,key)=>replay.events.find(e=>e.key===key);
const codes=event=>event.findings.map(f=>f.code);
const buy=o=>trade({...o,side:'BUY'});
const sell=o=>trade({...o,side:'SELL'});
const rng=seed=>{let s=seed;return()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};};

/* ------------------------------------------------------------------ 9. price resolver (contract 2, section 13 item 9) */

const T=m(60);
test('9 price resolver: age boundaries at t, t-180000, t-180001, t-900000, t-900001 (option M)',()=>{
  const cases=[[0,'FRESH'],[180000,'FRESH'],[180001,'STALE'],[900000,'STALE'],[900001,'UNAVAILABLE']];
  for(const [age,state] of cases){
    const r=resolvePrice({instant:T,rows:[barRow(T-age,'100.5')]});
    assert.equal(r.state,state,'age '+age);
    assert.equal(r.age_ms,age);
    assert.equal(r.price,state==='UNAVAILABLE'?null:'100.5');
    assert.equal(r.method,'btcusdt-1m-close-asof-market-v1');
  }
  assert.deepEqual(QR2_PRICE_POLICY,{fresh_ms:180000,carry_ms:900000});
});
test('9 price resolver: a bar with bar_time > t is not a candidate; no row is UNAVAILABLE; the largest bar_time <= t wins',()=>{
  assert.equal(resolvePrice({instant:T,rows:[barRow(T+60000,'100')]}).state,'UNAVAILABLE');
  assert.deepEqual(resolvePrice({instant:T,rows:[barRow(T+60000,'100')]}).reasons,['NO_PRICE_ROW']);
  assert.equal(resolvePrice({instant:T,rows:[]}).state,'UNAVAILABLE');
  const rows=[barRow(T-60000,'101'),barRow(T+60000,'999'),barRow(T-120000,'99')];
  const r=resolvePrice({instant:T,rows});
  assert.equal(r.price,'101');
  assert.equal(r.bar_time,T-60000);
  assert.equal(r.state,'FRESH');
});
test('9 price resolver: integrity failures give PRICE_INTEGRITY_FAILED and nothing is substituted',()=>{
  const older=barRow(T-60000,'99');
  const changed=barRow(T,'100');changed.bar.close='200'; // bar changed after its hash was stored
  let r=resolvePrice({instant:T,rows:[older,changed]});
  assert.equal(r.state,'PRICE_INTEGRITY_FAILED');assert.equal(r.price,null);assert.ok(r.reasons.includes('CONTENT_HASH_MISMATCH'));
  const highBelowClose=barRow(T,'100',{open:'99',high:'99',low:'98'}); // hash recomputed, rule high >= close broken
  r=resolvePrice({instant:T,rows:[older,highBelowClose]});
  assert.equal(r.state,'PRICE_INTEGRITY_FAILED');assert.ok(r.reasons.includes('BAR_RULE_VIOLATED'));
  const timeMismatch=barRow(T,'100',{timeOverride:T-60000});
  r=resolvePrice({instant:T,rows:[older,timeMismatch]});
  assert.equal(r.state,'PRICE_INTEGRITY_FAILED');assert.ok(r.reasons.includes('BAR_TIME_MISMATCH'));
  assert.equal(verifyBarRow(older).ok,true);
  const stringBar=barRow(T,'100');stringBar.bar='{not json';
  assert.equal(resolvePrice({instant:T,rows:[stringBar]}).state,'PRICE_INTEGRITY_FAILED');
});
test('9 price resolver: option M retrieval flag is information and never changes the number',()=>{
  const flags=[[undefined,'RETRIEVAL_TIME_UNKNOWN'],[T,'RETRIEVED_BY_INSTANT'],[T-1,'RETRIEVED_BY_INSTANT'],[T+1,'RETRIEVED_AFTER_INSTANT']];
  for(const [retrievedAt,flag] of flags){
    const r=resolvePrice({instant:T,rows:[barRow(T-60000,'100.5',{retrievedAt})]});
    assert.equal(r.price,'100.5');assert.equal(r.state,'FRESH');assert.equal(r.retrieval,flag);
  }
});
test('9 price resolver: option R (not selected) drops bars retrieved after t and labels a missing retrieved_at',()=>{
  const r=(rows)=>resolvePrice({instant:T,rows,option:'R'});
  assert.equal(r([barRow(T-60000,'100',{retrievedAt:T+1})]).state,'UNAVAILABLE');
  const fallback=r([barRow(T-60000,'101',{retrievedAt:T+1}),barRow(T-120000,'99',{retrievedAt:T-120000})]);
  assert.equal(fallback.price,'99');assert.equal(fallback.retrieval,'RETRIEVED_BY_INSTANT');assert.equal(fallback.method,'btcusdt-1m-close-asof-retrieved-v1');
  assert.equal(r([barRow(T-60000,'100',{retrievedAt:T})]).retrieval,'RETRIEVED_BY_INSTANT');
  const absent=r([barRow(T-60000,'100')]);
  assert.equal(absent.price,'100');assert.equal(absent.retrieval,'HISTORICAL_RECOMPUTE');
});
test('9 price resolver: a flat account needs no price, an unsupported market is visible but unpriced, market value rounds half-even once to 18 places',()=>{
  const flat=valuePosition({broker:'binance-global',symbol:'BTCUSDT',quantity:'0',instant:T,rows:[]});
  assert.equal(flat.state,'NO_POSITION');assert.equal(flat.market_value,'0');
  assert.equal(valuePosition({broker:'binance-th',symbol:'ETHTHB',quantity:'0',instant:T,rows:[]}).state,'NO_POSITION');
  const eth=valuePosition({broker:'binance-global',symbol:'ETHUSDT',quantity:'2',instant:T,rows:[barRow(T,'100')]});
  assert.equal(eth.state,'UNSUPPORTED_MARKET');assert.equal(eth.market_value,null);assert.equal(eth.quantity,'2');
  assert.equal(valuePosition({broker:'binance-th',symbol:'BTCUSDT',quantity:'1',instant:T,rows:[barRow(T,'100')]}).state,'UNSUPPORTED_MARKET');
  const rows=[barRow(T,'0.5')];
  // 1e-18 x 0.5 = 0.5e-18 -> half to even 0; 3e-18 x 0.5 = 1.5e-18 -> 2e-18; 5e-18 x 0.5 = 2.5e-18 -> 2e-18
  assert.equal(valuePosition({broker:'binance-global',symbol:'BTCUSDT',quantity:'0.000000000000000001',instant:T,rows}).market_value,'0');
  assert.equal(valuePosition({broker:'binance-global',symbol:'BTCUSDT',quantity:'0.000000000000000003',instant:T,rows}).market_value,'0.000000000000000002');
  assert.equal(valuePosition({broker:'binance-global',symbol:'BTCUSDT',quantity:'0.000000000000000005',instant:T,rows}).market_value,'0.000000000000000002');
  const stale=valuePosition({broker:'binance-global',symbol:'BTCUSDT',quantity:'2',instant:T,rows:[barRow(T-300000,'110.25')]});
  assert.equal(stale.state,'STALE');assert.equal(stale.market_value,'220.5');
  assert.deepEqual(priceReference(stale),[T-300000,stale.content_hash]);
  assert.equal(priceReference(eth),'UNPRICED');
});
/* ------------------------------------------------------------------ 1. replay set under E0 and E2 */

const F1000=()=>[fund(1,1,'1000','1000')];
// P: O3 rounding. 0.3 BTC for 10 -> lot price 33.333333333333333333 (18 places).
const dataP=()=>set(F1000(),[
  buy({s:1,qty:'0.3',quote:'10',at:100,cash:'-10',lot:{id:'P1',price:'33.333333333333333333'}}),
  sell({s:2,qty:'0.1',quote:'4',at:200,cash:'4'}),
  sell({s:3,qty:'0.2',quote:'7',at:300,cash:'7'})]);
test('1 replay E2: partial exit rounds the removed cost once to 18 places, the full close removes the whole remainder (ledger fix O3 / D9)',()=>{
  const r=run(dataP(),'E2');
  assert.equal(r.halted,null);
  assert.deepEqual(r.binding.findings,[]); // L1 holds: 10 / 0.3 rounds to 33.333333333333333333
  // 0.1 x 33.333333333333333333 = 3.3333333333333333333 -> removed 3.333333333333333333; cost 10 - that
  const a=ev(r,'2:0.1');
  assert.equal(a.removed_cost,'3.333333333333333333');
  assert.equal(a.realized_delta,'0.666666666666666667');
  assert.deepEqual(a.state.positions.BTCUSDT,{quantity:'0.2',cost:'6.666666666666666667'});
  assert.equal(a.state.cash,'994');
  // full close: removed = whole position cost; realized 7 - 6.666666666666666667
  const b=ev(r,'3:0.2');
  assert.equal(b.removed_cost,'6.666666666666666667');
  assert.equal(b.realized_delta,'0.333333333333333333');
  assert.deepEqual(b.state.positions.BTCUSDT,{quantity:'0',cost:'0'});
  assert.equal(b.state.realized,'1');assert.equal(b.state.cash,'1001');assert.equal(b.state.identity_diff,'0');
  assert.deepEqual(b.expected_audit,[]); // |6.6666666666666666666 - 6.666666666666666667| = 4e-19 < 1e-12
  assert.deepEqual(r.lots,[{position_id:'P1',symbol:'BTCUSDT',opened:true,filled_quantity:'0.3',remaining_quantity:'0',status:'CLOSED'}]);
});
test('1 replay E0: the unrounded removed cost has 19 places, so the ledger would have thrown: SCALE_DIVERGENCE halts the replay',()=>{
  const r=run(dataP(),'E0');
  assert.equal(r.halted.code,'SCALE_DIVERGENCE');assert.equal(r.halted.key,'2:0.1');
  const f=r.findings.find(x=>x.code==='SCALE_DIVERGENCE');
  assert.equal(f.value,'6.6666666666666666667');assert.equal(f.effect,'RECONCILIATION_FAILED');assert.equal(f.check,'RT');
  assert.equal(stateAt(r,201).available,false); // no state from the halting fill onward
  assert.equal(stateAt(r,200).available,true);   // states before it stay
  assert.equal(stateAt(r,200).state.cash,'990');
});
test('1 replay E1 (a577689): O3 rounding without a G1 term gives the E2 numbers on P and the E0 numbers on the G1 case',()=>{
  const p=run(dataP(),'E1');
  assert.equal(p.halted,null);
  assert.equal(ev(p,'2:0.1').removed_cost,'3.333333333333333333');
  assert.equal(ev(p,'3:0.2').state.realized,'1');
  const q=run(dataQ(),'E1');
  assert.equal(ev(q,'3:1.5').removed_cost,'200');assert.equal(ev(q,'3:1.5').state.positions.BTCUSDT.cost,'100');
});

// Q: a position of 2 BTC where 1 BTC has no lot (opened before lots were recorded) and 1 BTC has a lot at 200.
const dataQ=()=>set(F1000(),[
  buy({s:1,qty:'1',quote:'100',at:100,cash:'-100'}),
  buy({s:2,qty:'1',quote:'200',at:200,cash:'-200',lot:{id:'Q2',price:'200'}}),
  sell({s:3,qty:'1.5',quote:'360',at:300,cash:'360'})]);
test('1 replay E2: G1 prices the uncovered part of a FIFO exit at the average cost of the unlotted rest',()=>{
  const r=run(dataQ(),'E2');
  // lot 1 x 200 consumed, 0.5 uncovered; unlotted qty 0.5+0.5=1, unlotted cost 300-200=100; removed 200+100x0.5/1 = 250
  const s=ev(r,'3:1.5');
  assert.equal(s.removed_cost,'250');assert.equal(s.realized_delta,'110');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0.5',cost:'50'});
  assert.equal(s.state.cash,'1060');assert.equal(s.state.identity_diff,'0');
  assert.deepEqual(s.findings.find(f=>f.code==='G1_UNLOTTED_CHARGED').uncovered,'0.5');
  assert.ok(!codes(s).includes('PARTIAL_LOT_COVERAGE'));
  assert.deepEqual(codes(ev(r,'1:1')),['NO_LOT','UNLOTTED_QUANTITY']);
  assert.equal(ev(r,'1:1').findings[1].amount,'1');
  assert.equal(s.findings.find(f=>f.code==='UNLOTTED_QUANTITY').amount,'0.5');
  assert.deepEqual(r.unlotted,{BTCUSDT:'0.5'});
});
test('1 replay E0: the same exit removes only the lot cost and reports PARTIAL_LOT_COVERAGE',()=>{
  const r=run(dataQ(),'E0');
  const s=ev(r,'3:1.5');
  assert.equal(s.removed_cost,'200');assert.equal(s.realized_delta,'160');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0.5',cost:'100'});
  assert.equal(s.findings.find(f=>f.code==='PARTIAL_LOT_COVERAGE').uncovered,'0.5');
  assert.ok(!codes(s).includes('G1_UNLOTTED_CHARGED'));
  assert.equal(s.state.identity_diff,'0'); // 1060 + 100 = 1000 + 160
});

// R: Bridge-style exits. TA has two partial-fill lots (R1a 0.4 @ 100, R1b 0.6 @ 110), TB one lot (R2 1 @ 120).
const dataR=(...extra)=>set(F1000(),[
  buy({s:1,cum:'0.4',qty:'0.4',quote:'40',at:100,cash:'-40',trade:'TA',lot:{id:'R1a',price:'100'}}),
  buy({s:1,cum:'1',qty:'0.6',quote:'66',at:200,cash:'-66',trade:'TA',lot:{id:'R1b',price:'110'}}),
  buy({s:2,qty:'1',quote:'120',at:300,cash:'-120',trade:'TB',lot:{id:'R2',price:'120'}}),...extra]);
const targeted=(target,qty,quote)=>sell({s:3,qty,quote,at:400,cash:quote,payload:JSON.stringify({targetTradeId:target})});
test('1 replay E0 and E2: L1 binds partial-fill lots pairwise; targeted exits by entry_trade_id, by position_id and across two lots',()=>{
  for(const epoch of ['E0','E2']){
    const base=run(dataR(),epoch);
    assert.deepEqual(base.binding.findings,[]);
    assert.equal(base.binding.bound.get('1:0.4').position_id,'R1a');
    assert.equal(base.binding.bound.get('1:1').position_id,'R1b');
    // by entry_trade_id TB: one lot, 1 x 120; position cost 226 -> 106
    let r=run(dataR(targeted('TB','1','130')),epoch),s=ev(r,'3:1');
    assert.equal(s.removed_cost,'120');assert.equal(s.realized_delta,'10');assert.deepEqual(s.consumed,[{position_id:'R2',take:'1'}]);
    assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'1',cost:'106'});
    // by position_id R1b: 0.6 x 110 = 66
    r=run(dataR(targeted('R1b','0.6','70')),epoch);s=ev(r,'3:0.6');
    assert.equal(s.removed_cost,'66');assert.equal(s.realized_delta,'4');assert.deepEqual(s.consumed,[{position_id:'R1b',take:'0.6'}]);
    assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'1.4',cost:'160'});
    // target equal to entry_trade_id TA with two lots, consumed in opened_at order: 0.4x100 + 0.6x110 = 106
    r=run(dataR(targeted('TA','1','115')),epoch);s=ev(r,'3:1');
    assert.equal(s.removed_cost,'106');assert.equal(s.realized_delta,'9');
    assert.deepEqual(s.consumed,[{position_id:'R1a',take:'0.4'},{position_id:'R1b',take:'0.6'}]);
    assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'1',cost:'120'});
    // a smaller exit across both TA lots: 0.4x100 + 0.1x110 = 51 and R1b keeps 0.5
    r=run(dataR(targeted('TA','0.5','60')),epoch);s=ev(r,'3:0.5');
    assert.equal(s.removed_cost,'51');assert.deepEqual(s.consumed,[{position_id:'R1a',take:'0.4'},{position_id:'R1b',take:'0.1'}]);
    assert.equal(r.lots.find(l=>l.position_id==='R1b').remaining_quantity,'0.5');
    assert.equal(r.lots.find(l=>l.position_id==='R1a').status,'CLOSED');
  }
});
test('1 replay E0 and E2: TARGET_UNRESOLVED and TARGET_OVERFILL halt the replay with RT and RECONCILIATION_FAILED from that fill',()=>{
  for(const epoch of ['E0','E2']){
    let r=run(dataR(targeted('ZZ','1','130')),epoch);
    assert.equal(r.halted.code,'TARGET_UNRESOLVED');assert.equal(r.halted.key,'3:1');assert.equal(r.halted.time,400);
    assert.deepEqual(r.findings.find(f=>f.code==='TARGET_UNRESOLVED'),{check:'RT',code:'TARGET_UNRESOLVED',effect:'RECONCILIATION_FAILED',event_key:'3:1',target:'ZZ'});
    assert.equal(stateAt(r,500).available,false);assert.equal(stateAt(r,400).available,true);
    r=run(dataR(targeted('TB','1.5','190')),epoch);
    assert.equal(r.halted.code,'TARGET_OVERFILL'); // lot R2 holds 1; position holds 2, so SELL_EXCEEDS_POSITION does not apply
    assert.equal(r.findings.find(f=>f.code==='TARGET_OVERFILL').uncovered,'0.5');
    r=run(dataR(sell({s:3,qty:'2.5',quote:'300',at:400,cash:'300'})),epoch);
    assert.equal(r.halted.code,'SELL_EXCEEDS_POSITION');
    assert.deepEqual([r.findings.find(f=>f.code==='SELL_EXCEEDS_POSITION').expected,r.findings.find(f=>f.code==='SELL_EXCEEDS_POSITION').actual],['2','2.5']);
  }
});

// U: a position without lots; the proportional fallback.
const dataU=()=>set(F1000(),[
  buy({s:1,qty:'2',quote:'100',at:100,cash:'-100'}),
  sell({s:2,qty:'0.5',quote:'30',at:200,cash:'30'}),
  sell({s:3,qty:'1.5',quote:'90',at:300,cash:'90'})]);
test('1 replay E0 and E2: NO_LOT_FALLBACK removes cost x q / old quantity; at a full close E2 does not use the fallback, E0 still reports it',()=>{
  for(const epoch of ['E0','E2']){
    const r=run(dataU(),epoch);
    const a=ev(r,'2:0.5'),b=ev(r,'3:1.5');
    assert.equal(a.removed_cost,'25');assert.equal(a.realized_delta,'5');assert.deepEqual(a.state.positions.BTCUSDT,{quantity:'1.5',cost:'75'});
    assert.ok(codes(a).includes('NO_LOT_FALLBACK'));
    assert.equal(b.removed_cost,'75');assert.equal(b.realized_delta,'15');assert.equal(b.state.realized,'20');assert.equal(b.state.cash,'1020');
    assert.equal(codes(b).includes('NO_LOT_FALLBACK'),epoch==='E0');
  }
});

// V: lots cost more than the position (lot V1 stored at 300 against a position cost of 200).
const dataV=()=>set(F1000(),[
  buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',lot:{id:'V1',price:'300'}}),
  buy({s:2,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'V2',price:'100'}}),
  sell({s:3,qty:'1',quote:'120',at:300,cash:'120'}),
  sell({s:4,qty:'1',quote:'10',at:400,cash:'10'})]);
test('1 replay E2: COST_CLAMPED removes only the position cost and profit uses the removed amount; the audit row is expected',()=>{
  const r=run(dataV(),'E2');
  assert.deepEqual(r.binding.findings.map(f=>[f.code,f.field,f.expected,f.actual]),[['LOT_BINDING_MISMATCH','entry_price','100','300']]);
  const s=ev(r,'3:1');
  assert.equal(s.removed_cost,'200');assert.equal(s.realized_delta,'-80');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'1',cost:'0'});
  assert.equal(s.findings.find(f=>f.code==='COST_CLAMPED').amount,'100');
  assert.deepEqual(s.expected_audit,['ledger.cost_clamped']);
  assert.equal(s.state.cash,'920');assert.equal(s.state.identity_diff,'0');assert.equal(s.state.e0_clamp_total,'0');
  // the last lot (100) leaves a position of cost 0: removed = 0, lot cost and position cost differ by > 1e-12
  const t=ev(r,'4:1');
  assert.equal(t.removed_cost,'0');assert.equal(t.realized_delta,'10');assert.deepEqual(t.expected_audit,['ledger.cost_divergence']);
});
test('1 replay E0: COST_CLAMPED keeps the unclamped removed cost in profit and breaks the identity by exactly the clamped amount, which RI records',()=>{
  const r=run(dataV(),'E0');
  const s=ev(r,'3:1');
  assert.equal(s.removed_cost,'300');assert.equal(s.realized_delta,'-180');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'1',cost:'0'});
  assert.equal(s.findings.find(f=>f.code==='COST_CLAMPED').amount,'100');
  assert.equal(s.state.e0_clamp_total,'100');assert.equal(s.state.identity_diff,'100'); // cash 920 + cost 0 - (1000 - 180)
  assert.deepEqual(s.expected_audit,[]);
  // the last lot (100) leaves the position cost 0: E0 removes the lot cost 100 again and clamps another 100; realized 10 - 100
  const t=ev(r,'4:1');
  assert.equal(t.removed_cost,'100');assert.equal(t.realized_delta,'-90');
  assert.equal(t.state.e0_clamp_total,'200');assert.equal(t.state.identity_diff,'200'); // cash 930 + 0 - (1000 - 270)
  const seeds=legacySeeds({fundings:dataV().fundings,fills:dataV().fills,replay:r,accountStart:0});
  const ri=checkIdentity({replay:r,seeds});
  assert.equal(ri.ok,true);
  assert.deepEqual(ri.e0_differences,[{event_key:'3:1',time:300,amount:'100',label:'E0_CLAMP_DIFFERENCE'},{event_key:'4:1',time:400,amount:'100',label:'E0_CLAMP_DIFFERENCE'}]);
});

// X: a full close where the lots and the position disagree.
const dataX=price2=>set(F1000(),[
  buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',lot:{id:'X1',price:'100'}}),
  buy({s:2,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'X2',price:price2}}),
  sell({s:3,qty:'2',quote:'260',at:300,cash:'260'})]);
test('1 replay: a full close removes the whole position cost under E2 (cost_divergence expected); E0 clamps lots above it and leaves RESIDUAL_COST_AT_FLAT below it',()=>{
  let r=run(dataX('100.001'),'E2'),s=ev(r,'3:2');
  assert.equal(s.removed_cost,'200');assert.equal(s.realized_delta,'60');assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0',cost:'0'});
  assert.deepEqual(s.expected_audit,['ledger.cost_divergence']);
  r=run(dataX('100.001'),'E0');s=ev(r,'3:2');
  assert.equal(s.removed_cost,'200.001');assert.equal(s.realized_delta,'59.999');assert.equal(s.findings.find(f=>f.code==='COST_CLAMPED').amount,'0.001');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0',cost:'0'});
  r=run(dataX('99.999'),'E2');s=ev(r,'3:2');
  assert.equal(s.removed_cost,'200');assert.deepEqual(s.expected_audit,['ledger.cost_divergence']);
  r=run(dataX('99.999'),'E0');s=ev(r,'3:2');
  assert.equal(s.removed_cost,'199.999');assert.equal(s.realized_delta,'60.001');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0',cost:'0.001'});
  assert.equal(s.findings.find(f=>f.code==='RESIDUAL_COST_AT_FLAT').amount,'0.001');
});

// Z: zero-cost lot next to unlotted quantity.
test('1 replay E2: a zero-cost lot counts as no lot, so the exit takes cost x qty / quantity and no G1 term (NO_LOT_FALLBACK)',()=>{
  const data=set(F1000(),[
    buy({s:1,qty:'1',quote:'50',at:100,cash:'-50',lot:{id:'Z1',price:'0'}}),
    buy({s:2,qty:'1',quote:'50',at:200,cash:'-50'}),
    sell({s:3,qty:'1.5',quote:'90',at:300,cash:'90'})]);
  const r=run(data,'E2'),s=ev(r,'3:1.5');
  assert.equal(s.removed_cost,'75');assert.equal(s.realized_delta,'15');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0.5',cost:'25'});
  assert.ok(codes(s).includes('NO_LOT_FALLBACK'));assert.ok(!codes(s).includes('G1_UNLOTTED_CHARGED'));
});

// W: two lots with the same opened_at.
const dataW=sellQty=>set(F1000(),[
  buy({s:1,qty:'1',quote:'100',at:1000,cash:'-100',lot:{id:'pos_x',price:'100'}}),
  buy({s:2,qty:'1',quote:'110',at:1000,cash:'-110',lot:{id:'pos_y',price:'110'}}),
  sell({s:3,qty:sellQty,quote:'120',at:2000,cash:'120'})]);
test('1 replay E0 and E2: LOT_ORDER_AMBIGUOUS when a tie on opened_at is consumed in part; consumption follows position_id',()=>{
  for(const epoch of ['E0','E2']){
    let r=run(dataW('1'),epoch),s=ev(r,'3:1');
    assert.equal(s.removed_cost,'100');assert.deepEqual(s.consumed,[{position_id:'pos_x',take:'1'}]);assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'1',cost:'110'});
    const a=s.findings.find(f=>f.code==='LOT_ORDER_AMBIGUOUS');
    assert.deepEqual([a.opened_at,a.cost_changes],[1000,true]);
    r=run(dataW('2'),epoch);s=ev(r,'3:2');
    assert.ok(!codes(s).includes('LOT_ORDER_AMBIGUOUS')); // the whole tie group is consumed: the order cannot change the outcome
  }
});
test('1 L1 binding: lots bind to BUY fills; LOT_BINDING_MISMATCH, NO_LOT and ORPHAN_LOT',()=>{
  const fills=[buy({s:5,cum:'0.4',qty:'0.4',quote:'40',fee:'0.04',at:10,cash:'-40.04'}).f];
  const lot=(over)=>({position_id:'L5',entry_signal_id:5,entry_trade_id:'T5',filled_quantity:'0.4',entry_price:'100.1',opened_at:10,symbol:'BTCUSDT',...over});
  const atBoundary={lotFeeBoundary:0}; // every lot is at or after the lot-fee boundary: entry_price = round18((quote + fee) / delta)
  // (40 + 0.04) / 0.4 = 100.1
  assert.deepEqual(bindLots(fills,[lot()],atBoundary).findings,[]);
  assert.deepEqual(bindLots(fills,[lot({filled_quantity:'0.5'})],atBoundary).findings.map(f=>[f.code,f.field,f.expected,f.actual,f.effect]),[['LOT_BINDING_MISMATCH','filled_quantity','0.4','0.5','SPLIT_NULL']]);
  assert.deepEqual(bindLots(fills,[lot({entry_price:'100'})],atBoundary).findings.map(f=>[f.code,f.field,f.expected,f.actual]),[['LOT_BINDING_MISMATCH','entry_price','100.1','100']]);
  const none=bindLots(fills,[],atBoundary);
  assert.deepEqual(none.findings.map(f=>[f.code,f.effect,f.event_key]),[['NO_LOT',null,'5:0.4']]); // BUY before the lot table: not a failure
  const orphan=bindLots(fills,[lot(),lot({position_id:'L99',entry_signal_id:99,entry_trade_id:'T99'})],atBoundary);
  assert.deepEqual(orphan.findings.map(f=>[f.code,f.effect,f.position_id]),[['ORPHAN_LOT','SPLIT_NULL','L99']]);
  // rounding: 100 / 3 -> 33.333333333333333333
  const three=[buy({s:6,qty:'3',quote:'100',at:10,cash:'-100'}).f];
  assert.deepEqual(bindLots(three,[lot({entry_signal_id:6,filled_quantity:'3',entry_price:'33.333333333333333333'})],atBoundary).findings,[]);
});
test('1 L1 binding (RC-Q13): the entry_price formula follows the lot-fee epoch; an absent boundary is LOT_EPOCH_UNKNOWN and SPLIT_NULL',()=>{
  const fills=[buy({s:5,cum:'0.4',qty:'0.4',quote:'40',fee:'0.04',at:10,cash:'-40.04'}).f];
  const lot=price=>({position_id:'L5',entry_signal_id:5,entry_trade_id:'T5',filled_quantity:'0.4',entry_price:price,opened_at:10,symbol:'BTCUSDT'});
  // opened before the boundary: fee excluded, 40 / 0.4 = 100 (9a87ab6); opened at or after it: (40 + 0.04) / 0.4 = 100.1 (b74ba50)
  assert.deepEqual(bindLots(fills,[lot('100')],{lotFeeBoundary:11}).findings,[]);
  assert.deepEqual(bindLots(fills,[lot('100.1')],{lotFeeBoundary:10}).findings,[]); // the boundary itself is the later epoch
  let found=bindLots(fills,[lot('100.1')],{lotFeeBoundary:11}).findings;
  assert.deepEqual(found.map(f=>[f.code,f.effect,f.expected,f.actual,f.lot_price_epoch]),[['LOT_BINDING_MISMATCH','SPLIT_NULL','100','100.1','LOT_PRICE_EXCLUDES_FEE']]);
  found=bindLots(fills,[lot('100')],{lotFeeBoundary:10}).findings;
  assert.deepEqual(found.map(f=>[f.code,f.expected,f.actual,f.lot_price_epoch]),[['LOT_BINDING_MISMATCH','100.1','100','LOT_PRICE_INCLUDES_FEE']]);
  // no boundary: the current formula holds, or the epoch is unknown (fail closed and visible)
  assert.deepEqual(bindLots(fills,[lot('100.1')]).findings,[]);
  found=bindLots(fills,[lot('100')]).findings;
  assert.deepEqual(found.map(f=>[f.code,f.effect,f.symbol,f.expected,f.actual]),[['LOT_EPOCH_UNKNOWN','SPLIT_NULL','BTCUSDT','100.1','100']]);
  assert.throws(()=>bindLots(fills,[lot('100')],{lotFeeBoundary:1.5}),{code:'QR2_INPUT_INVALID'});
  // through the replay and R6: SPLIT_NULL for the symbol, replay numbers (which use the stored price) stay
  const data=set(F1000(),[buy({s:5,qty:'0.4',quote:'40',fee:'0.04',at:10,cash:'-40.04',lot:{id:'L5',price:'100'}})]);
  const unknown=replayAccount({...data,epochs:EP('E2')});
  assert.deepEqual(unknown.binding.findings.map(f=>f.code),['LOT_EPOCH_UNKNOWN']);
  const seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay:unknown,accountStart:0});
  const stored=data.lots.map(l=>({...l,remaining_quantity:'0.4',status:'OPEN'}));
  const r6=checkR6({replay:unknown,storedLots:stored,seeds});
  assert.deepEqual(r6.failures.map(f=>[f.code,f.effect,f.symbol]),[['LOT_EPOCH_UNKNOWN','SPLIT_NULL','BTCUSDT']]);
  const known=replayAccount({...data,epochs:EP('E2'),lotFeeBoundary:11}); // the lot was opened at 10, before the boundary: fee excluded
  assert.deepEqual(known.binding.findings,[]);
  assert.equal(known.method.lot_fee_boundary,11);
});
test('1 L1 binding (RC-Q17): fewer lots than BUY fills bind to the last fills; an unbound BUY before the earliest lot is NO_LOT, a later one is LOT_BINDING_MISMATCH',()=>{
  const fills=[buy({s:7,cum:'1',qty:'1',quote:'100',at:10,cash:'-100'}).f,buy({s:7,cum:'3',qty:'2',quote:'220',at:20,cash:'-220'}).f,buy({s:8,qty:'1',quote:'10',at:30,cash:'-10'}).f];
  const lot={position_id:'L7',entry_signal_id:7,entry_trade_id:'T7',filled_quantity:'2',entry_price:'110',opened_at:20,symbol:'BTCUSDT'};
  const r=bindLots(fills,[lot],{lotFeeBoundary:0});
  assert.equal(r.bound.get('7:3').position_id,'L7');
  // 7:1 was received at 10, before the earliest lot (20): booked before the lot table. 8:1 at 30 has no lot: a lost lot must not hide as NO_LOT
  assert.deepEqual(r.findings.map(f=>[f.code,f.effect,f.event_key]),[['NO_LOT',null,'7:1'],['LOT_BINDING_MISMATCH','SPLIT_NULL','8:1']]);
});
test('1 replay E1: an exit that leaves lot-less quantity unpriced reports PARTIAL_LOT_COVERAGE with the uncovered quantity (RC-Q17)',()=>{
  const r=run(dataQ(),'E1');
  assert.equal(ev(r,'3:1.5').findings.find(f=>f.code==='PARTIAL_LOT_COVERAGE').uncovered,'0.5');
});

/* ------------------------------------------------------------------ 2. epoch selection */

test('2 epoch selection: a fill before and after the boundary; from is inclusive, to is exclusive',()=>{
  const e=[{epoch:'E0',from:null,to:300},{epoch:'E2',from:300,to:null}];
  assert.equal(epochOfFill(299,e),'E0');assert.equal(epochOfFill(300,e),'E2');
  const atBoundary=run(dataQ(),e);   // the SELL at 300 is E2: G1 gives 250
  assert.equal(ev(atBoundary,'3:1.5').epoch,'E2');assert.equal(ev(atBoundary,'3:1.5').removed_cost,'250');
  assert.equal(ev(atBoundary,'1:1').epoch,'E0');assert.equal(ev(atBoundary,'2:1').epoch,'E0');
  const before=run(dataQ(),[{epoch:'E0',from:null,to:301},{epoch:'E2',from:301,to:null}]); // the SELL at 300 is E0: 200
  assert.equal(ev(before,'3:1.5').epoch,'E0');assert.equal(ev(before,'3:1.5').removed_cost,'200');
  const three=run(dataQ(),[{epoch:'E0',from:null,to:150},{epoch:'E1',from:150,to:300},{epoch:'E2',from:300,to:null}]);
  assert.deepEqual(three.events.filter(x=>x.kind==='FILL').map(x=>x.epoch),['E0','E1','E2']);
});
test('2 epoch selection: the ledgerRule marker is corroboration only; a marker overwritten by a zero-quantity update still leaves the boundary epoch',()=>{
  const data=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',marker:'paper-exit-cost-v2'}),
    buy({s:2,qty:'1',quote:'200',at:200,cash:'-200',lot:{id:'Q2',price:'200'}}),               // marker overwritten: absent
    sell({s:3,qty:'1.5',quote:'360',at:300,cash:'360',marker:'paper-exit-cost-o3-v1'})]);     // marker says E1, boundary says E2
  const r=run(data,EP('E2'));
  assert.deepEqual([ev(r,'1:1').marker_check,ev(r,'2:1').marker_check,ev(r,'3:1.5').marker_check],['AGREES','ABSENT','DISAGREES']);
  assert.equal(ev(r,'3:1.5').epoch,'E2');
  assert.equal(ev(r,'3:1.5').removed_cost,'250'); // the rule of the boundary epoch, not of the marker
});
test('2 epoch selection: an unknown epoch gives LEDGER_RULE_UNREPLAYABLE from that fill; replay never retries another epoch',()=>{
  const r=run(dataQ(),[{epoch:'E0',from:null,to:250}]); // the SELL at 300 is covered by no row
  assert.equal(r.halted.code,'LEDGER_RULE_UNREPLAYABLE');
  assert.deepEqual(r.unreplayable_from,{index:3,time:300,key:'3:1.5',reason:'EPOCH_UNKNOWN'});
  assert.equal(r.findings.find(f=>f.code==='LEDGER_RULE_UNREPLAYABLE').effect,'RECONCILIATION_FAILED');
  assert.equal(stateAt(r,250).state.cash,'700');   // earlier events still replay
  assert.equal(stateAt(r,301).available,false);    // E2 would have replayed it; the replay does not try
  assert.equal(stateAt(r,301).reason,'LEDGER_RULE_UNREPLAYABLE');
  assert.equal(run(dataQ(),[]).halted.key,'1:1'); // no boundary recorded: every fill is unknown
  const overlap=run(dataQ(),[{epoch:'E0',from:null,to:null},{epoch:'E2',from:null,to:null}]);
  assert.equal(overlap.halted.code,'LEDGER_RULE_UNREPLAYABLE'); // two rows cover the fill: unknown
  assert.throws(()=>run(dataQ(),[{epoch:'E9',from:null,to:null}]),{code:'QR2_INPUT_INVALID'});
});
/* ------------------------------------------------------------------ 3. identity property test (E2) */

function genOps(seed){
  const rand=rng(seed),ops=[],lots=[];
  let pos=D(0),signal=0;
  const unlottedStart=rand()<0.3;
  if(unlottedStart){signal++;ops.push({s:signal,side:'BUY',qty:'2',price:'75',fee:'0',noLot:true});pos=pos.plus(2);}
  const n=8+Math.floor(rand()*8);
  for(let i=0;i<n;i++){
    const r=rand();
    if(r<0.4||pos.lte(0)){
      signal++;
      const qty=D(1+Math.floor(rand()*2000)).div(1000),price=(50+Math.floor(rand()*10000)/100).toFixed(2),fee=(Math.floor(rand()*50)/100).toFixed(2);
      const mod=rand(),lotMod=mod<0.8?null:mod<0.9?'ZERO':'INFLATE';
      ops.push({s:signal,side:'BUY',qty:qty.toFixed(),price,fee,lotMod});lots.push({s:signal,remaining:qty});pos=pos.plus(qty);
      continue;
    }
    signal++;
    const price=(50+Math.floor(rand()*10000)/100).toFixed(2),fee=(Math.floor(rand()*50)/100).toFixed(2);
    const open=lots.filter(l=>l.remaining.gt(0));
    if(rand()<0.25&&open.length){
      const lot=open[Math.floor(rand()*open.length)],qty=D(1+Math.floor(rand()*lot.remaining.mul(1000).toNumber())).div(1000);
      ops.push({s:signal,side:'SELL',qty:qty.toFixed(),price,fee,target:'T'+lot.s});lot.remaining=lot.remaining.minus(qty);pos=pos.minus(qty);
      continue;
    }
    const qty=rand()<0.25?pos:D(1+Math.floor(rand()*pos.mul(1000).toNumber())).div(1000);
    ops.push({s:signal,side:'SELL',qty:qty.toFixed(),price,fee});
    let left=qty;for(const l of lots){if(left.lte(0))break;const take=l.remaining.lte(left)?l.remaining:left;l.remaining=l.remaining.minus(take);left=left.minus(take);}
    pos=pos.minus(qty);
  }
  return ops;
}
// Row data for one op list, as the real ledger would store it (test-side arithmetic, repository money helpers).
function rowsFromOps(ops){
  const trades=[];
  ops.forEach((op,k)=>{
    const at=100+k*10,quote=D(op.qty).mul(op.price).toFixed(),fee=op.fee,cash=op.side==='BUY'?D(quote).plus(fee).neg().toFixed():D(quote).minus(fee).toFixed();
    let lot=null;
    if(op.side==='BUY'&&!op.noLot){
      const normal=amount(D(quote).plus(fee).div(op.qty));
      lot={id:'L'+op.s,price:op.lotMod==='ZERO'?'0':op.lotMod==='INFLATE'?D(normal).mul(3).toFixed():normal};
    }
    trades.push(trade({s:op.s,side:op.side,qty:op.qty,quote,fee,at,cash,lot,payload:op.target?JSON.stringify({targetTradeId:op.target}):'{}'}));
  });
  return set(F1000(),trades);
}
test('3 identity property: cash + cost = F_cash + R after every event over 1000 random E2 sequences (buys, partial, full, targeted, G1, zero-cost lots, clamps)',()=>{
  let clamps=0,g1=0,fallback=0;
  for(let seed=1;seed<=1000;seed++){
    const ops=genOps(seed*7919),r=run(rowsFromOps(ops),'E2');
    assert.equal(r.halted,null,'seed '+seed+' halted '+JSON.stringify(r.halted));
    for(const e of r.events){
      const s=e.state,lhs=D(s.cash).plus(s.position_cost),rhs=D(s.f_cash).plus(s.realized);
      assert.ok(lhs.eq(rhs),`seed ${seed} event ${e.key}: ${lhs.toFixed()} != ${rhs.toFixed()}`);
      assert.equal(s.identity_diff,'0');assert.equal(s.e0_clamp_total,'0');
      for(const p of Object.values(s.positions)){assert.ok(D(p.cost).gte(0));assert.ok((p.cost.split('.')[1]||'').length<=18,'scale '+p.cost);}
      for(const f of e.findings){if(f.code==='COST_CLAMPED')clamps++;if(f.code==='G1_UNLOTTED_CHARGED')g1++;if(f.code==='NO_LOT_FALLBACK')fallback++;}
    }
    const last=r.events[r.events.length-1].state;
    if(D(last.positions.BTCUSDT?.quantity??0).isZero())assert.equal(last.positions.BTCUSDT.cost,'0'); // L-I2
  }
  assert.ok(clamps>0&&g1>0&&fallback>0,`generator coverage clamps=${clamps} g1=${g1} fallback=${fallback}`);
});

/* ------------------------------------------------------------------ 3b. parity: E2 replay against the real recordExecution */

function makeLedgerStore(oracle={}){
  const t={signals:new Map(),allocations:[],positions:new Map(),journal:[],fills:[],audit:[]};
  const db={isTransaction:true,transaction:async fn=>fn(),prepare(sql){return{
    get:async(...p)=>{
      if(sql.includes('FROM users WHERE id=?'))return {id:p[0]};
      if(sql.includes('FROM signals WHERE id=?'))return t.signals.get(p[0]);
      if(sql.includes('SUM(cost_basis)'))return {amount:[...t.positions.values()].reduce((a,x)=>a.plus(x.cost_basis),D(0)).toFixed()};
      if(sql.includes('FROM ledger_positions WHERE user_id=? AND account_id='))return t.positions.get(`${p[0]}:${p[1]}:${p[2]}:${p[3]}`);
      if(sql.includes('FROM paper_funding'))return {equity:'100000000',cash:'100000000'};
      if(sql.includes('FROM paper_cash_journal'))return {amount:t.journal.reduce((a,x)=>a.plus(x.cash_delta),D(0)).toFixed()};
      if(sql.includes('SELECT stop_loss,take_profit FROM ledger_position_allocations')){const o=t.allocations.filter(a=>a.status==='OPEN'&&D(a.remaining_quantity).gt(0));return o.length?o[o.length-1]:undefined;}
      return undefined;},
    all:async(...p)=>{
      if(sql.includes('FROM ledger_position_allocations'))return t.allocations.filter(a=>a.status==='OPEN'&&D(a.remaining_quantity).gt(0)&&a.symbol===p[3]&&(p.length<6||a.entry_trade_id===p[4]||a.position_id===p[5]));
      return [];},
    run:async(...p)=>{
      if(sql.includes('INSERT INTO ledger_position_allocations'))t.allocations.push({position_id:p[0],user_id:p[1],account_id:p[2],execution_mode:p[3],broker:p[4],symbol:p[5],entry_signal_id:p[6],entry_trade_id:p[7],status:p[8],filled_quantity:p[9],remaining_quantity:p[10],entry_price:p[11],opened_at:p[14]});
      else if(sql.includes('UPDATE ledger_position_allocations')){const a=t.allocations.find(x=>x.position_id===p[4]);a.remaining_quantity=p[0];a.status=p[1];}
      else if(sql.includes('INSERT INTO paper_cash_journal'))t.journal.push({signal_id:p[0],cumulative_quantity:p[1],cash_delta:p[4],at:p[5]});
      else if(sql.includes('INSERT INTO ledger_positions')){const[u,a,mo,b,s,q,avg,sl,tp,ir,pnl,upd,cost]=p;t.positions.set(`${u}:${a}:${mo}:${s}`,{quantity:q,cost_basis:cost,avg_price:avg,initial_risk:ir,cumulative_pnl:pnl,stop_loss:sl,take_profit:tp});}
      else if(sql.includes('INSERT INTO fills'))t.fills.push({signal_id:p[0],cumulative_quantity:p[1],delta_quantity:p[2],price:p[3],fee_quote:p[4],received_at:p[6],quote_amount:p[7]});
      return {changes:1};}};}};
  return {t,store:{db,...ledgerMethods,...oracle,snapshotPaper:async()=>{},complete:async()=>{},audit:async(u,event,tradeId,details)=>{t.audit.push({event,tradeId,details});}}};
}
// Parity per epoch (RC-Q4, RC-Q12). The oracle is the ledger code of that epoch run against the same mock store: E2 is the real
// ledger of this tree, E0 (b9d19e3) and E1 (a577689) are frozen read-only copies of their recordExecution under
// test/fixtures/qr2-ledger-epochs/. Compared per fill: quantity, cost, expected audit rows, journal cash_delta, ledger
// cumulative_pnl per position cycle (it resets at flat) and, at the end, lot remaining and status. An E0 ledger call that throws
// (exact() on a cost above 18 places) must be a SCALE_DIVERGENCE halt of the replay at that very fill.
async function parityRun({epoch,oracle,seeds,mapOps=ops=>ops}){
  const realNow=Date.now;let clock=1000;
  const seen={clamp:0,divergence:0,g1:0,fallback:0,targeted:0,partial:0,fullClose:0,residual:0,threw:0,pnlChecked:0,journalChecked:0};
  Date.now=()=>++clock; // every ledger timestamp is unique and increasing, so lot order is opened_at order
  try{
    for(const seed of seeds){
      const ops=mapOps(genOps(seed*104729)),ctx=makeLedgerStore(oracle),account='binance-global:primary',key=`u:${account}:PAPER:BTCUSDT`;
      const after=[];let threw=null,failing=null;
      for(const [index,op] of ops.entries()){
        const q=D(op.qty),notional=D(amount(q.mul(op.price)));
        const row={id:op.s,user_id:'u',trade_id:'T'+op.s,execution_mode:'PAPER',broker:'binance-global',symbol:'BTCUSDT',account_id:account,applied_quantity:'0',applied_quote:'0',status:'PROCESSING',payload:op.target?JSON.stringify({targetTradeId:op.target}):'{}',side:op.side};
        ctx.t.signals.set(row.id,row);
        if(op.noLot){ // a position opened before lots were recorded: pre-seeded, replayed as a BUY without a lot
          ctx.t.positions.set(key,{quantity:'2',cost_basis:'150',avg_price:'75',initial_risk:'0',cumulative_pnl:'0'});
          ctx.t.fills.push({signal_id:op.s,cumulative_quantity:'2',delta_quantity:'2',price:'75',fee_quote:'0',received_at:++clock,quote_amount:'150'});
          ctx.t.journal.push({signal_id:op.s,cumulative_quantity:'2',cash_delta:'-150',at:clock});
          after.push({quantity:'2',cost:'150',pnl:'0',cash:'-150',audit:[]});
          continue;
        }
        const auditBefore=ctx.t.audit.length;
        try{
          await ctx.store.recordExecution(row,{status:'FILLED',orderId:'x',executedQty:q.toFixed(),quoteQty:notional.toFixed(),deltaFeeQuote:op.fee,raw:{}},{side:op.side,quantity:q.toFixed(),price:op.price,stopLoss:'1',takeProfit:null,notional:notional.toFixed()});
        }catch(error){
          assert.equal(epoch,'E0','only the E0 ledger can throw: '+error.message);
          assert.match(error.message,/Maximum decimal scale is 18/);
          // The mock has no rollback: drop what the failed call wrote, as the transaction would have.
          ctx.t.journal=ctx.t.journal.filter(j=>j.signal_id!==op.s);
          threw=index;seen.threw++;
          failing={signal_id:op.s,cumulative_quantity:q.toFixed(),delta_quantity:q.toFixed(),price:amount(notional.div(q)),fee_quote:op.fee,received_at:++clock,quote_amount:notional.toFixed(),legacy_float:0,side:op.side,symbol:'BTCUSDT',trade_id:'T'+op.s,payload:row.payload};
          break;
        }
        if(op.side==='BUY'&&op.lotMod){ // simulate a lot/position divergence the ledger can inherit
          const lot=ctx.t.allocations[ctx.t.allocations.length-1];
          lot.entry_price=op.lotMod==='ZERO'?'0':D(lot.entry_price).mul(3).toFixed();
        }
        const p=ctx.t.positions.get(key);
        after.push({quantity:p.quantity,cost:p.cost_basis,pnl:p.cumulative_pnl,cash:ctx.t.journal[ctx.t.journal.length-1].cash_delta,audit:ctx.t.audit.slice(auditBefore).map(a=>a.event).filter(e=>e.startsWith('ledger.'))});
      }
      const bySignal=new Map([...ctx.t.signals]);
      const fills=ctx.t.fills.map(f=>({...f,legacy_float:0,side:bySignal.get(f.signal_id).side,symbol:'BTCUSDT',trade_id:bySignal.get(f.signal_id).trade_id,payload:bySignal.get(f.signal_id).payload}));
      if(failing)fills.push(failing);
      const data={
        fundings:[{id:1,at:1,equity_delta:'100000000',cash_delta:'100000000',kind:'CONFIGURATION'}],
        fills,journal:ctx.t.journal,
        lots:ctx.t.allocations.map(a=>({position_id:a.position_id,entry_signal_id:a.entry_signal_id,entry_trade_id:a.entry_trade_id,filled_quantity:a.filled_quantity,entry_price:a.entry_price,opened_at:a.opened_at,symbol:a.symbol}))
      };
      const r=run(data,epoch);
      if(failing){
        assert.equal(r.halted?.code,'SCALE_DIVERGENCE','seed '+seed+' the ledger threw at op '+threw);
        assert.equal(r.halted.key,`${failing.signal_id}:${failing.cumulative_quantity}`);
      }else assert.equal(r.halted,null,'seed '+seed);
      const fillEvents=r.events.filter(e=>e.kind==='FILL'&&!e.halted);
      assert.equal(fillEvents.length,after.length);
      let cycle=D(0);
      fillEvents.forEach((e,i)=>{
        const real=after[i],pos=e.state.positions.BTCUSDT;
        assert.ok(D(pos.quantity).eq(real.quantity),`seed ${seed} op ${i} quantity ${pos.quantity} vs ${real.quantity}`);
        assert.ok(D(pos.cost).eq(real.cost),`seed ${seed} op ${i} cost ${pos.cost} vs ${real.cost}`);
        assert.deepEqual(e.expected_audit,real.audit,`seed ${seed} op ${i} audit`);
        // journal cash_delta: BUY -(quote + fee), SELL quote - fee
        const expectedCash=e.side==='BUY'?D(e.quote).plus(e.fee).neg():D(e.quote).minus(e.fee);
        assert.ok(expectedCash.eq(real.cash),`seed ${seed} op ${i} journal ${expectedCash.toFixed()} vs ${real.cash}`);seen.journalChecked++;
        // ledger cumulative_pnl is the realized PnL of the current position cycle and resets at flat
        if(e.side==='SELL')cycle=cycle.plus(e.realized_delta);
        // the ledger stores the cycle total rounded to 18 places at every write while the position is open (E0 profits can have more)
        if(D(pos.quantity).gt(0)){cycle=D(amount(cycle));assert.ok(cycle.eq(real.pnl),`seed ${seed} op ${i} cumulative_pnl ${cycle.toFixed()} vs ${real.pnl}`);seen.pnlChecked++;}
        else{assert.equal(real.pnl,'0');cycle=D(0);}
        const c=codes(e);
        if(c.includes('COST_CLAMPED'))seen.clamp++;
        if(e.expected_audit.includes('ledger.cost_divergence'))seen.divergence++;
        if(c.includes('G1_UNLOTTED_CHARGED'))seen.g1++;
        if(c.includes('NO_LOT_FALLBACK'))seen.fallback++;
        if(c.includes('RESIDUAL_COST_AT_FLAT'))seen.residual++;
        if(e.side==='SELL'&&e.consumed.length&&ops[i].target)seen.targeted++;
        if(e.side==='SELL'&&D(pos.quantity).gt(0))seen.partial++;
        if(e.side==='SELL'&&D(pos.quantity).isZero())seen.fullClose++;
      });
      if(!failing)for(const a of ctx.t.allocations){
        const l=r.lots.find(x=>x.position_id===a.position_id);
        assert.ok(D(l.remaining_quantity).eq(a.remaining_quantity),`seed ${seed} lot ${a.position_id}`);
        assert.equal(l.status,a.status);
      }
    }
  }finally{Date.now=realNow;}
  return seen;
}
const range=(from,to)=>Array.from({length:to-from+1},(_,i)=>from+i);
const noFees=ops=>ops.map(op=>({...op,fee:'0'}));
const reached=(seen,keys)=>{for(const key of keys)assert.ok(seen[key]>0,'branch never reached: '+key+' '+JSON.stringify(seen));};
test('3 parity E2: the replay equals the real recordExecution of this tree over 150 random sequences',async()=>{
  const seen=await parityRun({epoch:'E2',oracle:{},seeds:range(1,150)});
  reached(seen,['clamp','divergence','g1','fallback','targeted','partial','fullClose','pnlChecked','journalChecked']);
});
test('3 parity E1 (a577689): the replay equals the frozen recordExecution over 150 random sequences',async()=>{
  const seen=await parityRun({epoch:'E1',oracle:frozenLedgerE1,seeds:range(1,150)});
  reached(seen,['clamp','divergence','fallback','targeted','partial','fullClose','pnlChecked','journalChecked']);
  assert.equal(seen.g1,0); // E1 has no G1 term
});
test('3 parity E0 (b9d19e3): the replay equals the frozen recordExecution; a ledger exact() throw is a SCALE_DIVERGENCE halt at that fill',async()=>{
  const withFees=await parityRun({epoch:'E0',oracle:frozenLedgerE0,seeds:range(1,150)});
  reached(withFees,['threw','journalChecked']);
  // zero fees keep lot costs short, so the E0 ledger does not throw and every branch is compared
  const zeroFee=await parityRun({epoch:'E0',oracle:frozenLedgerE0,seeds:range(1,150),mapOps:noFees});
  reached(zeroFee,['clamp','residual','fallback','targeted','partial','fullClose','pnlChecked','journalChecked']);
  assert.equal(zeroFee.g1,0);
});

/* ------------------------------------------------------------------ golden account, gates, R3c, N1/N2 */

// Golden E2 account (hand values): fund 1000; BUY 2 @ 200+0.2 fee; BUY 1 @ 105+0.1 fee; SELL 2.5 for 300-0.3 (FIFO: lot G1 200.2 +
// lot G2 half 52.55 = 252.75 removed, realized 46.95); then a withdrawal of 100.
function golden(){
  const trades=[
    buy({s:1,qty:'2',quote:'200',fee:'0.2',at:2000,cash:'-200.2',lot:{id:'G1',price:'100.1'}}),
    buy({s:2,qty:'1',quote:'105',fee:'0.1',at:3000,cash:'-105.1',lot:{id:'G2',price:'105.1'}}),
    sell({s:3,qty:'2.5',quote:'300',fee:'0.3',at:4000,cash:'299.7'})];
  const data=set([fund(1,1000,'1000','1000'),fund(2,5000,'-100','-100')],trades);
  const snapshots=[
    {id:1,at:1000,reason:'FUNDING',cash:'1000',book_equity:'1000',position_cost:'0'},
    {id:2,at:2000,reason:'FILL',cash:'799.8',book_equity:'1000',position_cost:'200.2'},
    {id:3,at:3000,reason:'FILL',cash:'694.7',book_equity:'1000',position_cost:'305.3'},
    {id:4,at:4000,reason:'FILL',cash:'994.4',book_equity:'1046.95',position_cost:'52.55'},
    {id:5,at:5000,reason:'FUNDING',cash:'894.4',book_equity:'946.95',position_cost:'52.55'}];
  const storedLots=[{...data.lots[0],remaining_quantity:'0',status:'CLOSED'},{...data.lots[1],remaining_quantity:'0.5',status:'OPEN'}];
  const stored={positions:[{symbol:'BTCUSDT',quantity:'0.5',cost_basis:'52.55'}],cash:'894.4'};
  return {...data,snapshots,storedLots,stored};
}
const SCOPE={user_id:'u1',broker:'binance-global'};
function gate(g,over={}){
  const x={...g,...over},replay=run({fundings:x.fundings,fills:x.fills,journal:x.journal,lots:x.storedLots.map(l=>({...l}))},'E2');
  const seeds=legacySeeds({fundings:x.fundings,fills:x.fills,replay,accountStart:0});
  const gates=runGates({replay,seeds,fundings:x.fundings,journal:x.journal,fills:x.fills,storedLots:x.storedLots,stored:x.stored,snapshots:x.snapshots,scope:SCOPE,readTime:10000});
  return {replay,seeds,...gates};
}
const GOLDEN_BARS=[barRow(2500,'100'),barRow(3500,'102'),barRow(5000,'104'),barRow(6000,'110')];

test('golden: replay hand values (identity, lots, snapshots) and every gate passes on the real-shaped account',()=>{
  const g=gate(golden());
  const s=ev(g.replay,'3:2.5');
  assert.equal(s.removed_cost,'252.75');assert.equal(s.realized_delta,'46.95');
  assert.deepEqual(s.state.positions.BTCUSDT,{quantity:'0.5',cost:'52.55'});
  assert.deepEqual(s.consumed,[{position_id:'G1',take:'2'},{position_id:'G2',take:'0.5'}]);
  assert.equal(g.replay.final.cash,'894.4');assert.equal(g.replay.final.book_equity,'946.95');
  assert.deepEqual(g.seeds,{method:'legacy-two-seed-v1',s_cash:0,s_cost:0,nav_from:0,has_m1:false,has_m2:false,m1_count:0,m2_count:0,last_m1_time:null});
  for(const id of ['R1','R2','R4','R5','R6','R7','R11','RC','RI'])assert.equal(g.gates[id].ok,true,id);
  assert.equal(g.gates.N.ok,true);assert.equal(g.gates.R3c.ok,true);
  assert.deepEqual(g.gates.R3c.results.map(r=>r.status),['MATCH','MATCH','MATCH','MATCH','MATCH']);
  assert.deepEqual(g.findings,[]);
  assert.equal(g.effects.reconciliation_failed,false);assert.equal(g.refused,null);
  assert.deepEqual(unbackedEquityLine(g.replay.final),{value:'0',identity_ok:true});
});

/* ------------------------------------------------------------------ 4. legacy seeds (O7) */

const baseline=fund(1,500,'150','150','LEGACY_BASELINE');
function legacyAccount(){
  const lf=buy({s:1,qty:'1',quote:'50',at:100,cash:'-50',legacy:1});
  const sl=sell({s:2,qty:'1',quote:'70',at:800,cash:'70'});
  return set([baseline],[lf,sl]);
}
test('4 legacy: S_cash is the last LEGACY_BASELINE row, S_cost the first flat instant after it and after the last legacy fill',()=>{
  const data=legacyAccount(),replay=run(data,'E2');
  const seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  assert.deepEqual(seeds,{method:'legacy-two-seed-v1',s_cash:500,s_cost:801,nav_from:501,has_m1:true,has_m2:true,m1_count:1,m2_count:1,last_m1_time:100});
  // negative pre-baseline cash does not trigger N1: cash is -50 after the legacy BUY at 100 and 100 after the baseline
  assert.equal(ev(replay,'1:1').state.cash,'-50');
  const inv=checkLedgerInvariants({replay,seeds});
  assert.equal(inv.ok,true);assert.deepEqual(inv.violations,[]);assert.deepEqual(inv.spans,[]);
  // seeded instants: NAV only after S_cash, cost and PnL split only after S_cost
  assert.equal(navSeeded(seeds,400),false);assert.equal(navSeeded(seeds,501),true);
  assert.equal(costSeeded(seeds,700),false);assert.equal(costSeeded(seeds,801),true);
  const rows=[barRow(700,'60'),barRow(900,'80')];
  const before=navAt({replay,seeds,instant:400,rows});
  assert.equal(before.nav,null);assert.deepEqual(before.reasons,['RECONCILIATION_UNAVAILABLE_LEGACY']);
  const between=navAt({replay,seeds,instant:700,rows}); // cash 100 + 1 x 60
  assert.deepEqual([between.cash,between.nav,between.realized,between.unrealized,between.cost_reason],['100','160',null,null,'COST_UNVERIFIED_LEGACY']);
  const after=navAt({replay,seeds,instant:900,rows});   // flat: cash 170, realized 70 - 50
  assert.deepEqual([after.cash,after.nav,after.realized,after.unrealized,after.cost_reason],['170','170','20','0',null]);
});
test('4 legacy: LEGACY_DUST (1e-13 replayed quantity where the ledger shows zero) is reported exactly and prevents S_cost',()=>{
  const data=set([],[
    buy({s:1,qty:'1',quote:'50',at:100,cash:'-50',legacy:1}),
    sell({s:2,qty:'0.9999999999999',quote:'60',at:200,cash:'60',legacy:1})]);
  const replay=run(data,'E2');
  assert.equal(replay.final.positions.BTCUSDT.quantity,'0.0000000000001');
  const seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  assert.equal(seeds.s_cost,null);
  const r4=checkR4({replay,seeds,stored:{positions:[{symbol:'BTCUSDT',quantity:'0',cost_basis:'0'}],cash:'10'}});
  assert.equal(r4.ok,false);
  assert.deepEqual(r4.failures.map(f=>[f.code,f.symbol,f.amount,f.expected,f.actual,f.effect]),[['LEGACY_DUST','BTCUSDT','0.0000000000001','0','0.0000000000001','RECONCILIATION_FAILED']]);
  // no epsilon: the same difference is not accepted when the stored quantity is also non-zero but different
  const other=checkR4({replay,seeds,stored:{positions:[{symbol:'BTCUSDT',quantity:'0.0000000000002',cost_basis:'0'}],cash:'10'}});
  assert.equal(other.ok,false);assert.equal(other.failures[0].code,'RECONCILIATION_FAILED');
  // gates that need S_cost do not run
  const gates=runGates({replay,seeds,fundings:data.fundings,journal:data.journal,fills:data.fills,storedLots:[],stored:{positions:[{symbol:'BTCUSDT',quantity:'0',cost_basis:'0'}],cash:'10'},snapshots:[],scope:SCOPE,readTime:1000});
  assert.deepEqual([gates.gates.R5.not_run,gates.gates.R7.not_run,gates.gates.RI.not_run,gates.gates.R3c.status],['S_COST_UNAVAILABLE','S_COST_UNAVAILABLE','S_COST_UNAVAILABLE','NOT_RUN']);
});
test('4 legacy: an M3 marker (fill without journal row, or the reverse) at or after S_cash is RECONCILIATION_FAILED; before S_cash it is information',()=>{
  const lateFill=buy({s:2,qty:'1',quote:'10',at:600,cash:'-10',nojournal:true});
  let r1=checkR1({fills:[lateFill.f],journal:[],scope:SCOPE,sCash:500});
  assert.equal(r1.ok,false);
  assert.deepEqual(r1.failures.map(f=>[f.check,f.reason,f.marker,f.event_key,f.effect]),[['R1','FILL_WITHOUT_JOURNAL','M3','2:1','RECONCILIATION_FAILED']]);
  const earlyFill=buy({s:2,qty:'1',quote:'10',at:400,cash:'-10',nojournal:true});
  r1=checkR1({fills:[earlyFill.f],journal:[],scope:SCOPE,sCash:500});
  assert.equal(r1.ok,true);assert.equal(r1.information.length,1);
  const orphanJournal={signal_id:9,cumulative_quantity:'1',cash_delta:'-5',at:700,user_id:'u1',broker:'binance-global'};
  r1=checkR1({fills:[],journal:[orphanJournal],scope:SCOPE,sCash:500});
  assert.deepEqual(r1.failures.map(f=>[f.reason,f.event_key]),[['JOURNAL_WITHOUT_FILL','9:1']]);
});
test('4 legacy: an M1 fill after S_cash does not move S_cost earlier than the last legacy fill',()=>{
  const data=set([],[
    buy({s:1,qty:'1',quote:'50',at:100,cash:'-50',legacy:1}),
    sell({s:2,qty:'1',quote:'60',at:200,cash:'60',legacy:1}),
    buy({s:3,qty:'1',quote:'50',at:300,cash:'-50',legacy:1}),
    sell({s:4,qty:'1',quote:'60',at:400,cash:'60',legacy:1})]);
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:[],fills:data.fills,replay,accountStart:0});
  assert.equal(seeds.s_cost,401); // flat at 201 too, but not after the last legacy fill (400)
});
/* ------------------------------------------------------------------ 5. commit order R3c */

test('5 R3c: MATCH on every snapshot of the golden account',()=>{
  const g=golden(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const r=checkCommitOrder({replay,snapshots:g.snapshots,seeds});
  assert.equal(r.status,'RUN');assert.equal(r.method,'commit-order-snapshot-id-v1');
  assert.deepEqual(r.results.map(x=>[x.event_key,x.snapshot_id,x.status]),[['F:1','1','MATCH'],['1:2','2','MATCH'],['2:1','3','MATCH'],['3:2.5','4','MATCH'],['F:2','5','MATCH']]);
});
// F4 row set (docs/evidence/PAPER_FUNDING_RACE_F4_LOCAL_2026-10-13.json): funding 100/100, a BUY of 400 at 0.1 (notional 40) commits,
// then a withdrawal to 20/20 decided on a snapshot without that fill commits; its funding snapshot says cash 20, position cost 0.
function f4(extra=[]){
  const trades=[buy({s:1,qty:'400',quote:'40',at:2000,cash:'-40',lot:{id:'F4L',price:'0.1'}}),...extra];
  const data=set([fund(1,1000,'100','100'),fund(2,3000,'-80','-80')],trades);
  const snapshots=[
    {id:1,at:1000,reason:'FUNDING',cash:'100',book_equity:'100',position_cost:'0'},
    {id:2,at:2000,reason:'FILL',cash:'60',book_equity:'100',position_cost:'40'},
    {id:3,at:3000,reason:'FUNDING',cash:'20',book_equity:'20',position_cost:'0'}];
  return {...data,snapshots};
}
test('5 R3c: FUNDING_SNAPSHOT_STALE on the F4 row set',()=>{
  const g=f4(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.lots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const r=checkCommitOrder({replay,snapshots:g.snapshots,seeds});
  assert.deepEqual(r.results.map(x=>x.status),['MATCH','MATCH','FUNDING_SNAPSHOT_STALE']);
  const stale=r.results[2];
  assert.equal(stale.stale_over_fills,1);
  // replay after both events: cash 100-80-40 = -20, book equity 20-40+40 = 20, cost 40; the snapshot lacks the fill
  assert.deepEqual(stale.expected,{cash:'-20',book_equity:'20',position_cost:'40'});
  assert.deepEqual(stale.actual,{cash:'20',book_equity:'20',position_cost:'0'});
  assert.equal(r.ok,false); // diagnostic: no effect, no span from R3c itself
  assert.equal(r.effect,null);
});
test('5 R3c: ORDER_UNPROVEN on equal received_at when the snapshot order differs from the replay tie-break',()=>{
  // Two BUYs stamped 2000: signal 1 (1 BTC, 10) and signal 2 (2 BTC, 30). Replay orders by signal id; the snapshots were written 2 then 1.
  const data=set([fund(1,1000,'100','100')],[
    buy({s:1,qty:'1',quote:'10',at:2000,cash:'-10',lot:{id:'A',price:'10'}}),
    buy({s:2,qty:'2',quote:'30',at:2000,cash:'-30',lot:{id:'B',price:'15'}})]);
  const snapshots=[
    {id:1,at:1000,reason:'FUNDING',cash:'100',book_equity:'100',position_cost:'0'},
    {id:2,at:2000,reason:'FILL',cash:'70',book_equity:'100',position_cost:'30'},  // signal 2 committed first
    {id:3,at:2000,reason:'FILL',cash:'60',book_equity:'100',position_cost:'40'}];
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  const r=checkCommitOrder({replay,snapshots,seeds});
  assert.deepEqual(r.results.map(x=>[x.event_key,x.status,x.reason]),[['F:1','MATCH',undefined],['1:1','ORDER_UNPROVEN','EQUAL_EVENT_TIME'],['2:2','MATCH',undefined]]);
  assert.deepEqual(r.results[1].expected,{cash:'90',book_equity:'100',position_cost:'10'});
  assert.deepEqual(r.results[1].actual,{cash:'70',book_equity:'100',position_cost:'30'});
  // equal times whose snapshots agree with the replay order stay MATCH
  const ordered=[snapshots[0],{id:2,at:2000,reason:'FILL',cash:'90',book_equity:'100',position_cost:'10'},snapshots[2]];
  assert.deepEqual(checkCommitOrder({replay,snapshots:ordered,seeds}).results.map(x=>x.status),['MATCH','MATCH','MATCH']);
});
test('5 R3c: a snapshot reason that disagrees with the replay order, or a missing snapshot, is ORDER_UNPROVEN; a plain mismatch is FILL_SNAPSHOT_MISMATCH',()=>{
  const g=golden(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const bad=g.snapshots.map(s=>s.id===3?{...s,cash:'694.69'}:s);
  assert.equal(checkCommitOrder({replay,snapshots:bad,seeds}).results[2].status,'FILL_SNAPSHOT_MISMATCH');
  const swapped=g.snapshots.map(s=>s.id===2?{...s,reason:'FUNDING'}:s);
  assert.equal(checkCommitOrder({replay,snapshots:swapped,seeds}).results[1].status,'ORDER_UNPROVEN');
  const missing=checkCommitOrder({replay,snapshots:g.snapshots.slice(1),seeds});
  assert.equal(missing.results[0].status,'ORDER_UNPROVEN');assert.equal(missing.results[0].reason,'NO_SNAPSHOT');
  assert.equal(missing.results[1].status,'MATCH'); // alignment is from the last snapshot
});
/* ------------------------------------------------------------------ 6. N1 and N2 on the F4 table */

test('6 N1 and N2 on the F4 table: -20 and -20; a later SELL ends the span but keeps the recorded flags',()=>{
  let g=f4(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.lots},'E2');
  let seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  let inv=checkLedgerInvariants({replay,seeds});
  assert.equal(inv.ok,false);
  assert.deepEqual(inv.violations.map(v=>[v.check,v.event_key,v.time,v.value,v.effect]),[['N1','F:2',3000,'-20','LEDGER_INVARIANT_VIOLATED'],['N2','F:2',3000,'-20','LEDGER_INVARIANT_VIOLATED']]);
  assert.deepEqual(inv.spans,[{from:3000,to:null,start_event_key:'F:2',end_event_key:null}]); // not recovered
  // a later SELL of the 400 at 0.1: cash -20 + 40 = 20, configured equity floor 20 + (-40 + 40) = 20
  const later=sell({s:2,qty:'400',quote:'40',at:4000,cash:'40'});
  g=f4([later]);replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.lots},'E2');
  seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  inv=checkLedgerInvariants({replay,seeds});
  assert.deepEqual(inv.violations.map(v=>[v.check,v.value]),[['N1','-20'],['N2','-20']]); // flags kept
  assert.deepEqual(inv.spans,[{from:3000,to:4000,start_event_key:'F:2',end_event_key:'2:400'}]);
  assert.equal(ev(replay,'2:400').state.cash,'20');
  // the violation span nulls returns of periods that intersect it, while money facts stay
  const effects=effectsOf({findings:inv.violations,spans:inv.spans,replay});
  assert.equal(effects.ledger_invariant_violated,true);
  assert.equal(intersectsSpan(inv.spans,2500,3500),true);
  assert.equal(intersectsSpan(inv.spans,3500,4500),true);
  assert.equal(intersectsSpan(inv.spans,4001,5000),false);
  assert.equal(intersectsSpan(inv.spans,1000,3000),false); // [1000,3000) ends before the violating event at 3000
  const rows=[barRow(2500,'0.1'),barRow(3500,'0.1')];
  const inside=rangePerformance({replay,seeds,effects,from:2500,to:3500,rows});
  assert.equal(inside.twr.value,null);assert.deepEqual(inside.twr.reasons,['LEDGER_INVARIANT_VIOLATED']);
  assert.deepEqual(inside.mwr.reasons,['LEDGER_INVARIANT_VIOLATED']);assert.deepEqual(inside.max_drawdown.reasons,['LEDGER_INVARIANT_VIOLATED']);
  // NAV(2500) = 60 + 400 x 0.1 = 100; NAV(3500) = -20 + 40 = 20; flow -80 at 3000: money PnL = 20 - 100 + 80 = 0, visible and labelled
  assert.equal(inside.money_pnl.value,'0');assert.deepEqual(inside.money_pnl.reasons,['LEDGER_INVARIANT_VIOLATED']);
  assert.equal(inside.nav_to.nav,'20');
  assert.deepEqual(accountStatus({effects,performance:inside}),{status:'PARTIAL',overlays:['LEDGER_INVARIANT_VIOLATED'],reasons:['LEDGER_INVARIANT_VIOLATED']});
});

/* ------------------------------------------------------------------ 7, 8. boundaries, TWR and Modified Dietz */

function perf(data,{from,to,rows=[],epoch='E2',effects,commitOrder}){
  const replay=run(data,epoch),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  const eff=effects??effectsOf({findings:[],spans:[],replay});
  return {replay,seeds,out:rangePerformance({replay,seeds,effects:eff,from,to,rows,commitOrder})};
}
test('7 boundaries: a flow at exactly from is counted once; a flow at exactly to is excluded from the range and from NAV(to)',()=>{
  const data=set([fund(1,m(10),'100','100')],[]);
  const inRange=perf(data,{from:m(10),to:m(40)}).out;
  assert.deepEqual(inRange.flows,[{time:m(10),amount:'100'}]);
  assert.equal(inRange.nav_from.nav,'0');assert.equal(inRange.nav_to.nav,'100');
  assert.equal(inRange.money_pnl.value,'0'); // 100 - 0 - 100
  const previous=perf(data,{from:m(-20),to:m(10)}).out;
  assert.deepEqual(previous.flows,[]);
  assert.equal(previous.nav_to.nav,'0'); // the deposit stamped to belongs to the next range
  assert.equal(previous.money_pnl.value,'0');
  // the same flow is not counted in two adjacent ranges: 100 in total
  assert.equal(inRange.flows.length+previous.flows.length,1);
});
test('7 boundaries: a deposit-only range has money PnL 0 and TWR 0 (and Modified Dietz 0)',()=>{
  const out=perf(set([fund(1,m(20),'100','100')],[]),{from:m(10),to:m(40)}).out;
  assert.deepEqual(out.flows,[{time:m(20),amount:'100'}]);
  assert.equal(out.money_pnl.value,'0');assert.equal(out.twr.value,'0');assert.equal(out.mwr.value,'0');
  assert.equal(out.detail.twr.subperiods[0].skipped,true); // empty first sub-period: start value 0, no fill, no position
  assert.equal(out.detail.twr.subperiods[1].skipped,false);
});
// T2: deposit 1000; BUY 5 @ 100; range [m10, m40) with a +200 deposit at m20 and a -100 withdrawal at m30.
const dataT2=()=>set([fund(1,m(0),'1000','1000'),fund(2,m(20),'200','200'),fund(3,m(30),'-100','-100')],[
  buy({s:1,qty:'5',quote:'500',at:m(5),cash:'-500',lot:{id:'T1',price:'100'}})]);
const barsT2=()=>[barRow(m(10),'100'),barRow(m(20),'110'),barRow(m(30),'99'),barRow(m(40),'121')];
test('8 TWR and Modified Dietz: hand-computed range with two flows',()=>{
  const {out}=perf(dataT2(),{from:m(10),to:m(40),rows:barsT2()});
  // NAV(m10) 500+500 = 1000; NAV(m20) 500+550 = 1050; NAV(m30) 700+495 = 1195; NAV(m40) 600+605 = 1205
  assert.deepEqual([out.nav_from.nav,out.nav_to.nav],['1000','1205']);
  assert.deepEqual(out.flows,[{time:m(20),amount:'200'},{time:m(30),amount:'-100'}]);
  assert.equal(out.money_pnl.value,'105');           // 1205 - 1000 - (200 - 100)
  // (1050/1000) x (1195/1250) x (1205/1095) - 1 = 0.10463835616438356164...
  assert.equal(out.twr.value,'0.104638356164');
  // w = 20/30 and 10/30: 1000 + 133.33.. - 33.33.. = 1100; 105 / 1100 = 0.0954545454545...
  assert.equal(out.mwr.value,'0.095454545455');
  assert.equal(out.max_drawdown.value,'0.044');      // index 1.05 -> 1.0038: 1 - 1195/1250
  assert.deepEqual([out.detail.drawdown.grid_points,out.detail.drawdown.valued_points,out.detail.drawdown.sampled],[4,4,true]);
  assert.equal(out.identity.ok,true);                // R10: delta R 0 + delta U ((605 - 500) - (500 - 500)) = 105
  assert.deepEqual([out.identity.expected,out.identity.actual],['105','105']);
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.deepEqual([out[key].status,out[key].reasons],['COMPLETE',[]]);
});
test('8 TWR: same-instant flows are summed; an empty first sub-period is skipped',()=>{
  const data=set([fund(1,m(0),'1000','1000'),fund(2,m(20),'100','100'),fund(3,m(20),'50','50')],[]);
  const {out,replay}=perf(data,{from:m(10),to:m(40)});
  assert.deepEqual(flowsIn(replay,m(10),m(40)),[{time:m(20),amount:'150'}]);
  assert.equal(out.money_pnl.value,'0'); // 1150 - 1000 - 150
  assert.equal(out.twr.value,'0');
  const empty=perf(set([fund(1,m(20),'100','100')],[]),{from:m(10),to:m(40)}).out;
  assert.equal(empty.twr.value,'0');
  // opposite flows in one millisecond that cancel are not a flow
  const cancel=set([fund(1,m(0),'1000','1000'),fund(2,m(20),'100','100'),fund(3,m(20),'-100','-100')],[]);
  assert.deepEqual(flowsIn(run(cancel,'E2'),m(10),m(40)),[]);
  // an equity-only CONFIGURATION change is not a flow and never moves NAV
  const equityOnly=set([fund(1,m(0),'1000','1000'),fund(2,m(20),'500','0')],[]);
  const eo=perf(equityOnly,{from:m(10),to:m(40)}).out;
  assert.deepEqual(eo.flows,[]);assert.equal(eo.nav_to.nav,'1000');assert.equal(eo.twr.value,'0');
  assert.deepEqual(unbackedEquityLine(run(equityOnly,'E2').final),{value:'500',identity_ok:true});
});
const stubNav=(map,positions=[])=>t=>({nav:map[t]??null,reasons:map[t]===undefined?['UNAVAILABLE']:[],positions});
test('8 TWR: NON_POSITIVE_BASE for a start value <= 0 unless the sub-period is empty; Modified Dietz denominator <= 0',()=>{
  const replay={events:[]},ctx={replay,seeds:{nav_from:0},rows:[],commitOrder:null};
  // start value 10 + flow -20 = -10
  let r=twr({...ctx,from:0,to:100,flows:[{time:50,amount:'-20'}],navFn:stubNav({0:'10',50:'10',100:'5'})});
  assert.equal(r.value,null);assert.deepEqual(r.reasons,['NON_POSITIVE_BASE']);
  // start value exactly 0 with an open position is not empty
  r=twr({...ctx,from:0,to:100,flows:[],navFn:stubNav({0:'0',100:'5'},[{quantity:'1'}])});
  assert.deepEqual(r.reasons,['NON_POSITIVE_BASE']);
  // start value exactly 0 and flat: skipped, a first deposit is valid
  r=twr({...ctx,from:0,to:100,flows:[{time:50,amount:'100'}],navFn:stubNav({0:'0',50:'0',100:'100'})});
  assert.equal(r.value,'0');
  // a start value 0 with a fill inside is not empty
  r=twr({replay:{events:[{kind:'FILL',time:10,halted:false,key:'x'}]},seeds:{nav_from:0},from:0,to:100,flows:[],navFn:stubNav({0:'0',100:'0'}),rows:[]});
  assert.deepEqual(r.reasons,['NON_POSITIVE_BASE']);
  // w = 0.5; denominator = 100 + 0.5 x (-300) = -50
  const md=modifiedDietz({navFrom:{nav:'100',reasons:[]},navTo:{nav:'200',reasons:[]},flows:[{time:50,amount:'-300'}],from:0,to:100});
  assert.equal(md.value,null);assert.deepEqual(md.reasons,['NON_POSITIVE_BASE']);
  assert.deepEqual(moneyPnl({navFrom:{nav:'100',reasons:[]},navTo:{nav:'200',reasons:[]},flows:[{time:50,amount:'-300'}]}),{value:'400',reasons:[]});
});
test('8 TWR: a null boundary NAV gives TWR_BOUNDARY_UNVALUED with no partial product, and Modified Dietz still exists when only interior prices are missing',()=>{
  const data=set([fund(1,m(0),'1000','1000'),fund(2,m(30),'200','200')],[buy({s:1,qty:'5',quote:'500',at:m(5),cash:'-500',lot:{id:'T1',price:'100'}})]);
  // prices only at the range ends: the interior flow instant m30 is 20 minutes after the last bar (> 900 s)
  const {out}=perf(data,{from:m(10),to:m(40),rows:[barRow(m(10),'100'),barRow(m(40),'120')]});
  assert.equal(out.twr.value,null);assert.deepEqual(out.twr.reasons,['TWR_BOUNDARY_UNVALUED','UNAVAILABLE']);
  assert.equal(out.money_pnl.value,'100');          // NAV(m40) 700 + 600 = 1300; 1300 - 1000 - 200
  assert.equal(out.mwr.value,'0.09375');            // 100 / (1000 + 200/3) = 300 / 3200
  assert.deepEqual(out.max_drawdown.reasons,['DRAWDOWN_GRID_UNVALUED']);
  assert.equal(out.max_drawdown.value,null);
});
test('8 drawdown grid: a daily 00:00Z point is part of the grid and a point without a price is never skipped',()=>{
  // deposit 1000, BUY 5 @ 100; range [m-10, m10) crosses midnight 00:00Z at m0
  const data=set([fund(1,m(-60),'1000','1000')],[buy({s:1,qty:'5',quote:'500',at:m(-55),cash:'-500',lot:{id:'D1',price:'100'}})]);
  const rows=[barRow(m(-10),'100'),barRow(m(0),'90'),barRow(m(10),'95')];
  const {replay,out}=perf(data,{from:m(-10),to:m(10),rows});
  assert.deepEqual(gridPoints({replay,from:m(-10),to:m(10),flows:[]}),[m(-10),m(0),m(10)]);
  // NAV 1000 -> 950 -> 975: index 1 -> 0.95 -> 0.975; max drawdown 0.05; TWR 975/1000 - 1
  assert.equal(out.max_drawdown.value,'0.05');assert.equal(out.twr.value,'-0.025');
  assert.deepEqual([out.detail.drawdown.peak_time,out.detail.drawdown.trough_time],[m(-10),m(0)]);
  // no bar between m-25 and m10 except at the ends: the grid point at midnight is 25 minutes old and unavailable
  const gap=perf(data,{from:m(-10),to:m(10),rows:[barRow(m(-25),'100'),barRow(m(10),'95')]}).out;
  assert.equal(gap.twr.value,'-0.025');                  // end points are valued (the first price is 15 min old: STALE)
  assert.equal(gap.max_drawdown.value,null);assert.deepEqual(gap.max_drawdown.reasons,['DRAWDOWN_GRID_UNVALUED']);
  assert.equal(gap.detail.drawdown.grid_points,3);assert.equal(gap.detail.drawdown.valued_points,2);
  assert.deepEqual(gap.nav_from.reasons,['PRICE_STALE']);assert.deepEqual(gap.money_pnl.reasons,['PRICE_STALE']);
  assert.equal(gap.money_pnl.status,'COMPLETE'); // PRICE_STALE is information: the value stays COMPLETE (RC-Q17)
});
test('8 drawdown grid: the grid is a refinement of the flow cuts, so its last index equals the TWR',()=>{
  const g=golden(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const effects=effectsOf({findings:[],spans:[],replay});
  const out=rangePerformance({replay,seeds,effects,from:1500,to:6000,rows:GOLDEN_BARS});
  assert.deepEqual(gridPoints({replay,from:1500,to:6000,flows:out.flows}),[1500,2000,3000,4000,5000,6000]);
  // NAV 1500: 1000; 3000: 799.8 + 200 = 999.8; 5000: 994.4 + 52 = 1046.4; 6000: 894.4 + 55 = 949.4; flow -100 at 5000
  assert.deepEqual([out.nav_from.nav,out.nav_to.nav],['1000','949.4']);
  assert.equal(out.money_pnl.value,'49.4');                    // 949.4 - 1000 + 100 = delta R 46.95 + delta U 2.45
  assert.equal(out.twr.value,'0.049716990702');                // (1046.4/1000) x (949.4/946.4) - 1
  assert.equal(out.mwr.value,'0.050522727273');                // 49.4 / (1000 - 100 x 1000/4500)
  assert.equal(out.max_drawdown.value,'0.0002');               // 1 -> 0.9998 at 3000, later peaks are higher
  assert.deepEqual([out.identity.expected,out.identity.actual,out.identity.e0_clamp_delta],['49.4','49.4','0']);
  assert.equal(out.nav_to.realized,'46.95');assert.equal(out.nav_to.unrealized,'2.45');
  assert.deepEqual(exposure(out.nav_to),{value:'0.057931325047',basis:'MARKET_VALUE_OVER_NAV'});
  const unpriced=navAt({replay,seeds,instant:6000,rows:[]});
  assert.equal(unpriced.nav,null);assert.deepEqual(unpriced.reasons,['UNAVAILABLE']);
  assert.deepEqual(exposure(unpriced),{value:'0.055493954274',basis:'EXPOSURE_AT_COST'});
});
test('8 TWR: a same-millisecond flow and fill whose order changes the NAV is ORDER_AMBIGUOUS unless R3c proves the order',()=>{
  // BUY 5 @ 100 (cost 500) and a +200 deposit are both stamped m20; the bar says 110, so the BUY is worth 550 vs 500 paid
  const data=set([fund(1,m(0),'1000','1000'),fund(2,m(20),'200','200')],[buy({s:1,qty:'5',quote:'500',at:m(20),cash:'-500',lot:{id:'O1',price:'100'}})]);
  const rows=[barRow(m(10),'100'),barRow(m(20),'110'),barRow(m(40),'110')];
  const bare=perf(data,{from:m(10),to:m(40),rows}).out;
  // flow first: NAV(m20) = 1000; fills first: cash 500 + 5 x 110 = 1050
  assert.equal(bare.twr.value,null);assert.deepEqual(bare.twr.reasons,['ORDER_AMBIGUOUS']);
  assert.equal(bare.money_pnl.value,'50'); // 1250 + 0... NAV(m40) = 700 + 550 = 1250; 1250 - 1000 - 200 = 50
  // a BUY priced exactly at the mark does not change NAV, so the order does not change the result
  const neutral=set([fund(1,m(0),'1000','1000'),fund(2,m(20),'200','200')],[buy({s:1,qty:'5',quote:'550',at:m(20),cash:'-550',lot:{id:'O2',price:'110'}})]);
  const ok=perf(neutral,{from:m(10),to:m(40),rows}).out;
  assert.notEqual(ok.twr.value,null);
  // R3c proof: every event stamped m20 matched its snapshot
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  const proof={status:'RUN',results:[{event_key:'F:2',status:'MATCH'},{event_key:'1:5',status:'MATCH'}]};
  const proven=rangePerformance({replay,seeds,effects:effectsOf({findings:[],spans:[],replay}),from:m(10),to:m(40),rows,commitOrder:proof});
  assert.notEqual(proven.twr.value,null);
});

/* ------------------------------------------------------------------ gates with injected faults (pure mirror of PostgreSQL items 14-15) */

const clone=x=>JSON.parse(JSON.stringify(x));
test('14 gates: cost_basis changed by 1e-18 is R7 COST_DRIFT, SPLIT_NULL, and NAV and returns are unchanged',()=>{
  const g=golden();g.stored.positions[0].cost_basis='52.550000000000000001';
  const r=gate(g);
  assert.equal(r.gates.R7.ok,false);
  assert.deepEqual(r.gates.R7.failures.map(f=>[f.check,f.code,f.effect,f.symbol,f.expected,f.actual]),[['R7','COST_DRIFT','SPLIT_NULL','BTCUSDT','52.550000000000000001','52.55']]);
  assert.deepEqual([...r.effects.split_null],['BTCUSDT']);assert.equal(r.effects.reconciliation_failed,false);
  const out=rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to:6000,rows:GOLDEN_BARS});
  assert.equal(out.money_pnl.value,'49.4');assert.equal(out.twr.value,'0.049716990702');assert.equal(out.nav_to.nav,'949.4');
  // the split numbers are null for the symbol, quantity and market value stay
  assert.equal(out.nav_to.unrealized,null);assert.equal(out.nav_to.realized,null);
  assert.equal(out.nav_to.positions[0].cost,null);assert.equal(out.nav_to.positions[0].market_value,'55');
  assert.equal(applySplitNull(navAt({replay:r.replay,seeds:r.seeds,instant:6000,rows:GOLDEN_BARS}),new Set()).unrealized,'2.45');
});
test('14 gates: a removed journal row is R1 (and R4 on cash), RECONCILIATION_FAILED, and every number is null',()=>{
  const g=golden();g.journal=g.journal.filter(j=>j.signal_id!==3);
  const r=gate(g);
  assert.deepEqual(r.gates.R1.failures.map(f=>[f.reason,f.event_key,f.effect]),[['FILL_WITHOUT_JOURNAL','3:2.5','RECONCILIATION_FAILED']]);
  assert.equal(r.gates.R4.ok,false);assert.equal(r.gates.R4.failures[0].field,'cash');
  assert.equal(r.effects.reconciliation_failed,true);
  const out=rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to:6000,rows:GOLDEN_BARS});
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.deepEqual([out[key].value,out[key].reasons],[null,['RECONCILIATION_FAILED']]);
  assert.equal(reconciliationBlocks(r.effects,6000),true);
});
test('14 gates: cash changed by 1e-18 is R4 and a journal delta off by 0.01 is R2, both RECONCILIATION_FAILED; neither is reported again as a broken identity',()=>{
  let g=golden();g.stored.cash='894.400000000000000001';
  let r=gate(g);
  assert.deepEqual(r.gates.R4.failures.map(f=>[f.field,f.expected,f.actual]),[['cash','894.400000000000000001','894.4']]);
  assert.equal(r.effects.reconciliation_failed,true);assert.equal(r.effects.account_unavailable,false);
  g=golden();g.journal[0].cash_delta='-200.21';
  r=gate(g);
  assert.deepEqual(r.gates.R2.failures.map(f=>[f.event_key,f.expected,f.actual]),[['1:2','-200.2','-200.21']]);
  assert.equal(r.gates.RI.ok,true); // RI checks the replay arithmetic against the cash the fills imply
  assert.equal(r.effects.reconciliation_failed,true);assert.equal(r.effects.account_unavailable,false);
  assert.equal(r.gates.R4.ok,false); // stored cash 894.4 against replayed 894.39
});
test('14 gates: RI reports QR2_IDENTITY_BROKEN with the first failing event and both values; the account then has no number (ACCOUNT_UNAVAILABLE)',()=>{
  const replay={halted:null,events:[
    {kind:'FILL',time:1900,key:'1:2',halted:false,epoch:'E2',findings:[],state:{identity_diff:'0',e0_clamp_total:'0'}},
    {kind:'FILL',time:2000,key:'2:1',halted:false,epoch:'E2',findings:[],state:{identity_diff:'-0.01',e0_clamp_total:'0'}}]};
  const ri=checkIdentity({replay,seeds:{s_cost:0}});
  assert.equal(ri.ok,false);
  assert.deepEqual(ri.failures,[{check:'RI',effect:'ACCOUNT_UNAVAILABLE',code:'QR2_IDENTITY_BROKEN',event_key:'2:1',time:2000,expected:'0',actual:'-0.01'}]);
  assert.deepEqual(checkIdentity({replay,seeds:{s_cost:null}}).not_run,'S_COST_UNAVAILABLE');
  assert.equal(checkIdentity({replay,seeds:{s_cost:1950}}).failures.length,1); // events before S_cost are not checked
  const g=golden(),real=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay:real,accountStart:0});
  const effects=effectsOf({findings:ri.failures,spans:[],replay:real});
  assert.equal(effects.account_unavailable,true);
  const out=rangePerformance({replay:real,seeds,effects,from:1500,to:6000,rows:GOLDEN_BARS});
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.deepEqual([out[key].value,out[key].reasons],[null,['ACCOUNT_UNAVAILABLE']]);
});
test('14 gates: an extra lot is ORPHAN_LOT (R6) and R5, SPLIT_NULL; an exit that cannot be replayed halts with RT and blocks only from that fill',()=>{
  let g=golden();
  g.storedLots.push({position_id:'GX',entry_signal_id:99,entry_trade_id:'T99',filled_quantity:'1',entry_price:'100',opened_at:2500,symbol:'BTCUSDT',remaining_quantity:'1',status:'OPEN',user_id:'u1',account_id:'binance-global:primary',execution_mode:'PAPER'});
  let r=gate(g);
  assert.deepEqual(r.gates.R6.failures.filter(f=>f.code==='ORPHAN_LOT').map(f=>[f.position_id,f.effect]),[['GX','SPLIT_NULL']]);
  assert.equal(r.gates.R5.ok,false);assert.deepEqual([...r.effects.split_null],['BTCUSDT']);assert.equal(r.effects.reconciliation_failed,false);
  g=golden();g.fills[2].payload=JSON.stringify({targetTradeId:'GHOST'}); // payload changed after execution (G4)
  r=gate(g);
  assert.equal(r.replay.halted.code,'TARGET_UNRESOLVED');
  assert.equal(r.effects.reconciliation_failed,true);assert.equal(r.effects.failed_from,4000);assert.equal(r.effects.failed_whole_account,false);
  assert.equal(reconciliationBlocks(r.effects,4000),false); // NAV(4000) uses events before the failing fill
  assert.equal(reconciliationBlocks(r.effects,4001),true);
  const before=rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to:4000,rows:GOLDEN_BARS});
  assert.equal(before.nav_to.nav,'1000.7'); // 694.7 + 3 x 102
  const after=rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to:6000,rows:GOLDEN_BARS});
  assert.deepEqual(after.twr.reasons,['RECONCILIATION_FAILED']);
});
test('14 gates: a cross-Bot row is QR2_CROSS_BOT_ROW (RX) and a Live row refuses the view QR2_NON_PAPER_ROW (RP)',()=>{
  let g=golden();g.fills[1].user_id='u2';
  let r=gate(g);
  assert.equal(r.row_scope.cross_bot,true);assert.deepEqual(r.row_scope.findings.map(f=>[f.check,f.code,f.table]),[['RX','QR2_CROSS_BOT_ROW','fills']]);
  g=golden();g.fills[1].execution_mode='LIVE';
  r=gate(g);
  assert.equal(r.refused,'QR2_NON_PAPER_ROW');
  assert.deepEqual(checkRowScope({scope:SCOPE,tables:{lots:[{account_id:'binance-th:primary'}]}}).findings.map(f=>f.code),['QR2_CROSS_BOT_ROW']);
  // no signal, journal key, funding id or position key may appear in two Bot views of one total
  const a=golden(),b=golden();
  assert.equal(checkCrossViewKeys([{id:'bot1',fills:a.fills,journal:a.journal,fundings:a.fundings,lots:a.lots},{id:'bot2',fills:[],journal:[],fundings:[],lots:[]}]).ok,true);
  const dup=checkCrossViewKeys([{id:'bot1',fills:a.fills,journal:a.journal,fundings:a.fundings,lots:a.lots},{id:'bot2',fills:b.fills,journal:b.journal,fundings:b.fundings,lots:b.lots}]);
  assert.equal(dup.ok,false);assert.equal(dup.code,'QR2_CROSS_BOT_ROW');
});
test('14 gates: R11 fee overlay refused, RC FUTURE_TIMESTAMP, R13 bound, status roll-up',()=>{
  const g=golden(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  assert.throws(()=>runGates({replay,seeds,fundings:g.fundings,journal:g.journal,fills:g.fills,storedLots:g.storedLots,stored:g.stored,snapshots:g.snapshots,scope:SCOPE,readTime:10000,feeOverlayBps:5}),{code:'QR2_FEE_OVERLAY_REFUSED'});
  const future=runGates({replay,seeds,fundings:g.fundings,journal:g.journal,fills:g.fills,storedLots:g.storedLots,stored:g.stored,snapshots:g.snapshots,scope:SCOPE,readTime:4500});
  assert.deepEqual(future.gates.RC.failures.map(f=>[f.code,f.event_key,f.table,f.time]),[['FUTURE_TIMESTAMP','F:2','paper_funding',5000],['FUTURE_TIMESTAMP','S:5','paper_snapshots',5000]]);
  assert.equal(future.effects.reconciliation_failed,true);
  const r13=checkR13({replay,storedLots:g.storedLots});
  // remaining 0.5 x 105.1 = 52.55 against position cost 52.55; bound 0.5e-18 x filled since flat 3
  assert.deepEqual(r13.rows,[{symbol:'BTCUSDT',lot_cost:'52.55',position_cost:'52.55',difference:'0',bound:'0.0000000000000000015',unlotted_quantity:'0',within_bound:true}]);
  assert.equal(worstStatus(['COMPLETE','PARTIAL','COMPLETE']),'PARTIAL');
  assert.equal(worstStatus(['COMPLETE','UNAVAILABLE','PARTIAL']),'UNAVAILABLE');
  assert.equal(worstStatus([]),'UNAVAILABLE');
});

test('10 status (section 10): COMPLETE, PARTIAL and UNAVAILABLE with overlays; lot methods met by the replay',()=>{
  const g=golden(),clean=gate(g);
  const run1=(over,rows=GOLDEN_BARS,from=1500,to=6000)=>{const r=gate(over);return {r,out:rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from,to,rows})};};
  let x=run1(g);
  assert.deepEqual(accountStatus({effects:x.r.effects,performance:x.out}),{status:'COMPLETE',overlays:[],reasons:[]});
  // cost drift: split numbers null, everything else stays: PARTIAL
  const drift=golden();drift.stored.positions[0].cost_basis='52.550000000000000001';
  x=run1(drift);
  assert.deepEqual(accountStatus({effects:x.r.effects,performance:x.out}),{status:'PARTIAL',overlays:[],reasons:['SPLIT_NULL']});
  // no price at the end: NAV(to) null, money PnL and returns null with the reason
  x=run1(g,[]);
  assert.equal(x.out.nav_from.nav,'1000');assert.equal(x.out.nav_to.nav,null);
  assert.deepEqual(accountStatus({effects:x.r.effects,performance:x.out}),{status:'PARTIAL',overlays:[],reasons:['UNAVAILABLE','TWR_BOUNDARY_UNVALUED','DRAWDOWN_GRID_UNVALUED']});
  // both ends unvalued: every needed price is missing
  x=run1(g,[],4500,6000);
  assert.deepEqual(accountStatus({effects:x.r.effects,performance:x.out}),{status:'UNAVAILABLE',overlays:[],reasons:['NO_VALUED_NAV']});
  // failed reconciliation, and no ledger rows
  const bad=golden();bad.journal=bad.journal.filter(j=>j.signal_id!==3);
  x=run1(bad);
  assert.deepEqual(accountStatus({effects:x.r.effects,performance:x.out}),{status:'UNAVAILABLE',overlays:[],reasons:['RECONCILIATION_FAILED']});
  assert.deepEqual(accountStatus({effects:clean.effects,performance:null,hasLedgerRows:false}).reasons,['NO_LEDGER_ROWS']);
  assert.deepEqual(accountStatus({effects:clean.effects,performance:{nav_from:{nav:'1',reasons:[]},nav_to:{nav:'1',reasons:[]},money_pnl:{value:'0'},twr:{value:'0'},mwr:{value:'0'},max_drawdown:{value:'0'}},unresolved:['COVERAGE_STARTS_AFTER_REQUEST']}),{status:'PARTIAL',overlays:[],reasons:['COVERAGE_STARTS_AFTER_REQUEST']});
  // a legacy period before the seeded state carries the legacy overlay
  const legacy=legacyAccount(),replay=run(legacy,'E2'),seeds=legacySeeds({fundings:legacy.fundings,fills:legacy.fills,replay,accountStart:0});
  const out=rangePerformance({replay,seeds,effects:effectsOf({findings:[],spans:[],replay}),from:200,to:900,rows:[barRow(900,'80')]});
  assert.deepEqual(out.twr.reasons,['LEGACY_FUNDING_HISTORY_UNAVAILABLE']);
  assert.deepEqual(accountStatus({effects:effectsOf({findings:[],spans:[],replay}),performance:out}).overlays,['RECONCILIATION_UNAVAILABLE_LEGACY']);
  // the lot methods of the epochs met go into the header
  const mixed=run(dataQ(),[{epoch:'E0',from:null,to:300},{epoch:'E2',from:300,to:null}]);
  assert.deepEqual(lotMethodsMet(mixed),['ledger-stored-lots-target-fifo-fallback-v1','paper-exit-cost-v2']);
  assert.deepEqual(lotMethodsMet(run(dataQ(),'E1')),['paper-exit-cost-o3-v1']);
});

/* ------------------------------------------------------------------ 10. ranges and periods (O9) */

test('10 ranges: UTC exclusive end at 00:00Z for custom windows, ISO week from Monday, day, month, year',()=>{
  // calendar days 2026-10-05 .. 2026-10-07 inclusive -> [10-05 00:00Z, 10-08 00:00Z)
  assert.deepEqual(customWindow(1791158400000+13*3600000,1791331200000+23*3600000+59999),{period_method:'utc-exclusive-isoweek-v1',kind:'CUSTOM',label:'Custom (UTC)',from:1791158400000,to:1791417600000});
  // Sunday 2026-10-11T23:59:59.999Z is the last millisecond of the week that began Monday 2026-10-05
  assert.deepEqual([periodWindow('WEEK',1791763199999).from,periodWindow('WEEK',1791763199999).to],[1791158400000,1791763200000]);
  assert.deepEqual([periodWindow('WEEK',1791763200000).from,periodWindow('WEEK',1791763200000).to],[1791763200000,1792368000000]);
  assert.equal(periodWindow('WEEK',1791763199999).label,'Week (Mon-Sun, UTC)');assert.equal(QR2_WEEK_LABEL,'Week (Mon-Sun, UTC)');
  assert.deepEqual([periodWindow('DAY',B+5000).from,periodWindow('DAY',B+5000).to],[1790812800000,1790899200000]);
  assert.deepEqual([periodWindow('MONTH',1771113600000).from,periodWindow('MONTH',1771113600000).to],[1769904000000,1772323200000]); // February 2026
  assert.deepEqual([periodWindow('MONTH',1797328800000).from,periodWindow('MONTH',1797328800000).to],[1796083200000,1798761600000]); // December wraps
  assert.deepEqual([periodWindow('YEAR',1771113600000).from,periodWindow('YEAR',1771113600000).to],[1767225600000,1798761600000]);
  assert.throws(()=>periodWindow('ROLLING7',B),{code:'QR2_RANGE_INVALID'});
  assert.equal(allTimeWindow({coverageStart:B,requestTime:B+1000}).label,'All Time Registered');
  assert.equal(firstFundingAt([fund(2,500,'1','1'),fund(1,300,'1','1','LEGACY_BASELINE')]),300);assert.equal(firstFundingAt([]),null);
});
test('10 ranges: to <= from is refused QR2_RANGE_INVALID; a from before coverage start keeps both intervals with COVERAGE_STARTS_AFTER_REQUEST',()=>{
  const now=1792497600000; // 2026-10-20T12:00Z
  assert.throws(()=>resolveRange({from:1791417600000,to:1791417600000,requestTime:now,coverageStart:0}),{code:'QR2_RANGE_INVALID'});
  assert.throws(()=>resolveRange({from:1791417600000,to:1791158400000,requestTime:now,coverageStart:0}),{code:'QR2_RANGE_INVALID'});
  assert.deepEqual(resolveRange({from:1791158400000,to:1791417600000,requestTime:now,coverageStart:B}),{requested:{from:1791158400000,to:1791417600000},resolved:{from:1791158400000,to:1791417600000},flags:[]});
  assert.deepEqual(resolveRange({from:1791158400000,to:1791417600000,requestTime:now,coverageStart:1791244800000}),{requested:{from:1791158400000,to:1791417600000},resolved:{from:1791244800000,to:1791417600000},flags:['COVERAGE_STARTS_AFTER_REQUEST']});
});
/* ------------------------------------------------------------------ 12. response validator, numbers, digests, dedup key */

const METHODS={valuation_method:{id:QR2_METHODS.valuation_method,fresh_ms:180000,carry_ms:900000},return_method:QR2_METHODS.return_method,lot_method:['paper-exit-cost-v2'],legacy_method:QR2_METHODS.legacy_method,
  order_method:QR2_METHODS.order_method,period_method:QR2_METHODS.period_method,drawdown_grid:QR2_METHODS.drawdown_grid,rounding:QR2_METHODS.rounding};
const header=()=>buildHeader({basis:'ACTUAL_PAPER_LEDGER',requested_range:{from:1,to:2},resolved_range:{from:1,to:2},as_of:2,first_funding_at:1,currency:'USDT',methods:METHODS,
  contract_id:'qr2-portfolio-performance-test',declaration_version:null,ledger_rule_epochs:['E2'],lot_epochs:['paper-exit-cost-v2']});
test('12 response validator: a complete Paper view passes; missing, foreign and mixed basis and historical_simulation true are refused',()=>{
  const ok={...header(),status:'COMPLETE',money_pnl:numberField({value:'49.4'}),accounts:[{basis:'ACTUAL_PAPER_LEDGER'}]};
  assert.deepEqual(validateResponse(ok),{ok:true,errors:[]});
  assert.deepEqual([ok.basis,ok.execution,ok.historical_simulation,ok.qualified_evidence,ok.fx],['ACTUAL_PAPER_LEDGER','PAPER_SIMULATED_FILLS',false,false,'NONE']);
  const {basis,...missing}=ok;void basis;
  assert.deepEqual(validateResponse(missing).errors,[{code:'BASIS_MISSING',path:'basis'}]);
  assert.deepEqual(validateResponse({...ok,basis:'HISTORICAL_SIMULATION'}).errors,[{code:'BASIS_FOREIGN',path:'basis'}]);
  assert.deepEqual(validateResponse({...ok,accounts:[{basis:'ACTUAL_PAPER_LEDGER'},{basis:'RESEARCH_REPLAY'}]}).errors,[{code:'BASIS_MIXED',path:'accounts[1].basis'}]);
  assert.deepEqual(validateResponse({...ok,basis:['ACTUAL_PAPER_LEDGER','RESEARCH_REPLAY']}).errors,[{code:'BASIS_MIXED',path:'basis'}]);
  assert.deepEqual(validateResponse({...ok,historical_simulation:true}).errors,[{code:'HISTORICAL_SIMULATION_NOT_FALSE',path:'historical_simulation'}]);
  assert.deepEqual(validateResponse({...ok,accounts:[{basis:'ACTUAL_PAPER_LEDGER',historical_simulation:true}]}).errors,[{code:'HISTORICAL_SIMULATION_NOT_FALSE',path:'accounts[0].historical_simulation'}]);
  assert.deepEqual(validateResponse({...ok,qualified_evidence:true}).errors,[{code:'QUALIFIED_EVIDENCE_NOT_FALSE',path:'qualified_evidence'}]);
  assert.deepEqual(validateResponse({...ok,execution:'LIVE'}).errors,[{code:'EXECUTION_LABEL_INVALID',path:'execution'}]);
  assert.deepEqual(validateResponse({...ok,fx:'USD'}).errors,[{code:'FX_NOT_NONE',path:'fx'}]);
  const {valuation_method,...noMethod}=ok;void valuation_method;
  assert.deepEqual(validateResponse(noMethod).errors,[{code:'HEADER_FIELD_MISSING',path:'valuation_method'}]);
  assert.throws(()=>buildHeader({basis:'HISTORICAL_SIMULATION',requested_range:null,resolved_range:null,as_of:1,first_funding_at:null,currency:'USDT',methods:METHODS}),{code:'QR2_BASIS_REFUSED'});
  assert.throws(()=>buildHeader({requested_range:null,resolved_range:null,as_of:1,first_funding_at:null,currency:'USDT',methods:METHODS}),{code:'QR2_BASIS_REFUSED'});
});
test('12 numbers: a null never serializes as 0; money and returns are decimal strings',()=>{
  assert.deepEqual(numberField({value:null,reasons:['TWR_BOUNDARY_UNVALUED']}),{value:null,status:'UNAVAILABLE',reasons:['TWR_BOUNDARY_UNVALUED']});
  assert.deepEqual(numberField({value:'0'}),{value:'0',status:'COMPLETE',reasons:[]});
  assert.notDeepEqual(numberField({value:null,reasons:['X']}).value,numberField({value:'0'}).value);
  assert.throws(()=>numberField({value:null}),{code:'QR2_NULL_WITHOUT_REASON'});
  assert.throws(()=>numberField({value:0}),TypeError);
  assert.throws(()=>numberField({value:'1e-7'}),TypeError);
  const view={...header(),a:{value:null,status:'UNAVAILABLE',reasons:[]},b:{value:0,status:'COMPLETE',reasons:[]},c:{value:'5',status:'UNAVAILABLE',reasons:['X']}};
  assert.deepEqual(validateResponse(view).errors.map(e=>[e.code,e.path]),[['NULL_WITHOUT_REASON','a.value'],['NUMBER_NOT_DECIMAL_STRING','b.value'],['VALUE_WITH_UNAVAILABLE_STATUS','c.status']]);
});
test('12 audit dedup key: same defect one key, new defect new key; at most 20 distinct keys per request',()=>{
  const defect={method_id:'paper-exit-cost-v2',bot_id:'bot_7',broker:'binance-global',check_id:'R7',first_row_key:'3:2.5'};
  assert.equal(auditDedupKey(defect),'e598cd2c70a6272c4135dd5278d140d1f9ea3188d5386406650d98a36bdb7ac1'); // sha256 of ["paper-exit-cost-v2","bot_7","binance-global","R7","3:2.5"]
  assert.equal(auditDedupKey({...defect}),auditDedupKey(defect));
  for(const change of [{first_row_key:'4:1'},{check_id:'R6'},{bot_id:'bot_8'},{broker:'binance-th'},{method_id:'paper-exit-cost-o3-v1'}])assert.notEqual(auditDedupKey({...defect,...change}),auditDedupKey(defect));
  const findings=[{check:'R7',event_key:'3:2.5'},{check:'R7',event_key:'3:2.5'},{check:'R6',position_id:'GX',event_key:null},{check:'R4',symbol:'BTCUSDT'}];
  const picked=selectAuditKeys({findings,method_id:'paper-exit-cost-v2',bot_id:'bot_7',broker:'binance-global'});
  assert.equal(picked.length,3);assert.equal(picked[0].key,auditDedupKey(defect));
  const flood=Array.from({length:50},(_,i)=>({check:'R7',event_key:'k'+i}));
  assert.equal(selectAuditKeys({findings:flood,method_id:'x',bot_id:'b',broker:'binance-global'}).length,20);
  // the same GET twice yields the same keys, so a second GET adds none
  assert.deepEqual(selectAuditKeys({findings,method_id:'paper-exit-cost-v2',bot_id:'bot_7',broker:'binance-global'}),picked);
});
test('12 inputs_hash: row content, not only keys; prices as (bar_time, content_hash) or UNPRICED; digests only when to is the request time',()=>{
  const fundRow={id:1,user_id:'u1',broker:'binance-global',at:1000,equity_delta:'1000',cash_delta:'1000',kind:'CONFIGURATION'};
  const journalRow={signal_id:1,cumulative_quantity:'2',cash_delta:'-200.2',at:2000,user_id:'u1',broker:'binance-global'};
  const fillRow={signal_id:1,cumulative_quantity:'2',delta_quantity:'2',price:'100',fee_quote:'0.2',quote_amount:'200',received_at:2000,legacy_float:0,side:'BUY',symbol:'BTCUSDT',trade_id:'T1',payload:'{}'};
  const input=(fill=fillRow)=>({methods:{valuation_method:'btcusdt-1m-close-asof-market-v1'},scope:{bot_id:'bot_7',broker:'binance-global'},period:{from:1000,to:6000},
    accounts:[{id:'acct1',fundings:[fundRow],journal:[journalRow],fills:[fill]}],prices:[{instant:6000,symbol:'BTCUSDT',ref:[6000,'abc']},{instant:5000,symbol:'BTCUSDT',ref:'UNPRICED'}],to:6000,requestTime:7000});
  assert.equal(inputsHash(input()),'943b4270fc7f3751a5161de21107991209113b7876130ec4da36dbdccedf3c58');
  assert.equal(inputsHash(input()),inputsHash(clone(input()))); // identical inputs give identical digests
  // an in-place UPDATE of fills.fee_quote changes the hash although every key is the same
  assert.equal(inputsHash(input({...fillRow,fee_quote:'0.21'})),'4fba83ef5a5678ebec0cc369134948cad866917d7efef12d4574309732a88503');
  const nowInput={...input(),requestTime:6000,positions:[{symbol:'BTCUSDT',quantity:'2',cost_basis:'200.2'}],lots:[{position_id:'L1',remaining_quantity:'2',status:'OPEN'}]};
  assert.equal(inputsHash(nowInput),'0e7d1df6140a7dbf46c395c5417229433ba01377d90f537271e12bc882382307');
  assert.notEqual(inputsHash({...nowInput,positions:[{symbol:'BTCUSDT',quantity:'2',cost_basis:'200.21'}]}),inputsHash(nowInput));
  // rows stamped at or after `to` are not inputs
  const late={...fillRow,signal_id:9,received_at:6000};
  assert.equal(inputsHash({...input(),accounts:[{id:'acct1',fundings:[fundRow],journal:[journalRow],fills:[fillRow,late]}]}),inputsHash(input()));
  assert.equal(rowsDigest([{a:1},{b:2}]),rowsDigest([{b:2},{a:1}]));
});

/* ------------------------------------------------------------------ fix round: root rulings RC-Q1 to RC-Q19 */

// A gate run over hand-built data: replay under one epoch, stored lots with remaining/status and stored positions as given.
function gateData(data,{epoch='E2',storedLots,stored,snapshots=[],extra={}}={}){
  const replay=run({fundings:data.fundings,fills:data.fills,journal:data.journal,lots:data.lots},epoch,extra);
  const seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  const gates=runGates({replay,seeds,fundings:data.fundings,journal:data.journal,fills:data.fills,storedLots,stored,snapshots,scope:SCOPE,readTime:1000000});
  return {replay,seeds,...gates};
}

test('6 N1/N2 span (RC-Q1): a cash-only legacy baseline followed by a BUY has an equity floor below zero but no violation, no span and no overlay',()=>{
  // LEGACY_BASELINE cash 150 with equity 0; BUY 100 at 200: cash 50, equity floor 0 + (-100) = -100. N2 is a CONFIGURATION-row gate.
  const data=set([fund(1,100,'0','150','LEGACY_BASELINE')],[buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}})]);
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  assert.equal(ev(replay,'1:1').state.equity_floor,'-100');assert.equal(ev(replay,'1:1').state.cash,'50');
  const inv=checkLedgerInvariants({replay,seeds});
  assert.equal(inv.ok,true);assert.deepEqual(inv.violations,[]);assert.deepEqual(inv.spans,[]);
  const effects=effectsOf({findings:inv.violations,spans:inv.spans,replay});
  assert.equal(effects.ledger_invariant_violated,false);
  // returns are not nulled by an overlay that was never recorded
  assert.equal(seeds.nav_from,101);
  const out=rangePerformance({replay,seeds,effects,from:101,to:300,rows:[barRow(150,'100')]});
  assert.equal(out.twr.value,'0');assert.deepEqual(out.twr.reasons,[]);
});
test('6 N1/N2 span (RC-Q1): N2 alone opens a span at a CONFIGURATION row and the span closes at the first later event with cash >= 0 and floor >= 0',()=>{
  // deposit 100/100, BUY 100 (cash 0, floor 0), then an equity-only withdrawal of 50: cash 0 but floor 50 + (-100) = -50: N2 only
  const data=set([fund(1,100,'100','100'),fund(2,300,'-50','0')],[
    buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}}),
    sell({s:2,qty:'1',quote:'100',at:400,cash:'100'})]);
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  const inv=checkLedgerInvariants({replay,seeds});
  assert.deepEqual(inv.violations.map(v=>[v.check,v.event_key,v.value]),[['N2','F:2','-50']]);
  assert.deepEqual(inv.spans,[{from:300,to:400,start_event_key:'F:2',end_event_key:'2:1'}]);
  assert.equal(ev(replay,'2:1').state.equity_floor,'50');
});
test('6 N1 (M35): a cash balance of exactly zero is not a violation',()=>{
  const data=set([fund(1,100,'100','100')],[buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}})]);
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  assert.equal(ev(replay,'1:1').state.cash,'0');
  const inv=checkLedgerInvariants({replay,seeds});
  assert.equal(inv.ok,true);assert.deepEqual(inv.violations,[]);assert.deepEqual(inv.spans,[]);
});
test('6 N1/N2 span end (RC-Q17, M34): the end is inclusive, so a period that starts at the recovering event is still in the span',()=>{
  const g=f4([sell({s:2,qty:'400',quote:'40',at:4000,cash:'40'})]),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.lots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const spans=checkLedgerInvariants({replay,seeds}).spans;
  assert.equal(spans[0].to,4000);
  assert.equal(intersectsSpan(spans,4000,5000),true);   // from === span.to
  assert.equal(intersectsSpan(spans,4001,5000),false);
  assert.equal(intersectsSpan(spans,1000,3000),false);  // [1000, 3000) ends before the violating event
  assert.equal(intersectsSpan(spans,1000,3001),true);
  assert.equal(intersectsSpan([{from:3000,to:null}],9e12,9e12+1),true); // an unrecovered span reaches every later period
});

test('14 gates (RC-Q2): a row of another Bot refuses the whole view QR2_CROSS_BOT_ROW and no number is produced',()=>{
  const g=golden();g.fills[1].user_id='u2';
  const r=gate(g);
  assert.equal(r.refused,'QR2_CROSS_BOT_ROW');assert.equal(r.effects.refused,'QR2_CROSS_BOT_ROW');
  const out=rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to:6000,rows:GOLDEN_BARS});
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.deepEqual([out[key].value,out[key].status,out[key].reasons],[null,'UNAVAILABLE',['QR2_CROSS_BOT_ROW']]);
  assert.equal(out.nav_from,undefined);assert.equal(out.nav_to,undefined);assert.equal(out.refused,'QR2_CROSS_BOT_ROW');
  assert.deepEqual(accountStatus({effects:r.effects,performance:out}),{status:'REFUSED',overlays:[],reasons:['QR2_CROSS_BOT_ROW']});
  // a foreign journal row or lot refuses the same way; a Live row is reported as QR2_NON_PAPER_ROW and wins
  const j=golden();j.journal[0].broker='binance-th';
  assert.equal(gate(j).refused,'QR2_CROSS_BOT_ROW');
  const both=golden();both.fills[1].user_id='u2';both.fills[0].execution_mode='LIVE';
  assert.equal(gate(both).refused,'QR2_NON_PAPER_ROW');
});

test('10 status (RC-Q3): a range that ends at or before the failing fill is PARTIAL with RECONCILIATION_FAILED_AFTER_RANGE; one that reaches it is UNAVAILABLE',()=>{
  const g=golden();g.fills[2].payload=JSON.stringify({targetTradeId:'GHOST'}); // the replay halts at the exit stamped 4000
  const r=gate(g);
  const run2=(to)=>rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to,rows:GOLDEN_BARS});
  const before=run2(4000);
  assert.equal(before.nav_to.nav,'1000.7');assert.notEqual(before.money_pnl.value,null);
  assert.deepEqual(accountStatus({effects:r.effects,performance:before}),{status:'PARTIAL',overlays:[],reasons:['RECONCILIATION_FAILED_AFTER_RANGE']});
  assert.deepEqual(accountStatus({effects:r.effects,performance:before,to:4000}).reasons,['RECONCILIATION_FAILED_AFTER_RANGE']);
  const reaching=run2(4001);
  assert.deepEqual(accountStatus({effects:r.effects,performance:reaching}),{status:'UNAVAILABLE',overlays:[],reasons:['RECONCILIATION_FAILED']});
  assert.deepEqual(accountStatus({effects:r.effects,performance:reaching,to:4001}).status,'UNAVAILABLE');
  // W5 (round 5): a `to` that differs from performance.range.to is refused, fail closed (kills a swapped to-order)
  assert.throws(()=>accountStatus({effects:r.effects,performance:before,to:4001}),{code:'QR2_INPUT_INVALID'});
  assert.throws(()=>accountStatus({effects:r.effects,performance:reaching,to:4000}),{code:'QR2_INPUT_INVALID'});
  // a whole-account failure blocks every range end
  const whole=golden();whole.journal=whole.journal.filter(x=>x.signal_id!==3);
  const w=gate(whole);
  assert.equal(accountStatus({effects:w.effects,performance:null,to:1}).status,'UNAVAILABLE');
});
test('14 gates (RC-Q5): a range identity break is QR2_IDENTITY_BROKEN, the account is ACCOUNT_UNAVAILABLE and has no number',()=>{
  const g=golden();g.journal[0].cash_delta='-200.21'; // the journal says 0.01 more cash left than the fill implies
  const replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2'),seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const effects=effectsOf({findings:[],spans:[],replay}); // gates R1/R2 are not consulted: the range identity is what is under test
  const out=rangePerformance({replay,seeds,effects,from:1500,to:6000,rows:GOLDEN_BARS});
  // NAV(to) = 894.39 + 55 = 949.39 against delta R 46.95 + delta U 2.45 = 49.4
  assert.deepEqual([out.identity.ok,out.identity.expected,out.identity.actual,out.identity.code],[false,'49.4','49.39','QR2_IDENTITY_BROKEN']);
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.deepEqual([out[key].value,out[key].reasons],[null,['QR2_IDENTITY_BROKEN']]);
  assert.equal(out.account_unavailable,true);
  assert.deepEqual(accountStatus({effects,performance:out}),{status:'UNAVAILABLE',overlays:[],reasons:['ACCOUNT_UNAVAILABLE','QR2_IDENTITY_BROKEN']});
});

test('1 replay (RC-Q6): a replayed COST_CLAMPED is SPLIT_NULL for its symbol under E2 and E0 while NAV and returns stay',()=>{
  for(const [epoch,keys] of [['E2',['3:1']],['E0',['3:1','4:1']]]){
    const data=dataV();
    const storedLots=data.lots.map(l=>({...l,remaining_quantity:'0',status:'CLOSED'}));
    const g=gateData(data,{epoch,storedLots,stored:{positions:[{symbol:'BTCUSDT',quantity:'0',cost_basis:'0'}],cash:'930'}});
    const clamps=g.findings.filter(f=>f.check==='R14');
    assert.deepEqual(clamps.map(f=>[f.code,f.effect,f.symbol,f.event_key]),keys.map(k=>['COST_CLAMPED','SPLIT_NULL','BTCUSDT',k]),epoch);
    assert.deepEqual([...g.effects.split_null],['BTCUSDT'],epoch);
    assert.equal(g.effects.reconciliation_failed,false);
    const out=rangePerformance({replay:g.replay,seeds:g.seeds,effects:g.effects,from:50,to:500,rows:[barRow(40,'100'),barRow(450,'100')]});
    assert.equal(out.nav_to.nav,'930');assert.equal(out.nav_to.realized,null);assert.equal(out.nav_to.unrealized,null);
  }
});

test('4 legacy (RC-Q7): LEGACY_DUST needs an M1 marker, otherwise the same difference is a plain R4 quantity failure',()=>{
  const data=set([],[
    buy({s:1,qty:'1',quote:'50',at:100,cash:'-50'}),
    sell({s:2,qty:'0.9999999999999',quote:'60',at:200,cash:'60'})]); // no legacy_float marker anywhere
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:[],fills:data.fills,replay,accountStart:0});
  assert.equal(seeds.has_m1,false);
  const stored={positions:[{symbol:'BTCUSDT',quantity:'0',cost_basis:'0'}],cash:'10'};
  const plain=checkR4({replay,stored,seeds});
  assert.deepEqual(plain.failures.map(f=>[f.code,f.symbol,f.amount,f.expected,f.actual]),[['RECONCILIATION_FAILED','BTCUSDT',undefined,'0','0.0000000000001']]);
  assert.equal(checkR4({replay,stored}).failures[0].code,'RECONCILIATION_FAILED'); // no seeds: no marker is known
});
test('4 legacy (RC-Q8): a duplicate fill or journal key follows the S_cash split by the time of the duplicate row',()=>{
  const late=buy({s:2,qty:'1',quote:'10',at:600,cash:'-10'}),early=buy({s:3,qty:'1',quote:'10',at:400,cash:'-10'});
  const r=checkR1({fills:[late.f,{...late.f},early.f,{...early.f}],journal:[late.j,{...late.j},early.j,{...early.j}],scope:SCOPE,sCash:500});
  const view=list=>list.map(f=>[f.reason,f.event_key,f.time]).sort();
  assert.deepEqual(view(r.failures),[['DUPLICATE_FILL_KEY','2:1',600],['DUPLICATE_JOURNAL_KEY','2:1',600]]);
  assert.deepEqual(view(r.information),[['DUPLICATE_FILL_KEY','3:1',400],['DUPLICATE_JOURNAL_KEY','3:1',400]]);
  assert.equal(r.ok,false);
});
test('4 legacy (RC-Q17): a legacy fill without quote_amount uses quantity x price unrounded, labelled QUOTE_FROM_PRICE_LEGACY; a non-legacy fill is QR2_INPUT_INVALID',()=>{
  const f=buy({s:1,qty:'2',quote:null,price:'30.5',at:100,cash:'-61',legacy:1}).f;
  const r=run({fundings:[],fills:[f],journal:[],lots:[]},'E2');
  assert.equal(ev(r,'1:2').state.positions.BTCUSDT.cost,'61');
  const note=ev(r,'1:2').findings.find(x=>x.code==='QUOTE_FROM_PRICE_LEGACY');
  assert.deepEqual([note.amount,note.symbol],['61','BTCUSDT']);
  const bad=buy({s:1,qty:'2',quote:null,price:'30',at:100,cash:'-60'}).f;
  assert.throws(()=>run({fundings:[],fills:[bad],journal:[],lots:[]},'E2'),{code:'QR2_INPUT_INVALID'});
  // the refusal happens before any event is replayed, also for a fill behind an earlier halt
  assert.throws(()=>run({fundings:[],fills:[buy({s:0,qty:'1',quote:'1',at:1,cash:'-1'}).f,bad],journal:[],lots:[]},[{epoch:'E2',from:null,to:50}]),{code:'QR2_INPUT_INVALID'});
});
test('4 legacy (RC-Q17): nav_from is S_cash + 1 with an M2 row, and a period starting exactly at S_cash has no return',()=>{
  const data=legacyAccount(),replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  assert.equal(seeds.s_cash,500);assert.equal(seeds.nav_from,501);
  assert.equal(navAt({replay,seeds,instant:500,rows:[]}).nav,null); // the state at S_cash excludes the baseline row stamped S_cash (2.6)
  assert.deepEqual(navAt({replay,seeds,instant:500,rows:[]}).reasons,['RECONCILIATION_UNAVAILABLE_LEGACY']);
  const effects=effectsOf({findings:[],spans:[],replay}),rows=[barRow(500,'60'),barRow(900,'80')];
  const atSCash=rangePerformance({replay,seeds,effects,from:500,to:900,rows});
  assert.deepEqual([atSCash.twr.value,atSCash.twr.reasons],[null,['LEGACY_FUNDING_HISTORY_UNAVAILABLE']]);
  // M19: a period starting exactly at nav_from has a return: NAV(501) = 100 + 1 x 60, NAV(900) = 170 (flat after the exit at 800)
  const atNavFrom=rangePerformance({replay,seeds,effects,from:501,to:900,rows});
  assert.deepEqual([atNavFrom.nav_from.nav,atNavFrom.nav_to.nav],['160','170']);
  assert.deepEqual([atNavFrom.money_pnl.value,atNavFrom.twr.value,atNavFrom.mwr.value,atNavFrom.max_drawdown.value],['10','0.0625','0.0625','0']);
  assert.deepEqual(atNavFrom.twr.reasons,[]);
});

test('5 R3c (RC-Q16): a halted replay is NOT_RUN with REPLAY_HALTED',()=>{
  const g=golden();g.fills[2].payload=JSON.stringify({targetTradeId:'GHOST'});
  const replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  assert.equal(replay.halted.code,'TARGET_UNRESOLVED');
  const r=checkCommitOrder({replay,snapshots:g.snapshots,seeds});
  assert.deepEqual([r.status,r.reason,r.results,r.ok],['NOT_RUN','REPLAY_HALTED',[],null]);
});
test('5 R3c (RC-Q17): a FUNDING snapshot mismatch without the F4 signature is FUNDING_SNAPSHOT_MISMATCH; a snapshot count that differs adds one SNAPSHOT_COUNT_MISMATCH',()=>{
  const g=golden(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const bad=g.snapshots.map(s=>s.id===5?{...s,cash:'1'}:s);
  const r=checkCommitOrder({replay,snapshots:bad,seeds}).results[4];
  assert.deepEqual([r.status,r.snapshot_reason],['FUNDING_SNAPSHOT_MISMATCH','FUNDING']);
  assert.deepEqual(r.expected,{cash:'894.4',book_equity:'946.95',position_cost:'52.55'});
  assert.deepEqual(r.actual,{cash:'1',book_equity:'946.95',position_cost:'52.55'});
  const full=checkCommitOrder({replay,snapshots:g.snapshots,seeds});
  assert.deepEqual(full.diagnostics,[]);assert.equal(full.ok,true);
  const missing=checkCommitOrder({replay,snapshots:g.snapshots.slice(1),seeds});
  assert.deepEqual(missing.diagnostics,[{code:'SNAPSHOT_COUNT_MISMATCH',snapshots:4,events:5}]);
  assert.equal(missing.ok,false);
  assert.equal(missing.results[1].status,'MATCH'); // tail alignment is kept
});

test('2 epoch selection (RC-Q17): a closure failure is LEDGER_RULE_UNREPLAYABLE from that fill; R3c stays a diagnostic with no effect',()=>{
  const r=run(dataR(targeted('ZZ','1','130')),'E2');
  assert.deepEqual(r.unreplayable_from,{index:4,time:400,key:'3:1',reason:'TARGET_UNRESOLVED'});
  assert.equal(r.findings.find(f=>f.code==='TARGET_UNRESOLVED').effect,'RECONCILIATION_FAILED');
  const clean=run(dataR(),'E2');
  assert.equal(clean.unreplayable_from,null);
});
test('2 epoch selection (RC-Q17): the boundary wins over the marker; DISAGREES is information and counted, never a finding',()=>{
  const data=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',marker:'paper-exit-cost-v2'}),
    buy({s:2,qty:'1',quote:'200',at:200,cash:'-200',lot:{id:'Q2',price:'200'}}),
    sell({s:3,qty:'1.5',quote:'360',at:300,cash:'360',marker:'paper-exit-cost-o3-v1'})]);
  const r=run(data,EP('E2'));
  assert.deepEqual(markerCounts(r),{AGREES:1,DISAGREES:1,ABSENT:1});
  assert.equal(ev(r,'3:1.5').epoch,'E2');
  assert.deepEqual(ledgerRuleEpochsMet(r),['E2']);
  const g=gateData(data,{storedLots:[],stored:{positions:[{symbol:'BTCUSDT',quantity:'0.5',cost_basis:'50'}],cash:'1060'}});
  assert.deepEqual(g.marker_counts,{AGREES:1,DISAGREES:1,ABSENT:1});
  assert.ok(!g.findings.some(f=>f.marker_check==='DISAGREES'||f.code==='MARKER_DISAGREES'));
  const mixed=run(dataQ(),[{epoch:'E0',from:null,to:300},{epoch:'E2',from:300,to:null}]);
  assert.deepEqual(ledgerRuleEpochsMet(mixed),['E0','E2']);
});

test('1 replay (RC-Q14): an E0 fill before the lot-table boundary replays with targetTradeId ignored; without the boundary, or under E2, the target is honoured',()=>{
  const data=()=>dataR(targeted('ZZ','1','130'));
  assert.equal(run(data(),'E0').halted.code,'TARGET_UNRESOLVED'); // no boundary recorded: the halt stays
  const before=run(data(),'E0',{lotTableBoundary:401}),s=ev(before,'3:1');
  assert.equal(before.halted,null);
  // FIFO over the symbol: R1a 0.4 x 100 + R1b 0.6 x 110 = 106 removed, realized 130 - 106
  assert.equal(s.removed_cost,'106');assert.equal(s.realized_delta,'24');assert.deepEqual(s.consumed,[{position_id:'R1a',take:'0.4'},{position_id:'R1b',take:'0.6'}]);
  assert.equal(before.method.lot_table_boundary,401);
  assert.equal(run(data(),'E0',{lotTableBoundary:400}).halted.code,'TARGET_UNRESOLVED'); // the fill at 400 is not before 400
  assert.equal(run(data(),'E2',{lotTableBoundary:401}).halted.code,'TARGET_UNRESOLVED'); // E0 only
  assert.throws(()=>run(data(),'E0',{lotTableBoundary:'x'}),{code:'QR2_INPUT_INVALID'});
});

test('1 replay and R6 (RC-Q17): LOT_ORDER_AMBIGUOUS is SPLIT_NULL when the tie group has different entry prices; equal prices are information and R6 compares the group sum',()=>{
  const stateOf=(data,swap)=>{ // the ledger took pos_x (replay order) or, for the other physical order, pos_y
    return data.lots.map(l=>{const closed=swap?l.position_id==='pos_y':l.position_id==='pos_x';return {...l,remaining_quantity:closed?'0':'1',status:closed?'CLOSED':'OPEN'};});
  };
  const stored=(cost,cash)=>({positions:[{symbol:'BTCUSDT',quantity:'1',cost_basis:cost}],cash});
  // different prices (100 and 110): the cost removed depends on the physical order
  let data=dataW('1');
  let g=gateData(data,{storedLots:stateOf(data,false),stored:stored('110','910')});
  assert.deepEqual(g.findings.filter(f=>f.code==='LOT_ORDER_AMBIGUOUS').map(f=>[f.check,f.effect,f.symbol,f.opened_at]),[['R6','SPLIT_NULL','BTCUSDT',1000]]);
  assert.deepEqual([...g.effects.split_null],['BTCUSDT']);assert.equal(g.effects.reconciliation_failed,false);
  // the finding is also an R6 failure (RC-Q17, round 3 T5): gates.R6.ok is false and the finding is listed once
  assert.equal(g.gates.R6.ok,false);
  assert.deepEqual(g.gates.R6.failures.filter(f=>f.code==='LOT_ORDER_AMBIGUOUS').map(f=>[f.check,f.effect,f.symbol,f.opened_at]),[['R6','SPLIT_NULL','BTCUSDT',1000]]);
  assert.equal(g.findings.filter(f=>f.code==='LOT_ORDER_AMBIGUOUS').length,1);
  // equal prices: information; the stored lots may differ per position_id, the group sum decides
  data=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:1000,cash:'-100',lot:{id:'pos_x',price:'100'}}),
    buy({s:2,qty:'1',quote:'100',at:1000,cash:'-100',lot:{id:'pos_y',price:'100'}}),
    sell({s:3,qty:'1',quote:'120',at:2000,cash:'120'})]);
  for(const swap of [false,true]){
    g=gateData(data,{storedLots:stateOf(data,swap),stored:stored('100','920')});
    assert.equal(g.gates.R6.ok,true,'swap '+swap);
    assert.deepEqual(g.information.filter(f=>f.code==='LOT_ORDER_AMBIGUOUS').map(f=>[f.opened_at,f.cost_changes]),[[1000,false]]);
    assert.equal(g.effects.split_null.size,0);
  }
  // a group sum that differs is still a failure
  const lost=stateOf(data,false).map(l=>({...l,remaining_quantity:'0',status:'CLOSED'}));
  g=gateData(data,{storedLots:lost,stored:stored('100','920')});
  assert.deepEqual(g.gates.R6.failures.map(f=>[f.code,f.tie_group,f.expected,f.actual]),[['LOT_REMAINING_MISMATCH',true,'0','1']]);
});

test('3 grid and labels (RC-Q17): the drawdown grid ends at the resolved to, drawdown is a positive fraction, a gating label makes a number PARTIAL and PRICE_STALE stays COMPLETE',()=>{
  const g=golden(),replay=run({fundings:g.fundings,fills:g.fills,journal:g.journal,lots:g.storedLots},'E2');
  assert.deepEqual(gridPoints({replay,from:1500,to:6000,flows:[]}).slice(-1),[6000]);
  const seeds=legacySeeds({fundings:g.fundings,fills:g.fills,replay,accountStart:0});
  const out=rangePerformance({replay,seeds,effects:effectsOf({findings:[],spans:[],replay}),from:1500,to:6000,rows:GOLDEN_BARS});
  assert.ok(D(out.max_drawdown.value).gt(0)); // 0.0002 as a positive fraction of the peak, not -0.0002
  // a gating label (a violation span the period intersects) makes the money PnL PARTIAL; the null returns are UNAVAILABLE
  const f=f4([sell({s:2,qty:'400',quote:'40',at:4000,cash:'40'})]),fr=run({fundings:f.fundings,fills:f.fills,journal:f.journal,lots:f.lots},'E2');
  const fs=legacySeeds({fundings:f.fundings,fills:f.fills,replay:fr,accountStart:0}),inv=checkLedgerInvariants({replay:fr,seeds:fs});
  const violated=rangePerformance({replay:fr,seeds:fs,effects:effectsOf({findings:inv.violations,spans:inv.spans,replay:fr}),from:2500,to:3500,rows:[barRow(2500,'0.1'),barRow(3500,'0.1')]});
  assert.deepEqual([violated.money_pnl.status,violated.money_pnl.reasons],['PARTIAL',['LEDGER_INVARIANT_VIOLATED']]);
  assert.deepEqual([violated.twr.status,violated.twr.value],['UNAVAILABLE',null]);
  assert.deepEqual(validateResponse({...header(),money_pnl:violated.money_pnl}).errors,[]);
});
test('3 exposure (RC-Q17, M17, M21): rounded to 12 places half-even; a NAV of exactly 0 or less has no exposure',()=>{
  assert.deepEqual(exposure({available:true,nav:'0',market_value:'0',reasons:[]}),{value:null,basis:null,reason:'NON_POSITIVE_NAV'});
  assert.deepEqual(exposure({available:true,nav:'-1',market_value:'5',reasons:[]}),{value:null,basis:null,reason:'NON_POSITIVE_NAV'});
  assert.deepEqual(exposure({available:true,nav:'1',market_value:'0.5',reasons:[]}),{value:'0.5',basis:'MARKET_VALUE_OVER_NAV'});
  // ties at the 13th decimal go to the even neighbour
  assert.equal(round12('0.0000000000005'),'0');             // 0.000000000000|5 -> even 0
  assert.equal(round12('0.0000000000015'),'0.000000000002'); // 1|5 -> even 2
  assert.equal(round12('0.0000000000025'),'0.000000000002'); // 2|5 -> even 2
  assert.equal(round12('0.0000000000035'),'0.000000000004');
  assert.equal(round12('-0.0000000000015'),'-0.000000000002');
  assert.equal(exposure({available:true,nav:'1',market_value:'0.0000000000005',reasons:[]}).value,'0');
  assert.equal(exposure({available:true,nav:'1',market_value:'0.0000000000015',reasons:[]}).value,'0.000000000002');
});
test('8 drawdown (M20): a return to an earlier peak does not move the peak time',()=>{
  const day=86400000;
  // deposit 1000, BUY 5 @ 100; the grid is the range ends and every 00:00Z. NAV = 500 + 5 x price
  const data=set([fund(1,B-4*day,'1000','1000')],[buy({s:1,qty:'5',quote:'500',at:B-4*day+60000,cash:'-500',lot:{id:'P',price:'100'}})]);
  const from=B-2*day+3600000,to=B+3*day+3600000;
  const rows=[[from,'100'],[B-day,'150'],[B,'100'],[B+day,'150'],[B+2*day,'80'],[B+3*day,'100'],[to,'100']].map(([t,p])=>barRow(t,p));
  const {out}=perf(data,{from,to,rows});
  // NAV 1000, 1250, 1000, 1250, 900: index 1 -> 1.25 (peak at B-1d) -> 1 -> 1.25 (back to the peak, not above it) -> 0.9; every ratio is exact
  assert.equal(out.max_drawdown.value,'0.28'); // (1.25 - 0.9) / 1.25
  assert.deepEqual([out.detail.drawdown.peak_time,out.detail.drawdown.trough_time],[B-day,B+2*day]);
});

test('2 event order (RC-Q15, RC-Q17, M26): a funding row sorts before a fill stamped in the same millisecond; a fill and its journal row are one event at received_at',()=>{
  const data=set([fund(1,500,'100','100')],[buy({s:1,qty:'1',quote:'100',at:500,jat:499,cash:'-100',lot:{id:'A',price:'100'}})]);
  const r=run(data,'E2');
  assert.deepEqual(r.events.map(e=>e.key),['F:1','1:1']);
  assert.equal(ev(r,'1:1').state.cash,'0'); // the deposit is applied first, so the fill never sees a negative cash balance
  assert.equal(ev(r,'1:1').cash_delta,'-100');
  assert.equal(stateAt(r,500).state.cash,'0');           // neither the funding row nor the fill (and its journal cash) is before 500
  assert.deepEqual(stateAt(r,500).state.positions,{});
  assert.equal(stateAt(r,501).state.cash,'0');
  assert.deepEqual(stateAt(r,501).state.positions.BTCUSDT,{quantity:'1',cost:'100'});
  const seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay:r,accountStart:0});
  assert.equal(checkLedgerInvariants({replay:r,seeds}).ok,true);
  assert.equal(r.events.some(e=>e.kind==='JOURNAL'),false); // the journal row did not become an event of its own at 499
});

test('1 replay (M32): ledger.cost_divergence is expected above 1e-12 and not at exactly 1e-12; E2 compares signed when part of the exit is unlotted',()=>{
  for(const epoch of ['E1','E2']){
    const audit=price2=>ev(run(dataX(price2),epoch),'3:2').expected_audit;
    assert.deepEqual(audit('100.0000000001'),['ledger.cost_divergence'],epoch);  // lots 200.0000000001 against position cost 200: 1e-10
    assert.deepEqual(audit('100.000000000002'),['ledger.cost_divergence'],epoch);
    assert.deepEqual(audit('100.000000000001'),[],epoch);                          // exactly 1e-12: not above the band
    assert.deepEqual(audit('99.9999999999'),['ledger.cost_divergence'],epoch);     // lots below the position: absolute difference
    assert.deepEqual(audit('99.999999999999'),[],epoch);
  }
  // a full close where lots cover only part (200 of 300): E1 compares the absolute difference, E2 the signed one (-100 is not above the band)
  const part=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:100,cash:'-100'}),
    buy({s:2,qty:'1',quote:'200',at:200,cash:'-200',lot:{id:'Q2',price:'200'}}),
    sell({s:3,qty:'2',quote:'360',at:300,cash:'360'})]);
  assert.deepEqual(ev(run(part,'E1'),'3:2').expected_audit,['ledger.cost_divergence']);
  assert.deepEqual(ev(run(part,'E2'),'3:2').expected_audit,[]);
  assert.deepEqual(ev(run(part,'E0'),'3:2').expected_audit,[]);
});

test('R13 (M36): a difference equal to the stated bound is within the bound, one ulp above it is not',()=>{
  // 4 BTC filled since flat: bound 0.5e-18 x 4 = 2e-18. Lot cost 4 x 100.0000000000000000005 = 400.000000000000000002 against position cost 400
  const make=price=>{const data=set(F1000(),[buy({s:1,qty:'4',quote:'400',at:10,cash:'-400',lot:{id:'R13',price}})]);return {data,replay:run(data,'E2')};};
  let {data,replay}=make('100.0000000000000000005');
  let row=checkR13({replay,storedLots:data.lots}).rows[0];
  assert.deepEqual([row.difference,row.bound,row.within_bound],['-0.000000000000000002','0.000000000000000002',true]);
  ({data,replay}=make('100.0000000000000000006'));
  row=checkR13({replay,storedLots:data.lots}).rows[0];
  assert.deepEqual([row.difference,row.within_bound],['-0.0000000000000000024',false]);
  assert.equal(checkR13({replay,storedLots:data.lots}).ok,false);
});

test('8 unbacked equity (M47): the line is configured equity minus funding cash with its sign, and the identity holds when equity and cash deltas differ',()=>{
  // equity 1000 with cash 600, then equity -200 with cash -100: equity 800, funding cash 500, unbacked 300
  const data=set([fund(1,m(0),'1000','600'),fund(2,m(10),'-200','-100')],[buy({s:1,qty:'1',quote:'100',at:m(20),cash:'-100',lot:{id:'U',price:'100'}})]);
  const r=run(data,'E2');
  assert.equal(r.final.unbacked_equity,'300');
  assert.equal(ev(r,'F:1').state.unbacked_equity,'400');
  assert.equal(ev(r,'F:2').state.unbacked_equity,'300');
  // cash 400, position cost 100, book equity 800 - 100 + 100 = 800: 800 - 400 - 100 = 300
  assert.equal(r.final.cash,'400');assert.equal(r.final.book_equity,'800');
  assert.deepEqual(unbackedEquityLine(r.final),{value:'300',identity_ok:true});
  assert.equal(unbackedEquityLine(r.final).value,r.final.unbacked_equity);
});

test('10 ranges (M08, M09, M10): to equal to the request time is accepted; coverage starting at to gives a null range, the flag and UNAVAILABLE; a request at the coverage start is refused',()=>{
  const now=1792497600000,day=86400000;
  assert.deepEqual(resolveRange({from:now-day,to:now,requestTime:now,coverageStart:0}).resolved,{from:now-day,to:now}); // M08
  assert.deepEqual(resolveRange({from:now-day,to:now+1,requestTime:now,coverageStart:0}).resolved,{from:now-day,to:now}); // later than the request time: resolved to it (round 3 T9)
  const none=resolveRange({from:1791158400000,to:1791417600000,requestTime:now,coverageStart:1791417600000}); // M09
  assert.equal(none.resolved,null);assert.deepEqual(none.flags,['COVERAGE_STARTS_AFTER_REQUEST']);
  assert.deepEqual([none.status,none.reasons],['UNAVAILABLE',['COVERAGE_STARTS_AFTER_REQUEST']]);
  assert.deepEqual(none.requested,{from:1791158400000,to:1791417600000});
  const oneMs=resolveRange({from:1791158400000,to:1791417600000,requestTime:now,coverageStart:1791417599999});
  assert.deepEqual(oneMs.resolved,{from:1791417599999,to:1791417600000});assert.equal(oneMs.status,undefined);
  assert.throws(()=>allTimeWindow({coverageStart:B,requestTime:B}),{code:'QR2_RANGE_INVALID'}); // M10
  assert.equal(allTimeWindow({coverageStart:B,requestTime:B+1}).to,B+1);
});
// Owner decision (2026-10-19): a requested `to` later than the request time is resolved to the request time; the response shows
// RANGE_END_AT_REQUEST_TIME and keeps the requested range next to the resolved range. Request time: Tuesday 2026-10-20T12:00Z.
test('10 ranges (owner decision 2026-10-19): the current Day, Week, Month, Year and a custom range resolve their end to the request time with RANGE_END_AT_REQUEST_TIME',()=>{
  const now=1792497600000,day=86400000;
  const resolve=window=>resolveRange({from:window.from,to:window.to,requestTime:now,coverageStart:0});
  const expectations=[
    ['DAY',1792454400000,1792540800000],     // 2026-10-20 00:00Z to 2026-10-21 00:00Z
    ['WEEK',1792368000000,1792972800000],    // Monday 2026-10-19 to Monday 2026-10-26
    ['MONTH',1790812800000,1793491200000],   // 2026-10-01 to 2026-11-01
    ['YEAR',1767225600000,1798761600000]     // 2026-01-01 to 2027-01-01
  ];
  for(const [kind,from,to] of expectations){
    const window=periodWindow(kind,now);
    assert.deepEqual([window.from,window.to],[from,to],kind);
    assert.deepEqual(resolve(window),{requested:{from,to},resolved:{from,to:now},flags:['RANGE_END_AT_REQUEST_TIME']},kind);
  }
  // custom: calendar days 2026-10-17 to 2026-10-20 inclusive end at 2026-10-21 00:00Z, after the request time
  const custom=customWindow(1792195200000,now);
  assert.deepEqual([custom.from,custom.to],[1792195200000,1792540800000]);
  assert.deepEqual(resolve(custom),{requested:{from:1792195200000,to:1792540800000},resolved:{from:1792195200000,to:now},flags:['RANGE_END_AT_REQUEST_TIME']});
  // a range that ended before the request time is unchanged and carries no flag; so is one that ends exactly at it
  const past=customWindow(1792195200000,1792195200000+day);
  assert.deepEqual(resolve(past),{requested:{from:past.from,to:past.to},resolved:{from:past.from,to:past.to},flags:[]});
  assert.deepEqual(resolveRange({from:now-day,to:now,requestTime:now,coverageStart:0}).flags,[]);
  // one millisecond later is resolved and flagged
  assert.deepEqual(resolveRange({from:now-day,to:now+1,requestTime:now,coverageStart:0}),{requested:{from:now-day,to:now+1},resolved:{from:now-day,to:now},flags:['RANGE_END_AT_REQUEST_TIME']});
  // the coverage flag and the end flag combine; coverage starting after the resolved end gives the null range and the UNAVAILABLE status
  const both=resolveRange({from:1792368000000,to:1792972800000,requestTime:now,coverageStart:1792454400000});
  assert.deepEqual([both.resolved,both.flags],[{from:1792454400000,to:now},['COVERAGE_STARTS_AFTER_REQUEST','RANGE_END_AT_REQUEST_TIME']]);
  const late=resolveRange({from:1792368000000,to:1792972800000,requestTime:now,coverageStart:now});
  assert.equal(late.resolved,null);assert.deepEqual([late.status,late.reasons],['UNAVAILABLE',['COVERAGE_STARTS_AFTER_REQUEST']]);
  assert.deepEqual(late.flags,['COVERAGE_STARTS_AFTER_REQUEST','RANGE_END_AT_REQUEST_TIME']);
  // RC-Q22 (round 4 V5): a current period requested at its exact start resolves to null, UNAVAILABLE, no exception
  const atStart=resolveRange({from:now,to:now+day,requestTime:now,coverageStart:0});
  assert.deepEqual(atStart,{requested:{from:now,to:now+day},resolved:null,flags:['RANGE_END_AT_REQUEST_TIME'],status:'UNAVAILABLE',reasons:['RANGE_EMPTY_AT_REQUEST_TIME']});
  const dayStart=periodWindow('DAY',1792454400000),atMidnight=resolveRange({from:dayStart.from,to:dayStart.to,requestTime:dayStart.from,coverageStart:0});
  assert.deepEqual([atMidnight.resolved,atMidnight.status,atMidnight.reasons],[null,'UNAVAILABLE',['RANGE_EMPTY_AT_REQUEST_TIME']]);
  // a start later than the request time stays refused, and so does to <= from
  assert.throws(()=>resolveRange({from:now+1,to:now+day,requestTime:now,coverageStart:0}),{code:'QR2_RANGE_INVALID'});
  assert.throws(()=>resolveRange({from:now+day,to:now+2*day,requestTime:now,coverageStart:0}),{code:'QR2_RANGE_INVALID'});
  assert.throws(()=>resolveRange({from:now-day,to:now-day,requestTime:now,coverageStart:0}),{code:'QR2_RANGE_INVALID'});
});
test('10 ranges (owner decision 2026-10-19): the header keeps the requested range beside the resolved one and the flag is shown',()=>{
  const now=1792497600000,window=periodWindow('DAY',now),r=resolveRange({from:window.from,to:window.to,requestTime:now,coverageStart:0});
  const head=buildHeader({basis:'ACTUAL_PAPER_LEDGER',requested_range:r.requested,resolved_range:r.resolved,as_of:now,first_funding_at:null,currency:'USDT',methods:METHODS,range_flags:r.flags,
    contract_id:'qr2-portfolio-performance-test',declaration_version:null,ledger_rule_epochs:['E2'],lot_epochs:['paper-exit-cost-v2']});
  assert.deepEqual(head.requested_range,{from:1792454400000,to:1792540800000});
  assert.deepEqual(head.resolved_range,{from:1792454400000,to:now});
  assert.deepEqual(head.range_flags,['RANGE_END_AT_REQUEST_TIME']);
  assert.deepEqual(validateResponse({...head,status:'COMPLETE'}),{ok:true,errors:[]});
  // RC-Q23 (round 4 V6): requested `to` later than resolved `to` needs RANGE_END_AT_REQUEST_TIME in range_flags
  const noFlag=buildHeader({basis:'ACTUAL_PAPER_LEDGER',requested_range:r.requested,resolved_range:r.resolved,as_of:now,first_funding_at:null,currency:'USDT',methods:METHODS,
    contract_id:'qr2-portfolio-performance-test',declaration_version:null,ledger_rule_epochs:['E2'],lot_epochs:['paper-exit-cost-v2']});
  assert.deepEqual(noFlag.range_flags,[]);
  assert.deepEqual(validateResponse(noFlag).errors,[{code:'RANGE_END_FLAG_MISSING',path:'range_flags'}]);
  assert.deepEqual(validateResponse({...head,range_flags:['COVERAGE_STARTS_AFTER_REQUEST']}).errors,[{code:'RANGE_END_FLAG_MISSING',path:'range_flags'}]);
  const withoutKey={...head};delete withoutKey.range_flags;
  assert.deepEqual(validateResponse(withoutKey).errors,[{code:'HEADER_FIELD_MISSING',path:'range_flags'},{code:'RANGE_END_FLAG_MISSING',path:'range_flags'}]);
  // W4 (round 5): range_flags is a required header key, also when the requested range ends in the past
  assert.deepEqual(validateResponse({...withoutKey,requested_range:{from:now-86400000,to:now},resolved_range:{from:now-86400000,to:now}}).errors,[{code:'HEADER_FIELD_MISSING',path:'range_flags'}]);
  // W4: a null resolved range with a requested end later than as_of needs RANGE_END_AT_REQUEST_TIME too
  assert.deepEqual(validateResponse({...noFlag,resolved_range:null}).errors,[{code:'RANGE_END_FLAG_MISSING',path:'range_flags'}]);
  assert.deepEqual(validateResponse({...head,resolved_range:null}),{ok:true,errors:[]});
  assert.deepEqual(validateResponse({...noFlag,resolved_range:null,requested_range:{from:now-86400000,to:now}}),{ok:true,errors:[]});
  assert.deepEqual(validateResponse({...head,range_flags:'RANGE_END_AT_REQUEST_TIME'}).errors.map(e=>e.code),['RANGE_FLAGS_INVALID','RANGE_END_FLAG_MISSING']);
  // a range that ends at or before the request time needs no flag
  assert.deepEqual(validateResponse({...noFlag,requested_range:{from:now-86400000,to:now},resolved_range:{from:now-86400000,to:now}}),{ok:true,errors:[]});
});

test('9 price resolver (RC-Q9): one malformed bar_time makes every instant PRICE_INTEGRITY_FAILED (fail closed, whole set)',()=>{
  const bad={...barRow(T-120000,'99'),bar_time:'12x'};
  const r=resolvePrice({instant:T,rows:[barRow(T-60000,'101'),bad]});
  assert.equal(r.state,'PRICE_INTEGRITY_FAILED');assert.equal(r.price,null);assert.ok(r.reasons.includes('BAR_TIME_INVALID'));
});

test('12 header (RC-Q10, RC-Q11): fixed labels cannot be overridden by method fields; the validator requires the exact header keys',()=>{
  const evil=buildHeader({basis:'ACTUAL_PAPER_LEDGER',requested_range:null,resolved_range:null,as_of:2,first_funding_at:null,currency:'USDT',contract_id:'c',declaration_version:null,ledger_rule_epochs:[],lot_epochs:[],
    methods:{...METHODS,basis:'HISTORICAL_SIMULATION',execution:'LIVE',historical_simulation:true,qualified_evidence:true,fx:'USD',event_time_basis:'MARKET_TIME',fee_source:'MODELED',alloc_method:'x'},
    extra:{basis:'RESEARCH_REPLAY',currency:'THB',fx:'USD'}});
  assert.deepEqual([evil.basis,evil.execution,evil.historical_simulation,evil.qualified_evidence,evil.fx,evil.event_time_basis,evil.currency],['ACTUAL_PAPER_LEDGER','PAPER_SIMULATED_FILLS',false,false,'NONE','LEDGER_WRITE_TIME','USDT']);
  assert.deepEqual([evil.fee_source,evil.alloc_method],['RECORDED_ONLY','qr2-alloc-v1']); // defaults are the contract values, not the method fields
  const ok={...header(),status:'COMPLETE'};
  assert.deepEqual(validateResponse(ok),{ok:true,errors:[]});
  assert.deepEqual(ok.price_policy,{fresh_ms:180000,carry_ms:900000});
  for(const key of ['price_policy','contract_id','declaration_version','ledger_rule_epochs','lot_epochs','fee_source','alloc_method']){
    const copy={...ok};delete copy[key];
    assert.deepEqual(validateResponse(copy).errors,[{code:'HEADER_FIELD_MISSING',path:key}],key);
  }
  assert.deepEqual(validateResponse({...ok,price_policy:{fresh_ms:1}}).errors,[{code:'PRICE_POLICY_INVALID',path:'price_policy'}]);
  assert.deepEqual(validateResponse({...ok,fee_source:'MODELED'}).errors,[{code:'FEE_SOURCE_INVALID',path:'fee_source'}]);
  // a present key must hold a usable value (round 3 T6); declaration_version stays null until S4
  for(const [change,code,path] of [[{contract_id:null},'CONTRACT_ID_INVALID','contract_id'],[{contract_id:''},'CONTRACT_ID_INVALID','contract_id'],
    [{ledger_rule_epochs:null},'LEDGER_RULE_EPOCHS_INVALID','ledger_rule_epochs'],[{ledger_rule_epochs:'E2'},'LEDGER_RULE_EPOCHS_INVALID','ledger_rule_epochs'],
    [{lot_epochs:null},'LOT_EPOCHS_INVALID','lot_epochs'],[{lot_epochs:{}},'LOT_EPOCHS_INVALID','lot_epochs'],
    [{alloc_method:'x'},'ALLOC_METHOD_INVALID','alloc_method'],[{alloc_method:null},'ALLOC_METHOD_INVALID','alloc_method']])
    assert.deepEqual(validateResponse({...ok,...change}).errors,[{code,path}],JSON.stringify(change));
  assert.deepEqual(validateResponse({...ok,declaration_version:null}),{ok:true,errors:[]});
  assert.deepEqual(validateResponse({...ok,alloc_method:QR2_METHODS.alloc_method,ledger_rule_epochs:[],lot_epochs:[]}),{ok:true,errors:[]});
  // a header missing contract_id because the caller did not pass it is refused by the validator
  const forgot=buildHeader({basis:'ACTUAL_PAPER_LEDGER',requested_range:null,resolved_range:null,as_of:2,first_funding_at:null,currency:'USDT',methods:METHODS});
  assert.ok(validateResponse(forgot).errors.some(e=>e.code==='HEADER_FIELD_MISSING'&&e.path==='contract_id'));
});
test('12 inputs_hash (RC-Q15): a journal row is filtered by its paired fill received_at, not by its own at',()=>{
  const fundRow={id:1,user_id:'u1',broker:'binance-global',at:1000,equity_delta:'1000',cash_delta:'1000',kind:'CONFIGURATION'};
  const mk=(signal,at,jat)=>({fill:{signal_id:signal,cumulative_quantity:'1',delta_quantity:'1',price:'5',fee_quote:'0',quote_amount:'5',received_at:at,legacy_float:0,side:'BUY',symbol:'BTCUSDT',trade_id:'T'+signal,payload:'{}'},
    journal:{signal_id:signal,cumulative_quantity:'1',cash_delta:'-5',at:jat,user_id:'u1',broker:'binance-global'}});
  const early=mk(1,2000,2000),gap=mk(9,6000,5999); // the journal row was written 1 ms before its fill, which is stamped at `to`
  const input=(accounts)=>({methods:{valuation_method:'x'},scope:{bot_id:'b'},period:{from:1000,to:6000},accounts,prices:[],to:6000,requestTime:7000});
  const without=inputsHash(input([{id:'a',fundings:[fundRow],journal:[early.journal],fills:[early.fill]}]));
  const withGap=inputsHash(input([{id:'a',fundings:[fundRow],journal:[early.journal,gap.journal],fills:[early.fill,gap.fill]}]));
  assert.equal(withGap,without); // both halves of the event are at or after `to`: neither is an input
  const orphan=inputsHash(input([{id:'a',fundings:[fundRow],journal:[early.journal,{...gap.journal,signal_id:77}],fills:[early.fill]}]));
  assert.notEqual(orphan,without); // a journal row with no fill uses its own at (5999 < 6000)
});

test('9 price resolver (RC-Q17): a bar older than carry_ms is UNAVAILABLE without verification; at exactly carry_ms the bar is verified',()=>{
  const old=barRow(T-900001,'100');old.bar.close='5'; // corrupt, but it is never used, so it is never verified
  const r=resolvePrice({instant:T,rows:[old]});
  assert.equal(r.state,'UNAVAILABLE');assert.deepEqual(r.reasons,['PRICE_OLDER_THAN_CARRY']);assert.equal(r.price,null);assert.equal(r.content_hash,null);
  const edge=barRow(T-900000,'100');edge.bar.close='5';
  assert.equal(resolvePrice({instant:T,rows:[edge]}).state,'PRICE_INTEGRITY_FAILED');
});

/* ------------------------------------------------------------------ fix round 3: root rulings T1-T9 */

test('6 N2 legacy baseline (round 3 T1): a LEGACY_BASELINE row seeds (cash_delta - equity_delta) as configured equity, so a cash-only seed is no N2 violation',()=>{
  // baseline cash 150 equity 0 at 100; BUY 100 at 200; deposit 10/10 at 300. Cash 60. Raw equity floor 10 - 100 = -90; seeded 150: 60.
  const data=set([fund(1,100,'0','150','LEGACY_BASELINE'),fund(2,300,'10','10')],[buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}})]);
  const replay=run(data,'E2'),seeds=legacySeeds({fundings:data.fundings,fills:data.fills,replay,accountStart:0});
  assert.equal(ev(replay,'F:2').state.equity_floor,'-90');assert.equal(ev(replay,'F:2').state.cash,'60');
  const inv=checkLedgerInvariants({replay,seeds});
  assert.equal(inv.ok,true);assert.deepEqual(inv.violations,[]);assert.deepEqual(inv.spans,[]);
  const effects=effectsOf({findings:inv.violations,spans:inv.spans,replay});
  assert.equal(effects.ledger_invariant_violated,false);
  const out=rangePerformance({replay,seeds,effects,from:101,to:400,rows:[barRow(150,'100'),barRow(350,'100')]});
  assert.equal(out.twr.value,'0');assert.deepEqual(out.twr.reasons,[]);
  assert.deepEqual(accountStatus({effects,performance:out}).overlays,[]);
  // the seed is configured equity, not a free pass: an equity-only withdrawal of 60 gives 150 + (-60) + (-100) = -10 and N2 fires
  const bad=set([fund(1,100,'0','150','LEGACY_BASELINE'),fund(2,300,'-60','0')],[buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}})]);
  const badReplay=run(bad,'E2'),badSeeds=legacySeeds({fundings:bad.fundings,fills:bad.fills,replay:badReplay,accountStart:0});
  const badInv=checkLedgerInvariants({replay:badReplay,seeds:badSeeds});
  assert.deepEqual(badInv.violations.map(v=>[v.check,v.event_key,v.value]),[['N2','F:2','-10']]);
  assert.deepEqual(badInv.spans,[{from:300,to:null,start_event_key:'F:2',end_event_key:null}]);
});

// Cycle fixture: A clean (100 to 200), B clamped (300 to 450, lot B1 stored at 300 against a position cost of 200), C clean (600 to 700).
const cycleData=()=>set(F1000(),[
  buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',lot:{id:'A1',price:'100'}}),
  sell({s:2,qty:'1',quote:'110',at:200,cash:'110'}),
  buy({s:3,qty:'1',quote:'100',at:300,cash:'-100',lot:{id:'B1',price:'300'}}),
  buy({s:4,qty:'1',quote:'100',at:350,cash:'-100',lot:{id:'B2',price:'100'}}),
  sell({s:5,qty:'1',quote:'120',at:400,cash:'120'}),
  sell({s:6,qty:'1',quote:'10',at:450,cash:'10'}),
  buy({s:7,qty:'1',quote:'100',at:600,cash:'-100',lot:{id:'C1',price:'100'}}),
  sell({s:8,qty:'1',quote:'110',at:700,cash:'110'})]);
test('1 replay and gates (round 3 T2, OD-Q10): COST_CLAMPED carries its position cycle and nulls cost and PnL only for ranges that intersect the cycle',()=>{
  const data=cycleData(),storedLots=data.lots.map(l=>({...l,remaining_quantity:'0',status:'CLOSED'}));
  const g=gateData(data,{storedLots,stored:{positions:[{symbol:'BTCUSDT',quantity:'0',cost_basis:'0'}],cash:'950'}});
  const clamps=g.findings.filter(f=>f.code==='COST_CLAMPED');
  assert.deepEqual(clamps.map(f=>[f.check,f.effect,f.event_key,f.symbol,f.cycle]),[['R14','SPLIT_NULL','5:1','BTCUSDT',{symbol:'BTCUSDT',from:300,to:450}]]);
  // B1 is stored at 300 against the fill (100), so R6 also reports LOT_BINDING_MISMATCH for the symbol in every range; that is a separate finding.
  // To pin the cycle scope alone, the effects below carry the clamp finding only.
  assert.deepEqual([...g.effects.split_null],['BTCUSDT']);
  const only=effectsOf({findings:clamps,spans:[],replay:g.replay});
  assert.equal(only.split_null.size,0);assert.deepEqual(only.split_null_cycles,[{symbol:'BTCUSDT',from:300,to:450}]);
  const bars=[barRow(50,'100')];
  const at=(from,to)=>rangePerformance({replay:g.replay,seeds:g.seeds,effects:only,from,to,rows:bars});
  const nulled=out=>[out.nav_from.realized,out.nav_from.unrealized,out.nav_from.position_cost,out.nav_to.realized,out.nav_to.unrealized,out.nav_to.position_cost];
  // before the cycle: [150, 250) holds cycle A only; [150, 300) ends at the opening fill of B, whose state excludes that fill
  let out=at(150,250);
  assert.deepEqual([out.nav_to.realized,out.nav_to.unrealized,out.nav_to.position_cost],['10','0','0']);assert.equal(out.identity.ok,true);
  // round 4 V3: the cumulative realized is null at every instant at or after the cycle's from time (300), position cost stays
  out=at(150,300);assert.equal(out.nav_to.realized,null);assert.equal(out.nav_to.position_cost,'0');assert.equal(out.nav_from.realized,'0');
  assert.notEqual(out.nav_to.nav,null);assert.notEqual(out.money_pnl.value,null);
  out=at(150,299);assert.equal(out.nav_to.realized,'10');
  // the identity output hides expected and e0_clamp_delta from the cycle's from time on, and still checks the identity
  assert.equal('expected' in out.identity,true);assert.equal('e0_clamp_delta' in out.identity,true);
  out=at(150,300);assert.deepEqual([out.identity.checked,out.identity.ok,'expected' in out.identity,'e0_clamp_delta' in out.identity],[true,true,false,false]);
  assert.deepEqual(accountStatus({effects:only,performance:at(150,250)}).reasons.includes('SPLIT_NULL'),false);
  // inside the cycle: cost, realized and unrealized are null; NAV, money PnL and returns stay
  out=at(320,420);
  assert.deepEqual(nulled(out),[null,null,null,null,null,null]);
  assert.notEqual(out.nav_to.nav,null);assert.notEqual(out.money_pnl.value,null);
  assert.ok(accountStatus({effects:only,performance:out}).reasons.includes('SPLIT_NULL'));
  // the flat fill stamped 450 belongs to the cycle: a range starting there still sees the open position (inclusive end)
  assert.deepEqual(nulled(at(450,500)),[null,null,null,null,null,null]);
  // after the cycle: a range that starts one millisecond later keeps position cost, NAV and money PnL, but the cumulative
  // realized contains cycle B and is null (round 4 V3, OD-Q10); the identity needs it and is not checked
  out=at(451,500);
  assert.deepEqual([out.nav_from.realized,out.nav_to.realized,out.nav_to.position_cost],[null,null,'0']);
  out=at(500,800);
  assert.deepEqual([out.nav_from.realized,out.nav_to.realized,out.nav_to.unrealized,out.nav_to.position_cost],[null,null,'0','0']);
  // round 5 W1: the identity stays on after a clamp cycle (it runs on the raw NAV); dR + dU is not shown
  assert.deepEqual([out.identity.checked,out.identity.ok,'expected' in out.identity],[true,true,false]);
  assert.notEqual(out.money_pnl.value,null);assert.notEqual(out.nav_to.nav,null);
  // W3: e0_clamp_total is a cumulative cost balance and is null at and after the cycle's from time (display only)
  assert.deepEqual([at(150,299).nav_to.e0_clamp_total,at(150,300).nav_to.e0_clamp_total,out.nav_to.e0_clamp_total],['0',null,null]);
  assert.equal(clampCumulativeNull(navAt({replay:g.replay,seeds:g.seeds,instant:800,rows:bars}),only).e0_clamp_total,null);
  // W1: a state that was tampered after the cycle is still caught as QR2_IDENTITY_BROKEN
  const last=g.replay.events.filter(e=>!e.halted&&e.time<800).pop();
  const tampered={...g.replay,events:g.replay.events.map(e=>e===last?{...e,state:{...e.state,cash:D(e.state.cash).plus('1').toFixed()}}:e)};
  const broken=rangePerformance({replay:tampered,seeds:g.seeds,effects:only,from:500,to:800,rows:bars});
  assert.deepEqual([broken.identity.checked,broken.identity.ok,broken.identity.code,broken.account_unavailable],[true,false,'QR2_IDENTITY_BROKEN',true]);
  assert.deepEqual(accountStatus({effects:only,performance:broken}).reasons,['ACCOUNT_UNAVAILABLE','QR2_IDENTITY_BROKEN']);
  assert.equal(accountStatus({effects:only,performance:out}).reasons.includes('SPLIT_NULL'),false);
  // a range that spans the cycle is null too
  assert.deepEqual(nulled(at(150,800)).slice(3),[null,null,null]);
  assert.deepEqual(['expected' in at(150,800).identity,'e0_clamp_delta' in at(150,800).identity],[false,false]);
  // round 4 V1: accountStatus without a range counts every clamp cycle (fail closed), also a cycle far from any range
  const noRange=accountStatus({effects:only,performance:{nav_from:{nav:'1',reasons:[]},nav_to:{nav:'1',reasons:[]},money_pnl:{value:'0'},twr:{value:'0'},mwr:{value:'0'},max_drawdown:{value:'0'}}});
  assert.deepEqual([noRange.status,noRange.reasons],['PARTIAL',['SPLIT_NULL']]);
  const perf={nav_from:{nav:'1',reasons:[]},nav_to:{nav:'1',reasons:[]},money_pnl:{value:'0'},twr:{value:'0'},mwr:{value:'0'},max_drawdown:{value:'0'}};
  assert.deepEqual(accountStatus({effects:only,to:500,performance:perf}).reasons,['SPLIT_NULL']);   // the end passes the cycle's opening fill
  assert.deepEqual(accountStatus({effects:only,to:300,performance:perf}).reasons,[]);                // the end excludes the opening fill
});
test('1 replay and gates (round 3 T2): a clamp in a position cycle that is still open applies to every later range',()=>{
  const open=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',lot:{id:'V1',price:'300'}}),
    buy({s:2,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'V2',price:'100'}}),
    sell({s:3,qty:'1',quote:'120',at:300,cash:'120'})]);
  const g=gateData(open,{storedLots:[{...open.lots[0],remaining_quantity:'0',status:'CLOSED'},{...open.lots[1],remaining_quantity:'1',status:'OPEN'}],stored:{positions:[{symbol:'BTCUSDT',quantity:'1',cost_basis:'0'}],cash:'920'}});
  const clamp=g.findings.find(f=>f.code==='COST_CLAMPED');
  assert.deepEqual(clamp.cycle,{symbol:'BTCUSDT',from:100,to:null});
  const eff=effectsOf({findings:[clamp],spans:[],replay:g.replay});
  assert.deepEqual([...splitNullFor(eff,5000,6000)],['BTCUSDT']);
  assert.deepEqual([...splitNullFor(eff,50,100)],[]);   // the range ends at the opening fill: NAV(100) excludes it
  assert.deepEqual([...splitNullFor(eff,50,101)],['BTCUSDT']);
  // a SPLIT_NULL finding without a cycle (any other check) still applies to its symbol in every range
  const plain=effectsOf({findings:[{check:'R7',code:'COST_DRIFT',effect:'SPLIT_NULL',symbol:'BTCUSDT'}],spans:[],replay:g.replay});
  assert.deepEqual([...splitNullFor(plain,1,2)],['BTCUSDT']);
});

test('1 L1 binding (round 3 T3): the lot-table cutoff is min(earliest lot, lotTableBoundary); an unbound BUY at or after it is LOT_BINDING_MISMATCH',()=>{
  const buyAt=(s,at)=>buy({s,qty:'1',quote:'100',at,cash:'-100'}).f;
  const opts=boundary=>({lotFeeBoundary:0,lotTableBoundary:boundary});
  const shape=r=>r.findings.map(f=>[f.code,f.effect,f.event_key]);
  // the lot table is lost entirely: with a recorded boundary a later BUY is no longer NO_LOT
  assert.deepEqual(shape(bindLots([buyAt(1,5000)],[],opts(1000))),[['LOT_BINDING_MISMATCH','SPLIT_NULL','1:1']]);
  assert.equal(bindLots([buyAt(1,5000)],[],opts(1000)).findings[0].field,'lot');
  assert.deepEqual(shape(bindLots([buyAt(1,999)],[],opts(1000))),[['NO_LOT',null,'1:1']]);              // strictly before the boundary
  assert.deepEqual(shape(bindLots([buyAt(1,1000)],[],opts(1000))),[['LOT_BINDING_MISMATCH','SPLIT_NULL','1:1']]); // exactly at it
  assert.deepEqual(shape(bindLots([buyAt(1,5000)],[],{lotFeeBoundary:0})),[['NO_LOT',null,'1:1']]);      // no boundary recorded: unchanged
  // mutation N07: a BUY exactly at the earliest lot opened_at without a lot of its own is a mismatch, not NO_LOT
  const lot={position_id:'L7',entry_signal_id:7,entry_trade_id:'T7',filled_quantity:'1',entry_price:'100',opened_at:20,symbol:'BTCUSDT'};
  const fills=[buyAt(7,20),buyAt(8,20),buyAt(9,19)];
  assert.deepEqual(shape(bindLots(fills,[lot],opts(null))),[['LOT_BINDING_MISMATCH','SPLIT_NULL','8:1'],['NO_LOT',null,'9:1']]);
  // the smaller of the two bounds wins
  assert.deepEqual(shape(bindLots([buyAt(8,500)],[lot],opts(1000))).filter(x=>x[2]==='8:1'),[['LOT_BINDING_MISMATCH','SPLIT_NULL','8:1']]); // earliest lot 20 < boundary 1000
  assert.deepEqual(shape(bindLots([buyAt(8,15)],[lot],opts(10))).filter(x=>x[2]==='8:1'),[['LOT_BINDING_MISMATCH','SPLIT_NULL','8:1']]);   // boundary 10 < earliest lot 20
  assert.deepEqual(shape(bindLots([buyAt(8,9)],[lot],opts(10))).filter(x=>x[2]==='8:1'),[['NO_LOT',null,'8:1']]);
  assert.throws(()=>bindLots([buyAt(1,1)],[],{lotTableBoundary:1.5}),{code:'QR2_INPUT_INVALID'});
  // through the replay and the gates: the symbol is SPLIT_NULL
  const data=set(F1000(),[buy({s:1,qty:'1',quote:'100',at:5000,cash:'-100'})]);
  const g=gateData(data,{storedLots:[],stored:{positions:[{symbol:'BTCUSDT',quantity:'1',cost_basis:'100'}],cash:'900'},extra:{lotTableBoundary:1000}});
  assert.deepEqual(g.gates.R6.failures.map(f=>[f.code,f.effect,f.symbol,f.event_key]),[['LOT_BINDING_MISMATCH','SPLIT_NULL','BTCUSDT','1:1']]);
  assert.deepEqual([...g.effects.split_null],['BTCUSDT']);
});
test('1 replay (round 3 T4): a BUY classified LOT_BINDING_MISMATCH is noted LOT_MISSING, never NO_LOT',()=>{
  const data=set(F1000(),[buy({s:1,qty:'1',quote:'100',at:5000,cash:'-100'})]); // no lot row at all
  const lost=run(data,'E2',{lotTableBoundary:1000});
  assert.deepEqual(lost.binding.findings.map(f=>f.code),['LOT_BINDING_MISMATCH']);
  assert.deepEqual(codes(ev(lost,'1:1')),['LOT_MISSING','UNLOTTED_QUANTITY']);
  const early=run(data,'E2',{lotTableBoundary:5001}); // booked before the lot table
  assert.deepEqual(early.binding.findings.map(f=>f.code),['NO_LOT']);
  assert.deepEqual(codes(ev(early,'1:1')),['NO_LOT','UNLOTTED_QUANTITY']);
  assert.deepEqual(codes(ev(run(data,'E2'),'1:1')),['NO_LOT','UNLOTTED_QUANTITY']); // no boundary and no lots: unchanged
  // with lots present: the BUY after the earliest lot has no lot of its own
  const mixed=set(F1000(),[buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',lot:{id:'A',price:'100'}}),buy({s:2,qty:'1',quote:'100',at:200,cash:'-100'})]);
  const r=run(mixed,'E2');
  assert.deepEqual(codes(ev(r,'2:1')),['LOT_MISSING','UNLOTTED_QUANTITY']);
  assert.ok(!codes(ev(r,'2:1')).includes('NO_LOT'));
});

test('14 gates (round 3 T5): LOT_ORDER_AMBIGUOUS is an R6 failure; binding SPLIT_NULL findings stay visible as information when R6 is NOT_RUN for S_COST_UNAVAILABLE',()=>{
  // (a) covered with the tie-group test above (gates.R6.failures, ok recomputed).
  // (b) an M1 legacy fill that is never flat again leaves S_cost null, so R6 does not run. The lot price follows no known epoch
  // (LOT_EPOCH_UNKNOWN), signal 2 lost its lot (LOT_BINDING_MISMATCH) and lot L99 has no fill (ORPHAN_LOT).
  const data=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',legacy:1,lot:{id:'L1',price:'999'}}),
    buy({s:2,qty:'1',quote:'100',at:200,cash:'-100'})]);
  data.lots.push({position_id:'L99',entry_signal_id:99,entry_trade_id:'T99',filled_quantity:'1',entry_price:'1',opened_at:150,symbol:'BTCUSDT',user_id:'u1',account_id:'binance-global:primary',execution_mode:'PAPER'});
  const storedLots=data.lots.map(l=>({...l,remaining_quantity:'1',status:'OPEN'}));
  const g=gateData(data,{storedLots,stored:{positions:[{symbol:'BTCUSDT',quantity:'2',cost_basis:'200'}],cash:'800'},extra:{lotFeeBoundary:null,lotTableBoundary:150}});
  assert.equal(g.seeds.s_cost,null);
  assert.deepEqual([g.gates.R6.ok,g.gates.R6.not_run],[null,'S_COST_UNAVAILABLE']);
  const info=g.information.filter(f=>f.check==='R6');
  assert.deepEqual(info.map(f=>[f.code,f.effect,f.not_run]).sort(),[['LOT_BINDING_MISMATCH','SPLIT_NULL','S_COST_UNAVAILABLE'],['LOT_EPOCH_UNKNOWN','SPLIT_NULL','S_COST_UNAVAILABLE'],['ORPHAN_LOT','SPLIT_NULL','S_COST_UNAVAILABLE']]);
  // information only: no number is changed by them
  assert.equal(g.findings.some(f=>f.check==='R6'),false);assert.equal(g.effects.split_null.size,0);
  // when R6 runs the same findings are failures and not information
  const run2=gateData(data,{storedLots,stored:{positions:[{symbol:'BTCUSDT',quantity:'2',cost_basis:'200'}],cash:'800'},extra:{lotFeeBoundary:null,lotTableBoundary:150},epoch:'E2'});
  assert.equal(run2.information.filter(f=>f.check==='R6').length,3);
});

test('12 header (round 3 T6): the validator refuses a null or empty contract_id, non-array epochs and a foreign alloc_method',()=>{
  // covered next to the header test (RC-Q10, RC-Q11); this case pins the buildHeader path too
  const forged=buildHeader({basis:'ACTUAL_PAPER_LEDGER',requested_range:null,resolved_range:null,as_of:2,first_funding_at:null,currency:'USDT',methods:METHODS,
    contract_id:null,declaration_version:null,ledger_rule_epochs:null,lot_epochs:null});
  assert.deepEqual(validateResponse(forged).errors.map(e=>[e.code,e.path]),[['CONTRACT_ID_INVALID','contract_id'],['LEDGER_RULE_EPOCHS_INVALID','ledger_rule_epochs'],['LOT_EPOCHS_INVALID','lot_epochs']]);
});

test('14 gates (round 3 T8): a counted row that names no Bot fails closed with QR2_CROSS_BOT_ROW',()=>{
  const missing=(table,row)=>checkRowScope({scope:SCOPE,tables:{[table]:[row]}}).findings;
  // no scope field at all, user_id alone, broker alone: refused
  for(const row of [{signal_id:1},{signal_id:1,user_id:'u1'},{signal_id:1,broker:'binance-global'}]){
    const f=missing('fills',row);
    assert.deepEqual(f.map(x=>[x.check,x.code,x.reason,x.table]),[['RX','QR2_CROSS_BOT_ROW','SCOPE_FIELD_MISSING','fills']],JSON.stringify(row));
  }
  assert.equal(missing('journal',{signal_id:1}).length,1);assert.equal(missing('fundings',{id:1}).length,1);assert.equal(missing('lots',{position_id:'L'}).length,1);
  // a row that names its Bot passes: user_id with broker, or with account_id
  assert.deepEqual(missing('fills',{user_id:'u1',broker:'binance-global'}),[]);
  assert.deepEqual(missing('lots',{user_id:'u1',account_id:'binance-global:primary'}),[]);
  assert.deepEqual(missing('fills',{signal_id:1,user_id:null,broker:'binance-global'}).map(x=>x.code),['QR2_CROSS_BOT_ROW']); // a null user_id is a mismatch
  // positions and snapshots are compared, not counted
  assert.deepEqual(missing('positions',{symbol:'BTCUSDT'}),[]);assert.deepEqual(missing('snapshots',{id:1}),[]);
  // a mismatch is still reported once, with its own finding
  assert.deepEqual(missing('fills',{user_id:'u2',broker:'binance-global'}).map(x=>x.reason),[undefined]);
  // through the gate runner: the whole view is refused and no number is produced
  const g=golden();delete g.fills[1].user_id;
  const r=gate(g);
  assert.equal(r.refused,'QR2_CROSS_BOT_ROW');assert.equal(r.effects.refused,'QR2_CROSS_BOT_ROW');assert.equal(r.row_scope.cross_bot,true);
  const j=golden();delete j.journal[0].user_id;delete j.journal[0].broker;
  assert.equal(gate(j).refused,'QR2_CROSS_BOT_ROW');
  const out=rangePerformance({replay:r.replay,seeds:r.seeds,effects:r.effects,from:1500,to:6000,rows:GOLDEN_BARS});
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.equal(out[key].value,null);
  // the golden account itself passes
  assert.equal(gate(golden()).refused,null);
});

/* ------------------------------------------------------------------ items outside S1 (kept as todo, slice named) */

test('11 allocation (INDEPENDENT_ACCOUNTS sum, SHARED_HYPOTHETICAL, no declaration, ALLOCATION_SET_CHANGED, QR2_CURRENCY_MIX)',{todo:'S4: the slice table gives the capital-model declaration and owner totals to S4 (alloc_method qr2-alloc-v1 starts there); not implemented in S1'},()=>{
  assert.equal(QR2_METHODS.alloc_method,'qr2-alloc-v1');
});
test('RX total equals the exact per-currency sum of its parts (QR2_TOTAL_MISMATCH)',{todo:'S4: owner totals belong to S4; only the row-level and cross-view key parts of RX exist in S1'},()=>{
  assert.ok(true);
});
test('R14 audit rows (ledger.cost_clamped, ledger.cost_divergence in range) and R15 pending orders',{todo:'S2: R14 reads the audit table and R15 needs exposure() at request time, both read by the S2 reader; the replay-derived clamp SPLIT_NULL (RC-Q6) is done in S1'},()=>{
  assert.ok(true);
});
test('FILL_BEFORE_BAR (2.4)',{todo:'S2: fills.received_at earlier than the signal bar close is RC RECONCILIATION_FAILED; FILL_BEFORE_BAR_UNCHECKED (information) when the signal has no bar time; needs the signal fields the S2 reader loads'},()=>{
  assert.ok(true);
});

test('constants: method ids stay as written in contract 7.4',()=>{
  assert.deepEqual(QR2_METHODS,{
    valuation_method:'btcusdt-1m-close-asof-market-v1',valuation_method_option_r:'btcusdt-1m-close-asof-retrieved-v1',
    return_method:{twr:'twr-flow-split-v1',mwr:'mwr-modified-dietz-v1',money_pnl:'money-pnl-flow-v1'},
    lot_method:{E0:'ledger-stored-lots-target-fifo-fallback-v1',E1:'paper-exit-cost-o3-v1',E2:'paper-exit-cost-v2'},
    legacy_method:'legacy-two-seed-v1',order_method:'commit-order-snapshot-id-v1',period_method:'utc-exclusive-isoweek-v1',drawdown_grid:'qr2-grid-daily-events-v1',alloc_method:'qr2-alloc-v1',
    rounding:{market_value:'market-value-18-half-even',return:'return-12-half-even'}});
});

/* ------------------------------------------------------------------ round 4 rulings (V7, V8) */

test('14 gates (round 4 V7): with S_cost set and no legacy flag, the T5 binding findings are R6 failures and not information',()=>{
  // same ledger as the T5 case, but fill 1 carries no legacy_float marker: the account is flat at the start, so S_cost exists and R6 runs
  const data=set(F1000(),[
    buy({s:1,qty:'1',quote:'100',at:100,cash:'-100',lot:{id:'L1',price:'999'}}),
    buy({s:2,qty:'1',quote:'100',at:200,cash:'-100'})]);
  data.lots.push({position_id:'L99',entry_signal_id:99,entry_trade_id:'T99',filled_quantity:'1',entry_price:'1',opened_at:150,symbol:'BTCUSDT',user_id:'u1',account_id:'binance-global:primary',execution_mode:'PAPER'});
  const storedLots=data.lots.map(l=>({...l,remaining_quantity:'1',status:'OPEN'}));
  const g=gateData(data,{storedLots,stored:{positions:[{symbol:'BTCUSDT',quantity:'2',cost_basis:'200'}],cash:'800'},extra:{lotFeeBoundary:null,lotTableBoundary:150}});
  assert.notEqual(g.seeds.s_cost,null);
  assert.equal(g.gates.R6.not_run,undefined);assert.equal(g.gates.R6.ok,false);
  const codesOf=g.gates.R6.failures.map(f=>f.code);
  for(const code of ['LOT_EPOCH_UNKNOWN','LOT_BINDING_MISMATCH','ORPHAN_LOT'])assert.ok(codesOf.includes(code),code);
  assert.equal(g.information.some(f=>f.check==='R6'),false);
});

test('6 N2 legacy baseline (round 4 V8, mutation gap M2): the floor adds exactly cash_delta - equity_delta of a baseline with cash 150 and equity 50',()=>{
  // baseline cash 150 equity 50 at 100 (seeded 100); BUY 100 at 200. Equity-only withdrawal 40/40 at 300: raw floor 50 - 40 - 100 = -90,
  // seeded 10, cash 10: no violation. A seed of cash only (150) or equity only (50) or none (0) gives 60, -40 or -90.
  const okData=set([fund(1,100,'50','150','LEGACY_BASELINE'),fund(2,300,'-40','-40')],[buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}})]);
  const okReplay=run(okData,'E2'),okSeeds=legacySeeds({fundings:okData.fundings,fills:okData.fills,replay:okReplay,accountStart:0});
  assert.equal(ev(okReplay,'F:2').state.equity_floor,'-90');assert.equal(ev(okReplay,'F:2').state.cash,'10');
  const okInv=checkLedgerInvariants({replay:okReplay,seeds:okSeeds});
  assert.deepEqual([okInv.ok,okInv.violations,okInv.spans],[true,[],[]]);
  // an equity-only withdrawal of 60 gives raw -110, seeded -10, cash 50: N2 fires with value -10 (a cash-only seed would give 40)
  const badData=set([fund(1,100,'50','150','LEGACY_BASELINE'),fund(2,300,'-60','0')],[buy({s:1,qty:'1',quote:'100',at:200,cash:'-100',lot:{id:'A',price:'100'}})]);
  const badReplay=run(badData,'E2'),badSeeds=legacySeeds({fundings:badData.fundings,fills:badData.fills,replay:badReplay,accountStart:0});
  const badInv=checkLedgerInvariants({replay:badReplay,seeds:badSeeds});
  assert.deepEqual(badInv.violations.map(v=>[v.check,v.event_key,v.value]),[['N2','F:2','-10']]);
});
