import test from 'node:test';
import assert from 'node:assert/strict';
import {ledgerMethods} from '../src/postgres/ledger.js';
import {D,amount,down} from '../src/money.js';

// Exit cost rule (paper-exit-cost-v2, O3 and G1): the real recordExecution runs against an in-memory fake db, so the rule
// is checked over thousands of generated entries without PostgreSQL.
// L-I1: after every fill, cost_basis has at most 18 places and is not negative.
// L-I2: a fill that leaves quantity 0 leaves cost_basis exactly 0.
// L-I3: the booked profit of an exit equals notional - cost actually removed - fee, and a flat-to-flat cycle conserves.
// L-I4: a FIFO exit that consumes every open lot charges the uncovered quantity at the average cost of the unlotted rest
// of the position, never at zero (G1).
const ACCOUNT='binance-global:primary',KEY=`u:${ACCOUNT}:PAPER:BTCUSDT`;

function makeStore(){
  const t={signals:new Map(),allocations:[],positions:new Map(),cash:[],audit:[],completed:[],streakPnl:null};
  const db={isTransaction:true,transaction:async fn=>fn(),prepare(sql){return{
    get:async(...p)=>{
      if(sql.includes('FROM users WHERE id=?'))return {id:p[0]};
      if(sql.includes('FROM signals WHERE id=?'))return t.signals.get(p[0]);
      if(sql.includes('SUM(cost_basis)'))return {amount:[...t.positions.values()].reduce((a,x)=>a.plus(x.cost_basis),D(0)).toFixed()};
      if(sql.includes('FROM ledger_positions WHERE user_id=? AND account_id='))return t.positions.get(`${p[0]}:${p[1]}:${p[2]}:${p[3]}`);
      if(sql.includes('FROM paper_funding'))return {equity:'100000000',cash:'100000000'};
      if(sql.includes('FROM paper_cash_journal'))return {amount:t.cash.reduce((a,x)=>a.plus(x),D(0)).toFixed()};
      if(sql.includes('SELECT stop_loss,take_profit FROM ledger_position_allocations')){const o=t.allocations.filter(a=>a.status==='OPEN'&&D(a.remaining_quantity).gt(0));return o.length?o[o.length-1]:undefined;}
      return undefined;},
    all:async(...p)=>{
      // A targeted exit passes its target twice (entry_trade_id or position_id).
      if(sql.includes('FROM ledger_position_allocations'))return t.allocations.filter(a=>a.status==='OPEN'&&D(a.remaining_quantity).gt(0)&&a.symbol===p[3]&&(p.length<6||a.entry_trade_id===p[4]||a.position_id===p[5]));
      return [];},
    run:async(...p)=>{
      if(sql.includes('INSERT INTO ledger_position_allocations')){const[position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,status,filled_quantity,remaining_quantity,entry_price]=p;t.allocations.push({position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,status,filled_quantity,remaining_quantity,entry_price});}
      else if(sql.includes('UPDATE ledger_position_allocations')){const a=t.allocations.find(x=>x.position_id===p[4]);a.remaining_quantity=p[0];a.status=p[1];}
      else if(sql.includes('INSERT INTO paper_cash_journal'))t.cash.push(D(p[4]));
      // A flat position stores cumulative_pnl 0; the cycle profit is only visible in the loss-streak update.
      else if(sql.includes('INSERT INTO ledger_streak'))t.streakPnl=p[4];
      else if(sql.includes('INSERT INTO ledger_positions')){const[u,a,m,b,s,q,avg,sl,tp,ir,pnl,upd,cost]=p;t.positions.set(`${u}:${a}:${m}:${s}`,{quantity:q,avg_price:avg,initial_risk:ir,cumulative_pnl:pnl,cost_basis:cost,stop_loss:sl,take_profit:tp});}
      return {changes:1};}};}};
  return {t,store:{db,...ledgerMethods,snapshotPaper:async()=>{},complete:async(id,status,fields)=>{t.completed.push({id,status,...fields});},audit:async(u,event,tradeId,details)=>{t.audit.push({event,details});}}};
}

let nextId=0;
const places=value=>(String(value).split('.')[1]||'').length;
const pos=ctx=>ctx.t.positions.get(KEY);
const auditCount=(ctx,event)=>ctx.t.audit.filter(a=>a.event===event).length;
const signalRow=(side)=>{const id=++nextId;return {id,user_id:'u',trade_id:'T'+id,execution_mode:'PAPER',broker:'binance-global',symbol:'BTCUSDT',account_id:ACCOUNT,applied_quantity:'0',applied_quote:'0',status:'PROCESSING',payload:'{}',side};};

// Books one full fill and reports the position before and after, so a case can check the profit that was booked.
async function fill(ctx,side,qty,price,{fee='0',raw={}}={}){
  const row=signalRow(side),q=D(qty),notional=D(amount(q.mul(price)));
  ctx.t.signals.set(row.id,row);ctx.t.streakPnl=null;
  const beforePos=pos(ctx),cost0=D(beforePos?.cost_basis??0),pnl0=D(beforePos?.cumulative_pnl??0);
  await ctx.store.recordExecution(row,{status:'FILLED',orderId:'x',executedQty:q.toFixed(),quoteQty:notional.toFixed(),deltaFeeQuote:fee,raw},{side,quantity:q.toFixed(),price:String(price),stopLoss:'1',takeProfit:null,notional:notional.toFixed()});
  const after=pos(ctx),cost1=D(after.cost_basis),flat=D(after.quantity).isZero();
  const pnl1=flat?D(ctx.t.streakPnl??0):D(after.cumulative_pnl);
  return {notional,fee:D(fee),cost0,cost1,profit:pnl1.minus(pnl0),cycleProfit:pnl1,flat,after};
}

// Seeded generator so a failure reproduces with the same inputs.
function rng(seed){let s=seed;return()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};}

function checkExit(ctx,exit,label){
  assert.ok(places(exit.after.cost_basis)<=18&&exit.cost1.gte(0),`L-I1 ${label}`);
  if(exit.flat)assert.ok(exit.cost1.isZero(),`L-I2 ${label}: cost ${exit.after.cost_basis}`);
  assert.equal(exit.profit.toFixed(),exit.notional.minus(exit.cost0.minus(exit.cost1)).minus(exit.fee).toFixed(),`L-I3 ${label}: profit uses the cost actually removed`);
}

// Quantity and cost with no lot, as a position opened before lots were recorded (schema 11 upgrade, SQLite import) holds.
function addUnlotted(ctx,qty,cost){
  const p=pos(ctx)||{quantity:'0',avg_price:'0',initial_risk:'0',cumulative_pnl:'0',cost_basis:'0',stop_loss:null,take_profit:null};
  ctx.t.positions.set(KEY,{...p,quantity:D(p.quantity).plus(qty).toFixed(),cost_basis:D(p.cost_basis).plus(cost).toFixed()});
}
const openLots=ctx=>ctx.t.allocations.filter(a=>a.status==='OPEN'&&D(a.remaining_quantity).gt(0));

// The removal an untargeted exit of `take` should make, worked out from the state before it: open lots in opening order,
// then any uncovered quantity at the average cost of the part of the position that no lot holds. Exact, not rounded.
function expectedRemoval(ctx,take){
  const p=pos(ctx),q0=D(p.quantity),c0=D(p.cost_basis);
  let left=D(take),lotCost=D(0),lotQty=D(0);
  for(const a of openLots(ctx)){
    const rem=D(a.remaining_quantity),t=rem.lt(left)?rem:left;
    lotCost=lotCost.plus(t.mul(a.entry_price));lotQty=lotQty.plus(rem);left=left.minus(t);
  }
  if(left.isZero())return {exact:lotCost,uncovered:D(0),lotCost,lotQty};
  const unlottedQty=q0.minus(lotQty),unlottedCost=c0.minus(lotCost);
  return {exact:lotCost.plus(unlottedCost.mul(left).div(unlottedQty)),uncovered:left,unlottedQty,unlottedCost,lotCost,lotQty};
}

// L-I4: a partial exit removes the expected cost rounded once to 18 places; after an exit that reached unlotted quantity,
// the position cost is the remaining unlotted share, within half a unit of the 18th place.
function checkCover(want,exit,label){
  if(exit.flat)return;
  assert.equal(exit.cost0.minus(exit.cost1).toFixed(),amount(want.exact),`L-I4 ${label}: removed cost`);
  if(want.uncovered.gt(0)){
    const share=want.unlottedCost.mul(exit.after.quantity).div(want.unlottedQty);
    assert.ok(exit.cost1.minus(share).abs().lte('5e-19'),`L-I4 ${label}: cost ${exit.after.cost_basis} vs unlotted share ${share.toFixed()}`);
  }
}

test('legacy-sized entries: 2000 half exit then full exit never throw and keep L-I1, L-I2 and L-I3 exact',async()=>{
  for(let i=0;i<2000;i++){
    const p=D(60000).plus(D(i*137%1000000).div(100)).toFixed(2),v=D(10+((i*7919)%990));
    const q=D(down(v.div(p))),ctx=makeStore();
    const buy=await fill(ctx,'BUY',q,p);
    assert.ok(places(buy.after.cost_basis)<=18,`L-I1 buy ${i}`);
    const half=await fill(ctx,'SELL',down(q.div(2)),D(p).plus(50).toFixed(2));
    checkExit(ctx,half,`half ${i}`);
    const rest=await fill(ctx,'SELL',D(pos(ctx).quantity),D(p).minus(50).toFixed(2));
    checkExit(ctx,rest,`full ${i}`);
    assert.ok(rest.flat);
    assert.equal(rest.cycleProfit.toFixed(),half.notional.plus(rest.notional).minus(buy.cost1).toFixed(),`L-I3 cycle ${i}`);
    assert.equal(auditCount(ctx,'ledger.cost_clamped')+auditCount(ctx,'ledger.cost_divergence'),0,`no audit row for a covered cycle ${i}`);
  }
});

test('random multi-lot sequences with fees and several partial exits keep L-I1, L-I2 and L-I3 exact',async()=>{
  const rnd=rng(7);
  for(let s=0;s<500;s++){
    const ctx=makeStore();
    let entryCost=D(0),proceeds=D(0),cycleProfit=D(0),flatSeen=false;
    const lotsN=1+Math.floor(rnd()*4);
    for(let k=0;k<lotsN;k++){
      const p=D(60000).plus(D(Math.floor(rnd()*1000000)).div(100)).toFixed(2),v=D(10+Math.floor(rnd()*990));
      const q=D(down(v.div(p))),buyFee=amount(D(amount(q.mul(p))).mul(rnd()*0.002));
      const b=await fill(ctx,'BUY',q,p,{fee:buyFee});entryCost=entryCost.plus(b.cost1.minus(b.cost0));
      assert.ok(places(b.after.cost_basis)<=18,`L-I1 buy ${s}.${k}`);
    }
    const exits=1+Math.floor(rnd()*3);
    for(let k=0;k<exits;k++){
      const hold=D(pos(ctx).quantity),take=D(down(hold.mul(0.1+rnd()*0.5)));
      if(take.isZero())break;
      const price=D(61000).plus(Math.floor(rnd()*1000)).toFixed(2),fee=amount(D(amount(take.mul(price))).mul(rnd()*0.002));
      const e=await fill(ctx,'SELL',take,price,{fee});checkExit(ctx,e,`partial ${s}.${k}`);
      proceeds=proceeds.plus(e.notional).minus(e.fee);cycleProfit=cycleProfit.plus(e.profit);
    }
    const rest=D(pos(ctx).quantity);
    if(rest.gt(0)){
      const e=await fill(ctx,'SELL',rest,'62000.00',{fee:'0.5'});checkExit(ctx,e,`close ${s}`);
      proceeds=proceeds.plus(e.notional).minus(e.fee);cycleProfit=cycleProfit.plus(e.profit);flatSeen=e.flat;
    }
    assert.ok(flatSeen);
    assert.ok(D(pos(ctx).cost_basis).isZero(),`L-I2 end ${s}`);
    assert.equal(cycleProfit.toFixed(),proceeds.minus(entryCost).toFixed(),`L-I3 cycle ${s}`);
    assert.equal(ctx.t.cash.reduce((a,x)=>a.plus(x),D(0)).toFixed(),proceeds.minus(entryCost).toFixed(),`cash ${s}`);
    assert.equal(auditCount(ctx,'ledger.cost_clamped')+auditCount(ctx,'ledger.cost_divergence'),0,`no audit row for covered sequence ${s}`);
  }
});

test('a full close whose lots disagree with the position cost removes the whole cost and writes ledger.cost_divergence above 1e-12',async()=>{
  for(const [delta,expectRow] of [['0.0000000000001',false],['0.00000000001',true]]){
    const ctx=makeStore();
    await fill(ctx,'BUY','0.002','60000');
    const lotCost=D(pos(ctx).cost_basis);
    pos(ctx).cost_basis=lotCost.plus(delta).toFixed();
    const exit=await fill(ctx,'SELL','0.002','61000');
    assert.ok(exit.flat&&exit.cost1.isZero());
    assert.equal(exit.profit.toFixed(),exit.notional.minus(lotCost.plus(delta)).toFixed(),'profit uses the whole position cost');
    const rows=ctx.t.audit.filter(a=>a.event==='ledger.cost_divergence');
    assert.equal(rows.length,expectRow?1:0);
    if(expectRow)assert.deepEqual(rows[0].details,{signalId:nextId,symbol:'BTCUSDT',lotCost:lotCost.toFixed(),positionCost:lotCost.plus(delta).toFixed(),atFlat:true,uncoveredQuantity:'0'});
  }
});

test('a full close with uncovered quantity writes ledger.cost_divergence only when the lots cost more than the whole position',async()=>{
  // Lot 0.001 x 60000 = 60 plus 0.003 unlotted. Unlotted cost 150 is a normal mixed position (G1); a negative unlotted cost
  // means the lot alone costs more than the whole position, which only a lot/position divergence produces.
  for(const [unlottedCost,expectRow] of [['150',false],['0',false],['-0.0000000000001',false],['-0.00000000001',true],['-10',true]]){
    const ctx=makeStore();
    addUnlotted(ctx,'0.003',unlottedCost);
    await fill(ctx,'BUY','0.001','60000');
    const positionCost=D(pos(ctx).cost_basis);
    assert.equal(positionCost.toFixed(),D(60).plus(unlottedCost).toFixed());
    const exit=await fill(ctx,'SELL','0.004','61000');
    assert.ok(exit.flat&&exit.cost1.isZero(),`flat ${unlottedCost}`);
    assert.equal(exit.profit.toFixed(),D(244).minus(positionCost).toFixed(),`profit uses the whole position cost ${unlottedCost}`);
    assert.equal(openLots(ctx).length,0);
    const rows=ctx.t.audit.filter(a=>a.event==='ledger.cost_divergence');
    assert.equal(rows.length,expectRow?1:0,`divergence rows ${unlottedCost}`);
    if(expectRow)assert.deepEqual(rows[0].details,{signalId:nextId,symbol:'BTCUSDT',lotCost:'60',positionCost:positionCost.toFixed(),atFlat:true,uncoveredQuantity:'0.003'});
    assert.equal(auditCount(ctx,'ledger.cost_clamped'),0,`a full close never clamps ${unlottedCost}`);
  }
});

test('a lot cost above the position cost on a partial exit clamps to 0, removes only the position cost and writes ledger.cost_clamped',async()=>{
  const ctx=makeStore();
  await fill(ctx,'BUY','0.002','60000');
  pos(ctx).cost_basis='10';
  const exit=await fill(ctx,'SELL','0.001','61000');
  assert.equal(exit.cost1.toFixed(),'0');
  assert.equal(exit.profit.toFixed(),exit.notional.minus(10).toFixed());
  assert.deepEqual(ctx.t.audit.filter(a=>a.event==='ledger.cost_clamped').map(a=>a.details),[{signalId:nextId,symbol:'BTCUSDT',clamped:'50'}]);
});

test('the rule marker is written only when the call books a fill and keeps the other broker response fields',async()=>{
  const ctx=makeStore();
  const booked=async(raw)=>{await fill(ctx,'BUY','0.001','60000',{raw});return ctx.t.completed.at(-1).response;};
  const raw={paper:true,status:'FILLED'};
  assert.deepEqual(await booked(raw),{paper:true,status:'FILLED',ledgerRule:'paper-exit-cost-v2'});
  assert.deepEqual(raw,{paper:true,status:'FILLED'},'the broker response object is not mutated');
  assert.deepEqual(await booked(null),{ledgerRule:'paper-exit-cost-v2'});
  assert.deepEqual(await booked(['x']),{ledgerRule:'paper-exit-cost-v2'});

  // A status-only update: no new quantity, so execution.raw is stored exactly as the broker sent it.
  for(const statusRaw of [null,{paper:true,status:'CANCELED'}]){
    const row=signalRow('BUY');row.applied_quantity='0.001';row.applied_quote='60';ctx.t.signals.set(row.id,row);
    await ctx.store.recordExecution(row,{status:'CANCELED',orderId:'x',executedQty:'0.001',quoteQty:'60',deltaFeeQuote:0,raw:statusRaw},{side:'BUY',quantity:'0.002',price:'60000',stopLoss:'1',takeProfit:null,notional:'120'});
    const stored=ctx.t.completed.at(-1);
    assert.equal(stored.id,row.id);
    assert.equal(stored.response,statusRaw);
  }
  const noFill=signalRow('BUY');ctx.t.signals.set(noFill.id,noFill);
  await ctx.store.recordExecution(noFill,{status:'NEW',orderId:'x',executedQty:'0',quoteQty:'0',deltaFeeQuote:0,raw:null},{side:'BUY',quantity:'0.002',price:'60000',stopLoss:'1',takeProfit:null,notional:'120'});
  assert.equal(ctx.t.completed.at(-1).response,null);
});

test('G1 worked example: an exit larger than its lot removes the lot cost plus the unlotted average cost',async()=>{
  const ctx=makeStore();
  addUnlotted(ctx,'0.003','150');
  await fill(ctx,'BUY','0.001','60000');
  // SELL 0.002 at 61000: the lot 0.001 x 60000 = 60, then the uncovered 0.001 at 150 / 0.003 = 50000, which is 50.
  const exit=await fill(ctx,'SELL','0.002','61000');
  assert.equal(exit.cost0.minus(exit.cost1).toFixed(),'110');
  assert.equal(exit.cost1.toFixed(),'100');
  assert.equal(exit.profit.toFixed(),'12','122 - 110; the lot cost alone would book 62');
  assert.equal(D(exit.after.avg_price).toFixed(),'50000');
  assert.equal(openLots(ctx).length,0);
  const close=await fill(ctx,'SELL','0.002','59000');
  assert.ok(close.flat&&close.cost1.isZero());
  assert.equal(close.profit.toFixed(),'18');
  assert.equal(close.cycleProfit.toFixed(),'30','exits 122 + 118 minus entry cost 150 + 60');
  assert.equal(auditCount(ctx,'ledger.cost_clamped')+auditCount(ctx,'ledger.cost_divergence'),0);
});

test('G1 a position with no lot at all keeps the proportional cost of the O3 rule, byte for byte',async()=>{
  const rnd=rng(11);
  for(let i=0;i<500;i++){
    const ctx=makeStore();
    const q=D(down(D(rnd()).mul('0.05').plus('0.000001'))),c=D(amount(q.mul(60000+Math.floor(rnd()*10000)).mul(1+rnd()/7)));
    addUnlotted(ctx,q,c);
    const take=D(down(q.mul(0.1+rnd()*0.8)));
    const exit=await fill(ctx,'SELL',take,'61000.00');
    assert.equal(exit.after.cost_basis,c.minus(amount(c.mul(take).div(q))).toFixed(),`no-lot exit ${i}`);
    checkExit(ctx,exit,`no-lot ${i}`);
  }
});

test('G1 legacy-sized mixed positions: 2000 exits larger than the lot, then a full close, keep L-I1 to L-I4 exact',async()=>{
  for(let i=0;i<2000;i++){
    const p=D(60000).plus(D(i*137%1000000).div(100)).toFixed(2),v=D(10+((i*7919)%990));
    const q=D(down(v.div(p))),ctx=makeStore();
    // The unlotted part has its own size and an average cost within about 10% of the entry price.
    const uq=D(down(q.mul(0.5+(i%7)/4))),uc=D(amount(uq.mul(p).mul(0.9+(i%11)/50)));
    addUnlotted(ctx,uq,uc);
    const buy=await fill(ctx,'BUY',q,p);
    assert.ok(places(buy.after.cost_basis)<=18,`L-I1 buy ${i}`);
    const take=down(q.plus(uq.div(2))),want=expectedRemoval(ctx,take);
    assert.ok(want.uncovered.gt(0),`case ${i} must reach unlotted quantity`);
    const part=await fill(ctx,'SELL',take,D(p).plus(50).toFixed(2));
    checkExit(ctx,part,`part ${i}`);checkCover(want,part,`part ${i}`);
    assert.equal(openLots(ctx).length,0,`every lot consumed ${i}`);
    const rest=await fill(ctx,'SELL',D(pos(ctx).quantity),D(p).minus(50).toFixed(2));
    checkExit(ctx,rest,`full ${i}`);
    assert.ok(rest.flat);
    assert.equal(rest.cycleProfit.toFixed(),part.notional.plus(rest.notional).minus(buy.cost1).toFixed(),`L-I3 cycle ${i}`);
    assert.equal(auditCount(ctx,'ledger.cost_clamped')+auditCount(ctx,'ledger.cost_divergence'),0,`no audit row ${i}`);
  }
});

test('G1 random mixed sequences with fees, covered and uncovered partial exits keep L-I1 to L-I4 exact',async()=>{
  const rnd=rng(13);
  let reached=0,covered=0,mixedCloses=0;
  for(let s=0;s<500;s++){
    const ctx=makeStore();
    const base=D(60000).plus(Math.floor(rnd()*5000));
    const uq=D(down(D(rnd()).mul('0.01').plus('0.00001'))),uc=D(amount(uq.mul(base).mul(0.8+rnd()*0.4)));
    addUnlotted(ctx,uq,uc);
    let entryCost=uc,proceeds=D(0),cycleProfit=D(0),divergence=0;
    const lotsN=1+Math.floor(rnd()*3);
    for(let k=0;k<lotsN;k++){
      const p=D(60000).plus(D(Math.floor(rnd()*1000000)).div(100)).toFixed(2),v=D(10+Math.floor(rnd()*990));
      const q=D(down(v.div(p))),buyFee=amount(D(amount(q.mul(p))).mul(rnd()*0.002));
      const b=await fill(ctx,'BUY',q,p,{fee:buyFee});entryCost=entryCost.plus(b.cost1.minus(b.cost0));
      assert.ok(places(b.after.cost_basis)<=18,`L-I1 buy ${s}.${k}`);
    }
    const exits=1+Math.floor(rnd()*4);
    for(let k=0;k<exits;k++){
      const hold=D(pos(ctx).quantity),take=D(down(hold.mul(0.1+rnd()*0.8)));
      if(take.isZero())break;
      const want=expectedRemoval(ctx,take);
      if(want.uncovered.gt(0))reached++;else covered++;
      const price=D(61000).plus(Math.floor(rnd()*1000)).toFixed(2),fee=amount(D(amount(take.mul(price))).mul(rnd()*0.002));
      const e=await fill(ctx,'SELL',take,price,{fee});checkExit(ctx,e,`partial ${s}.${k}`);checkCover(want,e,`partial ${s}.${k}`);
      proceeds=proceeds.plus(e.notional).minus(e.fee);cycleProfit=cycleProfit.plus(e.profit);
    }
    const rest=D(pos(ctx).quantity),want=expectedRemoval(ctx,rest),gap=want.lotCost.minus(pos(ctx).cost_basis);
    // A full close that consumes lots records a divergence when lots covering the whole exit differ from the position cost,
    // or when, next to uncovered quantity, the lots cost more than the whole position. The unlotted cost here is positive,
    // so a full close that still consumes lots next to unlotted quantity writes no row.
    if(want.lotQty.gt(0)&&(want.uncovered.isZero()?gap.abs():gap).gt('1e-12'))divergence=1;
    if(want.lotQty.gt(0)&&want.uncovered.gt(0))mixedCloses++;
    const e=await fill(ctx,'SELL',rest,'62000.00',{fee:'0.5'});checkExit(ctx,e,`close ${s}`);
    proceeds=proceeds.plus(e.notional).minus(e.fee);cycleProfit=cycleProfit.plus(e.profit);
    assert.ok(e.flat&&D(pos(ctx).cost_basis).isZero(),`L-I2 end ${s}`);
    assert.equal(cycleProfit.toFixed(),proceeds.minus(entryCost).toFixed(),`L-I3 cycle ${s}`);
    assert.equal(auditCount(ctx,'ledger.cost_clamped'),0,`no clamp ${s}`);
    assert.equal(auditCount(ctx,'ledger.cost_divergence'),divergence,`divergence rows ${s}`);
  }
  assert.ok(reached>100&&covered>100,`both kinds of exit are exercised: ${reached} uncovered, ${covered} covered`);
  assert.ok(mixedCloses>100,`full closes of lots plus unlotted quantity are exercised: ${mixedCloses}`);
});

test('G1 lots costing more than the whole position: the uncovered exit clamps to 0 and writes ledger.cost_clamped',async()=>{
  const ctx=makeStore();
  await fill(ctx,'BUY','0.001','60000');
  // 0.002 more quantity with no lot while the position cost drops to 50: the lot alone holds 60, so the rest holds -10.
  addUnlotted(ctx,'0.002','-10');
  const exit=await fill(ctx,'SELL','0.0015','61000');
  // Removal 60 + (-10 x 0.0005 / 0.002) = 57.5 is more than the 50 held, so the position gives up exactly its 50.
  assert.equal(exit.cost1.toFixed(),'0');
  assert.equal(exit.profit.toFixed(),exit.notional.minus(50).toFixed());
  assert.deepEqual(ctx.t.audit.filter(a=>a.event==='ledger.cost_clamped').map(a=>a.details),[{signalId:nextId,symbol:'BTCUSDT',clamped:'7.5'}]);
});

test('G1 a zero-cost lot next to unlotted quantity counts as no lot: removed cost grows with the exit size and the cycle conserves',async()=>{
  // Lot 0.001 with entry_price 0 (only operator SQL or a corrupt row writes one) plus 0.003 unlotted at cost 200, so the
  // position holds 0.004 at 200. Every exit size takes cost x qty / quantity = 50000 per unit; charging the zero lot 0 on
  // the exit above the lot removed 6.666666666666666667 for 0.0011 against 50 for 0.001.
  let last=D(-1);
  for(const [take,want] of [['0.0009','45'],['0.001','50'],['0.0011','55']]){
    const ctx=makeStore();
    addUnlotted(ctx,'0.003','200');
    addUnlotted(ctx,'0.001','0');
    ctx.t.allocations.push({position_id:'zero-lot',user_id:'u',account_id:ACCOUNT,execution_mode:'PAPER',broker:'binance-global',symbol:'BTCUSDT',
      entry_signal_id:0,entry_trade_id:'T0',status:'OPEN',filled_quantity:'0.001',remaining_quantity:'0.001',entry_price:'0'});
    const exit=await fill(ctx,'SELL',take,'61000');
    const removed=exit.cost0.minus(exit.cost1);
    assert.equal(removed.toFixed(),want,`removed cost for ${take}`);
    assert.ok(removed.gt(last),`removed cost grows with the exit size at ${take}`);last=removed;
    checkExit(ctx,exit,`zero lot ${take}`);
    assert.equal(openLots(ctx).length,D(take).lt('0.001')?1:0,`the lot is still consumed first ${take}`);
    const close=await fill(ctx,'SELL',D(pos(ctx).quantity),'59000');
    checkExit(ctx,close,`zero lot close ${take}`);
    assert.ok(close.flat&&close.cost1.isZero(),`flat ${take}`);
    assert.equal(close.cycleProfit.toFixed(),exit.notional.plus(close.notional).minus(200).toFixed(),`cycle conserves ${take}`);
    assert.equal(auditCount(ctx,'ledger.cost_clamped')+auditCount(ctx,'ledger.cost_divergence'),0,`no audit row ${take}`);
  }
});

test('E5 a targeted exit above its lot throws on a mixed position instead of pricing the unlotted part',async()=>{
  const ctx=makeStore();
  addUnlotted(ctx,'0.003','150');
  await fill(ctx,'BUY','0.001','60000');
  const target=ctx.t.allocations[0].entry_trade_id,before=structuredClone(pos(ctx));
  const row={...signalRow('SELL'),payload:JSON.stringify({targetTradeId:target})};ctx.t.signals.set(row.id,row);
  await assert.rejects(ctx.store.recordExecution(row,{status:'FILLED',orderId:'x',executedQty:'0.002',quoteQty:'122',deltaFeeQuote:'0',raw:{}},
    {side:'SELL',quantity:'0.002',price:'61000',notional:'122'}),/Fill exceeds remaining target allocation quantity/);
  assert.deepEqual(pos(ctx),before,'no position write');
  assert.equal(ctx.t.cash.length,1,'only the entry journal row');
  assert.equal(ctx.t.completed.length,1,'only the entry was completed');
});
