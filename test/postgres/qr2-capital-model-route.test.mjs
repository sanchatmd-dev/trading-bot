import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {hashPassword} from '../../src/security.js';
import {enroll} from '../helpers.mjs';
import {appendCapitalModelDeclaration,mapCapitalModelFailure,QR2_CAPITAL_MODEL_PATH as PATH,QR2_CAPITAL_MODEL_EVENT as EVENT} from '../../src/postgres/qr2-capital-model-route.js';
import {policyFor} from '../helpers/qr2-reader-fixture.mjs';

// Real application HTTP/auth/dispatcher and a disposable database. Clock changes below affect only this fixture function, never production configuration.
const PW='Capital-route-'+randomUUID(),DAY=86400000,MID=Date.UTC(2026,9,23);
const BODY={currency:'USDT',capital_model:'INDEPENDENT_ACCOUNTS'};
let f,off,ddl,clockDefinition;
const account=async(role='USER')=>f.store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(PW),role});
const login=async user=>{const out=await f.request('/api/auth/login','POST',{email:user.email,password:PW});assert.equal(out.status,200);return out.session;};
const put=(session,body=BODY,query='')=>f.request(PATH+query,'PUT',body,session);
const rows=async(owner,currency='USDT')=>(await f.db.query('SELECT * FROM public.paper_capital_models WHERE owner_id=$1 AND currency=$2 ORDER BY version',[owner,currency])).rows;
const audits=async owner=>(await f.db.query('SELECT details FROM public.audit WHERE user_id=$1 AND event=$2 ORDER BY id',[owner,EVENT])).rows;
const write=(owner,over={},store=f.store)=>store.db.transaction(()=>appendCapitalModelDeclaration(store,{ownerId:owner,currency:'USDT',capitalModel:'INDEPENDENT_ACCOUNTS',...over}),{isolation:'SERIALIZABLE'});

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  ddl=await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8');
  clockDefinition=ddl.match(/CREATE FUNCTION public\.paper_capital_model_now_ms\(\)[\s\S]*?\$fn\$;/)[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
  f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{QR2_PERFORMANCE_ENABLED:'1',MARKET_PUBLIC_PROXY:'0'}});
  off=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{QR2_PERFORMANCE_ENABLED:'',MARKET_PUBLIC_PROXY:'0'}});
});
after(async()=>{await f?.close();await off?.close();});

// Fixed synthetic database times. Sequence consumption survives rollback, proving the dispatcher restarts from fresh samples.
async function clock(values){
  await f.db.query('DROP SEQUENCE IF EXISTS public.qr2_fixture_clock');
  await f.db.query('CREATE SEQUENCE public.qr2_fixture_clock');
  await f.db.query(`CREATE OR REPLACE FUNCTION public.paper_capital_model_now_ms() RETURNS BIGINT LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp
    AS $fixture$ SELECT (ARRAY[${values.join(',')}]::bigint[])[LEAST(pg_catalog.nextval('public.qr2_fixture_clock')::int,${values.length})] $fixture$`);
}
const resetClock=async()=>f.db.query(clockDefinition);

test('S44 absent extension is a safe 503; disabled route stays unknown and never installs the extension',async()=>{
  const user=await account(),session=await login(user);
  const absent=await put(session);
  assert.equal(absent.status,503);assert.equal(absent.body.code,'QR2_CAPITAL_MODEL_UNAVAILABLE');
  assert.equal(JSON.stringify(absent.body).includes('paper_capital_model_schema'),false);
  const disabled=await off.request(PATH,'PUT',BODY,await off.login(off.owner));
  assert.equal(disabled.status,404);
  assert.equal((await off.db.query("SELECT to_regclass('public.paper_capital_models') AS name")).rows[0].name,null);
  await f.db.query(ddl);
});

test('S44 real auth: session, canonical CSRF, sensitive elevation, child and ADMIN own scope',async()=>{
  assert.equal((await put(undefined)).status,401);
  const user=await account(),session=await login(user);
  const missing={cookie:{...session.cookie},csrf:''};
  assert.equal((await put(missing)).status,403);
  const forged={cookie:{...session.cookie},csrf:'not-csrf'};
  assert.equal((await put(forged)).status,403);
  await f.db.query('UPDATE sessions SET elevated_until=1 WHERE user_id=$1',[user.id]);
  const stepup=await put(session);assert.equal(stepup.status,403);assert.equal(stepup.body.code,'STEP_UP_REQUIRED');
  assert.equal((await rows(user.id)).length,0);
  const admin=await account('ADMIN'),adminSession=await login(admin);
  assert.equal((await put(adminSession)).body.code,'MFA_ENROLLMENT_REQUIRED');
  await enroll(f.request,adminSession,PW);
  const own=await put(adminSession);assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.declaration.owner_id,admin.id);
  const child=await f.store.createBot(user.id,'no login',policyFor(1000));
  const childLogin=await f.request('/api/auth/login','POST',{email:child.email,password:PW});
  assert.notEqual(childLogin.status,200);
  await assert.rejects(write(child.id),{code:'QR2_NOT_OWNER'});
});

test('S44 SUPPORT with own:write and MFA may declare only for its own primary account',async()=>{
  const user=await account('SUPPORT'),session=await login(user);
  const unenrolled=await put(session);assert.equal(unenrolled.status,403);assert.equal(unenrolled.body.code,'MFA_ENROLLMENT_REQUIRED');
  await enroll(f.request,session,PW);
  const own=await put(session);assert.equal(own.status,200,JSON.stringify(own.body));
  assert.equal(own.body.declaration.owner_id,user.id);assert.equal(own.body.declaration.declared_by,user.id);
  for(const body of [{...BODY,owner_id:f.foreign.id},{...BODY,declared_by:f.foreign.id},{...BODY,bot_set:[f.foreign.id]}]){
    const denied=await put(session,body);assert.equal(denied.status,400);assert.equal(denied.body.code,'QR2_INPUT_INVALID');
  }
  const query=await put(session,BODY,'?owner_id='+f.foreign.id);assert.equal(query.status,400);assert.equal(query.body.code,'QR2_INPUT_INVALID');
  assert.equal((await rows(user.id)).length,1);assert.equal((await audits(user.id)).length,1);
  assert.equal((await rows(f.foreign.id)).length,0);
});

test('S44 closed PUT rejects selectors, query keys, extra JSON fields and wrong methods before any declaration',async()=>{
  const user=await account(),session=await login(user);
  // The canonical body preloader rejects non-object JSON before the route assigns a QR2-specific code.
  for(const body of [null,[]]){
    const out=await put(session,body);assert.equal(out.status,400);assert.equal(out.body.error,'JSON object required');
  }
  for(const body of [{}, {...BODY,owner_id:f.foreign.id},{...BODY,bot_set:[user.id]},{...BODY,version:9},{...BODY,effective_from:MID},{...BODY,declared_by:f.foreign.id},{...BODY,currency:'USD'},{...BODY,capital_model:'SHARED'}]){
    const out=await put(session,body);assert.equal(out.status,400,JSON.stringify(body));assert.equal(out.body.code,'QR2_INPUT_INVALID');
  }
  for(const query of ['?owner_id='+f.foreign.id,'?currency=USDT','?bot_id='+f.foreign.id,'?currency=USDT&currency=THB'])assert.equal((await put(session,BODY,query)).status,400);
  assert.equal((await f.request(PATH,'DELETE',undefined,session)).status,405);
  assert.equal((await rows(user.id)).length,0);assert.equal((await audits(user.id)).length,0);
});

test('S44 USER append and withdrawal: server owner, full byte-sorted Bot set, per-currency versions and one audit per commit',async()=>{
  const user=await account(),session=await login(user);
  await f.store.createBot(user.id,'a',policyFor(1000));await f.store.createBot(user.id,'b',policyFor(1000));
  const set=(await f.store.listBots(user.id)).map(row=>row.id).sort();
  const first=await put(session),withdraw=await put(session,{currency:'USDT',capital_model:'SHARED_HYPOTHETICAL'}),thb=await put(session,{...BODY,currency:'THB'});
  for(const out of [first,withdraw,thb]){
    assert.equal(out.status,200,JSON.stringify(out.body));const d=out.body.declaration;
    assert.deepEqual(d.bot_set,set);assert.equal(d.owner_id,user.id);assert.equal(d.declared_by,user.id);
    assert.equal(d.effective_from,Math.floor(d.declared_at/DAY)*DAY+DAY);
    assert.deepEqual(Object.keys(d).sort(),['owner_id','currency','version','capital_model','bot_set','effective_from','declared_at','declared_by'].sort());
  }
  assert.deepEqual([first.body.declaration.version,withdraw.body.declaration.version,thb.body.declaration.version],[1,2,1]);
  assert.equal((await rows(user.id))[0].capital_model,'INDEPENDENT_ACCOUNTS');
  assert.equal((await rows(user.id))[1].capital_model,'SHARED_HYPOTHETICAL');
  assert.equal((await audits(user.id)).length,3);
});

test('S44 a complete five-Bot owner set is stored; ordinary createBot retains its existing fifth-child refusal',async()=>{
  const user=await account(),session=await login(user);
  for(let i=0;i<4;i++)await f.store.createBot(user.id,'slot '+i,policyFor(1000));
  const out=await put(session);assert.equal(out.status,200,JSON.stringify(out.body));
  const expected=(await f.store.listBots(user.id)).map(row=>row.id).sort();
  assert.equal(expected.length,5);assert.deepEqual(out.body.declaration.bot_set,expected);
  await assert.rejects(f.store.createBot(user.id,'too many',policyFor(1000)),/Maximum 5 bot profiles/);
  assert.equal((await f.store.listBots(user.id)).length,5);
});

test('S44 concurrent declarations commit gapless versions with matching audits through the real dispatcher',async()=>{
  const user=await account(),session=await login(user);
  const answers=await Promise.all([put(session),put(session),put(session)]);
  for(const out of answers)assert.equal(out.status,200,JSON.stringify(out.body));
  assert.deepEqual((await rows(user.id)).map(row=>Number(row.version)),[1,2,3]);
  assert.equal((await audits(user.id)).length,3);
});

test('S44 owner lock is held through audit and serializes createBot; a fresh request includes the committed child',async()=>{
  const user=await account();let entered,release;
  const held=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const own={db:f.db,audit:async(...args)=>{entered();await gate;return f.store.audit(...args);}};
  const writing=write(user.id,{},own);
  await held;
  let created=false;
  const creating=f.store.createBot(user.id,'concurrent',policyFor(1000)).then(bot=>{created=true;return bot;});
  try{await new Promise(resolve=>setTimeout(resolve,25));assert.equal(created,false,'createBot waits for declaration owner lock');}finally{release();}
  const first=await writing,child=await creating;
  assert.deepEqual(first.bot_set,[user.id],'the child is serialized after this declaration');
  const next=await write(user.id);
  assert.deepEqual(next.bot_set,[user.id,child.id].sort(),'fresh request sees the committed child');
});

test('S44 createBot tuple write invalidates an already authenticated declaration snapshot; retry includes the full new set exactly once',async()=>{
  const user=await account(),session=await login(user);let entered,release;
  const held=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const creating=f.store.createBot(user.id,'snapshot-race',policyFor(1000),async()=>{entered();await gate;});
  await held;
  const pending=put(session);
  let waiting=false;
  try{
    for(let i=0;i<200;i++){
      const out=await f.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE public.users SET label=label%'");
      if(out.rows[0].n>0){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'HTTP auth established its snapshot and the declaration now waits on the owner tuple');
  }finally{release();}
  const bot=await creating,out=await pending;
  assert.equal(out.status,200,JSON.stringify(out.body));
  assert.deepEqual(out.body.declaration.bot_set,[user.id,bot.id].sort());
  assert.equal(out.body.declaration.version,1);
  assert.equal((await rows(user.id)).length,1);assert.equal((await audits(user.id)).length,1);
  const bots=await f.store.listBots(user.id);
  assert.equal(bots.length,2,'ordinary createBot commits one child without duplication');
  assert.equal(bots.filter(row=>row.id===bot.id).length,1);
});

test('S44 failed declaration audit rolls back the inserted version and leaves no declaration or success audit',async()=>{
  const user=await account(),broken={db:f.db,audit:async()=>{throw new Error('fixture private audit detail');}};
  await assert.rejects(write(user.id,{},broken),error=>error.code==='QR2_CAPITAL_MODEL_DECLARATION_REFUSED'&&!error.message.includes('private'));
  assert.equal((await rows(user.id)).length,0);assert.equal((await audits(user.id)).length,0);
});

test('S44 real HTTP audit database failure rolls the declaration back and returns only a sanitized error',async()=>{
  const user=await account(),session=await login(user);
  await f.db.query(`CREATE FUNCTION public.qr2_fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $fixture$
    BEGIN IF NEW.event='${EVENT}' AND NEW.user_id=TG_ARGV[0] THEN RAISE EXCEPTION 'PRIVATE_FIXTURE_AUDIT_ROW' USING ERRCODE='23514',CONSTRAINT='qr2_fixture_audit'; END IF; RETURN NEW; END $fixture$`);
  await f.db.query(`CREATE TRIGGER qr2_fixture_reject_audit BEFORE INSERT ON public.audit FOR EACH ROW EXECUTE FUNCTION public.qr2_fixture_reject_audit('${user.id}')`);
  try{
    const out=await put(session);assert.equal(out.status,503);assert.equal(out.body.code,'QR2_CAPITAL_MODEL_DECLARATION_REFUSED');
    assert.equal(JSON.stringify(out.body).includes('PRIVATE_FIXTURE'),false);
    assert.equal((await rows(user.id)).length,0);assert.equal((await audits(user.id)).length,0);
  }finally{
    await f.db.query('DROP TRIGGER qr2_fixture_reject_audit ON public.audit');
    await f.db.query('DROP FUNCTION public.qr2_fixture_reject_audit()');
  }
});

test('S44 DB exact-midnight stamp always activates strictly NEXT midnight, independent of process time',async()=>{
  const user=await account(),session=await login(user);
  try{await clock([MID]);const out=await put(session);assert.equal(out.status,200,JSON.stringify(out.body));assert.equal(out.body.declaration.declared_at,MID);assert.equal(out.body.declaration.effective_from,MID+DAY);}finally{await resetClock();}
});

test('S44 returned midnight rollover retries on a fresh dispatcher transaction; past-midnight clock guard is safe 503 without unproved retry',async()=>{
  const user=await account(),session=await login(user);
  try{
    await clock([MID-1,MID,MID+1,MID+1]);
    const out=await put(session);assert.equal(out.status,200,JSON.stringify(out.body));
    assert.equal(out.body.declaration.version,1);assert.equal(out.body.declaration.declared_at,MID+1);assert.equal(out.body.declaration.effective_from,MID+DAY);
    assert.equal((await rows(user.id)).length,1);assert.equal((await audits(user.id)).length,1);
    const other=await account(),otherSession=await login(other);
    await clock([MID-1,MID+1]);const guarded=await put(otherSession);
    assert.equal(guarded.status,503);assert.equal(guarded.body.code,'QR2_CAPITAL_MODEL_DECLARATION_REFUSED');
    assert.equal((await rows(other.id)).length,0);assert.equal((await audits(other.id)).length,0);
    assert.equal(Number((await f.db.query('SELECT last_value FROM public.qr2_fixture_clock')).rows[0].last_value),2,'unproved clock constraint is not retried');
  }finally{await resetClock();}
});

test('S44 cap1000 applies per currency and exact constraint mapping never leaks database detail',async()=>{
  const user=await account(),session=await login(user);
  await f.db.transaction(async()=>{
    await f.db.query(`INSERT INTO public.paper_capital_models(owner_id,currency,version,capital_model,bot_set,effective_from,declared_at,declared_by)
      SELECT $1,'USDT',v,'SHARED_HYPOTHETICAL',jsonb_build_array($1::text),((public.paper_capital_model_now_ms()/86400000)+1)*86400000,0,$1 FROM generate_series(1,1000) v`,[user.id]);
  },{isolation:'SERIALIZABLE'});
  const capped=await put(session);assert.equal(capped.status,422);assert.equal(capped.body.code,'QR2_CAPITAL_MODEL_LIMIT_REACHED');
  assert.equal((await rows(user.id)).length,1000);assert.equal((await audits(user.id)).length,0);
  assert.equal((await put(session,{...BODY,currency:'THB'})).status,200);
  for(const [code,constraint] of [['23514','paper_capital_models_effective_from_check'],['QR004','paper_capital_models_clock'],['QR004','paper_capital_models_version'],['QR004','paper_capital_models_bot_set'],['QR004','paper_capital_models_owner']]){
    const mapped=mapCapitalModelFailure(Object.assign(new Error('PRIVATE_ROW'),{code,constraint,detail:'PRIVATE_ROW'}));
    assert.ok(mapped&&mapped.status);assert.equal(JSON.stringify(mapped).includes('PRIVATE_ROW'),false);assert.equal(mapped.message.includes('PRIVATE_ROW'),false);
  }
  for(const code of ['40001','40P01'])assert.equal(mapCapitalModelFailure({code}),null,'dispatcher owns '+code);
});
