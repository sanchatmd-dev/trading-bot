import fs from 'node:fs/promises';
import {PostgresDatabase} from '../src/postgres/db.js';

// Requires the same maintenance boundary as base migrations. Never run on startup.
const db=new PostgresDatabase();
try {
  await db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    const {rows}=await db.query("SELECT to_regclass('public.pine_bridge_schema') present");
    if(rows[0].present) {
      const version=(await db.query('SELECT version FROM pine_bridge_schema')).rows;
      if(version.length!==1||version[0].version!==1)throw new Error('Unsupported Pine Bridge extension');
      return;
    }
    await db.query(await fs.readFile(new URL('../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
  });
  console.log('Pine Bridge extension 1 ready (base schema 14)');
} finally {await db.close();}
