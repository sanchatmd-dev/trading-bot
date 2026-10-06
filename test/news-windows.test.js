import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {NEWS_WINDOWS_PATH,NEWS_WINDOW_LIMITS,bearerMatches,createNewsWindowsPort,loadWindows,newsRiskFor,parseNewsFeedToken,pruneWindows,saveWindows,
  validateWindows,windowsCover} from '../src/postgres/news-windows.js';
import {evaluateRisk} from '../src/postgres/risk.js';

const NOW=Date.UTC(2026,9,2,12,0,0),MIN=60000,HOUR=3600000,DAY=86400000;
const sha=text=>createHash('sha256').update(text).digest('hex');
const TOKEN='feed-token-'+'x'.repeat(40);
const win=(start,end,extra={})=>({start_ms:start,end_ms:end,source:'ai-feed',label:'CPI',...extra});
const invalid=(body,pattern,now=NOW)=>assert.throws(()=>validateWindows(body,now),error=>{
  assert.equal(error.code,'INVALID_NEWS_WINDOWS');assert.equal(error.status,400);if(pattern)assert.match(error.message,pattern);return true;
});

// Settings store stand-in: getSetting/setSetting as the real Store, plus audit and a transaction wrapper that can fail.
function fakeStore({failAudit=false}={}){
  const settings=new Map(),audits=[],log=[];
  const store={settings,audits,log,
    getSetting:async(key,fallback)=>settings.has(key)?JSON.parse(settings.get(key)):fallback,
    setSetting:async(key,value)=>{log.push('set');settings.set(key,JSON.stringify(value));},
    audit:async(...entry)=>{log.push('audit');if(failAudit)throw new Error('audit failed');audits.push(entry);},
    db:{transaction:async fn=>{const before=new Map(settings);try{return await fn();}catch(error){settings.clear();for(const [k,v] of before)settings.set(k,v);throw error;}}}};
  return store;
}

test('validateWindows: a valid set is sorted and returned as stored; expired entries are pruned and counted',()=>{
  const out=validateWindows({windows:[win(NOW+2*HOUR,NOW+3*HOUR,{label:'NFP'}),win(NOW+HOUR,NOW+90*MIN),win(NOW-3*DAY,NOW-2*DAY),win(NOW-2*DAY,NOW-DAY-1)]},NOW);
  assert.deepEqual(out.windows.map(item=>item.label),['CPI','NFP']);assert.equal(out.pruned,2);
  assert.deepEqual(out.windows[0],{start_ms:NOW+HOUR,end_ms:NOW+90*MIN,source:'ai-feed',label:'CPI'});
  // Exactly one day past the end is still kept; the label is optional.
  assert.equal(validateWindows({windows:[{start_ms:NOW-DAY-HOUR,end_ms:NOW-DAY,source:'s'}]},NOW).windows[0].label,'');
  assert.deepEqual(validateWindows({windows:[]},NOW),{windows:[],pruned:0},'an empty set clears every window');
  assert.deepEqual(NEWS_WINDOW_LIMITS,{maxWindows:50,maxDurationMs:DAY,maxFutureMs:7*DAY,pruneAfterMs:DAY});
});

test('validateWindows: bounds are 50 windows, 24 hours each, end after start, end within 7 days; everything else is refused',()=>{
  assert.equal(validateWindows({windows:Array.from({length:50},(_,i)=>win(NOW+i*HOUR,NOW+i*HOUR+MIN))},NOW).windows.length,50);
  invalid({windows:Array.from({length:51},(_,i)=>win(NOW+i*HOUR,NOW+i*HOUR+MIN))},/At most 50/);
  assert.equal(validateWindows({windows:[win(NOW,NOW+DAY)]},NOW).windows.length,1);
  invalid({windows:[win(NOW,NOW+DAY+1)]},/longer than 24 hours/);
  invalid({windows:[win(NOW,NOW)]},/end_ms must be after/);invalid({windows:[win(NOW+HOUR,NOW)]},/end_ms must be after/);
  assert.equal(validateWindows({windows:[win(NOW+7*DAY-HOUR,NOW+7*DAY)]},NOW).windows.length,1);
  invalid({windows:[win(NOW+7*DAY-HOUR,NOW+7*DAY+1)]},/more than 7 days/);
  for(const bad of [NaN,Infinity,1.5,'1700000000000',null,0,-5,2**60])invalid({windows:[win(bad,NOW+HOUR)]},/start_ms and end_ms/);
  for(const bad of [NaN,1.5,'x',null,0,-1])invalid({windows:[win(NOW,bad)]},/start_ms and end_ms/);
  for(const source of [undefined,'',5,'a'.repeat(65),'bad\nsource',null])invalid({windows:[{start_ms:NOW,end_ms:NOW+MIN,source}]},/source/);
  for(const label of [5,'a'.repeat(121),'bad\u0007label',null])invalid({windows:[win(NOW,NOW+MIN,{label})]},/label/);
  assert.equal(validateWindows({windows:[win(NOW,NOW+MIN,{label:'a'.repeat(120)})]},NOW).windows.length,1);
  for(const body of [null,[],'x',5,{},{windows:'x'},{windows:{}},{windows:[],extra:1},{window:[]}])invalid(body,/body must be/);
  for(const item of [null,[],'x',5,win(NOW,NOW+MIN,{extra:true}),{...win(NOW,NOW+MIN),id:'x'}])invalid({windows:[item]},/windows\[0\]/);
  // One bad entry rejects the whole set (all or nothing) and names its index.
  invalid({windows:[win(NOW,NOW+MIN),win(NOW,NOW)]},/windows\[1\]/);
});

test('windowsCover is half open and pruneWindows drops entries more than a day past their end',()=>{
  const list=[win(1000,2000)];
  assert.equal(windowsCover(list,999),false);assert.equal(windowsCover(list,1000),true);assert.equal(windowsCover(list,1999),true);assert.equal(windowsCover(list,2000),false);
  for(const at of [NaN,undefined,null,'1500',Infinity])assert.equal(windowsCover(list,at),false,String(at));
  assert.equal(windowsCover([],1500),false);
  assert.deepEqual(pruneWindows([win(NOW-DAY-2,NOW-DAY-1),win(NOW-DAY-1,NOW-DAY),win(NOW,NOW+1)],NOW).length,2);
});

test('stored windows are read fail-open: anything unreadable counts as no window, expired entries are left out',async()=>{
  const store=fakeStore();
  assert.deepEqual(await loadWindows(store,NOW),[]);
  for(const stored of [null,5,'x',[],{},{windows:'x'},{windows:{}},{version:1,windows:null}]){
    store.settings.set('news_windows',JSON.stringify(stored));
    assert.deepEqual(await loadWindows(store,NOW),[],JSON.stringify(stored));
  }
  store.settings.set('news_windows',JSON.stringify({version:1,updated_at:1,windows:[win(NOW,NOW+HOUR),{start_ms:'x'},null,win(NOW,NOW-1),win(NOW-5*DAY,NOW-4*DAY)]}));
  assert.deepEqual((await loadWindows(store,NOW)).map(item=>item.start_ms),[NOW],'bad and expired entries are skipped, the good one is kept');
  // A window further out than 7 days (written when it was valid) is still readable: only new input is bounded by the future limit.
  store.settings.set('news_windows',JSON.stringify({version:1,windows:[win(NOW+8*DAY,NOW+8*DAY+HOUR)]}));
  assert.equal((await loadWindows(store,NOW)).length,1);
  // Round trip through the same setting key the store already has.
  await saveWindows(store,[win(NOW,NOW+HOUR)],NOW);
  assert.deepEqual(JSON.parse(store.settings.get('news_windows')),{version:1,updated_at:NOW,windows:[win(NOW,NOW+HOUR)]});
});

test('newsRiskFor: true only when a window covers the bar_time, else a real false; the time of receipt is only a fallback',async()=>{
  const store=fakeStore();
  assert.equal(await newsRiskFor(store,{barTime:NOW,receivedAt:NOW,now:NOW}),false,'no window: false, never missing');
  await saveWindows(store,[win(NOW-MIN,NOW+MIN)],NOW);
  assert.equal(await newsRiskFor(store,{barTime:NOW,receivedAt:NOW,now:NOW}),true);
  assert.equal(await newsRiskFor(store,{barTime:NOW+MIN,receivedAt:NOW,now:NOW}),false,'the window is half open');
  assert.equal(await newsRiskFor(store,{barTime:NOW-2*MIN,receivedAt:NOW,now:NOW}),false,'bar_time wins over the time of receipt');
  assert.equal(await newsRiskFor(store,{barTime:NOW,receivedAt:NOW+HOUR,now:NOW}),true,'bar_time wins in the other direction too');
  for(const barTime of [undefined,null,NaN,'x'])assert.equal(await newsRiskFor(store,{barTime,receivedAt:NOW,now:NOW}),true,'fallback to the time of receipt: '+String(barTime));
  assert.equal(await newsRiskFor(store,{barTime:undefined,receivedAt:NOW+HOUR,now:NOW}),false);
  assert.equal(await newsRiskFor(store,{barTime:NaN,receivedAt:NaN,now:NOW}),false);
  assert.equal(typeof await newsRiskFor(store),'boolean');
});

test('window to risk: a BUY inside the window is rejected, an EXIT passes, and trading resumes by itself after the window',async()=>{
  const store=fakeStore(),policy={maxRiskPercent:5,maxOrderNotional:100000,maxDailyNotional:500000,maxTradesPerDay:10,maxDailyLossR:3,maxOpenPositions:3,
    onePositionPerSymbol:false,pauseAfterLossStreak:3,maxSignalAgeSeconds:3600,maxVolatilityPercent:5,blockHighVolatility:false,blockDuringNews:true,
    sideMode:'BOTH',requireReduceOnlySell:true,allowedSymbols:[]};
  await saveWindows(store,[win(NOW,NOW+30*MIN)],NOW);
  const buy=async(time)=>({tradeId:'b'+time,broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',timestamp:time,riskMode:'PERCENT_EQUITY',
    riskValue:1,referencePrice:100,stopLoss:90,takeProfit:120,leverage:1,volatilityPercent:0,newsRisk:await newsRiskFor(store,{barTime:time,now:time})});
  const context=(time,extra={})=>({policy,daily:{trades:0,notional:'0',realized_r:'0',loss_streak:0},position:{quantity:'0'},equity:'10000',licensed:true,
    globalKill:false,openPositions:0,hasPendingOrder:false,now:time,...extra});
  const inside=await buy(NOW+10*MIN),during=evaluateRisk(inside,context(NOW+10*MIN));
  assert.equal(inside.newsRisk,true);assert.equal(during.ok,false);assert.equal(during.reason,'News trading block is active');
  const exit={tradeId:'x',broker:'binance-global',symbol:'BTCUSDT',event:'SELL',side:'SELL',orderType:'MARKET',timestamp:NOW+10*MIN,riskMode:'QUANTITY',quantity:'1',
    referencePrice:105,leverage:1,reduceOnly:true,volatilityPercent:0,newsRisk:true};
  assert.equal(evaluateRisk(exit,context(NOW+10*MIN,{position:{quantity:'1'}})).ok,true,'EXIT is never news-blocked');
  const after=await buy(NOW+31*MIN);
  assert.equal(after.newsRisk,false);assert.equal(evaluateRisk(after,context(NOW+31*MIN)).ok,true,'the same bot trades again; no Resume is needed');
  const before=await buy(NOW-MIN);
  assert.equal(before.newsRisk,false);assert.equal(evaluateRisk(before,context(NOW-MIN)).ok,true);
  // A bot whose switch is off ignores the window.
  assert.equal(evaluateRisk(inside,context(NOW+10*MIN,{policy:{...policy,blockDuringNews:false}})).ok,true);
});

test('NEWS_FEED_TOKEN_SHA256: unset or blank leaves the port off; anything else must be 64 hex characters',()=>{
  for(const value of [undefined,null,'','   '])assert.equal(parseNewsFeedToken(value),null);
  const digest=parseNewsFeedToken(sha(TOKEN));
  assert.equal(digest.length,32);assert.equal(digest.toString('hex'),sha(TOKEN));
  assert.equal(parseNewsFeedToken('  '+sha(TOKEN).toUpperCase()+'\n').toString('hex'),sha(TOKEN),'case and surrounding space do not matter');
  for(const bad of ['abc',sha(TOKEN).slice(1),sha(TOKEN)+'0','z'.repeat(64),'0x'+sha(TOKEN).slice(2),sha(TOKEN).slice(0,63)+' ',TOKEN])
    assert.throws(()=>parseNewsFeedToken(bad),/Invalid NEWS_FEED_TOKEN_SHA256: expected 64 hexadecimal characters/,bad.slice(0,20));
});

test('bearerMatches: only Authorization: Bearer <token> whose sha256 matches; nothing else is read',()=>{
  const digest=parseNewsFeedToken(sha(TOKEN)),req=headers=>({headers});
  assert.equal(bearerMatches(req({authorization:'Bearer '+TOKEN}),digest),true);
  assert.equal(bearerMatches(req({authorization:'bearer '+TOKEN}),digest),true,'the scheme is case-insensitive');
  for(const header of [undefined,'','Bearer','Bearer ','Bearer  '+TOKEN,'Bearer '+TOKEN+' extra',' Bearer '+TOKEN,'Basic '+TOKEN,TOKEN,'Bearer '+TOKEN+'x','Bearer '+TOKEN.slice(1),
    'Bearer '+TOKEN.toUpperCase(),'Bearer a'.repeat(300)])
    assert.equal(bearerMatches(req({authorization:header}),digest),false,String(header).slice(0,30));
  assert.equal(bearerMatches({headers:{cookie:'session='+TOKEN,'x-api-key':TOKEN}},digest),false,'cookies and other headers never authenticate');
  assert.equal(bearerMatches({headers:{}},digest),false);assert.equal(bearerMatches({},digest),false);
  // A digest of the empty string must not let a request without a token in.
  const empty=parseNewsFeedToken(sha(''));
  assert.equal(bearerMatches(req({}),empty),false);assert.equal(bearerMatches(req({authorization:'Bearer '}),empty),false);
});

// ---- The machine port behind a real socket. The pipeline after it answers 404 like any unknown route. ----
async function withPort({store=fakeStore(),digest=parseNewsFeedToken(sha(TOKEN)),limit=null,now=()=>NOW},run){
  const port=createNewsWindowsPort({store,digest,limit,now});
  const pipeline=[];
  const server=http.createServer(async(req,res)=>{
    if(await port.handle(req,res))return;
    pipeline.push(req.method+' '+req.url);
    res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'Not found'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(method,path=NEWS_WINDOWS_PATH,{token=TOKEN,body,headers={},raw}={})=>{
    const response=await fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined||raw!==undefined?{'content-type':'application/json'}:{}),...headers},
      body:raw!==undefined?raw:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();let json=null;try{json=JSON.parse(text);}catch{/* not JSON */}
    return {status:response.status,body:json,text,headers:response.headers};
  };
  try{await run({call,store,port,pipeline,address:server.address()});}finally{await new Promise(resolve=>server.close(resolve));}
}

test('port disabled: no token digest means the port never answers; the request runs through the pipeline like any unknown route',async()=>{
  await withPort({digest:null},async({call,port,pipeline,store})=>{
    assert.equal(port.enabled,false);
    for(const [method,token] of [['GET',TOKEN],['POST',TOKEN],['GET',null],['DELETE',null]]){
      const answer=await call(method,NEWS_WINDOWS_PATH,{token,...(method==='POST'?{body:{windows:[]}}:{})});
      assert.equal(answer.status,404,method);assert.deepEqual(answer.body,{error:'Not found'});
    }
    const unknown=await call('GET','/api/system/other-route',{token:null});
    assert.deepEqual([unknown.status,unknown.body],[404,{error:'Not found'}],'the same answer as a route that never existed');
    assert.equal(pipeline.length,5,'every request, including the port path, reached the normal pipeline');
    assert.deepEqual(store.log,[],'nothing was read or written');
  });
});

test('port enabled: only its own path is taken; everything else passes through untouched',async()=>{
  await withPort({},async({call,pipeline})=>{
    assert.equal((await call('GET','/api/system/news-windows/extra')).status,404);
    assert.equal((await call('GET','/api/system/news-window')).status,404);
    assert.equal((await call('GET','/api/bots',{token:null})).status,404);
    assert.deepEqual(pipeline,['GET /api/system/news-windows/extra','GET /api/system/news-window','GET /api/bots']);
    assert.equal((await call('GET','/api/system/news-windows?x=1')).status,200,'a query string does not change the path');
  });
});

test('port auth: Bearer sha256 only; wrong, missing, malformed tokens and cookies get 401 before anything is read',async()=>{
  await withPort({},async({call,store})=>{
    for(const [name,options] of [['no token',{token:null}],['wrong token',{token:TOKEN+'x'}],['basic scheme',{token:null,headers:{authorization:'Basic '+TOKEN}}],
      ['cookie only',{token:null,headers:{cookie:'robot_session='+TOKEN}}],['token in query',{token:null}]]){
      for(const method of ['GET','POST']){
        const path=name==='token in query'?NEWS_WINDOWS_PATH+'?token='+TOKEN:NEWS_WINDOWS_PATH;
        const answer=await call(method,path,{...options,...(method==='POST'?{body:{windows:[]}}:{})});
        assert.equal(answer.status,401,name+' '+method);assert.deepEqual(answer.body,{error:'Unauthorized'});
        assert.equal(answer.headers.get('www-authenticate'),'Bearer');assert.equal(answer.headers.get('cache-control'),'no-store');
      }
    }
    assert.equal((await call('DELETE',NEWS_WINDOWS_PATH,{token:null})).status,401,'auth comes before the method check');
    assert.deepEqual(store.log,[],'an unauthorized request reads and writes nothing');
  });
});

test('port GET and POST: POST replaces the whole set atomically, GET returns it, an audit row carries counts only',async()=>{
  await withPort({},async({call,store})=>{
    assert.deepEqual((await call('GET')).body,{windows:[],count:0,updated_at:null});
    const first=await call('POST',NEWS_WINDOWS_PATH,{body:{windows:[win(NOW+2*HOUR,NOW+3*HOUR,{label:'Fed decision'}),win(NOW+HOUR,NOW+90*MIN),win(NOW-3*DAY,NOW-2*DAY)]}});
    assert.equal(first.status,200);assert.equal(first.body.count,2);assert.equal(first.body.updated_at,NOW);
    assert.deepEqual(first.body.windows.map(item=>item.label),['CPI','Fed decision'],'sorted by start, the expired entry pruned');
    assert.equal(first.headers.get('cache-control'),'no-store');assert.match(first.headers.get('content-type'),/^application\/json/);
    assert.deepEqual((await call('GET')).body,first.body);
    // A second POST replaces the first completely.
    const second=await call('POST',NEWS_WINDOWS_PATH,{body:{windows:[win(NOW+4*HOUR,NOW+5*HOUR,{source:'manual',label:''})]}});
    assert.deepEqual((await call('GET')).body.windows,[{start_ms:NOW+4*HOUR,end_ms:NOW+5*HOUR,source:'manual',label:''}]);assert.equal(second.body.count,1);
    // An empty set clears every window.
    assert.deepEqual((await call('POST',NEWS_WINDOWS_PATH,{body:{windows:[]}})).body.windows,[]);
    assert.equal(store.audits.length,3);
    assert.deepEqual(store.audits[0],[null,'news_windows.updated',null,{received:3,stored:2,pruned:1}]);
    assert.deepEqual(store.audits[1].slice(1),['news_windows.updated',null,{received:1,stored:1,pruned:0}]);
    assert.ok(!JSON.stringify(store.audits).includes('Fed decision')&&!JSON.stringify(store.audits).includes('ai-feed'),'counts only: no label or source in the audit');
  });
});

test('port validation: a bad body changes nothing and the answer names the problem',async()=>{
  await withPort({},async({call,store})=>{
    await call('POST',NEWS_WINDOWS_PATH,{body:{windows:[win(NOW,NOW+HOUR)]}});
    const before=JSON.stringify([...store.settings]),audits=store.audits.length;
    const many=Array.from({length:51},(_,i)=>win(NOW+i*MIN*2,NOW+i*MIN*2+MIN));
    const cases=[[{windows:[win(NOW,NOW+DAY+1)]},/longer than 24 hours/],[{windows:[win(NOW+HOUR,NOW)]},/after start_ms/],
      [{windows:[win(NOW,NOW+HOUR),{start_ms:'x'}]},/windows\[1\]/],[{windows:many},/At most 50/],
      [{windows:[],extra:1},/body must be/],[{windows:'x'},/body must be/],[{},/body must be/]];
    for(const [body,pattern] of cases){
      const answer=await call('POST',NEWS_WINDOWS_PATH,{body});
      assert.equal(answer.status,400,JSON.stringify(body).slice(0,60));assert.equal(answer.body.code,'INVALID_NEWS_WINDOWS');assert.match(answer.body.error,pattern);
    }
    assert.equal(JSON.stringify([...store.settings]),before,'the previous set is untouched');assert.equal(store.audits.length,audits);
    assert.equal((await call('GET')).body.count,1);
  });
});

test('port transport rules: JSON content type, JSON object body, size limit and methods',async()=>{
  await withPort({},async({call,store})=>{
    assert.equal((await call('POST',NEWS_WINDOWS_PATH,{raw:'{"windows":[]}',headers:{'content-type':'text/plain'}})).status,415);
    assert.equal((await call('POST',NEWS_WINDOWS_PATH,{raw:'{"windows":[]}',headers:{'content-type':'application/json; charset=utf-8'}})).status,200);
    for(const raw of ['{','[]','"x"','null','5']){
      const answer=await call('POST',NEWS_WINDOWS_PATH,{raw});
      assert.deepEqual([answer.status,answer.body.code],[400,'INVALID_JSON'],raw);
    }
    const big=await call('POST',NEWS_WINDOWS_PATH,{raw:JSON.stringify({windows:[],pad:'x'.repeat(40000)})});
    assert.equal(big.status,413);assert.equal(big.body.code,'PAYLOAD_TOO_LARGE');
    for(const method of ['PUT','PATCH','DELETE']){
      const answer=await call(method);assert.equal(answer.status,405,method);assert.equal(answer.headers.get('allow'),'GET, POST');
    }
    assert.equal(store.audits.length,1,'only the one valid POST was audited');
  });
});

test('port failures: a failed audit rolls the whole replacement back; a store failure is 503; the rate limit answers 429 first',async()=>{
  const failing=fakeStore({failAudit:true});
  await withPort({store:failing},async({call})=>{
    const answer=await call('POST',NEWS_WINDOWS_PATH,{body:{windows:[win(NOW,NOW+HOUR)]}});
    assert.equal(answer.status,503);assert.deepEqual(answer.body,{error:'Request could not be completed'});
    assert.equal(failing.settings.size,0,'the set was not stored without its audit row (one transaction)');
  });
  const broken=fakeStore();broken.getSetting=async()=>{throw new Error('db down');};
  await withPort({store:broken},async({call})=>{assert.equal((await call('GET')).status,503);});
  const calls=[];
  await withPort({limit:async req=>{calls.push(req.method);return false;}},async({call,store})=>{
    const answer=await call('GET',NEWS_WINDOWS_PATH,{token:null});
    assert.equal(answer.status,429);assert.deepEqual(answer.body,{error:'Request limit reached'});assert.deepEqual(calls,['GET']);assert.deepEqual(store.log,[]);
  });
});

// ---- Startup: the real server entry point, with no database configured. ----
function startServer(env){
  const clean={...process.env};
  for(const key of ['DATABASE_URL','TEST_DATABASE_URL','PINE_BRIDGE_AI_QUOTA','NEWS_FEED_TOKEN_SHA256'])delete clean[key];
  return spawnSync(process.execPath,[fileURLToPath(new URL('../src/postgres/server.js',import.meta.url))],{env:{...clean,...env},encoding:'utf8',timeout:90000});
}

test('startup: a malformed NEWS_FEED_TOKEN_SHA256 stops the server before any database work; unset, blank or valid passes this check',()=>{
  for(const value of ['abc','z'.repeat(64),sha(TOKEN)+'00']){
    const run=startServer({NEWS_FEED_TOKEN_SHA256:value});
    assert.notEqual(run.status,0,value.slice(0,12));
    assert.match(run.stderr,/Invalid NEWS_FEED_TOKEN_SHA256: expected 64 hexadecimal characters/);
    assert.doesNotMatch(run.stderr,/DATABASE_URL is required/,'the check comes before the database');
  }
  for(const env of [{},{NEWS_FEED_TOKEN_SHA256:''},{NEWS_FEED_TOKEN_SHA256:sha(TOKEN)}]){
    const run=startServer(env);
    assert.doesNotMatch(run.stderr,/Invalid NEWS_FEED_TOKEN_SHA256/);assert.match(run.stderr,/DATABASE_URL is required/);
  }
});

test('the source keeps its promises: no cookie or session read, no Origin bypass in the shared pipeline, port answered before the pipeline',()=>{
  const port=fs.readFileSync(new URL('../src/postgres/news-windows.js',import.meta.url),'utf8');
  assert.ok(!/cookie|session|checkOrigin/i.test(port.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,'')),'the port code never reads a cookie or session');
  // The shared pipeline lives in request-dispatch.js; the router stays in server.js.
  const server=fs.readFileSync(new URL('../src/postgres/server.js',import.meta.url),'utf8');
  const dispatch=fs.readFileSync(new URL('../src/postgres/request-dispatch.js',import.meta.url),'utf8');
  assert.equal((server+dispatch).split('auth.checkOrigin(req)').length-1,2,'the Origin check of the shared pipeline is unchanged');
  assert.ok(dispatch.indexOf('newsWindowsPort.handle(req,res)')>0&&dispatch.indexOf('newsWindowsPort.handle(req,res)')<dispatch.indexOf('const pathname=requestPathname(req.url)'),'the port runs before the transactional pipeline');
});

test('port enabled: a malformed request target never crashes the server; the pipeline answers it and the port keeps working',async()=>{
  await withPort({},async({call,port,pipeline,address})=>{
    for(const target of ['//','///','//[','//x:99999'])assert.equal(await port.handle({url:target,method:'GET',headers:{}},null),false,target);
    // fetch would normalize the target, so send it byte for byte on a raw socket.
    const net=await import('node:net');const CRLF=String.fromCharCode(13,10);
    const raw=await new Promise((resolve,reject)=>{
      const socket=net.connect(address.port,'127.0.0.1',()=>socket.end('GET // HTTP/1.1'+CRLF+'Host: localhost'+CRLF+'Connection: close'+CRLF+CRLF));
      let data='';socket.on('data',chunk=>data+=chunk);socket.on('end',()=>resolve(data));socket.on('error',reject);
    });
    assert.ok(raw.startsWith('HTTP/1.1 404 '),'the normal pipeline answered the malformed target');
    assert.deepEqual(pipeline,['GET //']);
    const after=await call('GET');
    assert.equal(after.status,200,'the server is still up and the port still answers');
  });
});
