import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {readProfileEnrollmentEvidence} from '../../src/postgres/quant-profile-enrollment-evidence.js';
import {validateProfileEnrollmentReceipt} from '../../src/quant-research/profile-contract-v2.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {createProducerWorld} from '../helpers/quant-profile-preflight-producer-fixture.mjs';

// Local engineering evidence only. Source/deployment/bars and OS telemetry are synthetic.
// Real workers, PROFILE generation, enrollment authority, receipt and Node PF2 replay are product paths.
// Python shim replaces synthetic source enrollment with fixed test signal inputs; no source parity claim.
test('real enrollment producer publishes a receipt usable by PF2 without evaluator admission', {timeout:120000}, async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Assigned isolated PostgreSQL target required');
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  let world;
  t.after(async()=>{try{await world?.dispose();}finally{await admin.close();}});
  world=await createProducerWorld(admin);
  const {db,owner,profileJob,tx,profile,service}=world;
  assert.deepEqual(world.stats(),{builds:0,releases:0,stops:0});
  assert.equal((await db.query('SELECT count(*)::int count FROM quant_profile_enrollment_receipts')).rows[0].count,0);
  assert.equal(profileJob.result,null);
  assert.equal(await world.run(),true);
  assert.deepEqual(world.stats(),{builds:1,releases:1,stops:1});
  const evidence=await readProfileEnrollmentEvidence(db,profileJob.job_id);
  validateProfileEnrollmentReceipt(evidence);
  assert.equal(evidence.job.status,'SUCCEEDED');assert.equal(evidence.job.lease_token,null);
  assert.equal(evidence.job.worker_id,null);assert.equal(evidence.launch.state,'STOP_PROVEN');
  assert.equal(evidence.ledger.state.operations[0].status,'SETTLED');
  assert.equal(evidence.job.result.evaluator_admission,false);
  assert.deepEqual(await readProfileEnrollmentEvidence(db,profileJob.job_id),evidence);
  const exposed=await tx(()=>profile.get(owner,profileJob.job_id));
  assert.equal(exposed.status,'SUCCEEDED');assert.equal(exposed.evaluator_admission,false);
  assert.deepEqual(await tx(()=>profile.enqueueEnrollment(owner,world.body,world.key)),exposed);
  await assert.rejects(db.transaction(()=>db.query('UPDATE quant_profile_enrollment_receipts SET completed_at=completed_at+1 WHERE job_id=$1',[profileJob.job_id])));
  const boundary=evidence.job.contract.dataset.metadata.end_time+60000;
  await tx(()=>service.registerHoldoutBoundary(owner,{bot_id:owner,holdout_start_time:boundary+60000}));
  const sibling='e4-sibling-'+randomUUID();
  await db.query("INSERT INTO users(id,email,password_hash,created_at,parent_user_id,bot_slot_index) VALUES($1,$2,'synthetic-fixture',$3,$4,2)",
    [sibling,sibling+'@example.test',world.now,owner]);
  await tx(()=>service.registerHoldoutBoundary(owner,{bot_id:sibling,holdout_start_time:boundary}));
  const request={bot_id:owner,deployment_id:world.deploymentId,profile_job_id:profileJob.job_id};
  const key=randomUUID(),queued=await tx(()=>service.enqueue(owner,request,key));
  assert.equal(queued.status,'QUEUED');assert.equal(queued.evaluator_admission,false);
  assert.deepEqual(await tx(()=>service.enqueue(owner,request,key)),queued);
  const job=(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  const binding=(await db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  const resolved=await resolveHistoricalPreflight(JSON.parse(binding.plan_json),service.trusted(job),
    {now:world.now,supportedSourceHash:evidence.job.contract.profile.source_hash});
  assert.equal(resolved.dataset.holdout_start_time,boundary);
  assert.deepEqual(resolved.admission,{development_only:true,evaluator_admission:false,holdout_accessed:false,orders_executed:false,execution_model_parity:'V1_ONLY'});
  assert.equal((await db.query('SELECT count(*)::int count FROM quant_profile_enrollment_receipts')).rows[0].count,1);
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[queued.job_id])).rows[0].status,'QUEUED');
  assert.equal(await world.runPreflight(),true);
  const finished=(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  assert.equal(finished.status,'SUCCEEDED',finished.diagnostic);
  assert.equal(finished.lease_token,null);assert.equal(finished.worker_id,null);
  const terminal=(await db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  assert.equal(terminal.unit_name,null);assert.equal(terminal.unit_token,null);
  assert.deepEqual(finished.result.admission,resolved.admission);
  assert.equal(finished.result.dataset.holdout_start_time,boundary);
  assert.equal(finished.result.run.chunks_executed,Math.ceil(resolved.dataset.total_bars/1000));
  assert.deepEqual(world.replayStats(),{replayLaunches:Math.ceil(resolved.dataset.total_bars/1000),maxReplayActive:1,checkpoints:Math.ceil(resolved.dataset.total_bars/1000)-1});
  assert.equal(world.worker.profileOperations.size,0);assert.equal(world.worker.activeLaunches.size,0);
  assert.deepEqual(await readProfileEnrollmentEvidence(db,profileJob.job_id),evidence);
  const detail=await tx(()=>service.get(owner,queued.job_id));
  assert.equal(detail.envelope.plan_hash,binding.plan_hash);assert.equal(detail.evaluator_admission,false);
  assert.equal((await db.query('SELECT count(*)::int count FROM quant_research_foundation WHERE job_id=$1',[queued.job_id])).rows[0].count,0);

});
