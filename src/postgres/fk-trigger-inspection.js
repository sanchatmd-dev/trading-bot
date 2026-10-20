/**
 * Shared check of the internal referential-integrity (RI) triggers of the foreign keys of an offline extension table. Read only.
 *
 * A foreign key is two things: the constraint row (which pg_get_constraintdef deparses) and the internal triggers that enforce it. A superuser
 * can disable or drop those triggers (DISABLE TRIGGER ALL, or ALTER TABLE ... DISABLE TRIGGER <name> on an internal trigger) and the constraint
 * text stays intact but is no longer enforced. So the extension classifiers compare the triggers too. For each named foreign key constraint
 * of one table the expected triggers are derived from its pg_constraint row, never from a fixed list, exactly as a fresh PostgreSQL 16 install
 * creates them for a NO ACTION key:
 *   on the referencing table  RI_FKey_check_ins (tgtype 5) and RI_FKey_check_upd (17);
 *   on the referenced table   RI_FKey_noaction_del (9) and RI_FKey_noaction_upd (17).
 * tgtype bits: ROW 1, INSERT 4, DELETE 8, UPDATE 16, all AFTER. Each trigger must be internal, enabled (tgenabled 'O'), a pg_catalog function, have
 * no arguments, no column list and no WHEN clause, and its deferrable and initially-deferred flags must equal those of the constraint. A key
 * whose triggers are not exactly that set, or that no longer exists, is returned by name; a caller reports it as
 * TABLE_DEFINITION:<table>:FOREIGN_KEY_TRIGGERS. A key that references itself (the same table on both sides) is handled the same way.
 *
 * Fail closed on the referenced table: the check covers both sides of a key. A referenced base table (users, quant_jobs, pine_deployments, an
 * earlier extension table) whose RI trigger for the extension key is disabled or missing makes the extension classify OTHER, although the
 * extension did not touch that table. That is deliberate: the extension stores insert-only evidence and relies on the referenced row to stay
 * while the evidence exists. With that trigger off, a delete or key update of the referenced row would succeed and leave orphaned evidence, and the
 * extension could no longer say that its foreign key holds. The classifier cannot repair the table (it never writes to a table it does not
 * own), so it refuses loudly: OTHER blocks install and rollback and fails the inspection until the owner re-enables the trigger. Only the
 * triggers that belong to the extension's own keys are judged; RI triggers of other extensions' keys on the same table are not looked at.
 */
const EXPECTED=Object.freeze([['conrelid','RI_FKey_check_ins',5],['conrelid','RI_FKey_check_upd',17],['confrelid','RI_FKey_noaction_del',9],['confrelid','RI_FKey_noaction_upd',17]]);

/** The sorted relation|function|tgtype items a foreign key constraint row needs, as a fresh install creates them. */
export function expectedForeignKeyTriggers(constraint){
  return EXPECTED.map(([side,fn,tgtype])=>[constraint[side],fn,tgtype].join('|')).sort();
}

const ROWS=`SELECT k.conname,k.conrelid,k.confrelid,k.condeferrable,k.condeferred,
  t.tgrelid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred,t.tgnargs,t.tgattr::text AS columns,
  t.tgqual IS NOT NULL AS has_qual
  FROM pg_catalog.pg_constraint k LEFT JOIN pg_catalog.pg_trigger t ON t.tgconstraint=k.oid
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE k.contype='f' AND k.conrelid=$1 AND k.conname=ANY($2) ORDER BY k.conname,t.tgname`;

/**
 * Names of the foreign key constraints (of the table with oid relationOid, among constraintNames) whose internal RI triggers are not exactly the
 * expected set. An empty list means every named key is enforced. A name that has no foreign key constraint on the table is returned too.
 */
export async function foreignKeyTriggerFailures(db,relationOid,constraintNames){
  if(!constraintNames.length)return [];
  const rows=(await db.query(ROWS,[relationOid,constraintNames])).rows;
  const failed=[];
  for(const name of constraintNames){
    const own=rows.filter(row=>row.conname===name);
    if(!own.length){failed.push(name);continue;}
    const triggers=own.filter(row=>row.tgrelid!==null);
    const found=triggers.map(row=>[row.tgrelid,row.proname,row.tgtype].join('|')).sort(),wanted=expectedForeignKeyTriggers(own[0]);
    if(found.length!==wanted.length||found.some((item,index)=>item!==wanted[index])
      ||triggers.some(row=>!row.tgisinternal||row.tgenabled!=='O'||row.function_schema!=='pg_catalog'||row.tgdeferrable!==row.condeferrable||row.tginitdeferred!==row.condeferred
        ||row.tgnargs!==0||row.columns!==''||row.has_qual))failed.push(name);
  }
  return failed;
}
