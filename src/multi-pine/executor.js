import {canonical, hash} from '../pine-bridge/source.js';
import {D} from '../money.js';
import {contentDigest} from '../quant-research/research-contract-v2.js';
import {coverage, screen, RULES} from '../quant-research/contract.js';
import {validateBar} from '../postgres/pine-bridge-market.js';
import {deploymentExitVersion} from '../pine-bridge/exit-version.js';
import {BOT_ROWS, DEPLOYMENT_ROWS, EVIDENCE_ROWS, JOB_ROWS} from '../postgres/mp-member-set-store.js';
import {appendRunEvent, getMultiRun} from '../postgres/mp-run-store.js';
import {decideFreeze, memberSetFreshness} from './member-set.js';
import {planFromContract, assertEvaluationBudget, gridValues, PLAN_CODES} from './candidate-plan.js';
import {runCombinedOracle, compareCombined, BASELINE_VERSION} from './combined-oracle.js';
import {MP_COMBINED_CLOSURE_VERSION} from './engine-closure.js';
import {MP_CODES, MP_COMBINED_EVALUATOR, MP_SAME_BAR_ORDER} from './codes.js';

/*
 * F11 S3: the multi-Pine fixture executor (docs/MULTI_PINE_CONTRACT.md RD-MP-29 to RD-MP-32, root rulings R-10 to R-17).
 * MultiPineFixtureExecutor.execute({owner_id, run_id, signal?}) runs ONE admitted run of the internal run store to a terminal event; sweep({owner_id, run_id}) ends
 * a RUNNING run past its deadline. It is called only by tests and the operator script (scripts/mp-fixture-run.mjs) on an isolated cluster with a FIXTURE-role
 * handle. No route, worker, runtime root, background loop, checkpoint, step table or lease exists: the RUNNING append (the transition guard of the run store) is
 * the only mutual exclusion, and a crashed run stays RUNNING until `sweep` ends it after its deadline.
 *
 * Configuration (constructor, never request input): db (fixture role), store (a Store on THE SAME db), readBotState({bot_id}) (storeBotState over that store),
 * clock() in epoch ms, runEvaluator(payload, {signal, timeoutMs}) (src/multi-pine/python-runner.js, or a test double), engineHash (a function that answers the
 * CURRENT closure hash, or a fixed 64-hex string), callTimeoutMs (at most 30000).
 *
 * execute, in order:
 *   1. getMultiRun (every stored row is re-checked). Only ADMITTED proceeds; any other status returns without writing.
 *   2. gate: abort, deadline (TIMED_OUT JOB_DEADLINE_EXCEEDED), engine hash (FAILED QUANT_ENGINE_CHANGED), member-set freshness (FAILED MP_MEMBER_SET_STALE).
 *      The gate runs before the claim, before every step and before the terminal append, and then also re-reads the last event: when it is no longer RUNNING
 *      (an operator ended the run) the executor stops without writing.
 *   3. claim: append RUNNING. A refused transition means another executor won; this one returns CLAIM_LOST and writes nothing else.
 *   4. materialise, read only: member sources and deployment snapshots (hash bound), the Bot policy (hash bound), the bars of pine_market_bars (row checks and the
 *      ordered content digest of the contract), the plan (candidate-plan.js), the evaluation cap planned + 9.
 *   5. one Python process per step: CANDIDATE steps, SENSITIVITY and STRESS of the selected pair, one HOLDOUT (selection, screen against row 0, 100% coverage and
 *      the frozen rules follow QuantResearchWorker.run). MP_MEMBER_NO_SIGNALS after the first CANDIDATE step. Rows 0..validation_end go to every step except
 *      HOLDOUT, which alone gets rows 0..test_end.
 *   6. after the HOLDOUT step, the Node oracle (combined-oracle.js) runs on the HOLDOUT step's bars, member signals, pair, model, policy, capital and ledger
 *      start. Its record `mp-combined-baseline-v1` is stored in the result as combined_baseline, bound to {run_id, contract_hash}; it NEVER changes the status or
 *      the completion reason. An oracle that throws leaves an unmatched record with the error code; the status still follows the search. The Python side of the
 *      comparison uses the final state the job sent in the HOLDOUT ledger (final_cash, position_quantity, position_cost, open_allocations; all four are required);
 *      the executor re-derives them from the FILLED decisions and records a disagreement as the difference job_final_state_vs_trace.
 *   7. the terminal result is validated, then appended: SUCCEEDED or NO_VALID_CANDIDATE with the result (at most 1 MiB, else FAILED EVALUATION_OUTPUT_TOO_LARGE).
 * A job error (any code), a cross_source_target or duplicate_intents counter that is not 0, a response with a wrong shape, type or sign: FAILED EVALUATION_FAILED. A
 * HOLDOUT response whose fill or decision counts disagree with its own ledger is not a run failure: the baseline stores HOLDOUT_LEDGER_INCONSISTENT as its error
 * (RD-MP-30) and the status follows the search. An abort ends the run CANCELLED RESEARCH_INTERRUPTED. owner_recommendation_ready is always false and MULTI_PINE_REQUIRES_APP_3B stays in acceptance_blockers.
 */

export const EXECUTOR_RESULT_VERSION = 'mp-combined-result-v1';
export const STEP_VERSION = 'mp-combined-step-v1';
export const REQUEST_VERSION = 'mp-combined-request-v1';
export const MAX_RESULT_BYTES = 1048576;
export const MAX_CALL_TIMEOUT_MS = 30000;
export const EXECUTOR_REASONS = Object.freeze({
  DEADLINE: 'JOB_DEADLINE_EXCEEDED', ENGINE_CHANGED: 'QUANT_ENGINE_CHANGED', STALE: MP_CODES.MEMBER_SET_STALE, NO_SIGNALS: MP_CODES.MEMBER_NO_SIGNALS,
  FAILED: 'EVALUATION_FAILED', TOO_LARGE: 'EVALUATION_OUTPUT_TOO_LARGE', INTERRUPTED: 'RESEARCH_INTERRUPTED'
});
/** Reason codes a failure may carry; every other error code (a job code such as MP_CROSS_SOURCE_TARGET included) is stored as EVALUATION_FAILED. */
const REASON_ALLOWLIST = new Set([
  'QUANT_ENGINE_CHANGED', 'JOB_DEADLINE_EXCEEDED', MP_CODES.MEMBER_SET_STALE, MP_CODES.MEMBER_NO_SIGNALS, 'EVALUATION_FAILED', 'EVALUATION_OUTPUT_TOO_LARGE',
  'EVALUATION_TIMED_OUT', 'INVALID_EVALUATION_RESPONSE', 'QUANT_PYTHON_UNAVAILABLE', 'RESEARCH_REQUEST_TOO_LARGE', PLAN_CODES.INSUFFICIENT_DIMENSION_BUDGET,
  PLAN_CODES.EVALUATION_BUDGET_EXCEEDED, PLAN_CODES.INVALID_PLAN_INPUT, 'VERIFIED_MARKET_DATA_REQUIRED', 'MARKET_METADATA_MISMATCH',
  'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET', 'RESEARCH_DATASET_CHANGED'
]);

/**
 * The error codes the Python job may print (quant_lab/src/robot_quant/mp_combined_job.py: library codes, source-gate codes and its own). A job error with one of these
 * codes is a recorded outcome (FAILED EVALUATION_FAILED); any other error is a defect of the executor, the runner or the system and is rethrown after a best-effort
 * FAILED event. test/postgres/mp-executor.test.mjs compares this list with the job's own code sets.
 */
export const JOB_CODES = Object.freeze(['MP_INPUT_INVALID', 'MP_SOURCE_SLOTS_FORBIDDEN', 'MP_MEMBER_DUPLICATE_LOGIC', 'EVALUATION_OUTPUT_TOO_LARGE', 'EVALUATION_FAILED',
  'MP_EVENT_ORDER_UNDEFINED', 'MP_CROSS_SOURCE_TARGET', 'UNSUPPORTED_SOURCE_HASH', 'UNSUPPORTED_CUSTOM_MARKET', 'UNSUPPORTED_CUSTOM_SLOT_COUNT', 'DUPLICATE_CUSTOM_INPUT_IDENTITY',
  'MISSING_SOURCE_MEMBERSHIP', 'CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED', 'SOURCE_INPUT_IDENTITY_MISMATCH', 'CUSTOM_EFFECTIVE_INPUT_CHANGED', 'UNSUPPORTED_CUSTOM_BINDING',
  'INVALID_CUSTOM_SLOT_DOMAIN', 'DUPLICATE_CUSTOM_BINDING', 'UNSUPPORTED_CUSTOM_SETTING', 'UNSUPPORTED_SIGNAL_MAPPING', 'INVALID_CUSTOM_SEARCH_DOMAIN']);
const JOB_CODE_SET = new Set(JOB_CODES);

const HEX64 = /^[0-9a-f]{64}$/;
/** Closed shapes of a job response (every key is checked in both directions; an extra key is a defect, never data to store). */
const METRIC_KEYS = ['bars', 'closed_trades', 'end_equity', 'gross_loss', 'gross_profit', 'max_drawdown_percent', 'net_return_percent', 'profit_factor', 'start_equity'];
const RESPONSE_KEYS = ['closure', 'decision_count', 'diagnostics', 'evaluator', 'exit_fill_reasons', 'fills', 'kind', 'ledger_hash', 'member_signals', 'owner_recommendation_ready', 'pair',
  'rejections', 'run', 'same_bar_order', 'train', 'validation', 'version'];
const DIAGNOSTIC_KEYS = ['bot', 'cross_source_target', 'duplicate_intents', 'members', 'same_bar_order', 'version'];
const FUNNEL_KEYS = ['accepted', 'capped', 'exit_fills', 'intents_buy', 'intents_exit', 'native_buy', 'native_exit', 'pre_start_intents', 'rejected', 'skipped_buys', 'suppressed_buys'];
const MEMBER_FUNNEL_KEYS = [...FUNNEL_KEYS, 'deployment_id', 'ordinal'];
const SIGNAL_ROW_KEYS = ['deployment_id', 'native_buy', 'native_exit', 'ordinal', 'segments', 'signals_hash'];
/** The HOLDOUT ledger of a job response has exactly these six keys: the trace plus the four final-state fields copied from the Python replay ledger. */
const LEDGER_KEYS = ['decisions', 'events', 'final_cash', 'open_allocations', 'position_cost', 'position_quantity'];
/** The three final-state fields that are decimal strings (open_allocations is a non-negative integer). */
const LEDGER_DECIMAL_KEYS = ['final_cash', 'position_cost', 'position_quantity'];
const EVENT_KEYS = ['entry_ref', 'event_type', 'reason', 'sequence', 'sl', 'time', 'tp'];
const FILLED_KEYS = ['cash', 'cost', 'entry_ref', 'event_type', 'fee', 'notional', 'outcome', 'price', 'quantity', 'realized_r', 'reason', 'sequence', 'sizing_adjustment', 'sizing_outcome', 'sl', 'time', 'tp'];
const REJECTED_KEYS = ['entry_ref', 'event_type', 'fee', 'outcome', 'quantity', 'reason', 'sequence', 'sl', 'time', 'tp'];
/** The sixteen node_policy keys the job and the oracle take (quant_lab bridge_paper.node_policy). The Bot policy may carry more keys (paperTrading, ...); only these go out. */
export const NODE_POLICY_KEYS = Object.freeze(['killSwitch', 'maxSignalAgeSeconds', 'maxTradesPerDay', 'maxDailyLossR', 'pauseAfterLossStreak', 'blockHighVolatility', 'maxVolatilityPercent',
  'blockDuringNews', 'allowedSymbols', 'sideMode', 'maxOpenPositions', 'onePositionPerSymbol', 'capPercentEquitySize', 'maxRiskPercent', 'maxOrderNotional', 'maxDailyNotional']);
const MINUTE = 60_000;
const PAGE = 1000;
const SOURCE_ROWS = `SELECT r.pine_import_id,r.source_version,r.source,r.source_hash,r.analysis,s.owner_id,s.bot_id FROM public.pine_source_revisions r
  JOIN public.pine_sources s ON s.pine_import_id=r.pine_import_id WHERE s.owner_id=$1 AND s.bot_id=$2 AND r.pine_import_id=ANY($3::text[]) ORDER BY r.pine_import_id,r.source_version`;
const SET_ROW = 'SELECT record FROM public.mp_member_sets WHERE member_set_id=$1 AND owner_id=$2 AND bot_id=$3';
const LAST_EVENT = 'SELECT status FROM public.mp_research_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1';
const BAR_PAGE = `SELECT bar_time,bar,provenance,content_hash FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'
  AND bar_time>$1 AND bar_time<=$2 ORDER BY bar_time LIMIT ${PAGE}`;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), {code});
const decimalText = value => D(value).toFixed();

/** Thrown inside a run to end it with a terminal event. */
class Stop extends Error {
  constructor(status, reason_code) { super(reason_code); this.status = status; this.reason_code = reason_code; }
}
/** Thrown when the run is no longer ours (an operator or another executor ended it): nothing is written. */
class Released extends Error {
  constructor(status) { super('RELEASED'); this.status = status; }
}

/** An object with exactly these keys. */
const closed = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** A map from a short text key to a count (rejection reasons, exit fill reasons). */
const countMap = value => isObject(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, count]) => key.length >= 1 && key.length <= 120 && countOk(count));

function metricsOk(metrics) {
  if (!closed(metrics, METRIC_KEYS) || !Number.isSafeInteger(metrics.closed_trades) || metrics.closed_trades < 0) return false;
  for (const key of ['net_return_percent', 'max_drawdown_percent']) {
    if (!['string', 'number'].includes(typeof metrics[key])) return false;
    try {
      const value = D(metrics[key]);
      if (!value.isFinite() || (key === 'max_drawdown_percent' && value.lt(0))) return false;
    } catch { return false; }
  }
  return true;
}
const countOk = value => Number.isSafeInteger(value) && value >= 0;
/** A decimal text the money helper accepts (a string only, never a number): '0E-18' style engine output included. */
function decimalStringOk(value) {
  if (typeof value !== 'string') return false;
  try { return D(value).isFinite(); } catch { return false; }
}

/** The check of one step response against its request (the worker's INVALID_EVALUATION_RESPONSE checks, plus the multi-only counters). Throws EVALUATION_FAILED. */
function checkStep(request, response, members, split) {
  const kind = request.step.kind, holdout = kind === 'HOLDOUT';
  const bad = () => { throw fail(EXECUTOR_REASONS.FAILED); };
  if (!isObject(response) || response.version !== STEP_VERSION || response.evaluator !== MP_COMBINED_EVALUATOR || response.closure !== MP_COMBINED_CLOSURE_VERSION) bad();
  if (canonical(response.run) !== canonical(request.run) || response.kind !== kind || canonical(response.pair) !== canonical(request.step.pair) || response.same_bar_order !== MP_SAME_BAR_ORDER) bad();
  if (response.owner_recommendation_ready !== false || !metricsOk(response.train) || !metricsOk(response.validation)) bad();
  if (!countOk(response.decision_count) || !countOk(response.fills) || typeof response.ledger_hash !== 'string' || !HEX64.test(response.ledger_hash)) bad();
  if (!countMap(response.rejections) || !countMap(response.exit_fill_reasons)) bad();
  // The holdout stays in the HOLDOUT step: no other response carries test metrics, a ledger trace or a signal vector. The key set is closed in both directions.
  if (!closed(response, holdout ? [...RESPONSE_KEYS, 'ledger', 'test'] : RESPONSE_KEYS)) bad();
  if (holdout) {
    const {ledger} = response;
    if (!metricsOk(response.test) || !closed(ledger, LEDGER_KEYS) || !Array.isArray(ledger.events) || !Array.isArray(ledger.decisions)) bad();
    if (!LEDGER_DECIMAL_KEYS.every(key => decimalStringOk(ledger[key])) || !countOk(ledger.open_allocations)) bad();
    // F4: the final state is never negative. '-0' parses to zero, which is not less than zero, so it is accepted as zero (D('-0').lt(0) is false).
    if (LEDGER_DECIMAL_KEYS.some(key => D(ledger[key]).lt(0))) bad();
    if (!ledger.events.every(event => closed(event, EVENT_KEYS))) bad();
    if (!ledger.decisions.every(decision => closed(decision, decision?.outcome === 'FILLED' ? FILLED_KEYS : decision?.outcome === 'REJECTED' ? REJECTED_KEYS : []))) bad();
    // F3: the executor derives the final state from the FILLED decisions, so their typed fields are checked before any arithmetic.
    if (!ledger.decisions.filter(decision => decision.outcome === 'FILLED').every(fill => ['quantity', 'cash', 'cost'].every(key => decimalStringOk(fill[key]))
      && typeof fill.entry_ref === 'string' && ['BUY', 'EXIT'].includes(fill.event_type))) bad();
  }
  const diagnostics = response.diagnostics;
  if (!closed(diagnostics, DIAGNOSTIC_KEYS) || diagnostics.same_bar_order !== MP_SAME_BAR_ORDER || !Array.isArray(diagnostics.members) || diagnostics.members.length !== members.length) bad();
  const funnelOk = (row, keys) => closed(row, keys) && FUNNEL_KEYS.filter(key => !['exit_fills', 'rejected'].includes(key)).every(key => countOk(row[key])) && countMap(row.exit_fills) && countMap(row.rejected);
  if (!funnelOk(diagnostics.bot, FUNNEL_KEYS) || !diagnostics.members.every((row, index) => funnelOk(row, MEMBER_FUNNEL_KEYS) && row.ordinal === members[index].ordinal && row.deployment_id === members[index].deployment_id)) bad();
  // MP_CROSS_SOURCE_TARGET and a repeated intent are defects of the evaluator, never a research outcome (RD-MP-25).
  if (diagnostics.cross_source_target !== 0 || diagnostics.duplicate_intents !== 0) bad();
  if (!Array.isArray(response.member_signals) || response.member_signals.length !== members.length) bad();
  response.member_signals.forEach((row, index) => {
    const segmentNames = holdout ? ['test', 'train', 'validation'] : ['train', 'validation'];
    if (!closed(row, holdout ? [...SIGNAL_ROW_KEYS, 'signals'] : SIGNAL_ROW_KEYS) || row.ordinal !== members[index].ordinal || row.deployment_id !== members[index].deployment_id
      || typeof row.signals_hash !== 'string' || !HEX64.test(row.signals_hash) || !countOk(row.native_buy) || !countOk(row.native_exit)
      || !closed(row.segments, segmentNames) || !segmentNames.every(name => closed(row.segments[name], ['buy', 'exit']) && countOk(row.segments[name].buy) && countOk(row.segments[name].exit))) bad();
    if (holdout) {
      const {buy, native_exit} = row.signals ?? {};
      if (!Array.isArray(buy) || !Array.isArray(native_exit) || buy.length !== split.test_end || native_exit.length !== split.test_end
        || ![...buy, ...native_exit].every(value => typeof value === 'boolean')) bad();
    }
  });
}

/** Per-candidate record kept in the result: metrics and counts only, no trace. */
const brief = response => ({train: response.train, validation: response.validation, decision_count: response.decision_count, fills: response.fills,
  rejections: response.rejections, exit_fill_reasons: response.exit_fill_reasons, ledger_hash: response.ledger_hash});

/** The names of the final-state fields in which the job values differ from the values derived from the FILLED decisions (decimals compare by value: '0E-18' equals '0'). */
const FINAL_FIELDS = ['final_cash', 'position_quantity', 'position_cost', 'open_allocations'];

/**
 * The Python-side view of a HOLDOUT ledger for compareCombined. The trace is the job's own ledger; the final state is the one the JOB supplied (final_cash,
 * position_quantity, position_cost, open_allocations of the Python replay ledger). The executor still derives the same four values from the FILLED decisions as a
 * cross-check: `mismatched` names every field in which the derivation differs from the job value (RD-MP-30: that is a baseline difference, never a run status).
 */
function pythonLedger(response, startCash) {
  const {events, decisions, final_cash, position_quantity, position_cost, open_allocations} = response.ledger;
  const fills = decisions.filter(decision => isObject(decision) && decision.outcome === 'FILLED');
  if (fills.length !== response.fills || decisions.length !== response.decision_count) throw fail('HOLDOUT_LEDGER_INCONSISTENT');
  const last = fills.at(-1);
  let quantity = D(0);
  const open = new Set();
  for (const fill of fills) {
    if (fill.event_type === 'BUY') { quantity = quantity.plus(D(fill.quantity)); open.add(fill.entry_ref); }
    else { quantity = quantity.minus(D(fill.quantity)); open.delete(fill.entry_ref); }
  }
  const job = {final_cash, position_quantity, position_cost, open_allocations};
  const derived = {final_cash: last ? last.cash : startCash, position_quantity: quantity.toFixed(), position_cost: last ? last.cost : '0', open_allocations: open.size};
  const same = key => {
    if (key === 'open_allocations') return job[key] === derived[key];
    try { return D(job[key]).eq(D(derived[key])); } catch { return false; }
  };
  return {python: {ledger: {events, decisions, fills, ...job}, diagnostics: response.diagnostics}, mismatched: FINAL_FIELDS.filter(key => !same(key))};
}

/** Validation of the terminal result before it is written (RD-MP-32). Throws EVALUATION_FAILED. */
export function validateTerminalResult(result, run) {
  const bad = () => { throw fail(EXECUTOR_REASONS.FAILED); };
  if (!isObject(result) || result.version !== EXECUTOR_RESULT_VERSION || result.run_id !== run.run_id || result.contract_hash !== run.contract_hash) bad();
  if (result.owner_recommendation_ready !== false || canonical(result.acceptance_blockers) !== canonical(run.contract.acceptance_blockers)) bad();
  if (!result.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B') || result.evaluator !== MP_COMBINED_EVALUATOR || result.fixture !== true || result.engine_hash !== run.contract.engine_hash) bad();
  if (!isObject(result.closure) || result.closure.version !== MP_COMBINED_CLOSURE_VERSION || result.closure.hash !== run.contract.engine_hash) bad();
  if (!isObject(result.search) || !Array.isArray(result.candidates) || result.candidates.length !== result.search.planned) bad();
  if (typeof result.holdout_evaluated !== 'boolean' || typeof result.completion_reason !== 'string') bad();
  if (result.holdout_evaluated) {
    const baseline = result.combined_baseline;
    if (!isObject(result.selected) || !isObject(result.selected.test) || !Array.isArray(result.holdout_decisions)) bad();
    if (!isObject(baseline) || baseline.version !== BASELINE_VERSION || typeof baseline.matched !== 'boolean') bad();
    if (canonical(baseline.binding) !== canonical({run_id: run.run_id, contract_hash: run.contract_hash}) || canonical(baseline.pair) !== canonical(result.selected.parameters)) bad();
  } else if (result.combined_baseline !== null || Object.hasOwn(result, 'holdout_decisions') || (result.selected !== null && Object.hasOwn(result.selected, 'test'))) bad();
  return result;
}

/**
 * Operator guard (scripts/mp-fixture-run.mjs): is the connected role the FIXTURE role of scripts/grant-postgres-mp-fixture.sql? True only when the role is not
 * privileged (superuser, bypass-RLS, create-role, create-db, replication), does not own a run-store table, holds SELECT and INSERT on the run and event tables,
 * holds no UPDATE, DELETE or TRUNCATE on them, and the run-store marker exists. Returns {fixture_role, ...facts}; a cluster without the run store throws.
 */
export async function readFixtureRole(db) {
  const facts = (await db.query(`SELECT current_user AS role,
    (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication FROM pg_roles WHERE rolname=current_user) AS privileged,
    to_regclass('public.mp_run_store_schema') IS NOT NULL AS marker,
    COALESCE((SELECT bool_and(has_table_privilege(t,'SELECT') AND has_table_privilege(t,'INSERT')) FROM unnest(ARRAY['public.mp_research_runs','public.mp_research_run_events']::regclass[]) AS t),false) AS can_write,
    COALESCE((SELECT bool_or(has_table_privilege(t,'UPDATE') OR has_table_privilege(t,'DELETE') OR has_table_privilege(t,'TRUNCATE')) FROM unnest(ARRAY['public.mp_research_runs','public.mp_research_run_events']::regclass[]) AS t),true) AS can_edit,
    COALESCE((SELECT bool_or(pg_has_role(current_user,c.relowner,'MEMBER')) FROM pg_class c WHERE c.oid IN ('public.mp_research_runs'::regclass,'public.mp_research_run_events'::regclass)),true) AS owns`)).rows[0];
  return {...facts, fixture_role: !facts.privileged && facts.marker && facts.can_write && !facts.can_edit && !facts.owns};
}

export class MultiPineFixtureExecutor {
  #db; #store; #readBotState; #clock; #runEvaluator; #engineHash; #callTimeoutMs;

  constructor({db, store, readBotState, clock = Date.now, runEvaluator, engineHash, callTimeoutMs = MAX_CALL_TIMEOUT_MS} = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.transaction !== 'function') throw new TypeError('MultiPineFixtureExecutor: db is required');
    if (!store || store.db !== db) throw new TypeError('MultiPineFixtureExecutor: store must be a Store on the same db');
    if (typeof readBotState !== 'function') throw new TypeError('MultiPineFixtureExecutor: readBotState is required');
    if (typeof clock !== 'function') throw new TypeError('MultiPineFixtureExecutor: clock must be a function');
    if (typeof runEvaluator !== 'function') throw new TypeError('MultiPineFixtureExecutor: runEvaluator is required');
    if (typeof engineHash !== 'function' && !(typeof engineHash === 'string' && HEX64.test(engineHash))) throw new TypeError('MultiPineFixtureExecutor: engineHash must be a function or 64 hex characters');
    if (!Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > MAX_CALL_TIMEOUT_MS) throw new TypeError('MultiPineFixtureExecutor: callTimeoutMs must be 1 to 30000');
    this.#db = db; this.#store = store; this.#readBotState = readBotState; this.#clock = clock; this.#runEvaluator = runEvaluator;
    this.#engineHash = engineHash; this.#callTimeoutMs = callTimeoutMs;
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 1) throw new TypeError('MultiPineFixtureExecutor: clock must return epoch milliseconds');
    return now;
  }

  /** The status of the newest event of the run, or null when it has none. */
  async #lastStatus(view) { return (await this.#db.query(LAST_EVENT, [view.run.run_id])).rows[0]?.status ?? null; }

  async #currentEngine() { return typeof this.#engineHash === 'function' ? this.#engineHash() : this.#engineHash; }

  /* ---------- reads ---------- */

  /** One consistent snapshot of the rows the freshness check and the job input need (REPEATABLE READ, SET TRANSACTION READ ONLY). */
  async #readWorld(view, set) {
    const {owner_id, bot_id} = view.run;
    const ids = set.members.map(member => member.deployment_id), imports = set.members.map(member => member.pine_import_id);
    return this.#db.transaction(async () => {
      // db.transaction has no read-only option; the first statement of the transaction makes it read only (the Bot-state reader runs inside it too).
      await this.#db.query('SET TRANSACTION READ ONLY');
      const memberships = (await this.#db.query(BOT_ROWS, [owner_id, bot_id])).rows;
      const rows = (await this.#db.query(DEPLOYMENT_ROWS, [owner_id, bot_id, ids])).rows;
      const jobs = new Map();
      if (rows.length > 0) for (const row of (await this.#db.query(JOB_ROWS, [owner_id, bot_id, rows.map(item => item.deployment_id)])).rows) jobs.set(row.deployment_id, [...(jobs.get(row.deployment_id) ?? []), row.artifact]);
      const deployments = rows.map(row => {
        const found = jobs.get(row.deployment_id) ?? [];
        const derived = found.length === 1 ? deploymentExitVersion(found[0], row.snapshot, row.deployment_id) : null;
        return derived?.ok === true ? {...row, exit_version: derived.exit_version} : row;
      });
      const evidence = (await this.#db.query(EVIDENCE_ROWS, [ids])).rows;
      const sources = (await this.#db.query(SOURCE_ROWS, [owner_id, bot_id, imports])).rows;
      const bot_state = await this.#readBotState({bot_id});
      return {memberships, deployments, evidence, sources, bot_state};
    }, {isolation: 'REPEATABLE READ'});
  }

  async #readSet(view) {
    const {owner_id, bot_id, member_set_id} = view.run;
    const row = (await this.#db.query(SET_ROW, [member_set_id, owner_id, bot_id])).rows[0];
    const decided = row ? decideFreeze(row.record, []) : null;
    if (!decided?.ok || decided.member_set.set_hash !== view.run.set_hash) throw new Stop('FAILED', EXECUTOR_REASONS.STALE);
    return decided.member_set;
  }

  /** abort, deadline, engine hash, member-set freshness, then (when claimed) the last event. Throws Stop or Released; returns the world rows. */
  async #gate(view, set, signal, claimed) {
    if (signal?.aborted) throw new Stop('CANCELLED', EXECUTOR_REASONS.INTERRUPTED);
    if (this.#now() >= view.run.deadline_ms) throw new Stop('TIMED_OUT', EXECUTOR_REASONS.DEADLINE);
    if (await this.#currentEngine() !== view.run.contract.engine_hash) throw new Stop('FAILED', EXECUTOR_REASONS.ENGINE_CHANGED);
    const world = await this.#readWorld(view, set);
    const fresh = memberSetFreshness(set, {owner_id: view.run.owner_id, bot_id: view.run.bot_id, bot_state: world.bot_state, memberships: world.memberships, deployments: world.deployments, evidence: world.evidence});
    if (!fresh.ok || !fresh.fresh) throw new Stop('FAILED', EXECUTOR_REASONS.STALE);
    if (claimed) {
      const last = await this.#lastStatus(view);
      if (last !== 'RUNNING') throw new Released(last ?? 'UNKNOWN');
    }
    return world;
  }

  /* ---------- materialisation ---------- */

  /** The job members, every hash bound in Node: the source bytes, the effective inputs and the deployment snapshot of the frozen set. */
  #members(view, set, world) {
    const contract = view.run.contract;
    return set.members.map((frozen, index) => {
      const contractMember = contract.members[index];
      const source = world.sources.find(row => row.pine_import_id === frozen.pine_import_id && row.source_version === frozen.source_version);
      const deployment = world.deployments.find(row => row.deployment_id === frozen.deployment_id);
      if (!source || !deployment || canonical(contractMember) !== canonical(frozen)
        || typeof source.source !== 'string' || hash(source.source) !== frozen.source_hash || source.source_hash !== frozen.source_hash
        || source.analysis?.effective_inputs_hash !== frozen.effective_inputs_hash
        || deployment.snapshot_hash !== frozen.deployment_snapshot_hash || hash(canonical(deployment.snapshot)) !== deployment.snapshot_hash) throw new Stop('FAILED', EXECUTOR_REASONS.STALE);
      return {ordinal: frozen.ordinal, deployment_id: frozen.deployment_id, pine_import_id: frozen.pine_import_id, source_version: frozen.source_version, source_hash: frozen.source_hash,
        effective_inputs_hash: frozen.effective_inputs_hash, source: source.source, snapshot: deployment.snapshot};
    });
  }

  /** The verified bars of the contract range, in the job's row shape. Checks every row, the count and the ordered content digest. */
  async #readBars(contract) {
    const {dataset, model} = contract;
    const rows = [];
    let after = dataset.start_time - 1;
    while (rows.length < dataset.bar_count) {
      const page = (await this.#db.query(BAR_PAGE, [after, dataset.end_time])).rows;
      if (page.length === 0) break;
      for (const row of page) {
        const time = Number(row.bar_time);
        if (time !== dataset.start_time + rows.length * MINUTE || row.bar?.time !== time || row.provenance?.profile !== model.data_profile || hash(canonical(row.bar)) !== row.content_hash)
          throw new Stop('FAILED', 'VERIFIED_MARKET_DATA_REQUIRED');
        try { validateBar(row.bar); } catch { throw new Stop('FAILED', 'VERIFIED_MARKET_DATA_REQUIRED'); }
        if (!D(row.bar.price_tick).eq(model.price_tick) || !D(row.bar.quantity_step).eq(model.quantity_step)) throw new Stop('FAILED', 'MARKET_METADATA_MISMATCH');
        rows.push({bar_time: time, content_hash: row.content_hash, bar: row.bar});
        if (rows.length > dataset.bar_count) break;
      }
      after = Number(page.at(-1).bar_time);
    }
    if (rows.length !== dataset.bar_count) throw new Stop('FAILED', 'INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET');
    if (contentDigest(rows) !== dataset.content_digest) throw new Stop('FAILED', 'RESEARCH_DATASET_CHANGED');
    return rows.map(({bar}) => ({time: bar.time, open: decimalText(bar.open), high: decimalText(bar.high), low: decimalText(bar.low), close: decimalText(bar.close),
      volume: decimalText(bar.volume), atr14: decimalText(bar.atr14)}));
  }

  /* ---------- terminal writes ---------- */

  async #append(view, input) {
    const out = await appendRunEvent(this.#db, {owner_id: view.run.owner_id, run_id: view.run.run_id, ...input});
    if (!out.ok) return out;
    return {ok: true, status: input.status, reason_code: input.reason_code ?? null, event: out.event};
  }

  /* ---------- execute ---------- */

  async execute({owner_id, run_id, signal} = {}) {
    const read = await getMultiRun(this.#db, {owner_id, run_id});
    if (!read.ok) return {ok: false, code: read.code, diagnostic: read.diagnostic};
    if (read.status !== 'ADMITTED') return {ok: true, action: 'SKIPPED', status: read.status};
    let claimed = false;
    try {
      const set = await this.#readSet(read);
      const world = await this.#gate(read, set, signal, false);
      const claim = await this.#append(read, {status: 'RUNNING'});
      if (!claim.ok) return {ok: true, action: 'CLAIM_LOST', status: 'UNKNOWN', diagnostic: claim.diagnostic};
      claimed = true;
      const outcome = await this.#run(read, set, world, signal);
      const written = await this.#finish(read, set, signal, outcome);
      return written;
    } catch (error) {
      if (error instanceof Released) return {ok: true, action: 'RELEASED', status: error.status};
      const stop = this.#stopOf(error);
      if (stop === null) {
        // An unexpected defect or a database failure: end a claimed run best effort, then let the caller see the error.
        if (claimed) { try { await this.#append(read, {status: 'FAILED', reason_code: EXECUTOR_REASONS.FAILED}); } catch { /* the run stays RUNNING until sweep */ } }
        throw error;
      }
      if (!claimed) {
        // Before the claim another executor may already own the run: a Stop, a coded error or an abort ends it only while it is still ADMITTED, else this executor lost.
        const last = await this.#lastStatus(read);
        if (last !== 'ADMITTED') return {ok: true, action: 'CLAIM_LOST', status: last ?? 'UNKNOWN'};
      }
      const written = await this.#append(read, {status: stop.status, reason_code: stop.reason_code});
      return written.ok ? {ok: true, action: 'TERMINAL', status: stop.status, reason_code: stop.reason_code} : {ok: true, action: claimed ? 'RELEASED' : 'CLAIM_LOST', status: 'UNKNOWN', diagnostic: written.diagnostic};
    }
  }

  /** The terminal event for an error, or null for a defect that must be rethrown. */
  #stopOf(error) {
    if (error instanceof Stop) return error;
    const code = error?.code;
    if (code === EXECUTOR_REASONS.INTERRUPTED) return new Stop('CANCELLED', EXECUTOR_REASONS.INTERRUPTED);
    // Only KNOWN codes are recorded outcomes: a reason code of this executor, the runner or the plan, or a code the Python job prints. Anything else (ENOENT,
    // ECONNRESET, a database code, an unknown job code, a TypeError) is a defect and is rethrown.
    if (typeof code === 'string' && REASON_ALLOWLIST.has(code)) return new Stop('FAILED', code);
    if (typeof code === 'string' && JOB_CODE_SET.has(code)) return new Stop('FAILED', EXECUTOR_REASONS.FAILED);
    return null;
  }

  /** The terminal append of a finished search: gate, validate, size, write. */
  async #finish(view, set, signal, outcome) {
    await this.#gate(view, set, signal, true);
    validateTerminalResult(outcome.result, view.run);
    if (Buffer.byteLength(canonical(outcome.result)) > MAX_RESULT_BYTES) throw new Stop('FAILED', EXECUTOR_REASONS.TOO_LARGE);
    const released = async () => { const last = await this.#lastStatus(view); return last === 'RUNNING' ? null : {ok: true, action: 'RELEASED', status: last ?? 'UNKNOWN'}; };
    const written = await this.#append(view, {status: outcome.status, result: outcome.result});
    if (written.ok) return {ok: true, action: 'TERMINAL', status: outcome.status, reason_code: null};
    // An operator ended the run between the gate and this append: the run is no longer ours.
    const gone = await released();
    if (gone) return gone;
    // The database refused the result (for example its stored size): the run still ends, as FAILED.
    const failed = await this.#append(view, {status: 'FAILED', reason_code: written.diagnostic?.field === 'storage' ? EXECUTOR_REASONS.TOO_LARGE : EXECUTOR_REASONS.FAILED});
    if (failed.ok) return {ok: true, action: 'TERMINAL', status: 'FAILED', reason_code: failed.reason_code};
    return (await released()) ?? {ok: false, code: failed.code, diagnostic: failed.diagnostic};
  }

  /* ---------- the search ---------- */

  async #run(view, set, firstWorld, signal) {
    const contract = view.run.contract;
    const split = contract.split;
    const plan = planFromContract(contract, set);
    const members = this.#members(view, set, firstWorld);
    const botPolicy = members[0].snapshot.policy;
    if (!isObject(botPolicy) || hash(canonical(botPolicy)) !== contract.policy_hash) throw new Stop('FAILED', EXECUTOR_REASONS.STALE);
    if (!NODE_POLICY_KEYS.every(key => Object.hasOwn(botPolicy, key))) throw fail(EXECUTOR_REASONS.FAILED);
    const policy = Object.fromEntries(NODE_POLICY_KEYS.map(key => [key, botPolicy[key]]));
    const rows = await this.#readBars(contract);
    const model = {version: contract.model.version, price_tick: decimalText(contract.model.price_tick), quantity_step: decimalText(contract.model.quantity_step),
      fee_bps: decimalText(contract.model.fee_bps), slippage_bps: decimalText(contract.model.slippage_bps), risk_percent: decimalText(contract.model.risk_percent)};
    const base = {
      version: REQUEST_VERSION, evaluator: MP_COMBINED_EVALUATOR, closure: MP_COMBINED_CLOSURE_VERSION,
      run: {run_id: view.run.run_id, contract_hash: view.run.contract_hash, engine_hash: contract.engine_hash, set_hash: contract.set_hash},
      market: {broker: set.market.broker, symbol: set.market.symbol, timeframe: set.market.timeframe}, model, policy,
      capital: {equity: contract.capital.equity, cash: contract.capital.cash}, split, first_time: contract.dataset.first_time, same_bar_order: MP_SAME_BAR_ORDER, members
    };
    const grids = Object.fromEntries(Object.entries(contract.bridge_domains).map(([name, domain]) => [name, gridValues(domain)]));
    const state = {started: 0, signature: null};
    const deadline = view.run.deadline_ms;

    const step = async (kind, parameters) => {
      await this.#gate(view, set, signal, true);
      assertEvaluationBudget(plan, state.started);
      state.started++;
      const request = {...base, rows: rows.slice(0, kind === 'HOLDOUT' ? split.test_end : split.validation_end), step: {kind, pair: {atr_multiplier: parameters.atr_multiplier, rr: parameters.rr}}};
      const timeoutMs = Math.max(1, Math.min(this.#callTimeoutMs, deadline - this.#now()));
      let response;
      try { response = await this.#runEvaluator(request, {signal, timeoutMs}); }
      catch (error) {
        // The call timeout is the time left to the deadline when that is shorter: a step cut there is the deadline, not an evaluator failure.
        if (error?.code === 'EVALUATION_TIMED_OUT' && this.#now() >= deadline) throw new Stop('TIMED_OUT', EXECUTOR_REASONS.DEADLINE);
        throw error;
      }
      checkStep(request, response, members, split);
      // F24: the member signal sets do not depend on the pair, so they are equal in every step of one run.
      const signature = canonical(response.member_signals.map(row => [row.ordinal, row.signals_hash, row.native_buy, row.native_exit]));
      if (state.signature === null) state.signature = signature;
      else if (state.signature !== signature) throw fail(EXECUTOR_REASONS.FAILED);
      return {request, response};
    };

    const results = [];
    for (let index = 0; index < plan.candidates.length; index++) {
      const parameters = plan.candidates[index];
      const {response} = await step('CANDIDATE', parameters);
      if (index === 0 && response.member_signals.some(row => row.native_buy === 0)) throw new Stop('FAILED', EXECUTOR_REASONS.NO_SIGNALS);
      results.push({index, parameters, response});
    }
    const covered = coverage(results, grids);
    const baselineReturn = results[0].response.validation.net_return_percent;
    const candidates = results.map(row => ({...row, screen_reasons: screen(row.response, baselineReturn)}));
    const eligible = candidates.filter(row => !row.screen_reasons.length).sort((a, b) =>
      D(b.response.validation.net_return_percent).cmp(D(a.response.validation.net_return_percent)) || D(a.response.validation.max_drawdown_percent).cmp(D(b.response.validation.max_drawdown_percent))
      || canonical(a.parameters).localeCompare(canonical(b.parameters)));
    const selected = eligible[0];
    const report = {
      version: EXECUTOR_RESULT_VERSION, run_id: view.run.run_id, contract_hash: view.run.contract_hash, owner_recommendation_ready: false,
      acceptance_blockers: [...contract.acceptance_blockers], evaluator: MP_COMBINED_EVALUATOR, engine_hash: contract.engine_hash,
      closure: {version: MP_COMBINED_CLOSURE_VERSION, hash: contract.engine_hash}, set_hash: contract.set_hash, same_bar_order: MP_SAME_BAR_ORDER, fixture: true,
      search: {algorithm: plan.algorithm, seed: plan.seed, budget: plan.requested_budget, planned: plan.planned_candidates, grid_combinations: plan.grid_combinations,
        max_evaluations: plan.max_evaluations, plan_hash: plan.plan_hash, ...covered},
      candidates: candidates.map(row => ({index: row.index, parameters: row.parameters, ...brief(row.response), screen_reasons: row.screen_reasons})),
      selected: null, holdout_evaluated: false, completion_reason: 'NO_VALID_TRAIN_VALIDATION_CANDIDATE',
      member_signals: results[0].response.member_signals.map(({signals, ...row}) => row), funnel: null, combined_baseline: null
    };
    if (!selected || covered.dimension_coverage_percent !== 100) return {status: 'NO_VALID_CANDIDATE', result: report};
    report.funnel = {step: 'CANDIDATE', rows: split.validation_end, diagnostics: selected.response.diagnostics};

    const errors = [], checks = [];
    for (const name of Object.keys(grids).sort()) {
      const grid = grids[name], at = grid.indexOf(selected.parameters[name]);
      for (const next of [at - 1, at + 1]) if (next >= 0 && next < grid.length) {
        const parameters = {...selected.parameters, [name]: grid[next]};
        const saved = results.find(row => canonical(row.parameters) === canonical(parameters));
        const response = saved?.response ?? (await step('SENSITIVITY', parameters)).response;
        checks.push({dimension: name, parameters, ...brief(response)});
        if (D(response.validation.net_return_percent).lt(D(selected.response.validation.net_return_percent).minus(RULES.sensitivity_max_drop_percentage_points))
          || response.validation.closed_trades < RULES.minimum_closed_trades_validation) errors.push('SENSITIVITY_FAILED');
      }
    }
    const stress = (await step('STRESS', selected.parameters)).response;
    if (D(stress.validation.net_return_percent).lt(0) || stress.validation.closed_trades < RULES.minimum_closed_trades_validation) errors.push('COST_STRESS_FAILED');
    report.selected = {index: selected.index, parameters: selected.parameters, ...brief(selected.response), sensitivity: checks, cost_stress: brief(stress), screen_reasons: errors};
    if (!errors.length) {
      const {request, response} = await step('HOLDOUT', selected.parameters);
      report.holdout_evaluated = true;
      report.selected.test = response.test;
      report.selected.holdout = {ledger_hash: response.ledger_hash, decision_count: response.decision_count, fills: response.fills};
      report.member_signals = response.member_signals.map(({signals, ...row}) => row);
      report.funnel = {step: 'HOLDOUT', rows: split.test_end, diagnostics: response.diagnostics};
      report.holdout_decisions = response.ledger.decisions;
      report.combined_baseline = this.#baseline(view, request, response);
      if (response.test.closed_trades < RULES.minimum_closed_trades_test) errors.push('INSUFFICIENT_TEST_TRADES');
      if (D(response.test.net_return_percent).lt(0)) errors.push('NEGATIVE_HOLDOUT_RETURN');
      if (D(response.test.max_drawdown_percent).gt(RULES.maximum_drawdown_percent)) errors.push('TEST_DRAWDOWN_EXCEEDED');
    }
    report.completion_reason = errors.length ? 'CANDIDATE_FAILED_CHECKS' : 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';
    return {status: errors.length ? 'NO_VALID_CANDIDATE' : 'SUCCEEDED', result: report};
  }

  /** RD-MP-30: the Node oracle on the HOLDOUT step's inputs. Never throws and never decides the run status. */
  #baseline(view, request, response) {
    const binding = {run_id: view.run.run_id, contract_hash: view.run.contract_hash};
    const pair = {atr_multiplier: request.step.pair.atr_multiplier, rr: request.step.pair.rr};
    let mismatched = [];
    try {
      const derived = pythonLedger(response, request.capital.cash);
      const python = derived.python;
      mismatched = derived.mismatched;
      const oracle = runCombinedOracle({
        members: request.members.map((member, index) => ({ordinal: member.ordinal, deployment_id: member.deployment_id, signals: response.member_signals[index].signals})),
        bars: request.rows.map(row => ({time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, atr14: row.atr14})),
        pair, model: request.model, policy: request.policy, equity: request.capital.equity, cash: request.capital.cash, broker: request.market.broker, symbol: request.market.symbol,
        start_time: request.rows[request.split.warmup].time, same_bar_order: request.same_bar_order, binding
      });
      const record = compareCombined(python, oracle);
      // The job's final state against the state derived from its own FILLED decisions: a disagreement is one named difference (job_final_state_vs_trace, one per field)
      // and an unmatched record. It adds a difference only; the run status still follows the search alone.
      if (mismatched.length === 0) return record;
      return {...record, matched: false, differences: {...record.differences, job_final_state_vs_trace: mismatched.length}, job_final_state_mismatch: mismatched};
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'ORACLE_FAILED';
      // F5: a job/derived final-state disagreement found before the failure stays on the error record.
      const extra = mismatched.length > 0 ? {job_final_state_mismatch: mismatched} : {};
      return {version: BASELINE_VERSION, binding, pair, same_bar_order: MP_SAME_BAR_ORDER, matched: false, error: code,
        differences: {oracle_error: 1, ...(mismatched.length > 0 ? {job_final_state_vs_trace: mismatched.length} : {})}, ...extra};
    }
  }

  /* ---------- sweep ---------- */

  /** A RUNNING run past its deadline ends TIMED_OUT JOB_DEADLINE_EXCEEDED. Any other run is left alone. */
  async sweep({owner_id, run_id} = {}) {
    const read = await getMultiRun(this.#db, {owner_id, run_id});
    if (!read.ok) return {ok: false, code: read.code, diagnostic: read.diagnostic};
    if (read.status !== 'RUNNING' || this.#now() < read.run.deadline_ms) return {ok: true, action: 'NONE', status: read.status};
    const written = await this.#append(read, {status: 'TIMED_OUT', reason_code: EXECUTOR_REASONS.DEADLINE});
    return written.ok ? {ok: true, action: 'TIMED_OUT', status: 'TIMED_OUT', reason_code: EXECUTOR_REASONS.DEADLINE} : {ok: true, action: 'NONE', status: 'UNKNOWN', diagnostic: written.diagnostic};
  }
}
