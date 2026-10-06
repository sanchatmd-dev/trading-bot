import test from 'node:test';
import assert from 'node:assert/strict';
import {clientIp} from '../src/http-safety.js';
import {createRequestLimits,API_LIMIT,WEBHOOK_SOURCE_LIMIT} from '../src/postgres/request-limits.js';
import {createDispatcher,json} from '../src/postgres/request-dispatch.js';

const ORIGIN='https://app.test',hex='c'.repeat(64),unknown='d'.repeat(64);
// Real dispatcher and limiter; the database, session and router are recording fakes.
function harness({portHandles=false}={}){
  const events=[],rows=new Map(),keys=[];
  const limit=async(key,max)=>{keys.push(key);const n=(rows.get(key)||0)+1;rows.set(key,n);return n<=max;};
  const auth={
    checkOrigin(req){
      events.push('origin');
      if(req.method==='GET')return;
      if(req.headers.origin!==ORIGIN)throw Object.assign(new Error('Origin is not allowed'),{status:403});
    },
    async prepareSession(){events.push('session');}
  };
  const dispatch=createDispatcher({
    newsWindowsPort:{handle:async(req,res)=>{events.push('port');if(portHandles)json(res,200,{port:true});return portHandles;}},
    requestLimits:createRequestLimits({limit,sourceKey:req=>clientIp(req,false)}),
    auth,
    database:{transaction:async(fn,{isolation})=>{events.push('tx:'+isolation);return fn();}},
    store:{audit:async()=>{}},
    preloadJson:async()=>{events.push('preload');},
    // Stands in for the router: it routes on the same canonical pathname and knows one webhook secret.
    handleRequest:async(req,res)=>{
      const pathname=new URL(req.url,'http://localhost').pathname;
      events.push('route:'+pathname);
      if(pathname.startsWith('/webhooks/'))return json(res,pathname.endsWith('/'+hex)?202:404,pathname.endsWith('/'+hex)?{accepted:true}:{error:'Not found'});
      return json(res,200,{ok:true});
    },
    runMarketDeferred:async()=>null
  });
  const send=async(url,{method='POST',origin=ORIGIN}={})=>{
    events.length=0;keys.length=0;
    const req={url,method,headers:{...(origin?{origin}:{}),'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}};
    const res={headersSent:false,status:null,headers:null,body:null,
      writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},
      end(body){this.body=body===undefined?'':String(body);},removeHeader(){},setHeader(){}};
    await dispatch(req,res);
    return {status:res.status,headers:res.headers,body:res.body,events:[...events],keys:[...keys]};
  };
  return {send,rows};
}

const apiTargets=['/api/bots','//evil/api/bots','http://localhost/api/bots','http://evil.example/api/bots','/webhooks/../api/bots','/./api/bots','/%2e%2e/api/bots'];
const webhookTargets=['/webhooks/tradingview/'+hex,'//evil/webhooks/tradingview/'+hex,'http://localhost/webhooks/tradingview/'+hex,'/./webhooks/tradingview/'+hex,'/x/../webhooks/tradingview/'+hex,'/%2e%2e/webhooks/tradingview/'+hex,'/api/../webhooks/tradingview/'+hex];

test('every raw spelling of an API path is limited, Origin-checked and SERIALIZABLE',async()=>{
  const {send}=harness();
  for(const target of apiTargets){
    const answer=await send(target);
    assert.equal(answer.status,200,target);
    assert.deepEqual(answer.keys,['request:127.0.0.1'],target);
    assert.deepEqual(answer.events,['port','origin','preload','session','tx:SERIALIZABLE','route:/api/bots'],target);
    const crossSite=await send(target,{origin:'https://evil.example'});
    assert.equal(crossSite.status,403,target+' without our Origin');
    assert.ok(!crossSite.events.some(event=>event.startsWith('route:')),target+' never reached the router');
  }
});

test('every raw spelling of a webhook path is limited in webhook buckets and READ COMMITTED',async()=>{
  const {send}=harness();
  for(const target of webhookTargets){
    const answer=await send(target,{origin:null});
    assert.equal(answer.status,202,target);
    assert.deepEqual(answer.keys,['webhook-source:127.0.0.1'],target);
    assert.deepEqual(answer.events,['port','preload','session','tx:READ COMMITTED','route:/webhooks/tradingview/'+hex],target);
  }
});

test('raw spellings cannot multiply the API budget',async()=>{
  const {send}=harness();
  for(let i=0;i<API_LIMIT.limit;i++)assert.equal((await send(apiTargets[i%apiTargets.length],{method:'GET'})).status,200);
  for(const target of apiTargets){
    const answer=await send(target,{method:'GET'});
    assert.equal(answer.status,429,target);
    assert.deepEqual(answer.events,['port'],target+' stopped before Origin, body, session and transaction');
  }
  assert.equal((await send(webhookTargets[1],{origin:null})).status,202,'webhooks keep flowing');
});

test('unparsable targets get 400 before any limiter, session or router work',async()=>{
  const {send,rows}=harness();
  for(const target of ['//','///','//[','//x:99999']){
    const answer=await send(target,{method:'GET'});
    assert.equal(answer.status,400,target);
    assert.equal(answer.body,JSON.stringify({error:'Invalid request target'}));
    assert.deepEqual(answer.events,['port'],target);
  }
  assert.equal(rows.size,0);
});

test('non-pipeline paths stay outside the limiter and the transaction',async()=>{
  const {send}=harness();
  for(const target of ['/','/healthz','//evil/app.js','/webhooks','/api']){
    const answer=await send(target,{method:'GET'});
    assert.deepEqual(answer.keys,[],target);
    assert.ok(!answer.events.some(event=>event.startsWith('tx:')),target);
  }
});

test('once the source budget is spent, valid and unknown tokens get byte-identical 429 answers',async()=>{
  const {send}=harness();
  const valid=await send('/webhooks/tradingview/'+hex,{origin:null}),missing=await send('/webhooks/tradingview/'+unknown,{origin:null});
  assert.equal(valid.status,202);assert.equal(missing.status,404,'before the budget is spent the answers differ');
  for(let i=2;i<WEBHOOK_SOURCE_LIMIT.limit;i++)await send('/webhooks/tradingview/'+i.toString(16).padStart(64,'0'),{origin:null});
  const spentValid=await send('/webhooks/tradingview/'+hex,{origin:null});
  const spentUnknown=await send('/webhooks/tradingview/'+unknown,{origin:null});
  assert.equal(spentValid.status,429);
  assert.deepEqual({status:spentUnknown.status,headers:spentUnknown.headers,body:spentUnknown.body},{status:spentValid.status,headers:spentValid.headers,body:spentValid.body});
  assert.equal(spentValid.body,'{"error":"Request limit reached"}');
  assert.deepEqual(spentValid.headers,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  for(const answer of [spentValid,spentUnknown])assert.deepEqual(answer.events,['port'],'no router work leaks timing or state');
});
test('the machine port answers before the pipeline: no limiter, Origin, session or transaction',async()=>{
  const {send,rows}=harness({portHandles:true});
  const answer=await send('/api/news-windows',{origin:null});
  assert.equal(answer.status,200);assert.deepEqual(answer.events,['port']);assert.equal(rows.size,0);
});
