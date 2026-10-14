import fs from 'node:fs/promises';

/**
 * GH2 hardening of quant_io_foundation_release_guard() (finding GH1-IO-RELEASE). Offline only: the maintenance lock excludes every
 * participating API and worker. The function reads quant_io_launches and quant_io_ledgers, so the hardened definition qualifies both
 * with public. and pins search_path; a session TEMP table can no longer stand in for either table. Logic, status sets and the error
 * message are unchanged. CREATE OR REPLACE keeps the OID, owner, grants and the trigger on quant_foundation_jobs. No row changes.
 *
 * Not chained into migrateQuantFoundation or any startup path. Both directions CLASSIFY the live definition before any write and
 * accept only exactly the original (schema-file body, no function settings) or exactly the hardened one (hardened body, one setting:
 * the pinned search_path). Anything else is refused and left untouched.
 */
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const RELEASE_GUARD='quant_io_foundation_release_guard';
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
const exists=async(db,table)=>(await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;
// Same normalization as ensureQuantIoSchema: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function requireExtension(db){
  for(const table of ['quant_foundation_jobs','quant_io_ledgers','quant_io_launches'])
    if(!await exists(db,table))throw Error('Quant I/O extension required: '+table);
}

/**
 * Trusted release text for both states. Load-time invariant: the hardened body with public. removed equals the original body, so
 * the only difference between them is relation qualification.
 */
export async function quantIoReleaseGuardBodies(){
  const original=await sql('quant-io-runtime-schema.sql'),hardened=await sql('quant-io-release-guard-hardening.sql');
  const before=/CREATE FUNCTION quant_io_foundation_release_guard\(\) RETURNS TRIGGER LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/.exec(original);
  const after=/CREATE OR REPLACE FUNCTION public\.quant_io_foundation_release_guard\(\) RETURNS TRIGGER\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp\s+AS \$fn\$([\s\S]*?)\$fn\$;/.exec(hardened);
  if(!before)throw Error('Original definition not found: '+RELEASE_GUARD);
  if(!after)throw Error('Hardened definition not found: '+RELEASE_GUARD);
  if(before[1].includes('public.')||normalize(after[1].replaceAll('public.',''))!==normalize(before[1]))
    throw Error('Hardened body differs from the original beyond public. qualification: '+RELEASE_GUARD);
  return {original:before[1],hardened:after[1]};
}

/** Exact two-state classification: ORIGINAL, HARDENED, MISSING or OTHER. */
function classify(row,bodies){
  if(!row)return 'MISSING';
  const plain=row.prosecdef===false&&row.lanname==='plpgsql'&&row.prorettype===2279&&row.pronargs===0&&row.provolatile==='v'&&row.proleakproof===false;
  if(!plain)return 'OTHER';
  const body=normalize(row.prosrc);
  if(row.proconfig===null&&body===normalize(bodies.original))return 'ORIGINAL';
  if(Array.isArray(row.proconfig)&&row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH&&body===normalize(bodies.hardened))return 'HARDENED';
  return 'OTHER';
}

/** Catalog facts and the failures they imply, read only. state is ORIGINAL, HARDENED, MISSING or OTHER. */
export async function inspectQuantIoReleaseGuardHardening(db){
  const bodies=await quantIoReleaseGuardBodies(),failures=[];
  const [row]=(await db.query(`SELECT p.oid,p.pronargs,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.prorettype,l.lanname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,['public.'+RELEASE_GUARD+'()'])).rows;
  const state=classify(row,bodies);
  const facts={function:{name:RELEASE_GUARD,state,security_definer:row?row.prosecdef:null,search_path:row?.proconfig||[]},trigger:null,state};
  if(state==='MISSING')failures.push('FUNCTION_MISSING:'+RELEASE_GUARD);
  if(state==='OTHER'){
    failures.push('FUNCTION_UNEXPECTED_DEFINITION:'+RELEASE_GUARD);
    if(row.prosecdef!==false)failures.push('FUNCTION_SECURITY_DEFINER:'+RELEASE_GUARD);
    if(row.proconfig!==null&&!(row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))failures.push('FUNCTION_SEARCH_PATH:'+RELEASE_GUARD);
    const body=normalize(row.prosrc);
    if(body!==normalize(bodies.original)&&body!==normalize(bodies.hardened))failures.push('FUNCTION_BODY:'+RELEASE_GUARD);
  }
  if(row){
    const trigger=(await db.query(`SELECT t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual,t.tgnargs,octet_length(t.tgargs) args_length,
      t.tgattr::text columns,t.tgconstraint FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid=to_regclass('public.quant_foundation_jobs') AND t.tgname=$1`,[RELEASE_GUARD])).rows[0];
    facts.trigger={table:'quant_foundation_jobs',name:RELEASE_GUARD,enabled:trigger?.tgenabled??null};
    if(!trigger)failures.push('TRIGGER_MISSING:'+RELEASE_GUARD);
    else if(trigger.tgfoid!==row.oid)failures.push('TRIGGER_FUNCTION:'+RELEASE_GUARD);
    else if(!['O','A'].includes(trigger.tgenabled))failures.push('TRIGGER_DISABLED:'+RELEASE_GUARD);
    else if(trigger.tgisinternal||trigger.tgtype!==19||trigger.tgqual!==null||trigger.tgnargs!==0||trigger.args_length!==0||trigger.columns!==''||trigger.tgconstraint!==0)
      failures.push('TRIGGER_SHAPE:'+RELEASE_GUARD);
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the function is exactly ORIGINAL or HARDENED and the trigger is bound to it. */
function requireKnownState(report,action){
  if(!report.ok||!['ORIGINAL','HARDENED'].includes(report.facts.state))
    throw Error('Quant I/O release guard hardening '+action+' refused; unexpected state '+report.facts.state+' (no change made): '+report.failures.join(', '));
}

/** Installs the hardening in one transaction; classifies first, writes only over the exact original, no-ops on the exact hardened. */
export async function migrateQuantIoReleaseGuardHardening(db){
  if(db.isTransaction)throw Error('Quant I/O release guard hardening requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await inspectQuantIoReleaseGuardHardening(db);
    requireKnownState(before,'install');
    const oid=(await db.query('SELECT to_regprocedure($1)::oid::text oid',['public.'+RELEASE_GUARD+'()'])).rows[0].oid;
    if(before.facts.state==='ORIGINAL')await db.query(await sql('quant-io-release-guard-hardening.sql'));
    const report=await inspectQuantIoReleaseGuardHardening(db);
    const after=(await db.query('SELECT to_regprocedure($1)::oid::text oid',['public.'+RELEASE_GUARD+'()'])).rows[0].oid;
    if(!report.ok||report.facts.state!=='HARDENED'||after!==oid)throw Error('Quant I/O release guard hardening verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.facts.state};
  });
}

/** Restores the exact original definition after classifying first. No row is read or written. */
export async function rollbackQuantIoReleaseGuardHardening(db){
  if(db.isTransaction)throw Error('Quant I/O release guard hardening rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await inspectQuantIoReleaseGuardHardening(db);
    requireKnownState(before,'rollback');
    if(before.facts.state==='HARDENED')await db.query(await sql('quant-io-release-guard-hardening-rollback.sql'));
    const report=await inspectQuantIoReleaseGuardHardening(db);
    if(!report.ok||report.facts.state!=='ORIGINAL')throw Error('Quant I/O release guard hardening rollback left a different definition: '+report.failures.join(', '));
    return {rolled_back:true,previous_state:before.facts.state};
  });
}
