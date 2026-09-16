import {DatabaseSync} from 'node:sqlite';

// Explicit operator action for an existing account; never silently migrate financial settings.
const [email,value]=process.argv.slice(2),percent=Number(value);
if(!email||!value||!Number.isFinite(percent)||percent<.01||percent>100||!process.env.DB_PATH)
  throw new Error('Usage: DB_PATH=/absolute/database node scripts/set-max-risk.mjs user@email 100');
const db=new DatabaseSync(process.env.DB_PATH);
try{
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const user=db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if(!user)throw new Error('Account not found');
  const row=db.prepare('SELECT policy FROM risk_profiles WHERE user_id=?').get(user.id);
  if(!row)throw new Error('Existing risk profile required');
  const policy=JSON.parse(row.policy),before=policy.maxRiskPercent;
  policy.maxRiskPercent=percent;
  db.prepare('UPDATE risk_profiles SET policy=?,updated_at=? WHERE user_id=?').run(JSON.stringify(policy),Date.now(),user.id);
  db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(?,?,?,NULL,?)')
    .run(user.id,Date.now(),'risk.operator.max-percent',JSON.stringify({before,after:percent}));
  db.exec('COMMIT');
  console.log('Max risk updated to '+percent+'%; all other settings preserved.');
}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
