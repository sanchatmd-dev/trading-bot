import test from 'node:test';
import assert from 'node:assert/strict';
import {composePerformanceResponse,unknownTopLevelKeys,refusalAnswer,statusOfRefusal,statusOfAdmission,QR2_CONTRACT_ID,QR2_MAX_FINDINGS,QR2_NOTICE_IDS,QR2_ERROR_TEXT} from '../src/portfolio/qr2-response.js';
import {validateResponse,numberField} from '../src/portfolio/qr2-labels.js';
import {QR2_METHODS,QR2_STATUS} from '../src/portfolio/qr2-constants.js';

// QR-2 S3a composer (contract 8.1, RC-Q32; design tests R1 to R4). Pure: no database. The views below are hand-built in the exact shape
// readQr2Account returns (qr2-reader.js), with literal hand values; the real reader output is composed in test/postgres/qr2-route-http.test.mjs.
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
const refusedView=(code='QR2_CROSS_BOT_ROW')=>({
  reader:view().reader,scope:view().scope,boundary_record:{record_id:'X',evidence:null},request:{from:T0,to:NOW,request_time:NOW},coverage_start:T0,first_funding_at:null,
  range:view().range,cutoffs:null,rows:null,refused:code,status:{status:QR2_STATUS.REFUSED,overlays:[],reasons:[code]},
  gates:{refused:code,findings:[],row_scope:{refused:code,cross_bot:true,findings:[{check:'RX',code,reason:'FOREIGN_USER',table:'fills',count:2,foreign_user_id:SECRET,amount:'999999'}]}},
  audit_findings:[{check:'RX',code,event_key:'row:fills:abc'}]
});
const compose=v=>composePerformanceResponse(v,{requestTime:NOW});
const numbersOf=body=>{
  const found=[];
  (function walk(value,path){
    if(Array.isArray(value))return value.forEach((x,i)=>walk(x,path+'['+i+']'));
    if(value&&typeof value==='object'){
      if('value' in value&&'status' in value&&'reasons' in value)found.push([path,value]);
      for(const [k,v] of Object.entries(value))walk(v,path?path+'.'+k:k);
    }
  })(body,'');
  return found;
};
const textOf=body=>JSON.stringify(body);

test('R1 header: COMPLETE, PARTIAL, UNAVAILABLE and REFUSED views carry the full label header and pass validateResponse',()=>{
  const views={
    COMPLETE:view(),
    PARTIAL:view({status:{status:QR2_STATUS.PARTIAL,overlays:[],reasons:['SPLIT_NULL']},performance:performance({twr:numberField({value:null,reasons:['TWR_BOUNDARY_UNVALUED']})})}),
    UNAVAILABLE:view({status:{status:QR2_STATUS.UNAVAILABLE,overlays:[],reasons:['RECONCILIATION_FAILED']},performance:null}),
    REFUSED:refusedView()
  };
  for(const [name,v] of Object.entries(views)){
    const body=compose(v);
    assert.equal(validateResponse(body).ok,true,name);
    assert.equal(body.status.status,name,name);
    assert.equal(body.basis,'ACTUAL_PAPER_LEDGER',name);
    assert.equal(body.execution,'PAPER_SIMULATED_FILLS');
    assert.equal(body.historical_simulation,false);assert.equal(body.qualified_evidence,false);assert.equal(body.fx,'NONE');
    assert.equal(body.declaration_version,null);assert.equal(body.contract_id,QR2_CONTRACT_ID);
    assert.equal(body.currency,'USDT');assert.equal(body.event_time_basis,'LEDGER_WRITE_TIME');
    assert.equal(body.as_of,NOW);assert.equal(body.fee_source,'RECORDED_ONLY');assert.equal(body.alloc_method,'qr2-alloc-v1');
    assert.deepEqual(body.price_policy,{fresh_ms:180000,carry_ms:900000});
    for(const id of ['valuation_method','legacy_method','order_method','period_method','drawdown_grid'])assert.equal(body[id],QR2_METHODS[id],name+' '+id);
    assert.deepEqual(body.return_method,QR2_METHODS.return_method);assert.deepEqual(body.rounding,QR2_METHODS.rounding);assert.deepEqual(body.lot_method,QR2_METHODS.lot_method);
    assert.deepEqual(body.notice_ids,[...QR2_NOTICE_IDS]);
    assert.deepEqual(body.requested_range,{from:T0,to:T0+4*DAY});
    // The current period ends after the request time: the resolved end is the request time and the flag says so (RC-Q23).
    assert.deepEqual(body.resolved_range,{from:T0,to:NOW});assert.deepEqual(body.range_flags,['RANGE_END_AT_REQUEST_TIME']);
  }
  assert.deepEqual(compose(views.COMPLETE).ledger_rule_epochs,['E2']);
  assert.deepEqual(compose(views.COMPLETE).lot_epochs,['paper-exit-cost-v2']);
  // Hand values of the account block (cash 9644, NAV 10016, realized 4, unrealized 12, fees 1.5 from the replay state at the range end).
  const a=compose(views.COMPLETE).account;
  assert.deepEqual([a.cash.value,a.nav.value,a.market_value.value,a.position_cost.value,a.realized_pnl.value,a.unrealized_pnl.value,a.fees.value,a.flows_total.value,a.available_cash.value],
    ['9644','10016','372','360','4','12','1.5','10000','9644']);
  assert.deepEqual([a.money_pnl.value,a.twr.value,a.mwr.value,a.max_drawdown.value],['16','0.0016','0.0016','0']);
  assert.equal(a.exposure.value,'0.03714057508','market value 372 over NAV 10016, rounded once to 12 places');
  assert.equal(compose(views.COMPLETE).symbols[0].price.value,'62000');
  assert.equal(compose(views.COMPLETE).symbols[0].price_state,'FRESH');
});

test('R1 header: a resolved range that is null and a late requested end still carry the flag; a stale price travels as information',()=>{
  const empty=view({range:{requested:{from:NOW,to:NOW+DAY},resolved:null,flags:['RANGE_END_AT_REQUEST_TIME']},performance:null,first_funding_at:null,
    status:{status:QR2_STATUS.UNAVAILABLE,overlays:[],reasons:['RANGE_EMPTY_AT_REQUEST_TIME']}});
  const body=compose(empty);
  assert.equal(body.resolved_range,null);assert.ok(body.range_flags.includes('RANGE_END_AT_REQUEST_TIME'));
  assert.equal(body.status.status,'UNAVAILABLE');assert.deepEqual(body.status.reasons,['RANGE_EMPTY_AT_REQUEST_TIME']);
  const stale=view({performance:performance({nav_to:nav({reasons:['PRICE_STALE'],positions:[{...nav().positions[0],state:'STALE'}]})})});
  const s=compose(stale);
  assert.equal(s.account.nav.value,'10016');assert.deepEqual(s.account.nav.reasons,['PRICE_STALE']);assert.equal(s.account.nav.status,'COMPLETE');
  assert.deepEqual(s.symbols[0].price.reasons,['PRICE_STALE']);
});

test('R2 numbers: a null is never 0 and always has a reason; every present number is a decimal string',()=>{
  const unpriced=view({status:{status:QR2_STATUS.PARTIAL,overlays:[],reasons:['UNAVAILABLE']},
    performance:performance({nav_to:nav({nav:null,market_value:null,unrealized:null,reasons:['UNAVAILABLE'],positions:[{...nav().positions[0],state:'UNAVAILABLE',price:null,market_value:null,unrealized:null,age_ms:null,bar_time:null,retrieval:null}]}),
      money_pnl:numberField({value:null,reasons:['UNAVAILABLE']}),twr:numberField({value:null,reasons:['TWR_BOUNDARY_UNVALUED']})})});
  const body=compose(unpriced);
  assert.equal(body.account.nav.value,null);assert.equal(body.account.nav.status,'UNAVAILABLE');assert.deepEqual(body.account.nav.reasons,['UNAVAILABLE']);
  assert.equal(body.symbols[0].price.value,null);assert.deepEqual(body.symbols[0].price.reasons,['UNAVAILABLE']);
  assert.equal(body.symbols[0].market_value.value,null);
  assert.equal(body.account.cash.value,'9644','cash stays visible when only the price is missing');
  const all=numbersOf(body);
  assert.ok(all.length>=15);
  for(const [path,n] of all){
    if(n.value===null){assert.ok(n.reasons.length>0,path+' null without reason');assert.notEqual(n.value,0);}
    else{assert.equal(typeof n.value,'string',path);assert.match(n.value,/^-?\d+(?:\.\d+)?$/,path);}
  }
  // A blocked account (no performance): every number is null with the account reasons, none is 0.
  const blocked=compose(view({status:{status:QR2_STATUS.UNAVAILABLE,overlays:[],reasons:['RECONCILIATION_FAILED']},performance:null,facts:{...view().facts,r15:{...view().facts.r15,available_cash:null,available_cash_reason:'PENDING_ORDER_UNCERTAIN',reserved_notional:undefined,reserved_fees:undefined}}}));
  for(const key of ['cash','nav','realized_pnl','money_pnl','twr','mwr','max_drawdown']){
    assert.equal(blocked.account[key].value,null,key);assert.ok(blocked.account[key].reasons.includes('RECONCILIATION_FAILED'),key);
  }
  assert.deepEqual(blocked.symbols,[]);
});

test('R2 fail closed: a number that is not a decimal string, a missing label field or a non-integer request time gives QR2_RESPONSE_INVALID and no number',()=>{
  const bad=[
    ['JS number price',view({performance:performance({nav_to:nav({positions:[{...nav().positions[0],price:62000.5}]})})})],
    ['exponent number',view({performance:performance({nav_to:nav({cash:'1e21'})})})],
    ['missing currency',view({scope:{...view().scope,currency:undefined}})],
    ['reader counts missing',view({reader:undefined})],
    ['gates missing',view({gates:undefined})],
    ['not an object',null]
  ];
  for(const [name,v] of bad){
    let caught;
    try{compose(v);}catch(error){caught=error;}
    assert.ok(caught,name);assert.equal(caught.code,'QR2_RESPONSE_INVALID',name);
    assert.equal(caught.message,QR2_ERROR_TEXT.QR2_RESPONSE_INVALID,name+': fixed text');
    assert.ok(!/62000|1e21|9644/.test(JSON.stringify({m:caught.message,c:caught.code,v:caught.validation})),name+': no number in the error');
  }
  assert.throws(()=>composePerformanceResponse(view(),{requestTime:1.5}),{code:'QR2_RESPONSE_INVALID'});
  assert.throws(()=>composePerformanceResponse(view(),{}),{code:'QR2_RESPONSE_INVALID'});
});

test('R3 no rows: the body has no ledger rows, no replay events, no by-fill lists and no order list; findings are capped',()=>{
  const findings=Array.from({length:120},(_,i)=>({check:'R1',effect:'RECONCILIATION_FAILED',code:'JOURNAL_MISSING',event_key:i+':1',table:'fills',time:T0+i,expected:SECRET,actual:SECRET}));
  const body=compose(view({gates:{...view().gates,findings}}));
  const text=textOf(body);
  assert.ok(!text.includes(SECRET),'no row value reaches the body');
  for(const key of ['rows','events','replay','by_fill','orders','details','expected','actual'])assert.ok(!text.includes('"'+key+'"'),key+' is not a body key');
  assert.equal(body.findings.total,120);assert.equal(body.findings.capped,true);assert.equal(body.findings.items.length,QR2_MAX_FINDINGS);
  assert.deepEqual(Object.keys(body.findings.items[0]).sort(),['check','code','effect','event_key','table']);
  const few=compose(view({gates:{...view().gates,findings:findings.slice(0,3)}}));
  assert.equal(few.findings.capped,false);assert.equal(few.findings.items.length,3);
  assert.deepEqual(body.attribution_counts,{BRIDGE:0,WEBHOOK:2,ATTRIBUTION_UNKNOWN:0});
  assert.deepEqual(body.reader.counts,{fundings:1,journal:2,fills:2,lots:1,snapshots:3,total:9},'counts are numbers');
});

test('R3 refused view: header, status REFUSED, the code and counts only; no foreign value, no number field',()=>{
  const body=compose(refusedView('QR2_CROSS_BOT_ROW'));
  assert.equal(body.status.status,'REFUSED');assert.equal(body.code,'QR2_CROSS_BOT_ROW');assert.deepEqual(body.status.reasons,['QR2_CROSS_BOT_ROW']);
  const text=textOf(body);
  assert.ok(!text.includes(SECRET)&&!text.includes('999999'),'a foreign value never leaves the composer');
  assert.deepEqual(numbersOf(body),[],'a refused view has no number field');
  assert.equal(body.account,undefined);assert.equal(body.symbols,undefined);assert.equal(body.cutoffs,undefined);
  assert.deepEqual(body.findings.items,[{check:'RX',code:'QR2_CROSS_BOT_ROW',effect:null,reason:'FOREIGN_USER',table:'fills',count:2}]);
  assert.equal(body.reader.counts.fills,2);
  assert.equal(compose(refusedView('QR2_NON_PAPER_ROW')).code,'QR2_NON_PAPER_ROW');
});

test('R4 status map: every request-level code of contract 10 has a fixed HTTP status and fixed text; an unknown code never echoes',()=>{
  const expected={QR2_INPUT_INVALID:400,QR2_RANGE_INVALID:400,QR2_FEE_OVERLAY_REFUSED:400,QR2_NOT_OWNER:404,QR2_CURRENCY_MIX:422,QR2_RESPONSE_INVALID:500,QR2_REPORT_FAILED:503};
  for(const [code,status] of Object.entries(expected)){
    const a=refusalAnswer(code);
    assert.equal(a.status,status,code);assert.equal(statusOfRefusal(code),status,code);
    assert.deepEqual(a.body,{code,error:QR2_ERROR_TEXT[code]},code);
  }
  assert.equal(refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'history_days',max:30}).status,403);
  assert.equal(refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'concurrency',max:1}).status,429);
  for(const limit of ['ledger_rows','grid_instants','audit_rows','pending_orders'])assert.equal(refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit,value:9,max:5}).status,422,limit);
  assert.equal(statusOfAdmission(undefined),422);
  assert.deepEqual(refusalAnswer('QR2_RANGE_ADMISSION_REFUSED',{limit:'ledger_rows',value:5001,max:5000,sql:'SELECT secret',path:'C:/x'}).body,
    {code:'QR2_RANGE_ADMISSION_REFUSED',error:QR2_ERROR_TEXT.QR2_RANGE_ADMISSION_REFUSED,detail:{limit:'ledger_rows',value:5001,max:5000}},'only limit, value and max travel');
  // The same body for any not-owner cause (no existence oracle).
  assert.equal(JSON.stringify(refusalAnswer('QR2_NOT_OWNER').body),JSON.stringify({code:'QR2_NOT_OWNER',error:'Not found'}));
  const unknown=refusalAnswer('QR2_SQL_EXPLODED: relation "x" does not exist');
  assert.equal(unknown.status,503);assert.deepEqual(unknown.body,{code:'QR2_REPORT_FAILED',error:QR2_ERROR_TEXT.QR2_REPORT_FAILED});
  // Contract 10 lists the row codes as request-level REFUSED codes; the route answers them as a 200 REFUSED view (RC-Q32), never a bare error.
  assert.equal(refusalAnswer('QR2_CROSS_BOT_ROW').status,503);
});

test('R5 named keys: seeds, market data and cutoffs copy named keys only; no global serial id; unlotted is an aggregate; unknown counts are null',()=>{
  const v=view({seeds:{...view().seeds,future_field:SECRET},cutoffs:{...view().cutoffs,future_field:SECRET},
    facts:{...view().facts,market_data:{...view().facts.market_data,future_field:SECRET}},replay:{...view().replay,unlotted:{BTCUSDT:'0.001'}}});
  const body=compose(v);
  assert.ok(!textOf(body).includes(SECRET),'a field the reader adds later does not reach the body');
  assert.deepEqual(Object.keys(body.legacy_seeds).sort(),['has_m1','has_m2','last_m1_time','m1_count','m2_count','method','nav_from','s_cash','s_cost']);
  assert.deepEqual(Object.keys(body.market_data).sort(),['bars','checked','gap','instants','table_present']);
  assert.deepEqual(body.cutoffs,{funding_count:1,snapshot_count:3,fill_count:2,lot_count:1,last_fill:{received_at:T0+2,cumulative_quantity:'0.004'},market_data_cutoff:NOW-1000});
  const text=textOf(body);
  for(const key of ['max_funding_id','max_snapshot_id','signal_id'])assert.ok(!text.includes('"'+key+'"'),key+' is not a body key');
  assert.equal(body.symbols[0].unlotted_quantity.value,'0.001');
  assert.equal(compose(view()).symbols[0].unlotted_quantity.value,null,'no replay aggregate: null with a reason');
  assert.deepEqual(compose(view()).symbols[0].unlotted_quantity.reasons,['UNLOTTED_NOT_AVAILABLE']);
  assert.equal(body.flows_count,1);assert.equal(body.information_count,0);
  const blocked=compose(view({status:{status:QR2_STATUS.UNAVAILABLE,overlays:[],reasons:['RECONCILIATION_FAILED']},performance:null,gates:{...view().gates,information:undefined}}));
  assert.equal(blocked.flows_count,null,'not computed is null, not 0');assert.equal(blocked.information_count,null);
  assert.deepEqual(unknownTopLevelKeys(body),[]);
  assert.deepEqual(unknownTopLevelKeys({...body,rows:[],max_funding_id:1}),['rows','max_funding_id']);
});

test('R6 composer refuses a body with an unknown top-level key; count blocks copy named keys only',()=>{
  // The composer itself (not only the helper) checks the key allowlist: a build step that adds a key outside it fails closed.
  const rogue=(v,requestTime)=>({...composePerformanceResponse(v,{requestTime}),max_funding_id:1});
  let caught;
  try{composePerformanceResponse(view(),{requestTime:NOW,build:rogue});}catch(error){caught=error;}
  assert.ok(caught);assert.equal(caught.code,'QR2_RESPONSE_INVALID');assert.equal(caught.message,QR2_ERROR_TEXT.QR2_RESPONSE_INVALID);
  assert.deepEqual(caught.validation,['UNKNOWN_TOP_LEVEL_KEY']);
  assert.deepEqual(unknownTopLevelKeys(compose(view())),[]);
  const extra=view({marker_counts:{AGREES:2,DISAGREES:0,ABSENT:0,FUTURE:SECRET},
    facts:{...view().facts,attribution:{by_fill:[],counts:{BRIDGE:0,WEBHOOK:2,ATTRIBUTION_UNKNOWN:0,FUTURE:SECRET}},slippage:{by_fill:[],counts:{SLIPPAGE_UNKNOWN:2,MODELED_SLIPPAGE_ALREADY_INCLUDED:0,FUTURE:SECRET}}}});
  const body=compose(extra);
  assert.ok(!textOf(body).includes(SECRET),'a count the reader adds later does not reach the body');
  assert.deepEqual(body.marker_counts,{AGREES:2,DISAGREES:0,ABSENT:0});
  assert.deepEqual(body.attribution_counts,{BRIDGE:0,WEBHOOK:2,ATTRIBUTION_UNKNOWN:0});
  assert.deepEqual(body.slippage_counts,{SLIPPAGE_UNKNOWN:2,MODELED_SLIPPAGE_ALREADY_INCLUDED:0});
});
