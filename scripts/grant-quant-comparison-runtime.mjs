import {PostgresDatabase} from '../src/postgres/db.js';
import {grantQuantComparisonRuntime,revokeQuantComparisonRuntime,inspectExtensions,inspectAsRuntimeRole,QuantComparisonGrantRefusal,SERVER_TARGET_QUERY,sameServerTarget} from '../src/postgres/quant-comparison-grants.js';
import {readQuantComparisonGrantState} from '../src/postgres/quant-comparison-grant-state.js';

// Offline for --grant and --revoke: stop the API, the trading worker and every research worker first (the tool takes the maintenance try-lock and
// refuses while one runs). --inspect takes no lock and writes nothing, so it is safe beside running services.
// Targeted runtime grant of the QR-3 set C tables to the runtime role, and its exact reverse. It does NOT replace or reapply
// scripts/grant-postgres-runtime.sql and changes nothing else:
//   --grant    SELECT on quant_exposure_register_schema and quant_comparison_schema; SELECT, INSERT, UPDATE on quant_exposure_register; SELECT, INSERT
//              on the seven quant_comparison_* record tables (no DELETE, TRUNCATE or TRIGGER)
//   --revoke   the exact reverse
//   --inspect  classify the ten tables (ABSENT, NONE, EXACT, OTHER, MIXED) and run the two existing inspections; nothing is written
// Connections, both from the environment and neither printed (the runtime role name is never an argument):
//   DATABASE_URL          the schema owner (or a member of the owner role): runs the transaction
//   RUNTIME_DATABASE_URL  the runtime role's own connection: its `SELECT current_user` and the server-target read run on it, and after a committed
//                         grant the two inspections run on it too, in process; the target is compared with the owner connection's and never printed
// The role name, hosts, paths and passwords are never printed or returned. The output is state labels, counts, booleans and one digest.
// Exit 0: done, already in the wanted state (no-op), or (--inspect) ABSENT, NONE or a fully inspected EXACT. Exit 1: refused or failed.
const USAGE='Usage: node scripts/grant-quant-comparison-runtime.mjs (--grant | --revoke | --inspect)';
const args=process.argv.slice(2);
if(args.length!==1||!['--grant','--revoke','--inspect'].includes(args[0])){console.error(USAGE);process.exit(1);}
const mode=args[0];
const fail=code=>{console.error('Quant comparison grant failed: '+code+' (no change made)');process.exitCode=1;};

/** Opens the runtime connection, checks it reaches the same server and database as the owner connection and returns {runtime,roleName}; the caller closes runtime. */
async function openRuntime(ownerTarget){
  const url=process.env.RUNTIME_DATABASE_URL;
  if(!url)throw new QuantComparisonGrantRefusal('RUNTIME_DATABASE_URL_REQUIRED');
  const runtime=new PostgresDatabase({connectionString:url,max:1});
  try{
    const target=(await runtime.query(SERVER_TARGET_QUERY)).rows[0];
    // The two connections must reach the same server and database (database name, port setting, postmaster start time); compared in process, never printed.
    if(!sameServerTarget(target,ownerTarget))throw new QuantComparisonGrantRefusal('CONNECTIONS_DIFFER');
    return {runtime,roleName:(await runtime.query('SELECT current_user AS name')).rows[0].name};
  }catch(error){await runtime.close().catch(()=>{});throw error;}
}
const failures=list=>list.length?'; failures='+list.join('|'):'';

let db,runtime;
try{
  db=new PostgresDatabase({max:2});
  const ownerTarget=(await db.query(SERVER_TARGET_QUERY)).rows[0];
  const opened=await openRuntime(ownerTarget);
  runtime=opened.runtime;const runtimeRole=opened.roleName;
  if(mode==='--inspect'){
    const state=await readQuantComparisonGrantState(db,{runtimeRole});
    const exact=state.state==='EXACT';
    const owner=await inspectExtensions(db,{runtimeRole,requireGrants:exact});
    // The runtime connection can read the marker tables only once the grant is in place.
    const own=exact?await inspectAsRuntimeRole(runtime,{runtimeRole,requireGrants:true}):null;
    const ok=state.state==='ABSENT'||(state.state==='NONE'&&owner.ok)||(exact&&owner.ok&&own.ok);
    console.log('Quant comparison grant state: state='+state.state+'; register='+state.groups.register+'; comparison='+state.groups.comparison
      +'; extensions register='+owner.register+' comparison='+owner.comparison+'; inspection_ok='+owner.ok+'; runtime_connection_ok='+(own?own.ok:'not_run')
      +failures([...owner.failures,...(own?own.failures:[]),...state.reasons]));
    process.exitCode=ok?0:1;
  }else{
    const run=mode==='--grant'?grantQuantComparisonRuntime:revokeQuantComparisonRuntime;
    const report=await run(db,{runtimeRole});
    const line='Quant comparison '+report.action+' done: changed='+report.changed+'; statements='+report.statements
      +'; before register='+report.before.register+' comparison='+report.before.comparison+'; after register='+report.after.register+' comparison='+report.after.comparison
      +'; inspection_ok='+report.inspection_ok+'; other_relations='+report.other_relations+'; other_acl_unchanged='+report.other_acl_unchanged
      +'; acl_digest='+report.acl_digest_after;
    if(mode==='--grant'){
      // The transaction has committed. The inspections now run on the runtime role's own connection: a failure here is reported loudly and the caller unwinds.
      let own;
      try{own=await inspectAsRuntimeRole(runtime,{runtimeRole,requireGrants:true});}
      catch(error){
        // A throw here (a driver error or a refused read-only check) happens AFTER the commit: never print "no change made"; print the label or bare SQLSTATE and the committed report.
        const label=error instanceof QuantComparisonGrantRefusal?[error.code,...error.details].map(item=>String(item).replace(/[^A-Za-z0-9_:]/g,'').slice(0,32)).join(', '):'ERROR'+(error?.code?':'+String(error.code).replace(/[^A-Za-z0-9_]/g,'').slice(0,16):'');
        console.error('Quant comparison grant committed but the runtime connection inspection failed: '+label+' (the grant stays in place; run --revoke or --inspect)');
        console.error(line+'; runtime_connection_ok=false');
        process.exitCode=1;own=null;
      }
      if(own===null){}else if(!own.ok){
        console.error('Quant comparison grant committed but the runtime connection inspection failed: register='+own.register+' comparison='+own.comparison+failures(own.failures)
          +' (the grant stays in place; run --revoke or --inspect)');
        process.exitCode=1;
      }else console.log(line+'; runtime_connection_ok=true');
    }else console.log(line+'; runtime_connection_ok=not_run');
  }
}catch(error){
  // Only a refusal label or a bare SQLSTATE leaves: a driver message can name the role, the host or a path.
  if(error instanceof QuantComparisonGrantRefusal)console.error(error.message);
  else fail('ERROR'+(error?.code?':'+String(error.code).replace(/[^A-Za-z0-9_]/g,'').slice(0,16):''));
  process.exitCode=1;
}finally{await runtime?.close().catch(()=>{});await db?.close().catch(()=>{});}
