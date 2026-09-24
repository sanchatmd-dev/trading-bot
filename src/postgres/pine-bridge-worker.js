import {randomUUID} from 'node:crypto';
import {assemble,validateProposal} from '../pine-bridge/template.js';
import {hash,canonical,fail} from '../pine-bridge/source.js';
import {DirectProvider} from '../pine-bridge/gemini.js';

export class PineBridgeWorker {
  constructor({service,provider=new DirectProvider(),clock=Date.now}){this.service=service;this.db=service.db;this.provider=provider;this.clock=clock;}
  async sweep() {
    const now=this.clock();
    await this.db.prepare("UPDATE pine_bridge_jobs SET status='TIMED_OUT',diagnostic='JOB_DEADLINE_EXCEEDED',updated_at=? WHERE status IN ('QUEUED','RETRY_WAIT','RUNNING','VALIDATING') AND deadline<=?").run(now,now);
    await this.db.prepare("UPDATE pine_bridge_jobs SET status='OUTCOME_UNKNOWN',diagnostic='WORKER_LEASE_EXPIRED',updated_at=? WHERE status IN ('RUNNING','VALIDATING') AND lease_until<=?").run(now,now);
  }
  async claim() {
    return this.db.transaction(async()=>{
      await this.db.lock('pine-bridge:jobs');const now=this.clock();
      await this.sweep();
      const running=await this.db.prepare("SELECT owner_id FROM pine_bridge_jobs WHERE status IN ('RUNNING','VALIDATING')").all();
      if(running.length>=4)return null;
      const rows=await this.db.prepare("SELECT * FROM pine_bridge_jobs WHERE status IN ('QUEUED','RETRY_WAIT') AND next_attempt<=? AND deadline>? AND attempt<2 ORDER BY created_at LIMIT 20 FOR UPDATE").all(now,now);
      for(const row of rows) {
        if(running.some(r=>r.owner_id===row.owner_id))continue;
        try{await this.service.authorize(row.owner_id,row.bot_id);}catch{
          await this.db.prepare("UPDATE pine_bridge_jobs SET status='FAILED',diagnostic='OWNER_UNAVAILABLE',updated_at=? WHERE job_id=?").run(now,row.job_id);continue;
        }
        const attempt_id=randomUUID();
        await this.db.prepare("UPDATE pine_bridge_jobs SET status='RUNNING',attempt=attempt+1,attempt_id=?,lease_until=?,updated_at=? WHERE job_id=?").run(attempt_id,now+30000,now,row.job_id);
        await this.db.prepare('INSERT INTO pine_bridge_attempts(attempt_id,job_id,dispatched_at) VALUES(?,?,?)').run(attempt_id,row.job_id,now);
        return {...row,attempt_id,attempt:row.attempt+1};
      }
      return null;
    });
  }
  async finish(job,response,error) {
    const now=this.clock();
    await this.db.transaction(async()=>{
      const row=await this.db.prepare('SELECT * FROM pine_bridge_jobs WHERE job_id=? FOR UPDATE').get(job.job_id);
      const usage=response?.usage??null;
      await this.db.prepare('UPDATE pine_bridge_attempts SET finished_at=?,outcome=?,usage=?,provider_request_id=? WHERE attempt_id=?').run(now,error?.code??'RESPONSE_RECEIVED',JSON.stringify(usage),response?.request_id??null,job.attempt_id);
      // Usage remains accounted for even when cancellation discards the output.
      if(usage)await this.db.prepare('UPDATE pine_bridge_jobs SET usage=usage || ?::jsonb WHERE job_id=?').run(JSON.stringify([usage]),job.job_id);
      if(row.attempt_id!==job.attempt_id||!['RUNNING','VALIDATING'].includes(row.status))return;
      let status='FAILED',diagnostic=error?.code??response?.error??null,result=null,next=0;
      if(now>=row.deadline){status='TIMED_OUT';diagnostic='JOB_DEADLINE_EXCEEDED';}
      else if(error) {
        if(error.code==='PROVIDER_RATE_LIMIT'&&job.attempt<2&&Number.isFinite(error.retryAfter)&&error.retryAfter<=30&&now+Math.max(2,error.retryAfter)*1000<row.deadline){status='RETRY_WAIT';next=now+Math.max(2,error.retryAfter)*1000;}
        else if(['OUTCOME_UNKNOWN','PROVIDER_USAGE_UNKNOWN'].includes(error.code))status='OUTCOME_UNKNOWN';
      } else if(!diagnostic) {
        try {
          await this.service.authorize(job.owner_id,job.bot_id);
          const u=response.usage,b=job.request.budget;
          if(!u||!Number.isSafeInteger(u.input_tokens)||!Number.isSafeInteger(u.output_tokens)||u.input_tokens<0||u.output_tokens<0||!Number.isFinite(u.cost_usd)||u.cost_usd<0||u.input_tokens>b.input_tokens||u.output_tokens>4000||u.cost_usd>b.reserved_usd/2)throw fail('PROVIDER_BUDGET_VIOLATION');
          const proposal=validateProposal(response.value,job.request.analysis,job.request.selection);
          await this.db.prepare("UPDATE pine_bridge_jobs SET status='VALIDATING',updated_at=? WHERE job_id=?").run(now,job.job_id);
          if(job.operation==='analyze') {
            result={kind:'indicator',...job.request.analysis,proposal,required_bridge_parameters:[{slot:1,name:'ATR Multiplier for SL',default:2},{slot:2,name:'Risk-to-Reward',default:1.5}],slot_limits:{fixed:2,dynamic:8,total:10}};
          } else {
            const source=await this.service.source(job.owner_id,job.bot_id,job.pine_import_id,job.request.deployment.source_version);
            result={...assemble(source.source,job.request.selection,job.request.deployment),bridge_capability:source.analysis.bridge_capability,quant_capability:source.analysis.quant_capability,diagnostics:proposal.diagnostics,deployment_id:job.request.deployment.deployment_id};
            const snapshot={...job.request.snapshot,selection:job.request.selection,market:job.request.deployment,source_hash:source.source_hash,instruction_versions:job.request.versions,artifact_hash:hash(result.integrated_pine)};
            await this.db.prepare('INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,created_at) VALUES(?,?,?,?,?,?,?,?)').run(result.deployment_id,job.owner_id,job.bot_id,job.pine_import_id,source.source_version,JSON.stringify(snapshot),hash(canonical(snapshot)),now);
          }
          status='SUCCEEDED';
        } catch(e){diagnostic=e.code??'VALIDATION_FAILED';result=null;}
      }
      await this.db.prepare('UPDATE pine_bridge_jobs SET status=?,diagnostic=?,result=?,next_attempt=?,lease_until=0,updated_at=? WHERE job_id=? AND attempt_id=?').run(status,diagnostic,JSON.stringify(result),next,now,job.job_id,job.attempt_id);
    });
  }
  async tick() {
    const job=await this.claim();if(!job)return false;
    const controller=new AbortController();this.controller=controller;
    let pulseActive=false;
    const pulse=setInterval(async()=>{
      if(pulseActive)return;pulseActive=true;
      try{
        const now=this.clock();const updated=await this.db.prepare("UPDATE pine_bridge_jobs SET lease_until=?,updated_at=? WHERE job_id=? AND attempt_id=? AND status='RUNNING' AND deadline>?").run(now+30000,now,job.job_id,job.attempt_id,now);
        if(!updated.changes)controller.abort();
      }catch{controller.abort();}finally{pulseActive=false;}
    },5000);
    const timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(90000,job.deadline-this.clock())));
    let response,error;
    try {
      const row=await this.db.prepare('SELECT status FROM pine_bridge_jobs WHERE job_id=?').get(job.job_id);
      if(row.status!=='RUNNING')throw fail('CANCELLED');
      const source=await this.service.source(job.owner_id,job.bot_id,job.pine_import_id,job.request.source_version);
      response=await this.provider.run(job.request,source.source,{signal:controller.signal});
    }catch(e){error=e.code?e:fail('OUTCOME_UNKNOWN');}
    finally{clearTimeout(timeout);clearInterval(pulse);this.controller=null;}
    await this.finish(job,response,error);return true;
  }
  start(){
    this.timer=setInterval(()=>this.run(),1000);
    this.sweeper=setInterval(()=>{if(this.sweeping)return;this.sweeping=this.sweep().catch(()=>console.error('Pine Bridge sweep failed')).finally(()=>{this.sweeping=null;});},5000);
    this.run();
  }
  run(){if(this.active||this.stopping)return;this.active=this.tick().catch(()=>console.error('Pine Bridge worker failed')).finally(()=>{this.active=null;});}
  async stop(){this.stopping=true;clearInterval(this.timer);clearInterval(this.sweeper);this.controller?.abort();await Promise.all([this.active,this.sweeping]);}
}
