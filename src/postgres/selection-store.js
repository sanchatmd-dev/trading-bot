import {randomUUID,createHash} from 'node:crypto';
import {canonical} from '../pine-bridge/source.js';
import {buildRegistration,registrationHashOf} from '../selection/registration.js';
import {registrationBody} from '../selection/hash.js';
import {CODES,REQUIRED_MARKET,MINUTE,isObject,isInt,text,refuse,byCreation,byText} from '../selection/codes.js';
import {checkCancel} from '../selection/lifecycle.js';
import {readExposures,toComparisonEntries} from './exposure-register.js';

/**
 * QR-4 S2-1 selection store: the registration path of the qualified-selection tables (src/postgres/quant-selection.sql). It holds the only
 * writers of the registration (registerSelection) and of the owner cancel (cancelSelection), the owner-scoped read (readSelection) and the
 * searched-window reader (readSearchedWindows). No route, worker or pure-module change; the exposure recheck, freeze, start, outcome and
 * replay writers are slice S2-2.
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
  quant_selection_universe_member:[CODES.INTEGRITY_CHECK_FAILED,'quant_selection_universe_member']});

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
 * RESEARCH_RUN for every run until slice S3 adds the evaluation-run marker. A run without a readable dataset start or split makes the
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
 * registration (registration_hash included, ready for recheckWindow), the universe, participant and event rows.
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
    return {ok:true,selection:{selection_id:row.selection_id,owner_id:row.owner_id,fixture:row.fixture,status:last.status,code:last.code,outcome:last.outcome,seq:last.seq,
      window_kind:row.window_kind,start_ms:num(row.start_ms),end_ms:num(row.end_ms),registered_at_ms:num(row.registered_at_ms),frozen_at_ms:num(row.frozen_at_ms),
      admission_deadline_ms:num(row.admission_deadline_ms),registration_key:row.registration_key,registration_hash:row.registration_hash,registration,universe,participants,events}};
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
