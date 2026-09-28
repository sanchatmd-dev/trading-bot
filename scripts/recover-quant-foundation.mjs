import {PostgresDatabase} from '../src/postgres/db.js';
import {loadQuantRecoveryPolicy,recoverQuantFoundation} from '../src/postgres/quant-foundation-recovery.js';

if(process.argv.length!==3||process.argv[2]!=='--apply')throw Error('Usage: node scripts/recover-quant-foundation.mjs --apply');
if(process.env.PAPER_TRADING!=='true'||process.env.PINE_BRIDGE_ENV!=='staging'||
   process.env.QUANT_RESEARCH_FOUNDATION_ENABLED!=='1')throw Error('Foundation recovery requires Paper staging');
const policy=await loadQuantRecoveryPolicy();
const db=new PostgresDatabase();
try{
 const mode=(await db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton')).rows[0]?.mode;
 if(mode!=='FOUNDATION')throw Error('Foundation executor mode required');
 const result=await recoverQuantFoundation({db,policy});
 console.log(JSON.stringify(result));
}finally{await db.close();}
