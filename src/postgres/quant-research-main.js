import {PostgresDatabase} from './db.js';
import {Store} from './store.js';
import {PineBridgeService} from './pine-bridge.js';
import {QuantResearchService} from './quant-research.js';
import {QuantResearchWorker} from './quant-research-worker.js';
import {config,assertProductionConfig} from '../config.js';
assertProductionConfig();
if(process.env.QUANT_RESEARCH_ENABLED!=='1'||process.env.PINE_BRIDGE_ENV!=='staging'||!config.paperTrading)throw Error('Dedicated Quant research worker requires Paper staging');
const db=new PostgresDatabase();await db.runtimeLock();await db.verifySchema();
const rows=(await db.query('SELECT version FROM quant_job_schema')).rows;
if(rows.length!==1||rows[0].version!==1)throw Error('Initialize Quant research extension 1 offline');
const worker=new QuantResearchWorker({service:new QuantResearchService({pineService:new PineBridgeService(new Store(db),{defaultRisk:config.defaultRisk})})});
worker.start();console.log('Dedicated PostgreSQL Quant research worker started');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await worker.stop();await db.close();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
