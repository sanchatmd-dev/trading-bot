import test from 'node:test';
import assert from 'node:assert/strict';
import {AnthropicProvider} from '../src/pine-bridge/anthropic.js';
import {DirectProvider} from '../src/pine-bridge/gemini.js';
import {providerConfig,budgetFor} from '../src/pine-bridge/provider.js';
const key='sk-ant-test-dummy';
const env={PINE_AI_PROVIDER:'anthropic',PINE_AI_MODEL:'claude-sonnet-5-5',PINE_AI_API_KEY:key,PINE_AI_INPUT_USD_PER_MILLION:'2',PINE_AI_OUTPUT_USD_PER_MILLION:'10',PINE_AI_RATE_VERSION:'fixture'};
const makeRequest=(overrides={},operation='analyze')=>{
  const request={operation,provider:providerConfig({...env,...overrides}),analysis:{inputs:[],dependencies:[]}};
  request.budget=budgetFor(request,'//@version=6');
  return request;
};
const request=makeRequest();
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','request-id':'req_fixture',...headers}});
const message=(overrides={})=>({id:'msg_fixture',type:'message',role:'assistant',model:'claude-sonnet-5-5-fixture',content:[{type:'text',text:'{"buy":null,"exit":null,"eligible_inputs":[],"diagnostics":[]}'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:null,cache_read_input_tokens:null},...overrides});
const apiError=(type,status,headers)=>json({type:'error',error:{type,message:'fixture'}},status,headers);
const isCount=url=>String(url).endsWith('/v1/messages/count_tokens');
// Records every request. Handlers receive (kind, call) and return a Response.
function harness(handler) {
  const calls=[];
  const fetcher=async(url,options)=>{
    const call={url:String(url),kind:isCount(url)?'count':'create',headers:new Headers(options.headers),body:JSON.parse(options.body),options};
    calls.push(call);
    return handler(call);
  };
  return {calls,provider:new AnthropicProvider({env,fetcher})};
}
const normal=call=>call.kind==='count'?json({input_tokens:100}):json(message());

test('Anthropic counts before generation, sends the contract body and keeps the key in the header only',async()=>{
  const {calls,provider}=harness(normal);
  const result=await provider.run(request,'//@version=6\n// removed comment\nplot(close)',{});
  assert.deepEqual(calls.map(c=>c.kind),['count','create']);
  for(const call of calls) {
    assert.equal(call.url.includes(key),false);assert.equal(call.headers.get('x-api-key'),key);
    assert.equal(call.headers.get('authorization'),null);
    assert.ok(call.url.startsWith('https://api.anthropic.com/v1/messages'));
    assert.equal(JSON.stringify(call.body).includes(key),false);
    assert.equal(call.body.model,'claude-sonnet-5-5');
    assert.equal(call.body.output_config.effort,'low');
    assert.equal(call.body.output_config.format.type,'json_schema');
    assert.equal(call.body.output_config.format.schema.additionalProperties,false);
    assert.equal(call.body.messages.length,1);assert.equal(call.body.messages[0].role,'user');
    assert.equal(typeof call.body.system,'string');
    assert.equal(call.body.messages[0].content.includes('removed comment'),false);
    assert.equal(call.body.messages[0].content.includes('plot(close)'),true);
    for(const forbidden of ['thinking','temperature','top_p','tool_choice','tools','cache_control','fallbacks','metadata','stop_sequences'])assert.equal(Object.hasOwn(call.body,forbidden),false,forbidden);
  }
  assert.equal(calls[1].body.max_tokens,4000);
  assert.deepEqual(calls[0].body.output_config,calls[1].body.output_config);
  assert.deepEqual(result.value,{buy:null,exit:null,eligible_inputs:[],diagnostics:[]});
  assert.equal(result.request_id,'req_fixture');
  assert.equal(result.usage.model_version,'claude-sonnet-5-5-fixture');
  assert.equal(result.usage.counted_input_tokens,100);assert.equal(result.usage.rate_version,'fixture');
});
test('Anthropic schemas are closed and differ by operation',async()=>{
  const analyze=harness(normal),generate=harness(normal);
  await analyze.provider.run(request,'source',{});
  await generate.provider.run(makeRequest({},'generate'),'source',{});
  const a=analyze.calls[1].body.output_config.format.schema,g=generate.calls[1].body.output_config.format.schema;
  assert.deepEqual(Object.keys(a.properties),['buy','exit','eligible_inputs','diagnostics']);
  assert.deepEqual(Object.keys(g.properties),['buy','exit','diagnostics']);
  for(const schema of [a,g]) {
    assert.deepEqual(schema.required,Object.keys(schema.properties));
    assert.deepEqual(schema.properties.buy.anyOf,[{type:'string'},{type:'null'}]);
    assert.deepEqual(schema.properties.exit,schema.properties.buy);
    assert.deepEqual(schema.properties.diagnostics,{type:'array',items:{type:'string'}});
  }
  assert.deepEqual(a.properties.eligible_inputs,{type:'array',items:{type:'string'}});
});
test('Anthropic ignores ANTHROPIC_* environment overrides for destination and credentials',async()=>{
  const saved={...process.env};
  Object.assign(process.env,{ANTHROPIC_BASE_URL:'https://elsewhere.invalid',ANTHROPIC_AUTH_TOKEN:'other-token-not-real',ANTHROPIC_API_KEY:'other-key-not-real'});
  try {
    const {calls,provider}=harness(normal);
    await provider.run(request,'source',{});
    for(const call of calls) {
      assert.ok(call.url.startsWith('https://api.anthropic.com/'));
      assert.equal(call.headers.get('x-api-key'),key);assert.equal(call.headers.get('authorization'),null);
    }
  } finally {
    for(const name of ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY'])if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];
  }
});
test('Anthropic refuses excessive counted input with exactly one request',async()=>{
  const {calls,provider}=harness(()=>json({input_tokens:24000-1024+1}));
  await assert.rejects(provider.run(request,'source',{}),e=>e.code==='SOURCE_TOKEN_BUDGET_EXCEEDED'&&e.status===413);
  assert.equal(calls.length,1);assert.equal(calls[0].kind,'count');
  const edge=harness(call=>call.kind==='count'?json({input_tokens:24000-1024}):json(message()));
  await edge.provider.run(request,'source',{});
  assert.equal(edge.calls.length,2);
});
test('Anthropic count failures are TOKEN_COUNT_UNAVAILABLE and never reach generation',async()=>{
  for(const handler of [()=>apiError('api_error',500),()=>apiError('overloaded_error',529),()=>json({input_tokens:-1}),()=>json({input_tokens:1.5}),()=>json({}),()=>{throw new TypeError('network down');}]) {
    const {calls,provider}=harness(handler);
    await assert.rejects(provider.run(request,'source',{}),{code:'TOKEN_COUNT_UNAVAILABLE'});
    assert.equal(calls.length,1);
  }
});
test('Anthropic 429 keeps the explicit retry delay and is sent once',async()=>{
  for(const [headers,expected] of [[{'retry-after':'120'},120],[{},2]]) {
    const {calls,provider}=harness(()=>apiError('rate_limit_error',429,headers));
    await assert.rejects(provider.run(request,'source',{}),e=>e.code==='PROVIDER_RATE_LIMIT'&&e.retryAfter===expected);
    assert.equal(calls.length,1);
  }
  const dated=harness(()=>apiError('rate_limit_error',429,{'retry-after':new Date(Date.now()+60000).toUTCString()}));
  await assert.rejects(dated.provider.run(request,'source',{}),e=>e.code==='PROVIDER_RATE_LIMIT'&&e.retryAfter>50&&e.retryAfter<=60);
  const generation=harness(call=>call.kind==='count'?json({input_tokens:100}):apiError('rate_limit_error',429,{'retry-after':'7'}));
  await assert.rejects(generation.provider.run(request,'source',{}),e=>e.code==='PROVIDER_RATE_LIMIT'&&e.retryAfter===7);
  assert.equal(generation.calls.filter(c=>c.kind==='create').length,1);
});
test('Anthropic 5xx, overload and network failures on generation are OUTCOME_UNKNOWN and never resent',async()=>{
  for(const failure of [()=>apiError('api_error',500),()=>apiError('overloaded_error',529),()=>apiError('api_error',503),()=>{throw new TypeError('connection reset');}]) {
    const {calls,provider}=harness(call=>call.kind==='count'?json({input_tokens:100}):failure());
    await assert.rejects(provider.run(request,'source',{}),{code:'OUTCOME_UNKNOWN'});
    assert.equal(calls.filter(c=>c.kind==='create').length,1);
  }
});
test('Anthropic 200 without a usage record is PROVIDER_USAGE_UNKNOWN, which the worker treats as unknown',async()=>{
  const {calls,provider}=harness(call=>call.kind==='count'?json({input_tokens:100}):new Response('not json',{status:200}));
  await assert.rejects(provider.run(request,'source',{}),{code:'PROVIDER_USAGE_UNKNOWN'});
  assert.equal(calls.filter(c=>c.kind==='create').length,1);
});
test('Anthropic 4xx rejection other than rate limit is PROVIDER_REJECTED',async()=>{
  for(const [type,status] of [['invalid_request_error',400],['authentication_error',401],['permission_error',403],['not_found_error',404]]) {
    const {calls,provider}=harness(call=>call.kind==='count'?json({input_tokens:100}):apiError(type,status));
    await assert.rejects(provider.run(request,'source',{}),{code:'PROVIDER_REJECTED'});
    assert.equal(calls.filter(c=>c.kind==='create').length,1);
  }
});
test('Anthropic aborts map to OUTCOME_UNKNOWN or TOKEN_COUNT_UNAVAILABLE and cancellation after counting stops generation',async()=>{
  const duringCreate=new AbortController();
  const created=harness(async call=>{if(call.kind==='count')return json({input_tokens:100});duringCreate.abort();throw new DOMException('aborted','AbortError');});
  await assert.rejects(created.provider.run(request,'source',{signal:duringCreate.signal}),{code:'OUTCOME_UNKNOWN'});
  const afterCount=new AbortController();
  const counted=harness(call=>{afterCount.abort();return json({input_tokens:100});});
  await assert.rejects(counted.provider.run(request,'source',{signal:afterCount.signal}),{code:'CANCELLED'});
  assert.equal(counted.calls.length,1);
  const early=new AbortController();early.abort();
  const never=harness(normal);
  await assert.rejects(never.provider.run(request,'source',{signal:early.signal}),{code:'TOKEN_COUNT_UNAVAILABLE'});
  assert.equal(never.calls.filter(c=>c.kind==='create').length,0);
});
test('Anthropic response above 128 KiB is refused before the SDK parses it',async()=>{
  const generation=harness(call=>call.kind==='count'?json({input_tokens:100}):new Response(JSON.stringify(message({content:[{type:'text',text:'x'.repeat(200*1024)}]})),{status:200}));
  await assert.rejects(generation.provider.run(request,'source',{}),{code:'PROVIDER_RESPONSE_TOO_LARGE'});
  assert.equal(generation.calls.filter(c=>c.kind==='create').length,1);
  const counting=harness(()=>new Response('{"input_tokens":1,"pad":"'+'x'.repeat(200*1024)+'"}',{status:200}));
  await assert.rejects(counting.provider.run(request,'source',{}),{code:'PROVIDER_RESPONSE_TOO_LARGE'});
});
test('Anthropic maps refusal with usage, max_tokens and malformed output',async()=>{
  const run=async overrides=>{
    const {provider}=harness(call=>call.kind==='count'?json({input_tokens:100}):json(message(overrides)));
    return provider.run(request,'source',{});
  };
  const refusal=await run({stop_reason:'refusal',content:[]});
  assert.equal(refusal.error,'PROVIDER_REFUSAL');assert.equal(refusal.usage.input_tokens,100);assert.equal(refusal.usage.output_tokens,20);assert.equal('value' in refusal,false);
  const truncated=await run({stop_reason:'max_tokens'});
  assert.equal(truncated.error,'INVALID_AI_OUTPUT');assert.equal(truncated.usage.output_tokens,20);
  for(const stop_reason of ['stop_sequence','tool_use','pause_turn','model_context_window_exceeded'])assert.equal((await run({stop_reason})).error,'INVALID_AI_OUTPUT');
  assert.equal((await run({content:[{type:'text',text:'not json'}]})).error,'INVALID_AI_OUTPUT');
  assert.equal((await run({content:[]})).error,'INVALID_AI_OUTPUT');
  const mixed=await run({content:[{type:'thinking',thinking:'{"buy":"ignored"}',signature:'sig'},{type:'text',text:'{"buy":'},{type:'text',text:'null,"exit":null,"diagnostics":[]}'}]});
  assert.deepEqual(mixed.value,{buy:null,exit:null,diagnostics:[]});
});
test('Anthropic usage cost follows fixture rates, including cache tokens and thinking',async()=>{
  const run=async(usage,rates)=>{
    const {provider}=harness(call=>call.kind==='count'?json({input_tokens:900}):json(message({usage})));
    return provider.run(makeRequest(rates),'source',{});
  };
  const plain=await run({input_tokens:1000,output_tokens:200,cache_creation_input_tokens:null,cache_read_input_tokens:null});
  assert.equal(plain.usage.input_tokens,1000);assert.equal(plain.usage.output_tokens,200);assert.equal(plain.usage.counted_input_tokens,900);
  assert.ok(Math.abs(plain.usage.cost_usd-0.004)<1e-12);
  const cached=await run({input_tokens:1000,output_tokens:200,cache_creation_input_tokens:100,cache_read_input_tokens:200,output_tokens_details:{thinking_tokens:50}},{PINE_AI_INPUT_USD_PER_MILLION:'4',PINE_AI_OUTPUT_USD_PER_MILLION:'20'});
  assert.equal(cached.usage.input_tokens,1300);assert.equal(cached.usage.output_tokens,200);assert.equal(cached.usage.thinking_tokens,50);
  assert.ok(Math.abs(cached.usage.cost_usd-(1200*4+100*4*1.25+200*20)/1e6)<1e-12);
  for(const usage of [{input_tokens:-1,output_tokens:1},{input_tokens:1.5,output_tokens:1},{input_tokens:1,output_tokens:'2'},{input_tokens:1,output_tokens:1,cache_read_input_tokens:-5},{input_tokens:1}]) {
    const {provider}=harness(call=>call.kind==='count'?json({input_tokens:900}):json(message({usage})));
    await assert.rejects(provider.run(request,'source',{}),{code:'PROVIDER_USAGE_UNKNOWN'});
  }
});
test('Anthropic refuses a changed or incomplete provider configuration before any request',async()=>{
  for(const changed of [{PINE_AI_PROVIDER:'gemini'},{PINE_AI_MODEL:'claude-haiku-5-5'},{PINE_AI_API_KEY:''}]) {
    let calls=0;
    const provider=new AnthropicProvider({env:{...env,...changed},fetcher:async()=>{calls++;return json({});}});
    await assert.rejects(provider.run(request,'source',{}),{code:'PROVIDER_CONFIG_CHANGED'});
    assert.equal(calls,0);
  }
  await assert.rejects(new DirectProvider().run(request,'source',{}),e=>e.code==='PROVIDER_CONFIG_CHANGED'||process.env.PINE_AI_PROVIDER==='anthropic');
});
test('providerConfig accepts exactly the three Anthropic models and still requires explicit rates',()=>{
  for(const model of ['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5']) {
    const config=providerConfig({...env,PINE_AI_MODEL:model});
    assert.equal(config.provider,'anthropic');assert.equal(config.model,model);assert.equal(config.sourceView,'pine-ai-view-v1');
    assert.equal(config.inputRate,2);assert.equal(config.outputRate,10);assert.equal(config.rateVersion,'fixture');
  }
  for(const model of ['claude-opus-4-5','claude-sonnet-5','claude-opus-5-5-latest','gpt-4.1','gemini-3.8-flash',''])assert.throws(()=>providerConfig({...env,PINE_AI_MODEL:model}),{code:'AI_PROVIDER_NOT_CONFIGURED'});
  assert.throws(()=>providerConfig({...env,PINE_AI_API_KEY:''}),{code:'AI_PROVIDER_NOT_CONFIGURED'});
  assert.throws(()=>providerConfig({...env,PINE_AI_INPUT_USD_PER_MILLION:''}));
  assert.throws(()=>providerConfig({...env,PINE_AI_RATE_VERSION:''}),{code:'AI_RATE_VERSION_REQUIRED'});
  assert.throws(()=>providerConfig({...env,PINE_AI_PROVIDER:'anthropic-x'}),{code:'AI_PROVIDER_NOT_CONFIGURED'});
  assert.equal(providerConfig({...env,PINE_AI_PROVIDER:'openai-chat',PINE_AI_MODEL:'gpt-4.1'}).sourceView,undefined);
});
test('budgetFor reserves the full input cap for Anthropic and keeps the per-job cost limit',()=>{
  const budget=makeRequest().budget;
  assert.equal(budget.input_tokens,24000);assert.equal(budget.output_tokens,4000);assert.equal(budget.total_reserved_tokens,56000);
  assert.equal(budget.tokenizer,'anthropic-count-tokens-v1');assert.equal(budget.framing_reserve,1024);
  const opus=makeRequest({PINE_AI_MODEL:'claude-opus-5-5',PINE_AI_INPUT_USD_PER_MILLION:'4',PINE_AI_OUTPUT_USD_PER_MILLION:'20'});
  assert.ok(Math.abs(opus.budget.reserved_usd-0.352)<1e-12);
  const dear={operation:'analyze',provider:providerConfig({...env,PINE_AI_INPUT_USD_PER_MILLION:'10',PINE_AI_OUTPUT_USD_PER_MILLION:'40'}),analysis:{inputs:[],dependencies:[]}};
  assert.throws(()=>budgetFor(dear,'//@version=6'),{code:'JOB_COST_BUDGET_EXCEEDED'});
});
test('Anthropic declared content-length above 128 KiB is PROVIDER_RESPONSE_TOO_LARGE with exactly one request',async()=>{
  const big={'content-length':'200000'};
  const generation=harness(call=>call.kind==='count'?json({input_tokens:100}):new Response(JSON.stringify(message()),{status:200,headers:big}));
  await assert.rejects(generation.provider.run(request,'source',{}),{code:'PROVIDER_RESPONSE_TOO_LARGE'});
  assert.equal(generation.calls.filter(c=>c.kind==='create').length,1);
  const counting=harness(()=>new Response('{"input_tokens":1}',{status:200,headers:big}));
  await assert.rejects(counting.provider.run(request,'source',{}),{code:'PROVIDER_RESPONSE_TOO_LARGE'});
  assert.equal(counting.calls.length,1);
});
test('Anthropic refuses changed credentials or beta headers from ANTHROPIC_CUSTOM_HEADERS before any request',async()=>{
  const saved=process.env.ANTHROPIC_CUSTOM_HEADERS;
  try {
    for(const custom of ['x-api-key: other-key-not-real','anthropic-beta: fixture-beta','authorization: Bearer other-token-not-real','x-api-key: other-key-not-real\nanthropic-beta: fixture-beta']) {
      process.env.ANTHROPIC_CUSTOM_HEADERS=custom;
      const {calls,provider}=harness(normal);
      await assert.rejects(provider.run(request,'source',{}),{code:'PROVIDER_CONFIG_CHANGED'});
      assert.equal(calls.length,0,custom);
    }
    process.env.ANTHROPIC_CUSTOM_HEADERS='x-fixture-note: harmless';
    const {calls,provider}=harness(normal);
    await provider.run(request,'source',{});
    assert.equal(calls.length,2);
    for(const call of calls)assert.equal(call.headers.get('x-api-key'),key);
  } finally {
    if(saved===undefined)delete process.env.ANTHROPIC_CUSTOM_HEADERS;else process.env.ANTHROPIC_CUSTOM_HEADERS=saved;
  }
});
test('Anthropic SDK stays silent when ANTHROPIC_LOG=debug is set',async()=>{
  const savedLog=process.env.ANTHROPIC_LOG,saved={};
  const methods=['debug','info','warn','error','log'];
  const seen=[];
  for(const name of methods) {saved[name]=console[name];console[name]=(...args)=>{seen.push([name,args]);};}
  process.env.ANTHROPIC_LOG='debug';
  try {
    const {provider}=harness(normal);
    await provider.run(request,'//@version=6\nplot(close)',{});
  } finally {
    for(const name of methods)console[name]=saved[name];
    if(savedLog===undefined)delete process.env.ANTHROPIC_LOG;else process.env.ANTHROPIC_LOG=savedLog;
  }
  assert.deepEqual(seen,[]);
});