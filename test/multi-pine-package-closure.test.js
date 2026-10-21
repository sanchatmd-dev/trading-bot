import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical, hash} from '../src/pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {MP_COMBINED_ENGINE_FILES, MP_COMBINED_ONLY_FILES, mpCombinedEngineHash} from '../src/multi-pine/engine-closure.js';
import {INGESTION_ENGINE_FILES} from '../src/postgres/quant-data.js';
import {FOUNDATION_ENGINE_FILES, LEGACY_ENGINE_FILES} from '../src/postgres/quant-research.js';
import {PF2_ENGINE_FILES, PF2_EVALUATOR_FILES} from '../src/quant-research/preflight-resolver.js';
import {FIXED_EVAL_ENGINE_FILES} from '../src/postgres/quant-fixed-eval-engine.js';
import {MP_PACKAGE_TRACE_CLOSURE_VERSION, MP_PACKAGE_TRACE_FILES, mpPackageTraceClosure, mpPackageTraceClosureHash} from '../src/multi-pine/package-closure.js';

/*
 * F11 R6-1 (RD-MP-39): the producer closure mp-package-trace-closure-v1. It lists only the files that bind the multi-Pine trace producer and that the run engine closure
 * does not hash already. Nothing here pins the hash of a repository file: every hash is computed at test time from the files as checked out, with CRLF read back as LF
 * where two readers are compared, so a Windows checkout and a Linux checkout run the same assertions.
 */

const NEW_SOURCE_FILES = ['src/multi-pine/package-closure.js', 'src/multi-pine/package-render.js', 'src/multi-pine/package-trace.js'];
const PRODUCER_ROOTS = ['src/multi-pine/package-trace.js', 'src/multi-pine/package-closure.js'];
const RUNTIME_ROOTS = ['src/postgres/quant-research-main.js', 'src/quant-research/io-profile-worker.js', 'src/postgres/quant-preflight-wiring.js', 'src/postgres/quant-preflight-routes.js'];
/** Modules the package modules must never reach: the executor and the run engine plumbing, the run store, the member set store and the run contract validator. */
const FORBIDDEN_REACH = ['src/multi-pine/executor.js', 'src/multi-pine/python-runner.js', 'src/multi-pine/candidate-plan.js', 'src/multi-pine/engine-closure.js', 'src/multi-pine/run-contract.js',
  'src/multi-pine/fixture-service.js', 'src/postgres/mp-run-store.js', 'src/postgres/mp-member-set-store.js'];

/** Modules planned to import the package modules (R6-2 and R6-4); neither exists yet. Any other importer outside the package modules fails the pin below. */
const PLANNED_IMPORTERS = ['src/multi-pine/package-gates.js', 'src/postgres/mp-package-store.js'];

const listed = new Set(MP_PACKAGE_TRACE_FILES);
const engineListed = new Set(MP_COMBINED_ENGINE_FILES);
const nodeImports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;

async function nodeClosure(roots) {
  const visited = new Set();
  async function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(nodeImports)) await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
  for (const file of roots) await visit(file);
  return visited;
}
async function walk(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const full = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full)); else found.push(full);
  }
  return found;
}
// A reader that turns CRLF back into LF, so the hash of an LF checkout and of a CRLF checkout agree.
const lfReadFile = async url => {
  const bytes = await fs.readFile(url);
  return bytes.includes(0x0d) ? Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : bytes;
};
const expectedHash = async readFile => hash(canonical({version: MP_PACKAGE_TRACE_CLOSURE_VERSION,
  files: Object.fromEntries(await Promise.all(MP_PACKAGE_TRACE_FILES.map(async file => [file, hash(await readFile(new URL('../' + file, import.meta.url)))])))}));

test('the closure is the producer and its closure module: explicit, sorted, unique, frozen, present, and versioned', async () => {
  assert.equal(MP_PACKAGE_TRACE_CLOSURE_VERSION, 'mp-package-trace-closure-v1');
  assert.deepEqual([...MP_PACKAGE_TRACE_FILES], ['src/multi-pine/package-closure.js', 'src/multi-pine/package-trace.js']);
  assert.deepEqual([...MP_PACKAGE_TRACE_FILES], [...MP_PACKAGE_TRACE_FILES].sort());
  assert.equal(new Set(MP_PACKAGE_TRACE_FILES).size, MP_PACKAGE_TRACE_FILES.length);
  assert.ok(Object.isFrozen(MP_PACKAGE_TRACE_FILES));
  for (const file of MP_PACKAGE_TRACE_FILES) await fs.access(file);
  for (const file of NEW_SOURCE_FILES) await fs.access(file);
});

test('disjoint from the multi-Pine run engine closure and from every existing research closure list', () => {
  for (const file of MP_PACKAGE_TRACE_FILES) {
    assert.ok(!MP_COMBINED_ONLY_FILES.includes(file), file + ' is in MP_COMBINED_ONLY_FILES');
    assert.ok(!engineListed.has(file), file + ' is in the combined engine closure');
    assert.ok(!QUANT_RUNTIME_ENGINE_FILES.includes(file), file + ' is in the runtime manifest');
  }
  for (const [name, files] of Object.entries({LEGACY: LEGACY_ENGINE_FILES, FOUNDATION: FOUNDATION_ENGINE_FILES, INGESTION: INGESTION_ENGINE_FILES, PF2_engine: PF2_ENGINE_FILES,
    PF2_evaluator: PF2_EVALUATOR_FILES, FE2a: FIXED_EVAL_ENGINE_FILES}))
    for (const file of NEW_SOURCE_FILES) assert.ok(!files.includes(file), file + ' is in ' + name);
  // all three new source files stay out of the run engine closure, including the renderer that the producer closure does not list
  for (const file of NEW_SOURCE_FILES) assert.ok(!MP_COMBINED_ONLY_FILES.includes(file) && !engineListed.has(file), file);
});

test('every file the producer imports is hashed by exactly one closure: this one or the run engine closure', async () => {
  const reached = await nodeClosure(PRODUCER_ROOTS);
  for (const file of PRODUCER_ROOTS) assert.ok(reached.has(file));
  assert.ok(reached.size > 3, 'the traversal must reach the shared modules');
  for (const file of reached) {
    const inEngine = engineListed.has(file), inThis = listed.has(file);
    assert.ok(inEngine || inThis, 'unhashed dependency ' + file);
    assert.ok(!(inEngine && inThis), 'hashed twice ' + file);
  }
  // no stale entry: every listed file is reached from a producer root
  for (const file of MP_PACKAGE_TRACE_FILES) assert.ok(reached.has(file), 'unreached entry ' + file);
  // the producer reaches the digest, decimal and code modules through the run engine closure
  for (const file of ['src/money.js', 'src/pine-bridge/source.js', 'src/multi-pine/codes.js']) assert.ok(reached.has(file) && engineListed.has(file), file);
});

test('the renderer is not part of the producer closure, and its own imports are all hashed by the run engine closure or are the producer', async () => {
  const reached = await nodeClosure(['src/multi-pine/package-render.js']);
  assert.ok(!listed.has('src/multi-pine/package-render.js'), 'a renderer edit must not rotate the trace record hash');
  for (const file of reached) assert.ok(engineListed.has(file) || NEW_SOURCE_FILES.includes(file), 'unexpected dependency of the renderer ' + file);
  assert.ok(reached.has('src/multi-pine/package-trace.js'));
});

test('the new modules reach no executor, run store, member set store, run contract validator or engine closure module', async () => {
  const reached = await nodeClosure(NEW_SOURCE_FILES);
  for (const file of FORBIDDEN_REACH) assert.ok(!reached.has(file), file + ' is reachable from a package module');
});

test('no runtime root imports a new module, and no other source file does except the planned importers, and inside the package modules the renderer imports the producer', async () => {
  const reached = await nodeClosure(RUNTIME_ROOTS);
  for (const file of NEW_SOURCE_FILES) assert.ok(!reached.has(file), file + ' is reachable from a runtime root');
  const importers = [];
  for (const file of (await walk('src')).filter(item => item.endsWith('.js') || item.endsWith('.mjs'))) {
    if (NEW_SOURCE_FILES.includes(file)) continue;
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(nodeImports)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (NEW_SOURCE_FILES.includes(target)) importers.push(file + ' -> ' + target);
    }
  }
  // The planned importers are the only files outside the package modules that may import them; neither may be reachable from a runtime root.
  const unplanned = importers.filter(edge => !PLANNED_IMPORTERS.includes(edge.split(' -> ')[0]));
  assert.deepEqual(unplanned, []);
  for (const file of PLANNED_IMPORTERS) assert.ok(!reached.has(file), file + ' is reachable from a runtime root');
  const inside = [];
  for (const file of NEW_SOURCE_FILES) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(nodeImports)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (NEW_SOURCE_FILES.includes(target)) inside.push(file + ' -> ' + target);
    }
  }
  assert.deepEqual(inside, ['src/multi-pine/package-render.js -> src/multi-pine/package-trace.js']);
});

test('the run engine closure source does not name a package module (the pin that MP_COMBINED_ONLY_FILES must not gain them)', async () => {
  const source = await fs.readFile('src/multi-pine/engine-closure.js', 'utf8');
  for (const name of ['package-closure', 'package-render', 'package-trace']) assert.ok(!source.includes(name), name);
  for (const file of NEW_SOURCE_FILES) assert.ok(!MP_COMBINED_ONLY_FILES.includes(file));
});

test('the hash is the version plus the sha256 of every listed file as checked out', async () => {
  const raw = await expectedHash(fs.readFile);
  assert.equal(await mpPackageTraceClosureHash(), raw);
  assert.match(raw, /^[a-f0-9]{64}$/);
  assert.deepEqual(await mpPackageTraceClosure(), {version: 'mp-package-trace-closure-v1', hash: raw});
  // an LF-normalised read gives the value an LF checkout gives; on an LF checkout it is the same bytes
  assert.equal(await mpPackageTraceClosureHash(lfReadFile), await expectedHash(lfReadFile));
  // the version is part of the hashed object, and the bare map is a different value
  const files = Object.fromEntries(await Promise.all(MP_PACKAGE_TRACE_FILES.map(async file => [file, hash(await fs.readFile(new URL('../' + file, import.meta.url)))])));
  assert.notEqual(hash(canonical({version: 'mp-package-trace-closure-v2', files})), raw);
  assert.notEqual(hash(canonical(files)), raw);
  // it differs from the run engine closure
  assert.notEqual(await mpCombinedEngineHash(), raw);
});

test('a changed byte in either listed file rotates the hash, and a file outside the list does not', async () => {
  const baseline = await mpPackageTraceClosureHash();
  for (const file of MP_PACKAGE_TRACE_FILES) {
    const target = new URL('../' + file, import.meta.url).href;
    const changed = await mpPackageTraceClosureHash(async url => {
      const bytes = await fs.readFile(url);
      return url.href === target ? Buffer.concat([bytes, Buffer.from('\n// changed\n')]) : bytes;
    });
    assert.notEqual(changed, baseline, file);
  }
  const renderer = new URL('../src/multi-pine/package-render.js', import.meta.url).href;
  const same = await mpPackageTraceClosureHash(async url => {
    const bytes = await fs.readFile(url);
    return url.href === renderer ? Buffer.concat([bytes, Buffer.from('\n// changed\n')]) : bytes;
  });
  assert.equal(same, baseline);
});

test('every listed file is read: a missing or unreadable file fails closed instead of hashing a shorter list', async () => {
  for (const file of MP_PACKAGE_TRACE_FILES) {
    const target = new URL('../' + file, import.meta.url).href;
    await assert.rejects(mpPackageTraceClosureHash(url => {
      if (url.href === target) throw Object.assign(new Error('missing ' + file), {code: 'ENOENT'});
      return fs.readFile(url);
    }), new RegExp('missing ' + file.replace(/[.]/g, '[.]')), file);
  }
  await assert.rejects(mpPackageTraceClosure(() => Promise.reject(new Error('no disk'))), /no disk/);
});
