import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Offline contract check only: this test never executes the grant script. test/postgres/runtime-grants.test.mjs runs it.
const PROTECTED=['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler','quant_jobs',
  'quant_research_chunks','quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts',
  'quant_storage_namespace','quant_research_executor_mode'];

test('runtime grants: role from the psql variable, one transaction under the maintenance lock, DELETE never granted to PF-2 tables',async()=>{
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
  // The ten PF-2 tables are excluded from DELETE, revoked for history, and checked at the end.
  const list=sql.match(/protected CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/);
  assert.ok(list);assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map(match=>match[1]).sort(),[...PROTECTED].sort());
  assert.doesNotMatch(sql,/ON ALL TABLES[^;]*DELETE|DELETE[^;]*ON ALL TABLES/,'no blanket DELETE grant');
  assert.match(sql,/tablename<>ALL\(protected\) AND tablename<>ALL\(read_only\)/);
  assert.match(sql,/REVOKE DELETE ON TABLE public\.%I FROM %I/);
  assert.match(sql,/has_table_privilege\(runtime_role,format\('public\.%I',item\),'DELETE'\)/);
  // The read-only provenance tables are proven read-only too, and the role is matched by its exact name.
  assert.match(sql,/FOREACH item IN ARRAY read_only LOOP\s+IF to_regclass\(format\('public\.%I',item\)\) IS NOT NULL\s+AND \(has_table_privilege\(runtime_role,format\('public\.%I',item\),'INSERT'\)\s+OR has_table_privilege\(runtime_role,format\('public\.%I',item\),'UPDATE'\)\s+OR has_table_privilege\(runtime_role,format\('public\.%I',item\),'DELETE'\)\) THEN\s+RAISE EXCEPTION/);
  assert.match(sql,/IF NOT EXISTS\(SELECT 1 FROM pg_roles WHERE rolname=runtime_role\) THEN/);
  assert.doesNotMatch(sql,/to_regrole/);
  // The scheduler keeps the table-level UPDATE that LOCK TABLE ... IN EXCLUSIVE MODE needs.
  assert.doesNotMatch(sql,/REVOKE[^;]*(?:UPDATE|ALL)[^;]*quant_foundation_scheduler/i);
  assert.match(sql,/GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO %I/);
});