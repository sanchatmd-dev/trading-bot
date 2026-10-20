import fs from 'node:fs/promises';
import {inspectRuntimeRole} from './runtime-role-inspection.js';

/**
 * QR-1b terminal-result freeze. Offline only: the maintenance lock excludes every participating API and worker.
 * The freeze is its own SQL file, applied separately from the version-1 extensions, adds no table and changes no grant.
 *
 * FZ2: both directions CLASSIFY the live catalog before they write anything. The SQL uses CREATE OR REPLACE, so an unclassified
 * install would silently overwrite a foreign object that carries a freeze name. The accepted states are:
 *   ABSENT        no freeze function and no freeze trigger exists (the marker function is missing too);
 *   FROZEN        every object is exactly the freeze SQL for every table that exists, FOUNDATION guards included;
 *   FROZEN_LEGACY every legacy object is exact and no FOUNDATION object exists (either the FOUNDATION tables do not exist yet, or
 *                 they exist and the install has not run since). A second install converges it to FROZEN.
 * Anything else (partial, tampered body, extra function setting, SECURITY DEFINER, disabled trigger, changed trigger shape, foreign
 * trigger on a freeze function, overload or orphan with a freeze name, a guarded table or freeze function owned by a role other than the
 * owner of the anchor table quant_jobs: OWNER_MISMATCH:<name>) is OTHER and is refused with no write.
 * Run the install as the owner of quant_jobs: the freeze functions are created by the current user, so any other user (a superuser included)
 * is refused before any write, and the tables would otherwise be owned by a role other than the one that created the freeze.
 * Install on FROZEN is a no-op. Rollback on ABSENT is a no-op. Rollback only drops the objects the install created.
 */
export const FREEZE_MARKER='quant-research-freeze-v1';
export const FREEZE_SQLSTATE='QR001';
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
const TABLES=['quant_jobs','quant_job_steps','quant_research_foundation','quant_research_chunks'];
const LEGACY_TABLES=['quant_jobs','quant_job_steps'];
export const FREEZE_GUARDS=Object.freeze([
 ['quant_jobs','quant_job_terminal_freeze','quant_research_freeze_job_update'],
 ['quant_jobs','quant_job_terminal_no_delete','quant_research_freeze_job_delete'],
 ['quant_job_steps','quant_job_step_terminal_insert','quant_research_freeze_step_insert'],
 ['quant_research_foundation','quant_research_binding_terminal_insert','quant_research_freeze_step_insert'],
 ['quant_research_chunks','quant_research_chunk_terminal_insert','quant_research_freeze_step_insert'],
 ['quant_research_chunks','quant_research_chunk_terminal_freeze','quant_research_freeze_chunk_change']]);
const FUNCTIONS=['quant_research_freeze_version','quant_research_status_is_terminal','quant_research_freeze_job_update','quant_research_freeze_job_delete',
 'quant_research_freeze_step_insert','quant_research_freeze_chunk_change'];
// The chunk guard function exists only with the FOUNDATION extension; every other function is legacy.
const CHUNK_FUNCTION='quant_research_freeze_chunk_change';
// The ownership anchor: every guarded table and every freeze function must have the owner of quant_jobs (the freeze has no table of its own).
const ANCHOR_TABLE='quant_jobs';
// pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16. Every guard is a BEFORE row trigger.
const GUARD_TGTYPE=Object.freeze({quant_job_terminal_freeze:19,quant_job_terminal_no_delete:11,quant_job_step_terminal_insert:7,
 quant_research_binding_terminal_insert:7,quant_research_chunk_terminal_insert:7,quant_research_chunk_terminal_freeze:27});
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as the other guard installers: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function exists(db,table){return (await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;}
async function requireExtension(db){
  if(!await exists(db,'quant_job_schema'))throw Error('Quant research extension 1 required');
  const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported quant_job_schema version');
}

/** Trusted release text: signature, language, volatility and body of every function, read from the freeze SQL file itself. */
async function expectedFunctions(){
  const text=await sql('quant-research-freeze.sql'),out={};
  for(const name of FUNCTIONS){
    const match=new RegExp('CREATE OR REPLACE FUNCTION public\\.'+name+'\\(([^)]*)\\) RETURNS (\\w+)\\s+LANGUAGE (\\w+)( IMMUTABLE)? SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(text);
    if(!match)throw Error('Freeze definition not found: '+name);
    out[name]={args:match[1].trim().toLowerCase(),returns:match[2].toLowerCase(),language:match[3].toLowerCase(),volatility:match[4]?'i':'v',body:match[5]};
  }
  return out;
}

const FUNCTION_ROWS=`SELECT p.oid,p.proowner,p.proname,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.proisstrict,p.proretset,p.prokind,p.proparallel,
  l.lanname,p.prorettype::regtype::text AS returns,pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) ORDER BY p.proname,p.oid`;
// Triggers that carry a freeze name on any table, and triggers bound to a freeze function under any name.
const TRIGGER_ROWS=`SELECT t.tgname,c.relname,n.nspname,t.tgfoid,p.proname,pn.nspname AS function_schema,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual IS NOT NULL AS has_qual,
  t.tgnargs,octet_length(t.tgargs) AS args_length,t.tgattr::text AS columns,t.tgconstraint,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE t.tgname=ANY($1) OR (pn.nspname='public' AND p.proname=ANY($2)) ORDER BY t.tgname,c.relname`;

/** Reasons a function row differs from the freeze SQL; an empty list means exact. */
function functionDifferences(row,expected){
  const reasons=[];
  if(row.prosecdef!==false)reasons.push('SECURITY_DEFINER');
  if(!(Array.isArray(row.proconfig)&&row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))reasons.push('SEARCH_PATH');
  if(normalize(row.prosrc)!==normalize(expected.body))reasons.push('BODY');
  if(row.lanname!==expected.language||row.returns.toLowerCase()!==expected.returns||row.provolatile!==expected.volatility||row.proleakproof!==false
    ||row.proisstrict!==false||row.proretset!==false||row.prokind!=='f'||row.proparallel!=='u')reasons.push('ATTRIBUTES');
  return reasons;
}

/**
 * Read-only exact classification of every freeze object. state is ABSENT, FROZEN, FROZEN_LEGACY or OTHER. problems lists present
 * objects that are not exactly the freeze SQL, missing lists expected objects that do not exist. Never calls a freeze function.
 */
export async function classifyQuantResearchFreeze(db){
  const bodies=await expectedFunctions(),tables=[];
  for(const table of TABLES)if(await exists(db,table))tables.push(table);
  const functions=(await db.query(FUNCTION_ROWS,[FUNCTIONS])).rows;
  const triggers=(await db.query(TRIGGER_ROWS,[FREEZE_GUARDS.map(guard=>guard[1]),FUNCTIONS])).rows;
  const problems=[],missing=[],exact={},legacyMissing=[],foundationMissing=[];
  // Cross-lane rule: every guarded table that exists and every freeze function is owned by the owner of the anchor table, so a re-owned object
  // (whose owner could disable its triggers or replace it) is never classified as the release text. Judged only when the anchor table exists.
  const owners=new Map((await db.query(`SELECT c.relname,c.relowner FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relname=ANY($1)`,[TABLES])).rows
    .map(row=>[row.relname,row.relowner]));
  const anchorOwner=owners.get(ANCHOR_TABLE)??null;
  // The anchor must be an ordinary table; when it is not (missing, a view, a partitioned table), the ownership check cannot run and that is a problem, never a silent skip.
  if(anchorOwner===null)problems.push('OWNER_ANCHOR_UNAVAILABLE:'+ANCHOR_TABLE);
  else{
    for(const table of tables)if(owners.get(table)!==anchorOwner)problems.push('OWNER_MISMATCH:'+table);
    for(const row of functions)if(row.proowner!==anchorOwner)problems.push('OWNER_MISMATCH:'+row.proname);
  }
  let foundationExpected=0;
  for(const row of functions){
    const expected=bodies[row.proname];
    if(row.proname===CHUNK_FUNCTION&&!tables.includes('quant_research_chunks')||row.args.toLowerCase()!==expected.args){
      problems.push('FUNCTION_UNEXPECTED:'+row.proname+'('+row.args+')');continue;
    }
    const reasons=functionDifferences(row,expected);
    if(reasons.length)problems.push('FUNCTION_DEFINITION:'+row.proname+':'+reasons.join('+'));
    else exact[row.proname]=row.oid;
  }
  for(const name of FUNCTIONS){
    const foundation=name===CHUNK_FUNCTION;
    if(foundation&&!tables.includes('quant_research_chunks'))continue;
    if(foundation)foundationExpected++;
    if(!functions.some(row=>row.proname===name&&row.args.toLowerCase()===bodies[name].args))(foundation?foundationMissing:legacyMissing).push('FUNCTION_MISSING:'+name);
  }
  for(const row of triggers){
    const guard=FREEZE_GUARDS.find(item=>item[1]===row.tgname&&item[0]===row.relname&&row.nspname==='public'&&tables.includes(item[0]));
    if(!guard){problems.push('TRIGGER_UNEXPECTED:'+row.tgname+' on '+row.nspname+'.'+row.relname+' (function '+row.proname+')');continue;}
    const bound=row.function_schema==='public'&&row.proname===guard[2]&&exact[guard[2]]===row.tgfoid;
    const shaped=row.tgtype===GUARD_TGTYPE[guard[1]]&&!row.tgisinternal&&!row.has_qual&&row.tgnargs===0&&row.args_length===0&&row.columns===''
      &&row.tgconstraint===0&&!row.tgdeferrable&&!row.tginitdeferred&&row.tgoldtable===null&&row.tgnewtable===null;
    if(!bound)problems.push('TRIGGER_FUNCTION:'+row.tgname);
    else if(row.tgenabled!=='A')problems.push('TRIGGER_NOT_ALWAYS:'+row.tgname);
    else if(!shaped)problems.push('TRIGGER_SHAPE:'+row.tgname);
  }
  for(const [table,name] of FREEZE_GUARDS){
    if(!tables.includes(table))continue;
    const foundation=!LEGACY_TABLES.includes(table);
    if(foundation)foundationExpected++;
    if(!triggers.some(row=>row.tgname===name&&row.relname===table&&row.nspname==='public'))(foundation?foundationMissing:legacyMissing).push('TRIGGER_MISSING:'+name);
  }
  missing.push(...legacyMissing,...foundationMissing);
  let state;
  if(!functions.length&&!triggers.length&&!problems.length)state='ABSENT';
  else if(problems.length||legacyMissing.length)state='OTHER';
  else if(foundationMissing.length===0&&foundationExpected>0)state='FROZEN';
  else if(foundationMissing.length===foundationExpected)state='FROZEN_LEGACY';
  else state='OTHER';
  // A FOUNDATION table exists but none of its guards does: the install still has work to do (a second run converges it).
  const converged=state==='FROZEN'||(state==='FROZEN_LEGACY'&&foundationExpected===0);
  return {state,converged,problems,missing,tables,exact:Object.keys(exact)};
}

/**
 * Catalog facts and the failures they imply, read only. The runtime-role checks are the shared inspection of runtime-role-inspection.js.
 * With runtimeRole the privilege boundary the freeze relies on is checked too: the role is not a superuser or BYPASSRLS and is a member of no
 * superuser or BYPASSRLS role (RUNTIME_ROLE_PRIVILEGED_MEMBER), owns none of the tables and no freeze function (ownership includes membership of
 * the owning role through pg_has_role MEMBER, which SET ROLE reaches even without inheritance), holds no TRIGGER or TRUNCATE privilege on them
 * (also through any role it can reach by membership, INHERIT FALSE included), does not own schema public (also as database owner) nor hold CREATE
 * on it and (PostgreSQL 15 and later) may not SET session_replication_role. The database TEMP privilege is recorded, not judged,
 * because every function pins search_path and qualifies each relation.
 * facts.state is the exact classification (ABSENT, FROZEN, FROZEN_LEGACY or OTHER); every inexact object is a failure too.
 */
export async function inspectQuantResearchFreeze(db,{runtimeRole}={}){
  const failures=[],facts={marker:null,state:'ABSENT',guards:[],functions:[],tables:[]};
  const classification=await classifyQuantResearchFreeze(db);
  facts.state=classification.state;failures.push(...classification.problems);
  facts.tables.push(...TABLES.filter(table=>classification.tables.includes(table)));
  const present=facts.tables;
  // The marker function runs only when it is exactly the freeze SQL; a replaced one is never executed by an inspection.
  if(classification.exact.includes('quant_research_freeze_version'))
    facts.marker=(await db.query('SELECT public.quant_research_freeze_version() v')).rows[0].v;
  if(facts.marker!==FREEZE_MARKER)failures.push('MARKER_MISSING');
  for(const [table,name,fn] of FREEZE_GUARDS){
    if(!present.includes(table))continue;
    const row=(await db.query(`SELECT t.tgenabled,p.proname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2 AND NOT t.tgisinternal`,['public.'+table,name])).rows[0];
    facts.guards.push({table,name,enabled:row?.tgenabled??null});
    if(!row)failures.push('GUARD_MISSING:'+name);
    else{
      if(row.tgenabled!=='A')failures.push('GUARD_NOT_ALWAYS:'+name);
      if(row.proname!==fn)failures.push('GUARD_FUNCTION:'+name);
    }
  }
  for(const name of FUNCTIONS){
    const [fn]=(await db.query(`SELECT p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid`,[name])).rows;
    // The chunk guard function exists only with the FOUNDATION extension.
    if(!fn){if(name!==CHUNK_FUNCTION||present.includes('quant_research_chunks'))failures.push('FUNCTION_MISSING:'+name);continue;}
    facts.functions.push({name,security_definer:fn.prosecdef,search_path:fn.proconfig});
    if(fn.prosecdef!==false)failures.push('FUNCTION_SECURITY_DEFINER:'+name);
    if(!(fn.proconfig||[]).includes(PINNED_SEARCH_PATH))failures.push('FUNCTION_SEARCH_PATH:'+name);
  }
  if(present.includes('quant_jobs')){
    const cascades=(await db.query(`SELECT c.conname FROM pg_catalog.pg_constraint c WHERE c.contype='f' AND c.confrelid=to_regclass('public.quant_jobs')
      AND c.confdeltype NOT IN ('a','r')`)).rows;
    for(const row of cascades)failures.push('FOREIGN_KEY_CASCADE:'+row.conname);
  }
  if(runtimeRole){
    // One shared read-only inspection (src/postgres/runtime-role-inspection.js): ownership by membership, TRIGGER and TRUNCATE through any
    // reachable role (also with INHERIT FALSE), privileged membership, CREATE on schema public and session_replication_role.
    const inspected=await inspectRuntimeRole(db,{runtimeRole,schema:'public',tables:present.map(name=>({name,forbidden:['TRIGGER','TRUNCATE']})),functions:FUNCTIONS});
    failures.push(...inspected.failures);
    if(inspected.found){facts.runtime_role=inspected.facts;facts.server_version_num=inspected.facts.server_version_num;}
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the freeze objects are exactly absent or exactly the freeze SQL. */
function requireKnownState(classification,action){
  if(!['ABSENT','FROZEN','FROZEN_LEGACY'].includes(classification.state))
    throw Error('Research freeze '+action+' refused; unexpected state '+classification.state+' (no change made): '+[...classification.problems,...classification.missing].join(', '));
}

/**
 * Installs or converges the freeze in one transaction. Classifies first: writes over ABSENT, or over FROZEN_LEGACY when a FOUNDATION
 * table now exists, and writes nothing over FROZEN. The catalog assertions run in the same transaction.
 */
export async function migrateQuantResearchFreeze(db,{runtimeRole}={}){
  if(db.isTransaction)throw Error('Research freeze migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await classifyQuantResearchFreeze(db);
    requireKnownState(before,'install');
    // The functions are created by the current user and must belong to the owner of quant_jobs; refuse before any write otherwise.
    const owns=(await db.query(`SELECT c.relowner=(SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user) AS owns FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.quant_jobs')`)).rows[0]?.owns;
    if(owns!==true)throw Error('Research freeze install refused; run as the owner of quant_jobs (no change made)');
    if(!before.converged)await db.query(await sql('quant-research-freeze.sql'));
    const report=await inspectQuantResearchFreeze(db,{runtimeRole});
    if(!report.ok||!['FROZEN','FROZEN_LEGACY'].includes(report.facts.state))throw Error('Research freeze verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.state};
  });
}

/** Drops exactly the objects the install created, after classifying first. No row is read or written. */
export async function rollbackQuantResearchFreeze(db){
  if(db.isTransaction)throw Error('Research freeze rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await classifyQuantResearchFreeze(db);
    requireKnownState(before,'rollback');
    if(before.state!=='ABSENT')await db.query(await sql('quant-research-freeze-rollback.sql'));
    const left=await classifyQuantResearchFreeze(db);
    if(left.state!=='ABSENT')throw Error('Research freeze rollback left objects behind');
    return {rolled_back:true,previous_state:before.state};
  });
}
