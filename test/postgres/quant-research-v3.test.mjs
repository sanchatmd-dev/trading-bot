import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService,engineHash} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {canonical,hash,validateSelection} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {fixture,source} from '../helpers/quant-research-fixture.mjs';
import {buildResearchContractV3,validateResearchContractV3,RESEARCH_V3_BLOCKERS} from '../../src/quant-research/research-contract-v3.js';
import {ownerRecommendationGate} from '../../src/quant-library/owner-recommendation.js';
let admin,db,store,pine,service,readerService,databaseName,now=Date.now();
const reader={answer:true,calls:[],fail:false,isRegistered:async(...args)=>{reader.calls.push(args);if(reader.fail)throw Error('registry unreadable');return reader.answer;}};
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 databaseName='quant_research_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+databaseName);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
 db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
 await db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
 const sql=await fs.readFile(new URL('../../src/postgres/quant-research-schema.sql',import.meta.url),'utf8');
 await assert.rejects(db.transaction(async()=>{await db.query(sql);throw Error('rollback');}));
 assert.equal((await db.query("SELECT to_regclass('quant_jobs') present")).rows[0].present,null);
 await db.query(sql);store=new Store(db);pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
 await installQuantGuards(db);
 service=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(source)});   // production wiring: no capability reader
 readerService=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(source),capabilityReader:reader});
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});
async function baseline(){
 const a=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
 const policy={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':1000}};await store.setRisk(a,policy);
 const f=fixture(),importId=randomUUID(),deploymentId=randomUUID();
 await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,a,a,1,hash(source),'Synthetic only',source,JSON.stringify(f.analysis),now);
 await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,hash(source),source,JSON.stringify(f.analysis),now);
 await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,a,a,1);
 const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
 const capital=await store.paperAccounts(a),snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:0,membership:members,selection:validateSelection(f.analysis,f.selection.signals,f.slots,f.selection.bridge)};
 snapshot.funding_cutoff=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(a)).cutoff;
 await db.prepare('INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,\'READY\',?)').run(deploymentId,a,a,importId,1,JSON.stringify(snapshot),hash(canonical(snapshot)),now);
 const evidence={snapshot_hash:hash(canonical(snapshot)),artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
 await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,evidence.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),now);
 const start=1800000000000,count=3250;
 // Decimal strings mirror real verified market storage, rather than JS numbers.
 for(let i=0;i<count;i++){
  const bar={time:start+i*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
  await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run('binance-global','BTCUSDT','1',bar.time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'}),hash(canonical(bar)));
 }
 now=Math.max(now,start+count*60000+1000);
 return {a,body:{bot_id:a,deployment_id:deploymentId,parameter_slots:f.slots,bridge_domains:f.bridge_domains,dataset:{start_time:start,end_time:start+(count-1)*60000,warmup_bars:1250},budget:25,seed:27}};
}
const enqueue=(x,key=randomUUID(),svc=service,body=x.body)=>db.transaction(()=>svc.enqueue(x.a,body,key));
const get=(x,id,cancel=false)=>db.transaction(()=>service.get(x.a,id,cancel));
const metric={closed_trades:5,net_return_percent:'1',max_drawdown_percent:'1'};
function evaluation(contract,parameters,kind){return {parameters,kind,train:metric,validation:metric,...(kind==='HOLDOUT'?{test:metric}:{}),owner_recommendation_ready:false};}
const worker=evaluate=>new QuantResearchWorker({service:readerService,evaluate:evaluate??evaluation,clock:()=>now});

/*
 * ql3a-research-job-v3 admission and run on a real PostgreSQL (GO-L6-LOCAL; tests V3-G1, V3-G2 (stub engine; the real engine side is in
 * bi-trace-reproduction.test.mjs and trace-reproduction-closure.test.js), V3-G4). Every run here is a LABELLED ENGINEERING FIXTURE: synthetic bars and a
 * synthetic source, never a research result. V3-G6 (FOUNDATION mode) is in quant-research-foundation.test.mjs, which owns that schema.
 */
const V1='ql3a-research-job-v1',V3='ql3a-research-job-v3';
const v3Of=x=>({...x.body,contract_version:V3});
const reset=()=>{reader.answer=true;reader.fail=false;reader.calls.length=0;};
const rowOf=id=>db.prepare('SELECT * FROM quant_jobs WHERE run_id=?').get(id);
const counts=async()=>({jobs:(await db.query('SELECT count(*)::int n FROM quant_jobs')).rows[0].n,
 events:(await db.query("SELECT count(*)::int n FROM audit WHERE event='quant.research.queued'")).rows[0].n});
const cancel=(x,id)=>get(x,id,true);
let v3Done=null;

test('V3-G1 refuses with CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED, no job row and no audit event, when no reader is wired, the reader says anything but true, or it cannot be read',async()=>{
 reset();
 const x=await baseline(),before=await counts();
 await assert.rejects(enqueue(x,randomUUID(),service,v3Of(x)),{code:'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED',status:409},'production wiring: no capability reader');
 for(const [name,set] of [['not registered',()=>{reader.answer=false;}],['truthy but not true',()=>{reader.answer='yes';}],['undefined',()=>{reader.answer=undefined;}],['unreadable',()=>{reader.fail=true;}]]){
  reset();set();
  await assert.rejects(enqueue(x,randomUUID(),readerService,v3Of(x)),{code:'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED',status:409},name);
  assert.equal(reader.calls.length,1,name+': the reader was asked once');
 }
 assert.deepEqual(await counts(),before,'no row and no audit event for any refusal');
 reset();
});

test('V3-G1 admits exactly one v3 row when the reader reports the source registered: exact v3 shape, legacy engine hash, policy fields from the snapshot, two candidate blockers',async()=>{
 reset();
 const x=await baseline(),before=await counts();
 const queued=await enqueue(x,randomUUID(),readerService,v3Of(x));
 const after=await counts();
 assert.equal(after.jobs,before.jobs+1);assert.equal(after.events,before.events+1);
 const row=await rowOf(queued.run_id),contract=row.contract;
 assert.equal(row.status,'QUEUED');
 assert.equal(contract.version,V3);assert.equal(contract.scope,'SPT_CUSTOM_ENGINEERING_ONLY');
 assert.equal(Object.hasOwn(contract,'execution_backend'),false);assert.equal(contract.dataset.bars.length,3250);
 assert.equal(canonical(validateResearchContractV3(contract)),canonical(contract),'the stored JSONB contract passes the exact-key validator and is canonical');
 assert.equal(row.contract_hash,hash(canonical(contract)));
 assert.equal(contract.engine_hash,await engineHash(false),'the legacy run closure, as v1');
 assert.equal(contract.policy_version,'fixture-v1');assert.equal(contract.policy_hash,contract.snapshot.policy_hash);
 assert.deepEqual(contract.acceptance_blockers,[...RESEARCH_V3_BLOCKERS]);
 assert.deepEqual(reader.calls,[[hash(source),fixture().analysis.effective_inputs_hash]],'asked once with the source hash and the effective input hash');
 assert.deepEqual(queued.acceptance_blockers,[...RESEARCH_V3_BLOCKERS]);assert.equal(queued.owner_recommendation_ready,false);
 assert.equal(queued.contract_hash,row.contract_hash);
 assert.equal(JSON.parse((await db.prepare("SELECT details FROM audit WHERE event='quant.research.queued' AND trade_id=?").get(queued.run_id)).details).source_slots,8);
 await cancel(x,queued.run_id);
});

test('V3-G1 the default request stays v1 with all three blockers; v3 differs from v1 only in version, blockers and the two policy fields',async()=>{
 reset();
 const x=await baseline();
 const one=await enqueue(x,randomUUID(),readerService),three=await enqueue(x,randomUUID(),readerService,v3Of(x));
 const v1=(await rowOf(one.run_id)).contract,v3=(await rowOf(three.run_id)).contract;
 assert.equal(v1.version,V1);assert.equal(v1.acceptance_blockers.length,3);
 assert.equal(reader.calls.length,1,'the v1 request never asks the capability reader');
 const {policy_version,policy_hash,...rest}=v3;
 assert.equal(policy_version,'fixture-v1');assert.equal(policy_hash,v3.snapshot.policy_hash);
 assert.equal(canonical({...rest,version:V1,acceptance_blockers:v1.acceptance_blockers}),canonical(v1),'every other field is byte-for-byte the v1 contract');
 await cancel(x,one.run_id);await cancel(x,three.run_id);
 const explicit=await enqueue(x,randomUUID(),readerService,{...x.body,contract_version:V1}),stored=(await rowOf(explicit.run_id)).contract;
 assert.equal(stored.version,V1);assert.equal(stored.acceptance_blockers.length,3);assert.equal(reader.calls.length,1,'an explicit v1 selector never asks the reader');
 await cancel(x,explicit.run_id);
});

test('V3-P16 (real database) the same idempotency key replays its own version and conflicts with another version',async()=>{
 reset();
 const x=await baseline(),key=randomUUID();
 const first=await enqueue(x,key,readerService,v3Of(x)),second=await enqueue(x,key,readerService,v3Of(x));
 assert.equal(second.run_id,first.run_id);assert.equal(second.contract_hash,first.contract_hash);
 assert.equal(reader.calls.length,1,'the replay does not ask the reader again');
 await assert.rejects(enqueue(x,key,readerService),{code:'IDEMPOTENCY_CONFLICT',status:409},'a v1 body without the key');
 await assert.rejects(enqueue(x,key,readerService,{...x.body,contract_version:V1}),{code:'IDEMPOTENCY_CONFLICT',status:409},'an explicit v1 selector');
 await assert.rejects(enqueue(x,key,readerService,{...v3Of(x),seed:x.body.seed+1}),{code:'IDEMPOTENCY_CONFLICT',status:409},'another body');
 const v1Key=randomUUID(),v1=await enqueue(x,v1Key,readerService);
 await assert.rejects(enqueue(x,v1Key,readerService,v3Of(x)),{code:'IDEMPOTENCY_CONFLICT',status:409},'v3 on a v1 key');
 assert.equal((await enqueue(x,v1Key,readerService)).run_id,v1.run_id,'the v1 body without the key keeps its submission hash');
 for(const value of ['ql3a-research-job-v2','v3',null,3])await assert.rejects(enqueue(x,randomUUID(),readerService,{...x.body,contract_version:value}),{code:'UNSUPPORTED_RESEARCH_CONTRACT_VERSION',status:400},String(value));
 await cancel(x,first.run_id);await cancel(x,v1.run_id);
});

test('V3-G2 (stub engine) the legacy worker runs a stored v3 row to SUCCEEDED with the PASS completion reason; G7 is PASS for v3 and FAIL for the same run labelled v1; the contract is untouched',async()=>{
 reset();
 const x=await baseline(),queued=await enqueue(x,randomUUID(),readerService,v3Of(x));
 const before=await rowOf(queued.run_id);
 assert.equal(await worker().tick(),true);
 const done=await get(x,queued.run_id),row=await rowOf(queued.run_id);
 assert.equal(done.status,'SUCCEEDED');assert.equal(row.result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');assert.equal(row.result.holdout_evaluated,true);
 assert.equal(row.result.owner_recommendation_ready,false,'the stored flag stays false; G7 ignores it');
 assert.deepEqual(row.result.acceptance_blockers,[...RESEARCH_V3_BLOCKERS]);
 assert.equal(row.result.contract_hash,before.contract_hash);
 assert.equal(canonical(row.contract),canonical(before.contract));assert.equal(row.contract_hash,hash(canonical(row.contract)));
 assert.deepEqual(ownerRecommendationGate({contract:row.contract,result:row.result}),{gate:'G7',state:'PASS',code:null});
 assert.equal(ownerRecommendationGate({contract:{...row.contract,version:V1},result:row.result}).state,'FAIL','the same result under v1 never passes G7');
 assert.equal(done.owner_recommendation_ready,false);assert.deepEqual(done.acceptance_blockers,[...RESEARCH_V3_BLOCKERS]);
 const steps=(await db.query('SELECT step_id,kind FROM quant_job_steps WHERE run_id=$1',[queued.run_id])).rows;
 assert.ok(steps.some(step=>step.kind==='HOLDOUT')&&steps.some(step=>step.kind==='STRESS'));
 v3Done={x,runId:queued.run_id,steps:steps.length};
});

test('V3-G4 a terminal v3 row is frozen: no result, status or contract update, no delete and no later step insert; a non-terminal contract stays immutable',async()=>{
 const {x,runId,steps}=v3Done,before=await rowOf(runId);
 await assert.rejects(db.prepare("UPDATE quant_jobs SET result='{}' WHERE run_id=?").run(runId),{code:'QR001'});
 await assert.rejects(db.prepare("UPDATE quant_jobs SET status='FAILED' WHERE run_id=?").run(runId),{code:'QR001'});
 await assert.rejects(db.prepare('UPDATE quant_jobs SET contract=? WHERE run_id=?').run('{}',runId),/immutable/);
 await assert.rejects(db.prepare('DELETE FROM quant_jobs WHERE run_id=?').run(runId),{code:'QR001'});
 await assert.rejects(db.prepare('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES(?,?,?,?,?,?)').run(runId,'late:step','CANDIDATE','{}','{}',now),{code:'QR001'});
 assert.deepEqual(await rowOf(runId),before,'every refused statement left the row untouched');
 assert.equal((await db.query('SELECT count(*)::int n FROM quant_job_steps WHERE run_id=$1',[runId])).rows[0].n,steps);
 reset();
 const queued=await enqueue(x,randomUUID(),readerService,v3Of(x));
 await assert.rejects(db.prepare('UPDATE quant_jobs SET contract=? WHERE run_id=?').run('{}',queued.run_id),/immutable/);
 await cancel(x,queued.run_id);
});
