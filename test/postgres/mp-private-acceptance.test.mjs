import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inspect} from 'node:util';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  AcceptanceCheckError, AcceptanceSummary, CASE_STATUSES, FIXTURES_DIR, MANIFEST_PATH, PRIVATE_CODES, PrivateInputError, PrivateSafeError, REPO_ROOT, REQUIRED_ROLES, SUMMARY_RELATIVE_DIR,
  assertHashEqual, expectEqual, guard, isSafeFact, privateGate, readPrivateInputs, repositoryFacts, safeError, sha256Hex, summaryPath, writeAcceptanceSummary
} from '../helpers/mp-private-inputs.mjs';
import {
  STRESS_FAILS, SYN_SOURCE, admitWorldRun, analysisMatchesFixture, changeOneDefaultByte, changedTables, createAcceptanceContext, digestAll, digestHash, fixtureDifference, gatedRunner,
  multiPineRefusals, newAcceptanceWorld, packageCounts, packageDigest, rowsFor, runWorld, sideDigest, syntheticAnalysis, tamperStoredFile, variantAnalysis
} from '../helpers/mp-acceptance-world.mjs';

/*
 * F11-01 R6-6: the RD-MP-34 private-source acceptance harness (docs/MULTI_PINE_CONTRACT.md RD-MP-34, RD-MP-43). ONE skipped-by-default node:test file; the helpers are
 * test/helpers/mp-private-inputs.mjs and test/helpers/mp-acceptance-world.mjs. There is no new script and no new runtime path.
 *
 * WHO RUNS WHAT. The owner runs the private cases locally (RD-MP-34): the reviewed SPT source and the two reviewed analyses sit in one git-ignored directory named by MP_PRIVATE_INPUTS_DIR, the
 * pins of the analyses are recorded in test/fixtures/mp-combined/private-inputs.manifest.json, and TEST_DATABASE_URL names a throwaway PostgreSQL cluster. Nothing else runs them.
 *   - Without MP_PRIVATE_INPUTS_DIR every private case is NOT RUN (skipped, with a reason that names the missing input). The tests that need no private input still run: the static check of the three
 *     harness files, the leak-control wrapper, the input reader (on an in-memory file system), the summary and the MP_REQUIRE_PRIVATE=1 refusal (a child process, with no reachable database).
 *   - With MP_REQUIRE_PRIVATE=1 and missing, unpinned or mismatching inputs the "private inputs" test fails and no database is touched (the private cases are skipped, and the before hook
 *     returns first).
 *   - A skipped run imports no store, executor or Python-runner module (those are imported lazily by mp-acceptance-world.mjs, after the inputs are valid).
 *
 * THE CASES. P1 to P9 and the optional PX follow section 5.2 of the R6 judgement. Each packaged run has its own owner and Bot (judgement J3). The harness NEVER marks a case accepted: it records
 * CHECKS_HELD, CHECKS_FAILED or NOT_RUN per case, labelled PRIV (the reviewed source ran in the real job) or SYN (the committed synthetic source behind the gate wrapper), in a hash-only summary
 * under .qa-local/f11-private-acceptance/. Root reviews the summary and copies the reviewed record to docs/evidence/. Every compile and evidence record is a fixture record (RD-MP-41), so F17 is a
 * mechanics pass only, as is every package case.
 *   P1 owner A   F17, F27, F28, F23, F22   P2 owner B   F19   P3 owner C   F18   P4 owner D   F20   P5 owner E reads A   F21   P6 owner A after P1   F10, F11
 *   P7 owner F   F24 (O7)                  P8 owner G   F29 (O7)   P9 owner A   F30 QR-3 half   PX optional operator path (MP_ACCEPTANCE_OPERATOR_PATH=1)
 *   P0 (the Python private tests) is pytest, run before this file: quant_lab/tests/test_mp_combined_job.py with MP_REQUIRE_PRIVATE=1 (readiness step 3).
 *   F1 to F9, F12 to F16, F25, F26 do not depend on the source and run in their committed suites; the evidence record labels them SYN (RD-MP-43).
 *
 * LEAK CONTROLS. Assertions compare hashes, codes and counts only (no deep equality anywhere in the harness files). Every call that carries private bytes is wrapped by guard(), which replaces any
 * error with a hash-only error. The cluster gets database-level log controls before the first private byte (mp-acceptance-world.mjs) and the harness refuses to continue if it cannot prove them.
 * The Python runner passes no private variable to the child; the source reaches Python only in the stdin request built from pine_source_revisions.
 *
 * O7 (judgement section 6). MP_ACCEPTANCE_O7=yes lets the harness derive fixture-labelled variants of the private member-2 analysis (P7, P8; hashes recomputed, kept only inside the throwaway
 * cluster). Any other value runs P7 and P8 as SYN on the committed synthetic source behind the gate wrapper (the REAL JOB cases of test/postgres/mp-executor.test.mjs, here on the acceptance cluster).
 */
const HERE = fileURLToPath(import.meta.url);
/** Compares two small public values (codes, statuses, counts) by their JSON text. */
const sameJson = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const HELPER_FILES = [new URL('../helpers/mp-private-inputs.mjs', import.meta.url), new URL('../helpers/mp-acceptance-world.mjs', import.meta.url), new URL(import.meta.url)];
const IS_CHILD = process.env.MP_ACCEPTANCE_CHILD === '1';
const O7_YES = process.env.MP_ACCEPTANCE_O7 === 'yes';
const OPERATOR_PATH = process.env.MP_ACCEPTANCE_OPERATOR_PATH === '1';
const SOURCE_INDEPENDENT_F_ITEMS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F12', 'F13', 'F14', 'F15', 'F16', 'F25', 'F26'];

const GATE = await privateGate(process.env);
const SKIP = GATE.state === 'ready' ? false
  : GATE.state === 'absent' ? GATE.reason
    : 'NOT RUN: private inputs refused: ' + GATE.code + (GATE.role ? ' (' + GATE.role + ')' : '');

const SUMMARY = new AcceptanceSummary({
  harness_version: 'mp-private-acceptance-v1', source_independent_f_items: SOURCE_INDEPENDENT_F_ITEMS, p0_python_private_tests: 'EXTERNAL_PYTEST',
  o7_mode: O7_YES ? 'yes' : 'no', node_version: process.version, private_inputs_state: GATE.state
});

/* ======================================================================================================================================================= */
/* Tests that need no private input                                                                                                                         */
/* ======================================================================================================================================================= */

test('private inputs: present, pinned and matching (NOT RUN without MP_PRIVATE_INPUTS_DIR; a failure with MP_REQUIRE_PRIVATE=1)', {skip: GATE.state === 'absent' ? GATE.reason : false}, () => {
  if (GATE.state === 'refused') throw new PrivateInputError(GATE.code, GATE.role);
  assert.equal(GATE.state, 'ready');
  for (const key of ['spt_source_sha256', 'analysis_m1_sha256', 'analysis_m2_sha256', 'analysis_m1_effective_inputs_hash', 'analysis_m2_effective_inputs_hash']) assert.match(GATE.inputs.hashes()[key], /^[0-9a-f]{64}$/, key);
});

/* ---- the static check of the three harness files ---- */

/**
 * The static check lives HERE (test/postgres/mp-private-acceptance.test.mjs). It reads the three harness files as text and fails on: any console use or direct stdout or stderr write;
 * any deep-equality assertion (a deep comparison prints both sides on failure, and a private object could be one of them); any literal that marks a case accepted; any static import from
 * src/ (the product modules load lazily); any file write outside the SUMMARY-WRITER block of mp-private-inputs.mjs; and a summary path that is not under the git-ignored .qa-local/ directory.
 */
test('static check: the three harness files print nothing, compare no object deeply, import no product module at load time and write only the ignored summary file', async () => {
  const names = ['mp-private-inputs.mjs', 'mp-acceptance-world.mjs', 'mp-private-acceptance.test.mjs'];
  const banned = [
    ['console', /\bconsole\s*\./],
    ['process stream write', /\bprocess\s*\.\s*std(?:out|err)\b/],
    ['deep equality', /\b(?:not)?[dD]eep(?:Strict)?Equal\b|partial[D]eep/],
    ['accepted marker', /['"]ACCEPTED['"]|\baccepted\s*:\s*true/],
    ['static src import', /^\s*(?:import|export)\b[^;\n]*\bfrom\s+['"][^'"]*\/src\//m],
    ['static src side-effect import', /^\s*import\s+['"][^'"]*\/src\//m]
  ];
  const writes = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|mkdir|mkdirSync|mkdtemp|truncate|truncateSync|cp|cpSync|symlink|symlinkSync|link|linkSync|open|openSync)\s*\(/g;
  let blocks = 0;
  for (let i = 0; i < HELPER_FILES.length; i++) {
    let text = await fs.readFile(HELPER_FILES[i], 'utf8');
    for (const [label, pattern] of banned) assert.equal(pattern.test(text), false, names[i] + ': ' + label);
    if (i === 0) {
      const found = [...text.matchAll(/^\/\/ SUMMARY-WRITER-BEGIN$([\s\S]*?)^\/\/ SUMMARY-WRITER-END$/gm)];
      assert.equal(found.length, 1, 'exactly one summary writer block');
      blocks = found.length;
      const body = found[0][1];
      assert.match(body, /summaryPath\(/, 'the writer target comes from summaryPath()');
      assert.equal(body.includes('.qa-local'), false, 'the writer block names no path literal');
      text = text.replace(found[0][0], '');
    }
    assert.equal(writes.test(text), false, names[i] + ': a file write outside the summary writer block');
    writes.lastIndex = 0;
  }
  assert.equal(blocks, 1);
  // the summary path: always <repo>/.qa-local/f11-private-acceptance/<plain name>.json, and that directory is git-ignored
  assert.equal(SUMMARY_RELATIVE_DIR.startsWith('.qa-local/'), true);
  const target = summaryPath('summary.json');
  assert.equal(path.dirname(target), path.join(REPO_ROOT, '.qa-local', 'f11-private-acceptance'));
  for (const bad of ['../x.json', 'a/b.json', '..\\x.json', '.hidden.json', 'x.txt', '', 'a'.repeat(90) + '.json', '/abs.json']) assert.throws(() => summaryPath(bad), {code: PRIVATE_CODES.LOCATION}, bad);
  const ignored = spawnSync('git', ['check-ignore', '-q', '--', path.dirname(target)], {cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true});
  assert.equal(ignored.status, 0, 'the summary directory is git-ignored');
});

/* ---- the leak-control rethrow wrapper ---- */

const SECRET = 'PRIVATE-SOURCE-MARKER-' + 'q'.repeat(48);
const SPACED = 'secret with spaces (' + SECRET + ')';
const fakeRowError = () => Object.assign(new Error('new row for relation "pine_sources" violates check constraint "pine_sources_source_check"\nDETAIL: Failing row contains (' + SECRET + ')'), {
  code: '23514', constraint: 'pine_sources_source_check', detail: 'Failing row contains (' + SECRET + ')', where: 'SQL statement "' + SECRET + '"', hint: SECRET, query: 'INSERT ' + SECRET,
  parameters: [SECRET], severity: 'ERROR', routine: 'ExecConstraints', stack: 'error: new row ... ' + SECRET
});
const noLeak = (error, label) => {
  const views = [String(error), error.message, error.stack ?? '', JSON.stringify(error), inspect(error, {depth: 8, showHidden: true}), JSON.stringify(Object.getOwnPropertyNames(error)), String(error.cause ?? '')];
  for (const view of views) assert.equal(view.includes(SECRET), false, label);
  assert.equal(Object.hasOwn(error, 'detail') || Object.hasOwn(error, 'where') || Object.hasOwn(error, 'hint') || Object.hasOwn(error, 'query') || Object.hasOwn(error, 'parameters') || Object.hasOwn(error, 'cause'), false, label);
};

test('leak control: safeError and guard replace a row error with a hash-only error (code, constraint, 8-hex prefix of the message hash)', async () => {
  const replaced = safeError('seed_pine_sources', fakeRowError());
  assert.equal(replaced instanceof PrivateSafeError, true);
  sameJson([replaced.code, replaced.constraint, replaced.label], ['23514', 'pine_sources_source_check', 'seed_pine_sources']);
  assert.equal(replaced.error_hash, sha256Hex(fakeRowError().message).slice(0, 8));
  assert.match(replaced.message, /^seed_pine_sources: 23514 pine_sources_source_check \[[0-9a-f]{8}\]$/);
  noLeak(replaced, 'safeError');
  await assert.rejects(guard('seed_job', async () => { throw fakeRowError(); }), error => { noLeak(error, 'guard'); return error instanceof PrivateSafeError && error.code === '23514'; });
  // a value that is returned is not touched
  assert.equal(await guard('ok', async () => 'value'), 'value');
  // an error that is already replaced passes through unchanged
  const once = safeError('a', fakeRowError());
  assert.equal(safeError('b', once), once);
});

test('leak control: aggregate errors, non-error throws, odd codes and odd labels cannot carry private bytes through the wrapper', async () => {
  const aggregate = new AggregateError([fakeRowError(), fakeRowError()], 'many: ' + SECRET);
  const fromAggregate = safeError('batch', aggregate);
  assert.equal(fromAggregate.code, '23514');
  noLeak(fromAggregate, 'aggregate');
  for (const thrown of [SECRET, {message: SECRET}, null, undefined, 42, Object.assign(new Error(SECRET), {code: SPACED, constraint: SPACED})]) {
    const out = safeError(SPACED, thrown);
    assert.equal(out.code, 'PRIVATE_CALL_FAILED');
    assert.equal(out.constraint, null);
    assert.equal(out.label, 'private_call', 'a label that is not code-like is replaced');
    noLeak(out, 'thrown');
  }
  // a throwing getter on the error object does not escape the wrapper
  const hostile = {get message() { throw new Error(SECRET); }, get code() { return 'ERR_HOSTILE'; }};
  const out = safeError('hostile', hostile);
  assert.equal(out.code, 'ERR_HOSTILE');
  noLeak(out, 'hostile');
});

test('leak control: checks show only primitives, short codes and 8-hex hash prefixes; anything else is redacted', () => {
  assert.throws(() => expectEqual('status', 'FAILED', 'SUCCEEDED'), error => error instanceof AcceptanceCheckError && /FAILED vs SUCCEEDED/.test(error.message));
  assert.throws(() => expectEqual('object', {source: SECRET}, 'x'), error => { noLeak(error, 'object'); return /<redacted>/.test(error.message); });
  assert.throws(() => expectEqual('spaced', SPACED, 'x'), error => { noLeak(error, 'spaced'); return /<redacted>/.test(error.message); });
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assertHashEqual('same', a, a);
  assert.throws(() => assertHashEqual('differs', a, b), error => error.message.includes('hash:aaaaaaaa vs hash:bbbbbbbb') && !error.message.includes(a));
  assert.throws(() => assertHashEqual('not_hash', SECRET, SECRET), error => { noLeak(error, 'not_hash'); return error instanceof AcceptanceCheckError; });
});

/* ---- the summary ---- */

test('summary: hash-only facts, a PRIV or SYN label per case, NOT_RUN by default, and never an accepted case', async () => {
  const hex = 'c'.repeat(64);
  const summary = new AcceptanceSummary({commit: 'a'.repeat(40), engine_hash: hex});
  summary.declare('P1', 'PRIV', ['F17', 'F27']);
  summary.notRun('P2', 'PRIV', ['F19'], 'DEPENDS_ON_P1');
  await summary.run('P3', 'SYN', ['F18'], async rec => { rec.fact('package_hash', hex); rec.fact('codes', ['BI_SOURCE_LOGIC_CHANGED']); rec.equal('status', 'EXPORT_REFUSED', 'EXPORT_REFUSED'); rec.hashEqual('same_hash', hex, hex); rec.check('flag', true); });
  await assert.rejects(summary.run('P4', 'PRIV', ['F20'], async rec => { rec.equal('status', 'SUCCEEDED', 'NO_VALID_CANDIDATE'); }), error => { noLeak(error, 'case'); return error instanceof PrivateSafeError; });
  const json = JSON.parse(JSON.stringify(summary));
  assert.equal(json.decision, 'NONE');
  sameJson(json.cases.map(item => [item.id, item.label, item.status]), [['P1', 'PRIV', CASE_STATUSES.NOT_RUN], ['P2', 'PRIV', CASE_STATUSES.NOT_RUN], ['P3', 'SYN', CASE_STATUSES.HELD], ['P4', 'PRIV', CASE_STATUSES.FAILED]]);
  assert.equal(json.cases[1].reason, 'DEPENDS_ON_P1');
  assert.equal(JSON.stringify(json).toLowerCase().includes('accepted'), false);
  for (const label of ['MAYBE', 'priv', '']) assert.throws(() => summary.declare('P9', label, []), {code: PRIVATE_CODES.SHAPE});
  // facts cannot carry text: a source-like string, an object, a long string and a string with spaces are refused
  for (const value of [SPACED, {a: 1}, 'x'.repeat(200), SECRET + ' ' + SECRET, [[1]], undefined, NaN]) assert.equal(isSafeFact(value), false);
  for (const value of [true, null, 7, hex, 'EXPORT_INTERNAL', ['A_B', 'C_D'], 'run-id-1']) assert.equal(isSafeFact(value), true);
  await assert.rejects(summary.run('P5', 'PRIV', ['F21'], async rec => rec.fact('text', SPACED)), error => { noLeak(error, 'fact'); return error instanceof PrivateSafeError; });
  assert.throws(() => new AcceptanceSummary({'bad key': 1}), {code: PRIVATE_CODES.SHAPE});
  assert.throws(() => writeAcceptanceSummary({}, '../escape.json'), {code: PRIVATE_CODES.LOCATION});
});

/* ---- the input reader, on an in-memory file system (no file is written) ---- */

const manifestOf = async patch => {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  for (const entry of manifest.files) Object.assign(entry, patch[entry.role] ?? {});
  return manifest;
};
const VDIR = path.join(os.tmpdir(), 'mp-virtual-private-inputs');
const file = (bytes, over = {}) => ({bytes: Buffer.from(bytes), link: false, ...over});
function virtualIo(files, {directory = true} = {}) {
  const stat = (kind, size = 0) => ({isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir', isFile: () => kind === 'file', size});
  const entryOf = target => files[path.basename(target)] !== undefined && path.dirname(target) === VDIR ? files[path.basename(target)] : null;
  return {
    async lstat(target) {
      if (target === VDIR) { if (!directory) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); return stat('dir'); }
      const entry = entryOf(target);
      if (!entry) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
      return stat(entry.link ? 'link' : 'file', entry.size ?? entry.bytes.length);
    },
    async realpath(target) { return target; },
    async readFile(target) { const entry = entryOf(target); if (!entry) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); return entry.bytes; }
  };
}
const codeOf = async promise => { try { await promise; return 'NO_ERROR'; } catch (error) { return error instanceof PrivateInputError ? error.code + '/' + error.role : 'OTHER'; } };
const ENV = {MP_PRIVATE_INPUTS_DIR: VDIR};

test('inputs: without the directory variable the result is NOT RUN with a reason naming the variable and every missing input; with MP_REQUIRE_PRIVATE=1 it fails', async () => {
  const out = await readPrivateInputs({env: {}});
  assert.equal(out.state, 'absent');
  assert.match(out.reason, /^NOT RUN: MP_PRIVATE_INPUTS_DIR is not set; missing private inputs: spt_source, analysis_m1, analysis_m2$/);
  assert.equal(await codeOf(readPrivateInputs({env: {MP_REQUIRE_PRIVATE: '1'}})), PRIVATE_CODES.MISSING + '/directory');
  assert.equal((await readPrivateInputs({env: {MP_REQUIRE_PRIVATE: '0'}})).state, 'absent');
  sameJson(REQUIRED_ROLES, ['spt_source', 'analysis_m1', 'analysis_m2']);
});

test('inputs: a missing directory, a null pin (unpinned), a changed byte, a link, an oversize file and a fixtures directory each refuse with a code and a role only', async () => {
  const pinned = async (files, over = {}) => manifestOf({
    spt_source: {sha256: sha256Hex(files['spt-spot-v4.pine']?.bytes ?? ''), ...over.spt_source},
    analysis_m1: {sha256: sha256Hex(files['analysis-m1.json']?.bytes ?? ''), effective_inputs_hash: 'e'.repeat(64), ...over.analysis_m1},
    analysis_m2: {sha256: sha256Hex(files['analysis-m2.json']?.bytes ?? ''), effective_inputs_hash: 'f'.repeat(64), ...over.analysis_m2}
  });
  const files = {'spt-spot-v4.pine': file('source bytes'), 'analysis-m1.json': file('{"m":1}'), 'analysis-m2.json': file('{"m":2}')};
  // directory missing (also the case MP_REQUIRE_PRIVATE=1 is not needed for: a set directory is always validated)
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files), io: virtualIo(files, {directory: false})})), PRIVATE_CODES.MISSING + '/directory');
  // null analysis pins (the committed manifest holds them until the owner records the hashes): unpinned, whatever the files hold
  const nulls = {sha256: null, effective_inputs_hash: null};
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files, {analysis_m1: nulls, analysis_m2: nulls}), io: virtualIo(files)})), PRIVATE_CODES.UNPINNED + '/analysis_m1');
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files, {analysis_m2: {effective_inputs_hash: null}}), io: virtualIo(files)})), PRIVATE_CODES.UNPINNED + '/analysis_m2');
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files, {analysis_m1: {sha256: null}}), io: virtualIo(files)})), PRIVATE_CODES.UNPINNED + '/analysis_m1');
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files, {spt_source: {sha256: null}}), io: virtualIo(files)})), PRIVATE_CODES.UNPINNED + '/spt_source');
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files, {spt_source: {sha256: 'not-hex'}}), io: virtualIo(files)})), PRIVATE_CODES.UNPINNED + '/spt_source');
  // one changed byte of the source after the pin was taken
  const changed = {...files, 'spt-spot-v4.pine': file('source byteS')};
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files), io: virtualIo(changed)})), PRIVATE_CODES.HASH_MISMATCH + '/spt_source');
  // a missing file, a link and an oversize file
  const missing = {'analysis-m1.json': files['analysis-m1.json'], 'analysis-m2.json': files['analysis-m2.json']};
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files), io: virtualIo(missing)})), PRIVATE_CODES.MISSING + '/spt_source');
  const linked = {...files, 'analysis-m1.json': file('{"m":1}', {link: true})};
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files), io: virtualIo(linked)})), PRIVATE_CODES.MISSING + '/analysis_m1');
  const huge = {...files, 'analysis-m2.json': file('{"m":2}', {size: 4 * 1024 * 1024 + 1})};
  assert.equal(await codeOf(readPrivateInputs({env: ENV, manifest: await pinned(files), io: virtualIo(huge)})), PRIVATE_CODES.MISSING + '/analysis_m2');
  // a directory under test/fixtures (a tracked location) is refused on the real file system
  assert.equal(await codeOf(readPrivateInputs({env: {MP_PRIVATE_INPUTS_DIR: path.join(FIXTURES_DIR, 'mp-combined')}})), PRIVATE_CODES.LOCATION + '/directory');
  // nothing in any message: a code and a role only
  try { await readPrivateInputs({env: ENV, manifest: await pinned(files), io: virtualIo(changed)}); assert.fail('expected a refusal'); } catch (error) { assert.equal(/\\|\/|source|bytes/i.test(error.message.replace(/PRIVATE_INPUT_HASH_MISMATCH \(spt_source\)/, '')), false); }
});

test('inputs: the gate never throws and a PrivateInputs value prints hashes only', async () => {
  const out = await privateGate({MP_REQUIRE_PRIVATE: '1'});
  sameJson([out.state, out.code, out.role], ['refused', PRIVATE_CODES.MISSING, 'directory']);
  sameJson((await privateGate({})).state, 'absent');
  if (GATE.state === 'ready') {
    assert.equal(inspect(GATE.inputs).includes('hash-only'), true);
    assert.equal(JSON.stringify(GATE.inputs).includes('buySignal'), false);
  }
});

/* ---- MP_REQUIRE_PRIVATE=1 fails the file before any database connection (a child process whose database URL is unreachable) ---- */

function child(extra) {
  const base = {PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? os.tmpdir(), TMP: process.env.TMP ?? os.tmpdir(), MP_ACCEPTANCE_CHILD: '1',
    TEST_DATABASE_URL: 'postgresql://nobody:none@127.0.0.1:1/none'};
  const out = spawnSync(process.execPath, ['--test', '--test-reporter=tap', HERE], {cwd: REPO_ROOT, env: {...base, ...extra}, encoding: 'utf8', windowsHide: true, timeout: 180000});
  return {status: out.status, text: String(out.stdout) + String(out.stderr)};
}

test('MP_REQUIRE_PRIVATE=1 with a missing, an absent or a misplaced directory fails the file before any database is touched', {skip: IS_CHILD ? 'NOT RUN: this is the child process of the refusal check' : false, timeout: 400000}, () => {
  for (const [extra, code] of [
    [{MP_REQUIRE_PRIVATE: '1'}, PRIVATE_CODES.MISSING],
    [{MP_REQUIRE_PRIVATE: '1', MP_PRIVATE_INPUTS_DIR: path.join(os.tmpdir(), 'mp-no-such-private-inputs-dir')}, PRIVATE_CODES.MISSING],
    [{MP_PRIVATE_INPUTS_DIR: path.join(FIXTURES_DIR, 'mp-combined')}, PRIVATE_CODES.LOCATION]
  ]) {
    const out = child(extra);
    assert.notEqual(out.status, 0, code + ': the file fails');
    assert.equal(out.text.includes(code), true, code + ': the failure names the code');
    assert.equal(/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|database "none"|28P01|3D000/i.test(out.text), false, code + ': no database was contacted');
    assert.equal(/not ok \d+ - (?:static check|leak control|summary|inputs)/.test(out.text), false, code + ': only the private-input test fails');
  }
});

test('a run without the directory variable skips every private case with a reason (child process, no database reachable)', {skip: IS_CHILD ? 'NOT RUN: this is the child process of the refusal check' : false, timeout: 300000}, () => {
  const out = child({});
  assert.equal(out.status, 0, 'the file passes without private inputs');
  assert.equal(out.text.includes('NOT RUN: MP_PRIVATE_INPUTS_DIR is not set; missing private inputs: spt_source, analysis_m1, analysis_m2'), true);
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'PX']) assert.equal(new RegExp('ok \\d+ - ' + id + ' .*# SKIP').test(out.text), true, id + ' is skipped');
  assert.equal(/not ok/.test(out.text), false);
});

/* ======================================================================================================================================================= */
/* The private cases (the owner runs them locally; skipped without the inputs)                                                                              */
/* ======================================================================================================================================================= */

const STATE = {ok: new Set(), A: null};
let CTX = null;
const flush = () => { if (GATE.state === 'ready') writeAcceptanceSummary(SUMMARY); };

before(async () => {
  if (GATE.state !== 'ready') return;
  const hashes = GATE.inputs.hashes();
  for (const [key, value] of Object.entries(hashes)) SUMMARY.setHeader(key, value);
  SUMMARY.setHeader('started_utc', new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
  const repo = repositoryFacts();
  SUMMARY.setHeader('commit', repo.commit);
  SUMMARY.setHeader('tree_clean', repo.tree_clean);
  CTX = await guard('create_context', () => createAcceptanceContext());
  SUMMARY.setHeader('engine_hash', CTX.ENGINE);
  SUMMARY.setHeader('producer_closure_hash', CTX.CLOSURE);
  // O3 as booleans: do the private analyses carry the committed fixture inputs of M1 and M2?
  SUMMARY.setHeader('o3_m1_matches_fixture', analysisMatchesFixture(GATE.inputs.analysis('analysis_m1'), CTX.F.manifest.members.M1.inputs));
  SUMMARY.setHeader('o3_m2_matches_fixture', analysisMatchesFixture(GATE.inputs.analysis('analysis_m2'), CTX.F.manifest.members.M2.inputs));
  for (const def of CASES) SUMMARY.declare(def.id, def.label, def.f);
  flush();
});

after(async () => {
  try {
    if (GATE.state === 'ready') { SUMMARY.setHeader('finished_utc', new Date().toISOString().replace(/\.\d+Z$/, 'Z')); flush(); }
  } finally {
    if (CTX) await CTX.close().catch(() => {});
  }
});

const CASES = [
  {id: 'P1', label: 'PRIV', f: ['F17', 'F27', 'F28', 'F23', 'F22'], title: 'owner A: full run, package, attempts, idempotent build, side effects, refusals'},
  {id: 'P2', label: 'PRIV', f: ['F19'], title: 'owner B: missing member-2 parity, then appended'},
  {id: 'P3', label: 'PRIV', f: ['F18'], title: 'owner C: one default byte of the member-2 file changed'},
  {id: 'P4', label: 'PRIV', f: ['F20'], title: 'owner D: no candidate passes, no package'},
  {id: 'P5', label: 'PRIV', f: ['F21'], title: 'owner E reads the run and export of owner A'},
  {id: 'P6', label: 'PRIV', f: ['F10', 'F11'], title: 'owner A: disconnected member and a new source revision make the export STALE'},
  {id: 'P7', label: O7_YES ? 'PRIV' : 'SYN', f: ['F24'], title: 'member-2 input variant: member-1 signals identical, package STALE'},
  {id: 'P8', label: O7_YES ? 'PRIV' : 'SYN', f: ['F29'], title: 'member-2 zero-signal variant'},
  {id: 'P9', label: 'PRIV', f: ['F30'], title: 'QR-3 half of F30 for the export of owner A'},
  {id: 'PX', label: 'PRIV', f: ['OPERATOR_PATH'], title: 'optional: the operator script runs an admitted run (MP_ACCEPTANCE_OPERATOR_PATH=1)'}
];
const byId = Object.fromEntries(CASES.map(def => [def.id, def]));

function privateCase(id, needs, body, {extraSkip = false} = {}) {
  const def = byId[id];
  test(id + ' ' + def.title + ' [' + def.f.join(' ') + ']', {skip: SKIP || extraSkip, timeout: 1800000}, async t => {
    try {
      const missing = needs.find(need => !STATE.ok.has(need));
      if (missing) {
        SUMMARY.notRun(id, def.label, def.f, 'DEPENDS_ON_' + missing);
        t.skip('NOT RUN: depends on ' + missing);
        return;
      }
      await SUMMARY.run(id, def.label, def.f, rec => body(rec, t));
      STATE.ok.add(id);
    } finally { flush(); }
  });
}

/* ---- shared helpers of the cases ---- */

const m1 = () => GATE.inputs.analysis('analysis_m1');
const m2 = () => GATE.inputs.analysis('analysis_m2');
const sourceText = () => GATE.inputs.sourceText();
const sourceHash = () => GATE.inputs.hashes().source_hash;
const privateWorld = analyses => newAcceptanceWorld(CTX.db, CTX.store, {source: sourceText(), sourceHash: sourceHash(), analyses, bars: CTX.bars});
const signalsOf = result => Object.fromEntries((result?.member_signals ?? []).map(row => [row.ordinal, row.signals_hash]));
const lastOf = events => events[events.length - 1];
const F24_KEY = 'cooldownInput';

/** A world, an admission and a real run to a terminal event; records the admission, the status and the reason (codes only). */
async function realRun(rec, tag, analyses, {over = {}, runner, world: given} = {}) {
  const world = given ?? await privateWorld(analyses);
  const run = await runWorld(CTX, world, {runner, over});
  rec.fact(tag + '_admitted', run.admitted.ok === true);
  rec.fact(tag + '_admit_code', run.admitted.ok === true ? null : String(run.admitted.code ?? 'UNKNOWN'));
  rec.equal(tag + '_admitted_ok', run.admitted.ok, true);
  rec.fact(tag + '_run_id', run.run_id);
  rec.fact(tag + '_status', run.out.status);
  rec.fact(tag + '_reason', run.out.reason_code ?? null);
  const event = lastOf(run.events);
  return {world, run_id: run.run_id, out: run.out, events: run.events, result: event?.result ?? null, result_hash: event?.result_hash ?? null};
}

function funnelSums(result) {
  const diagnostics = result.funnel?.diagnostics;
  if (!diagnostics) return false;
  return ['native_buy', 'native_exit', 'intents_buy', 'intents_exit', 'pre_start_intents', 'suppressed_buys', 'skipped_buys', 'accepted', 'capped']
    .every(key => diagnostics.members.reduce((total, member) => total + member[key], 0) === diagnostics.bot[key]);
}

const EVIDENCE_CODES = ['BI_COMPILE_EVIDENCE_MISSING', 'BI_DATASET_ALIGNMENT_MISSING', 'BI_PARITY_EVIDENCE_MISSING', 'BI_REPAINT_EVIDENCE_MISSING', 'ACCEPTANCE_BLOCKERS_PRESENT'];

/** The run is SUCCEEDED with the guarantees every packaged case relies on (F28): blocker kept, recommendation false, a matched baseline, member counts summing to the Bot counts. */
function succeededChecks(rec, tag, real) {
  rec.equal(tag + '_succeeded', real.out.status, 'SUCCEEDED');
  const result = real.result;
  rec.equal(tag + '_completion', result.completion_reason, 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  rec.equal(tag + '_holdout_evaluated', result.holdout_evaluated, true);
  rec.check(tag + '_blocker_kept', result.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B'));
  rec.equal(tag + '_not_recommended', result.owner_recommendation_ready, false);
  rec.equal(tag + '_baseline_matched', result.combined_baseline.matched, true);
  rec.equal(tag + '_baseline_diffs', Object.values(result.combined_baseline.differences).filter(count => count !== 0).length, 0);
  rec.check(tag + '_funnel_sums', funnelSums(result));
  rec.hashEqual(tag + '_result_hash', real.result_hash, CTX.M.hash(CTX.M.canonical(result)));
  rec.fact(tag + '_engine_hash', result.engine_hash);
  rec.fact(tag + '_set_hash', result.set_hash);
  rec.fact(tag + '_baseline_final_cash_delta_zero', result.combined_baseline.final_cash_delta === '0');
  const signals = signalsOf(result);
  rec.fact(tag + '_signals_m1', signals[1] ?? null);
  rec.fact(tag + '_signals_m2', signals[2] ?? null);
}

/* ---- P1: owner A ---- */

privateCase('P1', [], async rec => {
  const world = await privateWorld([m1(), m2()]);
  const admitted = await admitWorldRun(CTX, world);
  rec.equal('p1_admitted_ok', admitted.ok, true);
  const run_id = admitted.run.run_id;
  rec.fact('p1_run_id', run_id);
  const before = await digestAll(CTX.db);
  const out = await CTX.executor().execute({owner_id: world.id, run_id});
  rec.fact('p1_status', out.status);
  rec.fact('p1_reason', out.reason_code ?? null);
  rec.equal('p1_succeeded', out.status, 'SUCCEEDED');
  const events = (await CTX.db.query('SELECT seq,status,reason_code,result,result_hash FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq', [run_id])).rows;
  rec.equal('p1_event_statuses', events.map(event => event.status).join(), 'ADMITTED,RUNNING,SUCCEEDED');
  const real = {out, result: lastOf(events).result, result_hash: lastOf(events).result_hash};
  succeededChecks(rec, 'p1', real);
  // F23: the run changed the run-store events and nothing else; deployment states and the session are unchanged
  const after = await digestAll(CTX.db);
  rec.fact('p1_changed_tables', changedTables(before, after, ['mp_research_run_events']));
  rec.hashEqual('p1_side_effect_digest', digestHash(before, ['mp_research_run_events']), digestHash(after, ['mp_research_run_events']));
  const states = (await CTX.db.query('SELECT state FROM pine_deployments WHERE owner_id=$1 ORDER BY deployment_id', [world.id])).rows.map(row => row.state);
  rec.equal('p1_deployments_draft', states.join(), 'DRAFT,DRAFT');
  rec.equal('p1_session_setup', (await CTX.store.getBotSession(world.bot)).state ?? 'SETUP', 'SETUP');
  // F17 and F19 first half: build, attempt 1 with retryable missing-evidence codes, fixture records, attempt 2 to EXPORT_INTERNAL with READY false
  const svc = CTX.packages();
  const sideBefore = await sideDigest(CTX.db);
  const built = await svc.build({owner_id: world.id, run_id});
  rec.fact('p1_build_code', built.ok === true ? null : String(built.code ?? 'UNKNOWN'));
  rec.equal('p1_build_ok', built.ok, true);
  rec.equal('p1_build_action', built.action, 'BUILD');
  const exportId = built.export.export_id;
  rec.fact('p1_export_id', exportId);
  rec.equal('p1_build_status', built.export.status, 'EXPORT_CANDIDATE');
  rec.equal('p1_build_ready', built.export.ready, false);
  const counts = await packageCounts(CTX.db);
  rec.equal('p1_files', counts.mp_package_files, 16);
  rec.equal('p1_trace_records', counts.mp_package_trace_records, 3);
  rec.equal('p1_one_export', counts.mp_package_exports, 1);
  const exportRow = (await rowsFor(CTX.db, 'mp_package_exports', exportId))[0];
  rec.fact('p1_package_hash', exportRow.package_hash);
  rec.fact('p1_binding_hash', exportRow.binding_hash);
  rec.equal('p1_b0_pass', exportRow.b0.pass, true);
  rec.equal('p1_g7_fail', exportRow.b0.g7.state, 'FAIL');
  rec.fact('p1_file_sha256', (await rowsFor(CTX.db, 'mp_package_files', exportId)).map(row => row.sha256).sort());
  const a1 = await svc.attempt({owner_id: world.id, export_id: exportId});
  rec.equal('p1_a1_ok', a1.ok, true);
  rec.equal('p1_a1_pass', a1.pass, false);
  rec.equal('p1_a1_status', a1.status, 'EXPORT_CANDIDATE');
  for (const code of EVIDENCE_CODES) rec.check('p1_a1_' + code.toLowerCase(), a1.codes.includes(code));
  rec.fact('p1_a1_codes', [...a1.codes].sort());
  rec.equal('p1_records_ok', (await svc.recordFixtureRecords({owner_id: world.id, export_id: exportId})).ok, true);
  const a2 = await svc.attempt({owner_id: world.id, export_id: exportId});
  rec.equal('p1_a2_ok', a2.ok, true);
  rec.equal('p1_a2_pass', a2.pass, true);
  rec.equal('p1_a2_status', a2.status, 'EXPORT_INTERNAL');
  rec.equal('p1_a2_codes', a2.codes.length, 0);
  rec.equal('p1_a2_ready', a2.ready, false);
  rec.equal('p1_a2_gates', a2.gates.map(item => item.gate + ':' + item.state).join(), 'C1:PASS,C2:PASS,C3:PASS,C4:PASS,Q:PASS');
  const validation = (await rowsFor(CTX.db, 'mp_package_validations', exportId))[0];
  rec.equal('p1_validation_mode', validation.mode, 'MULTI_PINE');
  rec.equal('p1_validation_fixture', validation.fixture, true);
  // owner A and its export are now the subject of P5, P6, P7 and P9, even if a later step of this case fails
  STATE.A = {world, run_id, export_id: exportId, signals: signalsOf(real.result), package_hash: exportRow.package_hash};
  STATE.ok.add('P1_PACKAGE');
  const read = await svc.read({owner_id: world.id, export_id: exportId});
  rec.equal('p1_read_status', read.status, 'EXPORT_INTERNAL');
  rec.equal('p1_read_ready', read.ready, false);
  rec.equal('p1_read_freshness', read.freshness.state, 'FRESH');
  // F27: a second build of the same run (on two handles) loads the same export and writes nothing
  const packagesBefore = digestHash(await packageDigest(CTX.db));
  for (const handle of [CTX.fx, CTX.fx2]) {
    const again = await CTX.packages(handle).build({owner_id: world.id, run_id});
    rec.equal('p1_rebuild_ok', again.ok, true);
    rec.equal('p1_rebuild_action', again.action, 'LOAD');
    rec.equal('p1_rebuild_same_export', again.export.export_id, exportId);
  }
  rec.hashEqual('p1_rebuild_writes_nothing', packagesBefore, digestHash(await packageDigest(CTX.db)));
  rec.hashEqual('p1_package_flow_side_effects', digestHash(sideBefore), digestHash(await sideDigest(CTX.db)));
  // F22: the three multi-Pine refusals still fire after the run
  const refusals = await multiPineRefusals(CTX, world);
  rec.equal('p1_t_r1', refusals.t_r1, 'MULTI_PINE_RESEARCH_NOT_SUPPORTED');
  rec.equal('p1_t_r2', refusals.t_r2, 'MULTI_PINE_REQUIRES_APP_3B');
  rec.equal('p1_t_r3', refusals.t_r3, 'MULTI_PINE_REQUIRES_APP_3B');
});

/* ---- P2: owner B, F19 ---- */

privateCase('P2', [], async rec => {
  const real = await realRun(rec, 'p2', [m1(), m2()]);
  succeededChecks(rec, 'p2', real);
  const svc = CTX.packages(), owner_id = real.world.id;
  const built = await svc.build({owner_id, run_id: real.run_id});
  rec.equal('p2_build_ok', built.ok, true);
  const exportId = built.export.export_id;
  rec.equal('p2_records_ok', (await svc.recordFixtureRecords({owner_id, export_id: exportId, skip: ['2:native_parity']})).ok, true);
  const a1 = await svc.attempt({owner_id, export_id: exportId});
  rec.equal('p2_a1_ok', a1.ok, true);
  rec.equal('p2_a1_pass', a1.pass, false);
  rec.equal('p2_a1_status', a1.status, 'EXPORT_CANDIDATE');
  rec.check('p2_a1_parity_missing', a1.codes.includes('BI_PARITY_EVIDENCE_MISSING'));
  rec.equal('p2_a1_names_member_2', a1.diagnostics.filter(item => item.code === 'BI_PARITY_EVIDENCE_MISSING').map(item => item.ordinal).join(), '2');
  rec.fact('p2_a1_codes', [...a1.codes].sort());
  rec.equal('p2_append_evidence', (await svc.recordEvidence({owner_id, export_id: exportId, ordinal: 2, kind: 'native_parity'})).ok, true);
  rec.equal('p2_append_clearance', (await svc.recordClearance({owner_id, export_id: exportId, blocker: 'VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED', ordinal: 2})).ok, true);
  const a2 = await svc.attempt({owner_id, export_id: exportId});
  rec.equal('p2_a2_pass', a2.pass, true);
  rec.equal('p2_a2_status', a2.status, 'EXPORT_INTERNAL');
  rec.equal('p2_a2_ready', a2.ready, false);
  rec.fact('p2_package_hash', (await rowsFor(CTX.db, 'mp_package_exports', exportId))[0].package_hash);
});

/* ---- P3: owner C, F18 ---- */

privateCase('P3', [], async rec => {
  const real = await realRun(rec, 'p3', [m1(), m2()]);
  succeededChecks(rec, 'p3', real);
  const svc = CTX.packages(), owner_id = real.world.id;
  const built = await svc.build({owner_id, run_id: real.run_id});
  rec.equal('p3_build_ok', built.ok, true);
  const exportId = built.export.export_id;
  rec.equal('p3_records_ok', (await svc.recordFixtureRecords({owner_id, export_id: exportId})).ok, true);
  // the stored member-2 file is changed by one default byte (cluster admin write; the manifest still names the old checksum)
  const tampered = await tamperStoredFile(CTX, exportId, 'members/2/indicator.pine', changeOneDefaultByte);
  rec.fact('p3_old_file_sha256', tampered.old_sha256);
  rec.fact('p3_new_file_sha256', tampered.new_sha256);
  const attempt = await svc.attempt({owner_id, export_id: exportId});
  rec.fact('p3_attempt_code', attempt.ok === true ? null : String(attempt.code ?? 'UNKNOWN'));
  rec.equal('p3_attempt_ok', attempt.ok, true);
  rec.equal('p3_pass', attempt.pass, false);
  rec.equal('p3_status', attempt.status, 'EXPORT_REFUSED');
  rec.fact('p3_codes', [...attempt.codes].sort());
  rec.check('p3_logic_changed', attempt.codes.includes('BI_SOURCE_LOGIC_CHANGED'));
  rec.equal('p3_logic_changed_names_member_2', attempt.diagnostics.filter(item => item.code === 'BI_SOURCE_LOGIC_CHANGED').map(item => item.ordinal).join(), '2');
  rec.equal('p3_closed', (await svc.attempt({owner_id, export_id: exportId})).code, CTX.M.PACKAGE_STORE_CODES.EXPORT_NOT_OPEN);
});

/* ---- P4: owner D, F20 ---- */

privateCase('P4', [], async rec => {
  const real = await realRun(rec, 'p4', [m1(), m2()], {over: {bridge_domains: structuredClone(STRESS_FAILS)}});
  rec.equal('p4_no_valid_candidate', real.out.status, 'NO_VALID_CANDIDATE');
  const result = real.result;
  rec.equal('p4_completion', result.completion_reason, 'CANDIDATE_FAILED_CHECKS');
  rec.check('p4_stress_failed', result.selected.screen_reasons.includes('COST_STRESS_FAILED'));
  rec.equal('p4_holdout_not_evaluated', result.holdout_evaluated, false);
  rec.equal('p4_no_baseline', result.combined_baseline, null);
  rec.equal('p4_no_holdout_decisions', Object.hasOwn(result, 'holdout_decisions'), false);
  const before = digestHash(await packageDigest(CTX.db));
  const out = await CTX.packages().build({owner_id: real.world.id, run_id: real.run_id});
  rec.fact('p4_build_code', String(out.code ?? 'NONE'));
  rec.fact('p4_build_codes', Array.isArray(out.codes) ? [...out.codes].sort() : []);
  rec.equal('p4_build_refused', out.ok, false);
  rec.equal('p4_build_code_b0', out.code, CTX.M.PACKAGE_STORE_CODES.BUILD_B0_FAILED);
  rec.equal('p4_build_stage', out.stage, 'B0');
  rec.check('p4_not_qualifiable', Array.isArray(out.codes) && out.codes.includes('BI_RUN_NOT_QUALIFIABLE'));
  rec.hashEqual('p4_no_package_row', before, digestHash(await packageDigest(CTX.db)));
});

/* ---- P5: owner E reads the run and export of owner A, F21 ---- */

privateCase('P5', ['P1_PACKAGE'], async rec => {
  const A = STATE.A;
  const other = await CTX.store.createUser({email: 'pa-e-' + CTX.F.now + '-' + sha256Hex(String(Math.random())).slice(0, 12) + '@example.test', passwordHash: 'unused-fixture-hash'});
  const svc = CTX.packages();
  const before = [digestHash(await packageDigest(CTX.db)), digestHash(await sideDigest(CTX.db))];
  const refused = (label, out) => {
    rec.equal(label + '_not_found', out.code, 'NOT_FOUND');
    rec.equal(label + '_ok', out.ok, false);
    rec.equal(label + '_keys', Object.keys(out).filter(key => key !== 'diagnostic').sort().join(), 'code,ok');
  };
  refused('p5_build', await svc.build({owner_id: other.id, run_id: A.run_id}));
  refused('p5_attempt', await svc.attempt({owner_id: other.id, export_id: A.export_id}));
  refused('p5_read_export', await svc.read({owner_id: other.id, export_id: A.export_id}));
  refused('p5_read_run', await svc.read({owner_id: other.id, run_id: A.run_id}));
  refused('p5_compile', await svc.recordCompile({owner_id: other.id, export_id: A.export_id, ordinal: 1}));
  refused('p5_evidence', await svc.recordEvidence({owner_id: other.id, export_id: A.export_id, ordinal: 1, kind: 'repaint'}));
  refused('p5_clearance', await svc.recordClearance({owner_id: other.id, export_id: A.export_id, blocker: 'CUSTOM_REPAINT_EVIDENCE_REQUIRED', ordinal: 1}));
  refused('p5_fixture_records', await svc.recordFixtureRecords({owner_id: other.id, export_id: A.export_id}));
  const run = await CTX.M.getMultiRun(CTX.fx, {owner_id: other.id, run_id: A.run_id});
  rec.equal('p5_run_not_found', run.code, 'NOT_FOUND');
  rec.equal('p5_run_ok', run.ok, false);
  const listed = await CTX.M.listMultiRuns(CTX.fx, {owner_id: other.id});
  rec.equal('p5_list_empty', listed.runs.length, 0);
  rec.equal('p5_run_bot_not_foreign', (await CTX.M.getMultiRun(CTX.fx, {owner_id: A.world.id, run_id: A.run_id})).ok, true);
  // an unknown and a malformed id answer the same, for the real owner
  refused('p5_unknown_run', await svc.build({owner_id: A.world.id, run_id: '00000000-0000-4000-8000-000000000000'}));
  refused('p5_malformed_run', await svc.build({owner_id: A.world.id, run_id: 'not-a-uuid'}));
  // no row, and no audit row on the Bot of owner A
  rec.hashEqual('p5_no_package_row', before[0], digestHash(await packageDigest(CTX.db)));
  rec.hashEqual('p5_no_side_row', before[1], digestHash(await sideDigest(CTX.db)));
});

/* ---- P6: owner A after P1, F10 and F11 package halves ---- */

privateCase('P6', ['P1_PACKAGE'], async rec => {
  const A = STATE.A, svc = CTX.packages(), db = CTX.db, id = A.export_id, owner_id = A.world.id;
  const [s1, s2] = A.world.specs;
  const freshness = async () => { const out = await svc.read({owner_id, export_id: id}); rec.equal('p6_read_ok', out.ok, true); rec.equal('p6_status_unchanged', out.status, 'EXPORT_INTERNAL'); rec.equal('p6_never_ready', out.ready, false); return out.freshness; };
  const before = digestHash(await packageDigest(db));
  rec.equal('p6_initial_fresh', (await freshness()).state, 'FRESH');
  // F10: member 2 is disconnected after the freeze
  await db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1', [s2.pine]);
  try {
    const stale = await freshness();
    rec.fact('p6_f10_code', stale.code);
    rec.fact('p6_f10_codes', [...stale.codes].sort());
    rec.equal('p6_f10_stale', stale.state, 'STALE');
    rec.equal('p6_f10_not_fresh', stale.fresh, false);
    const admit = await admitWorldRun(CTX, A.world);
    rec.fact('p6_f10_admit_code', admit.ok === true ? null : String(admit.code ?? 'UNKNOWN'));
    rec.equal('p6_f10_new_admission_refused', admit.ok, false);
  } finally { await db.query('UPDATE pine_memberships SET connected=true WHERE pine_import_id=$1', [s2.pine]); }
  rec.equal('p6_f10_fresh_again', (await freshness()).state, 'FRESH');
  // F11: a new source revision (version 2) of member 1 with the same analysis; the membership points at it
  await guard('p6_revision', () => db.query('INSERT INTO pine_source_revisions VALUES($1,2,$2,$3,$4,$5)', [s1.pine, sourceHash(), sourceText(), JSON.stringify(s1.analysis), CTX.F.now]));
  await db.query('UPDATE pine_memberships SET source_version=2 WHERE pine_import_id=$1', [s1.pine]);
  try {
    const stale = await freshness();
    rec.fact('p6_f11_code', stale.code);
    rec.equal('p6_f11_stale', stale.state, 'STALE');
  } finally { await db.query('UPDATE pine_memberships SET source_version=1 WHERE pine_import_id=$1', [s1.pine]); }
  rec.equal('p6_f11_fresh_again', (await freshness()).state, 'FRESH');
  rec.hashEqual('p6_freshness_writes_nothing', before, digestHash(await packageDigest(db)));
});

/* ---- P7 and P8: O7 ---- */

const synWorld = async names => {
  const M = CTX.M, hash = M.hash(SYN_SOURCE);
  const sets = names.map(name => (typeof name === 'string' ? CTX.F.manifest.members[name].inputs : name));
  const world = await newAcceptanceWorld(CTX.db, CTX.store, {source: SYN_SOURCE, sourceHash: hash, analyses: sets.map(inputs => syntheticAnalysis(M, inputs, hash)), bars: CTX.bars});
  return {world, runner: gatedRunner(M, Object.fromEntries(world.specs.map((spec, index) => [spec.pine, sets[index]])))};
};
const f24Inputs = () => ({...CTX.F.manifest.members.M2.inputs, [F24_KEY]: CTX.F.manifest.members.M1.inputs[F24_KEY]});

privateCase('P7', O7_YES ? ['P1_PACKAGE'] : [], async rec => {
  const M = CTX.M;
  let base, variant;
  if (O7_YES) {
    // PRIV: member 2 gets a fixture-derived variant of the private analysis; member 1 is the private M1 again. The base run is the run of owner A.
    const derived = variantAnalysis(M, m2(), {[F24_KEY]: CTX.F.manifest.members.M1.inputs[F24_KEY]});
    rec.check('p7_variant_differs', derived.effective_inputs_hash !== m2().effective_inputs_hash);
    rec.fact('p7_variant_effective_inputs_hash', derived.effective_inputs_hash);
    base = {signals: STATE.A.signals};
    const real = await realRun(rec, 'p7', [m1(), derived]);
    variant = {signals: signalsOf(real.result)};
    // F24 package half on owner A: a new reviewed input for member 2 (a new revision, the membership points at it) makes the export STALE at read
    const svc = CTX.packages(), A = STATE.A, s2 = A.world.specs[1];
    await guard('p7_revision', () => CTX.db.query('INSERT INTO pine_source_revisions VALUES($1,2,$2,$3,$4,$5)', [s2.pine, sourceHash(), sourceText(), JSON.stringify(derived), CTX.F.now]));
    await CTX.db.query('UPDATE pine_memberships SET source_version=2 WHERE pine_import_id=$1', [s2.pine]);
    try {
      const read = await svc.read({owner_id: A.world.id, export_id: A.export_id});
      rec.fact('p7_package_code', read.freshness.code);
      rec.equal('p7_package_stale', read.freshness.state, 'STALE');
      rec.equal('p7_package_never_ready', read.ready, false);
    } finally { await CTX.db.query('UPDATE pine_memberships SET source_version=1 WHERE pine_import_id=$1', [s2.pine]); }
  } else {
    // SYN: the committed synthetic source behind the gate wrapper; a base pair (M1, M2) and a variant pair (M1, M2 with member-1's cooldown)
    const one = await synWorld(['M1', 'M2']);
    const first = await realRun(rec, 'p7_base', null, {world: one.world, runner: one.runner});
    base = {signals: signalsOf(first.result)};
    const two = await synWorld(['M1', f24Inputs()]);
    const second = await realRun(rec, 'p7', null, {world: two.world, runner: two.runner});
    variant = {signals: signalsOf(second.result)};
    rec.fact('p7_package_half', 'COVERED_BY_P6_AND_R6_4_TESTS');
  }
  rec.check('p7_base_has_signals', typeof base.signals[1] === 'string' && typeof base.signals[2] === 'string');
  rec.check('p7_variant_has_signals', typeof variant.signals[1] === 'string' && typeof variant.signals[2] === 'string');
  rec.hashEqual('p7_member_1_signals_identical', base.signals[1], variant.signals[1]);
  rec.check('p7_member_2_signals_differ', base.signals[2] !== variant.signals[2]);
  rec.fact('p7_base_signals_m1', base.signals[1]);
  rec.fact('p7_variant_signals_m2', variant.signals[2]);
});

privateCase('P8', [], async rec => {
  let real;
  if (O7_YES) {
    const zero = variantAnalysis(CTX.M, m2(), fixtureDifference(CTX.F.manifest, 'M2', 'M2_ZERO'));
    rec.fact('p8_variant_effective_inputs_hash', zero.effective_inputs_hash);
    real = await realRun(rec, 'p8', [m1(), zero]);
  } else {
    const syn = await synWorld(['M1', 'M2_ZERO']);
    real = await realRun(rec, 'p8', null, {world: syn.world, runner: syn.runner});
  }
  rec.equal('p8_failed', real.out.status, 'FAILED');
  rec.equal('p8_no_signals', real.out.reason_code, 'MP_MEMBER_NO_SIGNALS');
  rec.equal('p8_events', real.events.map(event => event.status).join(), 'ADMITTED,RUNNING,FAILED');
  rec.equal('p8_no_result', real.result, null);
});

/* ---- P9: owner A, F30 QR-3 half (RD-MP-42) ---- */

privateCase('P9', ['P1_PACKAGE'], async rec => {
  const A = STATE.A, M = CTX.M;
  const stored = (await CTX.db.query('SELECT fixture FROM public.mp_package_exports WHERE export_id=$1', [A.export_id])).rows[0];
  rec.equal('p9_stored_fixture', stored.fixture, true);
  // (a) a non-fixture comparison offered a participant built from the stored multi export: the request check refuses
  const request = {mode: 'STANDARDIZED', participants: [{id: 'run-other'}, {id: A.run_id, fixture: stored.fixture}], market: {broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'}, cost_model_version: 'paper-close-v1'};
  const verdict = M.validateRequest(request);
  rec.equal('p9_refused', verdict.ok, false);
  rec.equal('p9_code', verdict.code, M.COMPARISON_CODES.QR3_FIXTURE_PARTICIPANT);
  rec.equal('p9_fixture_comparison_passes', M.validateRequest({...request, fixture_comparison: true}).ok, true);
  // (b) the runtime role cannot resolve the multi run or the export at all
  for (const table of ['mp_package_exports', 'mp_research_runs', 'mp_package_validations']) {
    let code = 'NO_ERROR';
    try { await CTX.rt.query('SELECT 1 FROM public.' + table + ' LIMIT 1'); } catch (error) { code = String(error?.code ?? 'UNKNOWN'); }
    rec.equal('p9_runtime_role_' + table, code, '42501');
  }
  let viaReader = 'NO_ERROR';
  try { await M.getMultiRun(CTX.rt, {owner_id: A.world.id, run_id: A.run_id}); } catch (error) { viaReader = String(error?.code ?? 'UNKNOWN'); }
  rec.equal('p9_runtime_role_reader', viaReader, '42501');
});

/* ---- PX: the operator script on an admitted run (optional) ---- */

privateCase('PX', [], async rec => {
  const world = await privateWorld([m1(), m2()]);
  const admitted = await admitWorldRun(CTX, world);
  rec.equal('px_admitted_ok', admitted.ok, true);
  const run_id = admitted.run.run_id;
  // the child gets the fixture-role URL and no private variable
  const env = {PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? os.tmpdir(), TMP: process.env.TMP ?? os.tmpdir(), NODE_ENV: 'test',
    MP_FIXTURE_DATABASE_URL: CTX.urlOf(CTX.databaseName, CTX.fixtureName), ...(process.env.QUANT_RESEARCH_PYTHON ? {QUANT_RESEARCH_PYTHON: process.env.QUANT_RESEARCH_PYTHON} : {})};
  const out = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'mp-fixture-run.mjs'), '--isolated-cluster', '--owner-id=' + world.id, '--run-id=' + run_id], {cwd: REPO_ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 1500000});
  rec.fact('px_exit_status', out.status);
  rec.equal('px_exit_zero', out.status, 0);
  const status = (await CTX.db.query('SELECT status FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1', [run_id])).rows[0].status;
  rec.fact('px_status', status);
  rec.equal('px_succeeded', status, 'SUCCEEDED');
}, {extraSkip: OPERATOR_PATH ? false : 'NOT RUN: MP_ACCEPTANCE_OPERATOR_PATH is not 1'});
