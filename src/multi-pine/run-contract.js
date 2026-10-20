import {canonical,hash} from '../pine-bridge/source.js';
import {FOUNDATION_LIMITS,validateDatasetMetadata} from '../quant-research/foundation-contract.js';
import {CANDIDATE_BLOCKERS} from '../quant-library/package-gates.js';
import {RULES} from '../quant-research/contract.js';
import {decideFreeze,decimalString} from './member-set.js';
import {MP_CODES,MP_MODE,MP_SAME_BAR_ORDER,MP_MAX_MEMBERS,MULTI_PINE_CONTRACT_VERSION,MULTI_PINE_BLOCKER} from './codes.js';

/*
 * F11-01 S2 (research run contract): pure, fixture-only builder and exact-key validator of the multi-Pine research run contract
 * `ql3a-research-job-multi-v1` (docs/MULTI_PINE_CONTRACT.md section 5.8; names frozen by RD-MP-1). Storage is RD-MP-2 and is a later slice.
 * No database, clock, randomness, network, file, engine or worker. Imported by no runtime root.
 *
 * Binding to the member set: the builder takes the frozen member set as the authority and refuses every claim that differs. The validator
 * sees only the stored contract: it cannot recompute set_hash (the member set record is not stored in the contract), and it cannot
 * re-derive the run capital from capital_basis_hash (the paper accounts are not stored either). It checks shape, hashes it can
 * recompute (membership_hash), derived values and constants. Binding to a frozen set is the builder's job.
 *
 * Mirrored one-Pine contract: `ql3a-research-job-v2` (src/quant-research/research-contract-v2.js, the FOUNDATION contract). It is
 * the live one-Pine shape: dataset by range plus ordered content digest (no bars, no source text), exact-key validator, derived
 * split and evaluation cap. The v1 contract embeds bars and one source, which a multi-Pine set does not have. Rules copied from v2:
 * identifier pattern, capital as a positive plain decimal, dataset keys and limits (through validateDatasetMetadata and
 * FOUNDATION_LIMITS), split formula, the sample floor (at least 2000 compared bars after warm-up, src/postgres/quant-research.js), and
 * the rules, which must equal RULES of src/quant-research/contract.js exactly. Run capital is not caller-claimed: the input carries the
 * paper accounts, which must hash to member_set.capital_basis_hash (the member-set recipe), and the capital is that of the account of
 * the set's market broker (src/postgres/quant-research.js). The budget is the candidate count only: the planned count and the
 * evaluation cap come with the later plan slice. Execution-model keys and value rules follow validateEvidence. Seed and
 * candidate-count limits follow candidatePlan.
 * Bridge domains follow the lockInputs domain rules (limits 0.01 to 1000, min below max, step aligned, at most 1000 grid values)
 * in exact decimal arithmetic, with the shared Bridge pair of the member set as the baseline.
 * Money, capital and Bridge domain values are exact decimal strings; a binary float there is refused.
 *
 * Every function returns a result and never throws:
 *   {ok:true, contract}                  success (canonical copy, keys sorted)
 *   {ok:false, code, diagnostic}         refusal; diagnostic names the stage and the field
 * First failing check wins, in the order of the code below.
 */

export const MULTI_RUN_ACCEPTANCE_BLOCKERS=Object.freeze([...CANDIDATE_BLOCKERS,MULTI_PINE_BLOCKER]);
/** Section 5.8: top-level keys of the stored contract. deployment_id, pine_import_id and source_version are absent on purpose. */
export const MULTI_RUN_CONTRACT_KEYS=Object.freeze(['version','mode','pine_count','member_set_id','set_hash','membership_hash','members','owner_id','bot_id','policy_hash','funding_cutoff','capital','model','rules','engine_hash','dataset','split','budget','seed','bridge_domains','same_bar_order','fixture','acceptance_blockers']);
/** Builder input: the frozen member set, the claims that must equal it, and the run's own fields. Closed list. */
export const MULTI_RUN_INPUT_KEYS=Object.freeze(['member_set','member_set_id','set_hash','membership_hash','pine_count','members','owner_id','bot_id','policy_hash','funding_cutoff','capital_accounts','model','rules','engine_hash','dataset','budget','seed','bridge_domains','fixture']);

class Refusal extends Error {
  constructor(code,diagnostic={}) {super(code);this.code=code;this.diagnostic=diagnostic;}
}
const refuse=(code,diagnostic={})=>{throw new Refusal(code,diagnostic);};
const invalid=(field,extra={})=>refuse(MP_CODES.INPUT_INVALID,{field,...extra});
const need=(condition,field,extra)=>{if(!condition)invalid(field,extra);};
const result=(stage,run)=>{
  try {return {ok:true,...run()};}
  catch(error) {
    if(error instanceof Refusal)return {ok:false,code:error.code,diagnostic:{stage,...error.diagnostic}};
    return {ok:false,code:MP_CODES.INPUT_INVALID,diagnostic:{stage,field:'unexpected'}};
  }
};

const MINUTE=60_000;
const MAX_TIME=8_640_000_000_000_000;
const HEX64=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// Plain positive decimal as the one-Pine v2 contract writes it: digits with an optional fraction, no sign, no exponent, below 1e20.
const DECIMAL_TEXT=/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;
const TIMESTAMP_SEMANTICS='verified closed-bar timestamps; half-open index end is last timestamp plus one minute';
const DIGEST_VERSION='pine-bar-content-digest-v1';
const MODEL_PROFILE='closed-ohlcv-atr14-v1';
const MODEL_VERSIONS=['paper-close-v1','paper-close-cost-v2'];
const MODEL_KEYS=['version','price_tick','quantity_step','fee_bps','slippage_bps','risk_percent','data_profile'];
const MEMBER_KEYS=['ordinal','pine_import_id','source_version','source_hash','effective_inputs_hash','deployment_id','deployment_snapshot_hash','exit_version','evidence_hash'];
const DATASET_KEYS=['start_time','end_time','warmup_bars','bar_count','first_time','timestamp_semantics','content_digest','digest_version'];
const DATASET_INPUT_KEYS=['start_time','end_time','warmup_bars','content_digest'];
const CAPITAL_KEYS=['equity','cash'];
const SPLIT_KEYS=['warmup','train_end','validation_end','test_end'];
const BUDGET_KEYS=['candidates'];
const ACCOUNT_KEYS=['broker','configuredEquity','configuredBalance'];
const MIN_COMPARED_BARS=2000;
const MAX_ACCOUNTS=20;
const BRIDGE_KEYS=['atr_multiplier','rr'];
const DOMAIN_KEYS=['min','max','step'];
/** Absolute lower limit of a Bridge domain (lockInputs limits [0.01, 1000]); the upper limit is enforced by decimalString. */
const DOMAIN_MIN='0.01';
const MAX_GRID_VALUES=1000n;
const MAX_SEED=2147483647;

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sameKeys=(value,keys)=>isObject(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha=value=>typeof value==='string'&&HEX64.test(value);
const identifier=value=>typeof value==='string'&&IDENTIFIER.test(value);
const text=value=>typeof value==='string'&&value.length>=1&&value.length<=200;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const finiteIn=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const positiveDecimal=value=>typeof value==='string'&&value.length<=120&&DECIMAL_TEXT.test(value)&&/[1-9]/.test(value);
const clone=value=>JSON.parse(canonical(value));

/** Plain JSON only: no accessors, symbols, holes, special prototypes, cycles, undefined or non-finite numbers. */
function plainJson(value,seen=new Set()) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||seen.has(value))return false;
  seen.add(value);
  let ok=true;
  if(Array.isArray(value)) {
    ok=Object.getPrototypeOf(value)===Array.prototype&&Reflect.ownKeys(value).length===value.length+1;
    for(let index=0;ok&&index<value.length;index++) {
      const field=Object.getOwnPropertyDescriptor(value,String(index));
      ok=!!field&&field.enumerable===true&&Object.hasOwn(field,'value')&&plainJson(field.value,seen);
    }
  } else {
    ok=[Object.prototype,null].includes(Object.getPrototypeOf(value));
    for(const name of Reflect.ownKeys(value)) {
      if(!ok)break;
      const field=typeof name==='string'?Object.getOwnPropertyDescriptor(value,name):null;
      ok=!!field&&field.enumerable===true&&Object.hasOwn(field,'value')&&plainJson(field.value,seen);
    }
  }
  seen.delete(value);
  return ok;
}

/* ---------- derived values (same formulas as the one-Pine v2 contract) ---------- */

const splitFor=(warmup,total)=>{const count=total-warmup;return {warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:total};};
const membershipOf=members=>hash(canonical(members.map(m=>({pine_import_id:m.pine_import_id,source_version:m.source_version,source_hash:m.source_hash}))));
const metadataFrom=dataset=>({version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:dataset.start_time,end_time:dataset.end_time+MINUTE,warmup_bars:dataset.warmup_bars,total_bars:dataset.bar_count,cutoff:dataset.end_time+MINUTE,source:'binance-spot-klines-v1'});

/* ---------- field checks shared by the builder and the validator ---------- */

function checkCapital(capital,field) {
  need(sameKeys(capital,CAPITAL_KEYS),field);
  for(const key of CAPITAL_KEYS)need(positiveDecimal(capital[key]),`${field}.${key}`);
}

function checkModel(model,field) {
  need(sameKeys(model,MODEL_KEYS),field);
  need(MODEL_VERSIONS.includes(model.version)&&model.data_profile===MODEL_PROFILE,`${field}.version`);
  for(const key of ['price_tick','quantity_step'])need(finiteIn(model[key],1e-18,1e12),`${field}.${key}`);
  need(finiteIn(model.risk_percent,1e-18,100),`${field}.risk_percent`);
  need(finiteIn(model.fee_bps,0,1000),`${field}.fee_bps`);
  need(finiteIn(model.slippage_bps,0,1000),`${field}.slippage_bps`);
}

/** The rules are the fixed one-Pine RULES, key for key and value for value; any other key set or value refuses with the field "rules". */
function checkRules(rules,field) {
  need(isObject(rules)&&canonical(rules)===canonical(RULES),field);
}

/** Dataset by range, count and ordered content digest (pine-bar-content-digest-v1). The Binance Spot BTCUSDT 1m rules come from validateDatasetMetadata. */
function checkDataset(dataset,field) {
  need(sameKeys(dataset,DATASET_KEYS),field);
  need(integer(dataset.start_time,1,MAX_TIME)&&integer(dataset.end_time,1,MAX_TIME)&&dataset.start_time%MINUTE===0&&dataset.end_time%MINUTE===0&&dataset.start_time<dataset.end_time,`${field}.range`);
  need(integer(dataset.bar_count,1,FOUNDATION_LIMITS.admittedBars),`${field}.bar_count`);
  need(integer(dataset.warmup_bars,0,5000),`${field}.warmup_bars`);
  need(dataset.first_time===dataset.start_time,`${field}.first_time`);
  need(dataset.timestamp_semantics===TIMESTAMP_SEMANTICS,`${field}.timestamp_semantics`);
  need(sha(dataset.content_digest),`${field}.content_digest`);
  need(dataset.digest_version===DIGEST_VERSION,`${field}.digest_version`);
  try {validateDatasetMetadata(metadataFrom(dataset));}
  catch {invalid(`${field}.range`);}
  // Sample floor, computed as src/postgres/quant-research.js does: compared bars after warm-up (bar_count - warmup_bars) at least 2000.
  need(dataset.bar_count-dataset.warmup_bars>=MIN_COMPARED_BARS,`${field}.sample`);
}

const fraction=value=>(value.split('.')[1]??'').length;
const scaled=(value,scale)=>{const [whole,part='']=value.split('.');return BigInt(whole+part.padEnd(scale,'0'));};

/**
 * lockInputs domain rules in exact decimals. Shape: canonical decimal strings min, max, step. min is at least 0.01, max at most 1000
 * (decimalString), min below max, (max - min) a whole number of steps, at most 1000 grid values. With a baseline (builder only) the
 * baseline lies in [min, max] on the grid.
 */
function checkDomain(domain,field,baseline) {
  need(sameKeys(domain,DOMAIN_KEYS),field);
  for(const key of DOMAIN_KEYS)need(typeof domain[key]==='string'&&decimalString(domain[key])===domain[key],`${field}.${key}`);
  const values=[domain.min,domain.max,domain.step,DOMAIN_MIN,...(baseline===undefined?[]:[baseline])];
  const scale=Math.max(...values.map(fraction));
  const min=scaled(domain.min,scale),max=scaled(domain.max,scale),step=scaled(domain.step,scale);
  need(min>=scaled(DOMAIN_MIN,scale),`${field}.min`);
  need(min<max,`${field}.max`);
  need((max-min)%step===0n,`${field}.step`);
  need((max-min)/step+1n<=MAX_GRID_VALUES,`${field}.step`);
  if(baseline!==undefined) {
    const base=scaled(baseline,scale);
    need(base>=min&&base<=max&&(base-min)%step===0n,`${field}.baseline`);
  }
}

function checkBridgeDomains(domains,field,pair) {
  need(sameKeys(domains,BRIDGE_KEYS),field);
  for(const key of BRIDGE_KEYS)checkDomain(domains[key],`${field}.${key}`,pair?.[key]);
}

function checkMembers(members,field) {
  need(Array.isArray(members),field);
  if(members.length===0)refuse(MP_CODES.MEMBERSHIP_EMPTY,{field});
  if(members.length===1)refuse(MP_CODES.NOT_MULTI_PINE,{field,pine_count:1});
  if(members.length>MP_MAX_MEMBERS)refuse(MP_CODES.MEMBER_COUNT_EXCEEDED,{field,pine_count:members.length,limit:MP_MAX_MEMBERS});
  let previous='';
  members.forEach((m,i)=>{
    need(sameKeys(m,MEMBER_KEYS)&&m.ordinal===i+1&&text(m.pine_import_id)&&m.pine_import_id>previous&&integer(m.source_version,1,Number.MAX_SAFE_INTEGER)&&sha(m.source_hash)&&sha(m.effective_inputs_hash)&&text(m.deployment_id)&&sha(m.deployment_snapshot_hash)&&text(m.exit_version)&&sha(m.evidence_hash),`${field}[${i}]`);
    previous=m.pine_import_id;
  });
  for(let i=0;i<members.length;i++) {
    for(let j=i+1;j<members.length;j++)
      if(members[i].source_hash===members[j].source_hash&&members[i].effective_inputs_hash===members[j].effective_inputs_hash)
        refuse(MP_CODES.MEMBER_DUPLICATE_LOGIC,{field,ordinals:[members[i].ordinal,members[j].ordinal]});
    if(members[i].exit_version!==members[0].exit_version)refuse(MP_CODES.EXIT_VERSION_MIXED,{field,ordinal:members[i].ordinal,against_ordinal:1});
  }
}

/* ---------- exact-key validator ---------- */

/** Strict shape check of a stored or built contract. Throws a Refusal. Returns a canonical copy. */
function checkContract(input) {
  need(plainJson(input)&&isObject(input),'contract');
  // One snapshot: every later read is of this copy, never of the caller's object (a Proxy could answer differently twice).
  const value=clone(input);
  for(const key of Object.keys(value))need(MULTI_RUN_CONTRACT_KEYS.includes(key),key);
  for(const key of MULTI_RUN_CONTRACT_KEYS)need(Object.hasOwn(value,key),key);
  if(value.fixture!==true)refuse(MP_CODES.FIXTURE_ONLY,{field:'fixture'});
  need(value.version===MULTI_PINE_CONTRACT_VERSION,'version');
  need(value.mode===MP_MODE,'mode');
  need(value.same_bar_order===MP_SAME_BAR_ORDER,'same_bar_order');
  need(typeof value.member_set_id==='string'&&UUID.test(value.member_set_id),'member_set_id');
  need(sha(value.set_hash),'set_hash');
  need(sha(value.membership_hash),'membership_hash');
  need(integer(value.pine_count,0,Number.MAX_SAFE_INTEGER),'pine_count');
  checkMembers(value.members,'members');
  need(value.pine_count===value.members.length,'pine_count');
  need(value.membership_hash===membershipOf(value.members),'membership_hash');
  need(identifier(value.owner_id),'owner_id');
  need(identifier(value.bot_id),'bot_id');
  need(sha(value.policy_hash),'policy_hash');
  need(integer(value.funding_cutoff,0,Number.MAX_SAFE_INTEGER),'funding_cutoff');
  checkCapital(value.capital,'capital');
  checkModel(value.model,'model');
  checkRules(value.rules,'rules');
  need(sha(value.engine_hash),'engine_hash');
  checkDataset(value.dataset,'dataset');
  need(sameKeys(value.split,SPLIT_KEYS)&&canonical(value.split)===canonical(splitFor(value.dataset.warmup_bars,value.dataset.bar_count)),'split');
  need(sameKeys(value.budget,BUDGET_KEYS),'budget');
  need(integer(value.budget.candidates,1,FOUNDATION_LIMITS.candidates),'budget.candidates');
  need(integer(value.seed,0,MAX_SEED),'seed');
  checkBridgeDomains(value.bridge_domains,'bridge_domains');
  need(canonical(value.acceptance_blockers)===canonical(MULTI_RUN_ACCEPTANCE_BLOCKERS),'acceptance_blockers');
  return value;
}

/** Exact-shape validation of a multi-Pine research run contract. Returns {ok:true,contract} (canonical copy) or {ok:false,code,diagnostic}. */
export const validateMultiResearchContract=value=>result('contract',()=>({contract:checkContract(value)}));

/* ---------- builder ---------- */

const accountText=value=>{
  const text=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  return positiveDecimal(text)?text:null;
};

/**
 * Run capital from the paper accounts (the shape of snapshot.capital). The accounts must hash to member_set.capital_basis_hash with the
 * member-set recipe (src/multi-pine/member-set.js snapshotFacts): hash of the canonical list of {broker, configuredEquity,
 * configuredBalance}. The capital is the account of the set's market broker, as src/postgres/quant-research.js takes it.
 */
function runCapital(accounts,set) {
  need(Array.isArray(accounts)&&accounts.length>=1&&accounts.length<=MAX_ACCOUNTS,'capital_accounts');
  const brokers=new Set();
  accounts.forEach((a,i)=>{
    need(sameKeys(a,ACCOUNT_KEYS)&&text(a.broker)&&!brokers.has(a.broker)&&(typeof a.configuredEquity==='number'||typeof a.configuredEquity==='string')&&(typeof a.configuredBalance==='number'||typeof a.configuredBalance==='string'),`capital_accounts[${i}]`);
    brokers.add(a.broker);
  });
  need(hash(canonical(accounts.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance}))))===set.capital_basis_hash,'capital',{against:'member_set.capital_basis_hash'});
  const account=accounts.find(a=>a.broker===set.market.broker);
  const equity=account&&accountText(account.configuredEquity),cash=account&&accountText(account.configuredBalance);
  need(equity&&cash,'capital',{against:'member_set.market'});
  return {equity,cash};
}

function build(raw) {
  need(plainJson(raw)&&isObject(raw),'input');
  // One snapshot (see checkContract): the rest of the builder reads only this copy.
  const input=clone(raw);
  for(const key of Object.keys(input))need(MULTI_RUN_INPUT_KEYS.includes(key),'input.'+key);
  if(input.fixture!==true)refuse(MP_CODES.FIXTURE_ONLY,{field:'fixture'});
  for(const key of MULTI_RUN_INPUT_KEYS)need(Object.hasOwn(input,key),key);

  // The frozen member set is the authority. It must be a valid S1 record; every claim of the input must equal it.
  const frozen=decideFreeze(input.member_set,[]);
  if(!frozen.ok)invalid('member_set',{detail:frozen.diagnostic?.field});
  const set=frozen.member_set;
  need(identifier(set.owner_id),'owner_id',{against:'member_set'});
  need(identifier(set.bot_id),'bot_id',{against:'member_set'});
  for(const key of ['owner_id','bot_id','member_set_id','set_hash','membership_hash','pine_count','policy_hash','funding_cutoff','members'])
    need(canonical(input[key])===canonical(set[key]),key,{against:'member_set'});
  // The run model is the execution model the member set froze (execution_model_hash covers the validated evidence model).
  checkModel(input.model,'model');
  need(hash(canonical(input.model))===set.execution_model_hash,'model',{against:'member_set.execution_model_hash'});

  const capital=runCapital(input.capital_accounts,set);
  checkRules(input.rules,'rules');
  need(sha(input.engine_hash),'engine_hash');
  need(sameKeys(input.dataset,DATASET_INPUT_KEYS),'dataset');
  need(sameKeys(input.budget,['candidates']),'budget');
  need(integer(input.seed,0,MAX_SEED),'seed');
  // Builder only: each Bridge domain contains the shared pair of the member set as its baseline (lockInputs).
  checkBridgeDomains(input.bridge_domains,'bridge_domains',set.bridge_pair);

  const d=input.dataset;
  need(integer(d.start_time,1,MAX_TIME)&&integer(d.end_time,1,MAX_TIME)&&d.start_time%MINUTE===0&&d.end_time%MINUTE===0&&d.start_time<d.end_time,'dataset.range');
  const bar_count=1+(d.end_time-d.start_time)/MINUTE;
  need(integer(input.budget.candidates,1,FOUNDATION_LIMITS.candidates),'budget.candidates');
  const contract={
    version:MULTI_PINE_CONTRACT_VERSION,mode:MP_MODE,pine_count:set.pine_count,member_set_id:set.member_set_id,set_hash:set.set_hash,
    membership_hash:set.membership_hash,members:set.members,owner_id:set.owner_id,bot_id:set.bot_id,policy_hash:set.policy_hash,
    funding_cutoff:set.funding_cutoff,capital,model:input.model,rules:input.rules,engine_hash:input.engine_hash,
    dataset:{start_time:d.start_time,end_time:d.end_time,warmup_bars:d.warmup_bars,bar_count,first_time:d.start_time,timestamp_semantics:TIMESTAMP_SEMANTICS,content_digest:d.content_digest,digest_version:DIGEST_VERSION},
    split:splitFor(d.warmup_bars,bar_count),
    budget:{candidates:input.budget.candidates},
    seed:input.seed,bridge_domains:input.bridge_domains,same_bar_order:MP_SAME_BAR_ORDER,fixture:true,acceptance_blockers:[...MULTI_RUN_ACCEPTANCE_BLOCKERS]
  };
  return {contract:checkContract(contract)};
}

/**
 * Section 5.8: build the multi-Pine research run contract from a frozen member set (a buildMemberSet record) and the run's own
 * fields. Returns {ok:true,contract} or {ok:false,code,diagnostic}. The input list is closed: a client field, deployment_id,
 * pine_import_id or source_version refuses with MP_INPUT_INVALID; fixture other than true refuses with MP_FIXTURE_ONLY.
 */
export const buildMultiResearchContract=input=>result('input',()=>build(input));
