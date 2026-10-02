import test from 'node:test';
import assert from 'node:assert/strict';
import {D} from '../src/money.js';
import {canonical} from '../src/pine-bridge/source.js';
import {config} from '../src/config.js';
import {validateRisk} from '../src/postgres/risk-policy-validation.js';
import {reviewRiskPolicy} from '../src/postgres/risk-policy-review.js';
import {ALLOW_LIST,CAPITAL_FIELDS,DECLARED_KEYS,DEFAULT_CEILINGS,LOSS_GUARDS,NUMERIC_CEILINGS,PF4_CONFIRM,PF4_VERSION,
  assertMonotoneSafe,buildProposal,changedFields,normalizeDeclared,policyHash} from '../src/postgres/pf4-risk-proposals.js';

// PF-4 rules over plain objects: no database, no clock. Every rule, the owner's Q1 limits and the safety check.
const defaultRisk=config.defaultRisk;
const clone=value=>structuredClone(value);
const policy0=(overrides={})=>({...clone(defaultRisk),blockDuringNews:false,capPercentEquitySize:false,maxRiskPercent:5,maxOrderNotional:'2000',
  maxDailyNotional:'20000',equities:{'binance-global':'1000'},balances:{'binance-global':'800'},...overrides});
const EVIDENCE={job_id:'job-1',plan_hash:'a'.repeat(64),policy_current:true,capital_current:true,cappable_buy_rejections:4,
  reasons:[{code:'ORDER_NOTIONAL_LIMIT',count:3},{code:'CASH_LIMIT',count:1}]};
const BRIDGE={deployment_id:'dep-1',evidence_hash:'b'.repeat(64),risk_percent:1};
const build=(options={})=>buildProposal({botId:'bot-1',base:policy0(),defaultRisk,declared:{},...options});
const fields=result=>changedFields(result.proposal);
const change=(result,field)=>result.proposal.changes.find(item=>item.field===field);
const codes=result=>result.proposal.advisories.map(item=>item.code);
const refuses=(fn,code,field)=>assert.throws(fn,error=>error.code===code&&error.status===400&&(field===undefined||error.message.includes(field)),String(fn));

test('constants name the version, the confirmation, the declared keys and the allow-list',()=>{
  assert.equal(PF4_VERSION,'pf4-proposal-v1');assert.equal(PF4_CONFIRM,'SAVE_RISK_PROPOSAL');
  assert.deepEqual(DECLARED_KEYS,['loss_per_trade_percent','order_notional_ceiling','daily_notional_ceiling','allow_repeated_entries']);
  assert.deepEqual([...ALLOW_LIST].sort(),['capPercentEquitySize','defaults','maxDailyNotional','maxOrderNotional','maxRiskPercent','onePositionPerSymbol']);
  for(const guard of ['killSwitch','maxDailyLossR','pauseAfterLossStreak'])assert.ok(LOSS_GUARDS.includes(guard));
  assert.ok(!ALLOW_LIST.some(key=>LOSS_GUARDS.includes(key)||CAPITAL_FIELDS.includes(key)),'no guard or capital field is changeable');
});

test('declared limits: absent means none; unknown keys are INVALID_FIELDS; values are plain decimals inside their range, normalized',()=>{
  assert.deepEqual(normalizeDeclared(undefined),{});assert.deepEqual(normalizeDeclared(null),{});assert.deepEqual(normalizeDeclared({}),{});
  for(const bad of [[],'x',5,{extra:1},{loss_per_trade_percent:'1',extra:1},{policy:{}}])
    assert.throws(()=>normalizeDeclared(bad),error=>error.code==='INVALID_FIELDS'&&error.status===400);
  assert.deepEqual(normalizeDeclared({loss_per_trade_percent:'1.50',order_notional_ceiling:2500,daily_notional_ceiling:'+10000.0',allow_repeated_entries:false}),
    {loss_per_trade_percent:'1.5',order_notional_ceiling:'2500',daily_notional_ceiling:'10000',allow_repeated_entries:false});
  assert.deepEqual(normalizeDeclared({loss_per_trade_percent:'.5'}),{loss_per_trade_percent:'0.5'});
  assert.deepEqual(normalizeDeclared({loss_per_trade_percent:'0.0001e2'}),{loss_per_trade_percent:'0.01'},'an exponent form is a plain decimal too');
  // Boundaries are accepted exactly, one step beyond is refused.
  assert.equal(normalizeDeclared({loss_per_trade_percent:'0.01'}).loss_per_trade_percent,'0.01');
  assert.equal(normalizeDeclared({loss_per_trade_percent:'100'}).loss_per_trade_percent,'100');
  assert.equal(normalizeDeclared({order_notional_ceiling:'1000000000000'}).order_notional_ceiling,'1000000000000');
  assert.equal(normalizeDeclared({daily_notional_ceiling:'10000000000000'}).daily_notional_ceiling,'10000000000000');
  const cases=[['loss_per_trade_percent',['','abc','0','0.009','-1','100.01','0.12345',null,true,[],{},' 1','1 ',Number.NaN,Infinity]],
    ['order_notional_ceiling',['','0','0.001','1000000000001','-5','x1',null,false,'1'.repeat(70)]],
    ['daily_notional_ceiling',['','0','0.009','10000000000001',null,{},'1,5']],
    ['allow_repeated_entries',['true','false',0,1,null,'',[]]]];
  for(const [key,values] of cases)for(const value of values)refuses(()=>normalizeDeclared({[key]:value}),'PF4_DECLARED_INVALID',key);
});

test('same declared value in any accepted spelling gives one normal form',()=>{
  const spellings=[2,'2','2.0','2.00','+2','0.2e1'];
  assert.equal(new Set(spellings.map(value=>canonical(normalizeDeclared({loss_per_trade_percent:value})))).size,1);
});

test('LOSS_CEILING tightens the risk ceiling to the declared loss and lowers a default above it; the change is explained',()=>{
  const base=policy0({maxRiskPercent:100}),bridge={...BRIDGE,risk_percent:0.4};
  const result=build({base,declared:{loss_per_trade_percent:'0.5'},bridgeRisk:bridge});
  assert.deepEqual(fields(result),['maxRiskPercent','defaults.riskPercent']);
  const item=change(result,'maxRiskPercent');
  assert.deepEqual([item.before,item.after,item.rule,item.direction],['100','0.5','LOSS_CEILING','LOWER']);
  assert.deepEqual(result.proposal.policy_input,{maxRiskPercent:0.5,defaults:{riskPercent:0.5}},'a number for the percent, as the validator wants');
  assert.equal(item.explanation,'You declared 0.5% loss per trade. Max risk per trade falls from 100% to 0.5%. The active Bridge risk is 0.4%, so entries stay possible. Fees, slippage and gaps can exceed a nominal stop.');
  assert.deepEqual(item.provenance.map(entry=>entry.source),['SAVED_POLICY','OWNER_DECLARED','DEPLOYMENT_EVIDENCE']);
  assert.equal(item.provenance[0].hash,policyHash(base));
  assert.deepEqual(item.provenance[1],{source:'OWNER_DECLARED',field:'loss_per_trade_percent',value:'0.5'});
  assert.deepEqual(item.provenance[2],{source:'DEPLOYMENT_EVIDENCE',deployment_id:'dep-1',evidence_hash:'b'.repeat(64),risk_percent:0.4});
  const lowered=change(result,'defaults.riskPercent');
  assert.deepEqual([lowered.before,lowered.after,lowered.rule,lowered.direction],['1','0.5','DEFAULTS_WITHIN_CEILINGS','LOWER']);
  assert.equal(lowered.explanation,'Default riskPercent 1 exceeds the new ceiling 0.5; it is lowered to 0.5.');
  assert.deepEqual(lowered.provenance.map(entry=>entry.source),['SAVED_POLICY','OWNER_DECLARED'],'the default follows a ceiling the owner declared');
});

test('LOSS_CEILING raises the risk ceiling up to the declared loss and never above it (owner decision Q1)',()=>{
  const base=policy0({maxRiskPercent:1}),result=build({base,declared:{loss_per_trade_percent:'2'},bridgeRisk:BRIDGE});
  const item=change(result,'maxRiskPercent');
  assert.deepEqual([item.before,item.after,item.rule,item.direction],['1','2','LOSS_CEILING','RAISE']);
  assert.equal(result.proposal.policy_input.maxRiskPercent,2);assert.equal(result.after.maxRiskPercent,2);
  assert.match(item.explanation,/rises from 1% to 2%, the most you accept\./);
  assert.deepEqual(fields(result),['maxRiskPercent'],'a default below the new ceiling is left alone: defaults are never raised');
  assert.equal(result.after.defaults.riskPercent,defaultRisk.defaults.riskPercent);
  // The hard range holds: the highest accepted value is the validator maximum and nothing goes beyond it.
  assert.equal(build({base,declared:{loss_per_trade_percent:'100'}}).after.maxRiskPercent,100);
  refuses(()=>build({base,declared:{loss_per_trade_percent:'100.0001'}}),'PF4_DECLARED_INVALID','loss_per_trade_percent');
  // A raise the Bridge needs: the saved cap 0.3 rejects a 1% Bridge, the declared 2% fixes it.
  const low=policy0({maxRiskPercent:0.3,defaults:{...defaultRisk.defaults,riskPercent:0.3}});
  assert.equal(build({base:low,declared:{loss_per_trade_percent:'2'},bridgeRisk:BRIDGE}).after.maxRiskPercent,2);
});

test('LOSS_CEILING never saves a cap below the Bridge risk; an equal declared loss changes nothing',()=>{
  for(const [saved,declared] of [[5,'0.5'],[0.2,'0.5'],[1,'0.99']]){
    const result=build({base:policy0({maxRiskPercent:saved,defaults:{...defaultRisk.defaults,riskPercent:0.1}}),declared:{loss_per_trade_percent:declared},bridgeRisk:BRIDGE});
    assert.deepEqual(fields(result),[],'saved '+saved+' declared '+declared);assert.equal(result.after,null);assert.equal(result.proposal.after_policy_hash,null);
    assert.ok(codes(result).includes('DECLARED_LOSS_BELOW_BRIDGE_RISK'));
    assert.match(result.proposal.advisories.find(item=>item.code==='DECLARED_LOSS_BELOW_BRIDGE_RISK').explanation,
      /declared loss per trade \(0\.[0-9]+%\) is below the active Bridge risk \(1%\)/);
  }
  const equal=build({base:policy0({maxRiskPercent:2}),declared:{loss_per_trade_percent:'2.00'},bridgeRisk:BRIDGE});
  assert.deepEqual(fields(equal),[]);assert.ok(!codes(equal).includes('DECLARED_LOSS_BELOW_BRIDGE_RISK'));
  assert.equal(build({base:policy0({maxRiskPercent:5}),declared:{loss_per_trade_percent:'1'},bridgeRisk:BRIDGE}).after.maxRiskPercent,1,'exactly the Bridge risk is allowed');
  const unknown=build({base:policy0({maxRiskPercent:5}),declared:{loss_per_trade_percent:'0.5'}});
  assert.equal(unknown.after.maxRiskPercent,0.5);assert.ok(codes(unknown).includes('BRIDGE_RISK_PERCENT_UNKNOWN'));
  assert.ok(!codes(build({declared:{loss_per_trade_percent:'1'},bridgeRisk:BRIDGE})).includes('BRIDGE_RISK_PERCENT_UNKNOWN'));
});

test('ORDER_NOTIONAL and DAILY_NOTIONAL set the declared ceilings as exact decimal strings, down or up to the declared value',()=>{
  const base=policy0({maxOrderNotional:'2000',maxDailyNotional:'20000',capPercentEquitySize:true});
  const lower=build({base,declared:{order_notional_ceiling:'500.50',daily_notional_ceiling:'9000'}});
  assert.deepEqual(lower.proposal.policy_input,{maxOrderNotional:'500.5',maxDailyNotional:'9000',defaults:{orderNotional:'500.5'}});
  const order=change(lower,'maxOrderNotional'),daily=change(lower,'maxDailyNotional');
  assert.deepEqual([order.before,order.after,order.rule,order.direction],['2000','500.5','ORDER_NOTIONAL','LOWER']);
  assert.deepEqual([daily.before,daily.after,daily.rule,daily.direction],['20000','9000','DAILY_NOTIONAL','LOWER']);
  assert.equal(order.explanation,'You declared an order notional ceiling of 500.5. Max order notional falls from 2000 to 500.5.');
  assert.equal(lower.after.maxOrderNotional,'500.5');assert.equal(lower.after.defaults.orderNotional,'500.5');
  // Raising is allowed up to the declared ceiling and not one unit more.
  const raise=build({base,declared:{order_notional_ceiling:'5000',daily_notional_ceiling:'50000'}});
  assert.deepEqual(fields(raise),['maxOrderNotional','maxDailyNotional'],'defaults 1000 and 5000 stay inside the raised ceilings');
  assert.deepEqual([raise.after.maxOrderNotional,raise.after.maxDailyNotional],['5000','50000']);
  assert.deepEqual([change(raise,'maxOrderNotional').direction,change(raise,'maxDailyNotional').direction],['RAISE','RAISE']);
  assert.match(change(raise,'maxOrderNotional').explanation,/rises from 2000 to 5000, the most you accept\./);
  assert.equal(build({base,declared:{order_notional_ceiling:'1000000000000'}}).after.maxOrderNotional,'1000000000000');
  assert.equal(build({base,declared:{daily_notional_ceiling:'10000000000000'}}).after.maxDailyNotional,'10000000000000');
  // The same value changes nothing; a number saved as a number compares by value.
  assert.deepEqual(fields(build({base:policy0({maxOrderNotional:2000}),declared:{order_notional_ceiling:'2000.0'}})),[]);
  // Declaring only one leaves the other alone.
  assert.deepEqual(fields(build({base,declared:{daily_notional_ceiling:'1500'}})),['maxDailyNotional','defaults.dailyNotional']);
});

test('a daily ceiling below the order ceiling is a warning only when this proposal changed one of them',()=>{
  const base=policy0({maxOrderNotional:'2000',maxDailyNotional:'20000'});
  const below=build({base,declared:{daily_notional_ceiling:'1500'}});
  assert.match(below.proposal.advisories.find(item=>item.code==='DAILY_BELOW_ORDER_NOTIONAL').explanation,/daily notional ceiling \(1500\) is below the order notional ceiling \(2000\)/);
  assert.equal(below.proposal.advisories.find(item=>item.code==='DAILY_BELOW_ORDER_NOTIONAL').severity,'warn');
  assert.ok(codes(build({base,declared:{order_notional_ceiling:'30000'}})).includes('DAILY_BELOW_ORDER_NOTIONAL'),'a raised order ceiling above the saved daily ceiling');
  assert.ok(!codes(build({base,declared:{order_notional_ceiling:'1000',daily_notional_ceiling:'5000'}})).includes('DAILY_BELOW_ORDER_NOTIONAL'));
  assert.ok(!codes(build({base:policy0({maxOrderNotional:'9000',maxDailyNotional:'5000'}),declared:{loss_per_trade_percent:'1'}})).includes('DAILY_BELOW_ORDER_NOTIONAL'),'an old setting is not nagged about');
});

test('REPEATED_ENTRIES only ever blocks repeats: declared false turns the block on, declared true never turns it off',()=>{
  const off=policy0({onePositionPerSymbol:false}),on=policy0({onePositionPerSymbol:true});
  const turned=build({base:off,declared:{allow_repeated_entries:false}});
  assert.deepEqual(turned.proposal.policy_input,{onePositionPerSymbol:true});
  const item=change(turned,'onePositionPerSymbol');
  assert.deepEqual([item.before,item.after,item.rule,item.direction],[false,true,'REPEATED_ENTRIES','ENABLE']);
  assert.deepEqual(item.provenance.map(entry=>entry.source),['SAVED_POLICY','OWNER_DECLARED']);
  assert.equal(turned.after.onePositionPerSymbol,true);
  const stays=build({base:on,declared:{allow_repeated_entries:true}});
  assert.deepEqual(fields(stays),[]);assert.equal(stays.after,null);assert.ok(codes(stays).includes('REPEATED_ENTRIES_NOT_LOOSENED'));
  assert.deepEqual(fields(build({base:off,declared:{allow_repeated_entries:true}})),[]);
  assert.deepEqual(fields(build({base:on,declared:{allow_repeated_entries:false}})),[]);
  assert.ok(!codes(build({base:off,declared:{allow_repeated_entries:true}})).includes('REPEATED_ENTRIES_NOT_LOOSENED'));
});

test('CAP_SIZING turns capping on for current evidence of cappable rejections, or when a notional ceiling is lowered; never otherwise',()=>{
  const seen=build({evidence:EVIDENCE}),item=change(seen,'capPercentEquitySize');
  assert.deepEqual(fields(seen),['capPercentEquitySize']);assert.deepEqual([item.before,item.after,item.rule,item.direction],[false,true,'CAP_SIZING','ENABLE']);
  assert.deepEqual(item.provenance.map(entry=>entry.source),['SAVED_POLICY','PF2_EVIDENCE']);
  assert.deepEqual(item.provenance[1],{source:'PF2_EVIDENCE',job_id:'job-1',plan_hash:'a'.repeat(64),reasons:[{code:'CASH_LIMIT',count:1},{code:'ORDER_NOTIONAL_LIMIT',count:3}]});
  assert.match(item.explanation,/^4 historical BUY intents were rejected because the risk-sized order exceeded CASH_LIMIT 1, ORDER_NOTIONAL_LIMIT 3\. /);
  assert.match(item.explanation,/risk per trade can only fall and no cash is added\.$/);
  for(const stale of [{policy_current:false},{capital_current:false},{cappable_buy_rejections:0}])
    assert.deepEqual(fields(build({evidence:{...EVIDENCE,...stale}})),[],JSON.stringify(stale));
  assert.deepEqual(fields(build({evidence:null})),[]);
  assert.deepEqual(fields(build({base:policy0({capPercentEquitySize:true}),evidence:EVIDENCE})),[],'already on');
  const lowered=build({declared:{order_notional_ceiling:'500'}});
  assert.deepEqual(fields(lowered),['maxOrderNotional','capPercentEquitySize','defaults.orderNotional']);
  assert.match(change(lowered,'capPercentEquitySize').explanation,/^Lower notional ceilings with capping off would reject orders above them; capping keeps them inside the new ceilings\./);
  assert.deepEqual(change(lowered,'capPercentEquitySize').provenance.map(entry=>entry.source),['SAVED_POLICY','OWNER_DECLARED']);
  assert.deepEqual(fields(build({declared:{order_notional_ceiling:'9000',daily_notional_ceiling:'90000'}})),['maxOrderNotional','maxDailyNotional'],'raised ceilings need no capping');
  assert.deepEqual(fields(build({declared:{loss_per_trade_percent:'0.5'}})).includes('capPercentEquitySize'),false,'a lower risk percent alone needs no capping');
});

test('DEFAULTS_WITHIN_CEILINGS lowers only the defaults above a proposed ceiling and never raises one',()=>{
  const base=policy0({maxRiskPercent:5,maxOrderNotional:'2000',maxDailyNotional:'20000',
    defaults:{...defaultRisk.defaults,riskPercent:3,orderNotional:'1500',dailyNotional:'9000'}});
  const result=build({base,declared:{loss_per_trade_percent:'2',order_notional_ceiling:'1000',daily_notional_ceiling:'6000'}});
  assert.deepEqual(fields(result),['maxRiskPercent','maxOrderNotional','maxDailyNotional','capPercentEquitySize','defaults.riskPercent','defaults.orderNotional','defaults.dailyNotional']);
  assert.deepEqual(result.proposal.policy_input.defaults,{riskPercent:2,orderNotional:'1000',dailyNotional:'6000'});
  for(const [key,after] of [['riskPercent','2'],['orderNotional','1000'],['dailyNotional','6000']]){
    const item=change(result,'defaults.'+key);assert.deepEqual([item.after,item.rule,item.direction],[after,'DEFAULTS_WITHIN_CEILINGS','LOWER']);
  }
  // Defaults that fit stay as they are, even when a ceiling was raised far above them.
  const raised=build({base,declared:{loss_per_trade_percent:'50',order_notional_ceiling:'900000'}});
  assert.deepEqual(fields(raised),['maxRiskPercent','maxOrderNotional']);
  assert.deepEqual(raised.after.defaults,base.defaults);
  // The validator rejects a default above its ceiling, so a base with one is repaired by this rule alone.
  const broken=policy0({defaults:{...defaultRisk.defaults,tradesPerDay:50}});
  assert.equal(reviewRiskPolicy(broken).status,'CONFLICT');assert.throws(()=>validateRisk({},broken,defaultRisk));
  const repaired=build({base:broken});
  assert.deepEqual(fields(repaired),['defaults.tradesPerDay']);assert.equal(repaired.after.defaults.tradesPerDay,defaultRisk.maxTradesPerDay);
  assert.equal(repaired.proposal.refusal,null);assert.equal(reviewRiskPolicy(repaired.after).status,'CONSISTENT');
  assert.deepEqual(change(repaired,'defaults.tradesPerDay').provenance.map(entry=>entry.source),['SAVED_POLICY'],'a repair of the saved policy has no declared cause');
  // A default that is missing is filled by the validator exactly like PUT does; that is not a change of the proposal.
  const partial=policy0();delete partial.defaults.volatilityPercent;
  const filled=build({base:partial,declared:{loss_per_trade_percent:'4'}});
  assert.deepEqual(fields(filled),['maxRiskPercent']);assert.equal(filled.after.defaults.volatilityPercent,defaultRisk.defaults.volatilityPercent);
});

test('a conflict outside the defaults refuses the proposal: nothing changes and the owner is told to fix the Risk form',()=>{
  for(const overrides of [{maxTradesPerDay:0},{sideMode:'NONE'},{maxDailyLossR:'x'},{equities:{'binance-global':'100'},balances:{'binance-global':'200'}},{maxRiskPercent:101}]){
    const result=build({base:policy0(overrides),declared:{loss_per_trade_percent:'1',order_notional_ceiling:'100'}});
    assert.deepEqual(fields(result),[],JSON.stringify(overrides));assert.deepEqual(result.proposal.policy_input,{});assert.equal(result.after,null);
    assert.equal(result.proposal.refusal.code,'BASE_POLICY_CONFLICT');assert.ok(result.proposal.refusal.detail.length>0);
    assert.equal(result.proposal.advisories[0].code,'BASE_POLICY_CONFLICT');
  }
  assert.equal(build().proposal.refusal,null);
});

test('loss guards and capital are never part of a proposal: the saved values stay, whatever is declared',()=>{
  const guarded=policy0({killSwitch:true,maxDailyLossR:1.5,pauseAfterLossStreak:2,maxTradesPerDay:7,maxOpenPositions:2,maxSignalAgeSeconds:30,
    blockHighVolatility:false,blockDuringNews:true,maxVolatilityPercent:2,sideMode:'BUY_ONLY',allowedSymbols:['BTCUSDT'],
    equities:{'binance-global':'1000','binance-th':'5'},balances:{'binance-global':'800'}});
  const everything={loss_per_trade_percent:'1',order_notional_ceiling:'900',daily_notional_ceiling:'3000',allow_repeated_entries:false};
  const result=build({base:guarded,declared:everything,evidence:EVIDENCE,bridgeRisk:{...BRIDGE,risk_percent:0.5}});
  assert.ok(result.after&&result.proposal.changes.length>3);
  for(const key of Object.keys(guarded)){
    if(ALLOW_LIST.includes(key))continue;
    assert.equal(canonical(result.after[key]),canonical(guarded[key]),key+' is unchanged');
  }
  assert.ok(Object.keys(result.proposal.policy_input).every(key=>ALLOW_LIST.includes(key)));
  for(const key of [...LOSS_GUARDS,...CAPITAL_FIELDS,'blockDuringNews','sideMode','allowedSymbols'])assert.ok(!(key in result.proposal.policy_input),key);
  assert.deepEqual(result.after.equities,guarded.equities);assert.deepEqual(result.after.balances,guarded.balances);
  // The news block is never changed and never advised against: it only acts inside an active news window.
  assert.ok(!codes(result).includes('NEWS_BLOCK_WITHOUT_NEWS_DATA'),'no advice to turn the news block off');
  assert.ok(!result.proposal.advisories.some(item=>/news/i.test(item.explanation)),'no advisory mentions news');
  assert.equal(result.after.blockDuringNews,true);
  for(const change of result.proposal.changes)assert.ok(ALLOW_LIST.includes(change.field.split('.')[0]),change.field);
});

test('assertMonotoneSafe refuses every loosening, raise beyond the declared ceiling, capital change and guard change',()=>{
  const base=policy0({killSwitch:true,onePositionPerSymbol:true,capPercentEquitySize:true,blockDuringNews:true,allowedSymbols:['BTCUSDT']});
  const declared={loss_per_trade_percent:'8',order_notional_ceiling:'3000'};
  const ok=after=>assertMonotoneSafe(base,{...clone(base),...after},declared,defaultRisk);
  const bad=(after,label)=>assert.throws(()=>ok(after),error=>error.code==='PF4_PROPOSAL_UNSAFE'&&error.status===500&&error.violations.length>0,label);
  assert.equal(ok({}),true);
  assert.equal(ok({maxRiskPercent:8,maxOrderNotional:'3000'}),true,'a raise exactly to the declared ceiling');
  assert.equal(ok({maxRiskPercent:0.5,maxOrderNotional:'1',maxDailyNotional:'5',defaults:{...base.defaults,riskPercent:0.5,orderNotional:'1',dailyNotional:'5'}}),true,'tightening needs no declared ceiling');
  bad({maxRiskPercent:8.01},'risk above the declared loss');bad({maxOrderNotional:'3000.01'},'order notional above the declared ceiling');
  bad({maxDailyNotional:'20000.01'},'daily notional raised although no ceiling was declared');
  bad({maxRiskPercent:100.5},'above the hard range');bad({maxRiskPercent:0},'below the hard range');bad({maxDailyNotional:'20000000000000'},'above the daily hard range');
  bad({killSwitch:false},'kill switch switched off');bad({maxDailyLossR:base.maxDailyLossR+1},'daily loss limit raised');
  bad({maxDailyLossR:base.maxDailyLossR-1},'daily loss limit changed');bad({pauseAfterLossStreak:base.pauseAfterLossStreak+1},'loss streak pause raised');
  bad({maxTradesPerDay:base.maxTradesPerDay+1},'trades per day raised');bad({maxOpenPositions:base.maxOpenPositions+1},'open positions raised');
  bad({onePositionPerSymbol:false},'repeated entries allowed');bad({capPercentEquitySize:false},'capping switched off');
  bad({blockDuringNews:false},'news block switched off');bad({blockHighVolatility:false},'volatility block switched off');
  bad({sideMode:'SELL_ONLY'},'side mode changed');bad({allowedSymbols:[]},'symbols changed');bad({paperTrading:false},'paper off');
  bad({requireReduceOnlySell:false},'reduce-only off');bad({equities:{'binance-global':'1001'}},'equity added');
  bad({balances:{'binance-global':'801'}},'balance added');bad({equities:{...base.equities,'binance-th':'1'}},'equity key added');
  bad({defaults:{...base.defaults,riskPercent:base.defaults.riskPercent+1}},'default raised');
  bad({defaults:{...base.defaults,orderNotional:'1'},maxOrderNotional:'0.5'},'default above its ceiling');
  bad({unknownField:1},'a field outside the allow-list');
  const loose=clone(base);delete loose.defaults.riskPercent;assert.throws(()=>assertMonotoneSafe(base,loose,declared,defaultRisk),error=>error.code==='PF4_PROPOSAL_UNSAFE');
  // Capping and the repeated-entry block only go from false to true.
  const open=policy0({onePositionPerSymbol:false,capPercentEquitySize:false});
  assert.equal(assertMonotoneSafe(open,{...clone(open),onePositionPerSymbol:true,capPercentEquitySize:true},{},defaultRisk),true);
});

test('hash and proposal are deterministic, ignore key order and spelling, and react to every input that the save depends on',()=>{
  const inputs={declared:{loss_per_trade_percent:'1',order_notional_ceiling:'900',allow_repeated_entries:false},evidence:EVIDENCE,bridgeRisk:BRIDGE};
  const a=build(inputs),b=build(clone(inputs));
  assert.deepEqual(a.proposal,b.proposal);assert.equal(a.proposal.proposal_hash,b.proposal.proposal_hash);assert.match(a.proposal.proposal_hash,/^[a-f0-9]{64}$/);
  const shuffled=build({declared:{allow_repeated_entries:false,order_notional_ceiling:900,loss_per_trade_percent:1.0},evidence:{...EVIDENCE,reasons:[...EVIDENCE.reasons].reverse()},bridgeRisk:BRIDGE});
  assert.equal(shuffled.proposal.proposal_hash,a.proposal.proposal_hash);
  assert.equal(a.proposal.base_policy_hash,policyHash(policy0()));assert.equal(a.proposal.after_policy_hash,policyHash(a.after));
  // Context only decorates the advisories; it is not part of the hash.
  assert.equal(build({...inputs,context:{readyDeploymentId:'dep-1',currentLossStreakPause:true}}).proposal.proposal_hash,a.proposal.proposal_hash);
  const hash=options=>build({...inputs,...options}).proposal.proposal_hash,seen=new Set([a.proposal.proposal_hash]);
  const variants=[{declared:{...inputs.declared,loss_per_trade_percent:'0.9'}},{declared:{...inputs.declared,order_notional_ceiling:'901'}},
    {declared:{...inputs.declared,daily_notional_ceiling:'4000'}},{declared:{...inputs.declared,allow_repeated_entries:true}},
    {evidence:{...EVIDENCE,job_id:'job-2'}},{evidence:{...EVIDENCE,plan_hash:'c'.repeat(64)}},{evidence:{...EVIDENCE,policy_current:false}},
    {evidence:{...EVIDENCE,capital_current:false}},{evidence:{...EVIDENCE,cappable_buy_rejections:5}},{evidence:{...EVIDENCE,reasons:[{code:'CASH_LIMIT',count:4}]}},
    {evidence:null},{bridgeRisk:{...BRIDGE,risk_percent:0.9}},{bridgeRisk:{...BRIDGE,deployment_id:'dep-2'}},{bridgeRisk:{...BRIDGE,evidence_hash:'d'.repeat(64)}},{bridgeRisk:null},
    {base:policy0({maxRiskPercent:6})},{base:policy0({killSwitch:true})},{base:policy0({blockDuringNews:true})},{botId:'bot-2'}];
  for(const variant of variants){const value=hash(variant);assert.ok(!seen.has(value),'hash did not react to '+JSON.stringify(variant).slice(0,80));seen.add(value);}
  assert.equal(seen.size,variants.length+1);
});

test('the builder reads its inputs and never changes them; the policy is what the PUT validator makes of the input',()=>{
  const inputs={base:policy0({maxRiskPercent:100}),declared:{loss_per_trade_percent:'1',daily_notional_ceiling:'9000'},evidence:clone(EVIDENCE),bridgeRisk:clone(BRIDGE),context:{readyDeploymentId:'dep-1'}};
  const frozen=clone(inputs);
  const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};
  deepFreeze(inputs.base);deepFreeze(inputs.declared);deepFreeze(inputs.evidence);deepFreeze(inputs.bridgeRisk);deepFreeze(inputs.context);
  const result=build(inputs);
  assert.deepEqual(inputs,frozen);
  assert.deepEqual(result.after,validateRisk(result.proposal.policy_input,inputs.base,defaultRisk));
  result.proposal.changes[0].provenance[0].hash='x';result.proposal.policy_input.maxRiskPercent=99;assert.equal(inputs.base.maxRiskPercent,100);
  const empty=build({base:inputs.base});
  assert.deepEqual([empty.proposal.changes,empty.proposal.policy_input,empty.after,empty.proposal.after_policy_hash],[[],{},null,null]);
  assert.deepEqual(codes(empty).slice(-3),['LOSS_GUARDS_LOCKED','CAPITAL_NEVER_CHANGED','HISTORICAL_AFTER_NOT_SIMULATED']);
});

// Seeded property test: random saved policies, declared limits, evidence and Bridge risks. A fixed seed keeps it reproducible.
function generator(seed){
  return ()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
}
test('property: over 500 random cases a proposal changes only the allow-list, raises only up to a declared ceiling, never loosens a guard or touches capital',()=>{
  const random=generator(20261002),pick=list=>list[Math.floor(random()*list.length)],flag=()=>random()<0.5;
  const risks=[0.01,0.1,0.5,1,2,5,10,50,100],orders=['0.01','50','500','1000','2000','10000','1000000','1000000000000'],
    dailies=['0.01','100','5000','20000','100000','10000000000000'],percents=['0.01','0.05','0.5','1','1.25','3','10','99.9999','100'];
  let withChanges=0,raised=0,lowered=0,capped=0;
  for(let index=0;index<500;index++){
    const base=policy0({maxRiskPercent:pick(risks),maxOrderNotional:pick(orders),maxDailyNotional:pick(dailies),onePositionPerSymbol:flag(),
      capPercentEquitySize:flag(),killSwitch:flag(),blockDuringNews:flag(),maxDailyLossR:pick([0.5,1,3,10]),pauseAfterLossStreak:pick([1,3,9]),
      maxTradesPerDay:pick([1,10,500]),sideMode:pick(['BOTH','BUY_ONLY','SELL_ONLY']),
      equities:flag()?{'binance-global':pick(['0','500','1000'])}:{},balances:{}});
    if(random()<0.3)base.defaults.riskPercent=pick([0.01,1,5,100]);
    const declared={};
    if(flag())declared.loss_per_trade_percent=pick(percents);
    if(flag())declared.order_notional_ceiling=pick(orders);
    if(flag())declared.daily_notional_ceiling=pick(dailies);
    if(flag())declared.allow_repeated_entries=flag();
    const evidence=flag()?{...EVIDENCE,policy_current:flag(),capital_current:flag(),cappable_buy_rejections:pick([0,1,7])}:null;
    const bridgeRisk=flag()?{...BRIDGE,risk_percent:pick([0.05,0.5,1,5])}:null;
    const inputs={base,declared,evidence,bridgeRisk},frozen=clone(inputs);
    const result=build(inputs),again=build(clone(inputs)),label='case '+index+' '+JSON.stringify({declared,bridgeRisk});
    assert.deepEqual(inputs,frozen,label);assert.equal(result.proposal.proposal_hash,again.proposal.proposal_hash,label);
    assert.ok(Object.keys(result.proposal.policy_input).every(key=>ALLOW_LIST.includes(key)),label);
    if(reviewRiskPolicy({...base,defaults:{...defaultRisk.defaults,...base.defaults}}).issues.some(issue=>!issue.field.startsWith('defaults.'))){
      assert.equal(result.proposal.refusal.code,'BASE_POLICY_CONFLICT',label);assert.equal(result.after,null,label);continue;
    }
    assert.equal(result.proposal.refusal,null,label);
    if(result.after===null){assert.deepEqual(result.proposal.changes,[],label);continue;}
    withChanges++;
    const after=result.after;
    assert.equal(assertMonotoneSafe(base,after,result.proposal.declared,defaultRisk),true,label);
    assert.deepEqual(after,validateRisk(result.proposal.policy_input,base,defaultRisk),label);
    assert.equal(reviewRiskPolicy(after).status,'CONSISTENT',label);
    for(const [field,key] of Object.entries(NUMERIC_CEILINGS)){
      const before=D(base[field]),now=D(after[field]);
      if(now.gt(before)){raised++;assert.ok(result.proposal.declared[key]!==undefined&&now.lte(D(result.proposal.declared[key])),'raised past the declared ceiling '+label);}
      if(now.lt(before))lowered++;
    }
    for(const flagField of ['onePositionPerSymbol','capPercentEquitySize'])assert.ok(after[flagField]===base[flagField]||(base[flagField]===false&&after[flagField]===true),flagField+' '+label);
    if(after.capPercentEquitySize!==base.capPercentEquitySize)capped++;
    // S-4: the money value of the R-counted daily loss limit is named whenever the risk ceiling rises, and only then.
    assert.equal(result.proposal.advisories.some(item=>item.code==='DAILY_LOSS_VALUE_RISES'),D(after.maxRiskPercent).gt(D(base.maxRiskPercent)),label);
    for(const key of [...LOSS_GUARDS,'blockDuringNews','blockHighVolatility','sideMode','allowedSymbols','maxVolatilityPercent','maxOpenPositions','maxSignalAgeSeconds','paperTrading','requireReduceOnlySell'])
      assert.equal(canonical(after[key]),canonical(base[key]),key+' '+label);
    assert.equal(canonical(after.equities),canonical(base.equities),label);assert.equal(canonical(after.balances),canonical(base.balances),label);
    for(const [key,ceiling] of Object.entries(DEFAULT_CEILINGS)){
      assert.ok(D(after.defaults[key]).lte(D(after[ceiling])),'default '+key+' '+label);
      assert.ok(D(after.defaults[key]).lte(D({...defaultRisk.defaults,...base.defaults}[key])),'default raised '+key+' '+label);
    }
    for(const item of result.proposal.changes)assert.ok(item.explanation.length>10&&item.provenance.length>=1&&item.provenance[0].source==='SAVED_POLICY',label);
  }
  assert.ok(withChanges>150&&raised>40&&lowered>60&&capped>20,JSON.stringify({withChanges,raised,lowered,capped}));
});

test('S-4: the guard text says the daily loss limit is counted in R, and a raised risk ceiling names the money value of that limit',()=>{
  const base=policy0({maxRiskPercent:1,maxDailyLossR:3});
  const raised=build({base,declared:{loss_per_trade_percent:'1.5'}});
  const locked=raised.proposal.advisories.find(item=>item.code==='LOSS_GUARDS_LOCKED');
  assert.equal(locked.severity,'info');
  assert.match(locked.explanation,/A proposal never loosens a loss guard\. The daily loss limit is counted in R \(1R is the risk of one trade\), so a higher risk per trade raises its money value: for example 3R at 1\.5% allows up to 4\.5% of equity in one day\.$/);
  const note=raised.proposal.advisories.find(item=>item.code==='DAILY_LOSS_VALUE_RISES');
  assert.equal(note.severity,'warn');assert.deepEqual(note.values,{before:'1',after:'1.5',limit:'3',from:'3',to:'4.5'});
  assert.equal(note.explanation,'Max risk per trade rises from 1% to 1.5%. The daily loss limit of 3R is counted in R, so its money value rises from up to 3% to up to 4.5% of equity per day.');
  assert.equal(raised.after.maxDailyLossR,3,'the guard value itself is unchanged: only its money value moves');
  // The always-on text is there with every proposal, also an empty one; the money note only when the ceiling rises.
  for(const result of [build({base}),build({base,declared:{loss_per_trade_percent:'0.5'}}),build({base,declared:{loss_per_trade_percent:'1'}}),build({base,declared:{order_notional_ceiling:'900'}})]){
    assert.ok(codes(result).includes('LOSS_GUARDS_LOCKED'));assert.ok(!codes(result).includes('DAILY_LOSS_VALUE_RISES'),'no rise, no money note');
    assert.match(result.proposal.advisories.find(item=>item.code==='LOSS_GUARDS_LOCKED').explanation,/counted in R/);
  }
  // A declared loss that the Bridge guard refuses is no rise either.
  assert.ok(!codes(build({base,declared:{loss_per_trade_percent:'3'},bridgeRisk:{...BRIDGE,risk_percent:5}})).includes('DAILY_LOSS_VALUE_RISES'));
  // Fractions: 2.5R at 0.3% to 1.25% is 0.75% up to 3.125%; long products are rounded to four places.
  const fraction=build({base:policy0({maxRiskPercent:0.3,maxDailyLossR:2.5,defaults:{...defaultRisk.defaults,riskPercent:0.3}}),declared:{loss_per_trade_percent:'1.25'}});
  assert.deepEqual(fraction.proposal.advisories.find(item=>item.code==='DAILY_LOSS_VALUE_RISES').values,{before:'0.3',after:'1.25',limit:'2.5',from:'0.75',to:'3.125'});
  const rounded=build({base:policy0({maxRiskPercent:0.3,maxDailyLossR:0.123456,defaults:{...defaultRisk.defaults,riskPercent:0.3,dailyLossR:0.1}}),declared:{loss_per_trade_percent:'0.7777'}});
  assert.deepEqual(rounded.proposal.advisories.find(item=>item.code==='DAILY_LOSS_VALUE_RISES').values,{before:'0.3',after:'0.7777',limit:'0.123456',from:'0.037',to:'0.096'},'0.0370368 and 0.0960117312 round to four places');
  assert.equal(raised.proposal.proposal_hash,build({base,declared:{loss_per_trade_percent:'1.5'}}).proposal.proposal_hash,'advisory values are not hashed input and are deterministic');
});
