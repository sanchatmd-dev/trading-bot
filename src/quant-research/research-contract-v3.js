import {canonical,fail,hash} from '../pine-bridge/source.js';
import {strictJsonV2,fieldsV2} from './foundation-contract-v2.js';

/** Pure contract layer for the one-Pine LEGACY research contract ql3a-research-job-v3 (design docs/design/f09-recommendation-contract).
 * V3 is the v1 contract shape (bars inline, no execution_backend key, evaluated by the unchanged legacy engine) plus two
 * explicit policy fields (OD-12) and the split blocker model (OD-3): the stored blockers are the two candidate evidence
 * blockers only, because admission refuses while a customer capability blocker applies to the source.
 *
 * This slice is the labelled fixture path. The scope is always the engineering scope, which forces fixture = true downstream,
 * and policy_version is the constant fixture value. A real (non-fixture) run needs the owner answers Q2 (scope name), Q3
 * (policy_version source) and Q4 (capability registry); until then admission refuses every real v3 run.
 * This module reads no database, no file, no clock and no random source.
 */
export const RESEARCH_V3_VERSION='ql3a-research-job-v3';
export const RESEARCH_V3_SCOPE='SPT_CUSTOM_ENGINEERING_ONLY';
/** Q3 fixture value (root ruling SB172): design section 3 types policy_version as text, so the fixture value is text. Fixture runs only. */
export const RESEARCH_V3_FIXTURE_POLICY_VERSION='fixture-v1';
export const RESEARCH_V3_BLOCKERS=Object.freeze(['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED','CUSTOM_REPAINT_EVIDENCE_REQUIRED']);
export const RESEARCH_V3_CONTRACT_KEYS=Object.freeze(['version','scope','owner_id','bot_id','deployment_id','pine_import_id','source_version','source','source_hash','baseline_snapshot_hash','snapshot','input_lock','plan','model','rules','engine_hash','dataset','split','capital','ledger_initialization','max_evaluations','acceptance_blockers','policy_version','policy_hash']);

const MINUTE=60_000;
const MAX_TIME=8_640_000_000_000_000;
const MAX_BARS=10_000;
const HEX=/^[a-f0-9]{64}$/;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DATASET_KEYS=['start_time','end_time','warmup_bars','bar_count','bars','sha256'];
const RULE_KEYS=['minimum_closed_trades_train','minimum_closed_trades_validation','minimum_closed_trades_test','maximum_drawdown_percent','sensitivity_max_drop_percentage_points'];
const LEDGER='Independent historical flat Paper simulation; live daily/streak counters are neither consumed nor reset.';
const INVALID='INVALID_RESEARCH_CONTRACT_V3';

const sha=value=>typeof value==='string'&&HEX.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const need=ok=>{if(!ok)throw new Error('check');};
const DECIMAL_TEXT=/^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;
const positive=value=>typeof value==='number'?Number.isFinite(value)&&value>0&&value<1e20:typeof value==='string'&&value.length<=120&&DECIMAL_TEXT.test(value)&&/[1-9]/.test(value);
const deepFreeze=value=>{if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;};
const clone=value=>deepFreeze(JSON.parse(canonical(value)));
// The v1 formulas, byte for byte (src/postgres/quant-research.js legacy admission).
const splitFor=(warmup,total)=>{const count=total-warmup;return {warmup,train_end:warmup+Math.floor(count*.6),validation_end:warmup+Math.floor(count*.8),test_end:total};};
const evaluationsFor=(plan,domains)=>plan.planned_candidates+2*Object.keys(domains).length+2+3;

/** Exact-shape validation of a stored v3 contract. Returns a deep-frozen canonical copy and never mutates the input. */
export function validateResearchContractV3(value){
 try{
  strictJsonV2(value);
  fieldsV2(value,RESEARCH_V3_CONTRACT_KEYS);   // an extra, missing or renamed key refuses; so does execution_backend, null included
  need(value.version===RESEARCH_V3_VERSION&&value.scope===RESEARCH_V3_SCOPE);
  need(typeof value.owner_id==='string'&&IDENTIFIER.test(value.owner_id)&&typeof value.bot_id==='string'&&IDENTIFIER.test(value.bot_id));
  need(typeof value.deployment_id==='string'&&value.deployment_id.length>0&&typeof value.pine_import_id==='string'&&value.pine_import_id.length>0);
  need(integer(value.source_version,1,2147483647));
  need(typeof value.source==='string'&&sha(value.source_hash)&&hash(value.source)===value.source_hash);
  need(sha(value.baseline_snapshot_hash)&&sha(value.engine_hash));
  const {snapshot,input_lock:lock,plan,model,rules,capital,dataset:d}=value;
  // OD-12: policy_version is non-empty text; policy_hash is 64 lower-case hex and equals snapshot.policy_hash (root ruling R3, Q9).
  need(typeof value.policy_version==='string'&&IDENTIFIER.test(value.policy_version));
  need(plain(snapshot)&&sha(value.policy_hash)&&snapshot.policy_hash===value.policy_hash);
  need(plain(lock)&&plain(lock.selection)&&plain(lock.domains)&&sha(lock.lock_hash)&&canonical(snapshot.selection)===canonical(lock.selection));
  need(plain(plan)&&integer(plan.planned_candidates,1,1_000_000)&&Array.isArray(plan.candidates)&&plan.candidates.length===plan.planned_candidates);
  need(plain(model));
  fieldsV2(rules,RULE_KEYS);
  need(RULE_KEYS.every(name=>typeof rules[name]==='number'&&Number.isFinite(rules[name])));
  fieldsV2(capital,['equity','cash']);
  need(positive(capital.equity)&&positive(capital.cash));
  // OD-3 split blocker model: exactly the two candidate evidence blockers, in order. A capability blocker never belongs to v3.
  need(value.ledger_initialization===LEDGER&&canonical(value.acceptance_blockers)===canonical(RESEARCH_V3_BLOCKERS));
  need(value.max_evaluations===evaluationsFor(plan,lock.domains));
  fieldsV2(d,DATASET_KEYS);
  need(integer(d.start_time,1,MAX_TIME)&&integer(d.end_time,1,MAX_TIME)&&d.start_time%MINUTE===0&&d.end_time%MINUTE===0&&d.start_time<d.end_time);
  need(integer(d.warmup_bars,0,5000)&&integer(d.bar_count,1,MAX_BARS)&&d.bar_count===1+(d.end_time-d.start_time)/MINUTE&&d.warmup_bars<d.bar_count);
  need(sha(d.sha256)&&Array.isArray(d.bars)&&d.bars.length===d.bar_count);
  for(let i=0;i<d.bars.length;i++)need(plain(d.bars[i])&&d.bars[i].time===d.start_time+i*MINUTE);
  need(canonical(value.split)===canonical(splitFor(d.warmup_bars,d.bar_count)));
 }catch{throw fail(INVALID);}
 return clone(value);
}

/** Builds the stored v3 contract from the values a LEGACY enqueue holds (the same values it feeds the v1 literal).
 * Every derived field (bar count, split, evaluation cap, ledger text, blockers, policy fields) is computed here. The caller
 * supplies the snapshot as the deployment holds it, the legacy engine_hash and the dataset range with its inline bars and digest.
 */
export function buildResearchContractV3(input){
 let contract;
 try{
  const {owner_id,bot_id,deployment,source,snapshot,lock,plan,model,rules,capital,engine_hash,dataset}=input;
  const parts={owner_id,bot_id,deployment_id:deployment.deployment_id,pine_import_id:deployment.pine_import_id,source_version:deployment.source_version,source:source.source,source_hash:source.source_hash,baseline_snapshot_hash:deployment.snapshot_hash,snapshot,input_lock:lock,plan,model,rules,capital:{equity:capital.configuredEquity,cash:capital.configuredBalance},engine_hash,dataset:{start_time:dataset.start_time,end_time:dataset.end_time,warmup_bars:dataset.warmup_bars,bars:dataset.bars,sha256:dataset.sha256}};
  strictJsonV2(parts);
  need(plain(parts.snapshot)&&plain(parts.input_lock));
  const d=parts.dataset,total=d.bars.length;
  contract={version:RESEARCH_V3_VERSION,scope:RESEARCH_V3_SCOPE,owner_id:parts.owner_id,bot_id:parts.bot_id,deployment_id:parts.deployment_id,pine_import_id:parts.pine_import_id,source_version:parts.source_version,source:parts.source,source_hash:parts.source_hash,baseline_snapshot_hash:parts.baseline_snapshot_hash,snapshot:{...parts.snapshot,selection:parts.input_lock.selection},input_lock:parts.input_lock,plan:parts.plan,model:parts.model,rules:parts.rules,engine_hash:parts.engine_hash,
   dataset:{start_time:d.start_time,end_time:d.end_time,warmup_bars:d.warmup_bars,bar_count:total,bars:d.bars,sha256:d.sha256},
   split:splitFor(d.warmup_bars,total),capital:parts.capital,ledger_initialization:LEDGER,max_evaluations:evaluationsFor(parts.plan,parts.input_lock.domains),acceptance_blockers:[...RESEARCH_V3_BLOCKERS],
   policy_version:RESEARCH_V3_FIXTURE_POLICY_VERSION,policy_hash:parts.snapshot.policy_hash};
 }catch{throw fail(INVALID);}
 return validateResearchContractV3(contract);
}
