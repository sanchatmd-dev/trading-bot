import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {TEMP_PRIVILEGE_NOT_OWNER,TEMP_PRIVILEGE_REFUSED,TEMP_PRIVILEGE_SESSIONS_ACTIVE,TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE,inspectTempPrivilege,restoreTempPrivilege,revokeTempPrivilege,runtimeRoleHasTemp} from '../../src/postgres/temp-privilege.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

// Owner decision C2 (prepared, NOT applied anywhere): REVOKE TEMPORARY ON DATABASE FROM PUBLIC. Proven on a throwaway PostgreSQL cluster as a
// real non-owner LOGIN role with the repo grants. Every row is a LABELLED FIXTURE. The tool and the readiness helper are not wired into any
// startup path (checked below).
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const BLOCKED='P0001:Foundation I/O launch unresolved';
let admin,db,rt,databaseName,roleName,groupName,connectionString,runtimeUrl;
const databases=[],sessions=[],extraRoles=[],extraPools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
async function session(){const client=new pg.Client({connectionString:runtimeUrl});await client.connect();sessions.push(client);return client;}
const read=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const codeOf=promise=>promise.then(()=>null,error=>error.code);
const errorOf=promise=>promise.then(()=>assert.fail('expected a refusal'),error=>error);
// The shared fixture database always has other sessions (the test pools, the old-session probes), so its revoke and restore calls opt in to
// the unsafe override; the fresh-database tests below prove the default refusal and the override.
const LIVE={allowActiveSessions:true};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  databaseName='robot_temp_test_'+suffix;roleName='robot_temp_role_'+suffix.slice(0,16);groupName='robot_temp_group_'+suffix.slice(0,16);
  await admin.query('CREATE DATABASE '+databaseName);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  connectionString=urlOf(databaseName);runtimeUrl=urlOf(databaseName,roleName);
  db=new PostgresDatabase({connectionString,max:6});await db.migrate();
  for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await db.query(await read(name));
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  // The repo grant script, with the throwaway role: broad DML, no ownership, TEMP left at the PUBLIC default. The ORIGINAL release guard stays installed.
  await db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+roleName+"'"));
  rt=new PostgresDatabase({connectionString:runtimeUrl,max:2});
});
after(async()=>{
  for(const client of sessions)await client.end().catch(()=>{});
  for(const pool of extraPools)await pool.close().catch(()=>{});
  await rt?.close().catch(()=>{});await db?.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  if(admin){
    await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');
    for(const name of extraRoles)await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName);await admin.query('DROP ROLE IF EXISTS '+groupName);await admin.close();
  }
});

// ---- the release-guard shadow attack (finding GH1-IO-RELEASE), one representative case against the ORIGINAL guard ---------------------------
const reset=()=>db.query('TRUNCATE public.quant_io_launches,public.quant_io_ledgers,public.quant_foundation_jobs CASCADE');
async function runningJobWithSpawnedLaunch(){
  await reset();
  const id=randomUUID(),token=randomUUID(),contract={version:'quant-foundation-v2',kind:'PROFILE'};
  await db.query("INSERT INTO public.quant_foundation_owners(owner_id) VALUES('temp-fixture') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at,lease_token,lease_until)
    VALUES($1,'temp-fixture',$2,$3,$4,'RUNNING',1,900001,$5,900000)`,[id,randomUUID(),JSON.stringify(contract),hash(canonical(contract)),token]);
  const state={job_id:id,policy_hash:hash('temp-policy'),lease_token:token,revision:0,operations:[{status:'ACTIVE'}]};
  await db.query('INSERT INTO public.quant_io_ledgers VALUES($1,$2,$3,0,$4,$5)',[id,state.policy_hash,token,JSON.stringify(state),hash(canonical(state))]);
  await db.query('INSERT INTO public.quant_io_launches VALUES($1,$2,$3,$4,$5,$6,1)',[id,'temp-operation',token,'temp-'+id+'.service',hash('temp-payload'),'SPAWNED']);
  return id;
}
const PAUSE="UPDATE public.quant_foundation_jobs SET status='PAUSED',lease_token=NULL,lease_until=NULL WHERE job_id=$1";
const SHADOWS={
  none:[],
  tempTables:['CREATE TEMP TABLE quant_io_launches(job_id uuid,state text)','CREATE TEMP TABLE quant_io_ledgers(job_id uuid,state jsonb)'],
  tempTablesPathFirst:['CREATE TEMP TABLE quant_io_launches(job_id uuid,state text)','CREATE TEMP TABLE quant_io_ledgers(job_id uuid,state jsonb)','SET LOCAL search_path = pg_temp, public'],
  tempViews:['CREATE TEMP VIEW quant_io_launches AS SELECT NULL::uuid job_id,NULL::text state WHERE false','CREATE TEMP VIEW quant_io_ledgers AS SELECT NULL::uuid job_id,NULL::jsonb state WHERE false']};
/** The pause under a shadow in a transaction that is always rolled back; resolves to 'ok' or 'SQLSTATE:message'. */
async function attempt(client,shadow,id){
  await client.query('BEGIN');
  try{for(const statement of shadow)await client.query(statement);await client.query(PAUSE,[id]);return 'ok';}
  catch(error){return error.code+':'+error.message;}
  finally{await client.query('ROLLBACK');}
}
async function outcomes(id){
  const out={};
  for(const [name,shadow] of Object.entries(SHADOWS)){const client=await session();try{out[name]=await attempt(client,shadow,id);}finally{sessions.splice(sessions.indexOf(client),1);await client.end();}}
  return out;
}

let originalDatacl,revoked;

test('setup: PUBLIC holds TEMP, the runtime role is a non-owner, and the helper agrees with has_database_privilege',async()=>{
  const report=await inspectTempPrivilege(db,{runtimeRole:roleName});
  originalDatacl=report.datacl;
  assert.equal(report.public_has_temp,true);assert.equal(report.runtime_role.exists,true);assert.equal(report.runtime_role.superuser,false);assert.equal(report.runtime_role.owner,false);
  assert.equal(report.runtime_role.effective_temp,true);assert.equal(report.runtime_role.direct_temp_grant,false);assert.equal(report.temp_closed_for_runtime_role,false);
  assert.equal(report.connected_as,report.owner);assert.equal(report.database,databaseName);
  assert.equal(await runtimeRoleHasTemp(rt),true,'a readiness check running as the runtime role asks about itself');
  assert.equal(await runtimeRoleHasTemp(db,{role:roleName}),true);
  await assert.rejects(runtimeRoleHasTemp(db,{role:'robot_no_such_role'}),{code:'42704'});
  // Inspect is read only and works as the runtime role (no write privilege needed) and inside a READ ONLY transaction.
  assert.deepEqual((await inspectTempPrivilege(rt,{runtimeRole:roleName})).runtime_role.effective_temp,true);
  const client=await session();
  try{
    await client.query('BEGIN READ ONLY');
    assert.equal((await inspectTempPrivilege({query:(sql,params)=>client.query(sql,params)},{runtimeRole:roleName})).public_has_temp,true);
    await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});}
  await assert.rejects(inspectTempPrivilege(db,{runtimeRole:'Bad-Role'}),{code:TEMP_PRIVILEGE_REFUSED});
  const missing=await inspectTempPrivilege(db,{runtimeRole:'robot_no_such_role'});
  assert.equal(missing.runtime_role.exists,false);assert.equal(missing.temp_closed_for_runtime_role,null);
});

test('inspect shows a live runtime session that holds a temp schema, and nothing once that session has ended',async()=>{
  const none=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(none.runtime_role_holds_temp_schema,false);
  const client=await session();
  await client.query('CREATE TEMP TABLE temp_probe(id int)');
  const held=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(held.runtime_role_holds_temp_schema,true);assert.ok(held.live_temp_schemas.some(item=>item.owner===roleName&&item.relations>=1),JSON.stringify(held.live_temp_schemas));
  assert.ok(held.runtime_role.live_sessions>=1);
  sessions.splice(sessions.indexOf(client),1);await client.end();
  let after;
  for(let i=0;i<100;i++){after=await inspectTempPrivilege(db,{runtimeRole:roleName});if(!after.runtime_role_holds_temp_schema)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(after.runtime_role_holds_temp_schema,false,'temp objects are dropped with their session');
});

test('control: while PUBLIC holds TEMP, a TEMP shadow of the ORIGINAL release guard releases a job that has an unresolved launch',async()=>{
  const id=await runningJobWithSpawnedLaunch();
  const result=await outcomes(id);
  assert.equal(result.none,BLOCKED,'the original guard blocks the release');
  for(const name of ['tempTables','tempTablesPathFirst','tempViews'])assert.equal(result[name],'ok',name+': the shadow hides the launch and the release passes');
  assert.equal((await db.query('SELECT status FROM public.quant_foundation_jobs WHERE job_id=$1',[id])).rows[0].status,'RUNNING','every attempt was rolled back');
});

test('a non-owner is refused: revoke and restore through the runtime role change nothing',async()=>{
  const before=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(await codeOf(revokeTempPrivilege(rt,{runtimeRole:roleName})),TEMP_PRIVILEGE_NOT_OWNER);
  assert.equal(await codeOf(restoreTempPrivilege(rt,{runtimeRole:roleName})),TEMP_PRIVILEGE_NOT_OWNER);
  assert.equal((await inspectTempPrivilege(db,{runtimeRole:roleName})).datacl,before.datacl);
});

test('the runtime role is refused when TEMP cannot be taken from it: a superuser or the owner, a missing role, or TEMP inherited from a group role',async()=>{
  const before=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(await codeOf(revokeTempPrivilege(db,{runtimeRole:before.owner})),TEMP_PRIVILEGE_REFUSED,'the owner (here also a superuser)');
  assert.equal(await codeOf(revokeTempPrivilege(db,{runtimeRole:'robot_no_such_role'})),TEMP_PRIVILEGE_REFUSED);
  await admin.query('CREATE ROLE '+groupName+' NOLOGIN');
  await db.query('GRANT TEMPORARY ON DATABASE '+databaseName+' TO '+groupName);await db.query('GRANT '+groupName+' TO '+roleName);
  try{
    assert.equal(await codeOf(revokeTempPrivilege(db,{runtimeRole:roleName,...LIVE})),TEMP_PRIVILEGE_REFUSED,'TEMP still effective through the group role');
    const after=await inspectTempPrivilege(db,{runtimeRole:roleName});
    assert.equal(after.public_has_temp,true,'the PUBLIC revoke inside the refused transaction was rolled back');
    assert.deepEqual(after.direct_temp_grantees,[groupName]);
  }finally{
    await db.query('REVOKE '+groupName+' FROM '+roleName);await db.query('REVOKE TEMPORARY ON DATABASE '+databaseName+' FROM '+groupName);
  }
  // A grant followed by a revoke turns a NULL datacl into the equivalent explicit list, so compare the meaning, not the text.
  const cleaned=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.deepEqual([cleaned.public_has_temp,cleaned.direct_temp_grantees,cleaned.runtime_role.effective_temp],[before.public_has_temp,before.direct_temp_grantees,before.runtime_role.effective_temp],'cleanup left the privileges as they were');
});

test('revoke: PUBLIC loses TEMP, the runtime role cannot create a TEMP object, and every TEMP shadow of the release guard is refused with 42501',async()=>{
  const id=await runningJobWithSpawnedLaunch();
  const before=await inspectTempPrivilege(db,{runtimeRole:roleName});
  // A session that already created its temp objects BEFORE the revoke keeps them; the revoke only stops new ones.
  const old=await session();await old.query('CREATE TEMP TABLE quant_io_launches(job_id uuid,state text)');
  revoked=await revokeTempPrivilege(db,{runtimeRole:roleName,...LIVE});
  assert.equal(revoked.active_sessions_override,true);assert.ok(revoked.sessions_at_check.total>=1);assert.match(revoked.writers_note,/Stop every application writer/);
  assert.equal(revoked.changed,true);assert.deepEqual(revoked.statements,['REVOKE TEMPORARY ON DATABASE '+databaseName+' FROM PUBLIC']);
  assert.equal(revoked.previous_datacl,before.datacl);assert.notEqual(revoked.datacl,before.datacl);
  assert.equal(revoked.temp_closed_for_runtime_role,true);assert.match(revoked.note,/Live sessions may still hold temp objects/);
  const after=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(after.public_has_temp,false);assert.equal(after.runtime_role.effective_temp,false);assert.equal(after.temp_closed_for_runtime_role,true);
  assert.equal(await runtimeRoleHasTemp(rt),false);assert.equal(await runtimeRoleHasTemp(db,{role:roleName}),false);
  assert.equal(after.runtime_role_holds_temp_schema,true,'the old session still holds its temp schema');
  // A NEW runtime session cannot create a temp table, view or function.
  const fresh=await session();
  for(const statement of ['CREATE TEMP TABLE temp_probe(id int)','CREATE TEMP VIEW temp_view AS SELECT 1 AS id','CREATE TEMP SEQUENCE temp_seq','CREATE FUNCTION pg_temp.temp_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE TEMP TABLE temp_probe AS SELECT 1 AS id','SELECT 1 AS id INTO TEMP temp_into'])
    assert.equal(await codeOf(fresh.query(statement)),'42501',statement);
  // The shadows of the release guard can no longer be set up: creation fails before the release statement runs.
  const result=await outcomes(id);
  assert.equal(result.none,BLOCKED,'normal behavior is unchanged');
  for(const name of ['tempTables','tempTablesPathFirst','tempViews'])assert.ok(result[name].startsWith('42501:'),name+': '+result[name]);
  // Still, a live session that created the shadow earlier can use it: a revoke is followed by a restart of the runtime sessions.
  await old.query('BEGIN');
  try{
    await old.query('CREATE TEMP TABLE quant_io_launches2(job_id uuid)').then(()=>assert.fail('unexpected'),error=>assert.equal(error.code,'42501'));
  }finally{await old.query('ROLLBACK');}
  assert.equal((await old.query('SELECT count(*)::int n FROM quant_io_launches')).rows[0].n,0,'the pre-revoke temp table still shadows in that session');
  sessions.splice(sessions.indexOf(old),1);await old.end();
  // Idempotent.
  const again=await revokeTempPrivilege(db,{runtimeRole:roleName,...LIVE});
  assert.equal(again.changed,false);assert.deepEqual(again.statements,[]);assert.equal(again.previous_datacl,revoked.datacl);assert.equal(again.datacl,revoked.datacl);
});

test('with TEMP revoked the application paths still work: DML as the runtime role, a rolled-back transaction, a prepared statement and the maintenance lock',async()=>{
  const id=await runningJobWithSpawnedLaunch();
  const client=await session();
  assert.equal(await attempt(client,[],id),BLOCKED);
  await client.query("UPDATE public.quant_foundation_jobs SET diagnostic='temp-closed' WHERE job_id=$1",[id]);
  assert.equal((await rt.query('SELECT diagnostic FROM public.quant_foundation_jobs WHERE job_id=$1',[id])).rows[0].diagnostic,'temp-closed');
  assert.equal((await rt.transaction(()=>rt.query('SELECT count(*)::int n FROM public.quant_io_launches'))).rows[0].n,1);
  // Sorts and hashes that spill use temp FILES, which do not need the TEMPORARY privilege.
  assert.equal((await rt.query("SELECT count(*)::int n FROM (SELECT g FROM generate_series(1,200000) g ORDER BY md5(g::text)) s")).rows[0].n,200000);
});

test('restore: PUBLIC gets TEMP back, the previous ACL is printed, the byte-identical restore is documented as not guaranteed, and the shadow control works again',async()=>{
  const id=await runningJobWithSpawnedLaunch();
  const closed=await inspectTempPrivilege(db,{runtimeRole:roleName});
  const restored=await restoreTempPrivilege(db,{runtimeRole:roleName,...LIVE});
  assert.equal(restored.action,'restore');assert.equal(restored.changed,true);assert.equal(restored.previous_datacl,closed.datacl);assert.equal(restored.public_has_temp,true);
  assert.match(restored.note,/Byte-identical datacl restore is not guaranteed/);
  assert.equal(await runtimeRoleHasTemp(rt),true);
  const fresh=await session();await fresh.query('CREATE TEMP TABLE temp_probe(id int)');
  const result=await outcomes(id);
  for(const name of ['tempTables','tempTablesPathFirst','tempViews'])assert.equal(result[name],'ok',name+': the bypass is possible again after the restore');
  // Report (not assert) how close the ACL text is: a database created with a NULL datacl ends with an explicit list.
  process.stderr.write('datacl original='+JSON.stringify(originalDatacl)+' revoked='+JSON.stringify(revoked.datacl)+' restored='+JSON.stringify(restored.datacl)+'\n');
  assert.match(restored.datacl,/^\{=[A-Za-z]*T[A-Za-z]*\//,'PUBLIC entry carries T');
  const second=await restoreTempPrivilege(db,{runtimeRole:roleName,...LIVE});
  assert.equal(second.changed,false);assert.equal(second.datacl,restored.datacl);
});

test('a TEMP grant made directly to the runtime role is revoked as well, and the restore does not grant it again',async()=>{
  await db.query('GRANT TEMPORARY ON DATABASE '+databaseName+' TO '+roleName);
  const before=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(before.runtime_role.direct_temp_grant,true);
  const result=await revokeTempPrivilege(db,{runtimeRole:roleName,...LIVE});
  assert.deepEqual(result.statements,['REVOKE TEMPORARY ON DATABASE '+databaseName+' FROM PUBLIC','REVOKE TEMPORARY ON DATABASE '+databaseName+' FROM '+roleName]);
  const after=await inspectTempPrivilege(db,{runtimeRole:roleName});
  assert.equal(after.runtime_role.effective_temp,false);assert.equal(after.runtime_role.direct_temp_grant,false);
  await restoreTempPrivilege(db,{runtimeRole:roleName,...LIVE});
  assert.equal((await inspectTempPrivilege(db,{runtimeRole:roleName})).runtime_role.direct_temp_grant,false,'only the PUBLIC default is restored');
});

test('the CLI inspects, revokes and restores on the throwaway database, and refuses bad arguments and a non-owner',async()=>{
  const script='scripts/postgres-temp-privilege.mjs';
  const cli=async(url,...args)=>JSON.parse((await run(process.execPath,[script,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}})).stdout);
  const withRole='--runtime-role='+roleName;
  assert.equal((await cli(connectionString,'--inspect',withRole)).public_has_temp,true);
  assert.equal((await cli(runtimeUrl,'--inspect',withRole)).runtime_role.effective_temp,true,'inspect works as the runtime role');
  const revokedByCli=await cli(connectionString,'--revoke',withRole,'--allow-active-sessions');
  assert.equal(revokedByCli.changed,true);assert.ok(revokedByCli.previous_datacl);
  assert.equal((await cli(connectionString,'--inspect',withRole)).temp_closed_for_runtime_role,true);
  await assert.rejects(run(process.execPath,[script,'--revoke',withRole],{cwd:repoRoot,env:{...process.env,DATABASE_URL:runtimeUrl}}),error=>error.code===1&&error.stderr.includes(TEMP_PRIVILEGE_NOT_OWNER));
  const restoredByCli=await cli(connectionString,'--restore',withRole,'--allow-active-sessions');
  assert.equal(restoredByCli.public_has_temp,true);assert.match(restoredByCli.note,/not guaranteed/);
  // The default runtime role (robot_app) does not exist here: inspect reports that, revoke refuses.
  assert.equal((await cli(connectionString,'--inspect')).runtime_role.exists,false);
  await assert.rejects(run(process.execPath,[script,'--revoke'],{cwd:repoRoot,env:{...process.env,DATABASE_URL:connectionString}}),error=>error.stderr.includes(TEMP_PRIVILEGE_REFUSED));
  assert.equal((await inspectTempPrivilege(db,{runtimeRole:roleName})).public_has_temp,true,'the refused revoke changed nothing');
  // A usage error is one line on stderr, exit code 1, and no stack trace.
  for(const args of [[],['--inspect','--revoke'],['--other'],['--inspect','--inspect'],['--revoke','--runtime-role=Bad-Name'],['--inspect',withRole,withRole],
    ['--inspect','--allow-active-sessions'],['--restore','--allow-temp-role=robot_x'],['--revoke','--allow-temp-role=Bad-Name'],['--revoke','--allow-active-sessions','--allow-active-sessions']])
    await assert.rejects(run(process.execPath,[script,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:connectionString}}),
      error=>error.code===1&&/^Usage: /.test(error.stderr)&&error.stderr.trim().split(/\r?\n/).length===1&&!/\n\s+at /.test(error.stderr)&&!/Error:/.test(error.stderr)&&error.stdout==='',JSON.stringify(args));
});

// ---- RT2: every login role (K16) and active sessions (K17), each on its own fresh database so no fixture pool is a "foreign" session ------
const reportOf=report=>JSON.stringify(report.login_roles);
async function freshDatabase(label,ownerRole=null){
  const name='robot_temp_'+label+'_'+randomUUID().replaceAll('-','');databases.push(name);
  await admin.query('CREATE DATABASE '+name+(ownerRole?' OWNER '+ownerRole:''));
  // One connection only: the tool's own pid is the only session of the caller.
  const owner=new PostgresDatabase({connectionString:urlOf(name,ownerRole),max:1});extraPools.push(owner);
  return {name,owner};
}
async function freshRole(label,options='LOGIN NOSUPERUSER'){
  const role='robot_temp_'+label+'_'+randomUUID().replaceAll('-','').slice(0,12);extraRoles.push(role);
  await admin.query('CREATE ROLE '+role+' '+options+rolePasswordClause());return role;
}
async function liveClient(name,role){
  const client=new pg.Client({connectionString:urlOf(name,role)});await client.connect();sessions.push(client);return client;
}
async function endClient(client){sessions.splice(sessions.indexOf(client),1);await client.end();}
async function waitForNoSessions(owner,runtimeRole){
  let report;
  for(let i=0;i<200;i++){report=await inspectTempPrivilege(owner,{runtimeRole});if(report.other_sessions.total===0)return report;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.fail('sessions did not end: '+JSON.stringify(report.other_sessions));
}

test('K16: inspect reports every login role; revoke is refused and rolled back while another login role keeps TEMP, and --allow-temp-role accepts only the named role',async()=>{
  const {name,owner}=await freshDatabase('k16');
  const runtime=await freshRole('rt'),direct=await freshRole('direct'),member=await freshRole('member'),noconnect=await freshRole('noconn');
  const group=await freshRole('grp','NOLOGIN');
  const isSuper=(await owner.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper;
  const superRole=isSuper?await freshRole('super','LOGIN SUPERUSER'):null;
  // Only the intended roles may connect, so a login role without CONNECT is not counted even though it holds a direct TEMP grant.
  await owner.query('REVOKE CONNECT ON DATABASE '+name+' FROM PUBLIC');
  for(const role of [runtime,direct,member])await owner.query('GRANT CONNECT ON DATABASE '+name+' TO '+role);
  await owner.query('GRANT TEMPORARY ON DATABASE '+name+' TO '+direct);await owner.query('GRANT TEMPORARY ON DATABASE '+name+' TO '+noconnect);
  await owner.query('GRANT TEMPORARY ON DATABASE '+name+' TO '+group);await owner.query('GRANT '+group+' TO '+member);
  const before=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.deepEqual(before.login_roles.map(item=>item.name),[direct,member,runtime].sort(),'not the owner, a superuser, a NOLOGIN role or a role without CONNECT: '+reportOf(before));
  const byName=Object.fromEntries(before.login_roles.map(item=>[item.name,item]));
  assert.equal(byName[direct].direct_temp_grant,true);assert.equal(byName[member].direct_temp_grant,false);assert.equal(byName[member].effective_temp,true,'inherited through the group role');
  assert.equal(byName[runtime].effective_temp,true,'through PUBLIC');assert.equal(before.all_login_roles_closed,false);
  assert.deepEqual(before.login_roles_with_temp,[direct,member,runtime].sort());
  assert.equal(before.other_sessions.total,0);
  if(superRole)assert.ok(!before.login_roles.some(item=>item.name===superRole));
  // Refused, and the PUBLIC revoke inside the refused transaction was rolled back.
  const refused=await errorOf(revokeTempPrivilege(owner,{runtimeRole:runtime}));
  assert.equal(refused.code,TEMP_PRIVILEGE_REFUSED);assert.deepEqual(refused.roles,[direct,member].sort());
  assert.ok(refused.message.includes(direct+' (direct grant)')&&refused.message.includes(member+' (inherited)'),refused.message);
  const afterRefusal=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(afterRefusal.public_has_temp,true);assert.equal(afterRefusal.datacl,before.datacl);assert.equal(afterRefusal.runtime_role.effective_temp,true);
  // Listing one role is not enough, the unlisted one is still named; a role that does not exist, or the runtime role, cannot be listed.
  const partial=await errorOf(revokeTempPrivilege(owner,{runtimeRole:runtime,allowTempRoles:[direct]}));
  assert.equal(partial.code,TEMP_PRIVILEGE_REFUSED);assert.deepEqual(partial.roles,[member]);
  assert.equal(await codeOf(revokeTempPrivilege(owner,{runtimeRole:runtime,allowTempRoles:[direct,member,'robot_no_such_role']})),TEMP_PRIVILEGE_REFUSED);
  assert.equal(await codeOf(revokeTempPrivilege(owner,{runtimeRole:runtime,allowTempRoles:[direct,member,runtime]})),TEMP_PRIVILEGE_REFUSED);
  assert.equal(await codeOf(revokeTempPrivilege(owner,{runtimeRole:runtime,allowTempRoles:['Bad-Name']})),TEMP_PRIVILEGE_REFUSED);
  assert.equal((await inspectTempPrivilege(owner,{runtimeRole:runtime})).datacl,before.datacl,'every refusal changed nothing');
  // Both exceptions listed: the revoke succeeds with the default session policy (no other session exists) and reports them.
  const done=await revokeTempPrivilege(owner,{runtimeRole:runtime,allowTempRoles:[direct,member,direct]});
  assert.equal(done.changed,true);assert.deepEqual(done.statements,['REVOKE TEMPORARY ON DATABASE '+name+' FROM PUBLIC']);
  assert.deepEqual(done.allowed_temp_roles,[direct,member].sort());assert.deepEqual(done.login_roles_checked,[direct,member,runtime].sort());
  assert.equal(done.active_sessions_override,false);assert.equal(done.sessions_at_check.total,0);assert.match(done.writers_note,/does not take the application maintenance lock/);
  const after=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(after.public_has_temp,false);assert.equal(after.runtime_role.effective_temp,false);assert.deepEqual(after.login_roles_with_temp,[direct,member].sort());assert.equal(after.all_login_roles_closed,false);
  // With the group membership and the direct grant removed, a plain revoke needs no allow list and the report is clean.
  await owner.query('REVOKE '+group+' FROM '+member);await owner.query('REVOKE TEMPORARY ON DATABASE '+name+' FROM '+direct);
  const clean=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(clean.all_login_roles_closed,true);assert.deepEqual(clean.login_roles_with_temp,[]);
  assert.equal((await revokeTempPrivilege(owner,{runtimeRole:runtime})).changed,false,'already closed: idempotent, nothing to allow');
});

test('K17: revoke and restore are refused with counts by role while another session is connected, and --allow-active-sessions overrides that',async()=>{
  const {name,owner}=await freshDatabase('k17');
  const runtime=await freshRole('rt'),other=await freshRole('other');
  const clients=[await liveClient(name,runtime),await liveClient(name,runtime),await liveClient(name,other)];
  const before=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(before.other_sessions.total,3);assert.deepEqual(before.other_sessions.by_role,[{role:other,count:1},{role:runtime,count:2}].sort((a,b)=>a.role<b.role?-1:1));
  assert.equal(before.runtime_role.live_sessions,2);
  const refused=await errorOf(revokeTempPrivilege(owner,{runtimeRole:runtime}));
  assert.equal(refused.code,TEMP_PRIVILEGE_SESSIONS_ACTIVE);assert.equal(refused.sessions.total,3);assert.deepEqual(refused.sessions.by_role,before.other_sessions.by_role);
  assert.ok(refused.message.includes(runtime+'=2')&&refused.message.includes(other+'=1')&&refused.message.includes('--allow-active-sessions'),refused.message);
  const refusedRestore=await errorOf(restoreTempPrivilege(owner,{runtimeRole:runtime}));
  assert.equal(refusedRestore.code,TEMP_PRIVILEGE_SESSIONS_ACTIVE);assert.equal(refusedRestore.sessions.total,3);
  assert.equal((await inspectTempPrivilege(owner,{runtimeRole:runtime})).datacl,before.datacl,'both refusals changed nothing');
  // The unsafe override works and records what it overrode.
  const forced=await revokeTempPrivilege(owner,{runtimeRole:runtime,allowActiveSessions:true});
  assert.equal(forced.changed,true);assert.equal(forced.active_sessions_override,true);assert.equal(forced.sessions_at_check.total,3);assert.match(forced.writers_note,/Stop every application writer/);
  assert.equal((await inspectTempPrivilege(owner,{runtimeRole:runtime})).public_has_temp,false);
  // A session that ends stops counting: after all sessions end, restore needs no override.
  for(const client of clients)await endClient(client);
  await waitForNoSessions(owner,runtime);
  const restored=await restoreTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(restored.changed,true);assert.equal(restored.public_has_temp,true);assert.equal(restored.active_sessions_override,false);assert.equal(restored.sessions_at_check.total,0);
  // One session again: restore is refused until overridden, and the override restores.
  const again=await liveClient(name,other);
  await revokeTempPrivilege(owner,{runtimeRole:runtime,allowActiveSessions:true});
  assert.equal(await codeOf(restoreTempPrivilege(owner,{runtimeRole:runtime})),TEMP_PRIVILEGE_SESSIONS_ACTIVE);
  assert.equal((await restoreTempPrivilege(owner,{runtimeRole:runtime,allowActiveSessions:true})).public_has_temp,true);
  await endClient(again);
});

test('K17 visibility: a non-superuser owner without pg_read_all_stats cannot count sessions and is refused as unverifiable; with pg_read_all_stats the sessions are counted',async()=>{
  const ownerRole=await freshRole('nsowner'),runtime=await freshRole('rt');
  const {name,owner}=await freshDatabase('k17v',ownerRole);
  const client=await liveClient(name,runtime);
  const blind=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(blind.connected_as,ownerRole);assert.equal(blind.owner,ownerRole);
  // Other roles' rows carry only backend_type for this caller, so the database filter alone would see nothing: the report must say so.
  assert.equal(blind.sessions_verifiable,false);assert.equal(blind.other_sessions.visibility,'LIMITED');assert.equal(blind.other_sessions.verifiable,false);
  assert.ok(blind.other_sessions.unattributed>=1,JSON.stringify(blind.other_sessions));
  assert.equal(blind.runtime_role.live_sessions,null);assert.ok(blind.login_roles.every(item=>item.live_sessions===null));
  const before=blind.datacl;
  const refused=await errorOf(revokeTempPrivilege(owner,{runtimeRole:runtime}));
  assert.equal(refused.code,TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE);assert.match(refused.message,/pg_read_all_stats/);assert.equal(refused.sessions.verifiable,false);
  assert.equal(await codeOf(restoreTempPrivilege(owner,{runtimeRole:runtime})),TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE);
  assert.equal((await inspectTempPrivilege(owner,{runtimeRole:runtime})).datacl,before,'both refusals changed nothing');
  // The unsafe override still works and records that the sessions could not be verified.
  const forced=await revokeTempPrivilege(owner,{runtimeRole:runtime,allowActiveSessions:true});
  assert.equal(forced.changed,true);assert.equal(forced.active_sessions_override,true);assert.equal(forced.sessions_verifiable,false);
  assert.equal((await restoreTempPrivilege(owner,{runtimeRole:runtime,allowActiveSessions:true})).public_has_temp,true);
  // With pg_read_all_stats the same caller sees the session and the refusal is the normal one, with counts.
  await admin.query('GRANT pg_read_all_stats TO '+ownerRole);
  const seen=await inspectTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(seen.other_sessions.visibility,'FULL');assert.equal(seen.sessions_verifiable,true);assert.equal(seen.other_sessions.unattributed,0);
  assert.equal(seen.other_sessions.total,1);assert.deepEqual(seen.other_sessions.by_role,[{role:runtime,count:1}]);assert.equal(seen.runtime_role.live_sessions,1);
  const active=await errorOf(revokeTempPrivilege(owner,{runtimeRole:runtime}));
  assert.equal(active.code,TEMP_PRIVILEGE_SESSIONS_ACTIVE);assert.deepEqual(active.sessions.by_role,[{role:runtime,count:1}]);
  await endClient(client);await waitForNoSessions(owner,runtime);
  const done=await revokeTempPrivilege(owner,{runtimeRole:runtime});
  assert.equal(done.changed,true);assert.equal(done.active_sessions_override,false);assert.equal(done.sessions_verifiable,true);
});

test('K16 and K17 through the CLI: one-line refusals, the exception list and the unsafe override',async()=>{
  const {name}=await freshDatabase('cli');
  const runtime=await freshRole('rt'),extra=await freshRole('extra');
  const url=urlOf(name),script='scripts/postgres-temp-privilege.mjs';
  const exec=(...args)=>run(process.execPath,[script,...args],{cwd:repoRoot,env:{...process.env,DATABASE_URL:url}});
  const failure=async(...args)=>{const error=await errorOf(exec(...args));assert.equal(error.code,1);assert.equal(error.stdout,'');assert.equal(error.stderr.trim().split(/\r?\n/).length,1,error.stderr);assert.doesNotMatch(error.stderr,/\n\s+at /);return error.stderr;};
  const withRole='--runtime-role='+runtime;
  // The grant goes through the admin connection (another database), so no fixture connection of this test is a foreign session of the CLI.
  await admin.query('GRANT TEMPORARY ON DATABASE '+name+' TO '+extra);
  // K16: the extra role keeps TEMP, so the CLI refuses with one line naming it.
  const refusedRoles=await failure('--revoke',withRole);
  assert.ok(refusedRoles.startsWith(TEMP_PRIVILEGE_REFUSED+': ')&&refusedRoles.includes(extra),refusedRoles);
  const inspected=JSON.parse((await exec('--inspect',withRole)).stdout);
  // Other LOGIN roles of the cluster (fixture roles of this file) can connect through PUBLIC too, so only membership is asserted.
  assert.ok(inspected.login_roles_with_temp.includes(extra)&&inspected.login_roles_with_temp.includes(runtime),inspected.login_roles_with_temp.join());assert.equal(inspected.public_has_temp,true);
  // K17: a connected session blocks both mutating modes with one line; the override works. The CLI's own connection is not counted.
  const client=await liveClient(name,extra);
  const refusedSessions=await failure('--revoke',withRole,'--allow-temp-role='+extra);
  assert.ok(refusedSessions.startsWith(TEMP_PRIVILEGE_SESSIONS_ACTIVE+': ')&&refusedSessions.includes(extra+'=1'),refusedSessions);
  assert.ok((await failure('--restore',withRole)).startsWith(TEMP_PRIVILEGE_SESSIONS_ACTIVE+': '));
  assert.equal(JSON.parse((await exec('--inspect',withRole)).stdout).other_sessions.total,1);
  const forced=JSON.parse((await exec('--revoke',withRole,'--allow-temp-role='+extra,'--allow-active-sessions')).stdout);
  assert.equal(forced.changed,true);assert.equal(forced.active_sessions_override,true);assert.deepEqual(forced.allowed_temp_roles,[extra]);
  await endClient(client);
  for(let i=0;i<200&&JSON.parse((await exec('--inspect',withRole)).stdout).other_sessions.total>0;i++)await new Promise(resolve=>setTimeout(resolve,50));
  const restored=JSON.parse((await exec('--restore',withRole)).stdout);
  assert.equal(restored.public_has_temp,true);assert.equal(restored.active_sessions_override,false);
});

test('nothing wires the privilege tool into a startup, migration or readiness path yet',async()=>{
  const importers=[];
  for(const folder of ['src','scripts','tools']){
    const names=await fs.readdir(new URL('../../'+folder+'/',import.meta.url),{recursive:true}).catch(()=>[]);
    for(const name of names.filter(item=>/\.(m?js|cjs|ts)$/.test(item))){
      const posix=name.split(path.sep).join('/');
      const text=await fs.readFile(new URL('../../'+folder+'/'+posix,import.meta.url),'utf8').catch(()=>'');
      if(text.includes('temp-privilege'))importers.push(folder+'/'+posix);
    }
  }
  assert.deepEqual(importers,['scripts/postgres-temp-privilege.mjs']);
});

// ---- the application suites with TEMP revoked (opt-in: the two suites take minutes) ------------------------------------------------------
// A canary event trigger makes ANY temp object created in a test database fail, even for a superuser (who always holds TEMP), so a
// suite that passes proves no path of it creates one. The preload revokes TEMP from PUBLIC and installs the canary right after each
// CREATE DATABASE; no suite file is edited.
const CANARY=`CREATE SCHEMA rt_canary;
GRANT USAGE ON SCHEMA rt_canary TO PUBLIC;
CREATE FUNCTION rt_canary.no_temp() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT object_type,object_identity FROM pg_event_trigger_ddl_commands() WHERE schema_name='pg_temp' LOOP
    RAISE EXCEPTION 'TEMP_OBJECT_CREATED: % %',r.object_type,r.object_identity USING ERRCODE='42501';
  END LOOP;
END $$;
CREATE EVENT TRIGGER rt_canary_no_temp ON ddl_command_end EXECUTE FUNCTION rt_canary.no_temp();`;

test('the canary refuses a temp object even for a superuser, and a table in a normal schema is not affected',async()=>{
  const name='robot_temp_canary_'+randomUUID().replaceAll('-','');databases.push(name);
  await admin.query('CREATE DATABASE '+name);
  const local=new PostgresDatabase({connectionString:urlOf(name)});
  try{
    await local.query(CANARY);
    for(const statement of ['CREATE TEMP TABLE canary_probe(id int)','CREATE TEMP VIEW canary_view AS SELECT 1 AS id','CREATE TEMP TABLE canary_as AS SELECT 1 AS id','SELECT 1 AS id INTO TEMP canary_into'])
      await assert.rejects(local.query(statement),{code:'42501',message:/TEMP_OBJECT_CREATED/},statement);
    await local.query('CREATE TABLE public.canary_ok(id int)');await local.query('DROP TABLE public.canary_ok');
  }finally{await local.close();}
});

const appSuites=['test/postgres/quant-research-http.test.mjs','test/postgres/quant-preflight-http.test.mjs'];
const preloadOf=()=>`import {PostgresDatabase} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../src/postgres/db.js',import.meta.url))).href)};
const canary=${JSON.stringify(CANARY)};
let applied=0;const original=PostgresDatabase.prototype.query;
PostgresDatabase.prototype.query=async function(sql,params){
  const result=await original.call(this,sql,params);
  const match=typeof sql==='string'?/^\\s*CREATE DATABASE\\s+([a-z0-9_]+)/i.exec(sql):null;
  if(match){
    await original.call(this,'REVOKE TEMPORARY ON DATABASE '+match[1]+' FROM PUBLIC');
    const url=new URL(this.pool.options.connectionString);url.pathname='/'+match[1];
    const pool=new this.pool.constructor({connectionString:url.toString(),max:1});
    try{await pool.query(canary);}finally{await pool.end();}
    applied++;
  }
  return result;
};
process.on('exit',()=>process.stderr.write('TEMP_REVOKED_DATABASES='+applied+'\\n'));`;
for(const file of appSuites)
  test('application suite with TEMP revoked from PUBLIC and the temp canary installed: '+file,{timeout:1800000,skip:process.env.TEMP_PRIVILEGE_APP_SUITES!=='1'&&'set TEMP_PRIVILEGE_APP_SUITES=1 to run (takes minutes)'},async()=>{
    let result;
    try{
      // The child is its own test run: inheriting NODE_TEST_CONTEXT would make it a subtest of this run and print nothing it can be parsed from.
      const env={...process.env,TEST_DATABASE_URL:process.env.TEST_DATABASE_URL};delete env.NODE_TEST_CONTEXT;
      result=await run(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preloadOf()),'--test','--test-isolation=none','--test-reporter=spec',file],
        {cwd:repoRoot,env,maxBuffer:64*1024*1024});
    }catch(error){result={stdout:error.stdout||'',stderr:error.stderr||'',failed:true};}
    const text=result.stdout+result.stderr,count=name=>Number((new RegExp('ℹ '+name+' (\\d+)').exec(text)||[])[1]);
    const applied=Number((/TEMP_REVOKED_DATABASES=(\d+)/.exec(text)||[])[1]);
    assert.ok(applied>=1,'TEMP was revoked and the canary installed in the suite databases ('+applied+')');
    assert.equal(count('fail'),0,text.slice(-3000));assert.equal(!!result.failed,false);assert.ok(count('pass')>0);
    assert.doesNotMatch(text,/TEMP_OBJECT_CREATED/);
    process.stderr.write('TEMP revoked '+file+': pass='+count('pass')+' fail='+count('fail')+' skipped='+count('skipped')+' databases='+applied+'\n');
  });
