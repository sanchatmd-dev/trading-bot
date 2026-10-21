import {randomUUID} from 'node:crypto';
import {canonical,hash,keys,fail} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {strictJsonV2} from '../quant-research/foundation-contract-v2.js';
import {SOURCE_HASH} from '../quant-research/contract.js';
import {validateResearchContractV2,validateDatasetBindingV1,datasetBindingIdentity} from '../quant-research/research-contract-v2.js';
import {reportMatchesCheckpoints} from '../quant-library/derive.js';
import {contextFields,contextKey} from '../comparison/context.js';
import {specHashOf} from '../comparison/ranking.js';
import {registrationHashOf} from '../selection/hash.js';
import {buildFixedEvalContract,expectedFixedEvalRequest,fixedEvalParametersFromParent,projectFixedEvalPolicy,
 validateFixedEvalContract,validateFixedEvalRequest,refuseSearchFields,CONTENT_DIGEST_SQL,FIXED_EVAL_LIMITS,FIXED_EVAL_VERSIONS} from '../quant-research/fixed-eval-contract.js';
import {FIXED_EVAL_STEPS,validateFixedEvalBinding,fixedEvalBindingIdentity,validateFixedEvalStepResult,validateFixedEvalResult} from '../quant-research/fixed-eval-contract.js';
import {fixedEvalEngineHash} from './quant-fixed-eval-engine.js';
import {startEvaluation} from './selection-store.js';

const MINUTE=60000;
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const same=(a,b)=>canonical(a)===canonical(b);
const decimal=value=>D(value).toFixed();
const dataModel=c=>({data_profile:c.model.data_profile,price_tick:decimal(c.model.price_tick),quantity_step:decimal(c.model.quantity_step)});
const costModel=c=>({version:c.model.version,fee_bps:decimal(c.model.fee_bps),slippage_bps:decimal(c.model.slippage_bps)});
const TIMESTAMPS='verified closed-bar timestamps; half-open index end is last timestamp plus one minute';
/** Root-reviewed QR3 C11/C16 adapters. These hashes have different purposes from the FE2a policy-only hash. */
export const fixedEvalComparisonPolicyHash=c=>hash(canonical({policy:projectFixedEvalPolicy(c.snapshot.policy),risk_percent:decimal(c.model.risk_percent)}));
export const fixedEvalComparisonProtocolHash=(c,spec)=>hash(canonical({rules:{adequacy:spec.adequacy,risk_filter:spec.risk_filter,
 sensitivity_max_drop_percentage_points:decimal(c.rules.sensitivity_max_drop_percentage_points),cost_stress:'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE'},
 ledger_initialization:c.ledger_initialization,evaluation_contract_version:FIXED_EVAL_VERSIONS.contract}));
const need=(ok,code='FIXED_EVAL_AUTHORITY_INVALID')=>{if(!ok)throw fail(code,409);};
const parse=(text,digest)=>{need(typeof text==='string'&&hash(text)===digest);let value;try{value=JSON.parse(text);}catch{throw fail('FIXED_EVAL_AUTHORITY_INVALID',409);}need(canonical(value)===text);return value;};
const publicJob=row=>({ok:true,run_id:row.run_id,evaluation_run_id:row.run_id,status:row.status,contract_hash:row.contract_hash,
 purpose:row.contract.purpose,object_id:row.contract.lineage.object_id,parent_run_id:row.contract.lineage.parent_run_id,
 dataset_content_digest:row.contract.dataset.content_digest,dataset_sha_verified:false,deadline:row.deadline});
export const fixedEvalStepIdentity=(contract,kind)=>hash(canonical({contract,parameters:contract.parameters,kind}));
export function fixedEvalUnitName(runId,stepId,token){
 need(UUID.test(runId)&&UUID.test(token)&&FIXED_EVAL_STEPS.some(step=>step.step_id===stepId),'FIXED_EVAL_RECORDS_INVALID');
 return 'robot-quant-'+runId+'-'+hash(stepId).slice(0,8)+'-'+token+'.service';
}
/** Immutable historical authority only: no current eligibility, deployment, source or engine lookup. */
export async function fixedEvalArtifactSha(db,owner,contract,runId){
 validateFixedEvalContract(contract);need(contract.owner_id===owner);
 const id=contract.lineage.object_id,d=contract.dataset;let sha;
 if(contract.purpose==='QR4_SELECTION'){
  const r=(await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[id,owner])).rows[0];
  need(!!r);const raw=parse(r.body_canonical,r.registration_hash);
  need(registrationHashOf({...raw,registration_hash:r.registration_hash})===r.registration_hash);
  const start=(await db.query('SELECT * FROM public.quant_selection_evaluation_starts WHERE selection_id=$1 AND evaluation_run_id=$2',[id,runId])).rows[0];
  const freeze=(await db.query('SELECT * FROM public.quant_selection_window_freezes WHERE selection_id=$1',[id])).rows[0];
  need(start?.parent_run_id===contract.lineage.parent_run_id&&start.engine_hash===contract.engine_hash&&raw.scope.engine===contract.engine_hash&&
   raw.participants.some(p=>p.export_id===start.export_id&&p.run_id===start.parent_run_id)&&freeze&&start.dataset_hash===freeze.dataset_hash);
  const w=raw.window;
  need(freeze.start_ms===w.start_ms&&freeze.end_ms===w.end_ms&&freeze.bars_total===w.total_bars&&
   d.start_time===w.start_ms-w.warmup_bars*MINUTE+MINUTE&&d.end_time===w.end_ms&&d.warmup_bars===w.warmup_bars&&d.bar_count===w.total_bars);
  sha=freeze.dataset_hash;
 }else{
  const s=(await db.query('SELECT * FROM public.quant_comparison_specs WHERE comparison_id=$1 AND owner_id=$2',[id,owner])).rows[0];need(!!s);
  const spec=parse(s.spec_canonical,s.spec_body_hash);
  need(s.mode==='STANDARDIZED'&&specHashOf(spec)===s.spec_hash&&spec.period.start_ms===s.start_ms&&spec.period.end_ms===s.end_ms);
  const p=(await db.query('SELECT * FROM public.quant_comparison_participants WHERE comparison_id=$1 AND participant_id=$2',[id,contract.lineage.parent_run_id])).rows[0];need(!!p);
  const frozen=parse(p.freeze_canonical,p.freeze_hash),context=contextFields(p.participant_id,frozen.context),f=context.fields;
  need(context.missing.length===0&&contextKey(f)===p.context_key&&p.context_key===s.context_key&&spec.participants.includes(p.participant_id)&&
   f.engine===contract.engine_hash&&f.spec_hash===s.spec_hash&&same(f.period,{start_ms:s.start_ms,end_ms:s.end_ms,evaluation_bars:(s.end_ms-s.start_ms)/MINUTE})&&
   f.dataset.digest_kind==='ql3a-dataset-sha256-v1'&&f.dataset.timestamp_semantics===TIMESTAMPS&&
   f.dataset.first_bar===d.start_time&&f.dataset.last_bar===d.end_time&&f.dataset.bar_count===d.bar_count&&
   d.start_time===s.start_ms-d.warmup_bars*MINUTE+MINUTE&&d.end_time===s.end_ms);
  sha=f.dataset.digest;
 }
 need(typeof sha==='string'&&/^[a-f0-9]{64}$/.test(sha),'FIXED_EVAL_DATASET_SHA_MISMATCH');return sha;
}
/** Exact durable fixed records, shared by execution, closed reads and offline recovery. No live authority is inferred. */
export function validateFixedEvalRecords(contract,{chunks=[],steps=[],evaluations_started=0,token=null,run_id=null,complete=false}={}){
 validateFixedEvalContract(contract);
 need(chunks.length<=3&&new Set(chunks.map(row=>row.step_id)).size===chunks.length&&steps.length<=2&&new Set(steps.map(row=>row.step_id)).size===steps.length,'FIXED_EVAL_RECORDS_INVALID');
 const preparation=chunks.find(row=>row.step_id==='prepare:dataset');let binding=null;
 if(preparation){
  binding=validateFixedEvalBinding(contract,preparation.parameters);
  need(preparation.kind==='PREPARE'&&preparation.identity_hash===fixedEvalBindingIdentity(contract,binding)&&preparation.next_bar===0&&preparation.checkpoint===null&&preparation.checkpoint_hash===null&&preparation.unit_name===null&&preparation.unit_token===null,'FIXED_EVAL_RECORDS_INVALID');
 }
 const results={},units=[];let reserved=0;
 for(const chunk of chunks.filter(row=>row!==preparation)){
  const spec=FIXED_EVAL_STEPS.find(step=>step.step_id===chunk.step_id);
  need(binding&&spec&&chunk.kind===spec.kind&&same(chunk.parameters,contract.parameters)&&chunk.identity_hash===fixedEvalStepIdentity(contract,spec.kind)&&chunk.next_bar===0&&chunk.checkpoint===null&&chunk.checkpoint_hash===null,'FIXED_EVAL_RECORDS_INVALID');reserved++;
  if(chunk.unit_name!==null){need(!!token&&chunk.unit_token===token&&chunk.unit_name===fixedEvalUnitName(run_id,chunk.step_id,token),'FIXED_EVAL_RECORDS_INVALID');units.push(chunk.unit_name);}
  else need(chunk.unit_token===null,'FIXED_EVAL_RECORDS_INVALID');
 }
 need(Number.isSafeInteger(evaluations_started)&&evaluations_started===reserved&&reserved<=2,'FIXED_EVAL_RECORDS_INVALID');
 for(const step of steps){
  const spec=FIXED_EVAL_STEPS.find(item=>item.step_id===step.step_id),chunk=chunks.find(item=>item.step_id===step.step_id);
  need(binding&&spec&&chunk&&chunk.unit_name===null&&step.kind===spec.kind&&same(step.parameters,contract.parameters),'FIXED_EVAL_RECORDS_INVALID');
  results[spec.step_id==='eval:base'?'base':'stress']=validateFixedEvalStepResult(contract,binding,spec.kind,step.result);
 }
 need(!chunks.some(row=>row.step_id==='eval:stress')||!!results.base,'FIXED_EVAL_RECORDS_INVALID');
 if(complete)need(binding&&reserved===2&&steps.length===2&&units.length===0&&results.base&&results.stress,'FIXED_EVAL_RECORDS_INVALID');
 return {binding,results,units};
}

/** Internal, disabled-by-unwired admission adapter. Only persisted object/participant IDs cross its request boundary.
 * QR4 composes admission with the exposure-first start transaction. QR3 retains its SPEC_FROZEN exposure.
 * No route, worker launch, recovery decision, customer metrics, source bytes or dataset reference is exposed here.
 */
export class QuantFixedEvalService{
 constructor({pineService,clock=Date.now,supportedSourceHash=SOURCE_HASH,engineHash=fixedEvalEngineHash,runtimeMs=FIXED_EVAL_LIMITS.runtimeMs}={}){
  if(!pineService?.db||typeof pineService.authorize!=='function')throw Error('Fixed evaluation requires the internal Pine service');
  need(Number.isSafeInteger(runtimeMs)&&runtimeMs>0&&runtimeMs<=FIXED_EVAL_LIMITS.runtimeMs);
  this.pine=pineService;this.db=pineService.db;this.clock=clock;this.supportedSourceHash=supportedSourceHash;this.engineHash=engineHash;this.runtimeMs=runtimeMs;
 }
 request(body){
  refuseSearchFields(body);strictJsonV2(body);keys(body,['purpose','object_id','participant_id']);
  need(['QR4_SELECTION','QR3_COMPARISON'].includes(body.purpose)&&ID.test(body.object_id)&&ID.test(body.participant_id),'INVALID_FIELDS');
  if(body.purpose==='QR4_SELECTION')need(UUID.test(body.object_id)&&UUID.test(body.participant_id),'INVALID_FIELDS');
  return JSON.parse(canonical(body));
 }
 async prerequisites(tx){
  const {rows:[row]}=await tx.query(`SELECT
   to_regclass('public.quant_research_foundation') IS NOT NULL AND to_regclass('public.quant_research_chunks') IS NOT NULL
   AND to_regprocedure('public.quant_research_freeze_version()') IS NOT NULL AS present,
   (SELECT count(*)::int FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled='A' AND (t.tgrelid,t.tgname) IN (
    (to_regclass('public.quant_jobs'),'quant_job_terminal_freeze'),(to_regclass('public.quant_jobs'),'quant_job_terminal_no_delete'),
    (to_regclass('public.quant_job_steps'),'quant_job_step_terminal_insert'),
    (to_regclass('public.quant_research_foundation'),'quant_research_binding_terminal_insert'),
    (to_regclass('public.quant_research_chunks'),'quant_research_chunk_terminal_insert'),
    (to_regclass('public.quant_research_chunks'),'quant_research_chunk_terminal_freeze'))) AS guards`);
  need(row?.present===true&&row.guards===6,'FIXED_EVAL_IMMUTABLE_AUTHORITY_REQUIRED');
  const mode=(await tx.query('SELECT mode FROM public.quant_research_executor_mode WHERE singleton FOR SHARE')).rows[0];
  need(mode?.mode==='FOUNDATION','RESEARCH_EXECUTOR_MODE_MISMATCH');
 }
 async lock(tx,owner){
  need(tx.isTransaction===true,'FIXED_EVAL_TRANSACTION_REQUIRED');
  const isolation=(await tx.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
  need(isolation==='serializable','FIXED_EVAL_TRANSACTION_REQUIRED');
  need((await tx.query('SELECT singleton FROM public.quant_foundation_scheduler FOR UPDATE')).rows.length===1,'FIXED_EVAL_AUTHORITY_UNAVAILABLE');
  await tx.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE',[owner]);
  await this.prerequisites(tx);
 }
 async parent(tx,owner,id){
  const row=(await tx.query('SELECT * FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2',[id,owner])).rows[0];
  need(!!row,'NOT_FOUND');
  need(row.status==='SUCCEEDED'&&row.contract?.mode!=='FIXED_INPUT_EVAL','FIXED_EVAL_PARENT_INELIGIBLE');
  need(hash(canonical(row.contract))===row.contract_hash);
  const c=validateResearchContractV2(row.contract);
  need(c.owner_id===owner&&c.bot_id===row.bot_id&&c.deployment_id===row.deployment_id&&c.source_hash===this.supportedSourceHash&&hash(c.source)===c.source_hash,'UNSUPPORTED_SOURCE_HASH');
  await this.pine.authorize(owner,row.bot_id);
  need(c.model.version==='paper-close-v1'&&c.model.data_profile==='closed-ohlcv-atr14-v1','FIXED_EVAL_PARENT_INELIGIBLE');
  need(c.snapshot.policy.paperTrading===true&&c.snapshot.policy.requireReduceOnlySell===true&&hash(canonical(c.snapshot.policy))===c.snapshot.policy_hash);
  need(hash(canonical({selection:c.input_lock.selection,domains:c.input_lock.domains}))===c.input_lock.lock_hash);
  need(row.result?.contract_hash===row.contract_hash&&row.result?.input_lock_hash===c.input_lock.lock_hash&&!!row.result?.selected?.parameters);
  need(c.plan.candidates.some(parameters=>same(parameters,row.result.selected.parameters)),'FIXED_EVAL_PARENT_RESULT_INVALID');
  const steps=(await tx.query('SELECT step_id,kind,parameters,result,completed_at FROM public.quant_job_steps WHERE run_id=$1 ORDER BY step_id',[id])).rows;
  need(reportMatchesCheckpoints(row.result,steps).ok===true,'FIXED_EVAL_PARENT_RESULT_INVALID');
  const binding=(await tx.query("SELECT * FROM public.quant_research_chunks WHERE run_id=$1 AND step_id='prepare:dataset'",[id])).rows[0];
  need(!!binding,'FIXED_EVAL_PARENT_RESULT_INVALID');
  validateDatasetBindingV1(c,binding.parameters);
  need(binding.kind==='PREPARE'&&binding.identity_hash===datasetBindingIdentity(c,binding.parameters)&&binding.next_bar===0&&binding.checkpoint===null&&binding.checkpoint_hash===null&&binding.unit_name===null&&binding.unit_token===null);
  need(row.result.dataset_hash===binding.parameters.dataset_sha256,'FIXED_EVAL_PARENT_RESULT_INVALID');
  const adapter=(await tx.query('SELECT b.contract_hash,f.owner_id,f.status FROM public.quant_research_foundation b JOIN public.quant_foundation_jobs f ON f.job_id=b.job_id WHERE b.run_id=$1',[id])).rows[0];
  need(adapter?.contract_hash===row.contract_hash&&adapter.owner_id===owner&&adapter.status==='SUCCEEDED');
  return {row,c,parameters:fixedEvalParametersFromParent({fixedInputs:c.input_lock.selection.fixed_inputs,selected:row.result.selected.parameters}),resultHash:hash(canonical(row.result))};
 }
 async resolve(tx,owner,body){
  const engine=await this.engineHash();
  let parent,window,expectedDatasetHash;
  if(body.purpose==='QR4_SELECTION'){
   const r=(await tx.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[body.object_id,owner])).rows[0];
   need(!!r,'NOT_FOUND');
   const raw=parse(r.body_canonical,r.registration_hash),registration={...raw,registration_hash:r.registration_hash};
   need(registrationHashOf(registration)===r.registration_hash);
   const participant=(await tx.query('SELECT * FROM public.quant_selection_participants WHERE selection_id=$1 AND export_id=$2',[body.object_id,body.participant_id])).rows[0];
   need(!!participant&&raw.participants.some(p=>p.export_id===participant.export_id&&p.run_id===participant.run_id&&p.package_hash===participant.package_hash&&p.source_hash===participant.source_hash));
   const status=(await tx.query('SELECT status FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq DESC LIMIT 1',[body.object_id])).rows[0]?.status;
   need(['SELECTION_REGISTERED','SELECTION_EVALUATING'].includes(status),'FIXED_EVAL_OBJECT_NOT_EVALUATING');
   parent=await this.parent(tx,owner,participant.run_id);
   need(parent.row.updated_at<=r.frozen_at_ms&&participant.source_hash===parent.c.source_hash);
   const x=(await tx.query('SELECT * FROM public.bi_exports WHERE export_id=$1 AND owner_id=$2',[body.participant_id,owner])).rows[0];
   need(x?.run_id===parent.row.run_id&&x.bot_id===parent.row.bot_id&&x.mode==='ONE_PINE'&&x.fixture===r.fixture&&x.package_hash===participant.package_hash);
   need(hash(canonical(x.binding))===x.binding_hash&&x.binding.contract_hash===parent.row.contract_hash&&x.binding.source_hash===parent.c.source_hash&&x.binding.library_record_ref?.result_sha256===parent.resultHash);
   need((await tx.query('SELECT status FROM public.bi_status_events WHERE export_id=$1 ORDER BY seq DESC LIMIT 1',[x.export_id])).rows[0]?.status==='EXPORT_VALIDATED');
   const validation=(await tx.query('SELECT * FROM public.ql4c_validation WHERE export_id=$1',[x.export_id])).rows[0];
   need(validation?.package_hash===x.package_hash&&validation.binding_hash===x.binding_hash&&validation.fixture===r.fixture&&validation.validated_at_utc===participant.validated_at_utc);
   const s=raw.scope,c=parent.c;
   need(s.engine===engine,'FIXED_EVAL_ENGINE_MISMATCH');
   need(s.policy.policy_hash===c.snapshot.policy_hash&&same(s.capital,{equity:decimal(c.capital.equity),cash:decimal(c.capital.cash)})&&
    same(s.data_model,dataModel(c))&&same(s.cost_model,{...costModel(c),risk_percent:decimal(c.model.risk_percent)}),'FIXED_EVAL_CONTEXT_MISMATCH');
   need(same(s.market,c.snapshot.market),'FIXED_EVAL_CONTEXT_MISMATCH');
   const freeze=(await tx.query('SELECT * FROM public.quant_selection_window_freezes WHERE selection_id=$1',[body.object_id])).rows[0];
   need(freeze&&freeze.start_ms===raw.window.start_ms&&freeze.end_ms===raw.window.end_ms&&freeze.bars_total===raw.window.total_bars);
   expectedDatasetHash=freeze.dataset_hash;window=raw.window;
  }else{
   const s=(await tx.query('SELECT * FROM public.quant_comparison_specs WHERE comparison_id=$1 AND owner_id=$2',[body.object_id,owner])).rows[0];
   need(!!s,'NOT_FOUND');const spec=parse(s.spec_canonical,s.spec_body_hash);
   need(s.mode==='STANDARDIZED'&&specHashOf(spec)===s.spec_hash&&spec.period.start_ms===s.start_ms&&spec.period.end_ms===s.end_ms);
   const event=(await tx.query('SELECT seq,status FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq DESC LIMIT 1',[body.object_id])).rows[0];
   need(['SPEC_FROZEN','EVALUATING'].includes(event?.status),'FIXED_EVAL_OBJECT_NOT_EVALUATING');
   const participants=(await tx.query('SELECT * FROM public.quant_comparison_participants WHERE comparison_id=$1 ORDER BY position',[body.object_id])).rows;
   need(same(participants.map(p=>p.participant_id).sort(),[...spec.participants].sort())&&participants.length===s.participant_count);
   let warmup=1006,common=null;
   for(const p of participants){
    const frozen=parse(p.freeze_canonical,p.freeze_hash);
    need(!!frozen.context,'FIXED_EVAL_AUTHORITY_UNAVAILABLE');
    const context=contextFields(p.participant_id,frozen.context);
    need(context.missing.length===0&&contextKey(context.fields)===p.context_key&&p.context_key===s.context_key,'FIXED_EVAL_CONTEXT_MISMATCH');
    const candidate=await this.parent(tx,owner,p.participant_id),c=candidate.c,f=context.fields;
    need(candidate.row.updated_at<=s.frozen_at_ms&&p.source_hash===c.source_hash&&p.fixture===s.fixture);
    need(f.engine===engine&&f.scope===c.scope&&same(f.market,c.snapshot.market)&&same(f.period,{start_ms:s.start_ms,end_ms:s.end_ms,evaluation_bars:(s.end_ms-s.start_ms)/MINUTE})&&f.spec_hash===s.spec_hash,'FIXED_EVAL_CONTEXT_MISMATCH');
    need(f.risk_policy===fixedEvalComparisonPolicyHash(c)&&same(f.data_model,dataModel(c))&&same(f.cost_model,costModel(c))&&
     same(f.capital,{initial_cash:decimal(c.capital.cash),initial_inventory:'0',quote:'USDT'})&&decimal(c.capital.cash)===decimal(c.capital.equity)&&f.ledger_initialization===c.ledger_initialization,'FIXED_EVAL_CONTEXT_MISMATCH');
    need(same(f.execution,{fill_model:'paper-close-v1',exit_semantics_version:'bridge-exit-v2'})&&
     same(f.valuation,{price_series:'DATASET_CLOSE',grid_id:'qr3-grid-bar-close-v1',currency:'USDT',fx:'NONE',end_treatment:'MARK_AT_END_CLOSE'})&&
     f.benchmark==='qr3-bh-close-same-cost-v1'&&f.validation_protocol===fixedEvalComparisonProtocolHash(c,spec)&&f.dataset.timestamp_semantics===TIMESTAMPS,
     'FIXED_EVAL_CONTEXT_MISMATCH');
    need(f.dataset.digest_kind==='ql3a-dataset-sha256-v1','FIXED_EVAL_AUTHORITY_UNAVAILABLE');
    need(/^[a-f0-9]{64}$/.test(f.dataset.digest),'FIXED_EVAL_CONTEXT_MISMATCH');
    need(!common||same(common,f),'FIXED_EVAL_CONTEXT_MISMATCH');common=f;
    warmup=Math.max(warmup,5*candidate.parameters.inputs.ema_slow);
    if(p.participant_id===body.participant_id)parent=candidate;
   }
   need(!!parent,'NOT_FOUND');
   window={start_ms:s.start_ms,end_ms:s.end_ms,warmup_bars:warmup};
   need(common.dataset.first_bar===s.start_ms-warmup*MINUTE+MINUTE&&common.dataset.last_bar===s.end_ms&&common.dataset.bar_count===(s.end_ms-s.start_ms)/MINUTE+warmup,'FIXED_EVAL_CONTEXT_MISMATCH');
   expectedDatasetHash=common.dataset.digest;
  }
  // Objects and exposures name OPEN-bar half-open intervals. FE2a names the corresponding CLOSED timestamps.
  // The first scored close is S + one minute and the last is E. Warm-up bars never shift the exposure window.
  const start=window.start_ms-window.warmup_bars*MINUTE+MINUTE,end=window.end_ms,count=1+(end-start)/MINUTE;
  need(Number.isSafeInteger(count)&&count<=FIXED_EVAL_LIMITS.totalBars&&end<=this.clock(),'FOUNDATION_CAPABILITY_LIMIT');
  const span=(await tx.query(CONTENT_DIGEST_SQL,[start,end,parent.c.model.data_profile])).rows[0];
  need(span?.n===count&&span.first_time===start&&span.last_time===end&&span.bad===0,'VERIFIED_MARKET_DATA_REQUIRED');
  const policy=projectFixedEvalPolicy(parent.c.snapshot.policy);
  const contract=buildFixedEvalContract({purpose:body.purpose,owner_id:owner,bot_id:parent.row.bot_id,deployment_id:parent.row.deployment_id,
   lineage:{parent_run_id:parent.row.run_id,parent_contract_hash:parent.row.contract_hash,object_id:body.object_id},engine_hash:engine,parameters:parent.parameters,
   capital:{initial_cash:decimal(parent.c.capital.cash),initial_equity:decimal(parent.c.capital.equity),initial_inventory:'0',quote:'USDT'},policy,parent_policy:parent.c.snapshot.policy,
   cost_model:{...dataModel(parent.c),...costModel(parent.c),risk_percent:decimal(parent.c.model.risk_percent)},dataset:{start_time:start,end_time:end,warmup_bars:window.warmup_bars,content_digest:span.digest},
   parent_dataset_range:{start_time:parent.c.dataset.start_time,end_time:parent.c.dataset.end_time}});
  return {body,contract,expectedDatasetHash};
 }
 async prior(tx,owner,key,body){
  const rows=(await tx.query('SELECT * FROM public.quant_jobs WHERE owner_id=$1 AND idempotency_key=$2',[owner,'fixed:'+hash(key)])).rows;
  need(rows.length<=1);const row=rows[0];if(!row)return null;
  need(row.submission_hash===hash(canonical(body)),'IDEMPOTENCY_CONFLICT');
  need(hash(canonical(row.contract))===row.contract_hash);validateFixedEvalContract(row.contract);
  return row;
 }
 /** Transaction-local only. The caller has already taken the exposure lock for QR4. Every authority is read again. */
 async enqueueLocked(tx,owner,body,key,{runId=randomUUID(),replayOnly=false}={}){
  await this.lock(tx,owner);
  const resolved=await this.resolve(tx,owner,body),old=await this.prior(tx,owner,key,body);
  if(old){
   need(same(old.contract,resolved.contract));
   const adapter=(await tx.query('SELECT b.contract_hash,f.contract,f.contract_hash AS request_hash,f.owner_id FROM public.quant_research_foundation b JOIN public.quant_foundation_jobs f ON f.job_id=b.job_id WHERE b.run_id=$1',[old.run_id])).rows[0];
   need(adapter?.contract_hash===old.contract_hash&&adapter.owner_id===owner&&hash(canonical(adapter.contract))===adapter.request_hash);
   validateFixedEvalRequest(adapter.contract,old.contract);
   if(replayOnly){
    const start=(await tx.query('SELECT * FROM public.quant_selection_evaluation_starts WHERE selection_id=$1 AND export_id=$2',[body.object_id,body.participant_id])).rows[0];
    need(start?.evaluation_run_id===old.run_id&&start.parent_run_id===old.contract.lineage.parent_run_id&&start.dataset_hash===resolved.expectedDatasetHash&&start.engine_hash===old.contract.engine_hash);
   }
   return publicJob(old);
  }
  need(!replayOnly,'FIXED_EVAL_ALREADY_STARTED');
  const existing=(await tx.query("SELECT run_id FROM public.quant_jobs WHERE owner_id=$1 AND contract->>'mode'='FIXED_INPUT_EVAL' AND contract->>'purpose'=$2 AND contract#>>'{lineage,object_id}'=$3 AND contract#>>'{lineage,parent_run_id}'=$4",[owner,body.purpose,body.object_id,resolved.contract.lineage.parent_run_id])).rows;
  need(existing.length===0,'FIXED_EVAL_ALREADY_STARTED');
  const counts=(await tx.query("SELECT count(*)::int total,count(*) FILTER(WHERE owner_id=$1)::int owned FROM public.quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED','RUNNING','STOPPING')",[owner])).rows[0];
  need(counts.total<100&&counts.owned<20,'FOUNDATION_QUEUE_FULL');
  const request=validateFixedEvalRequest(expectedFixedEvalRequest(resolved.contract,this.runtimeMs),resolved.contract),now=this.clock(),deadline=now+this.runtimeMs;
  await tx.query("INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,phase,created_at,updated_at,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED','FIXED_EVAL',$9,$9,$10)",
   [runId,owner,resolved.contract.bot_id,resolved.contract.deployment_id,'fixed:'+hash(key),hash(canonical(body)),hash(canonical(resolved.contract)),JSON.stringify(resolved.contract),now,deadline]);
  await tx.query('INSERT INTO public.quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
  await tx.query("INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)",[runId,owner,'fixed:'+runId,JSON.stringify(request),hash(canonical(request)),now,deadline]);
  await tx.query('INSERT INTO public.quant_research_foundation(run_id,job_id,contract_hash) VALUES($1,$2,$3)',[runId,runId,hash(canonical(resolved.contract))]);
  return publicJob({run_id:runId,status:'QUEUED',contract_hash:hash(canonical(resolved.contract)),contract:resolved.contract,deadline});
 }
 async enqueue(owner,body,key){
  body=this.request(body);need(typeof owner==='string'&&ID.test(owner),'NOT_FOUND');
  need(typeof key==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(key),'IDEMPOTENCY_KEY_REQUIRED');
  need(!this.db.isTransaction,'FIXED_EVAL_OWN_TRANSACTION_REQUIRED');
  const runId=randomUUID();
  if(body.purpose==='QR4_SELECTION')return startEvaluation(this.db,{owner_id:owner,selection_id:body.object_id,export_id:body.participant_id,evaluation_run_id:runId,internal:true,now:this.clock,
   admitEvaluation:(tx,{replayOnly})=>this.enqueueLocked(tx,owner,body,key,{runId,replayOnly})});
  for(let attempt=0;;attempt++)try{
   return await this.db.transaction(async()=>{
    const result=await this.enqueueLocked(this.db,owner,body,key,{runId});
    const last=(await this.db.query('SELECT seq,status FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq DESC LIMIT 1',[body.object_id])).rows[0];
    if(last.status==='SPEC_FROZEN')await this.db.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,$2,'EVALUATING')",[body.object_id,Number(last.seq)+1]);
    return result;
   },{isolation:'SERIALIZABLE'});
  }catch(error){if(error.code!=='40001'||attempt>=3)throw error;}
 }
 /** Closed read-only snapshot. Partial jobs expose status only; success requires the binding, both steps and stored closure. */
 async read(owner,runId){
  const read=async()=>{
   need((await this.db.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only==='on','FIXED_EVAL_READ_ONLY_REQUIRED');
   const resolved=await this.storedRun(owner,runId),row=resolved.row;await this.pine.authorize(owner,row.bot_id);
   if(row.status!=='SUCCEEDED')return publicJob(row);
   const chunks=(await this.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1',[runId])).rows,steps=(await this.db.query('SELECT * FROM public.quant_job_steps WHERE run_id=$1',[runId])).rows;
   const records=validateFixedEvalRecords(row.contract,{chunks,steps,evaluations_started:row.evaluations_started,run_id:runId,complete:true});
   need(records.binding.dataset_sha256===await fixedEvalArtifactSha(this.db,owner,row.contract,runId),'FIXED_EVAL_DATASET_SHA_MISMATCH');
   const result=validateFixedEvalResult(row.contract,records.binding,row.result);
   need(same(result.base,records.results.base)&&same(result.stress,records.results.stress)&&resolved.foundation.status==='SUCCEEDED'&&resolved.foundation.result?.run_id===row.run_id&&resolved.foundation.result?.result_hash===hash(canonical(result))&&resolved.foundation.result?.contract_hash===row.contract_hash,'FIXED_EVAL_RESULT_INVALID');
   return {...publicJob(row),dataset_sha_verified:true,dataset_sha256:records.binding.dataset_sha256,result};
  };
  if(this.db.isTransaction)return read();
  return this.db.transaction(async()=>{await this.db.query('SET TRANSACTION READ ONLY');return read();},{isolation:'REPEATABLE READ'});
 }
 /** Resolve worker identity from persisted rows. Stop/cancel callers use live=false so revocation cannot strand a unit.
  * The scheduler singleton is already held by the caller; this method never acquires an exposure-register lock.
  */
 async storedRun(owner,runId,{request=null,live=false}={}){
  need(this.db.isTransaction===true,'FIXED_EVAL_TRANSACTION_REQUIRED');
  let row=(await this.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2',[String(runId),owner])).rows[0];
  need(row?.contract?.mode===FIXED_EVAL_VERSIONS.mode,'NOT_FOUND');
  if(live){
   await this.db.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE',[owner]);
   if(row.bot_id!==owner)await this.db.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE',[row.bot_id]);
   row=(await this.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2 FOR UPDATE',[String(runId),owner])).rows[0];
  }
  const contract=validateFixedEvalContract(row.contract);need(hash(canonical(contract))===row.contract_hash&&contract.owner_id===owner&&contract.bot_id===row.bot_id&&contract.deployment_id===row.deployment_id);
  const adapter=(await this.db.query('SELECT b.job_id,b.contract_hash,f.owner_id,f.contract,f.contract_hash AS request_hash,f.status,f.lease_token,f.attempts,f.result FROM public.quant_research_foundation b JOIN public.quant_foundation_jobs f ON f.job_id=b.job_id WHERE b.run_id=$1',[row.run_id])).rows[0];
  need(adapter?.job_id===row.run_id&&adapter.owner_id===owner&&adapter.contract_hash===row.contract_hash&&hash(canonical(adapter.contract))===adapter.request_hash);
  validateFixedEvalRequest(adapter.contract,contract);if(request!==null)need(same(request,adapter.contract));
  const body={purpose:contract.purpose,object_id:contract.lineage.object_id,participant_id:contract.lineage.parent_run_id};
  let start=null;
  if(contract.purpose==='QR4_SELECTION'){
   start=(await this.db.query('SELECT * FROM public.quant_selection_evaluation_starts WHERE selection_id=$1 AND evaluation_run_id=$2',[body.object_id,row.run_id])).rows[0];
   need(start?.parent_run_id===contract.lineage.parent_run_id&&start.engine_hash===contract.engine_hash);
   body.participant_id=start.export_id;
  }
  this.request(body);
  if(!live)return {row,foundation:adapter,body,contract};
  need(['QUEUED','RUNNING'].includes(row.status),'FIXED_EVAL_RUN_NOT_ACTIVE');
  await this.objectFence(owner,body);
  const parent=(await this.db.query('SELECT contract FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2',[contract.lineage.parent_run_id,owner])).rows[0];
  const deployment=(await this.db.query('SELECT * FROM public.pine_deployments WHERE deployment_id=$1 AND owner_id=$2 AND bot_id=$3 FOR SHARE',[row.deployment_id,owner,row.bot_id])).rows[0];
  need(deployment?.state==='READY'&&deployment.snapshot_hash===parent?.contract?.baseline_snapshot_hash&&hash(canonical(deployment.snapshot))===deployment.snapshot_hash,'FIXED_EVAL_DEPLOYMENT_NOT_READY');
  const resolved=await this.authorize(owner,body,'RUN',{run_id:row.run_id});
  need(!start||start.dataset_hash===resolved.expectedDatasetHash);
  return {...resolved,row,foundation:adapter};
 }
 // Immutable object parents have SELECT/INSERT grants only. SERIALIZABLE supplies the adopted logical order;
 // overlapping cancellation may serialize after this fence. The next fence rereads status from a fresh transaction.
 async objectFence(){
  const isolation=(await this.db.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation;
  need(isolation==='serializable','FIXED_EVAL_TRANSACTION_REQUIRED');
 }
 async authorize(owner,body,action,{run_id:runId}={}){
  need(['ENQUEUE','CLAIM','RUN','COMMIT'].includes(action),'FIXED_EVAL_ACTION_INVALID');
  body=this.request(body);need(this.db.isTransaction===true,'FIXED_EVAL_TRANSACTION_REQUIRED');
  await this.prerequisites(this.db);
  const resolved=await this.resolve(this.db,owner,body);
  if(runId){const row=(await this.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1 AND owner_id=$2',[runId,owner])).rows[0];need(row&&hash(canonical(row.contract))===row.contract_hash&&same(row.contract,resolved.contract));}
  return resolved;
 }
 async cancel(owner,runId){
  need(!this.db.isTransaction,'FIXED_EVAL_OWN_TRANSACTION_REQUIRED');
  for(let attempt=0;;attempt++)try{return await this.db.transaction(async()=>{
   await this.db.query('SELECT singleton FROM public.quant_foundation_scheduler FOR UPDATE');
   const f=(await this.db.query('SELECT * FROM public.quant_foundation_jobs WHERE job_id=$1 FOR UPDATE',[runId])).rows[0];
   need(f?.owner_id===owner,'NOT_FOUND');const resolved=await this.storedRun(owner,runId);
   const q=(await this.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1 FOR UPDATE',[runId])).rows[0];
   if(!['QUEUED','RUNNING'].includes(q.status))return publicJob(q);
   const now=this.clock();
   if(f.status==='QUEUED'){
    const chunks=(await this.db.query('SELECT * FROM public.quant_research_chunks WHERE run_id=$1',[runId])).rows;
    need(q.status==='QUEUED'&&q.attempt===0&&chunks.length===0,'FIXED_EVAL_RECORDS_INVALID');
    await this.db.query("UPDATE public.quant_foundation_jobs SET status='CANCELLED',diagnostic='FIXED_EVAL_OWNER_CANCELLED',lease_token=NULL,lease_until=NULL WHERE job_id=$1",[runId]);
    await this.db.query("UPDATE public.quant_jobs SET status='CANCELLED',diagnostic='FIXED_EVAL_OWNER_CANCELLED',lease_token=NULL,lease_until=0,updated_at=$2 WHERE run_id=$1",[runId,now]);
    return {...publicJob(q),status:'CANCELLED'};
   }
   need(['RUNNING','STOPPING'].includes(f.status)&&!!f.lease_token,'FIXED_EVAL_RECORDS_INVALID');
   await this.db.query("UPDATE public.quant_foundation_jobs SET status='STOPPING',stop_reason='CANCELLED',diagnostic='FIXED_EVAL_OWNER_CANCELLED',lease_until=NULL,runtime_used_ms=runtime_used_ms+CASE WHEN run_started_at IS NULL THEN 0 ELSE GREATEST(0,$2-run_started_at) END,run_started_at=NULL WHERE job_id=$1",[runId,now]);
   return {...publicJob(resolved.row),status:'STOPPING'};
  },{isolation:'SERIALIZABLE'});}catch(error){if(!['40001','40P01'].includes(error?.code)||attempt>=3)throw error;}
 }
}
