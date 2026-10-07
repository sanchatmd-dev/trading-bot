import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';

// The D6 harness is a measurement tool, so these tests check its report shape, its sanity and its database refusals.
// They assert no latency threshold.
const script=fileURLToPath(new URL('../../scripts/measure-d6-prepare-begin.mjs',import.meta.url));
const database=process.env.TEST_DATABASE_URL;
const needsDatabase=!database&&'TEST_DATABASE_URL is absent; the harness run needs isolated PostgreSQL';

function harness(args,env){
  const base={...process.env};
  for(const key of ['D6_DATABASE_URL','TEST_DATABASE_URL','DATABASE_URL'])delete base[key];
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
    [[],{D6_DATABASE_URL:local+'d6_local',PAPER_TRADING:'false'},'D6_PAPER_TRADING_REQUIRED']];
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
  const run=await harness([],{D6_DATABASE_URL:url});
  assert.equal(run.code,2,run.stderr);
  assert.deepEqual(lastLine(run.stderr),{error:'D6_DATABASE_NOT_EMPTY'});
  const relations=(await db.query(`SELECT count(*)::int n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s
    ON s.oid=c.relnamespace WHERE s.nspname NOT IN ('pg_catalog','information_schema') AND s.nspname NOT LIKE 'pg\\_%'`)).rows[0].n;
  assert.equal(relations,1);
});

test('harness measures prepare and BEGIN under every contention kind and reports a sane, redacted shape',{skip:needsDatabase},async t=>{
  const {db,url,name}=await scratchDatabase(t,'d6_run_');
  const run=await harness(['--samples=3','--warmup=1','--max-seconds=30','--read=1','--cancel=1','--claim=1','--hash=1',
    '--vacuum=1','--think-ms=1','--settle-ms=20','--vacuum-interval-ms=100','--heartbeat-ms=50'],{D6_DATABASE_URL:url});
  assert.equal(run.code,0,run.stderr);
  const report=JSON.parse(run.stdout);
  assert.equal(report.report,'d6-prepare-begin-v1');
  assert.equal(report.evidence_class,'development-only');
  const source=(await fs.readFile(script,'utf8')).replaceAll('\r\n','\n');
  assert.equal(report.harness.sha256,createHash('sha256').update(source).digest('hex'));
  assert.match(report.product.ingestion_engine_hash,/^[0-9a-f]{64}$/);
  assert.equal(report.environment.platform,process.platform);assert.equal(report.environment.node,process.version);
  assert.equal(report.environment.database_connection,'loopback');
  assert.match(report.environment.postgres.server_version,/^\d+/);
  assert.equal(report.settings.samples,3);assert.equal(report.settings.read,1);
  const samples=report.samples;
  assert.equal(samples.requested,3);assert.equal(samples.warmup,1);
  assert.ok(['samples','time-cap'].includes(samples.stopped_by));
  assert.ok(samples.measured>=1&&samples.measured<=3);
  assert.equal(samples.measured,samples.completed+samples.prepare_failed+samples.begin_failed);
  for(const [phase,stats] of Object.entries(report.phases)){
    if(stats.count===0)continue;
    const order=[stats.min,stats.p50,stats.p95,stats.p99,stats.max];
    assert.ok(order.every(value=>Number.isFinite(value)&&value>=0),phase);
    assert.ok(order.every((value,index)=>index===0||order[index-1]<=value),phase);
    assert.ok(stats.mean>=stats.min&&stats.mean<=stats.max,phase);
  }
  assert.equal(report.phases.combined.count,samples.completed);
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