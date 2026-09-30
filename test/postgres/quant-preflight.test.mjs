import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantPreflightService,PREFLIGHT_SERVICE_ERRORS,trustedSources} from '../../src/postgres/quant-preflight.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {config} from '../../src/config.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {createPf2Base,MINUTE,START} from '../helpers/pf2-fixture.js';
import {profileEnrollmentEvidenceFixture,insertProfileEnrollmentEvidenceFixture} from '../helpers/profile-enrollment-evidence-fixture.js';
import {FIXTURE_LABEL,createAccounts,createHarness,createWorld,fixtureEnvelope,insertFoundationJob,
  insertPreflightPair,insertV1Profile,sha,tamperBoundary} from '../helpers/preflight-pg-fixture.mjs';

// PF-2 slice R3 on isolated local PostgreSQL: QuantPreflightService, the holdout registry, the job scoped trusted
// adapters (resolved end to end by the real S3 resolver, no Python) and the scheduler authorize callback.
// Every row is a labeled test fixture (see FIXTURE_LABEL), never enrollment evidence.
const MARKER=String.raw`C:\secret-location\marker-4242`;
const ALLOWED=new Set(PREFLIGHT_SERVICE_ERRORS);
const key=()=>'fixture-key-'+randomUUID();
const clone=value=>structuredClone(value);

let admin,base,main;
const disposables=[];
const harness=async options=>{
  const created=await createHarness({admin,base,...options});
  disposables.push(()=>created.dispose());
  return created;
};
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  assert.ok(FIXTURE_LABEL);
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  // createPf2Base only registers its temporary root cleanup through t.after.
  base=await createPf2Base({after:dispose=>disposables.push(dispose)});
  main=await harness();
});
after(async()=>{
  for(const dispose of disposables.reverse())await dispose();
  await admin?.close();
});

/** Error hygiene for every refusal: a fixed known code, message equals code, only code and status, no leaked value. */
function hygiene(error,{code,status}={}){
  assert.ok(ALLOWED.has(error.code),'unexpected code '+error.code);
  assert.equal(error.message,error.code);
  assert.equal('cause' in error,false);
  assert.deepEqual(Object.keys(error),['code','status']);
  if(code!==undefined)assert.equal(error.code,code);
  if(status!==undefined)assert.equal(error.status,status);
  assert.equal([error.message,JSON.stringify(error)].join('\n').includes(MARKER),false);
  return true;
}
const refuses=(promise,code,status)=>assert.rejects(promise,error=>hygiene(error,{code,status}));
const resolverCode=(promise,code)=>assert.rejects(promise,error=>{
  assert.equal(error.code,code);
  assert.equal(error.message,error.code);
  return true;
});

const enqueue=(h,world,k=key())=>h.tx(()=>h.service.enqueue(world.owner,world.request,k));
const rowsOf=async(h,jobId)=>({
  job:(await h.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[jobId])).rows[0],
  bound:(await h.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[jobId])).rows[0]});
const resolveJob=async(h,world,jobId,{service=h.service,signal}={})=>{
  const {job,bound}=await rowsOf(h,jobId);
  return resolveHistoricalPreflight(JSON.parse(bound.plan_json),service.trusted(job),
    {now:world.now,supportedSourceHash:world.supportedSourceHash,...(signal?{signal}:{})});
};
/** Records every SQL statement the operation sends through the pooled database object. */
async function recordSql(db,operation){
  const log=[];
  db.query=function(sql,params){log.push(String(sql));return Object.getPrototypeOf(db).query.call(this,sql,params);};
  try{await operation();}finally{delete db.query;}
  return log;
}
const authorize=(h,world,contract,action,context,service=h.service)=>
  h.db.transaction(()=>service.authorize(world.owner,contract,action,context));

test('production adapters resolve the plan that enqueue built (real S3 resolver, no Python)',async()=>{
  const world=await createWorld(main);
  const summary=await enqueue(main,world);
  const {job,bound}=await rowsOf(main,summary.job_id);
  assert.equal(summary.status,'QUEUED');
  assert.deepEqual({...summary,job_id:undefined,created_at:undefined,plan_hash:undefined},
    {job_id:undefined,bot_id:world.bot,deployment_id:world.deploymentId,profile_job_id:world.profileJobId,
      plan_hash:undefined,status:'QUEUED',next_bar:0,total_bars:2100,diagnostic:null,created_at:undefined,
      development_only:true,evaluator_admission:false});
  assert.equal(bound.plan_hash,hash(bound.plan_json));
  assert.equal(summary.plan_hash,bound.plan_hash);
  const plan=JSON.parse(bound.plan_json);
  assert.equal(canonical(plan),bound.plan_json);
  assert.equal(canonical(plan.foundation),canonical(job.contract));
  assert.equal(job.contract_hash,hash(canonical(job.contract)));
  assert.equal(job.contract.kind,'PREFLIGHT');
  assert.deepEqual(job.contract.budget,{candidates:1,max_evaluations:1,chunk_bars:1000,max_runtime_ms:900000,
    max_output_bytes:524288,max_state_bytes:1048576});
  assert.equal(job.deadline_at,job.created_at+900000);
  assert.equal(plan.snapshot.development.holdout_start_time,world.boundary);
  assert.deepEqual(plan.snapshot.signal,{mode:'EVALUATOR',evaluator_hash:plan.snapshot.signal.evaluator_hash,artifact_sha256:null});
  const audit=(await main.db.query("SELECT details FROM audit WHERE event='quant.preflight.enqueued' AND trade_id=$1",[summary.job_id])).rows;
  assert.equal(audit.length,1);
  assert.deepEqual(JSON.parse(audit[0].details),{job_id:summary.job_id,plan_hash:bound.plan_hash});

  const resolved=await resolveJob(main,world,summary.job_id);
  assert.equal(resolved.plan_hash,bound.plan_hash);
  assert.equal(resolved.owner_id,world.owner);
  assert.equal(resolved.bot_id,world.bot);
  assert.deepEqual(resolved.admission,{development_only:true,evaluator_admission:false,holdout_accessed:false,
    orders_executed:false,execution_model_parity:'V1_ONLY'});
  assert.equal(resolved.dataset.holdout_start_time,world.boundary);
  assert.equal(resolved.identities.raw_dataset_sha256,world.scenario.enrollment.contract.dataset.sha256);
  assert.equal(resolved.identities.raw_provenance_sha256,world.scenario.provenanceSha);
  assert.equal(resolved.contract.deployment_id,world.deploymentId);
});

test('production service keeps the compiled-in supported source hash (no test seam in production wiring)',async()=>{
  const world=await createWorld(main);
  const production=main.serviceWith({supportedSourceHash:undefined});
  assert.equal(production.supportedSourceHash,undefined);
  // The synthetic fixture source is not the supported production source, so the builder refuses it.
  await refuses(main.tx(()=>production.enqueue(world.owner,world.request,key())),'UNSUPPORTED_SOURCE_HASH',409);
  assert.equal((await main.db.query('SELECT count(*)::int n FROM quant_preflight_jobs WHERE owner_id=$1',[world.owner])).rows[0].n,0);
});

/** The hashes the resolver asks the adapters for, from the stored plan and the enrolled deployment snapshot. */
function planKeys(world,plan){
  const s=plan.snapshot;
  return {source:s.source_hash,effective_inputs:s.effective_inputs_hash,bridge:s.bridge_hash,policy:s.policy_hash,
    capital:s.capital_hash,initial_state:s.initial_state_hash,execution_model:s.execution_model_hash,
    venue_metadata:s.venue_metadata_hash,deployment_snapshot:world.scenario.snapshotHash};
}
const findQuery=(scope,plan)=>({...scope,raw_dataset_sha256:plan.foundation.dataset.sha256,
  execution_model_hash:plan.snapshot.execution_model_hash,venue_metadata_hash:plan.snapshot.venue_metadata_hash});
const HOLDOUT_SCOPE={venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1'};

/** Every adapter, asked with `scope`: what each returns (authorize true/false, others a value or null). */
async function probe(trusted,world,plan,scope){
  const signal=new AbortController().signal;
  const out={authorize:await trusted.authorize({...scope},{signal}),records:{}};
  for(const [kind,sha] of Object.entries(planKeys(world,plan)))
    out.records[kind]=await trusted.records.get(kind,sha,{...scope,signal});
  out.enrollment=await trusted.enrollment.find(findQuery(scope,plan),{signal});
  out.provenance=await trusted.provenance.get(world.scenario.provenanceSha,{...scope,signal});
  out.holdout=await trusted.holdout.boundary({...scope,...HOLDOUT_SCOPE},{signal});
  return out;
}
const nothing=out=>out.authorize===false&&Object.values(out.records).every(value=>value===null)&&
  out.enrollment===null&&out.provenance===null&&out.holdout===null;

test('cross-owner and cross-bot: every adapter serves only the job scope',async()=>{
  const owned=await createAccounts(main.db,{botCount:2});
  const world=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  const foreign=await createWorld(main,{boundary:defaultOther()});
  const summary=await enqueue(main,world);
  const {job,bound}=await rowsOf(main,summary.job_id);
  const plan=JSON.parse(bound.plan_json);
  const trusted=main.service.trusted(job);
  const own={owner_id:world.owner,bot_id:world.bot};
  const served=await probe(trusted,world,plan,own);
  assert.equal(served.authorize,true);
  for(const [kind,value] of Object.entries(served.records))assert.notEqual(value,null,kind);
  assert.equal(served.records.source,world.scenario.source);
  assert.equal(canonical(served.records.effective_inputs),canonical(world.scenario.records.effective_inputs));
  assert.equal(canonical(served.records.deployment_snapshot),canonical(world.scenario.snapshot));
  assert.equal(canonical(served.enrollment.contract),canonical(world.scenario.enrollment.contract));
  assert.equal(canonical(served.enrollment.result),canonical(world.scenario.enrollment.result));
  assert.equal(canonical(served.enrollment.capacity_policy),canonical(main.capacityPolicy));
  assert.equal(canonical(served.provenance),canonical(world.scenario.provenance));
  assert.deepEqual(served.holdout,{holdout_start_time:world.boundary});
  const scopes={otherOwner:{owner_id:foreign.owner,bot_id:world.bot},otherBot:{owner_id:world.owner,bot_id:owned.bots[1]},
    otherBoth:{owner_id:foreign.owner,bot_id:foreign.bot}};
  for(const [name,scope] of Object.entries(scopes))assert.ok(nothing(await probe(trusted,world,plan,scope)),name);
  // The registry key is exact: another market, symbol, timeframe or venue is not the same boundary.
  const signal=new AbortController().signal;
  for(const [field,value] of [['venue','binance-th'],['market','FUTURES'],['symbol','ETHUSDT'],['timeframe','5']])
    assert.equal(await trusted.holdout.boundary({...own,...HOLDOUT_SCOPE,[field]:value},{signal}),null,field);
  // Malformed asks are refused too: not hex, unknown kind, missing scope.
  assert.equal(await trusted.records.get('source','not-a-sha',{...own,signal}),null);
  for(const kind of ['unknown_kind','constructor','__proto__','toString','hasOwnProperty',5,null,undefined,['source']])
    assert.equal(await trusted.records.get(kind,plan.snapshot.source_hash,{...own,signal}),null,String(kind));
  assert.equal(await trusted.records.get('source',plan.snapshot.source_hash,{signal}),null);
  assert.equal(await trusted.authorize(undefined,{signal}),false);
  assert.equal(await trusted.holdout.boundary(undefined,{signal}),null);
  // A record is only served under its own key.
  assert.equal(await trusted.records.get('policy',plan.snapshot.bridge_hash,{...own,signal}),null);
  assert.equal(await trusted.records.get('bridge',plan.snapshot.policy_hash,{...own,signal}),null);
  for(const other of [plan.snapshot.policy_hash,sha('9')])
    assert.equal(await trusted.records.get('deployment_snapshot',other,{...own,signal}),null);
});
function defaultOther(){return START+9000*MINUTE;}

test('a binding row that points at foreign rows serves nothing and the resolver stops (owner and bot poisoning)',async()=>{
  const a=await createWorld(main);
  const b=await createWorld(main,{boundary:a.boundary+7*MINUTE});
  const planned=await main.service.assemble(a.owner,a.request);
  const plan=planned.plan;
  const trustedFor=(jobId,scope)=>trustedSources({db:main.db,pine:main.pine,job_id:jobId,owner_id:scope.owner,
    bot_id:scope.bot,stores:main.stores,capacityPolicy:main.capacityPolicy});
  const resolveTrusted=trusted=>resolveHistoricalPreflight(JSON.parse(planned.plan_json),trusted,
    {now:a.now,supportedSourceHash:a.supportedSourceHash});

  // Owner B's job that names owner A's deployment and A's PROFILE job.
  const foreignRows=await insertPreflightPair(main.db,{planned,owner:b.owner,bot:b.bot,deploymentId:a.deploymentId,
    profileJobId:a.profileJobId});
  const one=trustedFor(foreignRows,b);
  const scopeB={owner_id:b.owner,bot_id:b.bot};
  const outB=await probe(one,a,plan,scopeB);
  // The job, owner and bot match, so authorize holds; every row lookup is scoped to B and finds nothing of A.
  assert.equal(outB.authorize,true);
  assert.ok(Object.entries(outB.records).every(([,value])=>value===null));
  assert.equal(outB.enrollment,null);
  assert.equal(outB.provenance,null);
  // B's own registry row is B's value, never A's.
  assert.deepEqual(outB.holdout,{holdout_start_time:b.boundary});
  assert.notEqual(b.boundary,a.boundary);
  // The plan names owner A, the adapters are scoped to owner B: the resolver's first call already fails.
  await resolverCode(resolveTrusted(one),'PF2_RESOLVE_UNAUTHORIZED');

  // Same owner, another bot: a job for bot 1 that names bot 0's deployment and PROFILE job.
  const owned=await createAccounts(main.db,{botCount:2});
  const bot0=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[1]}});
  const planned0=await main.service.assemble(bot0.owner,bot0.request);
  const crossBot=await insertPreflightPair(main.db,{planned:planned0,owner:owned.owner,bot:owned.bots[1],
    deploymentId:bot0.deploymentId,profileJobId:bot0.profileJobId});
  const two=trustedFor(crossBot,{owner:owned.owner,bot:owned.bots[1]});
  const outBot=await probe(two,bot0,planned0.plan,{owner_id:owned.owner,bot_id:owned.bots[1]});
  assert.equal(outBot.authorize,true);
  assert.ok(Object.values(outBot.records).every(value=>value===null));
  assert.equal(outBot.enrollment,null);
  assert.equal(outBot.provenance,null);
  await resolverCode(resolveHistoricalPreflight(JSON.parse(planned0.plan_json),two,
    {now:bot0.now,supportedSourceHash:bot0.supportedSourceHash}),'PF2_RESOLVE_UNAUTHORIZED');

  // Own deployment and source, but another owner's PROFILE job: the enrollment is not served.
  const mixed=await insertPreflightPair(main.db,{planned,owner:a.owner,bot:a.bot,deploymentId:a.deploymentId,
    profileJobId:b.profileJobId});
  const three=trustedFor(mixed,a);
  const scopeA={owner_id:a.owner,bot_id:a.bot};
  const outA=await probe(three,a,plan,scopeA);
  assert.equal(outA.enrollment,null);
  assert.ok(Object.entries(outA.records).filter(([kind])=>kind!=='deployment_snapshot').every(([,value])=>value===null));
  // The authoritative deployment snapshot is served under its own hash; the resolver re-hashes it.
  assert.equal(canonical(outA.records.deployment_snapshot),canonical(a.scenario.snapshot));
  await resolverCode(resolveTrusted(three),'PF2_INPUT_UNRESOLVED');
});

test('a binding row whose owner or bot differs from its job row serves nothing, stops the resolver and revokes authorize',async()=>{
  // The database binds neither owner nor bot of a binding row to its job row and blocks updates of the binding, so
  // each mismatch is inserted directly. The adapters, the resolver and the service must refuse it on their own.
  const owned=await createAccounts(main.db,{botCount:2});
  const world=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  const stranger=await createWorld(main);
  const planned=await main.service.assemble(world.owner,world.request);
  const scope={owner_id:world.owner,bot_id:world.bot};
  const pair=async binding=>{
    const jobId=await insertPreflightPair(main.db,{planned,owner:binding.owner,bot:binding.bot,jobOwner:world.owner,
      deploymentId:world.deploymentId,profileJobId:world.profileJobId});
    return {jobId,...await rowsOf(main,jobId)};
  };
  const resolves=trusted=>resolveHistoricalPreflight(JSON.parse(planned.plan_json),trusted,
    {now:world.now,supportedSourceHash:world.supportedSourceHash});
  // Control: a binding that agrees with its job row is served, resolves and authorizes.
  const agreeing=await pair({owner:world.owner,bot:world.bot});
  const served=await probe(main.service.trusted(agreeing.job),world,planned.plan,scope);
  assert.equal(served.authorize,true);
  assert.ok(Object.values(served.records).every(value=>value!==null));
  assert.notEqual(served.enrollment,null);
  assert.notEqual(served.provenance,null);
  assert.equal((await resolves(main.service.trusted(agreeing.job))).plan_hash,planned.plan_hash);
  assert.deepEqual(await authorize(main,world,agreeing.job.contract,'CLAIM',{job_id:agreeing.jobId}),{ok:true});
  const mismatches={'foreign owner':{owner:stranger.owner,bot:world.bot},
    'other bot of the same owner':{owner:world.owner,bot:owned.bots[1]},
    'foreign owner and bot':{owner:stranger.owner,bot:stranger.bot}};
  for(const [name,binding] of Object.entries(mismatches)){
    const {jobId,job,bound}=await pair(binding);
    assert.equal(job.owner_id,world.owner);
    assert.equal(job.contract.bot_id,world.bot);
    assert.deepEqual([bound.owner_id,bound.bot_id],[binding.owner,binding.bot]);
    const trusted=main.service.trusted(job);
    const out=await probe(trusted,world,planned.plan,scope);
    assert.equal(out.authorize,false,name);
    assert.ok(Object.values(out.records).every(value=>value===null),name);
    assert.equal(out.enrollment,null,name);
    assert.equal(out.provenance,null,name);
    await resolverCode(resolves(trusted),'PF2_RESOLVE_UNAUTHORIZED');
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:jobId}),{ok:false},name);
    // Stopping the job never depends on its binding.
    assert.deepEqual(await authorize(main,world,job.contract,'CANCEL',{job_id:jobId}),{ok:true},name);
  }
});

test('trustedSources refuses a malformed construction with one fixed code',()=>{
  const good={db:main.db,pine:main.pine,job_id:randomUUID(),owner_id:'pf-owner-x',bot_id:'pf-bot-x',stores:main.stores,
    capacityPolicy:main.capacityPolicy};
  trustedSources(good);
  for(const bad of [{},undefined,{...good,db:null},{...good,pine:{}},{...good,job_id:'not-a-uuid'},
    {...good,owner_id:''},{...good,bot_id:5},{...good,stores:undefined},{...good,stores:{raw:main.stores.raw}},
    {...good,stores:{raw:{inspect(){},read(){}},research:{}}}])
    assert.throws(()=>trustedSources(bad),error=>hygiene(error,{code:'PREFLIGHT_CONFIGURATION_INVALID',status:500}));
  // A missing capacity policy is allowed at construction: the enrollment is then never served.
  assert.equal(typeof trustedSources({...good,capacityPolicy:undefined}).enrollment.find,'function');
  const frozen=trustedSources(good);
  assert.ok(Object.isFrozen(frozen)&&Object.isFrozen(frozen.records)&&Object.isFrozen(frozen.enrollment));
  // The dataset facades expose read and inspect only, never a writer.
  assert.deepEqual(Object.keys(frozen.datasets.raw).sort(),['inspect','read']);
  assert.deepEqual(Object.keys(frozen.datasets.research).sort(),['inspectSidecarV2','raw','readV2']);
  assert.deepEqual(Object.keys(frozen.datasets.research.raw),['inspect']);
});

/** A world with its job already enqueued, plus the two stored rows. */
const fresh=async(h=main,options)=>{
  const world=await createWorld(h,options);
  const summary=await enqueue(h,world);
  return {world,summary,...await rowsOf(h,summary.job_id)};
};
/** A copy of the world's PROFILE enrollment row under a new job id (labeled fixture), with some columns replaced. */
const cloneProfile=(world,overrides)=>insertFoundationJob(main.db,{owner:world.owner,contract:world.scenario.enrollment.contract,
  result:world.scenario.enrollment.result,...overrides});
const count=async(h,table,owner)=>(await h.db.query('SELECT count(*)::int n FROM '+table+' WHERE owner_id=$1',[owner])).rows[0].n;

test('wrong profile_job_id: unknown, foreign, other bot, BACKFILL and other deployment give one code; bad shape is INVALID_FIELDS',async()=>{
  const owned=await createAccounts(main.db,{botCount:2});
  const w0=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  const w1=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[1]}});
  const foreign=await createWorld(main);
  const cases={unknown:{...w0.request,profile_job_id:randomUUID()},foreignOwner:{...w0.request,profile_job_id:foreign.profileJobId},
    otherBot:{...w0.request,profile_job_id:w1.profileJobId},backfill:{...w0.request,profile_job_id:w0.rawJobId},
    otherDeployment:{...w0.request,deployment_id:w1.deploymentId},otherBotRequest:{...w1.request,profile_job_id:w0.profileJobId},
    foreignRequest:{bot_id:foreign.bot,deployment_id:foreign.deploymentId,profile_job_id:w0.profileJobId}};
  const errors=[];
  for(const [name,body] of Object.entries(cases)){
    // The same body as another owner is refused with the same generic code, so no row existence leaks.
    const asOwner=body===cases.foreignRequest?foreign.owner:w0.owner;
    await assert.rejects(main.tx(()=>main.service.enqueue(asOwner,body,key())),error=>{
      hygiene(error,{code:'PREFLIGHT_ENROLLMENT_REQUIRED',status:409});errors.push({...error,message:error.message});return true;
    },name);
  }
  assert.equal(new Set(errors.map(error=>canonical(error))).size,1);
  for(const bad of ['not-a-uuid',w0.profileJobId.toUpperCase(),'',5,null,undefined,MARKER])
    await refuses(main.tx(()=>main.service.enqueue(w0.owner,{...w0.request,profile_job_id:bad},key())),'INVALID_FIELDS',400);
  assert.equal(await count(main,'quant_preflight_jobs',w0.owner),0);
});

test('an enrollment that is PROFILE v1, not SUCCEEDED, without a result or tampered is refused at enqueue',async()=>{
  const world=await createWorld(main);
  const refused=(code='PREFLIGHT_ENROLLMENT_REQUIRED',status=409)=>refuses(enqueue(main,world),code,status);
  const original=(await main.db.query('SELECT result FROM quant_foundation_jobs WHERE job_id=$1',[world.profileJobId])).rows[0];
  const set=(assignments,...values)=>main.db.query('UPDATE quant_foundation_jobs SET '+assignments+' WHERE job_id=$1',[world.profileJobId,...values]);
  for(const status of ['QUEUED','PAUSED','CANCELLED']){
    await set('status=$2',status);
    await refused();
  }
  await set("status='SUCCEEDED'");
  await set('result=NULL');await refused();
  await set('result=$2',JSON.stringify({...original.result,data_profile_verified:false}));await refused();
  const bar=clone(original.result);bar.binding.bar_count+=1;
  await set('result=$2',JSON.stringify(bar));await refused();
  await set('result=$2',JSON.stringify(original.result));
  // The contract seal is immutable, so a broken seal is a separate row: a copy of the enrollment under another hash.
  const unsealed=await cloneProfile(world,{contractHash:sha('9')});
  await refuses(main.tx(()=>main.service.enqueue(world.owner,{...world.request,profile_job_id:unsealed},key())),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
  assert.equal(await count(main,'quant_preflight_jobs',world.owner),0);
  // A v1 PROFILE row is an old enrollment (no capacity policy): refused; a v1 row with the V2 cost model is a parity refusal.
  const v1=await insertV1Profile(main.db,world);
  await refuses(main.tx(()=>main.service.enqueue(world.owner,{...world.request,profile_job_id:v1},key())),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
  const v2Model=await insertV1Profile(main.db,world,{modelVersion:'paper-close-cost-v2'});
  await refuses(main.tx(()=>main.service.enqueue(world.owner,{...world.request,profile_job_id:v2Model},key())),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
  // Positive control: with every row restored the same request is accepted.
  assert.equal((await enqueue(main,world)).status,'QUEUED');
});

test('an enrollment that turns invalid after enqueue stops the resolver (PF2_DATASET_ENROLLMENT_REQUIRED) and authorize',async()=>{
  const mutations={cancelled:'status=\'CANCELLED\'',nullResult:'result=NULL',queued:'status=\'QUEUED\''};
  for(const [name,assignments] of Object.entries(mutations)){
    const {world,summary,job}=await fresh();
    await main.db.query('UPDATE quant_foundation_jobs SET '+assignments+' WHERE job_id=$1',[world.profileJobId]);
    // Records still derive from the enrolled model, so the refusal comes from the enrollment step itself.
    await resolverCode(resolveJob(main,world,summary.job_id),'PF2_DATASET_ENROLLMENT_REQUIRED');
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:false},name);
  }
  // A binding that names a v1 PROFILE row, or a PROFILE copy with a broken seal, of the same owner and bot is not an enrollment either.
  const {world,summary,job}=await fresh();
  const planned=await main.service.assemble(world.owner,world.request);
  for(const profileJobId of [await insertV1Profile(main.db,world),await cloneProfile(world,{contractHash:sha('9')})]){
    const pair=await insertPreflightPair(main.db,{planned,owner:world.owner,bot:world.bot,deploymentId:world.deploymentId,profileJobId});
    const {job:pairJob}=await rowsOf(main,pair);
    await resolverCode(resolveHistoricalPreflight(planned.plan,main.service.trusted(pairJob),
      {now:world.now,supportedSourceHash:world.supportedSourceHash}),'PF2_DATASET_ENROLLMENT_REQUIRED');
    assert.deepEqual(await authorize(main,world,pairJob.contract,'CLAIM',{job_id:pair}),{ok:false});
  }
  assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:true});
});

test('explicit mode and matching durable receipt are mandatory for enqueue, authorization and trusted resolve',async()=>{
  const world=await createWorld(main),planned=await main.service.assemble(world.owner,world.request);
  for(const variant of ['unmarked-no-receipt','unmarked-with-receipt','marked-no-receipt','wrong-result-receipt','wrong-unit-proof']){
    const contract=clone(world.scenario.enrollment.contract),result=clone(world.scenario.enrollment.result),profileJobId=randomUUID();
    if(variant.startsWith('unmarked'))delete contract.completion_mode;
    await insertFoundationJob(main.db,{jobId:profileJobId,owner:world.owner,contract,result});
    if(!variant.endsWith('no-receipt')){
      const evidence=profileEnrollmentEvidenceFixture({contract,result,policy:world.scenario.enrollment.capacity_policy,jobId:profileJobId});
      if(variant==='wrong-result-receipt')evidence.receipt.result_hash=sha('9');
      if(variant==='wrong-unit-proof')evidence.launch.unit_name='robot-quant-'+sha('9')+'.service';
      await insertProfileEnrollmentEvidenceFixture(main.db,evidence);
    }
    await refuses(main.tx(()=>main.service.enqueue(world.owner,{...world.request,profile_job_id:profileJobId},key())),
      'PREFLIGHT_ENROLLMENT_REQUIRED',409);
    const pair=await insertPreflightPair(main.db,{planned,owner:world.owner,bot:world.bot,deploymentId:world.deploymentId,profileJobId});
    const {job}=await rowsOf(main,pair);
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:pair}),{ok:false},variant);
    await resolverCode(resolveHistoricalPreflight(planned.plan,main.service.trusted(job),
      {now:world.now,supportedSourceHash:world.supportedSourceHash}),'PF2_DATASET_ENROLLMENT_REQUIRED');
    await main.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[pair]);
  }
});

test('a rotated capacity policy invalidates the enrollment for enqueue, resolve and authorize',async()=>{
  const rotated=clone(main.capacityPolicy);rotated.evidence.parity_sha256=sha('9');
  const other=main.serviceWith({capacityPolicy:rotated});
  const world=await createWorld(main);
  await refuses(main.tx(()=>other.enqueue(world.owner,world.request,key())),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
  const {world:queued,summary,job}=await fresh();
  await resolverCode(resolveJob(main,queued,summary.job_id,{service:other}),'PF2_DATASET_ENROLLMENT_REQUIRED');
  assert.deepEqual(await authorize(main,queued,job.contract,'CLAIM',{job_id:summary.job_id},other),{ok:false});
  assert.deepEqual(await authorize(main,queued,job.contract,'CANCEL',{job_id:summary.job_id},other),{ok:true});
  assert.deepEqual(await authorize(main,queued,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:true});
});

const setDeployment=(world,assignments,...values)=>main.db.query('UPDATE pine_deployments SET '+assignments+' WHERE deployment_id=$1',
  [world.deploymentId,...values]);

test('an edited deployment snapshot is refused at enqueue and stops resolve and authorize after enqueue',async()=>{
  const edited="jsonb_set(snapshot,'{policy,maxTradesPerDay}','11'::jsonb)";
  // Before enqueue: the stored hash no longer matches the snapshot.
  const early=await createWorld(main);
  await setDeployment(early,'snapshot='+edited);
  await refuses(enqueue(main,early),'SNAPSHOT_HASH_MISMATCH',409);
  // A consistent edit (snapshot and hash together) no longer matches the enrolled snapshot hash either.
  const both=await createWorld(main);
  const changed=clone(both.scenario.snapshot);changed.policy.maxTradesPerDay=11;
  await setDeployment(both,'snapshot=$2,snapshot_hash=$3',JSON.stringify(changed),hash(canonical(changed)));
  await refuses(enqueue(main,both),'SNAPSHOT_HASH_MISMATCH',409);
  // After enqueue: the derived policy record changes, so the adapter has no record under the planned hash.
  const {world,summary,job}=await fresh();
  assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:true});
  await setDeployment(world,'snapshot='+edited);
  await resolverCode(resolveJob(main,world,summary.job_id),'PF2_INPUT_UNRESOLVED');
  assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:false});
  // Restoring the original snapshot restores the job: the refusal followed the edit, nothing else.
  await setDeployment(world,'snapshot=$2',JSON.stringify(world.scenario.snapshot));
  assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:true});
  await resolveJob(main,world,summary.job_id);
});

test('deployment gates at enqueue: not READY, stale membership, policy or capital, unsupported venue',async()=>{
  const gate=async(mutate,code,status=409)=>{
    const world=await createWorld(main);
    await mutate(world);
    await refuses(enqueue(main,world),code,status);
    assert.equal(await count(main,'quant_preflight_jobs',world.owner),0);
  };
  await gate(world=>setDeployment(world,"state='EXIT_ONLY'"),'RESEARCH_DEPLOYMENT_NOT_READY');
  await gate(world=>setDeployment(world,"state='REVOKED'"),'RESEARCH_DEPLOYMENT_NOT_READY');
  await gate(world=>main.db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[world.importId]),'STALE_MEMBERSHIP');
  await gate(async world=>main.store.setRisk(world.bot,{...await main.store.risk(world.bot,config.defaultRisk),maxTradesPerDay:11}),'STALE_POLICY');
  await gate(world=>main.db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'CONFIGURATION')",[world.bot,Date.now()]),'STALE_CAPITAL');
  await gate(world=>setDeployment(world,'pine_import_id=pine_import_id,source_version=2'),'PREFLIGHT_DEPLOYMENT_UNSUPPORTED');
  await gate(async world=>{
    const other=await createAccounts(main.db);
    await main.db.query('UPDATE pine_deployments SET bot_id=$2,owner_id=$3 WHERE deployment_id=$1',[world.deploymentId,other.bot,other.owner]);
  },'NOT_FOUND',404);
  await gate(world=>main.db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[world.bot]),'NOT_FOUND',404);
});

test('the deployment and the source are read under the job owner: an owner-only edit of either row is refused',async()=>{
  // Each row keeps its bot and changes only its owner column, so only the owner predicate can refuse it.
  const foreign=await createWorld(main);
  const setOwner=(table,column,id,owner)=>main.db.query('UPDATE '+table+' SET owner_id=$2 WHERE '+column+'=$1',[id,owner]);
  const rows={
    deployment:{table:'pine_deployments',column:'deployment_id',id:world=>world.deploymentId,code:'NOT_FOUND',status:404},
    source:{table:'pine_sources',column:'pine_import_id',id:world=>world.importId,code:'UNSUPPORTED_SOURCE_HASH',status:409}};
  for(const [name,row] of Object.entries(rows)){
    const world=await createWorld(main);
    await setOwner(row.table,row.column,row.id(world),foreign.owner);
    await refuses(enqueue(main,world),row.code,row.status);
    assert.equal(await count(main,'quant_preflight_jobs',world.owner),0,name);
    // Restored, the same request is accepted: the refusal followed the owner column and nothing else.
    await setOwner(row.table,row.column,row.id(world),world.owner);
    assert.equal((await enqueue(main,world)).status,'QUEUED',name);
  }
});

test('deployments outside the supported scope are refused at enqueue: live policy, other venue, extra member, other signals',async()=>{
  const unsupported=async options=>{
    const world=await createWorld(main,options);
    await refuses(enqueue(main,world),'PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
    assert.equal(await count(main,'quant_preflight_jobs',world.owner),0);
  };
  await unsupported({risk:{paperTrading:false}});
  await unsupported({risk:{requireReduceOnlySell:false}});
  await unsupported({edits:{market:{symbol:'ETHUSDT'}}});
  await unsupported({edits:{market:{broker:'binance-th'}}});
  await unsupported({edits:{market:{timeframe:'5'}}});
  await unsupported({edits:{snapshot:snapshot=>{snapshot.membership.push(clone(snapshot.membership[0]));}}});
  await unsupported({edits:{snapshot:snapshot=>{snapshot.selection.signals.buy='otherSignal';}}});
  await unsupported({edits:{snapshot:snapshot=>{snapshot.capital=snapshot.capital.filter(item=>item.broker!=='binance-global');}}});
  // The plain scope is accepted, so each refusal above came from its own defect.
  assert.equal((await enqueue(main,await createWorld(main))).status,'QUEUED');
});


test('a missing or edited source revision is refused at enqueue and gives no record afterwards',async()=>{
  const dropRevision=async world=>{
    await main.db.query('DELETE FROM pine_memberships WHERE pine_import_id=$1',[world.importId]);
    await main.db.query('DELETE FROM pine_source_revisions WHERE pine_import_id=$1',[world.importId]);
  };
  const editRevision=world=>main.db.query("UPDATE pine_source_revisions SET source=source||E'\n// edited' WHERE pine_import_id=$1",[world.importId]);
  for(const [name,tamper] of [['missing',dropRevision],['edited',editRevision]]){
    const early=await createWorld(main);
    await tamper(early);
    await refuses(enqueue(main,early),'UNSUPPORTED_SOURCE_HASH',409);
    const {world,summary,job}=await fresh();
    await tamper(world);
    await resolverCode(resolveJob(main,world,summary.job_id),'PF2_INPUT_UNRESOLVED');
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:false},name);
    // Stopping never depends on the source.
    assert.deepEqual(await authorize(main,world,job.contract,'CANCEL',{job_id:summary.job_id}),{ok:true},name);
  }
  // The source of another owner's bot is not readable through a binding either.
  const a=await createWorld(main);
  const b=await createWorld(main);
  await main.db.query('UPDATE pine_sources SET owner_id=$2,bot_id=$3 WHERE pine_import_id=$1',[a.importId,b.owner,b.bot]);
  await refuses(enqueue(main,a),'UNSUPPORTED_SOURCE_HASH',409);
});

test('edited or foreign BACKFILL provenance gives no capture evidence (PF2_CAPTURE_EVIDENCE_REQUIRED)',async()=>{
  const tampers={
    provenanceEdited:world=>main.db.query("UPDATE quant_foundation_jobs SET result=jsonb_set(result,'{provenance,pages,0,retrieved_at}','1') WHERE job_id=$1",[world.rawJobId]),
    checkpointEdited:world=>main.db.query("UPDATE quant_foundation_jobs SET checkpoint=jsonb_set(checkpoint,'{state,pages,0,provenance,retrieved_at}','1') WHERE job_id=$1",[world.rawJobId]),
    notSucceeded:world=>main.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[world.rawJobId]),
    noResult:world=>main.db.query('UPDATE quant_foundation_jobs SET result=NULL WHERE job_id=$1',[world.rawJobId]),
    noCheckpoint:world=>main.db.query('UPDATE quant_foundation_jobs SET checkpoint=NULL WHERE job_id=$1',[world.rawJobId]),
    checkpointSealBroken:world=>main.db.query("UPDATE quant_foundation_jobs SET checkpoint=jsonb_set(checkpoint,'{sha256}',to_jsonb($2::text)) WHERE job_id=$1",[world.rawJobId,sha('7')]),
    datasetSwapped:world=>main.db.query("UPDATE quant_foundation_jobs SET result=jsonb_set(result,'{dataset,dataset_id}',to_jsonb($2::text)) WHERE job_id=$1",[world.rawJobId,sha('7')])};
  for(const [name,tamper] of Object.entries(tampers)){
    const {world,summary,job}=await fresh();
    await resolveJob(main,world,summary.job_id);
    await tamper(world);
    await resolverCode(resolveJob(main,world,summary.job_id),'PF2_CAPTURE_EVIDENCE_REQUIRED');
    // The plan itself is still consistent: the enqueue-side builder does not read capture evidence, so this stays a resolver refusal.
    assert.equal((await rowsOf(main,summary.job_id)).job.status,'QUEUED',name);
  }
  // A BACKFILL row of another owner, or of another bot of the same owner, is never served.
  const owned=await createAccounts(main.db,{botCount:2});
  const first=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  const foreign=await createWorld(main);
  const cases=[[foreign.rawJobId,await createAccounts(main.db)],[first.rawJobId,{owner:owned.owner,bot:owned.bots[1]}]];
  for(const [target,accounts] of cases){
    const pointed=await createWorld(main,{accounts,
      edits:{enrollment:enrollment=>{enrollment.contract.profile.raw_job_id=target;}}});
    const summary=await enqueue(main,pointed);
    await resolverCode(resolveJob(main,pointed,summary.job_id),'PF2_CAPTURE_EVIDENCE_REQUIRED');
  }
});

test('adapters refuse a request whose hash differs from the enrolled or captured one (enrollment.find, provenance.get)',async()=>{
  const {world,job,bound}=await fresh();
  const plan=JSON.parse(bound.plan_json);
  const scope={owner_id:world.owner,bot_id:world.bot};
  const signal=new AbortController().signal;
  const trusted=main.service.trusted(job);
  const query=findQuery(scope,plan);
  const provenanceSha=world.scenario.provenanceSha;
  // Control: the exact hashes are served.
  assert.notEqual(await trusted.enrollment.find(query,{signal}),null);
  assert.notEqual(await trusted.provenance.get(provenanceSha,{...scope,signal}),null);
  // Each of the three enrollment identities is compared on its own: a well formed hash of something else is refused,
  // and so is another identity of the same enrollment (the execution model hash asked as the venue metadata hash).
  const fields=['raw_dataset_sha256','execution_model_hash','venue_metadata_hash'];
  for(const field of fields){
    for(const other of [sha('9'),plan.snapshot.source_hash,...fields.filter(name=>name!==field).map(name=>query[name])]){
      assert.notEqual(other,query[field]);
      assert.equal(await trusted.enrollment.find({...query,[field]:other},{signal}),null,field);
    }
    for(const malformed of ['not-a-sha',query[field].toUpperCase(),'',5,null,undefined])
      assert.equal(await trusted.enrollment.find({...query,[field]:malformed},{signal}),null,field+' '+String(malformed));
  }
  // The capture provenance is served under its own hash only.
  for(const other of [sha('9'),plan.snapshot.source_hash,query.raw_dataset_sha256])
    assert.equal(await trusted.provenance.get(other,{...scope,signal}),null);
  for(const malformed of ['not-a-sha',provenanceSha.toUpperCase(),'',5,null,undefined])
    assert.equal(await trusted.provenance.get(malformed,{...scope,signal}),null,String(malformed));
  // A BACKFILL result that names another dataset than the enrolled one, with its own provenance and every seal intact
  // and a self-consistent dataset reference, is not the capture of this enrollment. The stored contract and checkpoint
  // are untouched, so only the dataset comparison can refuse it.
  const original=(await main.db.query('SELECT result FROM quant_foundation_jobs WHERE job_id=$1',[world.rawJobId])).rows[0].result;
  await main.db.query("UPDATE quant_foundation_jobs SET result=jsonb_set(jsonb_set(result,'{dataset,dataset_id}',to_jsonb($2::text)),"+
    "'{dataset,sha256}',to_jsonb($2::text)) WHERE job_id=$1",[world.rawJobId,sha('7')]);
  assert.equal(await main.service.trusted(job).provenance.get(provenanceSha,{...scope,signal}),null);
  await resolverCode(resolveJob(main,world,job.job_id),'PF2_CAPTURE_EVIDENCE_REQUIRED');
  // Restored, the same capture is served again: the refusal followed the dataset reference and nothing else.
  await main.db.query('UPDATE quant_foundation_jobs SET result=$2 WHERE job_id=$1',[world.rawJobId,JSON.stringify(original)]);
  assert.notEqual(await main.service.trusted(job).provenance.get(provenanceSha,{...scope,signal}),null);
  await resolveJob(main,world,job.job_id);
});

test('holdout boundary at enqueue: missing, later than the dataset end, or tampered after enqueue',async()=>{
  const missing=await createWorld(main,{boundary:null});
  await refuses(enqueue(main,missing),'PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED',409);
  assert.equal(await count(main,'quant_preflight_jobs',missing.owner),0);
  // The whole artifact, warm-up included, must end at or before the registered boundary.
  const end=(await createWorld(main,{boundary:null})).scenario.enrollment.contract.dataset.metadata.end_time;
  const early=await createWorld(main,{boundary:end-MINUTE});
  await refuses(enqueue(main,early),'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED',409);
  const exact=await createWorld(main,{boundary:end});
  assert.equal((await enqueue(main,exact)).status,'QUEUED');
  // Out-of-band changes of the write-once row: a moved value and a removed row both stop the resolver and authorize.
  for(const [name,valueOf] of [['moved',world=>world.boundary+MINUTE],['removed',()=>null]]){
    const {world,summary,job}=await fresh();
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:true});
    await tamperBoundary(main.db,{owner:world.owner,bot:world.bot,value:valueOf(world)});
    await resolverCode(resolveJob(main,world,summary.job_id),'PF2_HOLDOUT_BOUNDARY_MISMATCH');
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:false},name);
    assert.deepEqual(await authorize(main,world,job.contract,'CANCEL',{job_id:summary.job_id}),{ok:true},name);
  }
});

const MAX_ALIGNED=253402300740000;
const register=(owner,body,h=main)=>h.tx(()=>h.service.registerHoldoutBoundary(owner,body));
/** An expected success: a refusal fails the test with an assertion that names the code. */
const accepts=async(promise,name='registration')=>{
  try{return await promise;}
  catch(error){assert.fail(name+' was refused with '+error.code);}
};
const stored=(world)=>main.db.query('SELECT * FROM quant_holdout_boundaries WHERE owner_id=$1 AND bot_id=$2',[world.owner,world.bot]).then(result=>result.rows);

test('holdout registry: owner-only, write-once, idempotent for the same value, minute aligned',async()=>{
  const owned=await createAccounts(main.db,{botCount:2});
  const world=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]},boundary:null});
  const stranger=await createAccounts(main.db);
  const value=START+2700*MINUTE;
  const body={bot_id:world.bot,holdout_start_time:value};
  assert.deepEqual(await main.tx(()=>main.service.getHoldoutBoundary(world.owner,world.bot)),
    {bot_id:world.bot,venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',holdout_start_time:null,created_at:null});
  for(const bad of [0,-MINUTE,1.5,MINUTE+1,'60000',null,undefined,NaN,Infinity,253402300799999,MAX_ALIGNED+MINUTE,Number.MAX_SAFE_INTEGER,true,[value],{}])
    await refuses(register(world.owner,{bot_id:world.bot,holdout_start_time:bad}),'HOLDOUT_BOUNDARY_INVALID',400);
  for(const bad of [{},{bot_id:world.bot},{holdout_start_time:value},{...body,extra:1},null,[],'x'])
    await refuses(register(world.owner,bad),'INVALID_FIELDS',400);
  for(const bad of ['',5,null,MARKER,'a/b'])await refuses(register(world.owner,{...body,bot_id:bad}),'INVALID_FIELDS',400);
  // Another owner cannot register for this bot, and an unknown bot is the same NOT_FOUND.
  await refuses(register(stranger.owner,body),'NOT_FOUND',404);
  await refuses(register(world.owner,{...body,bot_id:stranger.bot}),'NOT_FOUND',404);
  assert.deepEqual(await stored(world),[]);
  // The service methods need the caller's transaction.
  await refuses(main.service.registerHoldoutBoundary(world.owner,body),'INGESTION_TRANSACTION_REQUIRED');

  const first=await register(world.owner,body);
  assert.deepEqual({...first,created_at:undefined},{bot_id:world.bot,venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',
    timeframe:'1',holdout_start_time:value,created_at:undefined,registered:true});
  const rows=await stored(world);
  assert.equal(rows.length,1);
  assert.deepEqual({...rows[0],created_at:undefined},{owner_id:world.owner,bot_id:world.bot,venue:'binance-global',market:'SPOT',
    symbol:'BTCUSDT',timeframe:'1',holdout_start_time:value,created_by:world.owner,created_at:undefined});
  const audit=(await main.db.query("SELECT details FROM audit WHERE event='quant.holdout.registered' AND user_id=$1",[world.owner])).rows;
  assert.deepEqual(audit.map(row=>JSON.parse(row.details)),[{bot_id:world.bot,holdout_start_time:value}]);
  // Same value again: idempotent, the original row (and creation time) is returned. Another value: refused, nothing moves.
  assert.deepEqual(await register(world.owner,body),{...first,registered:false});
  for(const other of [value+MINUTE,value-MINUTE,START+MINUTE])
    await refuses(register(world.owner,{...body,holdout_start_time:other}),'HOLDOUT_BOUNDARY_EXISTS',409);
  // The upper bound is checked with the request validation, ahead of the write-once rule.
  await refuses(register(world.owner,{...body,holdout_start_time:MAX_ALIGNED}),'HOLDOUT_BOUNDARY_INVALID',400);
  assert.deepEqual(await stored(world),rows);
  assert.equal((await main.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.holdout.registered' AND user_id=$1",[world.owner])).rows[0].n,1);
  const {registered,...view}=first;
  assert.equal(registered,true);
  assert.deepEqual(await main.tx(()=>main.service.getHoldoutBoundary(world.owner,world.bot)),view);
  // Registration remains per bot, but a sibling cannot open an existing holdout to development.
  await refuses(register(world.owner,{bot_id:owned.bots[1],holdout_start_time:value+MINUTE}),'HOLDOUT_BOUNDARY_CONFLICT',409);
  const second=await register(world.owner,{bot_id:owned.bots[1],holdout_start_time:value});
  assert.equal(second.holdout_start_time,value);
  assert.deepEqual((await stored(world)).map(row=>row.holdout_start_time),[value]);
});

/** A labeled legacy QL-3A research row (fixture): only the split and the dataset start matter to the registry. */
let legacyCount=0;
const legacyJob=(world,contract,{status='SUCCEEDED',bot=world.bot,owner=world.owner,deployment=world.deploymentId}={})=>{
  const id='fixture-legacy-'+(++legacyCount)+'-'+randomUUID().slice(0,8),now=Date.now();
  return main.db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,
    contract,status,created_at,updated_at,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
  [id,owner,bot,deployment,'fixture:'+id,sha('1'),sha('2'),JSON.stringify({fixture:true,...contract}),status,now,now+900000]);
};
const split=(validationEnd,extra={})=>({split:{warmup:500,train_end:1500,validation_end:validationEnd,test_end:validationEnd+1000},
  dataset:{start_time:START,...extra}});

test('holdout registry refuses a boundary later than a legacy research holdout start (first holdout bar open time)',async()=>{
  // Legacy bars are close-time stamped, so the first holdout bar (index validation_end) opens one minute before its stamp.
  const legacyStart=validationEnd=>START+(validationEnd-1)*MINUTE;
  const fixtureWorld=()=>createWorld(main,{boundary:null});
  const world=await fixtureWorld();
  await legacyJob(world,split(3000));
  const body=value=>({bot_id:world.bot,holdout_start_time:value});
  await refuses(register(world.owner,body(legacyStart(3000)+MINUTE)),'HOLDOUT_BOUNDARY_CONFLICT',409);
  await refuses(register(world.owner,body(legacyStart(3000)+100*MINUTE)),'HOLDOUT_BOUNDARY_CONFLICT',409);
  assert.deepEqual(await stored(world),[]);
  // Equal to the legacy holdout start is allowed: the legacy holdout stays unexposed.
  assert.equal((await accepts(register(world.owner,body(legacyStart(3000))))).holdout_start_time,legacyStart(3000));

  // Several legacy rows: the earliest holdout start rules, whatever their status.
  const many=await fixtureWorld();
  await legacyJob(many,split(3000));
  await legacyJob(many,split(2800),{status:'FAILED'});
  await legacyJob(many,split(4000));
  await refuses(register(many.owner,{bot_id:many.bot,holdout_start_time:legacyStart(2800)+MINUTE}),'HOLDOUT_BOUNDARY_CONFLICT',409);
  await accepts(register(many.owner,{bot_id:many.bot,holdout_start_time:legacyStart(2800)}));

  // A legacy dataset that starts later moves its holdout later.
  const later=await fixtureWorld();
  await legacyJob(later,split(3000,{start_time:START+5000*MINUTE}));
  await accepts(register(later.owner,{bot_id:later.bot,holdout_start_time:START+7900*MINUTE}));
  await refuses(register(later.owner,{bot_id:later.bot,holdout_start_time:START+8000*MINUTE}),'HOLDOUT_BOUNDARY_EXISTS',409);
  const laterOne=await fixtureWorld();
  await legacyJob(laterOne,split(3000,{start_time:START+5000*MINUTE}));
  await refuses(register(laterOne.owner,{bot_id:laterOne.bot,holdout_start_time:START+8000*MINUTE}),'HOLDOUT_BOUNDARY_CONFLICT',409);

  // An unreadable split fails closed.
  for(const [name,contract] of [['text',split('x')],['missing index',{split:{warmup:1},dataset:{start_time:START}}],
    ['fraction',split(3000.5)],['no start',{split:split(3000).split,dataset:{}}],['null split',{split:null}],
    ['negative',split(-5)]]){
    const broken=await fixtureWorld();
    await legacyJob(broken,contract);
    await refuses(register(broken.owner,{bot_id:broken.bot,holdout_start_time:START+100*MINUTE}),'HOLDOUT_BOUNDARY_CONFLICT',409);
    assert.deepEqual(await stored(broken),[],name);
  }
  // A legacy row without a split is ignored.
  const noSplit=await fixtureWorld();
  await legacyJob(noSplit,{version:'ql3a-research-job-v1',dataset:{start_time:START}});
  await accepts(register(noSplit.owner,{bot_id:noSplit.bot,holdout_start_time:START+9000*MINUTE}));
  const untouched=await fixtureWorld();
  assert.equal((await accepts(register(untouched.owner,{bot_id:untouched.bot,holdout_start_time:START+9000*MINUTE}))).registered,true);
});

/** A registration through a service whose clock the test sets (the service's only time seam). */
const registerAt=(clock,owner,body)=>main.tx(()=>main.serviceWith({clock:()=>clock}).registerHoldoutBoundary(owner,body));
const auditRows=owner=>main.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.holdout.registered' AND user_id=$1",[owner])
  .then(result=>result.rows[0].n);

test('legacy holdout conflict is owner wide: a legacy split of any bot of the owner limits every bot, other owners never do',async()=>{
  const legacyStart=validationEnd=>START+(validationEnd-1)*MINUTE;
  const owned=await createAccounts(main.db,{botCount:3});
  const worlds=[];
  for(const bot of owned.bots)worlds.push(await createWorld(main,{accounts:{owner:owned.owner,bot},boundary:null}));
  const [a,b,c]=worlds;
  const foreign=await createWorld(main,{boundary:null});
  const body=(world,value)=>({bot_id:world.bot,holdout_start_time:value});
  // Legacy rows of two sibling bots (the status does not matter), one without a split (ignored). Bot c has none of its own.
  await legacyJob(a,split(3000));
  await legacyJob(b,split(2800),{status:'FAILED'});
  await legacyJob(a,{version:'ql3a-research-job-v1',dataset:{start_time:START}});
  // Rows of another owner are never read, whatever their holdout start or split, and even when they name a bot of this owner.
  await legacyJob(foreign,split(1000));
  await legacyJob(foreign,split('x'));
  await legacyJob(a,split(500),{owner:foreign.owner});
  // Bot c has no legacy row: the earliest start of its siblings rules, and nothing is written by a refusal.
  for(const later of [legacyStart(2800)+MINUTE,legacyStart(3000),legacyStart(3000)+100*MINUTE,START+9000*MINUTE])
    await refuses(register(c.owner,body(c,later)),'HOLDOUT_BOUNDARY_CONFLICT',409);
  // Bot a has an own legacy row (3000) but its sibling b holds an earlier one (2800): the earlier start rules.
  for(const later of [legacyStart(2800)+MINUTE,legacyStart(3000),START+9000*MINUTE])
    await refuses(register(a.owner,body(a,later)),'HOLDOUT_BOUNDARY_CONFLICT',409);
  assert.equal((await main.db.query('SELECT count(*)::int n FROM quant_holdout_boundaries WHERE owner_id=$1',[owned.owner])).rows[0].n,0);
  assert.equal(await auditRows(owned.owner),0);
  // Equal to the earliest legacy start is allowed, earlier too. Registration stays per bot: one row for each bot.
  assert.equal((await accepts(register(c.owner,body(c,legacyStart(2800))))).holdout_start_time,legacyStart(2800));
  assert.equal((await accepts(register(a.owner,body(a,legacyStart(2800)-10*MINUTE)))).registered,true);
  await refuses(register(b.owner,body(b,legacyStart(2800))),'HOLDOUT_BOUNDARY_CONFLICT',409);
  assert.equal((await accepts(register(b.owner,body(b,legacyStart(2800)-10*MINUTE)))).registered,true);
  const rows=(await main.db.query('SELECT bot_id,holdout_start_time FROM quant_holdout_boundaries WHERE owner_id=$1 ORDER BY bot_id',[owned.owner])).rows;
  assert.deepEqual(rows,[[a,legacyStart(2800)-10*MINUTE],[b,legacyStart(2800)-10*MINUTE],[c,legacyStart(2800)]]
    .map(([world,value])=>({bot_id:world.bot,holdout_start_time:value})));

  // An unreadable split of a sibling bot fails closed for every bot of the owner, and only for that owner.
  const pair=await createAccounts(main.db,{botCount:2});
  const pairWorlds=[];
  for(const bot of pair.bots)pairWorlds.push(await createWorld(main,{accounts:{owner:pair.owner,bot},boundary:null}));
  const [first,second]=pairWorlds;
  await legacyJob(second,split('x'));
  await refuses(register(first.owner,body(first,START+100*MINUTE)),'HOLDOUT_BOUNDARY_CONFLICT',409);
  assert.deepEqual(await stored(first),[]);
  const clear=await createWorld(main,{boundary:null});
  assert.equal((await accepts(register(clear.owner,body(clear,START+9000*MINUTE)))).registered,true);
});

test('sibling PF-2 holdout tightens effective admission and revokes old plans without rewriting registrations',async()=>{
  const accounts=await createAccounts(main.db,{botCount:3});
  const first=await createWorld(main,{accounts:{owner:accounts.owner,bot:accounts.bots[0]}});
  const sibling=await createWorld(main,{accounts:{owner:accounts.owner,bot:accounts.bots[1]},boundary:null});
  const missing=await createWorld(main,{accounts:{owner:accounts.owner,bot:accounts.bots[2]},boundary:null});
  const summary=await enqueue(main,first);
  const {job}=await rowsOf(main,summary.job_id);
  const original=await stored(first);
  const earlier=first.boundary-10*MINUTE;
  await register(sibling.owner,{bot_id:sibling.bot,holdout_start_time:earlier});
  assert.deepEqual(await stored(first),original);
  assert.equal((await register(first.owner,{bot_id:first.bot,holdout_start_time:first.boundary})).registered,false);
  assert.equal((await main.tx(()=>main.service.getHoldoutBoundary(first.owner,first.bot))).holdout_start_time,first.boundary);
  await refuses(enqueue(main,missing),'PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED',409);
  for(const action of ['CLAIM','HEARTBEAT','CHECKPOINT','FINISH'])
    assert.deepEqual(await authorize(main,first,job.contract,action,{job_id:summary.job_id}),{ok:false},action);
  await resolverCode(resolveJob(main,first,summary.job_id),'PF2_HOLDOUT_BOUNDARY_MISMATCH');
  assert.deepEqual(await authorize(main,first,job.contract,'CANCEL',{job_id:summary.job_id}),{ok:true});
  await main.tx(()=>main.service.get(first.owner,summary.job_id,true));
  const replacement=await enqueue(main,first);
  const {bound}=await rowsOf(main,replacement.job_id);
  assert.equal(JSON.parse(bound.plan_json).snapshot.development.holdout_start_time,earlier);
  assert.equal((await resolveJob(main,first,replacement.job_id)).dataset.holdout_start_time,earlier);
  // Another owner's earlier boundary cannot change this owner's effective boundary.
  await createWorld(main,{boundary:earlier-MINUTE});
  assert.equal((await resolveJob(main,first,replacement.job_id)).dataset.holdout_start_time,earlier);
  // Tightening into the dataset refuses new admission, not just old frozen plans.
  const end=first.scenario.enrollment.contract.dataset.metadata.end_time;
  await register(missing.owner,{bot_id:missing.bot,holdout_start_time:end-MINUTE});
  await main.tx(()=>main.service.get(first.owner,replacement.job_id,true));
  await refuses(enqueue(main,first),'PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED',409);
});

test('sibling holdout registration racing enqueue cannot authorize a stale plan in a fresh transaction',async()=>{
  for(const isolation of ['SERIALIZABLE','READ COMMITTED']){
    const accounts=await createAccounts(main.db,{botCount:2});
    const first=await createWorld(main,{accounts:{owner:accounts.owner,bot:accounts.bots[0]}});
    const sibling=await createWorld(main,{accounts:{owner:accounts.owner,bot:accounts.bots[1]},boundary:null});
    const earlier=first.boundary-10*MINUTE;
    const tx=operation=>main.db.transaction(operation,{isolation});
    const registerSibling=()=>tx(()=>main.service.registerHoldoutBoundary(first.owner,
      {bot_id:sibling.bot,holdout_start_time:earlier}));
    const enqueueFirst=()=>tx(()=>main.service.enqueue(first.owner,first.request,key()));
    const [registration,admission]=await Promise.allSettled([registerSibling(),enqueueFirst()]);
    for(const outcome of [registration,admission])
      if(outcome.status==='rejected')assert.equal(outcome.reason.code,'40001',isolation);
    if(registration.status==='rejected')await registerSibling();
    const summary=admission.status==='fulfilled'?admission.value:await enqueueFirst();
    const {job,bound}=await rowsOf(main,summary.job_id);
    const planBoundary=JSON.parse(bound.plan_json).snapshot.development.holdout_start_time;
    assert.ok([first.boundary,earlier].includes(planBoundary));
    // A serializable enqueue can precede registration logically. Its old plan
    // must fail the next fence; a new plan must carry the effective minimum.
    assert.deepEqual(await authorize(main,first,job.contract,'CLAIM',{job_id:summary.job_id}),
      {ok:planBoundary===earlier},isolation);
    assert.deepEqual((await stored(first)).map(row=>row.holdout_start_time),[first.boundary]);
    assert.deepEqual((await stored(sibling)).map(row=>row.holdout_start_time),[earlier]);
  }
});

test('holdout registry refuses a boundary later than the current minute of the service clock, ahead of every write',async()=>{
  const minute=START+5000*MINUTE;
  const world=await createWorld(main,{boundary:null});
  const body=value=>({bot_id:world.bot,holdout_start_time:value});
  const untouched=async()=>{
    assert.deepEqual(await stored(world),[]);
    assert.equal(await auditRows(world.owner),0);
  };
  // Later than the current minute: refused at any instant inside that minute, near or far, with no row and no audit record.
  for(const clock of [minute,minute+1,minute+30000,minute+MINUTE-1])
    for(const later of [minute+MINUTE,minute+2*MINUTE,minute+1000*MINUTE,MAX_ALIGNED])
      await refuses(registerAt(clock,world.owner,body(later)),'HOLDOUT_BOUNDARY_INVALID',400);
  await untouched();
  // The default service clock (the real time) refuses the far future and the minute after next as well.
  await refuses(register(world.owner,body(MAX_ALIGNED)),'HOLDOUT_BOUNDARY_INVALID',400);
  await refuses(register(world.owner,body(Math.floor(Date.now()/MINUTE)*MINUTE+2*MINUTE)),'HOLDOUT_BOUNDARY_INVALID',400);
  await untouched();
  // A clock that runs behind the request: the same rule, so a boundary from the future is never stored.
  await refuses(registerAt(minute-MINUTE,world.owner,body(minute)),'HOLDOUT_BOUNDARY_INVALID',400);
  await untouched();

  // The current minute itself is accepted whether the clock sits on it, 30 s into it or in its last millisecond;
  // the next minute stays refused at the same instant and is accepted once the clock reaches it.
  for(const [name,clock] of [['on the minute',minute],['30 s into the minute',minute+30000],['last millisecond',minute+MINUTE-1]]){
    const each=await createWorld(main,{boundary:null});
    const request=value=>({bot_id:each.bot,holdout_start_time:value});
    await refuses(registerAt(clock,each.owner,request(minute+MINUTE)),'HOLDOUT_BOUNDARY_INVALID',400);
    assert.deepEqual(await stored(each),[],name);
    const first=await accepts(registerAt(clock,each.owner,request(minute)),name);
    assert.equal(first.registered,true,name);
    assert.equal(first.holdout_start_time,minute,name);
    const rows=await stored(each);
    assert.deepEqual(rows.map(row=>row.holdout_start_time),[minute],name);
    assert.equal(await auditRows(each.owner),1,name);
    // Same value again: idempotent at the same instant and later. Later than the clock: refused, and the row is untouched.
    assert.deepEqual(await accepts(registerAt(clock,each.owner,request(minute)),name),{...first,registered:false},name);
    assert.deepEqual(await accepts(registerAt(clock+MINUTE,each.owner,request(minute)),name),{...first,registered:false},name);
    await refuses(registerAt(clock,each.owner,request(minute+MINUTE)),'HOLDOUT_BOUNDARY_INVALID',400);
    await refuses(registerAt(clock+MINUTE,each.owner,request(minute+MINUTE)),'HOLDOUT_BOUNDARY_EXISTS',409);
    assert.deepEqual(await stored(each),rows,name);
    assert.equal(await auditRows(each.owner),1,name);
  }
  // Once the clock has moved on, the next minute is a valid first registration.
  assert.equal((await accepts(registerAt(minute+MINUTE+30000,world.owner,body(minute+MINUTE)))).registered,true);
  assert.deepEqual((await stored(world)).map(row=>row.holdout_start_time),[minute+MINUTE]);
});

test('holdout registry upper bound is checked before the readiness, transaction and scope checks',async()=>{
  const owned=await createAccounts(main.db,{botCount:1});
  const world=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]},boundary:null});
  const stranger=await createAccounts(main.db);
  const future=Math.floor(Date.now()/MINUTE)*MINUTE+2*MINUTE;
  const body={bot_id:world.bot,holdout_start_time:future};
  const untouched=async()=>{
    assert.deepEqual(await stored(world),[]);
    assert.equal(await auditRows(world.owner),0);
  };
  // Outside a transaction a future value is INVALID, not INGESTION_TRANSACTION_REQUIRED; the same value in range still needs the transaction.
  await refuses(main.service.registerHoldoutBoundary(world.owner,body),'HOLDOUT_BOUNDARY_INVALID',400);
  await refuses(main.service.registerHoldoutBoundary(world.owner,{...body,holdout_start_time:START+2700*MINUTE}),'INGESTION_TRANSACTION_REQUIRED');
  // A bot the caller does not own: a future value is INVALID, not NOT_FOUND, so the bound is no bot existence oracle.
  await refuses(register(stranger.owner,body),'HOLDOUT_BOUNDARY_INVALID',400);
  await refuses(register(world.owner,{...body,bot_id:stranger.bot}),'HOLDOUT_BOUNDARY_INVALID',400);
  await refuses(main.service.registerHoldoutBoundary(world.owner,{...body,bot_id:stranger.bot}),'HOLDOUT_BOUNDARY_INVALID',400);
  await untouched();
  assert.deepEqual(await stored({owner:stranger.owner,bot:stranger.bot}),[]);
  assert.equal(await auditRows(stranger.owner),0);
});

/** Moves a fixture job between statuses with the lease columns each status requires (one RUNNING or STOPPING row per database). */
const setStatus=(jobId,status,db=main.db)=>{
  const token=randomUUID();
  const columns={RUNNING:[token,Date.now()+60000,null,'fixture-worker'],STOPPING:[token,null,'CANCELLED','fixture-worker']}[status]??
    [null,null,null,null];
  return db.query('UPDATE quant_foundation_jobs SET status=$2,lease_token=$3,lease_until=$4,stop_reason=$5,worker_id=$6 WHERE job_id=$1',
    [jobId,status,...columns]);
};

test('enqueue is idempotent per owner key, refuses a changed body, bad keys, bad bodies and a second active job per bot',async()=>{
  const owned=await createAccounts(main.db,{botCount:2});
  const world=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  const other=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[1]}});
  const k=key();
  const first=await enqueue(main,world,k);
  assert.deepEqual(await enqueue(main,world,k),first);
  assert.equal(await count(main,'quant_preflight_jobs',world.owner),1);
  assert.equal((await main.db.query("SELECT count(*)::int n FROM quant_foundation_jobs WHERE owner_id=$1 AND contract->>'kind'='PREFLIGHT'",[world.owner])).rows[0].n,1);
  for(const body of [{...world.request,deployment_id:other.deploymentId},{...world.request,profile_job_id:other.profileJobId},
    {...other.request},{...world.request,profile_job_id:randomUUID()},{...world.request,bot_id:other.bot}])
    await refuses(main.tx(()=>main.service.enqueue(world.owner,body,k)),'IDEMPOTENCY_CONFLICT',409);
  // The key space is shared with every foundation kind: a key used by a PROFILE row is a conflict, never a replay.
  const profileKey='profile-key-'+randomUUID().slice(0,8);
  await insertFoundationJob(main.db,{owner:world.owner,contract:other.scenario.enrollment.contract,result:other.scenario.enrollment.result,idempotencyKey:profileKey});
  await refuses(main.tx(()=>main.service.enqueue(world.owner,other.request,profileKey)),'IDEMPOTENCY_CONFLICT',409);
  for(const bad of [undefined,null,'','short',' '+k,k+'!','a'.repeat(129),5,MARKER,{}])
    await refuses(main.tx(()=>main.service.enqueue(world.owner,world.request,bad)),'IDEMPOTENCY_KEY_REQUIRED',400);
  for(const bad of [undefined,null,[],'x',{},{bot_id:world.bot},{...world.request,extra:1},{...world.request,bot_id:5},
    {...world.request,deployment_id:'short'},{...world.request,deployment_id:MARKER},{...world.request,bot_id:MARKER}])
    await refuses(main.tx(()=>main.service.enqueue(world.owner,bad,key())),'INVALID_FIELDS',400);
  await refuses(main.tx(()=>main.service.enqueue(world.owner,{...world.request,bot_id:'pf-no-such-bot'},key())),'NOT_FOUND',404);
  // Another owner cannot enqueue for this owner's bot, deployment and PROFILE job (owner and bot scope is enforced in code).
  const stranger=await createAccounts(main.db);
  await refuses(main.tx(()=>main.service.enqueue(stranger.owner,world.request,key())),'NOT_FOUND',404);
  await refuses(main.tx(()=>main.service.enqueue(stranger.owner,{...world.request,bot_id:stranger.bot},key())),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
  assert.equal(await count(main,'quant_preflight_jobs',stranger.owner),0);
  await refuses(main.service.enqueue(world.owner,world.request,key()),'INGESTION_TRANSACTION_REQUIRED');

  // One active PREFLIGHT per bot, in every active state; the other bot of the same owner is not blocked.
  const blocked=()=>refuses(enqueue(main,world),'PREFLIGHT_ALREADY_ACTIVE',409);
  await blocked();
  await setStatus(first.job_id,'PAUSED');await blocked();
  await setStatus(first.job_id,'RUNNING');await blocked();
  await setStatus(first.job_id,'STOPPING');await blocked();
  assert.equal((await enqueue(main,other)).status,'QUEUED');
  // A terminal job does not block; the replay of its key still returns it, and a new key builds a new job.
  await setStatus(first.job_id,'CANCELLED');
  assert.equal((await enqueue(main,world,k)).status,'CANCELLED');
  const next=await enqueue(main,world);
  assert.notEqual(next.job_id,first.job_id);
  assert.equal(await count(main,'quant_preflight_jobs',world.owner),3);
});

test('queue caps: 20 active per owner and 100 in all give FOUNDATION_QUEUE_FULL (429)',async()=>{
  const caps=await harness();
  const world=await createWorld(caps);
  const fill=(owner,total)=>Promise.all(Array.from({length:total},()=>insertFoundationJob(caps.db,{owner,contract:{fixture:true},status:'QUEUED'})));
  const ids=await fill(world.owner,20);
  await refuses(enqueue(caps,world),'FOUNDATION_QUEUE_FULL',429);
  await caps.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[ids[0]]);
  const summary=await enqueue(caps,world);
  assert.equal(summary.status,'QUEUED');
  const second=await createWorld(caps);
  await fill('pf-fixture-owner-a',40);
  await fill('pf-fixture-owner-b',40);
  // 20 + 40 + 40 = 100 active rows in all: another owner is refused although it holds none.
  assert.equal((await caps.db.query("SELECT count(*)::int n FROM quant_foundation_jobs WHERE status='QUEUED'")).rows[0].n,100);
  await refuses(enqueue(caps,second),'FOUNDATION_QUEUE_FULL',429);
  await caps.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE owner_id='pf-fixture-owner-b' AND job_id=(SELECT job_id FROM quant_foundation_jobs WHERE owner_id='pf-fixture-owner-b' LIMIT 1)");
  assert.equal((await enqueue(caps,second)).status,'QUEUED');
  // An idempotent replay is still answered when the queue is full.
  const k=key(),replay=await createWorld(caps);
  await caps.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE owner_id='pf-fixture-owner-a' AND job_id=(SELECT job_id FROM quant_foundation_jobs WHERE owner_id='pf-fixture-owner-a' LIMIT 1)");
  const made=await enqueue(caps,replay,k);
  assert.deepEqual(await enqueue(caps,replay,k),made);
});

const FENCED=['CLAIM','HEARTBEAT','CHECKPOINT','FINISH'];

test('authorize matrix: fenced actions need a transaction and a matching job; stops need the owner only',async()=>{
  const {world,summary,job}=await fresh();
  const {world:otherWorld,summary:otherSummary,job:otherJob}=await fresh();
  const contract=job.contract,context={job_id:summary.job_id,worker_id:'fixture-worker'};
  const inTx=(action,ctx=context,owner=world.owner,given=contract)=>main.db.transaction(()=>main.service.authorize(owner,given,action,ctx));
  for(const action of FENCED){
    assert.deepEqual(await inTx(action),{ok:true},action);
    // Outside a transaction the rebuild cannot hold its locks: refused. Stop actions never need one.
    assert.deepEqual(await main.service.authorize(world.owner,contract,action,context),{ok:false},action);
    for(const bad of [{},{worker_id:'w'},{job_id:undefined},{job_id:'x'},{job_id:5},{job_id:summary.job_id.toUpperCase()},
      {job_id:randomUUID()},{job_id:otherSummary.job_id},null])
      assert.deepEqual(await inTx(action,bad),{ok:false},action+' '+JSON.stringify(bad));
    // A stored job with another owner's contract or another job's plan is not this job.
    assert.deepEqual(await inTx(action,context,world.owner,otherJob.contract),{ok:false},action);
    assert.deepEqual(await inTx(action,{job_id:otherSummary.job_id},world.owner,contract),{ok:false},action);
    assert.deepEqual(await inTx(action,{job_id:otherSummary.job_id},otherWorld.owner,otherJob.contract),{ok:true},action);
    assert.deepEqual(await inTx(action,{job_id:otherSummary.job_id},world.owner,otherJob.contract),{ok:false},action);
  }
  for(const action of ['CANCEL','PAUSE'])for(const ctx of [context,{},null,{job_id:'x'}])
    assert.deepEqual(await inTx(action,ctx),{ok:true},action);
  // Supervisor proof is exactly stopped===true; nothing truthy-looking counts.
  assert.deepEqual(await inTx('ACKNOWLEDGE_STOPPED',{...context,stopped:true}),{ok:true});
  for(const stopped of [false,'true',1,{},null,undefined])
    assert.deepEqual(await inTx('ACKNOWLEDGE_STOPPED',{...context,stopped}),{ok:false},String(stopped));
  assert.deepEqual(await inTx('ACKNOWLEDGE_STOPPED',null),{ok:false});
  // Unknown actions, including the scheduler's own ENQUEUE (jobs only enter through the service), are refused.
  for(const action of ['ENQUEUE','','claim','DELETE','RESUME',undefined,null,5])
    assert.deepEqual(await inTx(action),{ok:false},String(action));
  // Another owner or another kind never passes, for every action.
  for(const action of [...FENCED,'CANCEL','PAUSE','ACKNOWLEDGE_STOPPED']){
    assert.deepEqual(await inTx(action,{...context,stopped:true},otherWorld.owner),{ok:false},action);
    assert.deepEqual(await inTx(action,{...context,stopped:true},world.owner,{...contract,kind:'BACKFILL'}),{ok:false},action);
    assert.deepEqual(await inTx(action,{...context,stopped:true},world.owner,null),{ok:false},action);
    assert.deepEqual(await inTx(action,{...context,stopped:true},world.owner,'x'),{ok:false},action);
  }
  // The contract must be the plan's foundation: any other contract of this owner and bot is refused for the job id.
  for(const variant of [{...contract,engine_hash:sha('5')},{...contract,snapshot_hash:sha('5')},
    {...contract,budget:{...contract.budget,chunk_bars:999}}])
    for(const action of FENCED)assert.deepEqual(await inTx(action,context,world.owner,variant),{ok:false},action);
  // A disabled service, or one without a capacity policy, only lets the stop actions through.
  for(const off of [main.serviceWith({enabled:false}),main.serviceWith({capacityPolicy:undefined})]){
    for(const action of FENCED)assert.deepEqual(await authorize(main,world,contract,action,context,off),{ok:false},action);
    assert.deepEqual(await authorize(main,world,contract,'CANCEL',context,off),{ok:true});
  }
});

test('authorize revokes every fenced action when any input of the plan changes; CANCEL, PAUSE and acknowledge stay open',async()=>{
  const cases={
    deploymentExitOnly:world=>setDeployment(world,"state='EXIT_ONLY'"),
    deploymentRevoked:world=>setDeployment(world,"state='REVOKED'"),
    snapshotEdited:world=>setDeployment(world,"snapshot=jsonb_set(snapshot,'{policy,maxTradesPerDay}','11'::jsonb)"),
    snapshotHashEdited:world=>setDeployment(world,'snapshot_hash=$2',sha('8')),
    membershipDisconnected:world=>main.db.query('UPDATE pine_memberships SET connected=FALSE WHERE pine_import_id=$1',[world.importId]),
    policyChanged:async world=>main.store.setRisk(world.bot,{...await main.store.risk(world.bot,config.defaultRisk),maxTradesPerDay:11}),
    capitalChanged:world=>main.db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'CONFIGURATION')",[world.bot,Date.now()]),
    botDisabled:world=>main.db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[world.bot]),
    ownerDisabled:world=>main.db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[world.owner]),
    boundaryMoved:world=>tamperBoundary(main.db,{owner:world.owner,bot:world.bot,value:world.boundary+MINUTE}),
    boundaryRemoved:world=>tamperBoundary(main.db,{owner:world.owner,bot:world.bot,value:null}),
    enrollmentCancelled:world=>main.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[world.profileJobId]),
    enrollmentResultGone:world=>main.db.query('UPDATE quant_foundation_jobs SET result=NULL WHERE job_id=$1',[world.profileJobId]),
    sourceEdited:world=>main.db.query("UPDATE pine_source_revisions SET source=source||E'\n// edited' WHERE pine_import_id=$1",[world.importId])};
  for(const [name,mutate] of Object.entries(cases)){
    const {world,summary,job}=await fresh();
    const context={job_id:summary.job_id,worker_id:'fixture-worker'};
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',context),{ok:true},name);
    await mutate(world);
    for(const action of FENCED)assert.deepEqual(await authorize(main,world,job.contract,action,context),{ok:false},name+' '+action);
    for(const action of ['CANCEL','PAUSE'])assert.deepEqual(await authorize(main,world,job.contract,action,context),{ok:true},name+' '+action);
    assert.deepEqual(await authorize(main,world,job.contract,'ACKNOWLEDGE_STOPPED',{...context,stopped:true}),{ok:true},name);
    assert.deepEqual(await authorize(main,world,job.contract,'ACKNOWLEDGE_STOPPED',context),{ok:false},name);
  }
});

test('authorize: another engine or evaluator hash than the plan revokes it; an unreadable hash is a refusal, never a throw',async()=>{
  const {world,summary,job}=await fresh();
  const context={job_id:summary.job_id};
  const hashes=await main.options.executableHashes();
  for(const [name,executableHashes] of [['engine',async()=>({...hashes,engine_hash:sha('e')})],
    ['evaluator',async()=>({...hashes,evaluator_hash:sha('f')})],
    ['unreadable',async()=>{throw new Error(MARKER);}],['same',async()=>hashes]]){
    const service=main.serviceWith({executableHashes});
    assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',context,service),{ok:name==='same'},name);
    assert.deepEqual(await authorize(main,world,job.contract,'CANCEL',context,service),{ok:true},name);
  }
});

const get=(h,owner,id,cancel=false,bot=null)=>h.tx(()=>h.service.get(owner,id,cancel,bot));
const SUMMARY_KEYS=['job_id','bot_id','deployment_id','profile_job_id','plan_hash','status','next_bar','total_bars','diagnostic',
  'created_at','development_only','evaluator_admission'];

test('get: owner scoped detail with engine_current; foreign, bot-mismatched and non-PREFLIGHT ids are NOT_FOUND',async()=>{
  const {world,summary,job}=await fresh();
  const detail=await get(main,world.owner,summary.job_id);
  assert.deepEqual(Object.keys(detail).sort(),[...SUMMARY_KEYS,'envelope','engine_current'].sort());
  assert.deepEqual({...detail,envelope:undefined,engine_current:undefined},{...summary,envelope:undefined,engine_current:undefined});
  assert.equal(detail.envelope,null);
  assert.equal(detail.engine_current,true);
  assert.deepEqual(await get(main,world.owner,summary.job_id,false,world.bot),detail);
  // Another engine hash than the job's plan: the detail still shows, flagged as not current.
  const stale=main.serviceWith({executableHashes:async()=>({...await main.options.executableHashes(),engine_hash:sha('e')})});
  assert.equal((await main.tx(()=>stale.get(world.owner,summary.job_id))).engine_current,false);
  const stranger=await createWorld(main);
  for(const [name,call] of Object.entries({foreignOwner:()=>get(main,stranger.owner,summary.job_id),
    botMismatch:()=>get(main,world.owner,summary.job_id,false,stranger.bot),
    botMismatchOwned:()=>get(main,world.owner,summary.job_id,false,world.bot+'x'),unknown:()=>get(main,world.owner,randomUUID()),
    malformed:()=>get(main,world.owner,'not-a-uuid'),upper:()=>get(main,world.owner,summary.job_id.toUpperCase()),
    profileRow:()=>get(main,world.owner,world.profileJobId),backfillRow:()=>get(main,world.owner,world.rawJobId),
    cancelForeign:()=>get(main,stranger.owner,summary.job_id,true),badBot:()=>get(main,world.owner,summary.job_id,false,5)}))
    await refuses(call(),'NOT_FOUND',404);
  // A deactivated bot hides its jobs.
  await main.db.query("UPDATE users SET status='DISABLED' WHERE id=$1",[world.bot]);
  await refuses(get(main,world.owner,summary.job_id),'NOT_FOUND',404);
  await main.db.query("UPDATE users SET status='ACTIVE' WHERE id=$1",[world.bot]);
  // Integrity: a job whose stored progress or checkpoint no longer matches its contract is not exposed.
  await main.db.query('UPDATE quant_foundation_jobs SET next_bar=5 WHERE job_id=$1',[job.job_id]);
  await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
  await main.db.query("UPDATE quant_foundation_jobs SET next_bar=5,checkpoint=$2 WHERE job_id=$1",[job.job_id,JSON.stringify({next_bar:5,state:{},sha256:sha('9')})]);
  await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
});

test('cancel: QUEUED becomes CANCELLED, RUNNING and STOPPING become STOPPING with reason CANCELLED, terminal is unchanged',async()=>{
  const {world,summary}=await fresh();
  const cancelled=await get(main,world.owner,summary.job_id,true);
  assert.equal(cancelled.status,'CANCELLED');
  const row=(await rowsOf(main,summary.job_id)).job;
  assert.equal(row.stop_reason,null);
  assert.deepEqual(await get(main,world.owner,summary.job_id,true),cancelled);
  assert.equal((await main.db.query("SELECT count(*)::int n FROM audit WHERE event='quant.preflight.cancelled' AND trade_id=$1",[summary.job_id])).rows[0].n,1);
  for(const from of ['PAUSED','RUNNING','STOPPING']){
    const {world:w,summary:s}=await fresh();
    await setStatus(s.job_id,from);
    const stopping=await get(main,w.owner,s.job_id,true);
    const stored=(await rowsOf(main,s.job_id)).job;
    assert.equal(stopping.status,from==='PAUSED'?'CANCELLED':'STOPPING',from);
    if(from!=='PAUSED'){
      assert.equal(stored.stop_reason,'CANCELLED');
      assert.equal(stored.lease_until,null);
      assert.ok(stored.lease_token);
      // The slot stays reserved until a physical stop is acknowledged: the fixture releases it.
      await setStatus(s.job_id,'CANCELLED');
    }
  }
  // Another owner cannot cancel: nothing changes.
  const {summary:live}=await fresh();
  const other=await createWorld(main);
  await refuses(get(main,other.owner,live.job_id,true),'NOT_FOUND',404);
  assert.equal((await rowsOf(main,live.job_id)).job.status,'QUEUED');
});

test('detail returns the re-validated envelope only for SUCCEEDED; a tampered result is FOUNDATION_INTEGRITY_FAILED',async()=>{
  const {world,summary,job,bound}=await fresh();
  const resolved=await resolveJob(main,world,summary.job_id);
  const envelope=fixtureEnvelope({resolved,planHash:bound.plan_hash});
  await main.db.query("UPDATE quant_foundation_jobs SET status='SUCCEEDED',result=$2 WHERE job_id=$1",[job.job_id,JSON.stringify(envelope)]);
  const done=await get(main,world.owner,summary.job_id);
  assert.equal(done.status,'SUCCEEDED');
  assert.equal(canonical(done.envelope),canonical(envelope));
  assert.equal(done.engine_current,true);
  assert.equal(done.evaluator_admission,false);
  assert.deepEqual(done.envelope.admission,{development_only:true,evaluator_admission:false,holdout_accessed:false,
    orders_executed:false,execution_model_parity:'V1_ONLY'});
  const listed=(await main.tx(()=>main.service.list(world.owner,world.bot)))[0];
  assert.equal('envelope' in listed,false);
  assert.equal(listed.status,'SUCCEEDED');
  const tampers={admissionFlip:e=>{e.admission.evaluator_admission=true;},etaKey:e=>{e.eta_seconds=5;},
    planSwap:e=>{e.plan_hash=sha('a');},otherBot:e=>{e.bot_id='pf-someone-else';},limitations:e=>{e.limitations.reverse();}};
  for(const edit of Object.values(tampers)){
    const copy=clone(envelope);edit(copy);
    await main.db.query('UPDATE quant_foundation_jobs SET result=$2 WHERE job_id=$1',[job.job_id,JSON.stringify(copy)]);
    await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
  }
  await main.db.query('UPDATE quant_foundation_jobs SET result=NULL WHERE job_id=$1',[job.job_id]);
  await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
  // The same envelope under a stale engine is still valid data; only engine_current changes.
  await main.db.query('UPDATE quant_foundation_jobs SET result=$2 WHERE job_id=$1',[job.job_id,JSON.stringify(envelope)]);
  const stale=main.serviceWith({executableHashes:async()=>({...await main.options.executableHashes(),engine_hash:sha('e')})});
  const old=await main.tx(()=>stale.get(world.owner,summary.job_id));
  assert.equal(old.engine_current,false);
  assert.equal(canonical(old.envelope),canonical(envelope));
});

test('list: the 20 newest summaries of one bot, newest first, no envelope; other bots and owners see nothing of it',async()=>{
  const owned=await createAccounts(main.db,{botCount:2});
  const world=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[0]}});
  const other=await createWorld(main,{accounts:{owner:owned.owner,bot:owned.bots[1]}});
  const planned=await main.service.assemble(world.owner,world.request);
  const base0=Date.now()-100000;
  const ids=[];
  for(let index=0;index<22;index++)
    ids.push(await insertPreflightPair(main.db,{planned,owner:world.owner,bot:world.bot,deploymentId:world.deploymentId,
      profileJobId:world.profileJobId,status:'CANCELLED',now:base0+index*10}));
  const otherSummary=await enqueue(main,other);
  const listed=await main.tx(()=>main.service.list(world.owner,world.bot));
  assert.equal(listed.length,20);
  assert.deepEqual(listed.map(item=>item.job_id),ids.slice(2).reverse());
  for(const item of listed){
    assert.deepEqual(Object.keys(item).sort(),SUMMARY_KEYS.slice().sort());
    assert.equal(item.bot_id,world.bot);
    assert.equal(item.status,'CANCELLED');
    assert.equal(item.plan_hash,planned.plan_hash);
    assert.equal(item.total_bars,2100);
  }
  assert.deepEqual((await main.tx(()=>main.service.list(world.owner,other.bot))).map(item=>item.job_id),[otherSummary.job_id]);
  const stranger=await createAccounts(main.db);
  await refuses(main.tx(()=>main.service.list(stranger.owner,world.bot)),'NOT_FOUND',404);
  await refuses(main.tx(()=>main.service.list(world.owner,stranger.bot)),'NOT_FOUND',404);
  for(const bad of [undefined,null,5,'',MARKER,{}])await refuses(main.tx(()=>main.service.list(world.owner,bad)),'INVALID_FIELDS',400);
  assert.deepEqual(await main.tx(()=>main.service.list(stranger.owner,stranger.bot)),[]);
  // A job whose contract no longer matches its binding is reported as an integrity failure, never listed.
  await main.db.query('UPDATE quant_foundation_jobs SET next_bar=3 WHERE job_id=$1',[ids[21]]);
  await refuses(main.tx(()=>main.service.list(world.owner,world.bot)),'FOUNDATION_INTEGRITY_FAILED',500);
});

test('real scheduler: claim, heartbeat and checkpoint run authorize; a stale deployment revokes; acknowledge needs proof',async()=>{
  const sched=await harness();
  const world=await createWorld(sched);
  const summary=await enqueue(sched,world);
  let proof=false;
  const scheduler=new QuantFoundationScheduler({db:sched.db,health:async()=>({ok:true}),
    authorize:(owner,contract,action,context)=>sched.service.authorize(owner,contract,action,{...context,stopped:proof})});
  // Jobs enter only through the service: the scheduler's own enqueue is refused for kind PREFLIGHT.
  const planned=await sched.service.assemble(world.owner,world.request);
  await assert.rejects(scheduler.enqueue(world.owner,planned.plan.foundation,key()),{code:'FOUNDATION_FORBIDDEN'});
  const claimed=await scheduler.claim('fixture-worker');
  assert.equal(claimed.job_id,summary.job_id);
  assert.equal(claimed.status,'RUNNING');
  await scheduler.heartbeat(claimed);
  const checkpointed=await scheduler.checkpoint(claimed,{next_bar:1,state:{fixture:true}});
  assert.equal(checkpointed.next_bar,1);
  // The stored checkpoint is exposed and integrity checked by the service.
  assert.equal((await get(sched,world.owner,summary.job_id)).next_bar,1);
  await sched.db.query("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE deployment_id=$1",[world.deploymentId]);
  await assert.rejects(scheduler.heartbeat(claimed),{code:'FOUNDATION_FORBIDDEN'});
  await assert.rejects(scheduler.checkpoint(claimed,{next_bar:2,state:{}}),{code:'FOUNDATION_FORBIDDEN'});
  await assert.rejects(scheduler.finish(claimed,{fixture:true}),{code:'FOUNDATION_FORBIDDEN'});
  // The owner can still stop it, and acknowledging the stop needs the supervisor proof.
  assert.equal((await get(sched,world.owner,summary.job_id,true)).status,'STOPPING');
  const stopping=(await rowsOf(sched,summary.job_id)).job;
  await assert.rejects(scheduler.acknowledgeStopped(summary.job_id,stopping.lease_token),{code:'FOUNDATION_FORBIDDEN'});
  proof=true;
  assert.equal((await scheduler.acknowledgeStopped(summary.job_id,stopping.lease_token)).status,'CANCELLED');

  // A stale deployment before claim: the claim itself cancels the job as revoked.
  const second=await createWorld(sched);
  const queued=await enqueue(sched,second);
  await sched.db.query("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE deployment_id=$1",[second.deploymentId]);
  assert.equal(await scheduler.claim('fixture-worker'),null);
  const revoked=(await rowsOf(sched,queued.job_id)).job;
  assert.equal(revoked.status,'CANCELLED');
  assert.equal(revoked.diagnostic,'AUTHORIZATION_REVOKED');
  // A healthy job is claimed after the revoked one.
  const third=await createWorld(sched);
  const ready=await enqueue(sched,third);
  assert.equal((await scheduler.claim('fixture-worker')).job_id,ready.job_id);
});

/** Every adapter call, bound to one job scope and one signal. */
function adapterCalls(trusted,world,plan,signal){
  const scope={owner_id:world.owner,bot_id:world.bot};
  return {authorize:()=>trusted.authorize(scope,{signal}),
    'records.get':()=>trusted.records.get('source',plan.snapshot.source_hash,{...scope,signal}),
    'enrollment.find':()=>trusted.enrollment.find(findQuery(scope,plan),{signal}),
    'provenance.get':()=>trusted.provenance.get(world.scenario.provenanceSha,{...scope,signal}),
    'holdout.boundary':()=>trusted.holdout.boundary({...scope,...HOLDOUT_SCOPE},{signal})};
}

test('adapters check the received signal before every query and only ever read its aborted flag',async()=>{
  const {world,job,bound}=await fresh();
  const plan=JSON.parse(bound.plan_json);
  const aborted=new AbortController();aborted.abort();
  // Pre-aborted: every adapter rejects and sends no SQL at all.
  for(const [name,call] of Object.entries(adapterCalls(main.service.trusted(job),world,plan,aborted.signal))){
    const log=await recordSql(main.db,()=>assert.rejects(call(),error=>hygiene(error,{code:'PREFLIGHT_ADAPTER_UNAVAILABLE',status:503})));
    assert.deepEqual(log,[],name);
  }
  // Aborted after the context was loaded: the adapters that query the database do not query.
  const live=new AbortController(),trusted=main.service.trusted(job);
  const liveCalls=adapterCalls(trusted,world,plan,live.signal);
  assert.equal(await liveCalls.authorize(),true);
  assert.equal(await liveCalls['holdout.boundary']()!==null,true);
  live.abort();
  for(const [name,call] of Object.entries(liveCalls)){
    const log=await recordSql(main.db,()=>assert.rejects(call()));
    assert.deepEqual(log,[],name);
  }
  // The flag is read before each of the queries of the context load: three reads pass, the fourth aborts, two queries ran.
  let reads=0;
  const counting={get aborted(){reads++;return reads>3;}};
  const log=await recordSql(main.db,()=>assert.rejects(adapterCalls(main.service.trusted(job),world,plan,counting).authorize()));
  assert.equal(reads,4);
  assert.equal(log.length,2);
  assert.match(log[0],/FROM pg_catalog\.pg_class/);
  assert.match(log[1],/FROM pg_catalog\.pg_proc/);
  // A signal-like object is only read: frozen, without listener support, it still works while aborted is exactly false.
  const inert=Object.freeze({aborted:false,addEventListener(){throw new Error(MARKER);},removeEventListener(){throw new Error(MARKER);},
    dispatchEvent(){throw new Error(MARKER);}});
  assert.equal(await main.service.trusted(job).authorize({owner_id:world.owner,bot_id:world.bot},{signal:inert}),true);
  // A flag that is not exactly false (or unreadable) counts as aborted; a missing signal cannot be checked and passes.
  const unreadable={get aborted(){throw new Error(MARKER);}};
  for(const bad of [{aborted:true},{aborted:undefined},{aborted:0},{aborted:null},{aborted:'no'},{},unreadable,null,0])
    await assert.rejects(adapterCalls(main.service.trusted(job),world,plan,bad).authorize(),error=>hygiene(error,{code:'PREFLIGHT_ADAPTER_UNAVAILABLE'}));
  assert.equal(await adapterCalls(main.service.trusted(job),world,plan,undefined).authorize(),true);
  // Through the real resolver: an aborted signal ends the resolve as PF2_CANCELLED.
  const controller=new AbortController();controller.abort();
  await resolverCode(resolveJob(main,world,job.job_id,{signal:controller.signal}),'PF2_CANCELLED');
});

test('the signal is checked once more just before the ownership check: an abort there sends no user query',async()=>{
  const {world,job}=await fresh();
  const scope={owner_id:world.owner,bot_id:world.bot};
  // Schema inspection also checks the signal. The final context read is the source revision;
  // an additional signal check must still occur immediately before pine.authorize.
  const attempt=async limit=>{
    const state={reads:0};
    const signal={get aborted(){state.reads++;return state.reads>limit;}};
    const trusted=main.service.trusted(job);
    let outcome;
    const log=await recordSql(main.db,async()=>{
      outcome=await trusted.authorize(scope,{signal}).then(value=>({value}),error=>({error}));
    });
    return {reads:state.reads,log,outcome};
  };
  const passed=await attempt(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(passed.outcome,{value:true});
  const contextQueries=passed.log.filter(sql=>!/FROM users/i.test(sql));
  assert.match(contextQueries.at(-1),/FROM pine_source_revisions/);
  const aborted=await attempt(passed.reads-1);
  assert.equal(aborted.reads,passed.reads);
  assert.ok(aborted.outcome.error,'the final signal read aborts before owner queries');
  hygiene(aborted.outcome.error,{code:'PREFLIGHT_ADAPTER_UNAVAILABLE',status:503});
  assert.deepEqual(aborted.log,contextQueries);
  assert.equal(aborted.log.some(sql=>/FROM users/i.test(sql)),false);
  // One read later the check passes and pine.authorize runs its user queries.
  assert.ok(passed.log.length>contextQueries.length);
  assert.equal(passed.log.slice(contextQueries.length).every(sql=>/FROM users/i.test(sql)),true);
});

test('adapters and the resolver run without any write: only plain SELECT statements, no lock, no row changes',async()=>{
  const {world,summary}=await fresh();
  const tables=['audit','quant_foundation_jobs','quant_preflight_jobs','quant_holdout_boundaries','pine_deployments','pine_sources',
    'pine_source_revisions','pine_memberships','users','risk_profiles','paper_funding'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,
    (await main.db.query('SELECT count(*)::int n,md5(COALESCE(string_agg(x::text,$1 ORDER BY x::text),$2)) digest FROM '+table+' x',['|',''])).rows[0]])));
  const before=await snapshot();
  let resolved;
  const log=await recordSql(main.db,async()=>{resolved=await resolveJob(main,world,summary.job_id);});
  assert.equal(resolved.plan_hash,summary.plan_hash);
  assert.ok(log.length>=8,'the resolver reached the adapters');
  for(const statement of log){
    assert.match(statement,/^\s*SELECT\b/i);
    assert.doesNotMatch(statement,/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b|FOR\s+(UPDATE|SHARE)|pg_advisory/i);
  }
  assert.deepEqual(await snapshot(),before);
  // The adapter read facade cannot reach a writer on the stores.
  const stores=main.service.trusted((await rowsOf(main,summary.job_id)).job).datasets;
  for(const target of [stores.raw,stores.research,stores.research.raw])for(const name of ['publish','publishStream','write','remove','delete','sidecar'])
    assert.equal(name in target,false,name);
});

test('a disabled service or one without a capacity policy refuses every public method with PREFLIGHT_DISABLED',async()=>{
  const world=await createWorld(main);
  const summary=await enqueue(main,world);
  for(const service of [main.serviceWith({enabled:false}),main.serviceWith({capacityPolicy:undefined}),
    main.serviceWith({enabled:undefined})]){
    const calls=[()=>service.enqueue(world.owner,world.request,key()),()=>service.get(world.owner,summary.job_id),
      ()=>service.get(world.owner,summary.job_id,true),()=>service.list(world.owner,world.bot),
      ()=>service.getHoldoutBoundary(world.owner,world.bot),
      ()=>service.registerHoldoutBoundary(world.owner,{bot_id:world.bot,holdout_start_time:START+MINUTE*60})];
    for(const call of calls)await refuses(main.tx(call),'PREFLIGHT_DISABLED',503);
  }
  assert.equal((await rowsOf(main,summary.job_id)).job.status,'QUEUED');
});

test('constructor refuses a missing collaborator with PREFLIGHT_CONFIGURATION_INVALID; trusted() needs stores',()=>{
  const good=main.options;
  new QuantPreflightService(good);
  for(const bad of [{},{...good,pineService:undefined},{...good,pineService:{}},{...good,pineService:{authorize(){}}},
    {...good,dataService:undefined},{...good,dataService:{ready(){}}},{...good,clock:5},{...good,executableHashes:'x'},
    {...good,stores:{}},{...good,supportedSourceHash:'abc'}])
    assert.throws(()=>new QuantPreflightService(bad),error=>hygiene(error,{code:'PREFLIGHT_CONFIGURATION_INVALID',status:500}));
  // Without stores the service works for the API but cannot serve trusted sources.
  const noStores=new QuantPreflightService({...good,stores:undefined});
  assert.throws(()=>noStores.trusted({job_id:randomUUID(),owner_id:'a',contract:{bot_id:'b'}}),error=>hygiene(error,{code:'PREFLIGHT_CONFIGURATION_INVALID'}));
  assert.throws(()=>main.service.trusted(undefined),error=>hygiene(error,{code:'PREFLIGHT_CONFIGURATION_INVALID'}));
});

test('readiness: missing or partial preflight schema and a wrong executor mode are refused before any work',async()=>{
  const bare=await harness();
  const world=await createWorld(bare);
  await bare.service.ready();
  await bare.db.query('DELETE FROM quant_preflight_schema');
  await refuses(enqueue(bare,world),'PREFLIGHT_SCHEMA_REQUIRED',503);
  await bare.db.query('INSERT INTO quant_preflight_schema VALUES(1)');
  await bare.service.ready();
  // Only the version row is not enough: every relation must be present (R2 audit A5).
  await bare.db.query('ALTER TABLE quant_holdout_boundaries RENAME TO quant_holdout_boundaries_gone');
  await refuses(enqueue(bare,world),'PREFLIGHT_SCHEMA_REQUIRED',503);
  await bare.db.query('ALTER TABLE quant_holdout_boundaries_gone RENAME TO quant_holdout_boundaries');
  await bare.db.query('ALTER TABLE quant_preflight_jobs RENAME TO quant_preflight_jobs_gone');
  await refuses(bare.tx(()=>bare.service.list(world.owner,world.bot)),'PREFLIGHT_SCHEMA_REQUIRED',503);
  await bare.db.query('ALTER TABLE quant_preflight_jobs_gone RENAME TO quant_preflight_jobs');
  await bare.service.ready();
  await bare.db.query("UPDATE quant_research_executor_mode SET mode='LEGACY'");
  await refuses(enqueue(bare,world),'RESEARCH_EXECUTOR_MODE_MISMATCH',503);
  await bare.db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  assert.equal((await enqueue(bare,world)).status,'QUEUED');
});

test('an unexpected failure is one fixed code without any message, and rolls the whole enqueue back',async()=>{
  const world=await createWorld(main);
  const boom=()=>{throw new Error(MARKER);};
  const audit=Object.create(main.pine);
  audit.store=Object.create(main.store);
  audit.store.audit=async()=>boom();
  const cases={audit:main.serviceWith({pineService:audit}),hashes:main.serviceWith({executableHashes:async()=>boom()}),
    clock:main.serviceWith({clock:()=>boom()}),badClock:main.serviceWith({clock:()=>-1}),
    ready:main.serviceWith({dataService:{ready:async()=>boom(),scope:main.data.scope.bind(main.data)}}),
    scope:main.serviceWith({dataService:{ready:main.data.ready.bind(main.data),scope:async()=>boom()}})};
  for(const [name,service] of Object.entries(cases)){
    await assert.rejects(main.tx(()=>service.enqueue(world.owner,world.request,key())),error=>{
      hygiene(error,{code:'PREFLIGHT_UNAVAILABLE',status:503});
      assert.equal(String(error.stack).includes(MARKER),false,name);
      return true;
    },name);
  }
  // The audit write is the last statement of enqueue: its failure rolled the job rows back with it.
  assert.equal(await count(main,'quant_preflight_jobs',world.owner),0);
  assert.equal((await main.db.query("SELECT count(*)::int n FROM quant_foundation_jobs WHERE owner_id=$1 AND contract->>'kind'='PREFLIGHT'",[world.owner])).rows[0].n,0);
  assert.equal((await enqueue(main,world)).status,'QUEUED');
  // The registry write is rolled back with its audit row too: nothing is registered when the audit write fails.
  const open=await createWorld(main,{boundary:null});
  // The registry reads the clock for its upper bound: a throwing or unusable clock is the same fixed code, nothing is written.
  for(const name of ['clock','badClock'])
    await assert.rejects(main.tx(()=>cases[name].registerHoldoutBoundary(open.owner,{bot_id:open.bot,holdout_start_time:START+90*MINUTE})),
      error=>hygiene(error,{code:'PREFLIGHT_UNAVAILABLE',status:503}),name);
  assert.deepEqual(await stored(open),[]);
  await assert.rejects(main.tx(()=>cases.audit.registerHoldoutBoundary(open.owner,{bot_id:open.bot,holdout_start_time:START+90*MINUTE})),
    error=>hygiene(error,{code:'PREFLIGHT_UNAVAILABLE',status:503}));
  assert.deepEqual(await stored(open),[]);
  assert.equal((await register(open.owner,{bot_id:open.bot,holdout_start_time:START+90*MINUTE})).registered,true);
});

test('two concurrent enqueues for one bot or one key leave exactly one job (serialization conflict or a fixed refusal)',async()=>{
  const settle=results=>results.map(result=>result.status==='fulfilled'?'ok':result.reason.code);
  const world=await createWorld(main);
  const outcome=settle(await Promise.allSettled([enqueue(main,world),enqueue(main,world)]));
  assert.equal(outcome.filter(item=>item==='ok').length,1,JSON.stringify(outcome));
  // The loser fails with a serialization error (mapped to a retry by the server) or the fixed one-active refusal.
  assert.ok(outcome.some(item=>['40001','PREFLIGHT_ALREADY_ACTIVE'].includes(item)),JSON.stringify(outcome));
  assert.equal(await count(main,'quant_preflight_jobs',world.owner),1);
  const other=await createWorld(main);
  const shared=key();
  const same=settle(await Promise.allSettled([enqueue(main,other,shared),enqueue(main,other,shared)]));
  assert.ok(same.includes('ok'),JSON.stringify(same));
  assert.ok(same.every(item=>['ok','40001','PREFLIGHT_ALREADY_ACTIVE'].includes(item)),JSON.stringify(same));
  assert.equal(await count(main,'quant_preflight_jobs',other.owner),1);
  // Two concurrent registrations of one boundary: one row, the other is a conflict or an idempotent repeat.
  const open=await createWorld(main,{boundary:null});
  const value=START+2800*MINUTE;
  const both=settle(await Promise.allSettled([register(open.owner,{bot_id:open.bot,holdout_start_time:value}),
    register(open.owner,{bot_id:open.bot,holdout_start_time:value+MINUTE})]));
  assert.equal(both.filter(item=>item==='ok').length,1,JSON.stringify(both));
  assert.equal((await stored(open)).length,1);
});

test('rows whose owner column disagrees with their contract are not served (defense in depth, DB does not bind them)',async()=>{
  const other=await createWorld(main);
  // A PROFILE enrollment copy stored under another owner: the column says B, the contract says A.
  const world=await createWorld(main);
  const foreignProfile=await cloneProfile(world,{owner:other.owner});
  await refuses(main.tx(()=>main.service.enqueue(world.owner,{...world.request,profile_job_id:foreignProfile},key())),'PREFLIGHT_ENROLLMENT_REQUIRED',409);
  const planned=await main.service.assemble(world.owner,world.request);
  const pair=await insertPreflightPair(main.db,{planned,owner:world.owner,bot:world.bot,deploymentId:world.deploymentId,profileJobId:foreignProfile});
  const out=await probe(main.service.trusted((await rowsOf(main,pair)).job),world,planned.plan,{owner_id:world.owner,bot_id:world.bot});
  assert.equal(out.enrollment,null);
  assert.ok(Object.entries(out.records).filter(([kind])=>kind!=='deployment_snapshot').every(([,value])=>value===null));
  // A BACKFILL copy stored under another owner gives no capture evidence.
  const rawId=randomUUID();
  const pointed=await createWorld(main,{edits:{enrollment:enrollment=>{enrollment.contract.profile.raw_job_id=rawId;}}});
  await insertFoundationJob(main.db,{jobId:rawId,owner:other.owner,contract:pointed.backfill.contract,result:pointed.backfill.result,
    checkpoint:pointed.backfill.checkpoint,nextBar:pointed.scenario.enrollment.contract.dataset.metadata.total_bars});
  const summary=await enqueue(main,pointed);
  await resolverCode(resolveJob(main,pointed,summary.job_id),'PF2_CAPTURE_EVIDENCE_REQUIRED');
});

test('a source revision of another owner is never read, at enqueue or by the adapters',async()=>{
  const victim=await createWorld(main);
  // The deployment row names the other owner's source (the bytes are identical, so only the scope can refuse it).
  const early=await createWorld(main,{edits:{market:{pine_import_id:victim.importId}}});
  await main.db.query('UPDATE pine_deployments SET pine_import_id=$2 WHERE deployment_id=$1',[early.deploymentId,victim.importId]);
  await refuses(enqueue(main,early),'UNSUPPORTED_SOURCE_HASH',409);
  const {world,summary,job}=await fresh();
  await main.db.query('UPDATE pine_deployments SET pine_import_id=$2 WHERE deployment_id=$1',[world.deploymentId,victim.importId]);
  await resolverCode(resolveJob(main,world,summary.job_id),'PF2_INPUT_UNRESOLVED');
  assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',{job_id:summary.job_id}),{ok:false});
});

/** Holds the global scheduler lock in another transaction while `operation` runs; reports whether it had to wait. */
async function waitsForSchedulerLock(operation){
  let release,locked;
  const held=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{locked=resolve;});
  const holder=main.db.transaction(async()=>{
    await main.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    locked();
    await held;
  });
  await ready;
  const pending=operation();
  const outcome=await Promise.race([pending.then(()=>'done',()=>'done'),new Promise(resolve=>setTimeout(()=>resolve('waiting'),400))]);
  release();
  await holder;
  const result=await pending;
  return {outcome,result};
}

test('enqueue, cancel and registration serialize on the global scheduler lock, like every foundation writer',async()=>{
  const world=await createWorld(main);
  const enqueued=await waitsForSchedulerLock(()=>enqueue(main,world));
  assert.equal(enqueued.outcome,'waiting');
  assert.equal(enqueued.result.status,'QUEUED');
  const cancelled=await waitsForSchedulerLock(()=>get(main,world.owner,enqueued.result.job_id,true));
  assert.equal(cancelled.outcome,'waiting');
  assert.equal(cancelled.result.status,'CANCELLED');
  const open=await createWorld(main,{boundary:null});
  const registered=await waitsForSchedulerLock(()=>register(open.owner,{bot_id:open.bot,holdout_start_time:START+2800*MINUTE}));
  assert.equal(registered.outcome,'waiting');
  assert.equal(registered.result.registered,true);
  // Plain reads never take the lock.
  const read=await waitsForSchedulerLock(()=>get(main,world.owner,enqueued.result.job_id));
  assert.equal(read.outcome,'done');
});

/** Changes a foundation job the way only an operator could: the contract guard trigger is off for the statement. */
async function tamperJob(jobId,assignments,...values){
  await main.db.query('ALTER TABLE quant_foundation_jobs DISABLE TRIGGER quant_foundation_contract_guard');
  try{await main.db.query('UPDATE quant_foundation_jobs SET '+assignments+' WHERE job_id=$1',[jobId,...values]);}
  finally{await main.db.query('ALTER TABLE quant_foundation_jobs ENABLE TRIGGER quant_foundation_contract_guard');}
}

test('a job whose sealed contract or plan binding was tampered out of band is not exposed and not authorized',async()=>{
  const {world,summary,job}=await fresh();
  const context={job_id:summary.job_id};
  assert.deepEqual(await authorize(main,world,job.contract,'CLAIM',context),{ok:true});
  // The seal alone is broken (the contract is untouched and still equals the plan): integrity failure all the same.
  await tamperJob(job.job_id,'contract_hash=$2',sha('9'));
  await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
  await tamperJob(job.job_id,'contract_hash=$2',job.contract_hash);
  assert.equal((await get(main,world.owner,summary.job_id)).status,'QUEUED');
  // Contract edited without its seal: integrity failure.
  const edited={...job.contract,budget:{...job.contract.budget,chunk_bars:999}};
  await tamperJob(job.job_id,'contract=$2',JSON.stringify(edited));
  await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
  await refuses(main.tx(()=>main.service.list(world.owner,world.bot)),'FOUNDATION_INTEGRITY_FAILED',500);
  // Contract and seal edited together: it no longer equals the plan the binding row stores.
  await tamperJob(job.job_id,'contract_hash=$2',hash(canonical(edited)));
  await refuses(get(main,world.owner,summary.job_id),'FOUNDATION_INTEGRITY_FAILED',500);
  assert.deepEqual(await authorize(main,world,edited,'CLAIM',context),{ok:false});
  // A contract that is not the stored plan foundation is refused for every fenced action, whatever the job id.
  for(const variant of [{...job.contract,engine_hash:sha('5')},{...job.contract,snapshot_hash:sha('5')},
    {...job.contract,budget:{...job.contract.budget,chunk_bars:999}},{...job.contract,dataset:{...job.contract.dataset,dataset_id:sha('5')}}])
    for(const action of FENCED)assert.deepEqual(await authorize(main,world,variant,action,context),{ok:false},action);
});
