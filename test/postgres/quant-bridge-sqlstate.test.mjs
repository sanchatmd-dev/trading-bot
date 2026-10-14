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
  request.end=()=>queueMicrotask(()=>{
    if(process.env.CX3_UPSTREAM_ERROR==='1'){
      request.emit('error',Object.assign(new Error('Fixture upstream failure'),{code:'ECONNRESET'}));
      return;
    }
    const response=Readable.from([JSON.stringify({best:{params:{length:10},train_score:1}})]);
    response.statusCode=200;
    callback(response);
  });
  return request;
};
`).toString('base64');

for(const code of ['40001','23514',null])test(`legacy optimize preserves ${code||'upstream transport'} error semantics without repeating upstream`,async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quant-bridge-sqlstate-'));
  const log=path.join(directory,'upstream.log');
  await fs.writeFile(log,'');
  let f;
  t.after(async()=>{try{await f?.close();}finally{await fs.rm(directory,{recursive:true,force:true});}});
  const saved={NODE_OPTIONS:process.env.NODE_OPTIONS,CX3_UPSTREAM_LOG:process.env.CX3_UPSTREAM_LOG,CX3_UPSTREAM_ERROR:process.env.CX3_UPSTREAM_ERROR};
  process.env.NODE_OPTIONS=[saved.NODE_OPTIONS,PRELOAD].filter(Boolean).join(' ');
  process.env.CX3_UPSTREAM_LOG=log;process.env.CX3_UPSTREAM_ERROR=code?'0':'1';
  try{f=await quantDataHttpFixture(process.env.TEST_DATABASE_URL,{enabled:false});}
  finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await f.db.query("UPDATE quant_research_executor_mode SET mode='LEGACY'");
  if(code){
    // A real PostgreSQL error aborts the transaction after the fake engine has answered.
    await f.db.query(`CREATE FUNCTION cx3_fail_result() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Fixture database failure' USING ERRCODE='${code}'; END $$;
      CREATE TRIGGER cx3_fail_result BEFORE UPDATE ON quant_research_runs
      FOR EACH ROW EXECUTE FUNCTION cx3_fail_result()`);
  }
  const login=await f.request('/api/auth/login','POST',{email:f.user.email,password:f.password});
  assert.equal(login.status,200);
  const answer=await f.request('/api/quant/optimize','POST',{bot_id:f.user.id},login.session);
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),['POST /quant/optimize'],'exactly one upstream call');
  const audits=(await f.db.query("SELECT details FROM audit WHERE event='request.error'")).rows;
  assert.equal(audits.length,code?1:0,'one database failure audit; transport errors stay handled by the bridge');
  if(code==='40001'){
    assert.equal(answer.status,409);
    assert.deepEqual(answer.body,{error:'Concurrent update; retry the request',code:'RETRY_TRANSACTION'});
  }else{
    assert.equal(answer.status,503);
    assert.deepEqual(answer.body,{error:code?'Request could not be completed':'Quant Lab engine is unavailable'});
  }
  if(code){
    assert.deepEqual(JSON.parse(audits[0].details),{message:code==='40001'?'Concurrent request rolled back':'Database request failed'});
    assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_research_runs')).rows[0].n,0,'the aborted run insert is rolled back');
  }
});
