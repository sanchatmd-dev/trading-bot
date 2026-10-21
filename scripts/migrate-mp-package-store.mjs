import {PostgresDatabase} from '../src/postgres/db.js';
import {inspectMpPackageStore,migrateMpPackageStore,rollbackMpPackageStore} from '../src/postgres/mp-package-store-migration.js';

// Offline only: stop the API, the trading worker and every research worker first. Never run on service start. Install the run store (and with it the member-set
// extension) first: the package store installs only over an INSTALLED run store. Isolated clusters only until APP-3B (owner item O1).
// --inspect is the exception: one READ ONLY transaction, no maintenance lock and no write, so it is safe beside running services.
// --inspect runs as the schema owner (DATABASE_URL names the owner role): the runtime role holds no privilege on the package-store tables, so run as that role it
// reports MARKER_UNREADABLE and exits nonzero. Check the runtime role through --runtime-role=NAME, never by connecting as it.
// It may be combined with --runtime-role=NAME (the runtime role holds no privilege on the package-store tables; run it after the grant script) and
// --fixture-role=NAME (the fixture role of scripts/grant-postgres-mp-package-fixture.sql, isolated clusters only) to check the privilege boundary too.
// After an install, reapply scripts/grant-postgres-runtime.sql: this tool changes no grant. Uninstall order: this tool's --rollback before the run-store rollback.
const args=process.argv.slice(2);
const ROLE=/^--(runtime|fixture)-role=[a-z_][a-z0-9_]{0,62}$/;
const rollback=args.includes('--rollback'),inspect=args.includes('--inspect');
const roleOf=kind=>args.find(arg=>arg.startsWith('--'+kind+'-role='))?.split('=')[1];
const runtimeRole=roleOf('runtime'),fixtureRole=roleOf('fixture');
if(args.some(arg=>arg!=='--rollback'&&arg!=='--inspect'&&!ROLE.test(arg))||(rollback&&(inspect||runtimeRole||fixtureRole))||args.filter(arg=>arg.startsWith('--runtime-role=')).length>1||args.filter(arg=>arg.startsWith('--fixture-role=')).length>1)
  throw Error('Usage: node scripts/migrate-mp-package-store.mjs [--runtime-role=NAME] [--fixture-role=NAME] | --rollback | --inspect [--runtime-role=NAME] [--fixture-role=NAME]');
async function inspectReadOnly(db){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    return await inspectMpPackageStore({query:(sql,params)=>client.query(sql,params)},{runtimeRole,fixtureRole});
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
const db=new PostgresDatabase();
try{
  if(inspect){
    // Known states: ABSENT (nothing installed; only the "not installed" failures are allowed, so a bad role still fails) and an exact, complete INSTALLED.
    // OTHER exits nonzero.
    const report=await inspectReadOnly(db);
    console.log(JSON.stringify(report,null,2));
    const {state}=report.facts;
    const known=state==='ABSENT'?report.failures.every(failure=>/^(MARKER_MISSING|TRIGGER_MISSING:|FUNCTION_MISSING:|TABLE_MISSING:|INDEX_MISSING:)/.test(failure)):state==='INSTALLED'&&report.ok;
    process.exitCode=known?0:1;
  }else if(rollback){const report=await rollbackMpPackageStore(db);console.log('Multi-Pine package store removed; previous state='+report.previous_state+'; no record row existed');}
  else{
    const report=await migrateMpPackageStore(db,{runtimeRole,fixtureRole});
    console.log('Multi-Pine package store ready: '+report.facts.marker+'; state='+report.facts.state+'; previous state='+report.previous_state+'; guards='+report.facts.guards.length+(runtimeRole?'; runtime role checked':'; runtime role not checked')+(fixtureRole?'; fixture role checked':'; fixture role not checked')+'; grants unchanged');
  }
}finally{await db.close();}
