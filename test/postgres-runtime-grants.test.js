import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Offline contract check only: this test never executes the grant script.
test('runtime grants durably revoke DELETE on the PF-2 packet tables while retaining table UPDATE',async()=>{
 const sql=(await readFile(new URL('../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replace(/--[^\n]*/g,'');
 const block=sql.match(/FOREACH protected_table IN ARRAY ARRAY\[([\s\S]*?)\] LOOP([\s\S]*?)END LOOP;/);
 assert.ok(block,'the DELETE revoke follows the general grants and tolerates optional tables');
 const expected=['quant_foundation_jobs','quant_foundation_owners','quant_foundation_scheduler','quant_jobs',
  'quant_research_chunks','quant_io_ledgers','quant_io_launches','quant_profile_enrollment_receipts',
  'quant_storage_namespace','quant_research_executor_mode'];
 const tables=[...block[1].matchAll(/'([^']+)'/g)].map(match=>match[1]);
 assert.deepEqual(tables.sort(),expected.sort());
 assert.match(block[2],/IF to_regclass\(format\('public\.%I',protected_table\)\) IS NOT NULL THEN/);
 assert.match(block[2],/EXECUTE format\('REVOKE DELETE ON TABLE public\.%I FROM robot_app',protected_table\);/);
 const grant='GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO robot_app;';
 assert.ok(sql.indexOf(grant)>=0&&sql.indexOf(grant)<block.index);
 assert.doesNotMatch(sql.slice(block.index+block[0].length),/GRANT\s+[^;]*DELETE/i);
 // These revokes affect schema/provenance tables only. Scheduler keeps its table-level UPDATE needed by LOCK TABLE.
 const schedulerRevokes=[...sql.matchAll(/REVOKE\s+([^;]+?)\s+ON\s+([^;]+?)\s+FROM\s+robot_app;/gi)]
  .filter(match=>/quant_foundation_scheduler/.test(match[2]));
 assert.ok(schedulerRevokes.every(match=>!/(UPDATE|ALL)/i.test(match[1])));
});
