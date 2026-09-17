import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {encryptJson,decryptJson,encryptionKeys} from '../src/security.js';
import {acquireProcessLock} from '../src/process-lock.js';
import {backupDatabase} from './backup.mjs';

export function rotateEncryptionKey({databasePath,backupPath,oldKeys,newKey,newId}){
  if(!/^[a-fA-F0-9]{64}$/.test(newKey)||!newId||Object.hasOwn(oldKeys.keys,newId)||Object.values(oldKeys.keys).some(key=>key.toLowerCase()===newKey.toLowerCase()))throw new Error('Use a new encryption key and unused key ID');
  const next=encryptionKeys(newKey,newId),release=acquireProcessLock(databasePath);
  let db;
  try{
    const backup=backupDatabase(databasePath,backupPath);
    db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    if(db.prepare('PRAGMA user_version').get().user_version!==10)throw new Error('Schema 10 is required');
    let count=0;
    const rewrite=(value,context)=>{count++;return encryptJson(decryptJson(value,oldKeys,context),next,context);};
    for(const row of db.prepare('SELECT user_id,broker,encrypted_data FROM broker_credentials').all()){
      db.prepare('UPDATE broker_credentials SET encrypted_data=? WHERE user_id=? AND broker=?').run(rewrite(row.encrypted_data,`${row.user_id}:${row.broker}`),row.user_id,row.broker);
    }
    for(const row of db.prepare('SELECT id,webhook_secret_encrypted FROM users WHERE webhook_secret_encrypted IS NOT NULL').all()){
      db.prepare('UPDATE users SET webhook_secret_encrypted=? WHERE id=?').run(rewrite(row.webhook_secret_encrypted,`webhook:${row.id}`),row.id);
    }
    for(const row of db.prepare('SELECT * FROM user_security').all())for(const column of ['mfa_secret','pending_secret'])if(row[column]){
      db.prepare(`UPDATE user_security SET ${column}=? WHERE user_id=?`).run(rewrite(row[column],`mfa:${row.user_id}`),row.user_id);
    }
    for(const row of db.prepare('SELECT id,user_id,encrypted_body FROM security_mail').all()){
      db.prepare('UPDATE security_mail SET encrypted_body=? WHERE id=?').run(rewrite(row.encrypted_body,`security-mail:${row.user_id}`),row.id);
    }
    db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(NULL,?,?,NULL,?)').run(Date.now(),'security.key.rotated',JSON.stringify({keyId:newId,records:count}));
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Database verification failed');
    db.exec('COMMIT');return {backup,keyId:newId,records:count};
  }catch(error){if(db?.isTransaction)db.exec('ROLLBACK');throw error;}
  finally{db?.close();release();}
}
if(process.argv[1]&&path.basename(process.argv[1])==='rotate-encryption-key.mjs'){
  if(!process.env.MASTER_ENCRYPTION_KEY||!process.env.DB_PATH||!process.argv[2])throw new Error('DB_PATH, current key environment, and a new backup destination are required');
  const result=rotateEncryptionKey({databasePath:process.env.DB_PATH,backupPath:process.argv[2],
    oldKeys:encryptionKeys(process.env.MASTER_ENCRYPTION_KEY,process.env.ENCRYPTION_KEY_ID||'k1',process.env.ENCRYPTION_PREVIOUS_KEYS||'{}'),
    newKey:process.env.NEW_ENCRYPTION_KEY,newId:process.env.NEW_ENCRYPTION_KEY_ID});
  console.log(JSON.stringify(result));
  console.log('Rotation committed. Update the service key environment before restarting. Preserve the old key with its backup.');
}
