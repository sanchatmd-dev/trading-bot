import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from './quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {canonical,hash,validateSelection} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {fixture,source} from './quant-research-fixture.mjs';
import {BASE_MODEL} from './quant-research-clauses-fixture.mjs';

/**
 * F06-01 contract-guard tests: one disposable database per executor mode, each with the accepted guards installed.
 * LEGACY applies the version-1 research schema only. FOUNDATION adds the scheduler and adapter schemas and selects the
 * FOUNDATION executor mode, as test/postgres/quant-research-foundation.test.mjs does. Synthetic fixture only.
 */
export async function createModeDatabase({admin,foundation,label}){
 const name='quant_guards_'+label+'_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 const db=new PostgresDatabase({connectionString:url.toString(),max:12});
 const files=['pine-bridge-schema.sql','quant-research-schema.sql',...(foundation?['quant-foundation-schema.sql','quant-research-foundation-schema.sql']:[])];
 await db.migrate();
 for(const file of files)await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
 await installQuantGuards(db);
 let datasetRoot=null;
 const ctx={name,db,foundation,now:Date.now(),datasetRoot:null};
 if(foundation){
  await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
  datasetRoot=await fs.mkdtemp(path.join(os.tmpdir(),'research-guards-'));
 }
 ctx.datasetRoot=datasetRoot;
 ctx.store=new Store(db);
 ctx.pine=new PineBridgeService(ctx.store,{defaultRisk:config.defaultRisk});
 ctx.service=new QuantResearchService({pineService:ctx.pine,clock:()=>ctx.now,supportedSourceHash:hash(source),foundation,
  ...(foundation?{datasetStore:new ResearchDatasetStore({root:datasetRoot})}:{})});
 ctx.close=async()=>{
  await db.close();
  if(datasetRoot)await fs.rm(datasetRoot,{recursive:true,force:true});
  await admin.query('DROP DATABASE '+name);
 };
 return ctx;
}

/** Runs fn with one trigger of one table disabled and always re-enables it. Only a table owner may do this: it simulates a privileged edit. */
export async function withTriggerDisabled(db,table,trigger,fn){
 await db.query('ALTER TABLE '+table+' DISABLE TRIGGER '+trigger);
 try{return await fn();}
 finally{await db.query('ALTER TABLE '+table+' ENABLE TRIGGER '+trigger);}
}

/** pg_trigger.tgenabled: 'O' enabled (origin), 'A' enabled always, 'D' disabled. */
export async function triggerState(db,table,trigger){
 return (await db.query('SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2',[table,trigger])).rows[0]?.tgenabled;
}

/** Foundation chunk evaluator stub: same shape as the adapter suite's continuation(), metrics are injected engineering values. */
const METRIC={closed_trades:5,net_return_percent:'1',max_drawdown_percent:'1'};
export function continuation(payload){
 const {contract,parameters,kind,rows}=payload,end=kind==='HOLDOUT'?contract.split.test_end:contract.split.validation_end;
 const next=(payload.checkpoint?.next_bar??0)+rows.length;
 const checkpoint={version:'research-chunk-v1',identity:hash(canonical({contract,parameters,kind})),integrity:'a'.repeat(64),next_bar:next,last_time:rows.at(-1).time,paper:{cash:'1000'},evaluator:{index:next-1}};
 return {checkpoint,result:next===end?{parameters,kind,train:METRIC,validation:METRIC,...(kind==='HOLDOUT'?{test:METRIC}:{})}:null};
}

/**
 * Deployment seed like seedDeployment() of the clauses fixture, with one difference that matters for the frozen capital:
 * configured equity (1000) and configured cash balance (800) differ, so a contract that swaps or drops one of them is observable.
 */
export async function seedGuardDeployment({db,store,now}){
 const a=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
 const policy={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':800}};await store.setRisk(a,policy);
 const f=fixture(),importId=randomUUID(),deploymentId=randomUUID();
 await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,a,a,1,hash(source),'Synthetic only',source,JSON.stringify(f.analysis),now);
 await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,hash(source),source,JSON.stringify(f.analysis),now);
 await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,a,a,1);
 const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
 const capital=await store.paperAccounts(a),snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:0,membership:members,selection:validateSelection(f.analysis,f.selection.signals,f.slots,f.selection.bridge)};
 snapshot.funding_cutoff=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(a)).cutoff;
 await db.prepare('INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,\'READY\',?)').run(deploymentId,a,a,importId,1,JSON.stringify(snapshot),hash(canonical(snapshot)),now);
 const evidence={snapshot_hash:hash(canonical(snapshot)),artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:BASE_MODEL,references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
 await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,evidence.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),now);
 const start=1800000000000,count=3250;
 for(let i=0;i<count;i++){
  const bar={time:start+i*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
  await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run('binance-global','BTCUSDT','1',bar.time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'}),hash(canonical(bar)));
 }
 return {a,now:Math.max(now,start+count*60000+1000),body:{bot_id:a,deployment_id:deploymentId,parameter_slots:f.slots,bridge_domains:f.bridge_domains,dataset:{start_time:start,end_time:start+(count-1)*60000,warmup_bars:1250},budget:25,seed:27}};
}
