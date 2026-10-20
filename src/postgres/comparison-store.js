import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../pine-bridge/source.js';
import {CODES,REQUIRED_MARKET,isObject,isInt,isAligned,MINUTE} from '../comparison/common.js';
import {validateSpec,specHashOf} from '../comparison/ranking.js';
import {windowsOverlap} from '../comparison/evidence.js';
import {appendExposures,EXPOSURE_CODES} from './exposure-register.js';

/**
 * QR-3 S2c-1 comparison store: the create writer and the owner-scoped read of the tables in quant-comparison.sql.
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
export const STORE_CODES=Object.freeze({NOT_FOUND:'NOT_FOUND',ACTUAL_BOT_UNAVAILABLE:'QR3_ACTUAL_BOT_UNAVAILABLE',SCHEMA_ABSENT:'QR3_SCHEMA_ABSENT'});
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
  const requireReadOnly=async()=>{
    const mode=(await db.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode;
    if(mode!=='on')throw Error('Comparison read needs a READ ONLY transaction');
  };
  if(db.isTransaction===true){await requireReadOnly();return readRows(db,owner,comparisonId);}
  return db.transaction(async()=>{
    await db.query('SET TRANSACTION READ ONLY');
    await requireReadOnly();
    return readRows(db,owner,comparisonId);
  },{isolation:'REPEATABLE READ'});
}
