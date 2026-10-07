import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {checkDatabaseUrl,checkEnvironment,parseOptions,plannedConnections,serverConnection}
  from '../../scripts/measure-d6-prepare-begin.mjs';

// The D6 harness is a measurement tool, so these tests check its report shape, its sanity and its database refusals.
// They assert no latency threshold. CI reaches its PostgreSQL service container through a loopback port mapping, so
// the server reports its bridge address; the database runs pass --forwarded-loopback, the narrow development-only
// allowance for that case.
const forwarded='--forwarded-loopback';
const script=fileURLToPath(new URL('../../scripts/measure-d6-prepare-begin.mjs',import.meta.url));
const database=process.env.TEST_DATABASE_URL;
const needsDatabase=!database&&'TEST_DATABASE_URL is absent; the harness run needs isolated PostgreSQL';

function harness(args,env){
  const base={...process.env};
  for(const key of Object.keys(base))
    if(/^PG/i.test(key)||['D6_DATABASE_URL','TEST_DATABASE_URL','DATABASE_URL','NODE_OPTIONS','NODE_PG_FORCE_NATIVE'].includes(key))
      delete base[key];
  return new Promise(resolve=>execFile(process.execPath,[script,...args],
    {env:{...base,PAPER_TRADING:'true',SMTP_HOST:'',...env},timeout:50000,maxBuffer:8*1024*1024,windowsHide:true},
    (error,stdout,stderr)=>resolve({code:error?(typeof error.code==='number'?error.code:-1):0,stdout,stderr})));
}
const lastLine=text=>JSON.parse(text.trim().split('\n').at(-1));

async function scratchDatabase(t,prefix){
  const admin=new PostgresDatabase({connectionString:database,max:1});
  const name=prefix+randomUUID().replaceAll('-','').slice(0,16);
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(database);url.pathname='/'+name;
  const db=new PostgresDatabase({connectionString:url.toString(),max:1});
  t.after(async()=>{await db.close();await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');await admin.close();});
  return {name,url:url.toString(),db};
}

test('server address check accepts loopback, and a private bridge address only with the development-only option',()=>{
  const loopback=checkDatabaseUrl('postgresql://d6user:not-a-secret@127.0.0.1:5432/d6_local');
  const socket=checkDatabaseUrl('postgresql:///d6_local?host=/var/run/postgresql');
  assert.deepEqual([loopback.connection,socket.connection],['loopback','unix-socket']);
  for(const address of ['127.0.0.1','::1']){
    assert.equal(serverConnection(loopback,address),'loopback');
    assert.equal(serverConnection(loopback,address,{forwardedLoopback:true}),'loopback');
  }
  for(const address of ['172.18.0.2','172.16.0.1','172.31.255.254','10.1.2.3','192.168.5.6','fd12:3456::2']){
    assert.equal(serverConnection(loopback,address),null,address);
    assert.equal(serverConnection(loopback,address,{forwardedLoopback:true}),'loopback-forwarded-private',address);
  }
  for(const address of ['8.8.8.8','203.0.113.5','172.15.0.1','172.32.0.1','192.169.0.1','11.0.0.1','fe80::1','2001:db8::1',null,'']){
    assert.equal(serverConnection(loopback,address),null,String(address));
    assert.equal(serverConnection(loopback,address,{forwardedLoopback:true}),null,String(address));
  }
  assert.equal(serverConnection(socket,null),'unix-socket');
  for(const address of ['127.0.0.1','172.18.0.2'])assert.equal(serverConnection(socket,address,{forwardedLoopback:true}),null);
  const env={D6_DATABASE_URL:'postgresql://d6user:not-a-secret@127.0.0.1:5432/d6_local'};
  assert.equal(parseOptions([],env).options['forwarded-loopback'],false);
  assert.equal(parseOptions([forwarded],env).options['forwarded-loopback'],true);
  const refused=(argv,environment,code)=>assert.throws(()=>parseOptions(argv,environment),error=>error.code===code);
  refused([forwarded,'--evidence-class=staging-run'],env,'D6_FORWARDED_LOOPBACK_REFUSED');
  refused([forwarded],{D6_DATABASE_URL:'postgresql:///d6_local?host=/var/run/postgresql'},'D6_FORWARDED_LOOPBACK_REFUSED');
  refused(['--forwarded-loopback=1'],env,'D6_USAGE');
});

test('environment check refuses session options, preloads and the native driver, and connection planning is bounded',()=>{
  for(const key of ['PGOPTIONS','NODE_OPTIONS','NODE_PG_FORCE_NATIVE'])
    assert.throws(()=>checkEnvironment({[key]:''}),error=>error.code==='D6_ENVIRONMENT_REFUSED',key);
  assert.throws(()=>checkEnvironment({PAPER_TRADING:'false'}),error=>error.code==='D6_PAPER_TRADING_REQUIRED');
  assert.doesNotThrow(()=>checkEnvironment({PAPER_TRADING:'true',PGPASSWORD:'scrubbed-later'}));
  const env={D6_DATABASE_URL:'postgresql://d6user:not-a-secret@127.0.0.1:5432/d6_local'};
  // Defaults: the measuring pool (5) and its rate-limit pool (2), plus 2 + 2 for each of the 6 default contenders.
  assert.equal(plannedConnections(parseOptions([],env).options),31);
  assert.equal(plannedConnections(parseOptions(['--read=8','--cancel=8','--claim=0','--hash=0','--vacuum=0'],env).options),71);
});

test('harness refuses a missing, non-test, remote or rerouted database and bad settings before it connects',async()=>{
  // Port 1 is never reached: a harness that connected instead of refusing would exit 1, not 2.
  const local='postgresql://d6user:not-a-secret@127.0.0.1:1/';
  const cases=[
    [[],{},'D6_DATABASE_URL_REQUIRED'],
    [[],{TEST_DATABASE_URL:local+'d6_fallback',DATABASE_URL:local+'d6_fallback'},'D6_DATABASE_URL_REQUIRED'],
    [[],{D6_DATABASE_URL:local+'postgres'},'D6_DATABASE_NAME_REFUSED'],
    [[],{D6_DATABASE_URL:local+'robot_test'},'D6_DATABASE_NAME_REFUSED'],
    [[],{D6_DATABASE_URL:local+'staging_d6'},'D6_DATABASE_NAME_REFUSED'],
    [[],{D6_DATABASE_URL:'postgresql://d6user:not-a-secret@db.example.test:5432/d6_remote'},'D6_DATABASE_HOST_REFUSED'],
    [[],{D6_DATABASE_URL:local+'d6_local?host=db.example.test'},'D6_DATABASE_HOST_REFUSED'],
    [[],{D6_DATABASE_URL:local+'d6_local?sslmode=disable'},'D6_DATABASE_URL_INVALID'],
    [[],{D6_DATABASE_URL:'mysql://d6user:not-a-secret@127.0.0.1:1/d6_local'},'D6_DATABASE_URL_INVALID'],
    [['--database-url='+local+'d6_other'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [['--samples=0'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [['--samples=5001'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [['--read=9'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [['--max-seconds=601'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [['--unknown=1'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [[forwarded,'--evidence-class=staging-run'],{D6_DATABASE_URL:local+'d6_local'},'D6_FORWARDED_LOOPBACK_REFUSED'],
    [[forwarded],{D6_DATABASE_URL:'postgresql:///d6_local?host=/var/run/postgresql'},'D6_FORWARDED_LOOPBACK_REFUSED'],
    [['--forwarded-loopback=1'],{D6_DATABASE_URL:local+'d6_local'},'D6_USAGE'],
    [[],{D6_DATABASE_URL:local+'d6_local',PAPER_TRADING:'false'},'D6_PAPER_TRADING_REQUIRED'],
    [[],{D6_DATABASE_URL:local+'d6_local',NODE_OPTIONS:'--no-warnings'},'D6_ENVIRONMENT_REFUSED'],
    [[],{D6_DATABASE_URL:local+'d6_local',PGOPTIONS:'-c lock_timeout=0'},'D6_ENVIRONMENT_REFUSED'],
    [[],{D6_DATABASE_URL:local+'d6_local',NODE_PG_FORCE_NATIVE:'1'},'D6_ENVIRONMENT_REFUSED']];
  if(process.platform!=='linux')cases.push([['--evidence-class=staging-run'],{D6_DATABASE_URL:local+'d6_local'},'D6_EVIDENCE_CLASS_REFUSED']);
  // The real test database is a non-test name for the harness unless an operator chose a d6_ name for it.
  if(database&&!new URL(database).pathname.startsWith('/d6_'))cases.push([[],{D6_DATABASE_URL:database},'D6_DATABASE_NAME_REFUSED']);
  // Four at a time keeps the process count modest on small hosts.
  const runs=[];
  for(let index=0;index<cases.length;index+=4)
    runs.push(...await Promise.all(cases.slice(index,index+4).map(([args,env])=>harness(args,env))));
  runs.forEach((run,index)=>{
    const expected=cases[index][2];
    assert.equal(run.code,2,expected+': '+run.stderr);
    assert.deepEqual(lastLine(run.stderr),{error:expected});
    assert.equal(run.stdout,'');
    assert.ok(!run.stderr.includes('not-a-secret')&&!run.stderr.includes('example.test'));
  });
});

test('harness refuses a d6 database that already holds a relation and writes nothing into it',{skip:needsDatabase},async t=>{
  const {db,url}=await scratchDatabase(t,'d6_nonempty_');
  await db.query('CREATE TABLE operator_data(id int)');
  const run=await harness([forwarded],{D6_DATABASE_URL:url});
  assert.equal(run.code,2,run.stderr);
  assert.deepEqual(lastLine(run.stderr),{error:'D6_DATABASE_NOT_EMPTY'});
  const relations=(await db.query(`SELECT count(*)::int n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s
    ON s.oid=c.relnamespace WHERE s.nspname NOT IN ('pg_catalog','information_schema') AND s.nspname NOT LIKE 'pg\\_%'`)).rows[0].n;
  assert.equal(relations,1);
});

test('without --forwarded-loopback a non-loopback server address is refused before any write',{skip:needsDatabase},async t=>{
  const {db,url}=await scratchDatabase(t,'d6_address_');
  const address=(await db.query('SELECT host(inet_server_addr()) address')).rows[0].address;
  if(['127.0.0.1','::1'].includes(address)){t.skip('the server reports a loopback address here; CI covers the forwarded case');return;}
  const run=await harness([],{D6_DATABASE_URL:url});
  assert.equal(run.code,2,run.stderr);
  assert.deepEqual(lastLine(run.stderr),{error:'D6_DATABASE_IDENTITY_MISMATCH'});
  const relations=(await db.query("SELECT count(*)::int n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public'")).rows[0].n;
  assert.equal(relations,0);
});

test('harness measures prepare and BEGIN under every contention kind and reports a sane, redacted shape',{skip:needsDatabase},async t=>{
  const {db,url,name}=await scratchDatabase(t,'d6_run_');
  const run=await harness(['--samples=3','--warmup=1','--max-seconds=30','--read=1','--cancel=1','--claim=1','--hash=1',
    '--vacuum=1','--think-ms=1','--settle-ms=20','--vacuum-interval-ms=100','--heartbeat-ms=50',forwarded],{D6_DATABASE_URL:url});
  assert.equal(run.code,0,run.stderr);
  const report=JSON.parse(run.stdout);
  assert.equal(report.report,'d6-prepare-begin-v1');
  assert.equal(report.evidence_class,'development-only');
  const source=(await fs.readFile(script,'utf8')).replaceAll('\r\n','\n');
  assert.equal(report.harness.sha256,createHash('sha256').update(source).digest('hex'));
  assert.match(report.product.ingestion_engine_hash,/^[0-9a-f]{64}$/);
  assert.equal(report.environment.platform,process.platform);assert.equal(report.environment.node,process.version);
  assert.ok(['loopback','loopback-forwarded-private'].includes(report.environment.database_connection));
  assert.equal(report.settings['forwarded-loopback'],true);
  assert.match(report.environment.postgres.server_version,/^\d+/);
  assert.equal(report.settings.samples,3);assert.equal(report.settings.read,1);
  const samples=report.samples;
  assert.equal(samples.requested,3);assert.equal(samples.warmup,1);
  assert.ok(['samples','time-cap'].includes(samples.stopped_by));
  assert.ok(samples.measured>=1&&samples.measured<=3);
  assert.equal(samples.measured,samples.completed+samples.frame_check_failed+samples.prepare_failed+samples.begin_failed);
  // The fixture must reach BEGIN: a run whose samples all fail would time only failure paths.
  assert.ok(samples.completed>=1,JSON.stringify(report.failures));
  assert.equal(samples.frame_check_failed,0);assert.equal(samples.prepare_failed,0);
  assert.deepEqual(report.failures.frame_check,{});assert.deepEqual(report.failures.prepare,{});
  assert.ok(report.phases.begin.count>=1);
  assert.equal(report.p99_reliable,false);
  for(const [name,size] of Object.entries(report.fixture))assert.ok(Number.isSafeInteger(size)&&size>0,name);
  const connections=report.environment.connections;
  assert.equal(connections.planned,plannedConnections(report.settings));assert.ok(connections.free_after_plan>=20);
  for(const [phase,stats] of Object.entries(report.phases)){
    if(stats.count===0)continue;
    const order=[stats.min,stats.p50,stats.p95,stats.p99,stats.max];
    assert.ok(order.every(value=>Number.isFinite(value)&&value>=0),phase);
    assert.ok(order.every((value,index)=>index===0||order[index-1]<=value),phase);
    assert.ok(stats.mean>=stats.min&&stats.mean<=stats.max,phase);
  }
  assert.equal(report.phases.combined.count,samples.completed);
  assert.equal(report.phases.post_frame_total.count,samples.completed);
  assert.equal(report.phases.frame_check.count,samples.measured);
  const heartbeats=report.heartbeat.timer_duration.count+report.heartbeat.probe_duration.count;
  assert.ok(heartbeats>=1,'the probe or the timer records a heartbeat duration');
  const worst=report.worst_case;
  assert.ok(Math.abs(worst.ms-(report.phases.prepare.p99+worst.heartbeat_max+report.phases.begin.p99))<0.01);
  assert.equal(report.phases.prepare.count,samples.measured-samples.prepare_failed);
  const beginFailures=Object.values(report.failures.begin).reduce((sum,count)=>sum+count,0);
  assert.equal(beginFailures,samples.begin_failed);
  assert.equal(report.serialization.retries,0);
  assert.equal(report.serialization.failures,report.failures.begin['40001']??0);
  for(const role of ['read','cancel','claim','hash','vacuum']){
    assert.equal(report.contention[role].processes,1,role);assert.equal(report.contention[role].reported,1,role);
  }
  assert.ok(Object.values(report.contention).reduce((sum,entry)=>sum+entry.ops,0)>0);
  // Every sample job was released: nothing holds the global slot after the run.
  const held=(await db.query("SELECT count(*)::int n FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED','RUNNING','STOPPING')")).rows[0].n;
  assert.equal(held,0);
  const parsed=new URL(url);
  for(const secret of [url,parsed.username,parsed.password,name,os.tmpdir(),os.homedir(),process.cwd(),os.hostname()])
    if(secret&&secret.length>3)assert.ok(!run.stdout.includes(secret),'report must not hold machine or connection details');
});