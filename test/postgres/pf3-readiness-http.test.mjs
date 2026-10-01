import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cp} from 'node:fs/promises';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {createPf2Base,MINUTE} from '../helpers/pf2-fixture.js';
import {createWorld} from '../helpers/preflight-pg-fixture.mjs';
import {HEALTHY,insertBridgeEvidence,persistentPause,withResult} from '../helpers/pf3-envelope-fixture.js';
import {fixtureEnvelope} from '../helpers/preflight-pg-fixture.mjs';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {ReadinessService} from '../../src/postgres/pf3-readiness-service.js';
import {trustedSources} from '../../src/postgres/quant-preflight.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {resolveHistoricalPreflight} from '../../src/quant-research/preflight-resolver.js';
import {hashPassword} from '../../src/security.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';

// PF-3 readiness report over the actual application, auth and SERIALIZABLE response buffering. Isolated local PostgreSQL only.
const REPORT='/api/risk/readiness-report',preflights='/api/quant/data/preflights';
const clean=(overrides={})=>({...structuredClone(config.defaultRisk),blockDuringNews:false,
  equities:{'binance-global':'1000'},balances:{'binance-global':'800'},...overrides});
async function fixture(t,options){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,options);t.after(()=>f.close());return f;
}
// Whole-table digests: any insert, update or delete in these tables changes the digest. A refused request writes only its
// own request.error audit row (server error handling, outside the PF-3 path), which the digest leaves out.
const TABLES=['risk_profiles','paper_funding','paper_snapshots','paper_cash_journal','ledger_streak','ledger_daily','ledger_positions',
  'ledger_position_allocations','signals','bot_sessions','audit','pine_deployments','pine_bridge_evidence','pine_memberships',
  'quant_foundation_jobs','quant_preflight_jobs','quant_holdout_boundaries','users','licenses','system_settings'];
async function digests(db){
  const out={};
  for(const table of TABLES){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    const where=table==='audit'?" WHERE x.event<>'request.error'":'';
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM ${table} x${where}`)).rows[0].d:null;
  }
  return out;
}
const get=(f,session,query='')=>f.request(REPORT+query,'GET',undefined,session);
const codes=report=>report.blockers.map(item=>item.code);
const refuse=(answer,status,code)=>{assert.equal(answer.status,status,JSON.stringify(answer.body));if(code)assert.equal(answer.body.code,code);};

test('PF-2 disabled: CAPABILITY_UNAVAILABLE with full current facts; auth, scope, methods and query are strict; nothing is written',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),foreign=await f.login(f.foreign);
  await f.store.setRisk(f.owner.id,clean());
  assert.equal((await f.request(REPORT)).status,401);
  const before=await digests(f.db);
  const answer=await get(f,owner);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const report=answer.body;
  assert.equal(report.version,'pf3-readiness-v1');assert.equal(report.bot_id,f.owner.id);
  assert.deepEqual(report.flags,{diagnostic_only:true,saves_nothing:true,starts_nothing:true,run_approval:false,holdout_accessed:false,ai_authoritative:false});
  assert.equal(report.verdict,'CAPABILITY_UNAVAILABLE');assert.deepEqual(report.verdict_basis,['NO_READY_DEPLOYMENT','PF2_DISABLED']);
  assert.equal(report.historical.status,'UNAVAILABLE');assert.equal(report.historical.unavailable_code,'PF2_DISABLED');
  assert.equal(report.historical.evidence,null);assert.equal(report.activity_projection.status,'NOT_AVAILABLE');
  assert.equal(report.current.session.state,'SETUP');assert.equal(report.current.policy.source,'SAVED_POLICY');
  assert.equal(report.current.policy.hash,hash(canonical((await f.store.risk(f.owner.id,config.defaultRisk)))));
  assert.equal(report.current.account.cash,'800');assert.equal(report.current.account.configured_equity,'1000');
  assert.equal(report.current.account.valuation,'COST_BASIS_NOT_MARK_TO_MARKET');
  assert.equal(report.current.policy.consistency.status,'CONSISTENT');assert.ok(report.current.capacity);
  assert.equal(report.current.deployment,null);assert.equal(report.current.guards.kill_switch,false);
  assert.deepEqual(report.current.exposure,{open_positions:0,has_pending_order:false,uncertain:false,fee_reservation_unknown:false});
  assert.equal(JSON.stringify(report).includes('"eta"'),false);
  // The shared api() helper sends bot_id: the same bot answers.
  assert.deepEqual((await get(f,owner,'?bot_id='+f.owner.id)).body.current,report.current);
  // Scope: only the owner's bots, exactly one bot, one query key.
  const sibling=await get(f,owner,'?bot_id='+f.sibling.id);
  assert.equal(sibling.status,200);assert.equal(sibling.body.bot_id,f.sibling.id);
  assert.ok(sibling.body.blockers.some(item=>item.code==='PAPER_CAPITAL_NOT_FUNDED'),'the sibling bot has its own, unfunded policy');
  assert.equal(report.current.account.configured_equity,'1000');
  refuse(await get(f,foreign,'?bot_id='+f.owner.id),403);refuse(await get(f,foreign,'?bot_id='+f.sibling.id),403);
  assert.equal((await get(f,foreign)).body.bot_id,f.foreign.id);
  assert.equal((await get(f,foreign)).body.current.account.configured_equity,'0','another owner never sees this owner data');
  assert.equal((await get(f,owner,'?bot_id=all')).status,400);
  for(const query of ['?limit=5','?bot_id=','?bot_id='+f.owner.id+'&bot_id='+f.owner.id,'?bot_id='+f.owner.id+'&extra=1'])
    refuse(await get(f,owner,query),400,'INVALID_FIELDS');
  // GET only.
  for(const method of ['POST','PUT','PATCH','DELETE'])refuse(await f.request(REPORT,method,{},owner),405,'METHOD_NOT_ALLOWED');
  assert.deepEqual(await digests(f.db),before,'no write in any business table');
});

test('PF-2 disabled: each broken current setting is CONFIGURATION_FAILURE; a loss-streak pause is activity with no ETA; reads change nothing',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner),id=f.owner.id;
  const report=async()=>{const answer=await get(f,owner);assert.equal(answer.status,200,JSON.stringify(answer.body));return answer.body;};
  const setPolicy=overrides=>f.store.setRisk(id,clean(overrides));
  const cases=[
    ['KILL_SWITCH_ACTIVE',{killSwitch:true}],['SIDE_MODE_BLOCKS_BUY',{sideMode:'SELL_ONLY'}],
    ['NEWS_BLOCK_WITHOUT_NEWS_DATA',{blockDuringNews:true}],['SYMBOL_NOT_ALLOWED',{allowedSymbols:['ETHUSDT']}],
    ['PAPER_CAPITAL_NOT_FUNDED',{equities:{},balances:{}}]];
  for(const [code,overrides] of cases){
    await setPolicy(overrides);
    const body=await report();
    assert.equal(body.verdict,'CONFIGURATION_FAILURE',code);assert.deepEqual(body.verdict_basis,[code]);
    assert.equal(body.historical.unavailable_code,'PF2_DISABLED','the rest of the picture is still reported');
    assert.ok(codes(body).includes('PF2_DISABLED')&&codes(body).includes('NO_READY_DEPLOYMENT'));
  }
  // A conflicting saved policy is reported with its issue codes, never repaired.
  await setPolicy({defaults:{...config.defaultRisk.defaults,riskPercent:101}});
  const conflict=await report();
  assert.equal(conflict.current.policy.consistency.status,'CONFLICT');
  assert.ok(conflict.blockers.find(item=>item.code==='POLICY_CONFIGURATION_CONFLICT').detail.includes('DEFAULT_OUTSIDE_POLICY'));
  assert.equal(conflict.current.capacity,null);
  assert.equal((await f.store.risk(id,config.defaultRisk)).defaults.riskPercent,101,'the saved policy is untouched');
  // Loss streak at the limit: activity blocker, no finite ETA, streak unchanged.
  await setPolicy({});
  await f.db.query("INSERT INTO ledger_streak VALUES($1,'binance-global:primary','PAPER',3)",[id]);
  const paused=await report();
  assert.equal(paused.current.guards.loss_streak,3);assert.equal(paused.current.guards.loss_streak_limit,3);
  const blocker=paused.blockers.find(item=>item.code==='CURRENT_LOSS_STREAK_PAUSE');
  assert.deepEqual([blocker.category,blocker.source,blocker.detail],['ACTIVITY','CURRENT','3 >= 3']);
  assert.equal(paused.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');assert.equal(paused.activity_projection.rate_per_day,null);
  assert.equal((await f.db.query("SELECT loss_streak FROM ledger_streak WHERE user_id=$1",[id])).rows[0].loss_streak,3);
  // A global kill and a locked session policy are reported as such.
  await f.store.setSetting('globalKill',true);
  const killed=await report();
  assert.ok(codes(killed).includes('GLOBAL_KILL_ACTIVE'));assert.equal(killed.current.guards.global_kill,true);
  await f.store.setSetting('globalKill',false);
  await f.db.query("INSERT INTO bot_sessions(user_id,state,run_id,locked_policy,initial_capital,started_at,stopped_at,updated_at) VALUES($1,'RUNNING','run-1',$2,'{}',1,NULL,1)",
    [id,JSON.stringify(clean({killSwitch:true}))]);
  const running=await report();
  assert.equal(running.current.policy.source,'LOCKED_SESSION');assert.equal(running.current.session.state,'RUNNING');
  assert.equal(running.current.session.run_id,'run-1');assert.ok(codes(running).includes('KILL_SWITCH_ACTIVE'),'the locked policy decides');
  assert.notEqual(running.current.policy.hash,running.current.policy.saved_hash);
  await f.db.query("UPDATE bot_sessions SET locked_policy=NULL WHERE user_id=$1",[id]);
  assert.equal((await report()).current.policy.source,'SAVED_POLICY_FALLBACK');
  // Repeated reads leave every business table as it was.
  const before=await digests(f.db);
  for(let i=0;i<3;i++)await report();
  assert.deepEqual(await digests(f.db),before);
});

test('an inactive license is reported as CONFIGURATION_FAILURE for a USER owner and an active license clears it',async t=>{
  const f=await fixture(t,{mode:'disabled'});
  const password='pf3-'+randomUUID(),user=await f.store.createUser({email:'user-'+randomUUID()+'@example.test',passwordHash:await hashPassword(password),role:'USER'});
  await f.store.setRisk(user.id,clean());
  const session=(await f.request('/api/auth/login','POST',{email:user.email,password})).session;
  const body=(await get(f,session)).body;
  assert.equal(body.verdict,'CONFIGURATION_FAILURE');assert.ok(body.verdict_basis.includes('LICENSE_INACTIVE'));
  const key='ASTRA-PF3-'+randomUUID();
  await f.db.query("INSERT INTO licenses(id,key_hash,key_hint,plan,status,assigned_user_id,expires_at,created_at) VALUES($1,$2,'abcdef','PERSONAL','ACTIVE',$3,$4,$5)",
    [randomUUID(),hash(key),user.id,Date.now()+86400000,Date.now()]);
  assert.ok(!codes((await get(f,session)).body).includes('LICENSE_INACTIVE'));
});

/** One PF-2 world: the actual app with the test policy loader, a bot of the owner, a READY deployment and its enrollment. */
async function stagedWorld(t){
  const base=await createPf2Base(t),scenario=base.defaultScenario;
  const f=await fixture(t,{mode:'test-policy',capacityPolicy:scenario.enrollment.capacity_policy,syntheticSourceHash:scenario.supportedSourceHash});
  await cp(base.root,f.root,{recursive:true});
  const bot=f.sibling.id;
  const world=await createWorld({...f,base},{accounts:{owner:f.owner.id,bot,bots:[bot]},risk:{blockDuringNews:false}});
  await insertBridgeEvidence(f.db,world.deploymentId);
  const owner=await f.login(f.owner),foreign=await f.login(f.foreign);
  const pine=new PineBridgeService(f.store,{defaultRisk:config.defaultRisk});
  /** Enqueue one PF-2 job over HTTP, resolve its envelope like the worker would, and store `spec` as its terminal result. */
  async function succeed(spec,{status='SUCCEEDED'}={}){
    const key='pf3-'+randomUUID();
    const queued=await f.request(preflights,'POST',world.request,owner,{'Idempotency-Key':key});
    assert.equal(queued.status,202,JSON.stringify(queued.body));
    const bound=(await f.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[queued.body.job_id])).rows[0];
    const sources=trustedSources({db:f.db,pine,job_id:bound.job_id,owner_id:world.owner,bot_id:world.bot,capacityPolicy:f.policy,
      stores:{raw:new DatasetStore({root:f.root}),research:new ResearchDatasetStore({root:f.root})}});
    const resolved=await resolveHistoricalPreflight(JSON.parse(bound.plan_json),sources,{now:world.now,supportedSourceHash:world.supportedSourceHash});
    const envelope=withResult(fixtureEnvelope({resolved,planHash:bound.plan_hash}),spec,{deploymentId:world.deploymentId});
    await f.db.query('UPDATE quant_foundation_jobs SET status=$2,result=$3 WHERE job_id=$1',
      [bound.job_id,status,status==='SUCCEEDED'?JSON.stringify(envelope):null]);
    return {jobId:bound.job_id,envelope,planHash:bound.plan_hash};
  }
  const report=async(session=owner,query='?bot_id='+bot)=>{const answer=await get(f,session,query);assert.equal(answer.status,200,JSON.stringify(answer.body));return answer.body;};
  const setResult=(jobId,envelope)=>f.db.query('UPDATE quant_foundation_jobs SET result=$2 WHERE job_id=$1',[jobId,JSON.stringify(envelope)]);
  return {f,base,world,bot,owner,foreign,succeed,report,setResult};
}

test('PF-2 enabled: a staged bot reaches READY only with complete current evidence; every other state names its blocker',async t=>{
  const w=await stagedWorld(t),{f,world,bot,owner,foreign,report,succeed,setResult}=w;
  let healthy=null;
  const S=()=>healthy.envelope.result.window.evaluation_start_time;

  await t.test('no PF-2 job yet: NO_SUCCEEDED_PREFLIGHT, the current half is complete and fresh',async()=>{
    const body=await report();
    assert.equal(body.verdict,'CAPABILITY_UNAVAILABLE');assert.deepEqual(body.verdict_basis,['NO_SUCCEEDED_PREFLIGHT']);
    assert.equal(body.historical.status,'UNAVAILABLE');assert.equal(body.historical.latest_job,null);
    assert.deepEqual(body.current.deployment,{deployment_id:world.deploymentId,state:'READY',snapshot_hash:world.scenario.snapshotHash,
      fresh:true,stale_code:null,model_version:'paper-close-v1',bridge_risk_percent:1});
    assert.equal(body.current.account.configured_equity,'1000');assert.equal(body.bot_id,bot);
  });

  await t.test('a successful healthy PF-2 job gives READY_TO_START_PAPER with the full funnel; the read writes nothing',async()=>{
    const job=healthy=await succeed(HEALTHY);
    const before=await digests(f.db),started=Date.now();
    const body=await report();
    const elapsed=Date.now()-started;
    assert.ok(elapsed<8000,'report latency '+elapsed+' ms');
    console.log('PF-3 report latency with PF-2 evidence: '+elapsed+' ms');
    assert.equal(body.verdict,'READY_TO_START_PAPER',JSON.stringify(body.blockers));
    assert.deepEqual(body.verdict_basis,[]);assert.deepEqual(body.blockers,[]);
    const evidence=body.historical.evidence;
    assert.deepEqual([evidence.job_id,evidence.plan_hash,evidence.deployment_id],[job.jobId,job.planHash,world.deploymentId]);
    assert.deepEqual([evidence.engine_current,evidence.policy_current,evidence.capital_current,evidence.deployment_current],[true,true,true,true]);
    assert.equal(body.historical.latest_job.job_id,job.jobId);assert.equal(body.historical.latest_job.status,'SUCCEEDED');
    assert.deepEqual(body.historical.funnel.episodes,{closed:10,losing:4,non_losing:6});
    assert.deepEqual(body.historical.funnel.orders,{accepted:20,capped:0,rejected:2,buy_rejected:2,exit_rejected:0});
    assert.equal(body.historical.rejections.items[0].code,'MAX_TRADES_PER_DAY');
    assert.deepEqual(body.historical.account_end.initial,{cash:'800',equity:'1000'});
    assert.equal(body.activity_projection.status,'ESTIMATED');assert.equal(body.activity_projection.low_evidence,false);
    assert.equal(body.activity_projection.targets.length,3);
    assert.equal(body.historical.window.holdout_start_time,job.envelope.dataset.holdout_start_time);
    assert.equal(JSON.stringify(body).includes('eta_'),false);
    for(let i=0;i<2;i++)await report();
    assert.deepEqual(await digests(f.db),before,'reading the report writes nothing and takes no row lock effect');
    // The bot's owner reads it; a foreign owner is refused; so is a bot id the owner does not have.
    refuse(await get(f,foreign,'?bot_id='+bot),403);
    refuse(await get(f,owner,'?bot_id='+f.foreign.id),403);
  });

  await t.test('other windows of the same job: no trades, faults, unknown reasons, configuration rejections and a persistent pause',async()=>{
    const job=healthy,variant=spec=>withResult(job.envelope,spec,{deploymentId:world.deploymentId});
    const use=async spec=>{await setResult(job.jobId,variant(spec));return report();};
    const none=await use({});
    assert.equal(none.verdict,'INSUFFICIENT_ACTIVITY');assert.deepEqual(none.verdict_basis,['CLOSED_EPISODES_BELOW_MINIMUM']);
    assert.equal(none.activity_projection.status,'NO_ETA_NO_EPISODES');
    const few=await use({intents:{buy:3,exit_sl:3},fills:{buy:3,exit:3,exit_by_reason:{SL:3}},episodes:{closed:3,losing:1}});
    assert.equal(few.activity_projection.status,'ESTIMATED');assert.equal(few.activity_projection.low_evidence,true);
    const faults=await use({intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
      rejected_by_reason:{'Signal is stale':1,'Missing volatility data':1}});
    assert.equal(faults.verdict,'EXECUTION_FAULT_REVIEW_REQUIRED');assert.deepEqual(faults.verdict_basis,['HISTORICAL_EXECUTION_FAULTS']);
    const unknown=await use({intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
      rejected_by_reason:{'A reason nobody classified':2}});
    assert.equal(unknown.verdict,'EXECUTION_FAULT_REVIEW_REQUIRED');assert.deepEqual(unknown.verdict_basis,['HISTORICAL_UNKNOWN_REJECTIONS']);
    const configuration=await use({intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
      rejected_by_reason:{'Missing news risk data':2}});
    assert.equal(configuration.verdict,'CONFIGURATION_FAILURE');assert.deepEqual(configuration.verdict_basis,['HISTORICAL_CONFIGURATION_REJECTIONS']);
    const paused=await use({intents:{buy:9,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:6},
      rejected_by_reason:{'Trading paused after loss streak':3},guards:{loss_streak_final:3,pause:persistentPause('LOSS_STREAK',S()+300*MINUTE)}});
    assert.equal(paused.verdict,'INSUFFICIENT_ACTIVITY');assert.deepEqual(paused.verdict_basis,['HISTORICAL_PERSISTENT_PAUSE']);
    assert.equal(paused.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');
    assert.ok(paused.historical.pauses.paused_minutes_by_kind.LOSS_STREAK>0);
    assert.equal(paused.historical.pauses.persistent,true);
    await setResult(job.jobId,job.envelope);
    assert.equal((await report()).verdict,'READY_TO_START_PAPER');
  });

  await t.test('a tampered stored result is an integrity failure, an older job and a newer unfinished job are told apart',async()=>{
    const job=healthy,changed=structuredClone(job.envelope);changed.admission.holdout_accessed=true;
    await setResult(job.jobId,changed);
    const torn=await report();
    assert.equal(torn.verdict,'EXECUTION_FAULT_REVIEW_REQUIRED');assert.deepEqual(torn.verdict_basis,['EVIDENCE_INTEGRITY_FAILED']);
    assert.equal(torn.historical.unavailable_code,'FOUNDATION_INTEGRITY_FAILED');assert.equal(torn.historical.funnel,null);
    await setResult(job.jobId,job.envelope);
    const queued=await f.request(preflights,'POST',world.request,owner,{'Idempotency-Key':'pf3-newer-'+randomUUID()});
    assert.equal(queued.status,202,JSON.stringify(queued.body));
    const body=await report();
    assert.equal(body.historical.latest_job.job_id,queued.body.job_id);assert.equal(body.historical.latest_job.status,'QUEUED');
    assert.equal(body.historical.evidence.job_id,job.jobId,'the newest successful job is the evidence');
    assert.equal(body.verdict,'READY_TO_START_PAPER');
    await f.request(preflights+'/'+queued.body.job_id+'/cancel','POST',{},owner);
  });

  await t.test('a later saved-policy change makes the evidence and the READY deployment stale; restoring it makes them current again',async()=>{
    const put=body=>f.request('/api/risk?bot_id='+bot,'PUT',body,owner);
    const saved=await f.store.risk(bot,config.defaultRisk);
    refuse(await put({maxTradesPerDay:saved.maxTradesPerDay+1}),200);
    const stale=await report();
    assert.equal(stale.verdict,'CONFIGURATION_FAILURE');assert.ok(stale.verdict_basis.includes('DEPLOYMENT_SNAPSHOT_STALE'));
    assert.equal(stale.blockers.find(item=>item.code==='DEPLOYMENT_SNAPSHOT_STALE').detail,'STALE_POLICY');
    assert.ok(codes(stale).includes('HISTORICAL_POLICY_STALE'));assert.equal(stale.current.deployment.fresh,false);
    assert.equal(stale.current.deployment.stale_code,'STALE_POLICY');assert.equal(stale.activity_projection.status,'NOT_AVAILABLE');
    assert.equal(stale.historical.evidence.policy_current,false);assert.equal(stale.historical.evidence.capital_current,true);
    refuse(await put({maxTradesPerDay:saved.maxTradesPerDay}),200);
    const restored=await report();
    assert.equal(restored.verdict,'READY_TO_START_PAPER',JSON.stringify(restored.blockers));
    // Configuration blockers on top of fresh evidence: kill switch, news block, SELL_ONLY.
    for(const [code,body] of [['KILL_SWITCH_ACTIVE',{killSwitch:true}],['NEWS_BLOCK_WITHOUT_NEWS_DATA',{blockDuringNews:true}],['SIDE_MODE_BLOCKS_BUY',{sideMode:'SELL_ONLY'}]]){
      refuse(await put(body),200);
      const broken=await report();
      assert.equal(broken.verdict,'CONFIGURATION_FAILURE',code);assert.ok(broken.verdict_basis.includes(code),code);
      assert.ok(broken.verdict_basis.includes('DEPLOYMENT_SNAPSHOT_STALE'));
      refuse(await put({killSwitch:saved.killSwitch,blockDuringNews:saved.blockDuringNews,sideMode:saved.sideMode}),200);
    }
    assert.equal((await report()).verdict,'READY_TO_START_PAPER');
    assert.equal(hash(canonical(await f.store.risk(bot,config.defaultRisk))),hash(canonical(saved)),'the policy is back to the staged one');
  });

  await t.test('missing Bridge evidence, a replaced deployment and a loss streak at the limit are named; the streak is not reset',async()=>{
    const evidence=(await f.db.query('SELECT * FROM pine_bridge_evidence WHERE deployment_id=$1',[world.deploymentId])).rows[0];
    await f.db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[world.deploymentId]);
    const missing=await report();
    assert.equal(missing.verdict,'CAPABILITY_UNAVAILABLE');assert.deepEqual(missing.verdict_basis,['DEPLOYMENT_EVIDENCE_MISSING']);
    assert.equal(missing.blockers[0].detail,'BRIDGE_EXECUTION_EVIDENCE_REQUIRED');assert.equal(missing.current.deployment.model_version,null);
    await f.db.query('INSERT INTO pine_bridge_evidence VALUES($1,$2,$3,$4,$5)',[evidence.deployment_id,evidence.snapshot_hash,JSON.stringify(evidence.evidence),evidence.evidence_hash,evidence.recorded_at]);
    await f.db.query("UPDATE pine_deployments SET state='EXIT_ONLY' WHERE deployment_id=$1",[world.deploymentId]);
    const replaced=await report();
    assert.equal(replaced.verdict,'CAPABILITY_UNAVAILABLE');assert.ok(codes(replaced).includes('NO_READY_DEPLOYMENT'));
    assert.ok(codes(replaced).includes('HISTORICAL_DEPLOYMENT_NOT_CURRENT'));assert.equal(replaced.current.deployment,null);
    await f.db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[world.deploymentId]);
    await f.db.query("INSERT INTO ledger_streak VALUES($1,'binance-global:primary','PAPER',3)",[bot]);
    const paused=await report();
    assert.equal(paused.verdict,'INSUFFICIENT_ACTIVITY');assert.deepEqual(paused.verdict_basis,['CURRENT_LOSS_STREAK_PAUSE']);
    assert.equal(paused.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');assert.equal(paused.activity_projection.rate_per_day,null);
    assert.equal((await f.db.query("SELECT loss_streak FROM ledger_streak WHERE user_id=$1",[bot])).rows[0].loss_streak,3);
    await f.db.query("DELETE FROM ledger_streak WHERE user_id=$1",[bot]);
    assert.equal((await report()).verdict,'READY_TO_START_PAPER');
  });
});

test('the report runs in a read-only transaction: no write, no row lock, no wait on locks held elsewhere',async t=>{
  const f=await fixture(t,{mode:'disabled'}),owner=await f.login(f.owner);
  await f.store.setRisk(f.owner.id,clean());
  const service=new ReadinessService({store:f.store,defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true});
  // Inside one transaction the report is followed by a write: the transaction is read-only after the report.
  let written=null;
  await f.db.transaction(async()=>{
    const report=await service.report(f.owner.id,f.owner.id);
    assert.equal(report.version,'pf3-readiness-v1');
    written=await f.db.query("INSERT INTO system_settings(key,value) VALUES('pf3-probe','1')").catch(error=>error);
  },{isolation:'SERIALIZABLE'});
  assert.equal(written.code,'25006',String(written.message));
  let locked=null;
  await f.db.transaction(async()=>{
    await service.report(f.owner.id,f.owner.id);
    locked=await f.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[f.owner.id]).catch(error=>error);
  },{isolation:'SERIALIZABLE'});
  assert.equal(locked.code,'25006','a row lock is refused too');
  assert.equal((await f.db.query("SELECT count(*)::int n FROM system_settings WHERE key='pf3-probe'")).rows[0].n,0);
  // Outside a request transaction the service opens its own and is read-only as well.
  assert.equal((await service.report(f.owner.id,f.owner.id)).bot_id,f.owner.id);
  await assert.rejects(()=>service.report(f.owner.id,f.foreign.id),error=>error.code==='BOT_ACCESS_DENIED'&&error.status===403);
  await assert.rejects(()=>service.report(7,'x'),error=>error.code==='INVALID_FIELDS');
  assert.throws(()=>new ReadinessService({}),error=>error.code==='PF3_CONFIGURATION_INVALID');
  assert.throws(()=>new ReadinessService({store:f.store,defaultRisk:config.defaultRisk,preflightEnabled:true}),error=>error.code==='PF3_CONFIGURATION_INVALID');
  // A transaction that holds the row locks of the owner and the bot does not delay the HTTP report.
  await f.db.transaction(async()=>{
    await f.db.query('SELECT id FROM users WHERE id=ANY($1) FOR UPDATE',[[f.owner.id,f.sibling.id]]);
    const started=Date.now();
    const answer=await Promise.race([get(f,owner),new Promise(resolve=>setTimeout(()=>resolve({status:'WAITED'}),6000))]);
    assert.equal(answer.status,200,'the report waited on a row lock');
    assert.ok(Date.now()-started<6000);
  });
});

test('a PF-2 service that is off is never queried (the report works without the PF-2 tables); a suspended bot is a configuration blocker',async t=>{
  const f=await fixture(t,{mode:'disabled',missingPreflightSchema:true}),owner=await f.login(f.owner);
  await f.store.setRisk(f.owner.id,clean());
  assert.equal((await f.db.query("SELECT to_regclass('public.quant_preflight_jobs') AS name")).rows[0].name,null);
  const answer=await get(f,owner);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.equal(answer.body.historical.unavailable_code,'PF2_DISABLED');assert.equal(answer.body.verdict,'CAPABILITY_UNAVAILABLE');
  // A suspended bot is a configuration blocker; the owner still sees its report.
  await f.db.query("UPDATE users SET status='SUSPENDED' WHERE id=$1",[f.sibling.id]);
  const suspended=await get(f,owner,'?bot_id='+f.sibling.id);
  assert.equal(suspended.status,200);assert.ok(codes(suspended.body).includes('ACCOUNT_SUSPENDED'));
  assert.equal(suspended.body.verdict,'CONFIGURATION_FAILURE');
});

test('the service issues SET TRANSACTION READ ONLY first and then SELECT statements only, with no locking clause',async t=>{
  const f=await fixture(t,{mode:'disabled'});
  await f.store.setRisk(f.owner.id,clean());
  const statements=[];
  const recorded=new Proxy(f.db,{get(target,prop,receiver){
    if(prop==='query')return (sql,params)=>{statements.push(String(sql));return target.query(sql,params);};
    const value=Reflect.get(target,prop,receiver);return typeof value==='function'?value.bind(receiver):value;}});
  const {Store}=await import('../../src/postgres/store.js');
  const service=new ReadinessService({store:new Store(recorded),defaultRisk:config.defaultRisk,preflightEnabled:false,pineBridgeEnabled:true});
  assert.equal((await service.report(f.owner.id,f.owner.id)).verdict,'CAPABILITY_UNAVAILABLE');
  assert.ok(statements.length>10,'the report reads many rows: '+statements.length);
  assert.match(statements[0],/^\s*SET TRANSACTION READ ONLY\s*$/);
  for(const sql of statements.slice(1)){
    assert.match(sql,/^\s*(SELECT|WITH)\b/i,sql.slice(0,80));
    assert.doesNotMatch(sql,/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i,'a row lock: '+sql.slice(0,80));
    assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|MERGE|LOCK|TRUNCATE|CREATE|ALTER|DROP|NEXTVAL|PG_ADVISORY\w*)\b/i,'a write or lock: '+sql.slice(0,80));
  }
});
