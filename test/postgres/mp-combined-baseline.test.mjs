import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Decimal from 'decimal.js';
import {runCombinedOracle,compareCombined,PYTHON_FUNNEL_MAP,BASELINE_VERSION,CASH_TOLERANCE,REALIZED_R_TOLERANCE} from '../../src/multi-pine/combined-oracle.js';

/*
 * F11 S2: Python against the Node oracle, on REAL Python output (RD-MP-30, RD-MP-33).
 *
 * The S1 scripted driver (quant_lab/tests/mp_scripted_driver.py) runs the Python combined evaluator once per request and prints the ledger.
 * Every input below is a LABELLED ENGINEERING FIXTURE (scripted-signals-v1 cases, or the synthetic 6,000-bar fixture with the real SPT Custom
 * evaluator): never a research result, never market data. The oracle gets the same inputs and reads no Python output; only `compareCombined`
 * reads both. No database is used (the file sits in test/postgres/ by design); the only external process is the Python interpreter, named by
 * QUANT_TEST_PYTHON or quant_lab/.venv.
 */
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..','..');
const FIXTURES=path.join(root,'test','fixtures','mp-combined');
const DRIVER=path.join(root,'quant_lab','tests','mp_scripted_driver.py');
const PYTHON=process.env.QUANT_TEST_PYTHON??path.join(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const D=value=>new Decimal(value);
const CASES=JSON.parse(fs.readFileSync(path.join(FIXTURES,'scripted-cases-v1.json'),'utf8')).cases;
const MANIFEST=JSON.parse(fs.readFileSync(path.join(FIXTURES,'manifest.json'),'utf8'));

function driver(request){
  assert.ok(fs.existsSync(PYTHON),'the baseline needs the quant_lab/.venv interpreter (uv sync) or QUANT_TEST_PYTHON');
  const out=execFileSync(PYTHON,[DRIVER],{input:JSON.stringify(request),encoding:'utf8',cwd:root,maxBuffer:1024*1024*1024});
  const lines=out.split('\n').filter(Boolean);
  assert.equal(lines.length,1,'the driver prints one JSON line');
  const result=JSON.parse(lines[0]);
  assert.equal(result.error,undefined,'driver error '+result.error);
  return result;
}
/** The oracle input is built from the same request fields the driver reads; capital becomes equity and cash. */
const oracleInput=spec=>({members:spec.members,bars:spec.bars,pair:spec.pair,model:spec.model,policy:spec.policy,equity:spec.capital.equity,cash:spec.capital.cash,
  broker:spec.broker,symbol:spec.symbol,start_time:spec.start_time,same_bar_order:spec.same_bar_order});
const nonZero=record=>Object.fromEntries(Object.entries(record.differences).filter(([,count])=>count!==0));
function assertMatched(record,label){
  assert.equal(record.version,BASELINE_VERSION);
  assert.deepEqual(nonZero(record),{},label+': no difference count');
  assert.equal(record.matched,true,label+': matched');
  assert.ok(D(record.per_entry_cash_max_delta).lte(CASH_TOLERANCE)&&D(record.per_entry_cost_max_delta).lte(CASH_TOLERANCE),label+': per-entry cash and cost bound');
  assert.ok(D(record.final_cash_delta).lte(CASH_TOLERANCE)&&D(record.final_position_cost_delta).lte(CASH_TOLERANCE),label+': final cash and cost bound');
  assert.ok(D(record.max_realized_r_delta).lte(REALIZED_R_TOLERANCE),label+': realized R bound');
  assert.equal(record.counts.received_events,record.counts.events);
  assert.equal(record.counts.received_decisions,record.counts.decisions);
  assert.equal(record.counts.received_fills,record.counts.fills);
}

/* ---------------------------------------------------------------- (a) every scripted case */

test('the scripted case file lists the seven cases of the manifest',()=>{
  assert.deepEqual(CASES.map(item=>item.id),MANIFEST.scripted_cases.ids);
  assert.equal(CASES.length,7);
});

for(const scripted of CASES){
  test('scripted '+scripted.id+': real Python result against the oracle, matched',t=>{
    const python=driver(scripted);
    const oracle=runCombinedOracle(oracleInput(scripted));
    const record=compareCombined(python,oracle);
    assertMatched(record,scripted.id);
    assert.equal(record.members.length,scripted.members.length);
    assert.ok(record.counts.decisions>0&&record.counts.events>0);
    // the committed `expected` of the case file is a Python-side pin: the driver output must still carry it (a drift here is an S1 fixture fault, not a baseline fault)
    assert.equal(python.ledger_sha256,scripted.expected.ledger_sha256,'Python ledger hash equals the case pin');
    assert.ok(D(python.ledger.final_cash).eq(scripted.expected.final_cash),'Python final cash equals the case pin');
    assert.ok(D(oracle.ledger.final_cash).eq(scripted.expected.final_cash),'oracle final cash equals the case pin');
    t.diagnostic(JSON.stringify({id:scripted.id,matched:record.matched,events:record.counts.events,decisions:record.counts.decisions,fills:record.counts.fills,
      max_realized_r_delta:record.max_realized_r_delta,final_cash_delta:record.final_cash_delta}));
  });
}

/* ---------------------------------------------------------------- (b) library runs on the 6,000 fixture bars */

const LIBRARY={
  'M1+M2':['M1','M2'],
  'M1+M2+M1':['M1','M2','M3'],
  'M1':['M1']
};
const request=names=>({fixture_run:{members:names.map((name,index)=>({name,deployment_id:'fixture-'+(name==='M3'?'m1':name.toLowerCase())+'-'+(index+1)})),pair:MANIFEST.pair,factor:1}});
const libraryCache=new Map();
function library(name){
  if(!libraryCache.has(name)){
    const python=driver(request(LIBRARY[name]));
    libraryCache.set(name,{python,oracle:runCombinedOracle(oracleInput(python.input))});
  }
  return libraryCache.get(name);
}

for(const name of Object.keys(LIBRARY)){
  test('library '+name+': real Python result on the 6,000 fixture bars against the oracle, matched',t=>{
    const {python,oracle}=library(name);
    const input=python.input;
    assert.equal(input.bars.length,MANIFEST.bars.bar_count);
    assert.equal(input.start_time,input.bars[MANIFEST.split.warmup].time,'ledger start is the first row after warm-up');
    assert.equal(input.members.length,LIBRARY[name].length);
    const record=compareCombined(python,oracle);
    assertMatched(record,name);
    assert.equal(record.range.start_time,input.start_time);
    assert.equal(record.range.rows,MANIFEST.bars.bar_count);
    assert.ok(record.counts.fills>=20,'the run books fills');
    assert.ok(oracle.diagnostics.bot.pre_start_intents>0,'warm-up intents exist, so the window rule is exercised');
    t.diagnostic(JSON.stringify({run:name,matched:record.matched,counts:record.counts,max_realized_r_delta:record.max_realized_r_delta,per_entry_cash_max_delta:record.per_entry_cash_max_delta,
      final_cash_delta:record.final_cash_delta,final_position_cost_delta:record.final_position_cost_delta,bot:python.diagnostics.bot}));
  });
}

test('library M1+M2+M1: the duplicate-logic member books its own ledger rows under its own deployment id',()=>{
  const {python,oracle}=library('M1+M2+M1');
  const ids=python.input.members.map(member=>member.deployment_id);
  assert.deepEqual(ids,['fixture-m1-1','fixture-m2-2','fixture-m1-3']);
  const owner=entryRef=>entryRef.split(':').slice(0,-2).join(':');
  for(const id of ids)assert.ok(oracle.ledger.events.some(event=>owner(event.entry_ref)===id),'events of '+id);
  assert.equal(python.diagnostics.members[0].native_buy,python.diagnostics.members[2].native_buy,'equal logic, equal native signals');
});

/* ---------------------------------------------------------------- open points: how the Python result looks in practice */

test('open points: Python diagnostics shape matches what the comparison maps',()=>{
  for(const name of ['M1+M2','M1+M2+M1']){
    const {python,oracle}=library(name);
    const rows=python.diagnostics.members;
    assert.ok(Array.isArray(rows),'members is an array');
    for(const row of [...rows,python.diagnostics.bot]){
      for(const key of Object.keys(PYTHON_FUNNEL_MAP))assert.ok(Object.hasOwn(row,key),'key '+key+' present');
      assert.equal(Number.isInteger(row.skipped_buys),true,'skipped_buys is an integer (key present)');
      assert.equal(Number.isInteger(row.intents_exit),true,'intents_exit is an integer total, not a reason map');
    }
    // native signal counts cover every input row (warm-up included): they exceed the post-warm-up counts and equal the oracle's
    oracle.diagnostics.members.forEach((funnel,index)=>{
      assert.equal(rows[index].native_buy,funnel.native_buy);
      assert.equal(rows[index].native_exit,funnel.native_exit);
      assert.equal(rows[index].intents_buy,funnel.intents_buy);
      assert.equal(rows[index].pre_start_intents,funnel.pre_start_intents);
    });
    const input=python.input;
    const nativeBuyAfterStart=python.input.members.map(member=>member.signals.buy.slice(MANIFEST.split.warmup).filter(Boolean).length);
    const nativeBuyAll=python.input.members.map(member=>member.signals.buy.filter(Boolean).length);
    nativeBuyAll.forEach((all,index)=>{
      assert.equal(rows[index].native_buy,all,'native_buy counts all rows');
      assert.ok(all>nativeBuyAfterStart[index],'warm-up rows carry native signals');
    });
    assert.equal(input.bars.length,MANIFEST.bars.bar_count);
  }
});

/* ---------------------------------------------------------------- negative: one quantity step */

const STEP=(model)=>D(model.quantity_step);
function perturbFill(python,model){
  const copy=structuredClone(python);
  const index=copy.ledger.decisions.findIndex(item=>item.outcome==='FILLED'&&item.event_type==='BUY');
  assert.ok(index>=0,'a filled BUY exists');
  const decision=copy.ledger.decisions[index];
  const quantity=D(decision.quantity).plus(STEP(model)).toFixed();
  decision.quantity=quantity;
  const fill=copy.ledger.fills.find(item=>item.entry_ref===decision.entry_ref&&item.event_type===decision.event_type);
  assert.ok(fill,'the mirrored fill exists');
  fill.quantity=quantity;
  return {copy,entryRef:decision.entry_ref};
}

test('negative: one Python fill moved by one quantity step is not matched (scripted F13)',()=>{
  const scripted=CASES.find(item=>item.id==='F13');
  const python=driver(scripted),oracle=runCombinedOracle(oracleInput(scripted));
  assertMatched(compareCombined(python,oracle),'F13 unperturbed');
  const {copy}=perturbFill(python,scripted.model);
  const record=compareCombined(copy,oracle);
  assert.equal(record.matched,false);
  assert.ok(record.differences.quantity_steps>=1,'quantity difference counted');
  assert.equal(D(record.max_quantity_step_delta).toFixed(),'1','the difference is exactly one venue step');
});

test('negative: one Python fill moved by one quantity step is not matched (library M1+M2)',()=>{
  const {python,oracle}=library('M1+M2');
  const {copy}=perturbFill(python,python.input.model);
  const record=compareCombined(copy,oracle);
  assert.equal(record.matched,false);
  assert.ok(record.differences.quantity_steps>=1);
  assert.ok(record.differences.fill_content>=1,'the fills list shows the change as well');
  assert.equal(D(record.max_quantity_step_delta).toFixed(),'1');
  assertMatched(compareCombined(python,oracle),'library M1+M2 after the perturbed copy (the original is untouched)');
});
