import fs from 'node:fs/promises';
import {constants,realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical,hash,fail} from '../src/pine-bridge/source.js';
import {strictJsonV2,fieldsV2,frozenV2,validateFoundationRequestV2} from '../src/quant-research/foundation-contract-v2.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {loadQuantCapacityPolicy,validateQuantCapacityPolicy} from '../src/postgres/quant-capacity-policy.js';

/**
 * Owner-only enqueue helper for the W7 product Linux proof. It creates exactly one unmarked PROFILE V2 job
 * (no enrollment completion_mode) from trusted raw-backfill and deployment records, so the product worker can run
 * it in diagnostic mode. The worker ends such a job CANCELLED with a null SQL result.
 *
 * The request file selects existing records only: owner, bot, raw job, deployment and an idempotency key. It can
 * never carry execution fields, result bytes or capacity policy. The reviewed policy comes from
 * QUANT_CAPACITY_POLICY_FILE, and the contract is built here from the stored records, exactly as
 * QuantProfileService.enqueueEnrollment builds the enrollment contract but without the completion mode.
 *
 * Usage, on the Linux staging host with the private staging environment loaded:
 *   node scripts/enqueue-quant-profile-diagnostic.mjs /absolute/private/request.json
 *     Dry run, the default. Rolls back, writes nothing and prints one redacted JSON plan.
 *   node scripts/enqueue-quant-profile-diagnostic.mjs /absolute/private/request.json
 *     --enqueue --expect-contract-hash=CONTRACT_HASH_FROM_THE_DRY_RUN
 *     Writes one owner row (when absent) and one QUEUED job. The expected hash binds the write to the reviewed plan.
 *
 * Every outcome is one JSON line on standard output: exit code 0 for a plan or an enqueue, 2 for a refusal.
 * The line holds hashes, counts, enumerations and the job identity only. It never holds paths, hosts, database
 * URLs, SQL, record identifiers other than the job, or error messages.
 *
 * Refusal codes are fixed strings. Own codes, each prefixed QUANT_DIAGNOSTIC_: USAGE, CONFIGURATION_REQUIRED,
 * PRIVATE_FILE_REQUIRED, PRIVATE_FILE_UNTRUSTED, REQUEST_INVALID, PLAN_REQUIRED, PLAN_MISMATCH, SCHEMA_REQUIRED,
 * LOCK_TIMEOUT, CAPACITY_UNSUPPORTED, AUTHORITY_REFUSED, IDEMPOTENCY_AMBIGUOUS, BOT_ACTIVE, NOT_IDLE,
 * QUEUE_NOT_EMPTY, STATE_INVALID, INSERT_FAILED, and FAILED for any driver or system fault. Product refusals pass
 * through unchanged: IDEMPOTENCY_CONFLICT, FOUNDATION_INVALID_CLOCK, QUANT_CAPACITY_POLICY_*, NOT_FOUND,
 * BACKFILL_RESULT_UNAVAILABLE and the deployment refusals of QuantProfileService.deployment.
 *
 * The sqlstate field is null except for a fault reported by the PostgreSQL server (refusal FAILED), where it holds
 * the five-character SQLSTATE alone. It tells a serialization failure (40001, run the command again) from a missing
 * privilege (42501, fix the grant). It never holds a message.
 *
 * A failure reported as QUANT_DIAGNOSTIC_FAILED during a write may have happened while the commit was in flight.
 * Run the same command again before doing anything else: the idempotency key returns the job if it exists.
 * The worker must be stopped while this runs. The command takes the scheduler table lock for the length of its
 * transaction but waits for it at most 1000 ms (LOCK_TIMEOUT means a worker still holds it: try again later).
 * Right after the idempotency lookup it refuses unless the queue is empty and nothing is executing or unresolved,
 * before the raw, deployment, contract and authority work.
 * The request file must belong to the running user. Every directory above it must belong to the running user or
 * root, and no directory above it may be writable by group or other.
 */

export const DIAGNOSTIC_PLAN_VERSION='quant-profile-diagnostic-plan-v1';

const MAX_RAW_BARS=10000;
const SEED_BARS=500;
const MAX_REQUEST_BYTES=16384;
// The worker refuses a job with less than runtime_max_ms plus this margin before its deadline (PROFILE_DEADLINE_NEAR).
const DEADLINE_MARGIN_MS=5000;
// Longest wait for the scheduler table lock. A pending EXCLUSIVE request also queues every later scheduler lock
// request behind it, including a worker terminal commit, so the wait must stay short.
const LOCK_TIMEOUT_MS=1000;
const LOCK_TIMEOUT_SQL=`SET LOCAL lock_timeout='${LOCK_TIMEOUT_MS}ms'`;
// SQLSTATE lock_not_available, raised when a lock wait hits lock_timeout.
const LOCK_TIMEOUT_SQLSTATE='55P03';
const ACTIVE=['QUEUED','PAUSED','RUNNING','STOPPING'];
const CODE=/^[A-Z][A-Z0-9_]{2,80}$/;
const SQLSTATE=/^[0-9A-Z]{5}$/;
const SHA=/^[a-f0-9]{64}$/;
const OWNER_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RAW_JOB_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Same shape that validateProfileSpecV2 accepts for a stored deployment identifier.
const DEPLOYMENT_ID=/^[A-Za-z0-9-]{8,128}$/;
const IDEMPOTENCY_KEY=/^[A-Za-z0-9_-]{8,128}$/;
const REQUEST_FIELDS=['owner_id','bot_id','raw_job_id','deployment_id','idempotency_key'];
const FLAGS_ON=['PINE_BRIDGE_ENABLED','QUANT_RESEARCH_ENABLED','QUANT_RESEARCH_FOUNDATION_ENABLED','QUANT_PROFILE_V2_ENABLED'];
const FLAGS_OFF=['QUANT_PROFILE_V2_ENROLLMENT_ENABLED','QUANT_PREFLIGHT_ENABLED'];
const SETTINGS=['DATABASE_URL','QUANT_CAPACITY_POLICY_FILE','QUANT_STORAGE_LIMITS_FILE','QUANT_RESEARCH_DATASET_ROOT'];

const TABLES_SQL=`SELECT to_regclass('public.quant_foundation_scheduler') scheduler,
  to_regclass('public.quant_foundation_jobs') jobs,to_regclass('public.quant_io_ledgers') ledgers,
  to_regclass('public.quant_io_launches') launches`;
const PREVIOUS_SQL='SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2';
// One read of everything that must be idle. A ledger whose operations value is not an array reports invalid
// instead of raising, so the flag stays meaningful.
const GATE_SQL=`SELECT
  (SELECT count(*)::int FROM quant_foundation_jobs
    WHERE owner_id=$1 AND contract->>'bot_id'=$2 AND status=ANY($3::text[])) bot_active,
  (SELECT count(*)::int FROM quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')) executing,
  (SELECT count(*)::int FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED')) waiting,
  EXISTS(SELECT 1 FROM quant_io_launches WHERE state<>'STOP_PROVEN') launches,
  EXISTS(SELECT 1 FROM quant_io_ledgers
    WHERE pg_catalog.jsonb_typeof(state->'operations') IS DISTINCT FROM 'array') invalid,
  EXISTS(SELECT 1 FROM quant_io_ledgers l,
    LATERAL pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(l.state->'operations')='array'
      THEN l.state->'operations' ELSE '[]'::jsonb END) op
    WHERE COALESCE(op->>'status','') NOT IN ('SETTLED','CRASHED')) operations`;

const refuse=code=>{throw fail(code);};
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
// A coded refusal comes from fail(): a stable code plus an integer status. Driver and system errors have neither.
const isRefusal=error=>matches(CODE,error?.code)&&Number.isInteger(error.status);
const publicCode=error=>isRefusal(error)?error.code:'QUANT_DIAGNOSTIC_FAILED';
// The PostgreSQL SQLSTATE of a server fault and nothing else. The server always sends a severity with the code. Node
// system errors never do, so a five-letter code such as EPERM or ELOOP is not mistaken for a SQLSTATE.
const publicSqlstate=error=>!isRefusal(error)&&matches(SQLSTATE,error?.code)&&typeof error.severity==='string'?
  error.code:null;
const DRY_RUN=Symbol('dry-run rollback');

const blankPlan=()=>({version:DIAGNOSTIC_PLAN_VERSION,ok:false,mode:null,outcome:null,refusal:null,
  request_sha256:null,contract_hash:null,policy_hash:null,engine_hash:null,raw_bars:null,claim_window_ms:null,
  completion_mode:null,evaluator_admission:false,job_id:null,job_status:null,reused:false});

/** Owner input selects existing authoritative records, never execution fields, result bytes or policy. */
export function validateDiagnosticRequest(value){
  let valid=false;
  try{
    strictJsonV2(value);fieldsV2(value,REQUEST_FIELDS);
    valid=matches(OWNER_ID,value.owner_id)&&matches(OWNER_ID,value.bot_id)&&matches(RAW_JOB_ID,value.raw_job_id)&&
      matches(DEPLOYMENT_ID,value.deployment_id)&&matches(IDEMPOTENCY_KEY,value.idempotency_key);
  }catch{valid=false;}
  if(!valid)refuse('QUANT_DIAGNOSTIC_REQUEST_INVALID');
  return frozenV2(value);
}

/** Explicit diagnostic-only environment. The command never changes these flags. */
export function assertDiagnosticEnvironment({environment=process.env,platform=process.platform}={}){
  const present=name=>typeof environment[name]==='string'&&environment[name].length>0;
  if(platform!=='linux'||environment.PINE_BRIDGE_ENV!=='staging'||environment.PAPER_TRADING!=='true'||
    !FLAGS_ON.every(name=>environment[name]==='1')||
    !FLAGS_OFF.every(name=>environment[name]===undefined||environment[name]==='0')||
    !SETTINGS.every(present))refuse('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED');
}

/** Arguments are one request path, then optionally --enqueue and --expect-contract-hash=<sha256>, each once.
 * A write requires the hash of the reviewed dry-run plan, so the command cannot write anything else.
 */
export function parseDiagnosticArguments(argv){
  if(!Array.isArray(argv)||argv.length<1||argv.length>3||typeof argv[0]!=='string'||argv[0].startsWith('--'))
    refuse('QUANT_DIAGNOSTIC_USAGE');
  let enqueue=false,expectContractHash=null;
  for(const option of argv.slice(1)){
    if(option==='--enqueue'&&!enqueue)enqueue=true;
    else if(typeof option==='string'&&option.startsWith('--expect-contract-hash=')&&expectContractHash===null)
      expectContractHash=option.slice('--expect-contract-hash='.length);
    else refuse('QUANT_DIAGNOSTIC_USAGE');
  }
  if(expectContractHash!==null&&!SHA.test(expectContractHash))refuse('QUANT_DIAGNOSTIC_USAGE');
  if(enqueue&&expectContractHash===null)refuse('QUANT_DIAGNOSTIC_PLAN_REQUIRED');
  return Object.freeze({requestFile:argv[0],enqueue,expectContractHash});
}

/** Every directory above the file must be a real directory that only the running user or root can change. Whoever
 * can write to one of them could swap what the path points to between the checks and the open.
 */
async function assertPrivateAncestors(filename,fileSystem,uid){
  for(let directory=path.posix.dirname(filename);;directory=path.posix.dirname(directory)){
    const info=await fileSystem.lstat(directory);
    if(!info.isDirectory()||(info.uid!==uid&&info.uid!==0)||(info.mode&0o022)!==0)
      refuse('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED');
    if(directory==='/')return;
  }
}

/** Reads the owner's request only from a private regular file on Linux. The path must be absolute and canonical
 * with no symbolic link anywhere in it. The file must belong to the running user, grant nothing to group or other,
 * have one link and stay small. Every directory above it must belong to the running user or root and must not be
 * writable by group or other. Every failure is a fixed code that names no path.
 * The fileSystem, platform, uid and openConstants seams exist for focused tests only.
 */
export async function readPrivateRequest(filename,{fileSystem=fs,platform=process.platform,
  uid=process.getuid?.(),openConstants=constants}={}){
  if(platform!=='linux'||!Number.isSafeInteger(uid))refuse('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED');
  if(typeof filename!=='string'||filename.includes('\0')||!path.posix.isAbsolute(filename)||
    path.posix.normalize(filename)!==filename||filename.endsWith('/'))refuse('QUANT_DIAGNOSTIC_PRIVATE_FILE_REQUIRED');
  let handle;
  try{
    const link=await fileSystem.lstat(filename);
    if(link.isSymbolicLink()||!link.isFile()||await fileSystem.realpath(filename)!==filename)
      refuse('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED');
    await assertPrivateAncestors(filename,fileSystem,uid);
    // O_NOFOLLOW makes the open itself refuse a link that appears after the checks above. O_NONBLOCK keeps a FIFO
    // that appears there from blocking the open for ever (the fstat below then refuses it). Node does not expose
    // O_CLOEXEC and libuv adds it to every open on POSIX, so the descriptor never reaches a child process anyway.
    handle=await fileSystem.open(filename,openConstants.O_RDONLY|(openConstants.O_NOFOLLOW??0)|
      (openConstants.O_NONBLOCK??0)|(openConstants.O_CLOEXEC??0));
    const info=await handle.stat();
    if(!info.isFile()||info.dev!==link.dev||info.ino!==link.ino||info.uid!==uid||(info.mode&0o077)!==0||
      info.nlink!==1||info.size>MAX_REQUEST_BYTES)refuse('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED');
    const text=await handle.readFile({encoding:'utf8'});
    if(typeof text!=='string'||Buffer.byteLength(text)>MAX_REQUEST_BYTES)refuse('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED');
    let value;
    try{value=JSON.parse(text);}catch{refuse('QUANT_DIAGNOSTIC_REQUEST_INVALID');}
    return validateDiagnosticRequest(value);
  }catch(error){
    throw isRefusal(error)?error:fail('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED');
  }finally{try{await handle?.close();}catch{/* Nothing left to release. */}}
}

async function defaultEngineHash(){
  const {ingestionEngineHash}=await import('../src/postgres/quant-data.js');
  return ingestionEngineHash();
}

function annotate(error,plan){
  // Carry the redacted plan known so far to the caller without making it part of the error text.
  if(error!==null&&typeof error==='object'&&Object.isExtensible(error))
    Object.defineProperty(error,'plan',{value:Object.freeze({...plan}),configurable:true});
  return error;
}

/** Trusted dependency seam for focused tests. The command line passes production constructors only.
 * One SERIALIZABLE transaction takes the scheduler lock, waiting at most LOCK_TIMEOUT_MS, looks up the idempotency
 * key and runs the idle gate. Only then do the raw, deployment, contract and authority checks run, so a busy system
 * is refused after a few statements. A dry run always rolls back. Only a write run with the reviewed contract hash
 * can add one owner row and one unmarked queued job. An existing job under the same idempotency key is returned
 * unchanged and nothing is written.
 * Every refusal throws a coded error carrying error.plan, the redacted plan known at that point. The plan of a gate
 * refusal has no contract hash yet, because the contract is built after the gate.
 */
export async function enqueueQuantProfileDiagnostic({db,profileService,policy,request,enqueue=false,
  expectContractHash=null,readEngineHash=defaultEngineHash,clock=Date.now}={}){
  const known=blankPlan();
  known.mode=enqueue===true?'enqueue':'dry-run';
  try{
    const selected=validateDiagnosticRequest(request);
    known.request_sha256=hash(canonical(selected));
    const approved=validateQuantCapacityPolicy(policy);
    known.policy_hash=capacityPolicyHash(approved);
    if(typeof enqueue!=='boolean'||!db?.query||!db.transaction||db.isTransaction||profileService?.db!==db||
      profileService.profileV2Enabled!==true||profileService.enrollmentEnabled!==false||
      canonical(profileService.capacityPolicy)!==canonical(approved))refuse('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED');
    if(expectContractHash!==null&&!matches(SHA,expectContractHash)||enqueue&&expectContractHash===null)
      refuse('QUANT_DIAGNOSTIC_PLAN_REQUIRED');
    const present=(await db.query(TABLES_SQL)).rows[0];
    if(!present||!['scheduler','jobs','ledgers','launches'].every(name=>present[name]))
      refuse('QUANT_DIAGNOSTIC_SCHEMA_REQUIRED');
    // Hash the executable closure before the transaction. Small file work still runs while the scheduler is locked:
    // the storage marker read in ready(), the raw manifest inspection and the engine re-hash inside authorizeV2. The
    // idle gate comes before the last two, so a busy system never waits for them.
    const engineHash=await readEngineHash();

    const reuse=row=>{
      const stored=row.contract;
      const same=row.owner_id===selected.owner_id&&stored?.version==='quant-foundation-v2'&&stored.kind==='PROFILE'&&
        !Object.hasOwn(stored,'completion_mode')&&stored.owner_id===selected.owner_id&&
        stored.bot_id===selected.bot_id&&stored.profile?.raw_job_id===selected.raw_job_id&&
        stored.profile.deployment_id===selected.deployment_id&&matches(SHA,row.contract_hash)&&
        hash(canonical(stored))===row.contract_hash;
      if(!same)refuse('IDEMPOTENCY_CONFLICT');
      Object.assign(known,{contract_hash:row.contract_hash,policy_hash:stored.capacity?.policy_hash??null,
        engine_hash:stored.engine_hash??null,raw_bars:stored.dataset?.metadata?.total_bars??null});
      if(expectContractHash!==null&&expectContractHash!==row.contract_hash)refuse('QUANT_DIAGNOSTIC_PLAN_MISMATCH');
      return {...known,ok:true,outcome:'EXISTING',job_id:row.job_id,job_status:row.status,reused:true};
    };

    const decide=async()=>{
      // A worker takes the scheduler lock at claim and when it commits a terminal, and a terminal commit has a hard
      // time limit. A pending EXCLUSIVE request also queues every later request for the lock behind it, so the wait is
      // bounded and a timeout is a refusal. SET takes no snapshot.
      await db.query(LOCK_TIMEOUT_SQL);
      // The table lock comes first so the serializable snapshot starts after any claim or enrollment that held the
      // scheduler. The row lock then mirrors the product enqueue paths.
      await db.query('LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE');
      await profileService.ready();
      if((await db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE')).rowCount!==1)
        refuse('QUANT_DIAGNOSTIC_SCHEMA_REQUIRED');
      await profileService.scope(selected.owner_id,selected.bot_id);
      const found=(await db.query(PREVIOUS_SQL,[selected.owner_id,selected.idempotency_key])).rows;
      if(found.length>1)refuse('QUANT_DIAGNOSTIC_IDEMPOTENCY_AMBIGUOUS');
      if(found.length===1)return reuse(found[0]);

      // The public V1 route accepts a PROFILE only under 100 active jobs and 20 per owner. This command is stricter:
      // an empty queue and an idle executor, so the diagnostic is the only work the worker can claim. The gate runs
      // before the raw, deployment, contract and authority work, so a busy system is refused after a few statements
      // and the scheduler lock goes back at once.
      const gate=(await db.query(GATE_SQL,[selected.owner_id,selected.bot_id,ACTIVE])).rows[0];
      if(!gate||!['bot_active','executing','waiting'].every(name=>Number.isSafeInteger(gate[name])&&gate[name]>=0)||
        !['launches','invalid','operations'].every(name=>typeof gate[name]==='boolean'))
        refuse('QUANT_DIAGNOSTIC_STATE_INVALID');
      if(gate.bot_active>0)refuse('QUANT_DIAGNOSTIC_BOT_ACTIVE');
      if(gate.executing>0||gate.launches||gate.invalid||gate.operations)refuse('QUANT_DIAGNOSTIC_NOT_IDLE');
      if(gate.waiting>0)refuse('QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY');

      const raw=await profileService.raw(selected.owner_id,selected.bot_id,selected.raw_job_id);
      const {deployment,evidence,source}=await profileService.deployment(selected.owner_id,selected.bot_id,
        selected.deployment_id);
      const metadata=raw.result.dataset.metadata,total=metadata.total_bars,model=evidence.execution_model;
      known.raw_bars=Number.isSafeInteger(total)?total:null;
      if(known.raw_bars===null||total>MAX_RAW_BARS)refuse('QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED');
      const profile={raw_job_id:selected.raw_job_id,deployment_id:deployment.deployment_id,
        source_hash:source.source_hash,effective_inputs_hash:source.analysis.effective_inputs_hash,
        execution_model:model,metadata_hash:hash(canonical({market:deployment.snapshot.market,
          price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),data_profile:model.data_profile})),
        raw_provenance_sha256:hash(canonical(raw.result.provenance)),seed_bars:SEED_BARS,
        snapshot_hash:deployment.snapshot_hash};
      const budget={candidates:1,max_evaluations:1,max_runtime_ms:Math.min(900000,approved.budget.max_runtime_ms),
        max_output_bytes:Math.min(1048576,approved.budget.max_output_bytes),
        max_state_bytes:Math.min(1048576,approved.budget.max_state_bytes)};
      known.claim_window_ms=budget.max_runtime_ms-(approved.terminal.runtime_max_ms+DEADLINE_MARGIN_MS);
      if(known.claim_window_ms<0)refuse('QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED');
      const chunk=Math.min(1000,approved.max_chunk_bars,total-SEED_BARS);
      const capacity={version:'quant-capacity-v2',environment:'staging',policy_hash:known.policy_hash,
        stage:'HISTORICAL_PREFLIGHT',scope:approved.scope,dataset:{raw_bars:total,seed_bars:SEED_BARS,
          warmup_bars:metadata.warmup_bars,evaluation_bars:total-metadata.warmup_bars,processed_bars:total-SEED_BARS},
        chunk_bars:chunk,budget,io:approved.io};
      // No completion_mode: the contract stays an unmarked diagnostic job and can never be enrolled.
      const contract=validateFoundationRequestV2({version:'quant-foundation-v2',owner_id:selected.owner_id,
        bot_id:selected.bot_id,kind:'PROFILE',dataset:raw.result.dataset,engine_hash:engineHash,
        snapshot_hash:deployment.snapshot_hash,profile,capacity,budget:{...budget,chunk_bars:chunk}},{policy:approved});
      if(Object.hasOwn(contract,'completion_mode'))refuse('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED');
      const contractHash=hash(canonical(contract));
      Object.assign(known,{contract_hash:contractHash,engine_hash:contract.engine_hash});
      // The product authority the worker applies at claim: scope, engine hash, raw result and deployment bindings.
      if((await profileService.authorizeV2(selected.owner_id,contract,'ENQUEUE'))?.ok!==true)
        refuse('QUANT_DIAGNOSTIC_AUTHORITY_REFUSED');
      if(expectContractHash!==null&&expectContractHash!==contractHash)refuse('QUANT_DIAGNOSTIC_PLAN_MISMATCH');
      if(!enqueue)return {...known,ok:true,outcome:'WOULD_ENQUEUE',reused:false};

      const now=clock(),deadline=now+budget.max_runtime_ms;
      if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(deadline))refuse('FOUNDATION_INVALID_CLOCK');
      await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
        [selected.owner_id]);
      const row=(await db.query(`INSERT INTO quant_foundation_jobs
        (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
        VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,
        [randomUUID(),selected.owner_id,selected.idempotency_key,JSON.stringify(contract),contractHash,now,deadline]))
        .rows[0];
      // Read the stored row back: the job must be exactly the contract that was reviewed.
      if(!row||row.status!=='QUEUED'||row.owner_id!==selected.owner_id||row.idempotency_key!==selected.idempotency_key||
        row.contract_hash!==contractHash||row.attempts!==0||row.deadline_at!==deadline||row.result!==null||
        row.checkpoint!==null||hash(canonical(row.contract))!==contractHash)refuse('QUANT_DIAGNOSTIC_INSERT_FAILED');
      return {...known,ok:true,outcome:'ENQUEUED',job_id:row.job_id,job_status:row.status,reused:false};
    };

    let plan;
    try{
      await db.transaction(async()=>{
        plan=await decide();
        // A dry run never commits, even if a dependency wrote something.
        if(!enqueue)throw DRY_RUN;
      },{isolation:'SERIALIZABLE'});
    }catch(error){
      // Any lock wait that hits the timeout, the table lock or a row lock taken by a dependency, is a refusal.
      if(error!==DRY_RUN)throw error?.code===LOCK_TIMEOUT_SQLSTATE?fail('QUANT_DIAGNOSTIC_LOCK_TIMEOUT'):error;
    }
    return Object.freeze({...plan,mode:known.mode});
  }catch(error){throw annotate(error,known);}
}

/** Renders one deterministic JSON line: a fixed key set, sorted keys and no free text. */
export function diagnosticReport({plan=null,error=null,mode=null}={}){
  const report={...blankPlan(),sqlstate:null,...(plan??error?.plan??{})};
  if(report.mode===null)report.mode=mode;
  if(error!==null){
    report.ok=false;report.outcome='REFUSED';report.refusal=publicCode(error);report.sqlstate=publicSqlstate(error);
  }
  return canonical(report);
}

async function openProductionDependencies({policy}){
  const [{PostgresDatabase},{Store},{PineBridgeService},{QuantResearchService},{QuantDataService},
    {QuantProfileService},{config}]=await Promise.all([
    import('../src/postgres/db.js'),import('../src/postgres/store.js'),import('../src/postgres/pine-bridge.js'),
    import('../src/postgres/quant-research.js'),import('../src/postgres/quant-data.js'),
    import('../src/postgres/quant-profile.js'),import('../src/config.js')]);
  const db=new PostgresDatabase();
  try{
    await db.runtimeLock();await db.verifySchema();
    const pine=new PineBridgeService(new Store(db),{defaultRisk:config.defaultRisk});
    const research=new QuantResearchService({pineService:pine,foundation:true});
    const data=new QuantDataService({pineService:pine,datasetStore:research.datasetStore.raw,enabled:true});
    const profileService=new QuantProfileService({pineService:pine,dataService:data,researchStore:research.datasetStore,
      capacityPolicy:policy,enabled:true,profileV2Enabled:true,enrollmentEnabled:false});
    return {db,profileService,close:()=>db.close()};
  }catch(error){try{await db.close();}catch{/* The original failure is the one to report. */}throw error;}
}

/** The whole command with injectable seams. Returns the output line and the process exit code. */
export async function runQuantProfileDiagnostic({argv=process.argv.slice(2),environment=process.env,
  platform=process.platform,readRequest=readPrivateRequest,loadPolicy=loadQuantCapacityPolicy,
  openDependencies=openProductionDependencies,readEngineHash,clock}={}){
  let mode=null,dependencies=null;
  try{
    const args=parseDiagnosticArguments(argv);
    mode=args.enqueue?'enqueue':'dry-run';
    assertDiagnosticEnvironment({environment,platform});
    const request=await readRequest(args.requestFile);
    let policy;
    try{policy=await loadPolicy(environment.QUANT_CAPACITY_POLICY_FILE);}
    catch(error){throw isRefusal(error)?error:fail('QUANT_CAPACITY_POLICY_REQUIRED');}
    dependencies=await openDependencies({policy});
    const plan=await enqueueQuantProfileDiagnostic({db:dependencies.db,profileService:dependencies.profileService,
      policy,request,enqueue:args.enqueue,expectContractHash:args.expectContractHash,
      ...(readEngineHash===undefined?{}:{readEngineHash}),...(clock===undefined?{}:{clock})});
    return {exitCode:0,output:diagnosticReport({plan,mode})};
  }catch(error){
    // A thrown null or undefined is still a refusal, never a plan.
    return {exitCode:2,output:diagnosticReport({error:error??{},mode})};
  }finally{
    try{await dependencies?.close?.();}catch{/* Closing is best effort after the outcome is decided. */}
  }
}

const printLine=line=>console.log(line);

/** Last-resort report for a fault that escapes runQuantProfileDiagnostic, for example a database connection that
 * drops while a transaction is open: the driver then emits an error event that nothing handles, and Node would print
 * the error with its stack and file paths. This prints the one redacted failure line instead, once, and exits with 2.
 * Only the code, status and severity of the fault are looked at. The server rolls back a transaction whose
 * connection closed before the commit.
 * The target and write seams exist for focused tests.
 */
export function installCrashReporter({target=process,write=printLine,mode=null}={}){
  let reported=false;
  const report=fault=>{
    if(reported)return;
    reported=true;
    let error={};
    try{error={code:fault?.code,status:fault?.status,severity:fault?.severity};}catch{/* An unreadable fault is generic. */}
    try{write(diagnosticReport({error,mode}));}catch{/* A closed output cannot be told about it. */}
    target.exit(2);
  };
  target.on('uncaughtException',report);
  target.on('unhandledRejection',report);
  return report;
}

// import.meta.url is the real path of this file. process.argv[1] keeps a symbolic link or junction as typed, so it is
// resolved first. Without that, a start through a link such as a current-release link would do nothing, print nothing
// and exit 0. A path that cannot be resolved is not this file.
const startedAsCommand=()=>{
  try{return Boolean(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}
  catch{return false;}
};

if(startedAsCommand()){
  installCrashReporter({mode:process.argv.slice(2).includes('--enqueue')?'enqueue':'dry-run'});
  const {exitCode,output}=await runQuantProfileDiagnostic();
  printLine(output);process.exitCode=exitCode;
}
