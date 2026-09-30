import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {canonical,hash,keys,fail} from '../pine-bridge/source.js';
import {readJson} from './http.js';
import {planIngestionRange,periodPreview,RESEARCH_PERIODS,PLANNED_1M_STAGE_BUDGETS,INGESTION_CAPABILITY} from '../quant-research/ingestion-range.js';
import {validateFoundationRequest,validateBackfillState,validateBackfillResult} from '../quant-research/foundation-contract.js';
import {DatasetStore} from '../quant-research/dataset-store.js';
import {StorageBudget} from '../quant-research/storage-budget.js';
import {assertQuantStorageOwner} from './quant-storage-retention.js';
import {rawProfileReadiness} from '../quant-research/data-profile.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../quant-research/runtime-engine-files.js';

const active=['QUEUED','PAUSED','RUNNING','STOPPING'];
const files=['src/postgres/quant-data.js','src/postgres/quant-profile.js','src/quant-research/profile-contract.js','src/postgres/quant-research-main.js',
  'src/postgres/quant-research-foundation.js','src/postgres/quant-foundation-scheduler.js',
  'src/postgres/quant-foundation-recovery.js','src/postgres/quant-storage-retention.js',
  'src/quant-research/spot-ingestion.js','src/quant-research/ingestion-range.js',
  'src/quant-research/data-profile.js','src/money.js','src/quant-research/research-dataset-store.js',
  'src/quant-research/io-controls.js',
  'src/quant-research/foundation-contract.js','src/quant-research/dataset-store.js',
  'src/quant-research/storage-budget.js','src/quant-research/resource-health.js',
  'src/quant-research/health-recovery-gate.js','src/quant-research/scheduler-health.js','src/quant-research/bounded-health-probe.js',
  'src/quant-research/atr14-chunk-store.js','src/quant-research/capacity-contract.js',
  'src/quant-research/foundation-contract-v2.js','src/quant-research/profile-contract-v2.js',
  'src/quant-research/data-profile-v2.js','src/quant-research/profile-pipeline-v2.js','src/quant-research/io-terminal.js',
  'src/quant-research/research-contract-v2.js'];
export const INGESTION_ENGINE_FILES=Object.freeze([...new Set([...files,...QUANT_RUNTIME_ENGINE_FILES])]);
export async function ingestionEngineHash(readFile=fs.readFile){
  const values=await Promise.all(INGESTION_ENGINE_FILES.map(async name=>[name,hash(await readFile(new URL('../../'+name,import.meta.url)))]));
  return hash(canonical(Object.fromEntries(values)));
}
const normalized=value=>{
  keys(value,['bot_id','start_time','end_time','warmup_bars','cutoff']);
  if(typeof value.bot_id!=='string'||!value.bot_id)throw fail('INVALID_INGESTION_BOT');
  return {...value};
};
const range=value=>({broker:INGESTION_CAPABILITY.broker,symbol:INGESTION_CAPABILITY.symbol,
  timeframe:INGESTION_CAPABILITY.timeframe,start_time:value.start_time,end_time:value.end_time,
  warmup_bars:value.warmup_bars,cutoff:value.cutoff});

/** Transaction-local API service. Server owns SERIALIZABLE transaction. */
export class QuantDataService{
  constructor({pineService,datasetStore,clock=Date.now,enabled=false}={}){
    this.pine=pineService;this.db=pineService?.db;this.clock=clock;this.enabled=enabled;
    if(enabled){
      if(!datasetStore){
        if(!process.env.QUANT_STORAGE_LIMITS_FILE)throw fail('QUANT_STORAGE_LIMITS_REQUIRED');
        const limits=JSON.parse(readFileSync(process.env.QUANT_STORAGE_LIMITS_FILE,'utf8'));
        const root=process.env.QUANT_RESEARCH_DATASET_ROOT;
        datasetStore=new DatasetStore({root,storageBudget:new StorageBudget({...limits,root})});
      }
      if(!datasetStore.storageBudget)throw fail('INGESTION_STORAGE_BUDGET_REQUIRED');
    }
    this.datasetStore=datasetStore;
  }
  async ready(){
    if(!this.enabled)throw fail('QUANT_DATA_DISABLED',503);
    const mode=(await this.db.query("SELECT to_regclass('quant_research_executor_mode') present")).rows[0];
    if(!mode?.present)throw fail('RESEARCH_FOUNDATION_SCHEMA_REQUIRED',503);
    const current=(await this.db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton')).rows[0];
    if(current?.mode!=='FOUNDATION')throw fail('RESEARCH_EXECUTOR_MODE_MISMATCH',503);
    const schema=(await this.db.query("SELECT to_regclass('quant_foundation_schema') present")).rows[0];
    if(!schema?.present)throw fail('RESEARCH_FOUNDATION_SCHEMA_REQUIRED',503);
    const version=(await this.db.query('SELECT version FROM quant_foundation_schema')).rows;
    if(version.length!==1||version[0].version!==1)throw fail('RESEARCH_FOUNDATION_SCHEMA_REQUIRED',503);
    await assertQuantStorageOwner(this.db,this.datasetStore.root);
  }
  async capability(){
    let enabled=false;
    if(this.enabled){try{await this.ready();enabled=true;}catch{/* Fail closed until local foundation readiness holds. */}}
    return {...INGESTION_CAPABILITY,enabled,verified_execution_profile:false,
      report_timezone:'UTC',periods:RESEARCH_PERIODS,planned_stage_budgets:PLANNED_1M_STAGE_BUDGETS};
  }
  async scope(owner,bot){
    if(!this.db.isTransaction)throw fail('INGESTION_TRANSACTION_REQUIRED');
    await this.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner]);
    if(bot!==owner)await this.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[bot]);
    await this.pine.authorize(owner,bot);
  }
  async preview(owner,body){
    await this.ready();
    keys(body,['bot_id','start_time','end_time','warmup_bars']);
    await this.scope(owner,body.bot_id);
    const cutoff=Math.floor(this.clock()/60000)*60000;
    const request=normalized({...body,cutoff});
    const plan=planIngestionRange(range(request),{now:this.clock()});
    return {capability:await this.capability(),plan,request};
  }
  async previewPeriod(owner,body){
    await this.ready();
    keys(body,['bot_id','period','end_time','warmup_bars','timezone','custom_start_time'],
      ['bot_id','period','end_time','warmup_bars','timezone']);
    await this.scope(owner,body.bot_id);
    if(body.period==='ALL_AVAILABLE')throw fail('AVAILABLE_HISTORY_UNVERIFIED');
    const cutoff=Math.floor(this.clock()/60000)*60000;
    if(!Number.isSafeInteger(body.end_time)||body.end_time>cutoff)throw fail('INVALID_INGESTION_RANGE');
    return {...periodPreview({...body,available_start_time:undefined}),cutoff};
  }
  async authorize(owner,contract,action,context={}){
    if(contract.kind!=='BACKFILL'||contract.owner_id!==owner)return {ok:false};
    if(action==='ACKNOWLEDGE_STOPPED')return {ok:context.stopped===true};
    try{
      await this.scope(owner,contract.bot_id);
      if(await ingestionEngineHash()!==contract.engine_hash)return {ok:false};
      if(action==='CLAIM'){
        const row=(await this.db.query('SELECT checkpoint,next_bar,result,status FROM quant_foundation_jobs WHERE job_id=$1',[context.job_id])).rows[0];
        if(row?.checkpoint){
          validateBackfillState(contract,row.next_bar,row.checkpoint.state);
          for(const page of row.checkpoint.state.pages){
            await this.datasetStore.inspect(page.reference);
            for await(const ignored of this.datasetStore.read(page.reference)){void ignored;}
          }
        }
      }
      return {ok:true};
    }catch{return {ok:false};}
  }
  expose(row){
    if(hash(canonical(row.contract))!==row.contract_hash)throw fail('FOUNDATION_INTEGRITY_FAILED');
    if(row.checkpoint){
      const {sha256,...payload}=row.checkpoint;
      if(hash(canonical(payload))!==sha256||payload.next_bar!==row.next_bar||
        payload.engine_hash!==row.contract.engine_hash||payload.snapshot_hash!==row.contract.snapshot_hash)
        throw fail('FOUNDATION_INTEGRITY_FAILED');
      validateBackfillState(row.contract,row.next_bar,payload.state);
    }else if(row.next_bar!==0)throw fail('FOUNDATION_INTEGRITY_FAILED');
    if(row.status==='SUCCEEDED')validateBackfillResult(row.contract,row.checkpoint,row.result);
    return {job_id:row.job_id,status:row.status,next_bar:row.next_bar,
    total_bars:row.contract.range?(row.contract.range.end_time-row.contract.range.start_time)/60000+row.contract.range.warmup_bars:0,
    diagnostic:row.diagnostic??null,result:row.status==='SUCCEEDED'?row.result:null,
    raw_only:true,verified_execution_profile:false};
  }
  async enqueue(owner,body,key){
    await this.ready();
    const request=normalized(body);
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    await this.scope(owner,request.bot_id);
    const previous=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,key])).rows[0];
    if(previous){
      if(previous.contract.kind!=='BACKFILL'||canonical(previous.contract.range)!==canonical(range(request))||previous.contract.bot_id!==request.bot_id)throw fail('IDEMPOTENCY_CONFLICT',409);
      return this.expose(previous);
    }
    const plan=planIngestionRange(range(request),{now:this.clock()});
    const count=(await this.db.query("SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned FROM quant_foundation_jobs WHERE status=ANY($2::text[])",[owner,active])).rows[0];
    if(count.total>=100||count.owned>=20)throw fail('FOUNDATION_QUEUE_FULL',429);
    const engine_hash=await ingestionEngineHash(),snapshot_hash=hash(canonical(range(request)));
    const contract=validateFoundationRequest({version:'quant-foundation-v1',owner_id:owner,bot_id:request.bot_id,
      kind:'BACKFILL',range:range(request),engine_hash,snapshot_hash,
      budget:{candidates:1,max_evaluations:1,chunk_bars:Math.min(1000,plan.total_bars),max_runtime_ms:900000,
        max_output_bytes:1024*1024,max_state_bytes:1024*1024}});
    await this.db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
    const now=this.clock(),id=randomUUID();
    const row=(await this.db.query(`INSERT INTO quant_foundation_jobs
      (job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at)
      VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,
      [id,owner,key,JSON.stringify(contract),hash(canonical(contract)),now,now+contract.budget.max_runtime_ms])).rows[0];
    return this.expose(row);
  }
  async get(owner,id,cancel=false,queryBotId=null){
    await this.ready();
    await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
    const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||row.owner_id!==owner||row.contract.kind!=='BACKFILL')throw fail('NOT_FOUND',404);
    if(queryBotId!==null&&queryBotId!==row.contract.bot_id)throw fail('NOT_FOUND',404);
    await this.scope(owner,row.contract.bot_id);
    if(!cancel||!active.includes(row.status))return this.expose(row);
    const stopping=['RUNNING','STOPPING'].includes(row.status),now=this.clock();
    const updated=(await this.db.query(`UPDATE quant_foundation_jobs SET status=$2,stop_reason=$3,lease_until=NULL,
      runtime_used_ms=runtime_used_ms+CASE WHEN run_started_at IS NULL THEN 0 ELSE GREATEST(0,$4-run_started_at) END,
      run_started_at=NULL WHERE job_id=$1 RETURNING *`,[id,stopping?'STOPPING':'CANCELLED',stopping?'CANCELLED':null,now])).rows[0];
    return this.expose(updated);
  }
  async profileReadiness(owner,id,queryBotId=null){
    await this.ready();
    const row=(await this.db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
    if(!row||row.owner_id!==owner||row.contract.kind!=='BACKFILL')throw fail('NOT_FOUND',404);
    if(queryBotId!==null&&queryBotId!==row.contract.bot_id)throw fail('NOT_FOUND',404);
    await this.scope(owner,row.contract.bot_id);
    // expose validates contract, checkpoint and completed-result integrity before disk reads.
    this.expose(row);
    if(row.status!=='SUCCEEDED')return {version:'raw-profile-readiness-v1',job_id:id,
      verified_execution_profile:false,enrollment_ready:false,blockers:['BACKFILL_NOT_SUCCEEDED']};
    return rawProfileReadiness(row,this.datasetStore);
  }
}

export async function quantDataRoutes(req,res,url,actor,service,json,{enabled=false}={}){
  const prefix='/api/quant/data';
  if(url.pathname!==prefix+'/capability'&&!url.pathname.startsWith(prefix+'/'))return false;
  const query=[...url.searchParams.entries()];
  if(query.length>1||query.some(([name,value])=>name!=='bot_id'||!value))throw fail('INVALID_FIELDS');
  const queryBotId=query[0]?.[1]??null;
  if(url.pathname===prefix+'/capability'&&req.method==='GET'){json(res,200,await service.capability());return true;}
  if(!enabled)throw fail('QUANT_DATA_DISABLED',503);
  if(url.pathname===prefix+'/range-preview'&&req.method==='POST'){
    const body=await readJson(req);if(queryBotId!==null&&queryBotId!==body.bot_id)throw fail('INVALID_FIELDS');
    json(res,200,await service.preview(actor.id,body));return true;
  }
  if(url.pathname===prefix+'/period-preview'&&req.method==='POST'){
    const body=await readJson(req);if(queryBotId!==null&&queryBotId!==body.bot_id)throw fail('INVALID_FIELDS');
    json(res,200,await service.previewPeriod(actor.id,body));return true;
  }
  if(url.pathname===prefix+'/jobs'&&req.method==='POST'){
    const body=await readJson(req);if(queryBotId!==null&&queryBotId!==body.bot_id)throw fail('INVALID_FIELDS');
    json(res,202,await service.enqueue(actor.id,body,req.headers['idempotency-key']));return true;
  }
  const profile=url.pathname.match(/^\/api\/quant\/data\/jobs\/([a-f0-9-]{36})\/profile-readiness$/);
  if(profile&&req.method==='GET'){json(res,200,await service.profileReadiness(actor.id,profile[1],queryBotId));return true;}
  const match=url.pathname.slice((prefix+'/jobs').length).match(/^\/([a-f0-9-]{36})(\/cancel)?$/);
  if(url.pathname.startsWith(prefix+'/jobs/')&&match&&((req.method==='GET'&&!match[2])||(req.method==='POST'&&match[2]))){
    if(match[2])keys(await readJson(req),[]);
    json(res,200,await service.get(actor.id,match[1],!!match[2],queryBotId));return true;
  }
  throw fail('NOT_FOUND',404);
}
