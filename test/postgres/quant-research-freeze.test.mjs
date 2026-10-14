import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {TERMINAL} from '../../src/postgres/quant-research.js';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {FREEZE_GUARDS,FREEZE_MARKER,FREEZE_SQLSTATE,classifyQuantResearchFreeze,inspectQuantResearchFreeze,migrateQuantResearchFreeze,rollbackQuantResearchFreeze} from '../../src/postgres/quant-research-freeze-migration.js';
import {runOf,seedRun,seedFoundation,hex,T0} from '../helpers/quant-library-fixture.mjs';

// QR-1b terminal-result freeze, proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repo grants.
// Every row is a LABELLED FIXTURE (synthetic, never a research result).
const STATUSES=['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT'];
const QR=FREEZE_SQLSTATE;
let admin,db,rt,databaseName,roleName,connectionString,runtimeUrl,store;
const databases=[];
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const install=async name=>db.transaction(async()=>db.query(await fs.readFile(new URL(name,sourceDir),'utf8')));
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const refused=(promise,code=QR)=>assert.rejects(promise,{code});

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  databaseName='robot_freeze_test_'+suffix;roleName='robot_freeze_role_'+suffix.slice(0,16);
  await admin.query('CREATE DATABASE '+databaseName);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  connectionString=urlOf(databaseName);runtimeUrl=urlOf(databaseName,roleName);
  db=new PostgresDatabase({connectionString,max:6});await db.migrate();
  for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'])await install(name);
  // The repo grant script, with the throwaway role: broad SELECT/INSERT/UPDATE/DELETE, no TRUNCATE, no TRIGGER, no ownership.
  await db.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',roleName));
  rt=new PostgresDatabase({connectionString:runtimeUrl,max:6});
  store=new Store(db);
});
after(async()=>{
  await rt?.close().catch(()=>{});await db?.close().catch(()=>{});await shared?.close().catch(()=>{});
  for(const name of databases)await admin?.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
  if(admin){await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.query('DROP ROLE IF EXISTS '+roleName);await admin.close();}
});

async function newOwner(label,target=db,targetStore=store){
  const user=await targetStore.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:'freeze-fixture'};
  await target.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hex(importId),'Freeze fixture','//@version=6\nindicator("x")','{}',T0]);
  await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hex(JSON.stringify(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
const make=(owner,options)=>runOf({owner:owner.id,deployment:owner.deployment,importId:owner.importId,...options});
const rowOf=async id=>(await db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[id])).rows[0];

/** Whole-table digests (rows serialised by PostgreSQL, ordered by key) so "nothing changed" is a byte comparison. */
const DIGESTS={jobs:"SELECT encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY t.run_id),''),'UTF8')),'hex') d FROM quant_jobs t",
  steps:"SELECT encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY t.run_id,t.step_id),''),'UTF8')),'hex') d FROM quant_job_steps t",
  chunks:"SELECT encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY t.run_id,t.step_id),''),'UTF8')),'hex') d FROM quant_research_chunks t",
  bindings:"SELECT encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY t.run_id),''),'UTF8')),'hex') d FROM quant_research_foundation t"};
async function digests(target=db){
  const out={};for(const [name,sql] of Object.entries(DIGESTS))out[name]=(await target.query(sql)).rows[0].d;return out;
}
const acls=async(target=db)=>(await target.query(`SELECT encode(sha256(convert_to(COALESCE(string_agg(c.relname||':'||COALESCE(c.relacl::text,''),'|' ORDER BY c.relname),''),'UTF8')),'hex') d,
  count(*)::int n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','S')`)).rows[0];
const guardRows=async(target=db)=>(await target.query(`SELECT c.relname,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  WHERE NOT t.tgisinternal AND t.tgname LIKE ANY(ARRAY['quant\\_job\\_terminal%','quant\\_job\\_step\\_terminal%','quant\\_research\\_%\\_terminal\\_%']) ORDER BY t.tgname`)).rows;
const functionDigests=async(target=db)=>(await target.query(`SELECT p.proname,md5(p.prosrc||COALESCE(p.proconfig::text,'')) d,p.prosecdef FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'quant\\_research\\_%freeze%' OR p.proname='quant_research_status_is_terminal') ORDER BY p.proname`)).rows;

/** The way the workers write a run: QUEUED, then RUNNING under a lease, then checkpoints, then one terminal UPDATE (as the runtime role). */
async function lifecycle(run,owner,{finalStatus=run.status}={}){
  const contract=JSON.stringify(run.contract);
  await rt.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,phase)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$8,$9,'CANDIDATES')`,[run.run_id,owner.id,owner.deployment,'idem-'+run.run_id,hex('submission'),run.contract_hash,contract,run.created_at,run.created_at+900000]);
  await rt.query("UPDATE quant_jobs SET status='RUNNING',attempt=1,lease_token=$2,lease_until=$3,updated_at=$4 WHERE run_id=$1 AND status='QUEUED'",[run.run_id,'lease-'+run.run_id,run.created_at+900000,run.created_at+1]);
  await rt.query("UPDATE quant_jobs SET updated_at=$2 WHERE run_id=$1 AND status='RUNNING'",[run.run_id,run.created_at+2]);
  for(const step of run.steps)await rt.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
    [run.run_id,step.step_id,step.kind,JSON.stringify(step.parameters),JSON.stringify(step.result),step.completed_at]);
  if(finalStatus==='RUNNING')return;
  await rt.query("UPDATE quant_jobs SET status=$2,phase='COMPLETE',result=$3,diagnostic=$4,lease_token=NULL,lease_until=0,updated_at=$5 WHERE run_id=$1 AND status='RUNNING'",
    [run.run_id,finalStatus,run.result?JSON.stringify(run.result):null,run.diagnostic,run.updated_at]);
}

let A,preRuns,baseline,baselineAcl,baselineFunctions;
const specs=()=>({SUCCEEDED:{scenario:'PENDING',at:T0+1e6},NO_VALID_CANDIDATE:{scenario:'NO_VALID',at:T0+2e6},FAILED:{status:'FAILED',diagnostic:'QUANT_ENGINE_CHANGED',partial:2,at:T0+3e6},
  CANCELLED:{status:'CANCELLED',partial:1,at:T0+4e6},TIMED_OUT:{status:'TIMED_OUT',diagnostic:'JOB_DEADLINE_EXCEEDED',partial:3,at:T0+5e6}});

test('the terminal set of the database function equals the application TERMINAL set',async()=>{
  // Installed only for this read and rolled back at the end: the next test writes its rows before the freeze exists.
  await install('quant-research-freeze.sql');
  const all=['QUEUED','RUNNING',...STATUSES];
  for(const status of all)assert.equal((await db.query('SELECT public.quant_research_status_is_terminal($1) v',[status])).rows[0].v,TERMINAL.has(status),status);
  assert.deepEqual([...TERMINAL].sort(),[...STATUSES].sort());
  assert.equal((await db.query('SELECT public.quant_research_status_is_terminal(NULL) v')).rows[0].v,false);
  await rollbackQuantResearchFreeze(db);
});

test('pre-freeze rows are written "as found": the freeze neither reads nor changes them, and adds no table and no grant',async()=>{
  A=await newOwner('freeze-a');
  preRuns={};
  for(const [status,options] of Object.entries(specs())){preRuns[status]=make(A,options);await seedRun(db,preRuns[status],{owner:A.id,deployment:A.deployment});}
  preRuns.zeroStep=make(A,{status:'FAILED',diagnostic:'OWNER_UNAVAILABLE',at:T0+6e6});await seedRun(db,preRuns.zeroStep,{owner:A.id,deployment:A.deployment});
  baseline=await digests();baselineAcl=await acls();
  const before=await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1");
  const report=await migrateQuantResearchFreeze(db,{runtimeRole:roleName});
  assert.equal(report.ok,true,report.failures.join());assert.equal(report.facts.marker,FREEZE_MARKER);
  assert.deepEqual(await digests(),baseline,'no stored row changed');
  assert.deepEqual(await acls(),baselineAcl,'no grant changed');
  assert.deepEqual((await db.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")).rows,before.rows,'no table was added');
  baselineFunctions=await functionDigests();
  // Idempotent: a second run converges on the same catalog state.
  const guards=await guardRows();
  assert.equal((await migrateQuantResearchFreeze(db,{runtimeRole:roleName})).ok,true);
  assert.deepEqual(await guardRows(),guards);assert.deepEqual(await functionDigests(),baselineFunctions);assert.deepEqual(await digests(),baseline);
});

test('the migration is offline only: it needs the maintenance lock, its own transaction and the version-1 extension',async()=>{
  const holder=new PostgresDatabase({connectionString});
  try{
    await holder.runtimeLock();
    await assert.rejects(migrateQuantResearchFreeze(db),/Stop every PostgreSQL API and worker/);
    await assert.rejects(rollbackQuantResearchFreeze(db),/Stop every PostgreSQL API and worker/);
  }finally{await holder.close();}
  await assert.rejects(db.transaction(()=>migrateQuantResearchFreeze(db)),/own transaction/);
  await assert.rejects(db.transaction(()=>rollbackQuantResearchFreeze(db)),/own transaction/);
  assert.equal((await inspectQuantResearchFreeze(db)).ok,true,'refused attempts changed nothing');
});

test('catalog: ENABLE ALWAYS guards, invoker functions with a pinned search_path, and a runtime role that cannot bypass them',async()=>{
  const report=await inspectQuantResearchFreeze(db,{runtimeRole:roleName});
  assert.equal(report.ok,true,report.failures.join());
  assert.deepEqual((await guardRows()).map(row=>row.tgname).sort(),FREEZE_GUARDS.map(item=>item[1]).sort());
  assert.ok((await guardRows()).every(row=>row.tgenabled==='A'),'tgenabled is A for every guard');
  for(const fn of await functionDigests())assert.equal(fn.prosecdef,false,fn.proname);
  const functions=(await db.query(`SELECT proname,proconfig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'quant\\_research\\_%freeze%'`)).rows;
  assert.ok(functions.length>=5);for(const fn of functions)assert.ok(fn.proconfig.includes('search_path=pg_catalog, pg_temp'),fn.proname);
  assert.equal((await db.query('SELECT public.quant_research_freeze_version() v')).rows[0].v,FREEZE_MARKER);
  const role=(await db.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=$1',[roleName])).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false,rolreplication:false});
  for(const table of ['quant_jobs','quant_job_steps','quant_research_foundation','quant_research_chunks']){
    const facts=(await db.query(`SELECT pg_get_userbyid(relowner)=$2 AS owner,has_table_privilege($2,oid,'TRIGGER') AS trigger,has_table_privilege($2,oid,'TRUNCATE') AS truncate,
      has_table_privilege($2,oid,'UPDATE') AS update,has_table_privilege($2,oid,'DELETE') AS delete FROM pg_class WHERE oid=$1::regclass`,['public.'+table,roleName])).rows[0];
    assert.deepEqual(facts,{owner:false,trigger:false,truncate:false,update:true,delete:true},table);
  }
  // The foreign keys that reference quant_jobs never cascade a delete.
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND confrelid='public.quant_jobs'::regclass AND confdeltype NOT IN ('a','r')")).rows[0].n,0);
  const version=Number((await db.query("SELECT current_setting('server_version_num') v")).rows[0].v);
  if(version>=150000)assert.equal((await db.query("SELECT has_parameter_privilege($1,'session_replication_role','SET') v",[roleName])).rows[0].v,false);
  // The role itself cannot disable a guard, change the replication role or take ownership.
  await refused(rt.query('ALTER TABLE quant_jobs DISABLE TRIGGER quant_job_terminal_freeze'),'42501');
  await refused(rt.query('ALTER TABLE quant_jobs DISABLE TRIGGER ALL'),'42501');
  await refused(rt.query("SET session_replication_role = 'replica'"),'42501');
  await refused(rt.query('DROP TRIGGER quant_job_terminal_freeze ON quant_jobs'),'42501');
  await refused(rt.query('CREATE OR REPLACE FUNCTION public.quant_research_freeze_job_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'),'42501');
  await refused(rt.query('TRUNCATE public.quant_jobs'),'42501');
  await refused(rt.query('TRUNCATE public.quant_job_steps'),'42501');
  await refused(rt.query('TRUNCATE public.quant_research_chunks'),'42501');
  assert.deepEqual(await guardRows().then(rows=>rows.map(row=>row.tgenabled)),FREEZE_GUARDS.map(()=>'A'));
});

test('the runtime role cannot edit a terminal run in any form; every refusal carries one SQLSTATE and changes nothing',async()=>{
  const before=await digests();
  for(const status of STATUSES){
    const id=preRuns[status].run_id,other=STATUSES.find(item=>item!==status);
    const edits=[
      ["UPDATE quant_jobs SET result='{}'::jsonb WHERE run_id=$1",[id]],
      ["UPDATE quant_jobs SET diagnostic='EDITED' WHERE run_id=$1",[id]],
      ['UPDATE quant_jobs SET status=$2 WHERE run_id=$1',[id,other]],
      ['UPDATE quant_jobs SET updated_at=updated_at+1 WHERE run_id=$1',[id]],
      ['UPDATE quant_jobs SET evaluations_started=evaluations_started+1,attempt=2,phase=$2 WHERE run_id=$1',[id,'EDITED']],
      ['UPDATE quant_jobs SET status=status WHERE run_id=$1',[id]],
      ["UPDATE quant_jobs j SET result=s.result FROM (SELECT '{}'::jsonb AS result) s WHERE j.run_id=$1",[id]],
      ["UPDATE quant_jobs SET status='RUNNING' WHERE run_id=$1",[id]],
      [`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
        SELECT run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,'FAILED',created_at,updated_at,deadline FROM quant_jobs WHERE run_id=$1
        ON CONFLICT (run_id) DO UPDATE SET diagnostic='EDITED'`,[id]],
      ["MERGE INTO quant_jobs t USING (SELECT $1::text AS run_id) s ON t.run_id=s.run_id WHEN MATCHED THEN UPDATE SET diagnostic='EDITED'",[id]],
      ['DELETE FROM quant_jobs WHERE run_id=$1',[id]],
      ['INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[id,'candidate:999','CANDIDATE','{}','{}',1]]];
    for(const [sql,params] of edits)await assert.rejects(rt.query(sql,params),{code:QR},status+': '+sql.slice(0,60));
  }
  await refused(rt.query('DELETE FROM quant_jobs WHERE run_id=$1',[preRuns.zeroStep.run_id]));
  await refused(rt.query("UPDATE quant_jobs SET diagnostic='EDITED' WHERE run_id=$1",[preRuns.zeroStep.run_id]));
  await refused(rt.query('DELETE FROM quant_jobs'));
  // The earlier immutability triggers keep their own behaviour on the same run.
  await assert.rejects(rt.query('UPDATE quant_job_steps SET result=$2 WHERE run_id=$1',[preRuns.SUCCEEDED.run_id,'{}']),/Completed Quant checkpoint is immutable/);
  assert.deepEqual(await digests(),before,'no row changed');
  assert.deepEqual(await digests(),baseline,'the "as found" rows are byte identical to the baseline');
  // Reads stay open for the runtime role, and an UPDATE that matches no row is not an edit.
  assert.equal((await rt.query('SELECT count(*)::int n FROM quant_jobs')).rows[0].n,STATUSES.length+1);
  assert.equal((await rt.query("UPDATE quant_jobs SET diagnostic='X' WHERE run_id=$1 AND false",[preRuns.SUCCEEDED.run_id])).rowCount,0);
});

test('the lifecycle QUEUED -> RUNNING -> checkpoints -> terminal still works; a queued run can be cancelled; the finished run is then frozen',async()=>{
  const finished={};
  for(const status of STATUSES){
    finished[status]=make(A,{...specs()[status],id:randomUUID(),at:T0+(10+STATUSES.indexOf(status))*1e6});
    await lifecycle(finished[status],A);
    const row=await rowOf(finished[status].run_id);
    assert.equal(row.status,status);assert.equal(row.lease_token,null);
    assert.equal((await db.query('SELECT count(*)::int n FROM quant_job_steps WHERE run_id=$1',[row.run_id])).rows[0].n,finished[status].steps.length);
    await refused(rt.query("UPDATE quant_jobs SET diagnostic='EDITED' WHERE run_id=$1",[row.run_id]));
    await refused(rt.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[row.run_id,'late:1','CANDIDATE','{}','{}',1]));
  }
  // The cancel path of the service: a queued run goes straight to CANCELLED, and a RUNNING run is cancelled while holding its lease.
  const queued=make(A,{status:'QUEUED',at:T0+20e6}),running=make(A,{status:'RUNNING',partial:2,at:T0+21e6});
  await rt.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,phase)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$8,$9,'CANDIDATES')`,[queued.run_id,A.id,A.deployment,'idem-'+queued.run_id,hex('s'),queued.contract_hash,JSON.stringify(queued.contract),queued.created_at,queued.created_at+9e5]);
  await rt.query("UPDATE quant_jobs SET status='CANCELLED',phase='COMPLETE',updated_at=updated_at+1 WHERE run_id=$1 AND status IN ('QUEUED','RUNNING')",[queued.run_id]);
  await lifecycle(running,A,{finalStatus:'RUNNING'});
  assert.equal((await rt.query("UPDATE quant_jobs SET status='TIMED_OUT',diagnostic='JOB_DEADLINE_EXCEEDED',lease_token=NULL,lease_until=0 WHERE run_id=$1 AND status IN ('QUEUED','RUNNING')",[running.run_id])).rowCount,1);
  // A second, late sweep matches no non-terminal row, so the guard is never hit by the filtered writers.
  assert.equal((await rt.query("UPDATE quant_jobs SET status='FAILED' WHERE run_id=$1 AND status IN ('QUEUED','RUNNING')",[running.run_id])).rowCount,0);
  await refused(rt.query("UPDATE quant_jobs SET status='RUNNING' WHERE run_id=$1",[queued.run_id]));
  // Unknown parent: the guard defers to the foreign key.
  await assert.rejects(rt.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),'c:1','CANDIDATE','{}','{}',1]),{code:'23503'});
});

test('race: a checkpoint insert that waits for a concurrent terminal transition is refused when it commits (FOR SHARE, not FOR KEY SHARE)',async()=>{
  const run=make(A,{status:'RUNNING',partial:1,at:T0+30e6});await lifecycle(run,A,{finalStatus:'RUNNING'});
  const finisher=await rt.pool.connect(),writer=await rt.pool.connect();
  try{
    await finisher.query('BEGIN');await writer.query('BEGIN');
    await finisher.query("UPDATE quant_jobs SET status='SUCCEEDED',phase='COMPLETE',result='{}'::jsonb,lease_token=NULL,lease_until=0 WHERE run_id=$1",[run.run_id]);
    const pending=writer.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[run.run_id,'race:1','CANDIDATE','{}','{}',1]).then(()=>null,error=>error);
    // Wait until the insert is blocked on the row lock of the uncommitted terminal transition.
    let blocked=false;
    for(let i=0;i<100&&!blocked;i++){
      blocked=(await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO quant_job_steps%' AND datname=$1",[databaseName])).rowCount>0;
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(blocked,'the insert waits for the terminal transition instead of reading RUNNING');
    await finisher.query('COMMIT');
    const outcome=await pending;
    assert.equal(outcome?.code,QR,'the late checkpoint is refused');
    await writer.query('ROLLBACK');
  }finally{await finisher.query('ROLLBACK').catch(()=>{});await writer.query('ROLLBACK').catch(()=>{});finisher.release();writer.release();}
  assert.equal((await db.query("SELECT count(*)::int n FROM quant_job_steps WHERE run_id=$1 AND step_id='race:1'",[run.run_id])).rows[0].n,0);
  assert.equal((await rowOf(run.run_id)).status,'SUCCEEDED');
});

let F,cancelled,forgedJob;
test('FOUNDATION extension: chunks and the binding row of a terminal run are frozen; only the recovery clear of the unit columns stays open',async()=>{
  F=await newOwner('freeze-f');
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  cancelled=make(F,{version:'v2',scenario:'PENDING',tag:'f1',id:randomUUID(),at:T0+40e6});
  // Written like a FOUNDATION run: the run is RUNNING while its binding and chunks are written.
  const running={...cancelled,status:'RUNNING',result:null,phase:'CANDIDATES'};
  await seedRun(db,running,{owner:F.id,deployment:F.deployment,leaseToken:'lease-'+cancelled.run_id});
  await seedFoundation(db,running,{owner:F.id});
  const unit=randomUUID();
  // RUNNING parent: progress, a new chunk, a chunk delete and the unit columns are all writable.
  assert.equal((await rt.query("UPDATE quant_research_chunks SET next_bar=1200,checkpoint='{\"n\":1}'::jsonb,checkpoint_hash=$2,unit_name='unit.service',unit_token=$3 WHERE run_id=$1 AND step_id='candidate:000'",
    [cancelled.run_id,hex('cp'),unit])).rowCount,1);
  await rt.query("INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'candidate:001','CANDIDATE','{}',$2)",[cancelled.run_id,hex('c1')]);
  assert.equal((await rt.query("DELETE FROM quant_research_chunks WHERE run_id=$1 AND step_id='candidate:001'",[cancelled.run_id])).rowCount,1);
  // The run is cancelled while its unit is still recorded (as in the service).
  await rt.query("UPDATE quant_jobs SET status='CANCELLED',phase='COMPLETE',lease_token=NULL,lease_until=0 WHERE run_id=$1",[cancelled.run_id]);
  const before=await digests();
  for(const [sql,params] of [
    ["UPDATE quant_research_chunks SET checkpoint='{\"n\":2}'::jsonb WHERE run_id=$1 AND step_id='candidate:000'",[cancelled.run_id]],
    ['UPDATE quant_research_chunks SET next_bar=next_bar+1 WHERE run_id=$1 AND step_id=$2',[cancelled.run_id,'candidate:000']],
    ["UPDATE quant_research_chunks SET checkpoint_hash=$2 WHERE run_id=$1",[cancelled.run_id,hex('forged')]],
    ["UPDATE quant_research_chunks SET unit_name='other.service' WHERE run_id=$1",[cancelled.run_id]],
    ['UPDATE quant_research_chunks SET unit_token=gen_random_uuid() WHERE run_id=$1',[cancelled.run_id]],
    ["UPDATE quant_research_chunks SET unit_name=NULL,unit_token=NULL,checkpoint='{}'::jsonb WHERE run_id=$1 AND step_id='candidate:000'",[cancelled.run_id]],
    ["UPDATE quant_research_chunks c SET checkpoint='{}'::jsonb FROM quant_jobs j WHERE j.run_id=c.run_id AND c.run_id=$1",[cancelled.run_id]],
    ['DELETE FROM quant_research_chunks WHERE run_id=$1',[cancelled.run_id]],
    ["DELETE FROM quant_research_chunks WHERE run_id=$1 AND step_id='prepare:dataset'",[cancelled.run_id]],
    ["INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'candidate:009','CANDIDATE','{}',$2)",[cancelled.run_id,hex('c9')]],
    ["INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'candidate:000','CANDIDATE','{}',$2) ON CONFLICT (run_id,step_id) DO UPDATE SET checkpoint='{}'::jsonb",[cancelled.run_id,hex('c0')]],
    ['DELETE FROM quant_research_foundation WHERE run_id=$1',[cancelled.run_id]]])
    await assert.rejects(rt.query(sql,params),{code:sql.startsWith('DELETE FROM quant_research_foundation')?'P0001':QR},sql);
  assert.deepEqual(await digests(),before);
  // The recovery clear (src/postgres/quant-foundation-recovery.js): same predicate, both unit columns to NULL.
  assert.equal((await rt.query('UPDATE quant_research_chunks SET unit_name=NULL,unit_token=NULL WHERE run_id=$1 AND unit_token=$2 AND unit_name IS NOT NULL',[cancelled.run_id,unit])).rowCount,1);
  const cleared=(await db.query('SELECT step_id,unit_name,unit_token,next_bar,checkpoint FROM quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[cancelled.run_id])).rows;
  assert.deepEqual(cleared.map(row=>[row.step_id,row.unit_name,row.unit_token]),[['candidate:000',null,null],['prepare:dataset',null,null]]);
  assert.equal(cleared[0].next_bar,1200);assert.deepEqual(cleared[0].checkpoint,{n:1});
  // A binding row cannot be added under a terminal legacy run either (the binding and chunk tables are not a back door).
  await db.query("INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,'forged','{}'::jsonb,$3,'QUEUED',1,2)",
    [forgedJob=randomUUID(),F.id,hex('forged')]);
  const fixed=preRuns.SUCCEEDED.run_id;
  await refused(rt.query('INSERT INTO quant_research_foundation(run_id,job_id,contract_hash) VALUES($1,$2,$3)',[fixed,forgedJob,preRuns.SUCCEEDED.contract_hash]));
  await refused(rt.query("INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'prepare:dataset','PREPARE','{}',$2)",[fixed,hex('forged-binding')]));
  assert.equal((await db.query('SELECT count(*)::int n FROM quant_research_foundation WHERE run_id=$1',[fixed])).rows[0].n,0);
});

test('search_path hardening: a TEMP table named like a research table, seeded RUNNING, does not fool any guard',async()=>{
  const facts=(await db.query("SELECT has_database_privilege($1,current_database(),'TEMP') AS temp",[roleName])).rows[0];
  assert.equal(facts.temp,true,'the role holds TEMP (default PUBLIC privilege), so the shadow attack is possible');
  const terminal=preRuns.SUCCEEDED.run_id,shadowBefore=await digests(),client=await rt.pool.connect();
  try{
    await client.query('CREATE TEMP TABLE quant_jobs(run_id text,status text)');
    await client.query('CREATE TEMP TABLE quant_job_steps(run_id text,step_id text)');
    await client.query("INSERT INTO pg_temp.quant_jobs VALUES($1,'RUNNING'),($2,'RUNNING')",[terminal,cancelled.run_id]);
    // Control: the unqualified name really resolves to the shadow, so an unqualified lookup would have been fooled.
    assert.equal((await client.query('SELECT status FROM quant_jobs WHERE run_id=$1',[terminal])).rows[0].status,'RUNNING');
    assert.equal((await client.query('SELECT status FROM public.quant_jobs WHERE run_id=$1',[terminal])).rows[0].status,'SUCCEEDED');
    const attempts=[
      ['INSERT INTO public.quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[terminal,'shadow:1','CANDIDATE','{}','{}',1]],
      ["INSERT INTO public.quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'shadow:2','CANDIDATE','{}',$2)",[cancelled.run_id,hex('s2')]],
      ["UPDATE public.quant_research_chunks SET checkpoint='{\"shadow\":true}'::jsonb WHERE run_id=$1",[cancelled.run_id]],
      ['DELETE FROM public.quant_research_chunks WHERE run_id=$1',[cancelled.run_id]],
      ['INSERT INTO public.quant_research_foundation(run_id,job_id,contract_hash) VALUES($1,$2,$3)',[terminal,forgedJob,preRuns.SUCCEEDED.contract_hash]],
      ["UPDATE public.quant_jobs SET diagnostic='SHADOW' WHERE run_id=$1",[terminal]]];
    for(const [sql,params] of attempts)await assert.rejects(client.query(sql,params),{code:QR},sql);
    // Also with the temp schema searched first explicitly, and with a hostile search_path on the session.
    await client.query('SET search_path = pg_temp, public');
    await assert.rejects(client.query('INSERT INTO public.quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[terminal,'shadow:3','CANDIDATE','{}','{}',1]),{code:QR});
  }finally{client.release(true);}
  assert.deepEqual(await digests(),shadowBefore,'no row changed');
  assert.equal((await db.query("SELECT count(*)::int n FROM quant_job_steps WHERE step_id LIKE 'shadow:%'")).rows[0].n,0);
});

// Restart proof on its OWN throwaway cluster. The shared test cluster is never stopped or restarted: under --test-isolation=none every
// file of the suite shares it, and a restart would kill the open connections of the other files (finding FZ2-RESTART-ISOLATION).
// FREEZE_TEST_PG_BIN (a PostgreSQL bin directory) or FREEZE_TEST_PG_CTL (the path of pg_ctl, its directory is used) enables the proof;
// without either it is skipped. FREEZE_TEST_PGDATA is no longer read: the data directory is created and removed by the test.
const PG_BIN=process.env.FREEZE_TEST_PG_BIN||(process.env.FREEZE_TEST_PG_CTL?path.dirname(process.env.FREEZE_TEST_PG_CTL):'');
const pgTool=name=>path.join(PG_BIN,name+(process.platform==='win32'?'.exe':''));
// Output is discarded: a postmaster that inherits a pipe would hang the caller.
const runTool=(name,args,timeout=240000)=>spawnSync(pgTool(name),args,{stdio:'ignore',windowsHide:true,timeout}).status;
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);
  server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
test('restart readback: after its own throwaway cluster is stopped and started again the digests, the guards (tgenabled A) and the refusals are the same',{skip:!PG_BIN},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-freeze-restart-')),data=path.join(dir,'data');
  const sharedStart=(await admin.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.getTime();
  let own,ownRuntime,started=false;
  try{
    assert.equal(runTool('initdb',['-D',data,'-U','robot_restart_su','-A','trust','-E','UTF8','--locale=C']),0,'initdb');
    const port=await freePort();
    // The settings live in postgresql.conf, so the restart (which reuses them) needs no command line options.
    await fs.appendFile(path.join(data,'postgresql.conf'),`\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\nmax_connections = 40\nshared_buffers = 16MB\n`);
    assert.equal(runTool('pg_ctl',['-D',data,'-l',path.join(dir,'postgres.log'),'-w','-t','120','start']),0,'cluster started');started=true;
    const ownUrl=(user,name='postgres')=>`postgres://${user}@127.0.0.1:${port}/${name}`;
    const role='robot_restart_role',ownAdmin=new PostgresDatabase({connectionString:ownUrl('robot_restart_su')});
    try{await ownAdmin.query('CREATE DATABASE robot_restart_db');await ownAdmin.query('CREATE ROLE '+role+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');}finally{await ownAdmin.close();}
    own=new PostgresDatabase({connectionString:ownUrl('robot_restart_su','robot_restart_db'),max:4});await own.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'])
      await own.transaction(async()=>own.query(await fs.readFile(new URL(name,sourceDir),'utf8')));
    await own.query((await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll('robot_app',role));
    // Pre-freeze rows, as in the "as found" test, then the freeze.
    const owner=await newOwner('freeze-restart',own,new Store(own)),seeded={};
    for(const [status,options] of Object.entries(specs())){seeded[status]=make(owner,options);await seedRun(own,seeded[status],{owner:owner.id,deployment:owner.deployment});}
    seeded.zeroStep=make(owner,{status:'FAILED',diagnostic:'OWNER_UNAVAILABLE',at:T0+6e6});await seedRun(own,seeded.zeroStep,{owner:owner.id,deployment:owner.deployment});
    const report=await migrateQuantResearchFreeze(own,{runtimeRole:role});
    assert.equal(report.ok,true,report.failures.join());
    ownRuntime=new PostgresDatabase({connectionString:ownUrl(role,'robot_restart_db'),max:2});
    const snapshot=async target=>({rows:await digests(target),guards:await guardRows(target),functions:await functionDigests(target),acl:await acls(target)});
    const before=await snapshot(own);
    assert.ok(before.guards.length>=FREEZE_GUARDS.length&&before.guards.every(row=>row.tgenabled==='A'));
    assert.equal((await own.query('SELECT count(*)::int n FROM quant_jobs')).rows[0].n,STATUSES.length+1,'the proof runs on real rows');
    const startedAt=(await own.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.getTime();
    await ownRuntime.close();await own.close();own=null;ownRuntime=null;
    // restart = fast stop, then start with the settings recorded in postgresql.conf.
    assert.equal(runTool('pg_ctl',['-D',data,'restart','-m','fast','-w','-t','120']),0,'own cluster restarted');
    own=new PostgresDatabase({connectionString:ownUrl('robot_restart_su','robot_restart_db'),max:4});
    ownRuntime=new PostgresDatabase({connectionString:ownUrl(role,'robot_restart_db'),max:2});
    assert.ok((await own.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.getTime()>startedAt,'the postmaster really restarted');
    assert.deepEqual(await snapshot(own),before);
    await refused(ownRuntime.query("UPDATE quant_jobs SET diagnostic='EDITED' WHERE run_id=$1",[seeded.SUCCEEDED.run_id]));
    await refused(ownRuntime.query('DELETE FROM quant_jobs WHERE run_id=$1',[seeded.zeroStep.run_id]));
    assert.equal((await inspectQuantResearchFreeze(own,{runtimeRole:role})).ok,true);
  }finally{
    await ownRuntime?.close().catch(()=>{});await own?.close().catch(()=>{});
    if(started&&runTool('pg_ctl',['-D',data,'stop','-m','fast','-w','-t','60'])!==0)runTool('pg_ctl',['-D',data,'stop','-m','immediate','-w','-t','60']);
    await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(error=>t.diagnostic('scratch cluster not removed: '+error.message));
  }
  // The shared cluster was never touched: same postmaster, same connections.
  assert.equal((await admin.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started.getTime(),sharedStart,'the shared cluster was not restarted');
});

test('dump and restore: the restored database keeps every guard ENABLE ALWAYS and still refuses the edits',async t=>{
  const restoredName='robot_freeze_restore_'+randomUUID().replaceAll('-','');databases.push(restoredName);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'robot-freeze-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let backup;
  try{backup=await backupPostgres(path.join(dir,'freeze.dump'),{connectionString});}catch(error){t.skip('pg_dump unavailable: '+error.message);return;}
  await admin.query('CREATE DATABASE '+restoredName);
  const env=postgresToolEnvironment(urlOf(restoredName));
  const status=await new Promise(resolve=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});
    child.on('error',()=>resolve(null));child.on('exit',resolve);});
  if(status===null){t.skip('pg_restore unavailable');return;}
  assert.equal(status,0);
  const restored=new PostgresDatabase({connectionString:urlOf(restoredName)}),restoredRuntime=new PostgresDatabase({connectionString:urlOf(restoredName,roleName)});
  try{
    assert.deepEqual(await guardRows(restored),await guardRows(db));assert.ok((await guardRows(restored)).every(row=>row.tgenabled==='A'));
    assert.deepEqual(await functionDigests(restored),await functionDigests(db));
    assert.deepEqual(await digests(restored),await digests(db));
    assert.equal((await inspectQuantResearchFreeze(restored,{runtimeRole:roleName})).ok,true);
    await refused(restoredRuntime.query("UPDATE quant_jobs SET diagnostic='EDITED' WHERE run_id=$1",[preRuns.SUCCEEDED.run_id]));
    await refused(restoredRuntime.query('DELETE FROM quant_jobs WHERE run_id=$1',[preRuns.zeroStep.run_id]));
    await refused(restoredRuntime.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',[preRuns.SUCCEEDED.run_id,'late:2','CANDIDATE','{}','{}',1]));
  }finally{await restoredRuntime.close();await restored.close();}
});

test('rollback is a data-free DROP; edits work again; a second install restores the guards and leaves the data as it is',async()=>{
  const before=await digests(),acl=await acls(),functions=await functionDigests();
  await rollbackQuantResearchFreeze(db);
  assert.deepEqual(await digests(),before,'rollback changed no row');assert.deepEqual(await acls(),acl,'rollback changed no grant');
  assert.deepEqual(await guardRows(),[]);assert.deepEqual(await functionDigests(),[]);
  assert.equal((await db.query("SELECT to_regprocedure('public.quant_research_freeze_version()') p")).rows[0].p,null);
  // The version-1 guards stay exactly as they were.
  assert.ok((await db.query("SELECT 1 FROM pg_trigger WHERE tgname IN ('quant_job_contract_immutable','quant_job_step_immutable','quant_research_binding_immutable','quant_research_chunk_guard') AND NOT tgisinternal")).rowCount===4);
  // Without the freeze the old gap is back: the runtime role can rewrite a stored result. This is the documented pre-QR-1b state.
  await rt.query("UPDATE quant_jobs SET diagnostic='ROLLED_BACK_EDIT' WHERE run_id=$1",[preRuns.NO_VALID_CANDIDATE.run_id]);
  const edited=await digests();assert.notDeepEqual(edited,before);
  await rt.query("UPDATE quant_jobs SET diagnostic=$2 WHERE run_id=$1",[preRuns.NO_VALID_CANDIDATE.run_id,preRuns.NO_VALID_CANDIDATE.diagnostic]);
  assert.deepEqual(await digests(),before,'the edit was reverted by hand');
  await rollbackQuantResearchFreeze(db); // idempotent
  assert.equal((await migrateQuantResearchFreeze(db,{runtimeRole:roleName})).ok,true);
  assert.deepEqual(await digests(),before);assert.deepEqual(await functionDigests(),functions);assert.deepEqual(await acls(),acl);
  assert.ok((await guardRows()).every(row=>row.tgenabled==='A'));
  await refused(rt.query("UPDATE quant_jobs SET diagnostic='EDITED' WHERE run_id=$1",[preRuns.NO_VALID_CANDIDATE.run_id]));
});

test('legacy-only database: three guards, no FOUNDATION objects; a later FOUNDATION extension is picked up by re-running the migration',async()=>{
  const name='robot_freeze_legacy_'+randomUUID().replaceAll('-','');databases.push(name);
  await admin.query('CREATE DATABASE '+name);
  const local=new PostgresDatabase({connectionString:urlOf(name)});
  try{
    await local.migrate();
    for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql'])await local.transaction(async()=>local.query(await fs.readFile(new URL(file,sourceDir),'utf8')));
    assert.equal((await classifyQuantResearchFreeze(local)).state,'ABSENT');
    const report=await migrateQuantResearchFreeze(local);
    assert.equal(report.ok,true,report.failures.join());assert.equal(report.previous_state,'ABSENT');assert.equal(report.facts.state,'FROZEN_LEGACY');
    assert.deepEqual((await guardRows(local)).map(row=>row.tgname).sort(),['quant_job_step_terminal_insert','quant_job_terminal_freeze','quant_job_terminal_no_delete']);
    assert.equal(report.facts.functions.some(fn=>fn.name==='quant_research_freeze_chunk_change'),false);
    for(const file of ['quant-foundation-schema.sql','quant-research-foundation-schema.sql'])await local.transaction(async()=>local.query(await fs.readFile(new URL(file,sourceDir),'utf8')));
    const partial=await inspectQuantResearchFreeze(local);
    assert.equal(partial.ok,false);assert.ok(partial.failures.includes('GUARD_MISSING:quant_research_chunk_terminal_freeze'),partial.failures.join());
    // Legacy objects exact, FOUNDATION table present, no FOUNDATION guard yet: FROZEN_LEGACY, not yet converged.
    assert.equal(partial.facts.state,'FROZEN_LEGACY');assert.equal((await classifyQuantResearchFreeze(local)).converged,false);
    const converged=await migrateQuantResearchFreeze(local);
    assert.equal(converged.ok,true);assert.equal(converged.previous_state,'FROZEN_LEGACY');assert.equal(converged.facts.state,'FROZEN');
    assert.equal((await guardRows(local)).length,FREEZE_GUARDS.length);
    assert.equal((await rollbackQuantResearchFreeze(local)).previous_state,'FROZEN');
    assert.deepEqual(await guardRows(local),[]);
    // A database without the version-1 extension is refused.
    const bare='robot_freeze_bare_'+randomUUID().replaceAll('-','');databases.push(bare);
    await admin.query('CREATE DATABASE '+bare);
    const empty=new PostgresDatabase({connectionString:urlOf(bare)});
    try{await empty.migrate();await assert.rejects(migrateQuantResearchFreeze(empty),/Quant research extension 1 required/);}finally{await empty.close();}
  }finally{await local.close();}
});

// FZ2: classify first. Every case below runs on a throwaway copy (CREATE DATABASE ... TEMPLATE) of a database that has the version-1
// and FOUNDATION extensions, either without the freeze (ABSENT) or with it (FROZEN). A catalog digest that includes every row version
// (xmin) of the public functions and the user triggers proves "refused without writing": a rewrite, even by an identical statement, changes it.
const REFUSED_OTHER=/refused; unexpected state OTHER \(no change made\)/;
// One work database serves every case: fresh() removes anything that carries a freeze name, then installs the freeze SQL directly for 'frozen'.
let shared;
async function workDb(){
  if(shared)return shared;
  const name='robot_freeze_work_'+randomUUID().replaceAll('-','');databases.push(name);
  await admin.query('CREATE DATABASE '+name);
  const local=new PostgresDatabase({connectionString:urlOf(name)});
  await local.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql'])
    await local.transaction(async()=>local.query(await fs.readFile(new URL(file,sourceDir),'utf8')));
  return shared=local;
}
const CLEANUP=`DO $do$
DECLARE r record;
BEGIN
 FOR r IN SELECT t.tgname,c.oid::regclass AS rel FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE NOT t.tgisinternal AND (t.tgname LIKE 'quant\\_job\\_%terminal%' OR t.tgname LIKE 'quant\\_research\\_%terminal%' OR t.tgname='extra_freeze_copy') LOOP
  EXECUTE format('DROP TRIGGER %I ON %s',r.tgname,r.rel);
 END LOOP;
 FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND (p.proname LIKE 'quant\\_research\\_%freeze%' OR p.proname='quant_research_status_is_terminal' OR p.proname='foreign_guard') LOOP
  EXECUTE 'DROP FUNCTION '||r.f;
 END LOOP;
END $do$`;
/** A work database in the requested state: 'bare' (no object with a freeze name) or 'frozen' (the freeze SQL applied directly). */
async function fresh(kind){
  const local=await workDb();
  await local.query(CLEANUP);
  assert.equal((await classifyQuantResearchFreeze(local)).state,'ABSENT');
  if(kind==='frozen'){
    await local.transaction(async()=>local.query(await fs.readFile(new URL('quant-research-freeze.sql',sourceDir),'utf8')));
    assert.equal((await classifyQuantResearchFreeze(local)).state,'FROZEN');
  }
  return local;
}
const catalogDigest=async target=>(await target.query(`SELECT md5(COALESCE(string_agg(x,'|' ORDER BY x),'')) d,count(*)::int n FROM (
  SELECT 'f:'||p.oid||':'||p.xmin::text||':'||p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||md5(p.prosrc||COALESCE(p.proconfig::text,'')) x
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT 't:'||t.oid||':'||t.xmin::text||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid FROM pg_trigger t WHERE NOT t.tgisinternal) s`)).rows[0];
async function refusesUnchanged(local,note){
  const before=await catalogDigest(local);
  await assert.rejects(migrateQuantResearchFreeze(local),REFUSED_OTHER,note+': install');
  assert.deepEqual(await catalogDigest(local),before,note+': install wrote nothing');
  await assert.rejects(rollbackQuantResearchFreeze(local),REFUSED_OTHER,note+': rollback');
  assert.deepEqual(await catalogDigest(local),before,note+': rollback wrote nothing');
  assert.equal((await classifyQuantResearchFreeze(local)).state,'OTHER',note);
  assert.equal((await inspectQuantResearchFreeze(local)).facts.state,'OTHER',note);
}
const FOREIGN='CREATE FUNCTION public.foreign_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$';
const REBIND=(table,name,when,fn)=>['DROP TRIGGER '+name+' ON public.'+table,
  'CREATE TRIGGER '+name+' '+when+' ON public.'+table+' FOR EACH ROW EXECUTE FUNCTION public.'+fn+'()','ALTER TABLE public.'+table+' ENABLE ALWAYS TRIGGER '+name];

test('classify: ABSENT installs and reports previous_state; FROZEN installs as a no-op and writes nothing; rollback FROZEN gives ABSENT and ABSENT rollback writes nothing',async()=>{
  const local=await fresh('bare');
  const absent=await catalogDigest(local);
  assert.equal((await classifyQuantResearchFreeze(local)).state,'ABSENT');
  assert.deepEqual((await inspectQuantResearchFreeze(local)).facts.state,'ABSENT');
  const undone=await rollbackQuantResearchFreeze(local);
  assert.deepEqual(undone,{rolled_back:true,previous_state:'ABSENT'});assert.deepEqual(await catalogDigest(local),absent,'rollback on ABSENT wrote nothing');
  const first=await migrateQuantResearchFreeze(local);
  assert.equal(first.ok,true,first.failures.join());assert.equal(first.previous_state,'ABSENT');assert.equal(first.facts.state,'FROZEN');
  const frozen=await catalogDigest(local);assert.notDeepEqual(frozen,absent);
  const classification=await classifyQuantResearchFreeze(local);
  assert.equal(classification.state,'FROZEN');assert.equal(classification.converged,true);assert.deepEqual(classification.problems,[]);assert.deepEqual(classification.missing,[]);
  const second=await migrateQuantResearchFreeze(local);
  assert.equal(second.ok,true);assert.equal(second.previous_state,'FROZEN');assert.equal(second.facts.state,'FROZEN');
  assert.deepEqual(await catalogDigest(local),frozen,'install on FROZEN is a no-op: no row version of the catalog changed');
  const removed=await rollbackQuantResearchFreeze(local);
  assert.deepEqual(removed,{rolled_back:true,previous_state:'FROZEN'});
  assert.equal((await classifyQuantResearchFreeze(local)).state,'ABSENT');assert.deepEqual(await guardRows(local),[]);
  assert.equal((await migrateQuantResearchFreeze(local)).previous_state,'ABSENT');
});

const TAMPERED={
  'changed guard body':['CREATE OR REPLACE FUNCTION public.quant_research_freeze_job_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN OLD; END $$'],
  'changed chunk guard body':['CREATE OR REPLACE FUNCTION public.quant_research_freeze_chunk_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END $$'],
  'replaced marker':["CREATE OR REPLACE FUNCTION public.quant_research_freeze_version() RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 'forged'::text $$"],
  'extra function setting':["ALTER FUNCTION public.quant_research_freeze_job_update() SET work_mem = '64MB'"],
  'search_path reset':['ALTER FUNCTION public.quant_research_freeze_step_insert() RESET search_path'],
  'search_path changed':['ALTER FUNCTION public.quant_research_freeze_step_insert() SET search_path = public'],
  'security definer':['ALTER FUNCTION public.quant_research_freeze_job_update() SECURITY DEFINER'],
  'volatility changed':['ALTER FUNCTION public.quant_research_status_is_terminal(text) VOLATILE'],
  'strict':['ALTER FUNCTION public.quant_research_status_is_terminal(text) STRICT'],
  'leakproof':['ALTER FUNCTION public.quant_research_status_is_terminal(text) LEAKPROOF'],
  'disabled trigger':['ALTER TABLE public.quant_jobs DISABLE TRIGGER quant_job_terminal_freeze'],
  'origin-only trigger':['ALTER TABLE public.quant_jobs ENABLE TRIGGER quant_job_terminal_freeze'],
  'replica-only trigger':['ALTER TABLE public.quant_jobs ENABLE REPLICA TRIGGER quant_job_terminal_freeze'],
  'missing legacy trigger':['DROP TRIGGER quant_job_terminal_no_delete ON public.quant_jobs'],
  'missing foundation trigger':['DROP TRIGGER quant_research_chunk_terminal_insert ON public.quant_research_chunks'],
  'missing legacy function':['DROP FUNCTION public.quant_research_freeze_version()'],
  'trigger bound to a foreign function':[FOREIGN,...REBIND('quant_jobs','quant_job_terminal_freeze','BEFORE UPDATE','foreign_guard')],
  'trigger bound to another freeze function':REBIND('quant_jobs','quant_job_terminal_freeze','BEFORE UPDATE','quant_research_freeze_job_delete'),
  'AFTER trigger':REBIND('quant_jobs','quant_job_terminal_freeze','AFTER UPDATE','quant_research_freeze_job_update'),
  'trigger with a WHEN clause':['DROP TRIGGER quant_job_terminal_freeze ON public.quant_jobs',
    'CREATE TRIGGER quant_job_terminal_freeze BEFORE UPDATE ON public.quant_jobs FOR EACH ROW WHEN (OLD.status IS NOT NULL) EXECUTE FUNCTION public.quant_research_freeze_job_update()',
    'ALTER TABLE public.quant_jobs ENABLE ALWAYS TRIGGER quant_job_terminal_freeze'],
  'trigger on a column list':['DROP TRIGGER quant_job_terminal_freeze ON public.quant_jobs',
    'CREATE TRIGGER quant_job_terminal_freeze BEFORE UPDATE OF diagnostic ON public.quant_jobs FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_job_update()',
    'ALTER TABLE public.quant_jobs ENABLE ALWAYS TRIGGER quant_job_terminal_freeze'],
  'extra trigger on a freeze function':['CREATE TRIGGER extra_freeze_copy BEFORE INSERT ON public.quant_jobs FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_step_insert()'],
  'freeze trigger name on another table':['CREATE TRIGGER quant_job_terminal_freeze BEFORE UPDATE ON public.quant_foundation_jobs FOR EACH ROW EXECUTE FUNCTION public.quant_research_freeze_job_update()'],
  'foreign overload of a freeze function':["CREATE FUNCTION public.quant_research_status_is_terminal(integer) RETURNS boolean LANGUAGE sql AS 'SELECT false'"]};
test('classify: a FROZEN database with any inexact object is OTHER; install and rollback both refuse and write nothing',async()=>{
  for(const [note,statements] of Object.entries(TAMPERED)){
    const local=await fresh('frozen');
    for(const statement of statements)await local.query(statement);
    await refusesUnchanged(local,note);
  }
});

const FOREIGN_NAMED={
  'foreign marker function':["CREATE FUNCTION public.quant_research_freeze_version() RETURNS TEXT LANGUAGE sql AS $$ SELECT 'not-the-freeze'::text $$"],
  'foreign function with a different signature':['CREATE FUNCTION public.quant_research_freeze_job_delete(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$'],
  'foreign guard function':['CREATE FUNCTION public.quant_research_freeze_job_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'],
  'foreign trigger with a freeze name':[FOREIGN,'CREATE TRIGGER quant_job_terminal_freeze BEFORE UPDATE ON public.quant_jobs FOR EACH ROW EXECUTE FUNCTION public.foreign_guard()'],
  'freeze trigger name on another table':[FOREIGN,'CREATE TRIGGER quant_job_step_terminal_insert BEFORE INSERT ON public.quant_foundation_jobs FOR EACH ROW EXECUTE FUNCTION public.foreign_guard()'],
  'foreign chunk guard function':['CREATE FUNCTION public.quant_research_freeze_chunk_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$']};
test('classify: a database without the freeze but with a foreign object that carries a freeze name is OTHER; nothing is overwritten or dropped',async()=>{
  for(const [note,statements] of Object.entries(FOREIGN_NAMED)){
    const local=await fresh('bare');
    for(const statement of statements)await local.query(statement);
    await refusesUnchanged(local,note);
  }
});

test('inspect never runs a replaced marker function and takes no write: a marker that raises is not called',async()=>{
  const local=await fresh('bare');
  await local.query("CREATE FUNCTION public.quant_research_freeze_version() RETURNS TEXT LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'marker must not run'; END $$");
  const before=await catalogDigest(local);
  const report=await inspectQuantResearchFreeze(local);
  assert.equal(report.ok,false);assert.equal(report.facts.state,'OTHER');assert.equal(report.facts.marker,null);
  assert.ok(report.failures.includes('MARKER_MISSING'));
  assert.ok(report.failures.some(item=>item.startsWith('FUNCTION_DEFINITION:quant_research_freeze_version:')),report.failures.join());
  assert.deepEqual(await catalogDigest(local),before);
});

test('classify: FROZEN_LEGACY converges to FROZEN and rolls back; a partial FOUNDATION layer is OTHER',async()=>{
  const dropFoundationLayer=async local=>{
    for(const statement of ['DROP TRIGGER quant_research_chunk_terminal_freeze ON public.quant_research_chunks','DROP TRIGGER quant_research_chunk_terminal_insert ON public.quant_research_chunks',
      'DROP TRIGGER quant_research_binding_terminal_insert ON public.quant_research_foundation','DROP FUNCTION public.quant_research_freeze_chunk_change()'])await local.query(statement);
  };
  const local=await fresh('frozen');
  // Remove the whole FOUNDATION layer by hand: legacy exact, FOUNDATION tables present, no FOUNDATION object.
  await dropFoundationLayer(local);
  const legacy=await classifyQuantResearchFreeze(local);
  assert.equal(legacy.state,'FROZEN_LEGACY');assert.equal(legacy.converged,false);assert.equal(legacy.missing.length,4);
  assert.equal((await inspectQuantResearchFreeze(local)).ok,false,'not yet complete for the FOUNDATION tables');
  const report=await migrateQuantResearchFreeze(local);
  assert.equal(report.previous_state,'FROZEN_LEGACY');assert.equal(report.facts.state,'FROZEN');assert.equal(report.ok,true,report.failures.join());
  // Rollback also accepts FROZEN_LEGACY.
  await dropFoundationLayer(local);
  assert.deepEqual(await rollbackQuantResearchFreeze(local),{rolled_back:true,previous_state:'FROZEN_LEGACY'});
  assert.equal((await classifyQuantResearchFreeze(local)).state,'ABSENT');
});
