import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CATEGORY,REJECTION_TABLE,TARGET_NOT_OPEN,BELOW_QUANTITY_STEP,Pf3IntegrityError,attributeSides,classifyReason,
  classifyRejections,parseEntryRef,verifyTargets} from '../src/postgres/pf3-rejection-classes.js';

const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const PYTHON='quant_lab/src/robot_quant/risk_evaluator.py',JS='src/postgres/risk.js';
const DEPLOYMENT='deployment-fixture-0001',MINUTE=60000,S=10_000_000;
const ref=time=>DEPLOYMENT+':'+time+':0';
const counters=(buy,exits,fillBuy,fillExit)=>({intents:{buy,exit_sl:exits,exit_tp:0,exit_native:0},fills:{buy:fillBuy,exit:fillExit,exit_by_reason:{}}});
const classify=(byReason,shape,extra={})=>classifyRejections({byReason,...shape,samples:{fills:[],rejections:[]},window:{evaluation_start_time:S},deploymentId:DEPLOYMENT,...extra});
const only=(result,reason)=>result.items.filter(item=>item.reason===reason);

// Reasons the evaluators can produce: every literal of reject('...') in risk.js and reject("...") in risk_evaluator.py.
const PYTHON_RE=/reject\(\s*f?"([^"\n]*)"\s*\)/g,JS_RE=/reject\(\s*(['`])([^'`\n]*)\1\s*\)/g;
const TEMPLATE=/\$\{quoteCurrency\}|\{quote_currency\}/;
function evaluatorReasons(){
  const out=new Set();
  const expand=text=>{for(const value of TEMPLATE.test(text)?['USDT','THB']:[null])out.add(value===null?text:text.replace(TEMPLATE,value));};
  for(const match of read(PYTHON).matchAll(PYTHON_RE))expand(match[1]);
  for(const match of read(JS).matchAll(JS_RE))expand(match[2]);
  return out;
}

test('every evaluator rejection string, in both implementations, has a class (drift guard)',()=>{
  const reasons=evaluatorReasons();
  assert.ok(reasons.size>=35,'literal extraction found the evaluator strings: '+reasons.size);
  for(const reason of reasons)assert.ok(classifyReason(reason),'unclassified evaluator reason: '+reason);
  // The two evaluators stay in step: a string of one that the other lacks would be an unreviewed difference.
  const python=new Set([...read(PYTHON).matchAll(PYTHON_RE)].map(match=>match[1].replace('{quote_currency}','${quoteCurrency}')));
  const js=new Set([...read(JS).matchAll(JS_RE)].map(match=>match[2]));
  for(const reason of js)assert.ok(python.has(reason),'only in risk.js: '+reason);
  for(const reason of python)assert.ok(js.has(reason),'only in risk_evaluator.py: '+reason);
  // Reverse guard: a table key that no evaluator source can produce is a typo or a stale entry.
  const sources=read(PYTHON)+read(JS)+read('quant_lab/src/robot_quant/paper_state.py')+read('quant_lab/src/robot_quant/bridge_replay.py');
  for(const reason of REJECTION_TABLE.keys())
    assert.ok(reasons.has(reason)||sources.includes(reason),'table entry without a source: '+reason);
  assert.ok(read('quant_lab/src/robot_quant/paper_state.py').includes('"TARGET_NOT_OPEN"'));
  assert.ok(read('quant_lab/src/robot_quant/bridge_replay.py').includes('"BELOW_QUANTITY_STEP"'));
});

test('table entries carry a known category, a stable code, a side and the cappable flag only on BUY sizing limits',()=>{
  const categories=new Set(Object.values(CATEGORY)),cappable=[];
  for(const [reason,entry] of REJECTION_TABLE){
    assert.ok(categories.has(entry.category),reason);
    assert.match(entry.code,/^[A-Z][A-Z0-9_]+$/,reason);
    assert.ok(['BUY','EXIT','BOTH'].includes(entry.side),reason);
    if(entry.cappable){cappable.push(reason);assert.equal(entry.side,'BUY');assert.equal(entry.category,CATEGORY.POLICY_SKIP);}
  }
  assert.deepEqual(cappable.sort(),['Maximum daily notional exceeded','Maximum order notional exceeded',
    'Order exceeds available configured Spot balance','Order exceeds available configured Spot equity']);
  const category=reason=>classifyReason(reason).category;
  assert.equal(category('Kill switch is active: entries paused'),CATEGORY.CONFIGURATION);
  assert.equal(category('License is inactive or expired'),CATEGORY.CONFIGURATION);
  assert.equal(category('Missing news risk data'),CATEGORY.CONFIGURATION);
  assert.equal(category('Maximum trades per day reached'),CATEGORY.POLICY_SKIP);
  assert.equal(category('High volatility block is active'),CATEGORY.POLICY_SKIP);
  assert.equal(category('Maximum daily loss reached'),CATEGORY.LOSS_PAUSE);
  assert.equal(category('Trading paused after loss streak'),CATEGORY.LOSS_PAUSE);
  assert.equal(category('Signal is stale'),CATEGORY.FAULT);
  assert.equal(category('Missing volatility data'),CATEGORY.FAULT);
  assert.equal(category('No Spot position available to sell'),CATEGORY.FAULT);
  assert.equal(classifyReason('Something the evaluator never says'),null);
  assert.equal(classifyReason(undefined),null);assert.equal(classifyReason({}),null);
});

test('side attribution: a BOTH key is BUY or EXIT only when the counters leave no other possibility',()=>{
  assert.deepEqual(attributeSides({...counters(5,2,3,2),byReason:{'Signal is stale':2}}),
    {buy_rejected:2,exit_rejected:0,dual_buy:2,dual_exit:0,dual:'BUY'});
  assert.deepEqual(attributeSides({...counters(3,3,3,1),byReason:{'Signal is stale':2}}),
    {buy_rejected:0,exit_rejected:2,dual_buy:0,dual_exit:2,dual:'EXIT'});
  assert.deepEqual(attributeSides({...counters(4,2,3,1),byReason:{'Signal is stale':2}}),
    {buy_rejected:1,exit_rejected:1,dual_buy:1,dual_exit:1,dual:'MIXED'});
  // Single-side keys are subtracted first.
  assert.deepEqual(attributeSides({...counters(4,3,2,1),byReason:{'Kill switch is active: entries paused':2,[TARGET_NOT_OPEN]:1,OTHER:1}}),
    {buy_rejected:2,exit_rejected:2,dual_buy:0,dual_exit:1,dual:'EXIT'});
  assert.deepEqual(attributeSides({...counters(1,0,1,0),byReason:{}}),{buy_rejected:0,exit_rejected:0,dual_buy:0,dual_exit:0,dual:'BUY'});
});

test('inconsistent counters are an integrity failure, never a silent number',()=>{
  const fails=(shape,byReason,detail)=>assert.throws(()=>attributeSides({...shape,byReason}),error=>{
    assert.ok(error instanceof Pf3IntegrityError);assert.equal(error.code,'EVIDENCE_INTEGRITY_FAILED');assert.equal(error.detail,detail);return true;});
  fails(counters(2,0,2,0),{'Signal is stale':1},'REJECTED_SUM');
  fails(counters(1,2,0,0),{'Kill switch is active: entries paused':2,'Signal is stale':1},'SIDE_ONLY_EXCEEDS_SIDE');
  fails(counters(1,1,2,0),{},'FILLS_EXCEED_INTENTS');
  fails(counters(1,1,1,2),{},'FILLS_EXCEED_INTENTS');
  fails(counters(1,0,0,0),{'Signal is stale':0},'REASON_COUNT');
  fails(counters(1,0,0,0),{'Signal is stale':1.5},'REASON_COUNT');
  assert.throws(()=>attributeSides({intents:null,fills:{},byReason:{}}),Pf3IntegrityError);
  assert.throws(()=>attributeSides({intents:{buy:-1,exit_sl:0,exit_tp:0,exit_native:0},fills:{buy:0,exit:0},byReason:{}}),Pf3IntegrityError);
});

test('entry_ref parsing accepts only <deployment>:<time>:0 of the evidence deployment',()=>{
  assert.deepEqual(parseEntryRef(ref(123),DEPLOYMENT),{deployment_id:DEPLOYMENT,time:123});
  assert.deepEqual(parseEntryRef(ref(123)),{deployment_id:DEPLOYMENT,time:123});
  for(const bad of [DEPLOYMENT+':123',DEPLOYMENT+':abc:0',DEPLOYMENT+':123:1','x:123:0',DEPLOYMENT+':'+'9'.repeat(17)+':0','',null,7,'a'.repeat(300)])
    assert.equal(parseEntryRef(bad,DEPLOYMENT),null,String(bad).slice(0,30));
  assert.equal(parseEntryRef('other-deployment-9:5:0',DEPLOYMENT),null);
});

test('TARGET_NOT_OPEN is verified from warm-up entries, rejected BUYs and earlier exits; the rest stays unverified',()=>{
  const reject=(time,type,entry,reason=TARGET_NOT_OPEN)=>({time,event_type:type,entry_ref:entry,reason});
  const window={evaluation_start_time:S};
  const warm=verifyTargets({total:1,window,deploymentId:DEPLOYMENT,samples:{fills:[],rejections:[reject(S+MINUTE,'EXIT',ref(S-5*MINUTE))]}});
  assert.deepEqual(warm,{total:1,verified:1,unverified:0,basis:{WARMUP_ENTRY:1,REJECTED_BUY:0,CLOSED_EARLIER:0}});
  const buyThenExit=verifyTargets({total:1,window,deploymentId:DEPLOYMENT,samples:{fills:[],rejections:[
    reject(S+MINUTE,'BUY',ref(S+MINUTE),'Maximum trades per day reached'),reject(S+9*MINUTE,'EXIT',ref(S+MINUTE))]}});
  assert.equal(buyThenExit.basis.REJECTED_BUY,1);assert.equal(buyThenExit.unverified,0);
  const closed=verifyTargets({total:1,window,deploymentId:DEPLOYMENT,samples:{
    fills:[{time:S+2*MINUTE,event_type:'EXIT',entry_ref:ref(S+MINUTE),reason:'SL'}],
    rejections:[reject(S+9*MINUTE,'EXIT',ref(S+MINUTE))]}});
  assert.equal(closed.basis.CLOSED_EARLIER,1);assert.equal(closed.verified,1);
  // Not explained: the BUY rejection came later, the fill came later, another deployment, malformed ref.
  const later=verifyTargets({total:4,window,deploymentId:DEPLOYMENT,samples:{
    fills:[{time:S+30*MINUTE,event_type:'EXIT',entry_ref:ref(S+2*MINUTE),reason:'SL'}],
    rejections:[reject(S+5*MINUTE,'EXIT',ref(S+MINUTE)),reject(S+6*MINUTE,'EXIT',ref(S+2*MINUTE)),
      reject(S+9*MINUTE,'BUY',ref(S+MINUTE),'Signal is stale'),reject(S+10*MINUTE,'EXIT','other-deployment-9:5:0')]}});
  assert.deepEqual(later,{total:4,verified:0,unverified:4,basis:{WARMUP_ENTRY:0,REJECTED_BUY:0,CLOSED_EARLIER:0}});
  // The samples keep only the first rejections: a total beyond the sampled rows is never verified.
  const truncated=verifyTargets({total:5,window,deploymentId:DEPLOYMENT,samples:{fills:[],rejections:[
    reject(S+MINUTE,'EXIT',ref(S-MINUTE)),reject(S+2*MINUTE,'EXIT',ref(S-2*MINUTE))]}});
  assert.equal(truncated.verified,2);assert.equal(truncated.unverified,3);
  assert.equal(verifyTargets({total:0,window,samples:{fills:[],rejections:[]}}).unverified,0);
  assert.equal(verifyTargets({total:2,window,samples:null}).unverified,2);
  assert.throws(()=>verifyTargets({total:-1,window,samples:{}}),Pf3IntegrityError);
});

test('classification keeps every key: items add up to the rejected total, TARGET_NOT_OPEN splits, unknown stays unknown',()=>{
  const byReason={'Maximum trades per day reached':2,'Order exceeds available configured Spot balance':1,'Signal is stale':1,
    'Kill switch is active: entries paused':1,[TARGET_NOT_OPEN]:2,'Somebody changed the evaluator':1,OTHER:2};
  const rejected=Object.values(byReason).reduce((sum,value)=>sum+value,0);
  // 6 BUY and 4 EXIT intents are rejected: B+X must equal the rejected total.
  assert.equal(rejected,10);
  const result=classify(byReason,counters(9,5,3,1),{samples:{fills:[],rejections:[
    {time:S+MINUTE,event_type:'EXIT',entry_ref:ref(S-MINUTE),reason:TARGET_NOT_OPEN}]}});
  assert.equal(result.items.reduce((sum,item)=>sum+item.count,0),rejected);
  const target=only(result,TARGET_NOT_OPEN);
  assert.deepEqual(target.map(item=>[item.category,item.code,item.count]),
    [[CATEGORY.POLICY_SKIP,'TARGET_OF_UNFILLED_ENTRY',1],[CATEGORY.UNKNOWN,'TARGET_RELATIONSHIP_UNVERIFIED',1]]);
  assert.equal(only(result,'OTHER')[0].code,'OTHER_REASON_OVERFLOW');
  assert.equal(only(result,'Somebody changed the evaluator')[0].code,'UNLISTED_REASON');
  assert.equal(only(result,'Order exceeds available configured Spot balance')[0].code,'CASH_LIMIT');
  assert.equal(result.cappable_buy_rejections,1);
  assert.deepEqual(result.by_category,{[CATEGORY.CONFIGURATION]:1,[CATEGORY.FAULT]:1,[CATEGORY.UNKNOWN]:1+1+2,
    [CATEGORY.LOSS_PAUSE]:0,[CATEGORY.POLICY_SKIP]:2+1+1});
  assert.deepEqual(result.target_not_open,{total:2,verified:1,unverified:1,basis:{WARMUP_ENTRY:1,REJECTED_BUY:0,CLOSED_EARLIER:0}});
  // Sorted by count, then reason: deterministic output.
  const counts=result.items.map(item=>item.count);
  assert.deepEqual(counts,[...counts].sort((a,b)=>b-a));
  assert.deepEqual(classify(byReason,counters(9,5,3,1)).items.map(item=>item.code),
    classify(Object.fromEntries(Object.entries(byReason).reverse()),counters(9,5,3,1)).items.map(item=>item.code));
});

test('BELOW_QUANTITY_STEP is an expected skip only when it is attributed to BUY',()=>{
  const buy=classify({[BELOW_QUANTITY_STEP]:2},counters(2,0,0,0));
  assert.deepEqual(only(buy,BELOW_QUANTITY_STEP).map(item=>[item.category,item.code,item.attribution]),[[CATEGORY.POLICY_SKIP,'ORDER_BELOW_QUANTITY_STEP','BUY']]);
  const exit=classify({[BELOW_QUANTITY_STEP]:1},counters(1,1,1,0));
  assert.deepEqual(only(exit,BELOW_QUANTITY_STEP).map(item=>[item.category,item.code,item.attribution]),[[CATEGORY.UNKNOWN,'BELOW_STEP_SIDE_UNVERIFIED','EXIT']]);
  const mixed=classify({[BELOW_QUANTITY_STEP]:2},counters(2,1,1,0));
  assert.equal(only(mixed,BELOW_QUANTITY_STEP)[0].attribution,'MIXED');
  assert.equal(only(mixed,BELOW_QUANTITY_STEP)[0].category,CATEGORY.UNKNOWN);
});

test('classification never mutates its input and a counter mismatch throws before any class is returned',()=>{
  const byReason={'Signal is stale':1},shape=counters(1,0,0,0),samples={fills:[],rejections:[]};
  const before=structuredClone({byReason,shape,samples});
  classifyRejections({byReason,...shape,samples,window:{evaluation_start_time:S}});
  assert.deepEqual({byReason,shape,samples},before);
  assert.throws(()=>classify({'Signal is stale':3},counters(1,0,0,0)),Pf3IntegrityError);
  assert.throws(()=>classify({[TARGET_NOT_OPEN]:1},counters(2,0,2,0)),Pf3IntegrityError,'an EXIT-only key with no rejected EXIT');
});
