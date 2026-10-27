import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr2Database,createOwner,createBot,setCapital,insertBars,barOf,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {readQr2Snapshot} from '../../src/postgres/qr2-reader.js';
import {readQr2OwnerSnapshot} from '../../src/postgres/qr2-owner-reader.js';
import {answerOfError} from '../../src/postgres/qr2-routes.js';
import {Qr2Error} from '../../src/portfolio/qr2-constants.js';
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

test('coverage admission: the real readers refuse a read-limit range as a request refusal, never a plain Error',{timeout:45000},async()=>{
 await f.db.query('DELETE FROM public.pine_market_bars');
 const owner=await createOwner(f.store),bot=await createBot(f.store,owner,250),from=future(),to=from+3*M;await registration(bot,from);
 await insertBars(f.db,[barOf(from+M,'62000'),barOf(from+2*M,'62000'),barOf(from+3*M,'62000')]);
 const input={ownerId:owner.id,botId:bot.id,broker:'binance-global',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2};

 // Per-Bot reader, row cap: three stored rows over a cap of two.
 const rows=await refusal(readQr2Snapshot(f.store,{...input,coverageBudgets:{timestamp_rows:2}}));
 assert.ok(rows instanceof Qr2Error);assert.equal(rows.code,'QR2_RANGE_ADMISSION_REFUSED');assert.deepEqual(rows.detail,{limit:'timestamp_rows',max:2});
 let answer=asRequest(rows);assert.equal(answer.status,422);assert.deepEqual(answer.body.detail,{limit:'timestamp_rows',max:2});

 // Per-Bot reader, span cap: a three minute range over a two minute cap, refused before any bar is read.
 const span=await refusal(readQr2Snapshot(f.store,{...input,coverageBudgets:{union_minutes:2}}));
 assert.ok(span instanceof Qr2Error);assert.deepEqual(span.detail,{limit:'union_minutes',value:3,max:2});
 answer=asRequest(span);assert.equal(answer.status,422);assert.equal(answer.body.code,'QR2_RANGE_ADMISSION_REFUSED');

 // Owner reader, both caps.
 const ownerInput={ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2};
 const ownerRows=await refusal(readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{timestamp_rows:2}}));
 assert.ok(ownerRows instanceof Qr2Error);assert.deepEqual(ownerRows.detail,{limit:'timestamp_rows',max:2});assert.equal(asRequest(ownerRows).status,422);
 const ownerSpan=await refusal(readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{union_minutes:2}}));
 assert.ok(ownerSpan instanceof Qr2Error);assert.deepEqual(ownerSpan.detail,{limit:'union_minutes',value:3,max:2});assert.equal(asRequest(ownerSpan).status,422);

 // Within the limits the same reads succeed: the cap, not the data, caused the refusal.
 assert.ok(await readQr2Snapshot(f.store,{...input,coverageBudgets:{timestamp_rows:3,union_minutes:3}}));
 assert.ok(await readQr2OwnerSnapshot(f.store,{...ownerInput,coverageBudgets:{timestamp_rows:3,union_minutes:3}}));
});
