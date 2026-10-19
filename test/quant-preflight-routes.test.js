import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {quantPreflightRoutes,quantProfileEnrollmentRoutes} from '../src/postgres/quant-preflight-routes.js';

const id='11111111-1111-4111-8111-111111111111';
function fixture(){
  const calls=[],result={status:'QUEUED'};
  const service=Object.fromEntries(['enqueue','list','get','getHoldoutBoundary','registerHoldoutBoundary','enqueueEnrollment']
    .map(name=>[name,async(...args)=>{calls.push([name,...args]);return result;}]));
  async function request(path,{method='GET',body={},enabled=true,enrollment=false}={}){
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method=method;req.headers={'idempotency-key':'request-123'};
    let response;
    const handled=await(enrollment?quantProfileEnrollmentRoutes:quantPreflightRoutes)(req,{},new URL(path,'http://localhost'),
      {id:'owner-1'},service,(_res,status,value)=>{response={status,value};},{enabled});
    return {handled,response};
  }
  return {calls,service,request,result};
}
test('preflight routes bind authenticated owner, bot query and idempotency to the service',async()=>{
  const f=fixture(),body={bot_id:'bot-a',deployment_id:'deployment-a',profile_job_id:id};
  assert.deepEqual(await f.request('/api/quant/data/preflights?bot_id=bot-a',{method:'POST',body}),
    {handled:true,response:{status:202,value:f.result}});
  await f.request('/api/quant/data/preflights?bot_id=bot-a');
  await f.request('/api/quant/data/preflights/'+id+'?bot_id=bot-a');
  await f.request('/api/quant/data/preflights/'+id+'/cancel?bot_id=bot-a',{method:'POST'});
  assert.deepEqual(f.calls,[['enqueue','owner-1',body,'request-123'],['list','owner-1','bot-a'],
    ['get','owner-1',id,false,'bot-a'],['get','owner-1',id,true,'bot-a']]);
});
test('holdout routes preserve owner and reject bot mismatch without calling service',async()=>{
  const f=fixture(),body={bot_id:'bot-a',holdout_start_time:60000};
  await f.request('/api/quant/data/holdout-boundaries?bot_id=bot-a');
  await f.request('/api/quant/data/holdout-boundaries?bot_id=bot-a',{method:'POST',body});
  assert.deepEqual(f.calls,[['getHoldoutBoundary','owner-1','bot-a'],['registerHoldoutBoundary','owner-1',body]]);
  await assert.rejects(f.request('/api/quant/data/holdout-boundaries?bot_id=other',{method:'POST',body}),{code:'INVALID_FIELDS'});
  assert.equal(f.calls.length,2);
});
test('disabled preflight routes fail closed and do not intercept neighboring endpoints',async()=>{
  const f=fixture();
  for(const path of ['/api/quant/data/preflights','/api/quant/data/preflights/'+id,'/api/quant/data/holdout-boundaries'])
    await assert.rejects(f.request(path,{enabled:false}),{code:'PREFLIGHT_DISABLED',status:503});
  assert.equal((await f.request('/api/quant/data/preflights-extra')).handled,false);
  assert.equal((await f.request('/api/quant/data/profiles')).handled,false);
  assert.equal(f.calls.length,0);
});
test('query duplicates, extra fields, missing list bot and malformed cancellation are refused',async()=>{
  const f=fixture();
  for(const path of ['/api/quant/data/preflights','/api/quant/data/holdout-boundaries',
    '/api/quant/data/preflights?bot_id=a&bot_id=a','/api/quant/data/preflights?bot_id=',
    '/api/quant/data/preflights?bot_id=a&range=50k'])
    await assert.rejects(f.request(path),{code:'INVALID_FIELDS'});
  await assert.rejects(f.request('/api/quant/data/preflights?bot_id=other',{method:'POST',body:{bot_id:'bot-a'}}),{code:'INVALID_FIELDS'});
  await assert.rejects(f.request('/api/quant/data/preflights/'+id+'/cancel',{method:'POST',body:{force:true}}),{code:'INVALID_FIELDS'});
  await assert.rejects(f.request('/api/quant/data/holdout-boundaries/extra'),{code:'NOT_FOUND'});
  assert.equal(f.calls.length,0);
});
test('enrollment has a separate default-off POST route and preserves service error handling',async()=>{
  const f=fixture(),path='/api/quant/data/profile-enrollments',body={bot_id:'bot-a',raw_job_id:id,deployment_id:'deployment-a'};
  await assert.rejects(f.request(path,{enrollment:true,enabled:false}),{code:'QUANT_PROFILE_ENROLLMENT_DISABLED',status:503});
  assert.equal((await f.request(path,{enrollment:true,method:'POST',body})).response.status,202);
  assert.deepEqual(f.calls,[['enqueueEnrollment','owner-1',body,'request-123']]);
  await assert.rejects(f.request(path,{enrollment:true}),{code:'NOT_FOUND'});
  const error=Object.assign(Error('database detail'),{code:'40001'});
  f.service.enqueueEnrollment=async()=>{throw error;};
  await assert.rejects(f.request(path,{enrollment:true,method:'POST',body}),value=>value===error);
});
test('enrollment route passes the fixed active-enrollment 409 refusal through for the dispatcher',async()=>{
  const f=fixture(),path='/api/quant/data/profile-enrollments',body={bot_id:'bot-a',raw_job_id:id,deployment_id:'deployment-a'};
  const refusal=Object.assign(Error('PROFILE_ENROLLMENT_ALREADY_ACTIVE'),{code:'PROFILE_ENROLLMENT_ALREADY_ACTIVE',status:409});
  f.service.enqueueEnrollment=async()=>{throw refusal;};
  await assert.rejects(f.request(path,{enrollment:true,method:'POST',body}),error=>error===refusal&&error.status===409);
  assert.equal(f.calls.length,0);
});
