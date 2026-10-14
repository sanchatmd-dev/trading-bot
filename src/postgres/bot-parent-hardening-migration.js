import fs from 'node:fs/promises';

/**
 * GH2 hardening of check_bot_parent() (finding GH1-BOT-PARENT). Offline only: the maintenance lock excludes every participating API
 * and worker. The function reads users, so the hardened definition qualifies it with public. and pins search_path; a session TEMP
 * table named users can no longer stand in for the real one. Condition and error message are unchanged. CREATE OR REPLACE keeps the
 * OID, owner, grants and the bot_parent_guard trigger. No row changes. Not chained into any install or startup path.
 *
 * Both directions CLASSIFY the live definition before any write and accept only exactly the original (schema.sql body, no function
 * settings) or exactly the hardened one (hardened body, one setting: the pinned search_path). Anything else is refused untouched.
 */
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const BOT_PARENT_FUNCTION='check_bot_parent';
export const BOT_PARENT_TRIGGER='bot_parent_guard';
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
// Same normalization as ensureQuantIoSchema: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

/** Trusted release text for both states. Load-time invariant: hardened body with public. removed equals the original body. */
export async function botParentBodies(){
  const original=await sql('schema.sql'),hardened=await sql('bot-parent-hardening.sql');
  const before=/CREATE FUNCTION check_bot_parent\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/.exec(original);
  const after=/CREATE OR REPLACE FUNCTION public\.check_bot_parent\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp\s+AS \$fn\$([\s\S]*?)\$fn\$;/.exec(hardened);
  if(!before)throw Error('Original definition not found: '+BOT_PARENT_FUNCTION);
  if(!after)throw Error('Hardened definition not found: '+BOT_PARENT_FUNCTION);
  if(before[1].includes('public.')||normalize(after[1].replaceAll('public.',''))!==normalize(before[1]))
    throw Error('Hardened body differs from the original beyond public. qualification: '+BOT_PARENT_FUNCTION);
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
export async function inspectBotParentHardening(db){
  const bodies=await botParentBodies(),failures=[];
  const [row]=(await db.query(`SELECT p.oid,p.pronargs,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.prorettype,l.lanname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,['public.'+BOT_PARENT_FUNCTION+'()'])).rows;
  const state=classify(row,bodies);
  const facts={function:{name:BOT_PARENT_FUNCTION,state,security_definer:row?row.prosecdef:null,search_path:row?.proconfig||[]},trigger:null,state};
  if(state==='MISSING')failures.push('FUNCTION_MISSING:'+BOT_PARENT_FUNCTION);
  if(state==='OTHER'){
    failures.push('FUNCTION_UNEXPECTED_DEFINITION:'+BOT_PARENT_FUNCTION);
    if(row.prosecdef!==false)failures.push('FUNCTION_SECURITY_DEFINER:'+BOT_PARENT_FUNCTION);
    if(row.proconfig!==null&&!(row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))failures.push('FUNCTION_SEARCH_PATH:'+BOT_PARENT_FUNCTION);
    const body=normalize(row.prosrc);
    if(body!==normalize(bodies.original)&&body!==normalize(bodies.hardened))failures.push('FUNCTION_BODY:'+BOT_PARENT_FUNCTION);
  }
  if(row){
    const trigger=(await db.query(`SELECT t.tgfoid,t.tgtype,t.tgenabled,t.tgisinternal,t.tgqual,t.tgnargs
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('public.users') AND t.tgname=$1`,[BOT_PARENT_TRIGGER])).rows[0];
    facts.trigger={table:'users',name:BOT_PARENT_TRIGGER,enabled:trigger?.tgenabled??null};
    if(!trigger)failures.push('TRIGGER_MISSING:'+BOT_PARENT_TRIGGER);
    else if(trigger.tgfoid!==row.oid)failures.push('TRIGGER_FUNCTION:'+BOT_PARENT_TRIGGER);
    else if(!['O','A'].includes(trigger.tgenabled))failures.push('TRIGGER_DISABLED:'+BOT_PARENT_TRIGGER);
    else if(trigger.tgisinternal||trigger.tgtype!==23||trigger.tgqual!==null||trigger.tgnargs!==0)failures.push('TRIGGER_SHAPE:'+BOT_PARENT_TRIGGER);
  }
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless the function is exactly ORIGINAL or HARDENED and the trigger is bound to it. */
function requireKnownState(report,action){
  if(!report.ok||!['ORIGINAL','HARDENED'].includes(report.facts.state))
    throw Error('Bot parent guard hardening '+action+' refused; unexpected state '+report.facts.state+' (no change made): '+report.failures.join(', '));
}
const functionOid=async db=>(await db.query('SELECT to_regprocedure($1)::oid::text oid',['public.'+BOT_PARENT_FUNCTION+'()'])).rows[0].oid;

/** Installs the hardening in one transaction; classifies first, writes only over the exact original, no-ops on the exact hardened. */
export async function migrateBotParentHardening(db){
  if(db.isTransaction)throw Error('Bot parent guard hardening requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await inspectBotParentHardening(db);
    requireKnownState(before,'install');
    const oid=await functionOid(db);
    if(before.facts.state==='ORIGINAL')await db.query(await sql('bot-parent-hardening.sql'));
    const report=await inspectBotParentHardening(db);
    if(!report.ok||report.facts.state!=='HARDENED'||await functionOid(db)!==oid)throw Error('Bot parent guard hardening verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.facts.state};
  });
}

/** Restores the exact original definition after classifying first. No row is read or written. */
export async function rollbackBotParentHardening(db){
  if(db.isTransaction)throw Error('Bot parent guard hardening rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const before=await inspectBotParentHardening(db);
    requireKnownState(before,'rollback');
    if(before.facts.state==='HARDENED')await db.query(await sql('bot-parent-hardening-rollback.sql'));
    const report=await inspectBotParentHardening(db);
    if(!report.ok||report.facts.state!=='ORIGINAL')throw Error('Bot parent guard hardening rollback left a different definition: '+report.failures.join(', '));
    return {rolled_back:true,previous_state:before.facts.state};
  });
}
