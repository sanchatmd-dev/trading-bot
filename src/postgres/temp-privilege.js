/**
 * TEMPORARY privilege on the current database (owner decision C2, prepared and NOT applied by default).
 *
 * PostgreSQL grants TEMPORARY on every new database to PUBLIC, so the runtime role can CREATE TEMP TABLE and shadow an
 * unqualified relation name inside a trigger function that does not pin its search_path. Revoking TEMPORARY from PUBLIC (and from the
 * runtime role when it holds the privilege directly) closes that route for every guard at once. This module only inspects, revokes and
 * restores; nothing here is called from a startup path, a migration or a readiness check yet.
 *
 * The mutating calls refuse unless the connected role OWNS the database: REVOKE and GRANT by a non-owner only raise a WARNING and
 * change nothing, which would look like success.
 *
 * Beyond the one named runtime role, inspect reports every non-superuser LOGIN role that can connect to the database (and is not its owner),
 * and revoke refuses (rolls back) while any of them still has effective TEMP unless it is listed in allowTempRoles. Revoke and restore
 * also refuse while any session other than the caller's is connected to the database, unless allowActiveSessions is set; that override is
 * UNSAFE because a writer that connects or holds temp objects during the change is not controlled. This module does not take the
 * application maintenance lock (the tool is separate): the operator must stop every application writer first.
 *
 * Session visibility: pg_stat_activity shows another role's session (database, user) only to a superuser or a member of pg_read_all_stats;
 * to any other caller those rows carry only backend_type. A caller without that visibility cannot count sessions, so the report says
 * sessions_verifiable=false (the *live_sessions* fields are null) and revoke/restore refuse with TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE
 * unless allowActiveSessions is set. A client backend with no database name is never ignored: it is reported as unattributed and refused too.
 */
export const DEFAULT_RUNTIME_ROLE='robot_app';
export const TEMP_PRIVILEGE_NOT_OWNER='TEMP_PRIVILEGE_NOT_OWNER';
export const TEMP_PRIVILEGE_REFUSED='TEMP_PRIVILEGE_REFUSED';
export const TEMP_PRIVILEGE_SESSIONS_ACTIVE='TEMP_PRIVILEGE_SESSIONS_ACTIVE';
export const TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE='TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE';
export const WRITERS_NOTE='Stop every application writer before running this tool: it does not take the application maintenance lock, and a session that connects during the change is not controlled.';
const ROLE_NAME=/^[a-z_][a-z0-9_]{0,62}$/;
const refuse=(code,message,details={})=>Object.assign(new Error(message),{code},details);

/**
 * Whether the role can create TEMP tables in the current database. With no role it answers for the connected role, so a readiness
 * check running as the runtime role asks about itself. Throws when a named role does not exist.
 */
export async function runtimeRoleHasTemp(db,{role=null}={}){
  const {rows}=await db.query("SELECT has_database_privilege(COALESCE($1::name,current_user::name),current_database(),'TEMPORARY') AS temp",[role]);
  return rows[0].temp;
}

/** Read only. Never writes, never changes a setting. Works inside a READ ONLY transaction. */
export async function inspectTempPrivilege(db,{runtimeRole=DEFAULT_RUNTIME_ROLE}={}){
  if(!ROLE_NAME.test(runtimeRole))throw refuse(TEMP_PRIVILEGE_REFUSED,'Invalid runtime role name');
  const database=(await db.query(`SELECT current_database() AS name,pg_get_userbyid(d.datdba) AS owner,current_user AS connected_as,d.datacl::text AS datacl,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0 AND a.privilege_type='TEMPORARY') AS public_has_temp,
    -- The owner always holds TEMP and is left out of the grantee list.
    ARRAY(SELECT DISTINCT pg_get_userbyid(a.grantee)::text FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
      WHERE a.grantee<>0 AND a.grantee<>d.datdba AND a.privilege_type='TEMPORARY' ORDER BY 1) AS direct_temp_grantees
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  const visible=await canSeeAllSessions(db);
  const role=(await db.query('SELECT rolsuper FROM pg_roles WHERE rolname=$1',[runtimeRole])).rows[0];
  const runtime={name:runtimeRole,exists:!!role,superuser:role?.rolsuper===true,owner:database.owner===runtimeRole,
    effective_temp:null,direct_temp_grant:database.direct_temp_grantees.includes(runtimeRole),live_sessions:visible?0:null};
  if(role){
    runtime.effective_temp=await runtimeRoleHasTemp(db,{role:runtimeRole});
    if(visible)runtime.live_sessions=(await db.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>pg_backend_pid()',[runtimeRole])).rows[0].n;
  }
  // A temp schema (pg_temp_N) keeps its name after its session ends, but its relations and functions are dropped with the session.
  // A schema that still holds objects therefore belongs to a live session, and its owner shows which role created them.
  const temp=(await db.query(`SELECT s.schema,s.owner,sum(s.relations)::int AS relations,sum(s.functions)::int AS functions FROM (
      SELECT n.nspname AS schema,pg_get_userbyid(c.relowner) AS owner,1 AS relations,0 AS functions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname ~ '^pg_temp_[0-9]+$'
      UNION ALL SELECT n.nspname,pg_get_userbyid(p.proowner),0,1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname ~ '^pg_temp_[0-9]+$') s GROUP BY s.schema,s.owner ORDER BY s.schema,s.owner`)).rows;
  // Every non-superuser LOGIN role that can connect and is not the owner (the owner always holds TEMP). effective_temp follows
  // has_database_privilege, so it counts PUBLIC, a direct grant and an INHERITed membership; it does not count SET ROLE to a group the
  // role does not inherit from.
  const loginRoles=(await db.query(`SELECT r.rolname::text AS name,has_database_privilege(r.oid,d.oid,'TEMPORARY') AS effective_temp,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=r.oid AND a.privilege_type='TEMPORARY') AS direct_temp_grant,
      CASE WHEN $1::boolean THEN (SELECT count(*)::int FROM pg_stat_activity s WHERE s.datname=d.datname AND s.usename=r.rolname AND s.pid<>pg_backend_pid() AND s.backend_type='client backend') END AS live_sessions
    FROM pg_roles r CROSS JOIN pg_database d
    WHERE d.datname=current_database() AND r.rolcanlogin AND NOT r.rolsuper AND r.oid<>d.datdba AND has_database_privilege(r.oid,d.oid,'CONNECT')
    ORDER BY r.rolname`,[visible])).rows;
  const otherSessions=await foreignSessions(db,visible);
  return {database:database.name,owner:database.owner,connected_as:database.connected_as,datacl:database.datacl,
    public_has_temp:database.public_has_temp,direct_temp_grantees:database.direct_temp_grantees,runtime_role:runtime,
    temp_closed_for_runtime_role:runtime.exists?runtime.effective_temp===false:null,
    login_roles:loginRoles,login_roles_with_temp:loginRoles.filter(item=>item.effective_temp).map(item=>item.name),
    all_login_roles_closed:loginRoles.every(item=>!item.effective_temp),other_sessions:otherSessions,sessions_verifiable:otherSessions.verifiable,
    live_temp_schemas:temp,runtime_role_holds_temp_schema:temp.some(item=>item.owner===runtimeRole)};
}

/** Whether the caller sees database and user of every session: a superuser or a member of pg_read_all_stats. */
export async function canSeeAllSessions(db){
  return (await db.query("SELECT (r.rolsuper OR pg_has_role(r.oid,'pg_read_all_stats','USAGE')) AS visible FROM pg_roles r WHERE r.rolname=current_user")).rows[0].visible===true;
}

/**
 * Client sessions on the current database other than the caller's own connection (background workers are not client backends).
 * verifiable is false when the caller cannot see other roles' sessions (the counts are then only a lower bound) or when a client
 * backend without a database name exists (a session still starting): unattributed counts those, and also every row whose backend_type is
 * hidden from this caller (a limited caller sees no backend_type of other roles' sessions, so it cannot tell a client from a worker).
 */
export async function foreignSessions(db,visible=null){
  const canSee=visible===null?await canSeeAllSessions(db):visible;
  const rows=(await db.query("SELECT COALESCE(usename,'?')::text AS role,count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' GROUP BY 1 ORDER BY 1")).rows;
  const unattributed=(await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND (backend_type IS NULL OR (backend_type='client backend' AND datname IS NULL))")).rows[0].n;
  return {total:rows.reduce((sum,item)=>sum+item.count,0),by_role:rows,visibility:canSee?'FULL':'LIMITED',unattributed,verifiable:canSee&&unattributed===0};
}

async function ownedDatabase(db,runtimeRole){
  const before=await inspectTempPrivilege(db,{runtimeRole});
  if(before.connected_as!==before.owner)throw refuse(TEMP_PRIVILEGE_NOT_OWNER,'Run as the database owner ('+before.owner+'); connected as '+before.connected_as+'. A non-owner REVOKE or GRANT changes nothing.');
  return before;
}
const quoted=async(db,names)=>(await db.query('SELECT quote_ident(current_database()) AS database,quote_ident($1::text) AS role',[names])).rows[0];
const describeSessions=sessions=>sessions.by_role.map(item=>item.role+'='+item.count).join(', ');

/**
 * Refuse while another session is connected, or while the sessions cannot be counted, unless the caller chose the unsafe override.
 * Returns what was seen.
 */
function sessionGate(before,action,allowActiveSessions){
  const sessions=before.other_sessions;
  if(!allowActiveSessions){
    if(sessions.total>0)
      throw refuse(TEMP_PRIVILEGE_SESSIONS_ACTIVE,sessions.total+' other session(s) are connected to '+before.database+' ('+describeSessions(sessions)+'); stop every application writer and retry the '+action+'. --allow-active-sessions overrides this and is UNSAFE.',{sessions});
    if(!sessions.verifiable)
      throw refuse(TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE,sessions.visibility==='LIMITED'
        ?'Sessions of other roles cannot be counted: '+before.connected_as+' is neither a superuser nor a member of pg_read_all_stats ('+sessions.unattributed+' other backend(s) cannot be classified). Grant pg_read_all_stats to the caller, or --allow-active-sessions overrides this and is UNSAFE.'
        :sessions.unattributed+' client backend(s) without a database name are visible (starting or unattributed sessions); retry, or --allow-active-sessions overrides this and is UNSAFE.',{sessions});
  }
  return {sessions_at_check:sessions,sessions_verifiable:sessions.verifiable,active_sessions_override:sessions.total>0||!sessions.verifiable};
}

/**
 * REVOKE TEMPORARY ON DATABASE <current> FROM PUBLIC, and from the runtime role when it holds the privilege directly. One transaction:
 * if the runtime role still has TEMP afterwards (a group role grants it, or it is the owner or a superuser), or any other non-superuser
 * LOGIN role that can connect still has TEMP and is not listed in allowTempRoles, the whole change is rolled back.
 * Refused with TEMP_PRIVILEGE_SESSIONS_ACTIVE while another session is connected, and with TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE when the
 * caller cannot count sessions, unless allowActiveSessions is true (unsafe).
 */
export async function revokeTempPrivilege(db,{runtimeRole=DEFAULT_RUNTIME_ROLE,allowTempRoles=[],allowActiveSessions=false}={}){
  const allowed=[...new Set(allowTempRoles)];
  for(const name of allowed)if(typeof name!=='string'||!ROLE_NAME.test(name))throw refuse(TEMP_PRIVILEGE_REFUSED,'Invalid allowed TEMP role name');
  if(allowed.includes(runtimeRole))throw refuse(TEMP_PRIVILEGE_REFUSED,'The runtime role '+runtimeRole+' cannot be listed as an allowed TEMP role');
  return db.transaction(async()=>{
    const before=await ownedDatabase(db,runtimeRole);
    if(!before.runtime_role.exists)throw refuse(TEMP_PRIVILEGE_REFUSED,'Runtime role '+runtimeRole+' does not exist');
    if(before.runtime_role.superuser||before.runtime_role.owner)throw refuse(TEMP_PRIVILEGE_REFUSED,'Runtime role '+runtimeRole+' is a superuser or the database owner; TEMP cannot be revoked from it');
    // A typo in an allow list would silently allow nothing; a name that is not an existing role is refused.
    const known=(await db.query('SELECT rolname::text AS name FROM pg_roles WHERE rolname=ANY($1::text[])',[allowed])).rows.map(item=>item.name);
    const unknown=allowed.filter(name=>!known.includes(name));
    if(unknown.length>0)throw refuse(TEMP_PRIVILEGE_REFUSED,'Allowed TEMP role(s) do not exist: '+unknown.join(', '));
    const gate=sessionGate(before,'revoke',allowActiveSessions);
    const q=await quoted(db,runtimeRole);
    const statements=[];
    if(before.public_has_temp)statements.push('REVOKE TEMPORARY ON DATABASE '+q.database+' FROM PUBLIC');
    if(before.runtime_role.direct_temp_grant)statements.push('REVOKE TEMPORARY ON DATABASE '+q.database+' FROM '+q.role);
    for(const statement of statements)await db.query(statement);
    const after=await inspectTempPrivilege(db,{runtimeRole});
    if(after.runtime_role.effective_temp)throw refuse(TEMP_PRIVILEGE_REFUSED,'Runtime role '+runtimeRole+' still has TEMP after the revoke (inherited through another role); nothing was changed');
    const offenders=after.login_roles.filter(item=>item.effective_temp&&item.name!==runtimeRole&&!allowed.includes(item.name));
    if(offenders.length>0)
      throw refuse(TEMP_PRIVILEGE_REFUSED,'Login role(s) still have TEMP after the revoke: '+offenders.map(item=>item.name+(item.direct_temp_grant?' (direct grant)':' (inherited)')).join(', ')+'; nothing was changed. List an intended exception with --allow-temp-role=NAME.',{roles:offenders.map(item=>item.name)});
    const exceptions=after.login_roles.filter(item=>item.effective_temp&&allowed.includes(item.name)).map(item=>item.name);
    return {action:'revoke',changed:statements.length>0,statements,previous_datacl:before.datacl,datacl:after.datacl,
      temp_closed_for_runtime_role:true,login_roles_checked:after.login_roles.map(item=>item.name),allowed_temp_roles:exceptions,
      ...gate,writers_note:WRITERS_NOTE,live_temp_schemas:after.live_temp_schemas,
      note:after.runtime_role_holds_temp_schema||after.live_temp_schemas.length>0
        ?'Live sessions may still hold temp objects created before the revoke; the revoke blocks new temp objects only. Restart the runtime sessions to drop them.'
        :'No live session holds a temp object.'};
  });
}

/**
 * GRANT TEMPORARY ON DATABASE <current> TO PUBLIC (the PostgreSQL default). Byte-identical restore of datacl is NOT guaranteed: a database
 * whose datacl was NULL (the default ACL) ends with an explicit list, entry order and grantor follow PostgreSQL, and a direct TEMP grant
 * that revokeTempPrivilege removed from the runtime role is not granted again.
 */
export async function restoreTempPrivilege(db,{runtimeRole=DEFAULT_RUNTIME_ROLE,allowActiveSessions=false}={}){
  return db.transaction(async()=>{
    const before=await ownedDatabase(db,runtimeRole);
    const gate=sessionGate(before,'restore',allowActiveSessions);
    const q=await quoted(db,runtimeRole);
    const statements=['GRANT TEMPORARY ON DATABASE '+q.database+' TO PUBLIC'];
    for(const statement of statements)await db.query(statement);
    const after=await inspectTempPrivilege(db,{runtimeRole});
    return {action:'restore',changed:!before.public_has_temp,statements,previous_datacl:before.datacl,datacl:after.datacl,public_has_temp:after.public_has_temp,
      ...gate,writers_note:WRITERS_NOTE,
      note:'Byte-identical datacl restore is not guaranteed. A direct TEMP grant to the runtime role removed by --revoke is not granted again.'};
  });
}
