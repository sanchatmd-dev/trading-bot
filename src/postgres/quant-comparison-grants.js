import {inspectQuantExposureRegister} from './quant-exposure-register-migration.js';
import {inspectQuantComparison} from './quant-comparison-migration.js';
import {ALL_TABLES,TARGET_PRIVILEGES,GROUPS,QuantComparisonGrantRefusal,refuse,validRuntimeRole,readOnly,readRole,readTableFacts,readGrantStateIn,readHeldPrivileges,
  readDigestIn} from './quant-comparison-grant-state.js';

export {QuantComparisonGrantRefusal,TARGET_PRIVILEGES,GROUPS,ALL_TABLES,SERVER_TARGET_QUERY,sameServerTarget} from './quant-comparison-grant-state.js';

/**
 * QR-3 set C step SC-7: the targeted runtime grant of the exposure register and QR-3 comparison tables, and its exact reverse. Offline only: one
 * transaction under the maintenance try-lock, so every participating API and worker must be stopped. The repository grant script
 * (scripts/grant-postgres-runtime.sql) is NOT used on staging because it changes the grants of every table and the schema; this module changes
 * exactly these ACL entries and nothing else (TARGET_PRIVILEGES):
 *   GRANT SELECT                  ON quant_exposure_register_schema, quant_comparison_schema
 *   GRANT SELECT, INSERT, UPDATE  ON quant_exposure_register   (UPDATE only carries the writer's LOCK TABLE; a trigger refuses every row UPDATE)
 *   GRANT SELECT, INSERT          ON the seven quant_comparison_* record tables
 * No DELETE, TRUNCATE or TRIGGER, no grant option, column grant, sequence, function, schema, default-privilege, PUBLIC or other-table change. The revoke
 * is the exact reverse.
 *
 * The runtime role name is the caller's value (the CLI reads it in process from the runtime connection with current_user). It reaches the database
 * only as a bound parameter of one transaction-local setting and is quoted there with format('%I'); it is never put into statement text, never
 * returned, never printed and never part of an error message. Every failure leaves as a QuantComparisonGrantRefusal that carries labels only.
 *
 * Classification comes first (quant-comparison-grant-state.js): NONE (owner entries only on all ten tables), EXACT (owner entries plus exactly the
 * target entries, granted by the owner, without grant option, on all ten), OTHER (any other grantee, a PUBLIC entry, a grant option, another grantor,
 * another privilege set or a column grant on any table) or MIXED (no table OTHER, but the tables differ). OTHER and MIXED refuse with no write. Grant:
 * NONE applies, EXACT is a no-op pass. Revoke: EXACT applies, NONE is a no-op pass. Both extensions must be exactly INSTALLED, judged by the existing
 * inspections. Everything is verified before COMMIT, including the ACL digest of every object outside the two extensions; any failure rolls back.
 */
export const GRANT_SETTING='robot.qcg_grant_role';
const LOCK_MESSAGE='Stop every PostgreSQL API and worker before maintenance';

/** One entry per distinct privilege set, in table order: the statements are built from TARGET_PRIVILEGES so they cannot drift from it. */
const PLAN=(()=>{
  const sets=new Map();
  for(const table of ALL_TABLES){
    const key=TARGET_PRIVILEGES[table].join(', ');
    if(!sets.has(key))sets.set(key,{privileges:key,tables:[]});
    sets.get(key).tables.push(table);
  }
  return [...sets.values()].map(item=>({...item,list:item.tables.map(table=>'public.'+table).join(', ')}));
})();

/** Fixed statement texts. The role never appears in them: it is the bound parameter of SET_ROLE and is quoted by format('%I') inside the DO block. */
const doBlock=statement=>`DO $qcg$ BEGIN EXECUTE pg_catalog.format('${statement}',pg_catalog.current_setting('${GRANT_SETTING}')); END $qcg$`;
export const STATEMENTS=Object.freeze({
  SET_ROLE:`SELECT pg_catalog.set_config('${GRANT_SETTING}',$1::text,true) AS applied`,
  LOCK_TIMEOUT:`SET LOCAL lock_timeout = '5s'`,
  LOCK_TABLES:`LOCK TABLE ${[...ALL_TABLES].sort().map(table=>'public.'+table).join(', ')} IN ACCESS EXCLUSIVE MODE`,
  GRANT:Object.freeze(PLAN.map(item=>doBlock(`GRANT ${item.privileges} ON TABLE ${item.list} TO %I`))),
  REVOKE:Object.freeze(PLAN.map(item=>doBlock(`REVOKE ${item.privileges} ON TABLE ${item.list} FROM %I`)))});

/** A runtime-role inspection failure name may carry a role name after the colon (privileged membership); every other label is kept. */
const labelOf=failure=>String(failure).startsWith('RUNTIME_ROLE_PRIVILEGED_MEMBER')?'RUNTIME_ROLE_PRIVILEGED_MEMBER':String(failure);
const labelsOf=failures=>failures.map(labelOf).slice(0,20);
const stateLabels=state=>({register:state.groups.register,comparison:state.groups.comparison});

/** Runs the two existing inspections on db. Returns {ok,failures,register,comparison} (states of the two extensions). */
async function inspectBoth(db,{runtimeRole,requireGrants}){
  const register=await inspectQuantExposureRegister(db,{runtimeRole,requireGrants});
  const comparison=await inspectQuantComparison(db,{runtimeRole,requireGrants});
  return {ok:register.ok&&comparison.ok,failures:[...register.failures,...comparison.failures],register:register.facts.state,comparison:comparison.facts.state};
}

async function apply(db,{action,roleName,inspect}){
  if(db.isTransaction)refuse('NOT_OWN_TRANSACTION');
  const grant=action==='GRANT';
  return db.transaction(async()=>{
    try{await db.maintenanceLock();}
    catch(error){if(String(error?.message).includes(LOCK_MESSAGE))refuse('MAINTENANCE_LOCK_HELD');throw error;}
    try{await db.verifySchema();}catch(error){if(error?.code)throw error;refuse('SCHEMA_NOT_14');}
    // Early labels without any lock: the role, and who owns what. They are read again below once the table lock is held.
    await readRole(db,roleName);
    const early=await readTableFacts(db,roleName);
    if(early.length!==ALL_TABLES.length)refuse('EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
    if(early.some(table=>table.session_owns!==true))refuse('SESSION_NOT_OWNER');
    try{await db.query(STATEMENTS.LOCK_TIMEOUT);await db.query(STATEMENTS.LOCK_TABLES);}
    catch(error){
      if(error?.code==='55P03')refuse('LOCK_TABLES_TIMEOUT');
      if(error?.code==='42P01')refuse('EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
      throw error;
    }
    // Authoritative facts: read with the lock held, so no table can be dropped or re-owned between this read and the commit.
    const role=await readRole(db,roleName);
    const facts=await readTableFacts(db,roleName);
    if(facts.length!==ALL_TABLES.length)refuse('EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
    if(facts.some(table=>table.session_owns!==true))refuse('SESSION_NOT_OWNER');
    // Both extensions exactly INSTALLED, read with the existing inspections. Runtime-role facts are checked too; the grants themselves are judged below.
    const before=await inspect(db,{runtimeRole:roleName,requireGrants:false});
    if(before.register!=='INSTALLED'||before.comparison!=='INSTALLED')refuse('EXTENSION_NOT_INSTALLED',['REGISTER:'+before.register,'COMPARISON:'+before.comparison]);
    const aclBefore=await readGrantStateIn(db,roleName);
    if(aclBefore.state==='ABSENT')refuse('EXTENSION_NOT_INSTALLED',['ABSENT_OR_PARTIAL']);
    if(aclBefore.state==='OTHER')refuse('ACL_STATE_OTHER',aclBefore.reasons);
    if(aclBefore.state==='MIXED')refuse('ACL_STATE_MIXED',aclBefore.reasons);
    if(!before.ok)refuse('RUNTIME_ROLE_INSPECTION_FAILED',labelsOf(before.failures));
    const digestBefore=await readDigestIn(db);
    const wanted=grant?'EXACT':'NONE';
    let statements=0;
    if(aclBefore.state!==wanted){
      await db.query(STATEMENTS.SET_ROLE,[roleName]);
      for(const statement of grant?STATEMENTS.GRANT:STATEMENTS.REVOKE){await db.query(statement);statements++;}
    }
    // Verification: any failure throws and the transaction rolls back.
    const after=await readGrantStateIn(db,roleName);
    if(after.reasons.length||after.state!==wanted)refuse('VERIFY_ACL_STATE',[action]);
    const held=await readHeldPrivileges(db,roleName);
    for(const table of ALL_TABLES){
      const expected=grant?[...TARGET_PRIVILEGES[table]]:[];
      if(held[table].length!==expected.length||held[table].some((privilege,index)=>privilege!==expected[index]))refuse('VERIFY_PRIVILEGES',[action,table]);
    }
    const inspected=await inspect(db,{runtimeRole:roleName,requireGrants:grant});
    if(!inspected.ok||inspected.register!=='INSTALLED'||inspected.comparison!=='INSTALLED')refuse('VERIFY_INSPECTION',labelsOf(inspected.failures));
    const digestAfter=await readDigestIn(db);
    if(digestAfter.digest!==digestBefore.digest||digestAfter.relations!==digestBefore.relations)refuse('VERIFY_OTHER_ACL_CHANGED');
    return {action:action.toLowerCase(),changed:statements>0,statements,before:{...stateLabels(aclBefore),state:aclBefore.state},after:{...stateLabels(after),state:after.state},
      inspection_ok:inspected.ok,other_relations:digestAfter.relations,acl_digest_before:digestBefore.digest,acl_digest_after:digestAfter.digest,other_acl_unchanged:true};
  });
}

async function run(db,action,{runtimeRole}={},{inspect=inspectBoth}={}){
  if(!validRuntimeRole(runtimeRole))throw new QuantComparisonGrantRefusal('RUNTIME_ROLE_INVALID');
  try{return await apply(db,{action,roleName:runtimeRole,inspect});}
  catch(error){
    if(error instanceof QuantComparisonGrantRefusal)throw error;
    // A driver message can name the role or the host: only the SQLSTATE leaves.
    throw new QuantComparisonGrantRefusal('DATABASE_ERROR',[String(error?.code??'UNKNOWN')]);
  }
}
/** Grants exactly TARGET_PRIVILEGES to runtimeRole in one transaction, or passes as a no-op over the exact state. deps.inspect exists for the unit tests only. */
export const grantQuantComparisonRuntime=(db,options,deps)=>run(db,'GRANT',options,deps);
/** The exact reverse of the grant. */
export const revokeQuantComparisonRuntime=(db,options,deps)=>run(db,'REVOKE',options,deps);

/**
 * The two existing inspections on db in one READ ONLY transaction (no maintenance lock, no write), for --inspect. Returns {ok,register,comparison,failures}
 * with labels only. requireGrants true judges the target grants too.
 */
export async function inspectExtensions(db,{runtimeRole,requireGrants=false}={}){
  if(!validRuntimeRole(runtimeRole))throw new QuantComparisonGrantRefusal('RUNTIME_ROLE_INVALID');
  const result=await readOnly(db,()=>inspectBoth(db,{runtimeRole,requireGrants}));
  return {ok:result.ok,register:result.register,comparison:result.comparison,failures:labelsOf(result.failures)};
}

/**
 * The same two inspections on the runtime role's OWN connection (the CLI runs this after a committed grant), in one READ ONLY transaction. The role
 * must hold its grants for the inspections to read the marker tables, so call it with requireGrants true over an EXACT state only. Returns
 * {ok,register,comparison,failures} with labels only; a database error leaves as DATABASE_ERROR with the SQLSTATE.
 */
export const inspectAsRuntimeRole=(runtimeDb,{runtimeRole,requireGrants=true}={})=>inspectExtensions(runtimeDb,{runtimeRole,requireGrants});
