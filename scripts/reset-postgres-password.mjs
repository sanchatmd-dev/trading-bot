import path from 'node:path';
import {PostgresDatabase} from '../src/postgres/db.js';
import {Store} from '../src/postgres/store.js';
import {hashPassword} from '../src/security.js';

export async function resetPostgresPassword({db,email,password}){
  const hash=await hashPassword(password),store=new Store(db);
  return db.transaction(async()=>{
    await db.maintenanceLock();
    const user=await store.userByEmail(email);
    if(!user||user.parent_user_id)throw new Error('Main account not found');
    await store.setPassword(user.id,hash);
    await store.audit(user.id,'operator.password.reset',null,{sessionsRevoked:true,mfaPreserved:true});
    return {ok:true,sessionsRevoked:true,mfaPreserved:true};
  });
}
if(process.argv[1]&&path.basename(process.argv[1])==='reset-postgres-password.mjs'){
  if(!process.env.RESET_EMAIL||!process.env.RESET_PASSWORD)throw new Error('Provide RESET_EMAIL and RESET_PASSWORD through a protected environment; do not put passwords in command arguments');
  const db=new PostgresDatabase();
  try{console.log(JSON.stringify(await resetPostgresPassword({db,email:process.env.RESET_EMAIL,password:process.env.RESET_PASSWORD})));}
  finally{await db.close();}
}
