import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';
import {QuantResearchService,quantResearchRoutes} from '../../src/postgres/quant-research.js';
import {QuantLibraryService,quantLibraryRoutes} from '../../src/postgres/quant-library.js';

// Real stored fixed-evaluation admission in an isolated fixture database. No evaluator, scheduler or cancellation worker is started.
let f,research,library,fixed,beforeList;
const serial=fn=>f.db.transaction(fn,{isolation:'SERIALIZABLE'});
const notFound=error=>error?.code==='NOT_FOUND'&&error.status===404;
const writes=async()=>{
  const out={};
  for(const table of ['quant_jobs','quant_foundation_jobs','quant_research_foundation','quant_research_chunks','quant_job_steps','audit']){
    out[table]=(await f.db.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return out;
};
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL only');
  f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);
  research=new QuantResearchService({pineService:f.service.pine,foundation:true,datasetStore:{}});
  library=new QuantLibraryService(f.db,{admissionEnabled:true});
  beforeList=await library.list(f.owner);
  const admitted=await f.service.enqueue(f.owner,f.body,'pg_fixed_separation_001');
  assert.equal(admitted.ok,true);
  fixed=admitted.evaluation_run_id;
});
after(async()=>{await f?.close();});

test('fixed evaluation is NOT_FOUND to research get and cancel before any foundation, parent or audit mutation',async()=>{
  const before=await writes();
  for(const cancel of [false,true])await assert.rejects(serial(()=>research.get(f.owner,fixed,cancel)),notFound);
  assert.deepEqual(await writes(),before,'fixed parent, foundation lifecycle and audit are untouched');
  const row=(await f.db.query('SELECT * FROM public.quant_jobs WHERE run_id=$1',[fixed])).rows[0];
  assert.equal(row.contract.mode,'FIXED_INPUT_EVAL');
  assert.equal(row.contract.input_lock,undefined,'actual fixed contract has no legacy summary input_lock');
  await assert.rejects(research.summary(row),notFound,'direct summary/idempotent reuse cannot partially expose fixed metadata');
  assert.deepEqual(await writes(),before);
});

test('research GET and cancellation route wrappers disclose no fixed metadata; absent and foreign keys give the same code',async()=>{
  const before=await writes();let answers=0;
  for(const suffix of ['', '/cancel']){
    const req=Object.assign(Readable.from(suffix?[Buffer.from('{}')]:[]),{method:suffix?'POST':'GET',headers:{}});
    await assert.rejects(serial(()=>quantResearchRoutes(req,{},new URL('http://fixture/api/quant/research/jobs/'+fixed+suffix),{id:f.owner},research,()=>{answers++;},{enabled:true})),notFound);
  }
  assert.equal(answers,0);
  await assert.rejects(serial(()=>research.get(f.owner,randomUUID())),notFound);
  const foreign=await f.store.createUser({email:randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture'});
  await assert.rejects(serial(()=>research.get(foreign.id,fixed,true)),notFound);
  // The one intentionally created foreign fixture user does not change any table in writes().
  assert.deepEqual(await writes(),before);
});

test('library filters fixed rows before list pagination and totals, preserving ordinary research rows',async()=>{
  const afterList=await library.list(f.owner);
  assert.deepEqual(afterList,beforeList,'fixed admission is invisible to library rows, totals and cursors');
  assert.equal(afterList.totals.all,2);
  assert.equal(afterList.runs.some(row=>row.run_id===fixed),false);
  const pages=[];let before=null;
  do{
    const page=await library.list(f.owner,{limit:1,before});
    pages.push(...page.runs.map(row=>row.run_id));
    before=page.next_before?{created_at:Number(page.next_before.split(':')[0]),run_id:page.next_before.split(':')[1]}:null;
  }while(before);
  assert.equal(pages.length,2);assert.equal(new Set(pages).size,2);
  assert.deepEqual(new Set(pages),new Set(f.state.parents.map(row=>row.run_id)));
});

test('fixed library detail and mixed comparisons are closed NOT_FOUND in both orders; no partial metadata or G8 source',async()=>{
  const before=await writes(),normal=f.parent.run_id;
  await assert.rejects(library.detail(f.owner,fixed),notFound);
  await assert.rejects(library.detail('foreign-fixture-owner',fixed),notFound);
  await assert.rejects(library.detail(f.owner,randomUUID()),notFound);
  for(const ids of [[normal,fixed],[fixed,normal]])await assert.rejects(library.compare(f.owner,ids),notFound);
  for(const url of ['/api/quant/library/runs/'+fixed,'/api/quant/library/compare?run_id='+normal+'&run_id='+fixed]){
    let answered=false;
    await assert.rejects(quantLibraryRoutes({method:'GET'}, {},new URL('http://fixture'+url),{id:f.owner},f.db,()=>{answered=true;}),notFound);
    assert.equal(answered,false,'no partial route response');
  }
  assert.deepEqual(await writes(),before);
});

test('ordinary research summary/detail/compare still read the existing admitted parent runs',async()=>{
  const summary=await serial(()=>research.get(f.owner,f.parent.run_id));
  assert.equal(summary.run_id,f.parent.run_id);assert.equal(summary.status,'SUCCEEDED');
  const detail=await library.detail(f.owner,f.parent.run_id);
  assert.ok(JSON.stringify(detail).includes(f.parent.run_id));
  const ids=f.state.parents.map(row=>row.run_id),compared=await library.compare(f.owner,ids);
  assert.deepEqual(new Set(compared.runs.map(row=>row.run_id)),new Set(ids));
  assert.equal(JSON.stringify(compared).includes(fixed),false);
});
