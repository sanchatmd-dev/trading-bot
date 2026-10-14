import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {D,amount,down} from '../../src/money.js';
import {config} from '../../src/config.js';
import {hashPassword} from '../../src/security.js';

// O3 (paper-exit-cost-o3-v1): exits round the removed cost once, a full close removes the whole remaining cost,
// and realized profit uses the cost actually removed.
let adminDb,db,store,databaseName;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  adminDb=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_exitcost_test_'+randomUUID().replaceAll('-','');
  assert.match(databaseName,/^robot_exitcost_test_[a-f0-9]{32}$/);
  await adminDb.query('CREATE DATABASE '+databaseName);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:target.toString(),max:6});await db.migrate();store=new Store(db);
});
after(async()=>{await db?.close();if(adminDb){if(databaseName)await adminDb.query('DROP DATABASE '+databaseName);await adminDb.close();}});

const CAPITAL=10000;
const policy={...structuredClone(config.defaultRisk),maxTradesPerDay:1000,maxOpenPositions:10,maxOrderNotional:100000,maxDailyNotional:10000000,blockHighVolatility:false,blockDuringNews:false,equities:{'binance-global':CAPITAL},balances:{'binance-global':CAPITAL}};
async function account(){
  const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword('temporary-test-password'),role:'ADMIN'});
  await store.setRisk(user.id,policy);return user;
}
const signal=(tradeId,overrides)=>normalizeSignal({trade_id:tradeId,broker:'Binance Global',symbol:'BTCUSDT',timestamp:Date.now(),...overrides});
async function send(user,tradeId,overrides){
  assert.equal(await store.enqueue(user.id,signal(tradeId,overrides)),true);
  const worker=new ExecutionWorker({store,config});
  for(let i=0;i<10&&(await store.health()).queued;i++)await worker.tick();
  assert.equal((await store.health()).queued,0);
  return db.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(user.id,tradeId);
}
const position=user=>db.prepare('SELECT * FROM ledger_positions WHERE user_id=? AND symbol=?').get(user.id,'BTCUSDT');
const lots=user=>db.prepare('SELECT * FROM ledger_position_allocations WHERE user_id=? ORDER BY opened_at,position_id').all(user.id);
const places=value=>(String(value).split('.')[1]||'').length;
const fillOf=signalId=>db.prepare('SELECT * FROM fills WHERE signal_id=?').get(signalId);
const count=(user,event)=>db.prepare('SELECT count(*) n FROM audit WHERE user_id=? AND event=?').get(user.id,event).then(r=>Number(r.n));
// Booked profit as the ledger stores it: realized_r = (exit notional - cost actually removed - fee) / initial risk, rounded to 18 places.
const bookedR=(fill,removed,initialRisk)=>amount(D(fill.quote_amount).minus(removed).minus(fill.fee_quote).div(initialRisk));
// Legacy-sized entry from the Debugger probes: FIXED_NOTIONAL 100 at 65432.10 does not terminate.
const legacyBuy={event:'BUY',risk_mode:'FIXED_NOTIONAL',risk_value:'100',entry:'65432.10',sl:'64000'};

test('E1 O3 partial exit on a legacy-sized entry commits, rounds once and conserves profit',async()=>{
  const user=await account();
  const buy=await send(user,'e1-buy',legacyBuy);assert.equal(buy.status,'FILLED');
  const before=await position(user),[lot]=await lots(user);
  assert.equal(before.cost_basis,'99.999999999999953033');
  assert.equal(lot.entry_price,'65432.100000000000000131');
  assert.ok(places(D(lot.entry_price).mul('0.0007').toFixed())>18,'probe input must exceed 18 places before rounding');

  const exit=await send(user,'e1-exit',{event:'SELL',reduce_only:true,quantity:'0.0007',entry:'66000.00'});
  assert.equal(exit.status,'FILLED',exit.error_message);
  const after=await position(user),fill=await fillOf(exit.id);
  const removed=D(before.cost_basis).minus(after.cost_basis);
  assert.equal(after.cost_basis,'54.197529999999953033');
  assert.equal(removed.toFixed(),'45.80247');
  assert.equal(removed.toFixed(),amount(D('0.0007').mul(lot.entry_price)),'removed cost is the single rounding of take x entry_price');
  assert.ok(places(after.cost_basis)<=18);
  const profit=D(fill.quote_amount).minus(removed).minus(fill.fee_quote);
  assert.equal(profit.toFixed(),'0.39753');
  assert.equal(D(after.cumulative_pnl).toFixed(),profit.toFixed());
  assert.equal(D(fill.realized_r).toFixed(),bookedR(fill,removed,before.initial_risk),'stored realized_r uses the removed cost');
  assert.equal(after.quantity,'0.000828301857956568');
  const [rest]=await lots(user);assert.equal(rest.remaining_quantity,'0.000828301857956568');assert.equal(rest.status,'OPEN');
  // Book equity moves by exactly the realized profit: cash and remaining cost are consistent.
  const account_=await store.paperAccount(user.id,'binance-global');
  assert.equal(D(account_.bookEquity).minus(CAPITAL).toFixed(),profit.toFixed());
});

test('E2 O3 full exit after a partial exit leaves cost 0, closes the lot and conserves the cycle exactly',async()=>{
  const user=await account();
  await send(user,'e2-buy',legacyBuy);
  const entryCost=D((await position(user)).cost_basis);
  await send(user,'e2-part',{event:'SELL',reduce_only:true,quantity:'0.0007',entry:'66000.00'});
  const beforeFull=await position(user);
  const full=await send(user,'e2-full',{event:'SELL',reduce_only:true,entry:'66010.00'});
  assert.equal(full.status,'FILLED',full.error_message);
  assert.equal(D((await fillOf(full.id)).realized_r).toFixed(),bookedR(await fillOf(full.id),beforeFull.cost_basis,beforeFull.initial_risk),'full close books profit on the whole remaining cost');
  assert.equal(await count(user,'ledger.cost_divergence'),0,'a normal full close writes no divergence row');
  const flat=await position(user);
  assert.equal(flat.quantity,'0.000000000000000000');
  assert.equal(flat.cost_basis,'0.000000000000000000');
  assert.ok((await lots(user)).every(l=>l.status==='CLOSED'&&D(l.remaining_quantity).isZero()));
  // Flat to flat: cash change equals exit notional minus fees minus the entry cost, exactly.
  const exits=await db.prepare("SELECT f.* FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=? AND s.side='SELL'").all(user.id);
  assert.equal(exits.length,2);
  const exitNotional=exits.reduce((a,f)=>a.plus(f.quote_amount),D(0)),exitFees=exits.reduce((a,f)=>a.plus(f.fee_quote),D(0));
  const account_=await store.paperAccount(user.id,'binance-global');
  assert.equal(D(account_.positionCost).toFixed(),'0');
  assert.equal(D(account_.bookEquity).minus(CAPITAL).toFixed(),exitNotional.minus(exitFees).minus(entryCost).toFixed());
  assert.equal(D(account_.cash).minus(CAPITAL).toFixed(),D(account_.bookEquity).minus(CAPITAL).toFixed());
});

test('Debugger probe: full exit that used to be clamped to 0 with profit from the unclamped cost now removes the whole remainder',async()=>{
  const user=await account();
  // A stop close to the entry keeps the initial risk small, so a difference of 1e-17 in the booked profit still shows in realized_r.
  await send(user,'p2-buy',{...legacyBuy,sl:'65432.09'});
  const entry=await position(user),entryCost=D(entry.cost_basis);
  const lotCost=D((await lots(user))[0].entry_price).mul(entry.quantity);
  assert.ok(!lotCost.eq(entryCost),'probe input: the lot cost differs from the position cost');
  const exit=await send(user,'p2-exit',{event:'SELL',reduce_only:true,entry:'66000.00'});
  assert.equal(exit.status,'FILLED',exit.error_message);
  const flat=await position(user),fill=await fillOf(exit.id);
  assert.equal(flat.cost_basis,'0.000000000000000000');
  assert.equal(D(fill.quote_amount).minus(entryCost).minus(fill.fee_quote).toFixed(),
    D((await store.paperAccount(user.id,'binance-global')).cash).minus(CAPITAL).toFixed(),'cash moves by the exit proceeds minus the entry cost');
  assert.equal(D(fill.realized_r).toFixed(),bookedR(fill,entryCost,entry.initial_risk),'booked profit counts the cost actually removed, not the lot cost');
  assert.notEqual(D(fill.realized_r).toFixed(),bookedR(fill,lotCost,entry.initial_risk),'booked profit is not computed from the unrounded lot cost');
  assert.equal(await count(user,'ledger.cost_clamped'),0,'a full close removing the whole remainder is not a clamp');
});

test('Debugger probe: stalled exit no longer blocks another owner or the same owner\'s later entry',async()=>{
  const user=await account(),other=await account();
  await send(user,'p3-buy',legacyBuy);
  assert.equal((await send(user,'p3-exit',{event:'SELL',reduce_only:true,quantity:'0.0007',entry:'66000.00'})).status,'FILLED');
  assert.equal((await send(user,'p3-buy2',{event:'BUY',quantity:'0.001',entry:'65000',sl:'64000'})).status,'FILLED');
  assert.equal((await send(other,'p3-other',{event:'BUY',quantity:'0.001',entry:'65000',sl:'64000'})).status,'FILLED');
});

test('E8 L-I5 exits whose cost already terminates are identical to the unrounded rule, to the last digit',async()=>{
  const user=await account();
  await send(user,'e8-buy',{event:'BUY',quantity:'0.002',entry:'60000',sl:'59000'});
  const [lot]=await lots(user);assert.equal(lot.entry_price,'60000.000000000000000000');
  const before=await position(user);assert.equal(D(before.cost_basis).toFixed(),'120');
  const exit=await send(user,'e8-exit',{event:'SELL',reduce_only:true,quantity:'0.0005',entry:'61000'});
  assert.equal(exit.status,'FILLED',exit.error_message);
  const after=await position(user),fill=await fillOf(exit.id);
  const oldRemoved=D('0.0005').mul(lot.entry_price);
  assert.equal(D(after.cost_basis).toFixed(),D(before.cost_basis).minus(oldRemoved).toFixed());
  assert.equal(D(after.cost_basis).toFixed(),'90');
  assert.equal(D(after.cumulative_pnl).toFixed(),D(fill.quote_amount).minus(oldRemoved).minus(fill.fee_quote).toFixed());
  assert.equal(D(after.cumulative_pnl).toFixed(),'0.5');
  const closing=await send(user,'e8-close',{event:'SELL',reduce_only:true,entry:'59000'});
  assert.equal(closing.status,'FILLED',closing.error_message);
  assert.equal(D((await position(user)).cost_basis).toFixed(),'0');
});

test('E6 divergence: exit cost above the position cost clamps to 0, writes one audit row and profit uses the applied amount',async()=>{
  const user=await account();
  await send(user,'e6-buy',{event:'BUY',quantity:'0.002',entry:'60000',sl:'59000'});
  // Operator-style divergence: the position holds less cost than its lot implies.
  await db.query('UPDATE ledger_positions SET cost_basis=$2 WHERE user_id=$1',[user.id,'10']);
  const exit=await send(user,'e6-exit',{event:'SELL',reduce_only:true,quantity:'0.001',entry:'61000'});
  assert.equal(exit.status,'FILLED',exit.error_message);
  const after=await position(user),fill=await fillOf(exit.id);
  assert.equal(D(after.cost_basis).toFixed(),'0');
  assert.equal(D(after.cumulative_pnl).toFixed(),D(fill.quote_amount).minus('10').minus(fill.fee_quote).toFixed(),'removed is the 10 actually in the position');
  const audit=await db.prepare("SELECT * FROM audit WHERE user_id=? AND event='ledger.cost_clamped'").all(user.id);
  assert.equal(audit.length,1);
  assert.deepEqual(JSON.parse(audit[0].details),{signalId:exit.id,symbol:'BTCUSDT',clamped:'50'});
});

test('E9 rule marker is stored with the broker response of new fills and keeps the existing fields',async()=>{
  const user=await account();
  const buy=await send(user,'e9-buy',{event:'BUY',quantity:'0.001',entry:'60000',sl:'59000'});
  const exit=await send(user,'e9-exit',{event:'SELL',reduce_only:true,entry:'61000'});
  for(const row of [buy,exit]){
    const response=JSON.parse(row.broker_response);
    assert.equal(response.ledgerRule,'paper-exit-cost-o3-v1');
    assert.equal(response.paper,true);assert.equal(response.status,'FILLED');
  }
});

test('E7 property: random legacy-sized cycles never throw and keep cost representable, non-negative and conserved',async()=>{
  const user=await account();
  let seed=20261013;const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
  for(let i=0;i<12;i++){
    const price=D(60000).plus(D(Math.floor(rnd()*1000000)).div(100)).toFixed(2);
    const notional=10+Math.floor(rnd()*990);
    const startCash=D((await store.paperAccount(user.id,'binance-global')).cash);
    const buy=await send(user,'e7-buy-'+i,{event:'BUY',risk_mode:'FIXED_NOTIONAL',risk_value:String(notional),entry:price,sl:D(price).minus(1000).toFixed(2)});
    assert.equal(buy.status,'FILLED',buy.error_message);
    const entryCost=D((await position(user)).cost_basis);
    const qty=D((await position(user)).quantity);
    const take=down(qty.mul(0.2+rnd()*0.6));
    const part=await send(user,'e7-part-'+i,{event:'SELL',reduce_only:true,quantity:take,entry:D(price).plus(100).toFixed(2)});
    assert.equal(part.status,'FILLED',part.error_message);
    const mid=await position(user);
    assert.ok(places(mid.cost_basis)<=18&&D(mid.cost_basis).gte(0));
    const midFill=await fillOf(part.id);
    assert.equal(D(mid.cumulative_pnl).toFixed(),D(midFill.quote_amount).minus(D(entryCost).minus(mid.cost_basis)).minus(midFill.fee_quote).toFixed());
    const full=await send(user,'e7-full-'+i,{event:'SELL',reduce_only:true,entry:D(price).minus(100).toFixed(2)});
    assert.equal(full.status,'FILLED',full.error_message);
    assert.equal(D((await fillOf(full.id)).realized_r).toFixed(),bookedR(await fillOf(full.id),mid.cost_basis,mid.initial_risk));
    const flat=await position(user);
    assert.equal(D(flat.quantity).toFixed(),'0');assert.equal(D(flat.cost_basis).toFixed(),'0');
    const fills=await db.prepare('SELECT f.quote_amount,f.fee_quote FROM fills f WHERE f.signal_id IN (?,?)').all(part.id,full.id);
    const proceeds=fills.reduce((a,f)=>a.plus(f.quote_amount).minus(f.fee_quote),D(0));
    const endCash=D((await store.paperAccount(user.id,'binance-global')).cash);
    assert.equal(endCash.minus(startCash).toFixed(),proceeds.minus(entryCost).toFixed());
  }
  assert.equal(await count(user,'ledger.cost_clamped'),0);
  assert.equal(await count(user,'ledger.cost_divergence'),0);
});

test('E10 divergence at flat: a full close with lots covering less than the position cost removes it all and writes one audit row',async()=>{
  const user=await account();
  await send(user,'e10-buy',{event:'BUY',quantity:'0.001',entry:'60000',sl:'59000'});
  // Legacy-style quantity with no lot: the position holds 0.002 and 120 cost, the single lot covers 0.001 and 60.
  await db.query("UPDATE ledger_positions SET quantity=quantity+'0.001',cost_basis=cost_basis+60 WHERE user_id=$1",[user.id]);
  const before=await position(user);assert.equal(D(before.cost_basis).toFixed(),'120');
  const exit=await send(user,'e10-exit',{event:'SELL',reduce_only:true,entry:'61000'});
  assert.equal(exit.status,'FILLED',exit.error_message);
  const flat=await position(user),fill=await fillOf(exit.id);
  assert.equal(D(flat.quantity).toFixed(),'0');assert.equal(D(flat.cost_basis).toFixed(),'0');
  assert.equal(D(fill.realized_r).toFixed(),bookedR(fill,'120',before.initial_risk),'profit uses the whole position cost');
  const rows=await db.prepare("SELECT * FROM audit WHERE user_id=? AND event='ledger.cost_divergence'").all(user.id);
  assert.equal(rows.length,1);
  assert.deepEqual(JSON.parse(rows[0].details),{signalId:exit.id,symbol:'BTCUSDT',lotCost:'60',positionCost:'120',atFlat:true});
  assert.equal(await count(user,'ledger.cost_clamped'),0);
});
