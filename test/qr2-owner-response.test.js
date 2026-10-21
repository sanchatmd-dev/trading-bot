import test from 'node:test';
import assert from 'node:assert/strict';
import {composeOwnerResponse,validateOwnerResponse,ownerAccountInput,endpointPriceState} from '../src/portfolio/qr2-owner-response.js';
import {numberField} from '../src/portfolio/qr2-labels.js';
const from=1790812800000,to=from+86400000;
const num=value=>numberField({value});
const status={status:'COMPLETE',overlays:[],reasons:[]};
function fixture({currency='USDT',brokers=['binance-global'],declarations=true}={}){
  const accounts=brokers.map((broker,i)=>({input:{botId:'owner',broker},snapshot:{fills:[{signal_id:i+1}],journal:[],fundings:[{id:i+1}],lots:[]},
    view:{performance:{nav_from:{nav:'10',positions:[],reasons:[]},nav_to:{nav:'15',positions:[],reasons:[]}},reader:{compute_ms:1},audit_findings:[]},
    body:{currency,status,resolved_range:{from,to},reconciliation:{state:'OK',failed_from:null},ledger_rule_epochs:['E2'],lot_epochs:['paper-exit-cost-v2'],account:{nav:num('15'),flows_total:num('0'),fees:num('1'),money_pnl:num('5'),twr:num('0.5')}}}));
  const snapshot={kind:'owner',currency,ownerBots:[{bot_id:'owner',created_at:from-1}],declarations:declarations?[{version:1,capital_model:'INDEPENDENT_ACCOUNTS',bot_set:['owner'],effective_from:from-86400000}]:[],accounts,
    range:{requested:{from,to},resolved:{from,to},flags:[]},counts:{accounts:accounts.length,bots:1,declarations:1,ledger_rows:2,grid_instants:2,audit_rows:0,pending_orders:0}};
  const input={kind:'owner',currency,requestTime:to};
  const options={compute:(_,input)=>accounts.find(a=>a.input===input).view,compose:view=>accounts.find(a=>a.view===view).body};
  return {snapshot,input,options};
}
const run=f=>composeOwnerResponse(f.snapshot,f.input,f.options);

test('owner sums exact boundary values, retains currency, returns null owner returns and drops raw IDs',()=>{
  const f=fixture(),{body}=run(f);
  assert.equal(body.total.nav_from.value,'10');assert.equal(body.total.money_pnl.value,'5');assert.equal(body.total.fees.value,'1');
  assert.equal(body.total.twr.value,null);assert.equal(body.total.mwr.value,null);assert.equal(body.declaration_version,1);
  assert.equal(body.scope.kind,'OWNER');assert.equal(validateOwnerResponse(body),true);
  for(const key of ['keys','fills','snapshot','replay','owner_id'])assert.equal(JSON.stringify(body).includes('"'+key+'"'),false);
});
test('THB includes all three broker accounts without FX',()=>{
  const {body}=run(fixture({currency:'THB',brokers:['binance-th','innovestx','settrade']}));
  assert.equal(body.currency,'THB');assert.equal(body.fx,'NONE');assert.equal(body.accounts.length,3);assert.equal(body.total.nav_to.value,'45');
});
test('missing declaration keeps summaries; duplicate keys still refuse counts only',()=>{
  const f=fixture({declarations:false});
  assert.equal(run(f).body.allocation.reason,'CAPITAL_MODEL_NOT_DECLARED');
  const g=fixture({currency:'THB',brokers:['binance-th','settrade'],declarations:false});
  g.snapshot.accounts[1].snapshot.fills=[{signal_id:1}];
  const {body}=run(g);assert.equal(body.code,'QR2_CROSS_BOT_ROW');assert.equal(body.accounts,undefined);assert.equal(body.total,undefined);
});
test('missing owner range has unavailable null values, never a synthetic zero',()=>{
  const f=fixture();f.snapshot.range.resolved=null;f.snapshot.range.reasons=['RANGE_EMPTY_AT_REQUEST_TIME'];
  const {body}=run(f);assert.equal(body.status.status,'UNAVAILABLE');assert.equal(body.total.nav_to.value,null);
});
test('adapter preserves unavailable NAV and stale pricing; cash-only endpoint needs no price',()=>{
  const f=fixture(),m=f.snapshot.accounts[0];m.view.performance.nav_from=null;
  const mapped=ownerAccountInput(m.snapshot,m.input,m.view,m.body);
  assert.equal(mapped.nav_from.value,null);assert.equal(mapped.price_state_from,'PRICE_UNAVAILABLE');
  assert.equal(endpointPriceState({nav:'1',positions:[]}),'NO_POSITION');
  assert.equal(endpointPriceState({nav:'1',positions:[{state:'STALE'}]}),'STALE');
});
test('strict schema rejects nested secrets, raw keys and corrupt number fields',()=>{
  const {body}=run(fixture());
  for(const mutate of [b=>{b.total.keys=['SECRET'];},b=>{b.accounts[0].fees.raw='SECRET';},b=>{b.total.nav_to.value=15;},b=>{b.scope.owner_id='SECRET';},b=>{b.price_policy.sql='SECRET';},b=>{b.lot_method.private='SECRET';}]){
    const copy=structuredClone(body);mutate(copy);assert.equal(validateOwnerResponse(copy),false);
  }
});


test('owner header reports earliest known member funding and rejects invalid scalar bounds',()=>{
  const f=fixture({currency:'THB',brokers:['binance-th','innovestx','settrade']});
  f.snapshot.accounts[0].body.first_funding_at=from+10;
  f.snapshot.accounts[1].body.first_funding_at=null;
  f.snapshot.accounts[2].body.first_funding_at=from+1;
  const {body}=run(f);assert.equal(body.first_funding_at,from+1);
  for(const mutate of [b=>{b.total.member_count=-1;},b=>{b.total.member_count=21;},b=>{b.total.members=Array(21).fill({bot_id:'owner',broker:'binance-th',fields:[],reasons:[]});},b=>{b.first_funding_at=-1;},b=>{b.allocation.effective_from=-86400000;},b=>{b.price_policy.fresh_ms=1;}]){
    const copy=structuredClone(body);mutate(copy);assert.equal(validateOwnerResponse(copy),false);
  }
});
