import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {INSERT_ONLY_SQLSTATE,INSERT_GUARD_SQLSTATE,SERIALIZABLE_SQLSTATE,migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {QuantResearchWorker} from '../../src/postgres/quant-research-worker.js';
import {engineHash} from '../../src/postgres/quant-research.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {LIBRARY_VERSIONS} from '../../src/quant-library/derive.js';
import {PACKAGE_FILES,TRACE_FILES,CANDIDATE_BLOCKERS,ENGINEERING_SCOPE,evaluateProvenance} from '../../src/quant-library/package-gates.js';
import {renderPackage} from '../../src/quant-library/package-render.js';
import {driverEvaluation,gateTraceReproduction,reproduceRun,resolveInterpreter,traceReproductionEngineHash,traceReproductionRecords} from '../../src/quant-library/trace-reproduction.js';
import {FIXTURE_LABEL,contractOf,hex,MINUTE,T0} from '../helpers/quant-library-fixture.mjs';

/*
 * F09 builder S3c acceptance, PostgreSQL side (docs/design/f09-trace-repro/JUDGEMENT.md section 7, tests C3 and C4), on a throwaway cluster.
 *
 *   C3  the round-trip premise (J5): a fixture run is stored by the real QuantResearchWorker step/run/finish code into JSONB and read back through
 *       src/postgres/db.js; the S3 digests recomputed by the real driver equal the digests of the read-back `selected`. LABEL: C3 evidence on a v1
 *       fixture run, not B0 or build evidence. Needs an interpreter (QUANT_RESEARCH_PYTHON, else quant_lab/.venv; never a bare python from PATH);
 *       skipped with a reason elsewhere. A failure here is a design fact for root, never a tolerance.
 *   C4  the three bi_trace_reproductions rows: they insert after the seq 1 event in one SERIALIZABLE transaction; before the event QR004; outside
 *       SERIALIZABLE QR003; a fourth path 23514; a duplicate path 23505; UPDATE, DELETE and TRUNCATE QR002; the rows read back through db.js
 *       (int8 arrives as an integer, auditor note N8) feed gateTraceReproduction and the C3 gate. A raw pg read would return the int8 as text and
 *       drop every row, which is pinned too.
 *
 * Every row here is a LABELLED FIXTURE (synthetic, never a research result). Rows are insert-only, so each test uses its own export.
 * The worker engine step runs the real research engine; only the SPT Custom source enrolment is replaced, by a bootstrap script (see closure test).
 */

const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501',CHECK_VIOLATION='23514',UNIQUE_VIOLATION='23505';
const HEX64=/^[0-9a-f]{64}$/;
const LABEL='C3 evidence on a v1 fixture run, not B0 or build evidence';
const PYTHON=resolveInterpreter();
const NO_PYTHON=PYTHON?false:'no interpreter: QUANT_RESEARCH_PYTHON is unset and quant_lab/.venv is absent (a bare python from PATH is never used)';
const clone=value=>JSON.parse(JSON.stringify(value));
// In CI (the postgres job runs `uv sync`, so quant_lab/.venv exists) the interpreter-gated C3 cases must run, never skip.
test('C3 cases run in CI: an interpreter resolves there',{skip:process.env.CI!=='true'&&'checked only in CI'},()=>{assert.ok(PYTHON,NO_PYTHON||'');});
const sha=value=>createHash('sha256').update(value).digest('hex');
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const refused=(promise,code)=>assert.rejects(promise,{code});
const refusedWith=(promise,code,message)=>assert.rejects(promise,error=>error.code===code&&message.test(error.message));
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const grantScript=async role=>(await fs.readFile(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");

let admin,owner,rt,plain,store,templateName,databaseName,roleName,scratchDir,OWNER_A;
const pools=[];
const track=pool=>{pools.push(pool);return pool;};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL,max:2});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_s3c_tpl_'+suffix;databaseName='robot_s3c_main_'+suffix;roleName='robot_s3c_rt_'+suffix.slice(0,14);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await builder.transaction(async()=>builder.query(await sqlText(name)));
    await migrateBestInputsPackage(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  owner=track(new PostgresDatabase({connectionString:urlOf(databaseName),max:3}));
  store=new Store(owner);
  await owner.query(await grantScript(roleName));
  rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:3})));
  plain=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:1}));
  scratchDir=await fs.mkdtemp(path.join(os.tmpdir(),'s3c-trace-pg-'));
  OWNER_A=await newOwner('s3c');
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(scratchDir)await fs.rm(scratchDir,{recursive:true,force:true}).catch(()=>{});
  if(admin){
    for(const name of [databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
    await admin.close();
  }
});

/* ---- owner, run and export builders (labelled fixtures; the shape of test/postgres/best-inputs-package.test.mjs) ---- */

async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:'bi-fixture'};
  await owner.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hex(importId),'Package fixture','//@version=6\nindicator("x")','{}',T0]);
  await owner.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hex(JSON.stringify(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
/** A SUCCEEDED labelled fixture run row written directly (the C4 cases need a run for the export, not a real result). */
async function syntheticRun(who){
  const runId='run-'+randomUUID();
  await owner.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'SUCCEEDED',$8,$8,$9)`,[runId,who.id,who.deployment,'idem-'+runId,hex('submission'),hex('contract'),JSON.stringify({scope:ENGINEERING_SCOPE,label:FIXTURE_LABEL}),T0,T0+900000]);
  return runId;
}
const UTC=new Date(T0).toISOString();
const EXPORT_SQL=`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;
function exportRow({who,runId,files}){
  const exportId=randomUUID();
  return {export_id:exportId,owner_id:who.id,bot_id:who.id,run_id:runId,parent_export_id:null,mode:'ONE_PINE',internal:false,fixture:true,gate_version:'best-inputs-gates-v1',
    library_versions:{label:FIXTURE_LABEL},binding:{owner_id:who.id,bot_id:who.id,run_id:runId,mode:'ONE_PINE',fixture:true,created_at:UTC},binding_hash:hex('binding:'+exportId),
    package_hash:sha(files['quant-data/manifest.json']),b0:{gate:'B0',state:'PASS',codes:[]},created_at:T0,created_at_utc:UTC};
}
const exportValues=row=>[row.export_id,row.owner_id,row.bot_id,row.run_id,row.parent_export_id,row.mode,row.internal,row.fixture,row.gate_version,JSON.stringify(row.library_versions),
  JSON.stringify(row.binding),row.binding_hash,row.package_hash,JSON.stringify(row.b0),row.created_at,row.created_at_utc];
const insertBlob=(target,bytes)=>target.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(bytes),bytes.length,bytes]);
const insertFile=(target,exportId,file,bytes)=>target.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[exportId,file,sha(bytes),bytes.length]);
const insertCandidate=target=>exportId=>target.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,$2,$3,NULL,$4,$5)',[exportId,'EXPORT_CANDIDATE',[],T0+1,UTC]);
const traceInsert=(target,exportId,record)=>target.query(`INSERT INTO public.bi_trace_reproductions(export_id,path,sha256,steps_digest,holdout_digest,trace_engine_hash,run_engine_hash,recorded_at_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[exportId,record.path,record.sha256,record.steps_digest,record.holdout_digest,record.trace_engine_hash,record.run_engine_hash,record.recorded_at_ms]);
const toBytes=files=>Object.fromEntries(Object.entries(files).map(([file,content])=>[file,Buffer.isBuffer(content)?content:Buffer.from(content,'utf8')]));
/** Blobs, export, 12 files, the seq 1 EXPORT_CANDIDATE event, then the given trace rows, in ONE SERIALIZABLE transaction (the documented build order, RC-16). */
async function buildPackage({who=OWNER_A,runId,files,records=[],target=rt}){
  const bytes=toBytes(files),row=exportRow({who,runId:runId??await syntheticRun(who),files});
  await target.transaction(async()=>{
    for(const content of Object.values(bytes))await insertBlob(target,content);
    await target.query(EXPORT_SQL,exportValues(row));
    for(const [file,content] of Object.entries(bytes))await insertFile(target,row.export_id,file,content);
    await insertCandidate(target)(row.export_id);
    for(const record of records)await traceInsert(target,row.export_id,record);
  },{isolation:'SERIALIZABLE'});
  return {exportId:row.export_id,row,bytes};
}
/** A package with the 12 files but no trace rows, left open inside the caller's transaction pieces. */
const labelled=tag=>Object.fromEntries(PACKAGE_FILES.map(file=>[file,Buffer.from(FIXTURE_LABEL+'\n'+tag+'\n'+file+'\n')]));
const syntheticRecords=(files,over={})=>TRACE_FILES.map(file=>({path:file,sha256:sha(files[file]),steps_digest:hex('steps'),holdout_digest:hex('holdout'),trace_engine_hash:hex('trace-engine'),run_engine_hash:hex('run-engine'),recorded_at_ms:T0,...over}));
/** The stored rows as db.js returns them (int8 as an integer). */
const readRows=async(exportId,target=owner)=>(await target.query(`SELECT path,sha256,steps_digest,holdout_digest,trace_engine_hash,run_engine_hash,recorded_at_ms FROM public.bi_trace_reproductions WHERE export_id=$1 ORDER BY path`,[exportId])).rows;
const countRows=async exportId=>(await owner.query('SELECT count(*)::int n FROM public.bi_trace_reproductions WHERE export_id=$1',[exportId])).rows[0].n;

/* ================================ C4: the trace record rows ================================ */

test('C4 (no interpreter needed) three rows insert after the seq 1 event in one SERIALIZABLE transaction and read back through db.js in TRACE_FILES order',async()=>{
  const files=labelled('c4-roundtrip'),records=syntheticRecords(files);
  const pack=await buildPackage({files,records});
  assert.equal(await countRows(pack.exportId),3);
  const rows=await readRows(pack.exportId);
  assert.deepEqual(rows.map(row=>row.path).sort(),[...TRACE_FILES].sort());
  for(const row of rows){
    assert.equal(typeof row.recorded_at_ms,'number','db.js parses int8 as an integer');
    assert.equal(row.recorded_at_ms,T0);
    assert.equal(row.sha256,sha(pack.bytes[row.path]));
    for(const key of ['sha256','steps_digest','holdout_digest','trace_engine_hash','run_engine_hash'])assert.match(row[key],HEX64,key);
  }
  // The stored sha256 of each trace row is the sha256 of the stored package file of the same path (the assertion S4 makes in the build transaction).
  const files12=(await owner.query('SELECT path,sha256 FROM public.bi_package_files WHERE export_id=$1',[pack.exportId])).rows;
  for(const row of rows)assert.equal(files12.find(file=>file.path===row.path).sha256,row.sha256);
  // The read side maps the stored rows, in TRACE_FILES order, for a contract that carries the same run engine hash.
  const gated=gateTraceReproduction(rows,{engine_hash:hex('run-engine')});
  assert.deepEqual(gated.map(row=>row.path),[...TRACE_FILES]);
  assert.deepEqual(gated.map(row=>[row.sha256,row.steps_digest,row.holdout_digest]),TRACE_FILES.map(file=>[sha(pack.bytes[file]),hex('steps'),hex('holdout')]));
  // Another run engine hash in the contract: every row is dropped, so the gate sees an absent record.
  assert.deepEqual([...gateTraceReproduction(rows,{engine_hash:hex('another run engine')})],[]);
  // The three rows are also all that is there: the deferred completeness check does not need them, so a fixture export with fewer rows commits (S4 owns writing all three).
  const partial=await buildPackage({files:labelled('c4-partial'),records:syntheticRecords(labelled('c4-partial')).slice(0,2)});
  assert.equal(await countRows(partial.exportId),2);
  assert.equal(gateTraceReproduction(await readRows(partial.exportId),{engine_hash:hex('run-engine')}).length,2);
});

test('C4 (no interpreter needed) a raw pg read returns the int8 as text and gateTraceReproduction drops every row: the read side must go through db.js (note N8)',async()=>{
  const files=labelled('c4-n8'),pack=await buildPackage({files,records:syntheticRecords(files)});
  const client=new pg.Client({connectionString:urlOf(databaseName)});
  await client.connect();
  let raw;
  try{raw=(await client.query('SELECT path,sha256,steps_digest,holdout_digest,trace_engine_hash,run_engine_hash,recorded_at_ms FROM public.bi_trace_reproductions WHERE export_id=$1',[pack.exportId])).rows;}
  finally{await client.end();}
  assert.equal(raw.length,3);
  assert.ok(raw.every(row=>typeof row.recorded_at_ms==='string'),'a raw pg client returns int8 as a string');
  assert.deepEqual([...gateTraceReproduction(raw,{engine_hash:hex('run-engine')})],[],'every row is dropped on the raw read');
  assert.equal(gateTraceReproduction(await readRows(pack.exportId),{engine_hash:hex('run-engine')}).length,3,'the db.js read keeps them');
});

test('C4 (no interpreter needed) a trace row before the seq 1 event is QR004; the same rows after it commit',async()=>{
  const files=labelled('c4-order'),bytes=toBytes(files),runId=await syntheticRun(OWNER_A),row=exportRow({who:OWNER_A,runId,files}),records=syntheticRecords(files);
  const early=await rt.transaction(async()=>{
    for(const content of Object.values(bytes))await insertBlob(rt,content);
    await rt.query(EXPORT_SQL,exportValues(row));
    for(const [file,content] of Object.entries(bytes))await insertFile(rt,row.export_id,file,content);
    await rt.query('SAVEPOINT early');
    let code=null;
    try{await traceInsert(rt,row.export_id,records[0]);}catch(error){code=error.code;await rt.query('ROLLBACK TO SAVEPOINT early');}
    assert.equal((await rt.query('SELECT count(*)::int n FROM public.bi_trace_reproductions WHERE export_id=$1',[row.export_id])).rows[0].n,0);
    await insertCandidate(rt)(row.export_id);
    for(const record of records)await traceInsert(rt,row.export_id,record);
    return code;
  },{isolation:'SERIALIZABLE'});
  assert.equal(early,QR004,'a trace row before any status event is refused by the guard');
  assert.equal(await countRows(row.export_id),3);
  // The refusal text is the guard of the candidate-record tables.
  const second=exportRow({who:OWNER_A,runId:await syntheticRun(OWNER_A),files});
  await refusedWith(rt.transaction(async()=>{
    for(const content of Object.values(bytes))await insertBlob(rt,content);
    await rt.query(EXPORT_SQL,exportValues(second));
    await traceInsert(rt,second.export_id,records[0]);
  },{isolation:'SERIALIZABLE'}),QR004,/EXPORT_CANDIDATE/);
});

test('C4 (no interpreter needed) outside SERIALIZABLE a trace row is QR003; a fourth path is 23514; a duplicate path is 23505; a refused row leaves nothing behind',async()=>{
  const files=labelled('c4-refusals'),pack=await buildPackage({files}),records=syntheticRecords(files);
  for(const isolation of ['READ COMMITTED','REPEATABLE READ'])
    await refusedWith(rt.transaction(()=>traceInsert(rt,pack.exportId,records[0]),{isolation}),QR003,/require a SERIALIZABLE transaction/);
  await refused(plain.query(`INSERT INTO public.bi_trace_reproductions(export_id,path,sha256,steps_digest,holdout_digest,trace_engine_hash,run_engine_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [pack.exportId,records[0].path,records[0].sha256,hex('s'),hex('h'),hex('t'),hex('r'),T0]),QR003);
  assert.equal(await countRows(pack.exportId),0);
  await refused(rt.transaction(()=>traceInsert(rt,pack.exportId,{...records[0],path:'quant-data/metrics.json'}),{isolation:'SERIALIZABLE'}),CHECK_VIOLATION);
  await refused(rt.transaction(()=>traceInsert(rt,pack.exportId,{...records[0],path:'quant-data/other.csv'}),{isolation:'SERIALIZABLE'}),CHECK_VIOLATION);
  await refused(rt.transaction(()=>traceInsert(rt,pack.exportId,{...records[0],sha256:'ABC'}),{isolation:'SERIALIZABLE'}),CHECK_VIOLATION);
  await refused(rt.transaction(()=>traceInsert(rt,pack.exportId,{...records[0],recorded_at_ms:-1}),{isolation:'SERIALIZABLE'}),CHECK_VIOLATION);
  assert.equal(await countRows(pack.exportId),0);
  await rt.transaction(async()=>{for(const record of records)await traceInsert(rt,pack.exportId,record);},{isolation:'SERIALIZABLE'});
  assert.equal(await countRows(pack.exportId),3);
  await refused(rt.transaction(()=>traceInsert(rt,pack.exportId,{...records[1],sha256:hex('another file')}),{isolation:'SERIALIZABLE'}),UNIQUE_VIOLATION);
  await refused(rt.transaction(async()=>{await traceInsert(rt,pack.exportId,records[0]);},{isolation:'SERIALIZABLE'}),UNIQUE_VIOLATION);
  assert.deepEqual((await readRows(pack.exportId)).map(row=>row.sha256).sort(),records.map(record=>record.sha256).sort(),'the original rows are unchanged');
  // A trace row for an export that does not exist is refused by the guard (before the foreign key).
  await refused(rt.transaction(()=>traceInsert(rt,randomUUID(),records[0]),{isolation:'SERIALIZABLE'}),QR004);
});

test('C4 (no interpreter needed) the rows are insert-only: UPDATE, DELETE and TRUNCATE are QR002, also for the owner role; the runtime role is not even granted them',async()=>{
  const files=labelled('c4-frozen'),pack=await buildPackage({files,records:syntheticRecords(files)});
  const before=await readRows(pack.exportId);
  const attempt=sql=>owner.transaction(()=>owner.query(sql,[pack.exportId]),{isolation:'SERIALIZABLE'});
  await refused(attempt("UPDATE public.bi_trace_reproductions SET steps_digest='"+hex('x')+"' WHERE export_id=$1"),QR002);
  await refused(attempt('UPDATE public.bi_trace_reproductions SET recorded_at_ms=recorded_at_ms+1 WHERE export_id=$1'),QR002);
  await refused(attempt('DELETE FROM public.bi_trace_reproductions WHERE export_id=$1'),QR002);
  await refused(owner.transaction(()=>owner.query('TRUNCATE public.bi_trace_reproductions'),{isolation:'SERIALIZABLE'}),QR002);
  await refused(owner.transaction(async()=>{await owner.query("SET LOCAL session_replication_role = 'replica'");await owner.query('DELETE FROM public.bi_trace_reproductions WHERE export_id=$1',[pack.exportId]);},{isolation:'SERIALIZABLE'}),QR002);
  for(const sql of ["UPDATE public.bi_trace_reproductions SET steps_digest='"+hex('x')+"' WHERE export_id=$1",'DELETE FROM public.bi_trace_reproductions WHERE export_id=$1'])
    await refused(rt.transaction(()=>rt.query(sql,[pack.exportId]),{isolation:'SERIALIZABLE'}),DENIED);
  await refused(rt.transaction(()=>rt.query('TRUNCATE public.bi_trace_reproductions'),{isolation:'SERIALIZABLE'}),DENIED);
  assert.deepEqual(await readRows(pack.exportId),before,'every refused statement left the rows untouched');
});

/* ================================ C3: the JSONB round-trip premise, and the read-back C3 gate ================================ */

/* The fixture mirrors quant_lab/tests/test_trace_reproduction.py and test/trace-reproduction-closure.test.js (same bootstrap, same grid and plan). */
const BOOTSTRAP=entry=>['import sys','from robot_quant import research_engine, trace_reproduction',
  'from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, CustomSignalInputs',
  'BASE = CustomSignalInputs(ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2, zone_atr_mult=2.5, setup_expiry=8, cooldown=2, confirm_lookback=3)',
  'PLAN = CustomOptimizationPlan(BASE, {"emaFastInput": (4, 6, 1)})','CustomOptimizationPlan.from_snapshot = lambda *_: PLAN',entry,''].join('\n');
const STATEMENT='emaFastInput = input.int(5, "EMA fast", minval=4, maxval=6, step=1)';
const SOURCE=['//@version=6','indicator("Trace S3c fixture indicator", overlay=true)',STATEMENT,'useSlowFilter = input.bool(true, "Slow filter")','notifyEnabled = input.bool(false, "Notify")',
  'emaFast = ta.ema(close, emaFastInput)','emaSlow = ta.ema(close, 17)','buySignal = ta.crossover(emaFast, emaSlow)','sellSignal = ta.crossunder(emaFast, emaSlow)','plot(emaFast)',''].join('\n');
const SPAN_START=SOURCE.indexOf(STATEMENT);
const BARS=1500,SPLIT={warmup:10,train_end:600,validation_end:1050,test_end:BARS};
const GRID={emaFastInput:[4,5,6],atr_multiplier:[0.95,1,1.05],rr:[1.9,2,2.1]};
const PLAN=[{emaFastInput:5,atr_multiplier:1,rr:1.9},{emaFastInput:5,atr_multiplier:1,rr:2},{emaFastInput:5,atr_multiplier:0.95,rr:2},{emaFastInput:6,atr_multiplier:1,rr:1.9}];
function engineBars(){
  const bars=[];let previous=100;
  for(let i=0;i<BARS;i++){
    const close=100+12*Math.sin(i/23)+2*Math.sin(i/3);
    bars.push({time:T0+i*MINUTE,open:String(previous),high:String(Math.max(previous,close)+1.2),low:String(Math.min(previous,close)-1.2),close:String(close),volume:'1',atr14:'2.75'});
    previous=close;
  }
  return bars;
}
async function fixtureContract(who){
  const contract=clone(contractOf({owner:who.id,bot:who.id,deployment:who.deployment,importId:who.importId,tag:'s3c-pg',total:BARS,warmup:SPLIT.warmup,barCount:0,candidates:PLAN.length,domains:GRID}));
  Object.assign(contract,{version:'ql3a-research-job-v1',source:SOURCE,source_hash:hash(SOURCE),policy_version:'policy-v1',acceptance_blockers:[...CANDIDATE_BLOCKERS],split:{...SPLIT}});
  contract.snapshot.policy={max_daily_loss_percent:'3',equities:{'binance-global':'1000'},killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:10000,maxDailyLossR:10000,
    pauseAfterLossStreak:10000,blockHighVolatility:false,maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',maxOpenPositions:5,
    onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,maxDailyNotional:10000000};
  contract.snapshot.membership=[{pine_import_id:who.importId,source_version:1,source_hash:contract.source_hash}];
  contract.dataset.bars=engineBars();
  contract.model={...contract.model,quantity_step:0.00001};
  Object.assign(contract.input_lock.selection.bindings[0],{effective_value:5,search_domain:{min:4,max:6,step:1},source_span:{start:SPAN_START,end:SPAN_START+STATEMENT.length}});
  contract.input_lock.selection.fixed_inputs.push({input_id:'input_11',pine_variable:'emaSlowInput',effective_value:17,type:'int',eligible:false});
  contract.input_lock.baseline=clone(PLAN[0]);
  contract.plan.candidates=clone(PLAN);contract.plan.planned_candidates=PLAN.length;
  contract.max_evaluations=40;
  contract.engine_hash=await engineHash(false);
  return contract;
}
function runPython(script,body,{timeoutMs=60000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(PYTHON,['-P',script],{cwd:repoRoot,env:{...process.env,PYTHONPATH:path.join(repoRoot,'quant_lab/src'),PYTHONHASHSEED:'0'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    const out=[],timer=setTimeout(()=>child.kill(),timeoutMs);
    child.stdout.on('data',data=>out.push(data));child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0){reject(Object.assign(new Error('python exited '+code),{code:'EVALUATION_FAILED'}));return;}
      try{resolve(JSON.parse(Buffer.concat(out).toString('utf8')));}catch{reject(Object.assign(new Error('bad engine reply'),{code:'INVALID_EVALUATION_RESPONSE'}));}
    });
    child.stdin.end(JSON.stringify(body));
  });
}
const storedDigests=selected=>({
  steps:hash(canonical({candidate:{parameters:selected.parameters,result:selected.result},sensitivity:selected.sensitivity,cost_stress:selected.cost_stress})),
  holdout:hash(canonical({test:selected.test}))});
function c3Subject(storedRun,trace,recordRows){
  const run={...clone(storedRun),submission_hash:hex('submission-s3c-pg')};
  const rendered=renderPackage({export_id:'9f1c2b7e-3d4a-4b5c-8d6e-0123456789ab',created_at:'2026-10-19T12:00:00Z',run,fixture:true,library_versions:clone(LIBRARY_VERSIONS),
    risk_limits:{max_daily_loss_percent:'3'},trace,exit_version:'bridge-exit-v2'});
  const contract=run.contract;
  const metadata={version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:contract.dataset.start_time,
    end_time:contract.dataset.end_time+MINUTE,warmup_bars:contract.dataset.warmup_bars,total_bars:contract.dataset.bar_count,cutoff:contract.dataset.end_time+MINUTE,source:'binance-spot-klines-v1'};
  return {rendered,subject:{run,export:{library_versions:clone(LIBRARY_VERSIONS)},files:{...rendered.files},hard_limits:{max_daily_loss_percent:{max:'5'}},deployment:{exit_version:'bridge-exit-v2'},
    dataset:{readable:true,digest:contract.dataset.sha256,metadata},fixture_request:true,trace_reproduction:recordRows(rendered.files)}};
}
const c3Codes=subject=>[...evaluateProvenance(subject).codes];

/** The shared C3 fixture: the run stored by the real worker into PostgreSQL JSONB, read back, reproduced by the real driver. */
let premise=null;
const roundTrip=()=>premise??=(async()=>{
  const who=await newOwner('s3c-c3');
  const engineScript=path.join(scratchDir,'engine.py'),driverScript=path.join(scratchDir,'driver.py');
  await fs.writeFile(engineScript,BOOTSTRAP('research_engine.main()'));
  await fs.writeFile(driverScript,BOOTSTRAP('trace_reproduction.main()'));
  const contract=await fixtureContract(who),contractHash=hash(canonical(contract)),runId='run-s3c-'+randomUUID();
  const now=Date.now(),leaseToken='lease-'+randomUUID();
  await owner.query(`INSERT INTO quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,phase,created_at,updated_at,deadline,attempt,lease_token,lease_until)
    VALUES($1,$2,$2,$3,$4,$5,$6,$7,'RUNNING','CANDIDATES',$8,$8,$9,1,$10,$9)`,[runId,who.id,who.deployment,'idem-'+runId,hex('submission'),contractHash,JSON.stringify(contract),now,now+3600000,leaseToken]);
  const evaluate=(c,parameters,kind)=>runPython(engineScript,{contract:kind==='HOLDOUT'?c:{...c,dataset:{...c.dataset,bars:c.dataset.bars.slice(0,c.split.validation_end)}},parameters,kind});
  // The real worker code stores the run: step (shape check, checkpoint insert), run (selection, neighbours, stress, holdout) and finish (JSONB result).
  // Only the lease-independent pieces are replaced: the baseline freshness check (Pine service) and the audit write.
  const worker=Object.create(QuantResearchWorker.prototype);
  worker.service={foundation:false,store:{audit:async()=>{}}};
  worker.db=owner;worker.clock=Date.now;worker.controller={signal:new AbortController().signal};
  worker.current=async()=>{};
  worker.evaluate=evaluate;
  let inMemoryResult=null;
  const realFinish=worker.finish.bind(worker);
  worker.finish=async(job,status,result,diagnostic)=>{inMemoryResult=clone(result);return realFinish(job,status,result,diagnostic);};
  const job={...(await owner.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0]};
  await worker.run(job);
  const row=(await owner.query('SELECT * FROM quant_jobs WHERE run_id=$1',[runId])).rows[0];
  const steps=(await owner.query('SELECT step_id,kind,parameters,result FROM quant_job_steps WHERE run_id=$1 ORDER BY step_id',[runId])).rows;
  const run={owner_id:row.owner_id,bot_id:row.bot_id,run_id:row.run_id,status:row.status,contract:row.contract,contract_hash:row.contract_hash,result:row.result};
  const ports={evaluate,traceEvaluate:(c,parameters,signal)=>driverEvaluation(c,parameters,signal,{python:PYTHON,args:['-P',driverScript],timeoutMs:60000}),engineHash:()=>engineHash(false)};
  const value=await reproduceRun({run,ports});
  return {who,run,row,steps,inMemoryResult,value,contract};
})();

test('C3 ('+LABEL+') the run stored by the real worker into JSONB reads back whole: contract hash, status, completion and every step',{skip:NO_PYTHON,timeout:240000},async()=>{
  const {run,row,steps,contract}=await roundTrip();
  assert.equal(run.status,'SUCCEEDED',JSON.stringify(run.result?.selected?.screen_reasons));
  assert.equal(run.result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  assert.equal(run.result.holdout_evaluated,true);
  assert.equal(hash(canonical(run.contract)),run.contract_hash,'the contract hash survives the JSONB round trip');
  assert.equal(run.contract_hash,hash(canonical(contract)));
  assert.equal(row.lease_token,null);
  assert.equal(steps.length,10,'4 plan candidates, 4 sensitivity neighbours, the cost stress and the holdout; the two planned neighbours reuse their candidate steps: '+steps.map(step=>step.step_id).join());
  assert.deepEqual(steps.map(step=>step.kind).filter((kind,index,all)=>all.indexOf(kind)===index).sort(),['CANDIDATE','HOLDOUT','SENSITIVITY','STRESS']);
});

test('C3 ('+LABEL+') the digests of the read-back selected equal the digests before storage and the digests the real driver recomputes (the J5 round-trip premise)',{skip:NO_PYTHON,timeout:240000},async()=>{
  const {run,inMemoryResult,value,steps}=await roundTrip();
  const stored=storedDigests(run.result.selected),before=storedDigests(inMemoryResult.selected);
  assert.deepEqual(stored,before,'JSONB changes no byte the canonical form sees');
  assert.equal(value.steps_digest,stored.steps,'recomputed steps digest equals the digest of the stored (read-back) steps');
  assert.equal(value.holdout_digest,stored.holdout,'recomputed holdout digest equals the digest of the stored (read-back) test');
  assert.equal(value.run_engine_hash,run.contract.engine_hash);
  assert.equal(value.trace_engine_hash,await traceReproductionEngineHash());
  // The stored checkpoint rows carry the same results the report holds, for the candidate, the stress and the holdout step.
  const byId=Object.fromEntries(steps.map(step=>[step.step_id,step.result]));
  assert.deepEqual(byId['stress:selected'],run.result.selected.cost_stress);
  assert.deepEqual(byId['holdout:selected'].test,run.result.selected.test);
  // The number forms that can differ between Python JSON and JSONB: integer-valued floats and exponent decimals. They come back unchanged for the canonical form.
  const text=JSON.stringify(run.result);
  assert.ok(/"atr_multiplier":1[,}]/.test(text)||/"atr_multiplier":1\.0/.test(text),'an integer-valued grid float is present in the stored result');
});

test('C4 + C3 ('+LABEL+') the three records of the reproduction commit after the seq 1 event, read back through db.js, and the real C3 gate passes; tampering is reported',{skip:NO_PYTHON,timeout:240000},async()=>{
  const {who,run,value}=await roundTrip();
  const {rendered}=c3Subject(run,value.trace,()=>[]);
  assert.deepEqual(Object.keys(rendered.files).sort(),[...PACKAGE_FILES].sort(),'the render holds the 12 package files');
  const records=traceReproductionRecords(value,rendered.files,T0+5);
  const pack=await buildPackage({who,runId:run.run_id,files:rendered.files,records});
  const rows=await readRows(pack.exportId);
  assert.equal(rows.length,3);
  assert.ok(rows.every(row=>row.run_engine_hash===run.contract.engine_hash&&row.trace_engine_hash===value.trace_engine_hash&&row.recorded_at_ms===T0+5));
  const gated=gateTraceReproduction(rows,run.contract);
  assert.deepEqual(gated.map(row=>row.path),[...TRACE_FILES]);
  const passing=c3Subject(run,value.trace,()=>gated);
  assert.deepEqual(passing.rendered.files,rendered.files,'the same run and trace render the same bytes');
  assert.deepEqual(c3Codes(passing.subject),[],'untouched stored run with the records read back from PostgreSQL: C3 passes');
  const readBack=readRun=>c3Subject(readRun,value.trace,()=>gated).subject;
  const tampered=edit=>{const copy=clone(run);edit(copy.result.selected);return c3Codes(readBack(copy));};
  const bump=metrics=>{metrics.net_return_percent=String(Number(metrics.net_return_percent)+0.01);};
  assert.deepEqual(tampered(selected=>bump(selected.sensitivity[3].result.validation)),['BI_RESULT_MISMATCH']);
  assert.deepEqual(tampered(selected=>bump(selected.cost_stress.validation)),['BI_RESULT_MISMATCH']);
  assert.deepEqual(tampered(selected=>bump(selected.test)),['HOLDOUT_MISMATCH']);
  // An absent record: a read side that returned only two rows, or rows of another run engine, leaves C3 with an absent record.
  assert.deepEqual(c3Codes(c3Subject(run,value.trace,()=>gated.slice(0,2)).subject).sort(),['BI_RESULT_MISMATCH','HOLDOUT_MISMATCH']);
  assert.deepEqual(c3Codes(c3Subject(run,value.trace,()=>gateTraceReproduction(rows,{...run.contract,engine_hash:hex('another run engine')})).subject).sort(),['BI_RESULT_MISMATCH','HOLDOUT_MISMATCH']);
  // The trace rows, the render and the stored files agree byte for byte.
  const stored=(await owner.query('SELECT f.path,f.sha256,b.content FROM public.bi_package_files f JOIN public.bi_blobs b ON b.sha256=f.sha256 WHERE f.export_id=$1',[pack.exportId])).rows;
  for(const row of rows){
    const file=stored.find(item=>item.path===row.path);
    assert.equal(file.sha256,row.sha256);
    assert.equal(sha(file.content),row.sha256,'the stored blob hashes to the record');
  }
});
