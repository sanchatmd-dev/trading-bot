import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatcher,json,afterCommitFailureCount} from '../src/postgres/request-dispatch.js';

// QR-2 S3a after-commit hook (RC-Q33; design tests D1 to D4). The real dispatcher; the database, router and market runner are recording
// fakes, as in test/request-dispatch.test.js. The hook is res.phase2AfterCommit: at most one, run after COMMIT and after the answer.
const conflict=code=>Object.assign(new Error('could not serialize access'),{code});

function rig({handleRequest,runMarketDeferred=async fn=>fn()}){
  const events=[],audits=[],state={inTransaction:false};
  const dispatch=createDispatcher({
    newsWindowsPort:{handle:async()=>false},
    requestLimits:async()=>true,
    auth:{checkOrigin(){},async prepareSession(){}},
    database:{transaction:async(fn,{isolation})=>{
      events.push('begin:'+isolation);state.inTransaction=true;
      try{const value=await fn();events.push('commit');return value;}
      catch(error){events.push('rollback');throw error;}
      finally{state.inTransaction=false;}
    }},
    store:{audit:async(...args)=>{audits.push(args[3]);}},
    preloadJson:async()=>{},
    handleRequest:async(req,res)=>{events.push('route');return handleRequest(req,res,{events,state});},
    runMarketDeferred:async fn=>{events.push('deferred');return runMarketDeferred(fn);},
    pause:async()=>{events.push('pause');},
    warn:()=>{}
  });
  const send=async(url='/api/paper-performance?bot_id=b',method='GET')=>{
    const headers=new Map();
    const res={headersSent:false,status:null,written:null,body:null,phase2Buffer:false,
      setHeader(name,value){headers.set(name.toLowerCase(),value);},getHeader(name){return headers.get(name.toLowerCase());},removeHeader(name){headers.delete(name.toLowerCase());},
      getHeaders(){return Object.fromEntries(headers);},getHeaderNames(){return [...headers.keys()];},
      writeHead(status,extra){this.status=status;this.written={...Object.fromEntries(headers),...extra};this.headersSent=true;events.push('writeHead');},
      end(body){this.body=body===undefined?'':String(body);events.push('end');}};
    const req={url,method,headers:{},socket:{remoteAddress:'127.0.0.1'}};
    await dispatch(req,res);
    return {req,res,events:[...events],audits:[...audits]};
  };
  return {send,events,state};
}

// A route in the shape of the QR-2 route: the deferred answers, then registers the after-commit function.
const qr2Route=(hook,{answer={status:200,body:{ok:true}}}={})=>async(req,res)=>{
  res.phase2Deferred=async()=>{res.phase2AfterCommit=hook;return answer;};
};

test('D1 the hook runs once, after COMMIT and after the answer has ended',async()=>{
  const seen=[];
  const {send}=rig({handleRequest:qr2Route(()=>{seen.push('hook');})});
  const {res,events}=await send();
  assert.equal(res.status,200);assert.equal(res.body,JSON.stringify({ok:true}));
  assert.deepEqual(seen,['hook']);
  assert.deepEqual(events,['begin:SERIALIZABLE','route','commit','deferred','writeHead','end'],'the answer is written after the deferred phase');
  const probe=rig({handleRequest:(req,res)=>{res.phase2Deferred=async()=>{res.phase2AfterCommit=()=>probe.events.push('hook');return {status:200,body:{}};};}});
  const run=await probe.send();
  assert.deepEqual(run.events.slice(0,2).concat(run.events.slice(-3)),['begin:SERIALIZABLE','route','writeHead','end','hook'],'hook is the last step');
  assert.ok(run.events.indexOf('commit')<run.events.indexOf('hook'));
  assert.ok(run.events.indexOf('end')<run.events.indexOf('hook'));
  assert.equal(run.res.phase2AfterCommit,null,'the field is cleared after the run');
});

test('D1 no hook after a rollback, a failed attempt or an exhausted retry; a retry runs the hook of the final attempt only',async()=>{
  const seen=[];
  // Rollback by a plain error: the route registered a hook in phase 1 and then failed.
  const failing=rig({handleRequest:async(req,res)=>{res.phase2AfterCommit=()=>seen.push('stale-failed');throw Object.assign(new Error('bad input'),{status:400});}});
  const failed=await failing.send();
  assert.equal(failed.res.status,400);assert.deepEqual(seen,[]);assert.equal(failed.res.phase2AfterCommit,null);
  // Persistent serialization failure: three attempts, then 409; no hook ever runs.
  const exhausted=rig({handleRequest:async(req,res)=>{res.phase2AfterCommit=()=>seen.push('stale-exhausted');throw conflict('40001');}});
  const gone=await exhausted.send();
  assert.equal(gone.res.status,409);assert.deepEqual(seen,[]);
  // One 40001, then success: the first attempt's hook is dropped, the final attempt's hook runs once.
  let attempts=0;
  const retried=rig({handleRequest:async(req,res)=>{
    attempts++;
    if(attempts===1){res.phase2AfterCommit=()=>seen.push('attempt-1');throw conflict('40001');}
    res.phase2Deferred=async()=>{res.phase2AfterCommit=()=>seen.push('attempt-2');return {status:200,body:{attempt:attempts}};};
  }});
  const ok=await retried.send();
  assert.equal(ok.res.status,200);assert.deepEqual(seen,['attempt-2']);
  assert.equal(ok.events.filter(e=>e==='commit').length,1);assert.equal(ok.events.filter(e=>e==='rollback').length,1);
  // A hook registered by an earlier attempt is gone even when the final attempt registers none.
  let n=0;const quiet=rig({handleRequest:async(req,res)=>{n++;if(n===1){res.phase2AfterCommit=()=>seen.push('ghost');throw conflict('40P01');}json(res,200,{n});}});
  const q=await quiet.send();
  assert.equal(q.res.status,200);assert.deepEqual(seen,['attempt-2']);
});

test('D2 a throwing or rejecting hook changes no status, body or header, adds one count, writes no audit row and leaves no unhandled rejection',async()=>{
  const unhandled=[];const listener=reason=>unhandled.push(reason);
  process.on('unhandledRejection',listener);
  try{
    const plain=await rig({handleRequest:qr2Route(()=>{})}).send();
    for(const [name,hook] of [['throw',()=>{throw new Error('boom SQL text C:/secret/path');}],['reject',()=>Promise.reject(new Error('boom async'))],['async throw',async()=>{throw Object.assign(new Error('x'),{code:'40001'});}],['throw null',()=>{throw null;}]]){
      const before=afterCommitFailureCount();
      const result=await rig({handleRequest:qr2Route(hook)}).send();
      assert.equal(result.res.status,plain.res.status,name);assert.equal(result.res.body,plain.res.body,name);
      assert.deepEqual(result.res.written,plain.res.written,name+': headers');
      assert.equal(afterCommitFailureCount(),before+1,name+': counted once');
      assert.deepEqual(result.audits,[],name+': no request.error audit row');
      assert.equal(result.events.filter(e=>e==='end').length,1,name+': one answer');
    }
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
  }finally{process.off('unhandledRejection',listener);}
});

test('D3 the hook never runs on the error path; a refusal answer from the deferred phase is an ordinary answer',async()=>{
  const seen=[];
  // A deferred refusal (no hook registered) answers 503 and runs nothing.
  const refused=rig({handleRequest:(req,res)=>{res.phase2Deferred=async()=>({status:503,body:{code:'QR2_REPORT_FAILED'}});}});
  const r=await refused.send();assert.equal(r.res.status,503);assert.deepEqual(seen,[]);
  // The route throws after setting the field in the same attempt: nothing runs.
  const thrown=rig({handleRequest:async(req,res)=>{res.phase2AfterCommit=()=>seen.push('thrown');throw new Error('late failure');}});
  const t=await thrown.send();
  assert.equal(t.res.status,400);assert.deepEqual(seen,[]);
  assert.equal(t.audits.length,1,'the usual single request.error row');
  // Root ruling QR-2 S3a round 2: a hook registered before the deferred function threw is cleared and never runs.
  const deferredThrow=rig({handleRequest:(req,res)=>{res.phase2Deferred=async()=>{res.phase2AfterCommit=()=>seen.push('deferred-threw');throw new Error('x');};},
    runMarketDeferred:async fn=>{try{return await fn();}catch{return {status:503,body:{code:'MARKET_PROXY_FAILED'}};}}});
  const d=await deferredThrow.send();
  assert.equal(d.res.status,503);
  assert.deepEqual(seen,[],'a throwing deferred function clears the hook');
  assert.equal(d.res.phase2AfterCommit,null);
});

test('D4 the hook runs outside any transaction and only one function runs; a non-function value is ignored',async()=>{
  let inside=null;const state={};
  const r=rig({handleRequest:qr2Route(()=>{inside=state.ref.inTransaction;})});
  state.ref=r.state;
  const result=await r.send();
  assert.equal(result.res.status,200);assert.equal(inside,false,'no transaction context while the hook runs');
  // At most one: a later assignment replaces the earlier one.
  const calls=[];
  const two=rig({handleRequest:(req,res)=>{res.phase2Deferred=async()=>{res.phase2AfterCommit=()=>calls.push('first');res.phase2AfterCommit=()=>calls.push('second');return {status:200,body:{}};};}});
  await two.send();
  assert.deepEqual(calls,['second']);
  // A value that is not a function is cleared and ignored; the answer is unchanged.
  const junk=rig({handleRequest:(req,res)=>{res.phase2Deferred=async()=>{res.phase2AfterCommit='not a function';return {status:200,body:{ok:1}};};}});
  const j=await junk.send();
  assert.equal(j.res.status,200);assert.equal(j.res.phase2AfterCommit,null);
  // A request that sets no hook behaves exactly as before: no extra step, no count.
  const before=afterCommitFailureCount();
  const none=await rig({handleRequest:(req,res)=>{json(res,200,{plain:true});}}).send('/api/bots');
  assert.equal(none.res.body,JSON.stringify({plain:true}));assert.equal(afterCommitFailureCount(),before);
  assert.deepEqual(none.events,['begin:SERIALIZABLE','route','commit','writeHead','end']);
});
