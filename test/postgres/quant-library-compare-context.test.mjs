import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {QuantLibraryService} from '../../src/postgres/quant-library.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {runOf,seedRun,MARKERS,T0} from '../helpers/quant-library-fixture.mjs';

// The compare answer of a compatible set carries the shared context (market, dataset window, cost model) taken from the same
// derivation as the list rows and equal to the detail view. Every run is a LABELLED FIXTURE written with plain inserts.
let admin,db,store,service,databaseName,owner,other;
const AT=index=>T0+index*3_600_000;
const BASE_KEYS=['compatibility_key','completion_reason','created_at','diagnostic','engine_family','finished_at','library_class','library_group','qualification','run_id','status'];
const install=async name=>db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8')));

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_qlib_ctx_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:6});await db.migrate();
  await install('pine-bridge-schema.sql');await install('quant-research-schema.sql');
  store=new Store(db);service=new QuantLibraryService(db);
});
after(async()=>{
  await db?.close();
  if(admin){if(databaseName)await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.close();}
});
async function newOwner(label){
  const password='qlib-'+randomUUID(),user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword(password)});
  await store.setRisk(user.id,structuredClone(config.defaultRisk));
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:MARKERS.policy};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hash(importId),'Library fixture',MARKERS.source,'{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hash(canonical(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
const make=(who,options)=>runOf({owner:who.id,deployment:who.deployment,importId:who.importId,...options});
const put=async(who,options)=>{const run=make(who,options);await seedRun(db,run,{owner:who.id,deployment:who.deployment});return run;};
const pickContext=detail=>{
  const d=detail.provenance.dataset,m=detail.provenance.cost_policy.model;
  return {market:d.market,dataset:{start_time:d.start_time,end_time:d.end_time,warmup_bars:d.warmup_bars,bar_count:d.bar_count,digest_kind:d.digest_kind,digest:d.digest},
    cost:{fee_bps:m.fee_bps,slippage_bps:m.slippage_bps}};
};

test('compatible compare: every run carries the market, dataset window and cost model, equal to its detail view and its list row',async()=>{
  owner=await newOwner('qctx-a');other=await newOwner('qctx-b');
  const runs={
    pending:await put(owner,{scenario:'PENDING',at:AT(2),fee:12,slippage:3}),
    noValid:await put(owner,{scenario:'NO_VALID',candidates:12,at:AT(1),fee:12,slippage:3}),
    failed:await put(owner,{status:'FAILED',diagnostic:'QUANT_ENGINE_CHANGED',partial:2,at:AT(3),fee:12,slippage:3}),
    otherData:await put(owner,{scenario:'NO_VALID',candidates:6,tag:'b',at:AT(4),fee:12,slippage:3}),
    foreign:await put(other,{scenario:'PENDING',at:AT(5)})};
  const ids=[runs.pending,runs.noValid,runs.failed].map(run=>run.run_id);
  const body=await service.compare(owner.id,ids);
  assert.equal(body.verdict,'COMPATIBLE');assert.deepEqual(body.mismatches,[]);
  assert.deepEqual(body.runs.map(run=>run.run_id),[runs.noValid,runs.pending,runs.failed].map(run=>run.run_id),'created order');
  const listed=Object.fromEntries((await service.list(owner.id)).runs.map(run=>[run.run_id,run]));
  for(const run of body.runs){
    const detail=await service.detail(owner.id,run.run_id),expected=pickContext(detail);
    assert.deepEqual(run.market,expected.market,'market equals the detail view');
    assert.deepEqual(run.dataset,expected.dataset,'dataset window equals the detail view');
    assert.deepEqual(run.cost,expected.cost,'cost model equals the detail view');
    assert.deepEqual(run.market,{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
    assert.deepEqual(run.cost,{fee_bps:12,slippage_bps:3});
    assert.equal(run.dataset.bar_count,1000);assert.equal(run.dataset.warmup_bars,300);assert.equal(run.dataset.digest_kind,'ql3a-dataset-sha256-v1');
    const row=listed[run.run_id];
    assert.deepEqual([run.market,run.dataset,run.cost],[row.market,row.dataset,row.cost],'the same derivation as the list row');
    for(const key of BASE_KEYS)assert.ok(Object.hasOwn(run,key),key+' stays');
    assert.ok(Object.hasOwn(run,'disclosed')&&Object.hasOwn(run,'metrics')&&Object.hasOwn(run,'metrics_reason'),'existing fields stay');
  }
  assert.equal(JSON.stringify(body).includes(MARKERS.source),false);assert.equal(JSON.stringify(body).includes(MARKERS.bar),false);
  assert.equal(JSON.stringify(body).includes(other.id),false,'no other owner');

  // Another dataset: the verdict is INCOMPATIBLE and a run keeps the base shape only.
  const different=await service.compare(owner.id,[runs.pending.run_id,runs.otherData.run_id]);
  assert.equal(different.verdict,'INCOMPATIBLE');assert.deepEqual(different.mismatches.map(item=>item.field),['dataset']);
  for(const run of different.runs)assert.deepEqual(Object.keys(run).sort(),BASE_KEYS,'incompatible runs keep the base shape');

  // Owner scoping is unchanged: a foreign run is not found, whatever else is asked.
  await assert.rejects(service.compare(owner.id,[runs.pending.run_id,runs.foreign.run_id]),error=>error.status===404||error.code==='NOT_FOUND');
});
