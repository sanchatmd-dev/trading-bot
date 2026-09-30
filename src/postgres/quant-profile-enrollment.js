import {canonical,hash,fail} from '../pine-bridge/source.js';
import {validateProfileResultV2,buildProfileEnrollmentReceipt,validateProfileEnrollmentReceipt} from '../quant-research/profile-contract-v2.js';
import {validateCapacityPolicy} from '../quant-research/capacity-contract.js';
import {strictJsonV2} from '../quant-research/foundation-contract-v2.js';
import {validateIoBudgetLedgerState} from '../quant-research/io-budget-ledger.js';

const attempts=new WeakMap(),completions=new WeakMap();
const refused=()=>fail('PROFILE_ENROLLMENT_DENIED');
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const detach=value=>JSON.parse(canonical(value));
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Private runtime candidate. Neither persisted JSON nor a caller-created object can replace this capability. */
export async function prepareEnrollmentAttempt({job,frame,leaseToken,operationId,policy,signal,emergency,enrollment}){
 if(!enrollment?.enabled||!enrollment.tickets?.prepare||typeof enrollment.authorizeLocked!=='function'||
    typeof enrollment.assertSchemaLocked!=='function'||job?.contract?.completion_mode!=='pf2-enrollment-v1'||
    job.status!=='RUNNING'||job.lease_token!==leaseToken||job.job_id!==frame?.jobId||frame.operationId!==operationId)
  throw refused();
 strictJsonV2(frame);strictJsonV2(job.contract);
 const snapshot=validateCapacityPolicy(policy),contract=freeze(detach(job.contract)),result=freeze(detach(frame.result));
 if(hash(canonical(contract))!==job.contract_hash||hash(canonical(result))!==frame.resultHash||
    hash(canonical(snapshot))!==contract.capacity.policy_hash)throw refused();
 validateProfileResultV2(contract,result,{policy:snapshot});
 const ticket=await enrollment.tickets.prepare({job,leaseToken,operationId,payloadHash:frame.payloadHash,policy:snapshot});
 const attempt=Object.freeze({jobId:job.job_id,leaseToken,operationId,contractHash:job.contract_hash,
  payloadHash:frame.payloadHash,resultHash:frame.resultHash,policyHash:contract.capacity.policy_hash,
  engineHash:contract.engine_hash,contract,result,policy:snapshot,executionTicket:ticket});
 attempts.set(attempt,{enrollment,signal,emergency,time:{wall:null,mono:null,anomaly:false}});
 if(profileCompletionVeto(attempt))throw refused();
 return attempt;
}

export function profileCompletionVeto(attempt){
 const state=attempts.get(attempt);
 return !state||state.signal?.aborted===true||state.emergency?.aborted===true;
}
export function profileCompletionAttempt(completion){return completions.get(completion)?.attempt??null;}
/** Identity check only: true when the completion's attempt was prepared with exactly this trusted authority object.
 * It never hands the authority out, so holding a completion grants no ticket or authorization capability.
 */
export function profileCompletionBoundTo(completion,enrollment){
 const state=attempts.get(profileCompletionAttempt(completion));
 return !!state&&!!enrollment&&state.enrollment===enrollment;
}
/** True once a settle body recorded its expected terminal proof for this completion. */
export function profileCompletionProofRecorded(completion){return !!completions.get(completion)?.expectedTerminalProof;}
export function recordProfileCompletionProof(completion,proof){
 const context=completions.get(completion);
 if(!context||context.expectedTerminalProof&&canonical(context.expectedTerminalProof)!==canonical(proof))throw refused();
 context.expectedTerminalProof=freeze(detach(proof));
}
export async function refreshProfileCompletionTicket(completion){
 const attempt=profileCompletionAttempt(completion),state=attempts.get(attempt);
 if(!state||profileCompletionVeto(attempt))throw refused();
 return state.enrollment.tickets.refresh(attempt.executionTicket);
}
function ticketAccepted(attempt,ticket,phase){
 const state=attempts.get(attempt);
 try{return !!state&&state.enrollment.tickets.assert(ticket,{phase,jobId:attempt.jobId,leaseToken:attempt.leaseToken,
  operationId:attempt.operationId,contractHash:attempt.contractHash,policyHash:attempt.policyHash,engineHash:attempt.engineHash});}
 catch{return false;}
}

/** One high-water mark per attempt for each clock, from the first BEGIN read to the last FINALIZE read. A wall read
 * below an earlier wall read, a monotonic read below an earlier one, or an unusable read sets a sticky anomaly: the
 * attempt can no longer enroll. The marks never move down, so a later reading is never lower than a charged one.
 */
function readClock(state,clock,monotonic){
 const time=state.time,wall=clock(),mono=monotonic();
 if(safe(wall)){
  if(time.wall!==null&&wall<time.wall)time.anomaly=true;
  if(time.wall===null||wall>time.wall)time.wall=wall;
 }else time.anomaly=true;
 if(Number.isFinite(mono)){
  if(time.mono!==null&&mono<time.mono)time.anomaly=true;
  if(time.mono===null||mono>time.mono)time.mono=mono;
 }else time.anomaly=true;
 return time;
}

/** Caller holds the scheduler/job locks in a new SERIALIZABLE transaction. */
export async function beginProfileCompletionLocked({db,job,attempt,clock,monotonic=()=>performance.now()}){
 const state=attempts.get(attempt);
 if(!db.isTransaction||!state||typeof clock!=='function'||typeof monotonic!=='function'||
    profileCompletionVeto(attempt)||!ticketAccepted(attempt,attempt.executionTicket,'BEGIN')||
    job?.job_id!==attempt.jobId||job.lease_token!==attempt.leaseToken||job.status!=='RUNNING'||
    job.checkpoint!==null||job.next_bar!==0||job.contract_hash!==attempt.contractHash||
    canonical(job.contract)!==canonical(attempt.contract))throw refused();
 const usedAt=now=>{
  if(!safe(now)||!safe(job.run_started_at)||now<job.run_started_at||!safe(job.runtime_used_ms))return null;
  const elapsed=now-job.run_started_at,total=job.runtime_used_ms+elapsed;
  return safe(elapsed)&&safe(total)?total:null;
 };
 // Each check compares one reading: the runtime total at that wall time and the wall time itself. Returns the
 // total, or null when the reading does not fit or any read of this attempt was anomalous.
 const fitsAt=time=>{
  const used=time.anomaly?null:usedAt(time.wall);
  return used!==null&&job.lease_until>time.wall&&job.deadline_at>time.wall&&
   used<job.contract.budget.max_runtime_ms&&!profileCompletionVeto(attempt)?used:null;
 };
 if(fitsAt(readClock(state,clock,monotonic))===null)throw refused();
 await state.enrollment.assertSchemaLocked(db);
 if(fitsAt(readClock(state,clock,monotonic))===null)throw refused();
 const authorized=await state.enrollment.authorizeLocked(job.owner_id,job.contract,{jobId:job.job_id,
  leaseToken:attempt.leaseToken,executionTicket:attempt.executionTicket,phase:'BEGIN'});
 if(authorized?.ok!==true)throw refused();
 // The persisted reading is the compared reading: no fresh clock read decides the transition.
 const time=readClock(state,clock,monotonic),runtimeUsed=fitsAt(time);
 if(runtimeUsed===null)throw refused();
 const beginAt=time.wall,beginMonotonic=time.mono;
 const changed=await db.query(`UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='PROFILE_COMPLETING',
  runtime_used_ms=$3,lease_until=NULL,run_started_at=NULL WHERE job_id=$1 AND lease_token=$2 AND status='RUNNING' RETURNING *`,
 [job.job_id,attempt.leaseToken,runtimeUsed]);
 if(changed.rowCount!==1)throw refused();
 const completion=Object.freeze({jobId:job.job_id,leaseToken:attempt.leaseToken,operationId:attempt.operationId});
 completions.set(completion,{attempt,beginAt,beginMonotonic,runtimeUsed,clock,monotonic,elapsed:0});
 return completion;
}

/** Terminal runtime on the attempt's high-water clock. Monotonic elapsed is the floor of every charge. Wall elapsed
 * also counts while the wall clock never stepped back in this attempt, so a forward wall step raises the charge
 * (conservative) and a backward step can neither lower it nor enroll. A charge never drops below an earlier one.
 */
function runtimeTotal(context){
 const time=readClock(attempts.get(context.attempt),context.clock,context.monotonic);
 const elapsed=Math.max(context.elapsed,Math.ceil(time.mono-context.beginMonotonic),
  time.anomaly?0:time.wall-context.beginAt);
 if(safe(elapsed))context.elapsed=elapsed;
 const total=context.runtimeUsed+elapsed;
 return {now:time.wall,total,valid:!time.anomaly&&safe(elapsed)&&safe(total)};
}

/** SQL-only publication; accounting and launch proof are already updated in the same transaction. */
export async function finalizeProfileEnrollmentLocked({db,job,settledLedger,launch,completion,executionTicket,
 healthObservation,currentPolicy,shouldVeto=()=>false}){
 const context=completions.get(completion),attempt=context?.attempt,state=attempts.get(attempt);
 if(!db.isTransaction||!state)throw refused();
 const veto=()=>profileCompletionVeto(attempt)||shouldVeto()===true;
 // A reading fits when no clock anomaly occurred and its own values are inside the deadline and runtime budget.
 const within=time=>time.valid&&time.now<job.deadline_at&&time.total<job.contract.budget.max_runtime_ms;
 const fits=()=>{const time=runtimeTotal(context);return within(time)&&!veto()?time:null;};
 // Every charge is persisted, a denial and a clock anomaly included (the monotonic floor still counts).
 const charge=async()=>{const time=runtimeTotal(context);if(safe(time.total))await db.query(
  'UPDATE quant_foundation_jobs SET runtime_used_ms=GREATEST(runtime_used_ms,$3) WHERE job_id=$1 AND lease_token=$2',
  [job.job_id,attempt.leaseToken,time.total]);return time;};
 const denied=async reason=>{await charge();return {kind:'DENIED',reason};};
 if(job.job_id!==attempt.jobId||job.status!=='STOPPING'||job.stop_reason!=='PROFILE_COMPLETING'||
    job.lease_token!==attempt.leaseToken||job.contract_hash!==attempt.contractHash||
    canonical(job.contract)!==canonical(attempt.contract)||job.checkpoint!==null||job.next_bar!==0||
    // The receipt takes its operation, token and payload from the launch row, so it must be the attempt's own launch.
    launch?.job_id!==attempt.jobId||launch.operation_id!==attempt.operationId||
    launch.lease_token!==attempt.leaseToken||launch.payload_hash!==attempt.payloadHash||launch.state!=='STOP_PROVEN'||
    healthObservation?.ok!==true||canonical(currentPolicy)!==canonical(attempt.policy)||
    !fits()||!ticketAccepted(attempt,executionTicket,'FINALIZE'))return denied('AUTHORITY');
 await state.enrollment.assertSchemaLocked(db);
 if(!fits())return denied('VETO');
 const authority=await state.enrollment.authorizeLocked(job.owner_id,job.contract,{jobId:job.job_id,
  leaseToken:attempt.leaseToken,executionTicket,phase:'FINALIZE'});
 if(authority?.ok!==true||!fits())return denied('AUTHORITY');
 const unresolved=(await db.query("SELECT 1 FROM quant_io_launches WHERE job_id=$1 AND state<>'STOP_PROVEN' LIMIT 1",[job.job_id])).rowCount;
 if(unresolved!==0||settledLedger.state.operations.some(operation=>operation.status!=='SETTLED')||!fits())return denied('UNRESOLVED');
 const time=await charge();
 // The charged reading itself must fit. Later readings are never lower (high-water) and are compared again below.
 if(!within(time)||veto())return denied('BUDGET');
 const proposed={...job,status:'SUCCEEDED',result:attempt.result,worker_id:null,lease_token:null,lease_until:null,
  run_started_at:null,stop_reason:null,runtime_used_ms:Math.max(job.runtime_used_ms,time.total)};
 const receipt=buildProfileEnrollmentReceipt({job:proposed,policy:attempt.policy,launch,ledger:settledLedger,completed_at:time.now});
 await db.query('SAVEPOINT profile_enrollment_publication');
 if(!fits()){await db.query('ROLLBACK TO SAVEPOINT profile_enrollment_publication');return denied('VETO');}
 const fields=Object.keys(receipt),values=fields.map(field=>field==='policy'?JSON.stringify(receipt[field]):receipt[field]);
 await db.query('INSERT INTO public.quant_profile_enrollment_receipts ('+fields.join(',')+') VALUES ('+
  fields.map((_,index)=>'$'+(index+1)).join(',')+')',values);
 const final= fits();
 if(!final){await db.query('ROLLBACK TO SAVEPOINT profile_enrollment_publication');return denied('VETO');}
 // No await between this veto/time check and dispatch of the publication statement.
 const updated=await db.query(`UPDATE quant_foundation_jobs SET status='SUCCEEDED',result=$3,stop_reason=NULL,
  worker_id=NULL,lease_token=NULL,lease_until=NULL,run_started_at=NULL,runtime_used_ms=GREATEST(runtime_used_ms,$4)
  WHERE job_id=$1 AND lease_token=$2 AND status='STOPPING' AND stop_reason='PROFILE_COMPLETING' RETURNING *`,
 [job.job_id,attempt.leaseToken,JSON.stringify(attempt.result),final.total]);
 if(updated.rowCount!==1)throw refused();
 await db.query('RELEASE SAVEPOINT profile_enrollment_publication');
 return {kind:'ENROLLED',job:updated.rows[0],receipt};
}

/** One coherent read, independent of the cleared live token. Never promotes an accounting-only result. */
export async function readProfileCompletionOutcome({db,jobId,completion,expectedTerminalProof}){
 const attempt=profileCompletionAttempt(completion);
 expectedTerminalProof??=completions.get(completion)?.expectedTerminalProof;
 if(!attempt||attempt.jobId!==jobId||!expectedTerminalProof)return {kind:'UNCERTAIN'};
 try{
  if(db.isTransaction)return {kind:'UNCERTAIN'};
  return await db.transaction(async()=>{
  // SERIALIZABLE takes its snapshot at the first query. LOCK TABLE takes none, so a transaction that commits while
  // this read waits for the scheduler is inside the snapshot and cannot abort the read with a serialization error.
  await db.query('LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE');
  await db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
  await db.query('SELECT job_id FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[jobId]);
  const evidence=(await db.query(`SELECT to_jsonb(j) job,to_jsonb(r) receipt,to_jsonb(l) ledger,to_jsonb(x) launch
   FROM public.quant_foundation_jobs j LEFT JOIN public.quant_profile_enrollment_receipts r ON r.job_id=j.job_id
   LEFT JOIN public.quant_io_ledgers l ON l.job_id=j.job_id LEFT JOIN public.quant_io_launches x
   ON x.job_id=j.job_id AND x.operation_id=$2 WHERE j.job_id=$1`,[jobId,attempt.operationId])).rows[0];
  if(!evidence)return {kind:'UNCERTAIN'};
  const {job,receipt,ledger,launch}=evidence,operation=ledger?.state?.operations?.find(op=>op.operation_id===attempt.operationId);
  const immutable=job.job_id===attempt.jobId&&job.owner_id===attempt.contract.owner_id&&
   job.contract_hash===attempt.contractHash&&hash(canonical(job.contract))===attempt.contractHash&&
   launch?.job_id===attempt.jobId&&launch.operation_id===attempt.operationId&&launch.lease_token===attempt.leaseToken&&
   launch.payload_hash===attempt.payloadHash&&launch.unit_name===
    'robot-quant-'+hash(canonical({jobId:attempt.jobId,operationId:attempt.operationId}))+'.service'&&
   ledger?.job_id===attempt.jobId&&ledger.lease_token===attempt.leaseToken&&ledger.policy_hash===attempt.policyHash&&
   ledger.state_hash===hash(canonical(ledger.state))&&ledger.revision===ledger.state.revision&&
   ledger.state.job_id===attempt.jobId&&ledger.state.policy_hash===attempt.policyHash&&
   ledger.state.lease_token===attempt.leaseToken&&operation?.lease_token===attempt.leaseToken&&
   operation.cgroup_id===launch.unit_name&&operation.cgroup_inode===expectedTerminalProof.cgroup_inode&&
   ['read','write'].every(direction=>['','overshoot_','cleanup_'].every(prefix=>
    ledger.state.limits[prefix+direction+'_bytes']===attempt.contract.capacity.io[prefix+direction+'_bytes']));
  if(!immutable)return {kind:'UNCERTAIN'};
  validateIoBudgetLedgerState(ledger.state);
  const exact=canonical(operation?.terminal_proof??null)===canonical(expectedTerminalProof);
  if(job.status==='SUCCEEDED'){
   if(!exact||hash(canonical(job.result))!==attempt.resultHash)return {kind:'UNCERTAIN'};
   validateProfileEnrollmentReceipt(evidence);
   if(receipt.operation_id!==attempt.operationId||receipt.lease_token!==attempt.leaseToken||
      receipt.result_hash!==attempt.resultHash||receipt.payload_hash!==attempt.payloadHash)return {kind:'UNCERTAIN'};
   return {kind:'ENROLLED',job,receipt};
  }
  if(receipt)return {kind:'UNCERTAIN'};
  if(exact&&operation.status==='SETTLED'&&launch.state==='STOP_PROVEN')return {kind:'SETTLED_ONLY',job};
  if(job.lease_token===attempt.leaseToken&&job.status==='STOPPING'&&operation&&
     ['ACTIVE','STOP_REQUIRED','RESERVED'].includes(operation.status)&&launch?.state!=='STOP_PROVEN')return {kind:'UNSETTLED'};
  return {kind:'UNCERTAIN'};
  },{isolation:'SERIALIZABLE'});
 }catch{return {kind:'UNCERTAIN'};}
}
