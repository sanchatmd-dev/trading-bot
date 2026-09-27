import fs from 'node:fs/promises';

/** Offline only: the maintenance lock excludes every participating API/worker.
 * Installation preserves LEGACY mode unless the operator explicitly selects it.
 */
export async function migrateQuantFoundation(db,{mode}={}) {
  if(mode!==undefined&&!['LEGACY','FOUNDATION'].includes(mode))throw Error('Unsupported research executor mode');
  if(db.isTransaction)throw Error('Foundation migration requires its own transaction');
  return db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const version=async(table)=>{
      if(!(await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present)return false;
      const rows=(await db.query('SELECT version FROM '+table)).rows;
      if(rows.length!==1||rows[0].version!==1)throw Error('Unsupported '+table+' version');
      return true;
    };
    if(!await version('pine_bridge_schema')||!await version('quant_job_schema'))throw Error('Pine Bridge and Quant research extensions 1 required');
    if(!await version('quant_foundation_schema'))await db.query(await fs.readFile(new URL('./quant-foundation-schema.sql',import.meta.url),'utf8'));
    if(!await version('quant_research_foundation_schema'))await db.query(await fs.readFile(new URL('./quant-research-foundation-schema.sql',import.meta.url),'utf8'));
    if(mode!==undefined)await db.query('UPDATE quant_research_executor_mode SET mode=$1 WHERE singleton',[mode]);
    return (await db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton')).rows[0].mode;
  });
}
