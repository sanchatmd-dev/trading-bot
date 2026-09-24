import test from 'node:test';
import assert from 'node:assert/strict';
import {GeminiProvider} from '../src/pine-bridge/gemini.js';
import {providerConfig,budgetFor} from '../src/pine-bridge/provider.js';
import {aiSourceView} from '../src/pine-bridge/ai-source.js';
const env={PINE_AI_PROVIDER:'gemini',PINE_AI_MODEL:'gemini-3.8-flash',PINE_AI_API_KEY:'fixture-not-real',PINE_AI_INPUT_USD_PER_MILLION:'.75',PINE_AI_OUTPUT_USD_PER_MILLION:'3.75',PINE_AI_RATE_VERSION:'fixture'};
const request={operation:'analyze',provider:providerConfig(env),analysis:{inputs:[],dependencies:[]}};
request.budget=budgetFor(request,'//@version=6');
test('AI-only source view preserves string comments and Pine indentation while removing prose',()=>{
  const original='// license remains in original\r\n//@version=6\r\n\nindicator("https://example.test") // trailing\nif true\n    s = "// keep"\n\n    plot(close)\n';
  assert.equal(aiSourceView(original),'//@version=6\nindicator("https://example.test")\nif true\n    s = "// keep"\n    plot(close)');
  assert.ok(original.startsWith('// license'));
});
const ok=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
test('Gemini counts before generation and includes thinking in cost without exposing key in URL',async()=>{
  const calls=[];
  const provider=new GeminiProvider({env,fetcher:async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});assert.equal(url.includes(env.PINE_AI_API_KEY),false);
    if(url.endsWith(':countTokens'))return ok({totalTokens:100});
    return ok({usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:30},candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'not returned'},{text:'{"buy":null}'}]}}]});
  }});
  const result=await provider.run(request,'source',{});
  assert.equal(calls.length,2);assert.equal(calls[1].body.generationConfig.maxOutputTokens,4000);
  assert.equal(result.usage.output_tokens,50);assert.equal(result.usage.cost_usd,.0002625);assert.deepEqual(result.value,{buy:null});
});
test('Gemini refuses excessive input before generation and preserves explicit retry delay',async()=>{
  let calls=0;
  await assert.rejects(new GeminiProvider({env,fetcher:async()=>{calls++;return ok({totalTokens:24001});}}).run(request,'source',{}),{code:'SOURCE_TOKEN_BUDGET_EXCEEDED'});
  assert.equal(calls,1);
  await assert.rejects(new GeminiProvider({env,fetcher:async()=>new Response('',{status:429,headers:{'retry-after':'120'}})}).run(request,'source',{}),e=>e.code==='PROVIDER_RATE_LIMIT'&&e.retryAfter===120);
});
