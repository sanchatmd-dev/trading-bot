import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../../src/pine-bridge/source.js';

/**
 * LABELLED TEST FIXTURES for the Quant Research Library. Everything here is synthetic. A fixture run is built the way the
 * research workers build one (contract, per-evaluation checkpoints, report that matches them), so the library derives its
 * answers from realistic rows. These runs are never real research results and must never be shown as such: the product
 * UI renders only what the API returns from real rows. Compatible comparisons are proven with these fixtures only.
 */
export const FIXTURE_LABEL='LABELLED TEST FIXTURE: synthetic data, not a research result';
export const MARKERS=Object.freeze({source:'SECRET_SOURCE_TEXT',bar:'BAR_SECRET',plan:'PLAN_LEAK',policy:'POLICY_SECRET',lease:'LEASE_TOKEN_SECRET',
  worker:'WORKER_ID_SECRET',references:'REFERENCES_PATH_SECRET',idempotency:'idem-run-',submission:'SUBMISSION_HASH_SECRET'});
export const MINUTE=60000;
export const T0=Date.UTC(2026,8,27,7,30);
export const BLOCKERS=['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'];
export const RULES={minimum_closed_trades_train:5,minimum_closed_trades_validation:5,minimum_closed_trades_test:5,maximum_drawdown_percent:20,sensitivity_max_drop_percentage_points:2};
const LEDGER='Independent historical flat Paper simulation; live daily/streak counters are neither consumed nor reset.';
export const hex=tag=>hash('quant-library-fixture:'+tag);
export const parameters=index=>({atr_multiplier:1+(index%7)*0.5,rr:1+(Math.floor(index/7)%5)*0.25,emaFastInput:30+Math.floor(index/35)*10});

/** A contract in the stored shape. version v1 embeds the bars; v2 (FOUNDATION) holds only the digest. */
export function contractOf({version='v1',owner,bot=owner,deployment,importId,tag='a',total=1000,warmup=300,start=T0,candidates=6,barCount=0,
  engine=hex('engine-'+version),policyHash=hex('policy'),sourceHash=hex('source'),fee=10,slippage=1,capital='1000',domains,blockers=BLOCKERS,seed=7,budget}={}){
  const v2=version==='v2',count=total-warmup;
  const plan=Array.from({length:candidates},(_,index)=>parameters(index));
  const grid={atr_multiplier:[1,1.5,2,2.5,3,3.5,4],rr:[1,1.25,1.5,1.75,2],emaFastInput:[30,40,50]};
  const split={warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:total};
  const dataset=v2?{start_time:start,end_time:start+(total-1)*MINUTE,warmup_bars:warmup,bar_count:total,first_time:start,
      timestamp_semantics:'verified closed-bar timestamps; half-open index end is last timestamp plus one minute',content_digest:hex('digest-'+tag),digest_version:'pine-bar-content-digest-v1'}
    :{start_time:start,end_time:start+(total-1)*MINUTE,warmup_bars:warmup,bar_count:total,sha256:hex('dataset-'+tag),
      bars:Array.from({length:barCount},(_,index)=>({time:start+index*MINUTE,open:'100',high:'101',low:'99',close:MARKERS.bar,volume:'1'}))};
  return {version:v2?'ql3a-research-job-v2':'ql3a-research-job-v1',scope:'SPT_CUSTOM_ENGINEERING_ONLY',owner_id:owner,bot_id:bot,deployment_id:deployment,
    pine_import_id:importId,source_version:1,source:'//@version=6\n// '+MARKERS.source+' '+tag+'\nindicator("x")',source_hash:sourceHash,baseline_snapshot_hash:hex('baseline-'+tag),
    snapshot:{market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy:{marker:MARKERS.policy,equities:{'binance-global':1000},balances:{'binance-global':1000}},policy_hash:policyHash,
      membership:[{pine_import_id:importId,source_version:1,source_hash:sourceHash,analysis:{marker:MARKERS.source}}]},
    input_lock:{lock_hash:hex('lock-'+tag),selection:{signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},bridge:{atr_multiplier:2,rr:1.5},
      bindings:[{slot:3,input_id:'input_3',pine_variable:'emaFastInput',effective_value:50,type:'int',search_domain:{min:30,max:50,step:10},source_span:{start:1,end:2}}],
      fixed_inputs:[{input_id:'input_9',pine_variable:'useSlowFilter',effective_value:true,type:'bool',eligible:false},{input_id:'input_10',pine_variable:'notifyEnabled',effective_value:false,type:'bool',eligible:false}]},
      domains:domains??grid,baseline:{atr_multiplier:2,rr:1.5,emaFastInput:50}},
    plan:{candidates:plan.map(item=>({...item,marker:MARKERS.plan})),algorithm:'axis-covered-seeded-grid-v1',seed,requested_budget:budget??candidates,planned_candidates:candidates,grid_combinations:105},
    model:{version:'paper-close-v1',price_tick:0.01,quantity_step:0.001,fee_bps:fee,slippage_bps:slippage,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'},
    rules:RULES,engine_hash:engine,dataset,split,capital:{equity:capital,cash:capital},ledger_initialization:LEDGER,max_evaluations:candidates+2*3+2+3,
    acceptance_blockers:[...blockers],...(v2?{execution_backend:'quant-foundation-v1'}:{})};
}

export const metricsOf=(netReturn,trades,drawdown='1.5')=>({bars:1350,closed_trades:trades,start_equity:'1000',end_equity:String(1000+Number(netReturn)*10),
  net_return_percent:String(netReturn),max_drawdown_percent:String(drawdown),profit_factor:'1.2',gross_profit:'12.5',gross_loss:'5.5'});
const evaluation=(kind,params,train,validation,test)=>({kind,parameters:params,train,validation,...(test?{test}:{})});
const padded=index=>String(index).padStart(3,'0');

/**
 * The checkpoints and the report of a finished run, built like the worker builds them.
 * scenario: NO_VALID (every candidate misses the validation sample), PENDING (a candidate passes every check),
 * ROBUSTNESS (the selected candidate fails the cost stress), HOLDOUT_FEW (too few holdout trades), HOLDOUT_NEGATIVE.
 */
export function outcomeOf(contract,scenario='NO_VALID',{at=T0+3_600_000,bestReturn='3.2'}={}){
  const planned=contract.plan.planned_candidates,steps=[];
  const step=(id,kind,params,result,offset)=>{steps.push({step_id:id,kind,parameters:params,result,completed_at:at+offset});return result;};
  const results=[];
  for(let index=0;index<planned;index++){
    const params=parameters(index),good=scenario!=='NO_VALID'&&index===1;
    const train=metricsOf(good?'4.1':'-0.5',good?9:7),validation=good?metricsOf(bestReturn,8):metricsOf(scenario==='NO_VALID'?'0':'-0.2',scenario==='NO_VALID'?0:6);
    results.push({parameters:params,result:step('candidate:'+padded(index),'CANDIDATE',params,evaluation('CANDIDATE',params,train,validation),index)});
  }
  const candidates=results.map((item,index)=>({...item,screen_reasons:scenario==='NO_VALID'?['INSUFFICIENT_VALIDATION_TRADES']:index===1?[]:['VALIDATION_BELOW_BASELINE_OR_ZERO']}));
  const report={scope:contract.scope,contract_hash:hash(canonical(contract)),input_lock_hash:contract.input_lock.lock_hash,
    dataset_hash:contract.dataset.sha256??contract.dataset.content_digest,search_algorithm:contract.plan.algorithm,seed:contract.plan.seed,budget:contract.plan.requested_budget,
    candidate_count:planned,selected_dimensions:3,covered_dimensions:3,dimension_coverage_percent:100,candidates,selected:null,owner_recommendation_ready:false,
    acceptance_blockers:contract.acceptance_blockers,holdout_evaluated:false,completion_reason:'NO_VALID_TRAIN_VALIDATION_CANDIDATE'};
  if(scenario==='NO_VALID')return {status:'NO_VALID_CANDIDATE',result:report,steps};
  const best=candidates[1],errors=[];
  const neighbour={...best.parameters,rr:3},near=results[2];
  const sensitivityResult=step('sensitivity:rr:9','SENSITIVITY',neighbour,evaluation('SENSITIVITY',neighbour,metricsOf('3.0',9),metricsOf('2.9',8)),planned);
  const stress=step('stress:selected','STRESS',best.parameters,evaluation('STRESS',best.parameters,metricsOf('3.5',9),metricsOf(scenario==='ROBUSTNESS'?'-1.0':'2.4',8)),planned+1);
  if(scenario==='ROBUSTNESS')errors.push('COST_STRESS_FAILED');
  report.selected={...best,sensitivity:[{dimension:'atr_multiplier',parameters:near.parameters,result:near.result},{dimension:'rr',parameters:neighbour,result:sensitivityResult}],cost_stress:stress,screen_reasons:errors};
  if(!errors.length){
    const test=scenario==='HOLDOUT_FEW'?metricsOf('1.1',2):scenario==='HOLDOUT_NEGATIVE'?metricsOf('-0.7',9):metricsOf('1.9',9);
    const holdout=step('holdout:selected','HOLDOUT',best.parameters,evaluation('HOLDOUT',best.parameters,metricsOf('4.1',9),metricsOf(bestReturn,8),test),planned+2);
    report.holdout_evaluated=true;report.selected.test=holdout.test;
    if(holdout.test.closed_trades<5)errors.push('INSUFFICIENT_TEST_TRADES');
    if(Number(holdout.test.net_return_percent)<0)errors.push('NEGATIVE_HOLDOUT_RETURN');
  }
  report.completion_reason=errors.length?'CANDIDATE_FAILED_CHECKS':'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';
  return {status:errors.length?'NO_VALID_CANDIDATE':'SUCCEEDED',result:report,steps};
}

/** A run record: contract, hash, outcome and checkpoints. Non-completed statuses carry only what the worker had written. */
export function runOf({id=randomUUID(),status,scenario,diagnostic=null,at=T0+7_200_000,partial=0,...contractOptions}={}){
  const contract=contractOf(contractOptions);
  const outcome=scenario?outcomeOf(contract,scenario,{at}):null;
  const finalStatus=status??outcome?.status;
  const steps=outcome?outcome.steps:Array.from({length:partial},(_,index)=>{
    const params=parameters(index);
    return {step_id:'candidate:'+padded(index),kind:'CANDIDATE',parameters:params,result:evaluation('CANDIDATE',params,metricsOf('-0.5',7),metricsOf('0',0)),completed_at:at+index};
  });
  return {run_id:id,status:finalStatus,created_at:at,updated_at:at+120_000,contract,contract_hash:hash(canonical(contract)),result:outcome?outcome.result:null,steps,diagnostic,
    phase:['QUEUED','RUNNING'].includes(finalStatus)?'CANDIDATES':'COMPLETE'};
}

/** Writes one run and its checkpoints with plain inserts. Rows carry marker strings in every column the views must never return. */
export async function seedRun(db,run,{owner,deployment,bot=owner,leaseToken=null,attempt=1}={}){
  const contract=JSON.stringify(run.contract);
  await db.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline,
    phase,attempt,evaluations_started,lease_token,lease_until,result,diagnostic) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [run.run_id,owner,bot,deployment,MARKERS.idempotency+run.run_id,MARKERS.submission,run.contract_hash,contract,run.status,run.created_at,run.updated_at,run.created_at+900000,
      run.phase,attempt,run.steps.length,leaseToken,leaseToken?run.created_at+900000:0,run.result?JSON.stringify(run.result):null,run.diagnostic]);
  for(const step of run.steps)await db.query('INSERT INTO quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
    [run.run_id,step.step_id,step.kind,JSON.stringify(step.parameters),JSON.stringify(step.result),step.completed_at]);
  return run.run_id;
}

/** The FOUNDATION rows of a v2 run: execution facts, the run to job binding and the dataset binding chunk (never read back whole). */
export async function seedFoundation(db,run,{owner,withBinding=true,bindingHash=run.contract_hash}={}){
  const c=run.contract,d=c.dataset;
  await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
  const request={version:'quant-foundation-research-v2',owner_id:owner,bot_id:owner,kind:'OPTIMIZE',
    pending_dataset:{metadata:{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:d.start_time,end_time:d.end_time+MINUTE,
      warmup_bars:d.warmup_bars,total_bars:d.bar_count,cutoff:d.end_time+MINUTE,source:'binance-spot-klines-v1'},content_digest:d.content_digest,digest_version:d.digest_version},
    engine_hash:c.engine_hash,snapshot_hash:c.baseline_snapshot_hash,
    budget:{candidates:c.plan.planned_candidates,max_evaluations:c.max_evaluations,chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576}};
  const text=JSON.stringify(request);
  await db.query(`INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at,attempts,worker_id,runtime_used_ms,diagnostic)
    VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,1,$8,12345,NULL)`,[run.run_id,owner,'research:'+run.run_id,text,hash(text),run.created_at,run.created_at+900000,MARKERS.worker]);
  await db.query('INSERT INTO quant_research_foundation VALUES($1,$2,$3)',[run.run_id,run.run_id,bindingHash]);
  if(withBinding){
    const binding={version:'quant-research-dataset-binding-v1',references:{raw:{path:MARKERS.references},sidecar:{path:MARKERS.references}},dataset_sha256:hex('binding-'+run.run_id),
      content_digest:d.content_digest,bar_count:d.bar_count,execution_contract_hash:hex('execution-'+run.run_id)};
    await db.query("INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'prepare:dataset','PREPARE',$2,$3)",[run.run_id,JSON.stringify(binding),hex('identity-'+run.run_id)]);
    await db.query("INSERT INTO quant_research_chunks(run_id,step_id,kind,parameters,identity_hash,next_bar) VALUES($1,'candidate:000','CANDIDATE',$2,$3,1000)",[run.run_id,JSON.stringify(run.steps[0]?.parameters??{}),hex('chunk-'+run.run_id)]);
  }
}
