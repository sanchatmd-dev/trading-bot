import {randomUUID} from 'node:crypto';
import {canonical,fail,hash,keys} from '../pine-bridge/source.js';
import {validateBackfillResult} from '../quant-research/foundation-contract.js';
import {capacityPolicyHash,validateCapacityPolicy} from '../quant-research/capacity-contract.js';
import {deriveClosedMetadataV2} from '../quant-research/data-profile-v2.js';
import {validateProfileResultV2,validateProfileEnrollmentReceipt} from '../quant-research/profile-contract-v2.js';
import {readProfileEnrollmentEvidence} from './quant-profile-enrollment-evidence.js';
import {assertQuantProfileEnrollmentSchema} from './quant-profile-enrollment-migration.js';
import {PREFLIGHT_RECORD_FIELDS,buildPreflightPlan,derivePreflightRecords,
  validatePreflightEnvelope} from '../quant-research/preflight-plan.js';
import {pf2ExecutableHashes} from '../quant-research/preflight-resolver.js';
import {freshSnapshot} from './pine-bridge-readiness.js';

/**
 * PF-2 runtime slice R3: QuantPreflightService (enqueue, get, cancel, list), the owner-registered holdout
 * boundary registry, the job-scoped trusted-source adapters for the S3 resolver and the scheduler authorize
 * callback. Development-only diagnostic, V1 only, EVALUATOR mode only. Local library: no route, worker,
 * supervisor or process access. The caller owns the SERIALIZABLE transaction for every service method.
 * A public method throws a fixed code of ours or of the existing services (message equals code), or an error that
 * carries a five character code, a PostgreSQL SQLSTATE such as 40001 or a Node errno code such as EPERM. The second
 * kind passes through unchanged, message included, so the server's generic error mapping (a retry or a 503, never
 * that message) must answer for it: a route calls this service from the server's transactional handler. Every other
 * unexpected failure becomes PREFLIGHT_UNAVAILABLE and never carries a message, path or SQL text.
 */
export const PREFLIGHT_HOLDOUT_SCOPE=Object.freeze({venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',
  timeframe:'1'});

export const PREFLIGHT_SERVICE_ERRORS=Object.freeze(['PREFLIGHT_DISABLED','PREFLIGHT_SCHEMA_REQUIRED','NOT_FOUND',
  'INVALID_FIELDS','IDEMPOTENCY_KEY_REQUIRED','IDEMPOTENCY_CONFLICT','PREFLIGHT_ALREADY_ACTIVE',
  'FOUNDATION_QUEUE_FULL','PREFLIGHT_ENROLLMENT_REQUIRED','PREFLIGHT_DEPLOYMENT_UNSUPPORTED',
  'RESEARCH_DEPLOYMENT_NOT_READY','SNAPSHOT_HASH_MISMATCH','STALE_MEMBERSHIP','STALE_POLICY','STALE_CAPITAL',
  'UNSUPPORTED_SOURCE_HASH','PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED','PREFLIGHT_DEVELOPMENT_RANGE_REQUIRED',
  'FOUNDATION_CAPABILITY_LIMIT','PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED','INVALID_PREFLIGHT_CONTRACT',
  'FOUNDATION_INTEGRITY_FAILED','HOLDOUT_BOUNDARY_INVALID','HOLDOUT_BOUNDARY_EXISTS','HOLDOUT_BOUNDARY_CONFLICT',
  'PREFLIGHT_UNAVAILABLE','PREFLIGHT_CONFIGURATION_INVALID',
  'QUANT_PROFILE_ENROLLMENT_SCHEMA_UNSUPPORTED',
  // The one error an adapter throws for any failure; the resolver never reads it and maps the outcome itself.
  'PREFLIGHT_ADAPTER_UNAVAILABLE',
  // Raised by the existing quant data service that gates readiness and scope.
  'QUANT_DATA_DISABLED','RESEARCH_FOUNDATION_SCHEMA_REQUIRED','RESEARCH_EXECUTOR_MODE_MISMATCH',
  'STORAGE_DATABASE_BINDING_MISMATCH','INGESTION_TRANSACTION_REQUIRED']);

const ACTIVE=Object.freeze(['QUEUED','PAUSED','RUNNING','STOPPING']);
const MINUTE=60000;
const MAX_TIME_MS=253_402_300_799_999;
const JOB_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY=/^[A-Za-z0-9_-]{8,128}$/;
const ACCOUNT_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEPLOYMENT_ID=/^[A-Za-z0-9-]{8,128}$/;
const SHA=/^[a-f0-9]{64}$/;
const FENCED=new Set(['CLAIM','HEARTBEAT','CHECKPOINT','FINISH']);
const LIST_LIMIT=20;

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isSha=value=>typeof value==='string'&&SHA.test(value);
const isTime=value=>Number.isSafeInteger(value)&&value>0&&value<=MAX_TIME_MS&&value%MINUTE===0;

/** A fixed-code error of ours or of the existing services, or a database error the server maps generically. */
const passes=error=>error instanceof Error&&typeof error.code==='string'&&
  (Number.isInteger(error.status)||/^[0-9A-Z]{5}$/.test(error.code));
async function guarded(operation){
  try{return await operation();}
  catch(error){
    if(passes(error))throw error;
    throw fail('PREFLIGHT_UNAVAILABLE',503);
  }
}

// --- shared row readers (SELECT only, bounded by primary key) --------------------------------

const DEPLOYMENT_COLUMNS='deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash';

const rows=async(db,sql,params)=>(await db.query(sql,params)).rows;
const one=async(db,sql,params)=>(await rows(db,sql,params))[0];

/** The one PROFILE job the plan names, owner scoped. Loose shape only: full validation is validateEnrollment. */
async function readEnrollment(db,owner,bot,deploymentId,profileJobId,{share=false}={}){
  const evidence=await readProfileEnrollmentEvidence(db,profileJobId,{share});
  const row=evidence?.job;
  const contract=row?.contract;
  if(!row||row.owner_id!==owner||!isObject(contract)||contract.kind!=='PROFILE'||contract.bot_id!==bot||
     contract.owner_id!==owner||contract.profile?.deployment_id!==deploymentId)return null;
  return {...row,enrollment_evidence:evidence};
}

/** Full enrollment validation of section 4.3: null unless the row is a valid, current PROFILE v2 result. */
function validateEnrollment(row,{owner,bot,deploymentId,policy}){
  const contract=row?.contract;
  if(!row||!isObject(contract)||row.owner_id!==owner||contract.version!=='quant-foundation-v2'||
     contract.kind!=='PROFILE'||contract.owner_id!==owner||contract.bot_id!==bot||
     contract.profile?.deployment_id!==deploymentId||row.status!=='SUCCEEDED'||!isObject(row.result)||
     policy===null||policy===undefined)return null;
  try{
    validateProfileEnrollmentReceipt(row.enrollment_evidence);
    if(canonical(row.enrollment_evidence.job.contract)!==canonical(contract)||
      canonical(row.enrollment_evidence.job.result)!==canonical(row.result))return null;
    if(hash(canonical(contract))!==row.contract_hash)return null;
    validateProfileResultV2(contract,row.result,{policy});
    if(capacityPolicyHash(policy)!==contract.capacity.policy_hash)return null;
  }catch{return null;}
  return {contract,result:row.result,enrollment_evidence:row.enrollment_evidence};
}

const readBoundary=(db,owner,bot)=>one(db,'SELECT holdout_start_time,created_at FROM quant_holdout_boundaries '+
  'WHERE owner_id=$1 AND bot_id=$2 AND venue=$3 AND market=$4 AND symbol=$5 AND timeframe=$6',
[owner,bot,...Object.values(PREFLIGHT_HOLDOUT_SCOPE)]);

// Registration remains write-once per bot. Admission uses the strictest boundary
// for the owner's shared market, including a sibling registered after this bot.
// The outer row deliberately requires this bot's own explicit registration.
const EFFECTIVE_BOUNDARY_SQL=`SELECT (SELECT min(sibling.holdout_start_time)
  FROM quant_holdout_boundaries sibling WHERE sibling.owner_id=own.owner_id
  AND sibling.venue=own.venue AND sibling.market=own.market
  AND sibling.symbol=own.symbol AND sibling.timeframe=own.timeframe) holdout_start_time
  FROM quant_holdout_boundaries own WHERE own.owner_id=$1 AND own.bot_id=$2
  AND own.venue=$3 AND own.market=$4 AND own.symbol=$5 AND own.timeframe=$6`;
const readEffectiveBoundary=(db,owner,bot)=>one(db,EFFECTIVE_BOUNDARY_SQL,
  [owner,bot,...Object.values(PREFLIGHT_HOLDOUT_SCOPE)]);

const readSource=(db,owner,bot,importId,version)=>one(db,
  'SELECT r.source,r.source_hash FROM pine_source_revisions r JOIN pine_sources s ON s.pine_import_id=r.pine_import_id '+
  'WHERE s.owner_id=$1 AND s.bot_id=$2 AND r.pine_import_id=$3 AND r.source_version=$4',
[owner,bot,importId,version]);

// --- trusted-source adapters (section 4) -----------------------------------------------------

const unavailable=()=>fail('PREFLIGHT_ADAPTER_UNAVAILABLE',503);

/** Throws when the received signal is aborted or unreadable. A missing signal cannot be checked and passes. */
function alive(signal){
  let aborted;
  try{aborted=signal===undefined?false:signal?.aborted!==false;}catch{aborted=true;}
  if(aborted)throw unavailable();
}

const readOnly=(store,names)=>Object.fromEntries(names.map(name=>[name,(...args)=>store[name](...args)]));
const usableStores=stores=>isObject(stores)&&isObject(stores.raw)&&typeof stores.raw.inspect==='function'&&
  typeof stores.raw.read==='function'&&isObject(stores.research)&&isObject(stores.research.raw)&&
  typeof stores.research.raw.inspect==='function'&&typeof stores.research.inspectSidecarV2==='function'&&
  typeof stores.research.readV2==='function';

/**
 * Job scoped, read only trusted sources for one resolveHistoricalPreflight call. The scope (job, owner, bot) is fixed
 * at construction; a request for any other owner or bot is refused. Adapters are untrusted data sources: the resolver
 * detaches, re-hashes and re-validates everything they return. Each adapter checks the received signal before every
 * query, only ever runs SELECT, returns null for a missing, foreign or mismatching row and throws one fixed error
 * for any failure (no database text leaves an adapter). Nothing here writes, locks, freezes or replaces the signal.
 */
export function trustedSources({db,pine,job_id,owner_id,bot_id,stores,capacityPolicy}={}){
  if(!db||typeof db.query!=='function'||!pine||typeof pine.authorize!=='function'||
     typeof job_id!=='string'||!JOB_ID.test(job_id)||typeof owner_id!=='string'||typeof bot_id!=='string'||
     !ACCOUNT_ID.test(owner_id)||!ACCOUNT_ID.test(bot_id)||!usableStores(stores))
    throw fail('PREFLIGHT_CONFIGURATION_INVALID',500);
  const policy=capacityPolicy===undefined||capacityPolicy===null?null:validateCapacityPolicy(capacityPolicy);
  const inScope=ids=>isObject(ids)&&ids.owner_id===owner_id&&ids.bot_id===bot_id;
  // The signal is checked before each query; the statement must be a plain SELECT.
  const read=async(signal,sql,params)=>{
    alive(signal);
    if(!/^\s*SELECT\b/.test(sql))throw unavailable();
    return (await db.query(sql,params)).rows;
  };
  const adapter=operation=>async(...args)=>{
    try{return await operation(...args);}
    catch{throw unavailable();}
  };

  // One context per resolve: the rows this job names, read once, all scoped to this owner and bot.
  let loaded=null;
  const load=async signal=>{
    await assertQuantProfileEnrollmentSchema({query:(sql,params)=>read(signal,sql,params).then(rows=>({rows}))});
    const [bound]=await read(signal,'SELECT job_id,owner_id,bot_id,plan_hash,deployment_id,profile_job_id '+
      'FROM quant_preflight_jobs WHERE job_id=$1',[job_id]);
    if(!bound||bound.owner_id!==owner_id||bound.bot_id!==bot_id)return null;
    const [deployment]=await read(signal,'SELECT '+DEPLOYMENT_COLUMNS+' FROM pine_deployments '+
      'WHERE deployment_id=$1 AND owner_id=$2 AND bot_id=$3',[bound.deployment_id,owner_id,bot_id]);
    const evidence=await readProfileEnrollmentEvidence({query:(sql,params)=>read(signal,sql,params).then(rows=>({rows}))},bound.profile_job_id);
    const profile=evidence?.job?{...evidence.job,enrollment_evidence:evidence}:null;
    const enrolled=profile&&profile.owner_id===owner_id&&isObject(profile.contract)&&profile.contract.kind==='PROFILE'&&
      profile.contract.owner_id===owner_id&&profile.contract.bot_id===bot_id&&
      profile.contract.profile?.deployment_id===bound.deployment_id?profile:null;
    let source=null;
    if(deployment){
      const [revision]=await read(signal,'SELECT r.source,r.source_hash FROM pine_source_revisions r '+
        'JOIN pine_sources s ON s.pine_import_id=r.pine_import_id '+
        'WHERE s.owner_id=$1 AND s.bot_id=$2 AND r.pine_import_id=$3 AND r.source_version=$4',
      [owner_id,bot_id,deployment.pine_import_id,deployment.source_version]);
      source=revision??null;
    }
    // Derive-at-read (RD-4): the records come from the authoritative rows through the builder's own function,
    // so a later edit of the deployment, the source or the enrollment model yields another hash or no record.
    let derived=null;
    if(deployment&&enrolled&&source){
      try{
        derived=derivePreflightRecords({snapshot:deployment.snapshot,model:enrolled.contract.profile.execution_model,
          source:source.source});
      }catch{derived=null;}
    }
    return {bound,deployment:deployment??null,enrolled,source,derived};
  };
  const context=signal=>{loaded??=load(signal);return loaded;};

  const authorize=adapter(async(ids,options)=>{
    alive(options?.signal);
    if(!inScope(ids))return false;
    const ctx=await context(options?.signal);
    if(!ctx)return false;
    alive(options?.signal);
    try{await pine.authorize(owner_id,bot_id);}catch{return false;}
    return true;
  });

  const get=adapter(async(kind,sha,ids)=>{
    alive(ids?.signal);
    if(!inScope(ids)||!isSha(sha))return null;
    const ctx=await context(ids.signal);
    if(!ctx)return null;
    if(kind==='deployment_snapshot'){
      // The authoritative row itself, not derived: the resolver re-hashes it against the enrolled snapshot hash.
      return ctx.deployment&&ctx.deployment.snapshot_hash===sha?structuredClone(ctx.deployment.snapshot):null;
    }
    if(typeof kind!=='string'||!Object.hasOwn(PREFLIGHT_RECORD_FIELDS,kind)||!ctx.derived||
       ctx.derived.hashes[PREFLIGHT_RECORD_FIELDS[kind]]!==sha)return null;
    return ctx.derived.records[kind];
  });

  const find=adapter(async(query,options)=>{
    alive(options?.signal);
    if(!inScope(query)||!isSha(query.raw_dataset_sha256)||!isSha(query.execution_model_hash)||
       !isSha(query.venue_metadata_hash)||policy===null)return null;
    const ctx=await context(options?.signal);
    if(!ctx?.enrolled)return null;
    const valid=validateEnrollment(ctx.enrolled,{owner:owner_id,bot:bot_id,deploymentId:ctx.bound.deployment_id,policy});
    if(!valid)return null;
    const {contract}=valid;
    if(contract.dataset.sha256!==query.raw_dataset_sha256||
       hash(canonical(contract.profile.execution_model))!==query.execution_model_hash||
       contract.profile.metadata_hash!==query.venue_metadata_hash)return null;
    return {contract:structuredClone(contract),result:structuredClone(valid.result),
      capacity_policy:structuredClone(policy),enrollment_evidence:structuredClone(valid.enrollment_evidence)};
  });

  const provenance=adapter(async(sha,ids)=>{
    alive(ids?.signal);
    if(!inScope(ids)||!isSha(sha))return null;
    const ctx=await context(ids.signal);
    const profile=ctx?.enrolled?.contract.profile;
    if(!profile||typeof profile.raw_job_id!=='string'||!JOB_ID.test(profile.raw_job_id))return null;
    const [row]=await read(ids.signal,'SELECT job_id,owner_id,status,next_bar,contract,contract_hash,checkpoint,result '+
      'FROM quant_foundation_jobs WHERE job_id=$1 AND owner_id=$2',[profile.raw_job_id,owner_id]);
    const contract=row?.contract;
    if(!row||!isObject(contract)||contract.kind!=='BACKFILL'||contract.owner_id!==owner_id||
       contract.bot_id!==bot_id||row.status!=='SUCCEEDED'||!isObject(row.checkpoint)||!isObject(row.result)||
       hash(canonical(contract))!==row.contract_hash)return null;
    // The stored checkpoint keeps the integrity seal the scheduler wrote for it.
    const {sha256,...payload}=row.checkpoint;
    if(hash(canonical(payload))!==sha256||payload.next_bar!==row.next_bar||
       payload.engine_hash!==contract.engine_hash||payload.snapshot_hash!==contract.snapshot_hash)return null;
    try{validateBackfillResult(contract,row.checkpoint,row.result);}catch{return null;}
    if(canonical(row.result.dataset)!==canonical(ctx.enrolled.contract.dataset)||
       hash(canonical(row.result.provenance))!==sha)return null;
    return structuredClone(row.result.provenance);
  });

  const boundary=adapter(async(query,options)=>{
    alive(options?.signal);
    if(!inScope(query)||Object.entries(PREFLIGHT_HOLDOUT_SCOPE).some(([name,value])=>query[name]!==value))return null;
    const [row]=await read(options?.signal,EFFECTIVE_BOUNDARY_SQL,
    [owner_id,bot_id,...Object.values(PREFLIGHT_HOLDOUT_SCOPE)]);
    return row?{holdout_start_time:row.holdout_start_time}:null;
  });

  return Object.freeze({
    authorize,
    records:Object.freeze({get}),
    enrollment:Object.freeze({find}),
    provenance:Object.freeze({get:provenance}),
    holdout:Object.freeze({boundary}),
    // Read-only facades: the resolver can inspect and read, never publish or write.
    datasets:Object.freeze({raw:Object.freeze(readOnly(stores.raw,['inspect','read'])),
      research:Object.freeze({raw:Object.freeze(readOnly(stores.research.raw,['inspect'])),
        ...readOnly(stores.research,['inspectSidecarV2','readV2'])})})});
}

// --- service ---------------------------------------------------------------------------------

/** Transaction-local service. The caller owns the SERIALIZABLE transaction. */
export async function assertQuantPreflightSchema(db){
  const present=await one(db,"SELECT to_regclass('public.quant_preflight_schema') version_table,"+
    "to_regclass('public.quant_preflight_jobs') jobs_table,to_regclass('public.quant_holdout_boundaries') boundary_table",[]);
  if(!present?.version_table||!present.jobs_table||!present.boundary_table)throw fail('PREFLIGHT_SCHEMA_REQUIRED',503);
  const version=await rows(db,'SELECT version FROM public.quant_preflight_schema',[]);
  if(version.length!==1||version[0].version!==1)throw fail('PREFLIGHT_SCHEMA_REQUIRED',503);
}

export class QuantPreflightService{
  /**
   * capacityPolicy is the scheduler's configured policy (RD-11). supportedSourceHash and executableHashes are test
   * seams: production wiring omits both, so the plan builder keeps the compiled-in supported source hash and the
   * real PF-2 engine and evaluator hashes.
   */
  constructor({pineService,dataService,stores,capacityPolicy,clock=Date.now,enabled=false,supportedSourceHash,
    executableHashes=pf2ExecutableHashes}={}){
    if(!pineService||typeof pineService.authorize!=='function'||!pineService.db||!dataService||
       typeof dataService.ready!=='function'||typeof dataService.scope!=='function'||typeof clock!=='function'||
       typeof executableHashes!=='function'||(stores!==undefined&&!usableStores(stores))||
       (supportedSourceHash!==undefined&&!isSha(supportedSourceHash)))throw fail('PREFLIGHT_CONFIGURATION_INVALID',500);
    this.pine=pineService;this.db=pineService.db;this.data=dataService;this.stores=stores??null;
    this.clock=clock;this.enabled=enabled===true;this.supportedSourceHash=supportedSourceHash;
    this.executableHashes=executableHashes;
    this.capacityPolicy=capacityPolicy===undefined||capacityPolicy===null?null:validateCapacityPolicy(capacityPolicy);
  }

  async ready(){
    if(!this.enabled||!this.capacityPolicy)throw fail('PREFLIGHT_DISABLED',503);
    await this.data.ready();
    await assertQuantProfileEnrollmentSchema(this.db);
    await assertQuantPreflightSchema(this.db);
  }
  async scope(owner,bot){await this.data.scope(owner,bot);}
  now(){
    const now=this.clock();
    if(!Number.isSafeInteger(now)||now<0)throw fail('PREFLIGHT_UNAVAILABLE',503);
    return now;
  }
  async executables(){
    try{return await this.executableHashes();}
    catch{throw fail('PREFLIGHT_UNAVAILABLE',503);}
  }
  /** Bots and owners are plain identifiers; any other shape is an invalid request, never a lookup. */
  account(value){
    if(typeof value!=='string'||!ACCOUNT_ID.test(value))throw fail('INVALID_FIELDS');
    return value;
  }
  binding(jobId){return one(this.db,'SELECT * FROM quant_preflight_jobs WHERE job_id=$1',[jobId]);}

  /** Integrity-checked summary of one PREFLIGHT job (contract, plan binding, checkpoint). Code only on failure. */
  expose(row,bound){
    const integrity=()=>fail('FOUNDATION_INTEGRITY_FAILED',500);
    const contract=row?.contract;
    if(!row||!bound||!isObject(contract)||contract.kind!=='PREFLIGHT'||row.job_id!==bound.job_id||
       row.owner_id!==bound.owner_id||contract.owner_id!==row.owner_id||contract.bot_id!==bound.bot_id||
       hash(canonical(contract))!==row.contract_hash||hash(bound.plan_json)!==bound.plan_hash)throw integrity();
    let total;
    try{
      if(canonical(JSON.parse(bound.plan_json).foundation)!==canonical(contract))throw integrity();
      total=deriveClosedMetadataV2(contract.dataset).total_bars;
    }catch{throw integrity();}
    if(row.checkpoint){
      const {sha256,...payload}=row.checkpoint;
      if(hash(canonical(payload))!==sha256||payload.next_bar!==row.next_bar||
         payload.engine_hash!==contract.engine_hash||payload.snapshot_hash!==contract.snapshot_hash)throw integrity();
    }else if(row.next_bar!==0)throw integrity();
    return {job_id:row.job_id,bot_id:bound.bot_id,deployment_id:bound.deployment_id,
      profile_job_id:bound.profile_job_id,plan_hash:bound.plan_hash,status:row.status,next_bar:row.next_bar,
      total_bars:total,diagnostic:row.diagnostic??null,created_at:bound.created_at,development_only:true,
      evaluator_admission:false};
  }
  /** Summary plus the re-validated envelope (SUCCEEDED only) and whether the live PF-2 engine still matches it. */
  async detail(row,bound){
    const summary=this.expose(row,bound);
    let envelope=null;
    if(row.status==='SUCCEEDED'){
      try{
        envelope=validatePreflightEnvelope(row.contract,row.result,
          {planHash:bound.plan_hash,plan:JSON.parse(bound.plan_json)});
      }catch{throw fail('FOUNDATION_INTEGRITY_FAILED',500);}
    }
    const live=await this.executables();
    return {...summary,envelope,
      engine_current:live.engine_hash===(envelope?envelope.binding.engine_hash:row.contract.engine_hash)};
  }

  /**
   * Builder steps 3.3 e to l over the current authoritative rows, shared by enqueue and the scheduler authorize.
   * Reads only; every failure is a fixed code. The plan is built by the pure R1 builder, then the live freshness
   * gate (OD-3) runs: deployment READY, membership, policy, capital and funding cutoff unchanged.
   */
  async assemble(owner,{bot_id:bot,deployment_id:deploymentId,profile_job_id:profileJobId},{share=false}={}){
    await assertQuantProfileEnrollmentSchema(this.db);
    const enrollment=await readEnrollment(this.db,owner,bot,deploymentId,profileJobId,{share});
    if(!validateEnrollment(enrollment,{owner,bot,deploymentId,policy:this.capacityPolicy}))
      throw fail('PREFLIGHT_ENROLLMENT_REQUIRED',409);
    const deployment=await one(this.db,'SELECT '+DEPLOYMENT_COLUMNS+' FROM pine_deployments '+
      'WHERE owner_id=$1 AND bot_id=$2 AND deployment_id=$3',[owner,bot,deploymentId]);
    if(!deployment)throw fail('NOT_FOUND',404);
    const member=deployment.snapshot?.membership?.length===1?deployment.snapshot.membership[0]:null;
    if(!isObject(member)||member.pine_import_id!==deployment.pine_import_id||
       member.source_version!==deployment.source_version||
       deployment.snapshot.market?.pine_import_id!==deployment.pine_import_id||
       deployment.snapshot.market?.source_version!==deployment.source_version)
      throw fail('PREFLIGHT_DEPLOYMENT_UNSUPPORTED',409);
    const source=await readSource(this.db,owner,bot,deployment.pine_import_id,deployment.source_version);
    if(!source)throw fail('UNSUPPORTED_SOURCE_HASH',409);
    const boundary=await readEffectiveBoundary(this.db,owner,bot);
    if(!boundary)throw fail('PREFLIGHT_HOLDOUT_BOUNDARY_REQUIRED',409);
    const executables=await this.executables();
    const built=buildPreflightPlan({owner_id:owner,bot_id:bot,deployment_id:deploymentId,
      enrollment:{contract:enrollment.contract,result:enrollment.result,contract_hash:enrollment.contract_hash,
        status:enrollment.status},
      deployment:{deployment_id:deployment.deployment_id,owner_id:deployment.owner_id,bot_id:deployment.bot_id,
        state:deployment.state,snapshot:deployment.snapshot,snapshot_hash:deployment.snapshot_hash},
      source:{source:source.source,source_hash:source.source_hash},
      boundary:{holdout_start_time:boundary.holdout_start_time},
      executables:{engine_hash:executables.engine_hash,evaluator_hash:executables.evaluator_hash},
      capacityPolicy:this.capacityPolicy,
      // Production never passes a supported source hash: the builder keeps the compiled-in default.
      ...(this.supportedSourceHash===undefined?{}:{supportedSourceHash:this.supportedSourceHash})});
    await freshSnapshot(this.pine,deployment);
    return built;
  }

  request(body){
    keys(body,['bot_id','deployment_id','profile_job_id']);
    if(typeof body.bot_id!=='string'||!ACCOUNT_ID.test(body.bot_id)||typeof body.deployment_id!=='string'||
       !DEPLOYMENT_ID.test(body.deployment_id)||typeof body.profile_job_id!=='string'||!JOB_ID.test(body.profile_job_id))
      throw fail('INVALID_FIELDS');
    return {bot_id:body.bot_id,deployment_id:body.deployment_id,profile_job_id:body.profile_job_id};
  }

  /** One explicit owner request creates one QUEUED PREFLIGHT job. Never runs the resolver, reads dataset bytes or spawns. */
  enqueue(owner,body,key){return guarded(async()=>{
    await this.ready();
    const request=this.request(body);
    if(typeof key!=='string'||!KEY.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
    if(!this.db.isTransaction)throw fail('INGESTION_TRANSACTION_REQUIRED');
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    await this.scope(owner,request.bot_id);
    const previous=await one(this.db,'SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,key]);
    if(previous){
      const bound=previous.contract?.kind==='PREFLIGHT'?await this.binding(previous.job_id):null;
      if(!bound||bound.owner_id!==owner||bound.bot_id!==request.bot_id||
         bound.deployment_id!==request.deployment_id||bound.profile_job_id!==request.profile_job_id)
        throw fail('IDEMPOTENCY_CONFLICT',409);
      return this.expose(previous,bound);
    }
    // One active PREFLIGHT per bot (RD-7), then the shared foundation queue caps.
    if(await one(this.db,'SELECT j.job_id FROM quant_preflight_jobs p JOIN quant_foundation_jobs j ON j.job_id=p.job_id '+
      'WHERE p.owner_id=$1 AND p.bot_id=$2 AND j.status=ANY($3::text[]) LIMIT 1',[owner,request.bot_id,ACTIVE]))
      throw fail('PREFLIGHT_ALREADY_ACTIVE',409);
    const count=await one(this.db,'SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned '+
      'FROM quant_foundation_jobs WHERE status=ANY($2::text[])',[owner,ACTIVE]);
    if(count.total>=100||count.owned>=20)throw fail('FOUNDATION_QUEUE_FULL',429);
    const built=await this.assemble(owner,request,{share:true});
    const contract=built.plan.foundation,now=this.now(),id=randomUUID();
    await this.db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
    const job=await one(this.db,`INSERT INTO quant_foundation_jobs
      (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
      VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,
    [id,owner,key,JSON.stringify(contract),built.contract_hash,now,now+contract.budget.max_runtime_ms]);
    const bound=await one(this.db,`INSERT INTO quant_preflight_jobs
      (job_id,owner_id,bot_id,plan_hash,plan_json,deployment_id,profile_job_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id,owner,request.bot_id,built.plan_hash,built.plan_json,request.deployment_id,request.profile_job_id,now]);
    await this.pine.store.audit(owner,'quant.preflight.enqueued',id,{job_id:id,plan_hash:built.plan_hash});
    return this.expose(job,bound);
  });}

  /** Status detail, or an owner cancel (QUEUED/PAUSED to CANCELLED, RUNNING/STOPPING to STOPPING with reason CANCELLED). */
  get(owner,id,cancel=false,queryBotId=null){return guarded(async()=>{
    await this.ready();
    if(typeof id!=='string'||!JOB_ID.test(id)||(queryBotId!==null&&typeof queryBotId!=='string'))throw fail('NOT_FOUND',404);
    if(cancel)await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    const row=await one(this.db,'SELECT * FROM quant_foundation_jobs WHERE job_id=$1'+(cancel?' FOR UPDATE':''),[id]);
    if(!row||row.owner_id!==owner||row.contract?.kind!=='PREFLIGHT'||
       (queryBotId!==null&&queryBotId!==row.contract.bot_id))throw fail('NOT_FOUND',404);
    const bound=await this.binding(id);
    if(!bound||bound.owner_id!==owner||bound.bot_id!==row.contract.bot_id)throw fail('FOUNDATION_INTEGRITY_FAILED',500);
    if(cancel)await this.scope(owner,row.contract.bot_id);
    else await this.pine.authorize(owner,row.contract.bot_id);
    if(!cancel||!ACTIVE.includes(row.status))return this.detail(row,bound);
    const stopping=['RUNNING','STOPPING'].includes(row.status);
    const updated=await one(this.db,`UPDATE quant_foundation_jobs SET status=$2,stop_reason=$3,lease_until=NULL,
      runtime_used_ms=runtime_used_ms+CASE WHEN run_started_at IS NULL THEN 0 ELSE GREATEST(0,$4-run_started_at) END,
      run_started_at=NULL WHERE job_id=$1 RETURNING *`,[id,stopping?'STOPPING':'CANCELLED',stopping?'CANCELLED':null,this.now()]);
    await this.pine.store.audit(owner,'quant.preflight.cancelled',id,{job_id:id,status:updated.status});
    return this.detail(updated,bound);
  });}

  /** Up to 20 newest summaries for one of the owner's bots (no envelope). */
  list(owner,botId){return guarded(async()=>{
    await this.ready();
    const bot=this.account(botId);
    await this.pine.authorize(owner,bot);
    const found=await rows(this.db,`SELECT j.*,p.plan_hash,p.plan_json,p.deployment_id,p.profile_job_id,
      p.created_at bound_created_at,p.owner_id bound_owner_id,p.bot_id bound_bot_id
      FROM quant_preflight_jobs p JOIN quant_foundation_jobs j ON j.job_id=p.job_id
      WHERE p.owner_id=$1 AND p.bot_id=$2 AND j.owner_id=$1 ORDER BY p.created_at DESC,p.job_id DESC LIMIT ${LIST_LIMIT}`,[owner,bot]);
    return found.map(row=>this.expose(row,{job_id:row.job_id,owner_id:row.bound_owner_id,bot_id:row.bound_bot_id,
      plan_hash:row.plan_hash,plan_json:row.plan_json,deployment_id:row.deployment_id,
      profile_job_id:row.profile_job_id,created_at:row.bound_created_at}));
  });}

  // --- holdout registry (section 5) ----------------------------------------------------------

  holdoutView(bot,row){
    return {bot_id:bot,...PREFLIGHT_HOLDOUT_SCOPE,holdout_start_time:row?.holdout_start_time??null,
      created_at:row?.created_at??null};
  }
  /**
   * Earliest legacy research holdout start over every bot of one owner, on the open-time axis of the spot datasets.
   * The scan is owner wide, not per bot: the BTCUSDT 1m bars are shared by all bots of an owner, so the legacy
   * holdout of a sibling bot covers the same bars a boundary of this bot would open to development.
   * Legacy (QL-3A) bars are stamped with their close time (kline close plus one millisecond), the split indexes
   * that series, and the first holdout bar is index split.validation_end. Its open time is therefore
   * dataset.start_time + (validation_end - 1) minutes. A legacy row whose split cannot be read makes the check
   * fail closed (usable differs from total), for a sibling bot too. Rows of other owners are never read: the
   * query is parameterized and filtered by owner.
   */
  legacyHoldout(owner){
    return one(this.db,`SELECT count(*)::int total,count(*) FILTER(WHERE usable)::int usable,
      min(holdout) FILTER(WHERE usable) earliest FROM (
        SELECT COALESCE(s ~ '^[0-9]{1,6}$' AND t ~ '^[0-9]{1,15}$',FALSE) usable,
          CASE WHEN s ~ '^[0-9]{1,6}$' AND t ~ '^[0-9]{1,15}$' THEN t::bigint+(s::bigint-1)*60000 END holdout
        FROM (SELECT contract->'split'->>'validation_end' s,contract->'dataset'->>'start_time' t FROM quant_jobs
          WHERE owner_id=$1 AND contract ? 'split') q) r`,[owner]);
  }
  /** Current registry entry for one of the owner's bots: a timestamp only, or a null value when none is registered. */
  getHoldoutBoundary(owner,botId){return guarded(async()=>{
    await this.ready();
    const bot=this.account(botId);
    await this.pine.authorize(owner,bot);
    return this.holdoutView(bot,await readBoundary(this.db,owner,bot));
  });}
  /**
   * Owner-only, write-once registration of the development/holdout boundary for one bot (one row per owner, bot and
   * market key). The same value again is idempotent and a different value is refused. Two more refusals keep the
   * holdout unexposed. A value later than the current minute (the service clock, floored to the minute) is
   * HOLDOUT_BOUNDARY_INVALID: the row is permanent, so a far-future value or a unit typo would remove the holdout
   * for good. A value later than the earliest legacy research or registered PF-2 holdout of the same owner is
   * HOLDOUT_BOUNDARY_CONFLICT (an equal value is allowed), because the bars are shared across the owner's bots.
   * Nothing ever moves a boundary in V1.
   */
  registerHoldoutBoundary(owner,body){return guarded(async()=>{
    keys(body,['bot_id','holdout_start_time']);
    const bot=this.account(body.bot_id);
    if(!isTime(body.holdout_start_time))throw fail('HOLDOUT_BOUNDARY_INVALID');
    const value=body.holdout_start_time;
    // Checked with the other request validation, before any read or write. The clock is the service seam.
    if(value>Math.floor(this.now()/MINUTE)*MINUTE)throw fail('HOLDOUT_BOUNDARY_INVALID');
    await this.ready();
    if(!this.db.isTransaction)throw fail('INGESTION_TRANSACTION_REQUIRED');
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    await this.scope(owner,bot);
    const existing=await readBoundary(this.db,owner,bot);
    if(existing){
      if(existing.holdout_start_time!==value)throw fail('HOLDOUT_BOUNDARY_EXISTS',409);
      return {...this.holdoutView(bot,existing),registered:false};
    }
    const legacy=await this.legacyHoldout(owner);
    if(legacy.usable!==legacy.total||(legacy.earliest!==null&&value>legacy.earliest))
      throw fail('HOLDOUT_BOUNDARY_CONFLICT',409);
    const sibling=await one(this.db,`SELECT min(holdout_start_time) earliest FROM quant_holdout_boundaries
      WHERE owner_id=$1 AND venue=$2 AND market=$3 AND symbol=$4 AND timeframe=$5`,
    [owner,...Object.values(PREFLIGHT_HOLDOUT_SCOPE)]);
    if(sibling.earliest!==null&&value>sibling.earliest)throw fail('HOLDOUT_BOUNDARY_CONFLICT',409);
    const row=await one(this.db,`INSERT INTO quant_holdout_boundaries
      (owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING holdout_start_time,created_at`,
    [owner,bot,...Object.values(PREFLIGHT_HOLDOUT_SCOPE),value,owner,this.now()]);
    await this.pine.store.audit(owner,'quant.holdout.registered',null,{bot_id:bot,holdout_start_time:value});
    return {...this.holdoutView(bot,row),registered:true};
  });}

  // --- scheduler authorize (section 6.2) -----------------------------------------------------

  /**
   * Scheduler authorize callback for kind PREFLIGHT. Stop actions depend on the owner match alone (RD-12);
   * ACKNOWLEDGE_STOPPED needs supervisor proof. Every fenced action (CLAIM, HEARTBEAT, CHECKPOINT, FINISH) rebuilds
   * the plan from the current authoritative rows, engine hashes, registered boundary and freshness (OD-3) and
   * requires the stored plan bytes to be identical, so any change of enrollment, capacity policy, deployment, source,
   * boundary, engine or evaluator revokes the job. Any failure or throw is {ok:false}; no code leaves this method.
   */
  async authorize(owner,contract,action,context={}){
    try{
      if(contract?.kind!=='PREFLIGHT'||contract.owner_id!==owner)return {ok:false};
      if(action==='ACKNOWLEDGE_STOPPED')return {ok:context?.stopped===true};
      if(action==='CANCEL'||action==='PAUSE')return {ok:true};
      if(!FENCED.has(action)||!this.enabled||this.capacityPolicy===null||!this.db.isTransaction||
         typeof context?.job_id!=='string'||!JOB_ID.test(context.job_id))return {ok:false};
      await this.scope(owner,contract.bot_id);
      const bound=await this.binding(context.job_id);
      if(!bound||bound.owner_id!==owner||bound.bot_id!==contract.bot_id||hash(bound.plan_json)!==bound.plan_hash)
        return {ok:false};
      const plan=JSON.parse(bound.plan_json);
      if(canonical(plan)!==bound.plan_json||canonical(plan.foundation)!==canonical(contract))return {ok:false};
      const built=await this.assemble(owner,{bot_id:bound.bot_id,deployment_id:bound.deployment_id,
        profile_job_id:bound.profile_job_id},{share:true});
      return {ok:built.plan_json===bound.plan_json};
    }catch{return {ok:false};}
  }

  /** Job scoped trusted sources for one resolve of one PREFLIGHT job of this service. */
  trusted(job){
    if(!this.stores)throw fail('PREFLIGHT_CONFIGURATION_INVALID',500);
    return trustedSources({db:this.db,pine:this.pine,job_id:job?.job_id,owner_id:job?.owner_id,
      bot_id:job?.contract?.bot_id,stores:this.stores,capacityPolicy:this.capacityPolicy});
  }
}
