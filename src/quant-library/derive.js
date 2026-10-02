import {canonical,hash} from '../pine-bridge/source.js';

/**
 * Pure derivation layer of the Quant Research Library (QR-1 view, minimum QR-3 comparison, QR-4 qualification
 * presentation). It reads no database, no file, no clock and no random source. Every input is a plain value that a
 * caller took from the durable research rows; every output is a whitelisted plain value. Raw status, completion
 * reason and diagnostic stay with the caller and are always shown next to the derived class.
 *
 * Rule sets are versioned. The class and compatibility rules, the 13 hard compatibility fields and the 8 qualification
 * gates are fixed here, never chosen after a result is seen. Gate G8 (an accepted QL-4C validation record) has no
 * source in this release, so no run can be qualified and no view may name a winner.
 */
export const LIBRARY_VERSIONS=Object.freeze({list:'quant-library-v1',run:'quant-library-run-v1',compare:'quant-library-compare-v1',
  classes:'library-class-v1',compatibility:'library-compat-v1',qualification:'library-qualification-v1'});
export const LIBRARY_GROUPS=Object.freeze(['ACTIVE','COMPLETED','INSUFFICIENT','FAILED','CANCELLED']);
export const LIBRARY_CLASSES=Object.freeze({IN_PROGRESS:'ACTIVE',CANCELLED:'CANCELLED',TIMED_OUT:'FAILED',INSUFFICIENT_DATA:'INSUFFICIENT',
  FAILED:'FAILED',CANDIDATE_PENDING_ACCEPTANCE:'COMPLETED',INSUFFICIENT_EVIDENCE:'INSUFFICIENT',NO_VALID_CANDIDATE:'COMPLETED'});
/** No view applies a best, top or winner label. This stays zero and null while gate G8 cannot pass. */
export const QUALIFIED_TOTAL=0;
export const QUALIFIED_WINNER=null;
export const MINUTE=60000;

const DATA_DIAGNOSTICS=new Set(['INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET','VERIFIED_MARKET_DATA_REQUIRED','MARKET_METADATA_MISMATCH']);
const COMPLETED=new Set(['SUCCEEDED','NO_VALID_CANDIDATE']);
const METRIC_KEYS=['bars','closed_trades','start_equity','end_equity','net_return_percent','max_drawdown_percent','profit_factor','gross_profit','gross_loss'];

export const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const present=value=>value!==undefined&&value!==null;
const sameJson=(a,b)=>canonical(a)===canonical(b);
const sortedObject=map=>Object.fromEntries(Object.entries(map).sort(([a],[b])=>a<b?-1:a>b?1:0));
const scalar=value=>typeof value==='string'?value.slice(0,120):typeof value==='boolean'?value:typeof value==='number'&&Number.isFinite(value)?value:null;
const code=value=>typeof value==='string'?value.slice(0,64):null;

/** First match wins (library-class-v1). holdoutTooFewTrades is true when the selected candidate's screen reasons hold
 * INSUFFICIENT_TEST_TRADES. A NO_VALID_CANDIDATE run whose candidates all failed the train or validation sample size
 * stays NO_VALID_CANDIDATE in the COMPLETED group: the sample shortfall is shown as reason counts, never as a class. */
export function classify({status,diagnostic=null,holdoutTooFewTrades=false}={}){
  let cls;
  if(status==='QUEUED'||status==='RUNNING')cls='IN_PROGRESS';
  else if(status==='CANCELLED')cls='CANCELLED';
  else if(status==='TIMED_OUT')cls='TIMED_OUT';
  else if(status==='FAILED')cls=DATA_DIAGNOSTICS.has(diagnostic)?'INSUFFICIENT_DATA':'FAILED';
  else if(status==='SUCCEEDED')cls='CANDIDATE_PENDING_ACCEPTANCE';
  else if(status==='NO_VALID_CANDIDATE')cls=holdoutTooFewTrades===true?'INSUFFICIENT_EVIDENCE':'NO_VALID_CANDIDATE';
  else cls='FAILED';
  return {library_class:cls,library_group:LIBRARY_CLASSES[cls]};
}
export const isTerminal=status=>COMPLETED.has(status)||status==='FAILED'||status==='CANCELLED'||status==='TIMED_OUT';
export const isCompleted=status=>COMPLETED.has(status);

/** The selected candidate of a stored result: an object, or null. */
export const selectedOf=result=>isObject(result)&&isObject(result.selected)?result.selected:null;
export const selectedReasons=result=>{
  const selected=selectedOf(result);
  return selected&&Array.isArray(selected.screen_reasons)?selected.screen_reasons.filter(item=>typeof item==='string').map(item=>item.slice(0,64)).slice(0,20):[];
};
export const holdoutTooFewTrades=result=>selectedReasons(result).includes('INSUFFICIENT_TEST_TRADES');

/** Counts over the stored candidates. A candidate passed screening when its reason list is an empty array. */
export function candidateAggregates(candidates){
  const list=Array.isArray(candidates)?candidates:[],reasons={};
  let passed=0;
  for(const item of list){
    const reasonList=isObject(item)&&Array.isArray(item.screen_reasons)?item.screen_reasons:null;
    if(reasonList&&reasonList.length===0)passed++;
    for(const reason of reasonList??[])if(typeof reason==='string'){const key=reason.slice(0,64);reasons[key]=(reasons[key]??0)+1;}
  }
  return {candidate_count:list.length,screen_passed:passed,reason_counts:sortedObject(reasons)};
}

/** The development score is the stored validation net return of the engine-selected candidate, kept as the stored decimal
 * string. It is in-sample selection, never a recommendation. A candidate that failed screening never supplies a score; an
 * absent score is null with a reason code and never becomes zero. */
export const SCORE_BASIS='VALIDATION_NET_RETURN_PERCENT';
export function developmentScore({status,result,integrityFailed=false}={}){
  const none=reason=>({value:null,basis:SCORE_BASIS,reason});
  if(!isCompleted(status))return none('NOT_EVALUATED');
  if(!isObject(result))return none('NO_RESULT');
  if(integrityFailed)return none('INTEGRITY_CHECK_FAILED');
  const selected=selectedOf(result);
  if(!selected)return none('NO_SCREENED_CANDIDATE');
  const value=selected.result?.validation?.net_return_percent;
  if(typeof value==='string'&&value.length>0&&value.length<=120)return {value,basis:SCORE_BASIS,reason:null};
  if(typeof value==='number'&&Number.isFinite(value))return {value:String(value),basis:SCORE_BASIS,reason:null};
  return none('SCORE_NOT_RECORDED');
}

/** Whitelisted views. Metrics keep their stored decimal strings; an absent key stays absent. */
export function metrics(value){
  if(!isObject(value))return null;
  const out={};
  for(const key of METRIC_KEYS)if(Object.hasOwn(value,key))out[key]=value[key]===null?null:scalar(value[key]);
  return out;
}
export function parametersOf(value){
  if(!isObject(value))return null;
  const out={};
  for(const [key,item] of Object.entries(value).slice(0,24))out[key.slice(0,64)]=scalar(item);
  return out;
}
const reasonsOf=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').map(item=>item.slice(0,64)).slice(0,20):[];
export function candidateView(item,index){
  const source=isObject(item)?item:{},result=isObject(source.result)?source.result:{};
  return {index,parameters:parametersOf(source.parameters),train:metrics(result.train),validation:metrics(result.validation),screen_reasons:reasonsOf(source.screen_reasons)};
}
export function selectedView(selected){
  if(!isObject(selected))return null;
  const result=isObject(selected.result)?selected.result:{},stress=isObject(selected.cost_stress)?selected.cost_stress:null;
  return {parameters:parametersOf(selected.parameters),train:metrics(result.train),validation:metrics(result.validation),
    screen_reasons:reasonsOf(selected.screen_reasons),
    sensitivity:(Array.isArray(selected.sensitivity)?selected.sensitivity:[]).slice(0,40).filter(isObject).map(item=>({dimension:code(item.dimension),
      parameters:parametersOf(item.parameters),train:metrics(item.result?.train),validation:metrics(item.result?.validation)})),
    cost_stress:stress?{train:metrics(stress.train),validation:metrics(stress.validation)}:null,
    test:isObject(selected.test)?metrics(selected.test):null};
}

/** library-compat-v1: 13 hard context fields. Runs are comparable only when every field is equal. A field that cannot be
 * read gets a value that is unique to the run, so a malformed run is never comparable. The search configuration (domains,
 * seed, budget, algorithm, planned candidates), the Bot, the deployment, the baseline snapshot and the creation time may
 * differ and are what a comparison compares. */
export const COMPATIBILITY_FIELDS=Object.freeze(['scope','market','data_model','dataset','split','engine','source','fixed_strategy',
  'dimension_set','cost_model','capital','policy','validation_protocol']);
const DATASET_V1_KIND='ql3a-dataset-sha256-v1';
const text=value=>typeof value==='string'&&value.length>0?value:null;
function pick(source,names){
  if(!isObject(source))return null;
  const out={};
  for(const name of names){if(!present(source[name]))return null;out[name]=source[name];}
  return out;
}
function datasetField(dataset){
  if(!isObject(dataset))return null;
  const base=pick(dataset,['start_time','end_time','warmup_bars','bar_count']);
  if(!base)return null;
  if(text(dataset.content_digest))return text(dataset.digest_version)?{digest_kind:dataset.digest_version,digest:dataset.content_digest,...base}:null;
  return text(dataset.sha256)?{digest_kind:DATASET_V1_KIND,digest:dataset.sha256,...base}:null;
}
const fixedStrategy=lock=>{
  const selection=lock?.selection;
  return isObject(selection)&&isObject(selection.signals)&&Array.isArray(selection.fixed_inputs)?hash(canonical({signals:selection.signals,fixed_inputs:selection.fixed_inputs})):null;
};
const dimensionSet=lock=>{
  const names=isObject(lock?.domains)?Object.keys(lock.domains).sort():[];
  return names.length?names:null;
};
export function compatibilityFields(runId,contract){
  const c=isObject(contract)?contract:{};
  const raw={scope:text(c.scope),market:pick(c.snapshot?.market,['broker','symbol','timeframe']),
    data_model:pick(c.model,['data_profile','price_tick','quantity_step']),dataset:datasetField(c.dataset),
    split:pick(c.split,['warmup','train_end','validation_end','test_end']),engine:text(c.engine_hash),source:text(c.source_hash),
    fixed_strategy:fixedStrategy(c.input_lock),dimension_set:dimensionSet(c.input_lock),
    cost_model:pick(c.model,['version','fee_bps','slippage_bps','risk_percent']),capital:pick(c.capital,['equity','cash']),
    policy:text(c.snapshot?.policy_hash),
    validation_protocol:isObject(c.rules)&&text(c.ledger_initialization)?hash(canonical({rules:c.rules,ledger_initialization:c.ledger_initialization})):null};
  const fields={},missing=[];
  for(const name of COMPATIBILITY_FIELDS){
    if(raw[name]===null){fields[name]='MISSING:'+runId;missing.push(name);}else fields[name]=raw[name];
  }
  return {fields,missing};
}
export const compatibilityKey=fields=>hash(canonical({version:LIBRARY_VERSIONS.compatibility,...fields}));
const shortValue=value=>(typeof value==='string'?value:canonical(value)).slice(0,300);
/** The hard fields whose values are not equal in every run, with the value of each run. */
export function compatibilityMismatches(runs){
  const mismatches=[];
  for(const field of COMPATIBILITY_FIELDS){
    const first=canonical(runs[0].fields[field]);
    if(runs.some(run=>canonical(run.fields[field])!==first))mismatches.push({field,values:runs.map(run=>({run_id:run.run_id,value:shortValue(run.fields[field])}))});
  }
  return mismatches;
}

/** Read-time integrity of one run. The checkpoints of quant_job_steps are append-only in the database; the stored result
 * and diagnostic are not frozen by it, so the report is cross-checked against the checkpoints. A failed check never raises
 * an error: the caller shows a warning and gate G1 fails. */
export const contractHashVerified=(contract,expected)=>typeof expected==='string'&&hash(canonical(contract))===expected;
export const resultSha256=result=>present(result)?hash(canonical(result)):null;
const byStepId=(a,b)=>a.step_id<b.step_id?-1:a.step_id>b.step_id?1:0;
export function stepsDigest(steps){
  const ordered=[...steps].sort(byStepId);
  return {steps_count:ordered.length,steps_digest:hash(canonical(ordered.map(step=>[step.step_id,step.kind,step.completed_at,
    hash(canonical(step.parameters)),hash(canonical(step.result))])))};
}
/** Every candidate, the selected candidate, the sensitivity checks, the cost stress and the holdout of the report must be
 * backed by a checkpoint with the same parameters and result, and every checkpoint must be used by the report.
 * Returns {ok:null} when there is no report, otherwise {ok,problems} with fixed problem codes. */
export function reportMatchesCheckpoints(result,steps){
  if(!isObject(result))return {ok:null,problems:[]};
  const problems=new Set(),byId=new Map(steps.map(step=>[step.step_id,step])),used=new Set();
  const same=(step,parameters,value)=>step&&sameJson(step.parameters,parameters)&&sameJson(step.result,value);
  const candidates=Array.isArray(result.candidates)?result.candidates:null;
  if(!candidates)problems.add('CANDIDATES_MISSING');
  else{
    if(Number.isSafeInteger(result.candidate_count)&&result.candidate_count!==candidates.length)problems.add('CANDIDATE_COUNT_MISMATCH');
    candidates.forEach((item,index)=>{
      const id='candidate:'+String(index).padStart(3,'0'),step=byId.get(id);
      used.add(id);
      if(!isObject(item)||step?.kind!=='CANDIDATE'||!same(step,item.parameters,item.result))problems.add('CANDIDATE_MISMATCH');
    });
  }
  checkSelected(result,steps,byId,used,problems,candidates,same);
  if(steps.some(step=>!used.has(step.step_id)))problems.add('UNREFERENCED_STEP');
  return {ok:problems.size===0,problems:[...problems].sort()};
}
function checkSelected(result,steps,byId,used,problems,candidates,same){
  const selected=selectedOf(result),holdout=byId.get('holdout:selected');
  if(!selected){
    if(holdout||result.holdout_evaluated===true)problems.add('HOLDOUT_MISMATCH');
    return;
  }
  if(!candidates?.some(item=>isObject(item)&&sameJson(item.parameters,selected.parameters)&&sameJson(item.result,selected.result)))problems.add('SELECTED_MISMATCH');
  const stress=byId.get('stress:selected');
  used.add('stress:selected');
  if(!present(selected.cost_stress)||stress?.kind!=='STRESS'||!same(stress,selected.parameters,selected.cost_stress))problems.add('STRESS_MISMATCH');
  for(const item of Array.isArray(selected.sensitivity)?selected.sensitivity:[]){
    const own=isObject(item)?steps.find(step=>step.kind==='SENSITIVITY'&&sameJson(step.parameters,item.parameters)):null;
    const candidate=isObject(item)?candidates?.find(entry=>isObject(entry)&&sameJson(entry.parameters,item.parameters)):null;
    if(own){used.add(own.step_id);if(!sameJson(own.result,item.result))problems.add('SENSITIVITY_MISMATCH');}
    else if(!candidate||!sameJson(candidate.result,item.result))problems.add('SENSITIVITY_MISMATCH');
  }
  used.add('holdout:selected');
  if(result.holdout_evaluated===true){
    if(holdout?.kind!=='HOLDOUT'||!sameJson(holdout.parameters,selected.parameters)||!isObject(holdout.result)||!sameJson(holdout.result.test,selected.test))problems.add('HOLDOUT_MISMATCH');
  }else if(holdout||present(selected.test))problems.add('HOLDOUT_MISMATCH');
}

/** Holdout window of a run: the bar times of the last split, from the first holdout bar to the last. */
export function holdoutWindow(contract){
  const start=contract?.dataset?.start_time,split=contract?.split;
  if(!Number.isSafeInteger(start)||!isObject(split)||!Number.isSafeInteger(split.validation_end)||!Number.isSafeInteger(split.test_end)||
     split.validation_end<0||split.test_end<=split.validation_end)return null;
  return {start_time:start+split.validation_end*MINUTE,end_time:start+(split.test_end-1)*MINUTE};
}
export const windowsOverlap=(a,b)=>a!==null&&b!==null&&a.start_time<=b.end_time&&b.start_time<=a.end_time;
export const marketKey=contract=>{const market=pick(contract?.snapshot?.market,['broker','symbol','timeframe']);return market?canonical(market):null;};

/** library-qualification-v1. Eight gates, fixed before any result is seen. A gate is PASS, FAIL or NOT_REACHED (G2 to G5
 * after an earlier failure of G1 to G4; G6 to G8 are always evaluated). integrity is null when it was not checked (list
 * rows); holdoutOverlap is null when no earlier run was looked up. G8 has no source in this release and always fails, so
 * qualified is always false. */
export const GATE_NAMES=Object.freeze(['COMPLETED_EVALUATION','SCREENED_CANDIDATE','ROBUSTNESS','HOLDOUT_RESULT','HOLDOUT_INDEPENDENT',
  'BLOCKERS_CLEARED','OWNER_RECOMMENDATION_READY','QL4C_VALIDATION']);
const failedOf=(reasons,names)=>names.filter(name=>reasons.includes(name)).join(',')||null;
export function qualification({status,result=null,blockers=null,integrity=null,holdoutOverlap=null}={}){
  const gates=[],reasons=selectedReasons(result);
  const add=(index,state,reason=null)=>gates.push({gate:'G'+(index+1),name:GATE_NAMES[index],state,code:state==='PASS'?null:reason});
  let open=true;
  const run=(index,check)=>{
    if(!open){add(index,'NOT_REACHED');return;}
    const reason=check();
    if(reason===null)add(index,'PASS');else{add(index,'FAIL',reason);open=false;}
  };
  run(0,()=>!isCompleted(status)?'STATUS_NOT_COMPLETED':!isObject(result)?'NO_RESULT':
    integrity&&(integrity.contract_hash_verified!==true||integrity.report_matches_checkpoints!==true)?'INTEGRITY_CHECK_FAILED':null);
  run(1,()=>selectedOf(result)?null:'NO_SCREENED_CANDIDATE');
  run(2,()=>failedOf(reasons,['SENSITIVITY_FAILED','COST_STRESS_FAILED']));
  run(3,()=>result?.holdout_evaluated!==true?'HOLDOUT_NOT_EVALUATED':failedOf(reasons,['INSUFFICIENT_TEST_TRADES','NEGATIVE_HOLDOUT_RETURN','TEST_DRAWDOWN_EXCEEDED']));
  run(4,()=>holdoutOverlap===null?'HOLDOUT_INDEPENDENCE_NOT_CHECKED':holdoutOverlap.overlaps===true?'HOLDOUT_WINDOW_REUSED':null);
  if(Array.isArray(blockers)&&blockers.length===0)add(5,'PASS');
  else add(5,'FAIL',Array.isArray(blockers)?'ACCEPTANCE_BLOCKERS_PRESENT':'BLOCKERS_UNKNOWN');
  if(isObject(result)&&result.owner_recommendation_ready===true)add(6,'PASS');else add(6,'FAIL','OWNER_RECOMMENDATION_NOT_READY');
  add(7,'FAIL','QL4C_VALIDATION_NOT_AVAILABLE');
  const qualified=gates.every(gate=>gate.state==='PASS');
  const label=gates[0].state!=='PASS'?'NOT_EVALUATED':gates[1].state!=='PASS'?'NO_SCREENED_CANDIDATE':qualified?'QUALIFIED':'DEVELOPMENT_ONLY';
  return {version:LIBRARY_VERSIONS.qualification,qualified,label,gates};
}
