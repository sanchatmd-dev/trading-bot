import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../pine-bridge/source.js';
import {deploymentExitVersion} from '../pine-bridge/exit-version.js';
import {RULES} from '../quant-research/contract.js';
import {marketKey,holdoutWindow,contractHashVerified,reportMatchesCheckpoints,MINUTE} from '../quant-library/derive.js';
import {PACKAGE_GATE_VERSION,MAX_VALIDATION_ATTEMPTS,ENGINEERING_SCOPE,TRACE_FILES,searchedWindow,packageHash,bindingHash,evaluateBuildEligibility,evaluatePackage,readState,isRefused} from '../quant-library/package-gates.js';
import {renderPackage,PACKAGE_MARKET} from '../quant-library/package-render.js';
import {reproduceRun,traceReproductionRecords,TRACE_REFUSAL_CODES} from '../quant-library/trace-reproduction.js';
import {classifyBestInputsPackage} from './best-inputs-package-migration.js';
import {readExposures,toPackageEntries} from './exposure-register.js';
import {HARD_RANGES} from './pf4-risk-proposals.js';

/*
 * F09-01 stage I (L7): the one-Pine Best Inputs FIXTURE build and attempt service (docs/design/f09-build-worker/README.md, docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md RC-12 to RC-39,
 * root rulings SB176). Local engineering evidence, fixture path only. No route, worker, runtime root or service imports this module (test/bi-package-store-static-isolation.test.js),
 * and it is installed on no staging or production database. Every row it writes is a LABELLED FIXTURE (fixture true, READY false, G8 unchanged).
 *
 * BiFixturePackageService (constructor config only: db and a Store on the SAME db, readBotState, clock, ids, engineHash, traceClosureHash, ports, currentRules, hooks, maxPackageBytes):
 *   build({owner_id, run_id}, {signal})  RC-16: an existing export of the run is returned as it is (LOAD); otherwise the run is read (integrity recomputed, never trusted), the run-level
 *                                        part of B0 is judged BEFORE the evaluator runs, the run is reproduced ONCE outside the write transaction (S3 reproduceRun), rendered, judged by B0
 *                                        on the rendered binding (render again if the limitation codes changed), and ONE SERIALIZABLE transaction re-reads the export, the run, the lookups,
 *                                        the exposure register and the deployment, re-checks the closure pins, re-runs B0 and only then inserts the blobs, the export, its 12 files, the
 *                                        seq 1 EXPORT_CANDIDATE event and exactly three trace rows. A refusal writes no row. The request carries no bytes, hash, flag or result.
 *   attempt({owner_id, export_id})       one validation attempt (RC-26 to RC-30): the live engine hash must equal the contract engine hash (BI_ENGINE_HASH_MISMATCH, no attempt row), the
 *                                        run is reproduced once outside the transaction, then ONE SERIALIZABLE transaction reads the live state, runs C1 to C4 and Q through evaluatePackage
 *                                        with the S3 output unmodified, and inserts the attempt row, the fixture ql4c_validation row of a pass and the status event.
 *   read({owner_id, export_id|run_id})   the stored export with its derived freshness (readState), in ONE READ ONLY REPEATABLE READ transaction. READY is false for every fixture.
 *   recordCompile / recordEvidence / recordClearance   the candidate records. They are FIXTURE records only (method fixture-record, operator_role fixture); no TradingView step runs.
 *
 * Root rulings SB176 implemented here:
 *   2 capacity: ONE active job per service instance. A second build of the same owner/run joins it (single-flight, one reproduction; at most 8 joined waiters); any other call while a job is
 *     active, or a ninth waiter, answers PACKAGE_STORE_BUSY at once (a module code, never stored, never a gate code). An attempt never joins. No queue and no quant_jobs row.
 *   3 lifetime: zero. The entry is removed when the job settles, before its result is returned. No result or refusal is cached.
 *   4 cancellation: the first caller's AbortSignal owns the job; it is checked before LOOKUPS, before REPRODUCE, after REPRODUCE, before RENDER and before TX_BEGIN and passed to reproduceRun. A cancel
 *     before TX_BEGIN ends the job with PACKAGE_STORE_CANCELLED and no row. After TX_BEGIN the signal is ignored. A joined waiter's own signal detaches only that waiter.
 *   5 retry: one first try plus at most PACKAGE_STORE_MAX_RETRIES restarts for 40001, 40P01 and, by operation, a unique violation of the exact key a concurrent winner takes (build: the owner/run export key;
 *     attempt: the attempt and status event keys of the export; a record writer: none). A restart re-reads everything in the fresh
 *     snapshot and re-runs B0; it reuses the verified reproduction and the rendered bytes and never invokes the evaluator again. After the last restart the last race error is rethrown. QR004 maps to
 *     BI_TRANSITION_INVALID (RC-25); QR003 and every other database error are rethrown unchanged.
 *   6 uncertain outcome: an error at or after COMMIT that is not a race code is rethrown, with no retry. The operator calls read() before a new request. No crash-safety claim.
 *   7 cross-process exclusion: NONE (limitation). UNIQUE (owner_id, run_id) and SERIALIZABLE decide a persisted race; two processes may both evaluate before insert. Single process only.
 *   8 a change of the run or trace closure between the reproduction and the transaction refuses with BI_ENGINE_HASH_MISMATCH, no row, no retry.
 *
 * Limitations recorded here (fixture path): policy_version has no live source before the owner decision Q3, so the live value is the packaged one and BI_POLICY_SNAPSHOT_MISMATCH is decided by
 * policy_hash alone; the live input lock is not recomputed (it derives from the baseline deployment snapshot and the source revision, both compared live, so it reads as unchanged exactly when
 * they are); the Bridge bounds are the frozen contract domains (no server source of the Bot's permitted bounds exists before the apply flow).
 */

export const PACKAGE_STORE_CODES=Object.freeze({
  NOT_FOUND:'NOT_FOUND',BUILD_B0_FAILED:'BUILD_B0_FAILED',BUILD_INPUT_INVALID:'BUILD_INPUT_INVALID',EXPORT_NOT_OPEN:'EXPORT_NOT_OPEN',STORED_INTEGRITY:'PACKAGE_STORED_INTEGRITY',
  ENGINE_MISMATCH:'BI_ENGINE_HASH_MISMATCH',TRANSITION_INVALID:'BI_TRANSITION_INVALID',BUSY:'PACKAGE_STORE_BUSY',CANCELLED:'PACKAGE_STORE_CANCELLED',
  IN_TRANSACTION:'PACKAGE_STORE_IN_TRANSACTION',NOT_INSTALLED:'PACKAGE_STORE_NOT_INSTALLED'});
/** One first try plus three restarts of a lost race. */
export const PACKAGE_STORE_MAX_RETRIES=3;
/** At most eight callers join the one active build job. */
export const PACKAGE_STORE_MAX_WAITERS=8;
export const MAX_PACKAGE_BYTES=16*1024*1024;
/** The legacy research contract holds at most 10,000 inline bars (research-contract-v3). */
const MAX_BARS=10_000;
export const PACKAGE_LIBRARY_VERSIONS=Object.freeze({gates:PACKAGE_GATE_VERSION,render:'one-pine-v1'});
/** The scope of the registered boundary, the same four values as PREFLIGHT_HOLDOUT_SCOPE (quant-preflight.js); a test pins the equality. */
export const BOUNDARY_SCOPE=Object.freeze({venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1'});
/** The tables this module writes, and no other. */
export const WRITTEN_TABLES=Object.freeze(['bi_blobs','bi_exports','bi_package_files','bi_status_events','bi_trace_reproductions','bi_attempts','ql4c_validation','bi_compile_records','bi_evidence_records','bi_clearances']);

const SERIALIZATION_FAILURE='40001',DEADLOCK_DETECTED='40P01',UNIQUE_VIOLATION='23505',QR_GUARD='QR004';
const BUILD_RACE_KEYS=new Set(['bi_exports_owner_run_key']);
const ATTEMPT_RACE_KEYS=new Set(['bi_attempts_pkey','bi_status_events_pkey','bi_status_events_attempt_key','ql4c_validation_pkey']);
const NO_KEYS=new Set();
const HEX64=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_TEXT=/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;
const LIMIT_KEYS=Object.freeze(['maxRiskPercent','maxOrderNotional','maxDailyNotional']);
const EVIDENCE_KINDS=Object.freeze(['dataset_alignment','native_parity','bridge_parity','repaint','quant_baseline']);
/** The evidence kind a candidate blocker is cleared by (the same map as the clearance guard of the SQL). */
const CLEARANCE_KIND=Object.freeze({VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED:'native_parity',CUSTOM_REPAINT_EVIDENCE_REQUIRED:'repaint'});
const FIXTURE_LABEL=Object.freeze({method:'fixture-record',operator_role:'fixture'});
/** The codes of a reproduction failure this module reports as a refusal. Any other error (a programming error, a database error) is rethrown. */
const REPRODUCTION_CODES=new Set([...TRACE_REFUSAL_CODES,'BI_ENGINE_HASH_MISMATCH','STATUS_NOT_COMPLETED','BI_RUN_NOT_QUALIFIABLE','HOLDOUT_NOT_EVALUATED','BI_PROVENANCE_UNRESOLVED','BI_DATASET_UNAVAILABLE',
  'QUANT_PYTHON_UNAVAILABLE','EVALUATION_TIMED_OUT','RESEARCH_INTERRUPTED','EVALUATION_OUTPUT_TOO_LARGE','EVALUATION_FAILED','INVALID_EVALUATION_RESPONSE','RESEARCH_REQUEST_TOO_LARGE']);

const RUN_SQL=`SELECT run_id,owner_id,bot_id,deployment_id,status,created_at,contract_hash,submission_hash,contract,result FROM public.quant_jobs
  WHERE run_id=$1 AND owner_id=$2 AND (contract->>'mode') IS DISTINCT FROM 'FIXED_INPUT_EVAL'`;
const STEP_SQL='SELECT step_id,kind,parameters,result FROM public.quant_job_steps WHERE run_id=$1 ORDER BY step_id COLLATE "C"';
const DEPLOYMENT_SQL='SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash FROM public.pine_deployments WHERE owner_id=$1 AND bot_id=$2 AND deployment_id=$3';
const JOB_SQL=`SELECT CASE WHEN jsonb_typeof(result->'integrated_pine')='string' THEN result->>'integrated_pine' END AS artifact FROM public.pine_bridge_jobs
  WHERE owner_id=$1 AND bot_id=$2 AND operation='generate' AND status='SUCCEEDED' AND jsonb_typeof(result->'deployment_id')='string' AND result->>'deployment_id'=$3 ORDER BY job_id`;
const BRIDGE_EVIDENCE_SQL='SELECT deployment_id,snapshot_hash,evidence,evidence_hash FROM public.pine_bridge_evidence WHERE deployment_id=$1';
const MEMBERSHIP_SQL=`SELECT m.pine_import_id,m.source_version,r.source_hash FROM public.pine_memberships m
  JOIN public.pine_source_revisions r ON r.pine_import_id=m.pine_import_id AND r.source_version=m.source_version WHERE m.owner_id=$1 AND m.bot_id=$2 AND m.connected=true ORDER BY m.pine_import_id`;
const BAR_SQL=`SELECT bar_time,bar,provenance,content_hash FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=$1 AND bar_time<=$2 ORDER BY bar_time LIMIT $3`;
const EXPORT_COLUMNS=['export_id','owner_id','bot_id','run_id','parent_export_id','mode','internal','fixture','gate_version','library_versions','binding','binding_hash','package_hash','b0','created_at','created_at_utc'];
const EXPORT_BY_RUN=`SELECT ${EXPORT_COLUMNS.join(',')} FROM public.bi_exports WHERE owner_id=$1 AND run_id=$2`;
const EXPORT_BY_ID=`SELECT ${EXPORT_COLUMNS.join(',')} FROM public.bi_exports WHERE owner_id=$1 AND export_id=$2`;
const FILE_ROWS=`SELECT f.path,f.sha256,f.bytes,b.content FROM public.bi_package_files f JOIN public.bi_blobs b ON b.sha256=f.sha256 AND b.size=f.bytes WHERE f.export_id=$1 ORDER BY f.path COLLATE "C"`;
const EVENT_ROWS='SELECT seq,status,codes,attempt_no,at_ms,at_utc FROM public.bi_status_events WHERE export_id=$1 ORDER BY seq';
const ATTEMPT_ROWS='SELECT attempt_no,attempt_id,pass,codes FROM public.bi_attempts WHERE export_id=$1 ORDER BY attempt_no';
const COMPILE_ROWS=`SELECT compile_id,export_id,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,duplicate_bindings,mapping_check,compiled_at_ms,compiled_at_utc,operator_role,method
  FROM public.bi_compile_records WHERE export_id=$1 ORDER BY compiled_at_ms,compile_id`;
const EVIDENCE_ROW_SQL='SELECT kind,record,evidence_hash,recorded_at_ms FROM public.bi_evidence_records WHERE export_id=$1 ORDER BY kind,recorded_at_ms,evidence_hash';
const CLEARANCE_ROWS='SELECT blocker,run_id,parameter_hash,evidence_hash FROM public.bi_clearances WHERE export_id=$1 ORDER BY blocker,recorded_at_ms,evidence_hash';

/*
 * Holdout independence lookups (contract 5.0 item 5). EARLIER_ONE_PINE_SQL mirrors EARLIER of src/postgres/quant-library.js (the earlier runs of the owner that evaluated a holdout) and
 * EFFECTIVE_BOUNDARY_SQL mirrors the constant of the same name in src/postgres/quant-preflight.js; the only difference is the schema name `public.` before each table, so no search_path lookup
 * can pick another relation. Both are pinned by a parity test. EARLIER_SEARCHED_ONE_PINE_SQL adds the same-source filter of OD-10.
 */
export const EARLIER_ONE_PINE_SQL=`WITH earlier AS MATERIALIZED (SELECT j.run_id,j.created_at,
 CASE WHEN jsonb_typeof(j.contract)='object' THEN j.contract - 'source' #- '{dataset,bars}' #- '{plan,candidates}' END AS k
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND (j.contract->>'mode') IS DISTINCT FROM 'FIXED_INPUT_EVAL' AND j.run_id<>$2 AND (j.created_at,j.run_id)<($3::bigint,$2::text) AND j.result->'holdout_evaluated'='true'::jsonb)
 SELECT run_id,k#>'{snapshot,market}' AS market,k->'split' AS split,k#>'{dataset,start_time}' AS start_time FROM earlier ORDER BY created_at,run_id`;
export const EFFECTIVE_BOUNDARY_SQL=`SELECT (SELECT min(sibling.holdout_start_time)
  FROM public.quant_holdout_boundaries sibling WHERE sibling.owner_id=own.owner_id
  AND sibling.venue=own.venue AND sibling.market=own.market
  AND sibling.symbol=own.symbol AND sibling.timeframe=own.timeframe) holdout_start_time
  FROM public.quant_holdout_boundaries own WHERE own.owner_id=$1 AND own.bot_id=$2
  AND own.venue=$3 AND own.market=$4 AND own.symbol=$5 AND own.timeframe=$6`;
export const EARLIER_SEARCHED_ONE_PINE_SQL=`SELECT j.run_id,j.contract#>'{snapshot,market}' AS market,j.contract->'split' AS split,j.contract#>'{dataset,start_time}' AS start_time
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND (j.contract->>'mode') IS DISTINCT FROM 'FIXED_INPUT_EVAL' AND j.run_id<>$2 AND (j.created_at,j.run_id)<($3::bigint,$2::text) AND j.contract->>'source_hash'=ANY($4::text[]) ORDER BY j.created_at,j.run_id`;

/* ---------- small helpers ---------- */

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const sha=value=>typeof value==='string'&&HEX64.test(value);
const digest=value=>hash(canonical(value));
const refusal=(code,extra={})=>({ok:false,code,...extra});
const number=value=>{const parsed=typeof value==='number'?value:Number(value);return Number.isSafeInteger(parsed)?parsed:Number.NaN;};
const isoOf=ms=>new Date(ms).toISOString();
const toBuffer=value=>Buffer.isBuffer(value)?value:Buffer.from(value);
const positiveDecimal=value=>typeof value==='string'&&value.length<=120&&DECIMAL_TEXT.test(value)&&/[1-9]/.test(value);
const accountText=value=>{const out=typeof value==='number'&&Number.isFinite(value)?String(value):value;return positiveDecimal(out)?out:null;};
const sortedCodes=codes=>[...codes].sort();

/** The numeric limits of a policy as decimal strings (risk-profile.json). A limit that is not a positive plain decimal is absent, and C3 then reports BI_RISK_RELAXATION. */
export function riskLimitsOf(policy){
  const out={};
  if(isObject(policy))for(const key of LIMIT_KEYS){const value=accountText(policy[key]);if(value!==null)out[key]=value;}
  return out;
}
/** The current server hard limits {name: {min, max}} as decimal strings, from the ranges of the risk policy validator (HARD_RANGES, the one constant of those ranges). */
export const serverHardLimits=()=>Object.fromEntries(Object.entries(HARD_RANGES).map(([name,[min,max]])=>[name,{min,max}]));
/** The Bridge bounds are the frozen contract domains: the first and the last grid value (no server source of the Bot's permitted Bridge bounds exists before the apply flow). */
export function bridgeBoundsOf(contract){
  const grid=name=>{const values=contract?.input_lock?.domains?.[name];return Array.isArray(values)&&values.length>0?{min:values[0],max:values[values.length-1]}:undefined;};
  return {atr_multiplier:grid('atr_multiplier'),rr:grid('rr')};
}
/** Native alert isolation of the deployment, read from its own Bridge evidence: only a row of the deployment snapshot whose evidence_hash verifies counts; without the proof native_payloads is -1. */
export function nativeIsolationOf(snapshotHash,rows){
  const row=(Array.isArray(rows)?rows:[]).find(item=>isObject(item)&&item.snapshot_hash===snapshotHash&&sha(item.evidence_hash)&&isObject(item.evidence)&&digest(item.evidence)===item.evidence_hash);
  const record=row?.evidence,isolated=record?.native_alerts_isolated===true;
  return {routes_disabled:isolated,unrelated_payloads:Number.isSafeInteger(record?.unrelated_payloads)?record.unrelated_payloads:-1,native_payloads:isolated?0:-1};
}

/** The scope every fixture evidence record carries: the package binding values the C4 gate compares. */
const scopeOf=binding=>({source_hash:binding.source_hash,effective_input_hash:binding.effective_input_hash,dataset_digest:binding.dataset_ref?.sha256,engine_hash:binding.engine_hash});
/** A passing fixture evidence record of one kind (mechanics only: no TradingView compile and no real parity ran). */
export function fixtureEvidenceRecord(binding,kind){
  const scope=scopeOf(binding);
  switch(kind){
    case 'dataset_alignment':return {matched_percent:100,unmatched_bars:0,future_leakage:0,...FIXTURE_LABEL,scope};
    case 'native_parity':return {match_percent:100,missing_events:0,additional_events:0,shift_bars:0,sample:{warmup_bars:1250,lookback:200,closed_bars:2500,native_events:150,buy_events:40,exit_events:40},...FIXTURE_LABEL,scope};
    case 'bridge_parity':return {match_percent:100,sl_tp_diff_ticks:0,exit_version:binding.exit_version,...FIXTURE_LABEL,scope};
    case 'repaint':return {observations:100,changed_flags:0,...FIXTURE_LABEL,scope};
    case 'quant_baseline':return {coverage_percent:100,decision_match_percent:100,quantity_step_diff:0,cash_diff_minor_units:0,...FIXTURE_LABEL,scope};
    default:throw new Error('Unknown evidence kind '+kind);
  }
}
/** A clean fixture compile record for indicator.pine: the mapping check names the selected slots of the contract. */
export const fixtureCompileRecord=({indicatorSha256,contract,pineVersion='fixture'})=>({indicator_sha256:indicatorSha256,pine_version:String(pineVersion),errors:[],warnings:[],unresolved_references:0,collisions:0,duplicate_bindings:0,
  mapping_check:[...(contract?.input_lock?.selection?.bindings??[])].sort((a,b)=>a.slot-b.slot).map(item=>({slot:item.slot,pine_variable:item.pine_variable})),...FIXTURE_LABEL});

/** The run view the pure gates, the renderer and the reproduction read. Integrity is RECOMPUTED here from the stored contract, result and checkpoints, never taken from a caller. */
function runViewOf(row,steps){
  const contract=row.contract,result=isObject(row.result)?row.result:null,created=number(row.created_at);
  return {owner_id:row.owner_id,bot_id:row.bot_id,run_id:row.run_id,status:row.status,contract,contract_hash:row.contract_hash,submission_hash:row.submission_hash,result,created_at:created,
    created_at_utc:isoOf(created),integrity:{contract_hash_verified:contractHashVerified(contract,row.contract_hash),report_matches_checkpoints:reportMatchesCheckpoints(result,steps).ok===true}};
}
const refusedReproduction=error=>typeof error?.code==='string'&&REPRODUCTION_CODES.has(error.code);

/* ---------- holdout independence lookups ---------- */

/** The lookups of contract 5.0 item 5 for one one-Pine run, on the given handle. A part that cannot be read is null in `lookups` (B0 then reports HOLDOUT_INDEPENDENCE_NOT_CHECKED or
 * BI_EXPOSURE_REGISTER_UNAVAILABLE). Nothing here throws for an absent table or an unreadable row; a database error (for example 42501) passes through. */
export async function readOnePineLookups(db,view){
  const contract=view.contract,ownKey=marketKey(contract),sourceHashes=[contract.source_hash],unavailable=new Set();
  const earlier=[],searched=[];
  let ownOk=true,boundary=null,exposure=null;
  const params=[view.owner_id,view.run_id,view.created_at];
  for(const row of (await db.query(EARLIER_ONE_PINE_SQL,params)).rows){
    const shape={snapshot:{market:row.market},split:row.split,dataset:{start_time:row.start_time}},key=marketKey(shape),window=holdoutWindow(shape);
    if(key!==null&&key!==ownKey)continue;
    if(window===null)ownOk=false;else earlier.push(window);
  }
  for(const row of (await db.query(EARLIER_SEARCHED_ONE_PINE_SQL,[...params,sourceHashes])).rows){
    const shape={snapshot:{market:row.market},split:row.split,dataset:{start_time:row.start_time}},key=marketKey(shape),window=searchedWindow(shape);
    if(key!==null&&key!==ownKey)continue;
    if(window===null)ownOk=false;else searched.push(window);
  }
  if(!ownOk)unavailable.add('HOLDOUT_INDEPENDENCE_NOT_CHECKED');
  const present=(await db.query("SELECT to_regclass('public.quant_holdout_boundaries') AS boundaries")).rows[0];
  if(present?.boundaries!==null&&present?.boundaries!==undefined){
    const rows=(await db.query(EFFECTIVE_BOUNDARY_SQL,[view.owner_id,view.bot_id,...Object.values(BOUNDARY_SCOPE)])).rows;
    if(rows.length===0)boundary={exists:false};
    else{const start=number(rows[0].holdout_start_time);boundary=Number.isSafeInteger(start)?{exists:true,start_time:start}:null;}
  }
  if(boundary===null)unavailable.add('HOLDOUT_INDEPENDENCE_NOT_CHECKED');
  const read=await readExposures(db,{owner_id:view.owner_id,...PACKAGE_MARKET});
  exposure=read.ok===true?toPackageEntries(read):null;
  if(exposure===null)unavailable.add('BI_EXPOSURE_REGISTER_UNAVAILABLE');
  return {ok:unavailable.size===0,lookups:{earlier_holdouts:ownOk?earlier:null,earlier_searched:ownOk?searched:null,registered_boundary:boundary,exposure_register:exposure},unavailable:[...unavailable].sort()};
}

/* ---------- dataset ---------- */

/** Reads the contract bars from pine_market_bars and recomputes the dataset digest the way the legacy enqueue computed it. readable is false for a gap, a short range or a changed row. */
export async function readPackageDataset(db,contract){
  const dataset=contract.dataset;
  if(!isObject(dataset)||!Number.isSafeInteger(dataset.start_time)||!Number.isSafeInteger(dataset.end_time)||!Number.isSafeInteger(dataset.bar_count)||dataset.bar_count<1||dataset.bar_count>MAX_BARS)return {readable:false};
  // One row more than the contract holds is enough to see a surplus; the read is bounded by the contract, never by the table.
  const rows=(await db.query(BAR_SQL,[dataset.start_time,dataset.end_time,dataset.bar_count+1])).rows;
  if(rows.length!==dataset.bar_count)return {readable:false};
  for(let index=0;index<rows.length;index++){
    const row=rows[index];
    if(number(row.bar_time)!==dataset.start_time+index*MINUTE||!isObject(row.bar)||row.bar.time!==number(row.bar_time)||hash(canonical(row.bar))!==row.content_hash)return {readable:false};
  }
  const end=dataset.end_time+MINUTE;
  return {readable:true,digest:digest(rows.map(row=>({bar:row.bar,content_hash:row.content_hash,provenance:row.provenance}))),
    metadata:{version:'spot-dataset-v1',source:'binance-spot-klines-v1',venue:PACKAGE_MARKET.broker,market:'SPOT',symbol:PACKAGE_MARKET.symbol,timeframe:PACKAGE_MARKET.timeframe,
      start_time:dataset.start_time,end_time:end,total_bars:dataset.bar_count,warmup_bars:dataset.warmup_bars,cutoff:end}};
}

/* ---------- the service ---------- */

export class BiFixturePackageService{
  #db;#readBotState;#clock;#ids;#engineHash;#traceClosureHash;#ports;#currentRules;#hooks;#maxBytes;#job=null;#installed=false;

  /** db: a PostgresDatabase outside a transaction; store: a Store on THE SAME db; readBotState: storeBotState over that store (returns {policy_hash}); clock: epoch ms; ids: a function that returns a
   * new UUID (default randomUUID); engineHash and traceClosureHash: the live run closure hash and the live trace closure hash (a function or 64 hex characters; the caller computes them, so this module
   * imports no engine module); ports: the S3 evaluation ports (defaultPorts, or ports of the same shape); currentRules: the rules B0 compares the run rules with (default RULES); hooks:
   * {step(name, detail), beforeTransaction(), beforeInsert()} test seams (no hook changes a gate result); maxPackageBytes: a cap that can only tighten the 16 MiB package cap. */
  constructor({db,store,readBotState,clock,ids=randomUUID,engineHash,traceClosureHash,ports,currentRules=RULES,hooks={},maxPackageBytes=MAX_PACKAGE_BYTES}={}){
    if(!db||typeof db.query!=='function'||typeof db.transaction!=='function'||db.isTransaction===true)throw new Error('db must be a PostgresDatabase outside a transaction');
    if(!store||store.db!==db)throw new Error('store must be a Store on the same db');
    if(typeof readBotState!=='function'||typeof clock!=='function'||typeof ids!=='function')throw new Error('readBotState, clock and ids must be functions');
    if(!isObject(currentRules))throw new Error('currentRules');
    for(const value of [engineHash,traceClosureHash])if(typeof value!=='function'&&!sha(value))throw new Error('engineHash and traceClosureHash must be a function or 64 hex characters');
    if(!isObject(ports)||!['evaluate','traceEvaluate','engineHash'].every(name=>typeof ports[name]==='function')||typeof ports.closure!=='string')throw new Error('ports must be the S3 evaluation ports');
    if(!Number.isSafeInteger(maxPackageBytes)||maxPackageBytes<1)throw new Error('maxPackageBytes');
    this.#db=db;this.#readBotState=readBotState;this.#clock=clock;this.#ids=ids;this.#engineHash=engineHash;this.#traceClosureHash=traceClosureHash;this.#ports=ports;
    this.#currentRules=currentRules;this.#hooks=isObject(hooks)?hooks:{};this.#maxBytes=Math.min(maxPackageBytes,MAX_PACKAGE_BYTES);
  }

  async #step(name,detail){if(typeof this.#hooks.step==='function')await this.#hooks.step(name,detail);}
  async #liveEngine(){return typeof this.#engineHash==='function'?this.#engineHash():this.#engineHash;}
  async #liveTrace(){return typeof this.#traceClosureHash==='function'?this.#traceClosureHash():this.#traceClosureHash;}
  #cancelled(job,stage){return job.signal?.aborted===true?refusal(PACKAGE_STORE_CODES.CANCELLED,{stage}):null;}

  /** The package extension must already classify INSTALLED. This module never installs it. A positive answer is remembered; a negative one never is. */
  async #requireInstalled(){
    if(this.#installed)return null;
    const report=await classifyBestInputsPackage(this.#db);
    if(report.state!=='INSTALLED')return refusal(PACKAGE_STORE_CODES.NOT_INSTALLED,{state:report.state});
    this.#installed=true;
    return null;
  }

  /** One SERIALIZABLE transaction, restarted from its first statement after a lost race (at most PACKAGE_STORE_MAX_RETRIES times). QR004 maps to BI_TRANSITION_INVALID; everything else is rethrown. */
  async #transact(body,keys=NO_KEYS){
    // db.transaction inside a transaction of the same database runs its body in the caller's transaction, which would bypass a new SERIALIZABLE boundary.
    if(this.#db.isTransaction)return refusal(PACKAGE_STORE_CODES.IN_TRANSACTION);
    let last;
    for(let tries=0;tries<=PACKAGE_STORE_MAX_RETRIES;tries++){
      try{return await this.#db.transaction(body,{isolation:'SERIALIZABLE'});}
      catch(error){
        if(error?.code===SERIALIZATION_FAILURE||error?.code===DEADLOCK_DETECTED||(error?.code===UNIQUE_VIOLATION&&keys.has(error.constraint))){last=error;continue;}
        if(error?.code===QR_GUARD)return refusal(PACKAGE_STORE_CODES.TRANSITION_INVALID,{diagnostic:{message:String(error.message).slice(0,200)}});
        throw error;
      }
    }
    throw last;
  }

  /* ---------- the one active job ---------- */

  #enter(meta,work,joinable){
    const active=this.#job;
    if(active!==null){
      if(!joinable||active.key!==meta.key||active.waiters>=PACKAGE_STORE_MAX_WAITERS)return Promise.resolve(refusal(PACKAGE_STORE_CODES.BUSY));
      return this.#join(active,meta.signal);
    }
    const job={...meta,waiters:0,promise:null};
    this.#job=job;
    // Zero terminal-entry lifetime: the entry is removed when the job settles, before any caller sees the result.
    job.promise=(async()=>{try{return await work(job);}finally{this.#job=null;}})();
    return job.promise;
  }
  #join(job,signal){
    job.waiters++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(settle,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',onAbort);job.waiters--;settle(value);};
      const onAbort=()=>finish(resolve,refusal(PACKAGE_STORE_CODES.CANCELLED,{stage:'JOINED'}));
      if(signal?.aborted===true){onAbort();return;}
      signal?.addEventListener('abort',onAbort,{once:true});
      job.promise.then(value=>finish(resolve,structuredClone(value)),error=>finish(reject,error));
    });
  }

  /* ---------- reads of a stored run and export ---------- */

  async #loadRun(db,owner_id,run_id){
    const row=(await db.query(RUN_SQL,[run_id,owner_id])).rows[0];
    if(!row)return null;
    return runViewOf(row,(await db.query(STEP_SQL,[run_id])).rows);
  }
  async #exportRow(db,owner_id,key,sql){
    const row=(await db.query(sql,[owner_id,key])).rows[0];
    return row?{...row,created_at:number(row.created_at)}:null;
  }
  async #exportView(db,row){
    const files=(await db.query(FILE_ROWS,[row.export_id])).rows;
    const events=(await db.query(EVENT_ROWS,[row.export_id])).rows.map(event=>({...event,seq:number(event.seq),attempt_no:event.attempt_no===null?null:number(event.attempt_no),at_ms:number(event.at_ms)}));
    return {row,files,events,status:events.length>0?events[events.length-1].status:null};
  }
  /** Checks a stored export against its own bytes: file hashes and sizes, the manifest, the package hash, the binding hash and the identity. Returns null when consistent, else the first failing check. */
  #integrity(stored){
    const {row,files}=stored,byPath=new Map(files.map(file=>[file.path,file]));
    if(row.mode!=='ONE_PINE'||row.fixture!==true||row.internal!==false)return 'labels';
    for(const file of files)if(hash(toBuffer(file.content))!==file.sha256||toBuffer(file.content).length!==number(file.bytes))return 'file.'+file.path;
    const manifestFile=byPath.get('quant-data/manifest.json');
    if(!manifestFile)return 'manifest';
    let manifest;
    try{manifest=JSON.parse(toBuffer(manifestFile.content).toString('utf8'));}catch{return 'manifest.json';}
    if(packageHash(manifest)!==row.package_hash)return 'package_hash';
    if(bindingHash(row.binding)!==row.binding_hash||canonical(manifest.binding)!==canonical(row.binding))return 'binding_hash';
    if(manifest.identity?.export_id!==row.export_id||manifest.identity?.run_id!==row.run_id)return 'identity';
    return null;
  }
  async #summary(db,row){
    const stored=await this.#exportView(db,row),broken=this.#integrity(stored);
    if(broken!==null)return refusal(PACKAGE_STORE_CODES.STORED_INTEGRITY,{diagnostic:{check:broken}});
    const last=stored.events[stored.events.length-1];
    return {ok:true,action:'LOAD',export_id:row.export_id,run_id:row.run_id,status:stored.status,codes:[...last.codes],created_at_utc:row.created_at_utc,package_hash:row.package_hash,binding_hash:row.binding_hash,fixture:true,ready:false};
  }

  /** The evaluated deployment and its exit version, derived from the artifact of its one SUCCEEDED generate job. The deployment must be the one the run froze (identity and baseline snapshot hash). */
  async #deployment(db,view){
    const contract=view.contract;
    const row=(await db.query(DEPLOYMENT_SQL,[view.owner_id,view.bot_id,contract.deployment_id])).rows[0]??null;
    if(row===null)return {row:null,tied:false};
    const tied=row.pine_import_id===contract.pine_import_id&&row.source_version===contract.source_version&&row.snapshot_hash===contract.baseline_snapshot_hash;
    const jobs=tied?(await db.query(JOB_SQL,[view.owner_id,view.bot_id,row.deployment_id])).rows:[];
    const derived=jobs.length===1?deploymentExitVersion(jobs[0].artifact,row.snapshot,row.deployment_id):null;
    return {row,tied,exit_version:derived?.ok===true?derived.exit_version:undefined};
  }

  /** The live state the gates read, on the given handle, for a stored export (see the module comment for what is and is not recomputed). */
  async #live(db,view,binding){
    const deployment=await this.#deployment(db,view);
    const connected=(await db.query(MEMBERSHIP_SQL,[view.owner_id,view.bot_id])).rows.map(row=>({pine_import_id:row.pine_import_id,source_version:row.source_version,source_hash:row.source_hash}));
    const botState=await this.#readBotState({bot_id:view.bot_id});
    const dataset=await readPackageDataset(db,view.contract);
    const evidenceRows=deployment.row!==null?(await db.query(BRIDGE_EVIDENCE_SQL,[deployment.row.deployment_id])).rows:[];
    const own=connected.find(item=>item.pine_import_id===binding.pine_import_id);
    const sourceCurrent=own!==undefined&&own.source_version===binding.source_version&&own.source_hash===binding.source_hash;
    const current={membership:connected,policy_version:binding.policy_version,policy_hash:botState?.policy_hash,deployment_id:deployment.tied?deployment.row.deployment_id:null,
      input_lock_hash:deployment.tied&&sourceCurrent?binding.input_lock_hash:null,dataset_available:dataset.readable===true&&dataset.digest===binding.dataset_ref?.sha256,bot_owner_id:deployment.row?.owner_id??null};
    return {current,deployment,dataset,isolation:deployment.row!==null?nativeIsolationOf(deployment.row.snapshot_hash,evidenceRows):null};
  }

  /** The candidate records of an export in the shape the gates read: the newest compile record, and per evidence kind the newest record whose digest verifies. */
  async #records(db,row){
    const compiled=(await db.query(COMPILE_ROWS,[row.export_id])).rows,last=compiled[compiled.length-1];
    const compile=last?{export_id:row.export_id,indicator_sha256:last.indicator_sha256,pine_version:last.pine_version,errors:last.errors,warnings:last.warnings,unresolved_references:number(last.unresolved_references),
      collisions:number(last.collisions),duplicate_bindings:number(last.duplicate_bindings),mapping_check:last.mapping_check,compiled_at_utc:last.compiled_at_utc,operator_role:last.operator_role,method:last.method}:null;
    const chosen=new Map();
    for(const record of (await db.query(EVIDENCE_ROW_SQL,[row.export_id])).rows){
      if(digest(record.record)!==record.evidence_hash)continue;   // a record that does not verify is not read (the next older one of its kind is)
      chosen.set(record.kind,record);
    }
    const evidence=Object.fromEntries([...chosen].map(([kind,record])=>[kind,record.record]));
    const clearances=(await db.query(CLEARANCE_ROWS,[row.export_id])).rows.map(item=>({blocker:item.blocker,run_id:item.run_id,export_id:row.export_id,parameter_hash:item.parameter_hash,evidence_hash:item.evidence_hash}));
    return {compile,evidence,clearances,chosen};
  }

  /* ---------- build ---------- */

  build(input,{signal}={}){
    if(this.#db.isTransaction)return Promise.resolve(refusal(PACKAGE_STORE_CODES.IN_TRANSACTION));
    if(!isObject(input)||Object.keys(input).some(key=>!['owner_id','run_id'].includes(key))||!text(input.owner_id)||!text(input.run_id))return Promise.resolve(refusal(PACKAGE_STORE_CODES.NOT_FOUND));
    const {owner_id,run_id}=input;
    return this.#enter({kind:'BUILD',key:'build\0'+owner_id+'\0'+run_id,signal},job=>this.#buildJob(job,owner_id,run_id),true);
  }

  async #buildJob(job,owner_id,run_id){
    const db=this.#db;
    const missing=await this.#requireInstalled();
    if(missing!==null)return missing;
    // LOAD: a later call is a new operator request and starts with the existing-export check. A foreign or absent run is NOT_FOUND and nothing else.
    const view=await this.#loadRun(db,owner_id,run_id);
    if(view===null)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const existing=await this.#exportRow(db,owner_id,run_id,EXPORT_BY_RUN);
    if(existing)return this.#summary(db,existing);
    const contract=view.contract;
    // Fixture path only: the package is labelled a fixture, so the run must be an engineering-scope (fixture) run.
    if(contract?.scope!==ENGINEERING_SCOPE)return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'SCOPE'});
    let stop=this.#cancelled(job,'LOOKUPS');
    if(stop)return stop;
    await this.#step('LOOKUPS');
    const lookups=(await readOnePineLookups(db,view)).lookups;
    // The run-level part of B0 is judged before the evaluator runs: a run B0 would refuse for the run, its history or the register never costs a reproduction.
    const pre=evaluateBuildEligibility({owner_id,run:view,holdout:lookups,binding:{fixture:true},internal:false,current_rules:this.#currentRules});
    const blocking=pre.codes.filter(code=>code!=='BI_BINDING_INCOMPLETE');
    if(blocking.length>0)return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED,{stage:'B0',codes:blocking});
    const deployment=await this.#deployment(db,view);
    const exitVersion=deployment.exit_version;
    // No default may conceal missing provenance: a deployment the run did not freeze, or one whose exit version cannot be derived, refuses before the evaluator runs.
    if(exitVersion===undefined)return refusal('BI_BINDING_INCOMPLETE',{stage:'DEPLOYMENT'});
    // The run closure the service pins must be the closure of the run before the evaluator is paid for (the reproduction checks the closure of its ports too).
    if(await this.#liveEngine()!==contract.engine_hash)return refusal(PACKAGE_STORE_CODES.ENGINE_MISMATCH,{stage:'ENGINE'});
    stop=this.#cancelled(job,'REPRODUCE');
    if(stop)return stop;
    await this.#step('REPRODUCE');
    let reproduction;
    try{reproduction=await reproduceRun({run:view,ports:this.#ports,signal:job.signal});}
    catch(error){
      if(!refusedReproduction(error))throw error;
      if(error.code==='RESEARCH_INTERRUPTED'&&job.signal?.aborted===true)return refusal(PACKAGE_STORE_CODES.CANCELLED,{stage:'REPRODUCE'});
      return refusal(error.code,{stage:'REPRODUCE'});
    }
    stop=this.#cancelled(job,'REPRODUCE');
    if(stop)return stop;
    // The export identity, the time and the build inputs are frozen once; a restart of the transaction reuses them.
    const exportId=this.#ids(),createdAtMs=this.#clock();
    if(typeof exportId!=='string'||!UUID.test(exportId)||!Number.isSafeInteger(createdAtMs)||createdAtMs<1)return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'IDENTITY'});
    const input={export_id:exportId,created_at:isoOf(createdAtMs),fixture:true,run:view,library_versions:{...PACKAGE_LIBRARY_VERSIONS},risk_limits:riskLimitsOf(contract.snapshot?.policy),trace:reproduction.trace,exit_version:exitVersion};
    const render=codes=>{
      try{return {rendered:renderPackage(codes.length>0?{...input,limitations:{codes}}:input)};}
      catch(error){return {error:refusal(typeof error?.code==='string'?error.code:'RENDER_INPUT_INVALID',{stage:'RENDER',detail:String(error?.message??'').slice(0,200)})};}
    };
    await this.#step('RENDER');
    stop=this.#cancelled(job,'RENDER');
    if(stop)return stop;
    let out=render([]);
    if(out.error)return out.error;
    const judge=(run,binding,holdout)=>evaluateBuildEligibility({owner_id,run,holdout,binding,internal:false,current_rules:this.#currentRules});
    await this.#step('B0');
    let b0=judge(view,out.rendered.binding,lookups);
    if(!b0.pass)return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED,{stage:'B0',codes:[...b0.codes]});
    const codes=[...b0.limitations];
    if(codes.length>0){
      await this.#step('RENDER');
      out=render(codes);
      if(out.error)return out.error;
      b0=judge(view,out.rendered.binding,lookups);
      if(!b0.pass)return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED,{stage:'B0',codes:[...b0.codes]});
    }
    // The limitations B0 reports for the final binding are the ones that were rendered, and the manifest carries every one of them.
    const manifestCodes=new Set(out.rendered.manifest?.limitations?.codes??[]);
    if(canonical(sortedCodes(b0.limitations))!==canonical(sortedCodes(codes))||!codes.every(code=>manifestCodes.has(code)))return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'LIMITATIONS'});
    const rendered=out.rendered,files=Object.entries(rendered.files).map(([path,content])=>({path,bytes:Buffer.from(content,'utf8')}));
    if(files.reduce((sum,file)=>sum+file.bytes.length,0)>this.#maxBytes)return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'SIZE'});
    const records=traceReproductionRecords(reproduction,rendered.files,createdAtMs);
    const fileSha=new Map(files.map(file=>[file.path,hash(file.bytes)]));
    if(records.length!==TRACE_FILES.length||records.some(record=>record.sha256!==fileSha.get(record.path)))return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'TRACE_SHA'});
    if(typeof this.#hooks.beforeTransaction==='function')await this.#hooks.beforeTransaction();
    stop=this.#cancelled(job,'TX_BEGIN');
    if(stop)return stop;
    // Phase 2: one SERIALIZABLE transaction. Its first statement reads the export of the run, then everything is read again and B0 runs again before the first insert.
    // After TX_BEGIN the signal is ignored until COMMIT or ROLLBACK ends.
    return this.#transact(async()=>{
      await this.#step('TX_BEGIN');
      const found=await this.#exportRow(db,owner_id,run_id,EXPORT_BY_RUN);
      if(found)return this.#summary(db,found);
      const again=await this.#loadRun(db,owner_id,run_id);
      if(again===null)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
      if(again.contract_hash!==view.contract_hash||again.status!==view.status||canonical(again.result)!==canonical(view.result)||!again.integrity.contract_hash_verified||!again.integrity.report_matches_checkpoints)
        return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'RUN_CHANGED'});
      // Ruling 8: the run closure and the trace closure the reproduction used must still be the live ones. No row and no automatic retry.
      if(await this.#liveEngine()!==contract.engine_hash||await this.#liveTrace()!==reproduction.trace_engine_hash)return refusal(PACKAGE_STORE_CODES.ENGINE_MISMATCH,{stage:'ENGINE'});
      const lookups2=(await readOnePineLookups(db,again)).lookups;
      const deployment2=await this.#deployment(db,again);
      if(deployment2.exit_version!==exitVersion)return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'DEPLOYMENT_CHANGED'});
      const second=judge(again,rendered.binding,lookups2);
      if(!second.pass)return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED,{stage:'B0',codes:[...second.codes]});
      if(canonical(sortedCodes(second.limitations))!==canonical(sortedCodes(codes)))return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'LIMITATIONS'});
      if(typeof this.#hooks.beforeInsert==='function')await this.#hooks.beforeInsert();
      await this.#step('INSERT');
      await this.#insertExport({view:again,rendered,b0:second,files,records,createdAtMs});
      return {ok:true,action:'BUILD',export_id:exportId,run_id,status:'EXPORT_CANDIDATE',codes:[],created_at_utc:rendered.binding.created_at,package_hash:rendered.package_hash,binding_hash:rendered.binding_hash,fixture:true,ready:false};
    },BUILD_RACE_KEYS);
  }

  async #insertExport({view,rendered,b0,files,records,createdAtMs}){
    const db=this.#db,binding=rendered.binding,id=rendered.manifest.identity.export_id;
    for(const file of files)await db.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT (sha256) DO NOTHING',[hash(file.bytes),file.bytes.length,file.bytes]);
    await db.query(`INSERT INTO public.bi_exports(${EXPORT_COLUMNS.join(',')}) VALUES(${EXPORT_COLUMNS.map((_,index)=>'$'+(index+1)).join(',')})`,
      [id,view.owner_id,view.bot_id,view.run_id,null,'ONE_PINE',false,true,PACKAGE_GATE_VERSION,JSON.stringify(PACKAGE_LIBRARY_VERSIONS),JSON.stringify(binding),rendered.binding_hash,rendered.package_hash,JSON.stringify(b0),createdAtMs,binding.created_at]);
    for(const file of files)await db.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[id,file.path,hash(file.bytes),file.bytes.length]);
    await db.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,$2,$3,NULL,$4,$5)',[id,'EXPORT_CANDIDATE',[],createdAtMs,binding.created_at]);
    for(const record of records){
      await db.query(`INSERT INTO public.bi_trace_reproductions(export_id,path,sha256,steps_digest,holdout_digest,trace_engine_hash,run_engine_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id,record.path,record.sha256,record.steps_digest,record.holdout_digest,record.trace_engine_hash,record.run_engine_hash,record.recorded_at_ms]);
    }
  }

  /* ---------- read ---------- */

  async read(input){
    if(!isObject(input)||!text(input.owner_id)||(input.export_id===undefined)===(input.run_id===undefined))return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const key=input.export_id??input.run_id;
    if(!text(key))return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    // db.transaction inside an outer transaction runs its body in that transaction, so SET TRANSACTION READ ONLY would change or fail the caller's transaction.
    if(this.#db.isTransaction)return refusal(PACKAGE_STORE_CODES.IN_TRANSACTION);
    // One READ ONLY REPEATABLE READ transaction: the stored export and the live state it is compared with come from one snapshot. It writes nothing.
    return this.#db.transaction(async()=>{
      const db=this.#db;
      await db.query('SET TRANSACTION READ ONLY');
      const row=await this.#exportRow(db,input.owner_id,key,input.export_id!==undefined?EXPORT_BY_ID:EXPORT_BY_RUN);
      if(!row)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
      const stored=await this.#exportView(db,row),broken=this.#integrity(stored);
      if(broken!==null)return refusal(PACKAGE_STORE_CODES.STORED_INTEGRITY,{diagnostic:{check:broken}});
      const view=await this.#loadRun(db,row.owner_id,row.run_id);
      if(view===null)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
      const live=await this.#live(db,view,row.binding);
      // There is no replay event in this store, so replay_mismatch is false.
      const state=readState({status:stored.status,binding:row.binding,current:live.current,replay_mismatch:false,requester_owner_id:input.owner_id});
      const attempts=(await db.query(ATTEMPT_ROWS,[row.export_id])).rows.map(item=>({attempt_no:number(item.attempt_no),attempt_id:item.attempt_id,pass:item.pass,codes:item.codes}));
      return {ok:true,export:{export_id:row.export_id,owner_id:row.owner_id,bot_id:row.bot_id,run_id:row.run_id,package_hash:row.package_hash,binding_hash:row.binding_hash,created_at:row.created_at,
        created_at_utc:row.created_at_utc,b0:row.b0,library_versions:row.library_versions,fixture:row.fixture,files:stored.files.map(file=>file.path)},status:stored.status,events:stored.events,attempts,
        freshness:{fresh:state.fresh,state:state.state,code:state.code,codes:[...state.codes]},current:live.current,fixture:true,ready:state.ready};
    },{isolation:'REPEATABLE READ'});
  }

  /* ---------- candidate records (fixture records only) ---------- */

  async #openExport(owner_id,export_id){
    if(!text(owner_id)||!text(export_id))return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const row=await this.#exportRow(this.#db,owner_id,export_id,EXPORT_BY_ID);
    if(!row)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const view=await this.#loadRun(this.#db,owner_id,row.run_id);
    if(view===null)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    return {ok:true,row,view};
  }
  /** One compile record for indicator.pine of the export. record: the fixture compile record shape; it defaults to the clean record of the stored indicator bytes. */
  recordCompile({owner_id,export_id,record}={}){
    return this.#transact(async()=>{
      const opened=await this.#openExport(owner_id,export_id);
      if(opened.ok!==true)return opened;
      const file=(await this.#db.query("SELECT sha256 FROM public.bi_package_files WHERE export_id=$1 AND path='indicator.pine'",[export_id])).rows[0];
      const body=record??fixtureCompileRecord({indicatorSha256:file?.sha256??'0'.repeat(64),contract:opened.view.contract});
      const at=this.#clock();
      await this.#db.query(`INSERT INTO public.bi_compile_records(export_id,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,duplicate_bindings,mapping_check,
        compiled_at_ms,compiled_at_utc,operator_role,method) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,[export_id,body.indicator_sha256,body.pine_version,JSON.stringify(body.errors),
        JSON.stringify(body.warnings),body.unresolved_references,body.collisions,body.duplicate_bindings,JSON.stringify(body.mapping_check),at,isoOf(at),body.operator_role,body.method]);
      return {ok:true};
    });
  }
  /** One evidence record (kind, record). record defaults to the passing fixture record of the kind. */
  recordEvidence({owner_id,export_id,kind,record}={}){
    return this.#transact(async()=>{
      const opened=await this.#openExport(owner_id,export_id);
      if(opened.ok!==true)return opened;
      if(!EVIDENCE_KINDS.includes(kind))return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{field:'kind'});
      const body=record??fixtureEvidenceRecord(opened.row.binding,kind),evidenceHash=digest(body);
      await this.#db.query('INSERT INTO public.bi_evidence_records(export_id,kind,record,evidence_hash,recorded_at_ms) VALUES($1,$2,$3::jsonb,$4,$5)',[export_id,kind,JSON.stringify(body),evidenceHash,this.#clock()]);
      return {ok:true,evidence_hash:evidenceHash};
    });
  }
  /** One clearance of a candidate blocker: it names the digest of the newest evidence record of the blocker's kind and the digest of the selected parameters. */
  recordClearance({owner_id,export_id,blocker}={}){
    return this.#transact(async()=>{
      const opened=await this.#openExport(owner_id,export_id);
      if(opened.ok!==true)return opened;
      const kind=Object.hasOwn(CLEARANCE_KIND,blocker)?CLEARANCE_KIND[blocker]:null,records=await this.#records(this.#db,opened.row);
      const proof=kind===null?null:records.chosen.get(kind),selected=opened.view.result?.selected;
      if(!proof||!isObject(selected?.parameters))return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{field:'evidence'});
      await this.#db.query('INSERT INTO public.bi_clearances(export_id,blocker,run_id,parameter_hash,evidence_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5,$6)',
        [export_id,blocker,opened.row.run_id,digest(selected.parameters),proof.evidence_hash,this.#clock()]);
      return {ok:true};
    });
  }

  /* ---------- one validation attempt ---------- */

  attempt(input,{signal}={}){
    if(this.#db.isTransaction)return Promise.resolve(refusal(PACKAGE_STORE_CODES.IN_TRANSACTION));
    if(!isObject(input)||!text(input.owner_id)||!text(input.export_id))return Promise.resolve(refusal(PACKAGE_STORE_CODES.NOT_FOUND));
    const {owner_id,export_id}=input;
    return this.#enter({kind:'ATTEMPT',key:'attempt\0'+owner_id+'\0'+export_id,signal},job=>this.#attemptJob(job,owner_id,export_id),false);
  }

  /** The stored state an attempt starts from, on the given handle: the open export, its run and the next attempt number. */
  async #attemptState(db,owner_id,export_id){
    const row=await this.#exportRow(db,owner_id,export_id,EXPORT_BY_ID);
    if(!row)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const stored=await this.#exportView(db,row);
    if(stored.status!=='EXPORT_CANDIDATE')return refusal(PACKAGE_STORE_CODES.EXPORT_NOT_OPEN,{status:stored.status});
    const broken=this.#integrity(stored);
    if(broken!==null)return refusal(PACKAGE_STORE_CODES.STORED_INTEGRITY,{diagnostic:{check:broken}});
    const view=await this.#loadRun(db,owner_id,row.run_id);
    if(view===null)return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const attemptNo=(await db.query(ATTEMPT_ROWS,[export_id])).rows.length+1;
    if(attemptNo>MAX_VALIDATION_ATTEMPTS)return refusal(PACKAGE_STORE_CODES.EXPORT_NOT_OPEN,{status:stored.status});
    return {ok:true,row,stored,view,attemptNo};
  }

  async #attemptJob(job,owner_id,export_id){
    const db=this.#db;
    const missing=await this.#requireInstalled();
    if(missing!==null)return missing;
    const start=await this.#attemptState(db,owner_id,export_id);
    if(start.ok!==true)return start;
    const contract=start.view.contract;
    // The live engine hash is checked first: a mismatch writes no attempt row.
    if(await this.#liveEngine()!==contract.engine_hash)return refusal(PACKAGE_STORE_CODES.ENGINE_MISMATCH,{stage:'ENGINE'});
    let stop=this.#cancelled(job,'REPRODUCE');
    if(stop)return stop;
    await this.#step('REPRODUCE');
    let reproduction;
    try{reproduction=await reproduceRun({run:start.view,ports:this.#ports,signal:job.signal});}
    catch(error){
      if(!refusedReproduction(error))throw error;
      if(error.code==='RESEARCH_INTERRUPTED'&&job.signal?.aborted===true)return refusal(PACKAGE_STORE_CODES.CANCELLED,{stage:'REPRODUCE'});
      return refusal(error.code,{stage:'REPRODUCE'});
    }
    stop=this.#cancelled(job,'TX_BEGIN');
    if(stop)return stop;
    return this.#transact(async()=>{
      await this.#step('TX_BEGIN');
      const state=await this.#attemptState(db,owner_id,export_id);
      if(state.ok!==true)return state;
      const {row,stored,view,attemptNo}=state,pinned=view.contract;
      if(await this.#liveEngine()!==pinned.engine_hash||await this.#liveTrace()!==reproduction.trace_engine_hash)return refusal(PACKAGE_STORE_CODES.ENGINE_MISMATCH,{stage:'ENGINE'});
      const live=await this.#live(db,view,row.binding),records=await this.#records(db,row);
      const files=Object.fromEntries(stored.files.map(file=>[file.path,toBuffer(file.content).toString('utf8')]));
      const now=this.#clock();
      if(!Number.isSafeInteger(now)||now<1)return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID,{stage:'clock'});
      const traceRecords=this.#traceRecords(row,files,view,reproduction,now);
      const attemptId='attempt-'+this.#ids();
      const validator=digest({gates:PACKAGE_GATE_VERSION,engine_hash:pinned.engine_hash,trace_engine_hash:reproduction.trace_engine_hash});
      const subject={owner_id,run:view,export_id,export:{library_versions:row.library_versions},files,package_hash:row.package_hash,binding_hash:row.binding_hash,binding:row.binding,
        compile:records.compile,native_alert_isolation:live.isolation,evidence:records.evidence,clearances:records.clearances,current:live.current,hard_limits:serverHardLimits(),
        bridge_bounds:bridgeBoundsOf(pinned),deployment:{exit_version:live.deployment.exit_version},dataset:live.dataset,fixture_request:true,trace_reproduction:traceRecords,internal:false,
        current_rules:this.#currentRules,replay_mismatch:false,attempt:{attempt_id:attemptId,validator_engine_hash:validator,validated_at_utc:isoOf(now)},attempt_no:attemptNo};
      await this.#step('GATES',{evidence:records.evidence,bridge_bounds:subject.bridge_bounds,hard_limits:subject.hard_limits});
      const result=evaluatePackage(subject);
      if(isRefused(result))return refusal(String(result.refused),{fields:[...result.fields],ready:false});
      if(result.status===null||(result.pass&&!isObject(result.record)))return refusal(PACKAGE_STORE_CODES.TRANSITION_INVALID,{codes:[...(result.next?.codes??[])]});
      const codes=[...result.codes],gates=result.gates.map(item=>({gate:item.gate,state:item.state,pass:item.pass,codes:[...item.codes]}));
      const refs={evidence_hashes:Object.fromEntries([...records.chosen].map(([kind,item])=>[kind,item.evidence_hash])),clearances:records.clearances.length,compile_present:records.compile!==null,
        trace_engine_hash:reproduction.trace_engine_hash,run_engine_hash:reproduction.run_engine_hash};
      await db.query(`INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,[export_id,attemptNo,attemptId,row.package_hash,result.pass,codes,JSON.stringify(gates),JSON.stringify(refs),validator,now,isoOf(now)]);
      if(result.pass){
        const record=result.record;
        await db.query(`INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,[export_id,record.package_hash,record.binding_hash,record.attempt_id,JSON.stringify(record.gate_results),record.validator_engine_hash,record.fixture,now,record.validated_at_utc]);
      }
      const seq=stored.events[stored.events.length-1].seq+1;
      await db.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,$2,$3,$4,$5,$6,$7)',[export_id,seq,result.status,[...result.next.codes],attemptNo,now,isoOf(now)]);
      return {ok:true,attempt_no:attemptNo,attempt_id:attemptId,pass:result.pass,status:result.status,codes,gates:gates.map(item=>({gate:item.gate,state:item.state,codes:item.codes})),event_codes:[...result.next.codes],fixture:true,ready:false};
    },ATTEMPT_RACE_KEYS);
  }

  /** The S3 reproduction as trace records for C3: the three trace files are rendered again from the RECOMPUTED trace with the identity, time, versions and limitations of the stored export, and each record
   * names the digest of those recomputed bytes. A stored trace file that differs from its recomputation therefore fails C3. A render that cannot be repeated gives no record (C3 then reports both mismatches). */
  #traceRecords(row,files,view,reproduction,at){
    try{
      const manifest=JSON.parse(files['quant-data/manifest.json']),profile=JSON.parse(files['risk-profile.json']);
      const rendered=renderPackage({export_id:row.export_id,created_at:row.binding.created_at,fixture:row.fixture,run:view,library_versions:row.library_versions,risk_limits:profile.limits,trace:reproduction.trace,
        exit_version:row.binding.exit_version,limitations:{codes:manifest.limitations.codes},...(isObject(row.binding.holdout_boundary_ref)?{holdout_boundary_ref:row.binding.holdout_boundary_ref}:{})});
      return [...traceReproductionRecords(reproduction,rendered.files,at)];
    }catch{return [];}
  }
}
