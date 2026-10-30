import {inspectPaperCapitalModel,MARKER_TABLE,DECLARATION_TABLE} from './paper-capital-model-migration.js';

/**
 * QR-2 S4 paper capital model: the targeted runtime grant and its exact reverse (set B). Offline only: one transaction under the maintenance
 * lock, so every participating API and worker must be stopped. The repository grant script (scripts/grant-postgres-runtime.sql) is NOT used on
 * staging because it changes the grants of every table and the schema; this module changes exactly these ACL entries and nothing else:
 *   GRANT SELECT          ON TABLE public.paper_capital_model_schema TO <runtime role>
 *   GRANT SELECT, INSERT  ON TABLE public.paper_capital_models       TO <runtime role>
 *   GRANT EXECUTE         ON FUNCTION public.paper_capital_model_now_ms() TO <runtime role>   (only with includeExecute)
 * No grant option, column grant, other privilege, schema, default-privilege, PUBLIC or other-table change. The revoke is the exact reverse.
 *
 * The runtime role name is the caller's value (the CLI reads it in process from the runtime connection with current_user). It reaches the database
 * only as a bound parameter of one transaction-local setting and is quoted there with format('%I'); it is never put into statement text, never
 * returned, never printed and never part of an error message. Every failure leaves as a PaperCapitalModelGrantRefusal that carries labels only.
 *
 * Idempotence is by the ACL state of each object: NONE (owner entries only), EXACT (owner entries plus exactly the target entries, granted by the
 * owner, without grant option) or OTHER (any other grantee, a PUBLIC entry, a grant option, another grantor, another privilege set or a column
 * grant). OTHER refuses with no change. Grant: NONE applies, EXACT is a no-op pass. Revoke: EXACT applies, NONE is a no-op pass.
 * Everything is verified before COMMIT; any failure rolls the transaction back.
 */
export const GRANT_SETTING='robot.pcm_grant_role';
export const FUNCTION_NAME='public.paper_capital_model_now_ms()';
const TABLE_TARGETS=Object.freeze({[MARKER_TABLE]:['SELECT'],[DECLARATION_TABLE]:['INSERT','SELECT']});
const EXECUTE_TARGET=Object.freeze(['EXECUTE']);
const LOCK_MESSAGE='Stop every PostgreSQL API and worker before maintenance';
const RUNTIME_ROLE_TEXT=/^[^\u0000]{1,63}$/u;

/** Fixed statement texts. The role never appears in them: it is the bound parameter of SET_ROLE and is quoted by format('%I') inside the DO block. */
const doBlock=statement=>`DO $pcm$ BEGIN EXECUTE pg_catalog.format('${statement}',pg_catalog.current_setting('${GRANT_SETTING}')); END $pcm$`;
export const STATEMENTS=Object.freeze({
  SET_ROLE:`SELECT pg_catalog.set_config('${GRANT_SETTING}',$1::text,true) AS applied`,
  LOCK_TIMEOUT:`SET LOCAL lock_timeout = '5s'`,
  LOCK_TABLES:`LOCK TABLE public.${MARKER_TABLE}, public.${DECLARATION_TABLE} IN ACCESS EXCLUSIVE MODE`,
  GRANT_MARKER:doBlock(`GRANT SELECT ON TABLE public.${MARKER_TABLE} TO %I`),
  GRANT_DECLARATIONS:doBlock(`GRANT SELECT, INSERT ON TABLE public.${DECLARATION_TABLE} TO %I`),
  GRANT_EXECUTE:doBlock(`GRANT EXECUTE ON FUNCTION ${FUNCTION_NAME} TO %I`),
  REVOKE_MARKER:doBlock(`REVOKE SELECT ON TABLE public.${MARKER_TABLE} FROM %I`),
  REVOKE_DECLARATIONS:doBlock(`REVOKE SELECT, INSERT ON TABLE public.${DECLARATION_TABLE} FROM %I`),
  REVOKE_EXECUTE:doBlock(`REVOKE EXECUTE ON FUNCTION ${FUNCTION_NAME} FROM %I`)});

/** Read-only queries. Each starts with a tag comment. */
export const QUERIES=Object.freeze({
  ROLE:`/* pcm-grant:role */ SELECT r.oid AS oid,r.rolsuper AS superuser,r.rolbypassrls AS bypass_rls FROM pg_catalog.pg_roles r WHERE r.rolname=$1::name`,
  TABLES:`/* pcm-grant:tables */ SELECT c.relname AS name,c.relowner AS owner_oid,pg_catalog.pg_has_role(c.relowner,'USAGE') AS session_owns,
    pg_catalog.pg_has_role($1::name,c.relowner,'MEMBER') AS runtime_member
    FROM pg_catalog.pg_class c WHERE c.oid IN (pg_catalog.to_regclass('public.${MARKER_TABLE}'),pg_catalog.to_regclass('public.${DECLARATION_TABLE}')) ORDER BY c.relname`,
  TABLE_ACL:`/* pcm-grant:table-acl */ SELECT c.relname AS name,c.relowner AS owner_oid,
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_array(x.grantor::pg_catalog.int8,x.grantee::pg_catalog.int8,x.privilege_type,x.is_grantable) ORDER BY x.grantee,x.privilege_type,x.grantor),'[]'::json)
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x) AS entries,
    EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS column_acl
    FROM pg_catalog.pg_class c WHERE c.oid IN (pg_catalog.to_regclass('public.${MARKER_TABLE}'),pg_catalog.to_regclass('public.${DECLARATION_TABLE}')) ORDER BY c.relname`,
  FUNCTION_ACL:`/* pcm-grant:function-acl */ SELECT p.proowner AS owner_oid,
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_array(x.grantor::pg_catalog.int8,x.grantee::pg_catalog.int8,x.privilege_type,x.is_grantable) ORDER BY x.grantee,x.privilege_type,x.grantor),'[]'::json)
      FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) x) AS entries
    FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure('${FUNCTION_NAME}')::oid`,
  PRIVILEGES:`/* pcm-grant:privileges */ SELECT
    pg_catalog.has_table_privilege($1::name,'public.${MARKER_TABLE}','SELECT') OR pg_catalog.has_any_column_privilege($1::name,'public.${MARKER_TABLE}','SELECT') AS marker_select,
    pg_catalog.has_table_privilege($1::name,'public.${MARKER_TABLE}','INSERT') OR pg_catalog.has_any_column_privilege($1::name,'public.${MARKER_TABLE}','INSERT') AS marker_insert,
    pg_catalog.has_table_privilege($1::name,'public.${DECLARATION_TABLE}','SELECT') OR pg_catalog.has_any_column_privilege($1::name,'public.${DECLARATION_TABLE}','SELECT') AS declarations_select,
    pg_catalog.has_table_privilege($1::name,'public.${DECLARATION_TABLE}','INSERT') OR pg_catalog.has_any_column_privilege($1::name,'public.${DECLARATION_TABLE}','INSERT') AS declarations_insert,
    pg_catalog.has_function_privilege($1::name,'${FUNCTION_NAME}','EXECUTE') AS function_execute`,
  DIGEST:`/* pcm-grant:digest */ SELECT pg_catalog.md5(pg_catalog.concat_ws('#',
    (SELECT COALESCE(pg_catalog.string_agg(c.oid::text||':'||c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.oid),'') FROM pg_catalog.pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>ALL($1::text[])),
    (SELECT COALESCE(pg_catalog.string_agg(a.attrelid::text||':'||a.attnum::text||':'||a.attacl::text,'|' ORDER BY a.attrelid,a.attnum),'') FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL AND c.relname<>ALL($1::text[])),
    (SELECT n.nspowner::text||':'||COALESCE(n.nspacl::text,'') FROM pg_catalog.pg_namespace n WHERE n.nspname='public'),
    (SELECT COALESCE(d.datacl::text,'') FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()),
    (SELECT COALESCE(pg_catalog.string_agg(f.oid::text||':'||COALESCE(f.proacl::text,''),'|' ORDER BY f.oid),'') FROM pg_catalog.pg_proc f
      WHERE f.pronamespace='public'::regnamespace AND (NOT $2::boolean OR f.oid IS DISTINCT FROM pg_catalog.to_regprocedure('${FUNCTION_NAME}')::oid)),
    (SELECT COALESCE(pg_catalog.string_agg(da.oid::text||':'||COALESCE(da.defaclacl::text,''),'|' ORDER BY da.oid),'') FROM pg_catalog.pg_default_acl da))) AS digest,
    (SELECT count(*)::int FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>ALL($1::text[])) AS relations`});

/**
 * The server a connection reached, read the same way on the owner connection and on the runtime connection (the CLI compares them in process and
 * never prints a value): database, the server's port setting and the postmaster start time. The runtime role may run all of it.
 */
export const SERVER_TARGET_QUERY=`/* pcm-grant:target */ SELECT pg_catalog.current_database()::text AS database,pg_catalog.current_setting('port') AS port,
    extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text AS started`;
export const sameServerTarget=(a,b)=>['database','port','started'].every(key=>typeof a?.[key]==='string'&&a[key].length>0&&a[key]===b?.[key]);

/** Labels only. A refusal never carries the role name, a pg message, a host or a path. */
export class PaperCapitalModelGrantRefusal extends Error {
  constructor(code,details=[]){
    super('Paper capital model grant refused: '+[code,...details].join(', ')+' (no change made)');
    this.name='PaperCapitalModelGrantRefusal';this.code=code;this.details=[...details];
  }
}
const refuse=(code,details)=>{throw new PaperCapitalModelGrantRefusal(code,details);};
/** A runtime-role inspection failure name may carry a role name after the colon (privileged membership); every other label is kept. */
const labelOf=failure=>String(failure).startsWith('RUNTIME_ROLE_PRIVILEGED_MEMBER')?'RUNTIME_ROLE_PRIVILEGED_MEMBER':String(failure);

/**
 * Pure ACL classification of one object. entries is [[grantor,grantee,privilege,grantable],...] as aclexplode lists them (grantee 0 is PUBLIC);
 * owner entries are ignored. Returns {state:'NONE'|'EXACT'|'OTHER', reason}.
 */
export function classifyAcl({entries,columnAcl=false,ownerOid,runtimeOid,wanted}){
  if(columnAcl)return {state:'OTHER',reason:'COLUMN_ACL'};
  const mine=[];
  for(const [grantor,grantee,privilege,grantable] of entries){
    if(grantee===ownerOid)continue;
    if(grantee===0)return {state:'OTHER',reason:'PUBLIC_ENTRY'};
    if(grantee!==runtimeOid)return {state:'OTHER',reason:'FOREIGN_GRANTEE'};
    if(grantable)return {state:'OTHER',reason:'GRANT_OPTION'};
    if(grantor!==ownerOid)return {state:'OTHER',reason:'FOREIGN_GRANTOR'};
    mine.push(privilege);
  }
  const held=[...new Set(mine)].sort();
  if(held.length!==mine.length)return {state:'OTHER',reason:'DUPLICATE_ENTRY'};
  if(held.length===0)return {state:'NONE',reason:null};
  if(held.length===wanted.length&&held.every((privilege,index)=>privilege===wanted[index]))return {state:'EXACT',reason:null};
  return {state:'OTHER',reason:'PRIVILEGE_SET'};
}

/** pg returns oid columns as numbers, and the int8 cast of the ACL entries inside the JSON gives numbers too; anything else would make every comparison fail silently. */
const isOid=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const entriesAreOids=entries=>Array.isArray(entries)&&entries.every(entry=>Array.isArray(entry)&&isOid(entry[0])&&isOid(entry[1]));

async function readStates(db,{roleOid,includeExecute}){
  const states={},reasons=[];
  if(!isOid(roleOid))refuse('ACL_OID_TYPE');
  const acl=(await db.query(QUERIES.TABLE_ACL)).rows;
  for(const name of [MARKER_TABLE,DECLARATION_TABLE]){
    const row=acl.find(item=>item.name===name);
    if(!row)refuse('M6_TABLE_MISSING',[name]);
    if(!isOid(row.owner_oid)||!entriesAreOids(row.entries))refuse('ACL_OID_TYPE');
    const result=classifyAcl({entries:row.entries,columnAcl:row.column_acl,ownerOid:row.owner_oid,runtimeOid:roleOid,wanted:TABLE_TARGETS[name]});
    states[name]=result.state;if(result.reason)reasons.push(name+':'+result.reason);
  }
  const fn=(await db.query(QUERIES.FUNCTION_ACL)).rows[0];
  if(!fn)refuse('M6_FUNCTION_MISSING',['paper_capital_model_now_ms']);
  if(!isOid(fn.owner_oid)||!entriesAreOids(fn.entries))refuse('ACL_OID_TYPE');
  const mine=fn.entries.some(entry=>entry[1]===roleOid);
  states.function='NOT_IN_SCOPE';states.function_entry=mine;
  if(includeExecute){
    const result=classifyAcl({entries:fn.entries,ownerOid:fn.owner_oid,runtimeOid:roleOid,wanted:EXECUTE_TARGET});
    states.function=result.state;if(result.reason)reasons.push('paper_capital_model_now_ms:'+result.reason);
  }
  return {states,reasons};
}
const labels=states=>({marker:states[MARKER_TABLE],declarations:states[DECLARATION_TABLE],function:states.function});

/** The runtime role and the ownership facts. Throws a refusal; returns the role row. */
async function readFacts(db,roleName){
  const role=(await db.query(QUERIES.ROLE,[roleName])).rows[0];
  if(!role)refuse('RUNTIME_ROLE_MISSING');
  if(role.superuser)refuse('RUNTIME_ROLE_SUPERUSER');
  if(role.bypass_rls)refuse('RUNTIME_ROLE_BYPASSRLS');
  if(!isOid(role.oid))refuse('ACL_OID_TYPE');
  const tables=(await db.query(QUERIES.TABLES,[roleName])).rows;
  if(tables.length!==2)refuse('M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
  if(tables.some(table=>!isOid(table.owner_oid)))refuse('ACL_OID_TYPE');
  if(tables.some(table=>table.session_owns!==true))refuse('SESSION_NOT_OWNER');
  if(tables.some(table=>table.owner_oid===role.oid||table.runtime_member!==false))refuse('RUNTIME_ROLE_IS_OWNER');
  return role;
}

async function apply(db,{action,roleName,includeExecute,inspect}){
  if(db.isTransaction)refuse('NOT_OWN_TRANSACTION');
  const grant=action==='GRANT';
  return db.transaction(async()=>{
    try{await db.maintenanceLock();}
    catch(error){if(String(error?.message).includes(LOCK_MESSAGE))refuse('MAINTENANCE_LOCK_HELD');throw error;}
    try{await db.verifySchema();}catch(error){if(error?.code)throw error;refuse('SCHEMA_NOT_14');}
    // Early labels without any lock: the role, and who owns what. They are read again below once the table lock is held.
    await readFacts(db,roleName);
    try{await db.query(STATEMENTS.LOCK_TIMEOUT);await db.query(STATEMENTS.LOCK_TABLES);}
    catch(error){
      if(error?.code==='55P03')refuse('LOCK_TABLES_TIMEOUT');
      if(error?.code==='42P01')refuse('M6_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
      throw error;
    }
    // Authoritative facts: read with the lock held, so no table can be dropped or re-owned between this read and the commit.
    const role=await readFacts(db,roleName);
    // M6 exactly INSTALLED, read with the existing inspection. Runtime-role facts are checked too; the grants themselves are judged below.
    const before=await inspect(db,{runtimeRole:roleName,requireGrants:false});
    if(before.facts.state!=='INSTALLED')refuse('M6_NOT_INSTALLED',[before.facts.state]);
    const aclBefore=await readStates(db,{roleOid:role.oid,includeExecute});
    const other=Object.entries(aclBefore.states).filter(([key,value])=>key!=='function_entry'&&value==='OTHER');
    if(other.length)refuse('ACL_STATE_OTHER',aclBefore.reasons);
    if(!includeExecute&&aclBefore.states.function_entry){
      // An explicit runtime EXECUTE entry is outside the scope of this call: a revoke cannot reverse it, and a grant would leave a half state.
      refuse(grant?'ACL_STATE_MIXED':'ACL_STATE_OTHER',['paper_capital_model_now_ms:EXECUTE_ENTRY_NEEDS_INCLUDE_EXECUTE']);
    }
    if(!before.ok)refuse('RUNTIME_ROLE_INSPECTION_FAILED',before.failures.map(labelOf));
    const names=[MARKER_TABLE,DECLARATION_TABLE];
    const digestBefore=(await db.query(QUERIES.DIGEST,[names,includeExecute])).rows[0];
    const wanted=grant?'EXACT':'NONE',scope=[MARKER_TABLE,DECLARATION_TABLE,...(includeExecute?['function']:[])];
    // Both objects (and the function when in scope) move together in one transaction, so a half state can only come from outside: refuse it.
    if(new Set(scope.map(key=>aclBefore.states[key])).size!==1)refuse('ACL_STATE_MIXED');
    let statements=0;
    if(aclBefore.states[MARKER_TABLE]!==wanted){
      await db.query(STATEMENTS.SET_ROLE,[roleName]);
      const plan=[grant?'GRANT_MARKER':'REVOKE_MARKER',grant?'GRANT_DECLARATIONS':'REVOKE_DECLARATIONS',...(includeExecute?[grant?'GRANT_EXECUTE':'REVOKE_EXECUTE']:[])];
      for(const statement of plan){await db.query(STATEMENTS[statement]);statements++;}
    }
    // Verification: any failure throws and the transaction rolls back.
    const after=await readStates(db,{roleOid:role.oid,includeExecute});
    if(after.reasons.length||scope.some(key=>after.states[key]!==wanted))refuse('VERIFY_ACL_STATE',[action]);
    const held=(await db.query(QUERIES.PRIVILEGES,[roleName])).rows[0];
    if(grant){
      if(held.marker_select!==true||held.declarations_select!==true||held.declarations_insert!==true||held.marker_insert!==false)refuse('VERIFY_PRIVILEGES',[action]);
      // The runtime path calls paper_capital_model_now_ms(): a grant that leaves it without EXECUTE (default privileges removed PUBLIC, no explicit entry) is refused.
      if(held.function_execute!==true)refuse('VERIFY_EXECUTE',[action]);
    }else{
      if(held.marker_select||held.marker_insert||held.declarations_select||held.declarations_insert)refuse('VERIFY_PRIVILEGES',[action]);
      if(includeExecute&&held.function_execute)refuse('VERIFY_EXECUTE',[action]);
    }
    const inspected=await inspect(db,{runtimeRole:roleName,requireGrants:grant});
    if(!inspected.ok||inspected.facts.state!=='INSTALLED')refuse('VERIFY_INSPECTION',inspected.failures.map(labelOf));
    const digestAfter=(await db.query(QUERIES.DIGEST,[names,includeExecute])).rows[0];
    if(digestAfter.digest!==digestBefore.digest||digestAfter.relations!==digestBefore.relations)refuse('VERIFY_OTHER_ACL_CHANGED');
    return {action:action.toLowerCase(),changed:statements>0,statements,before:labels(aclBefore.states),after:labels(after.states),execute_in_scope:includeExecute===true,
      inspection_ok:inspected.ok,other_relations:digestAfter.relations,other_acl_unchanged:true};
  });
}

async function run(db,action,{runtimeRole,includeExecute=false}={},{inspect=inspectPaperCapitalModel}={}){
  if(typeof runtimeRole!=='string'||!RUNTIME_ROLE_TEXT.test(runtimeRole)||Buffer.byteLength(runtimeRole,'utf8')>63)throw new PaperCapitalModelGrantRefusal('RUNTIME_ROLE_INVALID');
  if(typeof includeExecute!=='boolean')throw new PaperCapitalModelGrantRefusal('OPTION_INVALID');
  try{return await apply(db,{action,roleName:runtimeRole,includeExecute,inspect});}
  catch(error){
    if(error instanceof PaperCapitalModelGrantRefusal)throw error;
    // A driver message can name the role or the host: only the SQLSTATE leaves.
    throw new PaperCapitalModelGrantRefusal('DATABASE_ERROR',[String(error?.code??'UNKNOWN')]);
  }
}
/** Grants exactly the privileges above to runtimeRole in one transaction, or passes as a no-op over the exact state. includeExecute only when B0 showed that default privileges removed PUBLIC EXECUTE. deps.inspect exists for the unit tests only. */
export const grantPaperCapitalModelRuntime=(db,options,deps)=>run(db,'GRANT',options,deps);
/** The exact reverse of the grant (pass the same includeExecute). */
export const revokePaperCapitalModelRuntime=(db,options,deps)=>run(db,'REVOKE',options,deps);
