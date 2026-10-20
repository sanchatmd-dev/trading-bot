import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../pine-bridge/source.js';
import {CODES,REQUIRED_MARKET,isObject,isInt,isAligned,MINUTE} from '../comparison/common.js';
import {validateSpec,specHashOf} from '../comparison/ranking.js';
import {windowsOverlap} from '../comparison/evidence.js';
import {appendExposures,EXPOSURE_CODES} from './exposure-register.js';

/**
 * QR-3 S2c comparison store: the create writer and the owner-scoped read of the tables in quant-comparison.sql (S2c-1), and the writers and the
 * owner-scoped read of the evaluation records, benchmarks, outcomes and replay events (S2c-2, see the section at the end of this file).
 * The pure checks (validateRequest, validateSpec, resolvePeriod, dataset gaps, contexts) and every research read run BEFORE this module, in a
 * separate READ ONLY transaction (contract I7), and no metric is computed or shown here (F8). This module stores what the caller froze.
 *
 * Create (RC-C32, RC-C38, RC-C40, RC-C41). One SERIALIZABLE transaction whose first statement is appendExposures (its LOCK TABLE takes no snapshot;
 * any earlier statement would turn a clean result into a 40001), then the spec, the participants and the SPEC_FROZEN event. The database
 * stamps frozen_at_ms from its own clock and checks at commit that the participants, the single status event and one register event per
 * participant belong to the spec. A 40001 or a failed commit check rolls the register events back too. A 40001 is retried from the first
 * statement, at most MAX_RETRIES times, rerunning every check inside the new transaction; the error is thrown when the retries are used up (the
 * caller answers RETRY_TRANSACTION). Every other database refusal is mapped by guard name (err.constraint of a QR004) or by SQLSTATE.
 * The prior exposure of each participant is recorded from the locked register read of the same transaction (RC-C41): the register rows of the same
 * owner and market whose window overlaps and that belong to another comparison or selection. It is the same list for every participant, because the
 * contract scope is owner plus market plus window. A later exposure only makes a read STALE (S4); nothing is rewritten.
 * Idempotency (D11): an optional request_key is stored as a SHA-256 hash, unique per owner. A repeat returns the existing comparison with
 * existing:true and same_spec telling whether the stored spec body is the one sent now; nothing new is written, so the register is not touched.
 * ACTUAL_BOT has no create path in version 1 (D8).
 *
 * Read. readComparison runs in its own REPEATABLE READ READ ONLY transaction, owner-scoped: an absent id and another owner's id both answer
 * {ok:false, code:'NOT_FOUND'} with the same shape. The stored bodies are re-hashed on read; a mismatch answers QR3_INTEGRITY_FAILED.
 */
export const MAX_RETRIES=3;
export const STORE_CODES=Object.freeze({NOT_FOUND:'NOT_FOUND',ACTUAL_BOT_UNAVAILABLE:'QR3_ACTUAL_BOT_UNAVAILABLE',SCHEMA_ABSENT:'QR3_SCHEMA_ABSENT',NOT_CANCELLABLE:'QR3_NOT_CANCELLABLE'});
const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX64=/^[0-9a-f]{64}$/;
const ORIGINS=Object.freeze(['LIBRARY_RUN','IMPORTED','FIXTURE']);
const MAX_SPEC_BYTES=65536,MAX_FREEZE_BYTES=262144,MAX_REQUEST_KEY=200;
const text=value=>typeof value==='string'&&value.length>0?value:null;
const bytes=value=>Buffer.byteLength(value,'utf8');
const refuse=(code,detail=null)=>({ok:false,code,detail});
// bigint arrives as a number from the product pool parser and as a string from a plain client; a value past 2^53 is refused, never rounded.
const integer=value=>{const parsed=typeof value==='string'&&/^\d{1,16}$/.test(value)?Number(value):value;return Number.isSafeInteger(parsed)?parsed:null;};

class Refusal extends Error {constructor(result){super(result.code);this.result=result;}}

/** The stored form of a request key: SHA-256 of the owner-supplied text. The text itself is never stored. */
export const requestKeyHash=key=>hash(String(key));

/**
 * Pure input checks. Returns {ok:false, code, detail} or {ok:true, value} where value holds everything the transaction writes.
 * input: {owner_id, comparison_id?, parent_comparison_id?, fixture?, market, spec (validateSpec().spec), spec_hash, context_key,
 *   participants:[{participant_id, position?, source_hash, origin, fixture, context_key, freeze:{...}}], request_key?}
 */
function prepare(input){
  const request=isObject(input)?input:{};
  if(!text(request.owner_id))return refuse(CODES.INVALID_FIELDS,'OWNER');
  const comparisonId=request.comparison_id===undefined?randomUUID():request.comparison_id;
  if(typeof comparisonId!=='string'||!ID.test(comparisonId))return refuse(CODES.INVALID_FIELDS,'COMPARISON_ID');
  const parent=request.parent_comparison_id??null;
  if(parent!==null&&(typeof parent!=='string'||!ID.test(parent)||parent===comparisonId))return refuse(CODES.INVALID_FIELDS,'PARENT_COMPARISON');
  const fixture=request.fixture===undefined?false:request.fixture;
  if(typeof fixture!=='boolean')return refuse(CODES.INVALID_FIELDS,'FIXTURE');
  const market=request.market;
  if(!isObject(market)||market.broker!==REQUIRED_MARKET.broker||market.symbol!==REQUIRED_MARKET.symbol)return refuse(CODES.QR3_MARKET_UNSUPPORTED);
  if(market.timeframe!==REQUIRED_MARKET.timeframe)return refuse(CODES.QR3_TIMEFRAME_UNSUPPORTED);
  const list=request.participants;
  if(!Array.isArray(list))return refuse(CODES.INVALID_FIELDS,'PARTICIPANTS');
  if(list.length<2||list.length>4)return refuse(CODES.QR3_PARTICIPANT_COUNT);
  if(list.some(item=>!isObject(item)))return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_SHAPE');
  const seen=new Set();
  for(const item of list){
    if(typeof item.participant_id!=='string'||!ID.test(item.participant_id))return refuse(CODES.INVALID_RUN_ID);
    if(seen.has(item.participant_id))return refuse(CODES.DUPLICATE_RUN_ID);
    seen.add(item.participant_id);
  }
  const spec=request.spec;
  if(!isObject(spec))return refuse(CODES.QR3_SPEC_INCOMPLETE,'SPEC');
  if(spec.mode==='ACTUAL_BOT')return refuse(STORE_CODES.ACTUAL_BOT_UNAVAILABLE);
  if(spec.mode!=='STANDARDIZED')return refuse(CODES.QR3_MODE_REQUIRED);
  // RC-C13: the frozen spec is valid against the registry defaults, equals its normal form, and its hash is the recomputed one.
  const checked=validateSpec(spec);
  if(!checked.ok||canonical(checked.spec)!==canonical(spec))return refuse(CODES.QR3_SPEC_INCOMPLETE,'SPEC');
  if(request.spec_hash!==specHashOf(spec)||typeof request.spec_hash!=='string'||!HEX64.test(request.spec_hash))return refuse(CODES.QR3_SPEC_IMMUTABLE,'SPEC_HASH_MISMATCH');
  const period=spec.period;
  if(!isObject(period)||!isAligned(period.start_ms)||!isAligned(period.end_ms)||period.end_ms<=period.start_ms||period.start_ms<0||period.end_ms>253402300800000)return refuse(CODES.QR3_PERIOD_INVALID);
  if(typeof request.context_key!=='string'||!HEX64.test(request.context_key))return refuse(CODES.INVALID_FIELDS,'CONTEXT_KEY');
  const specText=canonical(spec);
  if(bytes(specText)>MAX_SPEC_BYTES)return refuse(CODES.QR3_SPEC_INCOMPLETE,'SPEC_SIZE');
  const declared=[...spec.participants].sort();
  const given=list.map(item=>item.participant_id).sort();
  if(!Array.isArray(spec.participants)||declared.length!==given.length||declared.some((id,index)=>id!==given[index]))return refuse(CODES.INVALID_FIELDS,'PARTICIPANTS_DIFFER_FROM_SPEC');
  const positions=[];
  const participants=[];
  for(const [index,item] of list.entries()){
    if(typeof item.source_hash!=='string'||!HEX64.test(item.source_hash)||typeof item.context_key!=='string'||!HEX64.test(item.context_key))return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_HASH');
    if(!ORIGINS.includes(item.origin)||typeof item.fixture!=='boolean'||(item.origin==='FIXTURE')!==item.fixture)return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_ORIGIN');
    if(item.fixture&&!fixture)return refuse(CODES.QR3_FIXTURE_PARTICIPANT);
    if(!isObject(item.freeze)||Object.hasOwn(item.freeze,'prior_exposed_by'))return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_FREEZE');
    const position=item.position===undefined?index+1:item.position;
    if(!isInt(position)||position<1||position>list.length)return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_POSITION');
    positions.push(position);
    participants.push({participant_id:item.participant_id,position,source_hash:item.source_hash,origin:item.origin,fixture:item.fixture,context_key:item.context_key,freeze:item.freeze});
  }
  if(new Set(positions).size!==positions.length)return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_POSITION');
  let keyHash=null;
  if(request.request_key!==undefined&&request.request_key!==null){
    if(typeof request.request_key!=='string'||request.request_key.length<1||request.request_key.length>MAX_REQUEST_KEY)return refuse(CODES.INVALID_FIELDS,'REQUEST_KEY');
    keyHash=requestKeyHash(request.request_key);
  }
  for(const item of participants){
    const freezeText=canonical({...item.freeze,participant_id:item.participant_id,source_hash:item.source_hash,origin:item.origin,fixture:item.fixture,context_key:item.context_key,prior_exposed_by:[]});
    if(bytes(freezeText)>MAX_FREEZE_BYTES)return refuse(CODES.INVALID_FIELDS,'FREEZE_SIZE');
  }
  return {ok:true,value:{owner_id:request.owner_id,comparison_id:comparisonId,parent,fixture,spec,spec_hash:request.spec_hash,context_key:request.context_key,spec_text:specText,
    spec_body_hash:hash(specText),window:{start_ms:period.start_ms,end_ms:period.end_ms},participants,request_key_hash:keyHash}};
}

const overlapKey=item=>[item.kind,item.id,item.window.start_ms,item.window.end_ms,item.at_ms].join('|');
/** Register rows of the same owner and market (the read is already scoped to both) that overlap the window and belong to another comparison or selection. */
function priorExposures(rows,comparisonId,window){
  const found=new Map();
  for(const row of rows){
    // Only the register rows of this very comparison are excluded; a selection that happens to carry the same id text stays listed.
    if(row.kind==='QR3_COMPARISON'&&row.comparison_id===comparisonId)continue;
    const id=row.kind==='QR3_COMPARISON'?row.comparison_id:row.selection_id;
    const item={kind:row.kind,id,window:{start_ms:row.start_ms,end_ms:row.end_ms},at_ms:row.at_ms};
    if(windowsOverlap(item.window,window))found.set(overlapKey(item),item);
  }
  return [...found.values()].sort((a,b)=>a.at_ms-b.at_ms||(a.id<b.id?-1:a.id>b.id?1:0)||a.window.start_ms-b.window.start_ms);
}

async function findByRequestKey(db,owner,keyHash){
  const row=(await db.query('SELECT comparison_id,spec_body_hash,frozen_at_ms FROM public.quant_comparison_specs WHERE owner_id=$1 AND request_key_hash=$2',[owner,keyHash])).rows[0];
  return row?{comparison_id:row.comparison_id,spec_body_hash:row.spec_body_hash,frozen_at_ms:integer(row.frozen_at_ms)}:null;
}
const existingResult=(row,value)=>({ok:true,existing:true,comparison_id:row.comparison_id,frozen_at_ms:row.frozen_at_ms,same_spec:row.spec_body_hash===value.spec_body_hash,exposure_at_ms:null,participants:[],attempts:0});

/**
 * The create transaction. Nothing before appendExposures. Returns {ok:true, comparison_id, frozen_at_ms, exposure_at_ms, participants:[{participant_id, position,
 * prior_exposed_by}], existing:false, attempts} or {ok:false, code, detail}.
 */
async function createOnce(db,value,now,stage){
  const owner=value.owner_id,window=value.window;
  const events=value.participants.map(item=>({kind:'QR3_COMPARISON',window:{...window},comparison_id:value.comparison_id,participant_run_id:item.participant_id,source_hash:item.source_hash}));
  let prior=null;
  stage.name='register';
  const exposure=await appendExposures(db,{owner_id:owner,...REQUIRED_MARKET,events,now,check:read=>{prior=priorExposures(read.rows,value.comparison_id,window);return null;}});
  if(!exposure.ok)throw new Refusal(refuse(CODES.INVALID_FIELDS,exposure.code));
  stage.name='insert';
  const spec=(await db.query(`INSERT INTO public.quant_comparison_specs(comparison_id,owner_id,parent_comparison_id,mode,fixture,broker,symbol,timeframe,start_ms,end_ms,participant_count,
      context_key,spec_hash,spec_canonical,spec_body_hash,request_key_hash) VALUES($1,$2,$3,'STANDARDIZED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING frozen_at_ms`,
    [value.comparison_id,owner,value.parent,value.fixture,REQUIRED_MARKET.broker,REQUIRED_MARKET.symbol,REQUIRED_MARKET.timeframe,window.start_ms,window.end_ms,value.participants.length,
      value.context_key,value.spec_hash,value.spec_text,value.spec_body_hash,value.request_key_hash])).rows[0];
  for(const item of value.participants){
    const freezeText=canonical({...item.freeze,participant_id:item.participant_id,source_hash:item.source_hash,origin:item.origin,fixture:item.fixture,context_key:item.context_key,prior_exposed_by:prior});
    await db.query(`INSERT INTO public.quant_comparison_participants(comparison_id,participant_id,"position",source_hash,origin,fixture,context_key,freeze_canonical,freeze_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[value.comparison_id,item.participant_id,item.position,item.source_hash,item.origin,item.fixture,item.context_key,freezeText,hash(freezeText)]);
  }
  await db.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,1,'SPEC_FROZEN')",[value.comparison_id]);
  return {ok:true,existing:false,comparison_id:value.comparison_id,frozen_at_ms:integer(spec.frozen_at_ms),exposure_at_ms:exposure.rows[0].at_ms,
    participants:value.participants.map(item=>({participant_id:item.participant_id,position:item.position,prior_exposed_by:prior}))};
}

/** Maps a database failure to a request refusal, or null when it is not one this module owns (the caller rethrows it). */
function mapFailure(error,stage){
  if(error instanceof Refusal)return error.result;
  if(error?.code===EXPOSURE_CODES.UNAVAILABLE||error?.code===EXPOSURE_CODES.ROW_INVALID)return refuse(CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE,error.code);
  if(error?.code==='42P01')return stage.name==='register'?refuse(CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE,'42P01'):refuse(STORE_CODES.SCHEMA_ABSENT);
  if(error?.code==='QR004'){
    if(error.constraint==='quant_comparison_participant_fixture')return refuse(CODES.QR3_FIXTURE_PARTICIPANT);
    if(error.constraint==='quant_comparison_spec_parent')return refuse(CODES.INVALID_FIELDS,'PARENT_COMPARISON');
    return refuse(CODES.QR3_INTEGRITY_FAILED,error.constraint??'QR004');
  }
  if(error?.code==='23505'&&['quant_exposure_register_qr3_unique','quant_comparison_specs_pkey'].includes(error.constraint))return refuse(CODES.INVALID_FIELDS,'COMPARISON_ID_EXISTS');
  if(error?.code==='23503')return refuse(CODES.INVALID_FIELDS,error.constraint??'FOREIGN_KEY');
  return null;
}

/**
 * Creates one STANDARDIZED comparison (see the module comment for the input). db must not be inside a transaction: this function owns the
 * SERIALIZABLE transaction and its retries.
 */
export async function createComparison(db,input,{now=Date.now}={}){
  if(!db||typeof db.transaction!=='function'||typeof db.query!=='function'||db.isTransaction===true)throw Error('createComparison requires its own transaction');
  const prepared=prepare(input);
  if(!prepared.ok)return prepared;
  const value=prepared.value;
  for(let attempt=1;;attempt+=1){
    if(value.request_key_hash!==null){
      const found=await findByRequestKey(db,value.owner_id,value.request_key_hash);
      if(found)return existingResult(found,value);
    }
    const stage={name:'register'};
    try{
      const result=await db.transaction(()=>createOnce(db,value,now,stage),{isolation:'SERIALIZABLE'});
      return {...result,attempts:attempt};
    }catch(error){
      if(error?.code==='40001'&&attempt<=MAX_RETRIES)continue;
      // A concurrent create with the same request key won: answer with the committed comparison. Any unique violation counts, because the register
      // insert of the loser can meet the winner's rows (same comparison id) before the spec insert meets the request key.
      if(error?.code==='23505'&&value.request_key_hash!==null){
        const found=await findByRequestKey(db,value.owner_id,value.request_key_hash);
        if(found)return existingResult(found,value);
      }
      const mapped=mapFailure(error,stage);
      if(mapped!==null)return mapped;
      throw error;
    }
  }
}

const parse=value=>{try{return JSON.parse(value);}catch{return null;}};

async function readRows(db,owner,comparisonId){
  const spec=(await db.query(`SELECT comparison_id,owner_id,parent_comparison_id,mode,fixture,broker,symbol,timeframe,start_ms,end_ms,participant_count,context_key,spec_hash,spec_canonical,
      spec_body_hash,request_key_hash IS NOT NULL AS has_request_key,frozen_at_ms FROM public.quant_comparison_specs WHERE comparison_id=$1 AND owner_id=$2`,[comparisonId,owner])).rows[0];
  if(!spec)return refuse(STORE_CODES.NOT_FOUND);
  const participants=(await db.query(`SELECT participant_id,"position",source_hash,origin,fixture,context_key,freeze_canonical,freeze_hash FROM public.quant_comparison_participants
      WHERE comparison_id=$1 ORDER BY "position"`,[comparisonId])).rows;
  const events=(await db.query('SELECT seq,status,reason_code,at_ms FROM public.quant_comparison_status_events WHERE comparison_id=$1 ORDER BY seq',[comparisonId])).rows;
  const broken=detail=>refuse(CODES.QR3_INTEGRITY_FAILED,detail);
  const specBody=parse(spec.spec_canonical);
  if(hash(spec.spec_canonical)!==spec.spec_body_hash||!isObject(specBody)||canonical(specBody)!==spec.spec_canonical)return broken('SPEC_BODY');
  if(specHashOf(specBody)!==spec.spec_hash)return broken('SPEC_HASH');
  const start=integer(spec.start_ms),end=integer(spec.end_ms),frozen=integer(spec.frozen_at_ms);
  if(start===null||end===null||frozen===null||start%MINUTE!==0||end%MINUTE!==0)return broken('SPEC_WINDOW');
  if(participants.length!==spec.participant_count||!Array.isArray(specBody.participants)||[...specBody.participants].sort().join('\n')!==participants.map(row=>row.participant_id).sort().join('\n'))return broken('PARTICIPANTS');
  const views=[];
  for(const row of participants){
    const freeze=parse(row.freeze_canonical);
    if(hash(row.freeze_canonical)!==row.freeze_hash||!isObject(freeze)||canonical(freeze)!==row.freeze_canonical)return broken('PARTICIPANT_FREEZE');
    views.push({participant_id:row.participant_id,position:Number(row.position),source_hash:row.source_hash,origin:row.origin,fixture:row.fixture,context_key:row.context_key,
      freeze,freeze_hash:row.freeze_hash});
  }
  if(!events.length||events[0].status!=='SPEC_FROZEN'||events.some((row,index)=>Number(row.seq)!==index+1))return broken('STATUS_EVENTS');
  const timeline=events.map(row=>({seq:Number(row.seq),status:row.status,reason_code:row.reason_code,at_ms:integer(row.at_ms)}));
  return {ok:true,code:null,detail:null,
    comparison:{comparison_id:spec.comparison_id,owner_id:spec.owner_id,parent_comparison_id:spec.parent_comparison_id,mode:spec.mode,fixture:spec.fixture,
      market:{broker:spec.broker,symbol:spec.symbol,timeframe:spec.timeframe},window:{start_ms:start,end_ms:end},participant_count:Number(spec.participant_count),
      context_key:spec.context_key,spec_hash:spec.spec_hash,spec:specBody,spec_body_hash:spec.spec_body_hash,has_request_key:spec.has_request_key,frozen_at_ms:frozen},
    participants:views,status:timeline[timeline.length-1],events:timeline};
}

/**
 * Owner-scoped read of one comparison: {ok:true, comparison, participants, status, events} or {ok:false, code}. NOT_FOUND answers an absent id, another
 * owner's id and a malformed id alike. Runs in its own REPEATABLE READ READ ONLY transaction (it fails closed if the server does not report the
 * transaction read-only); inside a caller transaction it throws unless the caller transaction is already READ ONLY (transaction_read_only on), then
 * only runs SELECT statements. It never writes, starts no job and computes no metric.
 */
export async function readComparison(db,{owner_id:owner,comparison_id:comparisonId}={}){
  if(!db||typeof db.query!=='function')throw Error('readComparison requires a database handle');
  if(!text(owner)||typeof comparisonId!=='string'||!ID.test(comparisonId))return refuse(STORE_CODES.NOT_FOUND);
  return inReadOnly(db,()=>readRows(db,owner,comparisonId));
}

/** Runs read() in the caller's READ ONLY transaction, or in its own REPEATABLE READ READ ONLY one; it fails closed if the server does not report read-only. */
async function inReadOnly(db,read){
  const requireReadOnly=async()=>{
    const mode=(await db.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode;
    if(mode!=='on')throw Error('Comparison read needs a READ ONLY transaction');
  };
  if(db.isTransaction===true){await requireReadOnly();return read();}
  return db.transaction(async()=>{
    await db.query('SET TRANSACTION READ ONLY');
    await requireReadOnly();
    return read();
  },{isolation:'REPEATABLE READ'});
}

/* ---- S2c-2: evaluation records, benchmarks, outcomes and replay events ---- */

export const MAX_EVALUATION_BYTES=4194304,MAX_BENCHMARK_BYTES=262144,MAX_OUTCOME_BYTES=262144;
export const BENCHMARK_ID='qr3-bh-close-same-cost-v1';
export const REPLAY_KINDS=Object.freeze(['REPLAY_MATCH','REPLAY_MISMATCH','REPRODUCTION_DISABLED']);
const CODE=/^[A-Z][A-Z0-9_]{1,63}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Outcome participant statuses that need no stored evaluation record (contract 8.2); every other status does, and its created_at_ms is the stored time. */
const UNEVALUATED_STATUSES=Object.freeze(['NOT_EVALUATED','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','EXCLUDED_INCOMPATIBLE']);
const OUTCOME_FIELDS=Object.freeze(['version','mode','spec_hash','context_key','outcome','participants','uncertainty','only_qualified_participant_id','limitations']);

/**
 * Result writers. Each runs in its own SERIALIZABLE transaction and retries a 40001 (and a status-key collision, which only a concurrent
 * status event causes) at most MAX_RETRIES times, rerunning every check. The first statement of a write is an owner-scoped read of the spec: an
 * absent id and another owner's id both answer {ok:false, code:'NOT_FOUND'}. The database guards do the rest and are mapped by guard name:
 * a freeze-order refusal (F3: the record names another spec or comparison, or its time is not strictly later than the freeze) is
 * QR3_RESULT_PREDATES_SPEC, a spec-hash refusal on an outcome is QR3_SPEC_IMMUTABLE, a status refusal (the comparison is not in the status the write needs,
 * for example it lost to a cancel or to COMPLETE) is QR3_NOT_CANCELLABLE (RC-C38), every other guard or CHECK refusal is QR3_INTEGRITY_FAILED
 * with the guard name as detail, and a second record for the same key is INVALID_FIELDS with detail ALREADY_RECORDED. Times come from the database
 * clock (created_at_ms, at_ms); the caller never supplies one. No writer computes a metric or reruns a job.
 */
async function resultTransaction(db,work){
  if(!db||typeof db.transaction!=='function'||typeof db.query!=='function'||db.isTransaction===true)throw Error('Result writers require their own transaction');
  for(let attempt=1;;attempt+=1){
    try{
      const result=await db.transaction(()=>work(),{isolation:'SERIALIZABLE'});
      return {...result,attempts:attempt};
    }catch(error){
      if((error?.code==='40001'||(error?.code==='23505'&&error.constraint==='quant_comparison_status_events_pkey'))&&attempt<=MAX_RETRIES)continue;
      const mapped=mapResultFailure(error);
      if(mapped!==null)return mapped;
      throw error;
    }
  }
}

const STATUS_GUARDS=Object.freeze(['quant_comparison_eval_status','quant_comparison_benchmark_status','quant_comparison_outcome_status','quant_comparison_status_transition']);
const FREEZE_ORDER_GUARDS=Object.freeze(['quant_comparison_eval_freeze_order','quant_comparison_benchmark_freeze_order','quant_comparison_outcome_freeze_order']);
/** Maps a database failure of a result write to a refusal, or null when it is not one this module owns (the caller rethrows it). */
function mapResultFailure(error){
  if(error instanceof Refusal)return error.result;
  if(error?.code==='42P01')return refuse(STORE_CODES.SCHEMA_ABSENT);
  if(error?.code==='QR004'){
    if(FREEZE_ORDER_GUARDS.includes(error.constraint))return refuse(CODES.QR3_RESULT_PREDATES_SPEC,error.constraint);
    if(error.constraint==='quant_comparison_outcome_spec_hash')return refuse(CODES.QR3_SPEC_IMMUTABLE,error.constraint);
    if(STATUS_GUARDS.includes(error.constraint))return refuse(STORE_CODES.NOT_CANCELLABLE,error.constraint);
    return refuse(CODES.QR3_INTEGRITY_FAILED,error.constraint??'QR004');
  }
  if(error?.code==='23514')return refuse(CODES.QR3_INTEGRITY_FAILED,error.constraint??'CHECK');
  if(error?.code==='22P02')return refuse(CODES.QR3_INTEGRITY_FAILED,'BODY_JSON');
  if(error?.code==='23505')return refuse(CODES.INVALID_FIELDS,'ALREADY_RECORDED');
  if(error?.code==='23503')return refuse(CODES.INVALID_FIELDS,error.constraint??'FOREIGN_KEY');
  return null;
}

async function ownedSpec(db,owner,comparisonId){
  const row=(await db.query('SELECT spec_hash,context_key FROM public.quant_comparison_specs WHERE comparison_id=$1 AND owner_id=$2',[comparisonId,owner])).rows[0];
  if(!row)throw new Refusal(refuse(STORE_CODES.NOT_FOUND));
  return row;
}
const idOk=value=>typeof value==='string'&&ID.test(value);
const hexOk=value=>typeof value==='string'&&HEX64.test(value);
/** Common pure checks of a result write: owner and comparison id. A malformed id answers NOT_FOUND like an absent one. */
const target=input=>isObject(input)&&text(input.owner_id)&&idOk(input.comparison_id)?null:refuse(STORE_CODES.NOT_FOUND);
const bodyText=(body,limit)=>{
  if(!isObject(body))return refuse(CODES.INVALID_FIELDS,'BODY');
  const serialized=canonical(body);
  return bytes(serialized)>limit?refuse(CODES.INVALID_FIELDS,'BODY_SIZE'):{ok:true,text:serialized};
};

/**
 * Stores one participant's evaluation record (F3). input: {owner_id, comparison_id, participant_id, spec_hash (the frozen hash the evaluation ran
 * under), evaluation_run_id? (S3 lineage), body (object with record_comparison_id, record_spec_hash and window {start_ms,end_ms})}.
 * Returns {ok:true, comparison_id, participant_id, created_at_ms, body_hash, attempts} or {ok:false, code, detail}.
 */
export async function writeEvaluation(db,input){
  const bad=target(input);if(bad)return bad;
  if(!idOk(input.participant_id))return refuse(CODES.INVALID_RUN_ID);
  if(!hexOk(input.spec_hash))return refuse(CODES.INVALID_FIELDS,'SPEC_HASH');
  if(input.evaluation_run_id!==undefined&&input.evaluation_run_id!==null&&!idOk(input.evaluation_run_id))return refuse(CODES.INVALID_FIELDS,'EVALUATION_RUN_ID');
  const body=bodyText(input.body,MAX_EVALUATION_BYTES);if(!body.ok)return body;
  const digest=hash(body.text),runId=input.evaluation_run_id??null;
  return resultTransaction(db,async()=>{
    await ownedSpec(db,input.owner_id,input.comparison_id);
    const row=(await db.query(`INSERT INTO public.quant_comparison_evaluations(comparison_id,participant_id,spec_hash,evaluation_run_id,body_canonical,body_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at_ms`,
      [input.comparison_id,input.participant_id,input.spec_hash,runId,body.text,digest])).rows[0];
    return {ok:true,comparison_id:input.comparison_id,participant_id:input.participant_id,created_at_ms:integer(row.created_at_ms),body_hash:digest};
  });
}

/**
 * Stores the benchmark row of a comparison (once). input: {owner_id, comparison_id, spec_hash, body (object whose benchmark_id is the spec benchmark;
 * a null line with its reason code is allowed, B6/RC-C20)}.
 */
export async function writeBenchmark(db,input){
  const bad=target(input);if(bad)return bad;
  if(!hexOk(input.spec_hash))return refuse(CODES.INVALID_FIELDS,'SPEC_HASH');
  const body=bodyText(input.body,MAX_BENCHMARK_BYTES);if(!body.ok)return body;
  if(input.body.benchmark_id!==BENCHMARK_ID)return refuse(CODES.INVALID_FIELDS,'BENCHMARK_ID');
  const digest=hash(body.text);
  return resultTransaction(db,async()=>{
    await ownedSpec(db,input.owner_id,input.comparison_id);
    const row=(await db.query(`INSERT INTO public.quant_comparison_benchmarks(comparison_id,benchmark_id,spec_hash,body_canonical,body_hash) VALUES($1,$2,$3,$4,$5) RETURNING created_at_ms`,
      [input.comparison_id,BENCHMARK_ID,input.spec_hash,body.text,digest])).rows[0];
    return {ok:true,comparison_id:input.comparison_id,created_at_ms:integer(row.created_at_ms),body_hash:digest};
  });
}

/**
 * Stores the outcome and the COMPLETE status event in ONE transaction (the database refuses either without the other). input: {owner_id, comparison_id,
 * outcome: the decideOutcome() result (its record fields are kept, ok/code/detail dropped; a given outcome_hash must equal the hash of the stored body)}.
 * Returns {ok:true, comparison_id, outcome, outcome_hash, created_at_ms, complete_seq, complete_at_ms, attempts} or {ok:false, code, detail}.
 */
export async function writeOutcome(db,input){
  const bad=target(input);if(bad)return bad;
  const decided=input.outcome;
  if(!isObject(decided)||decided.ok!==true)return refuse(CODES.INVALID_FIELDS,'OUTCOME');
  const record={};
  for(const field of OUTCOME_FIELDS)record[field]=decided[field]===undefined?null:decided[field];
  const serialized=bodyText(record,MAX_OUTCOME_BYTES);if(!serialized.ok)return serialized;
  const digest=hash(serialized.text);
  if(decided.outcome_hash!==undefined&&decided.outcome_hash!==digest)return refuse(CODES.QR3_INTEGRITY_FAILED,'OUTCOME_HASH');
  if(typeof record.outcome!=='string'||!hexOk(record.spec_hash)||!hexOk(record.context_key))return refuse(CODES.INVALID_FIELDS,'OUTCOME');
  const only=record.only_qualified_participant_id;
  if(only!==null&&!idOk(only))return refuse(CODES.INVALID_FIELDS,'ONLY_QUALIFIED_PARTICIPANT');
  return resultTransaction(db,async()=>{
    await ownedSpec(db,input.owner_id,input.comparison_id);
    const row=(await db.query(`INSERT INTO public.quant_comparison_outcomes(comparison_id,outcome,spec_hash,context_key,body_canonical,outcome_hash,only_qualified_participant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING created_at_ms`,[input.comparison_id,record.outcome,record.spec_hash,record.context_key,serialized.text,digest,only])).rows[0];
    const last=(await db.query('SELECT max(seq) AS seq FROM public.quant_comparison_status_events WHERE comparison_id=$1',[input.comparison_id])).rows[0];
    const seq=Number(last.seq)+1;
    const complete=(await db.query("INSERT INTO public.quant_comparison_status_events(comparison_id,seq,status) VALUES($1,$2,'COMPLETE') RETURNING at_ms",[input.comparison_id,seq])).rows[0];
    return {ok:true,comparison_id:input.comparison_id,outcome:record.outcome,outcome_hash:digest,created_at_ms:integer(row.created_at_ms),complete_seq:seq,complete_at_ms:integer(complete.at_ms)};
  });
}

/**
 * Appends one replay event (I4, I5); the outcome row never changes. input: {owner_id, comparison_id, kind, prior_outcome_hash (the stored outcome hash),
 * replay_outcome_hash? (null for REPRODUCTION_DISABLED), first_differing_code? (required for REPLAY_MISMATCH, absent otherwise), replay_run_id?, replay_event_id?}.
 */
export async function writeReplayEvent(db,input){
  const bad=target(input);if(bad)return bad;
  if(!REPLAY_KINDS.includes(input.kind))return refuse(CODES.INVALID_FIELDS,'KIND');
  if(!hexOk(input.prior_outcome_hash))return refuse(CODES.INVALID_FIELDS,'PRIOR_OUTCOME_HASH');
  const replayHash=input.replay_outcome_hash??null,code=input.first_differing_code??null,runId=input.replay_run_id??null,eventId=input.replay_event_id??null;
  if(replayHash!==null&&!hexOk(replayHash))return refuse(CODES.INVALID_FIELDS,'REPLAY_OUTCOME_HASH');
  if(code!==null&&(typeof code!=='string'||!CODE.test(code)))return refuse(CODES.INVALID_FIELDS,'FIRST_DIFFERING_CODE');
  if(runId!==null&&!idOk(runId))return refuse(CODES.INVALID_FIELDS,'REPLAY_RUN_ID');
  if(eventId!==null&&(typeof eventId!=='string'||!UUID.test(eventId)))return refuse(CODES.INVALID_FIELDS,'REPLAY_EVENT_ID');
  const shaped=input.kind==='REPLAY_MATCH'?replayHash===input.prior_outcome_hash&&code===null
    :input.kind==='REPLAY_MISMATCH'?replayHash!==null&&replayHash!==input.prior_outcome_hash&&code!==null
    :replayHash===null&&code===null;
  if(!shaped)return refuse(CODES.INVALID_FIELDS,'REPLAY_SHAPE');
  return resultTransaction(db,async()=>{
    await ownedSpec(db,input.owner_id,input.comparison_id);
    const row=(await db.query(`INSERT INTO public.quant_comparison_replay_events(replay_event_id,comparison_id,kind,replay_run_id,prior_outcome_hash,replay_outcome_hash,first_differing_code)
      VALUES(COALESCE($1::uuid,pg_catalog.gen_random_uuid()),$2,$3,$4,$5,$6,$7) RETURNING replay_event_id,at_ms`,[eventId,input.comparison_id,input.kind,runId,input.prior_outcome_hash,replayHash,code])).rows[0];
    return {ok:true,comparison_id:input.comparison_id,replay_event_id:row.replay_event_id,kind:input.kind,at_ms:integer(row.at_ms)};
  });
}

/** Re-hashes a stored canonical body and returns the parsed value, or null when the text, its hash or its canonical form is wrong. */
function checkedBody(bodyCanonical,expectedHash){
  if(typeof bodyCanonical!=='string'||hash(bodyCanonical)!==expectedHash)return null;
  const parsed=parse(bodyCanonical);
  return isObject(parsed)&&canonical(parsed)===bodyCanonical?parsed:null;
}

async function readResultRows(db,owner,comparisonId){
  const spec=(await db.query('SELECT spec_hash,context_key,start_ms,end_ms,frozen_at_ms FROM public.quant_comparison_specs WHERE comparison_id=$1 AND owner_id=$2',[comparisonId,owner])).rows[0];
  if(!spec)return refuse(STORE_CODES.NOT_FOUND);
  const participantIds=new Set((await db.query('SELECT participant_id FROM public.quant_comparison_participants WHERE comparison_id=$1',[comparisonId])).rows.map(row=>row.participant_id));
  const windowStart=integer(spec.start_ms),windowEnd=integer(spec.end_ms);
  const evaluations=(await db.query(`SELECT participant_id,spec_hash,evaluation_run_id,body_canonical,body_hash,created_at_ms FROM public.quant_comparison_evaluations
      WHERE comparison_id=$1 ORDER BY participant_id COLLATE "C"`,[comparisonId])).rows;
  const benchmark=(await db.query('SELECT benchmark_id,spec_hash,body_canonical,body_hash,created_at_ms FROM public.quant_comparison_benchmarks WHERE comparison_id=$1',[comparisonId])).rows[0];
  const outcome=(await db.query(`SELECT outcome,spec_hash,context_key,body_canonical,outcome_hash,only_qualified_participant_id,created_at_ms FROM public.quant_comparison_outcomes
      WHERE comparison_id=$1`,[comparisonId])).rows[0];
  const replays=(await db.query(`SELECT replay_event_id,kind,replay_run_id,prior_outcome_hash,replay_outcome_hash,first_differing_code,at_ms FROM public.quant_comparison_replay_events
      WHERE comparison_id=$1 ORDER BY at_ms,replay_event_id`,[comparisonId])).rows;
  const broken=detail=>refuse(CODES.QR3_INTEGRITY_FAILED,detail);
  const views=[];
  for(const row of evaluations){
    const body=checkedBody(row.body_canonical,row.body_hash);
    if(body===null||integer(row.created_at_ms)===null)return broken('EVALUATION_BODY');
    // cross-check against the spec: a row of another spec, comparison, participant or window is a damaged row
    if(row.spec_hash!==spec.spec_hash||body.record_comparison_id!==comparisonId||body.record_spec_hash!==spec.spec_hash||!participantIds.has(row.participant_id))return broken('EVALUATION_SPEC');
    if(!isObject(body.window)||body.window.start_ms!==windowStart||body.window.end_ms!==windowEnd)return broken('EVALUATION_WINDOW');
    views.push({participant_id:row.participant_id,spec_hash:row.spec_hash,evaluation_run_id:row.evaluation_run_id,record_comparison_id:body.record_comparison_id??null,
      record_spec_hash:body.record_spec_hash??null,created_at_ms:integer(row.created_at_ms),body,body_hash:row.body_hash});
  }
  let benchmarkView=null;
  if(benchmark){
    const body=checkedBody(benchmark.body_canonical,benchmark.body_hash);
    if(body===null||integer(benchmark.created_at_ms)===null)return broken('BENCHMARK_BODY');
    if(benchmark.spec_hash!==spec.spec_hash)return broken('BENCHMARK_SPEC');
    benchmarkView={benchmark_id:benchmark.benchmark_id,spec_hash:benchmark.spec_hash,created_at_ms:integer(benchmark.created_at_ms),body,body_hash:benchmark.body_hash};
  }
  let outcomeView=null;
  if(outcome){
    const body=checkedBody(outcome.body_canonical,outcome.outcome_hash);
    if(body===null||integer(outcome.created_at_ms)===null)return broken('OUTCOME_BODY');
    if(outcome.spec_hash!==spec.spec_hash||outcome.context_key!==spec.context_key)return broken('OUTCOME_SPEC');
    const listed=Array.isArray(body.participants)?body.participants:null;
    if(listed===null||listed.some(item=>!isObject(item)||typeof item.id!=='string')||new Set(listed.map(item=>item.id)).size!==listed.length||listed.length!==participantIds.size
      ||listed.some(item=>!participantIds.has(item.id)))return broken('OUTCOME_PARTICIPANTS');
    const storedTimes=new Map(views.map(view=>[view.participant_id,view.created_at_ms]));
    /* NOT_EVALUATED: no stored row. UNAVAILABLE: a row is optional, and when present the time must match. Excluded statuses are not checked. */
    const timeMismatch=item=>item.created_at_ms!==storedTimes.get(item.id);
    if(listed.some(item=>item.status==='NOT_EVALUATED'?storedTimes.has(item.id)
      :item.status==='UNAVAILABLE'?storedTimes.has(item.id)&&timeMismatch(item)
      :!UNEVALUATED_STATUSES.includes(item.status)&&(!storedTimes.has(item.id)||timeMismatch(item))))return broken('OUTCOME_EVALUATIONS');
    outcomeView={outcome:outcome.outcome,spec_hash:outcome.spec_hash,context_key:outcome.context_key,only_qualified_participant_id:outcome.only_qualified_participant_id,
      created_at_ms:integer(outcome.created_at_ms),record:body,outcome_hash:outcome.outcome_hash};
  }
  const replayViews=replays.map(row=>({replay_event_id:row.replay_event_id,kind:row.kind,replay_run_id:row.replay_run_id,prior_outcome_hash:row.prior_outcome_hash,
    replay_outcome_hash:row.replay_outcome_hash,first_differing_code:row.first_differing_code,at_ms:integer(row.at_ms)}));
  if(replayViews.some(item=>item.at_ms===null||outcomeView===null||item.prior_outcome_hash!==outcomeView.outcome_hash||item.at_ms<=outcomeView.created_at_ms))return broken('REPLAY_EVENTS');
  return {ok:true,code:null,detail:null,comparison_id:comparisonId,spec_hash:spec.spec_hash,frozen_at_ms:integer(spec.frozen_at_ms),evaluations:views,benchmark:benchmarkView,
    outcome:outcomeView,replay_events:replayViews};
}

/**
 * Owner-scoped read of the result rows of one comparison, in the same READ ONLY manner as readComparison: {ok:true, comparison_id, spec_hash, frozen_at_ms,
 * evaluations, benchmark|null, outcome|null, replay_events} or {ok:false, code}. Absent, foreign and malformed ids answer NOT_FOUND alike. Every stored body
 * is re-hashed and re-canonicalised; a mismatch answers QR3_INTEGRITY_FAILED. Every row is also cross-checked against the spec (spec hash, comparison id, window, participant set, context key, and the stored evaluation
 * times an outcome reports); a row of another spec or window, a stranger participant or a time that differs answers QR3_INTEGRITY_FAILED with the check as detail. The F3 classification itself (created_at_ms against frozen_at_ms) is the
 * pure module's job (classifyEvidence); the row views carry exactly its inputs. Nothing here writes, reruns a job or computes a metric.
 */
export async function readComparisonResults(db,{owner_id:owner,comparison_id:comparisonId}={}){
  if(!db||typeof db.query!=='function')throw Error('readComparisonResults requires a database handle');
  if(!text(owner)||typeof comparisonId!=='string'||!ID.test(comparisonId))return refuse(STORE_CODES.NOT_FOUND);
  return inReadOnly(db,()=>readResultRows(db,owner,comparisonId));
}
