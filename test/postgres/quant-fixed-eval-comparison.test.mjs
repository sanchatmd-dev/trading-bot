import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {createComparison,readComparison} from '../../src/postgres/comparison-store.js';
import {contextFields,contextKey,CONTEXT_FIELDS} from '../../src/comparison/context.js';
import {validateSpec,specHashOf} from '../../src/comparison/ranking.js';
import {fixedEvalArtifactSha,fixedEvalComparisonProtocolHash} from '../../src/postgres/quant-fixed-eval.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

// Real PostgreSQL immutable parents, createComparison/exposure guards and fixed-evaluation admission. No Python or worker runs.
// The fixture pins the actual engine closure; this file establishes transaction/context evidence, not evaluator execution.
const MINUTE=60000;
let f,comparison,input,body,job,parentsBefore;
const serial=work=>f.db.transaction(work,{isolation:'SERIALIZABLE'});
const parentRows=async()=>(await f.db.query('SELECT run_id,status,contract_hash,contract,result,updated_at FROM public.quant_jobs WHERE run_id=ANY($1::text[]) ORDER BY run_id',[f.state.parents.map(row=>row.run_id)])).rows;
const jobRows=async()=>(await f.db.query("SELECT j.run_id,j.status,j.contract,j.contract_hash,f.status AS foundation_status,f.attempts FROM public.quant_jobs j JOIN public.quant_research_foundation b USING(run_id) JOIN public.quant_foundation_jobs f ON f.job_id=b.job_id WHERE j.contract->>'mode'='FIXED_INPUT_EVAL' ORDER BY j.run_id")).rows;

function comparisonInput({sparse=false}={}){
  const checked=validateSpec({mode:'STANDARDIZED',participants:f.state.parents.map(row=>row.run_id),
    period:{start_ms:f.registration.window.start_ms,end_ms:f.registration.window.end_ms},objective:'qr3-obj-net-return-v1',
    risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},
    benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}});
  assert.equal(checked.ok,true);
  const spec=checked.spec,context=structuredClone(f.context);
  context.spec_hash=specHashOf(spec);
  context.validation_protocol=fixedEvalComparisonProtocolHash(f.c,spec);
  // Selection's real frozen dataset SHA names the same stored bars, including warm-up. It is NOT the market content digest.
  context.dataset.digest=f.freeze.dataset_hash;
  const normalized=contextFields(f.parent.run_id,context);
  assert.deepEqual(normalized.missing,[]);
  assert.deepEqual(Object.keys(normalized.fields),CONTEXT_FIELDS);
  const key=contextKey(normalized.fields);
  return {owner_id:f.owner,comparison_id:randomUUID(),fixture:true,market:f.c.snapshot.market,spec,spec_hash:specHashOf(spec),context_key:key,request_key:'qr3-separation-'+randomUUID(),
    participants:f.state.parents.map((row,index)=>({participant_id:row.run_id,position:index+1,source_hash:f.c.source_hash,origin:'FIXTURE',fixture:true,context_key:key,
      freeze:sparse?{}:{context:structuredClone(normalized.fields)}}))};
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL only');
  f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
  parentsBefore=await parentRows();
  input=comparisonInput();
  comparison=await createComparison(f.db,input);
  assert.equal(comparison.ok,true,JSON.stringify(comparison));
  body={purpose:'QR3_COMPARISON',object_id:comparison.comparison_id,participant_id:f.parent.run_id};
});
after(async()=>{await f?.close();});

test('QR3 genuine freeze: C1-C16 context, actual stored dataset SHA, two guarded exposure rows and idempotent store create',async()=>{
  const read=await readComparison(f.db,{owner_id:f.owner,comparison_id:comparison.comparison_id});
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.status.status,'SPEC_FROZEN');
  assert.equal(typeof read.comparison.frozen_at_ms,'number');
  assert.equal(read.participants.length,2);
  for(const participant of read.participants){
    assert.equal(participant.freeze.context.dataset.digest,f.freeze.dataset_hash);
    const normalized=contextFields(participant.participant_id,participant.freeze.context);
    assert.deepEqual(normalized.missing,[]);assert.equal(contextKey(normalized.fields),read.comparison.context_key);
    assert.equal(hash(canonical(participant.freeze)),participant.freeze_hash);
  }
  const exposures=(await f.db.query('SELECT start_ms,end_ms,participant_run_id,kind FROM public.quant_exposure_register WHERE comparison_id=$1 ORDER BY participant_run_id',[comparison.comparison_id])).rows;
  assert.equal(exposures.length,2);
  for(const row of exposures){
    assert.equal(row.kind,'QR3_COMPARISON');assert.equal(typeof row.start_ms,'number');assert.equal(row.start_ms,input.spec.period.start_ms);assert.equal(row.end_ms,input.spec.period.end_ms);
  }
  const repeat=await createComparison(f.db,input);
  assert.equal(repeat.ok,true);assert.equal(repeat.existing,true);assert.equal(repeat.comparison_id,comparison.comparison_id);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.quant_exposure_register WHERE comparison_id=$1',[comparison.comparison_id])).rows[0].n,2);
  assert.deepEqual(await parentRows(),parentsBefore);
});

test('QR3 fixed admission: one job/binding on repeat, OPEN windows convert to CLOSED evaluation timestamps with exact counts',async()=>{
  const key='pg_qr3_fixed_admission_01';
  const first=await f.service.enqueue(f.owner,body,key),repeat=await f.service.enqueue(f.owner,body,key);
  assert.equal(first.ok,true);assert.equal(repeat.run_id,first.run_id);
  job=first.run_id;
  const jobs=await jobRows();assert.equal(jobs.length,1);
  const row=jobs[0],c=row.contract,w=input.spec.period;
  assert.equal(c.mode,'FIXED_INPUT_EVAL');assert.equal(c.purpose,'QR3_COMPARISON');assert.equal(c.lineage.object_id,comparison.comparison_id);assert.equal(c.lineage.parent_run_id,f.parent.run_id);
  assert.equal(c.dataset.start_time,w.start_ms-1006*MINUTE+MINUTE);
  assert.equal(c.dataset.end_time,w.end_ms);assert.equal(c.dataset.warmup_bars,1006);
  assert.equal(1+(c.dataset.end_time-c.dataset.start_time)/MINUTE,1206);
  assert.equal((w.end_ms-w.start_ms)/MINUTE,200);
  assert.notEqual(c.dataset.content_digest,f.freeze.dataset_hash,'content digest is not the frozen dataset file SHA');
  assert.equal(row.status,'QUEUED');assert.equal(row.foundation_status,'QUEUED');assert.equal(Number(row.attempts),0);
  const authorized=await serial(()=>f.service.authorize(f.owner,body,'CLAIM',{run_id:job}));
  assert.equal(authorized.expectedDatasetHash,f.freeze.dataset_hash);
  assert.equal(await fixedEvalArtifactSha(f.db,f.owner,c,job),f.freeze.dataset_hash);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.quant_research_foundation WHERE run_id=$1',[job])).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM public.quant_selection_evaluation_starts WHERE selection_id=$1',[f.body.object_id])).rows[0].n,0,'QR4 fixture remains unstarted');
  assert.equal((await readComparison(f.db,{owner_id:f.owner,comparison_id:comparison.comparison_id})).status.status,'EVALUATING');
  assert.deepEqual(await parentRows(),parentsBefore);
});

test('QR3 sparse historical participant freezes stay readable but refuse fixed admission with no new job',async()=>{
  const sparse=comparisonInput({sparse:true}),created=await createComparison(f.db,sparse);
  assert.equal(created.ok,true,JSON.stringify(created));
  const read=await readComparison(f.db,{owner_id:f.owner,comparison_id:created.comparison_id});
  assert.equal(read.ok,true);assert.equal(read.status.status,'SPEC_FROZEN');
  assert.equal(read.participants.every(row=>row.freeze.context===undefined),true);
  const before=await jobRows();
  await assert.rejects(f.service.enqueue(f.owner,{...body,object_id:created.comparison_id},'pg_qr3_sparse_context_01'),{code:'FIXED_EVAL_AUTHORITY_UNAVAILABLE'});
  assert.deepEqual(await jobRows(),before);
  assert.equal((await readComparison(f.db,{owner_id:f.owner,comparison_id:created.comparison_id})).status.status,'SPEC_FROZEN');
  assert.deepEqual(await parentRows(),parentsBefore);
});

test('QR3 cancelled comparison refuses fresh CLAIM authorization and preserves queued fixed job and immutable research parents',async()=>{
  assert.ok(job);
  const before=await jobRows();
  await serial(async()=>{
    const event=(await f.db.query('SELECT seq FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq DESC LIMIT 1',[comparison.comparison_id])).rows[0];
    await f.db.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,$2,'CANCELLED')",[comparison.comparison_id,Number(event.seq)+1]);
  });
  await assert.rejects(serial(()=>f.service.authorize(f.owner,body,'CLAIM',{run_id:job})),{code:'FIXED_EVAL_OBJECT_NOT_EVALUATING'});
  assert.equal(await fixedEvalArtifactSha(f.db,f.owner,before.find(row=>row.run_id===job).contract,job),f.freeze.dataset_hash,'immutable historical SHA does not depend on current comparison status');
  assert.deepEqual(await jobRows(),before,'authorization refusal itself does not terminalize parent or unit lifecycle');
  assert.deepEqual(await parentRows(),parentsBefore);
  assert.equal((await readComparison(f.db,{owner_id:f.owner,comparison_id:comparison.comparison_id})).status.status,'CANCELLED');
});
