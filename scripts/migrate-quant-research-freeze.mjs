import {PostgresDatabase} from '../src/postgres/db.js';
import {inspectQuantResearchFreeze,migrateQuantResearchFreeze,rollbackQuantResearchFreeze} from '../src/postgres/quant-research-freeze-migration.js';

// Offline only: stop the API, the trading worker and every research worker first. Never run on service start.
// Run the install as the owner of quant_jobs (the freeze functions take the current user as owner); any other user is refused with no change.
// --inspect is the exception: one READ ONLY transaction, no maintenance lock and no write, so it is safe beside running services.
// It may be combined with --runtime-role=NAME to check the runtime role's privilege boundary too.
const args=process.argv.slice(2);
const rollback=args.includes('--rollback'),inspect=args.includes('--inspect'),roleArg=args.find(arg=>arg.startsWith('--runtime-role='));
if(args.some(arg=>arg!=='--rollback'&&arg!=='--inspect'&&!/^--runtime-role=[a-z_][a-z0-9_]{0,62}$/.test(arg))||(rollback&&(roleArg||inspect)))
  throw Error('Usage: node scripts/migrate-quant-research-freeze.mjs [--runtime-role=NAME | --rollback | --inspect [--runtime-role=NAME]]');
const runtimeRole=roleArg?.split('=')[1];
async function inspectReadOnly(db){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    return await inspectQuantResearchFreeze({query:(sql,params)=>client.query(sql,params)},{runtimeRole});
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
const db=new PostgresDatabase();
try{
  if(inspect){
    // Known states: ABSENT (nothing installed; only the "not installed" failures are allowed, so a bad runtime role still fails) and an
    // exact, complete FROZEN or FROZEN_LEGACY. OTHER, and a FOUNDATION table without its guards, exit nonzero.
    const report=await inspectReadOnly(db);
    console.log(JSON.stringify(report,null,2));
    const {state}=report.facts;
    const known=state==='ABSENT'?report.failures.every(failure=>/^(MARKER_MISSING|GUARD_MISSING:|FUNCTION_MISSING:)/.test(failure)):(state==='FROZEN'||state==='FROZEN_LEGACY')&&report.ok;
    process.exitCode=known?0:1;
  }else if(rollback){const report=await rollbackQuantResearchFreeze(db);console.log('Quant research freeze removed; previous state='+report.previous_state+'; no data changed');}
  else{
    const report=await migrateQuantResearchFreeze(db,{runtimeRole});
    console.log('Quant research freeze ready: '+report.facts.marker+'; state='+report.facts.state+'; previous state='+report.previous_state+'; guards='+report.facts.guards.length+(roleArg?'; runtime role checked':'; runtime role not checked'));
  }
}finally{await db.close();}
