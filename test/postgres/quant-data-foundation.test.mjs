import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {bindQuantStorage,maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {recoverQuantFoundation} from '../../src/postgres/quant-foundation-recovery.js';
import {QuantDataService} from '../../src/postgres/quant-data.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {readSpotHistory} from '../../src/quant-research/spot-ingestion.js';
import {planIngestionRange} from '../../src/quant-research/ingestion-range.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {validateBackfillResult} from '../../src/quant-research/foundation-contract.js';

let admin,db,name,root,budget,data,worker,user,now;
const offline={policy:{workerUnit:'qdqs-data-test.service',releaseRoot:path.resolve('.')},
  manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},
  inventory:async()=>{},settleMs:0};
const minute=60000;
function response(url){
  const params=new URL(url).searchParams,start=Number(params.get('startTime')),count=Number(params.get('limit'));
  const rows=Array.from({length:count},(_,i)=>{const time=start+i*minute;
    return [time,'100','102','99','101','1',time+minute-1,'0',1,'0','0','0'];});
  return new Response(JSON.stringify(rows));
}
function request(total=2100,warmup=100){
  const end=Math.floor(now/minute)*minute;
  return {bot_id:user.id,start_time:end-(total-warmup)*minute,end_time:end,warmup_bars:warmup,cutoff:end};
}
async function job(id){return (await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];}
function makeWorker(fetcher=async url=>response(url),leaseMs=30000){
  const service={foundation:true,db,executorMode:async()=>{},datasetStore:{raw:data.datasetStore}};
  return new QuantResearchFoundationWorker({service,dataService:data,health:async()=>({ok:true}),clock:()=>now,
    leaseMs,fetchHistory:(range,options)=>readSpotHistory(range,{...options,fetcher})});
}
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_data_foundation_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
    'quant-research-foundation-schema.sql','quant-storage-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  root=await fs.mkdtemp(path.join(os.tmpdir(),'quant-data-foundation-'));
  await db.transaction(()=>bindQuantStorage(db,root));
  budget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const datasetStore=new DatasetStore({root,storageBudget:budget});
  const store=new Store(db);user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'TEST',role:'ADMIN'});
  now=Math.floor(Date.now()/minute)*minute+minute*4;
  data=new QuantDataService({pineService:{db,authorize:async(owner,bot)=>{
    if(owner!==user.id||bot!==user.id)throw Error('forbidden');}},datasetStore,clock:()=>now,enabled:true});
});
after(async()=>{await db?.close();if(name)await admin.query('DROP DATABASE '+name);await admin?.close();if(root)await fs.rm(root,{recursive:true,force:true});});

test('real scheduler resumes checkpointed pages after fenced offline recovery and retains all raw references',async()=>{
  const intent=request(),preview=await db.transaction(()=>data.preview(user.id,{bot_id:intent.bot_id,
    start_time:intent.start_time,end_time:intent.end_time,warmup_bars:intent.warmup_bars}));
  const queued=await db.transaction(()=>data.enqueue(user.id,preview.request,randomUUID()));
  worker=makeWorker();
  const first=await worker.scheduler.claim('data-test');assert.equal(first.contract.kind,'BACKFILL');
  const pageRange={...first.contract.range,start_time:first.contract.range.start_time-100*minute,
    end_time:first.contract.range.start_time+900*minute,warmup_bars:0};
  const pages=[];const bars=readSpotHistory(pageRange,{clock:()=>now,fetcher:async url=>response(url),
    beforePage:async()=>true,onPage:page=>pages.push(page)});
  const reference=await data.datasetStore.publish(planIngestionRange(pageRange,{now}).metadata,bars,{chunkBars:1000});
  const state={version:'backfill-pages-v1',pages:[{reference,provenance:pages[0]}]};
  await worker.scheduler.checkpoint(first,{next_bar:1000,state});
  await db.query("UPDATE quant_foundation_jobs SET status='STOPPING',stop_reason='LEASE_EXPIRED',lease_until=NULL,run_started_at=NULL WHERE job_id=$1",[first.job_id]);
  const recovery=await recoverQuantFoundation({db,...offline});
  assert.deepEqual(recovery.recovered,[{job_id:first.job_id,status:'PAUSED'}]);
  assert.equal((await job(first.job_id)).next_bar,1000);
  assert.equal(await worker.tick(),true);
  const done=await job(first.job_id);assert.equal(done.status,'SUCCEEDED');
  validateBackfillResult(done.contract,done.checkpoint,done.result);
  assert.equal(done.result.dataset.metadata.warmup_bars,100);
  assert.equal(done.result.provenance.pages.length,3);
  let count=0;for await(const ignored of data.datasetStore.read(done.result.dataset)){void ignored;count++;}
  assert.equal(count,2100);
  const retention=await maintainQuantStorage({db,budget,...offline});
  assert.deepEqual(retention.candidates,[]);
});

test('cancel keeps STOPPING and global slot until fetch and publish promise settles',async()=>{
  const intent=request(10,0),queued=await db.transaction(()=>data.enqueue(user.id,intent,randomUUID()));
  let entered;const started=new Promise(resolve=>entered=resolve);
  let release;const gate=new Promise(resolve=>release=resolve);
  const delayed=makeWorker(async url=>{entered();await gate;return response(url);},100);
  const tick=delayed.tick();await started;
  const running=await job(queued.job_id);assert.equal(running.status,'RUNNING');
  await db.transaction(()=>data.get(user.id,queued.job_id,true));
  assert.equal((await job(queued.job_id)).status,'STOPPING');
  assert.equal(await delayed.scheduler.claim('other-worker'),null);
  assert.equal(delayed.activeLaunches.size,1);
  release();await tick;
  assert.equal(delayed.activeLaunches.size,0);
  assert.equal((await job(queued.job_id)).status,'CANCELLED');
});
