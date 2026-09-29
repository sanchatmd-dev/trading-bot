import test from 'node:test';
import assert from 'node:assert/strict';
import {quantDataHttpFixture} from '../helpers/quant-data-http-fixture.mjs';

test('real managed app rejects concurrent legacy calculations without creating runs',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const f=await quantDataHttpFixture(process.env.TEST_DATABASE_URL);t.after(f.close);
  const login=await f.request('/api/auth/login','POST',{email:f.user.email,password:f.password});
  assert.equal(login.status,200);
  const before=(await f.db.query('SELECT count(*)::int n FROM quant_research_runs')).rows[0].n;
  const results=await Promise.all(['/api/quant/backtest','/api/quant/optimize'].map(route=>
    f.request(route,'POST',{bot_id:f.user.id},login.session)));
  for(const answer of results){assert.equal(answer.status,409);assert.equal(answer.body.code,'QUANT_MANAGED_JOB_REQUIRED');}
  assert.equal((await f.db.query('SELECT count(*)::int n FROM quant_research_runs')).rows[0].n,before);
  assert.equal((await f.request('/api/quant/runs','GET',undefined,login.session)).status,200);
  assert.equal((await f.request('/api/quant/backtest','POST',{})).status,401);
  for(const route of ['/api/analytics/summary','/api/analytics/equity-curve','/api/analytics/breakdown']){
    const answer=await f.request(route,'GET',undefined,login.session);
    assert.equal(answer.status,409);assert.equal(answer.body.code,'QUANT_MANAGED_REPORT_REQUIRED');
  }
});
