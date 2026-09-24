import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSource,validateSelection,hash,canonical} from '../src/pine-bridge/source.js';
import {assemble,validateProposal} from '../src/pine-bridge/template.js';
import {levels,exitDecision,executionPrice,validateEvent} from '../src/pine-bridge/contract.js';
import {budgetFor,providerConfig} from '../src/pine-bridge/provider.js';

const source='//@version=6\r\nindicator("strategy() is text")\r\nfast = input.int(10, "Fast", minval=1, maxval=100)\r\nslow = input.int(30, "Slow", minval=1)\r\nshow = input.bool(true, "Show")\r\nbuy = ta.crossover(ta.ema(close, fast), ta.ema(close, slow))\r\nsell = ta.crossunder(close, ta.ema(close, fast))';
const analysis=inspectSource(source),signals={buy:'buy',exit:'sell',timing:'bar_close'};
const slot={slot:3,input_id:analysis.inputs[0].input_id,min:5,max:15,step:1};
const deployment={deployment_id:'12345678-1234-1234-1234-123456789abc',pine_import_id:'12345678-1234-1234-1234-123456789def',source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'};

test('indicator declaration check ignores strings/comments but rejects executable strategies',()=>{
  assert.equal(analysis.pine_version,6);
  assert.throws(()=>inspectSource(source.replace('indicator(', 'strategy(')),{code:'INDICATOR_REQUIRED'});
  assert.throws(()=>inspectSource(source+'\nstrategy.entry("X", strategy.long)'),{code:'INDICATOR_REQUIRED'});
  assert.doesNotThrow(()=>inspectSource(source+'\n// strategy.entry("X")'));
  assert.throws(()=>inspectSource(source.replace('version=6','version=4')),{code:'UNSUPPORTED_BRIDGE_SOURCE'});
  assert.throws(()=>inspectSource(source+'\nindicator("second")'),{code:'UNSUPPORTED_BRIDGE_SOURCE'});
  assert.throws(()=>inspectSource(source+' '.repeat(256*1024)),{code:'SOURCE_TOO_LARGE'});
  assert.throws(()=>inspectSource(source+'\n'.repeat(10000)),{code:'SOURCE_TOO_LARGE'});
});
test('numeric input identities are source-bound; no truncation to first eight',()=>{
  assert.equal(analysis.inputs.length,3);assert.equal(analysis.inputs[2].eligible,false);
  const changed=inspectSource(source+'\n');assert.notEqual(changed.inputs[0].input_id,analysis.inputs[0].input_id);
  const many=inspectSource(source+'\n'+Array.from({length:20},(_,i)=>`x${i}=input.float(2.0)`).join('\n'));
  assert.equal(many.inputs.filter(i=>i.eligible).length,22);
  assert.equal(inspectSource(source+'\nfast := 2').inputs[0].eligible,false);
});
test('bindings reject duplicates, coercion, non-numeric and invalid domains',()=>{
  assert.equal(validateSelection(analysis,signals,[slot]).bindings.length,1);
  assert.equal(validateSelection(analysis,signals,[]).bridge.rr,1.5);
  for(const value of [true,'5',Infinity,NaN])assert.throws(()=>validateSelection(analysis,signals,[{...slot,min:value}]));
  for(const override of [{min:11},{max:9},{step:0},{step:0.1},{min:0},{slot:2}])assert.throws(()=>validateSelection(analysis,signals,[{...slot,...override}]));
  assert.throws(()=>validateSelection(analysis,signals,[slot,{...slot,slot:4}]),{code:'DUPLICATE_BINDING'});
  assert.throws(()=>validateSelection(analysis,signals,[{...slot,input_id:analysis.inputs[2].input_id}]),{code:'INELIGIBLE_INPUT'});
  assert.throws(()=>validateSelection(analysis,{...signals,buy:'buy or true'},[]),{code:'UNRESOLVED_SIGNAL_MAPPING'});
  assert.throws(()=>validateSelection(analysis,signals,[],{atr_multiplier:0,rr:1.5}));
});
test('AI cannot inject code or choose a different confirmed signal',()=>{
  const selection=validateSelection(analysis,signals,[]);
  assert.throws(()=>validateProposal({buy:'buy',exit:'sell',bridge_block:'evil',diagnostics:[]},analysis,selection));
  assert.throws(()=>validateProposal({buy:'sell',exit:'sell',diagnostics:[]},analysis,selection),{code:'AI_MAPPING_MISMATCH'});
  assert.throws(()=>validateProposal({buy:'buy',exit:'sell',eligible_inputs:['foreign'],diagnostics:[]},analysis));
});
test('assembly preserves original CRLF bytes and binds existing inputs once',()=>{
  const result=assemble(source,validateSelection(analysis,signals,[slot]),deployment);
  assert.equal(result.integrated_pine.slice(0,source.length),source);
  assert.equal(result.source_hash,hash(source));assert.equal(result.source_diff.changed_original_bytes,0);
  assert.equal(result.bindings.length,3);assert.equal(result.fixed_inputs.length,2);
  assert.equal((result.integrated_pine.match(/fast = input.int/g)||[]).length,1);
  assert.equal(result.artifact_status,'DRAFT');assert.match(result.webhook_setup,/do not activate/);
  assert.match(result.integrated_pine,/alert.freq_all/);
});
test('MTF and pivot capabilities stay separate from Bridge draft',()=>{
  const result=inspectSource(source+'\nx = request.security(syminfo.tickerid, "D", close)\np = ta.pivothigh(2, 2)');
  assert.equal(result.bridge_capability.status,'DRAFT');assert.equal(result.quant_capability.status,'UNSUPPORTED');
  assert.ok(result.dependencies.includes('request.security'));assert.ok(result.dependencies.includes('ta.pivothigh'));
});
test('frozen levels round outwards; next bar exits choose SL then TP then native',()=>{
  assert.deepEqual(levels(100,3.333,2,1.5,0.01),{sl:'93.33',tp:'110'});
  assert.throws(()=>levels(10,20,2,1.5,0.01));
  const entry={time:100,entry_ref:'entry',sl:'90',tp:'115'};
  assert.equal(exitDecision(entry,{time:100,low:80,high:120},true),null);
  for(let i=0;i<10;i++) {
    assert.equal(exitDecision(entry,{time:101+i,low:89,high:114}).reason,'SL');
    assert.equal(exitDecision(entry,{time:101+i,low:91,high:116}).reason,'TP');
  }
  for(let i=0;i<5;i++)assert.deepEqual(exitDecision(entry,{time:101+i,low:89,high:116},true),{reason:'SL',suppressed:['TP','NATIVE'],entry_ref:'entry'});
  assert.equal(executionPrice(100,'BUY',10,.01),'100.1');assert.equal(executionPrice(100,'EXIT',10,.01),'99.9');
});
test('strict versioned transport rejects extra authority fields, foreign IDs and stale bars',()=>{
  const ref=deployment.deployment_id+':1000:0',event={schema_version:'bridge-exit-v1',...deployment,event_id:ref+':BUY',event_type:'BUY',entry_ref:ref,bar_time:1000,sequence:0,close:100,atr:5};
  assert.equal(validateEvent(event,deployment,1100),event);
  assert.throws(()=>validateEvent({...event,bot_id:'other'},deployment,1100),{code:'INVALID_FIELDS'});
  assert.throws(()=>validateEvent({...event,schema_version:'v2'},deployment,1100),{code:'UNSUPPORTED_SCHEMA_VERSION'});
  assert.throws(()=>validateEvent({...event,source_version:2},deployment,1100),{code:'DEPLOYMENT_MISMATCH'});
  assert.throws(()=>validateEvent({...event,entry_ref:'other:1000:0'},deployment,1100));
  assert.throws(()=>validateEvent(event,deployment,100000),{code:'STALE_EVENT'});
  assert.throws(()=>validateEvent({...event,close:'100'},deployment,1100));
});
test('token and cost bounds reject before provider dispatch; canonical hash is order independent',()=>{
  const request={operation:'analyze',analysis,provider:{inputRate:.4,outputRate:1.6,rateVersion:'test'}};
  assert.ok(budgetFor(request,source).total_reserved_tokens<=56000);
  assert.ok(budgetFor(request,'// x\n'.repeat(5000)).input_tokens<24000);
  assert.throws(()=>budgetFor(request,'x'.repeat(5000)),{code:'SOURCE_LINE_TOO_LONG'});
  assert.throws(()=>budgetFor(request,'x x x x x x x x x x\n'.repeat(3000)),{code:'SOURCE_TOKEN_BUDGET_EXCEEDED'});
  assert.ok(budgetFor(request,'// <|endoftext|>').input_tokens>1024);
  assert.throws(()=>budgetFor({...request,provider:{inputRate:1000,outputRate:1000}},source),{code:'JOB_COST_BUDGET_EXCEEDED'});
  assert.throws(()=>providerConfig({}),{code:'AI_PROVIDER_NOT_CONFIGURED'});
  assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));
});
