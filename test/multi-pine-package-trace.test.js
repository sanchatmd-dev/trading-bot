import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical, hash} from '../src/pine-bridge/source.js';
import {RULES} from '../src/quant-research/contract.js';
import {TRACE_COLUMNS} from '../src/quant-library/trace-reproduction.js';
import {TRACE_FILES, MULTI_PINE_CONTRACT_VERSION} from '../src/quant-library/package-gates.js';
import {entryOwner} from '../src/multi-pine/combined-oracle.js';
import {MULTI_RUN_ACCEPTANCE_BLOCKERS, validateMultiResearchContract} from '../src/multi-pine/run-contract.js';
import {
  deriveMultiTrace, traceCsv, traceEntryOwner, MP_BASELINE_VERSION, MP_TRACE_COLUMNS, MP_TRACE_LIMITATION, MP_TRACE_METHOD, MP_TRACE_PATHS, TRACE_PRODUCER_CODES, TRACE_PRODUCER_DIVERGED,
  TRACE_PRODUCER_INPUT_INVALID
} from '../src/multi-pine/package-trace.js';

/*
 * F11 R6-1 (RD-MP-39): the multi-Pine trace producer. Every object below is a LABELLED ENGINEERING FIXTURE: a hand-built terminal result with seven stored holdout
 * decisions, no bars-v2 file, no database and no Python. Expected hashes and decimals are written out here, not derived with the module under test.
 */
const sha = text => createHash('sha256').update(text).digest('hex');
const ref = value => Array.isArray(value) ? '[' + value.map(ref).join(',') + ']' : value && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + ref(value[key])).join(',') + '}' : JSON.stringify(value);
const clone = value => structuredClone(value);
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;

const M = 60_000, START = 29333333 * M, BARS = 5000;
const SPLIT = {warmup: 500, train_end: 3200, validation_end: 4100, test_end: 5000};
const at = index => START + index * M;
const DEP = n => `0000000${n}-aaaa-4aaa-8aaa-00000000000${n}`;
const PINE = n => `1111111${n}-bbbb-4bbb-8bbb-11111111111${n}`;
const sourceOf = n => `//@version=5\nindicator("Fixture member ${n}", overlay=true)\nlen = input.int(${10 + n}, "Length")\nbuySignal = ta.crossover(close, ta.sma(close, len))\nsellSignal = ta.crossunder(close, ta.sma(close, len))\n`;
const POLICY = {paperTrading: true, requireReduceOnlySell: true, maxRiskPercent: 2};
const CLOSURE = sha('producer closure');
const refOf = (n, time) => DEP(n) + ':' + time + ':0';

function contractFor(count = 2) {
  const members = Array.from({length: count}, (_, i) => i + 1).map(n => ({ordinal: n, pine_import_id: PINE(n), source_version: 1, source_hash: sha(sourceOf(n)),
    effective_inputs_hash: sha('inputs-' + n), deployment_id: DEP(n), deployment_snapshot_hash: sha('snapshot-' + n), exit_version: 'bridge-exit-v2', evidence_hash: sha('evidence-' + n)}));
  return {version: MULTI_PINE_CONTRACT_VERSION, mode: 'MULTI_PINE', pine_count: count, member_set_id: '5b0c7a52-1d3e-4f60-8a71-2c9d4e6f8a01', set_hash: sha('set'),
    membership_hash: sha(ref(members.map(m => ({pine_import_id: m.pine_import_id, source_version: m.source_version, source_hash: m.source_hash})))), members,
    owner_id: 'owner-a', bot_id: 'bot-a', policy_hash: sha(ref(POLICY)), funding_cutoff: 7, capital: {equity: '1000', cash: '1000'},
    model: {version: 'paper-close-v1', price_tick: 0.01, quantity_step: 0.00001, fee_bps: 10, slippage_bps: 0, risk_percent: 1, data_profile: 'closed-ohlcv-atr14-v1'}, rules: clone(RULES),
    engine_hash: sha('engine'), dataset: {start_time: START, end_time: START + (BARS - 1) * M, warmup_bars: 500, bar_count: BARS, first_time: START,
      timestamp_semantics: 'verified closed-bar timestamps; half-open index end is last timestamp plus one minute', content_digest: sha('digest'), digest_version: 'pine-bar-content-digest-v1'},
    split: {...SPLIT}, budget: {candidates: 30}, seed: 42, bridge_domains: {atr_multiplier: {min: '1', max: '3', step: '0.5'}, rr: {min: '0.5', max: '2.5', step: '0.5'}},
    same_bar_order: 'exit-first-ordinal-v1', fixture: true, acceptance_blockers: [...MULTI_RUN_ACCEPTANCE_BLOCKERS]};
}
/** Seven stored holdout decisions. Cash: 1000 - 300.3 = 699.7; - 150.6505 = 549.0495; + 304.695 = 853.7445; + 149.3505 = 1003.095; - 300.3 = 702.795. */
function decisionsFor() {
  const fill = (n, type, time, over) => ({event_type: type, time: at(time), entry_ref: refOf(n, at(over.entry ?? time)), sequence: 0, reason: type === 'BUY' ? null : over.reason, sl: null, tp: null,
    outcome: 'FILLED', sizing_outcome: 'ACCEPTED', sizing_adjustment: null, quantity: over.quantity, price: over.price, notional: over.notional, fee: over.fee, cash: over.cash, cost: '0', realized_r: over.r ?? '0'});
  return [
    fill(1, 'BUY', 600, {quantity: '0.01', price: '30000', notional: '300', fee: '0.3', cash: '699.7'}),
    fill(2, 'BUY', 700, {quantity: '0.005', price: '30100', notional: '150.5', fee: '0.1505', cash: '549.0495'}),
    fill(1, 'EXIT', 800, {entry: 600, reason: 'TP', quantity: '0.01', price: '30500', notional: '305', fee: '0.305', cash: '853.7445', r: '0.5'}),
    {event_type: 'BUY', time: at(3300), entry_ref: refOf(2, at(3300)), sequence: 0, reason: 'MAX_OPEN_POSITIONS', sl: null, tp: null, outcome: 'REJECTED', quantity: '0', fee: '0'},
    fill(2, 'EXIT', 4200, {entry: 700, reason: 'SL', quantity: '0.005', price: '29900', notional: '149.5', fee: '0.1495', cash: '1003.095', r: '-1'}),
    fill(1, 'BUY', 4300, {quantity: '0.01', price: '30000', notional: '300', fee: '0.3', cash: '702.795'}),
    {event_type: 'EXIT', time: at(4400), entry_ref: refOf(1, at(100)), sequence: 0, reason: 'TARGET_NOT_OPEN', sl: null, tp: null, outcome: 'REJECTED', quantity: '0', fee: '0'}
  ];
}
const brief = tag => ({train: {closed_trades: 8, net_return_percent: '1.5'}, validation: {closed_trades: 6, net_return_percent: '0.9'}, decision_count: 40, fills: 30, rejections: {}, exit_fill_reasons: {TP: 3},
  ledger_hash: sha('ledger-' + tag)});
function runFor(count = 2) {
  const contract = contractFor(count), decisions = decisionsFor();
  const pair = {atr_multiplier: 2, rr: 1.5};
  const run_id = '9d8c7b6a-1111-4222-8333-444455556666', contract_hash = sha(ref(contract));
  const result = {version: 'mp-combined-result-v1', run_id, contract_hash, owner_recommendation_ready: false, acceptance_blockers: [...contract.acceptance_blockers], evaluator: 'mp-combined-paper-v1',
    engine_hash: contract.engine_hash, closure: {version: 'mp-combined-closure-v1', hash: contract.engine_hash}, set_hash: contract.set_hash, same_bar_order: contract.same_bar_order, fixture: true,
    search: {algorithm: 'seeded', seed: 42, budget: 30, planned: 30}, candidates: [],
    selected: {index: 0, parameters: pair, ...brief('selected'), sensitivity: [{dimension: 'atr_multiplier', parameters: {atr_multiplier: 2.5, rr: 1.5}, ...brief('n1')},
      {dimension: 'rr', parameters: {atr_multiplier: 2, rr: 1}, ...brief('n2')}], cost_stress: brief('stress'), screen_reasons: [],
      test: {bars: 900, closed_trades: 1, start_equity: '1000', end_equity: '1003.095', net_return_percent: '0.3095', max_drawdown_percent: '0.4', profit_factor: null},
      holdout: {ledger_hash: sha('holdout ledger'), decision_count: decisions.length, fills: decisions.filter(d => d.outcome === 'FILLED').length}},
    holdout_evaluated: true, completion_reason: 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE', member_signals: [], funnel: {step: 'HOLDOUT', rows: BARS, diagnostics: {}}, holdout_decisions: decisions,
    combined_baseline: {version: MP_BASELINE_VERSION, binding: {run_id, contract_hash}, pair: clone(pair), same_bar_order: contract.same_bar_order, matched: true, differences: {},
      received_decisions_hash: sha(ref(decisions))}};
  return {owner_id: 'owner-a', bot_id: 'bot-a', run_id, contract, contract_hash, submission_hash: sha('submission'), result};
}
/** Recompute what a divergence test does NOT want to trip first: the counts and the identity hash follow the edited decision list. */
function settle(run) {
  const {result} = run;
  result.selected.holdout.decision_count = result.holdout_decisions.length;
  result.selected.holdout.fills = result.holdout_decisions.filter(d => d.outcome === 'FILLED').length;
  result.combined_baseline.received_decisions_hash = sha(ref(result.holdout_decisions));
  return run;
}
const rehash = run => { run.contract_hash = sha(ref(run.contract)); run.result.contract_hash = run.contract_hash; run.result.combined_baseline.binding.contract_hash = run.contract_hash; return run; };
const edit = (fn, count = 2) => { const run = runFor(count); fn(run); return run; };
const derive = run => deriveMultiTrace({run, producer_closure_hash: CLOSURE});
const diverges = (run, pattern) => assert.throws(() => derive(run), error => error.code === TRACE_PRODUCER_DIVERGED && pattern.test(error.message), String(pattern));

test('the fixture contract is a valid multi-Pine run contract and the module constants are what the contract fixes', () => {
  const checked = validateMultiResearchContract(contractFor(2));
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(validateMultiResearchContract(contractFor(3)).ok, true);
  assert.deepEqual([...TRACE_PRODUCER_CODES], ['TRACE_PRODUCER_DIVERGED', 'TRACE_PRODUCER_INPUT_INVALID']);
  assert.equal(MP_TRACE_METHOD, 'stored-holdout-decisions-v1');
  assert.equal(MP_TRACE_LIMITATION, 'MP_TRACE_STEPS_NOT_REEVALUATED');
  assert.deepEqual([...Object.values(MP_TRACE_PATHS)].sort(), [...TRACE_FILES].sort());
  assert.equal(hash(canonical(runFor().result.holdout_decisions)), sha(ref(decisionsFor())), 'the module canonical form is the independent one');
});

test('columns are the one-Pine TRACE_COLUMNS plus deployment_id, and ordinal for decisions', () => {
  assert.deepEqual(MP_TRACE_COLUMNS.equity, [...TRACE_COLUMNS.equity, 'deployment_id']);
  assert.deepEqual(MP_TRACE_COLUMNS.trades, [...TRACE_COLUMNS.trades, 'deployment_id']);
  assert.deepEqual(MP_TRACE_COLUMNS.decisions, [...TRACE_COLUMNS.decisions, 'deployment_id', 'ordinal']);
  assert.ok(Object.isFrozen(MP_TRACE_COLUMNS) && Object.isFrozen(MP_TRACE_COLUMNS.decisions));
});

test('entry owner is the combined oracle rule: the key without its last two colon fields', () => {
  for (const key of [refOf(1, 123), 'a:b:c:d:0', 'x:1:0', ':1:0', 'x::0', 'nocolon', 'a:b', '', 7, null, undefined, 'a:b:c', '::', 'dep:12:0:extra'])
    assert.equal(traceEntryOwner(key), entryOwner(key), String(key));
  assert.equal(traceEntryOwner(refOf(2, 5)), DEP(2));
});

test('a good run derives three tables, three csv files and three records', () => {
  const out = derive(runFor());
  assert.deepEqual(Object.keys(out).sort(), ['counts', 'files', 'limitation_codes', 'records', 'tables']);
  assert.deepEqual(Object.keys(out.files), [MP_TRACE_PATHS.equity, MP_TRACE_PATHS.trades, MP_TRACE_PATHS.decisions]);
  assert.deepEqual(out.limitation_codes, ['MP_TRACE_STEPS_NOT_REEVALUATED']);
  assert.deepEqual(out.counts, {decisions: 7, fills: 5, closed_trades: {train: 1, validation: 0, test: 1}, open_entries: 1,
    members: [{ordinal: 1, deployment_id: DEP(1), decisions: 4, fills: 3}, {ordinal: 2, deployment_id: DEP(2), decisions: 3, fills: 2}]});
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.tables.trades.rows[0]) && Object.isFrozen(out.records[0]));
  for (const [name, table] of Object.entries(out.tables)) assert.deepEqual(table.columns, [...MP_TRACE_COLUMNS[name]]);
});

test('partitions come from the contract split: train, validation and test by decision time, and a trade takes the partition of its EXIT', () => {
  const out = derive(runFor());
  const decisions = out.tables.decisions.rows;
  assert.deepEqual(decisions.map(row => row[2]), ['train', 'train', 'train', 'validation', 'test', 'test', 'test']);
  assert.deepEqual(out.tables.equity.rows.map(row => row[2]), ['train', 'train', 'train', 'test', 'test']);
  const trades = out.tables.trades.rows;
  assert.deepEqual(trades.map(row => row[1]), ['train', 'test']);
  // exit-time partition, not entry-time partition: member 2 entered in train (bar 700) and exited in test (bar 4200)
  assert.equal(trades[1][2], at(700));
  assert.equal(trades[1][7], at(4200));
  // time_ms and time_utc agree
  for (const row of decisions) assert.equal(row[1], new Date(row[0]).toISOString());
  // the contract edges: the first bar of each partition and the last bar are on the right side
  for (const [time, expected] of [[at(500), 'train'], [at(3199), 'train'], [at(3200), 'validation'], [at(4099), 'validation'], [at(4100), 'test'], [at(4999), 'test']]) {
    const run = edit(r => { r.result.holdout_decisions = [{event_type: 'EXIT', time, entry_ref: refOf(1, at(1)), sequence: 0, reason: 'TARGET_NOT_OPEN', sl: null, tp: null, outcome: 'REJECTED', quantity: '0', fee: '0'}];
      r.result.selected.test.closed_trades = 0; settle(r); });
    assert.equal(derive(run).tables.decisions.rows[0][2], expected, String(time));
  }
});

test('member tags: every row carries the deployment of its entry_ref prefix, decisions also the member ordinal', () => {
  const out = derive(runFor());
  assert.deepEqual(out.tables.decisions.rows.map(row => [row[11], row[12]]), [[DEP(1), 1], [DEP(2), 2], [DEP(1), 1], [DEP(2), 2], [DEP(2), 2], [DEP(1), 1], [DEP(1), 1]]);
  assert.deepEqual(out.tables.equity.rows.map(row => row[7]), [DEP(1), DEP(2), DEP(1), DEP(2), DEP(1)]);
  assert.deepEqual(out.tables.trades.rows.map(row => row[14]), [DEP(1), DEP(2)]);
  // a third member with no decision is counted with zeros and changes nothing else
  const three = derive(runFor(3));
  assert.deepEqual(three.counts.members.map(m => [m.ordinal, m.decisions, m.fills]), [[1, 4, 3], [2, 3, 2], [3, 0, 0]]);
  assert.deepEqual(three.tables.decisions.rows, out.tables.decisions.rows);
  // a decision of member 3 is tagged ordinal 3
  const run = edit(r => { r.result.holdout_decisions.push({event_type: 'BUY', time: at(4500), entry_ref: refOf(3, at(4500)), sequence: 0, reason: 'MAX_OPEN_POSITIONS', sl: null, tp: null, outcome: 'REJECTED', quantity: '0', fee: '0'}); settle(r); }, 3);
  assert.deepEqual(derive(run).tables.decisions.rows.at(-1).slice(11), [DEP(3), 3]);
});

test('the exact rows: decimals stay strings as stored, net follows from the notionals and fees, equity marks the Bot position', () => {
  const out = derive(runFor());
  assert.deepEqual(out.tables.trades.rows, [
    [refOf(1, at(600)), 'train', at(600), new Date(at(600)).toISOString(), '30000', '0.01', '0.3', at(800), new Date(at(800)).toISOString(), '30500', '0.305', 'TP', '4.395', '0.5', DEP(1)],
    [refOf(2, at(700)), 'test', at(700), new Date(at(700)).toISOString(), '30100', '0.005', '0.1505', at(4200), new Date(at(4200)).toISOString(), '29900', '0.1495', 'SL', '-1.3', '-1', DEP(2)]]);
  const equity = out.tables.equity.rows;
  // position after each fill: 0.01, 0.015, 0.005, 0, 0.01; equity_at_fill = cash + position * price
  assert.deepEqual(equity.map(row => [row[4], row[5], row[6]]), [['699.7', '0.01', '999.7'], ['549.0495', '0.015', '1000.5495'], ['853.7445', '0.005', '1006.2445'], ['1003.095', '0', '1003.095'],
    ['702.795', '0.01', '1002.795']]);
  assert.deepEqual(out.tables.decisions.rows[3], [at(3300), new Date(at(3300)).toISOString(), 'validation', 'BUY', refOf(2, at(3300)), 'REJECTED', 'MAX_OPEN_POSITIONS', null, '0', null, '0', DEP(2), 2]);
  assert.deepEqual(out.tables.decisions.rows[0].slice(3, 11), ['BUY', refOf(1, at(600)), 'FILLED', null, 'ACCEPTED', '0.01', '30000', '0.3']);
});

test('csv text is RFC 4180 with line feeds, a header and a final line feed; the empty cell is null', () => {
  const out = derive(runFor());
  const lines = out.files[MP_TRACE_PATHS.decisions].split('\n');
  assert.equal(lines[0], MP_TRACE_COLUMNS.decisions.join(','));
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length, 7 + 2);
  assert.match(lines[4], /,REJECTED,MAX_OPEN_POSITIONS,,0,,0,/);
  assert.equal(traceCsv({columns: ['a', 'b'], rows: [['x,y', 'say "hi"'], [null, true], [3, 'line\nbreak']]}), 'a,b\n"x,y","say ""hi"""\n,true\n3,"line\nbreak"\n');
  assert.throws(() => traceCsv({columns: ['a'], rows: [[1.5]]}), error => error.code === TRACE_PRODUCER_DIVERGED);
  assert.throws(() => traceCsv({columns: ['a', 'b'], rows: [[1]]}), error => error.code === TRACE_PRODUCER_DIVERGED);
  assert.equal(out.files[MP_TRACE_PATHS.equity].split('\n').length, 5 + 2);
  assert.equal(out.files[MP_TRACE_PATHS.trades].split('\n').length, 2 + 2);
});

test('records: one per file, the sha256 of the file bytes, the identity hash, the digests of the stored steps, both engine hashes and the method', () => {
  const run = runFor(), out = derive(run), selected = run.result.selected;
  assert.deepEqual(out.records.map(record => record.path), Object.values(MP_TRACE_PATHS));
  const stepsDigest = sha(ref({candidate: {index: selected.index, parameters: selected.parameters, train: selected.train, validation: selected.validation, decision_count: selected.decision_count,
    fills: selected.fills, rejections: selected.rejections, exit_fill_reasons: selected.exit_fill_reasons, ledger_hash: selected.ledger_hash}, sensitivity: selected.sensitivity, cost_stress: selected.cost_stress}));
  const holdoutDigest = sha(ref({test: selected.test, holdout: selected.holdout}));
  for (const record of out.records) {
    assert.deepEqual(Object.keys(record).sort(), ['decisions_hash', 'holdout_digest', 'method', 'path', 'producer_closure_hash', 'run_engine_hash', 'sha256', 'steps_digest']);
    assert.equal(record.sha256, sha(out.files[record.path]));
    assert.equal(record.decisions_hash, sha(ref(run.result.holdout_decisions)));
    assert.equal(record.decisions_hash, run.result.combined_baseline.received_decisions_hash);
    assert.equal(record.steps_digest, stepsDigest);
    assert.equal(record.holdout_digest, holdoutDigest);
    assert.equal(record.run_engine_hash, run.contract.engine_hash);
    assert.equal(record.producer_closure_hash, CLOSURE);
    assert.equal(record.method, 'stored-holdout-decisions-v1');
  }
  // the digests move with the stored steps (a changed sensitivity or holdout step is a different record), the file hashes do not
  const other = derive(edit(r => { r.result.selected.cost_stress.ledger_hash = sha('other'); r.result.selected.holdout.ledger_hash = sha('other holdout'); }));
  assert.notEqual(other.records[0].steps_digest, out.records[0].steps_digest);
  assert.notEqual(other.records[0].holdout_digest, out.records[0].holdout_digest);
  assert.equal(other.records[0].sha256, out.records[0].sha256);
});

test('deterministic: the same run gives the same bytes, a reversed key order of the whole argument gives the same bytes, the argument is not mutated', () => {
  const run = runFor(), before = JSON.stringify(run);
  const first = derive(run), second = derive(run);
  assert.equal(JSON.stringify(run), before);
  assert.deepEqual(second, first);
  const shuffled = derive(reorder(clone(run)));
  assert.deepEqual(shuffled.files, first.files);
  assert.deepEqual(shuffled.records, first.records);
  assert.deepEqual(shuffled.counts, first.counts);
  // a different producer closure changes the records and nothing else
  const other = deriveMultiTrace({run, producer_closure_hash: sha('other closure')});
  assert.deepEqual(other.files, first.files);
  assert.notEqual(other.records[0].producer_closure_hash, first.records[0].producer_closure_hash);
});

test('a run with no fills at all derives header-only files', () => {
  const run = edit(r => { r.result.holdout_decisions = []; r.result.selected.test.closed_trades = 0; settle(r); });
  const out = derive(run);
  assert.deepEqual(out.tables.equity.rows, []);
  assert.equal(out.files[MP_TRACE_PATHS.trades], MP_TRACE_COLUMNS.trades.join(',') + '\n');
  assert.equal(out.counts.decisions, 0);
});

/* ---- refusals: every difference gives TRACE_PRODUCER_DIVERGED and returns nothing ---- */

test('refusal: an entry_ref prefix that maps to no member, a malformed entry_ref, and a prefix that is another run member set', () => {
  diverges(edit(r => { r.result.holdout_decisions[1].entry_ref = refOf(9, at(700)); settle(r); }), /maps to no contract member/);
  diverges(edit(r => { r.result.holdout_decisions[1].entry_ref = 'no-colon-at-all'; settle(r); }), /maps to no contract member/);
  diverges(edit(r => { r.result.holdout_decisions[1].entry_ref = 7; settle(r); }), /maps to no contract member/);
  diverges(edit(r => { r.result.holdout_decisions[6].entry_ref = 'x:1:0'; settle(r); }), /maps to no contract member/);
  // a member 3 reference on a two-member contract
  diverges(edit(r => { r.result.holdout_decisions[0].entry_ref = refOf(3, at(600)); settle(r); }), /maps to no contract member/);
});

test('refusal: a second BUY or a second EXIT for one entry_ref', () => {
  diverges(edit(r => { r.result.holdout_decisions.splice(1, 0, clone(r.result.holdout_decisions[0])); settle(r); }), /second BUY decision/);
  diverges(edit(r => { r.result.holdout_decisions.splice(3, 0, clone(r.result.holdout_decisions[2])); settle(r); }), /second EXIT decision/);
  // a rejected BUY counts as a BUY decision too
  diverges(edit(r => { r.result.holdout_decisions[3].entry_ref = refOf(1, at(600)); settle(r); }), /second BUY decision/);
});

test('refusal: a FILLED EXIT with no FILLED BUY, a different quantity, a missing reason, or an exit before its entry', () => {
  diverges(edit(r => { r.result.holdout_decisions[2].entry_ref = refOf(1, at(650)); settle(r); }), /without a FILLED BUY/);
  diverges(edit(r => { r.result.holdout_decisions[2].quantity = '0.009'; settle(r); }), /EXIT quantity or reason/);
  diverges(edit(r => { r.result.holdout_decisions[2].reason = null; settle(r); }), /EXIT quantity or reason/);
  diverges(edit(r => { const d = r.result.holdout_decisions; [d[0], d[2]] = [d[2], d[0]]; settle(r); }), /without a FILLED BUY|decision times decrease/);
  // a rejected BUY and a FILLED EXIT on the same entry_ref is not a closed trade
  diverges(edit(r => { r.result.holdout_decisions[4].entry_ref = refOf(2, at(3300)); settle(r); }), /without a FILLED BUY/);
});

test('refusal: a count that is off by one, in the decision count, the FILLED count and the closed trades of the test partition', () => {
  diverges(edit(r => { r.result.selected.holdout.decision_count += 1; }), /decision count/);
  diverges(edit(r => { r.result.selected.holdout.decision_count -= 1; }), /decision count/);
  diverges(edit(r => { r.result.selected.holdout.fills += 1; }), /FILLED count/);
  diverges(edit(r => { r.result.selected.holdout.fills -= 1; }), /FILLED count/);
  diverges(edit(r => { r.result.selected.test.closed_trades += 1; }), /closed trades of the test partition/);
  diverges(edit(r => { r.result.selected.test.closed_trades -= 1; }), /closed trades of the test partition/);
  // a stored count that is not an integer
  diverges(edit(r => { r.result.selected.holdout.fills = '5'; }), /selected counts/);
});

test('refusal: the identity hash differs (edited decisions, edited hash, edited key), without touching the counts', () => {
  diverges(edit(r => { r.result.holdout_decisions[0].fee = '0.30'; }), /identity hash/);
  diverges(edit(r => { r.result.combined_baseline.received_decisions_hash = sha('x'); }), /identity hash/);
  diverges(edit(r => { r.result.combined_baseline.received_decisions_hash = null; }), /identity hash/);
  diverges(edit(r => { delete r.result.combined_baseline.received_decisions_hash; }), /identity hash/);
  diverges(edit(r => { r.result.holdout_decisions.reverse(); }), /identity hash/);
});

test('refusal: the combined baseline did not match, is missing, has another version, is unbound, or names another pair', () => {
  diverges(edit(r => { r.result.combined_baseline.matched = false; }), /did not match/);
  diverges(edit(r => { r.result.combined_baseline.matched = 'true'; }), /did not match/);
  diverges(edit(r => { r.result.combined_baseline = null; }), /baseline missing/);
  diverges(edit(r => { delete r.result.combined_baseline; }), /baseline missing/);
  diverges(edit(r => { r.result.combined_baseline.version = 'mp-combined-baseline-v0'; }), /baseline missing/);
  diverges(edit(r => { r.result.combined_baseline.binding.run_id = 'other-run'; }), /not bound to the run/);
  diverges(edit(r => { r.result.combined_baseline.binding.contract_hash = sha('other contract'); }), /not bound to the run/);
  diverges(edit(r => { delete r.result.combined_baseline.binding; }), /not bound to the run/);
  diverges(edit(r => { r.result.combined_baseline.pair.rr = 1; }), /selected pair/);
  diverges(edit(r => { r.result.combined_baseline.pair = {atr_multiplier: 2}; }), /selected pair/);
  diverges(edit(r => { r.result.selected.parameters.atr_multiplier = 3; }), /selected pair/);
});

test('refusal: wrong pair across the steps is the same refusal, and a result of another run or contract is not accepted', () => {
  diverges(edit(r => { r.result.run_id = 'other'; }), /not bound to the run/);
  diverges(edit(r => { r.result.contract_hash = sha('other'); }), /not bound to the run/);
  diverges(edit(r => { r.result.engine_hash = sha('other engine'); }), /not bound to the contract/);
  diverges(edit(r => { r.result.set_hash = sha('other set'); }), /not bound to the contract/);
  diverges(edit(r => { r.result.fixture = false; }), /not bound to the contract/);
  diverges(edit(r => { r.contract.capital.cash = '999'; }), /contract hash differs/);
  diverges(edit(r => { r.contract_hash = sha('nope'); }), /contract hash differs/);
});

test('refusal: the holdout was not evaluated, or the run is not pending acceptance, or a stored step is missing', () => {
  diverges(edit(r => { r.result.holdout_evaluated = false; }), /holdout not evaluated/);
  diverges(edit(r => { r.result.completion_reason = 'CANDIDATE_FAILED_CHECKS'; }), /holdout not evaluated|pending acceptance/);
  diverges(edit(r => { delete r.result.holdout_decisions; }), /holdout_decisions/);
  diverges(edit(r => { r.result.holdout_decisions = {length: 7}; }), /holdout_decisions/);
  diverges(edit(r => { r.result.holdout_decisions[2] = 'FILLED'; }), /holdout_decisions/);
  diverges(edit(r => { r.result.selected = null; }), /selected steps are incomplete/);
  diverges(edit(r => { delete r.result.selected.test; }), /selected steps are incomplete/);
  diverges(edit(r => { delete r.result.selected.holdout; }), /selected steps are incomplete/);
  diverges(edit(r => { delete r.result.selected.cost_stress; }), /selected steps are incomplete/);
  diverges(edit(r => { r.result.selected.sensitivity = {}; }), /selected steps are incomplete/);
});

test('refusal: times going backwards, and times outside the contract bars', () => {
  diverges(edit(r => { const d = r.result.holdout_decisions; [d[5], d[6]] = [d[6], d[5]]; settle(r); }), /decision times decrease/);
  diverges(edit(r => { r.result.holdout_decisions[3].time = at(700); settle(r); }), /decision times decrease/);
  diverges(edit(r => { r.result.holdout_decisions[0].time = at(499); r.result.holdout_decisions[0].entry_ref = refOf(1, at(499)); settle(r); }), /outside the contract bars/);
  diverges(edit(r => { r.result.holdout_decisions[6].time = at(5000); settle(r); }), /outside the contract bars/);
  diverges(edit(r => { r.result.holdout_decisions[6].time = 1.5; settle(r); }), /outside the contract bars/);
  diverges(edit(r => { r.result.holdout_decisions[6].time = '1'; settle(r); }), /outside the contract bars/);
});

test('refusal: a cash value that does not follow from the previous cash by notional and fee, for BUY, EXIT and the first fill', () => {
  diverges(edit(r => { r.result.holdout_decisions[0].cash = '699.69'; settle(r); }), /cash does not follow/);
  diverges(edit(r => { r.result.holdout_decisions[2].cash = '853.7446'; settle(r); }), /cash does not follow/);
  diverges(edit(r => { r.result.holdout_decisions[5].cash = '702.7950001'; settle(r); }), /cash does not follow/);
  // the first fill starts from the run's cash
  diverges(edit(r => { r.contract.capital.cash = '1000.01'; rehash(r); }), /cash does not follow/);
  // a fee that is not part of the cash change, and a notional that is
  diverges(edit(r => { r.result.holdout_decisions[1].fee = '0.15'; settle(r); }), /cash does not follow/);
  diverges(edit(r => { r.result.holdout_decisions[1].notional = '150.4'; settle(r); }), /cash does not follow/);
  // non-decimal and non-string values are divergences, never exceptions of another kind
  for (const [key, value] of [['cash', 5], ['cash', 'abc'], ['notional', null], ['fee', 'x'], ['quantity', 0.01], ['price', undefined], ['realized_r', 'NaN']])
    diverges(edit(r => { r.result.holdout_decisions[0][key] = value; settle(r); }), /./);
});

test('refusal: a decision with an unknown event type or outcome, and amounts that are not positive', () => {
  diverges(edit(r => { r.result.holdout_decisions[0].event_type = 'SELL'; settle(r); }), /event_type or outcome/);
  diverges(edit(r => { r.result.holdout_decisions[0].outcome = 'ACCEPTED'; settle(r); }), /event_type or outcome/);
  diverges(edit(r => { r.result.holdout_decisions[0].quantity = '0'; settle(r); }), /FILLED amounts/);
  diverges(edit(r => { r.result.holdout_decisions[0].price = '0'; settle(r); }), /FILLED amounts/);
  diverges(edit(r => { r.result.holdout_decisions[0].reason = 5; settle(r); }), /reason type/);
});

test('input errors are TRACE_PRODUCER_INPUT_INVALID, not divergences', () => {
  const bad = (args, pattern = /./) => assert.throws(() => deriveMultiTrace(args), error => error.code === TRACE_PRODUCER_INPUT_INVALID && pattern.test(error.message));
  bad(undefined, /producer_closure_hash/);
  bad({}, /producer_closure_hash/);
  bad({run: runFor()}, /producer_closure_hash/);
  bad({run: runFor(), producer_closure_hash: 'abc'}, /producer_closure_hash/);
  bad({run: runFor(), producer_closure_hash: CLOSURE.toUpperCase()}, /producer_closure_hash/);
  bad({run: null, producer_closure_hash: CLOSURE}, /run/);
  bad({run: [], producer_closure_hash: CLOSURE}, /run/);
  bad({run: edit(r => { r.contract.version = 'ql3a-research-job-v2'; }), producer_closure_hash: CLOSURE}, /not a multi-Pine contract/);
  bad({run: edit(r => { r.contract.fixture = false; }), producer_closure_hash: CLOSURE}, /not a multi-Pine contract/);
  bad({run: edit(r => { r.contract.members = []; }), producer_closure_hash: CLOSURE}, /not a multi-Pine contract/);
  bad({run: edit(r => { delete r.contract.split; }), producer_closure_hash: CLOSURE}, /dataset and split/);
  bad({run: edit(r => { r.contract.dataset.bar_count = 4999; }), producer_closure_hash: CLOSURE}, /dataset and split/);
  bad({run: edit(r => { r.contract.capital = {cash: 1000}; }), producer_closure_hash: CLOSURE}, /capital/);
  bad({run: edit(r => { r.contract_hash = 'zz'; }), producer_closure_hash: CLOSURE}, /contract_hash/);
  bad({run: edit(r => { r.owner_id = ''; }), producer_closure_hash: CLOSURE}, /owner_id/);
  bad({run: edit(r => { r.result = []; }), producer_closure_hash: CLOSURE}, /result/);
  // the two contract members that share a deployment id would make a prefix ambiguous
  const twin = edit(r => { r.contract.members[1].deployment_id = r.contract.members[0].deployment_id; rehash(r); });
  diverges(twin, /share a deployment id/);
});

test('a refusal returns nothing and leaves the argument untouched', () => {
  const run = edit(r => { r.result.combined_baseline.matched = false; }), before = JSON.stringify(run);
  let returned = 'unset';
  try { returned = derive(run); } catch { returned = undefined; }
  assert.equal(returned, undefined);
  assert.equal(JSON.stringify(run), before);
});

test('purity: the producer reads no clock, random source, file, network or process, and imports neither the run store nor the executor', () => {
  const source = fs.readFileSync(new URL('../src/multi-pine/package-trace.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now|new Date\(\)|Math\.random|randomUUID|node:fs|node:net|node:http|node:child_process|fetch\(|process\.|setTimeout|require\(|import\(/);
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]).sort();
  assert.deepEqual(imports, ['../money.js', '../pine-bridge/source.js', './codes.js']);
  assert.doesNotMatch(source, /mp-run-store|mp_research_run|postgres/);
});

/* ---- R6-1 round 2: the exact Python ledger format, minute alignment, ordinal order, exact cash, pair key order ---- */

/** The Python ledger prints a decimal with 18 places, and zero as 0E-18. */
const py = value => { if (typeof value !== 'string') return value; if (/^0(?:\.0*)?$/.test(value)) return '0E-18'; const [whole, fraction = ''] = value.split('.'); return whole + '.' + fraction.padEnd(18, '0'); };
const pyDecision = decision => Object.fromEntries(Object.entries(decision).map(([key, value]) => [key, ['quantity', 'price', 'notional', 'fee', 'cash', 'cost', 'realized_r'].includes(key) ? py(value) : value]));
/** The seven fixture decisions in the exact Python form: 18-decimal strings, realized_r 0E-18 on a BUY, and a sizing_adjustment object on a CAPPED fill. */
function pythonRun(count = 2) {
  const run = runFor(count);
  run.result.holdout_decisions = run.result.holdout_decisions.map(pyDecision);
  Object.assign(run.result.holdout_decisions[1], {sizing_outcome: 'CAPPED', sizing_adjustment: {requested_quantity: '0.008000000000000000', granted_quantity: '0.005000000000000000', limit: 'CASH'}});
  return settle(run);
}

test('N6: a trace in the exact Python ledger format derives: 18-decimal strings, 0E-18 on a BUY, a CAPPED fill with a sizing_adjustment object', () => {
  const run = pythonRun(), decisions = run.result.holdout_decisions;
  assert.equal(decisions[0].realized_r, '0E-18');
  assert.equal(decisions[0].cash, '699.700000000000000000');
  assert.equal(decisions[1].sizing_outcome, 'CAPPED');
  const out = derive(run);
  assert.deepEqual(out.counts, {decisions: 7, fills: 5, closed_trades: {train: 1, validation: 0, test: 1}, open_entries: 1,
    members: [{ordinal: 1, deployment_id: DEP(1), decisions: 4, fills: 3}, {ordinal: 2, deployment_id: DEP(2), decisions: 3, fills: 2}]});
  // stored strings are copied as stored, computed values use the minimal form
  assert.deepEqual(out.tables.equity.rows.map(row => [row[4], row[5], row[6]]), [['699.700000000000000000', '0.01', '999.7'], ['549.049500000000000000', '0.015', '1000.5495'],
    ['853.744500000000000000', '0.005', '1006.2445'], ['1003.095000000000000000', '0', '1003.095'], ['702.795000000000000000', '0.01', '1002.795']]);
  assert.deepEqual(out.tables.trades.rows[0], [refOf(1, at(600)), 'train', at(600), new Date(at(600)).toISOString(), '30000.000000000000000000', '0.010000000000000000', '0.300000000000000000',
    at(800), new Date(at(800)).toISOString(), '30500.000000000000000000', '0.305000000000000000', 'TP', '4.395', '0.500000000000000000', DEP(1)]);
  assert.equal(out.tables.trades.rows[1][12], '-1.3');
  assert.equal(out.tables.trades.rows[1][13], '-1.000000000000000000');
  // the CAPPED fill is a FILLED decision; its sizing outcome is carried and the adjustment object is not
  assert.equal(out.tables.decisions.rows[1][7], 'CAPPED');
  assert.equal(out.tables.decisions.rows[1].length, MP_TRACE_COLUMNS.decisions.length);
  // a rejected decision keeps the stored zero form
  assert.deepEqual(out.tables.decisions.rows[3].slice(8, 11), ['0E-18', null, '0E-18']);
  assert.match(out.files[MP_TRACE_PATHS.decisions], /,CAPPED,0\.005000000000000000,30100\.000000000000000000,0\.150500000000000000,/);
  // the same run in the short form derives the same minimal-form columns
  const short = derive(runFor());
  assert.deepEqual(out.tables.equity.rows.map(row => [row[5], row[6]]), short.tables.equity.rows.map(row => [row[5], row[6]]));
  assert.deepEqual(out.tables.trades.rows.map(row => row[12]), short.tables.trades.rows.map(row => row[12]));
});

test('N6: the cash identity is exact to the last place, in both formats: 1e-18 off diverges', () => {
  const off = (make, index, cash) => { const run = make(); run.result.holdout_decisions[index].cash = cash; return settle(run); };
  for (const make of [runFor, pythonRun]) {
    assert.doesNotThrow(() => derive(make()));
    diverges(off(make, 0, '699.700000000000000001'), /cash does not follow/);
    diverges(off(make, 0, '699.699999999999999999'), /cash does not follow/);
    diverges(off(make, 2, '853.744500000000000001'), /cash does not follow/);
  }
});

test('N6: baseline.pair with the opposite key order from selected.parameters is the same pair and passes', () => {
  const run = runFor();
  assert.deepEqual(Object.keys(run.result.selected.parameters), ['atr_multiplier', 'rr']);
  run.result.combined_baseline.pair = {rr: 1.5, atr_multiplier: 2};
  assert.deepEqual(Object.keys(run.result.combined_baseline.pair), ['rr', 'atr_multiplier']);
  const out = derive(run);
  assert.deepEqual(out.files, derive(runFor()).files);
  diverges(edit(r => { r.result.combined_baseline.pair = {rr: 2, atr_multiplier: 2}; }), /selected pair/);
});

test('N4: decision times are minute-aligned to the dataset start', () => {
  diverges(edit(r => { r.result.holdout_decisions[3].time = at(3300) + 30_000; settle(r); }), /minute-aligned/);
  diverges(edit(r => { r.result.holdout_decisions[3].time = at(3300) - 1; settle(r); }), /minute-aligned/);
  diverges(edit(r => { r.result.holdout_decisions[3].time = at(3300) + 1; settle(r); }), /minute-aligned/);
  // any whole-minute offset from the dataset start is a bar, not only the bars the fixture uses
  assert.doesNotThrow(() => derive(edit(r => { r.result.holdout_decisions[3].time = at(3301); settle(r); })));
});

test('members are in ordinal order: a reordered or renumbered member list is an input error, and the counts follow the ordinals', () => {
  const bad = (fn, pattern = /ordinal order/) => assert.throws(() => derive(edit(fn, 3)), error => error.code === TRACE_PRODUCER_INPUT_INVALID && pattern.test(error.message));
  bad(r => { r.contract.members.reverse(); rehash(r); });
  bad(r => { r.contract.members.push(r.contract.members.shift()); rehash(r); });
  bad(r => { r.contract.members[1].ordinal = 5; rehash(r); });
  bad(r => { r.contract.members[0].ordinal = 0; rehash(r); });
  const out = derive(runFor(3));
  assert.deepEqual(out.counts.members.map(m => m.ordinal), [1, 2, 3]);
});

test('RD-MP-39 lenient reading: an EXIT decision may name an entry with no BUY decision (the warm-up case), but a second EXIT or BUY for one entry_ref still diverges', () => {
  const out = derive(runFor());
  const rejected = out.tables.decisions.rows.at(-1);
  assert.equal(rejected[3], 'EXIT');
  assert.equal(rejected[5], 'REJECTED');
  assert.equal(rejected[4], refOf(1, at(100)), 'no BUY decision exists for this entry_ref');
  diverges(edit(r => { r.result.holdout_decisions.push(clone(r.result.holdout_decisions[6])); r.result.holdout_decisions.at(-1).time = at(4500); settle(r); }), /second EXIT decision/);
});
