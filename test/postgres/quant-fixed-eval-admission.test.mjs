import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {validateFixedEvalRequest} from '../../src/quant-research/fixed-eval-contract.js';

// Every fixture creates and drops only its own database. The runner must supply an isolated TEST_DATABASE_URL.
async function withFixture(work){
 assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
 const f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
 try{return await work(f);}finally{await f.close();}
}
const counts=async f=>(await f.db.query(`SELECT
 (SELECT count(*)::int FROM public.quant_jobs WHERE contract->>'mode'='FIXED_INPUT_EVAL') jobs,
 (SELECT count(*)::int FROM public.quant_foundation_jobs WHERE contract->>'version'='quant-foundation-fixed-eval-v1') foundation,
 (SELECT count(*)::int FROM public.quant_selection_evaluation_starts WHERE selection_id=$1) starts,
 (SELECT count(*)::int FROM public.quant_exposure_register WHERE selection_id=$1::text) exposures`,[f.body.object_id])).rows[0];

test('real PG: concurrent QR4 repeats commit one exposure, start and foundation binding',()=>withFixture(async f=>{
 const key='pg_fixed_duplicate_001';
 const before=(await f.db.query('SELECT count(*)::int n FROM public.pine_deployments')).rows[0].n;
 const [a,b]=await Promise.all([f.service.enqueue(f.owner,f.body,key),f.service.enqueue(f.owner,f.body,key)]);
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.evaluation_run_id,b.evaluation_run_id);
 assert.deepEqual(await counts(f),{jobs:1,foundation:1,starts:1,exposures:1});
 const row=(await f.db.query(`SELECT j.*,f.contract AS request,b.contract_hash AS binding_hash
  FROM public.quant_jobs j JOIN public.quant_research_foundation b USING(run_id)
  JOIN public.quant_foundation_jobs f ON f.job_id=b.job_id WHERE j.run_id=$1`,[a.evaluation_run_id])).rows[0];
 assert.equal(row.contract_hash,hash(canonical(row.contract)));assert.equal(row.binding_hash,row.contract_hash);
 const request=validateFixedEvalRequest(row.request,row.contract);assert.equal(request.kind,'BACKTEST');assert.equal(request.budget.max_evaluations,2);
 assert.equal(row.contract.dataset.start_time+row.contract.dataset.warmup_bars*60000,f.registration.window.start_ms+60000);
 assert.equal(row.contract.dataset.end_time,f.registration.window.end_ms);
 const exposure=(await f.db.query('SELECT start_ms,end_ms FROM public.quant_exposure_register WHERE selection_id=$1',[f.body.object_id])).rows[0];
 assert.equal(typeof exposure.start_ms,'number');assert.equal(exposure.start_ms,f.registration.window.start_ms);assert.equal(exposure.end_ms,f.registration.window.end_ms);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM public.pine_deployments')).rows[0].n,before);
 // These are genuine installed freeze guards, not a mocked verdict.
 await assert.rejects(f.db.query("UPDATE public.quant_jobs SET result='{}' WHERE run_id=$1",[f.parent.run_id]),{code:'QR001'});
 await assert.rejects(f.db.query('UPDATE public.quant_job_steps SET result=$2 WHERE run_id=$1',[f.parent.run_id,'{}']));
}));

test('real PG: first-start queue refusal rolls back the exposure and leaves no orphan job',()=>withFixture(async f=>{
 const now=Date.now();
 for(let index=0;index<20;index++){
  const request={fixture:'queue-capacity',index};
  await f.db.query("INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)",
   [randomUUID(),f.owner,'quota:'+index,JSON.stringify(request),hash(canonical(request)),now,now+900000]);
 }
 await assert.rejects(f.service.enqueue(f.owner,f.body,'pg_fixed_queuefull_01'),{code:'FOUNDATION_QUEUE_FULL'});
 assert.deepEqual(await counts(f),{jobs:0,foundation:0,starts:0,exposures:0});
 const status=(await f.db.query('SELECT status FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq DESC LIMIT 1',[f.body.object_id])).rows[0].status;
 assert.equal(status,'SELECTION_REGISTERED');
}));

test('real PG: missing result-freeze protection refuses admission before any durable start',()=>withFixture(async f=>{
 await f.db.query('ALTER TABLE public.quant_jobs DISABLE TRIGGER quant_job_terminal_freeze');
 try{await assert.rejects(f.service.enqueue(f.owner,f.body,'pg_fixed_no_freeze01'),{code:'FIXED_EVAL_IMMUTABLE_AUTHORITY_REQUIRED'});}
 finally{await f.db.query('ALTER TABLE public.quant_jobs ENABLE ALWAYS TRIGGER quant_job_terminal_freeze');}
 assert.deepEqual(await counts(f),{jobs:0,foundation:0,starts:0,exposures:0});
}));

test('real PG: an owner cannot enqueue a foreign selection',()=>withFixture(async f=>{
 const foreign=await f.store.createUser({email:'foreign-'+randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture-hash'});
 const answer=await f.service.enqueue(foreign.id,f.body,'pg_fixed_foreign_01');
 assert.equal(answer.ok,false);assert.equal(answer.code,'NOT_FOUND');assert.deepEqual(await counts(f),{jobs:0,foundation:0,starts:0,exposures:0});
}));
