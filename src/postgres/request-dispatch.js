import {requestPathname} from './request-limits.js';

export const json = (res, status, body) => {
  if(res.phase2Buffer){res.phase2Result={status,body};return;}
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
};

// The shared request pipeline. Transaction, limiter, Origin check and isolation all follow the
// canonical pathname the router dispatches on, so no raw-target spelling can skip them.
export function createDispatcher({newsWindowsPort,requestLimits,auth,database,store,preloadJson,handleRequest,runMarketDeferred}) {
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
      res.phase2Buffer=true;
      await database.transaction(()=>handleRequest(req,res),{isolation:webhook?'READ COMMITTED':'SERIALIZABLE'});
      res.phase2Buffer=false;
      // A market proxy answer runs here, after COMMIT: no database connection or snapshot is held during network I/O.
      const deferred=res.phase2Deferred;res.phase2Deferred=null;
      const result=deferred?await runMarketDeferred(deferred):res.phase2Result;
      if(result)json(res,result.status,result.body);
    }catch(error){
      res.phase2Buffer=false;res.removeHeader('set-cookie');
      const retry=['40001','40P01','55P03'].includes(error.code);
      const internal=error.code&&/^[0-9A-Z]{5}$/.test(error.code);
      await store.audit(null,'request.error',null,{message:retry?'Concurrent request rolled back':internal?'Database request failed':'Request validation failed'}).catch(()=>{});
      if(!res.headersSent)json(res,error.status||(retry?409:internal?503:400),{error:retry?'Concurrent update; retry the request':internal?'Request could not be completed':error.message,...(retry?{code:'RETRY_TRANSACTION'}:error.code&&!internal?{code:error.code}:{})});
    }
  };
}