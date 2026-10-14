import {PostgresDatabase} from '../src/postgres/db.js';
import {DEFAULT_RUNTIME_ROLE,inspectTempPrivilege,restoreTempPrivilege,revokeTempPrivilege} from '../src/postgres/temp-privilege.js';

// Prepared for owner decision C2; running it is a separate, explicit owner action. Nothing starts this script.
//   --inspect  read only (one READ ONLY transaction): who holds TEMPORARY on the current database (the runtime role and every
//              non-superuser LOGIN role that can connect), the sessions other than this one, and live temp schemas.
//   --revoke   REVOKE TEMPORARY ON DATABASE <current> FROM PUBLIC (and from the runtime role when it holds it directly). Rolled back and
//              refused when the runtime role or any other non-superuser LOGIN role that can connect still has TEMP afterwards.
//   --restore  GRANT TEMPORARY ON DATABASE <current> TO PUBLIC. A byte-identical datacl restore is not guaranteed.
// --revoke and --restore must run as the database owner (DATABASE_URL), not as the runtime role.
// --runtime-role=NAME names the runtime role (default robot_app).
// --allow-temp-role=NAME (--revoke only, repeatable) accepts that one named role keeping TEMP.
// --revoke and --restore refuse (TEMP_PRIVILEGE_SESSIONS_ACTIVE) while any other session is connected to the database, and
// (TEMP_PRIVILEGE_SESSIONS_UNVERIFIABLE) when the caller is neither a superuser nor a pg_read_all_stats member and so cannot see them.
// --allow-active-sessions overrides that refusal and is UNSAFE. The tool does not take the application maintenance lock:
// stop every application writer before running --revoke or --restore.
const USAGE='Usage: node scripts/postgres-temp-privilege.mjs (--inspect | --revoke | --restore) [--runtime-role=NAME] [--allow-temp-role=NAME]... [--allow-active-sessions]';
const ROLE_OPTION=/^--(runtime-role|allow-temp-role)=([a-z_][a-z0-9_]{0,62})$/;

/** Returns the parsed options, or null for any usage error. */
function parseArguments(args){
  const modes=args.filter(arg=>['--inspect','--revoke','--restore'].includes(arg));
  const roleArgs=args.filter(arg=>arg.startsWith('--runtime-role='));
  const allowTempArgs=args.filter(arg=>arg.startsWith('--allow-temp-role='));
  const sessionArgs=args.filter(arg=>arg==='--allow-active-sessions');
  if(modes.length!==1||roleArgs.length>1||sessionArgs.length>1)return null;
  if(args.length!==modes.length+roleArgs.length+allowTempArgs.length+sessionArgs.length)return null;
  if([...roleArgs,...allowTempArgs].some(arg=>!ROLE_OPTION.test(arg)))return null;
  const mode=modes[0];
  if(allowTempArgs.length>0&&mode!=='--revoke')return null;
  if(sessionArgs.length>0&&mode==='--inspect')return null;
  return {mode,runtimeRole:roleArgs[0]?.split('=')[1]||DEFAULT_RUNTIME_ROLE,
    allowTempRoles:[...new Set(allowTempArgs.map(arg=>arg.split('=')[1]))],allowActiveSessions:sessionArgs.length===1};
}

async function inspectReadOnly(db,runtimeRole){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    return await inspectTempPrivilege({query:(sql,params)=>client.query(sql,params)},{runtimeRole});
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}

async function main(){
  const options=parseArguments(process.argv.slice(2));
  if(!options){console.error(USAGE);process.exitCode=1;return;}
  const {mode,runtimeRole,allowTempRoles,allowActiveSessions}=options;
  let db;
  try{
    db=new PostgresDatabase();
    const report=mode==='--inspect'?await inspectReadOnly(db,runtimeRole)
      :mode==='--revoke'?await revokeTempPrivilege(db,{runtimeRole,allowTempRoles,allowActiveSessions}):await restoreTempPrivilege(db,{runtimeRole,allowActiveSessions});
    console.log(JSON.stringify(report,null,2));
  }catch(error){
    console.error((error.code?error.code+': ':'')+String(error.message).replace(/\s*\r?\n\s*/g,' '));
    process.exitCode=1;
  }finally{await db?.close();}
}
await main();
