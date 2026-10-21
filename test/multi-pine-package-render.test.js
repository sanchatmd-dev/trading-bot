import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {assemble} from '../src/pine-bridge/template.js';
import {RULES} from '../src/quant-research/contract.js';
import {fileEntries, scanContent, MULTI_PINE_CONTRACT_VERSION, MANIFEST_PATH} from '../src/quant-library/package-gates.js';
import {MULTI_RUN_ACCEPTANCE_BLOCKERS, validateMultiResearchContract} from '../src/multi-pine/run-contract.js';
import {deriveMultiTrace, MP_BASELINE_VERSION, MP_TRACE_PATHS, MP_TRACE_LIMITATION} from '../src/multi-pine/package-trace.js';
import {
  renderMultiPackage, multiPackageFiles, multiPackageFileCount, multiBindingComplete, MULTI_BINDING_FIELDS, PACKAGE_MARKET, RENDER_REFUSAL_CODES, TRACE_FORMAT_DESCRIPTION
} from '../src/multi-pine/package-render.js';

/*
 * F11 R6-1 (docs/MULTI_PINE_CONTRACT.md 6.1 and 6.2): the pure multi-Pine renderer. Every object below is a LABELLED ENGINEERING FIXTURE: a hand-built contract, three
 * stored holdout decisions and synthetic Pine sources. No database, no bars file, no Python. Expected hashes are written out with an independent canonical-JSON writer
 * and node:crypto, not with the module under test.
 */
const sha = text => createHash('sha256').update(text).digest('hex');
const ref = value => Array.isArray(value) ? '[' + value.map(ref).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + ref(value[key])).join(',') + '}' : JSON.stringify(value);
const clone = value => structuredClone(value);
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;

const M = 60_000, START = 29333333 * M, BARS = 5000;
const at = index => START + index * M;
const DEP = n => `0000000${n}-aaaa-4aaa-8aaa-00000000000${n}`;
const PINE = n => `1111111${n}-bbbb-4bbb-8bbb-11111111111${n}`;
const sourceOf = n => `//@version=5\nindicator("Fixture member ${n}", overlay=true)\nlen = input.int(${10 + n}, "Length")\nbuySignal = ta.crossover(close, ta.sma(close, len))\nsellSignal = ta.crossunder(close, ta.sma(close, len))\n`;
const POLICY = {paperTrading: true, requireReduceOnlySell: true, maxRiskPercent: 2};
const CLOSURE = sha('producer closure');
const EXPORT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CREATED = '2026-10-21T12:00:00Z';
const PAIR = {atr_multiplier: 2, rr: 1.5};
const SIGNALS = {buy: 'buySignal', exit: 'sellSignal'};
const refOf = (n, time) => DEP(n) + ':' + time + ':0';

function contractFor(count, sources, policy) {
  const members = Array.from({length: count}, (_, i) => i + 1).map(n => ({ordinal: n, pine_import_id: PINE(n), source_version: 1, source_hash: sha(sources[n]),
    effective_inputs_hash: sha('inputs-' + n), deployment_id: DEP(n), deployment_snapshot_hash: sha('snapshot-' + n), exit_version: 'bridge-exit-v2', evidence_hash: sha('evidence-' + n)}));
  return {version: MULTI_PINE_CONTRACT_VERSION, mode: 'MULTI_PINE', pine_count: count, member_set_id: '5b0c7a52-1d3e-4f60-8a71-2c9d4e6f8a01', set_hash: sha('set'),
    membership_hash: sha(ref(members.map(m => ({pine_import_id: m.pine_import_id, source_version: m.source_version, source_hash: m.source_hash})))), members,
    owner_id: 'owner-a', bot_id: 'bot-a', policy_hash: sha(ref(policy)), funding_cutoff: 7, capital: {equity: '1000', cash: '1000'},
    model: {version: 'paper-close-v1', price_tick: 0.01, quantity_step: 0.00001, fee_bps: 10, slippage_bps: 0, risk_percent: 1, data_profile: 'closed-ohlcv-atr14-v1'}, rules: clone(RULES),
    engine_hash: sha('engine'), dataset: {start_time: START, end_time: START + (BARS - 1) * M, warmup_bars: 500, bar_count: BARS, first_time: START,
      timestamp_semantics: 'verified closed-bar timestamps; half-open index end is last timestamp plus one minute', content_digest: sha('digest'), digest_version: 'pine-bar-content-digest-v1'},
    split: {warmup: 500, train_end: 3200, validation_end: 4100, test_end: 5000}, budget: {candidates: 30}, seed: 42,
    bridge_domains: {atr_multiplier: {min: '1', max: '3', step: '0.5'}, rr: {min: '0.5', max: '2.5', step: '0.5'}},
    same_bar_order: 'exit-first-ordinal-v1', fixture: true, acceptance_blockers: [...MULTI_RUN_ACCEPTANCE_BLOCKERS]};
}
/** The Python ledger prints a decimal with 18 places, and zero as 0E-18. The fixture stores decisions in that exact form. */
const py = value => { if (typeof value !== 'string') return value; if (/^0(?:.0*)?$/.test(value)) return '0E-18'; const [whole, fraction = ''] = value.split('.'); return whole + '.' + fraction.padEnd(18, '0'); };
const pyDecision = decision => Object.fromEntries(Object.entries(decision).map(([key, value]) => [key, ['quantity', 'price', 'notional', 'fee', 'cash', 'cost', 'realized_r'].includes(key) ? py(value) : value]));
/** Cash: 1000 - 300.3 = 699.7; + 304.695 = 1004.395. */
const decisionsFor = () => [
  {event_type: 'BUY', time: at(600), entry_ref: refOf(1, at(600)), sequence: 0, reason: null, sl: null, tp: null, outcome: 'FILLED', sizing_outcome: 'ACCEPTED', sizing_adjustment: null,
    quantity: '0.01', price: '30000', notional: '300', fee: '0.3', cash: '699.7', cost: '300.3', realized_r: '0'},
  {event_type: 'BUY', time: at(3300), entry_ref: refOf(2, at(3300)), sequence: 0, reason: 'MAX_OPEN_POSITIONS', sl: null, tp: null, outcome: 'REJECTED', quantity: '0', fee: '0'},
  {event_type: 'EXIT', time: at(4200), entry_ref: refOf(1, at(600)), sequence: 0, reason: 'TP', sl: null, tp: null, outcome: 'FILLED', sizing_outcome: 'ACCEPTED', sizing_adjustment: null,
    quantity: '0.01', price: '30500', notional: '305', fee: '0.305', cash: '1004.395', cost: '0', realized_r: '0.5'}].map(pyDecision);
const brief = tag => ({train: {closed_trades: 8, net_return_percent: '1.5', max_drawdown_percent: '0.5'}, validation: {closed_trades: 6, net_return_percent: '0.9', max_drawdown_percent: '0.4'},
  decision_count: 40, fills: 30, rejections: {}, exit_fill_reasons: {TP: 3}, ledger_hash: sha('ledger-' + tag)});

/** Holdout funnel diagnostics (MPC 5.7): one row per member in ordinal order plus the Bot row, as the executor stores them. */
const diagnosticsFor = contract => ({same_bar_order: contract.same_bar_order, cross_source_target: 0, duplicate_intents: 0,
  members: contract.members.map(m => ({ordinal: m.ordinal, deployment_id: m.deployment_id, native_signals: 10 + m.ordinal, accepted: m.ordinal, rejected: {MAX_OPEN_POSITIONS: 1}})),
  bot: {native_signals: 30, accepted: 3, rejected: {MAX_OPEN_POSITIONS: 2}}});

/** over: count, sources {n: text}, policy, edit(input). Returns the renderer input. */
function build(over = {}) {
  const count = over.count ?? 2, sources = {1: sourceOf(1), 2: sourceOf(2), 3: sourceOf(3), ...(over.sources ?? {})}, policy = over.policy ?? POLICY;
  const contract = contractFor(count, sources, policy), decisions = decisionsFor();
  const run_id = '9d8c7b6a-1111-4222-8333-444455556666', contract_hash = sha(ref(contract));
  const result = {version: 'mp-combined-result-v1', run_id, contract_hash, owner_recommendation_ready: false, acceptance_blockers: [...contract.acceptance_blockers],
    evaluator: 'mp-combined-paper-v1', engine_hash: contract.engine_hash, closure: {version: 'mp-combined-closure-v1', hash: contract.engine_hash}, set_hash: contract.set_hash,
    same_bar_order: contract.same_bar_order, fixture: true, search: {algorithm: 'seeded', seed: 42, budget: 30, planned: 30}, candidates: [],
    selected: {index: 0, parameters: clone(PAIR), ...brief('selected'), sensitivity: [{dimension: 'atr_multiplier', parameters: {atr_multiplier: 2.5, rr: 1.5}, ...brief('n1')},
      {dimension: 'rr', parameters: {atr_multiplier: 2, rr: 1}, ...brief('n2')}], cost_stress: brief('stress'), screen_reasons: [],
      test: {bars: 900, closed_trades: 1, start_equity: '1000', end_equity: '1004.395', net_return_percent: '0.4395', max_drawdown_percent: '0.4', profit_factor: null},
      holdout: {ledger_hash: sha('holdout ledger'), decision_count: 3, fills: 2}},
    holdout_evaluated: true, completion_reason: 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE', member_signals: [], funnel: {step: 'HOLDOUT', rows: BARS, diagnostics: diagnosticsFor(contract)}, holdout_decisions: decisions,
    combined_baseline: {version: MP_BASELINE_VERSION, binding: {run_id, contract_hash}, pair: clone(PAIR), same_bar_order: contract.same_bar_order, matched: true, differences: {},
      received_decisions_hash: sha(ref(decisions))}};
  const run = {owner_id: 'owner-a', bot_id: 'bot-a', run_id, contract, contract_hash, submission_hash: sha('submission'), result};
  const trace = deriveMultiTrace({run, producer_closure_hash: CLOSURE});
  const input = {export_id: EXPORT_ID, created_at: CREATED, fixture: true, run, policy: clone(policy), library_versions: {gates: 'best-inputs-gates-v1', render: 'multi-v1'},
    risk_limits: {maxRiskPercent: '2', maxOrderNotional: 1000}, producer_closure_hash: CLOSURE, members: Array.from({length: count}, (_, i) => ({ordinal: i + 1, source: sources[i + 1], signals: clone(SIGNALS)})), trace};
  over.edit?.(input);
  return input;
}
const render = (over, mutate) => renderMultiPackage(mutate ? (() => { const input = build(over); mutate(input); return input; })() : build(over));
/** Edit that keeps the contract hash, the result tie, the baseline tie and the trace consistent after the contract is edited. */
function rehash(input) {
  const run = input.run;
  run.contract_hash = sha(ref(run.contract));
  run.result.contract_hash = run.contract_hash;
  run.result.combined_baseline.binding.contract_hash = run.contract_hash;
  return input;
}
const refuses = (fn, code, pattern = /./) => assert.throws(fn, error => error.code === code && pattern.test(error.message), code + ' ' + pattern);

test('the fixture contracts are valid multi-Pine run contracts', () => {
  for (const count of [2, 3]) {
    const input = build({count});
    const checked = validateMultiResearchContract(input.run.contract);
    assert.equal(checked.ok, true, JSON.stringify(checked));
  }
  assert.deepEqual([...RENDER_REFUSAL_CODES], ['RENDER_INPUT_INVALID', 'RENDER_SOURCE_UNRESOLVED', 'RENDER_ASSEMBLE_FAILED', 'RENDER_CONTENT_REFUSED', 'BI_FIXTURE_LABEL_MISSING', 'BI_BINDING_INCOMPLETE']);
  assert.deepEqual({...PACKAGE_MARKET}, {broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'});
});

test('layout: 10 + 3 * pine_count files, in the canonical order, for two and for three members', () => {
  assert.equal(multiPackageFileCount(2), 16);
  assert.equal(multiPackageFileCount(3), 19);
  assert.deepEqual(multiPackageFiles(2), ['inputs.json', 'risk-profile.json', 'setup-guide.md', 'validation.html', 'members/1/indicator.pine', 'members/1/indicator.json', 'members/2/indicator.pine',
    'members/2/indicator.json', 'quant-data/manifest.json', 'quant-data/metrics.json', 'quant-data/equity.csv', 'quant-data/trades.csv', 'quant-data/decisions.csv', 'quant-data/validation.json',
    'quant-data/members/1/parity.json', 'quant-data/members/2/parity.json']);
  for (const count of [2, 3]) {
    const out = render({count});
    const expected = multiPackageFiles(count);
    assert.equal(expected.length, 10 + 3 * count);
    assert.deepEqual(Object.keys(out.files), expected);
    assert.equal(Object.keys(out.files).length, multiPackageFileCount(count));
    assert.equal(new Set(Object.keys(out.files)).size, expected.length);
    for (const text of Object.values(out.files)) assert.equal(typeof text, 'string');
    for (let n = 1; n <= count; n++) for (const path of ['members/' + n + '/indicator.pine', 'members/' + n + '/indicator.json', 'quant-data/members/' + n + '/parity.json']) assert.ok(path in out.files, path);
    assert.equal(out.manifest.files.length, expected.length - 1, 'the manifest lists every file except itself');
  }
  for (const bad of [0, 1, 4, 2.5, '2', null, undefined]) refuses(() => multiPackageFiles(bad), 'RENDER_INPUT_INVALID');
});

test('indicator.pine is assemble of the original bytes with the selected pair: the original bytes first, nothing else edited', () => {
  const input = build({count: 3}), out = renderMultiPackage(input);
  for (const member of input.members) {
    const n = member.ordinal, c = input.run.contract.members[n - 1];
    const expected = assemble(member.source, {bridge: {atr_multiplier: 2, rr: 1.5}, signals: {buy: 'buySignal', exit: 'sellSignal'}, bindings: [], fixed_inputs: []},
      {deployment_id: DEP(n), pine_import_id: PINE(n), source_version: 1, broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'}).integrated_pine;
    const actual = out.files['members/' + n + '/indicator.pine'];
    assert.equal(actual, expected);
    assert.ok(actual.startsWith(member.source), 'the original bytes are an unchanged prefix');
    assert.equal(sha(actual.slice(0, member.source.length)), c.source_hash, 'the prefix hashes to the frozen source_hash');
    // the Bridge defaults are the selected pair; nothing else of the source changed
    assert.match(actual.slice(member.source.length), /atrMult = input\.float\(2, "Bridge ATR Multiplier for SL"/);
    assert.match(actual.slice(member.source.length), /rr = input\.float\(1\.5, "Bridge Risk-to-Reward"/);
    assert.ok(actual.includes(DEP(n)) && !actual.includes(DEP(n === 1 ? 2 : 1)), 'each file names its own deployment only');
    assert.equal((actual.match(/\bindicator\s*\(/g) ?? []).length, 1);
    assert.doesNotMatch(actual, /\bstrategy\s*[(.]/);
  }
  // the pair changes only the Bridge defaults
  const other = render({count: 2}, i => { i.run.result.selected.parameters = {atr_multiplier: 2.5, rr: 1}; i.run.result.combined_baseline.pair = {atr_multiplier: 2.5, rr: 1}; i.trace = deriveMultiTrace({run: i.run, producer_closure_hash: CLOSURE}); });
  const base = out.files['members/1/indicator.pine'];
  assert.equal(other.files['members/1/indicator.pine'].slice(0, sourceOf(1).length), sourceOf(1));
  assert.match(other.files['members/1/indicator.pine'], /atrMult = input\.float\(2\.5,/);
  assert.notEqual(other.files['members/1/indicator.pine'], base);
});

test('T-K3: the actionable block of inputs.json holds exactly atr_multiplier and rr, and no source input', () => {
  const out = render({count: 2}), inputs = JSON.parse(out.files['inputs.json']);
  assert.deepEqual(Object.keys(inputs.bridge).sort(), ['atr_multiplier', 'rr']);
  assert.deepEqual(inputs.bridge.atr_multiplier, {after: '2', domain: {max: '3', min: '1', step: '0.5'}, unit: 'ATR multiple'});
  assert.deepEqual(inputs.bridge.rr, {after: '1.5', domain: {max: '2.5', min: '0.5', step: '0.5'}, unit: 'reward to risk ratio'});
  assert.deepEqual(inputs.source_inputs, []);
  assert.equal(inputs.mode, 'MULTI_PINE');
  assert.equal(inputs.pine_count, 2);
  assert.deepEqual(Object.keys(inputs).sort(), ['bridge', 'member_set_id', 'members', 'mode', 'pine_count', 'run_id', 'set_hash', 'source_inputs']);
  assert.deepEqual(inputs.members.map(m => Object.keys(m).sort()), [['deployment_id', 'effective_input_hash', 'ordinal', 'pine_import_id', 'source_hash', 'source_version'],
    ['deployment_id', 'effective_input_hash', 'ordinal', 'pine_import_id', 'source_hash', 'source_version']]);
  // member indicator.json: identity, exit version, alert source, no edits
  for (const n of [1, 2]) {
    const meta = JSON.parse(out.files['members/' + n + '/indicator.json']);
    assert.equal(meta.alert_source, 'alert_calls');
    assert.equal(meta.exit_version, 'bridge-exit-v2');
    assert.deepEqual(meta.edits, []);
    assert.equal(meta.deployment_id, DEP(n));
    assert.equal(meta.source_diff.changed_original_bytes, 0);
    assert.deepEqual(meta.bridge_defaults, PAIR);
    assert.deepEqual(meta.signals, SIGNALS);
    assert.equal(meta.indicator.name, 'Fixture member ' + n);
    assert.equal(meta.pine_version, 5);
    assert.equal(meta.source_diff.appended_bytes, Buffer.byteLength(out.files['members/' + n + '/indicator.pine']) - Buffer.byteLength(sourceOf(n)));
  }
});

test('deterministic: the same argument gives the same bytes, any key order and any member order gives the same bytes, and the argument is not mutated', () => {
  const input = build({count: 3}), before = JSON.stringify(input);
  const first = renderMultiPackage(input), second = renderMultiPackage(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual({...second.files}, {...first.files});
  assert.equal(second.package_hash, first.package_hash);
  assert.equal(second.binding_hash, first.binding_hash);
  const shuffled = reorder(clone(input));
  shuffled.members.reverse();
  const third = renderMultiPackage(shuffled);
  assert.deepEqual({...third.files}, {...first.files}, 'reversed key order and member order');
  assert.equal(third.package_hash, first.package_hash);
  assert.equal(third.binding_hash, first.binding_hash);
  assert.deepEqual(third.manifest, first.manifest);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.files) && Object.isFrozen(first.manifest) && Object.isFrozen(first.binding));
  for (const text of Object.values(first.files)) assert.ok(!text.includes('\r'), 'line feeds only');
});

test('a different export id or creation time changes the hashes and none of the indicator bytes; a different pair changes the package', () => {
  const base = render({count: 2});
  const otherId = render({count: 2}, i => { i.export_id = '11111111-2222-4333-8444-555555555555'; });
  assert.notEqual(otherId.package_hash, base.package_hash);
  assert.equal(otherId.binding_hash, base.binding_hash, 'the binding does not carry the export id');
  assert.equal(otherId.files['members/1/indicator.pine'], base.files['members/1/indicator.pine']);
  const later = render({count: 2}, i => { i.created_at = '2026-10-21T12:00:01Z'; });
  assert.notEqual(later.binding_hash, base.binding_hash);
  assert.notEqual(later.package_hash, base.package_hash);
  assert.equal(later.files['members/2/indicator.pine'], base.files['members/2/indicator.pine']);
});

test('binding: every field from the run, members as an array, input_lock_hash over the two domains and every member snapshot; the hashes are the canonical SHA-256', () => {
  const input = build({count: 2}), out = renderMultiPackage(input), contract = input.run.contract, b = out.binding;
  assert.equal(multiBindingComplete(b), true);
  assert.deepEqual(Object.keys(b).sort(), [...MULTI_BINDING_FIELDS].sort());
  assert.equal(b.mode, 'MULTI_PINE');
  assert.equal(b.pine_count, 2);
  assert.equal(b.member_set_id, contract.member_set_id);
  assert.equal(b.set_hash, contract.set_hash);
  assert.equal(b.membership_hash, contract.membership_hash);
  assert.equal(b.same_bar_order, 'exit-first-ordinal-v1');
  assert.deepEqual(b.bridge_pair, PAIR);
  assert.equal(b.exit_version, 'bridge-exit-v2');
  assert.equal(b.alert_source, 'alert_calls');
  assert.equal(b.fixture, true);
  assert.equal(b.created_at, CREATED);
  assert.equal(b.engine_hash, contract.engine_hash);
  assert.equal(b.policy_hash, contract.policy_hash);
  assert.deepEqual(b.market, PACKAGE_MARKET);
  assert.equal(b.cost_model_version, 'paper-close-v1');
  assert.equal(b.owner_id, 'owner-a');
  assert.equal(b.contract_hash, input.run.contract_hash);
  assert.equal(b.submission_hash, input.run.submission_hash);
  assert.equal(b.library_record_ref.result_sha256, sha(ref(input.run.result)));
  assert.deepEqual(b.members.map(m => m.ordinal), [1, 2]);
  for (const m of b.members) {
    const c = contract.members[m.ordinal - 1];
    assert.deepEqual(m, {ordinal: c.ordinal, deployment_id: c.deployment_id, pine_import_id: c.pine_import_id, source_version: c.source_version, source_hash: c.source_hash,
      baseline_snapshot_hash: c.deployment_snapshot_hash, effective_input_hash: c.effective_inputs_hash, evidence_hash: c.evidence_hash, exit_version: 'bridge-exit-v2'});
  }
  assert.equal(b.input_lock_hash, sha(ref({bridge_domains: contract.bridge_domains, members: contract.members.map(c => ({ordinal: c.ordinal, effective_input_hash: c.effective_inputs_hash,
    deployment_snapshot_hash: c.deployment_snapshot_hash}))})));
  assert.equal(out.binding_hash, sha(ref(b)));
  assert.equal(out.package_hash, sha(ref(out.manifest)));
  assert.deepEqual(out.manifest.binding, b);
  // a new frozen member snapshot changes the lock hash and the binding hash
  const moved = render({count: 2}, i => { i.run.contract.members[1].deployment_snapshot_hash = sha('other snapshot'); rehash(i); });
  assert.notEqual(moved.binding.input_lock_hash, b.input_lock_hash);
  assert.notEqual(moved.binding_hash, out.binding_hash);
  // the optional boundary reference is carried and is part of the binding
  const bounded = render({count: 2}, i => { i.holdout_boundary_ref = {boundary: 'registered', at: 1}; });
  assert.deepEqual(bounded.binding.holdout_boundary_ref, {boundary: 'registered', at: 1});
  assert.notEqual(bounded.binding_hash, out.binding_hash);
});

test('manifest: checksums over every file but the manifest, member files included; mode, counts, trace records and the limitation codes', () => {
  const input = build({count: 3}), out = renderMultiPackage(input);
  const expected = Object.keys(out.files).filter(path => path !== MANIFEST_PATH).sort().map(path => ({path, sha256: sha(out.files[path]), bytes: Buffer.byteLength(out.files[path])}));
  assert.deepEqual(out.manifest.files, expected);
  assert.deepEqual(out.manifest.files, fileEntries(out.files));
  assert.equal(out.manifest.files.length, 18);
  for (const n of [1, 2, 3]) for (const path of ['members/' + n + '/indicator.pine', 'members/' + n + '/indicator.json', 'quant-data/members/' + n + '/parity.json'])
    assert.ok(out.manifest.files.some(entry => entry.path === path), path);
  assert.equal(out.manifest.inputs.inputs_sha256, sha(out.files['inputs.json']));
  assert.equal(out.manifest.fixture, true);
  assert.equal(out.manifest.schema_version, 'best-inputs-manifest-v1');
  const evidence = out.manifest.evidence;
  assert.equal(evidence.mode, 'MULTI_PINE');
  assert.equal(evidence.pine_count, 3);
  assert.equal(evidence.membership_hash, input.run.contract.membership_hash);
  assert.equal(evidence.set_hash, input.run.contract.set_hash);
  assert.equal(evidence.engine_hash, input.run.contract.engine_hash);
  assert.equal(evidence.result_sha256, sha(ref(input.run.result)));
  assert.deepEqual(evidence.member_counts.map(m => [m.ordinal, m.decisions, m.fills]), [[1, 2, 2], [2, 1, 0], [3, 0, 0]]);
  assert.equal(evidence.trace_records.length, 3);
  for (const record of evidence.trace_records) assert.equal(record.sha256, sha(out.files[record.path]));
  assert.deepEqual(out.manifest.limitations.codes, ['MP_TRACE_STEPS_NOT_REEVALUATED']);
  assert.match(out.manifest.limitations.text, /Labelled engineering fixture/);
  // caller limitation codes are merged, sorted and unique
  const merged = render({count: 2}, i => { i.limitations = {codes: ['RULES_VERSION_DIFFERS', 'MP_TRACE_STEPS_NOT_REEVALUATED']}; });
  assert.deepEqual(merged.manifest.limitations.codes, ['MP_TRACE_STEPS_NOT_REEVALUATED', 'RULES_VERSION_DIFFERS']);
  assert.notEqual(merged.package_hash, out.package_hash);
});

test('quant-data: metrics are per Bot, validation holds the stored steps and the baseline, the trace files are the producer bytes, parity is not recorded at build', () => {
  const input = build({count: 2}), out = renderMultiPackage(input), selected = input.run.result.selected;
  assert.deepEqual(JSON.parse(out.files['quant-data/metrics.json']), {train: selected.train, validation: selected.validation, test: selected.test});
  const validation = JSON.parse(out.files['quant-data/validation.json']);
  assert.equal(validation.mode, 'MULTI_PINE');
  assert.deepEqual(validation.candidate.parameters, PAIR);
  assert.deepEqual(validation.sensitivity, selected.sensitivity);
  assert.deepEqual(validation.cost_stress, selected.cost_stress);
  assert.deepEqual(validation.holdout, {test: selected.test, step: selected.holdout});
  assert.equal(validation.combined_baseline.matched, true);
  assert.equal(validation.trace.method, 'stored-holdout-decisions-v1');
  assert.deepEqual(validation.parity, {state: 'NOT_RECORDED_AT_BUILD'});
  for (const path of Object.values(MP_TRACE_PATHS)) assert.equal(out.files[path], input.trace.files[path]);
  const lines = out.files['quant-data/decisions.csv'].split('\n');
  assert.equal(lines[0].endsWith(',deployment_id,ordinal'), true);
  for (const n of [1, 2]) {
    const parity = JSON.parse(out.files['quant-data/members/' + n + '/parity.json']);
    assert.deepEqual(parity, {bridge_evidence_hash: sha('evidence-' + n), deployment_id: DEP(n), effective_input_hash: sha('inputs-' + n), ordinal: n, pine_import_id: PINE(n),
      source_hash: sha(sourceOf(n)), state: 'NOT_RECORDED_AT_BUILD'});
  }
  const risk = JSON.parse(out.files['risk-profile.json']);
  assert.deepEqual(risk, {limits: {maxOrderNotional: '1000', maxRiskPercent: '2'}, policy: POLICY, policy_hash: input.run.contract.policy_hash});
});

test('setup guide and validation page list every member script, one alert per member deployment, the fixture label, and escape their text', () => {
  const out = render({count: 3}), guide = out.files['setup-guide.md'], page = out.files['validation.html'];
  for (const n of [1, 2, 3]) {
    assert.ok(guide.includes('members/' + n + '/indicator.pine'), 'guide names member ' + n);
    assert.ok(guide.includes(DEP(n)), 'guide names deployment ' + n);
    assert.ok(page.includes(DEP(n)) && page.includes(sha(sourceOf(n))), 'page lists member ' + n);
  }
  assert.match(guide, /exactly one alert per member deployment, 3 alerts in all/);
  assert.match(guide, /LABELLED ENGINEERING FIXTURE/);
  assert.match(page, /LABELLED ENGINEERING FIXTURE/);
  assert.match(guide, new RegExp('Export ' + EXPORT_ID));
  assert.match(page, /Not recorded at build/);
  assert.match(page, /derived from the stored holdout decisions/);
  assert.ok(guide.endsWith('\n') && page.endsWith('\n'));
  // a hostile indicator title cannot inject markup
  const hostile = render({count: 2, sources: {1: sourceOf(1).replace('Fixture member 1', '<b>x</b> *bold* [l](u)')}});
  assert.ok(!hostile.files['setup-guide.md'].includes('<b>'));
  assert.match(hostile.files['setup-guide.md'], /&lt;b&gt;x&lt;\/b&gt; \\\*bold\\\*/);
  assert.ok(!hostile.files['validation.html'].includes('<b>x'));
});

test('content scan: a secret, a machine path, a bearer URL or a second indicator in a member source refuses the whole package', () => {
  const secret = '\n// api_key = "abcdef0123456789abcdef"\n';
  refuses(() => render({sources: {2: sourceOf(2) + secret}}), 'RENDER_CONTENT_REFUSED', /BI_SECRET_DETECTED/);
  refuses(() => render({sources: {1: sourceOf(1) + '\n// C:\\Users\\someone\\notes.txt\n'}}), 'RENDER_CONTENT_REFUSED', /BI_MACHINE_PATH_DETECTED/);
  refuses(() => render({sources: {1: sourceOf(1) + '\n// see /home/someone/file\n'}}), 'RENDER_CONTENT_REFUSED', /BI_MACHINE_PATH_DETECTED/);
  refuses(() => render({sources: {2: sourceOf(2) + '\n// https://hook.example.test/aaaaaaaaaaaaaaaaaaaa1\n'}}), 'RENDER_CONTENT_REFUSED', /BI_SECRET_DETECTED/);
  refuses(() => render({sources: {1: sourceOf(1) + 'indicator("again")\n'}}), 'RENDER_CONTENT_REFUSED', /INDICATOR_REQUIRED/);
  refuses(() => render({sources: {1: sourceOf(1).replace('indicator(', 'strategy(')}}), 'RENDER_CONTENT_REFUSED', /INDICATOR_REQUIRED/);
  // the policy and the limits travel into risk-profile.json and are scanned too
  refuses(() => render({policy: {...POLICY, note: 'password: abcdefghijklmnop12345'}}), 'RENDER_CONTENT_REFUSED', /BI_SECRET_DETECTED/);
  refuses(() => render({policy: {...POLICY, note: 'C:\\Windows\\secret'}}), 'RENDER_CONTENT_REFUSED', /BI_MACHINE_PATH_DETECTED/);
  // every output of a good render passes the same scan
  const out = render({count: 3});
  for (const [path, text] of Object.entries(out.files)) assert.deepEqual(scanContent(text), [], path);
});

test('refusals: a package is never created from input the renderer cannot render without inventing a value', () => {
  refuses(() => renderMultiPackage(null), 'RENDER_INPUT_INVALID');
  refuses(() => renderMultiPackage(undefined), 'RENDER_INPUT_INVALID');
  refuses(() => renderMultiPackage([]), 'RENDER_INPUT_INVALID');
  refuses(() => render({}, i => { i.fixture = false; }), 'BI_FIXTURE_LABEL_MISSING');
  refuses(() => render({}, i => { i.fixture = 'true'; }), 'RENDER_INPUT_INVALID', /fixture/);
  refuses(() => render({}, i => { delete i.fixture; }), 'RENDER_INPUT_INVALID', /fixture/);
  refuses(() => render({}, i => { i.export_id = 'not-a-uuid'; }), 'RENDER_INPUT_INVALID', /export_id/);
  for (const stamp of ['2026-10-21', '2026-02-30T00:00:00Z', '2026-10-21T24:00:00Z', 5, null, '2026-10-21T12:00:00+00:00'])
    refuses(() => render({}, i => { i.created_at = stamp; }), 'RENDER_INPUT_INVALID', /created_at/);
  for (const key of ['library_versions', 'risk_limits', 'run', 'policy', 'members', 'trace']) refuses(() => render({}, i => { delete i[key]; }), 'RENDER_INPUT_INVALID', new RegExp(key));
  refuses(() => render({}, i => { i.risk_limits = {}; }), 'RENDER_INPUT_INVALID', /risk_limits/);
  refuses(() => render({}, i => { i.risk_limits = {maxRiskPercent: 'a lot'}; }), 'RENDER_INPUT_INVALID', /risk_limits/);
  refuses(() => render({}, i => { i.limitations = {codes: ['lower case']}; }), 'RENDER_INPUT_INVALID', /limitations/);
  refuses(() => render({}, i => { i.holdout_boundary_ref = []; }), 'RENDER_INPUT_INVALID', /holdout_boundary_ref/);
  // the run
  refuses(() => render({}, i => { i.run.contract_hash = sha('other'); }), 'RENDER_INPUT_INVALID', /contract_hash/);
  refuses(() => render({}, i => { i.run.submission_hash = 'x'; }), 'RENDER_INPUT_INVALID', /submission_hash/);
  refuses(() => render({}, i => { i.run.contract.version = 'ql3a-research-job-v2'; rehash(i); }), 'RENDER_INPUT_INVALID', /multi-Pine fixture contract/);
  refuses(() => render({}, i => { i.run.contract.fixture = false; rehash(i); }), 'RENDER_INPUT_INVALID', /multi-Pine fixture contract/);
  refuses(() => render({}, i => { i.run.contract.pine_count = 3; rehash(i); }), 'RENDER_INPUT_INVALID', /pine_count/);
  refuses(() => render({}, i => { i.run.contract.members[1].ordinal = 5; rehash(i); }), 'RENDER_INPUT_INVALID', /ordinal/);
  refuses(() => render({}, i => { i.policy = {...POLICY, maxRiskPercent: 3}; }), 'RENDER_INPUT_INVALID', /policy/);
  refuses(() => render({}, i => { i.run.result.holdout_evaluated = false; }), 'RENDER_INPUT_INVALID', /finished holdout result/);
  refuses(() => render({}, i => { i.run.result.run_id = 'other'; }), 'RENDER_INPUT_INVALID', /finished holdout result/);
  refuses(() => render({}, i => { delete i.run.result.selected.sensitivity; }), 'RENDER_INPUT_INVALID', /incomplete/);
  refuses(() => render({}, i => { i.run.result.selected.parameters = {atr_multiplier: 2, rr: 1.5, extra: 1}; }), 'RENDER_INPUT_INVALID', /exactly atr_multiplier and rr/);
  refuses(() => render({}, i => { i.run.result.selected.parameters = {atr_multiplier: 2, rr: '1.5'}; }), 'RENDER_INPUT_INVALID', /exactly atr_multiplier and rr/);
  refuses(() => render({}, i => { i.run.result.selected.parameters = {atr_multiplier: 0, rr: 1.5}; }), 'RENDER_INPUT_INVALID', /exactly atr_multiplier and rr/);
  refuses(() => render({}, i => { i.run.result.selected.parameters = {atr_multiplier: NaN, rr: 1.5}; }), 'RENDER_INPUT_INVALID', /exactly atr_multiplier and rr/);
  // undefined or functions inside stored data are not plain data
  refuses(() => render({}, i => { i.run.result.selected.cost_stress.extra = undefined; }), 'RENDER_INPUT_INVALID', /not plain data/);
  refuses(() => render({}, i => { i.run.result.selected.cost_stress.extra = () => 1; }), 'RENDER_INPUT_INVALID', /not plain data/);
  // one member source per contract member, each hash-bound
  refuses(() => render({}, i => { i.members.pop(); }), 'RENDER_INPUT_INVALID', /members count/);
  refuses(() => render({}, i => { i.members[1].ordinal = 1; }), 'RENDER_INPUT_INVALID', /ordinal/);
  refuses(() => render({}, i => { i.members[1].ordinal = 3; }), 'RENDER_INPUT_INVALID', /missing/);
  refuses(() => render({}, i => { i.members[0].source = ''; }), 'RENDER_INPUT_INVALID', /source and signals/);
  refuses(() => render({}, i => { i.members[0].signals = {buy: 'buySignal'}; }), 'RENDER_INPUT_INVALID', /signals\.exit/);
  refuses(() => render({}, i => { i.members[0].signals.buy = 'not a name'; }), 'RENDER_INPUT_INVALID', /signals\.buy/);
  refuses(() => render({}, i => { i.members[1].source += ' '; }), 'RENDER_SOURCE_UNRESOLVED', /member 2/);
  refuses(() => render({}, i => { i.members[0].source = sourceOf(2); }), 'RENDER_SOURCE_UNRESOLVED', /member 1/);
});

test('refusals: the exit version, the trace and the binding', () => {
  refuses(() => render({}, i => { delete i.run.contract.members[0].exit_version; rehash(i); }), 'BI_BINDING_INCOMPLETE', /exit_version/);
  refuses(() => render({}, i => { i.run.contract.members[0].exit_version = 'bridge-exit-v9'; i.run.contract.members[1].exit_version = 'bridge-exit-v9'; rehash(i); }), 'RENDER_INPUT_INVALID', /exit_version/);
  refuses(() => render({}, i => { i.run.contract.members[1].exit_version = 'bridge-exit-v1'; rehash(i); }), 'RENDER_INPUT_INVALID', /exit_version/);
  for (const field of ['deployment_snapshot_hash', 'effective_inputs_hash']) refuses(() => render({}, i => { delete i.run.contract.members[1][field]; rehash(i); }), 'BI_BINDING_INCOMPLETE', /snapshot_hash|effective_input_hash/);
  for (const field of ['evidence_hash', 'source_version', 'pine_import_id', 'deployment_id']) refuses(() => render({}, i => { delete i.run.contract.members[0][field]; rehash(i); }), 'BI_BINDING_INCOMPLETE');
  refuses(() => render({}, i => { i.run.contract.members[0].evidence_hash = 'short'; rehash(i); }), 'BI_BINDING_INCOMPLETE');
  refuses(() => render({}, i => { i.run.contract.funding_cutoff = -1; rehash(i); }), 'BI_BINDING_INCOMPLETE');
  refuses(() => render({}, i => { i.run.contract.set_hash = 'x'; rehash(i); }), 'BI_BINDING_INCOMPLETE');
  refuses(() => render({}, i => { i.library_versions = []; }), 'RENDER_INPUT_INVALID', /library_versions/);
  // the trace must be the producer's output for this run
  refuses(() => render({}, i => { i.trace = {...i.trace, files: {...i.trace.files, [MP_TRACE_PATHS.equity]: i.trace.files[MP_TRACE_PATHS.equity] + '\n'}}; }), 'RENDER_INPUT_INVALID', /trace record for/);
  refuses(() => render({}, i => { i.trace = {...i.trace, records: i.trace.records.slice(1)}; }), 'RENDER_INPUT_INVALID', /trace\.records/);
  refuses(() => render({}, i => { const { [MP_TRACE_PATHS.trades]: _gone, ...files } = i.trace.files; i.trace = {...i.trace, files}; }), 'RENDER_INPUT_INVALID', /trace\.files/);
  refuses(() => render({}, i => { i.trace = {...i.trace, records: i.trace.records.map(r => ({...r, run_engine_hash: sha('other')}))}; }), 'RENDER_INPUT_INVALID', /trace record for/);
  refuses(() => render({}, i => { i.trace = {...i.trace, records: i.trace.records.map(r => ({...r, decisions_hash: sha('other')}))}; }), 'RENDER_INPUT_INVALID', /trace record for/);
  refuses(() => render({}, i => { i.trace = {...i.trace, records: i.trace.records.map(r => ({...r, method: 'reevaluated'}))}; }), 'RENDER_INPUT_INVALID', /trace record for/);
  refuses(() => render({}, i => { i.trace = {...i.trace, counts: {members: [i.trace.counts.members[0]]}}; }), 'RENDER_INPUT_INVALID', /trace\.counts/);
  refuses(() => render({}, i => { i.trace = {...i.trace, limitation_codes: ['not a code']}; }), 'RENDER_INPUT_INVALID', /limitation_codes/);
  // a trace of another run's decisions is refused through the baseline identity hash
  refuses(() => render({}, i => { i.run.result.combined_baseline.received_decisions_hash = sha('changed decisions'); }), 'RENDER_INPUT_INVALID', /trace record for/);
});

test('one-Pine regression: the renderer of the one-Pine package is a separate module with its own refusal for multi membership, and no file of it is edited here', () => {
  const source = fs.readFileSync(new URL('../src/quant-library/package-render.js', import.meta.url), 'utf8');
  assert.match(source, /RENDER_MULTI_PINE_UNSUPPORTED/);
});

test('purity: no clock, random source, file, network or process access, and only the known pure modules are imported', () => {
  const source = fs.readFileSync(new URL('../src/multi-pine/package-render.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now|new Date|Math\.random|randomUUID|node:fs|node:net|node:http|node:child_process|fetch\(|process\.|setTimeout|require\(|import\(/);
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]).sort();
  assert.deepEqual(imports, ['../pine-bridge/source.js', '../pine-bridge/template.js', '../quant-library/package-gates.js', './codes.js', './package-trace.js']);
  assert.doesNotMatch(source, /mp-run-store|mp_research_run|postgres|combined-oracle/);
});

test('B1: the manifest evidence and validation.json carry the HOLDOUT funnel member counts (MPC 5.7) next to the decision and fill counts', () => {
  const input = build({count: 3}), out = renderMultiPackage(input), funnel = input.run.result.funnel;
  assert.deepEqual(out.manifest.evidence.member_funnel, {step: 'HOLDOUT', diagnostics: funnel.diagnostics});
  assert.equal(out.manifest.evidence.member_funnel.diagnostics.members.length, 3);
  assert.deepEqual(out.manifest.evidence.member_funnel.diagnostics.bot, funnel.diagnostics.bot);
  assert.ok(Array.isArray(out.manifest.evidence.member_counts), 'the decision and fill counts stay');
  assert.deepEqual(JSON.parse(out.files['quant-data/validation.json']).funnel, {step: 'HOLDOUT', diagnostics: funnel.diagnostics});
  // the funnel is part of the stored result, so another funnel is another package
  const other = render({count: 3}, i => { i.run.result.funnel.diagnostics.bot.accepted = 99; });
  assert.notEqual(other.package_hash, out.package_hash);
  // a funnel that is missing, not the HOLDOUT step, or without member and Bot diagnostics is refused
  const funnelRefusal = /HOLDOUT funnel/;
  refuses(() => render({}, i => { delete i.run.result.funnel; }), 'RENDER_INPUT_INVALID', funnelRefusal);
  refuses(() => render({}, i => { i.run.result.funnel = null; }), 'RENDER_INPUT_INVALID', funnelRefusal);
  refuses(() => render({}, i => { i.run.result.funnel.step = 'CANDIDATE'; }), 'RENDER_INPUT_INVALID', funnelRefusal);
  refuses(() => render({}, i => { delete i.run.result.funnel.diagnostics; }), 'RENDER_INPUT_INVALID', funnelRefusal);
  refuses(() => render({}, i => { i.run.result.funnel.diagnostics = {}; }), 'RENDER_INPUT_INVALID', funnelRefusal);
  refuses(() => render({}, i => { delete i.run.result.funnel.diagnostics.bot; }), 'RENDER_INPUT_INVALID', funnelRefusal);
  refuses(() => render({}, i => { i.run.result.funnel.diagnostics.members.pop(); }), 'RENDER_INPUT_INVALID', funnelRefusal);
});

test('N2: the renderer re-derives the trace and refuses any trace that differs, even one whose record hashes were recomputed', () => {
  // edited CSV bytes with a recomputed sha256 in the record
  refuses(() => render({}, i => {
    const path = MP_TRACE_PATHS.equity, files = {...i.trace.files, [path]: i.trace.files[path].replace('699.700000000000000000', '699.800000000000000000')};
    i.trace = {...i.trace, files, records: i.trace.records.map(r => r.path === path ? {...r, sha256: sha(files[path])} : r)};
  }), 'RENDER_INPUT_INVALID', /trace differs from the derivation/);
  // an edited steps digest or holdout digest on all three records
  for (const key of ['steps_digest', 'holdout_digest']) refuses(() => render({}, i => { i.trace = {...i.trace, records: i.trace.records.map(r => ({...r, [key]: sha('forged')}))}; }),
    'RENDER_INPUT_INVALID', /trace differs from the derivation/);
  // a counts entry that is well formed but wrong
  refuses(() => render({}, i => { i.trace = {...i.trace, counts: {...i.trace.counts, members: i.trace.counts.members.map(m => ({...m, fills: m.fills + 1}))}}; }), 'RENDER_INPUT_INVALID', /trace differs from the derivation/);
  // the closure hash: the record must carry the caller's producer closure hash, and the hash must be a SHA-256
  refuses(() => render({}, i => { i.producer_closure_hash = sha('another closure'); }), 'RENDER_INPUT_INVALID', /trace differs from the derivation/);
  for (const bad of [undefined, 'abc', CLOSURE.toUpperCase()]) refuses(() => render({}, i => { i.producer_closure_hash = bad; }), 'RENDER_INPUT_INVALID', /producer_closure_hash/);
  // a run the producer refuses is a renderer refusal, not a thrown producer error
  refuses(() => render({}, i => { i.run.result.holdout_decisions[0].cash = '699.700000000000000001'; i.run.result.combined_baseline.received_decisions_hash = sha(ref(i.run.result.holdout_decisions)); }),
    'RENDER_INPUT_INVALID', /trace/);
  // the merged limitation codes must contain MP_TRACE_STEPS_NOT_REEVALUATED
  refuses(() => render({}, i => { i.trace = {...i.trace, limitation_codes: []}; }), 'RENDER_INPUT_INVALID', /MP_TRACE_STEPS_NOT_REEVALUATED/);
  refuses(() => render({}, i => { i.trace = {...i.trace, limitation_codes: ['OTHER_CODE']}; }), 'RENDER_INPUT_INVALID', /MP_TRACE_STEPS_NOT_REEVALUATED/);
  assert.ok(render({}).manifest.limitations.codes.includes(MP_TRACE_LIMITATION));
  assert.ok(render({}, i => { i.limitations = {codes: ['RULES_VERSION_DIFFERS']}; }).manifest.limitations.codes.includes(MP_TRACE_LIMITATION));
});

test('N3: the run owner_id and bot_id must equal the contract owner_id and bot_id', () => {
  refuses(() => render({}, i => { i.run.owner_id = 'owner-b'; }), 'RENDER_INPUT_INVALID', /owner_id and bot_id/);
  refuses(() => render({}, i => { i.run.bot_id = 'bot-b'; }), 'RENDER_INPUT_INVALID', /owner_id and bot_id/);
  const out = render({});
  assert.equal(out.binding.owner_id, 'owner-a');
  assert.equal(out.manifest.identity.bot_id, 'bot-a');
});

test('N5: the number formats are stated in the manifest and pinned: stored Python 18-decimal strings for cash, quantity, price and fee, money.js minimal form for net, position_quantity and equity_at_fill', () => {
  const out = render({count: 2});
  assert.equal(out.manifest.evidence.trace_formats, TRACE_FORMAT_DESCRIPTION);
  assert.ok(out.manifest.evidence.trace_semantics.includes(TRACE_FORMAT_DESCRIPTION));
  assert.match(TRACE_FORMAT_DESCRIPTION, /18-decimal/);
  assert.match(TRACE_FORMAT_DESCRIPTION, /net, position_quantity and equity_at_fill/);
  const line = text => text.split('\n')[1].split(',');
  const equity = line(out.files['quant-data/equity.csv']);
  assert.equal(equity[4], '699.700000000000000000', 'cash: the stored Python string');
  assert.equal(equity[5], '0.01', 'position_quantity: minimal form');
  assert.equal(equity[6], '999.7', 'equity_at_fill: minimal form');
  const trade = line(out.files['quant-data/trades.csv']);
  assert.equal(trade[4], '30000.000000000000000000', 'entry_price: the stored Python string');
  assert.equal(trade[5], '0.010000000000000000', 'quantity: the stored Python string');
  assert.equal(trade[6], '0.300000000000000000', 'entry_fee: the stored Python string');
  assert.equal(trade[12], '4.395', 'net: minimal form');
  assert.equal(trade[13], '0.500000000000000000', 'realized_r: the stored Python string');
  const decisions = out.files['quant-data/decisions.csv'].split('\n');
  assert.deepEqual(decisions[1].split(',').slice(8, 11), ['0.010000000000000000', '30000.000000000000000000', '0.300000000000000000'], 'decision quantity, price, fee');
  assert.match(decisions[2], /,0E-18,,0E-18,/, 'a rejected decision keeps the stored zero form and an empty price');
});

test('R3: the binding has slot_bindings as an empty list and neither policy_version nor ledger_initialization', () => {
  const out = render({count: 3});
  assert.deepEqual(out.binding.slot_bindings, []);
  assert.ok(!('policy_version' in out.binding) && !('ledger_initialization' in out.binding));
  assert.ok(MULTI_BINDING_FIELDS.includes('slot_bindings') && !MULTI_BINDING_FIELDS.includes('policy_version') && !MULTI_BINDING_FIELDS.includes('ledger_initialization'));
  assert.deepEqual(out.manifest.binding.slot_bindings, []);
  assert.equal(multiBindingComplete({...out.binding, slot_bindings: undefined}), false);
  assert.equal(multiBindingComplete({...out.binding, slot_bindings: [{slot: 'x'}]}), false);
});
