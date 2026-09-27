import test from 'node:test';
import assert from 'node:assert/strict';
import {runVenueRefreshJob} from '../src/postgres/venue-refresh-job.js';

test('finite producer spans more than two TTLs, logs recovery and never extends failed evidence',async()=>{
  let now=1000000,snapshotTime=null;const records=[];
  const store={db:{transaction:fn=>fn()}};
  const result=await runVenueRefreshJob({store,durationSeconds:140,clock:()=>now,wait:async ms=>{now+=ms;},log:r=>records.push(r),
    refresh:async(_store,symbol,{now:time})=>{assert.equal(symbol,'BTCUSDT');if(time===1040000)throw Object.assign(new Error(),{code:'VENUE_PROVIDER_UNAVAILABLE'});snapshotTime=time;return {retrievedAt:time,snapshotHash:'fixture'};}});
  assert.equal(result.attempts,8);assert.equal(result.successes,7);assert.equal(result.failures,1);
  assert.equal(result.endedAt-result.startedAt,140000);assert.equal(snapshotTime,1140000);
  const failed=records.find(r=>r.status==='FAILED');assert.equal(failed.expiresAt,undefined);
  assert.equal(records[3].status,'REFRESHED');assert.equal(result.status,'COMPLETED_WITH_FAILURES');
});
test('producer supports one-shot, rejects unbounded budgets and stops on cancellation',async()=>{
  const store={db:{transaction:fn=>fn()}},refresh=async()=>({retrievedAt:Date.now()});
  assert.equal((await runVenueRefreshJob({store,refresh})).attempts,1);
  for(const durationSeconds of [-1,601,Infinity])await assert.rejects(runVenueRefreshJob({store,refresh,durationSeconds}));
  const controller=new AbortController();controller.abort();
  const result=await runVenueRefreshJob({store,refresh,durationSeconds:60,signal:controller.signal});
  assert.equal(result.status,'STOPPED');assert.equal(result.attempts,0);
});
