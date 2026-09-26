import fs from 'node:fs/promises';
import {PostgresDatabase} from '../src/postgres/db.js';
const db=new PostgresDatabase();
try{
 await db.transaction(async()=>{
  await db.maintenanceLock();await db.verifySchema();
  const existing=(await db.query("SELECT to_regclass('public.quant_job_schema') present")).rows[0].present;
  if(existing){const versions=(await db.query('SELECT version FROM quant_job_schema')).rows;if(versions.length!==1||versions[0].version!==1)throw Error('Unsupported Quant job extension');return;}
  const bridge=(await db.query('SELECT version FROM pine_bridge_schema')).rows;
  if(bridge.length!==1||bridge[0].version!==1)throw Error('Pine Bridge extension 1 required');
  await db.query(await fs.readFile(new URL('../src/postgres/quant-research-schema.sql',import.meta.url),'utf8'));
 });
 console.log('Quant research extension 1 ready; base schema 14 unchanged');
}finally{await db.close();}
