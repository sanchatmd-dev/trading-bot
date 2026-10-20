import {D} from '../money.js';
import {QR2_BASIS,QR2_METHODS,QR2_STATUS,Qr2Error} from './qr2-constants.js';
import {buildHeader,numberField,validateResponse} from './qr2-labels.js';
import {stateAt} from './qr2-replay.js';
import {exposure} from './qr2-returns.js';

// QR-2 S3a response composer (contract 8.1, RC-Q32). Pure: it reads a reader view and builds the header and the number fields of the
// response. It never returns a ledger row, a replay event, a price bar or a value read from a row of another Bot. The final object goes
// through validateResponse; any failure (including a TypeError from a bad number) is one fixed QR2_RESPONSE_INVALID with no number in it.

// The contract id travels in every header (RC-Q11). The value is a root item (design R-2): root confirms or renames it.
export const QR2_CONTRACT_ID='QR2_PAPER_PERFORMANCE_CONTRACT_V1';
export const QR2_NOTICE_IDS=Object.freeze(['QR2_NOTICE_ACTUAL_PAPER','QR2_NOTICE_BOOK_EQUITY']);
export const QR2_MAX_FINDINGS=50;
// Every top-level key a response may carry: the buildHeader keys plus the body blocks below.
const HEADER_KEYS=['valuation_method','return_method','lot_method','legacy_method','order_method','period_method','drawdown_grid','rounding','price_policy',
  'contract_id','declaration_version','ledger_rule_epochs','lot_epochs','fee_source','alloc_method','range_flags','basis','execution','historical_simulation',
  'qualified_evidence','fx','event_time_basis','requested_range','resolved_range','as_of','first_funding_at','currency'];
const BODY_KEYS=['status','code','scope','account','exposure_basis','flows_count','symbols','reconciliation','legacy_seeds','marker_counts','findings','information_count',
  'attribution_counts','slippage_counts','audit_findings','pending','analytics_comparison','market_data','cutoffs','reader','notice_ids'];
const ALLOWED_KEYS=new Set([...HEADER_KEYS,...BODY_KEYS]);
export const unknownTopLevelKeys=body=>Object.keys(body).filter(key=>!ALLOWED_KEYS.has(key));

// Fixed text per code: an internal message, a SQL text or a path never reaches the client.
export const QR2_ERROR_TEXT=Object.freeze({
  QR2_INPUT_INVALID:'The request parameters are not valid',
  QR2_RANGE_INVALID:'The requested range is not valid',
  QR2_FEE_OVERLAY_REFUSED:'A fee overlay is not accepted',
  QR2_NOT_OWNER:'Not found',
  QR2_RANGE_ADMISSION_REFUSED:'The request is over a limit',
  QR2_CURRENCY_MIX:'The request is refused',
  QR2_RESPONSE_INVALID:'The performance response could not be validated',
  QR2_REPORT_FAILED:'Performance report could not be produced'
});

// Contract 10 request-level codes mapped to HTTP statuses. QR2_RANGE_ADMISSION_REFUSED depends on the detail (see statusOfAdmission).
const STATUS_OF_CODE=Object.freeze({
  QR2_INPUT_INVALID:400,QR2_RANGE_INVALID:400,QR2_FEE_OVERLAY_REFUSED:400,QR2_NOT_OWNER:404,QR2_CURRENCY_MIX:422,
  QR2_RESPONSE_INVALID:500,QR2_REPORT_FAILED:503
});
export function statusOfAdmission(detail){
  const limit=detail&&typeof detail==='object'?detail.limit:undefined;
  if(limit==='concurrency')return 429;
  if(limit==='history_days')return 403;
  return 422;
}
export function statusOfRefusal(code,detail){
  if(code==='QR2_RANGE_ADMISSION_REFUSED')return statusOfAdmission(detail);
  return STATUS_OF_CODE[code]??503;
}
// The request-level refusal body: code, fixed text and an optional own-scope detail. No header and no view (contract 10).
export function refusalAnswer(code,detail){
  const known=Object.hasOwn(QR2_ERROR_TEXT,code);
  const safe=known?code:'QR2_REPORT_FAILED';
  const body={code:safe,error:QR2_ERROR_TEXT[safe]};
  if(safe==='QR2_RANGE_ADMISSION_REFUSED'&&detail&&typeof detail==='object'){
    const pick={};
    for(const key of ['limit','value','max'])if(detail[key]!==undefined&&(typeof detail[key]==='string'||Number.isSafeInteger(detail[key])))pick[key]=detail[key];
    if(Object.keys(pick).length)body.detail=pick;
  }
  return {status:known?statusOfRefusal(safe,detail):503,body};
}

const methodIds=()=>({valuation_method:QR2_METHODS.valuation_method,return_method:QR2_METHODS.return_method,lot_method:QR2_METHODS.lot_method,
  legacy_method:QR2_METHODS.legacy_method,order_method:QR2_METHODS.order_method,period_method:QR2_METHODS.period_method,
  drawdown_grid:QR2_METHODS.drawdown_grid,rounding:QR2_METHODS.rounding});

// A value, or a null with at least one reason; the fallback reason keeps a null from ever being unexplained. nullReasons explain a null
// only; info reasons (for example PRICE_STALE) travel with a present value and never make it null.
const strings=list=>(list||[]).filter(r=>typeof r==='string');
const field=(value,nullReasons,fallback,info=[])=>{
  if(value===null||value===undefined){const list=strings(nullReasons);return numberField({value:null,reasons:list.length?list:[fallback]});}
  return numberField({value,reasons:strings(info)});
};
const copyField=item=>numberField({value:item.value,reasons:item.reasons,status:item.status});

const text=(value,fallback=null)=>typeof value==='string'?value:fallback;
const integer=value=>Number.isSafeInteger(value)?value:null;

function findingsOf(list){
  const out=[];
  for(const f of list||[]){
    const item={check:text(f.check),code:text(f.code),effect:text(f.effect)};
    if(typeof f.reason==='string')item.reason=f.reason;
    if(typeof f.table==='string')item.table=f.table;
    if(typeof f.event_key==='string')item.event_key=f.event_key;
    if(Number.isSafeInteger(f.count))item.count=f.count;
    out.push(item);
  }
  return {total:out.length,capped:out.length>QR2_MAX_FINDINGS,items:out.slice(0,QR2_MAX_FINDINGS)};
}

function header(view,requestTime){
  const range=view.range||{};
  return buildHeader({
    basis:QR2_BASIS,
    requested_range:range.requested??null,
    resolved_range:range.resolved??null,
    as_of:requestTime,
    first_funding_at:view.first_funding_at??null,
    currency:view.scope.currency,
    methods:methodIds(),
    contract_id:QR2_CONTRACT_ID,
    declaration_version:null,
    ledger_rule_epochs:Array.isArray(view.ledger_rule_epochs)?view.ledger_rule_epochs:[],
    lot_epochs:Array.isArray(view.lot_epochs)?view.lot_epochs:[],
    range_flags:Array.isArray(range.flags)?[...range.flags]:[]
  });
}

function readerBlock(view){
  const r=view.reader;
  return {method:r.method,limits:{...r.limits},counts:Object.fromEntries(Object.entries(r.counts).map(([k,v])=>[k,Number(v)])),
    read_ms:Math.round(r.read_ms),compute_ms:Math.round(r.compute_ms)};
}

// A refused view (RP, RX): header, status REFUSED, the code and the counts only (RC-Q26, RC-Q32).
function refusedBody(view,requestTime){
  const findings=findingsOf(view.gates?.row_scope?.findings);
  return {...header(view,requestTime),
    status:{status:QR2_STATUS.REFUSED,overlays:[],reasons:[view.refused]},
    code:view.refused,
    scope:{bot_id:view.scope.bot_id,broker:view.scope.broker,account_id:view.scope.account_id},
    reader:readerBlock(view),
    findings,
    notice_ids:[...QR2_NOTICE_IDS]};
}

// unlotted: the replayed quantity per symbol that no lot covers (an aggregate string per symbol, never a row).
function symbolsOf(nav,splitNullReasons,unlotted){
  return (nav?.positions||[]).map(p=>{
    const open=unlotted&&typeof unlotted==='object'?unlotted[p.symbol]:undefined;
    return {
      symbol:String(p.symbol),
      quantity:field(p.quantity,[],'QUANTITY_UNAVAILABLE'),
      unlotted_quantity:field(typeof open==='string'?open:null,['UNLOTTED_NOT_AVAILABLE'],'UNLOTTED_NOT_AVAILABLE'),
      cost_basis:field(p.cost,splitNullReasons,'COST_UNAVAILABLE'),
      price:field(p.price,[p.state],'PRICE_UNAVAILABLE',p.state==='STALE'?['PRICE_STALE']:[]),
      price_state:text(p.state),
      price_age_ms:integer(p.age_ms),
      price_bar_time:integer(p.bar_time),
      price_retrieval:text(p.retrieval),
      market_value:field(p.market_value,[p.state],'PRICE_UNAVAILABLE',p.state==='STALE'?['PRICE_STALE']:[]),
      unrealized_pnl:field(p.unrealized,p.market_value===null?[p.state]:splitNullReasons,'UNREALIZED_UNAVAILABLE')
    };
  });
}

function accountBody(view){
  const p=view.performance,nav=p?.nav_to,facts=view.facts,r15=facts.r15,resolvedTo=view.range.resolved?.to??null;
  const blocked=view.status.reasons;
  const none=reason=>blocked&&blocked.length?[...blocked]:[reason];
  const navReasons=nav?(nav.reasons.length?nav.reasons:[]):none('NAV_NOT_AVAILABLE');
  const costReasons=nav?(nav.cost_reason?[nav.cost_reason]:['SPLIT_NULL']):none('COST_NOT_AVAILABLE');
  const stale=(nav?.reasons||[]).filter(r=>r==='PRICE_STALE');
  const flowsTotal=p?.flows?p.flows.reduce((t,f)=>t.plus(f.amount),D(0)).toFixed():null;
  const at=resolvedTo===null?{available:false}:stateAt(view.replay,resolvedTo);
  const fees=at.available&&at.state&&nav?at.state.fees:null;
  const exp=nav?exposure(nav):{value:null,basis:null,reason:'NAV_NOT_AVAILABLE'};
  const account={
    cash:field(nav?.cash,navReasons,'CASH_NOT_AVAILABLE'),
    reserved_notional:field(r15.reserved_notional,[r15.available_cash_reason].filter(Boolean),'RESERVATION_NOT_AVAILABLE'),
    reserved_fees:field(r15.reserved_fees,[r15.available_cash_reason].filter(Boolean),'RESERVATION_NOT_AVAILABLE'),
    available_cash:field(r15.available_cash,[r15.available_cash_reason].filter(Boolean),'AVAILABLE_CASH_NOT_AVAILABLE'),
    nav:field(nav?.nav,navReasons,'NAV_NOT_AVAILABLE',stale),
    market_value:field(nav?.market_value,navReasons,'MARKET_VALUE_NOT_AVAILABLE',stale),
    position_cost:field(nav?.position_cost,costReasons,'COST_NOT_AVAILABLE'),
    exposure:field(exp.value,exp.reason?[exp.reason]:[],'EXPOSURE_NOT_AVAILABLE'),
    realized_pnl:field(nav?.realized,costReasons,'REALIZED_NOT_AVAILABLE'),
    unrealized_pnl:field(nav?.unrealized,nav?.nav===null?navReasons:costReasons,'UNREALIZED_NOT_AVAILABLE'),
    fees:field(fees,none('FEES_NOT_AVAILABLE'),'FEES_NOT_AVAILABLE'),
    unbacked_equity:field(facts.unbacked_equity?.value,[],'UNBACKED_EQUITY_NOT_AVAILABLE'),
    flows_total:field(flowsTotal,none('FLOWS_NOT_AVAILABLE'),'FLOWS_NOT_AVAILABLE'),
    money_pnl:p?.money_pnl?copyField(p.money_pnl):field(null,none('MONEY_PNL_NOT_AVAILABLE'),'MONEY_PNL_NOT_AVAILABLE'),
    twr:p?.twr?copyField(p.twr):field(null,none('TWR_NOT_AVAILABLE'),'TWR_NOT_AVAILABLE'),
    mwr:p?.mwr?copyField(p.mwr):field(null,none('MWR_NOT_AVAILABLE'),'MWR_NOT_AVAILABLE'),
    max_drawdown:p?.max_drawdown?copyField(p.max_drawdown):field(null,none('DRAWDOWN_NOT_AVAILABLE'),'DRAWDOWN_NOT_AVAILABLE')
  };
  return {account,exposure_basis:exp.basis,flows_count:p?.flows?p.flows.length:null,symbols:symbolsOf(nav,costReasons,view.replay?.unlotted)};
}

// Named keys only: a field the reader adds later never reaches the client by accident.
function seedsOf(seeds){
  return {method:text(seeds.method),s_cash:integer(seeds.s_cash),s_cost:integer(seeds.s_cost),nav_from:integer(seeds.nav_from),
    has_m1:seeds.has_m1===true,has_m2:seeds.has_m2===true,m1_count:integer(seeds.m1_count),m2_count:integer(seeds.m2_count),last_m1_time:integer(seeds.last_m1_time)};
}
function marketDataOf(market){
  return {checked:market.checked===true,table_present:typeof market.table_present==='boolean'?market.table_present:null,
    instants:integer(market.instants),bars:integer(market.bars),gap:text(market.gap)};
}
// Counts and times only. The global serial ids (max_funding_id, max_snapshot_id, last_fill.signal_id) are dropped: they hint at global volume.
function cutoffsOf(cutoffs,counts){
  const count=key=>integer(Number(counts?.[key]));
  const last=cutoffs.last_fill;
  return {funding_count:count('fundings'),snapshot_count:count('snapshots'),fill_count:integer(cutoffs.fill_count),lot_count:integer(cutoffs.lot_count),
    last_fill:last?{received_at:integer(last.received_at),cumulative_quantity:text(last.cumulative_quantity)}:null,
    market_data_cutoff:integer(cutoffs.market_data_cutoff)};
}

// Named keys only, like the other blocks: a count the reader adds later never reaches the client by accident.
function countsOf(counts,keys){
  const out={};
  for(const key of keys)out[key]=integer(counts?.[key]);
  return out;
}

function viewBody(view,requestTime){
  const gates=view.gates,effects=gates.effects,facts=view.facts;
  const {account,exposure_basis,flows_count,symbols}=accountBody(view);
  const findings=findingsOf(gates.findings);
  return {...header(view,requestTime),
    status:{status:view.status.status,overlays:[...(view.status.overlays||[])],reasons:[...(view.status.reasons||[])]},
    scope:{bot_id:view.scope.bot_id,broker:view.scope.broker,account_id:view.scope.account_id},
    account,
    exposure_basis,
    flows_count,
    symbols,
    reconciliation:{
      state:effects.account_unavailable?'ACCOUNT_UNAVAILABLE':effects.reconciliation_failed?'RECONCILIATION_FAILED':'OK',
      failed_from:integer(effects.failed_from),
      failed_whole_account:effects.failed_whole_account===true,
      ledger_invariant_violated:effects.ledger_invariant_violated===true,
      first_failure:effects.first_failure?{check:text(effects.first_failure.check),code:text(effects.first_failure.code),event_key:text(effects.first_failure.event_key)}:null
    },
    legacy_seeds:seedsOf(view.seeds),
    marker_counts:countsOf(view.marker_counts,['AGREES','DISAGREES','ABSENT']),
    findings,
    information_count:Array.isArray(gates.information)?gates.information.length:null,
    attribution_counts:countsOf(facts.attribution.counts,['BRIDGE','WEBHOOK','ATTRIBUTION_UNKNOWN']),
    slippage_counts:countsOf(facts.slippage.counts,['SLIPPAGE_UNKNOWN','MODELED_SLIPPAGE_ALREADY_INCLUDED']),
    audit_findings:{count:facts.r14.count,unparseable:facts.r14.unparseable.length,expected_missing:facts.r14.expected_missing.length},
    pending:{count:facts.r15.count,codes:[...facts.r15.codes],uncertain:facts.r15.uncertain},
    analytics_comparison:{code:text(facts.analytics.code),targeted_exits:integer(facts.analytics.targeted_exits)},
    market_data:marketDataOf(facts.market_data),
    cutoffs:cutoffsOf(view.cutoffs,view.reader.counts),
    reader:readerBlock(view),
    notice_ids:[...QR2_NOTICE_IDS]};
}

const buildBody=(view,requestTime)=>typeof view.refused==='string'?refusedBody(view,requestTime):viewBody(view,requestTime);

/**
 * Builds the validated response body for one reader view. requestTime is the one clock read of the request. build is a seam for tests only (default buildBody): whatever it returns still goes through validateResponse and the key allowlist. A refused view gives the
 * refusal body. Throws QR2_RESPONSE_INVALID (fixed text, no number) when the object cannot be built or validated.
 */
export function composePerformanceResponse(view,{requestTime,build=buildBody}){
  let body;
  try{
    if(!view||typeof view!=='object'||!Number.isSafeInteger(requestTime))throw new TypeError('view and requestTime are required');
    body=build(view,requestTime);
  }catch{
    throw new Qr2Error('QR2_RESPONSE_INVALID',QR2_ERROR_TEXT.QR2_RESPONSE_INVALID);
  }
  const check=validateResponse(body);
  // validateResponse (qr2-labels.js) checks the label fields only; the key allowlist of the response is held here.
  const unknown=unknownTopLevelKeys(body);
  if(unknown.length)check.ok=false,check.errors=[...check.errors,...unknown.map(key=>({code:'UNKNOWN_TOP_LEVEL_KEY',path:key}))];
  if(!check.ok)throw Object.assign(new Qr2Error('QR2_RESPONSE_INVALID',QR2_ERROR_TEXT.QR2_RESPONSE_INVALID),{validation:check.errors.map(e=>e.code)});
  return body;
}
