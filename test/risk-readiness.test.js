import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {normalizeSignal} from '../src/postgres/domain.js';
import {evaluateRisk} from '../src/postgres/risk.js';
import {buildRiskReadiness} from '../src/postgres/risk-readiness.js';
import {D,amount} from '../src/money.js';

// Deliberately isolated: this tests service semantics, not PostgreSQL auth/locking.
const now=1800000000000,botId='fixture-bot',ownerId='fixture-owner';
const raw=(overrides={})=>({trade_id:'preview-entry',broker:'binance-global',symbol:'BINANCE:BTCUSDT',event:'BUY',timestamp:now,
  reference_price:100,stop_loss:90,risk_mode:'QUANTITY',quantity:1,volatility_percent:1,news_risk:false,...overrides});

function fixture(overrides={}){
  const state={policy:structuredClone(config.defaultRisk),session:{state:'SETUP',run_id:null,locked_policy:null},
    account:{userId:botId,broker:'binance-global',currency:'USDT',cash:'600',bookEquity:'1000',positionCost:'400',configuredEquity:'1000',configuredBalance:'1000',valuation:'COST_BASIS_NOT_MARK_TO_MARKET'},
    daily:{trades:0,notional:'0',realized_r:'0',loss_streak:0},position:{quantity:'0'},
    exposure:{committedNotional:'400',reservedNotional:'0',reservedTrades:0,openPositions:1,hasPendingOrder:false,uncertain:false},
    botStatus:'ACTIVE',ownerStatus:'ACTIVE',licensed:true,globalKill:false,target:null,...overrides};
  const calls=[],writes=[];
  const scope=row=>{
    assert.equal(row.user_id,botId);assert.equal(row.account_id,'binance-global:primary');
    assert.equal(row.execution_mode,'PAPER');assert.equal(row.symbol,'BTCUSDT');
  };
  const forbidden=name=>(...args)=>{writes.push([name,args]);throw new Error('Readiness attempted write: '+name);};
  const db={isTransaction:false,
    async transaction(fn,options){calls.push(['transaction',options]);const nested=this.isTransaction;this.isTransaction=true;try{return await fn();}finally{this.isTransaction=nested;}},
    prepare(sql){assert.match(sql.trim(),/^SELECT\b/i);calls.push(['sql',sql]);return {
      async get(id){return {id};},async all(){return [];},run:forbidden('sql.run')};},
    async query(sql){assert.match(sql.trim(),/^SELECT\b/i);calls.push(['query',sql]);return {rows:[]};},exec:forbidden('exec')};
  const store={db,
    async ownsBot(owner,bot){calls.push(['ownsBot',owner,bot]);return owner===ownerId&&bot===botId;},
    async userById(id){assert.ok([botId,ownerId].includes(id));return id===botId?{id,parent_user_id:ownerId,role:'BOT',status:state.botStatus}:{id,parent_user_id:null,role:'USER',status:state.ownerStatus};},
    async botOwner(id){assert.equal(id,botId);return this.userById(ownerId);},
    async getBotSession(id){assert.equal(id,botId);return state.session;},
    async risk(id,defaults){assert.equal(id,botId);assert.deepEqual(defaults,config.defaultRisk);calls.push(['risk']);return state.policy;},
    async paperAccount(...args){assert.deepEqual(args,[botId,'binance-global']);calls.push(['paperAccount',...args]);return state.account;},
    async exposure(row){scope(row);return state.exposure;},async ledgerDaily(row){scope(row);return state.daily;},
    async ledgerPosition(row){scope(row);return state.position;},async ledgerTargetAllocation(row,target){scope(row);assert.equal(target,'entry-target');return state.target;},
    async hasActiveLicense(id){assert.equal(id,ownerId);return state.licensed;},
    async getSetting(key,fallback){assert.equal(key,'globalKill');assert.equal(fallback,false);return state.globalKill;},
    enqueue:forbidden('enqueue'),setRisk:forbidden('setRisk'),audit:forbidden('audit'),setSetting:forbidden('setSetting'),
    persistIntent:forbidden('persistIntent'),recordExecution:forbidden('recordExecution'),transitionBotState:forbidden('transitionBotState')};
  return {state,store,calls,writes};
}
async function preview(f,signal=raw(),body={signal}){
  const result=await buildRiskReadiness({store:f.store,botId,ownerId,defaultRisk:config.defaultRisk,body,now});
  assert.deepEqual(f.writes,[]);assert.equal(result.version,'pf1-readiness-v1');assert.equal(result.asOf,new Date(now).toISOString());
  assert.equal(result.botId,botId);assert.equal(result.scope,'POINT_IN_TIME_PAPER_RISK');
  assert.ok(Array.isArray(result.limitations));assert.ok(result.limitations.length>0);
  assert.ok(Array.isArray(result.readiness.reasons));assert.notEqual(result.readiness.status,'READY');
  assert.ok(f.calls.some(c=>c[0]==='transaction'&&c[1]?.isolation==='REPEATABLE READ'));
  return result;
}
async function matchesRisk(f,signal=raw(),policy=f.state.policy){
  const expected=evaluateRisk(normalizeSignal(signal,now),{policy,daily:f.state.daily,position:f.state.position,targetAllocation:f.state.target,
    equity:f.state.account.bookEquity,balance:f.state.account.cash,cashAvailable:amount(D(f.state.account.cash).minus(f.state.exposure.reservedNotional)),
    licensed:f.state.licensed,globalKill:f.state.globalKill,...f.state.exposure,now});
  const result=await preview(f,signal);
  assert.equal(result.calculation.status,expected.ok?(expected.order.sizingAdjustment?'CAPPED':'ACCEPTED'):'REJECTED');
  assert.equal(result.readiness.status,expected.ok?'UNKNOWN':'BLOCKED');
  if(expected.ok)assert.deepEqual(result.calculation.order,expected.order);else assert.equal(result.calculation.reason,expected.reason);
  return result;
}

for(const [name,signal] of [
  ['quantity',raw()],['fixed notional',raw({quantity:undefined,risk_mode:'FIXED_NOTIONAL',risk_value:200})],
  ['percent equity',raw({quantity:undefined,risk_mode:'PERCENT_EQUITY',risk_value:1})],
  ['capped percent equity',raw({quantity:undefined,risk_mode:'PERCENT_EQUITY',risk_value:100})],
  ['cash rejection',raw({quantity:7})],['missing volatility',raw({volatility_percent:undefined})],
  ['missing news',raw({news_risk:undefined})],['stale',raw({timestamp:now-61000})]
])test('readiness agrees with worker risk: '+name,async()=>{await matchesRisk(fixture(),signal);});

for(const [name,overrides] of [
  ['reserved cash',{exposure:{committedNotional:'950',reservedNotional:'550',reservedTrades:1,openPositions:2,hasPendingOrder:false,uncertain:false}}],
  ['daily trades',{daily:{trades:10,notional:'0',realized_r:'0',loss_streak:0}}],
  ['daily loss',{daily:{trades:0,notional:'0',realized_r:'-3',loss_streak:0}}],
  ['persistent loss streak',{daily:{trades:0,notional:'0',realized_r:'0',loss_streak:3}}],
  ['global kill',{globalKill:true}],['inactive license',{licensed:false}]
])test('readiness respects '+name,async()=>{await matchesRisk(fixture(overrides));});

test('actual ledger account and reservations determine capital without proposed policy',async()=>{
  const f=fixture({exposure:{committedNotional:'600',reservedNotional:'200',reservedTrades:1,openPositions:2,hasPendingOrder:false,uncertain:false}});
  f.state.policy.equities={'binance-global':999999};f.state.policy.balances={'binance-global':999999};
  const result=await matchesRisk(f,raw({quantity:undefined,risk_mode:'PERCENT_EQUITY',risk_value:100}));
  assert.equal(result.calculation.order.notional,'400');assert.equal(result.account.cashAvailable,'400');
  assert.deepEqual(result.account,{...f.state.account,cashAvailable:'400'});
});

test('RUNNING uses locked session policy',async()=>{
  const f=fixture();const locked={...f.state.policy,maxOrderNotional:50};
  f.state.session={state:'RUNNING',run_id:'run-fixture',locked_policy:JSON.stringify(locked)};
  const result=await matchesRisk(f,raw(),locked);assert.equal(result.policySource,'LOCKED_SESSION');
  assert.deepEqual(result.session,{state:'RUNNING',runId:'run-fixture'});assert.equal(f.calls.some(c=>c[0]==='risk'),false);
});
test('RUNNING missing lock explicitly falls back to saved policy',async()=>{
  const f=fixture({session:{state:'RUNNING',run_id:'run-fixture',locked_policy:null}});
  const result=await matchesRisk(f);assert.equal(result.policySource,'SAVED_POLICY_FALLBACK');assert.ok(result.limitations.includes('RUNNING_LOCKED_POLICY_MISSING'));
});
test('SETUP uses saved policy',async()=>{assert.equal((await matchesRisk(fixture())).policySource,'SAVED_POLICY');});
test('saved policy kill switch rejects',async()=>{const f=fixture();f.state.policy.killSwitch=true;await matchesRisk(f);});
test('unresolved pending order outcome blocks',async()=>{
  const f=fixture();f.state.exposure.uncertain=true;const result=await preview(f);
  assert.equal(result.calculation.status,'REJECTED');assert.deepEqual(result.readiness,{status:'BLOCKED',reasons:['ORDER_OUTCOME_UNCERTAIN']});
});
test('unsupported lifecycle state blocks',async()=>{
  const result=await preview(fixture({session:{state:'INVALID',run_id:null,locked_policy:null}}));
  assert.equal(result.calculation.status,'REJECTED');assert.deepEqual(result.readiness,{status:'BLOCKED',reasons:['SESSION_STATE_UNSUPPORTED']});
});

for(const state of ['PAUSED','STOPPED'])test(state+' blocks entry',async()=>{
  const result=await preview(fixture({session:{state,run_id:null,locked_policy:null}}));
  assert.equal(result.calculation.status,'REJECTED');assert.equal(result.readiness.status,'BLOCKED');
  assert.match(result.calculation.reason,new RegExp(state==='PAUSED'?'paused':'stopped','i'));
});
test('PAUSED permits reduce-only targeted exit and caps allocation',async()=>{
  const f=fixture({session:{state:'PAUSED',run_id:null,locked_policy:null},position:{quantity:'5'},target:{remaining_quantity:'2'},licensed:false,globalKill:true});
  const result=await matchesRisk(f,raw({event:'SELL',reduce_only:true,quantity:10,target_trade_id:'entry-target'}));
  assert.equal(result.calculation.order.quantity,'2');
});
test('missing target allocation rejects exit',async()=>{await matchesRisk(fixture({position:{quantity:'5'}}),raw({event:'SELL',reduce_only:true,target_trade_id:'entry-target'}));});
for(const field of ['botStatus','ownerStatus'])test('suspended '+field+' blocks',async()=>{
  const result=await preview(fixture({[field]:'SUSPENDED'}));assert.equal(result.calculation.status,'REJECTED');assert.equal(result.readiness.status,'BLOCKED');assert.match(result.calculation.reason,/suspended/i);
});
test('cross-owner access is denied before ledger reads',async()=>{
  const f=fixture();await assert.rejects(buildRiskReadiness({store:f.store,botId,ownerId:'other-owner',defaultRisk:config.defaultRisk,body:{signal:raw()},now}),/access denied|forbidden/i);
  assert.equal(f.calls.some(c=>c[0]==='paperAccount'),false);assert.deepEqual(f.writes,[]);
});
for(const body of [{signal:raw(),equity:999999},{signal:raw(),policy:{}},{signal:raw(),botId:'other-bot'},{signal:raw(),licensed:true}])
  test('strict request rejects trusted overrides: '+Object.keys(body)[1],async()=>{
    await assert.rejects(buildRiskReadiness({store:fixture().store,botId,ownerId,defaultRisk:config.defaultRisk,body,now}));
  });
test('Bridge payload is explicitly unsupported',async()=>{
  await assert.rejects(buildRiskReadiness({store:fixture().store,botId,ownerId,defaultRisk:config.defaultRisk,body:{signal:raw({bridge:{deploymentId:'fixture-deployment'}})},now}),
    error=>error.status===400&&/bridge.*unsupported|unsupported.*bridge/i.test(error.message));
});
test('future timestamp is rejected during normalization',async()=>{
  await assert.rejects(buildRiskReadiness({store:fixture().store,botId,ownerId,defaultRisk:config.defaultRisk,body:{signal:raw({timestamp:now+30001})},now}),
    error=>error.status===400&&/future/i.test(error.message));
});
test('existing transaction supports a readiness read without mutations',async()=>{
  const f=fixture();await f.store.db.transaction(async()=>{await matchesRisk(f);assert.equal(f.store.db.isTransaction,true);});
  assert.equal(f.store.db.isTransaction,false);assert.deepEqual(f.writes,[]);
});

test('accepted, capped and rejected calculations are distinct without claiming READY',async()=>{
  assert.equal((await preview(fixture())).calculation.status,'ACCEPTED');
  assert.equal((await preview(fixture(),raw({quantity:undefined,risk_mode:'PERCENT_EQUITY',risk_value:100}))).calculation.status,'CAPPED');
  assert.equal((await preview(fixture(),raw({quantity:undefined,risk_mode:'FIXED_NOTIONAL',risk_value:10000}))).calculation.status,'REJECTED');
});

test('cash reservations preserve 18-decimal precision',async()=>{
  const f=fixture();f.state.account.cash='600.000000000000000001';
  f.state.exposure.reservedNotional='0.000000000000000002';
  assert.equal((await matchesRisk(f)).account.cashAvailable,'599.999999999999999999');
});

test('STOPPED also blocks a reduce-only exit',async()=>{
  const f=fixture({session:{state:'STOPPED',run_id:null,locked_policy:null},position:{quantity:'5'}});
  assert.deepEqual((await preview(f,raw({event:'SELL',reduce_only:true}))).readiness,{status:'BLOCKED',reasons:['BOT_STOPPED']});
});

test('SELL cannot open a short and a pending symbol order prevents exit',async()=>{
  const f=fixture({position:{quantity:'5'}});
  assert.match((await matchesRisk(f,raw({event:'SELL',reduce_only:false}))).calculation.reason,/reduce_only/);
  f.state.exposure.hasPendingOrder=true;
  assert.match((await matchesRisk(f,raw({event:'SELL',reduce_only:true}))).calculation.reason,/Pending order/);
});

test('signal-level trusted fields and deployment references cannot bypass strict shape',async()=>{
  for(const field of ['equity','licensed','policy','deployment_id']){
    await assert.rejects(buildRiskReadiness({store:fixture().store,botId,ownerId,defaultRisk:config.defaultRisk,body:{signal:raw({[field]:'untrusted'})},now}),error=>error.status===400);
  }
});

test('policy provenance and capacity reflect server state and preserve exact snapshot hash',async()=>{
  const f=fixture(),first=await preview(f);
  assert.match(first.policy.hash,/^[a-f0-9]{64}$/);assert.equal(first.policy.hypothetical,false);
  assert.deepEqual(first.policy.effective,f.state.policy);
  assert.equal(first.consistency.status,'CONSISTENT');assert.equal(first.capacity.remainingDailyExecutions,10);
  f.state.policy.killSwitch=true;
  assert.notEqual((await preview(f)).policy.hash,first.policy.hash);
});

test('policy conflict blocks readiness without rewriting actual worker calculation',async()=>{
  const f=fixture();f.state.policy.defaults.riskPercent=101;
  const result=await preview(f);
  assert.equal(result.calculation.status,'ACCEPTED');assert.equal(result.readiness.status,'BLOCKED');
  assert.equal(result.consistency.status,'CONFLICT');assert.ok(result.readiness.reasons.includes('DEFAULT_OUTSIDE_POLICY'));
  assert.equal(f.state.policy.defaults.riskPercent,101);
});

test('malformed persisted policies return a configuration diagnostic without a server error',async()=>{
  for(const update of [{maxDailyLossR:'bad'},{allowedSymbols:{length:1}},{allowedSymbols:[null]}]){
    const f=fixture();Object.assign(f.state.policy,update);
    const result=await preview(f);
    assert.equal(result.consistency.status,'CONFLICT');assert.equal(result.readiness.status,'BLOCKED');
    assert.equal(result.calculation.status,'REJECTED');
  }
});


test('draft scenario is hypothetical, retains guards and never saves funding or policy',async()=>{
  const f=fixture(),before=structuredClone(f.state);
  const result=await preview(f,raw(),{signal:raw(),scenario:{policy:{maxOrderNotional:'50',defaults:{orderNotional:'50'}},capital:{cash:'600',bookEquity:'1000'}}});
  assert.equal(result.policySource,'HYPOTHETICAL_DRAFT');assert.equal(result.policy.hypothetical,true);
  assert.equal(result.scenario.hypothetical,true);assert.equal(result.calculation.status,'REJECTED');
  assert.deepEqual(f.state,before);assert.deepEqual(f.writes,[]);
});
test('draft cannot fabricate daily history or remove actual position commitments',async()=>{
  const f=fixture();
  for(const scenario of [
    {policy:{daily:{trades:0}},capital:{cash:'600',bookEquity:'1000'}},
    {policy:{},capital:{cash:'10',bookEquity:'20'}},
    {policy:{requireReduceOnlySell:false},capital:{cash:'600',bookEquity:'1000'}},
    {policy:{},capital:{cash:'600',bookEquity:'1000'},daily:{trades:0}}
  ])await assert.rejects(preview(f,raw(),{signal:raw(),scenario}));
  f.state.session.state='STOPPED';
  const result=await preview(f,raw(),{signal:raw(),scenario:{policy:{},capital:{cash:'600',bookEquity:'1000'}}});
  assert.equal(result.calculation.status,'REJECTED');assert.equal(result.readiness.reasons[0],'BOT_STOPPED');
});

test('hypothetical raised loss guard still exposes actual saved-policy pause',async()=>{
 const f=fixture();f.state.daily.loss_streak=3;
 const result=await preview(f,raw(),{signal:raw(),scenario:{policy:{pauseAfterLossStreak:5},capital:{cash:'600',bookEquity:'1000'}}});
 assert.equal(result.calculation.status,'ACCEPTED');assert.equal(result.actual.readiness.status,'BLOCKED');
 assert.equal(result.actual.calculation.reason,'Trading paused after loss streak');
 assert.notEqual(result.actual.policyHash,result.policy.hash);
});
