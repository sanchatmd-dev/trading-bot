/**
 * Shared read-only inspection of a runtime database role against the tables and functions an extension guards. Pure SQL queries over a
 * db handle ({query(sql,params)}); nothing here writes, locks or calls an extension function. The boundary it judges:
 *   - the role is not a superuser or BYPASSRLS role and is a member of no such role (RUNTIME_ROLE_PRIVILEGED_MEMBER);
 *   - the role owns no listed table, no listed function and not the schema (RUNTIME_ROLE_OWNS, RUNTIME_ROLE_OWNS_FUNCTION,
 *     RUNTIME_ROLE_OWNS_SCHEMA). Ownership is membership of the owning role (pg_has_role MEMBER), which SET ROLE reaches even without
 *     inheritance, and includes the database owner through pg_database_owner on PostgreSQL 15 and later;
 *   - no forbidden table privilege is held by the role or by any role it can reach by membership (SELECT, INSERT and UPDATE count on a single
 *     column too, through has_any_column_privilege; the required SELECT and INSERT stay table-level). The reach is EXISTS over pg_roles with
 *     pg_has_role(role, r.oid, 'MEMBER'), so a NOINHERIT role or a grant WITH INHERIT FALSE is still counted: has_table_privilege(role, ...)
 *     alone would miss it, while SET ROLE reaches it;
 *   - the role cannot CREATE in the schema (RUNTIME_ROLE_SCHEMA_CREATE);
 *   - (PostgreSQL 15 and later) the role may not SET session_replication_role.
 * With required privileges listed, the role itself must hold each of them (RUNTIME_ROLE_PRIVILEGE_MISSING).
 * The database TEMP privilege is recorded, not judged.
 */
export const TABLE_PRIVILEGES=Object.freeze(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']);
// Privileges that can also be granted on single columns: a column grant is a write path, but has_table_privilege does not see it.
const COLUMN_PRIVILEGES=new Set(['SELECT','INSERT','UPDATE']);

const REACHED=`EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role($1,r.oid,'MEMBER')`;

/**
 * options.runtimeRole: exact role name. options.schema (default public). options.tables: [{name, forbidden:[privilege], required:[privilege]}]
 * of tables that exist. options.functions: function names of the schema. Returns {found, failures, facts}; facts.runtime_role is null
 * when the role does not exist (failure RUNTIME_ROLE_MISSING).
 */
export async function inspectRuntimeRole(db,{runtimeRole,schema='public',tables=[],functions=[]}={}){
  const failures=[];
  const role=(await db.query('SELECT rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=$1',[runtimeRole])).rows[0];
  if(!role){failures.push('RUNTIME_ROLE_MISSING');return {found:false,failures,facts:null};}
  const facts={superuser:role.rolsuper,bypass_rls:role.rolbypassrls,privileged_members:[],tables:[],owned_functions:[]};
  if(role.rolsuper)failures.push('RUNTIME_ROLE_SUPERUSER');
  if(role.rolbypassrls)failures.push('RUNTIME_ROLE_BYPASSRLS');
  // Membership of any superuser or BYPASSRLS role lets SET ROLE reach it, whatever the role's own attributes say.
  facts.privileged_members=(await db.query(`SELECT r.rolname FROM pg_catalog.pg_roles r WHERE (r.rolsuper OR r.rolbypassrls) AND r.rolname<>$1
    AND pg_catalog.pg_has_role($1,r.oid,'MEMBER') ORDER BY r.rolname`,[runtimeRole])).rows.map(row=>row.rolname);
  for(const member of facts.privileged_members)failures.push('RUNTIME_ROLE_PRIVILEGED_MEMBER:'+member);
  facts.temp_privilege=(await db.query("SELECT pg_catalog.has_database_privilege($1,pg_catalog.current_database(),'TEMP') v",[runtimeRole])).rows[0].v;
  const owner=(await db.query(`SELECT pg_catalog.pg_has_role($1,n.nspowner,'MEMBER') AS owner,
    ${REACHED} AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS create_reached
    FROM pg_catalog.pg_namespace n WHERE n.nspname=$2`,[runtimeRole,schema])).rows[0];
  if(owner){
    facts.owns_schema=owner.owner;facts.schema_create=owner.create_reached;
    if(owner.owner)failures.push('RUNTIME_ROLE_OWNS_SCHEMA:'+schema);
    if(owner.create_reached)failures.push('RUNTIME_ROLE_SCHEMA_CREATE');
  }
  for(const {name,forbidden=[],required=[]} of tables){
    const held=(who,privilege)=>COLUMN_PRIVILEGES.has(privilege)
      ?`(pg_catalog.has_table_privilege(${who},c.oid,'${privilege}') OR pg_catalog.has_any_column_privilege(${who},c.oid,'${privilege}'))`
      :`pg_catalog.has_table_privilege(${who},c.oid,'${privilege}')`;
    // table_<privilege> is the table-level grant alone: the required privileges are judged on it, since a column grant does not serve a whole-table statement.
    const privileges=TABLE_PRIVILEGES.map(privilege=>`pg_catalog.has_table_privilege($1,c.oid,'${privilege}') AS "table_${privilege.toLowerCase()}",
      ${held('$1',privilege)} AS "${privilege.toLowerCase()}",
      ${REACHED} AND ${held('r.oid',privilege)}) AS "${privilege.toLowerCase()}_reached"`).join(',');
    const row=(await db.query(`SELECT pg_catalog.pg_has_role($1,c.relowner,'MEMBER') AS owner,${privileges}
      FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($2)`,[runtimeRole,schema+'.'+name])).rows[0];
    if(!row)continue;
    const entry={table:name,owner:row.owner,reached:{}};
    for(const privilege of TABLE_PRIVILEGES){
      const key=privilege.toLowerCase();
      entry[key]=row[key];entry.reached[key]=row[key+'_reached'];
    }
    facts.tables.push(entry);
    if(row.owner)failures.push('RUNTIME_ROLE_OWNS:'+name);
    for(const privilege of forbidden)if(entry.reached[privilege.toLowerCase()]||entry[privilege.toLowerCase()])
      failures.push(privilege==='TRIGGER'?'RUNTIME_ROLE_TRIGGER_PRIVILEGE:'+name:privilege==='TRUNCATE'?'RUNTIME_ROLE_TRUNCATE_PRIVILEGE:'+name
        :'RUNTIME_ROLE_WRITE_PRIVILEGE:'+name+':'+privilege);
    for(const privilege of required)if(!row['table_'+privilege.toLowerCase()])failures.push('RUNTIME_ROLE_PRIVILEGE_MISSING:'+name+':'+privilege);
  }
  // The owner of a function, or a member of that owner, can replace its body.
  if(functions.length){
    facts.owned_functions=(await db.query(`SELECT DISTINCT p.proname FROM pg_catalog.pg_proc p WHERE p.pronamespace=$3::regnamespace AND p.proname=ANY($1)
      AND pg_catalog.pg_has_role($2,p.proowner,'MEMBER') ORDER BY p.proname`,[functions,runtimeRole,schema])).rows.map(row=>row.proname);
    for(const name of facts.owned_functions)failures.push('RUNTIME_ROLE_OWNS_FUNCTION:'+name);
  }
  facts.server_version_num=Number((await db.query("SELECT pg_catalog.current_setting('server_version_num') v")).rows[0].v);
  if(facts.server_version_num>=150000){
    facts.session_replication_role_set=(await db.query("SELECT pg_catalog.has_parameter_privilege($1,'session_replication_role','SET') v",[runtimeRole])).rows[0].v;
    if(facts.session_replication_role_set)failures.push('RUNTIME_ROLE_SESSION_REPLICATION_ROLE');
  }
  return {found:true,failures,facts};
}
