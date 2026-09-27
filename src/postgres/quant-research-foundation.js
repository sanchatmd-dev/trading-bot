import {canonical,hash,fail} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {QuantFoundationScheduler} from './quant-foundation-scheduler.js';
import {QuantResearchWorker} from './quant-research-worker.js';
import {runQuantProcess,stopQuantUnit} from '../quant-research/process-supervisor.js';

const identity=(contract,parameters,kind)=>hash(canonical({contract,parameters,kind}));

/** Opt-in adapter for the existing research workflow. Scheduler owns the global
 * slot; completed research steps retain their original immutable result schema.
 */
export class QuantResearchFoundationWorker extends QuantResearchWorker {
 constructor({service,health,evaluateChunk,supervisor=runQuantProcess,stopUnit=stopQuantUnit,clock=Date.now,leaseMs=30000,python,limits,allowUnsupportedPlatformForTests=false}){
  super({service,clock,leaseMs});
  if(!service.foundation||typeof health!=='function')throw fail('RESEARCH_FOUNDATION_CALLBACKS_REQUIRED');
  this.supervisor=supervisor;this.stopUnit=stopUnit;this.evaluateChunk=evaluateChunk;this.python=python;this.limits=limits;this.allowUnsupportedPlatformForTests=allowUnsupportedPlatformForTests;this.stopped=new Set();this.activeLaunches=new Set();
  this.scheduler=new QuantFoundationScheduler({db:this.db,clock,leaseMs,health,authorize:(owner,request,action,context)=>this.authorize(owner,request,action,context)});
 }
 async authorize(owner,request,action,context){
  const row=(await this.db.query('SELECT q.* FROM quant_jobs q JOIN quant_research_foundation r ON r.run_id=q.run_id JOIN quant_foundation_jobs f ON f.job_id=r.job_id WHERE f.contract_hash=$1 AND q.owner_id=$2',[hash(canonical(request)),owner])).rows[0];
  if(!row||row.contract.execution_backend!=='quant-foundation-v1')return {ok:false};
  if(action==='ACKNOWLEDGE_STOPPED'){const key=context.job_id+':'+context.lease_token;return {ok:this.stopped.has(key)&&!this.activeLaunches.has(key)};}
  if(hash(canonical(row.contract))!==row.contract_hash||row.contract.engine_hash!==request.engine_hash||row.contract.baseline_snapshot_hash!==request.snapshot_hash||canonical(row.contract.dataset.references.raw)!==canonical(request.dataset))return {ok:false};
  if(!this.db.isTransaction)return {ok:false};
  // Match policy/membership/funding writers and retain these locks through the
  // scheduler mutation, so freshness cannot change between check and commit.
  await this.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.owner_id]);
  if(row.bot_id!==row.owner_id)await this.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.bot_id]);
  try{await this.current(row);if(await this.engineHash()!==request.engine_hash)return {ok:false};return {ok:true};}catch{return {ok:false};}
 }
 async reconcile(){
  const rows=(await this.db.query("SELECT f.* FROM quant_foundation_jobs f JOIN quant_research_foundation r ON r.job_id=f.job_id WHERE f.status='STOPPING'")).rows;
  for(const row of rows){
   const units=(await this.db.query('SELECT unit_name FROM quant_research_chunks WHERE run_id=$1 AND unit_token=$2 AND unit_name IS NOT NULL',[String(row.job_id),row.lease_token])).rows;
   // Stopping a persisted unit cannot prove an old launcher will never register
   // it later. Cold recovery therefore stays quarantined until offline recovery.
   for(const unit of units){try{await this.stopUnit(unit.unit_name);}catch{/* Keep the slot quarantined. */}}
   const key=row.job_id+':'+row.lease_token;
   if(!this.stopped.has(key)||this.activeLaunches.has(key))continue;
   try{await this.scheduler.acknowledgeStopped(row.job_id,row.lease_token);}catch{/* A newer token or another supervisor wins. */}
   finally{this.stopped.delete(key);}
  }
  await this.syncTerminal();
 }
 async syncTerminal(){
  await this.db.transaction(async()=>{
   await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
   await this.db.query("UPDATE quant_jobs q SET status=CASE WHEN f.deadline_at<=$1 THEN 'TIMED_OUT' ELSE 'FAILED' END,diagnostic=COALESCE(f.diagnostic,CASE WHEN f.deadline_at<=$1 THEN 'JOB_DEADLINE_EXCEEDED' ELSE 'FOUNDATION_CANCELLED' END),lease_token=NULL,lease_until=0,updated_at=$1 FROM quant_research_foundation r JOIN quant_foundation_jobs f ON f.job_id=r.job_id WHERE q.run_id=r.run_id AND q.status IN ('QUEUED','RUNNING') AND f.status='CANCELLED'",[this.clock()]);
  });
 }
 async claim(){
  await this.service.executorMode();
  await this.reconcile();
  const foundation=await this.scheduler.claim('research-foundation');await this.syncTerminal();if(!foundation){await this.reconcile();return null;}
  // This live worker owns a new token and has not launched a process for it.
  this.stopped.add(foundation.job_id+':'+foundation.lease_token);
  const row=(await this.db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[String(foundation.job_id)])).rows[0];
  if(!row)throw fail('RESEARCH_FOUNDATION_BINDING_MISSING');
  await this.scheduler.fenced(foundation,'CHECKPOINT',async()=>{await this.db.query("UPDATE quant_jobs SET status='RUNNING',attempt=$2,lease_token=$3,lease_until=$4,updated_at=$5 WHERE run_id=$1",[row.run_id,foundation.attempts,foundation.lease_token,foundation.lease_until,this.clock()]);return foundation;});
  return {...row,status:'RUNNING',lease_token:foundation.lease_token,attempt:foundation.attempts,foundation};
 }
 async fenced(job,callback){return this.scheduler.fenced(job.foundation,'CHECKPOINT',async()=>{
  const row=(await this.db.query('SELECT * FROM quant_jobs WHERE run_id=$1 FOR UPDATE',[job.run_id])).rows[0];
  if(!row||row.status!=='RUNNING'||row.lease_token!==job.lease_token)throw fail('RESEARCH_LEASE_LOST');
  return callback(row);
 });}
 async step(job,id,kind,parameters){
  const saved=(await this.steps(job)).find(row=>row.step_id===id);
  if(saved){if(saved.kind!==kind||canonical(saved.parameters)!==canonical(parameters))throw fail('CHECKPOINT_PARAMETER_MISMATCH');return saved.result;}
  const digest=identity(job.contract,parameters,kind);
  let chunk=(await this.db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',[job.run_id,id])).rows[0];
  if(chunk&&(chunk.identity_hash!==digest||chunk.kind!==kind||canonical(chunk.parameters)!==canonical(parameters)))throw fail('CHECKPOINT_PARAMETER_MISMATCH');
  if(chunk?.checkpoint&&(hash(canonical(chunk.checkpoint))!==chunk.checkpoint_hash||chunk.checkpoint.next_bar!==chunk.next_bar))throw fail('RESEARCH_CHECKPOINT_CORRUPT');
  if(!chunk)await this.fenced(job,async row=>{
   if(row.evaluations_started>=job.contract.max_evaluations)throw fail('EVALUATION_BUDGET_EXCEEDED');
   await this.db.query('INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,$2,$3,$4,$5)',[job.run_id,id,kind,JSON.stringify(parameters),digest]);
   await this.db.query('UPDATE quant_jobs SET evaluations_started=evaluations_started+1,phase=$2,updated_at=$3 WHERE run_id=$1',[job.run_id,kind,this.clock()]);
  });
  chunk??={next_bar:0,checkpoint:null};
  const end=kind==='HOLDOUT'?job.contract.split.test_end:job.contract.split.validation_end;
  while(chunk.next_bar<end){
   const until=Math.min(end,chunk.next_bar+job.foundation.contract.budget.chunk_bars),rows=[];
   for await(const row of this.service.datasetStore.read(job.contract.dataset.references,{start:chunk.next_bar,end:until,signal:this.controller.signal}))rows.push(row);
   const unitName='robot-quant-'+job.run_id+'-'+hash(id).slice(0,8)+'-'+job.lease_token+'.service';
   const key=job.foundation.job_id+':'+job.lease_token;
   this.stopped.delete(key);this.activeLaunches.add(key);let launched=false,answer;
   const payload={contract:job.contract,parameters,kind,rows,checkpoint:chunk.checkpoint};
   try{
    await this.fenced(job,async()=>{await this.db.query('UPDATE quant_research_chunks SET unit_name=$3,unit_token=$4 WHERE run_id=$1 AND step_id=$2',[job.run_id,id,unitName,job.lease_token]);});
    launched=true;
    answer=this.evaluateChunk?await this.evaluateChunk(payload,this.controller.signal):await this.supervisor({payload,module:'robot_quant.research_chunk',signal:this.controller.signal,python:this.python,timeoutMs:Math.min(30000,Math.max(100,job.deadline-this.clock())),limits:this.limits,unitName,allowUnsupportedPlatformForTests:this.allowUnsupportedPlatformForTests});
    this.stopped.add(key);
   }catch(error){if(!launched||error.stopped===true)this.stopped.add(key);throw error;}
   finally{this.activeLaunches.delete(key);}
   const checkpoint=answer?.checkpoint;
   if(!checkpoint||checkpoint.version!=='research-chunk-v1'||!(/^[a-f0-9]{64}$/).test(checkpoint.identity)||!(/^[a-f0-9]{64}$/).test(checkpoint.integrity)||checkpoint.next_bar!==until||checkpoint.last_time!==rows.at(-1).time||(chunk.checkpoint&&checkpoint.identity!==chunk.checkpoint.identity)||Buffer.byteLength(JSON.stringify(checkpoint))>job.foundation.contract.budget.max_state_bytes)throw fail('INVALID_RESEARCH_CHUNK_RESPONSE');
   if((until===end)!==Boolean(answer.result))throw fail('INVALID_RESEARCH_CHUNK_RESPONSE');
   if(answer.result)this.validateResult(answer.result,parameters,kind);
   await this.fenced(job,async()=>{
    await this.db.query('UPDATE quant_research_chunks SET next_bar=$3,checkpoint=$4,checkpoint_hash=$5,unit_name=NULL,unit_token=NULL WHERE run_id=$1 AND step_id=$2',[job.run_id,id,until,JSON.stringify(checkpoint),hash(canonical(checkpoint))]);
    if(answer.result)await this.db.prepare('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES(?,?,?,?,?,?)').run(job.run_id,id,kind,JSON.stringify(parameters),JSON.stringify(answer.result),this.clock());
   });
   chunk={next_bar:until,checkpoint};
   if(answer.result)return answer.result;
  }
  throw fail('RESEARCH_CHUNK_RESULT_MISSING');
 }
 validateResult(result,parameters,kind){
  if(canonical(result.parameters)!==canonical(parameters)||result.kind!==kind||!result.train||!result.validation||(kind!=='HOLDOUT'&&Object.hasOwn(result,'test')))throw fail('INVALID_EVALUATION_RESPONSE');
  for(const metrics of [result.train,result.validation,...(kind==='HOLDOUT'?[result.test]:[])]){
   if(!metrics||!Number.isSafeInteger(metrics.closed_trades)||metrics.closed_trades<0)throw fail('INVALID_EVALUATION_RESPONSE');
   for(const key of ['net_return_percent','max_drawdown_percent']){if(!['string','number'].includes(typeof metrics[key])||!D(metrics[key]).isFinite()||(key==='max_drawdown_percent'&&D(metrics[key]).lt(0)))throw fail('INVALID_EVALUATION_RESPONSE');}
  }
 }
 async finish(job,status,result,diagnostic=null){
  if(Buffer.byteLength(JSON.stringify(result))>job.foundation.contract.budget.max_output_bytes)throw fail('FOUNDATION_OUTPUT_TOO_LARGE');
  await this.scheduler.fenced(job.foundation,'FINISH',async(row,now)=>{
   const q=(await this.db.query('SELECT * FROM quant_jobs WHERE run_id=$1 FOR UPDATE',[job.run_id])).rows[0];
   if(q.status!=='RUNNING'||q.lease_token!==job.lease_token)throw fail('RESEARCH_LEASE_LOST');
   await this.db.query("UPDATE quant_jobs SET status=$2,phase='COMPLETE',result=$3,diagnostic=$4,lease_token=NULL,lease_until=0,updated_at=$5 WHERE run_id=$1",[job.run_id,status,JSON.stringify(result),diagnostic,now]);
   await this.db.query("UPDATE quant_foundation_jobs SET status='SUCCEEDED',result=$2,runtime_used_ms=runtime_used_ms+GREATEST(0,$3-run_started_at),run_started_at=NULL,lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE job_id=$1",[row.job_id,JSON.stringify({run_id:job.run_id,status,contract_hash:job.contract_hash}),now]);
   await this.service.store.audit(job.owner_id,'quant.research.finished',job.run_id,{status,contract_hash:job.contract_hash});
   return row;
  });
  this.stopped.delete(job.foundation.job_id+':'+job.lease_token);
 }
 async tick(){
  // Publish the controller before claim's awaited health/DB operations so stop()
  // also fences a shutdown requested while no subprocess exists yet.
  const controller=new AbortController();this.controller=controller;
  let job;
  try{job=await this.claim();}catch(error){if(this.controller===controller)this.controller=null;throw error;}
  if(!job){if(this.controller===controller)this.controller=null;return false;}
  let heartbeatTask=null;
  const heartbeat=setInterval(()=>{
   if(heartbeatTask)return;
   heartbeatTask=this.scheduler.heartbeat(job.foundation).catch(()=>controller.abort()).finally(()=>{heartbeatTask=null;});
  },Math.max(10,Math.min(5000,Math.floor(this.leaseMs/3))));
  try{if(controller.signal.aborted)throw fail('RESEARCH_INTERRUPTED');await this.run(job);}catch(error){
   // The supervisor settles only after physical exit. An unconfirmed stop keeps
   // STOPPING reserved for reconciliation of the persisted systemd unit.
   await this.db.transaction(async()=>{
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[job.foundation.job_id])).rows[0];
    if(row.status==='RUNNING'&&row.lease_token===job.lease_token){await this.db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',lease_until=NULL,runtime_used_ms=runtime_used_ms+GREATEST(0,$2-run_started_at),run_started_at=NULL,diagnostic=$3 WHERE job_id=$1",[row.job_id,this.clock(),error.code??'QUANT_WORKER_FAILED']);await this.db.query("UPDATE quant_jobs SET status='FAILED',diagnostic=$2,lease_token=NULL,lease_until=0,updated_at=$3 WHERE run_id=$1 AND status='RUNNING'",[job.run_id,error.code??'QUANT_WORKER_FAILED',this.clock()]);}
   });
   if(error.stopped!==false)await this.reconcile();
  }finally{clearInterval(heartbeat);await heartbeatTask;if(this.controller===controller)this.controller=null;}
  return true;
 }
}
