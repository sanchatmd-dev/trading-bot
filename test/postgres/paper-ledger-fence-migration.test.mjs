import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {FENCE_SQL,ensurePaperLedgerFence,inspectPaperLedgerFence,requirePaperLedgerFence,rollbackPaperLedgerFence}
  from '../../src/postgres/paper-ledger-fence.js';
import {inspectBotParentHardening} from '../../src/postgres/bot-parent-hardening-migration.js';
import {inspectQuantIoReleaseGuardHardening} from '../../src/postgres/quant-io-release-guard-hardening-migration.js';
import {inspectQuantResearchGuardHardening} from '../../src/postgres/quant-research-guard-hardening-migration.js';
import {inspectQuantResearchFreeze} from '../../src/postgres/quant-research-freeze-migration.js';
import {assertQuantProfileEnrollmentSchema} from '../../src/postgres/quant-profile-enrollment-migration.js';

// F4 fence packaging (FD1-r2 slice S3, tests M1-M7 and M9; M8 needs the call sites of slice S4). Core migrate() ensures the fence
// table on every successful path. Every database and role here is a throwaway on the isolated test cluster.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const suffix=randomUUID().replaceAll('-','').slice(0,12);
let admin;
const databases=[],roles=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
function connect(name,user){const db=new PostgresDatabase({connectionString:urlOf(name,user),max:3});pools.push(db);return db;}
async function database(label){
  const name='robot_fence_'+label+'_'+randomUUID().replaceAll('-','').slice(0,16);
  await admin.query('CREATE DATABASE '+name);databases.push(name);
  return {name,db:connect(name)};
}
async function role(label,{login=false}={}){
  const name='robot_fence_'+label+'_'+suffix;
  await admin.query('CREATE ROLE '+name+(login?' LOGIN':' NOLOGIN')+' NOSUPERUSER NOCREATEDB NOCREATEROLE'+(login?rolePasswordClause():''));
  roles.push(name);return name;
}
const grantRuntime=async(db,name)=>db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',name));
const version=async db=>(await db.query('SELECT version FROM schema_version')).rows[0].version;
const present=async(db,table)=>(await db.query('SELECT to_regclass($1) present',['public.'+table])).rows[0].present!==null;
const dropFence=db=>db.query('DROP TABLE IF EXISTS public.paper_ledger_fence');
// Everything an ensure or a rollback could change: the report, the relation's storage and owner, columns, triggers and indexes.
async function fingerprint(db){
  const one=async sql=>(await db.query(sql)).rows;
  return JSON.stringify({report:await inspectPaperLedgerFence(db),
    relation:await one("SELECT c.oid::text,c.relfilenode::text,c.relowner::text,c.relacl::text,c.reloptions FROM pg_class c WHERE c.oid=to_regclass('public.paper_ledger_fence')"),
    columns:await one("SELECT attname,atttypid::text,attisdropped FROM pg_attribute WHERE attrelid=to_regclass('public.paper_ledger_fence') AND attnum>0 ORDER BY attnum"),
    triggers:await one("SELECT tgname FROM pg_trigger WHERE tgrelid=to_regclass('public.paper_ledger_fence') ORDER BY tgname"),
    indexes:await one("SELECT indexrelid::regclass::text AS name FROM pg_index WHERE indrelid=to_regclass('public.paper_ledger_fence') ORDER BY 1")});
}
async function readOnlyInspect(db){
  const client=await db.pool.connect();
  try{await client.query('BEGIN READ ONLY');return await inspectPaperLedgerFence({query:(sql,params)=>client.query(sql,params)});}
  finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
}
const user=async db=>{const id=randomUUID();await db.query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'fixture',1)",[id,id+'@example.test']);return id;};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
});
after(async()=>{
  for(const db of pools)await db.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  for(const name of roles)await admin?.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
  await admin?.close();
});

test('M1 migrate() on a fresh database installs the fence; a READ ONLY inspection agrees; the schema version stays 14',async()=>{
  const {db}=await database('m1');
  await db.migrate();
  const report=await inspectPaperLedgerFence(db);
  assert.equal(report.state,'INSTALLED');assert.deepEqual(report.failures,[]);assert.equal(report.ok,true);
  assert.equal(report.facts.owner,report.facts.reference_owner);assert.deepEqual(report.facts.acl,report.facts.reference_acl);
  assert.deepEqual(report.facts.reloptions,['fillfactor=50']);assert.equal(report.facts.indexes,1);
  assert.deepEqual(await readOnlyInspect(db),report);
  assert.equal(await version(db),14);await db.verifySchema();
  assert.deepEqual(await requirePaperLedgerFence(db),report);
});

test('M2 migrate() on a schema 14 database without the fence creates it with the paper_funding grants; a second migrate() changes nothing',async()=>{
  const {db}=await database('m2'),grantee=await role('m2_grantee');
  await db.migrate();
  // A database from before this release: schema 14 with data and the runtime grants, and no fence table.
  const id=await user(db);await grantRuntime(db,grantee);await dropFence(db);
  assert.equal((await inspectPaperLedgerFence(db)).state,'ABSENT');
  await db.migrate();
  const report=await inspectPaperLedgerFence(db);
  assert.equal(report.state,'INSTALLED',report.failures.join(', '));
  assert.ok(report.facts.acl.includes(grantee+':SELECT:-')&&report.facts.acl.includes(grantee+':UPDATE:-'),'the runtime grants are replayed');
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])
    assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) ok',[grantee,'public.paper_ledger_fence',privilege])).rows[0].ok,true,privilege);
  assert.equal(await version(db),14);await db.verifySchema();
  await db.query('INSERT INTO public.paper_ledger_fence VALUES($1,7,1)',[id]);
  const installed=await fingerprint(db);
  await db.migrate();
  assert.equal(await fingerprint(db),installed,'a second migrate() is a no-op');
  assert.deepEqual((await db.query('SELECT user_id,version FROM public.paper_ledger_fence')).rows,[{user_id:id,version:7}]);
  await assert.rejects(db.query('INSERT INTO public.paper_ledger_fence VALUES($1,0,1)',[await user(db)]),{code:'23514'});
  await assert.rejects(db.query("INSERT INTO public.paper_ledger_fence VALUES('no-such-user',1,1)"),{code:'23503'});
});

test('M3 and M7: every OTHER fence makes migrate() refuse and stay untouched; the runtime check tolerates only owner, ACL, reloptions and a plain extra index',async()=>{
  const {name,db}=await database('m3'),other=await role('m3_other'),creator=await role('m3_creator',{login:true});
  await db.migrate();
  await db.query('GRANT CREATE ON SCHEMA public TO '+creator);await db.query('GRANT REFERENCES ON public.users TO '+creator);
  const creatorDb=connect(name,creator);
  const variants=[
    {label:'extra column',failure:'FENCE_COLUMNS',runtime:false,make:async()=>{await db.query(FENCE_SQL);await db.query('ALTER TABLE public.paper_ledger_fence ADD COLUMN note TEXT');}},
    {label:'user trigger',failure:'FENCE_USER_TRIGGER',runtime:false,make:async()=>{await db.query(FENCE_SQL);
      await db.query('CREATE FUNCTION public.fence_fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$');
      await db.query('CREATE TRIGGER fence_fixture BEFORE INSERT ON public.paper_ledger_fence FOR EACH ROW EXECUTE FUNCTION public.fence_fixture_trigger()');}},
    {label:'missing fillfactor',failure:'FENCE_RELOPTIONS',runtime:true,make:()=>db.query(FENCE_SQL.replace(' WITH (fillfactor=50)',''))},
    {label:'UNLOGGED',failure:'FENCE_PERSISTENCE',runtime:false,make:()=>db.query(FENCE_SQL.replace('CREATE TABLE','CREATE UNLOGGED TABLE'))},
    {label:'owner differs',failure:'FENCE_OWNER',runtime:true,make:async()=>{await db.query(FENCE_SQL);await db.query('ALTER TABLE public.paper_ledger_fence OWNER TO '+other);}},
    {label:'ACL differs',failure:'FENCE_ACL',runtime:true,make:async()=>{await db.query(FENCE_SQL);await db.query('GRANT SELECT ON public.paper_ledger_fence TO '+other);}},
    {label:'extra index',failure:'FENCE_EXTRA_INDEX',runtime:true,make:async()=>{await db.query(FENCE_SQL);await db.query('CREATE INDEX fence_fixture_updated ON public.paper_ledger_fence(updated_at)');}},
    // F-1: the right shape, created by a role that does not own paper_funding.
    {label:'created by a different role',failure:'FENCE_OWNER',runtime:true,make:()=>creatorDb.query(FENCE_SQL)}];
  for(const variant of variants){
    await dropFence(db);await db.query('DROP FUNCTION IF EXISTS public.fence_fixture_trigger()');
    await variant.make();
    const report=await inspectPaperLedgerFence(db);
    assert.equal(report.state,'OTHER',variant.label);assert.deepEqual(report.failures,[variant.failure],variant.label);
    // The whole migrate transaction fails closed: a table the version 14 path would create is not created either.
    await db.query('DROP TABLE IF EXISTS public.quant_research_runs');
    const untouched=await fingerprint(db);
    await assert.rejects(db.migrate(),{code:'PAPER_LEDGER_FENCE_OTHER'},variant.label);
    assert.equal(await fingerprint(db),untouched,variant.label+': left untouched');
    assert.equal(await present(db,'quant_research_runs'),false,variant.label+': migrate rolled back as a whole');
    assert.equal(await version(db),14);
    if(variant.runtime)assert.equal((await requirePaperLedgerFence(db)).state,'OTHER',variant.label+': the runtime check starts');
    else await assert.rejects(requirePaperLedgerFence(db),{code:'PAPER_LEDGER_FENCE_OTHER'},variant.label+': the runtime check refuses');
    await assert.rejects(db.transaction(()=>ensurePaperLedgerFence(db)),{code:'PAPER_LEDGER_FENCE_OTHER'});
  }
  await dropFence(db);await db.migrate();
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');assert.equal(await present(db,'quant_research_runs'),true);
});

test('M3b ensure creates the fence as the paper_funding owner through SET ROLE, and refuses FENCE_OWNER_MISMATCH before any write without it',async()=>{
  const {name,db}=await database('m3b');
  const owner=await role('m3b_owner'),reader=await role('m3b_reader'),migrator=await role('m3b_migrator',{login:true}),outsider=await role('m3b_outsider',{login:true});
  await db.migrate();await dropFence(db);
  await db.query('ALTER TABLE public.paper_funding OWNER TO '+owner);
  await db.query('GRANT CREATE ON SCHEMA public TO '+owner);await db.query('GRANT REFERENCES ON public.users TO '+owner);
  await db.query('GRANT SELECT,INSERT ON public.paper_funding TO '+reader);
  await db.query('GRANT '+owner+' TO '+migrator);
  const outsiderDb=connect(name,outsider);
  await assert.rejects(outsiderDb.transaction(()=>ensurePaperLedgerFence(outsiderDb)),{code:'FENCE_OWNER_MISMATCH'});
  assert.equal((await inspectPaperLedgerFence(db)).state,'ABSENT','nothing was created');
  const migratorDb=connect(name,migrator);
  const result=await migratorDb.transaction(async()=>({report:await ensurePaperLedgerFence(migratorDb),
    role:(await migratorDb.query('SELECT current_user::text AS name')).rows[0].name}));
  assert.equal(result.report.previous_state,'ABSENT');assert.equal(result.report.state,'INSTALLED');
  assert.equal(result.role,migrator,'the caller role is restored for the rest of its transaction');
  const report=await inspectPaperLedgerFence(db);
  assert.equal(report.state,'INSTALLED',report.failures.join(', '));assert.equal(report.facts.owner,owner);
  assert.ok(report.facts.acl.includes(reader+':SELECT:-')&&report.facts.acl.includes(reader+':INSERT:-'));
  assert.equal((await db.query("SELECT has_table_privilege($1,'public.paper_ledger_fence','UPDATE') ok",[reader])).rows[0].ok,false,'only the replayed grants');
});

test('M4 rollback drops only an INSTALLED fence, is a no-op when ABSENT and refuses OTHER untouched; the CLI inspects and rolls back',async()=>{
  const {name,db}=await database('m4');
  await db.migrate();
  assert.deepEqual(await rollbackPaperLedgerFence(db),{rolled_back:true,previous_state:'INSTALLED'});
  assert.equal((await inspectPaperLedgerFence(db)).state,'ABSENT');await db.verifySchema();
  assert.deepEqual(await rollbackPaperLedgerFence(db),{rolled_back:false,previous_state:'ABSENT'});
  await db.migrate();
  await db.query('ALTER TABLE public.paper_ledger_fence ADD COLUMN note TEXT');
  const other=await fingerprint(db);
  await assert.rejects(rollbackPaperLedgerFence(db),{code:'PAPER_LEDGER_FENCE_OTHER'});
  assert.equal(await fingerprint(db),other,'OTHER is left untouched');
  await db.query('ALTER TABLE public.paper_ledger_fence DROP COLUMN note');
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED','a dropped column is not part of the shape');
  await assert.rejects(db.transaction(()=>rollbackPaperLedgerFence(db)),{code:'PAPER_LEDGER_FENCE_TRANSACTION_REQUIRED'});
  await assert.rejects(ensurePaperLedgerFence(db),{code:'PAPER_LEDGER_FENCE_TRANSACTION_REQUIRED'});
  const script='scripts/paper-ledger-fence.mjs',env={...process.env,DATABASE_URL:urlOf(name)};
  const cli=(...args)=>run(process.execPath,[script,...args],{cwd:repoRoot,env});
  assert.equal(JSON.parse((await cli('--inspect')).stdout).state,'INSTALLED');
  assert.match((await cli('--rollback')).stdout,/Paper ledger fence removed; previous state=INSTALLED/);
  await assert.rejects(cli('--inspect'),error=>error.code===1&&JSON.parse(error.stdout).state==='ABSENT');
  assert.match((await cli('--rollback')).stdout,/already absent; nothing removed/);
  for(const args of [[],['--other'],['--inspect','--rollback']])await assert.rejects(cli(...args),/Usage/);
  await db.migrate();assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
});

test('M5 rollback refuses while an API or worker holds the runtime lock, and leaves the fence INSTALLED',async()=>{
  const {name,db}=await database('m5');
  await db.migrate();
  const service=connect(name);await service.runtimeLock();
  await assert.rejects(rollbackPaperLedgerFence(db),/Stop every PostgreSQL API and worker before maintenance/);
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
  await service.close();pools.splice(pools.indexOf(service),1);
  assert.equal((await rollbackPaperLedgerFence(db)).rolled_back,true);
});

test('M6 every existing guard inspector returns the same result with and without the fence table',async()=>{
  const {db}=await database('m6');
  await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql',
    'quant-storage-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql','quant-profile-enrollment-schema.sql'])
    await db.query(await fs.readFile(new URL(file,sourceDir),'utf8'));
  assert.deepEqual(await installQuantGuards(db),['bot-parent','research-mode-guards','io-release-guard','research-freeze']);
  const inspectors=async()=>({botParent:await inspectBotParentHardening(db),ioRelease:await inspectQuantIoReleaseGuardHardening(db),
    researchGuard:await inspectQuantResearchGuardHardening(db),researchFreeze:await inspectQuantResearchFreeze(db),
    profileEnrollment:await assertQuantProfileEnrollmentSchema(db)});
  const withFence=await inspectors();
  for(const [name,report] of Object.entries(withFence))if(name!=='profileEnrollment')assert.equal(report.ok,true,name+': '+report.failures?.join(', '));
  assert.equal(withFence.profileEnrollment,true);
  await rollbackPaperLedgerFence(db);
  assert.deepEqual(await inspectors(),withFence,'without the fence table');
  await db.migrate();
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
  assert.deepEqual(await inspectors(),withFence,'after migrate() adds it again');
});

test('M7 the runtime check refuses ABSENT with the migrate script named, and refuses a role without SELECT, INSERT and UPDATE',async()=>{
  const {name,db}=await database('m7'),runtime=await role('m7_runtime',{login:true});
  await db.migrate();await rollbackPaperLedgerFence(db);
  await assert.rejects(requirePaperLedgerFence(db),error=>error.code==='PAPER_LEDGER_FENCE_ABSENT'&&/scripts\/migrate-postgres\.mjs/.test(error.message));
  await db.migrate();
  const rt=connect(name,runtime);
  await assert.rejects(requirePaperLedgerFence(rt),{code:'PAPER_LEDGER_FENCE_PRIVILEGE'});
  // Any one privilege is not enough: has_table_privilege with a list would have accepted this.
  await db.query('GRANT SELECT ON public.paper_ledger_fence TO '+runtime);
  await assert.rejects(requirePaperLedgerFence(rt),{code:'PAPER_LEDGER_FENCE_PRIVILEGE'});
  await db.query('REVOKE ALL ON public.paper_ledger_fence FROM '+runtime);
  await grantRuntime(db,runtime);
  assert.equal((await requirePaperLedgerFence(rt)).state,'INSTALLED','the repo runtime grants are enough');
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED','the grant script keeps the fence ACL equal to paper_funding');
});

test('M9 a schema 11 database migrated to 14 ends with the fence INSTALLED',async()=>{
  const {db}=await database('m9');
  await db.migrate();
  // A synthetic schema 11 database: the relations the 11 to 14 chain creates are removed and the version is set back.
  for(const table of ['paper_ledger_fence','quant_research_runs','bot_session_archive','bot_sessions','ledger_position_allocations'])
    await db.query('DROP TABLE public.'+table);
  await db.query('UPDATE schema_version SET version=11');
  assert.equal((await inspectPaperLedgerFence(db)).state,'ABSENT');
  await db.migrate();
  assert.equal(await version(db),14);
  for(const table of ['ledger_position_allocations','bot_sessions','bot_session_archive','quant_research_runs'])assert.equal(await present(db,table),true,table);
  const report=await inspectPaperLedgerFence(db);
  assert.equal(report.state,'INSTALLED',report.failures.join(', '));
});

// ---- S3-R2 review items: each case fails on the first S3 commit and passes after the fix round ----------------------------------
const fenceWith=userId=>`CREATE TABLE public.paper_ledger_fence(user_id ${userId} PRIMARY KEY REFERENCES public.users(id),
  version pg_catalog.int8 NOT NULL CHECK(version > 0),updated_at pg_catalog.int8 NOT NULL) WITH (fillfactor=50)`;
// Polls pg_locks until some session of this database waits for the given kind of lock (bounded; false when nobody waits).
async function waitsFor(db,kind){
  const where=kind==='advisory'?"l.locktype='advisory'":"l.locktype='relation' AND l.relation=to_regclass('public.paper_ledger_fence')";
  for(let i=0;i<200;i++){
    if((await db.query('SELECT count(*)::int AS n FROM pg_locks l WHERE NOT l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND '+where)).rows[0].n)return true;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  return false;
}

test('M3c a user_id with another collation (C, or a nondeterministic ICU one) is OTHER and blocks migrate() and startup',async t=>{
  const {db}=await database('m3c');
  await db.migrate();
  const variants=[['C','pg_catalog.text COLLATE "C"']];
  try{await db.query("CREATE COLLATION public.fence_fixture_ci (provider=icu, locale='und-u-ks-level2', deterministic=false)");variants.push(['nondeterministic ICU','pg_catalog.text COLLATE public.fence_fixture_ci']);}
  catch(error){t.diagnostic('ICU collation not available on this server: '+error.message);}
  for(const [label,userId] of variants){
    await dropFence(db);await db.query(fenceWith(userId));
    const report=await inspectPaperLedgerFence(db);
    assert.equal(report.state,'OTHER',label);assert.deepEqual(report.failures,['FENCE_COLLATION'],label);
    await assert.rejects(db.migrate(),{code:'PAPER_LEDGER_FENCE_OTHER'},label);
    await assert.rejects(requirePaperLedgerFence(db),{code:'PAPER_LEDGER_FENCE_OTHER'},label);
  }
  await dropFence(db);await db.migrate();assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
});

test('M3d types are compared by OID: a domain named text on the search_path is OTHER, and ensure under that path still creates pg_catalog types and operators',async()=>{
  const {db}=await database('m3d');
  await db.migrate();
  await db.query('CREATE SCHEMA fence_fixture');await db.query('CREATE DOMAIN fence_fixture.text AS pg_catalog.text');
  // An operator that would turn the version CHECK into a no-op if the create resolved it through the caller's search_path.
  await db.query("CREATE FUNCTION fence_fixture.always(pg_catalog.int8,pg_catalog.int4) RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE AS 'SELECT true'");
  await db.query('CREATE OPERATOR fence_fixture.> (LEFTARG=pg_catalog.int8,RIGHTARG=pg_catalog.int4,FUNCTION=fence_fixture.always)');
  const hostile="SELECT set_config('search_path','fence_fixture, pg_catalog, public',true)";
  await dropFence(db);await db.query(fenceWith('fence_fixture.text'));
  const seen=await db.transaction(async()=>{await db.query(hostile);return inspectPaperLedgerFence(db);});
  assert.equal(seen.state,'OTHER');assert.ok(seen.failures.includes('FENCE_COLUMNS'),seen.failures.join(', '));
  await assert.rejects(db.migrate(),{code:'PAPER_LEDGER_FENCE_OTHER'});
  await dropFence(db);
  const created=await db.transaction(async()=>{await db.query(hostile);
    return {report:await ensurePaperLedgerFence(db),path:(await db.query("SELECT current_setting('search_path') AS path")).rows[0].path};});
  assert.equal(created.report.state,'INSTALLED');assert.equal(created.path,'fence_fixture, pg_catalog, public','the caller search_path comes back');
  assert.deepEqual((await db.query("SELECT atttypid::int AS type FROM pg_attribute WHERE attrelid='public.paper_ledger_fence'::regclass AND attnum>0 ORDER BY attnum")).rows.map(row=>row.type),[25,20,20]);
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
  await assert.rejects(db.query('INSERT INTO public.paper_ledger_fence VALUES($1,0,1)',[await user(db)]),{code:'23514'},'the CHECK uses the pg_catalog operator');
});

test('M3e a disabled trigger on the fence or on the users side of its foreign key is OTHER and blocks migrate() and startup',async()=>{
  const {db}=await database('m3e');
  await db.migrate();
  for(const table of ['paper_ledger_fence','users']){
    await db.query('ALTER TABLE public.'+table+' DISABLE TRIGGER ALL');
    const report=await inspectPaperLedgerFence(db);
    assert.equal(report.state,'OTHER',table);assert.deepEqual(report.failures,['FENCE_TRIGGER_DISABLED'],table);
    await assert.rejects(requirePaperLedgerFence(db),{code:'PAPER_LEDGER_FENCE_OTHER'},table);
    await assert.rejects(db.migrate(),{code:'PAPER_LEDGER_FENCE_OTHER'},table);
    await db.query('ALTER TABLE public.'+table+' ENABLE TRIGGER ALL');
    assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED',table);
  }
});

test('M7b the runtime check tolerates a plain extra index only; a unique, partial, exclusion or expression index blocks startup',async()=>{
  const {db}=await database('m7b');
  await db.migrate();
  const cases=[['plain','CREATE INDEX fence_fixture_index ON public.paper_ledger_fence(updated_at)',true],
    ['unique','CREATE UNIQUE INDEX fence_fixture_index ON public.paper_ledger_fence(version)',false],
    ['partial unique','CREATE UNIQUE INDEX fence_fixture_index ON public.paper_ledger_fence(updated_at) WHERE version>5',false],
    ['partial','CREATE INDEX fence_fixture_index ON public.paper_ledger_fence(updated_at) WHERE version>5',false],
    ['expression','CREATE INDEX fence_fixture_index ON public.paper_ledger_fence((version+updated_at))',false],
    ['exclusion','ALTER TABLE public.paper_ledger_fence ADD CONSTRAINT fence_fixture_exclusion EXCLUDE USING btree(version WITH =)',false]];
  for(const [label,sql,tolerated] of cases){
    await db.query(sql);
    const report=await inspectPaperLedgerFence(db);
    assert.equal(report.state,'OTHER',label);assert.ok(report.failures.includes('FENCE_EXTRA_INDEX'),label);
    await assert.rejects(db.migrate(),{code:'PAPER_LEDGER_FENCE_OTHER'},label);
    if(tolerated)assert.equal((await requirePaperLedgerFence(db)).state,'OTHER',label+': startup tolerates it');
    else await assert.rejects(requirePaperLedgerFence(db),error=>error.code==='PAPER_LEDGER_FENCE_OTHER'&&/FENCE_EXTRA_INDEX_UNSAFE/.test(error.message),label);
    await db.query('ALTER TABLE public.paper_ledger_fence DROP CONSTRAINT IF EXISTS fence_fixture_exclusion');await db.query('DROP INDEX IF EXISTS public.fence_fixture_index');
    assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED',label);
  }
});

test('M7c a DBA reloption change makes migrate() refuse but does not block startup',async()=>{
  const {db}=await database('m7c');
  await db.migrate();
  await db.query('ALTER TABLE public.paper_ledger_fence SET (autovacuum_enabled=false)');
  const report=await inspectPaperLedgerFence(db);
  assert.equal(report.state,'OTHER');assert.deepEqual(report.failures,['FENCE_RELOPTIONS']);
  assert.equal((await requirePaperLedgerFence(db)).state,'OTHER','startup tolerates it');
  await assert.rejects(db.migrate(),{code:'PAPER_LEDGER_FENCE_OTHER'});
  await db.query('ALTER TABLE public.paper_ledger_fence RESET (autovacuum_enabled)');
  assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
});

test('M5b rollback waits for a running migrate() (robot:schema) and holds the table from its classification to the drop',async()=>{
  const {name,db}=await database('m5b');
  await db.migrate();
  const holder=await connect(name).pool.connect();
  try{
    // A migrate() in progress holds robot:schema; rollback waits for it instead of dropping underneath it.
    await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('robot:schema',0))");
    let settled=false;
    const first=rollbackPaperLedgerFence(db).finally(()=>{settled=true;});first.catch(()=>{});
    assert.equal(await waitsFor(db,'advisory'),true,'rollback waits for the migrate lock');
    assert.equal(settled,false);assert.equal((await inspectPaperLedgerFence(db)).state,'INSTALLED');
    await holder.query('COMMIT');
    assert.deepEqual(await first,{rolled_back:true,previous_state:'INSTALLED'});
    // A change that commits while rollback waits for the table is seen by its classification, so the changed table is refused.
    await db.migrate();
    await holder.query('BEGIN');await holder.query('LOCK TABLE public.paper_ledger_fence IN ACCESS EXCLUSIVE MODE');
    const second=rollbackPaperLedgerFence(db);second.catch(()=>{});
    assert.equal(await waitsFor(db,'relation'),true,'rollback waits for the table');
    await holder.query('ALTER TABLE public.paper_ledger_fence ADD COLUMN note pg_catalog.text');await holder.query('COMMIT');
    await assert.rejects(second,{code:'PAPER_LEDGER_FENCE_OTHER'});
    assert.deepEqual((await inspectPaperLedgerFence(db)).failures,['FENCE_COLUMNS'],'the changed table is left in place');
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
});
