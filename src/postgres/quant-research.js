import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {D} from '../money.js';
import {hash,canonical,keys,number,fail} from '../pine-bridge/source.js';
import {freshSnapshot,deploymentEvidence} from './pine-bridge-readiness.js';
import {validateBar} from './pine-bridge-market.js';
import {lockInputs,candidatePlan,coverage,SOURCE_HASH,RULES} from '../quant-research/contract.js';
import {readJson} from './http.js';

export const TERMINAL=new Set(['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
const engineFiles=['src/quant-research/contract.js','src/postgres/quant-research-worker.js','quant_lab/src/robot_quant/research_engine.py','quant_lab/src/robot_quant/spt_custom_evaluator.py','quant_lab/src/robot_quant/spt_evaluator.py','quant_lab/src/robot_quant/bridge_paper.py','quant_lab/src/robot_quant/bridge_replay.py','quant_lab/src/robot_quant/risk_evaluator.py','quant_lab/src/robot_quant/ql3a.py','quant_lab/src/robot_quant/analytics.py'];
export async function engineHash(){
 const hashes=await Promise.all(engineFiles.map(async name=>[name,hash(await fs.readFile(new URL('../../'+name,import.meta.url)))]));
 return hash(canonical(Object.fromEntries(hashes)));
}

export class QuantResearchService{
 constructor({pineService,clock=Date.now,supportedSourceHash=SOURCE_HASH}){this.pine=pineService;this.store=pineService.store;this.db=pineService.db;this.clock=clock;this.supportedSourceHash=supportedSourceHash;}
 async enqueue(owner,body,key){
  keys(body,['bot_id','deployment_id','parameter_slots','bridge_domains','dataset','budget','seed','deadline_seconds'],['bot_id','deployment_id','parameter_slots','bridge_domains','dataset','budget','seed']);
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw fail('IDEMPOTENCY_KEY_REQUIRED');
  await this.pine.authorize(owner,body.bot_id);
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
  const rows=await this.db.prepare("SELECT * FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time>=? AND bar_time<=? ORDER BY bar_time").all(start,end);
  if(rows.length!==1+(end-start)/60000||rows.length-warmup<2000)throw fail('INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
  const model=evidence.execution_model;
  for(let i=0;i<rows.length;i++){
   const row=rows[i];
   if(row.bar_time!==start+i*60000||row.bar.time!==row.bar_time||row.provenance.profile!==model.data_profile||hash(canonical(row.bar))!==row.content_hash)throw fail('VERIFIED_MARKET_DATA_REQUIRED');
   validateBar(row.bar);
   if(!D(row.bar.price_tick).eq(model.price_tick)||!D(row.bar.quantity_step).eq(model.quantity_step))throw fail('MARKET_METADATA_MISMATCH');
  }
  const seconds=body.deadline_seconds??900;number(seconds,{min:60,max:900,integer:true});
  const running=await this.db.prepare("SELECT count(*) total,count(*) FILTER(WHERE owner_id=?) own FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')").get(owner);
  if(running.total>=10||running.own>=2)throw fail('QUANT_QUEUE_FULL',429);
  const capital=snapshot.capital.find(c=>c.broker===snapshot.market.broker);
  if(!capital||!D(capital.configuredEquity).gt(0)||!D(capital.configuredBalance).gt(0))throw fail('RESEARCH_CAPITAL_REQUIRED');
  const count=rows.length-warmup;
  const contract={version:'ql3a-research-job-v1',scope:'SPT_CUSTOM_ENGINEERING_ONLY',owner_id:owner,bot_id:body.bot_id,deployment_id:deployment.deployment_id,pine_import_id:deployment.pine_import_id,source_version:deployment.source_version,source:source.source,source_hash:source.source_hash,baseline_snapshot_hash:deployment.snapshot_hash,snapshot:{...snapshot,selection:lock.selection},input_lock:lock,plan,model,rules:RULES,engine_hash:await engineHash(),dataset:{...body.dataset,bar_count:rows.length,bars:rows.map(r=>r.bar),sha256:hash(canonical(rows.map(r=>({bar:r.bar,content_hash:r.content_hash,provenance:r.provenance}))))},split:{warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:rows.length},capital:{equity:capital.configuredEquity,cash:capital.configuredBalance},ledger_initialization:'Independent historical flat Paper simulation; live daily/streak counters are neither consumed nor reset.',max_evaluations:plan.planned_candidates+2*Object.keys(lock.domains).length+2+3,acceptance_blockers:['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']};
  const now=this.clock(),id=randomUUID();
  await this.db.prepare("INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?,?)").run(id,owner,body.bot_id,deployment.deployment_id,key,submissionHash,hash(canonical(contract)),JSON.stringify(contract),now,now,now+seconds*1000);
  await this.store.audit(owner,'quant.research.queued',id,{bot_id:body.bot_id,input_lock_hash:lock.lock_hash,dataset_hash:contract.dataset.sha256,budget:plan.planned_candidates,source_slots:lock.selection.bindings.length});
  return this.get(owner,id);
 }
 async summary(row){
  const steps=await this.db.prepare('SELECT step_id,kind,parameters,result,completed_at FROM quant_job_steps WHERE run_id=? ORDER BY completed_at,step_id').all(row.run_id);
  const candidates=steps.filter(s=>s.kind==='CANDIDATE');
  return {run_id:row.run_id,bot_id:row.bot_id,deployment_id:row.deployment_id,status:row.status,phase:row.phase,created_at:row.created_at,updated_at:row.updated_at,deadline:row.deadline,attempts:row.attempt,evaluations_started:row.evaluations_started,contract_hash:row.contract_hash,source_hash:row.contract.source_hash,baseline_snapshot_hash:row.contract.baseline_snapshot_hash,input_lock_hash:row.contract.input_lock.lock_hash,dataset_hash:row.contract.dataset.sha256,source_slots:row.contract.input_lock.selection.bindings.map(i=>({slot:i.slot,input_id:i.input_id,pine_variable:i.pine_variable,effective_value:i.effective_value,search_domain:i.search_domain})),bridge_domains:{atr_multiplier:row.contract.input_lock.domains.atr_multiplier,rr:row.contract.input_lock.domains.rr},progress:{candidates_completed:candidates.length,candidates_planned:row.contract.plan.planned_candidates,percent:Math.floor(100*candidates.length/row.contract.plan.planned_candidates),checks_completed:steps.length-candidates.length,...coverage(candidates,row.contract.input_lock.domains)},result:row.result,diagnostic:row.diagnostic,owner_recommendation_ready:false,acceptance_blockers:row.contract.acceptance_blockers};
 }
 async get(owner,id,cancel=false){
  const scope=await this.db.prepare('SELECT bot_id FROM quant_jobs WHERE run_id=? AND owner_id=?').get(id,owner);
  if(!scope)throw fail('NOT_FOUND',404);
  await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(owner);
  if(scope.bot_id!==owner)await this.db.prepare('SELECT id FROM users WHERE id=? FOR UPDATE').get(scope.bot_id);
  const row=await this.db.prepare('SELECT * FROM quant_jobs WHERE run_id=? AND owner_id=? FOR UPDATE').get(id,owner);
  if(!row)throw fail('NOT_FOUND',404);await this.pine.authorize(owner,row.bot_id);
  if(cancel&&!TERMINAL.has(row.status)){
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
