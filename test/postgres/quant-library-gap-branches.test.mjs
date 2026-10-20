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
import {runOf,seedRun,MARKERS,T0,MINUTE} from '../helpers/quant-library-fixture.mjs';

/**
 * PM-1 row F08-01 gap branches of the Quant Research Library (src/postgres/quant-library.js at c066604). Every run is a LABELLED
 * FIXTURE (test/helpers/quant-library-fixture.mjs): synthetic rows written with plain inserts, never a research result.
 * The service is called directly, as the route handler does (quantLibraryRoutes builds QuantLibraryService and calls detail()).
 *
 * C11 (docs/ROADMAP.md QR-1b paragraph: "The Research Library reports database protection only when every guard is installed";
 *      limitations.provenance_gaps RESULT_NOT_DB_FROZEN for a terminal run that is not frozen): the claim DB_TRIGGER needs the
 *      freeze function and every guard ENABLE ALWAYS, for the legacy tables AND, where the FOUNDATION tables exist, for the three
 *      FOUNDATION guards (quant_research_binding_terminal_insert, quant_research_chunk_terminal_insert,
 *      quant_research_chunk_terminal_freeze). The legacy guard case is asserted in quant-library-http.test.mjs; this file adds the
 *      FOUNDATION branches, the "FOUNDATION tables present but freeze not extended" state and the "no FOUNDATION tables" state.
 * C14 (docs/QUANT_RESEARCH_LIBRARY.md "Previously used holdout cannot be reused as independent proof"; gate G5 HOLDOUT_INDEPENDENT):
 *      an earlier run of the same owner that evaluated a holdout counts as overlapping when its market or its holdout window cannot
 *      be read (conservative), but not when it has a readable different market, a readable disjoint window, another owner, or is
 *      newer, or never evaluated a holdout.
 */
let admin,db,store,databaseName,service,A,B;

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_qgap_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:6});await db.migrate();
  await install('pine-bridge-schema.sql');
  await install('quant-exposure-register.sql');
  store=new Store(db);service=new QuantLibraryService(db);
  A=await newOwner('qgap-a');B=await newOwner('qgap-b');
  await install('quant-research-schema.sql');
});
after(async()=>{
  await db?.close();
  if(admin){if(databaseName)await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.close();}
});
const install=async name=>db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8')));
async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword('qgap-'+randomUUID())});
  await store.setRisk(user.id,structuredClone(config.defaultRisk));
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:MARKERS.policy};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hash(importId),'Library fixture',MARKERS.source,'{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hash(canonical(snapshot)),T0]);
  return {id:user.id,importId,deployment};
}
const AT=index=>T0+index*3_600_000;
const make=(owner,options)=>runOf({owner:owner.id,deployment:owner.deployment,importId:owner.importId,...options});
const seed=(owner,run)=>seedRun(db,run,{owner:owner.id,deployment:owner.deployment});
/** Changes the stored contract the way a damaged or foreign record would look, and keeps the stored hash consistent with it. */
function reshape(run,edit){edit(run.contract);run.contract_hash=hash(canonical(run.contract));return run;}
const detailOf=async(owner,run)=>service.detail(owner.id,run.run_id);

// ---------------------------------------------------------------------------------------------------------------------------
// C11: result_protection and the RESULT_NOT_DB_FROZEN gap, FOUNDATION branches of the "frozen" flag.
// ---------------------------------------------------------------------------------------------------------------------------
const FOUNDATION_GUARDS=[['quant_research_foundation','quant_research_binding_terminal_insert'],['quant_research_chunks','quant_research_chunk_terminal_insert'],
  ['quant_research_chunks','quant_research_chunk_terminal_freeze']];
const LEGACY_GUARDS=[['quant_jobs','quant_job_terminal_freeze'],['quant_jobs','quant_job_terminal_no_delete'],['quant_job_steps','quant_job_step_terminal_insert']];
const modes=async guards=>Object.fromEntries((await Promise.all(guards.map(async([table,name])=>{
  const row=(await db.query('SELECT tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND NOT tgisinternal',['public.'+table,name])).rows;
  return [name,row.length===1?row[0].tgenabled:'ABSENT'];
}))));
const protectionOf=async run=>{const body=await detailOf(A,run);return {protection:body.integrity.result_protection,gap:body.limitations.provenance_gaps.includes('RESULT_NOT_DB_FROZEN')};};
const FROZEN={protection:'DB_TRIGGER',gap:false},OPEN={protection:'APPLICATION_ONLY',gap:true};
let terminal,running;

test('C11: without FOUNDATION tables the freeze is reported once the three legacy guards are ENABLE ALWAYS; a missing freeze reads as application only',async()=>{
  terminal=make(A,{scenario:'PENDING',at:AT(1)});await seed(A,terminal);
  running=make(A,{status:'RUNNING',partial:2,at:AT(2)});await seed(A,running);
  assert.deepEqual(await db.query("SELECT to_regclass('quant_research_foundation') f,to_regclass('quant_research_chunks') c,to_regclass('quant_foundation_jobs') j").then(result=>result.rows[0]),{f:null,c:null,j:null});
  assert.deepEqual(await protectionOf(terminal),OPEN,'no freeze installed yet');
  await install('quant-research-freeze.sql');
  assert.deepEqual(await modes(LEGACY_GUARDS),{quant_job_terminal_freeze:'A',quant_job_terminal_no_delete:'A',quant_job_step_terminal_insert:'A'});
  assert.deepEqual(await protectionOf(terminal),FROZEN,'FOUNDATION tables are absent, so only the legacy guards count');
});

test('C11: FOUNDATION tables that exist while the freeze has no guard on them read as application only',async()=>{
  await install('quant-foundation-schema.sql');await install('quant-research-foundation-schema.sql');
  assert.deepEqual(await modes(FOUNDATION_GUARDS),{quant_research_binding_terminal_insert:'ABSENT',quant_research_chunk_terminal_insert:'ABSENT',quant_research_chunk_terminal_freeze:'ABSENT'});
  assert.deepEqual(await modes(LEGACY_GUARDS),{quant_job_terminal_freeze:'A',quant_job_terminal_no_delete:'A',quant_job_step_terminal_insert:'A'},'the legacy guards are untouched');
  assert.deepEqual(await protectionOf(terminal),OPEN,'three FOUNDATION guards are missing');
  await install('quant-research-freeze.sql');
  assert.deepEqual(await modes(FOUNDATION_GUARDS),{quant_research_binding_terminal_insert:'A',quant_research_chunk_terminal_insert:'A',quant_research_chunk_terminal_freeze:'A'});
  assert.deepEqual(await protectionOf(terminal),FROZEN,'every legacy and FOUNDATION guard is ENABLE ALWAYS');
});

for(const [table,name] of FOUNDATION_GUARDS){
  test('C11: the FOUNDATION guard '+name+' disabled, or enabled in the default way, no longer supports the freeze claim',async()=>{
    assert.deepEqual(await protectionOf(terminal),FROZEN,'start state');
    for(const [action,mode] of [['DISABLE TRIGGER','D'],['ENABLE TRIGGER','O']]){
      await db.query('ALTER TABLE '+table+' '+action+' '+name);
      try{
        const state=await modes([...LEGACY_GUARDS,...FOUNDATION_GUARDS]);
        const others=Object.entries(state).filter(([guard])=>guard!==name);
        assert.equal(state[name],mode,'the guard under test is now '+mode);
        assert.ok(others.every(([,value])=>value==='A'),'every other guard stays ENABLE ALWAYS: '+JSON.stringify(state));
        const body=await detailOf(A,terminal);
        assert.equal(body.integrity.result_protection,'APPLICATION_ONLY','guard '+name+' mode '+mode);
        assert.ok(body.limitations.provenance_gaps.includes('RESULT_NOT_DB_FROZEN'),'the gap is listed for a terminal run');
        assert.deepEqual(body.integrity.warnings,[],'the read-time integrity checks still pass');
        // A run that is still writable never receives the gap, whatever the guards say.
        const live=await detailOf(A,running);
        assert.equal(live.limitations.provenance_gaps.includes('RESULT_NOT_DB_FROZEN'),false);
        assert.equal(live.limitations.provenance_gaps.includes('NO_IMMUTABLE_FINISH_TIME'),false);
      }finally{await db.query('ALTER TABLE '+table+' ENABLE ALWAYS TRIGGER '+name);}
    }
    assert.equal((await modes(FOUNDATION_GUARDS))[name],'A');
    assert.deepEqual(await protectionOf(terminal),FROZEN,'restored');
  });
}

test('C11: the freeze function missing reads as application only even when every guard is ENABLE ALWAYS',async()=>{
  // The guards call the function, so the function cannot be dropped; the protection claim also needs the version marker function.
  await db.query('ALTER FUNCTION public.quant_research_freeze_version() RENAME TO quant_research_freeze_version_paused');
  try{assert.deepEqual(await protectionOf(terminal),OPEN);}
  finally{await db.query('ALTER FUNCTION public.quant_research_freeze_version_paused() RENAME TO quant_research_freeze_version');}
  assert.deepEqual(await protectionOf(terminal),FROZEN);
});
// ---------------------------------------------------------------------------------------------------------------------------
// C14: G5 HOLDOUT_INDEPENDENT, how an earlier run of unknown market or window shape is counted.
// The code (quant-library.js load()): an earlier run counts when (its market is unreadable OR equals the market of the run)
// AND (its holdout window is unreadable OR overlaps the window of the run). An unreadable part is a wildcard for that part only.
// ---------------------------------------------------------------------------------------------------------------------------
const FAR=T0+400_000*MINUTE;
const base={scenario:'PENDING',tag:'g5',start:FAR};
const gate5=async(owner,run)=>{const body=await detailOf(owner,run);return {gate:body.qualification.gates[4],overlap:body.qualification.holdout_overlap,gates:body.qualification.gates.map(item=>item.state).join(' '),label:body.qualification.label};};
const dropMarket=contract=>{delete contract.snapshot.market;};
const dropSplit=contract=>{delete contract.split;};

test('C14: an earlier run whose market or holdout window cannot be read is counted as overlapping, unless its readable part already excludes it; other owners, newer runs and runs without a holdout never count',async()=>{
  const current=make(A,{...base,at:AT(100)});await seed(A,current);
  // Controls with a readable shape that must not count.
  const disjoint=make(A,{...base,start:FAR+5000*MINUTE,at:AT(90)});
  const otherMarket=reshape(make(A,{...base,at:AT(91)}),contract=>{contract.snapshot.market.symbol='ETHUSDT';});
  await seed(A,disjoint);await seed(A,otherMarket);
  const clean=await gate5(A,current);
  assert.equal(clean.gates,'PASS PASS PASS PASS PASS FAIL FAIL FAIL','the current run reaches G5 and G1-G4 pass');
  assert.deepEqual(clean.gate,{gate:'G5',name:'HOLDOUT_INDEPENDENT',state:'PASS',code:null});
  assert.deepEqual(clean.overlap,{checked:true,overlaps:false,run_ids:[]},'a readable disjoint window, and an overlapping window on another readable market, do not count');
  // Earlier runs of unknown shape that DO count. The order of creation is the order of the answer (created_at, run_id).
  const noMarket=reshape(make(A,{...base,at:AT(92)}),dropMarket);                                                    // market unreadable, window overlaps
  const partialMarket=reshape(make(A,{...base,at:AT(93)}),contract=>{delete contract.snapshot.market.timeframe;});    // market incomplete, window overlaps
  const noSplit=reshape(make(A,{...base,at:AT(94)}),dropSplit);                                                       // same market, window unreadable
  const badWindow=reshape(make(A,{...base,at:AT(95)}),contract=>{contract.split.test_end=contract.split.validation_end;}); // same market, empty window
  const badStart=reshape(make(A,{...base,at:AT(96)}),contract=>{contract.dataset.start_time='not a number';});      // same market, no start
  const bothUnknown=reshape(make(A,{...base,start:FAR+5000*MINUTE,at:AT(97)}),contract=>{dropMarket(contract);dropSplit(contract);});
  const counted=[noMarket,partialMarket,noSplit,badWindow,badStart,bothUnknown];
  for(const run of counted)await seed(A,run);
  // Unknown shape that must still not count: the readable part excludes it, or the run is not an earlier holdout run of this owner.
  const unknownMarketDisjoint=reshape(make(A,{...base,start:FAR+5000*MINUTE,at:AT(80)}),dropMarket);
  const otherMarketNoWindow=reshape(make(A,{...base,at:AT(81)}),contract=>{contract.snapshot.market.symbol='ETHUSDT';dropSplit(contract);});
  const noHoldout=reshape(make(A,{...base,scenario:'NO_VALID',at:AT(82)}),contract=>{dropMarket(contract);dropSplit(contract);});
  const foreign=reshape(make(B,{...base,at:AT(83)}),contract=>{dropMarket(contract);dropSplit(contract);});
  const newer=reshape(make(A,{...base,at:AT(101)}),dropMarket);
  for(const run of [unknownMarketDisjoint,otherMarketNoWindow,noHoldout,newer])await seed(A,run);
  await seed(B,foreign);
  // Fixture check: these runs of this owner evaluated a holdout (the C11 run too), and the NO_VALID run did not.
  const holdoutRows=(await db.query("SELECT run_id FROM quant_jobs WHERE result->'holdout_evaluated'='true'::jsonb AND owner_id=$1",[A.id])).rows.map(row=>row.run_id).sort();
  assert.deepEqual(holdoutRows,[terminal,current,disjoint,otherMarket,...counted,unknownMarketDisjoint,otherMarketNoWindow,newer].map(run=>run.run_id).sort());
  assert.equal((await db.query("SELECT result->'holdout_evaluated' h FROM quant_jobs WHERE run_id=$1",[noHoldout.run_id])).rows[0].h,false);
  const reused=await gate5(A,current);
  assert.deepEqual(reused.gate,{gate:'G5',name:'HOLDOUT_INDEPENDENT',state:'FAIL',code:'HOLDOUT_WINDOW_REUSED'});
  assert.deepEqual(reused.overlap,{checked:true,overlaps:true,run_ids:counted.map(run=>run.run_id)},'exactly the six unreadable earlier runs, oldest first');
  assert.equal(reused.gates,'PASS PASS PASS PASS FAIL FAIL FAIL FAIL');
  assert.equal(reused.label,'DEVELOPMENT_ONLY');
  for(const excluded of [terminal,disjoint,otherMarket,unknownMarketDisjoint,otherMarketNoWindow,noHoldout,foreign,newer,current])assert.ok(!reused.overlap.run_ids.includes(excluded.run_id),'not counted: '+excluded.run_id);
  // A run whose own market cannot be read has no independence lookup at all: G5 fails closed with its own code.
  const newerBody=await detailOf(A,newer);
  assert.deepEqual(newerBody.qualification.holdout_overlap,{checked:false,overlaps:null,run_ids:[]});
  assert.deepEqual([newerBody.qualification.gates[4].state,newerBody.qualification.gates[4].code],['FAIL','HOLDOUT_INDEPENDENCE_NOT_CHECKED']);
  // The foreign owner's run is invisible to A.
  await assert.rejects(service.detail(A.id,foreign.run_id),{code:'NOT_FOUND',status:404});
});
