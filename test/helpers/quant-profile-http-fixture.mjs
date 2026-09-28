import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantDataService} from '../../src/postgres/quant-data.js';
import {QuantProfileService} from '../../src/postgres/quant-profile.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {DatasetStore} from '../../src/quant-research/dataset-store.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {SOURCE_HASH} from '../../src/quant-research/contract.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {httpClient} from '../helpers.mjs';

const minute=60000;

/** Isolated real app and PostgreSQL. Private source stays under ignored local QA. */
export async function quantProfileHttpFixture(connection,{privateFixturePath}={}){
  if(!privateFixturePath)throw Error('QUANT_PROFILE_SOURCE_FIXTURE required');
  const admin=new PostgresDatabase({connectionString:connection});
  const name='quant_profile_http_'+randomUUID().replaceAll('-','');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quant-profile-http-'));
  let db,server,exited=false,closed=false;
  async function close(){
    if(closed)return;closed=true;
    if(server&&!exited){const done=once(server,'exit');server.kill('SIGTERM');await done;}
    await db?.close();await admin.query('DROP DATABASE IF EXISTS '+name);await admin.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
  try{
    await admin.query('CREATE DATABASE '+name);
    const target=new URL(connection);target.pathname='/'+name;
    db=new PostgresDatabase({connectionString:target.toString()});await db.migrate();
    for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
      'quant-research-foundation-schema.sql','quant-storage-schema.sql'])
      await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
    await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
    const root=path.join(directory,'datasets');await db.transaction(()=>bindQuantStorage(db,root));
    const limits={diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0};
    const limitsFile=path.join(directory,'limits.json');await fs.writeFile(limitsFile,JSON.stringify(limits));
    const budget=new StorageBudget({...limits,root});
    const rawStore=new DatasetStore({root,storageBudget:budget});
    const researchStore=new ResearchDatasetStore({root,storageBudget:budget});
    const store=new Store(db),pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
    const password=randomUUID()+'-fixture';
    const owner=await store.createUser({email:randomUUID()+'@example.test',
      passwordHash:await hashPassword(password),role:'ADMIN'});
    const foreign=await store.createUser({email:randomUUID()+'@example.test',
      passwordHash:await hashPassword(password),role:'ADMIN'});
    const policy={...structuredClone(config.defaultRisk),paperTrading:true,
      requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':1000}};
    await store.setRisk(owner.id,policy);
    const privateFixture=JSON.parse(await fs.readFile(path.resolve(privateFixturePath),'utf8'));
    const revision=privateFixture.revision;
    if(hash(revision.source)!==SOURCE_HASH)throw Error('Supported private source fixture changed');
    const analysis=structuredClone(revision.analysis);
    const preset=analysis.inputs.find(input=>input.pine_variable==='preset');
    if(!preset)throw Error('Private source fixture lacks preset');
    preset.effective_value='Custom';
    analysis.effective_inputs_hash=hash(canonical(Object.fromEntries(analysis.inputs.map(input=>[
      input.pine_variable,input.effective_value]))));
    analysis.effective_input_review={source_hash:SOURCE_HASH,
      effective_inputs_hash:analysis.effective_inputs_hash,input_count:58,
      reviewed_by:owner.id,reviewed_at:Date.now()};
    const importId=randomUUID(),deploymentId=randomUUID(),now=Date.now();
    await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,
      owner.id,owner.id,1,SOURCE_HASH,'Local PROFILE HTTP fixture',revision.source,
      JSON.stringify(analysis),now);
    await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,
      1,SOURCE_HASH,revision.source,JSON.stringify(analysis),now);
    await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,owner.id,owner.id,1);
    const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
    const capital=await store.paperAccounts(owner.id);
    const funding=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(owner.id)).cutoff;
    const snapshot={source_hash:SOURCE_HASH,artifact_hash:privateFixture.review.artifact_hash,
      market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,
      policy_hash:hash(canonical(policy)),capital,funding_cutoff:funding,
      membership:members,selection:{...privateFixture.deployment.snapshot.selection},
      captured_at:now};
    const snapshotHash=hash(canonical(snapshot));
    await db.prepare("INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,'READY',?)").run(
      deploymentId,owner.id,owner.id,importId,1,JSON.stringify(snapshot),snapshotHash,now);
    const evidence={...privateFixture.review,snapshot_hash:snapshotHash,source_hash:SOURCE_HASH,
      artifact_hash:snapshot.artifact_hash};
    await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,
      snapshotHash,JSON.stringify(evidence),hash(canonical(evidence)),now);
    const data=new QuantDataService({pineService:pine,datasetStore:rawStore,enabled:true});
    const profile=new QuantProfileService({pineService:pine,dataService:data,researchStore,enabled:true});
    const workerService={foundation:true,db,store,datasetStore:researchStore,executorMode:async()=>{}};
    const fetchHistory=(range,{onPage}={})=>{
      const first=range.start_time-range.warmup_bars*minute;
      onPage?.({start_time:first,end_time:range.end_time,count:(range.end_time-first)/minute,
        sha256:hash('profile-http-page'),retrieved_at:Date.now(),
        source:'https://api.binance.com/api/v3/klines',
        timestamp_semantics:'UTC open time; end exclusive'});
      return (async function*(){for(let time=first;time<range.end_time;time+=minute)
        yield {time,open:'100',high:'102',low:'99',close:'101',volume:'1'};})();
    };
    const worker=new QuantResearchFoundationWorker({service:workerService,dataService:data,
      profileService:profile,health:async()=>({ok:true}),fetchHistory,stopUnit:async()=>true});
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const base='http://127.0.0.1:'+port;
    server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,
      DATABASE_URL:target.toString(),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,
      SMTP_HOST:'',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1',PINE_BRIDGE_ENV:'staging',
      QUANT_RESEARCH_ENABLED:'1',QUANT_RESEARCH_FOUNDATION_ENABLED:'1',
      QUANT_RESEARCH_DATASET_ROOT:root,QUANT_STORAGE_LIMITS_FILE:limitsFile}});
    let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);
    server.on('exit',()=>exited=true);
    let ready=false;
    for(let i=0;i<100&&!exited;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}
      if(ready)break;await delay(50);}
    if(!ready)throw Error('PROFILE HTTP app startup failed: '+output.slice(-1000));
    return {db,store,owner,foreign,password,request:httpClient(base),worker,
      researchStore,profile,data,deploymentId,close};
  }catch(error){await close();throw error;}
}
