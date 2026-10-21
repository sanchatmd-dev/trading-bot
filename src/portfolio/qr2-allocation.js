import {D,sum} from '../money.js';
import {QR2_STATUS,Qr2Error} from './qr2-constants.js';
import {checkCrossViewKeys,worstStatus} from './qr2-checks.js';

/*
 * QR-2 S4-2: pure owner-total allocation (contract 4.1 to 4.4, 6.6 RX, 10, 13 item 11; root decisions S4-2, design 3.4).
 * No I/O, no clock, no database, no worker import. Money is exact decimal text (src/money.js, plus an independent BigInt
 * self-check); no binary floating point; every list has a fixed order. The S4-5 adapter maps real per-Bot views to the plain
 * input below; nothing here reads a ledger row.
 *
 * Input of aggregateOwnerTotal(input, {sum}):
 *   currency      'USDT' | 'THB'                      the one request currency
 *   range         {from, to}                          resolved owner range, UTC epoch ms, half-open [from, to), from < to
 *   declarations  [{version, capital_model, bot_set:[bot_id...], effective_from, currency?}]
 *                 every version of (owner, currency); capital_model INDEPENDENT_ACCOUNTS | SHARED_HYPOTHETICAL;
 *                 versions unique, effective_from non-decreasing with version (the table guard keeps this; a violation is an input error)
 *   owner_bots    [{bot_id, created_at}]              the owner set: the owner's own row plus its children (contract 4.1)
 *   accounts      [{                                  one per (Bot, broker) account found in the currency, any ledger row
 *                   bot_id, broker, currency,                      accounts of a Bot created at or after range.to are dropped on input (G1)
 *                   status {status COMPLETE|PARTIAL|UNAVAILABLE|REFUSED, overlays[], reasons[]}   per-Bot composed `status`
 *                   code                              the refusal code when status is REFUSED, else null (composed `code`)
 *                   range {from, to} | null           composed `resolved_range`
 *                   reconciliation {state OK|RECONCILIATION_FAILED|ACCOUNT_UNAVAILABLE, failed_from int|null}   composed `reconciliation`
 *                   price_state_from, price_state_to  worst position price state at the range ends (FRESH, STALE, NO_POSITION or a failure state)
 *                   nav_from, nav_to, flows_total, fees, money_pnl, twr   composed `account.*` number fields {value|null, status, reasons[]};
 *                                                     nav_to is the composed `account.nav`; nav_from is the NAV at the range start (adapter-added)
 *                   keys {signals[], journal[{signal_id, cumulative_quantity}], fundings[], positions[]}   RX identities, never sent out
 *                 }]
 *                 A REFUSED account may omit every field except bot_id, broker, currency, status and code.
 *
 * Result (never mutates the input):
 *   {allocation:{capital_model, version, reason, effective_from},
 *    total:{label, notice, nav_from, nav_to, flows_total, fees, money_pnl, twr, mwr, member_count, members[]},   each number {value|null, status, reasons[]}
 *    accounts:[...], status:{status, overlays, reasons}}
 * or a refused view {refused, code, status, counts} carrying the code and counts only, no allocation, total or accounts (RC-Q26, RC-Q32).
 * allocation.reason carries declaration-level reasons only (CAPITAL_MODEL_NOT_DECLARED, ALLOCATION_DECLARATION_CHANGED,
 * NOT_AGGREGABLE_SHARED_CAPITAL, ALLOCATION_SET_CHANGED); member-level and range-defence nulls stay in the total reasons.
 * Request-level refusals (QR2_CURRENCY_MIX, QR2_INPUT_INVALID) are thrown as Qr2Error, like the other pure modules.
 */

export const ALLOCATION_CODES=Object.freeze({
  // New in S4-2 (root decision A1).
  ALLOCATION_DECLARATION_CHANGED:'ALLOCATION_DECLARATION_CHANGED',
  ALLOCATION_RANGE_MISMATCH:'ALLOCATION_RANGE_MISMATCH',
  // Other allocation codes of this module (contract 4.2, 6.6).
  CAPITAL_MODEL_NOT_DECLARED:'CAPITAL_MODEL_NOT_DECLARED',
  NOT_AGGREGABLE_SHARED_CAPITAL:'NOT_AGGREGABLE_SHARED_CAPITAL',
  ALLOCATION_SET_CHANGED:'ALLOCATION_SET_CHANGED',
  ALLOCATION_INDEPENDENT_NO_RETURN:'ALLOCATION_INDEPENDENT_NO_RETURN',
  ALLOCATION_MEMBER_UNAVAILABLE:'ALLOCATION_MEMBER_UNAVAILABLE',
  ALLOCATION_NO_MEMBER_ACCOUNT:'ALLOCATION_NO_MEMBER_ACCOUNT',
  QR2_CROSS_BOT_ROW:'QR2_CROSS_BOT_ROW',
  QR2_NON_PAPER_ROW:'QR2_NON_PAPER_ROW',
  QR2_TOTAL_MISMATCH:'QR2_TOTAL_MISMATCH',
  QR2_CURRENCY_MIX:'QR2_CURRENCY_MIX'
});
export const ALLOCATION_LABEL='SUM_OF_INDEPENDENT_PAPER_ACCOUNTS';
export const ALLOCATION_NOTICE='NOT_AN_OWNER_PORTFOLIO';
export const ALLOCATION_NO_ACCOUNT='NO_ACCOUNT';
export const ALLOCATION_MODELS=Object.freeze(['INDEPENDENT_ACCOUNTS','SHARED_HYPOTHETICAL']);
export const ALLOCATION_CURRENCIES=Object.freeze(['USDT','THB']);
// The five summed lines. The owner total carries no return (OD-Q8): twr and mwr are always null.
export const ALLOCATION_SUM_FIELDS=Object.freeze(['nav_from','nav_to','flows_total','fees','money_pnl']);
const PRICED_STATES=new Set(['FRESH','STALE','NO_POSITION']);
const RECONCILIATION_STATES=new Set(['OK','RECONCILIATION_FAILED','ACCOUNT_UNAVAILABLE']);
const ACCOUNT_STATUSES=new Set([QR2_STATUS.COMPLETE,QR2_STATUS.PARTIAL,QR2_STATUS.UNAVAILABLE,QR2_STATUS.REFUSED]);
// A refusal of one member view that refuses the whole owner view (RC-Q2 fail closed). Any other member refusal nulls the total.
const PROPAGATED_REFUSALS=['QR2_CROSS_BOT_ROW','QR2_NON_PAPER_ROW'];

/* ------------------------------------------------------------------ input reading (fail closed: a malformed input throws) */

const bad=what=>new Qr2Error('QR2_INPUT_INVALID','allocation input: '+what);
const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const isText=value=>typeof value==='string'&&value!=='';
const isInt=value=>Number.isSafeInteger(value);
const byText=(a,b)=>a<b?-1:a>b?1:0;
const stringList=(value,where)=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||!value.every(isText))throw bad(where+' must be a list of text');
  return [...value];
};
const unique=list=>[...new Set(list)].sort(byText);

const normDecimal=(value,where)=>{
  if(typeof value!=='string')throw bad(where+' must be a decimal string');
  let text;
  try{text=D(value).toFixed();}catch{throw bad(where+' is not a decimal string');}
  return text==='-0'?'0':text;
};
const nullField=reason=>({value:null,status:QR2_STATUS.UNAVAILABLE,reasons:[reason]});
function readField(item,name,{optional=false,absentReason=null}={}){
  if(item===undefined||item===null){
    if(!optional)throw bad(name+' is required');
    return nullField(absentReason??name.toUpperCase()+'_NOT_AVAILABLE');
  }
  if(!isPlain(item)||!('value' in item))throw bad(name+' must be a number field');
  const reasons=stringList(item.reasons,name+'.reasons');
  if(item.value===null)return {value:null,status:QR2_STATUS.UNAVAILABLE,reasons:reasons.length?reasons:[name.toUpperCase()+'_NOT_AVAILABLE']};
  const status=item.status===undefined?QR2_STATUS.COMPLETE:item.status;
  if(status!==QR2_STATUS.COMPLETE&&status!==QR2_STATUS.PARTIAL)throw bad(name+'.status is not valid for a present value');
  return {value:normDecimal(item.value,name+'.value'),status,reasons};
}

function readRange(range,where,nullable){
  if(range===null&&nullable)return null;
  if(!isPlain(range)||!isInt(range.from)||!isInt(range.to))throw bad(where+' must be {from, to} integers');
  return {from:range.from,to:range.to};
}

function readKeys(keys){
  if(!isPlain(keys))throw bad('keys is required');
  const ids=(list,where)=>{
    if(!Array.isArray(list)||!list.every(v=>isText(v)||isInt(v)))throw bad(where+' must be a list of ids');
    return list.map(String);
  };
  if(!Array.isArray(keys.journal))throw bad('keys.journal must be a list');
  const journal=keys.journal.map(row=>{
    if(!isPlain(row)||!(isText(row.signal_id)||isInt(row.signal_id)))throw bad('keys.journal rows need signal_id and cumulative_quantity');
    return {signal_id:String(row.signal_id),cumulative_quantity:normDecimal(row.cumulative_quantity,'keys.journal.cumulative_quantity')};
  });
  return {signals:ids(keys.signals,'keys.signals'),journal,fundings:ids(keys.fundings,'keys.fundings'),positions:ids(keys.positions,'keys.positions')};
}

function readAccount(raw,currency,index){
  const where='accounts['+index+']';
  if(!isPlain(raw))throw bad(where+' must be an object');
  if(!isText(raw.bot_id)||!isText(raw.broker))throw bad(where+' needs bot_id and broker');
  if(raw.currency!==currency)throw new Qr2Error(ALLOCATION_CODES.QR2_CURRENCY_MIX,'The request is refused');
  if(!isPlain(raw.status)||!ACCOUNT_STATUSES.has(raw.status.status))throw bad(where+'.status is invalid');
  const status={status:raw.status.status,overlays:unique(stringList(raw.status.overlays,where+'.status.overlays')),reasons:unique(stringList(raw.status.reasons,where+'.status.reasons'))};
  const refused=status.status===QR2_STATUS.REFUSED;
  const account={bot_id:raw.bot_id,broker:raw.broker,status,refused,code:null};
  if(refused){
    if(!isText(raw.code))throw bad(where+' is REFUSED and needs a code');
    account.code=raw.code;
  }
  const opt={optional:refused,absentReason:account.code};
  for(const name of ALLOCATION_SUM_FIELDS)account[name]=readField(raw[name],name,opt);
  account.twr=readField(raw.twr,'twr',{optional:true,absentReason:account.code});
  if(refused){
    account.range=null;account.reconciliation=null;account.price_state_from=null;account.price_state_to=null;
    account.keys=raw.keys===undefined?{signals:[],journal:[],fundings:[],positions:[]}:readKeys(raw.keys);
    return account;
  }
  account.range=readRange(raw.range,where+'.range',true);
  const rec=raw.reconciliation;
  if(!isPlain(rec)||!RECONCILIATION_STATES.has(rec.state)||!(rec.failed_from===null||rec.failed_from===undefined||isInt(rec.failed_from)))throw bad(where+'.reconciliation is invalid');
  account.reconciliation={state:rec.state,failed_from:rec.failed_from??null};
  for(const name of ['price_state_from','price_state_to']){
    if(!(raw[name]===undefined||raw[name]===null||isText(raw[name])))throw bad(where+'.'+name+' must be text or null');
    account[name]=raw[name]??null;
  }
  account.keys=readKeys(raw.keys);
  return account;
}

function readDeclarations(list,currency){
  if(!Array.isArray(list))throw bad('declarations must be a list');
  const rows=list.map((raw,i)=>{
    const where='declarations['+i+']';
    if(!isPlain(raw))throw bad(where+' must be an object');
    if(raw.currency!==undefined&&raw.currency!==currency)throw new Qr2Error(ALLOCATION_CODES.QR2_CURRENCY_MIX,'The request is refused');
    if(!isInt(raw.version)||raw.version<1)throw bad(where+'.version must be a positive integer');
    if(!ALLOCATION_MODELS.includes(raw.capital_model))throw bad(where+'.capital_model is invalid');
    if(!Array.isArray(raw.bot_set)||!raw.bot_set.length||!raw.bot_set.every(isText)||new Set(raw.bot_set).size!==raw.bot_set.length)throw bad(where+'.bot_set must be a non-empty list of unique ids');
    if(!isInt(raw.effective_from)||raw.effective_from<0)throw bad(where+'.effective_from must be a non-negative integer');
    return {version:raw.version,capital_model:raw.capital_model,bot_set:[...raw.bot_set].sort(byText),effective_from:raw.effective_from};
  }).sort((a,b)=>a.version-b.version);
  for(let i=1;i<rows.length;i++){
    if(rows[i].version===rows[i-1].version)throw bad('declaration versions must be unique');
    if(rows[i].effective_from<rows[i-1].effective_from)throw bad('declaration effective_from must not decrease with the version');
  }
  return rows;
}

function readInput(input){
  if(!isPlain(input))throw bad('input must be an object');
  const {currency}=input;
  if(!ALLOCATION_CURRENCIES.includes(currency))throw bad('currency must be USDT or THB');
  const range=readRange(input.range,'range',false);
  if(!(range.from<range.to))throw bad('range needs from < to');
  const declarations=readDeclarations(input.declarations,currency);
  if(!Array.isArray(input.owner_bots))throw bad('owner_bots must be a list');
  const ownerBots=input.owner_bots.map((raw,i)=>{
    if(!isPlain(raw)||!isText(raw.bot_id)||!isInt(raw.created_at))throw bad('owner_bots['+i+'] needs bot_id and created_at');
    return {bot_id:raw.bot_id,created_at:raw.created_at};
  }).sort((a,b)=>byText(a.bot_id,b.bot_id));
  if(new Set(ownerBots.map(b=>b.bot_id)).size!==ownerBots.length)throw bad('owner_bots ids must be unique');
  if(!Array.isArray(input.accounts))throw bad('accounts must be a list');
  const accounts=input.accounts.map((raw,i)=>readAccount(raw,currency,i)).sort((a,b)=>byText(a.bot_id,b.bot_id)||byText(a.broker,b.broker));
  const seen=new Set(),owner=new Set(ownerBots.map(b=>b.bot_id));
  for(const a of accounts){
    const key=a.bot_id+'\u0000'+a.broker;
    if(seen.has(key))throw bad('two accounts share one Bot and broker');
    seen.add(key);
    if(!owner.has(a.bot_id))throw bad('an account belongs to a Bot outside the owner set');
  }
  // G1: no row of a Bot created at or after range.to can lie in [from, to), so its accounts are not part of this range.
  const bornAt=new Map(ownerBots.map(b=>[b.bot_id,b.created_at]));
  const inRange=accounts.filter(a=>bornAt.get(a.bot_id)<range.to);
  return {currency,from:range.from,to:range.to,declarations,ownerBots,accounts:inRange};
}

/* ------------------------------------------------------------------ exact sums and the independent self-check */

const exactSum=values=>{const text=sum(values).toFixed();return text==='-0'?'0':text;};
const places=text=>{const i=text.indexOf('.');return i<0?0:text.length-i-1;};
// A decimal string as an integer count of 10^-scale units. BigInt is exact integer arithmetic, not binary floating point.
function scaled(text,scale){
  if(typeof text!=='string'||!/^-?\d+(?:\.\d+)?$/.test(text))throw new TypeError('not a decimal string');
  const negative=text.startsWith('-');
  const [whole,fraction='']=(negative?text.slice(1):text).split('.');
  const value=BigInt(whole+fraction.padEnd(scale,'0'));
  return negative?-value:value;
}
// RX: each total equals the exact sum of its parts, and money_pnl_total = nav_to_total - nav_from_total - flows_total. Returns the
// names of the lines that disagree; the sums are rebuilt here with integers, not with the code path that built the totals.
function selfCheck(parts,totals){
  const mismatched=[];
  const scale=Math.max(0,...ALLOCATION_SUM_FIELDS.flatMap(f=>[...parts[f],String(totals[f])].map(t=>typeof t==='string'?places(t):0)));
  try{
    for(const f of ALLOCATION_SUM_FIELDS){
      const expected=parts[f].reduce((t,v)=>t+scaled(v,scale),0n);
      if(expected!==scaled(totals[f],scale))mismatched.push(f);
    }
    if(scaled(totals.money_pnl,scale)!==scaled(totals.nav_to,scale)-scaled(totals.nav_from,scale)-scaled(totals.flows_total,scale))mismatched.push('identity');
    // G2: the identity holds for every member exactly (qr2-returns.js: money_pnl = nav_to - nav_from - flows_total), not only in sum.
    const broken=parts.money_pnl.some((v,i)=>scaled(v,scale)!==scaled(parts.nav_to[i],scale)-scaled(parts.nav_from[i],scale)-scaled(parts.flows_total[i],scale));
    if(broken)mismatched.push('member_identity');
  }catch{return ALLOCATION_SUM_FIELDS.concat('identity','member_identity');}
  return mismatched;
}

/* ------------------------------------------------------------------ result builders */

const allocationOf=(declaration,reason)=>({capital_model:declaration?declaration.capital_model:null,version:declaration?declaration.version:null,reason,effective_from:declaration?declaration.effective_from:null});
const statusOf=(status,reasons,overlays)=>({status,overlays,reasons});
const accountRow=a=>({bot_id:a.bot_id,broker:a.broker,status:{status:a.status.status,overlays:[...a.status.overlays],reasons:[...a.status.reasons]},
  nav_from:a.nav_from,nav_to:a.nav_to,flows_total:a.flows_total,fees:a.fees,money_pnl:a.money_pnl,twr:a.twr});

function refusedView(code,counts){
  return {refused:code,code,status:statusOf(QR2_STATUS.REFUSED,[code],[]),counts};
}

// Shared owner scope gate also covers an unresolved owner range without inventing an interval.
export function ownerAccountScopeRefusal(accounts,currency){
  return accountScopeRefusal(accounts.map((a,i)=>readAccount(a,currency,i)));
}
function accountScopeRefusal(accounts){
  // RX: no signal, journal key, funding id or position key in two member views; a refused member view refuses the whole total.
  const refusedMembers=accounts.filter(a=>a.refused&&PROPAGATED_REFUSALS.includes(a.code));
  const overlap=checkCrossViewKeys(accounts.map(a=>({id:a.bot_id+'\u0000'+a.broker,
    fills:unique([...a.keys.signals,...a.keys.journal.map(j=>j.signal_id)]).map(signal_id=>({signal_id})),journal:a.keys.journal,fundings:a.keys.fundings.map(id=>({id})),lots:a.keys.positions.map(position_id=>({position_id}))})));
  const keysOf=prefix=>new Set(overlap.findings.filter(f=>f.key.startsWith(prefix)).map(f=>f.key)).size;
  const counts={accounts:accounts.length,accounts_refused:refusedMembers.length,signals:keysOf('S:'),journal:keysOf('J:'),fundings:keysOf('F:'),positions:keysOf('P:')};
  if(!overlap.ok||refusedMembers.some(a=>a.code===ALLOCATION_CODES.QR2_CROSS_BOT_ROW))return refusedView(ALLOCATION_CODES.QR2_CROSS_BOT_ROW,counts);
  if(refusedMembers.length)return refusedView(ALLOCATION_CODES.QR2_NON_PAPER_ROW,counts);

  return null;
}

/**
 * The owner total over the independent Paper accounts of one currency and range (contract 4.2, design 3.4). Rules, in order:
 * input and currency defence (QR2_CURRENCY_MIX thrown); RX disjointness and member RP/RX refusals; applicable declaration;
 * declaration change inside the range; SHARED_HYPOTHETICAL; Bot-set check; member condition; range defence; exact sums with the self-check. The first
 * failing rule decides; a null total has no partial number (contract 4.2). `options.sum` is a test seam for the exact summing.
 */
export function aggregateOwnerTotal(input,{sum:sumFn=exactSum}={}){
  const {from,to,declarations,ownerBots,accounts}=readInput(input);
  const overlays=unique(accounts.flatMap(a=>a.status.overlays));
  // 4.2 and R-22: the applicable version at an instant is the highest version with effective_from <= that instant.
  let declaration=null;
  for(const d of declarations)if(d.effective_from<=from)declaration=d;
  const rowsOf=()=>{
    const rows=accounts.map(accountRow);
    if(declaration){
      const have=new Set(accounts.map(a=>a.bot_id));
      for(const id of declaration.bot_set)if(!have.has(id))rows.push({bot_id:id,account:ALLOCATION_NO_ACCOUNT});
    }
    return rows.sort((a,b)=>byText(a.bot_id,b.bot_id)||byText(a.broker??'',b.broker??''));
  };
  const independent=declaration?.capital_model==='INDEPENDENT_ACCOUNTS';
  // A total that is null: every number null with the reason; no partial value.
  const nullView=(reason,{allocationReason=reason,members=[]}={})=>{
    const total={label:independent?ALLOCATION_LABEL:null,notice:independent?ALLOCATION_NOTICE:null};
    for(const f of [...ALLOCATION_SUM_FIELDS,'twr','mwr'])total[f]=nullField(reason);
    total.member_count=0;total.members=members;
    return {allocation:allocationOf(declaration,allocationReason),total,accounts:rowsOf(),status:statusOf(QR2_STATUS.UNAVAILABLE,[reason],overlays)};
  };

  const scopeRefusal=accountScopeRefusal(accounts);
  if(scopeRefusal)return scopeRefusal;

  if(!declaration)return nullView(ALLOCATION_CODES.CAPITAL_MODEL_NOT_DECLARED);
  if(declarations.some(d=>d.version>declaration.version&&d.effective_from<to))return nullView(ALLOCATION_CODES.ALLOCATION_DECLARATION_CHANGED);
  if(declaration.capital_model==='SHARED_HYPOTHETICAL')return nullView(ALLOCATION_CODES.NOT_AGGREGABLE_SHARED_CAPITAL);

  // Bot-set check: the Bots that exist before `to` equal the declared set, and each declared Bot already exists at `from`.
  const bornBefore=ownerBots.filter(b=>b.created_at<to).map(b=>b.bot_id);
  const created=new Map(ownerBots.map(b=>[b.bot_id,b.created_at]));
  const sameSet=bornBefore.length===declaration.bot_set.length&&bornBefore.every((id,i)=>id===declaration.bot_set[i]);
  if(!sameSet||!declaration.bot_set.every(id=>created.has(id)&&created.get(id)<=from))return nullView(ALLOCATION_CODES.ALLOCATION_SET_CHANGED);
  const declared=new Set(declaration.bot_set);
  if(accounts.some(a=>!declared.has(a.bot_id)))throw bad('an account belongs to a Bot outside the declared set');

  // Member condition (R-5): NAV at both ends, flows, fees and money PnL present, priced, reconciled. A stale price keeps the value.
  const members=accounts;
  if(!members.length)return nullView(ALLOCATION_CODES.ALLOCATION_NO_MEMBER_ACCOUNT,{allocationReason:null});
  const nulls=[];
  for(const a of members){
    const reasons=new Set(),fields=[];
    if(a.refused)reasons.add(a.code);
    if(a.status.status===QR2_STATUS.UNAVAILABLE)reasons.add('MEMBER_STATUS_UNAVAILABLE');
    if(!a.refused){
      const rec=a.reconciliation;
      if(rec.state==='ACCOUNT_UNAVAILABLE')reasons.add(rec.state);
      else if(rec.state==='RECONCILIATION_FAILED'&&(rec.failed_from===null||to>rec.failed_from))reasons.add(rec.state);
      for(const name of ['price_state_from','price_state_to'])if(!PRICED_STATES.has(a[name]))reasons.add(a[name]??'PRICE_STATE_UNKNOWN');
    }
    for(const f of ALLOCATION_SUM_FIELDS)if(a[f].value===null){fields.push(f);for(const r of a[f].reasons)reasons.add(r);}
    if(reasons.size||fields.length)nulls.push({bot_id:a.bot_id,broker:a.broker,fields,reasons:[...reasons].sort(byText)});
  }
  if(nulls.length)return nullView(ALLOCATION_CODES.ALLOCATION_MEMBER_UNAVAILABLE,{allocationReason:null,members:nulls});

  // Range defence: every member view covers the owner range.
  if(members.some(a=>!a.range||a.range.from!==from||a.range.to!==to))return nullView(ALLOCATION_CODES.ALLOCATION_RANGE_MISMATCH,{allocationReason:null});

  // Exact sums, then the self-check (RX): totals equal the sum of the parts and the money PnL identity holds.
  const parts={},totals={},total={label:ALLOCATION_LABEL,notice:ALLOCATION_NOTICE};
  for(const f of ALLOCATION_SUM_FIELDS){
    parts[f]=members.map(a=>a[f].value);
    totals[f]=sumFn([...parts[f]],f);
  }
  const mismatched=selfCheck(parts,totals);
  if(mismatched.length)return refusedView(ALLOCATION_CODES.QR2_TOTAL_MISMATCH,{accounts:members.length,fields_checked:ALLOCATION_SUM_FIELDS.length+2,fields_mismatched:mismatched.length});
  for(const f of ALLOCATION_SUM_FIELDS){
    total[f]={value:totals[f],status:worstStatus(members.map(a=>a[f].status)),reasons:unique(members.flatMap(a=>a[f].reasons))};
  }
  total.twr=nullField(ALLOCATION_CODES.ALLOCATION_INDEPENDENT_NO_RETURN);
  total.mwr=nullField(ALLOCATION_CODES.ALLOCATION_INDEPENDENT_NO_RETURN);
  total.member_count=members.length;total.members=[];
  return {allocation:allocationOf(declaration,null),total,accounts:rowsOf(),
    status:statusOf(worstStatus(members.map(a=>a.status.status)),unique(members.flatMap(a=>a.status.reasons)),overlays)};
}
