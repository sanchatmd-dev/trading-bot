import {CODES,canonical,hash,isObject,text,refuse} from '../selection/codes.js';
import {readSelection,writeOutcome} from '../postgres/selection-store.js';
import {selectionEvaluationOf,refusedEvaluation,ENDING_REFUSAL_CODES} from './evaluation-adapter.js';

/**
 * QR-4 slice Q4-A (docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md 5.4, 7.1, 10, 13.1; Root ruling SB203): the database half of the outcome path. finalizeSelection reads one
 * selection and the terminal fixed-evaluation runs of its participants, builds one evaluation per participant with the pure adapter, and calls the existing writeOutcome
 * of the selection store with that list. Nothing in src imports this module yet: there is no route, flag or worker step for it, and it is not exported from
 * src/selection/index.js (the wiring slice does that later, under its own owner GO).
 *
 * Every access to the fixed-evaluation lifecycle comes in through the injected dependencies, so this text names none of the guarded evaluation modules (the importer
 * guard of the evaluation closure test):
 *   deps = {
 *     validators: {validateFixedEvalContract, validateFixedEvalResult},     required functions, else INTEGRITY_CHECK_FAILED / VALIDATOR_MISSING
 *     readEvaluation(owner_id, run_id) -> {contract, binding, result, status},   the verified, read-only read of one terminal run that SUCCEEDED
 *     readRows(owner_id, run_id, binding) -> rows                                dataset rows, only through the verified binding of that run
 *   }
 * readEvaluation must throw unless the stored records of the run match their checkpoints; the adapter takes that read as the proof behind
 * integrity.report_matches_checkpoints, and the finalizer itself proves the contract hash against the stored job row. A run that did not succeed is never read
 * through the dependencies: its stored contract (the job row) and its status are enough for the evaluation that ends the selection QR4_EVALUATION_FAILED.
 * A dependency that throws is refused with a transient detail (TRANSIENT_READ_EVALUATION or TRANSIENT_READ_ROWS, retryable true) and nothing is written, so the
 * caller may call again.
 *
 * Steps (all reads in one READ ONLY snapshot, the write through the store writer in its own SERIALIZABLE transaction):
 *  1. One READ ONLY, REPEATABLE READ transaction reads the selection (readSelection) and the fixed runs of the owner for the selection (quant_jobs: mode
 *     FIXED_INPUT_EVAL, purpose QR4_SELECTION, lineage object id = the selection id). A terminal selection answers ALREADY_TERMINAL; a REGISTERED one answers
 *     WAITING (nothing has started).
 *  2. The runs are checked against the evaluation start rows (quant_selection_evaluation_starts): every run needs its start and every start its run, one run per
 *     participant, the parent run and the engine hash of the start equal those of the run, and the stored contract hash is the hash of the stored contract. Two rows
 *     for one participant or any mismatch refuses INTEGRITY_CHECK_FAILED and nothing is written. A participant without a start, or a run that is QUEUED or RUNNING,
 *     answers WAITING: the finalizer waits until every run is terminal and never ends a selection early (RR-Q4-7).
 *  3. When every run is terminal the evaluations are built with the adapter. A refusal of the adapter that is deterministic on the frozen terminal record
 *     (INTEGRITY_CHECK_FAILED, QR4_METRIC_MISSING including a figure that is not a decimal string, or QR4_WINDOW_DATA_GAP: the bars of W were verified complete at the freeze,
 *     so a gap after it is not transient) is confirmed by a second read and adapt of that run through the same dependencies; the same
 *     refusal twice becomes an evaluation that rankSelection ends with the matching section-10 code (refusedEvaluation keeps the adapter code and detail, and the answer
 *     lists them as adapter_refusals), so the selection cannot stay SELECTION_EVALUATING for ever. A different second answer is UNSTABLE_READ, retryable, and nothing is
 *     written. Trade-off: a dependency that returns the same wrong rows or record twice can end a selection, which is why the dependencies must be verified reads.
 *     A run that did not succeed keeps its real status in that evaluation, so the ending is QR4_EVALUATION_FAILED. An unreadable close in W is also QR4_WINDOW_DATA_GAP (the adapter never emits QR4_WINDOW_DATA_UNAVAILABLE). Limitation: the durable ALL_EVALUATIONS_DONE event of a GAP ending stores the detail BAR_COUNT_DIFFERS from the marker evaluation; the real cause is only in adapter_refusals and the answer. A malformed call passes through unchanged with permanent true and nothing is written; ending those is left to the store slice. writeOutcome then ranks and stores the outcome (RR-Q4-6): it rechecks the window lock-first, and it ends the selection INCOMPLETE itself when the
 *     ranking is incomplete or the recheck fails. A writer that lost to a concurrent finalizer or cancel answers a transition refusal; the finalizer then reads the
 *     status again and answers ALREADY_TERMINAL without a retry.
 * This module reads no clock and no random source: every time comes from the database through the store writers. It writes no exposure event, takes no scheduler
 * lock and starts no run; the heavy work stays in the fixed-evaluation job.
 *
 * Returns {ok:true, code:null, detail:null, state, status, ...} with state WAITING (pending lists the export ids still to finish), COMPLETED (outcome, outcome_hash),
 * INCOMPLETE (code, detail, event: the selection ended SELECTION_INCOMPLETE) or ALREADY_TERMINAL; or {ok:false, code, detail} (NOT_FOUND for an absent, foreign or
 * malformed id; a refusal of the adapter or of the store passes through unchanged).
 */
export const FINALIZER_STATES=Object.freeze(['WAITING','COMPLETED','INCOMPLETE','ALREADY_TERMINAL']);

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL=Object.freeze(['SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED']);
const RUN_STATUSES=Object.freeze(['QUEUED','RUNNING','SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
const OPEN_RUN_STATUSES=Object.freeze(['QUEUED','RUNNING']);
const integrity=(detail,extra={})=>refuse(CODES.INTEGRITY_CHECK_FAILED,detail,extra);
const done=(state,fields={})=>({ok:true,code:null,detail:null,state,...fields});
const hasFunctions=(value,names)=>isObject(value)&&names.every(name=>typeof value[name]==='function');

/** The selection and its fixed runs, read in one READ ONLY snapshot (it fails closed if the server does not report read-only). */
async function readState(db,owner,selectionId){
  return db.transaction(async()=>{
    await db.query('SET TRANSACTION READ ONLY');
    const mode=(await db.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode;
    if(mode!=='on')throw Error('Selection finalizer reads need a READ ONLY transaction');
    const head=await readSelection(db,{owner_id:owner,selection_id:selectionId});
    if(!head.ok)return head;
    const jobs=(await db.query(`SELECT run_id,status,contract_hash,contract FROM public.quant_jobs WHERE owner_id=$1 AND contract->>'mode'='FIXED_INPUT_EVAL'
      AND contract->>'purpose'='QR4_SELECTION' AND contract#>>'{lineage,object_id}'=$2 ORDER BY run_id`,[owner,selectionId])).rows;
    return {ok:true,selection:head.selection,jobs};
  },{isolation:'REPEATABLE READ'});
}

async function call(read,detail){
  try{return {value:await read()};}catch{return {refusal:integrity('TRANSIENT_'+detail,{retryable:true})};}
}

/** The runs against the start rows of the selection; returns a refusal or the run of each start. */
function pairRuns(selection,jobs){
  const starts=selection.starts,byRun=new Map(),parents=new Set();
  for(const job of jobs){
    if(!isObject(job)||!text(job.run_id)||!RUN_STATUSES.includes(job.status))return integrity('RUN_STATUS');
    const parent=job.contract?.lineage?.parent_run_id;
    if(!text(parent)||parents.has(parent))return integrity('RUN_AMBIGUOUS');
    parents.add(parent);
    byRun.set(job.run_id,job);
  }
  for(const job of jobs)if(!starts.some(start=>start.evaluation_run_id===job.run_id))return integrity('RUN_WITHOUT_START');
  const participants=selection.registration.participants,paired=[];
  for(const start of starts){
    const job=byRun.get(start.evaluation_run_id);
    if(!job)return integrity('START_WITHOUT_RUN');
    const participant=participants.find(item=>item.export_id===start.export_id);
    if(!participant||participant.run_id!==start.parent_run_id||job.contract.lineage.parent_run_id!==start.parent_run_id||job.contract.engine_hash!==start.engine_hash)return integrity('RUN_START_MISMATCH');
    if(hash(canonical(job.contract))!==job.contract_hash)return integrity('CONTRACT_HASH');
    paired.push({start,job});
  }
  return {ok:true,paired};
}

/**
 * One participant run into its adapter answer. A run that did not succeed needs no read; a succeeded one is read through the injected dependencies. Returns
 * {adapted} (the adapter answer, which may be a refusal) or {refusal} (a transient or integrity refusal of the finalizer itself).
 */
async function adaptRun(owner,selection,job,deps){
  const base={registration:selection.registration,evaluation_run_id:job.run_id,fixed_contract:job.contract,binding:null,fixed_result:null,rows:null,run_status:job.status};
  let input=base;
  if(job.status==='SUCCEEDED'){
    const read=await call(()=>deps.readEvaluation(owner,job.run_id),'READ_EVALUATION');
    if(read.refusal)return {refusal:read.refusal};
    const record=read.value;
    if(!isObject(record)||!isObject(record.contract)||!isObject(record.binding)||!isObject(record.result)||record.status!=='SUCCEEDED')return {refusal:integrity('READ_EVALUATION')};
    if(canonical(record.contract)!==canonical(job.contract))return {refusal:integrity('CONTRACT_DIFFERS')};
    const rows=await call(()=>deps.readRows(owner,job.run_id,record.binding),'READ_ROWS');
    if(rows.refusal)return {refusal:rows.refusal};
    input={...base,fixed_contract:record.contract,binding:record.binding,fixed_result:record.result,rows:rows.value};
  }
  return {adapted:selectionEvaluationOf(input,deps.validators)};
}

/**
 * Reads the selection and, when every participant run is terminal, builds the evaluation of each participant (step 1 to 3 of the module text, without the write).
 * Returns {ok:true, ready:true, selection, evaluations} (in the order of the participants), {ok:true, ready:false, answer} where answer is the done() value of a
 * selection that is terminal or still waiting, or a refusal. allowTerminal reads the evaluations of a selection that has already ended (the outcome replay).
 */
async function collect(db,input,deps,{allowTerminal=false}={}){
  if(!db||typeof db.transaction!=='function'||typeof db.query!=='function'||db.isTransaction===true)throw Error('finalizeSelection requires its own transaction handling');
  if(!isObject(deps)||!hasFunctions(deps.validators,['validateFixedEvalContract','validateFixedEvalResult']))return integrity('VALIDATOR_MISSING');
  if(['readEvaluation','readRows'].some(name=>typeof deps[name]!=='function'))return integrity('DEPENDENCY_MISSING');
  if(!isObject(input)||typeof input.owner_id!=='string'||input.owner_id.length===0||typeof input.selection_id!=='string'||!UUID.test(input.selection_id))return refuse(CODES.NOT_FOUND);
  const owner=input.owner_id,selectionId=input.selection_id;

  const state=await readState(db,owner,selectionId);
  if(!state.ok)return state;
  const {selection,jobs}=state;
  if(!allowTerminal){
    if(TERMINAL.includes(selection.status))return {ok:true,ready:false,answer:done('ALREADY_TERMINAL',{status:selection.status,outcome_hash:selection.outcome_row?.outcome_hash??null})};
    if(selection.status==='SELECTION_REGISTERED')return {ok:true,ready:false,answer:done('WAITING',{status:selection.status,pending:selection.registration.participants.map(item=>item.export_id)})};
  }
  const paired=pairRuns(selection,jobs);
  if(!paired.ok)return paired;
  const started=new Set(selection.starts.map(start=>start.export_id));
  const unstarted=selection.registration.participants.filter(item=>!started.has(item.export_id)).map(item=>item.export_id);
  const open=paired.paired.filter(item=>OPEN_RUN_STATUSES.includes(item.job.status)).map(item=>item.start.export_id);
  if(unstarted.length>0||open.length>0)return {ok:true,ready:false,answer:done('WAITING',{status:selection.status,pending:[...unstarted,...open].sort()})};

  const evaluations=[],refusals=[];
  for(const {start,job} of paired.paired){
    const first=await adaptRun(owner,selection,job,deps);
    if(first.refusal)return first.refusal;
    let adapted=first.adapted;
    if(!adapted.ok){
      // A deterministic refusal of a frozen terminal record ends the selection (contract 7.1 item 1, section 10); a refusal that a faulty read could cause must not.
      // The run is therefore read and adapted once more, and only the same refusal twice ends the selection. A refusal that is not an ending code (a malformed
      // call) cannot end it here: it is returned as a permanent refusal and the ending is a store matter (Q4-W). The adapter never emits QR4_WINDOW_DATA_UNAVAILABLE.
      if(!ENDING_REFUSAL_CODES.includes(adapted.code))return {...adapted,permanent:true};
      const second=await adaptRun(owner,selection,job,deps);
      if(second.refusal)return second.refusal;
      if(second.adapted.ok||second.adapted.code!==adapted.code||second.adapted.detail!==adapted.detail)return integrity('UNSTABLE_READ',{retryable:true});
      const ended=refusedEvaluation({selection_id:selection.selection_id,run_id:job.run_id,parent_run_id:start.parent_run_id,engine_hash:start.engine_hash,dataset_hash:start.dataset_hash,refusal:adapted,status:job.status,expected_bars:selection.registration.window.evaluation_bars});
      if(ended===null)return {...adapted,permanent:true};
      adapted={ok:true,evaluation:ended};
      refusals.push({export_id:start.export_id,evaluation_run_id:job.run_id,code:adapted.evaluation.adapter_refusal.code,detail:adapted.evaluation.adapter_refusal.detail});
    }
    if(adapted.evaluation.parent_run_id!==start.parent_run_id)return integrity('RUN_START_MISMATCH');
    evaluations.push(adapted.evaluation);
  }
  return {ok:true,ready:true,selection,evaluations,refusals};
}

/**
 * The evaluations of a selection whose runs are all terminal, built exactly as finalizeSelection builds them, for a caller that needs the same list again (the outcome
 * replay of the wiring slice). Terminal selections are allowed. Returns {ok:true, state:'READY', selection, evaluations} or the WAITING answer of the finalizer, or a refusal.
 */
export async function readSelectionEvaluations(db,input,deps){
  const found=await collect(db,input,deps,{allowTerminal:true});
  if(!found.ok)return found;
  if(!found.ready)return found.answer;
  return done('READY',{selection:found.selection,evaluations:found.evaluations,adapter_refusals:found.refusals});
}

/** After a writer lost: the status now decides the answer. A non-terminal status is not explained by the loss, so the writer refusal is returned as is. */
async function lost(db,owner,selectionId,refusal){
  const now=await readSelection(db,{owner_id:owner,selection_id:selectionId});
  if(!now.ok)return now;
  if(TERMINAL.includes(now.selection.status))return done('ALREADY_TERMINAL',{status:now.selection.status,outcome_hash:now.selection.outcome_row?.outcome_hash??null});
  return refusal;
}

export async function finalizeSelection(db,input,deps){
  const found=await collect(db,input,deps);
  if(!found.ok)return found;
  if(!found.ready)return found.answer;
  const owner=input.owner_id,selectionId=input.selection_id;
  const wrote=await writeOutcome(db,{owner_id:owner,selection_id:selectionId,evaluations:found.evaluations});
  if(wrote.ok===true)return done('COMPLETED',{status:wrote.status,outcome:wrote.outcome,outcome_hash:wrote.outcome_hash});
  if(wrote.ended===true)return done('INCOMPLETE',{status:wrote.status,code:wrote.code,event:wrote.event??null,detail:wrote.detail??null,adapter_refusals:found.refusals});
  if(wrote.code===CODES.QR4_TRANSITION_INVALID)return lost(db,owner,selectionId,wrote);
  return wrote;
}
