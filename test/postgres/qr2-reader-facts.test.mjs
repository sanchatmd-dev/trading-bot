import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {readQr2Account} from '../../src/postgres/qr2-reader.js';
import {createQr2Database,createOwner,createBot,policyFor,book,send,insertBars,barOf,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';

// QR-2 S2b facts (design T10 and T11; contract 6.6 R14 and R15, 2.4 FILL_BEFORE_BAR, 8.3 attribution, 8.4 slippage, 17, 18). Isolated local
// PostgreSQL only. The ledger is written by the live recordFunding / recordExecution; every direct-SQL write is a labelled fault or fixture
// exception made by the test. Expected values are hand-worked literals in the comments.
let fx,db,store;
before(async()=>{fx=await createQr2Database('robot_qr2_facts');({db,store}=fx);});
after(async()=>{await fx?.dispose();});

const newBot=async(capital=10000,thb=0)=>{const o=await createOwner(store);const bot=await createBot(store,o,capital,thb);bot.owner=o;return bot;};
const read=(bot,extra={},broker='binance-global')=>{
  const now=extra.requestTime??Date.now();
  return readQr2Account(store,{ownerId:bot.owner.id,botId:bot.id,broker,from:bot.created_at,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2,...extra});
};
async function bars(price='62000'){await db.query('DELETE FROM public.pine_market_bars');await insertBars(db,[barOf(Math.floor((Date.now()-1000)/60000)*60000,price)]);}
const uid=bot=>bot.id.slice(0,6);

test('T10 unbacked configured equity stays outside NAV on its own line',async()=>{
  const owner=await createOwner(store);
  // Capital: equity 10000 configured, cash 8000 funded. Hand values: NAV = cash 8000; unbacked equity = 10000 - 8000 = 2000.
  const bot=await store.createBot(owner.id,'unbacked',{...policyFor(10000),balances:{'binance-global':8000,'binance-th':0}});bot.owner=owner;
  const result=await read(bot);
  assert.equal(result.performance.nav_to.nav,'8000');
  assert.deepEqual(result.facts.unbacked_equity,{value:'2000',identity_ok:true});
  assert.equal(result.performance.money_pnl.value,'0');
});

test('T10 a non-BTCUSDT position and a THB account are unpriced and PARTIAL; quantity and cost stay visible',async()=>{
  const bot=await newBot(10000,50000);
  await book(store,bot,'eth-'+uid(bot),{side:'BUY',symbol:'ETHUSDT',steps:[{qty:'0.1',quote:'300'}]});
  const eth=await read(bot);
  const position=eth.performance.nav_to.positions[0];
  assert.deepEqual([position.symbol,position.state,position.quantity,position.cost,position.market_value],['ETHUSDT','UNSUPPORTED_MARKET','0.1','300',null]);
  assert.equal(eth.performance.nav_to.nav,null);assert.equal(eth.performance.nav_to.cash,'9700');
  assert.equal(eth.status.status,'PARTIAL');assert.equal(eth.facts.market_data.checked,false,'no price is read for an unsupported market');
  await book(store,bot,'thb-'+uid(bot),{side:'BUY',symbol:'BTCTHB',broker:'Binance TH',steps:[{qty:'0.01',quote:'20000'}]});
  const thb=await read(bot,{},'binance-th');
  assert.equal(thb.scope.currency,'THB');
  assert.equal(thb.performance.nav_to.positions[0].state,'UNSUPPORTED_MARKET');
  assert.equal(thb.performance.nav_to.cash,'30000');assert.equal(thb.status.status,'PARTIAL');
});

test('T10 R15 pending orders: present, UNKNOWN, unknown fee reservation and an unreadable intent are PENDING_ORDER_UNCERTAIN; a historical to is RESERVATION_HISTORY_NOT_RECORDED',async()=>{
  await bars('62000');
  const bot=await newBot(10000);
  await book(store,bot,'done-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});                // a finished order is not pending; cash is now 9400
  // A pending BUY for 0.01 at 60000 with the Paper cost model: reserved notional 600, reserved fee 600 x 10 / 10000 = 0.6 (labelled direct status).
  assert.equal(await store.enqueue(bot.id,{tradeId:'pend-'+uid(bot),broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',timestamp:Date.now(),quantity:'0.01',referencePrice:'60000',stopLoss:'59000',riskMode:'QUANTITY'}),true);
  const intent=JSON.stringify({quantity:'0.01',price:'60000',execution_model_version:'paper-close-cost-v2',reserved_fee_bps:'10'});
  const setPending=(status,orderIntent)=>db.query('UPDATE public.signals SET status=$2,order_intent=$3 WHERE user_id=$1 AND trade_id=$4',[bot.id,status,orderIntent,'pend-'+uid(bot)]);
  await setPending('SUBMITTED',intent);
  let r15=(await read(bot)).facts.r15;
  assert.deepEqual([r15.count,r15.codes,r15.uncertain],[1,['PENDING_ORDERS_PRESENT'],false]);
  assert.equal(r15.available_cash,'8799.4');                                                          // 9400 - 600 - 0.6
  const certain=await read(bot);assert.equal(certain.status.status,'COMPLETE');
  await setPending('UNKNOWN',intent);
  let view=await read(bot);r15=view.facts.r15;
  assert.deepEqual(r15.codes,['PENDING_ORDERS_PRESENT','PENDING_ORDER_UNCERTAIN']);assert.equal(r15.available_cash,null);
  assert.equal(view.status.status,'PARTIAL');assert.ok(view.status.reasons.includes('PENDING_ORDER_UNCERTAIN'));
  await setPending('SUBMITTED',null);                                                                 // no recorded intent: feeReservationUnknown
  assert.equal((await read(bot)).facts.r15.uncertain,true);
  await setPending('SUBMITTED','{broken');                                                            // a JSON parse error inside exposure() is not a reader failure
  view=await read(bot);assert.equal(view.facts.r15.uncertain,true);assert.equal(view.status.status,'PARTIAL');
  await setPending('SUBMITTED',intent);
  const now=Date.now();
  const historical=await read(bot,{requestTime:now+5000,to:now});
  assert.equal(historical.facts.r15.available_cash,null);assert.equal(historical.facts.r15.available_cash_reason,'RESERVATION_HISTORY_NOT_RECORDED');
  assert.equal(historical.facts.r15.count,1);
});

test('T10 R15 only the JSON parse failure of the exposure read is mapped; a SQLSTATE, a connection error or any other error propagates',async()=>{
  const bot=await newBot(10000);
  const failing=error=>{const wrapped=Object.create(store);wrapped.exposure=async()=>{throw error;};return wrapped;};
  const now=Date.now(),args={ownerId:bot.owner.id,botId:bot.id,broker:'binance-global',from:bot.created_at,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2};
  for(const error of [Object.assign(new Error('canceling statement due to statement timeout'),{code:'57014'}),Object.assign(new Error('current transaction is aborted'),{code:'25P02'}),
    Object.assign(new Error('Connection terminated unexpectedly'),{code:'ECONNRESET'}),Object.assign(new Error('could not serialize access'),{code:'40001'}),new Error('boom'),new TypeError('not a parse error')])
    await assert.rejects(readQr2Account(failing(error),args),e=>e===error,error.message);
  const mapped=await readQr2Account(failing(new SyntaxError('Unexpected token')),args);
  assert.equal(mapped.facts.r15.uncertain,true);assert.deepEqual(mapped.facts.r15.codes,['PENDING_ORDER_UNCERTAIN']);
  assert.equal(mapped.status.status,'PARTIAL');
});

test('T10 a target exit where the analytics FIFO differs: REALIZED_METHOD_DIFFERS_FROM_ANALYTICS with the NAV the cash and price give',async()=>{
  await bars('62000');
  const bot=await newBot(10000);
  await book(store,bot,'ta-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});              // lot A cost 60000
  await book(store,bot,'tb-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'620'}]});              // lot B cost 62000
  await book(store,bot,'tx-'+uid(bot),{side:'SELL',target:'tb-'+uid(bot),steps:[{qty:'0.01',quote:'630'}]});
  // Targeted exit of lot B: realized 630 - 620 = 10. The analytics FIFO ignores the target and consumes lot A: 630 - 600 = 30.
  const result=await read(bot);
  assert.deepEqual([result.facts.analytics.code,result.facts.analytics.realized_replay,result.facts.analytics.realized_fifo_ignoring_targets],['REALIZED_METHOD_DIFFERS_FROM_ANALYTICS','10','30']);
  assert.equal(result.facts.analytics.targeted_exits,1);
  // NAV does not depend on the lot choice: cash 10000 - 600 - 620 + 630 = 9410 plus 0.01 x 62000 = 620.
  assert.equal(result.performance.nav_to.nav,'10030');
  assert.equal(result.performance.nav_to.realized,'10');
  for(const key of ['R1','R2','R4','R5','R6','R7','R11','RI'])assert.equal(result.gates.gates[key].ok,true,key);
  assert.notEqual(result.performance.twr.value,null);
  // No target: no comparison is made.
  const plain=await newBot(10000);
  await book(store,plain,'p1-'+uid(plain),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(store,plain,'p2-'+uid(plain),{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  assert.equal((await read(plain)).facts.analytics.code,null);
});

test('T10 R14 lists the cost_clamped audit rows of own SELL signals with their fills; unparseable rows are counted; foreign signals are not listed',async()=>{
  const bot=await newBot(10000);
  await book(store,bot,'c1-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  // Labelled lot/position divergence: the position cost is lower than the lot cost, so a partial exit clamps (the live ledger writes the audit row).
  await db.query('UPDATE public.ledger_positions SET cost_basis=100 WHERE user_id=$1',[bot.id]);
  const sell=await book(store,bot,'c2-'+uid(bot),{side:'SELL',steps:[{qty:'0.005',quote:'305'}]});
  const written=(await db.query("SELECT details FROM public.audit WHERE user_id=$1 AND event='ledger.cost_clamped'",[bot.id])).rows;
  assert.equal(written.length,1);assert.equal(JSON.parse(written[0].details).clamped,'200');
  await db.query("INSERT INTO public.audit(user_id,ts,event,trade_id,details) VALUES($1,1,'ledger.cost_divergence','x','not json')",[bot.id]);                 // labelled
  await db.query("INSERT INTO public.audit(user_id,ts,event,trade_id,details) VALUES($1,2,'ledger.cost_clamped','y','{\"signalId\":999999,\"symbol\":\"BTCUSDT\"}')",[bot.id]);
  const result=await read(bot);
  const r14=result.facts.r14;
  assert.equal(r14.rows.length,1);
  assert.deepEqual([r14.rows[0].event,r14.rows[0].signal_id,r14.rows[0].in_range,r14.rows[0].fill_keys],['ledger.cost_clamped',sell.id,true,[sell.id+':0.005']]);
  assert.equal(r14.unparseable.length,1);assert.equal(r14.unparseable[0].reason,'DETAILS_NOT_PARSEABLE');
  assert.equal(result.gates.gates.R7.ok,false,'the position cost is also a COST_DRIFT against the replay');
});

test('T10 FILL_BEFORE_BAR on a Bridge fill blocks the account; a fill after its bar passes; webhook fills are FILL_BEFORE_BAR_UNCHECKED information',async()=>{
  const bot=await newBot(10000);
  const buy=await book(store,bot,'f1-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(store,bot,'f2-'+uid(bot),{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  const fill=(await db.query('SELECT received_at FROM public.fills WHERE signal_id=$1',[buy.id])).rows[0];
  const setBar=barTime=>db.query("UPDATE public.signals SET payload=(payload::jsonb||jsonb_build_object('bridge',jsonb_build_object('deployment_id','dep-1','bar_time',$2::bigint)))::text WHERE id=$1",[buy.id,barTime]);   // labelled payload edit
  await setBar(fill.received_at-1000);
  let result=await read(bot);
  assert.equal(result.gates.gates.RC.ok,true);
  assert.deepEqual(result.gates.gates.RC.information.map(i=>[i.code,i.count]),[['FILL_BEFORE_BAR_UNCHECKED',1]]);
  await setBar(fill.received_at+1);
  result=await read(bot);
  const failure=result.gates.gates.RC.failures[0];
  assert.deepEqual([failure.code,failure.event_key,failure.bar_time,failure.time],['FILL_BEFORE_BAR',buy.id+':0.01',fill.received_at+1,fill.received_at]);
  assert.equal(result.status.status,'UNAVAILABLE');assert.equal(result.performance.money_pnl.value,null);
});

test('T10 attribution tags and slippage labels per fill: BRIDGE, WEBHOOK, ATTRIBUTION_UNKNOWN; modeled slippage only with a recorded intent, else SLIPPAGE_UNKNOWN',async()=>{
  await bars('62000');
  const bot=await newBot(10000);
  const worker=await send(store,bot,'w1-'+uid(bot),{event:'BUY',quantity:'0.01',entry:'60000',sl:'59000'});          // real worker: intent and slippage recorded
  const bridge=await book(store,bot,'w2-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  const garbage=await book(store,bot,'w3-'+uid(bot),{side:'SELL',steps:[{qty:'0.005',quote:'305'}]});
  await db.query("UPDATE public.signals SET payload=(payload::jsonb||'{\"bridge\":{\"deployment_id\":\"dep-9\"}}'::jsonb)::text WHERE id=$1",[bridge.id]);   // labelled
  await db.query("UPDATE public.signals SET payload='not json' WHERE id=$1",[garbage.id]);                                                                    // labelled
  const result=await read(bot);
  const tags=Object.fromEntries(result.facts.attribution.by_fill.map(f=>[f.event_key,f.tag+(f.deployment_id?':'+f.deployment_id:'')]));
  assert.deepEqual(tags,{[worker.id+':0.01']:'WEBHOOK',[bridge.id+':0.01']:'BRIDGE:dep-9',[garbage.id+':0.005']:'ATTRIBUTION_UNKNOWN'});
  assert.deepEqual(result.facts.attribution.counts,{BRIDGE:1,WEBHOOK:1,ATTRIBUTION_UNKNOWN:1});
  const slip=Object.fromEntries(result.facts.slippage.by_fill.map(f=>[f.event_key,f.label]));
  assert.equal(slip[worker.id+':0.01'],'MODELED_SLIPPAGE_ALREADY_INCLUDED');
  assert.equal(slip[bridge.id+':0.01'],'SLIPPAGE_UNKNOWN');assert.equal(slip[garbage.id+':0.005'],'SLIPPAGE_UNKNOWN');
  assert.equal(result.facts.slippage.by_fill.find(f=>f.label==='SLIPPAGE_UNKNOWN').slippage_bps,null,'never zero');
  // Attribution changes no number: the same account, NAV = cash 10000 - 600 - 600 + 305 = 9105 plus 0.015 x 62000 = 930.
  assert.equal(result.performance.nav_to.nav,'10035');
});

test('T11 legacy account: legacy_float fills, a LEGACY_BASELINE row and a rewritten cost_basis give both seeds and the labels',async()=>{
  await bars('62000');
  const bot=await newBot(10000);
  const buy=await book(store,bot,'l1-'+uid(bot),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  const fill=(await db.query('SELECT received_at FROM public.fills WHERE signal_id=$1',[buy.id])).rows[0];
  // Labelled legacy rows: the fill is an M1 float fill without quote_amount, a baseline funding row (M2) sits before it, and cost_basis was rewritten.
  await db.query('UPDATE public.fills SET legacy_float=1,quote_amount=NULL WHERE signal_id=$1',[buy.id]);
  await db.query("INSERT INTO public.paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'LEGACY_BASELINE')",[bot.id,fill.received_at-1]);
  await db.query('UPDATE public.ledger_positions SET cost_basis=cost_basis+7 WHERE user_id=$1',[bot.id]);
  const result=await read(bot);
  assert.deepEqual([result.seeds.has_m1,result.seeds.has_m2,result.seeds.s_cash,result.seeds.s_cost,result.seeds.nav_from],[true,true,fill.received_at-1,null,fill.received_at]);
  assert.equal(result.gates.gates.R7.not_run,'S_COST_UNAVAILABLE');
  assert.ok(result.replay.findings.some(f=>f.code==='QUOTE_FROM_PRICE_LEGACY'));
  assert.equal(result.performance.nav_to.cost_reason,'COST_UNVERIFIED_LEGACY');assert.equal(result.performance.nav_to.realized,null);
  assert.deepEqual(result.performance.twr.reasons,['LEGACY_FUNDING_HISTORY_UNAVAILABLE']);
  assert.ok(result.status.overlays.includes('RECONCILIATION_UNAVAILABLE_LEGACY'));
  assert.equal(result.performance.nav_to.cash,'9400');
});
