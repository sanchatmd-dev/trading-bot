import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {D} from '../money.js';
import {canonical,hash,fail} from '../pine-bridge/source.js';
import {screen,coverage,validParameters,RULES} from '../quant-research/contract.js';
import {engineHash} from './quant-research.js';
import {freshSnapshot} from './pine-bridge-readiness.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function pythonEvaluation(contract,parameters,kind,signal,{python=process.env.QUANT_RESEARCH_PYTHON||'python',timeoutMs=30000}={}){
 return new Promise((resolve,reject)=>{
  // Holdout candles never enter a candidate/sensitivity/stress subprocess.
  const calculationContract=kind==='HOLDOUT'?contract:{...contract,dataset:{...contract.dataset,bars:contract.dataset.bars.slice(0,contract.split.validation_end)}};
  const input=JSON.stringify({contract:calculationContract,parameters,kind});
  if(Buffer.byteLength(input)>8*1024*1024){reject(fail('RESEARCH_REQUEST_TOO_LARGE'));return;}
  const child=spawn(python,['-m','robot_quant.research_engine'],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'quant_lab/src')},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>{child.kill();finish(fail('RESEARCH_INTERRUPTED'));};
  const timer=setTimeout(()=>{child.kill();finish(fail('EVALUATION_TIMED_OUT'));},timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){abort();return;}
  child.stdout.on('data',data=>{output+=data;if(Buffer.byteLength(output)>2*1024*1024){child.kill();finish(fail('EVALUATION_OUTPUT_TOO_LARGE'));}});
  child.stderr.on('data',()=>{}); // Never echo private source/contract through Python errors.
  child.stdin.on('error',()=>{});
  child.on('error',()=>finish(fail('QUANT_PYTHON_UNAVAILABLE')));
  child.on('close',code=>{if(code!==0){finish(fail('EVALUATION_FAILED'));return;}try{const value=JSON.parse(output);if(value.error)throw Error();finish(null,value);}catch{finish(fail('INVALID_EVALUATION_RESPONSE'));}});
  child.stdin.end(input);
 });
}

export class QuantResearchWorker{
 constructor({service,evaluate=pythonEvaluation,clock=Date.now,leaseMs=30000}){this.service=service;this.db=service.db;this.evaluate=evaluate;this.clock=clock;this.leaseMs=leaseMs;}
 async sweep(){
  const now=this.clock();
  await this.db.prepare("UPDATE quant_jobs SET status='TIMED_OUT',diagnostic='JOB_DEADLINE_EXCEEDED',lease_token=NULL,lease_until=0,updated_at=? WHERE status IN ('QUEUED','RUNNING') AND deadline<=?").run(now,now);
  await this.db.prepare("UPDATE quant_jobs SET status='FAILED',diagnostic='RECOVERY_LIMIT_EXCEEDED',lease_token=NULL,lease_until=0,updated_at=? WHERE status='RUNNING' AND lease_until<=? AND attempt>=3").run(now,now);
  await this.db.prepare("UPDATE quant_jobs SET status='QUEUED',diagnostic='RECOVERING_FROM_CHECKPOINT',lease_token=NULL,lease_until=0,updated_at=? WHERE status='RUNNING' AND lease_until<=? AND attempt<3").run(now,now);
 }
 async claim(){return this.db.transaction(async()=>{
  await this.db.lock('quant:research:queue');await this.sweep();
  const running=await this.db.prepare("SELECT owner_id FROM quant_jobs WHERE status='RUNNING'").all();if(running.length>=2)return null;
  const queue=await this.db.prepare("SELECT * FROM quant_jobs WHERE status='QUEUED' AND attempt<3 ORDER BY created_at,run_id LIMIT 10 FOR UPDATE").all();
  for(const job of queue){
   if(running.some(r=>r.owner_id===job.owner_id))continue;
   try{await this.service.pine.authorize(job.owner_id,job.bot_id);}catch{await this.db.prepare("UPDATE quant_jobs SET status='FAILED',diagnostic='OWNER_UNAVAILABLE',updated_at=? WHERE run_id=?").run(this.clock(),job.run_id);continue;}
   const token=randomUUID(),now=this.clock();
   await this.db.prepare("UPDATE quant_jobs SET status='RUNNING',attempt=attempt+1,lease_token=?,lease_until=?,updated_at=?,diagnostic=NULL WHERE run_id=?").run(token,Math.min(job.deadline,now+this.leaseMs),now,job.run_id);
   return {...job,status:'RUNNING',lease_token:token,attempt:job.attempt+1};
  }
  return null;
 });}
 async fenced(job,fn){return this.db.transaction(async()=>{
  // Match policy, membership and funding writers' owner/Bot lock order.
  await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(job.owner_id);
  if(job.bot_id!==job.owner_id)await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(job.bot_id);
  const row=await this.db.prepare('SELECT * FROM quant_jobs WHERE run_id=? FOR UPDATE').get(job.run_id);
  if(row.status!=='RUNNING'||row.lease_token!==job.lease_token||row.lease_until<=this.clock()||row.deadline<=this.clock())throw fail('RESEARCH_LEASE_LOST');
  return fn(row);
 });}
 async steps(job){return this.db.prepare('SELECT * FROM quant_job_steps WHERE run_id=? ORDER BY step_id').all(job.run_id);}
 async current(job){
  if(hash(canonical(job.contract))!==job.contract_hash)throw fail('RESEARCH_CONTRACT_CHANGED');
  await this.service.pine.authorize(job.owner_id,job.bot_id);
  const row=await this.db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(job.deployment_id);
  if(!row||row.state!=='READY'||row.snapshot_hash!==job.contract.baseline_snapshot_hash)throw fail('RESEARCH_BASELINE_CHANGED');
  await freshSnapshot(this.service.pine,row);
 }
 async step(job,id,kind,parameters){
  const existing=(await this.steps(job)).find(s=>s.step_id===id);
  if(existing){if(existing.kind!==kind||canonical(existing.parameters)!==canonical(parameters))throw fail('CHECKPOINT_PARAMETER_MISMATCH');return existing.result;}
  if(await engineHash()!==job.contract.engine_hash)throw fail('QUANT_ENGINE_CHANGED');
  await this.fenced(job,async row=>{
   await this.current(job);
   if(row.evaluations_started>=job.contract.max_evaluations)throw fail('EVALUATION_BUDGET_EXCEEDED');
   await this.db.prepare('UPDATE quant_jobs SET evaluations_started=evaluations_started+1,phase=?,updated_at=? WHERE run_id=?').run(kind,this.clock(),job.run_id);
  });
  const result=await this.evaluate(job.contract,parameters,kind,this.controller.signal);
  if(canonical(result.parameters)!==canonical(parameters)||result.kind!==kind||!result.train||!result.validation||(kind!=='HOLDOUT'&&Object.hasOwn(result,'test')))throw fail('INVALID_EVALUATION_RESPONSE');
  for(const metrics of [result.train,result.validation,...(kind==='HOLDOUT'?[result.test]:[])]){
   if(!metrics||!Number.isSafeInteger(metrics.closed_trades)||metrics.closed_trades<0)throw fail('INVALID_EVALUATION_RESPONSE');
   for(const key of ['net_return_percent','max_drawdown_percent']){
    if(!['string','number'].includes(typeof metrics[key]))throw fail('INVALID_EVALUATION_RESPONSE');
    const value=D(metrics[key]);if(!value.isFinite()||(key==='max_drawdown_percent'&&value.lt(0)))throw fail('INVALID_EVALUATION_RESPONSE');
   }
  }
  await this.fenced(job,async()=>{
   await this.current(job);
   if(await engineHash()!==job.contract.engine_hash)throw fail('QUANT_ENGINE_CHANGED');
   await this.db.prepare('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES(?,?,?,?,?,?)').run(job.run_id,id,kind,JSON.stringify(parameters),JSON.stringify(result),this.clock());
  });
  return result;
 }
 async finish(job,status,result,diagnostic=null){await this.fenced(job,async()=>{
  if(status==='SUCCEEDED'||status==='NO_VALID_CANDIDATE')await this.current(job);
  await this.db.prepare('UPDATE quant_jobs SET status=?,phase=?,result=?,diagnostic=?,lease_token=NULL,lease_until=0,updated_at=? WHERE run_id=?').run(status,'COMPLETE',JSON.stringify(result),diagnostic,this.clock(),job.run_id);
  await this.service.store.audit(job.owner_id,'quant.research.finished',job.run_id,{status,contract_hash:job.contract_hash});
 });}
 async run(job){
  if(await engineHash()!==job.contract.engine_hash)throw fail('QUANT_ENGINE_CHANGED');
  const contract=job.contract,results=[];
  for(let i=0;i<contract.plan.candidates.length;i++){
   const parameters=contract.plan.candidates[i];
   results.push({parameters,result:await this.step(job,'candidate:'+String(i).padStart(3,'0'),'CANDIDATE',parameters)});
  }
  const covered=coverage(results,contract.input_lock.domains);
  const baseline=results[0].result.validation.net_return_percent;
  const candidates=results.map(row=>({...row,screen_reasons:screen(row.result,baseline)}));
  const eligible=candidates.filter(c=>!c.screen_reasons.length).sort((a,b)=>D(b.result.validation.net_return_percent).cmp(a.result.validation.net_return_percent)||D(a.result.validation.max_drawdown_percent).cmp(b.result.validation.max_drawdown_percent)||canonical(a.parameters).localeCompare(canonical(b.parameters)));
  const selected=eligible[0],errors=[],checks=[];
  const report={scope:contract.scope,contract_hash:job.contract_hash,input_lock_hash:contract.input_lock.lock_hash,dataset_hash:contract.dataset.sha256,search_algorithm:contract.plan.algorithm,seed:contract.plan.seed,budget:contract.plan.requested_budget,candidate_count:results.length,...covered,candidates,selected:null,owner_recommendation_ready:false,acceptance_blockers:contract.acceptance_blockers,holdout_evaluated:false,completion_reason:'NO_VALID_TRAIN_VALIDATION_CANDIDATE'};
  if(!selected||covered.dimension_coverage_percent!==100){await this.finish(job,'NO_VALID_CANDIDATE',report);return;}
  const fixed=Object.fromEntries(contract.input_lock.selection.fixed_inputs.map(i=>[i.pine_variable,i.effective_value]));
  for(const name of Object.keys(contract.input_lock.domains).sort()){
   const grid=contract.input_lock.domains[name],index=grid.indexOf(selected.parameters[name]);
   for(const next of [index-1,index+1])if(next>=0&&next<grid.length){
    const parameters={...selected.parameters,[name]:grid[next]};if(!validParameters(parameters,fixed))continue;
    const saved=results.find(r=>canonical(r.parameters)===canonical(parameters));
    const result=saved?.result??await this.step(job,'sensitivity:'+name+':'+next,'SENSITIVITY',parameters);
    checks.push({dimension:name,parameters,result});
    if(D(result.validation.net_return_percent).lt(D(selected.result.validation.net_return_percent).minus(RULES.sensitivity_max_drop_percentage_points))||result.validation.closed_trades<RULES.minimum_closed_trades_validation)errors.push('SENSITIVITY_FAILED');
   }
  }
  const stress=await this.step(job,'stress:selected','STRESS',selected.parameters);
  if(D(stress.validation.net_return_percent).lt(0)||stress.validation.closed_trades<RULES.minimum_closed_trades_validation)errors.push('COST_STRESS_FAILED');
  report.selected={...selected,sensitivity:checks,cost_stress:stress,screen_reasons:errors};
  if(!errors.length){
   const holdout=await this.step(job,'holdout:selected','HOLDOUT',selected.parameters);report.holdout_evaluated=true;report.selected.test=holdout.test;
   if(!holdout.test||holdout.test.closed_trades<RULES.minimum_closed_trades_test)errors.push('INSUFFICIENT_TEST_TRADES');
   if(holdout.test&&D(holdout.test.net_return_percent).lt(0))errors.push('NEGATIVE_HOLDOUT_RETURN');
   if(holdout.test&&D(holdout.test.max_drawdown_percent).gt(RULES.maximum_drawdown_percent))errors.push('TEST_DRAWDOWN_EXCEEDED');
  }
  report.completion_reason=errors.length?'CANDIDATE_FAILED_CHECKS':'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';
  await this.finish(job,errors.length?'NO_VALID_CANDIDATE':'SUCCEEDED',report);
 }
 async tick(){
  const job=await this.claim();if(!job)return false;
  const controller=new AbortController();this.controller=controller;
  const heartbeat=setInterval(async()=>{try{await this.fenced(job,()=>this.db.prepare('UPDATE quant_jobs SET lease_until=?,updated_at=? WHERE run_id=?').run(Math.min(job.deadline,this.clock()+this.leaseMs),this.clock(),job.run_id));}catch{controller.abort();}},5000);
  try{await this.run(job);}catch(error){
   if(!controller.signal.aborted){try{await this.finish(job,'FAILED',null,error.code??'QUANT_WORKER_FAILED');}catch{/* Cancellation or another lease owner wins. */}}
  }finally{clearInterval(heartbeat);this.controller=null;}
  return true;
 }
 start(){this.running=true;this.loop=(async()=>{while(this.running){try{if(await this.tick())continue;}catch{console.error('Quant research worker cycle failed');}await new Promise(resolve=>{this.wake=resolve;this.timer=setTimeout(resolve,1000);});}})();}
 async stop(){this.running=false;this.controller?.abort();clearTimeout(this.timer);this.wake?.();await this.loop;}
}
