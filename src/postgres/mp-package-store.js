import {randomUUID} from 'node:crypto';
import {canonical, hash} from '../pine-bridge/source.js';
import {deploymentExitVersion} from '../pine-bridge/exit-version.js';
import {D} from '../money.js';
import {contentDigest} from '../quant-research/research-contract-v2.js';
import {RULES} from '../quant-research/contract.js';
import {holdoutWindow, marketKey} from '../quant-library/derive.js';
import {searchedWindow, packageHash, bindingHash, CANDIDATE_BLOCKERS} from '../quant-library/package-gates.js';
import {decideFreeze, memberSetFreshness} from '../multi-pine/member-set.js';
import {renderMultiPackage, PACKAGE_MARKET} from '../multi-pine/package-render.js';
import {deriveMultiTrace, MP_TRACE_PATHS} from '../multi-pine/package-trace.js';
import {mpPackageTraceClosureHash} from '../multi-pine/package-closure.js';
import {evaluateMultiBuildEligibility, evaluateMultiPackage, multiReadState, MULTI_PACKAGE_GATE_VERSION, MAX_VALIDATION_ATTEMPTS, isRefused} from '../multi-pine/package-gates.js';
import {BOT_ROWS, DEPLOYMENT_ROWS, EVIDENCE_ROWS, JOB_ROWS} from './mp-member-set-store.js';
import {getMultiRun, listMultiRuns} from './mp-run-store.js';
import {readExposures, toPackageEntries} from './exposure-register.js';
import {HARD_RANGES} from './pf4-risk-proposals.js';
import {validateBar} from './pine-bridge-market.js';

/*
 * F11-01 R6-4: writer, readers and build service of the internal multi-Pine package store (src/postgres/mp-package-store.sql; docs/MULTI_PINE_CONTRACT.md RD-MP-36, RD-MP-37,
 * RD-MP-39 to RD-MP-41, RD-MP-46, RC-16). Local engineering evidence. No route, worker, runtime root or service imports this module, and the store is installed on no staging or
 * production database before APP-3B (owner item O1). It runs only on a FIXTURE-role connection of an isolated cluster: the runtime role holds no privilege on the package-store
 * tables, so every function here fails with 42501 for it (rethrown, never mapped). Every row it writes is a LABELLED FIXTURE (fixture true, method fixture-record, operator_role fixture).
 *
 * MultiPineFixturePackageService (constructor config only: db and a Store on the SAME db, readBotState, clock, engineHash, optional producerClosureHash, currentRules, hooks):
 *   build({owner_id, run_id})       RC-16 and RD-MP-40: read the run (every stored row re-checked; a foreign or absent run answers NOT_FOUND and writes nothing); an existing export
 *                                   of the run is returned as it is (F27); the live mp-combined engine hash must equal contract.engine_hash (BI_ENGINE_HASH_MISMATCH, no row);
 *                                   render, B0, render again if the B0 limitation codes changed; then ONE SERIALIZABLE transaction that reads the export of the run first, re-reads the
 *                                   run, the holdout lookups, the exposure register, the member state and the dataset, re-renders, re-runs B0 and only then inserts the blobs, the
 *                                   export row, its files, the seq 1 EXPORT_CANDIDATE event (empty codes, auditor R6-3 N2) and the three trace records. A B0 failure, a render refusal
 *                                   and a trace refusal write no row.
 *   attempt({owner_id, export_id})  one validation attempt: the live engine hash must equal contract.engine_hash (BI_ENGINE_HASH_MISMATCH, non-retryable, no attempt row; RD-MP-48 N3), then
 *                                   C1 to C4 and Q through evaluateMultiPackage, then the attempt row, the validation record of an EXPORT_INTERNAL pass (RD-MP-37) and the status event. An export
 *                                   that is not an open candidate answers EXPORT_NOT_OPEN. READY is always false.
 *   read({owner_id, export_id|run_id})  the stored export with its derived freshness (multiReadState): STALE and the first code are derived, never written. It runs in ONE READ ONLY
 *                                   REPEATABLE READ transaction, so the freshness is one snapshot (RD-MP-48 N7).
 *   recordCompile / recordEvidence / recordClearance / recordFixtureRecords: the candidate records (RD-MP-41). They are fixture records only.
 * The live state passed to the gates is read once per build or attempt transaction: `current` (membership, policy, capital {equity, cash} of the set market broker account,
 * funding cutoff, input_lock_hash recomputed by the RD-MP-44 R4 recipe from the LIVE effective inputs hash and the LIVE deployment snapshot hash of every member), and `deployments`
 * (the live pine_deployments rows the contract members name, full snapshots). When the stored member set is not fresh by memberSetFreshness (deployment state, exit version, evidence
 * hash, execution model also count), the input lock of `current` is passed unreadable (null), so B0 and C4 report it. trace_reproduction is the deriveMultiTrace output of the LIVE
 * producer closure hash, passed unmodified; the stored trace records are never trusted in its place.
 * Concurrency (auditor R6-3 N5): the export guard takes no lock; UNIQUE (owner_id, run_id) and SERIALIZABLE isolation decide a build race. The loser ends 40001 or a unique violation
 * of the owner/run key, restarts from the first read of its transaction, finds the winner and answers LOAD with the same export_id.
 *
 * D1 (RD-MP-48): the selected pair and the baseline pair of a run are canonical decimal STRINGS end to end (the executor and the candidate plan store them so); the renderer accepts only
 * them and the C3 and C4 gates compare them as decimals. The run view of this module is the stored run as it is: no mapping exists, so the manifest result_sha256 is the stored result_hash.
 * Hard limits (RD-MP-48 F2, N2): C3 BI_RISK_RELAXATION compares the risk-profile limits with the CURRENT SERVER hard limits, the ranges of the risk policy validator (validateRisk, the
 * same constant HARD_RANGES the PF-4 proposals use), not with the frozen policy itself. Bridge bounds: no current server source of "the Bot's permitted Bridge bounds" exists yet (the
 * apply flow, F09-03, is not built), so C4 BI_BRIDGE_PAIR_OUT_OF_BOUNDS uses the frozen contract domains; that is a recorded limitation (RD-MP-48), and a caller may pass narrower bounds (an override only tightens, RD-MP-49 R1).
 * Test seams: hooks.step(name, detail) is called at LOOKUPS, RENDER, B0, TX_BEGIN and INSERT (the RC-16 order) and, in an attempt, at GATES with the evidence the gates read (detail.evidence); hooks.beforeTransaction() and hooks.beforeInsert() let a test hold a build open.
 */

export const PACKAGE_STORE_CODES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND', BUILD_B0_FAILED: 'BUILD_B0_FAILED', BUILD_INPUT_INVALID: 'BUILD_INPUT_INVALID', EXPORT_NOT_OPEN: 'EXPORT_NOT_OPEN', STORED_INTEGRITY: 'PACKAGE_STORED_INTEGRITY',
  STORE_GUARD: 'PACKAGE_STORE_GUARD', ENGINE_MISMATCH: 'BI_ENGINE_HASH_MISMATCH', HOLDOUT_UNREADABLE: 'HOLDOUT_INDEPENDENCE_NOT_CHECKED', EXPOSURE_UNREADABLE: 'BI_EXPOSURE_REGISTER_UNAVAILABLE',
  IN_TRANSACTION: 'PACKAGE_STORE_IN_TRANSACTION'
});
/** Names of the guard triggers of mp-package-store.sql (the CONSTRAINT of each QR004). */
export const PACKAGE_STORE_GUARD_NAMES = Object.freeze({
  exports: 'mp_package_exports_guard', complete: 'mp_package_exports_complete', files: 'mp_package_files_guard', status: 'mp_package_status_events_guard', attempts: 'mp_package_attempts_guard',
  validations: 'mp_package_validations_guard', compile: 'mp_package_compile_records_guard', evidence: 'mp_package_evidence_records_guard', clearances: 'mp_package_clearances_guard',
  trace: 'mp_package_trace_records_guard'
});
/** One first try plus three restarts of a lost race (40001, 40P01 or a unique violation of a key below). */
export const PACKAGE_STORE_MAX_RETRIES = 3;
/** Holdout reader bound: at most 10 pages of 500 multi runs (RD-MP-40). */
export const HOLDOUT_MAX_PAGES = 10;
export const HOLDOUT_PAGE_SIZE = 500;
export const PACKAGE_LIBRARY_VERSIONS = Object.freeze({gates: MULTI_PACKAGE_GATE_VERSION, render: 'multi-v1'});
/** The scope of the registered boundary, the same four values as PREFLIGHT_HOLDOUT_SCOPE (quant-preflight.js); a test pins the equality. */
export const BOUNDARY_SCOPE = Object.freeze({venue: 'binance-global', market: 'SPOT', symbol: 'BTCUSDT', timeframe: '1'});

const QR_GUARD = 'QR004', SERIALIZATION_FAILURE = '40001', DEADLOCK_DETECTED = '40P01', UNIQUE_VIOLATION = '23505';
/** Unique keys whose violation means "another transaction won": restart and read again. */
const RACE_KEYS = new Set(['mp_package_exports_owner_run_key', 'mp_package_exports_pkey', 'mp_package_attempts_pkey', 'mp_package_attempts_attempt_id_key', 'mp_package_status_events_pkey',
  'mp_package_status_events_attempt_key', 'mp_package_validations_pkey', 'mp_package_files_pkey', 'mp_package_trace_records_pkey']);
const MINUTE = 60_000;
const PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TRACE_PATH_LIST = Object.freeze(Object.values(MP_TRACE_PATHS));
const EVIDENCE_KINDS = Object.freeze(['dataset_alignment', 'native_parity', 'bridge_parity', 'repaint']);
/** The evidence kind a candidate blocker is cleared by (the same map as the clearance guard of the SQL). */
const CLEARANCE_KIND = Object.freeze({VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED: 'native_parity', CUSTOM_REPAINT_EVIDENCE_REQUIRED: 'repaint'});
const LIMIT_KEYS = Object.freeze(['maxRiskPercent', 'maxOrderNotional', 'maxDailyNotional']);
/** The positive plain decimal of the multi-Pine run contract module (its DECIMAL_TEXT and positiveDecimal, copied exactly, RD-MP-48 N5): digits with an optional fraction, no sign or exponent, below 1e20. */
const DECIMAL_TEXT = /^(?:0|[1-9]\d{0,19})(?:\.\d+)?$/;

const SOURCE_ROWS = `SELECT r.pine_import_id,r.source_version,r.source,r.source_hash,r.analysis,s.owner_id,s.bot_id FROM public.pine_source_revisions r
  JOIN public.pine_sources s ON s.pine_import_id=r.pine_import_id WHERE s.owner_id=$1 AND s.bot_id=$2 AND r.pine_import_id=ANY($3::text[]) ORDER BY r.pine_import_id,r.source_version`;
const SET_ROW = 'SELECT record FROM public.mp_member_sets WHERE member_set_id=$1 AND owner_id=$2 AND bot_id=$3';
const BAR_PAGE = `SELECT bar_time,bar,provenance,content_hash FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'
  AND bar_time>$1 AND bar_time<=$2 ORDER BY bar_time LIMIT ${PAGE}`;
const EXPORT_COLUMNS = ['export_id', 'owner_id', 'bot_id', 'run_id', 'mode', 'pine_count', 'fixture', 'gate_version', 'library_versions', 'binding', 'binding_hash', 'package_hash', 'b0', 'created_at', 'created_at_utc'];
const EXPORT_BY_RUN = `SELECT ${EXPORT_COLUMNS.join(',')} FROM public.mp_package_exports WHERE owner_id=$1 AND run_id=$2`;
const EXPORT_BY_ID = `SELECT ${EXPORT_COLUMNS.join(',')} FROM public.mp_package_exports WHERE owner_id=$1 AND export_id=$2`;
const FILE_ROWS = `SELECT f.path,f.sha256,f.bytes,b.content FROM public.mp_package_files f JOIN public.mp_package_blobs b ON b.sha256=f.sha256 AND b.size=f.bytes
  WHERE f.export_id=$1 ORDER BY f.path COLLATE "C"`;
const EVENT_ROWS = 'SELECT seq,status,codes,attempt_no,at_ms,at_utc FROM public.mp_package_status_events WHERE export_id=$1 ORDER BY seq';
const ATTEMPT_ROWS = `SELECT attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc FROM public.mp_package_attempts
  WHERE export_id=$1 ORDER BY attempt_no`;
const COMPILE_ROWS = `SELECT compile_id,ordinal,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,duplicate_bindings,mapping_check,compiled_at_ms,compiled_at_utc,
  operator_role,method FROM public.mp_package_compile_records WHERE export_id=$1 ORDER BY ordinal,compiled_at_ms,compile_id`;
const EVIDENCE_ROW_SQL = `SELECT evidence_id,ordinal,kind,record,evidence_hash,recorded_at_ms FROM public.mp_package_evidence_records WHERE export_id=$1 ORDER BY ordinal,kind,recorded_at_ms,evidence_hash`;
const CLEARANCE_ROWS = 'SELECT blocker,ordinal,run_id,parameter_hash,evidence_hash,recorded_at_ms FROM public.mp_package_clearances WHERE export_id=$1 ORDER BY blocker,ordinal,recorded_at_ms,evidence_hash';
const TRACE_ROWS = `SELECT path,sha256,decisions_hash,steps_digest,holdout_digest,run_engine_hash,producer_closure_hash,method FROM public.mp_package_trace_records WHERE export_id=$1 ORDER BY path COLLATE "C"`;

/*
 * Holdout independence lookups (RD-MP-40). EARLIER_ONE_PINE_SQL mirrors EARLIER of src/postgres/quant-library.js (the earlier runs of the owner that evaluated a holdout) and
 * EFFECTIVE_BOUNDARY_SQL mirrors the constant of the same name in src/postgres/quant-preflight.js. Both are pinned by a parity test against those files; the only difference is the
 * schema name `public.` before each table, so no search_path lookup can pick another relation.
 */
export const EARLIER_ONE_PINE_SQL = `WITH earlier AS MATERIALIZED (SELECT j.run_id,j.created_at,
 CASE WHEN jsonb_typeof(j.contract)='object' THEN j.contract - 'source' #- '{dataset,bars}' #- '{plan,candidates}' END AS k
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND j.run_id<>$2 AND (j.created_at,j.run_id)<($3::bigint,$2::text) AND j.result->'holdout_evaluated'='true'::jsonb)
 SELECT run_id,k#>'{snapshot,market}' AS market,k->'split' AS split,k#>'{dataset,start_time}' AS start_time FROM earlier ORDER BY created_at,run_id`;
export const EFFECTIVE_BOUNDARY_SQL = `SELECT (SELECT min(sibling.holdout_start_time)
  FROM public.quant_holdout_boundaries sibling WHERE sibling.owner_id=own.owner_id
  AND sibling.venue=own.venue AND sibling.market=own.market
  AND sibling.symbol=own.symbol AND sibling.timeframe=own.timeframe) holdout_start_time
  FROM public.quant_holdout_boundaries own WHERE own.owner_id=$1 AND own.bot_id=$2
  AND own.venue=$3 AND own.market=$4 AND own.symbol=$5 AND own.timeframe=$6`;
/** Earlier one-Pine runs of the owner that searched data with one of the given source hashes (OD-10): any status, strictly earlier by (created_at, run_id). */
export const EARLIER_SEARCHED_ONE_PINE_SQL = `SELECT j.run_id,j.contract#>'{snapshot,market}' AS market,j.contract->'split' AS split,j.contract#>'{dataset,start_time}' AS start_time
 FROM public.quant_jobs j WHERE j.owner_id=$1 AND j.run_id<>$2 AND (j.created_at,j.run_id)<($3::bigint,$2::text) AND j.contract->>'source_hash'=ANY($4::text[]) ORDER BY j.created_at,j.run_id`;

/* ---------- small helpers ---------- */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const sha = value => typeof value === 'string' && HEX64.test(value);
const digest = value => hash(canonical(value));
const refusal = (code, extra = {}) => ({ok: false, code, ...extra});
const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const number = value => { const parsed = typeof value === 'number' ? value : Number(value); return Number.isSafeInteger(parsed) ? parsed : Number.NaN; };
const isoOf = ms => new Date(ms).toISOString();
const positiveDecimal = value => typeof value === 'string' && value.length <= 120 && DECIMAL_TEXT.test(value) && /[1-9]/.test(value);
/** As the accountText of the multi-Pine run contract module (RD-MP-48 N5): a finite number is written with String, then the positive decimal rule applies; otherwise null. */
const accountText = value => { const out = typeof value === 'number' && Number.isFinite(value) ? String(value) : value; return positiveDecimal(out) ? out : null; };
const datasetDigestOf = dataset => isObject(dataset) ? (typeof dataset.sha256 === 'string' ? dataset.sha256 : dataset.content_digest) : undefined;
const toBuffer = value => Buffer.isBuffer(value) ? value : Buffer.from(value);

/** The numeric limits of a policy, as decimal strings (risk-profile.json). A limit that is not a positive plain decimal is absent, and C3 then reports BI_RISK_RELAXATION. */
export function riskLimitsOf(policy) {
  const out = {};
  if (isObject(policy)) for (const key of LIMIT_KEYS) { const value = accountText(policy[key]); if (value !== null) out[key] = value; }
  return out;
}
/** RD-MP-48 F2, N2: the current server hard limits, {name: {min, max}} as decimal strings, from the ranges of the risk policy validator (HARD_RANGES, the one constant of those ranges). */
export const serverHardLimits = () => Object.fromEntries(Object.entries(HARD_RANGES).map(([name, [min, max]]) => [name, {min, max}]));
/**
 * RD-MP-49 R1: an override of the hard limits or the Bridge bounds may only TIGHTEN its default. Per key present in the default, the result takes the larger min and the smaller max of the
 * default and the override, compared as decimals (D, never Number). A key the override omits keeps its default; a key the default lacks is ignored; a bound that is not a readable decimal,
 * or an entry that is not an object, is ignored, so the default bound stays in force.
 */
export function tightenBounds(defaults, override) {
  const readable = value => { try { return D(value); } catch { return null; } };
  return Object.fromEntries(Object.entries(defaults).map(([name, bound]) => {
    const given = isObject(override) && isObject(override[name]) ? override[name] : {};
    const min = readable(given.min), max = readable(given.max);
    return [name, {min: min !== null && min.gt(bound.min) ? min.toFixed() : bound.min, max: max !== null && max.lt(bound.max) ? max.toFixed() : bound.max}];
  }));
}
/** RD-MP-48 limitation: the Bridge bounds are the frozen contract domains (no current server source of the Bot's permitted Bridge bounds exists before the F09-03 apply flow). */
export const bridgeBoundsOf = contract => Object.fromEntries(['atr_multiplier', 'rr'].map(name => [name, {min: contract.bridge_domains[name].min, max: contract.bridge_domains[name].max}]));
/**
 * RD-MP-48 N1: the native alert isolation of one contract member, read from the member's own Bridge evidence. Only a row whose snapshot_hash equals the member deployment_snapshot_hash
 * and whose evidence_hash verifies (it is the digest of the stored evidence) counts. native_alerts_isolated true is the proof that no native payload exists, so native_payloads is 0;
 * with no such row, or without the proof, the proof is absent and native_payloads is -1 (the gate then reports BI_NATIVE_ALERT_ISOLATION_UNPROVEN).
 */
export function memberIsolation(member, rows) {
  const row = (Array.isArray(rows) ? rows : []).find(item => isObject(item) && item.deployment_id === member.deployment_id && item.snapshot_hash === member.deployment_snapshot_hash
    && sha(item.evidence_hash) && isObject(item.evidence) && digest(item.evidence) === item.evidence_hash);
  const record = row?.evidence, isolated = record?.native_alerts_isolated === true;
  return {ordinal: member.ordinal, routes_disabled: isolated, unrelated_payloads: Number.isSafeInteger(record?.unrelated_payloads) ? record.unrelated_payloads : -1, native_payloads: isolated ? 0 : -1};
}

/** The run view the pure gates and the renderer read. */
function runFor(view) {
  const last = view.events[view.events.length - 1];
  return {owner_id: view.run.owner_id, bot_id: view.run.bot_id, run_id: view.run.run_id, status: view.status, contract: view.run.contract, contract_hash: view.run.contract_hash,
    submission_hash: view.run.submission_hash, result: last?.result ?? null, created_at_ms: view.run.created_at_ms};
}
const finishedHoldout = run => run.status === 'SUCCEEDED' && isObject(run.result) && run.result.holdout_evaluated === true && run.result.completion_reason === 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';

/* ---------- failure mapping ---------- */

/** QR004 maps by the guard that fired; every other database error is not owned here and the caller rethrows it. */
export function mapPackageStoreFailure(error) {
  if (error?.code === QR_GUARD && Object.values(PACKAGE_STORE_GUARD_NAMES).includes(error.constraint)) return refusal(PACKAGE_STORE_CODES.STORE_GUARD, {diagnostic: {guard: error.constraint, message: String(error.message).slice(0, 200)}});
  return null;
}
const raceError = error => error?.code === SERIALIZATION_FAILURE || error?.code === DEADLOCK_DETECTED || (error?.code === UNIQUE_VIOLATION && RACE_KEYS.has(error.constraint));

/* ---------- holdout independence lookups (RD-MP-40) ---------- */

/** The lookups of PKG 5.0 item 5 for one multi run, on the given handle. Returns {ok, lookups, unavailable}: a part that cannot be read is null in `lookups` (B0 then reports
 * HOLDOUT_INDEPENDENCE_NOT_CHECKED or BI_EXPOSURE_REGISTER_UNAVAILABLE) and its code is in `unavailable`. Nothing here throws for an absent table or an unreadable row. */
export async function readMultiHoldoutLookups(db, view, {pageSize = HOLDOUT_PAGE_SIZE, maxPages = HOLDOUT_MAX_PAGES} = {}) {
  const run = view.run, contract = run.contract, subjectKey = canonical(PACKAGE_MARKET);
  const sourceHashes = [...new Set(contract.members.map(member => member.source_hash))];
  const unavailable = new Set();
  const before = other => other.created_at_ms < run.created_at_ms || (other.created_at_ms === run.created_at_ms && other.run_id < run.run_id);
  let earlier = [], searched = [], boundary = null, exposure = null, ownRunsOk = true;
  // 1. earlier multi runs of the owner (listMultiRuns re-checks every row; a refusal, or more than maxPages pages, fails closed)
  const runs = [];
  let cursor = {};
  for (let page = 0; ; page++) {
    if (page >= maxPages) { ownRunsOk = false; break; }
    const listed = await listMultiRuns(db, {owner_id: run.owner_id, limit: pageSize, ...cursor});
    if (!listed.ok) { ownRunsOk = false; break; }
    runs.push(...listed.runs);
    if (listed.next === null) break;
    cursor = {before_ms: listed.next.before_ms, before_run_id: listed.next.before_run_id};
  }
  if (ownRunsOk) {
    for (const other of runs) {
      if (other.run.run_id === run.run_id || !before(other.run)) continue;
      const result = other.events[other.events.length - 1]?.result;
      if (isObject(result) && result.holdout_evaluated === true) {
        const window = holdoutWindow(other.run.contract);
        if (window === null) ownRunsOk = false; else earlier.push(window);
      }
      if (other.run.contract.members.some(member => sourceHashes.includes(member.source_hash))) {
        const window = searchedWindow(other.run.contract);
        if (window === null) ownRunsOk = false; else searched.push(window);
      }
    }
  }
  if (!ownRunsOk) unavailable.add(PACKAGE_STORE_CODES.HOLDOUT_UNREADABLE);
  // 2. earlier one-Pine runs (read-only; the table is part of the research extension)
  const present = (await db.query("SELECT to_regclass('public.quant_jobs') AS jobs,to_regclass('public.quant_holdout_boundaries') AS boundaries")).rows[0];
  let onePineOk = present?.jobs !== null && present?.jobs !== undefined;
  if (onePineOk) {
    const params = [run.owner_id, run.run_id, run.created_at_ms];
    const ownKey = subjectKey;
    for (const row of (await db.query(EARLIER_ONE_PINE_SQL, params)).rows) {
      const shape = {snapshot: {market: row.market}, split: row.split, dataset: {start_time: row.start_time}}, key = marketKey(shape), window = holdoutWindow(shape);
      if (key !== null && key !== ownKey) continue;
      if (window === null) onePineOk = false; else earlier.push(window);
    }
    for (const row of (await db.query(EARLIER_SEARCHED_ONE_PINE_SQL, [...params, sourceHashes])).rows) {
      const shape = {snapshot: {market: row.market}, split: row.split, dataset: {start_time: row.start_time}}, key = marketKey(shape), window = searchedWindow(shape);
      if (key !== null && key !== ownKey) continue;
      if (window === null) onePineOk = false; else searched.push(window);
    }
  }
  if (!onePineOk) unavailable.add(PACKAGE_STORE_CODES.HOLDOUT_UNREADABLE);
  // 3. the registered boundary (the strictest boundary of the owner's shared market; absent table fails closed)
  if (present?.boundaries !== null && present?.boundaries !== undefined) {
    const rows = (await db.query(EFFECTIVE_BOUNDARY_SQL, [run.owner_id, run.bot_id, ...Object.values(BOUNDARY_SCOPE)])).rows;
    if (rows.length === 0) boundary = {exists: false};
    else { const start = number(rows[0].holdout_start_time); boundary = Number.isSafeInteger(start) ? {exists: true, start_time: start} : null; }
  }
  if (boundary === null) unavailable.add(PACKAGE_STORE_CODES.HOLDOUT_UNREADABLE);
  // 4. the exposure register of the owner and the fixed market
  const read = await readExposures(db, {owner_id: run.owner_id, broker: PACKAGE_MARKET.broker, symbol: PACKAGE_MARKET.symbol, timeframe: PACKAGE_MARKET.timeframe});
  exposure = read.ok === true ? toPackageEntries(read) : null;
  if (exposure === null) unavailable.add(PACKAGE_STORE_CODES.EXPOSURE_UNREADABLE);
  const lookups = {earlier_holdouts: ownRunsOk && onePineOk ? earlier : null, earlier_searched: ownRunsOk && onePineOk ? searched : null, registered_boundary: boundary, exposure_register: exposure};
  return {ok: unavailable.size === 0, lookups, unavailable: [...unavailable].sort()};
}

/* ---------- dataset ---------- */

/** Reads the contract bars from pine_market_bars. readable is false for a gap, a short range, an unverified row or a metadata mismatch; digest is the ordered content digest of the rows read. */
export async function readPackageDataset(db, contract) {
  const {dataset, model} = contract, rows = [];
  let after = dataset.start_time - 1;
  try {
    while (rows.length < dataset.bar_count) {
      const page = (await db.query(BAR_PAGE, [after, dataset.end_time])).rows;
      if (page.length === 0) break;
      for (const row of page) {
        const time = Number(row.bar_time);
        if (time !== dataset.start_time + rows.length * MINUTE || row.bar?.time !== time || row.provenance?.profile !== model.data_profile || hash(canonical(row.bar)) !== row.content_hash) return {readable: false};
        validateBar(row.bar);
        if (!D(row.bar.price_tick).eq(model.price_tick) || !D(row.bar.quantity_step).eq(model.quantity_step)) return {readable: false};
        rows.push({bar_time: time, content_hash: row.content_hash});
        if (rows.length > dataset.bar_count) return {readable: false};
      }
      after = Number(page[page.length - 1].bar_time);
    }
    if (rows.length !== dataset.bar_count) return {readable: false};
    const end = rows[rows.length - 1].bar_time + MINUTE;
    return {readable: true, digest: contentDigest(rows), metadata: {version: 'spot-dataset-v1', source: 'binance-spot-klines-v1', venue: PACKAGE_MARKET.broker, market: 'SPOT', symbol: PACKAGE_MARKET.symbol,
      timeframe: PACKAGE_MARKET.timeframe, start_time: rows[0].bar_time, end_time: end, total_bars: rows.length, warmup_bars: dataset.warmup_bars, cutoff: end}};
  } catch (error) {
    // A PostgreSQL error (a five character SQLSTATE) is not a verdict on the data and is rethrown; a bar or digest check error is "not readable".
    if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) throw error;
    return {readable: false};
  }
}

/* ---------- fixture records (RD-MP-41): every compile and evidence record of F11-01 is a fixture record ---------- */

const FIXTURE_LABEL = Object.freeze({method: 'fixture-record', operator_role: 'fixture'});
function evidenceScope(contract, member) {
  return {source_hash: member.source_hash, effective_input_hash: member.effective_inputs_hash, dataset_digest: datasetDigestOf(contract.dataset), engine_hash: contract.engine_hash,
    deployment_id: member.deployment_id, ordinal: member.ordinal};
}
/** A passing fixture evidence record of one kind for one contract member, scoped to that member (RD-MP-41). Mechanics only: no TradingView compile and no real parity ran. */
export function fixtureEvidenceRecord(contract, member, kind) {
  const scope = evidenceScope(contract, member);
  switch (kind) {
    case 'dataset_alignment': return {matched_percent: 100, unmatched_bars: 0, future_leakage: 0, ...FIXTURE_LABEL, scope};
    case 'native_parity': return {match_percent: 100, missing_events: 0, additional_events: 0, shift_bars: 0,
      sample: {warmup_bars: 1250, lookback: 200, closed_bars: 2500, native_events: 150, buy_events: 40, exit_events: 40}, ...FIXTURE_LABEL, scope};
    case 'bridge_parity': return {match_percent: 100, sl_tp_diff_ticks: 0, exit_version: member.exit_version, ...FIXTURE_LABEL, scope};
    case 'repaint': return {observations: 100, changed_flags: 0, ...FIXTURE_LABEL, scope};
    default: throw new Error('Unknown evidence kind ' + kind);
  }
}
/** A clean fixture compile record for the member indicator.pine of an export. */
export const fixtureCompileRecord = ({indicatorSha256, pineVersion = 'fixture'}) => ({indicator_sha256: indicatorSha256, pine_version: String(pineVersion), errors: [], warnings: [], unresolved_references: 0,
  collisions: 0, duplicate_bindings: 0, mapping_check: [], ...FIXTURE_LABEL});

/* ---------- the service ---------- */

export class MultiPineFixturePackageService {
  #db; #store; #readBotState; #clock; #engineHash; #producerClosureHash; #currentRules; #hooks; #limits; #bounds;

  /** db: a FIXTURE-role PostgresDatabase (not in a transaction); store: a Store on THE SAME db; readBotState: storeBotState over that store; clock: epoch ms; engineHash: the live mp-combined
   * closure hash (a function or a 64-hex string, required: the caller computes it, as the executor's caller does, so this module imports no engine module); producerClosureHash: the live producer closure hash (default mpPackageTraceClosureHash); currentRules: the
   * rules B0 compares the run rules with (default RULES); hooks: {step(name), beforeInsert()} test seams (RC-16 order, a forced build race); hardLimits and bridgeBounds: overrides of the hard
   * limits and Bridge bounds the C3 and C4 gates take; each is intersected with its default per key, so it can only tighten (default: the current server hard limits and the frozen contract domains, see the module comment). */
  constructor({db, store, readBotState, clock, engineHash, producerClosureHash = mpPackageTraceClosureHash, currentRules = RULES, hooks = {}, hardLimits, bridgeBounds} = {}) {
    if (!db || typeof db.query !== 'function' || typeof db.transaction !== 'function' || db.isTransaction === true) throw new Error('db must be a PostgresDatabase outside a transaction');
    if (!store || store.db !== db) throw new Error('store must be a Store on the same db');
    if (typeof readBotState !== 'function' || typeof clock !== 'function') throw new Error('readBotState and clock are required');
    if (!isObject(currentRules)) throw new Error('currentRules');
    if (typeof engineHash !== 'function' && !sha(engineHash)) throw new Error('engineHash must be a function or 64 hex characters');
    this.#db = db; this.#store = store; this.#readBotState = readBotState; this.#clock = clock; this.#engineHash = engineHash; this.#producerClosureHash = producerClosureHash;
    this.#currentRules = currentRules; this.#hooks = isObject(hooks) ? hooks : {}; this.#limits = hardLimits; this.#bounds = bridgeBounds;
  }

  async #step(name, detail) { if (typeof this.#hooks.step === 'function') await this.#hooks.step(name, detail); }
  async #liveEngine() { return typeof this.#engineHash === 'function' ? this.#engineHash() : this.#engineHash; }
  async #liveClosure() { return typeof this.#producerClosureHash === 'function' ? this.#producerClosureHash() : this.#producerClosureHash; }

  /** One SERIALIZABLE transaction, restarted from its first statement after a lost race (at most PACKAGE_STORE_MAX_RETRIES times). */
  async #transact(body) {
    let last;
    for (let tries = 0; tries <= PACKAGE_STORE_MAX_RETRIES; tries++) {
      try { return await this.#db.transaction(body, {isolation: 'SERIALIZABLE'}); }
      catch (error) {
        if (raceError(error)) { last = error; continue; }
        const mapped = mapPackageStoreFailure(error);
        if (mapped === null) throw error;
        return mapped;
      }
    }
    throw last;
  }

  /* ---------- world reads ---------- */

  /** The rows the freshness checks, the live `current` state, the deployments and the sources need, on the given handle. */
  async #readWorld(db, view) {
    const {owner_id, bot_id, member_set_id, contract} = {...view.run, contract: view.run.contract};
    const ids = contract.members.map(member => member.deployment_id), imports = contract.members.map(member => member.pine_import_id);
    const memberships = (await db.query(BOT_ROWS, [owner_id, bot_id])).rows;
    const rows = (await db.query(DEPLOYMENT_ROWS, [owner_id, bot_id, ids])).rows;
    const jobs = new Map();
    if (rows.length > 0) for (const row of (await db.query(JOB_ROWS, [owner_id, bot_id, rows.map(item => item.deployment_id)])).rows) jobs.set(row.deployment_id, [...(jobs.get(row.deployment_id) ?? []), row.artifact]);
    const deployments = rows.map(row => {
      const found = jobs.get(row.deployment_id) ?? [];
      const derived = found.length === 1 ? deploymentExitVersion(found[0], row.snapshot, row.deployment_id) : null;
      return derived?.ok === true ? {...row, exit_version: derived.exit_version} : row;
    });
    const evidence = ids.length > 0 ? (await db.query(EVIDENCE_ROWS, [ids])).rows : [];
    const sources = (await db.query(SOURCE_ROWS, [owner_id, bot_id, imports])).rows;
    const bot_state = await this.#readBotState({bot_id});
    const accounts = await this.#store.paperAccounts(bot_id);
    const setRow = (await db.query(SET_ROW, [member_set_id, owner_id, bot_id])).rows[0] ?? null;
    return {memberships, deployments, evidence, sources, bot_state, accounts, setRow};
  }

  /** `current` (RD-MP-46): built once per transaction from live server state. See the class comment. */
  #currentOf(view, world, dataset) {
    const contract = view.run.contract;
    const connected = world.memberships.filter(row => row.connected === true).sort((a, b) => byText(a.pine_import_id, b.pine_import_id));
    const named = new Map(contract.members.map(member => [member.pine_import_id, member.deployment_id]));
    const membership = connected.map(row => ({pine_import_id: row.pine_import_id, source_version: row.source_version, source_hash: row.source_hash, deployment_id: named.get(row.pine_import_id) ?? null}));
    const membership_hash = digest(connected.map(row => ({pine_import_id: row.pine_import_id, source_version: row.source_version, source_hash: row.source_hash})));
    const account = world.accounts.find(item => item.broker === PACKAGE_MARKET.broker);
    const equity = account ? accountText(account.configuredEquity) : null, cash = account ? accountText(account.configuredBalance) : null;
    const lock = contract.members.map(member => {
      const live = connected.find(row => row.pine_import_id === member.pine_import_id), deployment = world.deployments.find(row => row.deployment_id === member.deployment_id);
      return {ordinal: member.ordinal, effective_input_hash: live?.analysis?.effective_inputs_hash, deployment_snapshot_hash: isObject(deployment?.snapshot) ? digest(deployment.snapshot) : undefined};
    });
    let input_lock_hash = lock.every(item => sha(item.effective_input_hash) && sha(item.deployment_snapshot_hash)) ? digest({bridge_domains: contract.bridge_domains, members: lock}) : null;
    // Auditor R6-2 NB2: the stored member set must also be fresh by memberSetFreshness (deployment state, exit version, evidence hash, execution model). Otherwise the input lock is unreadable.
    const decided = world.setRow ? decideFreeze(world.setRow.record, []) : null;
    let setFresh = false;
    if (decided?.ok === true && decided.member_set.set_hash === view.run.set_hash) {
      const fresh = memberSetFreshness(decided.member_set, {owner_id: view.run.owner_id, bot_id: view.run.bot_id, bot_state: world.bot_state, memberships: world.memberships, deployments: world.deployments, evidence: world.evidence});
      setFresh = fresh.ok === true && fresh.fresh === true;
    }
    if (!setFresh) input_lock_hash = null;
    return {membership, membership_hash, policy_hash: world.bot_state?.policy_hash, capital: equity !== null && cash !== null ? {equity, cash} : null, funding_cutoff: world.bot_state?.funding_cutoff,
      input_lock_hash, dataset_available: dataset.readable === true && dataset.digest === contract.dataset.content_digest};
  }

  /** Everything the build and an attempt read from live state, on the given handle (a plain handle for phase 1, the SERIALIZABLE transaction handle for phase 2 and for attempts). */
  async #prepare(db, view) {
    const contract = view.run.contract;
    const world = await this.#readWorld(db, view);
    const dataset = await readPackageDataset(db, contract);
    const current = this.#currentOf(view, world, dataset);
    const deployments = contract.members.map(member => {
      const row = world.deployments.find(item => item.deployment_id === member.deployment_id);
      return {deployment_id: member.deployment_id, exit_version: row?.exit_version, snapshot: row?.snapshot};
    }).filter(item => item.snapshot !== undefined);
    const members = contract.members.map(member => {
      const source = world.sources.find(row => row.pine_import_id === member.pine_import_id && row.source_version === member.source_version);
      const deployment = world.deployments.find(row => row.deployment_id === member.deployment_id);
      const signals = deployment?.snapshot?.selection?.signals;
      return {ordinal: member.ordinal, source: typeof source?.source === 'string' ? source.source : '', signals: {buy: signals?.buy ?? '', exit: signals?.exit ?? ''}};
    });
    const policy = world.deployments.find(row => row.deployment_id === contract.members[0].deployment_id)?.snapshot?.policy;
    const evidenceRows = world.evidence;
    // Native alert isolation of each member comes from the member's own Bridge evidence record (RD-MP-48 N1, see memberIsolation).
    const isolation = contract.members.map(member => memberIsolation(member, evidenceRows));
    return {world, dataset, current, deployments, members, policy, isolation};
  }

  /* ---------- RC-16: render, B0, render again if the limitation codes changed ---------- */

  async #assemble(db, view, prepared, {exportId, createdAtMs}) {
    const run = runFor(view), contract = run.contract;
    const live = await this.#liveEngine();
    if (live !== contract.engine_hash) return refusal(PACKAGE_STORE_CODES.ENGINE_MISMATCH, {stage: 'ENGINE'});
    if (!finishedHoldout(run)) {
      // Not a finished holdout run (for example NO_VALID_CANDIDATE, F20): B0 names the run codes; there is nothing to render.
      const b0 = evaluateMultiBuildEligibility({owner_id: run.owner_id, run, holdout: {}, deployments: prepared.deployments, binding: {}, internal: true, current_rules: this.#currentRules, current: prepared.current});
      return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED, {stage: 'B0', codes: [...b0.codes]});
    }
    const closure = await this.#liveClosure();
    let trace;
    try { trace = deriveMultiTrace({run, producer_closure_hash: closure}); }
    catch (error) { return refusal(typeof error?.code === 'string' ? error.code : 'TRACE_PRODUCER_INPUT_INVALID', {stage: 'TRACE', detail: String(error?.message ?? '').slice(0, 200)}); }
    const lookups = (await readMultiHoldoutLookups(db, view)).lookups;
    await this.#step('LOOKUPS');
    const input = {export_id: exportId, created_at: isoOf(createdAtMs), fixture: true, run, policy: prepared.policy, members: prepared.members, producer_closure_hash: closure, trace,
      library_versions: {...PACKAGE_LIBRARY_VERSIONS}, risk_limits: riskLimitsOf(prepared.policy)};
    const render = limitationCodes => {
      try { return {rendered: renderMultiPackage(limitationCodes.length ? {...input, limitations: {codes: limitationCodes}} : input)}; }
      catch (error) { return {error: refusal(typeof error?.code === 'string' ? error.code : 'RENDER_INPUT_INVALID', {stage: 'RENDER', detail: String(error?.message ?? '').slice(0, 200)})}; }
    };
    await this.#step('RENDER');
    let out = render([]);
    if (out.error) return out.error;
    const subject = binding => ({owner_id: run.owner_id, run, holdout: lookups, deployments: prepared.deployments, binding, internal: true, current_rules: this.#currentRules, current: prepared.current});
    await this.#step('B0');
    let b0 = evaluateMultiBuildEligibility(subject(out.rendered.binding));
    if (!b0.pass) return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED, {stage: 'B0', codes: [...b0.codes], b0});
    const codes = [...b0.limitations];
    if (codes.length > 0) {
      await this.#step('RENDER');
      out = render(codes);
      if (out.error) return out.error;
      b0 = evaluateMultiBuildEligibility(subject(out.rendered.binding));
      if (!b0.pass) return refusal(PACKAGE_STORE_CODES.BUILD_B0_FAILED, {stage: 'B0', codes: [...b0.codes], b0});
    }
    // RD-MP-48 N6: the limitations B0 reports for the final binding are the ones that were rendered, and the manifest carries every one of them, so the stored b0 and the manifest agree.
    const reported = [...b0.limitations].sort(), manifestCodes = new Set(out.rendered.manifest?.limitations?.codes ?? []);
    if (canonical(reported) !== canonical([...codes].sort()) || !reported.every(code => manifestCodes.has(code))) return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID, {stage: 'LIMITATIONS'});
    return {ok: true, rendered: out.rendered, b0, trace, closure};
  }

  /* ---------- reads of a stored export ---------- */

  async #exportRow(db, owner_id, key, sql) {
    const row = (await db.query(sql, [owner_id, key])).rows[0];
    if (!row) return null;
    return {...row, pine_count: number(row.pine_count), created_at: number(row.created_at)};
  }
  async #exportView(db, row) {
    const files = (await db.query(FILE_ROWS, [row.export_id])).rows;
    const events = (await db.query(EVENT_ROWS, [row.export_id])).rows.map(event => ({...event, seq: number(event.seq), attempt_no: event.attempt_no === null ? null : number(event.attempt_no), at_ms: number(event.at_ms)}));
    return {row, files, events, status: events.length > 0 ? events[events.length - 1].status : null};
  }
  /** Checks a stored export against its own bytes: the manifest, package hash and binding hash recomputed. Returns null when consistent, else the first failing check. */
  #integrity(stored) {
    const {row, files} = stored, byPath = new Map(files.map(file => [file.path, file]));
    for (const file of files) if (hash(toBuffer(file.content)) !== file.sha256 || toBuffer(file.content).length !== number(file.bytes)) return 'file.' + file.path;
    const manifestFile = byPath.get('quant-data/manifest.json');
    if (!manifestFile) return 'manifest';
    let manifest;
    try { manifest = JSON.parse(toBuffer(manifestFile.content).toString('utf8')); } catch { return 'manifest.json'; }
    if (packageHash(manifest) !== row.package_hash) return 'package_hash';
    if (bindingHash(row.binding) !== row.binding_hash || canonical(manifest.binding) !== canonical(row.binding)) return 'binding_hash';
    if (manifest.identity?.export_id !== row.export_id || manifest.identity?.run_id !== row.run_id) return 'identity';
    return null;
  }

  /** The candidate records of an export, in the shape the gates read, with the deterministic choice of auditor R6-3 N3: the newest record of each ordinal and kind (compile: the newest per ordinal). */
  async #records(db, row, contract) {
    // The rows come ordered by (ordinal, compiled_at_ms, compile_id), so the last row of an ordinal is the newest. Two records of one ordinal in the same millisecond tie, and the tie breaks by
    // compile_id, which is random: deterministic for a given set of rows, but not chronological (RD-MP-48 N9, accepted; the fixture clock of the tests is strictly increasing).
    const compile = new Map();
    for (const record of (await db.query(COMPILE_ROWS, [row.export_id])).rows) compile.set(number(record.ordinal), record);
    const compile_records = [...compile.values()].map(record => ({ordinal: number(record.ordinal), export_id: row.export_id, indicator_sha256: record.indicator_sha256, pine_version: record.pine_version, errors: record.errors,
      warnings: record.warnings, unresolved_references: number(record.unresolved_references), collisions: number(record.collisions), duplicate_bindings: number(record.duplicate_bindings),
      mapping_check: record.mapping_check, compiled_at_utc: record.compiled_at_utc, operator_role: record.operator_role, method: record.method}));
    const chosen = new Map();
    for (const record of (await db.query(EVIDENCE_ROW_SQL, [row.export_id])).rows) {
      if (digest(record.record) !== record.evidence_hash) continue;   // a record that does not verify is not read (the next older one of its kind is)
      chosen.set(number(record.ordinal) + ':' + record.kind, record);
    }
    // RD-MP-48 N4: one entry per contract member (ordinal alone when the member has no record yet), in ordinal order.
    const ordinals = contract.members.map(member => member.ordinal).sort((a, b) => a - b);
    const evidenceMembers = ordinals.map(ordinal => ({ordinal, ...Object.fromEntries(EVIDENCE_KINDS.filter(kind => chosen.has(ordinal + ':' + kind)).map(kind => [kind, chosen.get(ordinal + ':' + kind).record]))}));
    const clearances = (await db.query(CLEARANCE_ROWS, [row.export_id])).rows.map(item => ({blocker: item.blocker, run_id: item.run_id, export_id: row.export_id, ordinal: number(item.ordinal),
      parameter_hash: item.parameter_hash, evidence_hash: item.evidence_hash}));
    return {compile_records, evidence: {members: evidenceMembers}, clearances, chosen};
  }

  /* ---------- build ---------- */

  async build(input) {
    if (!isObject(input) || Object.keys(input).some(key => !['owner_id', 'run_id'].includes(key)) || !text(input.owner_id) || typeof input.run_id !== 'string' || !UUID.test(input.run_id)) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const {owner_id, run_id} = input;
    const loaded = await getMultiRun(this.#db, {owner_id, run_id});
    if (!loaded.ok) return refusal(loaded.code, {diagnostic: loaded.diagnostic});
    const existing = await this.#exportRow(this.#db, owner_id, run_id, EXPORT_BY_RUN);
    if (existing) return {ok: true, action: 'LOAD', export: await this.#summary(this.#db, existing)};
    const exportId = randomUUID(), createdAtMs = this.#clock();
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 1) return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID, {stage: 'clock'});
    // Phase 1 (RC-16): render, B0, render again if the limitation codes changed. Nothing is written.
    const first = await this.#assemble(this.#db, loaded, await this.#prepare(this.#db, loaded), {exportId, createdAtMs});
    if (first.ok !== true) return first;
    if (typeof this.#hooks.beforeTransaction === 'function') await this.#hooks.beforeTransaction();
    // Phase 2: one SERIALIZABLE transaction. Its first statement reads the export of the run (F27), then everything is read again and B0 runs again before the first insert.
    return this.#transact(async () => {
      await this.#step('TX_BEGIN');
      const found = await this.#exportRow(this.#db, owner_id, run_id, EXPORT_BY_RUN);
      if (found) return {ok: true, action: 'LOAD', export: await this.#summary(this.#db, found)};
      const view = await getMultiRun(this.#db, {owner_id, run_id});
      if (!view.ok) return refusal(view.code, {diagnostic: view.diagnostic});
      if (view.run.contract_hash !== loaded.run.contract_hash || view.status !== loaded.status) return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID, {stage: 'RUN_CHANGED'});
      const second = await this.#assemble(this.#db, view, await this.#prepare(this.#db, view), {exportId, createdAtMs});
      if (second.ok !== true) return second;
      if (typeof this.#hooks.beforeInsert === 'function') await this.#hooks.beforeInsert();
      await this.#step('INSERT');
      await this.#insertExport(view, second, createdAtMs);
      return {ok: true, action: 'BUILD', export: {export_id: exportId, run_id, status: 'EXPORT_CANDIDATE', package_hash: second.rendered.package_hash, binding_hash: second.rendered.binding_hash, ready: false}};
    });
  }

  async #insertExport(view, assembled, createdAtMs) {
    const {rendered, b0, trace, closure} = assembled, db = this.#db, binding = rendered.binding, id = rendered.manifest.identity.export_id;
    for (const content of Object.values(rendered.files)) {
      const bytes = Buffer.from(content, 'utf8');
      await db.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT (sha256) DO NOTHING', [hash(bytes), bytes.length, bytes]);
    }
    await db.query(`INSERT INTO public.mp_package_exports(${EXPORT_COLUMNS.join(',')}) VALUES(${EXPORT_COLUMNS.map((_, index) => '$' + (index + 1)).join(',')})`,
      [id, view.run.owner_id, view.run.bot_id, view.run.run_id, 'MULTI_PINE', view.run.pine_count, true, MULTI_PACKAGE_GATE_VERSION, JSON.stringify(PACKAGE_LIBRARY_VERSIONS), JSON.stringify(binding),
        rendered.binding_hash, rendered.package_hash, JSON.stringify(b0), createdAtMs, binding.created_at]);
    for (const [path, content] of Object.entries(rendered.files)) {
      const bytes = Buffer.from(content, 'utf8');
      await db.query('INSERT INTO public.mp_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)', [id, path, hash(bytes), bytes.length]);
    }
    // Auditor R6-3 N2: the seq 1 EXPORT_CANDIDATE event carries an empty codes array.
    await db.query('INSERT INTO public.mp_package_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,$2,$3,NULL,$4,$5)', [id, 'EXPORT_CANDIDATE', [], createdAtMs, binding.created_at]);
    for (const record of trace.records) {
      await db.query(`INSERT INTO public.mp_package_trace_records(export_id,path,sha256,decisions_hash,steps_digest,holdout_digest,run_engine_hash,producer_closure_hash,method,recorded_at_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, record.path, record.sha256, record.decisions_hash, record.steps_digest, record.holdout_digest, record.run_engine_hash, closure, record.method, createdAtMs]);
    }
  }

  async #summary(db, row) {
    const stored = await this.#exportView(db, row);
    return {export_id: row.export_id, run_id: row.run_id, status: stored.status, package_hash: row.package_hash, binding_hash: row.binding_hash, ready: false};
  }

  /* ---------- read ---------- */

  async read(input) {
    if (!isObject(input) || !text(input.owner_id) || (input.export_id === undefined) === (input.run_id === undefined)) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const key = input.export_id ?? input.run_id;
    if (typeof key !== 'string' || !UUID.test(key)) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    // RD-MP-49 R7: db.transaction inside an outer transaction of the same database runs its body in that outer transaction (src/postgres/db.js line 91), so SET TRANSACTION READ ONLY would
    // change or fail the caller's transaction. A read from inside a transaction is refused before any statement.
    if (this.#db.isTransaction) return refusal(PACKAGE_STORE_CODES.IN_TRANSACTION);
    // RD-MP-48 N7: one READ ONLY REPEATABLE READ transaction, so the stored export and the live state it is compared with come from one snapshot. It writes nothing.
    return this.#db.transaction(async () => {
      const db = this.#db;
      await db.query('SET TRANSACTION READ ONLY');
      const row = await this.#exportRow(db, input.owner_id, key, input.export_id !== undefined ? EXPORT_BY_ID : EXPORT_BY_RUN);
      if (!row) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
      const stored = await this.#exportView(db, row);
      const broken = this.#integrity(stored);
      if (broken !== null) return refusal(PACKAGE_STORE_CODES.STORED_INTEGRITY, {diagnostic: {check: broken}});
      const view = await getMultiRun(db, {owner_id: row.owner_id, run_id: row.run_id});
      if (!view.ok) return refusal(view.code, {diagnostic: view.diagnostic});
      const prepared = await this.#prepare(db, view);
      // There is no replay event in this store, so replay_mismatch is false.
      const state = multiReadState({status: stored.status, binding: row.binding, current: prepared.current, replay_mismatch: false});
      const attempts = (await db.query(ATTEMPT_ROWS, [row.export_id])).rows.map(item => ({attempt_no: number(item.attempt_no), attempt_id: item.attempt_id, pass: item.pass, codes: item.codes}));
      return {ok: true, export: {export_id: row.export_id, owner_id: row.owner_id, bot_id: row.bot_id, run_id: row.run_id, pine_count: row.pine_count, package_hash: row.package_hash, binding_hash: row.binding_hash,
        created_at: row.created_at, b0: row.b0, library_versions: row.library_versions, files: stored.files.map(file => file.path)},
      status: stored.status, events: stored.events, attempts, freshness: {fresh: state.fresh, state: state.state, code: state.code, codes: [...state.codes]}, ready: state.ready};
    }, {isolation: 'REPEATABLE READ'});
  }

  /* ---------- candidate records (RD-MP-41) ---------- */

  async #openExport(owner_id, export_id) {
    if (!text(owner_id) || typeof export_id !== 'string' || !UUID.test(export_id)) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const row = await this.#exportRow(this.#db, owner_id, export_id, EXPORT_BY_ID);
    if (!row) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
    const view = await getMultiRun(this.#db, {owner_id, run_id: row.run_id});
    if (!view.ok) return refusal(view.code, {diagnostic: view.diagnostic});
    return {ok: true, row, view, contract: view.run.contract};
  }

  /** One compile record for the member indicator.pine of the export. record: the fixture compile record shape without ordinal. */
  recordCompile({owner_id, export_id, ordinal, record}) {
    return this.#transact(async () => {
      const opened = await this.#openExport(owner_id, export_id);
      if (opened.ok !== true) return opened;
      const file = (await this.#db.query('SELECT sha256 FROM public.mp_package_files WHERE export_id=$1 AND path=$2', [export_id, 'members/' + ordinal + '/indicator.pine'])).rows[0];
      const body = record ?? fixtureCompileRecord({indicatorSha256: file?.sha256 ?? '0'.repeat(64)});
      const at = this.#clock();
      await this.#db.query(`INSERT INTO public.mp_package_compile_records(export_id,ordinal,indicator_sha256,pine_version,errors,warnings,unresolved_references,collisions,duplicate_bindings,mapping_check,
        compiled_at_ms,compiled_at_utc,operator_role,method) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`, [export_id, ordinal, body.indicator_sha256, body.pine_version,
        JSON.stringify(body.errors), JSON.stringify(body.warnings), body.unresolved_references, body.collisions, body.duplicate_bindings, JSON.stringify(body.mapping_check), at, isoOf(at), body.operator_role, body.method]);
      return {ok: true};
    });
  }
  /** One evidence record (kind, record). record defaults to the passing fixture record of the member. */
  recordEvidence({owner_id, export_id, ordinal, kind, record}) {
    return this.#transact(async () => {
      const opened = await this.#openExport(owner_id, export_id);
      if (opened.ok !== true) return opened;
      const member = opened.contract.members.find(item => item.ordinal === ordinal);
      const body = record ?? (member ? fixtureEvidenceRecord(opened.contract, member, kind) : null);
      if (body === null) return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID, {field: 'ordinal'});
      const evidenceHash = digest(body);
      await this.#db.query('INSERT INTO public.mp_package_evidence_records(export_id,ordinal,kind,record,evidence_hash,recorded_at_ms) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
        [export_id, ordinal, kind, JSON.stringify(body), evidenceHash, this.#clock()]);
      return {ok: true, evidence_hash: evidenceHash};
    });
  }
  /** One clearance of a candidate blocker for one member: it names the digest of the newest evidence record of the blocker's kind. */
  recordClearance({owner_id, export_id, blocker, ordinal}) {
    return this.#transact(async () => {
      const opened = await this.#openExport(owner_id, export_id);
      if (opened.ok !== true) return opened;
      const kind = Object.hasOwn(CLEARANCE_KIND, blocker) ? CLEARANCE_KIND[blocker] : null;
      const records = await this.#records(this.#db, opened.row, opened.contract);
      const proof = kind === null ? null : records.chosen.get(ordinal + ':' + kind);
      const selected = runFor(opened.view).result?.selected;
      if (!proof || !isObject(selected?.parameters)) return refusal(PACKAGE_STORE_CODES.BUILD_INPUT_INVALID, {field: 'evidence'});
      await this.#db.query('INSERT INTO public.mp_package_clearances(export_id,blocker,ordinal,run_id,parameter_hash,evidence_hash,recorded_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [export_id, blocker, ordinal, opened.row.run_id, digest(selected.parameters), proof.evidence_hash, this.#clock()]);
      return {ok: true};
    });
  }
  /** All fixture records of the export: a compile record and the four evidence kinds per member, and a clearance per candidate blocker and member. skip: ["<ordinal>:<kind>"] leaves records out
   * ("<ordinal>:compile" for the compile record, "<ordinal>:clearance" for that member's clearances) so a test can model missing evidence. */
  async recordFixtureRecords({owner_id, export_id, skip = []}) {
    const opened = await this.#openExport(owner_id, export_id);
    if (opened.ok !== true) return opened;
    const cut = new Set(skip);
    for (const member of opened.contract.members) {
      const n = member.ordinal;
      if (!cut.has(n + ':compile')) { const out = await this.recordCompile({owner_id, export_id, ordinal: n}); if (out.ok !== true) return out; }
      for (const kind of EVIDENCE_KINDS) if (!cut.has(n + ':' + kind)) { const out = await this.recordEvidence({owner_id, export_id, ordinal: n, kind}); if (out.ok !== true) return out; }
      if (!cut.has(n + ':clearance')) for (const blocker of opened.contract.acceptance_blockers.filter(name => CANDIDATE_BLOCKERS.includes(name))) {
        if (cut.has(n + ':' + CLEARANCE_KIND[blocker])) continue;
        const out = await this.recordClearance({owner_id, export_id, blocker, ordinal: n});
        if (out.ok !== true) return out;
      }
    }
    return {ok: true};
  }

  /* ---------- one validation attempt ---------- */

  attempt(input) {
    if (!isObject(input) || !text(input.owner_id) || typeof input.export_id !== 'string' || !UUID.test(input.export_id)) return Promise.resolve(refusal(PACKAGE_STORE_CODES.NOT_FOUND));
    const {owner_id, export_id} = input;
    return this.#transact(async () => {
      const db = this.#db;
      const row = await this.#exportRow(db, owner_id, export_id, EXPORT_BY_ID);
      if (!row) return refusal(PACKAGE_STORE_CODES.NOT_FOUND);
      const stored = await this.#exportView(db, row);
      if (stored.status !== 'EXPORT_CANDIDATE') return refusal(PACKAGE_STORE_CODES.EXPORT_NOT_OPEN, {status: stored.status});
      const broken = this.#integrity(stored);
      if (broken !== null) return refusal(PACKAGE_STORE_CODES.STORED_INTEGRITY, {diagnostic: {check: broken}});
      const view = await getMultiRun(db, {owner_id, run_id: row.run_id});
      if (!view.ok) return refusal(view.code, {diagnostic: view.diagnostic});
      const attempts = (await db.query(ATTEMPT_ROWS, [export_id])).rows;
      const attemptNo = attempts.length + 1;
      if (attemptNo > MAX_VALIDATION_ATTEMPTS) return refusal(PACKAGE_STORE_CODES.EXPORT_NOT_OPEN, {status: stored.status});
      const run = runFor(view), contract = run.contract;
      // RD-MP-48 N3: the live engine must be the engine of the run, as at the build. A mismatch writes no attempt row.
      const engine = await this.#liveEngine();
      if (engine !== contract.engine_hash) return refusal(PACKAGE_STORE_CODES.ENGINE_MISMATCH, {stage: 'ENGINE'});
      const prepared = await this.#prepare(db, view);
      const records = await this.#records(db, row, contract);
      const closure = await this.#liveClosure();
      let trace = [];
      try { trace = [...deriveMultiTrace({run, producer_closure_hash: closure}).records]; } catch { trace = []; }
      const files = Object.fromEntries(stored.files.map(file => [file.path, toBuffer(file.content).toString('utf8')]));
      const validator = digest({gates: MULTI_PACKAGE_GATE_VERSION, producer_closure_hash: closure, engine_hash: engine});
      const now = this.#clock();
      const attemptId = 'attempt-' + randomUUID();
      const subject = {owner_id, run, internal: true, deployments: prepared.deployments, current_rules: this.#currentRules, files, package_hash: row.package_hash, binding_hash: row.binding_hash,
        binding: row.binding, export_id, export: {library_versions: row.library_versions}, member_sources: prepared.members, compile_records: records.compile_records,
        native_alert_isolation: prepared.isolation, evidence: records.evidence, clearances: records.clearances, current: prepared.current,
        hard_limits: tightenBounds(serverHardLimits(), this.#limits), bridge_bounds: tightenBounds(bridgeBoundsOf(contract), this.#bounds), dataset: prepared.dataset, trace_reproduction: trace,
        attempt: {attempt_id: attemptId, validator_engine_hash: validator, validated_at_utc: isoOf(now)}, attempt_no: attemptNo, replay_mismatch: false};
      await this.#step('GATES', {evidence: records.evidence});
      const result = evaluateMultiPackage(subject);
      if (isRefused(result)) return refusal(String(result.refused), {fields: [...result.fields], ready: false});
      if (result.status === null || (result.pass && !isObject(result.record))) return refusal('BI_TRANSITION_INVALID', {codes: [...result.next.codes]});
      const refs = {compile_ordinals: records.compile_records.map(item => item.ordinal), evidence_hashes: Object.fromEntries([...records.chosen].map(([key, item]) => [key, item.evidence_hash])),
        clearances: records.clearances.length, trace_producer_closure_hash: closure};
      const codes = [...result.codes];
      await db.query(`INSERT INTO public.mp_package_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`, [export_id, attemptNo, attemptId, row.package_hash, result.pass, codes, JSON.stringify(result.gates), JSON.stringify(refs), validator, now, isoOf(now)]);
      if (result.pass) {
        const record = result.record;
        await db.query(`INSERT INTO public.mp_package_validations(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,mode,validated_at_ms,validated_at_utc)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`, [export_id, record.package_hash, record.binding_hash, record.attempt_id, JSON.stringify(record.gate_results), record.validator_engine_hash, record.fixture, 'MULTI_PINE',
          now, record.validated_at_utc]);
      }
      const seq = stored.events[stored.events.length - 1].seq + 1;
      await db.query('INSERT INTO public.mp_package_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,$2,$3,$4,$5,$6,$7)', [export_id, seq, result.status, [...result.next.codes], attemptNo, now, isoOf(now)]);
      return {ok: true, attempt_no: attemptNo, attempt_id: attemptId, pass: result.pass, status: result.status, codes, gates: result.gates.map(item => ({gate: item.gate, state: item.state, codes: [...item.codes]})),
        diagnostics: result.diagnostics, event_codes: [...result.next.codes], ready: false};
    });
  }
}
