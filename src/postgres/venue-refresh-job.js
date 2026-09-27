import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {refreshPaperVenue} from './risk-venue.js';

// Supervised, finite job. Scheduling a permanent producer is a separate rollout
// action; this module never changes services or refreshes execution-owner locks.
export async function runVenueRefreshJob({store,durationSeconds=0,intervalSeconds=20,
  clock=Date.now,wait=sleep,signal,refresh=refreshPaperVenue,log=()=>{}}){
  if(!Number.isInteger(durationSeconds)||durationSeconds<0||durationSeconds>600||
    !Number.isInteger(intervalSeconds)||intervalSeconds<15||intervalSeconds>30)throw new Error('Invalid bounded venue job budget');
  const jobId=randomUUID(),startedAt=clock(),deadline=startedAt+durationSeconds*1000;
  let attempts=0,successes=0,failures=0;
  do{
    if(signal?.aborted)break;
    attempts++;
    try{
      const result=await store.db.transaction(()=>refresh(store,'BTCUSDT',{now:clock()}));
      successes++;log({jobId,attempt:attempts,status:'REFRESHED',...result,expiresAt:result.retrievedAt+60000});
    }catch(error){failures++;log({jobId,attempt:attempts,status:'FAILED',code:error.code||'VENUE_REFRESH_FAILED'});}
    if(durationSeconds===0||clock()+intervalSeconds*1000>deadline||attempts>=41)break;
    try{await wait(intervalSeconds*1000,undefined,{signal});}catch(error){if(signal?.aborted)break;throw error;}
  }while(clock()<=deadline);
  const result={jobId,status:signal?.aborted?'STOPPED':failures?'COMPLETED_WITH_FAILURES':'COMPLETED',startedAt,endedAt:clock(),attempts,successes,failures};
  log(result);return result;
}
