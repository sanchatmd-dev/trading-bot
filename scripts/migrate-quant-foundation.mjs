import {PostgresDatabase} from '../src/postgres/db.js';
import {migrateQuantFoundation} from '../src/postgres/quant-foundation-migration.js';

const args=process.argv.slice(2);
if(args.length>1||(args.length===1&&!/^--mode=(LEGACY|FOUNDATION)$/.test(args[0])))throw Error('Usage: node scripts/migrate-quant-foundation.mjs [--mode=LEGACY|FOUNDATION]');
const db=new PostgresDatabase();
try{
  const mode=await migrateQuantFoundation(db,{mode:args[0]?.split('=')[1]});
  console.log('Quant foundation and research adapter extensions 1 ready; mode='+mode+'; base schema 14 unchanged');
}finally{await db.close();}
