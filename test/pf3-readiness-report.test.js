import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,canonical} from '../src/pine-bridge/source.js';
import {BLOCKER_RANK,FLAGS,LIMITATIONS,PROJECTION_ASSUMPTIONS,VERDICT,buildReadinessReport,capitalHash,projectActivity,
  summarizePauses} from '../src/postgres/pf3-readiness-report.js';
import {HEALTHY,NOW,account0,changePolicy,createEnvelopeWorld,persistentPause,pf3Facts,sha} from './helpers/pf3-envelope-fixture.js';
import {DEPLOYMENT,MINUTE} from './helpers/pf2-fixture.js';

const RANK=['CONFIGURATION','FAULT','CAPABILITY','ACTIVITY'];
const FAULTS={intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},
  rejected_by_reason:{'Signal is stale':1,'Missing volatility data':1},episodes:{closed:6,losing:2}};
const trades=(count,extra={})=>({intents:{buy:count,exit_sl:count},fills:{buy:count,exit:count,exit_by_reason:{SL:count}},
  episodes:{closed:count,losing:0},...extra});

const codes=report=>report.blockers.map(item=>item.code);
const byCode=(report,code)=>report.blockers.find(item=>item.code===code);

test('PF-3 report builder over validated PF-2 envelopes',async t=>{
  const world=await createEnvelopeWorld(t);
  const S=world.envelope.result.window.evaluation_start_time;
  // Every envelope this suite feeds the builder also passes the production validator.
  const valid=spec=>{const envelope=world.variant(spec);world.validate(envelope);return envelope;};
  const build=(options={})=>{const facts=pf3Facts({variant:valid},options);return {facts,report:buildReadinessReport(facts)};};

  await t.test('a complete healthy world is READY with no blocker, fixed flags and the report identity',()=>{
    const {report}=build();
    assert.equal(report.verdict,VERDICT.READY);assert.deepEqual(report.verdict_basis,[]);assert.deepEqual(report.blockers,[]);
    assert.deepEqual(report.flags,{diagnostic_only:true,saves_nothing:true,starts_nothing:true,run_approval:false,holdout_accessed:false,ai_authoritative:false});
    assert.equal(report.version,'pf3-readiness-v1');assert.equal(report.rules_version,'pf3-rules-v1');
    assert.equal(report.scope,'BINANCE_GLOBAL_BTCUSDT_SPOT_1M_PAPER');assert.equal(report.bot_id,'bot-1');
    assert.equal(report.generated_at,'2026-10-02T12:00:00.000Z');
    assert.equal(report.historical.status,'AVAILABLE');assert.equal(report.historical.unavailable_code,null);
    assert.deepEqual(report.limitations,[...LIMITATIONS]);
    assert.ok(report.limitations.includes('READY_IS_NOT_RUN_APPROVAL'));
    assert.deepEqual(Object.keys(report),['version','rules_version','bot_id','generated_at','scope','flags','verdict','verdict_basis','blockers',
      'current','historical','activity_projection','limitations']);
    assert.deepEqual(Object.keys(report.historical),['status','unavailable_code','latest_job','evidence','window','funnel','rejections','pauses','account_end']);
    assert.deepEqual(report.historical.evidence,{job_id:'job-1',plan_hash:sha('b'),deployment_id:DEPLOYMENT,engine_current:true,policy_current:true,
      capital_current:true,deployment_current:true,execution_model_version:'paper-close-v1',
      acceptance_blockers:['EVALUATOR_PARITY_REQUIRED','SOURCE_SETTINGS_CAPABILITY_REQUIRED'],limitations:world.envelope.limitations});
    assert.ok(Object.isFrozen(FLAGS)&&Object.isFrozen(LIMITATIONS)&&Object.isFrozen(PROJECTION_ASSUMPTIONS));
  });

  await t.test('envelope acceptance blockers and limitations are information only: they never become blockers',()=>{
    const {report}=build();
    assert.equal(report.verdict,VERDICT.READY);
    assert.ok(report.historical.evidence.acceptance_blockers.includes('EVALUATOR_PARITY_REQUIRED'));
    assert.ok(!codes(report).includes('EVALUATOR_PARITY_REQUIRED'));
  });

  await t.test('PF-2 disabled gives CAPABILITY_UNAVAILABLE with PF2_DISABLED and still reports all current facts',()=>{
    const disabled=facts=>{facts.preflightEnabled=false;facts.historical={status:'DISABLED'};};
    const {report}=build({edit:disabled});
    assert.equal(report.verdict,VERDICT.CAPABILITY);assert.deepEqual(report.verdict_basis,['PF2_DISABLED']);
    assert.deepEqual(report.historical,{status:'UNAVAILABLE',unavailable_code:'PF2_DISABLED',latest_job:null,evidence:null,window:null,
      funnel:null,rejections:null,pauses:null,account_end:null});
    assert.equal(report.activity_projection.status,'NOT_AVAILABLE');
    assert.equal(report.current.account.cash,'800');assert.equal(report.current.deployment.deployment_id,DEPLOYMENT);
    assert.equal(report.current.policy.consistency.status,'CONSISTENT');assert.ok(report.current.capacity);
    const bare=build({edit:facts=>{disabled(facts);facts.deployment=null;}}).report;
    assert.deepEqual(bare.verdict_basis,['NO_READY_DEPLOYMENT','PF2_DISABLED']);
    const closed=build({edit:facts=>{disabled(facts);facts.bridgeEnabled=false;facts.deployment=null;}}).report;
    assert.deepEqual(closed.verdict_basis,['BRIDGE_DISABLED','PF2_DISABLED']);assert.equal(closed.current.deployment,null);
  });

  await t.test('verdict ranks CONFIGURATION, FAULT, CAPABILITY, ACTIVITY and lists every blocker',()=>{
    assert.deepEqual(BLOCKER_RANK.map(item=>item[1]),[VERDICT.CONFIGURATION,VERDICT.FAULT,VERDICT.CAPABILITY,VERDICT.ACTIVITY]);
    const every=build({spec:FAULTS,edit:facts=>{
      changePolicy(facts,{killSwitch:true});facts.globalKill=true;facts.daily.loss_streak=3;
      facts.historical.evidence.engineCurrent=false;}}).report;
    assert.equal(every.verdict,VERDICT.CONFIGURATION);
    assert.deepEqual(every.verdict_basis,['KILL_SWITCH_ACTIVE']);
    for(const code of ['KILL_SWITCH_ACTIVE','HISTORICAL_EXECUTION_FAULTS','GLOBAL_KILL_ACTIVE','HISTORICAL_POLICY_STALE','HISTORICAL_ENGINE_CHANGED',
      'CURRENT_LOSS_STREAK_PAUSE'])assert.ok(codes(every).includes(code),code);
    const order=every.blockers.map(item=>RANK.indexOf(item.category));
    assert.deepEqual(order,[...order].sort((a,b)=>a-b));
    assert.ok(order[0]===0&&order.at(-1)===3);
  });

  await t.test('current configuration blockers: each broken setting names itself and gives CONFIGURATION_FAILURE',()=>{
    const cases=[
      ['KILL_SWITCH_ACTIVE',facts=>changePolicy(facts,{killSwitch:true})],
      ['SIDE_MODE_BLOCKS_BUY',facts=>changePolicy(facts,{sideMode:'SELL_ONLY'})],
      ['NEWS_BLOCK_WITHOUT_NEWS_DATA',facts=>changePolicy(facts,{blockDuringNews:true})],
      ['SYMBOL_NOT_ALLOWED',facts=>changePolicy(facts,{allowedSymbols:['ETHUSDT']})],
      ['PAPER_CAPITAL_NOT_FUNDED',facts=>{facts.account.configuredEquity='0';}],
      ['LICENSE_INACTIVE',facts=>{facts.licensed=false;}],
      ['ACCOUNT_SUSPENDED',facts=>{facts.bot.status='SUSPENDED';}],
      ['ACCOUNT_SUSPENDED',facts=>{facts.owner.status='SUSPENDED';}],
      ['BRIDGE_RISK_EXCEEDS_POLICY',facts=>{changePolicy(facts,{maxRiskPercent:0.5});}],
      ['POLICY_CONFIGURATION_CONFLICT',facts=>changePolicy(facts,{maxRiskPercent:'NaN'})],
      ['DEPLOYMENT_SNAPSHOT_STALE',facts=>{facts.deployment.staleCode='STALE_POLICY';}]];
    for(const [code,edit] of cases){
      const report=build({edit}).report;
      assert.equal(report.verdict,VERDICT.CONFIGURATION,code);assert.ok(report.verdict_basis.includes(code),code);
      assert.equal(byCode(report,code).category,'CONFIGURATION');assert.equal(byCode(report,code).source,'CURRENT');
    }
    // A symbol list that still contains the alias of BTCUSDT does not block (Binance Global USD alias).
    assert.ok(!codes(build({edit:facts=>changePolicy(facts,{allowedSymbols:['BTCUSD']})}).report).includes('SYMBOL_NOT_ALLOWED'));
    assert.ok(!codes(build({edit:facts=>changePolicy(facts,{sideMode:'BUY_ONLY'})}).report).includes('SIDE_MODE_BLOCKS_BUY'));
    // Q8: a stale READY deployment is a current configuration blocker carrying the stale code.
    assert.equal(byCode(build({edit:facts=>{facts.deployment.staleCode='STALE_CAPITAL';}}).report,'DEPLOYMENT_SNAPSHOT_STALE').detail,'STALE_CAPITAL');
    assert.equal(build({edit:facts=>{facts.deployment.staleCode='STALE_MEMBERSHIP';}}).report.current.deployment.fresh,false);
    assert.equal(byCode(build({edit:facts=>{changePolicy(facts,{maxRiskPercent:0.5});}}).report,'BRIDGE_RISK_EXCEEDS_POLICY').detail,'1 > 0.5');
  });

  await t.test('current capability blockers: Bridge, deployment, evidence, global kill and uncertain orders',()=>{
    const cases=[
      ['BRIDGE_DISABLED',facts=>{facts.bridgeEnabled=false;}],
      ['NO_READY_DEPLOYMENT',facts=>{facts.deployment=null;}],
      ['DEPLOYMENT_EVIDENCE_MISSING',facts=>{facts.deployment.model=null;facts.deployment.modelCode='BRIDGE_EXECUTION_EVIDENCE_REQUIRED';}],
      ['MULTI_PINE_REQUIRES_APP_3B',facts=>{facts.deployment.members=2;}],
      ['AMBIGUOUS_READY_DEPLOYMENT',facts=>{facts.deployment.ambiguous=true;}],
      ['GLOBAL_KILL_ACTIVE',facts=>{facts.globalKill=true;}],
      ['ORDER_OUTCOME_UNCERTAIN',facts=>{facts.exposure.uncertain=true;}]];
    for(const [code,edit] of cases){
      const report=build({edit}).report;
      assert.equal(report.verdict,VERDICT.CAPABILITY,code);assert.ok(report.verdict_basis.includes(code),code);
      assert.equal(byCode(report,code).category,'CAPABILITY');
    }
    assert.equal(byCode(build({edit:facts=>{facts.deployment.model=null;facts.deployment.modelCode='STALE_EVIDENCE';}}).report,'DEPLOYMENT_EVIDENCE_MISSING').detail,'STALE_EVIDENCE');
    // A deployment whose stored snapshot no longer matches its hash is an integrity fault, not a pass.
    const torn=build({edit:facts=>{facts.deployment.snapshotIntact=false;}}).report;
    assert.equal(torn.verdict,VERDICT.FAULT);assert.equal(byCode(torn,'EVIDENCE_INTEGRITY_FAILED').detail,'DEPLOYMENT_SNAPSHOT_HASH_MISMATCH');
    assert.equal(torn.current.deployment.fresh,false);
  });

  await t.test('stale or foreign evidence is CAPABILITY_UNAVAILABLE and never READY',()=>{
    const cases=[
      ['HISTORICAL_ENGINE_CHANGED',facts=>{facts.historical.evidence.engineCurrent=false;}],
      ['HISTORICAL_POLICY_STALE',facts=>{facts.historical.evidence.planPolicyHash=sha('c');}],
      ['HISTORICAL_CAPITAL_STALE',facts=>{facts.historical.evidence.planCapitalHash=sha('d');}],
      ['HISTORICAL_DEPLOYMENT_NOT_CURRENT',facts=>{facts.deployment.id='another-deployment-1';}]];
    for(const [code,edit] of cases){
      const report=build({edit}).report;
      assert.equal(report.verdict,VERDICT.CAPABILITY,code);assert.deepEqual(report.verdict_basis,[code]);
      assert.equal(byCode(report,code).source,'HISTORICAL');
    }
    // Evidence of an old policy gives no collection estimate.
    const stale=build({edit:facts=>{facts.historical.evidence.planPolicyHash=sha('c');}}).report;
    assert.equal(stale.activity_projection.status,'NOT_AVAILABLE');
    const unbound=build({edit:facts=>{facts.historical.evidence.planCapitalHash=null;}}).report;
    assert.ok(codes(unbound).includes('HISTORICAL_CAPITAL_STALE'));
    // The capital hash is the plan preimage {cash,equity} of the configured funding.
    assert.equal(capitalHash(account0()),hash(canonical({cash:'800',equity:'1000'})));
    assert.equal(capitalHash({configuredBalance:'x',configuredEquity:'1'}),null);
  });

  await t.test('faults, unknown reasons and unexplained EXIT targets give EXECUTION_FAULT_REVIEW_REQUIRED, never hidden',()=>{
    const faults=build({spec:FAULTS}).report;
    assert.equal(faults.verdict,VERDICT.FAULT);assert.deepEqual(faults.verdict_basis,['HISTORICAL_EXECUTION_FAULTS']);
    assert.equal(byCode(faults,'HISTORICAL_EXECUTION_FAULTS').detail,'MISSING_VOLATILITY_DATA 1, SIGNAL_STALE 1');
    const unknown=build({spec:{...FAULTS,rejected_by_reason:{'The evaluator said something new':2}}}).report;
    assert.equal(unknown.verdict,VERDICT.FAULT);assert.deepEqual(unknown.verdict_basis,['HISTORICAL_UNKNOWN_REJECTIONS']);
    assert.equal(unknown.historical.rejections.items[0].code,'UNLISTED_REASON');
    // TARGET_NOT_OPEN that the sampled evidence does not explain is unknown, so the verdict is a fault review.
    const target=world.variant({intents:{buy:6,exit_sl:6},fills:{buy:5,exit:4,exit_by_reason:{SL:4}},episodes:{closed:4,losing:1},
      rejected_by_reason:{'Maximum trades per day reached':1,TARGET_NOT_OPEN:2},samples:{rejections:[
        {time:S+MINUTE,event_type:'BUY',entry_ref:DEPLOYMENT+':'+(S+MINUTE)+':0',reason:'Maximum trades per day reached'},
        {time:S+9*MINUTE,event_type:'EXIT',entry_ref:DEPLOYMENT+':'+(S+4*MINUTE)+':0',reason:'TARGET_NOT_OPEN'},
        {time:S+10*MINUTE,event_type:'EXIT',entry_ref:DEPLOYMENT+':'+(S+5*MINUTE)+':0',reason:'TARGET_NOT_OPEN'}]}});
    world.validate(target);
    const unverified=buildReadinessReport(pf3Facts({variant:()=>target},{}));
    assert.equal(unverified.verdict,VERDICT.FAULT);assert.deepEqual(unverified.verdict_basis,['HISTORICAL_UNKNOWN_REJECTIONS']);
    assert.deepEqual(unverified.historical.rejections.target_not_open,{total:2,verified:0,unverified:2,basis:{WARMUP_ENTRY:0,REJECTED_BUY:0,CLOSED_EARLIER:0}});
    // An EXIT rejected for a reason that is not TARGET_NOT_OPEN is its own fault.
    const exit=build({spec:{intents:{buy:6,exit_sl:6},fills:{buy:6,exit:5,exit_by_reason:{SL:5}},episodes:{closed:5,losing:1},
      rejected_by_reason:{'Signal is stale':1}}}).report;
    assert.ok(codes(exit).includes('EXIT_REJECTED_NON_TARGET'));assert.equal(byCode(exit,'EXIT_REJECTED_NON_TARGET').detail,'1');
    assert.equal(exit.verdict,VERDICT.FAULT);
  });

  await t.test('persistent pause gives INSUFFICIENT_ACTIVITY alone and loses to a fault when both exist',()=>{
    const paused={intents:{buy:9,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:6},
      rejected_by_reason:{'Trading paused after loss streak':3},guards:{loss_streak_final:3,pause:persistentPause('LOSS_STREAK',S+600*MINUTE)}};
    const only=build({spec:paused}).report;
    assert.equal(only.verdict,VERDICT.ACTIVITY);assert.deepEqual(only.verdict_basis,['HISTORICAL_PERSISTENT_PAUSE']);
    assert.equal(byCode(only,'HISTORICAL_PERSISTENT_PAUSE').detail,'LOSS_STREAK');
    assert.equal(only.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');
    assert.equal(only.activity_projection.rate_per_day,null);
    assert.ok(only.activity_projection.targets.every(item=>item.days===null));
    assert.equal(only.historical.rejections.by_category.LOSS_PROTECTION_PAUSE,3);
    const both=build({spec:{...paused,rejected_by_reason:{'Trading paused after loss streak':2,'Signal is stale':1}}}).report;
    assert.equal(both.verdict,VERDICT.FAULT);assert.ok(codes(both).includes('HISTORICAL_PERSISTENT_PAUSE'));
    // The kill switch pause is persistent too.
    const kill=build({spec:{intents:{buy:2},rejected_by_reason:{'Kill switch is active: entries paused':2},
      guards:{kill_switch:true,pause:persistentPause('KILL_SWITCH',S)}}}).report;
    assert.ok(codes(kill).includes('HISTORICAL_PERSISTENT_PAUSE'));
    assert.equal(kill.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');
  });

  await t.test('fewer than five closed episodes is INSUFFICIENT_ACTIVITY; the estimate follows the root thresholds',()=>{
    const status=count=>build({spec:trades(count)}).report;
    const none=build({spec:{}}).report;
    assert.equal(none.verdict,VERDICT.ACTIVITY);assert.equal(byCode(none,'CLOSED_EPISODES_BELOW_MINIMUM').detail,'0 < 5');
    assert.equal(none.activity_projection.status,'NO_ETA_NO_EPISODES');
    for(const count of [1,2]){
      const report=status(count);
      assert.equal(report.verdict,VERDICT.ACTIVITY,String(count));
      assert.equal(report.activity_projection.status,'NO_RATE');assert.equal(report.activity_projection.closed_episodes,count);
      assert.equal(report.activity_projection.rate_per_day,null);
      assert.ok(report.activity_projection.targets.every(item=>item.days===null),'counts only, no day numbers');
    }
    for(const count of [3,4]){
      const report=status(count);
      assert.equal(report.verdict,VERDICT.ACTIVITY,String(count));
      assert.equal(report.activity_projection.status,'ESTIMATED');assert.equal(report.activity_projection.low_evidence,true);
    }
    const five=status(5).activity_projection;
    assert.equal(five.status,'ESTIMATED');assert.equal(five.low_evidence,false);
    assert.equal(status(5).verdict,VERDICT.READY);
    assert.equal(status(4).verdict===VERDICT.READY,false);
  });

  await t.test('historical configuration rejections count only while the evidence is current',()=>{
    const spec={intents:{buy:8,exit_sl:6},fills:{buy:6,exit:6,exit_by_reason:{SL:6}},episodes:{closed:6,losing:2},
      rejected_by_reason:{'Kill switch is active: entries paused':2}};
    const current=build({spec}).report;
    assert.equal(current.verdict,VERDICT.CONFIGURATION);assert.deepEqual(current.verdict_basis,['HISTORICAL_CONFIGURATION_REJECTIONS']);
    assert.equal(byCode(current,'HISTORICAL_CONFIGURATION_REJECTIONS').detail,'KILL_SWITCH 2');
    const stale=build({spec,edit:facts=>{facts.historical.evidence.planPolicyHash=sha('c');}}).report;
    assert.ok(!codes(stale).includes('HISTORICAL_CONFIGURATION_REJECTIONS'));assert.equal(stale.verdict,VERDICT.CAPABILITY);
  });

  await t.test('current loss-streak pause is INSUFFICIENT_ACTIVITY and gives no finite estimate (root decision Q9)',()=>{
    const report=build({edit:facts=>{facts.daily.loss_streak=3;}}).report;
    assert.equal(report.verdict,VERDICT.ACTIVITY);assert.deepEqual(report.verdict_basis,['CURRENT_LOSS_STREAK_PAUSE']);
    assert.equal(byCode(report,'CURRENT_LOSS_STREAK_PAUSE').detail,'3 >= 3');
    assert.equal(report.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');
    assert.equal(report.activity_projection.rate_per_day,null);
    assert.equal(report.current.guards.loss_streak,3);assert.equal(report.current.guards.loss_streak_limit,3);
    // A global kill or a kill switch is also persistent: no finite ETA either.
    assert.equal(build({edit:facts=>{facts.globalKill=true;}}).report.activity_projection.status,'NO_ETA_PERSISTENT_PAUSE');
    assert.equal(build({edit:facts=>{facts.daily.loss_streak=2;}}).report.verdict,VERDICT.READY);
  });

  await t.test('evidence integrity failures map to EXECUTION_FAULT_REVIEW_REQUIRED (root decision Q3)',()=>{
    const tamper=edit=>{const envelope=valid(HEALTHY);edit(envelope);return buildReadinessReport(pf3Facts({variant:()=>envelope},{}));};
    const sums=tamper(envelope=>{envelope.result.counters.orders.accepted+=1;});
    assert.equal(sums.verdict,VERDICT.FAULT);assert.deepEqual(sums.verdict_basis,['EVIDENCE_INTEGRITY_FAILED']);
    assert.equal(sums.historical.status,'UNAVAILABLE');assert.equal(sums.historical.unavailable_code,'EVIDENCE_INTEGRITY_FAILED');
    assert.equal(sums.historical.window,null);assert.equal(sums.activity_projection.status,'NOT_AVAILABLE');
    assert.equal(byCode(sums,'EVIDENCE_INTEGRITY_FAILED').source,'HISTORICAL');
    const holdout=tamper(envelope=>{envelope.admission.holdout_accessed=true;});
    assert.equal(byCode(holdout,'EVIDENCE_INTEGRITY_FAILED').detail,'ADMISSION');
    const side=tamper(envelope=>{envelope.result.counters.orders.rejected_by_reason={'Kill switch is active: entries paused':5};envelope.result.counters.orders.rejected=5;});
    assert.equal(side.verdict,VERDICT.FAULT);
    const shape=tamper(envelope=>{delete envelope.result.counters;});
    assert.equal(byCode(shape,'EVIDENCE_INTEGRITY_FAILED').detail,'SHAPE');
    assert.equal(tamper(envelope=>{envelope.result.guards.pause.periods=[{kind:'NOPE',start_time:1,end_time:2,persistent:false}];}).verdict,VERDICT.FAULT);
  });

  await t.test('PF-2 read outcomes: no succeeded job, unavailable, integrity failure and skipped',()=>{
    const history=(status,code,latest=null)=>facts=>{facts.historical={status,code,latestJob:latest};};
    const running={job_id:'job-2',status:'RUNNING',diagnostic:null,created_at:NOW-1000};
    const none=build({edit:history('NO_SUCCEEDED',null,running)}).report;
    assert.equal(none.verdict,VERDICT.CAPABILITY);assert.deepEqual(none.verdict_basis,['NO_SUCCEEDED_PREFLIGHT']);
    assert.equal(byCode(none,'NO_SUCCEEDED_PREFLIGHT').detail,'RUNNING');
    assert.deepEqual(none.historical.latest_job,{job_id:'job-2',status:'RUNNING',diagnostic:null,created_at:NOW-1000});
    assert.equal(none.historical.unavailable_code,'NO_SUCCEEDED_PREFLIGHT');
    const down=build({edit:history('UNAVAILABLE','PREFLIGHT_SCHEMA_REQUIRED')}).report;
    assert.deepEqual(down.verdict_basis,['PREFLIGHT_UNAVAILABLE']);assert.equal(down.historical.unavailable_code,'PREFLIGHT_SCHEMA_REQUIRED');
    for(const code of ['FOUNDATION_INTEGRITY_FAILED','PREFLIGHT_ENVELOPE_INVALID','PLAN_PROVENANCE_INVALID']){
      const report=build({edit:history('UNAVAILABLE',code)}).report;
      assert.equal(report.verdict,VERDICT.FAULT,code);assert.equal(byCode(report,'EVIDENCE_INTEGRITY_FAILED').detail,code);
    }
    const skipped=build({edit:history('SKIPPED','ACCOUNT_SUSPENDED')}).report;
    assert.ok(codes(skipped).includes('PREFLIGHT_UNAVAILABLE'));
    const missing=build({edit:facts=>{delete facts.historical;}}).report;
    assert.equal(missing.verdict,VERDICT.CAPABILITY);assert.ok(codes(missing).includes('PREFLIGHT_UNAVAILABLE'));
  });

  await t.test('funnel, window and end state are derived from the validated counters with exact labels',()=>{
    const spec={signals:{buy:12,native_exit:3,buy_evaluated:12,native_exit_evaluated:3},intents:{buy:12,exit_sl:4,exit_tp:3,exit_native:3},
      warmup_intents:{buy:0,exit:0},fills:{buy:10,exit:8,exit_by_reason:{SL:3,TP:3,NATIVE:2}},capped:3,
      rejected_by_reason:{'Maximum trades per day reached':2,TARGET_NOT_OPEN:2},episodes:{closed:8,losing:3},
      samples:{rejections:[{time:S+MINUTE,event_type:'BUY',entry_ref:DEPLOYMENT+':'+(S+MINUTE)+':0',reason:'Maximum trades per day reached'},
        {time:S+2*MINUTE,event_type:'BUY',entry_ref:DEPLOYMENT+':'+(S+2*MINUTE)+':0',reason:'Maximum trades per day reached'},
        {time:S+3*MINUTE,event_type:'EXIT',entry_ref:DEPLOYMENT+':'+(S-MINUTE)+':0',reason:'TARGET_NOT_OPEN'},
        {time:S+4*MINUTE,event_type:'EXIT',entry_ref:DEPLOYMENT+':'+(S-2*MINUTE)+':0',reason:'TARGET_NOT_OPEN'}]}};
    const {report}=build({spec});
    const h=report.historical;
    assert.deepEqual(h.funnel.native_signals,{buy:12,native_exit:3,buy_evaluated:12,native_exit_evaluated:3});
    assert.equal(h.funnel.suppressed_buy_evaluated,0);
    assert.deepEqual(h.funnel.bridge_intents,{buy:12,exit_sl:4,exit_tp:3,exit_native:3,total:22});
    assert.deepEqual(h.funnel.warmup_intents,{buy:0,exit:0});
    // capped counts a smaller fill and includes quantity-step rounding.
    assert.deepEqual(h.funnel.orders,{accepted:15,capped:3,rejected:4,buy_rejected:2,exit_rejected:2});
    assert.deepEqual(h.funnel.fills,{buy:10,exit:8,exit_by_reason:{SL:3,TP:3,NATIVE:2}});
    assert.equal(h.funnel.closed_allocations,8);
    assert.deepEqual(h.funnel.episodes,{closed:8,losing:3,non_losing:5});
    assert.deepEqual(h.rejections.target_not_open,{total:2,verified:2,unverified:0,basis:{WARMUP_ENTRY:2,REJECTED_BUY:0,CLOSED_EARLIER:0}});
    assert.deepEqual(h.rejections.side_attribution,{buy_rejected:2,exit_rejected:2,dual_buy:0,dual_exit:0});
    assert.equal(h.rejections.items.reduce((sum,item)=>sum+item.count,0),h.funnel.orders.rejected);
    assert.equal(h.window.total_bars,world.envelope.dataset.total_bars);assert.equal(h.window.warmup_bars,world.envelope.dataset.warmup_bars);
    assert.equal(h.window.evaluated_bars,1000);
    assert.equal(h.window.evaluated_days,'0.6944');assert.equal(h.window.evaluation_start_time,S);
    assert.deepEqual(h.account_end,{cash:'749.5',position_quantity:'0.5',position_cost:'50.25',open_allocations:2,initial:{cash:'800',equity:'1000'}});
  });

  await t.test('pause minutes per kind end an open period one bar after the last bar and flag a truncated list',()=>{
    const last=S+999*MINUTE;
    const pause={persistent:true,active_kinds:['LOSS_STREAK'],truncated:false,dropped_periods:0,periods:[
      {kind:'MAX_TRADES_PER_DAY',start_time:S+10*MINUTE,end_time:S+70*MINUTE,persistent:false},
      {kind:'MAX_DAILY_LOSS',start_time:S+100*MINUTE,end_time:S+130*MINUTE,persistent:false},
      {kind:'LOSS_STREAK',start_time:last-59*MINUTE,end_time:null,persistent:true}]};
    const summary=summarizePauses(pause,last);
    assert.deepEqual(summary.paused_minutes_by_kind,{KILL_SWITCH:0,MAX_TRADES_PER_DAY:60,MAX_DAILY_LOSS:30,LOSS_STREAK:60});
    assert.equal(summary.partial,false);assert.equal(summary.persistent,true);assert.deepEqual(summary.active_kinds,['LOSS_STREAK']);
    const cut=summarizePauses({...pause,truncated:true,dropped_periods:4},last);
    assert.equal(cut.partial,true);assert.equal(cut.truncated,true);assert.equal(cut.dropped_periods,4);
    summary.periods[0].kind='CHANGED';assert.equal(pause.periods[0].kind,'MAX_TRADES_PER_DAY','the summary copies the periods');
    assert.throws(()=>summarizePauses({...pause,periods:[{kind:'LOSS_STREAK',start_time:100,end_time:50,persistent:true}]},last),/EVIDENCE_INTEGRITY_FAILED/);
  });

  await t.test('estimate arithmetic uses Decimal and rounds days up to 0.1',()=>{
    const ten=projectActivity({available:true,closed:10,evaluatedBars:1000});
    assert.equal(ten.status,'ESTIMATED');assert.equal(ten.window_days,'0.6944');assert.equal(ten.rate_per_day,'14.4000');
    assert.deepEqual(ten.targets,[{label:'FIRST_CLOSED_EPISODE',episodes:1,days:'0.1'},{label:'ENGINEERING_PARTITION_MINIMUM',episodes:5,days:'0.4'},
      {label:'PLANNING_TRAIN_TARGET',episodes:30,days:'2.1'}]);
    const three=projectActivity({available:true,closed:3,evaluatedBars:1000});
    assert.equal(three.low_evidence,true);assert.equal(three.rate_per_day,'4.3200');
    assert.deepEqual(three.targets.map(item=>item.days),['0.3','1.2','7.0']);
    assert.equal(projectActivity({available:true,closed:5,evaluatedBars:1000}).low_evidence,false);
    assert.equal(projectActivity({available:true,historicalPause:true,closed:9,evaluatedBars:1000}).status,'NO_ETA_PERSISTENT_PAUSE');
    assert.equal(projectActivity({available:false,closed:9,evaluatedBars:1000}).status,'NOT_AVAILABLE');
    assert.equal(projectActivity({available:false,currentPause:true,closed:null,evaluatedBars:null}).status,'NO_ETA_PERSISTENT_PAUSE','a current pause needs no evidence');
    assert.equal(projectActivity({available:true,currentPause:true,closed:9,evaluatedBars:1000}).rate_per_day,null);
    assert.equal(projectActivity({available:true,closed:9,evaluatedBars:0}).status,'NO_RATE');
    assert.deepEqual(ten.assumptions,['SAME_SOURCE_INPUTS_POLICY_CAPITAL','STATIONARY_ACTIVITY_RATE','V1_CLOSE_FILL_MODEL','NO_NEW_PERSISTENT_PAUSE',
      'SHORT_DEVELOPMENT_WINDOW','NATURAL_SIGNALS_ONLY','NOT_A_GUARANTEE']);
    assert.equal(ten.basis,'PF2_DEVELOPMENT_WINDOW');
    // Every status declares the window and the assumptions; no ETA-like key exists.
    for(const closed of [null,0,1,3,10]){
      const projection=projectActivity({available:closed!==null,closed,evaluatedBars:1000});
      assert.deepEqual(projection.assumptions,[...PROJECTION_ASSUMPTIONS]);assert.equal(projection.basis,'PF2_DEVELOPMENT_WINDOW');
    }
  });

  await t.test('the builder neither changes its input nor aliases it in the result',()=>{
    const facts=pf3Facts({variant:valid},{});
    const before=structuredClone(facts);
    const report=buildReadinessReport(facts);
    assert.deepEqual(facts,before);
    report.historical.pauses.periods.push({kind:'X'});report.historical.funnel.fills.exit_by_reason.X=1;
    report.historical.evidence.acceptance_blockers.push('X');report.current.policy.consistency.issues.push({});
    assert.deepEqual(facts,before);
    // Deep-frozen input must work: the builder only reads it.
    const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
    assert.equal(buildReadinessReport(freeze(pf3Facts({variant:valid},{}))).verdict,VERDICT.READY);
  });
});
