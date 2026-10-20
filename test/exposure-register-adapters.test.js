import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {RULES} from '../src/quant-research/contract.js';
import {holdoutWindow} from '../src/quant-library/derive.js';
import {OWNER_RECOMMENDATION_CONTRACT_VERSIONS,CANDIDATE_BLOCKERS,evaluateBuildEligibility} from '../src/quant-library/package-gates.js';
import {CODES as QR3_CODES,REQUIRED_MARKET} from '../src/comparison/common.js';
import {exposuresOverlapping} from '../src/comparison/evidence.js';
import {CODES as QR4_CODES} from '../src/selection/codes.js';
import {overlapsExposure} from '../src/selection/window.js';
import {EXPOSURE_CODES,EXPOSURE_KINDS,appendExposures,readExposures,readExposuresLocked,toComparisonEntries,toPackageEntries} from '../src/postgres/exposure-register.js';
import {contractOf,metricsOf,parameters,hex,MINUTE} from './helpers/quant-library-fixture.mjs';

/*
 * QR-3 S2a adapter boundary, pure (no database, clock, network or file). One register row must be read the same way by the three
 * committed consumers: QR-3 evidence.js and QR-4 window.js take the half-open comparison shape, B0 package-gates.js takes the
 * inclusive package shape. The half-open to inclusive conversion is the main defect risk, so the touching-boundary cases run
 * against all three. Every row is a LABELLED FIXTURE (synthetic, never a research result).
 */
const OWNER='owner-a',MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},MARKET_KEY=canonical(REQUIRED_MARKET);
const CREATED='2026-10-19T11:30:00Z',CREATED_MS=Date.parse(CREATED);
const clone=value=>JSON.parse(JSON.stringify(value));
const withRate=(metric,rate)=>({...metric,win_rate:rate});

/** A reduced, internally consistent run: enough for B0 to reach the independence lookups (library gates G1 to G4 pass). */
function runFixture(){
  const contract=clone(contractOf({owner:OWNER,bot:'bot-a',deployment:'deployment-a',importId:'import-a',tag:'adapters'}));
  Object.assign(contract,{version:OWNER_RECOMMENDATION_CONTRACT_VERSIONS[0],acceptance_blockers:[...CANDIDATE_BLOCKERS]});
  const P=parameters(1);
  const evaluation=(kind,params,train,validation,test)=>({kind,parameters:params,train,validation,...(test?{test}:{})});
  const best=evaluation('CANDIDATE',P,withRate(metricsOf('4.1',9),'55.56'),withRate(metricsOf('3.2',8),'62.50'));
  const neighbour=(name,value)=>{const params={...P,[name]:value};return {dimension:name,parameters:params,result:evaluation('SENSITIVITY',params,metricsOf('3.0',9),metricsOf('2.9',8))};};
  const selected={parameters:P,result:best,screen_reasons:[],sensitivity:[neighbour('atr_multiplier',2),neighbour('rr',1.25),neighbour('emaFastInput',40)],
    cost_stress:evaluation('STRESS',P,metricsOf('3.5',9),metricsOf('2.4',8)),test:withRate(metricsOf('1.9',9,'1.5'),'66.67')};
  const result={scope:contract.scope,contract_hash:hash(canonical(contract)),selected,completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',holdout_evaluated:true,
    acceptance_blockers:contract.acceptance_blockers,candidate_count:6,candidates:[],search_algorithm:contract.plan.algorithm,seed:contract.plan.seed,budget:contract.plan.requested_budget,
    selected_dimensions:3,covered_dimensions:3,dimension_coverage_percent:100};
  return {owner_id:OWNER,run_id:'run-adapters',status:'SUCCEEDED',contract,result,created_at_utc:CREATED,integrity:{contract_hash_verified:true,report_matches_checkpoints:true}};
}
const RUN=runFixture();
const OWN=holdoutWindow(RUN.contract);                       // inclusive bar open times
const HOLDOUT={start_ms:OWN.start_time,end_ms:OWN.end_time+MINUTE}; // the same window, half-open

const row=(extra={})=>({exposure_id:'00000000-0000-4000-8000-000000000001',kind:'QR3_COMPARISON',owner_id:OWNER,...MARKET,start_ms:HOLDOUT.start_ms,end_ms:HOLDOUT.end_ms,
  comparison_id:'cmp-1',participant_run_id:'run-p1',source_hash:hex('source'),selection_id:null,at_ms:CREATED_MS-3600000,...extra});
const qr4=(extra={})=>row({kind:'QR4_SELECTION',comparison_id:null,participant_run_id:null,source_hash:null,selection_id:'sel-1',...extra});
const read=rows=>({ok:true,code:null,rows});

const qr3Hits=(rows,window=HOLDOUT,extra={})=>exposuresOverlapping({register:toComparisonEntries(read(rows)),owner_id:OWNER,market_key:MARKET_KEY,window,...extra});
const qr4Refusal=(rows,window=HOLDOUT)=>overlapsExposure(window,{register:toComparisonEntries(read(rows)),owner_id:OWNER});
const b0Codes=rows=>evaluateBuildEligibility({owner_id:OWNER,run:RUN,binding:{},internal:false,current_rules:clone(RULES),
  holdout:{earlier_holdouts:[],earlier_searched:[],registered_boundary:{exists:false},exposure_register:toPackageEntries(read(rows))}}).codes;
const EXPOSED='BI_HOLDOUT_EXPOSED_BY_SELECTION',B0_UNAVAILABLE='BI_EXPOSURE_REGISTER_UNAVAILABLE';
/** The three consumers' verdicts for one set of rows against the run's holdout window: [QR-3 flags, QR-4 flags, B0 flags]. */
const verdicts=(rows,window=HOLDOUT)=>[qr3Hits(rows,window).ids.length>0,qr4Refusal(rows,window)!==null,b0Codes(rows).includes(EXPOSED)];

test('one register row is flagged by QR-3, QR-4 and B0 alike, whichever kind it is',()=>{
  assert.deepEqual(verdicts([row()]),[true,true,true],'QR-3 event');
  assert.deepEqual(verdicts([qr4()]),[true,true,true],'QR-4 record');
  assert.deepEqual(qr3Hits([row()]).ids,['cmp-1']);assert.deepEqual(qr3Hits([qr4()]).ids,['sel-1']);
  assert.equal(qr4Refusal([row()]).code,QR4_CODES.QR4_WINDOW_EXPOSED);assert.equal(qr4Refusal([row()]).detail,'cmp-1');
  assert.equal(b0Codes([row()]).includes(B0_UNAVAILABLE),false);
  // several participants of one comparison give one id; a window inside, around and one bar over the edge all overlap
  assert.deepEqual(qr3Hits([row(),row({participant_run_id:'run-p2',exposure_id:'00000000-0000-4000-8000-000000000002'})]).ids,['cmp-1']);
  for(const [label,start,end] of [['inside',HOLDOUT.start_ms+MINUTE,HOLDOUT.end_ms-MINUTE],['around',HOLDOUT.start_ms-9*MINUTE,HOLDOUT.end_ms+9*MINUTE],
    ['one bar over the start',HOLDOUT.start_ms-MINUTE,HOLDOUT.start_ms+MINUTE],['one bar over the end',HOLDOUT.end_ms-MINUTE,HOLDOUT.end_ms+MINUTE]])
    assert.deepEqual(verdicts([row({start_ms:start,end_ms:end})]),[true,true,true],label);
});

test('a window that only touches the holdout is flagged by none of the three consumers (half-open to inclusive conversion)',()=>{
  const before=row({start_ms:HOLDOUT.start_ms-5*MINUTE,end_ms:HOLDOUT.start_ms});   // [t-5m, t): the last covered bar is t-1m
  const after=row({start_ms:HOLDOUT.end_ms,end_ms:HOLDOUT.end_ms+5*MINUTE});        // [e, e+5m): the first covered bar is e, one past the holdout
  assert.deepEqual(verdicts([before]),[false,false,false],'ends where the holdout starts');
  assert.deepEqual(verdicts([after]),[false,false,false],'starts where the holdout ends');
  assert.deepEqual(verdicts([qr4({start_ms:before.start_ms,end_ms:before.end_ms})]),[false,false,false]);
  assert.deepEqual(verdicts([qr4({start_ms:after.start_ms,end_ms:after.end_ms})]),[false,false,false]);
  // the contract case: exposure [t, t+60000) against a holdout that starts at t+60000 is the "before" row above with t = holdout start - 60000
  // the package conversion itself: the last covered bar is end_ms - 60000
  assert.deepEqual(toPackageEntries(read([before]))[0].window,{start_time:before.start_ms,end_time:HOLDOUT.start_ms-MINUTE});
  assert.deepEqual(toPackageEntries(read([row()]))[0].window,{start_time:OWN.start_time,end_time:OWN.end_time});
});

test('owner, market and time scope: another owner or market is not flagged; B0 counts an event only at or before the run creation time',()=>{
  assert.deepEqual(verdicts([row({owner_id:'owner-b'})]),[false,false,false],'another owner');
  assert.deepEqual(verdicts([qr4({owner_id:'owner-b'})]),[false,false,false]);
  // another market never reaches QR-3/QR-4 or B0 (the required market is fixed there)
  for(const field of ['broker','symbol','timeframe'])assert.deepEqual(verdicts([row({[field]:'other'})]),[false,false,false],'market '+field);
  // time: B0 and QR-3 (as_of_ms) count at_ms <= the run creation; QR-4 recheck counts every exposure
  assert.equal(b0Codes([row({at_ms:CREATED_MS})]).includes(EXPOSED),true,'equal time counts');
  assert.equal(b0Codes([row({at_ms:CREATED_MS-1})]).includes(EXPOSED),true,'a millisecond before counts');
  assert.equal(b0Codes([row({at_ms:CREATED_MS+1})]).includes(EXPOSED),false,'a millisecond after does not count');
  assert.equal(qr3Hits([row({at_ms:CREATED_MS+1})],HOLDOUT,{as_of_ms:CREATED_MS}).ids.length,0);
  assert.equal(qr3Hits([row({at_ms:CREATED_MS})],HOLDOUT,{as_of_ms:CREATED_MS}).ids.length,1);
  assert.notEqual(qr4Refusal([row({at_ms:CREATED_MS+1})]),null);
  // the own comparison is ignored by QR-3
  assert.equal(qr3Hits([row()],HOLDOUT,{comparison_id:'cmp-1'}).ids.length,0);
  assert.deepEqual(qr3Hits([row(),qr4()],HOLDOUT,{comparison_id:'cmp-1'}).ids,['sel-1']);
});

test('an absent or unreadable register gives each consumer its own unavailable code; an empty register is valid',()=>{
  const absent={ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null};
  assert.equal(toComparisonEntries(absent),null);assert.equal(toPackageEntries(absent),null);
  assert.equal(toComparisonEntries(null),null);assert.equal(toPackageEntries(undefined),null);assert.equal(toComparisonEntries({ok:true,rows:'x'}),null);
  const q3=exposuresOverlapping({register:toComparisonEntries(absent),owner_id:OWNER,market_key:MARKET_KEY,window:HOLDOUT});
  assert.equal(q3.ok,false);assert.equal(q3.code,QR3_CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE);
  const q4=overlapsExposure(HOLDOUT,{register:toComparisonEntries(absent),owner_id:OWNER});
  assert.equal(q4.code,QR4_CODES.QR4_EXPOSURE_REGISTRY_UNAVAILABLE);
  const b0=evaluateBuildEligibility({owner_id:OWNER,run:RUN,binding:{},internal:false,current_rules:clone(RULES),
    holdout:{earlier_holdouts:[],earlier_searched:[],registered_boundary:{exists:false},exposure_register:toPackageEntries(absent)}}).codes;
  assert.equal(b0.includes(B0_UNAVAILABLE),true);assert.equal(b0.includes(EXPOSED),false);
  // empty is valid: no flag, no unavailable code
  assert.deepEqual(toComparisonEntries(read([])),[]);assert.deepEqual(toPackageEntries(read([])),[]);
  assert.deepEqual(verdicts([]),[false,false,false]);
  assert.equal(b0Codes([]).includes(B0_UNAVAILABLE),false);
  assert.equal(qr3Hits([]).ok,true);
});

test('a row that breaks a table rule makes the whole read unavailable, never a partial list',()=>{
  const good=row();
  const bad=[['bad hash',row({source_hash:'ABC'})],['uppercase hash',row({source_hash:'A'.repeat(64)})],['short hash',row({source_hash:'a'.repeat(63)})],
    ['QR3 without comparison id',row({comparison_id:null})],['QR3 without participant',row({participant_run_id:''})],['QR3 with a selection id',row({selection_id:'sel-1'})],
    ['QR4 with a comparison id',qr4({comparison_id:'cmp-1'})],['QR4 with a source hash',qr4({source_hash:hex('x')})],['QR4 without selection id',qr4({selection_id:null})],
    ['unknown kind',row({kind:'OTHER'})],['misaligned start',row({start_ms:HOLDOUT.start_ms+1})],['misaligned end',row({end_ms:HOLDOUT.end_ms+1})],
    ['end equals start',row({end_ms:HOLDOUT.start_ms})],['end before start',row({end_ms:HOLDOUT.start_ms-MINUTE})],['negative start',row({start_ms:-MINUTE})],
    ['end beyond year 10000',row({start_ms:253402300800000,end_ms:253402300860000})],['start inside but end beyond year 10000',row({start_ms:253402300740000,end_ms:253402300860000})],
    ['negative at',row({at_ms:-1})],['at beyond year 9999',row({at_ms:253402300800000})],['fractional at',row({at_ms:1.5})],['non-numeric at',row({at_ms:'soon'})],
    ['empty owner',row({owner_id:''})],['empty broker',row({broker:''})],['empty symbol',row({symbol:null})],['empty timeframe',row({timeframe:''})],['not an object',null]];
  for(const [label,item] of bad){
    assert.equal(toComparisonEntries(read([good,item])),null,label);assert.equal(toPackageEntries(read([good,item])),null,label);
  }
  // pg returns bigint as strings from a plain client: accepted when exact digits, refused otherwise
  const strings=row({start_ms:String(HOLDOUT.start_ms),end_ms:String(HOLDOUT.end_ms),at_ms:String(CREATED_MS)});
  assert.equal(toComparisonEntries(read([strings]))[0].window.start_ms,HOLDOUT.start_ms);
  // the last valid minute-aligned end is exactly year 10000 (exclusive bound), matching the table CHECK
  assert.equal(toComparisonEntries(read([row({start_ms:253402300740000,end_ms:253402300800000})]))[0].window.end_ms,253402300800000);
  assert.equal(toComparisonEntries(read([row({at_ms:'12x'})])),null);
  assert.equal(toComparisonEntries(read([row({at_ms:'99999999999999999'})])),null);
});

test('entry shapes are exactly what each committed consumer documents',()=>{
  const qr3Row=row({at_ms:Date.UTC(2026,9,19,11,0,0,123)}),qr4Row=qr4({at_ms:Date.UTC(2026,9,19,11,0,0)});
  assert.deepEqual(toComparisonEntries(read([qr3Row,qr4Row])),[
    {owner_id:OWNER,market_key:MARKET_KEY,window:{start_ms:HOLDOUT.start_ms,end_ms:HOLDOUT.end_ms},kind:'QR3_COMPARISON',at_ms:qr3Row.at_ms,comparison_id:'cmp-1'},
    {owner_id:OWNER,market_key:MARKET_KEY,window:{start_ms:HOLDOUT.start_ms,end_ms:HOLDOUT.end_ms},kind:'QR4_SELECTION',at_ms:qr4Row.at_ms,selection_id:'sel-1'}]);
  assert.deepEqual(toPackageEntries(read([qr3Row,qr4Row])),[
    {owner_id:OWNER,market:{...MARKET},window:{start_time:OWN.start_time,end_time:OWN.end_time},at_utc:'2026-10-19T11:00:00.123Z',source_hash:hex('source'),comparison_id:'cmp-1'},
    {owner_id:OWNER,market:{...MARKET},window:{start_time:OWN.start_time,end_time:OWN.end_time},at_utc:'2026-10-19T11:00:00.000Z',selection_id:'sel-1'}]);
  // a QR-4 package entry carries no comparison_id key at all (B0 reads the key's presence), and a QR-3 one no selection_id key
  assert.equal(Object.hasOwn(toPackageEntries(read([qr4Row]))[0],'comparison_id'),false);assert.equal(Object.hasOwn(toPackageEntries(read([qr3Row]))[0],'selection_id'),false);
  assert.equal(Object.hasOwn(toComparisonEntries(read([qr4Row]))[0],'comparison_id'),false);assert.equal(Object.hasOwn(toComparisonEntries(read([qr3Row]))[0],'selection_id'),false);
  // a plain array of rows is accepted too; the market key equals the required-market key the consumers compute
  assert.equal(toComparisonEntries([qr3Row])[0].market_key,canonical(REQUIRED_MARKET));
  assert.equal(toPackageEntries([qr3Row]).length,1);
  assert.deepEqual([...EXPOSURE_KINDS],['QR3_COMPARISON','QR4_SELECTION']);
  // a row with all three at_utc fraction widths still passes B0's three-digit rule
  for(const at of [Date.UTC(2026,9,19,11,0,0,1),Date.UTC(2026,9,19,11,0,0,120),Date.UTC(2026,9,19,11,0,0,123)])
    assert.equal(b0Codes([row({at_ms:at})]).includes(B0_UNAVAILABLE),false);
});

/** A recording stand-in for a database that is inside the caller's transaction. */
function fakeDb({isTransaction=true,isolation='serializable',registerPresent=true,rows=[],markerRows=[{version:1}]}={}){
  const calls=[];
  return {calls,isTransaction,async query(sql,params=[]){
    calls.push({sql:sql.replace(/\s+/g,' ').trim(),params});
    if(/^LOCK TABLE/.test(sql))return {rows:[]};
    if(/current_setting/.test(sql))return {rows:[{level:isolation}]};
    if(/to_regclass/.test(sql))return {rows:[{register:registerPresent?'x':null,marker:registerPresent?'y':null}]};
    if(/^SELECT version/.test(sql))return {rows:markerRows};
    if(/^SELECT exposure_id/.test(sql))return {rows};
    if(/^INSERT/.test(sql))return {rows:[{exposure_id:params[0],kind:params[1],owner_id:params[2],broker:params[3],symbol:params[4],timeframe:params[5],start_ms:params[6],end_ms:params[7],
      comparison_id:params[8],participant_run_id:params[9],source_hash:params[10],selection_id:params[11],at_ms:params[12]}]};
    throw Error('unexpected statement '+sql);
  }};
}
const event=(extra={})=>({kind:'QR3_COMPARISON',window:{start_ms:HOLDOUT.start_ms,end_ms:HOLDOUT.end_ms},comparison_id:'cmp-9',participant_run_id:'run-9',source_hash:hex('source-9'),at_ms:CREATED_MS,...extra});
const call=(db,extra={})=>appendExposures(db,{owner_id:OWNER,...MARKET,events:[event()],...extra});

test('the writer validates before any statement, locks first, confirms SERIALIZABLE, reads, checks, then inserts',async()=>{
  // invalid input: nothing reaches the database
  for(const input of [{events:[]},{events:null},{events:[event({kind:'OTHER'})]},{events:[event({window:{start_ms:1,end_ms:2}})]},{events:[event({source_hash:'x'})]},
    {events:[event({window:{start_ms:String(HOLDOUT.start_ms),end_ms:HOLDOUT.end_ms}})]},{events:[event({window:{start_ms:253402300740000,end_ms:253402300860000}})]},{now:()=>'1'},{now:()=>253402300800000},{now:()=>1.5},{owner_id:''},{broker:''},
    {events:Array.from({length:501},()=>event())},{events:['x']}]){
    const db=fakeDb(),result=await call(db,input);
    assert.equal(result.ok,false,JSON.stringify(input).slice(0,80));assert.equal(result.code,EXPOSURE_CODES.EVENT_INVALID);assert.equal(db.calls.length,0,'no statement before validation');
  }
  // outside a transaction the writer refuses to start
  await assert.rejects(call(fakeDb({isTransaction:false})),/caller transaction/);
  await assert.rejects(appendExposures({isTransaction:true},{owner_id:OWNER,...MARKET,events:[event()]}),/caller transaction/);
  // the happy path: LOCK is the very first statement, then the isolation check, the read, and one INSERT per event
  const db=fakeDb(),result=await call(db,{events:[event(),event({participant_run_id:'run-10'}),{kind:'QR4_SELECTION',window:{start_ms:HOLDOUT.start_ms,end_ms:HOLDOUT.end_ms},selection_id:'sel-9',at_ms:CREATED_MS}]});
  assert.equal(result.ok,true);assert.equal(result.appended,3);
  assert.match(db.calls[0].sql,/^LOCK TABLE public\.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE$/);
  assert.match(db.calls[1].sql,/current_setting\('transaction_isolation'\)/);
  assert.match(db.calls[2].sql,/to_regclass/);assert.match(db.calls[3].sql,/^SELECT version FROM public\.quant_exposure_register_schema$/);
  assert.match(db.calls[4].sql,/^SELECT exposure_id.* FROM public\.quant_exposure_register WHERE owner_id=\$1/);
  assert.deepEqual(db.calls.slice(5).map(item=>item.sql.split(' ')[0]),['INSERT','INSERT','INSERT']);
  assert.ok(db.calls.every(item=>!/quant_exposure_register(?!_schema)/.test(item.sql)||/public\.quant_exposure_register/.test(item.sql)),'every relation is schema qualified');
  assert.deepEqual(result.rows.map(item=>item.kind),['QR3_COMPARISON','QR3_COMPARISON','QR4_SELECTION']);
  assert.match(result.rows[0].exposure_id,/^[0-9a-f-]{36}$/);assert.equal(new Set(result.rows.map(item=>item.exposure_id)).size,3,'a fresh id per event');
  // one clock read per call stamps every event; an at_ms on an event is ignored
  let reads=0;
  const stamped=fakeDb(),defaulted=await appendExposures(stamped,{owner_id:OWNER,...MARKET,events:[event({at_ms:7}),event({participant_run_id:'run-11',at_ms:CREATED_MS+99}),event({participant_run_id:'run-12',at_ms:undefined})],now:()=>{reads+=1;return CREATED_MS+5;}});
  assert.equal(reads,1);assert.deepEqual(defaulted.rows.map(item=>item.at_ms),[CREATED_MS+5,CREATED_MS+5,CREATED_MS+5]);
  assert.deepEqual(stamped.calls.filter(item=>/^INSERT/.test(item.sql)).map(item=>item.params[12]),[CREATED_MS+5,CREATED_MS+5,CREATED_MS+5]);
  // a transaction below SERIALIZABLE throws QR003 after the lock and before any read or write
  const weak=fakeDb({isolation:'repeatable read'});
  await assert.rejects(call(weak),error=>error.code==='QR003'&&/SERIALIZABLE/.test(error.message));
  assert.deepEqual(weak.calls.map(item=>item.sql.split(' ')[0]),['LOCK','SELECT']);
});

test('the writer appends only when the check under the lock allows it; an unreadable register writes nothing',async()=>{
  const stored=[row({exposure_id:'00000000-0000-4000-8000-0000000000aa'})];
  const refusing=fakeDb({rows:stored}),refused=await call(refusing,{check:({rows})=>toComparisonEntries({ok:true,rows}).length>0?'OVERLAP':null});
  assert.equal(refused.ok,false);assert.equal(refused.code,EXPOSURE_CODES.CHECK_REFUSED);assert.equal(refused.refusal,'OVERLAP');assert.equal(refused.appended,0);
  assert.equal(refusing.calls.some(item=>/^INSERT/.test(item.sql)),false,'a refused check writes nothing');
  for(const verdict of [null,undefined,false]){
    const allowing=fakeDb({rows:stored}),allowed=await call(allowing,{check:async()=>verdict});
    assert.equal(allowed.ok,true,String(verdict));assert.equal(allowing.calls.filter(item=>/^INSERT/.test(item.sql)).length,1);
  }
  const seen=[];
  await call(fakeDb({rows:stored}),{check:read=>{seen.push(read);return null;}});
  assert.equal(seen[0].ok,true);assert.deepEqual(seen[0].rows.map(item=>item.comparison_id),['cmp-1']);
  // an unreadable register throws (the caller transaction aborts) and writes nothing
  const missing=fakeDb({registerPresent:false});
  await assert.rejects(call(missing),error=>error.code===EXPOSURE_CODES.UNAVAILABLE);assert.equal(missing.calls.some(item=>/^INSERT/.test(item.sql)),false);
  for(const markerRows of [[],[{version:2}],[{version:1},{version:1}],[{version:'1'}]]){
    const badMarker=fakeDb({markerRows});
    await assert.rejects(call(badMarker),error=>error.code===EXPOSURE_CODES.UNAVAILABLE,JSON.stringify(markerRows));assert.equal(badMarker.calls.some(item=>/^INSERT/.test(item.sql)),false);
  }
  const tampered=fakeDb({rows:[row({source_hash:'bad'})]});
  await assert.rejects(call(tampered),error=>error.code===EXPOSURE_CODES.ROW_INVALID);assert.equal(tampered.calls.some(item=>/^INSERT/.test(item.sql)),false);
  const hugeEnd=fakeDb({rows:[row({start_ms:253402300740000,end_ms:253402300860000})]});
  await assert.rejects(call(hugeEnd),error=>error.code===EXPOSURE_CODES.ROW_INVALID);assert.equal(hugeEnd.calls.some(item=>/^INSERT/.test(item.sql)),false);
});

test('the reader needs a complete owner and market, reports an absent table as unavailable and qualifies every relation',async()=>{
  for(const input of [{},{owner_id:OWNER},{owner_id:OWNER,broker:'b',symbol:'s'},{owner_id:'',broker:'b',symbol:'s',timeframe:'1'}]){
    const db=fakeDb();assert.deepEqual(await readExposures(db,input),{ok:false,code:EXPOSURE_CODES.INPUT_INVALID,rows:null});assert.equal(db.calls.length,0);
  }
  assert.equal((await readExposures(null,{owner_id:OWNER,...MARKET})).ok,false);
  const absent=await readExposures(fakeDb({registerPresent:false}),{owner_id:OWNER,...MARKET});
  assert.deepEqual(absent,{ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null});
  for(const markerRows of [[],[{version:2}],[{version:1},{version:1}]])
    assert.deepEqual(await readExposures(fakeDb({markerRows}),{owner_id:OWNER,...MARKET}),{ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null},JSON.stringify(markerRows));
  const db=fakeDb({rows:[qr4({exposure_id:'00000000-0000-4000-8000-0000000000bb'})]}),found=await readExposures(db,{owner_id:OWNER,...MARKET});
  assert.equal(found.ok,true);assert.equal(found.rows[0].selection_id,'sel-1');assert.deepEqual(db.calls[2].params,[OWNER,'binance-global','BTCUSDT','1']);
  // the module is database-driver free and reads only the register through the caller's connection
  const source=fs.readFileSync(new URL('../src/postgres/exposure-register.js',import.meta.url),'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match=>match[1]),['node:crypto','../pine-bridge/source.js']);
  assert.ok(!/\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b/.test(source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'')),'the module never issues an UPDATE, DELETE or TRUNCATE');
});

test('readExposuresLocked: validates before any statement, locks first, confirms SERIALIZABLE, then reads and writes nothing',async()=>{
  for(const input of [{},{owner_id:OWNER},{owner_id:OWNER,broker:'b',symbol:'s'},{owner_id:'',broker:'b',symbol:'s',timeframe:'1'}]){
    const db=fakeDb();assert.deepEqual(await readExposuresLocked(db,input),{ok:false,code:EXPOSURE_CODES.INPUT_INVALID,rows:null});assert.equal(db.calls.length,0,'no statement before validation');
  }
  await assert.rejects(readExposuresLocked(fakeDb({isTransaction:false}),{owner_id:OWNER,...MARKET}),/caller transaction/);
  await assert.rejects(readExposuresLocked(null,{owner_id:OWNER,...MARKET}),/caller transaction/);
  const db=fakeDb({rows:[qr4({exposure_id:'00000000-0000-4000-8000-0000000000bb'})]}),found=await readExposuresLocked(db,{owner_id:OWNER,...MARKET});
  assert.equal(found.ok,true);assert.equal(found.rows[0].selection_id,'sel-1');
  assert.match(db.calls[0].sql,/^LOCK TABLE public.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE$/);
  assert.match(db.calls[1].sql,/current_setting\('transaction_isolation'\)/);
  assert.match(db.calls[2].sql,/to_regclass/);assert.match(db.calls[3].sql,/^SELECT version FROM public.quant_exposure_register_schema$/);assert.match(db.calls[4].sql,/^SELECT exposure_id/);
  assert.equal(db.calls.length,5);assert.equal(db.calls.some(item=>/^INSERT/.test(item.sql)),false,'a locked read writes nothing');
  // below SERIALIZABLE: QR003 after the lock and before any read
  const weak=fakeDb({isolation:'read committed'});
  await assert.rejects(readExposuresLocked(weak,{owner_id:OWNER,...MARKET}),error=>error.code==='QR003');assert.deepEqual(weak.calls.map(item=>item.sql.split(' ')[0]),['LOCK','SELECT']);
  // an unreadable register is ok:false, never an empty list
  assert.deepEqual(await readExposuresLocked(fakeDb({registerPresent:false}),{owner_id:OWNER,...MARKET}),{ok:false,code:EXPOSURE_CODES.UNAVAILABLE,rows:null});
});
