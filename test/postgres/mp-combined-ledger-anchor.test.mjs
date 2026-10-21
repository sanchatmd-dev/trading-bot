import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {config} from '../../src/config.js';
import {hashPassword} from '../../src/security.js';
import {D,amount} from '../../src/money.js';
import {runCombinedOracle,entryOwner} from '../../src/multi-pine/combined-oracle.js';

/*
 * F11 S2, R-8: the oracle's Bot-level rules against the real production ledger.
 *
 * The oracle (src/multi-pine/combined-oracle.js) is pure and never calls the ledger. This file drives the REAL `Store.recordExecution`
 * (src/postgres/ledger.js, no production change) on a throwaway PostgreSQL database with one fixture Bot per case, books the oracle's FILLED
 * decisions in the oracle's own order (two or three members interleaved on one Bot account), and asserts that the Bot state the ledger ends
 * with is the Bot state of the oracle: cash and committed cost after every fill, final quantity, open allocations, realized R of every fill,
 * and at the end the position initial risk, cumulative pnl, loss streak and the daily row.
 *
 * The oracle result exposes cash, cost, quantity, allocations and realized R per fill; it does not expose its running initial risk, pnl, loss
 * streak or daily map. Those four are re-derived here from the oracle FILLS with plain decimal.js (no ledger code), exactly as the Bot rules state
 * them (MPC 5.4, RD-MP-25): initial risk = sum of quantity x |fill price - stop| per open entry, reset at Bot flat; pnl = sum of exit profit
 * (exit notional - cost removed - fee), reset at Bot flat; loss streak moves only at Bot flat; daily row = filled trades, notional, realized R.
 *
 * Every input is a LABELLED ENGINEERING FIXTURE (scripted-signals-v1, or the synthetic 6,000-bar fixture): never a research result.
 */
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..','..');
const FIXTURES=path.join(root,'test','fixtures','mp-combined');
const DRIVER=path.join(root,'quant_lab','tests','mp_scripted_driver.py');
const PYTHON=process.env.QUANT_TEST_PYTHON??path.join(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const CASES=JSON.parse(fs.readFileSync(path.join(FIXTURES,'scripted-cases-v1.json'),'utf8')).cases;
const MANIFEST=JSON.parse(fs.readFileSync(path.join(FIXTURES,'manifest.json'),'utf8'));
const BROKER='binance-global';

let adminDb,db,store,databaseName;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  adminDb=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_mpanchor_test_'+randomUUID().replaceAll('-','');
  assert.match(databaseName,/^robot_mpanchor_test_[a-f0-9]{32}$/);
  await adminDb.query('CREATE DATABASE '+databaseName);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:target.toString(),max:4});await db.migrate();store=new Store(db);
});
after(async()=>{await db?.close();if(adminDb){if(databaseName)await adminDb.query('DROP DATABASE '+databaseName);await adminDb.close();}});

const oracleInput=spec=>({members:spec.members,bars:spec.bars,pair:spec.pair,model:spec.model,policy:spec.policy,equity:spec.capital.equity,cash:spec.capital.cash,
  broker:spec.broker,symbol:spec.symbol,start_time:spec.start_time,same_bar_order:spec.same_bar_order});

/** One fixture Bot funded with the case capital. The risk policy is the production default plus the funding; recordExecution reads only the funding. */
async function fixtureBot(capital){
  const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword('temporary-test-password'),role:'ADMIN'});
  await store.setRisk(user.id,{...structuredClone(config.defaultRisk),equities:{[BROKER]:Number(capital.equity)},balances:{[BROKER]:Number(capital.cash)}});
  return user;
}

/**
 * Book one oracle fill through the real recordExecution. The signal row is queued by the real enqueue and claimed the way the worker claims it
 * (QUEUED to PROCESSING); the execution is the oracle's own order (quantity, price, notional, fee) and the BUY/EXIT target is the entry reference.
 */
async function bookFill(user,fill,sequence,symbol){
  const buy=fill.event_type==='BUY';
  const tradeId=buy?fill.entry_ref:'exit:'+fill.entry_ref+':'+sequence;
  const body={trade_id:tradeId,broker:'Binance Global',symbol,event:buy?'BUY':'SELL',timeframe:'1',timestamp:fill.time,reference_price:fill.price,
    ...(buy?{stop_loss:fill.sl,take_profit:fill.tp,risk_mode:'PERCENT_EQUITY',risk_value:'1'}:{reduce_only:true,target_trade_id:fill.entry_ref})};
  const signal=normalizeSignal(body,fill.time+1);
  assert.equal(await store.enqueue(user.id,signal),true);
  const job=await db.prepare("UPDATE signals SET status='PROCESSING' WHERE user_id=? AND trade_id=? AND status='QUEUED' RETURNING *").get(user.id,tradeId);
  assert.ok(job,'claimed '+tradeId);
  const order={side:buy?'BUY':'SELL',quantity:fill.quantity,price:fill.price,notional:fill.notional,stopLoss:buy?fill.sl:null,takeProfit:buy?fill.tp:null,clientOrderId:job.client_order_id};
  await store.recordExecution(job,{status:'FILLED',orderId:'PAPER-'+job.client_order_id,executedQty:fill.quantity,quoteQty:fill.notional,deltaFeeQuote:fill.fee,raw:{paper:true,status:'FILLED'}},order);
  return job;
}

const position=(user,symbol)=>db.prepare('SELECT * FROM ledger_positions WHERE user_id=? AND symbol=?').get(user.id,symbol);

/** Oracle-side Bot state re-derived from the oracle fills only (see the header): initial risk, pnl, loss streak and the daily rows. */
function deriveBotState(ledger){
  let initialRisk=D(0),pnl=D(0),quantity=D(0),streak=0;
  const lots=new Map(),daily=new Map();
  for(const fill of ledger.fills){
    const q=D(fill.quantity),notional=D(fill.notional),fee=D(fill.fee);
    if(fill.event_type==='BUY'){
      quantity=quantity.plus(q);
      initialRisk=D(amount(initialRisk.plus(q.mul(D(fill.price).minus(fill.sl).abs()))));
      lots.set(fill.entry_ref,{quantity:q,entry_price:D(amount(notional.plus(fee).div(q)))});
    }else{
      const lot=lots.get(fill.entry_ref);
      pnl=D(amount(pnl.plus(notional.minus(q.mul(lot.entry_price)).minus(fee))));
      quantity=quantity.minus(q);lots.delete(fill.entry_ref);
      if(quantity.isZero()){streak=pnl.lt(0)?streak+1:0;initialRisk=D(0);pnl=D(0);}
    }
    const day=new Date(fill.time).toISOString().slice(0,10);
    const row=daily.get(day)??{trades:0,notional:D(0),realized_r:D(0)};
    row.trades++;row.notional=D(amount(row.notional.plus(notional)));row.realized_r=D(amount(row.realized_r.plus(fill.realized_r)));daily.set(day,row);
  }
  return {initialRisk:quantity.gt(0)?initialRisk:D(0),pnl:quantity.gt(0)?pnl:D(0),streak,daily};
}

const same=(left,right,label)=>assert.ok(D(left).eq(right),label+': ledger '+left+' oracle '+right);

async function anchor(label,spec,oracleResult){
  const {ledger}=oracleResult;
  assert.ok(ledger.fills.length>0,label+': the case books fills');
  const user=await fixtureBot(spec.capital);
  const symbol=spec.symbol;
  const owners=new Set(ledger.fills.map(fill=>entryOwner(fill.entry_ref)));
  let sequence=0;
  for(const fill of ledger.fills){
    const job=await bookFill(user,fill,++sequence,symbol);
    // after every fill: Bot cash and committed cost equal the oracle's running values, and the booked realized R equals the oracle's
    const account=await store.paperAccount(user.id,BROKER);
    const booked=await position(user,symbol);
    const row=await db.prepare('SELECT * FROM fills WHERE signal_id=?').get(job.id);
    const at=label+' '+fill.event_type+' '+fill.entry_ref+' #'+sequence;
    same(account.cash,fill.cash,at+' cash');
    same(booked.cost_basis,fill.cost,at+' cost');
    same(row.realized_r,fill.realized_r,at+' realized_r');
    same(row.delta_quantity,fill.quantity,at+' quantity');
    same(row.price,fill.price,at+' price');
    same(row.quote_amount,fill.notional,at+' notional');
    same(row.fee_quote,fill.fee,at+' fee');
  }
  // final Bot state
  const final=await position(user,symbol);
  const account=await store.paperAccount(user.id,BROKER);
  same(account.cash,ledger.final_cash,label+' final cash');
  same(final.cost_basis,ledger.position_cost,label+' final cost');
  same(final.quantity,ledger.position_quantity,label+' final quantity');
  const open=await db.prepare("SELECT count(*) n FROM ledger_position_allocations WHERE user_id=? AND status='OPEN' AND remaining_quantity>0").get(user.id);
  assert.equal(Number(open.n),ledger.open_allocations,label+' open allocations');
  const derived=deriveBotState(ledger);
  same(final.initial_risk,derived.initialRisk,label+' initial_risk');
  same(final.cumulative_pnl,derived.pnl,label+' pnl');
  const streak=await db.prepare("SELECT loss_streak FROM ledger_streak WHERE user_id=? AND execution_mode='PAPER'").get(user.id);
  assert.equal(streak?.loss_streak??0,derived.streak,label+' loss streak');
  // The ledger keeps one daily row, keyed by the wall-clock UTC day of the booking; the oracle keys by bar day. The totals must agree.
  const dailyRows=await db.prepare('SELECT * FROM ledger_daily WHERE user_id=?').all(user.id);
  assert.equal(dailyRows.length,1,label+' one ledger daily row');
  const total={trades:0,notional:D(0),realized_r:D(0)};
  for(const row of derived.daily.values()){total.trades+=row.trades;total.notional=total.notional.plus(row.notional);total.realized_r=total.realized_r.plus(row.realized_r);}
  assert.equal(Number(dailyRows[0].trades),total.trades,label+' daily trades');
  same(dailyRows[0].notional,total.notional,label+' daily notional');
  same(dailyRows[0].realized_r,total.realized_r,label+' daily realized_r');
  return {owners:owners.size,fills:ledger.fills.length,days:derived.daily.size,streak:derived.streak,initial_risk:final.initial_risk,pnl:final.cumulative_pnl,daily:{trades:dailyRows[0].trades,notional:dailyRows[0].notional,realized_r:dailyRows[0].realized_r}};
}

/* ---------------------------------------------------------------- scripted cases (two or three members interleaved on one Bot) */

const interleaved=new Map();
for(const scripted of CASES){
  test('ledger anchor '+scripted.id+': production recordExecution ends in the oracle Bot state',async t=>{
    const oracle=runCombinedOracle(oracleInput(scripted));
    if(oracle.ledger.fills.length===0){t.skip('no fills in this case');return;}
    const summary=await anchor(scripted.id,scripted,oracle);
    interleaved.set(scripted.id,summary.owners);
    assert.equal(summary.days,1,'a scripted case spans one bar day, so the daily row compares day for day');
    t.diagnostic(JSON.stringify({id:scripted.id,...summary}));
  });
}

test('ledger anchor: the cases that interleave members cover F4, F6, F7, F8 and F13; the loss-streak case moves the streak',()=>{
  for(const id of ['F4','F6','F7','F8','F13'])assert.ok(interleaved.get(id)>=2,id+' books fills of at least two members on one Bot');
  assert.equal(interleaved.get('F13'),3);
  const streakCase=CASES.find(item=>item.id==='F8-streak');
  const oracle=runCombinedOracle(oracleInput(streakCase));
  assert.equal(deriveBotState(oracle.ledger).streak,1,'F8-streak ends with a loss streak of 1');
  const lossCase=CASES.find(item=>item.id==='F8');
  assert.ok(oracle.ledger.fills.length>0&&runCombinedOracle(oracleInput(lossCase)).ledger.fills.some(fill=>fill.event_type==='EXIT'&&D(fill.realized_r).lt(0)),'F8 books a losing exit');
});

/* ---------------------------------------------------------------- library: M1 + M2 on the 6,000 fixture bars (74 fills, several days) */

test('ledger anchor library M1+M2: production recordExecution ends in the oracle Bot state over a multi-day run',async t=>{
  assert.ok(fs.existsSync(PYTHON),'the library anchor takes the member signals from the S1 driver: quant_lab/.venv interpreter (uv sync) or QUANT_TEST_PYTHON');
  const request={fixture_run:{members:[{name:'M1',deployment_id:'fixture-m1-1'},{name:'M2',deployment_id:'fixture-m2-2'}],pair:MANIFEST.pair,factor:1}};
  const out=JSON.parse(execFileSync(PYTHON,[DRIVER],{input:JSON.stringify(request),encoding:'utf8',cwd:root,maxBuffer:1024*1024*1024}));
  assert.equal(out.error,undefined);
  const oracle=runCombinedOracle(oracleInput(out.input));
  const summary=await anchor('library M1+M2',out.input,oracle);
  assert.equal(summary.owners,2);
  assert.ok(summary.days>1,'the run spans several bar days');
  t.diagnostic(JSON.stringify({run:'library M1+M2',...summary}));
});
