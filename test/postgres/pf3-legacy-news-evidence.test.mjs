import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {ReadinessService} from '../../src/postgres/pf3-readiness-service.js';
import {resolveHistoricalPreflight,pf2ExecutableHashes,PF2_ENGINE_FILES} from '../../src/quant-research/preflight-resolver.js';
import {trustedSources} from '../../src/postgres/quant-preflight.js';
import {config} from '../../src/config.js';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createHarness,createWorld,createAccounts,fixtureEnvelope} from '../helpers/preflight-pg-fixture.mjs';
import {insertBridgeEvidence,withResult} from '../helpers/pf3-envelope-fixture.js';

// PF-3 clause C5b (V-carry R3 F04-04): evidence recorded under the older news rule can never reach READY_TO_START_PAPER on
// the real path. 'Missing news risk data' was a rejection of the older Risk evaluator; risk_evaluator.py is one of the
// PF2_ENGINE_FILES, so the engine hash changed with the news-window redesign. Old evidence is therefore bound to another
// engine hash than the live one, engine_current is false and the report names HISTORICAL_ENGINE_CHANGED (CAPABILITY).
// The report never turns that stale evidence into readiness and never into a configuration failure either.
// In process on isolated local PostgreSQL: the real PF-2 services, the real executable hashing (pf2ExecutableHashes over the
// real file list) and the real ReadinessService. Only the bytes of one engine file differ between the "older" and the live
// engine. Rows are labeled test fixtures (see preflight-pg-fixture.mjs).
const ENGINE_FILE='quant_lab/src/robot_quant/risk_evaluator.py';
const OLDER_RULE_MARK='\n# older engine: Missing news risk data rejects an entry\n';
// Reads every engine file as it is on disk, except risk_evaluator.py, which is served as the older version.
const olderEngineRead=async(location,...rest)=>{
  const bytes=await fs.readFile(location,...rest);
  return new URL(location).pathname.endsWith('/'+ENGINE_FILE)?Buffer.concat([bytes,Buffer.from(OLDER_RULE_MARK)]):bytes;
};
const olderHashes=()=>pf2ExecutableHashes({readFile:olderEngineRead});
const liveHashes=()=>pf2ExecutableHashes();

// The entries the older engine rejected for missing news data, next to healthy activity (6 closed episodes).
const LEGACY_NEWS={intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
  rejected_by_reason:{'Missing news risk data':2}};

let admin,base;
const disposables=[];
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  base=await createPf2Base({after:dispose=>disposables.push(dispose)});
});
after(async()=>{
  for(const dispose of disposables.reverse())await dispose();
  await admin?.close();
});

/** A staged world whose PF-2 job is planned and resolved by an engine with `executableHashes` and `readFile`. */
async function stage({executableHashes,readFile}){
  // With a custom readFile the whole older world must be consistent: the plan (engine and evaluator), the enrollment
  // evidence and the capacity policy scope all carry the older executable hashes, as they did when the evidence was made.
  // Otherwise the resolver refuses with PF2_EVALUATOR_HASH_MISMATCH before any evidence exists.
  let capacityPolicy;
  const older=readFile?await executableHashes():null;
  if(older){
    capacityPolicy=structuredClone(base.defaultScenario.enrollment.capacity_policy);
    capacityPolicy.scope.evaluator_hash=older.evaluator_hash;
  }
  const harness=await createHarness({admin,base,executableHashes,capacityPolicy});
  disposables.push(()=>harness.dispose());
  let worldOptions={risk:{blockDuringNews:false}};
  if(older){
    const accounts=await createAccounts(harness.db);
    worldOptions={...worldOptions,accounts,edits:{
      plan:plan=>{plan.foundation.engine_hash=older.engine_hash;plan.snapshot.signal.evaluator_hash=older.evaluator_hash;},
      enrollmentOptions:{owner:accounts.owner,bot:accounts.bot,evaluatorHash:older.evaluator_hash}}};
  }
  const world=await createWorld(harness,worldOptions);
  await harness.db.query("UPDATE users SET role='ADMIN' WHERE id=$1",[world.owner]);
  await insertBridgeEvidence(harness.db,world.deploymentId);
  const queued=await harness.tx(()=>harness.service.enqueue(world.owner,world.request,'fixture-key-'+randomUUID()));
  const bound=(await harness.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  const sources=trustedSources({db:harness.db,pine:harness.pine,job_id:bound.job_id,owner_id:world.owner,bot_id:world.bot,
    capacityPolicy:harness.capacityPolicy,stores:harness.stores});
  const resolved=await resolveHistoricalPreflight(JSON.parse(bound.plan_json),sources,
    {now:world.now,supportedSourceHash:world.supportedSourceHash,...(readFile?{readFile}:{})});
  const envelope=withResult(fixtureEnvelope({resolved,planHash:bound.plan_hash}),LEGACY_NEWS,{deploymentId:world.deploymentId});
  await harness.db.query("UPDATE quant_foundation_jobs SET status='SUCCEEDED',result=$2 WHERE job_id=$1",[bound.job_id,JSON.stringify(envelope)]);
  return {harness,world,jobId:bound.job_id,envelope};
}
/** The readiness service over the PF-2 service of `harness` with the live engine of `executableHashes`. */
const readinessWith=(harness,executableHashes)=>new ReadinessService({store:harness.store,defaultRisk:config.defaultRisk,
  preflightService:harness.serviceWith({executableHashes}),preflightEnabled:true,pineBridgeEnabled:true});

test('the engine files that bind PF-2 evidence include risk_evaluator.py; the older rule changes the engine hash',async()=>{
  assert.ok(PF2_ENGINE_FILES.includes(ENGINE_FILE),'risk_evaluator.py is part of the PF-2 engine identity');
  const older=await olderHashes(),live=await liveHashes();
  assert.notEqual(older.engine_hash,live.engine_hash,'another risk_evaluator.py is another engine hash');
  assert.notEqual(older.evaluator_hash,live.evaluator_hash,'the evaluator closure contains the same file');
});

test('legacy news-rule evidence bound to an older engine hash is never READY: HISTORICAL_ENGINE_CHANGED, source HISTORICAL, nothing converted',async()=>{
  const staged=await stage({executableHashes:olderHashes,readFile:olderEngineRead}),{harness,world,jobId}=staged;
  const live=await liveHashes();
  assert.notEqual(staged.envelope.binding.engine_hash,live.engine_hash,'the evidence is bound to the older engine');
  const report=await readinessWith(harness,liveHashes).report(world.owner,world.bot);
  // Never READY; the one decisive blocker is the engine change, a CAPABILITY blocker that belongs to the evidence.
  assert.notEqual(report.verdict,'READY_TO_START_PAPER');
  assert.equal(report.verdict,'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(report.verdict_basis,['HISTORICAL_ENGINE_CHANGED']);
  assert.deepEqual(report.blockers,[{code:'HISTORICAL_ENGINE_CHANGED',category:'CAPABILITY',source:'HISTORICAL',detail:null}]);
  // Provenance: the evidence is named, and only the engine is stale (policy, capital and deployment are current).
  const evidence=report.historical.evidence;
  assert.equal(report.historical.status,'AVAILABLE');assert.equal(report.historical.unavailable_code,null);
  assert.deepEqual([evidence.job_id,evidence.deployment_id],[jobId,world.deploymentId]);
  assert.deepEqual([evidence.engine_current,evidence.policy_current,evidence.capital_current,evidence.deployment_current],[false,true,true,true]);
  // The old rejection stays visible and classified as a policy skip of the older engine: it is not a configuration failure.
  const news=report.historical.rejections.items.find(item=>item.reason==='Missing news risk data');
  assert.deepEqual([news.code,news.category,news.count],['LEGACY_NEWS_DATA_MISSING','EXPECTED_POLICY_SKIP',2]);
  assert.equal(report.blockers.some(item=>item.category==='CONFIGURATION'||/NEWS/.test(item.code)),false);
  assert.ok(!report.verdict_basis.includes('HISTORICAL_CONFIGURATION_REJECTIONS'));
  // The same stored job under the same older engine is current: only the live engine decides, the data is valid.
  const sameEngine=await readinessWith(harness,olderHashes).report(world.owner,world.bot);
  assert.equal(sameEngine.historical.evidence.engine_current,true);
});

test('control: evidence bound to the current engine hash is accepted and READY; the retired news reason blocks nothing',async()=>{
  const staged=await stage({executableHashes:liveHashes}),{harness,world,jobId}=staged;
  assert.equal(staged.envelope.binding.engine_hash,(await liveHashes()).engine_hash);
  const report=await readinessWith(harness,liveHashes).report(world.owner,world.bot);
  assert.equal(report.verdict,'READY_TO_START_PAPER',JSON.stringify(report.blockers));
  assert.deepEqual(report.verdict_basis,[]);assert.deepEqual(report.blockers,[]);
  const evidence=report.historical.evidence;
  assert.deepEqual([evidence.job_id,evidence.deployment_id],[jobId,world.deploymentId]);
  assert.deepEqual([evidence.engine_current,evidence.policy_current,evidence.capital_current,evidence.deployment_current],[true,true,true,true]);
  const news=report.historical.rejections.items.find(item=>item.reason==='Missing news risk data');
  assert.deepEqual([news.code,news.category,news.count],['LEGACY_NEWS_DATA_MISSING','EXPECTED_POLICY_SKIP',2]);
  // The same job turns stale the moment the live engine is another one: the engine hash alone decides.
  const changed=await readinessWith(harness,olderHashes).report(world.owner,world.bot);
  assert.equal(changed.verdict,'CAPABILITY_UNAVAILABLE');assert.deepEqual(changed.verdict_basis,['HISTORICAL_ENGINE_CHANGED']);
  assert.equal(changed.historical.evidence.engine_current,false);
});
