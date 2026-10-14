import {migrateBotParentHardening} from '../../src/postgres/bot-parent-hardening-migration.js';
import {migrateQuantResearchGuardHardening} from '../../src/postgres/quant-research-guard-hardening-migration.js';
import {migrateQuantIoReleaseGuardHardening} from '../../src/postgres/quant-io-release-guard-hardening-migration.js';
import {migrateQuantResearchFreeze} from '../../src/postgres/quant-research-freeze-migration.js';

const present=async(db,table)=>(await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;

/**
 * FX1: installs the accepted local hardening and the QR-1b terminal-result freeze into a disposable fixture database, so every suite
 * built on the fixture runs with the guards active. Each module is installed through its own offline transaction (maintenance lock),
 * exactly as the migration scripts do, and only where its extension exists. The freeze goes last. Call it after the schema files are
 * applied and before any row is written. The fixtures never write a finished run directly; a suite that must does so as a labelled
 * exception (see withFreezeInsertsPaused in quant-library-fixture.mjs).
 * @returns the names of the modules that were installed
 */
export async function installQuantGuards(db){
  const installed=[];
  await migrateBotParentHardening(db);installed.push('bot-parent');
  if(await present(db,'quant_research_foundation_schema')){await migrateQuantResearchGuardHardening(db);installed.push('research-mode-guards');}
  if((await Promise.all(['quant_foundation_jobs','quant_io_ledgers','quant_io_launches'].map(table=>present(db,table)))).every(Boolean)){
    await migrateQuantIoReleaseGuardHardening(db);installed.push('io-release-guard');
  }
  if(await present(db,'quant_job_schema')){await migrateQuantResearchFreeze(db);installed.push('research-freeze');}
  return installed;
}
