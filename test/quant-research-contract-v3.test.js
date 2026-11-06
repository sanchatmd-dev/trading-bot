import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical, hash} from '../src/pine-bridge/source.js';
import {lockInputs, candidatePlan, RULES} from '../src/quant-research/contract.js';
import {QuantResearchService} from '../src/postgres/quant-research.js';
import {familyOf} from '../src/postgres/quant-library.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {
  RESEARCH_V3_VERSION, RESEARCH_V3_SCOPE, RESEARCH_V3_FIXTURE_POLICY_VERSION, RESEARCH_V3_BLOCKERS, RESEARCH_V3_CONTRACT_KEYS,
  buildResearchContractV3, validateResearchContractV3
} from '../src/quant-research/research-contract-v3.js';
import {fixture, source as FIXTURE_SOURCE} from './helpers/quant-research-fixture.mjs';

/*
 * The ql3a-research-job-v3 contract (GO-L6-LOCAL, design docs/design/f09-recommendation-contract, tests V3-P1, V3-P2, V3-P3, V3-P16).
 * Everything here is a LABELLED ENGINEERING FIXTURE: synthetic bars and a synthetic source, never a research result and never a recommendation.
 * The module is pure, so no database, clock, network or file is used; the service cases run on stubs.
 */

const clone = value => JSON.parse(JSON.stringify(value));
const V1 = 'ql3a-research-job-v1';
const V3 = RESEARCH_V3_VERSION;
const CODE = 'INVALID_RESEARCH_CONTRACT_V3';
const START = 1_800_000_000_000, TOTAL = 20, WARMUP = 5;

function builderInput() {
  const f = fixture();
  const lock = lockInputs(f.analysis, f.selection, f.slots, f.bridge_domains);
  const plan = candidatePlan(lock, 25, 27);
  const policy = {paperTrading: true, requireReduceOnlySell: true};
  const bars = Array.from({length: TOTAL}, (_, index) => ({time: START + index * 60000, open: '100', high: '101', low: '99', close: '100', volume: '1', atr14: '2', price_tick: '0.01', quantity_step: '0.001'}));
  const snapshot = {source_hash: hash(FIXTURE_SOURCE), market: {broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'}, policy, policy_hash: hash(canonical(policy)), capital: [], membership: []};
  return {
    owner_id: 'owner-a', bot_id: 'owner-a',
    deployment: {deployment_id: '3c1d0a52-7b9e-4c1a-9a26-0f1e2d3c4b5a', pine_import_id: '8a6f4e21-5d3c-4b7a-8e19-2c4d6f8a0b1e', source_version: 1, snapshot_hash: hash('baseline')},
    source: {source: FIXTURE_SOURCE, source_hash: hash(FIXTURE_SOURCE)}, snapshot, lock, plan,
    model: {version: 'paper-close-v1', price_tick: '0.01', quantity_step: '0.001', fee_bps: 10, slippage_bps: 1, risk_percent: 1, data_profile: 'closed-ohlcv-atr14-v1'},
    rules: RULES, capital: {configuredEquity: '1000', configuredBalance: '1000'}, engine_hash: hash('engine'),
    dataset: {start_time: START, end_time: START + (TOTAL - 1) * 60000, warmup_bars: WARMUP, bars, sha256: hash('bars')}};
}
const VALID = buildResearchContractV3(builderInput());

test('V3-P1 the builder yields the exact 24-key v3 contract: v1 fields plus policy_version and policy_hash, no execution_backend, fixture scope, frozen', () => {
  assert.deepEqual(Object.keys(VALID).sort(), [...RESEARCH_V3_CONTRACT_KEYS].sort());
  assert.equal(RESEARCH_V3_CONTRACT_KEYS.length, 24);
  assert.ok(!Object.hasOwn(VALID, 'execution_backend'));
  assert.equal(VALID.version, 'ql3a-research-job-v3');
  assert.equal(VALID.scope, 'SPT_CUSTOM_ENGINEERING_ONLY');
  assert.equal(RESEARCH_V3_SCOPE, VALID.scope);
  assert.ok(Object.isFrozen(VALID) && Object.isFrozen(VALID.dataset) && Object.isFrozen(VALID.dataset.bars[0]) && Object.isFrozen(RESEARCH_V3_BLOCKERS));
  // derived exactly as the v1 literal derives them
  assert.deepEqual(VALID.split, {warmup: WARMUP, train_end: WARMUP + Math.floor((TOTAL - WARMUP) * .6), validation_end: WARMUP + Math.floor((TOTAL - WARMUP) * .8), test_end: TOTAL});
  assert.equal(VALID.dataset.bar_count, TOTAL);
  assert.deepEqual(VALID.capital, {equity: '1000', cash: '1000'});
  assert.equal(VALID.max_evaluations, VALID.plan.planned_candidates + 2 * Object.keys(VALID.input_lock.domains).length + 2 + 3);
  assert.equal(VALID.source_hash, hash(VALID.source));
  assert.equal(VALID.baseline_snapshot_hash, hash('baseline'));
  assert.equal(canonical(VALID.snapshot.selection), canonical(VALID.input_lock.selection));
  // a canonical round trip is the identity, so the stored hash is stable
  assert.equal(hash(canonical(VALID)), hash(canonical(JSON.parse(JSON.stringify(VALID)))));
  assert.equal(canonical(validateResearchContractV3(VALID)), canonical(VALID));
});

test('V3-P1 the builder reads its input without mutating it and takes no scope, version or policy value from the caller', () => {
  const input = builderInput(), before = canonical(input);
  buildResearchContractV3(input);
  assert.equal(canonical(input), before);
  const hostile = builderInput();
  Object.assign(hostile, {version: 'ql3a-research-job-v1', scope: 'OTHER', policy_version: 'real-v9', policy_hash: hash('x'), acceptance_blockers: [], execution_backend: 'quant-foundation-v1'});
  const built = buildResearchContractV3(hostile);
  assert.equal(built.version, V3);
  assert.equal(built.scope, 'SPT_CUSTOM_ENGINEERING_ONLY');
  assert.equal(built.policy_version, RESEARCH_V3_FIXTURE_POLICY_VERSION);
  assert.equal(built.policy_hash, hostile.snapshot.policy_hash);
  assert.ok(!Object.hasOwn(built, 'execution_backend'));
  for (const bad of [null, undefined, {}, {...builderInput(), deployment: undefined}, {...builderInput(), dataset: {...builderInput().dataset, bars: []}}, {...builderInput(), engine_hash: 'short'}])
    assert.throws(() => buildResearchContractV3(bad), {code: CODE});
});

test('V3-P1 the validator refuses an extra, missing or renamed key, an execution_backend key (null included) and any other version or scope', () => {
  assert.doesNotThrow(() => validateResearchContractV3(VALID));
  const bad = (name, edit) => assert.throws(() => validateResearchContractV3((() => { const c = clone(VALID); edit(c); return c; })()), {code: CODE, status: 400}, name);
  for (const key of RESEARCH_V3_CONTRACT_KEYS) {
    bad('missing ' + key, c => { delete c[key]; });
    bad('renamed ' + key, c => { c[key + '_x'] = c[key]; delete c[key]; });
  }
  bad('extra key', c => { c.extra = 1; });
  bad('execution_backend string', c => { c.execution_backend = 'quant-foundation-v1'; });
  bad('execution_backend null', c => { c.execution_backend = null; });
  for (const version of [V1, 'ql3a-research-job-v2', 'ql3a-research-job-v4', 'ql3a-research-job-multi-v1', 'QL3A-RESEARCH-JOB-V3', '', null, 3]) bad('version ' + String(version), c => { c.version = version; });
  for (const scope of ['SPT_CUSTOM_RESEARCH', '', null, 'spt_custom_engineering_only']) bad('scope ' + String(scope), c => { c.scope = scope; });
  for (const bare of [null, undefined, [], 'text', 5, Object.create({inherited: 1})]) assert.throws(() => validateResearchContractV3(bare), {code: CODE});
  // the input is never mutated and the result is a copy
  const copy = clone(VALID), checked = validateResearchContractV3(copy);
  assert.notEqual(checked, copy);
  assert.deepEqual(copy, clone(VALID));
});

test('V3-P1 the validator holds the v1 shape rules: ids, hashes, source, capital, rules, evaluation cap, dataset, bars and split', () => {
  const bad = (name, edit) => assert.throws(() => validateResearchContractV3((() => { const c = clone(VALID); edit(c); return c; })()), {code: CODE}, name);
  bad('owner id', c => { c.owner_id = ''; });
  bad('bot id', c => { c.bot_id = 'a b'; });
  bad('source version', c => { c.source_version = 0; });
  bad('source hash', c => { c.source_hash = hash('other'); });
  bad('engine hash', c => { c.engine_hash = 'ABC'; });
  bad('baseline hash', c => { c.baseline_snapshot_hash = 'x'; });
  bad('selection', c => { c.snapshot.selection.signals.buy = 'other'; });
  bad('lock hash', c => { c.input_lock.lock_hash = 'x'; });
  bad('plan count', c => { c.plan.planned_candidates += 1; });
  bad('rules key', c => { delete c.rules.maximum_drawdown_percent; });
  bad('rules extra', c => { c.rules.extra = 1; });
  bad('rules value', c => { c.rules.maximum_drawdown_percent = '20'; });
  bad('capital zero', c => { c.capital.cash = '0'; });
  bad('capital key', c => { c.capital.extra = 1; });
  bad('ledger text', c => { c.ledger_initialization = 'other'; });
  bad('max evaluations', c => { c.max_evaluations += 1; });
  bad('dataset key', c => { c.dataset.references = []; });
  bad('bar count', c => { c.dataset.bar_count += 1; });
  bad('bars length', c => { c.dataset.bars.pop(); });
  bad('bar gap', c => { c.dataset.bars[3].time += 1; });
  bad('dataset digest', c => { c.dataset.sha256 = 'x'; });
  bad('warmup', c => { c.dataset.warmup_bars = TOTAL; });
  bad('split', c => { c.split.train_end += 1; });
  bad('more than 10000 bars', c => { c.dataset.end_time = c.dataset.start_time + 10000 * 60000; c.dataset.bar_count = 10001; });
  bad('not json', c => { c.model.fee_bps = Number.NaN; });
});

test('V3-P2 acceptance_blockers must equal exactly the two candidate evidence blockers in order: a capability blocker, a missing, reordered, extra or unknown code refuses (OD-3)', () => {
  assert.deepEqual([...RESEARCH_V3_BLOCKERS], ['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED', 'CUSTOM_REPAINT_EVIDENCE_REQUIRED']);
  assert.deepEqual(VALID.acceptance_blockers, [...RESEARCH_V3_BLOCKERS]);
  const bad = (name, blockers) => assert.throws(() => validateResearchContractV3({...clone(VALID), acceptance_blockers: blockers}), {code: CODE}, name);
  bad('the v1 list with the capability blocker', [...RESEARCH_V3_BLOCKERS, 'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']);
  bad('capability blocker alone', ['CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']);
  bad('a capability blocker in place of one', ['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED', 'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED']);
  bad('reordered', [...RESEARCH_V3_BLOCKERS].reverse());
  bad('one missing', [RESEARCH_V3_BLOCKERS[0]]);
  bad('empty', []);
  bad('duplicate', [RESEARCH_V3_BLOCKERS[0], RESEARCH_V3_BLOCKERS[0]]);
  bad('unknown code', [...RESEARCH_V3_BLOCKERS, 'MULTI_PINE_REQUIRES_APP_3B']);
  bad('not an array', 'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED');
  bad('null', null);
});

test('V3-P3 policy_hash is 64 lower-case hex and equals snapshot.policy_hash; policy_version is non-empty text (OD-12, Q9)', () => {
  assert.equal(VALID.policy_hash, VALID.snapshot.policy_hash);
  assert.match(VALID.policy_hash, /^[a-f0-9]{64}$/);
  assert.equal(VALID.policy_version, 'fixture-v1');
  const bad = (name, edit) => assert.throws(() => validateResearchContractV3((() => { const c = clone(VALID); edit(c); return c; })()), {code: CODE}, name);
  bad('policy hash differs from the snapshot', c => { c.policy_hash = hash('other'); });
  bad('snapshot hash differs from the field', c => { c.snapshot.policy_hash = hash('other'); });
  bad('upper case', c => { c.policy_hash = c.policy_hash.toUpperCase(); c.snapshot.policy_hash = c.policy_hash; });
  bad('short', c => { c.policy_hash = 'abc'; c.snapshot.policy_hash = 'abc'; });
  bad('not text', c => { c.policy_hash = 5; });
  bad('snapshot without the hash', c => { delete c.snapshot.policy_hash; });
  for (const value of ['', ' ', null, 1, 1.5, true, {}, [], 'x'.repeat(129), 'bad value', '-leading']) bad('policy_version ' + JSON.stringify(value), c => { c.policy_version = value; });
  for (const value of ['fixture-v1', 'policy-v1', 'a', 'v1.2:final']) assert.doesNotThrow(() => validateResearchContractV3({...clone(VALID), policy_version: value}), value);
  // the builder takes the hash from the snapshot: a snapshot without it, or with a malformed one, cannot build
  const missing = builderInput(); delete missing.snapshot.policy_hash;
  assert.throws(() => buildResearchContractV3(missing), {code: CODE});
  const malformed = builderInput(); malformed.snapshot.policy_hash = 'ZZ';
  assert.throws(() => buildResearchContractV3(malformed), {code: CODE});
});

test('V3-P12 familyOf classifies v3 as LEGACY with v1; v2 and a backend key stay FOUNDATION; anything else is unclassified', () => {
  assert.equal(familyOf({version: V3}), 'LEGACY');
  assert.equal(familyOf({version: V1}), 'LEGACY');
  assert.equal(familyOf(VALID), 'LEGACY');
  assert.equal(familyOf({version: 'ql3a-research-job-v2'}), 'FOUNDATION');
  assert.equal(familyOf({version: V3, execution_backend: 'quant-foundation-v1'}), 'FOUNDATION', 'a backend key wins, as for v1');
  for (const version of ['ql3a-research-job-multi-v1', 'ql3a-research-job-v4', 'QL3A-RESEARCH-JOB-V3', '', undefined, null]) assert.equal(familyOf({version}), null, String(version));
});

/* ---------------- V3-P16: request selection, capability port and executor mode on stubs ---------------- */

const BODY = {bot_id: 'bot', deployment_id: 'old-deployment', parameter_slots: [], bridge_domains: {}, dataset: {}, budget: 1, seed: 1};
const KEY = 'historical-key';
function stubService({foundation = false, old = null, capabilityReader} = {}) {
  const statements = [];
  const db = {lock: async () => { statements.push('lock'); }, query: async sql => { statements.push(sql); return {rows: []}; },
    prepare: sql => { statements.push(sql); return {get: async () => old, all: async () => [], run: async () => {}}; }};
  const service = new QuantResearchService({pineService: {db, store: {}, authorize: async () => {}}, foundation, datasetStore: {}, ...(capabilityReader === undefined ? {} : {capabilityReader})});
  service.executorMode = async () => {};
  service.summary = async row => ({run_id: row.run_id});
  return {service, statements};
}
const stored = body => ({run_id: 'historical-job', submission_hash: hash(canonical(body)), contract: {snapshot: {selection: {bindings: []}}}});

test('V3-P16 request selection: contract_version is an optional key inside the submission hash; a v1 body without the key keeps its hash', async () => {
  const v3Body = {...BODY, contract_version: V3}, v1Body = {...BODY, contract_version: V1};
  assert.notEqual(hash(canonical(v3Body)), hash(canonical(BODY)));
  assert.notEqual(hash(canonical(v1Body)), hash(canonical(BODY)));
  // a v1 body without the key replays the stored job exactly as before the selector existed
  assert.deepEqual(await stubService({old: stored(BODY)}).service.enqueue('owner', BODY, KEY), {run_id: 'historical-job'});
  // each form replays its own stored job
  assert.deepEqual(await stubService({old: stored(v3Body)}).service.enqueue('owner', v3Body, KEY), {run_id: 'historical-job'});
  assert.deepEqual(await stubService({old: stored(v1Body)}).service.enqueue('owner', v1Body, KEY), {run_id: 'historical-job'});
  // the same idempotency key with another version, in either direction, is a conflict and never returns the other job
  for (const [row, body] of [[BODY, v3Body], [v3Body, BODY], [v1Body, v3Body], [v3Body, v1Body], [BODY, v1Body]]) {
    await assert.rejects(stubService({old: stored(row)}).service.enqueue('owner', body, KEY), {code: 'IDEMPOTENCY_CONFLICT', status: 409});
  }
});

test('V3-P16 an unknown, null or non-text contract_version refuses before any database statement', async () => {
  for (const value of ['ql3a-research-job-v2', 'ql3a-research-job-v4', 'ql3a-research-job-multi-v1', 'v3', '', null, 3, true, undefined, {}]) {
    const {service, statements} = stubService({old: stored(BODY)});
    await assert.rejects(service.enqueue('owner', {...BODY, contract_version: value}, KEY), {code: 'UNSUPPORTED_RESEARCH_CONTRACT_VERSION', status: 400}, String(value));
    assert.deepEqual(statements, [], 'no statement for ' + String(value));
  }
  // other unknown keys stay INVALID_FIELDS, so the selector does not widen the body
  await assert.rejects(stubService().service.enqueue('owner', {...BODY, contract_versions: V3}, KEY), {code: 'INVALID_FIELDS'});
});

test('V3-G6 (stub) a v3 request in a service in FOUNDATION mode is refused with RESEARCH_EXECUTOR_MODE_MISMATCH before any lock or row; v1 in that mode is unchanged', async () => {
  const {service, statements} = stubService({foundation: true});
  await assert.rejects(service.enqueue('owner', {...BODY, contract_version: V3}, KEY), {code: 'RESEARCH_EXECUTOR_MODE_MISMATCH', status: 503});
  assert.deepEqual(statements, [], 'no lock, no query');
  // a v1 body (with or without the explicit key) goes on to the idempotency lookup in FOUNDATION mode
  for (const body of [BODY, {...BODY, contract_version: V1}]) {
    const stubbed = stubService({foundation: true, old: stored(body)});
    assert.deepEqual(await stubbed.service.enqueue('owner', body, KEY), {run_id: 'historical-job'});
  }
});

test('V3 capability port: only a reader that answers exactly true admits; an absent, failing or non-true reader refuses with the capability code', async () => {
  const source = {source_hash: hash('s'), analysis: {effective_inputs_hash: hash('e')}};
  const refuse = async capabilityReader => {
    const {service} = stubService({capabilityReader});
    await assert.rejects(service.requireCapability(source), {code: 'CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED', status: 409});
  };
  await refuse(undefined);
  await refuse(null);
  await refuse({});
  await refuse({isRegistered: 'yes'});
  for (const answer of [false, undefined, null, 0, 1, 'true', 'yes', {}, [], 'registered']) await refuse({isRegistered: async () => answer});
  await refuse({isRegistered: () => { throw new Error('registry unreadable'); }});
  await refuse({isRegistered: async () => { throw new Error('registry unreadable'); }});
  await refuse({isRegistered: () => Promise.reject(new Error('down'))});
  const calls = [];
  const {service} = stubService({capabilityReader: {isRegistered: async (...args) => { calls.push(args); return true; }}});
  assert.equal(await service.requireCapability(source), undefined);
  assert.deepEqual(calls, [[hash('s'), hash('e')]], 'asked once with the source hash and the effective input hash');
  // a synchronous true is accepted too
  await stubService({capabilityReader: {isRegistered: () => true}}).service.requireCapability(source);
  // the production wiring passes no reader: the default service refuses every v3 request
  assert.equal(new QuantResearchService({pineService: {db: {}, store: {}}, datasetStore: {}}).capabilityReader, null);
});

test('V3 static: the v3 module is a runtime manifest member and a pure module (V3-P14 closure rule: test/quant-engine-files.test.js)', async () => {
  assert.ok(QUANT_RUNTIME_ENGINE_FILES.includes('src/quant-research/research-contract-v3.js'));
  const fs = await import('node:fs/promises');
  const own = await fs.readFile(new URL('../src/quant-research/research-contract-v3.js', import.meta.url), 'utf8');
  const imports = [...own.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]);
  assert.deepEqual(imports, ['../pine-bridge/source.js', './foundation-contract-v2.js'], 'pure module: no database, file, clock or engine import');
  assert.ok(!/\bDate\b|Math\.random|randomUUID|node:fs|process\.env/.test(own), 'no clock, random source, file or environment read');
});
