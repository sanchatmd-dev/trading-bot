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
      await db.query(`CREATE TABLE IF NOT EXISTS pine_bridge_pending(
        deployment_id TEXT NOT NULL REFERENCES pine_deployments(deployment_id), event_id TEXT NOT NULL,
        event_hash TEXT NOT NULL, payload JSONB NOT NULL,
        received_at BIGINT NOT NULL, deadline_at BIGINT NOT NULL, checked_at BIGINT,
        status TEXT NOT NULL CHECK(status IN ('WAITING_MARKET','QUEUED','REJECTED')),
        diagnostic TEXT, signal_id BIGINT REFERENCES signals(id),
        PRIMARY KEY(deployment_id,event_id));
        CREATE INDEX IF NOT EXISTS pine_bridge_pending_due ON pine_bridge_pending(deadline_at,received_at) WHERE status='WAITING_MARKET';`);
      return;
    }
    await db.query(await fs.readFile(new URL('../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
  });
  console.log('Pine Bridge extension 1 ready (base schema 14)');
} finally {await db.close();}
