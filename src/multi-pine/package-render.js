import {canonical, hash, executable} from '../pine-bridge/source.js';
import {assemble} from '../pine-bridge/template.js';
import {MANIFEST_PATH, SUPPORTED_EXIT_VERSIONS, CODE_PATTERN, METRIC_KEYS, buildManifest, packageHash, bindingHash, scanContent} from '../quant-library/package-gates.js';
import {MULTI_PINE_CONTRACT_VERSION, MP_MODE, MP_MIN_MEMBERS, MP_MAX_MEMBERS, MP_SAME_BAR_ORDER} from './codes.js';
import {MP_TRACE_PATHS, MP_TRACE_METHOD, MP_TRACE_LIMITATION, deriveMultiTrace} from './package-trace.js';

/**
 * F11 R6-1: pure deterministic renderer and binding of the multi-Pine package (docs/MULTI_PINE_CONTRACT.md 6.1 and 6.2). It reads no database, no file, no network, no
 * clock and no random source, imports neither the run store nor the executor, and is wired into no route, worker, table or UI. Every value in the output comes from an
 * argument; the same argument gives the same bytes, whatever the key order of the argument. It never mutates its argument.
 *
 * It renders bytes and nothing else. It judges nothing: the gates run after it. The one-Pine renderer (src/quant-library/package-render.js) is not edited and still
 * refuses a multi-Pine run. The renderer refuses (throws a coded error) only for input it cannot render without inventing a value. A refusal creates no package.
 *
 * renderMultiPackage(input). input:
 *   export_id         server UUID of the export
 *   created_at        ISO-8601 UTC creation time, given by the caller
 *   fixture           boolean, required; every F11-01 package is a fixture (false gives BI_FIXTURE_LABEL_MISSING)
 *   run               durable run view {owner_id, bot_id, run_id, contract, contract_hash, submission_hash, result} of a finished multi-Pine research run
 *   policy            the risk policy snapshot; it must hash to contract.policy_hash
 *   members           [{ordinal, source, signals:{buy, exit}}] one per contract member: the member's original source bytes (they must hash to the contract member's
 *                     source_hash) and the signal mapping of its deployment
 *   producer_closure_hash  the hash of the producer closure (package-closure.js) of the running code, computed by the caller
 *   trace             the output of deriveMultiTrace (package-trace.js): {files, records, limitation_codes, counts}. The renderer re-derives the trace from run and
 *                     producer_closure_hash and refuses RENDER_INPUT_INVALID unless the given trace equals it (files, records, digests, counts and limitation codes)
 *   library_versions  the value frozen in the export row at build
 *   risk_limits       {limit_name: decimal} for risk-profile.json
 *   limitations       optional {codes:[CODE]}; merged with the trace limitation codes
 *   holdout_boundary_ref  optional object, the registered boundary reference
 * Returns a frozen {files, manifest, package_hash, binding_hash, binding}. files maps each path of multiPackageFiles(pine_count) to UTF-8 text.
 */
export const RENDER_REFUSAL_CODES = Object.freeze(['RENDER_INPUT_INVALID', 'RENDER_SOURCE_UNRESOLVED', 'RENDER_ASSEMBLE_FAILED', 'RENDER_CONTENT_REFUSED',
  'BI_FIXTURE_LABEL_MISSING', 'BI_BINDING_INCOMPLETE']);
export const PACKAGE_MARKET = Object.freeze({broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'});
export const MULTI_ARTIFACT_SCHEMAS = Object.freeze({'inputs.json': 'best-inputs-multi-inputs-v1', 'members/*/indicator.json': 'best-inputs-multi-indicator-v1',
  'risk-profile.json': 'best-inputs-risk-profile-v1', 'quant-data/metrics.json': 'best-inputs-multi-metrics-v1', 'quant-data/validation.json': 'best-inputs-multi-validation-v1',
  'quant-data/members/*/parity.json': 'best-inputs-multi-parity-v1', 'quant-data/equity.csv': 'csv-rfc4180-lf-v1', 'quant-data/trades.csv': 'csv-rfc4180-lf-v1',
  'quant-data/decisions.csv': 'csv-rfc4180-lf-v1'});
/**
 * Number formats of the trace artifacts (stated in the manifest, evidence.trace_formats). Decimals the Python ledger printed are copied as stored; decimals the producer
 * computed use the money.js minimal form.
 */
export const TRACE_FORMAT_DESCRIPTION = 'Number formats in quant-data/equity.csv, trades.csv and decisions.csv. Stored Python ledger strings, copied unchanged: cash, quantity, price, fee, entry_price, entry_fee, exit_price, exit_fee and realized_r are 18-decimal strings as the ledger printed them (zero prints as 0E-18, for example realized_r on a BUY). Computed by the producer in money.js minimal decimal form, with no trailing zeros: net, position_quantity and equity_at_fill. Times are integer milliseconds plus ISO-8601 UTC text. Empty cells are null.';
const TRACE_SEMANTICS_BASE = 'Native signals are the alert() calls of the member indicator.pine files and are listed in decisions.csv as decisions, each tagged with the member deployment_id and ordinal. Intents are the accepted, capped or rejected outcomes in decisions.csv. Fills are server-owned Paper fills and appear only as closed rows of trades.csv. A position episode is one row of trades.csv, from entry_time to exit_time. equity.csv is the equity curve of the evaluated Bot account. Metrics are per Bot, never per member.';
const TRACE_SEMANTICS = TRACE_SEMANTICS_BASE + ' ' + TRACE_FORMAT_DESCRIPTION;
const BRIDGE_NAMES = Object.freeze(['atr_multiplier', 'rr']);
const BRIDGE_UNITS = Object.freeze({atr_multiplier: 'ATR multiple', rr: 'reward to risk ratio'});
const PARTITIONS = Object.freeze(['train', 'validation', 'test']);
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPLETION_REASON = 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE';

/** The canonical file list of a multi-Pine package: 10 package-level files plus three per member (docs/MULTI_PINE_CONTRACT.md 6.2). */
export function multiPackageFiles(pineCount) {
  if (!Number.isSafeInteger(pineCount) || pineCount < MP_MIN_MEMBERS || pineCount > MP_MAX_MEMBERS) throw refuse('RENDER_INPUT_INVALID', 'pine_count');
  const ordinals = Array.from({length: pineCount}, (_, index) => index + 1);
  return [
    'inputs.json', 'risk-profile.json', 'setup-guide.md', 'validation.html',
    ...ordinals.flatMap(n => ['members/' + n + '/indicator.pine', 'members/' + n + '/indicator.json']),
    MANIFEST_PATH, 'quant-data/metrics.json', MP_TRACE_PATHS.equity, MP_TRACE_PATHS.trades, MP_TRACE_PATHS.decisions, 'quant-data/validation.json',
    ...ordinals.map(n => 'quant-data/members/' + n + '/parity.json')];
}
export const multiPackageFileCount = pineCount => 10 + 3 * pineCount;

const refuse = (code, detail = '') => Object.assign(new Error(code + (detail ? ': ' + detail : '')), {code, detail});
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = value => typeof value === 'string' && value.length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && HEX64.test(value);
const invalid = detail => refuse('RENDER_INPUT_INVALID', detail);
const deepFreeze = value => { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };
const byOrdinal = (a, b) => a.ordinal - b.ordinal;

/** A value that survives JSON unchanged: plain objects, arrays, strings, booleans, null and finite numbers. */
function plain(value, path, depth = 0) {
  if (depth > 40) throw invalid(path + ' is nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(path + ' is not a finite number'); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => plain(item, path + '[' + index + ']', depth + 1)); return; }
  if (isObject(value)) { for (const key of Object.keys(value)) plain(value[key], path + '.' + key, depth + 1); return; }
  throw invalid(path + ' is not plain data');
}
/** A detached deep copy of plain data. */
function copy(value, path) { plain(value, path); return JSON.parse(JSON.stringify(value)); }
const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value;
/** Canonical file text: keys sorted at every depth, two-space indent, one trailing line feed. */
const jsonText = value => JSON.stringify(sortKeys(value), null, 2) + '\n';

/** Writes a String(number) exponent form such as 1.5e-7 as plain digits, by moving the decimal point, not by rounding. */
function expandExponent(form) {
  const match = form.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
  if (!match) return form;
  const digits = match[2] + (match[3] ?? ''), point = match[2].length + Number(match[4]);
  let whole, fraction;
  if (point <= 0) { whole = '0'; fraction = '0'.repeat(-point) + digits; }
  else if (point >= digits.length) { whole = digits + '0'.repeat(point - digits.length); fraction = ''; }
  else { whole = digits.slice(0, point); fraction = digits.slice(point); }
  whole = whole.replace(/^0+(?=\d)/, ''); fraction = fraction.replace(/0+$/, '');
  return match[1] + whole + (fraction.length ? '.' + fraction : '');
}
/** A decimal string that reads back to exactly the same number, or null. */
function decimalString(value) {
  if (typeof value === 'string') return DECIMAL.test(value) ? value : null;
  if (!finite(value)) return null;
  let out = String(value);
  if (/e/i.test(out)) out = expandExponent(out);
  if (out === '-0') out = '0';
  return DECIMAL.test(out) && Number(out) === value ? out : null;
}
const decimalOrRefuse = (value, path) => { const out = decimalString(value); if (out === null) throw invalid(path + ' has no exact decimal form'); return out; };

const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Text for a Markdown line: whitespace runs become one space, HTML characters are escaped and Markdown punctuation is backslash-escaped. */
const escapeMarkdown = value => escapeHtml(String(value).replace(/\s+/g, ' ').trim()).replace(/[\\`*_[\]()#|!~]/g, '\\$&');

/** A calendar check the lenient Date.parse does not make: real month, day (leap years included) and time of day (no 24:00). */
function calendarValid(stamp) {
  const [year, month, day, hour, minute, second] = stamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/).slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}

/* ---- input checks ---- */

function requireInput(input) {
  if (!isObject(input)) throw invalid('input');
  if (!text(input.export_id) || !UUID.test(input.export_id)) throw invalid('export_id must be a UUID');
  if (typeof input.created_at !== 'string' || !UTC.test(input.created_at) || Number.isNaN(Date.parse(input.created_at)) || !calendarValid(input.created_at)) throw invalid('created_at must be ISO-8601 UTC');
  if (typeof input.fixture !== 'boolean') throw invalid('fixture must be a boolean');
  if (input.fixture !== true) throw refuse('BI_FIXTURE_LABEL_MISSING');
  if (!isObject(input.library_versions)) throw invalid('library_versions');
  if (!isObject(input.risk_limits) || Object.keys(input.risk_limits).length === 0) throw invalid('risk_limits');
  if (!isObject(input.run)) throw invalid('run');
  if (!isObject(input.policy)) throw invalid('policy');
  if (!Array.isArray(input.members)) throw invalid('members');
  if (!isObject(input.trace)) throw invalid('trace');
  if (input.holdout_boundary_ref !== undefined && !isObject(input.holdout_boundary_ref)) throw invalid('holdout_boundary_ref');
  const limitations = input.limitations;
  const codes = limitations === undefined ? [] : isObject(limitations) && (limitations.codes === undefined || Array.isArray(limitations.codes)) ? limitations.codes ?? [] : null;
  if (codes === null || codes.some(code => typeof code !== 'string' || !CODE_PATTERN.test(code))) throw invalid('limitations.codes');
  return codes;
}

function requireRun(run, policy) {
  const {contract, result} = run;
  if (!text(run.owner_id) || !text(run.bot_id) || !text(run.run_id) || !isObject(contract) || !isObject(result)) throw invalid('run owner_id, bot_id, run_id, contract and result');
  if (run.owner_id !== contract.owner_id || run.bot_id !== contract.bot_id) throw invalid('run owner_id and bot_id must equal contract.owner_id and contract.bot_id');
  if (!sha(run.contract_hash) || run.contract_hash !== hash(canonical(contract))) throw invalid('run.contract_hash does not match the contract');
  if (!sha(run.submission_hash)) throw invalid('run.submission_hash');
  if (contract.version !== MULTI_PINE_CONTRACT_VERSION || contract.mode !== MP_MODE || contract.fixture !== true || contract.same_bar_order !== MP_SAME_BAR_ORDER) throw invalid('run.contract is not a multi-Pine fixture contract');
  const members = contract.members;
  if (!Array.isArray(members) || !members.every(isObject) || members.length < MP_MIN_MEMBERS || members.length > MP_MAX_MEMBERS || contract.pine_count !== members.length) throw invalid('contract.members and pine_count');
  members.forEach((member, index) => { if (member.ordinal !== index + 1) throw invalid('contract.members[' + index + '].ordinal'); });
  if (!isObject(contract.dataset) || !isObject(contract.split) || !isObject(contract.capital) || !isObject(contract.model) || !isObject(contract.rules) || !isObject(contract.bridge_domains)) throw invalid('run.contract bodies');
  if (!sha(contract.policy_hash) || hash(canonical(policy)) !== contract.policy_hash) throw invalid('policy does not hash to contract.policy_hash');
  const selected = result.selected;
  if (result.run_id !== run.run_id || result.contract_hash !== run.contract_hash || result.holdout_evaluated !== true || result.completion_reason !== COMPLETION_REASON) throw invalid('run.result is not a finished holdout result of this run');
  if (!isObject(selected) || !isObject(selected.parameters) || !isObject(selected.train) || !isObject(selected.validation) || !isObject(selected.test) || !Array.isArray(selected.sensitivity)
    || !isObject(selected.cost_stress) || !isObject(selected.holdout)) throw invalid('run.result.selected is incomplete');
  // MPC 5.7 member counts: the HOLDOUT funnel of the finished run carries them (diagnostics.members and diagnostics.bot) and the manifest copies them.
  const funnel = result.funnel;
  if (!isObject(funnel) || funnel.step !== 'HOLDOUT' || !isObject(funnel.diagnostics) || !Array.isArray(funnel.diagnostics.members) || funnel.diagnostics.members.length !== members.length
    || !funnel.diagnostics.members.every(isObject) || !isObject(funnel.diagnostics.bot))
    throw invalid('run.result.funnel must be the HOLDOUT funnel with the member and Bot diagnostics');
  const names = Object.keys(selected.parameters).sort();
  if (names.length !== 2 || names[0] !== 'atr_multiplier' || names[1] !== 'rr' || !BRIDGE_NAMES.every(name => finite(selected.parameters[name]) && selected.parameters[name] > 0)) throw invalid('selected parameters must be exactly atr_multiplier and rr');
  return selected;
}

/** Every member field of the binding must be present and well formed; a missing one is BI_BINDING_INCOMPLETE, before any file is built. */
function requireMemberFields(members) {
  for (const member of members) {
    const binding = memberBinding(member);
    for (const key of Object.keys(MEMBER_BINDING_SPEC)) if (!MEMBER_BINDING_SPEC[key](binding[key])) throw refuse('BI_BINDING_INCOMPLETE', 'member ' + member.ordinal + ' ' + key);
  }
}

/** One source per contract member, matched by ordinal, hash-bound to the frozen member. */
function requireMembers(inputMembers, contractMembers) {
  if (inputMembers.length !== contractMembers.length) throw invalid('members count');
  const byOrdinalMap = new Map();
  for (const item of inputMembers) {
    if (!isObject(item) || !Number.isSafeInteger(item.ordinal) || byOrdinalMap.has(item.ordinal)) throw invalid('members ordinal');
    byOrdinalMap.set(item.ordinal, item);
  }
  return contractMembers.map(member => {
    const item = byOrdinalMap.get(member.ordinal);
    if (item === undefined) throw invalid('members[' + member.ordinal + '] missing');
    if (!text(item.source) || !isObject(item.signals)) throw invalid('members[' + member.ordinal + '] source and signals');
    for (const name of ['buy', 'exit']) if (typeof item.signals[name] !== 'string' || !/^[A-Za-z_]\w*$/.test(item.signals[name])) throw invalid('members[' + member.ordinal + '].signals.' + name);
    if (hash(item.source) !== member.source_hash) throw refuse('RENDER_SOURCE_UNRESOLVED', 'member ' + member.ordinal + ': source does not hash to the frozen source_hash');
    return {contract: member, source: item.source, signals: {buy: item.signals.buy, exit: item.signals.exit}};
  });
}

function indicatorMeta(source) {
  const masked = executable(source), at = masked.search(/\bindicator\s*\(/), title = at < 0 ? null : source.slice(at).match(/^indicator\s*\(\s*(?:title\s*=\s*)?"([^"\\\n]*)"/),
    version = source.match(/^\s*\/\/@version=(\d+)\s*$/m);
  return {name: title ? title[1] : null, pine_version: version ? Number(version[1]) : null};
}

/** indicator.pine = assemble(original bytes, selected pair), nothing else changes: the output must start with the original bytes. */
function memberIndicator(member, pair) {
  const {contract} = member;
  let built;
  try {
    built = assemble(member.source, {bridge: {atr_multiplier: pair.atr_multiplier, rr: pair.rr}, signals: {buy: member.signals.buy, exit: member.signals.exit}, bindings: [], fixed_inputs: []},
      {deployment_id: contract.deployment_id, pine_import_id: contract.pine_import_id, source_version: contract.source_version, ...PACKAGE_MARKET});
  } catch (error) { throw refuse('RENDER_ASSEMBLE_FAILED', typeof error?.code === 'string' ? error.code : 'assemble'); }
  const pine = built?.integrated_pine;
  if (typeof pine !== 'string' || pine.length === 0) throw refuse('RENDER_ASSEMBLE_FAILED', 'empty output');
  if (!pine.startsWith(member.source) || built.source_diff?.changed_original_bytes !== 0) throw refuse('RENDER_ASSEMBLE_FAILED', 'original bytes changed');
  // The package is indicator-only: one indicator() declaration and no strategy() in the executable code.
  let code;
  try { code = executable(pine); } catch { throw refuse('RENDER_CONTENT_REFUSED', 'member ' + contract.ordinal + ' indicator.pine is not scannable'); }
  if ([...code.matchAll(/\bindicator\s*\(/g)].length !== 1 || /\bstrategy\s*(?:\(|\.)/.test(code)) throw refuse('RENDER_CONTENT_REFUSED', 'INDICATOR_REQUIRED member ' + contract.ordinal);
  return {pine, appended_bytes: built.source_diff.appended_bytes};
}

/** The trace the producer returned: three CSV files, one record per file tied to those bytes and to this run, and the member counts. */
function requireTrace(trace, contract, result) {
  const paths = Object.values(MP_TRACE_PATHS);
  if (!isObject(trace.files) || paths.some(path => typeof trace.files[path] !== 'string') || Object.keys(trace.files).length !== paths.length) throw invalid('trace.files');
  if (!Array.isArray(trace.records) || trace.records.length !== paths.length) throw invalid('trace.records');
  const decisionsHash = result.combined_baseline?.received_decisions_hash;
  for (const path of paths) {
    const record = trace.records.find(item => isObject(item) && item.path === path);
    if (record === undefined || record.sha256 !== hash(trace.files[path]) || record.method !== MP_TRACE_METHOD || record.run_engine_hash !== contract.engine_hash
      || record.decisions_hash !== decisionsHash || !sha(record.steps_digest) || !sha(record.holdout_digest) || !sha(record.producer_closure_hash)) throw invalid('trace record for ' + path);
  }
  const counts = trace.counts;
  if (!isObject(counts) || !Array.isArray(counts.members) || counts.members.length !== contract.members.length
    || contract.members.some(member => !counts.members.some(item => isObject(item) && item.ordinal === member.ordinal && item.deployment_id === member.deployment_id
      && Number.isSafeInteger(item.decisions) && Number.isSafeInteger(item.fills)))) throw invalid('trace.counts.members');
  if (!Array.isArray(trace.limitation_codes) || trace.limitation_codes.some(code => typeof code !== 'string' || !CODE_PATTERN.test(code))) throw invalid('trace.limitation_codes');
  return trace.limitation_codes;
}

/** N2: the renderer trusts no trace bytes. It re-derives the trace from the run and the producer closure hash and the given trace must equal it, byte for byte and digest for digest. */
function requireDerivation(input, traceCodes) {
  if (!traceCodes.includes(MP_TRACE_LIMITATION)) throw invalid('trace.limitation_codes must contain ' + MP_TRACE_LIMITATION);
  if (!sha(input.producer_closure_hash)) throw invalid('producer_closure_hash');
  let derived;
  try { derived = deriveMultiTrace({run: input.run, producer_closure_hash: input.producer_closure_hash}); } catch (error) { throw invalid('trace re-derivation refused: ' + (typeof error?.code === 'string' ? error.code : 'error')); }
  const pick = trace => canonical({files: trace.files, records: trace.records, counts: trace.counts, limitation_codes: trace.limitation_codes});
  if (pick(input.trace) !== pick(derived)) throw invalid('trace differs from the derivation of the run');
}

/* ---- file builders ---- */

function inputsOf(contract, pair, runId) {
  const domainOf = name => {
    const domain = contract.bridge_domains[name];
    if (!isObject(domain)) throw invalid('bridge_domains.' + name);
    return {min: decimalOrRefuse(domain.min, 'domain ' + name), max: decimalOrRefuse(domain.max, 'domain ' + name), step: decimalOrRefuse(domain.step, 'domain step ' + name)};
  };
  // The actionable block holds exactly atr_multiplier and rr (T-K3). No source input is selected in multi-Pine mode.
  const bridge = Object.fromEntries(BRIDGE_NAMES.map(name => [name, {unit: BRIDGE_UNITS[name], after: decimalOrRefuse(pair[name], 'parameter ' + name), domain: domainOf(name)}]));
  const members = contract.members.map(member => ({ordinal: member.ordinal, deployment_id: member.deployment_id, pine_import_id: member.pine_import_id, source_version: member.source_version,
    source_hash: member.source_hash, effective_input_hash: member.effective_inputs_hash}));
  return {run_id: runId, mode: MP_MODE, pine_count: contract.pine_count, member_set_id: contract.member_set_id, set_hash: contract.set_hash, bridge, source_inputs: [], members};
}

function setupGuide({exportId, runId, contract, built}) {
  const scripts = built.map(({member, meta}) => `- Member ${member.ordinal}: ${meta.name === null ? '(unnamed)' : escapeMarkdown(meta.name)}, file members/${member.ordinal}/indicator.pine, deployment ${escapeMarkdown(member.deployment_id)}, source ${member.source_hash.slice(0, 12)}.`);
  const pair = BRIDGE_NAMES.map(name => '- Bridge ' + name + ': ' + built[0].pair[name] + ' ' + BRIDGE_UNITS[name]);
  return [`# Setup guide`, '',
    'LABELLED ENGINEERING FIXTURE: synthetic data, not a research result and not a recommendation.', '',
    `Status: DRAFT until a validation attempt passes. Export ${exportId}, run ${escapeMarkdown(runId)}.`, '',
    `Multi-Pine Bot with ${contract.pine_count} member indicators. Exit contract: ${contract.members[0].exit_version}. Same-bar order: ${contract.same_bar_order}.`,
    `Market: ${PACKAGE_MARKET.broker} BINANCE:${PACKAGE_MARKET.symbol} Spot, standard candles, chart timeframe ${PACKAGE_MARKET.timeframe} (one minute).`, '',
    '## Member scripts', '', ...scripts, '',
    '## Shared Bridge pair', '', ...pair, 'The same pair applies to every member. No source input is selected in multi-Pine mode.', '',
    '## Steps', '',
    `1. Open a standard BINANCE:${PACKAGE_MARKET.symbol} Spot chart at timeframe ${PACKAGE_MARKET.timeframe}. Each indicator stops with an error on any other chart type, symbol or timeframe.`,
    '2. For each member, create a new Pine indicator in TradingView and paste its indicator.pine completely and unchanged. Compile it and review every warning.',
    '3. Match the two Bridge inputs of every indicator to the shared pair above and to inputs.json. All other source inputs stay at their stored values.',
    '4. Disable native alert() calls of the source indicators through their existing inputs. If that is impossible, execution stays blocked.',
    `5. Create exactly one alert per member deployment, ${contract.pine_count} alerts in all, with the condition set to that member indicator and Any alert() function call. Enter the private webhook address shown by the application in TradingView only. Webhook addresses, keys and credentials are never part of this package.`,
    '6. Leave the alert message field as the alert() calls of the indicator set it. Do not edit or replace the message.',
    '7. Missing verified bars wait up to five seconds without creating a Paper order. A timeout rejects the intent.',
    '8. Protection is observed at bar close and starts on the next bar. SL wins over TP and over native exits.',
    '9. Pine intents do not confirm inventory. The Paper worker controls accepted, capped and rejected fills and targeted exits. Cash, reservations and limits are shared by the Bot.',
    '10. Replacing alerts requires a new deployment and preserved old exits.', '',
    'No Quant support is implied by this package.', ''].join('\n');
}

function metricsTable(metrics) {
  const head = '<tr><th>Metric</th>' + PARTITIONS.map(name => '<th>' + name + '</th>').join('') + '</tr>';
  const body = [...METRIC_KEYS, 'win_rate'].filter(key => PARTITIONS.some(name => Object.hasOwn(metrics[name], key))).map(key =>
    '<tr><td>' + escapeHtml(key) + '</td>' + PARTITIONS.map(name => '<td>' + (Object.hasOwn(metrics[name], key) && metrics[name][key] !== null ? escapeHtml(metrics[name][key]) : '') + '</td>').join('') + '</tr>');
  return '<table>' + head + body.join('') + '</table>';
}
const returnOf = part => isObject(part) && part.net_return_percent !== undefined && part.net_return_percent !== null ? escapeHtml(part.net_return_percent) : 'not recorded';
function validationHtml({exportId, runId, createdAt, selected, metrics, contract, pair, trace}) {
  const params = BRIDGE_NAMES.map(key => '<tr><td>' + escapeHtml(key) + '</td><td>' + escapeHtml(pair[key]) + '</td></tr>').join('');
  const neighbours = selected.sensitivity.map(item => '<tr><td>' + escapeHtml(isObject(item) && item.dimension !== undefined ? item.dimension : '') + '</td><td>' + returnOf(isObject(item) ? item.validation : undefined) + '</td></tr>').join('');
  const members = contract.members.map(member => '<tr><td>' + member.ordinal + '</td><td>' + escapeHtml(member.pine_import_id) + '</td><td>' + escapeHtml(member.deployment_id) + '</td><td>' + escapeHtml(member.source_hash) + '</td></tr>').join('');
  const counts = trace.counts.members.map(item => '<tr><td>' + item.ordinal + '</td><td>' + item.decisions + '</td><td>' + item.fills + '</td></tr>').join('');
  return ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Best Inputs validation</title>',
    '<style>body{font-family:sans-serif;margin:16px;max-width:60rem}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #888;padding:4px 8px;text-align:left}.banner{border:2px solid #b00;padding:8px;font-weight:bold}</style>',
    '</head>', '<body>', '<h1>Best Inputs validation</h1>',
    '<p class="banner">LABELLED ENGINEERING FIXTURE: synthetic data, not a research result and not a recommendation.</p>',
    `<p>Export ${escapeHtml(exportId)}. Run ${escapeHtml(runId)}. Created ${escapeHtml(createdAt)}. Engine ${escapeHtml(contract.engine_hash)}. Member set ${escapeHtml(contract.set_hash)}.</p>`,
    `<h2>Members</h2><table><tr><th>Ordinal</th><th>Indicator</th><th>Deployment</th><th>Source</th></tr>${members}</table>`,
    '<h2>Shared Bridge pair</h2>', `<table><tr><th>Parameter</th><th>Value</th></tr>${params}</table>`,
    '<p>Metrics are per Bot. No source input is selected in multi-Pine mode.</p>',
    '<h2>Metrics of the selected candidate</h2>', metricsTable(metrics),
    '<h2>Robustness</h2>', `<table><tr><th>Neighbour dimension</th><th>Validation return percent</th></tr>${neighbours}</table>`,
    `<p>Cost stress validation return percent: ${returnOf(selected.cost_stress.validation)}.</p>`,
    '<h2>Trace</h2>', `<p>The trace files are derived from the stored holdout decisions. The earlier search steps are not re-evaluated at build.</p>`,
    `<table><tr><th>Member</th><th>Decisions</th><th>Fills</th></tr>${counts}</table>`,
    '<h2>Parity</h2>', '<p>Not recorded at build. Parity, repaint and compile evidence is appended after the build and is shown from its records at read time.</p>',
    '<h2>Execution differences</h2>',
    `<p>Exit contract ${escapeHtml(contract.members[0].exit_version)}. Pine tracks hypothetical entries only. Broker fills, allocation quantities and rejection are server-owned. Protection is observed at bar close and starts on the next bar; SL wins over TP and over native exits. Same-bar order ${escapeHtml(contract.same_bar_order)}.</p>`,
    '</body>', '</html>', ''].join('\n');
}

/* ---- binding ---- */

function memberBinding(member) {
  return {ordinal: member.ordinal, deployment_id: member.deployment_id, pine_import_id: member.pine_import_id, source_version: member.source_version, source_hash: member.source_hash,
    baseline_snapshot_hash: member.deployment_snapshot_hash, effective_input_hash: member.effective_inputs_hash, evidence_hash: member.evidence_hash, exit_version: member.exit_version};
}
const MEMBER_BINDING_SPEC = Object.freeze({ordinal: value => Number.isSafeInteger(value) && value >= 1, deployment_id: text, pine_import_id: text,
  source_version: value => Number.isSafeInteger(value) && value >= 1, source_hash: sha, baseline_snapshot_hash: sha, effective_input_hash: sha, evidence_hash: sha, exit_version: text});
const BINDING_SPEC = Object.freeze({owner_id: text, bot_id: text, run_id: text, contract_hash: sha, submission_hash: sha, member_set_id: text, set_hash: sha, membership_hash: sha,
  pine_count: value => Number.isSafeInteger(value) && value >= MP_MIN_MEMBERS && value <= MP_MAX_MEMBERS, slot_bindings: value => Array.isArray(value) && value.length === 0, mode: value => value === MP_MODE, bridge_pair: isObject, same_bar_order: text,
  members: value => Array.isArray(value) && value.length > 0, input_lock_hash: sha, bridge_domains: isObject, policy_hash: sha, funding_cutoff: value => Number.isSafeInteger(value) && value >= 0,
  capital: isObject, model: isObject, cost_model_version: text, dataset_ref: isObject, split: isObject, engine_hash: sha, rules: isObject, acceptance_blockers: value => Array.isArray(value) && value.every(text),
  library_versions: isObject, library_record_ref: isObject, alert_source: text, exit_version: text, market: isObject, fixture: value => value === true, created_at: value => typeof value === 'string' && UTC.test(value)});
export const MULTI_BINDING_FIELDS = Object.freeze(Object.keys(BINDING_SPEC));
/** Every field is required and nothing is defaulted. holdout_boundary_ref is optional and must be an object when present. */
export const multiBindingComplete = binding => isObject(binding) && MULTI_BINDING_FIELDS.every(key => BINDING_SPEC[key](binding[key]))
  && binding.members.length === binding.pine_count
  && binding.members.every(member => isObject(member) && Object.keys(MEMBER_BINDING_SPEC).every(key => MEMBER_BINDING_SPEC[key](member[key])))
  && (!Object.hasOwn(binding, 'holdout_boundary_ref') || isObject(binding.holdout_boundary_ref));

/* ---- the renderer ---- */

export function renderMultiPackage(input) {
  const callerCodes = requireInput(input), run = input.run, selected = requireRun(run, input.policy), contract = run.contract, result = run.result;
  requireMemberFields(contract.members);
  const members = requireMembers(input.members, contract.members), traceCodes = requireTrace(input.trace, contract, result);
  const pair = {atr_multiplier: selected.parameters.atr_multiplier, rr: selected.parameters.rr};
  const exitVersion = contract.members[0].exit_version;
  if (typeof exitVersion !== 'string' || !SUPPORTED_EXIT_VERSIONS.includes(exitVersion) || contract.members.some(member => member.exit_version !== exitVersion)) throw invalid('exit_version');
  const codes = [...new Set([...callerCodes, ...traceCodes])].sort();

  // inputs.json and the member files
  const inputs = copy(inputsOf(contract, pair, run.run_id), 'inputs');
  const built = members.map(member => {
    const {pine, appended_bytes: appended} = memberIndicator(member, pair);
    const meta = indicatorMeta(member.source), c = member.contract;
    const indicatorJson = copy({ordinal: c.ordinal, deployment_id: c.deployment_id, pine_import_id: c.pine_import_id, source_version: c.source_version, source_hash: c.source_hash,
      effective_input_hash: c.effective_inputs_hash, deployment_snapshot_hash: c.deployment_snapshot_hash, indicator: {name: meta.name, version: c.source_version}, pine_version: meta.pine_version,
      exit_version: exitVersion, alert_source: 'alert_calls', signals: member.signals, symbol: 'BINANCE:' + PACKAGE_MARKET.symbol, timeframe: PACKAGE_MARKET.timeframe,
      bridge_defaults: pair, edits: [], source_diff: {changed_original_bytes: 0, appended_bytes: appended}}, 'indicator.json');
    const parity = copy({ordinal: c.ordinal, deployment_id: c.deployment_id, pine_import_id: c.pine_import_id, source_hash: c.source_hash, effective_input_hash: c.effective_inputs_hash,
      bridge_evidence_hash: c.evidence_hash, state: 'NOT_RECORDED_AT_BUILD'}, 'parity.json');
    return {member: c, pine, indicatorJson, parity, meta, pair};
  });

  // binding tuple (6.1): every field from the run, nothing defaulted
  const memberBindings = contract.members.map(memberBinding);
  const raw = {owner_id: run.owner_id, bot_id: run.bot_id, run_id: run.run_id, contract_hash: run.contract_hash, submission_hash: run.submission_hash, member_set_id: contract.member_set_id,
    set_hash: contract.set_hash, membership_hash: contract.membership_hash, pine_count: contract.pine_count,
    // R3 (root ruling): no policy_version and no ledger_initialization. The policy is pinned by policy_hash, and capital {equity, cash} is the whole ledger initialization in multi
    // mode. Source slots are 0 in multi-Pine mode, so slot_bindings is the empty list.
    slot_bindings: [], mode: MP_MODE, bridge_pair: pair, same_bar_order: contract.same_bar_order,
    members: memberBindings, bridge_domains: contract.bridge_domains, policy_hash: contract.policy_hash, funding_cutoff: contract.funding_cutoff, capital: contract.capital, model: contract.model,
    cost_model_version: contract.model.version, dataset_ref: contract.dataset, split: contract.split, engine_hash: contract.engine_hash, rules: contract.rules,
    acceptance_blockers: contract.acceptance_blockers, library_versions: input.library_versions, library_record_ref: {run_id: run.run_id, result_sha256: hash(canonical(result))},
    alert_source: 'alert_calls', exit_version: exitVersion, market: {...PACKAGE_MARKET}, fixture: true, created_at: input.created_at,
    ...(input.holdout_boundary_ref === undefined ? {} : {holdout_boundary_ref: input.holdout_boundary_ref})};
  // input_lock_hash covers the two Bridge domains plus every member's frozen fixed snapshot.
  const lockSource = {bridge_domains: contract.bridge_domains, members: contract.members.map(member => ({ordinal: member.ordinal, effective_input_hash: member.effective_inputs_hash,
    deployment_snapshot_hash: member.deployment_snapshot_hash}))};
  raw.input_lock_hash = hash(canonical(lockSource));
  // A missing field is incomplete, not "not plain data": undefined becomes null before the completeness check.
  const withNulls = value => Array.isArray(value) ? value.map(withNulls) : isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === undefined ? null : withNulls(item)])) : value;
  if (!multiBindingComplete(withNulls(raw))) throw refuse('BI_BINDING_INCOMPLETE');
  const binding = copy(raw, 'binding');
  binding.members.sort(byOrdinal);

  // risk-profile.json and quant-data
  const limits = Object.fromEntries(Object.keys(input.risk_limits).sort().map(name => [name, decimalOrRefuse(input.risk_limits[name], 'risk_limits.' + name)]));
  const riskProfile = copy({policy_hash: contract.policy_hash, policy: input.policy, limits}, 'risk-profile');
  const copied = copy(selected, 'run.result.selected');
  // The re-derivation comes after every check of the run's own fields, so a malformed run is named by its own refusal, not as a trace difference.
  requireDerivation(input, traceCodes);
  const metrics = {train: copied.train, validation: copied.validation, test: copied.test};
  const validation = {mode: MP_MODE, candidate: {parameters: copied.parameters, train: copied.train, validation: copied.validation, decision_count: copied.decision_count, fills: copied.fills,
    ledger_hash: copied.ledger_hash}, sensitivity: copied.sensitivity, cost_stress: copied.cost_stress, holdout: {test: copied.test, step: copied.holdout},
  combined_baseline: copy(result.combined_baseline, 'run.result.combined_baseline'), funnel: copy({step: result.funnel.step, diagnostics: result.funnel.diagnostics}, 'run.result.funnel'),
    trace: {method: MP_TRACE_METHOD, records: copy(input.trace.records, 'trace.records')},
  parity: {state: 'NOT_RECORDED_AT_BUILD'}};

  const files = {
    'inputs.json': jsonText(inputs),
    'risk-profile.json': jsonText(riskProfile),
    'setup-guide.md': setupGuide({exportId: input.export_id, runId: run.run_id, contract, built}),
    'validation.html': validationHtml({exportId: input.export_id, runId: run.run_id, createdAt: input.created_at, selected: copied, metrics, contract, pair, trace: input.trace}),
    'quant-data/metrics.json': jsonText(metrics),
    'quant-data/validation.json': jsonText(validation),
    [MP_TRACE_PATHS.equity]: input.trace.files[MP_TRACE_PATHS.equity],
    [MP_TRACE_PATHS.trades]: input.trace.files[MP_TRACE_PATHS.trades],
    [MP_TRACE_PATHS.decisions]: input.trace.files[MP_TRACE_PATHS.decisions]};
  for (const item of built) {
    const n = item.member.ordinal;
    files['members/' + n + '/indicator.pine'] = item.pine;
    files['members/' + n + '/indicator.json'] = jsonText(item.indicatorJson);
    files['quant-data/members/' + n + '/parity.json'] = jsonText(item.parity);
  }
  const limitationText = 'Labelled engineering fixture. Not a research result and not a recommendation.' + (codes.length ? ' Limitation codes: ' + codes.join(', ') + '.' : '');
  const manifest = buildManifest({identity: {export_id: input.export_id, bot_id: run.bot_id, run_id: run.run_id, created_at: input.created_at}, binding,
    inputs: {inputs_sha256: hash(files['inputs.json'])},
    evidence: {engine_hash: contract.engine_hash, run_id: run.run_id, result_sha256: hash(canonical(result)), artifact_schemas: MULTI_ARTIFACT_SCHEMAS, trace_semantics: TRACE_SEMANTICS,
      mode: MP_MODE, pine_count: contract.pine_count, membership_hash: contract.membership_hash, set_hash: contract.set_hash,
      member_counts: copy(input.trace.counts.members, 'trace.counts.members'), member_funnel: copy({step: result.funnel.step, diagnostics: result.funnel.diagnostics}, 'run.result.funnel'),
      trace_formats: TRACE_FORMAT_DESCRIPTION, trace_records: copy(input.trace.records, 'trace.records')},
    limitations: {text: limitationText, codes}, fixture: true, files});
  files[MANIFEST_PATH] = jsonText(manifest);

  // The renderer is the last line before storage: refuse content the C1 scan would refuse, and a file set that is not the canonical set.
  const list = multiPackageFiles(contract.pine_count);
  const ordered = Object.fromEntries(list.map(path => [path, files[path]]));
  if (Object.keys(files).length !== list.length || list.length !== multiPackageFileCount(contract.pine_count) || list.some(path => typeof ordered[path] !== 'string')) throw refuse('RENDER_CONTENT_REFUSED', 'file set');
  const found = [...new Set(list.flatMap(path => scanContent(ordered[path])))];
  if (found.length) throw refuse('RENDER_CONTENT_REFUSED', found.join(','));

  const parsed = JSON.parse(ordered[MANIFEST_PATH]);
  return deepFreeze({files: ordered, manifest: parsed, package_hash: packageHash(parsed), binding_hash: bindingHash(binding), binding});
}
