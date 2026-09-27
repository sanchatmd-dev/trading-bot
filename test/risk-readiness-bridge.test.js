import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {resolveBridgePreviewContext,previewBridgeCosts} from '../src/postgres/risk-readiness-bridge.js';

const now=1700000000000,ownerId='owner-fixture',botId='bot-fixture',deploymentId='deployment-fixture';
const request=(extra={})=>({deployment_id:deploymentId,bar_time:now,event_type:'BUY',...extra});

function fixture(){
  const policy={maxSignalAgeSeconds:60,maxRiskPercent:2};
  const capital=[{broker:'binance-global',configuredEquity:'1000',configuredBalance:'1000'}];
  const membership=[{pine_import_id:'pine-fixture',source_version:1,source_hash:'source-fixture',analysis:{}}];
  const snapshot={policy,policy_hash:hash(canonical(policy)),capital,membership,funding_cutoff:1,
    source_hash:'source-fixture',artifact_hash:'artifact-fixture',selection:{bridge:{atr_multiplier:2,rr:1.5}},
    market:{deployment_id:deploymentId,pine_import_id:'pine-fixture',source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'}};
  const deployment={deployment_id:deploymentId,owner_id:ownerId,bot_id:botId,pine_import_id:'pine-fixture',source_version:1,
    state:'READY',snapshot,snapshot_hash:hash(canonical(snapshot))};
  const evidence={snapshot_hash:deployment.snapshot_hash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,
    compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,
    identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,
    execution_model:{version:'paper-close-v1',price_tick:0.01,quantity_step:0.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},
    references:{tradingview:'fixture-reference',source_review:'fixture-reference',paper_fixture:'fixture-reference'}};
  const bar={time:now,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'5',price_tick:'0.01',quantity_step:'0.001'};
  const state={policy,capital,membership,deployment,evidence,bar,allowOwnership:true,ownerStatus:'ACTIVE',botStatus:'ACTIVE',
    session:{state:'SETUP',run_id:null,locked_policy:null},missingEvidence:false,missingBar:false,exitOnBar:false,open:[],
    allocation:{position_id:'allocation-fixture',remaining_quantity:'2',stop_loss:'90',take_profit:'115'}};
  const calls=[];
  const store={
    async ownsBot(owner,bot){assert.equal(owner,ownerId);assert.equal(bot,botId);return state.allowOwnership;},
    async userById(id){assert.ok([ownerId,botId].includes(id));return {id,status:id===ownerId?state.ownerStatus:state.botStatus};},
    async getBotSession(id){assert.equal(id,botId);return state.session;},
    async risk(id){assert.equal(id,botId);return state.policy;},
    async paperAccounts(id){assert.equal(id,botId);return state.capital;},
    db:{prepare(sql){
      assert.match(sql.trim(),/^SELECT\b/);assert.doesNotMatch(sql,/FOR UPDATE/i);
      calls.push(sql);
      const get=async(...args)=>{
        if(sql.includes('FROM pine_deployments')){
          assert.match(sql,/owner_id=\? AND bot_id=\?/);assert.deepEqual(args,[deploymentId,ownerId,botId]);return state.deployment;
        }
        if(sql.includes('FROM pine_bridge_evidence')){
          assert.deepEqual(args,[deploymentId]);return state.missingEvidence?undefined:{snapshot_hash:state.deployment.snapshot_hash,evidence:state.evidence,evidence_hash:hash(canonical(state.evidence))};
        }
        if(sql.includes('FROM paper_funding')){assert.deepEqual(args,[botId]);return {cutoff:1};}
        if(sql.includes('FROM pine_market_bars')){
          assert.deepEqual(args,['binance-global','BTCUSDT','1',now]);
          return state.missingBar?undefined:{bar:state.bar,content_hash:hash(canonical(state.bar)),provenance:{profile:'closed-ohlcv-atr14-v1'}};
        }
        if(sql.includes('FROM pine_bridge_events')){assert.deepEqual(args,[deploymentId,now]);return state.exitOnBar?{exists:1}:undefined;}
        if(sql.includes('FROM pine_bridge_entries')){
          assert.match(sql,/a.user_id=\? AND a.account_id=\? AND a.execution_mode='PAPER' AND a.symbol=\?/);
          assert.deepEqual(args,[deploymentId,deploymentId+':'+(now-60000)+':0',botId,'binance-global:primary','BTCUSDT']);
          return state.allocation;
        }
        throw new Error('Unexpected query: '+sql);
      };
      const all=async(...args)=>{
        if(sql.includes('FROM pine_memberships')){assert.deepEqual(args,[ownerId,botId]);return state.membership;}
        if(sql.includes('FROM pine_bridge_entries')){assert.deepEqual(args,[deploymentId]);return state.open;}
        throw new Error('Unexpected query: '+sql);
      };
      return {get,all,run(){throw new Error('Unexpected write');}};
    }}
  };
  return {state,store,calls};
}
const resolve=(f,input=request())=>resolveBridgePreviewContext({store:f.store,ownerId,botId,request:input,defaultRisk:{},now});
const exit=extra=>request({event_type:'EXIT',entry_ref:deploymentId+':'+(now-60000)+':0',reason:'NATIVE',...extra});

test('Bridge preview derives server model, verified market and protection without writes',async()=>{
  const f=fixture(),before=structuredClone(f.state),result=await resolve(f);
  assert.equal(result.signal.referencePrice,'100.01');assert.equal(result.signal.stopLoss,'90');assert.equal(result.signal.takeProfit,'115');
  assert.equal(result.signal.riskValue,'1');assert.equal(result.signal.newsRisk,undefined);
  assert.equal(result.policySource,'SAVED_POLICY');assert.deepEqual(result.policy,f.state.policy);
  assert.equal(result.deployment.evidenceHash,hash(canonical(f.state.evidence)));assert.equal(result.market.contentHash,hash(canonical(f.state.bar)));
  assert.ok(result.limitations.includes('VENUE_FILTERS_UNVERIFIED'));assert.ok(result.limitations.includes('HYPOTHETICAL_BRIDGE_INTENT'));
  assert.ok(result.limitations.includes('COST_INCLUSIVE_RISK_LIMIT_NOT_ENFORCED'));assert.deepEqual(f.state,before);
});

for(const [name,change,code]of [
  ['owner boundary',f=>{f.state.allowOwnership=false;},'BOT_ACCESS_DENIED'],
  ['owner suspended',f=>{f.state.ownerStatus='SUSPENDED';},'ACCOUNT_SUSPENDED'],
  ['draft deployment',f=>{f.state.deployment.state='DRAFT';},'BRIDGE_NOT_READY'],
  ['snapshot changed',f=>{f.state.deployment.snapshot.policy_hash='changed';},'STALE_DEPLOYMENT_SNAPSHOT'],
  ['missing evidence',f=>{f.state.missingEvidence=true;},'BRIDGE_EXECUTION_EVIDENCE_REQUIRED'],
  ['evidence artifact mismatch',f=>{f.state.evidence.artifact_hash='changed';},'STALE_EVIDENCE'],
  ['saved policy changed',f=>{f.state.policy={...f.state.policy,maxRiskPercent:3};},'STALE_POLICY'],
  ['membership changed',f=>{f.state.membership=[];},'STALE_MEMBERSHIP'],
  ['funding changed',f=>{f.state.capital=[{...f.state.capital[0],configuredBalance:'2000'}];},'STALE_CAPITAL'],
  ['missing verified bar',f=>{f.state.missingBar=true;},'VERIFIED_MARKET_DATA_REQUIRED'],
  ['tick mismatch',f=>{f.state.bar.price_tick='1';},'MARKET_METADATA_MISMATCH'],
  ['same-bar exit intent',f=>{f.state.exitOnBar=true;},'BUY_SUPPRESSED_EXIT_BAR'],
  ['protective exit suppresses buy',f=>{f.state.open=[{entry_ref:deploymentId+':'+(now-60000)+':0',stop_loss:'99',take_profit:'115'}];},'BUY_SUPPRESSED_EXIT_BAR']
])test('Bridge preview rejects '+name,async()=>{
  const f=fixture();change(f);await assert.rejects(resolve(f),error=>error.code===code);
});

for(const field of ['policy','capital','model','fee_bps','quantity','news_risk','evidence_hash'])test('Bridge rejects client '+field,async()=>{
  const f=fixture();await assert.rejects(resolve(f,request({[field]:1})),error=>error.code==='INVALID_FIELDS');assert.deepEqual(f.calls,[]);
});

test('Bridge rejects future and stale bar requests',async()=>{
  await assert.rejects(resolve(fixture(),request({bar_time:now+1})),error=>error.code==='INVALID_NUMERIC_VALUE');
  await assert.rejects(resolve(fixture(),request({bar_time:now-60001})),error=>error.code==='STALE_EVENT');
});

test('Bridge PAUSED uses locked policy and scoped EXIT_ONLY allocation without fresh membership',async()=>{
  const f=fixture();f.state.deployment.state='EXIT_ONLY';f.state.session={state:'PAUSED',run_id:'run-fixture',locked_policy:JSON.stringify(f.state.policy)};
  f.state.policy={maxSignalAgeSeconds:0};f.state.membership=[];const before=structuredClone(f.state);
  const result=await resolve(f,exit());assert.equal(result.policySource,'LOCKED_SESSION');assert.equal(result.policy.maxSignalAgeSeconds,60);
  assert.equal(result.signal.side,'SELL');assert.equal(result.signal.reduceOnly,true);assert.equal(result.signal.targetTradeId,'allocation-fixture');
  assert.equal(result.signal.referencePrice,'99.99');assert.equal(result.signal.bridge.reason,'NATIVE');
  assert.ok(!f.calls.some(sql=>sql.includes('FROM pine_memberships')));assert.deepEqual(f.state,before);
});

test('Bridge missing target never becomes symbol-wide exit',async()=>{
  const f=fixture();f.state.allocation=null;await assert.rejects(resolve(f,exit()),error=>error.code==='TARGET_NOT_OPEN');
});
test('Bridge exit target must belong to requested deployment and precede bar',async()=>{
  await assert.rejects(resolve(fixture(),exit({entry_ref:'other:'+String(now-60000)+':0'})),error=>error.code==='INVALID_ENTRY_REFERENCE');
  await assert.rejects(resolve(fixture(),exit({entry_ref:deploymentId+':'+now+':0'})),error=>error.code==='INVALID_ENTRY_REFERENCE');
});
test('Bridge both-touched bar prioritizes SL over TP and native',async()=>{
  const f=fixture();f.state.bar.high='120';f.state.bar.low='80';
  await assert.rejects(resolve(f,exit()),error=>error.code==='EXIT_PRIORITY_MISMATCH');
  await assert.rejects(resolve(f,exit({reason:'TP'})),error=>error.code==='EXIT_PRIORITY_MISMATCH');
  const result=await resolve(f,exit({reason:'SL'}));assert.deepEqual(result.signal.bridge.suppressed,['TP']);
});

test('conditional stop/target costs include adverse execution, fees and cash debit',()=>{
  const model={fee_bps:10,slippage_bps:100,price_tick:0.01};
  const order={side:'BUY',quantity:'2',price:'100',notional:'200',stopLoss:'90',takeProfit:'120'};
  const result=previewBridgeCosts(order,model,{cash:'1000'});
  assert.equal(result.entryFee,'0.2');assert.equal(result.cashDebit,'200.2');assert.equal(result.cashAfterOrder,'799.8');
  assert.equal(result.estimatedStopExitPrice,'89.1');assert.equal(result.estimatedStopExitFee,'0.1782');assert.equal(result.estimatedLossAtStop,'22.1782');
  assert.equal(result.estimatedTargetExitPrice,'118.8');assert.equal(result.estimatedProfitAtTarget,'37.1624');
  assert.equal(result.costToStopRatio,'0.10891');assert.equal(result.riskLimitIncludesCosts,false);assert.match(result.assumption,/Gaps/);
});
test('conditional EXIT costs report fee and cash credit without invented protection',()=>{
  const result=previewBridgeCosts({side:'SELL',quantity:'2',price:'100',notional:'200'},{fee_bps:10,slippage_bps:1,price_tick:0.01},{cash:'1000'});
  assert.equal(result.fee,'0.2');assert.equal(result.cashCredit,'199.8');assert.equal(result.cashAfterOrder,'1199.8');
  assert.equal(result.entryFee,null);assert.equal(result.estimatedLossAtStop,null);
});
