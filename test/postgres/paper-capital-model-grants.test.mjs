import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {hashPassword} from '../../src/security.js';
import {httpClient} from '../helpers.mjs';
import {createBot} from '../helpers/qr2-reader-fixture.mjs';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migratePaperCapitalModel,inspectPaperCapitalModel,classifyPaperCapitalModel} from '../../src/postgres/paper-capital-model-migration.js';
import {grantPaperCapitalModelRuntime as grant,revokePaperCapitalModelRuntime as revoke,PaperCapitalModelGrantRefusal} from '../../src/postgres/paper-capital-model-grants.js';

// Targeted capital-model grant (set B), proven on a throwaway PostgreSQL cluster. Every database is its own clone of a migrated base schema 14.
// Roles are real LOGIN roles where a connection is needed. Nothing here is evidence; no real owner, Bot or credential appears.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const CLI='scripts/grant-paper-capital-model-runtime.mjs';
const MARKER='paper_capital_model_schema',DECL='paper_capital_models',FN='public.paper_capital_model_now_ms()';
const M6=[MARKER,DECL];
let admin,templateName,suffix;
const roles={};
const databases=[],pools=[],servers=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const track=pool=>{pools.push(pool);return pool;};
const open=(name,user,max=6)=>track(new PostgresDatabase({connectionString:urlOf(name,user),max}));
const quote=name=>'"'+name.replaceAll('"','""')+'"';

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  suffix=randomUUID().replaceAll('-','').slice(0,12);
  Object.assign(roles,{runtime:'robot_pcmg_rt_'+suffix,collector:'robot_pcmg_col_'+suffix,reader:'robot_pcmg_rd_'+suffix,nonowner:'robot_pcmg_no_'+suffix,
    mixed:'Robot_PCMG_Mixed_'+suffix,mixedTwin:'robot_pcmg_mixed_'+suffix,quoted:'robot pcmg "q" '+suffix,
    ownerRole:'robot_pcmg_own_'+suffix,inheritMember:'robot_pcmg_im_'+suffix,noInheritMember:'robot_pcmg_nm_'+suffix});
  for(const name of [roles.runtime,roles.nonowner])await admin.query('CREATE ROLE '+quote(name)+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  for(const name of [roles.collector,roles.reader,roles.mixed,roles.mixedTwin,roles.quoted])await admin.query('CREATE ROLE '+quote(name)+' NOLOGIN NOSUPERUSER');
  await admin.query('CREATE ROLE '+quote(roles.ownerRole)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  await admin.query('CREATE ROLE '+quote(roles.inheritMember)+' LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE ROLE '+quote(roles.noInheritMember)+' LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('GRANT '+quote(roles.ownerRole)+' TO '+quote(roles.inheritMember)+', '+quote(roles.noInheritMember));
  templateName='robot_pcmg_tpl_'+suffix;
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{await builder.migrate();}finally{await builder.close();}
});
after(async()=>{
  // Close every server, pool and client first, then drop; collect every error and fail the run if any occurred or anything is left behind.
  const errors=[];
  const attempt=async(label,action)=>{try{await action();}catch(error){errors.push(label+': '+(error&&error.message));}};
  for(const server of servers)await attempt('server stop',()=>server.stop());
  for(const pool of pools)await attempt('pool close',async()=>{try{await pool.close();}catch(error){if(!/more than once/.test(error&&error.message))throw error;}});
  if(admin){
    // DROP DATABASE waits for a checkpoint, which can pass the 15 s statement timeout of the shared pool: drop on a dedicated session without that timeout.
    const dropper=new pg.Client({connectionString:process.env.TEST_DATABASE_URL,statement_timeout:0});
    await attempt('drop session',()=>dropper.connect());
    for(const name of [...databases,templateName].filter(Boolean))await attempt('drop database',()=>dropper.query('DROP DATABASE IF EXISTS '+quote(name)+' WITH (FORCE)'));
    await attempt('drop session close',()=>dropper.end());
    for(const name of Object.values(roles))await attempt('drop role',()=>admin.query('DROP ROLE IF EXISTS '+quote(name)));
    await attempt('leftovers',async()=>{
      const left=(await admin.query(`SELECT (SELECT count(*)::int FROM pg_database WHERE datname ILIKE 'robot\\_pcmg\\_%') AS dbs,
        (SELECT count(*)::int FROM pg_roles WHERE rolname ILIKE 'robot\\_pcmg\\_%' OR ($1::text<>'' AND rolname LIKE '%'||$1::text)) AS roles`,[suffix||''])).rows[0];
      assert.deepEqual([left.dbs,left.roles],[0,0],'no robot_pcmg_ database or role remains');
    });
    await attempt('admin close',()=>admin.close());
  }
  assert.deepEqual(errors,[],'teardown errors');
});

/** A database from the template; optionally the PUBLIC EXECUTE default is removed first (the EXECUTE branch) and M6 is installed. */
async function clone(label,{install=true,noPublicExecute=false,before:prepare}={}){
  const name='robot_pcmg_'+label+'_'+randomUUID().replaceAll('-','').slice(0,16);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  const db=open(name);
  if(noPublicExecute)await db.query('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  if(prepare)await prepare(db);
  if(install)await migratePaperCapitalModel(db);
  return {name,db};
}
/** Every ACL fact outside the named objects, normalized so a NULL ACL and its explicit default compare equal. xmin shows that nothing was rewritten. */
const snapshot=async(db,{xmin=false,skipTables=[],skipFunctions=[]}={})=>(await db.query(`SELECT x FROM (
  SELECT 'r:'||c.relname||':'||COALESCE((SELECT string_agg(e.grantor||'>'||e.grantee||':'||e.privilege_type||':'||e.is_grantable::text,',' ORDER BY e.grantee,e.privilege_type,e.grantor)
    FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) e),'')||CASE WHEN $1::boolean THEN ':'||c.xmin::text ELSE '' END AS x
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>ALL($2::text[])
  UNION ALL SELECT 'a:'||a.attrelid::regclass::text||':'||a.attnum||':'||a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL AND c.relname<>ALL($2::text[])
  UNION ALL SELECT 'f:'||p.oid||':'||COALESCE(p.proacl::text,'') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname<>ALL($3::text[])
  UNION ALL SELECT 'n:'||COALESCE(nspacl::text,'') FROM pg_namespace WHERE nspname='public'
  UNION ALL SELECT 'd:'||COALESCE(datacl::text,'') FROM pg_database WHERE datname=current_database()
  UNION ALL SELECT 'x:'||oid||':'||COALESCE(defaclacl::text,'') FROM pg_default_acl) s ORDER BY x`,[xmin,skipTables,skipFunctions])).rows.map(row=>row.x);
const tableEntries=async(db,table)=>(await db.query(`SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,x.privilege_type AS privilege,x.is_grantable AS grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee
  WHERE c.oid=$1::regclass AND x.grantee<>c.relowner ORDER BY 1,2`,['public.'+table])).rows;
const functionEntries=async db=>(await db.query(`SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,x.privilege_type AS privilege,x.is_grantable AS grantable
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee
  WHERE p.oid=$1::regprocedure AND x.grantee<>p.proowner ORDER BY 1,2`,[FN])).rows;
const can=async(db,role,table,privilege)=>(await db.query('SELECT has_table_privilege($1::name,$2,$3) v',[role,'public.'+table,privilege])).rows[0].v;
const canExecute=async(db,role)=>(await db.query('SELECT has_function_privilege($1::name,$2,$3) v',[role,FN,'EXECUTE'])).rows[0].v;
/** True when the maintenance try-lock is free (a transaction-level lock, released at once). */
const lockFree=target=>target.transaction(async()=>(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0)) ok")).rows[0].ok);
const refused=async(promise,code,details)=>{
  const error=await promise.then(()=>null,reason=>reason);
  assert.ok(error instanceof PaperCapitalModelGrantRefusal,'refusal expected, got '+(error&&error.stack));
  assert.equal(error.code,code,error.message);
  if(details)assert.deepEqual(error.details,details);
  for(const name of Object.values(roles))assert.equal(error.message.includes(name),false,'the refusal names no role');
  return error;
};
const exactTargets=async(db,role)=>{
  assert.deepEqual(await tableEntries(db,MARKER),[{grantee:role,privilege:'SELECT',grantable:false}]);
  assert.deepEqual(await tableEntries(db,DECL),[{grantee:role,privilege:'INSERT',grantable:false},{grantee:role,privilege:'SELECT',grantable:false}]);
};
const noTargets=async db=>{assert.deepEqual(await tableEntries(db,MARKER),[]);assert.deepEqual(await tableEntries(db,DECL),[]);};

test('fresh install, then grant: ACL entries are EXACT, the inspection is ok with grants required; the second run is a no-op that rewrites nothing',async()=>{
  const {db}=await clone('exact');
  await noTargets(db);
  const start=await snapshot(db,{skipTables:M6});
  const result=await grant(db,{runtimeRole:roles.runtime});
  assert.deepEqual([result.action,result.changed,result.statements,result.before,result.after,result.inspection_ok,result.other_acl_unchanged],
    ['grant',true,2,{marker:'NONE',declarations:'NONE',function:'NOT_IN_SCOPE'},{marker:'EXACT',declarations:'EXACT',function:'NOT_IN_SCOPE'},true,true]);
  assert.equal(JSON.stringify(result).includes(roles.runtime),false,'the result names no role');
  await exactTargets(db,roles.runtime);
  assert.deepEqual(await snapshot(db,{skipTables:M6}),start,'no other table, function, schema or database ACL changed');
  const inspected=await inspectPaperCapitalModel(db,{runtimeRole:roles.runtime,requireGrants:true});
  assert.equal(inspected.ok,true,inspected.failures.join());assert.equal((await classifyPaperCapitalModel(db)).state,'INSTALLED');
  for(const [table,privilege,expected] of [[MARKER,'SELECT',true],[MARKER,'INSERT',false],[DECL,'SELECT',true],[DECL,'INSERT',true],[DECL,'UPDATE',false],[DECL,'DELETE',false],[DECL,'TRUNCATE',false],[DECL,'TRIGGER',false]])
    assert.equal(await can(db,roles.runtime,table,privilege),expected,table+' '+privilege);
  const settled=await snapshot(db,{xmin:true});
  const again=await grant(db,{runtimeRole:roles.runtime});
  assert.deepEqual([again.changed,again.statements,again.before.marker,again.before.declarations],[false,0,'EXACT','EXACT']);
  assert.deepEqual(await snapshot(db,{xmin:true}),settled,'a no-op writes no catalog row');
});

test('every OTHER shape refuses grant and revoke with no change',async()=>{
  const rt=quote(roles.runtime),other=quote(roles.collector);
  const cases={
    'extra privilege on the declarations':`GRANT SELECT, INSERT, UPDATE ON public.${DECL} TO ${rt}; GRANT SELECT ON public.${MARKER} TO ${rt}`,
    'extra privilege on the marker':`GRANT SELECT, INSERT ON public.${MARKER} TO ${rt}`,
    'PUBLIC entry':`GRANT SELECT ON public.${DECL} TO PUBLIC`,
    'grant option':`GRANT SELECT ON public.${MARKER} TO ${rt} WITH GRANT OPTION`,
    'column grant':`GRANT SELECT (owner_id) ON public.${DECL} TO ${rt}`,
    'another grantee':`GRANT SELECT ON public.${DECL} TO ${other}`,
    'partial declarations':`GRANT SELECT ON public.${DECL} TO ${rt}`};
  for(const [label,statement] of Object.entries(cases)){
    const {db}=await clone('other');
    await db.query(statement);
    const start=await snapshot(db,{xmin:true});
    await refused(grant(db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
    await refused(revoke(db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
    assert.deepEqual(await snapshot(db,{xmin:true}),start,label+': no change');
  }
});

test('a half state (one table EXACT, the other NONE) refuses as mixed',async()=>{
  const {db}=await clone('mixed');
  await db.query(`GRANT SELECT ON public.${MARKER} TO ${quote(roles.runtime)}`);
  const start=await snapshot(db,{xmin:true});
  await refused(grant(db,{runtimeRole:roles.runtime}),'ACL_STATE_MIXED');
  assert.deepEqual(await snapshot(db,{xmin:true}),start);
});

test('a held runtime lock refuses with no change; the grant passes once the holder closes',async()=>{
  const {name,db}=await clone('lock');
  const holder=open(name,undefined,3);await holder.runtimeLock();
  const start=await snapshot(db,{xmin:true});
  await refused(grant(db,{runtimeRole:roles.runtime}),'MAINTENANCE_LOCK_HELD');
  await refused(revoke(db,{runtimeRole:roles.runtime}),'MAINTENANCE_LOCK_HELD');
  assert.deepEqual(await snapshot(db,{xmin:true}),start);
  await holder.close();
  await until(()=>lockFree(db),'lock release');
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,true);
});

test('a non-owner session refuses; a missing role refuses; the role is not guessed',async()=>{
  const {name,db}=await clone('session');
  await db.query(`GRANT SELECT ON public.schema_version TO ${quote(roles.nonowner)}`);
  const intruder=open(name,roles.nonowner,3);
  const start=await snapshot(db,{xmin:true});
  await refused(grant(intruder,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  await refused(revoke(intruder,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  await refused(grant(db,{runtimeRole:'robot_pcmg_missing_'+suffix}),'RUNTIME_ROLE_MISSING');
  // Case is not folded: the lower-case spelling of an existing mixed-case role does not exist as written here.
  await refused(grant(db,{runtimeRole:roles.mixed.toUpperCase()}),'RUNTIME_ROLE_MISSING');
  assert.deepEqual(await snapshot(db,{xmin:true}),start);
});

test('the runtime role must not own, be a member of the owner, or be a superuser or BYPASSRLS role',async()=>{
  const {db}=await clone('roles');
  const owner=(await db.query('SELECT current_user u')).rows[0].u;
  await refused(grant(db,{runtimeRole:owner}),'RUNTIME_ROLE_SUPERUSER');
  const lax=roles.collector;
  await db.query(`ALTER ROLE ${quote(lax)} BYPASSRLS`);
  try{await refused(grant(db,{runtimeRole:lax}),'RUNTIME_ROLE_BYPASSRLS');}finally{await db.query(`ALTER ROLE ${quote(lax)} NOBYPASSRLS`);}
  await db.query(`GRANT ${quote(owner)} TO ${quote(roles.reader)}`);
  try{await refused(grant(db,{runtimeRole:roles.reader}),'RUNTIME_ROLE_IS_OWNER');}finally{await db.query(`REVOKE ${quote(owner)} FROM ${quote(roles.reader)}`);}
  assert.deepEqual(await tableEntries(db,DECL),[]);
});

test('mixed-case and quoted role names are matched exactly and quoted as identifiers; a look-alike role gets nothing',async()=>{
  for(const role of [roles.mixed,roles.quoted]){
    const {db}=await clone('quote');
    const result=await grant(db,{runtimeRole:role});
    assert.equal(result.changed,true);assert.equal(JSON.stringify(result).includes(role),false);
    await exactTargets(db,role);
    assert.equal(await can(db,roles.mixedTwin,DECL,'SELECT'),false,'the lower-case twin holds nothing');
    assert.equal((await inspectPaperCapitalModel(db,{runtimeRole:role,requireGrants:true})).ok,true);
    assert.equal((await revoke(db,{runtimeRole:role})).changed,true);
    await noTargets(db);
  }
});

test('an ABSENT, partial or OTHER extension refuses with no change',async()=>{
  const absent=await clone('absent',{install:false});
  const start=await snapshot(absent.db,{xmin:true});
  await refused(grant(absent.db,{runtimeRole:roles.runtime}),'M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  assert.deepEqual(await snapshot(absent.db,{xmin:true}),start);
  const tampered=await clone('tampered');
  await tampered.db.query(`ALTER TABLE public.${DECL} DISABLE TRIGGER paper_capital_models_20_guard`);
  assert.equal((await classifyPaperCapitalModel(tampered.db)).state,'OTHER');
  const before=await snapshot(tampered.db,{xmin:true});
  await refused(grant(tampered.db,{runtimeRole:roles.runtime}),'M6_NOT_INSTALLED',['OTHER']);
  await refused(revoke(tampered.db,{runtimeRole:roles.runtime}),'M6_NOT_INSTALLED',['OTHER']);
  assert.deepEqual(await snapshot(tampered.db,{xmin:true}),before);
  const partial=await clone('partial');
  await partial.db.query('DROP TABLE public.'+DECL);
  await refused(grant(partial.db,{runtimeRole:roles.runtime}),'M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
});

test('revoke from EXACT gives NONE and restores the pre-grant ACL; a repeat is a no-op',async()=>{
  const {db}=await clone('revoke');
  const start=await snapshot(db);
  await grant(db,{runtimeRole:roles.runtime});
  const result=await revoke(db,{runtimeRole:roles.runtime});
  assert.deepEqual([result.action,result.changed,result.statements,result.before.marker,result.after.marker,result.after.declarations],['revoke',true,2,'EXACT','NONE','NONE']);
  await noTargets(db);
  assert.deepEqual(await snapshot(db),start,'the ACL state is the one before the grant');
  for(const [table,privilege] of [[MARKER,'SELECT'],[DECL,'SELECT'],[DECL,'INSERT']])assert.equal(await can(db,roles.runtime,table,privilege),false);
  const settled=await snapshot(db,{xmin:true});
  const again=await revoke(db,{runtimeRole:roles.runtime});
  assert.deepEqual([again.changed,again.statements],[false,0]);
  assert.deepEqual(await snapshot(db,{xmin:true}),settled);
  assert.equal((await inspectPaperCapitalModel(db,{runtimeRole:roles.runtime,requireGrants:false})).ok,true);
});

test('a staging-shaped grants fixture with several grantee roles: no other ACL changes; default privileges that grant a third role refuse',async()=>{
  const prepare=async db=>{
    const rt=quote(roles.runtime),col=quote(roles.collector),rd=quote(roles.reader);
    await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${rt}, ${col}, ${rd};
      GRANT SELECT, INSERT, UPDATE ON public.users, public.sessions, public.audit, public.signals TO ${rt};
      GRANT SELECT ON public.schema_version TO ${rt}, ${rd};
      GRANT SELECT, INSERT ON public.signals TO ${col};
      GRANT SELECT ON public.users, public.audit TO ${rd}; GRANT SELECT (email) ON public.users TO ${rd}`);
  };
  const {db}=await clone('staging',{before:prepare});
  const start=await snapshot(db,{skipTables:M6});
  assert.ok(start.length>10);
  const result=await grant(db,{runtimeRole:roles.runtime});
  assert.equal(result.changed,true);assert.equal(result.other_acl_unchanged,true);
  assert.deepEqual(await snapshot(db,{skipTables:M6}),start,'the ACL of every other relation, function, the schema and the database is as it was');
  await exactTargets(db,roles.runtime);
  assert.equal(await can(db,roles.collector,DECL,'SELECT'),false);assert.equal(await can(db,roles.reader,MARKER,'SELECT'),false);
  assert.equal((await revoke(db,{runtimeRole:roles.runtime})).changed,true);
  assert.deepEqual(await snapshot(db,{skipTables:M6}),start);
  // Default privileges of the owner that hand the new tables to a third role make the tables OTHER: the tool refuses instead of hiding it.
  const defaults=await clone('defaults',{before:async db=>{await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(roles.reader)}`);}});
  assert.ok((await tableEntries(defaults.db,DECL)).some(entry=>entry.grantee===roles.reader));
  const before=await snapshot(defaults.db,{xmin:true});
  await refused(grant(defaults.db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
  assert.deepEqual(await snapshot(defaults.db,{xmin:true}),before);
});

test('the EXECUTE branch: only when default privileges removed PUBLIC EXECUTE; the function ACL changes only with the option',async()=>{
  const {name,db}=await clone('execute',{noPublicExecute:true});
  assert.deepEqual(await functionEntries(db),[],'no PUBLIC entry on the new function');
  assert.equal(await canExecute(db,roles.runtime),false);
  const asRuntime=open(name,roles.runtime,2);
  await assert.rejects(asRuntime.query('SELECT public.paper_capital_model_now_ms()'),{code:'42501'});
  // Without PUBLIC EXECUTE the runtime role could read the tables but not stamp the clock: a grant without the option is refused as a whole, with no change.
  const closed=await snapshot(db,{xmin:true});
  await refused(grant(db,{runtimeRole:roles.runtime}),'VERIFY_EXECUTE',['GRANT']);
  assert.deepEqual(await snapshot(db,{xmin:true}),closed,'the refused grant left no ACL change');await noTargets(db);
  assert.equal(await canExecute(db,roles.runtime),false);
  const result=await grant(db,{runtimeRole:roles.runtime,includeExecute:true});
  assert.deepEqual([result.changed,result.statements,result.after.function,result.execute_in_scope],[true,3,'EXACT',true]);
  assert.deepEqual(await functionEntries(db),[{grantee:roles.runtime,privilege:'EXECUTE',grantable:false}]);
  assert.equal(await canExecute(db,roles.runtime),true);
  assert.equal((await asRuntime.query('SELECT public.paper_capital_model_now_ms() AS at')).rows.length,1);
  assert.equal((await grant(db,{runtimeRole:roles.runtime,includeExecute:true})).changed,false);
  // An explicit runtime EXECUTE entry with a grant that leaves the option out is a half state.
  await refused(grant(db,{runtimeRole:roles.runtime}),'ACL_STATE_MIXED');
  await refused(revoke(db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
  const reversed=await revoke(db,{runtimeRole:roles.runtime,includeExecute:true});
  assert.deepEqual([reversed.changed,reversed.after.function],[true,'NONE']);
  assert.equal(await canExecute(db,roles.runtime),false);await noTargets(db);
  // Without the removal PUBLIC keeps EXECUTE, so the claim behind the option is false and the tool refuses.
  const open2=await clone('execute_open');
  await refused(grant(open2.db,{runtimeRole:roles.runtime,includeExecute:true}),'ACL_STATE_OTHER');
  await noTargets(open2.db);
});

const literal=text=>"'"+text.replaceAll("'","''")+"'";
/** Re-own every capital-model table and function to the NOLOGIN NOSUPERUSER owner role, which also gets the read of schema_version that a session needs. */
async function reown(db){
  const owner=quote(roles.ownerRole);
  for(const table of M6)await db.query('ALTER TABLE public.'+table+' OWNER TO '+owner);
  await db.query(`DO $do$ DECLARE f regprocedure; BEGIN
    FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'paper_capital_model%' LOOP
      EXECUTE 'ALTER FUNCTION '||f||' OWNER TO '||${literal(owner)}; END LOOP; END $do$`);
  await db.query('GRANT SELECT ON public.schema_version TO '+owner);
}
const grantors=async(db,table)=>(await db.query(`SELECT DISTINCT g.rolname AS grantor FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
  JOIN pg_roles g ON g.oid=x.grantor JOIN pg_roles e ON e.oid=x.grantee WHERE c.oid=$1::regclass AND e.rolname=$2`,['public.'+table,roles.runtime])).rows.map(row=>row.grantor);

test('a NOSUPERUSER owner role with an inheriting member session: grant EXACT, revoke NONE, the grantor is the owner role',async()=>{
  const {name,db}=await clone('member');await reown(db);
  const member=open(name,roles.inheritMember,3);
  assert.equal((await member.query('SELECT pg_has_role($1::name,$2::name,$3) v',[roles.inheritMember,roles.ownerRole,'USAGE'])).rows[0].v,true);
  const result=await grant(member,{runtimeRole:roles.runtime});
  assert.deepEqual([result.changed,result.statements,result.before.marker,result.after.marker,result.after.declarations,result.inspection_ok],[true,2,'NONE','EXACT','EXACT',true]);
  await exactTargets(db,roles.runtime);
  assert.deepEqual(await grantors(db,MARKER),[roles.ownerRole],'the grant is recorded as made by the owner role, not by the member');
  assert.deepEqual(await grantors(db,DECL),[roles.ownerRole]);
  assert.equal((await grant(member,{runtimeRole:roles.runtime})).changed,false);
  const reversed=await revoke(member,{runtimeRole:roles.runtime});
  assert.deepEqual([reversed.changed,reversed.before.marker,reversed.after.marker,reversed.after.declarations],[true,'EXACT','NONE','NONE']);
  await noTargets(db);
});

test('the runtime role equal to the owner role refuses RUNTIME_ROLE_IS_OWNER; a NOINHERIT member session refuses SESSION_NOT_OWNER',async()=>{
  const {name,db}=await clone('ownerrole');await reown(db);
  // The test's own GRANT on schema_version comes first, so the snapshot compares only what the refused calls could change.
  await db.query('GRANT SELECT ON public.schema_version TO '+quote(roles.noInheritMember));
  const start=await snapshot(db,{xmin:true});
  await refused(grant(db,{runtimeRole:roles.ownerRole}),'RUNTIME_ROLE_IS_OWNER');
  await refused(revoke(db,{runtimeRole:roles.ownerRole}),'RUNTIME_ROLE_IS_OWNER');
  // Member of the owner role without INHERIT: the session does not hold the owner's privileges (pg_has_role USAGE is false), so it cannot act as owner.
  const member=open(name,roles.noInheritMember,3);
  assert.equal((await member.query('SELECT pg_has_role($1::name,$2::name,$3) v',[roles.noInheritMember,roles.ownerRole,'USAGE'])).rows[0].v,false);
  await refused(grant(member,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  await refused(revoke(member,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  assert.deepEqual(await snapshot(db,{xmin:true}),start);await noTargets(db);
});

test('a runtime role that fails the shared inspection refuses RUNTIME_ROLE_INSPECTION_FAILED; a schema that is not 14 refuses SCHEMA_NOT_14',async()=>{
  const {db}=await clone('inspect');
  // CREATE on schema public is a privilege the runtime role must never hold; the inspection reports it before any grant statement.
  await db.query('GRANT CREATE ON SCHEMA public TO '+quote(roles.runtime));
  try{
    const start=await snapshot(db,{xmin:true});
    const error=await refused(grant(db,{runtimeRole:roles.runtime}),'RUNTIME_ROLE_INSPECTION_FAILED');
    assert.ok(error.details.includes('RUNTIME_ROLE_SCHEMA_CREATE'),error.details.join());
    await refused(revoke(db,{runtimeRole:roles.runtime}),'RUNTIME_ROLE_INSPECTION_FAILED');
    assert.deepEqual(await snapshot(db,{xmin:true}),start);await noTargets(db);
  }finally{await db.query('REVOKE CREATE ON SCHEMA public FROM '+quote(roles.runtime));}
  const stale=await clone('schema');
  await stale.db.query('UPDATE public.schema_version SET version=13');
  const before=await snapshot(stale.db,{xmin:true});
  await refused(grant(stale.db,{runtimeRole:roles.runtime}),'SCHEMA_NOT_14');
  await refused(revoke(stale.db,{runtimeRole:roles.runtime}),'SCHEMA_NOT_14');
  assert.deepEqual(await snapshot(stale.db,{xmin:true}),before);
});

test('the CLI reads the role from the runtime connection and prints labels, counts and booleans only',async()=>{
  const {name,db}=await clone('cli');
  const cli=async(args,env)=>{
    try{const out=await run(process.execPath,[CLI,...args],{cwd:repoRoot,env:{...process.env,...env}});return {code:0,...out};}
    catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
  };
  const env={DATABASE_URL:urlOf(name),RUNTIME_DATABASE_URL:urlOf(name,roles.runtime)};
  const secrets=[roles.runtime,new URL(process.env.TEST_DATABASE_URL).password,new URL(process.env.TEST_DATABASE_URL).hostname].filter(Boolean);
  const clean=out=>{for(const text of [out.stdout,out.stderr])for(const secret of secrets)assert.equal(text.includes(secret),false,'output leaks a connection value');};
  const first=await cli(['--grant'],env);
  assert.equal(first.code,0,first.stderr);assert.match(first.stdout,/^Paper capital model grant done: changed=true; statements=2; before marker=NONE declarations=NONE function=NOT_IN_SCOPE; after marker=EXACT declarations=EXACT function=NOT_IN_SCOPE; inspection_ok=true; other_relations=\d+; other_acl_unchanged=true\r?\n$/);
  clean(first);await exactTargets(db,roles.runtime);
  const second=await cli(['--grant'],env);assert.equal(second.code,0);assert.match(second.stdout,/changed=true|changed=false/);assert.match(second.stdout,/changed=false; statements=0/);clean(second);
  // Different databases on the two connections are refused before any statement.
  const wrong=await cli(['--revoke'],{...env,RUNTIME_DATABASE_URL:urlOf(templateName,roles.runtime)});
  assert.equal(wrong.code,1);assert.match(wrong.stderr,/CONNECTIONS_DIFFER/);clean(wrong);await exactTargets(db,roles.runtime);
  const missing=await cli(['--revoke'],{DATABASE_URL:env.DATABASE_URL,RUNTIME_DATABASE_URL:''});
  assert.equal(missing.code,1);assert.match(missing.stderr,/RUNTIME_DATABASE_URL_REQUIRED/);clean(missing);
  const revoked=await cli(['--revoke'],env);assert.equal(revoked.code,0,revoked.stderr);assert.match(revoked.stdout,/^Paper capital model revoke done: changed=true; statements=2;/);clean(revoked);
  await noTargets(db);
  const absent=await clone('cli_absent',{install:false});
  const refusedRun=await cli(['--grant'],{DATABASE_URL:urlOf(absent.name),RUNTIME_DATABASE_URL:urlOf(absent.name,roles.runtime)});
  assert.equal(refusedRun.code,1);assert.match(refusedRun.stderr,/M6_NOT_INSTALLED/);assert.equal(refusedRun.stdout,'');clean(refusedRun);
});

/* ---- route level, as the runtime role ---- */

async function until(check,label,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await delay(100);}
  throw Error('timed out waiting for '+label);
}
/** The unchanged application server as the runtime role. It holds the shared maintenance lock, so every grant happens with it stopped. */
async function startServer(name){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;let output='',exited=false;
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,NODE_OPTIONS:'',NODE_ENV:'test',
    DATABASE_URL:urlOf(name,roles.runtime),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1',PINE_BRIDGE_ENV:'staging',
    PINE_BRIDGE_CAPTURE_ENABLED:'0',QUANT_RESEARCH_ENABLED:'0',QUANT_RESEARCH_FOUNDATION_ENABLED:'0',QUANT_PROFILE_V2_ENABLED:'0',QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'0',
    QUANT_PREFLIGHT_ENABLED:'0',QR2_PERFORMANCE_ENABLED:'1',MARKET_PUBLIC_PROXY:'0'}});
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  const done=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  const server={base,request:httpClient(base),stop:async()=>{if(!exited){child.kill('SIGTERM');await Promise.race([done,delay(5000).then(()=>child.kill('SIGKILL'))]);await done;}}};
  servers.push(server);
  let ready=false;
  for(let i=0;i<200&&!exited&&!ready;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}if(!ready)await delay(50);}
  if(!ready){await server.stop();throw Error('server startup failed: '+output.slice(-1500));}
  return server;
}

test('route level as the runtime role: 503 before install, 503 after install without the grant, PUT 200 and owner GET 200 after the grant, 503 again after the revoke',{timeout:240000},async()=>{
  const password='Capital-grant-'+randomUUID();
  const {name,db}=await clone('route',{install:false});
  // Staging shape: the repository runtime grants were applied BEFORE M6 existed; M6 tables therefore carry no runtime entry until the targeted grant.
  const script=(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+roles.runtime+"'");
  await db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
  await db.query(script);
  const store=new Store(db);
  const owner=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password),role:'USER'});
  await createBot(store,owner,10000);
  const free=()=>until(()=>lockFree(db),'maintenance lock free');
  const BODY={currency:'USDT',capital_model:'INDEPENDENT_ACCOUNTS'},PUT='/api/paper-capital-model',GET='/api/paper-performance/owner?currency=USDT&period=DAY';
  const session=async server=>{const login=await server.request('/api/auth/login','POST',{email:owner.email,password});assert.equal(login.status,200,JSON.stringify(login.body));return login.session;};
  // Only 42P01 (the table does not exist before the install) counts as zero rows; 42501 (permission denied) or any other error fails the test.
  const rows=async()=>(await db.query('SELECT version FROM public.paper_capital_models WHERE owner_id=$1',[owner.id]).catch(error=>{if(error?.code==='42P01')return {rows:[]};throw error;})).rows.length;
  // A direct probe as the runtime role: SQLSTATE code of a one-row-limit read of the declarations table, or 'OK'.
  const runtimeProbe=open(name,roles.runtime,2);
  const probe=async()=>{try{await runtimeProbe.query('SELECT version FROM public.paper_capital_models LIMIT 1');return 'OK';}catch(error){return error?.code||'ERR';}};
  const phase=async(label,expected)=>{
    const server=await startServer(name);
    try{
      const s=await session(server);
      const put=await server.request(PUT,'PUT',BODY,s),get=await server.request(GET,'GET',undefined,s);
      assert.equal(put.status,expected.put,label+' PUT '+JSON.stringify(put.body));assert.equal(get.status,expected.get,label+' GET '+JSON.stringify(get.body));
      if(expected.code)assert.equal(put.body.code,expected.code,label);
      if(expected.stepUp){
        assert.equal(put.body.declaration.version,1);
        await db.query('UPDATE sessions SET elevated_until=1 WHERE user_id=$1',[owner.id]);
        const denied=await server.request(PUT,'PUT',BODY,s);
        assert.equal(denied.status,403);assert.equal(denied.body.code,'STEP_UP_REQUIRED');
      }
    }finally{await server.stop();}
    await free();
  };
  assert.equal(await probe(),'42P01','before install: the table does not exist');
  await phase('before install',{put:503,get:503,code:'QR2_CAPITAL_MODEL_UNAVAILABLE'});
  await migratePaperCapitalModel(db,{runtimeRole:roles.runtime});
  assert.equal(await probe(),'42501','installed, no grant: permission denied');
  await phase('installed, no grant',{put:503,get:503,code:'QR2_CAPITAL_MODEL_UNAVAILABLE'});
  assert.equal(await rows(),0);
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,true);
  assert.equal(await probe(),'OK','granted: the runtime role reads the table');
  await phase('granted',{put:200,get:200,stepUp:true});
  assert.equal(await rows(),1);
  assert.equal((await revoke(db,{runtimeRole:roles.runtime})).changed,true);
  assert.equal(await probe(),'42501','revoked: permission denied again');
  await phase('revoked',{put:503,get:503,code:'QR2_CAPITAL_MODEL_UNAVAILABLE'});
  assert.equal((await db.query('SELECT count(*)::int n FROM public.paper_capital_models')).rows[0].n,1,'the declaration stays; only the access is withdrawn');
});
