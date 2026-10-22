import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr2Database,createOwner,createBot,setCapital,insertBars,barOf,openSecond,ledgerDigest,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {readQr2Snapshot} from '../../src/postgres/qr2-reader.js';
import {readQr2OwnerSnapshot} from '../../src/postgres/qr2-owner-reader.js';
import {createQr2ComputePool} from '../../src/postgres/qr2-compute-pool.js';
import {composeOwnerResponse,validateOwnerResponse} from '../../src/portfolio/qr2-owner-response.js';
import {buildBarCoverage} from '../../src/portfolio/qr2-coverage.js';
const M=60000;let f;
before(async()=>{f=await createQr2Database('robot_qr2_coverage_integration');await f.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));});
after(async()=>{await f?.dispose();});
// One shared isolated database; tests run sequentially. Future reporting clocks and changed
// registration timestamps below are explicitly synthetic fixture shaping, never runtime clocks.
const future=()=>Math.ceil(Date.now()/M)*M+M;
async function clearBars(){await f.db.query('DELETE FROM public.pine_market_bars');}
async function registration(bot,at){
 // Labelled synthetic chronology: these cash-only fixtures have only CONFIGURATION funding
 // and FUNDING snapshots. Move their timestamps together to one ms after registration;
 // amounts, snapshot IDs, order and stored cash remain the live writer's originals.
 await f.db.transaction(async()=>{
  await f.db.query('UPDATE public.users SET created_at=$2 WHERE id=$1',[bot.id,at]);
  const funding=(await f.db.query('SELECT kind FROM public.paper_funding WHERE user_id=$1',[bot.id])).rows;
  const snapshots=(await f.db.query('SELECT reason FROM public.paper_snapshots WHERE user_id=$1',[bot.id])).rows;
  assert.equal(funding.length,1);assert.equal(funding[0].kind,'CONFIGURATION');
  assert.equal(snapshots.length,1);assert.equal(snapshots[0].reason,'FUNDING');
  await f.db.query('UPDATE public.paper_funding SET at=$2 WHERE user_id=$1',[bot.id,at+1]);
  await f.db.query('UPDATE public.paper_snapshots SET at=$2 WHERE user_id=$1',[bot.id,at+1]);
 });
}
const args=(owner,bot,from,to)=>({ownerId:owner.id,botId:bot.id,broker:'binance-global',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2});
const unionReads=qs=>qs.filter(q=>q.sql.startsWith('SELECT bar_time::text AS bar_time'));
async function observed(fn){const query=f.db.query.bind(f.db),queries=[];f.db.query=async(sql,params)=>{queries.push({sql,params});return query(sql,params);};try{return {value:await fn(),queries};}finally{f.db.query=query;}}
function publicCoverage(read){const registry=read.snapshot.coverage,w=registry.windows[0],u=registry.unions[w.union_id];return buildBarCoverage({market:w.market,resolved_range:w.resolved_range,fact:u.fact.state==='COMPLETE'?{state:'COMPLETE',timestamps:u.fact.timestamps.slice(w.start_index,w.end_index)}:u.fact});}
function noInternalKeys(value){if(!value||typeof value!=='object')return;for(const[k,v]of Object.entries(value)){assert.ok(!['coverage','coverage_context','coverage_window_id','coverage_input_bytes','coverage_output_bytes'].includes(k),'no internal public key '+k);noInternalKeys(v);}}

test('coverage integration: five funded supported accounts share one nested union and preserve cash-only owner body',{timeout:45000},async()=>{
 await clearBars();const owner=await createOwner(f.store);await setCapital(f.store,owner,100);
 const bots=[owner];for(let i=1;i<5;i++)bots.push(await createBot(f.store,owner,100+i));
 const from=future(),to=from+6*M;for(let i=0;i<5;i++)await registration(bots[i],from+i*M);
 await insertBars(f.db,Array.from({length:6},(_,i)=>barOf(from+(i+1)*M,'62000')));
 const before=await Promise.all(bots.map(b=>ledgerDigest(f.db,b)));
 const {value:read,queries}=await observed(()=>readQr2OwnerSnapshot(f.store,{ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2}));
 assert.equal(read.snapshot.accounts.length,5);assert.equal(read.snapshot.ownerBots.length,5);assert.equal(unionReads(queries).length,1);assert.equal(read.snapshot.coverage.unions.length,1);assert.equal(read.snapshot.coverage.windows.length,5);
 for(let i=0;i<5;i++){const member=read.snapshot.accounts.find(a=>a.input.botId===bots[i].id),meta=read.input.coverage_context.accounts.find(a=>a.bot_id===bots[i].id),binding=read.snapshot.coverage.bindings.find(b=>b.bot_id===bots[i].id);assert.deepEqual(meta.resolved_range,{from:from+i*M,to});assert.equal(member.snapshot.coverage_window_id,binding.window_id);assert.equal(Object.hasOwn(member.snapshot,'coverage'),false);assert.equal(Object.hasOwn(member.input,'coverage_context'),false);assert.equal(member.snapshot.market.checked,false);}
 const baseline=composeOwnerResponse(read.snapshot,read.input),pool=createQr2ComputePool();try{const actual=await pool.run(read.snapshot,read.input);assert.equal(actual.ok,true);assert.deepEqual(actual.body,baseline.body);assert.equal(validateOwnerResponse(actual.body),true);for(let i=0;i<5;i++){const row=actual.body.accounts.find(a=>a.bot_id===bots[i].id);assert.equal(row.nav_from.value,'0');assert.equal(row.nav_to.value,String(100+i));assert.equal(row.flows_total.value,String(100+i));assert.equal(row.money_pnl.value,'0');}noInternalKeys(actual.body);}finally{await pool.close();}
 assert.deepEqual(await Promise.all(bots.map(b=>ledgerDigest(f.db,b))),before);
 // Aggregate failure on the last independently counted member: no coverage or member detail.
 const query=f.db.query.bind(f.db),seen=[];let auditCalls=0;
 f.db.query=async(sql,params)=>{seen.push(sql);const result=await query(sql,params);if(sql.startsWith('SELECT count(*) AS n FROM public.audit')&&++auditCalls===5)return {rows:[{n:2}]};return result;};
 try{await assert.rejects(readQr2OwnerSnapshot(f.store,{ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2,limits:{audit_rows:1}}),{code:'QR2_RANGE_ADMISSION_REFUSED'});assert.equal(auditCalls,5);assert.ok(!seen.some(sql=>sql.includes('pine_market_bars')||/^SELECT (id,user_id|f.signal_id|j.signal_id|position_id|user_id,account_id|id,side)/.test(sql)));}finally{f.db.query=query;}
});

test('coverage integration: no-fill exact gap, absent versus empty, and row sentinel refuse whole read',{timeout:45000},async()=>{
 await clearBars();const owner=await createOwner(f.store),bot=await createBot(f.store,owner,250),from=future(),to=from+3*M;await registration(bot,from);const input=args(owner,bot,from,to);
 await insertBars(f.db,[barOf(from+M,'62000'),barOf(from+3*M,'62000')]);
 const {value:read,queries}=await observed(()=>readQr2Snapshot(f.store,{...input,coverageBudgets:{timestamp_rows:2}}));
 assert.equal(read.snapshot.market.checked,false);assert.deepEqual(read.snapshot.coverage.unions[0].fact.timestamps,[from+M,from+3*M]);assert.equal(unionReads(queries).length,1);assert.equal(unionReads(queries)[0].params[5],3);
 const c=publicCoverage(read);assert.deepEqual([c.state,c.expected_minutes,c.stored_minutes,c.missing_minutes],['COMPLETE',3,2,1]);assert.deepEqual(c.intervals,[{from:from+M,to:from+2*M,missing_minutes:1}]);
 await insertBars(f.db,[barOf(from+2*M,'62000')]);const original=f.db.query.bind(f.db),seen=[];f.db.query=async(sql,params)=>{seen.push(sql);return original(sql,params);};
 try{await assert.rejects(readQr2Snapshot(f.store,{...input,coverageBudgets:{timestamp_rows:2}}),{code:'QR2_RANGE_ADMISSION_REFUSED'});assert.ok(!seen.some(sql=>sql.startsWith('SELECT id,user_id,broker,at,equity_delta')));}finally{f.db.query=original;}
 await clearBars();const empty=publicCoverage(await readQr2Snapshot(f.store,input));assert.deepEqual([empty.state,empty.expected_minutes,empty.stored_minutes,empty.missing_minutes],['COMPLETE',3,0,3]);assert.deepEqual(empty.intervals,[{from,to,missing_minutes:3}]);
 await f.db.query('ALTER TABLE public.pine_market_bars RENAME TO pine_market_bars_coverage_hidden');try{const {value:absent,queries:absentQueries}=await observed(()=>readQr2Snapshot(f.store,input));assert.equal(absent.snapshot.coverage.unions[0].fact.state,'TABLE_ABSENT');assert.equal(publicCoverage(absent).state,'UNAVAILABLE');assert.equal(unionReads(absentQueries).length,0);}finally{await f.db.query('ALTER TABLE public.pine_market_bars_coverage_hidden RENAME TO pine_market_bars');}
});

test('coverage integration: committed late timestamp is invisible until a fresh read snapshot',{timeout:45000},async()=>{
 await clearBars();const owner=await createOwner(f.store),bot=await createBot(f.store,owner,300),from=future(),to=from+3*M;await registration(bot,from);await insertBars(f.db,[barOf(from+M,'62000'),barOf(from+3*M,'62000')]);const input=args(owner,bot,from,to),second=openSecond(f),query=f.db.query.bind(f.db);let inserted=false;
 // The scoped user SELECT has already established the RR snapshot before this count returns.
 f.db.query=async(sql,params)=>{const answer=await query(sql,params);if(!inserted&&sql.startsWith('SELECT count(*) AS n FROM public.audit')){inserted=true;await insertBars(second.db,[barOf(from+2*M,'62000')]);}return answer;};
 let first;try{first=await readQr2Snapshot(f.store,input);}finally{f.db.query=query;await second.close();}
 assert.equal(inserted,true);assert.deepEqual(first.snapshot.coverage.unions[0].fact.timestamps,[from+M,from+3*M]);assert.equal(publicCoverage(first).missing_minutes,1);
 const fresh=await readQr2Snapshot(f.store,input);assert.deepEqual(fresh.snapshot.coverage.unions[0].fact.timestamps,[from+M,from+2*M,from+3*M]);assert.equal(publicCoverage(fresh).missing_minutes,0);assert.deepEqual(fresh.snapshot.range,first.snapshot.range);assert.deepEqual(fresh.input.coverage_context.accounts,first.input.coverage_context.accounts);
});
