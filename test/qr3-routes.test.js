import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Readable} from 'node:stream';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {fixedEvalFixture} from './helpers/quant-fixed-eval-fixture.mjs';
import {qr3Routes,planCreate,qr3AuditFailureCount,READ_BUDGET,REFUSAL_CODES,QR3_PATH,QR3_CANCEL_EVENT} from '../src/postgres/qr3-routes.js';
import {validateSpec} from '../src/comparison/ranking.js';
import {resolvePeriod} from '../src/comparison/period.js';
import {requestKeyHash} from '../src/postgres/comparison-store.js';

// QR-3 S4 owner API over a STUB store: the route module, the dispatcher's deferred phase (emulated, as the real dispatcher runs res.phase2Deferred after COMMIT),
// a scripted database and a recording audit writer. The real store, the real auth and the real dispatcher run in test/postgres/qr3-routes.test.mjs.
// Contract 9.1 codes that only the store, the database or the real data can reach are listed in PG_ONLY; the PostgreSQL suite reaches each of them.
const MINUTE=60000;
const F=fixedEvalFixture();
const OWNER=F.owner;
const START=F.comparison.start_ms,END=F.comparison.end_ms;
const WARMUP=1006,FIRST=START-WARMUP*MINUTE+MINUTE,COUNT=(END-START)/MINUTE+WARMUP;
const PG_ONLY=['QR3_EXPOSURE_REGISTER_UNAVAILABLE'];
const UNREACHABLE=['QR3_PERIOD_NOT_PARTITION_ALIGNED'];
const reached=new Set();

const OK=Object.freeze({confirmed:true,request_key:'stub-key-1',fixture:true,mode:'STANDARDIZED',participants:[{run_id:'run-a'},{run_id:'run-b'}],
  market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},cost_model_version:'paper-close-v1',period:{choice:'CUSTOM',start_ms:START,end_ms:END},
  objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},
  benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}});
const with_=over=>{const body=structuredClone(OK);for(const [name,value] of Object.entries(over)){if(value===undefined)delete body[name];else body[name]=value;}return body;};

/** The parent runs: labelled fixtures by default; plain (unlabelled) when asked. */
function parentOf(source){
  const c=structuredClone(F.c);
  if(source){c.source=source;c.source_hash=hash(source);}
  return {c,contract_hash:hash(canonical(c))};
}
const LABELLED=parentOf(null),PLAIN=parentOf('//@version=6\nindicator("an owner source")');

function scripted(over={}){
  const state={owner:OWNER,gate:{library:true,comparison:true,modes:true,market:true},mode:'FOUNDATION',runs:{'run-a':LABELLED,'run-b':LABELLED},bytes:{},
    bounds:{first_time:FIRST,last_time:END},span:{n:COUNT,first_time:FIRST,last_time:END,bad:0,digest:hash('content')},times:null,
    spec:{owner:OWNER,id:'cmp-1'},seq:2,terminal:false,existing:null,throwOn:null,...over};
  const log=[];
  const db={isTransaction:false,
    async transaction(work,options={}){
      if(db.isTransaction)return work();
      db.isTransaction=true;
      try{return await work();}finally{db.isTransaction=false;}
    },
    async query(sql,params=[]){
      log.push({sql:String(sql),params});
      if(state.throwOn&&state.throwOn(sql))throw state.error;
      const text=String(sql);
      if(text==='SET TRANSACTION READ ONLY')return {rows:[]};
      if(text==="SELECT current_setting('transaction_read_only') AS mode")return {rows:[{mode:'on'}]};
      if(text.startsWith("SELECT to_regclass('public.quant_jobs')"))return {rows:[state.gate]};
      if(text.startsWith('SELECT mode FROM public.quant_research_executor_mode'))return {rows:[{mode:state.mode}]};
      if(text.startsWith('SELECT status,contract_hash'))return {rows:state.runs[params[0]]&&params[1]===state.owner?[{status:state.runs[params[0]].status??'SUCCEEDED',
        contract_hash:state.runs[params[0]].contract_hash,mode:null,contract_bytes:state.bytes[params[0]]??5000}]:[]};
      if(text.startsWith('SELECT run_id,bot_id,deployment_id,contract'))return {rows:state.runs[params[0]]&&params[1]===state.owner?[{run_id:params[0],bot_id:OWNER,
        deployment_id:F.parent.deployment_id,contract:state.runs[params[0]].c,selected:F.parent.result.selected.parameters}]:[]};
      if(text.startsWith('SELECT min(bar_time)'))return {rows:[state.bounds]};
      if(text.startsWith('SELECT count(*)::int n'))return {rows:[state.span]};
      if(text.startsWith('SELECT bar_time FROM'))return {rows:(state.times??[]).map(bar_time=>({bar_time}))};
      if(text.startsWith('SELECT comparison_id,spec_body_hash,frozen_at_ms FROM public.quant_comparison_specs'))return {rows:state.existing?[state.existing]:[]};
      if(text.startsWith('SELECT spec_hash,context_key FROM public.quant_comparison_specs'))return {rows:params[1]===state.spec.owner&&params[0]===state.spec.id?[{spec_hash:'0'.repeat(64),context_key:'0'.repeat(64)}]:[]};
      if(text.startsWith('SELECT comparison_id,owner_id,parent_comparison_id'))return {rows:[]};
      if(text.startsWith('SELECT max(seq)'))return {rows:[{seq:state.seq}]};
      if(text.startsWith('INSERT INTO public.quant_comparison_status_events')){
        if(state.terminal)throw Object.assign(Error('guard'),{code:'QR004',constraint:'quant_comparison_status_transition'});
        return {rows:[{at_ms:1234567890000}]};
      }
      throw Error('unscripted statement: '+text.slice(0,100));
    }};
  return {state,log,db};
}

/** The route plus the dispatcher's two phases. phase1Statements counts database statements before the deferred function runs (it must be zero). */
function harness(options={}){
  const {enabled=true,wired=true,script=scripted(),authorize=true}=options;
  const audits=[],authCalls=[];
  const store={db:script.db,async audit(...args){audits.push(args);if(options.auditFails)throw Error('audit down');}};
  const auth={async require(req){
    authCalls.push(req.method);
    if(req.method!=='GET'&&req.headers['x-csrf-token']!=='csrf-ok')throw Object.assign(Error('Invalid CSRF token'),{status:403});
    return {id:authorize?OWNER:'someone-else'};
  }};
  const deps=wired?{engineHash:async()=>hash('engine'),datasetDigest:async()=>hash('digest'),...options.deps}:undefined;
  async function call(method,path,{body,csrf=true,query=''}={}){
    const req=Readable.from([Buffer.from(JSON.stringify(body===undefined?{}:body))]);req.method=method;req.headers=csrf?{'x-csrf-token':'csrf-ok'}:{};
    const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null};
    let direct=null;
    const json=(target,status,value)=>{if(target.phase2Buffer){target.phase2Result={status,body:value};return;}direct={status,body:value};};
    const before=script.log.length;
    const handled=await qr3Routes(req,res,new URL(path+query,'http://localhost'),{id:OWNER},{store,auth,json,enabled,deps});
    const phase1Statements=script.log.length-before;
    let result=res.phase2Result;
    if(typeof res.phase2Deferred==='function')result=await res.phase2Deferred();
    if(result?.body?.code)reached.add(result.body.code);
    return {handled,status:result?.status??null,body:result?.body??null,phase1Statements,deferred:typeof res.phase2Deferred==='function'};
  }
  return {call,audits,authCalls,script};
}
const create=(over,options)=>harness(options).call('POST',QR3_PATH,{body:with_(over)});

/* ---- flag off, paths and methods ---- */

test('flag off: every path and method is unhandled, reads nothing and answers nothing (the router answers 404)',async()=>{
  const h=harness({enabled:false});
  for(const method of ['GET','POST','PUT','PATCH','DELETE'])for(const path of [QR3_PATH,QR3_PATH+'/cmp-1',QR3_PATH+'/cmp-1/cancel',QR3_PATH+'/cmp-1/replay',QR3_PATH+'/']){
    const answer=await h.call(method,path,{body:OK});
    assert.deepEqual([answer.handled,answer.status,answer.deferred],[false,null,false],method+' '+path);
  }
  assert.equal(h.script.log.length,0);assert.deepEqual(h.authCalls,[]);assert.deepEqual(h.audits,[]);
  // flag on: the neighbouring prefix is not ours
  const on=harness();
  for(const path of ['/api/quant/comparisonsX','/api/quant/library','/api/quant','/api/quant/comparison'])assert.equal((await on.call('GET',path)).handled,false,path);
});

test('flag on: exactly create, view and cancel; no other POST, no replay request, wrong methods answer 405, unknown shapes 404',async()=>{
  const h=harness();
  const posts=[],others=[];
  for(const path of [QR3_PATH,QR3_PATH+'/cmp-1',QR3_PATH+'/cmp-1/cancel',QR3_PATH+'/cmp-1/replay',QR3_PATH+'/cmp-1/cancel/extra',QR3_PATH+'/',QR3_PATH+'/cmp-1/start',QR3_PATH+'/cmp-1/apply']){
    const answer=await h.call('POST',path,{body:{}});
    (answer.status===404||answer.status===405?others:posts).push([path,answer.status]);
  }
  // only the collection (create, refused here for the missing confirm token, so 400) and the cancel path (a deferred answer) pass the method and path gate
  assert.deepEqual(posts.map(item=>item[0]),[QR3_PATH,QR3_PATH+'/cmp-1/cancel']);
  assert.deepEqual(Object.fromEntries(others),{[QR3_PATH+'/cmp-1']:405,[QR3_PATH+'/cmp-1/replay']:404,[QR3_PATH+'/cmp-1/cancel/extra']:404,[QR3_PATH+'/']:404,[QR3_PATH+'/cmp-1/start']:404,[QR3_PATH+'/cmp-1/apply']:404});
  for(const method of ['PUT','PATCH','DELETE','HEAD','OPTIONS']){
    for(const path of [QR3_PATH,QR3_PATH+'/cmp-1',QR3_PATH+'/cmp-1/cancel'])assert.equal((await h.call(method,path,{body:{}})).status,405,method+' '+path);
  }
  assert.equal((await h.call('GET',QR3_PATH)).status,405);
  assert.equal((await h.call('GET',QR3_PATH+'/cmp-1/cancel')).status,405);
  // the source has no route other than the three: one POST for the collection, one for cancel, one GET
  const text=await fs.readFile(new URL('../src/postgres/qr3-routes.js',import.meta.url),'utf8');
  assert.equal(/'(?:PUT|PATCH|DELETE)'/.test(text),false);
  assert.equal(/apply|optimi[sz]e|start-bot/i.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm,'')),false);
});

test('phase one writes and reads nothing: every database statement runs in the deferred phase, none for a refusal',async()=>{
  const h=harness();
  const view=await h.call('GET',QR3_PATH+'/cmp-1');
  assert.equal(view.deferred,true);assert.equal(view.phase1Statements,0);
  const cancel=await h.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{}});
  assert.equal(cancel.deferred,true);assert.equal(cancel.phase1Statements,0);
  const refused=await h.call('POST',QR3_PATH,{body:with_({confirmed:undefined})});
  assert.deepEqual([refused.deferred,refused.phase1Statements,refused.status],[false,0,400]);
  const good=await h.call('POST',QR3_PATH,{body:OK});
  assert.equal(good.deferred,true);assert.equal(good.phase1Statements,0);
});

test('CSRF and session: a POST without the token is refused by the canonical auth before any read; a GET asks the auth nothing; a foreign session answers 404',async()=>{
  const h=harness();
  await assert.rejects(h.call('POST',QR3_PATH,{body:OK,csrf:false}),{status:403});
  await assert.rejects(h.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{},csrf:false}),{status:403});
  assert.equal(h.script.log.length,0);
  await h.call('GET',QR3_PATH+'/cmp-1');
  assert.deepEqual(h.authCalls,['POST','POST']);
  const other=harness({authorize:false});
  for(const [method,path,body] of [['POST',QR3_PATH,OK],['POST',QR3_PATH+'/cmp-1/cancel',{}]]){
    const answer=await other.call(method,path,{body});
    assert.deepEqual([answer.status,answer.body.code],[404,'NOT_FOUND']);
  }
  assert.equal(other.script.log.length,0);
});

test('no field selects an owner, a user or a Bot: unknown body keys, participant keys and every query key are INVALID_FIELDS',async()=>{
  const h=harness();
  for(const key of ['user_id','owner_id','bot_id','comparison_id','deployment_id','replay','apply','email']){
    assert.equal((await create({[key]:'x'})).body.code,'INVALID_FIELDS',key);
    assert.equal((await h.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{[key]:'x'}})).body.code,'INVALID_FIELDS',key);
  }
  for(const key of ['user_id','owner_id','bot_id','participant_id']){
    assert.deepEqual((await create({participants:[{run_id:'run-a',[key]:'x'},{run_id:'run-b'}]})).body,{ok:false,code:'INVALID_FIELDS',detail:'PARTICIPANT_KEYS'});
  }
  for(const [method,path] of [['GET',QR3_PATH+'/cmp-1'],['POST',QR3_PATH],['POST',QR3_PATH+'/cmp-1/cancel']]){
    for(const query of ['?user_id=other','?owner_id=other','?bot_id=b','?x=1']){
      const answer=await h.call(method,path,{body:OK,query});
      assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[400,'INVALID_FIELDS','QUERY'],method+' '+path+query);
    }
  }
  assert.equal(h.script.log.length,0);
});

/* ---- contract 9.1: pure refusals, one input change each ---- */

const refusalOf=async(over,expectedCode,detail=null,status=400)=>{
  const answer=await create(over);
  assert.deepEqual([answer.status,answer.body.ok,answer.body.code,answer.body.detail],[status,false,expectedCode,detail],JSON.stringify(answer.body).slice(0,300));
  return answer;
};

test('9.1 pure refusals: each code is reached by exactly one change of an otherwise accepted request',async()=>{
  // the accepted request itself reaches the store (which the scripted database answers as an existing key: same spec is covered below)
  assert.equal(planCreate(OK).ok,true);
  await refusalOf({confirmed:undefined},'QR3_CONFIRMATION_REQUIRED');
  await refusalOf({confirmed:'yes'},'QR3_CONFIRMATION_REQUIRED');
  await refusalOf({confirmed:false},'QR3_CONFIRMATION_REQUIRED');
  await refusalOf({mode:undefined},'QR3_MODE_REQUIRED');
  await refusalOf({mode:'BOTH'},'QR3_MODE_REQUIRED');
  await refusalOf({participants:[{run_id:'run-a'},{run_id:'run-b',mode:'ACTUAL_BOT'}]},'QR3_MODE_MIX');
  await refusalOf({participants:[{run_id:'run-a'}]},'QR3_PARTICIPANT_COUNT');
  await refusalOf({participants:['a','b','c','d','e'].map(run_id=>({run_id}))},'QR3_PARTICIPANT_COUNT');
  await refusalOf({participants:[{run_id:'run-a'},{run_id:'bad id'}]},'INVALID_RUN_ID');
  await refusalOf({participants:[{run_id:'run-a'},{}]},'INVALID_RUN_ID');
  await refusalOf({participants:[{run_id:'run-a'},{run_id:'run-a'}]},'DUPLICATE_RUN_ID');
  await refusalOf({participants:'run-a'},'INVALID_FIELDS','PARTICIPANTS');
  await refusalOf({participants:[{run_id:'run-a'},'run-b']},'INVALID_FIELDS','PARTICIPANT_SHAPE');
  await refusalOf({market:{broker:'binance-global',symbol:'ETHUSDT',timeframe:'1'}},'QR3_MARKET_UNSUPPORTED');
  await refusalOf({market:{broker:'binance-th',symbol:'BTCUSDT',timeframe:'1'}},'QR3_MARKET_UNSUPPORTED');
  await refusalOf({market:undefined},'QR3_MARKET_UNSUPPORTED');
  await refusalOf({market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'5'}},'QR3_TIMEFRAME_UNSUPPORTED');
  await refusalOf({cost_model_version:'paper-close-v2'},'QR3_COST_MODEL_UNSUPPORTED');
  await refusalOf({cost_model_version:undefined},'QR3_COST_MODEL_UNSUPPORTED');
  await refusalOf({fixture:false,participants:[{run_id:'run-a',fixture:true},{run_id:'run-b'}]},'QR3_FIXTURE_PARTICIPANT');
  await refusalOf({fixture:undefined,participants:[{run_id:'run-a'},{run_id:'run-b',fixture:true}]},'QR3_FIXTURE_PARTICIPANT');
  await refusalOf({participants:[{run_id:'run-a',fixture:false},{run_id:'run-b'}]},'INVALID_FIELDS','PARTICIPANT_FIXTURE');
  await refusalOf({mode:'ACTUAL_BOT',objective:undefined},'QR3_ACTUAL_BOT_UNAVAILABLE',null,503);
  await refusalOf({mode:'ACTUAL_BOT',objective:'qr3-obj-net-return-v1'},'QR3_OBJECTIVE_NOT_ALLOWED');
  await refusalOf({period:undefined},'QR3_PERIOD_INVALID','PERIOD');
  await refusalOf({period:{choice:'FORTNIGHT'}},'QR3_PERIOD_INVALID','CHOICE_UNKNOWN');
  await refusalOf({period:{choice:'CUSTOM',start_ms:'0',end_ms:END}},'QR3_PERIOD_INVALID','BOUND_TYPE');
  await refusalOf({period:{choice:'CUSTOM',start_ms:START,end_ms:END,warmup:5}},'INVALID_FIELDS','PERIOD_KEYS');
  await refusalOf({objective:'qr3-obj-sharpe'},'QR3_OBJECTIVE_UNKNOWN');
  await refusalOf({objective:undefined},'QR3_SPEC_INCOMPLETE','objective');
  await refusalOf({risk_filter:undefined},'QR3_SPEC_INCOMPLETE','risk_filter');
  await refusalOf({adequacy:undefined},'QR3_SPEC_INCOMPLETE','adequacy');
  await refusalOf({tie:undefined},'QR3_SPEC_INCOMPLETE','tie');
  await refusalOf({benchmark:undefined},'QR3_SPEC_INCOMPLETE','benchmark');
  await refusalOf({benchmark:'something-else'},'QR3_SPEC_INCOMPLETE','benchmark');
  await refusalOf({uncertainty:undefined},'QR3_SPEC_INCOMPLETE','uncertainty');
  await refusalOf({risk_filter:{max_drawdown_percent:20}},'QR3_SPEC_INCOMPLETE','NUMBER_NOT_DECIMAL_STRING');
  await refusalOf({risk_filter:{max_drawdown_percent:'25'}},'QR3_FILTER_LOOSENED','max_drawdown_percent');
  await refusalOf({adequacy:{min_episodes_floor:4,min_episodes_ranking:20}},'QR3_FILTER_LOOSENED','min_episodes');
  await refusalOf({adequacy:{min_episodes_floor:5,min_episodes_ranking:10}},'QR3_FILTER_LOOSENED','min_episodes');
  await refusalOf({tie:{band_pp:'0.25'}},'QR3_FILTER_LOOSENED','tie_band_pp');
  // OPEN-1 and OPEN-2 stay fail closed: a wider tie band is refused TIE_BAND_FIXED and no outcome other than the fail-closed ones exists
  await refusalOf({tie:{band_pp:'0.75'}},'QR3_SPEC_INCOMPLETE','TIE_BAND_FIXED');
  await refusalOf({unknown_field:1},'INVALID_FIELDS','BODY');
  // the owner may tighten: a lower drawdown limit, more episodes and an approved uncertainty method are accepted by the pure checks
  assert.equal(planCreate(with_({risk_filter:{max_drawdown_percent:'10'},adequacy:{min_episodes_floor:8,min_episodes_ranking:30}})).ok,true);
  assert.equal(planCreate(with_({uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'7',resamples:100,block_length:5,confidence:'0.95'}})).ok,true);
  // an arbitrary non-object body never reaches the plan
  for(const body of [null,[],'text',7])assert.equal(planCreate(body).code,'INVALID_FIELDS');
});

/* ---- contract 9.1: refusals that need the scripted database ---- */

test('9.1 database refusals: schema, library, admission, wiring, owner scope, budget, parents, period and dataset',async()=>{
  const run=(over,options)=>create(over,options);
  const expect=(answer,status,code,detail=null)=>assert.deepEqual([answer.status,answer.body.code,answer.body.detail],[status,code,detail],JSON.stringify(answer.body).slice(0,300));
  // gates
  expect(await run({},{script:scripted({gate:{library:true,comparison:false,modes:true,market:true}})}),503,'QR3_SCHEMA_ABSENT');
  expect(await run({},{script:scripted({gate:{library:false,comparison:true,modes:true,market:true}})}),503,'QUANT_LIBRARY_UNAVAILABLE');
  expect(await run({},{script:scripted({mode:'LEGACY'})}),409,'QR3_ADMISSION_CLOSED','EXECUTOR_MODE');
  expect(await run({},{wired:false}),409,'QR3_ADMISSION_CLOSED','CREATE_NOT_WIRED');
  expect(await run({},{deps:{datasetDigest:undefined}}),409,'QR3_ADMISSION_CLOSED','CREATE_NOT_WIRED');
  // owner scope on every participant: a foreign run and an absent run answer alike, whatever its position
  const foreign=scripted();foreign.state.runs['run-b']=undefined;
  const first=await run({},{script:foreign});
  expect(first,404,'NOT_FOUND');
  const absent=await run({participants:[{run_id:'run-a'},{run_id:'run-zzz'}]});
  assert.deepEqual(absent.body,first.body,'foreign and absent are one answer');
  const lead=await run({participants:[{run_id:'run-zzz'},{run_id:'run-b'}]});
  assert.deepEqual(lead.body,first.body);
  const wrongOwner=scripted({owner:'another-owner'});
  expect(await run({},{script:wrongOwner}),404,'NOT_FOUND');
  // every participant lookup is scoped to the session user
  const probe=scripted();await run({},{script:probe});
  const lookups=probe.log.filter(entry=>entry.sql.startsWith('SELECT status,contract_hash')||entry.sql.startsWith('SELECT run_id,bot_id'));
  assert.ok(lookups.length>=4&&lookups.every(entry=>entry.params[1]===OWNER),'every parent read carries the owner');
  // eligibility
  const running=scripted();running.state.runs['run-b']={...LABELLED,status:'RUNNING'};
  expect(await run({},{script:running}),400,'INVALID_FIELDS','PARTICIPANT_NOT_SUCCEEDED');
  // read budget: one contract over the fixed byte budget (429)
  const big=scripted({bytes:{'run-b':READ_BUDGET.max_contract_bytes+1}});
  const over=await run({},{script:big});
  assert.deepEqual([over.status,over.body.code,over.body.detail,over.body.budget],[429,'QR3_READ_BUDGET_EXCEEDED','CONTRACT_BYTES',READ_BUDGET]);
  assert.deepEqual([READ_BUDGET.min_participants,READ_BUDGET.max_participants],[2,4]);
  const edge=scripted({bytes:{'run-b':READ_BUDGET.max_contract_bytes}});
  assert.notEqual((await run({},{script:edge})).status,429,'the budget itself is allowed');
  // the parent contract
  const multi=parentOf(null);multi.c.snapshot.membership=[...multi.c.snapshot.membership,{...multi.c.snapshot.membership[0]}];multi.contract_hash=hash(canonical(multi.c));
  expect(await run({},{script:scripted({runs:{'run-a':LABELLED,'run-b':multi}})}),409,'MULTI_PINE_RESEARCH_NOT_SUPPORTED');
  const eth=parentOf(null);eth.c.snapshot.market={broker:'binance-global',symbol:'ETHUSDT',timeframe:'1'};eth.contract_hash=hash(canonical(eth.c));
  expect(await run({},{script:scripted({runs:{'run-a':LABELLED,'run-b':eth}})}),400,'QR3_MARKET_UNSUPPORTED');
  const slow=parentOf(null);slow.c.snapshot.market={broker:'binance-global',symbol:'BTCUSDT',timeframe:'5'};slow.contract_hash=hash(canonical(slow.c));
  expect(await run({},{script:scripted({runs:{'run-a':LABELLED,'run-b':slow}})}),400,'QR3_TIMEFRAME_UNSUPPORTED');
  const costly=parentOf(null);costly.c.model.version='paper-close-v2';costly.contract_hash=hash(canonical(costly.c));
  expect(await run({},{script:scripted({runs:{'run-a':LABELLED,'run-b':costly}})}),400,'QR3_COST_MODEL_UNSUPPORTED');
  const tampered={...LABELLED,contract_hash:hash('another contract')};
  expect(await run({},{script:scripted({runs:{'run-a':LABELLED,'run-b':tampered}})}),409,'QR3_INTEGRITY_FAILED','PARTICIPANT_CONTRACT_HASH');
  const invalid=parentOf(null);invalid.c.version='ql3a-research-job-v9';invalid.contract_hash=hash(canonical(invalid.c));
  expect(await run({},{script:scripted({runs:{'run-a':LABELLED,'run-b':invalid}})}),400,'INVALID_FIELDS','PARTICIPANT_CONTRACT');
  // a labelled synthetic fixture parent is refused in a comparison that is not declared a fixture
  expect(await run({fixture:false}),400,'QR3_FIXTURE_PARTICIPANT','LABELLED_PARTICIPANT');
  // period
  expect(await run({period:{choice:'CUSTOM',start_ms:END,end_ms:START}}),400,'QR3_PERIOD_INVALID','END_NOT_AFTER_START');
  expect(await run({period:{choice:'CUSTOM',start_ms:START+1,end_ms:END}}),400,'QR3_PERIOD_INVALID','BOUND_NOT_ALIGNED');
  expect(await run({period:{choice:'YTD',start_ms:START,end_ms:END}}),400,'QR3_PERIOD_INVALID','YTD_START_FIXED');
  const future=await run({period:{choice:'CUSTOM',start_ms:START,end_ms:END+MINUTE}});
  assert.deepEqual([future.status,future.body.code,future.body.end_ms,future.body.last_completed_end_ms],[400,'QR3_PERIOD_IN_FUTURE',END+MINUTE,END]);
  const wide=scripted({bounds:{first_time:FIRST,last_time:START+9000*MINUTE}});
  const range=await run({period:{choice:'CUSTOM',start_ms:START,end_ms:START+9000*MINUTE}},{script:wide});
  assert.deepEqual([range.status,range.body.code,range.body.total_bars,range.body.limit],[400,'QR3_RANGE_ADMISSION_REFUSED',10006,10000]);
  // dataset
  expect(await run({},{script:scripted({gate:{library:true,comparison:true,modes:true,market:false}})}),409,'QR3_DATASET_UNAVAILABLE','NO_MARKET_TABLE');
  expect(await run({},{script:scripted({bounds:{first_time:null,last_time:null}})}),409,'QR3_DATASET_UNAVAILABLE','NO_BARS');
  expect(await run({},{script:scripted({span:{n:0,first_time:null,last_time:null,bad:0,digest:null}})}),409,'QR3_DATASET_UNAVAILABLE','NO_BARS');
  expect(await run({},{script:scripted({span:{n:COUNT,first_time:FIRST,last_time:END,bad:1,digest:hash('c')}})}),409,'QR3_DATASET_UNAVAILABLE','UNVERIFIED_BARS');
  expect(await run({},{deps:{datasetDigest:async()=>null}}),409,'QR3_DATASET_UNAVAILABLE','DIGEST');
  expect(await run({},{deps:{engineHash:async()=>'nope'}}),409,'QR3_DATASET_UNAVAILABLE','ENGINE_HASH');
  // a gap: close times from FIRST to END with one minute missing in the middle
  const times=[];for(let t=FIRST;t<=END;t+=MINUTE)if(t!==FIRST+500*MINUTE)times.push(t);
  const gapped=await run({},{script:scripted({span:{n:COUNT-1,first_time:FIRST,last_time:END,bad:0,digest:hash('c')},times})});
  assert.deepEqual([gapped.status,gapped.body.code,gapped.body.gaps],[409,'QR3_DATASET_GAPPED',[{start_ms:FIRST+499*MINUTE,end_ms:FIRST+500*MINUTE}]]);
  // a late first bar is a gap at the start, not an accepted shorter window
  const late=[];for(let t=FIRST+10*MINUTE;t<=END;t+=MINUTE)late.push(t);
  const startGap=await run({},{script:scripted({span:{n:COUNT-10,first_time:FIRST+10*MINUTE,last_time:END,bad:0,digest:hash('c')},times:late})});
  assert.deepEqual([startGap.status,startGap.body.code,startGap.body.gaps[0].start_ms],[409,'QR3_DATASET_GAPPED',FIRST-MINUTE]);
  // a platform error and a serialization failure never leak: fixed answers
  const broken=scripted({throwOn:sql=>sql.startsWith('SELECT min(bar_time)')});broken.state.error=Object.assign(Error('connection to host 10.1.2.3 refused'),{code:'08006'});
  const down=await run({},{script:broken});
  assert.deepEqual([down.status,down.body],[503,{ok:false,code:'QUANT_LIBRARY_UNAVAILABLE',detail:null}]);
  const clash=scripted({throwOn:sql=>sql.startsWith('SELECT min(bar_time)')});clash.state.error=Object.assign(Error('could not serialize'),{code:'40001'});
  const retry=await run({},{script:clash});
  assert.deepEqual([retry.status,retry.body.code],[409,'RETRY_TRANSACTION']);
});

test('create reaches the store with the owner and a request key: a repeat of the same frozen spec is the same comparison, a reused key with another spec is refused; no audit row for a repeat',async()=>{
  // the spec the route freezes: the same period the pure resolver gives, the same fields
  const period=resolvePeriod({choice:'CUSTOM',start_ms:START,end_ms:END,last_completed_end_ms:END,available_start_ms:FIRST,warmup_bars:WARMUP}).period;
  const spec=validateSpec({mode:'STANDARDIZED',participants:['run-a','run-b'],period:structuredClone(period),objective:OK.objective,risk_filter:OK.risk_filter,adequacy:OK.adequacy,tie:OK.tie,
    benchmark:OK.benchmark,uncertainty:OK.uncertainty});
  assert.equal(spec.ok,true);
  const body=hash(canonical(spec.spec));
  const same=harness({script:scripted({existing:{comparison_id:'cmp-existing',spec_body_hash:body,frozen_at_ms:1700000000000}})});
  const again=await same.call('POST',QR3_PATH,{body:OK});
  assert.deepEqual([again.status,again.body.ok,again.body.existing,again.body.same_spec,again.body.comparison_id,again.body.evaluation_started],[200,true,true,true,'cmp-existing',false]);
  assert.deepEqual(same.audits,[]);
  const keyLookup=same.script.log.find(entry=>entry.sql.startsWith('SELECT comparison_id,spec_body_hash'));
  assert.deepEqual(keyLookup.params,[OWNER,requestKeyHash('stub-key-1')]);
  const other=harness({script:scripted({existing:{comparison_id:'cmp-existing',spec_body_hash:hash('another spec'),frozen_at_ms:1700000000000}})});
  const clash=await other.call('POST',QR3_PATH,{body:OK});
  assert.deepEqual([clash.status,clash.body.code,clash.body.detail],[409,'QR3_SPEC_IMMUTABLE','REQUEST_KEY_REUSED']);
  assert.deepEqual(other.audits,[]);
});

/* ---- view and cancel ---- */

test('view: foreign, absent and malformed ids answer one 404; the view runs one READ ONLY transaction and writes nothing',async()=>{
  const h=harness();
  const answers=[];
  for(const id of ['cmp-1','absent-1','bad%20id','a'.repeat(200)])answers.push(await h.call('GET',QR3_PATH+'/'+id));
  for(const answer of answers)assert.deepEqual([answer.status,answer.body],[404,{ok:false,code:'NOT_FOUND',detail:null}]);
  const foreign=harness({script:scripted({spec:{owner:'another-owner',id:'cmp-1'}})});
  assert.deepEqual((await foreign.call('GET',QR3_PATH+'/cmp-1')).body,answers[0].body);
  for(const entry of h.script.log)assert.equal(/^(INSERT|UPDATE|DELETE|LOCK)/i.test(entry.sql),false,entry.sql);
  assert.ok(h.script.log.some(entry=>entry.sql==='SET TRANSACTION READ ONLY'));
  const reads=h.script.log.filter(entry=>entry.sql.startsWith('SELECT comparison_id,owner_id,parent_comparison_id'));
  assert.ok(reads.length>=1&&reads.every(entry=>entry.params[1]===OWNER));
  const noSchema=harness({script:scripted({gate:{library:true,comparison:false,modes:true,market:true}})});
  assert.deepEqual([(await noSchema.call('GET',QR3_PATH+'/cmp-1')).body.code],['QR3_SCHEMA_ABSENT']);
});

test('cancel: an owned open comparison is CANCELLED and audited once; a terminal one is QR3_NOT_CANCELLABLE with no audit; foreign and absent are one 404',async()=>{
  const ok=harness();
  const done=await ok.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{}});
  assert.deepEqual([done.status,done.body.ok,done.body.status,done.body.seq,done.body.exposure_events],[200,true,'CANCELLED',3,'KEPT']);
  assert.equal(done.body.at_utc,new Date(1234567890000).toISOString());
  assert.deepEqual(ok.audits,[[OWNER,QR3_CANCEL_EVENT,null,{comparison_id:'cmp-1',status:'CANCELLED',seq:3,outcome:'CANCELLED'}]]);
  const terminal=harness({script:scripted({terminal:true})});
  const refused=await terminal.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{}});
  assert.deepEqual([refused.status,refused.body],[409,{ok:false,code:'QR3_NOT_CANCELLABLE',detail:null}]);
  assert.deepEqual(terminal.audits,[]);
  const foreign=harness({script:scripted({spec:{owner:'another-owner',id:'cmp-1'}})});
  const missing=await foreign.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{}});
  const absent=await harness().call('POST',QR3_PATH+'/cmp-9/cancel',{body:{}});
  assert.deepEqual([missing.status,absent.status],[404,404]);
  assert.deepEqual(missing.body,absent.body);
  assert.deepEqual(foreign.audits,[]);
});

test('a failed audit write after a committed cancel is counted and never changes the answer',async()=>{
  const before=qr3AuditFailureCount();
  const h=harness({auditFails:true});
  const done=await h.call('POST',QR3_PATH+'/cmp-1/cancel',{body:{}});
  assert.deepEqual([done.status,done.body.ok,done.body.status],[200,true,'CANCELLED']);
  assert.equal(qr3AuditFailureCount(),before+1);
});

test('contract 9.1 coverage: the stub suite reaches every code except the store-only and the unreachable ones, which are named',()=>{
  const names=new Set(REFUSAL_CODES);
  for(const code of PG_ONLY)assert.ok(names.has(code),code);
  for(const code of UNREACHABLE)assert.ok(names.has(code),code);
  assert.equal(names.size,REFUSAL_CODES.length,'no duplicate');
  assert.equal(names.size,32,'the 32 codes of contract 9.1');
  const missing=REFUSAL_CODES.filter(code=>!reached.has(code)&&!PG_ONLY.includes(code)&&!UNREACHABLE.includes(code));
  assert.deepEqual(missing,[],'codes not reached by any stub case');
  // QR3_PERIOD_NOT_PARTITION_ALIGNED belongs to the stored-result view (M4), which none of the three routes serves
  assert.equal(reached.has('QR3_PERIOD_NOT_PARTITION_ALIGNED'),false);
});
