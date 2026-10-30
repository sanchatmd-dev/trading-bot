import {PostgresDatabase} from '../src/postgres/db.js';
import {grantPaperCapitalModelRuntime,revokePaperCapitalModelRuntime,PaperCapitalModelGrantRefusal,SERVER_TARGET_QUERY,sameServerTarget} from '../src/postgres/paper-capital-model-grants.js';

// Offline only: stop the API, the trading worker and every research worker first (the tool takes the maintenance lock and refuses while one runs).
// Targeted grant of the QR-2 paper capital model tables to the runtime role, and its exact reverse. It does NOT replace or reapply
// scripts/grant-postgres-runtime.sql and changes nothing else:
//   --grant   SELECT on paper_capital_model_schema; SELECT, INSERT on paper_capital_models (and EXECUTE on paper_capital_model_now_ms() with
//             --include-execute, only when default privileges removed PUBLIC EXECUTE on new functions)
//   --revoke  the exact reverse (pass the same --include-execute)
// Connections, both from the environment and neither printed:
//   DATABASE_URL          the schema owner (or a member of the owner role): runs the transaction
//   RUNTIME_DATABASE_URL  the runtime role's own connection: only `SELECT current_user` and the server-target read (database, port setting, postmaster start time) run on it, in process; the target is compared with the owner connection's and never printed
// The role name, hosts, paths and passwords are never printed or returned. The output is state labels, counts and booleans.
// Exit 0: done or already in the wanted state (no-op). Exit 1: refused or failed, with no change made.
const USAGE='Usage: node scripts/grant-paper-capital-model-runtime.mjs (--grant | --revoke) [--include-execute]';
const args=process.argv.slice(2);
const FORMS=[/^--grant$/,/^--revoke$/,/^--include-execute$/];
if(args.some(arg=>!FORMS.some(form=>form.test(arg)))||new Set(args).size!==args.length||args.includes('--grant')===args.includes('--revoke')){
  console.error(USAGE);process.exit(1);
}
const includeExecute=args.includes('--include-execute');
const fail=code=>{console.error('Paper capital model grant failed: '+code+' (no change made)');process.exitCode=1;};

async function runtimeRoleName(ownerTarget){
  const url=process.env.RUNTIME_DATABASE_URL;
  if(!url)throw new PaperCapitalModelGrantRefusal('RUNTIME_DATABASE_URL_REQUIRED');
  const runtime=new PostgresDatabase({connectionString:url,max:1});
  try{
    const target=(await runtime.query(SERVER_TARGET_QUERY)).rows[0];
    // The two connections must reach the same server and database (database name, port setting, postmaster start time); compared in process, never printed.
    if(!sameServerTarget(target,ownerTarget))throw new PaperCapitalModelGrantRefusal('CONNECTIONS_DIFFER');
    return (await runtime.query('SELECT current_user AS name')).rows[0].name;
  }finally{await runtime.close();}
}

let db;
try{
  db=new PostgresDatabase({max:2});
  const ownerTarget=(await db.query(SERVER_TARGET_QUERY)).rows[0];
  const runtimeRole=await runtimeRoleName(ownerTarget);
  const run=args.includes('--grant')?grantPaperCapitalModelRuntime:revokePaperCapitalModelRuntime;
  const report=await run(db,{runtimeRole,includeExecute});
  console.log('Paper capital model '+report.action+' done: changed='+report.changed+'; statements='+report.statements
    +'; before marker='+report.before.marker+' declarations='+report.before.declarations+' function='+report.before.function
    +'; after marker='+report.after.marker+' declarations='+report.after.declarations+' function='+report.after.function
    +'; inspection_ok='+report.inspection_ok+'; other_relations='+report.other_relations+'; other_acl_unchanged='+report.other_acl_unchanged);
}catch(error){
  // Only a refusal label or a bare SQLSTATE leaves: a driver message can name the role, the host or a path.
  if(error instanceof PaperCapitalModelGrantRefusal)console.error(error.message);
  else fail('ERROR'+(error?.code?':'+String(error.code).replace(/[^A-Za-z0-9_]/g,'').slice(0,16):''));
  process.exitCode=1;
}finally{await db?.close().catch(()=>{});}
