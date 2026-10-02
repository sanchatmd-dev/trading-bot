import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseAiQuota,aiLimitFor,enforceAiQuota,describeAiQuota} from '../src/postgres/ai-quota.js';
import {PineBridgeService,pineBridgeRoutes} from '../src/postgres/pine-bridge.js';

const DAY=86400000;
const source='//@version=6\nindicator("Fixture")\nlength=input.int(10, minval=1, maxval=20)\nbuy=ta.crossover(close,ta.ema(close,length))\nsell=ta.crossunder(close,ta.ema(close,length))';
const provider=()=>({provider:'fixture',model:'fixture',inputRate:.1,outputRate:.2,rateVersion:'fixture-v1'});

// A small in-memory stand-in for the jobs table: only the statements enqueue() runs before and including the insert.
function fakeBridge({plan='FREE',aiQuota=null,jobs=[]}={}){
  const audits=[],queries=[];
  const answer=(sql,params,mode)=>{
    queries.push(sql);
    if(/FROM pine_bridge_jobs WHERE owner_id=\? AND bot_id=\? AND operation=\? AND idempotency_key=\?/.test(sql))
      return jobs.find(job=>job.owner_id===params[0]&&job.bot_id===params[1]&&job.operation===params[2]&&job.idempotency_key===params[3]);
    if(/SELECT count\(\*\) AS used FROM pine_bridge_jobs/.test(sql))
      return {used:jobs.filter(job=>job.owner_id===params[0]&&job.operation===params[1]&&job.created_at>params[2]).length};
    if(/count\(\*\) total,count\(\*\) FILTER/.test(sql))return {total:0,own:0};
    if(/COALESCE\(max\(id\),0\) cutoff FROM paper_funding/.test(sql))return {cutoff:0};
    if(/^\s*INSERT INTO pine_bridge_jobs/.test(sql)){
      const [job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,created_at,,deadline]=params;
      jobs.push({job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request:JSON.parse(request),pine_import_id,created_at,deadline,
        status:'QUEUED',attempt:0,usage:[],result:null,diagnostic:null});
      return {changes:1};
    }
    return mode==='all'?[]:mode==='run'?{changes:1}:undefined;
  };
  const db={lock:async()=>{},prepare:sql=>({get:async(...p)=>answer(sql,p,'get'),all:async(...p)=>answer(sql,p,'all'),run:async(...p)=>answer(sql,p,'run')})};
  const state={plan};
  const store={db,ownsBot:async()=>true,userById:async id=>({id,status:'ACTIVE'}),activePlan:async()=>state.plan,
    getBotSession:async()=>({state:'SETUP',run_id:null,locked_policy:null}),risk:async()=>({}),paperAccounts:async()=>[],
    audit:async(...entry)=>{audits.push(entry);}};
  return {service:new PineBridgeService(store,{getProvider:provider,aiQuota}),store,db,jobs,audits,queries,state};
}
const analyzeBody=(bot='owner-1')=>({bot_id:bot,pine_source:source,source_name:'Fixture'});
const generateBody=(bot='owner-1')=>({bot_id:bot,pine_import_id:'12345678-1234-1234-1234-123456789abc',source_version:1,selected_signals:{},parameter_slots:[],bridge_options:{},market:{}});
const row=(overrides={})=>({job_id:'job-'+Math.random(),owner_id:'owner-1',bot_id:'owner-1',operation:'analyze',idempotency_key:'seed-'+Math.random(),created_at:Date.now(),status:'SUCCEEDED',...overrides});

test('PINE_BRIDGE_AI_QUOTA: absent, blank and limit-free configs disable the quota',()=>{
  for(const value of [undefined,null,'','   ','\n','{}','{"default":{}}','{"plans":{}}','{"default":{},"plans":{"pro":{}}}'])
    assert.equal(parseAiQuota(value),null,JSON.stringify(value));
  assert.equal(describeAiQuota(null),'AI quota disabled');
});

test('PINE_BRIDGE_AI_QUOTA: a valid config parses; plan names ignore case; zero is a real limit',()=>{
  const config=parseAiQuota('{"default":{"analyze_per_day":20,"generate_per_day":10},"plans":{"pro":{"analyze_per_day":100},"Free ":{"generate_per_day":0}}}');
  assert.ok(Object.isFrozen(config));
  assert.deepEqual({...config.default},{analyze_per_day:20,generate_per_day:10});
  assert.deepEqual([...config.plans.keys()].sort(),['FREE','PRO']);
  assert.equal(parseAiQuota('{"default":{"generate_per_day":0}}').default.generate_per_day,0);
  assert.equal(parseAiQuota('{"plans":{"PRO":{"analyze_per_day":5}}}').plans.get('PRO').analyze_per_day,5);
  assert.match(describeAiQuota(config),/^AI quota enabled \(default limits, 2 plan entries\)$/);
  assert.ok(!describeAiQuota(config).includes('100'),'the log line carries no limit values');
});

test('PINE_BRIDGE_AI_QUOTA: every malformed config fails with a clear message and never disables silently',()=>{
  const bad=[
    ['not json','{'],['unquoted key','{default:1}'],['array','[]'],['null literal','null'],['number literal','5'],['string literal','"x"'],
    ['unknown top-level key','{"defaults":{"analyze_per_day":1}}'],['typo in limit field','{"default":{"analyze_per_days":1}}'],
    ['unknown limit field in a plan','{"plans":{"pro":{"edit_per_day":1}}}'],
    ['default is not an object','{"default":5}'],['default is null','{"default":null}'],['default is an array','{"default":[]}'],
    ['plans is not an object','{"plans":[]}'],['plan limits are not an object','{"plans":{"pro":5}}'],
    ['negative','{"default":{"analyze_per_day":-1}}'],['fraction','{"default":{"analyze_per_day":1.5}}'],['string number','{"default":{"analyze_per_day":"5"}}'],
    ['boolean','{"default":{"analyze_per_day":true}}'],['null limit','{"default":{"analyze_per_day":null}}'],['too large','{"default":{"analyze_per_day":1000001}}'],
    ['huge exponent','{"default":{"analyze_per_day":1e30}}'],['empty plan name','{"plans":{"":{"analyze_per_day":1}}}'],['blank plan name','{"plans":{"  ":{"analyze_per_day":1}}}'],
    ['control character in plan name','{"plans":{"pro\u0007":{"analyze_per_day":1}}}'],['plan name too long','{"plans":{"'+'p'.repeat(65)+'":{"analyze_per_day":1}}}'],
    ['plan listed twice with different case','{"plans":{"pro":{"analyze_per_day":1},"PRO":{"analyze_per_day":2}}}']
  ];
  for(const [name,value] of bad)assert.throws(()=>parseAiQuota(value),error=>{
    assert.ok(error instanceof Error,name);assert.match(error.message,/^Invalid PINE_BRIDGE_AI_QUOTA: .{10,}/,name);return true;
  },name);
  assert.throws(()=>parseAiQuota(5),/must be a JSON string/);
});

test('limit lookup: default, plan override, per-field inheritance, case-insensitive plan, unlimited kinds',()=>{
  const config=parseAiQuota('{"default":{"analyze_per_day":20,"generate_per_day":10},"plans":{"pro":{"analyze_per_day":100},"team":{"generate_per_day":0}}}');
  assert.equal(aiLimitFor(config,'FREE','analyze'),20);assert.equal(aiLimitFor(config,'FREE','generate'),10);
  assert.equal(aiLimitFor(config,'PRO','analyze'),100);assert.equal(aiLimitFor(config,'pro','analyze'),100);assert.equal(aiLimitFor(config,' Pro ','analyze'),100);
  assert.equal(aiLimitFor(config,'PRO','generate'),10,'a plan inherits the default for fields it does not name');
  assert.equal(aiLimitFor(config,'TEAM','generate'),0);assert.equal(aiLimitFor(config,'TEAM','analyze'),20);
  assert.equal(aiLimitFor(config,undefined,'analyze'),20);assert.equal(aiLimitFor(config,'ENTERPRISE','generate'),10);
  const onlyAnalyze=parseAiQuota('{"default":{"analyze_per_day":3}}');
  assert.equal(aiLimitFor(onlyAnalyze,'FREE','generate'),null,'a kind without a configured limit is unlimited');
  const onlyPlan=parseAiQuota('{"plans":{"pro":{"analyze_per_day":3}}}');
  assert.equal(aiLimitFor(onlyPlan,'FREE','analyze'),null);assert.equal(aiLimitFor(onlyPlan,'PRO','analyze'),3);
  assert.equal(aiLimitFor(null,'PRO','analyze'),null);assert.equal(aiLimitFor(config,'PRO','other'),null);
});

test('enforceAiQuota: disabled is a no-op that touches nothing',async()=>{
  const touched=[];
  const store={activePlan:async()=>{touched.push('plan');return 'FREE';}},db={prepare:()=>{touched.push('sql');throw new Error('no query expected');}};
  await enforceAiQuota({db,store,config:null,owner:'o',operation:'analyze'});
  await enforceAiQuota({db,store,config:parseAiQuota(''),owner:'o',operation:'generate'});
  assert.deepEqual(touched,[]);
  // A kind without a limit does not query the jobs table either.
  await enforceAiQuota({db,store,config:parseAiQuota('{"default":{"analyze_per_day":1}}'),owner:'o',operation:'generate'});
  assert.deepEqual(touched,['plan']);
});

test('enforceAiQuota: under the limit passes, at the limit throws 429 AI_QUOTA_EXCEEDED with a clear message',async()=>{
  const config=parseAiQuota('{"default":{"analyze_per_day":2,"generate_per_day":1}}');
  const {store,db,jobs}=fakeBridge();
  const check=(owner='owner-1',operation='analyze')=>enforceAiQuota({db,store,config,owner,operation});
  await check();
  jobs.push(row());await check();
  jobs.push(row());
  await assert.rejects(check(),error=>{
    assert.equal(error.code,'AI_QUOTA_EXCEEDED');assert.equal(error.status,429);
    assert.equal(error.message,'You reached the limit of 2 AI analyses per 24 hours on your FREE plan. Try again later.');return true;
  });
  // The kinds are counted separately: two analyses leave generate untouched.
  await check('owner-1','generate');
  jobs.push(row({operation:'generate'}));
  await assert.rejects(check('owner-1','generate'),{code:'AI_QUOTA_EXCEEDED',status:429,message:/limit of 1 AI generations per 24 hours/});
  // Another owner has their own count.
  await check('owner-2');
  // Zero means the plan has none of that kind.
  await assert.rejects(enforceAiQuota({db,store,config:parseAiQuota('{"default":{"generate_per_day":0}}'),owner:'owner-9',operation:'generate'}),
    {code:'AI_QUOTA_EXCEEDED',status:429,message:'Your FREE plan does not include AI generations.'});
});

test('enforceAiQuota: counts only the owner trailing 24 hours of the same kind, in any status',async()=>{
  const config=parseAiQuota('{"default":{"analyze_per_day":3}}');
  const now=1_800_000_000_000;
  const {store,db,jobs,queries}=fakeBridge();
  const check=()=>enforceAiQuota({db,store,config,owner:'owner-1',operation:'analyze',now});
  // Jobs at or before the 24 hour edge are outside the window.
  jobs.push(row({created_at:now-DAY-1}),row({created_at:now-DAY}),row({created_at:now-2*DAY}));
  await check();
  jobs.push(row({created_at:now-DAY+1,status:'FAILED'}),row({created_at:now-1000,status:'CANCELLED'}),row({created_at:now,status:'QUEUED'}));
  await assert.rejects(check(),{code:'AI_QUOTA_EXCEEDED'},'every status counts');
  // Rows of another owner or another kind never count.
  jobs.length=0;
  jobs.push(row({owner_id:'owner-2',created_at:now}),row({owner_id:'owner-2',created_at:now}),row({operation:'generate',created_at:now}),
    row({operation:'generate',created_at:now}),row({operation:'generate',created_at:now}),row({created_at:now}));
  await check();
  const statements=queries.filter(sql=>/count\(\*\) AS used/.test(sql));
  assert.ok(statements.length>=3);
  for(const sql of statements)assert.match(sql,/WHERE owner_id=\? AND operation=\? AND created_at>\?/);
});

test('enforceAiQuota: the plan comes from the owner license plan',async()=>{
  const config=parseAiQuota('{"default":{"analyze_per_day":1},"plans":{"pro":{"analyze_per_day":3}}}');
  const {store,db,jobs,state}=fakeBridge();
  jobs.push(row(),row());
  state.plan='FREE';
  await assert.rejects(enforceAiQuota({db,store,config,owner:'owner-1',operation:'analyze'}),{code:'AI_QUOTA_EXCEEDED',message:/limit of 1 AI analyses .* on your FREE plan/});
  state.plan='PRO';
  await enforceAiQuota({db,store,config,owner:'owner-1',operation:'analyze'});
  jobs.push(row());
  await assert.rejects(enforceAiQuota({db,store,config,owner:'owner-1',operation:'analyze'}),{code:'AI_QUOTA_EXCEEDED',message:/limit of 3 AI analyses .* on your PRO plan/});
});

// ---- HTTP: the real route handler and service behind a real socket; only the database is faked. ----
async function withServer(service,run){
  const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    try{if(!await pineBridgeRoutes(req,res,url,{id:'owner-1'},service,json,{enabled:true}))json(res,404,{error:'Not found'});}
    // Same mapping as the catch of src/postgres/server.js for a request error.
    catch(error){json(res,error.status||400,{error:error.message,...(error.code?{code:error.code}:{})});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const post=async(operation,body,key)=>{
    const response=await fetch(base+'/api/quant/pine-bridge/'+operation,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  try{await run(post);}finally{await new Promise(resolve=>server.close(resolve));}
}

test('HTTP: without PINE_BRIDGE_AI_QUOTA nothing is limited',async()=>{
  const {service,jobs}=fakeBridge();
  await withServer(service,async post=>{
    for(let i=0;i<6;i++)assert.equal((await post('analyze',analyzeBody(),'unlimited-key-'+i)).status,202);
  });
  assert.equal(jobs.length,6);
});

test('HTTP analyze: under the limit 202, at the limit 429 AI_QUOTA_EXCEEDED with a clear message and nothing queued',async()=>{
  const {service,jobs,audits}=fakeBridge({aiQuota:parseAiQuota('{"default":{"analyze_per_day":2}}')});
  await withServer(service,async post=>{
    const first=await post('analyze',analyzeBody(),'quota-key-1'),second=await post('analyze',analyzeBody(),'quota-key-2');
    assert.equal(first.status,202);assert.equal(first.body.job_status,'QUEUED');assert.equal(second.status,202);
    const blocked=await post('analyze',analyzeBody(),'quota-key-3');
    assert.equal(blocked.status,429);assert.equal(blocked.body.code,'AI_QUOTA_EXCEEDED');
    assert.equal(blocked.body.error,'You reached the limit of 2 AI analyses per 24 hours on your FREE plan. Try again later.');
    // Replaying an already accepted key returns that job; it is not a new request and is not limited.
    const replay=await post('analyze',analyzeBody(),'quota-key-1');
    assert.equal(replay.status,202);assert.equal(replay.body.job_id,first.body.job_id);
  });
  assert.equal(jobs.length,2,'the blocked request queued nothing');
  assert.deepEqual(audits.map(entry=>entry[1]),['pine_bridge.analyze.queued','pine_bridge.analyze.queued']);
});

test('HTTP generate: its own limit; zero blocks every generate while analyze stays open',async()=>{
  const {service,jobs}=fakeBridge({aiQuota:parseAiQuota('{"default":{"generate_per_day":0,"analyze_per_day":5}}')});
  await withServer(service,async post=>{
    const blocked=await post('generate',generateBody(),'gen-key-1');
    assert.equal(blocked.status,429);assert.equal(blocked.body.code,'AI_QUOTA_EXCEEDED');assert.equal(blocked.body.error,'Your FREE plan does not include AI generations.');
    assert.equal((await post('analyze',analyzeBody(),'ana-key-1')).status,202);
  });
  assert.equal(jobs.length,1);
});

test('HTTP: a plan override raises the limit for that plan only',async()=>{
  const aiQuota=parseAiQuota('{"default":{"analyze_per_day":1},"plans":{"pro":{"analyze_per_day":2}}}');
  const free=fakeBridge({aiQuota,plan:'FREE'}),pro=fakeBridge({aiQuota,plan:'PRO'});
  await withServer(free.service,async post=>{
    assert.equal((await post('analyze',analyzeBody(),'plan-key-1')).status,202);
    assert.equal((await post('analyze',analyzeBody(),'plan-key-2')).status,429);
  });
  await withServer(pro.service,async post=>{
    assert.equal((await post('analyze',analyzeBody(),'plan-key-1')).status,202);
    assert.equal((await post('analyze',analyzeBody(),'plan-key-2')).status,202);
    const blocked=await post('analyze',analyzeBody(),'plan-key-3');
    assert.equal(blocked.status,429);assert.match(blocked.body.error,/limit of 2 AI analyses per 24 hours on your PRO plan/);
  });
});

test('HTTP: jobs older than 24 hours no longer count',async()=>{
  const old=row({created_at:Date.now()-DAY-60000});
  const {service,jobs}=fakeBridge({aiQuota:parseAiQuota('{"default":{"analyze_per_day":1}}'),jobs:[old]});
  await withServer(service,async post=>{
    assert.equal((await post('analyze',analyzeBody(),'age-key-1')).status,202);
    assert.equal((await post('analyze',analyzeBody(),'age-key-2')).status,429);
  });
  assert.equal(jobs.length,2);
});

// ---- Startup: the real server entry point, with no database configured. Validation runs before any database work. ----
function startServer(env){
  const clean={...process.env};
  for(const key of ['DATABASE_URL','TEST_DATABASE_URL','PINE_BRIDGE_AI_QUOTA','NEWS_FEED_TOKEN_SHA256'])delete clean[key];
  return spawnSync(process.execPath,[fileURLToPath(new URL('../src/postgres/server.js',import.meta.url))],{env:{...clean,...env},encoding:'utf8',timeout:90000});
}

test('startup: an invalid PINE_BRIDGE_AI_QUOTA stops the server with a clear error before any database work',()=>{
  for(const [value,message] of [['{"default":{"analyze_per_day":-1}}',/default\.analyze_per_day must be a whole number/],['{',/the value is not valid JSON/],
    ['{"default":{"analyse_per_day":1}}',/unknown field "analyse_per_day"/]]){
    const run=startServer({PINE_BRIDGE_AI_QUOTA:value});
    assert.notEqual(run.status,0,value);
    assert.match(run.stderr,/Invalid PINE_BRIDGE_AI_QUOTA: /);assert.match(run.stderr,message);
    assert.doesNotMatch(run.stderr,/DATABASE_URL is required/,'the config check comes before the database');
    assert.doesNotMatch(run.stdout,/AI quota (enabled|disabled)/);
  }
});

test('startup: a valid or blank PINE_BRIDGE_AI_QUOTA passes the check and the next step (the database) is what stops this isolated run',()=>{
  const on=startServer({PINE_BRIDGE_AI_QUOTA:'{"default":{"analyze_per_day":3}}'});
  assert.match(on.stdout,/AI quota enabled \(default limits, 0 plan entries\)/);assert.match(on.stderr,/DATABASE_URL is required/);
  const blank=startServer({PINE_BRIDGE_AI_QUOTA:''}),absent=startServer({});
  for(const run of [blank,absent]){assert.match(run.stdout,/AI quota disabled/);assert.match(run.stderr,/DATABASE_URL is required/);}
});
