import {pathToFileURL} from 'node:url';
import {PostgresDatabase} from '../src/postgres/db.js';

/** A read-only snapshot, not a lock preventing subsequent admission. */
export async function checkQuantFoundationIdle(db){
  try{
    return await db.transaction(async()=>{
      await db.query('SET TRANSACTION READ ONLY');
      const tables=(await db.query(`SELECT to_regclass('public.quant_foundation_jobs') foundation,
        to_regclass('public.quant_io_launches') launches,to_regclass('public.quant_io_ledgers') ledgers`)).rows[0];
      if(!tables?.foundation||!tables.launches||!tables.ledgers)
        return {ok:false,codes:['QUANT_IDLE_SCHEMA_REQUIRED'],queuedPolicies:[]};
      const counts=(await db.query(`SELECT
        (SELECT count(*)::int FROM public.quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')) active_jobs,
        (SELECT count(*)::int FROM public.quant_io_launches WHERE state<>'STOP_PROVEN') unresolved_launches,
        (SELECT count(*)::int FROM public.quant_io_ledgers l,
          LATERAL jsonb_array_elements(l.state->'operations') op
          WHERE COALESCE(op->>'status','') NOT IN ('SETTLED','CRASHED')) unresolved_operations,
        (SELECT count(*)::int FROM public.quant_io_ledgers WHERE
          jsonb_typeof(state->'operations') IS DISTINCT FROM 'array') invalid_ledgers`)).rows[0];
      const codes=[];
      for(const [field,code] of [['active_jobs','QUANT_IDLE_EXECUTOR_ACTIVE'],
        ['unresolved_launches','QUANT_IDLE_LAUNCH_UNRESOLVED'],
        ['unresolved_operations','QUANT_IDLE_OPERATION_UNRESOLVED'],['invalid_ledgers','QUANT_IDLE_LEDGER_INVALID']]){
        if(!Number.isSafeInteger(counts?.[field])||counts[field]<0)throw Error('Invalid idle count');
        if(counts[field])codes.push(code);
      }
      const rows=(await db.query(`SELECT contract->'capacity'->>'policy_hash' policy_hash,
        count(*) FILTER (WHERE status='QUEUED')::int queued,
        count(*) FILTER (WHERE status='PAUSED')::int paused
        FROM public.quant_foundation_jobs WHERE contract->>'version'='quant-foundation-v2'
        AND status IN ('QUEUED','PAUSED') GROUP BY 1 ORDER BY 1`)).rows;
      const queuedPolicies=rows.map(row=>{
        if(typeof row.policy_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.policy_hash)||
          !Number.isSafeInteger(row.queued)||row.queued<0||!Number.isSafeInteger(row.paused)||row.paused<0)
          throw Error('Invalid queued policy');
        return {policy_hash:row.policy_hash,queued:row.queued,paused:row.paused};
      });
      return {ok:codes.length===0,codes,queuedPolicies};
    },{isolation:'REPEATABLE READ'});
  }catch{return {ok:false,codes:['QUANT_IDLE_CHECK_FAILED'],queuedPolicies:[]};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let db,result;
  try{
    if(process.argv.length!==2||process.env.PAPER_TRADING!=='true'||process.env.PINE_BRIDGE_ENV!=='staging'||
      process.env.QUANT_RESEARCH_FOUNDATION_ENABLED!=='1')
      result={ok:false,codes:['QUANT_IDLE_CONFIGURATION_REQUIRED'],queuedPolicies:[]};
    else{db=new PostgresDatabase();result=await checkQuantFoundationIdle(db);}
  }catch{result={ok:false,codes:['QUANT_IDLE_CHECK_FAILED'],queuedPolicies:[]};}
  finally{await db?.close();}
  console.log(JSON.stringify(result));process.exitCode=result.ok?0:2;
}
