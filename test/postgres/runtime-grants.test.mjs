import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';

// scripts/grant-postgres-runtime.sql on real PostgreSQL: the runtime role may never DELETE the eleven protected quarantine,
// accounting and provenance tables, yet keeps table-level UPDATE, which LOCK TABLE ... IN EXCLUSIVE MODE needs on the
// scheduler during enrollment completion. The script takes its role from the psql variable runtime_role and runs in one
// transaction under the maintenance lock. test/postgres-runtime-grants.test.js checks the same script as text.
const PROTECTED=['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler','quant_jobs',
  'quant_research_chunks','quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts',
  'quant_storage_namespace','quant_research_executor_mode','quant_exposure_register'];
// The same extension schemas, in the same order, as test/helpers/quant-preflight-http-fixture.mjs, plus
// quant-exposure-register.sql (the PROTECTED loop asserts every protected table is installed) and best-inputs-package-schema.sql (F09 builder slice S2).
const SCHEMAS=['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
  'quant-research-foundation-schema.sql','quant-storage-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql',
  'quant-preflight-schema.sql','quant-profile-enrollment-schema.sql','quant-exposure-register.sql','best-inputs-package-schema.sql',
  'quant-comparison.sql','quant-selection.sql','mp-member-set.sql','mp-run-store.sql','paper-capital-model.sql'];
// The ten insert-only Best Inputs record tables: SELECT and INSERT stay, UPDATE, DELETE, TRUNCATE and TRIGGER never; the marker is read-only.
const INSERT_ONLY=['bi_exports','bi_package_files','bi_blobs','bi_status_events','bi_attempts','bi_compile_records','bi_evidence_records',
  'bi_clearances','bi_trace_reproductions','ql4c_validation'];
// The record tables of the QR-3 comparison, QR-4 selection (first four tables in slice S2-1) and F11 member set extensions: the same insert-only rule.
// The quant-comparison.sql install adds the seven QR-3 S2c tables (S2c-1 and S2c-2) and the quant-selection.sql install the eight QR-4 S2 tables (S2-1 and S2-2).
const EXTENSION_INSERT_ONLY=['quant_comparison_specs','quant_comparison_participants','quant_comparison_status_events','quant_comparison_evaluations','quant_comparison_benchmarks',
  'quant_comparison_outcomes','quant_comparison_replay_events',
  'quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events',
  'quant_selection_window_freezes','quant_selection_evaluation_starts','quant_selection_outcomes','quant_selection_replay_events',
  'mp_member_sets','mp_member_set_members','paper_capital_models'];
const EXTENSION_MARKERS=['quant_comparison_schema','quant_selection_schema','mp_member_set_schema','paper_capital_model_schema'];
// The internal multi-Pine run store (F11-01 RS-1): the runtime role holds no privilege of any kind, whatever history left behind.
const INTERNAL_ONLY=['mp_run_store_schema','mp_research_runs','mp_research_run_events'];
// What psql -v runtime_role=<role> does for :'runtime_role'.
const withRole=(sql,role)=>sql.replaceAll(":'runtime_role'","'"+role.replaceAll("'","''")+"'");

test('runtime grants: DELETE is refused on the eleven protected tables while scheduler UPDATE and its EXCLUSIVE lock remain',
  {skip:process.env.TEST_DATABASE_URL?false:'TEST_DATABASE_URL is required (isolated PostgreSQL only)'},async t=>{
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL}),suffix=randomUUID().replaceAll('-','');
  const name='robot_grants_'+suffix,role='robot_grants_role_'+suffix,idle='robot_grants_idle_'+suffix;
  // A mixed-case role must be found by its exact name, never case-folded.
  const mixed='Robot_Grants_Mixed_'+suffix;
  // Roles for the reachable-privilege proof: a holder of TRIGGER, a NOINHERIT member of it and (PostgreSQL 16 and later) a member WITH INHERIT FALSE.
  const holder='robot_grants_holder_'+suffix,member='robot_grants_member_'+suffix,memberFalse='robot_grants_memberf_'+suffix;
  // The same for a column-level UPDATE grant, which has_table_privilege does not see: a NOINHERIT member, a member WITH INHERIT FALSE and a PUBLIC grant.
  const colHolder='robot_grants_colh_'+suffix,colMember='robot_grants_colm_'+suffix,colMemberFalse='robot_grants_colmf_'+suffix,colPublic='robot_grants_colp_'+suffix;
  // The same for the read-only marker bi_package_schema: a PUBLIC column INSERT, and a column UPDATE held by a role reached WITH INHERIT FALSE.
  const roPublic='robot_grants_rop_'+suffix,roHolder='robot_grants_roh_'+suffix,roMemberFalse='robot_grants_romf_'+suffix;
  // The same for the internal-only run store tables: a PUBLIC SELECT, and a column SELECT held by a NOINHERIT member's role.
  const intPublic='robot_grants_intp_'+suffix,intHolder='robot_grants_inth_'+suffix,intMember='robot_grants_intm_'+suffix;
  let db=null;
  t.after(async()=>{
    for(const owned of [role,idle,'"'+mixed+'"',holder,member,memberFalse,colHolder,colMember,colMemberFalse,colPublic,roPublic,roHolder,roMemberFalse,intPublic,intHolder,intMember])await db?.query('DROP OWNED BY '+owned).catch(()=>{});
    await db?.close();await admin.query('DROP DATABASE IF EXISTS '+name);
    for(const dropped of [role,idle,'"'+mixed+'"',member,memberFalse,holder,colMember,colMemberFalse,colPublic,colHolder,roMemberFalse,roPublic,roHolder,intMember,intPublic,intHolder])await admin.query('DROP ROLE IF EXISTS '+dropped);await admin.close();
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
  for(const table of ['schema_version','pine_bridge_schema','pine_bridge_evidence','pine_market_bars','quant_exposure_register_schema','bi_package_schema',...EXTENSION_MARKERS])
    for(const kind of ['INSERT','UPDATE','DELETE'])assert.equal(await privilege(role,table,kind),false,table+' '+kind);
  // Insert-only Best Inputs record tables: SELECT and INSERT stay, nothing that edits or removes a row, whatever history left behind.
  for(const table of [...INSERT_ONLY,...EXTENSION_INSERT_ONLY]){
    assert.ok((await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name,table+' is installed');
    for(const kind of ['SELECT','INSERT'])assert.equal(await privilege(role,table,kind),true,table+' '+kind);
    for(const kind of ['UPDATE','DELETE','TRUNCATE','TRIGGER'])assert.equal(await privilege(role,table,kind),false,table+' '+kind);
    await assert.rejects(db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('DELETE FROM '+table);}),{code:'42501'},table);
  }
  for(const marker of ['bi_package_schema',...EXTENSION_MARKERS])assert.equal(await privilege(role,marker,'SELECT'),true,marker+' stays readable');
  // Internal-only run store tables: no privilege of any kind (the history above granted SELECT, INSERT, UPDATE and DELETE on every table), and 42501 on access.
  for(const table of INTERNAL_ONLY){
    assert.ok((await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name,table+' is installed');
    for(const kind of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES'])assert.equal(await privilege(role,table,kind),false,table+' '+kind);
    await assert.rejects(db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('SELECT 1 FROM '+table);}),{code:'42501'},table);
  }
  for(const table of ['sessions','auth_challenges','password_resets','security_mail','mfa_recovery','user_security',
    'worker_heartbeats','security_limits'])assert.equal(await privilege(role,table,'DELETE'),true,table+' keeps the runtime DELETE');
  // A privilege held through a role the runtime role reaches by membership but does not inherit is still refused: SET ROLE reaches it, while
  // has_table_privilege(runtime role, ...) alone says false.
  await admin.query('CREATE ROLE '+holder+' NOLOGIN');await admin.query('CREATE ROLE '+member+' NOSUPERUSER NOINHERIT');
  await db.query('GRANT TRIGGER ON TABLE bi_exports TO '+holder);await db.query('GRANT '+holder+' TO '+member);
  assert.equal(await privilege(member,'bi_exports','TRIGGER'),false,'the NOINHERIT member does not inherit the privilege');
  await assert.rejects(apply(withRole(script,member)),/can still edit or remove rows of bi_exports/);
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=160000){
    await admin.query('CREATE ROLE '+memberFalse+' NOSUPERUSER INHERIT');await db.query('GRANT '+holder+' TO '+memberFalse+' WITH INHERIT FALSE');
    await assert.rejects(apply(withRole(script,memberFalse)),/can still edit or remove rows of bi_exports/);
  }
  assert.equal(await usage(member),false,'the refused runs changed nothing');
  await db.query('REVOKE TRIGGER ON TABLE bi_exports FROM '+holder);
  await apply(withRole(script,member));
  assert.equal(await usage(member),true,'without the reachable privilege the same role is granted');
  assert.equal(await usage(idle),false,'only the named role was granted');
  // A column-level UPDATE grant: has_table_privilege is false, has_any_column_privilege is true, and the final check refuses to commit.
  await admin.query('CREATE ROLE '+colHolder+' NOLOGIN');await admin.query('CREATE ROLE '+colMember+' NOSUPERUSER NOINHERIT');
  await db.query('GRANT UPDATE (codes) ON TABLE bi_attempts TO '+colHolder);await db.query('GRANT '+colHolder+' TO '+colMember);
  assert.equal(await privilege(colMember,'bi_attempts','UPDATE'),false,'the table-level check does not see the column grant');
  assert.equal((await db.query("SELECT has_any_column_privilege($1,'public.bi_attempts','UPDATE') AS ok",[colHolder])).rows[0].ok,true);
  await assert.rejects(apply(withRole(script,colMember)),/can still edit or remove rows of bi_attempts/);
  if(version>=160000){
    await admin.query('CREATE ROLE '+colMemberFalse+' NOSUPERUSER INHERIT');await db.query('GRANT '+colHolder+' TO '+colMemberFalse+' WITH INHERIT FALSE');
    await assert.rejects(apply(withRole(script,colMemberFalse)),/can still edit or remove rows of bi_attempts/);
  }
  await admin.query('CREATE ROLE '+colPublic+' NOSUPERUSER');
  await db.query('GRANT UPDATE (mode) ON TABLE bi_exports TO PUBLIC');
  try{await assert.rejects(apply(withRole(script,colPublic)),/can still edit or remove rows of bi_exports/);}
  finally{await db.query('REVOKE UPDATE (mode) ON TABLE bi_exports FROM PUBLIC');}
  assert.equal(await usage(colMember),false,'the refused runs changed nothing');
  await db.query('REVOKE UPDATE (codes) ON TABLE bi_attempts FROM '+colHolder);
  await apply(withRole(script,colMember));
  assert.equal(await usage(colMember),true,'without the column grant the same role is granted');
  // Read-only marker: a column INSERT held through PUBLIC, and a column UPDATE of a role reached WITH INHERIT FALSE, are write paths that
  // has_table_privilege(runtime role, ...) does not see; the final check refuses to commit.
  await admin.query('CREATE ROLE '+roPublic+' NOSUPERUSER');
  await db.query('GRANT INSERT (version) ON TABLE bi_package_schema TO PUBLIC');
  try{
    assert.equal(await privilege(roPublic,'bi_package_schema','INSERT'),false,'the table-level check does not see the column grant');
    await assert.rejects(apply(withRole(script,roPublic)),/can still write to bi_package_schema/);
  }finally{await db.query('REVOKE INSERT (version) ON TABLE bi_package_schema FROM PUBLIC');}
  assert.equal(await usage(roPublic),false,'the refused run changed nothing');
  await apply(withRole(script,roPublic));
  assert.equal(await usage(roPublic),true,'without the PUBLIC column grant the same role is granted');
  if(version>=160000){
    await admin.query('CREATE ROLE '+roHolder+' NOLOGIN');await db.query('GRANT UPDATE (version) ON TABLE bi_package_schema TO '+roHolder);
    await admin.query('CREATE ROLE '+roMemberFalse+' NOSUPERUSER INHERIT');await db.query('GRANT '+roHolder+' TO '+roMemberFalse+' WITH INHERIT FALSE');
    assert.equal(await privilege(roMemberFalse,'bi_package_schema','UPDATE'),false,'the WITH INHERIT FALSE member does not inherit the privilege');
    await assert.rejects(apply(withRole(script,roMemberFalse)),/can still write to bi_package_schema/);
    assert.equal(await usage(roMemberFalse),false,'the refused run changed nothing');
    await db.query('REVOKE UPDATE (version) ON TABLE bi_package_schema FROM '+roHolder);
    await apply(withRole(script,roMemberFalse));
    assert.equal(await usage(roMemberFalse),true,'without the column grant the same role is granted');
  }
  // Internal-only run store: a PUBLIC SELECT, and a column SELECT of a role the runtime role reaches by membership without inheriting it, are refused by the final check.
  await admin.query('CREATE ROLE '+intPublic+' NOSUPERUSER');
  await db.query('GRANT SELECT ON TABLE mp_research_runs TO PUBLIC');
  try{await assert.rejects(apply(withRole(script,intPublic)),/can still reach internal table mp_research_runs/);}
  finally{await db.query('REVOKE SELECT ON TABLE mp_research_runs FROM PUBLIC');}
  assert.equal(await usage(intPublic),false,'the refused run changed nothing');
  await apply(withRole(script,intPublic));
  assert.equal(await usage(intPublic),true,'without the PUBLIC grant the same role is granted');
  await admin.query('CREATE ROLE '+intHolder+' NOLOGIN');await admin.query('CREATE ROLE '+intMember+' NOSUPERUSER NOINHERIT');
  await db.query('GRANT SELECT (run_id) ON TABLE mp_research_runs TO '+intHolder);await db.query('GRANT '+intHolder+' TO '+intMember);
  assert.equal(await privilege(intMember,'mp_research_runs','SELECT'),false,'the NOINHERIT member does not inherit the privilege');
  await assert.rejects(apply(withRole(script,intMember)),/can still reach internal table mp_research_runs/);
  assert.equal(await usage(intMember),false,'the refused run changed nothing');
  await db.query('REVOKE SELECT (run_id) ON TABLE mp_research_runs FROM '+intHolder);
  await apply(withRole(script,intMember));
  assert.equal(await usage(intMember),true,'without the reachable privilege the same role is granted');
});