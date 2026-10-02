import {fail} from '../pine-bridge/source.js';
import {LIBRARY_VERSIONS,LIBRARY_GROUPS,QUALIFIED_TOTAL,QUALIFIED_WINNER,isObject,classify,isTerminal,isCompleted,selectedOf,
  holdoutTooFewTrades,candidateAggregates,developmentScore,candidateView,selectedView,compatibilityFields,compatibilityKey,
  compatibilityMismatches,contractHashVerified,resultSha256,stepsDigest,reportMatchesCheckpoints,holdoutWindow,windowsOverlap,
  marketKey,qualification} from '../quant-library/derive.js';

/**
 * Quant Research Library (QR-1 view, minimum QR-3 comparison, QR-4 qualification presentation). Three GET routes, all
 * owner-scoped and read only: the list, one run with its provenance and read-time integrity checks, and a compatibility
 * comparison of two to four runs. Every statement runs after SET TRANSACTION READ ONLY inside the request transaction, so a
 * write or a row lock would fail loudly. Nothing is saved, started or applied here, and no executor mode is consulted: the
 * views stay readable while research admission is closed and in LEGACY or FOUNDATION mode.
 *
 * Contracts hold the Pine source and up to 10,000 market bars. They never leave the database in full: the list reads a slim
 * projection once per row, and every response is built from whitelisted fields (never source, bars, idempotency keys,
 * lease or worker fields, dataset references or policy balances).
 */
const PATH='/api/quant/library';
const DEFAULT_LIMIT=20,MAX_LIMIT=50,MAX_CANDIDATES=100,MAX_TEXT=300;
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN_ID=new RegExp('^'+UUID+'$'),CURSOR=new RegExp('^([0-9]{1,16}):('+UUID+')$'),DETAIL=new RegExp('^'+PATH+'/runs/(.+)$');
const SQLSTATE=/^[0-9A-Z]{5}$/;
// A fixed code of ours or of an existing service passes through; so does a PostgreSQL SQLSTATE error. Anything else is 503.
const appError=error=>error instanceof Error&&typeof error.code==='string'&&Number.isInteger(error.status)&&!SQLSTATE.test(error.code);
const platformError=error=>error instanceof Error&&typeof error.code==='string'&&SQLSTATE.test(error.code);
const text=(value,cap=MAX_TEXT)=>typeof value==='string'?value.slice(0,cap):null;
const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const object=value=>isObject(value)?value:{};

const PRESENT=`SELECT to_regclass('quant_jobs') IS NOT NULL AND to_regclass('quant_job_steps') IS NOT NULL AS present,
 to_regclass('quant_foundation_jobs') IS NOT NULL AND to_regclass('quant_research_foundation') IS NOT NULL
 AND to_regclass('quant_research_chunks') IS NOT NULL AS foundation`;

// One MATERIALIZED page detoasts each contract once: the slim copy drops the source, the bars and the candidate plan, and the
// outer select keeps only the fields the list reads. The result keeps everything except its candidate array, which is
// counted in one pass. Totals scan the owner's rows but read nothing from a contract.
const LIST=`WITH page AS MATERIALIZED (
 SELECT j.run_id,j.created_at,j.updated_at,j.status,j.phase,j.attempt,j.evaluations_started,j.contract_hash,j.diagnostic,
  CASE WHEN jsonb_typeof(j.contract)='object' THEN j.contract - 'source' #- '{dataset,bars}' #- '{plan,candidates}' END AS k,
  CASE WHEN jsonb_typeof(j.result)='object' THEN j.result - 'candidates' END AS r,
  (SELECT count(*)::int FROM quant_job_steps s WHERE s.run_id=j.run_id AND s.kind='CANDIDATE') AS evaluated,
  (SELECT count(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.result->'candidates')='array' THEN j.result->'candidates' ELSE '[]'::jsonb END) c
    WHERE jsonb_typeof(c->'screen_reasons')='array' AND jsonb_array_length(c->'screen_reasons')=0) AS passed
 FROM quant_jobs j WHERE j.owner_id=$1 AND ($2::bigint IS NULL OR (j.created_at,j.run_id)<($2::bigint,$3::text))
 ORDER BY j.created_at DESC,j.run_id DESC LIMIT $4)
SELECT p.run_id,p.created_at,p.updated_at,p.status,p.phase,p.attempt,p.evaluations_started,p.contract_hash,p.diagnostic,p.r,p.evaluated,p.passed,
 jsonb_build_object('version',p.k->'version','execution_backend',p.k->'execution_backend','scope',p.k->'scope','source_hash',p.k->'source_hash',
  'engine_hash',p.k->'engine_hash','snapshot',jsonb_build_object('market',p.k#>'{snapshot,market}','policy_hash',p.k#>'{snapshot,policy_hash}'),
  'model',p.k->'model','split',p.k->'split','capital',p.k->'capital','rules',p.k->'rules','ledger_initialization',p.k->'ledger_initialization',
  'acceptance_blockers',p.k->'acceptance_blockers','plan',jsonb_build_object('planned_candidates',p.k#>'{plan,planned_candidates}'),
  'dataset',p.k->'dataset','input_lock',jsonb_build_object('lock_hash',p.k#>'{input_lock,lock_hash}',
   'domains',CASE WHEN jsonb_typeof(p.k#>'{input_lock,domains}')='object' THEN (SELECT jsonb_object_agg(e.key,true) FROM jsonb_each(p.k#>'{input_lock,domains}') e) END,
   'selection',jsonb_build_object('signals',p.k#>'{input_lock,selection,signals}','fixed_inputs',p.k#>'{input_lock,selection,fixed_inputs}'))) AS c
FROM page p ORDER BY p.created_at DESC,p.run_id DESC`;
const TOTALS=`SELECT status,diagnostic,
 COALESCE(CASE WHEN jsonb_typeof(result#>'{selected,screen_reasons}')='array' THEN (result#>'{selected,screen_reasons}') ? 'INSUFFICIENT_TEST_TRADES' END,false) AS few,
 count(*)::int AS n FROM quant_jobs WHERE owner_id=$1 GROUP BY 1,2,3`;

const RUN=`SELECT run_id,bot_id,deployment_id,status,phase,created_at,updated_at,deadline,attempt,evaluations_started,contract_hash,contract,result,diagnostic
 FROM quant_jobs WHERE run_id=$1 AND owner_id=$2`;
const STEPS=`SELECT step_id,kind,parameters,result,completed_at FROM quant_job_steps WHERE run_id=$1 ORDER BY step_id COLLATE "C"`;
// The foundation row must belong to the same owner. Never the lease, the worker, the checkpoint, the contract or its dataset references.
const FOUNDATION=`SELECT f.job_id,f.status,f.attempts,f.runtime_used_ms,f.stop_reason,f.diagnostic,f.created_at,f.deadline_at,
 f.contract->'budget' AS budget,f.contract#>'{pending_dataset,metadata}' AS metadata,b.contract_hash AS binding_contract_hash
 FROM quant_research_foundation b JOIN quant_foundation_jobs f ON f.job_id=b.job_id WHERE b.run_id=$1 AND f.owner_id=$2`;
const CHUNKS=`SELECT step_id,kind,next_bar,CASE WHEN step_id='prepare:dataset' THEN jsonb_build_object('dataset_sha256',parameters->'dataset_sha256',
 'content_digest',parameters->'content_digest','bar_count',parameters->'bar_count','execution_contract_hash',parameters->'execution_contract_hash') END AS binding
 FROM quant_research_chunks WHERE run_id=$1 ORDER BY step_id COLLATE "C"`;
// Earlier runs of the same owner that evaluated a holdout. The slim contract is read once per matching row.
const EARLIER=`WITH earlier AS MATERIALIZED (SELECT j.run_id,j.created_at,
 CASE WHEN jsonb_typeof(j.contract)='object' THEN j.contract - 'source' #- '{dataset,bars}' #- '{plan,candidates}' END AS k
 FROM quant_jobs j WHERE j.owner_id=$1 AND j.run_id<>$2 AND (j.created_at,j.run_id)<($3::bigint,$2::text) AND j.result->'holdout_evaluated'='true'::jsonb)
 SELECT run_id,k#>'{snapshot,market}' AS market,k->'split' AS split,k#>'{dataset,start_time}' AS start_time FROM earlier ORDER BY created_at,run_id`;

const emptyTotals=()=>({all:0,...Object.fromEntries(LIBRARY_GROUPS.map(group=>[group,0]))});
const familyOf=c=>c.execution_backend==='quant-foundation-v1'||c.version==='ql3a-research-job-v2'?'FOUNDATION':c.version==='ql3a-research-job-v1'?'LEGACY':null;
const marketOf=c=>{const m=object(object(c.snapshot).market);return text(m.broker)&&text(m.symbol)&&text(m.timeframe)?{broker:m.broker,symbol:m.symbol,timeframe:m.timeframe}:null;};
const datasetOf=fields=>isObject(fields.dataset)?{start_time:fields.dataset.start_time,end_time:fields.dataset.end_time,warmup_bars:fields.dataset.warmup_bars,
  bar_count:fields.dataset.bar_count,digest_kind:text(fields.dataset.digest_kind),digest:text(fields.dataset.digest,128)}:null;
const plain=value=>typeof value==='string'?value.slice(0,120):typeof value==='boolean'?value:finite(value);
const finishedAt=row=>isTerminal(row.status)?row.updated_at:null;

function shapeListRow(row){
  const c=object(row.c),r=isObject(row.r)?row.r:null;
  const {library_class,library_group}=classify({status:row.status,diagnostic:row.diagnostic,holdoutTooFewTrades:holdoutTooFewTrades(r)});
  const {fields}=compatibilityFields(row.run_id,c);
  const quality=qualification({status:row.status,result:r,blockers:c.acceptance_blockers});
  return {run_id:row.run_id,created_at:row.created_at,finished_at:finishedAt(row),status:row.status,phase:text(row.phase,64),library_class,library_group,
    completion_reason:text(r?.completion_reason,64),diagnostic:text(row.diagnostic,120),contract_version:text(c.version,64),engine_family:familyOf(c),
    market:marketOf(c),dataset:datasetOf(fields),source_hash:text(c.source_hash,128),input_lock_hash:text(object(c.input_lock).lock_hash,128),
    engine_hash:text(c.engine_hash,128),policy_hash:text(object(c.snapshot).policy_hash,128),
    cost:{fee_bps:plain(object(c.model).fee_bps),slippage_bps:plain(object(c.model).slippage_bps)},
    candidates:{planned:count(object(c.plan).planned_candidates),evaluated:row.evaluated,screen_passed:r?row.passed:null},
    development_score:developmentScore({status:row.status,result:r}),qualification:{qualified:quality.qualified,label:quality.label},
    integrity_checked:false,compatibility_key:compatibilityKey(fields).slice(0,12)};
}

const list=(value,cap)=>Array.isArray(value)?value.slice(0,cap):[];
const strings=(value,names)=>isObject(value)?Object.fromEntries(names.map(name=>[name,plain(value[name])])):null;
const bindingOf=item=>({slot:count(item.slot),input_id:text(item.input_id,64),pine_variable:text(item.pine_variable,100),effective_value:plain(item.effective_value),
  search_domain:strings(item.search_domain,['min','max','step'])});
const fixedOf=item=>({input_id:text(item.input_id,64),pine_variable:text(item.pine_variable,100),effective_value:plain(item.effective_value),type:text(item.type,32)});
const domainOf=([dimension,values])=>{
  const numbers=Array.isArray(values)?values.filter(item=>finite(item)!==null):[];
  return {dimension:dimension.slice(0,100),count:numbers.length,min:numbers.length?Math.min(...numbers):null,max:numbers.length?Math.max(...numbers):null};
};
function foundationOf(found,chunks){
  if(!found)return null;
  const binding=chunks.find(chunk=>chunk.step_id==='prepare:dataset')?.binding,budget=object(found.budget),meta=object(found.metadata);
  return {job_id:found.job_id,status:text(found.status,32),attempts:count(found.attempts),runtime_used_ms:count(found.runtime_used_ms),stop_reason:text(found.stop_reason,32),
    diagnostic:text(found.diagnostic,120),created_at:found.created_at,deadline_at:found.deadline_at,
    budget:strings(budget,['candidates','max_evaluations','chunk_bars','max_runtime_ms','max_output_bytes','max_state_bytes']),
    dataset_metadata:strings(meta,['venue','market','symbol','timeframe','cutoff','source']),
    dataset_binding:binding?strings(binding,['dataset_sha256','content_digest','bar_count','execution_contract_hash']):null,
    chunk_rows:chunks.filter(chunk=>chunk.step_id!=='prepare:dataset').length};
}
function provenanceOf(contract,fields,found,chunks){
  const c=object(contract),snap=object(c.snapshot),lock=object(c.input_lock),selection=object(lock.selection),dataset=object(c.dataset),model=object(c.model),plan=object(c.plan);
  const metadata=found?object(found.metadata):{},foundation=foundationOf(found,chunks);
  return {
    source:{scope:text(c.scope),source_hash:text(c.source_hash,128),baseline_snapshot_hash:text(c.baseline_snapshot_hash,128),pine_import_id:text(c.pine_import_id,64),
      source_version:count(c.source_version),membership:list(snap.membership,10).filter(isObject).map(item=>({pine_import_id:text(item.pine_import_id,64),
        source_version:count(item.source_version),source_hash:text(item.source_hash,128)}))},
    input:{lock_hash:text(lock.lock_hash,128),signals:strings(selection.signals,['buy','exit','timing']),bridge:strings(selection.bridge,['atr_multiplier','rr']),
      bindings:list(selection.bindings,10).filter(isObject).map(bindingOf),fixed_inputs_count:Array.isArray(selection.fixed_inputs)?selection.fixed_inputs.length:null,
      fixed_inputs:list(selection.fixed_inputs,100).filter(isObject).map(fixedOf),
      domains:isObject(lock.domains)?Object.entries(lock.domains).sort(([a],[b])=>a<b?-1:a>b?1:0).slice(0,20).map(domainOf):[],
      search:strings(plan,['algorithm','seed','requested_budget','planned_candidates','grid_combinations'])},
    dataset:{market:marketOf(c),start_time:finite(dataset.start_time),end_time:finite(dataset.end_time),warmup_bars:finite(dataset.warmup_bars),bar_count:finite(dataset.bar_count),
      digest_kind:datasetOf(fields)?.digest_kind??null,digest:datasetOf(fields)?.digest??null,timestamp_semantics:text(dataset.timestamp_semantics),
      collection_cutoff:finite(metadata.cutoff)??null,collection_source:text(metadata.source,64),
      binding_sha256:foundation?.dataset_binding?.dataset_sha256??null},
    engine:{engine_hash:text(c.engine_hash,128),engine_family:familyOf(c),execution_backend:text(c.execution_backend,64),contract_version:text(c.version,64)},
    cost_policy:{model:strings(model,['version','fee_bps','slippage_bps','risk_percent','data_profile','price_tick','quantity_step']),
      cost_stress:'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE',policy_hash:text(snap.policy_hash,128),capital:strings(c.capital,['equity','cash']),
      ledger_initialization:text(c.ledger_initialization,300)},
    validation:{split:strings(c.split,['warmup','train_end','validation_end','test_end']),
      rules:strings(c.rules,['minimum_closed_trades_train','minimum_closed_trades_validation','minimum_closed_trades_test','maximum_drawdown_percent','sensitivity_max_drop_percentage_points']),
      max_evaluations:count(c.max_evaluations),acceptance_blockers:list(c.acceptance_blockers,20).filter(item=>typeof item==='string').map(item=>item.slice(0,100)),
      holdout_window:holdoutWindow(c)},
    foundation};
}
const GAP_BLOCKERS=['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED'];
function limitationsOf(c,row,found){
  const blockers=list(c.acceptance_blockers,20).filter(item=>typeof item==='string');
  const gaps=[];
  if(!text(c.effective_inputs_hash))gaps.push('NO_EFFECTIVE_INPUT_REVIEW_HASH');
  gaps.push('ENGINE_RELEASE_UNKNOWN');
  if(!found||!finite(object(found.metadata).cutoff))gaps.push('NO_DATA_COLLECTION_TIMESTAMP');
  if(blockers.some(item=>GAP_BLOCKERS.includes(item)))gaps.push('NO_PARITY_REPAINT_EVIDENCE');
  if(isTerminal(row.status))gaps.push('NO_IMMUTABLE_FINISH_TIME','RESULT_NOT_DB_FROZEN');
  gaps.push('NO_BENCHMARK_OR_COMPARISON_OBJECTIVE');
  return {provenance_gaps:gaps,acceptance_blockers:blockers.map(item=>item.slice(0,100))};
}

const OBJECTIVE=Object.freeze({rule:'VALIDATION_NET_RETURN_THEN_DRAWDOWN_THEN_PARAMETERS',fixed_before_run:true,source:'ENGINE_CODE'});
/** Everything derived from one stored run, its checkpoints and its foundation facts. */
function analyse(row,steps,found,chunks){
  const contract=row.contract,c=object(contract),result=isObject(row.result)?row.result:null;
  const hashVerified=contractHashVerified(contract,row.contract_hash),match=reportMatchesCheckpoints(result,steps),digest=stepsDigest(steps);
  const bindingMatches=found?found.binding_contract_hash===row.contract_hash:null;
  const warnings=[];
  if(!hashVerified)warnings.push('CONTRACT_HASH_MISMATCH');
  if(match.ok===false)warnings.push('CHECKPOINT_MISMATCH');
  if(bindingMatches===false)warnings.push('FOUNDATION_BINDING_MISMATCH');
  const integrity={contract_hash:row.contract_hash,contract_hash_verified:hashVerified,result_sha256:resultSha256(row.result),...digest,
    report_matches_checkpoints:match.ok,checkpoint_problems:match.problems,foundation_binding_matches:bindingMatches,
    identity_protection:'DB_TRIGGER',result_protection:'APPLICATION_ONLY',warnings};
  const {fields,missing:missingFields}=compatibilityFields(row.run_id,contract);
  const failed=warnings.length>0;
  return {row,c,result,steps,found,chunks,integrity,failed,fields,missingFields,key:compatibilityKey(fields),
    cls:classify({status:row.status,diagnostic:row.diagnostic,holdoutTooFewTrades:holdoutTooFewTrades(result)}),
    score:developmentScore({status:row.status,result,integrityFailed:failed}),
    gateInput:{status:row.status,result,blockers:c.acceptance_blockers,integrity:{contract_hash_verified:hashVerified&&bindingMatches!==false,report_matches_checkpoints:match.ok}}};
}
function completenessOf(a){
  const {row,c,result,found,chunks,steps}=a,v2=familyOf(c)==='FOUNDATION',missing=[];
  if(isCompleted(row.status)&&result===null)missing.push('NO_RESULT');
  if(v2&&!found)missing.push('NO_FOUNDATION_ROW');
  if(v2&&isCompleted(row.status)&&!chunks.some(chunk=>chunk.step_id==='prepare:dataset'))missing.push('NO_DATASET_BINDING');
  return {result_present:result!==null,candidates_planned:count(object(c.plan).planned_candidates),
    candidates_recorded:steps.filter(step=>step.kind==='CANDIDATE').length,holdout_evaluated:result?result.holdout_evaluated===true:null,missing};
}
function evaluationOf(a){
  const {result}=a,list=Array.isArray(result?.candidates)?result.candidates.slice(0,MAX_CANDIDATES):[];
  const aggregate=candidateAggregates(result?.candidates);
  return {objective:OBJECTIVE,completion_reason:text(result?.completion_reason,64),holdout_evaluated:result?result.holdout_evaluated===true:null,
    dimension_coverage_percent:finite(result?.dimension_coverage_percent),candidate_count:result?aggregate.candidate_count:null,
    screen_passed:result?aggregate.screen_passed:null,reason_counts:result?aggregate.reason_counts:null,development_score:a.score,
    selected:selectedView(selectedOf(result)),candidates:list.map(candidateView),
    candidates_truncated:Array.isArray(result?.candidates)&&result.candidates.length>MAX_CANDIDATES,stored_values_verified:!a.failed};
}
function shapeDetail(a,quality,overlap){
  const {row,c}=a;
  return {version:LIBRARY_VERSIONS.run,qualified_total:QUALIFIED_TOTAL,qualified_winner:QUALIFIED_WINNER,
    run:{run_id:row.run_id,created_at:row.created_at,finished_at:finishedAt(row),status:row.status,phase:text(row.phase,64),library_class:a.cls.library_class,
      library_group:a.cls.library_group,completion_reason:text(a.result?.completion_reason,64),diagnostic:text(row.diagnostic,120),
      contract_version:text(c.version,64),engine_family:familyOf(c),bot_id:row.bot_id,deployment_id:row.deployment_id,attempts:row.attempt,
      evaluations_started:row.evaluations_started,deadline:row.deadline},
    provenance:provenanceOf(a.row.contract,a.fields,a.found,a.chunks),integrity:a.integrity,completeness:completenessOf(a),
    limitations:limitationsOf(c,row,a.found),evaluation:evaluationOf(a),
    qualification:{...quality,holdout_overlap:overlap},
    compatibility:{version:LIBRARY_VERSIONS.compatibility,key:a.key,short_key:a.key.slice(0,12),fields:a.fields,missing:a.missingFields}};
}

const searchOf=c=>strings(object(c.plan),['algorithm','seed','requested_budget','planned_candidates','grid_combinations']);
function compareRun(a,quality,compatible){
  const {row,c}=a,base={run_id:row.run_id,created_at:row.created_at,finished_at:finishedAt(row),status:row.status,library_class:a.cls.library_class,
    library_group:a.cls.library_group,completion_reason:text(a.result?.completion_reason,64),diagnostic:text(row.diagnostic,120),engine_family:familyOf(c),
    qualification:{qualified:quality.qualified,label:quality.label},compatibility_key:a.key.slice(0,12)};
  if(!compatible)return base;
  const aggregate=candidateAggregates(a.result?.candidates),evaluated=isCompleted(row.status)&&a.result!==null;
  const selected=selectedOf(a.result),view=selectedView(selected);
  return {...base,disclosed:{bot_id:row.bot_id,deployment_id:row.deployment_id,baseline_snapshot_hash:text(c.baseline_snapshot_hash,128),search:searchOf(c),
      domains:isObject(object(c.input_lock).domains)?Object.entries(c.input_lock.domains).sort(([x],[y])=>x<y?-1:x>y?1:0).slice(0,20).map(domainOf):[]},
    metrics:evaluated?{candidates:{planned:count(object(c.plan).planned_candidates),evaluated:a.steps.filter(step=>step.kind==='CANDIDATE').length,
      screen_passed:aggregate.screen_passed},reason_counts:aggregate.reason_counts,development_score:a.score,
      selected:a.failed||!view?null:{parameters:view.parameters,train:view.train,validation:view.validation}}:null,
    metrics_reason:evaluated?null:a.score.reason};
}

export class QuantLibraryService{
  constructor(db,{admissionEnabled=false}={}){
    if(!db||typeof db.query!=='function'||typeof db.transaction!=='function')throw fail('QUANT_LIBRARY_CONFIGURATION_INVALID',500);
    this.db=db;this.admission=admissionEnabled===true;
  }
  /** Every read runs after SET TRANSACTION READ ONLY. A fixed code or a SQLSTATE error passes through unchanged. */
  async read(callback){
    const {db}=this;
    try{
      return await db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');return callback();},{isolation:'REPEATABLE READ'});
    }catch(error){
      if(appError(error)||platformError(error))throw error;
      throw fail('QUANT_LIBRARY_UNAVAILABLE',503);
    }
  }
  async totals(owner){
    const totals=emptyTotals();
    for(const row of (await this.db.query(TOTALS,[owner])).rows){
      const {library_group}=classify({status:row.status,diagnostic:row.diagnostic,holdoutTooFewTrades:row.few===true});
      totals[library_group]+=row.n;totals.all+=row.n;
    }
    return totals;
  }
  list(owner,{limit=DEFAULT_LIMIT,before=null}={}){
    return this.read(async()=>{
      const flags=(await this.db.query(PRESENT)).rows[0];
      const body={version:LIBRARY_VERSIONS.list,rules:{classes:LIBRARY_VERSIONS.classes,compatibility:LIBRARY_VERSIONS.compatibility,qualification:LIBRARY_VERSIONS.qualification},
        schema_present:flags.present===true,admission_enabled:this.admission,totals:emptyTotals(),qualified_total:QUALIFIED_TOTAL,qualified_winner:QUALIFIED_WINNER,next_before:null,runs:[]};
      if(!flags.present)return body;
      body.totals=await this.totals(owner);
      const rows=(await this.db.query(LIST,[owner,before?before.created_at:null,before?before.run_id:null,limit+1])).rows;
      const page=rows.slice(0,limit);
      body.runs=page.map(shapeListRow);
      body.next_before=rows.length>limit?page.at(-1).created_at+':'+page.at(-1).run_id:null;
      return body;
    });
  }
  /** One run with its steps, foundation facts and the holdout independence lookup, or NOT_FOUND (absent and foreign alike). */
  async load(owner,runId,flags){
    const row=(await this.db.query(RUN,[runId,owner])).rows[0];
    if(!row)throw fail('NOT_FOUND',404);
    const steps=(await this.db.query(STEPS,[runId])).rows;
    const found=flags.foundation?(await this.db.query(FOUNDATION,[runId,owner])).rows[0]??null:null;
    // The chunk rows belong to the run, which is already owner-scoped; only the foundation job row needs the owner join.
    const chunks=flags.foundation?(await this.db.query(CHUNKS,[runId])).rows:[];
    const a=analyse(row,steps,found,chunks);
    let quality=qualification(a.gateInput),overlap={checked:false,overlaps:null,run_ids:[]};
    if(quality.gates.slice(0,4).every(gate=>gate.state==='PASS')){
      const own=holdoutWindow(a.c),market=marketKey(a.c);
      if(own&&market){
        const ids=(await this.db.query(EARLIER,[owner,runId,row.created_at])).rows.filter(other=>{
          const shape={snapshot:{market:other.market},split:other.split,dataset:{start_time:other.start_time}},key=marketKey(shape),window=holdoutWindow(shape);
          return (key===null||key===market)&&(window===null||windowsOverlap(own,window));
        }).map(other=>other.run_id);
        overlap={checked:true,overlaps:ids.length>0,run_ids:ids.slice(0,20)};
        quality=qualification({...a.gateInput,holdoutOverlap:{overlaps:overlap.overlaps}});
      }else quality=qualification({...a.gateInput,holdoutOverlap:null});
    }
    return {a,quality,overlap};
  }
  detail(owner,runId){
    return this.read(async()=>{
      const flags=(await this.db.query(PRESENT)).rows[0];
      if(!flags.present)throw fail('NOT_FOUND',404);
      const {a,quality,overlap}=await this.load(owner,runId,flags);
      return shapeDetail(a,quality,overlap);
    });
  }
  compare(owner,runIds){
    return this.read(async()=>{
      const flags=(await this.db.query(PRESENT)).rows[0];
      if(!flags.present)throw fail('NOT_FOUND',404);
      const loaded=[];
      for(const id of runIds)loaded.push(await this.load(owner,id,flags));
      loaded.sort((x,y)=>x.a.row.created_at-y.a.row.created_at||(x.a.row.run_id<y.a.row.run_id?-1:1));
      const mismatches=compatibilityMismatches(loaded.map(item=>({run_id:item.a.row.run_id,fields:item.a.fields})));
      const compatible=mismatches.length===0;
      return {version:LIBRARY_VERSIONS.compare,verdict:compatible?'COMPATIBLE':'INCOMPATIBLE',rules:{compatibility:LIBRARY_VERSIONS.compatibility,qualification:LIBRARY_VERSIONS.qualification},
        mismatches,qualified_total:QUALIFIED_TOTAL,qualified_winner:QUALIFIED_WINNER,runs:loaded.map(item=>compareRun(item.a,item.quality,compatible))};
    });
  }
}

// bot_id is sent by the shared api() helper. The library is owner-scoped, so the value is ignored. Any other key, and any
// repeated key (except run_id on the compare route), is refused before anything is read.
function checkedQuery(url,allowed,repeatable=[]){
  const seen=new Set();
  for(const key of url.searchParams.keys()){
    if(!allowed.includes(key)||(seen.has(key)&&!repeatable.includes(key)))throw fail('INVALID_FIELDS');
    seen.add(key);
  }
}
function listQuery(url){
  checkedQuery(url,['limit','before','bot_id']);
  let limit=DEFAULT_LIMIT,before=null;
  if(url.searchParams.has('limit')){
    const value=url.searchParams.get('limit');
    if(!/^[0-9]{1,3}$/.test(value)||Number(value)<1||Number(value)>MAX_LIMIT)throw fail('INVALID_LIMIT');
    limit=Number(value);
  }
  if(url.searchParams.has('before')){
    const match=CURSOR.exec(url.searchParams.get('before'));
    if(!match||!Number.isSafeInteger(Number(match[1])))throw fail('INVALID_CURSOR');
    before={created_at:Number(match[1]),run_id:match[2]};
  }
  return {limit,before};
}
function compareQuery(url){
  checkedQuery(url,['run_id','bot_id'],['run_id']);
  const ids=url.searchParams.getAll('run_id');
  if(ids.some(id=>!RUN_ID.test(id)))throw fail('INVALID_RUN_ID');
  if(ids.length<2||ids.length>4)throw fail('COMPARE_RUN_COUNT');
  if(new Set(ids).size!==ids.length)throw fail('DUPLICATE_RUN_ID');
  return ids;
}

export async function quantLibraryRoutes(req,res,url,actor,db,json,{admissionEnabled=false}={}){
  const path=url.pathname;
  if(path!==PATH&&!path.startsWith(PATH+'/'))return false;
  if(req.method!=='GET')throw fail('METHOD_NOT_ALLOWED',405);
  const service=new QuantLibraryService(db,{admissionEnabled});
  if(path===PATH){json(res,200,await service.list(actor.id,listQuery(url)));return true;}
  if(path===PATH+'/compare'){json(res,200,await service.compare(actor.id,compareQuery(url)));return true;}
  const match=DETAIL.exec(path);
  if(match&&RUN_ID.test(match[1])){
    checkedQuery(url,['bot_id']);
    json(res,200,await service.detail(actor.id,match[1]));
    return true;
  }
  throw fail('NOT_FOUND',404);
}
