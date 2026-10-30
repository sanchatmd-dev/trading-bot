import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {composePerformanceResponse,QR2_FIRST_FAILURE_REASONS} from '../src/portfolio/qr2-response.js';
import {composeOwnerResponse,validateOwnerResponse} from '../src/portfolio/qr2-owner-response.js';
import {validateResponse,numberField} from '../src/portfolio/qr2-labels.js';
import {QR2_STATUS} from '../src/portfolio/qr2-constants.js';
import {replayAccount} from '../src/portfolio/qr2-replay.js';
import {checkR1,effectsOf} from '../src/portfolio/qr2-checks.js';
import {planCoverage,buildCoverageSnapshot} from '../src/portfolio/qr2-coverage-snapshot.js';
import {QR2_COVERAGE_LIMITS} from '../src/portfolio/qr2-coverage-limits.js';
import {QR2_COVERAGE_MARKET} from '../src/portfolio/qr2-coverage.js';

// QR-2 W3 (RC-Q47): the first reconciliation failure carries a closed reason code and nothing else of the finding. The views are hand-built in
// the shape readQr2Account returns, like test/qr2-response.test.js; the reasons come from the real emitters (replayAccount, checkR1).
const T0=1790812800000,DAY=86400000,NOW=T0+3*DAY+5000;
const SECRET='FOREIGN-SECRET-7731';

const nav=(over={})=>({instant:NOW,available:true,cash:'9644',nav:'10016',market_value:'372',position_cost:'360',realized:'4',unrealized:'12',e0_clamp_total:'0',cost_reason:null,
  positions:[{symbol:'BTCUSDT',quantity:'0.006',cost:'360',state:'FRESH',price:'62000',bar_time:NOW-1000,content_hash:'h',age_ms:1000,retrieval:'RETRIEVAL_TIME_UNKNOWN',market_value:'372',unrealized:'12'}],reasons:[],...over});
const performance=(over={})=>({range:{from:T0,to:NOW},nav_from:nav({instant:T0,nav:'10000',cash:'10000',market_value:'0',position_cost:'0',realized:'0',unrealized:'0',positions:[]}),nav_to:nav(),
  flows:[{time:T0+1,amount:'10000'}],identity:{checked:true,ok:true},
  money_pnl:numberField({value:'16'}),twr:numberField({value:'0.0016'}),mwr:numberField({value:'0.0016'}),max_drawdown:numberField({value:'0'}),methods:{}, ...over});
const effects=(over={})=>({refused:null,reconciliation_failed:false,failed_whole_account:false,failed_from:null,first_failure:null,account_unavailable:false,ledger_invariant_spans:[],ledger_invariant_violated:false,split_null:{},split_null_cycles:[],...over});
function view(over={}){
  return {
    reader:{method:'qr2-reader-v1',isolation:'repeatable read',read_only:true,read_ms:12.7,compute_ms:3.2,limits:{ledger_rows:5000,grid_instants:5000,audit_rows:2000,pending_orders:1000},counts:{fundings:'1',journal:'2',fills:'2',lots:'1',snapshots:'3',total:9}},
    scope:{owner_id:'owner-1',bot_id:'bot-1',broker:'binance-global',account_id:'binance-global:primary',currency:'USDT'},
    boundary_record:{record_id:'LOCAL_FIXTURE_E2',evidence:null},
    request:{from:T0,to:NOW,request_time:NOW},coverage_start:T0,first_funding_at:T0+1,
    range:{requested:{from:T0,to:T0+4*DAY},resolved:{from:T0,to:NOW},flags:['RANGE_END_AT_REQUEST_TIME']},
    cutoffs:{max_funding_id:1,max_snapshot_id:3,fill_count:2,last_fill:{received_at:T0+2,signal_id:2,cumulative_quantity:'0.004'},lot_count:1,market_data_cutoff:NOW-1000},
    rows:{fills:[{signal_id:SECRET}]},
    ledger_rule_epochs:['E2'],lot_epochs:['paper-exit-cost-v2'],marker_counts:{AGREES:2,DISAGREES:0,ABSENT:0},
    replay:{events:[{time:T0+2,halted:false,state:{fees:'1.5'}}],final:{}},
    seeds:{method:'legacy-two-seed-v1',s_cash:T0,s_cost:T0,nav_from:T0,has_m1:false,has_m2:false,m1_count:0,m2_count:0,last_m1_time:null},
    gates:{gates:{},findings:[],information:[],effects:effects(),refused:null,row_scope:{refused:null,cross_bot:false,findings:[]}},
    performance:performance(),commit_order:{},
    status:{status:QR2_STATUS.COMPLETE,overlays:[],reasons:[]},
    facts:{attribution:{by_fill:[{event_key:SECRET}],counts:{BRIDGE:0,WEBHOOK:2,ATTRIBUTION_UNKNOWN:0}},slippage:{by_fill:[{event_key:SECRET}],counts:{SLIPPAGE_UNKNOWN:2,MODELED_SLIPPAGE_ALREADY_INCLUDED:0}},
      r14:{rows:[{details:SECRET}],unparseable:[],expected_missing:[],count:0},
      r15:{orders:[{id:SECRET}],count:0,codes:[],uncertain:false,available_cash:'9644',available_cash_reason:null,reserved_notional:'0',reserved_fees:'0'},
      analytics:{code:null,targeted_exits:0},unbacked_equity:{value:'0',identity_ok:true},
      market_data:{checked:true,table_present:true,instants:3,bars:1,gap:null}},
    audit_findings:[],
    ...over
  };
}
const compose=v=>composePerformanceResponse(v,{requestTime:NOW});
const FAILED_STATUS={status:QR2_STATUS.UNAVAILABLE,overlays:[],reasons:['RECONCILIATION_FAILED']};
// A failed view whose gates carry the given findings and the given first failure.
const failedView=(first,findings=[])=>view({status:FAILED_STATUS,performance:null,
  gates:{...view().gates,findings,effects:effects({reconciliation_failed:true,failed_whole_account:first?.check!=='RT',failed_from:first?.check==='RT'?T0+2:null,first_failure:first})}});
const fill=(s,over={})=>({signal_id:s,cumulative_quantity:'1',delta_quantity:'1',price:'100',fee_quote:'0',quote_amount:'100',received_at:T0+s,legacy_float:0,side:'BUY',symbol:'BTCUSDT',trade_id:'T'+s,payload:'{}',...over});
const journalRow=(s,over={})=>({signal_id:s,cumulative_quantity:'1',at:T0+s,cash_delta:'-100',user_id:'owner-1',broker:'binance-global',...over});
const SCOPE={user_id:'owner-1',broker:'binance-global'};
const KEYS=['check','code','event_key','reason'];

test('T1 EPOCH_UNKNOWN first failure carries its reason (real replay, no epoch recorded)',()=>{
  const replay=replayAccount({fills:[fill(1)],epochs:[]});
  const fx=effectsOf({findings:replay.findings,spans:[],replay});
  const body=compose(failedView(fx.first_failure));
  assert.deepEqual(Object.keys(body.reconciliation.first_failure).sort(),KEYS);
  assert.deepEqual(body.reconciliation.first_failure,{check:'RT',code:'LEDGER_RULE_UNREPLAYABLE',event_key:'1:1',reason:'EPOCH_UNKNOWN'});
  assert.equal(body.reconciliation.state,'RECONCILIATION_FAILED');
  assert.equal(validateResponse(body).ok,true);
});

test('T2 each R1 reason passes through (real checkR1 findings)',()=>{
  const wanted={
    FILL_WITHOUT_JOURNAL:checkR1({fills:[fill(1)],journal:[],scope:SCOPE,sCash:0}),
    JOURNAL_WITHOUT_FILL:checkR1({fills:[],journal:[journalRow(1)],scope:SCOPE,sCash:0}),
    DUPLICATE_FILL_KEY:checkR1({fills:[fill(1),fill(1,{trade_id:'T1b',received_at:T0+9})],journal:[journalRow(1)],scope:SCOPE,sCash:0}),
    DUPLICATE_JOURNAL_KEY:checkR1({fills:[fill(1)],journal:[journalRow(1),journalRow(1,{at:T0+9})],scope:SCOPE,sCash:0}),
    FOREIGN_JOURNAL_ROW:checkR1({fills:[fill(1)],journal:[journalRow(1,{user_id:'other-user'})],scope:SCOPE,sCash:0})
  };
  for(const [reason,result] of Object.entries(wanted)){
    const first=result.failures.find(f=>f.reason===reason);
    assert.ok(first,reason+': the real checker emits it');
    const body=compose(failedView(first,result.failures));
    assert.deepEqual(Object.keys(body.reconciliation.first_failure).sort(),KEYS,reason);
    assert.equal(body.reconciliation.first_failure.reason,reason);
    assert.equal(body.reconciliation.first_failure.check,'R1');
    assert.equal(validateResponse(body).ok,true,reason);
  }
  assert.deepEqual(Object.keys(wanted).sort(),QR2_FIRST_FAILURE_REASONS.filter(r=>r!=='EPOCH_UNKNOWN').sort());
  assert.equal(Object.isFrozen(QR2_FIRST_FAILURE_REASONS),true);
  assert.equal(QR2_FIRST_FAILURE_REASONS.length,6);
});

test('T3 a closure failure has a null reason and no extras cross',()=>{
  const first={check:'RT',code:'SELL_EXCEEDS_POSITION',effect:'RECONCILIATION_FAILED',event_key:'3:1.5',expected:'1.5',actual:'2',quantity:'777.5',amount:'888.25'};
  const body=compose(failedView(first,[first]));
  assert.deepEqual(body.reconciliation.first_failure,{check:'RT',code:'SELL_EXCEEDS_POSITION',event_key:'3:1.5',reason:null});
  const block=JSON.stringify(body.reconciliation);
  for(const part of ['"expected"','"actual"','777.5','888.25','"quantity"','"amount"','"effect"'])assert.equal(block.includes(part),false,part);
});

test('T4 an unlisted or malformed reason is null, never free text, and the view still validates',()=>{
  for(const reason of ['NEW_REASON','',7,{},['EPOCH_UNKNOWN'],null,undefined,true,'epoch_unknown',' EPOCH_UNKNOWN','EPOCH_UNKNOWN ','__proto__','constructor','REPLAY_HALTED','<img src=x onerror=1>']){
    const first={check:'RT',code:'LEDGER_RULE_UNREPLAYABLE',effect:'RECONCILIATION_FAILED',event_key:'1:1',reason};
    const body=compose(failedView(first,[first]));
    assert.equal(body.reconciliation.first_failure.reason,null,String(reason));
    assert.deepEqual(Object.keys(body.reconciliation.first_failure).sort(),KEYS);
    assert.equal(validateResponse(body).ok,true,String(reason));
  }
  assert.doesNotThrow(()=>compose(failedView({check:5,code:{},event_key:[],reason:Symbol('x')})));
  assert.deepEqual(compose(failedView({check:5,code:{},event_key:[],reason:'EPOCH_UNKNOWN'})).reconciliation.first_failure,{check:null,code:null,event_key:null,reason:'EPOCH_UNKNOWN'});
});

test('T5 no expected or actual value and no user id crosses with a FOREIGN_JOURNAL_ROW reason',()=>{
  const first={check:'R1',code:'RECONCILIATION_FAILED',effect:'RECONCILIATION_FAILED',reason:'FOREIGN_JOURNAL_ROW',event_key:'4:1',time:T0+4,expected:'u-secret/b',actual:'u-other/b'};
  const body=compose(failedView(first,[first]));
  const text=JSON.stringify(body);
  assert.equal(body.reconciliation.first_failure.reason,'FOREIGN_JOURNAL_ROW');
  assert.equal(text.includes('u-secret'),false);assert.equal(text.includes('u-other'),false);
  const real=checkR1({fills:[fill(1)],journal:[journalRow(1,{user_id:'u-other-real'})],scope:{user_id:'u-secret-real',broker:'binance-global'},sCash:0}).failures.find(f=>f.reason==='FOREIGN_JOURNAL_ROW');
  assert.ok(real,'the real checker emits it');
  const realText=JSON.stringify(compose(failedView(real,[real])));
  assert.equal(realText.includes('u-secret-real'),false);assert.equal(realText.includes('u-other-real'),false);
  assert.equal(realText.includes('"expected"'),false);assert.equal(realText.includes('"actual"'),false);
});

test('T6 numbers stay null with a reason when the reconciliation failed',()=>{
  const first={check:'RT',code:'LEDGER_RULE_UNREPLAYABLE',effect:'RECONCILIATION_FAILED',event_key:'1:1',reason:'EPOCH_UNKNOWN'};
  const body=compose(failedView(first,[first]));
  assert.equal(body.status.status,'UNAVAILABLE');
  for(const key of ['cash','nav','realized_pnl','money_pnl','twr','mwr','max_drawdown']){
    assert.equal(body.account[key].value,null,key);assert.equal(body.account[key].status,'UNAVAILABLE',key);assert.ok(body.account[key].reasons.length>0,key);
  }
});

test('T7 the owner response is unchanged: a member reason never reaches the owner body',()=>{
  const MIN=60000,from=T0,to=T0+DAY,budgets={...QR2_COVERAGE_LIMITS},num=value=>numberField({value});
  const status={status:'COMPLETE',overlays:[],reasons:[]};
  const memberBody={currency:'USDT',status,resolved_range:{from,to},ledger_rule_epochs:['E2'],lot_epochs:['paper-exit-cost-v2'],
    reconciliation:{state:'RECONCILIATION_FAILED',failed_from:null,first_failure:{check:'RT',code:'LEDGER_RULE_UNREPLAYABLE',event_key:'1:1',reason:'EPOCH_UNKNOWN'}},
    account:{nav:num('15'),flows_total:num('0'),fees:num('1'),money_pnl:num('5'),twr:num('0.5')}};
  const accounts=[{input:{botId:'owner',broker:'binance-global'},snapshot:{fills:[{signal_id:1}],journal:[],fundings:[{id:1}],lots:[]},
    view:{performance:{nav_from:{nav:'10',positions:[],reasons:[]},nav_to:{nav:'15',positions:[],reasons:[]}},reader:{compute_ms:1},audit_findings:[]},body:memberBody}];
  const coverageAccounts=[{bot_id:'owner',broker:'binance-global',market:{...QR2_COVERAGE_MARKET},resolved_range:{from,to}}];
  const plan=planCoverage({accounts:coverageAccounts,budgets});
  const facts=plan.unions.map(union=>({state:'COMPLETE',timestamps:Array.from({length:(union.window.to-union.window.from)/MIN},(_,i)=>union.window.from+(i+1)*MIN)}));
  const snapshot={kind:'owner',currency:'USDT',ownerBots:[{bot_id:'owner',created_at:from-1}],
    declarations:[{version:1,capital_model:'INDEPENDENT_ACCOUNTS',bot_set:['owner'],effective_from:from-DAY}],accounts,
    range:{requested:{from,to},resolved:{from,to},flags:[]},counts:{accounts:1,bots:1,declarations:1,ledger_rows:2,grid_instants:2,audit_rows:0,pending_orders:0},
    coverage:buildCoverageSnapshot({accounts:coverageAccounts,budgets,facts})};
  const input={kind:'owner',currency:'USDT',requestTime:to,coverage_context:{accounts:coverageAccounts,budgets}};
  const {body}=composeOwnerResponse(snapshot,input,{compute:(_,i)=>accounts.find(a=>a.input===i).view,compose:v=>accounts.find(a=>a.view===v).body});
  assert.equal(validateOwnerResponse(body),true);
  const text=JSON.stringify(body);
  for(const part of ['EPOCH_UNKNOWN','first_failure','LEDGER_RULE_UNREPLAYABLE'])assert.equal(text.includes(part),false,part);
  assert.deepEqual(body.total.members[0].reasons,['RECONCILIATION_FAILED']);
});

test('T8 the closed list equals the reasons the real emitters can put on a reconciliation failure',()=>{
  const read=name=>fs.readFileSync(new URL('../src/portfolio/'+name,import.meta.url),'utf8');
  const found=new Set();
  for(const name of ['qr2-checks.js','qr2-replay.js'])for(const [,reason] of read(name).matchAll(/reason:'([A-Z][A-Z_]+)'/g))found.add(reason);
  // Reasons that sit on a NOT_RUN gate, an ORDER_UNPROVEN result or a row-scope refusal, never on a RECONCILIATION_FAILED finding.
  const notReconciliation=['REPLAY_HALTED','S_COST_UNAVAILABLE','NO_SNAPSHOT','SNAPSHOT_REASON_ORDER','EQUAL_EVENT_TIME','SCOPE_FIELD_MISSING'];
  for(const reason of notReconciliation)assert.ok(found.has(reason),reason+' is no longer emitted: update this list');
  const failureReasons=[...found].filter(reason=>!notReconciliation.includes(reason)).sort();
  assert.deepEqual(failureReasons,[...QR2_FIRST_FAILURE_REASONS].sort(),'a new emitter reason needs a ruling: list it in QR2_FIRST_FAILURE_REASONS or in notReconciliation');
});

test('T9 no failure keeps first_failure null and reports an OK reconciliation',()=>{
  const body=compose(view());
  assert.equal(body.reconciliation.first_failure,null);
  assert.equal(body.reconciliation.state,'OK');
  assert.equal(compose(failedView(null)).reconciliation.first_failure,null);
});
