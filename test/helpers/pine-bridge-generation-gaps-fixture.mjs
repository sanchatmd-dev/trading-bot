import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';

/**
 * PM-1 F02-01 gap tests: shared fakes for test/pine-bridge-refusals.test.js and
 * test/postgres/pine-bridge-generation-gaps.test.mjs. No network, no real provider, no provider key.
 */

/** SHA-256 hex, computed here and not through src/pine-bridge/source.js, so a test never confirms a hash with the code under test. */
export const sha256Hex=value=>createHash('sha256').update(value).digest('hex');

/** Independent copy of the documented canonical form (sorted keys, JSON scalars) for snapshot_hash checks. */
export const canonicalForm=value=>{
  if(Array.isArray(value))return '['+value.map(canonicalForm).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalForm(value[key])).join(',')+'}';
  return JSON.stringify(value);
};

/** The namespaced identifier prefix of an assembled Bridge block, derived here from the deployment id. */
export const bridgePrefix=deploymentId=>'rt_'+sha256Hex(deploymentId).slice(0,12)+'_';

/** Fixed, valid deployment facts. Ids are lowercase UUID shape, as the assembler requires. */
export const DEPLOYMENT=Object.freeze({
  deployment_id:'12345678-1234-1234-1234-123456789abc',
  pine_import_id:'12345678-1234-1234-1234-123456789def',
  source_version:1,broker:'binance-global',symbol:'BTCUSDT',timeframe:'1D'
});

/**
 * Fake node:https request function for OpenAIProvider. `plan` is a list of steps used in call order (the last step repeats):
 *   {status,headers,body}  an HTTP response, body is a string or an object (sent as JSON)
 *   {error}                a transport error on the request
 * `calls` records url, options and the request payload of each dispatch. Nothing leaves the process.
 */
export function fakeHttpsRequest(plan){
  const calls=[];
  const impl=(url,options,callback)=>{
    const request=new EventEmitter();
    request.destroy=error=>{queueMicrotask(()=>{request.emit('error',error);request.emit('close');});};
    request.end=payload=>{
      calls.push({url:String(url),options,payload});
      const step=plan[Math.min(calls.length-1,plan.length-1)];
      setImmediate(()=>{
        if(step.error){request.emit('error',step.error);request.emit('close');return;}
        const response=new EventEmitter();
        response.statusCode=step.status;response.headers=step.headers??{};
        callback(response);
        const body=typeof step.body==='string'?step.body:JSON.stringify(step.body??{});
        response.emit('data',Buffer.from(body));response.emit('end');request.emit('close');
      });
    };
    return request;
  };
  return {impl,calls};
}

/**
 * A completed chat-completions body as the OpenAI-compatible endpoint returns it. A key present in `options` with value undefined
 * omits that part (no finish_reason, no usage), unlike a missing key, which takes the default.
 */
export const chatBody=(options={})=>{
  const content=Object.hasOwn(options,'content')?options.content:{buy:null,exit:null,diagnostics:[],eligible_inputs:[]};
  const finish=Object.hasOwn(options,'finish')?options.finish:'stop';
  const usage=Object.hasOwn(options,'usage')?options.usage:{prompt_tokens:100,completion_tokens:50};
  return {
    choices:[{...(finish===undefined?{}:{finish_reason:finish}),message:{content:typeof content==='string'?content:JSON.stringify(content)}}],
    ...(usage===undefined?{}:{usage})
  };
};

/** Request, response and json sink for calling pineBridgeRoutes without a socket. */
export function routeRequest({path,body,key,method='POST'}){
  const request=Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method=method;request.url=path;request.headers=key===undefined?{}:{'idempotency-key':key};
  return request;
}
export function jsonSink(){
  const sink={status:null,body:null};
  return {sink,json:(response,status,body)=>{sink.status=status;sink.body=body;}};
}
