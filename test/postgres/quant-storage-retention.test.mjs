import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,utimes,mkdir,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {assertQuantStorageOwner,maintainQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {Store} from '../../src/postgres/store.js';
import {lockInputs,candidatePlan,RULES} from '../../src/quant-research/contract.js';
import {buildResearchContractV2,pendingMetadata,datasetBindingParameters,datasetBindingIdentity,
  expectedFoundationRequestV2,materializeExecutionContract,DATASET_BINDING_STEP_ID,DATASET_BINDING_KIND} from '../../src/quant-research/research-contract-v2.js';
import {fixture,source} from '../helpers/quant-research-fixture.mjs';
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

let prepared;
async function v2Fixture(){
  if(prepared)return prepared;
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  const owner=(await new Store(db).createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
  const pineImport=randomUUID(),deploymentId=randomUUID(),f=fixture();
  const policy={paperTrading:true,requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':1000}};
  const capital={broker:'binance-global',configuredEquity:'1000',configuredBalance:'1000'};
  const snapshot={source_hash:hash(source),artifact_hash:hash('retention-fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},
    policy,policy_hash:hash(canonical(policy)),capital:[capital],funding_cutoff:0,
    membership:[{pine_import_id:pineImport,source_version:1,source_hash:hash(source),analysis:f.analysis}],
    selection:{...f.selection,bindings:[],fixed_inputs:f.analysis.inputs}};
  const sourceRow={source,source_hash:hash(source),analysis:f.analysis};
  const deployment={deployment_id:deploymentId,pine_import_id:pineImport,source_version:1,snapshot_hash:hash(canonical(snapshot))};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',
    [pineImport,owner,hash(source),'Retention synthetic fixture',source,JSON.stringify(f.analysis),1]);
  await db.query("INSERT INTO pine_deployments VALUES($1,$2,$2,$3,1,$4,$5,'READY',1)",
    [deploymentId,owner,pineImport,JSON.stringify(snapshot),deployment.snapshot_hash]);
  const lock=lockInputs(f.analysis,snapshot.selection,f.slots,f.bridge_domains),plan=candidatePlan(lock,25,27);
  const start=1800000000000,count=3250,model={version:'paper-close-v1',price_tick:.01,quantity_step:.001,
    fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
  const contract=buildResearchContractV2({owner_id:owner,bot_id:owner,deployment,source:sourceRow,snapshot,lock,plan,model,rules:RULES,
    capital,engine_hash:hash('synthetic-retention-engine'),dataset:{start_time:start,end_time:start+(count-1)*60000,warmup_bars:1250,content_digest:hash('synthetic-verified-range')}});
  const bars=Array.from({length:count},(_,i)=>({time:start+i*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',
    atr14:'2',price_tick:'0.01',quantity_step:'0.001'}));
  // Publication reserves the bounded writer envelope, beyond the tiny legacy maintenance fixture budget.
  const publicationBudget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  const research=new ResearchDatasetStore({root,storageBudget:publicationBudget});
  const references=await research.publish(pendingMetadata(contract),bars,{model});
  const binding=datasetBindingParameters(contract,{references,dataset_sha256:hash(canonical(bars))});
  prepared={owner,contract,binding,references,research,bars};return prepared;
}

async function clearResearch(){
  // Preserve the original terminal foundation reference and its storage namespace.
  // TRUNCATE is test-fixture teardown; immutable contract/checkpoint triggers remain enabled.
  await db.query('TRUNCATE quant_research_chunks,quant_job_steps,quant_research_foundation,quant_jobs');
}
async function researchJob(contract,{status='QUEUED',evaluations=0}={}){
  const runId=randomUUID();
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,
    contract_hash,contract,status,created_at,updated_at,deadline,evaluations_started)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,1,1,900001,$9)`,
    [runId,contract.owner_id,contract.deployment_id,randomUUID(),hash('submission'),hash(canonical(contract)),JSON.stringify(contract),status,evaluations]);
  return runId;
}
async function bindingRow(runId,contract,binding,changes={}){
  const row={step_id:DATASET_BINDING_STEP_ID,kind:DATASET_BINDING_KIND,parameters:binding,
    identity_hash:datasetBindingIdentity(contract,binding),next_bar:0,checkpoint:null,checkpoint_hash:null,unit_name:null,unit_token:null,...changes};
  await db.query(`INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash,next_bar,checkpoint,checkpoint_hash,unit_name,unit_token)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [runId,row.step_id,row.kind,JSON.stringify(row.parameters),row.identity_hash,row.next_bar,row.checkpoint===null?null:JSON.stringify(row.checkpoint),row.checkpoint_hash,row.unit_name,row.unit_token]);
}
async function retainedNames(){
  let names;
  const inspect={root,maintenance:async({retainedNames,assertExclusive})=>{await assertExclusive();names=retainedNames;return {applied:false};}};
  await maintainQuantStorage({db,budget:inspect,...offline});return new Set(names);
}
const invalidRetention=()=>assert.rejects(maintainQuantStorage({db,budget,...offline}),{code:'STORAGE_REFERENCE_INVALID'});

test('V2 binding retains raw and ATR14 sidecar in every research status (P11)',async()=>{
  const f=await v2Fixture();
  try{
    for(const status of ['QUEUED','RUNNING','SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']){
      await clearResearch();const runId=await researchJob(f.contract,{status});await bindingRow(runId,f.contract,f.binding);
      const names=await retainedNames();assert.ok(names.has(f.references.raw.dataset_id),status);
      assert.ok(names.has('atr14-'+f.references.sidecar.sha256+'.json'),status);
    }
  }finally{await clearResearch();}
});

test('V2 without binding permits only pending zero-work jobs; completed work and successful status fail closed (P11)',async()=>{
  const f=await v2Fixture();
  try{
    for(const status of ['QUEUED','RUNNING','FAILED','CANCELLED','TIMED_OUT']){
      await clearResearch();await researchJob(f.contract,{status});const names=await retainedNames();
      assert.equal(names.has(f.references.raw.dataset_id),false,status);assert.equal(names.has('atr14-'+f.references.sidecar.sha256+'.json'),false,status);
    }
    for(const status of ['SUCCEEDED','NO_VALID_CANDIDATE']){
      await clearResearch();await researchJob(f.contract,{status});await invalidRetention();
    }
    await clearResearch();await researchJob(f.contract,{evaluations:1});await invalidRetention();
    await clearResearch();let runId=await researchJob(f.contract);
    await db.query("INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'candidate:000','CANDIDATE','{}',$2)",[runId,hash('candidate')]);
    await invalidRetention();
    await clearResearch();runId=await researchJob(f.contract);
    await db.query("INSERT INTO quant_job_steps VALUES($1,'candidate:000','CANDIDATE','{}','{}',1)",[runId]);
    await invalidRetention();
  }finally{await clearResearch();}
});

test('malformed V2 binding row and parameters refuse retention before maintenance (P11)',async()=>{
  const f=await v2Fixture();
  const changes=[{kind:'CANDIDATE'},{identity_hash:hash('wrong-identity')},{next_bar:1},{checkpoint:{}},
    {checkpoint_hash:hash('checkpoint')},{unit_name:'stale.service'},{unit_token:randomUUID()}];
  const changed=structuredClone(f.binding);changed.bar_count++;
  changes.push({parameters:changed,identity_hash:hash(canonical({contract:f.contract,parameters:changed,kind:DATASET_BINDING_KIND}))});
  const extra={...f.binding,extra:'unsupported'};
  changes.push({parameters:extra,identity_hash:hash(canonical({contract:f.contract,parameters:extra,kind:DATASET_BINDING_KIND}))});
  try{for(const mutation of changes){await clearResearch();const runId=await researchJob(f.contract);await bindingRow(runId,f.contract,f.binding,mutation);await invalidRetention();}}
  finally{await clearResearch();}
});

test('orphan PREPARE on legacy or unknown research versions fails closed; valid V1 remains retained (P11)',async()=>{
  const f=await v2Fixture(),v1=materializeExecutionContract(f.contract,f.binding);
  try{
    await clearResearch();await researchJob(v1,{status:'SUCCEEDED'});let names=await retainedNames();
    assert.ok(names.has(f.references.raw.dataset_id));assert.ok(names.has('atr14-'+f.references.sidecar.sha256+'.json'));
    for(const contract of [{...v1,execution_backend:'legacy'},{...v1,version:'unknown-research-version'},v1]){
      await clearResearch();const runId=await researchJob(contract,{status:'FAILED'});await bindingRow(runId,f.contract,f.binding);await invalidRetention();
    }
    await clearResearch();await researchJob({...v1,version:'unknown-research-version'},{status:'FAILED'});await invalidRetention();
    await clearResearch();const runId=await researchJob(f.contract);
    await bindingRow(runId,f.contract,f.binding,{step_id:'unexpected-prepare'});await invalidRetention();
  }finally{await clearResearch();}
});

test('pending research V2 foundation requests need null checkpoint and zero offset (P11)',async()=>{
  const f=await v2Fixture(),request=expectedFoundationRequestV2(f.contract,900000);
  await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[f.owner]);
  for(const {checkpoint,nextBar} of [{checkpoint:null,nextBar:0},{checkpoint:{},nextBar:0},{checkpoint:null,nextBar:1}]){
    const id=randomUUID();
    await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at,checkpoint,next_bar)
      VALUES($1,$2,$3,$4,$5,'QUEUED',1,900001,$6,$7)`,
      [id,f.owner,randomUUID(),JSON.stringify(request),hash(canonical(request)),checkpoint===null?null:JSON.stringify(checkpoint),nextBar]);
    try{if(checkpoint===null&&nextBar===0)await retainedNames();else await invalidRetention();}
    finally{await db.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[id]);}
  }
});

test('old bound V2 artifacts survive apply while an unbound raw orphan is removed (P11)',async()=>{
  const f=await v2Fixture(),old=new Date(Date.now()-3*86400000);
  const rawBars=f.bars.map(({time,open,high,low,close,volume})=>({time,open,high,low,close,volume}));
  const orphan=await f.research.raw.publish({...f.references.raw.metadata,cutoff:f.references.raw.metadata.cutoff+60000},rawBars);
  async function ageDataset(id){for(const filename of await readdir(path.join(root,id)))await utimes(path.join(root,id,filename),old,old);await utimes(path.join(root,id),old,old);}
  await ageDataset(f.references.raw.dataset_id);await ageDataset(orphan.dataset_id);
  const sidecar=path.join(root,'atr14-'+f.references.sidecar.sha256+'.json');await utimes(sidecar,old,old);
  try{
    const runId=await researchJob(f.contract,{status:'CANCELLED'});await bindingRow(runId,f.contract,f.binding);
    const dry=await maintainQuantStorage({db,budget,...offline});
    assert.ok(dry.candidates.some(item=>item.name===orphan.dataset_id));
    assert.equal(dry.candidates.some(item=>item.name===f.references.raw.dataset_id||item.name===path.basename(sidecar)),false);
    await maintainQuantStorage({db,budget,apply:true,...offline});
    await assert.rejects(readFile(path.join(root,orphan.dataset_id,'manifest.json')),error=>error.code==='ENOENT');
    assert.ok(await readFile(path.join(root,f.references.raw.dataset_id,'manifest.json'),'utf8'));assert.ok(await readFile(sidecar,'utf8'));
    await assertQuantStorageOwner(db,root);
  }finally{await clearResearch();}
});
