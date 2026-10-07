import {canonical,hash,fail} from '../pine-bridge/source.js';
import {validateProfileResultV2} from '../quant-research/profile-contract-v2.js';
import {QuantIoRuntime,QUANT_PROFILE_RUNTIME_PROTOCOL,quantIoUnitName} from './quant-io-runtime.js';
import {profileCompletionVeto,chargeProfileCompletionRuntime} from './quant-profile-enrollment.js';

const uncertain=()=>fail('QUANT_IO_LAUNCH_UNCERTAIN');
// Graceful stop (signal) and compute deadline both end the frame loop; the drained terminal still runs (W2 3.3).
const stopRequested=()=>fail('PROFILE_STOP_REQUESTED');
const computeDeadline=()=>fail('PROFILE_COMPUTE_DEADLINE');
const policyMismatch=()=>fail('QUANT_PROFILE_POLICY_MISMATCH');
// Measured frozen readback or the unknown-final fallback. Neither admits an evaluator result.
const TERMINAL_PROOFS=Object.freeze(['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED']);
const signalLike=value=>value===null||typeof value==='object'&&typeof value.aborted==='boolean'&&
  typeof value.addEventListener==='function'&&typeof value.removeEventListener==='function';
// The frame loop ends this long before the terminal precheck would refuse: one poll plus scheduling slack. The slack
// covers what still runs between the last passing check and terminate(): the observation round (two systemctl reads,
// a database transaction, health), a heartbeat, beforeTerminal and scheduler.cancel.
const DEADLINE_SLACK_MS=1000;

/** Internal staging adapter. Constructor callbacks resolve current trusted state. */
export class QuantProfileRuntimeV2 {
  constructor({db,ledger,scheduler,launcher,storageBudget,authorizeRelease,health,clock=Date.now,
    pollMs=100,enrollment=null}={}){
    if(!db?.transaction||ledger?.policy?.environment!=='staging'||!scheduler?.cancel||!storageBudget?.root||
      typeof authorizeRelease!=='function'||typeof health!=='function'||
      !Number.isSafeInteger(pollMs)||pollMs<25||pollMs>1000)throw uncertain();
    this.db=db;this.ledger=ledger;this.scheduler=scheduler;this.launcher=launcher;this.clock=clock;this.pollMs=pollMs;
    this.enrollment=enrollment;
    this.io=new QuantIoRuntime({db,ledger,scheduler,launcher,clock,enrollment,
      profile:{protocol:QUANT_PROFILE_RUNTIME_PROTOCOL,root:storageBudget.root,storageBudget,
        authorizeRelease:async job=>{
          if(!db.isTransaction||hash(canonical(job.contract))!==job.contract_hash||
            job.contract.kind!=='PROFILE'||job.contract.version!=='quant-foundation-v2')return false;
          return (await authorizeRelease(Object.freeze({jobId:job.job_id,ownerId:job.owner_id,
            botId:job.contract.bot_id,contractHash:job.contract_hash,
            policyHash:job.contract.capacity.policy_hash,
            deploymentId:job.contract.profile.deployment_id,
            sourceHash:job.contract.profile.source_hash}),job))?.ok===true;
        },health}});
  }

  /** Runs one PROFILE operation. Diagnostics keep a provisional result and end CANCELLED. Explicit
   * enrollment may end SUCCEEDED only after measured settlement and atomic receipt publication.
   * signal: graceful stop (the worker sets it on lease or health loss). Ends the frame wait with
   *   PROFILE_STOP_REQUESTED, then beforeTerminal runs once and the drained terminal follows.
   * The frame loop also ends by itself with PROFILE_COMPUTE_DEADLINE when handle.terminalLimitMs() is not above one
   *   poll plus 1,000 ms, checked before each wait and again right after each observation; the drained terminal
   *   follows the same way.
   * emergency: emergency stop (worker SIGTERM). Calls io.emergencyStop at once, in any phase after the reserve attempt:
   *   no freeze starts and the terminal takes the unknown-final fallback.
   * beforeTerminal: awaited once before the terminal starts, on every path that reserved. The worker stops its
   *   heartbeat there, because a STOPPING job holds no lease to renew.
   * A thrown stop or deadline error carries terminal {status, proof} when the terminal finished.
   */
  async run({jobId,leaseToken,operationId,expectedRevision=0,ownerId,signal=null,emergency=null,
    beforeTerminal=null,onTerminalDiagnostic=null}){
    if(!signalLike(signal)||!signalLike(emergency)||
      beforeTerminal!==null&&typeof beforeTerminal!=='function'||
      onTerminalDiagnostic!==null&&typeof onTerminalDiagnostic!=='function')throw uncertain();
    const request={jobId,leaseToken,operationId};
    let reserveAttempted=false,stop=null,frame=null,failure=null,hooked=false,attempt=null,marked=false;
    const checkStop=()=>{if(signal?.aborted||emergency?.aborted)throw stopRequested();};
    const onEmergency=()=>{if(reserveAttempted)this.io.emergencyStop(request).catch(()=>{});};
    let raiseAbort;
    const abortion=new Promise(resolve=>{raiseAbort=()=>resolve({kind:'abort'});});
    emergency?.addEventListener('abort',onEmergency,{once:true});
    emergency?.addEventListener('abort',raiseAbort,{once:true});
    signal?.addEventListener('abort',raiseAbort,{once:true});
    try{
      checkStop();
      // Policy binding (W2 3.6), before any reserve or write: the ledger policy must be the policy the job contract
      // was built against, and the launcher must enforce exactly that policy's terminal block.
      if(canonical(this.launcher?.terminalConfig??null)!==canonical(this.ledger.policy.terminal??null))
        throw policyMismatch();
      const owned=await this.db.transaction(async()=>{
        await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
        const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
        const ok=row?.owner_id===ownerId&&row.lease_token===leaseToken&&row.status==='RUNNING'&&
          row.contract?.version==='quant-foundation-v2'&&row.contract?.kind==='PROFILE'&&
          hash(canonical(row.contract))===row.contract_hash;
        if(ok&&hash(canonical(this.ledger.policy))!==row.contract.capacity?.policy_hash)throw policyMismatch();
        if(ok&&row.contract.completion_mode==='pf2-enrollment-v1'){
          marked=true;if(this.enrollment?.enabled!==true)throw fail('PROFILE_ENROLLMENT_DISABLED');
        }
        return ok;
      });
      if(!owned)throw uncertain();
      checkStop();
      // L1: refuse a host the drain cannot cover before anything is written; the job stays untouched.
      await this.io.assertHost();
      checkStop();
      // Set before the reserve: a reserve whose commit outcome is unknown still owes a terminal (F16).
      reserveAttempted=true;
      await this.io.reserve({...request,expectedRevision});
      checkStop();
      await this.io.start(request);
      checkStop();
      await this.io.ready(request);
      checkStop();
      await this.io.bind(request);
      checkStop();
      await this.io.release(request);
      const handle=this.io.handles.get(jobId+':'+operationId);
      if(!handle?.profileResult||!handle?.accepted)throw uncertain();
      let pending=handle.profileResult.then(value=>({kind:'result',value}),error=>({kind:'error',error}));
      let acceptance=handle.accepted.then(value=>({kind:'accepted',value}),error=>({kind:'error',error}));
      let accepted=false,complete=false,candidate=null,lastHeartbeat=this.clock();
      const receiptDeadline=Date.now()+3000;
      // Compute deadline (F15): end while the drained terminal still fits. The frame is lost; a measured settle stays possible.
      // A limit that is missing keeps the loop going; a limit that is not a number counts as passed.
      const deadlineNear=()=>typeof handle.terminalLimitMs==='function'&&
        !(handle.terminalLimitMs()>this.pollMs+DEADLINE_SLACK_MS);
      while(!complete){
        checkStop();
        if(deadlineNear())throw computeDeadline();
        const event=await Promise.race([acceptance,pending,abortion,
          new Promise(resolve=>setTimeout(()=>resolve(null),this.pollMs))]);
        if(event?.kind==='abort')throw stopRequested();
        await this.io.observe(request);
        // The observation can run long, so read the limit again before the heartbeat and the next poll. Only the poll
        // timer (no event) ends here; an error, acceptance or result event is handled below, and the check above sees
        // the limit again on the next pass.
        if(!event&&deadlineNear())throw computeDeadline();
        if(this.clock()-lastHeartbeat>=5000){
          await this.scheduler.heartbeat({job_id:jobId,lease_token:leaseToken});
          lastHeartbeat=this.clock();
        }
        if(event?.kind==='error')throw event.error;
        if(event?.kind==='accepted'){
          const payload=this.io.payloads.get(jobId+':'+operationId);
          if(event.value?.unitName!==quantIoUnitName(jobId,operationId)||
            event.value?.payloadHash!==hash(payload))throw uncertain();
          accepted=true;acceptance=new Promise(()=>{});
          if(candidate){frame=candidate;complete=true;}
        }
        if(event?.kind==='result'){
          candidate=event.value;pending=new Promise(()=>{});
          if(accepted){frame=candidate;complete=true;}
        }
        if(!accepted&&Date.now()>=receiptDeadline)throw uncertain();
      }
      const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[jobId])).rows[0];
      const payload=this.io.payloads.get(jobId+':'+operationId);
      if(!row||row.lease_token!==leaseToken||row.status!=='RUNNING'||
        frame?.jobId!==jobId||frame?.operationId!==operationId||
        frame?.payloadHash!==hash(payload)||frame?.resultHash!==hash(canonical(frame.result))||
        Buffer.byteLength(canonical(frame))>Math.min(8*1024*1024,row.contract.budget.max_output_bytes)+4096)
        throw uncertain();
      validateProfileResultV2(row.contract,frame.result,{policy:this.ledger.policy});
      if(frame.result.evaluator_admission!==false)throw uncertain();
      // The I/O runtime supplies its construction-bound enrollment authority; this adapter never chooses one.
      if(marked)attempt=await this.io.prepareEnrollment({job:row,frame,leaseToken,operationId,signal,emergency});
    }catch(error){
      failure=error;throw error;
    }finally{
      try{
        if(reserveAttempted){
          // The heartbeat must be quiet before the terminal: cancel makes the job STOPPING, which holds no lease to renew.
          if(beforeTerminal&&!hooked){hooked=true;try{await beforeTerminal();}
            catch{if(marked&&!failure)failure=fail('PROFILE_ENROLLMENT_DENIED');}}
          // The terminal owns the stop so it can freeze and read the unit before the kill. The emergency listener
          // stays attached until it is done: an emergency during the drain must still reach io.emergencyStop.
          let completion=null;
          if(attempt&&!failure&&!profileCompletionVeto(attempt)){
            try{completion=await this.scheduler.beginProfileCompletion({job_id:jobId,lease_token:leaseToken,attempt});}
            catch{failure=fail('PROFILE_ENROLLMENT_DENIED');}
          }
          try{stop=completion?await this.io.completeProfile({...request,completion,onTerminalDiagnostic}):
            await this.io.cancel({...request,ownerId,onTerminalDiagnostic});}
          catch{
            // Terminal failed before the stop was proven. Never leave the child running.
            const handle=this.io.handles.get(jobId+':'+operationId);
            if(handle)await handle.stop().catch(()=>{});
            // BEGIN stopped the scheduler's runtime clock. Include the failed terminal and stop attempt using
            // the same absolute total as every other completion charge; a failed write must keep quarantine.
            if(completion)try{await chargeProfileCompletionRuntime({db:this.db,completion});}catch{}
            stop={status:'STOPPING',proof:'UNCONFIRMED'};
          }
          if(failure&&typeof failure==='object'&&stop){
            try{failure.terminal=Object.freeze({status:stop.status,proof:stop.proof});}catch{}
          }
        }
      }finally{
        emergency?.removeEventListener('abort',onEmergency);
        emergency?.removeEventListener('abort',raiseAbort);
        signal?.removeEventListener('abort',raiseAbort);
      }
    }
    if(failure)throw failure;
    if(marked&&stop?.status==='SUCCEEDED'&&stop.proof==='MEASURED_FINAL_SETTLED')
      return Object.freeze({status:'SUCCEEDED',proof:stop.proof});
    if(stop?.status!=='CANCELLED'||!TERMINAL_PROOFS.includes(stop?.proof))throw uncertain();
    return Object.freeze({status:'CANCELLED',proof:stop.proof,
      provisional:Object.freeze({jobId,operationId,payloadHash:frame.payloadHash,
        resultHash:frame.resultHash,result:frame.result,evaluator_admission:false})});
  }
}
