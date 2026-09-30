import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../pine-bridge/source.js';
import {validateFoundationRequest,foundationTotalBars,validateBackfillState,validateBackfillResult} from '../quant-research/foundation-contract.js';
import {validateProfileResult} from '../quant-research/profile-contract.js';
import {validateFoundationRequestV2,strictJsonV2} from '../quant-research/foundation-contract-v2.js';
import {validateProfileResultV2} from '../quant-research/profile-contract-v2.js';
import {validateCapacityPolicy} from '../quant-research/capacity-contract.js';
import {validatePreflightEnvelope} from '../quant-research/preflight-plan.js';
import {beginProfileCompletionLocked} from './quant-profile-enrollment.js';

const fail = code => Object.assign(new Error(code), {code});
const activeStatuses = ['QUEUED','PAUSED','RUNNING','STOPPING'];
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function json(value,limit,code) {
  const seen=new Set();
  const inspect=value=>{
    if (value===null || typeof value==='string' || typeof value==='boolean') return;
    if (typeof value==='number' && Number.isFinite(value)) return;
    if (typeof value!=='object' || seen.has(value)) throw fail(code);
    if (!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw fail(code);
    if (Object.getOwnPropertySymbols(value).length) throw fail(code);
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i=0;i<value.length;i++) {if (!Object.hasOwn(value,i)) throw fail(code);inspect(value[i]);}
      if (Object.keys(value).length!==value.length) throw fail(code);
    } else for (const child of Object.values(value)) inspect(child);
    seen.delete(value);
  };
  inspect(value);
  let serialized;
  try { serialized=JSON.stringify(value); } catch { throw fail(code); }
  if (serialized===undefined || Buffer.byteLength(serialized)>limit) throw fail(code);
  return JSON.parse(serialized);
}
function text(value,code,max=128) {
  if (typeof value!=='string' || !value.trim() || value.length>max) throw fail(code);
  return value;
}

/** Internal foundation only. Callers must physically stop before pause/finish.
 * authorize must independently resolve owner/hash permissions and require a trusted
 * supervisor for ACKNOWLEDGE_STOPPED. A worker lease is not supervisor authority.
 * Before execution, trusted callers must inspect/read the dataset and resolve the
 * engine/snapshot hashes. Shape validation cannot establish artifact availability.
 * This module supplies no process supervision or OS resource isolation.
 */
export class QuantFoundationScheduler {
  constructor({db,authorize,health,clock=Date.now,leaseMs=30000,capacityPolicy,canRelease,profileV2Enabled=true}={}) {
    if (!db?.query || !db?.transaction || typeof authorize!=='function' || typeof health!=='function')
      throw fail('FOUNDATION_TRUSTED_CALLBACKS_REQUIRED');
    if (!Number.isSafeInteger(leaseMs) || leaseMs<1 || leaseMs>900000) throw fail('FOUNDATION_INVALID_LEASE');
    this.db=db;this.authorize=authorize;this.health=health;this.clock=clock;this.leaseMs=leaseMs;
    // Explicit caller-trusted engineering policy only. Default services cannot
    // enqueue or resume expanded contracts. Evidence resolution remains required.
    this.capacityPolicy=capacityPolicy===undefined?null:validateCapacityPolicy(capacityPolicy);
    if(canRelease!==undefined&&typeof canRelease!=='function')throw fail('FOUNDATION_TRUSTED_CALLBACKS_REQUIRED');
    this.canRelease=canRelease??null;
    this.profileV2Enabled=profileV2Enabled===true;
  }
  now() {
    const now=this.clock();
    if (!Number.isSafeInteger(now) || now<0) throw fail('FOUNDATION_INVALID_CLOCK');
    return now;
  }
  async allowed(owner,contract,action,context={}) {
    // Revoking capacity cannot disable cancellation or supervised physical stop.
    if(contract.version==='quant-foundation-v2'&&!['CANCEL','ACKNOWLEDGE_STOPPED','PAUSE'].includes(action))
      validateFoundationRequestV2(contract,{policy:this.capacityPolicy});
    if ((await this.authorize(owner,freeze(structuredClone(contract)),action,context))?.ok!==true)
      throw fail('FOUNDATION_FORBIDDEN');
  }
  async lock() { await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE'); }
  transaction(fn) {
    // Quarantine must commit before a lease-lost error escapes this service.
    if (this.db.isTransaction) throw fail('FOUNDATION_EXTERNAL_TRANSACTION_FORBIDDEN');
    return this.db.transaction(fn);
  }
  expose(row) { return row ? freeze(structuredClone(row)) : null; }
  integrity(row) {
    try {
    if (hash(canonical(row.contract))!==row.contract_hash) return false;
    if (!row.checkpoint) return row.next_bar===0;
    const {sha256,...payload}=row.checkpoint;
    if(row.contract.kind==='BACKFILL')return hash(canonical(payload))===sha256 &&
      payload.next_bar===row.next_bar && payload.engine_hash===row.contract.engine_hash &&
      payload.snapshot_hash===row.contract.snapshot_hash &&
      !!validateBackfillState(row.contract,row.next_bar,payload.state);
    return hash(canonical(payload))===sha256 && payload.next_bar===row.next_bar &&
      payload.dataset_id===row.contract.dataset.dataset_id && payload.dataset_sha256===row.contract.dataset.sha256 &&
      payload.engine_hash===row.contract.engine_hash && payload.snapshot_hash===row.contract.snapshot_hash &&
      Number.isSafeInteger(payload.next_bar) && payload.next_bar>0 && payload.next_bar<=row.contract.dataset.metadata.total_bars &&
      Buffer.byteLength(JSON.stringify(payload.state))<=row.contract.budget.max_state_bytes;
    } catch { return false; }
  }
  async row(id) {
    return (await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[id])).rows[0];
  }
  async enqueue(owner,request,idempotencyKey) {
    strictJsonV2(request);
    const contract=request?.version==='quant-foundation-v2'?
      validateFoundationRequestV2(request,{policy:this.capacityPolicy}):validateFoundationRequest(request);
    if (owner!==contract.owner_id) throw fail('FOUNDATION_FORBIDDEN');
    text(idempotencyKey,'FOUNDATION_INVALID_IDEMPOTENCY_KEY');
    await this.allowed(owner,contract,'ENQUEUE');
    const digest=hash(canonical(contract));
    return this.transaction(async()=>{
      await this.lock();
      const prior=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,idempotencyKey])).rows[0];
      if (prior) {
        if (prior.contract_hash!==digest) throw fail('FOUNDATION_IDEMPOTENCY_CONFLICT');
        return this.expose(prior);
      }
      const {rows:[counts]}=await this.db.query(`SELECT count(*)::int total,
        count(*) FILTER(WHERE owner_id=$1)::int owned FROM quant_foundation_jobs WHERE status=ANY($2::text[])`,[owner,activeStatuses]);
      if (counts.total>=100 || counts.owned>=20) throw fail('FOUNDATION_QUEUE_FULL');
      await this.db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
      const now=this.now();
      const {rows:[row]}=await this.db.query(`INSERT INTO quant_foundation_jobs
        (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
        VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,[randomUUID(),owner,idempotencyKey,JSON.stringify(contract),digest,now,now+contract.budget.max_runtime_ms]);
      return this.expose(row);
    });
  }
  async quarantine(row,now,forcedReason=null) {
    const reason=forcedReason ?? (row.deadline_at<=now || row.runtime_used_ms+now-row.run_started_at>=row.contract.budget.max_runtime_ms ? 'RUNTIME_EXCEEDED' :
      row.lease_until<=now ? 'LEASE_EXPIRED' : null);
    if (!reason) return false;
    // Internal safety transitions cannot depend on a revoked owner's permission.
    await this.db.query(`UPDATE quant_foundation_jobs SET status='STOPPING',lease_until=NULL,
      stop_reason=$2,runtime_used_ms=runtime_used_ms+GREATEST(0,$3-run_started_at),run_started_at=NULL WHERE job_id=$1`,[row.job_id,reason,now]);
    return true;
  }
  async claim(workerId) {
    text(workerId,'FOUNDATION_INVALID_WORKER');
    return this.transaction(async()=>{
      await this.lock();
      let now=this.now();
      const running=(await this.db.query("SELECT * FROM quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING') FOR UPDATE")).rows[0];
      if (running) {
        if (running.status==='RUNNING') await this.quarantine(running,now);
        return null;
      }
      let health;
      try { health=await this.health({action:'CLAIM'}); } catch { return null; }
      if (health?.ok!==true) return null;
      now=this.now();
      const expired=(await this.db.query(`SELECT * FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED')
        AND (deadline_at<=$1 OR attempts>=3) FOR UPDATE`,[now])).rows;
      for (const row of expired) {
        await this.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[row.job_id]);
      }
      for (let scanned=0;scanned<100;scanned++) {
      const row=(await this.db.query(`SELECT j.* FROM quant_foundation_jobs j JOIN quant_foundation_owners o USING(owner_id)
        WHERE j.status IN ('QUEUED','PAUSED') AND j.runtime_used_ms<(j.contract->'budget'->>'max_runtime_ms')::bigint
        ORDER BY o.last_served,j.created_at,j.job_id LIMIT 1 FOR UPDATE OF j`)).rows[0];
      if (!row) return null;
      let diagnostic=this.integrity(row)?null:'INTEGRITY_FAILED';
      const profileV2=row.contract.version==='quant-foundation-v2'&&row.contract.kind==='PROFILE';
      if(!diagnostic&&row.contract.version==='quant-foundation-v2'){
        if(profileV2&&!this.profileV2Enabled)diagnostic='PROFILE_V2_DISABLED';
        else if(profileV2&&row.attempts>0)diagnostic='PROFILE_ATTEMPT_EXHAUSTED';
        else try{validateFoundationRequestV2(row.contract,{policy:this.capacityPolicy});}
        catch{diagnostic='CAPACITY_POLICY_MISMATCH';}
      }
      if (!diagnostic) {
        try {await this.allowed(row.owner_id,row.contract,'CLAIM',{worker_id:workerId,job_id:row.job_id});}
        catch (error) {
          if (error.code!=='FOUNDATION_FORBIDDEN') throw error;
          diagnostic='AUTHORIZATION_REVOKED';
        }
      }
      now=this.now();
      if (!diagnostic && row.deadline_at<=now) diagnostic='DEADLINE_EXCEEDED';
      if (diagnostic) {
        await this.db.query("UPDATE quant_foundation_jobs SET status='CANCELLED',diagnostic=$2 WHERE job_id=$1",[row.job_id,diagnostic]);
        continue;
      }
      const {rows:[counter]}=await this.db.query('UPDATE quant_foundation_scheduler SET service_counter=service_counter+1 RETURNING service_counter');
      await this.db.query('UPDATE quant_foundation_owners SET last_served=$2 WHERE owner_id=$1',[row.owner_id,counter.service_counter]);
      const {rows:[claimed]}=await this.db.query(`UPDATE quant_foundation_jobs SET status='RUNNING',worker_id=$2,attempts=attempts+1,
        lease_token=$3,lease_until=$4,run_started_at=$5 WHERE job_id=$1 RETURNING *`,[row.job_id,workerId,randomUUID(),now+this.leaseMs,now]);
      return this.expose(claimed);
      }
      return null;
    });
  }
  async fenced(job,action,update) {
    const outcome=await this.transaction(async()=>{
      await this.lock();
      const row=await this.row(job?.job_id);
      if (!row || row.status!=='RUNNING' || row.lease_token!==job.lease_token) return {lost:true};
      await this.allowed(row.owner_id,row.contract,action,{job_id:row.job_id,worker_id:row.worker_id});
      let now=this.now();
      if (await this.quarantine(row,now)) return {lost:true};
      if (action==='HEARTBEAT') {
        let health;
        try { health=await this.health({action:'HEARTBEAT'}); } catch { health=null; }
        if (health?.ok!==true) {
          await this.quarantine(row,now,'HEALTH_UNAVAILABLE');
          return {lost:true};
        }
      }
      now=this.now();
      if (await this.quarantine(row,now)) return {lost:true};
      return {value:await update(row,now)};
    });
    // Throw only after STOPPING commits; rolling back would undo quarantine.
    if (outcome.lost) throw fail('FOUNDATION_LEASE_LOST');
    return this.expose(outcome.value);
  }
  async heartbeat(job) {
    return this.fenced(job,'HEARTBEAT',async(row,now)=>(await this.db.query(
      'UPDATE quant_foundation_jobs SET lease_until=$2 WHERE job_id=$1 RETURNING *',[row.job_id,now+this.leaseMs])).rows[0]);
  }
  async checkpoint(job,{next_bar,state}) {
    return this.fenced(job,'CHECKPOINT',async row=>{
      // PROFILE publishes one atomic result and must restart from its raw input.
      if(row.contract.kind==='PROFILE')throw fail('PROFILE_CHECKPOINT_INVALID');
      if (!Number.isSafeInteger(next_bar) || next_bar<=row.next_bar || next_bar>foundationTotalBars(row.contract))
        throw fail('FOUNDATION_INVALID_CHECKPOINT');
      const bounded=json(state,row.contract.budget.max_state_bytes,'FOUNDATION_STATE_TOO_LARGE');
      if(row.contract.kind==='BACKFILL')validateBackfillState(row.contract,next_bar,bounded);
      const checkpoint=row.contract.kind==='BACKFILL'?{next_bar,state:bounded,engine_hash:row.contract.engine_hash,
        snapshot_hash:row.contract.snapshot_hash}:{next_bar,state:bounded,dataset_id:row.contract.dataset.dataset_id,
        dataset_sha256:row.contract.dataset.sha256,engine_hash:row.contract.engine_hash,snapshot_hash:row.contract.snapshot_hash};
      checkpoint.sha256=hash(canonical(checkpoint));
      return (await this.db.query('UPDATE quant_foundation_jobs SET checkpoint=$2,next_bar=$3 WHERE job_id=$1 RETURNING *',
        [row.job_id,JSON.stringify(checkpoint),next_bar])).rows[0];
    });
  }
  async release(job,status,result) {
    return this.fenced(job,status==='PAUSED'?'PAUSE':'FINISH',async(row,now)=>{
      if(row.contract.version==='quant-foundation-v2'&&row.contract.kind==='PROFILE')
        throw fail('PROFILE_V2_TERMINAL_REQUIRED');
      if(this.canRelease&&(await this.canRelease(row,status==='PAUSED'?'PAUSE':'FINISH'))?.ok!==true)
        throw fail('FOUNDATION_IO_UNRESOLVED');
      if(row.contract.version==='quant-foundation-v2'&&status==='SUCCEEDED')strictJsonV2(result);
      const bounded=status==='SUCCEEDED'?json(result,row.contract.budget.max_output_bytes,'FOUNDATION_OUTPUT_TOO_LARGE'):null;
      if(row.contract.kind==='BACKFILL'&&status==='SUCCEEDED')validateBackfillResult(row.contract,row.checkpoint,bounded);
      if(row.contract.kind==='PREFLIGHT'&&status==='SUCCEEDED'){
        try{
          const plan=(await this.db.query('SELECT plan_hash,plan_json,unit_name,unit_token FROM quant_preflight_jobs WHERE job_id=$1 FOR SHARE',[row.job_id])).rows[0];
          if(!plan||plan.unit_name!==null||plan.unit_token!==null||hash(plan.plan_json)!==plan.plan_hash)throw fail('INTEGRITY_FAILED');
          validatePreflightEnvelope(row.contract,bounded,{planHash:plan.plan_hash,plan:JSON.parse(plan.plan_json)});
        }catch(error){if(/^[0-9A-Z]{5}$/.test(error?.code??''))throw error;throw fail('INTEGRITY_FAILED');}
      }
      if(row.contract.kind==='PROFILE'&&status==='SUCCEEDED'){
        if(row.contract.version==='quant-foundation-v2')validateProfileResultV2(row.contract,bounded,{policy:this.capacityPolicy});
        else validateProfileResult(row.contract,bounded);
      }
      return (await this.db.query(`UPDATE quant_foundation_jobs SET status=$2,result=$3,
        runtime_used_ms=runtime_used_ms+GREATEST(0,$4-run_started_at),run_started_at=NULL,
        lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE job_id=$1 RETURNING *`,[row.job_id,status,JSON.stringify(bounded),now])).rows[0];
    });
  }
  pause(job) { return this.release(job,'PAUSED'); }
  finish(job,result) { return this.release(job,'SUCCEEDED',result); }
  async beginProfileCompletion({job_id,lease_token,attempt}) {
    if(this.db.isTransaction)throw fail('FOUNDATION_EXTERNAL_TRANSACTION_FORBIDDEN');
    return this.db.transaction(async()=>{
      // SERIALIZABLE snapshots at the first query. LOCK TABLE takes no snapshot, so a transaction that commits while
      // this one waits for the scheduler (an owner cancel) is inside the snapshot instead of a serialization failure.
      await this.db.query('LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE');
      await this.lock();const job=await this.row(job_id);
      if(!job||job.lease_token!==lease_token)throw fail('FOUNDATION_LEASE_LOST');
      return beginProfileCompletionLocked({db:this.db,job,attempt,clock:this.clock});
    },{isolation:'SERIALIZABLE'});
  }
  async cancel(owner,jobId) {
    return this.transaction(async()=>{
      await this.lock();
      const row=await this.row(jobId);
      if (!row || row.owner_id!==owner) throw fail('FOUNDATION_NOT_FOUND');
      await this.allowed(owner,row.contract,'CANCEL',{job_id:jobId});
      if (!activeStatuses.includes(row.status)) return this.expose(row);
      const stopping=['RUNNING','STOPPING'].includes(row.status);
      return this.expose((await this.db.query(`UPDATE quant_foundation_jobs SET status=$2,
        stop_reason=$3,lease_until=NULL,runtime_used_ms=runtime_used_ms+CASE WHEN run_started_at IS NULL THEN 0 ELSE GREATEST(0,$4-run_started_at) END,
        run_started_at=NULL WHERE job_id=$1 RETURNING *`,[jobId,stopping?'STOPPING':'CANCELLED',stopping?'CANCELLED':null,this.now()])).rows[0]);
    });
  }
  async acknowledgeStopped(jobId,token) {
    return this.transaction(async()=>{
      await this.lock();
      const row=await this.row(jobId);
      if (!row || row.status!=='STOPPING' || row.lease_token!==token) throw fail('FOUNDATION_LEASE_LOST');
      // Supervisor proof must remain available after owner revocation.
      await this.allowed(row.owner_id,row.contract,'ACKNOWLEDGE_STOPPED',{job_id:jobId,lease_token:token});
      if(this.canRelease&&(await this.canRelease(row,'ACKNOWLEDGE_STOPPED'))?.ok!==true)
        throw fail('FOUNDATION_IO_UNRESOLVED');
      const profileV2=row.contract.version==='quant-foundation-v2'&&row.contract.kind==='PROFILE';
      const status=!profileV2&&['LEASE_EXPIRED','HEALTH_UNAVAILABLE'].includes(row.stop_reason) && row.attempts<3 && row.deadline_at>this.now()?'PAUSED':'CANCELLED';
      return this.expose((await this.db.query(`UPDATE quant_foundation_jobs SET status=$2,stop_reason=NULL,
        worker_id=NULL,lease_token=NULL,lease_until=NULL WHERE job_id=$1 RETURNING *`,[jobId,status])).rows[0]);
    });
  }
}
