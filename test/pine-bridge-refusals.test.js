import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {inspectSource,validateSelection} from '../src/pine-bridge/source.js';
import {assemble} from '../src/pine-bridge/template.js';
import {providerConfig,budgetFor,OpenAIProvider} from '../src/pine-bridge/provider.js';
import {GeminiProvider,DirectProvider} from '../src/pine-bridge/gemini.js';
import {DEPLOYMENT,bridgePrefix,sha256Hex,fakeHttpsRequest,chatBody} from './helpers/pine-bridge-generation-gaps-fixture.mjs';

/**
 * PM-1 F02-01 gap tests (docs/PINE_BRIDGE_ADAPTER_API.md, "Durable AI jobs and bounded cost" and the integration guide):
 *   C5  assembly refusals IDENTIFIER_COLLISION, INVALID_DEPLOYMENT_ID and INVALID_MARKET;
 *   C6  the guide text (webhook_setup) the template produces;
 *   C8  provider refusal codes and the HTTP mapping of both adapters through fake transports. No network and no real key:
 *       OpenAIProvider runs against a fake node:https request function, GeminiProvider against a fake fetcher.
 * Expected codes, statuses and phrases are written as literals so a changed constant or sentence fails here and does not follow silently.
 */
const source='//@version=6\nindicator("Refusal fixture")\nlength = input.int(10, "Length", minval=1, maxval=100)\nbuy = ta.crossover(close, ta.ema(close, length))\nsell = ta.crossunder(close, ta.ema(close, length))\n';
const analysis=inspectSource(source);
const signals={buy:'buy',exit:'sell',timing:'bar_close'};
const selection=validateSelection(analysis,signals,[]);
const deployment=DEPLOYMENT;

// ---- C5: assembly refusals ---------------------------------------------------------------------------------------------------
test('assembly refuses an identifier that uses the deployment namespace, but not text, other namespaces or look-alikes',()=>{
  const prefix=bridgePrefix(deployment.deployment_id);
  assert.match(prefix,/^rt_[a-f0-9]{12}_$/);
  assert.throws(()=>assemble(source+prefix+'atr = 1\n',selection,deployment),{code:'IDENTIFIER_COLLISION',status:400});
  assert.throws(()=>assemble(source+'plot('+prefix+'x)\n',selection,deployment),{code:'IDENTIFIER_COLLISION'});
  // Comments and string literals are masked, so reserved text there is not an identifier.
  assert.doesNotThrow(()=>assemble(source+'// '+prefix+'atr\n',selection,deployment));
  assert.doesNotThrow(()=>assemble(source+'label = "'+prefix+'atr"\n',selection,deployment));
  // Another deployment owns another namespace; an identifier that merely contains the prefix after a word character is a different name.
  const other=bridgePrefix('12345678-1234-1234-1234-123456789abd');
  assert.notEqual(other,prefix);
  assert.doesNotThrow(()=>assemble(source+other+'atr = 1\n',selection,deployment));
  assert.doesNotThrow(()=>assemble(source+'x'+prefix+'atr = 1\n',selection,deployment));
});
test('assembly refuses malformed deployment ids before any block is built',()=>{
  for(const bad of [{deployment_id:'12345678-1234-1234-1234-123456789ABC'},{deployment_id:'12345678-1234-1234-1234-123456789ab'},{deployment_id:'not-a-uuid'},{deployment_id:undefined},{deployment_id:123},
    {pine_import_id:'12345678-1234-1234-1234-123456789DEF'},{pine_import_id:'short'},{pine_import_id:undefined}])
    assert.throws(()=>assemble(source,selection,{...deployment,...bad}),{code:'INVALID_DEPLOYMENT_ID',status:400},JSON.stringify(bad));
  // The id check comes before the market check.
  assert.throws(()=>assemble(source,selection,{...deployment,deployment_id:'bad',symbol:'btc'}),{code:'INVALID_DEPLOYMENT_ID'});
});
test('assembly refuses symbols, timeframes and brokers outside the reviewed market allowlist',()=>{
  for(const bad of [{symbol:'btcusdt'},{symbol:'BT'},{symbol:'B'.repeat(31)},{symbol:'BTC-USDT'},{symbol:'BTC"USDT'},{symbol:'BTCUSDT\n'},{symbol:undefined},
    {timeframe:'1H'},{timeframe:'12345'},{timeframe:'D'},{timeframe:''},{timeframe:'1D;'},{timeframe:undefined},
    {broker:'binance-futures'},{broker:'bybit'},{broker:''},{broker:undefined}])
    assert.throws(()=>assemble(source,selection,{...deployment,...bad}),{code:'INVALID_MARKET',status:400},JSON.stringify(bad));
  for(const good of [{timeframe:'1'},{timeframe:'240'},{timeframe:'1D'},{timeframe:'4W'},{timeframe:'1M'},{symbol:'ABC'},{symbol:'B'.repeat(30)},{broker:'binance-th'},{broker:'innovestx'},{broker:'settrade'}])
    assert.doesNotThrow(()=>assemble(source,selection,{...deployment,...good}),JSON.stringify(good));
});

// ---- C6: guide content --------------------------------------------------------------------------------------------------------
test('webhook_setup guide states every reviewed instruction the owner must follow',()=>{
  const result=assemble(source,selection,deployment),guide=result.webhook_setup;
  assert.equal(result.artifact_status,'DRAFT');
  for(const phrase of [
    'DRAFT — do not activate an alert yet.',
    'Compile this complete indicator in TradingView and review every warning.',
    'Use standard BINANCE:BTCUSDT Spot candles at chart timeframe 1D.',
    'Verify source BUY/exit mappings and disable native alert() calls through existing inputs; if impossible, execution remains blocked.',
    'create an alert using Any alert() function call',
    'enter the private /webhooks/pine-bridge/v2/ URL in TradingView only.',
    'Missing verified bars wait up to five seconds without creating a Paper order; timeout rejects the intent.',
    'Match every input to this snapshot.',
    'Protection is observed at bar close, starting the next bar; SL wins over TP and native exits.',
    'Pine intents do not confirm inventory: Paper worker controls accepted/capped/rejected fills and targeted exits.',
    'Replacing alerts requires a new deployment and preserved old exits.',
    'No Quant support is implied.'
  ])assert.ok(guide.includes(phrase),'guide lacks: '+phrase);
  // The guide never carries a secret, a full webhook URL or a readiness claim.
  assert.doesNotMatch(guide,/https?:\/\/|secret|execution-ready|Webhook ready/i);
});
test('guide names the registered chart per venue and the Bridge block enforces the same chart',()=>{
  const global=assemble(source,selection,deployment);
  assert.ok(global.webhook_setup.includes('Use standard BINANCE:BTCUSDT Spot candles at chart timeframe 1D.'));
  assert.ok(global.integrated_pine.includes('syminfo.tickerid != "BINANCE:BTCUSDT"'));
  const thai=assemble(source,selection,{...deployment,broker:'settrade',symbol:'PTT',timeframe:'60'});
  assert.ok(thai.webhook_setup.includes('Use standard PTT Spot candles at chart timeframe 60.'));
  assert.equal(thai.webhook_setup.includes('BINANCE:'),false);
  assert.ok(thai.integrated_pine.includes('syminfo.ticker != "PTT"'));
  assert.ok(thai.integrated_pine.includes('timeframe.in_seconds("60")'));
  assert.ok(thai.integrated_pine.includes('runtime.error("Bridge requires the registered standard chart, symbol and timeframe")'));
});
test('assembly keeps the original bytes and states the DRAFT label inside the appended block',()=>{
  const result=assemble(source,selection,deployment);
  assert.ok(result.integrated_pine.startsWith(source));
  assert.equal(result.source_hash,sha256Hex(source));
  assert.deepEqual(result.source_diff,{changed_original_bytes:0,appended_bytes:Buffer.byteLength(result.integrated_pine.slice(source.length))});
  assert.ok(result.integrated_pine.slice(source.length).includes('// Robot Trade bridge-exit-v2. DRAFT: compilation and Paper evidence required.'));
  assert.deepEqual(result.instruction_versions,{prompt:'bridge-prompt-v3',guide:'bridge-guide-v4',template:'bridge-exit-v3',parser:'pine-static-v1',bridge:'indicator-bridge-v2',quant:'quant-evaluator-v1'});
});

// ---- C8: provider configuration ---------------------------------------------------------------------------------------------
const openaiEnv={PINE_AI_PROVIDER:'openai-chat',PINE_AI_MODEL:'gpt-4.1-mini',PINE_AI_API_KEY:'fixture-not-real',PINE_AI_INPUT_USD_PER_MILLION:'.75',PINE_AI_OUTPUT_USD_PER_MILLION:'3.75',PINE_AI_RATE_VERSION:'fixture'};
const geminiEnv={...openaiEnv,PINE_AI_PROVIDER:'gemini',PINE_AI_MODEL:'gemini-3.8-flash'};
const stubRequest=env=>{
  const request={operation:'analyze',provider:providerConfig(env),analysis:{inputs:[],dependencies:[]}};
  request.budget=budgetFor(request,'//@version=6');
  return request;
};
async function withEnv(vars,callback){
  const saved={};
  for(const key of Object.keys(vars)){saved[key]=process.env[key];if(vars[key]===undefined)delete process.env[key];else process.env[key]=vars[key];}
  try{return await callback();}
  finally{for(const key of Object.keys(saved)){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
}
test('providerConfig refuses unconfigured providers, models, keys and rates before any dispatch',()=>{
  const config=providerConfig(openaiEnv);
  assert.equal(config.provider,'openai-chat');assert.equal(config.model,'gpt-4.1-mini');assert.equal(config.inputRate,.75);assert.equal(config.outputRate,3.75);
  assert.equal(config.rateVersion,'fixture');assert.equal(config.guide,'bridge-guide-v4');assert.equal(config.template,'bridge-exit-v3');
  for(const bad of [{PINE_AI_API_KEY:undefined},{PINE_AI_PROVIDER:'anthropic'},{PINE_AI_MODEL:'gpt-5'},{PINE_AI_MODEL:'gemini-3.8-flash'},{PINE_AI_MODEL:undefined}])
    assert.throws(()=>providerConfig({...openaiEnv,...bad}),{code:'AI_PROVIDER_NOT_CONFIGURED',status:503},JSON.stringify(bad));
  assert.throws(()=>providerConfig({...geminiEnv,PINE_AI_MODEL:'gpt-4.1-mini'}),{code:'AI_PROVIDER_NOT_CONFIGURED',status:503});
  assert.throws(()=>providerConfig({...openaiEnv,PINE_AI_RATE_VERSION:undefined}),{code:'AI_RATE_VERSION_REQUIRED',status:503});
  for(const rate of ['0','-1','abc','1001',undefined])assert.throws(()=>providerConfig({...openaiEnv,PINE_AI_INPUT_USD_PER_MILLION:rate}),{code:'INVALID_NUMERIC_VALUE'},String(rate));
});

// ---- C8: OpenAI-compatible adapter through a fake node:https request -----------------------------------------------------------------
async function runOpenAI(plan,{env=openaiEnv,request=stubRequest(openaiEnv)}={}){
  const fake=fakeHttpsRequest(plan);
  const spy=mock.method(https,'request',fake.impl);
  try{return {fake,outcome:await withEnv(env,()=>new OpenAIProvider().run(request,'//@version=6',{signal:undefined}).then(value=>({value}),error=>({error})))};}
  finally{spy.mock.restore();}
}
test('OpenAI adapter sends one bounded, store-less request with the key only in the authorization header',async()=>{
  const {fake,outcome}=await runOpenAI([{status:200,headers:{'x-request-id':'req-1'},body:chatBody({content:{buy:'buy',exit:'sell',diagnostics:[]}})}]);
  assert.equal(outcome.error,undefined);
  assert.equal(fake.calls.length,1);
  const [call]=fake.calls,payload=JSON.parse(call.payload);
  assert.equal(call.url,'https://api.openai.com/v1/chat/completions');
  assert.equal(call.options.method,'POST');
  assert.equal(call.options.headers.authorization,'Bearer fixture-not-real');
  assert.equal(call.url.includes('fixture-not-real'),false);assert.equal(call.payload.includes('fixture-not-real'),false);
  assert.equal(payload.model,'gpt-4.1-mini');assert.equal(payload.max_completion_tokens,4000);assert.equal(payload.store,false);
  assert.deepEqual(payload.response_format,{type:'json_object'});
  assert.deepEqual(payload.messages.map(m=>m.role),['system','user']);
  assert.deepEqual(outcome.value.value,{buy:'buy',exit:'sell',diagnostics:[]});
  assert.deepEqual(outcome.value.usage,{input_tokens:100,output_tokens:50,cost_usd:.0002625,rate_version:'fixture'});
  assert.equal(outcome.value.request_id,'req-1');
});
test('OpenAI adapter reports no request id when the provider sends none',async()=>{
  const {outcome}=await runOpenAI([{status:200,body:chatBody()}]);
  assert.equal(outcome.value.request_id,null);
});
test('OpenAI adapter maps 429 to a retryable refusal and keeps the provider delay',async()=>{
  for(const [headers,expected] of [[{'retry-after':'7'},7],[{'retry-after':'0'},0],[{'retry-after':'120'},120],[{},2]]) {
    const {fake,outcome}=await runOpenAI([{status:429,headers,body:''}]);
    assert.equal(outcome.error.code,'PROVIDER_RATE_LIMIT');assert.equal(outcome.error.retryAfter,expected);
    assert.equal(fake.calls.length,1,'the adapter never resends by itself');
  }
  const {outcome}=await runOpenAI([{status:429,headers:{'retry-after':new Date(Date.now()+20000).toUTCString()},body:''}]);
  assert.equal(outcome.error.code,'PROVIDER_RATE_LIMIT');
  assert.ok(outcome.error.retryAfter>=18&&outcome.error.retryAfter<=21,'HTTP-date delay is converted to seconds: '+outcome.error.retryAfter);
});
test('OpenAI adapter maps every 5xx to OUTCOME_UNKNOWN and 4xx to PROVIDER_REJECTED, never resending',async()=>{
  for(const status of [500,502,503,504,599]) {
    const {fake,outcome}=await runOpenAI([{status,body:'upstream'}]);
    assert.equal(outcome.error.code,'OUTCOME_UNKNOWN',String(status));assert.equal(fake.calls.length,1,String(status));
  }
  for(const status of [400,401,403,404,422]) {
    const {fake,outcome}=await runOpenAI([{status,body:'refused'}]);
    assert.equal(outcome.error.code,'PROVIDER_REJECTED',String(status));assert.equal(fake.calls.length,1,String(status));
  }
});
test('OpenAI adapter maps a transport error to OUTCOME_UNKNOWN',async()=>{
  const {fake,outcome}=await runOpenAI([{error:new Error('socket hang up')}]);
  assert.equal(outcome.error.code,'OUTCOME_UNKNOWN');assert.equal(fake.calls.length,1);
});
test('OpenAI adapter refuses a response without trustworthy usage',async()=>{
  for(const usage of [undefined,null,{},{prompt_tokens:100},{completion_tokens:50},{prompt_tokens:1.5,completion_tokens:50},{prompt_tokens:100,completion_tokens:-1},{prompt_tokens:'100',completion_tokens:50}]) {
    const {outcome}=await runOpenAI([{status:200,body:chatBody({usage})}]);
    assert.equal(outcome.error?.code,'PROVIDER_USAGE_UNKNOWN',JSON.stringify(usage));
  }
  const {outcome}=await runOpenAI([{status:200,body:'not json'}]);
  assert.equal(outcome.error.code,'PROVIDER_USAGE_UNKNOWN');
});
test('OpenAI adapter keeps usage but returns INVALID_AI_OUTPUT when finish_reason is not stop or content is not JSON',async()=>{
  const broken=[
    chatBody({finish:'length'}),chatBody({finish:'content_filter'}),chatBody({finish:undefined}),
    {choices:[],usage:{prompt_tokens:100,completion_tokens:50}},{usage:{prompt_tokens:100,completion_tokens:50}},
    chatBody({content:'not json'}),chatBody({content:''})
  ];
  for(const body of broken) {
    const {outcome}=await runOpenAI([{status:200,body}]);
    assert.equal(outcome.error,undefined,JSON.stringify(body));
    assert.equal(outcome.value.error,'INVALID_AI_OUTPUT',JSON.stringify(body));
    assert.equal(Object.hasOwn(outcome.value,'value'),false);
    assert.deepEqual(outcome.value.usage,{input_tokens:100,output_tokens:50,cost_usd:.0002625,rate_version:'fixture'},'usage stays accounted');
  }
});
test('OpenAI adapter refuses when the model configured now differs from the model frozen in the job, before any request',async()=>{
  const {fake,outcome}=await runOpenAI([{status:200,body:chatBody()}],{env:{...openaiEnv,PINE_AI_MODEL:'gpt-4.1'}});
  assert.equal(outcome.error.code,'PROVIDER_CONFIG_CHANGED');assert.equal(fake.calls.length,0);
});

// ---- C8: Gemini adapter through a fake fetcher -------------------------------------------------------------------------------------
const geminiRequest=stubRequest(geminiEnv);
const ok=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const generated=(over={})=>ok({usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{text:'{"buy":null}'}]}}],...over});
function scripted(steps){
  const calls=[];
  const fetcher=async url=>{
    calls.push(url);
    const step=steps[Math.min(calls.length-1,steps.length-1)];
    if(step instanceof Error)throw step;
    return typeof step==='function'?step():step;
  };
  return {calls,fetcher};
}
const runGemini=async(steps,{env=geminiEnv,request=geminiRequest}={})=>{
  const fake=scripted(steps);
  const outcome=await new GeminiProvider({env,fetcher:fake.fetcher}).run(request,'source',{}).then(value=>({value}),error=>({error}));
  return {fake,outcome};
};
test('Gemini adapter refuses changed configuration before any request',async()=>{
  for(const bad of [{PINE_AI_PROVIDER:'openai-chat'},{PINE_AI_MODEL:'gemini-3.1-pro-preview'},{PINE_AI_API_KEY:undefined}]) {
    const {fake,outcome}=await runGemini([ok({totalTokens:1})],{env:{...geminiEnv,...bad}});
    assert.equal(outcome.error.code,'PROVIDER_CONFIG_CHANGED',JSON.stringify(bad));assert.equal(fake.calls.length,0,JSON.stringify(bad));
  }
  const frozen={...geminiRequest,provider:{...geminiRequest.provider,model:'gemini-9'}};
  const {fake,outcome}=await runGemini([ok({totalTokens:1})],{env:{...geminiEnv,PINE_AI_MODEL:'gemini-9'},request:frozen});
  assert.equal(outcome.error.code,'AI_PROVIDER_NOT_CONFIGURED');assert.equal(fake.calls.length,0);
});
test('Gemini adapter maps token-count failures before any generation request',async()=>{
  for(const step of [new Response('',{status:500}),new Response('',{status:503}),new Error('network down'),ok({totalTokens:-1}),ok({}),new Response('not json',{status:200})]) {
    const {fake,outcome}=await runGemini([step]);
    assert.equal(outcome.error?.code,'TOKEN_COUNT_UNAVAILABLE',String(step?.status??step?.message));assert.equal(fake.calls.length,1);
  }
  const {fake,outcome}=await runGemini([new Response('',{status:400})]);
  assert.equal(outcome.error.code,'PROVIDER_REJECTED');assert.equal(fake.calls.length,1);
});
test('Gemini adapter maps generation 5xx and transport errors to OUTCOME_UNKNOWN, 4xx to PROVIDER_REJECTED, never resending',async()=>{
  for(const status of [500,502,503]) {
    const {fake,outcome}=await runGemini([ok({totalTokens:100}),new Response('',{status})]);
    assert.equal(outcome.error.code,'OUTCOME_UNKNOWN',String(status));assert.equal(fake.calls.length,2,'one count and one generation request');
  }
  const transport=await runGemini([ok({totalTokens:100}),new Error('socket reset')]);
  assert.equal(transport.outcome.error.code,'OUTCOME_UNKNOWN');assert.equal(transport.fake.calls.length,2);
  const rejected=await runGemini([ok({totalTokens:100}),new Response('',{status:403})]);
  assert.equal(rejected.outcome.error.code,'PROVIDER_REJECTED');assert.equal(rejected.fake.calls.length,2);
});
test('Gemini adapter keeps the default retry delay of two seconds when 429 sends none',async()=>{
  const {fake,outcome}=await runGemini([ok({totalTokens:100}),new Response('',{status:429})]);
  assert.equal(outcome.error.code,'PROVIDER_RATE_LIMIT');assert.equal(outcome.error.retryAfter,2);assert.equal(fake.calls.length,2);
});
test('Gemini adapter refuses missing or invalid usage and reports non-STOP or non-JSON output with usage kept',async()=>{
  for(const body of [{usageMetadata:undefined},{usageMetadata:{}},{usageMetadata:{promptTokenCount:-1,candidatesTokenCount:2}},{usageMetadata:{promptTokenCount:1.5}},{usageMetadata:{promptTokenCount:10,candidatesTokenCount:'2'}}]) {
    const {outcome}=await runGemini([ok({totalTokens:100}),generated(body)]);
    assert.equal(outcome.error?.code,'PROVIDER_USAGE_UNKNOWN',JSON.stringify(body));
  }
  for(const candidates of [[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"buy":null}'}]}}],[{finishReason:'SAFETY'}],[],[{finishReason:'STOP',content:{parts:[{text:'not json'}]}}]]) {
    const {outcome}=await runGemini([ok({totalTokens:100}),generated({candidates})]);
    assert.equal(outcome.error,undefined,JSON.stringify(candidates));
    assert.equal(outcome.value.error,'INVALID_AI_OUTPUT',JSON.stringify(candidates));
    assert.equal(outcome.value.usage.output_tokens,50);assert.equal(outcome.value.usage.input_tokens,100);
  }
});

// ---- C8: DirectProvider routing -------------------------------------------------------------------------------------------------------
test('DirectProvider routes by the provider frozen in the job and refuses any other',async()=>{
  assert.throws(()=>new DirectProvider().run({provider:{provider:'fixture'}},'source',{}),{code:'AI_PROVIDER_NOT_CONFIGURED'});
  assert.throws(()=>new DirectProvider().run({provider:{}},'source',{}),{code:'AI_PROVIDER_NOT_CONFIGURED'});
  const fake=fakeHttpsRequest([{status:200,body:chatBody({content:{buy:null}})}]);
  const openaiHttps=mock.method(https,'request',fake.impl),fetched=mock.method(globalThis,'fetch',async()=>{throw new Error('openai route must not call fetch');});
  try{
    const result=await withEnv(openaiEnv,()=>new DirectProvider().run(stubRequest(openaiEnv),'//@version=6',{}));
    assert.deepEqual(result.value,{buy:null});assert.equal(fake.calls.length,1);assert.equal(fetched.mock.callCount(),0);
  }finally{openaiHttps.mock.restore();fetched.mock.restore();}
  const guardedHttps=mock.method(https,'request',()=>{throw new Error('gemini route must not use node:https');});
  let step=0;
  const gemini=mock.method(globalThis,'fetch',async()=>step++===0?ok({totalTokens:100}):generated());
  try{
    const result=await withEnv(geminiEnv,()=>new DirectProvider().run(stubRequest(geminiEnv),'//@version=6',{}));
    assert.deepEqual(result.value,{buy:null});assert.equal(gemini.mock.callCount(),2);assert.equal(guardedHttps.mock.callCount(),0);
  }finally{guardedHttps.mock.restore();gemini.mock.restore();}
});
