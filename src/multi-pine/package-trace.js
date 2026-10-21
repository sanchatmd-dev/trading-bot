import {canonical, hash} from '../pine-bridge/source.js';
import {D, amount} from '../money.js';
import {MULTI_PINE_CONTRACT_VERSION} from './codes.js';

/*
 * F11 R6-1: multi-Pine trace producer (docs/MULTI_PINE_CONTRACT.md RD-MP-39, the reading of PKG RC-17 for F11-01).
 *
 * Derives the three trace files of a multi-Pine package (equity.csv, trades.csv, decisions.csv) from the HOLDOUT decisions that the finished run stored in its terminal
 * result (RD-MP-34). That derivation is the recomputation RC-17 asks for. It never starts a second holdout evaluation. Pure: no database, file, network, clock, random
 * source or process state, and it imports neither the run store nor the executor. The caller passes the run view and the hash of the producer closure
 * (package-closure.js); this module reads nothing else.
 *
 * Before it derives anything it requires, with no tolerance:
 *   - the holdout was evaluated and the combined baseline matched, is bound to {run_id, contract_hash} and to the selected pair;
 *   - hash(canonical(holdout_decisions)) equals combined_baseline.received_decisions_hash (a Node identity of the decisions as received, never a parity verdict).
 * While it derives it requires:
 *   - every entry_ref prefix maps to exactly one contract member (the rule of the combined oracle: the key without its last two colon fields);
 *   - the decision count equals selected.holdout.decision_count, the FILLED count equals selected.holdout.fills, and the closed trades of the test partition equal
 *     selected.test.closed_trades;
 *   - each FILLED cash value follows from the previous cash value by notional and fee, in decimals, starting from the run's cash;
 *   - decision times never decrease and lie on the contract bars; an entry_ref has at most one BUY decision and at most one EXIT decision, and a FILLED EXIT closes
 *     a FILLED BUY of the same entry_ref and the same quantity.
 * Any difference throws TRACE_PRODUCER_DIVERGED and returns nothing.
 *
 * What the record claims, and what it does not: the CANDIDATE, SENSITIVITY and STRESS steps are NOT re-evaluated at build. steps_digest and holdout_digest are digests of
 * the stored selected steps, labelled as stored; the manifest limitation MP_TRACE_STEPS_NOT_REEVALUATED says so. Re-evaluation is deferred to APP-3B.
 */

/** Module refusal codes. They are not gate codes (the contract lists no producer code); TRACE_PRODUCER_DIVERGED is the one RD-MP-39 names. */
export const TRACE_PRODUCER_DIVERGED = 'TRACE_PRODUCER_DIVERGED';
export const TRACE_PRODUCER_INPUT_INVALID = 'TRACE_PRODUCER_INPUT_INVALID';
export const TRACE_PRODUCER_CODES = Object.freeze([TRACE_PRODUCER_DIVERGED, TRACE_PRODUCER_INPUT_INVALID]);
export const MP_TRACE_METHOD = 'stored-holdout-decisions-v1';
export const MP_TRACE_LIMITATION = 'MP_TRACE_STEPS_NOT_REEVALUATED';
export const MP_TRACE_PATHS = Object.freeze({equity: 'quant-data/equity.csv', trades: 'quant-data/trades.csv', decisions: 'quant-data/decisions.csv'});
/** Version of the combined baseline record this module accepts (the oracle comparison output). */
export const MP_BASELINE_VERSION = 'mp-combined-baseline-v1';
/** The one-Pine trace columns (src/quant-library/trace-reproduction.js TRACE_COLUMNS), plus the member tags of docs/MULTI_PINE_CONTRACT.md 6.2. A test pins the one-Pine prefix. */
export const MP_TRACE_COLUMNS = Object.freeze({
  equity: Object.freeze(['time_ms', 'time_utc', 'partition', 'event_type', 'cash', 'position_quantity', 'equity_at_fill', 'deployment_id']),
  trades: Object.freeze(['entry_ref', 'partition', 'entry_time_ms', 'entry_time_utc', 'entry_price', 'quantity', 'entry_fee', 'exit_time_ms', 'exit_time_utc', 'exit_price', 'exit_fee',
    'exit_reason', 'net', 'realized_r', 'deployment_id']),
  decisions: Object.freeze(['time_ms', 'time_utc', 'partition', 'event_type', 'entry_ref', 'outcome', 'reason', 'sizing_outcome', 'quantity', 'price', 'fee', 'deployment_id', 'ordinal'])
});

const MINUTE = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const PARTITIONS = Object.freeze(['train', 'validation', 'test']);
const COMPLETION_REASON = 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';

const refuse = (code, detail) => Object.assign(new Error(detail === undefined ? code : code + ': ' + detail), {code});
const diverged = detail => refuse(TRACE_PRODUCER_DIVERGED, detail);
const invalid = detail => refuse(TRACE_PRODUCER_INPUT_INVALID, detail);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length > 0;
const deepFreeze = value => { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };

/** Entry reference owner: `<deployment_id>:<bar time>:0` gives the deployment id, as the combined oracle derives it (the key without its last two colon fields). A test pins the equality. */
export function traceEntryOwner(entryRef) {
  if (typeof entryRef !== 'string') return null;
  const last = entryRef.lastIndexOf(':');
  if (last < 1) return null;
  const middle = entryRef.lastIndexOf(':', last - 1);
  return middle < 1 ? null : entryRef.slice(0, middle);
}

function digestOf(value) {
  try { return hash(canonical(value)); } catch { throw diverged('value cannot be hashed'); }
}
/** A decimal string the money module accepts, as the Python ledger prints it. */
function decimal(value, label) {
  if (typeof value !== 'string') throw diverged(label + ' is not a decimal string');
  try { return D(value); } catch { throw diverged(label + ' is not a decimal'); }
}
const timeMs = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;

/* ---- CSV (RFC 4180 with line feeds, the same cell rules as the one-Pine renderer) ---- */

function csvCell(value) {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw diverged('csv cell is not an integer'); return String(value); }
  if (typeof value !== 'string') throw diverged('csv cell type');
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}
/** Canonical CSV text of {columns, rows}: header, one line per row, a line feed after every line. */
export function traceCsv(table) {
  const {columns, rows} = table;
  return [columns.join(','), ...rows.map(row => {
    if (row.length !== columns.length) throw diverged('row width');
    return row.map(csvCell).join(',');
  })].join('\n') + '\n';
}

/* ---- inputs ---- */

function requireRun(run) {
  if (!isObject(run)) throw invalid('run');
  const {contract, result} = run;
  if (!isText(run.owner_id) || !isText(run.bot_id) || !isText(run.run_id) || !isObject(contract) || !isObject(result)) throw invalid('run owner_id, bot_id, run_id, contract and result');
  if (!HEX64.test(run.contract_hash ?? '')) throw invalid('run.contract_hash');
  if (contract.version !== MULTI_PINE_CONTRACT_VERSION || contract.fixture !== true || !Array.isArray(contract.members) || contract.members.length === 0
    || !contract.members.every(member => isObject(member) && isText(member.deployment_id) && Number.isSafeInteger(member.ordinal))) throw invalid('run.contract is not a multi-Pine contract');
  const dataset = contract.dataset, split = contract.split;
  if (!isObject(dataset) || !isObject(split) || !timeMs(dataset.start_time) || dataset.start_time % MINUTE !== 0
    || !['warmup', 'train_end', 'validation_end', 'test_end'].every(key => Number.isSafeInteger(split[key]))
    || !(0 < split.warmup && split.warmup < split.train_end && split.train_end < split.validation_end && split.validation_end < split.test_end)
    || dataset.bar_count !== split.test_end) throw invalid('run.contract dataset and split');
  if (!isObject(contract.capital) || typeof contract.capital.cash !== 'string') throw invalid('run.contract.capital.cash');
  if (!HEX64.test(contract.engine_hash ?? '')) throw invalid('run.contract.engine_hash');
  // Members are in ordinal order (ordinal n at index n - 1), as the contract validator and the renderer require; the output then never depends on input member order.
  if (!contract.members.every((member, index) => member.ordinal === index + 1)) throw invalid('run.contract.members must be in ordinal order, 1 to n');
  return {contract, result};
}

/** Everything the identity chain needs, in one place; every failure is a divergence. */
function requireResult(run, contract, result) {
  if (digestOf(contract) !== run.contract_hash) throw diverged('contract hash differs from the stored contract');
  if (result.run_id !== run.run_id || result.contract_hash !== run.contract_hash) throw diverged('result is not bound to the run');
  if (result.engine_hash !== contract.engine_hash || result.set_hash !== contract.set_hash || result.fixture !== true) throw diverged('result is not bound to the contract');
  if (result.holdout_evaluated !== true || result.completion_reason !== COMPLETION_REASON) throw diverged('holdout not evaluated or run not pending acceptance');
  const selected = result.selected;
  if (!isObject(selected) || !isObject(selected.parameters) || !isObject(selected.test) || !isObject(selected.holdout) || !isObject(selected.cost_stress) || !Array.isArray(selected.sensitivity))
    throw diverged('selected steps are incomplete');
  if (!Number.isSafeInteger(selected.holdout.decision_count) || !Number.isSafeInteger(selected.holdout.fills) || !Number.isSafeInteger(selected.test.closed_trades)) throw diverged('selected counts');
  const decisions = result.holdout_decisions;
  if (!Array.isArray(decisions) || !decisions.every(isObject)) throw diverged('holdout_decisions');
  const baseline = result.combined_baseline;
  if (!isObject(baseline) || baseline.version !== MP_BASELINE_VERSION) throw diverged('combined baseline missing');
  if (baseline.matched !== true) throw diverged('combined baseline did not match');
  if (!isObject(baseline.binding) || canonical(baseline.binding) !== canonical({run_id: run.run_id, contract_hash: run.contract_hash})) throw diverged('combined baseline is not bound to the run');
  if (!isObject(baseline.pair) || canonical(baseline.pair) !== canonical(selected.parameters)) throw diverged('combined baseline is not bound to the selected pair');
  if (baseline.received_decisions_hash !== digestOf(decisions)) throw diverged('decisions differ from the baseline identity hash');
  if (decisions.length !== selected.holdout.decision_count) throw diverged('decision count');
  return {selected, decisions};
}

/* ---- derivation ---- */

function memberOf(entryRef, byDeployment) {
  const owner = traceEntryOwner(entryRef);
  const member = owner === null ? undefined : byDeployment.get(owner);
  if (member === undefined) throw diverged('entry_ref prefix maps to no contract member');
  return member;
}

function derive(contract, selected, decisions) {
  const byDeployment = new Map();
  for (const member of contract.members) {
    if (byDeployment.has(member.deployment_id)) throw diverged('contract members share a deployment id');
    byDeployment.set(member.deployment_id, member);
  }
  const {start_time: start} = contract.dataset, split = contract.split;
  const edges = [start + split.warmup * MINUTE, start + split.train_end * MINUTE, start + split.validation_end * MINUTE];
  const last = start + (split.test_end - 1) * MINUTE;
  const partitionOf = time => {
    if (!timeMs(time) || time < edges[0] || time > last) throw diverged('time outside the contract bars');
    // The contract bars are contiguous minute bars from dataset.start_time; a decision time between two bars is not a bar close.
    if ((time - start) % MINUTE !== 0) throw diverged('time is not minute-aligned to the dataset start');
    return time < edges[1] ? 'train' : time < edges[2] ? 'validation' : 'test';
  };
  const isoOf = time => new Date(time).toISOString();

  const equity = [], trades = [], rows = [];
  const buys = new Map(), exits = new Set(), entries = new Map();
  const counts = new Map(contract.members.map(member => [member.deployment_id, {ordinal: member.ordinal, deployment_id: member.deployment_id, decisions: 0, fills: 0}]));
  const closed = {train: 0, validation: 0, test: 0};
  let cash = decimal(contract.capital.cash, 'capital.cash'), position = D(0), filled = 0, previousTime = -Infinity;

  for (const decision of decisions) {
    const member = memberOf(decision.entry_ref, byDeployment);
    if (!['BUY', 'EXIT'].includes(decision.event_type) || !['FILLED', 'REJECTED'].includes(decision.outcome)) throw diverged('decision event_type or outcome');
    const partition = partitionOf(decision.time);
    if (decision.time < previousTime) throw diverged('decision times decrease');
    previousTime = decision.time;
    const quantity = decimal(decision.quantity, 'quantity'), fee = decimal(decision.fee, 'fee');
    for (const key of ['reason', 'sizing_outcome']) if (decision[key] !== undefined && decision[key] !== null && typeof decision[key] !== 'string') throw diverged(key + ' type');
    if (decision.price !== undefined && decision.price !== null) decimal(decision.price, 'price');
    // Lenient reading, RD-MP-39: at most one BUY decision and at most one EXIT decision per entry_ref, and no more. An entry_ref may have an EXIT decision with no BUY
    // decision at all, because the entry can lie in the warm-up (RD-MP-39 warm-up case: Python skips intents before the warm-up end, so a REJECTED EXIT such as
    // TARGET_NOT_OPEN can name an entry that has no decision row). Only a FILLED EXIT must close a FILLED BUY of equal quantity (checked below).
    if (decision.event_type === 'BUY') { if (buys.has(decision.entry_ref)) throw diverged('second BUY decision for one entry_ref'); buys.set(decision.entry_ref, decision); }
    else { if (exits.has(decision.entry_ref)) throw diverged('second EXIT decision for one entry_ref'); exits.add(decision.entry_ref); }
    const tally = counts.get(member.deployment_id);
    tally.decisions++;
    const text = value => value === undefined || value === null ? null : value;
    rows.push([decision.time, isoOf(decision.time), partition, decision.event_type, decision.entry_ref, decision.outcome, text(decision.reason), text(decision.sizing_outcome),
      decision.quantity, text(decision.price), decision.fee, member.deployment_id, member.ordinal]);
    if (decision.outcome !== 'FILLED') continue;

    // FILLED: the cash identity, the position and the trade pairing.
    filled++;
    tally.fills++;
    const notional = decimal(decision.notional, 'notional'), recorded = decimal(decision.cash, 'cash'), price = decimal(decision.price, 'price');
    decimal(decision.realized_r, 'realized_r');
    if (quantity.lte(0) || price.lte(0) || notional.lt(0) || fee.lt(0)) throw diverged('FILLED amounts');
    let entry;
    if (decision.event_type === 'EXIT') {
      entry = entries.get(decision.entry_ref);
      if (entry === undefined) throw diverged('FILLED EXIT without a FILLED BUY');
      if (!decimal(entry.decision.quantity, 'quantity').eq(quantity) || typeof decision.reason !== 'string') throw diverged('EXIT quantity or reason');
    }
    const expected = decision.event_type === 'BUY' ? cash.minus(notional).minus(fee) : cash.plus(notional).minus(fee);
    if (!expected.eq(recorded)) throw diverged('cash does not follow from the previous cash');
    cash = recorded;
    if (decision.event_type === 'BUY') {
      position = position.plus(quantity);
      entries.set(decision.entry_ref, {decision, member});
    } else {
      entries.delete(decision.entry_ref);
      position = position.minus(quantity);
      if (position.lt(0)) throw diverged('position below zero');
      const net = notional.minus(fee).minus(decimal(entry.decision.notional, 'notional').plus(decimal(entry.decision.fee, 'fee')));
      closed[partition]++;
      trades.push([decision.entry_ref, partition, entry.decision.time, isoOf(entry.decision.time), entry.decision.price, entry.decision.quantity, entry.decision.fee,
        decision.time, isoOf(decision.time), decision.price, decision.fee, decision.reason, net.toFixed(), decision.realized_r, entry.member.deployment_id]);
    }
    equity.push([decision.time, isoOf(decision.time), partition, decision.event_type, decision.cash, amount(position), amount(recorded.plus(position.mul(price))), member.deployment_id]);
  }

  if (filled !== selected.holdout.fills) throw diverged('FILLED count');
  if (closed.test !== selected.test.closed_trades) throw diverged('closed trades of the test partition');
  return {
    tables: {equity: {columns: [...MP_TRACE_COLUMNS.equity], rows: equity}, trades: {columns: [...MP_TRACE_COLUMNS.trades], rows: trades},
      decisions: {columns: [...MP_TRACE_COLUMNS.decisions], rows}},
    counts: {decisions: decisions.length, fills: filled, closed_trades: {...closed}, open_entries: entries.size,
      members: [...counts.values()].sort((a, b) => a.ordinal - b.ordinal)}
  };
}

/**
 * deriveMultiTrace({run, producer_closure_hash}) -> frozen
 *   {tables:{equity,trades,decisions} as {columns, rows}, files:{path: csv text}, records:[per file], limitation_codes:[MP_TRACE_STEPS_NOT_REEVALUATED], counts}
 * run = {owner_id, bot_id, run_id, contract, contract_hash, result}: the durable run view of a SUCCEEDED run that is pending acceptance.
 * producer_closure_hash = the hash of package-closure.js for the code that is running (the caller computes it).
 * Throws one coded error (TRACE_PRODUCER_DIVERGED or TRACE_PRODUCER_INPUT_INVALID) and returns nothing on any difference.
 */
export function deriveMultiTrace({run, producer_closure_hash} = {}) {
  if (!HEX64.test(producer_closure_hash ?? '')) throw invalid('producer_closure_hash');
  const {contract, result} = requireRun(run);
  const {selected, decisions} = requireResult(run, contract, result);
  const derived = derive(contract, selected, decisions);
  const files = {};
  for (const name of ['equity', 'trades', 'decisions']) files[MP_TRACE_PATHS[name]] = traceCsv(derived.tables[name]);
  const decisionsHash = digestOf(decisions);
  // Stored, not re-evaluated: the selected candidate, sensitivity and stress steps, and the stored holdout step (RD-MP-39).
  const stepsDigest = digestOf({
    candidate: Object.fromEntries(['index', 'parameters', 'train', 'validation', 'decision_count', 'fills', 'rejections', 'exit_fill_reasons', 'ledger_hash']
      .filter(key => Object.hasOwn(selected, key)).map(key => [key, selected[key]])),
    sensitivity: selected.sensitivity, cost_stress: selected.cost_stress
  });
  const holdoutDigest = digestOf({test: selected.test, holdout: selected.holdout});
  const records = Object.values(MP_TRACE_PATHS).map(path => ({path, sha256: hash(files[path]), decisions_hash: decisionsHash, steps_digest: stepsDigest, holdout_digest: holdoutDigest,
    run_engine_hash: contract.engine_hash, producer_closure_hash, method: MP_TRACE_METHOD}));
  return deepFreeze({tables: derived.tables, files, records, limitation_codes: [MP_TRACE_LIMITATION], counts: derived.counts});
}
