import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PostgresDatabase} from '../src/postgres/db.js';
import {D,amount,exact} from '../src/money.js';
import {backupDatabase} from './backup.mjs';

const transient=new Set(['sessions','auth_challenges','password_resets','security_mail','security_limits']);
const name=value=>{assert.match(value,/^[a-z_]+$/);return '"'+value+'"';};
export async function importSqlite({source,backupPath,db,roundLegacy=false}){
  const backup=backupDatabase(source,backupPath),sqlite=new DatabaseSync(backup,{readOnly:true});
  try{
    assert.equal(sqlite.prepare('PRAGMA user_version').get().user_version,10,'Import requires schema 10');
    assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
    await db.migrate();
    return await db.transaction(async()=>{
      await db.maintenanceLock();
      await db.lock('robot:sqlite-import');
      const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);
      // Exclude running API/worker writes while validating and copying the empty target.
      await db.query('LOCK TABLE '+tables.map(name).join(',')+' IN ACCESS EXCLUSIVE MODE');
      for(const table of tables)assert.equal((await db.query('SELECT count(*) n FROM '+name(table))).rows[0].n,0,'Target must be empty: '+table);
      const counts={},rounding={};
      for(const table of tables){
        if(transient.has(table))continue;
        const columns=sqlite.prepare('PRAGMA table_info('+name(table)+')').all(),keys=columns.map(c=>c.name),decimals=new Set(columns.filter(c=>c.type==='REAL').map(c=>c.name));
        const expected=new Map();
        const canonical=row=>keys.map(k=>row[k]===null?null:decimals.has(k)?(roundLegacy?amount(row[k]):exact(row[k])):row[k]);
        for(const row of sqlite.prepare('SELECT * FROM '+name(table)+(table==='users'?' ORDER BY parent_user_id NULLS FIRST':' ORDER BY rowid')).iterate()){
          for(const key of decimals)if(row[key]!==null&&!D(row[key]).eq(amount(row[key]))){
            if(!roundLegacy)throw new Error(`Legacy REAL precision exceeds 18 decimals in ${table}.${key}; review and explicitly authorize --round-legacy-to-18`);
            const field=table+'.'+key,delta=D(row[key]).minus(amount(row[key])).abs(),prior=rounding[field]||{values:0,maxAbsoluteDelta:'0'};
            rounding[field]={values:prior.values+1,maxAbsoluteDelta:delta.gt(prior.maxAbsoluteDelta)?delta.toFixed():prior.maxAbsoluteDelta};
          }
          for(const c of columns)if(c.type==='INTEGER'&&row[c.name]!==null)assert.ok(Number.isSafeInteger(row[c.name]),'Unsafe source integer');
          const values=canonical(row);
          await db.query('INSERT INTO '+name(table)+'('+keys.map(name).join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',values);
          const hash=createHash('sha256').update(JSON.stringify(values)).digest('hex');expected.set(hash,(expected.get(hash)||0)+1);
        }
        const copied=await db.query('SELECT '+keys.map(name).join(',')+' FROM '+name(table));
        for(const row of copied.rows){const hash=createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex');assert.ok(expected.get(hash)>0,'Row mismatch in '+table);expected.set(hash,expected.get(hash)-1);}
        assert.ok([...expected.values()].every(n=>n===0),'Missing source rows in '+table);counts[table]=copied.rows.length;
        if(columns.some(c=>c.name==='id'&&c.type==='INTEGER'&&c.pk))await db.query("SELECT setval(pg_get_serial_sequence($1,'id'),GREATEST(COALESCE((SELECT MAX(id) FROM "+name(table)+"),0),1),EXISTS(SELECT 1 FROM "+name(table)+'))',[table]);
      }
      await db.query('UPDATE ledger_positions SET cost_basis=ROUND(quantity*avg_price,18)');
      await db.query(`UPDATE fills f SET quote_amount=CASE WHEN s.side='BUY' THEN -j.cash_delta-f.fee_quote ELSE j.cash_delta+f.fee_quote END
        FROM signals s,paper_cash_journal j WHERE s.id=f.signal_id AND j.signal_id=f.signal_id AND j.cumulative_quantity=f.cumulative_quantity`);
      await db.query('UPDATE fills SET quote_amount=ROUND(delta_quantity*price,18) WHERE quote_amount IS NULL');
      await db.query('UPDATE fills SET legacy_float=1');
      await db.query('UPDATE user_security SET pending_secret=NULL,pending_expires=0');
      const interrupted=await db.query("UPDATE signals SET status='UNKNOWN',error_message='Imported interrupted execution; operator review required' WHERE status IN ('PROCESSING','SUBMITTED','PARTIALLY_FILLED')");
      const accounts=await db.query(`SELECT u.id,f.broker,COALESCE(SUM(f.cash_delta),0) funding FROM users u JOIN paper_funding f ON f.user_id=u.id GROUP BY u.id,f.broker`);
      let negativeCash=0;
      for(const r of accounts.rows){const moves=(await db.query('SELECT COALESCE(SUM(cash_delta),0) n FROM paper_cash_journal WHERE user_id=$1 AND broker=$2',[r.id,r.broker])).rows[0].n;if(D(r.funding).plus(moves).lt(0))negativeCash++;}
      return {sourceSchema:10,targetSchema:11,backup,counts,rounding,sessionsRevoked:sqlite.prepare('SELECT count(*) n FROM sessions').get().n,interruptedQuarantined:interrupted.rowCount,negativeCashAccounts:negativeCash,sourceUnmodified:true};
    });
  }finally{sqlite.close();}
}
if(process.argv[1]&&path.basename(process.argv[1])==='import-postgres.mjs'){
  const [source,backupPath]=process.argv.slice(2);if(!source||!backupPath)throw new Error('Usage: DATABASE_URL=... node scripts/import-postgres.mjs /source/schema10.db /new/verified-backup.db');
  const db=new PostgresDatabase();try{console.log(JSON.stringify(await importSqlite({source,backupPath,db,roundLegacy:process.argv.includes('--round-legacy-to-18')}),null,2));}finally{await db.close();}
}
