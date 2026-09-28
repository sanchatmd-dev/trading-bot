import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical,hash} from '../pine-bridge/source.js';

const error=code=>Object.assign(new Error(code),{code});
const unitPattern=/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}\.service$/;
const transientPattern=/^robot-quant-[a-z0-9-]{1,100}\.service$/;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function command(file,args,timeoutMs=10000){
 return new Promise((resolve,reject)=>{
  const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',done=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(error('RECOVERY_COMMAND_TIMEOUT'));},timeoutMs);
  function finish(failure,code){if(done)return;done=true;clearTimeout(timer);if(failure)reject(failure);else if(code!==0)reject(error('RECOVERY_COMMAND_FAILED'));else resolve(stdout);}
  child.stdout.on('data',data=>{stdout+=data;if(stdout.length>65536)child.kill('SIGKILL');});
  child.stderr.on('data',data=>{stderr+=data;if(stderr.length>4096)child.kill('SIGKILL');});
  child.on('error',failure=>finish(failure));child.on('close',code=>finish(null,code));
 });
}

const systemd={
 show:async unit=>{
  const output=await command('systemctl',['--user','show',unit,'--property=LoadState,ActiveState,SubState,ControlGroup,Job,MainPID,KillMode']);
  return Object.fromEntries(output.split(/\r?\n/).filter(Boolean).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
 },
 jobs:()=>command('systemctl',['--user','list-jobs','--all','--no-legend','--plain']),
 stop:unit=>command('systemctl',['--user','stop',unit]),
 kill:unit=>command('systemctl',['--user','kill','--kill-whom=all','--signal=KILL',unit]),
 mask:unit=>command('systemctl',['--user','mask','--runtime',unit])
};

async function groupEmpty(group){
 if(!group)return true;
 if(!group.startsWith('/')||group.includes('..'))throw error('RECOVERY_INVALID_CGROUP');
 const root='/sys/fs/cgroup';
 const location=path.resolve(root,'.'+group);
 if(!location.startsWith(root+path.sep))throw error('RECOVERY_INVALID_CGROUP');
 try{return /^populated 0$/m.test(await fs.readFile(path.join(location,'cgroup.events'),'utf8'));}
 catch(failure){if(failure.code==='ENOENT')return true;throw failure;}
}

async function processInventory(policy){
 const expected=path.join(policy.releaseRoot,'src/postgres/quant-research-main.js');
 const entries=await fs.readdir('/proc',{withFileTypes:true});
 for(const entry of entries){
  if(!entry.isDirectory()||!/^\d+$/.test(entry.name))continue;
  let argv;
  try{argv=(await fs.readFile('/proc/'+entry.name+'/cmdline','utf8')).split('\0').filter(Boolean);}
  catch(failure){if(failure.code==='ENOENT'||failure.code==='ESRCH')continue;throw failure;}
  if(argv.some(arg=>path.isAbsolute(arg)&&path.normalize(arg)===expected)||
     (argv.some(arg=>path.basename(arg)==='systemd-run')&&argv.some(arg=>arg.includes('robot-quant-'))))
   throw error('RECOVERY_LAUNCHER_STILL_RUNNING');
 }
}

export async function loadQuantRecoveryPolicy(filename=process.env.QUANT_RECOVERY_POLICY_FILE){
 if(process.platform!=='linux')throw error('RECOVERY_LINUX_REQUIRED');
 if(typeof filename!=='string'||!path.isAbsolute(filename))throw error('RECOVERY_POLICY_REQUIRED');
 const info=await fs.lstat(filename);
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o022))throw error('RECOVERY_POLICY_UNTRUSTED');
 const policy=JSON.parse(await fs.readFile(filename,'utf8'));
 if(Object.keys(policy).sort().join(',')!=='releaseRoot,workerUnit'||!unitPattern.test(policy.workerUnit)||
   transientPattern.test(policy.workerUnit)||typeof policy.releaseRoot!=='string'||!path.isAbsolute(policy.releaseRoot)||
   await fs.realpath(policy.releaseRoot)!==policy.releaseRoot)throw error('RECOVERY_POLICY_INVALID');
 return Object.freeze({workerUnit:policy.workerUnit,releaseRoot:policy.releaseRoot});
}

/** Startup guard: only the reviewed user service may own the Quant launcher. */
export async function assertQuantWorkerUnit(unitName,{policy,manager=systemd,selfCgroup}={}){
 if(process.platform!=='linux'&&manager===systemd)throw error('RECOVERY_LINUX_REQUIRED');
 policy??=await loadQuantRecoveryPolicy();
 if(unitName!==policy.workerUnit)throw error('QUANT_WORKER_UNIT_MISMATCH');
 if(policy.releaseRoot){
  const expected=path.join(policy.releaseRoot,'src/postgres/quant-research-main.js');
  if(await fs.realpath(process.argv[1])!==expected)throw error('QUANT_WORKER_RELEASE_MISMATCH');
 }
 const state=await manager.show(unitName);
 const cgroup=selfCgroup??(await fs.readFile('/proc/self/cgroup','utf8')).match(/^0::(.+)$/m)?.[1];
 if(state.LoadState!=='loaded'||state.ActiveState!=='active'||state.KillMode!=='control-group'||
    Number(state.MainPID)!==process.pid||!state.ControlGroup||cgroup!==state.ControlGroup)
  throw error('QUANT_WORKER_UNIT_UNVERIFIED');
 return true;
}

async function assertStopped(manager,unit,{masked=false}={}){
 const state=await manager.show(unit);
 if(masked&&state.LoadState!=='masked')throw error('RECOVERY_UNIT_NOT_MASKED');
 if(!['inactive','failed'].includes(state.ActiveState)||!['','0'].includes(state.Job??''))throw error('RECOVERY_UNIT_ACTIVE');
 if(!await groupEmpty(state.ControlGroup))throw error('RECOVERY_CGROUP_POPULATED');
 return state;
}

async function assertNoJobs(manager,units){
 const jobs=await manager.jobs();
 if(units.some(unit=>jobs.includes(unit)))throw error('RECOVERY_PENDING_START');
}

/** Pin exclusive maintenance lock to the connection used by every recovery write. */
export async function withQuantOfflineGuard({db,policy,manager=systemd,inventory=processInventory,settleMs=100}={},callback){
 if(process.platform!=='linux'&&manager===systemd)throw error('RECOVERY_LINUX_REQUIRED');
 if(!db?.pool||!policy||!unitPattern.test(policy.workerUnit)||typeof callback!=='function')throw error('RECOVERY_INVALID_REQUEST');
 const client=await db.pool.connect();let locked=false,lost=false;
 const connectionLost=()=>{lost=true;};client.on('error',connectionLost);
 const query=async(sql,params)=>{
  if(lost)throw error('RECOVERY_MAINTENANCE_LOCK_LOST');
  const result=await client.query(sql,params);
  if(lost)throw error('RECOVERY_MAINTENANCE_LOCK_LOST');
  return result;
 };
 const assertExclusive=async()=>{
  if(lost)throw error('RECOVERY_MAINTENANCE_LOCK_LOST');
  await query('SELECT 1');
  await assertStopped(manager,policy.workerUnit,{masked:true});
  await assertNoJobs(manager,[policy.workerUnit]);
  await inventory(policy);
  if(lost)throw error('RECOVERY_MAINTENANCE_LOCK_LOST');
  await query('SELECT 1');
  if(lost)throw error('RECOVERY_MAINTENANCE_LOCK_LOST');
  return true;
 };
 try{
  const acquired=(await query("SELECT pg_try_advisory_lock(hashtextextended('robot:maintenance',0)) ok")).rows[0]?.ok;
  if(!acquired)throw error('RECOVERY_RUNTIME_ACTIVE');
  locked=true;
  for(let check=0;check<2;check++){await assertExclusive();if(check===0)await pause(settleMs);}
  const result=await callback({query,assertExclusive,manager,inventory});
  await assertExclusive();
  return result;
 }finally{
  if(locked&&!lost)await client.query("SELECT pg_advisory_unlock(hashtextextended('robot:maintenance',0))").catch(()=>{});
  client.removeListener('error',connectionLost);client.release(lost);
 }
}

function verifyRows(rows,chunksByRun){
 const units=[];
 for(const row of rows){
  if(!row.run_id||row.run_id!==String(row.job_id)||!row.lease_token||
     hash(canonical(row.contract))!==row.contract_hash||
     !row.research_contract||hash(canonical(row.research_contract))!==row.research_job_hash||
     row.research_contract_hash!==row.research_job_hash)throw error('RECOVERY_BINDING_UNVERIFIED');
  const checkpoint=row.checkpoint;
  if(checkpoint){
   const {sha256,...payload}=checkpoint;
   if(hash(canonical(payload))!==sha256||payload.next_bar!==row.next_bar||
      payload.dataset_id!==row.contract.dataset.dataset_id||
      payload.dataset_sha256!==row.contract.dataset.sha256||
      payload.engine_hash!==row.contract.engine_hash||payload.snapshot_hash!==row.contract.snapshot_hash||
      !Number.isSafeInteger(payload.next_bar)||payload.next_bar<1||
      payload.next_bar>row.contract.dataset.metadata.total_bars||
      Buffer.byteLength(JSON.stringify(payload.state))>row.contract.budget.max_state_bytes)
    throw error('RECOVERY_CHECKPOINT_CORRUPT');
  }else if(row.next_bar!==0)throw error('RECOVERY_CHECKPOINT_CORRUPT');
  for(const chunk of chunksByRun.get(row.run_id)??[]){
   if(chunk.identity_hash!==hash(canonical({contract:row.research_contract,parameters:chunk.parameters,kind:chunk.kind})))
    throw error('RECOVERY_CHUNK_CORRUPT');
   if(chunk.checkpoint){
    if(hash(canonical(chunk.checkpoint))!==chunk.checkpoint_hash||chunk.checkpoint.next_bar!==chunk.next_bar||
       !/^[a-f0-9]{64}$/.test(chunk.checkpoint.identity)||chunk.checkpoint.version!=='research-chunk-v1'||
       Buffer.byteLength(JSON.stringify(chunk.checkpoint))>row.contract.budget.max_state_bytes)
     throw error('RECOVERY_CHUNK_CORRUPT');
    // Python verifies its own integrity and identity when the resumed chunk runs.
   }else if(chunk.next_bar!==0)throw error('RECOVERY_CHUNK_CORRUPT');
   if(chunk.unit_name){
    if(!transientPattern.test(chunk.unit_name)||chunk.unit_token!==row.lease_token)
     throw error('RECOVERY_UNIT_INVALID');
    units.push(chunk.unit_name);
   }else if(chunk.unit_token)throw error('RECOVERY_UNIT_INVALID');
  }
 }
 return [...new Set(units)];
}

async function snapshot(query){
 const rows=(await query(`SELECT f.*,r.run_id,r.contract_hash AS research_contract_hash,
    q.contract AS research_contract,q.contract_hash AS research_job_hash
    FROM quant_foundation_jobs f LEFT JOIN quant_research_foundation r ON r.job_id=f.job_id
    LEFT JOIN quant_jobs q ON q.run_id=r.run_id WHERE f.status IN ('RUNNING','STOPPING') ORDER BY f.job_id`)).rows;
 const chunksByRun=new Map();
 for(const row of rows)chunksByRun.set(row.run_id,(await query(
  'SELECT * FROM quant_research_chunks WHERE run_id=$1',[row.run_id])).rows);
 return {rows,chunksByRun,units:verifyRows(rows,chunksByRun)};
}

/** Offline command. Exclusive session lock excludes all upgraded API/workers.
 * Caller must stop and runtime-mask the reviewed Quant worker service first.
 * Old transient names stay masked for the current boot after recovery.
 */
export async function recoverQuantFoundation({db,policy,manager=systemd,inventory=processInventory,settleMs=100}={}){
 return withQuantOfflineGuard({db,policy,manager,inventory,settleMs},async({query,assertExclusive})=>{
  const first=await snapshot(query);
  await assertNoJobs(manager,[policy.workerUnit,...first.units]);
  for(const unit of first.units){
   const state=await manager.show(unit);
   if(state.LoadState==='loaded'){
    if(['active','activating','deactivating'].includes(state.ActiveState))await manager.kill(unit);
    await manager.stop(unit);
   }
   await manager.mask(unit);
   await assertStopped(manager,unit,{masked:true});
  }
  for(let check=0;check<2;check++){
   await assertExclusive();
   for(const unit of first.units)await assertStopped(manager,unit,{masked:true});
   await assertNoJobs(manager,first.units);
   if(check===0)await pause(settleMs);
  }
  await assertExclusive();
  await query('BEGIN');
  try{
   await query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
   const second=await snapshot(query);
   if(canonical(second.rows)!==canonical(first.rows)||canonical(second.units)!==canonical(first.units))
    throw error('RECOVERY_STATE_CHANGED');
   const done=[];
   for(const row of second.rows){
    const now=Date.now();
    if(row.status==='RUNNING'){
     await query(`UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,
       runtime_used_ms=runtime_used_ms+GREATEST(0,$2-run_started_at),run_started_at=NULL WHERE job_id=$1 AND status='RUNNING' AND lease_token=$3`,
       [row.job_id,now,row.lease_token]);
    }
    const reason=row.status==='RUNNING'?'LEASE_EXPIRED':row.stop_reason;
    const status=['LEASE_EXPIRED','HEALTH_UNAVAILABLE'].includes(reason)&&row.attempts<3&&
      row.deadline_at>now&&row.runtime_used_ms+(row.run_started_at?Math.max(0,now-row.run_started_at):0)<row.contract.budget.max_runtime_ms?
      'PAUSED':'CANCELLED';
    const updated=await query(`UPDATE quant_foundation_jobs SET status=$2,stop_reason=NULL,
      worker_id=NULL,lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND status='STOPPING' AND lease_token=$3`,
      [row.job_id,status,row.lease_token]);
    if(updated.rowCount!==1)throw error('RECOVERY_LEASE_CHANGED');
    const cleared=await query(`UPDATE quant_research_chunks SET unit_name=NULL,unit_token=NULL
      WHERE run_id=$1 AND unit_token=$2 AND unit_name IS NOT NULL`,[row.run_id,row.lease_token]);
    if(cleared.rowCount!==second.chunksByRun.get(row.run_id).filter(chunk=>chunk.unit_name).length)
      throw error('RECOVERY_UNIT_STATE_CHANGED');
    if(status==='PAUSED')await query(`UPDATE quant_jobs SET status='QUEUED',lease_token=NULL,lease_until=0,updated_at=$2
      WHERE run_id=$1 AND status='RUNNING' AND lease_token=$3`,[row.run_id,now,row.lease_token]);
    else await query(`UPDATE quant_jobs SET status=CASE WHEN $2::bigint>=deadline THEN 'TIMED_OUT' ELSE 'FAILED' END,
      diagnostic=COALESCE(diagnostic,CASE WHEN $2::bigint>=deadline THEN 'JOB_DEADLINE_EXCEEDED' ELSE 'FOUNDATION_CANCELLED' END),
      lease_token=NULL,lease_until=0,updated_at=$2 WHERE run_id=$1 AND status IN ('QUEUED','RUNNING')`,[row.run_id,now]);
    done.push({job_id:row.job_id,status});
   }
   await query('SELECT 1');
   await query('COMMIT');
   return {recovered:done,maskedUnits:first.units};
  }catch(failure){await query('ROLLBACK').catch(()=>{});throw failure;}
 });
}
