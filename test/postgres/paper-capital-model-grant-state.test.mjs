import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migratePaperCapitalModel} from '../../src/postgres/paper-capital-model-migration.js';
import {grantPaperCapitalModelRuntime as grant,revokePaperCapitalModelRuntime as revoke,PaperCapitalModelGrantRefusal} from '../../src/postgres/paper-capital-model-grants.js';
import {readPaperCapitalModelGrantState as readState,preM6AclDigest,READ_ONLY_STATEMENTS,GRANT_STATE_QUERIES,EXECUTE_ENTRY_REASON,
  OBJECTS_DIFFER_REASON} from '../../src/postgres/paper-capital-model-grant-state.js';

// Read-only capital-model grant-state read and pre-M6 ACL digest (set B), proven on a throwaway PostgreSQL cluster. Every database is its own clone of a
// migrated base schema 14. The runtime roles are NOLOGIN roles: the reader needs only their names. Nothing here is evidence; no real owner, Bot or credential appears.
//
// Cluster: with TEST_DATABASE_URL (the CI harness of the other PostgreSQL suites) the suite uses that cluster, exactly like test/postgres/paper-capital-model-grants.test.mjs.
// Without it, the suite starts its OWN throwaway cluster (scram-sha-256, a random password in an absolute pwfile inside its own temp directory, loopback only,
// a free port) from the PostgreSQL bin directory in PCMG_STATE_PG_BIN or FREEZE_TEST_PG_BIN, or the portable install under LOCALAPPDATA, and stops and removes it at the end.
const MARKER='paper_capital_model_schema',DECL='paper_capital_models',FN='public.paper_capital_model_now_ms()';
const M6=[MARKER,DECL];
let admin,ddl,templateName,suffix,baseUrl;
const roles={};
const databases=[],pools=[];
const own={dir:null,data:null,started:false};
const urlOf=name=>{const url=new URL(baseUrl);url.pathname='/'+name;return url.toString();};
const open=(name,max=2)=>{const pool=new PostgresDatabase({connectionString:urlOf(name),max});pools.push(pool);return pool;};
const quote=name=>'"'+name.replaceAll('"','""')+'"';

const defaultBin=()=>process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Programs','PostgreSQL','16.15','bin'):'';
const pgBin=()=>process.env.PCMG_STATE_PG_BIN||process.env.FREEZE_TEST_PG_BIN||(process.env.FREEZE_TEST_PG_CTL?path.dirname(process.env.FREEZE_TEST_PG_CTL):'')||defaultBin();
const pgTool=name=>path.join(pgBin(),name+(process.platform==='win32'?'.exe':''));
// Output is discarded: a postmaster that inherits a pipe would hang the caller.
const runTool=(name,args,timeout=240000)=>spawnSync(pgTool(name),args,{stdio:'ignore',windowsHide:true,timeout}).status;
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);
  server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
async function startOwnCluster(){
  assert.ok(existsSync(pgTool('initdb')),'TEST_DATABASE_URL is required, or a PostgreSQL bin directory in PCMG_STATE_PG_BIN; isolated PostgreSQL only');
  own.dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-pcmg-state-'));own.data=path.join(own.dir,'data');
  const password=randomUUID(),pwfile=path.resolve(own.dir,'superuser.pw');
  await fs.writeFile(pwfile,password+'\n',{mode:0o600});
  assert.equal(runTool('initdb',['-D',own.data,'-U','robot_test','-A','scram-sha-256','--pwfile='+pwfile,'-E','UTF8','--locale=C']),0,'initdb');
  const port=await freePort();
  await fs.appendFile(path.join(own.data,'postgresql.conf'),`\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\nmax_connections = 40\nshared_buffers = 16MB\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`);
  assert.equal(runTool('pg_ctl',['-D',own.data,'-l',path.join(own.dir,'postgres.log'),'-w','-t','120','start']),0,'cluster started');own.started=true;
  return `postgres://robot_test:${password}@127.0.0.1:${port}/postgres`;
}

before(async()=>{
  baseUrl=process.env.TEST_DATABASE_URL||await startOwnCluster();
  admin=new PostgresDatabase({connectionString:baseUrl});
  // CREATE and DROP DATABASE wait for a checkpoint, which can pass the 15 s statement timeout of the shared pool: they run on a session without that timeout.
  ddl=new pg.Client({connectionString:baseUrl,statement_timeout:0});await ddl.connect();
  suffix=randomUUID().replaceAll('-','').slice(0,12);
  Object.assign(roles,{runtime:'robot_pcmg_st_rt_'+suffix,other:'robot_pcmg_st_ot_'+suffix,quoted:'robot_pcmg_st "q" '+suffix,missing:'robot_pcmg_st_missing_'+suffix});
  for(const name of [roles.runtime,roles.other,roles.quoted])await admin.query('CREATE ROLE '+quote(name)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  templateName='robot_pcmg_st_tpl_'+suffix;
  await ddl.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{await builder.migrate();}finally{await builder.close();}
});
after(async()=>{
  // Close every pool first, then drop; collect every error and fail the run if any occurred or anything is left behind.
  const errors=[];
  const attempt=async(label,action)=>{try{await action();}catch(error){errors.push(label+': '+(error&&error.message));}};
  for(const pool of pools)await attempt('pool close',async()=>{try{await pool.close();}catch(error){if(!/more than once/.test(error&&error.message))throw error;}});
  if(admin&&ddl){
    for(const name of [...databases,templateName].filter(Boolean))await attempt('drop database',()=>ddl.query('DROP DATABASE IF EXISTS '+quote(name)+' WITH (FORCE)'));
    for(const name of Object.values(roles))await attempt('drop role',()=>admin.query('DROP ROLE IF EXISTS '+quote(name)));
    await attempt('leftovers',async()=>{
      const left=(await admin.query(`SELECT (SELECT count(*)::int FROM pg_database WHERE datname ILIKE 'robot\\_pcmg\\_st%') AS dbs,
        (SELECT count(*)::int FROM pg_roles WHERE rolname ILIKE 'robot\\_pcmg\\_st%' OR ($1::text<>'' AND rolname LIKE '%'||$1::text)) AS roles`,[suffix||''])).rows[0];
      assert.deepEqual([left.dbs,left.roles],[0,0],'no robot_pcmg_st database or role remains');
    });
  }
  if(ddl)await attempt('ddl close',()=>ddl.end());
  if(admin)await attempt('admin close',()=>admin.close());
  if(own.started&&runTool('pg_ctl',['-D',own.data,'stop','-m','fast','-w','-t','60'])!==0&&runTool('pg_ctl',['-D',own.data,'stop','-m','immediate','-w','-t','60'])!==0)errors.push('own cluster did not stop');
  if(own.dir)await attempt('own directory',()=>fs.rm(own.dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}));
  assert.deepEqual(errors,[],'teardown errors');
});

/** A database from the template; optionally the PUBLIC EXECUTE default is removed first (the EXECUTE branch) and M6 is installed. */
async function clone(label,{install=true,noPublicExecute=false}={}){
  const name='robot_pcmg_st_'+label+'_'+randomUUID().replaceAll('-','').slice(0,16);databases.push(name);
  await ddl.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  const db=open(name);
  if(noPublicExecute)await db.query('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  if(install)await migratePaperCapitalModel(db);
  return {name,db};
}
/** Every ACL fact of the database, M6 objects included, normalized so a NULL ACL and its explicit default compare equal. xmin shows that nothing was rewritten. */
const snapshot=async db=>(await db.query(`SELECT x FROM (
  SELECT 'r:'||c.relname||':'||COALESCE((SELECT string_agg(e.grantor||'>'||e.grantee||':'||e.privilege_type||':'||e.is_grantable::text,',' ORDER BY e.grantee,e.privilege_type,e.grantor)
    FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) e),'')||':'||c.xmin::text AS x
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')
  UNION ALL SELECT 'a:'||a.attrelid::regclass::text||':'||a.attnum||':'||a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL
  UNION ALL SELECT 'f:'||p.oid||':'||COALESCE(p.proacl::text,'')||':'||p.xmin::text FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 'n:'||COALESCE(nspacl::text,'') FROM pg_namespace WHERE nspname='public'
  UNION ALL SELECT 'd:'||COALESCE(datacl::text,'') FROM pg_database WHERE datname=current_database()
  UNION ALL SELECT 'x:'||oid||':'||COALESCE(defaclacl::text,'') FROM pg_default_acl) s ORDER BY x`)).rows.map(row=>row.x);
const lockFree=target=>target.transaction(async()=>(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0)) ok")).rows[0].ok);
const everyName=()=>Object.values(roles);
const noRoleName=value=>{const text=JSON.stringify(value);for(const name of everyName())assert.equal(text.includes(name),false,'the role name is in no output');};
/** Reads the state and checks the generic output facts; the fixed shape, no role name. */
async function state(db,options={}){
  const result=await readState(db,{runtimeRole:roles.runtime,...options});
  assert.deepEqual(Object.keys(result),['state','objects','reasons','executeInScope']);
  assert.deepEqual(Object.keys(result.objects),['marker','declarations','function']);
  assert.equal(result.executeInScope,options.includeExecute===true);
  noRoleName(result);
  return result;
}
const refused=async(promise,code)=>{
  const error=await promise.then(()=>null,reason=>reason);
  assert.ok(error instanceof PaperCapitalModelGrantRefusal,'refusal expected, got '+(error&&error.stack));
  assert.equal(error.code,code,error.message);
  for(const name of everyName())assert.equal(JSON.stringify([error.message,error.details]).includes(name),false,'the refusal names no role');
  return error;
};
const grantFails=async(db,code,options={})=>refused(grant(db,{runtimeRole:roles.runtime,...options}),code);
const shape=result=>[result.state,result.objects.marker,result.objects.declarations,result.objects.function];

test('ABSENT before the M6 install (no throw), for both includeExecute choices; a partial M6 is ABSENT too and keeps what exists',async()=>{
  const {db}=await clone('absent',{install:false});
  for(const includeExecute of [false,true]){
    const result=await state(db,{includeExecute});
    assert.deepEqual(result,{state:'ABSENT',objects:{marker:'ABSENT',declarations:'ABSENT',function:'ABSENT'},reasons:['M6_ABSENT'],executeInScope:includeExecute});
  }
  const partial=await clone('partial');
  await partial.db.query('DROP TABLE public.'+DECL);
  const noTable=await state(partial.db);
  assert.deepEqual(noTable,{state:'ABSENT',objects:{marker:'NONE',declarations:'ABSENT',function:'NOT_IN_SCOPE'},reasons:['M6_PARTIAL'],executeInScope:false});
  const noTables=await clone('notables');
  await noTables.db.query('DROP TABLE public.'+DECL+'; DROP TABLE public.'+MARKER);
  const bare=await state(noTables.db);
  assert.deepEqual([bare.state,bare.objects.function,bare.reasons],['ABSENT','NOT_IN_SCOPE',['M6_PARTIAL']]);
  await refused(readState(db,{runtimeRole:roles.missing}),'RUNTIME_ROLE_MISSING');
});

test('lifecycle: NONE after the install, EXACT after the grant, NONE after the revoke; the grant module agrees with every state',async()=>{
  const {db}=await clone('life');
  assert.deepEqual(shape(await state(db)),['NONE','NONE','NONE','NOT_IN_SCOPE']);
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,true);
  assert.deepEqual(await state(db),{state:'EXACT',objects:{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'},reasons:[],executeInScope:false});
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,false,'the grant module sees EXACT as a no-op');
  assert.equal((await revoke(db,{runtimeRole:roles.runtime})).changed,true);
  assert.deepEqual(shape(await state(db)),['NONE','NONE','NONE','NOT_IN_SCOPE']);
  // Another role's grant is not this role's state.
  await db.query(`GRANT SELECT ON public.${MARKER} TO ${quote(roles.other)}`);
  assert.equal((await state(db)).state,'OTHER');
});

test('a mixed-case role name with quotes is read exactly, as a bound value',async()=>{
  const {db}=await clone('quote');
  const read=()=>readState(db,{runtimeRole:roles.quoted});
  assert.equal((await read()).state,'NONE');
  assert.equal((await grant(db,{runtimeRole:roles.quoted})).changed,true);
  const exact=await read();assert.equal(exact.state,'EXACT');noRoleName(exact);
  assert.equal((await state(db)).state,'OTHER','the unrelated runtime role sees the first role grant as a foreign grantee');
  assert.equal((await revoke(db,{runtimeRole:roles.quoted})).changed,true);
  assert.equal((await read()).state,'NONE');
  await refused(readState(db,{runtimeRole:roles.quoted.toUpperCase()}),'RUNTIME_ROLE_MISSING');
});

test('OTHER: an extra privilege, a column grant, a grant option, a PUBLIC entry or another grantee; the grant module refuses the same states',async()=>{
  const rt=quote(roles.runtime),other=quote(roles.other);
  const cases=[
    ['extra privilege',`GRANT SELECT, INSERT, UPDATE ON public.${DECL} TO ${rt}; GRANT SELECT ON public.${MARKER} TO ${rt}`,DECL+':PRIVILEGE_SET'],
    ['extra privilege on the marker',`GRANT SELECT, INSERT ON public.${MARKER} TO ${rt}`,MARKER+':PRIVILEGE_SET'],
    ['PUBLIC entry',`GRANT SELECT ON public.${DECL} TO PUBLIC`,DECL+':PUBLIC_ENTRY'],
    ['grant option',`GRANT SELECT ON public.${MARKER} TO ${rt} WITH GRANT OPTION`,MARKER+':GRANT_OPTION'],
    ['column grant',`GRANT SELECT (owner_id) ON public.${DECL} TO ${rt}`,DECL+':COLUMN_ACL'],
    ['another grantee',`GRANT SELECT ON public.${DECL} TO ${other}`,DECL+':FOREIGN_GRANTEE']];
  for(const [label,statement,reason] of cases){
    const {db}=await clone('other');
    await db.query(statement);
    const before=await snapshot(db);
    const result=await state(db);
    assert.equal(result.state,'OTHER',label);assert.deepEqual(result.reasons,[reason],label);
    await grantFails(db,'ACL_STATE_OTHER');
    assert.deepEqual(await snapshot(db),before,label+': neither the reader nor the refused grant changed an ACL');
  }
});

test('MIXED by objects: one table EXACT and the other NONE; the grant module refuses it as mixed',async()=>{
  const {db}=await clone('mixed');
  await db.query(`GRANT SELECT ON public.${MARKER} TO ${quote(roles.runtime)}`);
  const result=await state(db);
  assert.deepEqual(result,{state:'MIXED',objects:{marker:'EXACT',declarations:'NONE',function:'NOT_IN_SCOPE'},reasons:[OBJECTS_DIFFER_REASON],executeInScope:false});
  await grantFails(db,'ACL_STATE_MIXED');
});

test('MIXED by the EXECUTE rule: a manual runtime EXECUTE entry without includeExecute is MIXED, never NONE; with includeExecute it is judged',async()=>{
  // Default privileges: PUBLIC keeps EXECUTE on the new function.
  const open1=await clone('exec_open');
  await open1.db.query(`GRANT EXECUTE ON FUNCTION ${FN} TO ${quote(roles.runtime)}`);
  const mixed=await state(open1.db);
  assert.deepEqual(mixed,{state:'MIXED',objects:{marker:'NONE',declarations:'NONE',function:'NOT_IN_SCOPE'},reasons:[EXECUTE_ENTRY_REASON],executeInScope:false});
  await grantFails(open1.db,'ACL_STATE_MIXED');
  const judged=await state(open1.db,{includeExecute:true});
  assert.equal(judged.state,'OTHER');assert.deepEqual(judged.reasons,['paper_capital_model_now_ms:PUBLIC_ENTRY']);
  // PUBLIC EXECUTE removed by default privileges: the whole branch.
  const {db}=await clone('exec_closed',{noPublicExecute:true});
  assert.deepEqual(shape(await state(db,{includeExecute:true})),['NONE','NONE','NONE','NONE']);
  assert.equal((await grant(db,{runtimeRole:roles.runtime,includeExecute:true})).changed,true);
  assert.deepEqual(await state(db,{includeExecute:true}),{state:'EXACT',objects:{marker:'EXACT',declarations:'EXACT',function:'EXACT'},reasons:[],executeInScope:true});
  const withoutOption=await state(db);
  assert.deepEqual(shape(withoutOption),['MIXED','EXACT','EXACT','NOT_IN_SCOPE']);assert.deepEqual(withoutOption.reasons,[EXECUTE_ENTRY_REASON]);
  await grantFails(db,'ACL_STATE_MIXED');
  assert.equal((await revoke(db,{runtimeRole:roles.runtime,includeExecute:true})).changed,true);
  assert.deepEqual(shape(await state(db,{includeExecute:true})),['NONE','NONE','NONE','NONE']);
  // The entry alone, with the tables NONE, is MIXED without the option and the function differs from the tables with it.
  await db.query(`GRANT EXECUTE ON FUNCTION ${FN} TO ${quote(roles.runtime)}`);
  assert.equal((await state(db)).state,'MIXED');
  const half=await state(db,{includeExecute:true});
  assert.deepEqual([...shape(half),half.reasons],['MIXED','NONE','NONE','EXACT',[OBJECTS_DIFFER_REASON]]);
});

test('the reader never changes an ACL, takes no lock and is not blocked by the maintenance lock or by ACCESS EXCLUSIVE table locks',async()=>{
  const {name,db}=await clone('readonly');
  await db.query(`GRANT SELECT ON public.${MARKER} TO ${quote(roles.runtime)}`);
  const start=await snapshot(db);
  // Every statement the reader issues, through a wrapper of the real driver.
  const issued=[];const original=db.query.bind(db);
  db.query=(sql,params)=>{issued.push(String(sql));return original(sql,params);};
  try{
    for(const includeExecute of [false,true])await state(db,{includeExecute});
    await preM6AclDigest(db);
    await refused(readState(db,{runtimeRole:roles.missing}),'RUNTIME_ROLE_MISSING');
    assert.equal(issued.filter(sql=>sql==='SET TRANSACTION READ ONLY').length,4,'read-only mode is set in each of the four transactions');
    const allowed=/^(?:\/\*[^*]*\*\/\s*)?(SELECT|WITH)\b|^SET TRANSACTION READ ONLY$/;
    for(const sql of issued)assert.match(sql,allowed,sql.slice(0,70));
    assert.equal(issued[0],READ_ONLY_STATEMENTS.SET_READ_ONLY);
    assert.equal(issued.includes(READ_ONLY_STATEMENTS.CHECK_READ_ONLY),true);
    assert.equal(issued.includes(GRANT_STATE_QUERIES.PRE_M6_DIGEST),true);
    // The read cannot run inside a caller transaction.
    await db.transaction(async()=>{await refused(readState(db,{runtimeRole:roles.runtime}),'NOT_OWN_TRANSACTION');await refused(preM6AclDigest(db),'NOT_OWN_TRANSACTION');});
  }finally{db.query=original;}
  assert.deepEqual(await snapshot(db),start,'the digest of all ACLs, xmin included, is as before the reads');
  // A holder keeps the maintenance lock and ACCESS EXCLUSIVE on both tables; the reader still answers.
  const holder=open(name,2);
  let release,locked;const hold=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{locked=resolve;});
  const held=holder.transaction(async()=>{
    await holder.maintenanceLock();
    await holder.query(`LOCK TABLE public.${MARKER}, public.${DECL} IN ACCESS EXCLUSIVE MODE`);
    locked();await hold;
  });
  try{
    await ready;
    assert.equal(await lockFree(db),false,'the maintenance lock is held');
    const timeout=delay(15000).then(()=>{throw new Error('the reader was blocked by a lock');});
    const result=await Promise.race([readState(db,{runtimeRole:roles.runtime}),timeout]);
    assert.equal(result.state,'MIXED');
    assert.equal((await Promise.race([preM6AclDigest(db),timeout])).digest.length,32);
  }finally{release();await held;}
  assert.deepEqual(await snapshot(db),start,'still nothing changed');
  assert.equal(await lockFree(db),true,'the reader left the maintenance lock free');
});

test('preM6AclDigest: unchanged by the M6 install and by the M6 grants, changed by an ACL change on any pre-existing object',async()=>{
  const {name,db}=await clone('digest',{install:false,noPublicExecute:true});
  const before=await preM6AclDigest(db);
  assert.match(before.digest,/^[0-9a-f]{32}$/);
  assert.deepEqual(await preM6AclDigest(db),before,'a repeated read is stable');
  await migratePaperCapitalModel(db);
  assert.deepEqual(await preM6AclDigest(db),before,'installing M6 does not change it');
  assert.equal((await grant(db,{runtimeRole:roles.runtime,includeExecute:true})).changed,true);
  assert.deepEqual(await preM6AclDigest(db),before,'the M6 table and function ACLs are excluded');
  assert.equal((await revoke(db,{runtimeRole:roles.runtime,includeExecute:true})).changed,true);
  assert.deepEqual(await preM6AclDigest(db),before);
  // The grant module digest does not exclude the five other M6 functions; this one does, and its function ACL is part of the read.
  await db.query(`GRANT EXECUTE ON FUNCTION public.paper_capital_model_stamp() TO ${quote(roles.runtime)}`);
  assert.deepEqual(await preM6AclDigest(db),before,'every M6 function is excluded');
  await db.query(`REVOKE EXECUTE ON FUNCTION public.paper_capital_model_stamp() FROM ${quote(roles.runtime)}`);
  const changes=[
    [`GRANT SELECT ON public.users TO ${quote(roles.runtime)}`,`REVOKE SELECT ON public.users FROM ${quote(roles.runtime)}`],
    [`GRANT SELECT (email) ON public.users TO ${quote(roles.runtime)}`,`REVOKE SELECT (email) ON public.users FROM ${quote(roles.runtime)}`],
    [`GRANT USAGE ON SCHEMA public TO ${quote(roles.other)}`,`REVOKE USAGE ON SCHEMA public FROM ${quote(roles.other)}`],
    [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(roles.other)}`,`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM ${quote(roles.other)}`]];
  // The ACL text can stay explicit after an undo (PostgreSQL keeps the materialized default), so each change is compared with the digest read just before it.
  for(const [change,undo] of changes){
    const base=(await preM6AclDigest(db)).digest;
    await db.query(change);
    assert.notEqual((await preM6AclDigest(db)).digest,base,change);
    await db.query(undo);
  }
  // The exclusion is by name AND signature: a same-name overload stays in the digest. Creating it changes the digest; so does an ACL change on it.
  await db.query("CREATE FUNCTION public.paper_capital_model_now_ms(integer) RETURNS integer LANGUAGE sql AS 'SELECT 1'");
  try{
    const overload=(await preM6AclDigest(db)).digest;
    assert.notEqual(overload,before.digest,'the overload is in the digest');
    await db.query(`GRANT EXECUTE ON FUNCTION public.paper_capital_model_now_ms(integer) TO ${quote(roles.other)}`);
    assert.notEqual((await preM6AclDigest(db)).digest,overload,'an ACL change on the overload changes the digest');
  }finally{await db.query('DROP FUNCTION IF EXISTS public.paper_capital_model_now_ms(integer)');}
  // An ACL change on a non-M6 public function changes the digest.
  await db.query("CREATE FUNCTION public.robot_pcmg_st_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
  try{
    const fnBase=(await preM6AclDigest(db)).digest;
    await db.query(`GRANT EXECUTE ON FUNCTION public.robot_pcmg_st_fn() TO ${quote(roles.other)}`);
    assert.notEqual((await preM6AclDigest(db)).digest,fnBase,'a non-M6 function ACL is part of the digest');
  }finally{await db.query('DROP FUNCTION IF EXISTS public.robot_pcmg_st_fn()');}
  // A database ACL change changes the digest.
  const dbBase=(await preM6AclDigest(db)).digest;
  await db.query(`GRANT CONNECT ON DATABASE ${quote(name)} TO ${quote(roles.other)}`);
  try{assert.notEqual((await preM6AclDigest(db)).digest,dbBase,'the database ACL is part of the digest');}
  finally{await db.query(`REVOKE CONNECT ON DATABASE ${quote(name)} FROM ${quote(roles.other)}`);}
  // A new relation is part of the digest.
  const last=(await preM6AclDigest(db)).digest;
  await db.query('CREATE TABLE public.robot_pcmg_st_extra(id int)');
  assert.notEqual((await preM6AclDigest(db)).digest,last);
  await db.query('DROP TABLE public.robot_pcmg_st_extra');
});
