import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';

// scripts/grant-postgres-runtime.sql on real PostgreSQL: the runtime role may never DELETE the ten PF-2 quarantine,
// accounting and provenance tables, yet keeps table-level UPDATE, which LOCK TABLE ... IN EXCLUSIVE MODE needs on the
// scheduler during enrollment completion. test/postgres-runtime-grants.test.js checks the same script as text.
const PROTECTED=['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler','quant_jobs',
  'quant_research_chunks','quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts',
  'quant_storage_namespace','quant_research_executor_mode'];
// The same extension schemas, in the same order, as test/helpers/quant-preflight-http-fixture.mjs.
const SCHEMAS=['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
  'quant-research-foundation-schema.sql','quant-storage-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql',
  'quant-preflight-schema.sql','quant-profile-enrollment-schema.sql'];

test('runtime grants: DELETE is refused on the ten PF-2 tables while scheduler UPDATE and its EXCLUSIVE lock remain',
  {skip:process.env.TEST_DATABASE_URL?false:'TEST_DATABASE_URL is required (isolated PostgreSQL only)'},async t=>{
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL}),suffix=randomUUID().replaceAll('-','');
  const name='robot_grants_'+suffix,role='robot_grants_role_'+suffix;
  let db=null;
  t.after(async()=>{
    await db?.query('DROP OWNED BY '+role).catch(()=>{});await db?.close();
    await admin.query('DROP DATABASE IF EXISTS '+name);await admin.query('DROP ROLE IF EXISTS '+role);await admin.close();
  });
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  for(const file of SCHEMAS)await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await admin.query('CREATE ROLE '+role+' NOSUPERUSER NOCREATEDB NOCREATEROLE');
  const grants=(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',role);
  await db.query(grants);
  const privilege=async(table,kind)=>(await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,'public.'+table,kind])).rows[0].ok;
  for(const table of PROTECTED){
    assert.ok((await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name,table+' is installed');
    await assert.rejects(db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('DELETE FROM '+table);}),{code:'42501'},table);
    assert.equal(await privilege(table,'DELETE'),false,table);
    assert.equal(await privilege(table,'SELECT'),true,table);
  }
  assert.equal(await privilege('quant_foundation_scheduler','UPDATE'),true);
  await db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE');});
  // Control: the general runtime grant still allows DELETE elsewhere, so the refusals above are the targeted revoke.
  assert.equal(await privilege('sessions','DELETE'),true);
});