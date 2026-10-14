import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {ensureQuantIoSchema} from '../../src/postgres/quant-io-schema-install.js';
import {PINNED_SEARCH_PATH,RELEASE_GUARD,inspectQuantIoReleaseGuardHardening,migrateQuantIoReleaseGuardHardening,
  quantIoReleaseGuardBodies,rollbackQuantIoReleaseGuardHardening} from '../../src/postgres/quant-io-release-guard-hardening-migration.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

// GH2: the I/O foundation release guard must not read a session TEMP table in place of quant_io_launches or quant_io_ledgers
// (finding GH1-IO-RELEASE). Proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repo grants.
// Every row is a LABELLED FIXTURE. The hardening is never chained into migrateQuantFoundation: fresh installs stay ORIGINAL.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const BLOCKED='P0001:Foundation I/O launch unresolved';
const UNRESOLVED_LAUNCH=new Set(['INTENT_RECORDED','STARTING','SPAWNED','RELEASED']);
const UNRESOLVED_OPERATION=new Set(['RESERVED','ACTIVE','STOP_REQUIRED','CRASHED_UNCONFIRMED']);
let admin,db,databaseName,roleName,connectionString,runtimeUrl;
const databases=[],sessions=[];
// The child is its own test run: inheriting NODE_TEST_CONTEXT (set when this file runs in its own process) would make it
// report in the parent runner's binary format, with no text summary to parse.
const childEnv=()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;return env;};
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
async function session(){const client=new pg.Client({connectionString:runtimeUrl});await client.connect();sessions.push(client);return client;}
const read=name=>fs.readFile(new URL(name,sourceDir),'utf8');

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  databaseName='robot_iorg_test_'+suffix;roleName='robot_iorg_role_'+suffix.slice(0,16);
  await admin.query('CREATE DATABASE '+databaseName);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  connectionString=urlOf(databaseName);runtimeUrl=urlOf(databaseName,roleName);
  db=new PostgresDatabase({connectionString,max:6});await db.migrate();
  for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await db.query(await read(name));
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  // The repo grant script, with the throwaway role: broad DML, no ownership, TEMP left at the PUBLIC default.
  await db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',roleName));
});
after(async()=>{
  for(const client of sessions)await client.end().catch(()=>{});
  await db?.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  if(admin){await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS '+roleName);await admin.close();}
});

// ---- fixtures (owner connection, committed) -------------------------------------------------------------------------------------
const reset=()=>db.query('TRUNCATE public.quant_io_launches,public.quant_io_ledgers,public.quant_foundation_jobs CASCADE');
async function fixture({status='RUNNING',ops=null,launch=null}){
  await reset();
  const id=randomUUID(),token=randomUUID(),contract={version:'quant-foundation-v2',kind:'PROFILE'};
  await db.query("INSERT INTO public.quant_foundation_owners(owner_id) VALUES('gh2-fixture') ON CONFLICT DO NOTHING");
  await db.query(`INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at,
    lease_token,lease_until,stop_reason) VALUES($1,'gh2-fixture',$2,$3,$4,$5,1,900001,$6,$7,$8)`,
    [id,randomUUID(),JSON.stringify(contract),hash(canonical(contract)),status,token,status==='RUNNING'?900000:null,status==='STOPPING'?'CANCELLED':null]);
  if(ops!==null||launch!==null){
    const state={job_id:id,policy_hash:hash('gh2-policy'),lease_token:token,revision:0,operations:(ops||[]).map(item=>({status:item}))};
    await db.query('INSERT INTO public.quant_io_ledgers VALUES($1,$2,$3,0,$4,$5)',[id,state.policy_hash,token,JSON.stringify(state),hash(canonical(state))]);
  }
  if(launch!==null)await db.query('INSERT INTO public.quant_io_launches VALUES($1,$2,$3,$4,$5,$6,1)',
    [id,'gh2-operation',token,'gh2-'+id+'.service',hash('gh2-payload'),launch]);
  return {id,token};
}
const FIXTURES=[
  ['no ledger, no launch',{}],['empty ledger',{ops:[]}],
  ['launch INTENT_RECORDED',{launch:'INTENT_RECORDED'}],['launch STARTING',{launch:'STARTING'}],['launch SPAWNED',{launch:'SPAWNED'}],
  ['launch RELEASED',{launch:'RELEASED'}],['launch STOP_PROVEN',{launch:'STOP_PROVEN'}],
  ['ledger RESERVED',{ops:['RESERVED']}],['ledger ACTIVE',{ops:['ACTIVE']}],['ledger STOP_REQUIRED',{ops:['STOP_REQUIRED']}],
  ['ledger CRASHED_UNCONFIRMED',{ops:['CRASHED_UNCONFIRMED']}],['ledger SETTLED',{ops:['SETTLED']}],['ledger CRASHED',{ops:['CRASHED']}],
  ['ledger SETTLED then ACTIVE',{ops:['SETTLED','ACTIVE']}],['launch STOP_PROVEN, ledger ACTIVE',{launch:'STOP_PROVEN',ops:['ACTIVE']}],
  ['launch RELEASED, ledger SETTLED',{launch:'RELEASED',ops:['SETTLED']}]];
const UPDATE='UPDATE public.quant_foundation_jobs SET ';
const ACTIONS={
  RUNNING:{pause:UPDATE+"status='PAUSED',lease_token=NULL,lease_until=NULL WHERE job_id=$1",
    cancel:UPDATE+"status='CANCELLED',lease_token=NULL,lease_until=NULL WHERE job_id=$1",
    succeed:UPDATE+"status='SUCCEEDED',lease_token=NULL,lease_until=NULL WHERE job_id=$1",
    rotateLease:UPDATE+'lease_token=gen_random_uuid() WHERE job_id=$1',
    renew:UPDATE+'lease_until=lease_until+1000 WHERE job_id=$1',
    toStopping:UPDATE+"status='STOPPING',lease_until=NULL,stop_reason='CANCELLED' WHERE job_id=$1"},
  STOPPING:{cancel:UPDATE+"status='CANCELLED',lease_token=NULL,stop_reason=NULL WHERE job_id=$1",
    succeed:UPDATE+"status='SUCCEEDED',lease_token=NULL,stop_reason=NULL WHERE job_id=$1",
    rotateLease:UPDATE+'lease_token=gen_random_uuid() WHERE job_id=$1',
    keep:UPDATE+"diagnostic='gh2' WHERE job_id=$1"}};
const RELEASES=new Set(['pause','cancel','succeed','rotateLease']);
// Independent model of the documented guard: a leaving or token-changing job is blocked by an unresolved launch or operation.
const modelOf=(spec,action)=>RELEASES.has(action)&&((spec.launch&&UNRESOLVED_LAUNCH.has(spec.launch))||(spec.ops||[]).some(item=>UNRESOLVED_OPERATION.has(item)))?BLOCKED:'ok';

const TEMP_LAUNCHES='CREATE TEMP TABLE quant_io_launches(job_id uuid,state text)',TEMP_LEDGERS='CREATE TEMP TABLE quant_io_ledgers(job_id uuid,state jsonb)';
const SHADOWS={
  none:[],
  tempTables:[TEMP_LAUNCHES,TEMP_LEDGERS],
  tempTablesPathFirst:[TEMP_LAUNCHES,TEMP_LEDGERS,'SET LOCAL search_path = pg_temp, public'],
  tempViews:['CREATE TEMP VIEW quant_io_launches AS SELECT NULL::uuid job_id,NULL::text state WHERE false','CREATE TEMP VIEW quant_io_ledgers AS SELECT NULL::uuid job_id,NULL::jsonb state WHERE false'],
  launchesOnly:[TEMP_LAUNCHES],
  ledgersOnly:[TEMP_LEDGERS],
  functionShadow:['CREATE FUNCTION pg_temp.jsonb_array_elements(jsonb) RETURNS SETOF jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb WHERE false $$','SET LOCAL search_path = pg_temp, public']};

/** One statement under a shadow in a transaction that is always rolled back; resolves to 'ok' or 'SQLSTATE:message'. */
async function attempt(client,shadow,sql,params){
  await client.query('BEGIN');
  try{for(const statement of shadow)await client.query(statement);await client.query(sql,params);return 'ok';}
  catch(error){return error.code+':'+error.message;}
  finally{await client.query('ROLLBACK');}
}
/** Every fixture x job status x action as the runtime role. Fixtures are re-committed by the owner connection for each job state. */
async function matrix(shadowName){
  const client=await session(),out={};
  for(const [label,spec] of FIXTURES)for(const status of ['RUNNING','STOPPING']){
    const {id}=await fixture({...spec,status});
    for(const [action,sql] of Object.entries(ACTIONS[status]))out[label+'|'+status+'|'+action]=await attempt(client,SHADOWS[shadowName],sql,[id]);
  }
  return out;
}
const modelMatrix=()=>Object.fromEntries(FIXTURES.flatMap(([label,spec])=>['RUNNING','STOPPING'].flatMap(status=>
  Object.keys(ACTIONS[status]).map(action=>[label+'|'+status+'|'+action,modelOf(spec,action)]))));
const bypassed=(shadowed,plain)=>Object.keys(plain).filter(key=>plain[key]===BLOCKED&&shadowed[key]==='ok');

// ---- catalog helpers ----------------------------------------------------------------------------------------------------------------
const fnRow=async(connection=db)=>(await connection.query(`SELECT p.oid::text oid,p.prosrc,p.proconfig,p.prosecdef,pg_get_functiondef(p.oid) def,
  pg_get_userbyid(p.proowner) owner,p.proacl::text acl FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.quant_io_foundation_release_guard()')`)).rows[0];
const triggerRow=async(connection=db)=>(await connection.query("SELECT tgrelid::regclass::text relation,tgfoid::text fn,tgtype,tgenabled FROM pg_catalog.pg_trigger WHERE tgname='quant_io_foundation_release_guard'")).rows[0];
const othersDigest=async()=>(await db.query(`SELECT md5(string_agg(proname||pg_get_functiondef(oid),'|' ORDER BY proname)) d FROM pg_catalog.pg_proc
  WHERE pronamespace='public'::regnamespace AND proname<>$1 AND prokind='f'`,[RELEASE_GUARD])).rows[0].d;
const rowDigest=async()=>(await db.query(`SELECT md5(COALESCE((SELECT jsonb_agg(to_jsonb(j) ORDER BY job_id) FROM public.quant_foundation_jobs j),'[]')::text
  ||COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY job_id,operation_id) FROM public.quant_io_launches l),'[]')::text
  ||COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY job_id) FROM public.quant_io_ledgers g),'[]')::text) d`)).rows[0].d;
async function rollbackFixture(callback){
  const rollback=Error('fixture rollback');
  await assert.rejects(db.transaction(async()=>{await db.maintenanceLock();await callback();throw rollback;}),error=>error===rollback);
}
async function dropIo(){
  await db.query('DROP TABLE public.quant_profile_enrollment_receipts');
  await db.query('DROP TABLE public.quant_io_launches; DROP TABLE public.quant_io_ledgers CASCADE');
  for(const name of ['quant_io_ledger_guard','quant_io_launch_guard','quant_io_foundation_release_guard'])await db.query('DROP FUNCTION public.'+name+'() CASCADE');
}

let original,hardened,baseline,controls={},othersBefore,digestBefore;

test('setup: runtime role is a non-owner with TEMP privilege and the original release guard is installed (not chained into the foundation migration)',async()=>{
  const role=(await db.query("SELECT rolsuper,rolbypassrls,has_database_privilege(rolname,current_database(),'TEMP') temp FROM pg_roles WHERE rolname=$1",[roleName])).rows[0];
  assert.deepEqual([role.rolsuper,role.rolbypassrls,role.temp],[false,false,true]);
  original=await fnRow();
  assert.equal(original.prosecdef,false);assert.equal(original.proconfig,null);assert.notEqual(original.owner,roleName);
  const bodies=await quantIoReleaseGuardBodies();
  assert.equal(original.prosrc,bodies.original,'stored text equals the applied schema file text exactly');
  const report=await inspectQuantIoReleaseGuardHardening(db);
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.facts.state,'ORIGINAL');
  assert.deepEqual(await triggerRow(),{relation:'quant_foundation_jobs',fn:original.oid,tgtype:19,tgenabled:'O'});
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.deepEqual(await fnRow(),original,'migrateQuantFoundation never hardens');
});

test('baseline: the original guard matches the documented release rules for every fixture and action',async()=>{
  baseline=await matrix('none');
  assert.deepEqual(baseline,modelMatrix());
  assert.ok(Object.values(baseline).includes(BLOCKED)&&Object.values(baseline).includes('ok'));
  assert.equal(Object.keys(baseline).length,FIXTURES.length*(Object.keys(ACTIONS.RUNNING).length+Object.keys(ACTIONS.STOPPING).length));
});

test('control: before hardening, a TEMP shadow releases a job with unresolved launch or operation',async()=>{
  for(const name of ['tempTables','tempTablesPathFirst','tempViews'])controls[name]=await matrix(name);
  for(const name of Object.keys(controls)){
    const flipped=bypassed(controls[name],baseline);
    assert.ok(flipped.length>=40,name+': '+flipped.length+' blocked outcomes became ok');
    assert.ok(Object.keys(controls[name]).every(key=>controls[name][key]==='ok'),name+': both tables hidden, every statement passes');
  }
  // One shadowed table hides only what that table holds.
  const launches=bypassed(await matrix('launchesOnly'),baseline);
  assert.ok(launches.includes('launch SPAWNED|RUNNING|pause'));assert.ok(!launches.includes('ledger ACTIVE|RUNNING|pause'));
  // A pg_temp function is not looked up by unqualified call, so it cannot shadow jsonb_array_elements.
  assert.deepEqual(await matrix('functionShadow'),baseline);
  await reset();
});

test('the hardening migration is offline only: maintenance lock, own transaction, I/O extension required',async()=>{
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateQuantIoReleaseGuardHardening(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackQuantIoReleaseGuardHardening(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateQuantIoReleaseGuardHardening(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackQuantIoReleaseGuardHardening(db)),/own transaction/);
  assert.deepEqual(await fnRow(),original,'refused attempts changed nothing');
  const bare='robot_iorg_bare_'+randomUUID().replaceAll('-','');databases.push(bare);
  await admin.query('CREATE DATABASE '+bare);
  const bareDb=new PostgresDatabase({connectionString:urlOf(bare)});
  try{
    await bareDb.migrate();
    await assert.rejects(migrateQuantIoReleaseGuardHardening(bareDb),/Quant I\/O extension required/);
    await assert.rejects(rollbackQuantIoReleaseGuardHardening(bareDb),/Quant I\/O extension required/);
    assert.equal((await bareDb.query('SELECT count(*)::int n FROM pg_proc WHERE proname=$1',[RELEASE_GUARD])).rows[0].n,0);
  }finally{await bareDb.close();}
});

test('install with unresolved I/O work live: only the one function changes; OID, owner, grants, trigger and rows are untouched',async()=>{
  await fixture({status:'RUNNING',ops:['ACTIVE'],launch:'SPAWNED'});
  othersBefore=await othersDigest();digestBefore=await rowDigest();
  const triggerBefore=await triggerRow();
  const report=await migrateQuantIoReleaseGuardHardening(db);
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.facts.state,'HARDENED');assert.equal(report.previous_state,'ORIGINAL');
  hardened=await fnRow();
  assert.equal(hardened.oid,original.oid,'CREATE OR REPLACE keeps the OID');
  assert.equal(hardened.owner,original.owner);assert.equal(hardened.acl,original.acl);
  assert.equal(hardened.prosecdef,false);assert.deepEqual(hardened.proconfig,[PINNED_SEARCH_PATH]);
  assert.match(hardened.def,/SET search_path TO 'pg_catalog', 'pg_temp'/);assert.doesNotMatch(hardened.def,/SECURITY DEFINER/);
  assert.match(hardened.def,/FROM public\.quant_io_launches/);assert.match(hardened.def,/FROM public\.quant_io_ledgers l,/);
  assert.notEqual(hardened.prosrc,original.prosrc);
  assert.deepEqual(await triggerRow(),triggerBefore,'the same trigger still calls the same function');
  assert.equal(await othersDigest(),othersBefore,'no other function changed');
  assert.equal(await rowDigest(),digestBefore,'no row changed');
  assert.equal((await db.query("SELECT has_function_privilege($1::name,to_regprocedure('public.quant_io_foundation_release_guard()')::oid,'EXECUTE') ok",[roleName])).rows[0].ok,
    true,'the PUBLIC EXECUTE default is unchanged');
});

test('invariant: the hardened body with public. removed equals the original body; the rollback body equals the original text',async()=>{
  const bodies=await quantIoReleaseGuardBodies(),norm=value=>value.replaceAll('\r\n','\n').trim();
  assert.equal(bodies.original.includes('public.'),false);
  assert.equal(norm(bodies.hardened.replaceAll('public.','')),norm(bodies.original));
  assert.equal((bodies.hardened.match(/public\./g)||[]).length,2,'exactly the two relation qualifiers');
  const restore=/CREATE OR REPLACE FUNCTION public\.quant_io_foundation_release_guard\(\) RETURNS TRIGGER LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$;/.exec(await read('quant-io-release-guard-hardening-rollback.sql'))[1];
  assert.equal(norm(restore),norm(bodies.original));
  assert.match(await read('quant-io-release-guard-hardening.sql'),/RAISE EXCEPTION 'Foundation I\/O launch unresolved'/);
});

test('after hardening every TEMP shadow is refused and every outcome equals the baseline',async()=>{
  assert.deepEqual(await matrix('none'),baseline,'normal behavior is identical before and after hardening');
  for(const name of ['tempTables','tempTablesPathFirst','tempViews','launchesOnly','ledgersOnly','functionShadow']){
    const shadowed=await matrix(name);
    assert.deepEqual(shadowed,baseline,name+': shadow cannot change any outcome');
    assert.deepEqual(bypassed(shadowed,baseline),[],name);
  }
  assert.notDeepEqual(controls.tempTables,baseline,'the control outcome differed');
  await reset();
});

test('re-applying is a no-op: the same definition, trigger, metadata and rows',async()=>{
  await fixture({status:'RUNNING',ops:['ACTIVE'],launch:'SPAWNED'});const digest=await rowDigest();
  const again=await migrateQuantIoReleaseGuardHardening(db);
  assert.equal(again.ok,true);assert.equal(again.facts.state,'HARDENED');assert.equal(again.previous_state,'HARDENED');
  assert.deepEqual(await fnRow(),hardened);assert.equal(await rowDigest(),digest);assert.equal(await othersDigest(),othersBefore);
});

test('the installer accepts the exact ORIGINAL and the exact HARDENED definition and never hardens or repairs',async()=>{
  await reset();
  await db.transaction(()=>ensureQuantIoSchema(db));
  assert.deepEqual(await fnRow(),hardened,'hardened accepted unchanged, OID kept');
  assert.equal(await migrateQuantFoundation(db),'LEGACY');assert.deepEqual(await fnRow(),hardened);
  await rollbackQuantIoReleaseGuardHardening(db);
  await db.transaction(()=>ensureQuantIoSchema(db));assert.deepEqual(await fnRow(),original,'original accepted unchanged');
  assert.equal(await migrateQuantFoundation(db),'LEGACY');assert.deepEqual(await fnRow(),original);
  // Fresh install installs ORIGINAL: the installer never executes the hardening file.
  await rollbackFixture(async()=>{
    await dropIo();
    await ensureQuantIoSchema(db);
    const fresh=await fnRow(db);
    assert.equal(fresh.proconfig,null);assert.equal(fresh.prosrc,original.prosrc);
  });
  assert.deepEqual(await fnRow(),original);
  await migrateQuantIoReleaseGuardHardening(db);assert.deepEqual(await fnRow(),hardened);
});

test('the installer refuses every other definition of the release guard and of its siblings, without repair',async()=>{
  await reset();
  const hardeningSql=await read('quant-io-release-guard-hardening.sql'),rollbackSql=await read('quant-io-release-guard-hardening-rollback.sql');
  const fn='public.quant_io_foundation_release_guard()';
  const variants=[
    ['hardened body without the pin',hardeningSql.replace('SECURITY INVOKER SET search_path = pg_catalog, pg_temp','SECURITY INVOKER')],
    ['hardened body with one changed character',hardeningSql.replace("'ACTIVE'","'ACTIVF'")],
    ['hardened body with an unqualified launches relation',hardeningSql.replace('FROM public.quant_io_launches','FROM quant_io_launches')],
    ['original body with the pin',rollbackSql+'ALTER FUNCTION '+fn+' SET search_path = pg_catalog, pg_temp'],
    ['hardened with an extra setting','ALTER FUNCTION '+fn+" SET work_mem = '1MB'"],
    ['hardened with a different search_path','ALTER FUNCTION '+fn+' SET search_path = public, pg_temp'],
    ['hardened with a longer search_path','ALTER FUNCTION '+fn+' SET search_path = pg_catalog, pg_temp, public'],
    ['hardened with SECURITY DEFINER','ALTER FUNCTION '+fn+' SECURITY DEFINER'],
    ['hardened with trigger disabled','ALTER TABLE public.quant_foundation_jobs DISABLE TRIGGER quant_io_foundation_release_guard'],
    ['hardened with trigger rebound to another function','DROP TRIGGER quant_io_foundation_release_guard ON public.quant_foundation_jobs; CREATE TRIGGER quant_io_foundation_release_guard BEFORE UPDATE ON public.quant_foundation_jobs FOR EACH ROW EXECUTE FUNCTION public.quant_io_ledger_guard()'],
    ['hardened with a narrower trigger event','DROP TRIGGER quant_io_foundation_release_guard ON public.quant_foundation_jobs; CREATE TRIGGER quant_io_foundation_release_guard BEFORE UPDATE OF status ON public.quant_foundation_jobs FOR EACH ROW EXECUTE FUNCTION public.quant_io_foundation_release_guard()'],
    ['pinned ledger guard (siblings keep the single-state rule)','ALTER FUNCTION public.quant_io_ledger_guard() SET search_path = pg_catalog, pg_temp'],
    ['pinned launch guard (siblings keep the single-state rule)','ALTER FUNCTION public.quant_io_launch_guard() SET search_path = pg_catalog, pg_temp']];
  for(const [label,statement] of variants)await rollbackFixture(async()=>{
    await db.query(statement);
    const changed=await fnRow(db),siblings=await othersDigest();
    await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_SCHEMA_UNSUPPORTED'},label);
    assert.deepEqual(await fnRow(db),changed,label+': no repair');assert.equal(await othersDigest(),siblings,label+': no repair of siblings');
  });
  // The same variants against the ORIGINAL start (a different baseline) for the pins that matter.
  await rollbackQuantIoReleaseGuardHardening(db);
  for(const [label,statement] of [['original with the pin','ALTER FUNCTION '+fn+' SET search_path = pg_catalog, pg_temp'],['original with SECURITY DEFINER','ALTER FUNCTION '+fn+' SECURITY DEFINER'],
    ['original with a setting','ALTER FUNCTION '+fn+" SET work_mem = '1MB'"]])await rollbackFixture(async()=>{
    await db.query(statement);
    await assert.rejects(ensureQuantIoSchema(db),{code:'QUANT_IO_SCHEMA_UNSUPPORTED'},label);
  });
  assert.deepEqual(await fnRow(),original);
  await migrateQuantIoReleaseGuardHardening(db);assert.deepEqual(await fnRow(),hardened);
});

test('the installer refuses with QUANT_IO_SCHEMA_UNSUPPORTED, not a raw file error, when the hardening file is missing or unreadable (GH2-ENOENT)',async()=>{
  await reset();
  const digest=await othersDigest(),before=await fnRow();
  const real=fs.readFile,target='quant-io-release-guard-hardening.sql';
  for(const code of ['ENOENT','EACCES']){
    // The installer calls fs.readFile on the shared module object, so a temporary stub reproduces the file failure without touching the file.
    fs.readFile=async(file,...rest)=>{
      if(String(file).endsWith(target))throw Object.assign(Error(code+': simulated '+target),{code});
      return real.call(fs,file,...rest);
    };
    try{
      await rollbackFixture(async()=>{
        await assert.rejects(ensureQuantIoSchema(db),error=>error.code==='QUANT_IO_SCHEMA_UNSUPPORTED',code);
      });
    }finally{fs.readFile=real;}
  }
  assert.equal(fs.readFile,real,'stub removed');
  assert.deepEqual(await fnRow(),before,'no repair');assert.equal(await othersDigest(),digest,'no repair of siblings');
  await db.transaction(()=>ensureQuantIoSchema(db));
});

test('install and rollback classify first: a tampered, over-configured or missing definition is refused and left unchanged',async()=>{
  await fixture({status:'RUNNING',ops:['ACTIVE'],launch:'SPAWNED'});const digest=await rowDigest();
  const rollbackSql=await read('quant-io-release-guard-hardening-rollback.sql'),hardeningSql=await read('quant-io-release-guard-hardening.sql');
  const fn='public.quant_io_foundation_release_guard()';
  const tampers=[
    ['changed status set (no settings)',rollbackSql.replace("'CRASHED_UNCONFIRMED'","'CRASHED_UNCONFIRMEX'")],
    ['changed status set (hardened header)',hardeningSql.replace("'RESERVED'","'RESERVEX'")],
    ['extra setting on the hardened body','ALTER FUNCTION '+fn+" SET work_mem = '1MB'"],
    ['original body with the pin',rollbackSql+'ALTER FUNCTION '+fn+' SET search_path = pg_catalog, pg_temp'],
    ['SECURITY DEFINER on the hardened body','ALTER FUNCTION '+fn+' SECURITY DEFINER'],
    ['trigger disabled','ALTER TABLE public.quant_foundation_jobs DISABLE TRIGGER quant_io_foundation_release_guard']];
  for(const [label,statement] of tampers){
    await db.query(hardeningSql);await db.query(statement);   // start every case from exact HARDENED, then tamper
    const changed=await fnRow(),trigger=await triggerRow();
    const report=await inspectQuantIoReleaseGuardHardening(db);
    assert.equal(report.ok,false,label);
    await assert.rejects(migrateQuantIoReleaseGuardHardening(db),/install refused; unexpected state|install refused/,label);
    await assert.rejects(rollbackQuantIoReleaseGuardHardening(db),/rollback refused; unexpected state|rollback refused/,label);
    assert.deepEqual(await fnRow(),changed,label+': definition untouched');assert.deepEqual(await triggerRow(),trigger,label+': trigger untouched');
    assert.equal(await rowDigest(),digest,label+': rows untouched');
    // The owner restores the exact trusted text by running the trusted files directly.
    await db.query('ALTER TABLE public.quant_foundation_jobs ENABLE TRIGGER quant_io_foundation_release_guard');
    await db.query(rollbackSql);
    assert.deepEqual(await fnRow(),original,label+': trusted restore');
  }
  // A missing function is refused and not recreated.
  await db.query('DROP FUNCTION public.quant_io_foundation_release_guard() CASCADE');
  const missing=await inspectQuantIoReleaseGuardHardening(db);
  assert.equal(missing.facts.state,'MISSING');
  await assert.rejects(migrateQuantIoReleaseGuardHardening(db),/install refused; unexpected state MISSING/);
  await assert.rejects(rollbackQuantIoReleaseGuardHardening(db),/rollback refused; unexpected state MISSING/);
  assert.equal((await db.query('SELECT count(*)::int n FROM pg_proc WHERE proname=$1',[RELEASE_GUARD])).rows[0].n,0);
  await db.query(rollbackSql);
  await db.query('CREATE TRIGGER quant_io_foundation_release_guard BEFORE UPDATE ON public.quant_foundation_jobs FOR EACH ROW EXECUTE FUNCTION public.quant_io_foundation_release_guard()');
  const restored=await fnRow();original=restored;   // new OID after the drop; later comparisons use this exact original
  assert.equal(restored.prosrc,(await quantIoReleaseGuardBodies()).original);
  assert.equal((await inspectQuantIoReleaseGuardHardening(db)).facts.state,'ORIGINAL');
  assert.equal(await rowDigest(),digest);
  await reset();
});

test('rollback restores the exact original, is idempotent, reopens the control bypass, and re-install reproduces the hardened text',async()=>{
  await migrateQuantIoReleaseGuardHardening(db);hardened=await fnRow();
  await fixture({status:'RUNNING',ops:['ACTIVE'],launch:'SPAWNED'});const digest=await rowDigest();
  assert.deepEqual(await rollbackQuantIoReleaseGuardHardening(db),{rolled_back:true,previous_state:'HARDENED'});
  const restored=await fnRow();
  assert.equal(restored.def,original.def,'pg_get_functiondef equals the pre-hardening text');
  assert.equal(restored.prosrc,(await quantIoReleaseGuardBodies()).original,'stored text equals the schema file text exactly');
  assert.equal(restored.proconfig,null);assert.equal(restored.oid,hardened.oid,'OID kept');assert.equal(restored.owner,hardened.owner);assert.equal(restored.acl,hardened.acl);
  assert.deepEqual(await rollbackQuantIoReleaseGuardHardening(db),{rolled_back:true,previous_state:'ORIGINAL'});
  assert.deepEqual(await fnRow(),restored);
  assert.equal(await rowDigest(),digest);
  const flipped=bypassed(await matrix('tempTables'),baseline);assert.ok(flipped.length>=40,'the bypass works again after rollback');
  await fixture({status:'RUNNING',ops:['ACTIVE'],launch:'SPAWNED'});
  await migrateQuantIoReleaseGuardHardening(db);
  assert.deepEqual(await fnRow(),hardened,'re-install reproduces the first install byte for byte');
  assert.deepEqual(await matrix('tempTables'),baseline);
  // Rollback, then the foundation migration still passes on the restored original, then harden again.
  await rollbackQuantIoReleaseGuardHardening(db);await reset();
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  await migrateQuantIoReleaseGuardHardening(db);assert.deepEqual(await fnRow(),hardened);
  assert.equal(await migrateQuantFoundation(db),'LEGACY');assert.deepEqual(await fnRow(),hardened);
  await rollbackQuantIoReleaseGuardHardening(db);
});

test('the CLI installs, converges, rolls back and refuses bad arguments on the throwaway database',async()=>{
  const script='scripts/migrate-quant-io-release-guard-hardening.mjs',env={...process.env,DATABASE_URL:connectionString};
  const cli=async(...args)=>(await run(process.execPath,[script,...args],{cwd:repoRoot,env})).stdout;
  assert.match(await cli(),/state=HARDENED; previous state=ORIGINAL/);
  assert.match(await cli(),/state=HARDENED; previous state=HARDENED/);
  assert.equal((await fnRow()).proconfig[0],PINNED_SEARCH_PATH);
  assert.match(await cli('--rollback'),/original function definition restored; previous state=HARDENED/);
  assert.match(await cli('--rollback'),/previous state=ORIGINAL/);
  assert.equal((await fnRow()).proconfig,null);
  await assert.rejects(run(process.execPath,[script,'--other'],{cwd:repoRoot,env}),/Usage/);
  await assert.rejects(run(process.execPath,[script,'--rollback','--rollback'],{cwd:repoRoot,env}),/Usage/);
});

// ---- the existing I/O suites, unchanged, against a hardened database ------------------------------------------------------------------
// Each suite builds its own database and applies the schema files directly. A preload patches PostgresDatabase.query so that, right after
// the statement that creates the release guard, the hardening file runs (inside the same transaction when there is one). No suite file
// is edited; the suite then runs against exactly the hardened definition, which the installer verifier must also accept.
const hardenedRun=async file=>{
  const preload=`import fs from 'node:fs';
import {PostgresDatabase} from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../../src/postgres/db.js',import.meta.url))).href)};
const hardening=fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('quant-io-release-guard-hardening.sql',sourceDir)))},'utf8');
let applied=0;const original=PostgresDatabase.prototype.query;
PostgresDatabase.prototype.query=async function(sql,params){
  const result=await original.call(this,sql,params);
  if(typeof sql==='string'&&sql.includes('CREATE FUNCTION quant_io_foundation_release_guard()')){await original.call(this,hardening);applied++;}
  return result;
};
process.on('exit',()=>process.stderr.write('GH2_HARDENING_APPLIED='+applied+'\\n'));`;
  let result;
  try{
    result=await run(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'--test','--test-isolation=none','--test-reporter=spec',file],
      {cwd:repoRoot,env:childEnv(),maxBuffer:64*1024*1024});
  }catch(error){result={stdout:error.stdout||'',stderr:error.stderr||'',failed:true};}
  const text=result.stdout+result.stderr,count=name=>Number((new RegExp('ℹ '+name+' (\\d+)').exec(text)||[])[1]);
  return {failed:!!result.failed,pass:count('pass'),fail:count('fail'),skipped:count('skipped'),applied:Number((/GH2_HARDENING_APPLIED=(\d+)/.exec(text)||[])[1]),text};
};
for(const file of ['test/postgres/quant-io-runtime.test.mjs','test/postgres/quant-foundation-recovery.test.mjs',
  'test/postgres/quant-profile-runtime-v2.test.mjs','test/postgres/quant-foundation-migration.test.mjs','test/postgres/quant-profile-enrollment.test.mjs'])
  test('existing suite against a hardened release guard: '+file,{timeout:900000},async()=>{
    const outcome=await hardenedRun(file);
    assert.ok(outcome.applied>=1,'the hardening was applied in the suite process ('+outcome.applied+')');
    assert.equal(outcome.fail,0,outcome.text.slice(-3000));assert.equal(outcome.failed,false);assert.ok(outcome.pass>0);
    process.stderr.write('hardened '+file+': pass='+outcome.pass+' fail='+outcome.fail+' skipped='+outcome.skipped+' hardeningApplied='+outcome.applied+'\n');
  });
