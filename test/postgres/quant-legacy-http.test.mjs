import test from 'node:test';
import http from 'node:http';
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

const QUANT_BRIDGE_PORT=7654;
const DENIED_QUANT=[['/api/quant/backtest','POST'],['/api/quant/optimize','POST']];
const DENIED_REPORTS=['/api/analytics/summary','/api/analytics/equity-curve','/api/analytics/breakdown'];

/** Stand-in for the loopback Python bridge (fixed port in server.js). Records every path it receives. */
async function bridgeStandIn(t){
  const seen=[];
  const server=http.createServer((req,res)=>{
    seen.push(req.url);req.resume();
    res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
  });
  const listening=await new Promise(resolve=>{
    server.once('error',()=>resolve(false));
    server.listen(QUANT_BRIDGE_PORT,'127.0.0.1',()=>resolve(true));
  });
  t.after(()=>listening?new Promise(resolve=>server.close(resolve)):undefined);
  return {listening,seen};
}
async function staleFlagApp(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const bridge=await bridgeStandIn(t);
  // API flags 0 while the database mode row already says FOUNDATION: a stale API process.
  const f=await quantDataHttpFixture(process.env.TEST_DATABASE_URL,{enabled:false});t.after(f.close);
  assert.equal((await f.db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton')).rows[0].mode,'FOUNDATION');
  const login=await f.request('/api/auth/login','POST',{email:f.user.email,password:f.password});
  assert.equal(login.status,200);
  const healthz=(await f.request('/healthz')).status;
  const runs=async()=>(await f.db.query('SELECT (SELECT count(*)::int FROM quant_research_runs) legacy,(SELECT count(*)::int FROM quant_jobs) managed')).rows[0];
  return {f,bridge,session:login.session,runs,healthz};
}
async function assertUnrelatedRoutesStay200({f,session,healthz}){
  const settings=await f.request('/api/analytics/settings','PUT',{broker:'binance-global',feeBps:10},session);
  assert.equal(settings.status,200);
  // The fixture runs no worker, so /healthz reports its own worker state; the gate must not change it.
  assert.equal((await f.request('/healthz')).status,healthz);
  assert.equal((await f.request('/api/quant/runs','GET',undefined,session)).status,200);
}
/** Bridge evidence is its own subtest: a busy port 7654 shows as a visible SKIP and a diagnostic, never a silent pass. */
async function assertBridgeEvidence(t,{f,bridge,session}){
  const busy='port '+QUANT_BRIDGE_PORT+' busy: bridge stand-in unavailable, bridge evidence not collected';
  if(!bridge.listening)t.diagnostic(busy);
  await t.test('bridge stand-in: denied calculations never reach it, proxied routes still do',{skip:bridge.listening?false:busy},async()=>{
    assert.deepEqual(bridge.seen.filter(p=>/backtest|optimize/.test(p)),[],'denied calculations never reached the Python bridge');
    assert.equal((await f.request('/api/quant/health','GET',undefined,session)).status,200);
    assert.equal((await f.request('/api/quant/risk-preview','POST',{},session)).status,200);
    // Positive control: the stand-in does see proxied traffic, so the empty check above is meaningful.
    assert.ok(bridge.seen.includes('/quant/health')&&bridge.seen.includes('/quant/risk-preview'),'stand-in observes proxied calls');
  });
}

test('stale API flag 0 with database mode FOUNDATION still denies legacy calculations',async t=>{
  const app=await staleFlagApp(t),{f,session}=app;
  const before=await app.runs();
  for(const [route,method] of DENIED_QUANT){
    const answer=await f.request(route,method,{bot_id:f.user.id},session);
    assert.equal(answer.status,409,route);assert.equal(answer.body.code,'QUANT_MANAGED_JOB_REQUIRED',route);
  }
  for(const route of DENIED_REPORTS){
    const answer=await f.request(route,'GET',undefined,session);
    assert.equal(answer.status,409,route);assert.equal(answer.body.code,'QUANT_MANAGED_REPORT_REQUIRED',route);
  }
  assert.deepEqual(await app.runs(),before,'no legacy run or managed job row created');
  await assertUnrelatedRoutesStay200(app);
  await assertBridgeEvidence(t,app);
  assert.deepEqual(await app.runs(),before);
});

test('unreadable executor mode fails closed with 503 on every gated route',async t=>{
  // The mode column is CHECK-constrained and the row is a singleton, so an invalid value cannot be stored.
  // The only unreadable state reachable with plain DML is a missing singleton row (restored below).
  const app=await staleFlagApp(t),{f,session}=app;
  await f.db.query('DELETE FROM quant_research_executor_mode');
  const before=await app.runs();
  const answers=[];
  for(const [route,method] of DENIED_QUANT)answers.push([route,await f.request(route,method,{bot_id:f.user.id},session)]);
  for(const route of DENIED_REPORTS)answers.push([route,await f.request(route,'GET',undefined,session)]);
  for(const [route,answer] of answers){
    assert.equal(answer.status,503,route+' must be 503, not 400 or 200');
    assert.notEqual(answer.body.code,'QUANT_MANAGED_JOB_REQUIRED',route);
  }
  assert.deepEqual(await app.runs(),before,'fail-closed creates no rows');
  await assertUnrelatedRoutesStay200(app);
  await assertBridgeEvidence(t,app);
  await f.db.query("INSERT INTO quant_research_executor_mode VALUES(TRUE,'FOUNDATION')");
  const restored=await f.request('/api/quant/backtest','POST',{bot_id:f.user.id},session);
  assert.equal(restored.status,409);assert.equal(restored.body.code,'QUANT_MANAGED_JOB_REQUIRED');
});

test('unreadable executor mode reports QUANT_EXECUTOR_MODE_UNAVAILABLE on analytics routes',async t=>{
  const app=await staleFlagApp(t),{f,session}=app;
  await f.db.query('DELETE FROM quant_research_executor_mode');
  for(const route of DENIED_REPORTS){
    const answer=await f.request(route,'GET',undefined,session);
    assert.equal(answer.status,503,route);assert.equal(answer.body.code,'QUANT_EXECUTOR_MODE_UNAVAILABLE',route);
  }
});

test('unreadable executor mode reports QUANT_EXECUTOR_MODE_UNAVAILABLE on backtest and optimize',async t=>{
  const app=await staleFlagApp(t),{f,session}=app;
  await f.db.query('DELETE FROM quant_research_executor_mode');
  for(const [route,method] of DENIED_QUANT){
    const answer=await f.request(route,method,{bot_id:f.user.id},session);
    assert.equal(answer.status,503,route);assert.equal(answer.body.code,'QUANT_EXECUTOR_MODE_UNAVAILABLE',route);
  }
});
