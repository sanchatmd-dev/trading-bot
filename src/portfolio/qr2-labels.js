import {hash,canonical} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {QR2_BASIS,QR2_EXECUTION,QR2_FEE_SOURCE,QR2_METHODS,QR2_PRICE_POLICY,QR2_STATUS,Qr2Error} from './qr2-constants.js';
import {fillKey} from './qr2-replay.js';

// QR-2 labels and digests (contract 7.3, 6.7, 8.1, 8.2): the response validator, the number serializer, inputs_hash and the
// audit dedup key. Pure; nothing here writes anything.

/* ------------------------------------------------------------------ numbers: {value | null, status, reasons[]} */

const DECIMAL_STRING=/^-?\d+(?:\.\d+)?$/;
/**
 * Serializes one number (8.1). Money and returns are decimal strings; a JS number is refused. A null needs at least one
 * reason and is never rendered as 0. A present value is COMPLETE unless the caller sets another status; reasons on a present
 * value are information (for example PRICE_STALE).
 */
export function numberField({value=null,reasons=[],status}={}){
  if(typeof value==='number')throw new TypeError('QR-2 numbers are decimal strings, not JS numbers');
  if(value===null||value===undefined){
    if(!reasons.length)throw new Qr2Error('QR2_NULL_WITHOUT_REASON','a null number needs a reason');
    return {value:null,status:status??QR2_STATUS.UNAVAILABLE,reasons:[...reasons]};
  }
  const text=typeof value==='string'?value:D(value).toFixed();
  if(!DECIMAL_STRING.test(text))throw new TypeError('QR-2 number is not a decimal string: '+text);
  return {value:text,status:status??QR2_STATUS.COMPLETE,reasons:[...reasons]};
}

/* ------------------------------------------------------------------ view header and validator (8.1, 8.2) */

/**
 * Builds the header carried on every status. The basis argument is required and only 'ACTUAL_PAPER_LEDGER' is accepted.
 * execution, historical_simulation, qualified_evidence and fx are fixed by the contract and are not parameters. Method fields
 * and `extra` are spread BEFORE the fixed label fields, so they can never override a label (RC-Q10). The header keys of RC-Q11
 * are price_policy {fresh_ms, carry_ms}, contract_id, declaration_version, ledger_rule_epochs, lot_epochs, fee_source and
 * alloc_method; price_policy, fee_source and alloc_method default to the constants, the others come from the caller (a missing
 * one is refused by the validator).
 */
export function buildHeader({basis,requested_range,resolved_range,as_of,first_funding_at,currency,methods,extra={},price_policy=QR2_PRICE_POLICY,contract_id,declaration_version,ledger_rule_epochs,lot_epochs,fee_source=QR2_FEE_SOURCE,alloc_method=QR2_METHODS.alloc_method,range_flags=[]}){
  if(basis!==QR2_BASIS)throw new Qr2Error('QR2_BASIS_REFUSED','basis must be '+QR2_BASIS);
  return {...extra,...methods,price_policy,contract_id,declaration_version,ledger_rule_epochs,lot_epochs,fee_source,alloc_method,range_flags,
    basis:QR2_BASIS,execution:QR2_EXECUTION,historical_simulation:false,qualified_evidence:false,fx:'NONE',event_time_basis:'LEDGER_WRITE_TIME',
    requested_range,resolved_range,as_of,first_funding_at,currency};
}

const HEADER_FIELDS=['requested_range','resolved_range','as_of','first_funding_at','event_time_basis','currency','price_policy','contract_id','declaration_version','ledger_rule_epochs','lot_epochs','fee_source','alloc_method'];
const METHOD_FIELDS=['valuation_method','return_method','lot_method','legacy_method','order_method','period_method','drawdown_grid','rounding'];

function walk(value,path,visit){
  if(Array.isArray(value)){value.forEach((item,i)=>walk(item,path+'['+i+']',visit));return;}
  if(value&&typeof value==='object'){visit(value,path);for(const [k,v] of Object.entries(value))walk(v,path?path+'.'+k:k,visit);}
}

/**
 * Response validator (8.2). Refuses a missing, foreign or mixed basis, a wrong execution label, historical_simulation other
 * than false (also nested), qualified_evidence other than false, fx other than NONE, a missing header or method field, and a
 * number whose null is not explained or whose status says unavailable while it carries a value. Returns
 * {ok, errors:[{code, path}]}. The error code names are this module's choice; the contract names the rules only.
 */
export function validateResponse(response){
  const errors=[],add=(code,path)=>errors.push({code,path});
  if(!response||typeof response!=='object'||Array.isArray(response))return {ok:false,errors:[{code:'RESPONSE_NOT_AN_OBJECT',path:''}]};
  if(response.basis===undefined)add('BASIS_MISSING','basis');
  else if(Array.isArray(response.basis))add('BASIS_MIXED','basis');
  else if(response.basis!==QR2_BASIS)add('BASIS_FOREIGN','basis');
  else walk(response,'',(object,path)=>{if(object!==response&&object.basis!==undefined&&object.basis!==QR2_BASIS)add('BASIS_MIXED',path?path+'.basis':'basis');});
  if(response.execution!==QR2_EXECUTION)add('EXECUTION_LABEL_INVALID','execution');
  if(response.historical_simulation!==false)add('HISTORICAL_SIMULATION_NOT_FALSE','historical_simulation');
  walk(response,'',(object,path)=>{if(object!==response&&object.historical_simulation===true)add('HISTORICAL_SIMULATION_NOT_FALSE',path?path+'.historical_simulation':'historical_simulation');});
  if(response.qualified_evidence!==false)add('QUALIFIED_EVIDENCE_NOT_FALSE','qualified_evidence');
  if(response.fx!=='NONE')add('FX_NOT_NONE','fx');
  for(const field of [...HEADER_FIELDS,...METHOD_FIELDS])if(response[field]===undefined)add('HEADER_FIELD_MISSING',field);
  if(response.event_time_basis!==undefined&&response.event_time_basis!=='LEDGER_WRITE_TIME')add('EVENT_TIME_BASIS_INVALID','event_time_basis');
  const policy=response.price_policy;
  if(policy!==undefined&&!(policy&&typeof policy==='object'&&Number.isSafeInteger(policy.fresh_ms)&&Number.isSafeInteger(policy.carry_ms)))add('PRICE_POLICY_INVALID','price_policy');
  if(response.fee_source!==undefined&&response.fee_source!==QR2_FEE_SOURCE)add('FEE_SOURCE_INVALID','fee_source');
  // RC-Q21 header values: a present key must also hold a usable value. declaration_version may be null until S4.
  if(response.contract_id!==undefined&&(typeof response.contract_id!=='string'||response.contract_id===''))add('CONTRACT_ID_INVALID','contract_id');
  if(response.ledger_rule_epochs!==undefined&&!Array.isArray(response.ledger_rule_epochs))add('LEDGER_RULE_EPOCHS_INVALID','ledger_rule_epochs');
  if(response.lot_epochs!==undefined&&!Array.isArray(response.lot_epochs))add('LOT_EPOCHS_INVALID','lot_epochs');
  if(response.alloc_method!==undefined&&response.alloc_method!==QR2_METHODS.alloc_method)add('ALLOC_METHOD_INVALID','alloc_method');
  // RC-Q23: the resolved-range flags travel in range_flags; a requested `to` later than the resolved `to` needs
  // RANGE_END_AT_REQUEST_TIME in it.
  if(response.range_flags===undefined)add('HEADER_FIELD_MISSING','range_flags');
  else if(!Array.isArray(response.range_flags))add('RANGE_FLAGS_INVALID','range_flags');
  const asked=response.requested_range,resolved=response.resolved_range;
  // A null resolved range with a requested end later than as_of also needs the flag (the end clamps to the request time).
  const lateEnd=asked&&typeof asked==='object'&&(resolved&&typeof resolved==='object'?asked.to>resolved.to:resolved===null&&asked.to>response.as_of);
  if(lateEnd&&!(Array.isArray(response.range_flags)&&response.range_flags.includes('RANGE_END_AT_REQUEST_TIME')))
    add('RANGE_END_FLAG_MISSING','range_flags');
  walk(response,'',(object,path)=>{
    if(!('value' in object&&'status' in object&&'reasons' in object))return;
    if(typeof object.value==='number')add('NUMBER_NOT_DECIMAL_STRING',path+'.value');
    else if(object.value===null&&(!Array.isArray(object.reasons)||!object.reasons.length))add('NULL_WITHOUT_REASON',path+'.value');
    else if(object.value!==null&&object.status===QR2_STATUS.UNAVAILABLE)add('VALUE_WITH_UNAVAILABLE_STATUS',path+'.status');
    else if(object.value!==null&&typeof object.value==='string'&&!DECIMAL_STRING.test(object.value))add('NUMBER_NOT_DECIMAL_STRING',path+'.value');
  });
  return {ok:errors.length===0,errors};
}

/* ------------------------------------------------------------------ inputs_hash (7.3) */

const byNumber=(...keys)=>(a,b)=>{
  for(const key of keys){const c=D(a[key]).cmp(b[key]);if(c)return c;}
  return 0;
};
const sortedRows=(rows,...keys)=>rows.slice().sort(byNumber(...keys));
export const rowsDigest=rows=>hash(canonical(rows.map(canonical).sort()));

/**
 * inputs_hash: sha256 of the canonical JSON of the method ids, scope, period and, per account, the ordered canonical row
 * content (not only the keys) of paper_funding, paper_cash_journal and fills with the joined signal fields used, rows with
 * event time before `to` (journal rows by the paired fill's received_at); every price used as [bar_time, content_hash] or 'UNPRICED'; and, when `to` equals the request
 * time, the digests of positions and lots. Whole rows are hashed, so an in-place UPDATE of a column changes the hash.
 * accounts: [{id, fundings, journal, fills}]; prices: [{instant, symbol, ref}] where ref comes from priceReference.
 */
export function inputsHash({methods,scope,period,accounts,prices=[],to,requestTime,positions=[],lots=[]}){
  // RC-Q15: a fill and its journal row are one event at fills.received_at, so a journal row is filtered by its paired fill's
  // received_at (its own `at` only when no fill pairs with it).
  const journalTime=(account,row)=>{
    const paired=(account.fills||[]).find(f=>fillKey(f.signal_id,f.cumulative_quantity)===fillKey(row.signal_id,row.cumulative_quantity));
    return Number(paired?paired.received_at:row.at);
  };
  const document={
    methods,scope,period,
    accounts:accounts.map(a=>({
      id:a.id,
      paper_funding:sortedRows((a.fundings||[]).filter(r=>Number(r.at)<to),'at','id'),
      paper_cash_journal:sortedRows((a.journal||[]).filter(r=>journalTime(a,r)<to),'signal_id','cumulative_quantity'),
      fills:sortedRows((a.fills||[]).filter(r=>Number(r.received_at)<to),'received_at','signal_id','cumulative_quantity')
    })),
    prices:prices.slice().sort((a,b)=>a.instant-b.instant||(a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0)).map(p=>[p.instant,p.symbol,p.ref]),
    digests:to===requestTime?{positions:rowsDigest(positions),lots:rowsDigest(lots)}:null
  };
  return hash(canonical(document));
}

/* ------------------------------------------------------------------ audit dedup key (R-A, 6.7) */

// sha256(canonical([method_id, bot_id, broker, check_id, first_row_key])): one key per distinct defect.
export const auditDedupKey=({method_id,bot_id,broker,check_id,first_row_key})=>hash(canonical([method_id,bot_id,broker,check_id,first_row_key]));

/**
 * At most `max` (20) distinct keys per request (6.7). A finding contributes check_id = finding.check and first_row_key =
 * event_key, else position_id, else symbol, else ''. Order of first appearance is kept.
 */
export function selectAuditKeys({findings,method_id,bot_id,broker,max=20}){
  const keys=new Map();
  for(const f of findings){
    if(!f.check)continue;
    const first_row_key=f.event_key??f.position_id??f.symbol??'';
    const key=auditDedupKey({method_id,bot_id,broker,check_id:f.check,first_row_key});
    if(!keys.has(key))keys.set(key,{key,check_id:f.check,first_row_key});
    if(keys.size>=max)break;
  }
  return [...keys.values()];
}
