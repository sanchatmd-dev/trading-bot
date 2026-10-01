import {BOT,DEPLOYMENT as FIXTURE_DEPLOYMENT,MINUTE,OWNER,createPf2Base,makeWorld,policyRecord} from './pf2-fixture.js';
import {fixtureEnvelope} from './preflight-pg-fixture.mjs';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {buildPreflightPlan,validatePreflightEnvelope} from '../../src/quant-research/preflight-plan.js';
import {classifyReason} from '../../src/postgres/pf3-rejection-classes.js';
import {config} from '../../src/config.js';
import {capitalHash} from '../../src/postgres/pf3-readiness-report.js';

/**
 * PF-3 test helper: rebuilds the S1 result of a PF-2 envelope from a compact description so that every S4 invariant
 * of validatePreflightEnvelope still holds (counters add up, samples match the counters, guards agree). It changes
 * only envelope.result; binding, dataset, run, admission and limitations stay those of the base envelope. This is a
 * labeled test fixture, never a replay result.
 */
const sum=values=>values.reduce((total,value)=>total+value,0);
const DEPLOYMENT=FIXTURE_DEPLOYMENT;
const EXIT_REASONS=['SL','TP','NATIVE'];

/** Persistent pause facts for the guard section (KILL_SWITCH must start at the first evaluated bar). */
export const persistentPause=(kind,start)=>({persistent:true,active_kinds:[kind],
  periods:[{kind,start_time:start,end_time:null,persistent:true}],truncated:false,dropped_periods:0});
export const noPause=()=>({persistent:false,active_kinds:[],periods:[],truncated:false,dropped_periods:0});

function fillSamples(spec,fills,S,deploymentId){
  const out=[],reasons=EXIT_REASONS.flatMap(name=>Array(fills.exit_by_reason[name]??0).fill(name));
  const limit=Math.min(200,fills.buy+fills.exit);
  const entry=index=>deploymentId+':'+(S+(index+1)*MINUTE)+':0';
  for(let index=0;index<fills.buy&&out.length<limit;index++)
    out.push({time:S+(index+1)*MINUTE,event_type:'BUY',entry_ref:entry(index),reason:null,sizing_outcome:index<spec.capped?'CAPPED':'ACCEPTED',
      quantity:'0.5',price:'100.5',notional:'50.25',fee:'0.05'});
  for(let index=0;index<fills.exit&&out.length<limit;index++)
    out.push({time:S+(fills.buy+index+1)*MINUTE,event_type:'EXIT',entry_ref:entry(index),reason:reasons[index]??'SL',sizing_outcome:'ACCEPTED',
      quantity:'0.5',price:'100.5',notional:'50.25',fee:'0.05'});
  return out;
}

function rejectionSamples(byReason,S,deploymentId){
  const out=[],limit=Math.min(200,sum(Object.values(byReason)));
  let step=0;
  for(const [reason,count] of Object.entries(byReason).sort(([a],[b])=>a<b?-1:a>b?1:0)){
    const exit=classifyReason(reason)?.side==='EXIT';
    for(let index=0;index<count&&out.length<limit;index++){
      step++;
      // A TARGET_NOT_OPEN exit points at an entry from a warm-up bar, so the relationship is verifiable.
      out.push({time:S+step*MINUTE,event_type:exit?'EXIT':'BUY',
        entry_ref:deploymentId+':'+(exit?S-(step+1)*MINUTE:S+step*MINUTE)+':0',reason});
    }
  }
  return out;
}

/** The S1 result for `spec` over the window of `base` (an envelope). */
export function pf3Result(base,spec={},{deploymentId=DEPLOYMENT}={}){
  const {window,plan_hash:planHash,execution_model_version:model,admission,limitations}=base.result;
  const S=window.evaluation_start_time;
  const intents={buy:0,exit_sl:0,exit_tp:0,exit_native:0,...spec.intents};
  const warmup={buy:0,exit:0,...spec.warmup_intents};
  const fills={buy:0,exit:0,exit_by_reason:{},...spec.fills};
  if(spec.fills&&!spec.fills.exit_by_reason&&fills.exit>0)fills.exit_by_reason={SL:fills.exit};
  const episodes={closed:0,losing:0,...spec.episodes};
  const byReason={...spec.rejected_by_reason},rejected=sum(Object.values(byReason));
  const capped=spec.capped??0,accepted=fills.buy+fills.exit-capped,total=sum(Object.values(intents));
  const signals={buy:intents.buy+warmup.buy,native_exit:intents.exit_native,buy_evaluated:intents.buy,
    native_exit_evaluated:intents.exit_native,...spec.signals};
  const open=fills.buy-fills.exit;
  const guards={kill_switch:false,loss_streak_final:0,pause:noPause(),...spec.guards};
  return {version:base.result.version,plan_hash:planHash,execution_model_version:model,window:{...window},
    counters:{signals,intents,warmup_intents:warmup,orders:{accepted,sizing_adjusted:capped,rejected,rejected_by_reason:byReason},
      fills,episodes},
    derived:{intents_evaluated:total,suppressed_buy:signals.buy-intents.buy-warmup.buy,
      suppressed_buy_evaluated:signals.buy_evaluated-intents.buy,non_losing_episodes:episodes.closed-episodes.losing},
    guards,
    account:{cash:open===0?'800':'749.5',position_quantity:open===0?'0':'0.5',position_cost:open===0?'0':'50.25',open_allocations:open,
      ...spec.account},
    samples:{fills:spec.samples?.fills??fillSamples({capped},fills,S,deploymentId),
      rejections:spec.samples?.rejections??rejectionSamples(byReason,S,deploymentId)},
    admission:{...admission},limitations:[...base.result.limitations]};
}

/** A copy of `base` whose result follows `spec`. */
export function withResult(base,spec,options){
  const envelope=structuredClone(base);
  envelope.result=pf3Result(base,spec,options);
  return envelope;
}

/** A healthy window: ten closed episodes, two day-capped BUY rejections, nothing unexplained. */
export const HEALTHY={intents:{buy:12,exit_sl:6,exit_tp:4},fills:{buy:10,exit:10,exit_by_reason:{SL:6,TP:4}},
  rejected_by_reason:{'Maximum trades per day reached':2},episodes:{closed:10,losing:4},guards:{loss_streak_final:1}};

/**
 * A real validated PF-2 envelope world without a database: synthetic datasets, a built plan, the resolver output and
 * a no-trade base envelope. validate(envelope) runs the production validatePreflightEnvelope against the built plan.
 */
export async function createEnvelopeWorld(t){
  const base=await createPf2Base(t);
  const scenario=await base.scenario({policy:{...policyRecord(),blockDuringNews:false}});
  const {contract,result,capacity_policy:policy}=scenario.enrollment;
  const clone=value=>structuredClone(value);
  const built=buildPreflightPlan({owner_id:OWNER,bot_id:BOT,deployment_id:FIXTURE_DEPLOYMENT,
    enrollment:{contract:clone(contract),result:clone(result),contract_hash:hash(canonical(contract)),status:'SUCCEEDED'},
    deployment:{deployment_id:FIXTURE_DEPLOYMENT,owner_id:OWNER,bot_id:BOT,state:'READY',snapshot:clone(scenario.snapshot),
      snapshot_hash:scenario.snapshotHash,pine_import_id:'pine-import-fixture-1',source_version:1,created_at:1},
    source:{source:scenario.source,source_hash:scenario.supportedSourceHash},
    boundary:{holdout_start_time:contract.dataset.metadata.end_time},executables:{...base.executables},
    capacityPolicy:clone(policy),supportedSourceHash:scenario.supportedSourceHash});
  const world=makeWorld(base,scenario);world.plan=clone(built.plan);
  const resolved=await world.resolve();
  const envelope=fixtureEnvelope({resolved,planHash:built.plan_hash});
  const validate=candidate=>validatePreflightEnvelope(built.plan.foundation,candidate,{planHash:built.plan_hash,plan:built.plan});
  return {base,scenario,built,resolved,envelope,validate,variant:spec=>withResult(envelope,spec)};
}

export const NOW=Date.UTC(2026,9,2,12,0,0);
export const sha=letter=>letter.repeat(64);
export const policy0=()=>({...structuredClone(config.defaultRisk),blockDuringNews:false,equities:{'binance-global':'1000'},balances:{'binance-global':'800'}});
export const account0=()=>({cash:'800',positionCost:'0',bookEquity:'1000',configuredEquity:'1000',configuredBalance:'800'});
/** The facts the service would read for a healthy staged bot; edit mutates a fresh copy. */
export function pf3Facts(world,{spec=HEALTHY,edit}={}){
  const policy=policy0(),account=account0(),envelope=world.variant(spec);
  const facts={now:NOW,botId:'bot-1',bridgeEnabled:true,preflightEnabled:true,owner:{status:'ACTIVE'},bot:{status:'ACTIVE'},
    licensed:true,globalKill:false,session:{state:'SETUP',run_id:null},
    policy:{effective:policy,error:null,source:'SAVED_POLICY',hash:hash(canonical(policy)),savedHash:hash(canonical(policy))},
    account,exposure:{reservedNotional:'0',reservedFees:'0',reservedTrades:0,openPositions:0,hasPendingOrder:false,uncertain:false,
      feeReservationUnknown:false},daily:{trades:0,notional:'0',realized_r:'0',loss_streak:0},
    deployment:{id:DEPLOYMENT,state:'READY',snapshotHash:sha('a'),ambiguous:false,snapshotIntact:true,staleCode:null,members:1,
      model:{version:'paper-close-v1',risk_percent:1},modelCode:null,initialCapital:{cash:'800',equity:'1000'}},
    historical:{status:'EVIDENCE',latestJob:{job_id:'job-1',status:'SUCCEEDED',diagnostic:null,created_at:NOW-3600000},
      evidence:{summary:{job_id:'job-1',plan_hash:sha('b'),deployment_id:DEPLOYMENT,status:'SUCCEEDED'},envelope,engineCurrent:true,
        planPolicyHash:hash(canonical(policy)),planCapitalHash:capitalHash(account)}}};
  edit?.(facts);
  return facts;
}
// A saved-policy change as the service sees it: the effective policy and its hash move, the evidence keeps the old hash.
export const changePolicy=(facts,change)=>{
  Object.assign(facts.policy.effective,change);
  facts.policy.hash=hash(canonical(facts.policy.effective));
};

/** Bridge execution evidence of a deployment, as the activation gate stores it (isolated fixture, not a real review). */
export async function insertBridgeEvidence(db,deploymentId,{riskPercent=1}={}){
  const row=(await db.query('SELECT snapshot,snapshot_hash FROM pine_deployments WHERE deployment_id=$1',[deploymentId])).rows[0];
  const evidence={snapshot_hash:row.snapshot_hash,artifact_hash:row.snapshot.artifact_hash,source_hash:row.snapshot.source_hash,
    compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,
    duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,
    execution_model:{version:'paper-close-v1',price_tick:0.01,quantity_step:0.001,fee_bps:10,slippage_bps:5,risk_percent:riskPercent,
      data_profile:'closed-ohlcv-atr14-v1'},
    references:{tradingview:'isolated fixture; not real compilation',source_review:'isolated fixture source review',paper_fixture:'isolated fixture gate validation'}};
  await db.query('INSERT INTO pine_bridge_evidence VALUES($1,$2,$3,$4,$5)',
    [deploymentId,row.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),Date.now()]);
}
