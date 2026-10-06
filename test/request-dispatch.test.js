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

const apiTargets=['/api/bots','//evil/api/bots','http://localhost/api/bots','http://evil.example/api/bots','/webhooks/../api/bots','/./api/bots','/%2e%2e/api/bots','/\\evil/api/bots','/x/..\\api/bots'];
const webhookTargets=['/webhooks/tradingview/'+hex,'//evil/webhooks/tradingview/'+hex,'http://localhost/webhooks/tradingview/'+hex,'/./webhooks/tradingview/'+hex,'/x/../webhooks/tradingview/'+hex,'/%2e%2e/webhooks/tradingview/'+hex,'/api/../webhooks/tradingview/'+hex,'/x/..\\webhooks/tradingview/'+hex,'/\\evil/webhooks/tradingview/'+hex];

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

// Bare dispatcher with scripted router and transaction, for the error mapping and the deferred market answer.
function bare({handleRequest,runMarketDeferred=async()=>null,audit=async()=>{}}){
  const events=[],audits=[];
  const dispatch=createDispatcher({
    newsWindowsPort:{handle:async()=>false},
    requestLimits:async()=>true,
    auth:{checkOrigin(){},async prepareSession(){}},
    database:{transaction:async(fn,{isolation})=>{events.push('begin:'+isolation);try{const value=await fn();events.push('commit');return value;}catch(error){events.push('rollback');throw error;}}},
    store:{audit:async(...args)=>{audits.push(args[3]);return audit(...args);}},
    preloadJson:async()=>{},
    handleRequest:async(req,res)=>{events.push('route');return handleRequest(req,res,events);},
    runMarketDeferred:async deferred=>{events.push('deferred');return runMarketDeferred(deferred);}
  });
  const send=async(url='/api/bots')=>{
    const headers=new Map();
    const res={headersSent:false,status:null,written:null,body:null,phase2Buffer:false,
      setHeader(name,value){headers.set(name.toLowerCase(),value);},getHeader(name){return headers.get(name.toLowerCase());},removeHeader(name){headers.delete(name.toLowerCase());},
      writeHead(status,extra){this.status=status;this.written={...Object.fromEntries(headers),...extra};this.headersSent=true;},
      end(body){this.body=body===undefined?'':String(body);}};
    await dispatch({url,method:'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}},res);
    return {res,events:[...events],audits:[...audits]};
  };
  return {send};
}

test('catch mapping: retryable SQLSTATEs become 409 RETRY_TRANSACTION',async()=>{
  for(const code of ['40001','40P01','55P03']){
    const {res,events,audits}=await bare({handleRequest:async()=>{throw Object.assign(new Error('could not serialize access'),{code});}}).send();
    assert.equal(res.status,409,code);
    assert.equal(res.body,JSON.stringify({error:'Concurrent update; retry the request',code:'RETRY_TRANSACTION'}),code);
    assert.deepEqual(events,['begin:SERIALIZABLE','route','rollback'],code);
    assert.deepEqual(audits,[{message:'Concurrent request rolled back'}],code);
  }
});

test('catch mapping: other SQLSTATEs become 503 without database detail',async()=>{
  for(const code of ['23505','42P01','08006','XX000']){
    const {res,audits}=await bare({handleRequest:async()=>{throw Object.assign(new Error('duplicate key value violates unique constraint users_email_key'),{code});}}).send();
    assert.equal(res.status,503,code);
    assert.equal(res.body,JSON.stringify({error:'Request could not be completed'}),code);
    assert.deepEqual(audits,[{message:'Database request failed'}],code);
  }
});

test('catch mapping: error.status and an application code pass through; a plain error is 400',async()=>{
  let answer=(await bare({handleRequest:async()=>{throw Object.assign(new Error('Bot access denied'),{status:403,code:'BOT_DENIED'});}}).send()).res;
  assert.equal(answer.status,403);assert.equal(answer.body,JSON.stringify({error:'Bot access denied',code:'BOT_DENIED'}));
  answer=(await bare({handleRequest:async()=>{throw Object.assign(new Error('Too many'),{status:429});}}).send()).res;
  assert.equal(answer.status,429);assert.equal(answer.body,JSON.stringify({error:'Too many'}));
  const plain=await bare({handleRequest:async()=>{throw new Error('Invalid risk policy');}}).send();
  assert.equal(plain.res.status,400);assert.equal(plain.res.body,JSON.stringify({error:'Invalid risk policy'}));
  assert.deepEqual(plain.audits,[{message:'Request validation failed'}]);
});

test('catch mapping: set-cookie and phase-2 buffering never leak into the error answer; a failed audit does not block it',async()=>{
  const {res}=await bare({
    handleRequest:async(req,res)=>{res.setHeader('set-cookie','session=new');json(res,200,{issued:true});throw Object.assign(new Error('late conflict'),{code:'40001'});},
    audit:async()=>{throw new Error('audit down');}
  }).send();
  assert.equal(res.phase2Buffer,false,'buffering is reset');
  assert.equal(res.status,409,'the buffered 200 is discarded');
  assert.equal(res.written['set-cookie'],undefined,'no cookie from the rolled-back work');
  assert.equal(res.body,JSON.stringify({error:'Concurrent update; retry the request',code:'RETRY_TRANSACTION'}));
});

test('a deferred market answer runs after COMMIT and replaces the buffered result',async()=>{
  const deferred={kind:'market'};let seen=null;
  const {res,events}=await bare({
    handleRequest:async(req,res)=>{json(res,200,{buffered:true});res.phase2Deferred=deferred;},
    runMarketDeferred:async value=>{seen=value;return {status:200,body:{market:true}};}
  }).send('/api/market/ohlcv');
  assert.deepEqual(events,['begin:SERIALIZABLE','route','commit','deferred']);
  assert.equal(seen,deferred);assert.equal(res.phase2Deferred,null);
  assert.equal(res.status,200);assert.equal(res.body,JSON.stringify({market:true}));
  const buffered=await bare({handleRequest:async(req,res)=>{json(res,201,{buffered:true});}}).send();
  assert.deepEqual(buffered.events,['begin:SERIALIZABLE','route','commit'],'no deferred call without a deferred answer');
  assert.equal(buffered.res.status,201);assert.equal(buffered.res.body,JSON.stringify({buffered:true}));
  const failed=await bare({handleRequest:async(req,res)=>{res.phase2Deferred=deferred;},runMarketDeferred:async()=>{throw Object.assign(new Error('upstream'),{status:502});}}).send();
  assert.deepEqual(failed.events,['begin:SERIALIZABLE','route','commit','deferred']);
  assert.equal(failed.res.status,502,'a failing market call answers after COMMIT, never rolls it back');
});
