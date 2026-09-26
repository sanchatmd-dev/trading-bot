import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {fixture,source} from '../helpers/quant-research-fixture.mjs';
let admin,db,store,pine,service,databaseName,now=Date.now();
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
 service=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(source)});
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
 const capital=await store.paperAccounts(a),snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:0,membership:members,selection:{...f.selection,bindings:[],fixed_inputs:f.analysis.inputs}};
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
const enqueue=(x,key=randomUUID())=>db.transaction(()=>service.enqueue(x.a,x.body,key));
const get=(x,id,cancel=false)=>db.transaction(()=>service.get(x.a,id,cancel));
const metric={closed_trades:5,net_return_percent:'1',max_drawdown_percent:'1'};
function evaluation(contract,parameters,kind){return {parameters,kind,train:metric,validation:metric,...(kind==='HOLDOUT'?{test:metric}:{}),owner_recommendation_ready:false};}
const worker=evaluate=>new QuantResearchWorker({service,evaluate:evaluate??evaluation,clock:()=>now});
test('immutable contract, idempotency and owner scoping use real PostgreSQL',async()=>{
 const x=await baseline(),key=randomUUID(),one=await enqueue(x,key),two=await enqueue(x,key);assert.equal(one.run_id,two.run_id);
 assert.equal(one.source_slots.length,8);assert.equal(one.progress.candidates_completed,0);assert.equal(one.owner_recommendation_ready,false);
 await assert.rejects(enqueue({...x,body:{...x.body,seed:28}},key),{code:'IDEMPOTENCY_CONFLICT'});
 const stranger=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture'})).id;
 await assert.rejects(db.transaction(()=>service.get(stranger,one.run_id)),{code:'NOT_FOUND'});
 await assert.rejects(db.prepare('UPDATE quant_jobs SET contract=? WHERE run_id=?').run('{}',one.run_id),/immutable/);
 await get(x,one.run_id,true);assert.equal((await get(x,one.run_id)).status,'CANCELLED');assert.equal(await worker().tick(),false);
});
test('completed checkpoint survives worker recreation; old lease cannot commit; holdout selected once',async()=>{
 const x=await baseline(),queued=await enqueue(x),first=worker(),job=await first.claim();first.controller=new AbortController();
 await first.step(job,'candidate:000','CANDIDATE',job.contract.plan.candidates[0]);
 await assert.rejects(db.prepare('DELETE FROM quant_job_steps WHERE run_id=?').run(job.run_id),/immutable/);
 await db.prepare('UPDATE quant_jobs SET lease_until=0 WHERE run_id=?').run(job.run_id);
 let calls=0,holdouts=0;const restarted=worker((contract,p,kind)=>{calls++;if(kind==='HOLDOUT')holdouts++;return evaluation(contract,p,kind);});
 const recovered=await restarted.claim();assert.equal(recovered.attempt,2);
 await assert.rejects(first.fenced(job,()=>{}),{code:'RESEARCH_LEASE_LOST'});
 restarted.controller=new AbortController();await restarted.run(recovered);
 const done=await get(x,queued.run_id);assert.equal(done.status,'SUCCEEDED');assert.equal(done.progress.dimension_coverage_percent,100);
 assert.equal(done.progress.candidates_completed,25);assert.equal(holdouts,1);assert.equal(done.owner_recommendation_ready,false);
 assert.equal(done.evaluations_started,calls+1);
});
test('running cancellation discards late computation and persists no checkpoint',async()=>{
 const x=await baseline(),queued=await enqueue(x);let release,started;
 const began=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const w=worker(async(c,p,k)=>{started();await wait;return evaluation(c,p,k);});const task=w.tick();await began;
 await get(x,queued.run_id,true);release();await task;
 assert.equal((await get(x,queued.run_id)).status,'CANCELLED');assert.equal((await w.steps({run_id:queued.run_id})).length,0);
});
test('deadline and three expired leases terminate without removing completed work',async()=>{
 const x=await baseline(),q=await enqueue(x);now+=901000;await worker().tick();assert.equal((await get(x,q.run_id)).status,'TIMED_OUT');
 const next=await enqueue(x);const w=worker();for(let i=0;i<3;i++){assert.ok(await w.claim());await db.prepare('UPDATE quant_jobs SET lease_until=0 WHERE run_id=?').run(next.run_id);}
 await w.tick();assert.equal((await get(x,next.run_id)).status,'FAILED');assert.equal((await get(x,next.run_id)).diagnostic,'RECOVERY_LIMIT_EXCEEDED');
});
test('zero validation trades never opens holdout or produces Best Inputs',async()=>{
 const x=await baseline(),q=await enqueue(x);let holdouts=0;
 await worker((c,p,k)=>{if(k==='HOLDOUT')holdouts++;return {...evaluation(c,p,k),validation:{...metric,closed_trades:0}};}).tick();
 const done=await get(x,q.run_id);assert.equal(done.status,'NO_VALID_CANDIDATE');assert.equal(holdouts,0);assert.equal(done.result.selected,null);
 assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14);
 assert.equal((await db.query('SELECT count(*) n FROM signals')).rows[0].n,0);
});
test('policy change during calculation fails closed before checkpoint',async()=>{
 const x=await baseline(),q=await enqueue(x);
 await worker(async(c,p,k)=>{const policy=await store.risk(x.a,config.defaultRisk);await store.setRisk(x.a,{...policy,maxDailyLossR:policy.maxDailyLossR+1});return evaluation(c,p,k);}).tick();
 const done=await get(x,q.run_id);assert.equal(done.status,'FAILED');assert.equal(done.diagnostic,'STALE_POLICY');assert.equal(done.progress.candidates_completed,0);
});
test('recovery after a committed holdout does not evaluate test performance twice',async()=>{
 const x=await baseline(),q=await enqueue(x),first=worker(),job=await first.claim();first.controller=new AbortController();
 first.finish=async()=>{throw Error('simulated process loss after holdout commit');};
 await assert.rejects(first.run(job),/simulated process loss/);
 assert.equal((await first.steps(job)).filter(s=>s.kind==='HOLDOUT').length,1);
 await db.prepare('UPDATE quant_jobs SET lease_until=0 WHERE run_id=?').run(job.run_id);
 let calculations=0;const recovered=worker((...args)=>{calculations++;return evaluation(...args);});await recovered.tick();
 assert.equal(calculations,0);assert.equal((await get(x,q.run_id)).status,'SUCCEEDED');
});
