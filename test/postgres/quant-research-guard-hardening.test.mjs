import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {Store} from '../../src/postgres/store.js';
import {MODE_GUARDS,PINNED_SEARCH_PATH,inspectQuantResearchGuardHardening,migrateQuantResearchGuardHardening,rollbackQuantResearchGuardHardening} from '../../src/postgres/quant-research-guard-hardening-migration.js';
import {migrateQuantResearchFreeze,rollbackQuantResearchFreeze,inspectQuantResearchFreeze} from '../../src/postgres/quant-research-freeze-migration.js';
import {runOf,seedRun,seedFoundation,hex,T0} from '../helpers/quant-library-fixture.mjs';

// GH1: the research mode guards must not read a session TEMP table in place of a research table (finding QR1B-MODE-GUARDS).
// Proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repo grants. Every row is a LABELLED FIXTURE.
const MISMATCH='P0001:Research executor mode mismatch';
const DRAIN='P0001:Stop and drain every research executor before changing mode';
const FUNCTION_NAMES=MODE_GUARDS.map(item=>item[0]);
let admin,db,databaseName,roleName,connectionString,runtimeUrl,store,owner,legacy,foundation,seeded;
const databases=[];
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const install=async name=>db.transaction(async()=>db.query(await fs.readFile(new URL(name,sourceDir),'utf8')));
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const sessions=[];
async function session(){const client=new pg.Client({connectionString:runtimeUrl});await client.connect();sessions.push(client);return client;}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  databaseName='robot_guard_test_'+suffix;roleName='robot_guard_role_'+suffix.slice(0,16);
  await admin.query('CREATE DATABASE '+databaseName);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  connectionString=urlOf(databaseName);runtimeUrl=urlOf(databaseName,roleName);
  db=new PostgresDatabase({connectionString,max:6});await db.migrate();
  for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'])await install(name);
  // The repo grant script, with the throwaway role: broad SELECT/INSERT/UPDATE/DELETE, no TRUNCATE, no TRIGGER, no ownership, TEMP left at the PUBLIC default.
  await db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+roleName+"'"));
  store=new Store(db);
});
after(async()=>{
  for(const client of sessions)await client.end().catch(()=>{});
  await db?.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  if(admin){await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS '+roleName);await admin.close();}
});

async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:'guard-fixture'};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hex(importId),'Guard fixture','//@version=6\nindicator("x")','{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hex(JSON.stringify(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
const makeRun=(options)=>runOf({owner:owner.id,deployment:owner.deployment,importId:owner.importId,scenario:'PENDING',...options});
const insertJob=(client,run,status)=>client.query(`INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,phase)
  VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,'CANDIDATES')`,[run.run_id,owner.id,owner.deployment,'idem-'+run.run_id,hex('submission'),run.contract_hash,JSON.stringify(run.contract),status,run.created_at,run.created_at+900000]);
const setMode=(client,mode)=>client.query('UPDATE public.quant_research_executor_mode SET mode=$1',[mode]);

/** One statement group in its own transaction that is always rolled back; resolves to 'ok' or 'SQLSTATE:message'. */
async function attempt(client,steps){
  await client.query('BEGIN');
  try{await steps(client);return 'ok';}
  catch(error){return error.code+':'+error.message;}
  finally{await client.query('ROLLBACK');}
}

/** Normal (non-attack) behavior of both guards as the runtime role. Compared before and after hardening. */
async function matrix(client){
  const out={};
  out.legacyQueuedAtLegacy=await attempt(client,c=>insertJob(c,legacy,'QUEUED'));
  out.legacyRunningAtLegacy=await attempt(client,c=>insertJob(c,legacy,'RUNNING'));
  out.foundationQueuedAtLegacy=await attempt(client,c=>insertJob(c,foundation,'QUEUED'));
  out.foundationRunningAtLegacy=await attempt(client,c=>insertJob(c,foundation,'RUNNING'));
  out.foundationTerminalAtLegacy=await attempt(client,c=>insertJob(c,foundation,'SUCCEEDED'));
  out.modeChangeNoJobs=await attempt(client,c=>setMode(c,'FOUNDATION'));
  out.modeSameValueNoJobs=await attempt(client,c=>setMode(c,'LEGACY'));
  out.legacyQueuedAtFoundation=await attempt(client,async c=>{await setMode(c,'FOUNDATION');await insertJob(c,legacy,'QUEUED');});
  out.foundationQueuedAtFoundation=await attempt(client,async c=>{await setMode(c,'FOUNDATION');await insertJob(c,foundation,'QUEUED');});
  out.foundationRunningAtFoundation=await attempt(client,async c=>{await setMode(c,'FOUNDATION');await insertJob(c,foundation,'RUNNING');});
  out.modeChangeActiveLegacyJob=await attempt(client,async c=>{await insertJob(c,legacy,'QUEUED');await setMode(c,'FOUNDATION');});
  out.modeChangeActiveRunningJob=await attempt(client,async c=>{await insertJob(c,legacy,'RUNNING');await setMode(c,'FOUNDATION');});
  out.modeSameValueActiveJob=await attempt(client,async c=>{await insertJob(c,legacy,'QUEUED');await setMode(c,'LEGACY');});
  out.modeChangeActiveFoundationJob=await attempt(client,async c=>{
    await c.query("UPDATE public.quant_foundation_jobs SET status='QUEUED' WHERE job_id=$1",[seeded.run_id]);await setMode(c,'FOUNDATION');});
  out.modeChangeTerminalJobsOnly=await attempt(client,async c=>{await insertJob(c,legacy,'FAILED');await setMode(c,'FOUNDATION');});
  return out;
}

/** TEMP-shadow attacks as the runtime role. Each returns the outcome of the guarded statement. */
const attacks={
  // The real mode is LEGACY; the shadow says FOUNDATION, so a FOUNDATION-backend job slips past the mode guard when the shadow is read.
  async modeGuardShadow(){
    const client=await session();
    return attempt(client,async c=>{
      await c.query('CREATE TEMP TABLE quant_research_executor_mode(singleton BOOLEAN,mode TEXT)');
      await c.query("INSERT INTO quant_research_executor_mode VALUES(TRUE,'FOUNDATION')");
      await insertJob(c,foundation,'QUEUED');
    });
  },
  // A real QUEUED job exists; empty shadows of both job tables hide it, so the executor mode flips while work is active.
  async modeChangeShadow(){
    const client=await session();
    return attempt(client,async c=>{
      await insertJob(c,legacy,'QUEUED');
      await c.query('CREATE TEMP TABLE quant_jobs(status TEXT)');
      await c.query('CREATE TEMP TABLE quant_foundation_jobs(status TEXT)');
      await setMode(c,'FOUNDATION');
    });
  },
  // The shadow is also ahead of public when the attacker orders the search_path itself.
  async modeGuardShadowExplicitPath(){
    const client=await session();
    return attempt(client,async c=>{
      await c.query('CREATE TEMP TABLE quant_research_executor_mode(singleton BOOLEAN,mode TEXT)');
      await c.query("INSERT INTO quant_research_executor_mode VALUES(TRUE,'FOUNDATION')");
      await c.query('SET LOCAL search_path = pg_temp, public');
      await insertJob(c,foundation,'QUEUED');
    });
  }
};

const defs=async()=>Object.fromEntries((await db.query(`SELECT p.proname,pg_get_functiondef(p.oid) def FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) ORDER BY 1`,[FUNCTION_NAMES])).rows.map(row=>[row.proname,row.def]));
const triggerRows=async()=>(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
  WHERE NOT t.tgisinternal AND t.tgname=ANY($1) ORDER BY t.tgname`,[FUNCTION_NAMES])).rows;
const functionMeta=async()=>(await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,p.proacl::text acl FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1) ORDER BY 1`,[FUNCTION_NAMES])).rows;
const tableDigest=async()=>(await db.query(`SELECT (SELECT count(*) FROM quant_jobs)::int jobs,(SELECT count(*) FROM quant_foundation_jobs)::int foundation,
  (SELECT string_agg(mode,',') FROM quant_research_executor_mode) mode`)).rows[0];

let original,controlOutcomes,baselineMatrix,hardenedDefs,rowsBefore;

test('setup: runtime role is a non-owner with TEMP privilege and the original guards are in place',async()=>{
  owner=await newOwner('guard-a');
  legacy=makeRun({});foundation=makeRun({version:'v2'});
  // legacy and foundation are contract carriers only; every case inserts them inside a rolled-back transaction. seeded is a finished FOUNDATION run.
  seeded=makeRun({version:'v2'});
  await seedRun(db,seeded,{owner:owner.id,deployment:owner.deployment});await seedFoundation(db,seeded,{owner:owner.id});
  const role=(await db.query("SELECT rolsuper,rolbypassrls,has_database_privilege(rolname,current_database(),'TEMP') temp FROM pg_roles WHERE rolname=$1",[roleName])).rows[0];
  assert.deepEqual([role.rolsuper,role.rolbypassrls,role.temp],[false,false,true],'runtime role: not superuser, no RLS bypass, TEMP privilege held');
  const metas=await functionMeta();
  assert.equal(metas.length,2);
  for(const meta of metas){assert.equal(meta.prosecdef,false,meta.proname);assert.equal(meta.proconfig,null,meta.proname+' has no pinned search_path');assert.notEqual(meta.owner,roleName);}
  assert.equal((await inspectQuantResearchGuardHardening(db)).facts.state,'ORIGINAL');
  original=await defs();rowsBefore=await tableDigest();
  assert.ok(FUNCTION_NAMES.every(name=>original[name]&&!/search_path/.test(original[name])));
});

test('control: before hardening a TEMP table changes the outcome of both guards',async()=>{
  controlOutcomes={modeGuardShadow:await attacks.modeGuardShadow(),modeChangeShadow:await attacks.modeChangeShadow()};
  assert.equal(controlOutcomes.modeGuardShadow,'ok','the shadow made a FOUNDATION job pass while the real mode is LEGACY');
  assert.equal(controlOutcomes.modeChangeShadow,'ok','the shadows hid an active job and the mode changed');
  // The same statements without a shadow are refused: it is the shadow that flips the result.
  const plain=await session();
  assert.equal(await attempt(plain,c=>insertJob(c,foundation,'QUEUED')),MISMATCH);
  assert.equal(await attempt(plain,async c=>{await insertJob(c,legacy,'QUEUED');await setMode(c,'FOUNDATION');}),DRAIN);
  assert.deepEqual(await tableDigest(),rowsBefore,'every attack ran inside a rolled-back transaction');
});

test('normal guard behavior before hardening (baseline) is the documented behavior',async()=>{
  const client=await session();
  baselineMatrix=await matrix(client);
  assert.equal(baselineMatrix.legacyQueuedAtLegacy,'ok');
  assert.equal(baselineMatrix.foundationQueuedAtLegacy,MISMATCH);
  assert.equal(baselineMatrix.foundationRunningAtLegacy,MISMATCH);
  assert.equal(baselineMatrix.foundationTerminalAtLegacy,'ok');
  assert.equal(baselineMatrix.modeChangeNoJobs,'ok');
  assert.equal(baselineMatrix.legacyQueuedAtFoundation,MISMATCH);
  assert.equal(baselineMatrix.foundationQueuedAtFoundation,'ok');
  assert.equal(baselineMatrix.modeChangeActiveLegacyJob,DRAIN);
  assert.equal(baselineMatrix.modeChangeActiveRunningJob,DRAIN);
  assert.equal(baselineMatrix.modeSameValueActiveJob,'ok');
  assert.equal(baselineMatrix.modeChangeActiveFoundationJob,DRAIN,'an active FOUNDATION job also blocks a mode change');
  assert.equal(baselineMatrix.modeChangeTerminalJobsOnly,'ok');
  assert.deepEqual(await tableDigest(),rowsBefore);
});

test('the hardening migration is offline only: maintenance lock, own transaction, foundation extension',async()=>{
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateQuantResearchGuardHardening(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackQuantResearchGuardHardening(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateQuantResearchGuardHardening(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackQuantResearchGuardHardening(db)),/own transaction/);
  assert.deepEqual(await defs(),original,'refused attempts changed nothing');
  // A database without the foundation extension is refused instead of creating orphan functions.
  const bare='robot_guard_bare_'+randomUUID().replaceAll('-','');databases.push(bare);
  await admin.query('CREATE DATABASE '+bare);
  const bareDb=new PostgresDatabase({connectionString:urlOf(bare)});
  try{
    await bareDb.migrate();
    await assert.rejects(migrateQuantResearchGuardHardening(bareDb),/foundation extension required/);
    await assert.rejects(rollbackQuantResearchGuardHardening(bareDb),/foundation extension required/);
    assert.equal((await bareDb.query("SELECT count(*)::int n FROM pg_proc WHERE proname=ANY($1)",[FUNCTION_NAMES])).rows[0].n,0);
  }finally{await bareDb.close();}
});

test('install: only the two functions change; owner, grants, triggers and rows are untouched',async()=>{
  const metaBefore=await functionMeta(),triggersBefore=await triggerRows();
  const aclBefore=(await db.query("SELECT encode(sha256(convert_to(COALESCE(string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname),''),'UTF8')),'hex') d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')")).rows[0].d;
  const tablesBefore=(await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows;
  const report=await migrateQuantResearchGuardHardening(db);
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.facts.state,'HARDENED');
  hardenedDefs=await defs();
  for(const name of FUNCTION_NAMES){
    assert.notEqual(hardenedDefs[name],original[name],name);
    assert.match(hardenedDefs[name],/SET search_path TO 'pg_catalog', 'pg_temp'/);
    assert.doesNotMatch(hardenedDefs[name],/SECURITY DEFINER/);
  }
  assert.match(hardenedDefs.quant_research_mode_guard,/FROM public\.quant_research_executor_mode/);
  assert.match(hardenedDefs.quant_research_mode_change,/FROM public\.quant_jobs/);assert.match(hardenedDefs.quant_research_mode_change,/FROM public\.quant_foundation_jobs/);
  const metaAfter=await functionMeta();
  for(const [index,meta] of metaAfter.entries()){
    assert.equal(meta.prosecdef,false);assert.deepEqual(meta.proconfig,[PINNED_SEARCH_PATH]);
    assert.equal(meta.owner,metaBefore[index].owner);assert.equal(meta.acl,metaBefore[index].acl);
  }
  assert.deepEqual(await triggerRows(),triggersBefore,'the same triggers still call the same functions');
  assert.equal((await db.query("SELECT encode(sha256(convert_to(COALESCE(string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname),''),'UTF8')),'hex') d FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')")).rows[0].d,aclBefore,'no grant changed');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows,tablesBefore,'no table added');
  assert.deepEqual(await tableDigest(),rowsBefore,'no row changed');
});

test('after hardening the TEMP-shadow attacks no longer change either guard',async()=>{
  assert.equal(await attacks.modeGuardShadow(),MISMATCH);
  assert.equal(await attacks.modeChangeShadow(),DRAIN);
  assert.equal(await attacks.modeGuardShadowExplicitPath(),MISMATCH);
  assert.notEqual(await attacks.modeGuardShadow(),controlOutcomes.modeGuardShadow,'the control outcome differed');
  assert.deepEqual(await tableDigest(),rowsBefore);
});

test('normal guard behavior is identical before and after hardening',async()=>{
  const client=await session();
  assert.deepEqual(await matrix(client),baselineMatrix);
});

test('re-applying converges: the same definitions, triggers and metadata',async()=>{
  const triggers=await triggerRows(),meta=await functionMeta();
  const again=await migrateQuantResearchGuardHardening(db);
  assert.equal(again.ok,true);assert.equal(again.facts.state,'HARDENED');assert.equal(again.previous_state,'HARDENED','a hardened database is a no-op re-apply');
  assert.deepEqual(await defs(),hardenedDefs);assert.deepEqual(await triggerRows(),triggers);assert.deepEqual(await functionMeta(),meta);
  assert.deepEqual(await tableDigest(),rowsBefore);
});

test('rollback restores the original definitions exactly, and the control attack works again',async()=>{
  assert.deepEqual(await rollbackQuantResearchGuardHardening(db),{rolled_back:true,previous_state:'HARDENED'});
  assert.deepEqual(await defs(),original,'pg_get_functiondef equals the pre-hardening text');
  // The stored function text equals the text in the applied schema file.
  const schema=await fs.readFile(new URL('quant-research-foundation-schema.sql',sourceDir),'utf8');
  for(const name of FUNCTION_NAMES){
    const body=new RegExp('CREATE FUNCTION '+name+'\\(\\) RETURNS TRIGGER LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$;').exec(schema)[1];
    assert.equal((await db.query('SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure($1)',['public.'+name+'()'])).rows[0].prosrc,body,name);
  }
  assert.equal((await inspectQuantResearchGuardHardening(db)).facts.state,'ORIGINAL');
  // Rolling back twice is a no-op.
  assert.deepEqual(await rollbackQuantResearchGuardHardening(db),{rolled_back:true,previous_state:'ORIGINAL'});assert.deepEqual(await defs(),original);
  assert.equal(await attacks.modeGuardShadow(),'ok');assert.equal(await attacks.modeChangeShadow(),'ok');
  assert.deepEqual(await matrix(await session()),baselineMatrix);
  assert.deepEqual(await tableDigest(),rowsBefore);
});

test('re-install after rollback reproduces the first install byte for byte',async()=>{
  await migrateQuantResearchGuardHardening(db);
  assert.deepEqual(await defs(),hardenedDefs);
  assert.equal(await attacks.modeGuardShadow(),MISMATCH);
});

test('with the QR-1b freeze installed: hardening holds, freeze stays intact, and either rollback leaves the other alone',async()=>{
  const freeze=await migrateQuantResearchFreeze(db,{runtimeRole:roleName});
  assert.equal(freeze.ok,true,freeze.failures.join());
  assert.deepEqual(await defs(),hardenedDefs,'installing the freeze did not touch the hardened guards');
  assert.equal(await attacks.modeGuardShadow(),MISMATCH);assert.equal(await attacks.modeChangeShadow(),DRAIN);
  assert.deepEqual(await matrix(await session()),baselineMatrix,'parity with the freeze present');
  assert.equal((await migrateQuantResearchGuardHardening(db)).facts.state,'HARDENED','re-apply with the freeze present');
  // Roll the hardening back while the freeze stays: original text, control attack works, the freeze still reports ok.
  await rollbackQuantResearchGuardHardening(db);
  assert.deepEqual(await defs(),original);
  assert.equal((await inspectQuantResearchFreeze(db,{runtimeRole:roleName})).ok,true);
  assert.equal(await attacks.modeGuardShadow(),'ok');
  await migrateQuantResearchGuardHardening(db);
  assert.deepEqual(await defs(),hardenedDefs);
  // Remove the freeze: the hardened guards stay.
  await rollbackQuantResearchFreeze(db);
  assert.deepEqual(await defs(),hardenedDefs);assert.equal((await inspectQuantResearchGuardHardening(db)).facts.state,'HARDENED');
  assert.equal(await attacks.modeChangeShadow(),DRAIN);
  assert.deepEqual(await tableDigest(),rowsBefore);
});

test('invariant: the hardened body with public. removed equals the original body, and the original has no public.',async()=>{
  const original=await fs.readFile(new URL('quant-research-foundation-schema.sql',sourceDir),'utf8');
  const hardened=await fs.readFile(new URL('quant-research-guard-hardening.sql',sourceDir),'utf8');
  const rollback=await fs.readFile(new URL('quant-research-guard-hardening-rollback.sql',sourceDir),'utf8');
  const norm=value=>value.replaceAll('\r\n','\n').trim();
  for(const name of FUNCTION_NAMES){
    const before=new RegExp('CREATE FUNCTION '+name+'\\(\\) RETURNS TRIGGER LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$;').exec(original)[1];
    const after=new RegExp('CREATE OR REPLACE FUNCTION public\\.'+name+'\\(\\) RETURNS TRIGGER\\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp\\s+AS \\$fn\\$([\\s\\S]*?)\\$fn\\$;').exec(hardened)[1];
    const restore=new RegExp('CREATE OR REPLACE FUNCTION public\\.'+name+'\\(\\) RETURNS TRIGGER LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$;').exec(rollback)[1];
    assert.equal(before.includes('public.'),false,name+' original has no public.');
    assert.equal(norm(after.replaceAll('public.','')),norm(before),name+': hardened minus public. equals original');
    assert.equal(norm(restore),norm(before),name+': rollback body equals original');
    assert.notEqual(norm(after),norm(before));
  }
});

test('a tampered definition is refused by install, rollback and inspect, and left unchanged',async()=>{
  await rollbackQuantResearchGuardHardening(db);
  const base=await defs();
  // One extra status in the original-style body: still SECURITY INVOKER, no settings, but not the trusted text.
  await db.query(`CREATE OR REPLACE FUNCTION public.quant_research_mode_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE selected TEXT;
BEGIN
 SELECT mode INTO selected FROM quant_research_executor_mode WHERE singleton FOR SHARE;
 IF NEW.status IN ('QUEUED','RUNNING','PAUSED') AND ((COALESCE(NEW.contract->>'execution_backend','')='quant-foundation-v1') IS DISTINCT FROM (selected='FOUNDATION')) THEN
  RAISE EXCEPTION 'Research executor mode mismatch';
 END IF;
 RETURN NEW;
END $$;`);
  const tampered=await defs();
  assert.notDeepEqual(tampered,base);
  const report=await inspectQuantResearchGuardHardening(db);
  assert.equal(report.ok,false);assert.equal(report.facts.state,'OTHER');assert.ok(report.failures.includes('FUNCTION_BODY:quant_research_mode_guard'));
  await assert.rejects(migrateQuantResearchGuardHardening(db),/install refused; unexpected state OTHER \(no change made\)/);
  await assert.rejects(rollbackQuantResearchGuardHardening(db),/rollback refused; unexpected state OTHER \(no change made\)/);
  assert.deepEqual(await defs(),tampered,'neither direction overwrote the tampered definition, including the untouched sibling');
  // Pinned settings on a non-trusted body are refused too.
  await db.query('ALTER FUNCTION public.quant_research_mode_guard() SET search_path = pg_catalog, pg_temp');
  await assert.rejects(migrateQuantResearchGuardHardening(db),/refused/);
  // The owner restores by running the trusted rollback text directly; then install works.
  await db.query(await fs.readFile(new URL('quant-research-guard-hardening-rollback.sql',sourceDir),'utf8'));
  assert.deepEqual(await defs(),original);
  assert.equal((await migrateQuantResearchGuardHardening(db)).previous_state,'ORIGINAL');
  assert.deepEqual(await defs(),hardenedDefs);
});

test('an extra or different function setting is refused (exactly one pinned search_path is the hardened state)',async()=>{
  const reset=()=>db.query('ALTER FUNCTION public.quant_research_mode_change() RESET ALL');
  const pin=()=>db.query('ALTER FUNCTION public.quant_research_mode_change() SET search_path = pg_catalog, pg_temp');
  const cases=[
    ['extra setting on the hardened body',async()=>{await pin();await db.query("ALTER FUNCTION public.quant_research_mode_change() SET work_mem = '1MB'");}],
    ['different search_path',async()=>{await db.query('ALTER FUNCTION public.quant_research_mode_change() SET search_path = public');}],
    ['longer search_path',async()=>{await db.query('ALTER FUNCTION public.quant_research_mode_change() SET search_path = pg_catalog, pg_temp, public');}]];
  for(const [label,setup] of cases){
    await reset();await setup();
    const snapshot=await defs(),meta=await functionMeta();
    const bad=await inspectQuantResearchGuardHardening(db);
    assert.equal(bad.ok,false,label);assert.equal(bad.facts.state,'OTHER',label);
    await assert.rejects(migrateQuantResearchGuardHardening(db),/refused/,label);
    await assert.rejects(rollbackQuantResearchGuardHardening(db),/refused/,label);
    assert.deepEqual(await defs(),snapshot,label);assert.deepEqual(await functionMeta(),meta,label+': settings untouched');
  }
  // SECURITY DEFINER on a trusted body is also refused.
  await reset();await pin();
  await db.query('ALTER FUNCTION public.quant_research_mode_change() SECURITY DEFINER');
  const definer=await inspectQuantResearchGuardHardening(db);
  assert.ok(definer.failures.includes('FUNCTION_SECURITY_DEFINER:quant_research_mode_change'));
  await assert.rejects(migrateQuantResearchGuardHardening(db),/refused/);
  await db.query('ALTER FUNCTION public.quant_research_mode_change() SECURITY INVOKER');
  assert.equal((await inspectQuantResearchGuardHardening(db)).facts.state,'HARDENED','back to the exact hardened state');
  assert.equal((await migrateQuantResearchGuardHardening(db)).previous_state,'HARDENED');
  assert.deepEqual(await defs(),hardenedDefs);
});

test('a mixed ORIGINAL/HARDENED pair converges; a missing trigger is refused',async()=>{
  // Mixed exact states converge: put one function back to its trusted original text.
  const rollback=await fs.readFile(new URL('quant-research-guard-hardening-rollback.sql',sourceDir),'utf8');
  await db.query(rollback.split('CREATE OR REPLACE FUNCTION public.quant_research_mode_change()')[0]);
  const mixed=await inspectQuantResearchGuardHardening(db);
  assert.equal(mixed.ok,true);assert.equal(mixed.facts.state,'MIXED');
  assert.equal((await migrateQuantResearchGuardHardening(db)).previous_state,'MIXED');
  assert.deepEqual(await defs(),hardenedDefs);
  await db.query('DROP TRIGGER quant_research_mode_change ON quant_research_executor_mode');
  await assert.rejects(migrateQuantResearchGuardHardening(db),/refused/);
  assert.ok((await inspectQuantResearchGuardHardening(db)).failures.includes('TRIGGER_MISSING:quant_research_mode_change'));
  await db.query('CREATE TRIGGER quant_research_mode_change BEFORE UPDATE ON quant_research_executor_mode FOR EACH ROW EXECUTE FUNCTION quant_research_mode_change()');
  assert.equal((await inspectQuantResearchGuardHardening(db)).ok,true);
  assert.deepEqual(await tableDigest(),rowsBefore);
});
