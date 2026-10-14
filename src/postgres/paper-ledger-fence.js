/**
 * F4 Paper ledger fence table (design FD1-r2, slice S3: packaging only; the call sites that write it are a later slice).
 *
 * public.paper_ledger_fence holds one version counter per Bot. Core db.migrate() creates it through ensurePaperLedgerFence() at the end
 * of every successful path, in the migrate transaction, with no schema version bump: schema_version stays 14 and verifySchema() is
 * unchanged. Old code never reads the table, so rolling back code needs no database step.
 *
 * Classify first. ABSENT: no relation of that name. INSTALLED: exactly the table below (pg_catalog types, default collation),
 * permanent, not partitioned or inherited, no RLS, rules, user triggers or extra indexes, every trigger (the internal foreign key
 * triggers included) enabled, fillfactor=50 (so version updates stay HOT), owner and table ACL equal to those of public.paper_funding.
 * OTHER: anything else; ensure and rollback refuse it and leave it untouched.
 *
 * The runtime startup check (requirePaperLedgerFence) is deliberately weaker than the inspector: it ignores owner, ACL, reloptions and
 * extra indexes that cannot reject a write (not unique, partial, exclusion or expression), and instead asks whether the connected role
 * can SELECT, INSERT and UPDATE the table, so a later benign DBA change (a grant, an index, an autovacuum setting) cannot block a
 * restart. Its contract is the throw: a returned report can still read OTHER, so callers never branch on report.ok.
 */
export const FENCE_TABLE='paper_ledger_fence';
export const PAPER_LEDGER_FENCE_ABSENT='PAPER_LEDGER_FENCE_ABSENT';
export const PAPER_LEDGER_FENCE_OTHER='PAPER_LEDGER_FENCE_OTHER';
export const PAPER_LEDGER_FENCE_PRIVILEGE='PAPER_LEDGER_FENCE_PRIVILEGE';
export const PAPER_LEDGER_FENCE_REPLICATION_ROLE='PAPER_LEDGER_FENCE_REPLICATION_ROLE';
export const PAPER_LEDGER_FENCE_VERIFY_FAILED='PAPER_LEDGER_FENCE_VERIFY_FAILED';
export const PAPER_LEDGER_FENCE_TRANSACTION_REQUIRED='PAPER_LEDGER_FENCE_TRANSACTION_REQUIRED';
export const FENCE_OWNER_MISMATCH='FENCE_OWNER_MISMATCH';
// Failures the runtime check tolerates; the strict inspector, ensure and rollback do not.
export const RUNTIME_TOLERATED=Object.freeze(['FENCE_OWNER','FENCE_ACL','FENCE_EXTRA_INDEX','FENCE_RELOPTIONS']);
// Types are schema-qualified and ensure also pins search_path for the create, so a domain or operator in another schema never lands here.
export const FENCE_SQL=`CREATE TABLE public.paper_ledger_fence(
  user_id    pg_catalog.text PRIMARY KEY REFERENCES public.users(id),
  version    pg_catalog.int8 NOT NULL CHECK(version > 0),
  updated_at pg_catalog.int8 NOT NULL) WITH (fillfactor=50)`;
// Name, type OID (text 25, int8 20) and collation OID (100 is the database default; integers carry none).
const COLUMNS=[['user_id',25,100],['version',20,0],['updated_at',20,0]];
const PRIVILEGES=new Set(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']);
const refuse=(code,message,details={})=>Object.assign(new Error(code+': '+message),{code},details);

// Table-level ACL as sorted grantee:privilege:grant-option entries. The owner reads <owner> and the grantor is left out, so two tables
// with different owners can still compare equal here; the owner is checked on its own.
async function aclOf(db,oid){
  const row=(await db.query(`SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
    ARRAY(SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=c.relowner THEN '<owner>' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
      ||':'||a.privilege_type||':'||CASE WHEN a.is_grantable THEN 'G' ELSE '-' END
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a ORDER BY 1) AS acl,
    EXISTS(SELECT 1 FROM pg_catalog.pg_attribute t WHERE t.attrelid=c.oid AND t.attacl IS NOT NULL) AS column_acl
    FROM pg_catalog.pg_class c WHERE c.oid=$1`,[oid])).rows[0];
  return row??null;
}

/** Read only: catalog reads, no lock, works inside a READ ONLY transaction. state is ABSENT, INSTALLED or OTHER. */
export async function inspectPaperLedgerFence(db){
  const [relation]=(await db.query(`SELECT c.oid,c.relkind,c.relpersistence,c.relispartition,c.relrowsecurity,c.relforcerowsecurity,c.relhasrules,
    c.reloptions,am.amname,pg_catalog.to_regclass('public.paper_funding')::oid AS reference,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherits,
    EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam WHERE c.oid=pg_catalog.to_regclass('public.'||$1)`,[FENCE_TABLE])).rows;
  if(!relation)return {ok:false,state:'ABSENT',failures:['FENCE_ABSENT'],facts:{table:FENCE_TABLE,present:false}};
  const failures=[],oid=relation.oid;
  if(relation.relkind!=='r'||relation.amname!=='heap')failures.push('FENCE_RELATION_KIND');
  if(relation.relpersistence!=='p')failures.push('FENCE_PERSISTENCE');
  if(relation.relispartition||relation.inherits)failures.push('FENCE_INHERITANCE');
  if(relation.relrowsecurity||relation.relforcerowsecurity||relation.policies)failures.push('FENCE_ROW_SECURITY');
  if(relation.relhasrules)failures.push('FENCE_RULES');
  if(JSON.stringify(relation.reloptions)!==JSON.stringify(['fillfactor=50']))failures.push('FENCE_RELOPTIONS');
  // Types and collations by OID: format_type prints a domain named text as plain text when its schema is on the search_path.
  const columns=(await db.query(`SELECT a.attname::text AS name,a.atttypid::int AS type,a.atttypmod,a.attcollation::int AS collation,a.attnotnull,a.atthasdef,
    a.attidentity,a.attgenerated FROM pg_catalog.pg_attribute a WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[oid])).rows;
  if(columns.length!==COLUMNS.length||columns.some((column,index)=>column.name!==COLUMNS[index][0]||column.type!==COLUMNS[index][1]||column.atttypmod!==-1||
    !column.attnotnull||column.atthasdef||column.attidentity!==''||column.attgenerated!==''))failures.push('FENCE_COLUMNS');
  // A different collation (C, or a nondeterministic ICU one) changes which user ids the primary key treats as equal.
  let collation=columns.some((column,index)=>COLUMNS[index]&&column.name===COLUMNS[index][0]&&column.collation!==COLUMNS[index][2]);
  // NOT NULL is checked on the columns; a server that also lists it as a constraint (contype n) is not counted twice.
  const constraints=(await db.query(`SELECT con.contype,con.conkey::text AS conkey,con.condeferrable,con.convalidated,con.conindid,
    CASE WHEN con.contype='c' THEN pg_catalog.pg_get_expr(con.conbin,con.conrelid) END AS expression,
    con.contype='f' AND con.confrelid=pg_catalog.to_regclass('public.users') AND con.confupdtype='a' AND con.confdeltype='a' AND con.confmatchtype='s'
      AND con.confkey::text=(SELECT '{'||a.attnum||'}' FROM pg_catalog.pg_attribute a WHERE a.attrelid=con.confrelid AND a.attname='id') AS users_reference
    FROM pg_catalog.pg_constraint con WHERE con.conrelid=$1 AND con.contype<>'n' ORDER BY con.contype`,[oid])).rows;
  const primary=constraints.find(row=>row.contype==='p');
  const shape=constraints.length===3&&constraints.every(row=>!row.condeferrable&&row.convalidated)&&primary?.conkey==='{1}'&&
    constraints.some(row=>row.contype==='c'&&row.conkey==='{2}'&&row.expression==='(version > 0)')&&
    constraints.some(row=>row.contype==='f'&&row.conkey==='{1}'&&row.users_reference===true);
  if(!shape)failures.push('FENCE_CONSTRAINTS');
  const indexes=(await db.query(`SELECT i.indexrelid,i.indisprimary,i.indisunique,i.indisexclusion,i.indkey::text AS indkey,i.indexprs IS NULL AS columns_only,
    i.indpred IS NULL AS total,i.indcollation::text AS collation,am.amname,
    (SELECT pg_catalog.bool_and(o.opcdefault) FROM pg_catalog.pg_opclass o WHERE o.oid=ANY(i.indclass::pg_catalog.oid[])) AS default_opclass
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
    WHERE i.indrelid=$1`,[oid])).rows;
  const primaryIndex=indexes.find(row=>primary&&row.indexrelid===primary.conindid);
  if(!primaryIndex||!primaryIndex.indisprimary||!primaryIndex.indisunique||primaryIndex.indkey!=='1'||!primaryIndex.columns_only||!primaryIndex.total||
    primaryIndex.amname!=='btree'||!primaryIndex.default_opclass)failures.push('FENCE_PRIMARY_KEY_INDEX');
  if(primaryIndex&&primaryIndex.collation!=='100')collation=true;
  if(collation)failures.push('FENCE_COLLATION');
  const extra=indexes.filter(row=>row!==primaryIndex);
  if(extra.length)failures.push('FENCE_EXTRA_INDEX');
  // An index that can reject or skip a write (unique, partial, exclusion) or runs an expression on every write is never benign.
  if(extra.some(row=>row.indisunique||row.indisexclusion||!row.total||!row.columns_only))failures.push('FENCE_EXTRA_INDEX_UNSAFE');
  // Every trigger on the table and both sides of its foreign key, the internal ones included, must fire: DISABLE TRIGGER ALL turns
  // the users reference off.
  const triggers=(await db.query(`SELECT pg_catalog.count(*) FILTER (WHERE t.tgrelid=$1 AND NOT t.tgisinternal)::int AS user_triggers,
    pg_catalog.count(*) FILTER (WHERE t.tgenabled<>'O')::int AS disabled FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid=$1 OR t.tgconstraint IN (SELECT con.oid FROM pg_catalog.pg_constraint con WHERE con.conrelid=$1)`,[oid])).rows[0];
  if(triggers.user_triggers)failures.push('FENCE_USER_TRIGGER');
  if(triggers.disabled)failures.push('FENCE_TRIGGER_DISABLED');
  const acl=await aclOf(db,oid),reference=relation.reference===null?null:await aclOf(db,relation.reference);
  if(!reference)failures.push('FENCE_REFERENCE_MISSING');
  else{
    if(acl.owner!==reference.owner)failures.push('FENCE_OWNER');
    if(acl.column_acl||JSON.stringify(acl.acl)!==JSON.stringify(reference.acl))failures.push('FENCE_ACL');
  }
  const state=failures.length?'OTHER':'INSTALLED';
  return {ok:state==='INSTALLED',state,failures,facts:{table:FENCE_TABLE,present:true,owner:acl.owner,acl:acl.acl,
    reference_owner:reference?.owner??null,reference_acl:reference?.acl??null,reloptions:relation.reloptions,indexes:indexes.length,user_triggers:triggers.user_triggers,
    disabled_triggers:triggers.disabled}};
}

/**
 * Creates the fence from ABSENT inside the caller's transaction (db.migrate() calls it last, so the core schema already exists); a
 * no-op on INSTALLED; refuses OTHER with PAPER_LEDGER_FENCE_OTHER before any write. The table gets the owner of public.paper_funding:
 * when the connected role is not that owner it switches with SET LOCAL ROLE, and refuses with FENCE_OWNER_MISMATCH before any write
 * when the session cannot. Every non-owner grant on public.paper_funding is then replayed onto the fence and the result is verified.
 */
export async function ensurePaperLedgerFence(db){
  if(!db.isTransaction)throw refuse(PAPER_LEDGER_FENCE_TRANSACTION_REQUIRED,'the fence is created inside the migrate transaction');
  const before=await inspectPaperLedgerFence(db);
  if(before.state==='INSTALLED')return {...before,previous_state:'INSTALLED'};
  if(before.state!=='ABSENT')throw refuse(PAPER_LEDGER_FENCE_OTHER,'unexpected public.'+FENCE_TABLE+' (no change made): '+before.failures.join(', '),{report:before});
  const role=(await db.query(`SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,current_user::text AS current,pg_catalog.current_setting('role') AS setting,
    pg_catalog.pg_has_role(session_user,c.relowner,'SET') AS can_set FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.paper_funding')`)).rows[0];
  if(!role)throw refuse(PAPER_LEDGER_FENCE_OTHER,'public.paper_funding is missing, so the fence has no owner or ACL to follow (no change made)');
  const switched=role.owner!==role.current;
  if(switched&&!role.can_set)throw refuse(FENCE_OWNER_MISMATCH,'public.paper_funding is owned by '+role.owner+'; connected as '+role.current+', which cannot SET ROLE to it (no change made)');
  const grants=(await db.query(`SELECT a.privilege_type,a.is_grantable,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END AS grantee
    FROM pg_catalog.pg_class c,pg_catalog.aclexplode(c.relacl) a WHERE c.oid=pg_catalog.to_regclass('public.paper_funding') AND a.grantee<>c.relowner ORDER BY 3,1`)).rows;
  if(grants.some(grant=>!PRIVILEGES.has(grant.privilege_type)))throw refuse(PAPER_LEDGER_FENCE_OTHER,'public.paper_funding carries an unknown privilege (no change made)');
  const quote=async name=>(await db.query('SELECT pg_catalog.quote_ident($1) AS name',[name])).rows[0].name;
  // The create resolves the CHECK operator through search_path, so it runs with pg_catalog only and the caller's path comes back after.
  const searchPath=(await db.query("SELECT pg_catalog.current_setting('search_path') AS path")).rows[0].path;
  await db.query("SELECT pg_catalog.set_config('search_path','pg_catalog',true)");
  if(switched)await db.query('SET LOCAL ROLE '+await quote(role.owner));
  await db.query(FENCE_SQL);
  for(const grant of grants)await db.query('GRANT '+grant.privilege_type+' ON TABLE public.'+FENCE_TABLE+' TO '+grant.grantee+(grant.is_grantable?' WITH GRANT OPTION':''));
  // SET LOCAL ends with the transaction anyway; this hands the rest of the caller's transaction back to the role and path it had.
  // The verification still reads under pg_catalog, where the CHECK operator prints unqualified.
  if(switched)await db.query('SET LOCAL ROLE '+(role.setting==='none'?'NONE':await quote(role.setting)));
  const after=await inspectPaperLedgerFence(db);
  await db.query("SELECT pg_catalog.set_config('search_path',$1,true)",[searchPath]);
  if(after.state!=='INSTALLED')throw refuse(PAPER_LEDGER_FENCE_VERIFY_FAILED,'the created fence does not inspect as INSTALLED: '+after.failures.join(', '),{report:after});
  return {...after,previous_state:'ABSENT'};
}

/**
 * Startup check for the API and the execution worker. Read only. Refuses while ABSENT, on any shape failure, or when the connected
 * role cannot SELECT, INSERT and UPDATE the table; owner, ACL, reloptions and benign extra indexes are not checked here (see
 * RUNTIME_TOLERATED). The throw is the contract: the returned report may still read OTHER with ok false.
 */
export async function requirePaperLedgerFence(db){
  // A replica session bypasses foreign key enforcement without changing the catalog. Require the normal runtime setting.
  const replicationRole=(await db.query("SELECT pg_catalog.current_setting('session_replication_role') AS role")).rows[0].role;
  if(replicationRole!=='origin')throw refuse(PAPER_LEDGER_FENCE_REPLICATION_ROLE,'session_replication_role must be origin for the Paper ledger fence');
  const report=await inspectPaperLedgerFence(db);
  if(report.state==='ABSENT')throw refuse(PAPER_LEDGER_FENCE_ABSENT,'public.'+FENCE_TABLE+' is missing; run scripts/migrate-postgres.mjs offline before starting PostgreSQL services');
  const blocking=report.failures.filter(code=>!RUNTIME_TOLERATED.includes(code));
  if(blocking.length)throw refuse(PAPER_LEDGER_FENCE_OTHER,'unexpected public.'+FENCE_TABLE+': '+blocking.join(', '),{report});
  // has_table_privilege with a list is true when ANY listed privilege is held, so each one is asked on its own.
  const privilege=(await db.query(`SELECT pg_catalog.has_table_privilege('public.'||$1,'SELECT') AND pg_catalog.has_table_privilege('public.'||$1,'INSERT')
    AND pg_catalog.has_table_privilege('public.'||$1,'UPDATE') AS ok`,[FENCE_TABLE])).rows[0].ok;
  if(!privilege)throw refuse(PAPER_LEDGER_FENCE_PRIVILEGE,'the connected role needs SELECT, INSERT and UPDATE on public.'+FENCE_TABLE);
  return report;
}

/**
 * Offline rollback: its own transaction under the maintenance lock (refused while any API or worker holds the runtime lock) and the
 * migrate lock (robot:schema), so a bare migrate() cannot interleave. Drops the table only from INSTALLED; ABSENT is a no-op; OTHER
 * is refused untouched. It loses only fence counters, never accounting rows.
 */
export async function rollbackPaperLedgerFence(db){
  if(db.isTransaction)throw refuse(PAPER_LEDGER_FENCE_TRANSACTION_REQUIRED,'rollback runs in its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.lock('robot:schema');await db.verifySchema();
    // The table is held from before the classification to the drop, so a concurrent change either lands first and is seen, or waits.
    const kind=(await db.query('SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($1)',['public.'+FENCE_TABLE])).rows[0]?.relkind;
    if(kind==='r'||kind==='p')await db.query('LOCK TABLE public.'+FENCE_TABLE+' IN ACCESS EXCLUSIVE MODE');
    const before=await inspectPaperLedgerFence(db);
    if(before.state==='ABSENT')return {rolled_back:false,previous_state:'ABSENT'};
    if(before.state!=='INSTALLED')throw refuse(PAPER_LEDGER_FENCE_OTHER,'rollback refused on unexpected public.'+FENCE_TABLE+' (no change made): '+before.failures.join(', '),{report:before});
    await db.query('DROP TABLE public.'+FENCE_TABLE);
    const after=await inspectPaperLedgerFence(db);
    if(after.state!=='ABSENT')throw refuse(PAPER_LEDGER_FENCE_VERIFY_FAILED,'public.'+FENCE_TABLE+' is still present after rollback');
    return {rolled_back:true,previous_state:'INSTALLED'};
  });
}
