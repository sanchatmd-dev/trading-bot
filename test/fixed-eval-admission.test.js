import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {contextKey} from '../src/comparison/context.js';
import {validateFixedEvalContract,validateFixedEvalRequest} from '../src/quant-research/fixed-eval-contract.js';
import {fixedEvalFixture,fixedEvalSelectionFixture} from './helpers/quant-fixed-eval-fixture.mjs';
import {startEvaluation} from '../src/postgres/selection-store.js';

// Focused application-level tests. Real PostgreSQL guard/grant, exposure and concurrency acceptance is separate.
const key='fixed_fixture_0001';
function changeContext(f,mutate){
 for(const p of f.participants){const freeze=JSON.parse(p.freeze_canonical);mutate(freeze.context);p.context_key=contextKey(freeze.context);p.freeze_canonical=canonical(freeze);p.freeze_hash=hash(p.freeze_canonical);}
 f.comparison.context_key=f.participants[0].context_key;
}

test('fixed admission derives two evaluations and atomically stores the existing foundation trio',async()=>{
 const f=fixedEvalFixture(),result=await f.service.enqueue(f.owner,f.body,key);
 assert.equal(result.status,'QUEUED');assert.equal(result.dataset_sha_verified,false);
 assert.equal(f.state.jobs.length,1);assert.equal(f.state.foundation.length,1);assert.equal(f.state.bindings.length,1);
 const c=validateFixedEvalContract(f.state.jobs[0].contract),request=validateFixedEvalRequest(f.state.foundation[0].contract,c);
 assert.equal(c.parameters.inputs.ema_fast,f.parent.result.selected.parameters.emaFastInput);
 assert.equal(c.parameters.inputs.ema_slow,200);assert.equal(c.dataset.warmup_bars,1006);
 assert.equal(c.dataset.bar_count,1206);assert.equal(request.kind,'BACKTEST');assert.equal(request.budget.max_evaluations,2);
 assert.equal(c.dataset.start_time,f.comparison.start_ms-1006*60000+60000);
 assert.equal(c.dataset.start_time+c.dataset.warmup_bars*60000,f.comparison.start_ms+60000);
 assert.equal(c.dataset.end_time,f.comparison.end_ms);
 assert.equal(c.dataset.end_time-c.dataset.start_time+60000,1206*60000);
 assert.equal(f.state.status.at(-1).status,'EVALUATING');
 assert.equal(f.calls.some(call=>/INSERT.*quant_exposure_register|UPDATE.*(?:users|pine_deployments|orders)/i.test(call.sql)),false);
 assert.equal(JSON.stringify(result).includes('SYNTHETIC'),false);
});

test('same-key repeat and concurrent application calls return one persisted run',async()=>{
 const f=fixedEvalFixture();
 const [a,b]=await Promise.all([f.service.enqueue(f.owner,f.body,key),f.service.enqueue(f.owner,f.body,key)]);
 assert.equal(a.run_id,b.run_id);assert.equal(f.state.jobs.length,1);
 const replay=await f.service.enqueue(f.owner,f.body,key);assert.equal(replay.run_id,a.run_id);
 await assert.rejects(f.service.enqueue(f.owner,{...f.body,participant_id:'fixture-parent-2'},key),{code:'IDEMPOTENCY_CONFLICT'});
 await assert.rejects(f.service.enqueue(f.owner,f.body,'another_fixture_key'),{code:'FIXED_EVAL_ALREADY_STARTED'});
});

test('serialization restarts all resolution and rolls back uncommitted jobs',async()=>{
 const f=fixedEvalFixture();f.state.serialFailures=1;
 await f.service.enqueue(f.owner,f.body,key);
 assert.equal(f.state.jobs.length,1);assert.equal(f.state.foundation.length,1);assert.equal(f.state.bindings.length,1);
 assert.equal(f.calls.filter(call=>call.sql.includes('FROM pine_market_bars')).length,2);
});

test('full queue and missing immutable guards write no job or object transition',async()=>{
 for(const alter of [f=>{f.state.queue.total=100;},f=>{f.state.queue.owned=20;},f=>{f.state.guards=5;}]){
  const f=fixedEvalFixture();alter(f);
  await assert.rejects(f.service.enqueue(f.owner,f.body,key));
  assert.equal(f.state.jobs.length,0);assert.equal(f.state.foundation.length,0);assert.equal(f.state.status.length,1);
 }
});

test('caller parameters, policies, contracts and search fields are never admitted',async()=>{
 for(const extra of [{parameters:{}},{policy:{}},{contract:{}},{seed:1},{nested:{search:1}}]){
  const f=fixedEvalFixture();await assert.rejects(f.service.enqueue(f.owner,{...f.body,...extra},key));assert.equal(f.calls.length,0);
 }
});

test('foreign owner, revoked permission, stale source and evaluation parent fail closed',async()=>{
 for(const alter of [f=>{f.owner='foreign-owner';},f=>{f.state.deny=true;},f=>{f.c.source+='changed';},f=>{f.parent.contract.mode='FIXED_INPUT_EVAL';},f=>{f.parent.status='RUNNING';}]){
  const f=fixedEvalFixture();alter(f);await assert.rejects(f.service.enqueue(f.owner,f.body,key));assert.equal(f.state.jobs.length,0);
 }
});

test('frozen comparison without a declared context remains non-executable',async()=>{
 const f=fixedEvalFixture();const freeze=JSON.parse(f.participants[0].freeze_canonical);delete freeze.context;
 f.participants[0].freeze_canonical=canonical(freeze);f.participants[0].freeze_hash=hash(f.participants[0].freeze_canonical);
 await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_AUTHORITY_UNAVAILABLE'});assert.equal(f.state.jobs.length,0);
});

test('self-consistent frozen hashes do not authorize changed execution, policy or validation semantics',async()=>{
 for(const mutate of [c=>{c.execution.fill_model='close-adverse-v1';},c=>{c.execution.exit_semantics_version='reduce-only-exit-v3';},
  c=>{c.risk_policy=hash('different policy');},c=>{c.validation_protocol=hash('different rules');},c=>{c.dataset.timestamp_semantics='bar-open-utc-ms';},
  c=>{c.valuation.end_treatment='LIQUIDATE_AT_END';},c=>{c.capital.initial_cash='1001';},c=>{c.engine=hash('other engine');}]){
  const f=fixedEvalFixture();changeContext(f,mutate);await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_CONTEXT_MISMATCH'});assert.equal(f.state.jobs.length,0);
 }
});

test('parent report must still match immutable completed checkpoints',async()=>{
 const f=fixedEvalFixture();f.parent.result.selected.parameters.emaFastInput=31;
 await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_PARENT_RESULT_INVALID'});assert.equal(f.state.jobs.length,0);
});

test('dataset SHA is a worker obligation and never compared with the content digest',async()=>{
 const f=fixedEvalFixture();
 const resolved=await f.db.transaction(()=>f.service.resolve(f.db,f.owner,f.body));
 assert.equal(resolved.expectedDatasetHash,f.context.dataset.digest);
 assert.notEqual(resolved.expectedDatasetHash,resolved.contract.dataset.content_digest);
 changeContext(f,c=>{c.dataset.digest_kind='pine-bar-content-digest-v1';});
 await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_AUTHORITY_UNAVAILABLE'});
});

test('a frozen OPEN-time dataset cannot masquerade as the adopted CLOSED-time dataset',async()=>{
 const f=fixedEvalFixture();changeContext(f,c=>{c.dataset.first_bar-=60000;c.dataset.last_bar-=60000;});
 await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_CONTEXT_MISMATCH'});assert.equal(f.state.jobs.length,0);
});

test('status reader hides result/source bytes before completion',async()=>{
 const f=fixedEvalFixture(),job=await f.service.enqueue(f.owner,f.body,key),read=await f.service.read(f.owner,job.run_id);
 assert.equal(read.run_id,job.run_id);assert.equal(Object.hasOwn(read,'result'),false);assert.equal(Object.hasOwn(read,'contract'),false);
});

test('QR4 first start takes exposure lock first and binds the queued job in the same transaction',async()=>{
 const f=fixedEvalSelectionFixture(),result=await f.service.enqueue(f.owner,f.body,key);
 assert.equal(result.ok,true);assert.equal(result.first,true);assert.equal(f.state.jobs.length,1);assert.equal(f.state.starts.length,1);assert.equal(f.state.exposures.length,1);
 assert.equal(f.state.starts[0].evaluation_run_id,f.state.jobs[0].run_id);
 assert.equal(f.state.starts[0].dataset_hash,f.freeze.dataset_hash);
 assert.notEqual(f.freeze.dataset_hash,f.state.jobs[0].contract.dataset.content_digest);
 const lock=f.calls.findIndex(call=>call.sql.startsWith('LOCK TABLE public.quant_exposure_register'));
 const scheduler=f.calls.findIndex(call=>call.sql.includes('quant_foundation_scheduler'));
 assert.ok(lock>=0&&scheduler>lock);
 assert.equal(f.state.exposures[0].start_ms,f.registration.window.start_ms);assert.equal(f.state.exposures[0].end_ms,f.registration.window.end_ms);
 assert.equal(f.state.jobs[0].contract.dataset.start_time+1006*60000,f.registration.window.start_ms+60000);
});

test('QR4 first admission refusal rolls back exposure, start, status and the foundation trio',async()=>{
 const f=fixedEvalSelectionFixture();f.state.queue.total=100;
 await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FOUNDATION_QUEUE_FULL'});
 assert.equal(f.state.jobs.length,0);assert.equal(f.state.foundation.length,0);assert.equal(f.state.bindings.length,0);
 assert.equal(f.state.starts.length,0);assert.equal(f.state.exposures.length,0);assert.equal(f.state.selectionStatus.at(-1).status,'SELECTION_REGISTERED');
});

test('QR4 key replay rechecks authority and durable start without appending exposure',async()=>{
 const f=fixedEvalSelectionFixture(),first=await f.service.enqueue(f.owner,f.body,key),replay=await f.service.enqueue(f.owner,f.body,key);
 assert.equal(first.evaluation_run_id,replay.evaluation_run_id);assert.equal(f.state.jobs.length,1);assert.equal(f.state.exposures.length,1);assert.equal(f.state.starts.length,1);
 f.state.deny=true;await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'NOT_FOUND'});
 assert.equal(f.state.jobs.length,1);assert.equal(f.state.exposures.length,1);
});

test('QR4 changed package result hash cannot supply a parent authority',async()=>{
 const f=fixedEvalSelectionFixture(),x=f.exports.find(x=>x.export_id===f.body.participant_id);
 x.binding.library_record_ref.result_sha256=hash('changed report');x.binding_hash=hash(canonical(x.binding));
 await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_AUTHORITY_INVALID'});
 assert.equal(f.state.jobs.length,0);assert.equal(f.state.exposures.length,0);
});

test('QR4 requires the full library cost model including its frozen risk percent',async()=>{
 for(const mutate of [s=>{delete s.cost_model.risk_percent;},s=>{s.cost_model.risk_percent='2';}]){
  const f=fixedEvalSelectionFixture();mutate(f.registration.scope);
  // Rehashing the declaration cannot authorize a scope that differs from the immutable parent model.
  const {registrationBody,registrationHashOf}=await import('../src/selection/hash.js');
  f.row.body_canonical=canonical(registrationBody(f.registration));f.row.registration_hash=registrationHashOf(f.registration);
  await assert.rejects(f.service.enqueue(f.owner,f.body,key),{code:'FIXED_EVAL_CONTEXT_MISMATCH'});
  assert.equal(f.state.jobs.length,0);assert.equal(f.state.exposures.length,0);
 }
});

test('selection writer refuses an admission callback without the trusted internal option',async()=>{
 const f=fixedEvalSelectionFixture();
 const result=await startEvaluation(f.db,{owner_id:f.owner,selection_id:f.body.object_id,export_id:f.body.participant_id,evaluation_run_id:'fixture-run',admitEvaluation:()=>{throw Error('must not run');}});
 assert.equal(result.ok,false);assert.equal(result.detail,'ADMISSION');assert.equal(f.calls.length,0);
});
