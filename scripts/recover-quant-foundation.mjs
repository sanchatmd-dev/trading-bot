import {PostgresDatabase} from '../src/postgres/db.js';
import {loadQuantRecoveryPolicy} from '../src/postgres/quant-foundation-recovery.js';
import {runRecovery} from '../src/postgres/quant-foundation-recovery-cli.js';

if(process.argv.length!==3||process.argv[2]!=='--apply')throw Error('Usage: node scripts/recover-quant-foundation.mjs --apply');
if(process.env.PAPER_TRADING!=='true'||process.env.PINE_BRIDGE_ENV!=='staging'||
   process.env.QUANT_RESEARCH_FOUNDATION_ENABLED!=='1')throw Error('Foundation recovery requires Paper staging');
const policy=await loadQuantRecoveryPolicy();
const db=new PostgresDatabase();
try{process.exitCode=await runRecovery({db,policy});}
finally{await db.close();}
