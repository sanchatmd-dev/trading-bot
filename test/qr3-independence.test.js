import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {EARLIER_ONE_PINE_SQL,EARLIER_SEARCHED_ONE_PINE_SQL,EFFECTIVE_BOUNDARY_SQL,BOUNDARY_SCOPE as BI_BOUNDARY_SCOPE} from '../src/postgres/bi-package-store.js';
import {EARLIER_HOLDOUTS_SQL,SEARCHED_SQL,BOUNDARY_SQL,BOUNDARY_SCOPE,INDEPENDENCE_VERSION,INDEPENDENCE_BUDGET,halfOpen,readIndependence} from '../src/postgres/qr3-independence.js';
import {windowsOverlap as inclusiveOverlap,holdoutWindow,marketKey,MINUTE} from '../src/quant-library/derive.js';
import {searchedWindow} from '../src/quant-library/package-gates.js';
import {windowsOverlap,classifyEvidence} from '../src/comparison/evidence.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';

// QR-3 hardening slice A (SB191): the create-time independence block. Pure parts run here; the real cluster runs in test/postgres/qr3-routes.test.mjs.
const T0=1800000000000;
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const OTHER={...MARKET,symbol:'ETHUSDT'};
const MKEY=marketKey({snapshot:{market:MARKET}});

/* ---- SQL parity: the three statements are the bi-package-store ones minus the run and time cutoffs ---- */

const CUTOFF=' AND j.run_id<>$2 AND (j.created_at,j.run_id)<($3::bigint,$2::text)';

test('the earlier-holdout statement is EARLIER_ONE_PINE_SQL without the run and time cutoffs and nothing else',()=>{
  assert.ok(EARLIER_ONE_PINE_SQL.includes(CUTOFF));
  assert.equal(EARLIER_HOLDOUTS_SQL,EARLIER_ONE_PINE_SQL.replace(CUTOFF,''));
  assert.doesNotMatch(EARLIER_HOLDOUTS_SQL,/\$2|\$3/);
});

test('the searched-window statement is EARLIER_SEARCHED_ONE_PINE_SQL without the run and time cutoffs, with the source hashes as the second parameter',()=>{
  assert.ok(EARLIER_SEARCHED_ONE_PINE_SQL.includes(CUTOFF));
  assert.equal(SEARCHED_SQL,EARLIER_SEARCHED_ONE_PINE_SQL.replace(CUTOFF,'').replace('ANY($4::text[])','ANY($2::text[])'));
  assert.match(SEARCHED_SQL,/j\.contract->>'source_hash'=ANY\(\$2::text\[\]\)/);
  assert.doesNotMatch(SEARCHED_SQL,/\$3|\$4|holdout_evaluated/,'every run of the source counts, whatever it evaluated');
});

test('the boundary statement and its scope are the B0 ones, byte for byte',()=>{
  assert.equal(BOUNDARY_SQL,EFFECTIVE_BOUNDARY_SQL);
  assert.deepEqual(BOUNDARY_SCOPE,BI_BOUNDARY_SCOPE);
  assert.deepEqual(Object.values(BOUNDARY_SCOPE),['binance-global','SPOT','BTCUSDT','1'],'the parameter order $3 to $6');
});

/* ---- window conversion ---- */

test('halfOpen: the inclusive open-time library window becomes [start, last open time + one minute); unreadable windows are null',()=>{
  assert.deepEqual(halfOpen({start_time:T0,end_time:T0}),{start_ms:T0,end_ms:T0+MINUTE});
  assert.deepEqual(halfOpen({start_time:T0,end_time:T0+9*MINUTE}),{start_ms:T0,end_ms:T0+10*MINUTE});
  for(const bad of [null,undefined,{},{start_time:T0},{start_time:T0,end_time:T0-MINUTE},{start_time:'1',end_time:2},{start_time:1.5,end_time:3},{start_time:T0,end_time:Number.MAX_SAFE_INTEGER}])
    assert.equal(halfOpen(bad),null,JSON.stringify(bad));
  assert.equal(halfOpen(holdoutWindow({dataset:{start_time:T0+1},split:{validation_end:1,test_end:2}})),null,'a holdout not on a minute boundary is unreadable');
});

test('halfOpen reproduces the G5 overlap rule exactly: touching windows do not overlap, one minute of overlap does',()=>{
  const inclusive=(from,to)=>({start_time:T0+from*MINUTE,end_time:T0+to*MINUTE});
  // [0, 9] and [10, 19] touch (the first ends with the open time of minute 9, the second starts at minute 10): no overlap
  assert.equal(windowsOverlap(halfOpen(inclusive(0,9)),halfOpen(inclusive(10,19))),false);
  assert.equal(inclusiveOverlap(inclusive(0,9),inclusive(10,19)),false);
  // [0, 10] and [10, 19] share the bar open at minute 10: overlap by one minute
  assert.equal(windowsOverlap(halfOpen(inclusive(0,10)),halfOpen(inclusive(10,19))),true);
  assert.equal(inclusiveOverlap(inclusive(0,10),inclusive(10,19)),true);
  // the same on a full grid of small windows: the two rules never differ
  for(let a0=0;a0<7;a0++)for(let a1=a0;a1<7;a1++)for(let b0=0;b0<7;b0++)for(let b1=b0;b1<7;b1++)
    assert.equal(windowsOverlap(halfOpen(inclusive(a0,a1)),halfOpen(inclusive(b0,b1))),inclusiveOverlap(inclusive(a0,a1),inclusive(b0,b1)),[a0,a1,b0,b1].join());
});

/* ---- the scripted handle ---- */

const row=(run_id,{start=T0-1000*MINUTE,validation_end=50,test_end=150,market=MARKET,split})=>({run_id,market,split:split===undefined?{validation_end,test_end}:split,start_time:start});
function handle({holdouts=[],searched=[],boundaryTable='quant_holdout_boundaries',boundaries=[],fail=null,register=[]}={}){
  const log=[];
  return {log,async query(sql,params=[]){
    log.push({sql,params});
    if(fail&&fail(sql))throw Object.assign(Error('read failed'),{code:'42501'});
    if(sql.startsWith('WITH earlier AS MATERIALIZED'))return {rows:holdouts.slice(0,params[1])};
    if(sql.startsWith('SELECT j.run_id,j.contract#>'))return {rows:searched.slice(0,params[2])};
    if(sql.startsWith("SELECT to_regclass('public.quant_exposure_register')"))return {rows:[register===null?{register:null,marker:null}:{register:'quant_exposure_register',marker:'quant_exposure_register_schema'}]};
    if(sql.startsWith('SELECT version FROM public.quant_exposure_register_schema'))return {rows:[{version:1}]};
    if(sql.startsWith('SELECT exposure_id,kind'))return {rows:register};
    if(sql.includes("to_regclass('public.quant_holdout_boundaries')"))return {rows:[{boundaries:boundaryTable}]};
    if(sql.startsWith('SELECT (SELECT min(sibling.holdout_start_time)'))return {rows:boundaries};
    throw Error('unscripted statement '+sql.slice(0,60));
  }};
}
const PERIOD={start_ms:T0,end_ms:T0+200*MINUTE};
const input=(over={})=>({owner_id:'o1',run_id:'own',bot_id:'bot-1',source_hash:'s'.repeat(64),market_key:MKEY,period:PERIOD,...over});

test('readIndependence: only entries that overlap the period are kept, in scan order, with half-open windows; the own parent holdout is the source window and never an earlier holdout',async()=>{
  // holdout windows (open times): overlap [T0-50m, T0+49m], touching [T0-50m, T0-1m], one-minute [T0-50m, T0], far, other market
  const db=handle({holdouts:[row('own',{start:T0-100*MINUTE,test_end:150}),row('over',{start:T0-100*MINUTE,test_end:150}),row('touch',{start:T0-100*MINUTE,test_end:100}),
    row('one',{start:T0-100*MINUTE,test_end:101}),row('eth',{start:T0-100*MINUTE,test_end:150,market:OTHER}),row('far',{start:T0-9000*MINUTE})],
  searched:[row('own',{start:T0-10*MINUTE,validation_end:100}),row('near',{start:T0-300*MINUTE,validation_end:301}),row('gone',{start:T0-300*MINUTE,validation_end:300}),
    row('eth',{start:T0-10*MINUTE,validation_end:100,market:OTHER})],boundaries:[{holdout_start_time:'1799000000000'}]});
  const read=await readIndependence(db,input({market_key:MKEY}));
  assert.equal(read.ok,true);
  const block=read.block;
  assert.equal(block.version,INDEPENDENCE_VERSION);
  assert.deepEqual(block.earlier_holdouts,[{run_id:'over',window:{start_ms:T0-50*MINUTE,end_ms:T0+50*MINUTE}},{run_id:'one',window:{start_ms:T0-50*MINUTE,end_ms:T0+MINUTE}}]);
  assert.deepEqual([block.source_holdout_state,block.source_holdout_window],['SET',{start_ms:T0-50*MINUTE,end_ms:T0+50*MINUTE}]);
  // searched: the own parent's own search counts (it is in-sample data); 'near' ends one minute into the period, 'gone' ends the minute before it
  assert.deepEqual(block.searched_windows.map(item=>item.run_id),['own','near']);
  assert.deepEqual(block.searched_windows[1].window,{start_ms:T0-300*MINUTE,end_ms:T0+MINUTE});
  assert.deepEqual(block.registered_boundary,{state:'SET',start_ms:1799000000000});
  assert.deepEqual(block.scanned,{holdout_rows:6,searched_rows:4});
  assert.deepEqual(Object.keys(block).sort(),['earlier_holdouts','registered_boundary','scanned','searched_windows','source_holdout_register','source_holdout_state','source_holdout_window','version']);
  // the statements carry the owner, the source hash list, the budget plus one and the Bot of the parent
  assert.deepEqual(db.log[0].params,['o1',INDEPENDENCE_BUDGET.max_rows_per_scan+1]);
  assert.deepEqual(db.log[1].params,['o1',['s'.repeat(64)],INDEPENDENCE_BUDGET.max_rows_per_scan+1]);
  assert.deepEqual(db.log.at(-1).params,['o1','bot-1','binance-global','SPOT','BTCUSDT','1']);
});

test('readIndependence: an unreadable row nulls its list, never an empty list; the own parent row only sets its own state',async()=>{
  const bad=await readIndependence(handle({holdouts:[row('x',{split:null})],searched:[row('y',{validation_end:0})]}),input({market_key:MKEY}));
  assert.deepEqual([bad.block.earlier_holdouts,bad.block.searched_windows],[null,null]);
  const nokey=await readIndependence(handle({holdouts:[row('x',{split:null,market:null})]}),input({market_key:MKEY}));
  assert.equal(nokey.block.earlier_holdouts,null,'a row without a readable market cannot be skipped');
  const skipped=await readIndependence(handle({holdouts:[row('x',{split:null,market:OTHER})]}),input({market_key:MKEY}));
  assert.deepEqual(skipped.block.earlier_holdouts,[]);
  const own=await readIndependence(handle({holdouts:[row('own',{split:null})]}),input({market_key:MKEY}));
  assert.deepEqual([own.block.source_holdout_state,own.block.source_holdout_window,own.block.earlier_holdouts],['UNAVAILABLE',null,[]]);
  const none=await readIndependence(handle(),input({market_key:MKEY}));
  assert.deepEqual([none.block.source_holdout_state,none.block.source_holdout_window,none.block.earlier_holdouts,none.block.searched_windows],['NONE',null,[],[]]);
});

test('readIndependence: the boundary is NONE for no row, SET for an integer, and UNAVAILABLE for an absent table, a missing Bot, a null or a non-integer value',async()=>{
  const state=async over=>(await readIndependence(handle(over.table),input(over.input??{}))).block.registered_boundary;
  assert.deepEqual(await state({table:{}}),{state:'NONE'});
  assert.deepEqual(await state({table:{boundaries:[{holdout_start_time:1799000000000}]}}),{state:'SET',start_ms:1799000000000});
  assert.deepEqual(await state({table:{boundaries:[{holdout_start_time:'1799000000000'}]}}),{state:'SET',start_ms:1799000000000});
  assert.deepEqual(await state({table:{boundaryTable:null}}),{state:'UNAVAILABLE'});
  assert.deepEqual(await state({table:{},input:{bot_id:null}}),{state:'UNAVAILABLE'});
  for(const value of [null,undefined,'12x','1.5',1.5,Number.NaN,'99999999999999999999'])assert.deepEqual(await state({table:{boundaries:[{holdout_start_time:value}]}}),{state:'UNAVAILABLE'},String(value));
});

test('readIndependence: a scan above the budget refuses with INDEPENDENCE_ROWS, the budget itself is read, and a database error passes through',async()=>{
  const rows=count=>Array.from({length:count},(_,index)=>row('r'+index,{start:T0-9000*MINUTE}));
  const limit=INDEPENDENCE_BUDGET.max_rows_per_scan;
  assert.deepEqual(await readIndependence(handle({holdouts:rows(limit+1)}),input()),{ok:false,detail:'INDEPENDENCE_ROWS'});
  assert.deepEqual(await readIndependence(handle({searched:rows(limit+1)}),input()),{ok:false,detail:'INDEPENDENCE_ROWS'});
  assert.equal((await readIndependence(handle({holdouts:rows(limit),searched:rows(limit)}),input())).ok,true);
  assert.deepEqual(await readIndependence(handle({holdouts:rows(4)}),input({limit:3})),{ok:false,detail:'INDEPENDENCE_ROWS'});
  for(const prefix of ['WITH earlier','SELECT j.run_id','SELECT to_regclass','SELECT (SELECT min'])
    await assert.rejects(readIndependence(handle({fail:sql=>sql.startsWith(prefix)}),input()),/read failed/,prefix);
  await assert.rejects(readIndependence(handle(),input({owner_id:null})),/QR3_INDEPENDENCE_INPUT/);
  await assert.rejects(readIndependence(handle(),input({limit:0})),/QR3_INDEPENDENCE_INPUT/);
});

/* ---- SB191 finding P2: the source-holdout register ---- */

const exposureRow=(id,from,to,{kind='QR3_COMPARISON',at=T0-5000*MINUTE,symbol='BTCUSDT',owner='o1'}={})=>({exposure_id:'e-'+id,kind,owner_id:owner,broker:'binance-global',symbol,timeframe:'1',start_ms:from,end_ms:to,
  comparison_id:kind==='QR3_COMPARISON'?id:null,participant_run_id:kind==='QR3_COMPARISON'?'p-'+id:null,source_hash:kind==='QR3_COMPARISON'?'a'.repeat(64):null,selection_id:kind==='QR4_SELECTION'?id:null,at_ms:at});
const OWN_HOLDOUT=row('own',{start:T0-1000*MINUTE,validation_end:50,test_end:150});   // holdout open times T0-950m .. T0-851m, half-open [T0-950m, T0-850m)
const sourceWindow={start_ms:T0-950*MINUTE,end_ms:T0-850*MINUTE};

test('source_holdout_register: entries that overlap the parent holdout window but not the comparison period are stored, in the comparison shape, even when they are later than the parent',async()=>{
  const register=[exposureRow('c-hold',T0-900*MINUTE,T0-800*MINUTE,{at:T0+MINUTE}),exposureRow('s-hold',T0-1200*MINUTE,T0-940*MINUTE,{kind:'QR4_SELECTION',at:T0-5000*MINUTE}),
    exposureRow('c-touch',T0-850*MINUTE,T0-800*MINUTE),exposureRow('c-period',T0,T0+100*MINUTE),
    exposureRow('c-hold',T0-900*MINUTE,T0-800*MINUTE,{at:T0+MINUTE})];
  const db=handle({holdouts:[OWN_HOLDOUT],register});
  const block=(await readIndependence(db,input({market_key:MKEY}))).block;
  assert.deepEqual(block.source_holdout_window,sourceWindow);
  // the second row is a selection, the touching row and the period row do not overlap the holdout; the duplicate row collapses; the SQL scopes the read to owner and market (the params below)
  assert.deepEqual(block.source_holdout_register,[{kind:'QR4_SELECTION',id:'s-hold',window:{start_ms:T0-1200*MINUTE,end_ms:T0-940*MINUTE},at_ms:T0-5000*MINUTE},
    {kind:'QR3_COMPARISON',id:'c-hold',window:{start_ms:T0-900*MINUTE,end_ms:T0-800*MINUTE},at_ms:T0+MINUTE}]);
  const query=db.log.find(entry=>entry.sql.startsWith('SELECT exposure_id,kind'));
  assert.deepEqual(query.params,['o1','binance-global','BTCUSDT','1']);
});

test('source_holdout_register: the stored list makes the evidence classifier see an exposure of the parent holdout that the period-scoped prior list never held (the P2 case)',async()=>{
  // the exposure overlaps the parent holdout, and neither overlaps the comparison period
  const exposure=exposureRow('c-hold',T0-900*MINUTE,T0-800*MINUTE,{at:T0-100*MINUTE});
  const block=(await readIndependence(handle({holdouts:[OWN_HOLDOUT],register:[exposure]}),input({market_key:MKEY}))).block;
  assert.equal(windowsOverlap(block.source_holdout_register[0].window,PERIOD),false);
  const entries=list=>list.map(item=>({owner_id:'o1',market_key:MKEY,window:item.window,kind:item.kind,at_ms:item.at_ms,...(item.kind==='QR3_COMPARISON'?{comparison_id:item.id}:{selection_id:item.id})}));
  const classify=register=>classifyEvidence(evidenceInput({source_holdout_window:block.source_holdout_window,exposure_register:register}));
  const seen=classify(entries(block.source_holdout_register));
  assert.deepEqual([seen.evidence_class,seen.reasons,seen.exposed_by],['DEVELOPMENT_EVIDENCE',['HOLDOUT_EXPOSED_BY_COMPARISON'],['c-hold']]);
  // the period-scoped prior list of the store (here: empty, nothing overlaps the period) misses it
  const missed=classify([]);
  assert.deepEqual([missed.evidence_class,missed.reasons],['INDEPENDENT',[]]);
});

test('source_holdout_register: null (never []) when the register is unreadable or the own holdout window is unreadable; [] only when the parent evaluated no holdout or none overlaps',async()=>{
  const read=async over=>(await readIndependence(handle(over),input({market_key:MKEY}))).block;
  assert.equal((await read({holdouts:[OWN_HOLDOUT],register:null})).source_holdout_register,null,'absent register table');
  assert.equal((await read({holdouts:[row('own',{split:null})],register:[exposureRow('c',T0-900*MINUTE,T0-800*MINUTE)]})).source_holdout_register,null,'own holdout unreadable');
  assert.deepEqual((await read({register:[exposureRow('c',T0-900*MINUTE,T0-800*MINUTE)]})).source_holdout_register,[],'no own holdout: nothing to overlap');
  assert.deepEqual((await read({holdouts:[OWN_HOLDOUT],register:[exposureRow('far',T0,T0+MINUTE)]})).source_holdout_register,[],'readable register, no overlap');
  // a row that breaks a register rule makes the read unavailable, never a shorter list
  assert.equal((await read({holdouts:[OWN_HOLDOUT],register:[{...exposureRow('bad',T0-900*MINUTE,T0-800*MINUTE),end_ms:T0-900*MINUTE}]})).source_holdout_register,null);
  // a register read failure passes through (the create fails closed)
  await assert.rejects(readIndependence(handle({holdouts:[OWN_HOLDOUT],fail:sql=>sql.startsWith('SELECT exposure_id,kind')}),input({market_key:MKEY})),/read failed/);
});

/* ---- the stored lists give the same verdict as the full lists ---- */

const evidenceInput=(patch={})=>({participant_id:'p1',owner_id:'o1',market_key:MKEY,source_hash:'s'.repeat(64),window:PERIOD,record_created_at_ms:2000,frozen_at_ms:1000,as_of_ms:null,comparison_id:'c-now',
  spec_hash:'h',record_comparison_id:'c-now',record_spec_hash:'h',viewable_before_freeze:false,from_stored_view:false,imported:false,no_screened_candidate:false,earlier_holdouts:[],searched_windows:[],
  source_holdout_window:null,exposure_register:[],registered_boundary_ms:null,
  library_gates:['G1','G2','G3','G4','G5','G6','G7','G8'].map(gate=>({gate,state:'PASS',pass:true,codes:[]})),...patch});

test('filter equivalence: the evidence verdict over the stored (overlapping) entries equals the verdict over the full scan, for every period around the windows',async()=>{
  const holdouts=[],searched=[];
  for(let shift=-30;shift<=30;shift+=5){
    holdouts.push(row('h'+shift,{start:T0+shift*MINUTE,validation_end:10,test_end:25}));
    searched.push(row('s'+shift,{start:T0+shift*MINUTE,validation_end:12,test_end:30}));
  }
  const full=(rows,make)=>rows.map(item=>({owner_id:'o1',...make(item)}));
  for(let from=-40;from<=40;from+=3)for(const length of [1,7,20]){
    const period={start_ms:T0+from*MINUTE,end_ms:T0+(from+length)*MINUTE};
    const read=await readIndependence(handle({holdouts,searched}),input({market_key:MKEY,period}));
    const everything=evidenceInput({window:period,
      earlier_holdouts:full(holdouts,item=>({market_key:MKEY,window:halfOpen(holdoutWindow({dataset:{start_time:item.start_time},split:item.split}))})),
      searched_windows:full(searched,item=>({source_hash:'s'.repeat(64),window:halfOpen(searchedWindow({dataset:{start_time:item.start_time},split:item.split}))}))});
    const stored=evidenceInput({window:period,earlier_holdouts:read.block.earlier_holdouts.map(item=>({owner_id:'o1',market_key:MKEY,window:item.window})),
      searched_windows:read.block.searched_windows.map(item=>({owner_id:'o1',source_hash:'s'.repeat(64),window:item.window}))});
    assert.deepEqual(classifyEvidence(stored),classifyEvidence(everything),JSON.stringify(period));
  }
  // and the lists are not vacuous: a period inside a holdout is flagged by the stored lists too
  const read=await readIndependence(handle({holdouts,searched}),input({market_key:MKEY,period:{start_ms:T0+10*MINUTE,end_ms:T0+12*MINUTE}}));
  const verdict=classifyEvidence(evidenceInput({window:{start_ms:T0+10*MINUTE,end_ms:T0+12*MINUTE},earlier_holdouts:read.block.earlier_holdouts.map(item=>({owner_id:'o1',market_key:MKEY,window:item.window})),
    searched_windows:read.block.searched_windows.map(item=>({owner_id:'o1',source_hash:'s'.repeat(64),window:item.window}))}));
  assert.deepEqual([...verdict.reasons].sort(),['QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT','QR3_WINDOW_OVERLAPS_SEARCHED_DATA']);
  assert.equal(read.block.earlier_holdouts.length>0&&read.block.searched_windows.length>0,true);
});

/* ---- the module stays outside the evaluation closure ---- */

test('the module is outside the runtime manifest and imported by the route module only',async()=>{
  assert.ok(!QUANT_RUNTIME_ENGINE_FILES.includes('src/postgres/qr3-independence.js'));
  assert.ok(!QUANT_RUNTIME_ENGINE_FILES.includes('src/postgres/qr3-routes.js'));
  const importers=[];
  for(const dir of ['src','src/postgres','src/comparison','src/quant-research','src/quant-library'])
    for(const name of await fs.readdir(dir)){
      if(!name.endsWith('.js'))continue;
      if((await fs.readFile(dir+'/'+name,'utf8')).match(/['"][^'"]*qr3-independence(?:.js)?['"]/))importers.push(dir+'/'+name);
    }
  assert.deepEqual(importers,['src/postgres/qr3-routes.js']);
});
