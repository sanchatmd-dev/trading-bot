import {canonical,hash,fail} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {QuantFoundationScheduler} from './quant-foundation-scheduler.js';
import {QuantResearchWorker} from './quant-research-worker.js';
import {runQuantProcess,stopQuantUnit} from '../quant-research/process-supervisor.js';
import {readSpotHistory} from '../quant-research/spot-ingestion.js';
import {planIngestionRange} from '../quant-research/ingestion-range.js';
import {validateBackfillState} from '../quant-research/foundation-contract.js';
import {buildProfile,authorizeProfileV2Stop} from './quant-profile.js';
import {assertQuantStorageOwner} from './quant-storage-retention.js';
import {canReleaseQuantIo,QUANT_IO_DIAGNOSTIC_REASONS} from './quant-io-runtime.js';
import {validateBar} from './pine-bridge-market.js';
import {resolveHistoricalPreflight} from '../quant-research/preflight-resolver.js';
import {runHistoricalPreflight} from '../quant-research/preflight-replay.js';
import {createSupervisedRunner} from '../quant-research/preflight-runtime.js';
import {RESEARCH_V2_VERSIONS,DATASET_BINDING_STEP_ID,DATASET_BINDING_KIND,
 validateResearchContractV2,validateFoundationResearchRequestV2,contentDigest,pendingMetadata,
 datasetBindingParameters,validateDatasetBindingV1,materializeExecutionContract,
 datasetBindingIdentity} from '../quant-research/research-contract-v2.js';

const identity=(contract,parameters,kind)=>hash(canonical({contract,parameters,kind}));

/** Reason allowlist of the PROFILE V2 terminal log: the I/O diagnostic reasons plus the worker's own PROFILE reasons. */
export const QUANT_PROFILE_TERMINAL_LOG_REASONS=Object.freeze([...QUANT_IO_DIAGNOSTIC_REASONS,'PROFILE_STOP_REQUESTED',
 'PROFILE_COMPUTE_DEADLINE','QUANT_PROFILE_POLICY_MISMATCH','QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED','PROFILE_DEADLINE_NEAR',
 'PROFILE_V2_DISABLED']);

/** Smallest PG_POOL_SIZE of a worker with health recovery, for every job kind. The recovery probe runs through
 * db.pool.query, so it needs a connection outside the scheduler transaction that called health. Peak demand of a running
 * job: the runtime lock (1); a scheduler transaction that holds the scheduler lock while it awaits the probe, the tick
 * heartbeat or, in PROFILE V2, observe and the frame-loop heartbeat (2); one more scheduler transaction that waits for that
 * lock on its own connection, such as BACKFILL beforePage, checkpoint and finish, PREFLIGHT persistUnit, checkpoint and
 * finish, PROFILE V1 finish, legacy research steps, or the V2 heartbeat itself (3); the probe connection (4). With 3 the
 * probe starves and health reads UNKNOWN: the heartbeat quarantines the job (HEALTH_UNAVAILABLE) or the V2 observe fails. */
export const QUANT_HEALTH_RECOVERY_MINIMUM_POOL=4;
export function assertQuantHealthRecoveryPool({recoveryEnabled,poolMax}={}){
 if(recoveryEnabled===false)return;
 if(!(poolMax>=QUANT_HEALTH_RECOVERY_MINIMUM_POOL))throw Error('Health recovery requires PG_POOL_SIZE at least '+
  QUANT_HEALTH_RECOVERY_MINIMUM_POOL+' for runtime lock, two scheduler transactions and independent probe');
}

/** Opt-in adapter for the existing research workflow. Scheduler owns the global
 * slot; completed research steps retain their original immutable result schema.
 */
export class QuantResearchFoundationWorker extends QuantResearchWorker {
 constructor({service,dataService,profileService,preflightService,health,evaluateChunk,fetchHistory=readSpotHistory,supervisor=runQuantProcess,stopUnit=stopQuantUnit,clock=Date.now,leaseMs=30000,python,limits,ioControls,allowUnsupportedPlatformForTests=false,profileV2Enabled=false,capacityPolicy,profileRuntimeV2,terminalLog=line=>console.info(line)}){
  super({service,clock,leaseMs});
  if(!service.foundation||typeof health!=='function')throw fail('RESEARCH_FOUNDATION_CALLBACKS_REQUIRED');
  this.dataService=dataService;this.fetchHistory=fetchHistory;this.supervisor=supervisor;this.stopUnit=stopUnit;this.evaluateChunk=evaluateChunk;this.python=python;this.limits=limits;this.ioControls=ioControls;this.allowUnsupportedPlatformForTests=allowUnsupportedPlatformForTests;this.stopped=new Set();this.activeLaunches=new Set();
  this.profileV2Enabled=profileV2Enabled===true;this.capacityPolicy=capacityPolicy;this.profileRuntimeV2=profileRuntimeV2;
  this.profileOperations=new Map();
  this.terminalLog=terminalLog;
  this.scheduler=new QuantFoundationScheduler({db:this.db,clock,leaseMs,health,capacityPolicy,profileV2Enabled:this.profileV2Enabled,
   canRelease:this.profileV2Enabled?row=>canReleaseQuantIo(this.db,row):undefined,
   authorize:(owner,request,action,context)=>this.authorize(owner,request,action,context)});
  this.profileService=profileService;
  this.preflightService=preflightService;
 }
 async authorize(owner,request,action,context){
  if(request.kind==='PREFLIGHT')return this.preflightService?.authorize(owner,request,action,
   {...context,stopped:this.stopped.has(context.job_id+':'+context.lease_token)&&!this.activeLaunches.has(context.job_id+':'+context.lease_token)})??{ok:false};
  // The stop acknowledgement needs durable proof only, so it never depends on the profile service being wired.
  // It shares the service's single authority, which also checks the stored contract and its hash.
  if(request.kind==='PROFILE'&&request.version==='quant-foundation-v2'&&action==='ACKNOWLEDGE_STOPPED')
   return authorizeProfileV2Stop(this.db,owner,request,context);
  if(request.kind==='PROFILE')return this.profileService?.authorize(owner,request,action,
   {...context,stopped:this.stopped.has(context.job_id+':'+context.lease_token)&&!this.activeLaunches.has(context.job_id+':'+context.lease_token)})??{ok:false};
  if(request.kind==='BACKFILL')return this.dataService?.authorize(owner,request,action,
   {...context,stopped:this.stopped.has(context.job_id+':'+context.lease_token)&&!this.activeLaunches.has(context.job_id+':'+context.lease_token)})??{ok:false};
  const row=(await this.db.query('SELECT q.* FROM quant_jobs q JOIN quant_research_foundation r ON r.run_id=q.run_id JOIN quant_foundation_jobs f ON f.job_id=r.job_id WHERE f.contract_hash=$1 AND q.owner_id=$2',[hash(canonical(request)),owner])).rows[0];
  if(!row||row.contract.execution_backend!=='quant-foundation-v1')return {ok:false};
  if(action==='ACKNOWLEDGE_STOPPED'){const key=context.job_id+':'+context.lease_token;return {ok:this.stopped.has(key)&&!this.activeLaunches.has(key)};}
  try{
   if(row.contract.version!==RESEARCH_V2_VERSIONS.contract||request.version!==RESEARCH_V2_VERSIONS.request||
      hash(canonical(row.contract))!==row.contract_hash)return {ok:false};
   validateResearchContractV2(row.contract);
   validateFoundationResearchRequestV2(request,row.contract);
  }catch{return {ok:false};}
  if(!this.db.isTransaction)return {ok:false};
  // Match policy/membership/funding writers and retain these locks through the
  // scheduler mutation, so freshness cannot change between check and commit.
  await this.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.owner_id]);
  if(row.bot_id!==row.owner_id)await this.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.bot_id]);
  try{await this.current(row);if(await this.engineHash()!==request.engine_hash)return {ok:false};return {ok:true};}catch{return {ok:false};}
 }
 async reconcile(){
  const preflights=(await this.db.query("SELECT * FROM quant_foundation_jobs WHERE contract->>'kind'='PREFLIGHT' AND status='STOPPING'")).rows;
  for(const row of preflights){
   const binding=(await this.db.query('SELECT unit_name,unit_token FROM quant_preflight_jobs WHERE job_id=$1',[row.job_id])).rows[0];
   if(!binding||(binding.unit_name!==null&&binding.unit_token!==row.lease_token)||
      (binding.unit_name===null&&binding.unit_token!==null))continue;
   const units=binding.unit_name?[binding]:[];
   let allStopped=true;
   for(const unit of units){try{if(await this.stopUnit(unit.unit_name)!==true)allStopped=false;}catch{allStopped=false;}}
   const key=row.job_id+':'+row.lease_token;
   // A cold worker cannot prove that the old launcher will never register a unit.
   if(!allStopped||!this.stopped.has(key)||this.activeLaunches.has(key))continue;
   try{
    await this.db.transaction(async()=>{
     await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
     const current=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[row.job_id])).rows[0];
     if(current?.status!=='STOPPING'||current.lease_token!==row.lease_token)throw fail('FOUNDATION_LEASE_LOST');
     await this.db.query('UPDATE quant_preflight_jobs SET unit_name=NULL,unit_token=NULL WHERE job_id=$1 AND unit_token=$2',[row.job_id,row.lease_token]);
    });
    await this.scheduler.acknowledgeStopped(row.job_id,row.lease_token);
    this.stopped.delete(key);
   }catch{/* Keep the slot quarantined until stop proof and token match. */}
  }
  const backfills=(await this.db.query("SELECT * FROM quant_foundation_jobs WHERE contract->>'kind' IN ('BACKFILL','PROFILE') AND status='STOPPING'")).rows;
  for(const row of backfills){
   if(row.contract.version==='quant-foundation-v2'&&row.contract.kind==='PROFILE'){
    // Durable proof survives process restart. The scheduler repeats this check under its lock.
    if(!this.profileV2Enabled)continue;
    try{if((await canReleaseQuantIo(this.db,row)).ok)await this.scheduler.acknowledgeStopped(row.job_id,row.lease_token);}catch{}
    continue;
   }
   const key=row.job_id+':'+row.lease_token;
   if(!this.stopped.has(key)||this.activeLaunches.has(key))continue;
   try{await this.scheduler.acknowledgeStopped(row.job_id,row.lease_token);}catch{/* Cold recovery or newer token owns transition. */}
   finally{this.stopped.delete(key);}
  }
  const rows=(await this.db.query("SELECT f.* FROM quant_foundation_jobs f JOIN quant_research_foundation r ON r.job_id=f.job_id WHERE f.status='STOPPING'")).rows;
  for(const row of rows){
   const units=(await this.db.query('SELECT unit_name FROM quant_research_chunks WHERE run_id=$1 AND unit_token=$2 AND unit_name IS NOT NULL',[String(row.job_id),row.lease_token])).rows;
   // Stopping a persisted unit cannot prove an old launcher will never register
   // it later. Cold recovery therefore stays quarantined until offline recovery.
   let allStopped=true;
   for(const unit of units){try{if(await this.stopUnit(unit.unit_name)!==true)allStopped=false;}catch{allStopped=false;}}
   const key=row.job_id+':'+row.lease_token;
   if(!allStopped||!this.stopped.has(key)||this.activeLaunches.has(key))continue;
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
  if(!(foundation.contract.kind==='PROFILE'&&foundation.contract.version==='quant-foundation-v2'))
   this.stopped.add(foundation.job_id+':'+foundation.lease_token);
  if(foundation.contract.kind==='BACKFILL')return {kind:'BACKFILL',foundation};
  if(foundation.contract.kind==='PROFILE')return {kind:'PROFILE',foundation};
  if(foundation.contract.kind==='PREFLIGHT')return {kind:'PREFLIGHT',foundation};
  const row=(await this.db.query('SELECT * FROM quant_jobs WHERE run_id=$1',[String(foundation.job_id)])).rows[0];
  if(!row)throw fail('RESEARCH_FOUNDATION_BINDING_MISSING');
  let phase=row.phase;
  await this.scheduler.fenced(foundation,'CHECKPOINT',async()=>{
   if(row.contract.version===RESEARCH_V2_VERSIONS.contract){
    const binding=(await this.db.query('SELECT step_id FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',
     [row.run_id,DATASET_BINDING_STEP_ID])).rows[0];
    if(!binding)phase='PREPARE';
   }
   await this.db.query("UPDATE quant_jobs SET status='RUNNING',attempt=$2,lease_token=$3,lease_until=$4,updated_at=$5,phase=$6 WHERE run_id=$1",
    [row.run_id,foundation.attempts,foundation.lease_token,foundation.lease_until,this.clock(),phase]);
   return foundation;
  });
  return {...row,status:'RUNNING',phase,lease_token:foundation.lease_token,attempt:foundation.attempts,foundation};
 }
 async fenced(job,callback){return this.scheduler.fenced(job.foundation,'CHECKPOINT',async()=>{
  const row=(await this.db.query('SELECT * FROM quant_jobs WHERE run_id=$1 FOR UPDATE',[job.run_id])).rows[0];
  if(!row||row.status!=='RUNNING'||row.lease_token!==job.lease_token)throw fail('RESEARCH_LEASE_LOST');
  return callback(row);
 });}
 async run(job){return super.run(await this.prepareResearch(job));}
 datasetBinding(contract,row){
  try{
   const parameters=validateDatasetBindingV1(contract,row.parameters);
   if(row.kind!==DATASET_BINDING_KIND||row.identity_hash!==datasetBindingIdentity(contract,parameters)||
      row.next_bar!==0||row.checkpoint!==null||row.checkpoint_hash!==null||
      row.unit_name!==null||row.unit_token!==null)throw fail('RESEARCH_DATASET_BINDING_INVALID');
   return parameters;
  }catch{throw fail('RESEARCH_DATASET_BINDING_INVALID');}
 }
 /** File preparation runs under the heartbeat and lease, outside a database transaction.
  * Only the final binding CAS holds scheduler and research row locks.
  */
 async prepareResearch(job){
  if(job.contract.version!==RESEARCH_V2_VERSIONS.contract)throw fail('INVALID_RESEARCH_CONTRACT_V2');
  const contract=validateResearchContractV2(job.contract),signal=this.controller?.signal;
  const aborted=()=>{if(signal?.aborted)throw fail('DATASET_CANCELLED');};
  aborted();
  if(await this.engineHash()!==contract.engine_hash)throw fail('QUANT_ENGINE_CHANGED');
  const saved=(await this.db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',
   [job.run_id,DATASET_BINDING_STEP_ID])).rows[0];
  let parameters;
  if(saved){
   parameters=this.datasetBinding(contract,saved);
   try{
    await this.service.datasetStore.sidecar(parameters.references.sidecar,{signal});
    await this.service.datasetStore.raw.inspect(parameters.references.raw,{signal});
   }catch{aborted();throw fail('RESEARCH_DATASET_BINDING_INVALID');}
  }else{
   const rows=[],dataset=contract.dataset,model=contract.model;
   let after=dataset.start_time-1;
   while(rows.length<dataset.bar_count){
    aborted();
    const page=(await this.db.query(`SELECT * FROM pine_market_bars
     WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'
      AND bar_time>$1 AND bar_time<=$2 ORDER BY bar_time LIMIT 1000`,[after,dataset.end_time])).rows;
    if(!page.length)break;
    for(const row of page){
     if(row.bar_time!==dataset.start_time+rows.length*60000||row.bar?.time!==row.bar_time||
        row.provenance?.profile!==model.data_profile||hash(canonical(row.bar))!==row.content_hash)
      throw fail('VERIFIED_MARKET_DATA_REQUIRED');
     validateBar(row.bar);
     if(!D(row.bar.price_tick).eq(model.price_tick)||!D(row.bar.quantity_step).eq(model.quantity_step))
      throw fail('MARKET_METADATA_MISMATCH');
     rows.push(row);
    }
    after=page.at(-1).bar_time;
   }
   aborted();
   if(rows.length!==dataset.bar_count)throw fail('INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
   if(contentDigest(rows)!==dataset.content_digest)throw fail('RESEARCH_DATASET_CHANGED');
   const datasetSha=hash(canonical(rows.map(row=>({bar:row.bar,content_hash:row.content_hash,provenance:row.provenance}))));
   const references=await this.service.datasetStore.publish(pendingMetadata(contract),rows.map(row=>row.bar),
    {model,signal,chunkBars:1000});
   parameters=datasetBindingParameters(contract,{references,dataset_sha256:datasetSha});
   aborted();
   await this.fenced(job,async()=>{
    aborted();
    const digest=datasetBindingIdentity(contract,parameters);
    const inserted=await this.db.query(`INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,step_id) DO NOTHING RETURNING run_id`,
     [job.run_id,DATASET_BINDING_STEP_ID,DATASET_BINDING_KIND,JSON.stringify(parameters),digest]);
    if(!inserted.rowCount){
     const existing=(await this.db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',
      [job.run_id,DATASET_BINDING_STEP_ID])).rows[0];
     if(!existing||existing.identity_hash!==digest||canonical(existing.parameters)!==canonical(parameters))
      throw fail('RESEARCH_DATASET_BINDING_CONFLICT');
     this.datasetBinding(contract,existing);
    }else await this.service.store.audit(job.owner_id,'quant.research.prepared',job.run_id,
     {lease_token:job.lease_token,attempt:job.attempt,dataset_hash:parameters.dataset_sha256,
      execution_contract_hash:parameters.execution_contract_hash});
   });
  }
  aborted();
  return {...job,contract:materializeExecutionContract(contract,parameters),
   identity_contract:contract,dataset_binding:parameters};
 }
 async step(job,id,kind,parameters){
  if(job.foundation.contract.version===RESEARCH_V2_VERSIONS.request&&
     (!job.identity_contract||!job.dataset_binding))throw fail('RESEARCH_DATASET_BINDING_REQUIRED');
  const saved=(await this.steps(job)).find(row=>row.step_id===id);
  if(saved){if(saved.kind!==kind||canonical(saved.parameters)!==canonical(parameters))throw fail('CHECKPOINT_PARAMETER_MISMATCH');return saved.result;}
  const digest=identity(job.identity_contract??job.contract,parameters,kind);
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
    if(this.ioControls&&!this.evaluateChunk)await assertQuantStorageOwner(this.db,this.service.datasetStore.root);
    launched=true;
    answer=this.evaluateChunk?await this.evaluateChunk(payload,this.controller.signal):await this.supervisor({payload,module:'robot_quant.research_chunk',signal:this.controller.signal,python:this.python,timeoutMs:Math.min(30000,Math.max(100,job.deadline-this.clock())),limits:this.limits,ioControls:this.ioControls,ioTerminalProtocol:this.ioControls?'quant-io-terminal-v1':undefined,storageBudget:this.ioControls?this.service.storageBudget:undefined,unitName,allowUnsupportedPlatformForTests:this.allowUnsupportedPlatformForTests});
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
 async runProfile(job,signal){
  const foundation=job.foundation,key=foundation.job_id+':'+foundation.lease_token;
  this.stopped.delete(key);this.activeLaunches.add(key);let completed=false;
  try{
   if(!this.profileService)throw fail('PROFILE_SERVICE_REQUIRED');
   const result=await buildProfile({rawStore:this.dataService.datasetStore,
    researchStore:this.service.datasetStore,contract:foundation.contract,signal,now:this.clock()});
   if(signal.aborted)throw fail('DATASET_CANCELLED');
   await this.scheduler.finish(foundation,result);completed=true;
  }finally{this.activeLaunches.delete(key);if(completed)this.stopped.delete(key);else this.stopped.add(key);}
 }
 async runProfileV2(job,{signal,emergency,beforeTerminal}){
  const foundation=job.foundation,operationId='op-'+foundation.lease_token;
  const started=performance.now();let logged=false,terminalDiagnostic=null;
  const log=diagnostic=>{
   if(logged)return;
   const proof=['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED','NO_START_PROVEN','UNCONFIRMED'].includes(diagnostic?.proof)?diagnostic.proof:'UNCONFIRMED';
   const reason=QUANT_PROFILE_TERMINAL_LOG_REASONS.includes(diagnostic?.reason)?diagnostic.reason:'UNKNOWN';
   const record={jobId:foundation.job_id,proof,reason:reason==='COMPLETE'&&proof!=='MEASURED_FINAL_SETTLED'?'UNKNOWN':reason};
   for(const field of ['drainMs','elapsedMs','barrierMs'])if(Number.isSafeInteger(diagnostic?.[field])&&diagnostic[field]>=0)record[field]=diagnostic[field];
   logged=true;try{this.terminalLog(JSON.stringify(record));}catch{}
  };
  try{
   if(!this.profileV2Enabled||!this.profileRuntimeV2)throw fail('PROFILE_V2_DISABLED');
   if(!this.capacityPolicy?.terminal||hash(canonical(this.capacityPolicy))!==foundation.contract.capacity?.policy_hash)
    throw fail('QUANT_PROFILE_POLICY_MISMATCH');
   if(foundation.deadline_at-this.clock()<this.capacityPolicy.terminal.runtime_max_ms+5000)
    throw fail('PROFILE_DEADLINE_NEAR');
   this.profileOperations.set(foundation.job_id,{leaseToken:foundation.lease_token,operationId});
   const answer=await this.profileRuntimeV2.run({jobId:foundation.job_id,leaseToken:foundation.lease_token,
    operationId,expectedRevision:0,ownerId:foundation.owner_id,signal,emergency,beforeTerminal,
    onTerminalDiagnostic:diagnostic=>{terminalDiagnostic=diagnostic;}});
   // elapsedMs always spans this worker run, including the terminal. Terminal evidence supplies only available timings.
   log({...terminalDiagnostic,proof:answer?.proof,reason:terminalDiagnostic?.reason??'COMPLETE',
    elapsedMs:Math.max(0,Math.round(performance.now()-started))});
   return answer;
  }catch(error){
   log({...terminalDiagnostic,proof:error.terminal?.proof??terminalDiagnostic?.proof,reason:error.code,
    elapsedMs:Math.max(0,Math.round(performance.now()-started))});
   throw error;
  }finally{
   // W2 can throw before its terminal removes this entry. Physical stop proof remains durable.
   this.profileRuntimeV2?.io?.emergency?.delete(foundation.job_id+':'+operationId);
   this.profileOperations.delete(foundation.job_id);
  }
 }
 async stop(){this.emergencyController?.abort();await super.stop();}
 async runPreflight(job,signal){
  const foundation=job.foundation,key=foundation.job_id+':'+foundation.lease_token;
  let completed=false,runner;
  this.stopped.delete(key);this.activeLaunches.add(key);
  try{
   if(!this.preflightService)throw fail('PREFLIGHT_DISABLED');
   const bound=(await this.db.query('SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[foundation.job_id])).rows[0];
   if(!bound||bound.owner_id!==foundation.owner_id||bound.bot_id!==foundation.contract.bot_id||
      hash(bound.plan_json)!==bound.plan_hash)throw fail('FOUNDATION_INTEGRITY_FAILED');
   const plan=JSON.parse(bound.plan_json);
   if(canonical(plan)!==bound.plan_json||canonical(plan.foundation)!==canonical(foundation.contract))
    throw fail('FOUNDATION_INTEGRITY_FAILED');
   const resolved=await resolveHistoricalPreflight(plan,this.preflightService.trusted(foundation),
    {signal,now:this.clock(),...(this.preflightService.supportedSourceHash===undefined?{}:
     {supportedSourceHash:this.preflightService.supportedSourceHash})});
   runner=createSupervisedRunner({supervisor:options=>{
    // The authorization transaction can consume the last deadline margin after persistUnit.
    if(this.clock()>=foundation.deadline_at)throw Object.assign(fail('EVALUATION_TIMED_OUT'),{stopped:true});
    return this.supervisor(options);
   },python:this.python,limits:this.limits,
    ioControls:this.ioControls,storageBudget:this.service.storageBudget,
    allowUnsupportedPlatformForTests:this.allowUnsupportedPlatformForTests,clock:this.clock,
    deadlineAt:foundation.deadline_at,
    persistUnit:unit=>this.scheduler.fenced(foundation,'CHECKPOINT',async()=>{
     const saved=await this.db.query('UPDATE quant_preflight_jobs SET unit_name=$2,unit_token=$3 WHERE job_id=$1 AND unit_name IS NULL',
      [foundation.job_id,unit,foundation.lease_token]);
     if(saved.rowCount!==1)throw fail('FOUNDATION_LEASE_LOST');
     return foundation;
    }),
    clearUnit:async unit=>{
     const cleared=await this.db.query('UPDATE quant_preflight_jobs SET unit_name=NULL,unit_token=NULL WHERE job_id=$1 AND unit_name=$2 AND unit_token=$3',
      [foundation.job_id,unit,foundation.lease_token]);
     if(cleared.rowCount!==1)throw fail('FOUNDATION_LEASE_LOST');
    }});
   let running=false;
   const envelope=await runHistoricalPreflight({resolved,research:this.service.datasetStore,signal,clock:this.clock,
    resume:foundation.checkpoint?.state,onCheckpoint:token=>this.checkpointToken(foundation,token),
    runChunk:async(input,options)=>{
     if(running)throw fail('PF2_RUNNER_FAILED');
     if(this.clock()>=foundation.deadline_at)throw fail('PF2_DEADLINE_EXCEEDED');
     running=true;try{return await runner.runChunk(input,options);}finally{running=false;}
    }});
   await runner.settled();
   if(runner.unconfirmed)throw Object.assign(fail('QUANT_PROCESS_STOP_UNCONFIRMED'),{stopped:false});
   if(Buffer.byteLength(canonical(envelope))>foundation.contract.budget.max_output_bytes)throw fail('PF2_LIMIT_EXCEEDED');
   await this.scheduler.finish(foundation,envelope);completed=true;
  }catch(error){
   await runner?.settled();
   if(runner?.unconfirmed)throw Object.assign(fail('QUANT_PROCESS_STOP_UNCONFIRMED'),{stopped:false});
   if(error.code==='PF2_RUNNER_FAILED'&&this.clock()>=foundation.deadline_at)throw fail('PF2_DEADLINE_EXCEEDED');
   if(error.code==='PF2_RUNNER_FAILED'&&runner?.lastSupervisorCode)
    throw fail('PF2_RUNNER_FAILED:'+runner.lastSupervisorCode);
   throw error;
  }finally{
   await runner?.settled();this.activeLaunches.delete(key);
   if(completed)this.stopped.delete(key);else if(!runner?.unconfirmed)this.stopped.add(key);
  }
 }
 async checkpointToken(foundation,token){
  if(Buffer.byteLength(canonical(token))>foundation.contract.budget.max_state_bytes)throw fail('PF2_LIMIT_EXCEEDED');
  return this.scheduler.checkpoint(foundation,{next_bar:token.next_bar,state:token});
 }
 async runBackfill(job,signal){
  const foundation=job.foundation,contract=foundation.contract,store=this.dataService?.datasetStore;
  if(!store?.storageBudget)throw fail('INGESTION_STORAGE_BUDGET_REQUIRED');
  const key=foundation.job_id+':'+foundation.lease_token;
  let completed=false;
  this.stopped.delete(key);this.activeLaunches.add(key);
  try{
   const plan=planIngestionRange(contract.range,{now:this.clock()});
   let state=foundation.checkpoint?.state??{version:'backfill-pages-v1',pages:[]};
   if(foundation.next_bar)validateBackfillState(contract,foundation.next_bar,state);
   let offset=foundation.next_bar;
   while(offset<plan.total_bars){
    if(signal.aborted)throw fail('INGESTION_CANCELLED');
    const count=Math.min(1000,plan.total_bars-offset),start=plan.metadata.start_time+offset*60000;
    const pageRange={...contract.range,start_time:start,end_time:start+count*60000,warmup_bars:0};
    let provenance;
    const bars=this.fetchHistory(pageRange,{signal,clock:this.clock,
     beforePage:async()=>{await this.scheduler.fenced(foundation,'CHECKPOINT',async row=>row);return true;},
     onPage:page=>{provenance={...page,page:state.pages.length};}});
    const metadata=planIngestionRange(pageRange,{now:this.clock()}).metadata;
    const reference=await store.publish(metadata,bars,{signal,chunkBars:1000});
    if(!provenance)throw fail('INGESTION_PROVENANCE_MISSING');
    const pages=[...state.pages,{reference,provenance}];
    state={version:'backfill-pages-v1',pages};
    offset+=count;
    await this.scheduler.checkpoint(foundation,{next_bar:offset,state});
   }
   async function* assembled(){for(const page of state.pages)yield* store.read(page.reference,{signal});}
   const dataset=await store.publish(plan.metadata,assembled(),{signal,chunkBars:1000});
   await this.scheduler.finish(foundation,{version:'spot-ingestion-v1',dataset,
    provenance:{range:plan,pages:state.pages.map(page=>page.provenance)},
    raw_only:true,verified_execution_profile:false});
   completed=true;
  }finally{this.activeLaunches.delete(key);if(completed)this.stopped.delete(key);else this.stopped.add(key);}
 }
 async tick(){
  // Publish the controller before claim's awaited health/DB operations so stop()
  // also fences a shutdown requested while no subprocess exists yet.
  const controller=new AbortController(),emergencyController=new AbortController();
  this.controller=controller;this.emergencyController=emergencyController;
  let job;
  try{job=await this.claim();}catch(error){if(this.controller===controller)this.controller=null;if(this.emergencyController===emergencyController)this.emergencyController=null;throw error;}
  if(!job){if(this.controller===controller)this.controller=null;if(this.emergencyController===emergencyController)this.emergencyController=null;return false;}
  const profileV2=job.kind==='PROFILE'&&job.foundation.contract.version==='quant-foundation-v2';
  let heartbeatTask=null,terminalStarted=false;
  const heartbeat=setInterval(()=>{
   if(heartbeatTask)return;
   heartbeatTask=this.scheduler.heartbeat(job.foundation).catch(()=>{if(!terminalStarted)controller.abort();}).finally(()=>{heartbeatTask=null;});
  },Math.max(10,Math.min(5000,Math.floor(this.leaseMs/3))));
  const beforeTerminal=async()=>{clearInterval(heartbeat);await heartbeatTask;terminalStarted=true;};
  try{if(controller.signal.aborted)throw fail('RESEARCH_INTERRUPTED');if(job.kind==='PREFLIGHT')await this.runPreflight(job,controller.signal);else if(job.kind==='BACKFILL')await this.runBackfill(job,controller.signal);else if(profileV2)await this.runProfileV2(job,{signal:controller.signal,emergency:emergencyController.signal,beforeTerminal});else if(job.kind==='PROFILE')await this.runProfile(job,controller.signal);else await this.run(job);}catch(error){
   // A pre-reserve refusal has no runtime terminal hook, but still must quiet this heartbeat.
   if(profileV2)await beforeTerminal();
   // The supervisor settles only after physical exit. An unconfirmed stop keeps
   // STOPPING reserved for reconciliation of the persisted systemd unit.
   await this.db.transaction(async()=>{
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[job.foundation.job_id])).rows[0];
    if(row.status==='RUNNING'&&row.lease_token===job.foundation.lease_token){await this.db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',lease_until=NULL,runtime_used_ms=runtime_used_ms+GREATEST(0,$2-run_started_at),run_started_at=NULL,diagnostic=$3 WHERE job_id=$1",[row.job_id,this.clock(),error.code??'QUANT_WORKER_FAILED']);if(!['BACKFILL','PROFILE','PREFLIGHT'].includes(job.kind))await this.db.query("UPDATE quant_jobs SET status='FAILED',diagnostic=$2,lease_token=NULL,lease_until=0,updated_at=$3 WHERE run_id=$1 AND status='RUNNING'",[job.run_id,error.code??'QUANT_WORKER_FAILED',this.clock()]);}
   });
   const proof=error.terminal?.proof;
   const confirmed=['MEASURED_FINAL_SETTLED','UNKNOWN_FINAL_CHARGED','NO_START_PROVEN'].includes(proof);
   if(profileV2){
    if(proof==='UNCONFIRMED')return true;
    if(confirmed||!proof)await this.reconcile();
   }else if(error.stopped!==false)await this.reconcile();
  }finally{clearInterval(heartbeat);await heartbeatTask;if(this.controller===controller)this.controller=null;if(this.emergencyController===emergencyController)this.emergencyController=null;}
  return true;
 }
}
