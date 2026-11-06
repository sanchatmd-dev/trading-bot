import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {createComparison,readComparison,readComparisonResults,writeEvaluation,writeBenchmark,cancelComparison,failComparison,STORE_CODES} from '../../src/postgres/comparison-store.js';
import {finalizeComparison,RUN_FAILURE_REASONS} from '../../src/postgres/comparison-finalizer.js';
import {evaluationRecordBody,benchmarkRecordBody,outcomeRecord} from '../../src/comparison/evaluation-record.js';
import {contextFields,contextKey} from '../../src/comparison/context.js';
import {validateSpec,specHashOf} from '../../src/comparison/ranking.js';
import {CODES} from '../../src/comparison/common.js';
import {Money} from '../../src/money.js';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {fixedEvalComparisonProtocolHash} from '../../src/postgres/quant-fixed-eval.js';
import {buildFixedEvalContract,buildFixedEvalResult,fixedEvalBindingParameters,fixedEvalPendingMetadata,validateFixedEvalContract,validateFixedEvalResult}
  from '../../src/quant-research/fixed-eval-contract.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';

// QR-3 S3b on a real PostgreSQL cluster: the unwired finalizer (src/postgres/comparison-finalizer.js) and the cancel and fail writers of the comparison store.
// The fixture is the FE-2b one: real immutable parents, the real create transaction with its exposure events, and real fixed-evaluation job rows admitted
// through QuantFixedEvalService.enqueue (the comparison moves to EVALUATING in that transaction), so the FE-2b fences are the real ones. No Python and no worker
// run, so the "evaluator" results are LABELLED SYNTHETIC FIXTURES built through buildFixedEvalResult and checked by the real validators; the finalizer reads
// them through injected dependencies, exactly as the later wiring slice will. Nothing here is a research result. One file per process, one cluster.
const MINUTE=60000;
const WARMUP=1006,BARS=WARMUP+200;
let f,rival,counter=0;
const serial=work=>f.db.transaction(work,{isolation:'SERIALIZABLE'});
const hex=label=>hash(label);

/* ---- fixtures ---- */

function comparisonInput({sparse=false}={}){
  const checked=validateSpec({mode:'STANDARDIZED',participants:f.state.parents.map(row=>row.run_id),period:{start_ms:f.registration.window.start_ms,end_ms:f.registration.window.end_ms},
    objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},
    benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}});
  assert.equal(checked.ok,true);
  const spec=checked.spec,context=structuredClone(f.context);
  context.spec_hash=specHashOf(spec);
  context.validation_protocol=fixedEvalComparisonProtocolHash(f.c,spec);
  context.dataset.digest=f.freeze.dataset_hash;
  const normalized=contextFields(f.parent.run_id,context);
  assert.deepEqual(normalized.missing,[]);
  const key=contextKey(normalized.fields);
  return {owner_id:f.owner,comparison_id:randomUUID(),fixture:true,market:f.c.snapshot.market,spec,spec_hash:specHashOf(spec),context_key:key,request_key:'qr3-fin-'+randomUUID(),
    participants:f.state.parents.map((row,index)=>({participant_id:row.run_id,position:index+1,source_hash:f.c.source_hash,origin:'FIXTURE',fixture:true,context_key:key,
      freeze:sparse?{}:{context:structuredClone(normalized.fields)}}))};
}

const POLICY={killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,pauseAfterLossStreak:10000,blockHighVolatility:false,maxVolatilityPercent:100,
  blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',maxOpenPositions:3,onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,
  maxDailyNotional:100000000};
const INPUTS={ema_fast:3,ema_slow:8,atr_len:14,st_factor:3.2,zone_atr_mult:1.15,setup_expiry:48,cooldown:0,confirm_lookback:5,sl_atr_buffer:0.6,min_risk_atr:0.5};
const COST={version:'paper-close-v1',data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'10',risk_percent:'1'};
const CLOSES=['100','110','99'];
const BASE_FILLS=[{bar:0,side:'BUY',quantity:'10',price:'100.1',fee:'1.001',cost:'1'},{bar:2,side:'SELL',quantity:'10',price:'98.9',fee:'0.989',cost:'1'}];
const STRESS_FILLS=[{bar:0,side:'BUY',quantity:'10',price:'100.2',fee:'2.004',cost:'2'},{bar:2,side:'SELL',quantity:'10',price:'98.8',fee:'1.976',cost:'2'}];

/** Independent Money ledger of the fixture (hand-derived in test/qr3-evaluation-record.test.js): cash, inventory, mark-to-close NAV, drawdown from the initial NAV. */
function ledgerOf(closes,fills,cash0){
  let cash=new Money(cash0),held=new Money(0),peak=cash,drawdown=new Money(0),fees=new Money(0),slippage=new Money(0),inMarket=0,nav=cash;
  closes.forEach((close,bar)=>{
    for(const fill of fills.filter(item=>item.bar===bar)){
      const notional=new Money(fill.quantity).mul(fill.price);
      cash=fill.side==='BUY'?cash.minus(notional).minus(fill.fee):cash.plus(notional).minus(fill.fee);
      held=fill.side==='BUY'?held.plus(fill.quantity):held.minus(fill.quantity);
      fees=fees.plus(fill.fee);slippage=slippage.plus(fill.cost);
    }
    nav=cash.plus(held.mul(close));
    if(held.gt(0))inMarket+=1;
    if(nav.gt(peak))peak=nav;
    const down=peak.minus(nav).div(peak).mul(100);
    if(down.gt(drawdown))drawdown=down;
  });
  return {nav,fees,slippage,inMarket,held,drawdown,returnPercent:nav.div(cash0).minus(1).mul(100)};
}

/** A validated fixed-eval-result-v1 with its contract, binding and dataset rows for one participant of one comparison (LABELLED SYNTHETIC FIXTURE). */
function evaluationWorld({comparisonId,participant,period,cost={}}){
  const first=period.start_ms-(WARMUP-1)*MINUTE,end=first+(BARS-1)*MINUTE,cash='10000';
  const model={...COST,...cost};
  const engine=hex('qr3-finalizer-engine'),digest=hex('qr3-finalizer-digest');
  const contract=buildFixedEvalContract({purpose:'QR3_COMPARISON',owner_id:'owner-1',bot_id:'bot-1',deployment_id:'deployment-1',
    lineage:{parent_run_id:participant,parent_contract_hash:hex('parent contract'),object_id:comparisonId},engine_hash:engine,
    parameters:{inputs:{...INPUTS},atr_multiplier:'2',rr:'1.5'},capital:{initial_cash:cash,initial_equity:cash,initial_inventory:'0',quote:'USDT'},
    policy:{...POLICY},parent_policy:{...POLICY,paperTrading:true,requireReduceOnlySell:true},cost_model:model,
    dataset:{start_time:first,end_time:end,warmup_bars:WARMUP,content_digest:digest},parent_dataset_range:{start_time:first-5000*MINUTE,end_time:first-MINUTE}});
  const metadata=fixedEvalPendingMetadata(contract);
  const sidecar={sha256:hex('sidecar'),bar_count:BARS,first_time:first,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:model.quantity_step};
  const binding=fixedEvalBindingParameters(contract,{references:{raw:{dataset_id:hex('raw'),sha256:hex('raw'),metadata},sidecar},dataset_sha256:hex('files')});
  const closes=Array.from({length:BARS-WARMUP},(_,index)=>CLOSES[index%CLOSES.length]);
  const rows=Array.from({length:BARS},(_,index)=>({time:first+index*MINUTE,open:'100',high:'111',low:'98',close:index<WARMUP?'100':closes[index-WARMUP],volume:'1',atr14:'1.5'}));
  const S=period.start_ms;
  assert.equal(rows[WARMUP].time-MINUTE,S);assert.equal(rows[BARS-1].time,period.end_ms);
  const step=(kind,fills)=>{
    const factor=kind==='EVALUATION_STRESS'?2:1,led=ledgerOf(closes,fills,cash),sells=fills.filter(fill=>fill.side==='SELL').length;
    return {version:'fixed-eval-v1',evaluator_closure:'fixed-eval-closure-v1',kind,cost_stress:{fee_multiplier:String(factor),slippage_multiplier:String(factor)},
      model:{price_tick:'0.01',quantity_step:model.quantity_step,fee_bps:new Money(model.fee_bps).mul(factor).toFixed(),slippage_bps:new Money(model.slippage_bps).mul(factor).toFixed(),
        risk_percent:'1',version:'paper-close-v1'},
      bridge:{atr_multiplier:'2',rr:'1.5'},initial_equity:cash,split:{warmup:WARMUP,end:BARS,evaluated_bars:BARS-WARMUP},engine_hash:engine,dataset_sha256:binding.dataset_sha256,
      parent_run_id:participant,selection_id:null,metrics_precision:80,
      metrics:{end_equity:led.nav.toFixed(),net_return_percent:led.returnPercent.toFixed(),max_drawdown_percent:led.drawdown.toFixed(),closed_trades:sells},
      fills:fills.map((fill,index)=>({event_type:fill.side==='BUY'?'BUY':'EXIT',time:S+fill.bar*MINUTE+MINUTE,price:fill.price,quantity:fill.quantity,fee:fill.fee,sequence:index+1,
        notional:new Money(fill.quantity).mul(fill.price).toFixed(),bar_time_ms:S+fill.bar*MINUTE,side:fill.side,slippage_cost_incl_tick:fill.cost})),
      fees_total:led.fees.toFixed(),slippage_cost_incl_tick_total:led.slippage.toFixed(),
      exposure:{bars_in_market:led.inMarket,bars:BARS-WARMUP,fraction:new Money(led.inMarket).div(BARS-WARMUP).toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed()},
      episodes:{completed_count:1,completed:[{open_bar_time_ms:S,allocations:1,close_bar_time_ms:S+2*MINUTE}]},closed_allocations:sells,
      open_position:{quantity:led.held.toFixed(),allocations:0,mark_close:closes[closes.length-1],open_episode:null},
      rejected:{total:3,intents_total:2,orphan_exits:{warmup_entry:1,refused_entry:0},
        by_event_type_and_reason:[{event_type:'BUY',reason:'MAX_OPEN_POSITIONS',count:2},{event_type:'EXIT',reason:'TARGET_NOT_OPEN',count:1}]}};
  };
  const result=buildFixedEvalResult(contract,binding,{base:step('EVALUATION',BASE_FILLS),stress:step('EVALUATION_STRESS',STRESS_FILLS)},{version:'fixed-eval-closure-v1',hash:engine});
  return {contract,binding,rows,result};
}

const VALIDATORS={validateFixedEvalContract,validateFixedEvalResult};
const STATUS_INPUT={integrity_ok:true,unavailable:false,compatibility:{compatible:true},coverage:{state:'PASS'},evidence:{evidence_class:'INDEPENDENT',reasons:[]},
  episode_gate_available:false,completed_episodes:1};

/**
 * A comparison created through the real transaction and admitted through the real enqueue (so it is EVALUATING with one QUEUED fixed job per participant).
 * c: {id, input, spec, participants, runs: participant -> run id, worlds: run id -> evaluation world, deps, calls}. deps counts every dependency call in c.calls.
 */
async function admitted({cost={},keepQueued=false}={}){
  const input=comparisonInput();
  const created=await createComparison(f.db,input);
  assert.equal(created.ok,true,JSON.stringify(created));
  const c={id:created.comparison_id,input,spec:input.spec,participants:input.participants.map(item=>item.participant_id),runs:{},worlds:{},calls:{readEvaluation:0,readRows:0,participantInputs:0}};
  for(const [index,participant] of c.participants.entries()){
    counter+=1;
    const job=await f.service.enqueue(f.owner,{purpose:'QR3_COMPARISON',object_id:c.id,participant_id:participant},'pg_qr3_fin_'+counter+'_'+index+'_'+randomUUID().slice(0,8));
    assert.equal(job.status,'QUEUED');
    c.runs[participant]=job.run_id;
    // The owner queue cap of FE-2b counts active foundation jobs (fewer than 20 per owner); a test that does not use the foundation row retires it here.
    if(!keepQueued)await f.db.query("UPDATE public.quant_foundation_jobs SET status='CANCELLED' WHERE job_id=$1",[job.run_id]);
    c.worlds[job.run_id]=evaluationWorld({comparisonId:c.id,participant,period:input.spec.period,cost:index===1?cost:{}});
  }
  assert.equal((await readComparison(f.db,{owner_id:f.owner,comparison_id:c.id})).status.status,'EVALUATING');
  c.deps={validators:VALIDATORS,
    async readEvaluation(owner,runId){c.calls.readEvaluation+=1;const world=c.worlds[runId];assert.ok(world,'a run of this comparison');return {contract:world.contract,binding:world.binding,result:world.result};},
    async readRows(owner,runId,binding){c.calls.readRows+=1;assert.equal(binding,c.worlds[runId].binding,'rows come only through the binding of that run');return structuredClone(c.worlds[runId].rows);},
    async participantInputs(owner,comparisonId,participant){c.calls.participantInputs+=1;assert.equal(comparisonId,c.id);return structuredClone(STATUS_INPUT);}};
  return c;
}
const setRun=(c,participant,status)=>f.db.query('UPDATE public.quant_jobs SET status=$2 WHERE run_id=$1',[c.runs[participant],status]);
const succeedAll=async c=>{for(const participant of c.participants)await setRun(c,participant,'SUCCEEDED');};
const calls=c=>({...c.calls});

/* ---- observation ---- */

const COMPARISON_TABLES=['quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes','quant_comparison_replay_events'];
const digest=async table=>(await f.db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const RESEARCH_TABLES=['users','quant_jobs','quant_job_steps','quant_research_chunks','quant_research_foundation','quant_foundation_jobs','pine_market_bars','quant_exposure_register'];
const researchDigest=async()=>Promise.all(RESEARCH_TABLES.map(digest));
/** The rows that no test step here changes (the parents, their steps and chunks, the market bars): the comparison tests add jobs and set job states on purpose. */
const stableDigest=async()=>Promise.all(['users','quant_job_steps','quant_research_chunks','pine_market_bars'].map(digest));
const counts=async id=>{
  const one=async table=>(await f.db.query(`SELECT count(*)::int n FROM public.${table} WHERE comparison_id=$1`,[id])).rows[0].n;
  return Object.fromEntries(await Promise.all(['quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes','quant_comparison_replay_events','quant_comparison_status_events','quant_exposure_register']
    .map(async table=>[table.replace('quant_comparison_','').replace('quant_',''),await one(table)])));
};
const events=async id=>(await f.db.query('SELECT seq,status,reason_code,at_ms FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq',[id])).rows
  .map(row=>({seq:Number(row.seq),status:row.status,reason_code:row.reason_code}));
const storedRows=async id=>(await f.db.query(`SELECT 'e' k,participant_id id,body_hash h,created_at_ms t,evaluation_run_id r FROM public.quant_comparison_evaluations WHERE comparison_id=$1
  UNION ALL SELECT 'b',benchmark_id,body_hash,created_at_ms,NULL FROM public.quant_comparison_benchmarks WHERE comparison_id=$1
  UNION ALL SELECT 'o',outcome,outcome_hash,created_at_ms,NULL FROM public.quant_comparison_outcomes WHERE comparison_id=$1 ORDER BY 1,2`,[id])).rows;
const finalize=(c,db=f.db,deps=c.deps)=>finalizeComparison(db,{owner_id:f.owner,comparison_id:c.id},deps);
const sameFacts=(left,right)=>assert.deepEqual(left,right);

/**
 * A recording wrapper: every statement is logged, then hook may delay it or make it throw, then the read-only state of its transaction is probed with a separate
 * query that is not logged (the probe is the first query of a transaction, so it also takes that transaction's snapshot). The finalizer gets this handle in
 * place of the pool.
 */
function spy(target,{hook=null}={}){
  const log=[];
  const proxy=new Proxy(target,{get(object,property){
    if(property==='query')return async(sql,params)=>{
      const text=String(sql).trim(),entry={text,readOnly:null};
      log.push(entry);
      if(hook)await hook(entry,log);
      if(/^(SELECT|WITH|INSERT|UPDATE|DELETE)/i.test(text)&&object.isTransaction)entry.readOnly=(await object.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode==='on';
      return object.query(sql,params);
    };
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  return {db:proxy,log};
}
const writes=log=>log.filter(entry=>/^(INSERT|UPDATE|DELETE)/i.test(entry.text));
const selects=log=>log.filter(entry=>/^(SELECT|WITH)/i.test(entry.text));
const INSERT=table=>new RegExp('^INSERT INTO public\\.'+table+'\\(');
const refusal=(answer,code,detail)=>{assert.deepEqual([answer.ok,answer.code,answer.detail],[false,code,detail],JSON.stringify(answer).slice(0,300));};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL only');
  f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
  // a second handle (its own transaction context): a competing owner request made from inside a statement hook of the first
  rival=new PostgresDatabase({connectionString:f.connectionString,max:2});
});
after(async()=>{await rival?.close();await f?.close();});

/* ---- 1. the full path ---- */

test('a comparison whose fixed runs all succeeded ends COMPLETE with NO_QUALIFIED_RESULT; every read is READ ONLY; research rows are byte-identical; a repeat writes nothing',async()=>{
  const c=await admitted();
  await succeedAll(c);
  const researchBefore=await researchDigest();
  const run=spy(f.db);
  const answer=await finalize(c,run.db);
  assert.equal(answer.ok,true,JSON.stringify(answer));
  assert.deepEqual([answer.state,answer.status,answer.outcome],['COMPLETE','COMPLETE','NO_QUALIFIED_RESULT']);
  assert.match(answer.outcome_hash,/^[0-9a-f]{64}$/);
  assert.deepEqual(await events(c.id),[{seq:1,status:'SPEC_FROZEN',reason_code:null},{seq:2,status:'EVALUATING',reason_code:null},{seq:3,status:'COMPLETE',reason_code:null}]);
  assert.deepEqual(calls(c),{readEvaluation:2,readRows:2,participantInputs:2});
  // the statements: the run lookup and every read of the comparison are READ ONLY; the only writes are the four records and the COMPLETE event, none read-only
  const lookup=run.log.filter(entry=>/FROM public\.quant_jobs/.test(entry.text));
  assert.equal(lookup.length,1);assert.equal(lookup[0].readOnly,true);
  assert.deepEqual(writes(run.log).map(entry=>entry.text.match(/^INSERT INTO public\.(\w+)/)[1]),
    ['quant_comparison_evaluations','quant_comparison_evaluations','quant_comparison_benchmarks','quant_comparison_outcomes','quant_comparison_status_events']);
  assert.ok(writes(run.log).every(entry=>entry.readOnly===false));
  // every other SELECT (the reads of the comparison and of its results) ran READ ONLY; the two exceptions are the first statements inside the writer transactions
  const reads=selects(run.log).filter(entry=>!/^SELECT (spec_hash,context_key FROM public\.quant_comparison_specs|max\(seq\) AS seq)/.test(entry.text));
  assert.ok(reads.length>=8,'the reads of the comparison: '+reads.length);
  assert.ok(reads.every(entry=>entry.readOnly===true),reads.filter(entry=>entry.readOnly!==true).map(entry=>entry.text.slice(0,80)).join(' | '));
  // the stored rows
  const view=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:c.id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.equal(view.evaluations.length,2);
  for(const item of view.evaluations){
    assert.equal(item.body.basis_confirmed,false,'R1: the V8 hold stays');
    assert.equal(item.evaluation_run_id,c.runs[item.participant_id]);
    assert.equal(item.record_comparison_id,c.id);
    assert.ok(item.created_at_ms>view.frozen_at_ms);
    assert.ok(item.body.limitations.includes(CODES.VALUATION_BASIS_UNCONFIRMED));
  }
  assert.equal(view.benchmark.body.benchmark_id,'qr3-bh-close-same-cost-v1');
  assert.deepEqual([view.outcome.outcome,view.outcome.outcome_hash,view.outcome.record.limitations],['NO_QUALIFIED_RESULT',answer.outcome_hash,[CODES.VALUATION_BASIS_UNCONFIRMED]]);
  assert.ok(view.outcome.record.participants.every(item=>item.status==='DEVELOPMENT_EVIDENCE'),'every evaluated participant stays development evidence');
  // I3: the same stored inputs give the same outcome hash (rebuilt from the stored rows, not from the finalizer's memory)
  const rebuilt=outcomeRecord({spec:c.spec,spec_hash:specHashOf(c.spec),context_key:c.input.context_key,participants:c.participants.map(participant=>{
    const item=view.evaluations.find(row=>row.participant_id===participant);
    return {participant_id:participant,status_input:structuredClone(STATUS_INPUT),evaluation:{body:item.body,created_at_ms:item.created_at_ms}};
  })});
  assert.equal(rebuilt.ok,true,JSON.stringify(rebuilt));
  assert.equal(rebuilt.outcome_hash,answer.outcome_hash);
  // research and account rows are byte-identical, and no exposure event was added
  sameFacts(await researchDigest(),researchBefore);
  // a repeat is ALREADY_TERMINAL, writes nothing, reads only, and calls no dependency
  const stored=await storedRows(c.id),callsBefore=calls(c);
  const again=spy(f.db);
  const repeat=await finalize(c,again.db);
  assert.deepEqual([repeat.ok,repeat.state,repeat.status],[true,'ALREADY_TERMINAL','COMPLETE']);
  assert.deepEqual(writes(again.log),[]);
  assert.ok(selects(again.log).every(entry=>entry.readOnly===true));
  assert.deepEqual(calls(c),callsBefore);
  sameFacts(await storedRows(c.id),stored);
  sameFacts(await researchDigest(),researchBefore);
});

/* ---- 2. waiting ---- */

test('a SPEC_FROZEN comparison, a missing run and a QUEUED or RUNNING run answer WAITING: reads only, no dependency call, nothing written',async()=>{
  const frozen=await createComparison(f.db,comparisonInput());
  assert.equal(frozen.ok,true);
  const idle=spy(f.db);
  const answer=await finalizeComparison(idle.db,{owner_id:f.owner,comparison_id:frozen.comparison_id},{validators:VALIDATORS,readEvaluation(){throw Error('no read');},readRows(){throw Error('no rows');},participantInputs(){throw Error('no inputs');}});
  assert.deepEqual([answer.ok,answer.state,answer.status,answer.pending],[true,'WAITING','SPEC_FROZEN',f.state.parents.map(row=>row.run_id)]);
  assert.deepEqual(writes(idle.log),[]);

  const c=await admitted();
  const watch=async(expected,pending)=>{
    const run=spy(f.db),before=calls(c),stored=await storedRows(c.id);
    const result=await finalize(c,run.db);
    assert.deepEqual([result.ok,result.state,result.status,result.pending],[true,'WAITING','EVALUATING',pending],expected);
    assert.deepEqual(writes(run.log),[],expected);
    assert.ok(selects(run.log).every(entry=>entry.readOnly===true),expected);
    assert.deepEqual(calls(c),before,expected);
    sameFacts(await storedRows(c.id),stored);
  };
  await watch('both QUEUED',c.participants);
  await setRun(c,c.participants[0],'SUCCEEDED');
  await watch('one SUCCEEDED, one QUEUED',[c.participants[1]]);
  await setRun(c,c.participants[1],'RUNNING');
  await watch('one SUCCEEDED, one RUNNING',[c.participants[1]]);
  assert.deepEqual(await counts(c.id),{evaluations:0,benchmarks:0,outcomes:0,replay_events:0,status_events:2,exposure_register:2});
});

/* ---- 3. recovery after a partial write ---- */

test('recovery: a stop after the first evaluation and a stop before the outcome are completed by the next call with no duplicate and the same hashes',async()=>{
  const c=await admitted();
  await succeedAll(c);
  // stop 1: the second evaluation insert throws (the first is committed, its transaction is gone)
  const stop=(table,nth)=>{let seen=0;return spy(f.db,{hook(entry){if(INSERT(table).test(entry.text)){seen+=1;if(seen===nth)throw Error('simulated stop');}}});};
  await assert.rejects(finalize(c,stop('quant_comparison_evaluations',2).db),/simulated stop/);
  assert.deepEqual(await counts(c.id),{evaluations:1,benchmarks:0,outcomes:0,replay_events:0,status_events:2,exposure_register:2});
  const first=await storedRows(c.id);
  assert.equal(first.length,1);
  // stop 2: the next call writes the missing evaluation and the benchmark, then the outcome insert throws
  await assert.rejects(finalize(c,stop('quant_comparison_outcomes',1).db),/simulated stop/);
  assert.deepEqual(await counts(c.id),{evaluations:2,benchmarks:1,outcomes:0,replay_events:0,status_events:2,exposure_register:2});
  const second=await storedRows(c.id);
  assert.deepEqual(second.find(row=>row.k==='e'&&row.id===first[0].id),first[0],'the stored evaluation is not rewritten (same hash, same time)');
  assert.deepEqual((await events(c.id)).map(item=>item.status),['SPEC_FROZEN','EVALUATING']);
  // the third call writes only the outcome
  const run=spy(f.db);
  const answer=await finalize(c,run.db);
  assert.deepEqual([answer.ok,answer.state],[true,'COMPLETE']);
  assert.deepEqual(writes(run.log).map(entry=>entry.text.match(/^INSERT INTO public\.(\w+)/)[1]),['quant_comparison_outcomes','quant_comparison_status_events']);
  const third=await storedRows(c.id);
  assert.deepEqual(third.filter(row=>row.k!=='o'),second,'evaluations and benchmark are unchanged');
  assert.deepEqual(await counts(c.id),{evaluations:2,benchmarks:1,outcomes:1,replay_events:0,status_events:3,exposure_register:2});
  assert.deepEqual((await events(c.id)).map(item=>item.status),['SPEC_FROZEN','EVALUATING','COMPLETE']);
  assert.equal((await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:c.id})).ok,true);
});

/* ---- 4. concurrent finalizers ---- */

test('two concurrent finalizers: exactly one COMPLETE, the other ALREADY_TERMINAL, no error, one record of each kind',async()=>{
  const c=await admitted();
  await succeedAll(c);
  // both build every record and read the same state, then wait at their first evaluation insert until both have arrived
  let arrived=0,open;
  const barrier=new Promise(resolve=>{open=resolve;});
  const racer=()=>{let waited=false;return spy(f.db,{async hook(entry){
    if(waited||!INSERT('quant_comparison_evaluations').test(entry.text))return;
    waited=true;arrived+=1;if(arrived===2)open();await barrier;
  }});};
  const [a,b]=await Promise.all([finalize(c,racer().db),finalize(c,racer().db)]);
  assert.equal(a.ok&&b.ok,true,JSON.stringify([a,b]));
  assert.deepEqual([a.state,b.state].sort(),['ALREADY_TERMINAL','COMPLETE']);
  assert.deepEqual(await counts(c.id),{evaluations:2,benchmarks:1,outcomes:1,replay_events:0,status_events:3,exposure_register:2});
  assert.deepEqual((await events(c.id)).map(item=>item.status),['SPEC_FROZEN','EVALUATING','COMPLETE']);
  const view=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:c.id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.equal(view.outcome.outcome_hash,[a,b].find(item=>item.state==='COMPLETE').outcome_hash);
});

/* ---- 5. cancel ---- */

test('cancel while EVALUATING: CANCELLED is stored with its exposure events; every FE-2b fence refuses; the finalizer writes nothing',async()=>{
  const c=await admitted();
  const body=participant=>({purpose:'QR3_COMPARISON',object_id:c.id,participant_id:participant});
  const jobsBefore=(await f.db.query('SELECT run_id,status,contract_hash,updated_at FROM public.quant_jobs WHERE run_id=ANY($1::text[]) ORDER BY run_id',[Object.values(c.runs)])).rows;
  const cancelled=await cancelComparison(f.db,{owner_id:f.owner,comparison_id:c.id});
  assert.equal(cancelled.ok,true,JSON.stringify(cancelled));
  assert.deepEqual([cancelled.status,cancelled.seq,cancelled.reason_code],['CANCELLED',3,null]);
  assert.ok(cancelled.at_ms>0);
  assert.deepEqual((await events(c.id)).map(item=>[item.seq,item.status,item.reason_code]),[[1,'SPEC_FROZEN',null],[2,'EVALUATING',null],[3,'CANCELLED',null]]);
  assert.equal((await counts(c.id)).exposure_register,2,'exposure events already written stay (RC-C32)');
  // FE-2b: the next CLAIM, RUN or COMMIT fence re-reads the comparison status and refuses; the cancel itself touched no job row
  for(const action of ['CLAIM','RUN','COMMIT']){
    for(const participant of c.participants)await assert.rejects(serial(()=>f.service.authorize(f.owner,body(participant),action,{run_id:c.runs[participant]})),{code:'FIXED_EVAL_OBJECT_NOT_EVALUATING'},action);
  }
  sameFacts((await f.db.query('SELECT run_id,status,contract_hash,updated_at FROM public.quant_jobs WHERE run_id=ANY($1::text[]) ORDER BY run_id',[Object.values(c.runs)])).rows,jobsBefore);
  // a fixed run that still finishes cannot reach the comparison
  await succeedAll(c);
  const run=spy(f.db),before=calls(c),researchBefore=await researchDigest();
  const answer=await finalize(c,run.db);
  assert.deepEqual([answer.ok,answer.state,answer.status],[true,'ALREADY_TERMINAL','CANCELLED']);
  assert.deepEqual(writes(run.log),[]);
  assert.deepEqual(calls(c),before);
  assert.deepEqual(await counts(c.id),{evaluations:0,benchmarks:0,outcomes:0,replay_events:0,status_events:3,exposure_register:2});
  sameFacts(await researchDigest(),researchBefore);
  // the status can not change again
  refusal(await cancelComparison(f.db,{owner_id:f.owner,comparison_id:c.id}),STORE_CODES.NOT_CANCELLABLE,'quant_comparison_status_transition');
  refusal(await failComparison(f.db,{owner_id:f.owner,comparison_id:c.id,reason_code:'LATE_FAILURE'}),STORE_CODES.NOT_CANCELLABLE,'quant_comparison_status_transition');
});

/** Cancels the comparison at the start of the nth writer transaction of a finalizer run (the first statement of every writer is the owner-scoped spec read). */
function cancelAtWriter(c,nth){
  let seen=0;const result={cancelled:null};
  const run=spy(f.db,{async hook(entry){
    if(!/^SELECT spec_hash,context_key FROM public\.quant_comparison_specs/.test(entry.text))return;
    seen+=1;
    if(seen===nth)result.cancelled=await cancelComparison(rival,{owner_id:f.owner,comparison_id:c.id});
  }});
  return {...run,result};
}

test('a cancel that arrives between the finalizer reads and its first write, or just before its outcome write: the writer loses (QR3_NOT_CANCELLABLE) and the finalizer answers CANCELLED',async()=>{
  const first=await admitted();
  await succeedAll(first);
  const early=cancelAtWriter(first,1);
  const answer=await finalize(first,early.db);
  assert.equal(early.result.cancelled?.ok,true,JSON.stringify(early.result.cancelled));
  assert.deepEqual([answer.ok,answer.state,answer.status],[true,'CANCELLED','CANCELLED'],JSON.stringify(answer));
  assert.deepEqual(await counts(first.id),{evaluations:0,benchmarks:0,outcomes:0,replay_events:0,status_events:3,exposure_register:2});
  assert.deepEqual((await events(first.id)).map(item=>item.status),['SPEC_FROZEN','EVALUATING','CANCELLED']);
  // the fourth writer transaction is the outcome write (evaluation, evaluation, benchmark, outcome): the records stay, there is no outcome and no COMPLETE
  const second=await admitted();
  await succeedAll(second);
  const late=cancelAtWriter(second,4);
  const lateAnswer=await finalize(second,late.db);
  assert.equal(late.result.cancelled?.ok,true,JSON.stringify(late.result.cancelled));
  assert.deepEqual([lateAnswer.ok,lateAnswer.state,lateAnswer.status],[true,'CANCELLED','CANCELLED'],JSON.stringify(lateAnswer));
  assert.deepEqual(await counts(second.id),{evaluations:2,benchmarks:1,outcomes:0,replay_events:0,status_events:3,exposure_register:2});
  assert.deepEqual((await events(second.id)).map(item=>item.status),['SPEC_FROZEN','EVALUATING','CANCELLED']);
  const view=await readComparisonResults(f.db,{owner_id:f.owner,comparison_id:second.id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.equal(view.outcome,null);
  assert.deepEqual((await finalize(second)).state,'ALREADY_TERMINAL');
});

/* ---- 6. failed runs ---- */

test('a failed, timed out or cancelled fixed run fails the comparison with a reason code (RR-2, provisional); partial results are not stored; a repeat is ALREADY_TERMINAL',async()=>{
  const failed=await admitted();
  await setRun(failed,failed.participants[0],'SUCCEEDED');await setRun(failed,failed.participants[1],'FAILED');
  const answer=await finalize(failed);
  assert.equal(answer.ok,true,JSON.stringify(answer));
  assert.deepEqual([answer.state,answer.status,answer.reason_code,answer.participant_id,answer.run_id],['FAILED','FAILED',RUN_FAILURE_REASONS.FAILED,failed.participants[1],failed.runs[failed.participants[1]]]);
  assert.deepEqual(await events(failed.id),[{seq:1,status:'SPEC_FROZEN',reason_code:null},{seq:2,status:'EVALUATING',reason_code:null},{seq:3,status:'FAILED',reason_code:'PARTICIPANT_RUN_FAILED'}]);
  assert.deepEqual(await counts(failed.id),{evaluations:0,benchmarks:0,outcomes:0,replay_events:0,status_events:3,exposure_register:2});
  assert.deepEqual(calls(failed),{readEvaluation:0,readRows:0,participantInputs:0},'a finished sibling is not read');
  const repeat=await finalize(failed);
  assert.deepEqual([repeat.state,repeat.status],['ALREADY_TERMINAL','FAILED']);
  refusal(await cancelComparison(f.db,{owner_id:f.owner,comparison_id:failed.id}),STORE_CODES.NOT_CANCELLABLE,'quant_comparison_status_transition');

  // an owner-cancelled fixed run (the real FE-2b cancel of a queued job), with the sibling still running
  const stopped=await admitted({keepQueued:true});
  await setRun(stopped,stopped.participants[1],'RUNNING');
  const job=await f.service.cancel(f.owner,stopped.runs[stopped.participants[0]]);
  assert.equal(job.status,'CANCELLED');
  const second=await finalize(stopped);
  assert.deepEqual([second.ok,second.state,second.reason_code,second.participant_id],[true,'FAILED',RUN_FAILURE_REASONS.CANCELLED,stopped.participants[0]],JSON.stringify(second));
  assert.deepEqual((await events(stopped.id)).at(-1),{seq:3,status:'FAILED',reason_code:'PARTICIPANT_RUN_CANCELLED'});
  assert.deepEqual(calls(stopped),{readEvaluation:0,readRows:0,participantInputs:0});

  // a timed out run
  const late=await admitted();
  await setRun(late,late.participants[0],'TIMED_OUT');
  const third=await finalize(late);
  assert.deepEqual([third.state,third.reason_code],['FAILED',RUN_FAILURE_REASONS.TIMED_OUT]);
});

/* ---- 7. integrity ---- */

test('a failing dependency, a refused record body or differing benchmark inputs store nothing and leave the comparison EVALUATING',async()=>{
  const c=await admitted({cost:{slippage_bps:'20'}});
  await succeedAll(c);
  const researchBefore=await stableDigest();
  const none={evaluations:0,benchmarks:0,outcomes:0,replay_events:0,status_events:2,exposure_register:2};
  // the second participant has another cost model: its own result is valid, but the benchmark inputs of the two differ
  refusal(await finalize(c),CODES.QR3_INTEGRITY_FAILED,'BENCHMARK_INPUT_DIFFERS');
  assert.deepEqual(await counts(c.id),none);
  // a dependency that throws
  for(const [name,detail] of [['readEvaluation','READ_EVALUATION'],['readRows','READ_ROWS'],['participantInputs','PARTICIPANT_INPUTS']]){
    const other=await admitted();await succeedAll(other);
    refusal(await finalize(other,f.db,{...other.deps,[name]:async()=>{throw Error('dependency down');}}),CODES.QR3_INTEGRITY_FAILED,detail);
    const state=await counts(other.id);
    // the participant inputs are asked after the records are stored (the outcome needs their stored times), so those stay and the next call finishes the work
    assert.deepEqual(state,name==='participantInputs'?{...none,evaluations:2,benchmarks:1}:none,name);
    if(name==='participantInputs'){
      const finished=await finalize(other);
      assert.deepEqual([finished.ok,finished.state],[true,'COMPLETE'],JSON.stringify(finished));
    }
  }
  // a result the pure module refuses (an end equity that is not the valued one) is passed through unchanged, nothing is repaired
  const lie=await admitted();await succeedAll(lie);
  const tampered=structuredClone(lie.worlds[lie.runs[lie.participants[0]]].result);
  tampered.base.metrics.end_equity='1';
  const refused=await finalize(lie,f.db,{...lie.deps,readEvaluation:async(owner,runId)=>({...(await lie.deps.readEvaluation(owner,runId)),result:runId===lie.runs[lie.participants[0]]?tampered:lie.worlds[runId].result})});
  refusal(refused,CODES.QR3_INTEGRITY_FAILED,'CROSS_CHECK_END_NAV');
  assert.deepEqual(await counts(lie.id),none);
  // a missing validator is refused before anything is read
  refusal(await finalize(lie,f.db,{...lie.deps,validators:{}}),CODES.QR3_INTEGRITY_FAILED,'VALIDATOR_MISSING');
  sameFacts(await stableDigest(),researchBefore);
});

test('a stored evaluation that differs from the rebuilt body refuses QR3_INTEGRITY_FAILED, overwrites nothing and stores nothing else',async()=>{
  const c=await admitted();
  await succeedAll(c);
  const participant=c.participants[0],runId=c.runs[participant],world=c.worlds[runId];
  const contract=world.contract,spec=(await readComparison(f.db,{owner_id:f.owner,comparison_id:c.id})).comparison.spec;
  const built=evaluationRecordBody({comparison_id:c.id,spec_hash:specHashOf(spec),spec,participant_id:participant,evaluation_run_id:runId,fixed_contract:contract,binding:world.binding,
    fixed_result:world.result,rows:world.rows},VALIDATORS);
  assert.equal(built.ok,true,JSON.stringify(built));
  // the planted body is valid for the database and for the store (ids, window, hash), only its content differs from the rebuilt one
  const planted={...structuredClone(built.body),completed_episodes:built.body.completed_episodes+1};
  const stored=await writeEvaluation(f.db,{owner_id:f.owner,comparison_id:c.id,participant_id:participant,spec_hash:specHashOf(spec),evaluation_run_id:runId,body:planted});
  assert.equal(stored.ok,true,JSON.stringify(stored));
  const rowsBefore=await storedRows(c.id),researchBefore=await stableDigest();
  const run=spy(f.db);
  refusal(await finalize(c,run.db),CODES.QR3_INTEGRITY_FAILED,'EVALUATION_MISMATCH');
  assert.deepEqual(writes(run.log),[]);
  sameFacts(await storedRows(c.id),rowsBefore);
  assert.deepEqual(await counts(c.id),{evaluations:1,benchmarks:0,outcomes:0,replay_events:0,status_events:2,exposure_register:2});
  // a stored evaluation of the right body but of another run id is a mismatch too
  const other=await admitted();await succeedAll(other);
  const otherParticipant=other.participants[0],otherRun=other.runs[otherParticipant],otherWorld=other.worlds[otherRun];
  const otherBuilt=evaluationRecordBody({comparison_id:other.id,spec_hash:specHashOf(spec),spec,participant_id:otherParticipant,evaluation_run_id:otherRun,fixed_contract:otherWorld.contract,
    binding:otherWorld.binding,fixed_result:otherWorld.result,rows:otherWorld.rows},VALIDATORS);
  assert.equal(otherBuilt.ok,true,JSON.stringify(otherBuilt));
  const strange=await writeEvaluation(f.db,{owner_id:f.owner,comparison_id:other.id,participant_id:otherParticipant,spec_hash:specHashOf(spec),evaluation_run_id:'some-other-run',body:otherBuilt.body});
  assert.equal(strange.ok,true,JSON.stringify(strange));
  refusal(await finalize(other),CODES.QR3_INTEGRITY_FAILED,'EVALUATION_MISMATCH');
  sameFacts(await stableDigest(),researchBefore);
});

test('a stored benchmark that differs from the rebuilt one refuses QR3_INTEGRITY_FAILED, and a matching stored benchmark is reused',async()=>{
  const c=await admitted();
  await succeedAll(c);
  const participant=c.participants[0],world=c.worlds[c.runs[participant]];
  const spec=(await readComparison(f.db,{owner_id:f.owner,comparison_id:c.id})).comparison.spec,specHash=specHashOf(spec);
  const built=benchmarkRecordBody({comparison_id:c.id,spec_hash:specHash,spec,fixed_contract:world.contract,rows:world.rows},VALIDATORS);
  assert.equal(built.ok,true,JSON.stringify(built));
  const planted={...structuredClone(built.body),result:{ok:false,code:CODES.QR3_BENCHMARK_DATA_UNAVAILABLE,detail:'PLANTED',value:null}};
  const stored=await writeBenchmark(f.db,{owner_id:f.owner,comparison_id:c.id,spec_hash:specHash,body:planted});
  assert.equal(stored.ok,true,JSON.stringify(stored));
  const before=await storedRows(c.id);
  refusal(await finalize(c),CODES.QR3_INTEGRITY_FAILED,'BENCHMARK_MISMATCH');
  sameFacts(await storedRows(c.id),before);
  assert.deepEqual(await counts(c.id),{evaluations:0,benchmarks:1,outcomes:0,replay_events:0,status_events:2,exposure_register:2});

  const ok=await admitted();
  await succeedAll(ok);
  const okWorld=ok.worlds[ok.runs[ok.participants[0]]];
  const same=benchmarkRecordBody({comparison_id:ok.id,spec_hash:specHash,spec,fixed_contract:okWorld.contract,rows:okWorld.rows},VALIDATORS);
  const preStored=await writeBenchmark(f.db,{owner_id:f.owner,comparison_id:ok.id,spec_hash:specHash,body:same.body});
  assert.equal(preStored.ok,true);
  const benchmarkRow=(await storedRows(ok.id)).find(row=>row.k==='b');
  const answer=await finalize(ok);
  assert.deepEqual([answer.ok,answer.state],[true,'COMPLETE'],JSON.stringify(answer));
  assert.deepEqual((await storedRows(ok.id)).find(row=>row.k==='b'),benchmarkRow,'the stored benchmark was reused, not rewritten');
});

/* ---- 8. the new store writers ---- */

test('cancelComparison and failComparison: every allowed and every refused transition; foreign, absent and malformed ids answer NOT_FOUND alike; exposure rows stay',async()=>{
  const intruder=await f.store.createUser({email:'qr3-fin-'+randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture-hash'});
  const make=async()=>{const created=await createComparison(f.db,comparisonInput({sparse:true}));assert.equal(created.ok,true,JSON.stringify(created));return created.comparison_id;};
  const toEvaluating=id=>serial(()=>f.db.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,2,'EVALUATING')",[id]));
  const cancel=id=>cancelComparison(f.db,{owner_id:f.owner,comparison_id:id});
  const fail=(id,reason='EVALUATION_ERROR')=>failComparison(f.db,{owner_id:f.owner,comparison_id:id,reason_code:reason});
  const refused=answer=>refusal(answer,STORE_CODES.NOT_CANCELLABLE,'quant_comparison_status_transition');
  // a COMPLETE comparison refuses both writers (set up first: it adds job rows)
  const complete=await admitted();await succeedAll(complete);
  assert.equal((await finalize(complete)).state,'COMPLETE');
  const researchBefore=await researchDigest();

  // SPEC_FROZEN to CANCELLED, and nothing after it
  let id=await make();
  const frozenCancel=await cancel(id);
  assert.deepEqual([frozenCancel.ok,frozenCancel.status,frozenCancel.seq,frozenCancel.reason_code,frozenCancel.attempts],[true,'CANCELLED',2,null,1]);
  refused(await cancel(id));refused(await fail(id));
  assert.deepEqual(await events(id),[{seq:1,status:'SPEC_FROZEN',reason_code:null},{seq:2,status:'CANCELLED',reason_code:null}]);
  // SPEC_FROZEN to FAILED with a reason, and nothing after it
  id=await make();
  const frozenFail=await fail(id,'ADMISSION_REFUSED');
  assert.deepEqual([frozenFail.ok,frozenFail.status,frozenFail.seq,frozenFail.reason_code],[true,'FAILED',2,'ADMISSION_REFUSED']);
  refused(await cancel(id));refused(await fail(id));
  assert.deepEqual(await events(id),[{seq:1,status:'SPEC_FROZEN',reason_code:null},{seq:2,status:'FAILED',reason_code:'ADMISSION_REFUSED'}]);
  // EVALUATING to CANCELLED and to FAILED
  id=await make();await toEvaluating(id);
  const evaluatingCancel=await cancel(id);
  assert.deepEqual([evaluatingCancel.ok,evaluatingCancel.status,evaluatingCancel.seq],[true,'CANCELLED',3]);
  refused(await fail(id));
  id=await make();await toEvaluating(id);
  const evaluatingFail=await fail(id,'EVALUATION_ERROR');
  assert.deepEqual([evaluatingFail.ok,evaluatingFail.status,evaluatingFail.seq,evaluatingFail.reason_code],[true,'FAILED',3,'EVALUATION_ERROR']);
  refused(await cancel(id));
  // COMPLETE refuses both
  refused(await cancel(complete.id));refused(await fail(complete.id));
  assert.deepEqual((await events(complete.id)).map(item=>item.status),['SPEC_FROZEN','EVALUATING','COMPLETE']);
  // the database clock stamps the time, strictly increasing
  const times=(await f.db.query('SELECT at_ms FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq',[id])).rows.map(row=>Number(row.at_ms));
  assert.ok(times.every((time,index)=>index===0||time>times[index-1]),String(times));

  // foreign, absent and malformed ids: one answer, nothing written
  id=await make();
  const before=await events(id);
  for(const writer of [(input)=>cancelComparison(f.db,input),(input)=>failComparison(f.db,{...input,reason_code:'EVALUATION_ERROR'})]){
    for(const input of [{owner_id:intruder.id,comparison_id:id},{owner_id:f.owner,comparison_id:randomUUID()},{owner_id:f.owner,comparison_id:'bad id; DROP TABLE'},{owner_id:'',comparison_id:id},{owner_id:f.owner}]){
      assert.deepEqual(await writer(input),{ok:false,code:'NOT_FOUND',detail:null},JSON.stringify(input));
    }
  }
  assert.deepEqual(await events(id),before);
  // a concurrent cancel and fail: exactly one wins, the other loses with QR3_NOT_CANCELLABLE
  const [x,y]=await Promise.all([cancel(id),fail(id)]);
  assert.deepEqual([x.ok,y.ok].sort(),[false,true],JSON.stringify([x,y]));
  refused(x.ok?y:x);
  assert.equal((await events(id)).length,2);
  const [p,q]=await Promise.all([cancel(await make()),cancel(await make())]);
  assert.equal(p.ok&&q.ok,true,'two different comparisons do not interfere');
  // every create left its exposure events; the writers added none, and no research row moved
  assert.equal((await counts(complete.id)).exposure_register,2);
  const researchAfter=await researchDigest();
  sameFacts(researchAfter.filter((_,index)=>RESEARCH_TABLES[index]!=='quant_exposure_register'&&RESEARCH_TABLES[index]!=='users'),researchBefore.filter((_,index)=>RESEARCH_TABLES[index]!=='quant_exposure_register'&&RESEARCH_TABLES[index]!=='users'));
});
