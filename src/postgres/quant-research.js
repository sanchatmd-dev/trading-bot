import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {D} from '../money.js';
import {hash,canonical,keys,number,fail} from '../pine-bridge/source.js';
import {freshSnapshot,deploymentEvidence} from './pine-bridge-readiness.js';
import {validateBar} from './pine-bridge-market.js';
import {lockInputs,candidatePlan,coverage,SOURCE_HASH,RULES} from '../quant-research/contract.js';
import {readJson} from './http.js';
import {ResearchDatasetStore} from '../quant-research/research-dataset-store.js';
import {CONTENT_DIGEST_SQL,buildResearchContractV2,expectedFoundationRequestV2,
 validateFoundationResearchRequestV2,RESEARCH_V2_VERSIONS,DATASET_BINDING_STEP_ID,
 DATASET_BINDING_KIND,validateDatasetBindingV1,datasetBindingIdentity} from '../quant-research/research-contract-v2.js';
import {StorageBudget} from '../quant-research/storage-budget.js';
import {assertQuantStorageOwner} from './quant-storage-retention.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../quant-research/runtime-engine-files.js';

export const TERMINAL=new Set(['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
const engineFiles=['src/quant-research/contract.js','src/postgres/quant-research-worker.js','quant_lab/src/robot_quant/research_engine.py','quant_lab/src/robot_quant/spt_custom_evaluator.py','quant_lab/src/robot_quant/spt_evaluator.py','quant_lab/src/robot_quant/bridge_paper.py','quant_lab/src/robot_quant/bridge_replay.py','quant_lab/src/robot_quant/risk_evaluator.py','quant_lab/src/robot_quant/ql3a.py','quant_lab/src/robot_quant/analytics.py'];
function engineFileList(foundation=false){
 const files=foundation?[...engineFiles,'src/postgres/quant-research-foundation.js','src/postgres/quant-foundation-scheduler.js','src/quant-research/foundation-contract.js','src/quant-research/dataset-store.js','src/quant-research/research-dataset-store.js','src/quant-research/process-supervisor.js','src/quant-research/resource-health.js','quant_lab/src/robot_quant/research_chunk.py','quant_lab/src/robot_quant/paper_state.py']:engineFiles;
 if(foundation)files.push('src/quant-research/storage-budget.js','src/postgres/quant-storage-retention.js','src/postgres/quant-foundation-recovery.js',
   'src/quant-research/io-controls.js','src/quant-research/data-profile.js','src/quant-research/profile-contract.js','src/postgres/quant-profile.js',
   'src/quant-research/health-recovery-gate.js','src/quant-research/scheduler-health.js','src/quant-research/bounded-health-probe.js','src/postgres/quant-research-main.js',
   'src/quant-research/atr14-chunk-store.js','src/quant-research/capacity-contract.js',
   'src/quant-research/foundation-contract-v2.js','src/quant-research/profile-contract-v2.js',
   'src/quant-research/data-profile-v2.js','src/quant-research/profile-pipeline-v2.js','src/quant-research/io-terminal.js',
   'src/quant-research/research-contract-v2.js');
 return foundation?[...new Set([...files,...QUANT_RUNTIME_ENGINE_FILES])]:files;
}
export const LEGACY_ENGINE_FILES=Object.freeze([...engineFiles]);
export const FOUNDATION_ENGINE_FILES=Object.freeze(engineFileList(true));
export async function engineHash(foundation=false){
 const files=foundation?FOUNDATION_ENGINE_FILES:LEGACY_ENGINE_FILES;
 const hashes=await Promise.all(files.map(async name=>[name,hash(await fs.readFile(new URL('../../'+name,import.meta.url)))]));
 return hash(canonical(Object.fromEntries(hashes)));
}

export class QuantResearchService{
 constructor({pineService,clock=Date.now,supportedSourceHash=SOURCE_HASH,foundation=process.env.QUANT_RESEARCH_FOUNDATION_ENABLED==='1',datasetStore}){
  this.pine=pineService;this.store=pineService.store;this.db=pineService.db;this.clock=clock;this.supportedSourceHash=supportedSourceHash;this.foundation=foundation;this.managedStorage=foundation&&!datasetStore;
  if(this.managedStorage){
   if(!process.env.QUANT_STORAGE_LIMITS_FILE)throw fail('QUANT_STORAGE_LIMITS_REQUIRED');
   const limits=JSON.parse(readFileSync(process.env.QUANT_STORAGE_LIMITS_FILE,'utf8'));
   const root=process.env.QUANT_RESEARCH_DATASET_ROOT;
   this.storageBudget=new StorageBudget({...limits,root});
   datasetStore=new ResearchDatasetStore({root,storageBudget:this.storageBudget});
  }
  this.datasetStore=datasetStore??null;
 }
 async executorMode(){
  const exists=(await this.db.query("SELECT to_regclass('quant_research_executor_mode') present")).rows[0].present;
  if(!exists){if(this.foundation)throw fail('RESEARCH_FOUNDATION_SCHEMA_REQUIRED');return;}
  const row=(await this.db.query('SELECT mode FROM quant_research_executor_mode WHERE singleton FOR SHARE')).rows[0];
  if(row?.mode!==(this.foundation?'FOUNDATION':'LEGACY'))throw fail('RESEARCH_EXECUTOR_MODE_MISMATCH',503);
 }
 async enqueue(owner,body,key){
  keys(body,['bot_id','deployment_id','parameter_slots','bridge_domains','dataset','budget','seed','deadline_seconds'],['bot_id','deployment_id','parameter_slots','bridge_domains','dataset','budget','seed']);
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
  await this.pine.authorize(owner,body.bot_id);
  await this.executorMode();
  if(this.managedStorage)await assertQuantStorageOwner(this.db,this.datasetStore.root);
  if(this.foundation)await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
  await this.db.lock('quant:research:queue');
  const submissionHash=hash(canonical(body));
  const old=await this.db.prepare('SELECT * FROM quant_jobs WHERE owner_id=? AND bot_id=? AND idempotency_key=?').get(owner,body.bot_id,key);
  if(old){if(old.submission_hash!==submissionHash)throw fail('IDEMPOTENCY_CONFLICT',409);return this.summary(old);}
  const deployment=await this.db.prepare('SELECT * FROM pine_deployments WHERE owner_id=? AND bot_id=? AND deployment_id=?').get(owner,body.bot_id,body.deployment_id);
  if(!deployment)throw fail('NOT_FOUND',404);
  if(deployment.state!=='READY')throw fail('RESEARCH_DEPLOYMENT_NOT_READY',409);
  if(hash(canonical(deployment.snapshot))!==deployment.snapshot_hash)throw fail('SNAPSHOT_HASH_MISMATCH',409);
  await freshSnapshot(this.pine,deployment);
  const evidence=await deploymentEvidence(this.db,deployment);
  if(evidence.execution_model.version!=='paper-close-v1')throw fail('RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED',409);
  const snapshot=deployment.snapshot;
  if(snapshot.membership.length!==1)throw fail('MULTI_PINE_RESEARCH_NOT_SUPPORTED',409);
  if(snapshot.policy.paperTrading!==true||snapshot.policy.requireReduceOnlySell!==true)throw fail('SPOT_PAPER_POLICY_REQUIRED');
  if(snapshot.market.broker!=='binance-global'||snapshot.market.symbol!=='BTCUSDT'||snapshot.market.timeframe!=='1')throw fail('UNSUPPORTED_CUSTOM_MARKET');
  const source=await this.pine.source(owner,body.bot_id,deployment.pine_import_id,deployment.source_version);
  if(source.source_hash!==this.supportedSourceHash||hash(source.source)!==source.source_hash)throw fail('UNSUPPORTED_SOURCE_HASH');
  const review=source.analysis.effective_input_review;
  if(source.analysis.inputs.length!==58||!review||review.source_hash!==source.source_hash||review.effective_inputs_hash!==source.analysis.effective_inputs_hash||review.input_count!==58||!review.reviewed_by||!Number.isSafeInteger(review.reviewed_at))throw fail('CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED');
  const effective=Object.fromEntries(source.analysis.inputs.map(i=>[i.pine_variable,i.effective_value]));
  const settings={preset:'Custom',tradeDirectionectionection:'Long + Exit',useSlowFilter:true,useMTF:false,useRSIFilter:false,requireBOS:false,requireSweep:false,slMode:'Zone + ATR',useSession:false,confirmMode:'Any',notifyEnabled:false};
  if(Object.entries(settings).some(([name,value])=>effective[name]!==value))throw fail('UNSUPPORTED_CUSTOM_SETTING');
  if(canonical(snapshot.selection.signals)!==canonical({buy:'buySignal',exit:'sellSignal',timing:'bar_close'}))throw fail('UNSUPPORTED_SIGNAL_MAPPING');
  const lock=lockInputs(source.analysis,snapshot.selection,body.parameter_slots,body.bridge_domains);
  const plan=candidatePlan(lock,body.budget,body.seed);
  keys(body.dataset,['start_time','end_time','warmup_bars']);
  for(const k of ['start_time','end_time'])number(body.dataset[k],{min:1,max:this.clock(),integer:true});
  const slowMaximum=Math.max(effective.emaSlowInput,...(lock.domains.emaSlowInput??[]));
  number(body.dataset.warmup_bars,{min:Math.max(1006,slowMaximum*5),max:5000,integer:true});
  const {start_time:start,end_time:end,warmup_bars:warmup}=body.dataset;
  if(start>=end||(end-start)%60000!==0||start%60000!==0||end%60000!==0||1+(end-start)/60000>10000)throw fail('INVALID_RESEARCH_DATASET');
  const seconds=body.deadline_seconds??900;number(seconds,{min:60,max:900,integer:true});
  // Queue limits and the range precheck run before any bar row is loaded or any dataset file is published.
  // The queue lock (and, in FOUNDATION mode, the scheduler lock) stays held. The limits hold through that lock plus
  // SERIALIZABLE conflict detection: a concurrent committed enqueue surfaces as 40001, answered 409 RETRY_TRANSACTION.
  const running=await this.db.prepare("SELECT count(*) total,count(*) FILTER(WHERE owner_id=?) own FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')").get(owner);
  if(running.total>=10||running.own>=2)throw fail('QUANT_QUEUE_FULL',429);
  if(this.foundation){
   const queued=(await this.db.query("SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED','RUNNING','STOPPING')",[owner])).rows[0];
   if(queued.total>=100||queued.owned>=20)throw fail('FOUNDATION_QUEUE_FULL',429);
  }
  const expected=1+(end-start)/60000;
  let contract,request;
  if(this.foundation){
   const model=evidence.execution_model;
   const span=(await this.db.query(CONTENT_DIGEST_SQL,[start,end,model.data_profile])).rows[0];
   if(span.n!==expected||expected-warmup<2000)throw fail('INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
   if(span.first_time!==start||span.last_time!==end||span.bad!==0||
      typeof span.digest!=='string'||!/^[a-f0-9]{64}$/.test(span.digest))throw fail('VERIFIED_MARKET_DATA_REQUIRED');
   const capital=snapshot.capital.find(c=>c.broker===snapshot.market.broker);
   if(!capital||!D(capital.configuredEquity).gt(0)||!D(capital.configuredBalance).gt(0))throw fail('RESEARCH_CAPITAL_REQUIRED');
   contract=buildResearchContractV2({owner_id:owner,bot_id:body.bot_id,deployment,source,snapshot,
    lock,plan,model,rules:RULES,capital,engine_hash:await engineHash(true),
    dataset:{...body.dataset,content_digest:span.digest}});
   request=validateFoundationResearchRequestV2(expectedFoundationRequestV2(contract,seconds*1000),contract);
  }else{
  const span=await this.db.prepare("SELECT count(*) n,min(bar_time) first_time,max(bar_time) last_time FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=? AND bar_time<=?").get(start,end);
  if(span.n!==expected||expected-warmup<2000)throw fail('INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
  if(span.first_time!==start||span.last_time!==end)throw fail('VERIFIED_MARKET_DATA_REQUIRED');
  const rows=await this.db.prepare("SELECT * FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=? AND bar_time<=? ORDER BY bar_time").all(start,end);
  if(rows.length!==expected)throw fail('INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
  const model=evidence.execution_model;
  for(let i=0;i<rows.length;i++){
   const row=rows[i];
   if(row.bar_time!==start+i*60000||row.bar.time!==row.bar_time||row.provenance.profile!==model.data_profile||hash(canonical(row.bar))!==row.content_hash)throw fail('VERIFIED_MARKET_DATA_REQUIRED');
   validateBar(row.bar);
   if(!D(row.bar.price_tick).eq(model.price_tick)||!D(row.bar.quantity_step).eq(model.quantity_step))throw fail('MARKET_METADATA_MISMATCH');
  }
  const capital=snapshot.capital.find(c=>c.broker===snapshot.market.broker);
  if(!capital||!D(capital.configuredEquity).gt(0)||!D(capital.configuredBalance).gt(0))throw fail('RESEARCH_CAPITAL_REQUIRED');
  const count=rows.length-warmup;
  contract={version:'ql3a-research-job-v1',scope:'SPT_CUSTOM_ENGINEERING_ONLY',owner_id:owner,bot_id:body.bot_id,deployment_id:deployment.deployment_id,pine_import_id:deployment.pine_import_id,source_version:deployment.source_version,source:source.source,source_hash:source.source_hash,baseline_snapshot_hash:deployment.snapshot_hash,snapshot:{...snapshot,selection:lock.selection},input_lock:lock,plan,model,rules:RULES,engine_hash:await engineHash(),dataset:{...body.dataset,bar_count:rows.length,bars:rows.map(r=>r.bar),sha256:hash(canonical(rows.map(r=>({bar:r.bar,content_hash:r.content_hash,provenance:r.provenance}))))},split:{warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:rows.length},capital:{equity:capital.configuredEquity,cash:capital.configuredBalance},ledger_initialization:'Independent historical flat Paper simulation; live daily/streak counters are neither consumed nor reset.',max_evaluations:plan.planned_candidates+2*Object.keys(lock.domains).length+2+3,acceptance_blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']};
  }
  const now=this.clock(),id=randomUUID();
  await this.db.prepare("INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?,?)").run(id,owner,body.bot_id,deployment.deployment_id,key,submissionHash,hash(canonical(contract)),JSON.stringify(contract),now,now,now+seconds*1000);
  if(this.foundation){
   await this.db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
   await this.db.query("INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)",[id,owner,'research:'+id,JSON.stringify(request),hash(canonical(request)),now,now+seconds*1000]);
   await this.db.query('INSERT INTO quant_research_foundation VALUES($1,$2,$3)',[id,id,hash(canonical(contract))]);
  }
  await this.store.audit(owner,'quant.research.queued',id,{bot_id:body.bot_id,input_lock_hash:lock.lock_hash,
   ...(this.foundation?{dataset_content_digest:contract.dataset.content_digest}:{dataset_hash:contract.dataset.sha256}),
   budget:plan.planned_candidates,source_slots:lock.selection.bindings.length});
  return this.get(owner,id);
 }
 async summary(row){
  const steps=await this.db.prepare('SELECT step_id,kind,parameters,result,completed_at FROM quant_job_steps WHERE run_id=? ORDER BY completed_at,step_id').all(row.run_id);
  const candidates=steps.filter(s=>s.kind==='CANDIDATE');
  let datasetStatus={dataset_hash:row.contract.dataset.sha256};
  if(row.contract.version===RESEARCH_V2_VERSIONS.contract){
   const binding=(await this.db.query('SELECT * FROM quant_research_chunks WHERE run_id=$1 AND step_id=$2',
    [row.run_id,DATASET_BINDING_STEP_ID])).rows[0];
   if(binding){
    validateDatasetBindingV1(row.contract,binding.parameters);
    if(binding.kind!==DATASET_BINDING_KIND||binding.identity_hash!==datasetBindingIdentity(row.contract,binding.parameters)||
       binding.next_bar!==0||binding.checkpoint!==null||binding.checkpoint_hash!==null||
       binding.unit_name!==null||binding.unit_token!==null)throw fail('RESEARCH_DATASET_BINDING_INVALID');
   }
   datasetStatus={dataset_hash:binding?.parameters.dataset_sha256??null,
    dataset_content_digest:row.contract.dataset.content_digest,dataset_prepared:!!binding};
  }
  return {run_id:row.run_id,bot_id:row.bot_id,deployment_id:row.deployment_id,status:row.status,phase:row.phase,created_at:row.created_at,updated_at:row.updated_at,deadline:row.deadline,attempts:row.attempt,evaluations_started:row.evaluations_started,contract_hash:row.contract_hash,source_hash:row.contract.source_hash,baseline_snapshot_hash:row.contract.baseline_snapshot_hash,input_lock_hash:row.contract.input_lock.lock_hash,...datasetStatus,source_slots:row.contract.input_lock.selection.bindings.map(i=>({slot:i.slot,input_id:i.input_id,pine_variable:i.pine_variable,effective_value:i.effective_value,search_domain:i.search_domain})),bridge_domains:{atr_multiplier:row.contract.input_lock.domains.atr_multiplier,rr:row.contract.input_lock.domains.rr},progress:{candidates_completed:candidates.length,candidates_planned:row.contract.plan.planned_candidates,percent:Math.floor(100*candidates.length/row.contract.plan.planned_candidates),checks_completed:steps.length-candidates.length,...coverage(candidates,row.contract.input_lock.domains)},result:row.result,diagnostic:row.diagnostic,owner_recommendation_ready:false,acceptance_blockers:row.contract.acceptance_blockers};
 }
 async get(owner,id,cancel=false){
  await this.executorMode();
  if(this.foundation)await this.db.query('SELECT singleton FROM quant_foundation_scheduler FOR UPDATE');
  const scope=await this.db.prepare('SELECT bot_id FROM quant_jobs WHERE run_id=? AND owner_id=?').get(id,owner);
  if(!scope)throw fail('NOT_FOUND',404);
  await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner);
  if(scope.bot_id!==owner)await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(scope.bot_id);
  const row=await this.db.prepare('SELECT * FROM quant_jobs WHERE run_id=? AND owner_id=? FOR UPDATE').get(id,owner);
  if(!row)throw fail('NOT_FOUND',404);await this.pine.authorize(owner,row.bot_id);
  if(cancel&&!TERMINAL.has(row.status)){
   if(row.contract.execution_backend==='quant-foundation-v1'){
    const binding=(await this.db.query('SELECT job_id FROM quant_research_foundation WHERE run_id=$1',[id])).rows[0];
    await this.db.query("UPDATE quant_foundation_jobs SET status=CASE WHEN status IN ('RUNNING','STOPPING') THEN 'STOPPING' ELSE 'CANCELLED' END,stop_reason=CASE WHEN status IN ('RUNNING','STOPPING') THEN 'CANCELLED' ELSE NULL END,lease_until=NULL,runtime_used_ms=runtime_used_ms+CASE WHEN run_started_at IS NULL THEN 0 ELSE GREATEST(0,$2-run_started_at) END,run_started_at=NULL WHERE job_id=$1 AND status IN ('QUEUED','PAUSED','RUNNING','STOPPING')",[binding.job_id,this.clock()]);
   }
   row.status='CANCELLED';row.updated_at=this.clock();
   await this.db.prepare("UPDATE quant_jobs SET status='CANCELLED',lease_token=NULL,lease_until=0,updated_at=? WHERE run_id=?").run(row.updated_at,id);
   await this.store.audit(owner,'quant.research.cancelled',id,{});
  }
  return this.summary(row);
 }
}

export async function quantResearchRoutes(req,res,url,actor,service,json,{enabled=false}={}){
 const prefix='/api/quant/research/jobs';
 if(url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))return false;
 if(!enabled)throw fail('QUANT_RESEARCH_DISABLED',503);
 if(url.pathname===prefix&&req.method==='POST'){json(res,202,await service.enqueue(actor.id,await readJson(req),req.headers['idempotency-key']));return true;}
 const route=url.pathname.slice(prefix.length).match(/^\/([a-f0-9-]{36})(\/cancel)?$/);
 if(route&&((req.method==='GET'&&!route[2])||(req.method==='POST'&&route[2]))){
  if(route[2])keys(await readJson(req),[]);
  json(res,200,await service.get(actor.id,route[1],!!route[2]));return true;
 }
 throw fail('NOT_FOUND',404);
}
