import {canonical, hash, executable} from '../pine-bridge/source.js';
import {assemble} from '../pine-bridge/template.js';
import {transition, RETRYABLE_CODES, isRetryable, evaluateQualification, notReached, CODE_PATTERN, MANIFEST_SCHEMA, packageHash, bindingHash, scanContent, ownerRecommendationGate,
  RECOMMENDATION_COMPLETION_REASON, CANDIDATE_BLOCKERS, MULTI_PINE_CONTRACT_VERSION, MULTI_PINE_BLOCKER, SUPPORTED_EXIT_VERSIONS, TRACE_FILES, FRESHNESS_ORDER, searchedWindow} from '../quant-library/package-gates.js';
import {holdoutWindow, windowsOverlap} from '../quant-library/derive.js';
import {multiPackageFiles, MULTI_BINDING_FIELDS, PACKAGE_MARKET, multiBindingComplete} from './package-render.js';
import {MP_TRACE_METHOD, MP_BASELINE_VERSION, deriveMultiTrace} from './package-trace.js';
import {MP_CODES, MP_MODE, MP_MIN_MEMBERS, MP_MAX_MEMBERS} from './codes.js';

/**
 * F11 R6-2: pure gate layer of the multi-Pine package (docs/MULTI_PINE_CONTRACT.md 6.3, RD-MP-37, RD-MP-38). It reads no database, no file, no network, no clock and no random
 * source, and it is wired into no route, worker, table or UI. Every input is a plain value that the caller took from durable rows or from the package bytes; every output is a
 * frozen plain value. A gate result is {gate, state, pass, codes}: state is PASS, FAIL or NOT_REACHED. Missing, null, empty, unreadable or wrong-type input is a FAIL with a
 * code, never a pass, a skip or an exception. B0 is a build-time gate; the attempt-time evaluation (evaluateMultiPackage) runs C1 to C4 and Q only.
 *
 * Freshness tuple F (MPC 6.1) and its pair term (RD-MP-46 B1). The pair of the F tuple is the FROZEN shared deployment pair: the Bridge pair that every member deployment snapshot
 * carries as selection.bridge since before the research. It is not the selected candidate pair (the research result may select any pair of the domains). There is no server state
 * for a "current selected pair", so this module compares no pair in the freshness codes. A change of the frozen deployment pair changes the deployment snapshot, therefore
 * deployment_snapshot_hash of the member, therefore input_lock_hash, and BI_SELECTION_CHANGED reports it through input_lock_hash. Shared pair equality across the member
 * deployments is a B0 check (MP_BRIDGE_PAIR_DIVERGENT).
 *
 * B0 freshness (RD-MP-46 B2). B0 takes the same current input as C4 and compares it with the FROZEN tuple that the module derives from the run contract (not from the caller binding):
 * membership, source versions and hashes, deployments, policy, capital, funding cutoff and input_lock_hash. Any difference, and any unreadable or absent current state, gives
 * MP_MEMBER_SET_STALE (the stale code MPC 8.2 names for a stale member set). BI_DATASET_UNAVAILABLE is not a member-set term and is judged by C3 and C4 only.
 *
 * Deployment snapshot binding (RD-MP-46 N3, N4). Every member needs exactly one entry of deployments (by deployment_id) whose snapshot has hash(canonical(snapshot)) equal to the
 * contract member deployment_snapshot_hash. B0 reads the market and the pair only from such a bound snapshot; any missing, duplicated or unbound entry gives
 * HOLDOUT_INDEPENDENCE_NOT_CHECKED (the market of the member cannot be trusted). C3 reports an unbound snapshot as BI_FIXED_INPUT_CHANGED and a duplicate through the exit-version check.
 *
 * This module imports only the exported one-Pine helpers that read no one-Pine contract or result shape (RD-MP-38) and the R6-1 modules. The helpers that do read a one-Pine
 * shape (the B0 library checks, the exposure check, the robustness check, the C1 to C4 gates) are re-implemented here for the multi shape: selected train and validation at top
 * level, sensitivity entries with top-level validation, the search record as result.search, the market key from the frozen member deployments, the run creation time from
 * created_at_ms. The one-Pine module is not edited, so its T-R suite and the engine hash stay unchanged.
 *
 * The EXPORT_INTERNAL path (RC-11): a pass of C1 to C4 leads to EXPORT_INTERNAL, which is terminal and never READY. The Q record has the shape of a one-Pine validation record plus
 * mode MULTI_PINE and fixture true (RD-MP-37). Nothing here writes it. It is never read by a G8, QR-3 or QR-4 reader, so G8 and QUALIFIED_TOTAL do not change.
 *
 * Input shapes (the caller is the store reader of R6-4):
 *   run         {owner_id, bot_id, run_id, status, contract, contract_hash, submission_hash, result, created_at_ms}: the durable multi-Pine run view. contract.members are in
 *               ordinal order. The module recomputes the contract hash and the result tie itself; it takes no integrity flag from the caller.
 *   holdout     {earlier_holdouts, earlier_searched, registered_boundary, exposure_register}: the lookups of PKG 5.0 item 5. The multi exposure market key does not come from here.
 *   deployments [{deployment_id, exit_version, snapshot}]: the frozen member deployments with their FULL stored snapshots (market, selection.bridge and the rest). Exactly one per
 *               contract member (by deployment_id), and hash(canonical(snapshot)) equals the member deployment_snapshot_hash.
 *   member_sources [{ordinal, source, signals:{buy, exit}}]: the original member sources (hash-bound to the contract members) and the signal mapping, as the renderer received them.
 *   compile_records [{ordinal, export_id, indicator_sha256, ...}] one per member file; native_alert_isolation [{ordinal, routes_disabled, unrelated_payloads, native_payloads}].
 *   evidence    {members:[{ordinal, dataset_alignment, native_parity, bridge_parity, repaint}]}: each record names scope {source_hash, effective_input_hash, dataset_digest,
 *               engine_hash, deployment_id, ordinal} (RD-MP-41). There is no Bot-level quant_baseline record; the combined baseline of the run result is the baseline (RD-MP-30).
 *   clearances  [{blocker, run_id, export_id, ordinal, parameter_hash, evidence_hash}]: one per (candidate blocker, ordinal).
 *   current     {membership:[{pine_import_id, source_version, source_hash, deployment_id}], membership_hash, policy_hash, capital, funding_cutoff, input_lock_hash, dataset_available,
 *               bot_owner_id}. capital is {equity, cash} of the contract form (not capital_basis_hash). input_lock_hash is recomputed by the caller with the RD-MP-44 R4 recipe
 *               from the current member state: hash(canonical({bridge_domains, members:[{ordinal, effective_input_hash, deployment_snapshot_hash}]})). A current.bridge_pair, if
 *               present, is not read (see the freshness note above).
 *
 * Trace trust (RD-MP-46 N1). C3 does not trust the caller trace records. It re-derives the trace with deriveMultiTrace({run, producer_closure_hash}) (a pure sibling import) using the
 * producer_closure_hash of each record, and the caller must pass the record of the closure hash of the code that is running. This module cannot read that hash.
 */
export const MULTI_PACKAGE_GATE_VERSION = 'best-inputs-multi-gates-v1';
export const MAX_VALIDATION_ATTEMPTS = 5;
export const MULTI_GATES = Object.freeze(['B0', 'C1', 'C2', 'C3', 'C4', 'Q']);
export const QUALIFYING_GATES = Object.freeze(['C1', 'C2', 'C3', 'C4']);
export const MULTI_MANIFEST_PATH = 'quant-data/manifest.json';
export const MULTI_STATUS = Object.freeze({EXPORT_CANDIDATE: 'EXPORT_CANDIDATE', EXPORT_INTERNAL: 'EXPORT_INTERNAL', EXPORT_REFUSED: 'EXPORT_REFUSED'});
export const INPUT_INVALID = 'INPUT_INVALID';
export const REPLAY_STATE_UNAVAILABLE = 'BI_REPLAY_STATE_UNAVAILABLE';
/** OD-4: the versioned episode gate does not exist yet, so no non-fixture package can pass B0 (mirrors EPISODE_GATE_VERSION of the one-Pine module). */
const EPISODE_GATE_VERSION = null;
const ADMITTED_COST_MODELS = Object.freeze(['paper-close-v1']);
/** Reviewed Bridge templates by exit version. Only bridge-exit-v2 has one today (the one-Pine module keeps the same map privately). */
const EXIT_TEMPLATES = Object.freeze({'bridge-exit-v2': assemble});
const CLEARANCE_EVIDENCE = Object.freeze({VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED: 'native_parity', CUSTOM_REPAINT_EVIDENCE_REQUIRED: 'repaint'});
const CANDIDATE_BLOCKER_SET = new Set(CANDIDATE_BLOCKERS);
const RETRYABLE = new Set(RETRYABLE_CODES);
const COMPLETED = new Set(['SUCCEEDED', 'NO_VALID_CANDIDATE']);
const RULE_KEYS = ['minimum_closed_trades_train', 'minimum_closed_trades_validation', 'minimum_closed_trades_test', 'maximum_drawdown_percent', 'sensitivity_max_drop_percentage_points'];
const METRIC_KEYS = ['bars', 'closed_trades', 'start_equity', 'end_equity', 'net_return_percent', 'max_drawdown_percent', 'profit_factor', 'gross_profit', 'gross_loss'];
const DECIMAL_METRICS = METRIC_KEYS.filter(key => key !== 'bars' && key !== 'closed_trades');
const PARTITIONS = ['train', 'validation', 'test'];
const BRIDGE_NAMES = ['atr_multiplier', 'rr'];
const MINUTE = 60_000;
const DATASET_METADATA_VERSION = 'spot-dataset-v1';
const DATASET_SOURCE = 'binance-spot-klines-v1';
const HEX64 = /^[a-f0-9]{64}$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/* ---- small helpers ---- */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => value !== undefined && value !== null;
const has = (object, key) => isObject(object) && Object.hasOwn(object, key);
const text = value => typeof value === 'string' && value.length > 0;
const sha = value => typeof value === 'string' && HEX64.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const utc = value => typeof value === 'string' && UTC.test(value) && !Number.isNaN(Date.parse(value));
/** at_utc (exposure register) accepts at most three fraction digits; Date.parse would drop the rest. */
const utcMs = value => utc(value) && !/\.\d{4,}Z$/.test(value);
const list = value => Array.isArray(value) ? value : [];
const decimalNumber = value => finite(value) ? value : typeof value === 'string' && DECIMAL.test(value) ? Number(value) : NaN;
const canon = value => { try { const out = canonical(value); return typeof out === 'string' ? out : null; } catch { return null; } };
const same = (a, b) => { const left = canon(a); return left !== null && left === canon(b); };
const digest = value => { const out = canon(value); return out === null ? null : hash(out); };
const unique = values => [...new Set(values)];
const byKey = key => (a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
const sortedBy = (items, key) => list(items).filter(isObject).sort(byKey(key));
const bytesOf = content => typeof content === 'string' ? Buffer.from(content, 'utf8') : content instanceof Uint8Array ? content : null;
const textOf = content => { const bytes = bytesOf(content); return bytes === null ? null : typeof content === 'string' ? content : new TextDecoder().decode(bytes); };
const parseJson = content => { const source = textOf(content); if (source === null) return undefined; try { return JSON.parse(source); } catch { return undefined; } };
const frozenList = items => Object.freeze(items.map(item => Object.freeze({...item})));

/** A gate result. codes keep the order of the checks and are unique. diagnostics name the member of a member-scoped code ({code, ordinal, pine_import_id}). */
function outcome(gate, codes, extra = {}) {
  const found = unique(codes);
  return Object.freeze({gate, state: found.length ? 'FAIL' : 'PASS', pass: found.length === 0, codes: Object.freeze(found), ...extra});
}
/** Runs a gate body. A wrong-type input never throws out of a gate: an unexpected exception becomes the gate's fallback code, which is non-retryable. */
const guarded = (gate, fallback, body, extra = {}) => { try { return body(); } catch { return outcome(gate, [fallback], extra); } };
/** The fallback result of B0 has the normal B0 shape (limitations and g7), so a caller never meets a short result (RD-MP-46 N5). */
const B0_FALLBACK_FIELDS = Object.freeze({limitations: Object.freeze([]), g7: Object.freeze({gate: 'G7', state: 'FAIL', code: 'OWNER_RECOMMENDATION_NOT_READY'})});
const refusal = (gate, fields, reason = INPUT_INVALID) => Object.freeze({gate, refused: reason, fields: Object.freeze([...fields]), pass: false, codes: Object.freeze([])});
export const isRefused = result => isObject(result) && typeof result.refused === 'string';
/** A failure with at least one non-retryable code is a hard failure: the gates after it are NOT_REACHED. */
export const isHardFailure = result => isObject(result) && result.state === 'FAIL' && list(result.codes).some(code => !RETRYABLE.has(code));

/** A collector for member-scoped codes. */
function collector() {
  const codes = [], diagnostics = [];
  return {codes, diagnostics, add: (code, member) => { codes.push(code); if (member) diagnostics.push({code, ordinal: member.ordinal, pine_import_id: member.pine_import_id}); }};
}

/* ---- contract shape helpers ---- */

const rulesOf = contract => { const rules = contract?.rules; return isObject(rules) && RULE_KEYS.every(key => finite(rules[key])) ? rules : null; };
const membersOf = contract => { const members = contract?.members; return Array.isArray(members) && members.every(isObject) ? sortedBy(members, 'ordinal') : []; };
const selectedOf = result => isObject(result) && isObject(result.selected) ? result.selected : null;
const selectedReasons = selected => isObject(selected) && Array.isArray(selected.screen_reasons) ? selected.screen_reasons.filter(item => typeof item === 'string').map(item => item.slice(0, 64)).slice(0, 20) : [];
/** Mode of a run from its frozen contract (server-resolved, never the claimed binding): MULTI_PINE for 2 to 3 members with a dense pine_count, else null. */
const modeOfRun = contract => isObject(contract) && contract.mode === MP_MODE && Array.isArray(contract.members) && contract.members.length >= MP_MIN_MEMBERS && contract.members.length <= MP_MAX_MEMBERS
  && contract.members.every(isObject) && contract.pine_count === contract.members.length ? MP_MODE : null;
/**
 * The EXPORT_INTERNAL path (RC-11): true only when the package is created internal (an explicit true), the claimed mode and the mode derived from the frozen contract are both
 * MULTI_PINE, and the contract version is the multi-Pine research contract version. A mode or version mismatch never gets the tolerance and is refused with BI_BINDING_MISMATCH at B0.
 */
const internalPath = (internal, contract, claimedMode) => internal === true && claimedMode === MP_MODE && modeOfRun(contract) === MP_MODE && isObject(contract) && contract.version === MULTI_PINE_CONTRACT_VERSION;
const datasetDigest = ref => isObject(ref) ? (text(ref.sha256) ? ref.sha256 : text(ref.content_digest) ? ref.content_digest : null) : null;
const marketPick = market => isObject(market) && [market.broker, market.symbol, market.timeframe].every(text) ? {broker: market.broker, symbol: market.symbol, timeframe: market.timeframe} : null;

/* ---- Gate B0: build eligibility (PKG 5.0 mirrored for the multi shape, MPC 6.3) ---- */

const windowList = value => Array.isArray(value) && value.every(item => isObject(item) && Number.isSafeInteger(item.start_time) && Number.isSafeInteger(item.end_time) && item.start_time <= item.end_time) ? value : null;
const boundaryKnown = value => isObject(value) && (value.exists === false || (value.exists === true && Number.isSafeInteger(value.start_time) && (!has(value, 'ref') || isObject(value.ref))));
/** Where the registered boundary has a ref, the packaged holdout_boundary_ref must equal it; both absent is allowed. */
function boundaryRefMismatch(binding, lookups) {
  const boundary = isObject(lookups) ? lookups.registered_boundary : undefined;
  if (!boundaryKnown(boundary) || !isObject(binding)) return false;
  const expected = boundary.exists === true && has(boundary, 'ref') ? boundary.ref : undefined, actual = has(binding, 'holdout_boundary_ref') ? binding.holdout_boundary_ref : undefined;
  return expected === undefined ? actual !== undefined : !same(expected, actual);
}
/** Exposure register entry (OD-19): a QR-3 event or a QR-4 record, as the one-Pine module reads it. Anything else is malformed. */
function exposureEntry(entry) {
  if (!isObject(entry) || !text(entry.owner_id) || marketPick(entry.market) === null || !utcMs(entry.at_utc) || windowList([entry.window]) === null) return null;
  const qr3 = has(entry, 'comparison_id'), qr4 = has(entry, 'selection_id');
  if (qr3 === qr4 || (qr3 && !(text(entry.comparison_id) && sha(entry.source_hash))) || (qr4 && !text(entry.selection_id))) return null;
  return {owner_id: entry.owner_id, market_key: canon(marketPick(entry.market)), window: entry.window, at: Date.parse(entry.at_utc)};
}
/**
 * The frozen deployment of every contract member: exactly one entry of deployments per member (by deployment_id; a duplicate is not resolved silently) whose snapshot hashes to the
 * member deployment_snapshot_hash. {member, deployment} per member in ordinal order, or null when any member lacks such an entry (RD-MP-46 N3, N4).
 */
function boundDeployments(contract, deployments) {
  const members = membersOf(contract), items = list(deployments).filter(isObject), bound = [];
  if (members.length === 0) return null;
  for (const member of members) {
    const mine = items.filter(item => item.deployment_id === member.deployment_id);
    if (mine.length !== 1 || !isObject(mine[0].snapshot) || !sha(member.deployment_snapshot_hash) || digest(mine[0].snapshot) !== member.deployment_snapshot_hash) return null;
    bound.push({member, deployment: mine[0]});
  }
  return bound;
}
/**
 * The market of a multi run: the market of each bound member deployment snapshot. {key} when every member has one and all are equal and equal the fixed market;
 * {code} otherwise (J2: contract.snapshot.market does not exist on the multi contract). An unbound or unreadable snapshot is "not checked".
 */
function multiMarket(bound) {
  if (bound === null) return {code: 'HOLDOUT_INDEPENDENCE_NOT_CHECKED'};
  const markets = bound.map(({deployment}) => marketPick(deployment.snapshot.market));
  if (markets.includes(null)) return {code: 'HOLDOUT_INDEPENDENCE_NOT_CHECKED'};
  const keys = unique(markets.map(canon));
  if (keys.length > 1) return {code: MP_CODES.MARKET_MIXED};
  if (keys[0] !== canon(PACKAGE_MARKET)) return {code: 'BI_MARKET_SCOPE_INVALID'};
  return {key: keys[0]};
}
/** The frozen Bridge pair of one deployment snapshot (selection.bridge, exactly atr_multiplier and rr, decimal strings or numbers), as numbers; null when unreadable. */
function snapshotPair(snapshot) {
  const bridge = snapshot?.selection?.bridge;
  if (!isObject(bridge) || Object.keys(bridge).length !== 2) return null;
  const atr = decimalNumber(bridge.atr_multiplier), rr = decimalNumber(bridge.rr);
  return atr > 0 && rr > 0 ? {atr_multiplier: atr, rr} : null;
}
/** MPC 6.3 B0: shared pair equality. Every bound member deployment carries the same frozen pair; an unreadable pair cannot be shown equal. An unbound set is reported elsewhere. */
function sharedPairCodes(bound) {
  if (bound === null) return [];
  const pairs = bound.map(({deployment}) => snapshotPair(deployment.snapshot));
  return pairs.includes(null) || unique(pairs.map(canon)).length > 1 ? [MP_CODES.BRIDGE_PAIR_DIVERGENT] : [];
}
/** An entry counts only for the same owner and the same canonical market, and only when at_utc is at or before the run's durable creation time (created_at_ms). */
function exposureCodes(run, own, register, bound) {
  const entries = Array.isArray(register) ? register.map(exposureEntry) : null;
  if (entries === null || entries.includes(null) || !Number.isSafeInteger(run.created_at_ms) || run.created_at_ms < 0) return ['BI_EXPOSURE_REGISTER_UNAVAILABLE'];
  const market = multiMarket(bound);
  if (market.key === undefined) return [market.code];
  if (own === null) return ['HOLDOUT_INDEPENDENCE_NOT_CHECKED'];
  return entries.some(entry => entry.owner_id === run.owner_id && entry.market_key === market.key && entry.at <= run.created_at_ms && windowsOverlap(own, entry.window)) ? ['BI_HOLDOUT_EXPOSED_BY_SELECTION'] : [];
}
/** J2: selected train and validation are top-level, sensitivity entries carry validation at top level, and cost_stress carries validation at top level. */
function robustnessCodes(selected, rules) {
  const stored = selectedReasons(selected), codes = [], base = decimalNumber(selected.validation?.net_return_percent);
  let sensitivity = stored.includes('SENSITIVITY_FAILED') || !Array.isArray(selected.sensitivity);
  if (rules && Array.isArray(selected.sensitivity)) for (const item of selected.sensitivity) {
    const validation = isObject(item) ? item.validation : undefined;
    if (!(decimalNumber(validation?.net_return_percent) >= base - rules.sensitivity_max_drop_percentage_points) || !(validation?.closed_trades >= rules.minimum_closed_trades_validation)) sensitivity = true;
  }
  let stress = stored.includes('COST_STRESS_FAILED') || !isObject(selected.cost_stress);
  if (rules && isObject(selected.cost_stress)) {
    const validation = selected.cost_stress.validation;
    if (!(decimalNumber(validation?.net_return_percent) >= 0) || !(validation?.closed_trades >= rules.minimum_closed_trades_validation)) stress = true;
  }
  if (sensitivity) codes.push('SENSITIVITY_FAILED');
  if (stress) codes.push('COST_STRESS_FAILED');
  return codes;
}
function holdoutCodes(result, selected, rules) {
  if (result.holdout_evaluated !== true || !isObject(selected.test)) return ['HOLDOUT_NOT_EVALUATED'];
  const stored = selectedReasons(selected), test = selected.test, codes = [];
  if (stored.includes('INSUFFICIENT_TEST_TRADES') || (rules && !(test.closed_trades >= rules.minimum_closed_trades_test))) codes.push('INSUFFICIENT_TEST_TRADES');
  if (stored.includes('NEGATIVE_HOLDOUT_RETURN') || (rules && !(decimalNumber(test.net_return_percent) >= 0))) codes.push('NEGATIVE_HOLDOUT_RETURN');
  if (stored.includes('TEST_DRAWDOWN_EXCEEDED') || (rules && !(decimalNumber(test.max_drawdown_percent) <= rules.maximum_drawdown_percent))) codes.push('TEST_DRAWDOWN_EXCEEDED');
  return codes;
}
function independenceCodes(run, contract, lookups, bound) {
  const own = holdoutWindow(contract), source = isObject(lookups) ? lookups : {};
  const earlier = windowList(source.earlier_holdouts), searched = windowList(source.earlier_searched), boundary = source.registered_boundary;
  const codes = [];
  if (own === null || earlier === null || searched === null || !boundaryKnown(boundary)) codes.push('HOLDOUT_INDEPENDENCE_NOT_CHECKED');
  else {
    if (earlier.some(window => windowsOverlap(own, window))) codes.push('HOLDOUT_WINDOW_REUSED');
    if (searched.some(window => windowsOverlap(own, window))) codes.push('BI_HOLDOUT_OVERLAPS_SEARCHED_DATA');
    if (boundary.exists === true && own.start_time < boundary.start_time) codes.push('BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY');
  }
  codes.push(...exposureCodes(run, own, source.exposure_register, bound));
  return codes;
}
/** Library gates G1 to G5 recomputed under the run's own frozen rules, for the multi shape. The first failing gate of G1 to G4 stops the list, as derive.js does. */
function libraryCodes(run, lookups, bound) {
  const contract = isObject(run.contract) ? run.contract : {}, result = run.result, rules = rulesOf(contract);
  if (!COMPLETED.has(run.status)) return ['STATUS_NOT_COMPLETED'];
  if (!isObject(result)) return ['NO_RESULT'];
  // The module recomputes the contract hash and the result tie itself (no caller flag).
  if (!isObject(run.contract) || !sha(run.contract_hash) || run.contract_hash !== digest(run.contract) || result.run_id !== run.run_id || result.contract_hash !== run.contract_hash) return ['INTEGRITY_CHECK_FAILED'];
  const codes = [];
  if (run.status !== 'SUCCEEDED' || result.completion_reason !== RECOMMENDATION_COMPLETION_REASON) codes.push('BI_RUN_NOT_QUALIFIABLE');
  const selected = selectedOf(result);
  const sampled = selected && (!rules || (selected.train?.closed_trades >= rules.minimum_closed_trades_train && selected.validation?.closed_trades >= rules.minimum_closed_trades_validation));
  if (!selected || !sampled) return [...codes, 'NO_SCREENED_CANDIDATE'];
  const robustness = robustnessCodes(selected, rules);
  if (robustness.length) return [...codes, ...robustness];
  const holdout = holdoutCodes(result, selected, rules);
  if (holdout.length) return [...codes, ...holdout];
  return [...codes, ...independenceCodes(run, contract, lookups, bound)];
}
const searchRecordPresent = (result, contract) => isObject(result.search) && text(result.search.algorithm) && Number.isSafeInteger(result.search.seed) && count(result.search.budget) && count(result.search.planned)
  && text(result.completion_reason) && isObject(contract.bridge_domains);
const dimensionCoverageFull = result => isObject(result.search) && result.search.dimension_coverage_percent === 100 && Number.isSafeInteger(result.search.selected_dimensions) && result.search.selected_dimensions > 0
  && result.search.covered_dimensions === result.search.selected_dimensions;
/** Unknown blocker codes are never tolerated. On the internal path only, MULTI_PINE_REQUIRES_APP_3B does not refuse B0 (RC-11). */
function blockerCodes(contract, internal) {
  const blockers = contract.acceptance_blockers;
  if (!Array.isArray(blockers) || !blockers.every(text)) return ['BLOCKERS_UNKNOWN'];
  return blockers.some(name => !CANDIDATE_BLOCKER_SET.has(name) && !(internal && name === MULTI_PINE_BLOCKER)) ? ['BI_CAPABILITY_BLOCKER_PRESENT'] : [];
}
/** RULES_VERSION_DIFFERS is informational: the run's own frozen rules differ from the current rules. */
const rulesLimitations = (contract, current) => { const rules = rulesOf(contract); return rules && isObject(current) && !same(rules, current) ? ['RULES_VERSION_DIFFERS'] : []; };
/** MPC 6.3 added B0 checks that do not need a lookup: one exit version for all members. */
function exitVersionCodes(contract) {
  const versions = membersOf(contract).map(member => member.exit_version);
  if (versions.length === 0) return [];
  if (unique(versions).length > 1) return [MP_CODES.EXIT_VERSION_MIXED];
  return SUPPORTED_EXIT_VERSIONS.includes(versions[0]) ? [] : ['BI_EXIT_VERSION_UNSUPPORTED'];
}
/**
 * B0. subject: {owner_id, run, holdout, deployments, binding, internal, current_rules, current}. See the header for run, holdout, deployments and current. current_rules is required input;
 * current is read like C4 reads it and an unreadable or stale current gives MP_MEMBER_SET_STALE (RD-MP-46 B2). binding.mode must
 * equal the mode of the frozen contract (BI_BINDING_MISMATCH). internal is the created-internal flag; only on the EXPORT_INTERNAL path (mode MULTI_PINE and the multi-Pine contract
 * version) do MULTI_PINE_REQUIRES_APP_3B and a G7 FAIL (completion reason RESEARCH_CANDIDATE_PENDING_ACCEPTANCE with the unlisted multi-Pine version) not refuse B0. A foreign or absent
 * run gives NOT_FOUND and nothing else. The result carries g7, the G7 gate as the one-Pine derivation gives it (OD-18). The guarded fallback of an unexpected exception is the same
 * result shape with HOLDOUT_INDEPENDENCE_NOT_CHECKED, empty limitations and a G7 FAIL.
 */
export function evaluateMultiBuildEligibility(subject) {
  return guarded('B0', 'HOLDOUT_INDEPENDENCE_NOT_CHECKED', () => {
    const s = isObject(subject) ? subject : {}, run = s.run;
    if (!text(s.owner_id) || !isObject(run) || run.owner_id !== s.owner_id) return outcome('B0', ['NOT_FOUND'], {limitations: Object.freeze([])});
    if (!isObject(s.current_rules)) return refusal('B0', ['current_rules']);
    const contract = isObject(run.contract) ? run.contract : {}, binding = isObject(s.binding) ? s.binding : {}, rules = rulesOf(contract), bound = boundDeployments(contract, s.deployments), codes = [...libraryCodes(run, s.holdout, bound)];
    if (isObject(run.result)) {
      if (!searchRecordPresent(run.result, contract)) codes.push('BI_SEARCH_RECORD_MISSING');
      if (!dimensionCoverageFull(run.result)) codes.push('BI_DIMENSION_COVERAGE');
    }
    const mode = modeOfRun(contract), internal = internalPath(s.internal, contract, binding.mode);
    codes.push(...blockerCodes(contract, internal));
    if (mode !== MP_MODE) codes.push('BI_BINDING_MISMATCH');
    else if (!internal) codes.push('BI_MULTI_PINE_INTERNAL_ONLY');
    codes.push(...exitVersionCodes(contract));
    // MPC 6.3 B0: the deployments are bound to the frozen snapshots, the shared pair is equal, and the member set is fresh (RD-MP-46 B2, N3, N4).
    if (bound === null) codes.push('HOLDOUT_INDEPENDENCE_NOT_CHECKED');
    codes.push(...sharedPairCodes(bound), ...memberSetCodes(contract, s.current));
    if (!multiBindingComplete(s.binding) || !rules) codes.push('BI_BINDING_INCOMPLETE');
    // The claimed mode must equal the mode of the frozen contract; a created-internal package must be multi-Pine with the multi-Pine version.
    const modeMismatch = present(binding.mode) && binding.mode !== mode;
    const versionMismatch = s.internal === true && (mode !== MP_MODE || contract.version !== MULTI_PINE_CONTRACT_VERSION);
    if (boundaryRefMismatch(s.binding, s.holdout) || modeMismatch || versionMismatch) codes.push('BI_BINDING_MISMATCH');
    if (binding.fixture !== true && EPISODE_GATE_VERSION === null) codes.push('BI_EPISODE_GATE_UNAVAILABLE');
    // G7 is derived by OD-18 only. On the internal path it may stay FAIL, but only for the multi-Pine version with the PASS completion reason.
    const g7 = ownerRecommendationGate(run);
    const g7Tolerated = internal && isObject(run.result) && run.result.completion_reason === RECOMMENDATION_COMPLETION_REASON && contract.version === MULTI_PINE_CONTRACT_VERSION;
    if (g7.code && !g7Tolerated) codes.push(g7.code);
    return outcome('B0', codes, {limitations: Object.freeze(rulesLimitations(contract, s.current_rules)), g7});
  }, B0_FALLBACK_FIELDS);
}

/* ---- package reader shared by C1 to C4 ---- */

/** The package size comes from the stored run contract, else from the stored binding, never from the manifest of the package under test. */
function pineCountOf(subject) {
  for (const candidate of [subject.run?.contract?.pine_count, subject.binding?.pine_count]) if (Number.isSafeInteger(candidate) && candidate >= MP_MIN_MEMBERS && candidate <= MP_MAX_MEMBERS) return candidate;
  return null;
}
function openPackage(subject) {
  const files = isObject(subject.files) ? subject.files : null, pineCount = pineCountOf(subject);
  let layout = null;
  try { layout = pineCount === null ? null : multiPackageFiles(pineCount); } catch { layout = null; }
  const json = {};
  for (const path of layout === null ? [MULTI_MANIFEST_PATH] : layout.filter(item => item.endsWith('.json'))) json[path] = files && Object.hasOwn(files, path) ? parseJson(files[path]) : undefined;
  const manifest = isObject(json[MULTI_MANIFEST_PATH]) ? json[MULTI_MANIFEST_PATH] : null;
  return {files, json, layout, pineCount, manifest, binding: isObject(manifest?.binding) ? manifest.binding : null,
    readable: path => files !== null && Object.hasOwn(files, path) && bytesOf(files[path]) !== null};
}

/* ---- Gate C1: structure and content integrity (MPC 6.3: file set per 6.2, checksums over every member file) ---- */

const MANIFEST_KEYS = ['schema_version', 'identity', 'binding', 'files', 'inputs', 'evidence', 'limitations', 'fixture'];
const manifestValid = manifest => isObject(manifest) && Object.keys(manifest).length === MANIFEST_KEYS.length && MANIFEST_KEYS.every(key => has(manifest, key))
  && manifest.schema_version === MANIFEST_SCHEMA && isObject(manifest.identity) && text(manifest.identity.export_id) && isObject(manifest.binding)
  && isObject(manifest.inputs) && isObject(manifest.evidence) && typeof manifest.fixture === 'boolean'
  && Array.isArray(manifest.files) && manifest.files.every(file => isObject(file) && text(file.path) && sha(file.sha256) && count(file.bytes))
  && isObject(manifest.limitations) && typeof manifest.limitations.text === 'string' && Array.isArray(manifest.limitations.codes)
  && manifest.limitations.codes.every(code => typeof code === 'string' && CODE_PATTERN.test(code));
function checksumMismatch(pkg, subject) {
  const manifest = pkg.manifest, expected = pkg.layout.filter(path => path !== MULTI_MANIFEST_PATH), listed = new Set(manifest.files.map(file => file.path));
  let mismatch = listed.size !== manifest.files.length || manifest.files.some(file => !expected.includes(file.path)) || expected.some(path => !listed.has(path));
  for (const file of manifest.files) if (expected.includes(file.path) && pkg.readable(file.path)) {
    const bytes = bytesOf(pkg.files[file.path]);
    if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) mismatch = true;
  }
  return mismatch || !sha(subject.package_hash) || packageHash(manifest) !== subject.package_hash || !sha(subject.binding_hash)
    || bindingHash(manifest.binding) !== subject.binding_hash || bindingHash(subject.binding) !== subject.binding_hash;
}
function numericFormatInvalid(pkg, manifestOk) {
  if (manifestOk && !utc(pkg.manifest.identity.created_at)) return true;
  const metricsFile = pkg.json['quant-data/metrics.json'];
  if (isObject(metricsFile)) for (const name of PARTITIONS) {
    const part = metricsFile[name];
    if (!isObject(part)) continue;
    for (const key of DECIMAL_METRICS) if (Object.hasOwn(part, key) && part[key] !== null && !(typeof part[key] === 'string' && DECIMAL.test(part[key]))) return true;
    for (const key of ['bars', 'closed_trades']) if (Object.hasOwn(part, key) && part[key] !== null && !count(part[key])) return true;
    if (Object.hasOwn(part, 'win_rate') && part.win_rate !== null && !(typeof part.win_rate === 'string' && DECIMAL.test(part.win_rate))) return true;
  }
  const inputs = pkg.json['inputs.json'];
  if (isObject(inputs) && isObject(inputs.bridge)) for (const entry of Object.values(inputs.bridge)) {
    if (!isObject(entry) || typeof entry.after !== 'string' || !DECIMAL.test(entry.after) || !text(entry.unit) || !isObject(entry.domain)
      || ['min', 'max', 'step'].some(key => typeof entry.domain[key] !== 'string' || !DECIMAL.test(entry.domain[key]))) return true;
  }
  return false;
}
/** A metric the run does not have is invented. selected.train, selected.validation and selected.test are top-level in the multi shape. */
function metricFabricated(pkg, run) {
  const metricsFile = pkg.json['quant-data/metrics.json'], selected = selectedOf(run?.result);
  if (!isObject(metricsFile) || !isObject(run)) return false;
  const own = {train: selected?.train, validation: selected?.validation, test: selected?.test};
  return PARTITIONS.some(name => {
    const part = metricsFile[name], base = isObject(own[name]) ? own[name] : {};
    return isObject(part) && (METRIC_KEYS.some(key => Object.hasOwn(part, key) && !Object.hasOwn(base, key)) || (Object.hasOwn(part, 'win_rate') && part.win_rate !== null && !Object.hasOwn(base, 'win_rate')));
  });
}
/** True when the Pine file holds exactly one indicator() declaration and no strategy call in its executable code. */
function indicatorOnly(source) {
  let code;
  try { code = executable(source); } catch { return false; }
  return [...code.matchAll(/\bindicator\s*\(/g)].length === 1 && !/\bstrategy\s*(?:\(|\.)/.test(code);
}
/**
 * C1. subject: {files:{path:text|bytes}, package_hash, binding_hash, binding, run}. The file set is the layout of multiPackageFiles(pine_count) (10 + 3 * pine_count files), with pine_count
 * from the stored run (else the stored binding). Every check reports independently; a check whose input cannot be read reports its own code and its dependants stay silent.
 */
export function evaluateMultiStructure(subject) {
  return guarded('C1', 'BI_ARTIFACT_MISSING', () => {
    const s = isObject(subject) ? subject : {}, pkg = openPackage(s), codes = [];
    if (pkg.layout === null || pkg.files === null) return outcome('C1', ['BI_ARTIFACT_MISSING']);
    if (pkg.layout.some(path => !pkg.readable(path))) codes.push('BI_ARTIFACT_MISSING');
    if (Object.keys(pkg.files).some(path => !pkg.layout.includes(path))) codes.push('BI_ARTIFACT_UNEXPECTED');
    if (Object.keys(pkg.json).some(path => path !== MULTI_MANIFEST_PATH && pkg.readable(path) && pkg.json[path] === undefined)) codes.push('BI_ARTIFACT_MISSING');
    const manifestOk = manifestValid(pkg.manifest);
    if (pkg.readable(MULTI_MANIFEST_PATH) && !manifestOk) codes.push('BI_MANIFEST_SCHEMA_INVALID');
    if (manifestOk && checksumMismatch(pkg, s)) codes.push('BI_CHECKSUM_MISMATCH');
    const scans = Object.keys(pkg.files).filter(path => pkg.readable(path)).flatMap(path => scanContent(textOf(pkg.files[path])));
    if (scans.includes('BI_SECRET_DETECTED')) codes.push('BI_SECRET_DETECTED');
    if (scans.includes('BI_MACHINE_PATH_DETECTED')) codes.push('BI_MACHINE_PATH_DETECTED');
    if (numericFormatInvalid(pkg, manifestOk)) codes.push('BI_NUMERIC_FORMAT_INVALID');
    if (metricFabricated(pkg, s.run)) codes.push('BI_METRIC_FABRICATED');
    const memberJson = Array.from({length: pkg.pineCount}, (_, index) => pkg.json['members/' + (index + 1) + '/indicator.json']).filter(isObject);
    if (manifestOk && (pkg.manifest.binding.alert_source !== 'alert_calls' || memberJson.some(item => item.alert_source !== 'alert_calls'))) codes.push('BI_ALERT_SOURCE_INVALID');
    for (let n = 1; n <= pkg.pineCount; n++) {
      const path = 'members/' + n + '/indicator.pine';
      if (pkg.readable(path) && !indicatorOnly(textOf(pkg.files[path]))) { codes.push('INDICATOR_REQUIRED'); break; }
    }
    if (manifestOk && (!same(pkg.manifest.binding.market, PACKAGE_MARKET) || memberJson.some(item => item.symbol !== 'BINANCE:' + PACKAGE_MARKET.symbol || item.timeframe !== PACKAGE_MARKET.timeframe))) codes.push('BI_MARKET_SCOPE_INVALID');
    return outcome('C1', codes);
  });
}

/* ---- Gate C2: compile and source integrity, one record per member file (MPC 6.3) ---- */

const compileShapeOk = record => isObject(record) && text(record.export_id) && sha(record.indicator_sha256) && (text(record.pine_version) || finite(record.pine_version))
  && Array.isArray(record.errors) && Array.isArray(record.warnings) && count(record.unresolved_references) && count(record.collisions) && count(record.duplicate_bindings)
  && Array.isArray(record.mapping_check) && utc(record.compiled_at_utc) && text(record.operator_role) && text(record.method);
const warningReviewed = warning => isObject(warning) && text(warning.text) && text(warning.disposition) && text(warning.reviewer_role);
const nativeIsolationProven = record => isObject(record) && record.routes_disabled === true && record.unrelated_payloads === 0 && record.native_payloads === 0;
/** The member file must equal, byte for byte, the Bridge output (the template of its exit version) for the original source with the run's selected pair. Nothing else may change. */
function memberLogicIntact({source, signals, member, pair, indicator, indicatorJson, template}) {
  if (typeof source !== 'string' || typeof indicator !== 'string' || template === null || !isObject(signals) || !isObject(pair)) return false;
  if (!isObject(indicatorJson) || !Array.isArray(indicatorJson.edits) || indicatorJson.edits.length !== 0) return false;
  if (![signals.buy, signals.exit].every(name => typeof name === 'string' && /^[A-Za-z_]\w*$/.test(name))) return false;
  try {
    const out = template(source, {bridge: {atr_multiplier: pair.atr_multiplier, rr: pair.rr}, signals: {buy: signals.buy, exit: signals.exit}, bindings: [], fixed_inputs: []},
      {deployment_id: member.deployment_id, pine_import_id: member.pine_import_id, source_version: member.source_version, ...PACKAGE_MARKET});
    return typeof out?.integrated_pine === 'string' && out.integrated_pine === indicator;
  } catch { return false; }
}
/**
 * C2. subject: {export_id, files, run, compile_records, native_alert_isolation, member_sources}. One compile record per member indicator.pine, bound to that file's SHA-256. A missing
 * member record is BI_COMPILE_EVIDENCE_MISSING (retryable) with the member ordinal and pine_import_id in the diagnostics. The logic diff uses the Bridge template of the package's own exit
 * version: a named version without a template fails with BI_EXIT_VERSION_UNSUPPORTED. This gate never calls TradingView.
 */
export function evaluateMultiCompile(subject) {
  return guarded('C2', 'BI_PROVENANCE_UNRESOLVED', () => {
    const s = isObject(subject) ? subject : {}, pkg = openPackage(s), contract = isObject(s.run?.contract) ? s.run.contract : {}, members = membersOf(contract);
    if (members.length === 0 || !isObject(s.run?.result)) return outcome('C2', ['BI_PROVENANCE_UNRESOLVED']);
    const out = collector(), pair = selectedOf(s.run.result)?.parameters, binding = pkg.binding;
    const records = list(s.compile_records).filter(isObject), isolation = list(s.native_alert_isolation).filter(isObject), sources = list(s.member_sources).filter(isObject);
    const exitVersion = isObject(binding) && text(binding.exit_version) ? binding.exit_version : null;
    const template = exitVersion !== null && Object.hasOwn(EXIT_TEMPLATES, exitVersion) ? EXIT_TEMPLATES[exitVersion] : null;
    for (const member of members) {
      const path = 'members/' + member.ordinal + '/indicator.pine', mine = records.filter(item => item.ordinal === member.ordinal), record = mine.length === 1 ? mine[0] : null;
      const bytes = pkg.readable(path) ? bytesOf(pkg.files[path]) : null, indicatorSha = bytes ? hash(bytes) : null;
      if (!compileShapeOk(record) || record.export_id !== s.export_id) out.add('BI_COMPILE_EVIDENCE_MISSING', member);
      else {
        if (indicatorSha === null || record.indicator_sha256 !== indicatorSha) out.add('BI_COMPILE_SOURCE_MISMATCH', member);
        if (record.errors.length > 0 || record.unresolved_references > 0 || record.collisions > 0 || record.duplicate_bindings > 0) out.add('BI_COMPILE_ERRORS', member);
        // No source slot is bound in multi-Pine mode, so the mapping check must be empty.
        if (record.mapping_check.length !== 0) out.add('BI_SLOT_BINDING_MISMATCH', member);
        if (!record.warnings.every(warningReviewed)) out.add('BI_COMPILE_WARNINGS_UNREVIEWED', member);
      }
      const given = sources.filter(item => item.ordinal === member.ordinal), source = given.length === 1 ? given[0] : null;
      const packaged = isObject(binding) ? list(binding.members).find(item => isObject(item) && item.ordinal === member.ordinal) : undefined;
      if (!isObject(source) || typeof source.source !== 'string' || hash(source.source) !== member.source_hash || !isObject(packaged) || packaged.source_hash !== member.source_hash) out.add('BI_SOURCE_HASH_MISMATCH', member);
      if (exitVersion !== null && template === null) out.add('BI_EXIT_VERSION_UNSUPPORTED', member);
      else if (!memberLogicIntact({source: source?.source, signals: source?.signals, member, pair, indicator: pkg.readable(path) ? textOf(pkg.files[path]) : null,
        indicatorJson: pkg.json['members/' + member.ordinal + '/indicator.json'], template})) out.add('BI_SOURCE_LOGIC_CHANGED', member);
      const proof = isolation.filter(item => item.ordinal === member.ordinal);
      if (proof.length !== 1 || !nativeIsolationProven(proof[0])) out.add('BI_NATIVE_ALERT_ISOLATION_UNPROVEN', member);
    }
    return outcome('C2', out.codes, {diagnostics: frozenList(out.diagnostics)});
  });
}

/* ---- Gate C3: provenance (MPC 6.3) ---- */

const memberBindingOf = member => isObject(member) ? {ordinal: member.ordinal, deployment_id: member.deployment_id, pine_import_id: member.pine_import_id, source_version: member.source_version,
  source_hash: member.source_hash, baseline_snapshot_hash: member.deployment_snapshot_hash, effective_input_hash: member.effective_inputs_hash, evidence_hash: member.evidence_hash,
  exit_version: member.exit_version} : null;
/** RD-MP-44 R4: the digest of the two Bridge domains and every member's frozen fixed snapshot. The caller recomputes it from the current member state. */
const inputLockHash = contract => digest({bridge_domains: contract.bridge_domains, members: membersOf(contract).map(member => ({ordinal: member.ordinal, effective_input_hash: member.effective_inputs_hash,
  deployment_snapshot_hash: member.deployment_snapshot_hash}))});
/** The binding fields that must equal the stored run and its immutable contract (RD-MP-44 R3: no policy_version, no ledger_initialization, slot_bindings is the empty list). created_at,
 * fixture and holdout_boundary_ref have their own checks. library_versions is the value frozen in the export row at build, never a current constant. */
function derivedBinding(run, libraryVersions) {
  const contract = run.contract, members = sortedBy(membersOf(contract).map(memberBindingOf).filter(present), 'ordinal'), selected = selectedOf(run.result);
  return {owner_id: run.owner_id, bot_id: run.bot_id, run_id: run.run_id, contract_hash: run.contract_hash, submission_hash: run.submission_hash, member_set_id: contract.member_set_id,
    set_hash: contract.set_hash, membership_hash: contract.membership_hash, pine_count: contract.pine_count, slot_bindings: [], mode: MP_MODE,
    bridge_pair: {atr_multiplier: selected?.parameters?.atr_multiplier, rr: selected?.parameters?.rr}, same_bar_order: contract.same_bar_order, members,
    input_lock_hash: inputLockHash(contract),
    bridge_domains: contract.bridge_domains, policy_hash: contract.policy_hash, funding_cutoff: contract.funding_cutoff, capital: contract.capital, model: contract.model,
    cost_model_version: contract.model?.version, dataset_ref: contract.dataset, split: contract.split, engine_hash: contract.engine_hash, rules: contract.rules,
    acceptance_blockers: contract.acceptance_blockers, library_versions: isObject(libraryVersions) ? libraryVersions : undefined, library_record_ref: {run_id: run.run_id, result_sha256: digest(run.result)},
    alert_source: 'alert_calls', exit_version: membersOf(contract)[0]?.exit_version, market: {...PACKAGE_MARKET}};
}
const BINDING_EXTRA_KEYS = new Set(['holdout_boundary_ref']);
function bindingMismatch(binding, run, libraryVersions) {
  const normal = {...binding, members: Array.isArray(binding.members) ? sortedBy(binding.members, 'ordinal') : binding.members};
  if (Object.keys(binding).some(key => !MULTI_BINDING_FIELDS.includes(key) && !BINDING_EXTRA_KEYS.has(key))) return true;
  if (!Array.isArray(binding.members) || binding.members.length !== list(run.contract.members).length) return true;
  return Object.entries(derivedBinding(run, libraryVersions)).some(([key, value]) => !same(normal[key], value));
}
function domainContains(domain, after) {
  const min = decimalNumber(domain?.min), max = decimalNumber(domain?.max), step = decimalNumber(domain?.step);
  if (![min, max, step, after].every(finite) || step <= 0) return false;
  const steps = (after - min) / step;
  return after >= min && after <= max && Math.abs(steps - Math.round(steps)) < 1e-9;
}
/** inputs.json against the frozen run: only the shared Bridge pair is actionable (T-K3), it equals the selected candidate, no source slot exists, and the member snapshots are the frozen ones. */
function inputsCodes(pkg, run, selected) {
  const contract = run.contract, inputs = pkg.json['inputs.json'], codes = [];
  if (!isObject(inputs) || !isObject(inputs.bridge) || !Array.isArray(inputs.source_inputs) || !Array.isArray(inputs.members)) return ['BI_INPUTS_MISMATCH'];
  if (inputs.source_inputs.length > 0) codes.push(MP_CODES.SOURCE_SLOTS_FORBIDDEN);
  let mismatch = !same(Object.keys(inputs.bridge).sort(), [...BRIDGE_NAMES].sort()) || inputs.run_id !== run.run_id || inputs.mode !== MP_MODE || inputs.pine_count !== contract.pine_count
    || inputs.member_set_id !== contract.member_set_id || inputs.set_hash !== contract.set_hash, outOfDomain = false;
  for (const name of BRIDGE_NAMES) {
    const entry = inputs.bridge[name], domain = contract.bridge_domains?.[name];
    if (!isObject(entry) || !isObject(domain)) { mismatch = true; continue; }
    const after = decimalNumber(entry.after);
    if (!domainContains(domain, after)) outOfDomain = true;
    if (after !== selected?.parameters?.[name] || !same(entry.domain, {min: domain.min, max: domain.max, step: domain.step})) mismatch = true;
  }
  if (mismatch) codes.push('BI_INPUTS_MISMATCH');
  if (outOfDomain) codes.push('BI_INPUT_OUT_OF_DOMAIN');
  const members = membersOf(contract);
  const frozen = members.map(member => ({ordinal: member.ordinal, deployment_id: member.deployment_id, pine_import_id: member.pine_import_id, source_version: member.source_version,
    source_hash: member.source_hash, effective_input_hash: member.effective_inputs_hash}));
  let changed = !same(sortedBy(inputs.members, 'ordinal'), frozen);
  for (const member of members) {
    const meta = pkg.json['members/' + member.ordinal + '/indicator.json'];
    if (!isObject(meta) || meta.ordinal !== member.ordinal || meta.deployment_id !== member.deployment_id || meta.pine_import_id !== member.pine_import_id || meta.source_version !== member.source_version
      || meta.source_hash !== member.source_hash || meta.effective_input_hash !== member.effective_inputs_hash || meta.deployment_snapshot_hash !== member.deployment_snapshot_hash) changed = true;
  }
  if (changed) codes.push('BI_FIXED_INPUT_CHANGED');
  return codes;
}
function riskCodes(profile, contract, hardLimits) {
  const codes = [];
  if (!isObject(profile) || profile.policy_hash !== contract.policy_hash || !sha(contract.policy_hash) || digest(profile.policy) !== contract.policy_hash) codes.push('BI_POLICY_SNAPSHOT_MISMATCH');
  const limits = isObject(profile) && isObject(profile.limits) ? profile.limits : null;
  if (!limits || !isObject(hardLimits) || Object.keys(hardLimits).length === 0) codes.push('BI_RISK_RELAXATION');
  else for (const [name, bound] of Object.entries(hardLimits)) {
    const value = decimalNumber(limits[name]), min = isObject(bound) && present(bound.min) ? decimalNumber(bound.min) : -Infinity, max = isObject(bound) && present(bound.max) ? decimalNumber(bound.max) : Infinity;
    if (!isObject(bound) || !(value >= min) || !(value <= max)) { codes.push('BI_RISK_RELAXATION'); break; }
  }
  return codes;
}
const STEP_KEYS = ['index', 'parameters', 'train', 'validation', 'decision_count', 'fills', 'rejections', 'exit_fill_reasons', 'ledger_hash'];
/** Digests of the stored steps of the selected candidate, defined as the trace producer defines them (RD-MP-44 R4): the candidate, sensitivity and stress steps, and the holdout step. */
const storedStepDigests = selected => isObject(selected) ? {
  steps: digest({candidate: Object.fromEntries(STEP_KEYS.filter(key => Object.hasOwn(selected, key)).map(key => [key, selected[key]])), sensitivity: selected.sensitivity, cost_stress: selected.cost_stress}),
  holdout: digest({test: selected.test, holdout: selected.holdout})} : {steps: null, holdout: null};
const TRACE_RECORD_KEYS = ['path', 'sha256', 'decisions_hash', 'steps_digest', 'holdout_digest', 'run_engine_hash', 'producer_closure_hash', 'method'];
/** The fields of a trace record that carry the steps (BI_RESULT_MISMATCH) and the fields that carry the holdout identity (HOLDOUT_MISMATCH). Together they are the whole record. */
const TRACE_STEP_FIELDS = ['path', 'sha256', 'steps_digest', 'method', 'producer_closure_hash'];
const TRACE_HOLDOUT_FIELDS = ['holdout_digest', 'decisions_hash', 'run_engine_hash'];
const traceRecordShaped = record => isObject(record) && Object.keys(record).length === TRACE_RECORD_KEYS.length && TRACE_RECORD_KEYS.every(key => Object.hasOwn(record, key));
/** The records deriveMultiTrace gives for this run and this producer closure hash, or null when the trace cannot be derived (every RD-MP-39 difference throws). */
function derivedTraceRecords(run, producerClosureHash) {
  try { return deriveMultiTrace({run, producer_closure_hash: producerClosureHash}).records; } catch { return null; }
}
/**
 * Trace files reproduce the stored steps (RD-MP-46 N1, N2). The module re-derives the trace itself with deriveMultiTrace({run, producer_closure_hash}) for the producer_closure_hash of
 * the caller record (64 lowercase hex) and requires the caller record, the packaged manifest record and the derived record to be equal field by field. A record must also name the
 * packaged file bytes, carry the digest of the stored steps and the producer method. A difference in a step field or a missing, duplicated or malformed record gives steps:false; a difference
 * in the holdout digest, the identity hash of the stored decisions or the run engine hash gives holdout:false. A trace that cannot be derived gives both false.
 */
function traceReproduced(pkg, selected, result, contract, reproduction, run) {
  const stored = storedStepDigests(selected), records = list(reproduction).filter(isObject), packaged = list(pkg.manifest?.evidence?.trace_records).filter(isObject);
  const decisionsHash = isObject(result?.combined_baseline) ? result.combined_baseline.received_decisions_hash : undefined;
  const derivations = new Map();
  const derivedFor = (producerClosureHash, path) => {
    if (!derivations.has(producerClosureHash)) derivations.set(producerClosureHash, derivedTraceRecords(run, producerClosureHash));
    return derivations.get(producerClosureHash)?.find(item => item.path === path) ?? null;
  };
  let steps = true, holdout = true;
  for (const path of TRACE_FILES) {
    const matches = records.filter(item => item.path === path), record = matches.length === 1 ? matches[0] : null, bytes = pkg.readable(path) ? bytesOf(pkg.files[path]) : null;
    const copies = packaged.filter(item => item.path === path), copy = copies.length === 1 ? copies[0] : null;
    if (record === null || copy === null) { steps = false; holdout = false; continue; }
    // A producer closure hash that is not 64 lowercase hex is a step failure only; a trace that cannot be derived fails both.
    const closureOk = sha(record.producer_closure_hash), derived = closureOk ? derivedFor(record.producer_closure_hash, path) : null;
    const equal = fields => fields.every(key => record[key] === copy[key] && (!closureOk || (derived !== null && record[key] === derived[key])));
    if (bytes === null || stored.steps === null || !closureOk || !traceRecordShaped(record) || !traceRecordShaped(copy) || !equal(TRACE_STEP_FIELDS) || record.sha256 !== hash(bytes)
      || record.steps_digest !== stored.steps || record.method !== MP_TRACE_METHOD) steps = false;
    if (stored.holdout === null || !traceRecordShaped(record) || !traceRecordShaped(copy) || !equal(TRACE_HOLDOUT_FIELDS) || record.holdout_digest !== stored.holdout || !sha(decisionsHash)
      || record.decisions_hash !== decisionsHash || record.run_engine_hash !== contract.engine_hash) holdout = false;
  }
  return {steps, holdout};
}
function resultCodes(pkg, selected, result, contract, reproduction, run) {
  const codes = [], metricsFile = pkg.json['quant-data/metrics.json'], validation = pkg.json['quant-data/validation.json'], traces = traceReproduced(pkg, selected, result, contract, reproduction, run);
  const candidate = isObject(selected) ? Object.fromEntries(['parameters', 'train', 'validation', 'decision_count', 'fills', 'ledger_hash'].filter(key => selected[key] !== undefined).map(key => [key, selected[key]])) : null;
  const metricsOk = isObject(metricsFile) && isObject(selected) && same(metricsFile, {train: selected.train, validation: selected.validation, test: selected.test});
  const funnelOk = isObject(validation) && isObject(result?.funnel) && same(validation.funnel, {step: result.funnel.step, diagnostics: result.funnel.diagnostics});
  const stepsOk = isObject(validation) && isObject(selected) && validation.mode === MP_MODE && same(validation.candidate, candidate) && same(validation.sensitivity, selected.sensitivity)
    && same(validation.cost_stress, selected.cost_stress) && funnelOk;
  if (!metricsOk || !stepsOk || !traces.steps) codes.push('BI_RESULT_MISMATCH');
  if (!isObject(validation) || !isObject(selected) || !same(validation.holdout, {test: selected.test, step: selected.holdout}) || !same(validation.combined_baseline, result?.combined_baseline) || !traces.holdout) codes.push('HOLDOUT_MISMATCH');
  return codes;
}
/** spot-dataset-v1 metadata of the Binance Spot BTCUSDT 1m window against the contract dataset (the same window rules as the one-Pine C3). */
function dataWindowCodes(metadata, dataset) {
  const meta = isObject(metadata) ? metadata : null, ref = isObject(dataset) ? dataset : {};
  if (meta === null) return ['BI_DATASET_UNAVAILABLE'];
  const codes = [];
  if (meta.venue !== PACKAGE_MARKET.broker || meta.market !== 'SPOT' || meta.symbol !== PACKAGE_MARKET.symbol || meta.timeframe !== PACKAGE_MARKET.timeframe) codes.push('BI_MARKET_SCOPE_INVALID');
  const whole = [meta.start_time, meta.end_time, meta.total_bars, meta.warmup_bars, meta.cutoff].every(Number.isSafeInteger);
  const ok = meta.version === DATASET_METADATA_VERSION && meta.source === DATASET_SOURCE && whole && meta.start_time % MINUTE === 0 && meta.end_time % MINUTE === 0 && meta.end_time <= meta.cutoff
    && meta.end_time - meta.start_time === meta.total_bars * MINUTE && meta.warmup_bars >= 0 && meta.warmup_bars <= meta.total_bars && meta.start_time === ref.start_time
    && meta.end_time === ref.end_time + MINUTE && meta.total_bars === ref.bar_count && meta.warmup_bars === ref.warmup_bars;
  if (!ok) codes.push('BI_DATASET_UNAVAILABLE');
  return codes;
}
/**
 * C3. subject: {run, export:{library_versions}, files, deployments, dataset:{readable, digest, metadata}, hard_limits, trace_reproduction, binding, package_hash, binding_hash}. The claimed binding is
 * the manifest binding of the package. Every member's fixed snapshot equals the frozen run member snapshot (BI_FIXED_INPUT_CHANGED); the pair in inputs.json equals the selected candidate
 * (BI_INPUTS_MISMATCH); source slots are 0 (MP_SOURCE_SLOTS_FORBIDDEN); fixture is true (BI_FIXTURE_LABEL_MISSING).
 */
export function evaluateMultiProvenance(subject) {
  return guarded('C3', 'BI_PROVENANCE_UNRESOLVED', () => {
    const s = isObject(subject) ? subject : {}, pkg = openPackage(s), run = s.run, codes = [];
    if (!isObject(run) || !isObject(run.contract) || !isObject(pkg.binding) || !isObject(pkg.manifest) || !isObject(run.result) || run.contract_hash !== digest(run.contract)) return outcome('C3', ['BI_PROVENANCE_UNRESOLVED']);
    const contract = run.contract, binding = pkg.binding, selected = selectedOf(run.result), members = membersOf(contract);
    if (bindingMismatch(binding, run, isObject(s.export) ? s.export.library_versions : undefined)) codes.push('BI_BINDING_MISMATCH');
    if (Array.isArray(binding.slot_bindings) && binding.slot_bindings.length > 0) codes.push(MP_CODES.SOURCE_SLOTS_FORBIDDEN);
    codes.push(...inputsCodes(pkg, run, selected));
    codes.push(...riskCodes(pkg.json['risk-profile.json'], contract, s.hard_limits));
    codes.push(...resultCodes(pkg, selected, run.result, contract, s.trace_reproduction, run));
    const dataset = isObject(s.dataset) ? s.dataset : {};
    if (dataset.readable !== true) codes.push('BI_DATASET_UNAVAILABLE');
    else {
      if (!text(dataset.digest) || dataset.digest !== datasetDigest(contract.dataset)) codes.push('BI_DATASET_HASH_MISMATCH');
      codes.push(...dataWindowCodes(dataset.metadata, contract.dataset));
    }
    if (!sha(contract.engine_hash) || binding.engine_hash !== contract.engine_hash || pkg.manifest.evidence?.engine_hash !== contract.engine_hash) codes.push('BI_ENGINE_HASH_MISMATCH');
    if (!ADMITTED_COST_MODELS.includes(binding.cost_model_version) || !ADMITTED_COST_MODELS.includes(contract.model?.version)) codes.push('BI_COST_MODEL_UNSUPPORTED');
    const deployments = list(s.deployments).filter(isObject);
    const exitOk = SUPPORTED_EXIT_VERSIONS.includes(binding.exit_version) && members.length > 0 && members.every(member => member.exit_version === binding.exit_version
      && deployments.filter(item => item.deployment_id === member.deployment_id).length === 1
      && deployments.find(item => item.deployment_id === member.deployment_id).exit_version === binding.exit_version);
    if (!exitOk) codes.push('BI_EXIT_VERSION_UNSUPPORTED');
    // N3: a deployment snapshot must be the frozen one of the contract member (a missing or duplicated entry is already the exit-version failure above).
    if (!members.every(member => { const mine = deployments.filter(item => item.deployment_id === member.deployment_id); return mine.length !== 1 || (isObject(mine[0].snapshot) && digest(mine[0].snapshot) === member.deployment_snapshot_hash); })) codes.push('BI_FIXED_INPUT_CHANGED');
    if (binding.fixture !== true || pkg.manifest.fixture !== true) codes.push('BI_FIXTURE_LABEL_MISSING');
    return outcome('C3', codes);
  });
}

/* ---- Gate C4: validation, evidence and freshness (MPC 6.3, RD-MP-41) ---- */

/**
 * Freshness tuple F (MPC 6.1) against current server state, in the order of FRESHNESS_ORDER. Unknown or unreadable state differs. The pair of F is the frozen shared deployment pair,
 * which input_lock_hash already covers through the member deployment snapshots; no pair is compared here (see the module header, RD-MP-46 B1).
 */
export function multiFreshnessCodes(binding, current) {
  const b = isObject(binding) ? binding : {}, c = isObject(current) ? current : {}, found = new Set();
  const bound = list(b.members).filter(isObject), now = list(c.membership).filter(isObject), valid = bound.length > 0 && bound.length === list(b.members).length;
  const currentOf = id => now.find(item => item.pine_import_id === id);
  if (!valid || !bound.every(member => { const other = currentOf(member.pine_import_id); return isObject(other) && other.source_version === member.source_version && other.source_hash === member.source_hash; })) found.add('BI_SOURCE_VERSION_STALE');
  if (!valid || !same(bound.map(member => member.pine_import_id).sort(), now.map(member => member.pine_import_id).sort()) || !sha(b.membership_hash) || b.membership_hash !== c.membership_hash) found.add('BI_MEMBERSHIP_CHANGED');
  if (!sha(b.policy_hash) || b.policy_hash !== c.policy_hash || !same(b.capital, c.capital) || !Number.isSafeInteger(b.funding_cutoff) || b.funding_cutoff !== c.funding_cutoff) found.add('BI_POLICY_SNAPSHOT_MISMATCH');
  if (!valid || !bound.every(member => text(member.deployment_id) && currentOf(member.pine_import_id)?.deployment_id === member.deployment_id)) found.add('BI_DEPLOYMENT_CHANGED');
  if (!sha(b.input_lock_hash) || b.input_lock_hash !== c.input_lock_hash) found.add('BI_SELECTION_CHANGED');
  if (c.dataset_available !== true) found.add('BI_DATASET_UNAVAILABLE');
  return FRESHNESS_ORDER.filter(code => found.has(code));
}
/**
 * B0 member-set freshness (MPC 6.3 B0): the FROZEN tuple derived from the run contract against current. Any freshness difference except dataset availability, and any unreadable or
 * absent current state, is MP_MEMBER_SET_STALE.
 */
function memberSetCodes(contract, current) {
  const frozen = {members: membersOf(contract), membership_hash: contract.membership_hash, policy_hash: contract.policy_hash, capital: contract.capital, funding_cutoff: contract.funding_cutoff,
    input_lock_hash: inputLockHash(contract)};
  return multiFreshnessCodes(frozen, current).some(code => code !== 'BI_DATASET_UNAVAILABLE') ? [MP_CODES.MEMBER_SET_STALE] : [];
}
const recordOf = (entry, key) => isObject(entry) && isObject(entry[key]) ? entry[key] : null;
const percentFull = value => value === 100;
/** One member's evidence against the chosen pair. The scope of every record must name this member's hashes (RD-MP-41); another member's scope is MP_MEMBER_PARITY_SCOPE_MISMATCH. */
function memberEvidenceCodes(out, member, entry, contract) {
  const alignment = recordOf(entry, 'dataset_alignment'), parity = recordOf(entry, 'native_parity'), bridge = recordOf(entry, 'bridge_parity'), repaint = recordOf(entry, 'repaint');
  if (!alignment || !finite(alignment.matched_percent) || !count(alignment.unmatched_bars) || !count(alignment.future_leakage)) out.add('BI_DATASET_ALIGNMENT_MISSING', member);
  else if (!percentFull(alignment.matched_percent) || alignment.unmatched_bars !== 0 || alignment.future_leakage !== 0) out.add('BI_DATASET_ALIGNMENT_FAILED', member);
  const sample = isObject(parity?.sample) ? parity.sample : null;
  if (!parity || !sample || !finite(parity.match_percent) || !count(parity.missing_events) || !count(parity.additional_events) || !Number.isSafeInteger(parity.shift_bars)
    || !['warmup_bars', 'lookback', 'closed_bars', 'native_events', 'buy_events', 'exit_events'].every(key => count(sample[key]))) out.add('BI_PARITY_EVIDENCE_MISSING', member);
  else {
    if (sample.warmup_bars < Math.max(500, 5 * sample.lookback) || sample.closed_bars < 2000 || sample.native_events < 100 || sample.buy_events < 30 || sample.exit_events < 30) out.add('BI_PARITY_SAMPLE_FLOOR_NOT_MET', member);
    if (!percentFull(parity.match_percent) || parity.missing_events !== 0 || parity.additional_events !== 0 || parity.shift_bars !== 0) out.add('BI_NATIVE_SIGNAL_PARITY_FAILED', member);
  }
  if (!bridge || !finite(bridge.match_percent) || !count(bridge.sl_tp_diff_ticks) || !text(bridge.exit_version)) out.add('BI_PARITY_EVIDENCE_MISSING', member);
  else if (!percentFull(bridge.match_percent) || bridge.sl_tp_diff_ticks !== 0 || bridge.exit_version !== member.exit_version) out.add('BI_BRIDGE_PARITY_FAILED', member);
  if (!repaint || !count(repaint.observations) || !count(repaint.changed_flags)) out.add('BI_REPAINT_EVIDENCE_MISSING', member);
  else {
    if (repaint.changed_flags > 0) out.add('BI_REPAINT_FLAGS_CHANGED', member);
    if (repaint.observations < 100) out.add('BI_REPAINT_EVIDENCE_MISSING', member);
  }
  const scope = {source_hash: member.source_hash, effective_input_hash: member.effective_inputs_hash, dataset_digest: datasetDigest(contract.dataset), engine_hash: contract.engine_hash, deployment_id: member.deployment_id, ordinal: member.ordinal};
  if ([alignment, parity, bridge, repaint].some(item => item && !same(item.scope, scope))) out.add(MP_CODES.MEMBER_PARITY_SCOPE_MISMATCH, member);
}
/** RD-MP-30: the combined baseline record of the run result must exist, be tied to this run and the selected pair, and be matched. It is the baseline of MPC 5.6. */
function baselineOk(run, selected) {
  const baseline = run.result?.combined_baseline;
  return isObject(baseline) && baseline.version === MP_BASELINE_VERSION && isObject(baseline.binding) && same(baseline.binding, {run_id: run.run_id, contract_hash: run.contract_hash})
    && isObject(baseline.pair) && isObject(selected) && same(baseline.pair, selected.parameters) && baseline.same_bar_order === run.contract.same_bar_order
    && sha(baseline.received_decisions_hash) && baseline.received_decisions_hash === digest(run.result.holdout_decisions) && baseline.matched === true;
}
function bridgePairOutOfBounds(pkg, contract, bounds) {
  const inputs = pkg.json['inputs.json'];
  return BRIDGE_NAMES.some(name => {
    const after = decimalNumber(inputs?.bridge?.[name]?.after), bound = isObject(bounds) ? bounds[name] : null;
    return !finite(after) || !domainContains(contract.bridge_domains?.[name], after) || !isObject(bound) || !(after >= decimalNumber(bound.min)) || !(after <= decimalNumber(bound.max));
  });
}
/** G6 for export: every candidate blocker needs one clearance per ordinal that names this run, export, ordinal and chosen pair and the digest of that member's evidence record. */
function clearanceCodes(contract, selected, run, exportId, clearances, evidence, internal) {
  const blockers = contract.acceptance_blockers;
  if (!Array.isArray(blockers) || !blockers.every(text)) return ['BLOCKERS_UNKNOWN'];
  const parameterHash = digest(selected?.parameters), members = membersOf(contract), items = list(clearances).filter(isObject);
  const proofHash = (blocker, ordinal) => {
    const kind = Object.hasOwn(CLEARANCE_EVIDENCE, blocker) ? CLEARANCE_EVIDENCE[blocker] : null;
    const entry = list(evidence?.members).filter(isObject).filter(item => item.ordinal === ordinal);
    const proof = kind === null || entry.length !== 1 ? null : recordOf(entry[0], kind);
    return proof === null ? null : digest(proof);
  };
  const cleared = (blocker, ordinal) => items.some(item => item.blocker === blocker && item.run_id === run.run_id && text(exportId) && item.export_id === exportId && item.ordinal === ordinal
    && sha(item.parameter_hash) && item.parameter_hash === parameterHash && sha(item.evidence_hash) && item.evidence_hash === proofHash(blocker, ordinal));
  const open = blockers.some(name => !(internal && name === MULTI_PINE_BLOCKER) && !(CANDIDATE_BLOCKER_SET.has(name) && members.length > 0 && members.every(member => cleared(name, member.ordinal))));
  return open ? ['ACCEPTANCE_BLOCKERS_PRESENT'] : [];
}
/**
 * C4. subject: {export_id, run, files, evidence, current, bridge_bounds, clearances, internal, binding}. Per-member alignment, parity and repaint for the chosen pair, each scoped to its member;
 * a missing member record uses the existing retryable codes with the member ordinal and pine_import_id in the diagnostics. Evidence naming another member's hashes is
 * MP_MEMBER_PARITY_SCOPE_MISMATCH (non-retryable). A missing, untied, wrong-pair or unmatched combined baseline is MP_COMBINED_BASELINE_FAILED (non-retryable). Freshness F follows. On the
 * EXPORT_INTERNAL path only, MULTI_PINE_REQUIRES_APP_3B does not leave an acceptance blocker open (RC-11).
 */
export function evaluateMultiValidation(subject) {
  return guarded('C4', 'BI_PROVENANCE_UNRESOLVED', () => {
    const s = isObject(subject) ? subject : {}, pkg = openPackage(s), run = s.run;
    if (!isObject(run) || !isObject(run.contract) || !isObject(run.result) || !isObject(pkg.binding)) return outcome('C4', ['BI_PROVENANCE_UNRESOLVED']);
    const out = collector(), members = membersOf(run.contract), selected = selectedOf(run.result);
    if (members.length === 0) return outcome('C4', ['BI_PROVENANCE_UNRESOLVED']);
    for (const member of members) {
      const entries = list(s.evidence?.members).filter(item => isObject(item) && item.ordinal === member.ordinal);
      // Two entries for one ordinal are ambiguous scope, never "missing": a hard code (RD-MP-46 N7).
      if (entries.length > 1) out.add(MP_CODES.MEMBER_PARITY_SCOPE_MISMATCH, member);
      else memberEvidenceCodes(out, member, entries.length === 1 ? entries[0] : null, run.contract);
    }
    if (!baselineOk(run, selected)) out.add(MP_CODES.COMBINED_BASELINE_FAILED);
    out.codes.push(...multiFreshnessCodes(pkg.binding, s.current));
    if (bridgePairOutOfBounds(pkg, run.contract, s.bridge_bounds)) out.codes.push('BI_BRIDGE_PAIR_OUT_OF_BOUNDS');
    out.codes.push(...clearanceCodes(run.contract, selected, run, s.export_id, s.clearances, s.evidence, internalPath(s.internal, run.contract, pkg.binding.mode)));
    return outcome('C4', out.codes, {diagnostics: frozenList(out.diagnostics)});
  });
}

/* ---- Gate Q: qualification record (RD-MP-37) ---- */

/**
 * Q passes only when C1 to C4 passed in this attempt. It then builds the record of the shape of a one-Pine validation record plus mode MULTI_PINE and fixture true. The caller stores it
 * in the multi package store; it is never written to a one-Pine validation table and no G8 reader reads it. Bad attempt metadata refuses the call; the one-Pine Q gate judges it.
 */
export function evaluateMultiQualification(subject, results) {
  return guarded('Q', 'BI_BINDING_INCOMPLETE', () => {
    const base = evaluateQualification(subject, results);
    if (!isObject(base.record)) return base;
    if (base.record.fixture !== true) return outcome('Q', ['BI_FIXTURE_LABEL_MISSING']);
    return Object.freeze({...base, record: Object.freeze({...base.record, mode: MP_MODE})});
  });
}

/* ---- derived freshness and READY (MPC 9.2) ---- */

/** Freshness is derived at read time and never written over the status. A REPLAY_MISMATCH event forces STALE and is listed first. replay_mismatch is a required boolean. */
export function multiFreshness(input) {
  const {binding, current, replay_mismatch: replay} = isObject(input) ? input : {};
  if (typeof replay !== 'boolean') return Object.freeze({refused: REPLAY_STATE_UNAVAILABLE, fields: Object.freeze(['replay_mismatch']), fresh: false, state: null, code: null, codes: Object.freeze([])});
  const codes = [...(replay ? ['REPLAY_MISMATCH'] : []), ...multiFreshnessCodes(binding, current)];
  return Object.freeze({fresh: codes.length === 0, state: codes.length === 0 ? 'FRESH' : 'STALE', code: codes[0] ?? null, codes: Object.freeze(codes)});
}
/** The read-time view of one multi export. READY is always false for MULTI_PINE (MPC 9.2, T-K1), whatever the status, the binding, the fixture label and the requester (RD-MP-46 B3). */
export function multiReadState(input) {
  const {status, binding, current, replay_mismatch: replay} = isObject(input) ? input : {};
  const view = multiFreshness({binding, current, replay_mismatch: replay});
  if (isRefused(view)) return Object.freeze({refused: view.refused, fields: view.fields, status: status ?? null, fresh: false, state: null, code: null, codes: view.codes, ready: false});
  return Object.freeze({status: status ?? null, fresh: view.fresh, state: view.state, code: view.code, codes: view.codes, ready: false});
}

/* ---- full evaluation of one validation attempt ---- */

const attemptFields = attempt => {
  const a = isObject(attempt) ? attempt : {};
  return [!text(a.attempt_id) && 'attempt.attempt_id', !sha(a.validator_engine_hash) && 'attempt.validator_engine_hash', !utc(a.validated_at_utc) && 'attempt.validated_at_utc'].filter(Boolean);
};
/**
 * Evaluates one validation attempt: C1 to C4 and then Q, in order. B0 is a build-time gate and is never re-run here. A hard failure makes every later gate NOT_REACHED; a retryable-only failure
 * does not, so one attempt reports all missing evidence. The call is refused (refused, fields, no gates, next null, status null, record null) when the run is absent or foreign (NOT_FOUND), when
 * replay_mismatch is not a boolean (BI_REPLAY_STATE_UNAVAILABLE), or when the attempt metadata or attempt_no (a safe integer from 1 to 5) is unusable (INPUT_INVALID). The stored transition
 * is the one-Pine graph with mode MULTI_PINE: a pass leads to EXPORT_INTERNAL, a retryable-only failure keeps EXPORT_CANDIDATE until attempt 5, which gives EXPORT_REFUSED with
 * BI_ATTEMPTS_EXHAUSTED. The Q record is returned only when the attempt passed and its stored transition is allowed.
 */
export function evaluateMultiPackage(subject) {
  const s = isObject(subject) ? subject : {}, run = s.run;
  const refused = (reason, fields) => Object.freeze({version: MULTI_PACKAGE_GATE_VERSION, refused: reason, fields: Object.freeze([...fields]), pass: false, gates: Object.freeze([]), codes: Object.freeze([]),
    diagnostics: Object.freeze([]), limitations: Object.freeze([]), next: null, status: null, record: null, ready: false});
  try {
    if (!text(s.owner_id) || !isObject(run) || run.owner_id !== s.owner_id) return refused('NOT_FOUND', []);
    const attemptNoOk = Number.isSafeInteger(s.attempt_no) && s.attempt_no >= 1 && s.attempt_no <= MAX_VALIDATION_ATTEMPTS;
    const fields = [...(isObject(s.current_rules) ? [] : ['current_rules']), ...(typeof s.replay_mismatch === 'boolean' ? [] : ['replay_mismatch']), ...attemptFields(s.attempt), ...(attemptNoOk ? [] : ['attempt_no'])];
    if (fields.length) return refused(fields.includes('replay_mismatch') ? REPLAY_STATE_UNAVAILABLE : INPUT_INVALID, fields);
    const gates = [];
    let blocked = false;
    for (const [name, gate] of [['C1', evaluateMultiStructure], ['C2', evaluateMultiCompile], ['C3', evaluateMultiProvenance], ['C4', evaluateMultiValidation]]) {
      if (blocked) { gates.push(notReached(name)); continue; }
      const result = gate(s);
      gates.push(result);
      if (isHardFailure(result)) blocked = true;
    }
    gates.push(gates.every(item => item.pass) ? evaluateMultiQualification(s, gates) : notReached('Q'));
    const codes = unique(gates.flatMap(item => item.codes)), pass = gates.every(item => item.pass), diagnostics = gates.flatMap(item => list(item.diagnostics));
    const next = transition(MULTI_STATUS.EXPORT_CANDIDATE, {kind: 'ATTEMPT', pass, codes, mode: MP_MODE, attempt_no: s.attempt_no});
    const status = next.ok ? next.to : null, binding = openPackage(s).binding ?? (isObject(s.binding) ? s.binding : {});
    return Object.freeze({version: MULTI_PACKAGE_GATE_VERSION, pass, gates: Object.freeze(gates), codes: Object.freeze(codes), diagnostics: frozenList(diagnostics),
      limitations: Object.freeze(rulesLimitations(run.contract, s.current_rules)), next, status, record: next.ok && pass ? gates[4].record ?? null : null,
      ready: status !== null && multiReadState({status, binding, current: s.current, replay_mismatch: s.replay_mismatch}).ready});
  } catch {
    return refused(INPUT_INVALID, ['subject']);
  }
}

/* The pure one-Pine helpers this module shares, re-exported so a caller of the multi gates needs one import. */
export {transition, RETRYABLE_CODES, isRetryable, notReached, CODE_PATTERN, MANIFEST_SCHEMA, FRESHNESS_ORDER, MULTI_PINE_CONTRACT_VERSION, MULTI_PINE_BLOCKER, CANDIDATE_BLOCKERS,
  RECOMMENDATION_COMPLETION_REASON, holdoutWindow, searchedWindow, windowsOverlap};
