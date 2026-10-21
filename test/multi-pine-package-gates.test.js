import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import * as G from '../src/multi-pine/package-gates.js';
import * as ONE from '../src/quant-library/package-gates.js';
import {QUALIFIED_TOTAL} from '../src/quant-library/derive.js';
import {renderMultiPackage, multiPackageFiles} from '../src/multi-pine/package-render.js';
import {deriveMultiTrace, MP_TRACE_PATHS, MP_TRACE_METHOD} from '../src/multi-pine/package-trace.js';
import {MP_COMBINED_ONLY_FILES, MP_COMBINED_ENGINE_FILES} from '../src/multi-pine/engine-closure.js';
import {MULTI_RUN_ACCEPTANCE_BLOCKERS} from '../src/multi-pine/run-contract.js';
import {MP_CODES} from '../src/multi-pine/codes.js';

/*
 * F11 R6-2 (docs/MULTI_PINE_CONTRACT.md 6.3, RD-MP-37, RD-MP-38): the pure multi-Pine gate module. Every object here is a LABELLED ENGINEERING FIXTURE built from
 * test/fixtures/mp-combined/package-golden-v1.json: a hand-made contract, synthetic holdout decisions and synthetic Pine sources. No database, no bars file, no Python, no network.
 * Expected hashes come from the independent canonical writer below and node:crypto, not from the module under test.
 */
const MANIFEST = 'quant-data/manifest.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const ref = value => Array.isArray(value) ? '[' + value.map(ref).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + ref(value[key])).join(',') + '}' : JSON.stringify(value);
const clone = value => structuredClone(value);
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
const jsonText = value => JSON.stringify(sortKeys(value), null, 2) + '\n';

const RAW = fs.readFileSync(new URL('./fixtures/mp-combined/package-golden-v1.json', import.meta.url), 'utf8');
const golden = JSON.parse(RAW);
const RI = golden.render_input;
const M = 60_000, START = 29333333 * M, at = index => START + index * M;
const HOLDOUT_WINDOW = {start_time: at(4100), end_time: at(4999)};
const MARKET = {broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'};
const TRACE = deriveMultiTrace({run: {...clone(RI.run), ...golden.run_view}, producer_closure_hash: RI.producer_closure_hash});
const SEEN = new Set();

/** A fresh, fully consistent subject for evaluateMultiPackage and every gate. */
function fresh() {
  const run = {...clone(RI.run), ...clone(golden.run_view)};
  const s = {owner_id: 'owner-a', run, internal: true, holdout: clone(golden.holdout), deployments: clone(golden.deployments), current_rules: clone(golden.current_rules),
    files: clone(golden.rendered.files), package_hash: golden.rendered.package_hash, binding_hash: golden.rendered.binding_hash, export_id: RI.export_id,
    export: {library_versions: clone(RI.library_versions)}, member_sources: clone(RI.members), compile_records: clone(golden.compile_records),
    native_alert_isolation: clone(golden.native_alert_isolation), evidence: clone(golden.evidence), clearances: clone(golden.clearances), current: clone(golden.current),
    hard_limits: clone(golden.hard_limits), bridge_bounds: clone(golden.bridge_bounds), dataset: clone(golden.dataset), trace_reproduction: clone(TRACE.records),
    attempt: clone(golden.attempt), attempt_no: 1, replay_mismatch: false};
  s.binding = JSON.parse(s.files[MANIFEST]).binding;
  return s;
}
/** Recomputes the manifest file list, the package hash and the binding hash after a file edit, so only the intended gate sees the change. */
function seal(s) {
  const manifest = JSON.parse(s.files[MANIFEST]);
  manifest.files = ONE.fileEntries(s.files);
  s.files[MANIFEST] = jsonText(manifest);
  s.package_hash = ONE.packageHash(manifest);
  s.binding_hash = ONE.bindingHash(manifest.binding);
  s.binding = manifest.binding;
  return s;
}
const jsonEdit = (s, path, fn) => { const value = JSON.parse(s.files[path]); fn(value); s.files[path] = jsonText(value); return s; };
const edit = (s, path, fn) => seal(jsonEdit(s, path, fn));
const bindingEdit = (s, fn) => edit(s, MANIFEST, manifest => fn(manifest.binding));
/** After a contract edit: keep the contract hash, the result tie and the baseline tie consistent. */
function rehash(s) {
  const run = s.run;
  run.contract_hash = sha(ref(run.contract));
  run.result.contract_hash = run.contract_hash;
  run.result.combined_baseline.binding.contract_hash = run.contract_hash;
  return s;
}
/** Edits the stored snapshot of deployment i and keeps everything bound to it consistent: the member snapshot hash, the contract hash and its ties, and the current input lock. */
function snapshotEdit(s, index, fn) {
  const deployment = s.deployments[index];
  fn(deployment.snapshot);
  const contract = s.run.contract;
  contract.members.find(member => member.deployment_id === deployment.deployment_id).deployment_snapshot_hash = sha(ref(deployment.snapshot));
  rehash(s);
  s.current.input_lock_hash = sha(ref({bridge_domains: contract.bridge_domains,
    members: contract.members.map(member => ({ordinal: member.ordinal, effective_input_hash: member.effective_inputs_hash, deployment_snapshot_hash: member.deployment_snapshot_hash}))}));
  return s;
}
const note = codes => { for (const code of codes) SEEN.add(code); return codes; };
const b0 = s => G.evaluateMultiBuildEligibility(s);
const c1 = s => G.evaluateMultiStructure(s);
const c2 = s => G.evaluateMultiCompile(s);
const c3 = s => G.evaluateMultiProvenance(s);
const c4 = s => G.evaluateMultiValidation(s);
const codes = result => note([...result.codes]);
const sorted = values => [...values].sort();
function expectCodes(result, expected, label = '') {
  assert.deepEqual(sorted(codes(result)), sorted(expected), label + ' ' + JSON.stringify(result.codes));
  assert.equal(result.pass, expected.length === 0);
}
const withCodes = (result, ...expected) => { for (const code of expected) assert.ok(codes(result).includes(code), code + ' in ' + JSON.stringify(result.codes)); };
const run0 = () => fresh().run;

/* ---- the golden ---- */

test('the golden is a labelled synthetic fixture with LF bytes, and it reproduces from its render input byte for byte', () => {
  assert.equal(golden.version, 'mp-package-golden-v1');
  assert.match(golden.label, /^LABELLED ENGINEERING FIXTURE/);
  assert.ok(!RAW.includes('\r'), 'LF bytes');
  assert.deepEqual(ONE.scanContent(RAW), [], 'no secret and no machine path');
  assert.equal(RAW.includes('BEGIN'), false);
  const out = renderMultiPackage(clone(RI));
  assert.deepEqual({...out.files}, golden.rendered.files);
  assert.equal(out.package_hash, golden.rendered.package_hash);
  assert.equal(out.binding_hash, golden.rendered.binding_hash);
  assert.equal(Object.keys(golden.rendered.files).length, 10 + 3 * 2);
  assert.deepEqual(Object.keys(golden.rendered.files), multiPackageFiles(2));
  // hashes written with the independent canonical writer
  assert.equal(golden.rendered.package_hash, sha(ref(JSON.parse(golden.rendered.files[MANIFEST]))));
  assert.equal(golden.rendered.binding_hash, sha(ref(JSON.parse(golden.rendered.files[MANIFEST]).binding)));
  // RD-MP-46: the member deployments carry full synthetic snapshots that hash to the frozen member snapshot hashes, with a frozen pair that is not the selected pair
  assert.equal(golden.deployments.length, 2);
  for (const [index, deployment] of golden.deployments.entries()) {
    assert.equal(sha(ref(deployment.snapshot)), RI.run.contract.members[index].deployment_snapshot_hash);
    assert.deepEqual(deployment.snapshot.selection.bridge, {atr_multiplier: '1.5', rr: '1'});
  }
  assert.deepEqual(RI.run.result.selected.parameters, {atr_multiplier: '2', rr: '1.5'}, 'D1: the selected pair is a pair of canonical decimal strings');
  assert.equal(golden.current.bridge_pair, undefined, 'the freshness tuple has no selected-pair term');
  assert.equal(golden.current.input_lock_hash, JSON.parse(golden.rendered.files[MANIFEST]).binding.input_lock_hash);
  // the trace the evaluator re-derives is the packaged one
  assert.deepEqual(TRACE.records, RI.trace.records);
  assert.equal(TRACE.records.length, 3);
  assert.deepEqual(TRACE.records.map(item => item.path), [...ONE.TRACE_FILES]);
  assert.deepEqual(Object.values(MP_TRACE_PATHS), [...ONE.TRACE_FILES]);
});

/* ---- T-K1 / F17: the golden passes to EXPORT_INTERNAL ---- */

test('T-K1 / F17: B0 and C1 to C4 pass, the stored status is EXPORT_INTERNAL, READY is false, G8 and QUALIFIED_TOTAL are unchanged', () => {
  const s = fresh();
  const gate0 = b0(s);
  expectCodes(gate0, []);
  assert.deepEqual({...gate0.g7}, {gate: 'G7', state: 'FAIL', code: 'OWNER_RECOMMENDATION_NOT_READY'}, 'G7 stays FAIL on the internal path');
  for (const gate of [c1, c2, c3, c4]) expectCodes(gate(s), []);
  const result = G.evaluateMultiPackage(s);
  assert.equal(result.version, G.MULTI_PACKAGE_GATE_VERSION);
  assert.equal(result.pass, true);
  assert.deepEqual(result.gates.map(item => [item.gate, item.state]), [['C1', 'PASS'], ['C2', 'PASS'], ['C3', 'PASS'], ['C4', 'PASS'], ['Q', 'PASS']]);
  assert.deepEqual([...result.codes], []);
  assert.equal(result.status, 'EXPORT_INTERNAL');
  assert.deepEqual({ok: result.next.ok, to: result.next.to, codes: [...result.next.codes]}, {ok: true, to: 'EXPORT_INTERNAL', codes: []});
  assert.equal(result.ready, false);
  const record = result.record;
  assert.deepEqual(Object.keys(record).sort(), ['attempt_id', 'binding_hash', 'export_id', 'fixture', 'gate_results', 'mode', 'package_hash', 'validated_at_utc', 'validator_engine_hash']);
  assert.equal(record.mode, 'MULTI_PINE');
  assert.equal(record.fixture, true);
  assert.equal(record.export_id, RI.export_id);
  assert.equal(record.package_hash, golden.rendered.package_hash);
  assert.equal(record.binding_hash, golden.rendered.binding_hash);
  assert.equal(record.attempt_id, golden.attempt.attempt_id);
  assert.equal(record.validator_engine_hash, golden.attempt.validator_engine_hash);
  assert.equal(record.validated_at_utc, golden.attempt.validated_at_utc);
  assert.deepEqual(record.gate_results.map(item => [item.gate, item.state, [...item.codes]]), [['C1', 'PASS', []], ['C2', 'PASS', []], ['C3', 'PASS', []], ['C4', 'PASS', []]]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(record) && Object.isFrozen(result.gates) && Object.isFrozen(result.codes));
  // G8 reads only a PASS validation record of a non-fixture ONE_PINE package: the multi record changes nothing.
  const items = [{run_id: s.run.run_id, mode: 'MULTI_PINE', record}];
  assert.deepEqual({...ONE.libraryG8(items, s.run.run_id)}, {gate: 'G8', state: 'FAIL', code: 'QL4C_VALIDATION_NOT_AVAILABLE'});
  assert.deepEqual({...ONE.libraryG8([...items, {run_id: s.run.run_id, mode: 'ONE_PINE', record}], s.run.run_id)}, {gate: 'G8', state: 'FAIL', code: 'QL4C_VALIDATION_NOT_AVAILABLE'}, 'a fixture record never passes G8');
  const total = ONE.qualifiedFromRecords(items);
  assert.equal(total.total, 0);
  assert.equal(total.winner, null);
  assert.equal(QUALIFIED_TOTAL, 0);
});

test('READY is always false for MULTI_PINE, whatever the stored status', () => {
  const s = fresh();
  const base = {binding: s.binding, current: s.current, replay_mismatch: false, requester_owner_id: 'owner-a'};
  for (const status of ['EXPORT_INTERNAL', 'EXPORT_CANDIDATE', 'EXPORT_REFUSED', 'EXPORT_VALIDATED']) {
    const view = G.multiReadState({...base, status});
    assert.equal(view.ready, false, status);
    assert.equal(view.state, 'FRESH');
    assert.equal(view.fresh, true);
  }
  // RD-MP-46 B3: not even a caller binding that claims ONE_PINE, a non-fixture package, a fresh state and the owning requester makes a multi export READY
  for (const binding of [{...s.binding, mode: 'ONE_PINE', fixture: false}, {...s.binding, mode: 'ONE_PINE'}, {...s.binding, fixture: false}, s.binding]) {
    for (const status of ['EXPORT_VALIDATED', 'EXPORT_INTERNAL']) {
      const view = G.multiReadState({...base, status, binding});
      assert.equal(view.ready, false, status + ' ' + JSON.stringify([binding.mode, binding.fixture]));
    }
  }
  assert.equal(G.multiReadState({binding: s.binding, current: s.current, replay_mismatch: false, requester_owner_id: 'owner-a', status: 'EXPORT_VALIDATED', mode: 'ONE_PINE', fixture: false, owns_bot: true}).ready, false);
  for (const wrong of [undefined, null, 5, 'x', [], {}]) assert.equal(G.multiReadState(wrong).ready, false);
  const stale = G.multiReadState({...base, status: 'EXPORT_INTERNAL', current: {...s.current, dataset_available: false}});
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.code, 'BI_DATASET_UNAVAILABLE');
  const replay = G.multiFreshness({binding: s.binding, current: s.current, replay_mismatch: true});
  assert.deepEqual(note([...replay.codes]), ['REPLAY_MISMATCH']);
  for (const bad of [undefined, null, 'false', 0]) {
    const refused = G.multiFreshness({binding: s.binding, current: s.current, replay_mismatch: bad});
    assert.equal(refused.refused, 'BI_REPLAY_STATE_UNAVAILABLE');
    assert.equal(refused.fresh, false);
    assert.equal(G.multiReadState({...base, status: 'EXPORT_INTERNAL', replay_mismatch: bad}).ready, false);
  }
});

/* ---- B0 ---- */

test('B0: foreign or absent run is NOT_FOUND and nothing else, and unusable caller input refuses the call', () => {
  const s = fresh();
  s.owner_id = 'owner-x';
  expectCodes(b0(s), ['NOT_FOUND']);
  expectCodes(b0({...fresh(), run: null}), ['NOT_FOUND']);
  expectCodes(b0({...fresh(), owner_id: ''}), ['NOT_FOUND']);
  const refused = b0({...fresh(), current_rules: undefined});
  assert.equal(refused.refused, 'INPUT_INVALID');
  assert.deepEqual([...refused.fields], ['current_rules']);
  assert.equal(refused.pass, false);
  assert.deepEqual([...refused.codes], []);
});

const B0_CASES = [
  ['STATUS_NOT_COMPLETED', ['STATUS_NOT_COMPLETED'], s => { s.run.status = 'RUNNING'; }],
  ['NO_RESULT', ['NO_RESULT', 'OWNER_RECOMMENDATION_NOT_READY'], s => { s.run.result = null; }],
  ['INTEGRITY_CHECK_FAILED (contract hash)', ['INTEGRITY_CHECK_FAILED'], s => { s.run.contract_hash = sha('other'); }],
  ['INTEGRITY_CHECK_FAILED (result tie)', ['INTEGRITY_CHECK_FAILED'], s => { s.run.result.run_id = 'other-run'; }],
  ['BI_RUN_NOT_QUALIFIABLE', ['BI_RUN_NOT_QUALIFIABLE', 'OWNER_RECOMMENDATION_NOT_READY'], s => { s.run.result.completion_reason = 'CANDIDATE_FAILED_CHECKS'; }],
  ['BI_RUN_NOT_QUALIFIABLE (NO_VALID_CANDIDATE status)', ['BI_RUN_NOT_QUALIFIABLE'], s => { s.run.status = 'NO_VALID_CANDIDATE'; }],
  ['NO_SCREENED_CANDIDATE (no selected)', ['NO_SCREENED_CANDIDATE'], s => { s.run.result.selected = null; }],
  ['NO_SCREENED_CANDIDATE (train sample)', ['NO_SCREENED_CANDIDATE'], s => { s.run.result.selected.train.closed_trades = 4; }],
  ['NO_SCREENED_CANDIDATE (validation sample)', ['NO_SCREENED_CANDIDATE'], s => { s.run.result.selected.validation.closed_trades = 4; }],
  ['SENSITIVITY_FAILED (drop)', ['SENSITIVITY_FAILED'], s => { s.run.result.selected.sensitivity[0].validation.net_return_percent = '-5'; }],
  ['SENSITIVITY_FAILED (sample)', ['SENSITIVITY_FAILED'], s => { s.run.result.selected.sensitivity[1].validation.closed_trades = 2; }],
  ['SENSITIVITY_FAILED (J2: validation is read at top level, not under result)', ['SENSITIVITY_FAILED'], s => {
    for (const item of s.run.result.selected.sensitivity) { item.result = {validation: item.validation}; delete item.validation; }
  }],
  ['SENSITIVITY_FAILED (stored reason)', ['SENSITIVITY_FAILED'], s => { s.run.result.selected.screen_reasons = ['SENSITIVITY_FAILED']; }],
  ['SENSITIVITY_FAILED (list missing)', ['SENSITIVITY_FAILED'], s => { delete s.run.result.selected.sensitivity; }],
  ['COST_STRESS_FAILED', ['COST_STRESS_FAILED'], s => { s.run.result.selected.cost_stress.validation.net_return_percent = '-1'; }],
  ['COST_STRESS_FAILED (missing)', ['COST_STRESS_FAILED'], s => { delete s.run.result.selected.cost_stress; }],
  ['HOLDOUT_NOT_EVALUATED', ['HOLDOUT_NOT_EVALUATED'], s => { s.run.result.holdout_evaluated = false; }],
  ['INSUFFICIENT_TEST_TRADES', ['INSUFFICIENT_TEST_TRADES'], s => { s.run.result.selected.test.closed_trades = 4; }],
  ['NEGATIVE_HOLDOUT_RETURN', ['NEGATIVE_HOLDOUT_RETURN'], s => { s.run.result.selected.test.net_return_percent = '-0.1'; }],
  ['TEST_DRAWDOWN_EXCEEDED', ['TEST_DRAWDOWN_EXCEEDED'], s => { s.run.result.selected.test.max_drawdown_percent = '20.5'; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (no lookups)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED', 'BI_EXPOSURE_REGISTER_UNAVAILABLE'], s => { delete s.holdout; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (earlier list unreadable)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { s.holdout.earlier_holdouts = null; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (boundary unknown)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { s.holdout.registered_boundary = {exists: 'maybe'}; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (member snapshots absent)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { delete s.deployments; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (one member snapshot absent)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { s.deployments.pop(); }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (snapshot market unreadable)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { snapshotEdit(s, 1, snapshot => { snapshot.market = {broker: 'binance-global'}; }); }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (unbound deployments are reported even when an earlier gate fails)', ['STATUS_NOT_COMPLETED', 'HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { s.run.status = 'RUNNING'; delete s.deployments; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (N3: snapshot is not the frozen one)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { s.deployments[0].snapshot.funding_cutoff = 99; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (N3: snapshot absent)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { delete s.deployments[1].snapshot; }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (N4: duplicated deployment_id)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => { s.deployments.push(clone(s.deployments[0])); }],
  ['HOLDOUT_INDEPENDENCE_NOT_CHECKED (N4: duplicated deployment_id with another market)', ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'], s => {
    s.deployments.unshift({...clone(s.deployments[0]), snapshot: {...clone(s.deployments[0].snapshot), market: {...clone(s.deployments[0].snapshot.market), symbol: 'ETHUSDT'}}});
  }],
  ['MP_BRIDGE_PAIR_DIVERGENT (member 2 carries another pair)', ['MP_BRIDGE_PAIR_DIVERGENT'], s => { snapshotEdit(s, 1, snapshot => { snapshot.selection.bridge.rr = '2'; }); }],
  ['MP_BRIDGE_PAIR_DIVERGENT (pair unreadable)', ['MP_BRIDGE_PAIR_DIVERGENT'], s => { snapshotEdit(s, 0, snapshot => { snapshot.selection = null; }); }],
  ['MP_BRIDGE_PAIR_DIVERGENT (third key in the pair)', ['MP_BRIDGE_PAIR_DIVERGENT'], s => { snapshotEdit(s, 1, snapshot => { snapshot.selection.bridge.extra = '1'; }); }],
  ['MP_MEMBER_SET_STALE (source version)', ['MP_MEMBER_SET_STALE'], s => { s.current.membership[0].source_version = 2; }],
  ['MP_MEMBER_SET_STALE (source hash)', ['MP_MEMBER_SET_STALE'], s => { s.current.membership[1].source_hash = sha('new source'); }],
  ['MP_MEMBER_SET_STALE (membership hash)', ['MP_MEMBER_SET_STALE'], s => { s.current.membership_hash = sha('other'); }],
  ['MP_MEMBER_SET_STALE (a member disconnected)', ['MP_MEMBER_SET_STALE'], s => { s.current.membership.pop(); }],
  ['MP_MEMBER_SET_STALE (policy hash)', ['MP_MEMBER_SET_STALE'], s => { s.current.policy_hash = sha('other'); }],
  ['MP_MEMBER_SET_STALE (capital)', ['MP_MEMBER_SET_STALE'], s => { s.current.capital = {equity: '999', cash: '999'}; }],
  ['MP_MEMBER_SET_STALE (funding cutoff)', ['MP_MEMBER_SET_STALE'], s => { s.current.funding_cutoff = 8; }],
  ['MP_MEMBER_SET_STALE (deployment)', ['MP_MEMBER_SET_STALE'], s => { s.current.membership[1].deployment_id = 'dep-new'; }],
  ['MP_MEMBER_SET_STALE (input lock)', ['MP_MEMBER_SET_STALE'], s => { s.current.input_lock_hash = sha('other'); }],
  ['MP_MEMBER_SET_STALE (current unreadable: absent)', ['MP_MEMBER_SET_STALE'], s => { delete s.current; }],
  ['MP_MEMBER_SET_STALE (current unreadable: not an object)', ['MP_MEMBER_SET_STALE'], s => { s.current = 'fresh'; }],
  ['MP_MEMBER_SET_STALE (current unreadable: membership not a list)', ['MP_MEMBER_SET_STALE'], s => { s.current.membership = null; }],
  ['INTEGRITY_CHECK_FAILED (F1: contract edited, hashes unchanged)', ['INTEGRITY_CHECK_FAILED'], s => { s.run.contract.budget.candidates = 31; }],
  ['HOLDOUT_WINDOW_REUSED', ['HOLDOUT_WINDOW_REUSED'], s => { s.holdout.earlier_holdouts = [{start_time: at(4900), end_time: at(5200)}]; }],
  ['BI_HOLDOUT_OVERLAPS_SEARCHED_DATA', ['BI_HOLDOUT_OVERLAPS_SEARCHED_DATA'], s => { s.holdout.earlier_searched = [{start_time: at(0), end_time: at(4100)}]; }],
  ['BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY', ['BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY'], s => { s.holdout.registered_boundary = {exists: true, start_time: at(4500)}; }],
  ['BI_HOLDOUT_EXPOSED_BY_SELECTION', ['BI_HOLDOUT_EXPOSED_BY_SELECTION'], s => {
    s.holdout.exposure_register.push({owner_id: 'owner-a', market: clone(MARKET), window: {start_time: at(4500), end_time: at(4600)}, selection_id: 'selection-1', at_utc: '2026-10-01T00:00:00Z'});
  }],
  ['BI_HOLDOUT_EXPOSED_BY_SELECTION (QR-3 event, entry at the creation instant)', ['BI_HOLDOUT_EXPOSED_BY_SELECTION'], s => {
    s.holdout.exposure_register.push({owner_id: 'owner-a', market: clone(MARKET), window: {start_time: at(4500), end_time: at(4600)}, comparison_id: 'cmp-1', source_hash: sha('source'), at_utc: '2026-10-21T11:00:00Z'});
  }],
  ['BI_EXPOSURE_REGISTER_UNAVAILABLE (register missing)', ['BI_EXPOSURE_REGISTER_UNAVAILABLE'], s => { s.holdout.exposure_register = null; }],
  ['BI_EXPOSURE_REGISTER_UNAVAILABLE (malformed entry)', ['BI_EXPOSURE_REGISTER_UNAVAILABLE'], s => { s.holdout.exposure_register.push({owner_id: 'owner-a'}); }],
  ['BI_EXPOSURE_REGISTER_UNAVAILABLE (too many fraction digits)', ['BI_EXPOSURE_REGISTER_UNAVAILABLE'], s => {
    s.holdout.exposure_register.push({owner_id: 'owner-a', market: clone(MARKET), window: {start_time: at(4500), end_time: at(4600)}, selection_id: 'selection-1', at_utc: '2026-10-01T00:00:00.0001Z'});
  }],
  ['BI_EXPOSURE_REGISTER_UNAVAILABLE (created_at_ms missing)', ['BI_EXPOSURE_REGISTER_UNAVAILABLE'], s => { delete s.run.created_at_ms; }],
  ['MP_MARKET_MIXED', ['MP_MARKET_MIXED'], s => { snapshotEdit(s, 1, snapshot => { snapshot.market.symbol = 'ETHUSDT'; }); }],
  ['BI_MARKET_SCOPE_INVALID (all members on another market)', ['BI_MARKET_SCOPE_INVALID'], s => { for (const index of [0, 1]) snapshotEdit(s, index, snapshot => { snapshot.market.symbol = 'ETHUSDT'; }); }],
  ['BI_SEARCH_RECORD_MISSING (no search object)', ['BI_SEARCH_RECORD_MISSING', 'BI_DIMENSION_COVERAGE'], s => { s.run.result.search = null; }],
  ['BI_SEARCH_RECORD_MISSING (seed)', ['BI_SEARCH_RECORD_MISSING'], s => { delete s.run.result.search.seed; }],
  ['BI_SEARCH_RECORD_MISSING (completion reason)', ['BI_SEARCH_RECORD_MISSING', 'BI_RUN_NOT_QUALIFIABLE', 'OWNER_RECOMMENDATION_NOT_READY'], s => { s.run.result.completion_reason = ''; }],
  ['BI_SEARCH_RECORD_MISSING (domains; the frozen input lock changes too)', ['BI_SEARCH_RECORD_MISSING', 'MP_MEMBER_SET_STALE'], s => { s.run.contract.bridge_domains = null; rehash(s); }],
  ['BI_DIMENSION_COVERAGE', ['BI_DIMENSION_COVERAGE'], s => { s.run.result.search.dimension_coverage_percent = 50; s.run.result.search.covered_dimensions = 1; }],
  ['BLOCKERS_UNKNOWN', ['BLOCKERS_UNKNOWN'], s => { s.run.contract.acceptance_blockers = 'MULTI_PINE_REQUIRES_APP_3B'; rehash(s); }],
  ['BI_CAPABILITY_BLOCKER_PRESENT', ['BI_CAPABILITY_BLOCKER_PRESENT'], s => { s.run.contract.acceptance_blockers.push('CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'); rehash(s); }],
  ['BI_BINDING_INCOMPLETE (field missing)', ['BI_BINDING_INCOMPLETE'], s => { delete s.binding.input_lock_hash; }],
  ['BI_BINDING_INCOMPLETE (no binding)', ['BI_BINDING_INCOMPLETE', 'BI_EPISODE_GATE_UNAVAILABLE', 'BI_MULTI_PINE_INTERNAL_ONLY', 'BI_CAPABILITY_BLOCKER_PRESENT', 'OWNER_RECOMMENDATION_NOT_READY'], s => { s.binding = null; }],
  ['BI_BINDING_INCOMPLETE (rules unreadable)', ['BI_BINDING_INCOMPLETE'], s => { s.run.contract.rules = {minimum_closed_trades_train: 5}; rehash(s); }],
  ['BI_BINDING_MISMATCH (claimed mode)', ['BI_BINDING_MISMATCH', 'BI_BINDING_INCOMPLETE', 'BI_MULTI_PINE_INTERNAL_ONLY', 'BI_CAPABILITY_BLOCKER_PRESENT', 'OWNER_RECOMMENDATION_NOT_READY'], s => { s.binding.mode = 'ONE_PINE'; }],
  ['BI_BINDING_MISMATCH (boundary ref)', ['BI_BINDING_MISMATCH'], s => { s.holdout.registered_boundary = {exists: true, start_time: at(100), ref: {id: 'boundary-1'}}; }],
  ['BI_EPISODE_GATE_UNAVAILABLE', ['BI_EPISODE_GATE_UNAVAILABLE', 'BI_BINDING_INCOMPLETE'], s => { s.binding.fixture = false; }],
  ['MP_EXIT_VERSION_MIXED', ['MP_EXIT_VERSION_MIXED'], s => { s.run.contract.members[1].exit_version = 'bridge-exit-v3'; rehash(s); }],
  ['BI_EXIT_VERSION_UNSUPPORTED', ['BI_EXIT_VERSION_UNSUPPORTED'], s => { for (const member of s.run.contract.members) member.exit_version = 'bridge-exit-v3'; rehash(s); }],
  ['BI_BINDING_MISMATCH (not a multi contract)', ['BI_BINDING_MISMATCH', 'BI_CAPABILITY_BLOCKER_PRESENT', 'OWNER_RECOMMENDATION_NOT_READY'], s => { s.run.contract.mode = 'ONE_PINE'; rehash(s); }]
];
for (const [name, expected, mutate] of B0_CASES) test('B0 negation: ' + name, () => {
  const s = fresh();
  mutate(s);
  expectCodes(b0(s), expected);
});

test('B0: exposure counts only the same owner, the same member market and a register time at or before the run creation time (created_at_ms)', () => {
  const entry = overrides => ({owner_id: 'owner-a', market: clone(MARKET), window: {start_time: at(4500), end_time: at(4600)}, selection_id: 'selection-1', at_utc: '2026-10-01T00:00:00Z', ...overrides});
  const outcome = (...entries) => { const s = fresh(); s.holdout.exposure_register.push(...entries); return codes(b0(s)); };
  assert.deepEqual(outcome(entry({})), ['BI_HOLDOUT_EXPOSED_BY_SELECTION']);
  assert.deepEqual(outcome(entry({owner_id: 'owner-b'})), [], 'another owner');
  assert.deepEqual(outcome(entry({market: {broker: 'binance-global', symbol: 'ETHUSDT', timeframe: '1'}})), [], 'another market');
  assert.deepEqual(outcome(entry({window: {start_time: at(100), end_time: at(200)}})), [], 'no window overlap');
  assert.deepEqual(outcome(entry({at_utc: '2026-10-21T11:00:00Z'})), ['BI_HOLDOUT_EXPOSED_BY_SELECTION'], 'exactly at created_at_ms');
  assert.deepEqual(outcome(entry({at_utc: '2026-10-21T11:00:00.001Z'})), [], 'one millisecond after created_at_ms');
  assert.deepEqual(outcome(entry({at_utc: '2026-10-22T00:00:00Z'})), [], 'after the run');
  // the market key comes from the member snapshots: the contract carries no snapshot.market
  const s = fresh();
  assert.equal(s.run.contract.snapshot, undefined);
  s.holdout.exposure_register.push(entry({market: {broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'}}));
  assert.deepEqual(codes(b0(s)), ['BI_HOLDOUT_EXPOSED_BY_SELECTION']);
  // and the run creation time comes from created_at_ms, not created_at_utc
  const t = fresh();
  t.run.created_at_utc = '2020-01-01T00:00:00Z';
  t.holdout.exposure_register.push(entry({}));
  assert.deepEqual(codes(b0(t)), ['BI_HOLDOUT_EXPOSED_BY_SELECTION']);
});

test('RC-11: the tolerance of MULTI_PINE_REQUIRES_APP_3B and of a G7 FAIL exists on the internal path only', () => {
  const internal = fresh();
  expectCodes(b0(internal), []);
  const external = fresh();
  external.internal = false;
  expectCodes(b0(external), ['BI_MULTI_PINE_INTERNAL_ONLY', 'BI_CAPABILITY_BLOCKER_PRESENT', 'OWNER_RECOMMENDATION_NOT_READY']);
  for (const flag of ['true', 1, undefined, null]) {
    const s = fresh();
    s.internal = flag;
    withCodes(b0(s), 'BI_CAPABILITY_BLOCKER_PRESENT', 'BI_MULTI_PINE_INTERNAL_ONLY');
  }
  // a created-internal package whose version disagrees gets no tolerance
  const wrong = fresh();
  wrong.run.contract.version = 'ql3a-research-job-v2';
  rehash(wrong);
  withCodes(b0(wrong), 'BI_BINDING_MISMATCH', 'BI_CAPABILITY_BLOCKER_PRESENT');
  // G7: the multi-Pine version is not listed, so the gate stays FAIL, and the tolerance needs the PASS completion reason
  const reason = fresh();
  reason.run.result.completion_reason = 'CANDIDATE_FAILED_CHECKS';
  withCodes(b0(reason), 'OWNER_RECOMMENDATION_NOT_READY');
  // C4: the same blocker rule on the clearances
  const cleared = fresh();
  expectCodes(c4(cleared), []);
  const closedPath = fresh();
  closedPath.internal = false;
  expectCodes(c4(closedPath), ['ACCEPTANCE_BLOCKERS_PRESENT']);
  const noMarker = fresh();
  noMarker.clearances = [];
  expectCodes(c4(noMarker), ['ACCEPTANCE_BLOCKERS_PRESENT']);
});

test('B0 and the attempt carry RULES_VERSION_DIFFERS as information only when the current rules differ from the run frozen rules', () => {
  const s = fresh();
  assert.deepEqual([...b0(s).limitations], []);
  s.current_rules = {...s.current_rules, minimum_closed_trades_test: 9};
  const gate = b0(s);
  assert.equal(gate.pass, true, 'information, not a failure');
  assert.deepEqual(note([...gate.limitations]), ['RULES_VERSION_DIFFERS']);
  const result = G.evaluateMultiPackage(s);
  assert.equal(result.pass, true);
  assert.deepEqual([...result.limitations], ['RULES_VERSION_DIFFERS']);
  assert.equal(result.status, 'EXPORT_INTERNAL');
});

/* ---- RD-MP-48 D1: the pair of the run is a pair of canonical decimal strings ---- */

test('D1: C3 compares the pair of inputs.json with the selected pair as decimals and refuses a number; C4 compares the baseline pair as decimals and refuses a number', () => {
  const golden0 = fresh();
  assert.deepEqual(golden0.run.result.selected.parameters, {atr_multiplier: '2', rr: '1.5'});
  assert.deepEqual(golden0.run.result.combined_baseline.pair, {atr_multiplier: '2', rr: '1.5'});
  expectCodes(c3(golden0), []);
  expectCodes(c4(golden0), []);
  // a number is not the contract shape: the pair of inputs.json then differs from it (BI_INPUTS_MISMATCH), however equal the value
  const numeric = fresh();
  numeric.run.result.selected.parameters = {atr_multiplier: 2, rr: 1.5};
  withCodes(c3(numeric), 'BI_INPUTS_MISMATCH');
  // a decimal-equal spelling of the same pair is the same pair for the inputs.json compare (other codes may report the changed bytes of the run, never BI_INPUTS_MISMATCH)
  const spelled = fresh();
  spelled.run.result.selected.parameters = {atr_multiplier: '2.0', rr: '1.50'};
  assert.ok(!codes(c3(spelled)).includes('BI_INPUTS_MISMATCH'), JSON.stringify(c3(spelled).codes));
  const other = fresh();
  other.run.result.selected.parameters = {atr_multiplier: '2.5', rr: '1.5'};
  withCodes(c3(other), 'BI_INPUTS_MISMATCH');
  // C4: the combined baseline pair (RD-MP-30)
  const spelledBaseline = fresh();
  spelledBaseline.run.result.combined_baseline.pair = {atr_multiplier: '2.00', rr: '1.500'};
  assert.ok(!codes(c4(spelledBaseline)).includes('MP_COMBINED_BASELINE_FAILED'), JSON.stringify(c4(spelledBaseline).codes));
  for (const pair of [{atr_multiplier: 2, rr: 1.5}, {atr_multiplier: '2', rr: 1.5}, {atr_multiplier: '2', rr: '1.5', extra: '1'}, {atr_multiplier: '2'}, {atr_multiplier: '2', rr: '1.51'}, {atr_multiplier: '0', rr: '0'}]) {
    const bad = fresh();
    bad.run.result.combined_baseline.pair = pair;
    withCodes(c4(bad), 'MP_COMBINED_BASELINE_FAILED');
  }
  // a number in the selected pair fails the baseline too, whatever the baseline holds
  const numericBoth = fresh();
  numericBoth.run.result.selected.parameters = {atr_multiplier: 2, rr: 1.5};
  numericBoth.run.result.combined_baseline.pair = {atr_multiplier: 2, rr: 1.5};
  withCodes(c4(numericBoth), 'MP_COMBINED_BASELINE_FAILED');
});

/* ---- RD-MP-46 B1: the selected pair is not a freshness term ---- */

test('B1: the selected pair differs from the frozen deployment pair (decimal strings) and the package still passes; a changed frozen pair is caught through the input lock', () => {
  const s = fresh();
  const frozen = s.deployments.map(item => item.snapshot.selection.bridge);
  assert.deepEqual(frozen, [{atr_multiplier: '1.5', rr: '1'}, {atr_multiplier: '1.5', rr: '1'}]);
  assert.notDeepEqual(s.run.result.selected.parameters, {atr_multiplier: '1.5', rr: '1'});
  assert.deepEqual(G.multiFreshnessCodes(s.binding, s.current), []);
  assert.equal(G.multiFreshness({binding: s.binding, current: s.current, replay_mismatch: false}).state, 'FRESH');
  // a current.bridge_pair of any shape is not read
  for (const pair of [{atr_multiplier: 2, rr: 1.5}, {atr_multiplier: '9', rr: '9'}, null, 'x', [], undefined]) {
    const t = fresh();
    t.current.bridge_pair = pair;
    assert.deepEqual(G.multiFreshnessCodes(t.binding, t.current), []);
    expectCodes(c4(t), []);
    expectCodes(b0(t), []);
    assert.equal(G.evaluateMultiPackage(t).status, 'EXPORT_INTERNAL');
  }
  assert.equal(G.evaluateMultiPackage(s).status, 'EXPORT_INTERNAL');
  // a change of the frozen deployment pair changes the snapshot, the member snapshot hash and the input lock: the current lock differs from the packaged one
  const moved = fresh();
  const before = moved.current.input_lock_hash;
  snapshotEdit(moved, 0, snapshot => { snapshot.selection.bridge.rr = '2'; });
  assert.notEqual(moved.current.input_lock_hash, before);
  // the packaged binding still carries the old lock, so the current lock differs
  withCodes(c4(moved), 'BI_SELECTION_CHANGED');
});

/* ---- RD-MP-46 B2: B0 freshness and shared pair equality ---- */

test('B2: B0 reads the same current input as C4 and derives the frozen tuple from the run contract, not from the caller binding', () => {
  const s = fresh();
  expectCodes(b0(s), []);
  // the dataset availability is not a member-set term
  s.current.dataset_available = false;
  expectCodes(b0(s), []);
  withCodes(c4(s), 'BI_DATASET_UNAVAILABLE');
  // a caller binding that lies about the frozen tuple changes nothing: the contract decides
  const lie = fresh();
  lie.binding = {...lie.binding, membership_hash: sha('lie'), policy_hash: sha('lie'), input_lock_hash: sha('lie')};
  expectCodes(b0(lie), []);
  // the same capital in another key order is not stale
  const equal = fresh();
  equal.current.capital = {cash: '1000', equity: '1000'};
  expectCodes(b0(equal), []);
  // stale state gives exactly one code, whatever the number of differing terms
  const many = fresh();
  many.current.membership_hash = sha('a');
  many.current.policy_hash = sha('b');
  many.current.funding_cutoff = 1;
  assert.deepEqual(codes(b0(many)), ['MP_MEMBER_SET_STALE']);
  assert.equal(G.isRetryable('MP_MEMBER_SET_STALE'), false);
  // the pair equality is numeric: strings and numbers of the same value are equal
  const mixed = fresh();
  snapshotEdit(mixed, 1, snapshot => { snapshot.selection.bridge = {atr_multiplier: 1.5, rr: 1}; });
  expectCodes(b0(mixed), []);
  const trailing = fresh();
  snapshotEdit(trailing, 1, snapshot => { snapshot.selection.bridge = {atr_multiplier: '1.50', rr: '1.0'}; });
  expectCodes(b0(trailing), []);
});

/* ---- RD-MP-46 N1: C3 re-derives the trace ---- */

test('N1: C3 re-derives the trace itself: a record that agrees with the packaged copy and the stored digests but not with the derived trace gives both mismatch codes', () => {
  const s = fresh();
  expectCodes(c3(s), []);
  assert.equal(s.run.result.selected.holdout.fills, 16);
  // the run result is changed (one more FILLED decision is claimed) and every digest and copy that C3 compared before is brought to the new result by the independent writer
  s.run.result.selected.holdout.fills += 1;
  const holdoutDigest = sha(ref({test: s.run.result.selected.test, holdout: s.run.result.selected.holdout}));
  for (const record of s.trace_reproduction) record.holdout_digest = holdoutDigest;
  jsonEdit(s, 'quant-data/validation.json', value => { value.holdout.step = s.run.result.selected.holdout; });
  edit(s, MANIFEST, manifest => {
    for (const record of manifest.evidence.trace_records) record.holdout_digest = holdoutDigest;
    manifest.binding.library_record_ref.result_sha256 = sha(ref(s.run.result));
  });
  assert.throws(() => deriveMultiTrace({run: s.run, producer_closure_hash: RI.producer_closure_hash}), /FILLED count/);
  expectCodes(c3(s), ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH']);
  // the run view is not changed or frozen by the re-derivation
  const t = fresh();
  c3(t);
  assert.equal(Object.isFrozen(t.run.result.selected), false);
  assert.equal(Object.isFrozen(t.run.contract), false);
  assert.equal(Object.isFrozen(t.trace_reproduction[0]), false);
});

test('N1: the producer closure hash of the record is passed to the derivation, so another closure hash that record and copy agree on is the caller closure and re-derives', () => {
  const s = fresh();
  const other = sha('another producer closure');
  for (const record of s.trace_reproduction) record.producer_closure_hash = other;
  edit(s, MANIFEST, manifest => { for (const record of manifest.evidence.trace_records) record.producer_closure_hash = other; });
  // the module cannot read the running closure hash (the caller must pass the live one, RD-MP-46); with a consistent record it is accepted as the caller closure
  expectCodes(c3(s), []);
  // a record that names the original closure while the copy names the other is a mismatch
  const t = fresh();
  edit(t, MANIFEST, manifest => { manifest.evidence.trace_records[0].producer_closure_hash = other; });
  expectCodes(c3(t), ['BI_RESULT_MISMATCH']);
});

/* ---- RD-MP-46 N5: the B0 fallback has the B0 shape ---- */

test('N5: an unexpected exception inside B0 gives the normal B0 result shape: limitations, g7 and one code', () => {
  const s = fresh();
  Object.defineProperty(s.run, 'contract', {get() { throw new Error('boom'); }, enumerable: true});
  const result = b0(s);
  assert.deepEqual([...result.codes], ['HOLDOUT_INDEPENDENCE_NOT_CHECKED']);
  assert.equal(result.state, 'FAIL');
  assert.equal(result.pass, false);
  assert.deepEqual([...result.limitations], []);
  assert.deepEqual({...result.g7}, {gate: 'G7', state: 'FAIL', code: 'OWNER_RECOMMENDATION_NOT_READY'});
  assert.deepEqual(Object.keys(result).sort(), Object.keys(b0(fresh())).sort());
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.limitations) && Object.isFrozen(result.g7));
  note(result.codes);
});

/* ---- RD-MP-46 N7: duplicated evidence is a hard code ---- */

test('N7: two evidence entries for one ordinal refuse the package at once (hard), where a missing entry stays retryable', () => {
  const s = fresh();
  s.evidence.members.push(clone(s.evidence.members[1]));
  const result = G.evaluateMultiPackage(s);
  assert.equal(result.status, 'EXPORT_REFUSED');
  withCodes(result, 'MP_MEMBER_PARITY_SCOPE_MISMATCH');
  assert.equal(G.isRetryable('MP_MEMBER_PARITY_SCOPE_MISMATCH'), false);
  assert.ok(!result.codes.includes('BI_DATASET_ALIGNMENT_MISSING') && !result.codes.includes('BI_PARITY_EVIDENCE_MISSING') && !result.codes.includes('BI_REPAINT_EVIDENCE_MISSING'));
  assert.deepEqual(result.diagnostics.map(item => ({...item})), [{code: 'MP_MEMBER_PARITY_SCOPE_MISMATCH', ordinal: 2, pine_import_id: RI.run.contract.members[1].pine_import_id}]);
  assert.equal(result.record, null);
  // one entry removed: the missing codes are retryable and the package stays a candidate
  const missing = fresh();
  missing.evidence.members.pop();
  const retry = G.evaluateMultiPackage(missing);
  assert.equal(retry.status, 'EXPORT_CANDIDATE');
  assert.ok(retry.codes.every(code => G.isRetryable(code)));
});

/* ---- C1 ---- */

test('C1: the golden passes and the file set follows the stored pine_count', () => {
  const s = fresh();
  expectCodes(c1(s), []);
  assert.deepEqual(Object.keys(s.files), multiPackageFiles(2));
  assert.equal(Object.keys(s.files).length, 16);
  // pine_count comes from the stored run, not from the package under test
  const three = fresh();
  three.run.contract.pine_count = 3;
  withCodes(c1(three), 'BI_ARTIFACT_MISSING');
  const noRun = fresh();
  delete noRun.run;
  expectCodes(c1(noRun), []);
  noRun.binding = {...noRun.binding, pine_count: 7};
  expectCodes(c1(noRun), ['BI_ARTIFACT_MISSING']);
});

const C1_CASES = [
  ['BI_ARTIFACT_MISSING (member file)', ['BI_ARTIFACT_MISSING'], s => { delete s.files['members/2/indicator.pine']; }],
  ['BI_ARTIFACT_MISSING (member parity file)', ['BI_ARTIFACT_MISSING'], s => { delete s.files['quant-data/members/1/parity.json']; }],
  ['BI_ARTIFACT_MISSING (manifest)', ['BI_ARTIFACT_MISSING'], s => { delete s.files[MANIFEST]; }],
  ['BI_ARTIFACT_MISSING (unparseable JSON)', ['BI_ARTIFACT_MISSING'], s => { s.files['inputs.json'] = '{'; seal(s); }],
  ['BI_ARTIFACT_MISSING (unreadable content)', ['BI_ARTIFACT_MISSING'], s => { s.files['validation.html'] = 42; }],
  ['BI_ARTIFACT_UNEXPECTED', ['BI_ARTIFACT_UNEXPECTED'], s => { s.files['notes.txt'] = 'x'; }],
  ['BI_ARTIFACT_UNEXPECTED (a one-Pine path)', ['BI_ARTIFACT_UNEXPECTED'], s => { s.files['indicator.pine'] = s.files['members/1/indicator.pine']; }],
  ['BI_MANIFEST_SCHEMA_INVALID', ['BI_MANIFEST_SCHEMA_INVALID'], s => { edit(s, MANIFEST, manifest => { manifest.schema_version = 'other-v1'; }); }],
  ['BI_MANIFEST_SCHEMA_INVALID (extra key)', ['BI_MANIFEST_SCHEMA_INVALID'], s => { edit(s, MANIFEST, manifest => { manifest.extra = 1; }); }],
  ['BI_CHECKSUM_MISMATCH (file byte)', ['BI_CHECKSUM_MISMATCH'], s => { s.files['risk-profile.json'] += ' '; }],
  ['BI_CHECKSUM_MISMATCH (member file byte)', ['BI_CHECKSUM_MISMATCH'], s => { s.files['members/2/indicator.json'] += ' '; }],
  ['BI_CHECKSUM_MISMATCH (package hash)', ['BI_CHECKSUM_MISMATCH'], s => { s.package_hash = sha('other'); }],
  ['BI_CHECKSUM_MISMATCH (binding hash)', ['BI_CHECKSUM_MISMATCH'], s => { s.binding_hash = sha('other'); }],
  ['BI_CHECKSUM_MISMATCH (stored binding differs)', ['BI_CHECKSUM_MISMATCH'], s => { s.binding = {...s.binding, owner_id: 'other'}; }],
  ['BI_CHECKSUM_MISMATCH (file list)', ['BI_CHECKSUM_MISMATCH'], s => { jsonEdit(s, MANIFEST, manifest => { manifest.files.pop(); }); s.package_hash = ONE.packageHash(JSON.parse(s.files[MANIFEST])); }],
  ['BI_SECRET_DETECTED', ['BI_SECRET_DETECTED'], s => { s.files['setup-guide.md'] += '\napi_key: abcdefghijklmnop1234\n'; seal(s); }],
  ['BI_SECRET_DETECTED (member file)', ['BI_SECRET_DETECTED'], s => { s.files['members/2/indicator.pine'] += '\n// Bearer abcdefghijklmnop1234\n'; seal(s); }],
  ['BI_MACHINE_PATH_DETECTED', ['BI_MACHINE_PATH_DETECTED'], s => { s.files['setup-guide.md'] += '\nsee C:\\Users\\someone\\notes.txt\n'; seal(s); }],
  ['BI_NUMERIC_FORMAT_INVALID (metric)', ['BI_NUMERIC_FORMAT_INVALID'], s => { edit(s, 'quant-data/metrics.json', value => { value.train.net_return_percent = 1.5; }); }],
  ['BI_NUMERIC_FORMAT_INVALID (count)', ['BI_NUMERIC_FORMAT_INVALID'], s => { edit(s, 'quant-data/metrics.json', value => { value.test.closed_trades = '5'; }); }],
  ['BI_NUMERIC_FORMAT_INVALID (bridge value)', ['BI_NUMERIC_FORMAT_INVALID'], s => { edit(s, 'inputs.json', value => { value.bridge.rr.after = 1.5; }); }],
  ['BI_NUMERIC_FORMAT_INVALID (bridge domain)', ['BI_NUMERIC_FORMAT_INVALID'], s => { edit(s, 'inputs.json', value => { value.bridge.rr.domain.step = 0.5; }); }],
  ['BI_NUMERIC_FORMAT_INVALID (created_at)', ['BI_NUMERIC_FORMAT_INVALID'], s => { edit(s, MANIFEST, manifest => { manifest.identity.created_at = 'yesterday'; }); }],
  ['BI_METRIC_FABRICATED', ['BI_METRIC_FABRICATED'], s => { edit(s, 'quant-data/metrics.json', value => { value.test.win_rate = '0.6'; }); }],
  ['BI_METRIC_FABRICATED (key the run does not have)', ['BI_METRIC_FABRICATED'], s => { delete s.run.result.selected.train.max_drawdown_percent; }],
  ['BI_ALERT_SOURCE_INVALID (member file)', ['BI_ALERT_SOURCE_INVALID'], s => { edit(s, 'members/2/indicator.json', value => { value.alert_source = 'webhook'; }); }],
  ['BI_ALERT_SOURCE_INVALID (binding)', ['BI_ALERT_SOURCE_INVALID'], s => { edit(s, MANIFEST, manifest => { manifest.binding.alert_source = 'webhook'; }); }],
  ['INDICATOR_REQUIRED (strategy)', ['INDICATOR_REQUIRED'], s => { s.files['members/1/indicator.pine'] += "\nstrategy('x')\n"; seal(s); }],
  ['INDICATOR_REQUIRED (second indicator)', ['INDICATOR_REQUIRED'], s => { s.files['members/2/indicator.pine'] += '\nindicator("second")\n'; seal(s); }],
  ['BI_MARKET_SCOPE_INVALID (member file)', ['BI_MARKET_SCOPE_INVALID'], s => { edit(s, 'members/1/indicator.json', value => { value.symbol = 'BINANCE:ETHUSDT'; }); }],
  ['BI_MARKET_SCOPE_INVALID (timeframe)', ['BI_MARKET_SCOPE_INVALID'], s => { edit(s, 'members/2/indicator.json', value => { value.timeframe = '5'; }); }],
  ['BI_MARKET_SCOPE_INVALID (binding market)', ['BI_MARKET_SCOPE_INVALID'], s => { edit(s, MANIFEST, manifest => { manifest.binding.market.symbol = 'ETHUSDT'; }); }]
];
for (const [name, expected, mutate] of C1_CASES) test('C1 negation: ' + name, () => {
  const s = fresh();
  mutate(s);
  expectCodes(c1(s), expected);
});

/* ---- C2 ---- */

const memberDiag = (n, code) => ({code, ordinal: n, pine_import_id: RI.run.contract.members[n - 1].pine_import_id});
const C2_CASES = [
  ['BI_COMPILE_EVIDENCE_MISSING (member 2 record absent)', ['BI_COMPILE_EVIDENCE_MISSING'], s => { s.compile_records.pop(); }, [memberDiag(2, 'BI_COMPILE_EVIDENCE_MISSING')]],
  ['BI_COMPILE_EVIDENCE_MISSING (no records)', ['BI_COMPILE_EVIDENCE_MISSING'], s => { delete s.compile_records; }, [memberDiag(1, 'BI_COMPILE_EVIDENCE_MISSING'), memberDiag(2, 'BI_COMPILE_EVIDENCE_MISSING')]],
  ['BI_COMPILE_EVIDENCE_MISSING (two records for one member)', ['BI_COMPILE_EVIDENCE_MISSING'], s => { s.compile_records.push(clone(s.compile_records[0])); }, [memberDiag(1, 'BI_COMPILE_EVIDENCE_MISSING')]],
  ['BI_COMPILE_EVIDENCE_MISSING (other export)', ['BI_COMPILE_EVIDENCE_MISSING'], s => { s.compile_records[0].export_id = 'another-export'; }, [memberDiag(1, 'BI_COMPILE_EVIDENCE_MISSING')]],
  ['BI_COMPILE_SOURCE_MISMATCH', ['BI_COMPILE_SOURCE_MISMATCH'], s => { s.compile_records[1].indicator_sha256 = sha('another file'); }, [memberDiag(2, 'BI_COMPILE_SOURCE_MISMATCH')]],
  ['BI_COMPILE_SOURCE_MISMATCH (record of the other member)', ['BI_COMPILE_SOURCE_MISMATCH', 'BI_COMPILE_SOURCE_MISMATCH'], s => {
    [s.compile_records[0].indicator_sha256, s.compile_records[1].indicator_sha256] = [s.compile_records[1].indicator_sha256, s.compile_records[0].indicator_sha256];
  }, [memberDiag(1, 'BI_COMPILE_SOURCE_MISMATCH'), memberDiag(2, 'BI_COMPILE_SOURCE_MISMATCH')]],
  ['BI_COMPILE_ERRORS', ['BI_COMPILE_ERRORS'], s => { s.compile_records[0].errors = [{text: 'x'}]; }, [memberDiag(1, 'BI_COMPILE_ERRORS')]],
  ['BI_COMPILE_ERRORS (unresolved reference)', ['BI_COMPILE_ERRORS'], s => { s.compile_records[1].unresolved_references = 1; }, [memberDiag(2, 'BI_COMPILE_ERRORS')]],
  ['BI_SLOT_BINDING_MISMATCH', ['BI_SLOT_BINDING_MISMATCH'], s => { s.compile_records[0].mapping_check = [{slot: 1, pine_variable: 'len'}]; }, [memberDiag(1, 'BI_SLOT_BINDING_MISMATCH')]],
  ['BI_COMPILE_WARNINGS_UNREVIEWED', ['BI_COMPILE_WARNINGS_UNREVIEWED'], s => { s.compile_records[1].warnings = [{text: 'unused variable'}]; }, [memberDiag(2, 'BI_COMPILE_WARNINGS_UNREVIEWED')]],
  ['BI_SOURCE_HASH_MISMATCH (source bytes)', ['BI_SOURCE_HASH_MISMATCH', 'BI_SOURCE_LOGIC_CHANGED'], s => { s.member_sources[0].source += ' '; }, [memberDiag(1, 'BI_SOURCE_HASH_MISMATCH'), memberDiag(1, 'BI_SOURCE_LOGIC_CHANGED')]],
  ['BI_SOURCE_HASH_MISMATCH (source absent)', ['BI_SOURCE_HASH_MISMATCH', 'BI_SOURCE_LOGIC_CHANGED'], s => { s.member_sources.pop(); }, [memberDiag(2, 'BI_SOURCE_HASH_MISMATCH'), memberDiag(2, 'BI_SOURCE_LOGIC_CHANGED')]],
  ['BI_SOURCE_HASH_MISMATCH (packaged binding names another hash)', ['BI_SOURCE_HASH_MISMATCH'], s => { bindingEdit(s, binding => { binding.members[1].source_hash = sha('another'); }); }, [memberDiag(2, 'BI_SOURCE_HASH_MISMATCH')]],
  ['BI_EXIT_VERSION_UNSUPPORTED', ['BI_EXIT_VERSION_UNSUPPORTED'], s => { bindingEdit(s, binding => { binding.exit_version = 'bridge-exit-v9'; }); }, [memberDiag(1, 'BI_EXIT_VERSION_UNSUPPORTED'), memberDiag(2, 'BI_EXIT_VERSION_UNSUPPORTED')]],
  ['BI_NATIVE_ALERT_ISOLATION_UNPROVEN (record absent)', ['BI_NATIVE_ALERT_ISOLATION_UNPROVEN'], s => { s.native_alert_isolation.shift(); }, [memberDiag(1, 'BI_NATIVE_ALERT_ISOLATION_UNPROVEN')]],
  ['BI_NATIVE_ALERT_ISOLATION_UNPROVEN (routes enabled)', ['BI_NATIVE_ALERT_ISOLATION_UNPROVEN'], s => { s.native_alert_isolation[1].routes_disabled = false; }, [memberDiag(2, 'BI_NATIVE_ALERT_ISOLATION_UNPROVEN')]],
  ['BI_NATIVE_ALERT_ISOLATION_UNPROVEN (native payloads)', ['BI_NATIVE_ALERT_ISOLATION_UNPROVEN'], s => { s.native_alert_isolation[0].native_payloads = 1; }, [memberDiag(1, 'BI_NATIVE_ALERT_ISOLATION_UNPROVEN')]]
];
test('C2: the golden passes with an empty diagnostics list', () => {
  const result = c2(fresh());
  expectCodes(result, []);
  assert.deepEqual([...result.diagnostics], []);
});
for (const [name, expected, mutate, diagnostics] of C2_CASES) test('C2 negation: ' + name, () => {
  const s = fresh();
  mutate(s);
  const result = c2(s);
  expectCodes(result, expected.length === 2 && expected[0] === expected[1] ? [expected[0]] : expected);
  assert.deepEqual(result.diagnostics.map(item => ({...item})), diagnostics);
});

test('F18: one source default changed in the member 2 file gives BI_SOURCE_LOGIC_CHANGED naming member 2 and leaves member 1 alone', () => {
  const s = fresh();
  s.files['members/2/indicator.pine'] = s.files['members/2/indicator.pine'].replace('input.int(12,', 'input.int(13,');
  assert.notEqual(s.files['members/2/indicator.pine'], golden.rendered.files['members/2/indicator.pine']);
  seal(s);
  s.compile_records[1].indicator_sha256 = sha(s.files['members/2/indicator.pine']);
  const result = c2(s);
  expectCodes(result, ['BI_SOURCE_LOGIC_CHANGED']);
  assert.deepEqual(result.diagnostics.map(item => ({...item})), [memberDiag(2, 'BI_SOURCE_LOGIC_CHANGED')]);
  assert.equal(G.isRetryable('BI_SOURCE_LOGIC_CHANGED'), false);
  const full = G.evaluateMultiPackage(s);
  assert.equal(full.status, 'EXPORT_REFUSED');
  assert.deepEqual(full.gates.map(item => item.state), ['PASS', 'FAIL', 'NOT_REACHED', 'NOT_REACHED', 'NOT_REACHED']);
  assert.equal(full.record, null);
});

test('C2: every other edit of a member file is a logic change: the Bridge block, the pair, the edits list, the signals', () => {
  const edits = [
    ['an edit in the appended Bridge block', s => { s.files['members/1/indicator.pine'] = s.files['members/1/indicator.pine'].replace(/atrMult = input\.float\(2,/, 'atrMult = input.float(3,'); }],
    ['the original part', s => { s.files['members/1/indicator.pine'] = s.files['members/1/indicator.pine'].replace('len = input', 'len2 = input'); }],
    ['a trailing byte', s => { s.files['members/2/indicator.pine'] += '\n'; }],
    ['edits recorded in indicator.json', s => { jsonEdit(s, 'members/1/indicator.json', value => { value.edits = [{input_id: 'len'}]; }); }],
    ['another signal mapping', s => { s.member_sources[0].signals.buy = 'sellSignal'; }],
    ['a signal name that is not an identifier', s => { s.member_sources[1].signals.exit = 'bad name'; }]
  ];
  for (const [label, edit] of edits) {
    const s = fresh();
    edit(s);
    seal(s);
    for (const record of s.compile_records) record.indicator_sha256 = sha(s.files['members/' + record.ordinal + '/indicator.pine']);
    withCodes(c2(s), 'BI_SOURCE_LOGIC_CHANGED');
    assert.ok(c2(s).diagnostics.some(item => item.code === 'BI_SOURCE_LOGIC_CHANGED'), label);
  }
  // the pair comes from the run, not from the package: a file assembled with another pair is a logic change
  const s = fresh();
  s.run.result.selected.parameters = {atr_multiplier: '2.5', rr: '1'};
  withCodes(c2(s), 'BI_SOURCE_LOGIC_CHANGED');
});

test('C2: no member in the run is unresolved provenance', () => {
  expectCodes(c2({...fresh(), run: undefined}), ['BI_PROVENANCE_UNRESOLVED']);
  const s = fresh();
  s.run.contract.members = [];
  expectCodes(c2(s), ['BI_PROVENANCE_UNRESOLVED']);
});

/* ---- C3 ---- */

const C3_CASES = [
  ['BI_BINDING_MISMATCH (owner)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.owner_id = 'owner-x'; }); }],
  ['BI_BINDING_MISMATCH (submission hash)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.submission_hash = sha('other'); }); }],
  ['BI_BINDING_MISMATCH (membership hash)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.membership_hash = sha('other'); }); }],
  ['BI_BINDING_MISMATCH (member snapshot)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.members[1].baseline_snapshot_hash = sha('other'); }); }],
  ['no code (the member order in the binding is normalised)', [], s => { bindingEdit(s, binding => { binding.members.reverse(); }); }],
  ['BI_BINDING_MISMATCH (pair)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.bridge_pair.rr = 1; }); }],
  ['BI_BINDING_MISMATCH (input lock)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.input_lock_hash = sha('other'); }); }],
  ['BI_BINDING_MISMATCH (policy_version is not a multi binding field, RD-MP-44 R3)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.policy_version = 'policy-v1'; }); }],
  ['BI_BINDING_MISMATCH (ledger_initialization is not a multi binding field, RD-MP-44 R3)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.ledger_initialization = 'x'; }); }],
  ['BI_BINDING_MISMATCH (library versions)', ['BI_BINDING_MISMATCH'], s => { s.export.library_versions = {gates: 'older'}; }],
  ['BI_BINDING_MISMATCH (library versions not frozen)', ['BI_BINDING_MISMATCH'], s => { delete s.export; }],
  ['BI_BINDING_MISMATCH (result record ref)', ['BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.library_record_ref.result_sha256 = sha('other'); }); }],
  ['BI_BINDING_MISMATCH + MP_SOURCE_SLOTS_FORBIDDEN (slot bindings)', ['BI_BINDING_MISMATCH', 'MP_SOURCE_SLOTS_FORBIDDEN'], s => { bindingEdit(s, binding => { binding.slot_bindings = [{slot: 1, input_id: 'len', pine_variable: 'len'}]; }); }],
  ['F12: MP_SOURCE_SLOTS_FORBIDDEN (inputs.json)', ['MP_SOURCE_SLOTS_FORBIDDEN'], s => { edit(s, 'inputs.json', value => { value.source_inputs = [{input_id: 'len', slot: 1, before: '12', after: '13', unit: 'bars'}]; }); }],
  ['BI_INPUTS_MISMATCH (pair differs from the selected candidate, still in the domain)', ['BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { value.bridge.rr.after = '2'; }); }],
  ['BI_INPUTS_MISMATCH (a third actionable key)', ['BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { value.bridge.extra = clone(value.bridge.rr); }); }],
  ['BI_INPUTS_MISMATCH (domain declared differently)', ['BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { value.bridge.atr_multiplier.domain.max = '4'; }); }],
  ['BI_INPUTS_MISMATCH (other run)', ['BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { value.run_id = 'other'; }); }],
  ['BI_INPUTS_MISMATCH (unreadable block)', ['BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { delete value.bridge; }); }],
  ['BI_INPUT_OUT_OF_DOMAIN + BI_INPUTS_MISMATCH', ['BI_INPUT_OUT_OF_DOMAIN', 'BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { value.bridge.atr_multiplier.after = '9'; }); }],
  ['BI_INPUT_OUT_OF_DOMAIN (off the grid)', ['BI_INPUT_OUT_OF_DOMAIN', 'BI_INPUTS_MISMATCH'], s => { edit(s, 'inputs.json', value => { value.bridge.rr.after = '1.25'; }); }],
  ['BI_FIXED_INPUT_CHANGED (inputs.json member snapshot)', ['BI_FIXED_INPUT_CHANGED'], s => { edit(s, 'inputs.json', value => { value.members[1].effective_input_hash = sha('changed'); }); }],
  ['BI_FIXED_INPUT_CHANGED (member file snapshot)', ['BI_FIXED_INPUT_CHANGED'], s => { edit(s, 'members/1/indicator.json', value => { value.deployment_snapshot_hash = sha('changed'); }); }],
  ['BI_FIXED_INPUT_CHANGED (member list)', ['BI_FIXED_INPUT_CHANGED'], s => { edit(s, 'inputs.json', value => { value.members.pop(); }); }],
  ['BI_POLICY_SNAPSHOT_MISMATCH (hash)', ['BI_POLICY_SNAPSHOT_MISMATCH'], s => { edit(s, 'risk-profile.json', value => { value.policy_hash = sha('other'); }); }],
  ['BI_POLICY_SNAPSHOT_MISMATCH (policy body)', ['BI_POLICY_SNAPSHOT_MISMATCH'], s => { edit(s, 'risk-profile.json', value => { value.policy.maxRiskPercent = 5; }); }],
  ['BI_RISK_RELAXATION (limit above the hard limit)', ['BI_RISK_RELAXATION'], s => { edit(s, 'risk-profile.json', value => { value.limits.maxRiskPercent = '3'; }); }],
  ['BI_RISK_RELAXATION (hard limits absent)', ['BI_RISK_RELAXATION'], s => { delete s.hard_limits; }],
  ['BI_RISK_RELAXATION (limit missing)', ['BI_RISK_RELAXATION'], s => { edit(s, 'risk-profile.json', value => { delete value.limits.maxOrderNotional; }); }],
  ['BI_RESULT_MISMATCH (metrics)', ['BI_RESULT_MISMATCH'], s => { edit(s, 'quant-data/metrics.json', value => { value.train.net_return_percent = '9.9'; }); }],
  ['BI_RESULT_MISMATCH (candidate step)', ['BI_RESULT_MISMATCH'], s => { edit(s, 'quant-data/validation.json', value => { value.candidate.parameters.rr = 1; }); }],
  ['BI_RESULT_MISMATCH (sensitivity)', ['BI_RESULT_MISMATCH'], s => { edit(s, 'quant-data/validation.json', value => { value.sensitivity.pop(); }); }],
  ['BI_RESULT_MISMATCH (cost stress)', ['BI_RESULT_MISMATCH'], s => { edit(s, 'quant-data/validation.json', value => { value.cost_stress.fills = 1; }); }],
  ['BI_RESULT_MISMATCH (funnel diagnostics)', ['BI_RESULT_MISMATCH'], s => { edit(s, 'quant-data/validation.json', value => { value.funnel.diagnostics.bot.accepted = 99; }); }],
  ['BI_RESULT_MISMATCH (trace steps digest)', ['BI_RESULT_MISMATCH'], s => { s.trace_reproduction[0].steps_digest = sha('other'); }],
  ['F2: BI_RESULT_MISMATCH (reproduction steps digest differs from the stored steps, the manifest copy equals it)', ['BI_RESULT_MISMATCH'], s => {
    s.trace_reproduction[1].steps_digest = sha('forged steps');
    edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[1].steps_digest = sha('forged steps'); });
  }],
  ['BI_RESULT_MISMATCH (trace file bytes)', ['BI_RESULT_MISMATCH'], s => { s.files['quant-data/trades.csv'] += '\n'; seal(s); }],
  ['BI_RESULT_MISMATCH (trace method)', ['BI_RESULT_MISMATCH'], s => { s.trace_reproduction[2].method = 'recomputed'; }],
  ['BI_RESULT_MISMATCH (packaged record differs)', ['BI_RESULT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[1].steps_digest = sha('other'); }); }],
  ['HOLDOUT_MISMATCH (validation.json holdout)', ['HOLDOUT_MISMATCH'], s => { edit(s, 'quant-data/validation.json', value => { value.holdout.test.closed_trades = 6; }); }],
  ['HOLDOUT_MISMATCH (baseline copy)', ['HOLDOUT_MISMATCH'], s => { edit(s, 'quant-data/validation.json', value => { value.combined_baseline.matched = false; }); }],
  ['HOLDOUT_MISMATCH (holdout digest)', ['HOLDOUT_MISMATCH'], s => { s.trace_reproduction[1].holdout_digest = sha('other'); }],
  ['F3: HOLDOUT_MISMATCH (reproduction holdout digest differs from the stored holdout, the manifest copy equals it)', ['HOLDOUT_MISMATCH'], s => {
    s.trace_reproduction[2].holdout_digest = sha('forged holdout');
    edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[2].holdout_digest = sha('forged holdout'); });
  }],
  ['HOLDOUT_MISMATCH (decisions identity hash)', ['HOLDOUT_MISMATCH'], s => { s.trace_reproduction[0].decisions_hash = sha('other'); }],
  ['HOLDOUT_MISMATCH (run engine hash)', ['HOLDOUT_MISMATCH'], s => { s.trace_reproduction[2].run_engine_hash = sha('other'); }],
  ['N2: BI_RESULT_MISMATCH (producer closure hash is not hex, record and copy agree)', ['BI_RESULT_MISMATCH'], s => {
    s.trace_reproduction[0].producer_closure_hash = 'closure';
    edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[0].producer_closure_hash = 'closure'; });
  }],
  ['N2: BI_RESULT_MISMATCH (producer closure hash is upper case hex, record and copy agree)', ['BI_RESULT_MISMATCH'], s => {
    const upper = RI.producer_closure_hash.toUpperCase();
    for (const record of s.trace_reproduction) record.producer_closure_hash = upper;
    edit(s, MANIFEST, manifest => { for (const record of manifest.evidence.trace_records) record.producer_closure_hash = upper; });
  }],
  ['N2: BI_RESULT_MISMATCH (manifest copy producer closure hash differs)', ['BI_RESULT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[1].producer_closure_hash = sha('another closure'); }); }],
  ['N2: BI_RESULT_MISMATCH (manifest copy method differs)', ['BI_RESULT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[2].method = 'recomputed'; }); }],
  ['N2: BI_RESULT_MISMATCH (manifest copy sha256 differs)', ['BI_RESULT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[0].sha256 = sha('other file'); }); }],
  ['N2: HOLDOUT_MISMATCH (manifest copy decisions hash differs)', ['HOLDOUT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[0].decisions_hash = sha('other'); }); }],
  ['N2: HOLDOUT_MISMATCH (manifest copy run engine hash differs)', ['HOLDOUT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[1].run_engine_hash = sha('other'); }); }],
  ['N2: BI_RESULT_MISMATCH + HOLDOUT_MISMATCH (manifest copy carries an extra key)', ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.trace_records[0].extra = 1; }); }],
  ['N2: BI_RESULT_MISMATCH + HOLDOUT_MISMATCH (reproduction record carries an extra key)', ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH'], s => { s.trace_reproduction[0].extra = 1; }],
  ['N3: BI_FIXED_INPUT_CHANGED (deployment snapshot is not the frozen one)', ['BI_FIXED_INPUT_CHANGED'], s => { s.deployments[1].snapshot.funding_cutoff = 99; }],
  ['N3: BI_FIXED_INPUT_CHANGED (deployment snapshot absent)', ['BI_FIXED_INPUT_CHANGED'], s => { delete s.deployments[0].snapshot; }],
  ['N4: BI_EXIT_VERSION_UNSUPPORTED (duplicated deployment_id)', ['BI_EXIT_VERSION_UNSUPPORTED'], s => { s.deployments.push(clone(s.deployments[0])); }],
  ['BI_RESULT_MISMATCH + HOLDOUT_MISMATCH (no reproduction record)', ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH'], s => { delete s.trace_reproduction; }],
  ['BI_RESULT_MISMATCH + HOLDOUT_MISMATCH (duplicated record)', ['BI_RESULT_MISMATCH', 'HOLDOUT_MISMATCH'], s => { s.trace_reproduction.push(clone(s.trace_reproduction[0])); }],
  ['BI_DATASET_UNAVAILABLE (not readable)', ['BI_DATASET_UNAVAILABLE'], s => { s.dataset.readable = false; }],
  ['BI_DATASET_UNAVAILABLE (absent)', ['BI_DATASET_UNAVAILABLE'], s => { delete s.dataset; }],
  ['BI_DATASET_UNAVAILABLE (window)', ['BI_DATASET_UNAVAILABLE'], s => { s.dataset.metadata.total_bars -= 1; }],
  ['BI_DATASET_UNAVAILABLE (metadata)', ['BI_DATASET_UNAVAILABLE'], s => { s.dataset.metadata = null; }],
  ['BI_DATASET_HASH_MISMATCH', ['BI_DATASET_HASH_MISMATCH'], s => { s.dataset.digest = sha('other'); }],
  ['BI_MARKET_SCOPE_INVALID (dataset metadata)', ['BI_MARKET_SCOPE_INVALID'], s => { s.dataset.metadata.symbol = 'ETHUSDT'; }],
  ['BI_ENGINE_HASH_MISMATCH (manifest evidence)', ['BI_ENGINE_HASH_MISMATCH'], s => { edit(s, MANIFEST, manifest => { manifest.evidence.engine_hash = sha('other'); }); }],
  ['BI_ENGINE_HASH_MISMATCH + BI_BINDING_MISMATCH (binding)', ['BI_ENGINE_HASH_MISMATCH', 'BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.engine_hash = sha('other'); }); }],
  ['BI_COST_MODEL_UNSUPPORTED', ['BI_COST_MODEL_UNSUPPORTED', 'BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.cost_model_version = 'other-v1'; }); }],
  ['BI_EXIT_VERSION_UNSUPPORTED (deployment)', ['BI_EXIT_VERSION_UNSUPPORTED'], s => { s.deployments[1].exit_version = 'bridge-exit-v9'; }],
  ['BI_EXIT_VERSION_UNSUPPORTED (deployment absent)', ['BI_EXIT_VERSION_UNSUPPORTED'], s => { s.deployments.pop(); }],
  ['BI_EXIT_VERSION_UNSUPPORTED (binding)', ['BI_EXIT_VERSION_UNSUPPORTED', 'BI_BINDING_MISMATCH'], s => { bindingEdit(s, binding => { binding.exit_version = 'bridge-exit-v9'; }); }],
  ['BI_FIXTURE_LABEL_MISSING (manifest)', ['BI_FIXTURE_LABEL_MISSING'], s => { edit(s, MANIFEST, manifest => { manifest.fixture = false; }); }],
  ['BI_FIXTURE_LABEL_MISSING (binding)', ['BI_FIXTURE_LABEL_MISSING'], s => { bindingEdit(s, binding => { binding.fixture = false; }); }]
];
for (const [name, expected, mutate] of C3_CASES) test('C3 negation: ' + name, () => {
  const s = fresh();
  mutate(s);
  expectCodes(c3(s), expected);
});

test('C3: unresolvable provenance', () => {
  expectCodes(c3({...fresh(), run: undefined}), ['BI_PROVENANCE_UNRESOLVED']);
  const hash = fresh();
  hash.run.contract_hash = sha('other');
  expectCodes(c3(hash), ['BI_PROVENANCE_UNRESOLVED']);
  const manifest = fresh();
  delete manifest.files[MANIFEST];
  expectCodes(c3(manifest), ['BI_PROVENANCE_UNRESOLVED']);
  const result = fresh();
  result.run.result = null;
  expectCodes(c3(result), ['BI_PROVENANCE_UNRESOLVED']);
});

/* ---- C4 ---- */

const C4_CASES = [
  ['BI_DATASET_ALIGNMENT_MISSING (record absent)', ['BI_DATASET_ALIGNMENT_MISSING'], s => { delete s.evidence.members[1].dataset_alignment; }, [memberDiag(2, 'BI_DATASET_ALIGNMENT_MISSING')]],
  ['BI_DATASET_ALIGNMENT_FAILED', ['BI_DATASET_ALIGNMENT_FAILED'], s => { s.evidence.members[0].dataset_alignment.matched_percent = 99; }, [memberDiag(1, 'BI_DATASET_ALIGNMENT_FAILED')]],
  ['BI_PARITY_EVIDENCE_MISSING (F19: member 2 native parity absent)', ['BI_PARITY_EVIDENCE_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { delete s.evidence.members[1].native_parity; }, [memberDiag(2, 'BI_PARITY_EVIDENCE_MISSING')]],
  ['BI_PARITY_EVIDENCE_MISSING (bridge parity absent)', ['BI_PARITY_EVIDENCE_MISSING'], s => { delete s.evidence.members[0].bridge_parity; }, [memberDiag(1, 'BI_PARITY_EVIDENCE_MISSING')]],
  ['BI_PARITY_EVIDENCE_MISSING (no entry for member 1)', ['BI_DATASET_ALIGNMENT_MISSING', 'BI_PARITY_EVIDENCE_MISSING', 'BI_REPAINT_EVIDENCE_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members.shift(); },
    [memberDiag(1, 'BI_DATASET_ALIGNMENT_MISSING'), memberDiag(1, 'BI_PARITY_EVIDENCE_MISSING'), memberDiag(1, 'BI_PARITY_EVIDENCE_MISSING'), memberDiag(1, 'BI_REPAINT_EVIDENCE_MISSING')]],
  ['BI_PARITY_EVIDENCE_MISSING (no evidence at all)', ['BI_DATASET_ALIGNMENT_MISSING', 'BI_PARITY_EVIDENCE_MISSING', 'BI_REPAINT_EVIDENCE_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { delete s.evidence; }, null],
  ['BI_PARITY_SAMPLE_FLOOR_NOT_MET', ['BI_PARITY_SAMPLE_FLOOR_NOT_MET', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[1].native_parity.sample.buy_events = 29; }, [memberDiag(2, 'BI_PARITY_SAMPLE_FLOOR_NOT_MET')]],
  ['BI_PARITY_SAMPLE_FLOOR_NOT_MET (warm-up below 5 x lookback)', ['BI_PARITY_SAMPLE_FLOOR_NOT_MET', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[0].native_parity.sample.lookback = 300; }, [memberDiag(1, 'BI_PARITY_SAMPLE_FLOOR_NOT_MET')]],
  ['BI_NATIVE_SIGNAL_PARITY_FAILED', ['BI_NATIVE_SIGNAL_PARITY_FAILED', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[0].native_parity.missing_events = 1; }, [memberDiag(1, 'BI_NATIVE_SIGNAL_PARITY_FAILED')]],
  ['F4: BI_NATIVE_SIGNAL_PARITY_FAILED (match percent alone)', ['BI_NATIVE_SIGNAL_PARITY_FAILED', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[0].native_parity.match_percent = 99; }, [memberDiag(1, 'BI_NATIVE_SIGNAL_PARITY_FAILED')]],
  ['BI_NATIVE_SIGNAL_PARITY_FAILED (shift)', ['BI_NATIVE_SIGNAL_PARITY_FAILED', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[1].native_parity.shift_bars = 1; }, [memberDiag(2, 'BI_NATIVE_SIGNAL_PARITY_FAILED')]],
  ['BI_BRIDGE_PARITY_FAILED', ['BI_BRIDGE_PARITY_FAILED'], s => { s.evidence.members[1].bridge_parity.sl_tp_diff_ticks = 1; }, [memberDiag(2, 'BI_BRIDGE_PARITY_FAILED')]],
  ['BI_BRIDGE_PARITY_FAILED (exit version)', ['BI_BRIDGE_PARITY_FAILED'], s => { s.evidence.members[0].bridge_parity.exit_version = 'bridge-exit-v9'; }, [memberDiag(1, 'BI_BRIDGE_PARITY_FAILED')]],
  ['BI_REPAINT_EVIDENCE_MISSING (record absent)', ['BI_REPAINT_EVIDENCE_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { delete s.evidence.members[0].repaint; }, [memberDiag(1, 'BI_REPAINT_EVIDENCE_MISSING')]],
  ['BI_REPAINT_EVIDENCE_MISSING (too few observations)', ['BI_REPAINT_EVIDENCE_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[1].repaint.observations = 99; }, [memberDiag(2, 'BI_REPAINT_EVIDENCE_MISSING')]],
  ['BI_REPAINT_FLAGS_CHANGED', ['BI_REPAINT_FLAGS_CHANGED', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[0].repaint.changed_flags = 2; }, [memberDiag(1, 'BI_REPAINT_FLAGS_CHANGED')]],
  ['F25: MP_MEMBER_PARITY_SCOPE_MISMATCH (member 2 names member 1 evidence)', ['MP_MEMBER_PARITY_SCOPE_MISMATCH', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => {
    for (const kind of ['dataset_alignment', 'native_parity', 'bridge_parity', 'repaint']) s.evidence.members[1][kind].scope = clone(s.evidence.members[0][kind].scope);
  }, [memberDiag(2, 'MP_MEMBER_PARITY_SCOPE_MISMATCH')]],
  ['MP_MEMBER_PARITY_SCOPE_MISMATCH (engine hash)', ['MP_MEMBER_PARITY_SCOPE_MISMATCH', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members[0].repaint.scope.engine_hash = sha('other'); }, [memberDiag(1, 'MP_MEMBER_PARITY_SCOPE_MISMATCH')]],
  ['MP_MEMBER_PARITY_SCOPE_MISMATCH (scope absent)', ['MP_MEMBER_PARITY_SCOPE_MISMATCH'], s => { delete s.evidence.members[1].bridge_parity.scope; }, [memberDiag(2, 'MP_MEMBER_PARITY_SCOPE_MISMATCH')]],
  ['MP_MEMBER_PARITY_SCOPE_MISMATCH (deployment)', ['MP_MEMBER_PARITY_SCOPE_MISMATCH'], s => { s.evidence.members[0].dataset_alignment.scope.deployment_id = 'dep-other'; }, [memberDiag(1, 'MP_MEMBER_PARITY_SCOPE_MISMATCH')]],
  ['N7: MP_MEMBER_PARITY_SCOPE_MISMATCH (two evidence entries for member 1 are ambiguous, not missing)', ['MP_MEMBER_PARITY_SCOPE_MISMATCH', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members.push(clone(s.evidence.members[0])); },
    [memberDiag(1, 'MP_MEMBER_PARITY_SCOPE_MISMATCH')]],
  ['N7: MP_MEMBER_PARITY_SCOPE_MISMATCH (two entries for member 2, one of them empty)', ['MP_MEMBER_PARITY_SCOPE_MISMATCH', 'ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.evidence.members.push({ordinal: 2}); },
    [memberDiag(2, 'MP_MEMBER_PARITY_SCOPE_MISMATCH')]],
  ['MP_COMBINED_BASELINE_FAILED (missing)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline = null; }, []],
  ['MP_COMBINED_BASELINE_FAILED (absent key)', ['MP_COMBINED_BASELINE_FAILED'], s => { delete s.run.result.combined_baseline; }, []],
  ['MP_COMBINED_BASELINE_FAILED (untied: other run)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.binding.run_id = 'other-run'; }, []],
  ['MP_COMBINED_BASELINE_FAILED (untied: other contract hash)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.binding.contract_hash = sha('other'); }, []],
  ['MP_COMBINED_BASELINE_FAILED (untied: no binding)', ['MP_COMBINED_BASELINE_FAILED'], s => { delete s.run.result.combined_baseline.binding; }, []],
  ['MP_COMBINED_BASELINE_FAILED (wrong pair)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.pair = {atr_multiplier: '2', rr: '1'}; }, []],
  ['MP_COMBINED_BASELINE_FAILED (pair absent)', ['MP_COMBINED_BASELINE_FAILED'], s => { delete s.run.result.combined_baseline.pair; }, []],
  ['MP_COMBINED_BASELINE_FAILED (matched false)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.matched = false; }, []],
  ['MP_COMBINED_BASELINE_FAILED (matched not boolean true)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.matched = 'true'; }, []],
  ['F5: MP_COMBINED_BASELINE_FAILED (same bar order differs)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.same_bar_order = 'ordinal-first-v1'; }, []],
  ['MP_COMBINED_BASELINE_FAILED (version)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.combined_baseline.version = 'mp-combined-baseline-v0'; }, []],
  ['MP_COMBINED_BASELINE_FAILED (decisions identity hash)', ['MP_COMBINED_BASELINE_FAILED'], s => { s.run.result.holdout_decisions.pop(); }, []],
  ['BI_SOURCE_VERSION_STALE', ['BI_SOURCE_VERSION_STALE'], s => { s.current.membership[0].source_version = 2; }, []],
  ['BI_SOURCE_VERSION_STALE (source hash)', ['BI_SOURCE_VERSION_STALE'], s => { s.current.membership[1].source_hash = sha('new source'); }, []],
  ['BI_MEMBERSHIP_CHANGED', ['BI_MEMBERSHIP_CHANGED'], s => { s.current.membership_hash = sha('other'); }, []],
  ['BI_POLICY_SNAPSHOT_MISMATCH (policy hash)', ['BI_POLICY_SNAPSHOT_MISMATCH'], s => { s.current.policy_hash = sha('other'); }, []],
  ['BI_POLICY_SNAPSHOT_MISMATCH (capital)', ['BI_POLICY_SNAPSHOT_MISMATCH'], s => { s.current.capital = {equity: '999', cash: '999'}; }, []],
  ['BI_POLICY_SNAPSHOT_MISMATCH (funding)', ['BI_POLICY_SNAPSHOT_MISMATCH'], s => { s.current.funding_cutoff = 8; }, []],
  ['BI_DEPLOYMENT_CHANGED', ['BI_DEPLOYMENT_CHANGED'], s => { s.current.membership[1].deployment_id = 'dep-new'; }, []],
  ['BI_SELECTION_CHANGED (input lock)', ['BI_SELECTION_CHANGED'], s => { s.current.input_lock_hash = sha('other'); }, []],
  ['no code (B1: a current.bridge_pair is not read; the frozen deployment pair is covered by the input lock)', [], s => { s.current.bridge_pair = {atr_multiplier: '9', rr: '9'}; }, []],
  ['BI_DATASET_UNAVAILABLE (freshness)', ['BI_DATASET_UNAVAILABLE'], s => { s.current.dataset_available = false; }, []],
  ['freshness: a state that is unreadable differs on every code', ['BI_SOURCE_VERSION_STALE', 'BI_MEMBERSHIP_CHANGED', 'BI_POLICY_SNAPSHOT_MISMATCH', 'BI_DEPLOYMENT_CHANGED', 'BI_SELECTION_CHANGED', 'BI_DATASET_UNAVAILABLE'], s => { delete s.current; }, []],
  ['BI_BRIDGE_PAIR_OUT_OF_BOUNDS', ['BI_BRIDGE_PAIR_OUT_OF_BOUNDS'], s => { s.bridge_bounds.rr.max = '1'; }, []],
  ['BI_BRIDGE_PAIR_OUT_OF_BOUNDS (bounds absent)', ['BI_BRIDGE_PAIR_OUT_OF_BOUNDS'], s => { delete s.bridge_bounds; }, []],
  ['ACCEPTANCE_BLOCKERS_PRESENT (no clearances)', ['ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.clearances = []; }, []],
  ['ACCEPTANCE_BLOCKERS_PRESENT (member 2 not cleared for repaint)', ['ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.clearances = s.clearances.filter(item => !(item.blocker === 'CUSTOM_REPAINT_EVIDENCE_REQUIRED' && item.ordinal === 2)); }, []],
  ['ACCEPTANCE_BLOCKERS_PRESENT (other pair)', ['ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.clearances[0].parameter_hash = sha('other'); }, []],
  ['ACCEPTANCE_BLOCKERS_PRESENT (other export)', ['ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.clearances[1].export_id = 'other-export'; }, []],
  ['ACCEPTANCE_BLOCKERS_PRESENT (other evidence)', ['ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.clearances[2].evidence_hash = sha('other'); }, []],
  ['ACCEPTANCE_BLOCKERS_PRESENT (clearance of another run)', ['ACCEPTANCE_BLOCKERS_PRESENT'], s => { s.clearances[3].run_id = 'other-run'; }, []],
  ['BLOCKERS_UNKNOWN', ['BLOCKERS_UNKNOWN'], s => { s.run.contract.acceptance_blockers = null; }, []]
];
test('C4: the golden passes with an empty diagnostics list', () => {
  const result = c4(fresh());
  expectCodes(result, []);
  assert.deepEqual([...result.diagnostics], []);
});
for (const [name, expected, mutate, diagnostics] of C4_CASES) test('C4 negation: ' + name, () => {
  const s = fresh();
  mutate(s);
  const result = c4(s);
  expectCodes(result, expected);
  if (diagnostics !== null) assert.deepEqual(result.diagnostics.map(item => ({...item})), diagnostics);
});

test('C4: freshness codes come in the FRESHNESS_ORDER whatever the order of the differences', () => {
  const s = fresh();
  s.current.dataset_available = false;
  s.current.input_lock_hash = sha('x');
  s.current.membership[1].deployment_id = 'dep-new';
  s.current.policy_hash = sha('y');
  s.current.membership_hash = sha('z');
  s.current.membership[0].source_version = 9;
  assert.deepEqual([...c4(s).codes], [...G.FRESHNESS_ORDER]);
  assert.deepEqual(G.multiFreshnessCodes(s.binding, s.current), [...ONE.FRESHNESS_ORDER]);
  assert.deepEqual(G.multiFreshnessCodes(fresh().binding, fresh().current), []);
  // F10 / F11: the member 2 disconnects after the freeze
  const t = fresh();
  t.current.membership.pop();
  t.current.membership_hash = sha('without member 2');
  assert.deepEqual(G.multiFreshnessCodes(t.binding, t.current), ['BI_SOURCE_VERSION_STALE', 'BI_MEMBERSHIP_CHANGED', 'BI_DEPLOYMENT_CHANGED']);
  const view = G.multiReadState({status: 'EXPORT_INTERNAL', binding: t.binding, current: t.current, replay_mismatch: false, requester_owner_id: 'owner-a'});
  assert.equal(view.state, 'STALE');
  assert.equal(view.code, 'BI_SOURCE_VERSION_STALE');
  // the first code of an export read is the first differing code
  const replay = G.multiReadState({status: 'EXPORT_INTERNAL', binding: t.binding, current: t.current, replay_mismatch: true, requester_owner_id: 'owner-a'});
  assert.equal(replay.code, 'REPLAY_MISMATCH');
});

test('C4: unresolvable provenance', () => {
  expectCodes(c4({...fresh(), run: undefined}), ['BI_PROVENANCE_UNRESOLVED']);
  const manifest = fresh();
  delete manifest.files[MANIFEST];
  expectCodes(c4(manifest), ['BI_PROVENANCE_UNRESOLVED']);
  const members = fresh();
  members.run.contract.members = [];
  expectCodes(c4(members), ['BI_PROVENANCE_UNRESOLVED']);
});

/* ---- Q ---- */

test('Q: passes only after C1 to C4 passed, refuses bad attempt metadata, and builds the RD-MP-37 record', () => {
  const s = fresh();
  const gates = [c1, c2, c3, c4].map(gate => gate(s));
  const q = G.evaluateMultiQualification(s, gates);
  assert.equal(q.gate, 'Q');
  assert.equal(q.state, 'PASS');
  assert.equal(q.record.mode, 'MULTI_PINE');
  assert.equal(q.record.fixture, true);
  assert.deepEqual(Object.keys(q.record).sort(), ['attempt_id', 'binding_hash', 'export_id', 'fixture', 'gate_results', 'mode', 'package_hash', 'validated_at_utc', 'validator_engine_hash']);
  assert.equal(G.evaluateMultiQualification(s, gates.slice(0, 3)).state, 'NOT_REACHED');
  assert.equal(G.evaluateMultiQualification(s, [...gates.slice(0, 3), ONE.notReached('C4')]).state, 'NOT_REACHED');
  for (const attempt of [undefined, {}, {attempt_id: 'a'}, {...golden.attempt, validated_at_utc: 'today'}, {...golden.attempt, validator_engine_hash: 'x'}]) {
    const refused = G.evaluateMultiQualification({...s, attempt}, gates);
    assert.equal(refused.refused, 'INPUT_INVALID');
    assert.equal(refused.pass, false);
  }
  const unhashed = G.evaluateMultiQualification({...s, package_hash: 'x'}, gates);
  assert.deepEqual([...unhashed.codes], ['BI_BINDING_INCOMPLETE']);
  const unlabelled = fresh();
  jsonEdit(unlabelled, MANIFEST, manifest => { manifest.fixture = false; });
  assert.deepEqual([...G.evaluateMultiQualification(unlabelled, gates).codes], ['BI_FIXTURE_LABEL_MISSING']);
});

/* ---- attempt flow, F19 and the stored statuses ---- */

test('evaluateMultiPackage refuses the call for a foreign run and for unusable caller input, and records no status', () => {
  const refusedCases = [
    [{...fresh(), owner_id: 'owner-x'}, 'NOT_FOUND', []],
    [{...fresh(), run: undefined}, 'NOT_FOUND', []],
    [{...fresh(), current_rules: undefined}, 'INPUT_INVALID', ['current_rules']],
    [{...fresh(), replay_mismatch: 'no'}, 'BI_REPLAY_STATE_UNAVAILABLE', ['replay_mismatch']],
    [{...fresh(), replay_mismatch: undefined, current_rules: undefined}, 'BI_REPLAY_STATE_UNAVAILABLE', ['current_rules', 'replay_mismatch']],
    [{...fresh(), attempt: {}}, 'INPUT_INVALID', ['attempt.attempt_id', 'attempt.validator_engine_hash', 'attempt.validated_at_utc']],
    [{...fresh(), attempt_no: 0}, 'INPUT_INVALID', ['attempt_no']],
    [{...fresh(), attempt_no: 6}, 'INPUT_INVALID', ['attempt_no']],
    [{...fresh(), attempt_no: 1.5}, 'INPUT_INVALID', ['attempt_no']],
    [{...fresh(), attempt_no: '1'}, 'INPUT_INVALID', ['attempt_no']]];
  for (const [subject, reason, fields] of refusedCases) {
    const result = G.evaluateMultiPackage(subject);
    assert.equal(result.refused, reason);
    assert.deepEqual([...result.fields], fields);
    assert.deepEqual([result.pass, result.next, result.status, result.record, result.ready], [false, null, null, null, false]);
    assert.deepEqual([...result.gates], []);
  }
});

test('F19: a missing member parity record is retryable, names member 2, keeps EXPORT_CANDIDATE up to attempt 4 and exhausts at attempt 5', () => {
  const diagnostic = {code: 'BI_PARITY_EVIDENCE_MISSING', ordinal: 2, pine_import_id: RI.run.contract.members[1].pine_import_id};
  for (let attempt = 1; attempt <= 5; attempt++) {
    const s = fresh();
    s.attempt_no = attempt;
    delete s.evidence.members[1].native_parity;
    const result = G.evaluateMultiPackage(s);
    assert.equal(result.pass, false);
    assert.deepEqual(result.gates.map(item => item.state), ['PASS', 'PASS', 'PASS', 'FAIL', 'NOT_REACHED']);
    assert.deepEqual(sorted(result.codes), ['ACCEPTANCE_BLOCKERS_PRESENT', 'BI_PARITY_EVIDENCE_MISSING']);
    assert.ok(result.codes.every(code => G.isRetryable(code)), 'retryable only');
    assert.deepEqual(result.diagnostics.map(item => ({...item})), [diagnostic]);
    assert.equal(result.record, null);
    assert.equal(result.ready, false);
    if (attempt < 5) {
      assert.equal(result.status, 'EXPORT_CANDIDATE', 'attempt ' + attempt);
      assert.deepEqual({ok: result.next.ok, to: result.next.to}, {ok: true, to: 'EXPORT_CANDIDATE'});
      assert.ok(!result.next.codes.includes('BI_ATTEMPTS_EXHAUSTED'));
    } else {
      assert.equal(result.status, 'EXPORT_REFUSED');
      assert.ok(result.next.codes.includes('BI_ATTEMPTS_EXHAUSTED'));
      assert.deepEqual(sorted(result.next.codes), ['ACCEPTANCE_BLOCKERS_PRESENT', 'BI_ATTEMPTS_EXHAUSTED', 'BI_PARITY_EVIDENCE_MISSING']);
    }
  }
});

test('a hard failure refuses the package at once and later gates are NOT_REACHED; a retryable-only failure does not stop the later gates', () => {
  const hard = fresh();
  hard.files['setup-guide.md'] += '\napi_key: abcdefghijklmnop1234\n';
  seal(hard);
  const refused = G.evaluateMultiPackage(hard);
  assert.deepEqual(refused.gates.map(item => item.state), ['FAIL', 'NOT_REACHED', 'NOT_REACHED', 'NOT_REACHED', 'NOT_REACHED']);
  assert.deepEqual(refused.gates[1], ONE.notReached('C2'));
  assert.equal(refused.status, 'EXPORT_REFUSED');
  assert.deepEqual([...refused.codes], ['BI_SECRET_DETECTED']);
  const soft = fresh();
  soft.compile_records.pop();
  delete soft.evidence.members[0].repaint;
  const retryable = G.evaluateMultiPackage(soft);
  assert.deepEqual(retryable.gates.map(item => item.state), ['PASS', 'FAIL', 'PASS', 'FAIL', 'NOT_REACHED']);
  assert.equal(retryable.status, 'EXPORT_CANDIDATE');
  assert.deepEqual(sorted(retryable.codes), ['ACCEPTANCE_BLOCKERS_PRESENT', 'BI_COMPILE_EVIDENCE_MISSING', 'BI_REPAINT_EVIDENCE_MISSING']);
  // a mix of a retryable and a hard code refuses
  const mixed = fresh();
  mixed.compile_records.pop();
  mixed.dataset.readable = false;
  const both = G.evaluateMultiPackage(mixed);
  assert.equal(both.status, 'EXPORT_REFUSED');
  assert.deepEqual(sorted(both.codes), ['BI_COMPILE_EVIDENCE_MISSING', 'BI_DATASET_UNAVAILABLE']);
  assert.deepEqual(both.gates.map(item => item.state), ['PASS', 'FAIL', 'FAIL', 'NOT_REACHED', 'NOT_REACHED']);
  assert.equal(G.isRetryable('MP_COMBINED_BASELINE_FAILED'), false);
  assert.equal(G.isRetryable('MP_MEMBER_PARITY_SCOPE_MISMATCH'), false);
  for (const code of ['BI_COMPILE_EVIDENCE_MISSING', 'BI_PARITY_EVIDENCE_MISSING', 'BI_REPAINT_EVIDENCE_MISSING', 'BI_DATASET_ALIGNMENT_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT']) assert.equal(G.isRetryable(code), true, code);
});

test('evaluateMultiPackage does not change the subject and gives the same answer twice (no clock, no random source)', () => {
  const s = fresh();
  const before = JSON.stringify(s);
  const first = G.evaluateMultiPackage(s), second = G.evaluateMultiPackage(s);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  for (const gate of [b0, c1, c2, c3, c4]) { gate(s); assert.equal(JSON.stringify(s), before); }
});

/* ---- wrong-type input never throws ---- */

const WRONG = [undefined, null, 0, 1, -1, NaN, 'x', '', true, false, [], [1, 'a'], {}, {run: 5}, {run: []}, {run: {contract: 5, result: 'a'}, files: 'z'}, () => 1, 10n, new Date(0), new Map(), {files: [], run: {contract: {}, result: {}}}];
function wellFormed(result, label) {
  assert.equal(typeof result, 'object', label);
  assert.ok(result !== null, label);
  assert.ok(Array.isArray(result.codes), label);
  for (const code of result.codes) assert.match(code, ONE.CODE_PATTERN, label);
  for (const item of result.diagnostics ?? []) assert.match(item.code, ONE.CODE_PATTERN, label);
  note(result.codes);
}
test('wrong-type input gives a code (or a refusal) and never throws, for every gate and the full evaluation', () => {
  const gates = {b0, c1, c2, c3, c4, package: G.evaluateMultiPackage};
  for (const [name, gate] of Object.entries(gates)) for (const wrong of WRONG) {
    const result = gate(wrong);
    wellFormed(result, name + ' ' + String(wrong));
    assert.equal(result.pass, false, name);
  }
  for (const wrong of WRONG) {
    wellFormed(G.evaluateMultiQualification(wrong, wrong), 'Q');
    assert.equal(G.evaluateMultiQualification(wrong, wrong).pass, false);
    assert.ok(Array.isArray(G.multiFreshnessCodes(wrong, wrong)));
    assert.equal(G.multiFreshness(wrong).fresh, false);
    assert.equal(G.multiReadState(wrong).ready, false);
  }
  // every subject key replaced by every wrong value, and every nested run field
  const base = fresh();
  for (const key of Object.keys(base)) for (const wrong of WRONG) {
    const subject = {...base, [key]: wrong};
    for (const [name, gate] of Object.entries(gates)) wellFormed(gate(subject), name + ' ' + key + '=' + String(wrong));
  }
  for (const key of Object.keys(base.run)) for (const wrong of WRONG) {
    const subject = {...base, run: {...base.run, [key]: wrong}};
    for (const [name, gate] of Object.entries(gates)) wellFormed(gate(subject), name + ' run.' + key + '=' + String(wrong));
  }
  for (const key of Object.keys(base.run.result)) for (const wrong of [undefined, null, 'x', 5, [], {}]) {
    const subject = {...base, run: {...base.run, result: {...base.run.result, [key]: wrong}}};
    for (const [name, gate] of Object.entries(gates)) wellFormed(gate(subject), name + ' result.' + key);
  }
  for (const key of Object.keys(base.run.contract)) for (const wrong of [undefined, null, 'x', 5, [], {}]) {
    const subject = {...base, run: {...base.run, contract: {...base.run.contract, [key]: wrong}}};
    for (const [name, gate] of Object.entries(gates)) wellFormed(gate(subject), name + ' contract.' + key);
  }
  for (const key of Object.keys(base.files)) for (const wrong of [undefined, null, 5, [], {}, new Uint8Array([1, 2]), '\u0000']) {
    const subject = {...base, files: {...base.files, [key]: wrong}};
    for (const [name, gate] of Object.entries(gates)) wellFormed(gate(subject), name + ' files.' + key);
  }
  // a package given as bytes reads like the same package given as text
  const bytes = {...fresh()};
  bytes.files = Object.fromEntries(Object.entries(bytes.files).map(([path, text]) => [path, new TextEncoder().encode(text)]));
  expectCodes(c1(bytes), []);
  expectCodes(c3(bytes), []);
});

/* ---- parity with the one-Pine module wherever a check is shared ---- */

/** A minimal, valid one-Pine package built with the one-Pine builder. The shared C1 checks are compared on it. */
function onePineSubject() {
  const files = {
    'inputs.json': jsonText({run_id: 'run-1', source_inputs: [], bridge: {atr_multiplier: {unit: 'ATR multiple', before: '2', after: '2.5'}, rr: {unit: 'ratio', before: '1', after: '1.5'}}}),
    'indicator.pine': '//@version=5\nindicator("one")\nplot(close)\n',
    'indicator.json': jsonText({alert_source: 'alert_calls', symbol: 'BINANCE:BTCUSDT', timeframe: '1', edits: []}),
    'risk-profile.json': jsonText({policy_hash: sha('policy'), limits: {}}),
    'setup-guide.md': '# guide\n', 'validation.html': '<p>x</p>\n',
    'quant-data/metrics.json': jsonText({train: {closed_trades: 8, net_return_percent: '1.5'}, validation: {closed_trades: 6, net_return_percent: '0.9'}, test: {closed_trades: 5, net_return_percent: '0.4'}}),
    'quant-data/equity.csv': 'a\n', 'quant-data/trades.csv': 'a\n', 'quant-data/decisions.csv': 'a\n', 'quant-data/validation.json': jsonText({})};
  const manifest = ONE.buildManifest({identity: {export_id: 'export-1', created_at: '2026-10-21T12:00:00Z'}, binding: {alert_source: 'alert_calls', market: clone(MARKET)}, inputs: {}, evidence: {},
    limitations: {text: 'x', codes: []}, fixture: true, files});
  files[MANIFEST] = jsonText(manifest);
  return {files, package_hash: ONE.packageHash(manifest), binding_hash: ONE.bindingHash(manifest.binding), binding: manifest.binding};
}
const SHARED_C1 = ['BI_SECRET_DETECTED', 'BI_MACHINE_PATH_DETECTED', 'BI_MANIFEST_SCHEMA_INVALID', 'BI_CHECKSUM_MISMATCH', 'BI_NUMERIC_FORMAT_INVALID', 'BI_ALERT_SOURCE_INVALID', 'BI_MARKET_SCOPE_INVALID'];
const SHARED_ACTIONS = {
  none: [() => {}, true],
  'a secret in a file': [s => { s.files['setup-guide.md'] += '\napi_key: abcdefghijklmnop1234\n'; }, true],
  'a bearer token in a file': [s => { s.files['setup-guide.md'] += '\nAuthorization: Bearer abcdefghijklmnop1234\n'; }, true],
  'a private key header': [s => { s.files['validation.html'] += '\n-----BEGIN RSA PRIVATE KEY-----\n'; }, true],
  'a Windows path': [s => { s.files['setup-guide.md'] += '\nC:\\Users\\someone\\x\n'; }, true],
  'a POSIX home path': [s => { s.files['setup-guide.md'] += '\nsee /home/someone/x.txt\n'; }, true],
  'a secret and a path together': [s => { s.files['validation.html'] += '\npassword=abcdefghijklmnop1234 /Users/a/b\n'; }, true],
  'a metric as a number': [s => jsonEdit(s, 'quant-data/metrics.json', value => { value.train.net_return_percent = 1.5; }), true],
  'a count as text': [s => jsonEdit(s, 'quant-data/metrics.json', value => { value.test.closed_trades = '5'; }), true],
  'a metric that is not a decimal': [s => jsonEdit(s, 'quant-data/metrics.json', value => { value.validation.max_drawdown_percent = '1e-3'; }), true],
  'a bad manifest creation time': [s => jsonEdit(s, MANIFEST, value => { value.identity.created_at = 'yesterday'; }), true],
  'a bad manifest schema': [s => jsonEdit(s, MANIFEST, value => { value.schema_version = 'x'; }), true],
  'a manifest with an extra key': [s => jsonEdit(s, MANIFEST, value => { value.extra = 1; }), true],
  'a changed byte, manifest not updated': [s => { s.files['risk-profile.json'] += ' '; }, false],
  'a wrong package hash': [s => { s.package_hash = sha('other'); }, false],
  'a wrong binding hash': [s => { s.binding_hash = sha('other'); }, false],
  'an alert source other than alert_calls': [s => jsonEdit(s, MANIFEST, value => { value.binding.alert_source = 'webhook'; }), true],
  'a market other than BINANCE:BTCUSDT 1': [s => jsonEdit(s, MANIFEST, value => { value.binding.market.symbol = 'ETHUSDT'; }), true]
};
test('parity: the shared C1 checks (content scan, manifest and checksums, numeric format, alert source, market) give the same codes in both modules', () => {
  const baseOne = onePineSubject();
  assert.deepEqual([...ONE.evaluateStructure(baseOne).codes], [], 'the neutral one-Pine package is valid');
  for (const [label, [apply, reseal]] of Object.entries(SHARED_ACTIONS)) {
    const multi = fresh(), one = onePineSubject();
    for (const s of [multi, one]) { apply(s); if (reseal) seal(s); }
    const left = c1(multi).codes.filter(code => SHARED_C1.includes(code)), right = ONE.evaluateStructure(one).codes.filter(code => SHARED_C1.includes(code));
    assert.deepEqual(sorted(left), sorted(right), label);
    if (label !== 'none') assert.ok(left.length > 0, label + ' is refused by both');
    note(left);
  }
});

test('parity: the transition graph is the one-Pine graph, with mode MULTI_PINE leading a pass to EXPORT_INTERNAL', () => {
  assert.equal(G.transition, ONE.transition);
  assert.equal(G.isRetryable, ONE.isRetryable);
  assert.deepEqual([...G.RETRYABLE_CODES], [...ONE.RETRYABLE_CODES]);
  assert.equal(G.CODE_PATTERN, ONE.CODE_PATTERN);
  assert.equal(G.MANIFEST_SCHEMA, ONE.MANIFEST_SCHEMA);
  assert.deepEqual([...G.FRESHNESS_ORDER], [...ONE.FRESHNESS_ORDER]);
  assert.deepEqual([...G.CANDIDATE_BLOCKERS], [...ONE.CANDIDATE_BLOCKERS]);
  assert.deepEqual([...MULTI_RUN_ACCEPTANCE_BLOCKERS], [...ONE.CANDIDATE_BLOCKERS, ONE.MULTI_PINE_BLOCKER]);
  const events = [
    [null, {kind: 'BUILD', b0_pass: true}], [null, {kind: 'BUILD', b0_pass: false}], [null, {kind: 'BUILD'}], ['EXPORT_CANDIDATE', {kind: 'BUILD', b0_pass: true}],
    ...[1, 2, 5, 6, 0].flatMap(attempt_no => [true, false].flatMap(pass => [[], ['BI_PARITY_EVIDENCE_MISSING'], ['BI_SECRET_DETECTED'], ['BI_ATTEMPTS_EXHAUSTED']].flatMap(codes =>
      ['MULTI_PINE', 'ONE_PINE', 'OTHER'].map(mode => ['EXPORT_CANDIDATE', {kind: 'ATTEMPT', pass, codes, mode, attempt_no}])))),
    ['EXPORT_INTERNAL', {kind: 'ATTEMPT', pass: true, codes: [], mode: 'MULTI_PINE', attempt_no: 1}], ['EXPORT_REFUSED', {kind: 'ATTEMPT', pass: true, codes: [], mode: 'MULTI_PINE', attempt_no: 1}]];
  for (const [from, event] of events) assert.deepEqual(G.transition(from, event), ONE.transition(from, event));
  assert.equal(G.transition('EXPORT_CANDIDATE', {kind: 'ATTEMPT', pass: true, codes: [], mode: 'MULTI_PINE', attempt_no: 1}).to, 'EXPORT_INTERNAL');
  assert.equal(G.transition('EXPORT_CANDIDATE', {kind: 'ATTEMPT', pass: true, codes: [], mode: 'ONE_PINE', attempt_no: 1}).to, 'EXPORT_VALIDATED', 'the multi module never takes this edge');
  assert.equal(G.MAX_VALIDATION_ATTEMPTS, ONE.MAX_VALIDATION_ATTEMPTS);
  // the attempt flow never ends in EXPORT_VALIDATED, whatever the subject
  for (const attempt_no of [1, 2, 3, 4, 5]) assert.notEqual(G.evaluateMultiPackage({...fresh(), attempt_no}).status, 'EXPORT_VALIDATED');
});

/** The multi run view as a one-Pine run view, so that the shared B0 checks can be compared. */
function toOnePine(s) {
  const r = s.run, c = r.contract, selected = r.result?.selected ?? null;
  const contract = {version: c.version, snapshot: {membership: c.members.map(m => ({pine_import_id: m.pine_import_id, source_version: m.source_version, source_hash: m.source_hash})), market: clone(MARKET)},
    acceptance_blockers: clone(c.acceptance_blockers), rules: clone(c.rules), dataset: clone(c.dataset), split: clone(c.split), input_lock: {domains: {atr_multiplier: [1, 2], rr: [1, 2]}}};
  const result = {completion_reason: r.result?.completion_reason, holdout_evaluated: r.result?.holdout_evaluated, search_algorithm: 'seeded', seed: 42, budget: 30, candidate_count: 3,
    dimension_coverage_percent: r.result?.search?.dimension_coverage_percent, selected_dimensions: r.result?.search?.selected_dimensions, covered_dimensions: r.result?.search?.covered_dimensions,
    selected: selected === null ? null : {result: {train: selected.train, validation: selected.validation},
      sensitivity: Array.isArray(selected.sensitivity) ? selected.sensitivity.map(item => ({result: {validation: item.validation}})) : undefined,
      cost_stress: selected.cost_stress, test: selected.test, screen_reasons: selected.screen_reasons}};
  if (!r.result?.search || r.result.search.seed === undefined) delete result.seed;
  const run = {owner_id: r.owner_id, run_id: r.run_id, status: r.status, contract, result: r.result === null ? null : result, integrity: {contract_hash_verified: true, report_matches_checkpoints: true},
    created_at_utc: new Date(r.created_at_ms).toISOString()};
  return {owner_id: s.owner_id, run, holdout: s.holdout, binding: {mode: 'MULTI_PINE', fixture: true}, internal: s.internal, current_rules: s.current_rules};
}
const SHARED_B0 = ['STATUS_NOT_COMPLETED', 'NO_RESULT', 'BI_RUN_NOT_QUALIFIABLE', 'NO_SCREENED_CANDIDATE', 'SENSITIVITY_FAILED', 'COST_STRESS_FAILED', 'HOLDOUT_NOT_EVALUATED',
  'INSUFFICIENT_TEST_TRADES', 'NEGATIVE_HOLDOUT_RETURN', 'TEST_DRAWDOWN_EXCEEDED', 'HOLDOUT_WINDOW_REUSED', 'BI_HOLDOUT_OVERLAPS_SEARCHED_DATA', 'BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY',
  'BI_HOLDOUT_EXPOSED_BY_SELECTION', 'BI_EXPOSURE_REGISTER_UNAVAILABLE', 'HOLDOUT_INDEPENDENCE_NOT_CHECKED', 'BI_SEARCH_RECORD_MISSING', 'BI_DIMENSION_COVERAGE', 'BI_CAPABILITY_BLOCKER_PRESENT',
  'BLOCKERS_UNKNOWN', 'BI_MULTI_PINE_INTERNAL_ONLY', 'OWNER_RECOMMENDATION_NOT_READY'];
test('parity: the B0 checks the two modules share (library gates, holdout independence, exposure, RC-11 tolerance) give the same codes on the same facts', () => {
  const exposure = overrides => ({owner_id: 'owner-a', market: clone(MARKET), window: {start_time: at(4500), end_time: at(4600)}, selection_id: 'selection-1', at_utc: '2026-10-01T00:00:00Z', ...overrides});
  const cases = {
    none: () => {},
    'not completed': s => { s.run.status = 'RUNNING'; },
    'no result': s => { s.run.result = null; },
    'not qualifiable': s => { s.run.result.completion_reason = 'CANDIDATE_FAILED_CHECKS'; },
    'no selected candidate': s => { s.run.result.selected = null; },
    'train sample': s => { s.run.result.selected.train.closed_trades = 4; },
    'sensitivity drop': s => { s.run.result.selected.sensitivity[0].validation.net_return_percent = '-5'; },
    'sensitivity sample': s => { s.run.result.selected.sensitivity[1].validation.closed_trades = 1; },
    'stored sensitivity reason': s => { s.run.result.selected.screen_reasons = ['SENSITIVITY_FAILED']; },
    'cost stress': s => { s.run.result.selected.cost_stress.validation.net_return_percent = '-1'; },
    'holdout not evaluated': s => { s.run.result.holdout_evaluated = false; },
    'few test trades': s => { s.run.result.selected.test.closed_trades = 2; },
    'negative holdout': s => { s.run.result.selected.test.net_return_percent = '-1'; },
    'test drawdown': s => { s.run.result.selected.test.max_drawdown_percent = '25'; },
    'earlier holdout': s => { s.holdout.earlier_holdouts = [{start_time: at(4900), end_time: at(5200)}]; },
    'searched data': s => { s.holdout.earlier_searched = [{start_time: at(0), end_time: at(4100)}]; },
    'registered boundary': s => { s.holdout.registered_boundary = {exists: true, start_time: at(4500)}; },
    'lookups unreadable': s => { s.holdout.earlier_searched = 'x'; },
    'exposed': s => { s.holdout.exposure_register.push(exposure({})); },
    'exposed at the creation instant': s => { s.holdout.exposure_register.push(exposure({at_utc: '2026-10-21T11:00:00Z'})); },
    'register entry after the run': s => { s.holdout.exposure_register.push(exposure({at_utc: '2026-10-21T11:00:00.001Z'})); },
    'another owner': s => { s.holdout.exposure_register.push(exposure({owner_id: 'owner-b'})); },
    'another market': s => { s.holdout.exposure_register.push(exposure({market: {broker: 'binance-global', symbol: 'ETHUSDT', timeframe: '1'}})); },
    'register unreadable': s => { s.holdout.exposure_register = {}; },
    'register entry malformed': s => { s.holdout.exposure_register.push({owner_id: 'owner-a'}); },
    'search record': s => { s.run.result.search = {...s.run.result.search, dimension_coverage_percent: 50, covered_dimensions: 1}; },
    'search seed': s => { delete s.run.result.search.seed; },
    'external path': s => { s.internal = false; },
    'external path and not qualifiable': s => { s.internal = false; s.run.result.completion_reason = 'CANDIDATE_FAILED_CHECKS'; },
    'internal flag not a boolean': s => { s.internal = 'true'; },
    'unknown blocker': s => { s.run.contract.acceptance_blockers.push('SOMETHING_ELSE'); rehash(s); },
    'capability blocker': s => { s.run.contract.acceptance_blockers.push('CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'); rehash(s); },
    'blockers unreadable': s => { s.run.contract.acceptance_blockers = 'x'; rehash(s); },
    'another contract version, internal': s => { s.run.contract.version = 'ql3a-research-job-v2'; rehash(s); },
    'a version that derives G7 PASS': s => { s.run.contract.version = 'ql3a-research-job-v3'; rehash(s); }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const s = fresh();
    mutate(s);
    const left = b0(s).codes.filter(code => SHARED_B0.includes(code)), right = ONE.evaluateBuildEligibility(toOnePine(s)).codes.filter(code => SHARED_B0.includes(code));
    assert.deepEqual(sorted(left), sorted(right), label);
    note(left);
  }
});

/** The one-Pine view of the multi C4 facts for member 1: one evidence record per kind and the clearances of ordinal 1. Only the blocker rule of RC-11 is compared. */
function toOnePineC4(s) {
  const run = toOnePine(s).run;
  run.result = {selected: {parameters: clone(s.run.result.selected.parameters)}};
  const entry = s.evidence?.members?.[0] ?? {};
  const mode = (() => { try { return JSON.parse(s.files[MANIFEST]).binding.mode; } catch { return undefined; } })();
  return {run, export_id: s.export_id, internal: s.internal, evidence: {native_parity: entry.native_parity, repaint: entry.repaint}, current: {}, bridge_bounds: {},
    clearances: list1(s.clearances).filter(item => item.ordinal === 1).map(({ordinal, ...rest}) => rest), files: {[MANIFEST]: jsonText({binding: {mode}})}};
}
const list1 = value => Array.isArray(value) ? value : [];
test('parity: the C4 blocker rule (RC-11 tolerance on the internal path only, cleared candidate blockers, unknown blockers) gives the same answer in both modules', () => {
  const RULE = ['ACCEPTANCE_BLOCKERS_PRESENT', 'BLOCKERS_UNKNOWN'];
  const cases = {
    none: () => {},
    'external path': s => { s.internal = false; },
    'internal flag not a boolean': s => { s.internal = 'true'; },
    'internal flag absent': s => { s.internal = undefined; },
    'no clearances': s => { s.clearances = []; },
    'no clearances, external': s => { s.clearances = []; s.internal = false; },
    'only the parity blocker is cleared': s => { s.clearances = s.clearances.filter(item => item.blocker === 'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED'); },
    'candidate blockers only, no marker, external': s => { s.run.contract.acceptance_blockers = ['VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED', 'CUSTOM_REPAINT_EVIDENCE_REQUIRED']; rehash(s); s.internal = false; },
    'marker only, no clearances': s => { s.run.contract.acceptance_blockers = ['MULTI_PINE_REQUIRES_APP_3B']; s.clearances = []; rehash(s); },
    'marker only, no clearances, external': s => { s.run.contract.acceptance_blockers = ['MULTI_PINE_REQUIRES_APP_3B']; s.clearances = []; s.internal = false; rehash(s); },
    'unknown blocker': s => { s.run.contract.acceptance_blockers.push('SOMETHING_ELSE'); rehash(s); },
    'capability blocker': s => { s.run.contract.acceptance_blockers.push('CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED'); rehash(s); },
    'blockers unreadable': s => { s.run.contract.acceptance_blockers = null; rehash(s); },
    'another contract version, internal': s => { s.run.contract.version = 'ql3a-research-job-v2'; rehash(s); },
    'claimed mode ONE_PINE': s => { bindingEdit(s, binding => { binding.mode = 'ONE_PINE'; }); },
    'clearance of another export': s => { s.clearances[0].export_id = 'other-export'; s.clearances[2].export_id = 'other-export'; },
    'clearance for another pair': s => { s.clearances[0].parameter_hash = sha('other'); },
    'clearance with other evidence': s => { s.clearances[2].evidence_hash = sha('other'); },
    'clearance of another run': s => { s.clearances[0].run_id = 'other-run'; }
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const s = fresh();
    mutate(s);
    const left = c4(s).codes.filter(code => RULE.includes(code)), right = ONE.evaluateValidation(toOnePineC4(s)).codes.filter(code => RULE.includes(code));
    assert.deepEqual(sorted(left), sorted(right), label);
    note(left);
  }
  // sanity: the matrix contains both outcomes
  const open = fresh();
  open.internal = false;
  assert.deepEqual(c4(open).codes.filter(code => RULE.includes(code)), ['ACCEPTANCE_BLOCKERS_PRESENT']);
  assert.deepEqual(c4(fresh()).codes.filter(code => RULE.includes(code)), []);
});

test('parity: the helpers the two modules share are the same functions (imported, not copied)', () => {
  assert.equal(G.notReached, ONE.notReached);
  assert.deepEqual(G.holdoutWindow({dataset: {start_time: at(0)}, split: {validation_end: 4100, test_end: 5000}}), HOLDOUT_WINDOW);
  assert.deepEqual(G.searchedWindow({dataset: {start_time: at(0)}, split: {validation_end: 4100}}), {start_time: at(0), end_time: at(4099)});
  assert.equal(G.windowsOverlap(HOLDOUT_WINDOW, {start_time: at(4999), end_time: at(5100)}), true);
  assert.equal(G.windowsOverlap(HOLDOUT_WINDOW, {start_time: at(5000), end_time: at(5100)}), false);
  assert.equal(G.windowsOverlap(null, HOLDOUT_WINDOW), false);
  assert.equal(G.RECOMMENDATION_COMPLETION_REASON, ONE.RECOMMENDATION_COMPLETION_REASON);
  assert.equal(G.MULTI_PINE_CONTRACT_VERSION, 'ql3a-research-job-multi-v1');
  assert.equal(G.MULTI_PINE_BLOCKER, 'MULTI_PINE_REQUIRES_APP_3B');
});

/* ---- static properties ---- */

test('the new module is not in MP_COMBINED_ONLY_FILES, not in the engine closure, and not in the producer closure', async () => {
  const name = 'src/multi-pine/package-gates.js';
  assert.equal(MP_COMBINED_ONLY_FILES.includes(name), false);
  assert.equal(MP_COMBINED_ENGINE_FILES.includes(name), false);
  assert.ok(MP_COMBINED_ONLY_FILES.length > 0);
  const closure = await import('../src/multi-pine/package-closure.js');
  assert.equal(closure.MP_PACKAGE_TRACE_FILES.includes(name), false);
  // nothing in the engine closure imports the gate module (it would then have to be listed)
  for (const file of MP_COMBINED_ENGINE_FILES.filter(item => item.startsWith('src/multi-pine/'))) {
    assert.doesNotMatch(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /['"](?:\.\/|\.\.\/multi-pine\/)package-gates\.js['"]/, file);
  }
});

test('the module imports only the exported helpers of RD-MP-38 and the R6-1 modules, and reads no file, clock, random source or process state', () => {
  const source = fs.readFileSync(new URL('../src/multi-pine/package-gates.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gms)].map(item => [item[2], item[1].split(',').map(name => name.trim()).filter(Boolean)]);
  const ALLOWED_ONE = ['transition', 'RETRYABLE_CODES', 'isRetryable', 'evaluateQualification', 'notReached', 'CODE_PATTERN', 'MANIFEST_SCHEMA', 'buildManifest', 'fileEntries', 'packageHash',
    'bindingHash', 'scanContent', 'ownerRecommendationGate', 'RECOMMENDATION_COMPLETION_REASON', 'CANDIDATE_BLOCKERS', 'MULTI_PINE_CONTRACT_VERSION', 'MULTI_PINE_BLOCKER',
    'SUPPORTED_EXIT_VERSIONS', 'TRACE_FILES', 'FRESHNESS_ORDER', 'isReady', 'holdoutWindow', 'searchedWindow', 'windowsOverlap'];
  const modules = Object.fromEntries(imports.map(([from, names]) => [from, names]));
  assert.deepEqual(Object.keys(modules).sort(), ['../pine-bridge/source.js', '../pine-bridge/template.js', '../quant-library/derive.js', '../quant-library/package-gates.js', './codes.js',
    './package-render.js', './package-trace.js']);
  for (const name of [...modules['../quant-library/package-gates.js'], ...modules['../quant-library/derive.js']]) assert.ok(ALLOWED_ONE.includes(name), name);
  // the one-Pine helpers that read one-Pine shapes are not imported
  for (const name of ['evaluateBuildEligibility', 'evaluateStructure', 'evaluateCompile', 'evaluateProvenance', 'evaluateValidation', 'evaluatePackage', 'freshnessCodes', 'freshness', 'readState',
    'effectiveInputHash', 'selectedOf', 'selectedReasons', 'marketKey', 'isCompleted', 'libraryG8', 'qualifiedFromRecords']) {
    assert.ok(!Object.values(modules).some(names => names.includes(name)), name);
  }
  assert.doesNotMatch(source, /\b(?:Date\.now|new Date|Math\.random|process\.|require\(|import\(|fetch\(|readFile|writeFile|setTimeout|crypto\.)/);
  assert.doesNotMatch(source, /mp_research_run|mp-run-store|executor\.js|python-runner|combined-oracle|\bpg\b/i);
  // the helper module the gates are built from stays as it was: no multi-Pine edit in the one-Pine files
  const one = fs.readFileSync(new URL('../src/quant-library/package-gates.js', import.meta.url), 'utf8');
  assert.doesNotMatch(one, /multi-pine\/package-gates/);
});

test('every code the suite saw matches the code pattern, and the module emits no code the contract and the one-Pine module do not know', () => {
  assert.ok(SEEN.size > 60, 'the suite exercised ' + SEEN.size + ' codes');
  for (const code of SEEN) assert.match(code, ONE.CODE_PATTERN, code);
  // every MP_ code that appeared is in the contract list (section 8.2); the module adds no local code
  for (const code of SEEN) if (code.startsWith('MP_')) assert.ok(['MP_MARKET_MIXED', 'MP_EXIT_VERSION_MIXED', 'MP_SOURCE_SLOTS_FORBIDDEN', 'MP_MEMBER_PARITY_SCOPE_MISMATCH', 'MP_COMBINED_BASELINE_FAILED', 'MP_MEMBER_SET_STALE', 'MP_BRIDGE_PAIR_DIVERGENT'].includes(code), code);
  assert.equal(MP_TRACE_METHOD, 'stored-holdout-decisions-v1');
});

test('one negation per code: every code literal of the module was produced by a test above', () => {
  const source = fs.readFileSync(new URL('../src/multi-pine/package-gates.js', import.meta.url), 'utf8');
  const literals = [...new Set([...source.matchAll(/'([A-Z][A-Z0-9_]{2,63})'/g)].map(item => item[1]))];
  // words that are statuses, gate states, modes or a refusal reason of the call, not codes of a gate result
  const NOT_CODES = new Set(['SUCCEEDED', 'NO_VALID_CANDIDATE', 'EXPORT_CANDIDATE', 'EXPORT_INTERNAL', 'EXPORT_REFUSED', 'MULTI_PINE', 'INPUT_INVALID', 'SPOT', 'ATTEMPT', 'FAIL', 'PASS', 'FRESH', 'STALE',
    'NOT_REACHED', 'BI_REPLAY_STATE_UNAVAILABLE']);
  const unseen = literals.filter(code => !NOT_CODES.has(code) && !SEEN.has(code));
  assert.deepEqual(unseen, []);
  // the codes written as MP_CODES members
  for (const code of [...source.matchAll(/MP_CODES\.([A-Z_]+)/g)].map(item => MP_CODES[item[1]])) assert.ok(SEEN.has(code), code);
  // a refusal reason is not a gate code, and neither is a status word
  for (const word of NOT_CODES) assert.equal(SEEN.has(word) && !['NO_VALID_CANDIDATE'].includes(word) && !word.startsWith('BI_'), false, word);
});
