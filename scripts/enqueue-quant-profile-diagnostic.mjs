import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical,hash,fail} from '../src/pine-bridge/source.js';
import {strictJsonV2,fieldsV2,frozenV2,validateFoundationRequestV2} from '../src/quant-research/foundation-contract-v2.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {loadQuantCapacityPolicy,validateQuantCapacityPolicy} from '../src/postgres/quant-capacity-policy.js';
import {PostgresDatabase} from '../src/postgres/db.js';
import {Store} from '../src/postgres/store.js';
import {PineBridgeService} from '../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../src/postgres/quant-research.js';
import {QuantDataService,ingestionEngineHash} from '../src/postgres/quant-data.js';
import {QuantProfileService} from '../src/postgres/quant-profile.js';
import {config} from '../src/config.js';

const refused=code=>{throw fail(code);};
const active=['QUEUED','PAUSED','RUNNING','STOPPING'];

/** Owner input selects existing authoritative records, never execution fields or result bytes. */
export function validateDiagnosticRequest(value){
 strictJsonV2(value);
 fieldsV2(value,['owner_id','bot_id','raw_job_id','deployment_id','idempotency_key']);
 if(!['owner_id','bot_id'].every(name=>typeof value[name]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value[name]))||
    !['raw_job_id','deployment_id'].every(name=>typeof value[name]==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value[name]))||
    typeof value.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value.idempotency_key))
  refused('QUANT_DIAGNOSTIC_REQUEST_INVALID');
 return frozenV2(value);
}

/** Explicit diagnostic-only environment. The command never changes these flags. */
export function assertDiagnosticEnvironment({environment=process.env,platform=process.platform}={}){
 if(platform!=='linux'||environment.PINE_BRIDGE_ENV!=='staging'||environment.PAPER_TRADING!=='true'||
    !['PINE_BRIDGE_ENABLED','QUANT_RESEARCH_ENABLED','QUANT_RESEARCH_FOUNDATION_ENABLED','QUANT_PROFILE_V2_ENABLED']
      .every(name=>environment[name]==='1')||
    !['QUANT_PROFILE_V2_ENROLLMENT_ENABLED','QUANT_PREFLIGHT_ENABLED']
      .every(name=>environment[name]===undefined||environment[name]==='0'))refused('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED');
}

/** Trusted dependency seam for focused tests. CLI dependencies below are production constructors only.
 * The only writes, after every gate, are one owner upsert and one unmarked queued job.
 */
export async function enqueueQuantProfileDiagnostic({db,profileService,policy,request,enqueue=false,
 readEngineHash=ingestionEngineHash,clock=Date.now}){
 const selected=validateDiagnosticRequest(request),approvedPolicy=validateQuantCapacityPolicy(policy);
 if(typeof enqueue!=='boolean'||db.isTransaction||profileService.db!==db||
    profileService.profileV2Enabled!==true||profileService.enrollmentEnabled!==false||
    canonical(profileService.capacityPolicy)!==canonical(approvedPolicy))refused('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED');
 return db.transaction(async()=>{
  const locked=await db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
  if(locked.rowCount!==1)refused('QUANT_DIAGNOSTIC_SCHEDULER_REQUIRED');
  await profileService.ready();
  await profileService.scope(selected.owner_id,selected.bot_id);
  const raw=await profileService.raw(selected.owner_id,selected.bot_id,selected.raw_job_id);
  const {deployment,evidence,source}=await profileService.deployment(selected.owner_id,selected.bot_id,selected.deployment_id);
  const metadata=raw.result.dataset.metadata,total=metadata.total_bars,model=evidence.execution_model;
  if(total>10000)refused('QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED');
  const profile={raw_job_id:selected.raw_job_id,deployment_id:deployment.deployment_id,
   source_hash:source.source_hash,effective_inputs_hash:source.analysis.effective_inputs_hash,
   execution_model:model,metadata_hash:hash(canonical({market:deployment.snapshot.market,
    price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),data_profile:model.data_profile})),
   raw_provenance_sha256:hash(canonical(raw.result.provenance)),seed_bars:500,snapshot_hash:deployment.snapshot_hash};
  const budget={candidates:1,max_evaluations:1,max_runtime_ms:Math.min(900000,approvedPolicy.budget.max_runtime_ms),
   max_output_bytes:Math.min(1048576,approvedPolicy.budget.max_output_bytes),
   max_state_bytes:Math.min(1048576,approvedPolicy.budget.max_state_bytes)};
  if(budget.max_runtime_ms<approvedPolicy.terminal.runtime_max_ms+5000)refused('QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED');
  const chunk=Math.min(1000,approvedPolicy.max_chunk_bars,total-500);
  const capacity={version:'quant-capacity-v2',environment:'staging',policy_hash:capacityPolicyHash(approvedPolicy),
   stage:'HISTORICAL_PREFLIGHT',scope:approvedPolicy.scope,dataset:{raw_bars:total,seed_bars:500,
    warmup_bars:metadata.warmup_bars,evaluation_bars:total-metadata.warmup_bars,processed_bars:total-500},
   chunk_bars:chunk,budget,io:approvedPolicy.io};
  const contract=validateFoundationRequestV2({version:'quant-foundation-v2',owner_id:selected.owner_id,
   bot_id:selected.bot_id,kind:'PROFILE',dataset:raw.result.dataset,engine_hash:await readEngineHash(),
   snapshot_hash:deployment.snapshot_hash,profile,capacity,budget:{...budget,chunk_bars:chunk}},{policy:approvedPolicy});
  if((await profileService.authorizeV2(selected.owner_id,contract,'ENQUEUE'))?.ok!==true)
   refused('QUANT_DIAGNOSTIC_AUTHORITY_REFUSED');
  const contractHash=hash(canonical(contract));
  const previous=(await db.query('SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2',
   [selected.owner_id,selected.idempotency_key])).rows[0];
  if(previous&&(previous.owner_id!==selected.owner_id||previous.contract_hash!==contractHash||
     canonical(previous.contract)!==canonical(contract)))refused('IDEMPOTENCY_CONFLICT');
  const idle=(await db.query(`SELECT
   EXISTS(SELECT 1 FROM quant_foundation_jobs WHERE status IN ('RUNNING','STOPPING')) active,
   EXISTS(SELECT 1 FROM quant_io_launches WHERE state<>'STOP_PROVEN') launches,
   EXISTS(SELECT 1 FROM quant_io_ledgers WHERE pg_catalog.jsonb_typeof(state->'operations') IS DISTINCT FROM 'array') invalid,
   EXISTS(SELECT 1 FROM quant_io_ledgers l,LATERAL pg_catalog.jsonb_array_elements(l.state->'operations') op
    WHERE COALESCE(op->>'status','') NOT IN ('SETTLED','CRASHED')) operations`)).rows[0];
  if(!idle||['active','launches','invalid','operations'].some(name=>idle[name]!==false))
   refused('QUANT_DIAGNOSTIC_NOT_IDLE');
  const count=(await db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned
   FROM quant_foundation_jobs WHERE status=ANY($2::text[])`,[selected.owner_id,active])).rows[0];
  if(!count||!Number.isSafeInteger(count.total)||!Number.isSafeInteger(count.owned)||
     count.total<0||count.owned<0||count.owned>count.total)refused('QUANT_DIAGNOSTIC_QUEUE_INVALID');
  if(!previous&&(count.total>=100||count.owned>=20))refused('FOUNDATION_QUEUE_FULL');
  if(count.total>(previous&&['QUEUED','PAUSED'].includes(previous.status)?1:0))refused('QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY');
  const summary={mode:enqueue?'enqueue':'dry-run',contract_hash:contractHash,policy_hash:capacity.policy_hash,
   raw_bars:total,completion_mode:null,evaluator_admission:false};
  if(previous)return {...summary,job_id:previous.job_id,status:previous.status,reused:true};
  if(!enqueue)return {...summary,status:'READY',reused:false};
  const now=clock(),deadline=now+budget.max_runtime_ms;
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(deadline))refused('FOUNDATION_INVALID_CLOCK');
  await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[selected.owner_id]);
  const row=(await db.query(`INSERT INTO quant_foundation_jobs
   (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
   VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING job_id,status`,
   [randomUUID(),selected.owner_id,selected.idempotency_key,JSON.stringify(contract),contractHash,now,deadline])).rows[0];
  if(!row)refused('QUANT_DIAGNOSTIC_INSERT_FAILED');
  return {...summary,job_id:row.job_id,status:row.status,reused:false};
 },{isolation:'SERIALIZABLE'});
}

async function readPrivateRequest(filename){
 if(typeof filename!=='string'||!path.isAbsolute(filename))refused('QUANT_DIAGNOSTIC_PRIVATE_FILE_REQUIRED');
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();
  if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077)||info.size>16384)
   refused('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED');
  return validateDiagnosticRequest(JSON.parse(await file.readFile('utf8')));
 }finally{await file.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let db;
 try{
  const args=process.argv.slice(2);
  if(args.length<1||args.length>2||args[1]!==undefined&&args[1]!=='--enqueue')
   refused('QUANT_DIAGNOSTIC_USAGE');
  assertDiagnosticEnvironment();
  const request=await readPrivateRequest(args[0]),policy=await loadQuantCapacityPolicy();
  db=new PostgresDatabase();await db.runtimeLock();
  const pine=new PineBridgeService(new Store(db),{defaultRisk:config.defaultRisk});
  const research=new QuantResearchService({pineService:pine,foundation:true});
  const data=new QuantDataService({pineService:pine,datasetStore:research.datasetStore.raw,enabled:true});
  const profile=new QuantProfileService({pineService:pine,dataService:data,researchStore:research.datasetStore,
   capacityPolicy:policy,enabled:true,profileV2Enabled:true,enrollmentEnabled:false});
  console.log(JSON.stringify(await enqueueQuantProfileDiagnostic({db,profileService:profile,policy,request,enqueue:args[1]==='--enqueue'})));
 }catch(error){
  // Never print SQL, paths, connection strings, source or configuration contents.
  const code=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)?error.code:'QUANT_DIAGNOSTIC_FAILED';
  console.error(JSON.stringify({ok:false,code}));process.exitCode=2;
 }finally{await db?.close();}
}
