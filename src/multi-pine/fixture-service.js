import {canonical,hash} from '../pine-bridge/source.js';
import {deploymentExitVersion} from '../pine-bridge/exit-version.js';
import {CONTENT_DIGEST_SQL} from '../quant-research/research-contract-v2.js';
import {RULES} from '../quant-research/contract.js';
import {freezeOrLoadMemberSet,BOT_ROWS,DEPLOYMENT_ROWS,EVIDENCE_ROWS,JOB_ROWS} from '../postgres/mp-member-set-store.js';
import {findMultiRunByKey,insertMultiRun,mapRunStoreFailure,RUN_STORE_MAX_RETRIES,RUN_STORE_CODES,RUN_STORE_KEY_CONSTRAINT} from '../postgres/mp-run-store.js';
import {memberSetFreshness} from './member-set.js';
import {checkMemberAdmission,checkMemberSetAdmission,MAX_DATASET_BARS} from './member-admission.js';
import {buildMultiResearchContract} from './run-contract.js';
import {MP_CODES} from './codes.js';

/*
 * F11 RS-5: the internal multi-Pine fixture admission service (docs/MULTI_PINE_CONTRACT.md 5.1, 10; RD-MP-15, RD-MP-17 to RD-MP-21).
 * MultiPineFixtureService.admit(input) admits one multi-Pine research run into the internal run store. It is called only by tests and an operator fixture script on an
 * isolated cluster, with a FIXTURE-role database handle (SELECT and INSERT on the run store; scripts/grant-postgres-mp-fixture.sql). No route, worker or runtime root
 * imports this module (test/mp-run-store-static-isolation.test.js), and it writes only the member-set and run-store tables.
 *
 * Configuration (constructor, never request input): db (fixture role), store (the Store built on THE SAME db object, so every read of the admission transaction uses its
 * handle), readBotState({bot_id}) (MUST be storeBotState({store}) over that same store: a reader on another handle reads the Bot state outside the T2 snapshot), clock() in epoch ms, engineHash and supported_source_hash (64 hex characters each).
 *
 * admit(input): input is a closed key list, {owner_id, bot_id, fixture, idempotency_key, member_deployments, bridge_domains, dataset, budget, seed} plus the optional
 * parameter_slots (absent or empty) and deadline_seconds (whole seconds 60 to 900, default 900 as in the one-Pine job). Steps, in this order:
 *   1. shape (closed keys), then fixture === true (MP_FIXTURE_ONLY), then non-empty parameter_slots (MP_SOURCE_SLOTS_FORBIDDEN);
 *   2. owner and Bot authorization, as PineBridgeService.authorize (NOT_FOUND); T2 repeats it first on every attempt (RD-MP-35);
 *   3. read-only replay check: the same key with the same submission hash LOADs the stored run; another submission under the key is MP_INPUT_INVALID (idempotency_key);
 *   4. T1: freezeOrLoadMemberSet, outside any transaction (its own SERIALIZABLE transaction);
 *   5. T2, one SERIALIZABLE transaction: authorization again, then the key lookup again through the transaction (same hash LOADs, another submission is
 *      MP_INPUT_INVALID idempotency_key; RD-MP-35), then FOR SHARE on the Bot's memberships and the member deployments, member-set freshness, the RS-4 checks (checkMemberSetAdmission) with
 *      the dataset span of CONTENT_DIGEST_SQL and the capital accounts read in the transaction, buildMultiResearchContract, insertMultiRun;
 *   6. T2 restarts on 40001, 40P01 and a lost idempotency-key race, at most RUN_STORE_MAX_RETRIES times; every attempt after the first calls findMultiRunByKey first (X6)
 *      outside the transaction, and every attempt, the first included, looks the key up inside it, so a run that a competitor committed is loaded and not checked again. After the last retry the last database error is rethrown, as appendRunEvent does;
 *   7. every refusal inside T2 is THROWN out of the transaction callback (so ROLLBACK runs) and mapped to a result outside it, never returned from inside.
 * Result: {ok:true, action:'ADMIT'|'LOAD', run:{run_id, contract_hash, status, owner_recommendation_ready:false}} (status ADMITTED on ADMIT, the stored run's current
 * status on LOAD) or {ok:false, code, diagnostic}. Refusal codes are the existing MP_CODES, one-Pine codes (RS-4) and the run-store NOT_FOUND. A diagnostic carries only
 * field names, ordinals and ids, never a database message, constraint name or SQL. A database error that no refusal covers (42501, QR003, the retry bound) is rethrown.
 *
 * Quant capability (R17, RD-MP-20): the service builds the record of each member itself. State is SUPPORTED only when the member passed the RS-4 per-member checks, its
 * source hash equals supported_source_hash, and its effective inputs hash is the hash of its actual effective inputs (the recipe of reviewedInputs: canonical map of
 * input_id to effective_value). The record carries the member's own source hash and effective inputs hash. A stored hash that does not match the inputs it names is
 * the case the per-member checks do not see, so that member refuses the set with MP_MEMBER_QUANT_UNSUPPORTED.
 */

export const DEFAULT_DEADLINE_SECONDS=900,MIN_DEADLINE_SECONDS=60,MAX_DEADLINE_SECONDS=900;

const INPUT_KEYS=['owner_id','bot_id','fixture','idempotency_key','member_deployments','parameter_slots','bridge_domains','dataset','budget','seed','deadline_seconds'];
const REQUIRED_KEYS=['owner_id','bot_id','fixture','idempotency_key','member_deployments','bridge_domains','dataset','budget','seed'];
const IDEMPOTENCY_KEY=/^[A-Za-z0-9_-]{8,128}$/,HEX64=/^[0-9a-f]{64}$/;
const SERIALIZATION_FAILURE='40001',DEADLOCK_DETECTED='40P01',UNIQUE_VIOLATION='23505';
/** The idempotency-key unique index of src/postgres/mp-run-store.sql, named by the run-store module: a violation is a lost race, not a defect (insertMultiRun rethrows it). */
const KEY_CONSTRAINT=RUN_STORE_KEY_CONSTRAINT;
const MINUTE=60_000;
const PUBLIC_DIAGNOSTIC_KEYS=['stage','field','ordinal','pine_import_id','deployment_id','ordinals','against','detail','reason','pine_count','limit','run_id'];

/** The member-set store's own read texts (T1), each with the lock T2 takes on top of it (RD-MP-15), so both transactions read the same rows the same way. */
const MEMBERSHIP_ROWS=BOT_ROWS+' FOR SHARE OF m';
const DEPLOYMENT_LOCKED_ROWS=DEPLOYMENT_ROWS+' FOR SHARE';
const SOURCE_ROWS=`SELECT r.pine_import_id,r.source_version,r.source,r.source_hash,r.analysis,s.owner_id,s.bot_id FROM pine_source_revisions r
  JOIN pine_sources s ON s.pine_import_id=r.pine_import_id WHERE s.owner_id=$1 AND s.bot_id=$2 AND r.pine_import_id=ANY($3::text[]) ORDER BY r.pine_import_id,r.source_version`;

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>=1&&value.length<=200;
const primitive=value=>value===null||['string','number','boolean'].includes(typeof value);
/** A diagnostic keeps only the allowed field names and plain values: nothing from a database message, constraint or SQL text reaches the caller (X5). */
const publicDiagnostic=diagnostic=>({stage:'service',...(isObject(diagnostic)?Object.fromEntries(Object.entries(diagnostic).filter(([key,value])=>
  PUBLIC_DIAGNOSTIC_KEYS.includes(key)&&(primitive(value)||(Array.isArray(value)&&value.every(primitive))))):{})});
const refusal=(code,diagnostic)=>({ok:false,code,diagnostic:publicDiagnostic(diagnostic)});
const invalid=field=>refusal(MP_CODES.INPUT_INVALID,{field});

/** Thrown out of the T2 callback so the transaction rolls back; the loop maps it to a result outside the transaction (step 7). */
class Refusal extends Error {
  constructor(outcome) {super(outcome.code);this.outcome=outcome;}
}
const refuse=outcome=>{throw new Refusal(outcome);};
const retryable=error=>error?.code===SERIALIZATION_FAILURE||error?.code===DEADLOCK_DETECTED||(error?.code===UNIQUE_VIOLATION&&error.constraint===KEY_CONSTRAINT);

/** True when a number that is not finite sits anywhere in the value: JSON turns NaN and Infinity into null, so they would hash like null. Depth-bounded; a cycle or a deeper value counts as non-finite input. */
const hasNonFinite=(value,depth=0)=>{
  if(typeof value==='number')return !Number.isFinite(value);
  if(value===null||typeof value!=='object')return false;
  if(depth>32)return true;
  return Object.values(value).some(item=>hasNonFinite(item,depth+1));
};

/** Step 1: closed key list, shape, fixture flag, source slots. Returns a refusal or null. */
function readInput(input) {
  if(!isObject(input))return invalid('input');
  for(const key of Object.keys(input))if(!INPUT_KEYS.includes(key))return invalid('input.'+key);
  for(const key of REQUIRED_KEYS)if(!Object.hasOwn(input,key))return invalid(key);
  for(const key of Object.keys(input))if(hasNonFinite(input[key]))return invalid(key);
  if(!text(input.owner_id))return invalid('owner_id');
  if(!text(input.bot_id))return invalid('bot_id');
  if(typeof input.idempotency_key!=='string'||!IDEMPOTENCY_KEY.test(input.idempotency_key))return invalid('idempotency_key');
  if(!Array.isArray(input.member_deployments))return invalid('member_deployments');
  if(Object.hasOwn(input,'parameter_slots')&&!Array.isArray(input.parameter_slots))return invalid('parameter_slots');
  if(Object.hasOwn(input,'deadline_seconds')&&!(Number.isSafeInteger(input.deadline_seconds)&&input.deadline_seconds>=MIN_DEADLINE_SECONDS&&input.deadline_seconds<=MAX_DEADLINE_SECONDS))return invalid('deadline_seconds');
  if(input.fixture!==true)return refusal(MP_CODES.FIXTURE_ONLY,{field:'fixture'});
  if(input.parameter_slots?.length>0)return refusal(MP_CODES.SOURCE_SLOTS_FORBIDDEN,{field:'parameter_slots'});
  return null;
}

/** The hash of the request without its key, as the one-Pine enqueue hashes its body. Null when the input is not plain JSON. */
function submissionHash(input) {
  try {
    const {idempotency_key,...body}=input;
    return hash(canonical(JSON.parse(JSON.stringify(body))));
  } catch {return null;}
}

/** The effective inputs hash of an analysis, by the recipe of reviewedInputs (src/pine-bridge/input-review.js). */
export const effectiveInputsHash=analysis=>hash(canonical(Object.fromEntries(analysis.inputs.map(input=>[input.input_id,input.effective_value]))));

/** R17: the quant capability record of one member. SUPPORTED needs the RS-4 per-member checks, the configured source hash and a hash that matches the effective inputs. */
function quantCapability(source,passed,supported) {
  let proven=false;
  try {proven=passed&&source.source_hash===supported&&effectiveInputsHash(source.analysis)===source.analysis.effective_inputs_hash;}
  catch {proven=false;}
  return {state:proven?'SUPPORTED':'UNSUPPORTED',source_hash:source?.source_hash,effective_inputs_hash:source?.analysis?.effective_inputs_hash};
}

/** The exit version of each deployment from the artifact of its one SUCCEEDED generate job (RD-MP-12). A deployment without a derivable version carries none, so freshness reports exit_version. */
async function withExitVersions(db,owner_id,bot_id,deployments) {
  const found=new Map();
  if(deployments.length>0)
    for(const row of (await db.query(JOB_ROWS,[owner_id,bot_id,deployments.map(row=>row.deployment_id)])).rows)found.set(row.deployment_id,[...(found.get(row.deployment_id)??[]),row.artifact]);
  return deployments.map(row=>{
    const jobs=found.get(row.deployment_id)??[];
    const derived=jobs.length===1?deploymentExitVersion(jobs[0],row.snapshot,row.deployment_id):null;
    return derived?.ok===true?{...row,exit_version:derived.exit_version}:row;
  });
}

/** The dataset span (5.1 step 5). The query runs only for a range the dataset rules can accept; any other range is refused by checkDatasetAdmission before it reads the span. */
async function readSpan(db,dataset,profile) {
  const usable=isObject(dataset)&&Number.isSafeInteger(dataset.start_time)&&Number.isSafeInteger(dataset.end_time)&&dataset.start_time>=1&&dataset.start_time<dataset.end_time
    &&dataset.start_time%MINUTE===0&&dataset.end_time%MINUTE===0&&1+(dataset.end_time-dataset.start_time)/MINUTE<=MAX_DATASET_BARS;
  return usable?(await db.query(CONTENT_DIGEST_SQL,[dataset.start_time,dataset.end_time,typeof profile==='string'?profile:''])).rows[0]:null;
}

export class MultiPineFixtureService {
  #db;#store;#readBotState;#clock;#engineHash;#supported;

  constructor({db,store,readBotState,clock=Date.now,engineHash,supported_source_hash}={}) {
    if(!db||typeof db.query!=='function'||typeof db.transaction!=='function')throw new TypeError('MultiPineFixtureService: db is required');
    if(!store||store.db!==db||typeof store.ownsBot!=='function'||typeof store.userById!=='function'||typeof store.paperAccounts!=='function')throw new TypeError('MultiPineFixtureService: store must be a Store on the same db');
    if(typeof readBotState!=='function')throw new TypeError('MultiPineFixtureService: readBotState is required');
    if(typeof clock!=='function')throw new TypeError('MultiPineFixtureService: clock must be a function');
    if(typeof engineHash!=='string'||!HEX64.test(engineHash))throw new TypeError('MultiPineFixtureService: engineHash must be 64 hex characters');
    if(typeof supported_source_hash!=='string'||!HEX64.test(supported_source_hash))throw new TypeError('MultiPineFixtureService: supported_source_hash must be 64 hex characters');
    this.#db=db;this.#store=store;this.#readBotState=readBotState;this.#clock=clock;this.#engineHash=engineHash;this.#supported=supported_source_hash;
  }

  async admit(input) {
    const bad=readInput(input);
    if(bad!==null)return bad;
    if(this.#db.isTransaction)return invalid('db.transaction');
    const {owner_id,bot_id,idempotency_key}=input;
    // 2. The same checks as PineBridgeService.authorize: the owner owns the Bot, and both users are ACTIVE.
    if(!await this.#authorized(owner_id,bot_id))return refusal(RUN_STORE_CODES.NOT_FOUND,{field:'bot_id'});
    // 3. Read-only replay check.
    const submission_hash=submissionHash(input);
    if(submission_hash===null)return invalid('input');
    const replayed=await this.#replay(owner_id,bot_id,idempotency_key,submission_hash);
    if(replayed!==null)return replayed;
    // 4. T1, outside any transaction.
    const frozen=await freezeOrLoadMemberSet(this.#db,{owner_id,bot_id,fixture:true,member_deployments:input.member_deployments,readBotState:this.#readBotState,created_at:new Date(this.#now()).toISOString()});
    if(!frozen.ok)return refusal(frozen.code,frozen.diagnostic);
    // 5 and 6. T2, restarted as a whole.
    let last;
    for(let tries=0;tries<=RUN_STORE_MAX_RETRIES;tries++) {
      if(tries>0) {
        const winner=await this.#replay(owner_id,bot_id,idempotency_key,submission_hash);
        if(winner!==null)return winner;
      }
      try {return await this.#db.transaction(()=>this.#admission(frozen.member_set,input,submission_hash),{isolation:'SERIALIZABLE'});}
      catch(error) {
        // 7. The transaction is rolled back here; a refusal is mapped now.
        if(error instanceof Refusal)return error.outcome;
        if(retryable(error)){last=error;continue;}
        const mapped=mapRunStoreFailure(error);
        if(mapped===null)throw error;
        return refusal(mapped.code,mapped.diagnostic);
      }
    }
    throw last;
  }

  /** The injected clock, in epoch milliseconds. A clock that answers anything else is a configuration error, thrown before any write of this attempt. */
  #now() {
    const now=this.#clock();
    if(!Number.isSafeInteger(now)||now<1||!Number.isFinite(new Date(now).getTime()))throw new TypeError('MultiPineFixtureService: clock must return epoch milliseconds');
    return now;
  }

  /** The same checks as PineBridgeService.authorize: the owner owns the Bot, and both users are ACTIVE. Runs on the handle of the caller: inside T2 it reads through the transaction. */
  async #authorized(owner_id,bot_id) {
    return await this.#store.ownsBot(owner_id,bot_id)&&(await this.#store.userById(bot_id))?.status==='ACTIVE'&&(await this.#store.userById(owner_id))?.status==='ACTIVE';
  }

  /** Replay lookup by key. Outside any transaction for step 3 and the retry; inside T2 (RD-MP-35) it reads through the transaction handle. Null when the key is unused; else the LOAD result or the key conflict. */
  async #replay(owner_id,bot_id,idempotency_key,submission_hash) {
    const found=await findMultiRunByKey(this.#db,{owner_id,bot_id,idempotency_key});
    if(!found.ok)return refusal(found.code,found.diagnostic);
    if(!found.found)return null;
    if(found.run.submission_hash!==submission_hash)return invalid('idempotency_key');
    return {ok:true,action:'LOAD',run:{run_id:found.run.run_id,contract_hash:found.run.contract_hash,status:found.status,owner_recommendation_ready:false}};
  }

  /** One T2 attempt, inside the SERIALIZABLE transaction. Returns the insertMultiRun result; every refusal is thrown. */
  async #admission(set,input,submission_hash) {
    const db=this.#db,{owner_id,bot_id}=set;
    const now=this.#now();
    // RD-MP-35, on every attempt and before any other check: authorization and the idempotency key are read again through the transaction. A user deactivated after step 2 is NOT_FOUND,
    // and a same-key run that a competitor committed before this snapshot is loaded (or conflicts), so no later check can refuse it.
    if(!await this.#authorized(owner_id,bot_id))refuse(refusal(RUN_STORE_CODES.NOT_FOUND,{field:'bot_id'}));
    const replayed=await this.#replay(owner_id,bot_id,input.idempotency_key,submission_hash);
    if(replayed!==null) {
      if(!replayed.ok)refuse(replayed);
      return replayed;
    }
    const ids=set.members.map(member=>member.deployment_id),imports=set.members.map(member=>member.pine_import_id);
    // The locks come first (RD-MP-15): a row that changes after the snapshot fails this transaction with 40001.
    const memberships=(await db.query(MEMBERSHIP_ROWS,[owner_id,bot_id])).rows;
    const deployments=await withExitVersions(db,owner_id,bot_id,(await db.query(DEPLOYMENT_LOCKED_ROWS,[owner_id,bot_id,ids])).rows);
    const evidence=(await db.query(EVIDENCE_ROWS,[ids])).rows;
    const bot_state=await this.#readBotState({bot_id});
    const fresh=memberSetFreshness(set,{owner_id,bot_id,bot_state,memberships,deployments,evidence});
    if(!fresh.ok)refuse(refusal(fresh.code,fresh.diagnostic));
    if(!fresh.fresh)refuse(refusal(fresh.code,fresh.diagnostic));
    // RS-4 members: the one-Pine rows of each member of the frozen set, in ordinal order.
    const sources=(await db.query(SOURCE_ROWS,[owner_id,bot_id,imports])).rows;
    const context={owner_id,bot_id,supported_source_hash:this.#supported};
    const outcomes=[];
    const members=set.members.map(frozen=>{
      const deployment=deployments.find(row=>row.deployment_id===frozen.deployment_id)??null;
      const member={ordinal:frozen.ordinal,pine_import_id:frozen.pine_import_id,source_version:frozen.source_version,deployment,
        evidence:evidence.find(row=>row.deployment_id===frozen.deployment_id)??null,
        source:sources.find(row=>row.pine_import_id===frozen.pine_import_id&&row.source_version===deployment?.source_version)??null};
      const outcome=checkMemberAdmission(member,context);
      outcomes.push(outcome);
      return {...member,quant_capability:quantCapability(member.source,outcome.ok,this.#supported)};
    });
    // The span profile is the one the contract will carry: the validated execution model of ordinal 1 (a failed member refuses the set before the span is used).
    const dataset_span=await readSpan(db,input.dataset,outcomes[0]?.ok===true?outcomes[0].execution_model?.data_profile:undefined);
    const capital_accounts=(await this.#store.paperAccounts(bot_id)).map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance}));
    const admitted=checkMemberSetAdmission({owner_id,bot_id,supported_source_hash:this.#supported,members,dataset:input.dataset,dataset_span,capital_accounts,now});
    if(!admitted.ok)refuse(refusal(admitted.code,admitted.diagnostic));
    const built=buildMultiResearchContract({member_set:set,member_set_id:set.member_set_id,set_hash:set.set_hash,membership_hash:set.membership_hash,pine_count:set.pine_count,
      members:set.members,owner_id,bot_id,policy_hash:set.policy_hash,funding_cutoff:set.funding_cutoff,capital_accounts,model:outcomes[0].execution_model,rules:structuredClone(RULES),
      engine_hash:this.#engineHash,dataset:{start_time:input.dataset.start_time,end_time:input.dataset.end_time,warmup_bars:input.dataset.warmup_bars,content_digest:dataset_span.digest},
      budget:input.budget,seed:input.seed,bridge_domains:input.bridge_domains,fixture:true});
    if(!built.ok)refuse(refusal(built.code,built.diagnostic));
    const seconds=input.deadline_seconds??DEFAULT_DEADLINE_SECONDS;
    const stored=await insertMultiRun(db,{member_set:set,contract:built.contract,idempotency_key:input.idempotency_key,submission_hash,created_at_ms:now,deadline_ms:now+seconds*1000});
    if(!stored.ok)refuse(refusal(stored.code,stored.diagnostic));
    return stored;
  }
}
