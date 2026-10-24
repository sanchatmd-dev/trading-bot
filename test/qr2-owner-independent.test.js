import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createQr2Slot,qr2PerformanceRoute} from '../src/postgres/qr2-routes.js';
import {qr2OwnerPerformanceRoute} from '../src/postgres/qr2-owner-route.js';
import {createQr2ComputePool} from '../src/postgres/qr2-compute-pool.js';
import {createDispatcher,json} from '../src/postgres/request-dispatch.js';
import {composeOwnerResponse,validateOwnerResponse} from '../src/portfolio/qr2-owner-response.js';
import {buildCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {QR2_COVERAGE_LIMITS} from '../src/portfolio/qr2-coverage-limits.js';
const NOW=1790899200000,DAY=86400000;
// Zero members and an unresolved owner range: the registry is empty and the body omits market_coverage.
const emptyContext={accounts:[],budgets:{...QR2_COVERAGE_LIMITS}};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function ownerResult(){
  return composeOwnerResponse({kind:'owner',currency:'USDT',ownerBots:[{bot_id:'owner',created_at:NOW-DAY-1}],declarations:[],accounts:[],
    range:{requested:{from:NOW-DAY,to:NOW},resolved:null,reasons:['RANGE_EMPTY_AT_REQUEST_TIME'],flags:[]},
    counts:{accounts:0,bots:1,declarations:0,ledger_rows:0,grid_instants:0,audit_rows:0,pending_orders:0},coverage:buildCoverageSnapshot({...emptyContext,facts:[]})},
  {kind:'owner',currency:'USDT',requestTime:NOW,coverage_context:emptyContext});
}
const store=()=>({userById:async id=>({id,parent_user_id:null,created_at:NOW-DAY-1}),ownsBot:async()=>true,activePlan:async()=> 'ENTERPRISE'});
const response=()=>{const headers={};return {headers,phase2AfterCommit:null,setHeader:(k,v)=>{headers[k]=v;}};};
async function plan(kind,deps,res=response()){
  const path=kind==='owner'?'/api/paper-performance/owner?currency=USDT&period=DAY':'/api/paper-performance?bot_id=owner&period=DAY';
  const route=kind==='owner'?qr2OwnerPerformanceRoute:qr2PerformanceRoute;
  assert.equal(await route({method:'GET',headers:{}},res,new URL('http://fixture'+path),{id:'owner'},
    {store:store(),enabled:true,clock:()=>NOW,json:(_r,status,body)=>{throw new Error('Unexpected phase1 '+status+' '+JSON.stringify(body));},auth:{sensitive:async()=>{}},...deps}),true);
  assert.equal(typeof res.phase2Deferred,'function');return res;
}

test('independent owner and account routes contend on the same actual slot throughout read and compute',async()=>{
  for(const first of ['owner','account']){
    const slot=createQr2Slot(),entered=deferred(),releaseRead=deferred();let reads=0,computes=0;
    const deps={slot,readSnapshot:async()=>{reads++;entered.resolve();await releaseRead.promise;return {snapshot:{kind:'owner',accounts:[{},{}]},input:{kind:'owner'}};},compute:{run:async()=>{computes++;return {ok:true,...ownerResult()};}}};
    const a=await plan(first,deps),work=a.phase2Deferred();await entered.promise;assert.equal(slot.busy,1);
    const b=await plan(first==='owner'?'account':'owner',deps),blocked=await b.phase2Deferred();
    assert.equal(blocked.status,429);assert.equal(blocked.body.code,'QR2_RANGE_ADMISSION_REFUSED');assert.equal(reads,1);assert.equal(computes,0);
    releaseRead.resolve();assert.equal((await work).status,200);assert.equal(slot.busy,0);assert.equal(computes,1);
  }
});

test('independent owner batch timeout holds shared slot until worker termination, then permits account recovery',async()=>{
  const terminationEntered=deferred(),allowTermination=deferred(),messages=[];let spawned=0;
  class FixtureWorker extends EventEmitter{
    constructor(hang){super();this.hang=hang;}
    ref(){}unref(){}
    postMessage(message){messages.push(message);queueMicrotask(()=>{this.emit('message',{type:'ready'});if(!this.hang)this.emit('message',{id:message.id,ok:true,body:{recovered:true},auditFindings:[]});});}
    async terminate(){if(this.hang){terminationEntered.resolve();await allowTermination.promise;}return 0;}
  }
  const pool=createQr2ComputePool({deadlineMs:15,execArgv:[],nodeOptions:'',spawn:()=>new FixtureWorker(++spawned===1)});
  const slot=createQr2Slot(),batch={kind:'owner',accounts:[{fixture:1},{fixture:2},{fixture:3}]};
  const deps={slot,compute:pool,readSnapshot:async()=>({snapshot:batch,input:{kind:'owner'}})};
  try{
    const own=await plan('owner',deps),pending=own.phase2Deferred();await terminationEntered.promise;
    assert.equal(messages.length,1);assert.equal(messages[0].snapshot,batch);assert.equal(messages[0].input.kind,'owner');assert.equal(pool.busy,true);assert.equal(slot.busy,1);
    const account=await plan('account',deps);assert.equal((await account.phase2Deferred()).status,429);assert.equal(messages.length,1);
    allowTermination.resolve();const failed=await pending;assert.equal(failed.status,503);assert.equal(failed.body.code,'QR2_REPORT_FAILED');assert.equal(own.headers['Retry-After'],'2');assert.equal(own.phase2AfterCommit,null);assert.equal(slot.busy,0);
    assert.equal((await account.phase2Deferred()).status,200);assert.equal(spawned,2);assert.equal(pool.counters.timeout,1);
  }finally{allowTermination.resolve();await pool.close();}
});

test('independent owner finding audit runs only after dispatcher commit and response send, audit failure cannot rewrite response',async()=>{
  const order=[],slot=createQr2Slot();let inside=false;const headers={};
  const res={headersSent:false,getHeaders:()=>headers,getHeaderNames:()=>Object.keys(headers),setHeader:(k,v)=>{headers[k]=v;},removeHeader:k=>{delete headers[k];},
    writeHead(status){this.statusCode=status;this.headersSent=true;order.push('send-head');},end(text){this.body=JSON.parse(text);order.push('send-body');}};
  const db={transaction:async body=>{inside=true;try{await body();}finally{inside=false;}order.push('commit');}};
  const finding={botId:'owner',broker:'binance-global',check:'R3',event_key:'PRIVATE_EVENT_SENTINEL',code:'RECONCILIATION_FAILED'};
  const dispatch=createDispatcher({newsWindowsPort:{handle:async()=>false},requestLimits:async()=>true,auth:{checkOrigin(){},prepareSession:async()=>{}},database:db,store:{audit:async()=>{}},preloadJson:async()=>{},runMarketDeferred:body=>body(),warn:()=>{},
    handleRequest:async(req,response)=>qr2OwnerPerformanceRoute(req,response,new URL('http://fixture'+req.url),{id:'owner'},
      {store:store(),enabled:true,slot,json,clock:()=>NOW,readSnapshot:async()=>{assert.equal(inside,false);order.push('read');return {snapshot:{kind:'owner'},input:{kind:'owner'}};},compute:{run:async()=>({ok:true,...ownerResult(),auditFindings:[finding]})},
        writeAudit:async(_store,group)=>{assert.equal(inside,false);assert.equal(res.headersSent,true);assert.equal(slot.busy,0);assert.equal(group.botId,'owner');order.push('audit');throw new Error('PRIVATE_AUDIT_SENTINEL');}})});
  await dispatch({method:'GET',url:'/api/paper-performance/owner?currency=USDT&period=DAY',headers:{},socket:{}},res);
  assert.deepEqual(order,['commit','read','send-head','send-body','audit']);assert.equal(res.statusCode,200);assert.equal(validateOwnerResponse(res.body),true);
  assert.equal(JSON.stringify(res.body).includes('PRIVATE_'),false);assert.equal(res.phase2AfterCommit,null);
});

test('independent owner body with an unresolved range carries no market_coverage and a body carrying one is refused by the route',async()=>{
  const body=structuredClone(ownerResult().body);
  assert.equal(body.resolved_range,null);assert.equal(Object.hasOwn(body,'market_coverage'),false);assert.equal(validateOwnerResponse(body),true);
  body.market_coverage={version:'qr2-owner-bar-coverage-v1',entries:[],accounts:[]};
  assert.equal(validateOwnerResponse(body),false);
  const res=await plan('owner',{slot:createQr2Slot(),readSnapshot:async()=>({snapshot:{},input:{}}),compute:{run:async()=>({ok:true,body,auditFindings:[]})}});
  const result=await res.phase2Deferred();assert.equal(result.status,500);assert.equal(result.body.code,'QR2_RESPONSE_INVALID');
});

test('independent owner scalar response corruption is refused and never registers audit',async()=>{
  const mutations=[b=>{b.currency='PRIVATE_SQL_SENTINEL';},b=>{b.price_policy='PRIVATE_SQL_SENTINEL';},b=>{b.counts.accounts='PRIVATE_SQL_SENTINEL';},b=>{b.contract_id='PRIVATE_SQL_SENTINEL';},b=>{b.valuation_method='PRIVATE_SQL_SENTINEL';}];
  for(const mutate of mutations){const body=structuredClone(ownerResult().body);mutate(body);
    const res=await plan('owner',{slot:createQr2Slot(),readSnapshot:async()=>({snapshot:{},input:{}}),compute:{run:async()=>({ok:true,body,auditFindings:[{botId:'owner',broker:'binance-global',check:'R3'}]})}});
    const result=await res.phase2Deferred();assert.equal(result.status,500);assert.equal(result.body.code,'QR2_RESPONSE_INVALID');assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);assert.equal(res.phase2AfterCommit,null);
  }
});
