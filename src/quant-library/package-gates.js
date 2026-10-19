import {canonical,hash} from '../pine-bridge/source.js';
import {assemble} from '../pine-bridge/template.js';
import {RECOMMENDATION_COMPLETION_REASON,OWNER_RECOMMENDATION_CONTRACT_VERSIONS,ownerRecommendationGate} from './owner-recommendation.js';
import {isObject,isCompleted,selectedOf,selectedReasons,holdoutWindow,windowsOverlap,classify,candidateAggregates,holdoutTooFewTrades,metrics,marketKey,MINUTE} from './derive.js';

/**
 * Pure gate layer of the QL-4B/QL-4C qualified Best Inputs package (docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md, sections
 * 5, 6 and 11.1). It reads no database, no file, no network, no clock and no random source, and it is wired into no route,
 * worker or UI. Every input is a plain value that a caller took from durable rows or from the package bytes; every output
 * is a frozen plain value. A gate result is {gate, state, pass, codes}: state is PASS, FAIL or NOT_REACHED, and every
 * refusal carries an exact contract code. Missing, null, empty, unreadable or wrong-type input is a FAIL, never a pass or a
 * skip, and never an exception. B0 is a build-time gate (6.1) and the attempt-time evaluatePackage runs C1 to C4 and Q only.
 * Caller input that no gate may judge (see INPUT_INVALID) refuses the call and never becomes a package outcome. Thresholds come from the run's own frozen rules, never from a current code constant. No
 * test-only override of any gate exists here, and nothing sets G7 except the derivation in ownerRecommendationGate.
 *
 * Evidence record shapes (compile record fields excepted) are named by this module because the contract fixes the checks
 * and not the field names; the shapes are documented next to each gate.
 */
export const PACKAGE_GATE_VERSION='best-inputs-gates-v1';
export const MANIFEST_SCHEMA='best-inputs-manifest-v1';
export const CODE_PATTERN=/^[A-Z][A-Z0-9_]{1,63}$/;
export const MAX_VALIDATION_ATTEMPTS=5;
export const ENGINEERING_SCOPE='SPT_CUSTOM_ENGINEERING_ONLY';
export {RECOMMENDATION_COMPLETION_REASON,OWNER_RECOMMENDATION_CONTRACT_VERSIONS,ownerRecommendationGate};
export const MODES=Object.freeze(['ONE_PINE','MULTI_PINE']);
export const STATUS=Object.freeze({NO_VALID_CANDIDATE:'NO_VALID_CANDIDATE',EXPORT_CANDIDATE:'EXPORT_CANDIDATE',EXPORT_INTERNAL:'EXPORT_INTERNAL',
  EXPORT_VALIDATED:'EXPORT_VALIDATED',EXPORT_REFUSED:'EXPORT_REFUSED'});
export const GATES=Object.freeze(['B0','C1','C2','C3','C4','Q']);
export const MANIFEST_PATH='quant-data/manifest.json';
export const PACKAGE_FILES=Object.freeze(['inputs.json','indicator.pine','indicator.json','risk-profile.json','setup-guide.md','validation.html',
  MANIFEST_PATH,'quant-data/metrics.json','quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv','quant-data/validation.json']);
const JSON_FILES=Object.freeze(['inputs.json','indicator.json','risk-profile.json',MANIFEST_PATH,'quant-data/metrics.json','quant-data/validation.json']);
/** Missing-evidence codes, the only ones a retry may follow (section 6.1). */
export const RETRYABLE_CODES=Object.freeze(['BI_COMPILE_EVIDENCE_MISSING','BI_COMPILE_WARNINGS_UNREVIEWED','BI_NATIVE_ALERT_ISOLATION_UNPROVEN',
  'BI_DATASET_ALIGNMENT_MISSING','BI_PARITY_EVIDENCE_MISSING','BI_REPAINT_EVIDENCE_MISSING','ACCEPTANCE_BLOCKERS_PRESENT']);
const RETRYABLE=new Set(RETRYABLE_CODES);
export const isRetryable=code=>RETRYABLE.has(code);
/** Section 4.4. Capability blockers must be clear at admission; candidate evidence blockers are cleared by append-only records. */
export const CAPABILITY_BLOCKERS=Object.freeze(['CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']);
export const CANDIDATE_BLOCKERS=Object.freeze(['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED']);
const CANDIDATE_BLOCKER_SET=new Set(CANDIDATE_BLOCKERS);
/**
 * RC-11: the multi-Pine research contract version and its one capability blocker. Root froze 'ql3a-research-job-multi-v1'
 * (RD-MP-1, option A); the value is final for F11-01. The blocker name stays a placeholder until docs/MULTI_PINE_CONTRACT.md
 * freezes it. The version is never listed in OWNER_RECOMMENDATION_CONTRACT_VERSIONS: no
 * multi-Pine run derives G7 PASS before APP-3B. The blocker is tolerated on the EXPORT_INTERNAL path only (internalPath).
 */
export const MULTI_PINE_CONTRACT_VERSION='ql3a-research-job-multi-v1';
export const MULTI_PINE_BLOCKER='MULTI_PINE_REQUIRES_APP_3B';
/** RC-8: an unreadable or non-boolean replay state refuses the read. It is never a C4 freshness code and never REPLAY_MISMATCH. */
export const REPLAY_STATE_UNAVAILABLE='BI_REPLAY_STATE_UNAVAILABLE';
export const ADMITTED_COST_MODELS=Object.freeze(['paper-close-v1']);
/** Reviewed Bridge templates (assemble, src/pine-bridge/template.js, a pure function) by exit version. Only bridge-exit-v2 has one today. */
const EXIT_TEMPLATES=Object.freeze({'bridge-exit-v2':assemble});
/** Exit versions with a template. C2 judges the logic diff with the template of the package's own exit version; C3 refuses any other version. */
export const SUPPORTED_EXIT_VERSIONS=Object.freeze(Object.keys(EXIT_TEMPLATES));
/** OD-4: the versioned episode gate does not exist yet, so no non-fixture package can pass B0. */
export const EPISODE_GATE_VERSION=null;
export const FRESHNESS_ORDER=Object.freeze(['BI_SOURCE_VERSION_STALE','BI_MEMBERSHIP_CHANGED','BI_POLICY_SNAPSHOT_MISMATCH','BI_DEPLOYMENT_CHANGED',
  'BI_SELECTION_CHANGED','BI_DATASET_UNAVAILABLE']);
const RULE_KEYS=['minimum_closed_trades_train','minimum_closed_trades_validation','minimum_closed_trades_test','maximum_drawdown_percent','sensitivity_max_drop_percentage_points'];
/** The same list as derive.js METRIC_KEYS (not exported there). */
export const METRIC_KEYS=Object.freeze(['bars','closed_trades','start_equity','end_equity','net_return_percent','max_drawdown_percent','profit_factor','gross_profit','gross_loss']);
const DECIMAL_METRICS=METRIC_KEYS.filter(key=>key!=='bars'&&key!=='closed_trades');
const PARTITIONS=['train','validation','test'];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const DATASET_METADATA_VERSION='spot-dataset-v1';
/** The only data source of spot-dataset-v1 metadata (Binance Global public klines, FND validateDatasetMetadata). */
const DATASET_SOURCE='binance-spot-klines-v1';
const HEX64=/^[a-f0-9]{64}$/;
const DECIMAL=/^-?\d+(?:\.\d+)?$/;
const UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const present=value=>value!==undefined&&value!==null;
const has=(object,key)=>isObject(object)&&Object.hasOwn(object,key);
const text=value=>typeof value==='string'&&value.length>0;
const sha=value=>typeof value==='string'&&HEX64.test(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const utc=value=>typeof value==='string'&&UTC.test(value)&&!Number.isNaN(Date.parse(value));
/** at_utc and created_at_utc (exposure register, run creation time) accept at most three fraction digits; Date.parse would drop the rest. */
const utcMs=value=>utc(value)&&!/\.\d{4,}Z$/.test(value);
const list=value=>Array.isArray(value)?value:[];
const decimalNumber=value=>finite(value)?value:typeof value==='string'&&DECIMAL.test(value)?Number(value):NaN;
const canon=value=>{try{const out=canonical(value);return typeof out==='string'?out:null;}catch{return null;}};
const same=(a,b)=>{const left=canon(a);return left!==null&&left===canon(b);};
const digest=value=>{const out=canon(value);return out===null?null:hash(out);};
const unique=values=>[...new Set(values)];
const byKey=key=>(a,b)=>a[key]<b[key]?-1:a[key]>b[key]?1:0;
const sortedBy=(items,key)=>list(items).filter(isObject).sort(byKey(key));
const bytesOf=content=>typeof content==='string'?Buffer.from(content,'utf8'):content instanceof Uint8Array?content:null;
const textOf=content=>{const bytes=bytesOf(content);return bytes===null?null:typeof content==='string'?content:new TextDecoder().decode(bytes);};
const parseJson=content=>{const source=textOf(content);if(source===null)return undefined;try{return JSON.parse(source);}catch{return undefined;}};

/** A gate result. codes keep the order of the checks and are unique. */
function outcome(gate,codes,extra={}){
  const found=unique(codes);
  return Object.freeze({gate,state:found.length?'FAIL':'PASS',pass:found.length===0,codes:Object.freeze(found),...extra});
}
export const notReached=gate=>Object.freeze({gate,state:'NOT_REACHED',pass:false,codes:Object.freeze([])});
/**
 * Caller input that no gate may judge (bad attempt metadata, no current rules, an unknown replay state) refuses the CALL. A
 * refusal is {refused, fields, pass:false, codes:[]}: no gate state, no status event, no attempt recorded, and never a
 * package outcome. INPUT_INVALID is not a gate code.
 */
export const INPUT_INVALID='INPUT_INVALID';
const refusal=(gate,fields,reason=INPUT_INVALID)=>Object.freeze({gate,refused:reason,fields:Object.freeze([...fields]),pass:false,codes:Object.freeze([])});
export const isRefused=result=>isObject(result)&&typeof result.refused==='string';
/** The three evaluator-produced trace files of quant-data (section 5.3). */
export const TRACE_FILES=Object.freeze(['quant-data/equity.csv','quant-data/trades.csv','quant-data/decisions.csv']);
/** A validation attempt qualifies when these four gates pass. B0 is a build-time gate and is never re-run at attempt time. */
export const QUALIFYING_GATES=Object.freeze(['C1','C2','C3','C4']);
/** A failure with at least one non-retryable code is a hard failure: the gates after it are NOT_REACHED. */
export const isHardFailure=result=>isObject(result)&&result.state==='FAIL'&&list(result.codes).some(code=>!RETRYABLE.has(code));

/* ---- hashing and manifest builder (section 3.1, 11.1 item 6) ---- */

/** SHA-256 of the canonical JSON of the binding tuple. Key order and whitespace do not matter. */
export const bindingHash=binding=>isObject(binding)?digest(binding):null;
/** SHA-256 of the canonical quant-data/manifest.json, given as an object or as JSON text. */
export function packageHash(manifest){
  const value=typeof manifest==='string'?parseJson(manifest):manifest;
  return isObject(value)?digest(value):null;
}
/** (path, sha256, bytes) of every file except the manifest, sorted by path. Unreadable entries are left out. */
export function fileEntries(files){
  if(!isObject(files))return [];
  return Object.keys(files).filter(path=>path!==MANIFEST_PATH).sort().flatMap(path=>{
    const bytes=bytesOf(files[path]);
    return bytes===null?[]:[{path,sha256:hash(bytes),bytes:bytes.length}];
  });
}
/** Deterministic builder: the same inputs give the same manifest, and so the same package_hash. */
export const buildManifest=({identity,binding,inputs,evidence,limitations,fixture,files}={})=>({schema_version:MANIFEST_SCHEMA,identity,binding,
  files:fileEntries(files),inputs,evidence,limitations,fixture});

/* ---- content scan (section 5.1) ---- */

const SECRET_PATTERNS=Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[_-]?key|api[_-]?secret|secret|token|password|passwd|authorization)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  /\bhttps?:\/\/[^\s"'<>/@]+:[^\s"'<>/@]+@/i,
  /\bhttps?:\/\/[^\s"'<>]*[?&](?:token|key|secret|auth|signature|password)=[^&\s"'<>]{6,}/i,
  /\bhttps?:\/\/[^\s"'<>]*\/(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}(?=[/?#\s"'<>]|$)/i]);
const PATH_PATTERNS=Object.freeze([
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/,
  /\\\\[A-Za-z0-9_.$-]+\\[A-Za-z0-9_.$-]+/,
  /(?:^|[\s"'(=,[])\/(?:home|Users|root|var|tmp|etc|opt|usr|mnt|srv|Volumes|private)\/[^\s"'<>]+/m,
  /(?:^|[\s"'(=,[])~\/[^\s"'<>]+/m]);
/** BI_SECRET_DETECTED for a credential, bearer URL, secret pattern or private key; BI_MACHINE_PATH_DETECTED for a Windows,
 * UNC, POSIX absolute or home path. A last line of defence: the builder must never read credential sources. */
export function scanContent(value){
  const content=typeof value==='string'?value:'',codes=[];
  if(SECRET_PATTERNS.some(pattern=>pattern.test(content)))codes.push('BI_SECRET_DETECTED');
  if(PATH_PATTERNS.some(pattern=>pattern.test(content)))codes.push('BI_MACHINE_PATH_DETECTED');
  return codes;
}
/** Pine text with comments and string contents blanked out, line breaks kept. */
function pineCode(source){
  let out='',quote=null;
  for(let index=0;index<source.length;index++){
    const char=source[index];
    if(quote){
      if(char==='\\'){out+='  ';index++;continue;}
      if(char===quote)quote=null;
      out+=char==='\n'?'\n':' ';
    }else if(char==='"'||char==="'"){quote=char;out+=' ';}
    else if(char==='/'&&source[index+1]==='/'){while(index<source.length&&source[index]!=='\n'){out+=' ';index++;}index--;}
    else out+=char;
  }
  return out;
}

/* ---- binding tuple (section 3.2) ---- */

const BINDING_SPEC=Object.freeze({
  owner_id:text,bot_id:text,run_id:text,contract_hash:sha,submission_hash:sha,deployment_id:text,pine_import_id:text,
  source_version:value=>Number.isSafeInteger(value)&&value>=1,source_hash:sha,baseline_snapshot_hash:sha,input_lock_hash:sha,
  slot_bindings:Array.isArray,bridge_domains:value=>isObject(value)&&Array.isArray(value.atr_multiplier)&&Array.isArray(value.rr),
  effective_input_hash:sha,policy_version:text,policy_hash:sha,capital:isObject,ledger_initialization:text,model:isObject,
  cost_model_version:text,dataset_ref:isObject,split:isObject,engine_hash:sha,
  rules:value=>isObject(value)&&RULE_KEYS.every(key=>finite(value[key])),
  acceptance_blockers:value=>Array.isArray(value)&&value.every(text),library_versions:isObject,library_record_ref:isObject,
  alert_source:text,exit_version:text,market:isObject,mode:value=>MODES.includes(value),pine_count:value=>Number.isSafeInteger(value)&&value>=1,
  membership:value=>Array.isArray(value)&&value.length>0,fixture:value=>typeof value==='boolean',created_at:utc});
export const BINDING_FIELDS=Object.freeze(Object.keys(BINDING_SPEC));
/** Every field is required and nothing is defaulted. holdout_boundary_ref is optional and must be an object when present. */
export const bindingComplete=binding=>isObject(binding)&&BINDING_FIELDS.every(key=>BINDING_SPEC[key](binding[key]))&&
  (!has(binding,'holdout_boundary_ref')||isObject(binding.holdout_boundary_ref));

const rulesOf=contract=>{const rules=contract?.rules;return isObject(rules)&&RULE_KEYS.every(key=>finite(rules[key]))?rules:null;};
const bindingsOf=contract=>list(contract?.input_lock?.selection?.bindings).filter(isObject);
const fixedOf=contract=>list(contract?.input_lock?.selection?.fixed_inputs).filter(isObject);
const datasetRef=dataset=>{if(!isObject(dataset))return undefined;const {bars:_bars,...rest}=dataset;return rest;};
const datasetDigest=ref=>isObject(ref)?(text(ref.sha256)?ref.sha256:text(ref.content_digest)?ref.content_digest:null):null;
const marketOf=market=>isObject(market)?{broker:market.broker,symbol:market.symbol,timeframe:market.timeframe}:undefined;
/** SHA-256 of the complete effective-input snapshot of a run contract: selected values, fixed values and the Bridge pair. */
export function effectiveInputHash(contract){
  const selection=contract?.input_lock?.selection;
  if(!isObject(selection)||!Array.isArray(selection.bindings)||!Array.isArray(selection.fixed_inputs)||!isObject(selection.bridge))return null;
  const pairs=items=>Object.fromEntries(items.filter(isObject).map(item=>[item.pine_variable,item.effective_value]));
  return digest({selected:pairs(selection.bindings),fixed:pairs(selection.fixed_inputs),bridge:selection.bridge});
}
/** Train and validation windows a run searched, bar time of the first to the last bar before its holdout. */
export function searchedWindow(contract){
  const start=contract?.dataset?.start_time,split=contract?.split;
  if(!Number.isSafeInteger(start)||!isObject(split)||!Number.isSafeInteger(split.validation_end)||split.validation_end<=0)return null;
  return {start_time:start,end_time:start+(split.validation_end-1)*MINUTE};
}

/* ---- G7 and G8 (sections 5.5, OD-18) ---- */

const validationRecordPasses=record=>isObject(record)&&record.fixture===false&&text(record.export_id)&&sha(record.package_hash)&&sha(record.binding_hash)&&
  Array.isArray(record.gate_results)&&['C1','C2','C3','C4'].every(name=>record.gate_results.some(item=>isObject(item)&&item.gate===name&&item.state==='PASS'));
/** Items are {run_id, mode, record}. G8 passes for a run only with a PASS ql4c_validation record of a non-fixture ONE_PINE package. */
export function libraryG8(items,runId){
  const ok=text(runId)&&list(items).some(item=>isObject(item)&&item.run_id===runId&&item.mode==='ONE_PINE'&&validationRecordPasses(item.record));
  return Object.freeze(ok?{gate:'G8',state:'PASS',code:null}:{gate:'G8',state:'FAIL',code:'QL4C_VALIDATION_NOT_AVAILABLE'});
}
/** QUALIFIED_TOTAL and QUALIFIED_WINNER derive from validation records. The winner stays null: the best-within-scope ranking is QR-4. */
export function qualifiedFromRecords(items){
  const runs=unique(list(items).filter(item=>isObject(item)&&text(item.run_id)).map(item=>item.run_id).filter(runId=>libraryG8(items,runId).state==='PASS')).sort();
  return Object.freeze({total:runs.length,winner:null,runs:Object.freeze(runs)});
}

/* ---- Gate B0: build eligibility (section 5.0) ---- */

const windowList=value=>Array.isArray(value)&&value.every(item=>isObject(item)&&Number.isSafeInteger(item.start_time)&&Number.isSafeInteger(item.end_time)&&item.start_time<=item.end_time)?value:null;
const boundaryKnown=value=>isObject(value)&&(value.exists===false||(value.exists===true&&Number.isSafeInteger(value.start_time)&&(!has(value,'ref')||isObject(value.ref))));
/** Where the registered boundary has a ref, the packaged holdout_boundary_ref must equal it; both absent is allowed (3.2). */
function boundaryRefMismatch(binding,lookups){
  const boundary=isObject(lookups)?lookups.registered_boundary:undefined;
  if(!boundaryKnown(boundary)||!isObject(binding))return false;
  const expected=boundary.exists===true&&has(boundary,'ref')?boundary.ref:undefined,actual=has(binding,'holdout_boundary_ref')?binding.holdout_boundary_ref:undefined;
  return expected===undefined?actual!==undefined:!same(expected,actual);
}
/**
 * Exposure register entry (OD-19): a QR-3 event {owner_id, market, source_hash, window, comparison_id, at_utc} or a QR-4
 * record {owner_id, market, window, selection_id, at_utc}. market is {broker, symbol, timeframe}; window is {start_time,
 * end_time}. Anything else is malformed; an entry whose market is not that object is never matched, so it is refused.
 */
const exposureEntry=entry=>{
  if(!isObject(entry)||!text(entry.owner_id)||!isObject(entry.market)||![entry.market.broker,entry.market.symbol,entry.market.timeframe].every(text)||!utcMs(entry.at_utc)||
    windowList([entry.window])===null)return null;
  const qr3=has(entry,'comparison_id'),qr4=has(entry,'selection_id');
  if(qr3===qr4||(qr3&&!(text(entry.comparison_id)&&sha(entry.source_hash)))||(qr4&&!text(entry.selection_id)))return null;
  return {owner_id:entry.owner_id,market_key:canon({broker:entry.market.broker,symbol:entry.market.symbol,timeframe:entry.market.timeframe}),window:entry.window,at:Date.parse(entry.at_utc)};
};
/** An entry counts only for the same owner and the same canonical market, and only when at_utc is at or before the run's durable creation time. */
function exposureCodes(run,contract,own,register){
  const entries=Array.isArray(register)?register.map(exposureEntry):null;
  if(entries===null||entries.includes(null)||!utcMs(run.created_at_utc))return ['BI_EXPOSURE_REGISTER_UNAVAILABLE'];
  const key=marketKey(contract);
  if(key===null||own===null)return ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'];
  const created=Date.parse(run.created_at_utc);
  return entries.some(entry=>entry.owner_id===run.owner_id&&entry.market_key===key&&entry.at<=created&&windowsOverlap(own,entry.window))?['BI_HOLDOUT_EXPOSED_BY_SELECTION']:[];
}
function robustnessCodes(selected,rules){
  const stored=selectedReasons({selected}),codes=[],base=decimalNumber(selected.result?.validation?.net_return_percent);
  let sensitivity=stored.includes('SENSITIVITY_FAILED')||!Array.isArray(selected.sensitivity);
  if(rules&&Array.isArray(selected.sensitivity))for(const item of selected.sensitivity){
    const validation=isObject(item)?item.result?.validation:undefined;
    if(!(decimalNumber(validation?.net_return_percent)>=base-rules.sensitivity_max_drop_percentage_points)||!(validation?.closed_trades>=rules.minimum_closed_trades_validation))sensitivity=true;
  }
  let stress=stored.includes('COST_STRESS_FAILED')||!isObject(selected.cost_stress);
  if(rules&&isObject(selected.cost_stress)){
    const validation=selected.cost_stress.validation;
    if(!(decimalNumber(validation?.net_return_percent)>=0)||!(validation?.closed_trades>=rules.minimum_closed_trades_validation))stress=true;
  }
  if(sensitivity)codes.push('SENSITIVITY_FAILED');
  if(stress)codes.push('COST_STRESS_FAILED');
  return codes;
}
function holdoutCodes(result,selected,rules){
  if(result.holdout_evaluated!==true||!isObject(selected.test))return ['HOLDOUT_NOT_EVALUATED'];
  const stored=selectedReasons({selected}),test=selected.test,codes=[];
  if(stored.includes('INSUFFICIENT_TEST_TRADES')||(rules&&!(test.closed_trades>=rules.minimum_closed_trades_test)))codes.push('INSUFFICIENT_TEST_TRADES');
  if(stored.includes('NEGATIVE_HOLDOUT_RETURN')||(rules&&!(decimalNumber(test.net_return_percent)>=0)))codes.push('NEGATIVE_HOLDOUT_RETURN');
  if(stored.includes('TEST_DRAWDOWN_EXCEEDED')||(rules&&!(decimalNumber(test.max_drawdown_percent)<=rules.maximum_drawdown_percent)))codes.push('TEST_DRAWDOWN_EXCEEDED');
  return codes;
}
function independenceCodes(run,contract,lookups){
  const own=holdoutWindow(contract),source=isObject(lookups)?lookups:{};
  const earlier=windowList(source.earlier_holdouts),searched=windowList(source.earlier_searched),boundary=source.registered_boundary;
  const codes=[];
  if(own===null||earlier===null||searched===null||!boundaryKnown(boundary))codes.push('HOLDOUT_INDEPENDENCE_NOT_CHECKED');
  else{
    if(earlier.some(window=>windowsOverlap(own,window)))codes.push('HOLDOUT_WINDOW_REUSED');
    if(searched.some(window=>windowsOverlap(own,window)))codes.push('BI_HOLDOUT_OVERLAPS_SEARCHED_DATA');
    if(boundary.exists===true&&own.start_time<boundary.start_time)codes.push('BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY');
  }
  codes.push(...exposureCodes(run,contract,own,source.exposure_register));
  return codes;
}
/** Library gates G1 to G5 recomputed under the run's own rules. G1 to G4 stop at the first failing gate, as derive.js does. */
function libraryCodes(run,lookups){
  const contract=isObject(run.contract)?run.contract:{},result=run.result,rules=rulesOf(contract);
  if(!isCompleted(run.status))return ['STATUS_NOT_COMPLETED'];
  if(!isObject(result))return ['NO_RESULT'];
  const integrity=run.integrity;
  if(!isObject(integrity)||integrity.contract_hash_verified!==true||integrity.report_matches_checkpoints!==true)return ['INTEGRITY_CHECK_FAILED'];
  const codes=[];
  if(run.status!=='SUCCEEDED'||result.completion_reason!==RECOMMENDATION_COMPLETION_REASON)codes.push('BI_RUN_NOT_QUALIFIABLE');
  const selected=selectedOf(result);
  const sampled=selected&&(!rules||(selected.result?.train?.closed_trades>=rules.minimum_closed_trades_train&&selected.result?.validation?.closed_trades>=rules.minimum_closed_trades_validation));
  if(!selected||!sampled)return [...codes,'NO_SCREENED_CANDIDATE'];
  const robustness=robustnessCodes(selected,rules);
  if(robustness.length)return [...codes,...robustness];
  const holdout=holdoutCodes(result,selected,rules);
  if(holdout.length)return [...codes,...holdout];
  return [...codes,...independenceCodes(run,contract,lookups)];
}
const searchRecordPresent=(result,contract)=>text(result.search_algorithm)&&Number.isSafeInteger(result.seed)&&count(result.budget)&&count(result.candidate_count)&&
  text(result.completion_reason)&&isObject(contract.input_lock?.domains);
const dimensionCoverageFull=result=>result.dimension_coverage_percent===100&&Number.isSafeInteger(result.selected_dimensions)&&result.selected_dimensions>0&&
  result.covered_dimensions===result.selected_dimensions;
/** Mode of a run from its frozen membership (3.2, server-resolved, never the claimed binding): one member ONE_PINE, more MULTI_PINE, else unknown. */
const modeOfRun=contract=>{const members=list(contract?.snapshot?.membership);return members.length>0&&members.every(isObject)?(members.length===1?'ONE_PINE':'MULTI_PINE'):null;};
/**
 * The EXPORT_INTERNAL path (RC-11): true only when the package is created internal (an explicit true), the claimed mode and the
 * mode derived from the frozen membership are both MULTI_PINE, and the run's contract version is the multi-Pine research contract
 * version. A mode and version mismatch never gets the tolerance and is refused with BI_BINDING_MISMATCH at B0.
 */
const internalPath=(internal,contract,claimedMode)=>internal===true&&claimedMode==='MULTI_PINE'&&modeOfRun(contract)==='MULTI_PINE'&&
  isObject(contract)&&contract.version===MULTI_PINE_CONTRACT_VERSION;
/** Unknown blocker codes are never tolerated. On the internal path only, MULTI_PINE_REQUIRES_APP_3B does not refuse B0 (RC-11). */
function blockerCodes(contract,internal){
  const blockers=contract.acceptance_blockers;
  if(!Array.isArray(blockers)||!blockers.every(text))return ['BLOCKERS_UNKNOWN'];
  return blockers.some(name=>!CANDIDATE_BLOCKER_SET.has(name)&&!(internal&&name===MULTI_PINE_BLOCKER))?['BI_CAPABILITY_BLOCKER_PRESENT']:[];
}
/**
 * B0. subject: {owner_id, run, holdout, binding, internal, current_rules}. run is the durable quant_jobs view {owner_id,
 * run_id, status, contract, result, integrity:{contract_hash_verified, report_matches_checkpoints}}; holdout is
 * {earlier_holdouts:[window], earlier_searched:[window], registered_boundary:{exists:false}|{exists:true, start_time, ref?},
 * exposure_register:[entry]} (entries: see exposureEntry). run also carries created_at_utc, the durable creation time of the
 * run row: an exposure entry counts only when its at_utc is at or before it; at_utc and created_at_utc carry at most three fraction
 * digits. current_rules is required input. binding.mode must equal the mode of the frozen membership (BI_BINDING_MISMATCH). internal
 * is the created-internal flag; the EXPORT_INTERNAL path (RC-11) also needs mode MULTI_PINE and contract.version equal to
 * MULTI_PINE_CONTRACT_VERSION, and only on it MULTI_PINE_REQUIRES_APP_3B and a G7 FAIL (completion reason RESEARCH_CANDIDATE_PENDING_ACCEPTANCE
 * with the unlisted multi-Pine version) do not refuse B0. A created-internal package whose mode and version disagree is refused
 * with BI_BINDING_MISMATCH and gets no tolerance. The result carries g7, the G7 gate as this module derives it (OD-18).
 * A foreign or absent run gives NOT_FOUND and nothing else. B0 runs at build time only (6.1): the attempt-time evaluation
 * never calls it.
 */
export function evaluateBuildEligibility(subject){
  const s=isObject(subject)?subject:{},run=s.run;
  if(!text(s.owner_id)||!isObject(run)||run.owner_id!==s.owner_id)return outcome('B0',['NOT_FOUND'],{limitations:Object.freeze([])});
  if(!isObject(s.current_rules))return refusal('B0',['current_rules']);
  const contract=isObject(run.contract)?run.contract:{},binding=isObject(s.binding)?s.binding:{},rules=rulesOf(contract),codes=[...libraryCodes(run,s.holdout)];
  if(isObject(run.result)){
    if(!searchRecordPresent(run.result,contract))codes.push('BI_SEARCH_RECORD_MISSING');
    if(!dimensionCoverageFull(run.result))codes.push('BI_DIMENSION_COVERAGE');
  }
  const mode=modeOfRun(contract),internal=internalPath(s.internal,contract,binding.mode);
  codes.push(...blockerCodes(contract,internal));
  if(mode==='MULTI_PINE'&&!internal)codes.push('BI_MULTI_PINE_INTERNAL_ONLY');
  if(!bindingComplete(s.binding)||!rules)codes.push('BI_BINDING_INCOMPLETE');
  // The claimed mode must equal the mode of the frozen membership; a created-internal package must be multi-Pine with the multi-Pine version.
  const modeMismatch=MODES.includes(binding.mode)&&binding.mode!==mode;
  const versionMismatch=s.internal===true&&(mode!=='MULTI_PINE'||contract.version!==MULTI_PINE_CONTRACT_VERSION);
  if(boundaryRefMismatch(s.binding,s.holdout)||modeMismatch||versionMismatch)codes.push('BI_BINDING_MISMATCH');
  if(binding.fixture!==true&&EPISODE_GATE_VERSION===null)codes.push('BI_EPISODE_GATE_UNAVAILABLE');
  // G7 is derived here by OD-18 only. On the internal path it may stay FAIL, but only for the multi-Pine version with the PASS completion reason.
  const g7=ownerRecommendationGate(run);
  const g7Tolerated=internal&&isObject(run.result)&&run.result.completion_reason===RECOMMENDATION_COMPLETION_REASON&&contract.version===MULTI_PINE_CONTRACT_VERSION;
  if(g7.code&&!g7Tolerated)codes.push(g7.code);
  return outcome('B0',codes,{limitations:Object.freeze(rulesLimitations(contract,s.current_rules)),g7});
}
/** RULES_VERSION_DIFFERS is informational: the run's own frozen rules differ from the current rules. */
const rulesLimitations=(contract,current)=>{const rules=rulesOf(contract);return rules&&isObject(current)&&!same(rules,current)?['RULES_VERSION_DIFFERS']:[];};

/* ---- package reader shared by C1 to C4 ---- */

function openPackage(subject){
  const files=isObject(subject.files)?subject.files:null,json={};
  for(const path of JSON_FILES)json[path]=files&&Object.hasOwn(files,path)?parseJson(files[path]):undefined;
  const manifest=isObject(json[MANIFEST_PATH])?json[MANIFEST_PATH]:null;
  return {files,json,manifest,binding:isObject(manifest?.binding)?manifest.binding:null,
    readable:path=>files!==null&&Object.hasOwn(files,path)&&bytesOf(files[path])!==null};
}

/* ---- Gate C1: structure and content integrity (section 5.1) ---- */

const MANIFEST_KEYS=['schema_version','identity','binding','files','inputs','evidence','limitations','fixture'];
const manifestValid=manifest=>isObject(manifest)&&Object.keys(manifest).length===MANIFEST_KEYS.length&&MANIFEST_KEYS.every(key=>has(manifest,key))&&
  manifest.schema_version===MANIFEST_SCHEMA&&isObject(manifest.identity)&&text(manifest.identity.export_id)&&isObject(manifest.binding)&&
  isObject(manifest.inputs)&&isObject(manifest.evidence)&&typeof manifest.fixture==='boolean'&&
  Array.isArray(manifest.files)&&manifest.files.every(file=>isObject(file)&&text(file.path)&&sha(file.sha256)&&count(file.bytes))&&
  isObject(manifest.limitations)&&typeof manifest.limitations.text==='string'&&Array.isArray(manifest.limitations.codes)&&
  manifest.limitations.codes.every(code=>typeof code==='string'&&CODE_PATTERN.test(code));
function checksumMismatch(pkg,subject){
  const manifest=pkg.manifest,expected=PACKAGE_FILES.filter(path=>path!==MANIFEST_PATH),listed=new Set(manifest.files.map(file=>file.path));
  let mismatch=listed.size!==manifest.files.length||manifest.files.some(file=>!expected.includes(file.path))||expected.some(path=>!listed.has(path));
  for(const file of manifest.files)if(expected.includes(file.path)&&pkg.readable(file.path)){
    const bytes=bytesOf(pkg.files[file.path]);
    if(hash(bytes)!==file.sha256||bytes.length!==file.bytes)mismatch=true;
  }
  return mismatch||!sha(subject.package_hash)||packageHash(manifest)!==subject.package_hash||!sha(subject.binding_hash)||
    bindingHash(manifest.binding)!==subject.binding_hash||bindingHash(subject.binding)!==subject.binding_hash;
}
function numericFormatInvalid(pkg,manifestOk){
  if(manifestOk&&!utc(pkg.manifest.identity.created_at))return true;
  const metricsFile=pkg.json['quant-data/metrics.json'];
  if(isObject(metricsFile))for(const name of PARTITIONS){
    const part=metricsFile[name];
    if(!isObject(part))continue;
    for(const key of DECIMAL_METRICS)if(Object.hasOwn(part,key)&&part[key]!==null&&!(typeof part[key]==='string'&&DECIMAL.test(part[key])))return true;
    for(const key of ['bars','closed_trades'])if(Object.hasOwn(part,key)&&part[key]!==null&&!count(part[key]))return true;
    if(Object.hasOwn(part,'win_rate')&&part.win_rate!==null&&!(typeof part.win_rate==='string'&&DECIMAL.test(part.win_rate)))return true;
  }
  const inputs=pkg.json['inputs.json'];
  if(isObject(inputs)&&Array.isArray(inputs.source_inputs)&&isObject(inputs.bridge)){
    const entries=[...inputs.source_inputs,...Object.values(inputs.bridge)];
    if(entries.some(entry=>!isObject(entry)||typeof entry.before!=='string'||typeof entry.after!=='string'||!text(entry.unit)))return true;
  }
  return false;
}
function metricFabricated(pkg,run){
  const metricsFile=pkg.json['quant-data/metrics.json'],selected=selectedOf(run?.result);
  if(!isObject(metricsFile)||!isObject(run))return false;
  const own={train:selected?.result?.train,validation:selected?.result?.validation,test:selected?.test};
  return PARTITIONS.some(name=>{
    const part=metricsFile[name],base=isObject(own[name])?own[name]:{};
    // Win Rate follows the same rule: where the run has none it stays absent or null; a value for it is invented.
    return isObject(part)&&(METRIC_KEYS.some(key=>Object.hasOwn(part,key)&&!Object.hasOwn(base,key))||
      (Object.hasOwn(part,'win_rate')&&part.win_rate!==null&&!Object.hasOwn(base,'win_rate')));
  });
}
/**
 * C1. subject: {files:{path:text|bytes}, package_hash, binding_hash, binding, run}. binding is the stored tuple; it must
 * hash to binding_hash like the packaged one. Every check reports independently; a check whose input cannot be read
 * reports its own code and its dependants stay silent.
 */
export function evaluateStructure(subject){
  const s=isObject(subject)?subject:{},pkg=openPackage(s),codes=[];
  if(PACKAGE_FILES.some(path=>!pkg.readable(path)))codes.push('BI_ARTIFACT_MISSING');
  if(pkg.files!==null&&Object.keys(pkg.files).some(path=>!PACKAGE_FILES.includes(path)))codes.push('BI_ARTIFACT_UNEXPECTED');
  if(JSON_FILES.some(path=>path!==MANIFEST_PATH&&pkg.readable(path)&&pkg.json[path]===undefined))codes.push('BI_ARTIFACT_MISSING');
  const manifestOk=manifestValid(pkg.manifest);
  if(pkg.readable(MANIFEST_PATH)&&!manifestOk)codes.push('BI_MANIFEST_SCHEMA_INVALID');
  if(manifestOk&&checksumMismatch(pkg,s))codes.push('BI_CHECKSUM_MISMATCH');
  const scans=Object.keys(pkg.files??{}).filter(path=>pkg.readable(path)).flatMap(path=>scanContent(textOf(pkg.files[path])));
  if(scans.includes('BI_SECRET_DETECTED'))codes.push('BI_SECRET_DETECTED');
  if(scans.includes('BI_MACHINE_PATH_DETECTED'))codes.push('BI_MACHINE_PATH_DETECTED');
  if(numericFormatInvalid(pkg,manifestOk))codes.push('BI_NUMERIC_FORMAT_INVALID');
  if(metricFabricated(pkg,s.run))codes.push('BI_METRIC_FABRICATED');
  const indicatorJson=pkg.json['indicator.json'];
  if(manifestOk&&isObject(indicatorJson)&&(pkg.manifest.binding.alert_source!=='alert_calls'||indicatorJson.alert_source!=='alert_calls'))codes.push('BI_ALERT_SOURCE_INVALID');
  if(pkg.readable('indicator.pine')){
    const code=pineCode(textOf(pkg.files['indicator.pine']));
    if([...code.matchAll(/\bindicator\s*\(/g)].length!==1||/\bstrategy\s*(?:\(|\.)/.test(code))codes.push('INDICATOR_REQUIRED');
  }
  if(manifestOk&&isObject(indicatorJson)&&(!same(pkg.manifest.binding.market,MARKET)||indicatorJson.symbol!=='BINANCE:BTCUSDT'||indicatorJson.timeframe!=='1'))codes.push('BI_MARKET_SCOPE_INVALID');
  return outcome('C1',codes);
}

/* ---- Gate C2: compile and source integrity (section 5.2) ---- */

const compileShapeOk=record=>isObject(record)&&text(record.export_id)&&sha(record.indicator_sha256)&&(text(record.pine_version)||finite(record.pine_version))&&
  Array.isArray(record.errors)&&Array.isArray(record.warnings)&&count(record.unresolved_references)&&count(record.collisions)&&count(record.duplicate_bindings)&&
  Array.isArray(record.mapping_check)&&utc(record.compiled_at_utc)&&text(record.operator_role)&&text(record.method);
const warningReviewed=warning=>isObject(warning)&&text(warning.text)&&text(warning.disposition)&&text(warning.reviewer_role);
const nativeIsolationProven=record=>isObject(record)&&record.routes_disabled===true&&record.unrelated_payloads===0&&record.native_payloads===0;
/** True when the package names an exit version that has no Bridge template. C2 cannot judge the logic diff for it, so it fails
 * with BI_EXIT_VERSION_UNSUPPORTED (non-retryable) and never reports BI_SOURCE_LOGIC_CHANGED or PASS for it. */
const exitVersionUntemplated=binding=>isObject(binding)&&text(binding.exit_version)&&!Object.hasOwn(EXIT_TEMPLATES,binding.exit_version);
/** The deterministic Bridge output (the template of the package's exit version) for an edited source, the package
 * Bridge values and the signals, deployment and market of the binding. null when it cannot be assembled. */
function assembledIndicator(prefix,binding,contract,inputs){
  const atr=decimalNumber(inputs?.bridge?.atr_multiplier?.after),rr=decimalNumber(inputs?.bridge?.rr?.after),signals=contract.input_lock?.selection?.signals,market=binding?.market;
  const template=isObject(binding)&&text(binding.exit_version)&&Object.hasOwn(EXIT_TEMPLATES,binding.exit_version)?EXIT_TEMPLATES[binding.exit_version]:null;
  if(template===null||!isObject(binding)||!isObject(market)||!finite(atr)||!finite(rr)||!isObject(signals)||![signals.buy,signals.exit].every(name=>typeof name==='string'&&/^[A-Za-z_]\w*$/.test(name)))return null;
  try{
    const out=template(prefix,{bridge:{atr_multiplier:atr,rr},signals:{buy:signals.buy,exit:signals.exit},bindings:[],fixed_inputs:[]},
      {deployment_id:binding.deployment_id,pine_import_id:binding.pine_import_id,source_version:binding.source_version,broker:market.broker,symbol:market.symbol,timeframe:market.timeframe});
    return typeof out?.integrated_pine==='string'?out.integrated_pine:null;
  }catch{return null;}
}
/** Approved edits are numeric default literals inside the span of a selected input. indicator.pine must equal, byte for byte,
 * the Bridge output for the registered source with only those edits applied and the package Bridge values; any other
 * difference, in the original part or in the appended block, is a logic change. */
function logicIntact({original,indicator,edits,inputs,bindings,assembleFrom}){
  if(typeof original!=='string'||typeof indicator!=='string'||!Array.isArray(edits)||!Array.isArray(inputs?.source_inputs))return false;
  const byId=new Map(bindings.map(binding=>[binding.input_id,binding])),afterOf=new Map(inputs.source_inputs.filter(isObject).map(item=>[item.input_id,item]));
  const used=new Set();
  for(const edit of edits){
    const binding=isObject(edit)?byId.get(edit.input_id):undefined,span=binding?.source_span,input=afterOf.get(edit?.input_id);
    if(!binding||!isObject(span)||used.has(edit.input_id)||!isObject(input))return false;
    used.add(edit.input_id);
    const {start,end}=edit;
    if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<span.start||end>span.end||start>end||end>original.length)return false;
    if(original.slice(start,end)!==edit.before||typeof edit.after!=='string'||!DECIMAL.test(edit.after)||decimalNumber(edit.after)!==decimalNumber(input.after))return false;
  }
  for(const input of afterOf.values())if(decimalNumber(input.after)!==decimalNumber(input.before)&&!used.has(input.input_id))return false;
  const ordered=[...edits].sort(byKey('start'));
  let cursor=0,prefix='';
  for(const edit of ordered){
    if(edit.start<cursor)return false;
    prefix+=original.slice(cursor,edit.start)+edit.after;
    cursor=edit.end;
  }
  prefix+=original.slice(cursor);
  const expected=assembleFrom(prefix);
  return typeof expected==='string'&&indicator===expected;
}
/**
 * C2. subject: {export_id, files, run, compile, native_alert_isolation}. compile is the append-only compile record
 * {export_id, indicator_sha256, pine_version, errors[], warnings[{text, disposition, reviewer_role}], unresolved_references,
 * collisions, duplicate_bindings, mapping_check:[{slot, pine_variable}], compiled_at_utc, operator_role, method}.
 * native_alert_isolation is {routes_disabled:true, unrelated_payloads:0, native_payloads:0}. indicator.json carries the
 * approved edits [{input_id, start, end, before, after}] in the original source. This gate never calls TradingView. The
 * logic diff uses the Bridge template of the package's own exit version; a named version without a template fails here
 * with BI_EXIT_VERSION_UNSUPPORTED (C3 and later are then NOT_REACHED).
 */
export function evaluateCompile(subject){
  const s=isObject(subject)?subject:{},pkg=openPackage(s),record=s.compile,codes=[],contract=isObject(s.run?.contract)?s.run.contract:{},bindings=bindingsOf(contract);
  const indicatorBytes=pkg.readable('indicator.pine')?bytesOf(pkg.files['indicator.pine']):null,indicatorSha=indicatorBytes?hash(indicatorBytes):null;
  if(!compileShapeOk(record)||record.export_id!==s.export_id)codes.push('BI_COMPILE_EVIDENCE_MISSING');
  else{
    if(indicatorSha===null||record.indicator_sha256!==indicatorSha)codes.push('BI_COMPILE_SOURCE_MISMATCH');
    if(record.errors.length>0||record.unresolved_references>0||record.collisions>0||record.duplicate_bindings>0)codes.push('BI_COMPILE_ERRORS');
    const expected=sortedBy(bindings.map(binding=>({slot:binding.slot,pine_variable:binding.pine_variable})),'slot');
    const mapped=sortedBy(record.mapping_check.map(item=>isObject(item)?{slot:item.slot,pine_variable:item.pine_variable}:null).filter(present),'slot');
    if(!same(mapped,expected)||mapped.length!==record.mapping_check.length)codes.push('BI_SLOT_BINDING_MISMATCH');
    if(!record.warnings.every(warningReviewed))codes.push('BI_COMPILE_WARNINGS_UNREVIEWED');
  }
  const original=contract.source;
  if(typeof original!=='string'||hash(original)!==contract.source_hash||!isObject(pkg.binding)||pkg.binding.source_hash!==contract.source_hash)codes.push('BI_SOURCE_HASH_MISMATCH');
  const indicatorJson=pkg.json['indicator.json'];
  if(exitVersionUntemplated(pkg.binding))codes.push('BI_EXIT_VERSION_UNSUPPORTED');
  else if(!logicIntact({original,indicator:pkg.readable('indicator.pine')?textOf(pkg.files['indicator.pine']):null,edits:isObject(indicatorJson)?indicatorJson.edits:null,
    inputs:pkg.json['inputs.json'],bindings,assembleFrom:prefix=>assembledIndicator(prefix,pkg.binding,contract,pkg.json['inputs.json'])}))codes.push('BI_SOURCE_LOGIC_CHANGED');
  if(!nativeIsolationProven(s.native_alert_isolation))codes.push('BI_NATIVE_ALERT_ISOLATION_UNPROVEN');
  return outcome('C2',codes);
}

/* ---- Gate C3: provenance (section 5.3) ---- */

/** The binding fields that must equal the quant_jobs row and its immutable contract. library_versions is the value frozen in the
 * export row at build (subject.export.library_versions), never the current LIBRARY_VERSIONS constant: a later version bump cannot
 * change what an old package is compared with, and a missing frozen value is a mismatch. library_record_ref names the run and the
 * SHA-256 of its stored result (the frozen QR-1 record). engine_hash, fixture, exit_version, created_at and alert_source have their
 * own checks; holdout_boundary_ref is compared with the registered boundary in B0. */
function derivedBinding(run,libraryVersions){
  const contract=run.contract,lock=contract.input_lock,members=sortedBy(list(contract.snapshot?.membership).map(member=>isObject(member)?
    {pine_import_id:member.pine_import_id,source_version:member.source_version,source_hash:member.source_hash}:null).filter(present),'pine_import_id');
  return {owner_id:run.owner_id,bot_id:run.bot_id,run_id:run.run_id,contract_hash:run.contract_hash,submission_hash:run.submission_hash,
    deployment_id:contract.deployment_id,pine_import_id:contract.pine_import_id,source_version:contract.source_version,source_hash:contract.source_hash,
    baseline_snapshot_hash:contract.baseline_snapshot_hash,input_lock_hash:lock?.lock_hash,
    slot_bindings:sortedBy(bindingsOf(contract).map(item=>({slot:item.slot,input_id:item.input_id,pine_variable:item.pine_variable})),'slot'),
    bridge_domains:{atr_multiplier:lock?.domains?.atr_multiplier,rr:lock?.domains?.rr},effective_input_hash:effectiveInputHash(contract),
    policy_version:contract.policy_version,policy_hash:contract.snapshot?.policy_hash,capital:contract.capital,
    ledger_initialization:contract.ledger_initialization,model:contract.model,cost_model_version:contract.model?.version,
    dataset_ref:datasetRef(contract.dataset),split:contract.split,rules:contract.rules,acceptance_blockers:contract.acceptance_blockers,
    library_versions:isObject(libraryVersions)?libraryVersions:undefined,library_record_ref:{run_id:run.run_id,result_sha256:digest(run.result)},
    market:marketOf(contract.snapshot?.market),mode:members.length===1?'ONE_PINE':'MULTI_PINE',pine_count:members.length,membership:members};
}
function bindingMismatch(binding,run,libraryVersions){
  const normal={...binding,slot_bindings:sortedBy(binding.slot_bindings,'slot'),membership:sortedBy(binding.membership,'pine_import_id')};
  return Object.entries(derivedBinding(run,libraryVersions)).some(([key,value])=>!same(normal[key],value));
}
function gridOf(contract,name){const grid=contract.input_lock?.domains?.[name];return Array.isArray(grid)&&grid.length>0&&grid.every(finite)?grid:null;}
function domainDeclared(declared,grid){
  return isObject(declared)&&Number(declared.min)===grid[0]&&Number(declared.max)===grid[grid.length-1]&&(grid.length<2||Math.abs(Number(declared.step)-(grid[1]-grid[0]))<1e-9);
}
/** Slots, values and domains of inputs.json against the frozen run. */
function inputsCodes(inputs,run,selected){
  const codes=[],contract=run.contract,bindings=bindingsOf(contract);
  if(!isObject(inputs)||!Array.isArray(inputs.source_inputs)||!isObject(inputs.bridge)||!Array.isArray(inputs.fixed_inputs))return ['BI_INPUTS_MISMATCH'];
  const slots=inputs.source_inputs.filter(isObject),distinct=values=>new Set(values).size===values.length;
  const limit=inputs.source_inputs.length>8||slots.length!==inputs.source_inputs.length||!distinct(slots.map(item=>item.input_id))||
    !distinct(slots.map(item=>item.slot))||!distinct(slots.map(item=>item.pine_variable))||!same(Object.keys(inputs.bridge).sort(),['atr_multiplier','rr']);
  if(limit)codes.push('BI_SLOT_LIMIT');
  let mismatch=false,outOfDomain=false;
  const parameters=isObject(selected?.parameters)?selected.parameters:{};
  if(!limit){
    if(inputs.run_id!==run.run_id||inputs.source_hash!==contract.source_hash||inputs.effective_input_hash!==effectiveInputHash(contract))mismatch=true;
    const shape=items=>sortedBy(items.map(item=>({slot:item.slot,input_id:item.input_id,pine_variable:item.pine_variable})),'slot');
    if(!same(shape(slots),shape(bindings)))mismatch=true;
  }
  for(const slot of slots){
    const binding=bindings.find(item=>item.input_id===slot.input_id),grid=binding?gridOf(contract,binding.pine_variable):null;
    if(!binding||!grid)continue;
    const after=decimalNumber(slot.after);
    if(!['int','float'].includes(binding.type)||!grid.includes(after)||(binding.type==='int'&&!Number.isInteger(after)))outOfDomain=true;
    if(!limit&&(after!==parameters[binding.pine_variable]||decimalNumber(slot.before)!==binding.effective_value||slot.kind!==binding.type||!domainDeclared(slot.domain,grid)))mismatch=true;
  }
  for(const name of ['atr_multiplier','rr']){
    const entry=inputs.bridge[name],grid=gridOf(contract,name);
    if(!isObject(entry)||!grid){if(!limit)mismatch=true;continue;}
    const after=decimalNumber(entry.after);
    if(!grid.includes(after))outOfDomain=true;
    if(!limit&&(after!==parameters[name]||decimalNumber(entry.before)!==contract.input_lock?.selection?.bridge?.[name]||!domainDeclared(entry.domain,grid)))mismatch=true;
  }
  if(mismatch)codes.push('BI_INPUTS_MISMATCH');
  if(outOfDomain)codes.push('BI_INPUT_OUT_OF_DOMAIN');
  const fixed=sortedBy(fixedOf(contract).map(item=>({input_id:item.input_id,pine_variable:item.pine_variable,value:item.effective_value})),'input_id');
  if(!same(sortedBy(inputs.fixed_inputs,'input_id'),fixed))codes.push('BI_FIXED_INPUT_CHANGED');
  return codes;
}
function riskCodes(profile,contract,hardLimits){
  const codes=[],policy=contract.snapshot?.policy;
  if(!isObject(profile)||profile.policy_version!==contract.policy_version||profile.policy_hash!==contract.snapshot?.policy_hash||!same(profile.policy,policy))codes.push('BI_POLICY_SNAPSHOT_MISMATCH');
  const limits=isObject(profile)&&isObject(profile.limits)?profile.limits:null;
  if(!limits||!isObject(hardLimits)||Object.keys(hardLimits).length===0)codes.push('BI_RISK_RELAXATION');
  else for(const [name,bound] of Object.entries(hardLimits)){
    const value=decimalNumber(limits[name]),min=isObject(bound)&&present(bound.min)?decimalNumber(bound.min):-Infinity,max=isObject(bound)&&present(bound.max)?decimalNumber(bound.max):Infinity;
    if(!isObject(bound)||!(value>=min)||!(value<=max)){codes.push('BI_RISK_RELAXATION');break;}
  }
  return codes;
}
/** Digests of the stored steps of the selected candidate: the candidate, sensitivity and cost-stress steps, and the holdout step. */
const storedStepDigests=selected=>isObject(selected)?{steps:digest({candidate:{parameters:selected.parameters,result:selected.result},sensitivity:selected.sensitivity,cost_stress:selected.cost_stress}),
  holdout:digest({test:selected.test})}:{steps:null,holdout:null};
/**
 * Trace files reproduce the stored steps (5.3). The evaluator, not this module, replays the stored steps and writes one
 * reproduction record per trace file {path, sha256, steps_digest, holdout_digest}. The record must name the packaged file
 * bytes and carry the digest of the stored steps. An absent, duplicated or different record gives steps:false; an absent or
 * duplicated record, or a different holdout digest, also gives holdout:false (BI_RESULT_MISMATCH and HOLDOUT_MISMATCH together).
 */
function traceReproduced(pkg,selected,reproduction){
  const stored=storedStepDigests(selected),records=list(reproduction).filter(isObject);
  let steps=true,holdout=true;
  for(const path of TRACE_FILES){
    const matches=records.filter(item=>item.path===path),record=matches.length===1?matches[0]:null,bytes=pkg.readable(path)?bytesOf(pkg.files[path]):null;
    if(record===null||bytes===null||stored.steps===null||record.sha256!==hash(bytes)||record.steps_digest!==stored.steps)steps=false;
    if(record===null||stored.holdout===null||record.holdout_digest!==stored.holdout)holdout=false;
  }
  return {steps,holdout};
}
function resultCodes(pkg,selected,reproduction){
  const codes=[],metricsFile=pkg.json['quant-data/metrics.json'],validation=pkg.json['quant-data/validation.json'],traces=traceReproduced(pkg,selected,reproduction);
  // Win Rate is not in derive.js metrics(). Where the shipped or the stored value is present, both must be equal (absent and null are equal).
  const rate=part=>isObject(part)&&Object.hasOwn(part,'win_rate')?part.win_rate:null;
  const partOk=(shipped,stored)=>isObject(shipped)&&isObject(stored)&&same(metrics(shipped),metrics(stored))&&same(rate(shipped),rate(stored));
  const metricsOk=isObject(metricsFile)&&isObject(selected)&&partOk(metricsFile.train,selected.result?.train)&&
    partOk(metricsFile.validation,selected.result?.validation)&&partOk(metricsFile.test,selected.test);
  const stepsOk=isObject(validation)&&isObject(selected)&&same(validation.candidate,{parameters:selected.parameters,result:selected.result})&&
    same(validation.sensitivity,selected.sensitivity)&&same(validation.cost_stress,selected.cost_stress);
  if(!metricsOk||!stepsOk||!traces.steps)codes.push('BI_RESULT_MISMATCH');
  if(!isObject(validation)||!isObject(selected)||!same(validation.holdout,{test:selected.test})||!traces.holdout)codes.push('HOLDOUT_MISMATCH');
  return codes;
}
/** Section 4.3 "Data window": spot-dataset-v1 metadata of the Binance Spot BTCUSDT 1m window. The row names BI_MARKET_SCOPE_INVALID
 * for the market and BI_DATASET_UNAVAILABLE for the data window; it names no code for a gap, a duplicate or an open bar, so
 * those use BI_DATASET_UNAVAILABLE. */
function dataWindowCodes(metadata,dataset){
  const meta=isObject(metadata)?metadata:null,ref=isObject(dataset)?dataset:{};
  if(meta===null)return ['BI_DATASET_UNAVAILABLE'];
  const codes=[];
  if(meta.venue!==MARKET.broker||meta.market!=='SPOT'||meta.symbol!==MARKET.symbol||meta.timeframe!==MARKET.timeframe)codes.push('BI_MARKET_SCOPE_INVALID');
  const whole=[meta.start_time,meta.end_time,meta.total_bars,meta.warmup_bars,meta.cutoff].every(Number.isSafeInteger);
  const ok=meta.version===DATASET_METADATA_VERSION&&meta.source===DATASET_SOURCE&&whole&&meta.start_time%MINUTE===0&&meta.end_time%MINUTE===0&&meta.end_time<=meta.cutoff&&meta.end_time-meta.start_time===meta.total_bars*MINUTE&&meta.warmup_bars>=0&&
    meta.warmup_bars<=meta.total_bars&&meta.start_time===ref.start_time&&meta.end_time===ref.end_time+MINUTE&&meta.total_bars===ref.bar_count&&meta.warmup_bars===ref.warmup_bars;
  if(!ok)codes.push('BI_DATASET_UNAVAILABLE');
  return codes;
}
/**
 * C3. subject: {run, export:{library_versions}, files, deployment:{exit_version}, dataset:{readable, digest, metadata}, hard_limits,
 * fixture_request, trace_reproduction}. export.library_versions is the value frozen in the export row at build; a missing value is
 * BI_BINDING_MISMATCH. The claimed binding is the manifest binding of the package. dataset.metadata is the spot-dataset-v1
 * metadata (see dataWindowCodes). trace_reproduction is the evaluator's record per trace file (see traceReproduced); this
 * module compares digests and never replays a trace itself.
 */
export function evaluateProvenance(subject){
  const s=isObject(subject)?subject:{},pkg=openPackage(s),run=s.run,codes=[];
  if(!isObject(run)||!isObject(run.contract)||!isObject(pkg.binding)||run.contract_hash!==digest(run.contract))return outcome('C3',['BI_PROVENANCE_UNRESOLVED']);
  const contract=run.contract,binding=pkg.binding,selected=selectedOf(run.result);
  if(bindingMismatch(binding,run,isObject(s.export)?s.export.library_versions:undefined))codes.push('BI_BINDING_MISMATCH');
  codes.push(...inputsCodes(pkg.json['inputs.json'],run,selected));
  codes.push(...riskCodes(pkg.json['risk-profile.json'],contract,s.hard_limits));
  codes.push(...resultCodes(pkg,selected,s.trace_reproduction));
  const dataset=isObject(s.dataset)?s.dataset:{};
  if(dataset.readable!==true)codes.push('BI_DATASET_UNAVAILABLE');
  else{
    if(!text(dataset.digest)||dataset.digest!==datasetDigest(contract.dataset))codes.push('BI_DATASET_HASH_MISMATCH');
    codes.push(...dataWindowCodes(dataset.metadata,contract.dataset));
  }
  if(!sha(contract.engine_hash)||binding.engine_hash!==contract.engine_hash||pkg.manifest?.evidence?.engine_hash!==contract.engine_hash)codes.push('BI_ENGINE_HASH_MISMATCH');
  if(!ADMITTED_COST_MODELS.includes(binding.cost_model_version)||!ADMITTED_COST_MODELS.includes(contract.model?.version))codes.push('BI_COST_MODEL_UNSUPPORTED');
  const deployment=isObject(s.deployment)?s.deployment:{};
  if(!SUPPORTED_EXIT_VERSIONS.includes(binding.exit_version)||binding.exit_version!==deployment.exit_version)codes.push('BI_EXIT_VERSION_UNSUPPORTED');
  const engineering=contract.scope===ENGINEERING_SCOPE||s.fixture_request===true;
  if((engineering&&(binding.fixture!==true||pkg.manifest.fixture!==true))||binding.fixture!==pkg.manifest.fixture)codes.push('BI_FIXTURE_LABEL_MISSING');
  return outcome('C3',codes);
}

/* ---- Gate C4: validation, evidence and freshness (section 5.4) ---- */

const sameMembers=(a,b)=>same(sortedBy(a,'pine_import_id').map(item=>item.pine_import_id),sortedBy(b,'pine_import_id').map(item=>item.pine_import_id));
function versionsCurrent(binding,current){
  const members=list(binding.membership).filter(isObject),now=list(current.membership).filter(isObject);
  if(members.length===0||members.length!==list(binding.membership).length)return false;
  const own=members.find(item=>item.pine_import_id===binding.pine_import_id);
  const match=(item,other)=>isObject(other)&&item.source_version===other.source_version&&item.source_hash===other.source_hash;
  return members.every(item=>match(item,now.find(other=>other.pine_import_id===item.pine_import_id)))&&
    isObject(own)&&own.source_version===binding.source_version&&own.source_hash===binding.source_hash;
}
/** Freshness tuple F against current server state, in the order of FRESHNESS_ORDER. Unknown or unreadable state differs. */
export function freshnessCodes(binding,current){
  const b=isObject(binding)?binding:{},c=isObject(current)?current:{},codes=[];
  if(!versionsCurrent(b,c))codes.push('BI_SOURCE_VERSION_STALE');
  if(!sameMembers(list(b.membership),list(c.membership))||list(b.membership).length===0)codes.push('BI_MEMBERSHIP_CHANGED');
  if(!text(b.policy_version)||!sha(b.policy_hash)||b.policy_version!==c.policy_version||b.policy_hash!==c.policy_hash)codes.push('BI_POLICY_SNAPSHOT_MISMATCH');
  if(!text(b.deployment_id)||b.deployment_id!==c.deployment_id)codes.push('BI_DEPLOYMENT_CHANGED');
  if(!sha(b.input_lock_hash)||b.input_lock_hash!==c.input_lock_hash)codes.push('BI_SELECTION_CHANGED');
  if(c.dataset_available!==true)codes.push('BI_DATASET_UNAVAILABLE');
  return codes;
}
const record=(evidence,key)=>isObject(evidence)&&isObject(evidence[key])?evidence[key]:null;
const percentFull=value=>value===100;
function evidenceCodes(evidence,binding,current){
  const codes=[],alignment=record(evidence,'dataset_alignment'),parity=record(evidence,'native_parity'),bridge=record(evidence,'bridge_parity'),
    repaint=record(evidence,'repaint'),baseline=record(evidence,'quant_baseline');
  if(!alignment||!finite(alignment.matched_percent)||!count(alignment.unmatched_bars)||!count(alignment.future_leakage))codes.push('BI_DATASET_ALIGNMENT_MISSING');
  else if(!percentFull(alignment.matched_percent)||alignment.unmatched_bars!==0||alignment.future_leakage!==0)codes.push('BI_DATASET_ALIGNMENT_FAILED');
  const sample=isObject(parity?.sample)?parity.sample:null;
  if(!parity||!sample||!finite(parity.match_percent)||!count(parity.missing_events)||!count(parity.additional_events)||!Number.isSafeInteger(parity.shift_bars)||
    !['warmup_bars','lookback','closed_bars','native_events','buy_events','exit_events'].every(key=>count(sample[key])))codes.push('BI_PARITY_EVIDENCE_MISSING');
  else{
    if(sample.warmup_bars<Math.max(500,5*sample.lookback)||sample.closed_bars<2000||sample.native_events<100||sample.buy_events<30||sample.exit_events<30)codes.push('BI_PARITY_SAMPLE_FLOOR_NOT_MET');
    if(!percentFull(parity.match_percent)||parity.missing_events!==0||parity.additional_events!==0||parity.shift_bars!==0)codes.push('BI_NATIVE_SIGNAL_PARITY_FAILED');
  }
  if(!bridge||!finite(bridge.match_percent)||!count(bridge.sl_tp_diff_ticks)||!text(bridge.exit_version))codes.push('BI_PARITY_EVIDENCE_MISSING');
  else if(!percentFull(bridge.match_percent)||bridge.sl_tp_diff_ticks!==0||bridge.exit_version!==binding.exit_version)codes.push('BI_BRIDGE_PARITY_FAILED');
  if(!repaint||!count(repaint.observations)||!count(repaint.changed_flags))codes.push('BI_REPAINT_EVIDENCE_MISSING');
  else{
    if(repaint.changed_flags>0)codes.push('BI_REPAINT_FLAGS_CHANGED');
    if(repaint.observations<100)codes.push('BI_REPAINT_EVIDENCE_MISSING');
  }
  if(!baseline||!finite(baseline.coverage_percent)||!finite(baseline.decision_match_percent)||!finite(baseline.quantity_step_diff)||!finite(baseline.cash_diff_minor_units)||
    !percentFull(baseline.coverage_percent)||!percentFull(baseline.decision_match_percent)||baseline.quantity_step_diff!==0||Math.abs(baseline.cash_diff_minor_units)>1)codes.push('BI_QUANT_BASELINE_FAILED');
  const scope={source_hash:binding.source_hash,effective_input_hash:binding.effective_input_hash,dataset_digest:datasetDigest(binding.dataset_ref),engine_hash:binding.engine_hash};
  if([alignment,parity,bridge,repaint,baseline].some(item=>item&&!same(item.scope,scope)))codes.push('BI_PARITY_SCOPE_MISMATCH');
  codes.push(...freshnessCodes(binding,current));
  return codes;
}
function bridgePairOutOfBounds(inputs,contract,bounds){
  return ['atr_multiplier','rr'].some(name=>{
    const after=decimalNumber(inputs?.bridge?.[name]?.after),grid=gridOf(contract,name),bound=isObject(bounds)?bounds[name]:null;
    return !finite(after)||!grid||!grid.includes(after)||!isObject(bound)||!(after>=decimalNumber(bound.min))||!(after<=decimalNumber(bound.max));
  });
}
/** The evidence record whose SHA-256 of canonical JSON a clearance of that blocker must carry (4.4). */
const CLEARANCE_EVIDENCE=Object.freeze({VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED:'native_parity',CUSTOM_REPAINT_EVIDENCE_REQUIRED:'repaint'});
function clearanceCodes(contract,selected,run,exportId,clearances,evidence,internal){
  const blockers=contract.acceptance_blockers;
  if(!Array.isArray(blockers)||!blockers.every(text))return ['BLOCKERS_UNKNOWN'];
  const parameterHash=digest(selected?.parameters);
  const proofHash=name=>{const proof=Object.hasOwn(CLEARANCE_EVIDENCE,name)?record(evidence,CLEARANCE_EVIDENCE[name]):null;return proof===null?null:digest(proof);};
  const cleared=new Set(list(clearances).filter(item=>isObject(item)&&item.run_id===run.run_id&&text(exportId)&&item.export_id===exportId&&sha(item.parameter_hash)&&
    item.parameter_hash===parameterHash&&sha(item.evidence_hash)&&item.evidence_hash===proofHash(item.blocker)).map(item=>item.blocker));
  // G6 for export: the frozen list minus the cleared candidate blockers, and on the internal path only minus MULTI_PINE_REQUIRES_APP_3B (RC-11).
  return blockers.some(name=>!(CANDIDATE_BLOCKER_SET.has(name)&&cleared.has(name))&&!(internal&&name===MULTI_PINE_BLOCKER))?['ACCEPTANCE_BLOCKERS_PRESENT']:[];
}
/**
 * C4. subject: {export_id, run, files, evidence, current, bridge_bounds, clearances, internal}. On the EXPORT_INTERNAL path only
 * (see internalPath), MULTI_PINE_REQUIRES_APP_3B does not fail G6 for export. evidence holds the records
 * dataset_alignment {matched_percent, unmatched_bars, future_leakage}, native_parity {match_percent, missing_events,
 * additional_events, shift_bars, sample:{warmup_bars, lookback, closed_bars, native_events, buy_events, exit_events}},
 * bridge_parity {match_percent, sl_tp_diff_ticks, exit_version}, repaint {observations, changed_flags} and quant_baseline
 * {coverage_percent, decision_match_percent, quantity_step_diff, cash_diff_minor_units}; each names scope {source_hash,
 * effective_input_hash, dataset_digest, engine_hash}. current is the current server state {deployment_id, membership,
 * policy_version, policy_hash, input_lock_hash, dataset_available, bot_owner_id}. clearances are the append-only
 * {blocker, run_id, export_id, parameter_hash, evidence_hash} records. A clearance clears the parity blocker only when its
 * evidence_hash equals the digest of evidence.native_parity, and the repaint blocker only when it equals the digest of
 * evidence.repaint. A missing quant_baseline record is BI_QUANT_BASELINE_FAILED and not retryable: the contract names no
 * missing-evidence code for it and the retryable list is closed (6.1). Without a run or a packaged binding the package
 * cannot be resolved: BI_PROVENANCE_UNRESOLVED.
 */
export function evaluateValidation(subject){
  const s=isObject(subject)?subject:{},pkg=openPackage(s),run=s.run;
  if(!isObject(run)||!isObject(run.contract)||!isObject(pkg.binding))return outcome('C4',['BI_PROVENANCE_UNRESOLVED']);
  const codes=evidenceCodes(s.evidence,pkg.binding,s.current);
  if(bridgePairOutOfBounds(pkg.json['inputs.json'],run.contract,s.bridge_bounds))codes.push('BI_BRIDGE_PAIR_OUT_OF_BOUNDS');
  codes.push(...clearanceCodes(run.contract,selectedOf(run.result),run,s.export_id,s.clearances,s.evidence,internalPath(s.internal,run.contract,pkg.binding.mode)));
  return outcome('C4',codes);
}

/* ---- Gate Q: qualification record (section 5.5) ---- */

/** Names of the attempt metadata fields (subject.attempt) that are unusable. Bad caller metadata is not a package failure. */
const attemptFields=attempt=>{
  const a=isObject(attempt)?attempt:{};
  return [!text(a.attempt_id)&&'attempt.attempt_id',!sha(a.validator_engine_hash)&&'attempt.validator_engine_hash',!utc(a.validated_at_utc)&&'attempt.validated_at_utc'].filter(Boolean);
};
/** Q passes only when C1 to C4 passed in this attempt (B0 is a build-time gate). It then builds the append-only ql4c_validation
 * record from subject.attempt {attempt_id, validator_engine_hash, validated_at_utc}; the caller supplies the time, this module
 * has no clock. Bad attempt metadata refuses the call (a refusal result): no gate state, no transition, no attempt recorded,
 * and never EXPORT_REFUSED for the package. */
export function evaluateQualification(subject,results){
  const s=isObject(subject)?subject:{},gates=list(results).filter(isObject),bad=attemptFields(s.attempt);
  if(bad.length)return refusal('Q',bad);
  const found=QUALIFYING_GATES.map(name=>gates.find(item=>item.gate===name&&item.state==='PASS'));
  if(found.includes(undefined))return notReached('Q');
  const attempt=s.attempt,manifest=openPackage(s).manifest,fixture=manifest?.fixture;
  if(!text(s.export_id)||!sha(s.package_hash)||!sha(s.binding_hash)||typeof fixture!=='boolean')return outcome('Q',['BI_BINDING_INCOMPLETE']);
  const record=Object.freeze({export_id:s.export_id,package_hash:s.package_hash,binding_hash:s.binding_hash,attempt_id:attempt.attempt_id,
    gate_results:Object.freeze(found.map(item=>Object.freeze({gate:item.gate,state:item.state,codes:item.codes}))),
    validator_engine_hash:attempt.validator_engine_hash,fixture,validated_at_utc:attempt.validated_at_utc});
  return outcome('Q',[],{record});
}

/* ---- stored status transitions (section 6.1) ---- */

/**
 * Every transition not listed in the contract is refused with BI_TRANSITION_INVALID. from is null (terminal run, no export
 * row) or a stored status. event is {kind:'BUILD', b0_pass} from null, or {kind:'ATTEMPT', pass, codes, mode, attempt_no}
 * from EXPORT_CANDIDATE. A retryable-only failure keeps EXPORT_CANDIDATE (attempt recorded) until the attempt limit; any
 * non-retryable code refuses; a fifth failing attempt gives EXPORT_REFUSED with BI_ATTEMPTS_EXHAUSTED.
 */
export function transition(from,event){
  const refuse=()=>Object.freeze({ok:false,to:null,codes:Object.freeze(['BI_TRANSITION_INVALID'])});
  const move=(to,codes=[])=>Object.freeze({ok:true,to,codes:Object.freeze([...codes])});
  if(!isObject(event))return refuse();
  if(event.kind==='BUILD'){
    if(from!==null||typeof event.b0_pass!=='boolean')return refuse();
    return move(event.b0_pass?STATUS.EXPORT_CANDIDATE:null);
  }
  if(event.kind!=='ATTEMPT'||from!==STATUS.EXPORT_CANDIDATE)return refuse();
  const {pass,codes,mode,attempt_no:attempt}=event;
  if(!Number.isSafeInteger(attempt)||attempt<1||attempt>MAX_VALIDATION_ATTEMPTS||typeof pass!=='boolean'||!MODES.includes(mode)||
    !Array.isArray(codes)||!codes.every(code=>typeof code==='string'&&CODE_PATTERN.test(code)))return refuse();
  if(pass)return codes.length===0?move(mode==='ONE_PINE'?STATUS.EXPORT_VALIDATED:STATUS.EXPORT_INTERNAL):refuse();
  if(codes.length===0)return refuse();
  if(!codes.every(isRetryable))return move(STATUS.EXPORT_REFUSED,codes);
  return attempt>=MAX_VALIDATION_ATTEMPTS?move(STATUS.EXPORT_REFUSED,['BI_ATTEMPTS_EXHAUSTED']):move(STATUS.EXPORT_CANDIDATE,codes);
}

/* ---- derived freshness and READY (sections 6.2, 6.3) ---- */

/** Freshness is derived at read time and never written over the status. A REPLAY_MISMATCH event forces STALE and is listed
 * first (6.2, OD-15, RC-8); every differing F code follows in the C4 order. replay_mismatch is a required boolean: an absent,
 * null, unreadable or non-boolean replay state refuses the read with BI_REPLAY_STATE_UNAVAILABLE (a refusal result with no
 * fresh, no state and no code, fresh false). That state is never labelled REPLAY_MISMATCH and never treated as false. The
 * refusal code is not a C4 freshness code: FRESHNESS_ORDER does not hold it and C4 never emits it. */
export function freshness(input){
  const {binding,current,replay_mismatch:replay}=isObject(input)?input:{};
  if(typeof replay!=='boolean')return Object.freeze({refused:REPLAY_STATE_UNAVAILABLE,fields:Object.freeze(['replay_mismatch']),fresh:false,state:null,code:null,codes:Object.freeze([])});
  const codes=[...(replay?['REPLAY_MISMATCH']:[]),...freshnessCodes(binding,current)];
  return Object.freeze({fresh:codes.length===0,state:codes.length===0?'FRESH':'STALE',code:codes[0]??null,codes:Object.freeze(codes)});
}
/** READY = status EXPORT_VALIDATED AND fresh AND mode ONE_PINE AND fixture false AND requester owns the Bot. */
export function isReady(input){
  const {status,fresh,mode,fixture,owns_bot:ownsBot}=isObject(input)?input:{};
  return status===STATUS.EXPORT_VALIDATED&&fresh===true&&mode==='ONE_PINE'&&fixture===false&&ownsBot===true;
}
/** The read-time view of one export: stored status, derived freshness and the READY predicate. */
export function readState(input){
  const {status,binding,current,replay_mismatch:replay,requester_owner_id:requester}=isObject(input)?input:{};
  const view=freshness({binding,current,replay_mismatch:replay}),b=isObject(binding)?binding:{},c=isObject(current)?current:{};
  if(isRefused(view))return Object.freeze({refused:view.refused,fields:view.fields,status:status??null,fresh:false,state:null,code:null,codes:view.codes,ready:false});
  const ready=isReady({status,fresh:view.fresh,mode:b.mode,fixture:b.fixture,owns_bot:text(requester)&&c.bot_owner_id===requester});
  return Object.freeze({status:status??null,fresh:view.fresh,state:view.state,code:view.code,codes:view.codes,ready});
}

/* ---- diagnostic bundle (section 5.0, 11.1 item 16) ---- */

/** The only export an unsuccessful or unqualified run may have: labelled DIAGNOSTIC_ONLY, no parameters, no inputs block. */
export function diagnosticBundle(run){
  const r=isObject(run)?run:{},result=isObject(r.result)?r.result:null;
  return Object.freeze({label:'DIAGNOSTIC_ONLY',actionable:false,package:null,run_id:text(r.run_id)?r.run_id:null,status:text(r.status)?r.status:null,
    ...classify({status:r.status,diagnostic:r.diagnostic??null,holdoutTooFewTrades:holdoutTooFewTrades(result)}),
    completion_reason:text(result?.completion_reason)?result.completion_reason:null,
    candidate_count:Number.isSafeInteger(result?.candidate_count)?result.candidate_count:null,reason_counts:candidateAggregates(result?.candidates).reason_counts});
}

/* ---- full evaluation of one validation attempt ---- */

/**
 * Evaluates one validation attempt: C1 to C4 and then Q, in order. B0 is a build-time gate (6.1) and is never re-run here; the
 * attempt-time evaluation has no B0 outcome, no diagnostic bundle and no build decision. A hard failure makes every later gate
 * NOT_REACHED; a retryable-only failure does not, so one attempt reports all missing evidence. Also subject.attempt_no, a safe
 * integer from 1 to 5, for the status result.
 *
 * The call is refused (a refusal result: refused, fields, no gates, next null, status null, record null, nothing recorded) when
 * the run is absent or foreign (refused NOT_FOUND, nothing else leaks) or when caller input is unusable: current_rules absent,
 * replay_mismatch not a boolean (refused BI_REPLAY_STATE_UNAVAILABLE, which wins when replay_mismatch is among the bad fields),
 * bad attempt metadata, or attempt_no not a safe integer from 1 to 5 (refused INPUT_INVALID). Otherwise it returns the gate
 * list, the union of codes, the stored status the attempt leads to and the READY view (false for any package that is not yet
 * validated, fresh, one-Pine, non-fixture and owned). The Q record is returned only when the attempt passed and its stored
 * transition is allowed (next.ok), so no caller can append a ql4c_validation record without a status event.
 */
export function evaluatePackage(subject){
  const s=isObject(subject)?subject:{},run=s.run;
  const refused=(reason,fields)=>Object.freeze({version:PACKAGE_GATE_VERSION,refused:reason,fields:Object.freeze([...fields]),pass:false,gates:Object.freeze([]),codes:Object.freeze([]),
    limitations:Object.freeze([]),next:null,status:null,record:null,ready:false});
  if(!text(s.owner_id)||!isObject(run)||run.owner_id!==s.owner_id)return refused('NOT_FOUND',[]);
  const attemptNoOk=Number.isSafeInteger(s.attempt_no)&&s.attempt_no>=1&&s.attempt_no<=MAX_VALIDATION_ATTEMPTS;
  const fields=[...(isObject(s.current_rules)?[]:['current_rules']),...(typeof s.replay_mismatch==='boolean'?[]:['replay_mismatch']),...attemptFields(s.attempt),
    ...(attemptNoOk?[]:['attempt_no'])];
  if(fields.length)return refused(fields.includes('replay_mismatch')?REPLAY_STATE_UNAVAILABLE:INPUT_INVALID,fields);
  const gates=[];
  let blocked=false;
  for(const [name,gate] of [['C1',evaluateStructure],['C2',evaluateCompile],['C3',evaluateProvenance],['C4',evaluateValidation]]){
    if(blocked){gates.push(notReached(name));continue;}
    const result=gate(s);
    gates.push(result);
    if(isHardFailure(result))blocked=true;
  }
  gates.push(gates.every(item=>item.pass)?evaluateQualification(s,gates):notReached('Q'));
  const codes=unique(gates.flatMap(item=>item.codes)),pass=gates.every(item=>item.pass),binding=isObject(s.binding)?s.binding:{};
  const next=transition(STATUS.EXPORT_CANDIDATE,{kind:'ATTEMPT',pass,codes,mode:binding.mode,attempt_no:s.attempt_no});
  const status=next.ok?next.to:null;
  return Object.freeze({version:PACKAGE_GATE_VERSION,pass,gates:Object.freeze(gates),codes:Object.freeze(codes),limitations:Object.freeze(rulesLimitations(run.contract,s.current_rules)),
    next,status,record:next.ok&&pass?gates[4].record??null:null,
    ready:status!==null&&readState({status,binding:openPackage(s).binding??binding,current:s.current,replay_mismatch:s.replay_mismatch,requester_owner_id:s.owner_id}).ready});
}
