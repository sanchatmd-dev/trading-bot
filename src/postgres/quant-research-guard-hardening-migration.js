import fs from 'node:fs/promises';

/**
 * GH1 hardening of the two research mode-guard trigger functions (finding QR1B-MODE-GUARDS). Offline only: the maintenance lock
 * excludes every participating API and worker. Each function reads tables, so each now qualifies every relation with public. and
 * pins search_path; a session TEMP table can no longer stand in for a research table. Install is idempotent and keeps the owner,
 * the grants and the triggers. Rollback restores the exact original function text of the applied schema file. No row changes.
 *
 * Both directions CLASSIFY the live definitions before they write anything. A function is accepted only when it is exactly the
 * original (schema-file body, no function settings) or exactly the hardened one (hardened body, one setting: the pinned
 * search_path). Any other state (changed body, extra setting, SECURITY DEFINER, missing function) is refused and left untouched.
 */
export const PINNED_SEARCH_PATH='search_path=pg_catalog, pg_temp';
export const MODE_GUARDS=Object.freeze([
 ['quant_research_mode_guard','quant_jobs','quant_research_mode_guard'],
 ['quant_research_mode_change','quant_research_executor_mode','quant_research_mode_change']]);
const sql=name=>fs.readFile(new URL('./'+name,import.meta.url),'utf8');
const exists=async(db,table)=>(await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;
// Same normalization as the I/O installer: line endings and surrounding whitespace only.
const normalize=value=>value.replaceAll('\r\n','\n').trim();

async function requireExtension(db){
  if(!await exists(db,'quant_research_foundation_schema'))throw Error('Quant research foundation extension required');
  const rows=(await db.query('SELECT version FROM quant_research_foundation_schema')).rows;
  if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported quant_research_foundation_schema version');
}

/**
 * Trusted release text for both states, read from the applied schema file and the hardening file. The load-time invariant: the
 * hardened body with public. removed equals the original body, so the only change between them is relation qualification.
 */
async function expectedBodies(){
  const original=await sql('quant-research-foundation-schema.sql'),hardened=await sql('quant-research-guard-hardening.sql'),out={};
  for(const [name] of MODE_GUARDS){
    const before=new RegExp('CREATE FUNCTION '+name+'\\(\\) RETURNS TRIGGER LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$;').exec(original);
    const after=new RegExp('CREATE OR REPLACE FUNCTION public\\.'+name+'\\(\\) RETURNS TRIGGER\\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(hardened);
    if(!before)throw Error('Original definition not found: '+name);
    if(!after)throw Error('Hardened definition not found: '+name);
    if(before[1].includes('public.')||normalize(after[1].replaceAll('public.',''))!==normalize(before[1]))
      throw Error('Hardened body differs from the original beyond public. qualification: '+name);
    out[name]={original:before[1],hardened:after[1]};
  }
  return out;
}

/** Exact two-state classification of one function row: ORIGINAL, HARDENED, MISSING or OTHER. */
function classify(row,expected){
  if(!row)return 'MISSING';
  const plain=row.prosecdef===false&&row.lanname==='plpgsql'&&row.prorettype===2279&&row.pronargs===0&&row.provolatile==='v'&&row.proleakproof===false;
  if(!plain)return 'OTHER';
  const body=normalize(row.prosrc);
  if(row.proconfig===null&&body===normalize(expected.original))return 'ORIGINAL';
  if(Array.isArray(row.proconfig)&&row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH&&body===normalize(expected.hardened))return 'HARDENED';
  return 'OTHER';
}

/** Catalog facts and the failures they imply, read only. state is HARDENED, ORIGINAL, MIXED, MISSING or OTHER. */
export async function inspectQuantResearchGuardHardening(db){
  const facts={functions:[],triggers:[],state:'MISSING'},failures=[],bodies=await expectedBodies();
  for(const [name,table,fn] of MODE_GUARDS){
    const [row]=(await db.query(`SELECT p.oid,p.pronargs,p.prosrc,p.prosecdef,p.provolatile,p.proleakproof,p.proconfig,p.prorettype,l.lanname
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,['public.'+name+'()'])).rows;
    const state=classify(row,bodies[name]);
    facts.functions.push({name,state,security_definer:row?row.prosecdef:null,search_path:row?.proconfig||[]});
    if(state==='MISSING'){failures.push('FUNCTION_MISSING:'+name);continue;}
    if(state==='OTHER'){
      failures.push('FUNCTION_UNEXPECTED_DEFINITION:'+name);
      if(row.prosecdef!==false)failures.push('FUNCTION_SECURITY_DEFINER:'+name);
      if(row.proconfig!==null&&!(row.proconfig.length===1&&row.proconfig[0]===PINNED_SEARCH_PATH))failures.push('FUNCTION_SEARCH_PATH:'+name);
      const body=normalize(row.prosrc);
      if(body!==normalize(bodies[name].original)&&body!==normalize(bodies[name].hardened))failures.push('FUNCTION_BODY:'+name);
    }
    const trigger=(await db.query(`SELECT t.tgenabled,t.tgfoid FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2 AND NOT t.tgisinternal`,['public.'+table,name])).rows[0];
    facts.triggers.push({table,name,enabled:trigger?.tgenabled??null});
    if(!trigger)failures.push('TRIGGER_MISSING:'+name);
    else if(trigger.tgfoid!==row.oid)failures.push('TRIGGER_FUNCTION:'+name);
    else if(!['O','A'].includes(trigger.tgenabled))failures.push('TRIGGER_DISABLED:'+name);
  }
  const states=new Set(facts.functions.map(item=>item.state));
  facts.state=states.has('OTHER')?'OTHER':states.has('MISSING')?(states.size===1?'MISSING':'OTHER'):states.size===1?[...states][0]:'MIXED';
  return {ok:failures.length===0,failures,facts};
}

/** Refuses before any write unless every function is exactly ORIGINAL or HARDENED and every trigger is bound to it. */
function requireKnownState(report,action){
  if(!report.ok||!['ORIGINAL','HARDENED','MIXED'].includes(report.facts.state))
    throw Error('Research guard hardening '+action+' refused; unexpected state '+report.facts.state+' (no change made): '+report.failures.join(', '));
}

/** Installs or converges the hardening in one transaction; classifies first and refuses anything but exact ORIGINAL/HARDENED. */
export async function migrateQuantResearchGuardHardening(db){
  if(db.isTransaction)throw Error('Research guard hardening requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await inspectQuantResearchGuardHardening(db);
    requireKnownState(before,'install');
    if(before.facts.state!=='HARDENED')await db.query(await sql('quant-research-guard-hardening.sql'));
    const report=await inspectQuantResearchGuardHardening(db);
    if(!report.ok||report.facts.state!=='HARDENED')throw Error('Research guard hardening verification failed: '+report.failures.join(', '));
    return {...report,previous_state:before.facts.state};
  });
}

/** Restores the original function definitions after classifying first. No row is read or written. */
export async function rollbackQuantResearchGuardHardening(db){
  if(db.isTransaction)throw Error('Research guard hardening rollback requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();await requireExtension(db);
    const before=await inspectQuantResearchGuardHardening(db);
    requireKnownState(before,'rollback');
    if(before.facts.state!=='ORIGINAL')await db.query(await sql('quant-research-guard-hardening-rollback.sql'));
    const report=await inspectQuantResearchGuardHardening(db);
    if(!report.ok||report.facts.state!=='ORIGINAL')throw Error('Research guard hardening rollback left a different definition: '+report.failures.join(', '));
    return {rolled_back:true,previous_state:before.facts.state};
  });
}
