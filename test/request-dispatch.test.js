import test from 'node:test';
import {readFileSync} from 'node:fs';
import {legacyQuantDenied} from '../src/quant-research/legacy-admission.js';
import {quantOptimizeOutcome,QuantOptimizeDisconnected,requireQuantOptimizeConnection} from '../src/postgres/quant-optimize-transport.js';
import assert from 'node:assert/strict';
import {clientIp} from '../src/http-safety.js';
import {createRequestLimits,API_LIMIT,WEBHOOK_SOURCE_LIMIT} from '../src/postgres/request-limits.js';
import {Readable} from 'node:stream';
import {createDispatcher,json,RETRY_LIMIT,RETRY_BUDGET_MS,LEGACY_QUANT_PATHS,oncePerRequest,retryDelay} from '../src/postgres/request-dispatch.js';
import {preloadJson,readJson} from '../src/postgres/http.js';
import {readJson as readStream} from '../src/http-safety.js';
import {marketOhlcvRoutes} from '../src/postgres/market-ohlcv.js';
import {Auth} from '../src/postgres/auth.js';

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
      end(body){this.body=body===undefined?'':String(body);},removeHeader(){},setHeader(){},getHeaders(){return {};},getHeaderNames(){return [];}};
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
function bare({handleRequest,runMarketDeferred=async()=>null,audit=async()=>{},auth={checkOrigin(){},async prepareSession(){}},onPause=()=>{},
  preload=async()=>{},workerIntervalMs,clock,onCommit=async()=>{}}){
  const events=[],audits=[],pauses=[],steps=[],warnings=[];
  const dispatch=createDispatcher({
    newsWindowsPort:{handle:async()=>false},
    requestLimits:async()=>{steps.push('limit');return true;},
    auth:{checkOrigin(req){steps.push('origin');return auth.checkOrigin(req);},async prepareSession(req){steps.push('session');return auth.prepareSession(req);}},
    database:{transaction:async(fn,{isolation})=>{events.push('begin:'+isolation);try{const value=await fn();await onCommit();events.push('commit');return value;}catch(error){events.push('rollback');throw error;}}},
    store:{audit:async(...args)=>{audits.push(args[3]);return audit(...args);}},
    preloadJson:async req=>{steps.push('preload');return preload(req);},
    handleRequest:async(req,res)=>{events.push('route');return handleRequest(req,res,events);},
    runMarketDeferred:async deferred=>{events.push('deferred');return runMarketDeferred(deferred);},
    pause:async ms=>{pauses.push(ms);events.push('pause');onPause();},
    workerIntervalMs,clock,warn:line=>warnings.push(line)
  });
  const send=async(url='/api/bots',{method='GET',request={},preset={}}={})=>{
    const headers=new Map(Object.entries(preset));
    // Like Node's ServerResponse, header changes after writeHead throw ERR_HTTP_HEADERS_SENT.
    const sent=()=>{if(res.headersSent)throw Object.assign(new Error('Cannot change headers after they are sent'),{code:'ERR_HTTP_HEADERS_SENT'});};
    const res={headersSent:false,status:null,written:null,body:null,phase2Buffer:false,
      setHeader(name,value){sent();headers.set(name.toLowerCase(),value);},getHeader(name){return headers.get(name.toLowerCase());},removeHeader(name){sent();headers.delete(name.toLowerCase());},
      getHeaders(){return Object.fromEntries(headers);},getHeaderNames(){return [...headers.keys()];},
      writeHead(status,extra){this.status=status;this.written={...Object.fromEntries(headers),...extra};this.headersSent=true;},
      end(body){this.body=body===undefined?'':String(body);}};
    const req=request instanceof Readable?Object.assign(request,{url,method,headers:{},socket:{remoteAddress:'127.0.0.1'}}):{url,method,headers:{},socket:{remoteAddress:'127.0.0.1'},...request};
    await dispatch(req,res);
    return {req,res,events:[...events],steps:[...steps],audits:[...audits],pauses:[...pauses],warnings:[...warnings]};
  };
  return {send};
}
const conflict=code=>Object.assign(new Error('could not serialize access'),{code});
const attempt=['begin:SERIALIZABLE','route','rollback'];

test('catch mapping: a retryable SQLSTATE that persists becomes one 409 RETRY_TRANSACTION after the last attempt',async()=>{
  for(const code of ['40001','40P01']){
    const {res,events,steps,audits,pauses}=await bare({handleRequest:async()=>{throw conflict(code);}}).send();
    assert.equal(res.status,409,code);
    assert.equal(res.body,JSON.stringify({error:'Concurrent update; retry the request',code:'RETRY_TRANSACTION'}),code);
    assert.deepEqual(events,[...attempt,'pause',...attempt,'pause',...attempt],code+': three attempts');
    assert.deepEqual(steps,['limit','origin','session'],code+': the request steps run once');
    assert.equal(pauses.length,RETRY_LIMIT,code);
    assert.deepEqual(audits,[{message:'Concurrent request rolled back'}],code+': one audit row for the request');
  }
  // 55P03 (lock not available) is mapped the same way but never retried.
  const {res,events,audits}=await bare({handleRequest:async()=>{throw conflict('55P03');}}).send();
  assert.equal(res.status,409);assert.equal(JSON.parse(res.body).code,'RETRY_TRANSACTION');
  assert.deepEqual(events,attempt);
  assert.deepEqual(audits,[{message:'Concurrent request rolled back'}]);
});

test('capital declaration: exhausted serialization/deadlock returns 503 Retry-After 2; other methods, paths and 55P03 keep existing status',async()=>{
  for(const code of ['40001','40P01']){
    const {res,pauses}=await bare({handleRequest:async()=>{throw conflict(code);}}).send('/api/paper-capital-model',{method:'PUT'});
    assert.equal(res.status,503);assert.equal(res.written['retry-after'],'2');
    assert.equal(JSON.parse(res.body).code,'RETRY_TRANSACTION');assert.equal(pauses.length,RETRY_LIMIT);
  }
  for(const [path,method,code] of [['/api/paper-capital-model','GET','40001'],['/api/paper-capital-model-other','PUT','40001'],['/api/paper-capital-model','PUT','55P03']]){
    const {res}=await bare({handleRequest:async()=>{throw conflict(code);}}).send(path,{method});
    assert.equal(res.status,409);assert.equal(res.written['retry-after'],undefined);
  }
});

test('retry: one serialization failure then success answers 200 with no audit row',async()=>{
  let attempts=0;
  const {res,events,steps,audits,pauses}=await bare({handleRequest:async(req,res)=>{if(++attempts===1)throw conflict('40001');json(res,200,{attempt:attempts});}}).send('/api/quant/data/jobs/x',{method:'POST'});
  assert.equal(res.status,200);assert.equal(res.body,JSON.stringify({attempt:2}));
  assert.deepEqual(events,[...attempt,'pause','begin:SERIALIZABLE','route','commit']);
  assert.deepEqual(steps,['limit','origin','preload','session'],'limiter, Origin, body and session run once');
  assert.equal(events.filter(event=>event.startsWith('begin:')).length,2);
  assert.equal(events.filter(event=>event==='rollback').length,1);assert.equal(events.filter(event=>event==='commit').length,1);
  assert.deepEqual(audits,[]);
  assert.equal(pauses.length,1);
});

test('retry: the jitter stays between 20 and 80 ms',()=>{
  assert.equal(retryDelay(()=>0),20);assert.equal(retryDelay(()=>0.999999),80);
  assert.equal(retryDelay(()=>0,250),270,'the worker interval comes first');assert.equal(retryDelay(()=>0.999999,250),330);
  for(let i=0;i<200;i++){const ms=retryDelay();assert.ok(Number.isInteger(ms)&&ms>=20&&ms<=80,String(ms));}
});

test('retry: authentication paths, webhooks and non-retryable errors keep a single attempt',async()=>{
  for(const url of ['/api/auth/login','/api/auth/mfa/verify','/api/auth','/api/../api/auth/login']){
    const {res,events,audits}=await bare({handleRequest:async()=>{throw conflict('40001');}}).send(url,{method:'POST'});
    assert.equal(res.status,409,url);
    assert.equal(events.filter(event=>event.startsWith('begin:')).length,1,url);
    assert.equal(audits.length,1,url);
  }
  const webhook=await bare({handleRequest:async()=>{throw conflict('40001');}}).send('/webhooks/tradingview/'+hex,{method:'POST'});
  assert.equal(webhook.res.status,409);
  assert.deepEqual(webhook.events,['begin:READ COMMITTED','route','rollback']);
  assert.deepEqual(webhook.steps,['limit','preload','session']);
  for(const error of [conflict('23505'),Object.assign(new Error('Bot access denied'),{status:403}),new Error('plain')]){
    const {events}=await bare({handleRequest:async()=>{throw error;}}).send();
    assert.equal(events.filter(event=>event.startsWith('begin:')).length,1,String(error.code||error.status||'plain'));
  }
});

test('retry: a failed attempt leaks no cookie, validator or buffered answer, and adds no duplicate cookie',async()=>{
  let attempts=0;
  const {res}=await bare({handleRequest:async(req,res)=>{
    attempts++;
    res.setHeader('set-cookie',[...(res.getHeader('set-cookie')||[]),'robot_session=attempt'+attempts]);
    if(attempts===1){res.setHeader('etag','"stale"');json(res,200,{attempt:1});throw conflict('40001');}
    json(res,200,{attempt:attempts});
  }}).send();
  assert.equal(res.status,200);assert.equal(res.body,JSON.stringify({attempt:2}));
  assert.deepEqual(res.written['set-cookie'],['robot_session=attempt2'],'only the committed attempt sets a cookie');
  assert.equal(res.written.etag,undefined,'the rolled-back validator is gone');
});

test('retry: a failed attempt\'s deferred market call never runs',async()=>{
  const seen=[];let attempts=0;
  const first={kind:'first'},second={kind:'second'};
  const {res,events}=await bare({
    handleRequest:async(req,res)=>{attempts++;res.phase2Deferred=attempts===1?first:second;if(attempts===1)throw conflict('40001');},
    runMarketDeferred:async value=>{seen.push(value);return {status:200,body:{market:value.kind}};}
  }).send('/api/market/ohlcv');
  assert.deepEqual(seen,[second]);assert.equal(events.filter(event=>event==='deferred').length,1);
  assert.equal(res.body,JSON.stringify({market:'second'}));
  let failed=0;
  const exhausted=await bare({
    handleRequest:async(req,res)=>{res.phase2Deferred=first;throw conflict('40001');},
    runMarketDeferred:async()=>{failed++;return null;}
  }).send('/api/market/ohlcv');
  assert.equal(failed,0,'no deferred call after the final failure');assert.equal(exhausted.res.status,409);
  assert.equal(exhausted.res.phase2Deferred,null);
});

test('retry: each attempt starts without cached authentication or a buffered result',async()=>{
  const seen=[];let attempts=0;
  await bare({handleRequest:async(req,res)=>{
    attempts++;
    seen.push({authUser:req.authUser,authToken:req.authToken,validateAuth:req.validateAuth,sensitiveChecked:req.sensitiveChecked,
      buffer:res.phase2Buffer,result:res.phase2Result,deferred:res.phase2Deferred,sessionAlive:req.sessionAlive});
    req.authUser={id:'cached'};req.authToken='t';req.validateAuth=async()=>{};req.sensitiveChecked=true;
    json(res,200,{attempt:attempts});res.phase2Deferred={kind:'stale'};
    if(attempts<3)throw conflict('40P01');
    res.phase2Deferred=null;
  },auth:{checkOrigin(){},async prepareSession(req){req.sessionAlive=true;}}}).send();
  assert.equal(seen.length,3);
  for(const state of seen)assert.deepEqual(state,{authUser:undefined,authToken:undefined,validateAuth:undefined,sensitiveChecked:undefined,
    buffer:true,result:null,deferred:null,sessionAlive:true},'the session touch result stays; nothing from the failed attempt does');
});

test('retry: authentication re-runs on every attempt, so a revocation between attempts answers 401',async()=>{
  const token='e'.repeat(64),config={secureCookies:false,sessionIdleMinutes:30,publicOrigin:ORIGIN};
  let session={id:'u1',email:'u1@example.test',role:'USER',status:'ACTIVE',parent_user_id:null,
    expires_at:Date.now()+3600000,last_seen:Date.now(),elevated_until:0,mfa_verified:0};
  const reads=[],deleted=[];
  const db={prepare:()=>({get:async()=>{reads.push(session?.id??null);return session;}})};
  const auth=new Auth({db,deleteSession:async value=>{deleted.push(value);}},config,json);
  let attempts=0;
  const {res}=await bare({
    auth:{checkOrigin(){},async prepareSession(req){req.sessionAlive=true;}},
    handleRequest:async(req,res)=>{
      attempts++;
      const user=await auth.require(req);
      if(attempts===1){session=null;throw conflict('40001');}
      json(res,200,{user:user.id});
    }
  }).send('/api/bots',{request:{headers:{cookie:'robot_session='+token}}});
  assert.deepEqual(reads,['u1',null],'the session row is read again on the retry');
  assert.equal(res.status,401,'a session revoked between attempts is refused, never served from the first attempt\'s cache');
  assert.deepEqual(deleted,[token]);
});

test('retry: no retry once headers are sent or the client has gone',async()=>{
  const sent=await bare({handleRequest:async(req,res)=>{res.headersSent=true;throw conflict('40001');}}).send();
  assert.equal(sent.events.filter(event=>event.startsWith('begin:')).length,1,'headers sent');
  assert.equal(sent.audits.length,1);
  for(const gone of [{socket:{remoteAddress:'127.0.0.1',destroyed:true}}]){
    const closed=await bare({handleRequest:async()=>{throw conflict('40001');}}).send('/api/bots',{request:gone});
    assert.equal(closed.events.filter(event=>event.startsWith('begin:')).length,1,'socket closed');
    assert.equal(closed.audits.length,1);
  }
  // The client leaves during the jitter pause: the request stops before the next attempt.
  let attempts=0;const socket={remoteAddress:'127.0.0.1',destroyed:false};
  const left=await bare({handleRequest:async()=>{attempts++;throw conflict('40001');},onPause:()=>{socket.destroyed=true;}}).send('/api/bots',{request:{socket}});
  assert.equal(attempts,1);assert.deepEqual(left.events,[...attempt,'pause']);assert.equal(left.audits.length,1);
  const destroyed=await bare({handleRequest:async(req,res)=>{res.destroyed=true;throw conflict('40001');}}).send();
  assert.equal(destroyed.events.filter(event=>event.startsWith('begin:')).length,1,'response destroyed');
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

const attempts=events=>events.filter(event=>event.startsWith('begin:')).length;

test('retry: the legacy Quant Lab proxy paths keep a single attempt; their read-only run list still retries',async()=>{
  assert.deepEqual([...LEGACY_QUANT_PATHS].sort(),['/api/quant/backtest','/api/quant/health','/api/quant/optimize','/api/quant/risk-preview']);
  for(const url of [...LEGACY_QUANT_PATHS,'/api/x/../quant/optimize']){
    const {res,events,pauses,audits}=await bare({handleRequest:async()=>{throw conflict('40001');}}).send(url,{method:'POST'});
    assert.equal(res.status,409,url);assert.equal(attempts(events),1,url);assert.deepEqual(pauses,[],url);assert.equal(audits.length,1,url);
  }
  let runs=0;
  const list=await bare({handleRequest:async(req,res)=>{if(++runs===1)throw conflict('40001');json(res,200,[]);}}).send('/api/quant/runs');
  assert.equal(list.res.status,200);assert.equal(attempts(list.events),2);
});

test('retry: an attempt that made an outbound call is never rerun; the next request attempt starts with the flag clear',async()=>{
  let upstream=0;
  const {res,events,pauses,audits}=await bare({handleRequest:async(req,res)=>{res.phase2External=true;upstream++;throw conflict('40001');}}).send('/api/bots',{method:'POST'});
  assert.equal(upstream,1,'exactly one attempt');assert.equal(attempts(events),1);assert.deepEqual(pauses,[]);
  assert.equal(res.status,409);assert.equal(JSON.parse(res.body).code,'RETRY_TRANSACTION');assert.equal(audits.length,1);
  const seen=[];let runs=0;
  const clean=await bare({handleRequest:async(req,res)=>{seen.push(res.phase2External);if(++runs===1)throw conflict('40001');json(res,200,{ok:true});}}).send();
  assert.equal(clean.res.status,200);assert.deepEqual(seen,[false,false]);
});

test('retry budget: a slow first attempt is not retried and answers one 409',async()=>{
  let now=1000;
  const {res,events,pauses,audits,warnings}=await bare({clock:()=>now,handleRequest:async()=>{now+=RETRY_BUDGET_MS-19;throw conflict('40001');}}).send();
  assert.equal(attempts(events),1);assert.deepEqual(pauses,[]);assert.deepEqual(warnings,[]);
  assert.equal(res.status,409);assert.equal(res.body,JSON.stringify({error:'Concurrent update; retry the request',code:'RETRY_TRANSACTION'}));
  assert.deepEqual(audits,[{message:'Concurrent request rolled back'}]);
  // The budget counts from the first attempt: a second attempt that would end the pause past it is not started either.
  now=0;let runs=0;
  const second=await bare({clock:()=>now,handleRequest:async()=>{runs++;now+=runs===1?100:RETRY_BUDGET_MS-110;throw conflict('40001');}}).send();
  assert.equal(attempts(second.events),2);assert.equal(second.pauses.length,1);assert.equal(second.res.status,409);
});

test('retry delay: the default worker interval keeps both retries inside the budget',async()=>{
  let runs=0;
  const {res,pauses,events}=await bare({workerIntervalMs:250,handleRequest:async(req,res)=>{if(++runs<3)throw conflict('40P01');json(res,200,{runs});}}).send();
  assert.equal(res.status,200);assert.equal(attempts(events),3);
  assert.equal(pauses.length,2);for(const ms of pauses)assert.ok(ms>=270&&ms<=330,String(ms));
  assert.ok(250+80+250+80<RETRY_BUDGET_MS,'the budget never disables retry at the default interval by itself');
});

test('retry delay: a configured worker interval whose pause exceeds the budget means no retry and one 409',async()=>{
  const {res,events,pauses,audits}=await bare({workerIntervalMs:RETRY_BUDGET_MS,clock:()=>0,handleRequest:async()=>{throw conflict('40001');}}).send();
  assert.equal(attempts(events),1);assert.deepEqual(pauses,[]);
  assert.equal(res.status,409);assert.equal(JSON.parse(res.body).code,'RETRY_TRANSACTION');assert.equal(audits.length,1);
});

test('once per request: a limiter or admission runs on the first attempt only; a rejected run is tried again',async()=>{
  let counted=0,runs=0;
  const {res}=await bare({handleRequest:async(req,res)=>{
    const allowed=await oncePerRequest(req,'password-change',async()=>{counted++;return true;});
    if(++runs===1)throw conflict('40001');
    json(res,allowed?200:429,{runs});
  }}).send('/api/me/password',{method:'POST'});
  assert.equal(res.status,200);assert.equal(runs,2);assert.equal(counted,1,'one limiter count for one request');
  let tries=0;runs=0;
  const again=await bare({handleRequest:async(req,res)=>{
    runs++;
    await oncePerRequest(req,'limit',async()=>{if(++tries===1)throw conflict('40P01');return true;});
    json(res,200,{tries});
  }}).send();
  assert.equal(again.res.status,200);assert.equal(tries,2,'the failed first run is not reused');
  const first={},second={};
  assert.equal(oncePerRequest(first,'k',()=>1),1);assert.equal(oncePerRequest(first,'k',()=>2),1);assert.equal(oncePerRequest(second,'k',()=>3),3);
});

test('market proxy admission counts once for a retried request',async()=>{
  let admitted=0,runs=0;
  const proxy={enabled:true,admit:()=>{admitted++;return {ok:true};},now:()=>Date.now(),
    symbols:async()=>({list:[{symbol:'BTCUSDT'}],retrieved_at:Date.now(),stale:false})};
  const {res,events}=await bare({
    handleRequest:async(req,res)=>{
      await marketOhlcvRoutes(req,res,new URL(req.url,'http://localhost'),null,json,{actor:{id:'u1'},proxy});
      if(++runs===1)throw conflict('40001');
    },
    runMarketDeferred:async fn=>fn()
  }).send('/api/market/symbols');
  assert.equal(runs,2);assert.equal(admitted,1,'one admission for one request');
  assert.equal(events.filter(event=>event==='deferred').length,1);
  assert.equal(res.status,200);assert.equal(JSON.parse(res.body).count,1);
});

const stream=text=>Readable.from([Buffer.from(text,'utf8')]);
test('body reads: an attempt that changes the body leaves the next attempt the body as received',async()=>{
  const seen=[];let runs=0;
  const {res}=await bare({preload:preloadJson,handleRequest:async(req,res)=>{
    const body=await readJson(req);
    seen.push(JSON.stringify(body));
    body.name='changed';body.list.push(4);delete body.keep;
    if(++runs===1)throw conflict('40001');
    json(res,200,{runs});
  }}).send('/api/bots',{method:'POST',request:stream('{"name":"bot","list":[1,2,3],"keep":true}')});
  assert.equal(res.status,200);
  assert.deepEqual(seen,['{"name":"bot","list":[1,2,3],"keep":true}','{"name":"bot","list":[1,2,3],"keep":true}']);
  // Nesting that JSON.parse accepts but structuredClone and JSON.stringify refuse still reads on every attempt.
  const depth=5000,deep='{"a":'+'['.repeat(depth)+']'.repeat(depth)+'}';runs=0;
  const nested=await bare({preload:preloadJson,handleRequest:async(req,res)=>{
    let value=(await readJson(req)).a,levels=0;while(Array.isArray(value)){levels++;value=value[0];}
    if(++runs===1)throw conflict('40001');
    json(res,200,{levels});
  }}).send('/api/bots',{method:'POST',request:stream(deep)});
  assert.equal(nested.res.status,200,nested.res.body);assert.equal(JSON.parse(nested.res.body).levels,depth);
});

test('body reads: preloading keeps http-safety size limits and error answers',async()=>{
  const cases=[['x'.repeat(65537),'/api/bots'],['{"a":"'+'x'.repeat(2*1024*1024)+'"}','/api/quant/pine-bridge/analyze'],
    ['{"a":','/api/bots'],['[1]','/api/bots'],['null','/api/bots'],['','/api/bots']];
  for(const [text,url] of cases){
    const maxBytes=url==='/api/bots'?65536:2*1024*1024;
    const expected=await readStream(stream(text),{maxBytes}).then(value=>({value}),error=>({error:error.message}));
    const req=Object.assign(stream(text),{url,method:'POST'});
    const actual=await preloadJson(req).then(()=>readJson(req)).then(value=>({value}),error=>({error:error.message}));
    assert.deepEqual(actual,expected,url+' '+text.slice(0,12));
  }
  const {res,events,audits}=await bare({preload:preloadJson,handleRequest:async()=>{}}).send('/api/bots',{method:'POST',request:stream('x'.repeat(65537))});
  assert.equal(res.status,400);assert.equal(res.body,JSON.stringify({error:'Payload too large'}));
  assert.deepEqual(events,[],'no transaction for a refused body');assert.deepEqual(audits,[{message:'Request validation failed'}]);
});

test('retry: every header a failed attempt added is gone and earlier headers keep their values',async()=>{
  let runs=0;const written=[];
  const {res}=await bare({
    auth:{checkOrigin(){},async prepareSession(req){req.sessionAlive=true;}},
    handleRequest:async(req,res)=>{
      runs++;written.push(res.getHeaderNames().sort());
      res.setHeader('x-attempt-'+runs,'1');res.setHeader('x-request-base','attempt'+runs);
      if(runs===1){res.setHeader('x-debug','leak');res.setHeader('content-location','/api/stale');throw conflict('40001');}
      json(res,200,{runs});
    }
  }).send();
  assert.equal(res.status,200);
  assert.deepEqual(written,[[],[]],'the second attempt starts with no header from the first');
  assert.equal(res.written['x-attempt-1'],undefined);assert.equal(res.written['x-debug'],undefined);assert.equal(res.written['content-location'],undefined);
  assert.equal(res.written['x-attempt-2'],'1');
  // A header set before the first attempt survives every reset with its original value.
  runs=0;
  const kept=await bare({handleRequest:async(req,res)=>{
    runs++;
    if(runs===1){res.setHeader('x-request-id','changed');res.removeHeader('x-frame-options');throw conflict('40001');}
    json(res,200,{id:res.getHeader('x-request-id'),frame:res.getHeader('x-frame-options')});
  }}).send('/api/bots',{preset:{'x-request-id':'r1','x-frame-options':'DENY'}});
  assert.equal(kept.res.status,200);assert.deepEqual(JSON.parse(kept.res.body),{id:'r1',frame:'DENY'});
  assert.equal(kept.res.written['x-request-id'],'r1');
});

test('final catch: an error after headers were sent neither throws nor touches headers',async()=>{
  const {res,audits}=await bare({handleRequest:async(req,res)=>{res.setHeader('set-cookie','late=1');res.writeHead(200,{});res.end('{}');throw new Error('after send');}}).send('/api/bots',{method:'POST'});
  assert.equal(res.headersSent,true);assert.equal(res.status,200,'the sent answer stands');
  assert.deepEqual(audits,[{message:'Request validation failed'}]);
  await assert.doesNotReject(bare({handleRequest:async(req,res)=>{res.writeHead(200,{});throw conflict('40001');}}).send());
});

test('retry log: one line per retry with the attempt number and SQLSTATE only',async()=>{
  const cookie='robot_session='+'f'.repeat(64);
  const {warnings,res}=await bare({handleRequest:async()=>{throw conflict('40P01');}})
    .send('/api/me/secret-path?email=u1@example.test',{method:'POST',request:{headers:{cookie},body:'{"password":"hunter2"}'}});
  assert.equal(res.status,409);
  assert.deepEqual(warnings,['API request attempt 1 rolled back with SQLSTATE 40P01; retrying','API request attempt 2 rolled back with SQLSTATE 40P01; retrying']);
  for(const line of warnings)for(const secret of ['secret-path','example.test','robot_session','hunter2','/api/'])assert.ok(!line.includes(secret),secret);
  const single=await bare({handleRequest:async()=>{throw conflict('55P03');}}).send();
  assert.deepEqual(single.warnings,[],'no line without a retry');
});

test('final catch: a handler that throws null or a non-object still gets one answer and one audit row',async()=>{
  for(const thrown of [null,undefined,'plain text',42]){
    const label=String(thrown);
    const {res,events,audits,pauses}=await bare({handleRequest:async()=>{throw thrown;}}).send('/api/bots',{method:'POST'});
    assert.equal(res.status,400,label);assert.equal(res.body,JSON.stringify({error:'Request failed'}),label);
    assert.equal(attempts(events),1,label);assert.deepEqual(pauses,[],label);
    assert.deepEqual(audits,[{message:'Request validation failed'}],label);
  }
});

test('retry delay: a worker interval that leaves no pause inside the budget is logged once at creation, without request data',async()=>{
  const off=bare({workerIntervalMs:RETRY_BUDGET_MS-80,handleRequest:async(req,res)=>{json(res,200,{ok:true});}});
  const first=await off.send('/api/me/secret-path',{method:'POST'}),second=await off.send();
  const line='API request retry is effectively off: a '+(RETRY_BUDGET_MS-80)+' ms worker interval plus up to 80 ms jitter exceeds the '+RETRY_BUDGET_MS+' ms retry budget';
  assert.deepEqual(first.warnings,[line]);assert.deepEqual(second.warnings,[line],'once per dispatcher, not per request');
  assert.ok(!line.includes('/api/'));
  for(const workerIntervalMs of [undefined,250,RETRY_BUDGET_MS-81]){
    let runs=0;
    const {warnings,res}=await bare({workerIntervalMs,clock:()=>0,handleRequest:async(req,res)=>{if(++runs===1)throw conflict('40001');json(res,200,{runs});}}).send();
    assert.equal(res.status,200,String(workerIntervalMs));
    assert.deepEqual(warnings,['API request attempt 1 rolled back with SQLSTATE 40001; retrying'],String(workerIntervalMs));
  }
});

for(const code of ['40001','40P01','23514','55P03'])for(const completeResponse of [false,true])for(const rowBearing of [false,true])
test(`optimize ${code} after ${completeResponse?'complete':'unknown'} response, row ${rowBearing}, retains outcome through COMMIT`,async()=>{
  let outbound=0;
  const answer=await bare({handleRequest:async(req,res)=>{
    req.quantOptimizeAttempt={completeResponse,rowBearing};res.phase2External=true;outbound++;
    json(res,completeResponse?200:503,completeResponse?{best:{params:{}}}:quantOptimizeOutcome(req.quantOptimizeAttempt));
  },onCommit:async()=>{throw conflict(code);}}).send('/api/quant/optimize',{method:rowBearing?'POST':'GET'});
  assert.equal(outbound,1);assert.equal(attempts(answer.events),1);assert.deepEqual(answer.pauses,[]);
  assert.equal(answer.res.status,503);assert.deepEqual(JSON.parse(answer.res.body),quantOptimizeOutcome({completeResponse,rowBearing}));
  assert.deepEqual(answer.audits,[{message:['40001','40P01','55P03'].includes(code)?'Concurrent request rolled back':'Database request failed'}]);
  assert.ok(!answer.res.body.includes('RETRY_TRANSACTION'));assert.ok(!answer.res.body.includes('could not serialize'));
  assert.ok(!answer.events.includes('deferred'));
});

test('complete optimize success remains buffered until COMMIT',async()=>{
  let response;
  const result=await bare({handleRequest:async(req,res)=>{
    response=res;req.quantOptimizeAttempt={completeResponse:true,rowBearing:true};res.phase2External=true;json(res,200,{best:{}});
  },onCommit:async()=>{assert.equal(response.headersSent,false);assert.equal(response.body,null);}}).send('/api/quant/optimize',{method:'POST'});
  assert.equal(result.res.status,200);assert.deepEqual(JSON.parse(result.res.body),{best:{}});assert.deepEqual(result.audits,[]);
});

test('optimize outcome mapper remains scoped to exact canonical optimize pathname',async()=>{
  for(const url of ['/api/quant/backtest','/api/quant/health','/api/quant/risk-preview','/api/quant/optimize/']){
    const result=await bare({handleRequest:async(req,res)=>{
      req.quantOptimizeAttempt={completeResponse:true,rowBearing:true};res.phase2External=true;throw conflict('40001');
    }}).send(url);
    assert.equal(result.res.status,409);assert.equal(JSON.parse(result.res.body).code,'RETRY_TRANSACTION');
  }
  const canonical=await bare({handleRequest:async(req,res)=>{
    req.quantOptimizeAttempt={completeResponse:false,rowBearing:false};res.phase2External=true;throw conflict('40001');
  }}).send('/x/../api/quant/optimize?ignored=true');
  assert.equal(JSON.parse(canonical.res.body).code,'QUANT_SUBMISSION_OUTCOME_UNKNOWN');
});

test('only genuine disconnected pre-attempt cancellation suppresses audit and response',async()=>{
  const result=await bare({handleRequest:async(req,res)=>{req.aborted=true;requireQuantOptimizeConnection(req,res);}})
    .send('/api/quant/optimize');
  assert.ok(result.events.includes('rollback'));assert.equal(result.res.status,null);assert.deepEqual(result.audits,[]);
  for(const kind of ['forged code','connected internal','after attempt']){
    const answer=await bare({handleRequest:async(req,res)=>{
      if(kind!=='connected internal')req.aborted=true;
      if(kind==='after attempt'){req.quantOptimizeAttempt={completeResponse:false,rowBearing:true};res.phase2External=true;}
      throw kind==='forged code'?Object.assign(new Error('forged cancellation'),{code:'QUANT_REQUEST_DISCONNECTED'}):new QuantOptimizeDisconnected();
    }}).send('/api/quant/optimize');
    assert.equal(answer.audits.length,1,kind);
    assert.equal(answer.res.status,kind==='after attempt'?null:400,kind);
  }
});

// Exercise the production route body with isolated HTTP/SQL dependencies, without starting the application or engine.
const serverSource=readFileSync(new URL('../src/postgres/server.js',import.meta.url),'utf8');
const bridgeSource=serverSource.slice(serverSource.indexOf('async function quantBridge('),serverSource.indexOf('// Trust only the right-most address'));
assert.ok(bridgeSource.startsWith('async function quantBridge('));
function bridgeFixture({disconnectAt,admission='LEGACY',insertError,updateError,transportError,body={}}={}){
  let outbound=0,inserts=0,updates=0;
  const db={query:async sql=>{
    if(admission==='unreadable')throw new Error('mode read failed');
    if(sql.includes('to_regclass'))return {rows:[{present:admission==='absent table'?null:'quant_research_executor_mode'}]};
    return {rows:admission==='missing singleton'?[]:[{mode:admission}]};
  },prepare:sql=>({run:async()=>{
    if(sql.startsWith('INSERT')){inserts++;if(insertError)throw insertError;if(disconnectAt==='after INSERT')request.aborted=true;}
    if(sql.startsWith('UPDATE')){updates++;if(updateError)throw updateError;}
  }})};
  const route=new Function('legacyQuantDenied','readJson','requestQuantOptimize','requireQuantOptimizeConnection','json','quantPaths','http',
    'return '+bridgeSource)(legacyQuantDenied,async()=>body,async()=>{outbound++;if(disconnectAt==='after attempt')request.aborted=true;if(transportError)throw transportError;return {status:200,body:{best:{params:{}}}};},
    requireQuantOptimizeConnection,json,LEGACY_QUANT_PATHS,{});
  let request;
  const handleRequest=async(req,res)=>{
    request=req;if(disconnectAt==='before INSERT')req.aborted=true;
    try{await route(req,res,new URL(req.url,'http://fixture.test'),{id:'actor'}, {db,ownsBot:async()=>true});}
    catch(error){
      // Match the production route's error boundary; SQLSTATEs and cancellation must reach the dispatcher.
      if(error instanceof QuantOptimizeDisconnected||/^[0-9A-Z]{5}$/.test(error?.code))throw error;
      const outcome=quantOptimizeOutcome(req.quantOptimizeAttempt);
      json(res,503,outcome||{code:error.code,error:'Quant executor mode is unavailable'});
    }
  };
  return {handleRequest,get outbound(){return outbound;},get inserts(){return inserts;},get updates(){return updates;}};
}

for(const disconnectAt of ['before INSERT','after INSERT','after attempt'])test(`production optimize route: disconnect ${disconnectAt}`,async()=>{
  const route=bridgeFixture({disconnectAt});const answer=await bare(route).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,disconnectAt==='after attempt'?1:0);
  assert.equal(route.inserts,disconnectAt==='before INSERT'?0:1);
  assert.equal(route.updates,disconnectAt==='after attempt'?1:0);
  assert.equal(answer.events.includes('rollback'),disconnectAt!=='after attempt');assert.deepEqual(answer.audits,[]);
  assert.equal(answer.res.status,null,'disconnected client receives no response writes');
});
for(const admission of ['FOUNDATION','missing singleton','invalid','unreadable'])test(`production optimize route: ${admission} refuses before external attempt`,async()=>{
  const route=bridgeFixture({admission});const answer=await bare(route).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,0);assert.equal(route.inserts,0);assert.equal(answer.res.status,admission==='FOUNDATION'?409:503);
});
test('production optimize route: intentionally absent mode table retains legacy compatibility',async()=>{
  const route=bridgeFixture({admission:'absent table'});const answer=await bare(route).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,1);assert.equal(route.inserts,1);assert.equal(answer.res.status,200);
});
for(const code of ['40001','40P01','23514','55P03'])test(`production optimize route: INSERT ${code} sends zero; UPDATE ${code} sends once`,async()=>{
  const rejected=bridgeFixture({insertError:conflict(code)}),before=await bare(rejected).send('/api/quant/optimize',{method:'POST'});
  assert.equal(rejected.outbound,0);assert.equal(before.req.quantOptimizeAttempt,undefined);assert.equal(before.audits.length,1);
  const attempted=bridgeFixture({updateError:conflict(code)}),after=await bare(attempted).send('/api/quant/optimize',{method:'POST'});
  assert.equal(attempted.outbound,1);assert.equal(after.res.status,503);assert.equal(JSON.parse(after.res.body).code,'QUANT_RESULT_NOT_RECORDED');assert.equal(after.audits.length,1);
});
test('production optimize route: unknown transport plus failed COMMIT stays unknown',async()=>{
  const route=bridgeFixture({transportError:new Error('upstream lost')});
  const answer=await bare({...route,onCommit:async()=>{throw conflict('40P01');}}).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,1);assert.equal(route.updates,0);assert.equal(answer.res.status,503);
  assert.equal(JSON.parse(answer.res.body).code,'QUANT_SUBMISSION_OUTCOME_UNKNOWN');assert.equal(answer.audits.length,1);
});

test('production optimize route: POST without a runId never claims row persistence failed',async()=>{
  const route=bridgeFixture({body:null});
  const answer=await bare({...route,onCommit:async()=>{throw conflict('40001');}}).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,1);assert.equal(route.inserts,0);assert.equal(answer.res.status,503);
  assert.equal(JSON.parse(answer.res.body).code,'QUANT_REQUEST_NOT_COMPLETED');
});
test('production optimize route: disconnect after attempt never suppresses SQL error audit',async()=>{
  const route=bridgeFixture({disconnectAt:'after attempt',updateError:conflict('40001')});
  const answer=await bare(route).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,1);assert.equal(answer.res.status,null);assert.equal(answer.audits.length,1);
  assert.ok(answer.events.includes('rollback'));assert.deepEqual(answer.pauses,[]);
});
test('production optimize route: upstream cancellation string cannot erase attempted outcome',async()=>{
  const route=bridgeFixture({transportError:Object.assign(new Error('upstream failure'),{code:'QUANT_REQUEST_DISCONNECTED'})});
  const answer=await bare(route).send('/api/quant/optimize',{method:'POST'});
  assert.equal(route.outbound,1);assert.equal(answer.res.status,503);assert.equal(JSON.parse(answer.res.body).code,'QUANT_SUBMISSION_OUTCOME_UNKNOWN');
});
