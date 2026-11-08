import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {qr4Routes,planRegister,planPreview,productionDependencies,registrationRequestOf,registrationContextOf,botPolicyReader,qr4AuditFailureCount,QR4_PATH,QR4_CANCEL_EVENT,LIST_LIMIT,ADMISSION_DEADLINE_ALLOWANCE_MS} from '../src/postgres/qr4-routes.js';
import {UNIVERSE_CAP,POLICY_DRAWDOWN_FIELDS,policySnapshotOf,scopeOfContract,dataWindowsOf,labelOfGates} from '../src/postgres/selection-inputs.js';
import {ROUTE_ACTIONS,CODE_LIST,CODE_PATTERN,OBJECTIVE_REGISTRY,buildRegistration,rankSelection,developmentRowViolations,EXPOSURE_SENTENCE,NO_SIGNIFICANCE_SENTENCE,NO_PROFIT_SENTENCE} from '../src/selection/index.js';
import {registrationBodyText} from '../src/postgres/selection-store.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {canonical,hash} from '../src/pine-bridge/source.js';

// QR-4 slice Q4-B owner API over a STUB store: the route module and the dispatcher's deferred phase (emulated; the real dispatcher runs res.phase2Deferred after COMMIT).
// The real store, the real inputs reader and the real dispatcher run in test/postgres/qr4-routes.test.mjs and test/postgres/qr4-selection-inputs.test.mjs. A registration
// that succeeds needs the TEST objective registry, which no route can pass (RC-S11), so the success paths of register are store-level tests in the PostgreSQL files.
const OWNER='owner-1',INTRUDER='someone-else';
const SELECTION='0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',EXPORT='1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f';
const GOOD=Object.freeze({confirmed:true,fixture:true,
  scope:{market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},
    cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},capital:{equity:'1000',cash:'1000'},policy:{policy_version:'risk-v1',policy_hash:'a'.repeat(64)}},
  window:{kind:'PROSPECTIVE',start_ms:1900000000000,end_ms:1900000060000,warmup_bars:10},objective:{id:'qr4-objective-lexi-v1'},
  filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false}});
const with_=over=>{const body=structuredClone(GOOD);for(const [name,value] of Object.entries(over)){if(value===undefined)delete body[name];else body[name]=value;}return body;};

function scripted(over={}){
  const state={schema:true,rows:[],selection:null,throwOn:null,extra:null,...over};
  const log=[];
  const db={isTransaction:false,
    async transaction(work){
      if(db.isTransaction)return work();
      db.isTransaction=true;
      try{return await work();}finally{db.isTransaction=false;}
    },
    async query(sql,params=[]){
      const text=String(sql);
      log.push({sql:text,params});
      if(state.throwOn&&state.throwOn(text))throw state.error;
      if(text==='SET TRANSACTION READ ONLY')return {rows:[]};
      const extra=state.extra?state.extra(text,params):null;
      if(extra)return extra;
      if(text.startsWith("SELECT to_regclass('public.quant_selection_registrations')"))return {rows:[{selection:state.schema}]};
      if(text.includes('FROM public.quant_selection_registrations r'))return {rows:state.rows.slice(0,params[1])};
      if(text.startsWith('SELECT * FROM public.quant_selection_registrations WHERE selection_id'))return {rows:[]};
      if(text.startsWith('SELECT selection_id FROM public.quant_selection_registrations WHERE selection_id'))return {rows:[]};
      throw Error('unscripted statement: '+text.slice(0,100));
    }};
  return {state,log,db};
}

function harness(options={}){
  const {enabled=true,script=scripted(),authorize=true,deps}=options;
  const audits=[],authCalls=[];
  const store={db:script.db,async audit(...args){audits.push(args);if(options.auditFails)throw Error('audit down');}};
  const auth={async require(req){
    authCalls.push(req.method);
    if(req.method!=='GET'&&req.headers['x-csrf-token']!=='csrf-ok')throw Object.assign(new Error('Invalid CSRF token'),{status:403});
    return {id:authorize?OWNER:INTRUDER};
  }};
  async function call(method,path,{body,csrf=true,query=''}={}){
    const req=Readable.from([Buffer.from(JSON.stringify(body===undefined?{}:body))]);req.method=method;req.headers=csrf?{'x-csrf-token':'csrf-ok'}:{};
    const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null};
    const json=(target,status,value)=>{target.phase2Result={status,body:value};};
    const before=script.log.length;
    const handled=await qr4Routes(req,res,new URL(path+query,'http://localhost'),{id:OWNER},{store,auth,json,enabled,deps,readBotState:options.readBotState,fixtureSelectionsAllowed:options.fixtureSelectionsAllowed});
    const phase1Statements=script.log.length-before;
    let result=res.phase2Result;
    if(typeof res.phase2Deferred==='function')result=await res.phase2Deferred();
    return {handled,status:result?.status??null,body:result?.body??null,phase1Statements,deferred:typeof res.phase2Deferred==='function'};
  }
  return {call,audits,authCalls,script};
}

/* ---- flag off, paths and methods ---- */

test('flag off: every path and method is unhandled, reads nothing, authenticates nothing and answers nothing (the router answers 404)',async()=>{
  const h=harness({enabled:false});
  for(const method of ['GET','POST','PUT','PATCH','DELETE'])for(const path of [QR4_PATH,QR4_PATH+'/'+SELECTION,QR4_PATH+'/'+SELECTION+'/cancel',QR4_PATH+'/'+SELECTION+'/replay',
    QR4_PATH+'/'+SELECTION+'/package/'+EXPORT,QR4_PATH+'/'+SELECTION+'/apply',QR4_PATH+'/']){
    const answer=await h.call(method,path,{body:GOOD});
    assert.deepEqual([answer.handled,answer.status,answer.deferred],[false,null,false],method+' '+path);
  }
  assert.equal(h.script.log.length,0);assert.deepEqual(h.authCalls,[]);assert.deepEqual(h.audits,[]);
  const on=harness();
  for(const path of ['/api/quant/selectionsX','/api/quant/library','/api/quant','/api/quant/selection','/api/quant/comparisons'])assert.equal((await on.call('GET',path)).handled,false,path);
});

test('flag on: exactly register, list, detail, cancel, replay and open_package; other methods answer 405, unknown shapes 404 (RC-S11)',async()=>{
  const h=harness();
  const wrong=[['PUT',QR4_PATH],['DELETE',QR4_PATH],['PATCH',QR4_PATH],['POST',QR4_PATH+'/'+SELECTION],['GET',QR4_PATH+'/'+SELECTION+'/cancel'],['GET',QR4_PATH+'/'+SELECTION+'/replay'],
    ['POST',QR4_PATH+'/'+SELECTION+'/package/'+EXPORT],['PUT',QR4_PATH+'/'+SELECTION]];
  for(const [method,path] of wrong){
    const answer=await h.call(method,path,{body:{}});
    assert.deepEqual([answer.status,answer.body.code],[405,'METHOD_NOT_ALLOWED'],method+' '+path);
  }
  for(const path of [QR4_PATH+'/',QR4_PATH+'/'+SELECTION+'/package/',QR4_PATH+'/'+SELECTION+'/package',QR4_PATH+'/'+SELECTION+'/cancel/extra',QR4_PATH+'/'+SELECTION+'/package/'+EXPORT+'/x']){
    const answer=await h.call('GET',path);
    assert.deepEqual([answer.status,answer.body.code],[404,'NOT_FOUND'],path);
  }
  assert.equal(h.script.log.length,0,'a refused shape reads nothing');
  assert.deepEqual(ROUTE_ACTIONS,['register','cancel','replay_outcome','open_package','list','detail']);
});

test('a POST to any other action name is 403 QR4_APPLY_REFUSED after the CSRF check; a GET of it is 404; names on the allow-list are no POST sub-route',async()=>{
  const h=harness();
  for(const name of ['apply','import','start','email','alert','session','optimize','bot','Cancel','REPLAY','replay_outcome-x','apply_inputs','start_bot','email_report','x']){
    const answer=await h.call('POST',QR4_PATH+'/'+SELECTION+'/'+name,{body:{}});
    assert.deepEqual([answer.status,answer.body.code,answer.body.detail,answer.deferred],[403,'QR4_APPLY_REFUSED','ACTION_NOT_ALLOWED',false],name);
    assert.equal((await h.call('GET',QR4_PATH+'/'+SELECTION+'/'+name)).status,404,'GET '+name);
  }
  for(const name of ['register','list','detail','open_package'])assert.equal((await h.call('POST',QR4_PATH+'/'+SELECTION+'/'+name,{body:{}})).status,404,name);
  await assert.rejects(h.call('POST',QR4_PATH+'/'+SELECTION+'/apply',{body:{},csrf:false}),/CSRF/,'without the CSRF token the refusal is the auth failure, not a 403 of ours');
  assert.equal(h.script.log.length,0);assert.deepEqual(h.audits,[]);
});

test('a POST body that names apply, import, start, email, alert, a Bot or a session is 403 QR4_APPLY_REFUSED on register, cancel and replay, before any read',async()=>{
  const h=harness();
  for(const key of ['apply','import','start_bot','email','alert','session','optimize','bot_id','applyInputs']){
    for(const [path,body] of [[QR4_PATH,{...GOOD,[key]:true}],[QR4_PATH+'/'+SELECTION+'/cancel',{confirmed:true,[key]:true}],[QR4_PATH+'/'+SELECTION+'/replay',{[key]:true}]]){
      const answer=await h.call('POST',path,{body});
      assert.deepEqual([answer.status,answer.body.code,answer.deferred],[403,'QR4_APPLY_REFUSED',false],key+' '+path);
    }
  }
  assert.equal(h.script.log.length,0);
});

test('queries: any key is refused before a read; rank-like keys are QR4_DEVELOPMENT_SCORE_NOT_RANKABLE (D1), all others INVALID_FIELDS',async()=>{
  const h=harness();
  for(const key of ['sort','order_by','orderby','rank','rankby','top','top10','best','best3','leader','winner','sortby','SortBy','sort_by'])
    for(const path of [QR4_PATH,QR4_PATH+'/'+SELECTION]){
      const answer=await h.call('GET',path,{query:'?'+key+'=net_return'});
      assert.deepEqual([answer.status,answer.body.code,answer.body.detail,answer.deferred],[400,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE','QUERY',false],key+' '+path);
    }
  for(const key of ['limit','offset','owner_id','user_id','bot_id','x','include_gates']){
    const answer=await h.call('GET',QR4_PATH,{query:'?'+key+'=1'});
    assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[400,'INVALID_FIELDS','QUERY'],key);
  }
  assert.equal((await h.call('POST',QR4_PATH+'/'+SELECTION+'/cancel',{body:{confirmed:true},query:'?owner_id=x'})).body.code,'INVALID_FIELDS');
  assert.equal(h.script.log.length,0);
});

test('a POST of a session that is not the routed actor answers the same 404 as an absent selection and reads nothing',async()=>{
  const h=harness({authorize:false});
  for(const path of [QR4_PATH,QR4_PATH+'/'+SELECTION+'/cancel',QR4_PATH+'/'+SELECTION+'/replay']){
    const answer=await h.call('POST',path,{body:path===QR4_PATH?GOOD:{confirmed:true}});
    assert.deepEqual([answer.status,answer.body.code,answer.deferred],[404,'NOT_FOUND',false],path);
  }
  assert.equal(h.script.log.length,0);
});

/* ---- register: the pure part ---- */

test('register plan: forbidden words, unknown keys, the confirm token and the field shapes are refused in phase one, with nothing read',async()=>{
  const h=harness();
  const refused=async(body,status,code,detail=null)=>{
    const answer=await h.call('POST',QR4_PATH,{body});
    assert.deepEqual([answer.status,answer.body.code,answer.body.detail,answer.deferred,answer.phase1Statements],[status,code,detail,false,0],JSON.stringify(body).slice(0,120));
  };
  // a request can carry none of: the registry, the dependency facts, a tolerance, the prior selections, the requester, the clock, the admission deadline or the engine
  for(const key of ['objective_registry','dependencies','prior_selection_ids','policy_snapshot','requester_owner_id','owner_id','registered_at_ms','admission_deadline_ms','universe','selection_id','universe_cap','fixture_selections_allowed','capacity_bars','existing_registrations'])
    await refused(with_({[key]:key==='dependencies'?{qr3_context:true}:'x'}),400,'INVALID_FIELDS','BODY');
  for(const key of ['tie_tolerance','return_tolerance_pp','tolerances'])await refused(with_({[key]:'0.5'}),400,'INVALID_FIELDS','TOLERANCE_IN_REQUEST');
  await refused(with_({filters:{...GOOD.filters,tie_tolerance_pp:'1'}}),400,'INVALID_FIELDS','TOLERANCE_IN_REQUEST');
  await refused(with_({objective:{id:'qr4-objective-lexi-v1',tie_tolerance_return_pp:'1'}}),400,'INVALID_FIELDS','OBJECTIVE_KEYS');
  for(const key of ['weights','sort','rank','score','formula','custom','order_by'])await refused(with_({[key]:1}),400,'QR4_CUSTOM_WEIGHTS_REFUSED',key);
  await refused(with_({objective:{id:'qr4-objective-lexi-v1',weights:{a:1}}}),400,'QR4_CUSTOM_WEIGHTS_REFUSED','weights');
  await refused(with_({objective:{id:'custom-formula'}}),400,'QR4_OBJECTIVE_UNKNOWN','custom-formula');
  await refused(with_({confirmed:undefined}),400,'CONFIRMATION_REQUIRED');
  await refused(with_({confirmed:'true'}),400,'CONFIRMATION_REQUIRED');
  await refused(with_({fixture:'yes'}),400,'INVALID_FIELDS','FIXTURE');
  await refused(with_({ranking_basis:5}),400,'INVALID_FIELDS','RANKING_BASIS');
  await refused(with_({scope:undefined}),400,'INVALID_FIELDS','SCOPE_KEYS');
  await refused(with_({scope:{...GOOD.scope,engine:'a'.repeat(64)}}),400,'INVALID_FIELDS','SCOPE_KEYS');
  await refused(with_({scope:{...GOOD.scope,valuation:{valuation:'x',benchmark:'y'}}}),400,'INVALID_FIELDS','SCOPE_KEYS');
  await refused(with_({window:undefined}),400,'QR4_WINDOW_INVALID','WINDOW_SHAPE');
  await refused(with_({window:{kind:'PROSPECTIVE',start_ms:1,end_ms:'x',warmup_bars:1}}),400,'QR4_WINDOW_INVALID','WINDOW_SHAPE');
  await refused(with_({filters:undefined}),400,'INVALID_FIELDS','OBJECTIVE_OR_FILTERS_MISSING');
  await refused(with_({filters:{drawdown_limit_percent:'20',episode_floor:4}}),400,'QR4_FILTER_INVALID','FILTER_EPISODE_FLOOR');
  await refused(with_({filters:{drawdown_limit_percent:'20',episode_floor:5,extra:1}}),400,'QR4_FILTER_INVALID','FILTER_KEYS');
  assert.equal(h.script.log.length,0);
  assert.deepEqual([planRegister([]).code,planRegister(null).code,planRegister('x').detail],['INVALID_FIELDS','INVALID_FIELDS','BODY'],'a body that is not an object (the shared reader already refuses arrays)');
  const plan=planRegister(GOOD);
  assert.equal(plan.ok,true);
  assert.deepEqual(Object.keys(plan.plan).sort(),['filters','fixture','objective','ranking_basis','scope','window']);
  assert.equal(planRegister(with_({fixture:undefined})).plan.fixture,false,'a customer selection is the default');
});

test('register fails closed until the evaluation wiring supplies deps: QR4_EVALUATION_MODE_UNAVAILABLE before any read; a bad engine hash is refused the same way',async()=>{
  const h=harness();
  const unwired=await h.call('POST',QR4_PATH,{body:GOOD});
  assert.deepEqual([unwired.status,unwired.body.code,unwired.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','REGISTER_NOT_WIRED']);
  assert.equal(h.script.log.length,0,'nothing was read');
  for(const bad of [undefined,null,'x','A'.repeat(64),'a'.repeat(63),42]){
    const wired=harness({deps:{engineHash:async()=>bad}});
    const answer=await wired.call('POST',QR4_PATH,{body:GOOD});
    assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','ENGINE_HASH'],String(bad));
    assert.equal(wired.script.log.length,0);
  }
  assert.deepEqual(h.audits,[]);
});

test('the request and the context of a registration: the admission deadline is W end plus 24 hours from the server; the context holds exactly three keys and no registry (SB203 item 4, RC-S11)',()=>{
  const plan=planRegister({...GOOD,fixture:true}).plan;
  const request=registrationRequestOf(OWNER,plan,'b'.repeat(64));
  assert.equal(request.admission_deadline_ms,GOOD.window.end_ms+86400000);
  assert.deepEqual(Object.keys(request).sort(),['admission_deadline_ms','confirmed','filters','fixture','objective','owner_id','scope','window']);
  assert.deepEqual(request.scope.valuation,{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'});
  assert.equal(request.scope.engine,'b'.repeat(64));
  assert.equal(request.owner_id,OWNER);
  // the owner cannot move the deadline: the plan has no such field and the body is refused on it
  assert.equal(planRegister({...GOOD,admission_deadline_ms:1}).detail,'BODY');
  const context=registrationContextOf(OWNER,{deps:{engineHash:async()=>'x',evaluation_mode:true,qr3_context:true},fixtureSelectionsAllowed:true});
  assert.deepEqual(Object.keys(context).sort(),['dependencies','fixture_selections_allowed','requester_owner_id']);
  assert.deepEqual(context,{requester_owner_id:OWNER,dependencies:{qr3_context:false,evaluation_mode:true,episode_gate_version:''},fixture_selections_allowed:true});
  assert.equal(registrationContextOf(OWNER,{}).fixture_selections_allowed,false);
  assert.equal(registrationContextOf(OWNER,{fixtureSelectionsAllowed:'1'}).fixture_selections_allowed,false,'only the boolean true');
});

test('with the schema absent the routes answer QR4_SCHEMA_ABSENT (503); the answer is the same for every id',async()=>{
  const script=scripted({schema:false});
  const h=harness({script,deps:{engineHash:async()=>'b'.repeat(64)}});
  for(const [method,path,body] of [['GET',QR4_PATH],['GET',QR4_PATH+'/'+SELECTION],['GET',QR4_PATH+'/zzz'],['POST',QR4_PATH+'/'+SELECTION+'/cancel',{confirmed:true}],
    ['POST',QR4_PATH+'/'+SELECTION+'/replay',{}],['GET',QR4_PATH+'/'+SELECTION+'/package/'+EXPORT],['POST',QR4_PATH,GOOD]]){
    const answer=await h.call(method,path,{body});
    assert.deepEqual([answer.status,answer.body.code],[503,'QR4_SCHEMA_ABSENT'],method+' '+path);
  }
  assert.ok(script.log.every(item=>item.sql==='SET TRANSACTION READ ONLY'||item.sql.startsWith("SELECT to_regclass('public.quant_selection_registrations')")),'only the presence probe ran');
});

test('the production dependency facts: qr3_context is false (V8 hold) whatever a dependency object says; evaluation_mode and the episode gate come from the wiring only',()=>{
  assert.deepEqual(productionDependencies(undefined),{qr3_context:false,evaluation_mode:false,episode_gate_version:''});
  assert.deepEqual(productionDependencies({qr3_context:true,evaluation_mode:'yes',episode_gate_version:7}),{qr3_context:false,evaluation_mode:false,episode_gate_version:''});
  assert.deepEqual(productionDependencies({evaluation_mode:true,episode_gate_version:'fe1-flat-to-flat-v1'}),{qr3_context:false,evaluation_mode:true,episode_gate_version:'fe1-flat-to-flat-v1'});
  assert.ok(Object.isFrozen(productionDependencies()));
  assert.equal(ADMISSION_DEADLINE_ALLOWANCE_MS,86400000,'RR-Q4-8: W end plus 24 hours, set by the server');
});

/* ---- cancel, replay, list, detail, open_package over the stub ---- */

test('cancel: the confirm token is required, no other key is allowed, an absent id is the identical 404 and nothing is audited',async()=>{
  const h=harness();
  const body=async(over,id=SELECTION)=>h.call('POST',QR4_PATH+'/'+id+'/cancel',{body:over});
  assert.deepEqual([(await body({})).status,(await body({})).body.code],[400,'CONFIRMATION_REQUIRED']);
  assert.deepEqual([(await body({confirmed:false})).body.code],['CONFIRMATION_REQUIRED']);
  assert.deepEqual([(await body({confirmed:true,note:'x'})).body.code,(await body({confirmed:true,note:'x'})).body.detail],['INVALID_FIELDS','BODY']);
  const absent=await body({confirmed:true}),malformed=await body({confirmed:true},'not-a-uuid'),other=await body({confirmed:true},'ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.deepEqual([absent.status,absent.body],[404,{ok:false,code:'NOT_FOUND',detail:null}]);
  assert.deepEqual(malformed.body,absent.body);assert.deepEqual(other.body,absent.body);
  assert.deepEqual(h.audits,[]);
});

test('replay: an absent id is the identical 404 whether or not replay is wired; a body is not allowed',async()=>{
  for(const deps of [undefined,{replay:async()=>({ok:true,match:true})}]){
    const h=harness({deps});
    const absent=await h.call('POST',QR4_PATH+'/'+SELECTION+'/replay',{body:{}});
    assert.deepEqual([absent.status,absent.body],[404,{ok:false,code:'NOT_FOUND',detail:null}]);
    assert.deepEqual((await h.call('POST',QR4_PATH+'/'+SELECTION+'/replay',{body:{confirmed:true}})).body.detail,'BODY');
  }
});

test('list: creation order, counts per status and outcome, an outcome only on a completed selection, no metric, and an explicit truncation flag',async()=>{
  const row=(id,status,outcome=null,extra={})=>({selection_id:id,fixture:false,window_kind:'PROSPECTIVE',start_ms:'1900000000000',end_ms:'1900000060000',evaluation_bars:1,warmup_bars:0,total_bars:1,
    participant_count:2,registered_at_ms:'1800000000000',frozen_at_ms:'1800000000001',admission_deadline_ms:'1900086460000',status,code:null,outcome,...extra});
  const rows=[row('a','SELECTION_REGISTERED',null),row('b','SELECTION_COMPLETED','BEST_IN_SCOPE'),row('c','SELECTION_COMPLETED','NO_QUALIFYING_STRATEGY'),
    row('d','SELECTION_INCOMPLETE','BEST_IN_SCOPE',{code:'QR4_ADMISSION_REFUSED'}),row('e','SELECTION_CANCELLED'),row('f','SELECTION_EVALUATING',null,{fixture:true})];
  const h=harness({script:scripted({rows})});
  const answer=await h.call('GET',QR4_PATH);
  assert.equal(answer.status,200);
  const body=answer.body;
  assert.deepEqual(body.selections.map(item=>item.selection_id),['a','b','c','d','e','f'],'the order is the database order (creation), never by outcome');
  assert.deepEqual(body.selections.map(item=>item.outcome),[null,'BEST_IN_SCOPE','NO_QUALIFYING_STRATEGY',null,null,null],'an outcome shows only for SELECTION_COMPLETED');
  assert.deepEqual(body.counts.by_status,{SELECTION_REGISTERED:1,SELECTION_EVALUATING:1,SELECTION_COMPLETED:2,SELECTION_INCOMPLETE:1,SELECTION_CANCELLED:1});
  assert.deepEqual(body.counts.by_outcome,{BEST_IN_SCOPE:1,TIED_IN_SCOPE:0,NO_QUALIFYING_STRATEGY:1,INADEQUATE_EVIDENCE:0});
  assert.deepEqual([body.total,body.truncated,body.order],[6,false,'CREATION']);
  assert.equal(body.selections[5].internal_view,true);
  const text=JSON.stringify(body);
  assert.doesNotMatch(text,/net_return|drawdown_pct|"rank"|"best"|label_text|winner/i,'no metric, rank or label field');
  assert.ok(h.script.log.some(item=>item.sql==='SET TRANSACTION READ ONLY'),'the list runs in a READ ONLY transaction');
  const many=Array.from({length:LIST_LIMIT+1},(_,index)=>row('s'+index,'SELECTION_REGISTERED'));
  const big=await harness({script:scripted({rows:many})}).call('GET',QR4_PATH);
  assert.deepEqual([big.body.total,big.body.truncated],[LIST_LIMIT,true]);
});

test('detail and open_package: an absent, malformed or foreign id is one identical 404 body',async()=>{
  const h=harness();
  const bodies=[];
  for(const id of [SELECTION,'zzz','../x','ffffffff-ffff-4fff-8fff-ffffffffffff']){
    const detail=await h.call('GET',QR4_PATH+'/'+encodeURIComponent(id));
    const pack=await h.call('GET',QR4_PATH+'/'+encodeURIComponent(id)+'/package/'+EXPORT);
    bodies.push(detail.body,pack.body);
    assert.deepEqual([detail.status,pack.status],[404,404],id);
  }
  for(const body of bodies)assert.deepEqual(body,{ok:false,code:'NOT_FOUND',detail:null});
});

test('an audit write that fails is counted and never changes the answer (cancel of an absent id writes none)',async()=>{
  const before=qr4AuditFailureCount();
  const h=harness({auditFails:true});
  assert.equal((await h.call('POST',QR4_PATH+'/'+SELECTION+'/cancel',{body:{confirmed:true}})).status,404);
  assert.equal(qr4AuditFailureCount(),before);
  assert.equal(QR4_CANCEL_EVENT,'qr4.selection_cancelled');
});

test('a database failure answers QR4_UNAVAILABLE (503) and a serialization failure RETRY_TRANSACTION (409), without the message',async()=>{
  const down=scripted({throwOn:text=>text.startsWith("SELECT to_regclass('public.quant_selection_registrations')")});
  down.state.error=Object.assign(new Error('connection to server at db-host-placeholder refused'),{code:'ECONNREFUSED'});
  const a=await harness({script:down}).call('GET',QR4_PATH);
  assert.deepEqual([a.status,a.body],[503,{ok:false,code:'QR4_UNAVAILABLE',detail:null}]);
  const busy=scripted({throwOn:text=>text.startsWith("SELECT to_regclass('public.quant_selection_registrations')")});
  busy.state.error=Object.assign(new Error('could not serialize'),{code:'40001'});
  const b=await harness({script:busy}).call('GET',QR4_PATH);
  assert.deepEqual([b.status,b.body.code],[409,'RETRY_TRANSACTION']);
});

/* ---- the inputs reader: pure parts ---- */

test('policy snapshot (RR-Q4-20): the declared hash is accepted only when a parent policy hashes to it; a verified policy defines no drawdown limit; anything else is unreadable',()=>{
  const policy={maxRiskPercent:1,requireReduceOnlySell:true},good=hash(canonical(policy));
  const row=(policyHash,object)=>({k:{snapshot:{policy_hash:policyHash,policy:object}}});
  assert.deepEqual(policySnapshotOf([row(good,policy)],good),{policy_hash:good,max_drawdown_percent:null});
  assert.equal(policySnapshotOf([row(good,{...policy,maxRiskPercent:2})],good),null,'the stored policy does not hash to the snapshot hash');
  assert.equal(policySnapshotOf([row('b'.repeat(64),policy)],good),null,'no parent carries the declared hash');
  assert.equal(policySnapshotOf([],good),null);
  assert.equal(policySnapshotOf([row(good,policy)],'x'),null);
  assert.equal(policySnapshotOf([row(good,policy)],null),null);
  assert.equal(policySnapshotOf([row(good,undefined)],good),null);
  assert.deepEqual(POLICY_DRAWDOWN_FIELDS,[],'the Risk Manager policy schema names no percent drawdown field');
  // the policy schema itself: no field of the validated ranges or of the default risk names a drawdown percentage
});

test('the Risk Manager policy schema names no percent drawdown field (the file:line evidence of RR-Q4-20)',async()=>{
  const validation=await fs.readFile(new URL('../src/postgres/risk-policy-validation.js',import.meta.url),'utf8');
  const config=await fs.readFile(new URL('../src/config.js',import.meta.url),'utf8');
  assert.doesNotMatch(validation,/drawdown/i);
  assert.doesNotMatch(config,/drawdown/i);
  const ranges=validation.match(/const ranges = \{([\s\S]*?)\};/)[1];
  assert.deepEqual([...ranges.matchAll(/(\w+): \[/g)].map(match=>match[1]),['maxRiskPercent','maxOrderNotional','maxDailyNotional','maxTradesPerDay','maxDailyLossR','maxOpenPositions','pauseAfterLossStreak','maxSignalAgeSeconds','maxVolatilityPercent']);
});

test('scope of a contract: decimal strings and risk_percent exactly as the fixed evaluation admission compares them; unreadable input gives null',()=>{
  const c={model:{version:'paper-close-v1',data_profile:'closed-ohlcv-atr14-v1',price_tick:0.01,quantity_step:0.001,fee_bps:10,slippage_bps:1,risk_percent:1},capital:{equity:'1000',cash:'1000.50'},snapshot:{policy_hash:'c'.repeat(64)}};   // D(...).toFixed() drops the trailing zero, as the admission does
  assert.deepEqual(scopeOfContract(c,'risk-v1'),{data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},
    cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},capital:{equity:'1000',cash:'1000.5'},policy:{policy_version:'risk-v1',policy_hash:'c'.repeat(64)}});
  assert.equal(scopeOfContract({...c,policy_version:'own-v3'},'risk-v1').policy.policy_version,'own-v3','a contract policy version wins over the binding');
  assert.equal(scopeOfContract(c).policy.policy_version,null);
  assert.equal(scopeOfContract({...c,model:{...c.model,fee_bps:'abc'}}),null);
  assert.equal(scopeOfContract({}),null);
  assert.equal(scopeOfContract(null),null);
});

test('data windows are half-open and start at the dataset start (warm-up included); the cap and the gate-label rule are the contract ones',()=>{
  const c={dataset:{start_time:6000000,end_time:6000000+19*60000},split:{warmup:4,train_end:13,validation_end:16,test_end:20}};
  assert.deepEqual(dataWindowsOf(c),{dataset:{start_ms:6000000,end_ms:6000000+20*60000},train:{start_ms:6000000,end_ms:6000000+13*60000},
    validation:{start_ms:6000000+13*60000,end_ms:6000000+16*60000},holdout:{start_ms:6000000+16*60000,end_ms:6000000+20*60000}});
  assert.equal(dataWindowsOf({dataset:{start_time:1.5},split:c.split}),null);
  assert.equal(dataWindowsOf({dataset:c.dataset,split:{train_end:13,validation_end:13,test_end:20}}),null);
  assert.equal(UNIVERSE_CAP,50,'RR-Q4-12: provisional cap');
  const gates=states=>states.map((state,index)=>({gate:'G'+(index+1),state,code:state==='PASS'?null:'X'}));
  assert.equal(labelOfGates(gates(['FAIL','NOT_REACHED','NOT_REACHED','NOT_REACHED','NOT_REACHED','FAIL','FAIL','FAIL'])),'NOT_EVALUATED');
  assert.equal(labelOfGates(gates(['PASS','FAIL','NOT_REACHED','NOT_REACHED','NOT_REACHED','FAIL','FAIL','FAIL'])),'NO_SCREENED_CANDIDATE');
  assert.equal(labelOfGates(gates(['PASS','PASS','PASS','PASS','PASS','PASS','PASS','FAIL'])),'DEVELOPMENT_ONLY');
  assert.equal(labelOfGates(gates(['PASS','PASS','PASS','PASS','PASS','PASS','PASS','PASS'])),'QUALIFIED');
  assert.equal(labelOfGates(null),'NOT_EVALUATED');
});

test('botPolicyReader returns the hash of the effective Bot policy (the locked policy when a session holds one)',async()=>{
  const policy={maxRiskPercent:1};
  const stored=botPolicyReader({store:{getBotSession:async()=>({locked_policy:null}),risk:async(id,defaults)=>({...policy,id,defaults:defaults.x})},defaultRisk:{x:1}});
  assert.equal((await stored({bot_id:'bot-1'})).policy_hash,hash(canonical({maxRiskPercent:1,id:'bot-1',defaults:1})));
  const locked=botPolicyReader({store:{getBotSession:async()=>({locked_policy:JSON.stringify(policy)}),risk:async()=>{throw new Error('not read');}},defaultRisk:{}});
  assert.equal((await locked({bot_id:'bot-1'})).policy_hash,hash(canonical(policy)));
});

/* ---- static ---- */

test('static: no QR-4 file matches the fixed-evaluation closure rule; the server and the new files are outside the runtime manifest; the route passes no registry; every code fits the pattern',async()=>{
  const names=['src/postgres/qr4-routes.js','src/postgres/selection-inputs.js'];
  for(const name of names){
    const source=await fs.readFile(new URL('../'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/fixed-eval-contract|quant-fixed-eval-engine|quant-fixed-eval-worker|quant-fixed-eval\.js/,name);
    assert.doesNotMatch(source,/Date\.now|Math\.random|randomUUID|node:fs|child_process|fetch\(/,name+' has no clock, random source, file or network access');
    assert.doesNotMatch(source,/objective_registry\s*:/,name+' passes no objective registry');
    assert.doesNotMatch(source,/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM)?\s*public\./i,name+' writes no row itself');
  }
  const server=await fs.readFile(new URL('../src/postgres/server.js',import.meta.url),'utf8');
  assert.match(server,/QR4_SELECTION_ENABLED==='1'/);
  assert.match(server,/qr4SelectionEnabled\?botPolicyReader/,'the Bot policy reader is built only when the flag is on');
  assert.match(server,/deps: undefined/);
  const listed=new Set(QUANT_RUNTIME_ENGINE_FILES);
  for(const name of [...names,'src/postgres/server.js'])assert.equal(listed.has(name),false,name+' is not a member of the engine closure');
  assert.ok(CODE_LIST.every(code=>CODE_PATTERN.test(code)));
  for(const code of ['QR4_SCHEMA_ABSENT','QR4_UNAVAILABLE','RETRY_TRANSACTION','METHOD_NOT_ALLOWED'])assert.match(code,CODE_PATTERN);
});

/* ---- stored selections over the stub: the views of every status, the overlays at read time, open_package and replay ---- */

const DAY=86400000,MS=60000,BASE=Date.UTC(2026,9,20),ENGINE='e'.repeat(64);
const POLICY='f'.repeat(64);
const UU=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const OBJECTIVE_ID='qr4-objective-lexi-v1';
const RULES_OBJECT={maximum_drawdown_percent:'25',minimum_closed_trades_test:10};
const TEST_REGISTRY=(()=>{const registry=structuredClone(OBJECTIVE_REGISTRY);registry[OBJECTIVE_ID].tie_tolerances.return_pp='0.5';registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp='0.5';return registry;})();
const SCOPE={market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},data_model:{data_profile:'spot-klines-1m',price_tick:'0.01',quantity_step:'0.00001'},
  cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'5'},capital:{equity:'10000',cash:'10000'},policy:{policy_version:'risk-v1',policy_hash:POLICY},
  valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE};
const BAR={time:BASE,open:'1',high:'1',low:'1',close:'1',volume:'1'},BAR_HASH=hash(canonical(BAR)),BAR_DIGEST=hash(canonical([{bar:BAR,content_hash:BAR_HASH,provenance:{}}]));
const GATES=['G1','G2','G3','G4','G5','G6','G7','G8'];
/** A customer participant whose package is READY in the stored world below (a labelled engineering fixture, synthetic rows). */
function memberOf(i){
  const exp=UU(i),pkg=hash('pkg'+i),imp='pi'+i,src=hash('src'+i);
  const binding={mode:'ONE_PINE',fixture:false,owner_id:OWNER,bot_id:'bot-'+i,run_id:'run-'+i,pine_import_id:imp,source_version:1,source_hash:src,membership:[{pine_import_id:imp,source_version:1,source_hash:src}],
    policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:hash('lock'+i),dataset_ref:{sha256:BAR_DIGEST}};
  const current={membership:binding.membership,policy_version:'risk-v1',policy_hash:POLICY,deployment_id:'dep'+i,input_lock_hash:binding.input_lock_hash,dataset_available:true,bot_owner_id:OWNER};
  return {kind:'RESEARCH_RUN',owner_id:OWNER,run_id:'run-'+i,export_id:exp,created_at_ms:BASE-(20-i)*DAY,run_status:'SUCCEEDED',source_hash:src,market:structuredClone(SCOPE.market),
    qualification:{version:'library-qualification-v2',qualified:true,label:'QUALIFIED',gates:GATES.map(gate=>({gate,state:'PASS',code:null}))},integrity_checked:true,
    package:{export_id:exp,package_hash:pkg,status:'EXPORT_VALIDATED',binding,current,replay_mismatch:false},
    validation_records:[{run_id:'run-'+i,mode:'ONE_PINE',record:{fixture:false,export_id:exp,package_hash:pkg,binding_hash:hash('bind'+i),validated_at_utc:'2026-10-18T10:00:00Z',
      gate_results:['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS'}))}}],
    scope:{data_model:structuredClone(SCOPE.data_model),cost_model:structuredClone(SCOPE.cost_model),capital:structuredClone(SCOPE.capital),policy:structuredClone(SCOPE.policy)},
    library_class:'CANDIDATE_PENDING_ACCEPTANCE',rules_hash:hash(canonical(RULES_OBJECT)),rules:structuredClone(RULES_OBJECT),
    data_windows:{dataset:{start_ms:BASE-40*DAY,end_ms:BASE-10*DAY},train:{start_ms:BASE-40*DAY,end_ms:BASE-32*DAY},validation:{start_ms:BASE-32*DAY,end_ms:BASE-26*DAY},holdout:{start_ms:BASE-26*DAY,end_ms:BASE-10*DAY}},
    registered_boundary_ms:null};
}
const SELECTION_ID=UU(900);
function registrationOf(){
  const built=buildRegistration({owner_id:OWNER,selection_id:SELECTION_ID,registered_at_ms:BASE,confirmed:true,fixture:false,scope:structuredClone(SCOPE),
    window:{kind:'PROSPECTIVE',start_ms:BASE+DAY,end_ms:BASE+DAY+1000*MS,warmup_bars:200},objective:{id:OBJECTIVE_ID},filters:{drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false},
    admission_deadline_ms:BASE+2*DAY+1000*MS,universe:[memberOf(1),memberOf(2)]},
    {dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'x'},exposure_register:[],searched_windows:[],universe_cap:20,requester_owner_id:OWNER,
      policy_snapshot:{policy_hash:POLICY,max_drawdown_percent:null},prior_selection_ids:[],existing_registrations:[],objective_registry:TEST_REGISTRY,fixture_selections_allowed:false});
  assert.equal(built.ok,true,JSON.stringify(built));
  return built.registration;
}
const REGISTRATION=registrationOf();
const DATASET=hash('window');
function evaluationOf(reg,i,net){
  const result={evaluation_bars:reg.window.evaluation_bars,metrics:{net_return_percent:net,max_drawdown_percent:'5',closed_trades:9},episodes:8,rejected_intents:0,fees:'1.2',slippage:'0.4',
    exposure_percent:'35',cost_stress:{net_return_percent:'1'},benchmark:{net_return_percent:'0.1'}};
  return {run_id:'ev-'+i,parent_run_id:'run-'+i,selection_id:reg.selection_id,mode:'QR4_SELECTION_EVAL',status:'SUCCEEDED',integrity:{contract_hash_verified:true,report_matches_checkpoints:true},
    engine_hash:ENGINE,dataset_hash:DATASET,result,result_hash:hash(canonical(result))};
}
const OUTCOME=rankSelection(REGISTRATION,[evaluationOf(REGISTRATION,1,'3'),evaluationOf(REGISTRATION,2,'1')],{window_dataset_hash:DATASET});
const eventRow=(seq,event,status,over={})=>({seq,event,status,code:null,detail:null,outcome:null,completed_evaluation_run_ids:[],at_ms:String(BASE+seq),...over});
const EVENTS={
  SELECTION_REGISTERED:[eventRow(1,'REGISTER','SELECTION_REGISTERED')],
  SELECTION_EVALUATING:[eventRow(1,'REGISTER','SELECTION_REGISTERED'),eventRow(2,'FIRST_EVALUATION_START','SELECTION_EVALUATING')],
  SELECTION_INCOMPLETE:[eventRow(1,'REGISTER','SELECTION_REGISTERED'),eventRow(2,'DEADLINE_PASSED','SELECTION_INCOMPLETE',{code:'QR4_ADMISSION_REFUSED',detail:'ADMISSION_DEADLINE'})],
  SELECTION_CANCELLED:[eventRow(1,'REGISTER','SELECTION_REGISTERED'),eventRow(2,'OWNER_CANCEL','SELECTION_CANCELLED')],
  SELECTION_COMPLETED:[eventRow(1,'REGISTER','SELECTION_REGISTERED'),eventRow(2,'FIRST_EVALUATION_START','SELECTION_EVALUATING'),
    eventRow(3,'ALL_EVALUATIONS_DONE','SELECTION_COMPLETED',{outcome:OUTCOME.outcome,completed_evaluation_run_ids:['ev-1','ev-2']})]};

/** A script that answers the statements of readSelection, the package state and the schema probe for one stored selection. */
function stored(status,{outcomeRow=undefined,replayed=false,packages='ready'}={}){
  const reg=REGISTRATION,body=registrationBodyText(reg);
  const universe=[...reg.universe].sort((a,b)=>a.created_at_ms-b.created_at_ms||(a.run_id<b.run_id?-1:1));
  const parts=[...reg.participants].sort((a,b)=>a.export_id<b.export_id?-1:1);
  const completedBody=(()=>{const {outcome_hash:_hash,...rest}=OUTCOME;return canonical(rest);})();
  const outcome=status==='SELECTION_COMPLETED'?(outcomeRow===undefined?{outcome:OUTCOME.outcome,outcome_hash:OUTCOME.outcome_hash,body_canonical:completedBody,created_at_ms:String(BASE+3)}:outcomeRow):null;
  const exportOf=id=>{
    const m=[memberOf(1),memberOf(2)].find(item=>item.export_id===id);
    return m&&packages!=='absent'?{export_id:id,run_id:m.run_id,mode:'ONE_PINE',fixture:false,package_hash:m.package.package_hash,binding:m.package.binding,created_at:String(BASE)}:null;
  };
  const extra=(text,params)=>{
    if(text.startsWith('SELECT * FROM public.quant_selection_registrations WHERE selection_id'))
      return params[0]===SELECTION_ID&&params[1]===OWNER?{rows:[{selection_id:SELECTION_ID,owner_id:OWNER,fixture:false,window_kind:'PROSPECTIVE',start_ms:String(reg.window.start_ms),end_ms:String(reg.window.end_ms),
        registered_at_ms:String(reg.registered_at_ms),frozen_at_ms:String(reg.registered_at_ms+5),admission_deadline_ms:String(reg.admission_deadline_ms),registration_key:reg.registration_key,
        registration_hash:reg.registration_hash,body_canonical:body}]}:{rows:[]};
    if(text.startsWith('SELECT position,run_id,member_kind,universe_status'))return {rows:universe.map((item,index)=>({position:index+1,run_id:item.run_id,member_kind:item.kind,universe_status:item.status,first_code:item.code,export_id:item.export_id}))};
    if(text.includes('FROM public.quant_selection_participants WHERE selection_id'))return {rows:parts.map((item,index)=>({position:index+1,export_id:item.export_id,run_id:item.run_id,package_hash:item.package_hash,
      source_hash:item.source_hash,rules_hash:item.rules_hash,validation_package_hash:item.validation_binding.package_hash,validated_at_utc:item.validation_binding.validated_at_utc}))};
    if(text.includes('FROM public.quant_selection_status_events WHERE selection_id'))return {rows:EVENTS[status]};
    if(text.includes('FROM public.quant_selection_window_freezes'))return {rows:status==='SELECTION_REGISTERED'?[]:[{dataset_hash:DATASET,start_ms:String(reg.window.start_ms),end_ms:String(reg.window.end_ms),bars_total:reg.window.total_bars,frozen_at_ms:String(BASE+1)}]};
    if(text.includes('FROM public.quant_selection_evaluation_starts'))return {rows:status==='SELECTION_REGISTERED'?[]:parts.map(item=>({export_id:item.export_id,evaluation_run_id:'ev-'+item.run_id.slice(4),parent_run_id:item.run_id,dataset_hash:DATASET,engine_hash:ENGINE,started_at_ms:String(BASE+2)}))};
    if(text.includes('FROM public.quant_selection_outcomes'))return {rows:outcome?[outcome]:[]};
    if(text.includes('FROM public.quant_selection_replay_events'))return {rows:replayed?[{'?column?':1}]:[]};
    // the package state
    if(text.startsWith("SELECT to_regclass('public.bi_exports')"))return {rows:[{packages:true,boundaries:true}]};
    if(text.includes('FROM public.bi_exports WHERE owner_id=$1 AND export_id=$2')){const row=params[0]===OWNER?exportOf(params[1]):null;return {rows:row?[row]:[]};}
    if(text.startsWith('SELECT DISTINCT ON (export_id) export_id,status'))return {rows:params[0].map(id=>({export_id:id,status:packages==='candidate'?'EXPORT_CANDIDATE':'EXPORT_VALIDATED'}))};
    if(text.includes('FROM public.quant_jobs j WHERE j.owner_id=$1 AND j.run_id=ANY')){
      const rows=params[1].map(id=>{const m=[memberOf(1),memberOf(2)].find(item=>item.run_id===id);return m&&{run_id:id,bot_id:m.package.binding.bot_id,status:'SUCCEEDED',created_at:String(BASE),diagnostic:null,few:false,
        k:{deployment_id:m.package.binding.deployment_id,pine_import_id:m.package.binding.pine_import_id,source_version:1,baseline_snapshot_hash:hash('base'+id),dataset:{start_time:BASE,end_time:BASE,bar_count:1}}};}).filter(Boolean);
      return {rows};
    }
    if(text.includes('FROM public.pine_deployments')){const m=[memberOf(1),memberOf(2)].find(item=>item.package.binding.deployment_id===params[2]);
      return {rows:m?[{deployment_id:params[2],owner_id:OWNER,bot_id:m.package.binding.bot_id,pine_import_id:m.package.binding.pine_import_id,source_version:1,state:'READY',snapshot:{},snapshot_hash:hash('base'+m.run_id)}]:[]};}
    if(text.includes('FROM public.pine_memberships m')){
      return {rows:[memberOf(1),memberOf(2)].filter(m=>m.package.binding.bot_id===params[1]).map(m=>({pine_import_id:m.package.binding.pine_import_id,source_version:1,source_hash:m.source_hash}))};
    }
    if(text.includes('FROM public.pine_market_bars'))return {rows:[{bar_time:String(BASE),bar:BAR,provenance:{},content_hash:BAR_HASH}]};
    return null;
  };
  return scripted({extra});
}
const botState=async()=>({policy_hash:POLICY});
const RANK1=OUTCOME.ranking.filter(item=>item.rank===1).map(item=>item.export_id);
// The registered objective names its metrics as VALUES (metric: net_return_percent); a metric of W would be a KEY. The scan is over the keys of the whole body.
const keysOf=value=>Array.isArray(value)?value.flatMap(keysOf):value&&typeof value==='object'?Object.entries(value).flatMap(([key,item])=>[key,...keysOf(item)]):[];
const METRIC_KEYS=['net_return_percent','max_drawdown_percent','benchmark_net_return_percent','cost_stress_net_return_percent','ranking','evaluations','not_passed','values','label_text','label','profit_factor','episodes','closed_trades'];
const shownMetric=body=>keysOf(body).filter(key=>METRIC_KEYS.includes(key));

test('detail of a registered, evaluating, incomplete or cancelled selection shows progress counts only: no metric of W, no outcome, no label (16.3 item 3)',async()=>{
  for(const status of ['SELECTION_REGISTERED','SELECTION_EVALUATING','SELECTION_INCOMPLETE','SELECTION_CANCELLED']){
    const h=harness({script:stored(status)});
    const answer=await h.call('GET',QR4_PATH+'/'+SELECTION_ID);
    assert.equal(answer.status,200,status+JSON.stringify(answer.body));
    const body=answer.body;
    assert.deepEqual([body.status,body.metrics_visible,body.outcome,body.overlays,body.label_visible],[status,false,null,[],false],status);
    assert.deepEqual(body.progress,{participants:2,started:status==='SELECTION_REGISTERED'?0:2,window_frozen:status!=='SELECTION_REGISTERED'});
    assert.deepEqual(shownMetric(body),[],status+' shows no metric, ranking, evaluation or label');
    assert.deepEqual(body.events.map(item=>item.status).at(-1),status);
    assert.deepEqual([body.registration.registration_hash,body.registration.participant_count,body.registration.universe.length],[REGISTRATION.registration_hash,2,2]);
    assert.ok(h.script.log.some(item=>item.sql==='SET TRANSACTION READ ONLY'),'the view runs in a READ ONLY transaction');
  }
});

test('a completed selection shows the stored outcome; the label comes only with every sentence and only while the winners are READY and no replay mismatch exists (16.3 items 4 and 5)',async()=>{
  const ok=await harness({script:stored('SELECTION_COMPLETED')}).call('GET',QR4_PATH+'/'+SELECTION_ID,{});
  assert.equal(ok.status,200,JSON.stringify(ok.body).slice(0,300));
  const body=ok.body;
  assert.deepEqual([body.metrics_visible,body.overlays,body.label_visible,body.hide_recommended_values],[true,['WINNER_NOT_READY'],false,true],'no Bot policy port: the winner package is not fresh, so it is not READY');
  // wire the Bot policy hash: the winner package is READY now (fresh, validated, one-Pine, not a fixture, owned by the requester)
  const wired=await harness({script:stored('SELECTION_COMPLETED'),readBotState:botState}).call('GET',QR4_PATH+'/'+SELECTION_ID);
  assert.equal(wired.status,200);
  const shown=wired.body;
  assert.deepEqual([shown.overlays,shown.label_visible,shown.hide_recommended_values],[[],true,false],JSON.stringify(shown.overlays));
  const label=shown.outcome.label;
  assert.equal(label.label_text,'Best of 2 compared strategies within the selected scope');
  assert.deepEqual(label.participants,RANK1);
  assert.deepEqual([label.exposure_sentence,label.no_significance_sentence,label.no_profitability_sentence],[EXPOSURE_SENTENCE,NO_SIGNIFICANCE_SENTENCE,NO_PROFIT_SENTENCE]);
  assert.equal(label.scope_statement.coverage.participants_compared,2);
  assert.equal(shown.outcome.outcome,'BEST_IN_SCOPE');
  assert.equal(shown.outcome.outcome_hash,OUTCOME.outcome_hash);
  assert.equal(shown.outcome.ranking.find(item=>item.rank===1).net_return_percent,'3');
  // a replay mismatch event suppresses the label and hides the recommended values
  const mismatched=await harness({script:stored('SELECTION_COMPLETED',{replayed:true}),readBotState:botState}).call('GET',QR4_PATH+'/'+SELECTION_ID);
  assert.deepEqual([mismatched.body.overlays,mismatched.body.label_visible,mismatched.body.hide_recommended_values,mismatched.body.outcome.label],[['SELECTION_REPLAY_MISMATCH'],false,true,null]);
  assert.equal(mismatched.body.outcome.ranking.find(item=>item.rank===1).net_return_percent,null);
  assert.equal(mismatched.body.outcome.evaluations.find(item=>item.export_id===RANK1[0]).values,null);
  assert.doesNotMatch(JSON.stringify(mismatched.body),/label_text|Best of/);
  // a winner package that is no longer READY: WINNER_NOT_READY, the label is suppressed and the package link is hidden
  for(const packages of ['absent','candidate']){
    const gone=await harness({script:stored('SELECTION_COMPLETED',{packages}),readBotState:botState}).call('GET',QR4_PATH+'/'+SELECTION_ID);
    assert.deepEqual([gone.body.overlays,gone.body.label_visible,gone.body.hide_recommended_values,gone.body.hide_package_links,gone.body.outcome.label],[['WINNER_NOT_READY'],false,true,true,null],packages);
    assert.doesNotMatch(JSON.stringify(gone.body),/label_text|Best of/);
    const loser=gone.body.outcome.ranking.find(item=>item.rank!==1);
    if(loser)assert.notEqual(loser.net_return_percent,null,'only the recommended values are hidden');
  }
});

test('a stored outcome whose text does not hash to its outcome_hash, and one that is not JSON, are INTEGRITY_CHECK_FAILED (409) with no metric',async()=>{
  const tampered={outcome:OUTCOME.outcome,outcome_hash:OUTCOME.outcome_hash,body_canonical:'{"outcome":"BEST_IN_SCOPE","x":1}',created_at_ms:String(BASE+3)};
  const a=await harness({script:stored('SELECTION_COMPLETED',{outcomeRow:tampered})}).call('GET',QR4_PATH+'/'+SELECTION_ID);
  assert.deepEqual([a.status,a.body.code,a.body.detail],[409,'INTEGRITY_CHECK_FAILED','OUTCOME_HASH']);
  const raw='not json';
  const b=await harness({script:stored('SELECTION_COMPLETED',{outcomeRow:{outcome:'BEST_IN_SCOPE',outcome_hash:hash(raw),body_canonical:raw,created_at_ms:String(BASE)}})}).call('GET',QR4_PATH+'/'+SELECTION_ID);
  assert.deepEqual([b.status,b.body.detail],[409,'OUTCOME_UNREADABLE']);
  const none=await harness({script:stored('SELECTION_COMPLETED',{outcomeRow:null})}).call('GET',QR4_PATH+'/'+SELECTION_ID);
  assert.deepEqual([none.status,none.body.detail],[409,'OUTCOME_HASH']);
  assert.deepEqual(shownMetric([a.body,b.body,none.body]),[]);
});

test('open_package returns the export id and its READY state only, no link; a package that is not READY is QR4_PARTICIPANT_NOT_READY; a non-participant export is the identical 404',async()=>{
  const id=REGISTRATION.participants[0].export_id;
  const ready=await harness({script:stored('SELECTION_COMPLETED'),readBotState:botState}).call('GET',QR4_PATH+'/'+SELECTION_ID+'/package/'+id);
  assert.deepEqual([ready.status,ready.body],[200,{ok:true,selection_id:SELECTION_ID,export_id:id,state:'READY'}]);
  const noPort=await harness({script:stored('SELECTION_COMPLETED')}).call('GET',QR4_PATH+'/'+SELECTION_ID+'/package/'+id);
  assert.deepEqual([noPort.status,noPort.body.code,noPort.body.detail],[409,'QR4_PARTICIPANT_NOT_READY','BI_POLICY_SNAPSHOT_MISMATCH']);
  const candidate=await harness({script:stored('SELECTION_COMPLETED',{packages:'candidate'}),readBotState:botState}).call('GET',QR4_PATH+'/'+SELECTION_ID+'/package/'+id);
  assert.deepEqual([candidate.status,candidate.body.detail],[409,'EXPORT_CANDIDATE']);
  const foreign=await harness({script:stored('SELECTION_COMPLETED'),readBotState:botState}).call('GET',QR4_PATH+'/'+SELECTION_ID+'/package/'+UU(777));
  const absent=await harness({script:stored('SELECTION_COMPLETED'),readBotState:botState}).call('GET',QR4_PATH+'/'+UU(901)+'/package/'+id);
  assert.deepEqual([foreign.status,foreign.body,absent.body],[404,{ok:false,code:'NOT_FOUND',detail:null},{ok:false,code:'NOT_FOUND',detail:null}]);
  assert.ok(!JSON.stringify(ready.body).includes('http')&&!Object.keys(ready.body).some(key=>/link|url|href/i.test(key)));
});

test('replay (replay_outcome): only a completed selection; refuses until the wiring supplies deps.replay; with it the result and one audit row are returned',async()=>{
  const open=await harness({script:stored('SELECTION_EVALUATING'),deps:{replay:async()=>{throw new Error('must not run');}}}).call('POST',QR4_PATH+'/'+SELECTION_ID+'/replay',{body:{}});
  assert.deepEqual([open.status,open.body.code,open.body.detail],[409,'QR4_TRANSITION_INVALID','NOT_COMPLETED']);
  const unwired=await harness({script:stored('SELECTION_COMPLETED')}).call('POST',QR4_PATH+'/'+SELECTION_ID+'/replay',{body:{}});
  assert.deepEqual([unwired.status,unwired.body.code,unwired.body.detail],[409,'QR4_EVALUATION_MODE_UNAVAILABLE','REPLAY_NOT_WIRED']);
  const calls=[];
  const h=harness({script:stored('SELECTION_COMPLETED'),deps:{replay:async input=>{calls.push(input);return {ok:true,match:true,stored_outcome_hash:OUTCOME.outcome_hash,recomputed_outcome_hash:OUTCOME.outcome_hash};}}});
  const done=await h.call('POST',QR4_PATH+'/'+SELECTION_ID+'/replay',{body:{}});
  assert.deepEqual(calls,[{owner_id:OWNER,selection_id:SELECTION_ID}]);
  assert.deepEqual([done.status,done.body.ok,done.body.match,done.body.outcome_unchanged],[200,true,true,true]);
  assert.deepEqual(h.audits.map(item=>[item[0],item[1],item[2],item[3].selection_id,item[3].outcome]),[[OWNER,'qr4.selection_replayed',null,SELECTION_ID,'REPLAY_MATCH']]);
  const refused=await harness({script:stored('SELECTION_COMPLETED'),deps:{replay:async()=>({ok:false,code:'NOT_FOUND',detail:'NO_OUTCOME'})}}).call('POST',QR4_PATH+'/'+SELECTION_ID+'/replay',{body:{}});
  assert.deepEqual([refused.status,refused.body.code],[404,'NOT_FOUND']);
});

test('cancel of a stored selection: the status guard decides; a terminal selection is QR4_TRANSITION_INVALID and nothing is audited',async()=>{
  const script=stored('SELECTION_COMPLETED');
  const base=script.state.extra;
  script.state.extra=(text,params)=>{
    if(text.startsWith('SELECT selection_id FROM public.quant_selection_registrations WHERE selection_id'))return {rows:[{selection_id:params[0]}]};
    if(text.startsWith('SELECT seq,status FROM public.quant_selection_status_events'))return {rows:[{seq:3,status:'SELECTION_COMPLETED'}]};
    return base(text,params);
  };
  const h=harness({script});
  const answer=await h.call('POST',QR4_PATH+'/'+SELECTION_ID+'/cancel',{body:{confirmed:true}});
  assert.deepEqual([answer.status,answer.body.code],[409,'QR4_TRANSITION_INVALID']);
  assert.deepEqual(h.audits,[]);
});

/* ---- the universe and eligibility preview (Q4-C, SB213 item 3) ---- */

const PREVIEW=QR4_PATH+'/preview';
const PREVIEW_SCOPE=Object.freeze({market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},
  cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},capital:{equity:'1000',cash:'1000'},policy:{policy_version:'risk-v1',policy_hash:'a'.repeat(64)}});
/** A scripted database for the statements of the inputs reader when the universe is empty (or above the cap). */
function universeOf(runIds=[],over={}){
  const script=scripted(over);
  script.state.extra=text=>{
    if(text.startsWith('SELECT public.quant_selection_now_ms()'))return {rows:[{now_ms:'1900000000000'}]};
    if(text.startsWith('SELECT run_id FROM public.quant_jobs'))return {rows:runIds.map(run_id=>({run_id}))};
    if(text.startsWith('SELECT j.run_id,j.bot_id'))return {rows:[]};
    if(text.startsWith("SELECT to_regclass('public.bi_exports')"))return {rows:[{packages:true,boundaries:true}]};
    return null;
  };
  return script;
}

test('preview: flag off it is unhandled; with the flag on only POST is a method of it (GET, PUT, DELETE answer 405) and a refused shape reads nothing',async()=>{
  const off=harness({enabled:false});
  for(const method of ['GET','POST','PUT','DELETE']){
    const answer=await off.call(method,PREVIEW,{body:{}});
    assert.deepEqual([answer.handled,answer.status,answer.deferred],[false,null,false],method);
  }
  assert.equal(off.script.log.length,0);assert.deepEqual(off.authCalls,[]);
  const h=harness();
  for(const method of ['GET','PUT','DELETE','PATCH']){
    const answer=await h.call(method,PREVIEW,{body:{}});
    assert.deepEqual([answer.status,answer.body.code],[405,'METHOD_NOT_ALLOWED'],method);
  }
  assert.equal((await h.call('POST',PREVIEW+'/x',{body:{}})).status,403,'a deeper path is an action name, refused like any other');
  assert.equal(h.script.log.length,0);
  assert.deepEqual(ROUTE_ACTIONS,['register','cancel','replay_outcome','open_package','list','detail'],'preview is a view, not a seventh action');
});

test('preview: the body is refused in phase one with nothing read: forbidden words (a Bot, apply, start), rank-like keys, unknown keys, a bad fixture flag, a bad scope',async()=>{
  const h=harness({fixtureSelectionsAllowed:true});
  const refused=async(body,status,code,detail=null)=>{
    const answer=await h.call('POST',PREVIEW,{body});
    assert.deepEqual([answer.status,answer.body.code,answer.body.detail,answer.deferred,answer.phase1Statements],[status,code,detail,false,0],JSON.stringify(body).slice(0,100));
  };
  for(const key of ['bot_id','apply','import','start','email','alert','session','optimize'])await refused({[key]:'x'},403,'QR4_APPLY_REFUSED','ACTION_NOT_ALLOWED');
  for(const key of ['sort','order_by','rank','top','best','winner','leader','sortby','top10'])await refused({[key]:'net_return'},400,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE','BODY');
  for(const key of ['owner_id','limit','objective','window','filters','confirmed','universe','selection_id'])await refused({[key]:1},400,'INVALID_FIELDS','BODY');
  await refused({fixture:'yes'},400,'INVALID_FIELDS','FIXTURE');
  await refused({scope:'x'},400,'INVALID_FIELDS','SCOPE_KEYS');
  await refused({scope:{...PREVIEW_SCOPE,engine:'a'.repeat(64)}},400,'INVALID_FIELDS','SCOPE_KEYS');
  await refused({scope:{...PREVIEW_SCOPE,bot_id:'b'}},400,'INVALID_FIELDS','SCOPE_KEYS');
  await refused({scope:{...PREVIEW_SCOPE,market:{broker:'x',symbol:'BTCUSDT',timeframe:'1'}}},400,'BI_MARKET_SCOPE_INVALID','MARKET');
  await refused({scope:{...PREVIEW_SCOPE,data_model:undefined}},400,'QR4_SCOPE_INCOMPATIBLE','data_model');
  await refused({scope:{...PREVIEW_SCOPE,cost_model:[]}},400,'QR4_SCOPE_INCOMPATIBLE','cost_model');
  await refused({scope:{...PREVIEW_SCOPE,capital:{equity:'x',cash:'1'}}},400,'QR4_SCOPE_INCOMPATIBLE','capital');
  await refused({scope:{...PREVIEW_SCOPE,capital:{equity:'1',cash:1000}}},400,'QR4_SCOPE_INCOMPATIBLE','capital');
  await refused({scope:{...PREVIEW_SCOPE,policy:{policy_version:'risk-v1',policy_hash:'zz'}}},400,'QR4_SCOPE_INCOMPATIBLE','policy');
  await refused({scope:{...PREVIEW_SCOPE,policy:{policy_hash:'a'.repeat(64)}}},400,'QR4_SCOPE_INCOMPATIBLE','policy');
  const query=await h.call('POST',PREVIEW,{body:{},query:'?bot_id=b'});
  assert.deepEqual([query.status,query.body.code,query.body.detail,query.phase1Statements],[400,'INVALID_FIELDS','QUERY',0]);
  const ranked=await h.call('POST',PREVIEW,{body:{},query:'?sort=net_return'});
  assert.deepEqual([ranked.status,ranked.body.code],[400,'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE']);
  await assert.rejects(h.call('POST',PREVIEW,{body:{},csrf:false}),/CSRF/);
  const foreign=await harness({authorize:false}).call('POST',PREVIEW,{body:{}});
  assert.deepEqual([foreign.status,foreign.body.code,foreign.deferred],[404,'NOT_FOUND',false]);
  assert.equal(h.script.log.length,0);assert.deepEqual(h.audits,[]);
});

test('planPreview: the declared scope is normalised like the registration (capital), the fixture flag defaults to false and nothing else is carried',()=>{
  assert.deepEqual(planPreview({}),{ok:true,plan:{fixture:false,scope:null}});
  assert.deepEqual(planPreview({scope:null,fixture:true}),{ok:true,plan:{fixture:true,scope:null}});
  const plan=planPreview({scope:{...PREVIEW_SCOPE,capital:{equity:'1000.00',cash:'0500.50'}}});
  assert.equal(plan.ok,true);
  assert.deepEqual(plan.plan.scope.capital,{equity:'1000',cash:'500.5'});
  assert.deepEqual(Object.keys(plan.plan.scope).sort(),['capital','cost_model','data_model','policy'],'the market is checked and not carried');
  assert.deepEqual(plan.plan.scope.policy,PREVIEW_SCOPE.policy);
  assert.equal(planPreview([]).detail,'BODY');
  assert.equal(planPreview(null).detail,'BODY');
});

test('preview: a fixture preview needs the server flag before anything is read; without it the answer is 400 QR4_FIXTURE_PARTICIPANT',async()=>{
  const off=harness({script:universeOf()});
  const refused=await off.call('POST',PREVIEW,{body:{fixture:true}});
  assert.deepEqual([refused.status,refused.body.code,refused.body.detail,refused.deferred],[400,'QR4_FIXTURE_PARTICIPANT','FIXTURE_SELECTION_NOT_ALLOWED',false]);
  assert.equal(off.script.log.length,0);
  const on=harness({script:universeOf(),fixtureSelectionsAllowed:true});
  const done=await on.call('POST',PREVIEW,{body:{fixture:true}});
  assert.deepEqual([done.status,done.body.fixture],[200,true]);
});

test('preview of an empty universe: counts, the creation order marker, no scope check, READ ONLY statements only, no audit row and no registration wiring claimed',async()=>{
  const script=universeOf();
  const h=harness({script});
  const done=await h.call('POST',PREVIEW,{body:{}});
  assert.equal(done.status,200,JSON.stringify(done.body));
  assert.deepEqual(done.body,{ok:true,order:'CREATION',fixture:false,scope_declared:false,declared_scope:null,universe_cap:UNIVERSE_CAP,universe_count:0,participant_count:0,stale_count:0,excluded_count:0,
    min_participants:2,max_participants:4,registration_wired:false,members:[]});
  assert.equal(script.log[0].sql,'SET TRANSACTION READ ONLY');
  assert.ok(script.log.every(item=>!/^\s*(INSERT|UPDATE|DELETE|LOCK|CREATE|ALTER)/i.test(item.sql)),'no write statement');
  assert.deepEqual(h.audits,[],'a preview writes no audit row');
  const declared=await harness({script:universeOf(),deps:{engineHash:async()=>'b'.repeat(64)}}).call('POST',PREVIEW,{body:{scope:PREVIEW_SCOPE}});
  assert.deepEqual([declared.body.scope_declared,declared.body.registration_wired,declared.body.declared_scope.capital],[true,true,{equity:'1000',cash:'1000'}]);
  assert.equal('market' in declared.body.declared_scope,false);
  assert.deepEqual(developmentRowViolations(done.body),[],'no field name that reads as a rank, best, top, winner or leader');
});

test('preview: the owner id of the session is the only owner passed to the reader; a universe above the cap is QR4_UNIVERSE_TOO_LARGE and nothing is listed',async()=>{
  const script=universeOf();
  const h=harness({script});
  await h.call('POST',PREVIEW,{body:{}});
  const ids=script.log.find(item=>item.sql.startsWith('SELECT run_id FROM public.quant_jobs'));
  assert.equal(ids.params[0],OWNER);
  assert.equal(ids.params[3],false,'a customer preview leaves out labelled synthetic runs');
  const over=universeOf(Array.from({length:UNIVERSE_CAP+1},(_,index)=>'run-'+index));
  const refused=await harness({script:over}).call('POST',PREVIEW,{body:{}});
  assert.deepEqual([refused.status,refused.body.code,refused.body.detail,refused.body.universe_cap],[409,'QR4_UNIVERSE_TOO_LARGE',String(UNIVERSE_CAP+1),UNIVERSE_CAP]);
  assert.equal('members' in refused.body,false);
});

test('preview: with the schema absent the answer is QR4_SCHEMA_ABSENT (503)',async()=>{
  const answer=await harness({script:scripted({schema:false})}).call('POST',PREVIEW,{body:{}});
  assert.deepEqual([answer.status,answer.body.code],[503,'QR4_SCHEMA_ABSENT']);
});
