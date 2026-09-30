import {recoverQuantFoundation} from './quant-foundation-recovery.js';

const list=value=>Array.isArray(value)?value:[];

/** RECOVERY_IO_ROW_BLOCKED report: recovered rows, masked units and blocked rows. Each blocked row is rebuilt
 * from job id, operation id and code only, so no message, stack or connection detail reaches the output.
 */
export function blockedReport(failure){
 return {recovered:list(failure.recovered),
  maskedUnits:list(failure.maskedUnits).filter(unit=>typeof unit==='string'),
  blocked:list(failure.blocked).map(row=>({job_id:row?.job_id??null,operation_id:row?.operation_id??null,
   code:typeof row?.code==='string'?row.code:'RECOVERY_IO_ROW_FAILED'}))};
}

/** Runs recovery on an open database. Returns the exit code: 0 on success, 2 when rows stay blocked. */
export async function runRecovery({db,policy,recover=recoverQuantFoundation,log=console.log}){
 const mode=(await db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton')).rows[0]?.mode;
 if(mode!=='FOUNDATION')throw Error('Foundation executor mode required');
 try{
  log(JSON.stringify(await recover({db,policy})));
  return 0;
 }catch(failure){
  if(failure?.code!=='RECOVERY_IO_ROW_BLOCKED')throw failure;
  log(JSON.stringify(blockedReport(failure)));
  return 2;
 }
}
