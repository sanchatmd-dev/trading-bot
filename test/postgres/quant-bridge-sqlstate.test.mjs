import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {quantDataHttpFixture} from '../helpers/quant-data-http-fixture.mjs';

// Intercept the legacy engine in the forked API process. No socket reaches port 7654.
const PRELOAD='--import=data:text/javascript;base64,'+Buffer.from(`
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {appendFileSync} from 'node:fs';
const original=http.request;
http.request=function(options,callback){
  if(options.hostname!=='127.0.0.1'||Number(options.port)!==7654)return original.apply(this,arguments);
  appendFileSync(process.env.CX3_UPSTREAM_LOG,options.method+' '+options.path+'\\n');
  const request=new EventEmitter();
  let timer;
  request.destroy=()=>{clearInterval(timer);queueMicrotask(()=>request.emit('error',new Error('Fixture late destroy error')));};
  request.end=()=>queueMicrotask(()=>{
    if(process.env.CX3_UPSTREAM_ERROR==='1'){
      request.emit('error',Object.assign(new Error('Fixture upstream failure'),{code:'ECONNRESET'}));
      return;
    }
    if(process.env.CX3_UPSTREAM_SCENARIO==='stall')return;
    const trickle=process.env.CX3_UPSTREAM_SCENARIO==='trickle';
    const response=trickle?new Readable({read(){}}):Readable.from([JSON.stringify(
      process.env.CX3_UPSTREAM_SCENARIO==='rejected'?{error:'Fixture rejected request'}:{best:{params:{length:10},train_score:1}})]);
    response.statusCode=process.env.CX3_UPSTREAM_SCENARIO==='rejected'?422:200;
    callback(response);
    if(trickle)timer=setInterval(()=>response.push(' '),25);
  });
  return request;
};
`).toString('base64');

// This configuration affects only the disposable child interceptor, never production transport dependencies.
async function interceptedFixture(t,{error=false,scenario='fast',enabled=false}={}){
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quant-optimize-lo1-'));
  const log=path.join(directory,'upstream.log');await fs.writeFile(log,'');let f;
  t.after(async()=>{try{await f?.close();}finally{await fs.rm(directory,{recursive:true,force:true});}});
  const saved=Object.fromEntries(['NODE_OPTIONS','CX3_UPSTREAM_LOG','CX3_UPSTREAM_ERROR','CX3_UPSTREAM_SCENARIO'].map(key=>[key,process.env[key]]));
  Object.assign(process.env,{NODE_OPTIONS:[saved.NODE_OPTIONS,PRELOAD].filter(Boolean).join(' '),CX3_UPSTREAM_LOG:log,
    CX3_UPSTREAM_ERROR:error?'1':'0',CX3_UPSTREAM_SCENARIO:scenario});
  try{f=await quantDataHttpFixture(process.env.TEST_DATABASE_URL,{enabled});}
  finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  if(!enabled)await f.db.query("UPDATE quant_research_executor_mode SET mode='LEGACY'");
  const login=await f.request('/api/auth/login','POST',{email:f.user.email,password:f.password});assert.equal(login.status,200);
  return {f,session:login.session,calls:async()=>(await fs.readFile(log,'utf8')).trim().split('\n').filter(Boolean)};
}

const failures=[...['UPDATE','COMMIT'].flatMap(stage=>['40001','40P01','23514','55P03'].map(code=>({stage,code,unknown:false}))),
  ...['40001','40P01','23514','55P03'].map(code=>({stage:'COMMIT',code,unknown:true})),{stage:'transport',code:null,unknown:true}];
for(const {stage,code,unknown} of failures)test(`legacy optimize ${stage} ${code||'error'} ${unknown?'unknown':'complete'} response never repeats upstream`,async t=>{
  const {f,session,calls}=await interceptedFixture(t,{error:unknown});
  if(code){
    // UPDATE fails during the route; a deferred constraint trigger fails only at COMMIT.
    // Unknown transport never updates the run, so its COMMIT trigger must be queued by INSERT.
    const trigger=stage==='UPDATE'?'CREATE TRIGGER cx3_fail_result BEFORE UPDATE':
      `CREATE CONSTRAINT TRIGGER cx3_fail_result AFTER ${unknown?'INSERT':'UPDATE'}`;
    await f.db.query(`CREATE FUNCTION cx3_fail_result() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Fixture database failure' USING ERRCODE='${code}'; END $$;
      ${trigger} ON quant_research_runs ${stage==='COMMIT'?'DEFERRABLE INITIALLY DEFERRED':''}
      FOR EACH ROW EXECUTE FUNCTION cx3_fail_result()`);
  }
  const answer=await f.request('/api/quant/optimize','POST',{bot_id:f.user.id},session);
  assert.deepEqual(await calls(),['POST /quant/optimize'],'exactly one upstream call');
  const audits=(await f.db.query("SELECT details FROM audit WHERE event='request.error'")).rows;
  assert.equal(audits.length,code?1:0,'one database failure audit; transport errors stay handled by the bridge');
  assert.equal(answer.status,503);
  assert.deepEqual(answer.body,unknown?
    {error:'Quant request was attempted; its outcome is unknown.',code:'QUANT_SUBMISSION_OUTCOME_UNKNOWN'}:
    {error:'Quant response was received, but saving the result was not confirmed.',code:'QUANT_RESULT_NOT_RECORDED'});
  assert.equal(answer.headers.get('retry-after'),null);
  assert.ok(!JSON.stringify(answer.body).includes('RETRY_TRANSACTION'));
  assert.ok(!JSON.stringify(answer.body).includes('Fixture database failure'));
  if(code){
    assert.deepEqual(JSON.parse(audits[0].details),{message:['40001','40P01','55P03'].includes(code)?'Concurrent request rolled back':'Database request failed'});
    assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_research_runs')).rows[0].n,0,'the aborted run insert is rolled back');
  }else assert.deepEqual((await f.db.query('SELECT status FROM quant_research_runs')).rows,[{status:'RUNNING'}],'transport uncertainty is not a known FAILED result');
});

test('legacy optimize production 10000ms absolute deadline bounds trickle inside actual PostgreSQL transaction',{timeout:25000},async t=>{
  const {f,session,calls}=await interceptedFixture(t,{scenario:'trickle'});
  assert.equal(f.db.pool.options.idle_in_transaction_session_timeout,20000);
  const before=performance.now();
  const answer=await f.request('/api/quant/optimize','POST',{bot_id:f.user.id},session);
  const elapsed=performance.now()-before;
  assert.ok(elapsed>=9900&&elapsed<15000,`production deadline under normal fixture scheduling: ${elapsed}ms`);
  assert.deepEqual(await calls(),['POST /quant/optimize']);assert.equal(answer.status,503);
  assert.deepEqual(answer.body,{code:'QUANT_SUBMISSION_OUTCOME_UNKNOWN',error:'Quant request was attempted; its outcome is unknown.'});
  assert.equal(answer.headers.get('retry-after'),null);
  assert.deepEqual((await f.db.query('SELECT status,optimal_results FROM quant_research_runs')).rows,[{status:'RUNNING',optimal_results:null}]);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM audit WHERE event='request.error'")).rows[0].n,0);
});

for(const scenario of ['fast','rejected'])test(`legacy optimize known ${scenario} response preserves status and row semantics`,async t=>{
  const {f,session,calls}=await interceptedFixture(t,{scenario});
  const answer=await f.request('/api/quant/optimize','POST',{bot_id:f.user.id},session);
  assert.deepEqual(await calls(),['POST /quant/optimize']);assert.equal(answer.status,scenario==='fast'?200:422);
  const rows=(await f.db.query('SELECT status,optimal_results FROM quant_research_runs')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].status,scenario==='fast'?'COMPLETED':'FAILED');
  if(scenario==='fast')assert.deepEqual(JSON.parse(rows[0].optimal_results),{length:10});
  else assert.deepEqual(answer.body,{error:'Fixture rejected request'});
});

for(const error of [false,true])test(`legacy optimize GET ${error?'unknown':'complete'} response requires no run row`,async t=>{
  const {f,session,calls}=await interceptedFixture(t,{error});
  const answer=await f.request('/api/quant/optimize','GET',undefined,session);
  assert.deepEqual(await calls(),['GET /quant/optimize']);assert.equal(answer.status,error?503:200);
  if(error)assert.equal(answer.body.code,'QUANT_SUBMISSION_OUTCOME_UNKNOWN');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_research_runs')).rows[0].n,0);
});

test('legacy optimize admission and INSERT failures perform zero external attempts',async t=>{
  const {f,session,calls}=await interceptedFixture(t);
  const rows=async()=>(await f.db.query('SELECT count(*)::int n FROM quant_research_runs')).rows[0].n;
  const deny=async(status,run)=>{const answer=await run();assert.equal(answer.status,status);assert.deepEqual(await calls(),[]);assert.equal(await rows(),0);};
  await deny(401,()=>f.request('/api/quant/optimize','POST',{}));
  await deny(403,()=>f.request('/api/quant/optimize','POST',{},session,{origin:'https://foreign.invalid'}));
  await deny(403,()=>f.request('/api/quant/optimize','POST',{},session,{'x-csrf-token':''}));
  await deny(403,()=>f.request('/api/quant/optimize','POST',{bot_id:f.foreign.id},session));
  await f.db.query("UPDATE users SET role='NO_PERMISSION' WHERE id=$1",[f.user.id]);
  await deny(403,()=>f.request('/api/quant/optimize','POST',{},session));
  await f.db.query("UPDATE users SET role='ADMIN' WHERE id=$1",[f.user.id]);
  await f.db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  await deny(409,()=>f.request('/api/quant/optimize','POST',{},session));
  await f.db.query('DELETE FROM quant_research_executor_mode');
  await deny(503,()=>f.request('/api/quant/optimize','POST',{},session));
  await f.db.query("INSERT INTO quant_research_executor_mode VALUES(TRUE,'LEGACY')");
  await f.db.query(`CREATE FUNCTION lo1_insert_refused() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Fixture insert failure' USING ERRCODE='23514'; END $$;
    CREATE TRIGGER lo1_insert_refused BEFORE INSERT ON quant_research_runs FOR EACH ROW EXECUTE FUNCTION lo1_insert_refused()`);
  await deny(503,()=>f.request('/api/quant/optimize','POST',{},session));
  await f.db.query('DROP TRIGGER lo1_insert_refused ON quant_research_runs');
  const control=await f.request('/api/quant/optimize','POST',{},session);
  assert.equal(control.status,200);assert.equal(await rows(),1);assert.deepEqual(await calls(),['POST /quant/optimize']);
});
