import test from 'node:test';
import assert from 'node:assert/strict';
import {composeOwnerResponse,validateOwnerResponse,ownerAccountInput,endpointPriceState} from '../src/portfolio/qr2-owner-response.js';
import {numberField} from '../src/portfolio/qr2-labels.js';
import {buildCoverageSnapshot,planCoverage} from '../src/portfolio/qr2-coverage-snapshot.js';
import {QR2_COVERAGE_LIMITS} from '../src/portfolio/qr2-coverage-limits.js';
import {QR2_COVERAGE_MARKET} from '../src/portfolio/qr2-coverage.js';
import {projectPublicCoverage,validateOwnerCoverageShape} from '../src/portfolio/qr2-coverage-public.js';
const from=1790812800000,to=from+86400000;
const MIN=60000;
const budgets={...QR2_COVERAGE_LIMITS};
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
  const f={snapshot,input,options};
  rebuild(f);
  return f;
}
// Coverage registry for the fixture's members and the current owner range. Every binance-global bar is stored except the minute at index 5.
const gapFacts=plan=>plan.unions.map(union=>({state:'COMPLETE',timestamps:Array.from({length:(union.window.to-union.window.from)/MIN},(_,i)=>union.window.from+(i+1)*MIN).filter(time=>time!==union.window.from+5*MIN)}));
function coverageAccounts(f){
  const range=f.snapshot.range.resolved;
  return f.snapshot.accounts.map(a=>({bot_id:a.input.botId,broker:a.input.broker,market:a.input.broker==='binance-global'?{...QR2_COVERAGE_MARKET}:null,resolved_range:range}));
}
function rebuild(f,factsOf=gapFacts){
  const accounts=coverageAccounts(f),plan=planCoverage({accounts,budgets});
  f.snapshot.coverage=buildCoverageSnapshot({accounts,budgets,facts:factsOf(plan)});
  f.input.coverage_context={accounts,budgets};
  return f;
}
const run=f=>composeOwnerResponse(f.snapshot,f.input,f.options);
const pairs=list=>list.map(a=>[a.bot_id,a.broker]);

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


const projectOf=f=>projectPublicCoverage(f.snapshot.coverage,f.input.coverage_context);
const member=(f,index,patch)=>{Object.assign(f.snapshot.accounts[index].body,patch);return f;};
const unavailable=(f,index=0)=>member(f,index,{status:{status:'UNAVAILABLE',overlays:[],reasons:['PRICE_UNAVAILABLE']}});
const partial=(f,index=0)=>member(f,index,{status:{status:'PARTIAL',overlays:[],reasons:['X_PARTIAL']}});

test('market_coverage is present on COMPLETE, PARTIAL, UNAVAILABLE and undeclared owner bodies with a resolved range',()=>{
  const seen=new Map();
  for(const [name,f] of [['COMPLETE',fixture()],['PARTIAL',partial(fixture())],['UNAVAILABLE',unavailable(fixture())],['undeclared',fixture({declarations:false})]]){
    const {body}=run(f);
    seen.set(name,body.status.status);
    assert.notEqual(body.resolved_range,null,name);
    assert.deepEqual(body.market_coverage,projectOf(f).owner.market_coverage,name+': the envelope is the projection');
    assert.equal(validateOwnerResponse(body),true,name);
    assert.deepEqual(Object.keys(body.market_coverage),['version','entries','accounts']);
  }
  assert.equal(seen.get('COMPLETE'),'COMPLETE');assert.equal(seen.get('PARTIAL'),'PARTIAL');assert.equal(seen.get('UNAVAILABLE'),'UNAVAILABLE');assert.equal(seen.get('undeclared'),'UNAVAILABLE');
});

test('market_coverage carries the registry intervals and members hold no coverage object',()=>{
  const {body}=run(fixture());
  const [entry]=body.market_coverage.entries;
  assert.equal(entry.id,'coverage:0');assert.equal(entry.coverage.state,'COMPLETE');assert.equal(entry.coverage.interval_count,1);
  assert.deepEqual(entry.coverage.intervals,[{from:from+4*MIN,to:from+5*MIN,missing_minutes:1}]);
  assert.deepEqual(body.market_coverage.accounts,[{bot_id:'owner',broker:'binance-global',coverage_ids:['coverage:0']}]);
  for(const row of body.accounts)assert.equal(Object.hasOwn(row,'coverage')||Object.hasOwn(row,'coverage_ids')||Object.hasOwn(row,'market_data'),false);
});

test('market_coverage is absent from a REFUSED owner body and the validator rejects a REFUSED body that carries it',()=>{
  const g=fixture({currency:'THB',brokers:['binance-th','settrade'],declarations:false});
  g.snapshot.accounts[1].snapshot.fills=[{signal_id:1}];
  const {body}=run(g);
  assert.equal(body.status.status,'REFUSED');assert.equal(Object.hasOwn(body,'market_coverage'),false);assert.equal(validateOwnerResponse(body),true);
  const other=run(fixture({currency:'THB',brokers:['binance-th','settrade']})).body;
  assert.equal(validateOwnerResponse({...body,market_coverage:structuredClone(other.market_coverage)}),false);
});

test('market_coverage is absent when the owner range is null, including with admitted members, and the validator rejects it there',()=>{
  const f=fixture();f.snapshot.range.resolved=null;f.snapshot.range.reasons=['RANGE_EMPTY_AT_REQUEST_TIME'];rebuild(f);
  assert.equal(f.snapshot.accounts.length,1);
  const {body}=run(f);
  assert.equal(body.resolved_range,null);assert.equal(Object.hasOwn(body,'market_coverage'),false);assert.equal(validateOwnerResponse(body),true);
  const envelope=run(fixture()).body.market_coverage;
  assert.equal(validateOwnerResponse({...body,market_coverage:structuredClone(envelope)}),false);
  // The projection still runs for a null range: a corrupt registry fails the request.
  const bad=fixture();bad.snapshot.range.resolved=null;bad.snapshot.coverage=null;
  assert.throws(()=>run(bad));
});

test('market_coverage accounts reconcile by set with the non-NO_ACCOUNT owner rows',()=>{
  const f=fixture({currency:'THB',brokers:['binance-th','innovestx']});
  f.snapshot.ownerBots.push({bot_id:'idle',created_at:from-1});f.snapshot.declarations[0].bot_set=['idle','owner'];rebuild(f);
  const {body}=run(f);
  assert.ok(body.accounts.some(a=>a.account==='NO_ACCOUNT'),'the fixture has a NO_ACCOUNT row');
  assert.equal(validateOwnerResponse(body),true);
  assert.deepEqual(pairs(body.market_coverage.accounts),[['owner','binance-th'],['owner','innovestx']]);
  const mutations=[
    b=>{b.market_coverage.accounts.pop();},
    b=>{b.market_coverage.accounts.push({bot_id:'owner',broker:'settrade',coverage_ids:['coverage:0']});},
    b=>{b.market_coverage.accounts.push({bot_id:'zzz',broker:'binance-th',coverage_ids:['coverage:0']});},
    b=>{b.market_coverage.accounts.unshift({bot_id:'idle',broker:'binance-th',coverage_ids:['coverage:0']});},
    b=>{b.accounts=b.accounts.filter(a=>a.broker!=='innovestx');}
  ];
  for(const mutate of mutations){const copy=structuredClone(body);mutate(copy);assert.equal(validateOwnerResponse(copy),false);}
});

test('the order of non-NO_ACCOUNT owner rows equals the order of market_coverage accounts because both use the code-unit comparator',()=>{
  for(const f of [fixture(),fixture({currency:'THB',brokers:['settrade','binance-th','innovestx']}),(()=>{const g=fixture({currency:'THB',brokers:['innovestx','binance-th']});g.snapshot.ownerBots.push({bot_id:'idle',created_at:from-1});g.snapshot.declarations[0].bot_set=['idle','owner'];return rebuild(g);})()]){
    const {body}=run(f);
    assert.deepEqual(pairs(body.accounts.filter(a=>a.account!=='NO_ACCOUNT')),pairs(body.market_coverage.accounts));
  }
});

test('market_coverage with zero accounts is an empty closed envelope',()=>{
  const f=fixture();f.snapshot.accounts.length=0;rebuild(f);
  const {body}=run(f);
  assert.deepEqual(body.market_coverage,{version:'qr2-owner-bar-coverage-v1',entries:[],accounts:[]});
  assert.equal(validateOwnerResponse(body),true);
});

test('validateOwnerResponse rejects duplicate, orphan, unresolved, out-of-order and mismatched market_coverage',()=>{
  const {body}=run(fixture({currency:'THB',brokers:['binance-th','innovestx']}));
  const first=structuredClone(body.market_coverage.entries[0]);
  const mutations=[
    b=>{b.market_coverage.entries.push({id:'coverage:1',coverage:structuredClone(first.coverage)});},
    b=>{b.market_coverage.accounts[0].coverage_ids=['coverage:1'];},
    b=>{b.market_coverage.accounts[0].coverage_ids=['coverage:0','coverage:0'];},
    b=>{b.market_coverage.accounts.reverse();},
    b=>{b.market_coverage.accounts.push(structuredClone(b.market_coverage.accounts[0]));},
    b=>{b.market_coverage.accounts[0].broker='binance-global';},
    b=>{b.market_coverage.entries[0].id='coverage:7';},
    b=>{b.market_coverage.version='qr2-owner-bar-coverage-v0';},
    b=>{b.market_coverage.extra=1;},
    b=>{b.market_coverage.entries[0].coverage.state='COMPLETE';},
    b=>{b.market_coverage=null;},
    b=>{b.market_coverage=[];}
  ];
  for(const mutate of mutations){const copy=structuredClone(body);mutate(copy);assert.equal(validateOwnerResponse(copy),false);}
  assert.equal(validateOwnerCoverageShape(body.market_coverage).ok,true);
});

test('counts schema is unchanged and carries no coverage counter',()=>{
  const {body}=run(fixture());
  assert.deepEqual(Object.keys(body.counts).sort(),['accounts','audit_rows','bots','declarations','grid_instants','ledger_rows','pending_orders'].sort());
  assert.equal(JSON.stringify(body.counts).includes('overage'),false);
});

test('a direct composer call without the coverage option equals a call with the precomputed envelope',()=>{
  const f=fixture(),direct=run(f),given=composeOwnerResponse(f.snapshot,f.input,{...f.options,coverage:projectOf(f).owner.market_coverage});
  assert.deepEqual(direct.body,given.body);
  assert.equal(JSON.stringify(direct.body),JSON.stringify(given.body));
});

test('a direct composer call with a missing or corrupt registry throws and builds no body',()=>{
  const missing=fixture();delete missing.snapshot.coverage;assert.throws(()=>run(missing));
  const noContext=fixture();delete noContext.input.coverage_context;assert.throws(()=>run(noContext));
  const corrupt=fixture();corrupt.snapshot.coverage.windows[0].missing_minutes+=1;assert.throws(()=>run(corrupt));
});

test('a refused non-propagated member keeps its mapping in market_coverage',()=>{
  const f=fixture({currency:'THB',brokers:['binance-th','innovestx']});
  member(f,1,{status:{status:'REFUSED',overlays:[],reasons:['QR2_LEDGER_INVALID']},code:'QR2_LEDGER_INVALID'});
  const {body}=run(f);
  assert.notEqual(body.status.status,'REFUSED');
  assert.deepEqual(pairs(body.market_coverage.accounts),[['owner','binance-th'],['owner','innovestx']]);
  assert.equal(validateOwnerResponse(body),true);
});

test('the composed envelope shares entries by reference with the projection and the body is the only container',()=>{
  const f=fixture(),projection=projectOf(f),{body}=composeOwnerResponse(f.snapshot,f.input,{...f.options,coverage:projection.owner.market_coverage});
  assert.equal(body.market_coverage,projection.owner.market_coverage);
  assert.equal(body.market_coverage.entries[0].coverage,projection.accounts[0].market_data.coverage);
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
