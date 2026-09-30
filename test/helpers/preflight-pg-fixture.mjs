import {cp,mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantDataService} from '../../src/postgres/quant-data.js';
import {QuantPreflightService} from '../../src/postgres/quant-preflight.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {validateBackfillResult,validateFoundationRequest} from '../../src/quant-research/foundation-contract.js';
import {config} from '../../src/config.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {PF2_REPLAY_ENVELOPE_VERSION,PF2_REPLAY_LIMITATIONS,PF2_RESULT_VERSION} from '../../src/quant-research/preflight-replay.js';
import {MINUTE} from './pf2-fixture.js';

/**
 * PF-2 R3 PostgreSQL fixture. Isolated local PostgreSQL only. Every row written here is a clearly labeled
 * test fixture ('fixture:' idempotency keys, 'pf-' identities, synthetic Pine source and bars): none of it is
 * enrollment evidence, none of it a real PROFILE v2 enrollment, BACKFILL capture or holdout registration.
 */
export const FIXTURE_LABEL='PF-2 R3 test fixture: synthetic rows, never enrollment evidence';
export const sha=letter=>letter.repeat(64);
const clone=value=>structuredClone(value);
const sqlFile=name=>readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8');
const json=value=>JSON.stringify(value);

/** Default registered boundary: 100 minutes after the end of the fixture dataset (development range only). */
export const defaultBoundary=scenario=>scenario.enrollment.contract.dataset.metadata.end_time+100*MINUTE;

/**
 * One isolated database with the full foundation and preflight schema, a storage root bound to it that holds a copy
 * of the shared PF-2 datasets, real Store, PineBridgeService, QuantDataService and a QuantPreflightService.
 * `base` comes from createPf2Base (real raw, closed and ATR datasets on a temporary root).
 */
export async function createHarness({admin,base,executableHashes,supportedSourceHash,capacityPolicy}={}){
  const name='preflight_r3_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  const db=new PostgresDatabase({connectionString:url.toString()});
  const root=await mkdtemp(path.join(os.tmpdir(),'preflight-r3-'));
  await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql'])await db.query(await sqlFile(file));
  // The storage root must be empty while it is bound to the database; the datasets are copied in afterwards.
  await migrateQuantFoundation(db,{mode:'FOUNDATION',storageRoot:root});
  await cp(base.root,root,{recursive:true});
  const budget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const rawStore=new DatasetStore({root,storageBudget:budget});
  const researchStore=new ResearchDatasetStore({root,storageBudget:budget,allowUnsupportedDirectorySyncForTests:true});
  const store=new Store(db);
  const pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
  const data=new QuantDataService({pineService:pine,datasetStore:rawStore,clock:()=>Date.now(),enabled:true});
  const policy=capacityPolicy??base.defaultScenario.enrollment.capacity_policy;
  const hashes=executableHashes??(async()=>({...base.executables}));
  const stores={raw:rawStore,research:researchStore};
  const options={pineService:pine,dataService:data,stores,capacityPolicy:policy,clock:()=>Date.now(),enabled:true,
    supportedSourceHash:supportedSourceHash??base.defaultScenario.supportedSourceHash,executableHashes:hashes};
  const service=new QuantPreflightService(options);
  return {name,db,root,store,pine,data,stores,service,options,base,capacityPolicy:policy,admin,
    tx:fn=>db.transaction(fn,{isolation:'SERIALIZABLE'}),
    /** Another service over the same database, with some options replaced. */
    serviceWith:overrides=>new QuantPreflightService({...options,...overrides}),
    async dispose(){
      await db.close();
      await admin.query('DROP DATABASE IF EXISTS '+name);
      await rm(root,{recursive:true,force:true});
    }};
}

let identities=0;
const label=()=>(++identities)+'-'+randomUUID().slice(0,8);

/** One owner with separate bot profiles (distinct accounts, so bot scope differs from owner scope). */
export async function createAccounts(db,{botCount=1}={}){
  const id=label(),owner='pf-owner-'+id,now=Date.now();
  await db.query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'test-fixture-not-a-hash',$3)",
    [owner,owner+'@example.invalid',now]);
  const bots=[];
  for(let index=0;index<botCount;index++){
    const bot='pf-bot-'+id+'-'+index;
    await db.query("INSERT INTO users(id,email,password_hash,created_at,parent_user_id,bot_slot_index) VALUES($1,$2,'test-fixture-not-a-hash',$3,$4,$5)",
      [bot,bot+'@example.invalid',now,owner,index+2]);
    bots.push(bot);
  }
  return {owner,bots,bot:bots[0]};
}

export const riskPolicy=()=>({...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,
  equities:{'binance-global':1000},balances:{'binance-global':800}});

/** BACKFILL contract, seal, checkpoint and result that pass validateBackfillResult over the scenario provenance. */
export function backfillFixture({owner,bot,scenario}){
  const raw=scenario.enrollment.contract.dataset,meta=raw.metadata;
  const range={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',
    start_time:meta.start_time+meta.warmup_bars*MINUTE,end_time:meta.end_time,warmup_bars:meta.warmup_bars,
    cutoff:meta.cutoff};
  const contract=validateFoundationRequest({version:'quant-foundation-v1',owner_id:owner,bot_id:bot,kind:'BACKFILL',
    range,engine_hash:sha('b'),snapshot_hash:hash(canonical(range)),
    budget:{candidates:1,max_evaluations:1,chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:1048576,
      max_state_bytes:1048576}});
  const pages=scenario.provenance.pages.map((page,index)=>({reference:{dataset_id:hash('fixture-page-'+index),
    sha256:hash('fixture-page-'+index),metadata:{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
      symbol:'BTCUSDT',timeframe:'1',start_time:page.start_time,end_time:page.end_time,warmup_bars:0,
      total_bars:page.count,cutoff:meta.cutoff,source:'binance-spot-klines-v1'}},provenance:clone(page)}));
  const checkpoint={next_bar:meta.total_bars,state:{version:'backfill-pages-v1',pages},
    engine_hash:contract.engine_hash,snapshot_hash:contract.snapshot_hash};
  checkpoint.sha256=hash(canonical(checkpoint));
  const result={version:'spot-ingestion-v1',dataset:clone(raw),provenance:clone(scenario.provenance),raw_only:true,
    verified_execution_profile:false};
  validateBackfillResult(contract,checkpoint,result);
  return {contract,checkpoint,result,contract_hash:hash(canonical(contract))};
}

/** Direct fixture insert of a foundation job (labeled key). Returns the job id. */
export async function insertFoundationJob(db,{jobId=randomUUID(),owner,contract,status='SUCCEEDED',result=null,
  checkpoint=null,nextBar=0,contractHash=hash(canonical(contract)),now=Date.now(),idempotencyKey='fixture:'+jobId}){
  await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,
    created_at,deadline_at,result,checkpoint,next_bar) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [jobId,owner,idempotencyKey,json(contract),contractHash,status,now,now+900000,
    result===null?null:json(result),checkpoint===null?null:json(checkpoint),nextBar]);
  return jobId;
}

const omit=(value,names)=>Object.fromEntries(Object.entries(value).filter(([name])=>!names.includes(name)));

/**
 * A complete, consistent world for one owner and one bot, built from the PF-2 scenario generator (real Pine source
 * analysis, real datasets) and the live Paper policy and capital of the bot: users, risk and funding, Pine source,
 * revision, membership, READY deployment, a SUCCEEDED BACKFILL job, a SUCCEEDED quant-foundation-v2 PROFILE job
 * (a labeled fixture row, not a real enrollment) and, unless boundary is null, a registered holdout boundary row.
 * `edits` reach the scenario generator (snapshot and enrollment hooks are chained, not replaced); `risk` overrides
 * fields of the bot's Paper policy before the snapshot is captured.
 */
export async function createWorld(harness,{edits={},boundary,accounts,risk={}}={}){
  const {db,store,base}=harness;
  const owned=accounts??await createAccounts(db);
  const {owner,bot}=owned;
  await store.setRisk(bot,{...riskPolicy(),...risk});
  const policy=await store.risk(bot,config.defaultRisk);
  const capital=await store.paperAccounts(bot);
  const cutoff=(await db.query('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=$1',[bot])).rows[0].cutoff;
  const importId=randomUUID(),deploymentId='pf-deployment-'+randomUUID(),rawJobId=randomUUID(),profileJobId=randomUUID();
  const scenario=await base.scenario({policy,capital:{cash:'800',equity:'1000'},
    market:{deployment_id:deploymentId,pine_import_id:importId,...edits.market},
    snapshot:snapshot=>{snapshot.capital=clone(capital);snapshot.funding_cutoff=cutoff;edits.snapshot?.(snapshot);},
    enrollmentOptions:{owner,bot},
    enrollment:enrollment=>{enrollment.contract.profile.raw_job_id=rawJobId;edits.enrollment?.(enrollment);},
    ...omit(edits,['snapshot','enrollment','market'])});
  const now=Date.now(),analysis=scenario.records.effective_inputs,source=scenario.source,sourceHash=hash(source);
  await db.query('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',
    [importId,owner,bot,sourceHash,'fixture',source,json(analysis),now]);
  await db.query('INSERT INTO pine_source_revisions(pine_import_id,source_version,source_hash,source,analysis,created_at) VALUES($1,1,$2,$3,$4,$5)',
    [importId,sourceHash,source,json(analysis),now]);
  await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,TRUE)',
    [importId,owner,bot]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'READY',$7)",
    [deploymentId,owner,bot,importId,json(scenario.snapshot),scenario.snapshotHash,now]);
  const backfill=backfillFixture({owner,bot,scenario});
  await insertFoundationJob(db,{jobId:rawJobId,owner,contract:backfill.contract,result:backfill.result,
    checkpoint:backfill.checkpoint,nextBar:scenario.enrollment.contract.dataset.metadata.total_bars});
  await insertFoundationJob(db,{jobId:profileJobId,owner,contract:scenario.enrollment.contract,
    result:scenario.enrollment.result});
  const registered=boundary===null?null:boundary??defaultBoundary(scenario);
  if(registered!==null)await insertBoundary(db,{owner,bot,value:registered});
  return {...owned,scenario,importId,deploymentId,rawJobId,profileJobId,backfill,boundary:registered,
    request:{bot_id:bot,deployment_id:deploymentId,profile_job_id:profileJobId},now:scenario.now,
    supportedSourceHash:scenario.supportedSourceHash,sourceHash};
}

/** Direct fixture insert of a registry row (the write-once API path is exercised separately). */
export const insertBoundary=(db,{owner,bot,value,createdBy=owner})=>db.query(
  'INSERT INTO quant_holdout_boundaries(owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [owner,bot,'binance-global','SPOT','BTCUSDT','1',value,createdBy,Date.now()]);

/** Out-of-band tampering with the write-once registry, as an operator with table privileges could do. */
export async function tamperBoundary(db,{owner,bot,value}){
  await db.query('ALTER TABLE quant_holdout_boundaries DISABLE TRIGGER quant_holdout_boundary_write_once');
  try{
    if(value===null)await db.query('DELETE FROM quant_holdout_boundaries WHERE owner_id=$1 AND bot_id=$2',[owner,bot]);
    else await db.query('UPDATE quant_holdout_boundaries SET holdout_start_time=$3 WHERE owner_id=$1 AND bot_id=$2',[owner,bot,value]);
  }
  finally{await db.query('ALTER TABLE quant_holdout_boundaries ENABLE TRIGGER quant_holdout_boundary_write_once');}
}

/**
 * Fixture PREFLIGHT job pair that bypasses enqueue, so a test can point the binding row anywhere. owner and bot go
 * into the binding row; jobOwner owns the foundation job row and defaults to owner (the database binds neither).
 */
export async function insertPreflightPair(db,{planned,owner,bot,jobOwner=owner,deploymentId,profileJobId,status='QUEUED',
  now=Date.now()}){
  const jobId=randomUUID();
  await insertFoundationJob(db,{jobId,owner:jobOwner,contract:planned.plan.foundation,status,contractHash:planned.contract_hash,now});
  await db.query('INSERT INTO quant_preflight_jobs(job_id,owner_id,bot_id,plan_hash,plan_json,deployment_id,profile_job_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [jobId,owner,bot,planned.plan_hash,planned.plan_json,deploymentId,profileJobId,now]);
  return jobId;
}

const S1_LIMITATIONS=['V1_ONLY','DEVELOPMENT_ONLY','EVALUATOR_ADMISSION_FALSE','DIAGNOSTIC_ONLY',
  'SIZING_ADJUSTED_INCLUDES_QUANTITY_STEP_ROUNDING'];
const ADMISSION={development_only:true,evaluator_admission:false,holdout_accessed:false,orders_executed:false,
  execution_model_parity:'V1_ONLY'};

/**
 * A hand-made no-trade envelope that satisfies every S4 invariant of validatePreflightEnvelope (no Python needed),
 * shaped from the output of a real resolveHistoricalPreflight. It is a labeled fixture, never a replay result.
 */
export function fixtureEnvelope({resolved,planHash}){
  const d=resolved.dataset,chunk=resolved.budget.chunk_bars;
  const window={first_time:d.first_time,evaluation_start_time:d.evaluation_start_time,last_time:d.last_time,
    development_end_time:d.development_end_time,holdout_start_time:d.holdout_start_time,bars_seen:d.total_bars,
    warmup_bars:d.warmup_bars,evaluated_bars:d.total_bars-d.warmup_bars};
  const result={version:PF2_RESULT_VERSION,plan_hash:planHash,execution_model_version:'paper-close-v1',window,
    counters:{signals:{buy:0,native_exit:0,buy_evaluated:0,native_exit_evaluated:0},
      intents:{buy:0,exit_sl:0,exit_tp:0,exit_native:0},warmup_intents:{buy:0,exit:0},
      orders:{accepted:0,sizing_adjusted:0,rejected:0,rejected_by_reason:{}},
      fills:{buy:0,exit:0,exit_by_reason:{}},episodes:{closed:0,losing:0}},
    derived:{intents_evaluated:0,suppressed_buy:0,suppressed_buy_evaluated:0,non_losing_episodes:0},
    guards:{kill_switch:false,loss_streak_final:0,pause:{persistent:false,active_kinds:[],periods:[],truncated:false,
      dropped_periods:0}},
    account:{cash:'800',position_quantity:'0',position_cost:'0',open_allocations:0},
    samples:{fills:[],rejections:[]},admission:{...ADMISSION},limitations:[...S1_LIMITATIONS]};
  const ids=resolved.identities;
  return {version:PF2_REPLAY_ENVELOPE_VERSION,plan_hash:planHash,owner_id:resolved.owner_id,bot_id:resolved.bot_id,
    binding:{contract_sha256:sha('1'),resolved_sha256:sha('2'),contract_digest:sha('3'),engine_hash:ids.engine_hash,
      evaluator_hash:ids.evaluator_hash,raw_dataset_sha256:ids.raw_dataset_sha256,
      closed_dataset_sha256:ids.closed_dataset_sha256,atr14_sha256:ids.atr14_sha256,
      enrollment_binding_sha256:ids.enrollment_binding_sha256},
    dataset:{first_time:d.first_time,evaluation_start_time:d.evaluation_start_time,last_time:d.last_time,
      total_bars:d.total_bars,warmup_bars:d.warmup_bars,development_end_time:d.development_end_time,
      holdout_start_time:d.holdout_start_time},
    run:{chunk_bars:chunk,chunks_executed:Math.ceil(d.total_bars/chunk),resumed_from_bar:0},
    result,admission:{...ADMISSION},acceptance_blockers:[...resolved.acceptance_blockers],
    limitations:[...new Set([...resolved.limitations,...S1_LIMITATIONS,...PF2_REPLAY_LIMITATIONS])]};
}

/** A labeled quant-foundation-v1 PROFILE row for a world: an old-style enrollment the PF-2 builder must refuse. */
export async function insertV1Profile(db,world,{modelVersion='paper-close-v1'}={}){
  const enrolled=world.scenario.enrollment.contract;
  const contract=validateFoundationRequest({version:'quant-foundation-v1',owner_id:world.owner,bot_id:world.bot,
    kind:'PROFILE',dataset:clone(enrolled.dataset),engine_hash:sha('f'),snapshot_hash:enrolled.profile.snapshot_hash,
    profile:{...clone(enrolled.profile),execution_model:{...clone(enrolled.profile.execution_model),version:modelVersion}},
    budget:{candidates:1,max_evaluations:1,chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:1048576,
      max_state_bytes:1048576}});
  return insertFoundationJob(db,{owner:world.owner,contract,result:{version:'research-profile-enrollment-v1',fixture:true}});
}
