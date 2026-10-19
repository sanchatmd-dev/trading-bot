import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {source} from '../helpers/quant-research-fixture.mjs';
import {BASE_MODEL,seedDeployment,metric,scripted,neighbours,isolatedCandidate,planIndex} from '../helpers/quant-research-clauses-fixture.mjs';

/**
 * F05-03 clause tests for the QL-3A research worker (docs/QL_3A_DURABLE_JOBS.md "Gates and evidence"):
 * C1 cost model frozen into the contract, C6 selection screens and ranking, C7 sensitivity before holdout,
 * C9 holdout acceptance, C10 terminal report fields, C11 live Paper counters untouched.
 * Thresholds are written as literals on purpose: a changed RULES constant must fail here, not follow silently.
 * Metrics are injected by a stub evaluator; they establish engineering behaviour only, never strategy performance.
 */
let admin,db,store,pine,service,databaseName,now=Date.now();
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 databaseName='quant_research_clauses_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+databaseName);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
 db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
 await db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8'));
 await db.query(await fs.readFile(new URL('../../src/postgres/quant-research-schema.sql',import.meta.url),'utf8'));
 store=new Store(db);pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk});
 await installQuantGuards(db);
 service=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(source)});
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});

const worker=evaluate=>new QuantResearchWorker({service,evaluate,clock:()=>now});
const enqueue=(x,key=randomUUID())=>db.transaction(()=>service.enqueue(x.a,x.body,key));
const seed=async options=>{const x=await seedDeployment({db,store,now,...options});now=x.now;return x;};
let sharedDeployment;
const shared=async()=>sharedDeployment??=await seed();
const memo=new Map();
const once=(name,make)=>{if(!memo.has(name))memo.set(name,make());return memo.get(name);};

/** Enqueue one job, build a scripted evaluator from its frozen contract, run the real worker to a terminal state. */
async function runJob(x,build){
 const queued=await enqueue(x);
 try{
 const {contract}=await db.prepare('SELECT contract FROM quant_jobs WHERE run_id=?').get(queued.run_id);
 const script=build(contract);
 // Jobs share one fixed clock, so the queue order is by random run_id: no other runnable job may exist.
 assert.equal(Number((await db.prepare("SELECT count(*) n FROM quant_jobs WHERE status IN ('QUEUED','RUNNING') AND run_id<>?").get(queued.run_id)).n),0);
 assert.equal(await worker(script.evaluate).tick(),true);
 const job=await db.prepare('SELECT * FROM quant_jobs WHERE run_id=?').get(queued.run_id);
 assert.ok(['SUCCEEDED','NO_VALID_CANDIDATE'].includes(job.status),'job ended '+job.status+' '+job.diagnostic+' attempt '+job.attempt);
 const steps=await db.prepare('SELECT step_id,kind,parameters FROM quant_job_steps WHERE run_id=? ORDER BY step_id').all(queued.run_id);
 return {queued,contract,job,result:job.result,calls:script.calls,steps,meta:script.meta};
 }finally{
 // A failed build or assertion must not leave a runnable job that masks the root cause in later tests.
 const status=(await db.prepare('SELECT status FROM quant_jobs WHERE run_id=?').get(queued.run_id)).status;
 if(['QUEUED','RUNNING'].includes(status))await db.transaction(()=>service.get(x.a,queued.run_id,true));
 }
}
const withMeta=(meta,script)=>Object.assign(script,{meta});
const kinds=run=>run.calls.map(c=>c.kind);
const count=(run,kind)=>kinds(run).filter(k=>k===kind).length;
/** Stress and holdout must evaluate exactly the selected candidate, picked among at least two eligible candidates. */
function assertFinalistIdentity(run){
 const key=canonical(run.result.selected.parameters);
 assert.ok(run.result.candidates.filter(c=>c.screen_reasons.length===0).length>=2,'at least two eligible candidates, so a wrong pick is observable');
 for(const kind of ['STRESS','HOLDOUT']){
  const calls=run.calls.filter(c=>c.kind===kind),rows=run.steps.filter(r=>r.kind===kind);
  assert.equal(calls.length,1);assert.equal(rows.length,1);
  assert.equal(calls[0].key,key,kind+' call evaluates the selected parameters');
  assert.equal(canonical(rows[0].parameters),key,kind+' step row stores the selected parameters');
 }
}
const lexical=(a,b)=>canonical(a).localeCompare(canonical(b));

// One plan candidate (a pure function of contract) that wins on validation return and whose neighbours are all SENSITIVITY steps.
function winner(contract){
 const isolated=isolatedCandidate(contract);
 assert.ok(isolated,'plan has an isolated candidate with at least two neighbours outside the plan');
 return isolated;
}
const winnerSpec=(isolated,extra={},winning=metric(5,'50','1'))=>({...extra,candidate:(index,parameters)=>index===isolated.index?{validation:winning}:extra.candidate?.(index,parameters)});
const otherIndexes=(contract,...excluded)=>contract.plan.candidates.map((_,i)=>i).filter(i=>i>0&&!excluded.includes(i));

// ---- C1 -------------------------------------------------------------------------------------------------------------------------
test('C1: enqueue freezes fee, slippage and model version of the deployment evidence into the contract',async()=>{
 const x=await seed({executionModel:{...BASE_MODEL,fee_bps:12,slippage_bps:3}});
 const evidence=(await db.prepare('SELECT evidence FROM pine_bridge_evidence WHERE deployment_id=?').get(x.body.deployment_id)).evidence;
 assert.equal(evidence.execution_model.fee_bps,12);assert.equal(evidence.execution_model.slippage_bps,3);
 const queued=await enqueue(x);
 try{
 const row=await db.prepare('SELECT contract,contract_hash FROM quant_jobs WHERE run_id=?').get(queued.run_id);
 assert.deepEqual(row.contract.model,evidence.execution_model);
 assert.equal(row.contract.model.fee_bps,evidence.execution_model.fee_bps);
 assert.equal(row.contract.model.slippage_bps,evidence.execution_model.slippage_bps);
 assert.equal(row.contract.model.version,'paper-close-v1');
 assert.equal(row.contract_hash,hash(canonical(row.contract)));
 // Later evidence edits (a new fee) never reach the frozen contract of the queued job.
 const changed={...evidence,execution_model:{...evidence.execution_model,fee_bps:99}};
 await db.prepare('UPDATE pine_bridge_evidence SET evidence=?,evidence_hash=? WHERE deployment_id=?').run(JSON.stringify(changed),hash(canonical(changed)),x.body.deployment_id);
 const after=await db.prepare('SELECT contract,contract_hash FROM quant_jobs WHERE run_id=?').get(queued.run_id);
 assert.equal(after.contract.model.fee_bps,12);assert.equal(after.contract_hash,row.contract_hash);
}finally{
 // The queued job must never stay runnable for later tests, even when an assertion above fails.
 await db.transaction(()=>service.get(x.a,queued.run_id,true));
 }
 assert.equal((await db.prepare('SELECT status FROM quant_jobs WHERE run_id=?').get(queued.run_id)).status,'CANCELLED');
});

// ---- C6 -------------------------------------------------------------------------------------------------------------------------
test('C6: train/validation screens reject with exact reasons; boundaries stay eligible; best eligible candidate is selected',async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>{
  const w=winner(contract),[o1,o2,o3,o4,o5,o6]=otherIndexes(contract,w.index);
  return withMeta({w:w.index,train:o1,validation:o2,below:o3,drawdown:o4,multi:o5,equal:o6},scripted(winnerSpec(w,{candidate:index=>({
   [o1]:{train:metric(4,'1','1'),validation:metric(5,'90','1')},
   [o2]:{validation:metric(4,'90','1')},
   [o3]:{validation:metric(5,'1.99','1')},
   [o4]:{validation:metric(5,'90','20.01')},
   [o5]:{train:metric(0,'1','1'),validation:metric(0,'-5','30')},
   [o6]:{validation:metric(5,'2','1')}
  })[index]},metric(5,'40','20'))));
 });
 run.ids=run.meta;
 assert.deepEqual(run.contract.rules,{minimum_closed_trades_train:5,minimum_closed_trades_validation:5,minimum_closed_trades_test:5,maximum_drawdown_percent:20,sensitivity_max_drop_percentage_points:2});
 const reasons=i=>run.result.candidates[i].screen_reasons;
 assert.equal(run.job.status,'SUCCEEDED');
 assert.equal(reasons(0).length,0,'baseline equals its own threshold, so it is eligible');
 assert.deepEqual(reasons(run.ids.train),['INSUFFICIENT_TRAIN_TRADES']);
 assert.deepEqual(reasons(run.ids.validation),['INSUFFICIENT_VALIDATION_TRADES']);
 assert.deepEqual(reasons(run.ids.below),['VALIDATION_BELOW_BASELINE_OR_ZERO']);
 assert.deepEqual(reasons(run.ids.drawdown),['VALIDATION_DRAWDOWN_EXCEEDED']);
 assert.deepEqual(reasons(run.ids.multi),['INSUFFICIENT_TRAIN_TRADES','INSUFFICIENT_VALIDATION_TRADES','VALIDATION_BELOW_BASELINE_OR_ZERO','VALIDATION_DRAWDOWN_EXCEEDED']);
 assert.deepEqual(reasons(run.ids.equal),[],'return exactly equal to the baseline is eligible');
 assert.deepEqual(reasons(run.ids.w),[],'train 5, validation 5, drawdown exactly 20 are eligible');
 // Rejected candidates carry the highest returns (90); only the screens keep them out.
 assert.deepEqual(run.result.selected.parameters,run.contract.plan.candidates[run.ids.w]);
 assert.equal(run.result.selected.result.validation.net_return_percent,'40');
 assert.equal(run.result.selected.result.validation.max_drawdown_percent,'20');
});

test('C6: a negative baseline lowers the floor to zero, never below',async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>{
  const w=winner(contract),[o1,o2]=otherIndexes(contract,w.index);
  return withMeta({w:w.index,negative:o1,zero:o2},scripted(winnerSpec(w,{candidate:index=>({
   0:{validation:metric(5,'-3','1')},
   [o1]:{validation:metric(5,'-1','1')},
   [o2]:{validation:metric(5,'0','1')}
  })[index]})));
 });
 run.ids=run.meta;
 const reasons=i=>run.result.candidates[i].screen_reasons;
 assert.deepEqual(reasons(0),['VALIDATION_BELOW_BASELINE_OR_ZERO'],'baseline -3 is below the zero floor');
 assert.deepEqual(reasons(run.ids.negative),['VALIDATION_BELOW_BASELINE_OR_ZERO'],'-1 is above the baseline -3 but below zero');
 assert.deepEqual(reasons(run.ids.zero),[],'exactly zero is eligible');
 assert.deepEqual(run.result.selected.parameters,run.contract.plan.candidates[run.ids.w]);
});

test('C6: ranking is validation return desc, then drawdown asc, then lexical parameters',async()=>{
 const x=await shared();
 // Return beats drawdown; drawdown beats lexical order. The lexically first contender has the worst drawdown.
 const byReturn=await runJob(x,contract=>{
  const [l1,l2,l3]=[1,2,3].sort((a,b)=>lexical(contract.plan.candidates[a],contract.plan.candidates[b]));
  return withMeta({l1,l2,l3},scripted({candidate:index=>({[l1]:{validation:metric(5,'50','15')},[l3]:{validation:metric(5,'50','5')},[l2]:{validation:metric(5,'49','1')}})[index]}));
 });
 assert.deepEqual(byReturn.result.selected.parameters,byReturn.contract.plan.candidates[byReturn.meta.l3],'highest return with the lowest drawdown among equals');
 // Full tie: lexical order decides, and the lexical winner is neither first nor last in plan order among the tied pair.
 const tie=await runJob(x,contract=>{
  let pair=null;
  for(let i=1;i<contract.plan.candidates.length&&!pair;i++)for(let j=i+1;j<contract.plan.candidates.length&&!pair;j++)if(lexical(contract.plan.candidates[j],contract.plan.candidates[i])<0)pair={i,j};
  assert.ok(pair,'plan has a pair whose plan order differs from lexical order');
  return withMeta(pair,scripted({candidate:index=>[pair.i,pair.j].includes(index)?{validation:metric(5,'50','5')}:undefined}));
 });
 assert.ok(tie.meta.i<tie.meta.j);
 assert.deepEqual(tie.result.selected.parameters,tie.contract.plan.candidates[tie.meta.j],'lexically lower parameters win a full tie, not plan order');
});

// ---- C7 -------------------------------------------------------------------------------------------------------------------------
// Boundary run shared by C7, C9 and C10: sensitivity drop of exactly 2 points, exactly 5 neighbour trades, zero-return stress and
// holdout at 5 trades, return 0 and drawdown 20 all pass.
const boundaryRun=async()=>once('boundary',async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>{
  const w=winner(contract),list=w.neighbours;
  return withMeta(w,scripted(winnerSpec(w,{
   sensitivity:p=>[list[0],list.at(-1)].some(n=>canonical(n.parameters)===canonical(p))?metric(5,'48','1'):undefined,
   stress:metric(5,'0','1'),
   holdout:metric(5,'0','20')
  })));
 });
 return run;
});

test('C7: every neighbour is evaluated before stress and holdout; a drop of exactly 2 points with 5 trades passes',async()=>{
 const run=await boundaryRun(),list=run.meta.neighbours;
 assert.equal(run.job.status,'SUCCEEDED');
 assert.equal(count(run,'SENSITIVITY'),list.length);
 assert.equal(run.steps.filter(s=>s.kind==='SENSITIVITY').length,list.length);
 assert.deepEqual(run.result.selected.sensitivity.map(c=>[c.dimension,c.parameters]),list.map(n=>[n.name,n.parameters]));
 assert.equal(run.result.selected.sensitivity[0].result.validation.net_return_percent,'48');
 const order=kinds(run),lastSensitivity=order.lastIndexOf('SENSITIVITY'),stress=order.indexOf('STRESS'),holdout=order.indexOf('HOLDOUT');
 assert.ok(order.lastIndexOf('CANDIDATE')<order.indexOf('SENSITIVITY'),'candidates finish before sensitivity starts');
 assert.ok(lastSensitivity>=0&&lastSensitivity<stress&&stress<holdout,'sensitivity, then stress, then holdout');
 assert.equal(count(run,'HOLDOUT'),1);
 assert.deepEqual(run.result.selected.screen_reasons,[]);
 assertFinalistIdentity(run);
});

const sensitivityFailures=[
 ['drop of 2.01 points on the first neighbour',n=>n[0],metric(5,'47.99','1')],
 ['drop of 2.01 points on the last neighbour',n=>n.at(-1),metric(5,'47.99','1')],
 ['4 validation trades on the first neighbour despite a higher return',n=>n[0],metric(4,'60','1')],
 ['4 validation trades on the last neighbour despite a higher return',n=>n.at(-1),metric(4,'60','1')]
];
for(const [name,pick,bad] of sensitivityFailures)test('C7: '+name+' fails sensitivity and never opens holdout',async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>{
  const w=winner(contract),target=pick(w.neighbours);
  return withMeta(w,scripted(winnerSpec(w,{sensitivity:p=>canonical(p)===canonical(target.parameters)?bad:undefined})));
 });
 assert.equal(run.job.status,'NO_VALID_CANDIDATE');
 assert.deepEqual(run.result.selected.screen_reasons,['SENSITIVITY_FAILED']);
 assert.equal(count(run,'SENSITIVITY'),run.meta.neighbours.length,'all neighbours are still evaluated');
 assert.equal(count(run,'HOLDOUT'),0);
 assert.equal(run.steps.some(s=>s.kind==='HOLDOUT'),false);
 assert.equal(run.result.holdout_evaluated,false);
 assert.equal('test' in run.result.selected,false);
 assert.equal(run.result.completion_reason,'CANDIDATE_FAILED_CHECKS');
});

// Neighbours that are already plan candidates are judged on their stored candidate result, without a SENSITIVITY step.
for(const [name,dropped,expected] of [['a drop of exactly 2 points passes','48','SUCCEEDED'],['a drop of 2.01 points fails','47.99','NO_VALID_CANDIDATE']])test('C7: plan-resident neighbours reuse candidate results; '+name,async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>{
  const list=neighbours(contract,contract.plan.candidates[0]);
  assert.ok(list.length>=2&&list.every(n=>n.inPlan),'every baseline neighbour is a plan candidate');
  const low=new Set(list.slice(1).map(n=>planIndex(contract,n.parameters))),first=planIndex(contract,list[0].parameters);
  // The baseline sets the validation floor at 50, so only it is eligible; neighbours sit below it.
  return withMeta(list,scripted({candidate:index=>index===0?{validation:metric(5,'50','1')}:index===first?{validation:metric(5,dropped,'1')}:low.has(index)?{validation:metric(5,'48','1')}:undefined}));
 });
 assert.equal(run.job.status,expected);
 assert.deepEqual(run.result.selected.parameters,run.contract.plan.candidates[0]);
 assert.equal(count(run,'SENSITIVITY'),0,'no SENSITIVITY step: stored candidate results are reused');
 assert.equal(run.result.selected.sensitivity.length,run.meta.length);
 assert.equal(run.result.selected.sensitivity[0].result.validation.net_return_percent,dropped);
 assert.equal(count(run,'HOLDOUT'),expected==='SUCCEEDED'?1:0);
 assert.deepEqual(run.result.selected.screen_reasons,expected==='SUCCEEDED'?[]:['SENSITIVITY_FAILED']);
});

const stressFailures=[['negative stressed validation return',metric(5,'-0.01','1')],['4 stressed validation trades',metric(4,'5','1')]];
for(const [name,stress] of stressFailures)test('C7 (stress, supplementary): '+name+' fails before holdout',async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>scripted(winnerSpec(winner(contract),{stress})));
 assert.equal(run.job.status,'NO_VALID_CANDIDATE');
 assert.deepEqual(run.result.selected.screen_reasons,['COST_STRESS_FAILED']);
 assert.equal(count(run,'HOLDOUT'),0);assert.equal(run.result.holdout_evaluated,false);
});

// ---- C9 -------------------------------------------------------------------------------------------------------------------------
test('C9: holdout with exactly 5 trades, return 0 and drawdown 20 is accepted',async()=>{
 const run=await boundaryRun();
 assert.equal(run.job.status,'SUCCEEDED');
 assert.equal(run.result.holdout_evaluated,true);
 assertFinalistIdentity(run);
 assert.deepEqual(run.result.selected.test,metric(5,'0','20'));
 assert.deepEqual(run.result.selected.screen_reasons,[]);
});

const holdoutFailures=[
 ['INSUFFICIENT_TEST_TRADES',metric(4,'5','1'),['INSUFFICIENT_TEST_TRADES']],
 ['NEGATIVE_HOLDOUT_RETURN',metric(5,'-0.01','1'),['NEGATIVE_HOLDOUT_RETURN']],
 ['TEST_DRAWDOWN_EXCEEDED',metric(5,'1','20.01'),['TEST_DRAWDOWN_EXCEEDED']],
 ['all three reasons in order',metric(0,'-1','30'),['INSUFFICIENT_TEST_TRADES','NEGATIVE_HOLDOUT_RETURN','TEST_DRAWDOWN_EXCEEDED']]
];
for(const [name,holdout,expected] of holdoutFailures)test('C9: holdout rejection '+name,async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>scripted(winnerSpec(winner(contract),{holdout})));
 assert.equal(count(run,'HOLDOUT'),1);
 assertFinalistIdentity(run);
 assert.equal(run.job.status,'NO_VALID_CANDIDATE');
 assert.deepEqual(run.result.selected.screen_reasons,expected);
 assert.equal(run.result.holdout_evaluated,true);
 assert.deepEqual(run.result.selected.test,holdout);
 assert.equal(run.result.completion_reason,'CANDIDATE_FAILED_CHECKS');
 assert.equal(run.result.owner_recommendation_ready,false);
});

// ---- C10 ------------------------------------------------------------------------------------------------------------------------
test('C10: the worker-produced report says owner_recommendation_ready false for SUCCEEDED and the completion reason is pending acceptance',async()=>{
 const run=await boundaryRun();
 assert.equal(run.job.status,'SUCCEEDED');
 assert.strictEqual(run.job.result.owner_recommendation_ready,false);
 assert.equal(run.job.result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
 assert.ok(run.job.result.acceptance_blockers.length>0);
 assert.equal(run.job.result.scope,'SPT_CUSTOM_ENGINEERING_ONLY');
});

test('C10: NO_VALID_CANDIDATE through failed candidate checks is a terminal success status with owner_recommendation_ready false',async()=>{
 const x=await shared();
 const run=await runJob(x,contract=>scripted(winnerSpec(winner(contract),{holdout:metric(5,'-1','1')})));
 assert.equal(run.job.status,'NO_VALID_CANDIDATE');
 assert.strictEqual(run.job.result.owner_recommendation_ready,false);
 assert.equal(run.job.result.completion_reason,'CANDIDATE_FAILED_CHECKS');
 assert.equal(run.job.result.holdout_evaluated,true);
 assert.equal(run.job.diagnostic,null);
});

test('C10: no train/validation survivor ends NO_VALID_CANDIDATE with no selection, no holdout and owner_recommendation_ready false',async()=>{
 const x=await shared();
 const run=await runJob(x,()=>scripted({candidate:()=>({validation:metric(0,'0','0')})}));
 assert.equal(run.job.status,'NO_VALID_CANDIDATE');
 assert.strictEqual(run.job.result.owner_recommendation_ready,false);
 assert.equal(run.job.result.completion_reason,'NO_VALID_TRAIN_VALIDATION_CANDIDATE');
 assert.equal(run.job.result.selected,null);
 assert.equal(run.job.result.holdout_evaluated,false);
 assert.equal(run.calls.length,25);assert.ok(run.calls.every(c=>c.kind==='CANDIDATE'),'no sensitivity, stress or holdout call');
 assert.equal(run.steps.length,25);
 assert.ok(run.job.result.candidates.every(c=>c.screen_reasons.includes('INSUFFICIENT_VALIDATION_TRADES')));
});

// ---- C11 ------------------------------------------------------------------------------------------------------------------------
test('C11: research runs leave live Paper streak, daily counters, positions, fills, funding, signals and policy unchanged',async()=>{
 const x=await seed(),account='binance-global:primary',today=new Date(now).toISOString().slice(0,10);
 await db.prepare("INSERT INTO ledger_streak(user_id,account_id,execution_mode,loss_streak) VALUES(?,?,'PAPER',?)").run(x.a,account,3);
 await db.prepare("INSERT INTO ledger_daily(user_id,account_id,execution_mode,day,trades,notional,realized_r) VALUES(?,?,'PAPER',?,?,?,?)").run(x.a,account,today,2,'150.5','-1.25');
 await db.prepare("INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,timeframe,event,side,entry_price,payload,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(x.a,'c11-'+randomUUID(),now,now,'binance-global','BTCUSDT','1','ENTRY','BUY','100','{}','FILLED');
 await db.prepare("INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,avg_price,initial_risk,cumulative_pnl,updated_at) VALUES(?,?,'PAPER',?,?,?,?,?,?,?)").run(x.a,account,'binance-global','BTCUSDT','0.5','100','2','1.5',now);
 await db.prepare("INSERT INTO bot_sessions(user_id,state,run_id,started_at,updated_at) VALUES(?,'RUNNING',?,?,?)").run(x.a,'c11-session',now,now);
 const rows=async(table,order)=>(await db.query('SELECT * FROM '+table+' ORDER BY '+order)).rows;
 const live=async()=>({
  streak:await rows('ledger_streak','user_id,account_id,execution_mode'),
  daily:await rows('ledger_daily','user_id,account_id,execution_mode,day'),
  positions:await rows('ledger_positions','1,2,3,4'),
  allocations:await rows('ledger_position_allocations','1'),
  fills:await rows('fills','1,2'),
  funding:await rows('paper_funding','id'),
  signals:await rows('signals','1'),
  session:await rows('bot_sessions','1'),
  policy:await store.risk(x.a,config.defaultRisk)
 });
 const before=await live();
 assert.equal(Number(before.streak[0].loss_streak),3);assert.equal(Number(before.daily[0].trades),2);
 const done=await runJob(x,contract=>scripted(winnerSpec(winner(contract))));
 assert.equal(done.job.status,'SUCCEEDED');
 const failed=await runJob(x,contract=>scripted(winnerSpec(winner(contract),{holdout:metric(5,'-1','1')})));
 assert.equal(failed.job.status,'NO_VALID_CANDIDATE');
 assert.match(done.contract.ledger_initialization,/Independent historical flat Paper simulation; live daily\/streak counters are neither consumed nor reset\./);
 assert.deepEqual(await live(),before);
 assert.equal(before.signals.length,1);assert.equal(before.positions.length,1);assert.equal(before.session.length,1);
});
