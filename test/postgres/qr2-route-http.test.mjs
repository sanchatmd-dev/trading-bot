import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {createQr2Database,createOwner,createBot,policyFor,book,insertBars,barOf,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {enroll} from '../helpers.mjs';
import {hashPassword} from '../../src/security.js';
import {qr2PerformanceRoute,createQr2Slot,QR2_PERFORMANCE_PATH,QR2_ADMIN_READ_EVENT} from '../../src/postgres/qr2-routes.js';
import {readQr2Snapshot} from '../../src/postgres/qr2-reader.js';
import {executeQr2Job} from '../../src/postgres/qr2-compute-worker.js';
import {runMarketDeferred} from '../../src/postgres/market-ohlcv.js';
import {afterCommitFailureCount} from '../../src/postgres/request-dispatch.js';
import {validateResponse} from '../../src/portfolio/qr2-labels.js';
import {Qr2Error} from '../../src/portfolio/qr2-constants.js';

// QR-2 S3a route (RC-Q28 to RC-Q33; design tests H1 to H15). Isolated local PostgreSQL only (TEST_DATABASE_URL). Two groups:
// HTTP: server.js with the S3b compute pool (server.js:68, real worker thread) (forked by the fixture, QR2_PERFORMANCE_ENABLED=1, product default boundary record: the staging record of the registry), real auth and the
// SERIALIZABLE dispatcher. IN-PROCESS: the route function on a Store with the S2 fixture ledger and the LOCAL_FIXTURE_E2 test record, driven
// like the dispatcher drives it (phase 1, then the deferred function through the real runMarketDeferred, then the after-commit function).
// S3b: the route computes through an injected compute; the IN-PROCESS tests inject an in-thread executeQr2Job; the HTTP tests compute through the server's real worker pool. The worker pool has its own files
// (test/qr2-compute-pool.test.js, test/postgres/qr2-compute-http.test.mjs).
// Every direct-SQL write below is a labelled fixture or fault made by the test, never by the product.
const PW='Qr2-route-'+randomUUID();
const PATH=QR2_PERFORMANCE_PATH;
const DAY=86400000;
const NOT_OWNER={code:'QR2_NOT_OWNER',error:'Not found'};
const dayText=ms=>new Date(ms).toISOString().slice(0,10);

let f,off,sessions={},users={};

async function account(role){
  const user=await f.store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(PW),role});
  return user;
}
async function loginOf(user){
  const answer=await f.request('/api/auth/login','POST',{email:user.email,password:PW});
  assert.equal(answer.status,200,'fixture login');
  return answer.session;
}
const plan=(user,name)=>f.db.query("INSERT INTO licenses(id,key_hash,key_hint,plan,status,expires_at,assigned_user_id,created_at) VALUES($1,$2,'fixture',$3,'ACTIVE',$4,$5,$6)",
  [randomUUID(),randomUUID(),name,Date.now()+365*DAY,user.id,Date.now()]);
const get=(session,query)=>f.request(PATH+'?'+query,'GET',undefined,session);
const auditCount=async event=>Number((await f.db.query('SELECT count(*) AS n FROM audit WHERE event=$1',[event])).rows[0].n);

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{MARKET_PUBLIC_PROXY:'0',QR2_PERFORMANCE_ENABLED:'1'}});
  off=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{MARKET_PUBLIC_PROXY:'0',QR2_PERFORMANCE_ENABLED:''}});
  // A (FREE) owns bot a1; B (FREE) owns b1; P PERSONAL, R PRO, E ENTERPRISE own one Bot each; X is a SUPPORT user.
  for(const name of ['a','b','p','r','e'])users[name]=await account('USER');
  users.a1=await createBot(f.store,users.a,10000);users.b1=await createBot(f.store,users.b,10000);
  users.p1=await createBot(f.store,users.p,10000);users.r1=await createBot(f.store,users.r,10000);users.e1=await createBot(f.store,users.e,10000);
  await plan(users.p,'PERSONAL');await plan(users.r,'PRO');await plan(users.e,'ENTERPRISE');
  users.support=await account('SUPPORT');
  for(const name of ['a','b','p','r','e','support'])sessions[name]=await loginOf(users[name]);
});
after(async()=>{await f?.close();await off?.close();});

/* ------------------------------------------------------------------ HTTP group */

test('H13 flag off: the router answers 404 as for any unknown path; flag on: the route answers',async()=>{
  const session=await off.login(off.owner);
  const bot=off.owner.id;
  const unknown=await off.request('/api/paper-performance-unknown','GET',undefined,session);
  const gone=await off.request(PATH+'?bot_id='+bot+'&period=DAY','GET',undefined,session);
  assert.equal(gone.status,404);assert.deepEqual(gone.body,unknown.body,'the same body as an unknown route');
  assert.equal(JSON.stringify(gone.body).includes('QR2_'),false);
  // Flag off, a foreign or absent bot_id: the request falls through to the generic Bot ownership check, exactly as for any unknown /api path
  // with the same bot_id. The two answers are identical to each other and to the unknown-path answer (no existence oracle, no QR2_ text).
  const foreign=await off.request(PATH+'?bot_id='+off.foreign.id+'&period=DAY','GET',undefined,session);
  const absent=await off.request(PATH+'?bot_id='+randomUUID()+'&period=DAY','GET',undefined,session);
  const unknownForeign=await off.request('/api/paper-performance-unknown?bot_id='+off.foreign.id+'&period=DAY','GET',undefined,session);
  const unknownAbsent=await off.request('/api/paper-performance-unknown?bot_id='+randomUUID()+'&period=DAY','GET',undefined,session);
  assert.equal(foreign.status,unknownForeign.status);assert.deepEqual(foreign.body,unknownForeign.body);
  assert.equal(absent.status,unknownAbsent.status);assert.deepEqual(absent.body,unknownAbsent.body);
  assert.equal(foreign.status,absent.status);assert.deepEqual(foreign.body,absent.body,'a foreign and an absent Bot give identical bodies');
  assert.equal(JSON.stringify([foreign.body,absent.body]).includes('QR2_'),false);
  const on=await get(sessions.a,'bot_id='+users.a1.id+'&period=DAY');
  assert.equal(on.status,200,JSON.stringify(on.body));
  assert.equal(on.body.basis,'ACTUAL_PAPER_LEDGER');
  assert.equal(on.headers.get('cache-control'),'no-store');
  assert.equal((await f.request(PATH+'?bot_id='+users.a1.id)).status,401,'no session, no answer');
});

test('H1 scope: an owner reads an own child Bot and the own primary account; a foreign or absent Bot gives one byte-identical 404',async()=>{
  const own=await get(sessions.a,'bot_id='+users.a1.id+'&period=DAY');
  assert.equal(own.status,200);assert.equal(own.body.scope.bot_id,users.a1.id);
  assert.equal(validateResponse(own.body).ok,true);
  const primary=await get(sessions.a,'bot_id='+users.a.id+'&period=DAY');
  assert.equal(primary.status,200);assert.equal(primary.body.scope.bot_id,users.a.id);
  const answers=[
    await get(sessions.b,'bot_id='+users.a1.id+'&period=DAY'),
    await get(sessions.b,'bot_id='+users.a.id+'&period=DAY'),
    await get(sessions.a,'bot_id='+randomUUID()+'&period=DAY'),
    await get(sessions.a,'bot_id='+encodeURIComponent("x'; DROP TABLE users; --")+'&period=DAY'),
    await get(sessions.a,'bot_id='+'z'.repeat(300)+'&period=DAY'),
    await get(sessions.support,'bot_id='+users.a1.id+'&period=DAY')
  ];
  for(const [i,answer] of answers.entries()){
    assert.equal(answer.status,404,'case '+i);assert.deepEqual(answer.body,NOT_OWNER,'case '+i);
  }
  const text=new Set(answers.map(a=>JSON.stringify(a.body)));
  assert.equal(text.size,1,'one body for every cause');
  assert.equal(JSON.stringify(answers[0].body).includes(users.a1.id),false);
});

test('H2 parameters: user_id is never a selector; bot_id=all, a missing bot_id and a repeated parameter are refused',async()=>{
  const bot=users.a1.id;
  for(const extra of ['user_id='+users.b.id,'user_id='+users.a.id,'USER_ID='+users.a.id,'userId='+users.b.id,'user_id=']){
    const answer=await get(sessions.a,'bot_id='+bot+'&period=DAY&'+extra);
    assert.equal(answer.status,404,extra);assert.deepEqual(answer.body,NOT_OWNER,extra);
  }
  const user_first=await get(sessions.a,'user_id='+users.b.id+'&bot_id=all');
  assert.equal(user_first.status,404,'user_id wins over every other check');
  for(const query of ['bot_id=all&period=DAY','period=DAY','bot_id=&period=DAY','bot_id='+bot+'&bot_id='+users.a.id+'&period=DAY','bot_id='+bot+'&period=DAY&period=WEEK']){
    const answer=await get(sessions.a,query);
    assert.equal(answer.status,400,query);assert.equal(answer.body.code,'QR2_INPUT_INVALID',query);
  }
});

test('H3 admin: a cross-owner read needs analytics:any and a recent step-up and writes one committed audit row; own and absent Bots write none',async()=>{
  const admin=await account('ADMIN');
  const session=await loginOf(admin);
  const bot=users.a1.id,query='bot_id='+bot+'&period=DAY';
  const count0=await auditCount(QR2_ADMIN_READ_EVENT);
  // No MFA enrolled: refused before any data is read, and no audit row.
  const unenrolled=await get(session,query);
  assert.equal(unenrolled.status,403);assert.equal(unenrolled.body.code,'MFA_ENROLLMENT_REQUIRED');
  assert.equal(await auditCount(QR2_ADMIN_READ_EVENT),count0);
  // Enrolled: enabling MFA issues a stepped-up session.
  await enroll(f.request,session,PW);
  const read=await get(session,query);
  assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.scope.bot_id,bot);
  const rows=(await f.db.query('SELECT user_id,trade_id,details FROM audit WHERE event=$1 ORDER BY id',[QR2_ADMIN_READ_EVENT])).rows;
  assert.equal(rows.length,count0+1,'exactly one committed row');
  const row=rows.at(-1);
  assert.equal(row.user_id,admin.id);const details=JSON.parse(row.details);
  assert.deepEqual(Object.keys(details).sort(),['botId','broker','from','ownerId','period','to']);
  assert.deepEqual([details.botId,details.ownerId,details.broker,details.period],[bot,users.a.id,'binance-global','DAY']);
  assert.ok(Number.isSafeInteger(details.from)&&details.from%DAY===0&&details.to>details.from,'the resolved range is recorded');
  // An admin reading an own Bot is an owner read: no row.
  const mine=await createBot(f.store,admin,1000);
  assert.equal((await get(session,'bot_id='+mine.id+'&period=DAY')).status,200);
  assert.equal(await auditCount(QR2_ADMIN_READ_EVENT),count0+1);
  // An absent Bot: the same 404 as everyone else, and no row.
  const absent=await get(session,'bot_id='+randomUUID()+'&period=DAY');
  assert.equal(absent.status,404);assert.deepEqual(absent.body,NOT_OWNER);
  assert.equal(await auditCount(QR2_ADMIN_READ_EVENT),count0+1);
  // The step-up expires: refused, no row.
  await f.db.query('UPDATE sessions SET elevated_until=1 WHERE user_id=$1',[admin.id]);
  const expired=await get(session,query);
  assert.equal(expired.status,403);assert.equal(expired.body.code,'STEP_UP_REQUIRED');
  assert.equal(await auditCount(QR2_ADMIN_READ_EVENT),count0+1);
  // SUPPORT has no analytics:any: a cross-owner read is the not-owner 404 (also covered in H1).
  assert.equal((await get(sessions.support,query)).status,404);
});

test('H4 bounds: custom windows of at most 3660 days, strict dates, unknown parameters, fee overlays and other methods',async()=>{
  const bot=users.e1.id,session=sessions.e,today=Date.now();
  const span=days=>{const to=Math.floor(today/DAY)*DAY;return `bot_id=${bot}&period=CUSTOM&from=${dayText(to-(days-1)*DAY)}&to=${dayText(to)}`;};
  const ok=await get(session,span(3660));
  assert.equal(ok.status,200,JSON.stringify(ok.body));
  assert.ok(ok.body.range_flags.includes('COVERAGE_STARTS_AFTER_REQUEST'),'history before registration is flagged, never lengthened');
  const tooLong=await get(session,span(3661));
  assert.equal(tooLong.status,400);assert.equal(tooLong.body.code,'QR2_RANGE_INVALID');
  const refused=(query,status,code)=>get(session,query).then(answer=>{assert.equal(answer.status,status,query);assert.equal(answer.body.code,code,query);return answer;});
  await refused(`bot_id=${bot}&period=CUSTOM&from=2026-05-02&to=2026-05-01`,400,'QR2_RANGE_INVALID');
  for(const bad of ['2026-13-01','2026-02-30','2026-1-1','2026-01-01T00:00:00Z','x','']){
    await refused(`bot_id=${bot}&period=CUSTOM&from=${encodeURIComponent(bad)}&to=2026-05-01`,400,'QR2_INPUT_INVALID');
  }
  await refused(`bot_id=${bot}&period=CUSTOM&from=2026-05-01`,400,'QR2_INPUT_INVALID');
  await refused(`bot_id=${bot}&period=DAY&from=2026-05-01&to=2026-05-02`,400,'QR2_INPUT_INVALID');
  await refused(`bot_id=${bot}&period=CUSTOM&from=${dayText(today+2*DAY)}&to=${dayText(today+3*DAY)}`,400,'QR2_RANGE_INVALID');
  await refused(`bot_id=${bot}&period=FORTNIGHT`,400,'QR2_INPUT_INVALID');
  await refused(`bot_id=${bot}&period=DAY&broker=nyse`,400,'QR2_INPUT_INVALID');
  await refused(`bot_id=${bot}&period=DAY&symbol=BTCUSDT`,400,'QR2_INPUT_INVALID');
  for(const name of ['fee_bps','feeBps','FEE_BPS'])await refused(`bot_id=${bot}&period=DAY&${name}=10`,400,'QR2_FEE_OVERLAY_REFUSED');
  await refused(`bot_id=${bot}&period=day`,400,'QR2_INPUT_INVALID');
  await refused(`bot_id=${bot}&period=Month`,400,'QR2_INPUT_INVALID');
  const defaults=await get(session,`bot_id=${bot}`);
  assert.equal(defaults.status,200,'period defaults to MONTH and broker to binance-global');
  assert.equal(defaults.body.scope.broker,'binance-global');
  for(const period of ['DAY','WEEK','MONTH','YEAR','ALL_TIME']){
    const answer=await get(session,`bot_id=${bot}&period=${period}`);
    assert.equal(answer.status,200,period);assert.equal(validateResponse(answer.body).ok,true,period);
  }
  const post=await f.request(PATH+'?bot_id='+bot+'&period=DAY','POST',{},session);
  assert.equal(post.status,405);assert.deepEqual(post.body,{error:'Method not allowed'});
  // A refusal is a request-level answer: code and fixed text, never a header or a view.
  assert.deepEqual(Object.keys(tooLong.body).sort(),['code','error']);
});

test('H5 plan history: the limit applies to the start of every period (interim, owner item O-1)',async()=>{
  const today=Math.floor(Date.now()/DAY)*DAY;
  const custom=(bot,days)=>`bot_id=${bot}&period=CUSTOM&from=${dayText(today-days*DAY)}&to=${dayText(today)}`;
  const limit=async(session,bot,days,max)=>{
    const answer=await get(session,custom(bot,days));
    if(max===null){assert.equal(answer.status,200,days+' days');return;}
    assert.equal(answer.status,403,days+' days');
    assert.deepEqual(answer.body,{code:'QR2_RANGE_ADMISSION_REFUSED',error:'The request is over a limit',detail:{limit:'history_days',max}});
  };
  await limit(sessions.a,users.a1.id,29,null);await limit(sessions.a,users.a1.id,40,30);
  await limit(sessions.p,users.p1.id,85,null);await limit(sessions.p,users.p1.id,100,90);
  await limit(sessions.r,users.r1.id,170,null);await limit(sessions.r,users.r1.id,200,180);
  await limit(sessions.e,users.e1.id,3000,null);
  // The current day always fits; a FREE owner asking for the year or all time is refused only when that start is older than 30 days.
  assert.equal((await get(sessions.a,'bot_id='+users.a1.id+'&period=DAY')).status,200);
  const yearStart=Date.UTC(new Date().getUTCFullYear(),0,1);
  const year=await get(sessions.a,'bot_id='+users.a1.id+'&period=YEAR');
  assert.equal(year.status,Date.now()-yearStart>30*DAY?403:200);
});

test('H6 admission: ledger rows exactly at the limit are read, one more is refused with no partial body; the grid limit is checked first',async()=>{
  const bot=users.e1.id,session=sessions.e;
  const first=await get(session,`bot_id=${bot}&period=DAY`);
  const base=first.body.reader.counts.total;
  // Labelled fixture rows: paper_snapshots only, enough to reach the limit exactly.
  const fill=count=>f.db.query("INSERT INTO paper_snapshots(user_id,broker,at,reason,cash,book_equity,position_cost) SELECT $1,'binance-global',$2::bigint+g,'qr2-s3a-fixture',0,0,0 FROM generate_series(1,$3::int) g",[bot,Date.now()+1000,count]);
  await fill(5000-base);
  const atLimit=await get(session,`bot_id=${bot}&period=DAY`);
  assert.equal(atLimit.status,200);assert.equal(atLimit.body.reader.counts.total,5000);
  await fill(1);
  const over=await get(session,`bot_id=${bot}&period=DAY`);
  assert.equal(over.status,422);
  assert.deepEqual(over.body,{code:'QR2_RANGE_ADMISSION_REFUSED',error:'The request is over a limit',detail:{limit:'ledger_rows',value:5001,max:5000}});
  // Grid limit: a registration far in the past makes ALL_TIME exceed 5000 instants; refused before any row is counted.
  const old=users.p1.id;
  await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[old,Date.now()-6000*DAY]);
  await f.db.query("UPDATE licenses SET plan='ENTERPRISE' WHERE assigned_user_id=$1",[users.p.id]);
  const grid=await get(sessions.p,`bot_id=${old}&period=ALL_TIME`);
  assert.equal(grid.status,422,JSON.stringify(grid.body));
  assert.equal(grid.body.detail.limit,'grid_instants');assert.equal(grid.body.detail.max,5000);
});

test('H8 product default boundary record is the staging record: a fill booked now is in the open E2 row and reconciles; a funding-only account keeps NAV and returns',async()=>{
  const owner=await account('USER');const session=await loginOf(owner);
  const funded=await createBot(f.store,owner,10000);
  const traded=await createBot(f.store,owner,10000);
  await book(f.store,traded,'h8-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  const only=await get(session,`bot_id=${funded.id}&period=DAY`);
  assert.equal(only.status,200,JSON.stringify(only.body));
  assert.equal(only.body.account.nav.value,'10000');assert.equal(only.body.account.cash.value,'10000');
  assert.notEqual(only.body.account.twr.value,null,'returns are present without fills');
  assert.equal(only.body.account.money_pnl.value,'0');
  assert.notEqual(only.body.status.status,'UNAVAILABLE');
  const withFills=await get(session,`bot_id=${traded.id}&period=DAY`);
  assert.equal(withFills.status,200);
  // No price bar is stored in this group, so only the reconciliation is asserted here (valuation is covered with a price in qr2-boundary-wiring and
  // qr2-boundary-server). The fail-closed answer of the UNRECORDED product default is covered where it can be given explicitly: qr2-boundary-wiring P2 and P3.
  assert.equal(withFills.body.reconciliation.state,'OK',JSON.stringify(withFills.body.reconciliation));
  assert.equal(withFills.body.reconciliation.first_failure,null);
  assert.equal(validateResponse(withFills.body).ok,true);
});

test('H9 O8: the legacy Quant gate is not applied; the module imports no research code',async()=>{
  // The fixture runs the staging server with QUANT_RESEARCH_FOUNDATION_ENABLED=1: the legacy analytics report is denied there.
  const legacy=await f.request('/api/analytics/summary?user_id='+users.a1.id,'GET',undefined,sessions.a);
  assert.equal(legacy.status,409);assert.equal(legacy.body.code,'QUANT_MANAGED_REPORT_REQUIRED');
  const qr2=await get(sessions.a,'bot_id='+users.a1.id+'&period=DAY');
  assert.equal(qr2.status,200);
  // Static import graph of the two new product modules: no quant-research, quant-library or other quant module, and no legacyQuantDenied.
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const seen=new Set(),queue=[path.join(root,'src/postgres/qr2-routes.js'),path.join(root,'src/portfolio/qr2-response.js')];
  while(queue.length){
    const file=queue.pop();if(seen.has(file))continue;seen.add(file);
    const source=fs.readFileSync(file,'utf8').replace(/\/\/.*$/gm,'');
    assert.equal(source.includes('legacyQuantDenied'),false,file);
    for(const m of source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)){
      assert.equal(/quant/.test(m[1]),false,file+' imports '+m[1]);
      queue.push(path.resolve(path.dirname(file),m[1]));
    }
  }
  assert.ok(seen.size>=10,'the walk reached the portfolio library and the reader');
});

const TABLES=['paper_funding','paper_snapshots','paper_cash_journal','fills','signals','ledger_positions','ledger_position_allocations','paper_ledger_fence','risk_profiles','bot_sessions','pine_market_bars','users','system_settings'];
async function digests(db){
  const out={};
  for(const table of TABLES){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM public.${table} x`)).rows[0].d:null;
  }
  out.audit_other=(await db.query("SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM public.audit x WHERE x.event NOT IN ('request.error','qr2.admin_read','qr2.finding')")).rows[0].d;
  return out;
}

test('H10 no write: whole-table digests of the ledger and its neighbours are unchanged by reads and refusals; only qr2.* audit rows can appear',async()=>{
  const before=await digests(f.db);
  for(const query of ['bot_id='+users.a1.id+'&period=DAY','bot_id='+users.a1.id+'&period=ALL_TIME','bot_id='+users.a.id+'&period=WEEK']){
    assert.equal((await get(sessions.a,query)).status,200);
  }
  assert.equal((await get(sessions.b,'bot_id='+users.a1.id+'&period=DAY')).status,404);
  assert.equal((await get(sessions.a,'bot_id=all')).status,400);
  assert.deepEqual(await digests(f.db),before);
  const writers=(await f.db.query("SELECT DISTINCT event FROM audit WHERE event LIKE 'qr2.%'")).rows.map(r=>r.event);
  for(const event of writers)assert.ok(['qr2.admin_read','qr2.finding'].includes(event),event);
});

test('H16 end to end: the real dispatcher runs the audit writer after the answer (an injected R7 fault on a funded Bot gives a qr2.finding row)',async()=>{
  const bot=users.a1.id;
  const rows=()=>f.db.query("SELECT details FROM audit WHERE user_id=$1 AND event='qr2.finding'",[bot]).then(r=>r.rows.map(x=>JSON.parse(x.details)));
  assert.deepEqual(await rows(),[],'no finding row before the fault');
  // Labelled fixture fault made by the test: a stored position cost with no replayed cost behind it (R7 COST_DRIFT).
  await f.db.query("INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,updated_at,cost_basis) VALUES($1,'binance-global:primary','PAPER','binance-global','R7FIXTURE',0,$2,0.000000000000000001)",[bot,Date.now()]);
  const answer=await get(sessions.a,'bot_id='+bot+'&period=DAY');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  let found=[];
  for(let waited=0;waited<2000;waited+=50){
    found=(await rows()).filter(d=>d.check_id==='R7');
    if(found.length)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(found.length>=1,'the audit writer ran after the answer, through the real dispatcher');
  await f.db.query("DELETE FROM ledger_positions WHERE user_id=$1 AND symbol='R7FIXTURE'",[bot]);
});

/* ------------------------------------------------------------------ in-process group */

let fx,store,owner,dbs;
async function priceNow(price='62000'){await fx.db.query('DELETE FROM public.pine_market_bars');await insertBars(fx.db,[barOf(Date.now()-1000,price)]);}
async function tradedBot(){
  const o=await createOwner(store),bot=await createBot(store,o,10000);bot.owner=o;
  await priceNow();
  const tag=bot.id.slice(0,6);
  const buy=await book(store,bot,'ip-b-'+tag,{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(store,bot,'ip-s-'+tag,{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  await priceNow();
  return {bot,buy};
}
// Drives the route like the dispatcher: phase 1, the deferred function through the real market runner, then the after-commit function.
async function drive(query,actor,deps={}){
  const url=new URL('http://localhost'+PATH+'?'+query);
  const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null,phase2AfterCommit:null};
  const json=(r,status,body)=>{r.phase2Result={status,body};};
  const handled=await qr2PerformanceRoute({method:'GET',headers:{}},res,url,actor,{store,auth:{sensitive:async()=>{}},json,enabled:true,slot:createQr2Slot(),boundaries:LOCAL_FIXTURE_E2,compute:inlineCompute,...deps});
  const result=res.phase2Deferred?await runMarketDeferred(res.phase2Deferred):res.phase2Result;
  return {handled,result,res,hook:()=>res.phase2AfterCommit};
}
// S3b: the route computes through an injected compute (the product passes the worker pool). These tests run the same pure computation in-thread;
// the pool itself is covered by test/qr2-compute-pool.test.js and test/postgres/qr2-compute-http.test.mjs.
const inlineCompute={run:async(snapshot,input)=>executeQr2Job({snapshot,input})};
const pending=()=>{let release;const gate=new Promise(r=>{release=r;});return {gate,release};};

before(async()=>{fx=await createQr2Database('robot_qr2_route');({store}=fx);owner=await createOwner(store);});
after(async()=>{await fx?.dispose();});

test('H8 with a recorded test boundary the route returns the hand values (cash 9644, NAV 10016, realized 4, unrealized 12, fees 0)',async()=>{
  const {bot}=await tradedBot();
  const {result}=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner);
  assert.equal(result.status,200);
  const a=result.body.account;
  assert.deepEqual([a.cash.value,a.nav.value,a.market_value.value,a.position_cost.value,a.realized_pnl.value,a.unrealized_pnl.value,a.fees.value,a.flows_total.value,a.money_pnl.value,a.twr.value],
    ['9644','10016','372','360','4','12','0','10000','16','0.0016']);
  assert.equal(result.body.symbols[0].quantity.value,'0.006');assert.equal(result.body.symbols[0].price_state,'FRESH');
  assert.deepEqual(result.body.ledger_rule_epochs,['E2']);
  assert.equal(validateResponse(result.body).ok,true);
  const text=JSON.stringify(result.body);
  assert.equal(text.includes(bot.owner.id),false,'the owner id is not part of the body');
  assert.equal(Object.hasOwn(result.body,'rows'),false);
});

test('H7 concurrency: a second request while one holds the slot is refused 429 and never queued; the first is unaffected; the slot is released after an error',async()=>{
  const {bot}=await tradedBot();
  const slot=createQr2Slot();
  const gate=pending();
  let started;const startedSignal=new Promise(r=>{started=r;});
  const slow=async(...args)=>{started();await gate.gate;return readQr2Snapshot(...args);};
  const first=drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{slot,readSnapshot:slow});
  await startedSignal;
  assert.equal(slot.busy,1);
  const second=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{slot});
  assert.equal(second.result.status,429);
  assert.deepEqual(second.result.body,{code:'QR2_RANGE_ADMISSION_REFUSED',error:'The request is over a limit',detail:{limit:'concurrency',max:1}});
  gate.release();
  const done=await first;
  assert.equal(done.result.status,200);assert.equal(done.result.body.account.nav.value,'10016');
  assert.equal(slot.busy,0);
  // An internal error releases the slot too.
  const boom=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{slot,readSnapshot:async()=>{throw new Error('relation "x" does not exist');}});
  assert.equal(boom.result.status,503);assert.equal(slot.busy,0);
  assert.equal((await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{slot})).result.status,200);
});

test('H11 audit: one row per distinct defect after the answer, none on a repeat, none when the request fails; an audit failure leaves the answer unchanged',async()=>{
  const {bot,buy}=await tradedBot();
  // Two labelled faults, as in test/postgres/qr2-audit.test.mjs: an R7 cost drift and an R2 journal change.
  await fx.db.query('UPDATE public.ledger_positions SET cost_basis=cost_basis+0.000000000000000001 WHERE user_id=$1',[bot.id]);
  await fx.db.query('UPDATE public.paper_cash_journal SET cash_delta=cash_delta+0.000000000000000001 WHERE signal_id=$1',[buy.id]);
  const rows=()=>fx.db.query("SELECT trade_id,details FROM public.audit WHERE user_id=$1 AND event='qr2.finding' ORDER BY id",[bot.id]).then(r=>r.rows);
  const run=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner);
  assert.equal(run.result.status,200);
  assert.deepEqual(await rows(),[],'phase 2 itself writes no audit row');
  assert.equal(typeof run.hook(),'function','the after-commit function is registered');
  await run.hook()();
  const written=await rows();
  const checks=new Set(written.map(r=>JSON.parse(r.details).check_id));
  assert.ok(checks.has('R7')&&checks.has('R2'),[...checks].join());
  assert.equal(written.length,new Set(written.map(r=>r.trade_id)).size,'one row per distinct defect key');
  // A second GET adds none.
  const again=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner);
  await again.hook()();
  assert.equal((await rows()).length,written.length);
  // A request that fails writes none: a not-owner request registers no function.
  const other=await createOwner(store);
  const denied=await drive(`bot_id=${bot.id}&period=DAY`,{...other,role:'USER'});
  assert.equal(denied.result.status,404);assert.equal(denied.hook(),null);
  assert.equal((await rows()).length,written.length);
  // An audit writer that throws changes nothing about the answer: the dispatcher counts it (see request-dispatch-after-commit tests).
  const failing=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{writeAudit:async()=>{throw new Error('audit down');}});
  assert.equal(failing.result.status,200);assert.deepEqual(failing.result.body.account.nav,run.result.body.account.nav);
  await assert.rejects(failing.hook()(),/audit down/);
  assert.equal(typeof afterCommitFailureCount(),'number');
  // Inside a transaction the writer refuses: the function is meant to run after the answer, outside any transaction.
  const refuse=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner);
  await assert.rejects(fx.db.transaction(()=>refuse.hook()(),{isolation:'READ COMMITTED'}),{code:'QR2_AUDIT_OUTSIDE_TRANSACTION_REQUIRED'});
});

test('H12 an injected cross-Bot row: 200 with status REFUSED, the code and counts only, no foreign value',async()=>{
  const {bot,buy}=await tradedBot();
  const other=await createBot(store,bot.owner,5000);
  await fx.db.query('UPDATE public.paper_cash_journal SET user_id=$2,cash_delta=-777.123456 WHERE signal_id=$1',[buy.id,other.id]);
  const {result,hook}=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner);
  assert.equal(result.status,200);
  assert.equal(result.body.status.status,'REFUSED');assert.equal(result.body.code,'QR2_CROSS_BOT_ROW');
  assert.equal(result.body.basis,'ACTUAL_PAPER_LEDGER');assert.equal(validateResponse(result.body).ok,true);
  const text=JSON.stringify(result.body);
  for(const foreign of [other.id,'777.123456','-777'])assert.equal(text.includes(foreign),false,foreign);
  assert.equal(result.body.account,undefined);assert.equal(result.body.symbols,undefined);
  assert.equal(result.body.reader.counts.journal,2);
  assert.equal(typeof hook(),'function','the refusal itself is audited with an opaque key');
});

test('H14 an internal throw in phase 2 gives 503 QR2_REPORT_FAILED and never a MARKET_ code; an invalid composition gives 500 QR2_RESPONSE_INVALID',async()=>{
  const {bot}=await tradedBot();
  const thrown=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{readSnapshot:async()=>{throw Object.assign(new Error('SELECT secret FROM x'),{code:'XX000'});}});
  assert.equal(thrown.result.status,503);
  assert.deepEqual(thrown.result.body,{code:'QR2_REPORT_FAILED',error:'Performance report could not be produced'});
  assert.equal(JSON.stringify(thrown.result.body).includes('MARKET_'),false);
  // The deferred function never throws: called bare it returns the answer, so the market runner has nothing to convert.
  const url=new URL('http://localhost'+PATH+'?bot_id='+bot.id+'&period=DAY');
  const res={phase2Buffer:true};
  await qr2PerformanceRoute({method:'GET',headers:{}},res,url,bot.owner,{store,auth:{},json:()=>{},enabled:true,slot:createQr2Slot(),readSnapshot:async()=>{throw new Error('x');}});
  assert.deepEqual(await res.phase2Deferred(),{status:503,body:{code:'QR2_REPORT_FAILED',error:'Performance report could not be produced'}});
  // A reader that returns a view the composer cannot validate fails closed.
  const badView=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{compute:{run:async()=>({ok:false,kind:'response'})}});
  assert.equal(badView.result.status,500);assert.equal(badView.result.body.code,'QR2_RESPONSE_INVALID');
  for(const code of ['QR2_READER_SNAPSHOT_REQUIRED','QR2_BOUNDARY_RECORD_INVALID']){
    const error=Object.assign(new Error('internal '+code),{name:'Qr2Error',code});
    const answer=await drive(`bot_id=${bot.id}&period=DAY`,bot.owner,{readSnapshot:async()=>{throw error;}});
    assert.equal(answer.result.status,503,code);assert.equal(answer.result.body.code,'QR2_REPORT_FAILED',code);
  }
});

test('H15 a re-parent of the Bot between phase 1 and phase 2 fails closed with the not-owner answer',async()=>{
  const {bot}=await tradedBot();
  const stranger=await createOwner(store);
  const url=new URL('http://localhost'+PATH+'?bot_id='+bot.id+'&period=DAY');
  const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null};
  await qr2PerformanceRoute({method:'GET',headers:{}},res,url,bot.owner,{store,auth:{},json:(r,s,b)=>{r.phase2Result={status:s,body:b};},enabled:true,slot:createQr2Slot(),boundaries:LOCAL_FIXTURE_E2});
  assert.equal(typeof res.phase2Deferred,'function','phase 1 passed');
  await fx.db.query('UPDATE users SET parent_user_id=$2 WHERE id=$1',[bot.id,stranger.id]);
  const result=await runMarketDeferred(res.phase2Deferred);
  assert.equal(result.status,404);assert.deepEqual(result.body,NOT_OWNER);
  await fx.db.query('UPDATE users SET parent_user_id=$2 WHERE id=$1',[bot.id,bot.owner.id]);
});

test('route guards: the route is inert when disabled or for another path, answers 405 for other methods and takes the slot only in phase 2',async()=>{
  const {bot}=await tradedBot();
  const slot=createQr2Slot();
  const run=async(options,method='GET',pathname=PATH)=>{
    const res={phase2Buffer:true,phase2Result:null,phase2Deferred:null};
    const json=(r,s,b)=>{r.phase2Result={status:s,body:b};};
    const handled=await qr2PerformanceRoute({method,headers:{}},res,new URL('http://localhost'+pathname+'?bot_id='+bot.id+'&period=DAY'),bot.owner,{store,auth:{},json,slot,boundaries:LOCAL_FIXTURE_E2,...options});
    return {handled,res};
  };
  assert.equal((await run({enabled:false})).handled,false);
  assert.equal((await run({enabled:undefined})).handled,false);
  assert.equal((await run({enabled:true},'GET','/api/paper-performance2')).handled,false);
  const post=await run({enabled:true},'POST');
  assert.equal(post.handled,true);assert.deepEqual(post.res.phase2Result,{status:405,body:{error:'Method not allowed'}});
  const get=await run({enabled:true});
  assert.equal(get.handled,true);assert.equal(typeof get.res.phase2Deferred,'function');
  assert.equal(slot.busy,0,'phase 1 takes no slot');
  assert.equal(get.res.phase2Result,null,'phase 1 writes no answer; the deferred function does');
});

test('H5 history limit counts from UTC midnight of the request day: a 30-day plan reads the current month on a day 31, and no earlier start',async()=>{
  const owner=await createOwner(store),free=await createBot(store,owner,1000);
  const day31=Date.UTC(2026,9,31,0,0,1);
  const at=query=>drive(query,owner,{clock:()=>day31}).then(r=>r.result);
  // FREE plan (30 days): the month of 31 October starts on 1 October, exactly 30 days before the midnight of the request day.
  const month=await at(`bot_id=${free.id}&period=MONTH`);
  assert.equal(month.status,200,JSON.stringify(month.body));
  assert.equal((await at(`bot_id=${free.id}&period=DAY`)).status,200);
  const custom=days=>`bot_id=${free.id}&period=CUSTOM&from=${dayText(Date.UTC(2026,9,31)-days*DAY)}&to=2026-10-31`;
  assert.equal((await at(custom(30))).status,200,'30 days before the request day is the last allowed start');
  const over=await at(custom(31));
  assert.equal(over.status,403);assert.deepEqual(over.body.detail,{limit:'history_days',max:30});
  // A year start is older than 30 days on that day: refused.
  assert.equal((await at(`bot_id=${free.id}&period=YEAR`)).status,403);
});

test('H3 audit before read: the admin audit row exists when the reader is called, and stays when phase 2 is refused',async()=>{
  const {bot}=await tradedBot();
  const admin=await createOwner(store);
  const count=async()=>Number((await fx.db.query("SELECT count(*) AS n FROM public.audit WHERE user_id=$1 AND event=$2",[admin.id,QR2_ADMIN_READ_EVENT])).rows[0].n);
  const query=`bot_id=${bot.id}&period=DAY`;
  const seenAtRead=[];
  const spy=async(...args)=>{seenAtRead.push(await count());return readQr2Snapshot(...args);};
  const ok=await drive(query,admin,{readSnapshot:spy});
  assert.equal(ok.result.status,200);
  assert.deepEqual(seenAtRead,[1],'one committed row when the reader is called');
  const row=(await fx.db.query("SELECT details FROM public.audit WHERE user_id=$1 AND event=$2",[admin.id,QR2_ADMIN_READ_EVENT])).rows[0];
  assert.deepEqual(Object.keys(JSON.parse(row.details)).sort(),['botId','broker','from','ownerId','period','to']);
  // Phase 2 refused because the slot is busy: no read, and the row of this request stays.
  const busySlot=createQr2Slot();busySlot.tryAcquire();
  let reads=0;
  const busy=await drive(query,admin,{slot:busySlot,readSnapshot:async()=>{reads++;throw new Error('must not read');}});
  assert.equal(busy.result.status,429);assert.equal(reads,0);
  assert.equal(await count(),2,'the row stays when the slot is busy');
  // Phase 2 failed with a throwing reader: the row stays.
  const thrown=await drive(query,admin,{readSnapshot:async()=>{throw new Error('reader down');}});
  assert.equal(thrown.result.status,503);
  assert.equal(await count(),3,'exactly one row per request, kept when the reader throws');
});

test('H17 phase 2 hardening: a missing slot, a reader input error and the Retry-After header',async()=>{
  const {bot}=await tradedBot();
  const query=`bot_id=${bot.id}&period=DAY`;
  // A missing slot dependency answers QR2_REPORT_FAILED, never a thrown TypeError and never a MARKET_ code.
  const noSlot=await drive(query,bot.owner,{slot:undefined});
  assert.equal(noSlot.result.status,503);assert.equal(noSlot.result.body.code,'QR2_REPORT_FAILED');
  const wrongSlot=await drive(query,bot.owner,{slot:{}});
  assert.equal(wrongSlot.result.body.code,'QR2_REPORT_FAILED');
  // A reader QR2_INPUT_INVALID in phase 2 is not client input: 503 QR2_REPORT_FAILED. A phase 1 input refusal stays 400.
  const inputError=new Qr2Error('QR2_INPUT_INVALID','reader argument');
  const reader=await drive(query,bot.owner,{readSnapshot:async()=>{throw inputError;}});
  assert.equal(reader.result.status,503);assert.equal(reader.result.body.code,'QR2_REPORT_FAILED');
  assert.equal((await drive('bot_id=all&period=DAY',bot.owner)).result.status,400);
  // 429 carries Retry-After: 2.
  const headers={};
  const slot=createQr2Slot();slot.tryAcquire();
  const url=new URL('http://localhost'+PATH+'?'+query);
  const res={phase2Buffer:true,phase2Deferred:null,setHeader:(name,value)=>{headers[name]=value;}};
  await qr2PerformanceRoute({method:'GET',headers:{}},res,url,bot.owner,{store,auth:{},json:()=>{},enabled:true,slot,boundaries:LOCAL_FIXTURE_E2});
  assert.equal((await res.phase2Deferred()).status,429);
  assert.deepEqual(headers,{'Retry-After':'2'});
});

test('spec D item 10: an ALL_TIME request over a coverage budget answers 200 with bar coverage class C7 (the financial report is unchanged); a short range keeps its normal coverage',async()=>{
  // ENTERPRISE has unlimited history, so history_days (403) cannot answer first; the range is over the default union_minutes (43200 minutes, 30 days).
  const owner=await account('USER');await plan(owner,'ENTERPRISE');
  const session=await loginOf(owner);
  const bot=await createBot(f.store,owner,10000);
  const age=45*DAY,registration=Date.now()-age;
  // Labelled synthetic chronology (as in qr2-coverage-integration): move the registration, the one CONFIGURATION funding and its FUNDING snapshot together.
  await f.db.transaction(async()=>{
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[bot.id,registration]);
    const funding=(await f.db.query('SELECT kind FROM paper_funding WHERE user_id=$1',[bot.id])).rows;
    assert.equal(funding.length,1);assert.equal(funding[0].kind,'CONFIGURATION');
    await f.db.query('UPDATE paper_funding SET at=$2 WHERE user_id=$1',[bot.id,registration+1]);
    await f.db.query('UPDATE paper_snapshots SET at=$2 WHERE user_id=$1',[bot.id,registration+1]);
  });
  const long=await get(session,`bot_id=${bot.id}&period=ALL_TIME`);
  assert.equal(long.status,200,JSON.stringify(long.body));
  assert.equal(validateResponse(long.body).ok,true);
  assert.notEqual(long.body.status.status,'REFUSED');
  const c=long.body.market_data.coverage;
  assert.deepEqual([c.state,c.reason,c.complete,c.expected_minutes,c.stored_minutes,c.missing_minutes,c.interval_count,c.intervals],['UNAVAILABLE','COVERAGE_BUDGET_EXCEEDED',false,null,null,null,null,null],'class C7: not inspected, no count, no gap list');
  assert.ok(c.inspected_window.to-c.inspected_window.from>43200*60000,'the inspected window is over the default span budget');
  // The financial part is a normal report: the funding-only account keeps its NAV.
  assert.equal(long.body.account.nav.value,'10000');assert.equal(long.body.account.cash.value,'10000');
  // A day inside the same Bot's life is far under the budget: its coverage is never C7.
  const day=await get(session,`bot_id=${bot.id}&period=DAY`);
  assert.equal(day.status,200,JSON.stringify(day.body));
  assert.notEqual(day.body.market_data.coverage.reason,'COVERAGE_BUDGET_EXCEEDED');
});
