import {canonical,hash,MINUTE,QR3_VERSIONS,CODES,MODES,ADMITTED_COST_MODELS,REQUIRED_MARKET,NUMBER_DETAIL,isObject,isInt,isAligned,isNumber,text,decString,norm,deepFreeze,refuse} from './common.js';

/**
 * Context versus subject split (contract section 3), request validation (section 9.1 request refusals that need no database)
 * and mismatch reporting (3.4). Context is what must be identical for a fair comparison and is hashed into one key; subject
 * is what the comparison compares and is only disclosed. An unreadable field is `MISSING:<participant_id>` and never matches.
 */

/** C1 to C16 in contract order. */
export const CONTEXT_FIELDS=Object.freeze(['mode','scope','market','data_model','period','dataset','engine','execution','cost_model','capital',
  'risk_policy','ledger_initialization','valuation','benchmark','spec_hash','validation_protocol']);
/** Subject fields (3.2): may differ and are always disclosed; they never enter the context key. */
export const SUBJECT_FIELDS=Object.freeze(['source_hash','source_version','source_contract_version','fixed_strategy','parameters','bridge_atr_rr',
  'dimension_set','warmup_bars','originating_run','lineage','acceptance_blockers','library_class','qualification','integrity_warnings','bot_id',
  'deployment_id','bot_policy_hash']);

const str=text;
/** V7 (RC-C10): money and thresholds are decimal strings; a JS number is unreadable (MISSING:<id>), never read. */
const decimalText=value=>decString(value)===null?null:norm(value);
const positive=value=>{const d=decString(value);return d&&d.gt(0)?norm(value):null;};
const nonNegative=value=>{const d=decString(value);return d&&d.gte(0)?norm(value):null;};
const MONEY_PATHS=Object.freeze([['data_model','price_tick'],['data_model','quantity_step'],['cost_model','fee_bps'],['cost_model','slippage_bps'],['capital','initial_cash'],['capital','initial_inventory']]);
const numberInMoney=declared=>isObject(declared)&&MONEY_PATHS.some(([group,name])=>isObject(declared[group])&&isNumber(declared[group][name]));
const natural=value=>isInt(value)&&value>=0?value:null;
/**
 * An object whose listed names are all present and pass their reader; otherwise null (the whole field is then unreadable).
 * An unlisted sub-key also makes the field unreadable (MISSING:<id>) until decision RD-3 settles whether extra sub-fields may exist.
 */
function shape(readers){
  return value=>{
    if(!isObject(value))return null;
    if(Object.keys(value).some(key=>!Object.hasOwn(readers,key)))return null;
    const result={};
    for(const [name,read] of Object.entries(readers)){const item=read(value[name]);if(item===null||item===undefined)return null;result[name]=item;}
    return result;
  };
}
const periodShape=value=>{
  const out=shape({start_ms:v=>isAligned(v)?v:null,end_ms:v=>isAligned(v)?v:null,evaluation_bars:natural})(value);
  return out&&out.end_ms>out.start_ms&&out.evaluation_bars===(out.end_ms-out.start_ms)/MINUTE?out:null;
};
const READERS=Object.freeze({
  mode:value=>value==='STANDARDIZED'?value:null,
  scope:str,
  market:shape({broker:str,symbol:str,timeframe:str}),
  data_model:shape({data_profile:str,price_tick:positive,quantity_step:positive}),
  period:periodShape,
  dataset:shape({digest_kind:str,digest:str,first_bar:v=>isAligned(v)?v:null,last_bar:v=>isAligned(v)?v:null,
    bar_count:v=>isInt(v)&&v>0?v:null,timestamp_semantics:str}),
  engine:str,
  execution:shape({fill_model:str,exit_semantics_version:str}),
  cost_model:shape({version:str,fee_bps:nonNegative,slippage_bps:nonNegative}),
  capital:shape({initial_cash:positive,initial_inventory:decimalText,quote:str}),
  risk_policy:str,
  ledger_initialization:str,
  valuation:shape({price_series:str,grid_id:str,currency:str,fx:str,end_treatment:str}),
  benchmark:str,
  spec_hash:str,
  validation_protocol:str});

/** Context fields of one participant. Missing or unreadable input becomes `MISSING:<participant_id>` and is listed in `missing`. */
export function contextFields(participantId,raw){
  const source=isObject(raw)?raw:{};
  const fields={},missing=[];
  for(const name of CONTEXT_FIELDS){
    let value=null;
    try{value=READERS[name](source[name]);}catch{value=null;}
    if(value===null||value===undefined){fields[name]='MISSING:'+participantId;missing.push(name);}else fields[name]=value;
  }
  return deepFreeze({fields,missing});
}
/**
 * Declared (frozen spec) context read through the same readers as a participant's, so a raw '10.0' and a normalised '10' are one value.
 * A name that is absent, unreadable or already MISSING: becomes MISSING:DECLARED and is listed in missing.
 */
export function normaliseDeclared(declared){
  const source=isObject(declared)?declared:{};
  const fields={},missing=[];
  for(const name of CONTEXT_FIELDS){
    const raw=source[name];
    let value=null;
    if(!(typeof raw==='string'&&raw.startsWith('MISSING:'))){try{value=READERS[name](raw);}catch{value=null;}}
    if(value===null||value===undefined){fields[name]='MISSING:DECLARED';missing.push(name);}else fields[name]=value;
  }
  return deepFreeze({fields,missing});
}
/** Key = hash(canonical({version, ...C1..C16})), the same hashing as DERIVE compatibilityKey. */
export const contextKey=fields=>hash(canonical({version:QR3_VERSIONS.context_std,...fields}));
const shortValue=value=>(typeof value==='string'?value:canonical(value)).slice(0,300);

/** Subject of one participant: the listed names that are present. A missing subject name is disclosed as null, never invented. */
export function subjectOf(raw){
  const source=isObject(raw)?raw:{};
  const subject={};
  for(const name of SUBJECT_FIELDS)subject[name]=source[name]===undefined?null:source[name];
  return deepFreeze(subject);
}
/** Split one participant: context fields with key, and disclosed subject. */
export function splitParticipant(participantId,context,subject){
  const {fields,missing}=contextFields(participantId,context);
  return deepFreeze({participant_id:participantId,fields,missing,context_key:contextKey(fields),subject:subjectOf(subject)});
}
/** Pairwise mismatches against the first entry (3.4, DERIVE style): per differing context field, each participant's short value. */
export function contextMismatches(entries){
  const mismatches=[];
  if(!Array.isArray(entries)||entries.length===0)return mismatches;
  for(const field of CONTEXT_FIELDS){
    const first=canonical(entries[0].fields[field]);
    if(entries.some(entry=>canonical(entry.fields[field])!==first))mismatches.push({field,values:entries.map(entry=>({participant_id:entry.participant_id,value:shortValue(entry.fields[field])}))});
  }
  return deepFreeze(mismatches);
}
/** One participant against the declared comparison context (the frozen spec context). A participant that differs is excluded. */
export function compareToDeclared(declared,entry){
  const {fields,missing}=normaliseDeclared(declared);
  if(missing.length>0)return deepFreeze({compatible:false,code:CODES.QR3_SPEC_INCOMPLETE,detail:numberInMoney(declared)?NUMBER_DETAIL:null,mismatches:[],declared_missing:missing});
  const mismatches=contextMismatches([{participant_id:'DECLARED',fields},entry]);
  return deepFreeze({compatible:mismatches.length===0,code:mismatches.length===0?null:CODES.QR3_CONTEXT_MISMATCH,detail:null,mismatches,declared_missing:[]});
}
/** Subject differences disclosed per field (never an input to compatibility). */
export function subjectDifferences(entries){
  const differences=[];
  if(!Array.isArray(entries)||entries.length===0)return differences;
  for(const field of SUBJECT_FIELDS){
    const first=canonical(entries[0].subject[field]);
    if(entries.some(entry=>canonical(entry.subject[field])!==first))differences.push({field,values:entries.map(entry=>({participant_id:entry.participant_id,value:shortValue(entry.subject[field])}))});
  }
  return deepFreeze(differences);
}

/** Problems of a declared comparison context (what the frozen spec may hold). Empty array means no problem. */
export function declaredContextProblems(declared){
  const problems=[];
  const {fields,missing:bad}=normaliseDeclared(declared);
  if(bad.length>0)problems.push(numberInMoney(declared)?{code:CODES.QR3_SPEC_INCOMPLETE,fields:bad,detail:NUMBER_DETAIL}:{code:CODES.QR3_SPEC_INCOMPLETE,fields:bad});
  if(!bad.includes('market')){
    const market=fields.market;
    if(market.broker!==REQUIRED_MARKET.broker||market.symbol!==REQUIRED_MARKET.symbol)problems.push({code:CODES.QR3_MARKET_UNSUPPORTED});
    else if(market.timeframe!==REQUIRED_MARKET.timeframe)problems.push({code:CODES.QR3_TIMEFRAME_UNSUPPORTED});
  }
  if(!bad.includes('cost_model')&&!ADMITTED_COST_MODELS.includes(fields.cost_model.version))problems.push({code:CODES.QR3_COST_MODEL_UNSUPPORTED});
  if(!bad.includes('capital')&&fields.capital.initial_inventory!=='0')problems.push({code:CODES.QR3_SPEC_INCOMPLETE,fields:['capital']});
  return deepFreeze(problems);
}

const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MIN_PARTICIPANTS=2;
export const MAX_PARTICIPANTS=4;
/**
 * Request-level refusals that need no database (9.1). Check order: mode, mode mix, participant count, ids, market, timeframe,
 * cost model, fixture, objective in ACTUAL_BOT. The first failing check refuses; nothing is stored for a refusal.
 * input: {mode, participants:[{id, mode, fixture}], objective, market:{broker,symbol,timeframe}, cost_model_version, fixture_comparison}
 */
export function validateRequest(input){
  const request=isObject(input)?input:{};
  if(!MODES.includes(request.mode))return refuse(CODES.QR3_MODE_REQUIRED);
  const participants=Array.isArray(request.participants)?request.participants:null;
  if(participants===null)return refuse(CODES.INVALID_FIELDS,'PARTICIPANTS');
  if(participants.some(item=>!isObject(item)||item.mode!==undefined&&!MODES.includes(item.mode)))return refuse(CODES.INVALID_FIELDS,'PARTICIPANT_SHAPE');
  if(participants.some(item=>item.mode!==undefined&&item.mode!==request.mode))return refuse(CODES.QR3_MODE_MIX);
  if(participants.length<MIN_PARTICIPANTS||participants.length>MAX_PARTICIPANTS)return refuse(CODES.QR3_PARTICIPANT_COUNT);
  const seen=new Set();
  for(const item of participants){
    if(typeof item.id!=='string'||!RUN_ID.test(item.id))return refuse(CODES.INVALID_RUN_ID);
    if(seen.has(item.id))return refuse(CODES.DUPLICATE_RUN_ID);
    seen.add(item.id);
  }
  const market=request.market;
  if(!isObject(market)||market.broker!==REQUIRED_MARKET.broker||market.symbol!==REQUIRED_MARKET.symbol)return refuse(CODES.QR3_MARKET_UNSUPPORTED);
  if(market.timeframe!==REQUIRED_MARKET.timeframe)return refuse(CODES.QR3_TIMEFRAME_UNSUPPORTED);
  if(request.mode==='STANDARDIZED'&&!ADMITTED_COST_MODELS.includes(request.cost_model_version))return refuse(CODES.QR3_COST_MODEL_UNSUPPORTED);
  if(request.fixture_comparison!==true&&participants.some(item=>item.fixture===true))return refuse(CODES.QR3_FIXTURE_PARTICIPANT);
  if(request.mode==='ACTUAL_BOT'&&request.objective!==undefined&&request.objective!==null)return refuse(CODES.QR3_OBJECTIVE_NOT_ALLOWED);
  return deepFreeze({ok:true,code:null,detail:null});
}

/** qr3-context-actual-v1 (3.3): ACTUAL_BOT context is the QR-2 view header valuation context, field-by-field equality. */
export const ACTUAL_CONTEXT_FIELDS=Object.freeze(['mode','market','contract_version','method_ids','price_source_age_policy','drawdown_grid_id',
  'ledger_rule_epochs','fee_source','requested_range','resolved_range','currency','fx','capital_model_declaration_version']);
export function actualContextFields(participantId,raw){
  const source=isObject(raw)?raw:{};
  const fields={},missing=[];
  for(const name of ACTUAL_CONTEXT_FIELDS){
    const value=source[name];
    const readable=name==='mode'?value==='ACTUAL_BOT':value!==undefined&&value!==null&&value!=='';
    if(readable)fields[name]=value;else{fields[name]='MISSING:'+participantId;missing.push(name);}
  }
  return deepFreeze({fields,missing});
}
export const actualContextKey=fields=>hash(canonical({version:QR3_VERSIONS.context_actual,...fields}));
