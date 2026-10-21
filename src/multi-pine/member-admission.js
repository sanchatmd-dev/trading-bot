import {canonical,hash,keys,number} from '../pine-bridge/source.js';
import {validateEvidence} from '../postgres/pine-bridge-readiness.js';
import {SOURCE_HASH} from '../quant-research/contract.js';
import {SUPPORTED_EXIT_VERSIONS} from '../quant-library/package-gates.js';
import {D} from '../money.js';
import {MP_CODES,MP_CODE_PATTERN,MP_MIN_MEMBERS,MP_MAX_MEMBERS} from './codes.js';

/*
 * F11 RS-4: pure per-member admission checks of the multi-Pine fixture service (docs/MULTI_PINE_CONTRACT.md section 5.1 steps 3 to 6).
 * Root decision R16: this module MIRRORS the one-Pine admission checks of QuantResearchService.enqueue
 * (src/postgres/quant-research.js, the block from the deployment lookup to the signal-mapping check, plus the foundation dataset
 * rules). It does not share code with it and does not touch it; test/multi-pine-member-admission.test.js runs both on the same
 * fixtures and asserts the same refusal code for every case.
 *
 * No I/O, clock, database, worker, randomness or engine import. The caller (the later fixture service) reads server rows inside
 * its admission transaction and passes plain data in. Every function returns a result object and never throws:
 *   {ok:true, ...}                                        success
 *   {ok:false, code, diagnostic:{ordinal,pine_import_id,field}}   refusal; ordinal and pine_import_id name the failing member,
 *                                                         and are null for a refusal that belongs to the run, not one member
 * Codes are one-Pine codes or MP_CODES; this module defines none. First failing check wins, in the fixed order below.
 *
 * Caller duties (this module cannot check them; the later fixture service and RS-5 own them):
 *   - deployment.exit_version is NOT a pine_deployments column (RD-MP-12 option A, src/pine-bridge/exit-version.js). The caller sets
 *     it on the deployment row it passes in, from deploymentExitVersion(artifact, snapshot, deployment_id), as
 *     mp-member-set-store.js does (deriveExitVersions).
 *   - The mirror does not run PineBridgeService.authorize. RS-5 authorizes the owner and the Bot (ownsBot and an ACTIVE user)
 *     before any call here.
 *   - capital_accounts is the T2 read of the Bot paper accounts whose basis hashes to the capital_basis_hash of the member set.
 *     The one-Pine path reads snapshot.capital instead; this module reads what the caller passes.
 *   - supported_source_hash comes from service configuration, never from request input.
 *   - quant_capability proof (root item R17) is decided in RS-5; this module checks only the record shape and the two hashes (step 4).
 *
 * Differences from the one-Pine block, each on purpose:
 *   - members must arrive in ascending pine_import_id order (contract 3.1), else MP_INPUT_INVALID on members[i].
 *   - READY-state check (RESEARCH_DEPLOYMENT_NOT_READY) is replaced by the DRAFT rule of 3.4: any state other than DRAFT is
 *     MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE.
 *   - freshSnapshot (STALE_*) is not mirrored: the member set freshness (memberSetFreshness) owns it and runs earlier (admission 4b).
 *   - snapshot.membership length check (MULTI_PINE_RESEARCH_NOT_SUPPORTED) is not mirrored: a member of a multi-Pine set always
 *     sits in a membership of two or more; set membership equality is a member-set freshness rule.
 *   - lockInputs, assertSelectionCoherence and candidatePlan are not mirrored: multi-Pine forbids source slots (MP_SOURCE_SLOTS_FORBIDDEN)
 *     and the run-level bridge domains and budget belong to buildMultiResearchContract.
 */

class Refusal extends Error {
  constructor(code,diagnostic) {super(code);this.code=code;this.diagnostic=diagnostic;}
}
const refuse=(code,diagnostic)=>{throw new Refusal(code,diagnostic);};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const codeOf=error=>typeof error?.code==='string'&&MP_CODE_PATTERN.test(error.code)?error.code:null;
const runLevel=field=>({ordinal:null,pine_import_id:null,field});
const failed=(code,diagnostic)=>({ok:false,code,diagnostic});
const invalidInput=(field,member)=>failed(MP_CODES.INPUT_INVALID,member?{ordinal:member.ordinal??null,pine_import_id:member.pine_import_id??null,field}:runLevel(field));

/** The one-Pine supported SPT custom settings (quant-research.js `settings`), copied exactly, including the source's own spelling. */
export const SPT_CUSTOM_SETTINGS=Object.freeze({preset:'Custom',tradeDirectionectionection:'Long + Exit',useSlowFilter:true,useMTF:false,useRSIFilter:false,requireBOS:false,requireSweep:false,slMode:'Zone + ATR',useSession:false,confirmMode:'Any',notifyEnabled:false});
/** The one supported signal mapping (quant-research.js canonical comparison). */
export const SPT_SIGNAL_MAPPING=Object.freeze({buy:'buySignal',exit:'sellSignal',timing:'bar_close'});
export const SPT_INPUT_COUNT=58;
export const MIN_COMPARED_BARS=2000;
export const MIN_WARMUP_BARS=1006;
export const MAX_WARMUP_BARS=5000;
export const MAX_DATASET_BARS=10000;
const MINUTE=60000;
const PINE_IMPORT_ID=/^[a-f0-9-]{36}$/;

/**
 * Documentation of the per-member check order: [code, field]. The implementation below runs them in this order and the test pins it.
 * The first entry replaces RESEARCH_DEPLOYMENT_NOT_READY (3.4). Evidence also refuses with any validateEvidence code.
 */
export const MEMBER_CHECK_ORDER=Object.freeze([
  ['NOT_FOUND','deployment'],
  [MP_CODES.MEMBER_DEPLOYMENT_MISSING,'deployment.identity'],
  [MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,'deployment.state'],
  ['SNAPSHOT_HASH_MISMATCH','deployment.snapshot_hash'],
  ['BRIDGE_EXECUTION_EVIDENCE_REQUIRED','evidence'],
  ['RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED','evidence.execution_model.version'],
  ['SPOT_PAPER_POLICY_REQUIRED','snapshot.policy'],
  ['UNSUPPORTED_CUSTOM_MARKET','snapshot.market'],
  ['NOT_FOUND','source'],
  ['UNSUPPORTED_SOURCE_HASH','source.source_hash'],
  ['CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED','source.analysis.effective_input_review'],
  ['UNSUPPORTED_CUSTOM_SETTING','source.analysis.inputs'],
  ['UNSUPPORTED_SIGNAL_MAPPING','snapshot.selection.signals']
].map(row=>Object.freeze(row)));

/**
 * One-Pine admission checks for one member, against the member's own deployment (5.1 step 3).
 *   member: {ordinal, pine_import_id, source_version, deployment, evidence, source}
 *     deployment  the pine_deployments row, or null
 *     evidence    the pine_bridge_evidence row {deployment_id, snapshot_hash, evidence, evidence_hash}, or null
 *     source      the pine_source_revisions row joined with pine_sources {owner_id, bot_id, pine_import_id, source_version, source, source_hash, analysis}, or null
 *   context: {owner_id, bot_id, supported_source_hash}  (the constructor's supportedSourceHash; default is the SPT source hash)
 * Success: {ok:true, exit_version, execution_model, min_warmup_bars}.
 */
export function checkMemberAdmission(member,context) {
  if(!isObject(member)||!isObject(context))return invalidInput('input');
  let step='member';
  const stop=(code,field)=>refuse(code,{ordinal:member.ordinal,pine_import_id:member.pine_import_id,field});
  try {
    const {owner_id,bot_id}=context;
    const supported=context.supported_source_hash??SOURCE_HASH;
    step='deployment';
    const d=member.deployment;
    if(!isObject(d)||d.owner_id!==owner_id||d.bot_id!==bot_id)stop('NOT_FOUND','deployment');
    step='deployment.identity';
    if(d.pine_import_id!==member.pine_import_id||d.source_version!==member.source_version)stop(MP_CODES.MEMBER_DEPLOYMENT_MISSING,'deployment.identity');
    step='deployment.state';
    if(d.state!=='DRAFT')stop(MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,'deployment.state');
    step='deployment.snapshot_hash';
    if(hash(canonical(d.snapshot))!==d.snapshot_hash)stop('SNAPSHOT_HASH_MISMATCH','deployment.snapshot_hash');
    step='evidence';
    const record=member.evidence;
    if(!isObject(record)||record.deployment_id!==d.deployment_id||record.snapshot_hash!==d.snapshot_hash||hash(canonical(record.evidence))!==record.evidence_hash)stop('BRIDGE_EXECUTION_EVIDENCE_REQUIRED','evidence');
    let evidence;
    try {evidence=validateEvidence(record.evidence,d.snapshot_hash);}
    catch(error) {const code=codeOf(error);if(code===null)throw error;stop(code,'evidence');}
    if(evidence.artifact_hash!==d.snapshot.artifact_hash||evidence.source_hash!==d.snapshot.source_hash)stop('STALE_EVIDENCE','evidence');
    step='evidence.execution_model.version';
    if(evidence.execution_model.version!=='paper-close-v1')stop('RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED','evidence.execution_model.version');
    const snapshot=d.snapshot;
    step='snapshot.policy';
    if(snapshot.policy.paperTrading!==true||snapshot.policy.requireReduceOnlySell!==true)stop('SPOT_PAPER_POLICY_REQUIRED','snapshot.policy');
    step='snapshot.market';
    if(snapshot.market.broker!=='binance-global'||snapshot.market.symbol!=='BTCUSDT'||snapshot.market.timeframe!=='1')stop('UNSUPPORTED_CUSTOM_MARKET','snapshot.market');
    step='source';
    const source=member.source;
    // pine.source: authorize (owner and Bot), source_version range, import id shape, then the revision row.
    try {number(d.source_version,{min:1,max:2147483647,integer:true});}
    catch(error) {const code=codeOf(error);if(code===null)throw error;stop(code,'source');}
    if(typeof d.pine_import_id!=='string'||!PINE_IMPORT_ID.test(d.pine_import_id))stop('NOT_FOUND','source');
    if(!isObject(source)||source.owner_id!==owner_id||source.bot_id!==bot_id||source.pine_import_id!==d.pine_import_id||source.source_version!==d.source_version)stop('NOT_FOUND','source');
    step='source.source_hash';
    if(source.source_hash!==supported||hash(source.source)!==source.source_hash)stop('UNSUPPORTED_SOURCE_HASH','source.source_hash');
    step='source.analysis.effective_input_review';
    const review=source.analysis.effective_input_review;
    if(source.analysis.inputs.length!==SPT_INPUT_COUNT||!review||review.source_hash!==source.source_hash||review.effective_inputs_hash!==source.analysis.effective_inputs_hash||review.input_count!==SPT_INPUT_COUNT||!review.reviewed_by||!Number.isSafeInteger(review.reviewed_at))stop('CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED','source.analysis.effective_input_review');
    step='source.analysis.inputs';
    const effective=Object.fromEntries(source.analysis.inputs.map(input=>[input.pine_variable,input.effective_value]));
    for(const [name,value] of Object.entries(SPT_CUSTOM_SETTINGS))if(effective[name]!==value)stop('UNSUPPORTED_CUSTOM_SETTING','source.analysis.inputs.'+name);
    step='snapshot.selection.signals';
    if(canonical(snapshot.selection.signals)!==canonical(SPT_SIGNAL_MAPPING))stop('UNSUPPORTED_SIGNAL_MAPPING','snapshot.selection.signals');
    // One-Pine dataset floor for this member: max(1006, 5 * slow EMA length). Multi-Pine forbids slots, so the length is the effective value.
    step='source.analysis.inputs.emaSlowInput';
    if(typeof effective.emaSlowInput!=='number'||!Number.isFinite(effective.emaSlowInput))return invalidInput('source.analysis.inputs.emaSlowInput',member);
    step='deployment.exit_version';
    if(typeof d.exit_version!=='string'||d.exit_version.length===0)return invalidInput('deployment.exit_version',member);
    return {ok:true,exit_version:d.exit_version,execution_model:evidence.execution_model,min_warmup_bars:Math.max(MIN_WARMUP_BARS,effective.emaSlowInput*5)};
  } catch(error) {
    if(error instanceof Refusal)return failed(error.code,error.diagnostic);
    return invalidInput(step,member);
  }
}

/**
 * Dataset rules of 5.1 step 5 (the one-Pine foundation block): dataset keys and bounds, alignment, at most 10,000 bars, the
 * verified span read in the same transaction, at least 2,000 compared bars after warm-up, capital present.
 *   dataset          {start_time, end_time, warmup_bars}
 *   dataset_span     the CONTENT_DIGEST_SQL row {n, first_time, last_time, bad, digest}
 *   capital_accounts the Bot paper accounts [{broker, configuredEquity, configuredBalance}]
 *   now              epoch ms, upper bound of start_time and end_time (the one-Pine clock)
 *   min_warmup_bars  combined warm-up floor: the maximum of the member floors; the effective minimum is max(1006, this value)
 * Run-level refusals carry ordinal null and pine_import_id null.
 */
export function checkDatasetAdmission({dataset,dataset_span:span,capital_accounts:accounts,now,min_warmup_bars:floor}={}) {
  let field='dataset';
  try {
    const guard=(name,run)=>{
      field=name;
      try {return run();}
      catch(error) {const code=codeOf(error);if(code===null)throw error;return refuse(code,runLevel(name));}
    };
    if(!Number.isSafeInteger(now)||!Number.isFinite(floor))return invalidInput('dataset_inputs');
    guard('dataset',()=>keys(dataset,['start_time','end_time','warmup_bars']));
    for(const name of ['start_time','end_time'])guard('dataset.'+name,()=>number(dataset[name],{min:1,max:now,integer:true}));
    guard('dataset.warmup_bars',()=>number(dataset.warmup_bars,{min:Math.max(MIN_WARMUP_BARS,floor),max:MAX_WARMUP_BARS,integer:true}));
    const {start_time:start,end_time:end,warmup_bars:warmup}=dataset;
    field='dataset';
    if(start>=end||(end-start)%MINUTE!==0||start%MINUTE!==0||end%MINUTE!==0||1+(end-start)/MINUTE>MAX_DATASET_BARS)refuse('INVALID_RESEARCH_DATASET',runLevel('dataset'));
    const expected=1+(end-start)/MINUTE;
    field='dataset_span';
    if(!isObject(span))return invalidInput('dataset_span');
    if(span.n!==expected||expected-warmup<MIN_COMPARED_BARS)refuse('INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET',runLevel('dataset_span'));
    if(span.first_time!==start||span.last_time!==end||span.bad!==0||typeof span.digest!=='string'||!/^[a-f0-9]{64}$/.test(span.digest))refuse('VERIFIED_MARKET_DATA_REQUIRED',runLevel('dataset_span'));
    field='capital_accounts';
    if(!Array.isArray(accounts))return invalidInput('capital_accounts');
    const capital=accounts.find(account=>account.broker==='binance-global');
    if(!capital||!D(capital.configuredEquity).gt(0)||!D(capital.configuredBalance).gt(0))refuse('RESEARCH_CAPITAL_REQUIRED',runLevel('capital_accounts'));
    return {ok:true};
  } catch(error) {
    if(error instanceof Refusal)return failed(error.code,error.diagnostic);
    return invalidInput(field);
  }
}

/** Step 4: the capability record must say SUPPORTED and name this member's own source hash and effective inputs hash. */
const capabilityProves=m=>{
  const c=m.quant_capability;
  return isObject(c)&&c.state==='SUPPORTED'&&typeof c.source_hash==='string'&&c.source_hash===m.source.source_hash&&typeof c.effective_inputs_hash==='string'&&c.effective_inputs_hash===m.source.analysis.effective_inputs_hash;
};

const INPUT_KEYS=['owner_id','bot_id','supported_source_hash','members','dataset','dataset_span','capital_accounts','now'];

/**
 * Admission steps 3 to 6 for a member set, in contract order:
 *   3  per member in ordinal order, the one-Pine checks; the first failing member ends admission
 *   4  every member needs quant_capability {state:'SUPPORTED', source_hash, effective_inputs_hash} with both hashes equal to the
 *      member's own source hash and effective inputs hash; one member without it refuses the whole set (MP_MEMBER_QUANT_UNSUPPORTED)
 *   5  dataset rules against the combined warm-up floor
 *   6  one exit version (MP_EXIT_VERSION_MIXED, then BI_EXIT_VERSION_UNSUPPORTED) and one execution model (MP_EXECUTION_MODEL_MIXED)
 * Input: {owner_id, bot_id, supported_source_hash?, members:[member + quant_capability], dataset, dataset_span, capital_accounts, now}.
 * What proves quant_capability is root item R17 (decided in RS-5); this module only checks the record the caller passes.
 * Success: {ok:true, members:N, exit_version, min_warmup_bars}.
 */
export function checkMemberSetAdmission(input) {
  if(!isObject(input))return invalidInput('input');
  for(const key of Object.keys(input))if(!INPUT_KEYS.includes(key))return invalidInput('input.'+key);
  for(const key of ['owner_id','bot_id'])if(typeof input[key]!=='string'||input[key].length===0)return invalidInput(key);
  const {members}=input;
  if(!Array.isArray(members))return invalidInput('members');
  if(members.length===0)return failed(MP_CODES.MEMBERSHIP_EMPTY,runLevel('members'));
  if(members.length>MP_MAX_MEMBERS)return failed(MP_CODES.MEMBER_COUNT_EXCEEDED,runLevel('members'));
  if(members.length<MP_MIN_MEMBERS)return failed(MP_CODES.NOT_MULTI_PINE,runLevel('members'));
  let previous=null;
  for(let i=0;i<members.length;i++) {
    const m=members[i];
    if(!isObject(m)||m.ordinal!==i+1||typeof m.pine_import_id!=='string'||m.pine_import_id.length===0||(previous!==null&&m.pine_import_id<=previous))return invalidInput(`members[${i}]`);
    previous=m.pine_import_id;
  }
  const context={owner_id:input.owner_id,bot_id:input.bot_id,supported_source_hash:input.supported_source_hash};
  const checked=[];
  for(const m of members) {
    const outcome=checkMemberAdmission(m,context);
    if(!outcome.ok)return outcome;
    checked.push(outcome);
  }
  for(const m of members)if(!capabilityProves(m))return failed(MP_CODES.MEMBER_QUANT_UNSUPPORTED,{ordinal:m.ordinal,pine_import_id:m.pine_import_id,field:'quant_capability'});
  const floor=Math.max(...checked.map(c=>c.min_warmup_bars));
  const dataset=checkDatasetAdmission({dataset:input.dataset,dataset_span:input.dataset_span,capital_accounts:input.capital_accounts,now:input.now,min_warmup_bars:floor});
  if(!dataset.ok)return dataset;
  const at=(i,field)=>({ordinal:members[i].ordinal,pine_import_id:members[i].pine_import_id,field});
  for(let i=1;i<checked.length;i++)if(checked[i].exit_version!==checked[0].exit_version)return failed(MP_CODES.EXIT_VERSION_MIXED,at(i,'deployment.exit_version'));
  if(!SUPPORTED_EXIT_VERSIONS.includes(checked[0].exit_version))return failed('BI_EXIT_VERSION_UNSUPPORTED',at(0,'deployment.exit_version'));
  const model=canonical(checked[0].execution_model);
  for(let i=1;i<checked.length;i++)if(canonical(checked[i].execution_model)!==model)return failed(MP_CODES.EXECUTION_MODEL_MIXED,at(i,'evidence.execution_model'));
  return {ok:true,members:members.length,exit_version:checked[0].exit_version,min_warmup_bars:floor};
}
