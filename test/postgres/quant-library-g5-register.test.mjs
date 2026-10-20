import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {QuantLibraryService} from '../../src/postgres/quant-library.js';
import {appendExposures} from '../../src/postgres/exposure-register.js';
import {holdoutWindow} from '../../src/quant-library/derive.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {runOf,seedRun,MARKERS,T0,MINUTE} from '../helpers/quant-library-fixture.mjs';

/**
 * QR-3 S2b: library gate G5 (library-qualification-v2) reads the shared exposure register (contract RC-C28 and RC-C33, S2 design D6 and D7).
 * An exposure of the same owner and market counts when its at_ms is at or before the run creation time and its half-open window
 * overlaps the inclusive holdout window; either kind (QR3_COMPARISON, QR4_SELECTION) gives HOLDOUT_EXPOSED_BY_COMPARISON after
 * HOLDOUT_WINDOW_REUSED; an absent or unreadable register gives HOLDOUT_INDEPENDENCE_NOT_CHECKED; a later exposure is only an
 * informational flag. Every run and every register row is a LABELLED FIXTURE (synthetic, never a research result). The register is
 * insert-only, so each scenario uses its own owner. The service is called directly, as the route handler does.
 */
let admin,db,store,databaseName,service;
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const FAR=T0+400_000*MINUTE;
const CREATED=index=>T0+index*3_600_000;
const GATE5=(body,expected)=>assert.deepEqual([body.qualification.gates[4].state,body.qualification.gates[4].code],expected);

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_qg5_test_'+randomUUID().replaceAll('-','');
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
const install=async name=>db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8')));
async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword('qg5-'+randomUUID())});
  await store.setRisk(user.id,structuredClone(config.defaultRisk));
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:MARKERS.policy};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hash(importId),'Library fixture',MARKERS.source,'{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hash(canonical(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
const make=(owner,options)=>runOf({owner:owner.id,deployment:owner.deployment,importId:owner.importId,scenario:'PENDING',tag:'g5',start:FAR,...options});
const seed=async(owner,run)=>{await seedRun(db,run,{owner:owner.id,deployment:owner.deployment});return run;};
const detail=(owner,run)=>service.detail(owner.id,run.run_id);
const registerCount=async()=>Number((await db.query('SELECT count(*) AS n FROM public.quant_exposure_register')).rows[0].n);
/** Appends register events for one owner and market the way the S2a writer does: SERIALIZABLE transaction, one clock value per call. */
const expose=(owner,events,at,market=MARKET)=>db.transaction(()=>appendExposures(db,{owner_id:owner.id,...market,events,now:()=>at}),{isolation:'SERIALIZABLE'});
const around=(run,fromBars=10,toBars=20)=>{const window=holdoutWindow(run.contract);return {start_ms:window.start_time+fromBars*MINUTE,end_ms:window.start_time+toBars*MINUTE};};
const comparison=(window,id='cmp-'+randomUUID())=>({kind:'QR3_COMPARISON',window,comparison_id:id,participant_run_id:'run-'+randomUUID(),source_hash:hash(id)});
const selection=(window,id='sel-'+randomUUID())=>({kind:'QR4_SELECTION',window,selection_id:id});

test('absent register: G5 is HOLDOUT_INDEPENDENCE_NOT_CHECKED and the other gates are unchanged; the version is v2',async()=>{
  assert.equal((await db.query("SELECT to_regclass('public.quant_exposure_register') r")).rows[0].r,null);
  const owner=await newOwner('qg5-absent'),run=await seed(owner,make(owner,{at:CREATED(1)}));
  const body=await detail(owner,run);
  assert.equal(body.qualification.version,'library-qualification-v2');
  GATE5(body,['FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED']);
  assert.equal(body.qualification.gates.map(gate=>gate.state).join(' '),'PASS PASS PASS PASS FAIL FAIL FAIL FAIL');
  assert.equal(body.qualification.label,'DEVELOPMENT_ONLY');assert.equal(body.qualification.qualified,false);
  assert.deepEqual(body.qualification.holdout_overlap,{checked:true,overlaps:false,run_ids:[]},'the earlier-run lookup is unaffected');
  assert.deepEqual(body.qualification.exposure,{checked:false,overlaps:null,comparison_ids:[],selection_ids:[],later:{overlaps:null,comparison_ids:[],selection_ids:[]}});
  assert.deepEqual(body.qualification.flags,[]);
  assert.equal(body.qualified_total,0);assert.equal(body.qualified_winner,null);
  assert.equal((await service.list(owner.id)).rules.qualification,'library-qualification-v2');
});

test('empty register: G5 passes and the exposure view says the register was read',async()=>{
  await install('quant-exposure-register.sql');
  assert.equal(await registerCount(),0);
  const owner=await newOwner('qg5-empty'),run=await seed(owner,make(owner,{at:CREATED(2)}));
  const body=await detail(owner,run);
  GATE5(body,['PASS',null]);
  assert.equal(body.qualification.gates.map(gate=>gate.state).join(' '),'PASS PASS PASS PASS PASS FAIL FAIL FAIL');
  assert.deepEqual(body.qualification.exposure,{checked:true,overlaps:false,comparison_ids:[],selection_ids:[],later:{overlaps:false,comparison_ids:[],selection_ids:[]}});
  assert.deepEqual(body.qualification.flags,[]);
  assert.equal(body.qualification.label,'DEVELOPMENT_ONLY','G6 to G8 still fail, so nothing is qualified');assert.equal(body.qualified_total,0);
  const listed=(await service.list(owner.id)).runs.find(item=>item.run_id===run.run_id);
  assert.deepEqual(listed.qualification,{qualified:false,label:'DEVELOPMENT_ONLY'});
  assert.equal(await registerCount(),0,'the read never writes the register');
});

test('an unreadable register (marker table missing) gives HOLDOUT_INDEPENDENCE_NOT_CHECKED, never a pass; the register comes back unchanged',async()=>{
  const owner=await newOwner('qg5-marker'),run=await seed(owner,make(owner,{at:CREATED(3)}));
  GATE5(await detail(owner,run),['PASS',null]);
  await db.query('ALTER TABLE public.quant_exposure_register_schema RENAME TO quant_exposure_register_schema_paused');
  try{
    const body=await detail(owner,run);
    GATE5(body,['FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED']);assert.equal(body.qualification.exposure.checked,false);
  }finally{await db.query('ALTER TABLE public.quant_exposure_register_schema_paused RENAME TO quant_exposure_register_schema');}
  await db.query('ALTER TABLE public.quant_exposure_register RENAME TO quant_exposure_register_paused');
  try{GATE5(await detail(owner,run),['FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED']);}
  finally{await db.query('ALTER TABLE public.quant_exposure_register_paused RENAME TO quant_exposure_register');}
  GATE5(await detail(owner,run),['PASS',null]);
});

test('a counted QR-3 comparison exposure fails G5 with HOLDOUT_EXPOSED_BY_COMPARISON and names the comparison; a QR-4 selection does the same',async()=>{
  const owner=await newOwner('qg5-counted');
  const run=await seed(owner,make(owner,{at:CREATED(10)}));
  const window=around(run);
  await expose(owner,[comparison(window,'cmp-one')],run.created_at-MINUTE);
  const one=await detail(owner,run);
  GATE5(one,['FAIL','HOLDOUT_EXPOSED_BY_COMPARISON']);
  assert.equal(one.qualification.gates.map(gate=>gate.state).join(' '),'PASS PASS PASS PASS FAIL FAIL FAIL FAIL');
  assert.deepEqual(one.qualification.exposure,{checked:true,overlaps:true,comparison_ids:['cmp-one'],selection_ids:[],later:{overlaps:false,comparison_ids:[],selection_ids:[]}});
  assert.deepEqual(one.qualification.flags,[],'a counted exposure is G5, not an informational flag');
  assert.deepEqual(one.qualification.holdout_overlap,{checked:true,overlaps:false,run_ids:[]});
  assert.equal(one.qualification.label,'DEVELOPMENT_ONLY');assert.equal(one.qualification.qualified,false);
  await expose(owner,[selection(around(run,0,5),'sel-one')],run.created_at-2*MINUTE);
  const both=await detail(owner,run);
  GATE5(both,['FAIL','HOLDOUT_EXPOSED_BY_COMPARISON']);
  assert.deepEqual([both.qualification.exposure.comparison_ids,both.qualification.exposure.selection_ids],[['cmp-one'],['sel-one']]);
  // A selection alone, for a run of its own owner.
  const second=await newOwner('qg5-selection'),other=await seed(second,make(second,{at:CREATED(11)}));
  await expose(second,[selection(around(other,30,40),'sel-only')],other.created_at-5*MINUTE);
  const only=await detail(second,other);
  GATE5(only,['FAIL','HOLDOUT_EXPOSED_BY_COMPARISON']);
  assert.deepEqual([only.qualification.exposure.comparison_ids,only.qualification.exposure.selection_ids],[[],['sel-only']]);
  // The compare route reports the same labels and the v2 rule set.
  const pair=await newOwner('qg5-compare'),x=await seed(pair,make(pair,{at:CREATED(12)})),y=await seed(pair,make(pair,{at:CREATED(13),start:FAR+5000*MINUTE}));
  const answer=await service.compare(pair.id,[x.run_id,y.run_id]);
  assert.equal(answer.rules.qualification,'library-qualification-v2');assert.deepEqual(answer.runs.map(item=>item.qualification),[{qualified:false,label:'DEVELOPMENT_ONLY'},{qualified:false,label:'DEVELOPMENT_ONLY'}]);
  assert.equal(answer.qualified_total,0);assert.equal(answer.qualified_winner,null);
});

test('HOLDOUT_WINDOW_REUSED comes first: an overlapping earlier run and an exposure fail G5 with the earlier-run code, and both are reported',async()=>{
  const owner=await newOwner('qg5-reused');
  const earlier=await seed(owner,make(owner,{at:CREATED(20)})),run=await seed(owner,make(owner,{at:CREATED(21)}));
  await expose(owner,[comparison(around(run),'cmp-both')],run.created_at-MINUTE);
  const body=await detail(owner,run);
  GATE5(body,['FAIL','HOLDOUT_WINDOW_REUSED']);
  assert.deepEqual(body.qualification.holdout_overlap,{checked:true,overlaps:true,run_ids:[earlier.run_id]});
  assert.deepEqual([body.qualification.exposure.overlaps,body.qualification.exposure.comparison_ids],[true,['cmp-both']]);
  // The earlier run itself has nothing earlier than it, and the same exposure was recorded after its creation: G5 passes, informational flag only.
  const first=await detail(owner,earlier);
  GATE5(first,['PASS',null]);
  assert.deepEqual(first.qualification.exposure.later,{overlaps:true,comparison_ids:['cmp-both'],selection_ids:[]});
});

test('a later exposure never changes G5: it is shown as an informational HOLDOUT_EXPOSED_BY_COMPARISON flag with the ids; at_ms equal to the creation time still counts',async()=>{
  const owner=await newOwner('qg5-later'),run=await seed(owner,make(owner,{at:CREATED(30)}));
  await expose(owner,[comparison(around(run),'cmp-late')],run.created_at+1);
  await expose(owner,[selection(around(run,40,50),'sel-late')],run.created_at+MINUTE);
  const body=await detail(owner,run);
  GATE5(body,['PASS',null]);
  assert.equal(body.qualification.gates.map(gate=>gate.state).join(' '),'PASS PASS PASS PASS PASS FAIL FAIL FAIL');
  assert.deepEqual(body.qualification.exposure,{checked:true,overlaps:false,comparison_ids:[],selection_ids:[],later:{overlaps:true,comparison_ids:['cmp-late'],selection_ids:['sel-late']}});
  assert.deepEqual(body.qualification.flags,[{code:'HOLDOUT_EXPOSED_BY_COMPARISON',informational:true,comparison_ids:['cmp-late'],selection_ids:['sel-late']}]);
  const tied=await newOwner('qg5-tied'),other=await seed(tied,make(tied,{at:CREATED(31)}));
  await expose(tied,[comparison(around(other),'cmp-tied')],other.created_at);
  GATE5(await detail(tied,other),['FAIL','HOLDOUT_EXPOSED_BY_COMPARISON']);
});

test('window boundaries, other owner and other market: only a same-owner, same-market half-open overlap of the holdout counts',async()=>{
  const owner=await newOwner('qg5-edges'),stranger=await newOwner('qg5-stranger');
  const run=await seed(owner,make(owner,{at:CREATED(40)})),window=holdoutWindow(run.contract),before=run.created_at-MINUTE;
  const lastBar=window.end_time;
  // Touching, not overlapping: the exposure ends where the holdout starts, or starts one bar after the last holdout bar.
  await expose(owner,[comparison({start_ms:window.start_time-10*MINUTE,end_ms:window.start_time},'cmp-ends-at-start'),
    comparison({start_ms:lastBar+MINUTE,end_ms:lastBar+11*MINUTE},'cmp-after-end')],before);
  // Another owner and another market, both overlapping the window.
  await expose(stranger,[comparison(around(run),'cmp-stranger')],before);
  await expose(owner,[comparison(around(run),'cmp-other-market')],before,{...MARKET,symbol:'ETHUSDT'});
  const clean=await detail(owner,run);
  GATE5(clean,['PASS',null]);assert.deepEqual(clean.qualification.exposure.later,{overlaps:false,comparison_ids:[],selection_ids:[]});
  assert.deepEqual(clean.qualification.exposure.comparison_ids,[]);
  // One bar more on either side is an overlap: [start-10, start+1) holds the first holdout bar, [last, last+1) is the last one.
  await expose(owner,[comparison({start_ms:window.start_time-10*MINUTE,end_ms:window.start_time+MINUTE},'cmp-first-bar')],before);
  const first=await detail(owner,run);
  GATE5(first,['FAIL','HOLDOUT_EXPOSED_BY_COMPARISON']);assert.deepEqual(first.qualification.exposure.comparison_ids,['cmp-first-bar']);
  const lastOwner=await newOwner('qg5-last'),lastRun=await seed(lastOwner,make(lastOwner,{at:CREATED(41)}));
  await expose(lastOwner,[comparison({start_ms:holdoutWindow(lastRun.contract).end_time,end_ms:holdoutWindow(lastRun.contract).end_time+MINUTE},'cmp-last-bar')],lastRun.created_at-MINUTE);
  GATE5(await detail(lastOwner,lastRun),['FAIL','HOLDOUT_EXPOSED_BY_COMPARISON']);
});

test('G1 to G4 fail: the register is still read and a counted exposure is disclosed as an informational flag; an unreadable own window or market has no lookup and G5 fails closed',async()=>{
  const owner=await newOwner('qg5-skip');
  const noValid=await seed(owner,make(owner,{scenario:'NO_VALID',at:CREATED(50)}));
  const noMarket=make(owner,{at:CREATED(51),start:FAR+9000*MINUTE}),noSplit=make(owner,{at:CREATED(52),start:FAR+18000*MINUTE});
  delete noMarket.contract.snapshot.market;noMarket.contract_hash=hash(canonical(noMarket.contract));
  delete noSplit.contract.split;noSplit.contract_hash=hash(canonical(noSplit.contract));
  await seed(owner,noMarket);await seed(owner,noSplit);
  const unreadable=noSplit;
  await expose(owner,[comparison(around(noValid),'cmp-gated')],noValid.created_at-MINUTE);
  const gated=await detail(owner,noValid);
  assert.equal(gated.qualification.gates.map(gate=>gate.state).join(' '),'PASS FAIL NOT_REACHED NOT_REACHED NOT_REACHED FAIL FAIL FAIL');
  assert.deepEqual(gated.qualification.holdout_overlap,{checked:false,overlaps:null,run_ids:[]},'the earlier-run lookup stays inside the G1 to G4 block');
  assert.deepEqual(gated.qualification.exposure,{checked:true,overlaps:true,comparison_ids:['cmp-gated'],selection_ids:[],later:{overlaps:false,comparison_ids:[],selection_ids:[]}});
  assert.deepEqual(gated.qualification.flags,[{code:'HOLDOUT_EXPOSED_BY_COMPARISON',informational:true,comparison_ids:['cmp-gated'],selection_ids:[]}]);
  // A run whose own market or holdout window cannot be read has no independence lookup at all: G5 fails closed and the register is not consulted.
  for(const bad of [noMarket,unreadable]){
    const body=await detail(owner,bad);
    GATE5(body,['FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED']);
    assert.deepEqual(body.qualification.holdout_overlap,{checked:false,overlaps:null,run_ids:[]});
    assert.equal(body.qualification.exposure.checked,false);assert.deepEqual(body.qualification.flags,[]);
  }
});

test('a counted exposure is also flagged when HOLDOUT_WINDOW_REUSED takes G5; a definite reuse wins over an unreadable register',async()=>{
  const owner=await newOwner('qg5-reused-flag');
  const earlier=await seed(owner,make(owner,{at:CREATED(60),start:FAR+30000*MINUTE})),run=await seed(owner,make(owner,{at:CREATED(61),start:FAR+30000*MINUTE}));
  await expose(owner,[comparison(around(run),'cmp-counted')],run.created_at-MINUTE);
  await expose(owner,[selection(around(run,40,50),'sel-after')],run.created_at+MINUTE);
  const body=await detail(owner,run);
  GATE5(body,['FAIL','HOLDOUT_WINDOW_REUSED']);assert.deepEqual(body.qualification.holdout_overlap.run_ids,[earlier.run_id]);
  assert.deepEqual(body.qualification.flags,[{code:'HOLDOUT_EXPOSED_BY_COMPARISON',informational:true,comparison_ids:['cmp-counted'],selection_ids:['sel-after']}]);
  await db.query('ALTER TABLE public.quant_exposure_register_schema RENAME TO quant_exposure_register_schema_paused');
  try{
    const open=await detail(owner,run);
    GATE5(open,['FAIL','HOLDOUT_WINDOW_REUSED']);assert.equal(open.qualification.exposure.checked,false);assert.deepEqual(open.qualification.flags,[]);
  }finally{await db.query('ALTER TABLE public.quant_exposure_register_schema_paused RENAME TO quant_exposure_register_schema');}
});

test('an own holdout whose start is not minute aligned cannot be looked up: G5 is HOLDOUT_INDEPENDENCE_NOT_CHECKED and the register is not consulted',async()=>{
  const owner=await newOwner('qg5-unaligned');
  const run=await seed(owner,make(owner,{at:CREATED(70),start:FAR+40000*MINUTE+1}));
  const body=await detail(owner,run);
  assert.equal(holdoutWindow(run.contract),null);
  GATE5(body,['FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED']);
  assert.deepEqual(body.qualification.holdout_overlap,{checked:false,overlaps:null,run_ids:[]});
  assert.equal(body.qualification.exposure.checked,false);assert.deepEqual(body.qualification.flags,[]);
});

test('the register is installed but the runtime role cannot SELECT it: the detail view fails closed with an error, never PASS or NOT_CHECKED',async()=>{
  const owner=await newOwner('qg5-denied'),run=await seed(owner,make(owner,{at:CREATED(80),start:FAR+50000*MINUTE}));
  const role='qg5_reader_'+randomUUID().replaceAll('-','').slice(0,12),password='qg5-'+randomUUID();
  await db.query('CREATE ROLE '+role+" LOGIN PASSWORD '"+password+"'");
  let limited;
  try{
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO '+role);
    await db.query('REVOKE ALL ON public.quant_exposure_register FROM '+role);
    const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;url.username=role;url.password=password;
    limited=new PostgresDatabase({connectionString:url.toString(),max:2});
    const reader=new QuantLibraryService(limited);
    // Before the REVOKE takes effect the same limited role reads G5 PASS with the exposure checked, so only the register grant differs.
    await db.query('GRANT SELECT ON public.quant_exposure_register TO '+role);
    const granted=await reader.detail(owner.id,run.run_id);GATE5(granted,['PASS',null]);assert.equal(granted.qualification.exposure.checked,true);
    await db.query('REVOKE ALL ON public.quant_exposure_register FROM '+role);
    await assert.rejects(reader.detail(owner.id,run.run_id),error=>{assert.equal(error.code,'42501');assert.match(error.message,/quant_exposure_register/);return true;});
    const control=await detail(owner,run);GATE5(control,['PASS',null]);
  }finally{
    await limited?.close();
    await db.query('DROP OWNED BY '+role);await db.query('DROP ROLE '+role);
  }
});
