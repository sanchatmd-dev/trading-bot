import {fail} from './source.js';
import {providerMessages,OpenAIProvider} from './provider.js';
import {aiSourceView} from './ai-source.js';

export class GeminiProvider {
  constructor({fetcher=fetch,env=process.env}={}){this.fetcher=fetcher;this.env=env;}
  async run(request,source,{signal}) {
    if(this.env.PINE_AI_PROVIDER!=='gemini'||request.provider.model!==this.env.PINE_AI_MODEL||!this.env.PINE_AI_API_KEY)throw fail('PROVIDER_CONFIG_CHANGED');
    const model=request.provider.model;
    if(!['gemini-3.8-flash','gemini-3.1-pro-preview'].includes(model))throw fail('AI_PROVIDER_NOT_CONFIGURED');
    const messages=providerMessages(request,aiSourceView(source));
    const payload={systemInstruction:{parts:[{text:messages[0].content}]},contents:[{role:'user',parts:[{text:messages[1].content}]}],generationConfig:{maxOutputTokens:4000,responseMimeType:'application/json',thinkingConfig:{thinkingLevel:'low'}}};
    const post=async(method,body)=>{
      let response;
      try{response=await this.fetcher('https://generativelanguage.googleapis.com/v1beta/models/'+model+':'+method,{method:'POST',headers:{'x-goog-api-key':this.env.PINE_AI_API_KEY,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(80000)]):AbortSignal.timeout(80000)});}
      catch{throw fail(method==='countTokens'?'TOKEN_COUNT_UNAVAILABLE':'OUTCOME_UNKNOWN');}
      if(!response.ok){
        await response.body?.cancel();
        if(response.status===429){
          const raw=response.headers.get('retry-after');
          const retryAfter=raw===null?2:/^\d+$/.test(raw)?Number(raw):Math.max(0,(Date.parse(raw)-Date.now())/1000);
          throw Object.assign(fail('PROVIDER_RATE_LIMIT'),{retryAfter});
        }
        throw fail(response.status>=500?(method==='countTokens'?'TOKEN_COUNT_UNAVAILABLE':'OUTCOME_UNKNOWN'):'PROVIDER_REJECTED');
      }
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{
        for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>128*1024)throw fail('PROVIDER_RESPONSE_TOO_LARGE');chunks.push(value);}
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }catch(error){throw error.code?error:fail(method==='countTokens'?'TOKEN_COUNT_UNAVAILABLE':'OUTCOME_UNKNOWN');}
      finally{await reader.cancel().catch(()=>{});}
    };
    const count=await post('countTokens',{generateContentRequest:{model:'models/'+model,...payload}});
    if(!Number.isSafeInteger(count.totalTokens)||count.totalTokens<0)throw fail('TOKEN_COUNT_UNAVAILABLE');
    if(count.totalTokens+1024>request.budget.input_tokens)throw fail('SOURCE_TOKEN_BUDGET_EXCEEDED',413);
    if(signal?.aborted)throw fail('CANCELLED');
    const body=await post('generateContent',payload),u=body.usageMetadata;
    if(!u||![u.promptTokenCount,u.candidatesTokenCount??0,u.thoughtsTokenCount??0].every(n=>Number.isSafeInteger(n)&&n>=0))throw fail('PROVIDER_USAGE_UNKNOWN');
    const output=(u.candidatesTokenCount??0)+(u.thoughtsTokenCount??0);
    const result={usage:{input_tokens:u.promptTokenCount,output_tokens:output,thinking_tokens:u.thoughtsTokenCount??0,counted_input_tokens:count.totalTokens,cost_usd:(u.promptTokenCount*request.provider.inputRate+output*request.provider.outputRate)/1e6,rate_version:request.provider.rateVersion,model_version:body.modelVersion??model},request_id:body.responseId??null};
    const candidate=body.candidates?.[0];
    if(candidate?.finishReason!=='STOP')return {...result,error:'INVALID_AI_OUTPUT'};
    try{return {...result,value:JSON.parse(candidate.content.parts.filter(p=>!p.thought&&typeof p.text==='string').map(p=>p.text).join(''))};}
    catch{return {...result,error:'INVALID_AI_OUTPUT'};}
  }
}
export class DirectProvider {
  run(request,source,options){
    if(request.provider.provider==='gemini')return new GeminiProvider().run(request,source,options);
    if(request.provider.provider==='openai-chat')return new OpenAIProvider().run(request,source,options);
    throw fail('AI_PROVIDER_NOT_CONFIGURED');
  }
}
