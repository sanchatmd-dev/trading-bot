import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';

// FZ2: the four guard migration CLIs run `--inspect`: one READ ONLY transaction, no maintenance lock, no write, the JSON report on
// stdout, exit 0 only for a known state (ORIGINAL or HARDENED; ABSENT or FROZEN for the freeze) and nonzero otherwise.
// Runs against throwaway databases only. A catalog digest that includes every row version (xmin) proves nothing was written.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const SCRIPTS={
  bot:'scripts/migrate-bot-parent-hardening.mjs',
  research:'scripts/migrate-quant-research-guard-hardening.mjs',
  io:'scripts/migrate-quant-io-release-guard-hardening.mjs',
  freeze:'scripts/migrate-quant-research-freeze.mjs'};
let admin,db,databaseName,roleName,connectionString;
const databases=[];
const urlOf=name=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;return url.toString();};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  databaseName='robot_inspcli_test_'+suffix;roleName='robot_inspcli_role_'+suffix.slice(0,16);
  await admin.query('CREATE DATABASE '+databaseName);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  connectionString=urlOf(databaseName);
  db=new PostgresDatabase({connectionString,max:6});await db.migrate();
  for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await db.query(await fs.readFile(new URL(name,sourceDir),'utf8'));
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  await db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',roleName));
});
after(async()=>{
  await db?.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  if(admin){await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS '+roleName);await admin.close();}
});

/** Runs one CLI; never throws on a nonzero exit. */
async function cli(script,args=[],url=connectionString){
  try{
    const {stdout,stderr}=await run(process.execPath,[script,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}});
    return {code:0,stdout,stderr};
  }catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}
/** Runs `--inspect` for one CLI and parses the report. */
async function inspect(name,extra=[],url=connectionString){
  const result=await cli(SCRIPTS[name],['--inspect',...extra],url);
  let report=null;
  try{report=JSON.parse(result.stdout);}catch{/* a usage error prints no report */}
  return {...result,report};
}
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,'')) x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal) s`)).rows[0];
/** Inspects with every CLI against the database and proves the catalog did not change. */
async function inspectAll(expected,note,url=connectionString,target=db){
  const before=await catalogDigest(target);
  for(const [name,[code,state]] of Object.entries(expected)){
    const result=await inspect(name,[],url);
    assert.equal(result.code,code,note+' '+name+' exit code; '+(result.stderr||'')+(result.report?.failures||[]).join());
    assert.equal(result.report?.facts?.state,state,note+' '+name+' state');
  }
  assert.deepEqual(await catalogDigest(target),before,note+': --inspect wrote nothing');
}
const FN={bot:'public.check_bot_parent()',research:'public.quant_research_mode_guard()',io:'public.quant_io_foundation_release_guard()',freeze:'public.quant_research_freeze_job_update()'};

test('the scripts open the inspection with BEGIN READ ONLY and never call the maintenance lock themselves',async()=>{
  for(const script of Object.values(SCRIPTS)){
    const text=await fs.readFile(new URL('../../'+script,import.meta.url),'utf8');
    assert.match(text,/BEGIN READ ONLY/,script);assert.doesNotMatch(text,/maintenanceLock|verifySchema/,script);
  }
});

test('--inspect on the original database: ORIGINAL and ABSENT are known states (exit 0), JSON on stdout, nothing written',async()=>{
  await inspectAll({bot:[0,'ORIGINAL'],research:[0,'ORIGINAL'],io:[0,'ORIGINAL'],freeze:[0,'ABSENT']},'original');
  const bot=await inspect('bot');
  assert.equal(bot.report.ok,true);assert.deepEqual(bot.report.failures,[]);
  assert.equal(bot.report.facts.function.name,'check_bot_parent');
  assert.equal(bot.stderr,'');
});

test('--inspect takes no maintenance lock: it works while another session holds it, where the install refuses',async()=>{
  const holder=await db.pool.connect();
  try{
    assert.equal((await holder.query("SELECT pg_try_advisory_lock(hashtextextended('robot:maintenance',0)) ok")).rows[0].ok,true);
    await inspectAll({bot:[0,'ORIGINAL'],research:[0,'ORIGINAL'],io:[0,'ORIGINAL'],freeze:[0,'ABSENT']},'maintenance lock held');
    for(const name of Object.keys(SCRIPTS)){
      const result=await cli(SCRIPTS[name]);
      assert.notEqual(result.code,0,name);assert.match(result.stderr,/Stop every PostgreSQL API and worker/,name);
    }
  }finally{await holder.query("SELECT pg_advisory_unlock(hashtextextended('robot:maintenance',0))");holder.release();}
});

test('--inspect after the installs: HARDENED and FROZEN are known states; the freeze also checks a runtime role read-only',async()=>{
  for(const name of ['bot','research','io','freeze']){
    const result=await cli(SCRIPTS[name]);
    assert.equal(result.code,0,name+': '+result.stderr);
  }
  await inspectAll({bot:[0,'HARDENED'],research:[0,'HARDENED'],io:[0,'HARDENED'],freeze:[0,'FROZEN']},'installed');
  const withRole=await inspect('freeze',['--runtime-role='+roleName]);
  assert.equal(withRole.code,0,withRole.stderr+(withRole.report?.failures||[]).join());
  assert.equal(withRole.report.facts.runtime_role.superuser,false);
  // The current user of the throwaway database is not a valid runtime role (superuser or owner), so the role check fails the inspection.
  const current=(await db.query('SELECT current_user u')).rows[0].u;
  if(/^[a-z_][a-z0-9_]{0,62}$/.test(current)){
    const bad=await inspect('freeze',['--runtime-role='+current]);
    assert.notEqual(bad.code,0);assert.equal(bad.report.ok,false);
    assert.ok(bad.report.failures.some(item=>item.startsWith('RUNTIME_ROLE_')),bad.report.failures.join());
  }
  // The install CLIs report the previous state and no-op on a second run.
  assert.match((await cli(SCRIPTS.freeze)).stdout,/state=FROZEN; previous state=FROZEN/);
  assert.match((await cli(SCRIPTS.bot)).stdout,/state=HARDENED; previous state=HARDENED/);
});

test('--inspect on an unknown state exits nonzero and still prints the report and writes nothing',async()=>{
  // One function per guard module is changed outside the accepted text; the extra function setting makes each definition unknown.
  const tampers={
    bot:['ALTER FUNCTION '+FN.bot+" SET work_mem = '64MB'",'ALTER FUNCTION '+FN.bot+' RESET work_mem'],
    research:['ALTER FUNCTION '+FN.research+" SET work_mem = '64MB'",'ALTER FUNCTION '+FN.research+' RESET work_mem'],
    io:['ALTER FUNCTION '+FN.io+" SET work_mem = '64MB'",'ALTER FUNCTION '+FN.io+' RESET work_mem'],
    freeze:['ALTER FUNCTION '+FN.freeze+' SECURITY DEFINER','ALTER FUNCTION '+FN.freeze+' SECURITY INVOKER']};
  for(const [name,[tamper,repair]] of Object.entries(tampers)){
    await db.query(tamper);
    try{
      const before=await catalogDigest(db);
      const result=await inspect(name);
      assert.equal(result.code,1,name);assert.equal(result.report.ok,false,name);assert.equal(result.report.facts.state,'OTHER',name);
      assert.ok(result.report.failures.length>0,name);
      assert.deepEqual(await catalogDigest(db),before,name+': --inspect wrote nothing');
      // The install refuses the same state without a write.
      const refused=await cli(SCRIPTS[name]);
      assert.notEqual(refused.code,0,name);assert.match(refused.stderr,/refused; unexpected state OTHER \(no change made\)/,name);
      assert.deepEqual(await catalogDigest(db),before,name+': the refused install wrote nothing');
    }finally{await db.query(repair);}
  }
  await inspectAll({bot:[0,'HARDENED'],research:[0,'HARDENED'],io:[0,'HARDENED'],freeze:[0,'FROZEN']},'repaired');
});

test('--inspect after the rollbacks: ORIGINAL and ABSENT again (exit 0); a trigger that is not enabled is not a known state',async()=>{
  for(const name of ['freeze','io','research','bot']){
    const result=await cli(SCRIPTS[name],['--rollback']);
    assert.equal(result.code,0,name+': '+result.stderr);
  }
  await inspectAll({bot:[0,'ORIGINAL'],research:[0,'ORIGINAL'],io:[0,'ORIGINAL'],freeze:[0,'ABSENT']},'rolled back');
  // Function ORIGINAL but its trigger is disabled: ok=false, so exit 1 although the state label is ORIGINAL.
  await db.query('ALTER TABLE public.users DISABLE TRIGGER bot_parent_guard');
  try{
    const result=await inspect('bot');
    assert.equal(result.code,1);assert.equal(result.report.facts.state,'ORIGINAL');assert.ok(result.report.failures.includes('TRIGGER_DISABLED:bot_parent_guard'));
  }finally{await db.query('ALTER TABLE public.users ENABLE TRIGGER bot_parent_guard');}
  assert.equal((await inspect('bot')).code,0);
});

test('--inspect on a database without the extensions: bot-parent and the freeze are known, the I/O and research guards are not',async()=>{
  const name='robot_inspcli_bare_'+randomUUID().replaceAll('-','');databases.push(name);
  await admin.query('CREATE DATABASE '+name);
  const bare=new PostgresDatabase({connectionString:urlOf(name)});
  try{
    await bare.migrate();
    const before=await catalogDigest(bare);
    for(const [script,[code,state]] of Object.entries({bot:[0,'ORIGINAL'],research:[1,'MISSING'],io:[1,'MISSING'],freeze:[0,'ABSENT']})){
      const result=await inspect(script,[],urlOf(name));
      assert.equal(result.code,code,script+': '+result.stderr);assert.equal(result.report.facts.state,state,script);
    }
    assert.deepEqual(await catalogDigest(bare),before);
  }finally{await bare.close();}
});

test('usage: --inspect is exclusive with --rollback and with unknown arguments; the existing flags keep working',async()=>{
  for(const name of Object.keys(SCRIPTS)){
    for(const args of [['--inspect','--rollback'],['--rollback','--inspect'],['--inspect','--other'],['--other']]){
      const result=await cli(SCRIPTS[name],args);
      assert.notEqual(result.code,0,name+' '+args.join(' '));assert.match(result.stderr,/Usage/,name+' '+args.join(' '));
    }
  }
  // The freeze keeps its --runtime-role form and refuses the role with --rollback.
  assert.match((await cli(SCRIPTS.freeze,['--runtime-role=Bad Name'])).stderr,/Usage/);
  assert.match((await cli(SCRIPTS.freeze,['--rollback','--runtime-role='+roleName])).stderr,/Usage/);
  assert.match((await cli(SCRIPTS.bot,['--inspect','--runtime-role='+roleName])).stderr,/Usage/);
  const freeze=await cli(SCRIPTS.freeze,['--runtime-role='+roleName]);
  assert.equal(freeze.code,0,freeze.stderr);assert.match(freeze.stdout,/Quant research freeze ready: quant-research-freeze-v1; state=FROZEN; previous state=ABSENT; guards=6; runtime role checked/);
  const removed=await cli(SCRIPTS.freeze,['--rollback']);
  assert.equal(removed.code,0,removed.stderr);assert.match(removed.stdout,/Quant research freeze removed; previous state=FROZEN; no data changed/);
});
