import {canonical,hash,fail} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {validateBar} from './pine-bridge-market.js';
import {assertQuantStorageOwner} from './quant-storage-retention.js';
import {contentDigest} from '../quant-research/research-contract-v2.js';
import {FIXED_EVAL_VERSIONS,DATASET_BINDING_STEP_ID,DATASET_BINDING_KIND,fixedEvalPendingMetadata,
 fixedEvalBindingParameters,validateFixedEvalBinding,fixedEvalBindingIdentity} from '../quant-research/fixed-eval-contract.js';
import {FIXED_EVAL_STEPS,fixedEvalJobRequest,validateFixedEvalStepResult,buildFixedEvalResult} from '../quant-research/fixed-eval-contract.js';
import {fixedEvalStepIdentity,fixedEvalUnitName,validateFixedEvalRecords} from './quant-fixed-eval.js';
import {fixedEvalClosure} from './quant-fixed-eval-engine.js';

export const isFixedEvalRequest=request=>request?.version===FIXED_EVAL_VERSIONS.request;
const need=(ok,code)=>{if(!ok)throw fail(code);};
// Only application refusals become authorization denial. Database serialization, deadlock, grant and connection
// errors retain their identity; the caller must retry or fail the complete transaction, never continue as a denial.
const authorityRefusal=error=>error instanceof Error&&Number.isInteger(error.status)&&typeof error.code==='string'&&!/^[0-9A-Z]{5}$/.test(error.code);
const actions=Object.freeze({CLAIM:'CLAIM',BIND_FIXED_CLAIM:'CLAIM',HEARTBEAT:'RUN',CHECKPOINT:'RUN',FINISH:'COMMIT'});

/** Two supervised whole evaluations. Interrupted jobs are terminal and never resume an evaluation intent. */
export class QuantFixedEvalRunner{
 constructor({worker,service}){
  if(!worker?.scheduler||!service?.storedRun)throw Error('Fixed evaluation runner requires its foundation worker and service');
  this.worker=worker;this.service=service;this.db=worker.db;
 }
 async authorize(owner,request,action,context={}){
  if(!isFixedEvalRequest(request)||!this.db.isTransaction)return {ok:false};
  if(!Object.hasOwn(actions,action)&&!['CANCEL','ACKNOWLEDGE_STOPPED'].includes(action))return {ok:false};
  try{
   const stop=['CANCEL','ACKNOWLEDGE_STOPPED'].includes(action);
   const resolved=await this.service.storedRun(owner,context.job_id,{request,live:!stop});
   if(action==='ACKNOWLEDGE_STOPPED'){
    const key=context.job_id+':'+context.lease_token;
    return {ok:resolved.foundation.status==='STOPPING'&&resolved.foundation.lease_token===context.lease_token&&
     this.worker.stopped.has(key)&&!this.worker.activeLaunches.has(key)};
   }
   if(action==='CANCEL')return {ok:true};
   if(action==='CLAIM')need(resolved.row.status==='QUEUED'&&resolved.foundation.status==='QUEUED'&&resolved.foundation.attempts===0,'FIXED_EVAL_ATTEMPT_EXHAUSTED');
   else if(action==='BIND_FIXED_CLAIM')need(resolved.row.status==='QUEUED'&&resolved.row.attempt===0&&resolved.row.lease_token===null&&resolved.foundation.status==='RUNNING'&&resolved.foundation.attempts===1,'FIXED_EVAL_LEASE_LOST');
   else need(resolved.row.status==='RUNNING'&&resolved.row.lease_token===resolved.foundation.lease_token&&resolved.row.attempt===resolved.foundation.attempts&&resolved.foundation.attempts===1,'FIXED_EVAL_LEASE_LOST');
   return {ok:true,authority:resolved,action:actions[action]};
  }catch(error){if(authorityRefusal(error))return {ok:false};throw error;}
 }
 binding(contract,row){
  const parameters=validateFixedEvalBinding(contract,row.parameters);
  need(row.step_id===DATASET_BINDING_STEP_ID&&row.kind===DATASET_BINDING_KIND&&row.identity_hash===fixedEvalBindingIdentity(contract,parameters)&&
   row.next_bar===0&&row.checkpoint===null&&row.checkpoint_hash===null&&row.unit_name===null&&row.unit_token===null,'FIXED_EVAL_DATASET_BINDING_INVALID');
  return parameters;
 }
 async authority(job){
  return this.worker.fenced(job,async()=>{
   need(!this.worker.controller?.signal.aborted,'RESEARCH_INTERRUPTED');
   const resolved=await this.service.storedRun(job.owner_id,job.run_id,{request:job.foundation.contract,live:true});
   need(resolved.row.lease_token===job.lease_token&&resolved.foundation.lease_token===job.lease_token&&resolved.row.attempt===job.attempt,'FIXED_EVAL_LEASE_LOST');
   return resolved;
  });
 }
 async prepare(job){
  const signal=this.worker.controller?.signal,aborted=()=>need(!signal?.aborted,'RESEARCH_INTERRUPTED');
  aborted();const resolved=await this.authority(job),contract=resolved.contract;
  const store=this.worker.service.datasetStore;need(!!store,'FIXED_EVAL_DATASET_STORE_REQUIRED');
  await assertQuantStorageOwner(this.db,store.root);aborted();
  const saved=(await this.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 AND step_id=$2',[job.run_id,DATASET_BINDING_STEP_ID])).rows[0];
  if(saved){
   const parameters=this.binding(contract,saved);
   need(parameters.dataset_sha256===resolved.expectedDatasetHash,'FIXED_EVAL_DATASET_SHA_MISMATCH');
   await store.raw.inspect(parameters.references.raw,{signal});await store.sidecar(parameters.references.sidecar,{signal});aborted();
   const latest=await this.authority(job);need(parameters.dataset_sha256===latest.expectedDatasetHash,'FIXED_EVAL_DATASET_SHA_MISMATCH');
   return {...job,dataset_binding:parameters};
  }
  const rows=[],dataset=contract.dataset,model=contract.cost_model;let after=dataset.start_time-1;
  while(rows.length<dataset.bar_count){
   aborted();
   const page=(await this.db.query(`SELECT * FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'
    AND bar_time>$1 AND bar_time<=$2 ORDER BY bar_time LIMIT 1000`,[after,dataset.end_time])).rows;
   if(!page.length)break;
   for(const row of page){
    need(rows.length<dataset.bar_count&&row.bar_time===dataset.start_time+rows.length*60000&&row.bar?.time===row.bar_time&&
     row.provenance?.profile===model.data_profile&&hash(canonical(row.bar))===row.content_hash,'VERIFIED_MARKET_DATA_REQUIRED');
    validateBar(row.bar);need(D(row.bar.price_tick).eq(model.price_tick)&&D(row.bar.quantity_step).eq(model.quantity_step),'MARKET_METADATA_MISMATCH');
    rows.push(row);
   }
   after=page.at(-1).bar_time;
  }
  aborted();need(rows.length===dataset.bar_count,'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
  need(contentDigest(rows)===dataset.content_digest,'FIXED_EVAL_DATASET_CHANGED');
  const datasetSha=hash(canonical(rows.map(row=>({bar:row.bar,content_hash:row.content_hash,provenance:row.provenance}))));
  need(datasetSha===resolved.expectedDatasetHash,'FIXED_EVAL_DATASET_SHA_MISMATCH');
  const references=await store.publish(fixedEvalPendingMetadata(contract),rows.map(row=>row.bar),{model,signal,chunkBars:1000});
  const parameters=fixedEvalBindingParameters(contract,{references,dataset_sha256:datasetSha});aborted();
  await this.worker.fenced(job,async()=>{
   aborted();const latest=await this.service.storedRun(job.owner_id,job.run_id,{request:job.foundation.contract,live:true});
   need(latest.expectedDatasetHash===datasetSha,'FIXED_EVAL_DATASET_SHA_MISMATCH');
   const identity=fixedEvalBindingIdentity(contract,parameters);
   const inserted=await this.db.query(`INSERT INTO public.quant_research_chunks(run_id,step_id,kind,parameters,identity_hash)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,step_id) DO NOTHING RETURNING run_id`,[job.run_id,DATASET_BINDING_STEP_ID,DATASET_BINDING_KIND,JSON.stringify(parameters),identity]);
   if(!inserted.rowCount){
    const existing=(await this.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 AND step_id=$2',[job.run_id,DATASET_BINDING_STEP_ID])).rows[0];
    need(existing&&existing.identity_hash===identity&&canonical(existing.parameters)===canonical(parameters),'FIXED_EVAL_DATASET_BINDING_CONFLICT');this.binding(contract,existing);
   }
  });
  return {...job,dataset_binding:parameters};
 }
 async records(job,complete=false){
  const row=(await this.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1',[job.run_id])).rows[0];
  const chunks=(await this.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1',[job.run_id])).rows;
  const steps=(await this.db.query('SELECT * FROM public.quant_job_steps WHERE run_id=$1',[job.run_id])).rows;
  return validateFixedEvalRecords(job.contract,{chunks,steps,evaluations_started:row.evaluations_started,token:job.lease_token,run_id:job.run_id,complete});
 }
 async step(job,spec){
  const worker=this.worker,signal=worker.controller?.signal,key=job.run_id+':'+job.lease_token;
  const unit=fixedEvalUnitName(job.run_id,spec.step_id,job.lease_token);
  // This set is established before the first asynchronous opportunity to register or start a unit.
  worker.activeLaunches.add(key);worker.stopped.delete(key);let launched=false;
  try{
   const authority=await this.authority(job);need(job.dataset_binding.dataset_sha256===authority.expectedDatasetHash,'FIXED_EVAL_DATASET_SHA_MISMATCH');
   const rows=[];for await(const row of worker.service.datasetStore.read(job.dataset_binding.references,{signal}))rows.push(row);
   const payload=fixedEvalJobRequest(job.contract,job.dataset_binding,spec.kind,rows);
   await worker.fenced(job,async row=>{
    need(!signal?.aborted,'RESEARCH_INTERRUPTED');await this.records(job);
    need(row.evaluations_started<2,'EVALUATION_BUDGET_EXCEEDED');
    await this.db.query('INSERT INTO public.quant_research_chunks(run_id,step_id,kind,parameters,identity_hash,unit_name,unit_token) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [job.run_id,spec.step_id,spec.kind,JSON.stringify(job.contract.parameters),fixedEvalStepIdentity(job.contract,spec.kind),unit,job.lease_token]);
    await this.db.query('UPDATE public.quant_jobs SET evaluations_started=evaluations_started+1,phase=$2,updated_at=$3 WHERE run_id=$1',[job.run_id,spec.step_id,worker.clock()]);
   });
   await assertQuantStorageOwner(this.db,worker.service.datasetStore.root);
   await this.authority(job);need(!signal?.aborted,'RESEARCH_INTERRUPTED');
   const timeoutMs=Math.min(30000,job.deadline-worker.clock());need(timeoutMs>=100,'JOB_DEADLINE_EXCEEDED');
   launched=true;
   const answer=await worker.supervisor({payload,module:'robot_quant.fixed_eval_job',signal,python:worker.python,timeoutMs,limits:worker.limits,
    ioControls:worker.ioControls,ioTerminalProtocol:worker.ioControls?'quant-io-terminal-v1':undefined,
    storageBudget:worker.ioControls?worker.service.storageBudget:undefined,unitName:unit,allowUnsupportedPlatformForTests:worker.allowUnsupportedPlatformForTests});
   worker.stopped.add(key);
   need(answer&&Object.keys(answer).sort().join(',')==='checkpoint,result'&&answer.checkpoint===null,'FIXED_EVAL_STEP_RESPONSE_INVALID');
   const result=validateFixedEvalStepResult(job.contract,job.dataset_binding,spec.kind,answer.result);
   await worker.fenced(job,async()=>{
    need(!signal?.aborted,'RESEARCH_INTERRUPTED');await this.service.storedRun(job.owner_id,job.run_id,{request:job.foundation.contract,live:true});
    const cleared=await this.db.query('UPDATE public.quant_research_chunks SET unit_name=NULL,unit_token=NULL WHERE run_id=$1 AND step_id=$2 AND unit_name=$3 AND unit_token=$4',[job.run_id,spec.step_id,unit,job.lease_token]);
    need(cleared.rowCount===1,'FIXED_EVAL_LEASE_LOST');
    await this.db.query('INSERT INTO public.quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
     [job.run_id,spec.step_id,spec.kind,JSON.stringify(job.contract.parameters),JSON.stringify(result),worker.clock()]);
   });
   return result;
  }catch(error){if(!launched||error.stopped===true)worker.stopped.add(key);throw error;}
  finally{worker.activeLaunches.delete(key);}
 }
 async run(job){
  const authority=await this.authority(job);need(authority.row.evaluations_started===0,'FIXED_EVAL_RESTART_REFUSED');
  job=await this.prepare(job);
  for(const spec of FIXED_EVAL_STEPS)await this.step(job,spec);
  const closure=await fixedEvalClosure();need(closure.hash===job.contract.engine_hash,'QUANT_ENGINE_CHANGED');
  await this.worker.scheduler.fenced(job.foundation,'FINISH',async(f,now)=>{
   need(!this.worker.controller?.signal.aborted,'RESEARCH_INTERRUPTED');
   await this.service.storedRun(job.owner_id,job.run_id,{request:job.foundation.contract,live:true});
   const records=await this.records(job,true),result=buildFixedEvalResult(job.contract,records.binding,records.results,closure);
   need(Buffer.byteLength(JSON.stringify(result))<=f.contract.budget.max_output_bytes,'FOUNDATION_OUTPUT_TOO_LARGE');
   await this.db.query("UPDATE public.quant_jobs SET status='SUCCEEDED',phase='COMPLETE',result=$2,diagnostic=NULL,lease_token=NULL,lease_until=0,updated_at=$3 WHERE run_id=$1",[job.run_id,JSON.stringify(result),now]);
   await this.db.query("UPDATE public.quant_foundation_jobs SET status='SUCCEEDED',result=$2,runtime_used_ms=runtime_used_ms+GREATEST(0,$3-run_started_at),run_started_at=NULL,lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE job_id=$1",[job.run_id,JSON.stringify({run_id:job.run_id,contract_hash:job.contract_hash,result_hash:hash(canonical(result))}),now]);
  });
  this.worker.stopped.delete(job.run_id+':'+job.lease_token);
 }
 async failed(job,error){
  await this.worker.scheduler.transaction(async()=>{
   await this.worker.scheduler.lock();const row=await this.worker.scheduler.row(job.run_id);
   if(row?.status==='RUNNING'&&row.lease_token===job.lease_token)await this.db.query("UPDATE public.quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',diagnostic=COALESCE(diagnostic,$2),lease_until=NULL,runtime_used_ms=runtime_used_ms+GREATEST(0,$3-run_started_at),run_started_at=NULL WHERE job_id=$1",[job.run_id,error.code??'FIXED_EVAL_FAILED',this.worker.clock()]);
  });
  await this.reconcile(job.foundation);
 }
 async reconcile(row){
  const key=row.job_id+':'+row.lease_token;
  if(!this.worker.stopped.has(key)||this.worker.activeLaunches.has(key))return false;
  const capture=async()=>{
   await this.worker.scheduler.lock();const current=await this.worker.scheduler.row(row.job_id);
   if(current?.status!=='STOPPING'||current.lease_token!==row.lease_token)return null;
   const resolved=await this.service.storedRun(row.owner_id,row.job_id,{request:row.contract});
   const saved=(await this.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1 ORDER BY step_id',[String(row.job_id)])).rows;
   const steps=(await this.db.query('SELECT * FROM public.quant_job_steps WHERE run_id=$1 ORDER BY step_id',[String(row.job_id)])).rows;
   validateFixedEvalRecords(resolved.contract,{chunks:saved,steps,evaluations_started:resolved.row.evaluations_started,token:row.lease_token,run_id:String(row.job_id)});
   need(['QUEUED','RUNNING'].includes(resolved.row.status),'FIXED_EVAL_RECORDS_INVALID');
   return {foundation:current,row:resolved.row,chunks:saved,steps};
  };
  // Validate deterministic run/step/token identity before passing any stored name to the supervisor.
  const before=await this.worker.scheduler.transaction(capture);if(!before)return false;
  for(const chunk of before.chunks.filter(item=>item.unit_name!==null))if(await this.worker.stopUnit(chunk.unit_name)!==true)return false;
  await this.worker.scheduler.transaction(async()=>{
   const after=await capture();
   need(after&&canonical(after)===canonical(before),'FIXED_EVAL_STOP_EVIDENCE_CHANGED');
   need(this.worker.stopped.has(key)&&!this.worker.activeLaunches.has(key),'FIXED_EVAL_LEASE_LOST');
   await this.db.query('UPDATE public.quant_research_chunks SET unit_name=NULL,unit_token=NULL WHERE run_id=$1 AND unit_token=$2',[String(row.job_id),row.lease_token]);
  });
  await this.worker.scheduler.acknowledgeStopped(row.job_id,row.lease_token);this.worker.stopped.delete(key);return true;
 }
}
