import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

export function postgresToolEnvironment(connectionString){
  const url=new URL(connectionString);
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.pathname.length<2)throw new Error('An explicit PostgreSQL database URL is required');
  const env={...process.env,PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGHOST:url.searchParams.get('host')||url.hostname||'localhost',PGPORT:url.searchParams.get('port')||url.port||'5432'};
  if(url.username)env.PGUSER=decodeURIComponent(url.username);
  if(url.password)env.PGPASSWORD=decodeURIComponent(url.password);
  for(const [key,name] of Object.entries({sslmode:'PGSSLMODE',sslrootcert:'PGSSLROOTCERT',sslcert:'PGSSLCERT',sslkey:'PGSSLKEY',connect_timeout:'PGCONNECT_TIMEOUT'}))if(url.searchParams.has(key))env[name]=url.searchParams.get(key);
  return env;
}

export async function backupPostgres(target,{connectionString=process.env.DATABASE_URL,executable=process.env.PG_DUMP_PATH||'pg_dump'}={}){
  if(!connectionString)throw new Error('DATABASE_URL is required');
  const output=path.resolve(target);
  fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
  fs.closeSync(fs.openSync(output,'wx',0o600));
  const status=await new Promise((resolve,reject)=>{
    const child=spawn(executable,['--format=custom','--no-owner','--file',output],{env:postgresToolEnvironment(connectionString),stdio:['ignore','ignore','pipe'],windowsHide:true});
    // Database URLs may contain credentials. Never relay raw child error output.
    child.stderr.resume();child.on('error',()=>reject(new Error('Unable to start pg_dump')));child.on('exit',resolve);
  });
  if(status!==0)throw new Error('pg_dump failed; inspect the protected backup path before retrying');
  const digest=createHash('sha256');for await(const chunk of fs.createReadStream(output))digest.update(chunk);
  return {path:output,bytes:fs.statSync(output).size,sha256:digest.digest('hex'),format:'PostgreSQL custom archive'};
}
if(process.argv[1]&&path.basename(process.argv[1])==='backup-postgres.mjs'){
  if(!process.argv[2])throw new Error('Usage: node scripts/backup-postgres.mjs /new/backup.dump');
  console.log(JSON.stringify(await backupPostgres(process.argv[2])));
}
