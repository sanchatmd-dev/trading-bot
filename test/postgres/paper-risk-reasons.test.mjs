import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {receiveBridge} from '../../src/postgres/pine-bridge-receiver.js';
import {evaluateRisk} from '../../src/postgres/risk.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {finalizeBridgeOrder} from '../../src/postgres/paper-cost-model.js';
import {D} from '../../src/money.js';
import {config} from '../../src/config.js';
import {MODEL,BASE_POLICY,createBot,writeBar,buyEvent} from '../helpers/paper-risk-reasons-fixture.mjs';

/**
 * PM-1 F03-01 gap tests: Paper risk reasons and capped quantities on the src/postgres/risk.js + Bridge execution path.
 *
 * Contract sources for the expected values (the reason strings themselves are pinned from src/postgres/risk.js and
 * src/postgres/pine-bridge-execution.js, because no document spells them out):
 *  - docs/responsive-risk-update.md L10: Percent Equity BUY quantity is reduced to the lowest of the risk-derived size, free
 *    configured equity after committed and reserved capital, the order cap and the remaining daily budget; the adjustment is
 *    recorded. L11: an explicit quantity or fixed notional that is oversized is still rejected, not capped.
 *  - docs/UNIVERSAL_RISK_MANAGER.md L92 (new entries must satisfy free cash, order and daily notional limits) and L94 (decimal
 *    arithmetic, directional rounding, tick/step rules, revalidate after rounding, reserve buy cost plus fees).
 *  - docs/PF_1A_CHECKPOINT_2026-09-28.md L57-58: a calculation is ACCEPTED, CAPPED or REJECTED; docs/QL_2A_IMPLEMENTATION.md
 *    L30: filled outcomes are CAPPED or ACCEPTED; docs/QL_3A_IMPLEMENTATION.md L31: cash below one venue quantity step explains
 *    BUY rejections; docs/APP_3A_IMPLEMENTATION.md L12: a rejected BUY acquires no entry or allocation mapping.
 * Every number below is derived by hand from price 100, stop 90 (ATR 5 x 2), equity and cash 1000 USDT, 1% risk, fee 10 bps and
 * quantity step 0.001, and is written as a literal on purpose: a changed rule must fail here, not follow silently. The market
 * data are synthetic and say nothing about strategy performance.
 */
let admin,db,store,databaseName;
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 databaseName='paper_risk_reasons_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+databaseName);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
 db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
 await db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8')));
 store=new Store(db);
 await installQuantGuards(db);
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});

const CAP='Capped to available equity and notional limits';
const STEP='Capped/rounded to verified venue quantity step';
const n=value=>D(value).toFixed();

// ---- evaluateRisk and finalizeBridgeOrder, pure --------------------------------------------------------------------------
let tradeCounter=0;
const signal=(over={})=>normalizeSignal({trade_id:'pure-'+(++tradeCounter),broker:'Binance Global',symbol:'BTCUSDT',event:'BUY',risk_mode:'PERCENT_EQUITY',risk_value:'1',entry:'100',sl:'90',timestamp:Date.now(),...over});
const context=(o={})=>({policy:{...BASE_POLICY,...o.policy},daily:{trades:0,notional:'0',realized_r:'0',loss_streak:0,...o.daily},position:{quantity:'0'},equity:'1000',balance:'1000',licensed:true,openPositions:0,...o.context});
const decide=(o={},s=signal())=>evaluateRisk(s,context(o));
function assertCapped(result,{quantity,notional,requested}){
 assert.equal(result.ok,true,result.reason);
 assert.equal(result.order.quantity,quantity);assert.equal(result.order.notional,notional);
 assert.deepEqual(result.order.sizingAdjustment,{requestedQuantity:requested,quantity,reason:CAP});
}
function assertDecisionRejected(result,reason){assert.deepEqual({ok:result.ok,reason:result.reason},{ok:false,reason});assert.equal('order' in result,false);}

test('evaluateRisk control: nothing binds, so the BUY is ACCEPTED at the risk-derived quantity with no adjustment',()=>{
 const result=decide();
 assert.equal(result.ok,true);assert.equal(result.order.quantity,'1');assert.equal(result.order.notional,'100');assert.equal(result.order.price,'100');
 assert.equal('sizingAdjustment' in result.order,false);
});

test('evaluateRisk CAPPED: each of free equity, cash, order notional and daily notional caps the quantity exactly, with the reason and requested quantity',()=>{
 // Free equity after committed capital: 1000 - 950 = 50 USDT -> 50 / 100 = 0.5. Cash and notional budgets are far above it.
 assertCapped(decide({context:{committedNotional:'950',cashAvailable:'900'}}),{quantity:'0.5',notional:'50',requested:'1'});
 // Cash available 25 USDT -> 0.25.
 assertCapped(decide({context:{cashAvailable:'25'}}),{quantity:'0.25',notional:'25',requested:'1'});
 // Order notional cap 40 USDT -> 0.4.
 assertCapped(decide({policy:{maxOrderNotional:40}}),{quantity:'0.4',notional:'40',requested:'1'});
 // Daily budget 100 - 60 used - 10 reserved = 30 USDT -> 0.3.
 assertCapped(decide({policy:{maxDailyNotional:100},daily:{notional:'60'},context:{committedNotional:'10',reservedNotional:'10'}}),{quantity:'0.3',notional:'30',requested:'1'});
 // The smallest of the four binds: equity 300, cash 200, order 150, daily 300 -> 150 / 100 = 1.5 of a requested 2 (risk value 2%).
 assertCapped(decide({policy:{maxOrderNotional:150,maxDailyNotional:400},daily:{notional:'100'},context:{committedNotional:'700',cashAvailable:'200'}},signal({risk_value:'2'})),{quantity:'1.5',notional:'150',requested:'2'});
 // Budget remaining of 0.01 USDT still yields a capped fill of 0.0001, never a rejection.
 assertCapped(decide({policy:{maxDailyNotional:100},daily:{notional:'99.99'}}),{quantity:'0.0001',notional:'0.01',requested:'1'});
});

test('evaluateRisk: the cash budget of a fee-grossed-down balance caps to an exact 18-decimal quantity before the quantity step',()=>{
 // Bridge worker cash budget: 50 / (1 + 10 bps) = 49.95004995004995005 USDT (src/postgres/worker.js:100) -> floor to 18 places of /100.
 const result=decide({context:{balance:'50',cashAvailable:'49.95004995004995005'}});
 assertCapped(result,{quantity:'0.4995004995004995',notional:'49.95004995004995',requested:'1'});
});

test('evaluateRisk: an explicit quantity or a disabled cap is rejected, never capped (docs/responsive-risk-update.md L11)',()=>{
 assertDecisionRejected(decide({policy:{maxOrderNotional:40}},signal({risk_mode:'QUANTITY',risk_value:undefined,quantity:'1'})),'Maximum order notional exceeded');
 assertDecisionRejected(decide({policy:{maxOrderNotional:40,capPercentEquitySize:false}}),'Maximum order notional exceeded');
 assertDecisionRejected(decide({policy:{maxDailyNotional:150},daily:{notional:'100'}},signal({risk_mode:'QUANTITY',risk_value:undefined,quantity:'1'})),'Maximum daily notional exceeded');
 assertDecisionRejected(decide({context:{cashAvailable:'50'}},signal({risk_mode:'QUANTITY',risk_value:undefined,quantity:'1'})),'Order exceeds available configured Spot balance');
});

test('evaluateRisk REJECTED: no remaining Spot sizing budget, for every exhausted budget term and only at zero or below',()=>{
 const reason='No remaining Spot sizing budget';
 assertDecisionRejected(decide({context:{cashAvailable:'0'}}),reason);
 assertDecisionRejected(decide({context:{cashAvailable:'-1'}}),reason);
 assertDecisionRejected(decide({context:{committedNotional:'1000'}}),reason);
 assertDecisionRejected(decide({policy:{maxOrderNotional:0}}),reason);
 assertDecisionRejected(decide({policy:{maxDailyNotional:100},daily:{notional:'100'}}),reason);
 assertDecisionRejected(decide({policy:{maxDailyNotional:100},daily:{notional:'100.01'}}),reason);
 assertDecisionRejected(decide({policy:{maxDailyNotional:100},daily:{notional:'90'},context:{reservedNotional:'10'}}),reason);
});

test('evaluateRisk REJECTED: maximum open positions applies only to a BUY that opens a new symbol, at the exact limit',()=>{
 const policy={maxOpenPositions:3};
 assertDecisionRejected(decide({policy,context:{openPositions:3}}),'Maximum open positions reached');
 assertDecisionRejected(decide({policy,context:{openPositions:4}}),'Maximum open positions reached');
 assert.equal(decide({policy,context:{openPositions:2}}).ok,true);
 // Adding to a symbol that already has a position, or that has a pending order, does not open a new symbol.
 assert.equal(evaluateRisk(signal(),{...context({policy,context:{openPositions:3}}),position:{quantity:'1'}}).ok,true);
 assert.equal(decide({policy,context:{openPositions:3,hasPendingOrder:true}}).ok,true);
});

test('evaluateRisk REJECTED: maximum risk percent, at the exact boundary and one 18-decimal unit above it',()=>{
 const explicit=quantity=>signal({risk_mode:'QUANTITY',risk_value:undefined,quantity});
 // Risk = quantity x |100 - 90|; budget = 1000 x 2% = 20 USDT, so 2 is accepted (not greater) and 2.000000000000000001 is not.
 const atLimit=decide({},explicit('2'));
 assert.equal(atLimit.ok,true);assert.equal(atLimit.order.quantity,'2');assert.equal(atLimit.order.notional,'200');
 assertDecisionRejected(decide({},explicit('2.000000000000000001')),'Calculated risk exceeds maximum risk percent');
 assertDecisionRejected(decide({},explicit('3')),'Calculated risk exceeds maximum risk percent');
 // Percent Equity cannot exceed the policy percent: a requested percent above it is rejected before sizing.
 assertDecisionRejected(decide({},signal({risk_value:'2.01'})),'Risk percent exceeds policy');
 const same=decide({},signal({risk_value:'2'}));
 assert.equal(same.ok,true);assert.equal(same.order.quantity,'2');
});

test('finalizeBridgeOrder (paper-close-v1): rounds down to the quantity step, keeps the requested quantity, and rejects below one step',()=>{
 const capped={side:'BUY',quantity:'0.4995004995004995',price:'100',sizingAdjustment:{requestedQuantity:'1',quantity:'0.4995004995004995',reason:CAP}};
 const rounded=finalizeBridgeOrder(capped,MODEL);
 assert.equal(rounded.order.quantity,'0.499');assert.equal(rounded.order.notional,'49.9');assert.equal(rounded.fee,'0.0499');
 assert.deepEqual(rounded.order.sizingAdjustment,{requestedQuantity:'1',quantity:'0.499',reason:STEP});
 // Without an earlier cap the requested quantity is the pre-rounding quantity.
 const fresh=finalizeBridgeOrder({side:'BUY',quantity:'0.833333333333333333',price:'100'},MODEL);
 assert.equal(fresh.order.quantity,'0.833');assert.equal(fresh.order.notional,'83.3');assert.equal(fresh.fee,'0.0833');
 assert.deepEqual(fresh.order.sizingAdjustment,{requestedQuantity:'0.833333333333333333',quantity:'0.833',reason:STEP});
 // An exact multiple of the step changes nothing and records no adjustment; an earlier cap record is kept untouched.
 const exact=finalizeBridgeOrder({side:'BUY',quantity:'0.5',price:'100',sizingAdjustment:{requestedQuantity:'1',quantity:'0.5',reason:CAP}},MODEL);
 assert.equal(exact.order.quantity,'0.5');assert.equal(exact.fee,'0.05');assert.deepEqual(exact.order.sizingAdjustment,{requestedQuantity:'1',quantity:'0.5',reason:CAP});
 assert.equal('sizingAdjustment' in finalizeBridgeOrder({side:'BUY',quantity:'1',price:'100'},MODEL).order,false);
 assert.throws(()=>finalizeBridgeOrder({side:'BUY',quantity:'0.000999999999999999',price:'100'},MODEL),{code:'BELOW_QUANTITY_STEP'});
});

// ---- Bridge execution path: real receiver, ExecutionWorker, Ledger ------------------------------------------------------
let barTime=Date.now()-120000;
const nextBar=()=>barTime+=1000;
/** Runs the real worker until nothing is queued. A leftover QUEUED row would mask a later test, so it is asserted away. */
async function drain(){
 const worker=new ExecutionWorker({store,config});
 for(let i=0;i<20;i++)if(!await worker.tick())break;
 assert.equal(Number((await db.prepare("SELECT count(*) n FROM signals WHERE status='QUEUED'").get()).n),0);
}
/** One Bot with its READY deployment; a failed assertion still cancels anything left queued for it. */
async function scenario(options,body){
 const x=await createBot({db,store,...options});
 try{return await body(x);}
 finally{await db.prepare("UPDATE signals SET status='CANCELED' WHERE user_id=? AND status='QUEUED'").run(x.a);}
}
async function placeBuy(x,bar){
 const time=nextBar();await writeBar(db,time,bar);
 const received=await receiveBridge(store,x.secret,buyEvent(x.market,time,bar));
 assert.equal(received.accepted,true);assert.equal(received.duplicate,false);
 await drain();
 return db.prepare('SELECT * FROM signals WHERE id=?').get(received.signal_id);
}
async function placeLegacy(x,symbol,quantity){
 const tradeId='legacy-'+randomUUID();
 assert.equal(await store.enqueue(x.a,normalizeSignal({trade_id:tradeId,broker:'Binance Global',symbol,event:'BUY',quantity,entry:'100',sl:'90',timestamp:Date.now()}),'PAPER'),true);
 await drain();
 return db.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(x.a,tradeId);
}
const count=async(sql,...params)=>Number((await db.prepare(sql).get(...params)).n);
async function ledger(x){
 const account=await store.paperAccount(x.a,'binance-global');
 return {cash:n(account.cash),positionCost:n(account.positionCost),
  fills:await count('SELECT count(*) n FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=?',x.a),
  allocations:await count('SELECT count(*) n FROM ledger_position_allocations WHERE user_id=?',x.a),
  journal:await count('SELECT count(*) n FROM paper_cash_journal WHERE user_id=?',x.a),
  entries:await count('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?',x.deploymentId)};
}
/** REJECTED means status, exact reason, an audit row, a notification and, for a Bridge event, outcome REJECTED; and no ledger effect at all. */
async function assertSignalRejected(x,row,reason,before){
 assert.equal(row.status,'REJECTED');assert.equal(row.error_message,reason);
 assert.equal(n(row.applied_quantity),'0');assert.equal(row.order_intent,null);assert.equal(row.order_id,null);
 const audit=await db.prepare("SELECT details FROM audit WHERE user_id=? AND event='risk.rejected' AND trade_id=?").get(x.a,row.trade_id);
 assert.deepEqual(JSON.parse(audit.details),{reason});
 assert.equal(await count('SELECT count(*) n FROM notification_outbox WHERE user_id=? AND subject=? AND body=?',x.a,'Robot trade rejected '+row.trade_id,reason),1);
 assert.equal(await count('SELECT count(*) n FROM fills WHERE signal_id=?',row.id),0);
 assert.equal(await count('SELECT count(*) n FROM paper_cash_journal WHERE signal_id=?',row.id),0);
 assert.equal(await count('SELECT count(*) n FROM ledger_position_allocations WHERE entry_signal_id=?',row.id),0);
 if(JSON.parse(row.payload).bridge){
  const event=await db.prepare('SELECT outcome FROM pine_bridge_events WHERE signal_id=?').get(row.id);
  assert.equal(event.outcome,'REJECTED');
  assert.equal(await count('SELECT count(*) n FROM pine_bridge_entries WHERE deployment_id=?',x.deploymentId),before.ledger.entries);
 }
 assert.deepEqual(await ledger(x),before.ledger);
}
const snapshot=async x=>({ledger:await ledger(x)});

const CASES=[
 {name:'ACCEPTED control: nothing binds, no sizing adjustment',options:{},bar:{},quantity:'1',notional:'100',fee:'0.1',cash:'899.9',adjustment:null},
 {name:'CAPPED by order notional 50: 0.5 of a requested 1',options:{policy:{maxOrderNotional:50}},bar:{},quantity:'0.5',notional:'50',fee:'0.05',cash:'949.95',
  adjustment:{requestedQuantity:'1',quantity:'0.5',reason:CAP}},
 {name:'CAPPED by daily notional 75: 0.75 of a requested 1',options:{policy:{maxDailyNotional:75}},bar:{},quantity:'0.75',notional:'75',fee:'0.075',cash:'924.925',
  adjustment:{requestedQuantity:'1',quantity:'0.75',reason:CAP}},
 {name:'CAPPED by cash 50, then rounded down to the 0.001 step: 0.499 (before rounding 0.4995004995004995)',options:{cash:50},bar:{},quantity:'0.499',notional:'49.9',fee:'0.0499',cash:'0.0501',
  adjustment:{requestedQuantity:'1',quantity:'0.499',reason:STEP}},
 {name:'CAPPED by the quantity step alone: ATR 6 requests 0.833333333333333333, fills 0.833',options:{},bar:{atr:6},quantity:'0.833',notional:'83.3',fee:'0.0833',cash:'916.6167',
  adjustment:{requestedQuantity:'0.833333333333333333',quantity:'0.833',reason:STEP},stop:'88',target:'118'}
];
for(const c of CASES)test('Bridge BUY '+c.name,()=>scenario(c.options,async x=>{
 const before=await ledger(x);
 const row=await placeBuy(x,c.bar);
 assert.equal(row.status,'FILLED',row.error_message);assert.equal(row.error_message,null);
 assert.equal(n(row.applied_quantity),c.quantity);assert.equal(n(row.applied_quote),c.notional);
 const intent=JSON.parse(row.order_intent);
 assert.equal(intent.quantity,c.quantity);assert.equal(intent.notional,c.notional);assert.equal(intent.price,'100');
 if(c.adjustment)assert.deepEqual(intent.sizingAdjustment,c.adjustment);else assert.equal('sizingAdjustment' in intent,false);
 const fill=await db.prepare('SELECT * FROM fills WHERE signal_id=?').get(row.id);
 assert.equal(n(fill.delta_quantity),c.quantity);assert.equal(n(fill.quote_amount),c.notional);assert.equal(n(fill.fee_quote),c.fee);assert.equal(n(fill.price),'100');
 const allocation=await db.prepare('SELECT * FROM ledger_position_allocations WHERE entry_signal_id=?').get(row.id);
 assert.equal(n(allocation.filled_quantity),c.quantity);assert.equal(n(allocation.remaining_quantity),c.quantity);assert.equal(n(allocation.entry_price),'100.1');
 assert.equal(n(allocation.stop_loss),c.stop??'90');assert.equal(n(allocation.take_profit),c.target??'115');
 const mapped=await db.prepare('SELECT allocation_id FROM pine_bridge_entries WHERE deployment_id=?').all(x.deploymentId);
 assert.deepEqual(mapped.map(r=>r.allocation_id),[allocation.position_id]);
 const after=await ledger(x);
 assert.equal(after.cash,c.cash);assert.equal(after.fills,before.fills+1);assert.equal(after.allocations,before.allocations+1);assert.equal(after.entries,before.entries+1);
 assert.equal((await db.prepare('SELECT outcome FROM pine_bridge_events WHERE signal_id=?').get(row.id)).outcome,'FILLED');
}));

test('Bridge BUY sequence: the daily notional budget is spent by the first fill, caps the second and rejects the third',()=>scenario({policy:{maxDailyNotional:150}},async x=>{
 const first=await placeBuy(x,{});
 assert.equal(first.status,'FILLED');assert.equal(n(first.applied_quantity),'1');assert.equal('sizingAdjustment' in JSON.parse(first.order_intent),false);
 // Remaining daily budget 150 - 100 = 50 USDT -> 0.5 of a requested 1. Free equity 899.9 and cash 899.0009 are not binding.
 const second=await placeBuy(x,{});
 assert.equal(second.status,'FILLED');assert.equal(n(second.applied_quantity),'0.5');assert.equal(n(second.applied_quote),'50');
 assert.deepEqual(JSON.parse(second.order_intent).sizingAdjustment,{requestedQuantity:'1',quantity:'0.5',reason:CAP});
 const afterTwo=await ledger(x);
 assert.equal(afterTwo.cash,'849.85');assert.equal(afterTwo.allocations,2);assert.equal(afterTwo.fills,2);assert.equal(afterTwo.entries,2);
 // Daily budget 150 - 150 = 0: nothing is left to size, so the BUY is rejected and the ledger does not move.
 const third=await placeBuy(x,{});
 await assertSignalRejected(x,third,'No remaining Spot sizing budget',{ledger:afterTwo});
}));

test('Bridge BUY REJECTED: no sizing budget when the configured cash is 0, with no fill, allocation or mapping',()=>scenario({cash:0},async x=>{
 const before=await snapshot(x);
 assert.equal(before.ledger.cash,'0');
 await assertSignalRejected(x,await placeBuy(x,{}),'No remaining Spot sizing budget',before);
}));

test('Bridge BUY REJECTED: cash below one quantity step is BELOW_QUANTITY_STEP (docs/QL_3A_IMPLEMENTATION.md L31)',()=>scenario({cash:0.05},async x=>{
 // 0.05 / 1.001 = 0.04995004995004995 USDT -> 0.000499500499500499 quantity, which is under one 0.001 step.
 const before=await snapshot(x);
 assert.equal(before.ledger.cash,'0.05');
 await assertSignalRejected(x,await placeBuy(x,{}),'BELOW_QUANTITY_STEP',before);
}));

test('Bridge BUY REJECTED: maximum open positions, counting another symbol, and the same sequence fills one position higher',async()=>{
 await scenario({policy:{maxOpenPositions:1}},async x=>{
  const eth=await placeLegacy(x,'ETHUSDT','1');
  assert.equal(eth.status,'FILLED',eth.error_message);
  const before=await snapshot(x);
  assert.equal(before.ledger.allocations,1);assert.equal(before.ledger.cash,'900');
  await assertSignalRejected(x,await placeBuy(x,{}),'Maximum open positions reached',before);
 });
 await scenario({policy:{maxOpenPositions:2}},async x=>{
  assert.equal((await placeLegacy(x,'ETHUSDT','1')).status,'FILLED');
  const row=await placeBuy(x,{});
  assert.equal(row.status,'FILLED',row.error_message);assert.equal(n(row.applied_quantity),'1');
  assert.equal((await ledger(x)).allocations,2);
 });
});

test('Bridge BUY REJECTED: risk percent above the policy maximum, and accepted at exactly the maximum',async()=>{
 // The deployment evidence says 1% risk. Activation would refuse a policy maximum of 0.5% (RISK_EXCEEDS_POLICY), so this
 // inconsistent state is seeded directly to pin the worker's own check.
 await scenario({policy:{maxRiskPercent:0.5}},async x=>{
  const before=await snapshot(x);
  await assertSignalRejected(x,await placeBuy(x,{}),'Risk percent exceeds policy',before);
 });
 // 1% of 1000 = 10 USDT = quantity 1 x distance 10: the boundary is not "greater than", so it fills.
 await scenario({policy:{maxRiskPercent:1}},async x=>{
  const row=await placeBuy(x,{});
  assert.equal(row.status,'FILLED',row.error_message);assert.equal(n(row.applied_quantity),'1');
 });
});

test('Paper worker REJECTED: calculated risk above the maximum risk percent (explicit quantity), accepted at the exact boundary',()=>scenario({},async x=>{
 // Bridge events always size by Percent Equity, which cannot exceed the percent, so this reason is reachable only for an
 // explicit quantity. The same worker, risk module and ledger apply. Budget 1000 x 2% = 20 USDT; quantity 3 risks 30.
 const before=await snapshot(x);
 await assertSignalRejected(x,await placeLegacy(x,'ETHUSDT','3'),'Calculated risk exceeds maximum risk percent',before);
 const boundary=await placeLegacy(x,'ETHUSDT','2');
 assert.equal(boundary.status,'FILLED',boundary.error_message);assert.equal(n(boundary.applied_quantity),'2');
 assert.equal((await ledger(x)).cash,'800');
}));
