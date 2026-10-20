import {requestPathname} from './request-limits.js';
import {quantOptimizeOutcome,QuantOptimizeDisconnected,quantOptimizeDisconnected} from './quant-optimize-transport.js';

export const json = (res, status, body) => {
  if(res.phase2Buffer){res.phase2Result={status,body};return;}
  // 304 Not Modified carries no body; the validator header was set by the route.
  if(status===304){res.writeHead(304,{'cache-control':'no-store'});res.end();return;}
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
};

// A serialization failure or deadlock rolls the whole attempt back and nothing has been answered yet, so an API request
// may run again on a fresh snapshot. 55P03 (lock not available) is a policy answer, never retried.
const RETRY_SQLSTATES=['40001','40P01'];
export const RETRY_LIMIT=2;
// No retry once the next pause would end later than this many milliseconds after the first attempt began.
export const RETRY_BUDGET_MS=2000;
// The pause lasts at least one worker interval (config.workerIntervalMs): a request that lost to a worker's row update would
// otherwise meet the same backlog again at once. The 20-80 ms jitter spreads colliding requests apart.
export const retryDelay=(random=Math.random,intervalMs=0)=>intervalMs+20+Math.floor(random()*61);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const monotonic=()=>performance.now();
// The legacy Quant Lab proxy calls its upstream engine inside the request transaction; a rerun would repeat that call.
export const LEGACY_QUANT_PATHS=new Set(['/api/quant/health','/api/quant/backtest','/api/quant/optimize','/api/quant/risk-preview']);
// Authentication, login, recovery and MFA keep their single attempt: they consume one-time tokens and limiter buckets.
const retryablePath=pathname=>pathname.startsWith('/api/')&&pathname!=='/api/auth'&&!pathname.startsWith('/api/auth/')&&!LEGACY_QUANT_PATHS.has(pathname);
// Failures of the after-commit function since process start; for tests and health. No path, user or key is kept.
let afterCommitFailures=0;
export const afterCommitFailureCount=()=>afterCommitFailures;
const disconnected=(req,res)=>res.destroyed===true||req.socket?.destroyed===true;

// Work that must count once per request, not once per attempt: a limiter bucket or a market admission. Later attempts of
// the same request get the first attempt's result. A rejected promise is dropped, so the next attempt runs the work again.
const requestOnce=new WeakMap();
export function oncePerRequest(req,key,run){
  let memo=requestOnce.get(req);
  if(!memo)requestOnce.set(req,memo=new Map());
  if(!memo.has(key)){
    const value=run();
    memo.set(key,value);
    if(typeof value?.then==='function')value.then(null,()=>{if(memo.get(key)===value)memo.delete(key);});
  }
  return memo.get(key);
}

const headerSnapshot=res=>Object.entries(res.getHeaders()).map(([name,value])=>[name,Array.isArray(value)?[...value]:value]);
// Each attempt starts from the state the first one saw: no buffered answer, no deferred market call, no after-commit function, no outbound call, the
// response headers the request had before its first attempt, and no cached authentication, so the session, CSRF token and
// step-up are checked again on the new snapshot.
function resetAttempt(req,res,headers){
  res.phase2Buffer=true;res.phase2Result=null;res.phase2Deferred=null;res.phase2External=false;res.phase2AfterCommit=null;
  const kept=new Set(headers.map(([name])=>name));
  for(const name of res.getHeaderNames())if(!kept.has(name))res.removeHeader(name);
  for(const [name,value] of headers)res.setHeader(name,Array.isArray(value)?[...value]:value);
  delete req.authUser;delete req.authToken;delete req.validateAuth;delete req.sensitiveChecked;
}

// The shared request pipeline. Transaction, limiter, Origin check and isolation all follow the
// canonical pathname the router dispatches on, so no raw-target spelling can skip them.
// A route sets res.phase2External=true before any outbound call made inside the transaction; that attempt is never rerun.
export function createDispatcher({newsWindowsPort,requestLimits,auth,database,store,preloadJson,handleRequest,runMarketDeferred,
  workerIntervalMs=0,pause=sleep,clock=monotonic,warn=console.warn}) {
  // The longest pause is the interval plus 80 ms of jitter. Past the budget, retry is effectively off: say so once here.
  if(workerIntervalMs+80>=RETRY_BUDGET_MS)warn(`API request retry is effectively off: a ${workerIntervalMs} ms worker interval plus up to 80 ms jitter exceeds the ${RETRY_BUDGET_MS} ms retry budget`);
  return async(req,res)=>{
    // Machine port first: no cookie, session or Origin check applies to it. It answers only its own path and only while enabled.
    try{if(await newsWindowsPort.handle(req,res))return;}
    catch{if(!res.headersSent)json(res,503,{ok:false,error:'Service unavailable'});return;}
    const pathname=requestPathname(req.url);
    if(pathname===null)return json(res,400,{error:'Invalid request target'});
    const api=pathname.startsWith('/api/'),webhook=pathname.startsWith('/webhooks/');
    if(!api&&!webhook){try{return await handleRequest(req,res);}catch{if(!res.headersSent)json(res,503,{ok:false,error:'Service unavailable'});return;}}
    try{
      // Database buckets are shared across API replicas; outside the request transaction so failed requests count too.
      if(!await requestLimits(req,pathname))return json(res,429,{error:'Request limit reached'});
      if(api)auth.checkOrigin(req);
      if(!['GET','HEAD','OPTIONS'].includes(req.method))await preloadJson(req);
      await auth.prepareSession(req);
      // Limiter, Origin check, body and session touch above run once per request; only the transaction repeats.
      const retryable=retryablePath(pathname),headers=headerSnapshot(res),started=clock();
      for(let attempt=0;;attempt++){
        resetAttempt(req,res,headers);
        try{await database.transaction(()=>handleRequest(req,res),{isolation:webhook?'READ COMMITTED':'SERIALIZABLE'});break;}
        catch(error){
          if(!retryable||attempt>=RETRY_LIMIT||!RETRY_SQLSTATES.includes(error?.code)||res.phase2External===true||res.headersSent||disconnected(req,res))throw error;
          const delay=retryDelay(Math.random,workerIntervalMs);
          if(clock()-started+delay>RETRY_BUDGET_MS)throw error;
          // Attempt number and SQLSTATE only: no path, user, body or cookie reaches the log.
          warn(`API request attempt ${attempt+1} rolled back with SQLSTATE ${error.code}; retrying`);
          await pause(delay);
          if(res.headersSent||disconnected(req,res))throw error;
        }
      }
      res.phase2Buffer=false;
      // A market proxy answer runs here, after COMMIT: no database connection or snapshot is held during network I/O.
      const deferred=res.phase2Deferred;res.phase2Deferred=null;
      // A deferred function that throws leaves no after-commit function behind, even when the wrapper turns the throw into an answer.
      const guarded=typeof deferred==='function'?async()=>{try{return await deferred();}catch(deferredError){res.phase2AfterCommit=null;throw deferredError;}}:deferred;
      const result=deferred?await runMarketDeferred(guarded):res.phase2Result;
      if(pathname==='/api/quant/optimize'&&req.quantOptimizeAttempt&&quantOptimizeDisconnected(req,res))return;
      if(result)json(res,result.status,result.body);
      // QR-2 after-commit function (RC-Q33): at most one, run only here, after COMMIT and after the answer is sent, outside any transaction.
      // A throw or a rejection is counted and never changes the answer, writes no audit row and logs nothing.
      const afterCommit=res.phase2AfterCommit;res.phase2AfterCommit=null;
      if(typeof afterCommit==='function'){try{await afterCommit();}catch{afterCommitFailures++;}}
    }catch(error){
      // A handler may throw null or a non-object; the answer must still go out instead of the catch itself throwing.
      if(error===null||typeof error!=='object')error=new Error('Request failed');
      // An error answer never carries a cookie, a validator or deferred work from the rolled-back attempts.
      // Only the final failure reaches here, so one request writes at most one request.error row.
      res.phase2Buffer=false;res.phase2Deferred=null;res.phase2AfterCommit=null;
      if(!res.headersSent){res.removeHeader('set-cookie');res.removeHeader('etag');}
      // Only our internal pre-attempt cancellation skips the audit and response; the transaction has rolled back.
      if(pathname==='/api/quant/optimize'&&error instanceof QuantOptimizeDisconnected&&!req.quantOptimizeAttempt&&quantOptimizeDisconnected(req,res))return;
      const retry=['40001','40P01','55P03'].includes(error.code);
      const internal=error.code&&/^[0-9A-Z]{5}$/.test(error.code);
      await store.audit(null,'request.error',null,{message:retry?'Concurrent request rolled back':internal?'Database request failed':'Request validation failed'}).catch(()=>{});
      const outcome=pathname==='/api/quant/optimize'?quantOptimizeOutcome(req.quantOptimizeAttempt):null;
      if(outcome){if(!res.headersSent&&!quantOptimizeDisconnected(req,res))json(res,503,outcome);return;}
      if(!res.headersSent)json(res,error.status||(retry?409:internal?503:400),{error:retry?'Concurrent update; retry the request':internal?'Request could not be completed':error.message,...(retry?{code:'RETRY_TRANSACTION'}:error.code&&!internal?{code:error.code}:{})});
    }
  };
}
