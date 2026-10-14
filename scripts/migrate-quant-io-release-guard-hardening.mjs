import {PostgresDatabase} from '../src/postgres/db.js';
import {inspectQuantIoReleaseGuardHardening,migrateQuantIoReleaseGuardHardening,rollbackQuantIoReleaseGuardHardening} from '../src/postgres/quant-io-release-guard-hardening-migration.js';

// Offline only: stop the API, the trading worker and every research worker first. Never run on service start.
// --inspect is the exception: one READ ONLY transaction, no maintenance lock and no write, so it is safe beside running services.
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--rollback'&&arg!=='--inspect')||args.length>1)throw Error('Usage: node scripts/migrate-quant-io-release-guard-hardening.mjs [--rollback | --inspect]');
const KNOWN_STATES=['ORIGINAL','HARDENED'];
async function inspectReadOnly(db){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    return await inspectQuantIoReleaseGuardHardening({query:(sql,params)=>client.query(sql,params)});
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
const db=new PostgresDatabase();
try{
  if(args[0]==='--inspect'){
    const report=await inspectReadOnly(db);
    console.log(JSON.stringify(report,null,2));
    process.exitCode=report.ok&&KNOWN_STATES.includes(report.facts.state)?0:1;
  }else if(args.length){const report=await rollbackQuantIoReleaseGuardHardening(db);console.log('Quant I/O release guard hardening removed; original function definition restored; previous state='+report.previous_state+'; no data changed');}
  else{
    const report=await migrateQuantIoReleaseGuardHardening(db);
    console.log('Quant I/O release guard hardening ready: state='+report.facts.state+'; previous state='+report.previous_state);
  }
}finally{await db.close();}
