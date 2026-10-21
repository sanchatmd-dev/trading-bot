import test from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {canonical, hash} from '../src/pine-bridge/source.js';
import {QuantResearchWorker, pythonEvaluation} from '../src/postgres/quant-research-worker.js';
import {LEGACY_ENGINE_FILES, FOUNDATION_ENGINE_FILES} from '../src/postgres/quant-research.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {FIXED_EVAL_ENGINE_FILES} from '../src/postgres/quant-fixed-eval-engine.js';
import {PF2_ENGINE_FILES, PF2_EVALUATOR_FILES} from '../src/quant-research/preflight-resolver.js';
import {INGESTION_ENGINE_FILES} from '../src/postgres/quant-data.js';
import {LIBRARY_VERSIONS} from '../src/quant-library/derive.js';
import {TRACE_FILES, CANDIDATE_BLOCKERS, OWNER_RECOMMENDATION_CONTRACT_VERSIONS, evaluateProvenance} from '../src/quant-library/package-gates.js';
import {renderPackage} from '../src/quant-library/package-render.js';
import {
  DRIVER_ARGS, TRACE_COLUMNS, TRACE_EXECUTION_PROFILES, TRACE_PROFILE_DEFERRED, TRACE_REFUSAL_CODES, TRACE_REPRODUCTION_CLOSURE_VERSION, TRACE_REPRODUCTION_FILES, DRIVER_REPLY_LIMIT, DRIVER_REQUEST_LIMIT,
  defaultPorts, driverEvaluation, gateTraceReproduction, reproduceRun, resolveInterpreter, traceReproductionEngineHash, traceReproductionRecords
} from '../src/quant-library/trace-reproduction.js';
import {contractOf, metricsOf, hex, MINUTE, T0} from './helpers/quant-library-fixture.mjs';

/*
 * F09 builder S3b. Everything here is a LABELLED ENGINEERING FIXTURE: synthetic bars and synthetic metrics, never a research result and
 * never a recommendation. The module core runs on injected fake ports, so no Python, database, network or clock is involved. The driver
 * spawner runs against a stub script executed by this Node binary (never a bare interpreter from PATH), and the one test that would need
 * a real interpreter is skipped with a reason unless an interpreter resolves (QUANT_RESEARCH_PYTHON, else quant_lab/.venv; never a bare python from PATH).
 *
 * Fixture convention (root ruling R-CV1): every run here is a worker-shaped legacy v1 run (ql3a-research-job-v1, bars inline, no execution_backend key)
 * with policy_version added by hand, because no real v1 or v2 run passes the package gates today. This is fixture evidence, not build evidence. No test
 * accepts the v3 placeholder, the multi-Pine version or a foundation run as reproducible: those forms only appear in refusal tests (B6, B6b, B6c).
 */

const clone = value => JSON.parse(JSON.stringify(value));
const HEX64 = /^[0-9a-f]{64}$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- fixture: a legacy contract, a model run built by the real worker loop, and a fake driver ---------------- */

const OWNER = 'owner-a', BOT = 'bot-a', DEPLOY = '3c1d0a52-7b9e-4c1a-9a26-0f1e2d3c4b5a', IMPORT = '8a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e';
const SOURCE = ['//@version=6', 'indicator("Trace fixture indicator", overlay=true)', 'emaFastInput = input.int(50, "EMA fast", minval=30, maxval=50, step=10)',
  'useSlowFilter = input.bool(true, "Slow filter")', 'notifyEnabled = input.bool(false, "Notify")', 'emaFast = ta.ema(close, emaFastInput)',
  'emaSlow = ta.ema(close, 100)', 'buySignal = ta.crossover(emaFast, emaSlow)', 'sellSignal = ta.crossunder(emaFast, emaSlow)', 'plot(emaFast)', ''].join('\n');
const STATEMENT = 'emaFastInput = input.int(50, "EMA fast", minval=30, maxval=50, step=10)';
const SPAN_START = SOURCE.indexOf(STATEMENT);

/** The selected candidate. Its neighbours: atr 1 and atr 2 (a plan candidate), ema 30 (ema 50 fails validParameters), rr 1.25 (a plan candidate; rr index 0 is an edge). */
const SEL = {atr_multiplier: 1.5, emaFastInput: 40, rr: 1};
const PLAN = [
  {atr_multiplier: 1.5, emaFastInput: 40, rr: 1.25},
  SEL,
  {atr_multiplier: 2, emaFastInput: 40, rr: 1},
  {atr_multiplier: 1, emaFastInput: 30, rr: 1.5},
  {atr_multiplier: 1.5, emaFastInput: 30, rr: 1.75},
  {atr_multiplier: 1, emaFastInput: 40, rr: 1.5}];

function baseContract() {
  const contract = clone(contractOf({owner: OWNER, bot: BOT, deployment: DEPLOY, importId: IMPORT, tag: 'trace', total: 60, warmup: 4, barCount: 60}));
  Object.assign(contract, {version: 'ql3a-research-job-v1', source: SOURCE, source_hash: hash(SOURCE), policy_version: 'policy-v1', acceptance_blockers: [...CANDIDATE_BLOCKERS]});
  contract.snapshot.policy = {max_daily_loss_percent: '3', equities: {'binance-global': '1000'}};
  contract.snapshot.membership = [{pine_import_id: IMPORT, source_version: 1, source_hash: contract.source_hash}];
  contract.input_lock.selection.bindings[0].source_span = {start: SPAN_START, end: SPAN_START + STATEMENT.length};
  // The worker rule needs the slow EMA to judge a pair: ema 50 is not below 45, so that neighbour is skipped.
  contract.input_lock.selection.fixed_inputs.push({input_id: 'input_11', pine_variable: 'emaSlowInput', effective_value: 45, type: 'int', eligible: false});
  contract.plan.candidates = clone(PLAN);
  contract.plan.planned_candidates = PLAN.length;
  return contract;
}
const CONTRACT = baseContract();
const ENGINE = CONTRACT.engine_hash;
const S = CONTRACT.split;
const barTime = index => CONTRACT.dataset.bars[index].time;
const TRACE_HASH = hex('trace-engine');

const holdoutTest = () => ({...metricsOf('1.9', 5, '0E-18'), gross_loss: '0E-18'});
/** The deterministic fake engine: one result per (kind, parameters). Counts are fixed so the fake driver rows can match them. */
function fakeEval(kind, params) {
  const selected = canonical(params) === canonical(SEL);
  const validation = kind === 'STRESS' ? '3.5' : selected ? '5.0' : '4.0';
  return {kind, parameters: params, train: metricsOf('4.1', 5), validation: metricsOf(validation, 5), decision_count: 33, fills: 31, rejections: {RISK_LIMIT: 2},
    exit_fill_reasons: {SL: 7, TP: 8}, owner_recommendation_ready: false, ...(kind === 'HOLDOUT' ? {test: holdoutTest()} : {})};
}

/** The stored run: the REAL QuantResearchWorker.run loop with its step and finish stubbed to the fake engine, then a JSONB-like round trip. */
async function modelRun() {
  const worker = Object.create(QuantResearchWorker.prototype), steps = [];
  let finished = null;
  worker.engineHash = async () => ENGINE;
  worker.step = async (job, id, kind, parameters) => { steps.push({id, kind, parameters}); return fakeEval(kind, parameters); };
  worker.finish = async (job, status, result) => { finished = {status, result}; };
  await worker.run({contract: CONTRACT, contract_hash: hash(canonical(CONTRACT))});
  return {steps, finished, run: clone({owner_id: OWNER, bot_id: BOT, run_id: 'run-trace-0001', status: finished.status, contract: CONTRACT, contract_hash: hash(canonical(CONTRACT)), result: finished.result})};
}
const MODEL = await modelRun();
const BASE_RUN = MODEL.run;
const SELECTED = BASE_RUN.result.selected;
const storedDigests = selected => ({
  steps: hash(canonical({candidate: {parameters: selected.parameters, result: selected.result}, sensitivity: selected.sensitivity, cost_stress: selected.cost_stress})),
  holdout: hash(canonical({test: selected.test}))});
const STORED = storedDigests(SELECTED);

/** Trade schedule by bar index (entry, exit): five closed trades per partition, one trade crossing each boundary, one entry left open at the end. */
const SCHEDULE = [[5, 6], [8, 9], [11, 12], [14, 15], [17, 18],
  [S.train_end - 1, S.train_end], [S.train_end + 1, S.train_end + 2], [S.train_end + 4, S.train_end + 5], [S.train_end + 6, S.train_end + 7], [S.train_end + 8, S.train_end + 9],
  [S.validation_end - 1, S.validation_end], [S.validation_end + 1, S.validation_end + 2], [S.validation_end + 3, S.validation_end + 4], [S.validation_end + 5, S.validation_end + 6], [S.validation_end + 7, S.validation_end + 8]];
const OPEN_AT = S.test_end - 2, REJECTED_AT = [S.train_end + 3, S.validation_end + 9];
const partitionAt = index => index < S.train_end ? 'train' : index < S.validation_end ? 'validation' : 'test';

/** The reply of the Python driver for the fixture: result, trades, decisions and equity as strings and integers. */
function fakeReply() {
  const fills = [];
  SCHEDULE.forEach(([entry, exit], k) => { fills.push({index: entry, type: 'BUY', ref: 'e' + k, k}); fills.push({index: exit, type: 'EXIT', ref: 'e' + k, k}); });
  fills.push({index: OPEN_AT, type: 'BUY', ref: 'open', k: 99});
  fills.sort((a, b) => a.index - b.index);
  const trades = [], equity = [], decisions = [];
  let cash = 1000;
  for (const fill of fills) {
    const time = barTime(fill.index), exit = fill.type === 'EXIT';
    cash += exit ? 1.1 : -1;
    const open = fills.filter(item => item.index <= fill.index && item.type === 'BUY').length - fills.filter(item => item.index <= fill.index && item.type === 'EXIT').length;
    equity.push({time, partition: partitionAt(fill.index), event_type: fill.type, cash: cash.toFixed(2), position_quantity: open === 0 ? '0E-18' : '0.01', equity_at_fill: (cash + open * 1.005).toFixed(3)});
    decisions.push({time, event_type: fill.type, entry_ref: fill.ref, sequence: decisions.length + 1, reason: exit ? 'TP' : null, sl: exit ? null : '99', tp: exit ? null : '101',
      outcome: 'FILLED', sizing_outcome: 'ACCEPTED', sizing_adjustment: null, quantity: '0.01', price: '100.5', notional: '1.005', fee: '0.001', cash: cash.toFixed(2),
      cost: '1.006', realized_r: exit ? '0E-18' : '0', partition: partitionAt(fill.index)});
  }
  for (const index of REJECTED_AT)
    decisions.push({time: barTime(index), event_type: 'BUY', entry_ref: 'rej' + index, sequence: 0, reason: 'RISK_LIMIT', sl: '99', tp: '101', outcome: 'REJECTED', quantity: '0', fee: '0', partition: partitionAt(index)});
  decisions.sort((a, b) => a.time - b.time);
  SCHEDULE.forEach(([entry, exit], k) => trades.push({entry_ref: 'e' + k, partition: partitionAt(exit), entry_time: barTime(entry), entry_price: '100.5', quantity: '0.01', entry_fee: '0.001',
    exit_time: barTime(exit), exit_price: k % 2 ? '101.5' : '100.4', exit_fee: '0.001', exit_reason: k % 2 ? 'TP' : 'SL', net: k === 3 ? '0E-18' : k % 2 ? '0.0099' : '-0.0021', realized_r: k === 3 ? '0E-18' : '0.5'}));
  trades.sort((a, b) => a.exit_time - b.exit_time);
  return {result: fakeEval('HOLDOUT', clone(SEL)), trades, decisions, equity};
}

function makePorts({engine = ENGINE, evaluate, trace, reply = fakeReply, traceEngineHash = () => TRACE_HASH} = {}) {
  const log = [];
  let engineCalls = 0;
  const ports = {
    evaluate: async (contract, parameters, kind, signal) => { log.push(['evaluate', kind, clone(parameters)]); return evaluate ? evaluate(contract, parameters, kind, signal) : fakeEval(kind, parameters); },
    traceEvaluate: async (contract, parameters, signal) => { log.push(['trace', clone(parameters)]); return trace ? trace(contract, parameters, signal) : reply(); },
    engineHash: async () => { log.push(['engineHash']); engineCalls++; return typeof engine === 'function' ? engine(engineCalls) : engine; },
    traceEngineHash: async () => traceEngineHash()};
  return {ports, log};
}
/** A run from the model run with one edit; the contract hash is re-derived unless the edit is outside the contract. */
function runWith(edit) {
  const run = clone(BASE_RUN);
  edit?.(run);
  run.contract_hash = hash(canonical(run.contract));
  return run;
}
const reproduce = async (run = BASE_RUN, options = {}) => { const made = makePorts(options); const value = await reproduceRun({run, ports: made.ports, signal: options.signal}); return {value, log: made.log}; };
const refused = async (run, code, options = {}) => {
  const made = makePorts(options);
  await assert.rejects(() => reproduceRun({run, ports: made.ports, signal: options.signal}), error => { assert.equal(error.code, code, options.label); return true; }).catch(error => {
    if (options.label) error.message = options.label + ': ' + error.message;
    throw error;
  });
  return made.log;
};
const evaluations = log => log.filter(entry => entry[0] === 'evaluate' || entry[0] === 'trace');

test('the fixture run is what the real worker loop stores: pending acceptance, a holdout, six steps beyond the plan', () => {
  assert.equal(MODEL.finished.status, 'SUCCEEDED');
  assert.equal(SELECTED.screen_reasons.length, 0);
  assert.equal(BASE_RUN.result.holdout_evaluated, true);
  assert.equal(BASE_RUN.result.completion_reason, 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  assert.deepEqual(SELECTED.parameters, SEL);
  // Premise of the neighbour rule: a neighbour equal to a plan candidate is stored with that candidate's own result, so its kind is CANDIDATE.
  assert.deepEqual(SELECTED.sensitivity.map(item => [item.dimension, item.result.kind]),
    [['atr_multiplier', 'SENSITIVITY'], ['atr_multiplier', 'CANDIDATE'], ['emaFastInput', 'SENSITIVITY'], ['rr', 'CANDIDATE']]);
});

/* ---------------- B1 / B5: digests equal the stored ones ---------------- */

test('B1 recomputed digests equal the digests of the stored steps of the real worker (the formula the C3 gate compares)', async () => {
  const {value} = await reproduce();
  assert.equal(value.steps_digest, STORED.steps);
  assert.equal(value.holdout_digest, STORED.holdout);
  assert.match(value.steps_digest, HEX64);
  assert.match(value.holdout_digest, HEX64);
  assert.equal(value.run_engine_hash, ENGINE);
  assert.equal(value.trace_engine_hash, TRACE_HASH);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.trace) && Object.isFrozen(value.trace.equity.rows) && Object.isFrozen(value.trace.equity.rows[0]));
  assert.deepEqual(Object.keys(value).sort(), ['holdout_digest', 'run_engine_hash', 'steps_digest', 'trace', 'trace_engine_hash']);
  assert.deepEqual(Object.keys(value.trace), ['equity', 'trades', 'decisions']);
});

test('B1 a different recomputed value changes the digest: the cost-stress result and the holdout test each bind', async () => {
  const stress = (await reproduce(BASE_RUN, {evaluate: (contract, parameters, kind) => kind === 'STRESS' ? {...fakeEval(kind, parameters), validation: metricsOf('3.4', 5)} : fakeEval(kind, parameters)})).value;
  assert.notEqual(stress.steps_digest, STORED.steps);
  const holdout = (await reproduce(BASE_RUN, {reply: () => { const reply = fakeReply(); reply.result.test.net_return_percent = '1.8'; return reply; }})).value;
  assert.notEqual(holdout.holdout_digest, STORED.holdout);
  assert.equal(holdout.steps_digest, STORED.steps);
});

test('B5 neighbours follow the worker rule: sorted domains, index minus one then plus one, edge and validParameters skips, plan-equal neighbours are CANDIDATE', async () => {
  const {value, log} = await reproduce();
  assert.equal(value.steps_digest, STORED.steps);
  const calls = log.filter(entry => entry[0] === 'evaluate').map(entry => [entry[1], entry[2]]);
  assert.deepEqual(calls, [
    ['CANDIDATE', SEL],
    ['SENSITIVITY', {...SEL, atr_multiplier: 1}],
    ['CANDIDATE', {...SEL, atr_multiplier: 2}],
    ['SENSITIVITY', {...SEL, emaFastInput: 30}],
    ['CANDIDATE', {...SEL, rr: 1.25}],
    ['STRESS', SEL]]);
  // The real worker ran exactly the non-plan neighbours as steps, in the same order.
  const workerSensitivity = MODEL.steps.filter(step => step.kind === 'SENSITIVITY').map(step => step.parameters);
  assert.deepEqual(workerSensitivity, calls.filter(call => call[0] === 'SENSITIVITY').map(call => call[1]));
  // The FABLE alternative (a plan-equal neighbour run as SENSITIVITY) can never match the stored digest.
  const alternative = hash(canonical({candidate: {parameters: SELECTED.parameters, result: SELECTED.result},
    sensitivity: SELECTED.sensitivity.map(item => ({...item, result: {...item.result, kind: 'SENSITIVITY'}})), cost_stress: SELECTED.cost_stress}));
  assert.notEqual(alternative, STORED.steps);
});

/* ---------------- B2: port call log ---------------- */

test('B2 the call log is engine hash, steps in worker order, the one holdout through traceEvaluate, engine hash; HOLDOUT never goes through evaluate', async () => {
  const {log} = await reproduce();
  assert.deepEqual(log.map(entry => entry[0] === 'evaluate' ? entry[1] : entry[0]), ['engineHash', 'CANDIDATE', 'SENSITIVITY', 'CANDIDATE', 'SENSITIVITY', 'CANDIDATE', 'STRESS', 'trace', 'engineHash']);
  assert.equal(log.filter(entry => entry[0] === 'evaluate' && entry[1] === 'HOLDOUT').length, 0);
  assert.equal(log.filter(entry => entry[0] === 'trace').length, 1);
  assert.deepEqual(log.find(entry => entry[0] === 'trace')[1], SEL, 'the holdout runs the selected parameters only');
  assert.equal(log.find(entry => entry[0] === 'evaluate' && entry[1] === 'STRESS')[2].rr, SEL.rr);
  assert.deepEqual(log.filter(entry => entry[0] === 'evaluate').map(entry => entry[1]).filter(kind => kind === 'STRESS'), ['STRESS'], 'stress is its own kind, not CANDIDATE');
});

test('B2 the engine gets the contract by reference and parameters it may change without moving the digest', async () => {
  const seen = [];
  const {value} = await reproduce(BASE_RUN, {evaluate: (contract, parameters, kind) => { seen.push(contract); const original = clone(parameters); parameters.rr = 999; return fakeEval(kind, original); }});
  assert.equal(value.steps_digest, STORED.steps);
  assert.equal(seen.length, 6);
  assert.ok(seen.every(contract => contract === BASE_RUN.contract));
});

/* ---------------- B3: no stored result is read ---------------- */

test('B3 no stored result is copied: selected.result, sensitivity, cost_stress and test are throwing getters that never fire', async () => {
  const run = clone(BASE_RUN);
  const fired = [];
  for (const name of ['result', 'sensitivity', 'cost_stress', 'test'])
    Object.defineProperty(run.result.selected, name, {enumerable: true, configurable: true, get() { fired.push(name); throw new Error('stored ' + name + ' was read'); }});
  Object.defineProperty(run.result, 'candidates', {enumerable: true, configurable: true, get() { fired.push('candidates'); throw new Error('stored candidates were read'); }});
  const {value} = await reproduce(run);
  assert.deepEqual(fired, []);
  assert.equal(value.steps_digest, STORED.steps, 'the digest comes from recomputed values, which equal the stored ones');
});

test('B3 a stored value that differs from the recomputed one does not leak into the digests', async () => {
  const run = clone(BASE_RUN);
  run.result.selected.result.validation.net_return_percent = '99';
  run.result.selected.sensitivity.length = 0;
  run.result.selected.cost_stress = null;
  run.result.selected.test = {tampered: true};
  const {value} = await reproduce(run);
  assert.equal(value.steps_digest, STORED.steps);
  assert.equal(value.holdout_digest, STORED.holdout);
});

/* ---------------- B4: engine identity ---------------- */

test('B4 a live closure hash that differs from the contract hash refuses before the first evaluation with no engine call', async () => {
  const log = await refused(BASE_RUN, 'BI_ENGINE_HASH_MISMATCH', {engine: hex('another-engine')});
  assert.deepEqual(evaluations(log), []);
  assert.deepEqual(log, [['engineHash']]);
});

test('B4 a closure that changes between the first and the last evaluation refuses with no output', async () => {
  const log = await refused(BASE_RUN, 'BI_ENGINE_HASH_MISMATCH', {engine: calls => calls === 1 ? ENGINE : hex('changed-in-flight')});
  assert.equal(log.filter(entry => entry[0] === 'trace').length, 1, 'the holdout ran before the second check');
  assert.deepEqual(log.map(entry => entry[0] === 'evaluate' ? entry[1] : entry[0]).slice(-2), ['trace', 'engineHash']);
});

test('B4 the run engine hash is the value the live closure reported, proven equal to the contract hash', async () => {
  const {value} = await reproduce();
  assert.equal(value.run_engine_hash, ENGINE);
  const malformed = runWith(run => { run.contract.engine_hash = 'engine-not-a-digest'; });
  await refused(malformed, 'BI_ENGINE_HASH_MISMATCH', {engine: 'engine-not-a-digest'});
});

/* ---------------- B6: refusals ---------------- */

test('B6 TRACE_REFUSAL_CODES are exactly the two module codes and match the status code pattern', () => {
  assert.deepEqual([...TRACE_REFUSAL_CODES], ['TRACE_REPRODUCTION_DIVERGED', 'TRACE_REPRODUCTION_UNSUPPORTED']);
  assert.ok(TRACE_REFUSAL_CODES.every(code => /^[A-Z][A-Z0-9_]{1,63}$/.test(code)));
  assert.ok(Object.isFrozen(TRACE_REFUSAL_CODES));
});

const REFUSALS = [
  ['a queued run', run => { run.status = 'QUEUED'; }, 'STATUS_NOT_COMPLETED'],
  ['a running run', run => { run.status = 'RUNNING'; }, 'STATUS_NOT_COMPLETED'],
  ['a failed run', run => { run.status = 'FAILED'; }, 'BI_RUN_NOT_QUALIFIABLE'],
  ['a run with no valid candidate', run => { run.status = 'NO_VALID_CANDIDATE'; }, 'BI_RUN_NOT_QUALIFIABLE'],
  ['a succeeded run whose checks failed', run => { run.result.completion_reason = 'CANDIDATE_FAILED_CHECKS'; }, 'BI_RUN_NOT_QUALIFIABLE'],
  ['a run with no result', run => { run.result = null; }, 'BI_RUN_NOT_QUALIFIABLE'],
  ['a holdout that was not evaluated', run => { run.result.holdout_evaluated = false; }, 'HOLDOUT_NOT_EVALUATED'],
  ['a holdout flag that is not true', run => { run.result.holdout_evaluated = 'yes'; }, 'HOLDOUT_NOT_EVALUATED'],
  ['a contract that no longer matches its hash', run => { run.contract.seed = 1; run.contract_hash = 'f'.repeat(64); }, 'BI_PROVENANCE_UNRESOLVED'],
  ['a run without a contract', run => { run.contract = null; }, 'BI_PROVENANCE_UNRESOLVED'],
  ['a missing selection', run => { run.result.selected = null; }, 'BI_PROVENANCE_UNRESOLVED'],
  ['selected parameters that are an array', run => { run.result.selected.parameters = []; }, 'BI_PROVENANCE_UNRESOLVED'],
  ['selected parameters outside the plan', run => { run.result.selected.parameters = {...SEL, rr: 1.75}; }, 'BI_PROVENANCE_UNRESOLVED'],
  ['selected parameters outside the locked grid', run => { run.result.selected.parameters = {...SEL, rr: 7}; }, 'BI_PROVENANCE_UNRESOLVED'],
  ['selected parameters that equal two plan candidates', run => { run.contract.plan.candidates.push(clone(SEL)); }, 'BI_PROVENANCE_UNRESOLVED', true],
  ['a contract without a plan', run => { delete run.contract.plan; }, 'BI_PROVENANCE_UNRESOLVED', true],
  ['a foundation backend contract', run => { run.contract.execution_backend = 'quant-foundation-v1'; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['a foundation contract version without bars', run => { run.contract.version = 'ql3a-research-job-v2'; run.contract.execution_backend = 'quant-foundation-v1'; delete run.contract.dataset.bars; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['the v3 placeholder version (deferred to the slice that defines the next contract)', run => { run.contract.version = 'ql3a-research-job-v3'; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['the multi-Pine version (deferred to the F11 trace producer)', run => { run.contract.version = 'ql3a-research-job-multi-v1'; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['a v1 contract that carries an execution_backend key set to null', run => { run.contract.execution_backend = null; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['a version that is a number', run => { run.contract.version = 1; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['a contract with no version', run => { delete run.contract.version; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['an unknown contract version', run => { run.contract.version = 'ql3a-research-job-v9'; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['a version named like an Object.prototype member', run => { run.contract.version = 'constructor'; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['an unknown execution backend on a legacy version', run => { run.contract.execution_backend = 'other'; }, 'TRACE_REPRODUCTION_UNSUPPORTED', true],
  ['a legacy contract without bars', run => { delete run.contract.dataset.bars; }, 'BI_DATASET_UNAVAILABLE', true],
  ['bars shorter than the test end', run => { run.contract.dataset.bars.pop(); }, 'BI_DATASET_UNAVAILABLE', true],
  ['bars with a gap', run => { run.contract.dataset.bars[10].time += 1; }, 'BI_DATASET_UNAVAILABLE', true],
  ['a split that is not increasing', run => { run.contract.split.train_end = run.contract.split.warmup; }, 'BI_DATASET_UNAVAILABLE', true]];

for (const [name, edit, code, rehash] of REFUSALS) {
  test('B6 refusal ' + code + ': ' + name + ' (no engine call)', async () => {
    const run = clone(BASE_RUN);
    edit(run);
    if (rehash) run.contract_hash = hash(canonical(run.contract));
    const log = await refused(run, code);
    assert.deepEqual(evaluations(log), [], 'no evaluation ran');
    assert.deepEqual(log, [], 'refused before the engine hash check as well');
  });
}

test('B6 the execution profile tables are frozen literals: one ACTIVE key, three DEFERRED keys with an owner, no overlap', () => {
  assert.deepEqual(Object.keys(TRACE_EXECUTION_PROFILES), ['ql3a-research-job-v1']);
  assert.deepEqual(Object.keys(TRACE_PROFILE_DEFERRED).sort(), ['ql3a-research-job-multi-v1', 'ql3a-research-job-v2', 'ql3a-research-job-v3']);
  assert.ok(Object.isFrozen(TRACE_EXECUTION_PROFILES) && Object.isFrozen(TRACE_PROFILE_DEFERRED));
  assert.ok(Object.values(TRACE_EXECUTION_PROFILES).every(Object.isFrozen) && Object.values(TRACE_PROFILE_DEFERRED).every(Object.isFrozen));
  assert.ok(Object.values(TRACE_PROFILE_DEFERRED).every(entry => typeof entry.owner === 'string' && entry.owner.length > 0));
  assert.equal(TRACE_PROFILE_DEFERRED['ql3a-research-job-v2'].execution_backend, 'quant-foundation-v1');
  assert.ok(!Object.hasOwn(TRACE_EXECUTION_PROFILES['ql3a-research-job-v1'], 'execution_backend'), 'the ACTIVE profile has no execution_backend key');
  for (const key of Object.keys(TRACE_PROFILE_DEFERRED)) assert.ok(!Object.hasOwn(TRACE_EXECUTION_PROFILES, key), key);
});

test('B6b no shape dispatch: a v3-labelled or multi-Pine-labelled contract that is otherwise byte-identical to the v1 fixture (bars inline, correct legacy engine hash, contract_hash recomputed) is refused', async () => {
  const good = await reproduce(BASE_RUN);
  assert.ok(good.value, 'the same contract under the v1 label is reproduced');
  for (const version of ['ql3a-research-job-v3', 'ql3a-research-job-multi-v1', 'ql3a-research-job-v2']) {
    const run = runWith(copy => { copy.contract.version = version; });
    assert.ok(Array.isArray(run.contract.dataset.bars) && run.contract.engine_hash === ENGINE && !Object.hasOwn(run.contract, 'execution_backend'));
    const log = await refused(run, 'TRACE_REPRODUCTION_UNSUPPORTED', {label: version});
    assert.deepEqual(log, [], version + ': no port call and no engine hash read');
  }
});

test('B6c check order is pinned: run state and contract hash first, then the version dispatch, then the plan checks, then the bars', async () => {
  // The version dispatch comes before the plan checks, so a deferred form with a broken plan is UNSUPPORTED, never BI_PROVENANCE_UNRESOLVED.
  for (const version of ['ql3a-research-job-v2', 'ql3a-research-job-v3']) {
    const brokenPlan = runWith(run => { run.contract.version = version; delete run.contract.plan; });
    assert.deepEqual(await refused(brokenPlan, 'TRACE_REPRODUCTION_UNSUPPORTED', {label: version + ' with a broken plan'}), []);
    const validPlan = runWith(run => { run.contract.version = version; run.contract.execution_backend = 'quant-foundation-v1'; });
    assert.deepEqual(await refused(validPlan, 'TRACE_REPRODUCTION_UNSUPPORTED', {label: version + ' with a valid plan'}), []);
  }
  // A v1 run with the same broken plan stays BI_PROVENANCE_UNRESOLVED: the plan checks still run for the ACTIVE profile.
  await refused(runWith(run => { delete run.contract.plan; }), 'BI_PROVENANCE_UNRESOLVED');
  // Run state and the contract hash are checked before the version.
  const queued = runWith(run => { run.contract.version = 'ql3a-research-job-v3'; run.status = 'QUEUED'; });
  await refused(queued, 'STATUS_NOT_COMPLETED');
  const stale = clone(BASE_RUN);
  stale.contract.version = 'ql3a-research-job-v3';
  await refused(stale, 'BI_PROVENANCE_UNRESOLVED');
});

test('B6 an unsupported backend is never reported as an engine hash mismatch (the closure hash of a foundation run matches its own contract)', async () => {
  const foundation = runWith(run => { run.contract.execution_backend = 'quant-foundation-v1'; });
  const log = await refused(foundation, 'TRACE_REPRODUCTION_UNSUPPORTED', {engine: hex('some other closure')});
  assert.deepEqual(log, []);
});

test('B6 a process failure from a port keeps its code; an uncoded error becomes EVALUATION_FAILED; a pre-aborted signal interrupts with no call', async () => {
  const timed = () => { throw Object.assign(new Error('x'), {code: 'EVALUATION_TIMED_OUT'}); };
  await refused(BASE_RUN, 'EVALUATION_TIMED_OUT', {evaluate: timed});
  await refused(BASE_RUN, 'QUANT_PYTHON_UNAVAILABLE', {trace: () => { throw Object.assign(new Error('x'), {code: 'QUANT_PYTHON_UNAVAILABLE'}); }});
  await refused(BASE_RUN, 'TRACE_REPRODUCTION_DIVERGED', {trace: () => { throw Object.assign(new Error('x'), {code: 'TRACE_REPRODUCTION_DIVERGED'}); }});
  await refused(BASE_RUN, 'EVALUATION_FAILED', {evaluate: () => { throw new TypeError('boom with /secret/path'); }});
  // Only the J9 process codes and the module refusals pass through; a filesystem code or any other upper-case code is replaced.
  for (const code of ['ENOENT', 'EACCES', 'ERR_INVALID_ARG_TYPE', 'BI_ENGINE_HASH_MISMATCH', 'SOME_OTHER_CODE'])
    await refused(BASE_RUN, 'EVALUATION_FAILED', {trace: () => { throw Object.assign(new Error('/secret/path ' + code), {code}); }, label: code});
  for (const code of ['QUANT_PYTHON_UNAVAILABLE', 'EVALUATION_TIMED_OUT', 'RESEARCH_INTERRUPTED', 'EVALUATION_OUTPUT_TOO_LARGE', 'EVALUATION_FAILED', 'INVALID_EVALUATION_RESPONSE',
    'RESEARCH_REQUEST_TOO_LARGE', 'TRACE_REPRODUCTION_DIVERGED', 'TRACE_REPRODUCTION_UNSUPPORTED'])
    await refused(BASE_RUN, code, {evaluate: () => { throw Object.assign(new Error('x'), {code}); }, label: code});
  const controller = new AbortController();
  controller.abort();
  const log = await refused(BASE_RUN, 'RESEARCH_INTERRUPTED', {signal: controller.signal});
  assert.deepEqual(evaluations(log), []);
});

test('B6 an allowed code from a port is rebuilt as a fresh error: no original message, stack or property reaches the caller', async () => {
  const original = Object.assign(new Error('/secret/path DATABASE_URL=x'), {code: 'EVALUATION_TIMED_OUT', status: 504, detail: {secret: 'x'}, cause: new Error('inner')});
  const made = makePorts({evaluate: () => { throw original; }});
  await assert.rejects(() => reproduceRun({run: BASE_RUN, ports: made.ports}), error => {
    assert.notEqual(error, original, 'a new error object');
    assert.equal(error.code, 'EVALUATION_TIMED_OUT');
    assert.equal(error.message, 'EVALUATION_TIMED_OUT');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'status']);
    assert.ok(!String(error.stack).includes('/secret/path'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('B6 a HOLDOUT reply whose result fails the HOLDOUT result check is refused, even when the result is a good result of another kind (the kind is not taken from the reply)', async () => {
  const noTest = kind => { const result = fakeEval('HOLDOUT', clone(SEL)); delete result.test; result.kind = kind; if (kind === undefined) delete result.kind; return result; };
  for (const kind of ['STRESS', 'CANDIDATE', 'SENSITIVITY', 'holdout', '', undefined, null]) {
    const reply = fakeReply();
    reply.result = noTest(kind);
    await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {reply: () => reply, label: 'kind ' + String(kind)});
  }
  const reply = fakeReply();
  reply.result = fakeEval('STRESS', clone(SEL));
  await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {reply: () => reply, label: 'a complete stress result'});
});

test('B6 the driver reply is cross-checked against the recomputed holdout result with no tolerance', async () => {
  const edits = {
    'a trade row missing from a partition': reply => { reply.trades.splice(2, 1); },
    'a trade row duplicated': reply => { reply.trades.push({...reply.trades[0], entry_ref: reply.trades[1].entry_ref}); reply.trades.sort((a, b) => a.exit_time - b.exit_time); },
    'a decision row missing': reply => { reply.decisions.pop(); },
    'a fill (equity) row missing': reply => { reply.equity.shift(); },
    'a decision count that differs': reply => { reply.result.decision_count = 34; },
    'a fill count that differs': reply => { reply.result.fills = 30; },
    'a closed trade count that differs in one partition': reply => { reply.result.validation.closed_trades = 6; },
    'a driver partition label that differs from the contract split (trade)': reply => { reply.trades[0].partition = 'validation'; },
    'a driver partition label that differs (decision)': reply => { reply.decisions[3].partition = 'test'; },
    'a driver partition label that differs (equity)': reply => { reply.equity.find(row => row.partition === 'validation').partition = 'train'; },
    'a row before the warm-up end': reply => { reply.equity[0].time = barTime(S.warmup - 1); },
    'a row after the last bar': reply => { reply.equity[reply.equity.length - 1].time = barTime(S.test_end - 1) + MINUTE; },
    'rows out of time order': reply => { reply.equity.reverse(); }};
  for (const [name, edit] of Object.entries(edits)) {
    const reply = fakeReply();
    edit(reply);
    const log = await refused(BASE_RUN, 'TRACE_REPRODUCTION_DIVERGED', {reply: () => reply, label: name});
    assert.equal(log.filter(entry => entry[0] === 'trace').length, 1, name);
  }
});

test('B6 a malformed driver reply is an invalid evaluation response, not a trace', async () => {
  const edits = {
    'an extra key': reply => { reply.extra = []; },
    'a missing key': reply => { delete reply.equity; },
    'a trades value that is not a list': reply => { reply.trades = {}; },
    'a trade cell that is not a decimal': reply => { reply.trades[0].net = 'abc'; },
    'a trade cell that is a number': reply => { reply.trades[0].net = 1.5; },
    'a non-finite trade decimal': reply => { reply.trades[0].entry_price = 'Infinity'; },
    'an extra trade key': reply => { reply.trades[0].ohlc = '1'; },
    'an equity cell that is null': reply => { reply.equity[0].cash = null; },
    'a time that is not an integer': reply => { reply.equity[0].time = 1.5; },
    'a decision price that is not a decimal': reply => { reply.decisions[0].price = 'x'; },
    'a holdout result of another kind': reply => { reply.result.kind = 'STRESS'; },
    'a holdout result without a test part': reply => { delete reply.result.test; },
    'a holdout result for other parameters': reply => { reply.result.parameters = {...SEL, rr: 1.25}; }};
  for (const [name, edit] of Object.entries(edits)) {
    const reply = fakeReply();
    edit(reply);
    await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {reply: () => reply, label: name});
  }
  await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {reply: () => null});
});

test('B6 engine decimals in 0E-18 form are decimals: a flat position and a zero return are accepted, as text, unchanged', async () => {
  const reply = fakeReply();
  assert.ok(reply.equity.some(row => row.position_quantity === '0E-18') && reply.trades.some(row => row.net === '0E-18'));
  const {value} = await reproduce(BASE_RUN, {reply: () => reply});
  const flat = value.trace.equity.rows.filter(row => row[5] === '0E-18');
  assert.ok(flat.length > 0, 'the engine text reaches the table unchanged');
  assert.ok(value.trace.trades.rows.some(row => row[12] === '0E-18'));
  // A zero holdout metric in exponent form is also a decimal for the result shape check.
  assert.equal(reply.result.test.max_drawdown_percent, '0E-18');
});

test('B6 a failed closure read or an uncoded port error never leaks a message or a path: it becomes a fresh EVALUATION_FAILED', async () => {
  const leak = () => { throw Object.assign(new Error("ENOENT: no such file, open '/secret/path/src/money.js'"), {code: 'ENOENT', path: '/secret/path/src/money.js'}); };
  for (const options of [{engine: leak}, {engine: () => { throw new TypeError('boom with /secret/path'); }}, {traceEngineHash: leak}, {traceEngineHash: () => { throw new TypeError('boom'); }}]) {
    const made = makePorts(options);
    await assert.rejects(() => reproduceRun({run: BASE_RUN, ports: made.ports}), error => {
      assert.equal(error.code, 'EVALUATION_FAILED');
      assert.equal(error.message, 'EVALUATION_FAILED');
      assert.equal(error.path, undefined);
      return true;
    });
  }
  // The real closure function rejects with the raw file error when one closure file cannot be read; the module then replaces it.
  const missing = async () => { throw Object.assign(new Error('ENOENT: no such file'), {code: 'ENOENT'}); };
  await assert.rejects(() => traceReproductionEngineHash(missing), error => error.code === 'ENOENT');
  const made = makePorts();
  made.ports.traceEngineHash = () => traceReproductionEngineHash(missing);
  await assert.rejects(() => reproduceRun({run: BASE_RUN, ports: made.ports}), error => error.code === 'EVALUATION_FAILED' && error.message === 'EVALUATION_FAILED');
  // The run closure hash port fails the same way when one closure file cannot be read.
  const brokenEngine = makePorts({engine: () => { throw Object.assign(new Error('ENOENT: no such file'), {code: 'ENOENT'}); }});
  await assert.rejects(() => reproduceRun({run: BASE_RUN, ports: brokenEngine.ports}), error => error.code === 'EVALUATION_FAILED');
});

test('B6 a non-hex trace engine hash, before or after the run, is EVALUATION_FAILED', async () => {
  for (const bad of ['zzz', 'A'.repeat(64), '', 5, null, undefined, 'a'.repeat(63)]) {
    await refused(BASE_RUN, 'EVALUATION_FAILED', {traceEngineHash: () => bad, label: String(bad)});
    let calls = 0;
    await refused(BASE_RUN, 'EVALUATION_FAILED', {traceEngineHash: () => (++calls === 1 ? TRACE_HASH : bad), label: 'after ' + String(bad)});
  }
});

test('N2 the trace engine hash is read before the first step and after the run; a change in flight is BI_ENGINE_HASH_MISMATCH with no output', async () => {
  const order = [];
  const made = makePorts({traceEngineHash: () => { order.push('trace-hash'); return TRACE_HASH; }});
  const inner = made.ports.evaluate;
  made.ports.evaluate = async (...args) => { order.push('evaluate'); return inner(...args); };
  const traceInner = made.ports.traceEvaluate;
  made.ports.traceEvaluate = async (...args) => { order.push('trace'); return traceInner(...args); };
  await reproduceRun({run: BASE_RUN, ports: made.ports});
  assert.equal(order[0], 'trace-hash');
  assert.equal(order[order.length - 1], 'trace-hash');
  assert.equal(order.filter(item => item === 'trace-hash').length, 2);
  assert.ok(order.indexOf('trace-hash') < order.indexOf('evaluate'));
  assert.ok(order.lastIndexOf('trace-hash') > order.indexOf('trace'));
  let calls = 0;
  await refused(BASE_RUN, 'BI_ENGINE_HASH_MISMATCH', {traceEngineHash: () => (++calls === 1 ? TRACE_HASH : hex('trace-engine-changed'))});
  // A bad first hash stops the run before any evaluation.
  const log = await refused(BASE_RUN, 'EVALUATION_FAILED', {traceEngineHash: () => 'nope'});
  assert.deepEqual(evaluations(log), []);
  // A pre-aborted signal stops before the hash read.
  const controller = new AbortController();
  controller.abort();
  await refused(BASE_RUN, 'RESEARCH_INTERRUPTED', {signal: controller.signal, traceEngineHash: () => { throw new Error('must not be read'); }});
});

test('B6 trace rows: edges, duplicates, order, entry range and reply kind', async () => {
  const first = reply => {
    reply.equity[0].time = barTime(S.warmup); reply.equity[0].partition = 'train';
    reply.decisions[0].time = barTime(S.warmup); reply.decisions[0].partition = 'train';
  };
  const last = reply => {
    const eq = reply.equity[reply.equity.length - 1], de = reply.decisions[reply.decisions.length - 1];
    eq.time = barTime(S.test_end - 1); eq.partition = 'test'; de.time = barTime(S.test_end - 1); de.partition = 'test';
  };
  const accepted = {
    'an equity and a decision row on the first bar after the warm-up (train)': first,
    'an equity and a decision row on the last bar (test)': last,
    'a trade that enters on the first bar after the warm-up': reply => { reply.trades[0].entry_time = barTime(S.warmup); },
    'a trade that enters and exits on the same bar': reply => { reply.trades[0].entry_time = reply.trades[0].exit_time; }};
  for (const [name, edit] of Object.entries(accepted)) {
    const reply = fakeReply();
    edit(reply);
    assert.ok((await reproduce(BASE_RUN, {reply: () => reply})).value, name);
  }
  const both = fakeReply();
  first(both); last(both);
  const edges = (await reproduce(BASE_RUN, {reply: () => both})).value.trace.equity.rows;
  assert.equal(edges[0][2], 'train');
  assert.equal(edges[edges.length - 1][2], 'test');
  const diverging = {
    'an equity row one minute before the warm-up end': reply => { reply.equity[0].time = barTime(S.warmup) - MINUTE; },
    'a decision one minute before the warm-up end': reply => { reply.decisions[0].time = barTime(S.warmup) - MINUTE; },
    'a decision one minute after the last bar': reply => { reply.decisions[reply.decisions.length - 1].time = barTime(S.test_end - 1) + MINUTE; },
    'a trade exit one minute after the last bar': reply => { reply.trades[reply.trades.length - 1].exit_time = barTime(S.test_end - 1) + MINUTE; },
    'a trade entry before the warm-up end': reply => { reply.trades[0].entry_time = barTime(S.warmup) - MINUTE; },
    'a trade entry after the last bar': reply => { reply.trades[0].entry_time = barTime(S.test_end - 1) + MINUTE; },
    'a trade that exits before it enters': reply => { reply.trades[0].entry_time = reply.trades[0].exit_time + MINUTE; },
    'a trade entry at time zero': reply => { reply.trades[0].entry_time = 0; },
    'a decision at time zero': reply => { reply.decisions[0].time = 0; },
    'a duplicate entry_ref with every count unchanged': reply => { reply.trades[0].entry_ref = reply.trades[1].entry_ref; },
    'two trades out of exit-time order': reply => { [reply.trades[0], reply.trades[1]] = [reply.trades[1], reply.trades[0]]; },
    'two decisions out of time order': reply => { [reply.decisions[0], reply.decisions[1]] = [reply.decisions[1], reply.decisions[0]]; },
    'a trade partition label that is not the exit partition': reply => { reply.trades[5].partition = 'train'; }};
  for (const [name, edit] of Object.entries(diverging)) {
    const reply = fakeReply();
    edit(reply);
    await refused(BASE_RUN, 'TRACE_REPRODUCTION_DIVERGED', {reply: () => reply, label: name});
  }
  const invalid = {
    'a negative trade entry time': reply => { reply.trades[0].entry_time = -1; },
    'a negative equity time': reply => { reply.equity[0].time = -1; },
    'an entry time past the year 9999 limit': reply => { reply.trades[0].entry_time = 253402300799999 + 1; },
    'a holdout result of kind CANDIDATE': reply => { reply.result.kind = 'CANDIDATE'; },
    'a holdout result of kind SENSITIVITY': reply => { reply.result.kind = 'SENSITIVITY'; },
    'a holdout result with no kind': reply => { delete reply.result.kind; },
    'a lower-case holdout kind': reply => { reply.result.kind = 'holdout'; }};
  for (const [name, edit] of Object.entries(invalid)) {
    const reply = fakeReply();
    edit(reply);
    await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {reply: () => reply, label: name});
  }
});

test('B6 a contract whose first bar is time zero is valid, and a row at time zero is before the warm-up end, so it diverges', async () => {
  const zeroRun = runWith(run => { run.contract.dataset.bars.forEach(bar => { bar.time -= T0; }); });
  assert.equal(zeroRun.contract.dataset.bars[0].time, 0);
  const shifted = () => {
    const reply = fakeReply();
    for (const row of [...reply.equity, ...reply.decisions]) row.time -= T0;
    for (const row of reply.trades) { row.entry_time -= T0; row.exit_time -= T0; }
    return reply;
  };
  const {value} = await reproduce(zeroRun, {reply: shifted});
  assert.equal(value.trace.equity.rows[0][0], barTime(5) - T0);
  const atZero = shifted();
  atZero.equity[0].time = 0;
  await refused(zeroRun, 'TRACE_REPRODUCTION_DIVERGED', {reply: () => atZero});
});

test('B8 recorded_at_ms 0 is the lowest value the column check allows, and the read side keeps a row with 0', async () => {
  const {value} = await reproduce();
  const files = renderPackage(SCENARIO(value.trace)).files;
  const rows = traceReproductionRecords(value, files, 0);
  assert.deepEqual(rows.map(row => row.recorded_at_ms), [0, 0, 0]);
  assert.equal(gateTraceReproduction(rows, BASE_RUN.contract).length, 3);
  assert.throws(() => traceReproductionRecords(value, files, -0.5), TypeError);
  assert.throws(() => traceReproductionRecords(value, files, Number.NaN), TypeError);
  assert.throws(() => traceReproductionRecords(value, files, '0'), TypeError);
});

/* ---------------- B7: result shape check pinned against the worker ---------------- */

async function workerStep(response, kind, parameters) {
  const worker = Object.create(QuantResearchWorker.prototype);
  worker.controller = {signal: new AbortController().signal};
  worker.clock = () => 1;
  worker.steps = async () => [];
  worker.engineHash = async () => ENGINE;
  worker.fenced = async (job, work) => work({evaluations_started: 0});
  worker.current = async () => {};
  worker.db = {prepare: () => ({run: async () => {}})};
  worker.evaluate = async () => response;
  return worker.step({contract: {engine_hash: ENGINE, max_evaluations: 99}, run_id: 'run-b7'}, 'step', kind, parameters);
}
const SHAPE_MUTATIONS = {
  'a result of another kind': result => { result.kind = 'SENSITIVITY'; },
  'other parameters': result => { result.parameters = {...SEL, rr: 1.25}; },
  'no train part': result => { delete result.train; },
  'no validation part': result => { delete result.validation; },
  'closed trades that are not an integer': result => { result.train.closed_trades = 1.5; },
  'negative closed trades': result => { result.validation.closed_trades = -1; },
  'a net return that is a boolean': result => { result.train.net_return_percent = true; },
  'a net return that is not a decimal': result => { result.train.net_return_percent = 'abc'; },
  'a negative drawdown': result => { result.validation.max_drawdown_percent = '-0.5'; },
  'a non-finite drawdown': result => { result.validation.max_drawdown_percent = Number.NaN; },
  'a missing drawdown': result => { delete result.train.max_drawdown_percent; }};

test('B7 the bad non-holdout responses the worker refuses are refused by the module with the same meaning; good ones pass both', async () => {
  const kind = 'STRESS';
  assert.deepEqual((await workerStep(fakeEval(kind, SEL), kind, SEL)).kind, kind, 'a good response passes the worker');
  const {value} = await reproduce(BASE_RUN, {evaluate: (contract, parameters, stepKind) => fakeEval(stepKind, parameters)});
  assert.ok(value);
  const mutations = {...SHAPE_MUTATIONS, 'a test part on a non-holdout step': result => { result.test = holdoutTest(); }};
  for (const [name, edit] of Object.entries(mutations)) {
    const bad = fakeEval(kind, SEL);
    edit(bad);
    await assert.rejects(() => workerStep(clone(bad), kind, SEL), undefined, 'worker: ' + name);
    // The module sees the same bad response on its cost-stress step (the last non-holdout step).
    await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {evaluate: (contract, parameters, stepKind) => stepKind === 'STRESS' ? clone(bad) : fakeEval(stepKind, parameters)});
  }
});

test('B7 the bad holdout responses the worker refuses are refused by the module', async () => {
  assert.equal((await workerStep(fakeEval('HOLDOUT', SEL), 'HOLDOUT', SEL)).kind, 'HOLDOUT');
  const mutations = {...SHAPE_MUTATIONS, 'no test part': result => { delete result.test; }, 'closed trades of the test part that are not an integer': result => { result.test.closed_trades = 'five'; },
    'a negative test drawdown': result => { result.test.max_drawdown_percent = '-1'; }};
  for (const [name, edit] of Object.entries(mutations)) {
    const bad = fakeEval('HOLDOUT', SEL);
    edit(bad);
    await assert.rejects(() => workerStep(clone(bad), 'HOLDOUT', SEL), undefined, 'worker: ' + name);
    const reply = fakeReply();
    reply.result = clone(bad);
    await refused(BASE_RUN, 'INVALID_EVALUATION_RESPONSE', {reply: () => reply});
  }
});

/* ---------------- B8: records ---------------- */

const SCENARIO = (() => {
  // A renderable one-Pine fixture around the reproduction, shaped like the package render test's scenario.
  const contract = clone(contractOf({owner: OWNER, bot: BOT, deployment: DEPLOY, importId: IMPORT, tag: 'render'}));
  Object.assign(contract, {version: OWNER_RECOMMENDATION_CONTRACT_VERSIONS[0], source: SOURCE, source_hash: hash(SOURCE), policy_version: 'policy-v1', acceptance_blockers: [...CANDIDATE_BLOCKERS]});
  contract.snapshot.policy = {max_daily_loss_percent: '3', equities: {'binance-global': '1000'}};
  contract.snapshot.membership = [{pine_import_id: IMPORT, source_version: 1, source_hash: contract.source_hash}];
  contract.input_lock.selection.bindings[0].source_span = {start: SPAN_START, end: SPAN_START + STATEMENT.length};
  const P = {atr_multiplier: 1.5, rr: 1, emaFastInput: 40};
  const evaluation = (kind, params, train, validation, part) => ({kind, parameters: params, train, validation, ...(part ? {test: part} : {})});
  const best = evaluation('CANDIDATE', P, metricsOf('4.1', 9), metricsOf('3.2', 8));
  const selected = {parameters: P, result: best, screen_reasons: [], sensitivity: [], cost_stress: evaluation('STRESS', P, metricsOf('3.5', 9), metricsOf('2.4', 8)), test: metricsOf('1.9', 9, '1.5')};
  const result = {scope: contract.scope, contract_hash: hash(canonical(contract)), input_lock_hash: contract.input_lock.lock_hash, dataset_hash: contract.dataset.sha256,
    search_algorithm: contract.plan.algorithm, seed: contract.plan.seed, budget: contract.plan.requested_budget, candidate_count: 6, selected_dimensions: 3, covered_dimensions: 3,
    dimension_coverage_percent: 100, candidates: [{parameters: P, result: best, screen_reasons: []}], selected, owner_recommendation_ready: false,
    acceptance_blockers: contract.acceptance_blockers, holdout_evaluated: true, completion_reason: 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'};
  const run = {owner_id: OWNER, bot_id: BOT, run_id: 'run-render-0001', status: 'SUCCEEDED', contract, contract_hash: hash(canonical(contract)), submission_hash: hex('submission-render'), result,
    created_at_utc: '2026-10-19T11:30:00Z', integrity: {contract_hash_verified: true, report_matches_checkpoints: true}};
  return trace => ({export_id: '9f1c2b7e-3d4a-4b5c-8d6e-0123456789ab', created_at: '2026-10-19T12:00:00Z', run, fixture: true, library_versions: clone(LIBRARY_VERSIONS),
    risk_limits: {max_daily_loss_percent: '3'}, trace, exit_version: 'bridge-exit-v2'});
})();

// B8 checks the record mapping only (paths, digests, hashes and column patterns) on a renderable fixture; the SCENARIO below is a separate render fixture, not the BASE_RUN contract.
test('B8 three records in TRACE_FILES order: sha256 of the rendered bytes, shared digests, every field inside the migration CHECK patterns', async () => {
  const {value} = await reproduce();
  const rendered = renderPackage(SCENARIO(value.trace));
  const rows = traceReproductionRecords(value, rendered.files, 1790000000000);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.path), [...TRACE_FILES]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['holdout_digest', 'path', 'recorded_at_ms', 'run_engine_hash', 'sha256', 'steps_digest', 'trace_engine_hash']);
    for (const key of ['sha256', 'steps_digest', 'holdout_digest', 'trace_engine_hash', 'run_engine_hash']) assert.match(row[key], HEX64, key);
    assert.ok(Number.isSafeInteger(row.recorded_at_ms) && row.recorded_at_ms >= 0 && row.recorded_at_ms <= 253402300799999);
    assert.equal(row.sha256, hash(rendered.files[row.path]), 'sha256 is over the rendered file bytes');
    assert.equal(row.steps_digest, value.steps_digest);
    assert.equal(row.holdout_digest, value.holdout_digest);
    assert.equal(row.run_engine_hash, ENGINE);
    assert.equal(row.trace_engine_hash, TRACE_HASH);
    assert.ok(Object.isFrozen(row));
  }
  const tableOf = {'quant-data/equity.csv': 'equity', 'quant-data/trades.csv': 'trades', 'quant-data/decisions.csv': 'decisions'};
  for (const row of rows) {
    assert.notEqual(row.sha256, hash(JSON.stringify(value.trace[tableOf[row.path]])), 'not a hash of the row data');
    assert.notEqual(row.sha256, hash(canonical(value.trace[tableOf[row.path]])));
  }
  assert.ok(Object.isFrozen(rows));
  // Bytes work as well as text.
  const asBytes = Object.fromEntries(Object.entries(rendered.files).map(([file, content]) => [file, Buffer.from(content, 'utf8')]));
  assert.deepEqual(traceReproductionRecords(value, asBytes, 5).map(row => row.sha256), rows.map(row => row.sha256));
});

test('B8 records refuse a missing file, a malformed reproduction and a recorded time outside the column check', async () => {
  const {value} = await reproduce();
  const files = renderPackage(SCENARIO(value.trace)).files;
  assert.throws(() => traceReproductionRecords(value, {...files, 'quant-data/trades.csv': undefined}, 1), TypeError);
  assert.throws(() => traceReproductionRecords({...value, steps_digest: 'abc'}, files, 1), TypeError);
  assert.throws(() => traceReproductionRecords(value, files, -1), TypeError);
  assert.throws(() => traceReproductionRecords(value, files, 253402300799999 + 1), TypeError);
  assert.throws(() => traceReproductionRecords(value, files, 1.5), TypeError);
  assert.equal(traceReproductionRecords(value, files, 253402300799999).length, 3);
});

/* ---------------- B9: partitions and rendering ---------------- */

test('B9 every row is labelled by bar time against the contract split; a trade takes the partition of its exit bar', async () => {
  const {value} = await reproduce();
  assert.deepEqual(TRACE_COLUMNS.equity, ['time_ms', 'time_utc', 'partition', 'event_type', 'cash', 'position_quantity', 'equity_at_fill']);
  assert.deepEqual(value.trace.equity.columns, [...TRACE_COLUMNS.equity]);
  assert.deepEqual(value.trace.trades.columns, [...TRACE_COLUMNS.trades]);
  assert.deepEqual(value.trace.decisions.columns, [...TRACE_COLUMNS.decisions]);
  const partitionOfRow = (rows, time) => rows.filter(row => row[0] === time).map(row => row[2]);
  const equity = value.trace.equity.rows;
  assert.deepEqual(partitionOfRow(equity, barTime(S.train_end - 1)), ['train'], 'last train bar');
  assert.deepEqual(partitionOfRow(equity, barTime(S.train_end)), ['validation'], 'first validation bar');
  assert.deepEqual(partitionOfRow(equity, barTime(S.validation_end - 1)), ['validation'], 'last validation bar');
  assert.deepEqual(partitionOfRow(equity, barTime(S.validation_end)), ['test'], 'first test bar');
  // The trade that enters on the last train bar and exits on the first validation bar is a validation trade.
  const crossing = value.trace.trades.rows.find(row => row[2] === barTime(S.train_end - 1));
  assert.equal(crossing[1], 'validation');
  assert.equal(crossing[7], barTime(S.train_end));
  const counts = name => value.trace.trades.rows.filter(row => row[1] === name).length;
  assert.deepEqual([counts('train'), counts('validation'), counts('test')], [5, 5, 5]);
  assert.equal(value.trace.trades.rows.length, 15, 'the entry still open at the end has no trade row');
  assert.equal(value.trace.equity.rows.length, 31);
  assert.equal(value.trace.decisions.rows.length, 33);
  assert.ok(value.trace.decisions.rows.some(row => row[5] === 'REJECTED' && row[8] === '0' && row[9] === null), 'a rejected decision has a null price');
  assert.ok(value.trace.decisions.rows.some(row => row[5] === 'FILLED' && row[6] === 'TP'));
  // No holdout row is dropped (open question OQ-1): test-partition rows are present and labelled.
  assert.ok(equity.some(row => row[2] === 'test') && value.trace.decisions.rows.some(row => row[2] === 'test') && value.trace.trades.rows.some(row => row[1] === 'test'));
  for (const row of equity) { assert.equal(row[1], new Date(row[0]).toISOString()); assert.ok(Number.isSafeInteger(row[0])); }
  for (const rows of [value.trace.equity.rows, value.trace.trades.rows, value.trace.decisions.rows])
    for (const row of rows) for (const cell of row) assert.ok(cell === null || typeof cell === 'string' || Number.isSafeInteger(cell));
});

test('B9 rendering the same reproduction twice gives the same three file digests, and the files carry the labelled rows', async () => {
  const {value} = await reproduce();
  const first = renderPackage(SCENARIO(value.trace)), second = renderPackage(SCENARIO(clone(value.trace)));
  for (const file of TRACE_FILES) assert.equal(hash(first.files[file]), hash(second.files[file]), file);
  assert.deepEqual(traceReproductionRecords(value, first.files, 1).map(row => row.sha256), traceReproductionRecords(value, second.files, 1).map(row => row.sha256));
  const trades = first.files['quant-data/trades.csv'].split('\n');
  assert.equal(trades[0], TRACE_COLUMNS.trades.join(','));
  assert.equal(trades.length, 15 + 2, 'header, fifteen rows and the closing line feed');
  assert.ok(trades.some(line => line.includes(',validation,' + barTime(S.train_end - 1) + ',')));
  assert.ok(first.files['quant-data/equity.csv'].split('\n')[0] === TRACE_COLUMNS.equity.join(','));
  assert.ok(first.files['quant-data/equity.csv'].includes(',0E-18,'), 'the engine decimal text is written as the engine printed it');
  assert.ok(first.files['quant-data/decisions.csv'].includes(',REJECTED,RISK_LIMIT,,0,,0\n'), 'a rejection leaves the sizing and price cells empty');
});

test('B9 the module has no clock and no writer: the same inputs give the same reproduction', async () => {
  const one = (await reproduce()).value, two = (await reproduce()).value;
  assert.equal(canonical(one), canonical(two));
});

/* ---------------- B11: read side ---------------- */

test('B11 gateTraceReproduction keeps good rows in TRACE_FILES order and drops others so C3 sees an absent record', async () => {
  const {value} = await reproduce();
  const rendered = renderPackage(SCENARIO(value.trace));
  const rows = [...traceReproductionRecords(value, rendered.files, 1)].reverse().map(row => ({export_id: 'e', ...row}));
  const mapped = gateTraceReproduction(rows, BASE_RUN.contract);
  assert.deepEqual(mapped.map(row => row.path), [...TRACE_FILES]);
  assert.deepEqual(Object.keys(mapped[0]), ['path', 'sha256', 'steps_digest', 'holdout_digest']);
  assert.deepEqual(mapped.map(row => row.sha256), TRACE_FILES.map(file => hash(rendered.files[file])));
  assert.ok(mapped.every(row => row.steps_digest === value.steps_digest && row.holdout_digest === value.holdout_digest));
  const pathsAfter = edit => gateTraceReproduction(edit(rows.map(row => ({...row}))), BASE_RUN.contract).map(row => row.path);
  const other = 'quant-data/trades.csv';
  assert.deepEqual(pathsAfter(list => { list.find(row => row.path === other).run_engine_hash = hex('another run engine'); return list; }), TRACE_FILES.filter(file => file !== other));
  assert.deepEqual(pathsAfter(list => { list.find(row => row.path === other).sha256 = 'ABC'; return list; }), TRACE_FILES.filter(file => file !== other));
  assert.deepEqual(pathsAfter(list => { list.find(row => row.path === other).holdout_digest = hex('x').toUpperCase(); return list; }), TRACE_FILES.filter(file => file !== other));
  assert.deepEqual(pathsAfter(list => { list.find(row => row.path === other).trace_engine_hash = null; return list; }), TRACE_FILES.filter(file => file !== other));
  assert.deepEqual(pathsAfter(list => { list.find(row => row.path === other).recorded_at_ms = -1; return list; }), TRACE_FILES.filter(file => file !== other));
  assert.deepEqual(pathsAfter(list => [...list, {...list.find(row => row.path === other), sha256: hex('second')}]), TRACE_FILES.filter(file => file !== other), 'a duplicate path drops both rows');
  assert.deepEqual(pathsAfter(list => [...list, {...list[0], path: 'quant-data/other.csv'}]), [...TRACE_FILES]);
  assert.deepEqual(pathsAfter(list => [null, 5, 'x', ...list]), [...TRACE_FILES]);
  assert.deepEqual([...gateTraceReproduction(rows, {...BASE_RUN.contract, engine_hash: 'not a digest'})], []);
  assert.deepEqual([...gateTraceReproduction(rows, null)], []);
  assert.deepEqual([...gateTraceReproduction(null, BASE_RUN.contract)], []);
  assert.ok(Object.isFrozen(mapped));
});

/* ---------------- B1 / B11 against the real C3 gate ---------------- */

/** The rendered package of a stored run and the C3 subject around it, with the given reproduction records. */
function c3Subject(storedRun, trace, recordRows) {
  const run = {...clone(storedRun), submission_hash: hex('submission-trace')};
  const rendered = renderPackage({export_id: '9f1c2b7e-3d4a-4b5c-8d6e-0123456789ab', created_at: '2026-10-19T12:00:00Z', run, fixture: true, library_versions: clone(LIBRARY_VERSIONS),
    risk_limits: {max_daily_loss_percent: '3'}, trace, exit_version: 'bridge-exit-v2'});
  const contract = run.contract;
  const metadata = {version: 'spot-dataset-v1', venue: 'binance-global', market: 'SPOT', symbol: 'BTCUSDT', timeframe: '1', start_time: contract.dataset.start_time,
    end_time: contract.dataset.end_time + MINUTE, warmup_bars: contract.dataset.warmup_bars, total_bars: contract.dataset.bar_count, cutoff: contract.dataset.end_time + MINUTE, source: 'binance-spot-klines-v1'};
  return {rendered, subject: {run, export: {library_versions: clone(LIBRARY_VERSIONS)}, files: {...rendered.files}, hard_limits: {max_daily_loss_percent: {max: '5'}}, deployment: {exit_version: 'bridge-exit-v2'},
    dataset: {readable: true, digest: contract.dataset.sha256, metadata}, fixture_request: true, trace_reproduction: recordRows(rendered.files)}};
}
const c3Codes = subject => [...evaluateProvenance(subject).codes];

test('B1 the C3 gate passes the package of the model run when the trace records carry the recomputed digests and the file digests', async () => {
  const {value} = await reproduce();
  const {subject} = c3Subject(BASE_RUN, value.trace, files => gateTraceReproduction(traceReproductionRecords(value, files, 1), BASE_RUN.contract));
  assert.deepEqual(c3Codes(subject), []);
});

test('B1/B11 C3 reports BI_RESULT_MISMATCH for a stored step that was tampered, HOLDOUT_MISMATCH for a tampered holdout, and both for an absent record', async () => {
  const {value} = await reproduce();
  const records = files => gateTraceReproduction(traceReproductionRecords(value, files, 1), BASE_RUN.contract);
  const stepsTampered = clone(BASE_RUN);
  stepsTampered.result.selected.sensitivity[0].result.validation.net_return_percent = '3.1';
  assert.deepEqual(c3Codes(c3Subject(stepsTampered, value.trace, records).subject), ['BI_RESULT_MISMATCH']);
  const holdoutTampered = clone(BASE_RUN);
  holdoutTampered.result.selected.test.net_return_percent = '2.9';
  assert.deepEqual(c3Codes(c3Subject(holdoutTampered, value.trace, records).subject), ['HOLDOUT_MISMATCH']);
  // Rows dropped by the read side leave C3 with an absent record.
  const otherEngine = files => gateTraceReproduction(traceReproductionRecords(value, files, 1).map((row, index) => index === 1 ? {...row, run_engine_hash: hex('another run engine')} : row), BASE_RUN.contract);
  assert.deepEqual(c3Codes(c3Subject(BASE_RUN, value.trace, otherEngine).subject), ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH']);
  const duplicated = files => gateTraceReproduction([...traceReproductionRecords(value, files, 1), ...traceReproductionRecords(value, files, 2).slice(0, 1)], BASE_RUN.contract);
  assert.deepEqual(c3Codes(c3Subject(BASE_RUN, value.trace, duplicated).subject), ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH']);
  // A file that changed after the record was made no longer matches its sha256.
  const stale = files => gateTraceReproduction(traceReproductionRecords(value, {...files, 'quant-data/trades.csv': files['quant-data/trades.csv'] + ' '}, 1), BASE_RUN.contract);
  assert.deepEqual(c3Codes(c3Subject(BASE_RUN, value.trace, stale).subject), ['BI_RESULT_MISMATCH']);
});

/* ---------------- closure and defaults ---------------- */

async function pythonClosure(roots) {
  const visited = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const source = await fs.readFile('quant_lab/src/robot_quant/' + name + '.py', 'utf8');
    for (const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant\.)([A-Za-z_][A-Za-z_0-9]*)\s+import\b/gm)) await visit(match[1]);
    for (const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant)\s+import\s+([A-Za-z_][A-Za-z_0-9, ]*)/gm)) {
      for (const imported of match[1].split(',').map(item => item.trim()).filter(Boolean)) {
        const exists = await fs.access('quant_lab/src/robot_quant/' + imported + '.py').then(() => true, () => false);
        if (exists) await visit(imported);
      }
    }
    for (const match of source.matchAll(/^\s*import\s+robot_quant\.([A-Za-z_][A-Za-z_0-9]*)/gm)) await visit(match[1]);
  }
  for (const name of roots) await visit(name);
  return visited;
}
const OWN_FILES = ['src/quant-library/trace-reproduction.js', 'quant_lab/src/robot_quant/trace_reproduction.py'];

test('the trace closure is sorted, unique, frozen and present, and holds the driver Python import closure, the legacy run closure and both S3 files', async () => {
  assert.equal(TRACE_REPRODUCTION_CLOSURE_VERSION, 'trace-reproduction-closure-v1');
  assert.deepEqual([...TRACE_REPRODUCTION_FILES], [...TRACE_REPRODUCTION_FILES].sort());
  assert.equal(TRACE_REPRODUCTION_FILES.length, new Set(TRACE_REPRODUCTION_FILES).size);
  assert.ok(Object.isFrozen(TRACE_REPRODUCTION_FILES));
  for (const file of TRACE_REPRODUCTION_FILES) await fs.access(file);
  const listed = new Set(TRACE_REPRODUCTION_FILES);
  for (const file of OWN_FILES) assert.ok(listed.has(file), file);
  // money.js and source.js compute every digest and decide which decimals are accepted. package-gates.js is the judge and stays out on purpose.
  assert.ok(listed.has('src/money.js') && listed.has('src/pine-bridge/source.js'));
  assert.ok(!listed.has('src/quant-library/package-gates.js'));
  for (const file of LEGACY_ENGINE_FILES) assert.ok(listed.has(file), 'legacy run closure entry ' + file);
  const modules = await pythonClosure(['__init__', 'trace_reproduction']);
  assert.ok(modules.has('research_engine') && modules.has('bridge_paper') && modules.has('ql3a') && modules.has('analytics') && modules.has('contracts'));
  assert.ok(modules.size > 10, 'traversal must reach the engine modules');
  for (const name of modules) assert.ok(listed.has('quant_lab/src/robot_quant/' + name + '.py'), 'unhashed Python dependency ' + name);
  // The driver imports exactly these two project modules directly; a new import must come with a closure entry.
  const driver = await fs.readFile('quant_lab/src/robot_quant/trace_reproduction.py', 'utf8');
  assert.deepEqual([...driver.matchAll(/^from robot_quant(?:\.| import )(\w+)/gm)].map(match => match[1]).sort(), ['analytics', 'research_engine']);
});

test('the trace closure files are in no existing engine closure list, and no existing list gained or lost an entry because of them', () => {
  const lists = {LEGACY: LEGACY_ENGINE_FILES, FOUNDATION: FOUNDATION_ENGINE_FILES, INGESTION: INGESTION_ENGINE_FILES, PF2_engine: PF2_ENGINE_FILES, PF2_evaluator: PF2_EVALUATOR_FILES,
    runtime_manifest: QUANT_RUNTIME_ENGINE_FILES, FE2a: FIXED_EVAL_ENGINE_FILES};
  for (const [name, files] of Object.entries(lists)) for (const file of OWN_FILES) assert.ok(!files.includes(file), file + ' is in ' + name);
});

test('the trace engine hash is hash(canonical({version, files})) over the raw bytes, and one changed byte or one unreadable file changes or stops it', async () => {
  const files = await Promise.all(TRACE_REPRODUCTION_FILES.map(async name => [name, hash(await fs.readFile(name))]));
  const expected = hash(canonical({version: TRACE_REPRODUCTION_CLOSURE_VERSION, files: Object.fromEntries(files)}));
  assert.equal(await traceReproductionEngineHash(), expected);
  assert.match(expected, HEX64);
  const target = 'quant_lab/src/robot_quant/trace_reproduction.py';
  const changed = await traceReproductionEngineHash(async url => {
    const bytes = Buffer.from(await fs.readFile(url));
    return url.pathname.endsWith('/' + target) ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;
  });
  assert.notEqual(changed, expected);
  const changedNode = await traceReproductionEngineHash(async url => {
    const bytes = Buffer.from(await fs.readFile(url));
    return url.pathname.endsWith('/src/quant-library/trace-reproduction.js') ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes;
  });
  assert.notEqual(changedNode, expected);
  await assert.rejects(() => traceReproductionEngineHash(async url => { if (url.pathname.endsWith('/analytics.py')) throw new Error('missing'); return fs.readFile(url); }), /missing/);
  // A reproduction takes this hash from the default port when no override is injected.
  const made = makePorts();
  delete made.ports.traceEngineHash;
  assert.equal((await reproduceRun({run: BASE_RUN, ports: made.ports})).trace_engine_hash, expected);
  // A changed money.js or source.js changes the hash: both are bound.
  for (const name of ['/src/money.js', '/src/pine-bridge/source.js']) {
    const other = await traceReproductionEngineHash(async url => { const bytes = Buffer.from(await fs.readFile(url)); return url.pathname.endsWith(name) ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes; });
    assert.notEqual(other, expected, name);
  }
});

test('defaultPorts uses the legacy evaluation call, a driver spawner and the live legacy closure hash', async () => {
  const ports = defaultPorts();
  assert.equal(typeof ports.evaluate, 'function');
  assert.equal(typeof ports.traceEvaluate, 'function');
  assert.match(await ports.engineHash(), HEX64);
  assert.deepEqual(Object.keys(ports).sort(), ['engineHash', 'evaluate', 'traceEvaluate']);
  assert.equal(DRIVER_REQUEST_LIMIT, 8 * 1024 * 1024);
  assert.equal(DRIVER_REPLY_LIMIT, 16 * 1024 * 1024);
});

test('defaultPorts resolves one interpreter for both calls, forwards only python and timeoutMs, and never uses a bare python', async () => {
  const saved = process.env.QUANT_RESEARCH_PYTHON;
  try {
    delete process.env.QUANT_RESEARCH_PYTHON;
    const missing = path.join(STUB_DIR, 'no-such-interpreter');
    const ports = defaultPorts({python: missing, timeoutMs: 5000, args: ['-c', 'x'], cwd: '/', env: {DATABASE_URL: 'x'}});
    // The one resolved interpreter serves both calls (both fail to start it); the unknown options are ignored.
    await stubCode(ports.traceEvaluate({}, {}, undefined), 'QUANT_PYTHON_UNAVAILABLE');
    await stubCode(ports.evaluate({dataset: {bars: []}, split: {validation_end: 0}}, {}, 'CANDIDATE', undefined), 'QUANT_PYTHON_UNAVAILABLE');
  } finally {
    if (saved === undefined) delete process.env.QUANT_RESEARCH_PYTHON; else process.env.QUANT_RESEARCH_PYTHON = saved;
  }
  assert.equal(resolveInterpreter({python: 'explicit', env: {QUANT_RESEARCH_PYTHON: 'env'}, venv: 'venv', exists: () => true}), 'explicit');
  assert.equal(resolveInterpreter({env: {QUANT_RESEARCH_PYTHON: 'env'}, venv: 'venv', exists: () => true}), 'env');
  assert.equal(resolveInterpreter({env: {}, venv: 'venv', exists: file => file === 'venv'}), 'venv');
  assert.equal(resolveInterpreter({env: {}, venv: 'venv', exists: () => false}), null, 'no PATH fallback');
  // Like the F11 runner: ?? not ||, so an empty explicit value is kept (and is then no usable interpreter) instead of falling through to the venv.
  assert.equal(resolveInterpreter({env: {QUANT_RESEARCH_PYTHON: ''}, venv: 'venv', exists: () => true}), '');
  assert.equal(resolveInterpreter({python: '', env: {QUANT_RESEARCH_PYTHON: 'env'}, venv: 'venv', exists: () => true}), '');
});

test('defaultPorts with no usable interpreter rejects both calls with QUANT_PYTHON_UNAVAILABLE and never re-resolves one', async () => {
  const ports = defaultPorts({python: ''});
  await stubCode(ports.traceEvaluate({}, {}, undefined), 'QUANT_PYTHON_UNAVAILABLE');
  await stubCode(ports.evaluate({dataset: {bars: []}, split: {validation_end: 0}}, {}, 'CANDIDATE', undefined), 'QUANT_PYTHON_UNAVAILABLE');
});

test('defaultPorts does not forward args, cwd or env: the child runs the fixed -P driver list (a node binary refuses -P, a forwarded stub would reply)', async () => {
  const ports = defaultPorts({python: process.execPath, timeoutMs: 20000, args: [STUB, 'env'], cwd: STUB_DIR, env: {SECRET_TOKEN: 's'}});
  // Forwarded args would run the stub and resolve with its environment report; the fixed list makes node fail on its own bad option -P.
  await stubCode(ports.traceEvaluate({}, {}, undefined), 'EVALUATION_FAILED');
});

test('driverEvaluation ignores cwd and env options and spawns the fixed environment from the repository root; the stub reports its own argument list', async () => {
  const marker = path.join(STUB_DIR, 'marker-argv');
  const seen = await driverEvaluation({}, {}, undefined, {python: process.execPath, args: [STUB, 'env', marker], timeoutMs: 20000, cwd: STUB_DIR, env: {SECRET_TOKEN: 's', DATABASE_URL: 'x'}});
  assert.deepEqual(seen.argv, ['env', marker], 'the argument list the spawner passed (after the script path)');
  assert.equal(path.resolve(seen.cwd), path.resolve(repoRoot));
  assert.ok(!seen.names.includes('SECRET_TOKEN') && !seen.names.includes('DATABASE_URL'));
  assert.equal(seen.pythonpath, path.join(repoRoot, 'quant_lab/src'));
});

test('B10 a synchronous spawn failure (a NUL byte in the interpreter string) is a coded QUANT_PYTHON_UNAVAILABLE, not a raw error', async () => {
  await stubCode(driverEvaluation({}, {}, undefined, {python: 'bad\0interpreter', args: [], timeoutMs: 5000}), 'QUANT_PYTHON_UNAVAILABLE');
});

test('ports and run are required: a missing port is a caller error, not a coded refusal', async () => {
  await assert.rejects(() => reproduceRun({run: BASE_RUN, ports: {evaluate() {}, traceEvaluate() {}}}), TypeError);
  await assert.rejects(() => reproduceRun({run: BASE_RUN}), TypeError);
  await refused(null, 'BI_PROVENANCE_UNRESOLVED');
  await refused({}, 'BI_PROVENANCE_UNRESOLVED');
});

/* ---------------- B10: the driver spawner against a stub ---------------- */

const STUB_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-reproduction-stub-'));
const STUB = path.join(STUB_DIR, 'stub-driver.mjs');
await fs.writeFile(STUB, `
import fs from 'node:fs';
const mode = process.argv[2], marker = process.argv[3];
if (marker) fs.writeFileSync(marker, 'ran');
process.stdout.on('error', () => {});
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = Buffer.concat(chunks).toString('utf8');
  if (mode === 'ok') { const body = JSON.parse(request); process.stdout.write(JSON.stringify({keys: Object.keys(body), parameters: body.parameters, contract: body.contract})); return; }
  if (mode === 'noisy') { process.stderr.write('SECRET /private/path Traceback'); process.stdout.write(JSON.stringify({noisy: true})); return; }
  if (mode === 'exit1') process.exit(1);
  if (mode === 'diverged') { process.stdout.write('{"error":"TRACE_REPRODUCTION_DIVERGED"}'); process.exit(1); }
  if (mode === 'failed') { process.stdout.write('{"error":"RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}'); process.exit(1); }
  if (mode === 'badjson') { process.stdout.write('not json'); return; }
  if (mode === 'errorok') { process.stdout.write('{"error":"X"}'); return; }
  if (mode === 'big') { const piece = Buffer.alloc(1024 * 1024, 97); for (let i = 0; i < 17; i++) process.stdout.write(piece); return; }
  if (mode === 'sleep') { setInterval(() => {}, 1000); return; }
  if (mode === 'ignoreterm') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  if (mode === 'env') { process.stdout.write(JSON.stringify({names: Object.keys(process.env), pythonpath: process.env.PYTHONPATH, hashseed: process.env.PYTHONHASHSEED, cwd: process.cwd(), argv: process.argv.slice(2)})); return; }
  if (mode === 'len') { process.stdout.write(JSON.stringify({bytes: Buffer.byteLength(request)})); return; }
  if (mode.startsWith('size:')) {
    const total = Number(mode.slice(5)), head = '{"p":"', tail = '"}';
    let left = total - head.length - tail.length;
    process.stdout.write(head);
    const piece = Buffer.alloc(1024 * 1024, 97);
    while (left > 0) { const n = Math.min(left, piece.length); process.stdout.write(piece.subarray(0, n)); left -= n; }
    process.stdout.write(tail);
    return;
  }
});
`);
test.after(() => fs.rm(STUB_DIR, {recursive: true, force: true}));

const viaStub = (mode, {contract = {c: 1}, parameters = {p: 2}, signal, timeoutMs = 20000, extra = []} = {}) =>
  driverEvaluation(contract, parameters, signal, {python: process.execPath, args: [STUB, mode, ...extra], timeoutMs});
const stubCode = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code); return true; });

test('B10 the spawner sends exactly {contract, parameters} and returns the one JSON object the driver prints', async () => {
  const reply = await viaStub('ok', {contract: {bars: [1, 2]}, parameters: {rr: 1}});
  assert.deepEqual(reply.keys, ['contract', 'parameters']);
  assert.deepEqual(reply.parameters, {rr: 1});
  assert.deepEqual(reply.contract, {bars: [1, 2]});
  assert.deepEqual(await viaStub('noisy'), {noisy: true}, 'stderr is discarded');
});

test('B10 driver failures map to the module codes: exit 1, the diverged reply, an engine refusal, bad JSON and an error object on exit 0', async () => {
  await stubCode(viaStub('exit1'), 'EVALUATION_FAILED');
  await stubCode(viaStub('diverged'), 'TRACE_REPRODUCTION_DIVERGED');
  await stubCode(viaStub('failed'), 'EVALUATION_FAILED');
  await stubCode(viaStub('badjson'), 'INVALID_EVALUATION_RESPONSE');
  await stubCode(viaStub('errorok'), 'INVALID_EVALUATION_RESPONSE');
});

test('B10 a reply above 16 MiB is cut off with EVALUATION_OUTPUT_TOO_LARGE', async () => {
  await stubCode(viaStub('big'), 'EVALUATION_OUTPUT_TOO_LARGE');
});

test('B10 a reply of exactly 16 MiB is accepted and one byte more is cut off', async () => {
  const exact = await viaStub('size:' + DRIVER_REPLY_LIMIT);
  assert.equal(exact.p.length, DRIVER_REPLY_LIMIT - 8);
  await stubCode(viaStub('size:' + (DRIVER_REPLY_LIMIT + 1)), 'EVALUATION_OUTPUT_TOO_LARGE');
});

test('B10 a driver that sleeps past the timeout is killed with EVALUATION_TIMED_OUT', async () => {
  await stubCode(viaStub('sleep', {timeoutMs: 400}), 'EVALUATION_TIMED_OUT');
});

test('B10 an abort signal, even one already aborted, kills the driver with RESEARCH_INTERRUPTED', async () => {
  const controller = new AbortController();
  const pending = viaStub('sleep', {signal: controller.signal});
  setTimeout(() => controller.abort(), 200);
  await stubCode(pending, 'RESEARCH_INTERRUPTED');
  const before = new AbortController();
  before.abort();
  await stubCode(viaStub('sleep', {signal: before.signal}), 'RESEARCH_INTERRUPTED');
});

test('B10 a request of exactly 8 MiB is sent whole and a request one byte over is refused before any process starts', async () => {
  const overhead = Buffer.byteLength(JSON.stringify({contract: {pad: ''}, parameters: {}}));
  const exact = await driverEvaluation({pad: 'x'.repeat(DRIVER_REQUEST_LIMIT - overhead)}, {}, undefined, {python: process.execPath, args: [STUB, 'len'], timeoutMs: 20000});
  assert.equal(exact.bytes, DRIVER_REQUEST_LIMIT);
  const marker = path.join(STUB_DIR, 'marker-over');
  await stubCode(driverEvaluation({pad: 'x'.repeat(DRIVER_REQUEST_LIMIT - overhead + 1)}, {}, undefined, {python: process.execPath, args: [STUB, 'len', marker], timeoutMs: 20000}), 'RESEARCH_REQUEST_TOO_LARGE');
  await assert.rejects(() => fs.access(marker), 'the stub never ran');
});

test('B10 a request above 8 MiB is refused before any process starts', async () => {
  const marker = path.join(STUB_DIR, 'marker-large');
  await stubCode(viaStub('ok', {contract: {pad: 'x'.repeat(DRIVER_REQUEST_LIMIT + 1)}, extra: [marker]}), 'RESEARCH_REQUEST_TOO_LARGE');
  await assert.rejects(() => fs.access(marker), 'the stub never ran');
  const ranMarker = path.join(STUB_DIR, 'marker-small');
  await viaStub('ok', {extra: [ranMarker]});
  await fs.access(ranMarker);
});

test('B10 the child gets a minimal environment, the repository root as working directory and the -P argument list', async () => {
  const saved = {DATABASE_URL: process.env.DATABASE_URL, PYTHONSTARTUP: process.env.PYTHONSTARTUP, PYTHONHOME: process.env.PYTHONHOME, MP_FIXTURE_DATABASE_URL: process.env.MP_FIXTURE_DATABASE_URL, SECRET_TOKEN: process.env.SECRET_TOKEN};
  Object.assign(process.env, {DATABASE_URL: 'postgres://user:pw@host/db', PYTHONSTARTUP: '/x.py', PYTHONHOME: '/h', MP_FIXTURE_DATABASE_URL: 'postgres://y', SECRET_TOKEN: 's'});
  try {
    const seen = await viaStub('env');
    for (const name of Object.keys(saved)) assert.ok(!seen.names.includes(name), name + ' must not reach the child');
    assert.ok(!seen.names.some(name => /^PYTHON/i.test(name) && !['PYTHONPATH', 'PYTHONHASHSEED'].includes(name)));
    assert.equal(seen.pythonpath, path.join(repoRoot, 'quant_lab/src'));
    assert.equal(seen.hashseed, '0');
    assert.equal(path.resolve(seen.cwd), path.resolve(repoRoot));
    // Everything beyond PATH, LANG, LC_ALL and the two PYTHON variables is what the operating system itself adds to a child (Windows system variables).
    const extra = seen.names.filter(name => !['PATH', 'Path', 'LANG', 'LC_ALL', 'PYTHONPATH', 'PYTHONHASHSEED'].includes(name));
    if (process.platform !== 'win32') assert.deepEqual(extra, []);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  assert.deepEqual([...DRIVER_ARGS], ['-P', '-m', 'robot_quant.trace_reproduction']);
});

test('B10 a driver that ignores the first kill is killed with SIGKILL after the grace period', { skip: process.platform === 'win32' ? 'Windows kill is already forceful' : false, timeout: 15000 }, async () => {
  const started = Date.now();
  await stubCode(driverEvaluation({}, {}, undefined, {python: process.execPath, args: [STUB, 'ignoreterm'], timeoutMs: 300, killGraceMs: 300}), 'EVALUATION_TIMED_OUT');
  assert.ok(Date.now() - started < 10000);
});

test('B10 an interpreter that cannot start is QUANT_PYTHON_UNAVAILABLE', async () => {
  await stubCode(driverEvaluation({}, {}, undefined, {python: path.join(STUB_DIR, 'no-such-interpreter'), args: [], timeoutMs: 5000}), 'QUANT_PYTHON_UNAVAILABLE');
});

test('B10 the spawner feeds reproduceRun end to end through the stub as the holdout port', async () => {
  const reply = fakeReply();
  const replyFile = path.join(STUB_DIR, 'reply.json');
  await fs.writeFile(replyFile, JSON.stringify(reply));
  const replayStub = path.join(STUB_DIR, 'replay-driver.mjs');
  await fs.writeFile(replayStub, `import fs from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8')));`);
  const made = makePorts();
  made.ports.traceEvaluate = (contract, parameters, signal) => driverEvaluation(contract, parameters, signal, {python: process.execPath, args: [replayStub], timeoutMs: 20000});
  const value = await reproduceRun({run: BASE_RUN, ports: made.ports});
  assert.equal(value.holdout_digest, STORED.holdout);
  assert.equal(value.steps_digest, STORED.steps);
});

const REAL_PYTHON = resolveInterpreter();
test('the real driver refuses a contract it cannot evaluate (skipped when no interpreter resolves: no bare python from PATH is ever used)',
  {skip: REAL_PYTHON ? false : 'no interpreter: QUANT_RESEARCH_PYTHON is unset and quant_lab/.venv is absent'}, async () => {
    await stubCode(driverEvaluation({version: 'none'}, {}, undefined, {timeoutMs: 20000}), 'EVALUATION_FAILED');
  });
