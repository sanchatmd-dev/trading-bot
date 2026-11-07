import {CODES,isObject} from '../comparison/common.js';
import {evaluationRecordBody,benchmarkRecordBody,outcomeRecord} from '../comparison/evaluation-record.js';
import {readComparison,readComparisonResults,writeEvaluation,writeBenchmark,writeOutcome,failComparison,STORE_CODES} from './comparison-store.js';

/**
 * QR-3 slice S3b (docs/QR3_S3A_EVALUATION_RECORD_PACKET_2026-10-24.md, section 13; docs/QR_3_FAIR_COMPARISON_CONTRACT.md 8.1, RC-C38, RC-C45): the database
 * half of the evaluation orchestration. finalizeComparison reads one comparison and the terminal fixed-evaluation runs of its participants, builds the record
 * bodies with the S3a pure module, stores the evaluations, the benchmark and the outcome (COMPLETE) through the S2c-2 writers, and records a FAILED status
 * when a participant run cannot finish. Only the QR-3 wiring module imports it (L8-W, owner GO OG-1, Root ruling SB187); there is no route, flag or export
 * from src/comparison/index.js for it. It is listed in the runtime engine manifest, so every byte here, comments included, is part of the engine identities.
 *
 * Every access to the fixed-evaluation lifecycle comes in through the injected dependencies, so this text names none of the guarded evaluation modules
 * (the importer guard of the evaluation closure test); the required validators of the evaluation contract are one of those dependencies.
 *   deps = {
 *     validators: {validateFixedEvalContract, validateFixedEvalResult},          required functions, else QR3_INTEGRITY_FAILED / VALIDATOR_MISSING
 *     readEvaluation(owner_id, run_id) -> {contract, binding, result},            the validated, read-only read of one terminal run
 *     readRows(owner_id, run_id, binding) -> rows,                                dataset rows, only through the verified binding of that run
 *     participantInputs(owner_id, comparison_id, participant_id) -> status_input  participantStatus inputs the pure module does not derive (Q3)
 *   }
 * A dependency that throws is refused QR3_INTEGRITY_FAILED (READ_EVALUATION, READ_ROWS or PARTICIPANT_INPUTS); nothing is stored and the comparison keeps its
 * status, so the caller may call again.
 *
 * Steps (all reads READ ONLY, all writes through the store writers, each in its own SERIALIZABLE transaction):
 *  1. Read the comparison. A terminal status answers ALREADY_TERMINAL and nothing else runs; SPEC_FROZEN answers WAITING (no run has been admitted).
 *  2. Find the single fixed run of each participant (owner, QR3 purpose, lineage object id = comparison id, lineage parent run id = participant id) in a READ
 *     ONLY transaction. A participant without a run, or with a QUEUED or RUNNING one, is WAITING. A FAILED, TIMED_OUT, NO_VALID_CANDIDATE or CANCELLED run
 *     fails the comparison (see RUN_FAILURE_REASONS; Root ruling RR-2, adopted in SB180 item 3, with the contract deviation recorded as a limitation).
 *  3. For every participant rebuild the evaluation body. A stored body is compared by hash with the rebuilt one: a difference refuses
 *     QR3_INTEGRITY_FAILED / EVALUATION_MISMATCH and nothing is overwritten (the rows are insert-only). Missing bodies are written one by one, so a stop
 *     after any single write is recovered by the next call, which writes only what is missing and reads back the same hashes.
 *  4. The benchmark is built from every participant's own contract and rows; all builds must give one hash (BENCHMARK_INPUT_DIFFERS otherwise), then it is
 *     stored once under the same rule.
 *  5. The outcome is built from the stored evaluation times (outcomeRecord) and written with the COMPLETE event in one transaction (writeOutcome).
 * A writer that lost to a concurrent cancel, failed status or COMPLETE answers the store code QR3_NOT_CANCELLABLE (RC-C38); the finalizer then re-reads the
 * status and answers CANCELLED or ALREADY_TERMINAL without a retry. A second record for the same key (ALREADY_RECORDED) is the work of a concurrent
 * finalizer: it is not an error, and the read-back of step 3 and 4 still has to show the same hashes. This module reads no clock and no random source; every time
 * comes from the database through the writers (RC-C39). It writes no exposure event (RC-C32) and holds no scheduler lock; the heavy work stays in the
 * fixed-evaluation job.
 *
 * Returns {ok:true, code:null, detail:null, state, status, ...} with state WAITING (pending lists the participants still to finish), COMPLETE (outcome,
 * outcome_hash), FAILED (reason_code), CANCELLED (this call lost to a cancel) or ALREADY_TERMINAL; or {ok:false, code, detail} (NOT_FOUND for an absent, foreign or
 * malformed id; a pure-module refusal passes through unchanged).
 */
export const FINALIZER_STATES=Object.freeze(['WAITING','COMPLETE','FAILED','CANCELLED','ALREADY_TERMINAL']);
/** Fixed-run status to the reason code of the FAILED comparison (RR-2, adopted in SB180 item 3). Any other status is waiting (QUEUED, RUNNING) or ready (SUCCEEDED). */
export const RUN_FAILURE_REASONS=Object.freeze({FAILED:'PARTICIPANT_RUN_FAILED',TIMED_OUT:'PARTICIPANT_RUN_FAILED',NO_VALID_CANDIDATE:'PARTICIPANT_RUN_FAILED',CANCELLED:'PARTICIPANT_RUN_CANCELLED'});

const TERMINAL=Object.freeze(['COMPLETE','FAILED','CANCELLED']);
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const refuse=(code,detail=null)=>({ok:false,code,detail});
const integrity=detail=>refuse(CODES.QR3_INTEGRITY_FAILED,detail);
const done=(state,fields={})=>({ok:true,code:null,detail:null,state,...fields});
const alreadyRecorded=answer=>answer.code===CODES.INVALID_FIELDS&&answer.detail==='ALREADY_RECORDED';

/** The runs of a comparison, read in a READ ONLY transaction (it fails closed if the server does not report read-only). */
async function readRuns(db,owner,comparisonId){
  return db.transaction(async()=>{
    await db.query('SET TRANSACTION READ ONLY');
    const mode=(await db.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode;
    if(mode!=='on')throw Error('Run lookup needs a READ ONLY transaction');
    return (await db.query(`SELECT run_id,status,contract#>>'{lineage,parent_run_id}' AS participant_id FROM public.quant_jobs
      WHERE owner_id=$1 AND contract->>'mode'='FIXED_INPUT_EVAL' AND contract->>'purpose'='QR3_COMPARISON' AND contract#>>'{lineage,object_id}'=$2 ORDER BY run_id`,
    [owner,comparisonId])).rows;
  },{isolation:'REPEATABLE READ'});
}

/** After a writer lost: the status now decides the answer. A non-terminal status is not explained by the loss, so the writer refusal is returned as is. */
async function lost(db,owner,comparisonId,refusal){
  const now=await readComparison(db,{owner_id:owner,comparison_id:comparisonId});
  if(!now.ok)return now;
  const status=now.status.status;
  if(status==='CANCELLED')return done('CANCELLED',{status});
  if(TERMINAL.includes(status))return done('ALREADY_TERMINAL',{status});
  return refusal;
}

async function call(read,detail){
  try{return {value:await read()};}catch{return {refusal:integrity(detail)};}
}

export async function finalizeComparison(db,input,deps){
  if(!db||typeof db.transaction!=='function'||typeof db.query!=='function'||db.isTransaction===true)throw Error('finalizeComparison requires its own transaction handling');
  const validators=isObject(deps)?deps.validators:null;
  if(!isObject(validators)||typeof validators.validateFixedEvalContract!=='function'||typeof validators.validateFixedEvalResult!=='function')return integrity('VALIDATOR_MISSING');
  if(['readEvaluation','readRows','participantInputs'].some(name=>typeof deps[name]!=='function'))return integrity('DEPENDENCY_MISSING');
  if(!isObject(input)||typeof input.owner_id!=='string'||input.owner_id.length===0||typeof input.comparison_id!=='string'||!ID.test(input.comparison_id))return refuse(STORE_CODES.NOT_FOUND);
  const owner=input.owner_id,comparisonId=input.comparison_id;

  // 1. the comparison
  const head=await readComparison(db,{owner_id:owner,comparison_id:comparisonId});
  if(!head.ok)return head;
  const {comparison,participants}=head,status=head.status.status;
  if(TERMINAL.includes(status))return done('ALREADY_TERMINAL',{status});
  if(status==='SPEC_FROZEN')return done('WAITING',{status,pending:participants.map(item=>item.participant_id)});

  // 2. the fixed run of every participant
  const found=await readRuns(db,owner,comparisonId);
  const known=new Set(participants.map(item=>item.participant_id)),runs=new Map();
  for(const row of found){
    if(!known.has(row.participant_id))return integrity('RUN_UNKNOWN_PARTICIPANT');
    if(runs.has(row.participant_id))return integrity('RUN_AMBIGUOUS');
    runs.set(row.participant_id,row);
  }
  for(const item of participants){
    const reason=RUN_FAILURE_REASONS[runs.get(item.participant_id)?.status];
    if(reason===undefined)continue;
    const failed=await failComparison(db,{owner_id:owner,comparison_id:comparisonId,reason_code:reason});
    if(failed.ok)return done('FAILED',{status:'FAILED',reason_code:reason,participant_id:item.participant_id,run_id:runs.get(item.participant_id).run_id});
    return failed.code===STORE_CODES.NOT_CANCELLABLE?lost(db,owner,comparisonId,failed):failed;
  }
  const pending=participants.filter(item=>runs.get(item.participant_id)?.status!=='SUCCEEDED').map(item=>item.participant_id);
  if(pending.length>0)return done('WAITING',{status,pending});

  // 3. the evaluation bodies
  const built=[];
  for(const item of participants){
    const runId=runs.get(item.participant_id).run_id;
    const evaluated=await call(()=>deps.readEvaluation(owner,runId),'READ_EVALUATION');
    if(evaluated.refusal)return evaluated.refusal;
    const record=evaluated.value;
    if(!isObject(record)||!isObject(record.contract)||!isObject(record.binding)||!isObject(record.result))return integrity('READ_EVALUATION');
    const rows=await call(()=>deps.readRows(owner,runId,record.binding),'READ_ROWS');
    if(rows.refusal)return rows.refusal;
    const body=evaluationRecordBody({comparison_id:comparisonId,spec_hash:comparison.spec_hash,spec:comparison.spec,participant_id:item.participant_id,evaluation_run_id:runId,
      fixed_contract:record.contract,binding:record.binding,fixed_result:record.result,rows:rows.value},validators);
    if(!body.ok)return refuse(body.code,body.detail);
    const benchmark=benchmarkRecordBody({comparison_id:comparisonId,spec_hash:comparison.spec_hash,spec:comparison.spec,fixed_contract:record.contract,rows:rows.value},validators);
    if(!benchmark.ok)return refuse(benchmark.code,benchmark.detail);
    built.push({participant_id:item.participant_id,run_id:runId,body,benchmark});
  }
  if(built.some(item=>item.benchmark.body_hash!==built[0].benchmark.body_hash))return integrity('BENCHMARK_INPUT_DIFFERS');
  const benchmark=built[0].benchmark;

  // what is stored already must be exactly what is rebuilt
  const checkStored=async()=>{
    const stored=await readComparisonResults(db,{owner_id:owner,comparison_id:comparisonId});
    if(!stored.ok)return stored;
    const byParticipant=new Map(stored.evaluations.map(view=>[view.participant_id,view]));
    for(const item of built){
      const view=byParticipant.get(item.participant_id);
      if(view&&(view.body_hash!==item.body.body_hash||view.evaluation_run_id!==item.run_id))return integrity('EVALUATION_MISMATCH');
    }
    if(stored.benchmark&&stored.benchmark.body_hash!==benchmark.body_hash)return integrity('BENCHMARK_MISMATCH');
    return stored;
  };
  const before=await checkStored();
  if(!before.ok)return before;
  if(before.outcome)return done('ALREADY_TERMINAL',{status:'COMPLETE'});

  // writes: only what is missing, one record per transaction
  const have=new Set(before.evaluations.map(view=>view.participant_id));
  for(const item of built){
    if(have.has(item.participant_id))continue;
    const written=await writeEvaluation(db,{owner_id:owner,comparison_id:comparisonId,participant_id:item.participant_id,spec_hash:comparison.spec_hash,
      evaluation_run_id:item.run_id,body:item.body.body});
    if(written.ok||alreadyRecorded(written))continue;
    return written.code===STORE_CODES.NOT_CANCELLABLE?lost(db,owner,comparisonId,written):written;
  }
  if(!before.benchmark){
    const written=await writeBenchmark(db,{owner_id:owner,comparison_id:comparisonId,spec_hash:comparison.spec_hash,body:benchmark.body});
    if(!written.ok&&!alreadyRecorded(written))return written.code===STORE_CODES.NOT_CANCELLABLE?lost(db,owner,comparisonId,written):written;
  }

  // 5. the outcome, from the stored evaluation times
  const after=await checkStored();
  if(!after.ok)return after;
  if(after.outcome)return done('ALREADY_TERMINAL',{status:'COMPLETE'});
  const views=new Map(after.evaluations.map(view=>[view.participant_id,view]));
  const entries=[];
  for(const item of built){
    const view=views.get(item.participant_id);
    if(!view||!after.benchmark)return integrity('EVALUATION_MISSING');
    const supplied=await call(()=>deps.participantInputs(owner,comparisonId,item.participant_id),'PARTICIPANT_INPUTS');
    if(supplied.refusal)return supplied.refusal;
    entries.push({participant_id:item.participant_id,status_input:supplied.value,evaluation:{body:view.body,created_at_ms:view.created_at_ms}});
  }
  const decided=outcomeRecord({spec:comparison.spec,spec_hash:comparison.spec_hash,context_key:comparison.context_key,participants:entries});
  if(!decided.ok)return refuse(decided.code,decided.detail);
  const wrote=await writeOutcome(db,{owner_id:owner,comparison_id:comparisonId,outcome:decided});
  if(wrote.ok)return done('COMPLETE',{status:'COMPLETE',outcome:wrote.outcome,outcome_hash:wrote.outcome_hash,complete_seq:wrote.complete_seq});
  return wrote.code===STORE_CODES.NOT_CANCELLABLE||alreadyRecorded(wrote)?lost(db,owner,comparisonId,wrote):wrote;
}
