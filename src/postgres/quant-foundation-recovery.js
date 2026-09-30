import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical,hash} from '../pine-bridge/source.js';
import {validateBackfillState} from '../quant-research/foundation-contract.js';
import {crashIoOperation,acknowledgeIoCrashStop} from '../quant-research/io-budget-ledger.js';
import {QuantIoLedger} from './quant-io-ledger.js';
import {quantIoUnitName} from './quant-io-runtime.js';

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

// The cgroup mount is injectable through manager.cgroupRoot so tests can read a fake tree.
async function groupEmpty(group,cgroupRoot='/sys/fs/cgroup'){
 if(!group)return true;
 if(!group.startsWith('/')||group.includes('..'))throw error('RECOVERY_INVALID_CGROUP');
 const root=path.resolve(cgroupRoot);
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
 if(!await groupEmpty(state.ControlGroup,manager.cgroupRoot))throw error('RECOVERY_CGROUP_POPULATED');
 return state;
}

async function assertNoJobs(manager,units){
 const jobs=await manager.jobs();
 if(units.some(unit=>jobs.includes(unit)))throw error('RECOVERY_PENDING_START');
}

/** Kill and stop a live or loaded unit, mask it for this boot, then prove it inactive, masked and cgroup-free.
 * A masked unit that is still active (a partial earlier run) is killed too. Returns whether the unit was live.
 */
async function retireUnit(manager,unit){
 const state=await manager.show(unit);
 const live=['active','activating','deactivating'].includes(state.ActiveState);
 if(live)await manager.kill(unit);
 if(live||state.LoadState==='loaded')await manager.stop(unit);
 await manager.mask(unit);
 await assertStopped(manager,unit,{masked:true});
 return live;
}

// I/O-aware recovery. A PROFILE v2 row holds I/O state when it has a launch intent or a ledger operation.
// Every crash point of a mid-terminal parent leaves such a row: the release trigger blocks a plain release.
const ioUnitPattern=/^robot-quant-[a-f0-9]{64}[.]service$/;
const ioUnresolved=['RESERVED','ACTIVE','STOP_REQUIRED'];
const ioError=(code,operationId=null)=>Object.assign(error(code),{operationId});
const isProfileV2=row=>row.contract?.kind==='PROFILE'&&row.contract?.version==='quant-foundation-v2';
const ioStopProof=(jobId,operationId,unitName)=>hash(canonical({version:'quant-io-recovery-stop-proof-v1',
 jobId,operationId,unitName,unitMasked:true,cgroupEmpty:true,pendingStartsExcluded:true,launcherInventoryEmpty:true}));
// The ledger class supplies its own row checks and revision-checked write. Its db adapter here is the
// pinned recovery connection inside the caller's transaction, never the pool.
const ioLedger=query=>new QuantIoLedger({db:{isTransaction:true,transaction:async callback=>callback(),query}});

/** The quant_io_* tables are optional. Without both, no PROFILE row can hold I/O state. */
async function ioTablesPresent(query){
 const found=(await query("SELECT to_regclass('quant_io_ledgers') IS NOT NULL AND to_regclass('quant_io_launches') IS NOT NULL AS present")).rows[0];
 return found?.present===true;
}

async function loadIo(query,jobId,{lock=false}={}){
 const suffix=lock?' FOR UPDATE':'';
 const job=(await query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1'+suffix,[jobId])).rows[0]??null;
 const ledger=(await query('SELECT * FROM quant_io_ledgers WHERE job_id=$1'+suffix,[jobId])).rows[0]??null;
 const launches=(await query('SELECT * FROM quant_io_launches WHERE job_id=$1 ORDER BY operation_id'+suffix,[jobId])).rows;
 return {job,ledger,launches};
}

const holdsIo=evidence=>evidence.launches.length>0||
 (evidence.ledger!==null&&!(Array.isArray(evidence.ledger.state?.operations)&&evidence.ledger.state.operations.length===0));

/** Fail-closed binding check of one I/O row. Throws with the blocking operation id when known. */
function planIo({row,evidence},ledger){
 verifyProfile(row);
 const {job,ledger:ledgerRow,launches}=evidence;
 if(!job||job.status!==row.status||job.lease_token!==row.lease_token||!ledgerRow)throw ioError('RECOVERY_IO_STATE_INCONSISTENT');
 ledger.terminalCheck(job,ledgerRow);
 const state=ledger.check(ledgerRow,job.job_id);
 if(ledgerRow.lease_token!==job.lease_token||state.lease_token!==job.lease_token)throw ioError('RECOVERY_IO_STATE_INCONSISTENT');
 const operations=[];
 for(const launch of launches){
  const operation=state.operations.find(item=>item.operation_id===launch.operation_id);
  if(!operation||launch.lease_token!==job.lease_token||!ioUnitPattern.test(launch.unit_name)||
     launch.unit_name!==quantIoUnitName(job.job_id,launch.operation_id)||operation.cgroup_id!==launch.unit_name)
   throw ioError('RECOVERY_IO_STATE_INCONSISTENT',launch.operation_id);
  operations.push({operationId:launch.operation_id,unitName:launch.unit_name,launchState:launch.state});
 }
 for(const operation of state.operations)if(!launches.some(launch=>launch.operation_id===operation.operation_id))
  throw ioError('RECOVERY_IO_STATE_INCONSISTENT',operation.operation_id);
 return {operations};
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

function verifyProfile(row){
 if(!row.lease_token||hash(canonical(row.contract))!==row.contract_hash||row.run_id||row.research_contract)
  throw error('RECOVERY_BINDING_UNVERIFIED');
 // Profile conversion publishes atomically and restarts from its immutable input.
 if(row.checkpoint||row.next_bar!==0)throw error('RECOVERY_CHECKPOINT_CORRUPT');
}

function verifyRows(rows,chunksByRun){
 const units=[];
 for(const row of rows){
  if(row.contract?.kind==='PROFILE'){verifyProfile(row);continue;}
  if(row.contract?.kind==='BACKFILL'){
   if(!row.lease_token||hash(canonical(row.contract))!==row.contract_hash||row.run_id||row.research_contract)throw error('RECOVERY_BINDING_UNVERIFIED');
   if(row.checkpoint){
    const {sha256,...payload}=row.checkpoint;
    if(hash(canonical(payload))!==sha256||payload.next_bar!==row.next_bar||
      payload.engine_hash!==row.contract.engine_hash||payload.snapshot_hash!==row.contract.snapshot_hash||
      Buffer.byteLength(JSON.stringify(payload.state))>row.contract.budget.max_state_bytes)
      throw error('RECOVERY_CHECKPOINT_CORRUPT');
    try{validateBackfillState(row.contract,row.next_bar,payload.state);}catch{throw error('RECOVERY_CHECKPOINT_CORRUPT');}
   }else if(row.next_bar!==0)throw error('RECOVERY_CHECKPOINT_CORRUPT');
   continue;
  }
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
 // Rows holding I/O state recover per row; every other row keeps the single-transaction path.
 const plain=[],io=[];
 const tables=rows.some(row=>isProfileV2(row))&&await ioTablesPresent(query);
 for(const row of rows){
  if(tables&&isProfileV2(row)){
   const evidence=await loadIo(query,row.job_id);
   if(holdsIo(evidence)){io.push({row,evidence});continue;}
  }
  plain.push(row);
 }
 const chunksByRun=new Map();
 for(const row of plain)if(!['BACKFILL','PROFILE'].includes(row.contract?.kind))chunksByRun.set(row.run_id,(await query(
  'SELECT * FROM quant_research_chunks WHERE run_id=$1',[row.run_id])).rows);
 return {rows,plain,io,chunksByRun,units:verifyRows(plain,chunksByRun)};
}

/** One transaction body for one I/O row. Caller holds BEGIN and the scheduler singleton lock.
 * Unresolved operation: unknown-final crash charge plus crash-stop acknowledgement, never a measured settle.
 * SETTLED, CRASHED_UNCONFIRMED and CRASHED operations get no second charge. The job ends CANCELLED:
 * reserve is refused after unknown-final and after any settled operation, so PAUSED could not relaunch.
 */
async function finishIo(query,item,now){
 const ledger=ioLedger(query),evidence=await loadIo(query,item.row.job_id,{lock:true});
 if(canonical(evidence)!==canonical(item.evidence))throw ioError('RECOVERY_STATE_CHANGED');
 const job=evidence.job,outcomes=[];
 let state=ledger.check(evidence.ledger,job.job_id);
 const find=id=>state.operations.find(candidate=>candidate.operation_id===id);
 for(const step of item.plan.operations){
  try{
   const proof=ioStopProof(job.job_id,step.operationId,step.unitName);
   let operation=find(step.operationId);
   const identity={operation_id:operation.operation_id,lease_token:job.lease_token,
    cgroup_id:operation.cgroup_id,cgroup_inode:operation.cgroup_inode};
   if(ioUnresolved.includes(operation.status)){
    const crashed=crashIoOperation(state,{...identity,crash_evidence_sha256:proof});
    await ledger.write(job.job_id,state.revision,crashed);state=crashed;operation=find(step.operationId);
   }
   if(operation.status==='CRASHED_UNCONFIRMED'){
    const acknowledged=acknowledgeIoCrashStop(state,{...identity,stop_proof_sha256:proof});
    await ledger.write(job.job_id,state.revision,acknowledged);state=acknowledged;operation=find(step.operationId);
   }
   if(!['SETTLED','CRASHED'].includes(operation.status))throw ioError('RECOVERY_IO_STATE_INCONSISTENT');
   if(step.launchState!=='STOP_PROVEN'){
    const proven=await query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1 AND operation_id=$2 AND state=$3",
     [job.job_id,step.operationId,step.launchState]);
    if(proven.rowCount!==1)throw ioError('RECOVERY_STATE_CHANGED');
   }
   // A settled operation is never charged again. If its unit was still live at recovery, the I/O after the
   // settlement is unaccounted, and the proof label says so.
   const settled=operation.status==='SETTLED';
   outcomes.push({operation_id:step.operationId,
    proof:settled?(step.unitWasLive?'MEASURED_FINAL_SETTLED_UNIT_WAS_LIVE':'MEASURED_FINAL_SETTLED'):'UNKNOWN_FINAL_CHARGED'});
  }catch(failure){
   if(failure&&typeof failure==='object'&&failure.operationId==null)failure.operationId=step.operationId;
   throw failure;
  }
 }
 if(job.status==='RUNNING'){
  await query(`UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,
    runtime_used_ms=runtime_used_ms+GREATEST(0,$2-run_started_at),run_started_at=NULL WHERE job_id=$1 AND status='RUNNING' AND lease_token=$3`,
    [job.job_id,now,job.lease_token]);
 }
 const released=await query(`UPDATE quant_foundation_jobs SET status='CANCELLED',stop_reason=NULL,
   worker_id=NULL,lease_token=NULL,lease_until=NULL WHERE job_id=$1 AND status='STOPPING' AND lease_token=$2`,[job.job_id,job.lease_token]);
 if(released.rowCount!==1)throw error('RECOVERY_LEASE_CHANGED');
 return outcomes;
}

/** Per-row recovery of I/O rows under the caller's offline guard. A failing row is reported and left
 * STOPPING; the other rows continue. Only a lost maintenance lock aborts the whole command.
 */
async function recoverIoRows({query,assertExclusive,manager,settleMs,items}){
 const recovered=[],blocked=[],masked=[];
 const block=(item,failure,operationId=null)=>{
  if(failure?.code==='RECOVERY_MAINTENANCE_LOCK_LOST')throw failure;
  blocked.push({job_id:item.row.job_id,operation_id:failure?.operationId??operationId,
   code:failure?.code??'RECOVERY_IO_ROW_FAILED'});
 };
 let live=[];
 for(const item of items){
  let operationId=null;
  try{
   item.plan=planIo(item,ioLedger(query));
   for(const step of item.plan.operations){operationId=step.operationId;await assertNoJobs(manager,[step.unitName]);}
   for(const step of item.plan.operations){operationId=step.operationId;step.unitWasLive=await retireUnit(manager,step.unitName);masked.push(step.unitName);}
   live.push(item);
  }catch(failure){block(item,failure,operationId);}
 }
 if(live.length===0)return {recovered,blocked,masked};
 for(let check=0;check<2;check++){
  await assertExclusive();
  const still=[];
  for(const item of live){
   let operationId=null;
   try{
    for(const step of item.plan.operations){
     operationId=step.operationId;
     await assertStopped(manager,step.unitName,{masked:true});
     await assertNoJobs(manager,[step.unitName]);
    }
    still.push(item);
   }catch(failure){block(item,failure,operationId);}
  }
  live=still;
  if(check===0)await pause(settleMs);
 }
 for(const item of live){
  await assertExclusive();
  await query('BEGIN');
  try{
   await query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
   const outcomes=await finishIo(query,item,Date.now());
   await query('SELECT 1');
   await query('COMMIT');
   recovered.push({job_id:item.row.job_id,status:'CANCELLED',io:outcomes});
  }catch(failure){
   await query('ROLLBACK').catch(()=>{});
   block(item,failure);
  }
 }
 return {recovered,blocked,masked};
}

/** Offline command. Exclusive session lock excludes all upgraded API/workers.
 * Caller must stop and runtime-mask the reviewed Quant worker service first.
 * Old transient names stay masked for the current boot after recovery.
 * PROFILE v2 rows with launch intent or ledger operations recover per row (see finishIo): launch unit
 * stopped, killed and masked, then one transaction per row. A row that cannot prove stop stays STOPPING;
 * after all rows ran, the command throws RECOVERY_IO_ROW_BLOCKED with the blocking rows in `blocked`.
 */
export async function recoverQuantFoundation({db,policy,manager=systemd,inventory=processInventory,settleMs=100}={}){
 const outcome=await withQuantOfflineGuard({db,policy,manager,inventory,settleMs},async({query,assertExclusive})=>{
  const first=await snapshot(query);
  await assertNoJobs(manager,[policy.workerUnit,...first.units]);
  for(const unit of first.units)await retireUnit(manager,unit);
  for(let check=0;check<2;check++){
   await assertExclusive();
   for(const unit of first.units)await assertStopped(manager,unit,{masked:true});
   await assertNoJobs(manager,first.units);
   if(check===0)await pause(settleMs);
  }
  await assertExclusive();
  await query('BEGIN');
  const done=[];
  try{
   await query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
   const second=await snapshot(query);
   if(canonical(second.rows)!==canonical(first.rows)||canonical(second.units)!==canonical(first.units)||
    canonical(second.io.map(item=>item.evidence))!==canonical(first.io.map(item=>item.evidence)))
    throw error('RECOVERY_STATE_CHANGED');
   for(const row of second.plain){
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
    if(['BACKFILL','PROFILE'].includes(row.contract.kind)){done.push({job_id:row.job_id,status});continue;}
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
  }catch(failure){await query('ROLLBACK').catch(()=>{});throw failure;}
  const io=first.io.length===0?{recovered:[],blocked:[],masked:[]}:
   await recoverIoRows({query,assertExclusive,manager,settleMs,items:first.io});
  return {recovered:[...done,...io.recovered],maskedUnits:[...first.units,...io.masked],blocked:io.blocked};
 });
 // Thrown after the guard's final exclusivity check, so row work that already committed is post-checked too.
 const {blocked,...result}=outcome;
 if(blocked.length)throw Object.assign(error('RECOVERY_IO_ROW_BLOCKED'),{...result,blocked});
 return result;
}
