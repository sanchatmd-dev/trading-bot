import {PostgresDatabase} from '../src/postgres/db.js';
import {inspectPaperLedgerFence,rollbackPaperLedgerFence} from '../src/postgres/paper-ledger-fence.js';

// F4 Paper ledger fence. The table is created by scripts/migrate-postgres.mjs (core migrate), not here.
// --inspect: one READ ONLY transaction, no maintenance lock and no write, so it is safe beside running services; exit 0 only when
// the table is INSTALLED. --rollback: offline only (stop the API and every worker first); drops the table only from INSTALLED.
const args=process.argv.slice(2);
if(args.length!==1||!['--inspect','--rollback'].includes(args[0]))throw Error('Usage: node scripts/paper-ledger-fence.mjs --inspect | --rollback');
async function inspectReadOnly(db){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    return await inspectPaperLedgerFence({query:(sql,params)=>client.query(sql,params)});
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
const db=new PostgresDatabase();
try{
  if(args[0]==='--inspect'){
    const report=await inspectReadOnly(db);
    console.log(JSON.stringify(report,null,2));
    process.exitCode=report.state==='INSTALLED'?0:1;
  }else{
    const report=await rollbackPaperLedgerFence(db);
    console.log(report.rolled_back?'Paper ledger fence removed; previous state=INSTALLED; no accounting data changed'
      :'Paper ledger fence already absent; nothing removed');
  }
}finally{await db.close();}
