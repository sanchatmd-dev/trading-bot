import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantFixedEvalService} from '../../src/postgres/quant-fixed-eval.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';

// Isolated root runner only. Privileged fixture setup is followed by the complete canonical grant script.
// Service calls use a distinct LOGIN NOSUPERUSER connection, never SET ROLE on the fixture owner.
async function withRuntime(work){
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  let fixture,runtime,admin,role;
  try{
    fixture=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
    admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
    role='fe2b_runtime_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE ROLE '+role+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT'+rolePasswordClause(fixture.connectionString));
    const script=await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8');
    await fixture.db.query(script.replaceAll(":'runtime_role'","'"+role+"'"));
    const url=new URL(fixture.connectionString);url.username=role;
    runtime=new PostgresDatabase({connectionString:url.toString(),max:3});
    const store=new Store(runtime);
    const service=new QuantFixedEvalService({pineService:new PineBridgeService(store),supportedSourceHash:fixture.c.source_hash,engineHash:async()=>fixture.context.engine});
    await work({fixture,runtime,store,service,role});
  }finally{
    // Close non-owner connections before database disposal, then remove the cluster-global test role.
    try{await runtime?.close();}finally{
      try{await fixture?.close();}finally{
        try{if(role)await admin.query('DROP ROLE IF EXISTS '+role);}finally{await admin?.close();}
      }
    }
  }
}
const totals=async fixture=>(await fixture.db.query(`SELECT
 (SELECT count(*)::int FROM public.quant_jobs WHERE contract->>'mode'='FIXED_INPUT_EVAL') jobs,
 (SELECT count(*)::int FROM public.quant_foundation_jobs WHERE contract->>'version'='quant-foundation-fixed-eval-v1') foundation,
 (SELECT count(*)::int FROM public.quant_research_foundation b JOIN public.quant_jobs j ON j.run_id=b.run_id WHERE j.contract->>'mode'='FIXED_INPUT_EVAL') bindings,
 (SELECT count(*)::int FROM public.quant_selection_evaluation_starts WHERE selection_id=$1) starts,
 (SELECT count(*)::int FROM public.quant_exposure_register WHERE selection_id=$1::text) exposures`,[fixture.body.object_id])).rows[0];
const noStarts={jobs:0,foundation:0,bindings:0,starts:0,exposures:0};
const parentColumns={
  quant_selection_registrations:'fixture',quant_selection_participants:'position',quant_selection_window_freezes:'dataset_hash',
  quant_selection_status_events:'status',quant_selection_evaluation_starts:'engine_hash',
  quant_comparison_specs:'fixture',quant_comparison_participants:'position',
  bi_exports:'fixture',bi_status_events:'status',ql4c_validation:'fixture'
};

async function assertLeastPrivilege({fixture,runtime,role}){
  const identity=(await runtime.query('SELECT current_user AS name,session_user AS session')).rows[0];
  assert.equal(identity.name,role);assert.equal(identity.session,role);
  const flags=(await runtime.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(flags,{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,rolreplication:false});
  assert.equal((await fixture.db.query('SELECT pg_has_role($1,current_user,\'MEMBER\') AS inherited',[role])).rows[0].inherited,false,'runtime cannot SET ROLE to fixture schema owner');
  for(const [table,column] of Object.entries(parentColumns)){
    const privileges=(await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'UPDATE') AS write,has_any_column_privilege(current_user,$1,'UPDATE') AS column_write",['public.'+table])).rows[0];
    assert.deepEqual(privileges,{read:true,write:false,column_write:false},table);
    // Zero-row UPDATE proves denied privilege without changing a parent row or relying on insert-only triggers.
    await assert.rejects(runtime.query(`UPDATE public.${table} SET ${column}=${column} WHERE false`),{code:'42501'},table);
  }
}

test('FE2b actual runtime grants: immutable parents stay non-updatable while QR4 admission and read-only status succeed',()=>withRuntime(async context=>{
  const {fixture:f,runtime,service}=context;
  await assertLeastPrivilege(context);
  const foreign=await f.store.createUser({email:'foreign-runtime-'+randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture-hash'});
  const denied=await service.enqueue(foreign.id,f.body,'runtime_foreign_001');
  assert.equal(denied.ok,false);assert.equal(denied.code,'NOT_FOUND');assert.deepEqual(await totals(f),noStarts);
  const admitted=await service.enqueue(f.owner,f.body,'runtime_admit_0001');
  assert.equal(admitted.ok,true);assert.equal(typeof admitted.evaluation_run_id,'string');
  assert.deepEqual(await totals(f),{jobs:1,foundation:1,bindings:1,starts:1,exposures:1});
  const before=await totals(f);
  const read=await runtime.transaction(async()=>{
    await runtime.query('SET TRANSACTION READ ONLY');
    assert.equal((await runtime.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
    return service.read(f.owner,admitted.evaluation_run_id);
  },{isolation:'REPEATABLE READ'});
  assert.equal(read.ok,true);assert.equal(read.run_id,admitted.evaluation_run_id);assert.equal(read.status,'QUEUED');
  assert.equal(read.purpose,'QR4_SELECTION');assert.equal(read.dataset_sha_verified,false,'admission/status is not dataset execution acceptance');
  assert.equal(Object.hasOwn(read,'contract'),false);assert.equal(Object.hasOwn(read,'source'),false);
  await assert.rejects(service.read(foreign.id,admitted.evaluation_run_id),{code:'NOT_FOUND'});
  assert.deepEqual(await totals(f),before,'status and foreign reads add no jobs, starts or exposure');
  // Canonical parent privileges remain unchanged after successful admission.
  assert.equal((await runtime.query("SELECT has_table_privilege(current_user,'public.quant_selection_registrations','UPDATE') AS allowed")).rows[0].allowed,false);
}));

test('FE2b runtime queue refusal rolls back exposure-first QR4 composition without orphan job or start',()=>withRuntime(async({fixture:f,service})=>{
  // Synthetic queue saturation only. The full runtime grant script stays unchanged for this refusal path.
  const now=Date.now();
  for(let index=0;index<20;index++){
    const request={fixture:'runtime-grant-queue-capacity',index};
    await f.db.query("INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)",
      [randomUUID(),f.owner,'runtime-quota:'+index,JSON.stringify(request),hash(canonical(request)),now,now+900000]);
  }
  const before=await totals(f);
  assert.deepEqual(before,noStarts);
  await assert.rejects(service.enqueue(f.owner,f.body,'runtime_queuefull_01'),{code:'FOUNDATION_QUEUE_FULL'});
  assert.deepEqual(await totals(f),before);
  const last=(await f.db.query('SELECT status FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq DESC LIMIT 1',[f.body.object_id])).rows[0];
  assert.equal(last.status,'SELECTION_REGISTERED');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM public.quant_foundation_jobs WHERE owner_id=$1 AND status=$2',[f.owner,'QUEUED'])).rows[0].n,20,'preexisting synthetic queue remains unchanged');
}));
