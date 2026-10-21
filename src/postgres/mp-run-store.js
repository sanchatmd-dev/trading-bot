import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../pine-bridge/source.js';
import {decideFreeze} from '../multi-pine/member-set.js';
import {validateMultiResearchContract} from '../multi-pine/run-contract.js';
import {MP_CODES,MP_CODE_LIST,MP_CODE_PATTERN,MULTI_PINE_BLOCKER} from '../multi-pine/codes.js';

/*
 * F11-01 RS-2: writer and readers of the internal multi-Pine run store (src/postgres/mp-run-store.sql; docs/MULTI_PINE_CONTRACT.md RD-MP-15, RD-MP-17 to
 * RD-MP-20; root decisions W1 to W5). No route, worker, service or runtime root imports this module. It runs only on a FIXTURE-role connection of an
 * isolated cluster: the runtime role holds no privilege on the run-store tables, so every function here fails with 42501 for it (rethrown, never mapped).
 *
 * Results: {ok:true,...} or a refusal {ok:false,code,diagnostic}. Pure refusal codes come from src/multi-pine/codes.js (MP_*); NOT_FOUND is the store code
 * of comparison-store.js. A database error that is not mapped below is rethrown.
 *
 * insertMultiRun(db,input) runs INSIDE the caller's SERIALIZABLE transaction (the admission transaction T2 of RS-5): it refuses unless db.isTransaction, and its
 * first statement reads transaction_isolation and throws QR003 (rethrown, never mapped) unless the level is serializable, so a replay (LOAD), a key conflict and a
 * readFresh refusal are covered as well as the INSERT (the database trigger stays the last defence). It opens no transaction, no SAVEPOINT and no PL/pgSQL EXCEPTION
 * block (root ruling K4: the run row and its seq 1 ADMITTED event must be written by the top-level transaction), and it never retries: 40001 and 40P01 are rethrown,
 * and so is a unique violation of the idempotency key (a lost key race); the caller restarts the whole transaction, at most three times, and the new snapshot loads
 * the winner. A refusal that came from a DATABASE error leaves the caller's transaction aborted: such a refusal carries diagnostic.rollback_required=true. RS-5
 * rule (P8): the caller then THROWS out of its db.transaction callback (any error, so ROLLBACK runs and no stale read of the aborted transaction is trusted) and maps
 * the refusal outside the callback; it never returns the refusal from the callback. A refusal found before the INSERT (input, contract, replay conflict, readFresh,
 * stored integrity) leaves the transaction usable.
 * RS-5 passes only the output of buildMultiResearchContract (P9): the contract carries the capital but the member set stores only its hash (capital_basis_hash) and the
 * accounts are not stored, so this module cannot re-bind the capital to the set (RD-MP-18); a hand-built contract with another valid capital would be admitted here.
 * Steps: closed input check; contract and member set checks (pure); idempotency lookup (same submission hash loads that run, another one is MP_INPUT_INVALID
 * field idempotency_key); FOR SHARE locks on the Bot's memberships and the member deployments (RD-MP-15); optional readFresh; INSERT run; INSERT seq 1 event.
 * The caller supplies the application clock (created_at_ms, deadline_ms) and, for a replay, the same submission_hash. Bot-state freshness (memberSetFreshness)
 * is the caller's job inside the same transaction, through readFresh or before the call; the database stale guard stays the last defence.
 *
 * appendRunEvent(db,input) appends one event in its OWN SERIALIZABLE transaction (refused when db is already in one). The database clock stamps at_ms; the
 * result_hash is computed here from the result; the status graph, the reason_code/result presence rules and the result tie are the database guards, mapped
 * by constraint name. A lost race (40001, 40P01, a duplicate seq, or the order guard) is retried at most three times; after that 40001, 40P01 and a duplicate
 * seq are rethrown to the caller. The order guard is not retried (P3): the application read and the trigger see one snapshot, so it cannot fire on a race
 * and maps at once to run.order.
 *
 * getMultiRun, findMultiRunByKey and listMultiRuns re-check EVERY row they return: the contract through validateMultiResearchContract, the contract hash,
 * the column ties, the stored member set record through decideFreeze and its binding to the contract, and the events (contiguous seq, status graph,
 * strictly increasing at_ms, reason_code and result presence, result_hash recomputed, result tie). A row that fails is a storage integrity refusal
 * (MP_INPUT_INVALID, diagnostic stage 'stored'); a hash is a tie and never an authorization.
 */

/** One first attempt plus at most three retries (appendRunEvent), and the retry bound the admission transaction applies to insertMultiRun. */
export const RUN_STORE_MAX_RETRIES=3;
export const RUN_STORE_CODES=Object.freeze({NOT_FOUND:'NOT_FOUND'});
/** Guard names of src/postgres/mp-run-store.sql (the CONSTRAINT of each QR004). */
export const RUN_STORE_GUARD=Object.freeze({RUN:'mp_research_runs_guard',STALE:'mp_research_runs_set_stale',COMPLETE:'mp_research_runs_complete',ORDER:'mp_research_run_events_order',
  RESULT:'mp_research_run_events_result',TRANSITION:'mp_research_run_events_transition'});
export const RUN_STORE_STATUSES=Object.freeze(['ADMITTED','RUNNING','SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
export const RUN_STORE_TERMINAL=Object.freeze(['SUCCEEDED','NO_VALID_CANDIDATE','FAILED','CANCELLED','TIMED_OUT']);
export const RUN_LIST_DEFAULT_LIMIT=100,RUN_LIST_MAX_LIMIT=500;

const QR_GUARD='QR004',QR_ISOLATION='QR003',SERIALIZATION_FAILURE='40001',DEADLOCK_DETECTED='40P01',UNIQUE_VIOLATION='23505',CHECK_VIOLATION='23514',FK_VIOLATION='23503',NOT_NULL_VIOLATION='23502';
const KEY_CONSTRAINT='mp_research_runs_idempotency_key',EVENT_KEY='mp_research_run_events_pkey';
export {KEY_CONSTRAINT as RUN_STORE_KEY_CONSTRAINT};
const EDGES=Object.freeze({ADMITTED:['RUNNING','FAILED','CANCELLED','TIMED_OUT'],RUNNING:RUN_STORE_TERMINAL});
const HEX64=/^[0-9a-f]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,KEY=/^[A-Za-z0-9_-]{8,128}$/;
const MAX_TIME=8_640_000_000_000_000;
/** Deadline bounds of the one-Pine job (src/postgres/quant-research.js deadline_seconds: 60 s to 900 s), as the table CHECK states them. */
const MIN_WINDOW_MS=60_000,MAX_WINDOW_MS=900_000;
const INSERT_KEYS=['member_set','contract','idempotency_key','submission_hash','created_at_ms','deadline_ms','readFresh'];
const INSERT_REQUIRED=INSERT_KEYS.slice(0,6);
const APPEND_KEYS=['owner_id','run_id','status','reason_code','result'];
const BINDING_KEYS=['owner_id','bot_id','member_set_id','set_hash','membership_hash','pine_count','policy_hash','funding_cutoff','members','same_bar_order'];
const RUN_COLUMNS=['run_id','owner_id','bot_id','member_set_id','set_hash','membership_hash','pine_count','contract_version','contract','contract_hash','idempotency_key','submission_hash',
  'engine_hash','dataset_content_digest','created_at_ms','deadline_ms','fixture'];
const RUN_SELECT=`SELECT ${RUN_COLUMNS.join(',')} FROM public.mp_research_runs`;
const INSERT_RUN=`INSERT INTO public.mp_research_runs(${RUN_COLUMNS.join(',')}) VALUES(${RUN_COLUMNS.map((_,index)=>'$'+(index+1)).join(',')})`;
const EVENT_COLUMNS='run_id,seq,status,at_ms,reason_code,result,result_hash';
const INSERT_EVENT=`INSERT INTO public.mp_research_run_events(${EVENT_COLUMNS}) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING seq,status,at_ms,reason_code,result_hash`;
const ISOLATION_LEVEL="SELECT pg_catalog.current_setting('transaction_isolation') AS level";
const LOCK_MEMBERSHIPS='SELECT pine_import_id FROM public.pine_memberships WHERE owner_id=$1 AND bot_id=$2 ORDER BY pine_import_id FOR SHARE';
const LOCK_DEPLOYMENTS='SELECT deployment_id FROM public.pine_deployments WHERE owner_id=$1 AND bot_id=$2 AND deployment_id=ANY($3::text[]) ORDER BY deployment_id FOR SHARE';

const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.length>=1&&value.length<=200;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const number=value=>{const parsed=typeof value==='number'?value:Number(value);return Number.isSafeInteger(parsed)?parsed:Number.NaN;};
const refusal=(code,diagnostic)=>({ok:false,code,diagnostic});
const invalid=(field,extra={})=>refusal(MP_CODES.INPUT_INVALID,{stage:'store',field,...extra});
const storedRefusal=(field,extra={})=>refusal(MP_CODES.INPUT_INVALID,{stage:'stored',field,...extra});
const notFound=()=>refusal(RUN_STORE_CODES.NOT_FOUND,{stage:'store'});

/** Plain JSON only (no accessors, symbols, undefined, cycles, non-finite numbers or U+0000 in a string or key), depth at most 64: what the result hash and the JSONB column can hold. */
function plainJson(value,depth=0) {
  if(typeof value==='string')return !value.includes('\u0000');
  if(value===null||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||depth>64)return false;
  if(Array.isArray(value)) {
    if(Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)return false;
    return value.every((_,index)=>{const field=Object.getOwnPropertyDescriptor(value,String(index));return !!field&&Object.hasOwn(field,'value')&&plainJson(field.value,depth+1);});
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  return Reflect.ownKeys(value).every(name=>{
    const field=typeof name==='string'?Object.getOwnPropertyDescriptor(value,name):null;
    return !(typeof name==='string'&&name.includes('\u0000'))&&!!field&&field.enumerable===true&&Object.hasOwn(field,'value')&&plainJson(field.value,depth+1);
  });
}

/* ---------- database failures ---------- */

/**
 * Maps a database error of a run-store write to a refusal, or null when this module does not own it (the caller rethrows it): 40001, 40P01, QR002, QR003,
 * a unique violation of the idempotency key or of the event key (a lost race), 42501 and every other error. QR004 maps by the guard that fired
 * (error.constraint); a CHECK, foreign key, not-null or other unique violation is a storage refusal. Exported so the admission transaction can map a
 * failure that surfaces at COMMIT (the deferred completeness guard).
 */
export function mapRunStoreFailure(error) {
  const code=error?.code,constraint=error?.constraint??null;
  if(code===QR_GUARD) {
    switch(constraint) {
      case RUN_STORE_GUARD.STALE:return refusal(MP_CODES.MEMBER_SET_STALE,{stage:'store',field:'insert_guard',guard:constraint});
      case RUN_STORE_GUARD.RUN:return invalid('storage.binding',{guard:constraint});
      case RUN_STORE_GUARD.COMPLETE:return invalid('storage.complete',{guard:constraint});
      case RUN_STORE_GUARD.TRANSITION:return invalid('run.transition',{guard:constraint});
      case RUN_STORE_GUARD.ORDER:return invalid('run.order',{guard:constraint});
      case RUN_STORE_GUARD.RESULT:return invalid('run.result',{guard:constraint});
      default:return null;
    }
  }
  if(code===UNIQUE_VIOLATION)return constraint===KEY_CONSTRAINT||constraint===EVENT_KEY?null:invalid('storage',{sqlstate:code,constraint});
  if(code===CHECK_VIOLATION||code===FK_VIOLATION||code===NOT_NULL_VIOLATION)return invalid('storage',{sqlstate:code,constraint});
  return null;
}

/* ---------- stored row integrity ---------- */

class Bad extends Error {
  constructor(field,extra) {super(field);this.field=field;this.extra=extra;}
}
const bad=(field,extra={})=>{throw new Bad(field,extra);};

function checkEvents(row,contract,eventRows) {
  if(eventRows.length<1||eventRows.length>64)bad('events');
  let previous=null,previousMs=0;
  const events=eventRows.map((event,index)=>{
    const seq=number(event.seq),atMs=number(event.at_ms);
    if(seq!==index+1)bad('events.seq',{seq:index+1});
    if(!RUN_STORE_STATUSES.includes(event.status))bad('events.status',{seq});
    if(previous===null?event.status!=='ADMITTED':!(EDGES[previous]??[]).includes(event.status))bad('events.transition',{seq});
    if(!(atMs>=1&&atMs<=MAX_TIME&&atMs>previousMs))bad('events.at_ms',{seq});
    const terminal=RUN_STORE_TERMINAL.includes(event.status);
    if(event.status==='SUCCEEDED'||event.status==='NO_VALID_CANDIDATE') {
      const result=event.result;
      if(event.reason_code!==null||!isObject(result)||typeof event.result_hash!=='string'||!HEX64.test(event.result_hash))bad('events.result',{seq});
      if(hash(canonical(result))!==event.result_hash)bad('events.result_hash',{seq});
      if(result.run_id!==row.run_id||result.contract_hash!==row.contract_hash||result.owner_recommendation_ready!==false
        ||!Array.isArray(result.acceptance_blockers)||!result.acceptance_blockers.includes(MULTI_PINE_BLOCKER))bad('events.result_tie',{seq});
    } else if(terminal) {
      if(typeof event.reason_code!=='string'||!MP_CODE_PATTERN.test(event.reason_code)||event.result!==null||event.result_hash!==null)bad('events.reason',{seq});
    } else if(event.reason_code!==null||event.result!==null||event.result_hash!==null)bad('events.open',{seq});
    previous=event.status;previousMs=atMs;
    return {seq,status:event.status,at_ms:atMs,reason_code:event.reason_code,result:event.result,result_hash:event.result_hash};
  });
  return events;
}

/** Throws Bad for the first integrity failure. Returns the reader view of one stored run. */
function buildView(row,setRow,eventRows) {
  const created=number(row.created_at_ms),deadline=number(row.deadline_ms),count=number(row.pine_count);
  if(row.fixture!==true)bad('fixture');
  if(typeof row.run_id!=='string'||!UUID.test(row.run_id))bad('run_id');
  if(typeof row.idempotency_key!=='string'||!KEY.test(row.idempotency_key))bad('idempotency_key');
  if(typeof row.submission_hash!=='string'||!HEX64.test(row.submission_hash))bad('submission_hash');
  if(!(created>=1&&created<=MAX_TIME&&deadline>=created+MIN_WINDOW_MS&&deadline<=created+MAX_WINDOW_MS))bad('deadline_ms');
  const checked=validateMultiResearchContract(row.contract);
  if(!checked.ok)bad('contract',{detail:checked.diagnostic?.field??checked.code});
  const contract=checked.contract;
  if(typeof row.contract_hash!=='string'||hash(canonical(contract))!==row.contract_hash)bad('contract_hash');
  for(const [key,value] of [['version',row.contract_version],['owner_id',row.owner_id],['bot_id',row.bot_id],['member_set_id',row.member_set_id],['set_hash',row.set_hash],
    ['membership_hash',row.membership_hash],['pine_count',count],['engine_hash',row.engine_hash]])
    if(canonical(contract[key])!==canonical(value))bad('columns.'+key);
  if(contract.dataset.content_digest!==row.dataset_content_digest)bad('columns.dataset_content_digest');
  // The member set row the run names: the stored record must pass the S1 record check and agree with its columns and with the contract.
  if(!setRow)bad('member_set');
  const decided=decideFreeze(setRow.record,[]);
  if(!decided.ok)bad('member_set.record',{detail:decided.diagnostic?.field??decided.code});
  const set=decided.member_set;
  if(set.fixture!==true||setRow.fixture!==true)bad('member_set.fixture');
  for(const key of ['member_set_id','owner_id','bot_id','set_hash'])if(setRow[key]!==set[key]||row[key]!==set[key])bad('member_set.'+key);
  for(const key of BINDING_KEYS)if(canonical(contract[key])!==canonical(set[key]))bad('member_set.'+key);
  if(hash(canonical(contract.model))!==set.execution_model_hash)bad('member_set.execution_model_hash');
  const events=checkEvents(row,contract,eventRows);
  const last=events[events.length-1];
  return {run:{run_id:row.run_id,owner_id:row.owner_id,bot_id:row.bot_id,member_set_id:row.member_set_id,set_hash:row.set_hash,membership_hash:row.membership_hash,pine_count:count,
      contract_version:row.contract_version,contract,contract_hash:row.contract_hash,idempotency_key:row.idempotency_key,submission_hash:row.submission_hash,engine_hash:row.engine_hash,
      dataset_content_digest:row.dataset_content_digest,created_at_ms:created,deadline_ms:deadline,fixture:true},
    events,status:last.status,terminal:RUN_STORE_TERMINAL.includes(last.status),owner_recommendation_ready:false,acceptance_blockers:[...contract.acceptance_blockers]};
}

/** Reads the member set rows and the events of the given run rows in two batched queries and checks every run. Returns {ok:true,views} or the first integrity refusal. */
async function readViews(db,rows) {
  if(rows.length===0)return {ok:true,views:[]};
  const sets=new Map((await db.query('SELECT member_set_id,owner_id,bot_id,set_hash,fixture,record FROM public.mp_member_sets WHERE member_set_id=ANY($1::uuid[])',
    [[...new Set(rows.map(row=>row.member_set_id))]])).rows.map(row=>[row.member_set_id,row]));
  const events=new Map();
  for(const event of (await db.query(`SELECT ${EVENT_COLUMNS} FROM public.mp_research_run_events WHERE run_id=ANY($1::uuid[]) ORDER BY run_id,seq`,[rows.map(row=>row.run_id)])).rows)
    events.set(event.run_id,[...(events.get(event.run_id)??[]),event]);
  const views=[];
  for(const row of rows) {
    try {views.push(buildView(row,sets.get(row.member_set_id),events.get(row.run_id)??[]));}
    catch(error) {
      if(error instanceof Bad)return storedRefusal(error.field,{run_id:row.run_id,...error.extra});
      throw error;
    }
  }
  return {ok:true,views};
}

/* ---------- writer: insertMultiRun ---------- */

function readInsertInput(db,input) {
  if(!isObject(input))return invalid('input');
  for(const key of Object.keys(input))if(!INSERT_KEYS.includes(key))return invalid('input.'+key);
  for(const key of INSERT_REQUIRED)if(!Object.hasOwn(input,key))return invalid(key);
  if(typeof input.idempotency_key!=='string'||!KEY.test(input.idempotency_key))return invalid('idempotency_key');
  if(typeof input.submission_hash!=='string'||!HEX64.test(input.submission_hash))return invalid('submission_hash');
  if(!integer(input.created_at_ms,1,MAX_TIME))return invalid('created_at_ms');
  if(!integer(input.deadline_ms,input.created_at_ms+MIN_WINDOW_MS,Math.min(MAX_TIME,input.created_at_ms+MAX_WINDOW_MS)))return invalid('deadline_ms');
  if(input.readFresh!==undefined&&typeof input.readFresh!=='function')return invalid('readFresh');
  if(!db||typeof db.query!=='function'||db.isTransaction!==true)return invalid('db.transaction');
  return null;
}

/** The contract must be a valid multi-Pine contract and equal the frozen member set it names; returns {ok:true,contract,set} or a refusal. */
function bindContract(input) {
  const checked=validateMultiResearchContract(input.contract);
  if(!checked.ok)return checked;
  const decided=decideFreeze(input.member_set,[]);
  if(!decided.ok)return decided;
  const contract=checked.contract,set=decided.member_set;
  if(set.fixture!==true)return invalid('member_set.fixture');
  for(const key of BINDING_KEYS)if(canonical(contract[key])!==canonical(set[key]))return invalid('contract.'+key,{against:'member_set'});
  if(hash(canonical(contract.model))!==set.execution_model_hash)return invalid('contract.model',{against:'member_set.execution_model_hash'});
  return {ok:true,contract,set};
}

const handle=(run,action)=>({ok:true,action,run:{run_id:run.run.run_id,contract_hash:run.run.contract_hash,status:run.status,owner_recommendation_ready:false}});

/**
 * Admit one run inside the caller's SERIALIZABLE transaction. input: {member_set (the frozen S1 record), contract (the S2 contract built from it),
 * idempotency_key, submission_hash, created_at_ms, deadline_ms, readFresh?}. readFresh() runs after the FOR SHARE locks inside the transaction and returns
 * {ok:true} or {ok:false,code,diagnostic} with a code of MP_CODES (for example MP_MEMBER_SET_STALE from memberSetFreshness).
 * Returns {ok:true,action:'ADMIT'|'LOAD',run:{run_id,contract_hash,status,owner_recommendation_ready:false}} or a refusal. See the file header for the transaction rules.
 */
export async function insertMultiRun(db,input) {
  const bad_input=readInsertInput(db,input);
  if(bad_input!==null)return bad_input;
  const bound=bindContract(input);
  if(!bound.ok)return bound;
  const {contract}=bound;
  const contract_hash=hash(canonical(contract));
  try {
    // P2: the first statement. A non-serializable transaction is a programming error of the caller: thrown, never mapped, before any read or lock.
    if((await db.query(ISOLATION_LEVEL)).rows[0]?.level!=='serializable')
      throw Object.assign(new Error('Multi-Pine run store writes require a SERIALIZABLE transaction'),{code:QR_ISOLATION});
    // Replay: the same submission loads the run it created; another submission under the same key is a conflict.
    const existing=(await db.query(`${RUN_SELECT} WHERE owner_id=$1 AND bot_id=$2 AND idempotency_key=$3`,[contract.owner_id,contract.bot_id,input.idempotency_key])).rows;
    if(existing.length>0) {
      if(existing[0].submission_hash!==input.submission_hash)return invalid('idempotency_key');
      const loaded=await readViews(db,existing);
      return loaded.ok?handle(loaded.views[0],'LOAD'):loaded;
    }
    // RD-MP-15: lock the Bot's memberships and the member deployments, so a row that changes after the snapshot fails this transaction with 40001.
    await db.query(LOCK_MEMBERSHIPS,[contract.owner_id,contract.bot_id]);
    await db.query(LOCK_DEPLOYMENTS,[contract.owner_id,contract.bot_id,contract.members.map(member=>member.deployment_id)]);
    if(input.readFresh!==undefined) {
      const fresh=await input.readFresh();
      if(!isObject(fresh)||(fresh.ok!==true&&!(fresh.ok===false&&MP_CODE_LIST.includes(fresh.code))))return invalid('readFresh');
      if(fresh.ok===false)return refusal(fresh.code,isObject(fresh.diagnostic)?fresh.diagnostic:{stage:'fresh'});
    }
    const run_id=randomUUID();
    // Two statements of the top-level transaction: no SAVEPOINT and no EXCEPTION block around them (K4). The deferred completeness guard runs at COMMIT.
    await db.query(INSERT_RUN,[run_id,contract.owner_id,contract.bot_id,contract.member_set_id,contract.set_hash,contract.membership_hash,contract.pine_count,contract.version,
      JSON.stringify(contract),contract_hash,input.idempotency_key,input.submission_hash,contract.engine_hash,contract.dataset.content_digest,input.created_at_ms,input.deadline_ms,true]);
    await db.query(INSERT_EVENT,[run_id,1,'ADMITTED',1,null,null,null]);
    return {ok:true,action:'ADMIT',run:{run_id,contract_hash,status:'ADMITTED',owner_recommendation_ready:false}};
  } catch(error) {
    const mapped=mapRunStoreFailure(error);
    if(mapped===null)throw error;
    return {...mapped,diagnostic:{...mapped.diagnostic,rollback_required:true}};
  }
}

/* ---------- writer: appendRunEvent ---------- */

function readAppendInput(db,input) {
  if(!isObject(input))return invalid('input');
  for(const key of Object.keys(input))if(!APPEND_KEYS.includes(key))return invalid('input.'+key);
  if(!text(input.owner_id)||typeof input.run_id!=='string'||!UUID.test(input.run_id))return notFound();
  if(!RUN_STORE_STATUSES.includes(input.status))return invalid('status');
  if(input.reason_code!==undefined&&input.reason_code!==null&&(typeof input.reason_code!=='string'||!MP_CODE_PATTERN.test(input.reason_code)))return invalid('reason_code');
  if(input.result!==undefined&&input.result!==null&&!(isObject(input.result)&&plainJson(input.result)))return invalid('result');
  if(!db||typeof db.query!=='function'||typeof db.transaction!=='function'||db.isTransaction===true)return invalid('db.transaction');
  return null;
}

async function appendAttempt(db,input) {
  const owned=(await db.query('SELECT run_id FROM public.mp_research_runs WHERE run_id=$1 AND owner_id=$2',[input.run_id,input.owner_id])).rows;
  if(owned.length===0)return notFound();
  const last=(await db.query('SELECT seq FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1',[input.run_id])).rows[0];
  if(!last)return storedRefusal('events',{run_id:input.run_id});
  const result=input.result??null;
  // at_ms is a placeholder: the order guard overwrites it with the database clock. The result hash follows the result; the guards judge the rest.
  const stored=(await db.query(INSERT_EVENT,[input.run_id,number(last.seq)+1,input.status,1,input.reason_code??null,result===null?null:JSON.stringify(result),
    result===null?null:hash(canonical(result))])).rows[0];
  return {ok:true,event:{run_id:input.run_id,seq:number(stored.seq),status:stored.status,at_ms:number(stored.at_ms),reason_code:stored.reason_code,result_hash:stored.result_hash},
    terminal:RUN_STORE_TERMINAL.includes(stored.status)};
}

const retryable=error=>error?.code===SERIALIZATION_FAILURE||error?.code===DEADLOCK_DETECTED||(error?.code===UNIQUE_VIOLATION&&error.constraint===EVENT_KEY);

/**
 * Append one status event of an owned run. input: {owner_id, run_id, status, reason_code?, result?}. The run must belong to owner_id (another owner's run
 * and an unknown one both answer NOT_FOUND). Returns {ok:true,event:{run_id,seq,status,at_ms,reason_code,result_hash},terminal} or a refusal; the database
 * guards map by constraint name (transition to run.transition, result to run.result, order to run.order at once).
 */
export async function appendRunEvent(db,input) {
  const bad_input=readAppendInput(db,input);
  if(bad_input!==null)return bad_input;
  let last;
  for(let tries=0;tries<=RUN_STORE_MAX_RETRIES;tries++) {
    try {return await db.transaction(()=>appendAttempt(db,input),{isolation:'SERIALIZABLE'});}
    catch(error) {
      if(retryable(error)){last=error;continue;}
      const mapped=mapRunStoreFailure(error);
      if(mapped===null)throw error;
      return mapped;
    }
  }
  throw last;
}

/* ---------- readers ---------- */

/** One owned run with its events, every check applied. Absent, malformed and foreign ids answer NOT_FOUND. */
export async function getMultiRun(db,input) {
  if(!isObject(input)||Object.keys(input).some(key=>!['owner_id','run_id'].includes(key)))return invalid('input');
  if(!text(input.owner_id)||typeof input.run_id!=='string'||!UUID.test(input.run_id))return notFound();
  const rows=(await db.query(`${RUN_SELECT} WHERE run_id=$1 AND owner_id=$2`,[input.run_id,input.owner_id])).rows;
  if(rows.length===0)return notFound();
  const read=await readViews(db,rows);
  return read.ok?{ok:true,...read.views[0]}:read;
}

/** Replay lookup by (owner, Bot, idempotency key). {ok:true,found:false} when none; else {ok:true,found:true,...view} with every check applied. */
export async function findMultiRunByKey(db,input) {
  if(!isObject(input)||Object.keys(input).some(key=>!['owner_id','bot_id','idempotency_key'].includes(key)))return invalid('input');
  if(!text(input.owner_id))return invalid('owner_id');
  if(!text(input.bot_id))return invalid('bot_id');
  if(typeof input.idempotency_key!=='string'||!KEY.test(input.idempotency_key))return invalid('idempotency_key');
  const rows=(await db.query(`${RUN_SELECT} WHERE owner_id=$1 AND bot_id=$2 AND idempotency_key=$3`,[input.owner_id,input.bot_id,input.idempotency_key])).rows;
  if(rows.length===0)return {ok:true,found:false};
  const read=await readViews(db,rows);
  return read.ok?{ok:true,found:true,...read.views[0]}:read;
}

/**
 * Internal list of the runs of one owner (optionally one Bot), newest first (created_at_ms descending, then run_id), bounded by limit (default 100, at most 500).
 * Keyset paging (P1): before_ms and before_run_id are given together and keep the runs after that position in the order (created_at_ms < before_ms, or equal
 * and run_id > before_run_id), so runs that tie on created_at_ms are never dropped at a page boundary. limit+1 rows are fetched; when more exist the answer
 * carries next={before_ms,before_run_id} (the last returned run), else null. Every returned run passes every check; one that fails refuses the whole list,
 * naming its run_id. Returns {ok:true,runs:[view...],next}.
 */
export async function listMultiRuns(db,input) {
  if(!isObject(input)||Object.keys(input).some(key=>!['owner_id','bot_id','before_ms','before_run_id','limit'].includes(key)))return invalid('input');
  if(!text(input.owner_id))return invalid('owner_id');
  if(input.bot_id!==undefined&&!text(input.bot_id))return invalid('bot_id');
  if(input.before_ms!==undefined&&!integer(input.before_ms,1,MAX_TIME))return invalid('before_ms');
  if(input.before_run_id!==undefined&&(typeof input.before_run_id!=='string'||!UUID.test(input.before_run_id)))return invalid('before_run_id');
  if(input.before_ms!==undefined&&input.before_run_id===undefined)return invalid('before_run_id');
  if(input.before_run_id!==undefined&&input.before_ms===undefined)return invalid('before_ms');
  if(input.limit!==undefined&&!integer(input.limit,1,RUN_LIST_MAX_LIMIT))return invalid('limit');
  const limit=input.limit??RUN_LIST_DEFAULT_LIMIT;
  const fetched=(await db.query(`${RUN_SELECT} WHERE owner_id=$1 AND ($2::text IS NULL OR bot_id=$2) AND ($3::bigint IS NULL OR created_at_ms<$3 OR (created_at_ms=$3 AND run_id>$5::uuid))`
    +' ORDER BY created_at_ms DESC,run_id ASC LIMIT $4',[input.owner_id,input.bot_id??null,input.before_ms??null,limit+1,input.before_run_id??null])).rows;
  const rows=fetched.slice(0,limit);
  const read=await readViews(db,rows);
  if(!read.ok)return read;
  const last=rows[rows.length-1];
  return {ok:true,runs:read.views,next:fetched.length>limit?{before_ms:number(last.created_at_ms),before_run_id:last.run_id}:null};
}
