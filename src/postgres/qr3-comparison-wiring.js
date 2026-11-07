import {canonical,hash,fail} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {validateBar} from './pine-bridge-market.js';
import {contentDigest} from '../quant-research/research-contract-v2.js';
import {validateFixedEvalContract,validateFixedEvalResult,validateFixedEvalBinding} from '../quant-research/fixed-eval-contract.js';
import {QuantFixedEvalService,validateFixedEvalRecords} from './quant-fixed-eval.js';
import {fixedEvalEngineHash} from './quant-fixed-eval-engine.js';
import {finalizeComparison} from './comparison-finalizer.js';
import {readComparison,readComparisonResults,failComparison,writeReplayEvent} from './comparison-store.js';
import {evaluationRecordBody,benchmarkRecordBody,outcomeRecord} from '../comparison/evaluation-record.js';
import {classifyEvidence,windowsOverlap} from '../comparison/evidence.js';
import {checkCoverage} from '../comparison/period.js';
import {contextFields,contextKey} from '../comparison/context.js';
import {CODES,MINUTE,isObject} from '../comparison/common.js';
import {LIBRARY_VERSIONS} from '../quant-library/derive.js';

/**
 * QR-3 wiring inside the fixed-evaluation closure (L8-W, owner GO OG-1; Root rulings SB180 RR-2 and RR-3, SB184 RR-10, RR-11 and RR-12). This module is listed in
 * the runtime engine manifest, so every byte here is part of the engine identities. It holds three things:
 *
 *  1. Qr3EvaluationDriver: the bounded tick loop that the fixed-evaluation worker main starts only when QUANT_FIXED_EVAL_ENABLED and QR3_COMPARISON_ENABLED are
 *     both exactly '1'. Each tick takes at most 8 SPEC_FROZEN or EVALUATING comparisons, oldest freeze first. It admits one fixed run per participant through the
 *     fixed-evaluation service (idempotent key from the comparison id and the participant id) and then calls the finalizer. The finalizer runs outside any
 *     transaction and outside the scheduler lock; this module takes no lock of its own.
 *     Admission refusals (RR-10): retry on the next tick with no status change for ADMISSION_RETRY codes, any SQLSTATE and any non-application error; no-op for
 *     ADMISSION_NOOP codes; every other application refusal fails the comparison with PARTICIPANT_ADMISSION_REFUSED. Bound (hardening slice B, owner GO OG-2):
 *     a SQLSTATE or non-application admission error, and a thrown driver error, count per comparison per process; the comparison skips 2^min(n,5) ticks and
 *     is held after ADMISSION_HOLD_BOUND consecutive failures (logged, no status written, left for owner cancel). The global back-pressure codes of
 *     ADMISSION_RETRY never count. stop() starts nothing new and waits at most stop_grace_ms for the pass in flight.
 *     Finalizer refusals (RR-11): QR3_INTEGRITY_FAILED with a FINALIZE_TRANSIENT detail is retried on later ticks up to FINALIZE_RETRY_BOUND consecutive attempts per
 *     process, then the comparison is held (logged, left for owner cancel); every other refusal fails the comparison with QR3_INTEGRITY_FAILED.
 *  2. The finalizer dependencies (createFinalizerDeps): the contract validators, readEvaluation (one READ ONLY read of the stored run, its validated contract and
 *     its verified binding), readRows (the market bars of the run, verified against the binding hash with the worker's own rules, restated here) and
 *     participantInputs (RR-3: every input from stored create-time facts only, so a replay is deterministic).
 *  3. createQr3ApiDeps: what the owner API needs from the closure: the engine hash (C7), the shared dataset digest (C6) and the record replay (RR-12). The server
 *     builds them only when QR3_COMPARISON_ENABLED is exactly '1'.
 *
 * Record replay (RR-12) re-reads every fixed run, re-verifies its bars against the binding hash and rebuilds the bodies, the benchmark and the outcome with the
 * same pure functions and the same RR-3 inputs. It writes one replay event: REPLAY_MATCH, REPLAY_MISMATCH with the first differing code, or REPRODUCTION_DISABLED
 * only when a run or its bars are gone or no longer verify (REPLAY_DISABLED_CODES); a transient database error records nothing and is thrown. The outcome row
 * never changes. It does not re-run the Python evaluator (recorded limitation). It runs single-flight per process. It starts no job.
 *
 * Independence facts and library gates (hardening slice B, owner GO OG-2, Root ruling SB194 item 3): participantInputs maps the create-time independence block
 * of the participant freeze (earlier holdouts, searched windows, registered boundary, source holdout window and register, G1 to G8 gate snapshot) into the
 * evidence classifier and fails closed on every explicit unavailable state (independenceInputs). An unreadable stored register excludes the participant on
 * integrity. The V8 hold stays: every evaluated participant is DEVELOPMENT_EVIDENCE and the outcome is NO_QUALIFIED_RESULT. Nothing here reads a clock or a
 * random source of its own.
 */
export const DRIVER_LIMITS=Object.freeze({tick_ms:15000,comparisons_per_tick:8,stop_grace_ms:10000});
export const FINALIZE_RETRY_BOUND=5;
/** SB187 item 3 (d), hardening packet RR-10a: consecutive counted admission failures before a hold, and the backoff cap (skip 2^min(n,5) ticks, at most 32). */
export const ADMISSION_HOLD_BOUND=20;
export const ADMISSION_BACKOFF_MAX_EXPONENT=5;
export const ADMISSION_RETRY=Object.freeze(['FOUNDATION_QUEUE_FULL','RESEARCH_EXECUTOR_MODE_MISMATCH','FIXED_EVAL_IMMUTABLE_AUTHORITY_REQUIRED','FIXED_EVAL_AUTHORITY_UNAVAILABLE']);
export const ADMISSION_NOOP=Object.freeze(['FIXED_EVAL_ALREADY_STARTED','FIXED_EVAL_OBJECT_NOT_EVALUATING']);
export const FINALIZE_TRANSIENT=Object.freeze(['READ_EVALUATION','READ_ROWS','PARTICIPANT_INPUTS']);
export const ADMISSION_REFUSED_REASON='PARTICIPANT_ADMISSION_REFUSED';
export const REPLAY_CODES=Object.freeze({CLOSED:'QR3_ADMISSION_CLOSED',NOT_COMPLETE:'REPLAY_NOT_COMPLETE',BUSY:'REPLAY_BUSY'});
const REPLAY_VERSION='qr3-record-replay-v1';
/** The version of the create-time independence block (restated; the create module is outside this closure and is never imported here, SB194 item 3). */
export const INDEPENDENCE_VERSION='qr3-independence-v1';
const readableWindow=value=>windowsOverlap(value,value);
const SQLSTATE=/^[0-9A-Z]{5}$/;
const REASON=/^[A-Z][A-Z0-9_]{1,63}$/;
const TERMINAL=Object.freeze(['COMPLETE','FAILED','CANCELLED']);
const need=(ok,code)=>{if(!ok)throw fail(code,409);};
const refuse=(code,detail=null)=>({ok:false,code,detail});

/** The idempotency key of one participant's fixed run: 'qr3-' plus the hash of the canonical comparison and participant ids (68 characters). */
export const admissionKey=(comparisonId,participantId)=>'qr3-'+hash(canonical({comparison_id:comparisonId,participant_id:participantId}));

/** RR-10. An application refusal is an Error with an integer status and a code that is not a SQLSTATE (the worker's own rule). */
export function classifyAdmission(error){
  const code=error?.code;
  if(typeof code==='string'&&ADMISSION_NOOP.includes(code))return 'NOOP';
  if(typeof code==='string'&&ADMISSION_RETRY.includes(code))return 'RETRY';
  const application=error instanceof Error&&Number.isInteger(error.status)&&typeof code==='string'&&!SQLSTATE.test(code);
  return application?'FAIL':'RETRY';
}

/** RR-11. DONE for any finalizer answer, TRANSIENT for a dependency read refusal, FAIL for every other refusal. */
export function classifyFinalize(result){
  if(result?.ok===true)return 'DONE';
  if(result?.code===CODES.QR3_INTEGRITY_FAILED&&FINALIZE_TRANSIENT.includes(result.detail))return 'TRANSIENT';
  return 'FAIL';
}

/** Runs work in the caller's READ ONLY transaction or in its own REPEATABLE READ READ ONLY one; it fails closed if the server does not report read-only. */
async function inReadOnly(db,work){
  const check=async()=>{need((await db.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0]?.mode==='on','QR3_READ_ONLY_REQUIRED');};
  if(db.isTransaction===true){await check();return work();}
  return db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');await check();return work();},{isolation:'REPEATABLE READ'});
}

/** The fixed runs of one comparison (the finalizer's own lookup, restated). */
async function runsOf(db,owner,comparisonId){
  return (await db.query(`SELECT run_id,status,contract#>>'{lineage,parent_run_id}' AS participant_id FROM public.quant_jobs
    WHERE owner_id=$1 AND contract->>'mode'='FIXED_INPUT_EVAL' AND contract->>'purpose'='QR3_COMPARISON' AND contract#>>'{lineage,object_id}'=$2 ORDER BY run_id`,[owner,comparisonId])).rows;
}

/**
 * The verified market bars of one closed range: exactly count rows with consecutive close times, each row's bar time, profile and content hash checked, and,
 * when a cost model is given, the bar shape and its tick and step (the worker's preparation rules, restated). Returns the database rows.
 */
async function verifiedBars(db,{first,last,count,profile,model=null}){
  const rows=[];let after=first-1;
  while(rows.length<count){
    const page=(await db.query(`SELECT * FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'
      AND bar_time>$1 AND bar_time<=$2 ORDER BY bar_time LIMIT 1000`,[after,last])).rows;
    if(!page.length)break;
    for(const row of page){
      const time=Number(row.bar_time);
      need(rows.length<count&&time===first+rows.length*MINUTE&&row.bar?.time===time&&row.provenance?.profile===profile&&hash(canonical(row.bar))===row.content_hash,'VERIFIED_MARKET_DATA_REQUIRED');
      if(model){validateBar(row.bar);need(D(row.bar.price_tick).eq(model.price_tick)&&D(row.bar.quantity_step).eq(model.quantity_step),'MARKET_METADATA_MISMATCH');}
      rows.push(row);
    }
    after=Number(page.at(-1).bar_time);
  }
  need(rows.length===count&&Number(rows.at(-1)?.bar_time)===last,'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
  return rows;
}
/** The dataset SHA-256 of the worker's preparation (restated): the hash of the canonical list of {bar, content_hash, provenance}. */
const datasetSha=rows=>hash(canonical(rows.map(row=>({bar:row.bar,content_hash:row.content_hash,provenance:row.provenance}))));

/** The validated read of one terminal fixed run: {contract, binding, result} with the dataset SHA verified against its immutable authority. */
async function readEvaluationOf(service,owner,runId){
  const db=service.db;
  return inReadOnly(db,async()=>{
    const read=await service.read(owner,runId);
    need(read.status==='SUCCEEDED'&&read.dataset_sha_verified===true,'FIXED_EVAL_RUN_NOT_SUCCEEDED');
    const stored=await service.storedRun(owner,runId);
    const chunks=(await db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1',[String(runId)])).rows;
    const steps=(await db.query('SELECT * FROM public.quant_job_steps WHERE run_id=$1',[String(runId)])).rows;
    const records=validateFixedEvalRecords(stored.contract,{chunks,steps,evaluations_started:stored.row.evaluations_started,run_id:String(runId),complete:true});
    need(records.binding.dataset_sha256===read.dataset_sha256,'FIXED_EVAL_DATASET_SHA_MISMATCH');
    return {contract:stored.contract,binding:records.binding,result:read.result};
  });
}

/** The dataset rows of one run (time, open, high, low, close, volume, atr14), only through its verified binding: the bars must give the binding's dataset hash. */
async function readRowsOf(db,owner,runId,binding){
  return inReadOnly(db,async()=>{
    const row=(await db.query('SELECT contract,contract_hash FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2',[String(runId),owner])).rows[0];
    need(!!row&&hash(canonical(row.contract))===row.contract_hash,'NOT_FOUND');
    const contract=validateFixedEvalContract(row.contract),checked=validateFixedEvalBinding(contract,binding);
    need(canonical(checked)===canonical(binding),'FIXED_EVAL_DATASET_BINDING_INVALID');
    const d=contract.dataset,model=contract.cost_model;
    const rows=await verifiedBars(db,{first:d.first_time,last:d.end_time,count:d.bar_count,profile:model.data_profile,model});
    need(contentDigest(rows)===d.content_digest,'FIXED_EVAL_DATASET_CHANGED');
    need(datasetSha(rows)===checked.dataset_sha256,'FIXED_EVAL_DATASET_SHA_MISMATCH');
    return rows.map(({bar})=>({time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,atr14:bar.atr14}));
  });
}

/** Register entries of the evidence classifier from one stored create-time list ({kind, id, window, at_ms}), with the owner and market key added; null when unreadable. */
function registerEntries(owner,marketKey,list){
  if(!Array.isArray(list))return null;
  return list.map(item=>isObject(item)?{owner_id:owner,market_key:marketKey,window:item.window,kind:item.kind,at_ms:item.at_ms,
    ...(item.kind==='QR4_SELECTION'?{selection_id:item.id}:{comparison_id:item.id})}:null);
}
/** Library gate snapshot (gateSnapshot shape {version, gates:[{gate, state, code}]}) to the classifier shape [{gate, state, codes}]; null (every gate FAIL) when unreadable. */
function libraryGates(snapshot){
  if(!isObject(snapshot)||snapshot.version!==LIBRARY_VERSIONS.qualification||!Array.isArray(snapshot.gates))return null;
  return snapshot.gates.map(item=>isObject(item)?{gate:item.gate,state:item.state,codes:typeof item.code==='string'?[item.code]:[]}:null);
}

/**
 * The create-time independence facts of one participant (hardening slice B, owner GO OG-2; Root ruling SB194 item 3) mapped to the classifier inputs. Every explicit
 * unavailable state fails closed: a null or malformed list stays null (the classifier adds QR3_INTEGRITY_FAILED); a boundary that is not NONE or SET with an integer
 * start becomes a non-integer (QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY); a missing or unknown-version block, a source holdout that is UNAVAILABLE or unknown, or a SET
 * source holdout without a readable window and register sets integrity false; a missing gate snapshot makes every gate FAIL. The one exposure register is the
 * stored prior_exposed_by merged with the stored source_holdout_register (null when either is unreadable). Nothing is defaulted and nothing is read live.
 */
export function independenceInputs({owner_id:owner,market_key:marketKey,participant}){
  const freeze=isObject(participant?.freeze)?participant.freeze:{},block=freeze.independence;
  const prior=registerEntries(owner,marketKey,freeze.prior_exposed_by);
  const base={imported:participant?.origin==='IMPORTED',earlier_holdouts:null,searched_windows:null,source_holdout_window:null,exposure_register:prior,registered_boundary_ms:'UNREADABLE',library_gates:null};
  if(!isObject(block)||block.version!==INDEPENDENCE_VERSION)return {integrity_ok:false,classifier:base};
  const holdouts=Array.isArray(block.earlier_holdouts)?block.earlier_holdouts.map(item=>({owner_id:owner,market_key:marketKey,window:isObject(item)?item.window:null})):null;
  const searched=Array.isArray(block.searched_windows)?block.searched_windows.map(item=>({owner_id:owner,source_hash:participant.source_hash,window:isObject(item)?item.window:null})):null;
  const boundary=block.registered_boundary;
  const boundaryMs=isObject(boundary)&&boundary.state==='NONE'?null:isObject(boundary)&&boundary.state==='SET'&&Number.isSafeInteger(boundary.start_ms)?boundary.start_ms:'UNREADABLE';
  const state=block.source_holdout_state,sourceRegister=registerEntries(owner,marketKey,block.source_holdout_register);
  const sourceOk=state==='NONE'?sourceRegister!==null:state==='SET'?readableWindow(block.source_holdout_window)&&sourceRegister!==null:false;
  const register=prior!==null&&sourceRegister!==null?[...prior,...sourceRegister]:null;
  return {integrity_ok:sourceOk,classifier:{...base,earlier_holdouts:holdouts,searched_windows:searched,source_holdout_window:state==='SET'&&sourceOk?block.source_holdout_window:null,
    exposure_register:register,registered_boundary_ms:boundaryMs,library_gates:libraryGates(block.library_gates)}};
}

/**
 * RR-3: the participantStatus inputs of one participant, from stored create-time facts only (the comparison, its frozen participant row, the stored evaluation
 * record and the stored fixed run). One READ ONLY transaction. A database error is thrown (the finalizer then refuses PARTICIPANT_INPUTS and the driver retries).
 */
async function participantInputsOf(service,owner,comparisonId,participantId){
  const db=service.db;
  return inReadOnly(db,async()=>{
    const head=await readComparison(db,{owner_id:owner,comparison_id:comparisonId});
    need(head.ok,'QR3_COMPARISON_UNREADABLE');
    const results=await readComparisonResults(db,{owner_id:owner,comparison_id:comparisonId});
    need(results.ok,'QR3_RESULTS_UNREADABLE');
    const {comparison}=head,participant=head.participants.find(item=>item.participant_id===participantId);
    need(!!participant,'NOT_FOUND');
    const stored=results.evaluations.find(item=>item.participant_id===participantId)??null;
    const run=(await runsOf(db,owner,comparisonId)).filter(item=>item.participant_id===participantId);
    let evaluated=null;
    if(run.length===1&&run[0].status==='SUCCEEDED'){
      try{evaluated=await readEvaluationOf(service,owner,run[0].run_id);}
      catch(error){if(classifyAdmission(error)!=='FAIL')throw error;evaluated=null;}
    }
    const lineage=evaluated?.contract?.lineage;
    const integrity=evaluated!==null&&evaluated.contract.purpose==='QR3_COMPARISON'&&lineage?.object_id===comparisonId&&lineage?.parent_run_id===participantId&&
      (stored===null||stored.evaluation_run_id===run[0].run_id);
    const context=contextFields(participantId,participant.freeze.context);
    const compatible=context.missing.length===0&&contextKey(context.fields)===comparison.context_key&&participant.context_key===comparison.context_key;
    const d=evaluated?.contract?.dataset;
    // The scored interval of the fixed contract after the warm-up (the inverse of the admission window): start S, end E.
    const covered=d?{start_ms:d.start_time+d.warmup_bars*MINUTE-MINUTE,end_ms:d.end_time}:null;
    const coverage=checkCoverage({period:comparison.spec.period,covered});
    const market=comparison.market,marketKey=market.broker+':'+market.symbol+':'+market.timeframe;
    const facts=independenceInputs({owner_id:owner,market_key:marketKey,participant});
    const classified=classifyEvidence({participant_id:participantId,owner_id:owner,market_key:marketKey,source_hash:participant.source_hash,window:comparison.spec.period,
      record_created_at_ms:stored?stored.created_at_ms:null,record_comparison_id:stored?.record_comparison_id??null,record_spec_hash:stored?.record_spec_hash??null,
      spec_hash:comparison.spec_hash,frozen_at_ms:comparison.frozen_at_ms,as_of_ms:comparison.frozen_at_ms,comparison_id:comparisonId,
      viewable_before_freeze:false,from_stored_view:false,...facts.classifier});
    // SB187 item 3 (b): an unreadable stored register is a damaged freeze row, so the participant is excluded on integrity (metrics hidden); the code stays in the reasons
    const evidence=classified.ok===false?{evidence_class:stored?'DEVELOPMENT_EVIDENCE':'NOT_EVALUATED',reasons:[classified.code]}
      :{evidence_class:classified.evidence_class,reasons:[...classified.reasons],failing_gates:[...classified.failing_gates],gate_codes:[...classified.gate_codes],exposed_by:[...classified.exposed_by]};
    const inputs={integrity_ok:integrity&&facts.integrity_ok&&classified.ok!==false,unavailable:false,compatibility:{compatible},coverage:{state:coverage.state},evidence,episode_gate_available:false};
    if(stored)inputs.completed_episodes=stored.body.completed_episodes;
    return inputs;
  });
}

/** The finalizer dependencies over one fixed-evaluation service (its database and its Pine service). */
export function createFinalizerDeps({fixedEvalService:service}){
  if(!service?.db||typeof service.read!=='function'||typeof service.storedRun!=='function')throw Error('QR-3 finalizer dependencies require the fixed-evaluation service');
  return Object.freeze({validators:Object.freeze({validateFixedEvalContract,validateFixedEvalResult}),
    readEvaluation:(owner,runId)=>readEvaluationOf(service,owner,runId),
    readRows:(owner,runId,binding)=>readRowsOf(service.db,owner,runId,binding),
    participantInputs:(owner,comparisonId,participantId)=>participantInputsOf(service,owner,comparisonId,participantId)});
}

/**
 * The bounded evaluation driver (RR-10, RR-11, SB184 driver numbers). tick() is one pass and returns a summary per comparison; start() runs it now and then every
 * tickMs; stop() ends the loop and waits for the pass in flight.
 */
export class Qr3EvaluationDriver{
  constructor({fixedEvalService,deps=null,tickMs=DRIVER_LIMITS.tick_ms,perTick=DRIVER_LIMITS.comparisons_per_tick,retryBound=FINALIZE_RETRY_BOUND,
    admissionBound=ADMISSION_HOLD_BOUND,stopGraceMs=DRIVER_LIMITS.stop_grace_ms,log=null}={}){
    if(!fixedEvalService?.db||typeof fixedEvalService.enqueue!=='function')throw Error('QR-3 evaluation driver requires the fixed-evaluation service');
    if(![tickMs,perTick,retryBound,admissionBound].every(value=>Number.isSafeInteger(value)&&value>=1)||!Number.isSafeInteger(stopGraceMs)||stopGraceMs<0)
      throw Error('QR-3 evaluation driver limits are invalid');
    this.service=fixedEvalService;this.db=fixedEvalService.db;this.deps=deps??createFinalizerDeps({fixedEvalService});
    this.tickMs=tickMs;this.perTick=perTick;this.retryBound=retryBound;this.admissionBound=admissionBound;this.stopGraceMs=stopGraceMs;
    this.log=typeof log==='function'?log:event=>console.log(JSON.stringify(event));
    this.transient=new Map();this.held=new Set();this.timer=null;this.running=null;this.stopping=false;
    // per process: consecutive counted admission failures {count, resume_tick} and the tick counter of the backoff
    this.backoff=new Map();this.ticks=0;
  }
  /** Comparisons that are held or still backing off; pending() leaves them out, so they never take one of the perTick slots. */
  excluded(){
    return [...this.held,...[...this.backoff].filter(([,entry])=>entry.resume_tick>this.ticks).map(([id])=>id)];
  }
  /** At most perTick SPEC_FROZEN or EVALUATING comparisons of every owner, oldest freeze first, held and backing-off ones excluded. READ ONLY. */
  async pending(){
    return inReadOnly(this.db,async()=>(await this.db.query(`SELECT s.comparison_id,s.owner_id,e.status FROM public.quant_comparison_specs s
      JOIN LATERAL (SELECT status FROM public.quant_comparison_status_events WHERE comparison_id=s.comparison_id ORDER BY seq DESC LIMIT 1) e ON true
      WHERE e.status IN ('SPEC_FROZEN','EVALUATING') AND s.comparison_id<>ALL($1::text[]) ORDER BY s.frozen_at_ms,s.comparison_id LIMIT $2`,[this.excluded(),this.perTick])).rows);
  }
  /**
   * SB187 item 3 (d): one counted failure (a SQLSTATE or non-application admission error, or a thrown driver error). The comparison skips the next
   * 2^min(n, ADMISSION_BACKOFF_MAX_EXPONENT) ticks; after admissionBound consecutive failures it is held (logged, no status written, left for owner cancel).
   * The global back-pressure codes of ADMISSION_RETRY are never counted: they block every comparison alike.
   */
  counted(comparisonId,code){
    const count=(this.backoff.get(comparisonId)?.count??0)+1;
    if(count>=this.admissionBound){
      this.backoff.delete(comparisonId);this.held.add(comparisonId);
      this.log({event:'qr3.admission_held',comparison_id:comparisonId,code,attempts:count});
      return {held:true,attempts:count};
    }
    this.backoff.set(comparisonId,{count,resume_tick:this.ticks+2**Math.min(count,ADMISSION_BACKOFF_MAX_EXPONENT)});
    return {held:false,attempts:count};
  }
  async fail(item,reason,cause){
    const failed=await failComparison(this.db,{owner_id:item.owner_id,comparison_id:item.comparison_id,reason_code:reason});
    this.log({event:'qr3.comparison_failed',comparison_id:item.comparison_id,reason_code:reason,cause:cause??null,written:failed.ok===true,store_code:failed.ok?null:failed.code});
    this.transient.delete(item.comparison_id);
    // a comparison that became terminal first (owner cancel, COMPLETE) keeps that status: the store refuses the edge and nothing is written
    return {comparison_id:item.comparison_id,result:failed.ok?'FAILED':'FAIL_NOT_WRITTEN',reason_code:reason,cause:cause??null,store_code:failed.ok?null:failed.code};
  }
  /** Admission of every participant without a fixed run. Returns null to go on to the finalizer, or the summary that ends this comparison's pass. */
  async admit(item){
    const head=await readComparison(this.db,{owner_id:item.owner_id,comparison_id:item.comparison_id});
    if(!head.ok)return null;
    if(TERMINAL.includes(head.status.status))return {comparison_id:item.comparison_id,result:'TERMINAL'};
    const started=new Set((await inReadOnly(this.db,()=>runsOf(this.db,item.owner_id,item.comparison_id))).map(row=>row.participant_id));
    const enqueued=[];
    for(const participant of head.participants){
      if(started.has(participant.participant_id))continue;
      if(this.stopping)return {comparison_id:item.comparison_id,result:'STOPPED',enqueued};
      try{
        const job=await this.service.enqueue(item.owner_id,{purpose:'QR3_COMPARISON',object_id:item.comparison_id,participant_id:participant.participant_id},
          admissionKey(item.comparison_id,participant.participant_id));
        enqueued.push(job.run_id);
      }catch(error){
        const kind=classifyAdmission(error),code=typeof error?.code==='string'?error.code:null;
        if(kind==='NOOP')continue;
        if(kind==='RETRY'){
          this.log({event:'qr3.admission_retry',comparison_id:item.comparison_id,code});
          if(ADMISSION_RETRY.includes(code))return {comparison_id:item.comparison_id,result:'ADMISSION_RETRY',code,enqueued};
          const bound=this.counted(item.comparison_id,code);
          return {comparison_id:item.comparison_id,result:bound.held?'ADMISSION_HELD':'ADMISSION_RETRY',code,attempts:bound.attempts,enqueued};
        }
        return this.fail(item,ADMISSION_REFUSED_REASON,code);
      }
    }
    item.enqueued=enqueued;
    return null;
  }
  async finalize(item){
    const result=await finalizeComparison(this.db,{owner_id:item.owner_id,comparison_id:item.comparison_id},this.deps);
    const kind=classifyFinalize(result),enqueued=item.enqueued??[];
    if(kind==='DONE'){this.transient.delete(item.comparison_id);return {comparison_id:item.comparison_id,result:result.state,enqueued,reason_code:result.reason_code??null};}
    if(kind==='TRANSIENT'){
      const attempts=(this.transient.get(item.comparison_id)??0)+1;
      this.transient.set(item.comparison_id,attempts);
      if(attempts>=this.retryBound){
        this.held.add(item.comparison_id);this.transient.delete(item.comparison_id);
        this.log({event:'qr3.finalize_held',comparison_id:item.comparison_id,code:result.code,detail:result.detail,attempts});
        return {comparison_id:item.comparison_id,result:'HELD',code:result.code,detail:result.detail,attempts,enqueued};
      }
      this.log({event:'qr3.finalize_retry',comparison_id:item.comparison_id,code:result.code,detail:result.detail,attempts});
      return {comparison_id:item.comparison_id,result:'FINALIZE_RETRY',code:result.code,detail:result.detail,attempts,enqueued};
    }
    return this.fail(item,CODES.QR3_INTEGRITY_FAILED,REASON.test(result?.detail??'')?result.detail:result?.code??null);
  }
  async drive(item){
    const admitted=await this.admit(item);
    if(admitted){
      if(['TERMINAL','FAILED','FAIL_NOT_WRITTEN'].includes(admitted.result))this.backoff.delete(item.comparison_id);
      return admitted;
    }
    const done=await this.finalize(item);
    // a pass that reaches the finalizer and returns has admitted every participant: the count of consecutive admission failures restarts
    this.backoff.delete(item.comparison_id);
    return done;
  }
  /**
   * One pass. A thrown database error ends that comparison's pass with no status change and counts toward the admission bound (backoff, then hold); a later tick
   * retries it. A stop request ends the pass before the next comparison.
   */
  async tick(){
    const summary=[];
    this.ticks+=1;
    for(const item of await this.pending()){
      if(this.stopping)break;
      try{summary.push(await this.drive({comparison_id:item.comparison_id,owner_id:item.owner_id}));}
      catch(error){
        const code=typeof error?.code==='string'?error.code:null;
        this.log({event:'qr3.driver_error',comparison_id:item.comparison_id,code});
        const bound=this.counted(item.comparison_id,code);
        summary.push({comparison_id:item.comparison_id,result:'ERROR',code,attempts:bound.attempts,held:bound.held});
      }
    }
    return summary;
  }
  start(){
    if(this.timer!==null||this.running!==null||this.stopping)return;
    const loop=()=>{
      this.timer=null;
      if(this.stopping)return;
      this.running=this.tick().catch(error=>{this.log({event:'qr3.driver_error',comparison_id:null,code:typeof error?.code==='string'?error.code:null});})
        .finally(()=>{this.running=null;if(!this.stopping)this.timer=setTimeout(loop,this.tickMs);});
    };
    this.timer=setTimeout(loop,0);
  }
  /**
   * SB187 item 3 (f): ends the loop. No new comparison or admission starts after this call. It waits for the pass in flight or for graceMs, whichever ends first
   * (the grace timer is unref'd and always cleared). A pass left running stops between steps: every finalizer write is its own insert-only transaction and the
   * next call recovers a stop after any single write.
   */
  async stop({graceMs=this.stopGraceMs}={}){
    this.stopping=true;
    if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}
    if(!this.running)return;
    let grace=null;
    try{await Promise.race([this.running,new Promise(resolve=>{grace=setTimeout(resolve,graceMs);grace.unref?.();})]);}
    finally{clearTimeout(grace);}
  }
}

/* ---- RR-12: record replay ---- */

/**
 * SB187 item 3 (c), contract I5: the application codes of the replay read path that mean the archived data or the evaluator artifact is gone or no longer
 * verifies. Only these record REPRODUCTION_DISABLED. Every other error (a SQLSTATE, a lost connection, a non-application error, a read-only or transaction
 * guard, any other code) is thrown: no replay event is written and the route answers RETRY_TRANSACTION or QUANT_LIBRARY_UNAVAILABLE.
 */
export const REPLAY_DISABLED_CODES=Object.freeze(['NOT_FOUND','FIXED_EVAL_RUN_NOT_SUCCEEDED','FIXED_EVAL_RESULT_INVALID','FIXED_EVAL_AUTHORITY_INVALID',
  'FIXED_EVAL_DATASET_SHA_MISMATCH','FIXED_EVAL_DATASET_BINDING_INVALID','FIXED_EVAL_DATASET_CHANGED','VERIFIED_MARKET_DATA_REQUIRED','MARKET_METADATA_MISMATCH',
  'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET','FIXED_EVAL_RECORDS_INVALID','INVALID_MARKET_BAR']);
/** True only for an application refusal (an Error with an integer status) whose code is in REPLAY_DISABLED_CODES. */
export const replayDisables=error=>classifyAdmission(error)==='FAIL'&&REPLAY_DISABLED_CODES.includes(error.code);

const differing=answer=>typeof answer?.detail==='string'&&REASON.test(answer.detail)?answer.detail:typeof answer?.code==='string'&&REASON.test(answer.code)?answer.code:'REPLAY_REFUSED';

/**
 * Record replay of one COMPLETE comparison (RR-12). Returns {ok:true, kind, first_differing_code, replay_event_id, at_ms, prior_outcome_hash, replay_outcome_hash}
 * or a refusal: NOT_FOUND (absent, foreign or malformed id), QR3_ADMISSION_CLOSED with detail REPLAY_NOT_COMPLETE, or a store refusal. deps are the finalizer
 * dependencies. Writes nothing but the replay event; the outcome row never changes.
 */
export async function replayComparison(db,{owner_id:owner,comparison_id:comparisonId}={},deps){
  if(!db||typeof db.transaction!=='function'||db.isTransaction===true)throw Error('replayComparison requires its own transaction handling');
  const head=await readComparison(db,{owner_id:owner,comparison_id:comparisonId});
  if(!head.ok)return head;
  if(head.status.status!=='COMPLETE')return refuse(REPLAY_CODES.CLOSED,REPLAY_CODES.NOT_COMPLETE);
  const stored=await readComparisonResults(db,{owner_id:owner,comparison_id:comparisonId});
  if(!stored.ok)return stored;
  if(!stored.outcome)return refuse(REPLAY_CODES.CLOSED,REPLAY_CODES.NOT_COMPLETE);
  const prior=stored.outcome.outcome_hash,{comparison,participants}=head;
  const record=async(kind,code,replayHash)=>{
    const written=await writeReplayEvent(db,{owner_id:owner,comparison_id:comparisonId,kind,prior_outcome_hash:prior,replay_outcome_hash:replayHash,first_differing_code:code});
    if(!written.ok)return written;
    return {ok:true,code:null,detail:null,comparison_id:comparisonId,kind,first_differing_code:code,replay_event_id:written.replay_event_id,at_ms:written.at_ms,
      prior_outcome_hash:prior,replay_outcome_hash:replayHash};
  };
  const runs=new Map((await inReadOnly(db,()=>runsOf(db,owner,comparisonId))).map(row=>[row.participant_id,row]));
  const views=new Map(stored.evaluations.map(view=>[view.participant_id,view]));
  const rebuilt=[];let first=null,benchmark=null;
  for(const item of participants){
    const run=runs.get(item.participant_id);
    if(!run||run.status!=='SUCCEEDED')return record('REPRODUCTION_DISABLED',null,null);
    let evaluated,rows;
    try{evaluated=await deps.readEvaluation(owner,run.run_id);rows=await deps.readRows(owner,run.run_id,evaluated.binding);}
    catch(error){if(!replayDisables(error))throw error;return record('REPRODUCTION_DISABLED',null,null);}
    const body=evaluationRecordBody({comparison_id:comparisonId,spec_hash:comparison.spec_hash,spec:comparison.spec,participant_id:item.participant_id,evaluation_run_id:run.run_id,
      fixed_contract:evaluated.contract,binding:evaluated.binding,fixed_result:evaluated.result,rows},deps.validators);
    const line=benchmarkRecordBody({comparison_id:comparisonId,spec_hash:comparison.spec_hash,spec:comparison.spec,fixed_contract:evaluated.contract,rows},deps.validators);
    const view=views.get(item.participant_id);
    if(!body.ok)first??=differing(body);
    else if(!view||view.body_hash!==body.body_hash||view.evaluation_run_id!==run.run_id)first??='EVALUATION_MISMATCH';
    if(!line.ok)first??=differing(line);
    else if(benchmark!==null&&benchmark!==line.body_hash)first??='BENCHMARK_INPUT_DIFFERS';
    benchmark??=line.ok?line.body_hash:null;
    rebuilt.push({participant_id:item.participant_id,body,view});
  }
  if(first===null&&(!stored.benchmark||stored.benchmark.body_hash!==benchmark))first='BENCHMARK_MISMATCH';
  let outcomeHash=null;
  if(rebuilt.every(item=>item.body.ok&&item.view)){
    const entries=[];
    for(const item of rebuilt){
      let inputs;
      try{inputs=await deps.participantInputs(owner,comparisonId,item.participant_id);}
      catch(error){if(!replayDisables(error))throw error;return record('REPRODUCTION_DISABLED',null,null);}
      entries.push({participant_id:item.participant_id,status_input:inputs,evaluation:{body:item.body.body,created_at_ms:item.view.created_at_ms}});
    }
    const decided=outcomeRecord({spec:comparison.spec,spec_hash:comparison.spec_hash,context_key:comparison.context_key,participants:entries});
    if(!decided.ok)first??=differing(decided);
    else{outcomeHash=decided.outcome_hash;if(outcomeHash!==prior)first??='OUTCOME_MISMATCH';}
  }
  if(first===null)return record('REPLAY_MATCH',null,prior);
  // A mismatch names a replay hash that differs from the stored one: the rebuilt outcome hash when it differs, otherwise the hash of the canonical replay digest.
  const digest=hash(canonical({version:REPLAY_VERSION,first_differing_code:first,outcome_hash:outcomeHash,benchmark_hash:benchmark,
    evaluations:rebuilt.map(item=>({participant_id:item.participant_id,body_hash:item.body.ok?item.body.body_hash:null}))}));
  return record('REPLAY_MISMATCH',first,outcomeHash!==null&&outcomeHash!==prior?outcomeHash:digest);
}

/**
 * The owner API dependencies (server.js builds them only when QR3_COMPARISON_ENABLED is exactly '1'): engineHash (C7), datasetDigest (C6) and replay (RR-12,
 * single-flight per process: a second request while one runs is refused QR3_ADMISSION_CLOSED with detail REPLAY_BUSY).
 */
export function createQr3ApiDeps({pineService,fixedEvalService=null,engineHash=fixedEvalEngineHash}={}){
  const service=fixedEvalService??new QuantFixedEvalService({pineService});
  const deps=createFinalizerDeps({fixedEvalService:service});
  let busy=false;
  return Object.freeze({
    engineHash:()=>engineHash(),
    /** The admission's shared dataset digest over the closed range, read in the caller's READ ONLY transaction; null when the stored bars do not verify. */
    async datasetDigest({db,first_close_ms:first,last_close_ms:last,bar_count:count,data_profile:profile,content_digest:digest}){
      if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||!Number.isSafeInteger(count)||count<1||last!==first+(count-1)*MINUTE||typeof profile!=='string')return null;
      try{
        const rows=await verifiedBars(db,{first,last,count,profile});
        if(contentDigest(rows)!==digest)return null;
        return datasetSha(rows);
      }catch(error){if(classifyAdmission(error)==='FAIL')return null;throw error;}
    },
    async replay({owner_id:owner,comparison_id:comparisonId}){
      if(busy)return refuse(REPLAY_CODES.CLOSED,REPLAY_CODES.BUSY);
      busy=true;
      try{return await replayComparison(service.db,{owner_id:owner,comparison_id:comparisonId},deps);}
      finally{busy=false;}
    }
  });
}
