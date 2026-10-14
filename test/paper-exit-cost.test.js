import test from 'node:test';
import assert from 'node:assert/strict';
import {ledgerMethods} from '../src/postgres/ledger.js';
import {D,amount,down} from '../src/money.js';

// O3 (paper-exit-cost-o3-v1): the real recordExecution runs against an in-memory fake db, so the exit cost rule is
// checked over thousands of generated entries without PostgreSQL.
// L-I1: after every fill, cost_basis has at most 18 places and is not negative.
// L-I2: a fill that leaves quantity 0 leaves cost_basis exactly 0.
// L-I3: the booked profit of an exit equals notional - cost actually removed - fee, and a flat-to-flat cycle conserves.
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
      if(sql.includes('FROM ledger_position_allocations'))return t.allocations.filter(a=>a.status==='OPEN'&&D(a.remaining_quantity).gt(0)&&a.symbol===p[3]);
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
    if(expectRow)assert.deepEqual(rows[0].details,{signalId:nextId,symbol:'BTCUSDT',lotCost:lotCost.toFixed(),positionCost:lotCost.plus(delta).toFixed(),atFlat:true});
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
  assert.deepEqual(await booked(raw),{paper:true,status:'FILLED',ledgerRule:'paper-exit-cost-o3-v1'});
  assert.deepEqual(raw,{paper:true,status:'FILLED'},'the broker response object is not mutated');
  assert.deepEqual(await booked(null),{ledgerRule:'paper-exit-cost-o3-v1'});
  assert.deepEqual(await booked(['x']),{ledgerRule:'paper-exit-cost-o3-v1'});

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
