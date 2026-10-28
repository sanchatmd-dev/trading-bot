import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr2Database,createOwner,createBot,setCapital,insertBars,barOf,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {readQr2Snapshot} from '../../src/postgres/qr2-reader.js';
import {readQr2OwnerSnapshot} from '../../src/postgres/qr2-owner-reader.js';
import {answerOfError} from '../../src/postgres/qr2-routes.js';
import {Qr2Error} from '../../src/portfolio/qr2-constants.js';
import {validateCoverageSnapshot} from '../../src/portfolio/qr2-coverage-snapshot.js';
import {projectPublicCoverage} from '../../src/portfolio/qr2-coverage-public.js';
const M=60000;let f;
before(async()=>{f=await createQr2Database('robot_qr2_coverage_admission');await f.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));});
after(async()=>{await f?.dispose();});
// Synthetic future chronology, as in the coverage integration suite: the bars and the registration are fixture shaping, never runtime clocks.
const future=()=>Math.ceil(Date.now()/M)*M+M;
async function registration(bot,at){
 await f.db.transaction(async()=>{
  await f.db.query('UPDATE public.users SET created_at=$2 WHERE id=$1',[bot.id,at]);
  await f.db.query('UPDATE public.paper_funding SET at=$2 WHERE user_id=$1',[bot.id,at+1]);
  await f.db.query('UPDATE public.paper_snapshots SET at=$2 WHERE user_id=$1',[bot.id,at+1]);
 });
}
const refusal=async(promise)=>{try{await promise;}catch(error){return error;}throw new Error('expected a refusal');};
const asRequest=error=>answerOfError(error,2);

test('coverage admission: a degradable stop returns a degraded registry on the real readers; a zero-row byte refusal stays a request refusal',{timeout:45000},async()=>{
 await f.db.query('DELETE FROM public.pine_market_bars');
 const owner=await createOwner(f.store),bot=await createBot(f.store,owner,250),from=future(),to=from+3*M;await registration(bot,from);
 await insertBars(f.db,[barOf(from+M,'62000'),barOf(from+2*M,'62000'),barOf(from+3*M,'62000')]);
 const input={ownerId:owner.id,botId:bot.id,broker:'binance-global',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2};
 const factsOf=read=>read.snapshot.coverage.unions.map(u=>u.fact);
 const publicOf=read=>projectPublicCoverage(read.snapshot.coverage,read.input.coverage_context);

 // Per-Bot reader, row cap: three stored rows over a cap of two. The read goes on and only bar coverage reads UNAVAILABLE.
 const rows=await readQr2Snapshot(f.store,{...input,coverageBudgets:{timestamp_rows:2}});
 assert.deepEqual(factsOf(rows),[{state:'BUDGET_EXCEEDED',limit:'timestamp_rows'}]);
 assert.deepEqual(validateCoverageSnapshot(rows.snapshot.coverage,rows.input.coverage_context),{ok:true});
 const rowsCoverage=publicOf(rows).accounts[0].market_data.coverage;
 assert.deepEqual([rowsCoverage.state,rowsCoverage.reason,rowsCoverage.complete,rowsCoverage.stored_minutes,rowsCoverage.intervals],['UNAVAILABLE','COVERAGE_BUDGET_EXCEEDED',false,null,null]);

 // Per-Bot reader, span cap: a three minute range over a two minute cap. No bar is read.
 const span=await readQr2Snapshot(f.store,{...input,coverageBudgets:{union_minutes:2}});
 assert.deepEqual(factsOf(span),[{state:'BUDGET_EXCEEDED',limit:'union_minutes'}]);
 assert.equal(span.snapshot.coverage.charges.union_minutes,3);assert.equal(span.snapshot.coverage.charges.timestamp_rows,0);
 assert.deepEqual(validateCoverageSnapshot(span.snapshot.coverage,span.input.coverage_context),{ok:true});
 assert.equal(publicOf(span).accounts[0].market_data.coverage.reason,'COVERAGE_BUDGET_EXCEEDED');

 // Owner reader, both caps.
 const ownerInput={ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2};
 const ownerRows=await readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{timestamp_rows:2}});
 assert.deepEqual(factsOf(ownerRows),[{state:'BUDGET_EXCEEDED',limit:'timestamp_rows'}]);
 assert.ok(publicOf(ownerRows).owner.market_coverage.entries.every(e=>e.coverage.reason==='COVERAGE_BUDGET_EXCEEDED'));
 const ownerSpan=await readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{union_minutes:2}});
 assert.deepEqual(factsOf(ownerSpan),[{state:'BUDGET_EXCEEDED',limit:'union_minutes'}]);
 assert.deepEqual(validateCoverageSnapshot(ownerSpan.snapshot.coverage,ownerSpan.input.coverage_context),{ok:true});

 // The financial read is the same with and without the degrade.
 const whole=await readQr2Snapshot(f.store,{...input,coverageBudgets:{timestamp_rows:3,union_minutes:3}});
 assert.deepEqual(factsOf(whole).map(fact=>fact.state),['COMPLETE'],'within the limits the same read inspects the bars: the cap, not the data, caused the degrade');
 for(const key of ['owner','coverageStart','range','counts','fundings','fills','journal','lots','positions','cash','snapshots','auditRows','pending','exposure','market'])
  assert.deepEqual(rows.snapshot[key],whole.snapshot[key],key);
 assert.ok(await readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{timestamp_rows:3,union_minutes:3}}));

 // A zero-row byte refusal is not degradable: it keeps the request refusal (422) with the limit in the detail.
 const bytes=await refusal(readQr2Snapshot(f.store,{...input,coverageBudgets:{coverage_input_bytes:1500}}));
 assert.ok(bytes instanceof Qr2Error);assert.equal(bytes.code,'QR2_RANGE_ADMISSION_REFUSED');assert.equal(bytes.detail.limit,'coverage_input_bytes');
 const answer=asRequest(bytes);assert.equal(answer.status,422);assert.equal(answer.body.detail.limit,'coverage_input_bytes');
 const ownerBytes=await refusal(readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{coverage_input_bytes:1500}}));
 assert.ok(ownerBytes instanceof Qr2Error);assert.equal(ownerBytes.detail.limit,'coverage_input_bytes');assert.equal(asRequest(ownerBytes).status,422);
});
