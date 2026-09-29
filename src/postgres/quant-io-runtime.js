import {canonical,hash,fail} from '../pine-bridge/source.js';
import path from 'node:path';
import {reserveIoOperation,bindIoOperation,observeIoOperation,getIoStopDecision} from '../quant-research/io-budget-ledger.js';
import {validateFoundationRequestV2} from '../quant-research/foundation-contract-v2.js';

const unavailable=()=>fail('QUANT_IO_ACCOUNTING_UNAVAILABLE');
const lost=()=>fail('QUANT_IO_LEASE_LOST');
const uncertain=()=>fail('QUANT_IO_LAUNCH_UNCERTAIN');
const key=(jobId,operationId)=>jobId+':'+operationId;
export const QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH=hash(canonical({mode:'sleep'}));
export const quantIoUnitName=(jobId,operationId)=>
  'robot-quant-'+hash(canonical({jobId,operationId}))+'.service';
const safe=value=>Number.isSafeInteger(value)&&value>=0;
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
  constructor({db,ledger,scheduler,launcher,clock=Date.now}){
    if(!db?.transaction||!ledger?.open||!scheduler?.cancel||
      !launcher?.spawnPrepared||typeof clock!=='function')throw unavailable();
    this.db=db;this.ledger=ledger;this.scheduler=scheduler;this.launcher=launcher;
    this.clock=clock;this.handles=new Map();this.boundIdentity=new Map();
    this.releaseAllowed=new Set();this.releaseDisabled=new Set();
  }

  async locked(jobId,leaseToken,callback,{active=true}={}){
    if(this.db.isTransaction)throw unavailable();
    try{return await this.db.transaction(async()=>{
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
      if(!ledgerRow||ledgerRow.state_hash!==hash(canonical(ledgerRow.state))||
        ledgerRow.revision!==ledgerRow.state.revision||ledgerRow.lease_token!==leaseToken||
        ledgerRow.policy_hash!==job.contract.capacity.policy_hash||
        ledgerRow.state.lease_token!==leaseToken)throw unavailable();
      if(active&&canonical(ledgerRow.state.devices)!==canonical(this.ledger.devices))throw unavailable();
      const intent=(await this.db.query('SELECT * FROM quant_io_launches WHERE job_id=$1 FOR UPDATE',[jobId])).rows;
      return callback({job,ledgerRow,intent,now});
    });}catch(error){
      if(['QUANT_IO_LEASE_LOST','QUANT_IO_LAUNCH_UNCERTAIN','QUANT_IO_ACCOUNTING_UNAVAILABLE',
        'INVALID_IO_BUDGET_LEDGER'].includes(error?.code))throw error;
      throw unavailable();
    }
  }

  async reserve({jobId,leaseToken,expectedRevision,operationId,allowance}){
    // Initialization has no launch intent. Reserve and intent then commit together.
    await this.ledger.open({jobId,leaseToken});
    return this.locked(jobId,leaseToken,async({ledgerRow,intent,now})=>{
      if(ledgerRow.revision!==expectedRevision||intent.length!==0||
        ledgerRow.state.operations.length!==0)throw uncertain();
      const unitName=quantIoUnitName(jobId,operationId);
      const input={operation_id:operationId,lease_token:leaseToken,
        domain_id:'domain-'+hash(canonical({jobId,operationId})).slice(0,64),
        cgroup_id:unitName,allowance};
      const next=reserveIoOperation(ledgerRow.state,input);
      const update=await this.db.query(`UPDATE quant_io_ledgers SET revision=$2,state=$3,state_hash=$4
        WHERE job_id=$1 AND revision=$5`,[jobId,next.revision,JSON.stringify(next),hash(canonical(next)),expectedRevision]);
      if(update.rowCount!==1)throw uncertain();
      await this.db.query(`INSERT INTO quant_io_launches
        (job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at)
        VALUES($1,$2,$3,$4,$5,'INTENT_RECORDED',$6)`,
        [jobId,operationId,leaseToken,unitName,QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,now]);
      return {state:next,unitName};
    });
  }

  async start({jobId,leaseToken,operationId}){
    const intent=await this.locked(jobId,leaseToken,async({intent})=>{
      const row=intent.find(item=>item.operation_id===operationId);
      if(!row||row.lease_token!==leaseToken||row.state!=='INTENT_RECORDED')throw uncertain();
      await this.db.query("UPDATE quant_io_launches SET state='STARTING' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
      return row;
    });
    let handle=null;
    try{
      await this.locked(jobId,leaseToken,async({intent:rows,job})=>{
        const row=rows.find(item=>item.operation_id===operationId);
        if(!row||row.state!=='STARTING'||row.unit_name!==intent.unit_name||
          row.payload_hash!==QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH)throw uncertain();
        const current=this.clock();
        if(!Number.isSafeInteger(current)||job.lease_until<=current||job.deadline_at<=current)throw lost();
        // No await between final scheduler check and this synchronous spawn.
        handle=this.launcher.spawnPrepared({unitName:row.unit_name});
        if(!handle||handle.payloadHash!==row.payload_hash||
          typeof handle.release!=='function'||typeof handle.stop!=='function')throw uncertain();
        this.handles.set(key(jobId,operationId),handle);
        await this.db.query("UPDATE quant_io_launches SET state='SPAWNED' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
      });
      return {unitName:intent.unit_name};
    }catch(error){
      if(handle)await handle.stop().catch(()=>{});
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

  async ready({jobId,operationId}){
    const handle=this.handles.get(key(jobId,operationId));
    if(!handle?.ready)throw uncertain();
    try{return await handle.ready;}
    catch(error){await handle.stop().catch(()=>{});throw error;}
  }

  async cancel({ownerId,jobId,leaseToken,operationId}){
    const stoppedJob=await this.scheduler.cancel(ownerId,jobId);
    if(stoppedJob.status!=='STOPPING'||stoppedJob.lease_token!==leaseToken)throw lost();
    const handle=this.handles.get(key(jobId,operationId));
    let digest;
    if(handle){
      const proof=await handle.stop();
      if(proof?.unitName!==quantIoUnitName(jobId,operationId)||proof.launcherClosed!==true||
        proof.startRegistered!==true||proof.pendingStartsExcluded!==true||proof.unitStopped!==true)
        return {status:'STOPPING',proof:'UNCONFIRMED'};
      digest=hash(canonical({version:'quant-io-stop-proof-v1',jobId,operationId,
        unitName:proof.unitName,launcherClosed:true,startRegistered:true,
        pendingStartsExcluded:true,unitStopped:true}));
    }else{
      // An INTENT_RECORDED row proves no start claim occurred. STARTING without
      // a live owned handle may represent an issued but unobserved start.
      const excluded=await this.locked(jobId,leaseToken,async({intent})=>{
        const row=intent.find(item=>item.operation_id===operationId);
        if(!row)return false;
        if(row.state==='STOP_PROVEN')return true;
        if(row.state!=='INTENT_RECORDED')return false;
        await this.db.query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1 AND operation_id=$2",[jobId,operationId]);
        return true;
      },{active:false});
      if(!excluded)return {status:'STOPPING',proof:'UNCONFIRMED'};
      digest=hash(canonical({version:'quant-io-no-start-v1',jobId,operationId}));
    }
    // No post-exit cgroup readback exists yet. Burn allowance and quarantine job.
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
    this.handles.delete(key(jobId,operationId));
    const completed=await this.scheduler.acknowledgeStopped(jobId,leaseToken);
    return {status:completed.status,proof:'UNKNOWN_FINAL_CHARGED'};
  }
}
