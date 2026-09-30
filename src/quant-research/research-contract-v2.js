import {canonical,fail,hash,keys} from '../pine-bridge/source.js';
import {FOUNDATION_LIMITS,validateDatasetMetadata,validateDatasetReference} from './foundation-contract.js';
import {strictJsonV2} from './foundation-contract-v2.js';

/** Pure contract layer for FOUNDATION research jobs that prepare their dataset under the worker lease.
 * The stored research contract (version ql3a-research-job-v2) freezes the requested range, the bar count and an
 * ordered content digest of the verified market rows. It holds no bars, no file references and no file digest.
 * The dataset binding, written once by the worker after it publishes the files, supplies the late references.
 * materializeExecutionContract joins both into the byte-shape the V1 managed contract had, so the evaluator
 * input does not change. This module reads no database, no file, no clock and no random source.
 */
export const RESEARCH_V2_VERSIONS=Object.freeze({contract:'ql3a-research-job-v2',execution:'ql3a-research-job-v1',request:'quant-foundation-research-v2',binding:'quant-research-dataset-binding-v1',digest:'pine-bar-content-digest-v1'});
export const DATASET_BINDING_STEP_ID='prepare:dataset';
export const DATASET_BINDING_KIND='PREPARE';

/** One row, one aggregate. The digest joins bar_time:content_hash lines with a line feed in bar_time order,
 * exactly as contentDigest does. chr(10) keeps the text independent of string-escape settings. The row filters
 * are cast-free and NULL-safe: a missing profile key or a bar time that differs from the row key counts as bad.
 * An empty range yields a NULL digest. Parameters: $1 first bar_time, $2 last bar_time, $3 data profile.
 */
export const CONTENT_DIGEST_SQL=`SELECT count(*)::int n,min(bar_time) first_time,max(bar_time) last_time,
 count(*) FILTER (WHERE provenance->>'profile' IS DISTINCT FROM $3::text
  OR bar->'time' IS DISTINCT FROM to_jsonb(bar_time)
  OR bar_time % 60000 <> 0
  OR content_hash !~ '^[a-f0-9]{64}$')::int bad,
 encode(sha256(convert_to(string_agg(bar_time::text||':'||content_hash,chr(10) ORDER BY bar_time),'UTF8')),'hex') digest
FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'
 AND bar_time>=$1 AND bar_time<=$2`;

const V=RESEARCH_V2_VERSIONS;
const MINUTE=60_000;
const MAX_TIME=8_640_000_000_000_000;
const HEX=/^[a-f0-9]{64}$/;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MODEL_PROFILE='closed-ohlcv-atr14-v1';
const SCOPE='SPT_CUSTOM_ENGINEERING_ONLY';
const BACKEND='quant-foundation-v1';
const TIMESTAMP_SEMANTICS='verified closed-bar timestamps; half-open index end is last timestamp plus one minute';
const LEDGER='Independent historical flat Paper simulation; live daily/streak counters are neither consumed nor reset.';
const BLOCKERS=['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED','CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'];
const CONTRACT_KEYS=['version','scope','owner_id','bot_id','deployment_id','pine_import_id','source_version','source','source_hash','baseline_snapshot_hash','snapshot','input_lock','plan','model','rules','engine_hash','dataset','split','capital','ledger_initialization','max_evaluations','acceptance_blockers','execution_backend'];
const DATASET_KEYS=['start_time','end_time','warmup_bars','bar_count','first_time','timestamp_semantics','content_digest','digest_version'];
const RULE_KEYS=['minimum_closed_trades_train','minimum_closed_trades_validation','minimum_closed_trades_test','maximum_drawdown_percent','sensitivity_max_drop_percentage_points'];
const REQUEST_KEYS=['version','owner_id','bot_id','kind','pending_dataset','engine_hash','snapshot_hash','budget'];
const PENDING_KEYS=['metadata','content_digest','digest_version'];
const BUDGET_KEYS=['candidates','max_evaluations','chunk_bars','max_runtime_ms','max_output_bytes','max_state_bytes'];
const BINDING_KEYS=['version','references','dataset_sha256','content_digest','bar_count','execution_contract_hash'];
const SIDECAR_KEYS=['sha256','bar_count','first_time','profile','price_tick','quantity_step'];
const INVALID_CONTRACT='INVALID_RESEARCH_CONTRACT_V2';
const INVALID_BINDING='RESEARCH_DATASET_BINDING_INVALID';
const UNVERIFIED_MARKET='VERIFIED_MARKET_DATA_REQUIRED';

const sha=value=>typeof value==='string'&&HEX.test(value);
const identifier=value=>typeof value==='string'&&IDENTIFIER.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Capital, price tick and quantity step are strictly positive. V1 enqueue reads capital through D(), which refuses
// magnitudes from 1e20 and text longer than 120 characters. A string keeps the plain form Decimal toFixed writes:
// digits with an optional fraction, no sign, no exponent, no blank and no leading zero.
const DECIMAL_LIMIT=1e20;
const DECIMAL_TEXT=/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;
const positive=value=>typeof value==='number'?Number.isFinite(value)&&value>0&&value<DECIMAL_LIMIT:typeof value==='string'&&value.length<=120&&DECIMAL_TEXT.test(value)&&/[1-9]/.test(value);
const need=ok=>{if(!ok)throw new Error('check');};
const clone=value=>JSON.parse(canonical(value));

const splitFor=(warmup,total)=>{const count=total-warmup;return {warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:total};};
const evaluationsFor=(plan,domains)=>plan.planned_candidates+2*Object.keys(domains).length+2+3;
const metadataFrom=dataset=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:dataset.start_time,end_time:dataset.end_time+MINUTE,warmup_bars:dataset.warmup_bars,total_bars:dataset.bar_count,cutoff:dataset.end_time+MINUTE,source:'binance-spot-klines-v1'});

/** Ordered content digest (pine-bar-content-digest-v1): sha256 hex of the UTF-8 lines bar_time:content_hash joined
 * by a line feed in strictly ascending bar_time order, with no trailing line feed. Rows must be bounded, ordered
 * and well formed; the function never sorts, repairs or skips a row.
 */
export function contentDigest(rows){
 if(!Array.isArray(rows)||rows.length<1||rows.length>FOUNDATION_LIMITS.admittedBars)throw fail(UNVERIFIED_MARKET);
 const lines=[];
 let previous=0;
 for(const row of rows){
  const time=row?.bar_time,digest=row?.content_hash;
  if(!Number.isSafeInteger(time)||time<=previous||!sha(digest))throw fail(UNVERIFIED_MARKET);
  lines.push(time+':'+digest);
  previous=time;
 }
 return hash(lines.join('\n'));
}

/** Exact-shape validation of the stored research contract. Returns a canonical copy and never mutates the input. */
export function validateResearchContractV2(value){
 try{
  strictJsonV2(value);
  keys(value,CONTRACT_KEYS);
  const d=value.dataset;
  keys(d,DATASET_KEYS);
  need(value.version===V.contract&&value.scope===SCOPE&&value.execution_backend===BACKEND);
  need(identifier(value.owner_id)&&identifier(value.bot_id));
  need(typeof value.deployment_id==='string'&&value.deployment_id.length>0&&typeof value.pine_import_id==='string'&&value.pine_import_id.length>0);
  need(integer(value.source_version,1,2147483647));
  need(typeof value.source==='string'&&sha(value.source_hash)&&hash(value.source)===value.source_hash);
  need(sha(value.baseline_snapshot_hash)&&sha(value.engine_hash));
  const {snapshot,input_lock:lock,plan,model,rules,capital}=value;
  need(plain(lock.selection)&&plain(lock.domains)&&sha(lock.lock_hash)&&canonical(snapshot.selection)===canonical(lock.selection));
  need(integer(plan.planned_candidates,1,FOUNDATION_LIMITS.candidates)&&Array.isArray(plan.candidates)&&plan.candidates.length===plan.planned_candidates);
  need(model.data_profile===MODEL_PROFILE&&positive(model.price_tick)&&positive(model.quantity_step));
  keys(rules,RULE_KEYS);
  need(RULE_KEYS.every(name=>typeof rules[name]==='number'&&Number.isFinite(rules[name])));
  keys(capital,['equity','cash']);
  need(positive(capital.equity)&&positive(capital.cash));
  need(value.ledger_initialization===LEDGER&&canonical(value.acceptance_blockers)===canonical(BLOCKERS));
  need(value.max_evaluations===evaluationsFor(plan,lock.domains));
  need(integer(d.start_time,1,MAX_TIME)&&integer(d.end_time,1,MAX_TIME)&&d.start_time%MINUTE===0&&d.end_time%MINUTE===0&&d.start_time<d.end_time);
  need(integer(d.bar_count,1,FOUNDATION_LIMITS.admittedBars)&&integer(d.warmup_bars,0,5000));
  need(d.first_time===d.start_time&&d.timestamp_semantics===TIMESTAMP_SEMANTICS&&sha(d.content_digest)&&d.digest_version===V.digest);
  // The metadata rules tie the range to the count (end minus start is bar_count minutes) and keep warmup below the count.
  validateDatasetMetadata(metadataFrom(d));
  need(canonical(value.split)===canonical(splitFor(d.warmup_bars,d.bar_count)));
 }catch{throw fail(INVALID_CONTRACT);}
 return clone(value);
}

/** Builds the stored research contract from the values an enqueue holds. Every derived field (bar count, split,
 * evaluation cap, ledger text, blockers) is computed here; the dataset carries only the range and the digest.
 * The caller supplies rules, engine_hash and content_digest so this module imports no engine or database code.
 */
export function buildResearchContractV2(input){
 let contract;
 try{
  const {owner_id,bot_id,deployment,source,snapshot,lock,plan,model,rules,capital,engine_hash,dataset}=input;
  const parts={owner_id,bot_id,deployment_id:deployment.deployment_id,pine_import_id:deployment.pine_import_id,source_version:deployment.source_version,source:source.source,source_hash:source.source_hash,baseline_snapshot_hash:deployment.snapshot_hash,snapshot,input_lock:lock,plan,model,rules,capital:{equity:capital.configuredEquity,cash:capital.configuredBalance},engine_hash,dataset:{start_time:dataset.start_time,end_time:dataset.end_time,warmup_bars:dataset.warmup_bars,content_digest:dataset.content_digest}};
  strictJsonV2(parts);
  need(plain(parts.snapshot)&&plain(parts.input_lock));
  const d=parts.dataset,total=1+(d.end_time-d.start_time)/MINUTE;
  contract={version:V.contract,scope:SCOPE,owner_id:parts.owner_id,bot_id:parts.bot_id,deployment_id:parts.deployment_id,pine_import_id:parts.pine_import_id,source_version:parts.source_version,source:parts.source,source_hash:parts.source_hash,baseline_snapshot_hash:parts.baseline_snapshot_hash,snapshot:{...parts.snapshot,selection:parts.input_lock.selection},input_lock:parts.input_lock,plan:parts.plan,model:parts.model,rules:parts.rules,engine_hash:parts.engine_hash,
   dataset:{start_time:d.start_time,end_time:d.end_time,warmup_bars:d.warmup_bars,bar_count:total,first_time:d.start_time,timestamp_semantics:TIMESTAMP_SEMANTICS,content_digest:d.content_digest,digest_version:V.digest},
   split:splitFor(d.warmup_bars,total),capital:parts.capital,ledger_initialization:LEDGER,max_evaluations:evaluationsFor(parts.plan,parts.input_lock.domains),acceptance_blockers:[...BLOCKERS],execution_backend:BACKEND};
 }catch{throw fail(INVALID_CONTRACT);}
 return validateResearchContractV2(contract);
}

/** Dataset metadata the worker publishes and the foundation request pins (spot-dataset-v1, half-open end). */
export function pendingMetadata(contract){
 return validateDatasetMetadata(metadataFrom(validateResearchContractV2(contract).dataset));
}

function requestFrom(contract,maxRuntimeMs){
 const d=contract.dataset;
 return {version:V.request,owner_id:contract.owner_id,bot_id:contract.bot_id,kind:'OPTIMIZE',pending_dataset:{metadata:metadataFrom(d),content_digest:d.content_digest,digest_version:d.digest_version},engine_hash:contract.engine_hash,snapshot_hash:contract.baseline_snapshot_hash,
  budget:{candidates:contract.plan.planned_candidates,max_evaluations:contract.max_evaluations,chunk_bars:Math.min(1000,d.bar_count),max_runtime_ms:maxRuntimeMs,max_output_bytes:8*1024*1024,max_state_bytes:1024*1024}};
}

// Codes match the V1 foundation request validator where the same rule applies.
function checkedRequest(value){
 try{strictJsonV2(value);}catch{throw fail('INVALID_FIELDS');}
 keys(value,REQUEST_KEYS);
 if(value.version!==V.request)throw fail('UNSUPPORTED_FOUNDATION_VERSION');
 if(!identifier(value.owner_id)||!identifier(value.bot_id))throw fail('INVALID_FOUNDATION_ID');
 if(value.kind!=='OPTIMIZE')throw fail('INVALID_FOUNDATION_KIND');
 if(!sha(value.engine_hash)||!sha(value.snapshot_hash))throw fail('INVALID_FOUNDATION_HASH');
 const pending=value.pending_dataset;
 keys(pending,PENDING_KEYS);
 const metadata=validateDatasetMetadata(pending.metadata);
 if(!sha(pending.content_digest))throw fail('INVALID_FOUNDATION_HASH');
 if(pending.digest_version!==V.digest)throw fail('UNSUPPORTED_FOUNDATION_VERSION');
 if(metadata.cutoff!==metadata.end_time)throw fail('INVALID_DATASET_INTERVAL');
 if(metadata.total_bars>FOUNDATION_LIMITS.admittedBars)throw fail('FOUNDATION_CAPABILITY_LIMIT');
 const budget=value.budget;
 keys(budget,BUDGET_KEYS);
 const bounds={candidates:FOUNDATION_LIMITS.candidates,max_evaluations:FOUNDATION_LIMITS.evaluations,chunk_bars:Math.min(FOUNDATION_LIMITS.chunkBars,metadata.total_bars),max_runtime_ms:FOUNDATION_LIMITS.runtimeMs,max_output_bytes:FOUNDATION_LIMITS.outputBytes,max_state_bytes:FOUNDATION_LIMITS.stateBytes};
 for(const [name,max] of Object.entries(bounds))if(!integer(budget[name],1,max))throw fail('INVALID_FOUNDATION_BUDGET');
 if(budget.max_evaluations<budget.candidates)throw fail('INVALID_FOUNDATION_BUDGET');
 return clone({...value,pending_dataset:{...pending,metadata}});
}

/** The pending foundation request an enqueue stores for this contract (kind OPTIMIZE, no dataset reference yet). */
export function expectedFoundationRequestV2(contract,maxRuntimeMs){
 return checkedRequest(requestFrom(validateResearchContractV2(contract),maxRuntimeMs));
}

/** Validates a stored request. With a contract it must also equal the request that contract yields, so owner,
 * bot, hashes, dataset range, digest and budget cannot drift from the research row. The runtime cap is the only
 * value read from the request itself, because the contract does not store the job deadline.
 */
export function validateFoundationResearchRequestV2(value,contract){
 const request=checkedRequest(value);
 if(contract!==undefined){
  const checked=validateResearchContractV2(contract);
  if(canonical(request)!==canonical(requestFrom(checked,request.budget.max_runtime_ms)))throw fail(INVALID_CONTRACT);
 }
 return request;
}

// The V1-shaped input for base run(), chunk reads and Python. Callers pass a contract and binding already checked.
function materialize(contract,references,sha256){
 const d=contract.dataset;
 return clone({...contract,version:V.execution,dataset:{start_time:d.start_time,end_time:d.end_time,warmup_bars:d.warmup_bars,bar_count:d.bar_count,sha256,first_time:d.first_time,references,timestamp_semantics:d.timestamp_semantics}});
}

function checkedBinding(contract,parameters){
 try{
  strictJsonV2(parameters);
  keys(parameters,BINDING_KEYS);
  need(parameters.version===V.binding);
  const {references}=parameters;
  keys(references,['raw','sidecar']);
  const raw=validateDatasetReference(references.raw);
  need(canonical(raw.metadata)===canonical(metadataFrom(contract.dataset)));
  const sidecar=references.sidecar;
  keys(sidecar,SIDECAR_KEYS);
  need(sha(sidecar.sha256)&&sidecar.bar_count===contract.dataset.bar_count&&sidecar.first_time===contract.dataset.start_time);
  need(sidecar.profile===contract.model.data_profile&&sidecar.price_tick===String(contract.model.price_tick)&&sidecar.quantity_step===String(contract.model.quantity_step));
  need(sha(parameters.dataset_sha256)&&parameters.content_digest===contract.dataset.content_digest&&parameters.bar_count===contract.dataset.bar_count);
  need(parameters.execution_contract_hash===hash(canonical(materialize(contract,references,parameters.dataset_sha256))));
 }catch{throw fail(INVALID_BINDING);}
 return clone(parameters);
}

/** Builds the write-once dataset binding parameters from the published references and the V1-formula file digest. */
export function datasetBindingParameters(contract,input){
 const checked=validateResearchContractV2(contract);
 let parameters;
 try{
  keys(input,['references','dataset_sha256']);
  const {references,dataset_sha256}=input;
  strictJsonV2({references,dataset_sha256});
  parameters={version:V.binding,references,dataset_sha256,content_digest:checked.dataset.content_digest,bar_count:checked.dataset.bar_count,execution_contract_hash:hash(canonical(materialize(checked,references,dataset_sha256)))};
 }catch{throw fail(INVALID_BINDING);}
 return checkedBinding(checked,parameters);
}

/** Exact-shape validation of a stored binding against its research contract. Returns a canonical copy. */
export function validateDatasetBindingV1(contract,parameters){
 return checkedBinding(validateResearchContractV2(contract),parameters);
}

/** The evaluator input: the stored contract in the ql3a-research-job-v1 shape, filled from a validated binding. */
export function materializeExecutionContract(contract,parameters){
 const checked=validateResearchContractV2(contract),binding=checkedBinding(checked,parameters);
 return materialize(checked,binding.references,binding.dataset_sha256);
}

/** Identity hash of the binding chunk row, on the formula the research worker uses for every chunk. */
export function datasetBindingIdentity(contract,parameters){
 const checked=validateResearchContractV2(contract);
 return hash(canonical({contract:checked,parameters:checkedBinding(checked,parameters),kind:DATASET_BINDING_KIND}));
}
