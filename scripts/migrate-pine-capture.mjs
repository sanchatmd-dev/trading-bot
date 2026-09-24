import fs from 'node:fs/promises';
import {PostgresDatabase} from '../src/postgres/db.js';
const db=new PostgresDatabase();
try {
  await db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const bridge=(await db.query('SELECT version FROM pine_bridge_schema')).rows;
    if(bridge.length!==1||bridge[0].version!==1)throw new Error('Pine Bridge extension 1 is required');
    const installed=(await db.query("SELECT to_regclass('public.pine_capture_schema') present")).rows[0].present;
    if(installed){
      const rows=(await db.query('SELECT version FROM pine_capture_schema')).rows;
      if(rows.length!==1||rows[0].version!==1)throw new Error('Unsupported Pine capture extension');
      await db.query(`ALTER TABLE pine_capture_events ADD COLUMN IF NOT EXISTS market_present_at_intake BOOLEAN;
        ALTER TABLE pine_capture_events ADD COLUMN IF NOT EXISTS market_checked_at BIGINT;
        ALTER TABLE pine_capture_events ADD COLUMN IF NOT EXISTS market_hash_at_intake TEXT;`);
    }else await db.query(await fs.readFile(new URL('../src/postgres/pine-capture-schema.sql',import.meta.url),'utf8'));
  });
  console.log('Evidence-only Pine capture extension 1 ready');
}finally{await db.close();}
