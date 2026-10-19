import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
const wrong={code:'PAPER_LEDGER_FENCE_REPLICATION_ROLE'};
const setting="SELECT pg_catalog.current_setting('session_replication_role') AS role";
const poison=async(pool,role)=>{const c=await pool.connect();const pid=c.processID;await c.query('SET session_replication_role='+role);c.release();return pid;};
// Requires its own isolated superuser cluster. Never run against an application database.
test('runtime origin validation covers each independent checkout',{timeout:120000},async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  const url=new URL(process.env.TEST_DATABASE_URL);url.search='';
  const admin=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000,statement_timeout:60000,query_timeout:65000});
  const name='robot_po1_'+randomUUID().replaceAll('-',''),instances=new Set();let created=false;
  const make=(role,max=2)=>{const u=new URL(url);u.pathname='/'+name;if(role)u.searchParams.set('options','-c session_replication_role='+role);const db=new PostgresDatabase({connectionString:u.toString(),max});instances.add(db);return db;};
  const close=async db=>{await db.close();instances.delete(db);};
  try{
    await admin.connect();
    assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,true,'Fixture requires isolated superuser');
    await admin.query('CREATE DATABASE '+name);created=true;
    const setup=make();await setup.query('CREATE TABLE sentinel(n int); CREATE TABLE security_limits(key_hash text PRIMARY KEY,attempts int,expires_at bigint); CREATE TABLE sessions(token_hash text PRIMARY KEY,last_seen bigint,expires_at bigint)');await setup.query("INSERT INTO sessions VALUES('session',100,100000)");await close(setup);
    await t.test('origin works and lock lease survives business operations',async()=>{const db=make();await db.runtimeLock();const pid=db.runtimeClient.processID;assert.equal((await db.query(setting)).rows[0].role,'origin');assert.equal(db.runtimeClient.processID,pid);assert.ok((await admin.query('SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype=\'advisory\' AND granted',[pid])).rows[0].n>0);await close(db);assert.equal((await admin.query('SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype=\'advisory\'',[pid])).rows[0].n,0);});
    for(const role of ['replica','local'])await t.test('bad startup '+role+' refuses lock and stays guarded; offline remains inspectable',async()=>{const db=make(role);await assert.rejects(db.runtimeLock(),wrong);assert.equal(db.runtimeClient,undefined);await assert.rejects(db.query('INSERT INTO sentinel VALUES(1)'),wrong);assert.equal(db.pool.waitingCount,0);const offline=make(role);assert.equal((await offline.query(setting)).rows[0].role,role);await close(offline);await close(db);});
    for(const operation of ['query','transaction'])await t.test('poisoned reused main client refuses '+operation+' without work',async()=>{const db=make();await db.runtimeLock();const badPid=await poison(db.pool,'replica');let ran=false;if(operation==='query')await assert.rejects(db.query('INSERT INTO sentinel VALUES(2)'),wrong);else await assert.rejects(db.transaction(()=>{ran=true;return db.query('INSERT INTO sentinel VALUES(2)');}),wrong);assert.equal(ran,false);assert.notEqual((await db.query('SELECT pg_backend_pid() pid')).rows[0].pid,badPid);assert.equal((await db.query('SELECT count(*)::int n FROM sentinel')).rows[0].n,0);await close(db);});
    await t.test('new expansion and replacement backends are validated',async()=>{for(const expansion of [true,false]){const db=make(undefined,expansion?3:2);await db.runtimeLock();const held=await db.pool.connect();if(!expansion)held.release(true);db.pool.options.options='-c session_replication_role=replica';try{await assert.rejects(db.query('INSERT INTO sentinel VALUES(3)'),wrong);}finally{delete db.pool.options.options;if(expansion)held.release();}assert.equal((await db.query('SELECT count(*)::int n FROM sentinel')).rows[0].n,0);await close(db);}});
    await t.test('limitPool poison refuses both helpers; legitimate limit survives main rollback',async()=>{const db=make();await db.runtimeLock();await poison(db.limitPool,'local');await assert.rejects(db.consumeLimit('bad',10,1000,100),wrong);await poison(db.limitPool,'replica');await assert.rejects(db.touchSession('session',200,500),wrong);assert.equal((await db.query('SELECT count(*)::int n FROM security_limits')).rows[0].n,0);assert.equal((await db.query("SELECT last_seen::text v FROM sessions WHERE token_hash='session'")).rows[0].v,'100');const error=Error('rollback');await assert.rejects(db.transaction(async()=>{assert.equal(await db.consumeLimit('good',10,1000,100),true);throw error;}),e=>e===error);assert.equal((await db.query("SELECT attempts FROM security_limits WHERE key_hash='good'")).rows[0].attempts,1);assert.equal(db.limitPool.options.max,2);assert.equal(db.limitPool.options.statement_timeout,5000);await close(db);});
    await t.test('closed context refuses before a new checkout; privileged in-lease changes remain outside boundary',async()=>{const db=make();await db.runtimeLock();let release,late,nested=false;const wait=new Promise(r=>release=r);await db.transaction(async()=>{late=(async()=>{await wait;await assert.rejects(db.query('SELECT 1'),{code:'25000'});await assert.rejects(db.transaction(()=>{nested=true;}),{code:'25000'});})();});let checkouts=0;const original=db.pool.connect.bind(db.pool);db.pool.connect=(...args)=>{checkouts++;return original(...args);};release();await late;assert.equal(checkouts,0);assert.equal(nested,false);await db.transaction(async()=>{await db.query('SET LOCAL session_replication_role=replica');assert.equal((await db.query(setting)).rows[0].role,'replica','Checkout-only boundary: privileged changes inside the lease are not prevented');});await close(db);});
  }finally{
    const errors=[];for(const db of instances){try{await db.close();}catch(e){errors.push(e);}}
    // pool.end() resolves before backend sockets close. FORCE on a runtime backend that has not yet read Terminate sends FATAL 57P01,
    // and that error event reaches the runtime-lock-lost handler (process.exit). Let this database's backends leave first.
    try{if(created&&!errors.length){for(let i=0;i<100&&(await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[name])).rows[0].n;i++)await new Promise(r=>setTimeout(r,50));await admin.query('DROP DATABASE '+name+' WITH (FORCE)');}}catch(e){errors.push(e);}finally{try{await admin.end();}catch(e){errors.push(e);}}
    if(errors.length)throw new AggregateError(errors,'Runtime-origin fixture cleanup failed');
  }
});
