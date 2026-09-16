import {DatabaseSync} from 'node:sqlite';
const email=process.argv[2];
if(!email||!process.env.DB_PATH)throw new Error('Usage: DB_PATH=/absolute/database node scripts/enable-spot-sizing.mjs user@email');
const db=new DatabaseSync(process.env.DB_PATH);
try{
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const row=db.prepare('SELECT u.id,r.policy FROM users u JOIN risk_profiles r ON r.user_id=u.id WHERE u.email=?').get(email.toLowerCase());
  if(!row)throw new Error('Existing account and risk profile required');
  const policy=JSON.parse(row.policy);
  const before={capPercentEquitySize:policy.capPercentEquitySize??false,maxOrderNotional:policy.maxOrderNotional,maxDailyNotional:policy.maxDailyNotional};
  policy.capPercentEquitySize=true;policy.maxOrderNotional=10000;policy.maxDailyNotional=100000;
  db.prepare('UPDATE risk_profiles SET policy=?,updated_at=? WHERE user_id=?').run(JSON.stringify(policy),Date.now(),row.id);
  db.prepare('INSERT INTO audit(user_id,ts,event,trade_id,details) VALUES(?,?,?,NULL,?)')
    .run(row.id,Date.now(),'risk.operator.spot-sizing',JSON.stringify({before,after:{capPercentEquitySize:true,maxOrderNotional:10000,maxDailyNotional:100000}}));
  db.exec('COMMIT');
  console.log('Automatic Percent Equity sizing enabled; max order 10000; max daily 100000; other limits preserved.');
}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
