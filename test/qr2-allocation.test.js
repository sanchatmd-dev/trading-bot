import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateOwnerTotal,ALLOCATION_CODES,ALLOCATION_LABEL,ALLOCATION_NOTICE,ALLOCATION_SUM_FIELDS} from '../src/portfolio/qr2-allocation.js';
import {QR2_STATUS,Qr2Error} from '../src/portfolio/qr2-constants.js';

// QR-2 S4-2 allocation (contract 4.2, 6.6 RX, 10, 13 item 11). Pure: no database. Every expected number below is worked out by hand
// from the fixture literals; nothing is computed with the module under test. Range = [T0, T1), T1 = T0 + 7 days.
const T0=1790812800000,DAY=86400000,T1=T0+7*DAY;
const COMPLETE=QR2_STATUS.COMPLETE,PARTIAL=QR2_STATUS.PARTIAL,UNAVAILABLE=QR2_STATUS.UNAVAILABLE,REFUSED=QR2_STATUS.REFUSED;

const num=(value,over={})=>value===null?{value:null,status:UNAVAILABLE,reasons:over.reasons??['PRICE_UNAVAILABLE']}:{value,status:over.status??COMPLETE,reasons:over.reasons??[]};
// Account A (bot-a): nav 1000 -> 1180, flows 100, so money PnL 1180 - 1000 - 100 = 80. Fees 3.5.
const accountA=(over={})=>({bot_id:'bot-a',broker:'binance-global',currency:'USDT',status:{status:COMPLETE,overlays:[],reasons:[]},code:null,range:{from:T0,to:T1},
  reconciliation:{state:'OK',failed_from:null},price_state_from:'NO_POSITION',price_state_to:'FRESH',
  nav_from:num('1000'),nav_to:num('1180'),flows_total:num('100'),fees:num('3.5'),money_pnl:num('80'),twr:num('0.08'),
  keys:{signals:['101','102'],journal:[{signal_id:'101',cumulative_quantity:'0.4'}],fundings:['11'],positions:['p-a']},...over});
// Account B (bot-b): nav 500.25 -> 541, flows 20, so money PnL 541 - 500.25 - 20 = 20.75. Fees 1.25.
const accountB=(over={})=>({bot_id:'bot-b',broker:'binance-global',currency:'USDT',status:{status:COMPLETE,overlays:[],reasons:[]},code:null,range:{from:T0,to:T1},
  reconciliation:{state:'OK',failed_from:null},price_state_from:'NO_POSITION',price_state_to:'NO_POSITION',
  nav_from:num('500.25'),nav_to:num('541'),flows_total:num('20'),fees:num('1.25'),money_pnl:num('20.75'),twr:num('0.04'),
  keys:{signals:['201'],journal:[{signal_id:'201',cumulative_quantity:'1'}],fundings:['21'],positions:['p-b']},...over});
// Hand totals of A + B: nav_from 1500.25, nav_to 1721, flows 120, fees 4.75, money PnL 100.75 (1721 - 1500.25 - 120).
const TOTAL_AB={nav_from:'1500.25',nav_to:'1721',flows_total:'120',fees:'4.75',money_pnl:'100.75'};
const decl=(version,capital_model,bot_set,effective_from)=>({version,capital_model,bot_set,effective_from});
const bots=(...rows)=>rows.map(([bot_id,created_at])=>({bot_id,created_at}));
const build=(over={})=>({currency:'USDT',range:{from:T0,to:T1},
  declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-DAY)],
  owner_bots:bots(['bot-a',T0-10*DAY],['bot-b',T0-9*DAY]),
  accounts:[accountA(),accountB()],...over});
const run=(over,options)=>aggregateOwnerTotal(build(over),options);
const throwsCode=(fn,code)=>assert.throws(fn,error=>error instanceof Qr2Error&&error.code===code);
const allNull=(total,reason)=>{
  for(const f of [...ALLOCATION_SUM_FIELDS,'twr','mwr'])assert.deepEqual(total[f],{value:null,status:UNAVAILABLE,reasons:[reason]},f);
};
const valuesOf=total=>Object.fromEntries(ALLOCATION_SUM_FIELDS.map(f=>[f,total[f].value]));
// The number-field rule of the validator (8.1): a null has a reason and is never 0, a value is a decimal string and is not UNAVAILABLE.
function assertNumberFields(value,path='view'){
  if(Array.isArray(value))return value.forEach((v,i)=>assertNumberFields(v,path+'['+i+']'));
  if(!value||typeof value!=='object')return;
  if('value' in value&&'status' in value&&'reasons' in value){
    if(value.value===null){assert.ok(value.reasons.length>0,path+' null without a reason');assert.equal(value.status,UNAVAILABLE,path);}
    else{assert.equal(typeof value.value,'string',path);assert.match(value.value,/^-?\d+(?:\.\d+)?$/,path);assert.notEqual(value.status,UNAVAILABLE,path);}
    return;
  }
  for(const [k,v] of Object.entries(value))assertNumberFields(v,path+'.'+k);
}

/* ------------------------------------------------------------------ INDEPENDENT_ACCOUNTS: the exact sum line */

test('INDEPENDENT_ACCOUNTS: exact sum of two accounts, label, notice, no owner return, ordered accounts',()=>{
  const view=run();
  assert.deepEqual(view.allocation,{capital_model:'INDEPENDENT_ACCOUNTS',version:1,reason:null,effective_from:T0-DAY});
  assert.equal(view.total.label,ALLOCATION_LABEL);
  assert.equal(view.total.label,'SUM_OF_INDEPENDENT_PAPER_ACCOUNTS');
  assert.equal(view.total.notice,ALLOCATION_NOTICE);
  assert.equal(view.total.notice,'NOT_AN_OWNER_PORTFOLIO');
  assert.deepEqual(valuesOf(view.total),TOTAL_AB);
  for(const f of ALLOCATION_SUM_FIELDS){assert.equal(view.total[f].status,COMPLETE,f);assert.deepEqual(view.total[f].reasons,[],f);}
  for(const f of ['twr','mwr'])assert.deepEqual(view.total[f],{value:null,status:UNAVAILABLE,reasons:['ALLOCATION_INDEPENDENT_NO_RETURN']},f);
  assert.equal(view.total.member_count,2);
  assert.deepEqual(view.total.members,[]);
  assert.deepEqual(view.status,{status:COMPLETE,overlays:[],reasons:[]});
  assert.deepEqual(view.accounts.map(a=>a.bot_id+'/'+a.broker),['bot-a/binance-global','bot-b/binance-global']);
  assert.deepEqual(view.accounts[0].nav_to,num('1180'));
  assert.deepEqual(view.accounts[1].twr,num('0.04'));
  assertNumberFields(view);
});

test('sums are exact decimals, not binary floating point',()=>{
  // 0.1 + 0.2 is 0.30000000000000004 in binary floating point; the exact sum is 0.3.
  const a=accountA({nav_from:num('0.1'),nav_to:num('0.3'),flows_total:num('0'),fees:num('0.1'),money_pnl:num('0.2')});
  const b=accountB({nav_from:num('0.2'),nav_to:num('0.7'),flows_total:num('0.1'),fees:num('0.2'),money_pnl:num('0.4')});
  const view=run({accounts:[a,b]});
  // nav_from 0.1 + 0.2 = 0.3; nav_to 0.3 + 0.7 = 1; flows 0 + 0.1 = 0.1; fees 0.1 + 0.2 = 0.3; pnl 0.2 + 0.4 = 0.6 and 1 - 0.3 - 0.1 = 0.6.
  assert.deepEqual(valuesOf(view.total),{nav_from:'0.3',nav_to:'1',flows_total:'0.1',fees:'0.3',money_pnl:'0.6'});
  // 18-place values: three parts of 1e-18 add to 3e-18, and a 19-digit whole part keeps every digit.
  const c=n=>accountA({nav_from:num('0.000000000000000001'),nav_to:num('0.000000000000000001'),flows_total:num('0'),fees:num('0.000000000000000001'),money_pnl:num('0'),
    bot_id:'bot-'+n,keys:{signals:['s'+n],journal:[],fundings:['f'+n],positions:[]}});
  const three=aggregateOwnerTotal({currency:'USDT',range:{from:T0,to:T1},declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-1','bot-2','bot-3'],T0)],
    owner_bots:bots(['bot-1',0],['bot-2',0],['bot-3',0]),accounts:[c('1'),c('2'),c('3')]});
  assert.deepEqual(valuesOf(three.total),{nav_from:'0.000000000000000003',nav_to:'0.000000000000000003',flows_total:'0',fees:'0.000000000000000003',money_pnl:'0'});
  const big=run({accounts:[accountA({nav_from:num('1'),nav_to:num('1234567890123456789.000000000000000001'),flows_total:num('0'),money_pnl:num('1234567890123456788.000000000000000001')}),
    accountB({nav_from:num('0'),nav_to:num('0.000000000000000009'),flows_total:num('0'),money_pnl:num('0.000000000000000009')})]});
  assert.equal(big.total.nav_to.value,'1234567890123456789.00000000000000001');
  assert.equal(big.total.money_pnl.value,'1234567890123456788.00000000000000001');
});

test('negative money PnL sums with the correct sign and the identity holds',()=>{
  // A: 1000 -> 940, no flows, pnl -60. B: 100 -> 130, flows 10, pnl 20. Totals: 1100 -> 1070, flows 10, pnl -40 (1070 - 1100 - 10 = -40).
  const a=accountA({nav_from:num('1000'),nav_to:num('940'),flows_total:num('0'),money_pnl:num('-60')});
  const b=accountB({nav_from:num('100'),nav_to:num('130'),flows_total:num('10'),money_pnl:num('20')});
  const view=run({accounts:[a,b]});
  assert.deepEqual(valuesOf(view.total),{nav_from:'1100',nav_to:'1070',flows_total:'10',fees:'4.75',money_pnl:'-40'});
});

/* ------------------------------------------------------------------ declaration applicability (border cases) */

test('a version effective exactly at from applies; one ms after from does not',()=>{
  const atFrom=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0)]});
  assert.equal(atFrom.allocation.version,1);
  assert.equal(atFrom.allocation.effective_from,T0);
  assert.deepEqual(valuesOf(atFrom.total),TOTAL_AB);
  // Effective one ms after from: no version at `from`, so the strict reading gives CAPITAL_MODEL_NOT_DECLARED (OW2).
  const after=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0+1)]});
  assert.deepEqual(after.allocation,{capital_model:null,version:null,reason:'CAPITAL_MODEL_NOT_DECLARED',effective_from:null});
  allNull(after.total,'CAPITAL_MODEL_NOT_DECLARED');
  assert.equal(after.total.label,null);
  assert.equal(after.total.notice,null);
  assert.deepEqual(after.status,{status:UNAVAILABLE,overlays:[],reasons:['CAPITAL_MODEL_NOT_DECLARED']});
  // The per-Bot rows stay, and no Bot is guessed as NO_ACCOUNT without a declaration.
  assert.deepEqual(after.accounts.map(a=>a.bot_id),['bot-a','bot-b']);
  assertNumberFields(after);
});

test('no declaration at all gives no total',()=>{
  const view=run({declarations:[]});
  assert.equal(view.allocation.reason,'CAPITAL_MODEL_NOT_DECLARED');
  allNull(view.total,'CAPITAL_MODEL_NOT_DECLARED');
  assert.equal(view.total.member_count,0);
});

test('a later version effective before to changes the declaration; at to it does not',()=>{
  const v1=decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-DAY);
  // v2 effective one ms before `to`: it applies inside the range, so no total.
  const inside=run({declarations:[v1,decl(2,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T1-1)]});
  assert.deepEqual(inside.allocation,{capital_model:'INDEPENDENT_ACCOUNTS',version:1,reason:'ALLOCATION_DECLARATION_CHANGED',effective_from:T0-DAY});
  allNull(inside.total,'ALLOCATION_DECLARATION_CHANGED');
  assert.equal(inside.total.label,ALLOCATION_LABEL);
  // v2 effective exactly at `to`: the range is half-open, v2 applies from `to`, so v1 still gives the total.
  const atTo=run({declarations:[v1,decl(2,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T1)]});
  assert.equal(atTo.allocation.version,1);
  assert.equal(atTo.allocation.reason,null);
  assert.deepEqual(valuesOf(atTo.total),TOTAL_AB);
  // v2 effective one ms after from also changes the declaration inside the range.
  const justAfter=run({declarations:[v1,decl(2,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0+1)]});
  assert.equal(justAfter.allocation.reason,'ALLOCATION_DECLARATION_CHANGED');
});

test('the highest version effective at from applies (R-22), including a superseding one at from',()=>{
  const view=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-2*DAY),decl(2,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0),decl(3,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0+DAY)]});
  // v3 starts inside the range, so v2 (applicable at from) is changed inside the range first: the change check precedes the model.
  assert.equal(view.allocation.version,2);
  assert.equal(view.allocation.reason,'ALLOCATION_DECLARATION_CHANGED');
  const noLater=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-2*DAY),decl(2,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0)]});
  assert.equal(noLater.allocation.version,2);
  assert.equal(noLater.allocation.reason,'NOT_AGGREGABLE_SHARED_CAPITAL');
  // Equal effective_from: the later version supersedes the earlier one for every instant at or after it.
  const equal=run({declarations:[decl(1,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0),decl(2,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0)]});
  assert.equal(equal.allocation.version,2);
  assert.deepEqual(valuesOf(equal.total),TOTAL_AB);
});

test('SHARED_HYPOTHETICAL gives per-Bot rows only and no total',()=>{
  const view=run({declarations:[decl(4,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0-DAY)]});
  assert.deepEqual(view.allocation,{capital_model:'SHARED_HYPOTHETICAL',version:4,reason:'NOT_AGGREGABLE_SHARED_CAPITAL',effective_from:T0-DAY});
  allNull(view.total,'NOT_AGGREGABLE_SHARED_CAPITAL');
  assert.equal(view.total.label,null);
  assert.equal(view.total.notice,null);
  assert.deepEqual(view.status,{status:UNAVAILABLE,overlays:[],reasons:['NOT_AGGREGABLE_SHARED_CAPITAL']});
  assert.deepEqual(view.accounts.map(a=>[a.bot_id,a.nav_to.value]),[['bot-a','1180'],['bot-b','541']]);
  assertNumberFields(view);
});

/* ------------------------------------------------------------------ Bot-set check */

test('Bot set: equal sets pass; a Bot created exactly at from passes, one ms after from changes the set',()=>{
  const at=run({owner_bots:bots(['bot-a',T0-10*DAY],['bot-b',T0])});
  assert.equal(at.allocation.reason,null);
  assert.deepEqual(valuesOf(at.total),TOTAL_AB);
  const after=run({owner_bots:bots(['bot-a',T0-10*DAY],['bot-b',T0+1])});
  assert.equal(after.allocation.reason,'ALLOCATION_SET_CHANGED');
  allNull(after.total,'ALLOCATION_SET_CHANGED');
  assert.equal(after.total.label,ALLOCATION_LABEL);
  assert.equal(after.allocation.version,1);
  assertNumberFields(after);
});

test('Bot set: an undeclared Bot born before to changes the set; one born exactly at to does not',()=>{
  const cOwner=bots(['bot-a',T0-10*DAY],['bot-b',T0-9*DAY]);
  // bot-c born inside the range, not declared: the set differs.
  const inside=run({owner_bots:[...cOwner,...bots(['bot-c',T1-1])]});
  assert.equal(inside.allocation.reason,'ALLOCATION_SET_CHANGED');
  // bot-c born before from, never declared: also a different set (OW4 until the owner declares again).
  const before=run({owner_bots:[...cOwner,...bots(['bot-c',T0-DAY])]});
  assert.equal(before.allocation.reason,'ALLOCATION_SET_CHANGED');
  // bot-c born exactly at `to`: it does not exist in the half-open range, so the sets are equal.
  const atTo=run({owner_bots:[...cOwner,...bots(['bot-c',T1])]});
  assert.equal(atTo.allocation.reason,null);
  assert.deepEqual(valuesOf(atTo.total),TOTAL_AB);
});

test('Bot set: a declared Bot missing from the owner set, or a smaller owner set, changes the set',()=>{
  const missing=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b','bot-z'],T0-DAY)]});
  assert.equal(missing.allocation.reason,'ALLOCATION_SET_CHANGED');
  const subset=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0-DAY)],accounts:[accountA()]});
  assert.equal(subset.allocation.reason,'ALLOCATION_SET_CHANGED');
  allNull(subset.total,'ALLOCATION_SET_CHANGED');
});

test('a declared Bot with no account in the currency is NO_ACCOUNT and adds no number',()=>{
  const view=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b','bot-c'],T0-DAY)],owner_bots:bots(['bot-a',T0-10*DAY],['bot-b',T0-9*DAY],['bot-c',T0-DAY])});
  assert.equal(view.allocation.reason,null);
  assert.deepEqual(valuesOf(view.total),TOTAL_AB);
  assert.equal(view.total.member_count,2);
  assert.deepEqual(view.accounts.map(a=>a.bot_id),['bot-a','bot-b','bot-c']);
  assert.deepEqual(view.accounts[2],{bot_id:'bot-c',account:'NO_ACCOUNT'});
  assertNumberFields(view);
  // The NO_ACCOUNT row sorts by Bot id among the others.
  const mid=run({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-aa','bot-b'],T0-DAY)],owner_bots:bots(['bot-a',T0-10*DAY],['bot-aa',T0-DAY],['bot-b',T0-9*DAY])});
  assert.deepEqual(mid.accounts.map(a=>a.bot_id),['bot-a','bot-aa','bot-b']);
  // No account at all: no member, so no number (never a zero total).
  const none=run({accounts:[]});
  assert.equal(none.allocation.reason,null);
  allNull(none.total,'ALLOCATION_NO_MEMBER_ACCOUNT');
  assert.deepEqual(none.accounts,[{bot_id:'bot-a',account:'NO_ACCOUNT'},{bot_id:'bot-b',account:'NO_ACCOUNT'}]);
  assert.deepEqual(none.status,{status:UNAVAILABLE,overlays:[],reasons:['ALLOCATION_NO_MEMBER_ACCOUNT']});
});

/* ------------------------------------------------------------------ currency defence */

test('a mixed currency is refused QR2_CURRENCY_MIX and never summed',()=>{
  throwsCode(()=>run({accounts:[accountA(),accountB({currency:'THB'})]}),'QR2_CURRENCY_MIX');
  throwsCode(()=>run({currency:'THB'}),'QR2_CURRENCY_MIX');
  throwsCode(()=>run({declarations:[{...decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-DAY),currency:'THB'}]}),'QR2_CURRENCY_MIX');
  // The declaration's own currency may be given when it matches.
  assert.equal(run({declarations:[{...decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-DAY),currency:'USDT'}]}).allocation.version,1);
  // The error text is fixed and carries no id.
  try{run({accounts:[accountA(),accountB({currency:'THB'})]});assert.fail('expected a refusal');}
  catch(error){assert.equal(error.message,'The request is refused');}
});

/* ------------------------------------------------------------------ RX: disjointness and refused members */

const secret='SECRET-KEY-7731';
test('RX: a key of each kind in two member views refuses the whole total, counts only',()=>{
  for(const kind of ['signals','fundings','positions']){
    // The one shared id is the secret: it must never appear in the refused view.
    const a=accountA({keys:{...accountA().keys,[kind]:[...accountA().keys[kind],secret]}});
    const b=accountB({keys:{...accountB().keys,[kind]:[...accountB().keys[kind],secret]}});
    const view=run({accounts:[a,b]});
    assert.equal(view.refused,'QR2_CROSS_BOT_ROW',kind);
    assert.equal(view.code,'QR2_CROSS_BOT_ROW',kind);
    assert.deepEqual(view.status,{status:REFUSED,overlays:[],reasons:['QR2_CROSS_BOT_ROW']},kind);
    assert.deepEqual(view.counts,{accounts:2,accounts_refused:0,signals:0,journal:0,fundings:0,positions:0,[kind]:1},kind);
    assert.equal('total' in view,false,kind);
    assert.equal('accounts' in view,false,kind);
    assert.equal('allocation' in view,false,kind);
    assert.deepEqual(Object.keys(view).sort(),['code','counts','refused','status'],kind);
    assert.equal(JSON.stringify(view).includes(secret),false,kind);
    for(const value of ['1180','1721','101','p-a'])assert.equal(JSON.stringify(view).includes(value),false,kind+value);
  }
});

test('RX: a journal key (signal and cumulative quantity) shared by two views is refused; the same signal with another quantity is not',()=>{
  // 0.4 and 0.40 are the same quantity, so the journal key (101, 0.4) is in both views.
  const shared=run({accounts:[accountA(),accountB({keys:{signals:['201'],journal:[{signal_id:'101',cumulative_quantity:'0.40'}],fundings:['21'],positions:['p-b']}})]});
  assert.equal(shared.refused,'QR2_CROSS_BOT_ROW');
  assert.deepEqual(shared.counts,{accounts:2,accounts_refused:0,signals:1,journal:1,fundings:0,positions:0});
  // G3: the same signal with another quantity is a different journal key, but B's journal still names A's signal 101, so RX refuses (S: key).
  const other=run({accounts:[accountA(),accountB({keys:{signals:['201'],journal:[{signal_id:'101',cumulative_quantity:'0.5'}],fundings:['21'],positions:['p-b']}})]});
  assert.equal(other.refused,'QR2_CROSS_BOT_ROW');
  assert.deepEqual(other.counts,{accounts:2,accounts_refused:0,signals:1,journal:0,fundings:0,positions:0});
  // A journal row naming a signal of its own view is fine.
  const own=run({accounts:[accountA(),accountB({keys:{signals:[],journal:[{signal_id:'201',cumulative_quantity:'0.5'}],fundings:['21'],positions:['p-b']}})]});
  assert.equal(own.refused,undefined);
  assert.deepEqual(valuesOf(own.total),TOTAL_AB);
});

test('RX: a repeated key inside one view is not an overlap; three views sharing one key count it once',()=>{
  const dup=run({accounts:[accountA({keys:{signals:['101','101'],journal:[],fundings:['11','11'],positions:['p-a','p-a']}}),accountB()]});
  assert.equal(dup.refused,undefined);
  const three=aggregateOwnerTotal({currency:'USDT',range:{from:T0,to:T1},declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b','bot-c'],T0)],
    owner_bots:bots(['bot-a',0],['bot-b',0],['bot-c',0]),
    accounts:['bot-a','bot-b','bot-c'].map(id=>accountA({bot_id:id,keys:{signals:['same'],journal:[],fundings:[id],positions:[]}}))});
  assert.equal(three.refused,'QR2_CROSS_BOT_ROW');
  assert.equal(three.counts.signals,1);
});

test('RX: a member view refused QR2_CROSS_BOT_ROW or QR2_NON_PAPER_ROW refuses the whole total; another refusal nulls it',()=>{
  const refusedA=code=>({bot_id:'bot-a',broker:'binance-global',currency:'USDT',status:{status:REFUSED,overlays:[],reasons:[code]},code});
  const cross=run({accounts:[refusedA('QR2_CROSS_BOT_ROW'),accountB()]});
  assert.equal(cross.refused,'QR2_CROSS_BOT_ROW');
  assert.deepEqual(cross.counts,{accounts:2,accounts_refused:1,signals:0,journal:0,fundings:0,positions:0});
  const paper=run({accounts:[refusedA('QR2_NON_PAPER_ROW'),accountB()]});
  assert.equal(paper.refused,'QR2_NON_PAPER_ROW');
  assert.equal(paper.counts.accounts_refused,1);
  // Both at once: the cross-Bot code wins.
  const both=run({accounts:[refusedA('QR2_NON_PAPER_ROW'),{...refusedA('QR2_CROSS_BOT_ROW'),bot_id:'bot-b'}]});
  assert.equal(both.refused,'QR2_CROSS_BOT_ROW');
  // Any other refusal makes that member null, so the total is null with the reason and no partial number.
  const other=run({accounts:[refusedA('QR2_FEE_OVERLAY_REFUSED'),accountB()]});
  assert.equal(other.refused,undefined);
  allNull(other.total,'ALLOCATION_MEMBER_UNAVAILABLE');
  assert.deepEqual(other.total.members,[{bot_id:'bot-a',broker:'binance-global',fields:['nav_from','nav_to','flows_total','fees','money_pnl'],reasons:['QR2_FEE_OVERLAY_REFUSED']}]);
  assertNumberFields(other);
});

test('RX: the same Bot with three THB brokers is fine when the keys are disjoint',()=>{
  const thb=(broker,keys,over={})=>accountA({broker,currency:'THB',keys,price_state_to:'NO_POSITION',...over});
  const view=aggregateOwnerTotal({currency:'THB',range:{from:T0,to:T1},declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0)],owner_bots:bots(['bot-a',0]),
    accounts:[thb('settrade',{signals:['3'],journal:[],fundings:['f3'],positions:[]}),thb('binance-th',{signals:['1'],journal:[],fundings:['f1'],positions:[]}),
      thb('innovestx',{signals:['2'],journal:[],fundings:['f2'],positions:[]})]});
  assert.equal(view.refused,undefined);
  assert.deepEqual(view.accounts.map(a=>a.broker),['binance-th','innovestx','settrade']);
  // Three identical accounts of the fixture: nav_from 3 x 1000, nav_to 3 x 1180, flows 3 x 100, fees 3 x 3.5, pnl 3 x 80.
  assert.deepEqual(valuesOf(view.total),{nav_from:'3000',nav_to:'3540',flows_total:'300',fees:'10.5',money_pnl:'240'});
});

/* ------------------------------------------------------------------ member condition: no partial total */

test('one null member nulls every number, with the reason list and no partial total',()=>{
  for(const f of ALLOCATION_SUM_FIELDS){
    const view=run({accounts:[accountA(),accountB({[f]:num(null,{reasons:['PRICE_UNAVAILABLE']})})]});
    assert.equal(view.allocation.reason,null,f);
    allNull(view.total,'ALLOCATION_MEMBER_UNAVAILABLE');
    assert.equal(view.total.member_count,0,f);
    assert.deepEqual(view.total.members,[{bot_id:'bot-b',broker:'binance-global',fields:[f],reasons:['PRICE_UNAVAILABLE']}],f);
    assert.deepEqual(view.status,{status:UNAVAILABLE,overlays:[],reasons:['ALLOCATION_MEMBER_UNAVAILABLE']},f);
    // The other account's good numbers are still listed per Bot, never merged into a total.
    assert.equal(view.accounts[0].nav_to.value,'1180',f);
    assertNumberFields(view);
  }
});

test('an unpriced member lists its reasons; two null members list both in order',()=>{
  const a=accountA({price_state_to:'UNAVAILABLE',nav_to:num(null,{reasons:['UNAVAILABLE']}),money_pnl:num(null,{reasons:['UNAVAILABLE','NAV_TO_NULL']})});
  const b=accountB({nav_from:num(null,{reasons:[]})});
  const view=run({accounts:[b,a]});
  assert.deepEqual(view.total.members,[
    {bot_id:'bot-a',broker:'binance-global',fields:['nav_to','money_pnl'],reasons:['NAV_TO_NULL','UNAVAILABLE']},
    {bot_id:'bot-b',broker:'binance-global',fields:['nav_from'],reasons:['NAV_FROM_NOT_AVAILABLE']}]);
  assertNumberFields(view);
});

test('a price state that is not FRESH, STALE or NO_POSITION nulls the total even with a value',()=>{
  for(const state of ['UNAVAILABLE','PRICE_INTEGRITY_FAILED','UNSUPPORTED_MARKET']){
    for(const end of ['price_state_from','price_state_to']){
      const view=run({accounts:[accountA({[end]:state}),accountB()]});
      assert.equal(view.total.nav_to.value,null,state+end);
      assert.deepEqual(view.total.members,[{bot_id:'bot-a',broker:'binance-global',fields:[],reasons:[state]}],state+end);
    }
  }
  const unknown=run({accounts:[accountA({price_state_to:null}),accountB()]});
  assert.deepEqual(unknown.total.members[0].reasons,['PRICE_STATE_UNKNOWN']);
  // STALE and NO_POSITION are priced.
  assert.equal(run({accounts:[accountA({price_state_to:'STALE'}),accountB()]}).total.nav_to.value,'1721');
});

test('reconciliation blocks the total as RC-Q3 defines (account unavailable, failed whole account, failed inside the range)',()=>{
  const rec=(state,failed_from=null)=>run({accounts:[accountA({reconciliation:{state,failed_from}}),accountB()]});
  assert.deepEqual(rec('ACCOUNT_UNAVAILABLE').total.members[0].reasons,['ACCOUNT_UNAVAILABLE']);
  assert.deepEqual(rec('RECONCILIATION_FAILED').total.members[0].reasons,['RECONCILIATION_FAILED']);
  // A failure at a fill before `to` reaches the range; a failure at `to` or later ends after the range and does not block.
  assert.deepEqual(rec('RECONCILIATION_FAILED',T1-1).total.members[0].reasons,['RECONCILIATION_FAILED']);
  assert.equal(rec('RECONCILIATION_FAILED',T1).total.nav_to.value,'1721');
  assert.equal(rec('RECONCILIATION_FAILED',T1+DAY).total.nav_to.value,'1721');
  assert.equal(rec('OK').total.nav_to.value,'1721');
  // G4: a failure that began before from, or exactly at from, is inside the range reach (to > failed_from) and blocks the total.
  assert.deepEqual(rec('RECONCILIATION_FAILED',T0-DAY).total.members[0].reasons,['RECONCILIATION_FAILED']);
  assert.deepEqual(rec('RECONCILIATION_FAILED',T0).total.members[0].reasons,['RECONCILIATION_FAILED']);
});

test('a member whose status is UNAVAILABLE nulls the total',()=>{
  const view=run({accounts:[accountA({status:{status:UNAVAILABLE,overlays:[],reasons:['RECONCILIATION_FAILED']}}),accountB()]});
  assert.equal(view.total.nav_to.value,null);
  assert.deepEqual(view.total.members[0].reasons,['MEMBER_STATUS_UNAVAILABLE']);
});

test('a STALE member keeps the total with the PRICE_STALE reason; the status stays COMPLETE',()=>{
  const a=accountA({price_state_to:'STALE',nav_to:num('1180',{reasons:['PRICE_STALE']}),money_pnl:num('80',{reasons:['PRICE_STALE']})});
  const view=run({accounts:[a,accountB()]});
  assert.deepEqual(valuesOf(view.total),TOTAL_AB);
  assert.deepEqual(view.total.nav_to.reasons,['PRICE_STALE']);
  assert.deepEqual(view.total.money_pnl.reasons,['PRICE_STALE']);
  assert.deepEqual(view.total.nav_from.reasons,[]);
  assert.equal(view.total.nav_to.status,COMPLETE);
  assert.deepEqual(view.status,{status:COMPLETE,overlays:[],reasons:[]});
});

test('status is the worst member status; overlays and reasons are the sorted union',()=>{
  const a=accountA({status:{status:PARTIAL,overlays:['LEDGER_INVARIANT_VIOLATED'],reasons:['SPLIT_NULL']},twr:num(null,{reasons:['SPLIT_NULL']}),money_pnl:num('80',{status:PARTIAL,reasons:['LEDGER_INVARIANT_VIOLATED']})});
  const b=accountB({status:{status:COMPLETE,overlays:['RECONCILIATION_UNAVAILABLE_LEGACY'],reasons:['AN_INFO']}});
  const view=run({accounts:[b,a]});
  assert.deepEqual(view.status,{status:PARTIAL,overlays:['LEDGER_INVARIANT_VIOLATED','RECONCILIATION_UNAVAILABLE_LEGACY'],reasons:['AN_INFO','SPLIT_NULL']});
  // A PARTIAL value in one member makes that total line PARTIAL (worst), the others stay COMPLETE.
  assert.equal(view.total.money_pnl.status,PARTIAL);
  assert.deepEqual(view.total.money_pnl.reasons,['LEDGER_INVARIANT_VIOLATED']);
  assert.equal(view.total.money_pnl.value,'100.75');
  assert.equal(view.total.nav_to.status,COMPLETE);
  // The per-Bot twr of the partial account stays a null with its reason in the account row.
  assert.deepEqual(view.accounts[0].twr,num(null,{reasons:['SPLIT_NULL']}));
  assert.equal(view.accounts[0].status.status,PARTIAL);
  assertNumberFields(view);
  // Overlays are listed even when the total is null for another reason.
  const shared=run({declarations:[decl(1,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0)],accounts:[a,b]});
  assert.deepEqual(shared.status.overlays,['LEDGER_INVARIANT_VIOLATED','RECONCILIATION_UNAVAILABLE_LEGACY']);
});

test('THB with an unpriced open position has no total; THB with every account flat has one',()=>{
  const thb=(broker,over)=>accountA({broker,currency:'THB',keys:{signals:['s-'+broker],journal:[],fundings:['f-'+broker],positions:[]},...over});
  const flat=(broker)=>thb(broker,{price_state_to:'NO_POSITION'});
  const open=thb('innovestx',{price_state_to:'UNSUPPORTED_MARKET',nav_to:num(null,{reasons:['UNSUPPORTED_MARKET']}),money_pnl:num(null,{reasons:['UNSUPPORTED_MARKET']})});
  const base={currency:'THB',range:{from:T0,to:T1},declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0)],owner_bots:bots(['bot-a',0])};
  const blocked=aggregateOwnerTotal({...base,accounts:[flat('binance-th'),open,flat('settrade')]});
  allNull(blocked.total,'ALLOCATION_MEMBER_UNAVAILABLE');
  assert.deepEqual(blocked.total.members,[{bot_id:'bot-a',broker:'innovestx',fields:['nav_to','money_pnl'],reasons:['UNSUPPORTED_MARKET']}]);
  assert.equal(blocked.status.status,UNAVAILABLE);
  const ok=aggregateOwnerTotal({...base,accounts:[flat('binance-th'),flat('innovestx'),flat('settrade')]});
  assert.deepEqual(valuesOf(ok.total),{nav_from:'3000',nav_to:'3540',flows_total:'300',fees:'10.5',money_pnl:'240'});
  assert.equal(ok.allocation.reason,null);
});

/* ------------------------------------------------------------------ range defence */

test('a member range that differs from the owner range gives ALLOCATION_RANGE_MISMATCH',()=>{
  for(const range of [{from:T0,to:T1-1},{from:T0+1,to:T1},{from:T0-DAY,to:T1+DAY},null]){
    const view=run({accounts:[accountA(),accountB({range})]});
    assert.equal(view.allocation.reason,null,JSON.stringify(range));
    assert.equal(view.allocation.version,1);
    allNull(view.total,'ALLOCATION_RANGE_MISMATCH');
    assert.equal(view.total.label,ALLOCATION_LABEL);
  }
  assert.equal(run({accounts:[accountA(),accountB({range:{from:T0,to:T1}})]}).allocation.reason,null);
});

/* ------------------------------------------------------------------ self-check (RX total equals the sum of its parts) */

test('the self-check refuses a tampered part: money PnL that breaks nav_to - nav_from - flows',()=>{
  // B's money PnL should be 20.75; 20.76 makes the pnl total 100.76 while 1721 - 1500.25 - 120 = 100.75.
  const view=run({accounts:[accountA(),accountB({money_pnl:num('20.76')})]});
  assert.equal(view.refused,'QR2_TOTAL_MISMATCH');
  assert.equal(view.code,'QR2_TOTAL_MISMATCH');
  assert.deepEqual(view.status,{status:REFUSED,overlays:[],reasons:['QR2_TOTAL_MISMATCH']});
  assert.deepEqual(view.counts,{accounts:2,fields_checked:7,fields_mismatched:2});
  assert.equal('total' in view,false);
  assert.equal('allocation' in view,false);
  assert.equal('accounts' in view,false);
  assert.deepEqual(Object.keys(view).sort(),['code','counts','refused','status']);
  const text=JSON.stringify(view);
  for(const value of ['20.76','100.76','100.75','1721'])assert.equal(text.includes(value),false,value);
  // A tampered NAV breaks the same identity.
  assert.equal(run({accounts:[accountA({nav_to:num('1180.5')}),accountB()]}).refused,'QR2_TOTAL_MISMATCH');
  assert.equal(run({accounts:[accountA(),accountB({flows_total:num('21')})]}).refused,'QR2_TOTAL_MISMATCH');
});

test('the self-check refuses a sum error injected into the summing step (each line)',()=>{
  for(const f of ALLOCATION_SUM_FIELDS){
    const view=run({},{sum:(values,field)=>{const exact=aggregateExact(values);return field===f?exact+'1':exact;}});
    assert.equal(view.refused,'QR2_TOTAL_MISMATCH',f);
    assert.ok(view.counts.fields_mismatched>=1,f);
    assert.equal(view.counts.accounts,2,f);
  }
  // A seam that returns a non-decimal value or a number is refused, not summed.
  assert.equal(run({},{sum:()=>'abc'}).refused,'QR2_TOTAL_MISMATCH');
  assert.equal(run({},{sum:()=>5}).refused,'QR2_TOTAL_MISMATCH');
  // An honest seam passes: the default behaviour.
  assert.deepEqual(valuesOf(run({},{sum:values=>aggregateExact(values)}).total),TOTAL_AB);
});
// An independent hand sum for the seam test (BigInt over two decimals of the fixtures; every fixture value has at most two decimals).
function aggregateExact(values){
  const cents=values.reduce((t,v)=>{const negative=v.startsWith('-');const [w,f='']=(negative?v.slice(1):v).split('.');const n=BigInt(w+f.padEnd(2,'0'));return t+(negative?-n:n);},0n);
  const negative=cents<0n,abs=negative?-cents:cents,whole=abs/100n,frac=abs%100n;
  const text=frac===0n?String(whole):whole+'.'+String(frac).padStart(2,'0').replace(/0$/,'');
  return (negative?'-':'')+text;
}

test('the self-check refuses cancelling per-member identity errors that keep the total identity',()=>{
  // A money PnL 80.01 (+0.01) and B money PnL 20.74 (-0.01): the total is still 100.75 and the total identity holds, but each member breaks it.
  const view=run({accounts:[accountA({money_pnl:num('80.01')}),accountB({money_pnl:num('20.74')})]});
  assert.equal(view.refused,'QR2_TOTAL_MISMATCH');
  assert.deepEqual(view.counts,{accounts:2,fields_checked:7,fields_mismatched:1});
  assert.equal('total' in view,false);
  // One member off alone breaks both the member identity and the total identity.
  assert.deepEqual(run({accounts:[accountA({money_pnl:num('80.01')}),accountB()]}).counts,{accounts:2,fields_checked:7,fields_mismatched:2});
});

/* ------------------------------------------------------------------ determinism and input errors */

test('the result is deterministic, independent of input order, and the input is not changed',()=>{
  const input=build({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-b','bot-a'],T0-DAY)],owner_bots:bots(['bot-b',T0-9*DAY],['bot-a',T0-10*DAY]),accounts:[accountB(),accountA()]});
  const frozen=JSON.stringify(input);
  const first=aggregateOwnerTotal(input);
  assert.equal(JSON.stringify(input),frozen);
  const reordered=aggregateOwnerTotal(build());
  assert.deepEqual(first,reordered);
  assert.equal(JSON.stringify(first),JSON.stringify(aggregateOwnerTotal(input)));
  assert.deepEqual(first.accounts.map(a=>a.bot_id),['bot-a','bot-b']);
  assert.deepEqual(Object.keys(first.total),['label','notice','nav_from','nav_to','flows_total','fees','money_pnl','twr','mwr','member_count','members']);
});

test('a malformed input is QR2_INPUT_INVALID, never a number',()=>{
  const invalid=over=>throwsCode(()=>run(over),'QR2_INPUT_INVALID');
  invalid({currency:'EUR'});
  invalid({range:{from:T1,to:T0}});
  invalid({range:{from:T0,to:T0}});
  invalid({range:null});
  invalid({declarations:'x'});
  invalid({declarations:[decl(0,'INDEPENDENT_ACCOUNTS',['bot-a'],T0)]});
  invalid({declarations:[decl(1,'POOL',['bot-a'],T0)]});
  invalid({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',[],T0)]});
  invalid({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-a'],T0)]});
  invalid({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0+0.5)]});
  invalid({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0),decl(1,'SHARED_HYPOTHETICAL',['bot-a'],T0)]});
  invalid({declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0+DAY),decl(2,'INDEPENDENT_ACCOUNTS',['bot-a'],T0)]});
  invalid({owner_bots:[...bots(['bot-a',0]),...bots(['bot-a',1])]});
  invalid({owner_bots:[{bot_id:'bot-a',created_at:'0'}]});
  invalid({accounts:[accountA(),accountA()]});
  invalid({accounts:[accountA({bot_id:'bot-zz'})]});
  invalid({accounts:[accountA({nav_to:{value:1180,status:COMPLETE,reasons:[]}})]});
  invalid({accounts:[accountA({nav_to:{value:'12abc',status:COMPLETE,reasons:[]}})]});
  invalid({accounts:[accountA({nav_to:{value:'1180',status:UNAVAILABLE,reasons:[]}})]});
  invalid({accounts:[accountA({fees:undefined})]});
  invalid({accounts:[accountA({keys:undefined})]});
  invalid({accounts:[accountA({reconciliation:{state:'UNKNOWN',failed_from:null}})]});
  invalid({accounts:[accountA({status:{status:'SOMETHING',overlays:[],reasons:[]}})]});
  invalid({accounts:[{...accountA(),status:{status:REFUSED,overlays:[],reasons:[]},code:null}]});
  throwsCode(()=>aggregateOwnerTotal(null),'QR2_INPUT_INVALID');
  // An account of a Bot outside the owner set is an adapter error.
  invalid({accounts:[accountA({bot_id:'bot-zz'}),accountB()]});
});

test('G1: an account of a Bot created at or after range.to is dropped before the set check and is not part of the total',()=>{
  const later=created=>run({owner_bots:bots(['bot-a',T0-DAY],['bot-b',created]),declarations:[decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0-DAY)],accounts:[accountA(),accountB()]});
  for(const created of [T1,T1+DAY]){
    const view=later(created);
    assert.equal(view.allocation.reason,null,String(created));
    // The total is account A alone: nav 1000 -> 1180, flows 100, fees 3.5, money PnL 80.
    assert.deepEqual(valuesOf(view.total),{nav_from:'1000',nav_to:'1180',flows_total:'100',fees:'3.5',money_pnl:'80'},String(created));
    assert.equal(view.total.member_count,1);
    assert.deepEqual(view.accounts.map(a=>a.bot_id),['bot-a']);
  }
  // A Bot created one ms before to has a row in the range: its account stays and the undeclared Bot changes the set.
  assert.equal(later(T1-1).allocation.reason,'ALLOCATION_SET_CHANGED');
  // An account of a Bot outside the owner set is still an input error after the drop.
  throwsCode(()=>run({accounts:[accountA(),accountB({bot_id:'bot-zz'})]}),'QR2_INPUT_INVALID');
});

test('the module codes are exported and the two new codes are defined here',()=>{
  assert.equal(ALLOCATION_CODES.ALLOCATION_DECLARATION_CHANGED,'ALLOCATION_DECLARATION_CHANGED');
  assert.equal(ALLOCATION_CODES.ALLOCATION_RANGE_MISMATCH,'ALLOCATION_RANGE_MISMATCH');
  assert.equal(Object.isFrozen(ALLOCATION_CODES),true);
  for(const [name,value] of Object.entries(ALLOCATION_CODES))assert.equal(name,value);
});

test('S4-5 scope refusals and duplicate keys dominate every declaration shortcut',()=>{
  const variants=[[],[decl(1,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0-DAY)],
    [decl(1,'INDEPENDENT_ACCOUNTS',['bot-a'],T0-DAY)],
    [decl(1,'INDEPENDENT_ACCOUNTS',['bot-a','bot-b'],T0-DAY),decl(2,'SHARED_HYPOTHETICAL',['bot-a','bot-b'],T0+DAY)]];
  for(const declarations of variants){
    for(const code of ['QR2_CROSS_BOT_ROW','QR2_NON_PAPER_ROW']){
      const result=run({declarations,accounts:[accountA(),{bot_id:'bot-b',broker:'binance-global',currency:'USDT',status:{status:REFUSED,overlays:[],reasons:[code]},code}]});
      assert.equal(result.code,code);assert.equal(result.status.status,REFUSED);
      for(const key of ['accounts','allocation','total'])assert.equal(result[key],undefined);
    }
    const result=run({declarations,accounts:[accountA(),accountB({keys:accountA().keys})]});
    assert.equal(result.code,'QR2_CROSS_BOT_ROW');assert.equal(result.accounts,undefined);assert.equal(result.total,undefined);
  }
});
