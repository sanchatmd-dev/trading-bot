import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ownerIsolationFixture} from '../helpers/owner-isolation-http-fixture.mjs';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {config} from '../../src/config.js';

/**
 * F01-01 owner isolation on the real PostgreSQL server path (src/postgres/server.js behind request-dispatch.js), real HTTP.
 * Clauses (docs/QL_3A_DURABLE_JOBS.md "Existing owner authentication, CSRF and request limits apply"; F01-01 acceptance):
 *   C1 an owner route without a live session answers 401;
 *   C3 an unsafe method with a wrong or missing x-csrf-token answers 403;
 *   C4 a resource of another owner is refused (the status the code defines) with no data in the answer and no side effect.
 * Two plain USER accounts: `victim` owns every resource; `attacker` holds a live, valid session of its own.
 * Every refusal is judged by the exact literal status and body, and by a full before/after snapshot of every table a route
 * could write. CSRF refusals use the owner's own session against the owner's own resource, so a missing CSRF check would
 * perform the mutation and fail the snapshot. A control at the end of each group proves the owner reaches the handler
 * and the route path is real. Synthetic fixtures only; nothing here says anything about strategy performance.
 */
const M=60000,top=Math.floor(Date.now()/M)*M-30000*M;
let f,attacker,victim,A,V,child,bridgeJobId,signalId,runId,secrets;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  f=await ownerIsolationFixture(process.env.TEST_DATABASE_URL);
  await f.seedBars({start:top,count:3250});
  attacker=await f.newOwner('attacker');victim=await f.newOwner('victim');
  A=await attacker.login();V=await victim.login();
  child=await f.store.createBot(victim.id,'VICTIM_BOT_MARKER',{...config.defaultRisk,paperTrading:true});
  // Pine Bridge job of the victim: a QUEUED analyze job, as the enqueue path writes it, without a provider call.
  bridgeJobId=randomUUID();
  await f.db.prepare("INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?,?)")
    .run(bridgeJobId,victim.id,victim.id,'analyze','victim-isolation-key','h',JSON.stringify({source_version:1,analysis:{source_hash:'VICTIM_SOURCE_HASH_MARKER'}}),victim.importId,Date.now(),Date.now(),Date.now()+300000);
  // A REJECTED signal of the victim, the only status a review note can be written on.
  await f.store.enqueue(victim.id,normalizeSignal({trade_id:'victim-isolation',broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'1',entry:'0.1',sl:'0.09',timestamp:Date.now()}));
  signalId=(await f.store.listSignals(victim.id))[0].id;
  await f.db.prepare("UPDATE signals SET status='REJECTED' WHERE id=?").run(signalId);
  // Legacy Quant run of the victim, readable through GET /api/quant/runs.
  runId='run-victim-isolation';
  await f.db.prepare("INSERT INTO quant_research_runs(run_id,user_id,bot_id,indicators_config,status,created_at,updated_at) VALUES(?,?,?,?,'COMPLETED',?,?)")
    .run(runId,victim.id,victim.id,JSON.stringify({marker:'VICTIM_RUN_MARKER'}),Date.now(),Date.now());
  secrets=[victim.id,victim.email,child.id,victim.importId,victim.deploymentId,victim.draftId,bridgeJobId,runId,'VICTIM_BOT_MARKER','VICTIM_SOURCE_HASH_MARKER','VICTIM_RUN_MARKER','VICTIM_NOTE_MARKER'];
});
after(async()=>{await f?.close();});

// ---- literal contract answers (src/postgres/auth.js, pine-bridge/source.js fail(), server.js) ----------------------------------
const UNAUTHORIZED={status:401,body:{error:'Unauthorized'}};
const CSRF={status:403,body:{error:'Invalid CSRF token'}};
const NOT_FOUND={status:404,body:{error:'NOT_FOUND',code:'NOT_FOUND'}};
const BOT_DENIED={status:403,body:{error:'Bot access denied'}};
const BAD_CSRF={'x-csrf-token':'invalid'};
const withoutCsrf=session=>({cookie:session.cookie,csrf:''});

/** Exact status and exact body; a refusal carries no field beyond the error and no foreign identifier. */
function judge(label,answer,expected) {
  assert.equal(answer.status,expected.status,label+' '+JSON.stringify(answer.body));
  assert.deepEqual(answer.body,expected.body,label);
  const text=JSON.stringify(answer.body);
  for(const secret of secrets)assert.ok(!text.includes(secret),label+' leaks '+secret);
}
const send=async(label,expected,route,method,body,session,headers)=>judge(label,await f.request(route,method,body,session,headers),expected);
/** Same request without a session, then (unsafe methods only; GET never needs a token) with a wrong and a missing token on the owner's own session. */
async function refusedWithoutAuthority(label,route,method,body,owner,headers) {
  await send(label+': no session',UNAUTHORIZED,route,method,body,undefined,headers);
  if(method==='GET')return;
  await send(label+': wrong CSRF token',CSRF,route,method,body,owner,{...headers,...BAD_CSRF});
  await send(label+': missing CSRF token',CSRF,route,method,body,withoutCsrf(owner),headers);
}

/** Every table an owner-scoped route of this file could write, plus the dataset directory. Audit noise rows are excluded. */
async function snapshot() {
  const rows=async sql=>(await f.db.query(sql)).rows;
  return {
    users:await rows('SELECT id,role,status,label,parent_user_id FROM users ORDER BY id'),
    botSessions:await rows('SELECT user_id,state,run_id,started_at,stopped_at FROM bot_sessions ORDER BY user_id'),
    researchJobs:await rows('SELECT run_id,owner_id,status FROM quant_jobs ORDER BY run_id'),
    foundationJobs:await rows('SELECT job_id,owner_id,status FROM quant_foundation_jobs ORDER BY job_id'),
    legacyRuns:await rows('SELECT run_id,status FROM quant_research_runs ORDER BY run_id'),
    bridgeJobs:await rows('SELECT job_id,owner_id,status FROM pine_bridge_jobs ORDER BY job_id'),
    captures:await rows('SELECT capture_id,owner_id,closed,received FROM pine_capture_sessions ORDER BY capture_id'),
    deployments:await rows('SELECT deployment_id,owner_id,state FROM pine_deployments ORDER BY deployment_id'),
    memberships:await rows('SELECT pine_import_id,owner_id,bot_id,connected,source_version FROM pine_memberships ORDER BY pine_import_id'),
    signals:await rows('SELECT id,user_id,status,review_note FROM signals ORDER BY id'),
    analytics:await rows('SELECT user_id,broker,fee_bps FROM analytics_settings ORDER BY user_id,broker'),
    settings:await rows('SELECT key,value FROM system_settings ORDER BY key'),
    audit:await rows("SELECT event,count(*)::int n FROM audit WHERE event<>'request.error' GROUP BY event ORDER BY event"),
    files:await f.listing()
  };
}
const status=async(sql,params)=>(await f.db.query(sql,params)).rows[0]?.status;

// ---- /api/quant/research/jobs -------------------------------------------------------------------------------------------------
test('C1/C3/C4: /api/quant/research/jobs POST, GET and cancel refuse no session, bad CSRF and a foreign owner without side effect',async()=>{
  const body=f.researchBody(victim,{start:top});
  const queued=await f.request('/api/quant/research/jobs','POST',body,V,{'Idempotency-Key':randomUUID()});
  assert.equal(queued.status,202,JSON.stringify(queued.body));assert.equal(queued.body.status,'QUEUED');
  const run=queued.body.run_id,jobs='/api/quant/research/jobs';
  secrets.push(run);
  const idle=await snapshot();
  assert.equal(await status('SELECT status FROM quant_jobs WHERE run_id=$1',[run]),'QUEUED');
  const key=()=>({'Idempotency-Key':randomUUID()});
  await refusedWithoutAuthority('POST enqueue',jobs,'POST',body,V,key());
  await refusedWithoutAuthority('GET job',jobs+'/'+run,'GET',undefined,V);
  await refusedWithoutAuthority('POST cancel',jobs+'/'+run+'/cancel','POST',{},V);
  // Foreign owner: the Bot of the victim, then an own Bot with the deployment of the victim, then the job itself.
  await send('POST enqueue on foreign Bot',NOT_FOUND,jobs,'POST',body,A,key());
  await send('POST enqueue with foreign deployment on own Bot',NOT_FOUND,jobs,'POST',{...f.researchBody(attacker,{start:top}),deployment_id:victim.deploymentId},A,key());
  await send('GET foreign job',NOT_FOUND,jobs+'/'+run,'GET',undefined,A);
  await send('POST cancel foreign job',NOT_FOUND,jobs+'/'+run+'/cancel','POST',{},A);
  assert.deepEqual(await snapshot(),idle,'no row, file, status or audit event changed');
  assert.equal(await status('SELECT status FROM quant_jobs WHERE run_id=$1',[run]),'QUEUED');
  // Control: the owner reads and cancels its own job; only then the job and its scheduler row change.
  const own=await f.request(jobs+'/'+run,'GET',undefined,V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.run_id,run);assert.equal(own.body.status,'QUEUED');
  const cancelled=await f.request(jobs+'/'+run+'/cancel','POST',{},V);
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));assert.equal(cancelled.body.status,'CANCELLED');
  assert.equal(await status('SELECT status FROM quant_jobs WHERE run_id=$1',[run]),'CANCELLED');
  assert.equal((await f.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.research.cancelled'")).rows[0].n,1);
});

// ---- Pine Bridge: job GET and cancel ------------------------------------------------------------------------------------------
test('C1/C3/C4: /api/quant/pine-bridge/jobs GET and cancel refuse no session, bad CSRF and a foreign owner without side effect',async()=>{
  const route='/api/quant/pine-bridge/jobs/'+bridgeJobId,idle=await snapshot();
  await refusedWithoutAuthority('GET bridge job',route,'GET',undefined,V);
  await refusedWithoutAuthority('POST cancel bridge job',route+'/cancel','POST',{},V);
  await send('GET foreign bridge job',NOT_FOUND,route,'GET',undefined,A);
  await send('POST cancel foreign bridge job',NOT_FOUND,route+'/cancel','POST',{},A);
  assert.deepEqual(await snapshot(),idle);
  assert.equal(await status('SELECT status FROM pine_bridge_jobs WHERE job_id=$1',[bridgeJobId]),'QUEUED');
  const own=await f.request(route,'GET',undefined,V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.job_id,bridgeJobId);assert.equal(own.body.job_status,'QUEUED');
  const cancelled=await f.request(route+'/cancel','POST',{},V);
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));assert.equal(cancelled.body.job_status,'CANCELLED');
  assert.equal(await status('SELECT status FROM pine_bridge_jobs WHERE job_id=$1',[bridgeJobId]),'CANCELLED');
});

// ---- Pine Bridge: captures ----------------------------------------------------------------------------------------------------
test('C1/C3/C4: Pine Bridge capture create, status and close refuse no session, bad CSRF and a foreign owner without side effect',async()=>{
  const draft=victim.draftId,create='/api/quant/pine-bridge/deployments/'+draft+'/capture';
  const made=await f.request(create,'POST',{},V);
  assert.equal(made.status,201,JSON.stringify(made.body));assert.equal(made.body.mode,'CAPTURE_ONLY');
  const capture=made.body.capture_id,route='/api/quant/pine-bridge/captures/'+capture;
  secrets.push(capture,made.body.capture_path.split('/').pop());
  const idle=await snapshot();
  assert.equal((await f.db.query('SELECT closed FROM pine_capture_sessions WHERE capture_id=$1',[capture])).rows[0].closed,false);
  await refusedWithoutAuthority('POST create capture',create,'POST',{},V);
  await refusedWithoutAuthority('GET capture status',route,'GET',undefined,V);
  await refusedWithoutAuthority('POST close capture',route+'/close','POST',{},V);
  await send('POST create capture on foreign deployment',NOT_FOUND,create,'POST',{},A);
  await send('GET foreign capture',NOT_FOUND,route,'GET',undefined,A);
  await send('POST close foreign capture',NOT_FOUND,route+'/close','POST',{},A);
  assert.deepEqual(await snapshot(),idle,'no capture session created or closed');
  assert.equal((await f.db.query('SELECT closed FROM pine_capture_sessions WHERE capture_id=$1',[capture])).rows[0].closed,false);
  // Control: the owner reads its capture, then closes it.
  const own=await f.request(route,'GET',undefined,V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.capture_id,capture);assert.equal(own.body.closed,false);assert.equal(own.body.deployment_id,draft);
  const closed=await f.request(route+'/close','POST',{},V);
  assert.equal(closed.status,200,JSON.stringify(closed.body));assert.equal(closed.body.closed,true);
  assert.equal((await f.db.query('SELECT closed FROM pine_capture_sessions WHERE capture_id=$1',[capture])).rows[0].closed,true);
});

// ---- Pine Bridge: memberships and activate ------------------------------------------------------------------------------------
test('C1/C3/C4: Pine Bridge membership refuses no session, bad CSRF and a foreign owner; the READY deployment stays READY',async()=>{
  const route='/api/quant/pine-bridge/sources/'+victim.importId+'/membership',idle=await snapshot();
  assert.equal(await status('SELECT state AS status FROM pine_deployments WHERE deployment_id=$1',[victim.deploymentId]),'READY');
  // A membership change would also move every READY deployment of the Bot to EXIT_ONLY (invalidateEntries).
  await refusedWithoutAuthority('POST membership',route,'POST',{bot_id:victim.id,connected:false},V);
  await send('POST membership on foreign Bot',NOT_FOUND,route,'POST',{bot_id:victim.id,connected:false},A);
  await send('POST membership of foreign source on own Bot',NOT_FOUND,route,'POST',{bot_id:attacker.id,connected:false},A);
  assert.deepEqual(await snapshot(),idle);
  assert.equal((await f.db.query('SELECT connected FROM pine_memberships WHERE pine_import_id=$1',[victim.importId])).rows[0].connected,true);
  assert.equal(await status('SELECT state AS status FROM pine_deployments WHERE deployment_id=$1',[victim.deploymentId]),'READY');
  // Control: the owner reaches the handler (connected stays true, so nothing changes).
  const own=await f.request(route,'POST',{bot_id:victim.id,connected:true},V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.deepEqual(own.body,{pine_import_id:victim.importId,connected:true});
});

test('C1/C3/C4: Pine Bridge deployment activate refuses no session, bad CSRF and a foreign owner; the DRAFT deployment stays DRAFT',async()=>{
  const route='/api/quant/pine-bridge/deployments/'+victim.draftId+'/activate',idle=await snapshot();
  await refusedWithoutAuthority('POST activate',route,'POST',{},V);
  await send('POST activate foreign deployment',NOT_FOUND,route,'POST',{},A);
  assert.deepEqual(await snapshot(),idle);
  assert.equal(await status('SELECT state AS status FROM pine_deployments WHERE deployment_id=$1',[victim.draftId]),'DRAFT');
  // Control: the owner passes the ownership gate and is stopped by the business rule (no execution evidence for the DRAFT).
  const own=await f.request(route,'POST',{},V);
  assert.equal(own.status,409,JSON.stringify(own.body));assert.equal(own.body.code,'BRIDGE_EXECUTION_EVIDENCE_REQUIRED');
  assert.equal(await status('SELECT state AS status FROM pine_deployments WHERE deployment_id=$1',[victim.draftId]),'DRAFT');
});

// ---- /api/bots ----------------------------------------------------------------------------------------------------------------
test('C1/C3/C4: /api/bots PATCH refuses no session, bad CSRF and a foreign owner; POST refuses no session and bad CSRF',async()=>{
  const idle=await snapshot();
  await refusedWithoutAuthority('PATCH own Bot',  '/api/bots/'+child.id,'PATCH',{label:'PWNED'},V);
  await refusedWithoutAuthority('POST /api/bots','/api/bots','POST',{label:'Extra bot'},V);
  await send('PATCH foreign Bot of the victim',{status:404,body:{error:'Bot not found'}},'/api/bots/'+child.id,'PATCH',{label:'PWNED'},A);
  await send('PATCH foreign main account of the victim',{status:404,body:{error:'Bot not found'}},'/api/bots/'+victim.id,'PATCH',{label:'PWNED'},A);
  assert.deepEqual(await snapshot(),idle,'labels and bot rows unchanged');
  assert.equal((await f.db.query('SELECT label FROM users WHERE id=$1',[child.id])).rows[0].label,'VICTIM_BOT_MARKER');
  // Control: the owner renames its own Bot.
  const own=await f.request('/api/bots/'+child.id,'PATCH',{label:'VICTIM_BOT_RENAMED'},V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.id,child.id);assert.equal(own.body.label,'VICTIM_BOT_RENAMED');
  assert.equal((await f.db.query('SELECT label FROM users WHERE id=$1',[child.id])).rows[0].label,'VICTIM_BOT_RENAMED');
  secrets.push('VICTIM_BOT_RENAMED');
});

// ---- /api/bot/session* --------------------------------------------------------------------------------------------------------
test('C1/C3/C4: /api/bot/session* refuse no session, bad CSRF and a foreign Bot; no lifecycle row is written',async()=>{
  const idle=await snapshot();
  assert.deepEqual(idle.botSessions.filter(r=>r.user_id===victim.id||r.user_id===child.id),[]);
  await send('GET session: no session',UNAUTHORIZED,'/api/bot/session','GET');
  await refusedWithoutAuthority('POST run','/api/bot/session/run','POST',{},V);
  await refusedWithoutAuthority('POST rearm-loss-streak','/api/bot/session/rearm-loss-streak','POST',{broker:'binance-global',reason:'owner'},V);
  for(const bot of [victim.id,child.id]){
    await send('GET session of foreign Bot '+bot,BOT_DENIED,'/api/bot/session?bot_id='+bot,'GET',undefined,A);
    await send('GET archive of foreign Bot '+bot,BOT_DENIED,'/api/bot/session/archive?bot_id='+bot,'GET',undefined,A);
    for(const action of ['run','pause','stop','reset'])
      await send('POST '+action+' on foreign Bot '+bot,BOT_DENIED,'/api/bot/session/'+action+'?bot_id='+bot,'POST',{},A);
    await send('POST rearm-loss-streak on foreign Bot '+bot,BOT_DENIED,'/api/bot/session/rearm-loss-streak?bot_id='+bot,'POST',{broker:'binance-global',reason:'attacker'},A);
  }
  assert.deepEqual(await snapshot(),idle,'no Bot changed state and no audit event was written');
  // Control: the owner reads its own session (the Bot is funded, so a run would have changed the state above).
  const own=await f.request('/api/bot/session','GET',undefined,V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.state,'SETUP');assert.equal(own.body.run_id,null);
});

// ---- /api/signals/:id/note ----------------------------------------------------------------------------------------------------
test('C1/C3/C4: /api/signals/:id/note refuses no session, bad CSRF and a foreign owner; the review note stays empty',async()=>{
  const route='/api/signals/'+signalId+'/note',idle=await snapshot();
  assert.equal((await f.db.query('SELECT review_note FROM signals WHERE id=$1',[signalId])).rows[0].review_note,'');
  await refusedWithoutAuthority('PUT note',route,'PUT',{note:'VICTIM_NOTE_MARKER'},V);
  await send('PUT note on foreign signal',{status:404,body:{error:'Signal not found'}},route,'PUT',{note:'ATTACKER_NOTE'},A);
  await send('PUT note on foreign signal through foreign Bot selector',BOT_DENIED,route+'?bot_id='+victim.id,'PUT',{note:'ATTACKER_NOTE'},A);
  assert.deepEqual(await snapshot(),idle);
  assert.equal((await f.db.query('SELECT review_note FROM signals WHERE id=$1',[signalId])).rows[0].review_note,'');
  // Control: the owner writes the note of its own REJECTED signal.
  const own=await f.request(route,'PUT',{note:' VICTIM_NOTE_MARKER '},V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.deepEqual(own.body,{ok:true});
  assert.equal((await f.db.query('SELECT review_note FROM signals WHERE id=$1',[signalId])).rows[0].review_note,'VICTIM_NOTE_MARKER');
});

// ---- /api/analytics -----------------------------------------------------------------------------------------------------------
test('C1/C3/C4: /api/analytics cross-user read and write are refused for a USER; a missing user gives the same answer',async()=>{
  const idle=await snapshot(),denied={status:403,body:{error:'Cannot access another user analytics'}},settings={broker:'binance-global',feeBps:7};
  await send('GET summary: no session',UNAUTHORIZED,'/api/analytics/summary','GET');
  await refusedWithoutAuthority('PUT analytics settings','/api/analytics/settings','PUT',settings,A);
  for(const target of [victim.id,child.id,randomUUID()])
    for(const route of ['summary','equity-curve','breakdown'])
      await send('GET analytics '+route+' of '+target,denied,'/api/analytics/'+route+'?user_id='+target,'GET',undefined,A);
  await send('PUT analytics settings of the victim',denied,'/api/analytics/settings?user_id='+victim.id,'PUT',settings,A);
  await send('PUT analytics settings of the victim Bot',denied,'/api/analytics/settings?user_id='+child.id,'PUT',settings,A);
  assert.deepEqual(await snapshot(),idle,'no analytics settings row written');
  assert.equal((await f.db.query('SELECT count(*)::int n FROM analytics_settings WHERE user_id=ANY($1)',[[victim.id,child.id]])).rows[0].n,0);
  // Control: the same route works for the caller itself, and writes only the caller's row.
  const own=await f.request('/api/analytics/settings','PUT',settings,A);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.deepEqual(own.body,{userId:attacker.id,broker:'binance-global',feeBps:7});
  assert.deepEqual((await f.db.query('SELECT user_id FROM analytics_settings')).rows,[{user_id:attacker.id}]);
});

// ---- /api/quant/runs ----------------------------------------------------------------------------------------------------------
test('C1/C4: /api/quant/runs refuses no session and a foreign Bot; the foreign run never appears in an own list',async()=>{
  const idle=await snapshot();
  await send('GET runs: no session',UNAUTHORIZED,'/api/quant/runs','GET');
  await send('GET runs of the victim main account',BOT_DENIED,'/api/quant/runs?bot_id='+victim.id,'GET',undefined,A);
  await send('GET runs of the victim Bot',BOT_DENIED,'/api/quant/runs?bot_id='+child.id,'GET',undefined,A);
  const mine=await f.request('/api/quant/runs','GET',undefined,A);
  assert.equal(mine.status,200,JSON.stringify(mine.body));assert.deepEqual(mine.body,[],'the attacker list holds no run of the victim');
  assert.deepEqual(await snapshot(),idle);
  // Control: the owner sees its own run, so the empty list above is a scoping result and not a broken route.
  const own=await f.request('/api/quant/runs','GET',undefined,V);
  assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.length,1);assert.equal(own.body[0].run_id,runId);assert.deepEqual(own.body[0].indicators_config,{marker:'VICTIM_RUN_MARKER'});
});

// ---- /api/admin ---------------------------------------------------------------------------------------------------------------
test('C1/C3: /api/admin refuses no session, bad CSRF and the USER role; no account, role or setting changes',async()=>{
  const idle=await snapshot(),denied={status:403,body:{error:'Permission denied'}};
  await send('GET admin health: no session',UNAUTHORIZED,'/api/admin/health','GET');
  await send('POST admin users: no session',UNAUTHORIZED,'/api/admin/users','POST',{email:'new-admin@example.test',password:'temporary-test-password',role:'ADMIN'});
  // CSRF is judged before the role: a USER with a wrong token gets the CSRF answer, not the permission answer.
  await send('POST admin users: wrong CSRF token',CSRF,'/api/admin/users','POST',{email:'new-admin@example.test',password:'temporary-test-password',role:'ADMIN'},A,BAD_CSRF);
  await send('GET admin health as USER',denied,'/api/admin/health','GET',undefined,A);
  await send('GET admin users as USER',denied,'/api/admin/users','GET',undefined,A);
  await send('GET admin licenses as USER',denied,'/api/admin/licenses','GET',undefined,A);
  await send('POST admin users as USER',denied,'/api/admin/users','POST',{email:'new-admin@example.test',password:'temporary-test-password',role:'ADMIN'},A);
  await send('PUT admin role of the victim as USER',denied,'/api/admin/users/'+victim.id+'/role','PUT',{role:'ADMIN'},A);
  await send('PUT admin role of the attacker itself as USER',denied,'/api/admin/users/'+attacker.id+'/role','PUT',{role:'ADMIN'},A);
  await send('POST admin global-kill as USER',denied,'/api/admin/global-kill','POST',{enabled:true},A);
  assert.deepEqual(await snapshot(),idle,'no user created, no role changed, no global-kill setting written');
  assert.equal((await f.db.query('SELECT role FROM users WHERE id=$1',[attacker.id])).rows[0].role,'USER');
  assert.equal((await f.db.query("SELECT count(*)::int n FROM system_settings WHERE key='globalKill'")).rows[0].n,0);
});

// ---- /api/risk/venue-refresh --------------------------------------------------------------------------------------------------
test('C1/C3: /api/risk/venue-refresh refuses no session and a wrong CSRF token before any venue fetch',async()=>{
  // ETHUSDT can never reach the network: the handler throws VENUE_REFRESH_MARKET_UNSUPPORTED before it takes the lock or fetches.
  // An authenticated caller therefore gets 400, so the 401 and 403 below can only come from the authentication gate.
  const idle=await snapshot(),route='/api/risk/venue-refresh',body={symbol:'ETHUSDT'};
  await send('POST venue-refresh: no session',UNAUTHORIZED,route,'POST',body);
  await send('POST venue-refresh: wrong CSRF token',CSRF,route,'POST',body,V,BAD_CSRF);
  await send('POST venue-refresh: missing CSRF token',CSRF,route,'POST',body,withoutCsrf(V));
  assert.deepEqual(await snapshot(),idle);
  const own=await f.request(route,'POST',body,V);
  assert.equal(own.status,400,JSON.stringify(own.body));assert.deepEqual(own.body,{error:'VENUE_REFRESH_MARKET_UNSUPPORTED',code:'VENUE_REFRESH_MARKET_UNSUPPORTED'});
});

// ---- budget -------------------------------------------------------------------------------------------------------------------
test('the file stays inside the API request budget of the server (240 per minute and source address)',()=>{
  // Every request above comes from one loopback address. A 429 from the shared bucket would look like a broken route, so a
  // new case that pushes the file near the bucket fails here first and must be split into another file.
  assert.ok(f.requestCount()<=200,'requests sent through the fixture: '+f.requestCount());
});
