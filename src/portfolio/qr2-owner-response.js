import {computeQr2View} from '../postgres/qr2-reader.js';
import {aggregateOwnerTotal,ownerAccountScopeRefusal,ALLOCATION_SUM_FIELDS} from './qr2-allocation.js';
import {composePerformanceResponse,QR2_CONTRACT_ID} from './qr2-response.js';
import {buildHeader,numberField,validateResponse,auditDedupKey} from './qr2-labels.js';
import {QR2_BASIS,QR2_METHODS,QR2_STATUS,QR2_PRICE_POLICY,Qr2Error} from './qr2-constants.js';
import {projectPublicCoverage,validateOwnerCoverageShape} from './qr2-coverage-public.js';

const invalid=()=>{throw new Qr2Error('QR2_RESPONSE_INVALID');};
const textList=x=>Array.isArray(x)&&x.every(v=>typeof v==='string');
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,names)=>plain(x)&&Object.keys(x).every(k=>names.includes(k));
const status=x=>keys(x,['status','overlays','reasons'])&&Object.values(QR2_STATUS).includes(x.status)&&textList(x.overlays)&&textList(x.reasons);
const field=x=>keys(x,['value','status','reasons'])&&['COMPLETE','PARTIAL','UNAVAILABLE'].includes(x.status)&&textList(x.reasons)&&
  (x.value===null?x.reasons.length>0&&x.status==='UNAVAILABLE':typeof x.value==='string'&&/^-?\d+(?:\.\d+)?$/.test(x.value)&&x.status!=='UNAVAILABLE');
const fields=[...ALLOCATION_SUM_FIELDS,'twr','mwr'];
const headers=['valuation_method','return_method','lot_method','legacy_method','order_method','period_method','drawdown_grid','rounding','price_policy','contract_id','declaration_version','ledger_rule_epochs','lot_epochs','fee_source','alloc_method','range_flags','basis','execution','historical_simulation','qualified_evidence','fx','event_time_basis','requested_range','resolved_range','as_of','first_funding_at','currency'];
const range=x=>x===null||(keys(x,['from','to'])&&Number.isSafeInteger(x.from)&&Number.isSafeInteger(x.to)&&x.from<x.to);
// market_coverage is optional in this context-free validator until O7 updates the UI fixtures; the composer and the worker enforce presence.
// When present it must be absent for a null resolved range, pass the closed shape check and map exactly the non-NO_ACCOUNT account rows.
function ownerCoverageOk(body){
  if(!Object.hasOwn(body,'market_coverage'))return true;
  if(body.resolved_range===null||!validateOwnerCoverageShape(body.market_coverage).ok)return false;
  const pair=(botId,broker)=>JSON.stringify([botId,broker]);
  const covered=new Set(body.market_coverage.accounts.map(a=>pair(a.bot_id,a.broker)));
  const rows=new Set(body.accounts.filter(a=>a.account!=='NO_ACCOUNT').map(a=>pair(a.bot_id,a.broker)));
  return covered.size===rows.size&&[...covered].every(p=>rows.has(p));
}
// Closed recursive schema: summaries only, never snapshots, event identities or raw member bodies.
export function validateOwnerResponse(body){
  if(!validateResponse(body).ok||!keys(body,[...headers,'scope','status','code','counts','allocation','total','accounts','market_coverage']))return false;
  if(!keys(body.scope,['kind','currency'])||body.scope.kind!=='OWNER'||body.scope.currency!==body.currency||!['USDT','THB'].includes(body.currency)||!status(body.status))return false;
  if(!range(body.requested_range)||!range(body.resolved_range)||!keys(body.price_policy,['fresh_ms','carry_ms'])||body.price_policy.fresh_ms!==QR2_PRICE_POLICY.fresh_ms||body.price_policy.carry_ms!==QR2_PRICE_POLICY.carry_ms)return false;
  if(!Number.isSafeInteger(body.as_of)||body.as_of<0||!(body.first_funding_at===null||Number.isSafeInteger(body.first_funding_at)&&body.first_funding_at>=0)||
    !(body.declaration_version===null||Number.isSafeInteger(body.declaration_version)&&body.declaration_version>0&&body.declaration_version<=1000)||body.contract_id!==QR2_CONTRACT_ID)return false;
  if(!textList(body.ledger_rule_epochs)||!textList(body.lot_epochs)||!textList(body.range_flags))return false;
  if(!keys(body.counts,['ledger_rows','grid_instants','audit_rows','pending_orders','accounts','bots','declarations','accounts_refused','signals','journal','fundings','positions','fields_checked','fields_mismatched'])||!Object.values(body.counts).every(v=>Number.isSafeInteger(v)&&v>=0))return false;
  const ceilings={ledger_rows:5000,grid_instants:5000,audit_rows:2000,pending_orders:1000,accounts:20,bots:5,declarations:1000,accounts_refused:20,signals:5000,journal:5000,fundings:5000,positions:5000,fields_checked:7,fields_mismatched:7};
  if(Object.entries(body.counts).some(([name,value])=>value>ceilings[name]))return false;
  // lot_method is the sole structured method constant; exact equality prevents arbitrary nested data.
  for(const name of ['valuation_method','return_method','lot_method','legacy_method','order_method','period_method','drawdown_grid','rounding'])if(JSON.stringify(body[name])!==JSON.stringify(QR2_METHODS[name]))return false;
  if(body.status.status==='REFUSED')return typeof body.code==='string'&&body.allocation===undefined&&body.total===undefined&&body.accounts===undefined&&!Object.hasOwn(body,'market_coverage');
  if(body.code!==undefined||!keys(body.allocation,['capital_model','version','reason','effective_from'])||!keys(body.total,['label','notice',...fields,'member_count','members'])||!fields.every(f=>field(body.total[f]))||!Array.isArray(body.accounts)||body.accounts.length>20)return false;
  const allocation=body.allocation;
  if(![null,'INDEPENDENT_ACCOUNTS','SHARED_HYPOTHETICAL'].includes(allocation.capital_model)||
    !(allocation.version===null||Number.isSafeInteger(allocation.version)&&allocation.version>0&&allocation.version<=1000)||
    !(allocation.effective_from===null||Number.isSafeInteger(allocation.effective_from)&&allocation.effective_from>=0&&allocation.effective_from%86400000===0)||
    !(allocation.reason===null||typeof allocation.reason==='string')||allocation.version!==body.declaration_version||
    ![null,'SUM_OF_INDEPENDENT_PAPER_ACCOUNTS'].includes(body.total.label)||![null,'NOT_AN_OWNER_PORTFOLIO'].includes(body.total.notice))return false;
  if(body.total.twr.value!==null||body.total.mwr.value!==null||!Number.isSafeInteger(body.total.member_count)||body.total.member_count<0||body.total.member_count>20||!Array.isArray(body.total.members)||body.total.members.length>20)return false;
  if(!body.total.members.every(m=>keys(m,['bot_id','broker','fields','reasons'])&&typeof m.bot_id==='string'&&typeof m.broker==='string'&&textList(m.fields)&&textList(m.reasons)))return false;
  return body.accounts.every(a=>keys(a,['bot_id','broker','account','status',...ALLOCATION_SUM_FIELDS,'twr'])&&typeof a.bot_id==='string'&&
    (a.account==='NO_ACCOUNT'?Object.keys(a).length===2:typeof a.broker==='string'&&status(a.status)&&[...ALLOCATION_SUM_FIELDS,'twr'].every(f=>field(a[f]))))&&ownerCoverageOk(body);
}

export function endpointPriceState(nav){
  if(!nav||nav.available===false||nav.nav===null||nav.nav===undefined)return 'PRICE_UNAVAILABLE';
  const states=(nav.positions||[]).map(p=>p.state);
  const failed=states.find(s=>!['FRESH','STALE','NO_POSITION'].includes(s));
  return failed??(states.includes('STALE')?'STALE':states.includes('FRESH')?'FRESH':'NO_POSITION');
}
export function ownerAccountInput(snapshot,input,view,body){
  const base={bot_id:input.botId,broker:input.broker,currency:body.currency,status:body.status,code:body.code??null};
  if(body.status.status==='REFUSED')return base;
  const endpoint=view.performance?.nav_from;
  const nav=endpoint?.available===false?null:endpoint;
  return {...base,range:body.resolved_range,reconciliation:body.reconciliation,
    nav_from:numberField({value:nav?.nav??null,reasons:nav?.nav==null?(nav?.reasons?.length?nav.reasons:['NAV_NOT_AVAILABLE']):(nav.reasons||[]).filter(r=>r==='PRICE_STALE')}),
    nav_to:body.account.nav,flows_total:body.account.flows_total,fees:body.account.fees,money_pnl:body.account.money_pnl,twr:body.account.twr,
    price_state_from:endpointPriceState(nav),price_state_to:endpointPriceState(view.performance?.nav_to),
    keys:{signals:[...new Set(snapshot.fills.map(f=>String(f.signal_id)))],journal:snapshot.journal.map(j=>({signal_id:String(j.signal_id),cumulative_quantity:j.cumulative_quantity})),
      fundings:snapshot.fundings.map(f=>String(f.id)),positions:snapshot.lots.map(l=>String(l.position_id))}};
}

/**
 * coverage: the market_coverage envelope object. When absent, it is projected here from snapshot.coverage and input.coverage_context,
 * so a direct call fails closed on a missing or corrupt registry. The worker always passes it, so the worker path validates the registry once.
 * The envelope enters only a non-REFUSED body with a non-null resolved_range. Member bodies never carry coverage.
 */
export function composeOwnerResponse(snapshot,input,{compute=computeQr2View,compose=composePerformanceResponse,coverage}={}){
  const marketCoverage=coverage===undefined?projectPublicCoverage(snapshot.coverage,input.coverage_context).owner.market_coverage:coverage;
  const members=snapshot.accounts.map(a=>{const view=compute(a.snapshot,a.input);return {...a,view,body:compose(view,{requestTime:input.requestTime})};});
  const accounts=members.map(m=>ownerAccountInput(m.snapshot,m.input,m.view,m.body));
  let result;
  if(snapshot.range.resolved)result=aggregateOwnerTotal({currency:input.currency,range:snapshot.range.resolved,declarations:snapshot.declarations,owner_bots:snapshot.ownerBots,accounts});
  else{
    const reason=snapshot.range.reasons?.[0]??'RANGE_UNRESOLVED';
    result={allocation:{capital_model:null,version:null,reason,effective_from:null},total:{label:null,notice:null,...Object.fromEntries(fields.map(f=>[f,numberField({reasons:[reason]})])),member_count:0,members:[]},accounts:[],status:{status:'UNAVAILABLE',overlays:[],reasons:[reason]}};
    result=ownerAccountScopeRefusal(accounts,input.currency)||result;
  }
  const methods=Object.fromEntries(['valuation_method','return_method','lot_method','legacy_method','order_method','period_method','drawdown_grid','rounding'].map(k=>[k,QR2_METHODS[k]]));
  const union=name=>[...new Set(members.flatMap(m=>m.body[name]))].sort();
  const fundingTimes=members.map(m=>m.body.first_funding_at).filter(t=>Number.isSafeInteger(t)&&t>=0);
  const header=buildHeader({basis:QR2_BASIS,requested_range:snapshot.range.requested,resolved_range:snapshot.range.resolved,as_of:input.requestTime,first_funding_at:fundingTimes.length?Math.min(...fundingTimes):null,currency:input.currency,methods,contract_id:QR2_CONTRACT_ID,declaration_version:result.allocation?.version??null,ledger_rule_epochs:union('ledger_rule_epochs'),lot_epochs:union('lot_epochs'),range_flags:snapshot.range.flags});
  const {refused,...safe}=result;
  const body={...header,scope:{kind:'OWNER',currency:input.currency},...safe,counts:{...snapshot.counts,...(result.counts||{})}};
  if(body.status?.status!==QR2_STATUS.REFUSED&&body.resolved_range!==null)body.market_coverage=marketCoverage;
  if(!validateOwnerResponse(body))invalid();
  // Same opaque dedup identity and 20 distinct incidents as the existing audit writer, now across the whole owner job.
  const incidents=new Map();
  auditSelection: for(const m of members)for(const finding of m.view.audit_findings||[]){
    if(!finding.check)continue;
    const key=auditDedupKey({method_id:'qr2-reader-v1',bot_id:m.input.botId,broker:m.input.broker,check_id:finding.check,first_row_key:finding.event_key??finding.position_id??finding.symbol??''});
    if(!incidents.has(key))incidents.set(key,{...finding,botId:m.input.botId,broker:m.input.broker});
    if(incidents.size===20)break auditSelection;
  }
  const auditFindings=[...incidents.values()].slice(0,20);
  return {body,auditFindings,compute_ms:members.reduce((n,m)=>n+(m.view.reader?.compute_ms||0),0)};
}
