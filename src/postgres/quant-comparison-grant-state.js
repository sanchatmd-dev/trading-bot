import {MARKER_TABLE as REGISTER_MARKER_TABLE,REGISTER_TABLE} from './quant-exposure-register-migration.js';
import {MARKER_TABLE as COMPARISON_MARKER_TABLE,COMPARISON_TABLES} from './quant-comparison-migration.js';

/**
 * QR-3 set C: the READ-ONLY grant-state read, the ACL classification and the ACL digest of everything outside the exposure register and
 * QR-3 comparison extensions (packet set C section 2 SC-7, section 5.1). The writer (quant-comparison-grants.js) imports this module; this module
 * never takes the maintenance lock, never writes, never changes the session role and never issues a statement that is not a SELECT,
 * SET TRANSACTION READ ONLY or the transaction control of db.transaction.
 *
 * The runtime role gets exactly the entries in TARGET_PRIVILEGES and nothing else (no DELETE, TRUNCATE or TRIGGER, no sequence: neither SQL file
 * creates one). They equal what scripts/grant-postgres-runtime.sql leaves on these ten tables through its protected, read_only and insert_only lists
 * (the static test proves it from the script text and the real-cluster test from a script run).
 *
 * The runtime role name is the caller's value. It reaches the database only as a bound query parameter and is never part of a statement text, a
 * returned value, a reason label, a refusal code or an error message. Every failure leaves as a QuantComparisonGrantRefusal that carries labels
 * only (a driver error leaves only its SQLSTATE).
 */
export {REGISTER_MARKER_TABLE,REGISTER_TABLE,COMPARISON_MARKER_TABLE,COMPARISON_TABLES};

/** Sorted privilege sets (the order aclexplode lists them after a JavaScript sort). */
export const TARGET_PRIVILEGES=Object.freeze({
  [REGISTER_MARKER_TABLE]:Object.freeze(['SELECT']),
  // UPDATE on the register only carries the writer's LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE; a trigger refuses every row UPDATE (QR002).
  [REGISTER_TABLE]:Object.freeze(['INSERT','SELECT','UPDATE']),
  [COMPARISON_MARKER_TABLE]:Object.freeze(['SELECT']),
  ...Object.fromEntries(COMPARISON_TABLES.map(table=>[table,Object.freeze(['INSERT','SELECT'])]))});
/** The two extension groups, in the order of the packet: the register (marker, table) and the comparison (marker, seven record tables). */
export const GROUPS=Object.freeze({
  register:Object.freeze([REGISTER_MARKER_TABLE,REGISTER_TABLE]),
  comparison:Object.freeze([COMPARISON_MARKER_TABLE,...COMPARISON_TABLES])});
export const ALL_TABLES=Object.freeze([...GROUPS.register,...GROUPS.comparison]);
/** Every privilege the verification reads on each table; anything held beyond TARGET_PRIVILEGES is a failure. */
export const CHECKED_PRIVILEGES=Object.freeze(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']);

/**
 * The functions the two SQL files create, as name(identity arguments). The digest below excludes them so that installing the extensions does not
 * change it. A static test compares this list with the CREATE FUNCTION statements of both SQL files.
 */
export const EXTENSION_FUNCTION_SIGNATURES=Object.freeze([
  'quant_exposure_register_version()','quant_exposure_register_insert_only()','quant_exposure_register_serializable_insert()',
  'quant_comparison_version()','quant_comparison_in_this_transaction(row_xmin xid)','quant_comparison_insert_only()','quant_comparison_require_serializable()',
  'quant_comparison_guard_spec()','quant_comparison_guard_participant()','quant_comparison_guard_status_event()','quant_comparison_check_create()',
  'quant_comparison_guard_evaluation()','quant_comparison_guard_benchmark()','quant_comparison_guard_outcome()','quant_comparison_guard_replay_event()',
  'quant_comparison_check_outcome()']);

export const READ_ONLY_STATEMENTS=Object.freeze({
  SET_READ_ONLY:'SET TRANSACTION READ ONLY',
  CHECK_READ_ONLY:`/* qcg-state:read-only */ SELECT pg_catalog.current_setting('transaction_read_only') AS value`});

/** Read-only queries. Each starts with a tag comment. */
export const QUERIES=Object.freeze({
  ROLE:`/* qcg:role */ SELECT r.oid AS oid,r.rolsuper AS superuser,r.rolbypassrls AS bypass_rls FROM pg_catalog.pg_roles r WHERE r.rolname=$1::name`,
  TABLES:`/* qcg:tables */ SELECT c.relname AS name,c.relowner AS owner_oid,pg_catalog.pg_has_role(c.relowner,'USAGE') AS session_owns,
    pg_catalog.pg_has_role($1::name,c.relowner,'MEMBER') AS runtime_member
    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
  TABLE_ACL:`/* qcg:table-acl */ SELECT c.relname AS name,c.relowner AS owner_oid,
    (SELECT COALESCE(pg_catalog.json_agg(pg_catalog.json_build_array(x.grantor::pg_catalog.int8,x.grantee::pg_catalog.int8,x.privilege_type,x.is_grantable) ORDER BY x.grantee,x.privilege_type,x.grantor),'[]'::json)
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x) AS entries,
    EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS column_acl
    FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
  PRIVILEGES:`/* qcg:privileges */ SELECT n.name AS name,p.privilege AS privilege,
    (pg_catalog.has_table_privilege($1::name,pg_catalog.format('public.%I',n.name),p.privilege)
      OR (p.privilege IN ('SELECT','INSERT','UPDATE') AND pg_catalog.has_any_column_privilege($1::name,pg_catalog.format('public.%I',n.name),p.privilege))) AS held
    FROM pg_catalog.unnest($2::text[]) AS n(name) CROSS JOIN pg_catalog.unnest($3::text[]) AS p(privilege) ORDER BY n.name,p.privilege`,
  /**
   * The ACL of every object outside the two extensions: public relations, column ACLs, the schema, the database, public functions and the default ACLs,
   * with the ten extension tables (bound $1) and the sixteen extension functions (bound $2, name(identity arguments)) excluded. Installing either
   * extension does not change it; a grant on any other object does.
   */
  DIGEST:`/* qcg:digest */ SELECT pg_catalog.md5(pg_catalog.concat_ws('#',
    (SELECT COALESCE(pg_catalog.string_agg(c.oid::text||':'||c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.oid),'') FROM pg_catalog.pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>ALL($1::text[])),
    (SELECT COALESCE(pg_catalog.string_agg(a.attrelid::text||':'||a.attnum::text||':'||a.attacl::text,'|' ORDER BY a.attrelid,a.attnum),'') FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL AND c.relname<>ALL($1::text[])),
    (SELECT n.nspowner::text||':'||COALESCE(n.nspacl::text,'') FROM pg_catalog.pg_namespace n WHERE n.nspname='public'),
    (SELECT COALESCE(d.datacl::text,'') FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()),
    (SELECT COALESCE(pg_catalog.string_agg(f.oid::text||':'||COALESCE(f.proacl::text,''),'|' ORDER BY f.oid),'') FROM pg_catalog.pg_proc f
      WHERE f.pronamespace='public'::regnamespace AND (f.proname||'('||pg_catalog.pg_get_function_identity_arguments(f.oid)||')')<>ALL($2::text[])),
    (SELECT COALESCE(pg_catalog.string_agg(da.oid::text||':'||COALESCE(da.defaclacl::text,''),'|' ORDER BY da.oid),'') FROM pg_catalog.pg_default_acl da))) AS digest,
    (SELECT count(*)::int FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>ALL($1::text[])) AS relations`});

/**
 * The server a connection reached, read the same way on the owner connection and on the runtime connection (the CLI compares them in process and
 * never prints a value): database, the server's port setting and the postmaster start time. The runtime role may run all of it.
 */
export const SERVER_TARGET_QUERY=`/* qcg:target */ SELECT pg_catalog.current_database()::text AS database,pg_catalog.current_setting('port') AS port,
    extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text AS started`;
export const sameServerTarget=(a,b)=>['database','port','started'].every(key=>typeof a?.[key]==='string'&&a[key].length>0&&a[key]===b?.[key]);

/** Labels only. A refusal never carries the role name, a pg message, a host or a path. */
export class QuantComparisonGrantRefusal extends Error {
  constructor(code,details=[]){
    super('Quant comparison grant refused: '+[code,...details].join(', ')+' (no change made)');
    this.name='QuantComparisonGrantRefusal';this.code=code;this.details=[...details];
  }
}
export const refuse=(code,details)=>{throw new QuantComparisonGrantRefusal(code,details);};
export const RUNTIME_ROLE_TEXT=/^[^\u0000]{1,63}$/u;
export const validRuntimeRole=value=>typeof value==='string'&&RUNTIME_ROLE_TEXT.test(value)&&Buffer.byteLength(value,'utf8')<=63;

/**
 * Pure ACL classification of one object. entries is [[grantor,grantee,privilege,grantable],...] as aclexplode lists them (grantee 0 is PUBLIC);
 * owner entries are ignored. Returns {state:'NONE'|'EXACT'|'OTHER', reason}. wanted is a sorted privilege list.
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
export const isOid=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const entriesAreOids=entries=>Array.isArray(entries)&&entries.every(entry=>Array.isArray(entry)&&isOid(entry[0])&&isOid(entry[1]));

/** One READ ONLY transaction on the caller's db. Read-only mode is set first and then read back; anything but 'on' refuses. */
export async function readOnly(db,work){
  if(typeof db?.transaction!=='function'||typeof db?.query!=='function')refuse('DATABASE_INVALID');
  if(db.isTransaction)refuse('NOT_OWN_TRANSACTION');
  try{
    return await db.transaction(async()=>{
      await db.query(READ_ONLY_STATEMENTS.SET_READ_ONLY);
      const mode=(await db.query(READ_ONLY_STATEMENTS.CHECK_READ_ONLY)).rows[0];
      if(mode?.value!=='on')refuse('READ_ONLY_NOT_ENFORCED');
      return await work();
    },{isolation:'REPEATABLE READ'});
  }catch(error){
    if(error instanceof QuantComparisonGrantRefusal)throw error;
    // A driver message can name the role or the host: only the SQLSTATE leaves.
    throw new QuantComparisonGrantRefusal('DATABASE_ERROR',[String(error?.code??'UNKNOWN')]);
  }
}

/** The role row. Throws a refusal; a superuser or BYPASSRLS role bypasses ACLs, so a classification would mean nothing. */
export async function readRole(db,roleName){
  const role=(await db.query(QUERIES.ROLE,[roleName])).rows[0];
  if(!role)refuse('RUNTIME_ROLE_MISSING');
  if(role.superuser)refuse('RUNTIME_ROLE_SUPERUSER');
  if(role.bypass_rls)refuse('RUNTIME_ROLE_BYPASSRLS');
  if(!isOid(role.oid))refuse('ACL_OID_TYPE');
  return role;
}

/** The ownership facts of the extension tables that exist, ordered by name. */
export async function readTableFacts(db,roleName){
  const tables=(await db.query(QUERIES.TABLES,[roleName,[...ALL_TABLES]])).rows;
  if(tables.some(table=>!isOid(table.owner_oid)))refuse('ACL_OID_TYPE');
  return tables;
}

const groupState=states=>states.includes('OTHER')?'OTHER':new Set(states).size===1?states[0]:'MIXED';

/**
 * The classification inside the caller's transaction (the writer reads it with its table lock held). Returns
 * {state,groups:{register,comparison},objects:{table:state},reasons}:
 *   state ABSENT  a table of either group is missing (partial or absent); never a refusal here;
 *   state NONE    every table has owner entries only;   EXACT  every table holds exactly its TARGET_PRIVILEGES entries;
 *   state OTHER   any table is OTHER (reasons name the table and the label);
 *   state MIXED   no table is OTHER, but the tables are in different states.
 * groups.register and groups.comparison use the same labels (ABSENT, NONE, EXACT, OTHER, MIXED).
 */
export async function readGrantStateIn(db,roleName){
  const role=await readRole(db,roleName);
  const tables=await readTableFacts(db,roleName);
  const acl=(await db.query(QUERIES.TABLE_ACL,[[...ALL_TABLES]])).rows;
  const objects={},reasons=[];
  for(const name of ALL_TABLES){
    const row=acl.find(item=>item.name===name);
    if(!row){objects[name]='ABSENT';continue;}
    const facts=tables.find(item=>item.name===name);
    if(!facts)refuse('ACL_READ_INCONSISTENT');
    if(!isOid(row.owner_oid)||!entriesAreOids(row.entries))refuse('ACL_OID_TYPE');
    // A runtime role that owns the table, or is a member of its owner, makes the ACL classification meaningless.
    if(row.owner_oid===role.oid||facts.runtime_member!==false)refuse('RUNTIME_ROLE_IS_OWNER');
    const result=classifyAcl({entries:row.entries,columnAcl:row.column_acl,ownerOid:row.owner_oid,runtimeOid:role.oid,wanted:TARGET_PRIVILEGES[name]});
    objects[name]=result.state;if(result.reason)reasons.push(name+':'+result.reason);
  }
  const groups={};
  for(const [key,names] of Object.entries(GROUPS)){
    const states=names.map(name=>objects[name]);
    if(states.includes('ABSENT')){groups[key]='ABSENT';reasons.push(key.toUpperCase()+'_ABSENT_OR_PARTIAL');}
    else groups[key]=groupState(states);
  }
  let state;
  if(Object.values(groups).includes('ABSENT'))state='ABSENT';
  else if(Object.values(groups).includes('OTHER'))state='OTHER';
  else if(groups.register===groups.comparison&&['NONE','EXACT'].includes(groups.register))state=groups.register;
  else{state='MIXED';reasons.push(groups.register==='MIXED'||groups.comparison==='MIXED'?'OBJECTS_IN_DIFFERENT_STATES':'GROUPS_IN_DIFFERENT_STATES');}
  return {state,groups,objects,reasons};
}

/**
 * The ACL state of the ten tables for one runtime role, read only (own READ ONLY transaction, REPEATABLE READ). Refusals (labels only):
 * DATABASE_INVALID, RUNTIME_ROLE_INVALID, NOT_OWN_TRANSACTION, RUNTIME_ROLE_MISSING, RUNTIME_ROLE_SUPERUSER, RUNTIME_ROLE_BYPASSRLS, RUNTIME_ROLE_IS_OWNER,
 * ACL_OID_TYPE, ACL_READ_INCONSISTENT, READ_ONLY_NOT_ENFORCED, DATABASE_ERROR (SQLSTATE only).
 */
export async function readQuantComparisonGrantState(db,{runtimeRole}={}){
  if(!validRuntimeRole(runtimeRole))throw new QuantComparisonGrantRefusal('RUNTIME_ROLE_INVALID');
  return readOnly(db,()=>readGrantStateIn(db,runtimeRole));
}

/** The privileges the role holds on each of the ten tables (table or any column), keyed by table: sorted lists over CHECKED_PRIVILEGES. */
export async function readHeldPrivileges(db,roleName){
  const rows=(await db.query(QUERIES.PRIVILEGES,[roleName,[...ALL_TABLES],[...CHECKED_PRIVILEGES]])).rows;
  const held=Object.fromEntries(ALL_TABLES.map(name=>[name,[]]));
  for(const row of rows){
    if(typeof row.held!=='boolean'||!held[row.name])refuse('PRIVILEGE_TYPE');
    if(row.held)held[row.name].push(row.privilege);
  }
  for(const name of ALL_TABLES)held[name].sort();
  return held;
}

/** The digest query inside the caller's transaction. Returns {digest,relations}. */
export async function readDigestIn(db){
  const row=(await db.query(QUERIES.DIGEST,[[...ALL_TABLES],[...EXTENSION_FUNCTION_SIGNATURES]])).rows[0];
  if(typeof row?.digest!=='string'||!/^[0-9a-f]{32}$/.test(row.digest)||!Number.isInteger(row.relations))refuse('DIGEST_TYPE');
  return {digest:row.digest,relations:row.relations};
}

/**
 * The ACL digest of everything outside the two extensions (see QUERIES.DIGEST). Installing or removing either extension does not change it; a grant on
 * any other object does. Returns {digest,relations}. Refusals (labels only): DATABASE_INVALID, NOT_OWN_TRANSACTION, READ_ONLY_NOT_ENFORCED, DIGEST_TYPE,
 * DATABASE_ERROR (SQLSTATE only).
 */
export const outsideExtensionsAclDigest=db=>readOnly(db,()=>readDigestIn(db));
