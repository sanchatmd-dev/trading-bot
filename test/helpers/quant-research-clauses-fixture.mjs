import {randomUUID} from 'node:crypto';
import {canonical,hash,validateSelection} from '../../src/pine-bridge/source.js';
import {validParameters} from '../../src/quant-research/contract.js';
import {config} from '../../src/config.js';
import {fixture,source} from './quant-research-fixture.mjs';

/**
 * F05-03 clause tests: deployment seed (same shape as test/postgres/quant-research.test.mjs, plus an optional
 * execution model override) and a scripted stub evaluator with distinct per-candidate metrics.
 * Synthetic engineering fixture only; metrics are injected and say nothing about strategy performance.
 */
export const BASE_MODEL={version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};

export async function seedDeployment({db,store,now,executionModel=BASE_MODEL}){
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
 const evidence={snapshot_hash:hash(canonical(snapshot)),artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:executionModel,references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
 await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,evidence.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),now);
 const start=1800000000000,count=3250;
 for(let i=0;i<count;i++){
  const bar={time:start+i*60000,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
  await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').run('binance-global','BTCUSDT','1',bar.time,JSON.stringify(bar),JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'}),hash(canonical(bar)));
 }
 return {a,now:Math.max(now,start+count*60000+1000),body:{bot_id:a,deployment_id:deploymentId,parameter_slots:f.slots,bridge_domains:f.bridge_domains,dataset:{start_time:start,end_time:start+(count-1)*60000,warmup_bars:1250},budget:25,seed:27}};
}

export const metric=(trades,net,drawdown)=>({closed_trades:trades,net_return_percent:String(net),max_drawdown_percent:String(drawdown)});
export const GOOD=metric(5,'2','1');

export const planIndex=(contract,parameters)=>contract.plan.candidates.findIndex(p=>canonical(p)===canonical(parameters));

/** Adjacent-grid neighbours of a candidate, in the order the worker visits them (names sorted, previous before next). */
export function neighbours(contract,parameters){
 const fixed=Object.fromEntries(contract.input_lock.selection.fixed_inputs.map(i=>[i.pine_variable,i.effective_value]));
 const out=[];
 for(const name of Object.keys(contract.input_lock.domains).sort()){
  const grid=contract.input_lock.domains[name],index=grid.indexOf(parameters[name]);
  for(const next of [index-1,index+1])if(next>=0&&next<grid.length){
   const candidate={...parameters,[name]:grid[next]};
   if(!validParameters(candidate,fixed))continue;
   out.push({name,next,parameters:candidate,inPlan:planIndex(contract,candidate)>=0});
  }
 }
 return out;
}

/**
 * First non-baseline plan candidate with at least two neighbours, none of which is itself a plan candidate. Every
 * neighbour of such a candidate is evaluated as a SENSITIVITY step, so the evaluator controls each neighbour metric.
 */
export function isolatedCandidate(contract){
 for(let index=1;index<contract.plan.candidates.length;index++){
  const list=neighbours(contract,contract.plan.candidates[index]);
  if(list.length>=2&&list.every(n=>!n.inPlan))return {index,parameters:contract.plan.candidates[index],neighbours:list};
 }
 return null;
}

/**
 * Scripted stub evaluator. candidate(index, parameters) may return {train, validation}. follower kinds (SENSITIVITY, STRESS,
 * HOLDOUT) return `follow` as validation unless sensitivity(parameters)/stress/holdout override. Every call is logged.
 */
export function scripted(spec={}){
 const calls=[];
 const follow=spec.follow??metric(5,'50','1');
 const evaluate=(contract,parameters,kind)=>{
  const index=planIndex(contract,parameters);
  calls.push({kind,index,key:canonical(parameters)});
  let train=GOOD,validation=GOOD,test;
  if(kind==='CANDIDATE'){
   const o=spec.candidate?.(index,parameters)??{};train=o.train??train;validation=o.validation??validation;
  }else{
   train=GOOD;validation=follow;
   if(kind==='SENSITIVITY')validation=spec.sensitivity?.(parameters)??validation;
   if(kind==='STRESS')validation=spec.stress??validation;
   if(kind==='HOLDOUT'){test=spec.holdout??metric(5,'1','1');}
  }
  return {parameters,kind,train,validation,...(kind==='HOLDOUT'?{test}:{}),owner_recommendation_ready:false};
 };
 return {evaluate,calls};
}
