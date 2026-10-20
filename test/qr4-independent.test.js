import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/selection/index.js';

/*
 * Independent acceptance tests for the QR-4 S1 pure module. Written from docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md
 * section 16.1 (items 1 to 20 and 17a) and section 17.3 (RC-S1 to RC-S17). Public API only (src/selection/index.js).
 * Expectations are hand derived from the contract text.
 */
const {buildRegistration,rankSelection,replayOutcome,evaluateEligibility,recheckWindow,transitionSelection,OBJECTIVE_REGISTRY,CODE_LIST,canonical,hash} = S;

const MIN = 60000;
const R = 28333400 * MIN; // registration time, minute aligned
const OWNER = 'owner-1';
const hex = c => c.repeat(64);
const POLICY_HASH = hex('e');
const ENGINE = hex('1');
const DS = hex('2');
const MARKET_KEY = canonical(S.REQUIRED_MARKET);
const seenCodes = new Set();
const note = r => {
  if (r && typeof r === 'object') {
    if (typeof r.code === 'string') seenCodes.add(r.code);
    if (Array.isArray(r.codes)) r.codes.forEach(c => seenCodes.add(c));
    if (Array.isArray(r.problems)) r.problems.forEach(p => seenCodes.add(p.code));
  }
  return r;
};

/* ---------- fixtures ---------- */
const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'].map(g => ({gate: g, state: 'PASS', code: null}));
const RULES = {maximum_drawdown_percent: '20'};
const rulesHash = rules => hash(canonical(rules));
const SCOPE_BITS = () => ({
  data_model: {data_profile: 'p1', price_tick: '0.01', quantity_step: '0.00001'},
  cost_model: {version: 'paper-close-v1', fee_bps: '10', slippage_bps: '5'},
  capital: {equity: '10000', cash: '10000'},
  policy: {policy_version: 'pol-1', policy_hash: POLICY_HASH}});

function mkMember(i, patch) {
  const id = String(i), c = '0123456789abcdef'[i % 16];
  const exportId = 'exp-' + id, pkgHash = hex(c), memberOf = [{pine_import_id: 'pi-' + id, source_version: 1, source_hash: hex('c')}];
  const m = {
    kind: 'RESEARCH_RUN', owner_id: OWNER, run_id: 'run-' + id, export_id: exportId, created_at_ms: R - 1000 * MIN + i * MIN,
    run_status: 'SUCCEEDED', source_hash: hex(c) , market: {...S.REQUIRED_MARKET}, library_class: 'QUALIFIED',
    qualification: {version: 'library-qualification-v2', label: 'QUALIFIED', qualified: true, gates: GATES.map(g => ({...g}))},
    integrity_checked: true,
    package: {export_id: exportId, package_hash: pkgHash, status: 'EXPORT_VALIDATED',
      binding: {mode: 'ONE_PINE', fixture: false, membership: memberOf, pine_import_id: 'pi-' + id, source_version: 1, source_hash: hex('c'),
        policy_version: 'pol-1', policy_hash: POLICY_HASH, deployment_id: 'dep-' + id, input_lock_hash: hex('d')},
      current: {membership: memberOf, policy_version: 'pol-1', policy_hash: POLICY_HASH, deployment_id: 'dep-' + id, input_lock_hash: hex('d'),
        dataset_available: true, bot_owner_id: OWNER},
      replay_mismatch: false},
    validation_records: [{run_id: 'run-' + id, mode: 'ONE_PINE', record: {fixture: false, export_id: exportId, package_hash: pkgHash, binding_hash: hex('b'),
      gate_results: ['C1', 'C2', 'C3', 'C4'].map(g => ({gate: g, state: 'PASS', codes: []})), validated_at_utc: '2026-10-01T00:00:00.000Z'}}],
    scope: SCOPE_BITS(), rules, rules_hash: rulesHash(rules),
    data_windows: {dataset: {start_ms: R - 5000 * MIN, end_ms: R - 1000 * MIN}, train: {start_ms: R - 5000 * MIN, end_ms: R - 3000 * MIN},
      validation: {start_ms: R - 3000 * MIN, end_ms: R - 2000 * MIN}, holdout: {start_ms: R - 2000 * MIN, end_ms: R - 1000 * MIN}},
    registered_boundary_ms: null};
  if (patch) patch(m);
  return m;
}
const rules = RULES;
const W = () => ({kind: 'PROSPECTIVE', start_ms: R + 100 * MIN, end_ms: R + 300 * MIN, warmup_bars: 50});
const registryWith = (r = '0.5', d = '0.5') => {
  const reg = structuredClone(OBJECTIVE_REGISTRY);
  reg['qr4-objective-lexi-v1'].tie_tolerances = {return_pp: r, drawdown_pp: d, unit: 'PERCENTAGE_POINTS'};
  return reg;
};
const mkRequest = (members, patch) => {
  const q = {owner_id: OWNER, selection_id: 'sel-1', registered_at_ms: R, confirmed: true, fixture: false, ranking_basis: 'QR4_SELECTION_EVAL',
    scope: {market: {...S.REQUIRED_MARKET}, ...SCOPE_BITS(), valuation: {valuation: 'qr3-valuation-std-v1', benchmark: 'qr3-bh-close-same-cost-v1'}, engine: ENGINE},
    window: W(), objective: {id: 'qr4-objective-lexi-v1'}, filters: {drawdown_limit_percent: '15', episode_floor: 5, beats_buy_and_hold: false},
    admission_deadline_ms: R + 2000 * MIN, universe: members};
  if (patch) patch(q);
  return q;
};
const mkCtx = patch => {
  const c = {requester_owner_id: OWNER, policy_snapshot: {policy_hash: POLICY_HASH, max_drawdown_percent: '20'}, objective_registry: registryWith(),
    universe_cap: 50, dependencies: {qr3_context: true, evaluation_mode: true, episode_gate_version: 'v1'}, exposure_register: [], searched_windows: [],
    prior_selection_ids: [], existing_registrations: []};
  if (patch) patch(c);
  return c;
};
const build = (members, qp, cp) => note(buildRegistration(mkRequest(members, qp), mkCtx(cp)));
const goodMembers = (n = 3, patch) => Array.from({length: n}, (_, k) => mkMember(k + 1, patch ? m => patch(m, k + 1) : undefined));
function baseReg(n = 3, qp, cp, mp) {
  const r = build(goodMembers(n, mp), qp, cp);
  assert.equal(r.ok, true, 'base registration must build: ' + JSON.stringify(r).slice(0, 300));
  return r.registration;
}
const regWith = (tolR, tolD, n = 3, qp) => {
  const r = build(goodMembers(n), qp, c => { c.objective_registry = registryWith(tolR, tolD); });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return r.registration;
};

function mkEval(reg, i, spec = {}) {
  const result = {
    metrics: {net_return_percent: spec.ret ?? '5', max_drawdown_percent: spec.dd ?? '5', closed_trades: spec.trades ?? 12, profit_factor: '1.5', gross_profit: '100', gross_loss: '50'},
    fees: '1', slippage: '1', exposure_percent: '30', episodes: spec.ep ?? 10, rejected_intents: 0, evaluation_bars: reg.window.evaluation_bars,
    cost_stress: {net_return_percent: spec.cs ?? '0.5'}, benchmark: {net_return_percent: spec.bm ?? '1'}};
  return {mode: 'QR4_SELECTION_EVAL', selection_id: reg.selection_id, run_id: 'ev-' + i, parent_run_id: 'run-' + i, status: 'SUCCEEDED',
    integrity: {contract_hash_verified: true, report_matches_checkpoints: true}, result, result_hash: hash(canonical(result)), engine_hash: reg.scope.engine, dataset_hash: DS};
}
const rehash = ev => { ev.result_hash = hash(canonical(ev.result)); return ev; };
const mutateResult = (ev, fn) => { const e = structuredClone(ev); fn(e.result); return rehash(e); };
const evals = (reg, specs) => specs.map((s, k) => mkEval(reg, k + 1, s));
const rank = (reg, ev, opts = {window_dataset_hash: DS}) => note(rankSelection(reg, ev, opts));
const ranksOf = o => Object.fromEntries(o.ranking.map(x => [x.export_id, x.rank]));

/* ---------- 1 golden fixture ---------- */
test('16.1-1 golden: 3 distinct returns give BEST_IN_SCOPE with ranks 1,2,3 and a covering outcome_hash', () => {
  const reg = regWith('0.5', '0.5');
  const o = rank(reg, evals(reg, [{ret: '4.0'}, {ret: '12.5'}, {ret: '9.0'}]));
  assert.equal(o.status, 'SELECTION_COMPLETED');
  assert.equal(o.outcome, 'BEST_IN_SCOPE');
  assert.deepEqual(ranksOf(o), {'exp-2': 1, 'exp-3': 2, 'exp-1': 3});
  assert.deepEqual(o.ranking.map(x => x.rank), [1, 2, 3]);
  assert.match(o.outcome_hash, /^[a-f0-9]{64}$/);
  const {outcome_hash, ...body} = o;
  assert.equal(outcome_hash, hash(canonical(body)), 'outcome_hash must cover the whole body');
  assert.equal(o.window_dataset_hash, DS, 'RC-S8 body holds window_dataset_hash');
  assert.equal(o.registration_hash, reg.registration_hash);
  assert.equal(o.no_significance_sentence, 'No statistical significance is claimed.');
  assert.equal(o.label.label_text, 'Best of 3 compared strategies within the selected scope');
  assert.deepEqual(o.label.participants, ['exp-2']);
  assert.equal(rank(reg, evals(reg, [{ret: '4.0'}, {ret: '12.5'}, {ret: '9.0'}])).outcome_hash, o.outcome_hash, 'deterministic');
  assert.ok(Object.isFrozen(o));
  // section 7.1 item 8: output lists evaluation run ids and result hashes, tolerances and ruleset ids
  assert.deepEqual(o.tolerances, {return_pp: '0.5', drawdown_pp: '0.5'});
  const e1 = o.evaluations.find(x => x.export_id === 'exp-1');
  assert.equal(e1.evaluation_run_id, 'ev-1');
  assert.equal(e1.result_hash, mkEval(reg, 1, {ret: '4.0'}).result_hash);
  assert.equal(o.rulesets.objective, 'qr4-objective-lexi-v1');
});

/* ---------- 2 and 3 ties and boundary ---------- */
test('16.1-2 primary tie separated by drawdown gives BEST_IN_SCOPE; equal on both keys gives TIED_IN_SCOPE with full set', () => {
  const reg = regWith('0.5', '0.5', 3);
  // 10.0 and 9.8 tie on primary (gap 0.2). drawdown 3 vs 4: gap 1 > 0.5 so the lower drawdown wins.
  const a = rank(reg, evals(reg, [{ret: '10.0', dd: '4'}, {ret: '9.8', dd: '3'}, {ret: '2'}]));
  assert.equal(a.outcome, 'BEST_IN_SCOPE');
  assert.equal(ranksOf(a)['exp-2'], 1);
  assert.equal(a.ranking.find(x => x.export_id === 'exp-2').decided_by, 'SECONDARY');
  const b = rank(reg, evals(reg, [{ret: '10.0', dd: '4'}, {ret: '10.0', dd: '4'}, {ret: '2'}]));
  assert.equal(b.outcome, 'TIED_IN_SCOPE');
  assert.deepEqual(b.ranking.filter(x => x.rank === 1).map(x => x.export_id).sort(), ['exp-1', 'exp-2']);
  assert.equal(b.label.label_text, 'Tied for best of 3 compared strategies within the selected scope');
  assert.deepEqual([...b.label.participants].sort(), ['exp-1', 'exp-2']);
  // drawdown gap exactly equal to the secondary tolerance is still a tie
  const c = rank(reg, evals(reg, [{ret: '10.0', dd: '4.5'}, {ret: '9.9', dd: '4'}, {ret: '2'}]));
  assert.equal(c.outcome, 'TIED_IN_SCOPE');
});

test('16.1-3 boundary: gap equal to tolerance is a tie, one decimal unit above is not', () => {
  const reg = regWith('0.5', '0.5', 2);
  const eq = rank(reg, evals(reg, [{ret: '10.5', dd: '5'}, {ret: '10.0', dd: '5'}]));
  assert.equal(eq.outcome, 'TIED_IN_SCOPE');
  const above = rank(reg, evals(reg, [{ret: '10.501', dd: '5'}, {ret: '10.0', dd: '5'}]));
  assert.equal(above.outcome, 'BEST_IN_SCOPE');
  assert.equal(ranksOf(above)['exp-1'], 1);
  assert.equal(ranksOf(above)['exp-2'], 2);
  // also the drawdown boundary inside a primary tie
  const ddEq = rank(reg, evals(reg, [{ret: '10', dd: '3.5'}, {ret: '10', dd: '3'}]));
  assert.equal(ddEq.outcome, 'TIED_IN_SCOPE');
  const ddAbove = rank(reg, evals(reg, [{ret: '10', dd: '3.501'}, {ret: '10', dd: '3'}]));
  assert.equal(ddAbove.outcome, 'BEST_IN_SCOPE');
  assert.equal(ranksOf(ddAbove)['exp-2'], 1);
});

test('16.1-4 exact decimals: 0.4 vs 0.3 inside tolerance 0.1 ties (binary float gap is 0.10000000000000003); 1.10 equals 1.1', () => {
  const reg = regWith('0.1', '0.1', 2);
  const o = rank(reg, evals(reg, [{ret: '0.4', dd: '1'}, {ret: '0.3', dd: '1'}]));
  assert.equal(o.outcome, 'TIED_IN_SCOPE', 'float implementation would see gap > 0.1');
  const o2 = rank(reg, evals(reg, [{ret: '0.3', dd: '1'}, {ret: '0.2', dd: '1'}]));
  assert.equal(o2.outcome, 'TIED_IN_SCOPE');
  const zero = regWith('0', '0', 2);
  const eq = rank(zero, evals(zero, [{ret: '1.10', dd: '2.0'}, {ret: '1.1', dd: '2'}]));
  assert.equal(eq.outcome, 'TIED_IN_SCOPE', '"1.10" equals "1.1" and "2.0" equals "2" at zero tolerance');
  const near = rank(zero, evals(zero, [{ret: '0.3', dd: '2'}, {ret: '0.2', dd: '2'}]));
  assert.equal(near.outcome, 'BEST_IN_SCOPE');
  // 0.1 + 0.2 style: value "0.30000000000000004" is above "0.3" at zero tolerance
  const tiny = rank(zero, evals(zero, [{ret: '0.30000000000000004', dd: '2'}, {ret: '0.3', dd: '2'}]));
  assert.equal(tiny.outcome, 'BEST_IN_SCOPE');
  // filter boundaries are exact too: drawdown 15.00 equals limit 15
  const fl = regWith('0.5', '0.5', 2);
  const ok = rank(fl, evals(fl, [{ret: '3', dd: '15.00'}, {ret: '2', dd: '1'}]));
  assert.deepEqual(ok.not_passed, []);
});

/* ---------- 5, 6, 7 filters and outcomes ---------- */
test('16.1-5 all fail a strategy filter: NO_QUALIFYING_STRATEGY, no label, no rank', () => {
  const reg = regWith('0.5', '0.5', 3);
  const o = rank(reg, evals(reg, [{ret: '-1', cs: '-2'}, {ret: '0'}, {dd: '15.01', ret: '3'}]));
  assert.equal(o.status, 'SELECTION_COMPLETED');
  assert.equal(o.outcome, 'NO_QUALIFYING_STRATEGY');
  assert.deepEqual(o.ranking, []);
  assert.equal(o.label, null);
  assert.equal(o.text, 'No qualifying strategy within the selected scope.');
  assert.equal(o.no_significance_sentence, null, 'empty ranking carries no sentence (RC-S10)');
  assert.equal(o.not_passed.length, 3);
  assert.ok(o.not_passed.every(x => x.result === 'NOT_QUALIFYING_IN_SCOPE'));
});

test('16.1-6 only F2 failing everywhere gives INADEQUATE_EVIDENCE; F2-only mixed with another failure gives NO_QUALIFYING_STRATEGY', () => {
  const reg = regWith('0.5', '0.5', 3);
  const o = rank(reg, evals(reg, [{ep: 4}, {ep: 0}, {ep: 2, ret: '50'}]));
  assert.equal(o.outcome, 'INADEQUATE_EVIDENCE');
  assert.equal(o.label, null);
  assert.deepEqual(o.ranking, []);
  assert.equal(o.text, 'Evidence is not adequate to rank within the selected scope.');
  assert.ok(o.not_passed.every(x => x.result === 'EVIDENCE_INADEQUATE' && x.filter_codes.length === 1 && x.filter_codes[0] === 'FILTER_EPISODE_FLOOR'));
  const mix = rank(reg, evals(reg, [{ep: 4}, {ep: 10, ret: '-1', cs: '-1'}, {ep: 4}]));
  assert.equal(mix.outcome, 'NO_QUALIFYING_STRATEGY');
  const mix2 = rank(reg, evals(reg, [{ep: 4}, {ep: 4, dd: '16'}, {ep: 4}]));
  assert.equal(mix2.outcome, 'NO_QUALIFYING_STRATEGY', 'F2 plus F1 failure is not F2-only');
});

test('16.1-7 each filter negation gives exactly its filter code; two failures list both; boundary values pass', () => {
  const reg = regWith('0.5', '0.5', 2);
  const failing = spec => rank(reg, [mkEval(reg, 1, spec), mkEval(reg, 2, {ret: '3'})]).not_passed.find(x => x.export_id === 'exp-1');
  assert.deepEqual(failing({dd: '15.01'}).filter_codes, ['FILTER_DRAWDOWN_LIMIT']);
  assert.deepEqual(failing({ep: 4}).filter_codes, ['FILTER_EPISODE_FLOOR']);
  assert.deepEqual(failing({cs: '-0.01'}).filter_codes, ['FILTER_COST_STRESS']);
  assert.deepEqual(failing({ret: '0', cs: '0'}).filter_codes, ['FILTER_NET_RETURN_POSITIVE'], 'net return 0 is not greater than 0');
  assert.deepEqual([...failing({dd: '16', ep: 1}).filter_codes].sort(), ['FILTER_DRAWDOWN_LIMIT', 'FILTER_EPISODE_FLOOR']);
  assert.deepEqual([...failing({ret: '-1', cs: '-2'}).filter_codes].sort(), ['FILTER_COST_STRESS', 'FILTER_NET_RETURN_POSITIVE']);
  // boundaries pass: dd == limit, episodes == 5, cost stress == 0
  const edge = rank(reg, [mkEval(reg, 1, {dd: '15', ep: 5, cs: '0', ret: '1'}), mkEval(reg, 2, {ret: '3'})]);
  assert.equal(edge.not_passed.length, 0);
  // F5 optional: off by default, on only when registered
  const off = rank(reg, [mkEval(reg, 1, {ret: '2', bm: '9'}), mkEval(reg, 2, {ret: '3', bm: '1'})]);
  assert.equal(off.not_passed.length, 0);
  const on = regWith('0.5', '0.5', 2, q => { q.filters.beats_buy_and_hold = true; });
  const o5 = rank(on, [mkEval(on, 1, {ret: '2', bm: '2'}), mkEval(on, 2, {ret: '3', bm: '1'})]);
  assert.deepEqual(o5.not_passed.map(x => [x.export_id, x.filter_codes]), [['exp-1', ['FILTER_BEATS_BUY_AND_HOLD']]]);
  assert.equal(o5.outcome, 'BEST_IN_SCOPE');
  assert.equal(o5.passed_note, '1 of 2 participants passed the filters', 'BEST_IN_SCOPE with one passer states 1 of N');
  assert.equal(o5.label.label_text, 'Best of 2 compared strategies within the selected scope');
});

/* ---------- 8 permutation ---------- */
function prng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
const shuffled = (arr, rnd) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const shuffleKeys = (v, rnd) => Array.isArray(v) ? v.map(x => shuffleKeys(x, rnd)) : v && typeof v === 'object'
  ? Object.fromEntries(shuffled(Object.entries(v), rnd).map(([k, x]) => [k, shuffleKeys(x, rnd)])) : v;

test('16.1-8 permutation invariance over 100 shuffles of participant order and object key order', () => {
  const reg = regWith('0.5', '0.5', 4);
  const ev = evals(reg, [{ret: '10', dd: '5'}, {ret: '9.8', dd: '4.8'}, {ret: '9.5', dd: '4'}, {ret: '9', dd: '5'}]);
  const base = rank(reg, ev);
  assert.equal(base.status, 'SELECTION_COMPLETED');
  const rnd = prng(12345);
  for (let n = 0; n < 100; n++) {
    const r2 = shuffleKeys({...reg, participants: shuffled(reg.participants, rnd)}, rnd);
    const e2 = shuffleKeys(shuffled(ev, rnd), rnd);
    const o = rank(r2, e2);
    assert.equal(o.status, 'SELECTION_COMPLETED', 'permutation ' + n + ' ' + JSON.stringify(o.problems));
    assert.equal(o.outcome_hash, base.outcome_hash, 'permutation ' + n);
  }
});

/* RC-S13 */
test('RC-S13 dense anchored ranks do not depend on input order', () => {
  const reg = regWith('0.5', '0.5', 4);
  const ev = evals(reg, [{ret: '10.0', dd: '5'}, {ret: '9.8', dd: '4.8'}, {ret: '9.5', dd: '4'}, {ret: '9.0', dd: '1'}]);
  // round 1 anchor 10.0: primary group {1 (0), 2 (0.2), 3 (0.5 inclusive)}; exp-4 gap 1.0 out. low drawdown 4 -> only exp-3 (1.0 and 0.8 above) => BEST exp-3.
  // round 2 remaining 1,2,4: anchor 10.0 group {1,2}; drawdown 5 vs 4.8 within 0.5 => tie rank 2. round 3 exp-4.
  const rnd = prng(7);
  for (let n = 0; n < 24; n++) {
    const o = rank(reg, shuffled(ev, rnd));
    assert.deepEqual(ranksOf(o), {'exp-3': 1, 'exp-1': 2, 'exp-2': 2, 'exp-4': 3});
    assert.equal(o.outcome, 'BEST_IN_SCOPE');
  }
  // chain case: 10, 9.6, 9.2 tolerance 0.5 equal drawdown. anchored on 10: group {10,9.6}; 9.2 is 0.8 away so rank 2 (not chained into the tie).
  const reg3 = regWith('0.5', '0.5', 3);
  const c = rank(reg3, evals(reg3, [{ret: '9.2'}, {ret: '10'}, {ret: '9.6'}]));
  assert.equal(c.outcome, 'TIED_IN_SCOPE');
  assert.deepEqual(ranksOf(c), {'exp-2': 1, 'exp-3': 1, 'exp-1': 2});
});

/* ---------- 9 and 10 ---------- */
test('16.1-9 a participant that fails a filter never changes ranks or outcome of the others', () => {
  const reg3 = regWith('0.5', '0.5', 3), reg2 = regWith('0.5', '0.5', 2);
  const pass = [{ret: '8', dd: '4'}, {ret: '6', dd: '3'}];
  const base = rank(reg2, evals(reg2, pass));
  for (const bad of [{ret: '99', ep: 1}, {ret: '99', dd: '40'}, {ret: '-5', cs: '-5'}, {ret: '99', cs: '-1'}, {ret: '8', dd: '16', ep: 0}]) {
    const o = rank(reg3, evals(reg3, [...pass, bad]));
    assert.deepEqual(o.ranking.map(x => [x.export_id, x.rank]), base.ranking.map(x => [x.export_id, x.rank]));
    assert.equal(o.outcome, base.outcome);
    assert.equal(o.not_passed.length, 1);
  }
});

test('16.1-10 no third tiebreak: equal on both keys stays tied whatever run id, creation time or parameters', () => {
  const reg = build([mkMember(1, m => { m.created_at_ms = R - 900 * MIN; }), mkMember(2, m => { m.created_at_ms = R - 100 * MIN; m.run_id = 'run-2'; })], null, c => { c.objective_registry = registryWith(); });
  assert.equal(reg.ok, true);
  const r = reg.registration;
  const o = rank(r, [mkEval(r, 1, {ret: '7', dd: '3'}), mkEval(r, 2, {ret: '7', dd: '3'})]);
  assert.equal(o.outcome, 'TIED_IN_SCOPE');
  assert.deepEqual(o.ranking.map(x => x.rank), [1, 1]);
  // swap evaluations' run ids: still tied
  const e1 = mkEval(r, 1, {ret: '7', dd: '3'}); e1.run_id = 'zzz'; const e2 = mkEval(r, 2, {ret: '7', dd: '3'}); e2.run_id = 'aaa';
  assert.equal(rank(r, [e1, e2]).outcome, 'TIED_IN_SCOPE');
});

/* ---------- 11 incomplete ---------- */
test('16.1-11 data gaps give SELECTION_INCOMPLETE with the section 10 code, never a partial ranking, never a throw', () => {
  const reg = regWith('0.5', '0.5', 3);
  const good = evals(reg, [{ret: '5'}, {ret: '6'}, {ret: '7'}]);
  const check = (ev, code, opts) => {
    const o = rank(reg, ev, opts);
    assert.equal(o.status, 'SELECTION_INCOMPLETE', code);
    assert.equal(o.outcome, null);
    assert.equal(o.ranking, null);
    assert.equal(o.label, null);
    assert.equal(o.code, code);
    return o;
  };
  check(good.slice(0, 2), 'QR4_EVALUATION_FAILED');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { delete r.metrics.max_drawdown_percent; }) : e), 'QR4_METRIC_MISSING');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { r.metrics.net_return_percent = null; }) : e), 'QR4_METRIC_MISSING');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { r.metrics.net_return_percent = 5; }) : e), 'QR4_METRIC_MISSING');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { delete r.cost_stress; }) : e), 'QR4_METRIC_MISSING');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { r.episodes = '10'; }) : e), 'QR4_METRIC_MISSING');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { delete r.benchmark; }) : e), 'QR4_BENCHMARK_UNAVAILABLE');
  check(good.map((e, k) => k === 0 ? {...e, status: 'FAILED'} : e), 'QR4_EVALUATION_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, status: 'TIMED_OUT'} : e), 'QR4_EVALUATION_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, status: 'CANCELLED'} : e), 'QR4_EVALUATION_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, integrity: {contract_hash_verified: false, report_matches_checkpoints: true}} : e), 'INTEGRITY_CHECK_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, integrity: {contract_hash_verified: true, report_matches_checkpoints: false}} : e), 'INTEGRITY_CHECK_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, integrity: null} : e), 'INTEGRITY_CHECK_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, result_hash: hex('9')} : e), 'INTEGRITY_CHECK_FAILED');
  check(good.map((e, k) => k === 0 ? {...e, engine_hash: hex('8')} : e), 'QR4_ENGINE_MISMATCH');
  check(good.map((e, k) => k === 0 ? {...e, dataset_hash: hex('7')} : e), 'BI_DATASET_HASH_MISMATCH');
  check(good.map((e, k) => k === 0 ? mutateResult(e, r => { r.evaluation_bars = 199; }) : e), 'QR4_WINDOW_DATA_GAP');
  check(good, 'BI_DATASET_HASH_MISMATCH', {});
  { const u = note(rankSelection(reg, good, undefined)); assert.equal(u.status, 'SELECTION_INCOMPLETE'); assert.equal(u.code, 'BI_DATASET_HASH_MISMATCH'); }
  check(good, 'BI_DATASET_HASH_MISMATCH', {window_dataset_hash: 'nope'});
  // tampered registration
  const tampered = {...reg, filters: {...reg.filters, drawdown_limit_percent: '99'}};
  const t = note(rankSelection(tampered, good, {window_dataset_hash: DS}));
  assert.equal(t.status, 'SELECTION_INCOMPLETE'); assert.equal(t.code, 'INTEGRITY_CHECK_FAILED');
  // garbage never throws
  for (const [rg, ev] of [[null, good], [reg, null], [reg, 'x'], [reg, [null, 5]], [{}, []], [undefined, undefined], [reg, [...good, ...good]]]) {
    const o = rank(rg, ev);
    assert.equal(o.status, 'SELECTION_INCOMPLETE');
    assert.equal(o.ranking, null);
  }
  // an extra evaluation for an unknown parent is an integrity failure, not silently ignored
  const extra = {...good[0], run_id: 'ev-x', parent_run_id: 'run-zzz'};
  assert.equal(rank(reg, [...good, extra]).status, 'SELECTION_INCOMPLETE');
});

/* ---------- 12, 13 eligibility ---------- */
const ELIG_CTX = () => ({owner_id: OWNER, requester_owner_id: OWNER, scope: baseScope(), fixture: false});
function baseScope() { return baseReg(2, null, c => { c.objective_registry = registryWith(); }).scope; }
const elig = (patch, ctxPatch) => { const m = mkMember(1, patch); const c = ELIG_CTX(); if (ctxPatch) ctxPatch(c); return note(evaluateEligibility(m, c)); };

test('16.1-12 eligibility: a clean member is a PARTICIPANT; one negation per check E1..E6 gives the expected code', () => {
  const ok = elig();
  assert.equal(ok.eligible, true); assert.equal(ok.status, 'PARTICIPANT'); assert.equal(ok.code, null);
  assert.deepEqual(Object.values(ok.checks), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.deepEqual(ok.validation_binding, {export_id: 'exp-1', package_hash: hex('1'), validated_at_utc: '2026-10-01T00:00:00.000Z'});
  // E1: a QUALIFIED label with a failing gate (G5) copies the first failing gate code
  const e1 = elig(m => { m.qualification.gates[4] = {gate: 'G5', state: 'FAIL', code: 'HOLDOUT_EXPOSED_X'}; });
  assert.equal(e1.eligible, false); assert.equal(e1.code, 'QR4_PARTICIPANT_NOT_QUALIFIED'); assert.equal(e1.detail, 'HOLDOUT_EXPOSED_X'); assert.equal(e1.checks.E1, 'FAIL');
  const e1b = elig(m => { m.integrity_checked = false; });
  assert.equal(e1b.code, 'QR4_PARTICIPANT_NOT_QUALIFIED', 'list row integrity is not enough');
  const e1c = elig(m => { m.run_status = 'FAILED'; });
  assert.equal(e1c.eligible, false); assert.equal(e1c.code, 'QR4_PARTICIPANT_NOT_QUALIFIED');
  // E2
  const e2 = elig(m => { m.package.status = 'EXPORT_CANDIDATE'; });
  assert.equal(e2.code, 'QR4_PARTICIPANT_NOT_READY'); assert.equal(e2.detail, 'EXPORT_CANDIDATE'); assert.equal(e2.checks.E2, 'FAIL');
  for (const st of ['EXPORT_INTERNAL', 'EXPORT_REFUSED', 'NO_VALID_CANDIDATE']) {
    const r = elig(m => { m.package.status = st; });
    assert.equal(r.eligible, false, st); assert.equal(r.code, 'QR4_PARTICIPANT_NOT_READY', st);
  }
  const e2b = elig(m => { m.package.current.bot_owner_id = 'someone-else'; });
  assert.equal(e2b.eligible, false); assert.equal(e2b.code, 'QR4_PARTICIPANT_NOT_READY');
  // E3
  const e3 = elig(m => { m.validation_records[0].record.package_hash = hex('f'); });
  assert.equal(e3.code, 'QR4_VALIDATION_BINDING_MISMATCH'); assert.equal(e3.checks.E3, 'FAIL');
  const e3b = elig(m => { m.validation_records[0].record.export_id = 'exp-other'; });
  assert.equal(e3b.code, 'QR4_VALIDATION_BINDING_MISMATCH');
  const e3c = elig(m => { m.validation_records = []; });
  assert.equal(e3c.eligible, false);
  // E4
  const e4 = elig(m => { m.market = {...m.market, symbol: 'ETHUSDT'}; });
  assert.equal(e4.code, 'BI_MARKET_SCOPE_INVALID'); assert.equal(e4.checks.E4, 'FAIL');
  const e4b = elig(m => { m.market = {...m.market, timeframe: '5'}; });
  assert.equal(e4b.code, 'BI_MARKET_SCOPE_INVALID');
  const e4c = elig(m => { m.market = null; });
  assert.equal(e4c.code, 'BI_MARKET_SCOPE_INVALID', 'missing is FAIL');
  // E5
  const e5 = elig(m => { m.scope.capital = {equity: '5000', cash: '5000'}; });
  assert.equal(e5.code, 'QR4_SCOPE_INCOMPATIBLE'); assert.deepEqual(e5.mismatched_fields, ['capital']); assert.equal(e5.checks.E5, 'FAIL');
  const e5b = elig(m => { m.scope.cost_model.fee_bps = '11'; m.scope.data_model.price_tick = '0.1'; });
  assert.deepEqual([...e5b.mismatched_fields].sort(), ['cost_model', 'data_model']);
  const e5c = elig(m => { delete m.scope.policy; });
  assert.deepEqual(e5c.mismatched_fields, ['policy'], 'missing scope field is a mismatch, not a skip');
  // E6
  const fx = elig(m => { m.package.binding.fixture = true; m.validation_records[0].record.fixture = true; });
  assert.equal(fx.code, 'QR4_FIXTURE_PARTICIPANT'); assert.equal(fx.eligible, false);
  const mp = elig(m => { m.package.binding.mode = 'MULTI_PINE'; });
  assert.equal(mp.code, 'QR4_MULTI_PINE_PARTICIPANT'); assert.equal(mp.eligible, false);
});

test('16.1-12 never participants: development-only at highest score, failed run, imported bundle, QR-2 actual history, evaluation run', () => {
  const dev = elig(m => { m.qualification = {version: 'library-qualification-v2', label: 'DEVELOPMENT_ONLY', qualified: false, gates: GATES.map((g, k) => k === 7 ? {gate: 'G8', state: 'FAIL', code: 'QL4C_VALIDATION_NOT_AVAILABLE'} : g)}; m.development_score = '999'; m.package = null; m.validation_records = []; });
  assert.equal(dev.eligible, false); assert.equal(dev.code, 'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
  for (const label of ['NOT_EVALUATED', 'NO_SCREENED_CANDIDATE']) {
    const r = elig(m => { m.qualification.label = label; m.qualification.qualified = false; });
    assert.equal(r.eligible, false, label); assert.equal(r.code, 'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE', label);
  }
  const nv = elig(m => { m.run_status = 'INSUFFICIENT'; m.package = null; m.validation_records = []; });
  assert.equal(nv.eligible, false);
  for (const st of ['CANCELLED', 'TIMED_OUT', 'FAILED']) assert.equal(elig(m => { m.run_status = st; }).eligible, false, st);
  assert.equal(elig(m => { m.kind = 'IMPORTED_BUNDLE'; }).eligible, false);
  assert.equal(elig(m => { m.kind = 'EVALUATION_RUN'; }).eligible, false);
  const act = elig(m => { m.kind = 'ACTUAL_HISTORY'; });
  assert.equal(act.eligible, false); assert.equal(act.code, 'QR4_ACTUAL_HISTORY_NOT_RANKABLE');
  const foreign = elig(m => { m.owner_id = 'someone-else'; });
  assert.equal(foreign.eligible, false); assert.equal(foreign.code, 'NOT_FOUND');
  // unreadable input is FAIL, no throw
  for (const bad of [null, undefined, 5, 'x', []]) assert.equal(note(evaluateEligibility(bad, ELIG_CTX())).eligible, false);
  assert.equal(note(evaluateEligibility(mkMember(1), null)).eligible, false);
});

test('16.1-12 STALE package of a qualified run is listed as QUALIFIED_STALE and never ranked', () => {
  const s = elig(m => { m.package.current.deployment_id = 'dep-changed'; });
  assert.equal(s.status, 'QUALIFIED_STALE'); assert.equal(s.eligible, false);
  assert.equal(s.code, 'QR4_PARTICIPANT_NOT_READY'); assert.equal(s.detail, 'BI_DEPLOYMENT_CHANGED');
  const rep = elig(m => { m.package.replay_mismatch = true; });
  assert.equal(rep.status, 'QUALIFIED_STALE'); assert.equal(rep.detail, 'REPLAY_MISMATCH');
  // in a registration: stale member is visible in the universe, not a participant
  const members = goodMembers(3); members[2].package.current.input_lock_hash = hex('9');
  const r = build(members, null, c => { c.objective_registry = registryWith(); });
  assert.equal(r.ok, true);
  assert.equal(r.registration.participant_count, 2);
  const u = r.registration.universe.find(x => x.run_id === 'run-3');
  assert.equal(u.status, 'QUALIFIED_STALE');
  assert.equal(r.registration.universe.length, 3, 'universe snapshot lists every member');
});

test('16.1-12 mixed-basis request and actual-history request in buildRegistration', () => {
  const members = goodMembers(2); members.push({...mkMember(3), kind: 'ACTUAL_HISTORY'});
  const mixed = build(members, null, c => { c.objective_registry = registryWith(); });
  assert.equal(mixed.ok, false); assert.equal(mixed.code, 'QR4_MIXED_BASIS');
  const only = build([{...mkMember(1), kind: 'ACTUAL_HISTORY'}, {...mkMember(2), kind: 'ACTUAL_HISTORY'}]);
  assert.equal(only.ok, false); assert.equal(only.code, 'QR4_ACTUAL_HISTORY_NOT_RANKABLE');
  const dev = build(goodMembers(3), q => { q.ranking_basis = 'DEVELOPMENT_SCORE'; });
  assert.equal(dev.code, 'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE');
  const own = build(goodMembers(3), q => { q.ranking_basis = 'OWN_HOLDOUT'; });
  assert.equal(own.code, 'QR4_OWN_HOLDOUT_NOT_COMPARABLE');
});

test('16.1-13 E3 through buildRegistration: a G8 record naming another package_hash gives QR4_VALIDATION_BINDING_MISMATCH in the universe', () => {
  const members = goodMembers(3); members[0].validation_records[0].record.package_hash = hex('f');
  const r = build(members, null, c => { c.objective_registry = registryWith(); });
  assert.equal(r.ok, true); assert.equal(r.registration.participant_count, 2);
  const u = r.registration.universe.find(x => x.run_id === 'run-1');
  assert.equal(u.eligible, false); assert.equal(u.code, 'QR4_VALIDATION_BINDING_MISMATCH');
});

/* ---------- 14 current real state ---------- */
test('16.1-14 with G8 failing everywhere every registration gives QR4_NO_ELIGIBLE_PARTICIPANT (first in refusal order, RC-S15)', () => {
  const devOnly = m => {
    m.qualification = {version: 'library-qualification-v2', label: 'DEVELOPMENT_ONLY', qualified: false, gates: GATES.map(g => g.gate === 'G8' ? {gate: 'G8', state: 'FAIL', code: 'QL4C_VALIDATION_NOT_AVAILABLE'} : g)};
    m.validation_records = [];
  };
  const r = build(goodMembers(3, devOnly));
  assert.equal(r.ok, false); assert.equal(r.code, 'QR4_NO_ELIGIBLE_PARTICIPANT');
  // RC-S15: wins over unavailable dependencies and unset tolerances
  const r2 = build(goodMembers(3, devOnly), null, c => { c.dependencies = {}; c.objective_registry = undefined; });
  assert.equal(r2.code, 'QR4_NO_ELIGIBLE_PARTICIPANT');
  assert.equal(build([]).code, 'QR4_NO_ELIGIBLE_PARTICIPANT');
});

/* ---------- 15, 16 registered thresholds, rules ---------- */
test('16.1-15 filters: weaker than participant rules or policy gives QR4_FILTER_INVALID; own copied values decide', () => {
  const weaker = build(goodMembers(3), q => { q.filters.drawdown_limit_percent = '25'; });
  assert.equal(weaker.code, 'QR4_FILTER_INVALID');
  const equalOk = build(goodMembers(3), q => { q.filters.drawdown_limit_percent = '20'; });
  assert.equal(equalOk.ok, true, 'equal to the rules threshold is not weaker');
  const policyWeak = build(goodMembers(3), q => { q.filters.drawdown_limit_percent = '15'; }, c => { c.policy_snapshot.max_drawdown_percent = '10'; });
  assert.equal(policyWeak.code, 'QR4_FILTER_INVALID');
  const floor = build(goodMembers(3), q => { q.filters.episode_floor = 4; });
  assert.equal(floor.code, 'QR4_FILTER_INVALID');
  const strict = build(goodMembers(3), q => { q.filters.episode_floor = 8; });
  assert.equal(strict.ok, true, 'stricter is allowed');
  assert.equal(strict.registration.filters.episode_floor, 8);
  const wrongType = build(goodMembers(3), q => { q.filters.drawdown_limit_percent = 15; });
  assert.equal(wrongType.code, 'QR4_FILTER_INVALID');
  const missing = build(goodMembers(3), q => { delete q.filters.drawdown_limit_percent; });
  assert.equal(missing.code, 'QR4_FILTER_INVALID');
  // registration copies values; ranking judges by the copy: dd 12 passes at limit 15, fails at limit 10
  const reg15 = regWith('0.5', '0.5', 2), reg10 = regWith('0.5', '0.5', 2, q => { q.filters.drawdown_limit_percent = '10'; });
  assert.deepEqual(rank(reg15, evals(reg15, [{dd: '12'}, {dd: '3'}])).not_passed, []);
  assert.deepEqual(rank(reg10, evals(reg10, [{dd: '12'}, {dd: '3'}])).not_passed.map(x => x.filter_codes), [['FILTER_DRAWDOWN_LIMIT']]);
  // RC-S6 policy snapshot
  for (const snap of [undefined, null, {policy_hash: hex('0'), max_drawdown_percent: '20'}, {policy_hash: POLICY_HASH}]) {
    const r = build(goodMembers(3), null, c => { c.policy_snapshot = snap; });
    assert.equal(r.code, 'QR4_FILTER_INVALID', JSON.stringify(snap)); assert.equal(r.detail, 'POLICY_SNAPSHOT_UNREADABLE');
  }
  const nullLimit = build(goodMembers(3), null, c => { c.policy_snapshot = {policy_hash: POLICY_HASH, max_drawdown_percent: null}; });
  assert.equal(nullLimit.ok, true, 'a decimal string or null snapshot is valid');
  assert.equal(nullLimit.registration.scope.policy_max_drawdown_percent, null);
  assert.equal(equalOk.registration.scope.policy_max_drawdown_percent, '20');
});

test('16.1-16 mixed rules hashes give QR4_RULES_VERSION_MIXED; hash that is not the digest of its rules gives detail RULES_HASH_MISMATCH', () => {
  const other = {maximum_drawdown_percent: '18'};
  const mixed = build(goodMembers(3, (m, i) => { if (i === 3) { m.rules = other; m.rules_hash = rulesHash(other); } }));
  assert.equal(mixed.code, 'QR4_RULES_VERSION_MIXED');
  const mism = build(goodMembers(3, m => { m.rules_hash = hex('a'); }));
  assert.equal(mism.code, 'QR4_RULES_VERSION_MIXED'); assert.equal(mism.detail, 'RULES_HASH_MISMATCH');
  const same = build(goodMembers(3));
  assert.equal(same.ok, true);
  assert.equal(same.registration.universe.length, 3);
});

/* ---------- participants count, duplicates, universe ---------- */
test('4.3 participant count 2..4, duplicates and universe cap (RC-S16)', () => {
  assert.equal(build(goodMembers(1)).code, 'QR4_TOO_FEW_PARTICIPANTS');
  assert.equal(build(goodMembers(5)).code, 'QR4_TOO_MANY_PARTICIPANTS');
  assert.equal(build(goodMembers(2)).ok, true);
  assert.equal(build(goodMembers(4)).ok, true);
  const dupExport = goodMembers(3); dupExport[1].export_id = 'exp-1'; dupExport[1].package.export_id = 'exp-1';
  assert.equal(build(dupExport).code, 'QR4_DUPLICATE_PARTICIPANT');
  const dupRun = goodMembers(3); dupRun[1].run_id = 'run-1';
  assert.equal(build(dupRun).code, 'QR4_DUPLICATE_PARTICIPANT');
  assert.equal(build(goodMembers(4), null, c => { c.universe_cap = 3; }).code, 'QR4_UNIVERSE_TOO_LARGE');
  assert.equal(build(goodMembers(4), null, c => { c.universe_cap = 4; }).ok, true);
  // ineligible members stay in the universe with their first failing code; participants are not truncated
  const members = goodMembers(4); members[3].market.symbol = 'ETHUSDT';
  const r = build(members);
  assert.equal(r.ok, true); assert.equal(r.registration.participant_count, 3);
  assert.equal(r.registration.universe.find(x => x.run_id === 'run-4').code, 'BI_MARKET_SCOPE_INVALID');
});

/* ---------- dependencies and tolerances (RC-S1, RC-S15) ---------- */
test('RC-S1 and 1.3: dependency order, then registry tolerances', () => {
  const dep = d => build(goodMembers(3), null, c => { c.dependencies = d; });
  assert.equal(dep({}).code, 'QR4_QR3_CONTEXT_UNAVAILABLE');
  assert.equal(dep({qr3_context: true}).code, 'QR4_EVALUATION_MODE_UNAVAILABLE');
  assert.equal(dep({qr3_context: true, evaluation_mode: true}).code, 'QR4_EPISODE_GATE_UNAVAILABLE');
  assert.equal(dep(undefined).code, 'QR4_QR3_CONTEXT_UNAVAILABLE');
  // default registry has null tolerances: refuses QR4_OBJECTIVE_UNKNOWN with detail TIE_TOLERANCES_NOT_SET
  const nul = build(goodMembers(3), null, c => { delete c.objective_registry; });
  assert.equal(nul.code, 'QR4_OBJECTIVE_UNKNOWN'); assert.equal(nul.detail, 'TIE_TOLERANCES_NOT_SET');
  assert.equal(S.OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'].tie_tolerances.return_pp, null);
  // dependency refusal comes before tolerance refusal
  assert.equal(build(goodMembers(3), null, c => { delete c.objective_registry; c.dependencies = {}; }).code, 'QR4_QR3_CONTEXT_UNAVAILABLE');
  for (const bad of ['101', '-1', 'abc', '100.0001', '']) {
    const r = build(goodMembers(3), null, c => { c.objective_registry = registryWith(bad, '0.5'); });
    assert.equal(r.code, 'QR4_OBJECTIVE_UNKNOWN', 'return tolerance ' + bad); assert.equal(r.detail, 'TIE_TOLERANCES_INVALID', bad);
    const r2 = build(goodMembers(3), null, c => { c.objective_registry = registryWith('0.5', bad); });
    assert.equal(r2.detail, 'TIE_TOLERANCES_INVALID', 'drawdown tolerance ' + bad);
  }
  for (const good of ['0', '100', '0.5']) assert.equal(build(goodMembers(3), null, c => { c.objective_registry = registryWith(good, good); }).ok, true, good);
  const one = build(goodMembers(3), null, c => { c.objective_registry = registryWith('0.5', null); });
  assert.equal(one.detail, 'TIE_TOLERANCES_NOT_SET');
});

/* ---------- 18 adversarial ---------- */
test('16.1-18 adversarial: weights, sort, rank refused before any evaluation; tolerances only from the registry', () => {
  for (const key of ['weights', 'sort', 'rank', 'sort_by', 'order_by', 'score', 'formula', 'Weights', 'SORT']) {
    const r = build(goodMembers(3), q => { q[key] = {a: 1}; });
    assert.equal(r.ok, false, key); assert.equal(r.code, 'QR4_CUSTOM_WEIGHTS_REFUSED', key);
    const o = build(goodMembers(3), q => { q.objective[key] = 1; });
    assert.equal(o.code, 'QR4_CUSTOM_WEIGHTS_REFUSED', 'in objective ' + key);
    const f = build(goodMembers(3), q => { q.filters[key] = 1; });
    assert.equal(f.code, 'QR4_CUSTOM_WEIGHTS_REFUSED', 'in filters ' + key);
  }
  assert.equal(build(goodMembers(3), q => { q.objective.id = 'qr4-objective-custom'; }).code, 'QR4_OBJECTIVE_UNKNOWN');
  assert.equal(build(goodMembers(3), q => { q.objective = {}; }).ok, false);
  assert.equal(build(goodMembers(3), q => { q.objective.extra = 1; }).code, 'INVALID_FIELDS');
  const tol = build(goodMembers(3), q => { q.filters.tie_tolerance_return_pp = '5'; });
  assert.equal(tol.code, 'INVALID_FIELDS'); assert.equal(tol.detail, 'TOLERANCE_IN_REQUEST');
  const tol2 = build(goodMembers(3), q => { q.objective.tolerance = '5'; });
  assert.equal(tol2.code, 'INVALID_FIELDS');
  assert.equal(build(goodMembers(3), q => { q.surprise = 1; }).code, 'INVALID_FIELDS');
  assert.equal(build(goodMembers(3), q => { q.prior_selection_ids = ['x']; }).code, 'INVALID_FIELDS', 'RC-S17 request has no such key');
  assert.equal(build(goodMembers(3), q => { q.confirmed = false; }).code, 'CONFIRMATION_REQUIRED');
  assert.equal(build(goodMembers(3), q => { delete q.confirmed; }).code, 'CONFIRMATION_REQUIRED');
  for (const bad of [null, undefined, 5, 'x', []]) assert.equal(note(buildRegistration(bad, mkCtx())).ok, false);
  assert.equal(note(buildRegistration(mkRequest(goodMembers(3)), null)).ok, false);
});

test('RC-S4 and RC-S17: INVALID_FIELDS details for requester and server lists', () => {
  const d = (cp) => build(goodMembers(3), null, c => { c.objective_registry = registryWith(); cp(c); });
  let r = d(c => { delete c.requester_owner_id; });
  assert.equal(r.code, 'INVALID_FIELDS'); assert.equal(r.detail, 'REQUESTER_UNREADABLE');
  r = d(c => { c.requester_owner_id = 'someone'; });
  assert.equal(r.code, 'INVALID_FIELDS'); assert.equal(r.detail, 'REQUESTER_NOT_OWNER');
  r = d(c => { delete c.prior_selection_ids; });
  assert.equal(r.code, 'INVALID_FIELDS'); assert.equal(r.detail, 'PRIOR_SELECTIONS_UNREADABLE');
  r = d(c => { c.prior_selection_ids = 'x'; });
  assert.equal(r.detail, 'PRIOR_SELECTIONS_UNREADABLE');
  r = d(c => { delete c.existing_registrations; });
  assert.equal(r.code, 'INVALID_FIELDS'); assert.equal(r.detail, 'EXISTING_REGISTRATIONS_UNREADABLE');
  // prior selections are disclosed
  const ok = d(c => { c.prior_selection_ids = ['b', 'a']; });
  assert.equal(ok.ok, true); assert.equal(ok.registration.prior_selection_count, 2); assert.deepEqual([...ok.registration.prior_selection_ids].sort(), ['a', 'b']);
});

/* ---------- idempotency and immutability ---------- */
test('13.1 idempotency, immutability and registration contents', () => {
  const reg = baseReg(3, null, c => { c.objective_registry = registryWith(); });
  assert.ok(Object.isFrozen(reg) && Object.isFrozen(reg.participants));
  assert.match(reg.registration_hash, /^[a-f0-9]{64}$/);
  assert.equal(typeof reg.registration_key, 'string');
  assert.deepEqual({e: reg.window.evaluation_bars, w: reg.window.warmup_bars, t: reg.window.total_bars}, {e: 200, w: 50, t: 250});
  assert.deepEqual(reg.objective.tie_tolerance_return_pp, '0.5');
  // copies, not references: changing the registry constant afterwards cannot relabel
  assert.equal(reg.objective.id, 'qr4-objective-lexi-v1');
  assert.deepEqual(reg.participants.map(p => p.export_id), ['exp-1', 'exp-2', 'exp-3']);
  const again = build(goodMembers(3), null, c => { c.objective_registry = registryWith(); c.existing_registrations = [{owner_id: OWNER, registration_key: reg.registration_key, selection_id: 'sel-old'}]; });
  assert.equal(again.ok, false); assert.equal(again.code, 'QR4_SELECTION_EXISTS'); assert.equal(again.selection_id, 'sel-old');
  const other = build(goodMembers(3), null, c => { c.objective_registry = registryWith(); c.existing_registrations = [{owner_id: 'other', registration_key: reg.registration_key, selection_id: 'x'}]; });
  assert.equal(other.ok, true, 'a key of another owner is not a repeat');
  const imm = S.refuseRegistrationChange();
  assert.equal(imm.ok, false); assert.equal(imm.code, 'QR4_REGISTRATION_IMMUTABLE');
  // same registration under another selection id keeps the same key (key hashes scope, W, objective, filters, participants)
  const k2 = build(goodMembers(3), q => { q.selection_id = 'sel-2'; }, c => { c.objective_registry = registryWith(); });
  assert.equal(k2.registration.registration_key, reg.registration_key);
  // a different window gives a different key
  const k3 = build(goodMembers(3), q => { q.window.warmup_bars = 60; }, c => { c.objective_registry = registryWith(); });
  assert.notEqual(k3.registration.registration_key, reg.registration_key);
});

/* ---------- 17 windows ---------- */
const wcase = (members, qp, cp) => build(members, qp, c => { c.objective_registry = registryWith(); if (cp) cp(c); });
const overlapWindow = () => ({start_ms: R + 150 * MIN, end_ms: R + 160 * MIN});

test('16.1-17 window overlap with a participant train, validation, holdout, dataset or evidence window', () => {
  for (const name of ['dataset', 'train', 'validation', 'holdout']) {
    const r = wcase(goodMembers(3, (m, i) => { if (i === 2) m.data_windows[name] = overlapWindow(); }));
    assert.equal(r.code, 'QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA', name);
  }
  const ev = wcase(goodMembers(3, (m, i) => { if (i === 1) m.data_windows.evidence = [overlapWindow()]; }));
  assert.equal(ev.code, 'QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA', 'dataset referenced by package evidence');
  // half-open: touching does not overlap
  const touch = wcase(goodMembers(3, (m, i) => { if (i === 1) m.data_windows.holdout = {start_ms: R + 50 * MIN, end_ms: R + 100 * MIN}; }));
  assert.equal(touch.ok, true, 'holdout ends exactly where W starts');
  const touchEnd = wcase(goodMembers(3, (m, i) => { if (i === 1) m.data_windows.holdout = {start_ms: R + 300 * MIN, end_ms: R + 400 * MIN}; }));
  assert.equal(touchEnd.ok, true, 'holdout starts exactly where W ends');
  // one bar inside overlaps
  const bar = wcase(goodMembers(3, (m, i) => { if (i === 1) m.data_windows.holdout = {start_ms: R + 50 * MIN, end_ms: R + 101 * MIN}; }));
  assert.equal(bar.code, 'QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA');
  // warm-up bars only: warm-up is [start-50 bars, start) = [R+50, R+100). Overlap there passes.
  const warm = wcase(goodMembers(3, (m, i) => { if (i === 1) m.data_windows.holdout = {start_ms: R - 2000 * MIN, end_ms: R + 90 * MIN}; }));
  assert.equal(warm.ok, true, 'overlap of warm-up bars only passes');
  // unreadable participant windows fail, never pass
  const missing = wcase(goodMembers(3, (m, i) => { if (i === 1) delete m.data_windows.holdout; }));
  assert.equal(missing.ok, false);
});

test('16.1-17 window overlap with a window of another run on a participant source', () => {
  const entry = (patch = {}) => ({owner_id: OWNER, source_hash: hex('1'), run_id: 'other-run', kind: 'RESEARCH_RUN', window: overlapWindow(), ...patch});
  const hit = wcase(goodMembers(3), null, c => { c.searched_windows = [entry()]; });
  assert.equal(hit.code, 'QR4_WINDOW_OVERLAPS_SEARCHED_DATA');
  assert.equal(wcase(goodMembers(3), null, c => { c.searched_windows = [entry({source_hash: hex('9')})]; }).ok, true, 'other source');
  assert.equal(wcase(goodMembers(3), null, c => { c.searched_windows = [entry({owner_id: 'other-owner'})]; }).ok, true, 'other owner');
  assert.equal(wcase(goodMembers(3), null, c => { c.searched_windows = [entry({window: {start_ms: R + 300 * MIN, end_ms: R + 400 * MIN}})]; }).ok, true, 'touching');
  for (const bad of [null, undefined, 'x', [null], [{owner_id: OWNER}]]) {
    const r = wcase(goodMembers(3), null, c => { c.searched_windows = bad; });
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.code, 'QR4_EXPOSURE_REGISTRY_UNAVAILABLE'); assert.equal(r.detail, 'SEARCHED_WINDOWS_UNREADABLE');
  }
});

test('16.1-17 window overlap with an exposure record, QR-3 events included; empty registry passes; unreadable registry refuses', () => {
  const ex = (patch = {}) => ({owner_id: OWNER, market_key: MARKET_KEY, window: overlapWindow(), comparison_id: 'cmp-1', kind: 'QR3_COMPARISON', at_ms: R - MIN, ...patch});
  assert.equal(wcase(goodMembers(3), null, c => { c.exposure_register = []; }).ok, true, 'empty registry is valid');
  const qr3 = wcase(goodMembers(3), null, c => { c.exposure_register = [ex()]; });
  assert.equal(qr3.code, 'QR4_WINDOW_EXPOSED');
  const qr4 = wcase(goodMembers(3), null, c => { c.exposure_register = [ex({comparison_id: undefined, selection_id: 'sel-other', kind: 'QR4_SELECTION'})]; });
  assert.equal(qr4.code, 'QR4_WINDOW_EXPOSED');
  assert.equal(wcase(goodMembers(3), null, c => { c.exposure_register = [ex({owner_id: 'other'})]; }).ok, true, 'other owner');
  assert.equal(wcase(goodMembers(3), null, c => { c.exposure_register = [ex({market_key: canonical({broker: 'binance-global', symbol: 'ETHUSDT', timeframe: '1'})})]; }).ok, true, 'other market');
  assert.equal(wcase(goodMembers(3), null, c => { c.exposure_register = [ex({window: {start_ms: R + 300 * MIN, end_ms: R + 400 * MIN}})]; }).ok, true);
  for (const bad of [undefined, null, 'x', [null], [{owner_id: OWNER}]]) {
    const r = wcase(goodMembers(3), null, c => { c.exposure_register = bad; });
    assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.code, 'QR4_EXPOSURE_REGISTRY_UNAVAILABLE');
  }
});

test('16.1-17 start before registered boundary; over capacity; invalid window shapes and kinds', () => {
  const b = (boundary) => wcase(goodMembers(3, (m, i) => { if (i === 2) m.registered_boundary_ms = boundary; }));
  assert.equal(b(R + 100 * MIN).ok, true, 'start at the boundary is allowed ("at or after")');
  assert.equal(b(R + 100 * MIN + 1).code, 'QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY');
  assert.equal(b(R + 101 * MIN).code, 'QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY');
  assert.equal(b(R - 5000 * MIN).ok, true);
  const win = patch => wcase(goodMembers(3), q => { Object.assign(q.window, patch); q.admission_deadline_ms = R + 20000 * MIN; });
  assert.equal(win({end_ms: R + 100 * MIN + 9950 * MIN, warmup_bars: 50}).ok, true, 'total exactly 10000 passes');
  const over = win({end_ms: R + 100 * MIN + 9950 * MIN, warmup_bars: 51});
  assert.equal(over.code, 'QR4_WINDOW_OVER_CAPACITY');
  assert.equal(win({end_ms: R + 100 * MIN + 10001 * MIN, warmup_bars: 0}).code, 'QR4_WINDOW_OVER_CAPACITY');
  assert.equal(wcase(goodMembers(3), q => { q.window.end_ms = R + 100 * MIN + 100 * MIN; }, c => { c.capacity_bars = 100; }).code, 'QR4_WINDOW_OVER_CAPACITY');
  assert.equal(win({start_ms: R + 100 * MIN + 1}).code, 'QR4_WINDOW_INVALID', 'start not on a bar boundary');
  assert.equal(win({end_ms: R + 300 * MIN + 1}).code, 'QR4_WINDOW_INVALID', 'incomplete last bar');
  assert.equal(win({end_ms: R + 100 * MIN}).code, 'QR4_WINDOW_INVALID', 'empty window');
  assert.equal(win({end_ms: R + 50 * MIN}).code, 'QR4_WINDOW_INVALID', 'end before start');
  assert.equal(win({kind: 'RETROSPECTIVE'}).code, 'QR4_WINDOW_INVALID', 'OD-S1: no other kind');
  assert.equal(win({kind: undefined}).code, 'QR4_WINDOW_INVALID');
  assert.equal(win({warmup_bars: -1}).code, 'QR4_WINDOW_INVALID');
  assert.equal(win({warmup_bars: 1.5}).code, 'QR4_WINDOW_INVALID');
  assert.equal(win({start_ms: R, end_ms: R + 100 * MIN}).code, 'QR4_WINDOW_INVALID', 'PROSPECTIVE starts after registration');
  assert.equal(win({start_ms: R - 10 * MIN, end_ms: R + 100 * MIN}).code, 'QR4_WINDOW_INVALID');
  assert.equal(wcase(goodMembers(3), q => { q.window = null; }).ok, false);
  assert.equal(wcase(goodMembers(3), q => { q.window.extra = 1; }).code, 'QR4_WINDOW_INVALID');
});

test('OD-S1 FORWARD_PAST window starts at or after the latest dataset end and is completed before registration', () => {
  const past = (patch) => wcase(goodMembers(3), q => { q.window = {kind: 'FORWARD_PAST', start_ms: R - 1000 * MIN, end_ms: R - 800 * MIN, warmup_bars: 10, ...patch}; });
  assert.equal(past({}).ok, true, 'starts exactly at the dataset end R-1000');
  assert.equal(past({start_ms: R - 1001 * MIN}).code, 'QR4_WINDOW_INVALID');
  assert.equal(past({end_ms: R + 1 * MIN}).code, 'QR4_WINDOW_INVALID', 'a past window must be complete before registration');
  assert.equal(past({}).registration.window.kind, 'FORWARD_PAST');
});

/* ---------- 17a recheck ---------- */
test('16.1-17a window race: recheck at evaluation start and outcome write ends the selection without ranking', () => {
  const reg = baseReg(3, null, c => { c.objective_registry = registryWith(); });
  const ex = (patch = {}) => ({owner_id: OWNER, market_key: MARKET_KEY, window: overlapWindow(), comparison_id: 'cmp-1', kind: 'QR3_COMPARISON', at_ms: R + 10, ...patch});
  const rs = (extra, stage = 'EVALUATION_START') => note(recheckWindow({registration: reg, exposure_register: [], searched_windows: [{owner_id: OWNER, source_hash: hex('1'), run_id: 'x', kind: 'EVALUATION_RUN', window: overlapWindow()}], stage, ...extra}));
  for (const stage of ['EVALUATION_START', 'OUTCOME_WRITE']) {
    const clean = rs({}, stage);
    assert.equal(clean.ok, true, stage); assert.equal(clean.ranking, true);
    const q3 = rs({exposure_register: [ex()]}, stage);
    assert.equal(q3.ok, false); assert.equal(q3.ends_selection, true); assert.equal(q3.status, 'SELECTION_INCOMPLETE'); assert.equal(q3.code, 'QR4_WINDOW_EXPOSED'); assert.equal(q3.ranking, false);
    const q4 = rs({exposure_register: [ex({comparison_id: undefined, selection_id: 'sel-other', kind: 'QR4_SELECTION'})]}, stage);
    assert.equal(q4.code, 'QR4_WINDOW_EXPOSED'); assert.equal(q4.ends_selection, true);
    const own = rs({exposure_register: [ex({comparison_id: undefined, selection_id: reg.selection_id, kind: 'QR4_SELECTION'})]}, stage);
    assert.equal(own.ok, true, 'own exposure record never fails own recheck');
    const searched = rs({searched_windows: [{owner_id: OWNER, source_hash: hex('2'), run_id: 'late-run', kind: 'RESEARCH_RUN', window: overlapWindow()}]}, stage);
    assert.equal(searched.ok, false); assert.equal(searched.ends_selection, true); assert.equal(searched.code, 'QR4_WINDOW_OVERLAPS_SEARCHED_DATA'); assert.equal(searched.status, 'SELECTION_INCOMPLETE');
    const ownEval = rs({searched_windows: [{owner_id: OWNER, source_hash: hex('2'), run_id: 'ev-1', kind: 'EVALUATION_RUN', window: overlapWindow()}]}, stage);
    assert.equal(ownEval.ok, true, 'evaluation runs never fail the recheck');
    // RC-S2 unreadable: blocks, never ends the selection
    for (const bad of [{exposure_register: undefined}, {exposure_register: 'x'}, {searched_windows: undefined}, {searched_windows: [null]}]) {
      const u = rs(bad, stage);
      assert.equal(u.ok, false, JSON.stringify(bad)); assert.equal(u.ends_selection, false); assert.equal(u.code, 'QR4_EXPOSURE_REGISTRY_UNAVAILABLE'); assert.equal(u.status, null);
    }
  }
  const bad = rs({}, 'SOMETIME');
  assert.equal(bad.ok, false, 'unknown stage does not pass');
  assert.equal(note(recheckWindow({registration: {...reg, filters: {}}, exposure_register: [], searched_windows: [], stage: 'EVALUATION_START'})).ok, false, 'altered registration blocks');
  assert.equal(note(recheckWindow()).ok, false);
  // registration exposure is written only by the caller; the recheck never mutates inputs
  // lifecycle: the recheck failure maps to SELECTION_INCOMPLETE from both live states
  for (const from of ['SELECTION_REGISTERED', 'SELECTION_EVALUATING']) {
    for (const code of ['QR4_WINDOW_EXPOSED', 'QR4_WINDOW_OVERLAPS_SEARCHED_DATA']) {
      const t = note(transitionSelection(from, {kind: 'WINDOW_RECHECK_FAILED', code}));
      assert.equal(t.ok, true); assert.equal(t.to, 'SELECTION_INCOMPLETE'); assert.equal(t.code, code);
    }
    const blocked = transitionSelection(from, {kind: 'WINDOW_RECHECK_FAILED', code: 'QR4_EXPOSURE_REGISTRY_UNAVAILABLE'});
    assert.equal(blocked.ok, false); assert.equal(blocked.code, 'QR4_TRANSITION_INVALID');
  }
});

/* ---------- 8.1 transitions ---------- */
test('8.1 lifecycle: listed transitions pass, every other is QR4_TRANSITION_INVALID; terminal states are terminal', () => {
  const t = (from, ev) => note(transitionSelection(from, ev));
  assert.equal(t(null, {kind: 'REGISTER'}).to, 'SELECTION_REGISTERED');
  assert.equal(t('SELECTION_REGISTERED', {kind: 'FIRST_EVALUATION_START'}).to, 'SELECTION_EVALUATING');
  assert.equal(t('SELECTION_REGISTERED', {kind: 'OWNER_CANCEL'}).to, 'SELECTION_CANCELLED');
  assert.equal(t('SELECTION_EVALUATING', {kind: 'OWNER_CANCEL'}).to, 'SELECTION_CANCELLED');
  assert.equal(t('SELECTION_REGISTERED', {kind: 'PARTICIPANT_INELIGIBLE', code: 'QR4_PARTICIPANT_STALE'}).to, 'SELECTION_INCOMPLETE');
  assert.equal(t('SELECTION_EVALUATING', {kind: 'PARTICIPANT_INELIGIBLE', code: 'QR4_PARTICIPANT_STALE'}).to, 'SELECTION_INCOMPLETE');
  assert.equal(t('SELECTION_REGISTERED', {kind: 'DEADLINE_PASSED', code: 'QR4_ADMISSION_REFUSED'}).to, 'SELECTION_INCOMPLETE');
  assert.equal(t('SELECTION_REGISTERED', {kind: 'WINDOW_DATA_UNAVAILABLE', code: 'QR4_WINDOW_DATA_UNAVAILABLE'}).to, 'SELECTION_INCOMPLETE');
  for (const code of ['QR4_ADMISSION_REFUSED', 'QR4_EVALUATION_FAILED']) assert.equal(t('SELECTION_EVALUATING', {kind: 'DEADLINE_PASSED', code}).to, 'SELECTION_INCOMPLETE', code);
  assert.equal(t('SELECTION_EVALUATING', {kind: 'DEADLINE_PASSED', code: 'QR4_METRIC_MISSING'}).ok, false);
  assert.equal(t('SELECTION_REGISTERED', {kind: 'DEADLINE_PASSED', code: 'QR4_EVALUATION_FAILED'}).ok, false, 'registered deadline allows only QR4_ADMISSION_REFUSED');
  // WINDOW_DATA_UNAVAILABLE has no EVALUATING row (RC-S3)
  assert.equal(t('SELECTION_EVALUATING', {kind: 'WINDOW_DATA_UNAVAILABLE', code: 'QR4_WINDOW_DATA_UNAVAILABLE'}).ok, false);
  // all evaluations done
  const done = t('SELECTION_EVALUATING', {kind: 'ALL_EVALUATIONS_DONE', to: 'SELECTION_COMPLETED', outcome: 'BEST_IN_SCOPE'});
  assert.equal(done.ok, true); assert.equal(done.to, 'SELECTION_COMPLETED');
  for (const outcome of ['TIED_IN_SCOPE', 'NO_QUALIFYING_STRATEGY', 'INADEQUATE_EVIDENCE']) assert.equal(t('SELECTION_EVALUATING', {kind: 'ALL_EVALUATIONS_DONE', to: 'SELECTION_COMPLETED', outcome}).ok, true);
  for (const code of ['QR4_WINDOW_DATA_UNAVAILABLE', 'QR4_WINDOW_DATA_GAP', 'BI_DATASET_HASH_MISMATCH', 'QR4_EVALUATION_FAILED', 'QR4_METRIC_MISSING', 'INTEGRITY_CHECK_FAILED', 'QR4_ENGINE_MISMATCH', 'QR4_BENCHMARK_UNAVAILABLE']) {
    const r = t('SELECTION_EVALUATING', {kind: 'ALL_EVALUATIONS_DONE', to: 'SELECTION_INCOMPLETE', code});
    assert.equal(r.ok, true, code); assert.equal(r.code, code);
  }
  for (const code of ['SOMETHING_ELSE', 'QR4_EXPOSURE_REGISTRY_UNAVAILABLE', 'QR4_WINDOW_EXPOSED', undefined]) {
    const r = t('SELECTION_EVALUATING', {kind: 'ALL_EVALUATIONS_DONE', to: 'SELECTION_INCOMPLETE', code});
    assert.equal(r.ok, false, String(code)); assert.equal(r.code, 'QR4_TRANSITION_INVALID'); assert.equal(r.detail, 'CODE_NOT_ALLOWED');
  }
  // invalid ones
  for (const [from, kind] of [[null, 'FIRST_EVALUATION_START'], ['SELECTION_REGISTERED', 'ALL_EVALUATIONS_DONE'], ['SELECTION_EVALUATING', 'FIRST_EVALUATION_START'], ['SELECTION_EVALUATING', 'REGISTER'], ['SELECTION_REGISTERED', 'REGISTER']]) {
    const r = t(from, {kind, to: 'SELECTION_COMPLETED', outcome: 'BEST_IN_SCOPE'});
    assert.equal(r.ok, false, from + ' ' + kind); assert.equal(r.code, 'QR4_TRANSITION_INVALID');
  }
  for (const term of ['SELECTION_COMPLETED', 'SELECTION_INCOMPLETE', 'SELECTION_CANCELLED']) {
    for (const kind of ['OWNER_CANCEL', 'FIRST_EVALUATION_START', 'ALL_EVALUATIONS_DONE', 'REGISTER', 'WINDOW_RECHECK_FAILED', 'DEADLINE_PASSED', 'PARTICIPANT_INELIGIBLE']) {
      assert.equal(t(term, {kind, code: 'QR4_PARTICIPANT_STALE', to: 'SELECTION_COMPLETED', outcome: 'BEST_IN_SCOPE'}).ok, false, term + ' ' + kind);
    }
  }
  assert.equal(t('SELECTION_EVALUATING', null).ok, false);
  assert.equal(t('SELECTION_EVALUATING', {kind: 'ALL_EVALUATIONS_DONE', to: 'SELECTION_COMPLETED', outcome: 'WINNER'}).ok, false);
  // cancel needs the confirm token
  assert.equal(S.checkCancel('SELECTION_REGISTERED', false).code, 'CONFIRMATION_REQUIRED');
  assert.equal(S.checkCancel('SELECTION_REGISTERED', true).to, 'SELECTION_CANCELLED');
  assert.equal(S.checkCancel('SELECTION_COMPLETED', true).code, 'QR4_TRANSITION_INVALID');
  // partial results hidden until terminal (8.1 table, section 5.4)
  assert.equal(S.metricsVisible('SELECTION_EVALUATING'), false);
  assert.equal(S.metricsVisible('SELECTION_REGISTERED'), false);
  assert.equal(S.metricsVisible('SELECTION_COMPLETED'), true);
});

/* ---------- 19 registry frozen ---------- */
test('16.1-19 objective registry is frozen: exact ids, filters, keys and values for qr4-objective-lexi-v1', () => {
  assert.deepEqual(Object.keys(OBJECTIVE_REGISTRY), ['qr4-objective-lexi-v1']);
  assert.ok(Object.isFrozen(OBJECTIVE_REGISTRY) && Object.isFrozen(OBJECTIVE_REGISTRY['qr4-objective-lexi-v1']));
  assert.throws(() => { 'use strict'; OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'].third_key = 'x'; });
  const e = OBJECTIVE_REGISTRY['qr4-objective-lexi-v1'];
  assert.equal(e.id, 'qr4-objective-lexi-v1');
  assert.deepEqual(e.filters.map(f => f.code), ['FILTER_DRAWDOWN_LIMIT', 'FILTER_EPISODE_FLOOR', 'FILTER_COST_STRESS', 'FILTER_NET_RETURN_POSITIVE', 'FILTER_BEATS_BUY_AND_HOLD']);
  assert.deepEqual(e.filters.map(f => f.id), ['F1', 'F2', 'F3', 'F4', 'F5']);
  assert.deepEqual(e.filters.map(f => f.required), [true, true, true, true, false], 'F1 to F4 required, F5 optional');
  assert.equal(e.primary.metric, 'net_return_percent'); assert.equal(e.primary.direction, 'HIGHER_IS_BETTER');
  assert.equal(e.secondary.metric, 'max_drawdown_percent'); assert.equal(e.secondary.direction, 'LOWER_IS_BETTER');
  assert.equal(e.third_key, null, 'there is no third key');
  assert.equal(e.weights, null);
  assert.deepEqual(e.tie_tolerances, {return_pp: null, drawdown_pp: null, unit: 'PERCENTAGE_POINTS'}, 'OD-S3 open: tolerances null');
  assert.equal(e.uncertainty, 'qr4-uncertainty-disclosure-v1');
  assert.equal(S.QR4_VERSIONS.scope, 'qr4-scope-v1');
  assert.equal(S.QR4_VERSIONS.evaluation_mode, 'QR4_SELECTION_EVAL');
  // snapshot of key order (not derivable from the contract; fails on any change, so a bump is forced)
  assert.deepEqual(Object.keys(e), ['id', 'kind', 'filters', 'primary', 'secondary', 'third_key', 'weights', 'tie_tolerances', 'uncertainty', 'arithmetic']);
  assert.equal(e.arithmetic, 'EXACT_DECIMAL');
  assert.equal(S.EPISODE_FLOOR_V1, 5);
  assert.equal(S.MIN_PARTICIPANTS, 2); assert.equal(S.MAX_PARTICIPANTS, 4);
  assert.deepEqual([...S.WINDOW_KINDS], ['PROSPECTIVE', 'FORWARD_PAST']);
  assert.deepEqual([...S.OUTCOMES], ['BEST_IN_SCOPE', 'TIED_IN_SCOPE', 'NO_QUALIFYING_STRATEGY', 'INADEQUATE_EVIDENCE']);
  assert.deepEqual([...S.STATUSES], ['SELECTION_REGISTERED', 'SELECTION_EVALUATING', 'SELECTION_COMPLETED', 'SELECTION_INCOMPLETE', 'SELECTION_CANCELLED']);
});

/* ---------- 20 code pattern ---------- */
test('16.1-20 every code matches the pattern and every contract code exists', () => {
  const pat = /^[A-Z][A-Z0-9_]{1,63}$/;
  for (const c of CODE_LIST) assert.match(c, pat);
  assert.equal(new Set(CODE_LIST).size, CODE_LIST.length, 'no duplicate codes');
  const section9and10 = ['NOT_FOUND', 'CONFIRMATION_REQUIRED', 'QR4_NO_ELIGIBLE_PARTICIPANT', 'QR4_PARTICIPANT_NOT_READY', 'QR4_PARTICIPANT_NOT_QUALIFIED', 'QR4_VALIDATION_BINDING_MISMATCH',
    'QR4_FIXTURE_PARTICIPANT', 'QR4_MULTI_PINE_PARTICIPANT', 'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE', 'QR4_OWN_HOLDOUT_NOT_COMPARABLE', 'QR4_ACTUAL_HISTORY_NOT_RANKABLE', 'QR4_MIXED_BASIS',
    'QR4_TOO_FEW_PARTICIPANTS', 'QR4_TOO_MANY_PARTICIPANTS', 'QR4_DUPLICATE_PARTICIPANT', 'QR4_UNIVERSE_TOO_LARGE', 'QR4_SCOPE_INCOMPATIBLE', 'QR4_RULES_VERSION_MIXED', 'BI_MARKET_SCOPE_INVALID',
    'QR4_OBJECTIVE_UNKNOWN', 'QR4_CUSTOM_WEIGHTS_REFUSED', 'QR4_FILTER_INVALID', 'INVALID_FIELDS', 'QR4_REGISTRATION_IMMUTABLE', 'QR4_WINDOW_INVALID', 'QR4_WINDOW_OVER_CAPACITY',
    'QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA', 'QR4_WINDOW_OVERLAPS_SEARCHED_DATA', 'QR4_WINDOW_EXPOSED', 'QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY', 'QR4_QR3_CONTEXT_UNAVAILABLE',
    'QR4_EVALUATION_MODE_UNAVAILABLE', 'QR4_EPISODE_GATE_UNAVAILABLE', 'QR4_EXPOSURE_REGISTRY_UNAVAILABLE', 'QR4_EVALUATION_SEARCH_REFUSED', 'QR4_SELECTION_EXISTS', 'QR4_APPLY_REFUSED',
    'QR4_TRANSITION_INVALID', 'QR4_WINDOW_DATA_UNAVAILABLE', 'QR4_WINDOW_DATA_GAP', 'BI_DATASET_HASH_MISMATCH', 'QR4_EVALUATION_FAILED', 'QR4_METRIC_MISSING', 'INTEGRITY_CHECK_FAILED',
    'QR4_ENGINE_MISMATCH', 'QR4_BENCHMARK_UNAVAILABLE', 'QR4_PARTICIPANT_STALE', 'QR4_ADMISSION_REFUSED',
    'FILTER_DRAWDOWN_LIMIT', 'FILTER_EPISODE_FLOOR', 'FILTER_COST_STRESS', 'FILTER_NET_RETURN_POSITIVE', 'FILTER_BEATS_BUY_AND_HOLD'];
  for (const c of section9and10) assert.ok(CODE_LIST.includes(c), 'missing contract code ' + c);
  assert.ok(seenCodes.size > 20, 'sanity: many codes observed (' + seenCodes.size + ')');
});
test('zz-16.1-20 every code emitted by any test above matches the pattern and is a known code', () => {
  for (const c of seenCodes) { assert.match(c, /^[A-Z][A-Z0-9_]{1,63}$/, c); assert.ok(CODE_LIST.includes(c), 'emitted code not in CODE_LIST: ' + c); }
});

/* ---------- 17.3 / 12.2 / 5.4 / 3.3 guards ---------- */
test('RC-S11 route names are an exact-case allow-list; apply-type actions are QR4_APPLY_REFUSED', () => {
  for (const ok of ['register', 'cancel', 'replay_outcome', 'open_package', 'list', 'detail']) assert.equal(S.checkRouteAction(ok).ok, true, ok);
  for (const bad of ['Register', 'CANCEL', 'List', 'detail ', 'apply', 'import', 'start_bot', 'email', 'optimize', '', 'delete', 'update', null, undefined, 5]) {
    const r = note(S.checkRouteAction(bad));
    assert.equal(r.ok, false, String(bad));
  }
  for (const bad of ['apply', 'import', 'start_bot', 'email']) assert.equal(S.checkRouteAction(bad).code, 'QR4_APPLY_REFUSED', bad);
});

test('RC-S12 D1 development view query: unlisted and rank-like keys are refused before any row is read', () => {
  for (const k of ['sort', 'order_by', 'rank', 'top', 'best', 'sortby', 'rankby', 'top10', 'best3', 'leader', 'winner', 'unknown_param']) {
    const r = note(S.checkDevelopmentViewRequest({[k]: '1'}));
    assert.ok(r && r.ok === false, k); assert.equal(r.code, 'QR4_DEVELOPMENT_SCORE_NOT_RANKABLE', k);
  }
  assert.equal(S.checkDevelopmentViewRequest({}), null);
});

test('RC-S12 D2 field names: split on non-letters; stop_loss and desktop pass; top10 bestscore winnerid flagged; qualified_winner null echo allowed', () => {
  const v = row => S.developmentRowViolations(row);
  assert.deepEqual(v({stop_loss: 1, desktop: 2, run_id: 'a', score_kind: 'DEVELOPMENT_ONLY', qualified_winner: null}), []);
  for (const k of ['top10', 'bestscore', 'winnerid', 'rank', 'leader', 'best_run', 'rank_1', 'is_top', 'Winner']) assert.equal(v({[k]: 1}).length, 1, k);
  assert.equal(v({qualified_winner: 'run-1'}).length, 1, 'only the fixed null echo is exempt');
  assert.equal(v({nested: {inner: [{best: 1}]}}).length, 1, 'nested names are checked');
});

test('5.4 evaluation request: search dimension, bound, domain or budget refused; unknown keys refused', () => {
  const base = {selection_id: 'sel-1', run_id: 'ev-1', parent_run_id: 'run-1', mode: 'QR4_SELECTION_EVAL'};
  assert.equal(S.validateEvaluationRequest(base).ok, true);
  for (const k of ['search', 'bounds', 'domain', 'budget', 'dimensions', 'grid', 'seed']) {
    const r = note(S.validateEvaluationRequest({...base, [k]: 1}));
    assert.equal(r.ok, false, k); assert.equal(r.code, 'QR4_EVALUATION_SEARCH_REFUSED', k);
  }
  assert.equal(S.validateEvaluationRequest({...base, free_parameter: 3}).ok, false, 'an unnamed free dimension must not pass');
  assert.equal(S.validateEvaluationRequest(null).ok, false);
});

/* ---------- labels, overlays, replay, fixture ---------- */
test('11 labels: sentences, label only for rank 1 of BEST/TIED, none for empty outcomes', () => {
  assert.equal(S.NO_SIGNIFICANCE_SENTENCE, 'No statistical significance is claimed.');
  assert.equal(S.NO_PROFIT_SENTENCE, 'This is not a profitability claim or a forecast.');
  assert.equal(S.EXPOSURE_SENTENCE, 'This selection used the period W. That period is now development evidence. A claim about another period needs new independent data.');
  assert.equal(S.NO_QUALIFYING_TEXT, 'No qualifying strategy within the selected scope.');
  assert.equal(S.INADEQUATE_EVIDENCE_TEXT, 'Evidence is not adequate to rank within the selected scope.');
  assert.equal(S.NO_WINNER_TEXT, 'Qualified recommendations: none. No qualified winner.');
  assert.equal(S.SCOPE_PHRASE, 'within the selected scope');
  const reg = regWith('0.5', '0.5', 3);
  const o = rank(reg, evals(reg, [{ret: '9'}, {ret: '2', dd: '9'}, {ret: '6'}]));
  assert.equal(o.outcome, 'BEST_IN_SCOPE');
  assert.deepEqual(o.label.participants, ['exp-1']);
  assert.equal(o.label.exposure_sentence, S.EXPOSURE_SENTENCE);
  assert.equal(o.label.no_significance_sentence, S.NO_SIGNIFICANCE_SENTENCE);
  assert.equal(o.label.no_profitability_sentence, S.NO_PROFIT_SENTENCE);
  const cov = o.label.scope_statement.coverage;
  assert.deepEqual(cov, {participants_compared: 3, universe_runs: 3, evaluation_bars_each: 200});
  assert.equal(o.label.scope_statement.window.evaluation_bars, 200);
  assert.equal(o.label.scope_statement.window.total_bars, 250);
  assert.equal(o.label.scope_statement.window.warmup_bars, 50);
  assert.equal(o.label.scope_statement.window.start_utc, new Date(R + 100 * MIN).toISOString());
  assert.equal(o.label.scope_statement.prior_selection_count, 0);
  assert.equal(o.label.scope_statement.objective_id, 'qr4-objective-lexi-v1');
  assert.deepEqual(o.label.scope_statement.tie_tolerances, {return_pp: '0.5', drawdown_pp: '0.5'});
  assert.equal(o.label.scope_statement.universe.length, 3);
  for (const word of ['best', 'top', 'winner', 'optimal']) {
    const t = JSON.stringify(o.text ?? '') + o.label.label_text;
    if (new RegExp('\\b' + word + '\\b', 'i').test(t)) assert.ok(t.includes('within the selected scope'), word + ' without scope phrase');
  }
  // INADEQUATE and NO_QUALIFYING carry the no-winner text
  const none = rank(reg, evals(reg, [{ret: '-1', cs: '-1'}, {ret: '-2', cs: '-2'}, {ret: '-3', cs: '-3'}]));
  assert.equal(none.no_winner_text, 'Qualified recommendations: none. No qualified winner.');
});

test('8.2 overlays: WINNER_NOT_READY and SELECTION_REPLAY_MISMATCH suppress the label; RULESET_SUPERSEDED is information only', () => {
  const reg = regWith('0.5', '0.5', 3);
  const o = rank(reg, evals(reg, [{ret: '9'}, {ret: '2'}, {ret: '6'}]));
  const facts = (patch = {}) => ({packages_ready: {'exp-1': true, 'exp-2': true, 'exp-3': true}, replay_mismatch: false, current_versions: {objective: 'qr4-objective-lexi-v1', scope: 'qr4-scope-v1'}, ...patch});
  const clean = S.deriveOverlays(reg, o, facts());
  assert.deepEqual(clean.overlays, []); assert.equal(clean.label_visible, true);
  const notReady = S.deriveOverlays(reg, o, facts({packages_ready: {'exp-1': false, 'exp-2': true, 'exp-3': true}}));
  assert.ok(notReady.overlays.includes('WINNER_NOT_READY')); assert.equal(notReady.label_visible, false); assert.equal(notReady.hide_recommended_values, true); assert.equal(notReady.hide_package_links, true);
  const losingRank2NotReady = S.deriveOverlays(reg, o, facts({packages_ready: {'exp-1': true, 'exp-2': false, 'exp-3': false}}));
  assert.equal(losingRank2NotReady.label_visible, true, 'only the labelled participant matters');
  const rep = S.deriveOverlays(reg, o, facts({replay_mismatch: true}));
  assert.ok(rep.overlays.includes('SELECTION_REPLAY_MISMATCH')); assert.equal(rep.label_visible, false);
  const sup = S.deriveOverlays(reg, o, facts({current_versions: {objective: 'qr4-objective-lexi-v2', scope: 'qr4-scope-v1'}}));
  assert.deepEqual(sup.overlays, ['RULESET_SUPERSEDED']); assert.equal(sup.label_visible, true, 'information only, not relabelled');
  assert.equal(S.deriveOverlays(reg, o, undefined).label_visible, false, 'unreadable facts suppress');
});

test('13.2 replay: equal hash passes; a different stored hash or a missing W hash is a mismatch event that suppresses the label', () => {
  const reg = regWith('0.5', '0.5', 3);
  const ev = evals(reg, [{ret: '9'}, {ret: '2'}, {ret: '6'}]);
  const o = rank(reg, ev);
  const same = replayOutcome(reg, ev, o.outcome_hash, {window_dataset_hash: DS});
  assert.equal(same.match, true); assert.equal(same.event, null);
  const diff = replayOutcome(reg, ev, hex('5'), {window_dataset_hash: DS});
  assert.equal(diff.match, false); assert.equal(diff.event.kind, 'SELECTION_REPLAY_MISMATCH'); assert.equal(diff.event.label_suppressed, true);
  const noHash = replayOutcome(reg, ev, o.outcome_hash, {});
  assert.equal(noHash.match, false, 'RC-S8 missing hash cannot replay');
  const other = replayOutcome(reg, ev, o.outcome_hash, {window_dataset_hash: hex('3')});
  assert.equal(other.match, false);
  const changed = replayOutcome(reg, evals(reg, [{ret: '9'}, {ret: '2'}, {ret: '6.1'}]), o.outcome_hash, {window_dataset_hash: DS});
  assert.equal(changed.match, false, 'changed evaluation results change the hash');
  assert.equal(replayOutcome(reg, ev, 'nope', {window_dataset_hash: DS}).match, false);
});

test('RC-S7 fixture selection: needs a server allowance, admits fixture packages only, never gets a label', () => {
  const fxMember = i => mkMember(i, m => { m.package.binding.fixture = true; m.validation_records[0].record.fixture = true; });
  const fxBuild = (members, cp) => build(members, q => { q.fixture = true; }, c => { c.objective_registry = registryWith(); c.fixture_selections_allowed = true; if (cp) cp(c); });
  const r = fxBuild([fxMember(1), fxMember(2), fxMember(3)]);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.registration.fixture, true);
  const o = rank(r.registration, evals(r.registration, [{ret: '9'}, {ret: '2'}, {ret: '6'}]));
  assert.equal(o.status, 'SELECTION_COMPLETED'); assert.equal(o.label, null, 'fixture selection has no label'); assert.equal(o.fixture, true);
  // non-fixture package in a fixture selection: QR4_FIXTURE_PARTICIPANT detail NOT_FIXTURE_IN_FIXTURE_SELECTION
  const mixed = fxBuild([fxMember(1), fxMember(2), mkMember(3)]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.registration.universe.find(x => x.run_id === 'run-3').code, 'QR4_FIXTURE_PARTICIPANT');
  assert.equal(mixed.registration.universe.find(x => x.run_id === 'run-3').detail, 'NOT_FIXTURE_IN_FIXTURE_SELECTION');
  // a customer selection refuses fixture packages
  const cust = build([fxMember(1), fxMember(2), fxMember(3)], null, c => { c.objective_registry = registryWith(); });
  assert.equal(cust.code, 'QR4_NO_ELIGIBLE_PARTICIPANT');
  // fixture request without server allowance is not honoured
  const denied = build([fxMember(1), fxMember(2), fxMember(3)], q => { q.fixture = true; }, c => { c.objective_registry = registryWith(); });
  assert.equal(denied.ok, false);
});

test('6.3 and 7.1 uncertainty disclosure: version id and no-significance sentence stored in the outcome body and covered by outcome_hash', () => {
  assert.equal(S.QR4_VERSIONS.uncertainty, 'qr4-uncertainty-disclosure-v1');
  const reg = regWith('0.5', '0.5', 2);
  const o = rank(reg, evals(reg, [{ret: '9'}, {ret: '2'}]));
  assert.equal(o.rulesets.uncertainty, 'qr4-uncertainty-disclosure-v1');
  const {outcome_hash, ...body} = o;
  const stripped = {...body, no_significance_sentence: null};
  assert.notEqual(hash(canonical(stripped)), outcome_hash, 'sentence is inside the hashed body');
  const noRank = rank(reg, evals(reg, [{ret: '-9', cs: '-9'}, {ret: '-2', cs: '-2'}]));
  assert.equal(noRank.no_significance_sentence, null);
});

test('11.2-3 outcome strings: best/top/winner/optimal never appear without the scope phrase', () => {
  const reg = regWith('0.5', '0.5', 3);
  const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(x => strings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out)); return out; };
  const outcomes = [
    rank(reg, evals(reg, [{ret: '9'}, {ret: '2'}, {ret: '6'}])),
    rank(reg, evals(reg, [{ret: '9'}, {ret: '9'}, {ret: '6'}])),
    rank(reg, evals(reg, [{ret: '-1', cs: '-1'}, {ret: '-2', cs: '-2'}, {ret: '-3', cs: '-3'}])),
    rank(reg, evals(reg, [{ep: 1}, {ep: 2}, {ep: 3}]))];
  for (const o of outcomes) {
    for (const s of strings(o)) {
      // 16.3 item 2: the fixed no-winner sentence of 8.3 is the one allowed exception.
      if (s === 'Qualified recommendations: none. No qualified winner.') continue;
      if (/\b(best|top|winner|optimal)\b/i.test(s)) assert.ok(s.includes('within the selected scope'), `outcome ${o.outcome}: "${s}" lacks the scope phrase`);
    }
  }
});
