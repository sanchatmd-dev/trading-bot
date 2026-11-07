import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateQuantExposureRegister,inspectQuantExposureRegister,classifyQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {migrateQuantComparison,rollbackQuantComparison,inspectQuantComparison,classifyQuantComparison} from '../../src/postgres/quant-comparison-migration.js';
import {grantQuantComparisonRuntime as grant,revokeQuantComparisonRuntime as revoke,inspectAsRuntimeRole,STATEMENTS,QuantComparisonGrantRefusal,
  TARGET_PRIVILEGES,ALL_TABLES} from '../../src/postgres/quant-comparison-grants.js';
import {readQuantComparisonGrantState,outsideExtensionsAclDigest,EXTENSION_FUNCTION_SIGNATURES} from '../../src/postgres/quant-comparison-grant-state.js';

// Targeted QR-3 set C grant (SC-7), proven on a throwaway PostgreSQL cluster. Every database is its own clone of a template: schema 14, the Pine and
// research extensions and, for the "full" template, the exposure register and the QR-3 comparison tables. Roles are real LOGIN roles where a connection is
// needed. Nothing here is evidence; no real owner, Bot or credential appears.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const CLI='scripts/grant-quant-comparison-runtime.mjs';
const REGISTER='quant_exposure_register',REGISTER_MARKER='quant_exposure_register_schema',COMPARISON_MARKER='quant_comparison_schema';
const SPECS='quant_comparison_specs';
const TABLES=[...ALL_TABLES];
const FUNCTION_NAMES=EXTENSION_FUNCTION_SIGNATURES.map(item=>item.slice(0,item.indexOf('(')));
let admin,fullTemplate,bareTemplate,suffix;
const roles={};
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const track=pool=>{pools.push(pool);return pool;};
const open=(name,user,max=6)=>track(new PostgresDatabase({connectionString:urlOf(name,user),max}));
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  suffix=randomUUID().replaceAll('-','').slice(0,12);
  Object.assign(roles,{runtime:'robot_qcg_rt_'+suffix,script:'robot_qcg_sc_'+suffix,collector:'robot_qcg_col_'+suffix,reader:'robot_qcg_rd_'+suffix,nonowner:'robot_qcg_no_'+suffix,
    mixed:'Robot_QCG_Mixed_'+suffix,mixedTwin:'robot_qcg_mixed_'+suffix,quoted:'robot qcg "q" '+suffix,ownerRole:'robot_qcg_own_'+suffix,
    inheritMember:'robot_qcg_im_'+suffix,noInheritMember:'robot_qcg_nm_'+suffix});
  for(const name of [roles.runtime,roles.nonowner])await admin.query('CREATE ROLE '+quote(name)+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  for(const name of [roles.script,roles.collector,roles.reader,roles.mixed,roles.mixedTwin,roles.quoted])await admin.query('CREATE ROLE '+quote(name)+' NOLOGIN NOSUPERUSER');
  await admin.query('CREATE ROLE '+quote(roles.ownerRole)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  await admin.query('CREATE ROLE '+quote(roles.inheritMember)+' LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE ROLE '+quote(roles.noInheritMember)+' LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('GRANT '+quote(roles.ownerRole)+' TO '+quote(roles.inheritMember)+', '+quote(roles.noInheritMember));
  bareTemplate='robot_qcg_bare_'+suffix;fullTemplate='robot_qcg_full_'+suffix;
  await admin.query('CREATE DATABASE '+bareTemplate);
  const builder=new PostgresDatabase({connectionString:urlOf(bareTemplate),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+fullTemplate+' TEMPLATE '+bareTemplate);
  const full=new PostgresDatabase({connectionString:urlOf(fullTemplate),max:2});
  try{await migrateQuantExposureRegister(full);await migrateQuantComparison(full);}finally{await full.close();}
});
after(async()=>{
  // Close every pool first, then drop; collect every error and fail the run if any occurred or anything is left behind.
  const errors=[];
  const attempt=async(label,action)=>{try{await action();}catch(error){errors.push(label+': '+(error&&error.message));}};
  for(const pool of pools)await attempt('pool close',async()=>{try{await pool.close();}catch(error){if(!/more than once/.test(error&&error.message))throw error;}});
  if(admin){
    // DROP DATABASE waits for a checkpoint, which can pass the 15 s statement timeout of the shared pool: drop on a dedicated session without that timeout.
    const dropper=new pg.Client({connectionString:process.env.TEST_DATABASE_URL,statement_timeout:0});
    await attempt('drop session',()=>dropper.connect());
    for(const name of [...databases,fullTemplate,bareTemplate].filter(Boolean))await attempt('drop database',()=>dropper.query('DROP DATABASE IF EXISTS '+quote(name)+' WITH (FORCE)'));
    await attempt('drop session close',()=>dropper.end());
    for(const name of Object.values(roles))await attempt('drop role',()=>admin.query('DROP ROLE IF EXISTS '+quote(name)));
    await attempt('leftovers',async()=>{
      const left=(await admin.query(`SELECT (SELECT count(*)::int FROM pg_database WHERE datname ILIKE 'robot\\_qcg\\_%') AS dbs,
        (SELECT count(*)::int FROM pg_roles WHERE rolname ILIKE 'robot\\_qcg\\_%' OR ($1::text<>'' AND rolname LIKE '%'||$1::text)) AS roles`,[suffix||''])).rows[0];
      assert.deepEqual([left.dbs,left.roles],[0,0],'no robot_qcg_ database or role remains');
    });
    await attempt('admin close',()=>admin.close());
  }
  assert.deepEqual(errors,[],'teardown errors');
});

/** A database from a template. before runs on the clone first (it can reach into the catalog); extensions:'late' installs both extensions after before ran. */
async function clone(label,{template=fullTemplate,late=false,before:prepare}={}){
  const name='robot_qcg_'+label+'_'+randomUUID().replaceAll('-','').slice(0,16);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+(late?bareTemplate:template));
  const db=open(name);
  if(prepare)await prepare(db);
  if(late){await migrateQuantExposureRegister(db);await migrateQuantComparison(db);}
  return {name,db};
}
/** Every ACL fact outside the ten tables and the sixteen extension functions, normalized so a NULL ACL and its explicit default compare equal. xmin shows that nothing was rewritten. */
const snapshot=async(db,{xmin=false,all=false}={})=>(await db.query(`SELECT x FROM (
  SELECT 'r:'||c.relname||':'||COALESCE((SELECT string_agg(e.grantor||'>'||e.grantee||':'||e.privilege_type||':'||e.is_grantable::text,',' ORDER BY e.grantee,e.privilege_type,e.grantor)
    FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) e),'')||CASE WHEN $1::boolean THEN ':'||c.xmin::text ELSE '' END AS x
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND ($3::boolean OR c.relname<>ALL($2::text[]))
  UNION ALL SELECT 'a:'||a.attrelid::regclass::text||':'||a.attnum||':'||a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL AND ($3::boolean OR c.relname<>ALL($2::text[]))
  UNION ALL SELECT 'f:'||p.oid||':'||COALESCE(p.proacl::text,'') FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND ($3::boolean OR p.proname<>ALL($4::text[]))
  UNION ALL SELECT 'n:'||COALESCE(nspacl::text,'') FROM pg_namespace WHERE nspname='public'
  UNION ALL SELECT 'd:'||COALESCE(datacl::text,'') FROM pg_database WHERE datname=current_database()
  UNION ALL SELECT 'x:'||oid||':'||COALESCE(defaclacl::text,'') FROM pg_default_acl) s ORDER BY x`,[xmin,TABLES,all,FUNCTION_NAMES])).rows.map(row=>row.x);
const tableEntries=async(db,table)=>(await db.query(`SELECT COALESCE(r.rolname,'PUBLIC') AS grantee,x.privilege_type AS privilege,x.is_grantable AS grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x LEFT JOIN pg_roles r ON r.oid=x.grantee
  WHERE c.oid=$1::regclass AND x.grantee<>c.relowner ORDER BY 1,2`,['public.'+table])).rows;
const entriesOf=async(db,role)=>Object.fromEntries(await Promise.all(TABLES.map(async table=>[table,(await tableEntries(db,table)).filter(entry=>entry.grantee===role).map(entry=>entry.privilege)])));
const can=async(db,role,table,privilege)=>(await db.query('SELECT has_table_privilege($1::name,$2,$3) v',[role,'public.'+table,privilege])).rows[0].v;
/** True when the maintenance try-lock is free (a transaction-level lock, released at once). */
const lockFree=target=>target.transaction(async()=>(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0)) ok")).rows[0].ok);
async function until(check,label,timeout=15000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await delay(100);}
  throw Error('timed out waiting for '+label);
}
const refused=async(promise,code,details)=>{
  const error=await promise.then(()=>null,reason=>reason);
  assert.ok(error instanceof QuantComparisonGrantRefusal,'refusal expected, got '+(error&&error.stack));
  assert.equal(error.code,code,error.message);
  if(details)assert.deepEqual(error.details,details);
  for(const name of Object.values(roles))assert.equal(error.message.includes(name),false,'the refusal names no role');
  return error;
};
const exactTargets=async(db,role)=>{
  const held=await entriesOf(db,role);
  for(const table of TABLES)assert.deepEqual(held[table],[...TARGET_PRIVILEGES[table]],table);
  for(const table of TABLES)assert.equal((await tableEntries(db,table)).some(entry=>entry.grantable||entry.grantee==='PUBLIC'),false,table+': no grant option, no PUBLIC entry');
};
const noTargets=async db=>{for(const table of TABLES)assert.deepEqual(await tableEntries(db,table),[],table);};
const stateOf=async(db,role)=>(await readQuantComparisonGrantState(db,{runtimeRole:role}));

test('exact privilege sets: grant gives EXACT on all ten tables, the inspections are ok with grants required, the second run is a no-op that rewrites nothing',async()=>{
  const {db}=await clone('exact');
  await noTargets(db);
  assert.deepEqual((await stateOf(db,roles.runtime)).groups,{register:'NONE',comparison:'NONE'});
  const start=await snapshot(db);
  const digest=await outsideExtensionsAclDigest(db);
  const result=await grant(db,{runtimeRole:roles.runtime});
  assert.deepEqual([result.action,result.changed,result.statements,result.before,result.after,result.inspection_ok,result.other_acl_unchanged],
    ['grant',true,3,{register:'NONE',comparison:'NONE',state:'NONE'},{register:'EXACT',comparison:'EXACT',state:'EXACT'},true,true]);
  assert.equal(result.acl_digest_before,result.acl_digest_after);assert.equal(result.acl_digest_after,digest.digest,'the digest equals the stand-alone digest read');
  assert.equal(JSON.stringify(result).includes(roles.runtime),false,'the result names no role');
  await exactTargets(db,roles.runtime);
  assert.deepEqual(await snapshot(db),start,'no other table, function, schema or database ACL changed');
  assert.deepEqual(await outsideExtensionsAclDigest(db),digest);
  for(const table of TABLES)for(const privilege of ['DELETE','TRUNCATE','TRIGGER','REFERENCES'])assert.equal(await can(db,roles.runtime,table,privilege),false,table+' '+privilege);
  assert.equal(await can(db,roles.runtime,REGISTER,'UPDATE'),true);
  for(const table of TABLES.filter(item=>item!==REGISTER))assert.equal(await can(db,roles.runtime,table,'UPDATE'),false,table+' UPDATE');
  for(const table of [REGISTER_MARKER,COMPARISON_MARKER])assert.equal(await can(db,roles.runtime,table,'INSERT'),false,table+' INSERT');
  const registerReport=await inspectQuantExposureRegister(db,{runtimeRole:roles.runtime,requireGrants:true}),comparisonReport=await inspectQuantComparison(db,{runtimeRole:roles.runtime,requireGrants:true});
  assert.equal(registerReport.ok,true,registerReport.failures.join());assert.equal(comparisonReport.ok,true,comparisonReport.failures.join());
  assert.equal((await classifyQuantExposureRegister(db)).state,'INSTALLED');assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
  const settled=await snapshot(db,{xmin:true,all:true});
  const again=await grant(db,{runtimeRole:roles.runtime});
  assert.deepEqual([again.changed,again.statements,again.before.state,again.after.state],[false,0,'EXACT','EXACT']);
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),settled,'a no-op writes no catalog row');
});

test('revoke from EXACT gives NONE and restores the pre-grant ACL; a repeat is a no-op; the inspections stay ok without grants',async()=>{
  const {db}=await clone('revoke');
  const start=await snapshot(db,{all:true});
  await grant(db,{runtimeRole:roles.runtime});
  const result=await revoke(db,{runtimeRole:roles.runtime});
  assert.deepEqual([result.action,result.changed,result.statements,result.before.state,result.after.state],['revoke',true,3,'EXACT','NONE']);
  await noTargets(db);
  assert.deepEqual(await snapshot(db,{all:true}),start,'the ACL state is the one before the grant');
  for(const table of TABLES)for(const privilege of ['SELECT','INSERT','UPDATE'])assert.equal(await can(db,roles.runtime,table,privilege),false,table+' '+privilege);
  const settled=await snapshot(db,{xmin:true,all:true});
  const again=await revoke(db,{runtimeRole:roles.runtime});
  assert.deepEqual([again.changed,again.statements],[false,0]);
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),settled);
  assert.equal((await inspectQuantComparison(db,{runtimeRole:roles.runtime,requireGrants:false})).ok,true);
  assert.equal((await inspectQuantExposureRegister(db,{runtimeRole:roles.runtime,requireGrants:false})).ok,true);
});

test('every OTHER shape refuses grant and revoke with no change',async()=>{
  const rt=quote(roles.runtime),other=quote(roles.collector);
  const cases={
    'DELETE on the register':`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${REGISTER} TO ${rt}`,
    'TRUNCATE on a record table':`GRANT TRUNCATE ON public.${SPECS} TO ${rt}`,
    'TRIGGER on a record table':`GRANT TRIGGER ON public.${SPECS} TO ${rt}`,
    'UPDATE on a record table':`GRANT UPDATE ON public.${SPECS} TO ${rt}`,
    'INSERT on a marker table':`GRANT INSERT ON public.${COMPARISON_MARKER} TO ${rt}`,
    'PUBLIC entry':`GRANT SELECT ON public.${SPECS} TO PUBLIC`,
    'grant option':`GRANT SELECT ON public.${REGISTER_MARKER} TO ${rt} WITH GRANT OPTION`,
    'column grant':`GRANT SELECT (owner_id) ON public.${REGISTER} TO ${rt}`,
    'another grantee':`GRANT SELECT ON public.${SPECS} TO ${other}`,
    'partial register privileges':`GRANT SELECT ON public.${REGISTER} TO ${rt}`};
  for(const [label,statement] of Object.entries(cases)){
    const {db}=await clone('other');
    await db.query(statement);
    const start=await snapshot(db,{xmin:true,all:true});
    assert.equal((await stateOf(db,roles.runtime)).state,'OTHER',label);
    await refused(grant(db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
    await refused(revoke(db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
    assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start,label+': no change');
  }
});

test('a half state refuses as mixed: one table, one group, or one group EXACT while the other is NONE',async()=>{
  const rt=quote(roles.runtime);
  const cases={
    'one marker only':`GRANT SELECT ON public.${REGISTER_MARKER} TO ${rt}`,
    'one record table EXACT':`GRANT SELECT, INSERT ON public.${SPECS} TO ${rt}`,
    'register group EXACT, comparison NONE':`GRANT SELECT ON public.${REGISTER_MARKER} TO ${rt}; GRANT SELECT, INSERT, UPDATE ON public.${REGISTER} TO ${rt}`};
  for(const [label,statement] of Object.entries(cases)){
    const {db}=await clone('mixed');
    await db.query(statement);
    const start=await snapshot(db,{xmin:true,all:true});
    assert.equal((await stateOf(db,roles.runtime)).state,'MIXED',label);
    await refused(grant(db,{runtimeRole:roles.runtime}),'ACL_STATE_MIXED');
    await refused(revoke(db,{runtimeRole:roles.runtime}),'ACL_STATE_MIXED');
    assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start,label+': no change');
  }
  // A group-level half state names its reason.
  const {db}=await clone('mixed_reason');
  await db.query(`GRANT SELECT ON public.${REGISTER_MARKER} TO ${rt}; GRANT SELECT, INSERT, UPDATE ON public.${REGISTER} TO ${rt}`);
  const state=await stateOf(db,roles.runtime);
  assert.deepEqual([state.groups.register,state.groups.comparison],['EXACT','NONE']);assert.ok(state.reasons.includes('GROUPS_IN_DIFFERENT_STATES'));
});

test('a held maintenance lock refuses with no change; the grant passes once the holder closes',async()=>{
  const {name,db}=await clone('lock');
  const holder=open(name,undefined,3);await holder.runtimeLock();
  const start=await snapshot(db,{xmin:true,all:true});
  await refused(grant(db,{runtimeRole:roles.runtime}),'MAINTENANCE_LOCK_HELD');
  await refused(revoke(db,{runtimeRole:roles.runtime}),'MAINTENANCE_LOCK_HELD');
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start);
  await holder.close();
  await until(()=>lockFree(db),'lock release');
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,true);
});

test('a table lock held by another session refuses LOCK_TABLES_TIMEOUT with no change',{timeout:60000},async()=>{
  const {name,db}=await clone('tablelock');
  const holder=new pg.Client({connectionString:urlOf(name)});await holder.connect();
  try{
    await holder.query('BEGIN');await holder.query(`LOCK TABLE public.${SPECS} IN ACCESS SHARE MODE`);
    const start=await snapshot(db,{xmin:true,all:true});
    await refused(grant(db,{runtimeRole:roles.runtime}),'LOCK_TABLES_TIMEOUT');
    assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start);
  }finally{await holder.query('ROLLBACK').catch(()=>{});await holder.end();}
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,true);
});

test('a non-owner session refuses; a missing role refuses; the role is not guessed',async()=>{
  const {name,db}=await clone('session');
  await db.query(`GRANT SELECT ON public.schema_version TO ${quote(roles.nonowner)}`);
  const intruder=open(name,roles.nonowner,3);
  const start=await snapshot(db,{xmin:true,all:true});
  await refused(grant(intruder,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  await refused(revoke(intruder,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  await refused(grant(db,{runtimeRole:'robot_qcg_missing_'+suffix}),'RUNTIME_ROLE_MISSING');
  // Case is not folded: the upper-case spelling of an existing mixed-case role does not exist as written here.
  await refused(grant(db,{runtimeRole:roles.mixed.toUpperCase()}),'RUNTIME_ROLE_MISSING');
  for(const bad of ['','x'.repeat(64),'a\u0000b',null,undefined,7])await refused(grant(db,{runtimeRole:bad}),'RUNTIME_ROLE_INVALID');
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start);
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
  await noTargets(db);
});

test('mixed-case and quoted role names are matched exactly and quoted as identifiers; a look-alike role gets nothing',async()=>{
  for(const role of [roles.mixed,roles.quoted]){
    const {db}=await clone('quote');
    const result=await grant(db,{runtimeRole:role});
    assert.equal(result.changed,true);assert.equal(JSON.stringify(result).includes(role),false);
    await exactTargets(db,role);
    assert.equal(await can(db,roles.mixedTwin,SPECS,'SELECT'),false,'the lower-case twin holds nothing');
    assert.equal((await inspectQuantComparison(db,{runtimeRole:role,requireGrants:true})).ok,true);
    assert.equal((await revoke(db,{runtimeRole:role})).changed,true);
    await noTargets(db);
  }
});

test('extensions not INSTALLED refuse with no change: both absent, the comparison absent, an OTHER register, an OTHER comparison',async()=>{
  const bare=await clone('bare',{template:bareTemplate});
  const start=await snapshot(bare.db,{xmin:true,all:true});
  assert.equal((await stateOf(bare.db,roles.runtime)).state,'ABSENT');
  await refused(grant(bare.db,{runtimeRole:roles.runtime}),'EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  await refused(revoke(bare.db,{runtimeRole:roles.runtime}),'EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  assert.deepEqual(await snapshot(bare.db,{xmin:true,all:true}),start);
  // The register alone: the comparison tables are rolled back (no row exists), so the register stays INSTALLED and the comparison is ABSENT.
  const registerOnly=await clone('regonly');
  await rollbackQuantComparison(registerOnly.db);
  const registerOnlyState=await stateOf(registerOnly.db,roles.runtime);
  assert.deepEqual([registerOnlyState.state,registerOnlyState.groups],['ABSENT',{register:'NONE',comparison:'ABSENT'}]);
  await refused(grant(registerOnly.db,{runtimeRole:roles.runtime}),'EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  assert.deepEqual(await tableEntries(registerOnly.db,REGISTER),[]);
  // A tampered register (its freeze trigger disabled) is OTHER, so both directions refuse.
  const tamperedRegister=await clone('tamper_reg');
  await tamperedRegister.db.query(`ALTER TABLE public.${REGISTER} DISABLE TRIGGER quant_exposure_register_no_change`);
  assert.equal((await classifyQuantExposureRegister(tamperedRegister.db)).state,'OTHER');
  const before=await snapshot(tamperedRegister.db,{xmin:true,all:true});
  await refused(grant(tamperedRegister.db,{runtimeRole:roles.runtime}),'EXTENSION_NOT_INSTALLED',['REGISTER:OTHER','COMPARISON:INSTALLED']);
  await refused(revoke(tamperedRegister.db,{runtimeRole:roles.runtime}),'EXTENSION_NOT_INSTALLED',['REGISTER:OTHER','COMPARISON:INSTALLED']);
  assert.deepEqual(await snapshot(tamperedRegister.db,{xmin:true,all:true}),before);
  // A tampered comparison (a record table trigger disabled) is OTHER.
  const tamperedComparison=await clone('tamper_cmp');
  const trigger=(await tamperedComparison.db.query(`SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid='public.${SPECS}'::regclass AND NOT t.tgisinternal AND t.tgname LIKE '%no_change'`)).rows[0].tgname;
  await tamperedComparison.db.query(`ALTER TABLE public.${SPECS} DISABLE TRIGGER ${trigger}`);
  assert.equal((await classifyQuantComparison(tamperedComparison.db)).state,'OTHER');
  const after2=await snapshot(tamperedComparison.db,{xmin:true,all:true});
  await refused(grant(tamperedComparison.db,{runtimeRole:roles.runtime}),'EXTENSION_NOT_INSTALLED',['REGISTER:INSTALLED','COMPARISON:OTHER']);
  assert.deepEqual(await snapshot(tamperedComparison.db,{xmin:true,all:true}),after2);
});

test('a runtime role with CREATE on schema public refuses RUNTIME_ROLE_INSPECTION_FAILED; a schema that is not 14 refuses SCHEMA_NOT_14',async()=>{
  const {db}=await clone('inspect');
  await db.query('GRANT CREATE ON SCHEMA public TO '+quote(roles.runtime));
  try{
    const start=await snapshot(db,{xmin:true,all:true});
    const error=await refused(grant(db,{runtimeRole:roles.runtime}),'RUNTIME_ROLE_INSPECTION_FAILED');
    assert.ok(error.details.includes('RUNTIME_ROLE_SCHEMA_CREATE'),error.details.join());
    await refused(revoke(db,{runtimeRole:roles.runtime}),'RUNTIME_ROLE_INSPECTION_FAILED');
    assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start);await noTargets(db);
  }finally{await db.query('REVOKE CREATE ON SCHEMA public FROM '+quote(roles.runtime));}
  assert.equal((await grant(db,{runtimeRole:roles.runtime})).changed,true,'the same database grants once the CREATE privilege is gone');
  const stale=await clone('schema');
  await stale.db.query('UPDATE public.schema_version SET version=13');
  const before=await snapshot(stale.db,{xmin:true,all:true});
  await refused(grant(stale.db,{runtimeRole:roles.runtime}),'SCHEMA_NOT_14');
  await refused(revoke(stale.db,{runtimeRole:roles.runtime}),'SCHEMA_NOT_14');
  assert.deepEqual(await snapshot(stale.db,{xmin:true,all:true}),before);
});

test('a failure after the grant statements rolls the whole transaction back (injected inspection fault)',async()=>{
  const {db}=await clone('atomic');
  const start=await snapshot(db,{xmin:true,all:true});
  let calls=0;
  const flaky=async()=>{calls++;return calls===1?{ok:true,failures:[],register:'INSTALLED',comparison:'INSTALLED'}:{ok:false,failures:['INJECTED_FAULT'],register:'INSTALLED',comparison:'INSTALLED'};};
  await refused(grant(db,{runtimeRole:roles.runtime},{inspect:flaky}),'VERIFY_INSPECTION',['INJECTED_FAULT']);
  assert.equal(calls,2);
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start,'the grant statements were rolled back with the transaction');
  await noTargets(db);
  // A write to any other ACL inside the transaction is caught by the digest and rolled back with everything else.
  let stray=0;
  const meddling=async target=>{stray++;if(stray===2)await target.query('GRANT SELECT ON public.users TO '+quote(roles.reader));return {ok:true,failures:[],register:'INSTALLED',comparison:'INSTALLED'};};
  await refused(grant(db,{runtimeRole:roles.runtime},{inspect:meddling}),'VERIFY_OTHER_ACL_CHANGED');
  assert.equal(stray,2);
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start,'the stray grant and the target grants were rolled back');
  // The stand-alone digest does move when another object's ACL moves, and does not move for the target tables.
  const digest=(await outsideExtensionsAclDigest(db)).digest;
  await db.query('GRANT SELECT ON public.users TO '+quote(roles.reader));
  try{assert.notEqual((await outsideExtensionsAclDigest(db)).digest,digest);}finally{await db.query('REVOKE SELECT ON public.users FROM '+quote(roles.reader));}
  // The same for the revoke over an EXACT state.
  await grant(db,{runtimeRole:roles.runtime});
  const exact=await snapshot(db,{xmin:true,all:true});calls=0;
  await refused(revoke(db,{runtimeRole:roles.runtime},{inspect:flaky}),'VERIFY_INSPECTION',['INJECTED_FAULT']);
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),exact);await exactTargets(db,roles.runtime);
});

/** A grants-v4-shaped role set: schema public closed to PUBLIC CREATE, the runtime role and two other roles with their own table grants made BEFORE the extensions
 * existed (so the extension tables carry no runtime entry), legacy DELETE kept, quant_job_steps kept append-only, a column grant to a third role. */
const v4Shape=async db=>{
  const rt=quote(roles.runtime),col=quote(roles.collector),rd=quote(roles.reader);
  await db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${rt}, ${col}, ${rd};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${rt};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rt};
    GRANT DELETE ON public.users, public.sessions TO ${rt};
    GRANT SELECT, INSERT ON public.users, public.sessions TO ${col};
    GRANT SELECT ON public.schema_version TO ${col}, ${rd};
    GRANT SELECT (email) ON public.users TO ${rd}`);
  await db.query(`DO $do$ BEGIN IF to_regclass('public.quant_job_steps') IS NOT NULL THEN EXECUTE 'REVOKE UPDATE, DELETE ON public.quant_job_steps FROM ${rt}'; END IF; END $do$`);
};

test('a staging-shaped grants-v4 role set: only the ten tables change for the runtime role; other grantees and default privileges are as they were',async()=>{
  const {db}=await clone('v4',{late:true,before:v4Shape});
  await noTargets(db);
  const start=await snapshot(db);
  assert.ok(start.length>10);
  const steps=await can(db,roles.runtime,'quant_job_steps','UPDATE');
  const result=await grant(db,{runtimeRole:roles.runtime});
  assert.equal(result.changed,true);assert.equal(result.other_acl_unchanged,true);
  assert.deepEqual(await snapshot(db),start,'the ACL of every other relation, function, the schema and the database is as it was');
  await exactTargets(db,roles.runtime);
  assert.equal(await can(db,roles.runtime,'quant_job_steps','UPDATE'),steps,'the v4 append-only shape of quant_job_steps is untouched');
  assert.equal(await can(db,roles.collector,SPECS,'SELECT'),false);assert.equal(await can(db,roles.reader,REGISTER_MARKER,'SELECT'),false);
  assert.equal((await inspectQuantExposureRegister(db,{runtimeRole:roles.runtime,requireGrants:true})).ok,true);
  assert.equal((await inspectQuantComparison(db,{runtimeRole:roles.runtime,requireGrants:true})).ok,true);
  assert.equal((await revoke(db,{runtimeRole:roles.runtime})).changed,true);
  assert.deepEqual(await snapshot(db),start);await noTargets(db);
  // Default privileges of the owner that hand new tables to a third role make the tables OTHER: the tool refuses instead of hiding it.
  const defaults=await clone('v4_defaults',{late:true,before:async target=>{await v4Shape(target);await target.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quote(roles.reader)}`);}});
  assert.ok((await tableEntries(defaults.db,SPECS)).some(entry=>entry.grantee===roles.reader));
  const before=await snapshot(defaults.db,{xmin:true,all:true});
  await refused(grant(defaults.db,{runtimeRole:roles.runtime}),'ACL_STATE_OTHER');
  assert.deepEqual(await snapshot(defaults.db,{xmin:true,all:true}),before);
});

const literal=text=>"'"+text.replaceAll("'","''")+"'";
/** Re-own every extension table and function to the NOLOGIN NOSUPERUSER owner role, which also gets the read of schema_version that a session needs. */
async function reown(db){
  const owner=quote(roles.ownerRole);
  for(const table of TABLES)await db.query('ALTER TABLE public.'+table+' OWNER TO '+owner);
  await db.query(`DO $do$ DECLARE f regprocedure; BEGIN
    FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(${literal('{'+FUNCTION_NAMES.join(',')+'}')}::text[]) LOOP
      EXECUTE 'ALTER FUNCTION '||f||' OWNER TO '||${literal(owner)}; END LOOP; END $do$`);
  await db.query('GRANT SELECT ON public.schema_version TO '+owner);
}
const grantors=async(db,table)=>(await db.query(`SELECT DISTINCT g.rolname AS grantor FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
  JOIN pg_roles g ON g.oid=x.grantor JOIN pg_roles e ON e.oid=x.grantee WHERE c.oid=$1::regclass AND e.rolname=$2`,['public.'+table,roles.runtime])).rows.map(row=>row.grantor);

test('a NOSUPERUSER owner role with an inheriting member session: grant EXACT, revoke NONE, the grantor is the owner role',async()=>{
  const {name,db}=await clone('member');await reown(db);
  const member=open(name,roles.inheritMember,3);
  const result=await grant(member,{runtimeRole:roles.runtime});
  assert.deepEqual([result.changed,result.statements,result.before.state,result.after.state,result.inspection_ok],[true,3,'NONE','EXACT',true]);
  await exactTargets(db,roles.runtime);
  for(const table of TABLES)assert.deepEqual(await grantors(db,table),[roles.ownerRole],table+': the grant is recorded as made by the owner role, not by the member');
  assert.equal((await grant(member,{runtimeRole:roles.runtime})).changed,false);
  const reversed=await revoke(member,{runtimeRole:roles.runtime});
  assert.deepEqual([reversed.changed,reversed.before.state,reversed.after.state],[true,'EXACT','NONE']);
  await noTargets(db);
});

test('the runtime role equal to the owner role refuses RUNTIME_ROLE_IS_OWNER; a NOINHERIT member session refuses SESSION_NOT_OWNER',async()=>{
  const {name,db}=await clone('ownerrole');await reown(db);
  await db.query('GRANT SELECT ON public.schema_version TO '+quote(roles.noInheritMember));
  const start=await snapshot(db,{xmin:true,all:true});
  await refused(grant(db,{runtimeRole:roles.ownerRole}),'RUNTIME_ROLE_IS_OWNER');
  await refused(revoke(db,{runtimeRole:roles.ownerRole}),'RUNTIME_ROLE_IS_OWNER');
  const member=open(name,roles.noInheritMember,3);
  assert.equal((await member.query('SELECT pg_has_role($1::name,$2::name,$3) v',[roles.noInheritMember,roles.ownerRole,'USAGE'])).rows[0].v,false);
  await refused(grant(member,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  await refused(revoke(member,{runtimeRole:roles.runtime}),'SESSION_NOT_OWNER');
  assert.deepEqual(await snapshot(db,{xmin:true,all:true}),start);await noTargets(db);
});

const repositoryScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'",literal(role));

test('the targeted result equals what the repository grant script grants on these ten tables, and a grant over the script result is a no-op',async()=>{
  const viaTool=await clone('equal_tool');
  await grant(viaTool.db,{runtimeRole:roles.runtime});
  const viaScript=await clone('equal_script');
  await viaScript.db.query(await repositoryScript(roles.script));
  assert.deepEqual(await entriesOf(viaScript.db,roles.script),await entriesOf(viaTool.db,roles.runtime),'the same privileges on the same ten tables');
  for(const table of TABLES)assert.deepEqual((await tableEntries(viaScript.db,table)).filter(entry=>entry.grantee===roles.script).map(entry=>entry.privilege),[...TARGET_PRIVILEGES[table]],table);
  // The script result is EXACT for the tool: granting the same privileges to the script's own role is a no-op, and the inspections pass with grants required.
  assert.equal((await stateOf(viaScript.db,roles.script)).state,'EXACT');
  const noop=await grant(viaScript.db,{runtimeRole:roles.script});
  assert.deepEqual([noop.changed,noop.statements,noop.before.state],[false,0,'EXACT']);
});

test('the runtime role as itself: denied before the grant, the exact access after, DELETE and TRUNCATE never; inspections on its own connection',async()=>{
  const {name,db}=await clone('asruntime');
  const asRuntime=open(name,roles.runtime,2);
  const code=async sql=>{try{await asRuntime.query(sql);return 'OK';}catch(error){return error?.code||'ERR';}};
  for(const table of TABLES)assert.equal(await code(`SELECT count(*) FROM public.${table}`),'42501',table+' before the grant');
  await refused(inspectAsRuntimeRole(asRuntime,{runtimeRole:roles.runtime,requireGrants:true}),'DATABASE_ERROR',['42501']);
  await grant(db,{runtimeRole:roles.runtime});
  for(const table of TABLES)assert.equal(await code(`SELECT count(*) FROM public.${table}`),'OK',table+' after the grant');
  for(const table of TABLES){
    assert.equal(await code(`DELETE FROM public.${table}`),'42501',table+' DELETE');
    assert.equal(await code(`TRUNCATE public.${table}`),'42501',table+' TRUNCATE');
  }
  for(const table of [REGISTER_MARKER,COMPARISON_MARKER])assert.equal(await code(`INSERT INTO public.${table} DEFAULT VALUES`),'42501',table+' INSERT');
  // INSERT is permitted on the register and every record table: the statement then fails on a constraint or a guard (never on privilege), and an UPDATE is never permitted on a record table.
  assert.notEqual(await code(`INSERT INTO public.${REGISTER} DEFAULT VALUES`),'42501');
  assert.notEqual(await code(`INSERT INTO public.${SPECS} DEFAULT VALUES`),'42501');
  assert.equal(await code(`UPDATE public.${SPECS} SET owner_id='x'`),'42501');
  // UPDATE on the register only carries the writer's table lock.
  const lock=open(name,roles.runtime,2);
  assert.equal(await lock.transaction(async()=>{await lock.query(`LOCK TABLE public.${REGISTER} IN SHARE ROW EXCLUSIVE MODE`);return 'OK';}),'OK');
  const report=await inspectAsRuntimeRole(asRuntime,{runtimeRole:roles.runtime,requireGrants:true});
  assert.deepEqual([report.ok,report.register,report.comparison,report.failures],[true,'INSTALLED','INSTALLED',[]]);
  assert.equal(JSON.stringify(report).includes(roles.runtime),false);
  await revoke(db,{runtimeRole:roles.runtime});
  assert.equal(await code(`SELECT count(*) FROM public.${SPECS}`),'42501','revoked: permission denied again');
});

test('the SQL statements name the role only through the bound setting and carry exactly the target privileges',async()=>{
  const texts=[...STATEMENTS.GRANT,...STATEMENTS.REVOKE];
  assert.equal(STATEMENTS.GRANT.length,3);assert.equal(STATEMENTS.REVOKE.length,3);
  for(const text of texts){
    assert.ok(text.includes('%I'),text);
    assert.equal(/(DELETE|TRUNCATE|TRIGGER|REFERENCES|SEQUENCE)|ON ALL |WITH GRANT OPTION|(TO|FROM) PUBLIC/i.test(text),false,text);
    for(const value of Object.values(roles))assert.equal(text.includes(value),false);
  }
});

test('the CLI reads the role from the runtime connection, prints labels, counts, booleans and one digest only, and rejects every argument but one mode',{timeout:120000},async()=>{
  const {name,db}=await clone('cli');
  const cli=async(args,env)=>{
    try{const out=await run(process.execPath,[CLI,...args],{cwd:repoRoot,env:{...process.env,...env}});return {code:0,...out};}
    catch(error){return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
  };
  const env={DATABASE_URL:urlOf(name),RUNTIME_DATABASE_URL:urlOf(name,roles.runtime)};
  const secrets=[roles.runtime,new URL(process.env.TEST_DATABASE_URL).password,new URL(process.env.TEST_DATABASE_URL).hostname].filter(Boolean);
  const clean=out=>{for(const text of [out.stdout,out.stderr])for(const secret of secrets)assert.equal(text.includes(secret),false,'output leaks a connection value');};
  const inspectBefore=await cli(['--inspect'],env);
  assert.equal(inspectBefore.code,0,inspectBefore.stderr);
  assert.match(inspectBefore.stdout,/^Quant comparison grant state: state=NONE; register=NONE; comparison=NONE; extensions register=INSTALLED comparison=INSTALLED; inspection_ok=true; runtime_connection_ok=not_run\r?\n$/);clean(inspectBefore);
  const first=await cli(['--grant'],env);
  assert.equal(first.code,0,first.stderr);
  assert.match(first.stdout,/^Quant comparison grant done: changed=true; statements=3; before register=NONE comparison=NONE; after register=EXACT comparison=EXACT; inspection_ok=true; other_relations=\d+; other_acl_unchanged=true; acl_digest=[0-9a-f]{32}; runtime_connection_ok=true\r?\n$/);
  clean(first);await exactTargets(db,roles.runtime);
  const second=await cli(['--grant'],env);assert.equal(second.code,0);assert.match(second.stdout,/changed=false; statements=0/);clean(second);
  const inspected=await cli(['--inspect'],env);
  assert.equal(inspected.code,0,inspected.stderr);
  assert.match(inspected.stdout,/^Quant comparison grant state: state=EXACT; register=EXACT; comparison=EXACT; extensions register=INSTALLED comparison=INSTALLED; inspection_ok=true; runtime_connection_ok=true\r?\n$/);clean(inspected);
  // Different databases on the two connections are refused before any statement.
  const wrong=await cli(['--revoke'],{...env,RUNTIME_DATABASE_URL:urlOf(fullTemplate,roles.runtime)});
  assert.equal(wrong.code,1);assert.match(wrong.stderr,/CONNECTIONS_DIFFER/);clean(wrong);await exactTargets(db,roles.runtime);
  const missing=await cli(['--revoke'],{DATABASE_URL:env.DATABASE_URL,RUNTIME_DATABASE_URL:''});
  assert.equal(missing.code,1);assert.match(missing.stderr,/RUNTIME_DATABASE_URL_REQUIRED/);clean(missing);
  const revoked=await cli(['--revoke'],env);assert.equal(revoked.code,0,revoked.stderr);
  assert.match(revoked.stdout,/^Quant comparison revoke done: changed=true; statements=3;.*runtime_connection_ok=not_run\r?\n$/);clean(revoked);
  await noTargets(db);
  // OTHER state: --inspect names it and exits 1; --grant refuses with no change.
  await db.query(`GRANT TRUNCATE ON public.${SPECS} TO ${quote(roles.runtime)}`);
  const other=await cli(['--inspect'],env);assert.equal(other.code,1);assert.match(other.stdout,/state=OTHER;/);clean(other);
  const refusedGrant=await cli(['--grant'],env);assert.equal(refusedGrant.code,1);assert.match(refusedGrant.stderr,/ACL_STATE_OTHER/);assert.equal(refusedGrant.stdout,'');clean(refusedGrant);
  await db.query(`REVOKE TRUNCATE ON public.${SPECS} FROM ${quote(roles.runtime)}`);
  // Extensions absent: --inspect reports ABSENT (exit 0); --grant refuses.
  const bare=await clone('cli_bare',{template:bareTemplate});
  const bareEnv={DATABASE_URL:urlOf(bare.name),RUNTIME_DATABASE_URL:urlOf(bare.name,roles.runtime)};
  const absent=await cli(['--inspect'],bareEnv);assert.equal(absent.code,0,absent.stderr);assert.match(absent.stdout,/state=ABSENT; register=ABSENT; comparison=ABSENT;/);clean(absent);
  const refusedRun=await cli(['--grant'],bareEnv);
  assert.equal(refusedRun.code,1);assert.match(refusedRun.stderr,/EXTENSION_NOT_INSTALLED/);assert.equal(refusedRun.stdout,'');clean(refusedRun);
  // The role is never an argument, and exactly one mode is required.
  for(const args of [[],['--grant','--revoke'],['--grant','--grant'],['--grant','--runtime-role=x'],['--runtime-role='+roles.runtime],['--bogus'],['--inspect','--include-execute']]){
    const bad=await cli(args,env);
    assert.equal(bad.code,1,args.join(' '));assert.match(bad.stderr,/^Usage: node scripts\/grant-quant-comparison-runtime\.mjs/);assert.equal(bad.stdout,'');clean(bad);
  }
  await noTargets(db);
});

test('a throw in the post-commit runtime inspection still reports the committed grant, never "no change made", and leaks nothing',{timeout:120000},async()=>{
  const {name,db}=await clone('cli_post_commit');
  await noTargets(db);
  // Without USAGE on the schema the runtime connection cannot call the inspection function: the in-transaction checks (owner side) pass, the runtime inspection throws 42501.
  await db.query(`REVOKE USAGE ON SCHEMA public FROM ${quote(roles.runtime)}`);
  await db.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
  try{
    const env={...process.env,DATABASE_URL:urlOf(name),RUNTIME_DATABASE_URL:urlOf(name,roles.runtime)};
    let out;
    try{out={code:0,...await run(process.execPath,[CLI,'--grant'],{cwd:repoRoot,env})};}
    catch(error){out={code:error.code,stdout:error.stdout,stderr:error.stderr};}
    assert.equal(out.code,1,out.stdout+out.stderr);
    assert.match(out.stderr,/Quant comparison grant committed but the runtime connection inspection failed: DATABASE_ERROR/);
    assert.match(out.stderr,/changed=true; statements=3;.*other_acl_unchanged=true; acl_digest=[0-9a-f]{32}; runtime_connection_ok=false/);
    assert.equal(/no change made/i.test(out.stdout+out.stderr),false);
    assert.equal(out.stdout,'');
    const secrets=[roles.runtime,new URL(process.env.TEST_DATABASE_URL).password,new URL(process.env.TEST_DATABASE_URL).hostname].filter(Boolean);
    for(const secret of secrets)assert.equal((out.stdout+out.stderr).includes(secret),false,'output leaks a connection value');
    await exactTargets(db,roles.runtime);
    assert.equal((await stateOf(db,roles.runtime)).state,'EXACT');
  }finally{await db.query('GRANT USAGE ON SCHEMA public TO PUBLIC');}
});
