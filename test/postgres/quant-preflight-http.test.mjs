import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp} from 'node:fs/promises';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createWorld,fixtureEnvelope} from '../helpers/preflight-pg-fixture.mjs';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {trustedSources} from '../../src/postgres/quant-preflight.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {config} from '../../src/config.js';

// Actual application HTTP. Enabled cases use only the labeled test policy loader;
// they do not certify native Linux startup, private source parity or enrollment.
const preflights='/api/quant/data/preflights',boundaries='/api/quant/data/holdout-boundaries';
const enrollments='/api/quant/data/profile-enrollments',minute=60000;
async function fixture(t,options){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,options);t.after(()=>f.close());return f;
}
function noEstimates(value){
  if(!value||typeof value!=='object')return;
  for(const [key,item] of Object.entries(value)){
    assert.equal(/(^|_)(eta|estimate|estimated)(_|$)/i.test(key),false,'forbidden response key '+key);noEstimates(item);
  }
}
function refusal(answer,status,code){
  assert.equal(answer.status,status,JSON.stringify(answer.body));
  assert.deepEqual(answer.body,{error:code,code});noEstimates(answer.body);
}
const state=async f=>(await f.db.query('SELECT (SELECT count(*)::int FROM quant_holdout_boundaries) boundaries,'+
  '(SELECT count(*)::int FROM quant_preflight_jobs) preflights,(SELECT count(*)::int FROM quant_foundation_jobs) jobs')).rows[0];

test('native actual app: flags default off, authenticated routes refuse, auth remains active, no policy read',async t=>{
  const f=await fixture(t,{mode:'disabled'}),session=await f.login(f.owner),files=await f.listing(),before=await state(f);
  assert.equal((await f.request(preflights+'?bot_id='+f.owner.id)).status,401);
  const id=randomUUID(),body={bot_id:f.owner.id,deployment_id:randomUUID(),profile_job_id:randomUUID()};
  for(const [url,method,input,code] of [
    [preflights+'?bot_id='+f.owner.id,'GET',undefined,'PREFLIGHT_DISABLED'],
    [preflights,'POST',body,'PREFLIGHT_DISABLED'],
    [preflights+'/'+id,'GET',undefined,'PREFLIGHT_DISABLED'],
    [preflights+'/'+id+'/cancel','POST',{},'PREFLIGHT_DISABLED'],
    [boundaries+'?bot_id='+f.owner.id,'GET',undefined,'PREFLIGHT_DISABLED'],
    [boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:60000},'PREFLIGHT_DISABLED'],
    [enrollments,'POST',body,'QUANT_PROFILE_ENROLLMENT_DISABLED'],
  ])refusal(await f.request(url,method,input,session),503,code);
  assert.deepEqual(await state(f),before);assert.deepEqual(await f.listing(),files);
  // The fixture supplies a nonexistent policy filename. Successful native
  // startup proves that disabled registration does not read that file.
});

test('native Windows enabled startup refuses real Linux-only policy loader before listener',
  {skip:process.platform!=='win32'&&'native Windows case: asserts QUANT_CAPACITY_POLICY_LINUX_REQUIRED, which the real policy loader raises only off Linux'},async t=>{
    const f=await fixture(t,{mode:'native-enabled',expectStartupFailure:true});
    assert.equal(f.startup.ready,false);assert.equal(f.startup.exited,true);assert.notEqual(f.startup.exitCode,0);
    assert.match(f.startup.output,/QUANT_CAPACITY_POLICY_LINUX_REQUIRED/);
  });

test('actual app startup refuses requested enrollment without PROFILE v2',async t=>{
  const f=await fixture(t,{mode:'disabled',expectStartupFailure:true,
    environment:{QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'1',QUANT_PROFILE_V2_ENABLED:'0'}});
  assert.equal(f.startup.ready,false);assert.match(f.startup.output,/QUANT_PROFILE_V2_REQUIRED/);
});

test('actual app with test policy loader refuses missing preflight schema before listener',async t=>{
  const f=await fixture(t,{mode:'test-policy',missingPreflightSchema:true,expectStartupFailure:true});
  assert.equal(f.startup.ready,false);assert.match(f.startup.output,/PREFLIGHT_SCHEMA_REQUIRED/);
});

test('actual app with test policy loader refuses missing enrollment extension before listener',async t=>{
  const f=await fixture(t,{mode:'test-policy',missingEnrollmentSchema:true,expectStartupFailure:true});
  assert.equal(f.startup.ready,false);
  assert.match(f.startup.output,/QUANT_PROFILE_ENROLLMENT_SCHEMA_(?:REQUIRED|UNSUPPORTED)/);
});

test('actual app HTTP with test policy loader: query/body validation, absent enrollment, owner scope, no writes',async t=>{
  const f=await fixture(t,{mode:'test-policy'}),session=await f.login(f.owner),files=await f.listing(),before=await state(f);
  const body={bot_id:f.owner.id,deployment_id:randomUUID(),profile_job_id:randomUUID()},key='r6-http-negative-'+randomUUID();
  for(const url of [preflights,boundaries,preflights+'?bot_id='+f.owner.id+'&extra=1',
    preflights+'?bot_id='+f.owner.id+'&bot_id='+f.owner.id])
    refusal(await f.request(url,'GET',undefined,session),400,'INVALID_FIELDS');
  refusal(await f.request(preflights+'?bot_id='+f.foreign.id,'POST',body,session,{'Idempotency-Key':key}),400,'INVALID_FIELDS');
  refusal(await f.request(preflights,'POST',{...body,capacity_policy:f.policy},session,{'Idempotency-Key':key}),400,'INVALID_FIELDS');
  refusal(await f.request(preflights,'POST',body,session),400,'IDEMPOTENCY_KEY_REQUIRED');
  for(let i=0;i<2;i++)refusal(await f.request(preflights,'POST',body,session,{'Idempotency-Key':key}),409,'PREFLIGHT_ENROLLMENT_REQUIRED');
  const foreign=await f.login(f.foreign);
  refusal(await f.request(preflights+'?bot_id='+f.owner.id,'GET',undefined,foreign),404,'NOT_FOUND');
  const id=randomUUID();
  refusal(await f.request(preflights+'/'+id,'GET',undefined,session),404,'NOT_FOUND');
  refusal(await f.request(preflights+'/'+id+'/cancel','POST',{},session),404,'NOT_FOUND');
  refusal(await f.request(enrollments,'POST',body,session),503,'QUANT_PROFILE_ENROLLMENT_DISABLED');
  assert.deepEqual(await state(f),before);assert.deepEqual(await f.listing(),files);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.preflight.enqueued'")).rows[0].n,0);
});

test('actual app HTTP with test policy loader: holdout owner scope, write-once, sibling earliest boundary',async t=>{
  const f=await fixture(t,{mode:'test-policy'}),session=await f.login(f.owner),foreign=await f.login(f.foreign);
  const own=boundaries+'?bot_id='+f.owner.id,time=Math.floor(Date.now()/minute)*minute-500*minute;
  const empty=await f.request(own,'GET',undefined,session);assert.equal(empty.status,200);assert.equal(empty.body.holdout_start_time,null);
  const sibling=await f.request(boundaries,'POST',{bot_id:f.sibling.id,holdout_start_time:time},session);
  assert.equal(sibling.status,200);assert.equal(sibling.body.registered,true);noEstimates(sibling.body);
  refusal(await f.request(boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:time+minute},session),409,'HOLDOUT_BOUNDARY_CONFLICT');
  const first=await f.request(boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:time},session);
  assert.equal(first.status,200);assert.equal(first.body.registered,true);noEstimates(first.body);
  const duplicate=await f.request(boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:time},session);
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.registered,false);
  assert.equal(duplicate.body.created_at,first.body.created_at);
  refusal(await f.request(boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:time-minute},session),409,'HOLDOUT_BOUNDARY_EXISTS');
  refusal(await f.request(own,'GET',undefined,foreign),404,'NOT_FOUND');
  refusal(await f.request(boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:time},foreign),404,'NOT_FOUND');
  const result=await f.request(own,'GET',undefined,session);assert.equal(result.body.holdout_start_time,time);noEstimates(result.body);
  assert.equal((await state(f)).boundaries,2);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.holdout.registered'")).rows[0].n,2);
});

test('actual app HTTP rollback after holdout write hides SQL message and leaves no registration/audit residue',async t=>{
  const f=await fixture(t,{mode:'test-policy'}),session=await f.login(f.owner),time=Math.floor(Date.now()/minute)*minute-500*minute;
  // Isolated database trigger forces an existing audit write to fail after the
  // registry INSERT. Application source and error handling remain unchanged.
  await f.db.query(`CREATE FUNCTION r6_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event='quant.holdout.registered' THEN RAISE EXCEPTION 'R6_SQL_PRIVATE_MARKER_4242'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER r6_fixture_audit_failure BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION r6_fixture_audit_failure();`);
  const answer=await f.request(boundaries,'POST',{bot_id:f.owner.id,holdout_start_time:time},session);
  assert.equal(answer.status,503);assert.deepEqual(answer.body,{error:'Request could not be completed'});
  assert.equal(JSON.stringify(answer.body).includes('R6_SQL_PRIVATE_MARKER_4242'),false);noEstimates(answer.body);
  assert.equal((await state(f)).boundaries,0);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.holdout.registered'")).rows[0].n,0);
  const get=await f.request(boundaries+'?bot_id='+f.owner.id,'GET',undefined,session);
  assert.equal(get.status,200);assert.equal(get.body.holdout_start_time,null);
});

test('actual app positive receipt consumer, idempotency, cancellation and envelope exposure with synthetic evidence',async t=>{
  const base=await createPf2Base(t),scenario=base.defaultScenario;
  const f=await fixture(t,{mode:'test-policy',capacityPolicy:scenario.enrollment.capacity_policy,
    syntheticSourceHash:scenario.supportedSourceHash});
  await cp(base.root,f.root,{recursive:true});
  const world=await createWorld({...f,base},{accounts:{owner:f.owner.id,bot:f.owner.id,bots:[f.owner.id]}});
  const session=await f.login(f.owner),foreign=await f.login(f.foreign),key='r6-positive-'+randomUUID();
  const enqueue=()=>f.request(preflights,'POST',world.request,session,{'Idempotency-Key':key});
  const first=await enqueue();assert.equal(first.status,202,JSON.stringify(first.body));
  assert.equal(first.body.status,'QUEUED');assert.equal(first.body.evaluator_admission,false);noEstimates(first.body);
  const repeated=await enqueue();assert.equal(repeated.status,202);assert.deepEqual(repeated.body,first.body);
  const id=first.body.job_id,url=preflights+'/'+id;
  refusal(await f.request(url,'GET',undefined,foreign),404,'NOT_FOUND');
  refusal(await f.request(url+'/cancel','POST',{},foreign),404,'NOT_FOUND');
  const queued=await f.request(url,'GET',undefined,session);assert.equal(queued.status,200);assert.equal(queued.body.envelope,null);
  const listing=await f.request(preflights+'?bot_id='+world.bot,'GET',undefined,session);
  assert.equal(listing.status,200);assert.equal(listing.body.length,1);assert.equal(listing.body[0].job_id,id);
  const cancelled=await f.request(url+'/cancel','POST',{},session);assert.equal(cancelled.status,200);
  assert.equal(cancelled.body.status,'CANCELLED');assert.equal(cancelled.body.envelope,null);
  const second=await f.request(preflights,'POST',world.request,session,{'Idempotency-Key':key+'-result'});
  assert.equal(second.status,202,JSON.stringify(second.body));
  const job=(await f.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[second.body.job_id])).rows[0];
  const bound=(await f.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[job.job_id])).rows[0];
  const pine=new PineBridgeService(f.store,{defaultRisk:config.defaultRisk});
  const sources=trustedSources({db:f.db,pine,job_id:job.job_id,owner_id:world.owner,bot_id:world.bot,
    capacityPolicy:f.policy,stores:{raw:new DatasetStore({root:f.root}),research:new ResearchDatasetStore({root:f.root})}});
  const resolved=await resolveHistoricalPreflight(JSON.parse(bound.plan_json),sources,
    {now:world.now,supportedSourceHash:world.supportedSourceHash});
  // Explicit synthetic terminal row: verifies HTTP validation/exposure only.
  // E2/E4 separately prove the producer and execution path.
  const envelope=fixtureEnvelope({resolved,planHash:bound.plan_hash});
  await f.db.query("UPDATE quant_foundation_jobs SET status='SUCCEEDED',result=$2 WHERE job_id=$1",
    [job.job_id,JSON.stringify(envelope)]);
  const done=await f.request(preflights+'/'+job.job_id,'GET',undefined,session);
  assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.status,'SUCCEEDED');
  assert.deepEqual(done.body.envelope,envelope);assert.equal(done.body.engine_current,true);noEstimates(done.body);
  assert.equal(done.body.envelope.admission.holdout_accessed,false);
  assert.equal(done.body.envelope.admission.orders_executed,false);
  assert.equal(done.body.envelope.admission.evaluator_admission,false);
  const changed=structuredClone(envelope);changed.admission.evaluator_admission=true;
  await f.db.query('UPDATE quant_foundation_jobs SET result=$2 WHERE job_id=$1',[job.job_id,JSON.stringify(changed)]);
  refusal(await f.request(preflights+'/'+job.job_id,'GET',undefined,session),500,'FOUNDATION_INTEGRITY_FAILED');
});
