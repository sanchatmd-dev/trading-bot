import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantIoRuntime,canReleaseQuantIo,QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,quantIoUnitName} from '../../src/postgres/quant-io-runtime.js';
import {terminalReadbackDigest} from '../../src/quant-research/io-terminal.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {profileV2Fixture} from '../helpers/profile-v2-fixture.js';

const now=1800010000000,operationId='operation-00001';
let admin,db,second,name,ledger,scheduler,claimed,runtime,launcher,spawned,authorizations,denyTerminal,script;
const allowance={read_bytes:30,write_bytes:30};
const args=()=>({jobId:claimed.job_id,leaseToken:claimed.lease_token,operationId});
const evidenceFor=frozen=>({freezer:'frozen',windowMs:2500,
  reads:[{readBytes:frozen.readBytes,writeBytes:frozen.writeBytes},{readBytes:frozen.readBytes,writeBytes:frozen.writeBytes}],
  fileDirty:0,fileWriteback:0,maxBioBytes:1310720,rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}});
/** `terminal` scripts handle.terminate(): frozen counters, commit hook, gate, stop proof, verdict. */
const fixtureLauncher=(sampleOverride,readyOverride,terminal=null)=>({spawnPrepared({unitName}){
  spawned++;
  let released=false,stops=0;
  const group='/user.slice/'+unitName;
  const sample={unitName,group,cgroupInode:23,deviceId:'8:0',deviceInode:17,
    pid:4242,procStartTicks:'12345',invocationId:'1'.repeat(32),
    readBytes:3,writeBytes:4};
  const handle={payloadHash:QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,
    ready:Promise.resolve(readyOverride?readyOverride({unitName,group,cgroupInode:23,
      invocationId:'1'.repeat(32)}):{unitName,group,cgroupInode:23,invocationId:'1'.repeat(32)}),
    async sample(){return sampleOverride?sampleOverride(sample):sample;},
    release(){assert.equal(released,false);released=true;},
    // terminal.join models the real handle: a stop during terminate() joins it and shares its stop proof.
    async stop(){
      if(terminal?.join&&terminal.promise&&!terminal.settled){
        terminal.stopRequested=true;return (await terminal.promise).stopProof;
      }
      return rawStop();
    }};
  const rawStop=()=>{stops++;terminal?.events.push('stop');return {unitName,launcherClosed:true,startRegistered:true,
    pendingStartsExcluded:true,unitStopped:true,stops};};
  if(terminal)handle.terminate=request=>{
    terminal.calls++;
    terminal.promise??=(async()=>{
      terminal.events.push('terminate');
      if(terminal.join){
        // A drain that polls until the test lets it end (drainOver) or a stop request arrives. It gives up after 8 s so a
        // missing stop shows as a failed assertion, never as a hung test run.
        const giveUp=Date.now()+8000;
        while(!terminal.stopRequested&&!terminal.drainOver&&Date.now()<giveUp)await new Promise(resolve=>setTimeout(resolve,5));
        if(terminal.stopRequested){terminal.settled=true;return Object.freeze({stopProof:rawStop(),measured:false,reason:'STOP_REQUESTED'});}
      }
      const frozen={...sample,readBytes:terminal.read??7,writeBytes:terminal.write??9,...terminal.patch};
      let committed=false;
      if(terminal.commit!==false)try{await request.commit(frozen,evidenceFor(frozen));committed=true;}
      catch(error){terminal.commitError=error;}
      terminal.events.push('committed');
      await terminal.gate;
      const proof=terminal.join?rawStop():await handle.stop();
      terminal.settled=true;
      return Object.freeze({stopProof:terminal.stopProof??proof,measured:terminal.measured??committed,
        postExit:terminal.postExit??'REMOVED',frozenSample:frozen,readbackEvidence:evidenceFor(frozen)});
    })();
    return terminal.promise;
  };
  return handle;
}});
const ledgerState=async(connection=db)=>(await connection.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
const launchState=async(connection=db)=>(await connection.query('SELECT state FROM quant_io_launches')).rows[0].state;
const jobRow=async(connection=db)=>(await connection.query('SELECT * FROM quant_foundation_jobs')).rows[0];
/** Reserve, start, bind, release. The operation is ACTIVE and the launch RELEASED. */
async function armTerminal(overrides={}){
  script={calls:0,events:[],...overrides};
  launcher=fixtureLauncher(undefined,undefined,script);
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.ready(args());
  await runtime.bind(args());await runtime.release(args());
}
const stopDigest=()=>hash(canonical({version:'quant-io-stop-proof-v1',jobId:claimed.job_id,operationId,
  unitName:quantIoUnitName(claimed.job_id,operationId),launcherClosed:true,startRegistered:true,
  pendingStartsExcluded:true,unitStopped:true}));
const readbackDigest=(read,write,postExit='REMOVED')=>terminalReadbackDigest({jobId:claimed.job_id,operationId,
  unitName:quantIoUnitName(claimed.job_id,operationId),group:'/user.slice/'+quantIoUnitName(claimed.job_id,operationId),
  cgroupInode:23,invocationId:'1'.repeat(32),pid:4242,procStartTicks:'12345',deviceId:'8:0',deviceInode:17,
  reads:[{readBytes:read,writeBytes:write},{readBytes:read,writeBytes:write}],windowMs:2500,
  fileDirty:0,fileWriteback:0,freezer:'frozen',postExit});

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='quant_io_runtime_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  db=new PostgresDatabase({connectionString:url.toString(),max:4});
  second=new PostgresDatabase({connectionString:url.toString(),max:4});
  for(const file of ['quant-foundation-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'])
    await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
});
beforeEach(async()=>{
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  const {policy,contract}=profileV2Fixture(2000);
  scheduler=new QuantFoundationScheduler({db,capacityPolicy:policy,profileV2Enabled:true,clock:()=>now,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true}),
    canRelease:row=>canReleaseQuantIo(db,row)});
  const queued=await scheduler.enqueue('owner-a',contract,randomUUID());
  claimed=await scheduler.claim('io-runtime-test');assert.equal(claimed.job_id,queued.job_id);
  authorizations=[];denyTerminal=false;script=null;
  ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],
    authorizeTerminal:async({action})=>{authorizations.push(action);return {ok:!denyTerminal};},clock:()=>now});
  spawned=0;launcher=fixtureLauncher();runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
});
after(async()=>{
  await Promise.all([db?.close(),second?.close()]);
  if(admin){if(name)await admin.query('DROP DATABASE '+name);await admin.close();}
});

test('atomic reservation and intent, one start, held payload, then cancel charges unknown final',async()=>{
  const {state,unitName}=await runtime.reserve({...args(),expectedRevision:0,allowance});
  assert.equal(state.operations[0].cgroup_id,unitName);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'INTENT_RECORDED');
  await assert.rejects(runtime.reserve({...args(),expectedRevision:state.revision,allowance}),
    {code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.start(args());assert.equal(spawned,1);
  await assert.rejects(runtime.start(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.ready(args());
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  // A PROFILE V2 job leaves RUNNING only through the terminal path, so the scheduler refuses pause and finish before it
  // reaches the I/O release hook. The refusal writes nothing.
  const running=await jobRow();
  await assert.rejects(scheduler.pause(claimed),{code:'PROFILE_V2_TERMINAL_REQUIRED'});
  await assert.rejects(scheduler.finish(claimed,{}),{code:'PROFILE_V2_TERMINAL_REQUIRED'});
  assert.deepEqual(await jobRow(),running);
  // The release hook still reports the live launch as unresolved, independent of that refusal.
  assert.deepEqual(await scheduler.canRelease(running,'PAUSE'),{ok:false});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
  assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
  assert.equal((await db.query('SELECT result FROM quant_foundation_jobs')).rows[0].result,null);
});

test('prepared diagnostic spawn occurs only after final live lease check',async()=>{
  const original=fixtureLauncher();
  let prepared=0,aborted=0;
  launcher={spawnPrepared:original.spawnPrepared,
    async prepare({unitName}){
      prepared++;
      return {spawnPrepared:()=>original.spawnPrepared({unitName}),async abort(){aborted++;}};
    }};
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());
  assert.equal(prepared,1);assert.equal(spawned,1);assert.equal(aborted,0);
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('lease lost during async preparation aborts reservation without spawning',async()=>{
  let aborted=0;
  launcher={spawnPrepared(){throw Error('unexpected spawn');},
    async prepare(){
      await scheduler.cancel('owner-a',claimed.job_id);
      return {spawnPrepared(){throw Error('unexpected spawn');},async abort(){aborted++;}};
    }};
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await assert.rejects(runtime.start(args()),{code:'QUANT_IO_LEASE_LOST'});
  assert.equal(spawned,0);assert.equal(aborted,1);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STARTING');
});

test('SQL guard blocks alternate scheduler release and lease replacement',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  const alternate=new QuantFoundationScheduler({db:second,capacityPolicy:profileV2Fixture(2000).policy,
    clock:()=>now,authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  // No scheduler instance pauses a PROFILE V2 job, with or without the release hook.
  await assert.rejects(alternate.pause(claimed),{code:'PROFILE_V2_TERMINAL_REQUIRED'});
  // The trigger guards every writer: it refuses the statement release() would issue, whatever the target status.
  for(const status of ['PAUSED','SUCCEEDED','CANCELLED'])
    await assert.rejects(second.query(`UPDATE quant_foundation_jobs SET status=$2,result=$3,
      runtime_used_ms=runtime_used_ms+GREATEST(0,$4-run_started_at),run_started_at=NULL,
      lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE job_id=$1`,[claimed.job_id,status,null,now]),
    /Foundation I\/O launch unresolved/);
  await assert.rejects(db.query('UPDATE quant_foundation_jobs SET lease_token=$2 WHERE job_id=$1',
    [claimed.job_id,randomUUID()]),/Foundation I\/O launch unresolved/);
  await alternate.cancel('owner-a',claimed.job_id);
  await assert.rejects(alternate.acknowledgeStopped(claimed.job_id,claimed.lease_token),
    /Foundation I\/O launch unresolved/);
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
});

// QuantIoRuntime serves PROFILE V2 only, and the scheduler refuses to release that kind before any I/O check. A legacy
// job with a directly seeded launch row is therefore the one way to reach the release hook inside release() and an
// alternate scheduler's pause, so this keeps both guards covered on their own.
const legacyRequest=owner=>{
  const start=1800000000000,total=100,digest='a'.repeat(64);
  return {version:'quant-foundation-v1',owner_id:owner,bot_id:'fixture-bot',kind:'BACKTEST',
    dataset:{dataset_id:digest,sha256:digest,metadata:{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',
      symbol:'BTCUSDT',timeframe:'1',start_time:start,end_time:start+total*60000,warmup_bars:10,total_bars:total,
      cutoff:start+total*60000,source:'binance-spot-klines-v1'}},engine_hash:'b'.repeat(64),snapshot_hash:'c'.repeat(64),
    budget:{candidates:1,max_evaluations:1,chunk_bars:100,max_runtime_ms:900000,max_output_bytes:1024,max_state_bytes:1024}};
};

// Each seed blocks through one condition only, so the hook and the trigger are each checked on both of their conditions.
const unresolvedSeeds=[
  {name:'launch row',launch:'INTENT_RECORDED',operations:[],
    resolve:async(job)=>{await db.query("UPDATE quant_io_launches SET state='STOP_PROVEN' WHERE job_id=$1",[job.job_id]);}},
  {name:'ledger operation',launch:'STOP_PROVEN',operations:[{operation_id:operationId,status:'CRASHED_UNCONFIRMED'}],
    resolve:async(job,state)=>{
      const next={...state,revision:1,operations:[{operation_id:operationId,status:'CRASHED'}]};
      await db.query('UPDATE quant_io_ledgers SET revision=1,state=$2,state_hash=$3 WHERE job_id=$1',
        [job.job_id,JSON.stringify(next),hash(canonical(next))]);
    }}
];
for(const seed of unresolvedSeeds)
  test(`release hook and SQL guard also stop another job kind that holds an unresolved ${seed.name}`,async()=>{
    await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
    const {policy}=profileV2Fixture(2000);
    const build=(database,canRelease)=>new QuantFoundationScheduler({db:database,capacityPolicy:policy,clock:()=>now,
      leaseMs:30000,authorize:async()=>({ok:true}),health:async()=>({ok:true}),canRelease});
    const hooked=build(db,row=>canReleaseQuantIo(db,row)),alternate=build(second);
    await hooked.enqueue('owner-a',legacyRequest('owner-a'),randomUUID());
    const job=await hooked.claim('io-runtime-legacy');
    const state={job_id:job.job_id,policy_hash:hash('legacy-policy'),lease_token:job.lease_token,revision:0,
      operations:seed.operations};
    await db.query(`INSERT INTO quant_io_ledgers(job_id,policy_hash,lease_token,revision,state,state_hash)
      VALUES($1,$2,$3,0,$4,$5)`,[job.job_id,state.policy_hash,job.lease_token,JSON.stringify(state),hash(canonical(state))]);
    await db.query(`INSERT INTO quant_io_launches(job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[job.job_id,operationId,job.lease_token,quantIoUnitName(job.job_id,operationId),
      QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,seed.launch,now]);
    await assert.rejects(hooked.pause(job),{code:'FOUNDATION_IO_UNRESOLVED'});
    await assert.rejects(hooked.finish(job,{done:true}),{code:'FOUNDATION_IO_UNRESOLVED'});
    await assert.rejects(alternate.pause(job),/Foundation I\/O launch unresolved/);
    assert.equal((await jobRow()).status,'RUNNING');
    // Control: the same release goes through once that one condition is resolved, so it was the only blocker.
    await seed.resolve(job,state);
    assert.equal((await hooked.pause(job)).status,'PAUSED');
  });

test('cancel before start claim proves no launch; STARTING without handle remains quarantined',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  const completed=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(completed.status,'CANCELLED');assert.equal(spawned,0);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  const {policy,contract}=profileV2Fixture(2000);
  const next=new QuantFoundationScheduler({db,capacityPolicy:policy,profileV2Enabled:true,clock:()=>now,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  await next.enqueue('owner-a',contract,randomUUID());claimed=await next.claim('io-runtime-next');
  ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],
    authorizeTerminal:async()=>({ok:true}),clock:()=>now});
  runtime=new QuantIoRuntime({db,ledger,scheduler:next,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await db.query("UPDATE quant_io_launches SET state='STARTING' WHERE job_id=$1",[claimed.job_id]);
  const blocked=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(blocked.status,'STOPPING');assert.equal(blocked.proof,'UNCONFIRMED');
  await assert.rejects(next.acknowledgeStopped(claimed.job_id,claimed.lease_token),
    /Foundation I\/O launch unresolved/);
});

test('postspawn transaction rollback stops owned handle; STARTING intent can close only with that proof',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  let inject=true;
  const rollbackDb={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:callback=>db.transaction(async()=>{
      const value=await callback();
      if(inject&&spawned>0){inject=false;throw Error('postspawn transaction rolled back');}
      return value;
    })};
  // The ledger must share the runtime's database object, so it is rebuilt on the same wrapper.
  const rollbackLedger=new QuantIoLedger({db:rollbackDb,policy:ledger.policy,devices:ledger.devices,
    authorizeTerminal:ledger.authorizeTerminal,clock:()=>now});
  const uncertainRuntime=new QuantIoRuntime({db:rollbackDb,ledger:rollbackLedger,scheduler,launcher,clock:()=>now});
  await assert.rejects(uncertainRuntime.start(args()),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.equal(spawned,1);
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STARTING');
  const completed=await uncertainRuntime.cancel({ownerId:'owner-a',...args()});
  assert.equal(completed.status,'CANCELLED');
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'STOP_PROVEN');
});

test('synthetic trusted sample binds birth counters from zero before release; bound cancel burns allowance',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.ready(args());
  const bound=await runtime.bind(args());
  const operation=bound.operations[0];
  assert.equal(operation.status,'ACTIVE');
  assert.deepEqual(operation.baseline,{devices:[{device_id:'8:0',device_inode:17,read_bytes:0,write_bytes:0}]});
  assert.deepEqual(operation.last,{devices:[{device_id:'8:0',device_inode:17,read_bytes:3,write_bytes:4}]});
  await runtime.release(args());
  assert.equal((await db.query('SELECT state FROM quant_io_launches')).rows[0].state,'RELEASED');
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
  const stored=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].cgroup_inode,23);
  assert.equal(stored.operations[0].status,'CRASHED');
});

test('missing kernel counter row denies bind and payload',async()=>{
  launcher=fixtureLauncher(()=>{throw Object.assign(Error('no io.stat row'),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});});
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'RESERVED');
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('wrong enrolled device denies trusted binding',async()=>{
  launcher=fixtureLauncher(sample=>({...sample,deviceId:'8:1'}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('changed cgroup inode denies trusted binding',async()=>{
  launcher=fixtureLauncher(sample=>({...sample,cgroupInode:24}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('bound overshoot persists STOP_REQUIRED before stop and charges observed bytes',async()=>{
  launcher=fixtureLauncher(sample=>({...sample,readBytes:31}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const pending=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(pending.operations[0].status,'STOP_REQUIRED');
  assert.equal(pending.operations[0].last.devices[0].read_bytes,31);
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.charged,
    {read_bytes:31,write_bytes:30});
});

test('cancel between sampled identity and bind commit leaves reservation, no payload',async()=>{
  launcher=fixtureLauncher(async sample=>{await scheduler.cancel('owner-a',claimed.job_id);return sample;});
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LEASE_LOST'});
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'RESERVED');
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
});

test('lost bind commit acknowledgement stops the owned handle and forbids release',async()=>{
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.ready(args());
  let inject=true;
  const committedDb={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:async callback=>{
      const value=await db.transaction(callback);
      if(inject){inject=false;throw Error('commit acknowledgement lost');}
      return value;
    }};
  runtime.db=committedDb;
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status,'ACTIVE');
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
});

test('last fresh overshoot is persisted before payload denial and final charge',async()=>{
  let samples=0;
  launcher=fixtureLauncher(sample=>({...sample,readBytes:++samples===3?40:3}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());await runtime.bind(args());
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  const pending=(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state;
  assert.equal(pending.operations[0].status,'STOP_REQUIRED');
  assert.equal(pending.operations[0].last.devices[0].read_bytes,40);
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');
  assert.equal((await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.charged.read_bytes,40);
});

test('diagnostic enrollment denies a second operation for the same job',async()=>{
  const {state}=await runtime.reserve({...args(),expectedRevision:0,allowance});
  await assert.rejects(runtime.reserve({...args(),operationId:'operation-00002',
    expectedRevision:state.revision,allowance}),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM quant_io_launches')).rows[0].n,1);
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('nested owned quant unit path denies binding',async()=>{
  const ancestor='robot-quant-'+'f'.repeat(64)+'.service';
  const nested=unitName=>'/user.slice/'+ancestor+'/'+unitName;
  launcher=fixtureLauncher(sample=>({...sample,group:nested(sample.unitName)}),
    ready=>({...ready,group:nested(ready.unitName)}));
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await runtime.start(args());
  await assert.rejects(runtime.bind(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await assert.rejects(runtime.release(args()),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
  await runtime.cancel({ownerId:'owner-a',...args()});
});

// ---- FTR-1 measured terminal (fake handles; no Linux) ----

test('measured terminal settles exact frozen deltas with STOP_PROVEN, no quarantine, null SQL result',async()=>{
  await armTerminal();
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  assert.equal(script.calls,1);
  const stored=await ledgerState(),operation=stored.operations[0];
  assert.equal(operation.status,'SETTLED');
  assert.deepEqual(operation.charge,{read_bytes:7,write_bytes:9});
  assert.deepEqual(stored.charged,{read_bytes:7,write_bytes:9});
  assert.deepEqual(operation.last,{devices:[{device_id:'8:0',device_inode:17,read_bytes:7,write_bytes:9}]});
  assert.equal(operation.stop_reason,null);
  assert.equal(stored.operations.some(item=>['CRASHED','CRASHED_UNCONFIRMED'].includes(item.status)||
    item.stop_reason==='UNKNOWN_FINAL_ACCOUNTING'),false);
  assert.equal(operation.terminal_proof.stopped,true);assert.equal(operation.terminal_proof.final_readback,true);
  assert.equal(operation.terminal_proof.stop_proof_sha256,stopDigest());
  assert.equal(operation.terminal_proof.readback_proof_sha256,readbackDigest(7,9));
  assert.equal(operation.stop_confirmation,stopDigest());
  assert.equal(await launchState(),'STOP_PROVEN');
  const job=(await db.query('SELECT status,result,checkpoint FROM quant_foundation_jobs')).rows[0];
  assert.equal(job.status,'CANCELLED');assert.equal(job.result,null);assert.equal(job.checkpoint,null);
  assert.deepEqual(authorizations,['settle']);
  assert.deepEqual(script.events,['terminate','committed','stop']);
});

test('frozen sample is committed and visible to another connection before the unit is stopped',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const cancelling=runtime.cancel({ownerId:'owner-a',...args()});
  const deadline=Date.now()+5000;
  let visible=null;
  while(Date.now()<deadline&&!visible){
    const state=await ledgerState(second);
    if(state.operations[0].last.devices[0].read_bytes===7)visible=state;
    else await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(visible,'frozen observation not visible');
  assert.equal(visible.operations[0].status,'ACTIVE');
  assert.deepEqual(visible.operations[0].last.devices[0],{device_id:'8:0',device_inode:17,read_bytes:7,write_bytes:9});
  assert.equal(script.events.includes('stop'),false);
  assert.equal(await launchState(second),'RELEASED');
  openGate();
  assert.equal((await cancelling).proof,'MEASURED_FINAL_SETTLED');
  assert.equal(script.events.at(-1),'stop');
});

test('measured overshoot beyond allowance is charged exactly through STOP_REQUIRED without quarantine',async()=>{
  await armTerminal({read:31,write:9});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'SETTLED');
  assert.equal(stored.operations[0].stop_reason,'ALLOWANCE_EXHAUSTED');
  assert.deepEqual(stored.charged,{read_bytes:31,write_bytes:9});
  assert.equal(stored.operations.some(item=>item.status==='CRASHED'),false);
});

async function freshJob(label){
  await db.query('TRUNCATE quant_io_launches,quant_io_ledgers,quant_foundation_jobs,quant_foundation_owners');
  const {policy,contract}=profileV2Fixture(2000);
  const fresh=new QuantFoundationScheduler({db,capacityPolicy:policy,profileV2Enabled:true,clock:()=>now,leaseMs:30000,
    authorize:async()=>({ok:true}),health:async()=>({ok:true}),canRelease:row=>canReleaseQuantIo(db,row)});
  await fresh.enqueue('owner-a',contract,randomUUID());claimed=await fresh.claim(label);
  scheduler=fresh;authorizations.length=0;
}

test('not measured terminal uses the unknown-final fallback and burns the allowance',async()=>{
  for(const overrides of [{measured:false},{measured:false,commit:false},{measured:false,postExit:'UNKNOWN'}]){
    await freshJob('io-runtime-fallback');
    await armTerminal(overrides);
    const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
    assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
    const stored=await ledgerState();
    assert.equal(stored.operations[0].status,'CRASHED');
    assert.deepEqual(stored.charged,allowance);
    assert.equal(await launchState(),'STOP_PROVEN');
    assert.equal(authorizations.includes('settle'),false);
    assert.equal(authorizations.includes('crash'),true);
  }
});

test('tail observed after exit is never charged as measured',async()=>{
  // Honest launcher: not measured. Dishonest launcher: measured true with a rejected disposition.
  for(const overrides of [{measured:false,postExit:'TAIL_OBSERVED'},{measured:true,postExit:'TAIL_OBSERVED'},
    {measured:true,postExit:'UNKNOWN'}]){
    await freshJob('io-runtime-tail');
    await armTerminal(overrides);
    const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
    assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
    const stored=await ledgerState();
    assert.equal(stored.operations[0].status,'CRASHED');
    assert.deepEqual(stored.charged,allowance);
    assert.equal(stored.operations[0].last.devices[0].write_bytes,9);
  }
});

test('stop unconfirmed after the frozen read neither settles nor crash-charges and keeps the SQL guard',async()=>{
  await armTerminal({stopProof:{unitName:quantIoUnitName(claimed.job_id,operationId),launcherClosed:true,
    startRegistered:true,pendingStartsExcluded:true,unitStopped:false}});
  const blocked=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(blocked.status,'STOPPING');assert.equal(blocked.proof,'UNCONFIRMED');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'ACTIVE');
  assert.equal(stored.operations[0].last.devices[0].read_bytes,7);
  assert.equal(await launchState(),'RELEASED');
  assert.deepEqual(authorizations,[]);
  const alternate=new QuantFoundationScheduler({db:second,capacityPolicy:profileV2Fixture(2000).policy,
    clock:()=>now,authorize:async()=>({ok:true}),health:async()=>({ok:true})});
  await assert.rejects(alternate.acknowledgeStopped(claimed.job_id,claimed.lease_token),
    /Foundation I\/O launch unresolved/);
  await assert.rejects(db.query('UPDATE quant_foundation_jobs SET lease_token=$2 WHERE job_id=$1',
    [claimed.job_id,randomUUID()]),/Foundation I\/O launch unresolved/);
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
});

test('concurrent cancels run one terminal with a deterministic ledger revision sequence',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  // Wait for both scheduler.cancel calls to return STOPPING, so the second cancel has joined the
  // terminal held open by the gate. A fixed sleep is racy against real connection latency.
  const originalCancel=scheduler.cancel.bind(scheduler);let returned=0;
  scheduler.cancel=async(...values)=>{
    const stopping=await originalCancel(...values);
    if(stopping.status==='STOPPING')returned++;
    return stopping;
  };
  const first=runtime.cancel({ownerId:'owner-a',...args()});
  const joined=runtime.cancel({ownerId:'owner-a',...args()});
  const deadline=Date.now()+10000;
  while(returned<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(returned,2,'both cancels must reach the running terminal');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(script.events.includes('stop'),false);
  openGate();
  const [one,two]=await Promise.all([first,joined]);
  assert.equal(script.calls,1);
  assert.equal(one.proof,'MEASURED_FINAL_SETTLED');assert.deepEqual(two,one);
  const stored=await ledgerState();
  assert.equal(stored.revision,4);// reserve, bind, frozen observation, settle
  assert.equal(stored.operations[0].status,'SETTLED');
  assert.equal(script.events.filter(event=>event==='stop').length,1);
  assert.deepEqual(authorizations,['settle']);
  // Once the job is CANCELLED, a repeat cancel changes nothing and is rejected as before.
  await assert.rejects(runtime.cancel({ownerId:'owner-a',...args()}),{code:'QUANT_IO_LEASE_LOST'});
  assert.equal((await ledgerState()).revision,4);
});

test('lost settle acknowledgement rereads the committed settlement and never crash-charges',async()=>{
  await armTerminal();
  let inject=true;
  runtime.db={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:async callback=>{
      const value=await db.transaction(callback);
      if(inject&&(await ledgerState()).operations[0].status==='SETTLED'){
        inject=false;throw Error('commit acknowledgement lost');
      }
      return value;
    }};
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(inject,false);
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'SETTLED');assert.equal(stored.revision,4);
  assert.deepEqual(stored.charged,{read_bytes:7,write_bytes:9});
  assert.equal(await launchState(),'STOP_PROVEN');
  assert.deepEqual(authorizations,['settle']);
});

test('settle and launch STOP_PROVEN are atomic; a rolled back settle falls back to the crash charge',async()=>{
  await armTerminal();
  let inject=true;const seen=[];
  runtime.db={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:async callback=>{
      try{
        return await db.transaction(async()=>{
          const value=await callback();
          if(inject&&(await db.query('SELECT state FROM quant_io_ledgers')).rows[0].state.operations[0].status==='SETTLED'){
            inject=false;throw Error('failure after the ledger write');
          }
          return value;
        });
      }catch(error){
        if(!inject&&!seen.length)seen.push({ledger:(await ledgerState(second)).operations[0].status,launch:await launchState(second)});
        throw error;
      }
    }};
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(seen,[{ledger:'ACTIVE',launch:'RELEASED'}]);
  assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'CRASHED');assert.deepEqual(stored.charged,allowance);
  assert.equal(await launchState(),'STOP_PROVEN');
});

test('terminal authorization denial blocks settle and crash and leaves the operation unresolved',async()=>{
  await armTerminal();
  denyTerminal=true;
  await assert.rejects(runtime.cancel({ownerId:'owner-a',...args()}),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.equal(authorizations[0],'settle');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'ACTIVE');assert.deepEqual(stored.charged,{read_bytes:0,write_bytes:0});
  assert.equal(await launchState(),'RELEASED');
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
  await assert.rejects(scheduler.acknowledgeStopped(claimed.job_id,claimed.lease_token),
    {code:'FOUNDATION_IO_UNRESOLVED'});
});

test('job already STOPPING under the same token still settles; a stale token is denied before any terminal',async()=>{
  await armTerminal();
  await scheduler.cancel('owner-a',claimed.job_id);
  await assert.rejects(runtime.cancel({ownerId:'owner-a',...args(),leaseToken:randomUUID()}),
    {code:'QUANT_IO_LEASE_LOST'});
  assert.equal(script.calls,0);
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  assert.equal((await ledgerState()).operations[0].status,'SETTLED');
});

test('an instance without the handle cannot settle or crash a released operation',async()=>{
  await armTerminal();
  const orphan=new QuantIoRuntime({db,ledger,scheduler,launcher:fixtureLauncher(),clock:()=>now});
  const before=await ledgerState();
  const blocked=await orphan.cancel({ownerId:'owner-a',...args()});
  assert.equal(blocked.status,'STOPPING');assert.equal(blocked.proof,'UNCONFIRMED');
  assert.deepEqual(await ledgerState(),before);
  assert.equal(await launchState(),'RELEASED');
  assert.equal(script.calls,0);assert.deepEqual(authorizations,[]);
});

test('runtime requires the ledger to share its database object',()=>{
  const shared={db,ledger,scheduler,launcher:fixtureLauncher(),clock:()=>now};
  assert.doesNotThrow(()=>new QuantIoRuntime(shared));
  assert.throws(()=>new QuantIoRuntime({...shared,db:second}),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  const wrapper={get isTransaction(){return db.isTransaction;},query:(...values)=>db.query(...values),
    transaction:callback=>db.transaction(callback)};
  assert.throws(()=>new QuantIoRuntime({...shared,db:wrapper}),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  assert.doesNotThrow(()=>new QuantIoRuntime({...shared,db:wrapper,
    ledger:new QuantIoLedger({db:wrapper,policy:ledger.policy,devices:ledger.devices,
      authorizeTerminal:ledger.authorizeTerminal,clock:()=>now})}));
});

for(const [field,value] of [['cgroupInode',24],['invocationId','2'.repeat(32)],['pid',4243],['deviceId','8:1'],
  ['deviceInode',18],['procStartTicks','99999'],['group','/user.slice/other.service']]){
  test(`frozen sample with a different ${field} is never settled`,async()=>{
    // Honest launcher reports not measured after the commit hook rejects the sample.
    await armTerminal({patch:{[field]:value}});
    const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
    assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
    const stored=await ledgerState();
    assert.equal(stored.operations[0].status,'CRASHED');assert.deepEqual(stored.charged,allowance);
    assert.deepEqual(stored.operations[0].last.devices[0],{device_id:'8:0',device_inode:17,read_bytes:3,write_bytes:4});
    assert.equal(authorizations.includes('settle'),false);
  });
}

test('a launcher that claims measured after a rejected commit still cannot settle',async()=>{
  await armTerminal({patch:{pid:4243},measured:true});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
  assert.equal((await ledgerState()).operations[0].status,'CRASHED');
  assert.ok(script.commitError);
});

// ---- FTR-1c commit bound (RD-3): SET LOCAL lock_timeout 2 s and statement_timeout 3 s, no JavaScript timer ----
test('the frozen commit sets its server-side bounds first; no other runtime transaction is bounded',async()=>{
  const statements=[];
  const query=db.query.bind(db);
  db.query=(sql,params)=>{statements.push(String(sql));return query(sql,params);};
  try{
    await armTerminal();
    const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
    assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  }finally{db.query=query;}
  const lockTimeouts=statements.filter(sql=>sql.startsWith('SET LOCAL lock_timeout'));
  const statementTimeouts=statements.filter(sql=>sql.startsWith('SET LOCAL statement_timeout'));
  assert.deepEqual(lockTimeouts,["SET LOCAL lock_timeout='2000ms'"]);
  assert.deepEqual(statementTimeouts,["SET LOCAL statement_timeout='3000ms'"]);
  // Both come first in the frozen commit transaction, before its singleton lock.
  const at=statements.indexOf(lockTimeouts[0]);
  assert.equal(statements[at+1],statementTimeouts[0]);
  assert.match(statements[at+2],/^SELECT singleton FROM quant_foundation_scheduler FOR UPDATE/);
  assert.equal((await ledgerState()).operations[0].status,'SETTLED');
});

test('a held ledger row lock fails the frozen commit within about 2-3 s: COMMIT_FAILED fallback, one crash charge',async()=>{
  let openGate,release,holding;
  const held=new Promise(resolve=>{release=resolve;});
  const locked=new Promise(resolve=>{holding=resolve;});
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const before=await ledgerState();
  // Another connection keeps the ledger row locked; only the frozen commit is bounded, so it must give up.
  const holder=second.transaction(async()=>{
    await second.query('SELECT 1 FROM quant_io_ledgers FOR UPDATE');
    holding();await held;
  });
  await locked;
  const started=Date.now();
  const cancelling=runtime.cancel({ownerId:'owner-a',...args()});
  while(!script.commitError&&Date.now()-started<9000)await new Promise(resolve=>setTimeout(resolve,20));
  const elapsed=Date.now()-started;
  try{
    assert.ok(script.commitError,'the frozen commit did not fail');
    assert.ok(elapsed>=1500&&elapsed<4500,'commit failed after '+elapsed+' ms');
    // Nothing was written by the failed commit: the ledger is exactly as before and the launch is still RELEASED.
    assert.equal(canonical(await ledgerState()),canonical(before));
    assert.equal(await launchState(),'RELEASED');
    assert.equal(script.events.includes('stop'),false);
  }finally{
    release();await holder;openGate();
  }
  const cancelled=await cancelling;
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'CRASHED');
  assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].last.devices[0].read_bytes,3);
  assert.equal(authorizations.filter(action=>action==='crash').length,1);
  assert.equal(authorizations.includes('settle'),false);
  assert.deepEqual(script.events,['terminate','committed','stop']);
  assert.equal(await launchState(),'STOP_PROVEN');
});

// ---- FTR-1c-D F5: the whole frozen commit transaction fits COMMIT_BOUND_MS, not only each statement ----
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Waits until some backend is blocked on a row lock taken by the given FOR UPDATE statement on `table`. */
async function lockWaiter(table,limitMs=8000){
  const started=Date.now();
  for(;;){
    const {rows}=await second.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`,['%FROM '+table+' %FOR UPDATE%']);
    if(rows[0].waiting>0)return;
    if(Date.now()-started>limitMs)throw new Error('no backend waits for '+table);
    await pause(10);
  }
}
/** Holds a row lock in its own transaction until release() is called. */
function holdRow(sql){
  let release,held;
  const acquired=new Promise(resolve=>{held=resolve;});
  const released=new Promise(resolve=>{release=resolve;});
  const done=second.transaction(async()=>{await second.query(sql);held();await released;});
  return {acquired,release,done};
}
/** Waits for the frozen commit to fail. Returns the elapsed ms since `started`. */
async function commitFailure(started,limitMs=9000){
  while(!script.commitError&&Date.now()-started<limitMs)await pause(20);
  assert.ok(script.commitError,'the frozen commit did not fail');
  return Date.now()-started;
}
async function assertFrozenCommitFellBack(before,openGate,cancelling){
  // Nothing was written by the failed commit: the ledger is exactly as before and the launch is still RELEASED.
  assert.equal(script.commitError.code,'QUANT_IO_ACCOUNTING_UNAVAILABLE');
  assert.equal(canonical(await ledgerState()),canonical(before));
  assert.equal(await launchState(),'RELEASED');
  assert.equal(script.events.includes('stop'),false);
  openGate();
  const cancelled=await cancelling;
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.proof,'UNKNOWN_FINAL_CHARGED');
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'CRASHED');assert.deepEqual(stored.charged,allowance);
  assert.equal(authorizations.filter(action=>action==='crash').length,1);
  assert.equal(authorizations.includes('settle'),false);
  assert.deepEqual(script.events,['terminate','committed','stop']);
  assert.equal(await launchState(),'STOP_PROVEN');
}

test('two lock waits, each under lock_timeout, that together pass the age bound end unavailable with no ledger change',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const before=await ledgerState();
  // The frozen commit takes singleton, job, ledger, then launches. It waits about 1,150 ms for the ledger row and
  // about 1,150 ms for the launch row: both under lock_timeout 2,000, but 2,300 ms of age passes the 2,000 limit.
  const ledgerHolder=holdRow('SELECT 1 FROM quant_io_ledgers FOR UPDATE');
  const launchHolder=holdRow('SELECT 1 FROM quant_io_launches FOR UPDATE');
  await Promise.all([ledgerHolder.acquired,launchHolder.acquired]);
  const started=Date.now();
  const cancelling=runtime.cancel({ownerId:'owner-a',...args()});
  let ledgerWait,launchWait;
  try{
    await lockWaiter('quant_io_ledgers');
    const ledgerStarted=Date.now();
    await pause(1150);ledgerHolder.release();
    await lockWaiter('quant_io_launches');
    ledgerWait=Date.now()-ledgerStarted;
    const launchStarted=Date.now();
    await pause(1150);launchHolder.release();
    const elapsed=await commitFailure(started);
    launchWait=Date.now()-launchStarted;
    assert.ok(ledgerWait<2000&&launchWait<2000,'each lock wait stayed under lock_timeout: '+ledgerWait+' '+launchWait);
    assert.ok(elapsed>=2300&&elapsed<4500,'commit failed after '+elapsed+' ms');
  }finally{
    ledgerHolder.release();launchHolder.release();await Promise.all([ledgerHolder.done,launchHolder.done]);
  }
  await assertFrozenCommitFellBack(before,openGate,cancelling);
});

test('a write phase that pushes the frozen commit past the age bound before COMMIT rolls back with no ledger change',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const before=await ledgerState();
  // Locks are free and the age check after them passes. The ledger UPDATE then stalls 2,700 ms (client side), so the
  // transaction is 2,700 ms old right before COMMIT and must not commit late.
  const query=db.query.bind(db);let stalled=0;
  db.query=async(sql,params)=>{
    if(String(sql).includes('UPDATE quant_io_ledgers')){stalled+=1;await pause(2700);}
    return query(sql,params);
  };
  let cancelling;
  try{
    const started=Date.now();
    cancelling=runtime.cancel({ownerId:'owner-a',...args()});
    const elapsed=await commitFailure(started);
    assert.ok(elapsed>=2700&&elapsed<6000,'commit failed after '+elapsed+' ms');
    assert.equal(stalled,1);
  }finally{db.query=query;}
  await assertFrozenCommitFellBack(before,openGate,cancelling);
});

test('a frozen commit that finishes inside the age bound still settles; the age checks are frozen-commit only',async()=>{
  const statements=[];
  const query=db.query.bind(db);
  db.query=(sql,params)=>{statements.push(String(sql));return query(sql,params);};
  try{
    await armTerminal();
    statements.length=0;
    const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
    assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  }finally{db.query=query;}
  const checks=statements.map((sql,index)=>sql.includes('transaction_timestamp()')?index:-1).filter(index=>index>=0);
  assert.equal(checks.length,2,'one check after the four locks, one right before COMMIT');
  // First check sits right after the launches lock; the second right after the ledger UPDATE.
  assert.equal(checks[0],statements.findIndex(sql=>sql.startsWith('SELECT * FROM quant_io_launches'))+1);
  assert.equal(checks[1],statements.findIndex(sql=>sql.includes('UPDATE quant_io_ledgers'))+1);
  assert.equal((await ledgerState()).operations[0].status,'SETTLED');
});

// ---- W2: pre-reserve host gate (L1), emergency stop, client-side age bound (L2), no-start terminal for an empty job ----
const ledgerCount=async()=>(await db.query('SELECT count(*)::int AS n FROM quant_io_ledgers')).rows[0].n;
const launchCount=async()=>(await db.query('SELECT count(*)::int AS n FROM quant_io_launches')).rows[0].n;
const hostRefusal=cause=>Object.assign(Error('refused'),{code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED',
  ioDiagnostic:Object.freeze({phase:'PRE_RESERVE',cause})});
/** Runtime whose launcher answers the drain host gate. `gate` is called for every check. */
function gatedRuntime(gate){
  const base=fixtureLauncher();
  launcher={spawnPrepared:base.spawnPrepared,assertDrainHost:gate};
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
}

test('the drain host gate runs before the first write: a refusal leaves no ledger row and no launch row (L1)',async()=>{
  let gates=0;
  gatedRuntime(async()=>{gates++;throw hostRefusal('HOST_WRITEBACK_UNAVAILABLE');});
  await assert.rejects(runtime.reserve({...args(),expectedRevision:0,allowance}),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
    assert.deepEqual(error.ioDiagnostic,{phase:'PRE_RESERVE',cause:'HOST_WRITEBACK_UNAVAILABLE'});return true;
  });
  assert.equal(gates,1);assert.equal(await ledgerCount(),0);assert.equal(await launchCount(),0);assert.equal(spawned,0);
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'RUNNING');
  // Another failure of the gate has the same fixed code and no detail of its own.
  gatedRuntime(async()=>{throw Object.assign(Error('secret /srv/path'),{code:'EIO'});});
  await assert.rejects(runtime.reserve({...args(),expectedRevision:0,allowance}),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
    assert.equal(error.ioDiagnostic,undefined);assert.equal(String(error.message).includes('secret'),false);return true;
  });
  assert.equal(await ledgerCount(),0);assert.equal(await launchCount(),0);
  // Nothing was reserved, so the job can be cancelled with a no-start proof: ACK, no charge, no ledger row.
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(cancelled,{status:'CANCELLED',proof:'NO_START_PROVEN'});
  assert.equal(await ledgerCount(),0);assert.equal(await launchCount(),0);
  // A passing gate changes nothing: the reserve then runs exactly as before.
  await freshJob('io-runtime-gate');
  gatedRuntime(async()=>{gates++;});
  const {state}=await runtime.reserve({...args(),expectedRevision:0,allowance});
  assert.equal(state.operations[0].status,'RESERVED');assert.equal(gates,2);
  await runtime.cancel({ownerId:'owner-a',...args()});
});

test('a launcher with a drain policy but no drain host gate is refused before any write; drain 0 and a raw launcher pass (I4)',async()=>{
  const base=fixtureLauncher();
  const block=drain=>Object.freeze({version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:drain,
    tail_margin_ms:5000});
  const build=terminalConfig=>{
    launcher={spawnPrepared:base.spawnPrepared,...(terminalConfig?{terminalConfig}:{})};
    runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  };
  build(block(20000));
  await assert.rejects(runtime.assertHost(),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');assert.equal(error.ioDiagnostic,undefined);return true;
  });
  await assert.rejects(runtime.reserve({...args(),expectedRevision:0,allowance}),
    {code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'});
  assert.equal(await ledgerCount(),0);assert.equal(await launchCount(),0);assert.equal(spawned,0);
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'RUNNING');
  // Without a drain there is no host gate to owe; a launcher with no terminal block is the raw FTR-1 flow.
  for(const terminalConfig of [block(0),null]){
    build(terminalConfig);
    assert.equal(await runtime.assertHost(),undefined,JSON.stringify(terminalConfig));
  }
  // A launcher that owes the gate and has it is asked exactly once per check.
  let gates=0;
  launcher={spawnPrepared:base.spawnPrepared,terminalConfig:block(20000),assertDrainHost:async()=>{gates++;}};
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.assertHost();assert.equal(gates,1);
});

test('a job with no launch row and no operation ends with the no-start proof; any other launch row keeps the quarantine',async()=>{
  // A ledger row without operations (ledger.open committed, the reserve never did): no-start proof and ACK.
  await ledger.open({jobId:claimed.job_id,leaseToken:claimed.lease_token});
  assert.equal((await ledgerState()).operations.length,0);
  const empty=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(empty,{status:'CANCELLED',proof:'NO_START_PROVEN'});
  assert.equal((await ledgerState()).operations.length,0);assert.deepEqual((await ledgerState()).charged,{read_bytes:0,write_bytes:0});
  // Another operation's launch row is not proof about this operation: STOPPING, unresolved, nothing acknowledged.
  await freshJob('io-runtime-other-op');
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  const other=await runtime.cancel({ownerId:'owner-a',...args(),operationId:'operation-00002'});
  assert.deepEqual(other,{status:'STOPPING',proof:'UNCONFIRMED'});
  assert.equal(await launchState(),'INTENT_RECORDED');
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
});

test('emergencyStop without a handle only records the id; with a handle it stops at once and the terminal never freezes',async()=>{
  assert.equal(await runtime.emergencyStop({...args()}),null);
  assert.equal(runtime.emergency.has(claimed.job_id+':'+operationId),true);
  assert.equal(await ledgerCount(),0);assert.equal(await launchCount(),0);
  runtime.emergency.clear();
  await armTerminal({join:true});
  const proof=await runtime.emergencyStop(args());
  assert.equal(proof.unitStopped,true);assert.deepEqual(script.events,['stop']);
  await runtime.emergencyStop(args());// repeatable
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(cancelled,{status:'CANCELLED',proof:'UNKNOWN_FINAL_CHARGED'});
  assert.equal(script.calls,0,'terminate() is never called after an emergency');
  assert.equal(script.events.includes('terminate'),false);assert.equal(script.events.includes('committed'),false);
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'CRASHED');assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].last.devices[0].read_bytes,3,'no frozen observation was committed');
  assert.equal(await launchState(),'STOP_PROVEN');
  assert.equal(runtime.emergency.size,0);
});

test('an emergency during the terminal joins terminate(): one stop, no frozen commit, unknown-final charge (T-L4)',async()=>{
  await armTerminal({join:true});
  const cancelling=runtime.cancel({ownerId:'owner-a',...args()});
  const deadline=Date.now()+8000;
  while(!script.events.includes('terminate')&&Date.now()<deadline)await pause(5);
  assert.deepEqual(script.events,['terminate']);
  await pause(40);
  const at=Date.now();
  const proof=await runtime.emergencyStop(args());
  assert.equal(proof.unitStopped,true);
  const cancelled=await cancelling;
  assert.ok(Date.now()-at<1500,'ended within a poll and the fallback transactions');
  assert.deepEqual(cancelled,{status:'CANCELLED',proof:'UNKNOWN_FINAL_CHARGED'});
  assert.equal(script.calls,1);assert.deepEqual(script.events,['terminate','stop']);
  const stored=await ledgerState();
  assert.equal(stored.operations[0].status,'CRASHED');assert.deepEqual(stored.charged,allowance);
  assert.equal(stored.operations[0].last.devices[0].read_bytes,3);
  assert.equal(await launchState(),'STOP_PROVEN');
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'CANCELLED');
  assert.equal(runtime.emergency.size,0);
});

test('a drain that finishes normally is unaffected by the join model: measured settle (T-L4 control)',async()=>{
  await armTerminal({join:true,drainOver:true});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(cancelled,{status:'CANCELLED',proof:'MEASURED_FINAL_SETTLED'});
  assert.deepEqual(script.events,['terminate','committed','stop']);
  assert.deepEqual((await ledgerState()).charged,{read_bytes:7,write_bytes:9});
});

// ---- W2 L2: the frozen commit also counts the client clock (pool checkout, BEGIN round trip) ----
/** Runtime database that delays the first transaction (a slow pool checkout) and the first ledger UPDATE, and counts the
 * server-side age checks. Armed after armTerminal(), so the first transaction is the frozen commit's. */
function slowClientDb({checkoutMs=0,updateStallMs=0}){
  const seen={ageChecks:0,transactions:0};
  let stalled=false;
  runtime.db={get isTransaction(){return db.isTransaction;},
    async query(sql,params){
      const text=String(sql);
      if(text.includes('transaction_timestamp()'))seen.ageChecks++;
      if(updateStallMs&&!stalled&&text.includes('UPDATE quant_io_ledgers')){stalled=true;await pause(updateStallMs);}
      return db.query(sql,params);
    },
    async transaction(callback){
      seen.transactions++;
      if(seen.transactions===1&&checkoutMs)await pause(checkoutMs);
      return db.transaction(callback);
    }};
  return seen;
}

test('a slow pool checkout before BEGIN fails the frozen commit at the first age check: no server check, no ledger change (L2)',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const before=await ledgerState();
  // The transaction starts 2,100 ms late on the client clock: the server-side age is still tiny, so only the client
  // clock can catch it. It is over the 2,000 ms limit at the first check.
  const seen=slowClientDb({checkoutMs:2100});
  const started=Date.now();
  const cancelling=runtime.cancel({ownerId:'owner-a',...args()});
  const elapsed=await commitFailure(started);
  assert.ok(elapsed>=2100&&elapsed<5000,'commit failed after '+elapsed+' ms');
  assert.equal(seen.ageChecks,0,'the client check fails before any server check');
  await assertFrozenCommitFellBack(before,openGate,cancelling);
});

test('a pool checkout that passes the first check but not the pre-COMMIT limit still rolls back (L2)',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const before=await ledgerState();
  // 1,800 ms of checkout leaves the first check (2,000 ms) satisfied; the 800 ms UPDATE stall then puts the client
  // clock at about 2,650 ms, over the 2,500 ms pre-COMMIT limit, while the server clock only reads about 830 ms.
  const seen=slowClientDb({checkoutMs:1800,updateStallMs:800});
  const started=Date.now();
  const cancelling=runtime.cancel({ownerId:'owner-a',...args()});
  const elapsed=await commitFailure(started);
  assert.ok(elapsed>=2600&&elapsed<6000,'commit failed after '+elapsed+' ms');
  assert.equal(seen.ageChecks,1,'the first check passed on both clocks; the second failed on the client clock alone');
  await assertFrozenCommitFellBack(before,openGate,cancelling);
});

test('a checkout well inside the limits still settles; both clocks are checked twice (L2 control)',async()=>{
  await armTerminal();
  const seen=slowClientDb({checkoutMs:600});
  const cancelled=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.equal(cancelled.proof,'MEASURED_FINAL_SETTLED');
  assert.equal(seen.ageChecks,2);
  assert.equal((await ledgerState()).operations[0].status,'SETTLED');
});

test('a bounded transaction without an entry timestamp fails closed before any statement (L2)',async()=>{
  const statements=[];
  const query=db.query.bind(db);
  db.query=(sql,params)=>{statements.push(String(sql));return query(sql,params);};
  try{
    await assert.rejects(runtime.locked(claimed.job_id,claimed.lease_token,async()=>{},{active:false,bounded:true}),
      {code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
    await assert.rejects(runtime.locked(claimed.job_id,claimed.lease_token,async()=>{},
      {active:false,bounded:true,enteredAt:Number.NaN}),{code:'QUANT_IO_ACCOUNTING_UNAVAILABLE'});
  }finally{db.query=query;}
  assert.deepEqual(statements,[]);
});

// ---- W2 T-P8: a held job row lock fails the frozen commit by lock_timeout, no late commit ----
test('a held job row lock fails the frozen commit within about 2-3.5 s; the fallback follows the release; no late commit (T-P8)',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  // STOPPING first: runtime.cancel() would queue behind the holder on the job row before it ever reached the terminal.
  await scheduler.cancel('owner-a',claimed.job_id);
  const before=await ledgerState();
  const holder=holdRow('SELECT 1 FROM quant_foundation_jobs FOR UPDATE');
  await holder.acquired;
  const started=Date.now();
  const terminating=runtime.terminal(args());
  let elapsed;
  try{
    elapsed=await commitFailure(started);
    assert.ok(elapsed>=1500&&elapsed<3500,'commit failed after '+elapsed+' ms');
    assert.equal(canonical(await ledgerState()),canonical(before));
    assert.equal(await launchState(),'RELEASED');
    assert.equal(script.events.includes('stop'),false);
  }finally{
    holder.release();await holder.done;
  }
  await assertFrozenCommitFellBack(before,openGate,terminating);
  const stored=await ledgerState();
  assert.equal(stored.revision,4,'reserve, bind, crash, crash acknowledgement: the failed commit added no revision');
  assert.equal(stored.operations[0].last.devices[0].read_bytes,3,'the frozen sample never landed');
});

test('the server-side age check still catches a slow transaction when the client clock reads fast (L2)',async()=>{
  let openGate;
  await armTerminal({gate:new Promise(resolve=>{openGate=resolve;})});
  const before=await ledgerState();
  // The client clock is frozen for this test, so only clock_timestamp() - transaction_timestamp() can see the delay.
  // The ledger UPDATE stalls 2,700 ms: the transaction is over the 2,500 ms limit right before COMMIT.
  const realNow=performance.now.bind(performance);
  const frozen=realNow();
  Object.defineProperty(performance,'now',{value:()=>frozen,configurable:true,writable:true});
  const query=db.query.bind(db);let stalled=0;
  db.query=async(sql,params)=>{
    if(String(sql).includes('UPDATE quant_io_ledgers')){stalled+=1;await pause(2700);}
    return query(sql,params);
  };
  let cancelling;
  try{
    const started=Date.now();
    cancelling=runtime.cancel({ownerId:'owner-a',...args()});
    const elapsed=await commitFailure(started);
    assert.ok(elapsed>=2700&&elapsed<6000,'commit failed after '+elapsed+' ms');
    assert.equal(stalled,1);
  }finally{
    db.query=query;
    Object.defineProperty(performance,'now',{value:realNow,configurable:true,writable:true});
  }
  await assertFrozenCommitFellBack(before,openGate,cancelling);
});

test('an inconsistent job (a launch row without an operation, or an operation without a launch row) is never a no-start proof',async()=>{
  // Ledger open, no operation, but another operation has a launch row: not "nothing reserved".
  await ledger.open({jobId:claimed.job_id,leaseToken:claimed.lease_token});
  await db.query(`INSERT INTO quant_io_launches (job_id,operation_id,lease_token,unit_name,payload_hash,state,created_at)
    VALUES ($1,'operation-00002',$2,$3,$4,'STARTING',$5)`,
    [claimed.job_id,claimed.lease_token,quantIoUnitName(claimed.job_id,'operation-00002'),QUANT_IO_DIAGNOSTIC_PAYLOAD_HASH,now]);
  const stray=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(stray,{status:'STOPPING',proof:'UNCONFIRMED'});
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
  // An operation in the ledger without its launch row: the ledger holds an unresolved operation, so nothing is acknowledged.
  await freshJob('io-runtime-orphan-op');
  runtime=new QuantIoRuntime({db,ledger,scheduler,launcher,clock:()=>now});
  await runtime.reserve({...args(),expectedRevision:0,allowance});
  await db.query('ALTER TABLE quant_io_launches DISABLE TRIGGER USER');
  try{await db.query('DELETE FROM quant_io_launches');}finally{await db.query('ALTER TABLE quant_io_launches ENABLE TRIGGER USER');}
  assert.equal(await launchCount(),0);
  // The runtime itself refuses (UNCONFIRMED); it does not rely on the SQL guard to reject an acknowledgement.
  const orphan=await runtime.cancel({ownerId:'owner-a',...args()});
  assert.deepEqual(orphan,{status:'STOPPING',proof:'UNCONFIRMED'});
  assert.equal((await ledgerState()).operations[0].status,'RESERVED');
  assert.equal((await db.query('SELECT status FROM quant_foundation_jobs')).rows[0].status,'STOPPING');
});
