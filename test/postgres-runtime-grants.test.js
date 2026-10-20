import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Offline contract check only: this test never executes the grant script. test/postgres/runtime-grants.test.mjs runs it.
const PROTECTED=['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler','quant_jobs',
  'quant_research_chunks','quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts',
  'quant_storage_namespace','quant_research_executor_mode','quant_exposure_register'];
// F09 builder slice S2: the ten insert-only Best Inputs record tables. The runtime keeps SELECT and INSERT and loses UPDATE and DELETE.
const INSERT_ONLY=['bi_exports','bi_package_files','bi_blobs','bi_status_events','bi_attempts','bi_compile_records','bi_evidence_records',
  'bi_clearances','bi_trace_reproductions','ql4c_validation'];

test('runtime grants: role from the psql variable, one transaction under the maintenance lock, DELETE never granted to the protected tables',async()=>{
  const raw=await readFile(new URL('../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8');
  const sql=raw.replace(/--[^\n]*/g,'');
  // The role comes only from the required psql variable: no hard-coded role, no default.
  assert.doesNotMatch(raw,/robot_app/);
  assert.equal(sql.split(":'runtime_role'").length-1,1);
  assert.match(sql,/SELECT set_config\('robot\.runtime_role',:'runtime_role',true\)/);
  assert.doesNotMatch(sql,/\\(?:set|if)\b/,'no psql default for the role');
  // One transaction; the maintenance lock is taken first and never waits.
  const statements=sql.trim();
  assert.match(statements,/^BEGIN;/);assert.match(statements,/COMMIT;$/);
  assert.equal(sql.split('COMMIT;').length-1,1);
  const lock=sql.indexOf("pg_try_advisory_xact_lock(hashtextextended('robot:maintenance',0))");
  assert.ok(lock>0);
  assert.doesNotMatch(sql,/pg_advisory_(?:xact_)?lock\(/,'a blocking lock could wait for ever');
  assert.ok(lock<sql.search(/\bGRANT\b/)&&lock<sql.search(/\bREVOKE\b/),'the lock precedes every grant and revoke');
  // The eleven protected tables are excluded from DELETE, revoked for history, and checked at the end.
  const list=sql.match(/protected CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/);
  assert.ok(list);assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map(match=>match[1]).sort(),[...PROTECTED].sort());
  const readOnly=sql.match(/read_only CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/);
  assert.ok(readOnly);assert.ok([...readOnly[1].matchAll(/'([^']+)'/g)].map(match=>match[1]).includes('quant_exposure_register_schema'),'the register marker is read-only');
  assert.ok([...readOnly[1].matchAll(/'([^']+)'/g)].map(match=>match[1]).includes('bi_package_schema'),'the Best Inputs package marker is read-only');
  // The insert-only list: exactly the ten record tables, excluded from the DELETE loop, revoked UPDATE, DELETE, TRUNCATE and TRIGGER, and checked at the end.
  const insertOnly=sql.match(/insert_only CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/);
  assert.ok(insertOnly);assert.deepEqual([...insertOnly[1].matchAll(/'([^']+)'/g)].map(match=>match[1]).sort(),[...INSERT_ONLY].sort());
  assert.ok(![...insertOnly[1].matchAll(/'([^']+)'/g)].map(match=>match[1]).includes('bi_package_schema'),'the marker is read-only, not insert-only');
  assert.match(sql,/FOREACH item IN ARRAY insert_only LOOP\s+IF to_regclass\(format\('public\.%I',item\)\) IS NOT NULL THEN\s+EXECUTE format\('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON TABLE public\.%I FROM %I',item,runtime_role\);/);
  // The final check also covers every role the runtime role can reach by membership (INHERIT FALSE and NOINHERIT included).
  assert.ok(sql.includes("EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(runtime_role,r.oid,'MEMBER')"),'the insert-only check reaches every role the runtime role can SET ROLE to');
  for(const kind of ['UPDATE','DELETE','TRUNCATE','TRIGGER'])assert.ok(sql.includes("has_table_privilege(r.oid,format('public.%I',item),'"+kind+"')"),kind);
  // UPDATE also counts on a single column (has_table_privilege does not see a column grant).
  assert.ok(sql.includes("has_any_column_privilege(r.oid,format('public.%I',item),'UPDATE')"),'a column UPDATE grant of a reached role counts');
  assert.match(sql,/Runtime role % can still edit or remove rows of %/);assert.match(sql,/Runtime role % lacks SELECT or INSERT on %/);
  assert.ok(sql.indexOf('REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER')>sql.indexOf('GRANT SELECT,INSERT,UPDATE ON ALL TABLES'),'the revoke follows the blanket grant');
  assert.doesNotMatch(sql,/ON ALL TABLES[^;]*DELETE|DELETE[^;]*ON ALL TABLES/,'no blanket DELETE grant');
  assert.match(sql,/tablename<>ALL\(protected\) AND tablename<>ALL\(read_only\) AND tablename<>ALL\(insert_only\)/);
  assert.match(sql,/REVOKE DELETE ON TABLE public\.%I FROM %I/);
  assert.match(sql,/has_table_privilege\(runtime_role,format\('public\.%I',item\),'DELETE'\)/);
  // The read-only provenance tables are proven read-only too, and the role is matched by its exact name.
  // The read-only final check reaches PUBLIC and every role the runtime role can SET ROLE to (INHERIT FALSE and NOINHERIT included), and counts a column INSERT or UPDATE.
  const readOnlyStart=sql.indexOf('FOREACH item IN ARRAY read_only LOOP',sql.indexOf('FOREACH item IN ARRAY read_only LOOP')+1);
  const readOnlyCheck=sql.slice(readOnlyStart,sql.indexOf("RAISE EXCEPTION 'Runtime role % can still write to %'"));
  assert.ok(readOnlyStart>0&&readOnlyCheck.length>0,'the read-only final check is present');
  assert.ok(readOnlyCheck.includes("EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(runtime_role,r.oid,'MEMBER')"),'the read-only check reaches every role the runtime role can SET ROLE to');
  for(const kind of ['INSERT','UPDATE'])assert.ok(readOnlyCheck.includes("has_any_column_privilege(r.oid,format('public.%I',item),'"+kind+"')"),'a column '+kind+' grant of a reached role counts');
  for(const kind of ['INSERT','UPDATE','DELETE'])assert.ok(readOnlyCheck.includes("has_table_privilege(r.oid,format('public.%I',item),'"+kind+"')"),'table '+kind);
  assert.doesNotMatch(readOnlyCheck,/has_table_privilege\(runtime_role/,'the read-only check does not judge the runtime role alone');
  assert.match(sql,/Runtime role % can still write to %/);
  assert.match(sql,/IF NOT EXISTS\(SELECT 1 FROM pg_roles WHERE rolname=runtime_role\) THEN/);
  assert.doesNotMatch(sql,/to_regrole/);
  // The scheduler keeps the table-level UPDATE that LOCK TABLE ... IN EXCLUSIVE MODE needs.
  assert.doesNotMatch(sql,/REVOKE[^;]*(?:UPDATE|ALL)[^;]*quant_foundation_scheduler/i);
  assert.match(sql,/GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO %I/);
});