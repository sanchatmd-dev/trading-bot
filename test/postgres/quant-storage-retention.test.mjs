import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,utimes,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {assertQuantStorageOwner,maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

let admin,db,name,root,budget,url;
const offline={policy:{workerUnit:'qdqs-storage-test.service',releaseRoot:path.resolve('.')},manager:{show:async()=>({LoadState:'masked',ActiveState:'inactive',Job:'0',ControlGroup:''}),jobs:async()=>''},inventory:async()=>{},settleMs:0};
before(async()=>{
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});name='quant_retention_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString()});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql'])await db.query(await readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  root=await mkdtemp(path.join(os.tmpdir(),'quant-retention-'));
  await migrateQuantFoundation(db,{storageRoot:root});
  budget=new StorageBudget({root,diskQuotaBytes:10*1024*1024,tempQuotaBytes:4*1024*1024,freeFloorBytes:0});
});
test('filesystem maintenance stays protected beyond an aggressive idle transaction timeout',async()=>{
  let waited=false;
  const delayed={root,maintenance:async({assertExclusive})=>{
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.equal(await assertExclusive(),true);waited=true;return {applied:false};
  }};
  // A 100ms transaction idle limit would have killed the old implementation.
  for(let i=0;i<2;i++)await db.query("SET idle_in_transaction_session_timeout='100ms'");
  await maintainQuantStorage({db,budget:delayed,...offline});assert.equal(waited,true);
  await db.query("SET idle_in_transaction_session_timeout='20s'");
});
after(async()=>{await db?.close();if(name)await admin.query('DROP DATABASE '+name);await admin?.close();if(root)await rm(root,{recursive:true,force:true});});
test('storage namespace binds root/database and cannot be reassigned',async()=>{
  await assertQuantStorageOwner(db,root);assert.ok((await budget.inspect()).committedBytes>=0);
  await assert.rejects(db.query("UPDATE quant_storage_namespace SET root_hash=$1",['b'.repeat(64)]),/immutable/);
  const marker=path.join(root,'.database-owner.json'),original=await readFile(marker,'utf8');
  await writeFile(marker,original.replace(/"database_hash":"[a-f0-9]+"/,'"database_hash":"'+'c'.repeat(64)+'"'));
  await assert.rejects(assertQuantStorageOwner(db,root),{code:'STORAGE_DATABASE_BINDING_MISMATCH'});await writeFile(marker,original);
});
test('retention defaults dry run and requires offline runtime exclusion',async()=>{
  const store=new DatasetStore({root,storageBudget:budget});
  const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:60000,end_time:180000,warmup_bars:0,total_bars:2,cutoff:180000,source:'binance-spot-klines-v1'};
  const bars=[60000,120000].map(time=>({time,open:'100',high:'102',low:'99',close:'101',volume:'1'}));
  const reference=await store.publish(metadata,bars),orphan=reference.dataset_id;
  const kept=await store.publish({...metadata,cutoff:240000},bars);
  const contract={dataset:kept};await db.query("INSERT INTO quant_foundation_owners(owner_id) VALUES('retention-owner')");
  await db.query("INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,'retention-owner','terminal-evidence',$2,$3,'SUCCEEDED',1,2)",[randomUUID(),JSON.stringify(contract),hash(canonical(contract))]);
  const old=new Date(Date.now()-3*86400000);
  for(const id of [orphan,kept.dataset_id]){for(const file of ['manifest.json','chunk-00000.jsonl'])await utimes(path.join(root,id,file),old,old);await utimes(path.join(root,id),old,old);}
  const dry=await maintainQuantStorage({db,budget,...offline});assert.deepEqual(dry.candidates.map(c=>c.name),[orphan]);assert.ok(await readFile(path.join(root,orphan,'manifest.json'),'utf8'));
  const runtime=new PostgresDatabase({connectionString:url.toString()});try{await runtime.runtimeLock();await assert.rejects(maintainQuantStorage({db,budget,apply:true,...offline}),{code:'RECOVERY_RUNTIME_ACTIVE'});}finally{await runtime.close();}
  await maintainQuantStorage({db,budget,apply:true,...offline});await assert.rejects(readFile(path.join(root,orphan,'manifest.json')),error=>error.code==='ENOENT');assert.ok(await readFile(path.join(root,kept.dataset_id,'manifest.json'),'utf8'));await assertQuantStorageOwner(db,root);
});
