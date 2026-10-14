import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {createDispatcher,json} from '../../src/postgres/request-dispatch.js';
import {classifyExecutionFault} from '../../src/postgres/worker.js';

function latch(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const outcome=promise=>promise.then(value=>({value}),error=>({error}));
const closed=result=>{
  assert.equal(result.error?.message,'Transaction is closed');
  assert.equal(result.error.code,'25000');
  assert.equal(classifyExecutionFault(result.error).faultClass,'ENVIRONMENT');
};
const pid=async db=>(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;
function database(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const db=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL,max:1});
  t.after(()=>db.close());
  return db;
}

for(const finish of ['rollback','commit']){
  test(`late transaction helpers reject after ${finish} without touching the reused client`,{timeout:15000},async t=>{
    const db=database(t),release=latch(),failure=Error('body failed');
    let firstPid,late,nestedRan=false;
    const first=outcome(db.transaction(async()=>{
      firstPid=await pid(db);
      late=(async()=>{
        await release.promise;
        const calls=[
          ()=>db.query('SELECT 1/0'),
          ()=>db.exec('SELECT 1/0'),
          ()=>db.prepare('SELECT 1/0').get(),
          ()=>db.prepare('SELECT 1/0').all(),
          ()=>db.prepare('SELECT 1/0').run(),
          ()=>db.lock('cx1:closed'),
          ()=>db.maintenanceLock(),
          ()=>db.transaction(()=>{nestedRan=true;})
        ];
        const results=[];
        for(const call of calls)results.push(await outcome(call()));
        return results;
      })();
      if(finish==='rollback')await Promise.all([late,Promise.reject(failure)]);
      return 'committed';
    }));
    const result=await first;
    if(finish==='rollback')assert.equal(result.error,failure);else assert.equal(result.value,'committed');
    try{
      await db.transaction(async()=>{
        assert.equal(await pid(db),firstPid,'the next transaction owns the same backend');
        release.resolve();
        for(const result of await late)closed(result);
        assert.equal(nestedRan,false,'a closed nested transaction cannot invoke its body');
        assert.equal((await db.query('SELECT 42 answer')).rows[0].answer,42,'no stale SQL aborted the new transaction');
        await db.transaction(()=>db.query('SELECT 1'));
        await db.lock('cx1:active');
        await db.maintenanceLock();
      });
      assert.equal((await db.query('SELECT 7 answer')).rows[0].answer,7,'queries outside a transaction still work');
    }finally{release.resolve();await late;}
  });
}

test('a query queued before close checks the state again when its turn arrives',{timeout:15000},async t=>{
  const db=database(t),entered=latch(),release=latch();
  let firstPid,inFlight,queued;
  await db.transaction(async()=>{
    firstPid=await pid(db);
    const client=db.context.getStore().client,original=client.query;
    // Hold delivery of a real query result, leaving the next query in the database wrapper's queue.
    t.mock.method(client,'query',function(sql,params){
      const result=original.call(this,sql,params);
      return sql==='SELECT 123 AS held_result'?result.then(async value=>{
        entered.resolve();await release.promise;return value;
      }):result;
    });
    inFlight=outcome(db.query('SELECT 123 AS held_result'));
    queued=outcome(db.query('SELECT 1/0'));
    await entered.promise;
  });
  try{
    await db.transaction(async()=>{
      assert.equal(await pid(db),firstPid);
      release.resolve();
      assert.equal((await inFlight).value.rows[0].held_result,123);
      closed(await queued);
      assert.equal((await db.query('SELECT 42 answer')).rows[0].answer,42);
    });
  }finally{release.resolve();await Promise.all([inFlight,queued]);}
});

for(const scenario of ['retry','later request']){
  test(`an unfinished Promise.all branch cannot poison the HTTP ${scenario}`,{timeout:15000},async t=>{
    const db=database(t),release=latch(),audits=[],warnings=[];
    let attempts=0,firstPid,late,lateResult;
    const dispatch=createDispatcher({
      newsWindowsPort:{handle:async()=>false},requestLimits:async()=>true,
      auth:{checkOrigin(){},prepareSession:async()=>{}},database:db,
      store:{audit:async(...args)=>{audits.push(args);}},preloadJson:async()=>{},
      warn:message=>warnings.push(message),
      handleRequest:async(req,res)=>{
        if(req.url==='/api/closed-error')throw lateResult.error;
        if(req.url==='/api/first'&&++attempts===1){
          firstPid=await pid(db);
          const branch=(async()=>{await release.promise;return db.query('SELECT 1/0');})();
          late=outcome(branch);
          const error=Object.assign(Error('first attempt failed'),scenario==='retry'?{code:'40001'}:{status:409});
          await Promise.all([branch,Promise.reject(error)]);
        }
        assert.equal(await pid(db),firstPid,'HTTP transaction reuses the released backend');
        release.resolve();
        lateResult=await late;
        const {rows:[row]}=await db.query('SELECT 42 answer');
        json(res,200,{answer:row.answer});
      }
    });
    const server=createServer(dispatch);
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${server.address().port}`;
    try{
      const first=await fetch(base+'/api/first');
      const firstBody=await first.json();
      if(scenario==='retry'){
        assert.equal(first.status,200,JSON.stringify(firstBody));
        assert.deepEqual(firstBody,{answer:42});assert.equal(attempts,2);
        assert.equal(warnings.length,1);assert.equal(audits.length,0);
      }else{
        assert.equal(first.status,409);assert.deepEqual(firstBody,{error:'first attempt failed'});
        assert.equal(attempts,1);assert.equal(audits.length,1);
      }
      const next=await fetch(base+'/api/next'),nextBody=await next.json();
      assert.equal(next.status,200,JSON.stringify(nextBody));
      assert.deepEqual(nextBody,{answer:42});
      closed(lateResult);
      assert.equal(audits.length,scenario==='retry'?0:1,'no later request.error is recorded');
      if(scenario==='later request'){
        const failed=await fetch(base+'/api/closed-error');
        assert.equal(failed.status,503,'an escaping closed-state error is internal, not validation');
        assert.deepEqual(await failed.json(),{error:'Request could not be completed'});
        assert.equal(audits.at(-1)[3].message,'Database request failed');
        assert.equal(warnings.length,0,'invalid transaction state is not retried');
      }
    }finally{
      release.resolve();await late;
      await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
    }
  });
}

for(const finish of ['rollback','commit']){
  test(`queued write cannot persist during the ${finish} round trip`,{timeout:15000},async t=>{
    const db=database(t),failure=Error('body failed');
    await db.query('CREATE TEMP TABLE cx1_closed_window(id integer)');
    let firstPid,inFlight,late;
    const result=await outcome(db.transaction(async()=>{
      firstPid=await pid(db);
      inFlight=outcome(db.query('SELECT pg_sleep(0.3)'));
      // Let the first query reach pg before queuing the write and settling the body.
      await Promise.resolve();
      late=outcome(db.query('INSERT INTO cx1_closed_window VALUES(1)'));
      if(finish==='rollback')throw failure;
      return 'committed';
    }));
    if(finish==='rollback')assert.equal(result.error,failure);else assert.equal(result.value,'committed');
    const lateResult=await late;
    assert.equal((await inFlight).error,undefined,'already-submitted work may finish');
    await db.transaction(async()=>{
      assert.equal(await pid(db),firstPid,'inspect the same backend after the transaction finishes');
      const count=(await db.query('SELECT count(*)::int n FROM cx1_closed_window')).rows[0].n;
      t.diagnostic(`${finish}: persisted rows=${count}; late error=${lateResult.error?.code??'none'}`);
      assert.equal(count,0,'a queued write must not execute in autocommit after the body settles');
      closed(lateResult);
      assert.equal((await db.query('SELECT 42 answer')).rows[0].answer,42);
    });
  });
}
