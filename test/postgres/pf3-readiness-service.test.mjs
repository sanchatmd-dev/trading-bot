import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantDataService} from '../../src/postgres/quant-data.js';
import {QuantPreflightService,trustedSources} from '../../src/postgres/quant-preflight.js';
import {ReadinessService} from '../../src/postgres/pf3-readiness-service.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {config} from '../../src/config.js';
import {createPf2Base} from '../helpers/pf2-fixture.js';
import {createHarness,createWorld,fixtureEnvelope} from '../helpers/preflight-pg-fixture.mjs';
import {HEALTHY,insertBridgeEvidence,withResult} from '../helpers/pf3-envelope-fixture.js';

// PF-3 readiness service over the PF-2 services on isolated local PostgreSQL, in process (no HTTP): every statement of the
// report, including the PF-2 reads, is recorded. Rows are labeled test fixtures (see preflight-pg-fixture.mjs).
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

async function stagedHarness(){
  const harness=await createHarness({admin,base});
  disposables.push(()=>harness.dispose());
  const world=await createWorld(harness,{risk:{blockDuringNews:false}});
  await harness.db.query("UPDATE users SET role='ADMIN' WHERE id=$1",[world.owner]);
  await insertBridgeEvidence(harness.db,world.deploymentId);
  return {harness,world};
}
/** One PF-2 job for the world, enqueued by the real service and finished with a labeled synthetic envelope. */
async function succeed({harness,world},spec){
  const queued=await harness.tx(()=>harness.service.enqueue(world.owner,world.request,'fixture-key-'+randomUUID()));
  const bound=(await harness.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[queued.job_id])).rows[0];
  const sources=trustedSources({db:harness.db,pine:harness.pine,job_id:bound.job_id,owner_id:world.owner,bot_id:world.bot,
    capacityPolicy:harness.capacityPolicy,stores:harness.stores});
  const resolved=await resolveHistoricalPreflight(JSON.parse(bound.plan_json),sources,{now:world.now,supportedSourceHash:world.supportedSourceHash});
  const envelope=withResult(fixtureEnvelope({resolved,planHash:bound.plan_hash}),spec,{deploymentId:world.deploymentId});
  await harness.db.query("UPDATE quant_foundation_jobs SET status='SUCCEEDED',result=$2 WHERE job_id=$1",[bound.job_id,JSON.stringify(envelope)]);
  return {jobId:bound.job_id,envelope};
}
/** The whole read stack over a recording database handle: store, Bridge, data and PF-2 services. */
function recordingStack(harness,statements){
  const recorded=new Proxy(harness.db,{get(target,prop,receiver){
    if(prop==='query')return (sql,params)=>{statements.push(String(sql));return target.query(sql,params);};
    const value=Reflect.get(target,prop,receiver);return typeof value==='function'?value.bind(receiver):value;}});
  const store=new Store(recorded);
  const pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  const data=new QuantDataService({pineService:pine,datasetStore:harness.stores.raw,clock:()=>Date.now(),enabled:true});
  const preflight=new QuantPreflightService({...harness.options,pineService:pine,dataService:data});
  return new ReadinessService({store,defaultRisk:config.defaultRisk,preflightService:preflight,preflightEnabled:true,pineBridgeEnabled:true});
}

test('the PF-2 evidence path issues SET TRANSACTION READ ONLY first and SELECT statements only, and reads the bot scoped rows',async()=>{
  const staged=await stagedHarness(),{harness,world}=staged;
  const job=await succeed(staged,HEALTHY);
  const statements=[],service=recordingStack(harness,statements);
  const report=await service.report(world.owner,world.bot);
  assert.equal(report.verdict,'READY_TO_START_PAPER',JSON.stringify(report.blockers));
  assert.equal(report.historical.evidence.job_id,job.jobId);assert.equal(report.bot_id,world.bot);
  assert.ok(statements.length>25,'the PF-2 reads are part of the record: '+statements.length);
  assert.match(statements[0],/^\s*SET TRANSACTION READ ONLY\s*$/);
  for(const sql of statements.slice(1)){
    assert.match(sql,/^\s*(SELECT|WITH)\b/i,sql.slice(0,90));
    assert.doesNotMatch(sql,/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i,'a row lock: '+sql.slice(0,90));
    assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|MERGE|LOCK\s+TABLE|TRUNCATE|CREATE|ALTER|DROP|NEXTVAL|PG_ADVISORY\w*)\b/i,'a write or lock: '+sql.slice(0,90));
  }
  assert.ok(statements.some(sql=>/quant_preflight_jobs/.test(sql)),'the stored plan row is read');
  assert.ok(statements.some(sql=>/pine_deployments/.test(sql))&&statements.some(sql=>/pine_bridge_evidence/.test(sql)));
});

test('a PF-2 refusal becomes a coded historical status, a database error is never swallowed',async()=>{
  const staged=await stagedHarness(),{harness,world}=staged;
  await succeed(staged,HEALTHY);
  const statements=[],service=recordingStack(harness,statements);
  // PF-2 off in the service: the PF-2 tables are not read at all.
  const off=new ReadinessService({store:service.store,defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true});
  const offReport=await off.report(world.owner,world.bot);
  assert.equal(offReport.historical.unavailable_code,'PF2_DISABLED');
  assert.ok(!statements.some(sql=>/quant_preflight_jobs|quant_foundation_jobs/.test(sql)),'PF-2 tables untouched while PF-2 is off');
  // A PF-2 service that throws a coded error (disabled by configuration) is reported, not thrown.
  const refusing={list:async()=>{throw Object.assign(new Error('PREFLIGHT_DISABLED'),{code:'PREFLIGHT_DISABLED',status:503});},get:async()=>{throw new Error('unused');}};
  const coded=await new ReadinessService({store:service.store,defaultRisk:config.defaultRisk,preflightService:refusing,preflightEnabled:true,pineBridgeEnabled:true}).report(world.owner,world.bot);
  assert.equal(coded.historical.unavailable_code,'PREFLIGHT_DISABLED');assert.ok(coded.blockers.some(item=>item.code==='PREFLIGHT_UNAVAILABLE'));
  // A database error (SQLSTATE) from the PF-2 read passes through: the request transaction is poisoned and fails honestly.
  const broken={list:async()=>{throw Object.assign(new Error('boom'),{code:'40001'});},get:async()=>{throw new Error('unused');}};
  await assert.rejects(()=>new ReadinessService({store:service.store,defaultRisk:config.defaultRisk,preflightService:broken,preflightEnabled:true,pineBridgeEnabled:true}).report(world.owner,world.bot),
    error=>error.code==='40001');
  // An unexpected non-coded error inside the PF-2 read becomes a coded unavailable status; one outside it a fixed 503 code.
  const odd={list:async()=>{throw new TypeError('private detail');},get:async()=>{throw new Error('unused');}};
  const unexpected=await new ReadinessService({store:service.store,defaultRisk:config.defaultRisk,preflightService:odd,preflightEnabled:true,pineBridgeEnabled:true}).report(world.owner,world.bot);
  assert.equal(unexpected.historical.unavailable_code,'PREFLIGHT_UNAVAILABLE');assert.equal(JSON.stringify(unexpected).includes('private detail'),false);
  const faulty=new ReadinessService({store:Object.assign(Object.create(service.store),{risk:async()=>{throw new TypeError('private detail');}}),
    defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true});
  await assert.rejects(()=>faulty.report(world.owner,world.bot),error=>error.code==='PF3_READINESS_UNAVAILABLE'&&error.status===503&&!error.message.includes('private detail'));
});
