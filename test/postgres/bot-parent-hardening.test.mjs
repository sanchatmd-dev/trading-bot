import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {BOT_PARENT_FUNCTION,PINNED_SEARCH_PATH,botParentBodies,inspectBotParentHardening,migrateBotParentHardening,rollbackBotParentHardening}
  from '../../src/postgres/bot-parent-hardening-migration.js';

// GH2: check_bot_parent() must not read a session TEMP table in place of users (finding GH1-BOT-PARENT).
// Proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repo grants. Every row is a LABELLED FIXTURE.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const REFUSED='P0001:Invalid bot owner or slot';
let admin,db,databaseName,roleName,connectionString,runtimeUrl;
const databases=[],sessions=[];
// The child is its own test run: inheriting NODE_TEST_CONTEXT (set when this file runs in its own process) would make it
// report in the parent runner's binary format, with no text summary to parse.
const childEnv=()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;return env;};
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
async function session(){const client=new pg.Client({connectionString:runtimeUrl});await client.connect();sessions.push(client);return client;}
const read=name=>fs.readFile(new URL(name,sourceDir),'utf8');

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  databaseName='robot_botp_test_'+suffix;roleName='robot_botp_role_'+suffix.slice(0,16);
  await admin.query('CREATE DATABASE '+databaseName);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  connectionString=urlOf(databaseName);runtimeUrl=urlOf(databaseName,roleName);
  db=new PostgresDatabase({connectionString,max:6});await db.migrate();
  await db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+roleName+"'"));
  // LABELLED FIXTURES: T1 and T2 and S are top-level users, B1 is a bot of T1 (slot 2).
  for(const id of ['T1','T2','S'])await db.query("INSERT INTO public.users(id,email,password_hash,created_at) VALUES($1,$1||'@example.test','unused-fixture-hash',1)",[id]);
  await db.query("INSERT INTO public.users(id,email,password_hash,created_at,parent_user_id,bot_slot_index) VALUES('B1','B1@example.test','NO_LOGIN',1,'T1',2)");
});
after(async()=>{
  for(const client of sessions)await client.end().catch(()=>{});
  await db?.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  if(admin){await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS '+roleName);await admin.close();}
});

const INSERT='INSERT INTO public.users(id,email,password_hash,created_at,parent_user_id,bot_slot_index) VALUES(\'n1\',\'n1@example.test\',\'NO_LOGIN\',1,';
const CASES={
  insertTopLevel:INSERT+'NULL,1)',
  insertBotOfTop:INSERT+"'T1',3)",
  insertBotOfTopSlotFive:INSERT+"'T1',5)",
  insertBotOfTopSlotOne:INSERT+"'T1',1)",
  insertBotOfBot:INSERT+"'B1',2)",
  insertBotOfMissingParent:INSERT+"'ghost',2)",
  reparentToTop:"UPDATE public.users SET parent_user_id='T2',bot_slot_index=2 WHERE id='S'",
  reparentToBot:"UPDATE public.users SET parent_user_id='B1',bot_slot_index=3 WHERE id='S'",
  reparentTopUnderBot:"UPDATE public.users SET parent_user_id='B1',bot_slot_index=2 WHERE id='T1'",
  slotToOne:"UPDATE public.users SET bot_slot_index=1 WHERE id='B1'",
  slotToThree:"UPDATE public.users SET bot_slot_index=3 WHERE id='B1'",
  sameParent:"UPDATE public.users SET parent_user_id=parent_user_id WHERE id='B1'",
  clearParent:"UPDATE public.users SET parent_user_id=NULL WHERE id='B1'",
  labelOnly:"UPDATE public.users SET label='renamed' WHERE id='B1'"};
// Documented behavior: a bot needs a top-level owner and a slot above 1; only the guarded columns fire the trigger.
const EXPECTED={insertTopLevel:'ok',insertBotOfTop:'ok',insertBotOfTopSlotFive:'ok',insertBotOfTopSlotOne:REFUSED,insertBotOfBot:REFUSED,insertBotOfMissingParent:REFUSED,
  reparentToTop:'ok',reparentToBot:REFUSED,reparentTopUnderBot:REFUSED,slotToOne:REFUSED,slotToThree:'ok',sameParent:'ok',clearParent:'ok',labelOnly:'ok'};
// Shadows claim that every real user is top-level, which is what lets a bot of a bot pass the original guard.
const SHADOW_ROWS='INSERT INTO pg_temp.users SELECT id,NULL FROM public.users';
const SHADOWS={
  none:[],
  tempTable:['CREATE TEMP TABLE users(id TEXT,parent_user_id TEXT)',SHADOW_ROWS],
  tempTablePathFirst:['CREATE TEMP TABLE users(id TEXT,parent_user_id TEXT)',SHADOW_ROWS,'SET LOCAL search_path = pg_temp, public'],
  tempView:["CREATE TEMP VIEW users AS SELECT id,NULL::text parent_user_id FROM public.users"],
  pathFirstOnly:['SET LOCAL search_path = pg_temp, public']};

async function attempt(client,shadow,sql){
  await client.query('BEGIN');
  try{for(const statement of shadow)await client.query(statement);await client.query(sql);return 'ok';}
  catch(error){return error.code+':'+error.message;}
  finally{await client.query('ROLLBACK');}
}
async function matrix(shadowName){
  const client=await session(),out={};
  for(const [name,sql] of Object.entries(CASES))out[name]=await attempt(client,SHADOWS[shadowName],sql);
  return out;
}
const bypassed=(shadowed,plain)=>Object.keys(plain).filter(key=>plain[key]!=='ok'&&shadowed[key]==='ok');

const fnRow=async()=>(await db.query(`SELECT p.oid::text oid,p.prosrc,p.proconfig,p.prosecdef,pg_get_functiondef(p.oid) def,pg_get_userbyid(p.proowner) owner,p.proacl::text acl
  FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.check_bot_parent()')`)).rows[0];
const triggerRow=async()=>(await db.query("SELECT tgrelid::regclass::text relation,tgfoid::text fn,tgtype,tgenabled,tgattr::text columns FROM pg_catalog.pg_trigger WHERE tgname='bot_parent_guard'")).rows[0];
const othersDigest=async()=>(await db.query(`SELECT md5(string_agg(proname||pg_get_functiondef(oid),'|' ORDER BY proname)) d FROM pg_catalog.pg_proc
  WHERE pronamespace='public'::regnamespace AND proname<>$1 AND prokind='f'`,[BOT_PARENT_FUNCTION])).rows[0].d;
const rowDigest=async()=>(await db.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(u) ORDER BY id),'[]')::text) d FROM public.users u")).rows[0].d;

let original,hardened,baseline,controls={},othersBefore,digestBefore;

test('setup: runtime role is a non-owner with TEMP privilege and the original check_bot_parent() is installed',async()=>{
  const role=(await db.query("SELECT rolsuper,rolbypassrls,has_database_privilege(rolname,current_database(),'TEMP') temp FROM pg_roles WHERE rolname=$1",[roleName])).rows[0];
  assert.deepEqual([role.rolsuper,role.rolbypassrls,role.temp],[false,false,true]);
  original=await fnRow();
  assert.equal(original.prosecdef,false);assert.equal(original.proconfig,null);assert.notEqual(original.owner,roleName);
  assert.equal(original.prosrc,(await botParentBodies()).original,'stored text equals the schema.sql text exactly');
  const report=await inspectBotParentHardening(db);
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.facts.state,'ORIGINAL');
  assert.deepEqual(await triggerRow(),{relation:'users',fn:original.oid,tgtype:23,tgenabled:'O',columns:(await triggerRow()).columns});
  assert.notEqual((await triggerRow()).columns,'','UPDATE OF parent_user_id, bot_slot_index');
  othersBefore=await othersDigest();digestBefore=await rowDigest();
});

test('baseline: the original guard matches the documented rules',async()=>{
  baseline=await matrix('none');
  assert.deepEqual(baseline,EXPECTED);
});

test('control: before hardening, a TEMP users shadow lets a bot of a bot and a reparent under a bot pass',async()=>{
  for(const name of ['tempTable','tempTablePathFirst','tempView'])controls[name]=await matrix(name);
  for(const name of Object.keys(controls)){
    const flipped=bypassed(controls[name],baseline);
    assert.deepEqual(flipped.sort(),['insertBotOfBot','reparentToBot','reparentTopUnderBot'].sort(),name);
  }
  // Slot 1 and the missing-parent rules do not depend on the relation read through the shadow.
  assert.equal(controls.tempTable.insertBotOfTopSlotOne,REFUSED);assert.equal(controls.tempTable.insertBotOfMissingParent,REFUSED);
  assert.equal(await rowDigest(),digestBefore,'every probe ran inside a rolled-back transaction');
});

test('the hardening migration is offline only: maintenance lock, own transaction',async()=>{
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateBotParentHardening(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackBotParentHardening(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateBotParentHardening(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackBotParentHardening(db)),/own transaction/);
  assert.deepEqual(await fnRow(),original,'refused attempts changed nothing');
  // A database without schema 14 is refused by verifySchema.
  const bare='robot_botp_bare_'+randomUUID().replaceAll('-','');databases.push(bare);
  await admin.query('CREATE DATABASE '+bare);
  const bareDb=new PostgresDatabase({connectionString:urlOf(bare)});
  try{await assert.rejects(migrateBotParentHardening(bareDb),/Initialize\/import schema 14/);await assert.rejects(rollbackBotParentHardening(bareDb),/Initialize\/import schema 14/);}
  finally{await bareDb.close();}
});

test('install: only the one function changes; OID, owner, grants, trigger and rows are untouched',async()=>{
  const triggerBefore=await triggerRow();
  const report=await migrateBotParentHardening(db);
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.facts.state,'HARDENED');assert.equal(report.previous_state,'ORIGINAL');
  hardened=await fnRow();
  assert.equal(hardened.oid,original.oid);assert.equal(hardened.owner,original.owner);assert.equal(hardened.acl,original.acl);
  assert.equal(hardened.prosecdef,false);assert.deepEqual(hardened.proconfig,[PINNED_SEARCH_PATH]);
  assert.match(hardened.def,/SET search_path TO 'pg_catalog', 'pg_temp'/);assert.doesNotMatch(hardened.def,/SECURITY DEFINER/);
  assert.match(hardened.def,/FROM public\.users/);assert.notEqual(hardened.prosrc,original.prosrc);
  assert.deepEqual(await triggerRow(),triggerBefore);
  assert.equal(await othersDigest(),othersBefore,'no other function changed');assert.equal(await rowDigest(),digestBefore,'no row changed');
});

test('invariant: the hardened body with public. removed equals the original body; the rollback body equals the original text',async()=>{
  const bodies=await botParentBodies(),norm=value=>value.replaceAll('\r\n','\n').trim();
  assert.equal(bodies.original.includes('public.'),false);
  assert.equal(norm(bodies.hardened.replaceAll('public.','')),norm(bodies.original));
  assert.equal((bodies.hardened.match(/public\./g)||[]).length,1,'exactly the one users qualifier');
  const restore=/CREATE OR REPLACE FUNCTION public\.check_bot_parent\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/.exec(await read('bot-parent-hardening-rollback.sql'))[1];
  assert.equal(norm(restore),norm(bodies.original));
  assert.match(bodies.hardened,/RAISE EXCEPTION 'Invalid bot owner or slot'/);
});

test('after hardening every TEMP shadow is refused and every outcome equals the baseline',async()=>{
  assert.deepEqual(await matrix('none'),baseline,'normal behavior is identical before and after hardening');
  for(const name of ['tempTable','tempTablePathFirst','tempView','pathFirstOnly']){
    const shadowed=await matrix(name);
    assert.deepEqual(shadowed,baseline,name);assert.deepEqual(bypassed(shadowed,baseline),[],name);
  }
  assert.notDeepEqual(controls.tempTable,baseline,'the control outcome differed');
  assert.equal(await rowDigest(),digestBefore);
});

test('re-applying is a no-op',async()=>{
  const again=await migrateBotParentHardening(db);
  assert.equal(again.ok,true);assert.equal(again.facts.state,'HARDENED');assert.equal(again.previous_state,'HARDENED');
  assert.deepEqual(await fnRow(),hardened);assert.equal(await rowDigest(),digestBefore);
});

test('install and rollback classify first: a tampered, over-configured or missing definition is refused and left unchanged',async()=>{
  const rollbackSql=await read('bot-parent-hardening-rollback.sql'),hardeningSql=await read('bot-parent-hardening.sql');
  const fn='public.check_bot_parent()';
  const tampers=[
    ['changed slot rule (no settings)',rollbackSql.replace('bot_slot_index=1','bot_slot_index=2')],
    ['changed slot rule (hardened header)',hardeningSql.replace('bot_slot_index=1','bot_slot_index=2')],
    ['unqualified users with the pin',rollbackSql+'ALTER FUNCTION '+fn+' SET search_path = pg_catalog, pg_temp'],
    ['extra setting on the hardened body','ALTER FUNCTION '+fn+" SET work_mem = '1MB'"],
    ['different search_path on the hardened body','ALTER FUNCTION '+fn+' SET search_path = public, pg_temp'],
    ['SECURITY DEFINER on the hardened body','ALTER FUNCTION '+fn+' SECURITY DEFINER'],
    ['trigger disabled','ALTER TABLE public.users DISABLE TRIGGER bot_parent_guard']];
  for(const [label,statement] of tampers){
    await db.query(hardeningSql);await db.query(statement);
    const changed=await fnRow(),trigger=await triggerRow();
    assert.equal((await inspectBotParentHardening(db)).ok,false,label);
    await assert.rejects(migrateBotParentHardening(db),/install refused; unexpected state/,label);
    await assert.rejects(rollbackBotParentHardening(db),/rollback refused; unexpected state/,label);
    assert.deepEqual(await fnRow(),changed,label+': definition untouched');assert.deepEqual(await triggerRow(),trigger,label+': trigger untouched');
    assert.equal(await rowDigest(),digestBefore,label+': rows untouched');
    await db.query('ALTER TABLE public.users ENABLE TRIGGER bot_parent_guard');
    await db.query(rollbackSql);
    assert.deepEqual(await fnRow(),original,label+': trusted restore');
  }
  // Pins on the original start are refused too.
  for(const statement of ['ALTER FUNCTION '+fn+' SET search_path = pg_catalog, pg_temp','ALTER FUNCTION '+fn+' SECURITY DEFINER']){
    await db.query(statement);
    await assert.rejects(migrateBotParentHardening(db),/refused/);await assert.rejects(rollbackBotParentHardening(db),/refused/);
    await db.query(rollbackSql);assert.deepEqual(await fnRow(),original);
  }
  // A missing function is refused and not recreated.
  await db.query('DROP FUNCTION public.check_bot_parent() CASCADE');
  assert.equal((await inspectBotParentHardening(db)).facts.state,'MISSING');
  await assert.rejects(migrateBotParentHardening(db),/install refused; unexpected state MISSING/);
  await assert.rejects(rollbackBotParentHardening(db),/rollback refused; unexpected state MISSING/);
  assert.equal((await db.query('SELECT count(*)::int n FROM pg_proc WHERE proname=$1',[BOT_PARENT_FUNCTION])).rows[0].n,0);
  await db.query(rollbackSql);
  await db.query('CREATE TRIGGER bot_parent_guard BEFORE INSERT OR UPDATE OF parent_user_id,bot_slot_index ON public.users FOR EACH ROW EXECUTE FUNCTION public.check_bot_parent()');
  original=await fnRow();
  assert.equal(original.prosrc,(await botParentBodies()).original);
  assert.equal((await inspectBotParentHardening(db)).facts.state,'ORIGINAL');
  assert.deepEqual(await matrix('none'),baseline,'behavior restored');assert.equal(await rowDigest(),digestBefore);
});

test('rollback restores the exact original, is idempotent, reopens the control bypass, and re-install reproduces the hardened text',async()=>{
  await migrateBotParentHardening(db);hardened=await fnRow();
  assert.deepEqual(await rollbackBotParentHardening(db),{rolled_back:true,previous_state:'HARDENED'});
  const restored=await fnRow();
  assert.equal(restored.def,original.def,'pg_get_functiondef equals the pre-hardening text');
  assert.equal(restored.prosrc,(await botParentBodies()).original,'stored text equals the schema.sql text exactly');
  assert.equal(restored.proconfig,null);assert.equal(restored.oid,hardened.oid);assert.equal(restored.owner,hardened.owner);assert.equal(restored.acl,hardened.acl);
  assert.deepEqual(await rollbackBotParentHardening(db),{rolled_back:true,previous_state:'ORIGINAL'});assert.deepEqual(await fnRow(),restored);
  assert.deepEqual(bypassed(await matrix('tempTable'),baseline).sort(),['insertBotOfBot','reparentToBot','reparentTopUnderBot'].sort(),'the bypass works again after rollback');
  assert.deepEqual(await matrix('none'),baseline);
  await migrateBotParentHardening(db);
  assert.deepEqual(await fnRow(),hardened,'re-install reproduces the first install byte for byte');
  assert.deepEqual(await matrix('tempTable'),baseline);
  assert.equal(await othersDigest(),othersBefore);assert.equal(await rowDigest(),digestBefore);
  await rollbackBotParentHardening(db);
});

test('the CLI installs, converges, rolls back and refuses bad arguments on the throwaway database',async()=>{
  const script='scripts/migrate-bot-parent-hardening.mjs',env={...process.env,DATABASE_URL:connectionString};
  const cli=async(...args)=>(await run(process.execPath,[script,...args],{cwd:repoRoot,env})).stdout;
  assert.match(await cli(),/state=HARDENED; previous state=ORIGINAL/);
  assert.match(await cli(),/state=HARDENED; previous state=HARDENED/);
  assert.equal((await fnRow()).proconfig[0],PINNED_SEARCH_PATH);
  assert.match(await cli('--rollback'),/original function definition restored; previous state=HARDENED/);
  assert.match(await cli('--rollback'),/previous state=ORIGINAL/);
  assert.equal((await fnRow()).proconfig,null);
  await assert.rejects(run(process.execPath,[script,'--other'],{cwd:repoRoot,env}),/Usage/);
});

// ---- existing PostgreSQL suites that create bots, unchanged, against a hardened check_bot_parent() ---------------------------------------
// A preload patches PostgresDatabase.query so that, right after schema.sql creates check_bot_parent(), the hardening file runs in the same
// transaction. No suite file is edited.
const hardenedRun=async file=>{
  const preload=`import fs from 'node:fs';
import {PostgresDatabase} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../src/postgres/db.js',import.meta.url))).href)};
const hardening=fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('bot-parent-hardening.sql',sourceDir)))},'utf8');
let applied=0;const original=PostgresDatabase.prototype.query;
PostgresDatabase.prototype.query=async function(sql,params){
  const result=await original.call(this,sql,params);
  if(typeof sql==='string'&&sql.includes('CREATE FUNCTION check_bot_parent()')){await original.call(this,hardening);applied++;}
  return result;
};
process.on('exit',()=>process.stderr.write('GH2_HARDENING_APPLIED='+applied+'\\n'));`;
  let result;
  try{
    result=await run(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'--test','--test-isolation=none','--test-reporter=spec',file],
      {cwd:repoRoot,env:childEnv(),maxBuffer:64*1024*1024});
  }catch(error){result={stdout:error.stdout||'',stderr:error.stderr||'',failed:true};}
  const text=result.stdout+result.stderr,count=name=>Number((new RegExp('ℹ '+name+' (\\d+)').exec(text)||[])[1]);
  return {failed:!!result.failed,pass:count('pass'),fail:count('fail'),skipped:count('skipped'),applied:Number((/GH2_HARDENING_APPLIED=(\d+)/.exec(text)||[])[1]),text};
};
for(const file of ['test/postgres/phase2.test.mjs','test/postgres/risk-readiness.test.mjs','test/postgres/pine-bridge-deployments.test.mjs'])
  test('existing suite against a hardened check_bot_parent(): '+file,{timeout:900000},async()=>{
    const outcome=await hardenedRun(file);
    assert.ok(outcome.applied>=1,'the hardening was applied in the suite process ('+outcome.applied+')');
    assert.equal(outcome.fail,0,outcome.text.slice(-3000));assert.equal(outcome.failed,false);assert.ok(outcome.pass>0);
    process.stderr.write('hardened '+file+': pass='+outcome.pass+' fail='+outcome.fail+' skipped='+outcome.skipped+' hardeningApplied='+outcome.applied+'\n');
  });
