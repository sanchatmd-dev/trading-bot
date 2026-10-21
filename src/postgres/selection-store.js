import {randomUUID,createHash} from 'node:crypto';
import {canonical} from '../pine-bridge/source.js';
import {buildRegistration,registrationHashOf} from '../selection/registration.js';
import {registrationBody} from '../selection/hash.js';
import {CODES,REQUIRED_MARKET,MINUTE,isObject,isInt,text,refuse,byCreation,byText} from '../selection/codes.js';
import {checkCancel,transitionSelection} from '../selection/lifecycle.js';
import {recheckWindow} from '../selection/window.js';
import {rankSelection,replayOutcome as replayRanking} from '../selection/ranking.js';
import {EXPOSURE_CODES,appendExposures,readExposures,readExposuresLocked,toComparisonEntries} from './exposure-register.js';

/**
 * QR-4 selection store for the qualified-selection tables (src/postgres/quant-selection.sql). Slice S2-1 is the registration path: the only
 * writers of the registration (registerSelection) and of the owner cancel (cancelSelection), the owner-scoped read (readSelection) and the
 * searched-window reader (readSearchedWindows). Slice S2-2 is the RO-12 path at the end of this file: freezeWindow, startEvaluation (the first start
 * also appends the QR4_SELECTION exposure row), writeOutcome, replaySelectionOutcome, markWindowDataUnavailable and findOrphanSelectionExposures. No route,
 * worker or pure-module change.
 *
 * Every write runs in its own SERIALIZABLE transaction and retries a serialization failure (40001) from the first statement, at most three
 * times, rerunning every read and every pure check. A QR004 guard is never retried: it is mapped by the guard name the database raised
 * (error.constraint), never by message text. A registration refusal writes no row.
 *
 * Clocks (RC-S22). registerSelection reads quant_selection_now_ms() as the first statement of its transaction and hashes that value as
 * registered_at_ms; any registered_at_ms in the request is replaced. The database stamps frozen_at_ms separately. The register at_ms is an
 * application clock and is never compared with these.
 */
export const SERIALIZATION_RETRIES=3;
export const SERIALIZATION_FAILURE='40001';
/** writeOutcome without a usable evaluation list throws an Error with this code and retryable=true; nothing was written and no terminal state was stored. */
export const EVALUATIONS_UNAVAILABLE='EVALUATIONS_UNAVAILABLE';
/** A registration whose transaction took longer than this between its first clock read and its insert is refused before any row (the database guard allows 60 s). */
export const REGISTRATION_SLOW_LIMIT_MS=50000;
export const REGISTRATION_TOO_SLOW='REGISTRATION_TOO_SLOW';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256=/^[0-9a-f]{64}$/;
const TERMINAL=['SELECTION_COMPLETED','SELECTION_INCOMPLETE','SELECTION_CANCELLED'];
const OWNER_KEY='quant_selection_registrations_owner_key_key';
const sha=value=>createHash('sha256').update(value).digest('hex');
// bigint arrives as a number from the product pool parser and as a string from a plain client; both are accepted, nothing else is.
const num=value=>{
  if(typeof value==='number')return Number.isSafeInteger(value)?value:null;
  if(typeof value==='string'&&/^-?\d{1,16}$/.test(value)){const parsed=Number(value);return Number.isSafeInteger(parsed)?parsed:null;}
  return null;
};

/** QR004 guard name (error.constraint) to the refusal the application returns. Unknown guard names are not mapped and are rethrown. */
export const GUARD_REFUSALS=Object.freeze({
  quant_selection_registration_clock:[CODES.QR4_WINDOW_INVALID,'REGISTRATION_CLOCK'],
  quant_selection_participant_ready:[CODES.QR4_PARTICIPANT_NOT_READY,'PARTICIPANT_READY_GUARD'],
  quant_selection_participant_member:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_participant_member'],
  quant_selection_status_transition:[CODES.QR4_TRANSITION_INVALID,'STATUS_TRANSITION_GUARD'],
  quant_selection_exposure_bind:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_exposure_bind'],
  quant_selection_registration_complete:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_registration_complete'],
  quant_selection_universe_member:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_universe_member'],
  quant_selection_freeze_order:[CODES.QR4_TRANSITION_INVALID,'FREEZE_ORDER'],
  quant_selection_start_order:[CODES.QR4_TRANSITION_INVALID,'START_ORDER'],
  quant_selection_start_deadline:[CODES.QR4_ADMISSION_REFUSED,'START_DEADLINE_GUARD'],
  quant_selection_start_ready:[CODES.QR4_PARTICIPANT_STALE,'START_READY_GUARD'],
  quant_selection_outcome_order:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_outcome_order'],
  quant_selection_outcome_complete:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_outcome_complete'],
  quant_selection_first_start_complete:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_first_start_complete'],
  quant_selection_replay_order:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_replay_order']});

class Refused extends Error {constructor(refusal){super(refusal.code);this.refusal=refusal;}}

/** A refusal for a database error that the writer can name, or null. QR003 (a writer outside SERIALIZABLE) is a programming error and is never mapped. */
function refusalOfError(error){
  if(error?.code==='QR004'&&Object.hasOwn(GUARD_REFUSALS,error.constraint??'')){const [code,detail]=GUARD_REFUSALS[error.constraint];return refuse(code,detail);}
  if(error?.code==='23514')return refuse(CODES.INTEGRITY_CHECK_FAILED,'CHECK:'+String(error.constraint??'').slice(0,100));
  if(error?.code==='23503')return refuse(CODES.INVALID_FIELDS,'REFERENCE:'+String(error.constraint??'').slice(0,100));
  return null;
}

/** Runs fn in its own SERIALIZABLE transaction; a 40001 failure reruns fn from the start, at most `retries` times. Other errors are not retried. */
async function serializable(db,fn,retries=SERIALIZATION_RETRIES){
  if(!db||typeof db.transaction!=='function'||db.isTransaction===true)throw Error('A selection write requires its own SERIALIZABLE transaction');
  for(let attempt=0;;attempt++){
    try{return await db.transaction(fn,{isolation:'SERIALIZABLE'});}
    catch(error){if(error?.code!==SERIALIZATION_FAILURE||attempt>=retries)throw error;}
  }
}

/** The hashed text of a registration: the canonical JSON of the registration without registration_hash, lists in the neutral order of hash.js. */
export function registrationBodyText(registration){
  return canonical(registrationBody(registration));
}

/**
 * The train, validation and holdout windows of every run of the owner on one of the sources (every status), as the entries
 * [{owner_id, source_hash, run_id, kind, window:{start_ms,end_ms}}] that src/selection/window.js reads, or null when any run cannot be read
 * (the pure module then reports SEARCHED_WINDOWS_UNREADABLE). Windows are half-open [start_ms, end_ms) from the dataset start, warm-up
 * included (RC-S26): train [0, train_end), validation [train_end, validation_end), holdout [validation_end, test_end) bars. The kind is
 * RESEARCH_RUN for every run until slice S3 adds the evaluation-run marker (S3 must-do: research runs and evaluation runs must be told apart here, so an
 * evaluation run of another selection is judged by its own rule and not as searched data by accident). A run without a readable dataset start or split makes the
 * whole list unreadable.
 */
export async function readSearchedWindows(db,{owner_id:owner,source_hashes:sources}={}){
  if(!db||typeof db.query!=='function'||!text(owner)||!Array.isArray(sources)||sources.length===0||sources.some(item=>!text(item)))return null;
  const rows=(await db.query("SELECT run_id,contract FROM public.quant_jobs WHERE owner_id=$1 AND contract->>'source_hash'=ANY($2::text[]) ORDER BY run_id",[owner,sources])).rows;
  const entries=[];
  for(const row of rows){
    const contract=isObject(row.contract)?row.contract:null,start=contract?.dataset?.start_time,split=contract?.split,source=contract?.source_hash;
    if(!text(row.run_id)||!text(source)||!Number.isSafeInteger(start)||start<0||!isObject(split))return null;
    const {train_end:train,validation_end:validation,test_end:test}=split;
    if(![train,validation,test].every(Number.isSafeInteger)||!(train>0&&validation>train&&test>validation))return null;
    for(const [from,to] of [[0,train],[train,validation],[validation,test]]){
      const window={start_ms:start+from*MINUTE,end_ms:start+to*MINUTE};
      if(!isInt(window.start_ms)||!isInt(window.end_ms))return null;
      entries.push({owner_id:owner,source_hash:source,run_id:row.run_id,kind:'RESEARCH_RUN',window});
    }
  }
  return entries;
}

const idsOk=(registration)=>UUID.test(registration.selection_id)
  &&registration.universe.every(item=>item.export_id===null||(typeof item.export_id==='string'&&UUID.test(item.export_id)))
  &&registration.participants.every(item=>UUID.test(item.export_id)&&SHA256.test(item.validation_binding?.package_hash??''));

/**
 * Registers one selection (contract 12.2, 13.1; RC-S21, RC-S22). Own SERIALIZABLE transaction, steps in this order:
 *   1. read the database clock (first statement, takes the snapshot) as registered_at_ms;
 *   2. optional readInputs(tx, {owner_id, registered_at_ms}) may return {universe, context} read under the same snapshot (library, package and
 *      validation rows); without it request.universe and context are used as given;
 *   3. read the exposure register (plain readExposures: a registration is not an exposure and takes no register lock), the searched windows of
 *      the owner on the universe sources, and the earlier selections and registrations of the owner (every earlier selection, fixtures included);
 *   4. buildRegistration (pure; the four reads of step 3 replace any caller value); a refusal writes nothing;
 *   5. insert the registration, the universe rows, the participant rows and the seq 1 REGISTER event; the commit runs the deferred check C1.
 * Just before the first insert the clock is read again: more than REGISTRATION_SLOW_LIMIT_MS (50 s) after the hashed time the registration is not written and
 * an Error with code REGISTRATION_TOO_SLOW and retryable=true is thrown (nothing was written; the caller may submit again, which hashes a new time).
 * request.selection_id is accepted only with the internal option (a caller-supplied id would let one owner probe the ids of another); without the option a
 * request that carries one is refused INVALID_FIELDS/SELECTION_ID, and with it a primary key collision gives the same refusal for every owner.
 * A repeated registration key returns QR4_SELECTION_EXISTS with the existing selection_id. Returns
 * {ok:true, selection_id, registration, registration_hash, frozen_at_ms, attempts} or a refusal {ok:false, code, detail, ...}. Other database
 * errors (an unreachable database, an unmapped guard, 42501) are thrown.
 */
export async function registerSelection(db,{request,context={},readInputs=null,retries=SERIALIZATION_RETRIES,internal=false}={}){
  if(!isObject(request)||!text(request.owner_id))return refuse(CODES.INVALID_FIELDS,'IDENTITY_OR_TIME');
  if(request.selection_id!==undefined&&internal!==true)return refuse(CODES.INVALID_FIELDS,'SELECTION_ID');
  const selectionId=request.selection_id===undefined?randomUUID():request.selection_id;
  if(typeof selectionId!=='string'||!UUID.test(selectionId))return refuse(CODES.INVALID_FIELDS,'SELECTION_ID');
  let attempts=0,attemptedKey=null;
  try{
    return await serializable(db,async()=>{
      attempts++;
      const now=num((await db.query('SELECT public.quant_selection_now_ms() AS now_ms')).rows[0].now_ms);
      if(now===null)throw Error('The database clock is unreadable');
      const owner=request.owner_id;
      const inputs=typeof readInputs==='function'?await readInputs(db,{owner_id:owner,registered_at_ms:now}):null;
      const universe=Array.isArray(inputs?.universe)?inputs.universe:request.universe;
      const base={...context,...(isObject(inputs?.context)?inputs.context:{})};
      const market={owner_id:owner,...REQUIRED_MARKET};
      const exposures=await readExposures(db,market);
      const sources=[...new Set((Array.isArray(universe)?universe:[]).map(item=>isObject(item)?item.source_hash:null).filter(text))];
      const searched=await readSearchedWindows(db,{owner_id:owner,source_hashes:sources});
      const earlier=(await db.query('SELECT selection_id,owner_id,registration_key FROM public.quant_selection_registrations WHERE owner_id=$1 ORDER BY frozen_at_ms,selection_id',[owner])).rows;
      const built=buildRegistration({...request,selection_id:selectionId,registered_at_ms:now,universe},
        {...base,exposure_register:exposures.ok?toComparisonEntries(exposures):null,searched_windows:searched,
          prior_selection_ids:earlier.map(row=>row.selection_id),existing_registrations:earlier});
      if(!built.ok)return built;
      const registration=built.registration;
      attemptedKey=registration.registration_key;
      const body=registrationBodyText(registration);
      // The text the database hashes must be the text the pure module hashed; any difference fails closed before a row is written.
      if(sha(body)!==registration.registration_hash||registrationHashOf(registration)!==registration.registration_hash)return refuse(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_HASH');
      if(!idsOk(registration))return refuse(CODES.INVALID_FIELDS,'IDENTIFIER_SHAPE');
      const win=registration.window;
      const stamp=num((await db.query('SELECT public.quant_selection_now_ms() AS now_ms')).rows[0].now_ms);
      if(stamp===null)throw Error('The database clock is unreadable');
      if(stamp-now>REGISTRATION_SLOW_LIMIT_MS)
        throw Object.assign(Error('The registration transaction took longer than '+REGISTRATION_SLOW_LIMIT_MS+' ms; nothing was written'),{code:REGISTRATION_TOO_SLOW,retryable:true});
      const stored=(await db.query(`INSERT INTO public.quant_selection_registrations(selection_id,owner_id,fixture,broker,symbol,timeframe,window_kind,start_ms,end_ms,warmup_bars,
        evaluation_bars,total_bars,participant_count,admission_deadline_ms,registered_at_ms,registration_key,registration_hash,body_canonical)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING frozen_at_ms`,
        [registration.selection_id,registration.owner_id,registration.fixture,registration.market.broker,registration.market.symbol,registration.market.timeframe,win.kind,win.start_ms,
          win.end_ms,win.warmup_bars,win.evaluation_bars,win.total_bars,registration.participant_count,registration.admission_deadline_ms,registration.registered_at_ms,
          registration.registration_key,registration.registration_hash,body])).rows[0];
      const members=[...registration.universe].sort(byCreation);
      for(const [index,item] of members.entries())
        await db.query('INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [registration.selection_id,index+1,item.run_id,item.kind,item.status,item.code,item.export_id]);
      const chosen=[...registration.participants].sort(byText('export_id'));
      for(const [index,item] of chosen.entries())
        await db.query(`INSERT INTO public.quant_selection_participants(selection_id,export_id,position,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[registration.selection_id,item.export_id,index+1,item.run_id,item.package_hash,item.source_hash,item.rules_hash,
          item.validation_binding.package_hash,item.validation_binding.validated_at_utc]);
      await db.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids)
        VALUES($1,1,'REGISTER','SELECTION_REGISTERED',NULL,NULL,NULL,'{}')`,[registration.selection_id]);
      return {ok:true,selection_id:registration.selection_id,registration,registration_hash:registration.registration_hash,frozen_at_ms:num(stored.frozen_at_ms),attempts};
    },retries);
  }catch(error){
    if(error?.code==='23505'&&error.constraint===OWNER_KEY){
      // A concurrent or earlier registration with the same key: report the existing selection_id (read in a new transaction).
      const found=attemptedKey===null?null:await existingByKey(db,request.owner_id,attemptedKey);
      if(found!==null)return refuse(CODES.QR4_SELECTION_EXISTS,null,{selection_id:found});
    }
    // The same refusal as a malformed id, for every owner: a taken id is never confirmed.
    if(error?.code==='23505'&&error.constraint==='quant_selection_registrations_pkey')return refuse(CODES.INVALID_FIELDS,'SELECTION_ID');
    const refusal=refusalOfError(error);
    if(refusal!==null)return refusal;
    throw error;
  }
}

/** The selection_id stored for a registration key of the owner (read after the failed insert rolled back), or null. */
async function existingByKey(db,owner,key){
  const row=(await db.query('SELECT selection_id FROM public.quant_selection_registrations WHERE owner_id=$1 AND registration_key=$2',[owner,key])).rows[0];
  return row?row.selection_id:null;
}

/** Runs fn in one READ ONLY snapshot (REPEATABLE READ), so the rows of one selection are read at one time. */
async function readSnapshot(db,fn){
  if(db.isTransaction===true)return fn();
  return db.transaction(async()=>{await db.query('SET TRANSACTION READ ONLY');return fn();},{isolation:'REPEATABLE READ'});
}

/**
 * True when the universe or participant rows are not exactly the lists of the parsed body: the same count and, at every position i, the body item i.
 * The database check C1 enforces this at commit; the reader repeats it so a row set that was changed by other means is never returned as the selection.
 */
function rowsDifferFromBody(body,universe,participants){
  const members=Array.isArray(body.universe)?body.universe:null,chosen=Array.isArray(body.participants)?body.participants:null;
  if(members===null||chosen===null||universe.length!==members.length||participants.length!==chosen.length)return true;
  const same=(a,b)=>(a??null)===(b??null);
  for(const [index,item] of members.entries()){
    const row=universe[index];
    if(!isObject(item)||num(row.position)!==index+1||!same(row.run_id,item.run_id)||!same(row.member_kind,item.kind)||!same(row.universe_status,item.status)
      ||!same(row.first_code,item.code)||!same(row.export_id,item.export_id))return true;
  }
  for(const [index,item] of chosen.entries()){
    const row=participants[index],binding=isObject(item)&&isObject(item.validation_binding)?item.validation_binding:{};
    if(!isObject(item)||num(row.position)!==index+1||!same(row.export_id,item.export_id)||!same(row.run_id,item.run_id)||!same(row.package_hash,item.package_hash)
      ||!same(row.source_hash,item.source_hash)||!same(row.rules_hash,item.rules_hash)||!same(row.validation_package_hash,binding.package_hash)
      ||!same(row.validated_at_utc,binding.validated_at_utc))return true;
  }
  return false;
}

const eventOf=row=>({seq:row.seq,event:row.event,status:row.status,code:row.code,detail:row.detail,outcome:row.outcome,
  completed_evaluation_run_ids:row.completed_evaluation_run_ids,at_ms:num(row.at_ms)});

/**
 * Owner-scoped read of one selection in a READ ONLY snapshot. An absent selection and one of another owner are the same NOT_FOUND. The stored
 * body is verified before it is returned: text hash, parse, and registrationHashOf of the parsed registration (INTEGRITY_CHECK_FAILED with the
 * details REGISTRATION_UNREADABLE or REGISTRATION_HASH otherwise). Returns {ok:true, selection} with the current status (the last event), the parsed
 * registration (registration_hash included, ready for recheckWindow), the universe, participant and event rows, the freeze, the starts, the stored outcome
 * row and replay_mismatch (true when a SELECTION_REPLAY_MISMATCH row exists for the selection).
 */
export async function readSelection(db,{owner_id:owner,selection_id:selectionId}={}){
  if(!text(owner)||typeof selectionId!=='string'||!UUID.test(selectionId))return refuse(CODES.NOT_FOUND);
  return readSnapshot(db,async()=>{
    const row=(await db.query('SELECT * FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
    if(!row)return refuse(CODES.NOT_FOUND);
    let parsed=null;
    try{parsed=JSON.parse(row.body_canonical);}catch{return refuse(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_UNREADABLE');}
    if(!isObject(parsed))return refuse(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_UNREADABLE');
    const registration={...parsed,registration_hash:row.registration_hash};
    if(sha(row.body_canonical)!==row.registration_hash||registrationHashOf(registration)!==row.registration_hash)return refuse(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_HASH');
    const universe=(await db.query('SELECT position,run_id,member_kind,universe_status,first_code,export_id FROM public.quant_selection_universe WHERE selection_id=$1 ORDER BY position',[selectionId])).rows;
    const participants=(await db.query(`SELECT position,export_id,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc
      FROM public.quant_selection_participants WHERE selection_id=$1 ORDER BY position`,[selectionId])).rows;
    const differs=rowsDifferFromBody(parsed,universe,participants);
    if(differs)return refuse(CODES.INTEGRITY_CHECK_FAILED,'ROWS_DIFFER_FROM_BODY');
    const events=(await db.query(`SELECT seq,event,status,code,detail,outcome,completed_evaluation_run_ids,at_ms FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq`,[selectionId])).rows.map(eventOf);
    const last=events[events.length-1]??null;
    if(last===null)return refuse(CODES.INTEGRITY_CHECK_FAILED,'STATUS_LOG_EMPTY');
    const freezeRow=(await db.query('SELECT dataset_hash,start_ms,end_ms,bars_total,frozen_at_ms FROM public.quant_selection_window_freezes WHERE selection_id=$1',[selectionId])).rows[0]??null;
    const freeze=freezeRow&&{dataset_hash:freezeRow.dataset_hash,start_ms:num(freezeRow.start_ms),end_ms:num(freezeRow.end_ms),bars_total:freezeRow.bars_total,frozen_at_ms:num(freezeRow.frozen_at_ms)};
    const starts=(await db.query('SELECT export_id,evaluation_run_id,parent_run_id,dataset_hash,engine_hash,started_at_ms FROM public.quant_selection_evaluation_starts WHERE selection_id=$1 ORDER BY export_id',[selectionId])).rows
      .map(item=>({...item,started_at_ms:num(item.started_at_ms)}));
    const outcomeRow=(await db.query('SELECT outcome,outcome_hash,body_canonical,created_at_ms FROM public.quant_selection_outcomes WHERE selection_id=$1',[selectionId])).rows[0]??null;
    const outcomeStored=outcomeRow&&{...outcomeRow,created_at_ms:num(outcomeRow.created_at_ms)};
    // The fact the labels read (SELECTION_REPLAY_MISMATCH overlay): true when any replay event of this selection was stored.
    const replayMismatch=(await db.query('SELECT 1 FROM public.quant_selection_replay_events WHERE selection_id=$1 LIMIT 1',[selectionId])).rows.length>0;
    return {ok:true,selection:{selection_id:row.selection_id,owner_id:row.owner_id,fixture:row.fixture,status:last.status,code:last.code,outcome:last.outcome,seq:last.seq,
      window_kind:row.window_kind,start_ms:num(row.start_ms),end_ms:num(row.end_ms),registered_at_ms:num(row.registered_at_ms),frozen_at_ms:num(row.frozen_at_ms),
      admission_deadline_ms:num(row.admission_deadline_ms),registration_key:row.registration_key,registration_hash:row.registration_hash,registration,universe,participants,events,freeze,starts,outcome_row:outcomeStored,replay_mismatch:replayMismatch}};
  });
}

/**
 * Owner cancel (contract 12.2): own SERIALIZABLE transaction. NOT_FOUND for an absent or foreign selection, CONFIRMATION_REQUIRED without the
 * token, QR4_TRANSITION_INVALID from a terminal status (checkCancel), otherwise appends seq = last + 1 OWNER_CANCEL to SELECTION_CANCELLED.
 * A concurrent terminal event ends as a primary key violation or 40001; either way the answer is QR4_TRANSITION_INVALID after the retry or the
 * key collision. The registration and its exposure record, if any, are never changed.
 */
export async function cancelSelection(db,{owner_id:owner,selection_id:selectionId,confirmed=false,retries=SERIALIZATION_RETRIES}={}){
  if(!text(owner)||typeof selectionId!=='string'||!UUID.test(selectionId))return refuse(CODES.NOT_FOUND);
  try{
    return await serializable(db,async()=>{
      const row=(await db.query('SELECT selection_id FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
      if(!row)return refuse(CODES.NOT_FOUND);
      const last=(await db.query('SELECT seq,status FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq DESC LIMIT 1',[selectionId])).rows[0];
      if(!last)return refuse(CODES.INTEGRITY_CHECK_FAILED,'STATUS_LOG_EMPTY');
      const decided=checkCancel(last.status,confirmed===true);
      if(!decided.ok)return decided;
      const seq=Number(last.seq)+1;
      await db.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids)
        VALUES($1,$2,'OWNER_CANCEL','SELECTION_CANCELLED',NULL,NULL,NULL,'{}')`,[selectionId,seq]);
      return {ok:true,selection_id:selectionId,status:'SELECTION_CANCELLED',seq};
    },retries);
  }catch(error){
    if(error?.code==='23505'&&error.constraint==='quant_selection_status_events_pkey')return refuse(CODES.QR4_TRANSITION_INVALID,'CONCURRENT_EVENT');
    const refusal=refusalOfError(error);
    if(refusal!==null)return refusal;
    throw error;
  }
}

export const TERMINAL_STATUSES=Object.freeze([...TERMINAL]);

/* ---- S2-2: window freeze, evaluation starts (RO-12 rechecks), outcome and replay ---- */

const EXPOSURE_ERRORS=new Set([...Object.values(EXPOSURE_CODES),'42P01']);
const blocked=(code,detail)=>({action:'BLOCK',refusal:refuse(code,detail,{blocked:true})});
const ending=(event,code,detail)=>({action:'END',event,code,detail});
const marketOf=owner=>({owner_id:owner,...REQUIRED_MARKET});

async function lastEvent(tx,selectionId){
  return (await tx.query('SELECT seq,status FROM public.quant_selection_status_events WHERE selection_id=$1 ORDER BY seq DESC LIMIT 1',[selectionId])).rows[0]??null;
}
async function insertEvent(tx,selectionId,seq,{event,status,code=null,detail=null,outcome=null,completed=[]}){
  await tx.query(`INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status,code,detail,outcome,completed_evaluation_run_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [selectionId,seq,event,status,code,detail===null?null:String(detail).slice(0,200),outcome,completed]);
}
/** The status event that ends a selection INCOMPLETE; the tuple is judged by the pure lifecycle first, so the writer never offers the database an edge the lifecycle refuses. */
async function endWith(tx,selectionId,last,{event,code,detail}){
  const decided=transitionSelection(last.status,{kind:event,to:'SELECTION_INCOMPLETE',code});
  if(decided.ok!==true)return decided;
  await insertEvent(tx,selectionId,Number(last.seq)+1,{event,status:'SELECTION_INCOMPLETE',code,detail});
  return {ok:false,ended:true,status:'SELECTION_INCOMPLETE',code,detail:detail??null,event};
}
const validIds=(owner,selectionId)=>text(owner)&&typeof selectionId==='string'&&UUID.test(selectionId);

/** The export ids among exportIds whose participant is no longer a validated one-Pine export of the owner (the predicate of the start_ready guard). */
async function notReady(tx,selectionId,exportIds){
  return (await tx.query(`SELECT p.export_id FROM public.quant_selection_participants p JOIN public.quant_selection_registrations r ON r.selection_id=p.selection_id
    WHERE p.selection_id=$1 AND p.export_id=ANY($2::uuid[]) AND NOT (
      EXISTS(SELECT 1 FROM public.bi_exports x WHERE x.export_id=p.export_id AND x.owner_id=r.owner_id AND x.run_id=p.run_id AND x.mode='ONE_PINE' AND x.fixture=r.fixture AND x.package_hash=p.package_hash)
      AND (SELECT e.status FROM public.bi_status_events e WHERE e.export_id=p.export_id ORDER BY e.seq DESC LIMIT 1)='EXPORT_VALIDATED'
      AND EXISTS(SELECT 1 FROM public.ql4c_validation v WHERE v.export_id=p.export_id AND v.package_hash=p.package_hash AND v.fixture=r.fixture AND v.validated_at_utc=p.validated_at_utc))`,
    [selectionId,exportIds])).rows.map(row=>row.export_id);
}

/**
 * The RO-12 judgement of one guarded step, run inside the SERIALIZABLE transaction after the register lock was taken and the register was read under it.
 * stage EVALUATION_START (first start from SELECTION_REGISTERED, later starts from SELECTION_EVALUATING) or OUTCOME_WRITE (SELECTION_EVALUATING). Returns
 * {action:'OK', first, last, frozen, participant} to proceed, {action:'BLOCK', refusal} when the step must not run and the selection stays open (rolled back or
 * nothing written: an unreadable register or searched list, a missing freeze, a status that does not allow the step, a stored row that disagrees), or
 * {action:'END', event, code, detail, last} when the selection ends INCOMPLETE (an observed overlap, a stale participant, a passed deadline).
 * QR4-side check of the exposure order: before the first start the register holds no row of this selection (an orphan row blocks the step); from the
 * second step on it holds exactly one, over the registered window, and the selection has its FIRST_EVALUATION_START event.
 */
async function judgeStep(tx,{owner,selectionId,registration,read,stage,exportId=null,participantCheck=null}){
  const row=(await tx.query('SELECT registration_hash,admission_deadline_ms FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
  if(!row||row.registration_hash!==registration.registration_hash)return blocked(CODES.INTEGRITY_CHECK_FAILED,'REGISTRATION_CHANGED');
  const last=await lastEvent(tx,selectionId);
  if(!last)return blocked(CODES.INTEGRITY_CHECK_FAILED,'STATUS_LOG_EMPTY');
  const allowed=stage==='EVALUATION_START'?['SELECTION_REGISTERED','SELECTION_EVALUATING']:['SELECTION_EVALUATING'];
  if(!allowed.includes(last.status))return blocked(CODES.QR4_TRANSITION_INVALID,'STATUS_'+last.status);
  const frozen=(await tx.query('SELECT dataset_hash FROM public.quant_selection_window_freezes WHERE selection_id=$1',[selectionId])).rows[0]?.dataset_hash??null;
  if(frozen===null)return blocked(CODES.QR4_TRANSITION_INVALID,'WINDOW_NOT_FROZEN');
  const first=last.status==='SELECTION_REGISTERED';
  // The deadline is judged before the exposure-order checks, so a passed deadline can end a selection that those checks would otherwise block for good.
  if(stage==='EVALUATION_START'){
    const clock=num((await tx.query('SELECT public.quant_selection_now_ms() AS now_ms')).rows[0].now_ms);
    if(clock===null)return blocked(CODES.INTEGRITY_CHECK_FAILED,'CLOCK_UNREADABLE');
    if(clock>num(row.admission_deadline_ms))return {...ending('DEADLINE_PASSED',CODES.QR4_ADMISSION_REFUSED,'ADMISSION_DEADLINE'),last};
  }
  const own=read?.ok===true?read.rows.filter(item=>item.kind==='QR4_SELECTION'&&item.selection_id===selectionId):[];
  if(first&&own.length>0)return blocked(CODES.INTEGRITY_CHECK_FAILED,'ORPHAN_EXPOSURE');
  if(!first){
    if(read?.ok===true&&(own.length!==1||own[0].owner_id!==owner||own[0].start_ms!==registration.window.start_ms||own[0].end_ms!==registration.window.end_ms))return blocked(CODES.INTEGRITY_CHECK_FAILED,'EXPOSURE_MISSING');
    const started=(await tx.query("SELECT 1 FROM public.quant_selection_status_events WHERE selection_id=$1 AND event='FIRST_EVALUATION_START'",[selectionId])).rows;
    if(started.length!==1)return blocked(CODES.INTEGRITY_CHECK_FAILED,'EXPOSURE_WITHOUT_START');
  }
  const sources=[...new Set(registration.participants.map(item=>item.source_hash))];
  const searched=await readSearchedWindows(tx,{owner_id:owner,source_hashes:sources});
  const decided=recheckWindow({registration,exposure_register:toComparisonEntries(read),searched_windows:searched,stage});
  if(decided.ok!==true)return decided.ends_selection===true?{...ending('WINDOW_RECHECK_FAILED',decided.code,decided.detail),last}:blocked(decided.code,decided.detail);
  const starts=(await tx.query('SELECT export_id FROM public.quant_selection_evaluation_starts WHERE selection_id=$1',[selectionId])).rows;
  if(stage==='OUTCOME_WRITE'){
    if(starts.length!==registration.participants.length)return blocked(CODES.QR4_TRANSITION_INVALID,'EVALUATIONS_NOT_ALL_STARTED');
    return {action:'OK',first:false,last,frozen};
  }
  const participant=registration.participants.find(item=>item.export_id===exportId);
  if(!participant)return blocked(CODES.INVALID_FIELDS,'EXPORT_ID');
  if(starts.some(item=>item.export_id===exportId))return blocked(CODES.QR4_TRANSITION_INVALID,'ALREADY_STARTED');
  // The first start re-judges every participant; a later start its own participant (the database guard start_ready repeats the predicate).
  const stale=await notReady(tx,selectionId,first?registration.participants.map(item=>item.export_id):[exportId]);
  if(stale.length>0)return {...ending('PARTICIPANT_INELIGIBLE',CODES.QR4_PARTICIPANT_STALE,'NOT_READY:'+stale[0]),last};
  if(typeof participantCheck==='function'){
    const verdict=await participantCheck(tx,{registration,participant,first});
    if(verdict)return {...ending('PARTICIPANT_INELIGIBLE',CODES.QR4_PARTICIPANT_STALE,String(verdict.detail??'PARTICIPANT_CHECK').slice(0,120)),last};
  }
  return {action:'OK',first,last,frozen,participant};
}

/** A step the database refused with a QR004 start guard that the writer's own check should have caught first (a race): the selection ends in a new transaction. */
const GUARD_ENDINGS=Object.freeze({
  quant_selection_start_deadline:['DEADLINE_PASSED',CODES.QR4_ADMISSION_REFUSED,'START_DEADLINE_GUARD'],
  quant_selection_start_ready:['PARTICIPANT_INELIGIBLE',CODES.QR4_PARTICIPANT_STALE,'START_READY_GUARD']});
async function endAfterGuard(db,owner,selectionId,error,retries){
  const mapped=error?.code==='QR004'&&Object.hasOwn(GUARD_ENDINGS,error.constraint??'')?GUARD_ENDINGS[error.constraint]:undefined;
  if(!mapped)return null;
  const [event,code,detail]=mapped;
  return serializable(db,async()=>{
    const row=(await db.query('SELECT 1 FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
    if(!row)return refuse(CODES.NOT_FOUND);
    const last=await lastEvent(db,selectionId);
    if(!last||TERMINAL.includes(last.status))return refuse(CODES.QR4_TRANSITION_INVALID,'TERMINAL');
    return endWith(db,selectionId,last,{event,code,detail});
  },retries);
}

/** The refusal of a database error in a write of this section, or null. */
function stepRefusal(error){
  if(error?.code==='23505'){
    if(error.constraint==='quant_selection_evaluation_starts_pkey')return refuse(CODES.QR4_TRANSITION_INVALID,'ALREADY_STARTED');
    if(error.constraint==='quant_selection_evaluation_starts_run_key')return refuse(CODES.INVALID_FIELDS,'EVALUATION_RUN_ID_TAKEN');
    if(error.constraint==='quant_selection_status_events_pkey')return refuse(CODES.QR4_TRANSITION_INVALID,'CONCURRENT_EVENT');
    if(error.constraint==='quant_selection_window_freezes_pkey')return refuse(CODES.QR4_TRANSITION_INVALID,'ALREADY_FROZEN');
    if(error.constraint==='quant_selection_outcomes_pkey')return refuse(CODES.QR4_TRANSITION_INVALID,'OUTCOME_EXISTS');
  }
  // A QR4_SELECTION register row of another owner already names this selection id (the register keeps one row per selection id): a refusal, the selection stays open.
  if(error?.code==='23505'&&error.constraint==='quant_exposure_register_qr4_unique')return refuse(CODES.INTEGRITY_CHECK_FAILED,'EXPOSURE_SELECTION_TAKEN',{blocked:true});
  if(EXPOSURE_ERRORS.has(error?.code))return refuse(CODES.QR4_EXPOSURE_REGISTRY_UNAVAILABLE,'REGISTRY_UNREADABLE',{blocked:true});
  return refusalOfError(error);
}

/**
 * T-FREEZE: stores the dataset hash of the closed window W once, while the selection is SELECTION_REGISTERED (before the first start). The window columns
 * repeat the registration. The guard refuses it before the window has closed by the database stamp. Returns {ok:true, dataset_hash, frozen_at_ms}.
 */
export async function freezeWindow(db,{owner_id:owner,selection_id:selectionId,dataset_hash:datasetHash,retries=SERIALIZATION_RETRIES}={}){
  if(!validIds(owner,selectionId))return refuse(CODES.NOT_FOUND);
  if(typeof datasetHash!=='string'||!SHA256.test(datasetHash))return refuse(CODES.INVALID_FIELDS,'DATASET_HASH');
  try{
    return await serializable(db,async()=>{
      const row=(await db.query('SELECT start_ms,end_ms,total_bars FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
      if(!row)return refuse(CODES.NOT_FOUND);
      const last=await lastEvent(db,selectionId);
      if(!last||last.status!=='SELECTION_REGISTERED')return refuse(CODES.QR4_TRANSITION_INVALID,'STATUS_'+(last?.status??'NONE'));
      const stored=(await db.query('INSERT INTO public.quant_selection_window_freezes(selection_id,dataset_hash,start_ms,end_ms,bars_total) VALUES($1,$2,$3,$4,$5) RETURNING frozen_at_ms',
        [selectionId,datasetHash,row.start_ms,row.end_ms,row.total_bars])).rows[0];
      return {ok:true,selection_id:selectionId,dataset_hash:datasetHash,frozen_at_ms:num(stored.frozen_at_ms)};
    },retries);
  }catch(error){const refusal=stepRefusal(error);if(refusal!==null)return refusal;throw error;}
}

/** RC-S27: a window data gap found before the first start ends the selection on the REGISTERED to INCOMPLETE edge with QR4_WINDOW_DATA_UNAVAILABLE. */
export async function markWindowDataUnavailable(db,{owner_id:owner,selection_id:selectionId,retries=SERIALIZATION_RETRIES}={}){
  if(!validIds(owner,selectionId))return refuse(CODES.NOT_FOUND);
  try{
    return await serializable(db,async()=>{
      const row=(await db.query('SELECT 1 FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
      if(!row)return refuse(CODES.NOT_FOUND);
      const last=await lastEvent(db,selectionId);
      if(!last)return refuse(CODES.INTEGRITY_CHECK_FAILED,'STATUS_LOG_EMPTY');
      if(TERMINAL.includes(last.status))return refuse(CODES.QR4_TRANSITION_INVALID,'TERMINAL');
      return endWith(db,selectionId,last,{event:'WINDOW_DATA_UNAVAILABLE',code:CODES.QR4_WINDOW_DATA_UNAVAILABLE,detail:'WINDOW_DATA_UNAVAILABLE'});
    },retries);
  }catch(error){const refusal=stepRefusal(error);if(refusal!==null)return refusal;throw error;}
}

/**
 * T-START1 and T-STARTn (RO-12, contract 4.1 and 13.3): starts the evaluation of one participant in its own SERIALIZABLE transaction. The registration is read
 * first in its own snapshot (it is immutable and the transaction verifies its hash). In the write transaction the register lock is the first statement
 * (appendExposures, whose check runs under the lock): the register and the searched windows are rechecked (recheckWindow, EVALUATION_START), and only then
 *   - from SELECTION_REGISTERED the QR4_SELECTION exposure row of the evaluation part of W is appended, FIRST_EVALUATION_START is written and the evaluation
 *     start row follows (the status guard binds the event to that register row; the commit check C3 repeats it);
 *   - from SELECTION_EVALUATING only the evaluation start row is written (the check saw the selection already started: no second register row).
 * A failed recheck ends the selection (WINDOW_RECHECK_FAILED with QR4_WINDOW_EXPOSED or QR4_WINDOW_OVERLAPS_SEARCHED_DATA) and writes no exposure row. A passed
 * admission deadline, or a participant that is no longer validated (or the optional participantCheck(tx,{registration,participant,first}) hook returning a
 * truthy {detail}), ends it too (DEADLINE_PASSED, PARTICIPANT_INELIGIBLE). An unreadable register, an unreadable searched list, a missing freeze or a
 * stored row that disagrees blocks the step: nothing is written, the selection stays open, the answer has blocked:true.
 * Returns {ok:true, first, evaluation_run_id, ...}, {ok:false, ended:true, ...} or a refusal.
 */
export async function startEvaluation(db,{owner_id:owner,selection_id:selectionId,export_id:exportId,evaluation_run_id:runId,participantCheck=null,admitEvaluation=null,now=undefined,internal=false,retries=SERIALIZATION_RETRIES}={}){
  if(!validIds(owner,selectionId))return refuse(CODES.NOT_FOUND);
  // This callback is an internal composition seam, never a customer request field. A thrown admission refusal
  // rolls back the entire transaction, including the first exposure. It must not open a nested transaction.
  if(admitEvaluation!==null&&(internal!==true||typeof admitEvaluation!=='function'))return refuse(CODES.INVALID_FIELDS,'ADMISSION');
  // A caller-supplied application clock is accepted only with the internal option (tests and tools); the register at_ms is otherwise always Date.now.
  if(now!==undefined&&(internal!==true||typeof now!=='function'))return refuse(CODES.INVALID_FIELDS,'NOW');
  const clockNow=now===undefined?Date.now:now;
  if(typeof exportId!=='string'||!UUID.test(exportId)||!text(runId)||runId.length>200)return refuse(CODES.INVALID_FIELDS,'IDENTIFIERS');
  const pre=await readSelection(db,{owner_id:owner,selection_id:selectionId});
  if(!pre.ok)return pre;
  const registration=pre.selection.registration,window=registration.window;
  try{
    return await serializable(db,async()=>{
      const carried={};
      const appended=await appendExposures(db,{...marketOf(owner),now:clockNow,events:[{kind:'QR4_SELECTION',window:{start_ms:window.start_ms,end_ms:window.end_ms},selection_id:selectionId}],
        check:async read=>{
          const judged=await judgeStep(db,{owner,selectionId,registration,read,stage:'EVALUATION_START',exportId,participantCheck});
          if(admitEvaluation&&judged.action==='BLOCK'&&judged.refusal.detail==='ALREADY_STARTED'){
            const replay=await admitEvaluation(db,{registration,replayOnly:true});
            if(replay){carried.replay=replay;return {action:'REPLAY'};}
          }
          // The first start proceeds to the append (null); every other result is carried out as the check refusal.
          if(judged.action==='OK'&&judged.first){carried.judged=judged;return null;}
          return judged;
        }});
      let judged;
      if(appended.ok)judged=carried.judged;
      else if(appended.code===EXPOSURE_CODES.CHECK_REFUSED)judged=appended.refusal;
      else return refuse(CODES.INTEGRITY_CHECK_FAILED,'EXPOSURE_EVENT');
      if(judged.action==='REPLAY')return carried.replay;
      if(judged.action==='BLOCK')return judged.refusal;
      if(judged.action==='END')return endWith(db,selectionId,judged.last,judged);
      const admitted=admitEvaluation?await admitEvaluation(db,{registration,participant:judged.participant,frozen:judged.frozen,replayOnly:false}):null;
      if(admitEvaluation&&(!admitted||admitted.evaluation_run_id!==runId))throw Error('Evaluation admission did not bind the requested run');
      let seq=Number(judged.last.seq);
      if(judged.first)await insertEvent(db,selectionId,++seq,{event:'FIRST_EVALUATION_START',status:'SELECTION_EVALUATING'});
      await db.query(`INSERT INTO public.quant_selection_evaluation_starts(selection_id,export_id,evaluation_run_id,parent_run_id,dataset_hash,engine_hash) VALUES($1,$2,$3,$4,$5,$6)`,
        [selectionId,exportId,runId,judged.participant.run_id,judged.frozen,registration.scope.engine]);
      return {ok:true,selection_id:selectionId,export_id:exportId,evaluation_run_id:runId,parent_run_id:judged.participant.run_id,first:judged.first,exposure:judged.first?appended.rows[0]:null};
    },retries);
  }catch(error){
    const ended=await endAfterGuard(db,owner,selectionId,error,retries);
    if(ended!==null)return ended;
    const refusal=stepRefusal(error);if(refusal!==null)return refusal;throw error;
  }
}

/**
 * T-OUT (RO-12): ranks and stores the outcome in one SERIALIZABLE transaction whose first statement is the lock-first register read (readExposuresLocked).
 * The same recheck as a start (stage OUTCOME_WRITE) runs before anything is ranked: a failed one ends the selection and ranks nothing, an unreadable one blocks
 * the write. All participants must have an evaluation start. The evaluations come from the evaluations array or from readEvaluations(tx,{selection,window_dataset_hash}),
 * called inside the transaction (slice S3 reads them from the research rows); rankSelection (the pure ranking module) decides, and its result is stored:
 * a completed ranking writes the outcome row (canonical text of the result without outcome_hash, hashed) and then ALL_EVALUATIONS_DONE to SELECTION_COMPLETED;
 * an incomplete one writes ALL_EVALUATIONS_DONE to SELECTION_INCOMPLETE with the ranking code and the completed evaluation run ids. No register row is written.
 * Returns {ok:true, status, outcome, outcome_hash, ranking} or a refusal or an ended answer.
 */
export async function writeOutcome(db,{owner_id:owner,selection_id:selectionId,evaluations=null,readEvaluations=null,retries=SERIALIZATION_RETRIES}={}){
  if(!validIds(owner,selectionId))return refuse(CODES.NOT_FOUND);
  const pre=await readSelection(db,{owner_id:owner,selection_id:selectionId});
  if(!pre.ok)return pre;
  const registration=pre.selection.registration;
  try{
    return await serializable(db,async()=>{
      const read=await readExposuresLocked(db,marketOf(owner));
      const judged=await judgeStep(db,{owner,selectionId,registration,read,stage:'OUTCOME_WRITE'});
      if(judged.action==='BLOCK')return judged.refusal;
      if(judged.action==='END')return endWith(db,selectionId,judged.last,judged);
      const list=typeof readEvaluations==='function'?await readEvaluations(db,{selection:pre.selection,window_dataset_hash:judged.frozen}):evaluations;
      // A missing or non-array list is not evidence of a failed evaluation: nothing is written (the transaction rolls back), so the selection stays open and the caller may retry.
      if(!Array.isArray(list))throw Object.assign(Error('The evaluation list is unavailable; nothing was written'),{code:EVALUATIONS_UNAVAILABLE,retryable:true});
      const ranked=rankSelection(registration,list,{window_dataset_hash:judged.frozen});
      const seq=Number(judged.last.seq)+1;
      if(ranked.status==='SELECTION_COMPLETED'){
        const {outcome_hash:outcomeHash,...rest}=ranked;
        const body=canonical(rest);
        if(sha(body)!==outcomeHash)return refuse(CODES.INTEGRITY_CHECK_FAILED,'OUTCOME_HASH');
        const decided=transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_COMPLETED',outcome:ranked.outcome});
        if(decided.ok!==true)return decided;
        await db.query('INSERT INTO public.quant_selection_outcomes(selection_id,outcome,outcome_hash,body_canonical) VALUES($1,$2,$3,$4)',[selectionId,ranked.outcome,outcomeHash,body]);
        await insertEvent(db,selectionId,seq,{event:'ALL_EVALUATIONS_DONE',status:'SELECTION_COMPLETED',outcome:ranked.outcome});
        return {ok:true,selection_id:selectionId,status:'SELECTION_COMPLETED',outcome:ranked.outcome,outcome_hash:outcomeHash,ranking:ranked};
      }
      const decided=transitionSelection('SELECTION_EVALUATING',{kind:'ALL_EVALUATIONS_DONE',to:'SELECTION_INCOMPLETE',code:ranked.code});
      if(decided.ok!==true)return decided;
      await insertEvent(db,selectionId,seq,{event:'ALL_EVALUATIONS_DONE',status:'SELECTION_INCOMPLETE',code:ranked.code,detail:ranked.problems?.[0]?.detail??null,completed:ranked.completed_evaluation_ids});
      return {ok:false,ended:true,status:'SELECTION_INCOMPLETE',code:ranked.code,detail:ranked.problems?.[0]?.detail??null,event:'ALL_EVALUATIONS_DONE',ranking:ranked};
    },retries);
  }catch(error){const refusal=stepRefusal(error);if(refusal!==null)return refusal;throw error;}
}

/**
 * Outcome replay (contract 13.2). The stored outcome, the registration and the frozen dataset hash are read in one READ ONLY snapshot, the evaluations come from
 * the evaluations array or from readEvaluations(tx,{selection,window_dataset_hash}) and the ranking is made again by the pure module. An equal outcome_hash
 * returns {ok:true, match:true} and writes nothing. A different one (or a recomputation that is no longer complete) writes one SELECTION_REPLAY_MISMATCH row
 * in a SERIALIZABLE transaction and returns {ok:true, match:false, event}. The stored outcome row is never changed.
 */
export async function replaySelectionOutcome(db,{owner_id:owner,selection_id:selectionId,evaluations=null,readEvaluations=null,retries=SERIALIZATION_RETRIES}={}){
  if(!validIds(owner,selectionId))return refuse(CODES.NOT_FOUND);
  const replayed=await readSnapshot(db,async()=>{
    const read=await readSelection(db,{owner_id:owner,selection_id:selectionId});
    if(!read.ok)return read;
    const stored=read.selection.outcome_row;
    if(!stored)return refuse(CODES.NOT_FOUND,'NO_OUTCOME');
    if(sha(stored.body_canonical)!==stored.outcome_hash)return refuse(CODES.INTEGRITY_CHECK_FAILED,'OUTCOME_HASH');
    const frozen=read.selection.freeze?.dataset_hash??null;
    const list=typeof readEvaluations==='function'?await readEvaluations(db,{selection:read.selection,window_dataset_hash:frozen}):evaluations;
    // Same rule as writeOutcome: a missing or non-array list is not evidence of a different outcome, so no mismatch row is written and the caller may retry.
    if(!Array.isArray(list))throw Object.assign(Error('The evaluation list is unavailable; nothing was written'),{code:EVALUATIONS_UNAVAILABLE,retryable:true});
    return {ok:true,decided:replayRanking(read.selection.registration,list,stored.outcome_hash,{window_dataset_hash:frozen}),stored_outcome_hash:stored.outcome_hash};
  });
  if(replayed.ok!==true)return replayed;
  if(replayed.decided.match===true)return {ok:true,match:true,selection_id:selectionId,stored_outcome_hash:replayed.stored_outcome_hash,recomputed_outcome_hash:replayed.decided.recomputed_outcome_hash};
  const recomputed=replayed.decided.recomputed_outcome_hash;
  try{
    return await serializable(db,async()=>{
      const owned=(await db.query('SELECT 1 FROM public.quant_selection_registrations WHERE selection_id=$1 AND owner_id=$2',[selectionId,owner])).rows[0];
      if(!owned)return refuse(CODES.NOT_FOUND);
      const row=(await db.query(`INSERT INTO public.quant_selection_replay_events(selection_id,kind,stored_outcome_hash,recomputed_outcome_hash) VALUES($1,'SELECTION_REPLAY_MISMATCH',$2,$3) RETURNING replay_event_id,at_ms`,
        [selectionId,replayed.stored_outcome_hash,recomputed])).rows[0];
      return {ok:true,match:false,selection_id:selectionId,replay_event_id:row.replay_event_id,at_ms:num(row.at_ms),stored_outcome_hash:replayed.stored_outcome_hash,recomputed_outcome_hash:recomputed};
    },retries);
  }catch(error){const refusal=stepRefusal(error);if(refusal!==null)return refusal;throw error;}
}

/**
 * QR4-side audit of the exposure order (no trigger sits on the register table): the QR4_SELECTION register rows of the owner whose selection has no
 * registration of the owner or no FIRST_EVALUATION_START status event. Read only; an empty list is the healthy state. Such a row still counts as an exposure for
 * every other reader (it can only make windows less available), and the start of its own selection is blocked with ORPHAN_EXPOSURE.
 */
export async function findOrphanSelectionExposures(db,{owner_id:owner}={}){
  if(!db||typeof db.query!=='function'||!text(owner))return null;
  return (await db.query(`SELECT x.exposure_id,x.selection_id,x.start_ms,x.end_ms FROM public.quant_exposure_register x WHERE x.kind='QR4_SELECTION' AND x.owner_id=$1
    AND NOT EXISTS(SELECT 1 FROM public.quant_selection_status_events e JOIN public.quant_selection_registrations r ON r.selection_id=e.selection_id
      WHERE e.selection_id::text=x.selection_id AND r.owner_id=x.owner_id AND e.event='FIRST_EVALUATION_START') ORDER BY x.at_ms,x.exposure_id`,[owner])).rows
    .map(row=>({exposure_id:row.exposure_id,selection_id:row.selection_id,start_ms:num(row.start_ms),end_ms:num(row.end_ms)}));
}
