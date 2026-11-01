import {MARKER_TABLE,DECLARATION_TABLE} from './paper-capital-model-migration.js';
import {QUERIES,classifyAcl,PaperCapitalModelGrantRefusal} from './paper-capital-model-grants.js';

/**
 * QR-2 S4 paper capital model: the READ-ONLY grant-state read and the pre-M6 ACL digest (set B, packet draft section 4.4, K1, K12; rulings SB8 N-P3-1, SB9 N3-P3-2).
 * The accepted grant module (paper-capital-model-grants.js) has no read-only mode and is not changed. This module reuses only its exports: the ACL
 * queries (the function name is embedded in QUERIES.FUNCTION_ACL), classifyAcl and the refusal class. It never takes the maintenance lock, never writes, never changes the session role and
 * never issues a statement that is not a SELECT, SET TRANSACTION READ ONLY or the transaction control of db.transaction.
 *
 * Both reads run in their own READ ONLY transaction (REPEATABLE READ: the ACL rows of the several catalog scans come from one snapshot; the name lookups (to_regclass, to_regprocedure, pg_has_role)
 * use the current catalog, so concurrent DDL fails safe with ACL_READ_INCONSISTENT or ABSENT, never a wrong NONE or EXACT). A db that is already inside a
 * transaction is refused: the read-only mode could not be set first, and a caller's open transaction could hold locks.
 *
 * The runtime role name is the caller's value. It reaches the database only as a bound query parameter and is never part of a statement text, a
 * returned value, a reason label, a refusal code or an error message. Every failure leaves as a PaperCapitalModelGrantRefusal that carries labels
 * only (a driver error leaves only its SQLSTATE).
 */
export const READ_ONLY_STATEMENTS=Object.freeze({
  SET_READ_ONLY:'SET TRANSACTION READ ONLY',
  CHECK_READ_ONLY:`/* pcm-grant-state:read-only */ SELECT pg_catalog.current_setting('transaction_read_only') AS value`});

/** The six public functions that M6 creates (src/postgres/paper-capital-model.sql), all without arguments; the digest excludes them by name and signature. */
export const M6_FUNCTION_SIGNATURES=Object.freeze(['paper_capital_model_version()','paper_capital_model_now_ms()','paper_capital_model_freeze()',
  'paper_capital_model_require_serializable()','paper_capital_model_stamp()','paper_capital_model_guard()']);
export const M6_TABLES=Object.freeze([MARKER_TABLE,DECLARATION_TABLE]);

/**
 * The shape of QUERIES.DIGEST (grants.js:62-72) over the same object classes, but every M6 object is excluded: both tables by name (bound $1) and all
 * six functions by name and identity arguments (bound $2, entries like 'paper_capital_model_now_ms()'). A NULL cannot appear in either array, so the
 * <>ALL filters never drop a row by accident. M6 creates no sequence.
 */
export const GRANT_STATE_QUERIES=Object.freeze({
  PRE_M6_DIGEST:`/* pcm-grant-state:digest */ SELECT pg_catalog.md5(pg_catalog.concat_ws('#',
    (SELECT COALESCE(pg_catalog.string_agg(c.oid::text||':'||c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.oid),'') FROM pg_catalog.pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S','f') AND c.relname<>ALL($1::text[])),
    (SELECT COALESCE(pg_catalog.string_agg(a.attrelid::text||':'||a.attnum::text||':'||a.attacl::text,'|' ORDER BY a.attrelid,a.attnum),'') FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL AND c.relname<>ALL($1::text[])),
    (SELECT n.nspowner::text||':'||COALESCE(n.nspacl::text,'') FROM pg_catalog.pg_namespace n WHERE n.nspname='public'),
    (SELECT COALESCE(d.datacl::text,'') FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()),
    (SELECT COALESCE(pg_catalog.string_agg(f.oid::text||':'||COALESCE(f.proacl::text,''),'|' ORDER BY f.oid),'') FROM pg_catalog.pg_proc f
      WHERE f.pronamespace='public'::regnamespace AND (f.proname||'('||pg_catalog.pg_get_function_identity_arguments(f.oid)||')')<>ALL($2::text[])),
    (SELECT COALESCE(pg_catalog.string_agg(da.oid::text||':'||COALESCE(da.defaclacl::text,''),'|' ORDER BY da.oid),'') FROM pg_catalog.pg_default_acl da))) AS digest`});

const refuse=(code,details)=>{throw new PaperCapitalModelGrantRefusal(code,details);};
const RUNTIME_ROLE_TEXT=/^[^\u0000]{1,63}$/u;
const EXECUTE_TARGET=Object.freeze(['EXECUTE']);
const TABLE_TARGETS=Object.freeze({[MARKER_TABLE]:['SELECT'],[DECLARATION_TABLE]:['INSERT','SELECT']});
export const EXECUTE_ENTRY_REASON='paper_capital_model_now_ms:EXECUTE_ENTRY_NEEDS_INCLUDE_EXECUTE';
export const OBJECTS_DIFFER_REASON='OBJECTS_IN_DIFFERENT_STATES';

/** pg returns oid columns as numbers, and the int8 cast of the ACL entries inside the JSON gives numbers too (as in grants.js:116-117). */
const isOid=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const entriesAreOids=entries=>Array.isArray(entries)&&entries.every(entry=>Array.isArray(entry)&&isOid(entry[0])&&isOid(entry[1]));

/** One READ ONLY transaction on the caller's db. Read-only mode is set first and then read back; anything but 'on' refuses. */
async function readOnly(db,work){
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
    if(error instanceof PaperCapitalModelGrantRefusal)throw error;
    // A driver message can name the role or the host: only the SQLSTATE leaves.
    throw new PaperCapitalModelGrantRefusal('DATABASE_ERROR',[String(error?.code??'UNKNOWN')]);
  }
}

async function readState(db,{roleName,includeExecute}){
  const role=(await db.query(QUERIES.ROLE,[roleName])).rows[0];
  if(!role)refuse('RUNTIME_ROLE_MISSING');
  // As the grant module (grants.js:147-148): such a role bypasses ACLs, so the classification below would mean nothing.
  if(role.superuser)refuse('RUNTIME_ROLE_SUPERUSER');
  if(role.bypass_rls)refuse('RUNTIME_ROLE_BYPASSRLS');
  if(!isOid(role.oid))refuse('ACL_OID_TYPE');
  const tables=(await db.query(QUERIES.TABLES,[roleName])).rows;
  const acl=(await db.query(QUERIES.TABLE_ACL)).rows;
  const fn=(await db.query(QUERIES.FUNCTION_ACL)).rows[0];
  const objects={marker:'ABSENT',declarations:'ABSENT',function:'ABSENT'},reasons=[];
  let present=0;
  for(const [key,name] of [['marker',MARKER_TABLE],['declarations',DECLARATION_TABLE]]){
    const row=acl.find(item=>item.name===name);
    if(!row)continue;
    present++;
    const facts=tables.find(item=>item.name===name);
    if(!facts)refuse('ACL_READ_INCONSISTENT');
    if(!isOid(row.owner_oid)||!entriesAreOids(row.entries)||!isOid(facts.owner_oid))refuse('ACL_OID_TYPE');
    // As the grant module (grants.js:154): a runtime role that owns the table, or is a member of its owner, makes the ACL classification meaningless.
    if(row.owner_oid===role.oid||facts.runtime_member!==false)refuse('RUNTIME_ROLE_IS_OWNER');
    const result=classifyAcl({entries:row.entries,columnAcl:row.column_acl,ownerOid:row.owner_oid,runtimeOid:role.oid,wanted:TABLE_TARGETS[name]});
    objects[key]=result.state;if(result.reason)reasons.push(name+':'+result.reason);
  }
  let functionEntry=false;
  if(fn){
    present++;
    if(!isOid(fn.owner_oid)||!entriesAreOids(fn.entries))refuse('ACL_OID_TYPE');
    if(fn.owner_oid===role.oid)refuse('RUNTIME_ROLE_IS_OWNER');
    functionEntry=fn.entries.some(entry=>entry[1]===role.oid);
    objects.function='NOT_IN_SCOPE';
    if(includeExecute){
      const result=classifyAcl({entries:fn.entries,ownerOid:fn.owner_oid,runtimeOid:role.oid,wanted:EXECUTE_TARGET});
      objects.function=result.state;if(result.reason)reasons.push('paper_capital_model_now_ms:'+result.reason);
    }
  }
  // Absence is a state, never a throw: M6 is ABSENT when any of its two tables or its function is missing. The objects that do exist keep their own classification.
  if(present<3)return {state:'ABSENT',objects,reasons:[present===0?'M6_ABSENT':'M6_PARTIAL',...reasons],executeInScope:includeExecute};
  const scope=[objects.marker,objects.declarations,...(includeExecute?[objects.function]:[])];
  let state;
  if(scope.includes('OTHER'))state='OTHER';
  else if(!includeExecute&&functionEntry){
    // grants.js:181-184: an explicit runtime EXECUTE entry is outside the scope of a call without includeExecute; it is a half state, never NONE.
    state='MIXED';reasons.push(EXECUTE_ENTRY_REASON);
  }else if(new Set(scope).size!==1){state='MIXED';reasons.push(OBJECTS_DIFFER_REASON);}
  else state=scope[0];
  return {state,objects,reasons,executeInScope:includeExecute};
}

/**
 * The ACL state of the M6 objects for one runtime role, read only. Returns {state,objects:{marker,declarations,function},reasons,executeInScope}:
 *   state ABSENT  an M6 table or the function is missing (partial or absent); never a refusal;
 *   state NONE    every object in scope has owner entries only;  EXACT  every object in scope holds exactly the grant module's target entries;
 *   state OTHER   any object in scope is OTHER (reasons name the table or function and the grant module's reason label);
 *   state MIXED   objects in scope are in different states, or (without includeExecute) the runtime role holds an explicit EXECUTE entry on
 *                 paper_capital_model_now_ms() while no object is OTHER.
 * objects.function is NOT_IN_SCOPE without includeExecute. ABSENT covers only the two tables and paper_capital_model_now_ms(); whether the other five
 * M6 functions exist is the M6 --inspect judgement, not this read's. Refusals (labels only): DATABASE_INVALID, RUNTIME_ROLE_INVALID, OPTION_INVALID,
 * NOT_OWN_TRANSACTION, RUNTIME_ROLE_MISSING, RUNTIME_ROLE_SUPERUSER, RUNTIME_ROLE_BYPASSRLS, RUNTIME_ROLE_IS_OWNER, ACL_OID_TYPE, ACL_READ_INCONSISTENT, READ_ONLY_NOT_ENFORCED, DATABASE_ERROR (SQLSTATE only).
 */
export async function readPaperCapitalModelGrantState(db,{runtimeRole,includeExecute=false}={}){
  if(typeof runtimeRole!=='string'||!RUNTIME_ROLE_TEXT.test(runtimeRole)||Buffer.byteLength(runtimeRole,'utf8')>63)throw new PaperCapitalModelGrantRefusal('RUNTIME_ROLE_INVALID');
  if(typeof includeExecute!=='boolean')throw new PaperCapitalModelGrantRefusal('OPTION_INVALID');
  return readOnly(db,()=>readState(db,{roleName:runtimeRole,includeExecute}));
}

/**
 * The ACL digest of everything that exists before M6: relations, column ACLs, the schema, the database, the public functions and the default ACLs,
 * with both M6 tables and all six M6 functions excluded. Installing M6 does not change it; a grant on any other object does. Returns {digest}.
 * Refusals (labels only): DATABASE_INVALID, NOT_OWN_TRANSACTION, READ_ONLY_NOT_ENFORCED, DIGEST_TYPE, DATABASE_ERROR (SQLSTATE only).
 */
export async function preM6AclDigest(db){
  return readOnly(db,async()=>{
    const row=(await db.query(GRANT_STATE_QUERIES.PRE_M6_DIGEST,[[...M6_TABLES],[...M6_FUNCTION_SIGNATURES]])).rows[0];
    if(typeof row?.digest!=='string'||!/^[0-9a-f]{32}$/.test(row.digest))refuse('DIGEST_TYPE');
    return {digest:row.digest};
  });
}
