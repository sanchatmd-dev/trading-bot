import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';

let admin,db,databaseName,connectionString;
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='foundation_migration_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;connectionString=url.toString();
  db=new PostgresDatabase({connectionString});await db.migrate();
  for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await db.query(await readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8'));
});
after(async()=>{await db?.close();if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin?.close();});

test('offline migration excludes runtime holders and installs atomically in LEGACY mode',async()=>{
  const runtime=new PostgresDatabase({connectionString});
  try{
    await runtime.runtimeLock();
    await assert.rejects(migrateQuantFoundation(db),/Stop every PostgreSQL API and worker/);
    assert.equal((await db.query("SELECT to_regclass('quant_foundation_schema') present")).rows[0].present,null);
  }finally{await runtime.close();}
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14);
  assert.equal(await migrateQuantFoundation(db,{mode:'FOUNDATION'}),'FOUNDATION');
  assert.equal(await migrateQuantFoundation(db),'FOUNDATION');
  assert.equal(await migrateQuantFoundation(db,{mode:'LEGACY'}),'LEGACY');
  await assert.rejects(migrateQuantFoundation(db,{mode:'invalid'}),/Unsupported/);
  await assert.rejects(db.transaction(()=>migrateQuantFoundation(db)),/own transaction/);
});
