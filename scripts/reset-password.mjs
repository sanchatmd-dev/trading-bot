import {DatabaseSync} from 'node:sqlite';
import {hashPassword} from '../src/security.js';

export async function resetPassword({databasePath,email,password}) {
  if(typeof databasePath!=='string'||!databasePath)throw new Error('DB_PATH is required');
  if(typeof email!=='string'||!email.includes('@')||email.length>254)throw new Error('Valid email is required');
  const passwordHash=await hashPassword(password);
  const db=new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  try {
    const user=db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
    if(!user)throw new Error('User not found');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(?,?,?,?,?)')
      .run(user.id,Date.now(),'account.password.admin_reset',null,'{"sessionsRevoked":true}');
    db.exec('COMMIT');
    return true;
  } catch(error) {
    db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

if(process.argv[1]&&process.argv[1].endsWith('reset-password.mjs')) {
  const chunks=[];
  for await(const chunk of process.stdin)chunks.push(chunk);
  const [password,confirmation]=Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if(password!==confirmation)throw new Error('Passwords do not match');
  await resetPassword({databasePath:process.env.DB_PATH,email:process.env.RESET_EMAIL,password});
  console.log('Password reset completed; all existing sessions were revoked.');
}
