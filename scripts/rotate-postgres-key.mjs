import path from 'node:path';
import {PostgresDatabase} from '../src/postgres/db.js';
import {encryptJson,decryptJson,encryptionKeys} from '../src/security.js';
import {backupPostgres} from './backup-postgres.mjs';

export async function rotatePostgresKey({db,backupPath,oldKeys,newKey,newId}){
  if(!/^[a-fA-F0-9]{64}$/.test(newKey)||!newId||Object.hasOwn(oldKeys.keys,newId)||Object.values(oldKeys.keys).some(k=>k.toLowerCase()===newKey.toLowerCase()))throw new Error('Use a new encryption key and unused key ID');
  const next=encryptionKeys(newKey,newId);
  return db.transaction(async()=>{
    await db.maintenanceLock();
    await db.query("SET LOCAL idle_in_transaction_session_timeout='5min'");
    if(![11,12].includes((await db.query('SELECT version FROM schema_version')).rows[0]?.version))throw new Error('Schema 11 or 12 is required');
    const backup=await backupPostgres(backupPath,{connectionString:db.pool.options.connectionString});
    let count=0;
    const rewrite=(value,context)=>{count++;return encryptJson(decryptJson(value,oldKeys,context),next,context);};
    for(const r of (await db.query('SELECT user_id,broker,encrypted_data FROM broker_credentials')).rows)
      await db.prepare('UPDATE broker_credentials SET encrypted_data=? WHERE user_id=? AND broker=?').run(rewrite(r.encrypted_data,`${r.user_id}:${r.broker}`),r.user_id,r.broker);
    for(const r of (await db.query('SELECT id,webhook_secret_encrypted FROM users WHERE webhook_secret_encrypted IS NOT NULL')).rows)
      await db.prepare('UPDATE users SET webhook_secret_encrypted=? WHERE id=?').run(rewrite(r.webhook_secret_encrypted,`webhook:${r.id}`),r.id);
    for(const r of (await db.query('SELECT * FROM user_security')).rows)for(const column of ['mfa_secret','pending_secret'])if(r[column])
      await db.prepare(`UPDATE user_security SET ${column}=? WHERE user_id=?`).run(rewrite(r[column],`mfa:${r.user_id}`),r.user_id);
    for(const r of (await db.query('SELECT id,user_id,encrypted_body FROM security_mail')).rows)
      await db.prepare('UPDATE security_mail SET encrypted_body=? WHERE id=?').run(rewrite(r.encrypted_body,`security-mail:${r.user_id}`),r.id);
    await db.prepare('INSERT INTO audit(user_id,ts,event,details) VALUES(NULL,?,?,?)').run(Date.now(),'security.key.rotated',JSON.stringify({keyId:newId,records:count}));
    return {backup,keyId:newId,records:count};
  });
}
if(process.argv[1]&&path.basename(process.argv[1])==='rotate-postgres-key.mjs'){
  if(!process.env.MASTER_ENCRYPTION_KEY||!process.argv[2])throw new Error('Current key environment and a new backup path are required');
  const db=new PostgresDatabase();
  try{console.log(JSON.stringify(await rotatePostgresKey({db,backupPath:process.argv[2],oldKeys:encryptionKeys(process.env.MASTER_ENCRYPTION_KEY,process.env.ENCRYPTION_KEY_ID||'k1',process.env.ENCRYPTION_PREVIOUS_KEYS||'{}'),newKey:process.env.NEW_ENCRYPTION_KEY,newId:process.env.NEW_ENCRYPTION_KEY_ID})));}
  finally{await db.close();}
}
