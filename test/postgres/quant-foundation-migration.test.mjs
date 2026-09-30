import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {ensureQuantIoSchema} from '../../src/postgres/quant-io-schema-install.js';
import {checkQuantFoundationIdle} from '../../scripts/check-quant-foundation-idle.mjs';
import {canonical,hash} from '../../src/pine-bridge/source.js';

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
    for(const table of ['quant_io_ledgers','quant_io_launches'])
      assert.equal((await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present,null);
  }finally{await runtime.close();}
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14);
  assert.equal(await migrateQuantFoundation(db,{mode:'FOUNDATION'}),'FOUNDATION');
  assert.equal(await migrateQuantFoundation(db),'FOUNDATION');
  assert.equal(await migrateQuantFoundation(db,{mode:'LEGACY'}),'LEGACY');
  await assert.rejects(migrateQuantFoundation(db,{mode:'invalid'}),/Unsupported/);
  await assert.rejects(db.transaction(()=>migrateQuantFoundation(db)),/own transaction/);
  for(const table of ['quant_io_ledgers','quant_io_launches'])
    assert.ok((await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present);
});

async function catalog(){
  const tables=(await db.query("SELECT oid,relname,relkind,relpersistence FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('quant_io_ledgers','quant_io_launches') ORDER BY relname")).rows;
  const functions=(await db.query("SELECT oid,proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('quant_io_ledger_guard','quant_io_launch_guard','quant_io_foundation_release_guard') ORDER BY proname")).rows;
  const triggers=(await db.query("SELECT tgname,tgrelid,tgfoid,tgenabled FROM pg_trigger WHERE tgname IN ('quant_io_ledger_guard','quant_io_launch_guard','quant_io_foundation_release_guard') ORDER BY tgname")).rows;
  return {tables,functions,triggers};
}
async function rollbackFixture(callback){
  const rollback=Error('fixture rollback');
  await assert.rejects(db.transaction(async()=>{await db.maintenanceLock();await callback();throw rollback;}),error=>error===rollback);
}
async function dropIo(){
  // This rollback-only W2 fixture predates enrollment's FK into launch evidence.
  await db.query('DROP TABLE public.quant_profile_enrollment_receipts');
  await db.query('DROP TABLE public.quant_io_launches; DROP TABLE public.quant_io_ledgers CASCADE');
  for(const name of ['quant_io_ledger_guard','quant_io_launch_guard','quant_io_foundation_release_guard'])
    await db.query('DROP FUNCTION public.'+name+'() CASCADE');
}
async function job(status='CANCELLED'){
  const id=randomUUID(),token=randomUUID(),contract={version:'quant-foundation-v2',kind:'PROFILE'};
  await db.query("INSERT INTO public.quant_foundation_owners(owner_id) VALUES('migration-fixture') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,
    created_at,deadline_at,lease_token,lease_until,stop_reason) VALUES($1,'migration-fixture',$2,$3,$4,$5,1,900001,$6,$7,$8)`,
    [id,randomUUID(),JSON.stringify(contract),hash(canonical(contract)),status,
      ['RUNNING','STOPPING'].includes(status)?token:null,status==='RUNNING'?900000:null,status==='STOPPING'?'CANCELLED':null]);
  return {id,token};
}
async function ledgerRow(job,operations=[]){
  const policy=hash('migration-policy'),state={job_id:job.id,policy_hash:policy,lease_token:job.token,revision:0,operations};
  await db.query('INSERT INTO public.quant_io_ledgers VALUES($1,$2,$3,0,$4,$5)',
    [job.id,policy,job.token,JSON.stringify(state),hash(canonical(state))]);
}

test('fresh I/O catalogs are exact and idempotent without changing OIDs or LEGACY/base schema',async()=>{
  const before=await catalog();assert.equal(before.tables.length,2);assert.equal(before.functions.length,3);assert.equal(before.triggers.length,3);
  assert.equal(await migrateQuantFoundation(db),'LEGACY');assert.deepEqual(await catalog(),before);
  assert.equal((await db.query('SELECT version FROM public.schema_version')).rows[0].version,14);
  await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_OFFLINE_TRANSACTION_REQUIRED'});
});

test('a second installer cannot mutate while the first owns offline maintenance',async()=>{
  const second=new PostgresDatabase({connectionString}),before=await catalog();
  try{await rollbackFixture(async()=>{
    await assert.rejects(migrateQuantFoundation(second),/Stop every PostgreSQL API and worker/);
    assert.deepEqual(await catalog(),before);
  });}finally{await second.close();}
});

test('exact manually installed W2 schemas and terminal evidence are adopted without rewriting',async()=>{
  await rollbackFixture(async()=>{
    await dropIo();
    for(const file of ['quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
      await db.query(await readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
    const f=await job();await ledgerRow(f,[{status:'SETTLED'},{status:'CRASHED'}]);
    await db.query("INSERT INTO public.quant_io_launches VALUES($1,'terminal-operation',$2,$3,$4,'STOP_PROVEN',1)",
      [f.id,f.token,'migration-'+f.id+'.service',hash('payload')]);
    const before=await catalog(),data=(await db.query('SELECT * FROM public.quant_io_ledgers')).rows,
      launches=(await db.query('SELECT * FROM public.quant_io_launches')).rows;
    await ensureQuantIoSchema(db);
    assert.deepEqual(await catalog(),before);assert.deepEqual((await db.query('SELECT * FROM public.quant_io_ledgers')).rows,data);
    assert.deepEqual((await db.query('SELECT * FROM public.quant_io_launches')).rows,launches);
  });
});

test('partial, disabled, substituted and structurally changed I/O catalogs refuse without repair',async()=>{
  const changes=[
    'DROP TABLE public.quant_profile_enrollment_receipts; DROP TABLE public.quant_io_launches',
    'ALTER TABLE public.quant_io_ledgers DISABLE TRIGGER quant_io_ledger_guard',
    'CREATE OR REPLACE FUNCTION public.quant_io_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
    'DROP TRIGGER quant_io_launch_guard ON public.quant_io_launches; CREATE TRIGGER quant_io_launch_guard BEFORE UPDATE OR DELETE ON public.quant_io_launches FOR EACH ROW EXECUTE FUNCTION public.quant_io_ledger_guard()',
    'ALTER TABLE public.quant_io_ledgers ADD COLUMN unsafe_extra text',
    'ALTER TABLE public.quant_io_ledgers ALTER COLUMN revision SET DEFAULT 0',
    'ALTER TABLE public.quant_io_launches DROP CONSTRAINT quant_io_launches_job_id_fkey; ALTER TABLE public.quant_io_launches ADD FOREIGN KEY(job_id) REFERENCES public.quant_foundation_jobs(job_id)',
    'ALTER TABLE public.quant_io_ledgers DROP CONSTRAINT quant_io_ledgers_revision_check; ALTER TABLE public.quant_io_ledgers ADD CHECK(revision >= -1)'
  ];
  const baseline=await catalog();
  for(const sql of changes){
    await rollbackFixture(async()=>{
      await db.query(sql);const changed=await catalog();
      await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_SCHEMA_UNSUPPORTED'},sql);
      assert.deepEqual(await catalog(),changed,'refusal must not repair catalog');
    });
    assert.deepEqual(await catalog(),baseline,'rollback restores original catalog');
  }
  await rollbackFixture(async()=>{
    await dropIo();await db.query('CREATE FUNCTION public.quant_io_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$');
    await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_SCHEMA_UNSUPPORTED'});
    assert.equal((await db.query("SELECT to_regclass('public.quant_io_ledgers') present")).rows[0].present,null);
  });
});

test('persisted active jobs or unresolved/invalid ledger evidence blocks offline installation',async()=>{
  for(const status of ['RUNNING','STOPPING'])await rollbackFixture(async()=>{
    await job(status);await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_FOUNDATION_NOT_IDLE'});
  });
  for(const status of ['RESERVED','ACTIVE','STOP_REQUIRED','CRASHED_UNCONFIRMED','UNKNOWN'])await rollbackFixture(async()=>{
    const f=await job();await ledgerRow(f,[{status}]);await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_NOT_IDLE'});
  });
  await rollbackFixture(async()=>{
    const f=await job();await ledgerRow(f,[]);
    await db.query("INSERT INTO public.quant_io_launches VALUES($1,'unresolved',$2,$3,$4,'STARTING',1)",
      [f.id,f.token,'unresolved-'+f.id+'.service',hash('payload')]);
    await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_NOT_IDLE'});
  });
});

test('a failure during the second SQL resource rolls back the first resource and preserves prior catalog',async()=>{
  const before=await catalog();let sawFirst=false;
  const wrapped={get isTransaction(){return db.isTransaction;},maintenanceLock:()=>db.maintenanceLock(),query:async(sql,args)=>{
    if(sql.includes('CREATE TABLE quant_io_launches')){
      sawFirst=!!(await db.query("SELECT to_regclass('public.quant_io_ledgers') present")).rows[0].present;
      throw Error('injected second resource failure');
    }
    return db.query(sql,args);
  }};
  await assert.rejects(db.transaction(async()=>{await db.maintenanceLock();await dropIo();await ensureQuantIoSchema(wrapped);}),
    {code:'QUANT_IO_SCHEMA_UNSUPPORTED'});
  assert.equal(sawFirst,true);assert.deepEqual(await catalog(),before);
});

test('post-install compatibility refusal rolls back both newly installed tables',async()=>{
  const before=await catalog();let refusedFresh=false;
  const wrapped={get isTransaction(){return db.isTransaction;},maintenanceLock:()=>db.maintenanceLock(),query:async(sql,args)=>{
    const result=await db.query(sql,args);
    if(sql.includes('SELECT p.oid')&&result.rows.length===3){refusedFresh=true;return {rows:result.rows.map(row=>({...row,prosrc:row.prosrc+'\nchanged'}))};}
    return result;
  }};
  await assert.rejects(db.transaction(async()=>{await db.maintenanceLock();await dropIo();await ensureQuantIoSchema(wrapped);}),
    {code:'QUANT_IO_SCHEMA_UNSUPPORTED'});
  assert.equal(refusedFresh,true);assert.deepEqual(await catalog(),before);
});

test('idle gate ignores empty shadow tables and reports active public jobs',async()=>{
  await rollbackFixture(async()=>{
    await job('RUNNING');await db.query('CREATE SCHEMA migration_shadow');
    for(const table of ['quant_foundation_jobs','quant_io_ledgers','quant_io_launches'])
      await db.query('CREATE TABLE migration_shadow.'+table+' (LIKE public.'+table+')');
    await db.query('SET LOCAL search_path=migration_shadow,public,pg_catalog');
    // The rollback fixture already wrote setup, so only the gate's READ ONLY declaration is skipped.
    // Every catalog and operational read still executes against PostgreSQL with the shadow search_path.
    const result=await checkQuantFoundationIdle({transaction:callback=>callback(),
      query:(sql,...args)=>sql==='SET TRANSACTION READ ONLY'?Promise.resolve({rows:[]}):db.query(sql,...args)});
    assert.equal(result.ok,false);assert.ok(result.codes.includes('QUANT_IDLE_EXECUTOR_ACTIVE'));
  });
});
