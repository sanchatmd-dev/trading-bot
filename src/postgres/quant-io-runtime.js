import {canonical,hash,fail} from '../pine-bridge/source.js';
import path from 'node:path';
import {reserveIoOperation,bindIoOperation,observeIoOperation,getIoStopDecision} from '../quant-research/io-budget-ledger.js';
import {validateFoundationRequestV2} from '../quant-research/foundation-contract-v2.js';
import {terminalReadbackDigest,POST_EXIT_MEASURED,COMMIT_LOCK_TIMEOUT_MS,COMMIT_BOUND_MS} from '../quant-research/io-terminal.js';
import {finalizeProfileEnrollmentLocked,readProfileCompletionOutcome,refreshProfileCompletionTicket,
 profileCompletionAttempt,profileCompletionVeto,recordProfileCompletionProof} from './quant-profile-enrollment.js';

const unavailable=()=>fail('QUANT_IO_ACCOUNTING_UNAVAILABLE');
const lost=()=>fail('QUANT_IO_LEASE_LOST');
const uncertain=()=>fail('QUANT_IO_LAUNCH_UNCERTAIN');
const key=(jobId,operationId)=>jobId+':'+operationId;
export const QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH=hash(canonical({mode:'sleep'}));
export const QUANT_PROFILE_RUNTIME_PROTOCOL='profile-v2-provisional';
export const quantIoUnitName=(jobId,operationId)=>
  'robot-quant-'+hash(canonical({jobId,operationId}))+'.service';
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const diagnosticReasons=new Set(['COMPLETE','STOP_REQUESTED','ALREADY_STOPPING','STOP_UNCONFIRMED','UNKNOWN',
 'WRITEBACK_PENDING','COMMIT_BARRIER_FAILED','COMMIT_BARRIER_TIMEOUT','MEMORY_STAT_INVALID','FREEZE_UNVERIFIED',
 'NOT_FROZEN','CGROUP_EMPTY','QUANT_IO_TELEMETRY_UNAVAILABLE','POST_EXIT_UNKNOWN','POST_EXIT_TAIL_OBSERVED']);
// Frozen commit age limits. The terminal tail floor is after-snapshot 1,000 + commit COMMIT_BOUND_MS 3,000 + kill
// slack 1,000. lock_timeout limits one wait but the transaction takes four row locks in a row (singleton, job,
// ledger, launches), so waits of just under COMMIT_LOCK_TIMEOUT_MS each could add up to 4 x 2,000. The transaction
// therefore checks its own age twice, and each check needs both clocks to pass:
//   server: clock_timestamp() - transaction_timestamp() (the BEGIN): lock waits and statement time count;
//   client: performance.now() minus the moment commitFrozen was entered (monotonic): the pool checkout and the BEGIN
//           round trip count too. The pool alone can wait connectionTimeoutMillis (5,000 ms) before the BEGIN.
// Limits:
//   once the four locks are held: <= 3,000 - 1,000 = 2,000 ms (1,000 ms remain for the read, the UPDATE and COMMIT)
//   right before COMMIT:          <= 3,000 -   500 = 2,500 ms (500 ms remain for the COMMIT flush)
// An older transaction throws and rolls back and the terminal falls back to the crash charge. There is no JavaScript
// timer: a timer that fired late could race the crash CAS.
// The real bound: a commit that passes the last check was at most 2,500 ms old on both clocks when the check ran. The
// COMMIT round trip, its flush and any event loop stall between the check and the COMMIT are not measured, so a commit
// can land later than 2,500 ms after entry by that extra time (single-digit milliseconds on a healthy server), never
// unboundedly. A commit that fails is not held to these limits either: four lock waits of up to 2,000 ms can pass before
// the first check rolls it back (about 8 s). That is safe because a failed commit only selects the unmeasured fallback.
const COMMIT_LOCKS_HELD_MS=COMMIT_BOUND_MS-1000;
const COMMIT_BEFORE_COMMIT_MS=COMMIT_BOUND_MS-500;
// Any other failure of the launcher host gate is reported with the same fixed code and no detail.
const hostRefused=()=>fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
function trustedSample(value,ready,unitName,devices){
  const group=value?.group;
  const segments=typeof group==='string'?group.split('/').slice(1):[];
  if(!value||!ready||!Array.isArray(devices)||devices.length!==1||
    value.unitName!==unitName||ready.unitName!==unitName||
    group!==ready.group||!group?.endsWith('/'+unitName)||
    path.posix.normalize(group)!==group||segments.some(segment=>!segment||segment==='.'||segment==='..')||
    segments.slice(0,-1).some(segment=>/^robot-quant-[a-f0-9]{64}\.service$/.test(segment))||
    value.invocationId!==ready.invocationId||
    value.cgroupInode!==ready.cgroupInode||!safe(value.cgroupInode)||value.cgroupInode===0||
    value.deviceId!==devices[0].device_id||value.deviceInode!==devices[0].device_inode||
    !safe(value.deviceInode)||value.deviceInode===0||!safe(value.readBytes)||!safe(value.writeBytes)||
    !Number.isSafeInteger(value.pid)||value.pid<=0||
    typeof value.procStartTicks!=='string'||!/^\d+$/.test(value.procStartTicks)||
    typeof value.invocationId!=='string'||!/^[a-f0-9]{32}$/.test(value.invocationId))throw uncertain();
  return {devices:[{device_id:value.deviceId,device_inode:value.deviceInode,
    read_bytes:value.readBytes,write_bytes:value.writeBytes}]};
}
const sameBound=(sample,bound)=>bound&&
  ['unitName','group','pid','procStartTicks','cgroupInode','deviceId','deviceInode','invocationId']
    .every(field=>sample[field]===bound[field]);
const trustedStop=(proof,unitName)=>proof?.unitName===unitName&&proof.launcherClosed===true&&
  proof.startRegistered===true&&proof.pendingStartsExcluded===true&&proof.unitStopped===true;

/** Runs inside the scheduler's existing transaction and singleton/job lock.
 * The SQL trigger independently protects every scheduler instance.
 */
export async function canReleaseQuantIo(db,row){
  const launch=(await db.query("SELECT 1 FROM quant_io_launches WHERE job_id=$1 AND state<>'STOP_PROVEN' LIMIT 1",[row.job_id])).rowCount;
  const ledger=(await db.query('SELECT state FROM quant_io_ledgers WHERE job_id=$1',[row.job_id])).rows[0];
  const unresolved=ledger?.state.operations.some(op=>
    ['RESERVED','ACTIVE','STOP_REQUIRED','CRASHED_UNCONFIRMED'].includes(op.status));
  return {ok:launch===0&&!unresolved};
}

/** Opt-in diagnostic protocol. A process handle exists only in this instance.
 * Lost commit or process restart leaves durable intent quarantined.
 */
export class QuantIoRuntime {
  constructor({db,ledger,scheduler,launcher,clock=Date.now,profile=null}){
    if(!db?.transaction||!ledger?.open||!scheduler?.cancel||
      !launcher?.spawnPrepared||typeof clock!=='function')throw unavailable();
    if(profile&&(profile.protocol!==QUANT_PROFILE_RUNTIME_PROTOCOL||
      typeof profile.authorizeRelease!=='function'||typeof profile.health!=='function'||
      typeof profile.root!=='string'||!path.isAbsolute(profile.root)||
      !profile.storageBudget||profile.storageBudget.root!==profile.root))throw unavailable();
    // Measured settlement runs ledger.settleLocked inside this runtime's transaction. That only
    // works on the same PostgresDatabase instance (per-instance isTransaction); fail at build time.
    if(ledger.db!==db)throw unavailable();
    this.db=db;this.ledger=ledger;this.scheduler=scheduler;this.launcher=launcher;
    this.profile=profile;this.payloads=new Map();
    this.clock=clock;this.handles=new Map();this.boundIdentity=new Map();
    this.releaseAllowed=new Set();this.releaseDisabled=new Set();
    this.terminals=new Map();
    this.emergency=new Set();
  }

  /** Drain host gate (FTR-1c-D L1). When the launcher has a configured drain above 0 it checks the writeback plan and the
   * ext4 storage root here, before any ledger reservation or launch row is written. A refusal throws
   * QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED (with the launcher's enum-only ioDiagnostic) and writes nothing. prepare()
   * keeps the same gate as the backstop, so a host change after this check still fails closed there.
   * A launcher that carries a terminal block with a drain above 0 must expose the gate. Without it the reserve would
   * run unchecked and only prepare() could refuse, after the ledger was written, so this fails closed here (I4).
   */
  async assertHost(){
    if(typeof this.launcher.assertDrainHost!=='function'){
      if(this.launcher?.terminalConfig?.terminal_drain_ms>0)throw hostRefused();
      return;
    }
    try{await this.launcher.assertDrainHost();}
    catch(error){throw error?.code==='QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'?error:hostRefused();}
  }

  /** Emergency stop (worker SIGTERM, operator). Idempotent. The id joins the emergency set first, so no freeze starts
   * for this operation afterwards, whichever phase it is in. With a handle it calls handle.stop(): that joins a running
   * terminate() and makes a drain end within one poll, or stops the unit at once before a terminal begins. Without a
   * handle only the set entry is made and terminal() honors it. It never touches the database.
   */
  async emergencyStop({jobId,operationId}){
    const id=key(jobId,operationId);
    this.emergency.add(id);
    const handle=this.handles.get(id);
    if(handle)return handle.stop();
    return null;
  }

  async locked(jobId,leaseToken,callback,{active=true,bounded=false,ledgerOptional=false,enteredAt=null,isolation='READ COMMITTED'}={}){
    if(this.db.isTransaction)throw unavailable();
    if(bounded&&!Number.isFinite(enteredAt))throw unavailable();
    try{return await this.db.transaction(async()=>{
      // Commit bound (RD-3): the server aborts a stuck lock wait or statement inside this transaction, so a
      // frozen commit that cannot finish fails at once and can never commit late. No JavaScript timer.
      if(bounded){
        await this.db.query(`SET LOCAL lock_timeout='${COMMIT_LOCK_TIMEOUT_MS}ms'`);
        await this.db.query(`SET LOCAL statement_timeout='${COMMIT_BOUND_MS}ms'`);
      }
      // Age check, never a JavaScript timer: a late COMMIT could race the crash CAS. Client clock first (it covers the
      // pool checkout and BEGIN before the transaction exists), then the server clock (BEGIN to now).
      const withinAge=async limitMs=>performance.now()-enteredAt<=limitMs&&(await this.db.query(
        "SELECT clock_timestamp()-transaction_timestamp()<=$1::int*interval '1 millisecond' AS within",
        [limitMs])).rows[0]?.within===true;
      const singleton=await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
      if(singleton.rowCount!==1)throw unavailable();
      const job=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
      const now=this.clock();
      if(!job||job.lease_token!==leaseToken||!Number.isSafeInteger(now)||
        active&&(job.status!=='RUNNING'||job.lease_until<=now||job.deadline_at<=now))throw lost();
      if(hash(canonical(job.contract))!==job.contract_hash||job.contract.version!=='quant-foundation-v2')throw unavailable();
      if(active){
        if(!this.ledger.policy||!this.ledger.devices)throw unavailable();
        validateFoundationRequestV2(job.contract,{policy:this.ledger.policy});
      }
      const ledgerRow=(await this.db.query('SELECT * FROM quant_io_ledgers WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
      // ledgerOptional (the terminal without a handle) accepts a job that never got a ledger row; an existing row is
      // checked exactly as before.
      if(ledgerRow||!ledgerOptional){
        if(!ledgerRow||ledgerRow.state_hash!==hash(canonical(ledgerRow.state))||
          ledgerRow.revision!==ledgerRow.state.revision||ledgerRow.lease_token!==leaseToken||
          ledgerRow.policy_hash!==job.contract.capacity.policy_hash||
          ledgerRow.state.lease_token!==leaseToken)throw unavailable();
        if(active&&canonical(ledgerRow.state.devices)!==canonical(this.ledger.devices))throw unavailable();
      }
      const intent=(await this.db.query('SELECT * FROM quant_io_launches WHERE job_id=$1 FOR UPDATE',[jobId])).rows;
      if(bounded&&!await withinAge(COMMIT_LOCKS_HELD_MS))throw unavailable();
      const value=await callback({job,ledgerRow,intent,now});
      if(bounded&&!await withinAge(COMMIT_BEFORE_COMMIT_MS))throw unavailable();
      return value;
    },{isolation});}catch(error){
      if(['QUANT_IO_LEASE_LOST','QUANT_IO_LAUNCH_UNCERTAIN','QUANT_IO_ACCOUNTING_UNAVAILABLE',
        'INVALID_IO_BUDGET_LEDGER'].includes(error?.code))throw error;
      throw unavailable();
    }
  }

  async reserve({jobId,leaseToken,expectedRevision,operationId,allowance}){
    // L1: the drain host gate runs before the first database write (ledger open, reservation, launch intent).
    await this.assertHost();
    // Initialization has no launch intent. Reserve and intent then commit together.
    await this.ledger.open({jobId,leaseToken});
    const reserved=await this.locked(jobId,leaseToken,async({job,ledgerRow,intent,now})=>{
      if(ledgerRow.revision!==expectedRevision||intent.length!==0||
        ledgerRow.state.operations.length!==0)throw uncertain();
      const unitName=quantIoUnitName(jobId,operationId);
      const io=job.contract.capacity.io;
      const reservedAllowance=this.profile?{
        read_bytes:io.read_bytes-io.overshoot_read_bytes-io.cleanup_read_bytes,
        write_bytes:io.write_bytes-io.overshoot_write_bytes-io.cleanup_write_bytes}:allowance;
      const input={operation_id:operationId,lease_token:leaseToken,
        domain_id:'domain-'+hash(canonical({jobId,operationId})).slice(0,64),
        cgroup_id:unitName,allowance:reservedAllowance};
      const next=reserveIoOperation(ledgerRow.state,input);
      const update=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
        WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),hash(canonical(next)),expectedRevision]);
      if(update.rowCount!==1)throw uncertain();
      const profilePayload=this.profile?{
        version:QUANT_PROFILE_RUNTIME_PROTOCOL,jobId,operationId,
        contract:job.contract,policy:this.ledger.policy,
        storage:{root:this.profile.root,diskQuotaBytes:this.profile.storageBudget.diskQuotaBytes,
          tempQuotaBytes:this.profile.storageBudget.tempQuotaBytes,
          freeFloorBytes:this.profile.storageBudget.freeFloorBytes}}:null;
      const payloadText=profilePayload?canonical(profilePayload):null;
      if(payloadText&&Buffer.byteLength(payloadText)>65536)throw uncertain();
      const payloadDigest=payloadText?hash(payloadText):QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH;
      await this.db.query(`INSERT INTO quant_io_launches
        (job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at)
        VALUES($1,$2,$3,$4,$5,'INTENT_RECORDED',$6)`,
        [jobId,operationId,leaseToken,unitName,payloadDigest,now]);
      return {state:next,unitName,payloadText};
    });
    if(reserved.payloadText)this.payloads.set(key(jobId,operationId),reserved.payloadText);
    return {state:reserved.state,unitName:reserved.unitName};
  }

  async start({jobId,leaseToken,operationId}){
    const intent=await this.locked(jobId,leaseToken,async({intent})=>{
      const row=intent.find(item=>item.operation_id===operationId);
      if(!row||row.lease_token!==leaseToken||row.state!=='INTENT_RECORDED')throw uncertain();
      await this.db.query("UPDATE quant_io_launches SET state='STARTING' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
      return row;
    });
    let handle=null,preparation=null;
    try{
      if(this.launcher.prepare)preparation=await this.launcher.prepare({unitName:intent.unit_name,
        payload:this.payloads.get(key(jobId,operationId))});
      await this.locked(jobId,leaseToken,async({intent:rows,job})=>{
        const row=rows.find(item=>item.operation_id===operationId);
        if(!row||row.state!=='STARTING'||row.unit_name!==intent.unit_name||
          row.payload_hash!==(this.profile?hash(this.payloads.get(key(jobId,operationId))):QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH))throw uncertain();
        const current=this.clock();
        if(!Number.isSafeInteger(current)||job.lease_until<=current||job.deadline_at<=current)throw lost();
        // No await between final scheduler check and this synchronous spawn.
        handle=preparation?preparation.spawnPrepared():this.launcher.spawnPrepared({unitName:row.unit_name});
        if(!handle||handle.payloadHash!==row.payload_hash||
          typeof handle.release!=='function'||typeof handle.stop!=='function')throw uncertain();
        this.handles.set(key(jobId,operationId),handle);
        await this.db.query("UPDATE quant_io_launches SET state='SPAWNED' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
      });
      return {unitName:intent.unit_name};
    }catch(error){
      if(handle)await handle.stop().catch(()=>{});
      else if(preparation)try{await preparation.abort();}catch{throw uncertain();}
      throw error;
    }
  }

  async bind({jobId,leaseToken,operationId}){
    const id=key(jobId,operationId),handle=this.handles.get(id);
    if(!handle?.sample||this.releaseDisabled.has(id)||this.releaseAllowed.has(id))throw uncertain();
    try{
      const ready=await handle.ready;
      const identity=await handle.sample();
      const result=await this.locked(jobId,leaseToken,async({intent,job,ledgerRow})=>{
        const row=intent.find(item=>item.operation_id===operationId);
        const operation=ledgerRow.state.operations.find(item=>item.operation_id===operationId);
        if(!row||row.state!=='SPAWNED'||row.lease_token!==leaseToken||
        !operation||operation.status!=='RESERVED'||operation.cgroup_id!==row.unit_name||
        ledgerRow.state.operations.length!==1||intent.length!==1)
          throw uncertain();
        const sample=trustedSample(identity,ready,row.unit_name,ledgerRow.state.devices);
        const current=this.clock();
        if(!Number.isSafeInteger(current)||job.lease_until<=current||job.deadline_at<=current)throw lost();
        const domainProof=hash(canonical({version:'quant-io-sole-child-domain-v1',jobId,operationId,
          unitName:row.unit_name,group:identity.group,cgroupInode:identity.cgroupInode,
          soleOperation:true}));
        const identityProof=hash(canonical({version:'quant-io-identity-proof-v1',jobId,operationId,
          identity}));
        const next=bindIoOperation(ledgerRow.state,{operation_id:operationId,lease_token:leaseToken,
          domain_id:operation.domain_id,cgroup_id:row.unit_name,cgroup_inode:identity.cgroupInode,
          domain_relation:'DISJOINT',domain_proof_sha256:domainProof,
          identity_proof_sha256:identityProof,counter_origin:'CGROUP_BIRTH',sample});
        const saved=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
          WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),
          hash(canonical(next)),ledgerRow.revision]);
        if(saved.rowCount!==1)throw uncertain();
        return next;
      });
      if(result.operations.find(item=>item.operation_id===operationId)?.status!=='ACTIVE')throw uncertain();
      this.boundIdentity.set(id,{unitName:identity.unitName,group:identity.group,pid:identity.pid,
        procStartTicks:identity.procStartTicks,cgroupInode:identity.cgroupInode,
        deviceId:identity.deviceId,deviceInode:identity.deviceInode,
        invocationId:identity.invocationId});
      this.releaseAllowed.add(id);
      return result;
    }catch(error){
      this.releaseAllowed.delete(id);this.releaseDisabled.add(id);this.boundIdentity.delete(id);
      await handle.stop().catch(()=>{});
      throw error;
    }
  }

  async release({jobId,leaseToken,operationId}){
    const id=key(jobId,operationId),handle=this.handles.get(id);
    if(!handle||!this.releaseAllowed.has(id)||this.releaseDisabled.has(id))throw uncertain();
    try{
      const ready=await handle.ready;
      const first=await handle.sample();
      if(!sameBound(first,this.boundIdentity.get(id)))throw uncertain();
      await this.locked(jobId,leaseToken,async({intent,ledgerRow})=>{
        const row=intent.find(item=>item.operation_id===operationId);
        const operation=ledgerRow.state.operations.find(item=>item.operation_id===operationId);
        if(!row||row.state!=='SPAWNED'||row.payload_hash!==handle.payloadHash||
          !operation||operation.status!=='ACTIVE'||operation.cgroup_id!==row.unit_name)throw uncertain();
        const sample=trustedSample(first,ready,row.unit_name,ledgerRow.state.devices);
        const next=observeIoOperation(ledgerRow.state,{operation_id:operationId,
          lease_token:leaseToken,cgroup_id:row.unit_name,cgroup_inode:operation.cgroup_inode,sample});
        if(next.revision!==ledgerRow.revision){
          const saved=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
            WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),
            hash(canonical(next)),ledgerRow.revision]);
          if(saved.rowCount!==1)throw uncertain();
        }
      });
      const result=await this.locked(jobId,leaseToken,async({intent,job,ledgerRow})=>{
        const row=intent.find(item=>item.operation_id===operationId);
        const operation=ledgerRow.state.operations.find(item=>item.operation_id===operationId);
        if(!row||row.state!=='SPAWNED'||row.payload_hash!==handle.payloadHash||
          !operation||operation.status!=='ACTIVE'||operation.cgroup_id!==row.unit_name)throw uncertain();
        const fresh=await handle.sample();
        if(!sameBound(fresh,this.boundIdentity.get(id)))throw uncertain();
        const sample=trustedSample(fresh,ready,row.unit_name,ledgerRow.state.devices);
        if(canonical(operation.last)!==canonical(sample)){
          const next=observeIoOperation(ledgerRow.state,{operation_id:operationId,
            lease_token:leaseToken,cgroup_id:row.unit_name,
            cgroup_inode:operation.cgroup_inode,sample});
          const saved=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
            WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),
            hash(canonical(next)),ledgerRow.revision]);
          if(saved.rowCount!==1)throw uncertain();
          return {denied:true};
        }
        if(getIoStopDecision(ledgerRow.state,{operation_id:operationId,lease_token:leaseToken,
          cgroup_id:row.unit_name,cgroup_inode:operation.cgroup_inode}).stop_required)
          return {denied:true};
        if(this.profile){
          if((await this.profile.authorizeRelease(job))!==true||
            (await this.profile.health({action:'PROFILE_RELEASE'}))?.ok!==true)throw uncertain();
          const afterAuthorization=await handle.sample();
          if(!sameBound(afterAuthorization,this.boundIdentity.get(id)))return {denied:true};
          const finalSample=trustedSample(afterAuthorization,ready,row.unit_name,ledgerRow.state.devices);
          if(canonical(finalSample)!==canonical(sample)){
            const next=observeIoOperation(ledgerRow.state,{operation_id:operationId,
              lease_token:leaseToken,cgroup_id:row.unit_name,
              cgroup_inode:operation.cgroup_inode,sample:finalSample});
            const saved=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
              WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),
              hash(canonical(next)),ledgerRow.revision]);
            if(saved.rowCount!==1)throw uncertain();
            return {denied:true};
          }
        }
        const current=this.clock();
        if(!Number.isSafeInteger(current)||job.lease_until<=current||job.deadline_at<=current)throw lost();
        // No await between final identity/lease check and fixed payload release.
        handle.release();
        await this.db.query("UPDATE quant_io_launches SET state='RELEASED' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
        return {unitName:row.unit_name};
      });
      if(result.denied)throw uncertain();
      this.releaseAllowed.delete(id);
      return result;
    }catch(error){this.releaseAllowed.delete(id);this.releaseDisabled.add(id);
      await handle.stop().catch(()=>{});throw error;}
  }

  async observe({jobId,leaseToken,operationId}){
    if(!this.profile)throw uncertain();
    const id=key(jobId,operationId),handle=this.handles.get(id);
    if(!handle||!this.boundIdentity.has(id))throw uncertain();
    const ready=await handle.ready;
    const identity=await handle.sample();
    if(!sameBound(identity,this.boundIdentity.get(id)))throw uncertain();
    const observed=await this.locked(jobId,leaseToken,async({job,ledgerRow,intent})=>{
      const row=intent.find(item=>item.operation_id===operationId);
      const operation=ledgerRow.state.operations.find(item=>item.operation_id===operationId);
      if(!row||row.state!=='RELEASED'||!operation||operation.status!=='ACTIVE')throw uncertain();
      const sample=trustedSample(identity,ready,row.unit_name,ledgerRow.state.devices);
      const next=observeIoOperation(ledgerRow.state,{operation_id:operationId,
        lease_token:leaseToken,cgroup_id:row.unit_name,cgroup_inode:operation.cgroup_inode,sample});
      if(next.revision!==ledgerRow.revision){
        const saved=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
          WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),
          hash(canonical(next)),ledgerRow.revision]);
        if(saved.rowCount!==1)throw uncertain();
      }
      const stop=getIoStopDecision(next,{operation_id:operationId,lease_token:leaseToken,
        cgroup_id:row.unit_name,cgroup_inode:operation.cgroup_inode}).stop_required;
      let permitted=false;
      if(!stop)try{permitted=(await this.profile.health({action:'PROFILE_OBSERVE'}))?.ok===true&&
        (await this.profile.authorizeRelease(job))===true;}catch{}
      return {sample,stop:stop||!permitted};
    });
    if(observed.stop)throw uncertain();
    return observed.sample;
  }

  async ready({jobId,operationId}){
    const handle=this.handles.get(key(jobId,operationId));
    if(!handle?.ready)throw uncertain();
    try{return await handle.ready;}
    catch(error){await handle.stop().catch(()=>{});throw error;}
  }

  /** Single terminal per operation. Concurrent cancels join the running terminal. */
  async cancel({ownerId,jobId,leaseToken,operationId,onTerminalDiagnostic=null}){
    const id=key(jobId,operationId);
    const stoppedJob=await this.scheduler.cancel(ownerId,jobId);
    if(stoppedJob.status!=='STOPPING'||stoppedJob.lease_token!==leaseToken)throw lost();
    const running=this.terminals.get(id);
    if(running)return running;
    const terminal=this.terminal({jobId,leaseToken,operationId,onTerminalDiagnostic});
    this.terminals.set(id,terminal);
    try{return await terminal;}
    finally{if(this.terminals.get(id)===terminal)this.terminals.delete(id);}
  }

  /** Shares the cancellation terminal; beginning completion has already retained the global slot. */
  async completeProfile({jobId,leaseToken,operationId,completion,onTerminalDiagnostic=null}){
    const attempt=profileCompletionAttempt(completion);
    if(!attempt||attempt.jobId!==jobId||attempt.leaseToken!==leaseToken||attempt.operationId!==operationId)throw uncertain();
    const id=key(jobId,operationId),running=this.terminals.get(id);
    if(running)return running;
    const terminal=(async()=>{
    if(!this.handles.has(id)){
      const observed=await readProfileCompletionOutcome({db:this.db,jobId,completion});
      if(observed.kind==='ENROLLED')return {status:'SUCCEEDED',proof:'MEASURED_FINAL_SETTLED'};
      if(observed.kind==='SETTLED_ONLY'&&observed.job.status==='CANCELLED')return {status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'};
      if(observed.kind==='SETTLED_ONLY'&&observed.job.status==='STOPPING'){
        try{
          await this.scheduler.cancel(attempt.contract.owner_id,jobId);
          const stopped=await this.scheduler.acknowledgeStopped(jobId,leaseToken);
          return {status:stopped.status,proof:'MEASURED_FINAL_SETTLED'};
        }catch{return {status:'STOPPING',proof:'UNCONFIRMED'};}
      }
      if(observed.kind==='UNCERTAIN')return {status:'STOPPING',proof:'UNCONFIRMED'};
    }
    return this.terminal({jobId,leaseToken,operationId,completion,onTerminalDiagnostic});
    })();
    this.terminals.set(id,terminal);
    try{return await terminal;}
    finally{if(this.terminals.get(id)===terminal)this.terminals.delete(id);}
  }

  /** T2: persist the frozen sample as an ordinary observation. It runs before the unit is killed. */
  async commitFrozen({jobId,leaseToken,operationId,handle,bound},sample){
    // L2: the client-side age limit counts from here, so a pool checkout wait is part of the bound.
    const enteredAt=performance.now();
    const ready=await handle.ready;
    await this.locked(jobId,leaseToken,async({intent,ledgerRow})=>{
      const row=intent.find(item=>item.operation_id===operationId);
      const operation=ledgerRow.state.operations.find(item=>item.operation_id===operationId);
      if(!row||!['SPAWNED','RELEASED'].includes(row.state)||row.payload_hash!==handle.payloadHash||
        !operation||!['ACTIVE','STOP_REQUIRED'].includes(operation.status)||
        operation.cgroup_id!==row.unit_name||!sameBound(sample,bound))throw uncertain();
      const trusted=trustedSample(sample,ready,row.unit_name,ledgerRow.state.devices);
      const next=observeIoOperation(ledgerRow.state,{operation_id:operationId,lease_token:leaseToken,
        cgroup_id:row.unit_name,cgroup_inode:operation.cgroup_inode,sample:trusted});
      if(next.revision!==ledgerRow.revision){
        const saved=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
          WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),
          hash(canonical(next)),ledgerRow.revision]);
        if(saved.rowCount!==1)throw uncertain();
      }
    },{active:false,bounded:true,enteredAt});
  }

  /** T4a: measured settlement and launch STOP_PROVEN in one transaction, through the terminal
   * authorization hook. Returns ENROLLED, SETTLED_ONLY, DENIED, UNSETTLED or UNCERTAIN.
   * Only UNSETTLED permits the unknown-final fallback; an uncertain enrollment stays quarantined.
   */
  async settleMeasured({jobId,leaseToken,operationId,handle,bound,frozen,evidence,postExit,stopDigest,completion=null}){
    let readbackDigest;
    try{
      readbackDigest=terminalReadbackDigest({jobId,operationId,unitName:frozen.unitName,group:frozen.group,
        cgroupInode:frozen.cgroupInode,invocationId:frozen.invocationId,pid:frozen.pid,
        procStartTicks:frozen.procStartTicks,deviceId:frozen.deviceId,deviceInode:frozen.deviceInode,
        reads:evidence.reads.map(read=>({readBytes:read.readBytes,writeBytes:read.writeBytes})),
        windowMs:evidence.windowMs,fileDirty:evidence.fileDirty,fileWriteback:evidence.fileWriteback,
        freezer:evidence.freezer,postExit});
      if(evidence.reads.some(read=>read.readBytes!==frozen.readBytes||read.writeBytes!==frozen.writeBytes))
        return {kind:'UNSETTLED'};
    }catch{return {kind:'UNSETTLED'};}
    let expected=null;
    let executionTicket=null,healthObservation=null;
    // These observations happen only after trusted physical stop, outside all accounting locks.
    if(completion){
      try{executionTicket=await refreshProfileCompletionTicket(completion);}catch{}
      try{healthObservation=await this.profile.health({action:'PROFILE_OBSERVE'});}catch{}
    }
    try{
      const ready=await handle.ready;
      return await this.locked(jobId,leaseToken,async({job,ledgerRow,intent})=>{
        const row=intent.find(item=>item.operation_id===operationId);
        const operation=ledgerRow.state.operations.find(item=>item.operation_id===operationId);
        if(!row||!operation||row.payload_hash!==handle.payloadHash||row.unit_name!==bound.unitName||
          operation.cgroup_id!==row.unit_name||operation.cgroup_inode!==bound.cgroupInode||
          !sameBound(frozen,bound))return {kind:'UNSETTLED'};
        const sample=trustedSample(frozen,ready,row.unit_name,ledgerRow.state.devices);
        expected={operation_id:operationId,lease_token:leaseToken,cgroup_id:operation.cgroup_id,
          cgroup_inode:operation.cgroup_inode,stopped:true,stop_proof_sha256:stopDigest,
          final_readback:true,readback_proof_sha256:readbackDigest,sample};
        if(completion)recordProfileCompletionProof(completion,expected);
        if(operation.status==='SETTLED'){
          if(canonical(operation.terminal_proof)!==canonical(expected))throw uncertain();
        }else if(!['SPAWNED','RELEASED'].includes(row.state)||
          !['ACTIVE','STOP_REQUIRED'].includes(operation.status)||
          canonical(operation.last)!==canonical(sample))return {kind:'UNSETTLED'};
        const settledState=await this.ledger.settleLocked({job,row:ledgerRow,leaseToken,
          expectedRevision:ledgerRow.revision,input:expected});
        if(row.state!=='STOP_PROVEN')await this.db.query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
        if(!completion)return {kind:'SETTLED_ONLY'};
        const settledLedger={...ledgerRow,revision:settledState.revision,state:settledState,state_hash:hash(canonical(settledState))};
        return finalizeProfileEnrollmentLocked({db:this.db,job,settledLedger,launch:{...row,state:'STOP_PROVEN'},
          completion,executionTicket,healthObservation,currentPolicy:this.ledger.policy,shouldVeto:()=>this.emergency.has(key(jobId,operationId))||
            profileCompletionVeto(profileCompletionAttempt(completion))});
      },{active:false,isolation:completion?'SERIALIZABLE':'READ COMMITTED'});
    }catch(error){
      // Commit outcome may be unknown. Reread before any fallback; never crash-charge a committed settle.
      if(completion){
        const observed=await readProfileCompletionOutcome({db:this.db,jobId,completion,expectedTerminalProof:expected});
        if(observed.kind==='ENROLLED'||observed.kind==='SETTLED_ONLY')return observed;
        if(observed.kind==='UNSETTLED')return observed;
        return {kind:'UNCERTAIN'};
      }
      let observed;
      try{
        observed=await this.locked(jobId,leaseToken,async({ledgerRow,intent})=>({
          operation:ledgerRow.state.operations.find(item=>item.operation_id===operationId),
          row:intent.find(item=>item.operation_id===operationId)}),{active:false});
      }catch{throw error;}
      if(observed.operation?.status==='SETTLED'){
        if(expected&&canonical(observed.operation.terminal_proof)===canonical(expected)&&
          observed.row?.state==='STOP_PROVEN')return {kind:'SETTLED_ONLY'};
        throw uncertain();
      }
      return {kind:'UNSETTLED'};
    }
  }

  async terminal({jobId,leaseToken,operationId,onTerminalDiagnostic=null,completion=null}){
    const id=key(jobId,operationId),handle=this.handles.get(id);
    let digest,outcome=null,committed=null;
    const started=performance.now();
    const complete=(status,proof)=>{
      if(typeof onTerminalDiagnostic==='function'){
        const timing=outcome?.readbackEvidence??outcome?.diagnostic;
        const drainMs=timing?.drainMs??timing?.drain?.durationMs,barrierMs=timing?.barrierMs;
        const reason=diagnosticReasons.has(outcome?.reason)?outcome.reason:
          proof==='UNCONFIRMED'?'STOP_UNCONFIRMED':proof==='MEASURED_FINAL_SETTLED'?'COMPLETE':'UNKNOWN';
        try{onTerminalDiagnostic(Object.freeze({proof,reason,elapsedMs:Math.max(0,Math.round(performance.now()-started)),
          ...(safe(drainMs)?{drainMs}:{}),...(safe(barrierMs)?{barrierMs}:{})}));}catch{}
      }
      return {status,proof};
    };
    if(handle){
      const bound=this.boundIdentity.get(id)??null;
      let proof;
      // An emergency stop never freezes: the unit is stopped at once and the terminal takes the unknown-final fallback.
      // The check and the terminate() call have no await between them, so a later emergencyStop() joins terminate().
      if(typeof handle.terminate==='function'&&bound&&!this.emergency.has(id)){
        outcome=await handle.terminate({bound,commit:async sample=>{
          await this.commitFrozen({jobId,leaseToken,operationId,handle,bound},sample);
          committed=canonical(sample);
        }});
        proof=outcome?.stopProof;
      }else proof=await handle.stop();
      if(!trustedStop(proof,quantIoUnitName(jobId,operationId)))
        return complete('STOPPING','UNCONFIRMED');
      digest=hash(canonical({version:'quant-io-stop-proof-v1',jobId,operationId,
        unitName:proof.unitName,launcherClosed:true,startRegistered:true,
        pendingStartsExcluded:true,unitStopped:true}));
      if(outcome?.measured===true&&committed!==null&&outcome.frozenSample&&
        committed===canonical(outcome.frozenSample)&&POST_EXIT_MEASURED.includes(outcome.postExit)){
        const settlement=await this.settleMeasured({jobId,leaseToken,operationId,handle,bound,frozen:outcome.frozenSample,
          evidence:outcome.readbackEvidence,postExit:outcome.postExit,stopDigest:digest,completion});
        if(settlement?.kind==='UNCERTAIN')return complete('STOPPING','UNCONFIRMED');
        if(['ENROLLED','SETTLED_ONLY','DENIED'].includes(settlement?.kind)){
          this.handles.delete(id);this.emergency.delete(id);
          if(settlement.kind==='ENROLLED')return complete('SUCCEEDED','MEASURED_FINAL_SETTLED');
          if(completion)await this.scheduler.cancel(profileCompletionAttempt(completion).contract.owner_id,jobId);
          const completed=await this.scheduler.acknowledgeStopped(jobId,leaseToken);
          return complete(completed.status,'MEASURED_FINAL_SETTLED');
        }
      }
    }else{
      // An INTENT_RECORDED row proves no start claim occurred. STARTING without
      // a live owned handle may represent an issued but unobserved start.
      // No launch row at all and no ledger operation (or no ledger row) also proves no start: the reserve never
      // committed, or the host gate refused before any write. Nothing was reserved, so nothing is charged.
      let nothingReserved=false;
      const excluded=await this.locked(jobId,leaseToken,async({intent,ledgerRow})=>{
        const row=intent.find(item=>item.operation_id===operationId);
        if(!row){
          nothingReserved=intent.length===0&&(!ledgerRow||ledgerRow.state.operations.length===0);
          return nothingReserved;
        }
        if(row.state==='STOP_PROVEN')return true;
        if(row.state!=='INTENT_RECORDED')return false;
        await this.db.query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
        return true;
      },{active:false,ledgerOptional:true});
      if(!excluded)return complete('STOPPING','UNCONFIRMED');
      digest=hash(canonical({version:'quant-io-no-start-v1',jobId,operationId}));
      if(nothingReserved){
        this.emergency.delete(id);
        const completed=await this.scheduler.acknowledgeStopped(jobId,leaseToken);
        return complete(completed.status,'NO_START_PROVEN');
      }
    }
    // Fallback: no trusted final readback. Burn allowance and quarantine job.
    const state=await this.ledger.read({jobId,leaseToken});
    const operation=state.operations.find(item=>item.operation_id===operationId);
    if(!operation)throw uncertain();
    let crashed=state;
    if(['RESERVED','ACTIVE','STOP_REQUIRED'].includes(operation.status))
      crashed=await this.ledger.transition({jobId,leaseToken,expectedRevision:state.revision,
        action:'crash',input:{operation_id:operationId,lease_token:leaseToken,
          cgroup_id:operation.cgroup_id,cgroup_inode:operation.cgroup_inode,
          crash_evidence_sha256:digest}});
    if(crashed.operations.find(item=>item.operation_id===operationId)?.status==='CRASHED_UNCONFIRMED')
      await this.ledger.transition({jobId,leaseToken,expectedRevision:crashed.revision,
        action:'acknowledgeCrashStop',input:{operation_id:operationId,lease_token:leaseToken,
          cgroup_id:operation.cgroup_id,cgroup_inode:operation.cgroup_inode,
          stop_proof_sha256:digest}});
    if(handle)await this.locked(jobId,leaseToken,async({intent})=>{
      const row=intent.find(item=>item.operation_id===operationId);
      if(!row||!['STARTING','SPAWNED','RELEASED','STOP_PROVEN'].includes(row.state))throw uncertain();
      if(row.state!=='STOP_PROVEN')await this.db.query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
    },{active:false});
    this.handles.delete(id);this.emergency.delete(id);
    if(completion)await this.scheduler.cancel(profileCompletionAttempt(completion).contract.owner_id,jobId);
    const completed=await this.scheduler.acknowledgeStopped(jobId,leaseToken);
    return complete(completed.status,'UNKNOWN_FINAL_CHARGED');
  }
}
