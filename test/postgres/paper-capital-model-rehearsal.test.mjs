import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {INSERT_ONLY_SQLSTATE,SERIALIZABLE_SQLSTATE,INSERT_GUARD_SQLSTATE,classifyPaperCapitalModel,migratePaperCapitalModel} from '../../src/postgres/paper-capital-model-migration.js';

// QR-2 S4-3 local restore rehearsal of the paper capital model extension (design 4.3, steps 1 to 8), on a throwaway PostgreSQL cluster.
// Every restore here goes into a fresh database in the same cluster (not a fresh cluster); step 4b adds the --no-acl variant.
// Every row is a LABELLED FIXTURE (synthetic owners and Bots). No route writes a declaration yet, so the fixtures are direct guarded SERIALIZABLE
// inserts by a real non-owner LOGIN role with the repo grants. The tests run in order and share one rehearsal state: step N needs steps before it.
// Backups and export files go to a private OS temp directory, never into a tracked path; the digest and counts are the only recorded evidence.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const CLI='scripts/migrate-paper-capital-model.mjs';
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE;
const DAY=86400000;
const TABLE='public.paper_capital_models';
const PG_BIN=process.env.FREEZE_TEST_PG_BIN||(process.env.FREEZE_TEST_PG_CTL?path.dirname(process.env.FREEZE_TEST_PG_CTL):'');
const tool=name=>PG_BIN?path.join(PG_BIN,name):name;
const serializable={isolation:'SERIALIZABLE'};
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const grantScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const sha256Of=bytes=>createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA=sha256Of(Buffer.alloc(0));
const insertSql=`INSERT INTO ${TABLE}(owner_id,currency,version,capital_model,bot_set,effective_from,declared_at,declared_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`;
const valuesOf=value=>[value.owner_id,value.currency,value.version,value.capital_model,JSON.stringify(value.bot_set),value.effective_from,value.declared_at,value.declared_by];
// Midnight-safe fixture date: the database clock decides (the stamp trigger uses it); wait past a UTC midnight that is less than 30 s away.
let clockOffset=0;
const databaseNow=()=>Date.now()+clockOffset;
const nextMidnight=()=>{
  let now=databaseNow();
  if(DAY-now%DAY<30000){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,DAY-now%DAY+1000);now=databaseNow();}
  return (Math.floor(now/DAY)+1)*DAY;
};
const declaration=(owner,botSet,over={})=>({owner_id:owner,currency:'USDT',version:1,capital_model:'INDEPENDENT_ACCOUNTS',bot_set:botSet,effective_from:nextMidnight(),declared_at:1,declared_by:owner,...over});

let admin,roleName,templateName,sourceName,dir,sourcePool,runtimePool;
const databases=[],pools=[];
const track=pool=>{pools.push(pool);return pool;};
const rehearsal={};
async function cli(args,url){
  try{
    const {stdout,stderr}=await run(process.execPath,[CLI,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}});
    return {code:0,stdout,stderr};
  }catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
}
/** pg_restore into an existing database. stderr is captured for assertions and never printed. */
function restore(file,databaseName,extra=[]){
  return new Promise((resolve,reject)=>{
    const child=spawn(tool('pg_restore'),['--exit-on-error','--no-owner',...extra,'--dbname',databaseName,file],{env:postgresToolEnvironment(urlOf(databaseName)),stdio:['ignore','ignore','pipe'],windowsHide:true});
    let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',()=>reject(new Error('pg_restore could not start; set FREEZE_TEST_PG_BIN to a PostgreSQL bin directory')));
    child.on('exit',status=>resolve({status,stderr}));
  });
}
async function freshDatabase(label,template){
  const name='robot_pcmr_'+label+'_'+randomUUID().replaceAll('-','').slice(0,16);databases.push(name);
  await admin.query('CREATE DATABASE '+name+(template?' TEMPLATE '+template:''));
  return name;
}
const poolOf=(name,user)=>track(new PostgresDatabase({connectionString:urlOf(name,user),max:3}));
const declaredAt=async target=>(await target.query(`SELECT owner_id,currency,version::text v,declared_at::text d FROM ${TABLE} ORDER BY owner_id COLLATE "C",currency COLLATE "C",version`)).rows;
const guardRows=async target=>(await target.query(`SELECT t.tgname,t.tgenabled FROM pg_trigger t WHERE t.tgrelid IN ('public.paper_capital_models'::regclass,'public.paper_capital_model_schema'::regclass) AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
const extensionObjects=async target=>(await target.query(`SELECT
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'paper\\_capital\\_model%') relations,
  (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'paper\\_capital\\_model%') functions,
  (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'paper\\_capital\\_model%') triggers`)).rows[0];
const NONE={relations:0,functions:0,triggers:0};
const inspect=async(url,extra=[])=>{const result=await cli(['--inspect',...extra],url);let report=null;try{report=JSON.parse(result.stdout);}catch{/* usage or connection error */}return {...result,report};};
const guardRefused=(promise,name,pattern)=>assert.rejects(promise,error=>{
  assert.equal(error.code,QR004,'SQLSTATE: '+error.message);assert.equal(error.constraint,name,'rule family: '+error.message);
  if(pattern)assert.match(error.message,pattern);
  return true;});
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||md5(p.prosrc||COALESCE(p.proconfig::text,'')) x FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text FROM pg_trigger t WHERE NOT t.tgisinternal
  UNION ALL SELECT 'c:'||c.oid||':'||c.xmin::text||':'||c.relname||':'||COALESCE(c.relacl::text,'') FROM pg_class c WHERE c.relnamespace='public'::regnamespace) s`)).rows[0];

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  clockOffset=Number((await admin.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS ms')).rows[0].ms)-Date.now();
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_pcmr_tpl_'+suffix.slice(0,20);databases.push(templateName);
  roleName='robot_pcmr_rt_'+suffix.slice(0,14);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{await builder.migrate();}finally{await builder.close();}
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-pcm-rehearsal-'));
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of databases)await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
    await admin.close();
  }
  if(dir)await fs.rm(dir,{recursive:true,force:true});
});

/* ---- step 1: base schema 14, fixture owners and Bots, protected backup B0 ---- */

test('step 1: base schema 14 with fixture owners and Bots; protected backup B0 (exclusive create, custom archive, bytes and sha256 recorded)',async()=>{
  sourceName=await freshDatabase('src',templateName);
  sourcePool=poolOf(sourceName);
  const store=new Store(sourcePool);
  const bot=async(owner,slot)=>{
    const id=randomUUID();
    await sourcePool.query(`INSERT INTO users(id,email,password_hash,role,status,created_at,parent_user_id,bot_slot_index,label) VALUES($1,$2,'NO_LOGIN','BOT','ACTIVE',$3,$4,$5,'Fixture Bot')`,
      [id,id+'@bot.invalid',Date.now(),owner,slot]);
    return id;
  };
  const ownerA=(await store.createUser({email:'rehearsal-a-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'})).id;
  const ownerB=(await store.createUser({email:'rehearsal-b-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'})).id;
  const botsA=[await bot(ownerA,2),await bot(ownerA,3)],botsB=[await bot(ownerB,2)];
  rehearsal.ownerA=ownerA;rehearsal.ownerB=ownerB;
  rehearsal.setA=[ownerA,...botsA].sort();rehearsal.setB=[ownerB,...botsB].sort();
  rehearsal.usersBefore=(await sourcePool.query('SELECT count(*)::int n FROM users')).rows[0].n;
  assert.equal(rehearsal.usersBefore,5);
  assert.equal((await classifyPaperCapitalModel(sourcePool)).state,'ABSENT');
  const b0=await backupPostgres(path.join(dir,'b0.dump'),{connectionString:urlOf(sourceName),executable:tool('pg_dump')});
  assert.equal(b0.format,'PostgreSQL custom archive');assert.ok(b0.bytes>0);assert.match(b0.sha256,/^[0-9a-f]{64}$/);
  assert.equal(sha256Of(await fs.readFile(b0.path)),b0.sha256,'the recorded digest is the digest of the file');
  assert.equal((await fs.readFile(b0.path)).subarray(0,5).toString('latin1'),'PGDMP','a PostgreSQL custom archive');
  if(process.platform!=='win32')assert.equal((await fs.stat(b0.path)).mode&0o777,0o600);
  // the backup path is created exclusively: a second backup to the same path is refused and leaves the first untouched
  await assert.rejects(backupPostgres(b0.path,{connectionString:urlOf(sourceName),executable:tool('pg_dump')}),{code:'EEXIST'});
  assert.equal(sha256Of(await fs.readFile(b0.path)),b0.sha256);
  rehearsal.b0=b0;
});

/* ---- step 2: install, grants, inspect with the runtime role ---- */

test('step 2: install, reapply the grant script for the runtime role, --inspect --runtime-role exits 0',async()=>{
  const sourceUrl=urlOf(sourceName);
  const installed=await cli([],sourceUrl);
  assert.equal(installed.code,0,installed.stderr);assert.match(installed.stdout,/state=INSTALLED; previous state=ABSENT; guards=7/);
  await sourcePool.query(await grantScript(roleName));
  const report=await inspect(sourceUrl,['--runtime-role='+roleName]);
  assert.equal(report.code,0,report.stderr+(report.report?.failures||[]).join());
  assert.equal(report.report.ok,true);assert.equal(report.report.facts.state,'INSTALLED');
  assert.ok((await guardRows(sourcePool)).every(item=>item.tgenabled==='A'));
});

/* ---- step 3: fixture declarations through the guard, export (D1), protected backup B1 ---- */

test('step 3: fixture declarations by direct guarded SERIALIZABLE inserts; the O12 export records rows and digest D1; protected backup B1',async()=>{
  runtimePool=poolOf(sourceName,roleName);
  const put=value=>runtimePool.transaction(()=>runtimePool.query(insertSql,valuesOf(value)),serializable);
  const {ownerA,ownerB,setA,setB}=rehearsal;
  await put(declaration(ownerA,setA));
  await put(declaration(ownerA,setA,{version:2,capital_model:'SHARED_HYPOTHETICAL'}));
  await put(declaration(ownerA,setA,{currency:'THB'}));
  await put(declaration(ownerB,setB));
  const exportFile=path.join(dir,'d1.jsonl');
  const exported=await cli(['--export='+exportFile],urlOf(sourceName));
  assert.equal(exported.code,0,exported.stderr);
  const match=/^rows=(\d+) sha256=([0-9a-f]{64})\n$/.exec(exported.stdout);
  assert.ok(match,'only rows=<n> sha256=<h> is printed: '+exported.stdout);
  rehearsal.d1={rows:Number(match[1]),sha256:match[2]};
  assert.equal(rehearsal.d1.rows,4);
  assert.equal(sha256Of(await fs.readFile(exportFile)),rehearsal.d1.sha256,'D1 is the digest of the export file');
  rehearsal.exportBytes=await fs.readFile(exportFile);
  rehearsal.declaredAt=await declaredAt(sourcePool);
  assert.equal(rehearsal.declaredAt.length,4);
  assert.ok(rehearsal.declaredAt.every(item=>Number(item.d)>1000000000000),'declared_at is the database clock, not the client value 1');
  const b1=await backupPostgres(path.join(dir,'b1.dump'),{connectionString:urlOf(sourceName),executable:tool('pg_dump')});
  assert.ok(b1.bytes>rehearsal.b0.bytes,'B1 holds the extension and the rows');assert.notEqual(b1.sha256,rehearsal.b0.sha256);
  rehearsal.b1=b1;
});

/* ---- step 4: full restore of B1 keeps the rows, the digest and declared_at ---- */
// Steps 4 to 7 restore into a fresh DATABASE IN THE SAME CLUSTER: roles and ACL targets carry over. A fresh cluster (missing runtime role) is covered
// by step 4b only as far as --no-acl plus the grant script goes; a real fresh-cluster staging rehearsal stays a separate runbook step.

test('step 4: full pg_restore of B1 into a fresh database (same cluster): INSTALLED, rows, digest D1 and declared_at unchanged, guards still fire',async()=>{
  rehearsal.restoredName=await freshDatabase('b1',null);
  const outcome=await restore(rehearsal.b1.path,rehearsal.restoredName);
  assert.equal(outcome.status,0,outcome.stderr);
  const restoredUrl=urlOf(rehearsal.restoredName);
  const restored=poolOf(rehearsal.restoredName);
  assert.equal((await classifyPaperCapitalModel(restored)).state,'INSTALLED');
  const report=await inspect(restoredUrl,['--runtime-role='+roleName]);
  assert.equal(report.code,0,(report.report?.failures||[]).join()+report.stderr);assert.equal(report.report.facts.state,'INSTALLED');
  assert.deepEqual(await guardRows(restored),await guardRows(sourcePool));assert.ok((await guardRows(restored)).every(item=>item.tgenabled==='A'));
  // rows, digest and declared_at: the stamp trigger did not fire on restore
  assert.deepEqual(await declaredAt(restored),rehearsal.declaredAt,'declared_at came back unchanged');
  const restoredExport=path.join(dir,'d1-restored.jsonl');
  const again=await cli(['--export='+restoredExport],restoredUrl);
  assert.equal(again.code,0,again.stderr);
  assert.equal(again.stdout,'rows='+rehearsal.d1.rows+' sha256='+rehearsal.d1.sha256+'\n','the restored rows give the same count and digest');
  assert.ok((await fs.readFile(restoredExport)).equals(rehearsal.exportBytes),'the export bytes are identical');
  // the restored guards still fire: UPDATE (QR002, even for the owner) and a READ COMMITTED INSERT (QR003)
  await assert.rejects(restored.query(`UPDATE ${TABLE} SET version=version`),{code:QR002});
  await assert.rejects(restored.query(`DELETE FROM ${TABLE}`),{code:QR002});
  const restoredRuntime=poolOf(rehearsal.restoredName,roleName);
  await assert.rejects(restoredRuntime.transaction(()=>restoredRuntime.query(insertSql,valuesOf(declaration(rehearsal.ownerB,rehearsal.setB,{version:2})))),{code:QR003});
  // the insert guard of the restored table still refuses (a version gap), and nothing changed
  await guardRefused(restoredRuntime.transaction(()=>restoredRuntime.query(insertSql,valuesOf(declaration(rehearsal.ownerB,rehearsal.setB,{version:5}))),serializable),'paper_capital_models_version');
  assert.deepEqual(await declaredAt(restored),rehearsal.declaredAt);
});

test('step 4b: restore of B1 with --no-acl into a fresh database (the cross-cluster path without the runtime role): INSTALLED, no grants, then the grant script and --inspect --runtime-role exit 0',async()=>{
  const name=await freshDatabase('b1noacl',null);
  const outcome=await restore(rehearsal.b1.path,name,['--no-acl']);
  assert.equal(outcome.status,0,outcome.stderr);
  const url=urlOf(name),restored=poolOf(name);
  assert.equal((await classifyPaperCapitalModel(restored)).state,'INSTALLED');
  assert.deepEqual(await declaredAt(restored),rehearsal.declaredAt,'declared_at came back unchanged');
  // --no-acl drops the grants of B1: the runtime role holds no privilege on the declaration table until the grant script runs
  assert.equal((await restored.query(`SELECT has_table_privilege($1,'${TABLE}','INSERT') p`,[roleName])).rows[0].p,false,'no INSERT grant after --no-acl');
  const bare=await inspect(url);
  assert.equal(bare.code,0,(bare.report?.failures||[]).join()+bare.stderr);assert.equal(bare.report.facts.state,'INSTALLED');
  await restored.query(await grantScript(roleName));
  const granted=await inspect(url,['--runtime-role='+roleName]);
  assert.equal(granted.code,0,(granted.report?.failures||[]).join()+granted.stderr);assert.equal(granted.report.ok,true);assert.equal(granted.report.facts.state,'INSTALLED');
  const again=await cli(['--export='+path.join(dir,'d1-noacl.jsonl')],url);
  assert.equal(again.stdout,'rows='+rehearsal.d1.rows+' sha256='+rehearsal.d1.sha256+'\n','the --no-acl copy gives the D1 count and digest');
});

/* ---- step 5: data-only restore without disabled triggers fails (documented unsupported) ---- */

test('step 5: a data-only restore of B1 into an installed empty table without --disable-triggers fails (QR003) and loads nothing',async()=>{
  const name=await freshDatabase('dataonly',templateName),target=poolOf(name);
  await migratePaperCapitalModel(target);
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
  const outcome=await restore(rehearsal.b1.path,name,['--data-only','--table=paper_capital_models']);
  assert.notEqual(outcome.status,0,'a data-only restore replays the triggers and is refused');
  assert.match(outcome.stderr,/Paper capital model writes require a SERIALIZABLE transaction/,'the QR003 guard refused the COPY at READ COMMITTED');
  assert.equal((await target.query(`SELECT count(*)::int n FROM ${TABLE}`)).rows[0].n,0,'no row was loaded');
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
  rehearsal.dataOnlyName=name;
});


test('step 5b: the one data-only path, a superuser with --disable-triggers, loads the rows but leaves the guards origin-only, so the classifier says OTHER (unsupported); ENABLE ALWAYS repairs it',async()=>{
  const name=rehearsal.dataOnlyName,target=poolOf(name);
  const outcome=await restore(rehearsal.b1.path,name,['--data-only','--disable-triggers','--table=paper_capital_models']);
  assert.equal(outcome.status,0,outcome.stderr);
  assert.deepEqual(await declaredAt(target),rehearsal.declaredAt,'the rows and declared_at came back (no trigger ran)');
  // pg_restore re-enables the triggers with ENABLE TRIGGER ALL, which turns ENABLE ALWAYS into the origin-only setting
  const classification=await classifyPaperCapitalModel(target);
  assert.equal(classification.state,'OTHER');
  assert.ok(classification.problems.some(item=>item.startsWith('TRIGGER_NOT_ALWAYS:')),classification.problems.join());
  assert.ok((await guardRows(target)).some(item=>item.tgenabled==='O'));
  // the export refuses an OTHER install until an operator restores ENABLE ALWAYS on every guard
  const refused=await cli(['--export='+path.join(dir,'other.jsonl')],urlOf(name));
  assert.notEqual(refused.code,0);assert.match(refused.stderr,/export refused; state OTHER/);
  for(const row of await guardRows(target)){
    const table=row.tgname.startsWith('paper_capital_model_schema')?'paper_capital_model_schema':'paper_capital_models';
    await target.query('ALTER TABLE public.'+table+' ENABLE ALWAYS TRIGGER '+row.tgname);
  }
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
  const repaired=await cli(['--export='+path.join(dir,'repaired.jsonl')],urlOf(name));
  assert.equal(repaired.stdout,'rows='+rehearsal.d1.rows+' sha256='+rehearsal.d1.sha256+'\n','the repaired copy has the D1 rows and digest');
});

/* ---- step 6: restore B0 classifies ABSENT (the restore-to-before path) ---- */

test('step 6: full pg_restore of B0 into a fresh database classifies ABSENT, holds the pre-install users, and the install works forward again',async()=>{
  const name=await freshDatabase('b0',null);
  const outcome=await restore(rehearsal.b0.path,name);
  assert.equal(outcome.status,0,outcome.stderr);
  const restored=poolOf(name);
  assert.equal((await classifyPaperCapitalModel(restored)).state,'ABSENT');
  assert.deepEqual(await extensionObjects(restored),NONE);
  assert.equal((await restored.query('SELECT count(*)::int n FROM users')).rows[0].n,rehearsal.usersBefore);
  const report=await inspect(urlOf(name));
  assert.equal(report.code,0,report.stderr);assert.equal(report.report.facts.state,'ABSENT');
  const refused=await cli(['--export='+path.join(dir,'b0-export.jsonl')],urlOf(name));
  assert.notEqual(refused.code,0);assert.match(refused.stderr,/export refused; state ABSENT/);
  assert.equal((await migratePaperCapitalModel(restored)).previous_state,'ABSENT');
  assert.equal((await classifyPaperCapitalModel(restored)).state,'INSTALLED');
});

/* ---- step 7: rollback rehearsal on the restored B1 copy ---- */

test('step 7: on the restored B1 copy the plain rollback is refused, a wrong count or digest is refused, the count and digest D1 are accepted, ABSENT follows and the grants are reapplied',async()=>{
  const name=rehearsal.restoredName,url=urlOf(name),target=poolOf(name);
  const {d1}=rehearsal;
  const snapshot=async()=>({rows:await declaredAt(target),catalog:await catalogDigest(target)});
  const held=await snapshot();
  const plain=await cli(['--rollback'],url);
  assert.notEqual(plain.code,0);assert.match(plain.stderr,/rollback refused; 4 declaration row\(s\) exist \(no change made\)/);
  const wrongCount=await cli(['--rollback','--confirm-rows=3','--confirm-export-sha256='+d1.sha256],url);
  assert.notEqual(wrongCount.code,0);assert.match(wrongCount.stderr,/live declaration rows: row count \(no change made\)/);
  const wrongDigest=await cli(['--rollback','--confirm-rows=4','--confirm-export-sha256='+EMPTY_SHA],url);
  assert.notEqual(wrongDigest.code,0);assert.match(wrongDigest.stderr,/live declaration rows: digest \(no change made\)/);
  assert.deepEqual(await snapshot(),held,'every refusal changed nothing');
  assert.equal((await classifyPaperCapitalModel(target)).state,'INSTALLED');
  // the count and digest D1 were taken on the SOURCE database before the backup; the restored copy accepts them
  const accepted=await cli(['--rollback','--confirm-rows='+d1.rows,'--confirm-export-sha256='+d1.sha256],url);
  assert.equal(accepted.code,0,accepted.stderr);assert.match(accepted.stdout,/previous state=INSTALLED; confirmed rows=4/);
  assert.equal((await classifyPaperCapitalModel(target)).state,'ABSENT');
  assert.deepEqual(await extensionObjects(target),NONE);
  assert.equal((await target.query('SELECT count(*)::int n FROM users')).rows[0].n,rehearsal.usersBefore,'the base data is untouched');
  // the grant script is reapplied after the rollback and runs without the extension tables
  await target.query(await grantScript(roleName));
  const after=await inspect(url,['--runtime-role='+roleName]);
  assert.equal(after.code,0,(after.report?.failures||[]).join()+after.stderr);assert.equal(after.report.facts.state,'ABSENT');
  // the source database is a separate database: still installed with every row
  assert.equal((await classifyPaperCapitalModel(sourcePool)).state,'INSTALLED');
  assert.deepEqual(await declaredAt(sourcePool),rehearsal.declaredAt);
});

/* ---- step 8: TEMP-table shadows in a runtime session ---- */

test('step 8: TEMP tables named users and paper_capital_models in a runtime session change no guard result and no stored row',async()=>{
  const store=new Store(sourcePool);
  const owner=(await store.createUser({email:'rehearsal-c-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'})).id;
  const botId=randomUUID();
  await sourcePool.query(`INSERT INTO users(id,email,password_hash,role,status,created_at,parent_user_id,bot_slot_index,label) VALUES($1,$2,'NO_LOGIN','BOT','ACTIVE',$3,$4,2,'Fixture Bot')`,[botId,botId+'@bot.invalid',Date.now(),owner]);
  const set=[owner,botId].sort();
  const shadow=async()=>{
    await runtimePool.query('CREATE TEMP TABLE users(id text,parent_user_id text) ON COMMIT DROP');
    await runtimePool.query(`INSERT INTO pg_temp.users VALUES('${botId}',NULL),('${owner}',NULL)`);
    await runtimePool.query('CREATE TEMP TABLE paper_capital_models(LIKE public.paper_capital_models INCLUDING DEFAULTS) ON COMMIT DROP');
    await runtimePool.query(`INSERT INTO pg_temp.paper_capital_models VALUES('${owner}','USDT',1,'INDEPENDENT_ACCOUNTS','["${owner}"]',${nextMidnight()},1,'${owner}')`);
    await runtimePool.query('SET LOCAL search_path = pg_temp, public');
  };
  const outcomeOf=async(shadowed,value)=>{
    const error=await runtimePool.transaction(async()=>{if(shadowed)await shadow();await runtimePool.query(insertSql,valuesOf(value));},serializable).then(()=>null,failure=>failure);
    return error?{code:error.code,constraint:error.constraint||null,message:error.message}:null;
  };
  const cases=[
    ['a child Bot cannot own a declaration',declaration(botId,[botId]),'paper_capital_models_owner'],
    ['a set that hides the owner Bot is not the full owner set',declaration(owner,[owner]),'paper_capital_models_bot_set'],
    ['version 2 without a version 1',declaration(owner,set,{version:2}),'paper_capital_models_version']];
  const before=await declaredAt(sourcePool);
  for(const [label,value,constraint] of cases){
    const plain=await outcomeOf(false,value),shadowed=await outcomeOf(true,value);
    assert.equal(plain?.code,QR004,label+': '+plain?.message);assert.equal(plain.constraint,constraint,label);
    assert.deepEqual(shadowed,plain,label+': the same refusal with TEMP shadows');
  }
  assert.deepEqual(await declaredAt(sourcePool),before,'the refusals stored nothing');
  // the accepted write: version 1 with the full set lands in public.paper_capital_models only
  await runtimePool.transaction(async()=>{
    await shadow();
    await runtimePool.query(insertSql,valuesOf(declaration(owner,set)));
    assert.equal((await runtimePool.query('SELECT count(*)::int n FROM pg_temp.paper_capital_models')).rows[0].n,1,'the TEMP table kept only its own row');
  },serializable);
  const after=await declaredAt(sourcePool);
  assert.equal(after.length,before.length+1);assert.equal(after.filter(item=>item.owner_id===owner).length,1);
  assert.deepEqual(after.filter(item=>item.owner_id!==owner),before,'every earlier row is unchanged');
  // the insert-only trigger still fires for the real table whatever search_path says
  await assert.rejects(sourcePool.transaction(async()=>{
    await sourcePool.query('CREATE TEMP TABLE paper_capital_models(x integer) ON COMMIT DROP');
    await sourcePool.query('SET LOCAL search_path = pg_temp, public');
    await sourcePool.query(`UPDATE ${TABLE} SET version=version WHERE owner_id=$1`,[owner]);
  },serializable),{code:QR002});
  assert.equal((await classifyPaperCapitalModel(sourcePool)).state,'INSTALLED');
});
