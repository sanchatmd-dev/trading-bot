import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from '../helpers/quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {PineBridgeWorker} from '../../src/postgres/pine-bridge-worker.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {activateDeployment} from '../../src/postgres/pine-bridge-readiness.js';
import {setMembership} from '../../src/postgres/pine-bridge-registry.js';
import {createCapture} from '../../src/postgres/pine-capture.js';
import {resolveBridgePreviewContext} from '../../src/postgres/risk-readiness-bridge.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';
import {bigSource,smallSource,BIG_INPUT_COUNT,BIG_SIGNALS,SMALL_SIGNALS,PROVIDER_CONFIG,CATALOG_SLOTS,BRIDGE_DOMAINS,
  countingProvider,catalogSlots,evidenceFor,syntheticBar} from '../helpers/pine-bridge-selection-gates-fixture.mjs';

/**
 * PM-1 row F02-02 gate tests for the Bridge selection (docs/PINE_BRIDGE_ADAPTER_API.md, docs/STEP2_S4_CONTINUATION_2026-10-05.md):
 *   C5  generate refusals at service level (STALE_SOURCE, ANALYSIS_REQUIRED, INVALID_MARKET, slot and field refusals) happen before
 *       any job insert, any write and any provider call;
 *   C8  a stored deployment snapshot is immutable (no writer path touches it) and a tampered snapshot fails the hash recheck;
 *   G1  seam: the deployment a real worker generated from eight CATALOG slots is the selection research enqueue accepts, and drift is refused.
 * Not asserted on purpose: whether a binding must lie inside the AI analysis proposal (open owner decision, doc line 52 against code).
 * Expected codes, statuses and values are written as literals so a changed constant fails here and does not follow silently.
 * Synthetic fixtures only; nothing here says anything about the owner-private supported source or strategy performance.
 */
let admin,db,store,pine,quant,databaseName,now=Date.now();
const BAR_START=1800000000000,BAR_COUNT=3250;
before(async()=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
 admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
 databaseName='pine_bridge_gates_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+databaseName);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
 db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
 for(const file of ['pine-bridge-schema.sql','pine-capture-schema.sql','quant-research-schema.sql'])await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
 store=new Store(db);
 pine=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider:()=>PROVIDER_CONFIG});
 await installQuantGuards(db);
 quant=new QuantResearchService({pineService:pine,clock:()=>now,supportedSourceHash:hash(bigSource),foundation:false});
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE '+databaseName);await admin.close();}});

// ---- helpers ------------------------------------------------------------------------------------------------------------------
const enqueue=(owner,operation,body,key=randomUUID())=>db.transaction(()=>pine.enqueue(owner,operation,body,key));
const smallProvider=()=>countingProvider({buy:'buy',exit:'sell'});
const bigProvider=()=>countingProvider({buy:'buySignal',exit:'sellSignal'});
async function runAll(provider){const worker=new PineBridgeWorker({service:pine,provider});for(let i=0;i<30&&await worker.tick();i++);}
const cancel=(owner,jobId)=>db.transaction(()=>pine.get(owner,jobId,true));
const count=async(table,where='TRUE')=>Number((await db.query('SELECT count(*) n FROM '+table+' WHERE '+where)).rows[0].n);
async function newOwner(){
 const id=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'})).id;
 await store.setRisk(id,{...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2,equities:{'binance-global':1000},balances:{'binance-global':1000}});
 return id;
}
/** Run a callback while recording every SQL statement the database receives. Returns the statements. */
async function recordSql(callback){
 const sql=[],query=db.query.bind(db);
 db.query=(statement,...args)=>{sql.push(String(statement));return query(statement,...args);};
 try{await callback();}finally{delete db.query;}
 return sql;
}
const WRITES=/INSERT INTO (pine_bridge_jobs|pine_bridge_attempts|pine_sources|pine_source_revisions|pine_memberships|pine_deployments|audit)\b|UPDATE (pine_memberships|pine_deployments)\b/i;

/** Analyse a source through the real enqueue and worker path. Returns the registered import and its stored analysis. */
async function analysed(owner,{source=smallSource,provider=smallProvider(),review=false}={}){
 let body={bot_id:owner,pine_source:source,source_name:'PM1 gates'};
 if(review){
  const inspected=await pine.inspect(owner,{bot_id:owner,pine_source:source});
  body={...body,effective_inputs:Object.fromEntries(inspected.inputs.map(i=>[i.input_id,i.default_hint])),input_review:{source_hash:inspected.source_hash,confirmed:true}};
 }
 const job=await enqueue(owner,'analyze',body);
 await runAll(provider);
 assert.equal((await db.transaction(()=>pine.get(owner,job.job_id))).job_status,'SUCCEEDED');
 return {importId:job.pine_import_id,analysis:(await pine.source(owner,owner,job.pine_import_id,1)).analysis};
}
/** Eight slots over the first eight eligible small-source inputs, domains around each effective value. */
const smallSlots=analysis=>analysis.inputs.filter(i=>i.eligible).slice(0,8).map((input,i)=>({slot:3+i,input_id:input.input_id,...(input.type==='int'?{min:input.effective_value-2,max:input.effective_value+2,step:1}:{min:input.effective_value-1,max:input.effective_value+1,step:.5})}));
const market=(over={})=>({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',...over});
const generateBody=(owner,importId,slots,signals,over={})=>({bot_id:owner,pine_import_id:importId,source_version:1,selected_signals:signals,parameter_slots:slots,bridge_options:{atr_multiplier:60,rr:1.5},market:market(),...over});
/** Generate through the real worker and return the stored DRAFT deployment row. */
async function generated(owner,body,provider){
 const job=await enqueue(owner,'generate',body);
 await runAll(provider);
 const done=await db.transaction(()=>pine.get(owner,job.job_id));
 assert.equal(done.job_status,'SUCCEEDED',JSON.stringify(done.diagnostic));
 return db.prepare('SELECT * FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id);
}
async function activate(owner,deployment){
 const evidence=evidenceFor(deployment);
 await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deployment.deployment_id,deployment.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),Date.now());
 return db.transaction(()=>activateDeployment(pine,owner,deployment.deployment_id));
}

// ---- C5: service-level generate refusals before any write or provider call --------------------------------------------------------
let base;
async function gate(){
 if(base)return base;
 const owner=await newOwner(),{importId,analysis}=await analysed(owner);
 return base={owner,importId,analysis,slots:smallSlots(analysis),body:over=>generateBody(owner,importId,base.slots,SMALL_SIGNALS,over)};
}

/**
 * One refusal: the exact code and status, no write statement of any kind reached the database (a rolled-back insert would hide
 * an insert made before the refusal), no job, attempt or deployment row exists, and a worker run dispatches nothing to the provider.
 */
async function refused(label,owner,operation,body,expected,{key,cleanup}={}){
 const before={jobs:await count('pine_bridge_jobs'),attempts:await count('pine_bridge_attempts'),deployments:await count('pine_deployments'),generate:await count('pine_bridge_jobs',"operation='generate'")};
 const sql=await recordSql(()=>assert.rejects(enqueue(owner,operation,body,key),expected,label));
 assert.deepEqual(sql.filter(statement=>WRITES.test(statement)),[],label+': no write statement before the refusal');
 await cleanup?.();
 const spy=smallProvider();await runAll(spy);
 assert.deepEqual(spy.calls,[],label+': zero provider calls');
 assert.deepEqual({jobs:await count('pine_bridge_jobs'),attempts:await count('pine_bridge_attempts'),deployments:await count('pine_deployments'),generate:await count('pine_bridge_jobs',"operation='generate'")},before,label+': no job, attempt or deployment row');
 assert.equal(await count('pine_bridge_jobs',"status IN ('QUEUED','RETRY_WAIT','RUNNING','VALIDATING')"),0,label+': nothing left runnable');
}

test('C5: STALE_SOURCE (409) when the membership is disconnected or points at a newer source version; reconnecting accepts',async()=>{
 const owner=await newOwner(),{importId,analysis}=await analysed(owner),slots=smallSlots(analysis);
 const body=generateBody(owner,importId,slots,SMALL_SIGNALS);
 await db.transaction(()=>setMembership(pine,owner,importId,{bot_id:owner,connected:false}));
 await refused('disconnected',owner,'generate',body,{code:'STALE_SOURCE',status:409});
 await db.transaction(()=>setMembership(pine,owner,importId,{bot_id:owner,connected:true}));
 const reconnected=await enqueue(owner,'generate',body);
 assert.equal(reconnected.job_status,'QUEUED','the same body is accepted once the membership is connected again');
 await cancel(owner,reconnected.job_id);
 // A newer source version registers as the membership version at analyze enqueue, so version 1 is stale at once.
 const v2=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// revision 2',source_name:'PM1 gates',pine_import_id:importId,source_version:2});
 assert.equal(v2.source_version,2);
 await refused('newer version',owner,'generate',body,{code:'STALE_SOURCE',status:409},{cleanup:()=>cancel(owner,v2.job_id)});
});

test('C5: ANALYSIS_REQUIRED (409) when no analysis of this source version SUCCEEDED (queued, failed)',async()=>{
 const queued=await newOwner();
 const pending=await enqueue(queued,'analyze',{bot_id:queued,pine_source:smallSource,source_name:'PM1 gates'});
 const pendingAnalysis=(await pine.source(queued,queued,pending.pine_import_id,1)).analysis;
 await refused('analysis still queued',queued,'generate',generateBody(queued,pending.pine_import_id,smallSlots(pendingAnalysis),SMALL_SIGNALS),{code:'ANALYSIS_REQUIRED',status:409},{cleanup:()=>cancel(queued,pending.job_id)});
 const failing=await newOwner();
 const failed=await enqueue(failing,'analyze',{bot_id:failing,pine_source:smallSource,source_name:'PM1 gates'});
 await runAll(countingProvider({buy:'buy',exit:'sell',invalid:true}));
 assert.equal((await db.transaction(()=>pine.get(failing,failed.job_id))).job_status,'FAILED');
 const failedAnalysis=(await pine.source(failing,failing,failed.pine_import_id,1)).analysis;
 await refused('analysis failed',failing,'generate',generateBody(failing,failed.pine_import_id,smallSlots(failedAnalysis),SMALL_SIGNALS),{code:'ANALYSIS_REQUIRED',status:409});
});

test('C5: INVALID_MARKET (400) for a broker, symbol or timeframe outside the contract',async()=>{
 const g=await gate();
 for(const [label,over] of [
  ['unknown broker',{broker:'kraken'}],['lower-case symbol',{symbol:'btcusdt'}],['symbol too short',{symbol:'BT'}],
  ['symbol too long',{symbol:'A'.repeat(31)}],['timeframe 1h',{timeframe:'1h'}],['timeframe text',{timeframe:'abc'}],['timeframe five digits',{timeframe:'12345'}]
 ])await refused('INVALID_MARKET '+label,g.owner,'generate',g.body({market:market(over)}),{code:'INVALID_MARKET',status:400});
});

test('C5: slot, signal and Bridge option refusals come from the service before any write (INVALID_SLOT_COUNT, DUPLICATE_BINDING, ...)',async()=>{
 const g=await gate(),eligible=g.analysis.inputs.filter(i=>i.eligible);
 assert.ok(eligible.length>=9);
 const ninth={slot:10,input_id:eligible[8].input_id,min:eligible[8].effective_value-1,max:eligible[8].effective_value+1,step:1};
 const cases=[
  ['nine slots','INVALID_SLOT_COUNT',{parameter_slots:[...g.slots,ninth]}],
  ['two bindings on one slot number','DUPLICATE_BINDING',{parameter_slots:[...g.slots.slice(0,7),{...g.slots[7],slot:g.slots[0].slot}]}],
  ['one input bound twice','DUPLICATE_BINDING',{parameter_slots:[...g.slots.slice(0,7),{...g.slots[0],slot:10}]}],
  ['unknown input id','INELIGIBLE_INPUT',{parameter_slots:[{...g.slots[0],input_id:'0'.repeat(24)}]}],
  ['slot number 2 belongs to the Bridge','INVALID_NUMERIC_VALUE',{parameter_slots:[{...g.slots[0],slot:2}]}],
  ['slot number 11','INVALID_NUMERIC_VALUE',{parameter_slots:[{...g.slots[0],slot:11}]}],
  ['domain above the effective value','INVALID_SEARCH_DOMAIN',{parameter_slots:[{...g.slots[0],min:g.slots[0].max+1,max:g.slots[0].max+2}]}],
  ['zero step','INVALID_SEARCH_DOMAIN',{parameter_slots:[{...g.slots[0],step:0}]}],
  ['unmapped buy signal','UNRESOLVED_SIGNAL_MAPPING',{selected_signals:{...SMALL_SIGNALS,buy:'doesNotExist'}}],
  ['timing other than bar_close','UNRESOLVED_SIGNAL_MAPPING',{selected_signals:{...SMALL_SIGNALS,timing:'intrabar'}}],
  ['ATR multiplier zero','INVALID_NUMERIC_VALUE',{bridge_options:{atr_multiplier:0,rr:1.5}}],
  ['RR above 1000','INVALID_NUMERIC_VALUE',{bridge_options:{atr_multiplier:2,rr:1001}}],
  ['unknown body field','INVALID_FIELDS',{extra:true}],
  ['market without symbol','INVALID_FIELDS',{market:{broker:'binance-global',timeframe:'1'}}],
  ['market with extra field','INVALID_FIELDS',{market:{...market(),leverage:3}}],
  ['source version zero','INVALID_NUMERIC_VALUE',{source_version:0}]
 ];
 for(const [label,code,over] of cases)await refused(label,g.owner,'generate',g.body(over),{code,status:400});
});

test('C5: unknown source, version, foreign owner and a missing idempotency key are refused before any write',async()=>{
 const g=await gate(),stranger=await newOwner();
 await refused('unknown import id',g.owner,'generate',g.body({pine_import_id:randomUUID()}),{code:'NOT_FOUND',status:404});
 await refused('malformed import id',g.owner,'generate',g.body({pine_import_id:'not-a-uuid'}),{code:'NOT_FOUND',status:404});
 await refused('source version without a revision',g.owner,'generate',g.body({source_version:7}),{code:'NOT_FOUND',status:404});
 await refused('foreign owner',stranger,'generate',g.body(),{code:'NOT_FOUND',status:404});
 await refused('short idempotency key',g.owner,'generate',g.body(),{code:'IDEMPOTENCY_KEY_REQUIRED',status:400},{key:'short'});
});

test('C5 control: the same valid body is queued, writes a job and reaches the provider exactly once (the spies are not vacuous)',async()=>{
 const g=await gate(),spy=smallProvider();
 let queued;
 const sql=await recordSql(async()=>{queued=await enqueue(g.owner,'generate',g.body());});
 assert.equal(queued.job_status,'QUEUED');
 assert.ok(sql.some(statement=>/INSERT INTO pine_bridge_jobs/i.test(statement)),'the recording sees the job insert');
 await runAll(spy);
 assert.deepEqual(spy.calls,['generate']);
 const done=await db.transaction(()=>pine.get(g.owner,queued.job_id));
 assert.equal(done.job_status,'SUCCEEDED');
 assert.equal((await db.prepare('SELECT state FROM pine_deployments WHERE deployment_id=?').get(done.result.deployment_id)).state,'DRAFT');
});

// ---- C8: snapshot immutability -------------------------------------------------------------------------------------------------
const raw=async id=>(await db.query('SELECT snapshot::text AS text,snapshot_hash,created_at FROM pine_deployments WHERE deployment_id=$1',[id])).rows[0];
async function assertIntact(label,id,expected,state){
 const now=await raw(id);
 assert.equal(now.text,expected.text,label+': snapshot bytes unchanged');
 assert.equal(now.snapshot_hash,expected.snapshot_hash,label+': snapshot_hash unchanged');
 assert.equal(String(now.created_at),String(expected.created_at),label+': created_at unchanged');
 assert.equal(hash(canonical(JSON.parse(now.text))),now.snapshot_hash,label+': hash still matches the stored snapshot');
 if(state)assert.equal((await db.prepare('SELECT state FROM pine_deployments WHERE deployment_id=?').get(id)).state,state,label+': state');
}

test('C8: capture, activation, replacement, membership changes, a new source version and a refused activation never change a stored snapshot',async()=>{
 const owner=await newOwner(),{importId,analysis}=await analysed(owner),slots=smallSlots(analysis),provider=smallProvider();
 const body=generateBody(owner,importId,slots,SMALL_SIGNALS);
 const first=await generated(owner,body,provider),second=await generated(owner,body,provider);
 assert.notEqual(first.deployment_id,second.deployment_id);
 assert.equal(first.snapshot.selection.bindings.length,8);
 const was1=await raw(first.deployment_id),was2=await raw(second.deployment_id);
 await assertIntact('DRAFT first',first.deployment_id,was1,'DRAFT');
 await db.transaction(()=>createCapture(pine,owner,first.deployment_id,{}));
 await assertIntact('after capture session',first.deployment_id,was1,'DRAFT');
 await activate(owner,first);
 await assertIntact('first READY',first.deployment_id,was1,'READY');
 await activate(owner,second);
 await assertIntact('first replaced',first.deployment_id,was1,'EXIT_ONLY');
 await assertIntact('second READY',second.deployment_id,was2,'READY');
 await db.transaction(()=>setMembership(pine,owner,importId,{bot_id:owner,connected:false}));
 await assertIntact('membership off, first',first.deployment_id,was1,'EXIT_ONLY');
 await assertIntact('membership off, second',second.deployment_id,was2,'EXIT_ONLY');
 await db.transaction(()=>setMembership(pine,owner,importId,{bot_id:owner,connected:true}));
 await assertIntact('membership on, second',second.deployment_id,was2,'EXIT_ONLY');
 await assert.rejects(db.transaction(()=>activateDeployment(pine,owner,first.deployment_id)),{code:'DEPLOYMENT_REPLACED',status:409});
 await assertIntact('refused activation',first.deployment_id,was1,'EXIT_ONLY');
 const v2=await enqueue(owner,'analyze',{bot_id:owner,pine_source:smallSource+'\n// revision 2',source_name:'PM1 gates',pine_import_id:importId,source_version:2});
 await cancel(owner,v2.job_id);
 await assertIntact('new source version, first',first.deployment_id,was1,'EXIT_ONLY');
 await assertIntact('new source version, second',second.deployment_id,was2,'EXIT_ONLY');
});

test('C8: no code path in src writes a deployment snapshot after the worker insert (only state changes; one insert; no delete)',async()=>{
 const files=(await fs.readdir(new URL('../../src/',import.meta.url),{recursive:true})).filter(name=>/\.(js|mjs|sql)$/.test(name));
 assert.ok(files.length>100,'scan covers the source tree');
 const updates=[],inserts=[],deletes=[];
 for(const name of files){
  const text=await fs.readFile(new URL('../../src/'+name,import.meta.url),'utf8');
  for(const m of text.matchAll(/UPDATE\s+pine_deployments\s+SET\s+([\s\S]*?)\s+WHERE/gi))updates.push([name,m[1].trim()]);
  if(/INSERT\s+INTO\s+pine_deployments/i.test(text))inserts.push(name);
  if(/(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+pine_deployments/i.test(text))deletes.push(name);
 }
 assert.deepEqual(updates.map(([,set])=>set).sort(),["state='EXIT_ONLY'","state='EXIT_ONLY'","state='READY'"],'every UPDATE of pine_deployments sets state only');
 assert.deepEqual(updates.map(([name])=>name.replaceAll('\\','/')).sort(),['postgres/pine-bridge-readiness.js','postgres/pine-bridge-readiness.js','postgres/pine-bridge-registry.js']);
 assert.deepEqual(inserts.map(name=>name.replaceAll('\\','/')),['postgres/pine-bridge-worker.js']);
 assert.deepEqual(deletes,[]);
});

// ---- G1 seam and C8 hash recheck on one 58-input deployment generated by the real worker -----------------------------------------
const LITERAL_BINDINGS=[
 [3,'emaFastInput',50,{min:30,max:70,step:10}],[4,'emaSlowInput',200,{min:150,max:250,step:25}],[5,'atrLenInput',14,{min:10,max:20,step:2}],
 [6,'stFactorInput',3.2,{min:2.4,max:4,step:.4}],[7,'zoneAtrMultInput',1.15,{min:.75,max:1.55,step:.2}],[8,'setupExpiryInput',48,{min:24,max:72,step:12}],
 [9,'cooldownInput',8,{min:4,max:12,step:2}],[10,'confirmLookback',5,{min:3,max:7,step:1}]
];
const tuples=bindings=>[...bindings].sort((a,b)=>a.slot-b.slot).map(b=>[b.slot,b.pine_variable,b.effective_value,b.search_domain]);
let seamState;
async function seam(){
 if(seamState)return seamState;
 const owner=await newOwner(),{importId,analysis}=await analysed(owner,{source:bigSource,provider:bigProvider(),review:true});
 assert.equal(analysis.inputs.length,BIG_INPUT_COUNT);assert.equal(analysis.inputs.length,58);
 assert.equal(analysis.effective_input_review.input_count,58);
 const slots=catalogSlots(analysis);
 const deployment=await generated(owner,generateBody(owner,importId,slots,BIG_SIGNALS),bigProvider());
 await activate(owner,deployment);
 await db.transaction(async()=>{
  for(let i=0;i<BAR_COUNT;i++){
   const {bar,provenance,content_hash}=syntheticBar(BAR_START+i*60000);
   await db.prepare('INSERT INTO pine_market_bars VALUES(?,?,?,?,?,?,?)').run('binance-global','BTCUSDT','1',bar.time,JSON.stringify(bar),JSON.stringify(provenance),content_hash);
  }
 });
 now=Math.max(now,BAR_START+BAR_COUNT*60000+1000);
 const research=(over={},key=randomUUID())=>({owner,key,body:{bot_id:owner,deployment_id:deployment.deployment_id,parameter_slots:slots,bridge_domains:BRIDGE_DOMAINS,dataset:{start_time:BAR_START,end_time:BAR_START+(BAR_COUNT-1)*60000,warmup_bars:1250},budget:25,seed:27,...over}});
 return seamState={owner,importId,analysis,slots,deployment,research};
}
const queueResearch=x=>db.transaction(()=>quant.enqueue(x.owner,x.body,x.key));
const cancelResearch=(owner,id)=>db.transaction(()=>quant.get(owner,id,true));

test('G1 seam: a worker-generated eight-slot deployment stores exactly the selection research enqueue accepts and freezes into its contract',async()=>{
 const s=await seam();
 const {selection}=s.deployment.snapshot;
 assert.deepEqual(tuples(selection.bindings),LITERAL_BINDINGS,'deployed bindings');
 assert.deepEqual(selection.bridge,{atr_multiplier:60,rr:1.5});
 assert.deepEqual(selection.signals,BIG_SIGNALS);
 assert.equal(selection.fixed_inputs.length,50,'every unselected input is stored as fixed');
 assert.equal(selection.fixed_inputs.some(i=>CATALOG_SLOTS.some(([name])=>name===i.pine_variable)),false,'no selected input is also fixed');
 assert.equal(selection.fixed_inputs.find(i=>i.pine_variable==='preset').effective_value,'Custom');
 assert.equal((await db.prepare('SELECT state FROM pine_deployments WHERE deployment_id=?').get(s.deployment.deployment_id)).state,'READY');
 const x=s.research(),queued=await queueResearch(x);
 try{
  assert.equal(queued.status,'QUEUED');
  const job=await db.prepare('SELECT contract,contract_hash FROM quant_jobs WHERE run_id=?').get(queued.run_id);
  assert.equal(job.contract.baseline_snapshot_hash,s.deployment.snapshot_hash,'research is bound to the generated snapshot');
  assert.deepEqual(tuples(job.contract.input_lock.selection.bindings),LITERAL_BINDINGS,'research lock bindings');
  assert.deepEqual(tuples(job.contract.snapshot.selection.bindings),LITERAL_BINDINGS,'research contract snapshot bindings');
  assert.deepEqual(job.contract.input_lock.selection.bindings.map(b=>b.input_id).sort(),selection.bindings.map(b=>b.input_id).sort(),'same input identities');
  assert.deepEqual(Object.keys(job.contract.input_lock.domains).sort(),[...CATALOG_SLOTS.map(([name])=>name),'atr_multiplier','rr'].sort());
  assert.equal(job.contract.input_lock.baseline.atr_multiplier,60);assert.equal(job.contract.input_lock.baseline.rr,1.5);
  assert.equal(job.contract_hash,hash(canonical(job.contract)));
 }finally{await cancelResearch(s.owner,queued.run_id);}
});

test('G1 seam: slot order in the request is ignored, but any drift from the deployed selection is refused 409 before bars, datasets or job writes',async()=>{
 const s=await seam(),deployedSlots=s.slots;
 const reversed=await queueResearch(s.research({parameter_slots:[...deployedSlots].reverse()}));
 try{assert.equal(reversed.status,'QUEUED');}finally{await cancelResearch(s.owner,reversed.run_id);}
 const extra=s.analysis.inputs.find(i=>i.pine_variable==='slAtrBufferInput');
 const swapped=deployedSlots.map(slot=>slot.slot===3?{...slot,slot:4}:slot.slot===4?{...slot,slot:3}:slot);
 const drift=[
  ['one slot dropped',deployedSlots.slice(1)],
  ['two slot numbers swapped',swapped],
  ['one domain widened to a still aligned grid',deployedSlots.map(slot=>slot.slot===3?{...slot,min:20}:slot)],
  ['one domain step halved (stFactorInput .4 to .2)',deployedSlots.map(slot=>slot.slot===6?{...slot,step:.2}:slot)],
  ['confirmLookback replaced by slAtrBufferInput',deployedSlots.map(slot=>slot.slot===10?{slot:10,input_id:extra.input_id,min:.4,max:.8,step:.1}:slot)],
  ['no source slot at all',[]]
 ];
 for(const [label,slots] of drift){
  const jobs=await count('quant_jobs');
  const sql=await recordSql(()=>assert.rejects(queueResearch(s.research({parameter_slots:slots})),{code:'RESEARCH_SELECTION_MISMATCH',status:409},label));
  assert.equal(await count('quant_jobs'),jobs,label+': no job row');
  assert.equal(sql.some(statement=>statement.includes('pine_market_bars')),false,label+': no bar read');
  assert.equal(sql.some(statement=>/INSERT INTO quant_jobs/i.test(statement)),false,label+': no job insert');
 }
});

test('C8: a tampered deployment snapshot fails the hash recheck on read (research enqueue SNAPSHOT_HASH_MISMATCH, preview STALE_DEPLOYMENT_SNAPSHOT) and the intact one passes',async()=>{
 const s=await seam(),id=s.deployment.deployment_id,original=await raw(id);
 assert.equal(hash(canonical(JSON.parse(original.text))),original.snapshot_hash);
 const request={deployment_id:id,bar_time:Date.now()-1000,event_type:'BUY'};
 const preview=()=>resolveBridgePreviewContext({store,ownerId:s.owner,botId:s.owner,request,defaultRisk:config.defaultRisk});
 const restore=()=>db.prepare('UPDATE pine_deployments SET snapshot=?::jsonb,snapshot_hash=? WHERE deployment_id=?').run(original.text,original.snapshot_hash,id);
 const tampers=[
  ['snapshot changed, hash kept',()=>db.prepare("UPDATE pine_deployments SET snapshot=jsonb_set(snapshot,'{selection,bridge,rr}','3') WHERE deployment_id=?").run(id)],
  ['hash changed, snapshot kept',()=>db.prepare('UPDATE pine_deployments SET snapshot_hash=? WHERE deployment_id=?').run('0'.repeat(64),id)]
 ];
 // Control first: the intact snapshot is not refused by the hash recheck of either reader.
 const intact=await preview().then(()=>null,error=>error.code);
 assert.notEqual(intact,'STALE_DEPLOYMENT_SNAPSHOT');
 for(const [label,tamper] of tampers){
  await tamper();
  try{
   const jobs=await count('quant_jobs');
   await assert.rejects(queueResearch(s.research()),{code:'SNAPSHOT_HASH_MISMATCH',status:409},label+': research');
   assert.equal(await count('quant_jobs'),jobs,label+': no research job');
   await assert.rejects(db.transaction(preview),{code:'STALE_DEPLOYMENT_SNAPSHOT',status:409},label+': preview');
  }finally{await restore();}
  await assertIntact('restored after '+label,id,original,'READY');
 }
 const accepted=await queueResearch(s.research());
 try{assert.equal(accepted.status,'QUEUED');}finally{await cancelResearch(s.owner,accepted.run_id);}
});
