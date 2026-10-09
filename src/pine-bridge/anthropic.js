import Anthropic from '@anthropic-ai/sdk';
import {fail} from './source.js';
import {providerMessages} from './provider.js';
import {aiSourceView} from './ai-source.js';

export const anthropicModels=['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5'];
const MAX_RESPONSE_BYTES=128*1024,REQUEST_TIMEOUT_MS=80000,nullableName={anyOf:[{type:'string'},{type:'null'}]},text={type:'string'};
// Both schemas are closed objects. validateProposal remains the only authority.
const schemas={
  analyze:{type:'object',properties:{buy:nullableName,exit:nullableName,eligible_inputs:{type:'array',items:text},diagnostics:{type:'array',items:text}},required:['buy','exit','eligible_inputs','diagnostics'],additionalProperties:false},
  generate:{type:'object',properties:{buy:nullableName,exit:nullableName,diagnostics:{type:'array',items:text}},required:['buy','exit','diagnostics'],additionalProperties:false}
};
// The SDK reads the whole body itself, so the 128 KiB cap and the 80 s deadline
// are enforced on the stream it receives. Redirects are refused. ANTHROPIC_CUSTOM_HEADERS
// can alter the outgoing headers, so a changed key, any authorization header or any
// beta header is refused before the request leaves.
function boundedFetch(fetcher,apiKey) {
  return async(url,init={}) => {
    const outgoing=new Headers(init.headers);
    if(outgoing.get('x-api-key')!==apiKey||outgoing.has('authorization')||outgoing.has('anthropic-beta'))throw fail('PROVIDER_CONFIG_CHANGED');
    const deadline=AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response=await fetcher(url,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,deadline]):deadline});
    const declared=Number(response.headers.get('content-length'));
    if(Number.isFinite(declared)&&declared>MAX_RESPONSE_BYTES){await response.body?.cancel().catch(()=>{});throw fail('PROVIDER_RESPONSE_TOO_LARGE');}
    if(!response.body)return response;
    let size=0;
    const limited=response.body.pipeThrough(new TransformStream({transform(chunk,controller){
      size+=chunk.length;
      if(size>MAX_RESPONSE_BYTES)throw fail('PROVIDER_RESPONSE_TOO_LARGE');
      controller.enqueue(chunk);
    }}));
    return new Response(limited,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
function retryAfterSeconds(headers) {
  const raw=headers?.get?.('retry-after')??null;
  return raw===null?2:/^\d+$/.test(raw)?Number(raw):Math.max(0,(Date.parse(raw)-Date.now())/1000);
}
// The SDK wraps an error thrown by the injected fetch as APIConnectionError with the original as cause.
const ownCodes=new Set(['PROVIDER_RESPONSE_TOO_LARGE','PROVIDER_CONFIG_CHANGED']);
// Most specific class first. Ambiguous outcomes are never resent here; the worker owns retry policy.
function classify(error,counting) {
  const own=[error,error?.cause].find(candidate=>ownCodes.has(candidate?.code));
  if(own)return own;
  const unknown=fail(counting?'TOKEN_COUNT_UNAVAILABLE':'OUTCOME_UNKNOWN');
  if(error instanceof Anthropic.RateLimitError)return Object.assign(fail('PROVIDER_RATE_LIMIT'),{retryAfter:retryAfterSeconds(error.headers)});
  if(error instanceof Anthropic.InternalServerError||error instanceof Anthropic.APIConnectionError||error instanceof Anthropic.APIUserAbortError)return unknown;
  if(error instanceof Anthropic.APIError)return fail('PROVIDER_REJECTED');
  return unknown;
}
const wholeNumber=n=>Number.isSafeInteger(n)&&n>=0;
export class AnthropicProvider {
  constructor({fetcher=fetch,env=process.env}={}){this.fetcher=fetcher;this.env=env;}
  async run(request,source,{signal}={}) {
    if(this.env.PINE_AI_PROVIDER!=='anthropic'||request.provider.model!==this.env.PINE_AI_MODEL||!this.env.PINE_AI_API_KEY)throw fail('PROVIDER_CONFIG_CHANGED');
    const model=request.provider.model;
    if(!anthropicModels.includes(model))throw fail('AI_PROVIDER_NOT_CONFIGURED');
    const messages=providerMessages(request,aiSourceView(source));
    const system=messages[0].content;
    const output_config={effort:'low',format:{type:'json_schema',schema:schemas[request.operation==='analyze'?'analyze':'generate']}};
    // Explicit base URL and null auth token keep ANTHROPIC_* environment variables out of the request.
    // logLevel off keeps ANTHROPIC_LOG=debug from writing prompts or Pine source to service logs.
    const client=new Anthropic({apiKey:this.env.PINE_AI_API_KEY,authToken:null,baseURL:'https://api.anthropic.com',maxRetries:0,timeout:REQUEST_TIMEOUT_MS,logLevel:'off',fetch:boundedFetch(this.fetcher,this.env.PINE_AI_API_KEY)});
    const options=signal?{signal}:{};
    const conversation=[{role:'user',content:messages[1].content}];
    let count;
    try{count=await client.messages.countTokens({model,system,messages:conversation,output_config},options);}
    catch(error){throw classify(error,true);}
    if(!wholeNumber(count?.input_tokens))throw fail('TOKEN_COUNT_UNAVAILABLE');
    if(count.input_tokens+1024>request.budget.input_tokens)throw fail('SOURCE_TOKEN_BUDGET_EXCEEDED',413);
    if(signal?.aborted)throw fail('CANCELLED');
    let message;
    try{message=await client.messages.create({model,max_tokens:4000,system,messages:conversation,output_config},options);}
    catch(error){throw classify(error,false);}
    const u=message?.usage,cacheCreation=u?.cache_creation_input_tokens??0,cacheRead=u?.cache_read_input_tokens??0;
    if(!u||![u.input_tokens,u.output_tokens,cacheCreation,cacheRead].every(wholeNumber))throw fail('PROVIDER_USAGE_UNKNOWN');
    const {inputRate,outputRate}=request.provider;
    const thinking=u.output_tokens_details?.thinking_tokens;
    const result={usage:{input_tokens:u.input_tokens+cacheCreation+cacheRead,output_tokens:u.output_tokens,thinking_tokens:wholeNumber(thinking)?thinking:0,counted_input_tokens:count.input_tokens,cost_usd:((u.input_tokens+cacheRead)*inputRate+cacheCreation*inputRate*1.25+u.output_tokens*outputRate)/1e6,rate_version:request.provider.rateVersion,model_version:message.model??model},request_id:message._request_id??null};
    if(message.stop_reason==='refusal')return {...result,error:'PROVIDER_REFUSAL'};
    if(message.stop_reason!=='end_turn')return {...result,error:'INVALID_AI_OUTPUT'};
    try{return {...result,value:JSON.parse(message.content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join(''))};}
    catch{return {...result,error:'INVALID_AI_OUTPUT'};}
  }
}