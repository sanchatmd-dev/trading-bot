import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspect} from 'node:util';
import {fileURLToPath} from 'node:url';

/*
 * F11-01 R6-6: private-input reader, leak controls and hash-only summary for the RD-MP-34 acceptance run (docs/MULTI_PINE_CONTRACT.md RD-MP-34, RD-MP-43).
 * Used by test/postgres/mp-private-acceptance.test.mjs and test/helpers/mp-acceptance-world.mjs. This file is a test helper: it adds no product code and no runtime path.
 *
 * Rules this module keeps (the static check in the test file pins them):
 *  - It imports nothing from src/ at load time. The one comparison that needs a product constant (SOURCE_HASH, the effective inputs hash recipe) imports it lazily, after the
 *    inputs exist, so a skipped run loads no store, executor or runner module.
 *  - Private bytes (the reviewed SPT source and the reviewed analyses) live only in memory inside PrivateInputs. Errors carry a role and a code. Nothing here prints a path or content.
 *  - The only file this module writes is the hash-only summary, under the git-ignored .qa-local/ directory (the block between the SUMMARY-WRITER markers).
 */

export const REPO_ROOT = fsSync.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
export const MANIFEST_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'mp-combined', 'private-inputs.manifest.json');
export const FIXTURES_DIR = fsSync.realpathSync(path.join(REPO_ROOT, 'test', 'fixtures'));
export const SUMMARY_RELATIVE_DIR = '.qa-local/f11-private-acceptance';
export const SUMMARY_FILE = 'summary.json';
export const MAX_PRIVATE_FILE_BYTES = 4 * 1024 * 1024;
export const REQUIRED_ROLES = Object.freeze(['spt_source', 'analysis_m1', 'analysis_m2']);
export const INPUT_COUNT = 58;

export const PRIVATE_CODES = Object.freeze({
  MISSING: 'PRIVATE_INPUT_MISSING',
  HASH_MISMATCH: 'PRIVATE_INPUT_HASH_MISMATCH',
  UNPINNED: 'PRIVATE_INPUTS_UNPINNED',
  SHAPE: 'PRIVATE_INPUT_SHAPE',
  LOCATION: 'PRIVATE_INPUT_LOCATION',
  CLUSTER: 'PRIVATE_CLUSTER_NOT_FRESH',
  PINS: 'PRIVATE_PINS_UNCOMMITTED',
  REUSE: 'PRIVATE_HOLDOUT_REUSE'
});

const ERROR_HASH_KEY = randomBytes(32);
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_NAME = /^[A-Za-z0-9_]{1,63}$/;
const SAFE_TEXT = /^[A-Za-z0-9_.:@+,-]{0,80}$/;
export const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An input problem: a code and a role only. The message never holds a path, a value or content. */
export class PrivateInputError extends Error {
  constructor(code, role = null) {
    super(role ? code + ' (' + role + ')' : code);
    this.name = 'PrivateInputError';
    this.code = code;
    this.role = role;
  }
}

/* ------------------------------------------------------------------ leak controls ------------------------------------------------------------------ */

/**
 * An error that replaced one which could carry private bytes. It holds a label, a code, a constraint name and the first 8 hex characters of a process-keyed HMAC-SHA-256 of the original message.
 * It has no cause, no detail, no where, no stack of the original, and no message of the original.
 */
export class PrivateSafeError extends Error {
  constructor({label, code, constraint, errorHash}) {
    super(label + ': ' + code + (constraint ? ' ' + constraint : '') + ' [' + errorHash + ']');
    this.name = 'PrivateSafeError';
    this.label = label;
    this.code = code;
    this.constraint = constraint;
    this.error_hash = errorHash;
    this.stack = this.name + ': ' + this.message;
  }
}

/** A failed acceptance check. Values are shown only when they are numbers, booleans or short code-like strings; a 64-hex value is shown as an 8-hex prefix. */
export class AcceptanceCheckError extends PrivateSafeError {
  constructor(label, shown) {
    super({label, code: 'CHECK_FAILED', constraint: shown, errorHash: '--------'});
    this.name = 'AcceptanceCheckError';
    this.stack = this.name + ': ' + this.message;
  }
}

const shownValue = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string' && HEX64.test(value)) return 'hash:' + value.slice(0, 8);
  if (typeof value === 'string' && SAFE_TEXT.test(value)) return value;
  return '<redacted>';
};

/**
 * Replaces any error with a PrivateSafeError. The code is kept when it is code-like (a PostgreSQL SQLSTATE such as 23514 or QR004, a job code, a Node code). The constraint name is kept when it is
 * identifier-like. The message, detail, where, hint, query text and stack of the original are dropped. For an AggregateError the first inner error gives the code.
 */
export function safeError(label, error) {
  try {
    if (error instanceof PrivateSafeError) return error;
    let source = error;
    if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) source = error.errors[0];
    const rawCode = source?.code;
    const code = typeof rawCode === 'string' && (SAFE_CODE.test(rawCode) || /^[0-9A-Z]{5}$/.test(rawCode)) ? rawCode : 'PRIVATE_CALL_FAILED';
    const rawConstraint = source?.constraint;
    const constraint = typeof rawConstraint === 'string' && SAFE_NAME.test(rawConstraint) ? rawConstraint : null;
    const message = typeof source?.message === 'string' ? source.message : String(source);
    return new PrivateSafeError({label: SAFE_TEXT.test(String(label)) ? String(label) : 'private_call', code, constraint,
      errorHash: createHmac('sha256', ERROR_HASH_KEY).update(message).digest('hex').slice(0, 8)});
  } catch {
    return new PrivateSafeError({label: 'private_call', code: 'PRIVATE_CALL_FAILED', constraint: null, errorHash: '00000000'});
  }
}

/** Runs fn and rethrows any failure as a PrivateSafeError (the leak-control rethrow wrapper). Wrap every call that carries private bytes. */
export async function guard(label, fn) {
  try { return await fn(); }
  catch (error) { throw safeError(label, error); }
}

/** Compares two SHA-256 hex strings and fails with the 8-hex prefixes only. Anything that is not a 64-hex string is refused without printing it. */
export function assertHashEqual(label, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HEX64.test(a) || !HEX64.test(b)) throw new AcceptanceCheckError(label, 'not-a-hash');
  if (a !== b) throw new AcceptanceCheckError(label, 'hash:' + a.slice(0, 8) + ' vs hash:' + b.slice(0, 8));
}

/** expectEqual(label, actual, expected): primitives and code-like strings only. A mismatch shows the two safe values. */
export function expectEqual(label, actual, expected) {
  if (actual !== expected) throw new AcceptanceCheckError(label, shownValue(actual) + ' vs ' + shownValue(expected));
}

export function expectTrue(label, condition) {
  if (condition !== true) throw new AcceptanceCheckError(label, 'not true');
}

/* ------------------------------------------------------------------ the private inputs ------------------------------------------------------------------ */

/**
 * The validated private inputs. The source text and the analyses are private fields: they never appear in util.inspect, JSON or a spread. hashes() is the only view that may be printed.
 */
export class PrivateInputs {
  #source; #analyses; #hashes;
  constructor({source, analyses, hashes}) {
    this.#source = source;
    this.#analyses = analyses;
    this.#hashes = Object.freeze({...hashes});
  }
  /** The reviewed SPT source text. Private. */
  sourceText() { return this.#source; }
  /** A copy of the reviewed analysis of a role ('analysis_m1' or 'analysis_m2'). Private. */
  analysis(role) {
    if (!Object.hasOwn(this.#analyses, role)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, role);
    return structuredClone(this.#analyses[role]);
  }
  hashes() { return this.#hashes; }
  toJSON() { return this.#hashes; }
  [inspect.custom]() { return 'PrivateInputs{hash-only}'; }
}

const gitIgnored = absolute => {
  // read-only: exit 0 when the path is ignored, 1 when not, 128 when git cannot decide (outside the repository)
  const out = spawnSync('git', ['check-ignore', '-q', '--', absolute], {cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true});
  return out.status;
};
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Reads, pins and shape-checks the private inputs named by test/fixtures/mp-combined/private-inputs.manifest.json. Nothing is read from the database and nothing is written.
 *   env: the environment (default process.env); manifest: a parsed manifest object and io: {lstat, realpath, readFile} (tests only; default the committed file and the real file system).
 *   expectedSourceHash is a test-only argument, never environment-controlled; beforeRead runs after missing/location/pin checks and before any private file read.
 * Returns {state:'absent', reason} when the directory variable is unset and the require variable is not 1; {state:'ready', inputs: PrivateInputs} when every check holds.
 * Throws PrivateInputError (code and role only) for anything else, including an unset directory when the require variable is 1.
 */
export async function readPrivateInputs({env = process.env, manifest, io = fs, expectedSourceHash, beforeRead} = {}) {
  const spec = manifest ?? JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  if (!isObject(spec) || !Array.isArray(spec.files) || typeof spec.directory_env !== 'string' || typeof spec.require_env !== 'string') throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'manifest');
  const entries = new Map(spec.files.map(entry => [entry?.role, entry]));
  for (const role of REQUIRED_ROLES) if (!isObject(entries.get(role)) || typeof entries.get(role).file !== 'string') throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'manifest');
  const required = env[spec.require_env] === '1';
  const given = env[spec.directory_env];
  if (typeof given !== 'string' || given.length === 0) {
    if (required) throw new PrivateInputError(PRIVATE_CODES.MISSING, 'directory');
    return {state: 'absent', reason: 'NOT RUN: ' + spec.directory_env + ' is not set; missing private inputs: ' + REQUIRED_ROLES.join(', ')};
  }
  // 1. the directory: exists, is a real directory (no link, no junction), outside test/fixtures, git-ignored when inside the repository
  const directory = path.resolve(given);
  let real;
  try {
    const stat = await io.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PrivateInputError(PRIVATE_CODES.MISSING, 'directory');
    real = await io.realpath(directory);
  } catch (error) {
    if (error instanceof PrivateInputError) throw error;
    throw new PrivateInputError(PRIVATE_CODES.MISSING, 'directory');
  }
  if (inside(FIXTURES_DIR, real)) throw new PrivateInputError(PRIVATE_CODES.LOCATION, 'directory');
  // 2. every pin is present (a null pin is unpinned)
  for (const role of REQUIRED_ROLES) {
    const entry = entries.get(role);
    if (typeof entry.sha256 !== 'string' || !HEX64.test(entry.sha256)) throw new PrivateInputError(PRIVATE_CODES.UNPINNED, role);
    if (role !== 'spt_source' && (typeof entry.effective_inputs_hash !== 'string' || !HEX64.test(entry.effective_inputs_hash))) throw new PrivateInputError(PRIVATE_CODES.UNPINNED, role);
  }
  // The owner harness checks provenance and cluster freshness here, before reading any private file byte.
  if (beforeRead) await beforeRead();
  // 3. the files: exactly the manifest names, regular files, no link, inside the directory, at most 4 MiB, SHA-256 of the raw bytes equals the pin
  const raw = new Map();
  for (const role of REQUIRED_ROLES) {
    const entry = entries.get(role);
    if (entry.file !== path.basename(entry.file) || entry.file.length === 0) throw new PrivateInputError(PRIVATE_CODES.SHAPE, role);
    const file = path.join(directory, entry.file);
    let bytes;
    try {
      const stat = await io.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PRIVATE_FILE_BYTES) throw new PrivateInputError(PRIVATE_CODES.MISSING, role);
      const realFile = await io.realpath(file);
      if (path.dirname(realFile) !== real) throw new PrivateInputError(PRIVATE_CODES.MISSING, role);
      if (inside(REPO_ROOT, realFile) && gitIgnored(realFile) !== 0) throw new PrivateInputError(PRIVATE_CODES.LOCATION, role);
      bytes = await io.readFile(file);
    } catch (error) {
      if (error instanceof PrivateInputError) throw error;
      throw new PrivateInputError(PRIVATE_CODES.MISSING, role);
    }
    if (bytes.length > MAX_PRIVATE_FILE_BYTES) throw new PrivateInputError(PRIVATE_CODES.MISSING, role);
    if (sha256Hex(bytes) !== entry.sha256) throw new PrivateInputError(PRIVATE_CODES.HASH_MISMATCH, role);
    raw.set(role, bytes);
  }
  // 4. the product constants, imported only now
  const SOURCE_HASH = expectedSourceHash ?? (await import('../../src/quant-research/contract.js')).SOURCE_HASH;
  const {effectiveInputsHash} = await import('../../src/multi-pine/fixture-service.js');
  // 5. the source: no line-ending or BOM normalisation. The decoded text must hash back to the same value, and the value is SOURCE_HASH.
  const sourceBytes = raw.get('spt_source');
  const source = sourceBytes.toString('utf8');
  if (sha256Hex(sourceBytes) !== SOURCE_HASH || sha256Hex(source) !== SOURCE_HASH) throw new PrivateInputError(PRIVATE_CODES.HASH_MISMATCH, 'spt_source');
  // 6. the analyses
  const analyses = {}, hashes = {spt_source_sha256: sha256Hex(sourceBytes), source_hash: SOURCE_HASH};
  for (const role of ['analysis_m1', 'analysis_m2']) {
    const entry = entries.get(role);
    let analysis;
    try { analysis = JSON.parse(raw.get(role).toString('utf8')); } catch { throw new PrivateInputError(PRIVATE_CODES.SHAPE, role); }
    const inputs = analysis?.inputs;
    if (!isObject(analysis) || !Array.isArray(inputs) || inputs.length !== INPUT_COUNT) throw new PrivateInputError(PRIVATE_CODES.SHAPE, role);
    const seen = new Set();
    for (const input of inputs) {
      if (!isObject(input) || typeof input.input_id !== 'string' || typeof input.pine_variable !== 'string' || !Object.hasOwn(input, 'effective_value') || seen.has(input.input_id)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, role);
      seen.add(input.input_id);
    }
    const review = analysis.effective_input_review;
    if (!isObject(review) || review.source_hash !== SOURCE_HASH || review.input_count !== INPUT_COUNT) throw new PrivateInputError(PRIVATE_CODES.SHAPE, role);
    let computed;
    try { computed = effectiveInputsHash(analysis); } catch { throw new PrivateInputError(PRIVATE_CODES.SHAPE, role); }
    if (computed !== analysis.effective_inputs_hash || computed !== entry.effective_inputs_hash || review.effective_inputs_hash !== computed) throw new PrivateInputError(PRIVATE_CODES.HASH_MISMATCH, role);
    analyses[role] = analysis;
    hashes[role + '_sha256'] = sha256Hex(raw.get(role));
    hashes[role + '_effective_inputs_hash'] = computed;
  }
  if (hashes.analysis_m1_effective_inputs_hash === hashes.analysis_m2_effective_inputs_hash) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'analysis_m2');
  return {state: 'ready', inputs: new PrivateInputs({source, analyses, hashes})};
}

/** The gate the test file uses: never throws. {state:'absent', reason} | {state:'ready', inputs} | {state:'refused', code, role}. */
export async function privateGate(env = process.env, manifest, {beforeRead} = {}) {
  try { return await readPrivateInputs({env, manifest, beforeRead}); }
  catch (error) {
    if (error instanceof PrivateInputError) return {state: 'refused', code: error.code, role: error.role};
    return {state: 'refused', code: 'PRIVATE_INPUT_UNEXPECTED', role: null};
  }
}

/* ------------------------------------------------------------------ the hash-only summary ------------------------------------------------------------------ */

/** A fact may be a boolean, a finite number, a 64-hex string, a short code-like string, null, or an array of those. Anything else is refused: a summary cannot carry text. */
export function isSafeFact(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return HEX64.test(value) || SAFE_TEXT.test(value);
  if (Array.isArray(value)) return depth === 0 && value.length <= 200 && value.every(item => isSafeFact(item, 1));
  return false;
}

export const CASE_STATUSES = Object.freeze({NOT_RUN: 'NOT_RUN', HELD: 'CHECKS_HELD', FAILED: 'CHECKS_FAILED'});
export const CASE_LABELS = Object.freeze(['PRIV', 'SYN']);

/**
 * The summary of one acceptance run. It records, per case: a PRIV or SYN label, the F items, a status (NOT_RUN, CHECKS_HELD or CHECKS_FAILED), the checks that held and facts (hashes, codes, counts).
 * It never marks a case as accepted: the decision stays with root (RD-MP-43), and the top-level decision is the constant NONE.
 */
export class AcceptanceSummary {
  #header; #cases = new Map();
  constructor(header = {}) {
    for (const [key, value] of Object.entries(header)) if (!SAFE_NAME.test(key) || !isSafeFact(value)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'summary.' + key);
    this.#header = {...header};
  }
  setHeader(key, value) {
    if (!SAFE_NAME.test(key) || !isSafeFact(value)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'summary.' + key);
    this.#header[key] = value;
  }
  #entry(id, label, fItems) {
    if (!SAFE_NAME.test(id) || !CASE_LABELS.includes(label) || !Array.isArray(fItems) || !fItems.every(item => SAFE_NAME.test(item))) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'case');
    if (!this.#cases.has(id)) this.#cases.set(id, {id, label, f_items: [...fItems], status: CASE_STATUSES.NOT_RUN, reason: null, checks: [], facts: {}});
    return this.#cases.get(id);
  }
  /** Registers a case as NOT RUN (the default state of every case). */
  declare(id, label, fItems) { this.#entry(id, label, fItems); }
  notRun(id, label, fItems, reason) {
    const entry = this.#entry(id, label, fItems);
    entry.status = CASE_STATUSES.NOT_RUN;
    entry.reason = isSafeFact(reason) && typeof reason === 'string' ? reason : 'NOT_RUN';
  }
  /** The case body gets a recorder: check(label, held), fact(key, value). The status becomes CHECKS_HELD only when every check held and none threw. */
  async run(id, label, fItems, body) {
    const entry = this.#entry(id, label, fItems);
    entry.reason = null;
    const recorder = {
      fact: (key, value) => { if (!SAFE_NAME.test(key) || !isSafeFact(value)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'fact.' + key); entry.facts[key] = value; },
      check: (checkLabel, held) => { if (!SAFE_NAME.test(checkLabel)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'check'); entry.checks.push({label: checkLabel, held: held === true}); if (held !== true) throw new AcceptanceCheckError(checkLabel, 'not true'); },
      equal: (checkLabel, actual, expected) => { if (!SAFE_NAME.test(checkLabel)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'check'); entry.checks.push({label: checkLabel, held: actual === expected}); expectEqual(checkLabel, actual, expected); },
      hashEqual: (checkLabel, a, b) => { if (!SAFE_NAME.test(checkLabel)) throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'check'); entry.checks.push({label: checkLabel, held: typeof a === 'string' && a === b}); assertHashEqual(checkLabel, a, b); }
    };
    try {
      await body(recorder);
      entry.status = CASE_STATUSES.HELD;
    } catch (error) {
      entry.status = CASE_STATUSES.FAILED;
      const safe = safeError(id, error);
      entry.facts.failure_code = safe.code;
      entry.facts.failure_hash = safe.error_hash;
      throw safe;
    }
  }
  toJSON() {
    return {
      ...this.#header,
      version: 'mp-private-acceptance-summary-v1',
      decision: 'NONE',
      note: 'hash-only evidence for root review; the decision stays with root',
      cases: [...this.#cases.values()].map(entry => ({...entry, checks: entry.checks.map(item => ({...item})), facts: {...entry.facts}}))
    };
  }
}

/** The path of a summary file: always under <repo>/.qa-local/f11-private-acceptance/, a plain file name only. */
export function summaryPath(fileName = SUMMARY_FILE) {
  if (typeof fileName !== 'string' || !/^[A-Za-z0-9._-]{1,80}\.json$/.test(fileName) || fileName.startsWith('.')) throw new PrivateInputError(PRIVATE_CODES.LOCATION, 'summary');
  const directory = path.join(REPO_ROOT, ...SUMMARY_RELATIVE_DIR.split('/'));
  const full = path.join(directory, fileName);
  if (!inside(path.join(REPO_ROOT, '.qa-local'), full) || path.dirname(full) !== directory) throw new PrivateInputError(PRIVATE_CODES.LOCATION, 'summary');
  return full;
}

// SUMMARY-WRITER-BEGIN
/** Writes the hash-only summary. Refuses unless the summary directory is git-ignored. This is the only file write of the three harness files. */
export function writeAcceptanceSummary(summary, fileName = SUMMARY_FILE) {
  const target = summaryPath(fileName);
  const value = typeof summary?.toJSON === 'function' ? summary.toJSON() : summary;
  if (!isObject(value) || value.decision !== 'NONE' || !Array.isArray(value.cases) || value.cases.some(entry => !isObject(entry) || !Object.values(CASE_STATUSES).includes(entry.status))) {
    throw new PrivateInputError(PRIVATE_CODES.SHAPE, 'summary_status');
  }
  const directory = path.dirname(target);
  fsSync.mkdirSync(directory, {recursive: true});
  if (gitIgnored(directory) !== 0) throw new PrivateInputError(PRIVATE_CODES.LOCATION, 'summary');
  const body = JSON.stringify(value, null, 1) + '\n';
  fsSync.writeFileSync(target, body, {encoding: 'utf8'});
  return {sha256: sha256Hex(body), bytes: Buffer.byteLength(body)};
}
// SUMMARY-WRITER-END

/** The commit and the cleanliness of the working tree, read only. Hash-only facts. */
const provenanceFiles = Object.freeze({
  manifest: 'test/fixtures/mp-combined/private-inputs.manifest.json',
  source_hash_definition: 'src/quant-research/contract.js',
  private_inputs_helper: 'test/helpers/mp-private-inputs.mjs',
  acceptance_world_helper: 'test/helpers/mp-acceptance-world.mjs',
  acceptance_test: 'test/postgres/mp-private-acceptance.test.mjs'
});

export function repositoryFacts({run = args => spawnSync('git', args, {cwd: REPO_ROOT, windowsHide: true}), read = file => fsSync.readFileSync(file)} = {}) {
  const head = run(['rev-parse', 'HEAD']), status = run(['status', '--porcelain']);
  const commit = head.status === 0 ? String(head.stdout).trim() : '';
  if (!/^[0-9a-f]{40}$/.test(commit) || status.status !== 0) throw new PrivateInputError(PRIVATE_CODES.PINS);
  const facts = {commit, tree_clean: String(status.stdout).trim().length === 0};
  for (const [label, file] of Object.entries(provenanceFiles)) {
    const committed = run(['show', 'HEAD:' + file]);
    let bytes;
    try { bytes = read(path.join(REPO_ROOT, file)); } catch { throw new PrivateInputError(PRIVATE_CODES.PINS); }
    facts[label + '_sha256'] = sha256Hex(bytes);
    facts[label + '_matches_head'] = committed.status === 0 && sha256Hex(committed.stdout) === facts[label + '_sha256'];
  }
  return facts;
}

export function assertCommittedPins(facts) {
  if (facts.manifest_matches_head !== true || facts.source_hash_definition_matches_head !== true) throw new PrivateInputError(PRIVATE_CODES.PINS);
}
