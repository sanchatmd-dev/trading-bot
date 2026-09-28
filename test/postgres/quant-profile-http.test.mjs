import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {quantProfileHttpFixture} from '../helpers/quant-profile-http-fixture.mjs';

test('real app HTTP enrolls PROFILE with auth, idempotency, status and cancel',async t=>{
  const privateFixturePath=process.env.QUANT_PROFILE_SOURCE_FIXTURE;
  if(!privateFixturePath){t.skip('QUANT_PROFILE_SOURCE_FIXTURE private source fixture unavailable');return;}
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const f=await quantProfileHttpFixture(process.env.TEST_DATABASE_URL,{privateFixturePath});t.after(f.close);
  const ownerLogin=await f.request('/api/auth/login','POST',
    {email:f.owner.email,password:f.password});
  const foreignLogin=await f.request('/api/auth/login','POST',
    {email:f.foreign.email,password:f.password});
  assert.equal(ownerLogin.status,200);assert.equal(foreignLogin.status,200);
  const session=ownerLogin.session,foreign=foreignLogin.session;
  const end=Math.floor(Date.now()/60000)*60000-2*60000;
  const range={bot_id:f.owner.id,start_time:end-20*60000,end_time:end,warmup_bars:500};
  const preview=await f.request('/api/quant/data/range-preview','POST',range,session);
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  const raw=await f.request('/api/quant/data/jobs','POST',preview.body.request,session,
    {'Idempotency-Key':randomUUID()});
  assert.equal(raw.status,202,JSON.stringify(raw.body));
  assert.equal(await f.worker.tick(),true);
  const rawDone=await f.request('/api/quant/data/jobs/'+raw.body.job_id,'GET',undefined,session);
  assert.equal(rawDone.body.status,'SUCCEEDED');
  const body={bot_id:f.owner.id,raw_job_id:raw.body.job_id,deployment_id:f.deploymentId};
  const route='/api/quant/data/profiles';
  assert.equal((await f.request(route,'POST',body)).status,401);
  const denied=await f.request(route,'POST',body,foreign,{'Idempotency-Key':randomUUID()});
  assert.ok([403,404].includes(denied.status),JSON.stringify(denied.body));
  assert.equal((await f.request(route,'POST',{...body,source_hash:'a'.repeat(64)},session,
    {'Idempotency-Key':randomUUID()})).status,400);
  const key=randomUUID(),headers={'Idempotency-Key':key};
  const queued=await f.request(route,'POST',body,session,headers);
  assert.equal(queued.status,202,JSON.stringify(queued.body));
  assert.equal(queued.body.status,'QUEUED');
  const repeat=await f.request(route,'POST',body,session,headers);
  assert.equal(repeat.body.job_id,queued.body.job_id);
  const conflict=await f.request(route,'POST',{...body,deployment_id:randomUUID()},session,headers);
  assert.equal(conflict.status,409);
  assert.equal((await f.request(route+'/'+queued.body.job_id,'GET',undefined,foreign)).status,404);
  assert.equal((await f.request(route+'/'+queued.body.job_id+'?bot_id='+f.foreign.id,'GET',undefined,session)).status,404);
  const cancelled=await f.request(route+'/'+queued.body.job_id+'/cancel','POST',{},session);
  assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'CANCELLED');
  const success=await f.request(route,'POST',body,session,{'Idempotency-Key':randomUUID()});
  assert.equal(success.status,202,JSON.stringify(success.body));
  assert.equal(await f.worker.tick(),true);
  const done=await f.request(route+'/'+success.body.job_id,'GET',undefined,session);
  assert.equal(done.status,200,JSON.stringify(done.body));
  assert.equal(done.body.status,'SUCCEEDED',JSON.stringify(done.body));
  assert.equal(done.body.result.data_profile_verified,true);
  assert.equal(done.body.result.evaluator_admission,false);
});
