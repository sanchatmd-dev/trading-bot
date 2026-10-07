import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';

// scripts/grant-postgres-runtime.sql on real PostgreSQL: the runtime role may never DELETE the ten PF-2 quarantine,
// accounting and provenance tables, yet keeps table-level UPDATE, which LOCK TABLE ... IN EXCLUSIVE MODE needs on the
// scheduler during enrollment completion. The script takes its role from the psql variable runtime_role and runs in one
// transaction under the maintenance lock. test/postgres-runtime-grants.test.js checks the same script as text.
const PROTECTED=['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler','quant_jobs',
  'quant_research_chunks','quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts',
  'quant_storage_namespace','quant_research_executor_mode'];
// The same extension schemas, in the same order, as test/helpers/quant-preflight-http-fixture.mjs.
const SCHEMAS=['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
  'quant-research-foundation-schema.sql','quant-storage-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql',
  'quant-preflight-schema.sql','quant-profile-enrollment-schema.sql'];
// What psql -v runtime_role=<role> does for :'runtime_role'.
const withRole=(sql,role)=>sql.replaceAll(":'runtime_role'","'"+role.replaceAll("'","''")+"'");

test('runtime grants: DELETE is refused on the ten PF-2 tables while scheduler UPDATE and its EXCLUSIVE lock remain',
  {skip:process.env.TEST_DATABASE_URL?false:'TEST_DATABASE_URL is required (isolated PostgreSQL only)'},async t=>{
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL}),suffix=randomUUID().replaceAll('-','');
  const name='robot_grants_'+suffix,role='robot_grants_role_'+suffix,idle='robot_grants_idle_'+suffix;
  // A mixed-case role must be found by its exact name, never case-folded.
  const mixed='Robot_Grants_Mixed_'+suffix;
  let db=null;
  t.after(async()=>{
    for(const owned of [role,idle,'"'+mixed+'"'])await db?.query('DROP OWNED BY '+owned).catch(()=>{});
    await db?.close();await admin.query('DROP DATABASE IF EXISTS '+name);
    for(const dropped of [role,idle,'"'+mixed+'"'])await admin.query('DROP ROLE IF EXISTS '+dropped);await admin.close();
  });
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  for(const file of SCHEMAS)await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  for(const created of [role,idle,'"'+mixed+'"'])await admin.query('CREATE ROLE '+created+' NOSUPERUSER NOCREATEDB NOCREATEROLE');
  const script=await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8');
  // Each application runs on its own connection, as psql does; a failed one leaves nothing behind.
  const apply=async sql=>{
    const client=new pg.Client({connectionString:url.toString()});await client.connect();
    try{await client.query(sql);}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{await client.end();}
  };
  const privilege=async(who,table,kind)=>(await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[who,'public.'+table,kind])).rows[0].ok;
  // PUBLIC keeps USAGE on schema public by default, so a table grant shows whether the script ran for a role.
  const usage=async who=>privilege(who,'sessions','SELECT');

  // Fail closed before any change: no role variable, an unknown role, or a running API or worker.
  await assert.rejects(apply(script),{code:'42601'});
  await assert.rejects(apply(withRole(script,'robot_grants_missing_'+suffix)),/does not exist/);
  const runtime=new pg.Client({connectionString:url.toString()});await runtime.connect();
  try{
    assert.equal((await runtime.query("SELECT pg_try_advisory_lock_shared(hashtextextended('robot:maintenance',0)) AS ok")).rows[0].ok,true);
    const started=Date.now();
    await assert.rejects(apply(withRole(script,idle)),/Stop every PostgreSQL API and worker before maintenance/);
    assert.ok(Date.now()-started<10000,'the lock is tried, never waited for');
  }finally{await runtime.end();}
  assert.equal(await usage(idle),false,'a refused run changed nothing');
  // A write privilege on a read-only table that the role holds through PUBLIC survives the role's own REVOKE; the
  // final check refuses to commit.
  await db.query('GRANT INSERT ON schema_version TO PUBLIC');
  try{await assert.rejects(apply(withRole(script,idle)),/can still write to schema_version/);}
  finally{await db.query('REVOKE INSERT ON schema_version FROM PUBLIC');}
  assert.equal(await usage(idle),false,'the refused run changed nothing');
  await apply(withRole(script,mixed));
  assert.equal(await usage(mixed),true,'the mixed-case role was granted under its exact name');
  assert.equal(await privilege(mixed,'quant_foundation_jobs','DELETE'),false);

  // History an older script leaves: DELETE on every table. The script removes it, and a second run changes nothing.
  await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO '+role);
  assert.equal(await privilege(role,'quant_foundation_jobs','DELETE'),true);
  await apply(withRole(script,role));await apply(withRole(script,role));
  for(const table of PROTECTED){
    assert.ok((await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name,table+' is installed');
    await assert.rejects(db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('DELETE FROM '+table);}),{code:'42501'},table);
    assert.equal(await privilege(role,table,'DELETE'),false,table);
    assert.equal(await privilege(role,table,'SELECT'),true,table);
  }
  assert.equal(await privilege(role,'quant_foundation_scheduler','UPDATE'),true);
  await db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE');});
  // Read-only provenance stays read-only; elsewhere the runtime keeps DELETE (sessions).
  for(const table of ['schema_version','pine_bridge_schema','pine_bridge_evidence','pine_market_bars'])
    for(const kind of ['INSERT','UPDATE','DELETE'])assert.equal(await privilege(role,table,kind),false,table+' '+kind);
  for(const table of ['sessions','auth_challenges','password_resets','security_mail','mfa_recovery','user_security',
    'worker_heartbeats','security_limits'])assert.equal(await privilege(role,table,'DELETE'),true,table+' keeps the runtime DELETE');
  assert.equal(await usage(idle),false,'only the named role was granted');
});