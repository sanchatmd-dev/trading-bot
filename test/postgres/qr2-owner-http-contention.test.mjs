import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {createBot,ledgerDigest} from '../helpers/qr2-reader-fixture.mjs';
import {hashPassword} from '../../src/security.js';

// Actual server.js/auth/dispatcher/pool, with the registry default boundary record (funding-only Bot: no fill, so no epoch is read).
// A database lock observes the first phase-2 reader after shared-slot admission.
// This proves admission through read completion, not physical worker-stop timing.
const OWNER='/api/paper-performance/owner?currency=USDT&period=DAY';
const DEADLINE=5000;
async function bounded(promise,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),DEADLINE);})]);}
  finally{clearTimeout(timer);}
}

for(const ownerFirst of [true,false])test(`actual HTTP shared slot: ${ownerFirst?'owner then account':'account then owner'} refuses overlap and reuses after completion`,{timeout:45000},async()=>{
  const connection=process.env.TEST_DATABASE_URL;
  assert.ok(connection,'Root-assigned isolated PostgreSQL required');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(connection).hostname),'Loopback fixture only');
  let f,locker,locked=false,first,second,failure;
  try{
    f=await quantPreflightHttpFixture(connection,{mode:'disabled',environment:{QR2_PERFORMANCE_ENABLED:'1',MARKET_PUBLIC_PROXY:'0'}});
    await f.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));
    const password='Qr2-contention-'+randomUUID();
    const owner=await f.store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password),role:'USER'});
    const bot=await createBot(f.store,owner,1000);
    const login=await f.request('/api/auth/login','POST',{email:owner.email,password});
    assert.equal(login.status,200,'real application login');
    const account='/api/paper-performance?bot_id='+bot.id+'&period=DAY';
    assert.equal((await f.request(OWNER)).status,401,'owner route requires authentication');
    assert.equal((await f.request(account)).status,401,'account route requires authentication');
    const before=[await ledgerDigest(f.db,owner),await ledgerDigest(f.db,bot)];
    const [firstPath,secondPath]=ownerFirst?[OWNER,account]:[account,OWNER];
    locker=await f.db.pool.connect();
    const lockerPid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await locker.query('BEGIN');locked=true;
    await locker.query('LOCK TABLE public.paper_funding IN ACCESS EXCLUSIVE MODE');
    let settled=false;
    first=f.request(firstPath,'GET',undefined,login.session);
    first.then(()=>{settled=true;},()=>{settled=true;});
    const waiters=async()=>(await f.db.query(`SELECT a.pid,a.wait_event_type,a.query FROM pg_stat_activity a
      WHERE a.datname=current_database() AND $1::int=ANY(pg_blocking_pids(a.pid))`,[lockerPid])).rows;
    const end=Date.now()+DEADLINE;
    let waiting=[];
    while(Date.now()<end){
      waiting=await waiters();
      if(waiting.length)break;
      assert.equal(settled,false,'first request must reach the observed read barrier');
      await delay(20);
    }
    assert.equal(waiting.length,1,'exactly one first phase-2 reader reaches the barrier');
    assert.equal(waiting[0].wait_event_type,'Lock');
    assert.match(waiting[0].query,/public\.paper_funding/,'the barrier is a ledger read, not auth or phase 1');
    second=f.request(secondPath,'GET',undefined,login.session);
    const refused=await bounded(second,'second HTTP request did not refuse while the shared slot was held');
    assert.equal(refused.status,429);
    assert.deepEqual(refused.body.detail,{limit:'concurrency',max:1});
    assert.equal(refused.headers.get('retry-after'),'2');
    assert.equal(refused.body.code,'QR2_RANGE_ADMISSION_REFUSED');
    assert.equal((await waiters()).length,1,'second request does not start a concurrent ledger reader');
    assert.equal(settled,false,'first read still holds admission when the second request is refused');
    await locker.query('ROLLBACK');locked=false;
    const complete=await bounded(first,'first HTTP request did not finish after barrier release');
    assert.equal(complete.status,200,'first request completes through the actual worker');
    const reusable=await bounded(f.request(secondPath,'GET',undefined,login.session),'shared slot was not reusable after completion');
    assert.equal(reusable.status,200);
    assert.deepEqual([await ledgerDigest(f.db,owner),await ledgerDigest(f.db,bot)],before,'reads leave ledger, audit and fence unchanged');
  }catch(error){failure=error;throw error;}
  finally{
    // Cleanup always reaches fixture close, even if rollback or request draining fails.
    // Preserve the primary assertion failure; cleanup failure still fails a successful test.
    let cleanupFailure;
    try{
      if(locked)await locker.query('ROLLBACK');
    }catch(error){cleanupFailure=error;}
    finally{
      try{locker?.release(cleanupFailure);}catch(error){cleanupFailure??=error;}
      try{
        await bounded(Promise.allSettled([first,second].filter(Boolean)),'pending HTTP requests did not drain');
      }catch(error){cleanupFailure??=error;}
      finally{try{await f?.close();}catch(error){cleanupFailure??=error;}}
    }
    if(cleanupFailure&&!failure)throw cleanupFailure;
  }
});
