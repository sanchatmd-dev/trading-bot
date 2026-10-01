import {D,Money,exact} from '../money.js';
import {hash,canonical} from '../pine-bridge/source.js';
import {normalizeSymbol} from './domain.js';
import {reviewRiskPolicy,readinessCapacity} from './risk-policy-review.js';
import {CATEGORY,PF3_RULES_VERSION,Pf3IntegrityError,classifyRejections} from './pf3-rejection-classes.js';

/**
 * PF-3 readiness report builder (pf3-readiness-v1): a pure function over facts the service read in one request
 * transaction. No I/O, clock, randomness or mutation of its input. The report is computed per request and never
 * stored. It explains whether the evidence for starting a bounded Paper collection is complete; it never approves a
 * Run, saves a setting or starts a job. Unknown or missing data is a blocker, never a pass. The five verdicts rank
 * CONFIGURATION_FAILURE, EXECUTION_FAULT_REVIEW_REQUIRED, CAPABILITY_UNAVAILABLE, INSUFFICIENT_ACTIVITY and
 * READY_TO_START_PAPER; the highest ranked blocker category decides, and every blocker is still listed.
 */
export const PF3_VERSION='pf3-readiness-v1';
export {PF3_RULES_VERSION};
export const SCOPE='BINANCE_GLOBAL_BTCUSDT_SPOT_1M_PAPER';
export const VERDICT=Object.freeze({CONFIGURATION:'CONFIGURATION_FAILURE',FAULT:'EXECUTION_FAULT_REVIEW_REQUIRED',
  CAPABILITY:'CAPABILITY_UNAVAILABLE',ACTIVITY:'INSUFFICIENT_ACTIVITY',READY:'READY_TO_START_PAPER'});
// Blocker categories in verdict rank order.
export const BLOCKER_RANK=Object.freeze([['CONFIGURATION',VERDICT.CONFIGURATION],['FAULT',VERDICT.FAULT],
  ['CAPABILITY',VERDICT.CAPABILITY],['ACTIVITY',VERDICT.ACTIVITY]]);
export const FLAGS=Object.freeze({diagnostic_only:true,saves_nothing:true,starts_nothing:true,run_approval:false,
  holdout_accessed:false,ai_authoritative:false});
export const MIN_CLOSED_EPISODES=5;
export const NO_RATE_BELOW=3;
export const PROJECTION_TARGETS=Object.freeze([{label:'FIRST_CLOSED_EPISODE',episodes:1},
  {label:'ENGINEERING_PARTITION_MINIMUM',episodes:5},{label:'PLANNING_TRAIN_TARGET',episodes:30}]);
export const PROJECTION_ASSUMPTIONS=Object.freeze(['SAME_SOURCE_INPUTS_POLICY_CAPITAL','STATIONARY_ACTIVITY_RATE',
  'V1_CLOSE_FILL_MODEL','NO_NEW_PERSISTENT_PAUSE','SHORT_DEVELOPMENT_WINDOW','NATURAL_SIGNALS_ONLY','NOT_A_GUARANTEE']);
export const LIMITATIONS=Object.freeze(['DIAGNOSTIC_ONLY','PAPER_ONLY','POINT_IN_TIME_CURRENT_FACTS',
  'COST_BASIS_NOT_MARK_TO_MARKET','HISTORICAL_EVIDENCE_IS_DEVELOPMENT_WINDOW_ONLY','V1_EXECUTION_MODEL_ONLY',
  'COLLECTION_ESTIMATE_IS_NOT_A_GUARANTEE','READY_IS_NOT_RUN_APPROVAL','ENVELOPE_ACCEPTANCE_BLOCKERS_INFORMATIONAL']);
// Errors of the PF-2 read path that mean the stored evidence cannot be trusted (not merely unavailable).
export const INTEGRITY_CODES=Object.freeze(['FOUNDATION_INTEGRITY_FAILED','PREFLIGHT_ENVELOPE_INVALID',
  'PLAN_PROVENANCE_INVALID']);

const MINUTE=60000,DAY_MINUTES=1440;
const GUARD_KINDS=['KILL_SWITCH','MAX_TRADES_PER_DAY','MAX_DAILY_LOSS','LOSS_STREAK'];
const BROKER='binance-global',SYMBOL='BTCUSDT';
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);
const attempt=(operation,fallback=null)=>{try{return operation();}catch{return fallback;}};
const text=(value,cap=400)=>typeof value==='string'?value.slice(0,cap):null;

/** Hash of the capital record a PF-2 plan binds (derivePreflightRecords): {cash,equity} of the configured funding. */
export const capitalHash=account=>attempt(()=>hash(canonical({cash:exact(account.configuredBalance),
  equity:exact(account.configuredEquity)})));

// Fixed decimal places: the figures are shown at the precision they were rounded to.
const places=(value,count,mode=Money.ROUND_HALF_EVEN)=>D(value).toDecimalPlaces(count,mode).toFixed(count);

/**
 * Collection estimate from the PF-2 development window (design 2.6 and root decisions Q4, Q9). Never a promise:
 * the status names why there is no number, and a persistent pause never gets a finite ETA. A pause that holds right
 * now (loss streak, kill switch, global kill) is a current fact and wins even without usable evidence; a pause seen
 * in the evidence window counts only while that evidence is available and current.
 */
export function projectActivity({available,currentPause=false,historicalPause=false,closed,evaluatedBars}){
  const base={status:'NOT_AVAILABLE',basis:'PF2_DEVELOPMENT_WINDOW',window_days:null,closed_episodes:null,
    rate_per_day:null,low_evidence:false,targets:PROJECTION_TARGETS.map(item=>({...item,days:null})),
    assumptions:[...PROJECTION_ASSUMPTIONS]};
  if(!available)return currentPause?{...base,status:'NO_ETA_PERSISTENT_PAUSE'}:base;
  const windowDays=Number.isSafeInteger(evaluatedBars)&&evaluatedBars>0?places(D(evaluatedBars).div(DAY_MINUTES),4):null;
  const shared={...base,window_days:windowDays,closed_episodes:closed};
  if(currentPause||historicalPause)return {...shared,status:'NO_ETA_PERSISTENT_PAUSE'};
  if(closed===0)return {...shared,status:'NO_ETA_NO_EPISODES'};
  if(closed<NO_RATE_BELOW||windowDays===null)return {...shared,status:'NO_RATE'};
  // days(n) = n / (closed / (bars / 1440)), rounded up to 0.1 so the figure is never optimistic.
  const exactDays=n=>D(n).mul(evaluatedBars).div(DAY_MINUTES).div(closed);
  return {...shared,status:'ESTIMATED',low_evidence:closed<MIN_CLOSED_EPISODES,
    rate_per_day:places(D(closed).div(D(evaluatedBars).div(DAY_MINUTES)),4),
    targets:PROJECTION_TARGETS.map(item=>({...item,days:places(exactDays(item.episodes),1,Money.ROUND_UP)}))};
}

/** Pause facts of the envelope plus minutes per guard kind (an open period ends one bar after the last bar). */
export function summarizePauses(pause,lastTime){
  const minutes=Object.fromEntries(GUARD_KINDS.map(kind=>[kind,0]));
  const periods=Array.isArray(pause?.periods)?pause.periods:[];
  for(const period of periods){
    const end=period.end_time===null?lastTime+MINUTE:period.end_time;
    if(!Number.isSafeInteger(end)||!Number.isSafeInteger(period.start_time)||end<period.start_time||!Object.hasOwn(minutes,period.kind))
      throw new Pf3IntegrityError('PAUSE_PERIOD');
    minutes[period.kind]+=(end-period.start_time)/MINUTE;
  }
  return {persistent:pause.persistent===true,active_kinds:[...pause.active_kinds],periods:clone(periods),
    truncated:pause.truncated===true,dropped_periods:pause.dropped_periods,paused_minutes_by_kind:minutes,
    partial:pause.truncated===true};
}

const isCount=value=>Number.isSafeInteger(value)&&value>=0;
const broken=detail=>{throw new Pf3IntegrityError(detail);};

/**
 * Window, funnel, rejection classes, pauses and end state of one validated PF-2 envelope. The envelope already
 * passed validatePreflightEnvelope; the checks here re-derive the sums this report relies on and require the
 * development-only, no-holdout admission, so a defect is EVIDENCE_INTEGRITY_FAILED and never a wrong number.
 */
export function deriveHistorical({envelope,deploymentId=null}){
  const result=envelope?.result,dataset=envelope?.dataset;
  if(!isObject(result)||!isObject(result.counters)||!isObject(result.window)||!isObject(dataset)||!isObject(envelope.admission))
    broken('SHAPE');
  if(envelope.admission.holdout_accessed!==false||envelope.admission.development_only!==true)broken('ADMISSION');
  const {signals,intents,warmup_intents:warmup,orders,fills,episodes}=result.counters;
  const derived=result.derived,w=result.window;
  if(!isObject(signals)||!isObject(intents)||!isObject(warmup)||!isObject(orders)||!isObject(fills)||!isObject(episodes)||
    !isObject(derived))broken('SHAPE');
  const total=intents.buy+intents.exit_sl+intents.exit_tp+intents.exit_native;
  const counts=[total,orders.accepted,orders.sizing_adjusted,orders.rejected,fills.buy,fills.exit,episodes.closed,episodes.losing,
    derived.suppressed_buy_evaluated,w.evaluated_bars,w.last_time,w.evaluation_start_time];
  if(!counts.every(isCount))broken('COUNTERS');
  if(derived.intents_evaluated!==total||orders.accepted+orders.sizing_adjusted+orders.rejected!==total)broken('INTENT_SUM');
  if(fills.buy+fills.exit!==orders.accepted+orders.sizing_adjusted||episodes.closed>fills.exit||episodes.losing>episodes.closed)
    broken('FILL_SUM');
  const rejections=classifyRejections({byReason:orders.rejected_by_reason,intents,fills,samples:result.samples,window:w,deploymentId});
  const funnel={native_signals:{buy:signals.buy,native_exit:signals.native_exit,buy_evaluated:signals.buy_evaluated,
      native_exit_evaluated:signals.native_exit_evaluated},
    suppressed_buy_evaluated:derived.suppressed_buy_evaluated,
    bridge_intents:{buy:intents.buy,exit_sl:intents.exit_sl,exit_tp:intents.exit_tp,exit_native:intents.exit_native,total},
    warmup_intents:{buy:warmup.buy,exit:warmup.exit},
    // sizing_adjusted counts a smaller fill; it includes quantity-step rounding (S1 limitation).
    orders:{accepted:orders.accepted,capped:orders.sizing_adjusted,rejected:orders.rejected,
      buy_rejected:rejections.side_attribution.buy_rejected,exit_rejected:rejections.side_attribution.exit_rejected},
    fills:{buy:fills.buy,exit:fills.exit,exit_by_reason:{...fills.exit_by_reason}},
    closed_allocations:fills.exit,
    episodes:{closed:episodes.closed,losing:episodes.losing,non_losing:episodes.closed-episodes.losing}};
  const window={first_time:w.first_time,evaluation_start_time:w.evaluation_start_time,last_time:w.last_time,
    total_bars:dataset.total_bars,warmup_bars:dataset.warmup_bars,evaluated_bars:w.evaluated_bars,
    evaluated_days:places(D(w.evaluated_bars).div(DAY_MINUTES),4),development_end_time:w.development_end_time,
    holdout_start_time:w.holdout_start_time};
  const account=result.account;
  if(!isObject(account))broken('ACCOUNT');
  return {window,funnel,rejections,pauses:summarizePauses(result.guards?.pause??broken('GUARDS'),w.last_time),
    account_end:{cash:account.cash,position_quantity:account.position_quantity,position_cost:account.position_cost,
      open_allocations:account.open_allocations,initial:null},closed:episodes.closed};
}

const symbolBlocked=policy=>Array.isArray(policy.allowedSymbols)&&policy.allowedSymbols.length>0&&
  !policy.allowedSymbols.some(symbol=>attempt(()=>normalizeSymbol(symbol,BROKER),null)===SYMBOL);

// Day-scoped guards that are active right now (information only: they end at the next UTC day).
function dayScopedPauses(policy,daily,exposure){
  if(policy===null)return [];
  const kinds=[];
  if(attempt(()=>(daily.trades??0)+(exposure.reservedTrades??0)>=policy.maxTradesPerDay,false))kinds.push('MAX_TRADES_PER_DAY');
  if(attempt(()=>D(daily.realized_r??0).lte(D(policy.maxDailyLossR).abs().neg()),false))kinds.push('MAX_DAILY_LOSS');
  return kinds;
}

const pickJob=job=>isObject(job)?{job_id:text(job.job_id,64),status:text(job.status,32),diagnostic:text(job.diagnostic),
  created_at:Number.isSafeInteger(job.created_at)?job.created_at:null}:null;

/** The current-state half of the report: facts of one request, no history. Pure and side-effect free. */
function currentSection(facts,policy,consistency,deployment){
  const account=isObject(facts.account)?facts.account:{},exposure=isObject(facts.exposure)?facts.exposure:{},
    daily=isObject(facts.daily)?facts.daily:{};
  const cashAvailable=attempt(()=>Money.max(0,D(account.cash).minus(exposure.reservedNotional??0).minus(exposure.reservedFees??0))
    .toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed());
  return {
    policy:{source:text(facts.policy?.source,40),hash:facts.policy?.hash??null,saved_hash:facts.policy?.savedHash??null,
      consistency:{status:consistency.status,issues:consistency.issues.map(({field,code,severity})=>({field,code,severity}))}},
    session:{state:text(facts.session?.state,16),run_id:text(facts.session?.run_id,64)},
    account:{cash:account.cash??null,cash_available:cashAvailable,reserved_notional:exposure.reservedNotional??null,
      reserved_fees:exposure.reservedFees??null,book_equity:account.bookEquity??null,position_cost:account.positionCost??null,
      configured_equity:account.configuredEquity??null,configured_balance:account.configuredBalance??null,
      valuation:'COST_BASIS_NOT_MARK_TO_MARKET'},
    capacity:policy!==null&&consistency.status==='CONSISTENT'?attempt(()=>readinessCapacity(policy,daily,exposure)):null,
    exposure:{open_positions:exposure.openPositions??null,has_pending_order:exposure.hasPendingOrder===true,
      uncertain:exposure.uncertain===true,fee_reservation_unknown:exposure.feeReservationUnknown===true},
    guards:{kill_switch:policy?.killSwitch===true,global_kill:facts.globalKill===true,loss_streak:daily.loss_streak??null,
      loss_streak_limit:policy?.pauseAfterLossStreak??null,daily_trades:daily.trades??null,
      max_trades_per_day:policy?.maxTradesPerDay??null,daily_realized_r:daily.realized_r??null,
      max_daily_loss_r:policy?.maxDailyLossR??null,day_scoped_pauses:dayScopedPauses(policy,daily,exposure)},
    deployment:deployment===null?null:{deployment_id:deployment.id,state:'READY',snapshot_hash:deployment.snapshotHash??null,
      fresh:deployment.snapshotIntact!==false&&deployment.staleCode===null,stale_code:deployment.staleCode??null,
      model_version:deployment.model?.version??null,bridge_risk_percent:deployment.model?.risk_percent??null}
  };
}

const unavailableHistory=(code,latest)=>({status:'UNAVAILABLE',unavailable_code:code,latest_job:latest,evidence:null,window:null,
  funnel:null,rejections:null,pauses:null,account_end:null});

/** Blockers of the present configuration and capability (design 2.7). Returns whether a loss-streak pause is active. */
function currentBlockers(facts,policy,consistency,deployment,add){
  const daily=isObject(facts.daily)?facts.daily:{},exposure=isObject(facts.exposure)?facts.exposure:{};
  const intact=deployment!==null&&deployment.snapshotIntact!==false;
  if(!(facts.owner?.status==='ACTIVE'&&facts.bot?.status==='ACTIVE'))add('ACCOUNT_SUSPENDED','CONFIGURATION','CURRENT');
  if(facts.licensed!==true)add('LICENSE_INACTIVE','CONFIGURATION','CURRENT');
  if(consistency.status==='CONFLICT')
    add('POLICY_CONFIGURATION_CONFLICT','CONFIGURATION','CURRENT',consistency.issues.map(issue=>issue.code).join(', '));
  if(policy!==null){
    if(policy.killSwitch===true)add('KILL_SWITCH_ACTIVE','CONFIGURATION','CURRENT');
    if(policy.sideMode==='SELL_ONLY')add('SIDE_MODE_BLOCKS_BUY','CONFIGURATION','CURRENT');
    // Bridge intents carry no news flag, so an enabled news block rejects every BUY.
    if(policy.blockDuringNews===true)add('NEWS_BLOCK_WITHOUT_NEWS_DATA','CONFIGURATION','CURRENT');
    if(symbolBlocked(policy))add('SYMBOL_NOT_ALLOWED','CONFIGURATION','CURRENT');
  }
  if(!attempt(()=>D(facts.account?.configuredEquity).gt(0),false))add('PAPER_CAPITAL_NOT_FUNDED','CONFIGURATION','CURRENT');
  if(intact&&policy!==null&&deployment.model&&attempt(()=>D(deployment.model.risk_percent).gt(policy.maxRiskPercent),false))
    add('BRIDGE_RISK_EXCEEDS_POLICY','CONFIGURATION','CURRENT',deployment.model.risk_percent+' > '+policy.maxRiskPercent);
  if(intact&&deployment.staleCode)add('DEPLOYMENT_SNAPSHOT_STALE','CONFIGURATION','CURRENT',deployment.staleCode);
  if(facts.bridgeEnabled!==true)add('BRIDGE_DISABLED','CAPABILITY','CURRENT');
  else if(deployment===null)add('NO_READY_DEPLOYMENT','CAPABILITY','CURRENT');
  else if(!intact)add('EVIDENCE_INTEGRITY_FAILED','FAULT','CURRENT','DEPLOYMENT_SNAPSHOT_HASH_MISMATCH');
  else{
    if(deployment.ambiguous===true)add('AMBIGUOUS_READY_DEPLOYMENT','CAPABILITY','CURRENT');
    if(Number.isSafeInteger(deployment.members)&&deployment.members!==1)add('MULTI_PINE_REQUIRES_APP_3B','CAPABILITY','CURRENT');
    if(!deployment.model)add('DEPLOYMENT_EVIDENCE_MISSING','CAPABILITY','CURRENT',deployment.modelCode??null);
  }
  if(facts.globalKill===true)add('GLOBAL_KILL_ACTIVE','CAPABILITY','CURRENT');
  if(exposure.uncertain===true)add('ORDER_OUTCOME_UNCERTAIN','CAPABILITY','CURRENT');
  const lossStreakPause=policy!==null&&attempt(()=>Number.isSafeInteger(daily.loss_streak)&&daily.loss_streak>=policy.pauseAfterLossStreak,false);
  if(lossStreakPause)add('CURRENT_LOSS_STREAK_PAUSE','ACTIVITY','CURRENT',daily.loss_streak+' >= '+policy.pauseAfterLossStreak);
  return lossStreakPause;
}

// The initial capital is known only from a snapshot account whose hash equals the capital hash the plan bound.
function initialCapital(bound,candidates){
  for(const candidate of candidates){
    if(!isObject(candidate))continue;
    const shaped=candidate.cash!==undefined&&candidate.equity!==undefined?{cash:candidate.cash,equity:candidate.equity}:
      attempt(()=>({cash:exact(candidate.configuredBalance),equity:exact(candidate.configuredEquity)}));
    if(shaped&&attempt(()=>hash(canonical({cash:shaped.cash,equity:shaped.equity})))===bound)return {cash:shaped.cash,equity:shaped.equity};
  }
  return null;
}

const describe=(items,category)=>items.filter(item=>item.category===category).map(item=>item.code+' '+item.count).join(', ');

/** Blockers and sections drawn from one derived PF-2 envelope (design 2.7, root decisions Q3 and Q5). */
function evidenceBlockers(derived,flags,add){
  const byCategory=derived.rejections.by_category,items=derived.rejections.items;
  if(!flags.engine_current)add('HISTORICAL_ENGINE_CHANGED','CAPABILITY','HISTORICAL');
  if(!flags.policy_current)add('HISTORICAL_POLICY_STALE','CAPABILITY','HISTORICAL');
  if(!flags.capital_current)add('HISTORICAL_CAPITAL_STALE','CAPABILITY','HISTORICAL');
  if(!flags.deployment_current)add('HISTORICAL_DEPLOYMENT_NOT_CURRENT','CAPABILITY','HISTORICAL');
  if(flags.policy_current&&flags.capital_current&&byCategory[CATEGORY.CONFIGURATION]>0)
    add('HISTORICAL_CONFIGURATION_REJECTIONS','CONFIGURATION','HISTORICAL',describe(items,CATEGORY.CONFIGURATION));
  if(byCategory[CATEGORY.FAULT]>0)add('HISTORICAL_EXECUTION_FAULTS','FAULT','HISTORICAL',describe(items,CATEGORY.FAULT));
  if(byCategory[CATEGORY.UNKNOWN]>0)add('HISTORICAL_UNKNOWN_REJECTIONS','FAULT','HISTORICAL',describe(items,CATEGORY.UNKNOWN));
  if(derived.rejections.side_attribution.dual_exit>0)
    add('EXIT_REJECTED_NON_TARGET','FAULT','HISTORICAL',derived.rejections.side_attribution.dual_exit);
  if(derived.pauses.persistent)add('HISTORICAL_PERSISTENT_PAUSE','ACTIVITY','HISTORICAL',derived.pauses.active_kinds.join(', '));
  if(derived.closed<MIN_CLOSED_EPISODES)add('CLOSED_EPISODES_BELOW_MINIMUM','ACTIVITY','HISTORICAL',derived.closed+' < '+MIN_CLOSED_EPISODES);
}

const words=(list,cap=128)=>Array.isArray(list)?list.map(item=>text(item,cap)).filter(Boolean):[];

/** The historical section and its derived data. Returns {historical,derived,flags}; derived is null without usable evidence. */
function historicalPart(facts,deployment,add){
  const source=isObject(facts.historical)?facts.historical:{status:'UNAVAILABLE',code:'HISTORY_FACTS_MISSING'};
  const latest=pickJob(source.latestJob);
  const none=historical=>({historical,derived:null,flags:null});
  if(facts.preflightEnabled!==true||source.status==='DISABLED'){
    add('PF2_DISABLED','CAPABILITY','HISTORICAL');
    return none(unavailableHistory('PF2_DISABLED',null));
  }
  if(source.status==='NO_SUCCEEDED'){
    add('NO_SUCCEEDED_PREFLIGHT','CAPABILITY','HISTORICAL',latest?.status??null);
    return none(unavailableHistory('NO_SUCCEEDED_PREFLIGHT',latest));
  }
  if(source.status!=='EVIDENCE'||!isObject(source.evidence)){
    if(INTEGRITY_CODES.includes(source.code)){
      add('EVIDENCE_INTEGRITY_FAILED','FAULT','HISTORICAL',source.code);
      return none(unavailableHistory(source.code,latest));
    }
    add('PREFLIGHT_UNAVAILABLE','CAPABILITY','HISTORICAL',source.code??null);
    return none(unavailableHistory(text(source.code,64)??'PREFLIGHT_UNAVAILABLE',latest));
  }
  const evidence=source.evidence,summary=isObject(evidence.summary)?evidence.summary:{},envelope=evidence.envelope;
  let derived;
  try{derived=deriveHistorical({envelope,deploymentId:text(summary.deployment_id,128)});}
  catch(error){
    if(!(error instanceof Pf3IntegrityError))throw error;
    add('EVIDENCE_INTEGRITY_FAILED','FAULT','HISTORICAL',error.detail);
    return none(unavailableHistory('EVIDENCE_INTEGRITY_FAILED',latest));
  }
  const flags={engine_current:evidence.engineCurrent===true,
    policy_current:typeof evidence.planPolicyHash==='string'&&evidence.planPolicyHash===facts.policy?.hash,
    capital_current:typeof evidence.planCapitalHash==='string'&&evidence.planCapitalHash===capitalHash(facts.account??{}),
    deployment_current:deployment!==null&&summary.deployment_id===deployment.id};
  evidenceBlockers(derived,flags,add);
  derived.account_end.initial=initialCapital(evidence.planCapitalHash,[facts.account,deployment?.initialCapital]);
  return {derived,flags,historical:{status:'AVAILABLE',unavailable_code:null,latest_job:latest,
    evidence:{job_id:text(summary.job_id,64),plan_hash:text(summary.plan_hash,64),deployment_id:text(summary.deployment_id,128),
      ...flags,execution_model_version:text(envelope.result?.execution_model_version,40),
      acceptance_blockers:words(envelope.acceptance_blockers),limitations:words(envelope.limitations)},
    window:derived.window,funnel:derived.funnel,rejections:derived.rejections,pauses:derived.pauses,account_end:derived.account_end}};
}

/**
 * Builds the pf3-readiness-v1 report. facts (read by the service in one transaction):
 *   now, botId, bridgeEnabled, preflightEnabled, owner{status}, bot{status}, licensed, globalKill,
 *   session{state,run_id}, policy{effective,source,hash,savedHash}, account (binance-global paper account),
 *   exposure, daily, deployment (the READY Bridge deployment facts or null),
 *   historical{status:DISABLED|SKIPPED|UNAVAILABLE|NO_SUCCEEDED|EVIDENCE,code,latestJob,evidence}.
 * The input is never changed and nothing in the result aliases it.
 */
export function buildReadinessReport(facts){
  const blockers=[];
  const add=(code,category,source,detail=null)=>blockers.push({code,category,source,detail:detail===null?null:text(String(detail))});
  const policy=isObject(facts.policy?.effective)?facts.policy.effective:null;
  const consistency=policy===null?{status:'CONFLICT',issues:[{field:'policy',code:text(facts.policy?.error)??'POLICY_UNREADABLE',
    severity:'ERROR'}]}:reviewRiskPolicy(policy);
  const deployment=facts.bridgeEnabled===true&&isObject(facts.deployment)?facts.deployment:null;
  const lossStreakPause=currentBlockers(facts,policy,consistency,deployment,add);
  const {historical,derived,flags}=historicalPart(facts,deployment,add);

  const ranked=BLOCKER_RANK.flatMap(([category])=>blockers.filter(item=>item.category===category));
  const decisive=BLOCKER_RANK.find(([category])=>ranked.some(item=>item.category===category));
  const currentPause=lossStreakPause||policy?.killSwitch===true||facts.globalKill===true;
  const projection=projectActivity({available:derived!==null&&flags.policy_current&&flags.capital_current,currentPause,
    historicalPause:derived?.pauses.persistent===true,closed:derived?.closed??null,evaluatedBars:derived?.window.evaluated_bars??null});
  return {version:PF3_VERSION,rules_version:PF3_RULES_VERSION,bot_id:facts.botId,generated_at:new Date(facts.now).toISOString(),
    scope:SCOPE,flags:{...FLAGS},
    verdict:decisive?decisive[1]:VERDICT.READY,
    verdict_basis:decisive?ranked.filter(item=>item.category===decisive[0]).map(item=>item.code):[],
    blockers:ranked,
    current:currentSection(facts,policy,consistency,deployment),
    historical,activity_projection:projection,limitations:[...LIMITATIONS]};
}
