import {canonical,hash,fail} from '../pine-bridge/source.js';
import {validateProfileResultV2} from '../quant-research/profile-contract-v2.js';
import {QuantIoRuntime,QUANT_PROFILE_RUNTIME_PROTOCOL,quantIoUnitName} from './quant-io-runtime.js';

const uncertain=()=>fail('QUANT_IO_LAUNCH_UNCERTAIN');

/** Internal staging adapter. Constructor callbacks resolve current trusted state. */
export class QuantProfileRuntimeV2 {
  constructor({db,ledger,scheduler,launcher,storageBudget,authorizeRelease,health,clock=Date.now,
    pollMs=100}={}){
    if(!db?.transaction||ledger?.policy?.environment!=='staging'||!scheduler?.cancel||!storageBudget?.root||
      typeof authorizeRelease!=='function'||typeof health!=='function'||
      !Number.isSafeInteger(pollMs)||pollMs<25||pollMs>1000)throw uncertain();
    this.db=db;this.ledger=ledger;this.scheduler=scheduler;this.clock=clock;this.pollMs=pollMs;
    this.io=new QuantIoRuntime({db,ledger,scheduler,launcher,clock,
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

  async run({jobId,leaseToken,operationId,expectedRevision=0,ownerId}){
    const request={jobId,leaseToken,operationId};
    let reserved=false,stop=null,frame=null;
    try{
      const owned=await this.db.transaction(async()=>{
        await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
        const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
        return row?.owner_id===ownerId&&row.lease_token===leaseToken&&row.status==='RUNNING'&&
          row.contract?.version==='quant-foundation-v2'&&row.contract?.kind==='PROFILE'&&
          hash(canonical(row.contract))===row.contract_hash;
      });
      if(!owned)throw uncertain();
      await this.io.reserve({...request,expectedRevision});reserved=true;
      await this.io.start(request);
      await this.io.ready(request);
      await this.io.bind(request);
      await this.io.release(request);
      const handle=this.io.handles.get(jobId+':'+operationId);
      if(!handle?.profileResult||!handle?.accepted)throw uncertain();
      let pending=handle.profileResult.then(value=>({kind:'result',value}),error=>({kind:'error',error}));
      let acceptance=handle.accepted.then(value=>({kind:'accepted',value}),error=>({kind:'error',error}));
      let accepted=false,complete=false,candidate=null,lastHeartbeat=this.clock();
      const receiptDeadline=Date.now()+3000;
      while(!complete){
        const event=await Promise.race([acceptance,pending,
          new Promise(resolve=>setTimeout(()=>resolve(null),this.pollMs))]);
        await this.io.observe(request);
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
    }finally{
      if(reserved){
        const handle=this.io.handles.get(jobId+':'+operationId);
        if(handle)await handle.stop().catch(()=>{});
        try{stop=await this.io.cancel({...request,ownerId});}
        catch{stop={status:'STOPPING',proof:'UNCONFIRMED'};}
      }
    }
    if(stop?.status!=='CANCELLED'||stop?.proof!=='UNKNOWN_FINAL_CHARGED')throw uncertain();
    return Object.freeze({status:'CANCELLED',proof:stop.proof,
      provisional:Object.freeze({jobId,operationId,payloadHash:frame.payloadHash,
        resultHash:frame.resultHash,result:frame.result,evaluator_admission:false})});
  }
}
