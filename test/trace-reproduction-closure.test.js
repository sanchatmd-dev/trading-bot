import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonical, hash} from '../src/pine-bridge/source.js';
import {QuantResearchWorker} from '../src/postgres/quant-research-worker.js';
import {LEGACY_ENGINE_FILES, FOUNDATION_ENGINE_FILES, engineHash} from '../src/postgres/quant-research.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {FIXED_EVAL_ENGINE_FILES} from '../src/postgres/quant-fixed-eval-engine.js';
import {PF2_ENGINE_FILES, PF2_EVALUATOR_FILES} from '../src/quant-research/preflight-resolver.js';
import {INGESTION_ENGINE_FILES} from '../src/postgres/quant-data.js';
import {MP_COMBINED_ENGINE_FILES} from '../src/multi-pine/engine-closure.js';
import {LIBRARY_VERSIONS} from '../src/quant-library/derive.js';
import {TRACE_FILES, CANDIDATE_BLOCKERS, OWNER_RECOMMENDATION_CONTRACT_VERSIONS, MULTI_PINE_CONTRACT_VERSION, evaluateProvenance} from '../src/quant-library/package-gates.js';
import {renderPackage} from '../src/quant-library/package-render.js';
import {
  TRACE_EXECUTION_PROFILES, TRACE_PROFILE_DEFERRED, TRACE_REPRODUCTION_CLOSURE_VERSION, TRACE_REPRODUCTION_FILES,
  driverEvaluation, gateTraceReproduction, reproduceRun, resolveInterpreter, traceReproductionEngineHash, traceReproductionRecords
} from '../src/quant-library/trace-reproduction.js';
import {contractOf, hex, MINUTE, T0} from './helpers/quant-library-fixture.mjs';

/*
 * F09 builder S3c acceptance, closure side (docs/design/f09-trace-repro/JUDGEMENT.md section 7, tests C1, C2 and the R-CV1 tripwire C5).
 * The PostgreSQL side (C3, C4) is test/postgres/bi-trace-reproduction.test.mjs.
 *
 *   C1  the trace closure: the S3-owned files sit in no other closure list, the list equals the driver import closure plus the named Node files,
 *       one changed byte or one dropped file rotates the hash, and engine hashes match the authorized candidate pins.
 *       Node only, so it runs in the CI unit jobs. The hash is computed at test time from the checked-out bytes (CRLF or LF alike); only the
 *       pinned engine hashes of C1 normalise line ends, because those literals must hold on a CRLF Windows tree and on the LF CI tree.
 *   C2  a real driver and real engine end to end on a worker-produced v1 fixture run. LABEL: C3 evidence on a v1 fixture run, not B0 or build evidence.
 *       Runs only where an interpreter resolves (QUANT_RESEARCH_PYTHON, else quant_lab/.venv; never a bare python from PATH) and skips with a reason elsewhere.
 *   C5  classification coverage of every G7-listed version and the multi-Pine version (root ruling R-CV1).
 *
 * Every run here is a LABELLED ENGINEERING FIXTURE: synthetic bars, never a research result, never a recommendation.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = value => JSON.parse(JSON.stringify(value));
const HEX64 = /^[0-9a-f]{64}$/;
const read = file => fs.readFile(path.join(repoRoot, file));

/* ---------------- closure helpers (the pattern of test/fixed-eval-engine.test.js) ---------------- */

const PY_DIR = 'quant_lab/src/robot_quant/';
async function pythonClosure(roots) {
  const visited = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const source = await fs.readFile(path.join(repoRoot, PY_DIR + name + '.py'), 'utf8');
    for (const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant\.)([A-Za-z_][A-Za-z_0-9]*)\s+import\b/gm)) await visit(match[1]);
    for (const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant)\s+import\s+([A-Za-z_][A-Za-z_0-9, ]*)/gm)) {
      for (const imported of match[1].split(',').map(item => item.trim()).filter(Boolean)) {
        const exists = await fs.access(path.join(repoRoot, PY_DIR + imported + '.py')).then(() => true, () => false);
        if (exists) await visit(imported);
      }
    }
    for (const match of source.matchAll(/^\s*import\s+robot_quant\.([A-Za-z_][A-Za-z_0-9]*)/gm)) await visit(match[1]);
  }
  for (const name of roots) await visit(name);
  return visited;
}
const nodeImports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;

const S3_OWNED_FILES = ['quant_lab/src/robot_quant/trace_reproduction.py', 'src/quant-library/trace-reproduction.js'];
/** The existing closure lists. LEGACY is the only one TRACE_REPRODUCTION_FILES contains on purpose; it is checked as a subset below. */
const EXISTING_CLOSURES = () => ({
  LEGACY: LEGACY_ENGINE_FILES, FOUNDATION: FOUNDATION_ENGINE_FILES, INGESTION: INGESTION_ENGINE_FILES, PF2_engine: PF2_ENGINE_FILES, PF2_evaluator: PF2_EVALUATOR_FILES,
  runtime_manifest: QUANT_RUNTIME_ENGINE_FILES, FIXED_EVAL: FIXED_EVAL_ENGINE_FILES, MP_COMBINED: MP_COMBINED_ENGINE_FILES});
/** The offending (list, file) pairs. Pure, so a test can run it over a mutated copy (mutant M16). */
const ownedFilesInLists = (lists, files = S3_OWNED_FILES) => Object.entries(lists).flatMap(([name, list]) => files.filter(file => list.includes(file)).map(file => name + ':' + file));

/* The closure hash formula of src/postgres/quant-research.js engineHash, over LF-normalised bytes (see the header). */
const lfHash = async files => hash(canonical(Object.fromEntries(await Promise.all(files.map(async name => [name, hash(Buffer.from((await read(name)).toString('latin1').replaceAll('\r\n', '\n'), 'latin1'))])))));

/* ================================ C1: the trace closure ================================ */

test('C1 the S3-owned files are in no existing closure list; the existing lists and the S3 list are sorted, unique and present', async () => {
  const lists = EXISTING_CLOSURES();
  assert.deepEqual(ownedFilesInLists(lists), [], 'an S3-owned file leaked into an existing closure list');
  for (const file of S3_OWNED_FILES) assert.ok(TRACE_REPRODUCTION_FILES.includes(file), file + ' is part of the trace closure');
  assert.equal(TRACE_REPRODUCTION_FILES.length, new Set(TRACE_REPRODUCTION_FILES).size);
  assert.deepEqual([...TRACE_REPRODUCTION_FILES], [...TRACE_REPRODUCTION_FILES].sort());
  assert.ok(Object.isFrozen(TRACE_REPRODUCTION_FILES));
  for (const file of TRACE_REPRODUCTION_FILES) await fs.access(path.join(repoRoot, file));
  assert.equal(TRACE_REPRODUCTION_CLOSURE_VERSION, 'trace-reproduction-closure-v1');
  // The trace closure holds the whole legacy run closure, so a legacy edit rotates the trace hash too.
  for (const file of LEGACY_ENGINE_FILES) assert.ok(TRACE_REPRODUCTION_FILES.includes(file), 'legacy file missing from the trace closure: ' + file);
});

test('C1 mutant M16: the disjointness check turns red when an S3-owned file is added to any existing closure list', () => {
  const lists = EXISTING_CLOSURES();
  assert.deepEqual(ownedFilesInLists(lists), []);
  for (const name of Object.keys(lists)) {
    for (const file of S3_OWNED_FILES) {
      const mutated = {...lists, [name]: [...lists[name], file]};
      assert.deepEqual(ownedFilesInLists(mutated), [name + ':' + file], name + ' + ' + file);
    }
  }
});

test('C1 TRACE_REPRODUCTION_FILES is exactly the driver Python import closure plus the named Node files', async () => {
  const driver = await pythonClosure(['__init__', 'trace_reproduction']);
  assert.ok(driver.has('trace_reproduction') && driver.has('research_engine') && driver.has('bridge_paper') && driver.has('ql3a') && driver.has('spt_custom_evaluator'));
  assert.ok(driver.size > 12, 'the traversal must reach the engine modules');
  const python = TRACE_REPRODUCTION_FILES.filter(file => file.endsWith('.py'));
  assert.deepEqual(python, [...driver].map(name => PY_DIR + name + '.py').sort(), 'the Python part of the list is the traversed driver closure, no more and no less');
  // The Node files, named here on purpose: this module and the driver spawner, the digest and decimal support, the legacy run closure (worker and contract).
  const NAMED_NODE = ['src/money.js', 'src/pine-bridge/source.js', 'src/postgres/quant-research-worker.js', 'src/quant-library/trace-reproduction.js', 'src/quant-research/contract.js'];
  assert.deepEqual(TRACE_REPRODUCTION_FILES.filter(file => !file.endsWith('.py')), NAMED_NODE);
  assert.deepEqual(LEGACY_ENGINE_FILES.filter(file => file.endsWith('.js')), ['src/quant-research/contract.js', 'src/postgres/quant-research-worker.js'], 'the legacy Node files this list relies on');
});

test('C1 every static import of the S3 module is in the trace closure or is one of two named, reasoned exclusions', async () => {
  const file = 'src/quant-library/trace-reproduction.js';
  const source = await fs.readFile(path.join(repoRoot, file), 'utf8');
  const imported = [...source.matchAll(nodeImports)].map(match => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  assert.ok(imported.length >= 6);
  const EXCLUDED = {
    // The judge: it compares the stored values with this module's output. Hashing it would tie every stored record to a gate edit (module header, auditor note N1).
    'src/quant-library/package-gates.js': 'the gate judges the reproduction',
    // Holds the closure list and engineHash(); it is not itself an input of the legacy engine closure.
    'src/postgres/quant-research.js': 'defines the legacy closure list and TERMINAL'};
  for (const name of imported) assert.ok(TRACE_REPRODUCTION_FILES.includes(name) || Object.hasOwn(EXCLUDED, name), 'unhashed import ' + name);
  for (const name of Object.keys(EXCLUDED)) assert.ok(!TRACE_REPRODUCTION_FILES.includes(name), name + ' stays out of the trace closure');
});

test('C1 the trace hash is the version plus the sha256 of every listed file as checked out, computed at test time', async () => {
  const files = Object.fromEntries(await Promise.all(TRACE_REPRODUCTION_FILES.map(async file => [file, hash(await read(file))])));
  const expected = hash(canonical({version: TRACE_REPRODUCTION_CLOSURE_VERSION, files}));
  assert.equal(await traceReproductionEngineHash(), expected);
  assert.match(expected, HEX64);
  assert.notEqual(hash(canonical({version: 'trace-reproduction-closure-v2', files})), expected, 'the version is part of the hashed object');
  assert.notEqual(hash(canonical(files)), expected, 'the unversioned bare map is not this hash');
  // The list is hashed: the same bytes under a shorter list hash differently.
  const shorter = Object.fromEntries(Object.entries(files).filter(([file]) => file !== 'src/money.js'));
  assert.notEqual(hash(canonical({version: TRACE_REPRODUCTION_CLOSURE_VERSION, files: shorter})), expected);
  // It does not equal any existing run or evaluation hash.
  assert.notEqual(expected, await engineHash(false));
  assert.notEqual(expected, await engineHash(true));
});

test('C1 one changed byte in any listed file rotates the hash; one dropped file fails closed instead of hashing a shorter list', async () => {
  const baseline = await traceReproductionEngineHash();
  for (const file of TRACE_REPRODUCTION_FILES) {
    const target = new URL('../' + file, import.meta.url).href;
    const changed = await traceReproductionEngineHash(async url => {
      const bytes = await fs.readFile(url);
      return url.href === target ? Buffer.concat([bytes, Buffer.from('\n# changed\n')]) : bytes;
    });
    assert.notEqual(changed, baseline, file);
  }
  for (const file of ['src/quant-library/trace-reproduction.js', 'quant_lab/src/robot_quant/trace_reproduction.py', 'src/money.js', 'quant_lab/src/robot_quant/ql3a.py']) {
    const target = new URL('../' + file, import.meta.url).href;
    await assert.rejects(traceReproductionEngineHash(url => {
      if (url.href === target) throw Object.assign(new Error('missing ' + file), {code: 'ENOENT'});
      return fs.readFile(url);
    }), error => error.code === 'ENOENT', file);
  }
});

/** Candidate engine hashes over LF-normalised bytes. FE-2b has the owner's 2026-10-22 implementation GO.
 * Its release evidence records old/new hashes. Stored historical contracts remain unchanged. Update only with an authorized engine change. */
const BASE_HASHES = Object.freeze({
  LEGACY: '988171145615b423393760f11c0cf050c2df2b1c9d27df5cfebd972f88c6e63a',
  FOUNDATION: '3b29eb619f2b4eda1e8abb924e965965c221282462daf238d2cfdd0707386c22',
  FIXED_EVAL: 'b3acd0c8af04a06f17ad5d54946c55e892869f12f64200271f84c200df39bf88'});
const fixedEvalFormula = async () => hash(canonical({version: 'fixed-eval-closure-v1', files: Object.fromEntries(await Promise.all(FIXED_EVAL_ENGINE_FILES.map(async name => [name, hash(Buffer.from((await read(name)).toString('latin1').replaceAll('\r\n', '\n'), 'latin1'))])))}));

test('C1 the engine hashes of the checkout equal the authorized candidate pins', async () => {
  assert.equal(await lfHash(LEGACY_ENGINE_FILES), BASE_HASHES.LEGACY, 'LEGACY engineHash(false)');
  assert.equal(await lfHash(FOUNDATION_ENGINE_FILES), BASE_HASHES.FOUNDATION, 'FOUNDATION engineHash(true)');
  assert.equal(await fixedEvalFormula(), BASE_HASHES.FIXED_EVAL, 'fixed-eval-closure-v1');
});

/* ================================ C5: classification coverage (R-CV1) ================================ */

const LITERAL_VERSIONS = {active: ['ql3a-research-job-v1'], deferred: ['ql3a-research-job-multi-v1', 'ql3a-research-job-v2', 'ql3a-research-job-v3']};
const classified = (versions, active = TRACE_EXECUTION_PROFILES, deferred = TRACE_PROFILE_DEFERRED) => versions.filter(version => Object.hasOwn(active, version) || Object.hasOwn(deferred, version));
const unclassified = (versions, active = TRACE_EXECUTION_PROFILES, deferred = TRACE_PROFILE_DEFERRED) => versions.filter(version => !classified([version], active, deferred).length);
/** The closure each profile names, as a file list. A profile that names a closure this table does not know fails C5. */
const CLOSURE_FILES = {'engineHash(false)': LEGACY_ENGINE_FILES, 'engineHash(true)': FOUNDATION_ENGINE_FILES};

test('C5 every G7-listed version and the multi-Pine version is classified ACTIVE or DEFERRED; ACTIVE and DEFERRED are disjoint', () => {
  const versions = [...OWNER_RECOMMENDATION_CONTRACT_VERSIONS, MULTI_PINE_CONTRACT_VERSION];
  assert.ok(versions.length >= 2 && versions.every(version => typeof version === 'string' && version.length > 0));
  assert.deepEqual(unclassified(versions), [], 'a G7 or multi-Pine version has no S3 profile or recorded deferral: the slice that renamed or added it owns the S3 classification');
  const active = Object.keys(TRACE_EXECUTION_PROFILES), deferred = Object.keys(TRACE_PROFILE_DEFERRED);
  assert.deepEqual(active.filter(version => deferred.includes(version)), []);
  assert.ok(Object.isFrozen(TRACE_EXECUTION_PROFILES) && Object.isFrozen(TRACE_PROFILE_DEFERRED));
  for (const version of deferred) assert.equal(typeof TRACE_PROFILE_DEFERRED[version].owner, 'string', version + ' names the slice that owns it');
  assert.equal(TRACE_PROFILE_DEFERRED['ql3a-research-job-v2'].execution_backend, 'quant-foundation-v1');
});

test('C5 ACTIVE is exactly the v1 key today (the slice that defines the next research contract changes this pin and adds its own profile and closure)', () => {
  assert.deepEqual(Object.keys(TRACE_EXECUTION_PROFILES), LITERAL_VERSIONS.active);
  assert.deepEqual(Object.keys(TRACE_PROFILE_DEFERRED).sort(), LITERAL_VERSIONS.deferred);
  assert.equal(TRACE_EXECUTION_PROFILES['ql3a-research-job-v1'].state, 'ACTIVE');
  for (const version of [...OWNER_RECOMMENDATION_CONTRACT_VERSIONS, MULTI_PINE_CONTRACT_VERSION]) assert.ok(!Object.hasOwn(TRACE_EXECUTION_PROFILES, version), version + ' is not ACTIVE');
});

test('C5 every ACTIVE profile names an existing closure whose file list is a subset of the trace closure', async () => {
  for (const [version, profile] of Object.entries(TRACE_EXECUTION_PROFILES)) {
    assert.ok(Object.hasOwn(CLOSURE_FILES, profile.closure), version + ' names an unknown closure ' + profile.closure);
    const files = CLOSURE_FILES[profile.closure];
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(TRACE_REPRODUCTION_FILES.includes(file), version + ': ' + profile.closure + ' file ' + file + ' is not in TRACE_REPRODUCTION_FILES');
    for (const file of files) await fs.access(path.join(repoRoot, file));
  }
  assert.match(await engineHash(false), HEX64, 'the ACTIVE closure function exists and runs');
});

test('C5 rename probe: the keys are literal strings, so a renamed G7 placeholder is unclassified until the owning slice classifies it', async () => {
  const real = [...OWNER_RECOMMENDATION_CONTRACT_VERSIONS, MULTI_PINE_CONTRACT_VERSION];
  assert.deepEqual(unclassified(real), []);
  const renamed = real.map(version => version === 'ql3a-research-job-v3' ? 'ql3a-research-job-v3-renamed' : version);
  assert.notDeepEqual(renamed, real, 'the probe renames the v3 placeholder');
  assert.deepEqual(unclassified(renamed), ['ql3a-research-job-v3-renamed']);
  assert.deepEqual(unclassified(['ql3a-research-job-v4', 'ql3a-research-job-multi-v2']), ['ql3a-research-job-v4', 'ql3a-research-job-multi-v2']);
  // Mutant M20: a dropped DEFERRED key is caught.
  const {['ql3a-research-job-v3']: dropped, ...withoutV3} = TRACE_PROFILE_DEFERRED;
  assert.ok(dropped);
  assert.deepEqual(unclassified(real, TRACE_EXECUTION_PROFILES, withoutV3), ['ql3a-research-job-v3']);
  // Mutant M21: v3 added to ACTIVE with the legacy closure is caught by the pins above.
  assert.notDeepEqual(Object.keys({...TRACE_EXECUTION_PROFILES, 'ql3a-research-job-v3': {state: 'ACTIVE', closure: 'engineHash(false)'}}), LITERAL_VERSIONS.active);
  // Mutant M22: a table computed from the G7 constant or the multi-Pine constant would follow the rename. The module names neither constant.
  const source = await fs.readFile(path.join(repoRoot, 'src/quant-library/trace-reproduction.js'), 'utf8');
  assert.ok(!/OWNER_RECOMMENDATION_CONTRACT_VERSIONS|MULTI_PINE_CONTRACT_VERSION/.test(source), 'the profile tables must not be computed from the gate constants');
  for (const version of [...LITERAL_VERSIONS.active, ...LITERAL_VERSIONS.deferred]) assert.ok(source.includes("'" + version + "'"), 'literal key ' + version);
});

/* ================================ C2: a real driver run on a v1 fixture run ================================ */

const PYTHON = resolveInterpreter();
const NO_PYTHON = PYTHON ? false : 'no interpreter: QUANT_RESEARCH_PYTHON is unset and quant_lab/.venv is absent (a bare python from PATH is never used)';
// The Quant Lab workflow sets TRACE_REQUIRE_PYTHON=1 after `uv sync`: there the C2 cases must run, never skip. The unit jobs have no venv and skip them.
test('C2 cases run where TRACE_REQUIRE_PYTHON=1: an interpreter resolves', {skip: process.env.TRACE_REQUIRE_PYTHON !== '1' && 'TRACE_REQUIRE_PYTHON is not set'}, () => {
  assert.ok(PYTHON, NO_PYTHON || '');
});
const LABEL = 'C3 evidence on a v1 fixture run, not B0 or build evidence';

/* The fixture mirrors quant_lab/tests/test_trace_reproduction.py: the SPT Custom source enrolment is the only thing replaced, in a bootstrap script that
 * monkeypatches CustomOptimizationPlan.from_snapshot (a Pine source and a 58-input review are out of scope for an engine-path test). Signals, Bridge, Risk,
 * ledger, metrics, the HOLDOUT wrapper and the production driver module are the real ones. */
const BOOTSTRAP = entry => [
  'import sys',
  'from robot_quant import research_engine, trace_reproduction',
  'from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, CustomSignalInputs',
  'BASE = CustomSignalInputs(ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2, zone_atr_mult=2.5, setup_expiry=8, cooldown=2, confirm_lookback=3)',
  'PLAN = CustomOptimizationPlan(BASE, {"emaFastInput": (4, 6, 1)})',
  'CustomOptimizationPlan.from_snapshot = lambda *_: PLAN',
  entry, ''].join('\n');

const OWNER = 'owner-s3c', BOT = 'owner-s3c', DEPLOY = '3c1d0a52-7b9e-4c1a-9a26-0f1e2d3c4b5a', IMPORT = '8a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e';
const STATEMENT = 'emaFastInput = input.int(5, "EMA fast", minval=4, maxval=6, step=1)';
const SOURCE = ['//@version=6', 'indicator("Trace S3c fixture indicator", overlay=true)', STATEMENT, 'useSlowFilter = input.bool(true, "Slow filter")', 'notifyEnabled = input.bool(false, "Notify")',
  'emaFast = ta.ema(close, emaFastInput)', 'emaSlow = ta.ema(close, 17)', 'buySignal = ta.crossover(emaFast, emaSlow)', 'sellSignal = ta.crossunder(emaFast, emaSlow)', 'plot(emaFast)', ''].join('\n');
const SPAN_START = SOURCE.indexOf(STATEMENT);
const BARS = 1500, SPLIT = {warmup: 10, train_end: 600, validation_end: 1050, test_end: BARS};
const GRID = {emaFastInput: [4, 5, 6], atr_multiplier: [0.95, 1, 1.05], rr: [1.9, 2, 2.1]};
/** The plan: a baseline, the winner (rr 2), one planned neighbour on each of two dimensions, and ema 6 so every dimension is covered. Neighbours of the winner that are not
 * planned (ema 4, ema 6, atr 1.05, rr 2.1) are recomputed as SENSITIVITY steps; atr 0.95 and rr 1.9 are planned, so they are stored as CANDIDATE steps. */
const PLAN = [{emaFastInput: 5, atr_multiplier: 1, rr: 1.9}, {emaFastInput: 5, atr_multiplier: 1, rr: 2}, {emaFastInput: 5, atr_multiplier: 0.95, rr: 2}, {emaFastInput: 6, atr_multiplier: 1, rr: 1.9}];
const WINNER = PLAN[1];

function engineBars() {
  const bars = [];
  let previous = 100;
  for (let i = 0; i < BARS; i++) {
    const close = 100 + 12 * Math.sin(i / 23) + 2 * Math.sin(i / 3);
    bars.push({time: T0 + i * MINUTE, open: String(previous), high: String(Math.max(previous, close) + 1.2), low: String(Math.min(previous, close) - 1.2), close: String(close), volume: '1', atr14: '2.75'});
    previous = close;
  }
  return bars;
}
async function fixtureContract() {
  const contract = clone(contractOf({owner: OWNER, bot: BOT, deployment: DEPLOY, importId: IMPORT, tag: 's3c', total: BARS, warmup: SPLIT.warmup, barCount: 0, candidates: PLAN.length, domains: GRID}));
  Object.assign(contract, {version: 'ql3a-research-job-v1', source: SOURCE, source_hash: hash(SOURCE), policy_version: 'policy-v1', acceptance_blockers: [...CANDIDATE_BLOCKERS], split: {...SPLIT}});
  contract.snapshot.policy = {max_daily_loss_percent: '3', equities: {'binance-global': '1000'}, killSwitch: false, maxSignalAgeSeconds: 120, maxTradesPerDay: 10000, maxDailyLossR: 10000,
    pauseAfterLossStreak: 10000, blockHighVolatility: false, maxVolatilityPercent: 100, blockDuringNews: false, allowedSymbols: ['BTCUSDT'], sideMode: 'BOTH', maxOpenPositions: 5,
    onePositionPerSymbol: false, capPercentEquitySize: true, maxRiskPercent: 100, maxOrderNotional: 10000, maxDailyNotional: 10000000};
  contract.snapshot.membership = [{pine_import_id: IMPORT, source_version: 1, source_hash: contract.source_hash}];
  contract.dataset.bars = engineBars();
  contract.model = {...contract.model, quantity_step: 0.00001};
  const binding = contract.input_lock.selection.bindings[0];
  Object.assign(binding, {effective_value: 5, search_domain: {min: 4, max: 6, step: 1}, source_span: {start: SPAN_START, end: SPAN_START + STATEMENT.length}});
  contract.input_lock.selection.fixed_inputs.push({input_id: 'input_11', pine_variable: 'emaSlowInput', effective_value: 17, type: 'int', eligible: false});
  contract.input_lock.baseline = clone(PLAN[0]);
  contract.plan.candidates = clone(PLAN);
  contract.plan.planned_candidates = PLAN.length;
  contract.max_evaluations = 40;
  contract.engine_hash = await engineHash(false);
  return contract;
}

/** One Python process: the bootstrap script with stdin to stdout JSON. The caller supplies the whole request body. */
function runPython(script, body, {timeoutMs = 60000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-P', script], {cwd: repoRoot, env: {...process.env, PYTHONPATH: path.join(repoRoot, 'quant_lab/src'), PYTHONHASHSEED: '0'}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const out = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', data => out.push(data));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(Object.assign(new Error('python exited ' + code), {code: 'EVALUATION_FAILED'})); return; }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); } catch { reject(Object.assign(new Error('bad engine reply'), {code: 'INVALID_EVALUATION_RESPONSE'})); }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

let scratch = null;
async function ensureFixture() {
  if (scratch) return scratch;
  scratch = (async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 's3c-trace-'));
    const engineScript = path.join(dir, 'engine.py'), driverScript = path.join(dir, 'driver.py');
    await fs.writeFile(engineScript, BOOTSTRAP('research_engine.main()'));
    await fs.writeFile(driverScript, BOOTSTRAP('trace_reproduction.main()'));
    const contract = await fixtureContract();
    const contractHash = hash(canonical(contract));
    /** Like pythonEvaluation: a non-HOLDOUT step sees only the bars up to validation_end (holdout candles never enter those steps). */
    const evaluate = (c, parameters, kind, signal, {slice = true} = {}) => runPython(engineScript, {
      contract: kind === 'HOLDOUT' || !slice ? c : {...c, dataset: {...c.dataset, bars: c.dataset.bars.slice(0, c.split.validation_end)}}, parameters, kind});
    const traceEvaluate = (c, parameters, signal) => driverEvaluation(c, parameters, signal, {python: PYTHON, args: ['-P', driverScript], timeoutMs: 60000});
    const ports = {evaluate, traceEvaluate, engineHash: () => engineHash(false)};
    // The stored run: the real QuantResearchWorker.step and run loop, its storage and lease replaced, its evaluation the real engine.
    const worker = Object.create(QuantResearchWorker.prototype), stored = [], steps = [];
    let finished = null;
    worker.controller = {signal: new AbortController().signal};
    worker.clock = () => 1;
    worker.steps = async () => stored;
    worker.engineHash = async () => contract.engine_hash;
    worker.fenced = async (job, work) => work({evaluations_started: 0});
    worker.current = async () => {};
    worker.db = {prepare: sql => ({run: async (...values) => { if (/INSERT INTO quant_job_steps/.test(sql)) { const [runId, stepId, kind, parameters, result] = values; stored.push({step_id: stepId, kind, parameters: JSON.parse(parameters), result: JSON.parse(result)}); steps.push([stepId, kind]); } }})};
    worker.evaluate = evaluate;
    worker.finish = async (job, status, result) => { finished = {status, result: JSON.parse(JSON.stringify(result))}; };
    await worker.run({contract, contract_hash: contractHash, run_id: 'run-s3c-0001'});
    const run = clone({owner_id: OWNER, bot_id: BOT, run_id: 'run-s3c-0001', status: finished.status, contract, contract_hash: contractHash, result: finished.result});
    return {dir, ports, run, steps, stored, evaluate, engineScript, driverScript};
  })();
  return scratch;
}
test.after(async () => { if (scratch) { const fixture = await scratch.catch(() => null); if (fixture) await fs.rm(fixture.dir, {recursive: true, force: true}); } });

const storedDigests = selected => ({
  steps: hash(canonical({candidate: {parameters: selected.parameters, result: selected.result}, sensitivity: selected.sensitivity, cost_stress: selected.cost_stress})),
  holdout: hash(canonical({test: selected.test}))});

/** The rendered package of a stored run and the C3 subject around it (the shape of test/quant-library-trace-reproduction.test.js c3Subject). */
function c3Subject(storedRun, trace, recordRows) {
  const run = {...clone(storedRun), submission_hash: hex('submission-s3c')};
  const rendered = renderPackage({export_id: '9f1c2b7e-3d4a-4b5c-8d6e-0123456789ab', created_at: '2026-10-19T12:00:00Z', run, fixture: true, library_versions: clone(LIBRARY_VERSIONS),
    risk_limits: {max_daily_loss_percent: '3'}, trace, exit_version: 'bridge-exit-v2'});
  const contract = run.contract;
  const metadata = {version: 'spot-dataset-v1', venue: 'binance-global', market: 'SPOT', symbol: 'BTCUSDT', timeframe: '1', start_time: contract.dataset.start_time,
    end_time: contract.dataset.end_time + MINUTE, warmup_bars: contract.dataset.warmup_bars, total_bars: contract.dataset.bar_count, cutoff: contract.dataset.end_time + MINUTE, source: 'binance-spot-klines-v1'};
  return {rendered, subject: {run, export: {library_versions: clone(LIBRARY_VERSIONS)}, files: {...rendered.files}, hard_limits: {max_daily_loss_percent: {max: '5'}}, deployment: {exit_version: 'bridge-exit-v2'},
    dataset: {readable: true, digest: contract.dataset.sha256, metadata}, fixture_request: true, trace_reproduction: recordRows(rendered.files)}};
}
const c3Codes = subject => [...evaluateProvenance(subject).codes];

let reproduced = null;
const reproduction = async () => {
  const fixture = await ensureFixture();
  reproduced ??= reproduceRun({run: fixture.run, ports: fixture.ports});
  return {fixture, value: await reproduced};
};

test('C2 (' + LABEL + ') the fixture run is what the real worker loop stores from the real engine: pending acceptance, a holdout, CANDIDATE and SENSITIVITY neighbour steps',
  {skip: NO_PYTHON, timeout: 180000}, async () => {
    const {run, steps} = await ensureFixture();
    assert.equal(run.status, 'SUCCEEDED', 'the labelled fixture must clear the worker screening: ' + JSON.stringify(run.result?.selected?.screen_reasons));
    assert.equal(run.result.completion_reason, 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
    assert.equal(run.result.holdout_evaluated, true);
    assert.deepEqual(run.result.selected.parameters, WINNER);
    assert.deepEqual(run.result.selected.screen_reasons, []);
    assert.deepEqual(run.result.selected.sensitivity.map(item => [item.dimension, item.parameters, item.result.kind]), [
      ['atr_multiplier', {emaFastInput: 5, atr_multiplier: 0.95, rr: 2}, 'CANDIDATE'], ['atr_multiplier', {emaFastInput: 5, atr_multiplier: 1.05, rr: 2}, 'SENSITIVITY'],
      ['emaFastInput', {emaFastInput: 4, atr_multiplier: 1, rr: 2}, 'SENSITIVITY'], ['emaFastInput', {emaFastInput: 6, atr_multiplier: 1, rr: 2}, 'SENSITIVITY'],
      ['rr', {emaFastInput: 5, atr_multiplier: 1, rr: 1.9}, 'CANDIDATE'], ['rr', {emaFastInput: 5, atr_multiplier: 1, rr: 2.1}, 'SENSITIVITY']]);
    assert.equal(run.result.selected.cost_stress.kind, 'STRESS');
    assert.deepEqual(steps.filter(([, kind]) => kind === 'HOLDOUT').map(([id]) => id), ['holdout:selected']);
    assert.ok(run.result.selected.test.closed_trades >= 5);
  });

test('C2 (' + LABEL + ') the real driver and real engine recompute the digests the worker stored; the untouched run passes the real C3 gate', {skip: NO_PYTHON, timeout: 180000}, async () => {
  const {fixture, value} = await reproduction();
  const stored = storedDigests(fixture.run.result.selected);
  assert.equal(value.steps_digest, stored.steps, 'steps digest equals the stored one');
  assert.equal(value.holdout_digest, stored.holdout, 'holdout digest equals the stored one');
  assert.equal(value.run_engine_hash, fixture.run.contract.engine_hash);
  assert.equal(value.trace_engine_hash, await traceReproductionEngineHash());
  // The recomputed values are not the stored objects: the run was cloned through JSON before the module read it (the module reads no stored step result).
  const records = files => gateTraceReproduction(traceReproductionRecords(value, files, 1), fixture.run.contract);
  const {subject} = c3Subject(fixture.run, value.trace, records);
  assert.equal(subject.trace_reproduction.length, 3);
  assert.deepEqual(c3Codes(subject), [], 'untouched stored run: C3 passes');
});

test('C2 (' + LABEL + ') a tampered stored sensitivity result, cost-stress result or holdout test is reported by C3 as BI_RESULT_MISMATCH or HOLDOUT_MISMATCH', {skip: NO_PYTHON, timeout: 180000}, async () => {
  const {fixture, value} = await reproduction();
  const records = files => gateTraceReproduction(traceReproductionRecords(value, files, 1), fixture.run.contract);
  const codesOf = edit => { const tampered = clone(fixture.run); edit(tampered.result.selected); return c3Codes(c3Subject(tampered, value.trace, records).subject); };
  const bump = metrics => { metrics.net_return_percent = String(Number(metrics.net_return_percent) + 0.01); };
  // Every stored neighbour binds, the CANDIDATE-kind ones and the SENSITIVITY-kind ones alike.
  fixture.run.result.selected.sensitivity.forEach((item, index) => assert.deepEqual(codesOf(selected => bump(selected.sensitivity[index].result.validation)), ['BI_RESULT_MISMATCH'], 'sensitivity ' + index));
  assert.deepEqual(codesOf(selected => bump(selected.cost_stress.validation)), ['BI_RESULT_MISMATCH'], 'cost stress');
  assert.deepEqual(codesOf(selected => bump(selected.result.train)), ['BI_RESULT_MISMATCH'], 'candidate result');
  assert.deepEqual(codesOf(selected => bump(selected.test)), ['HOLDOUT_MISMATCH'], 'holdout test');
  // A record whose run engine hash is not the contract's is dropped by the read side, so C3 sees an absent record.
  const otherEngine = files => gateTraceReproduction(traceReproductionRecords({...value, run_engine_hash: hex('another run engine')}, files, 1), fixture.run.contract);
  assert.deepEqual(c3Codes(c3Subject(fixture.run, value.trace, otherEngine).subject), ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH']);
});

test('C2 (' + LABEL + ') the real trace: every partition has rows, partitions follow the contract split, closed trades equal the stored holdout counts, an open entry has no trade row',
  {skip: NO_PYTHON, timeout: 180000}, async () => {
    const {fixture, value} = await reproduction();
    const {contract, result} = fixture.run;
    const edges = [contract.dataset.bars[SPLIT.warmup].time, contract.dataset.bars[SPLIT.train_end].time, contract.dataset.bars[SPLIT.validation_end].time];
    const partitionOf = time => time < edges[1] ? 'train' : time < edges[2] ? 'validation' : 'test';
    const {equity, trades, decisions} = value.trace;
    assert.deepEqual(Object.keys(value.trace), ['equity', 'trades', 'decisions']);
    assert.ok(equity.rows.length > 0 && trades.rows.length > 0 && decisions.rows.length >= equity.rows.length);
    const col = (table, name) => table.columns.indexOf(name);
    for (const row of equity.rows) assert.equal(row[col(equity, 'partition')], partitionOf(row[col(equity, 'time_ms')]));
    for (const row of decisions.rows) assert.equal(row[col(decisions, 'partition')], partitionOf(row[col(decisions, 'time_ms')]));
    for (const row of trades.rows) assert.equal(row[col(trades, 'partition')], partitionOf(row[col(trades, 'exit_time_ms')]), 'a trade belongs to the partition of its exit bar');
    const stored = result.selected.test, perPartition = name => trades.rows.filter(row => row[col(trades, 'partition')] === name).length;
    assert.equal(perPartition('test'), stored.closed_trades);
    assert.equal(perPartition('train'), result.selected.result.train.closed_trades);
    assert.equal(perPartition('validation'), result.selected.result.validation.closed_trades);
    // Every trade row is a closed trade (a FILLED BUY and a FILLED EXIT decision). This fixture has no open entry at test_end, so the open-entry
    // loop below asserts nothing here; mutant M12 (an open final entry kept as a trade row) is killed by the S3a test A4, not by S3c.
    const filled = (ref, type) => decisions.rows.some(row => row[col(decisions, 'entry_ref')] === ref && row[col(decisions, 'event_type')] === type && row[col(decisions, 'outcome')] === 'FILLED');
    for (const row of trades.rows) assert.ok(filled(row[0], 'BUY') && filled(row[0], 'EXIT'), 'trade ' + row[0] + ' is a closed trade');
    const entries = new Set(decisions.rows.filter(row => row[col(decisions, 'event_type')] === 'BUY' && row[col(decisions, 'outcome')] === 'FILLED').map(row => row[col(decisions, 'entry_ref')]));
    const closed = new Set(trades.rows.map(row => row[0]));
    for (const ref of entries) if (!filled(ref, 'EXIT')) assert.ok(!closed.has(ref), 'open entry ' + ref + ' has a trade row');
    assert.equal(closed.size, trades.rows.length, 'one row per entry_ref');
  });

test('C2 (' + LABEL + ') mutant M8: a non-HOLDOUT step given the full bars is refused by the real engine; the holdout slice is what the module relies on', {skip: NO_PYTHON, timeout: 180000}, async () => {
  const fixture = await ensureFixture();
  const {contract} = fixture.run;
  await assert.rejects(fixture.evaluate(contract, clone(WINNER), 'CANDIDATE', undefined, {slice: false}), error => error.code === 'EVALUATION_FAILED');
  await assert.rejects(fixture.evaluate(contract, clone(WINNER), 'STRESS', undefined, {slice: false}), error => error.code === 'EVALUATION_FAILED');
  const sliced = await fixture.evaluate(contract, clone(WINNER), 'CANDIDATE');
  assert.equal(sliced.kind, 'CANDIDATE');
  assert.ok(!Object.hasOwn(sliced, 'test'), 'a candidate step never carries the holdout part');
  // The holdout needs the full bars; the validation slice alone is refused.
  const cut = {...contract, dataset: {...contract.dataset, bars: contract.dataset.bars.slice(0, contract.split.validation_end)}};
  await assert.rejects(fixture.evaluate(cut, clone(WINNER), 'HOLDOUT'), error => error.code === 'EVALUATION_FAILED');
});

test('C2 the production driver refuses without an interpreter and never falls back to a bare python (runs everywhere)', async () => {
  await assert.rejects(driverEvaluation({}, {}, undefined, {python: ''}), error => ['QUANT_PYTHON_UNAVAILABLE', 'EVALUATION_FAILED'].includes(error.code));
  assert.equal(resolveInterpreter({env: {}, venv: 'absent', exists: () => false}), null);
});
