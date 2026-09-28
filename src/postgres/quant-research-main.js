import {PostgresDatabase} from './db.js';
import {Store} from './store.js';
import {PineBridgeService} from './pine-bridge.js';
import {QuantResearchService} from './quant-research.js';
import {QuantResearchWorker} from './quant-research-worker.js';
import fs from 'node:fs/promises';
import {QuantResearchFoundationWorker} from './quant-research-foundation.js';
import {createResourceHealth,loopbackHealthProbe} from '../quant-research/resource-health.js';
import {assertQuantWorkerUnit} from './quant-foundation-recovery.js';
import {assertQuantStorageOwner} from './quant-storage-retention.js';
import {config,assertProductionConfig} from '../config.js';
assertProductionConfig();
if(process.env.QUANT_RESEARCH_ENABLED!=='1'||process.env.PINE_BRIDGE_ENV!=='staging'||!config.paperTrading)throw Error('Dedicated Quant research worker requires Paper staging');
const foundation=process.env.QUANT_RESEARCH_FOUNDATION_ENABLED==='1';
if(foundation)await assertQuantWorkerUnit(process.env.QUANT_WORKER_UNIT);
const db=new PostgresDatabase();await db.runtimeLock();await db.verifySchema();
const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
if(rows.length!==1||rows[0].version!==1)throw Error('Initialize Quant research extension 1 offline');
const service=new QuantResearchService({pineService:new PineBridgeService(new Store(db),{defaultRisk:config.defaultRisk}),foundation});
await db.transaction(()=>service.executorMode());
let worker,healthDb;
if(foundation){
 if(process.platform!=='linux')throw Error('Foundation worker requires Linux systemd resource isolation');
 for(const table of ['quant_foundation_schema','quant_research_foundation_schema']){
  if(!(await db.query('SELECT to_regclass($1) present',[table])).rows[0].present)throw Error('Initialize research foundation adapter offline');
  const versions=(await db.query('SELECT version FROM '+table)).rows;
  if(versions.length!==1||versions[0].version!==1)throw Error('Unsupported research foundation extension');
 }
 const old=(await db.query("SELECT count(*)::int total FROM quant_jobs WHERE status IN ('QUEUED','RUNNING') AND COALESCE(contract->>'execution_backend','')<>'quant-foundation-v1'")).rows[0];
 if(old.total)throw Error('Drain legacy research jobs before foundation startup');
 if(!process.env.QUANT_HEALTH_LIMITS_FILE||!process.env.QUANT_HEALTH_URL)throw Error('Foundation worker requires reviewed resource health limits and local Paper API probe');
 const limits=JSON.parse(await fs.readFile(process.env.QUANT_HEALTH_LIMITS_FILE,'utf8'));
 await assertQuantStorageOwner(db,process.env.QUANT_RESEARCH_DATASET_ROOT);
 if(process.env.QUANT_HEALTH_DATABASE_URL)healthDb=new PostgresDatabase({connectionString:process.env.QUANT_HEALTH_DATABASE_URL,max:2});
 const health=createResourceHealth({db,tradingDb:healthDb??db,limits,probe:loopbackHealthProbe(process.env.QUANT_HEALTH_URL),storageRoot:process.env.QUANT_RESEARCH_DATASET_ROOT});
 worker=new QuantResearchFoundationWorker({service,health});
}else worker=new QuantResearchWorker({service});
worker.start();console.log('Dedicated PostgreSQL Quant research worker started');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await worker.stop();await healthDb?.close();await db.close();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
