import {canonical,hash} from '../pine-bridge/source.js';
import {readJson} from './http.js';
import {CODES,MINUTE,REQUIRED_MARKET,isObject} from '../comparison/common.js';
import {validateRequest,contextFields,contextMismatches} from '../comparison/context.js';
import {validateSpec} from '../comparison/ranking.js';
import {resolvePeriod,checkDatasetGaps,PERIOD_CHOICES} from '../comparison/period.js';
import {FIXED_NOTICES,NO_WINNER_TEXT} from '../comparison/labels.js';
import {metricsView} from '../comparison/evidence.js';
import {excessReturn} from '../comparison/valuation.js';
import {createComparison,cancelComparison,readComparison,readComparisonResults} from './comparison-store.js';
import {validateResearchContractV2,CONTENT_DIGEST_SQL} from '../quant-research/research-contract-v2.js';
import {buildParticipantContext,warmupBarsOf} from './qr3-participant-context.js';
import {readIndependence,INDEPENDENCE_BUDGET} from './qr3-independence.js';
import {gateSnapshot} from './quant-library.js';
import {marketKey} from '../quant-library/derive.js';

/**
 * QR-3 S4 owner API (contract 11.3, root rulings SB177 and SB184 RR-12): four owner-scoped actions behind QR3_COMPARISON_ENABLED, off by default.
 *   POST /api/quant/comparisons              create: freezes the spec and writes one exposure event per participant (SPEC_FROZEN). Starts no evaluation.
 *   GET  /api/quant/comparisons/:id          view: spec, statuses, stored results once COMPLETE, derived STALE. Read only.
 *   POST /api/quant/comparisons/:id/cancel   cancel: SPEC_FROZEN or EVALUATING to CANCELLED.
 *   POST /api/quant/comparisons/:id/replay   record replay of a COMPLETE comparison (RR-12): confirm token, one replay event, the outcome row never changes.
 * Nothing else is mounted. When the flag is off the module answers false before it reads anything, so every path falls through to the router's own 404.
 *
 * The caller (the user router) has already required a session with own:read or own:write and, for POST, the canonical CSRF check; the module asks the auth
 * object again for a POST and refuses a session that is not the routed actor. The owner is always the session user: no body or query field selects an owner,
 * a Bot or a user (an unknown body key is INVALID_FIELDS, any query key is INVALID_FIELDS). Foreign and absent comparisons and runs answer the same 404.
 *
 * Transactions. The request transaction of the dispatcher is SERIALIZABLE and the store writers own their transaction, so every database step runs in the
 * deferred phase after COMMIT (res.phase2Deferred, the QR-2 pattern): the pure checks and the answer to a refusal happen in phase one, which is repeatable
 * and writes nothing. The read phases run in their own REPEATABLE READ READ ONLY transaction. The audit row of a create and of a cancel is written with
 * store.audit after the action committed (root ruling RR-9); a failed audit write is counted (qr3AuditFailureCount) and never changes the answer.
 *
 * Independence facts (hardening packet SB191, slice A). Create reads, in the same REPEATABLE READ READ ONLY snapshot as the parent reads, the earlier holdouts and the
 * searched windows that overlap the frozen period, the registered boundary of the parent Bot and the G1 to G8 gate snapshot of every parent run, and freezes them
 * in each participant freeze under `independence` (src/postgres/qr3-independence.js). Nothing is defaulted: a source that cannot be read is stored as an explicit
 * unavailable state (a null list, UNAVAILABLE, a null gate snapshot), and a scan above the read budget refuses the create. The later evaluation wiring reads the
 * stored block only (slice B, not part of this module). The view shows the stored block unchanged and stays read only.
 *
 * Create needs two values only the evaluation closure can supply (the engine hash, C7, and the shared dataset digest, C6). This module names no module of
 * that closure, so deps.engineHash and deps.datasetDigest are injected; without them create refuses QR3_ADMISSION_CLOSED with detail CREATE_NOT_WIRED
 * (fail closed). The wiring slice supplies them. View and cancel need neither. Replay runs deps.replay of the same wiring module (re-read of the stored runs and
 * their verified bars, rebuild with the pure functions, one replay event); without it replay refuses QR3_ADMISSION_CLOSED with detail REPLAY_NOT_WIRED. A replay
 * of a comparison that is not COMPLETE is QR3_ADMISSION_CLOSED with detail REPLAY_NOT_COMPLETE, and a replay while another one runs in this process is
 * QR3_ADMISSION_CLOSED with detail REPLAY_BUSY (single flight). The audit row is written after the replay event committed, as for create and cancel.
 */
export const QR3_PATH='/api/quant/comparisons';
export const QR3_CREATE_EVENT='qr3.comparison_created';
export const QR3_CANCEL_EVENT='qr3.comparison_cancelled';
export const QR3_REPLAY_EVENT='qr3.comparison_replay_requested';
/** Fixed read budget (RD-6, root ruling RR-5): 2 to 4 participants, each parent contract at most this many bytes (the create reads it in full). Not a timeout. */
export const READ_BUDGET=Object.freeze({min_participants:2,max_participants:4,max_contract_bytes:1048576});
const ROUTE_CODES=Object.freeze({NOT_FOUND:'NOT_FOUND',METHOD_NOT_ALLOWED:'METHOD_NOT_ALLOWED',QUANT_LIBRARY_UNAVAILABLE:'QUANT_LIBRARY_UNAVAILABLE',
  MULTI_PINE_RESEARCH_NOT_SUPPORTED:'MULTI_PINE_RESEARCH_NOT_SUPPORTED',QR3_READ_BUDGET_EXCEEDED:'QR3_READ_BUDGET_EXCEEDED',QR3_ADMISSION_CLOSED:'QR3_ADMISSION_CLOSED',
  QR3_SCHEMA_ABSENT:'QR3_SCHEMA_ABSENT',QR3_CONFIRMATION_REQUIRED:'QR3_CONFIRMATION_REQUIRED',QR3_NOT_CANCELLABLE:'QR3_NOT_CANCELLABLE',
  QR3_ACTUAL_BOT_UNAVAILABLE:'QR3_ACTUAL_BOT_UNAVAILABLE'});
/** Every contract 9.1 request refusal code, for tests. */
export const REFUSAL_CODES=Object.freeze([
  'NOT_FOUND','INVALID_RUN_ID','DUPLICATE_RUN_ID','INVALID_FIELDS','METHOD_NOT_ALLOWED','QUANT_LIBRARY_UNAVAILABLE',
  'MULTI_PINE_RESEARCH_NOT_SUPPORTED','QR3_MODE_REQUIRED','QR3_MODE_MIX','QR3_PARTICIPANT_COUNT','QR3_MARKET_UNSUPPORTED','QR3_TIMEFRAME_UNSUPPORTED','QR3_PERIOD_INVALID',
  'QR3_PERIOD_IN_FUTURE','QR3_PERIOD_NOT_PARTITION_ALIGNED','QR3_RANGE_ADMISSION_REFUSED','QR3_READ_BUDGET_EXCEEDED','QR3_OBJECTIVE_UNKNOWN','QR3_OBJECTIVE_NOT_ALLOWED',
  'QR3_FILTER_LOOSENED','QR3_SPEC_INCOMPLETE','QR3_SPEC_IMMUTABLE','QR3_COST_MODEL_UNSUPPORTED','QR3_FIXTURE_PARTICIPANT','QR3_DATASET_UNAVAILABLE','QR3_DATASET_GAPPED',
  'QR3_ADMISSION_CLOSED','QR3_SCHEMA_ABSENT','QR3_EXPOSURE_REGISTER_UNAVAILABLE','QR3_CONFIRMATION_REQUIRED','QR3_NOT_CANCELLABLE','QR3_ACTUAL_BOT_UNAVAILABLE']);
const STATUS=Object.freeze({NOT_FOUND:404,METHOD_NOT_ALLOWED:405,QUANT_LIBRARY_UNAVAILABLE:503,QR3_ACTUAL_BOT_UNAVAILABLE:503,QR3_SCHEMA_ABSENT:503,QR3_EXPOSURE_REGISTER_UNAVAILABLE:503,
  QR3_READ_BUDGET_EXCEEDED:429,QR3_ADMISSION_CLOSED:409,QR3_NOT_CANCELLABLE:409,QR3_SPEC_IMMUTABLE:409,QR3_DATASET_UNAVAILABLE:409,QR3_DATASET_GAPPED:409,
  QR3_INTEGRITY_FAILED:409,MULTI_PINE_RESEARCH_NOT_SUPPORTED:409,RETRY_TRANSACTION:409});
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_DETAIL=/^[A-Za-z0-9_:,.-]{1,120}$/;
const CREATE_KEYS=Object.freeze(['confirmed','request_key','fixture','parent_comparison_id','mode','participants','market','cost_model_version','period','objective','risk_filter',
  'adequacy','tie','benchmark','uncertainty']);
const PARTICIPANT_KEYS=Object.freeze(['run_id','mode','fixture']);
const PERIOD_KEYS=Object.freeze(['choice','start_ms','end_ms']);
const HIDDEN_METRIC_STATUSES=Object.freeze(['EXCLUDED_INCOMPATIBLE','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','UNAVAILABLE','NOT_EVALUATED']);
const LABELLED_FIXTURE=/LABELLED SYNTHETIC/;
let auditFailures=0;
/** Audit writes that failed after their action committed, since process start (for tests and health). No identifier is kept. */
export const qr3AuditFailureCount=()=>auditFailures;

/** A refusal value: only a fixed-token detail is kept (a database guard name or message never reaches the answer). */
const safe=detail=>typeof detail==='string'&&SAFE_DETAIL.test(detail)?detail:null;
export const refusal=(code,detail=null,extra={})=>({...extra,ok:false,code,detail:safe(detail)});
/** A store refusal keeps only an upper-case token as detail; a database guard or constraint name (lower case) is dropped. */
const fromStore=result=>({...result,detail:typeof result.detail==='string'&&/^[A-Z0-9_:,.-]{1,120}$/.test(result.detail)?result.detail:null});
const clean=result=>refusal(result.code,result.detail,Object.fromEntries(Object.entries(result).filter(([name])=>!['ok','code','detail'].includes(name))));
const answer=result=>({status:STATUS[result.code]??400,body:clean(result)});
const notFound=()=>answer(refusal(ROUTE_CODES.NOT_FOUND));
const iso=ms=>Number.isSafeInteger(ms)?new Date(ms).toISOString():null;

/**
 * The pure part of create (no database): body shape, confirm token, contract 9.1 request refusals, spec rules and the period declaration.
 * Returns a refusal or {ok:true, plan}. Check order: unknown key, confirm token, field types, validateRequest (mode, mode mix, participant count, run ids,
 * duplicate ids, market, timeframe, cost model, fixture, objective in ACTUAL_BOT), ACTUAL_BOT unavailable, period declaration, spec rules.
 */
export function planCreate(body){
  if(!isObject(body)||Object.keys(body).some(name=>!CREATE_KEYS.includes(name)))return refusal(CODES.INVALID_FIELDS,'BODY');
  if(body.confirmed!==true)return refusal(ROUTE_CODES.QR3_CONFIRMATION_REQUIRED);
  if(body.fixture!==undefined&&typeof body.fixture!=='boolean')return refusal(CODES.INVALID_FIELDS,'FIXTURE');
  const key=body.request_key;
  if(key!==undefined&&key!==null&&(typeof key!=='string'||key.length<1||key.length>200))return refusal(CODES.INVALID_FIELDS,'REQUEST_KEY');
  const parent=body.parent_comparison_id;
  if(parent!==undefined&&parent!==null&&(typeof parent!=='string'||!ID.test(parent)))return refusal(CODES.INVALID_FIELDS,'PARENT_COMPARISON');
  const list=Array.isArray(body.participants)?body.participants:null;
  if(list&&list.some(item=>isObject(item)&&Object.keys(item).some(name=>!PARTICIPANT_KEYS.includes(name))))return refusal(CODES.INVALID_FIELDS,'PARTICIPANT_KEYS');
  const fixture=body.fixture===true;
  const checked=validateRequest({mode:body.mode,participants:list===null?body.participants:list.map(item=>isObject(item)?{id:item.run_id,mode:item.mode,fixture:item.fixture}:item),
    objective:body.objective,market:body.market,cost_model_version:body.cost_model_version,fixture_comparison:fixture});
  if(!checked.ok)return clean(checked);
  if(body.mode==='ACTUAL_BOT')return refusal(ROUTE_CODES.QR3_ACTUAL_BOT_UNAVAILABLE);
  if(fixture&&list.some(item=>item.fixture===false))return refusal(CODES.INVALID_FIELDS,'PARTICIPANT_FIXTURE');
  const period=body.period;
  if(!isObject(period))return refusal(CODES.QR3_PERIOD_INVALID,'PERIOD');
  if(Object.keys(period).some(name=>!PERIOD_KEYS.includes(name)))return refusal(CODES.INVALID_FIELDS,'PERIOD_KEYS');
  if(!PERIOD_CHOICES.includes(period.choice))return refusal(CODES.QR3_PERIOD_INVALID,'CHOICE_UNKNOWN');
  for(const name of ['start_ms','end_ms'])if(period[name]!==undefined&&period[name]!==null&&!Number.isSafeInteger(period[name]))return refusal(CODES.QR3_PERIOD_INVALID,'BOUND_TYPE');
  const ids=list.map(item=>item.run_id);
  const fields={objective:body.objective,risk_filter:body.risk_filter,adequacy:body.adequacy,tie:body.tie,benchmark:body.benchmark,uncertainty:body.uncertainty};
  const spec=validateSpec({mode:'STANDARDIZED',participants:ids,period:null,...structuredClone(fields)});
  if(!spec.ok)return clean(spec);
  return {ok:true,plan:{ids,fixture,parent:parent??null,request_key:key??null,market:{broker:body.market.broker,symbol:body.market.symbol,timeframe:body.market.timeframe},
    period:{choice:period.choice,start_ms:period.start_ms??null,end_ms:period.end_ms??null},fields,spec_hash:spec.spec_hash,limitations:[...spec.limitations]}};
}

/* ---- database phases ---- */

const GATE=`SELECT to_regclass('public.quant_jobs') IS NOT NULL AS library,
 to_regclass('public.quant_comparison_specs') IS NOT NULL AND to_regclass('public.quant_comparison_participants') IS NOT NULL
 AND to_regclass('public.quant_comparison_status_events') IS NOT NULL AS comparison,
 to_regclass('public.quant_research_executor_mode') IS NOT NULL AS modes, to_regclass('public.pine_market_bars') IS NOT NULL AS market`;
const META=`SELECT status,contract_hash,contract->>'mode' AS mode,octet_length(contract::text) AS contract_bytes FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2`;
const PARENT=`SELECT run_id,bot_id,deployment_id,contract,result#>'{selected,parameters}' AS selected FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2`;
const BOUNDS=`SELECT min(bar_time) AS first_time,max(bar_time) AS last_time FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'`;
const TIMES=`SELECT bar_time FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=$1 AND bar_time<=$2 ORDER BY bar_time`;
const num=value=>value===null||value===undefined?null:Number(value);

class Stop extends Error{constructor(result){super(result.code);this.result=result;}}
const stop=(code,detail=null,extra={})=>{throw new Stop(refusal(code,detail,extra));};

/** Runs work in its own REPEATABLE READ READ ONLY transaction. A Stop thrown inside becomes the returned refusal. */
async function readOnly(db,work){
  try{
    return await db.transaction(async()=>{
      await db.query('SET TRANSACTION READ ONLY');
      return work();
    },{isolation:'REPEATABLE READ'});
  }catch(error){
    if(error instanceof Stop)return error.result;
    throw error;
  }
}
async function gate(db){
  const row=(await db.query(GATE)).rows[0];
  const mode=row.modes?(await db.query('SELECT mode FROM public.quant_research_executor_mode')).rows[0]?.mode??null:null;
  return {library:row.library,comparison:row.comparison,market:row.market,mode};
}

/** Reads and checks every parent run of the request (owner scope, eligibility, read budget, contract). Returns [{id,run,contract,selected,warmup}]. */
async function readParents(db,owner,ids){
  const metas=[];
  for(const id of ids){
    const meta=(await db.query(META,[id,owner])).rows[0];
    if(!meta)stop(ROUTE_CODES.NOT_FOUND);
    metas.push(meta);
  }
  for(const meta of metas){
    if(meta.mode==='FIXED_INPUT_EVAL')stop(CODES.INVALID_FIELDS,'PARTICIPANT_INELIGIBLE');
    if(meta.status!=='SUCCEEDED')stop(CODES.INVALID_FIELDS,'PARTICIPANT_NOT_SUCCEEDED');
  }
  if(metas.some(meta=>num(meta.contract_bytes)>READ_BUDGET.max_contract_bytes))stop(ROUTE_CODES.QR3_READ_BUDGET_EXCEEDED,'CONTRACT_BYTES',{budget:READ_BUDGET});
  const parents=[];
  for(const [index,id] of ids.entries()){
    const row=(await db.query(PARENT,[id,owner])).rows[0];
    if(!row)stop(ROUTE_CODES.NOT_FOUND);
    if(hash(canonical(row.contract))!==metas[index].contract_hash)stop(CODES.QR3_INTEGRITY_FAILED,'PARTICIPANT_CONTRACT_HASH');
    let contract;
    try{contract=validateResearchContractV2(row.contract);}catch{stop(CODES.INVALID_FIELDS,'PARTICIPANT_CONTRACT');}
    if(contract.owner_id!==owner)stop(ROUTE_CODES.NOT_FOUND);
    if(!Array.isArray(contract.snapshot?.membership)||contract.snapshot.membership.length!==1)stop(ROUTE_CODES.MULTI_PINE_RESEARCH_NOT_SUPPORTED);
    const market=contract.snapshot.market;
    if(!isObject(market)||market.broker!==REQUIRED_MARKET.broker||market.symbol!==REQUIRED_MARKET.symbol)stop(CODES.QR3_MARKET_UNSUPPORTED);
    if(market.timeframe!==REQUIRED_MARKET.timeframe)stop(CODES.QR3_TIMEFRAME_UNSUPPORTED);
    if(contract.model.version!=='paper-close-v1')stop(CODES.QR3_COST_MODEL_UNSUPPORTED);
    if(!isObject(row.selected))stop(CODES.INVALID_FIELDS,'PARTICIPANT_NO_SELECTED');
    const warmup=warmupBarsOf({fixed_inputs:contract.input_lock?.selection?.fixed_inputs,selected:row.selected});
    if(warmup===null)stop(CODES.INVALID_FIELDS,'PARTICIPANT_WARMUP');
    parents.push({id,run:{run_id:id,contract_hash:metas[index].contract_hash,bot_id:row.bot_id,deployment_id:row.deployment_id},contract,selected:row.selected,warmup});
  }
  return parents;
}

/** Everything create reads: gates, parents, the resolved period, the dataset check and the dataset digest. Returns a refusal or {ok:true, ...}. */
async function readCreate(db,deps,owner,plan){
  return readOnly(db,async()=>{
    const state=await gate(db);
    if(!state.comparison)stop(ROUTE_CODES.QR3_SCHEMA_ABSENT);
    if(!state.library)stop(ROUTE_CODES.QUANT_LIBRARY_UNAVAILABLE);
    if(state.mode!=='FOUNDATION')stop(ROUTE_CODES.QR3_ADMISSION_CLOSED,'EXECUTOR_MODE');
    if(typeof deps?.engineHash!=='function'||typeof deps?.datasetDigest!=='function')stop(ROUTE_CODES.QR3_ADMISSION_CLOSED,'CREATE_NOT_WIRED');
    const parents=await readParents(db,owner,plan.ids);
    if(!plan.fixture&&parents.some(parent=>LABELLED_FIXTURE.test(parent.contract.source)))stop(CODES.QR3_FIXTURE_PARTICIPANT,'LABELLED_PARTICIPANT');
    const warmup=Math.max(...parents.map(parent=>parent.warmup));
    if(!state.market)stop(CODES.QR3_DATASET_UNAVAILABLE,'NO_MARKET_TABLE');
    const bounds=(await db.query(BOUNDS)).rows[0];
    if(bounds.last_time===null||bounds.last_time===undefined)stop(CODES.QR3_DATASET_UNAVAILABLE,'NO_BARS');
    const resolved=resolvePeriod({choice:plan.period.choice,start_ms:plan.period.start_ms,end_ms:plan.period.end_ms,last_completed_end_ms:num(bounds.last_time),
      available_start_ms:num(bounds.first_time),warmup_bars:warmup});
    if(!resolved.ok)stop(resolved.code,resolved.detail,Object.fromEntries(Object.entries(resolved).filter(([name])=>!['ok','code','detail'].includes(name))));
    const period=resolved.period,first=period.start_ms-warmup*MINUTE+MINUTE,count=period.evaluation_bars+warmup;
    const profile=parents[0].contract.model.data_profile;
    const span=(await db.query(CONTENT_DIGEST_SQL,[first,period.end_ms,profile])).rows[0];
    if(!span||span.n===0||span.digest===null)stop(CODES.QR3_DATASET_UNAVAILABLE,'NO_BARS');
    if(span.bad>0)stop(CODES.QR3_DATASET_UNAVAILABLE,'UNVERIFIED_BARS');
    if(span.n!==count||num(span.first_time)!==first||num(span.last_time)!==period.end_ms){
      // The stored times are the close times of the bars; the pure gap check names the open times of the half-open interval.
      const times=(await db.query(TIMES,[first,period.end_ms])).rows.map(row=>({time_ms:num(row.bar_time)-MINUTE,complete:true}));
      const gaps=checkDatasetGaps({bars:times,start_ms:period.start_ms,end_ms:period.end_ms,warmup_bars:warmup});
      if(!gaps.ok)stop(gaps.code,gaps.detail,Object.fromEntries(Object.entries(gaps).filter(([name])=>!['ok','code','detail'].includes(name))));
      stop(CODES.QR3_DATASET_UNAVAILABLE,'BAR_COUNT');
    }
    const digest=await deps.datasetDigest({db,first_close_ms:first,last_close_ms:period.end_ms,bar_count:count,data_profile:profile,content_digest:span.digest});
    if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))stop(CODES.QR3_DATASET_UNAVAILABLE,'DIGEST');
    const independence=new Map();
    for(const parent of parents){
      const read=await readIndependence(db,{owner_id:owner,run_id:parent.id,bot_id:parent.run.bot_id,source_hash:parent.contract.source_hash,market_key:marketKey(parent.contract),
        period:{start_ms:period.start_ms,end_ms:period.end_ms}});
      if(!read.ok)stop(ROUTE_CODES.QR3_READ_BUDGET_EXCEEDED,read.detail,{budget:{...READ_BUDGET,...INDEPENDENCE_BUDGET}});
      independence.set(parent.id,{...read.block,library_gates:await gateSnapshot(db,owner,parent.id)});
    }
    return {ok:true,parents,warmup,period:structuredClone(period),digest,independence};
  });
}

const unexpected=error=>{
  if(error?.code==='40001'||error?.code==='40P01')return {status:409,body:refusal('RETRY_TRANSACTION')};
  return answer(refusal(ROUTE_CODES.QUANT_LIBRARY_UNAVAILABLE));
};
async function audit(store,owner,event,payload){
  try{await store.audit(owner,event,null,payload);}
  catch{auditFailures+=1;}
}

async function runCreate(store,deps,owner,plan){
  const db=store.db;
  const read=await readCreate(db,deps,owner,plan);
  if(!read.ok)return answer(read);
  const engine=await deps.engineHash();
  if(typeof engine!=='string'||!/^[a-f0-9]{64}$/.test(engine))return answer(refusal(CODES.QR3_DATASET_UNAVAILABLE,'ENGINE_HASH'));
  const framed=validateSpec({mode:'STANDARDIZED',participants:plan.ids,period:structuredClone(read.period),...structuredClone(plan.fields)});
  if(!framed.ok||framed.spec_hash!==plan.spec_hash)return answer(refusal(CODES.QR3_SPEC_INCOMPLETE,'SPEC'));
  const participants=[];
  for(const [index,parent] of read.parents.entries()){
    const built=buildParticipantContext({participant_id:parent.id,contract:parent.contract,selected:parent.selected,run:parent.run,spec:framed.spec,spec_hash:framed.spec_hash,
      period:{start_ms:read.period.start_ms,end_ms:read.period.end_ms},warmup_bars:read.warmup,dataset_digest:read.digest,engine_hash:engine});
    if(!built.ok)return answer(built);
    participants.push({participant_id:parent.id,position:index+1,source_hash:parent.contract.source_hash,origin:plan.fixture?'FIXTURE':'LIBRARY_RUN',fixture:plan.fixture,
      context_key:built.context_key,freeze:{...built.freeze,independence:read.independence.get(parent.id)}});
  }
  // The declared comparison context is the one of the participant at position 1; a participant whose own key differs is shown with its mismatches and is not
  // compatible. The admission re-checks every field at enqueue, so a difference stops the evaluation there and changes no stored number.
  const declared=participants[0].context_key;
  const created=await createComparison(db,{owner_id:owner,parent_comparison_id:plan.parent,fixture:plan.fixture,market:{...REQUIRED_MARKET},spec:framed.spec,spec_hash:framed.spec_hash,
    context_key:declared,participants,request_key:plan.request_key??undefined});
  if(!created.ok)return answer(fromStore(created));
  if(created.existing){
    if(created.same_spec!==true)return answer(refusal(CODES.QR3_SPEC_IMMUTABLE,'REQUEST_KEY_REUSED'));
    return {status:200,body:{ok:true,existing:true,comparison_id:created.comparison_id,frozen_at_ms:created.frozen_at_ms,same_spec:true,evaluation_started:false}};
  }
  await audit(store,owner,QR3_CREATE_EVENT,{comparison_id:created.comparison_id,status:'SPEC_FROZEN',participant_count:participants.length,fixture:plan.fixture,spec_hash:framed.spec_hash,
    context_key:declared,outcome:'CREATED'});
  return {status:201,body:{ok:true,existing:false,comparison_id:created.comparison_id,status:'SPEC_FROZEN',frozen_at_ms:created.frozen_at_ms,frozen_at_utc:iso(created.frozen_at_ms),
    exposure_at_ms:created.exposure_at_ms,spec_hash:framed.spec_hash,context_key:declared,declared_from:participants[0].participant_id,period:read.period,limitations:plan.limitations,
    participants:created.participants.map(item=>({participant_id:item.participant_id,position:item.position,context_key:participants[item.position-1].context_key,
      compatible:participants[item.position-1].context_key===declared,prior_exposed_by:item.prior_exposed_by})),
    evaluation_started:false,notices:[FIXED_NOTICES[0],FIXED_NOTICES[1]]}};
}

async function runCancel(store,owner,id){
  const db=store.db;
  const present=await readOnly(db,async()=>{
    const state=await gate(db);
    if(!state.comparison)stop(ROUTE_CODES.QR3_SCHEMA_ABSENT);
    return {ok:true};
  });
  if(!present.ok)return answer(present);
  const cancelled=await cancelComparison(db,{owner_id:owner,comparison_id:id});
  if(!cancelled.ok)return answer(fromStore(cancelled));
  await audit(store,owner,QR3_CANCEL_EVENT,{comparison_id:id,status:'CANCELLED',seq:cancelled.seq,outcome:'CANCELLED'});
  return {status:200,body:{ok:true,comparison_id:id,status:'CANCELLED',seq:cancelled.seq,at_ms:cancelled.at_ms,at_utc:iso(cancelled.at_ms),exposure_events:'KEPT'}};
}

async function runReplay(store,deps,owner,id){
  const db=store.db;
  const present=await readOnly(db,async()=>{
    const state=await gate(db);
    if(!state.comparison)stop(ROUTE_CODES.QR3_SCHEMA_ABSENT);
    return {ok:true};
  });
  if(!present.ok)return answer(present);
  if(typeof deps?.replay!=='function')return answer(refusal(ROUTE_CODES.QR3_ADMISSION_CLOSED,'REPLAY_NOT_WIRED'));
  const replayed=await deps.replay({owner_id:owner,comparison_id:id});
  if(!replayed.ok)return answer(fromStore(replayed));
  await audit(store,owner,QR3_REPLAY_EVENT,{comparison_id:id,status:'COMPLETE',kind:replayed.kind,first_differing_code:replayed.first_differing_code??null,outcome:'REPLAYED'});
  return {status:200,body:{ok:true,comparison_id:id,kind:replayed.kind,first_differing_code:replayed.first_differing_code??null,replay_event_id:replayed.replay_event_id,
    at_ms:replayed.at_ms,at_utc:iso(replayed.at_ms),outcome_unchanged:true,derived_status:replayed.kind==='REPLAY_MISMATCH'?'STALE':null}};
}

/* ---- the view ---- */

/** The stored independence facts as frozen, without the gate snapshot (shown apart); null for a freeze that holds no block (a comparison frozen before slice A). Never defaulted. */
const independenceView=block=>{
  if(!isObject(block))return null;
  const {library_gates:_gates,...facts}=block;
  return facts;
};

function participantsView(base){
  const entries=base.participants.map(row=>({participant_id:row.participant_id,fields:contextFields(row.participant_id,row.freeze.context).fields}));
  return {mismatches:contextMismatches(entries),
    list:base.participants.map(row=>({participant_id:row.participant_id,position:row.position,source_hash:row.source_hash,origin:row.origin,fixture:row.fixture,
      context_key:row.context_key,compatible:row.context_key===base.comparison.context_key,freeze_hash:row.freeze_hash,context:row.freeze.context??null,
      subject:row.freeze.subject??null,parent:row.freeze.parent??null,prior_exposed_by:row.freeze.prior_exposed_by??[],
      independence:independenceView(row.freeze.independence),library_gates:isObject(row.freeze.independence)?row.freeze.independence.library_gates??null:null}))};
}
const nullable=(value,reason)=>({value:value??null,reason:value===null||value===undefined?reason:null});

function resultsView(found){
  const evaluations=new Map(found.evaluations.map(item=>[item.participant_id,item]));
  const outcome=found.outcome;
  const benchmarkBody=found.benchmark?.body?.result??null;
  const participants=outcome.record.participants.map(item=>{
    const stored=evaluations.get(item.id)??null;
    const hidden=HIDDEN_METRIC_STATUSES.includes(item.status);
    let metrics=null,excess=null;
    if(!hidden&&stored){
      metrics=metricsView({...stored.body.metrics,completed_episodes:stored.body.completed_episodes,closed_allocations:stored.body.closed_allocations});
      try{excess=excessReturn(stored.body.valuation?.net_return_percent_exact,benchmarkBody);}catch{excess=null;}
    }
    return {participant_id:item.id,status:item.status,rank:item.rank??null,label:item.label??null,reasons:item.reasons??[],primary_metric:hidden?null:item.primary_metric??null,
      metrics,excess_over_benchmark:hidden||!stored?null:excess,metrics_hidden:hidden,evaluation_run_id:stored?.evaluation_run_id??null,created_at_ms:stored?.created_at_ms??null};
  });
  const benchmark=found.benchmark===null?null:{benchmark_id:found.benchmark.benchmark_id,created_at_ms:found.benchmark.created_at_ms,ok:benchmarkBody?.ok===true,
    code:benchmarkBody?.code??null,detail:benchmarkBody?.detail??null,method:benchmarkBody?.method??null,
    net_return_percent:nullable(benchmarkBody?.ok===true?benchmarkBody.net_return_percent:null,benchmarkBody?.code??'BENCHMARK_NOT_RECORDED'),
    max_drawdown_percent:nullable(benchmarkBody?.ok===true?benchmarkBody.max_drawdown_percent:null,benchmarkBody?.code??'BENCHMARK_NOT_RECORDED')};
  return {outcome:{outcome:outcome.outcome,outcome_hash:outcome.outcome_hash,created_at_ms:outcome.created_at_ms,only_qualified_participant_id:outcome.only_qualified_participant_id,
      uncertainty:outcome.record.uncertainty??null,limitations:outcome.record.limitations??[]},
    participants,benchmark,replay_events:found.replay_events,
    qualified_recommendations:outcome.outcome==='NO_QUALIFIED_RESULT'&&outcome.only_qualified_participant_id===null?NO_WINNER_TEXT:null};
}

/** Derived read status (8.1 STALE): an unreadable or damaged stored row, or a REPLAY_MISMATCH event. The stored numbers are shown unchanged. */
async function runView(store,owner,id){
  const db=store.db;
  const found=await readOnly(db,async()=>{
    const state=await gate(db);
    if(!state.comparison)stop(ROUTE_CODES.QR3_SCHEMA_ABSENT);
    const base=await readComparison(db,{owner_id:owner,comparison_id:id});
    if(!base.ok){
      if(base.code===CODES.QR3_INTEGRITY_FAILED)return {ok:true,stale_only:true,detail:base.detail};
      stop(base.code,fromStore(base).detail);
    }
    let results=null,integrity=null;
    if(base.status.status==='COMPLETE'){
      const read=await readComparisonResults(db,{owner_id:owner,comparison_id:id});
      if(read.ok)results=read;else if(read.code===CODES.QR3_INTEGRITY_FAILED)integrity=read.detail;else stop(read.code,fromStore(read).detail);
    }
    return {ok:true,base,results,integrity};
  });
  if(!found.ok)return answer(found);
  if(found.stale_only)return {status:200,body:{ok:true,comparison_id:id,derived_status:'STALE',stale:{first_differing_code:CODES.QR3_INTEGRITY_FAILED,detail:safe(found.detail)},
    comparison:null,results:null,notices:[FIXED_NOTICES[0],FIXED_NOTICES[1]]}};
  const {base,results,integrity}=found;
  const shown=participantsView(base);
  const mismatch=results?.replay_events.find(item=>item.kind==='REPLAY_MISMATCH')??null;
  const stale=integrity!==null?{first_differing_code:CODES.QR3_INTEGRITY_FAILED,detail:safe(integrity)}
    :mismatch!==null?{first_differing_code:mismatch.first_differing_code,detail:null}:null;
  const comparison=base.comparison;
  return {status:200,body:{ok:true,comparison_id:id,
    comparison:{comparison_id:comparison.comparison_id,parent_comparison_id:comparison.parent_comparison_id,mode:comparison.mode,fixture:comparison.fixture,market:comparison.market,
      window:comparison.window,participant_count:comparison.participant_count,context_key:comparison.context_key,spec_hash:comparison.spec_hash,spec:comparison.spec,
      spec_body_hash:comparison.spec_body_hash,frozen_at_ms:comparison.frozen_at_ms,frozen_at_utc:iso(comparison.frozen_at_ms)},
    status:base.status.status,status_event:{seq:base.status.seq,at_ms:base.status.at_ms,at_utc:iso(base.status.at_ms),reason_code:base.status.reason_code},
    events:base.events.map(item=>({seq:item.seq,status:item.status,reason_code:item.reason_code,at_ms:item.at_ms})),
    derived_status:stale===null?null:'STALE',stale,participants:shown.list,context_mismatches:shown.mismatches,
    // F8: no metric before COMPLETE; a FAILED or CANCELLED comparison shows none either.
    results:results===null||results.outcome===null?null:resultsView(results),
    notices:[FIXED_NOTICES[0],FIXED_NOTICES[1]]}};
}

/* ---- the route ---- */

function parseTarget(path){
  const rest=path.slice(QR3_PATH.length);
  if(rest==='')return {kind:'collection',id:null};
  const parts=rest.slice(1).split('/');
  if(parts[0]==='')return null;
  if(parts.length===1)return {kind:'item',id:parts[0]};
  if(parts.length===2&&parts[1]==='cancel')return {kind:'cancel',id:parts[0]};
  if(parts.length===2&&parts[1]==='replay')return {kind:'replay',id:parts[0]};
  return null;
}

export async function qr3Routes(req,res,url,actor,{store,auth,json,enabled,deps}={}){
  if(enabled!==true)return false;
  const path=url.pathname;
  if(path!==QR3_PATH&&!path.startsWith(QR3_PATH+'/'))return false;
  const send=result=>{json(res,result.status,result.body);return true;};
  const target=parseTarget(path);
  if(target===null)return send(notFound());
  const method=target.kind==='item'?'GET':'POST';
  if(req.method!==method)return send(answer(refusal(ROUTE_CODES.METHOD_NOT_ALLOWED)));
  // No query key selects anything (user_id and bot_id never select a scope).
  if([...url.searchParams].length)return send(answer(refusal(CODES.INVALID_FIELDS,'QUERY')));
  if(method==='POST'){
    // Authentication and the unsafe-method CSRF check are the canonical auth.require; no second token exists.
    const session=await auth.require(req);
    if(!session||session.id!==actor.id)return send(notFound());
  }
  const owner=actor.id;
  const defer=work=>{
    res.phase2Deferred=async()=>{try{return await work();}catch(error){return unexpected(error);}};
    return true;
  };
  if(target.kind==='item')return defer(()=>runView(store,owner,target.id));
  const body=await readJson(req);
  if(target.kind==='cancel'){
    if(!isObject(body)||Object.keys(body).length>0)return send(answer(refusal(CODES.INVALID_FIELDS,'BODY')));
    return defer(()=>runCancel(store,owner,target.id));
  }
  if(target.kind==='replay'){
    if(!isObject(body)||Object.keys(body).some(name=>name!=='confirmed'))return send(answer(refusal(CODES.INVALID_FIELDS,'BODY')));
    if(body.confirmed!==true)return send(answer(refusal(ROUTE_CODES.QR3_CONFIRMATION_REQUIRED)));
    return defer(()=>runReplay(store,deps,owner,target.id));
  }
  const planned=planCreate(body);
  if(!planned.ok)return send(answer(planned));
  return defer(()=>runCreate(store,deps,owner,planned.plan));
}
