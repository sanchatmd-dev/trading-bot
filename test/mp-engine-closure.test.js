import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical, hash} from '../src/pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../src/quant-research/runtime-engine-files.js';
import {MP_COMBINED_CLOSURE_VERSION, MP_COMBINED_ENGINE_FILES, MP_COMBINED_ONLY_FILES, mpCombinedClosure, mpCombinedEngineHash} from '../src/multi-pine/engine-closure.js';
import {INGESTION_ENGINE_FILES, ingestionEngineHash} from '../src/postgres/quant-data.js';
import {FOUNDATION_ENGINE_FILES, LEGACY_ENGINE_FILES, engineHash} from '../src/postgres/quant-research.js';
import {PF2_ENGINE_FILES, PF2_EVALUATOR_FILES, pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {FIXED_EVAL_ENGINE_FILES, fixedEvalEngineHash} from '../src/postgres/quant-fixed-eval-engine.js';
import {QUANT_IO_MODULES} from '../src/quant-research/process-supervisor.js';

/*
 * F11 S3: the multi-Pine engine closure mp-combined-closure-v1 (RD-MP-31). Its dedicated files stay outside the research closures.
 * FE-2b updates the shared runtime under the owner's 2026-10-22 implementation GO; the release evidence records the old and new hashes.
 */

/** The new Node modules: roots of the Node traversal (executor, oracle, plan and runner as RD-MP-31 names them, plus the closure module itself). */
const NEW_NODE_FILES = ['src/multi-pine/candidate-plan.js', 'src/multi-pine/combined-oracle.js', 'src/multi-pine/engine-closure.js', 'src/multi-pine/executor.js', 'src/multi-pine/python-runner.js'];
const NEW_PYTHON_FILES = ['quant_lab/src/robot_quant/mp_combined_job.py', 'quant_lab/src/robot_quant/mp_combined_paper.py'];
const NEW_FILES = [...NEW_NODE_FILES, ...NEW_PYTHON_FILES];
const RUNTIME_ROOTS = ['src/postgres/quant-research-main.js', 'src/quant-research/io-profile-worker.js', 'src/postgres/quant-preflight-wiring.js', 'src/postgres/quant-preflight-routes.js'];
/** Candidate closure pins. Update only with an authorized engine change and an old/new closure inventory. */
const BASE_HASHES = Object.freeze({
  legacy: '988171145615b423393760f11c0cf050c2df2b1c9d27df5cfebd972f88c6e63a',
  foundation: '3b29eb619f2b4eda1e8abb924e965965c221282462daf238d2cfdd0707386c22',
  ingestion: 'e10687a3f45eba8cc285c4612ae580db14d94367af3e1fc0b5005346dffa65ce',
  pf2_engine: '046422ce7627f136983f8e0ee2d382141d1d915f5858e03b48815ee661ea42b7',
  pf2_evaluator: '3fb2d465215ea2473aaa5d5e458d18fcd526aea239348063a3372e661d630ada',
  fixed_eval: 'b3acd0c8af04a06f17ad5d54946c55e892869f12f64200271f84c200df39bf88'
});

const listed = new Set(MP_COMBINED_ENGINE_FILES);
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
// Both import forms: "from robot_quant import a, b" (each name may be a module) and "from [.|robot_quant.]name import ...".
async function pythonClosure(roots) {
  const visited = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const source = await fs.readFile('quant_lab/src/robot_quant/' + name + '.py', 'utf8');
    for (const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant\.)([A-Za-z_][A-Za-z_0-9]*)\s+import\b/gm)) await visit(match[1]);
    for (const match of source.matchAll(/^\s*from\s+(?:\.|robot_quant)\s+import\s+([A-Za-z_][A-Za-z_0-9, ]*)/gm)) {
      for (const imported of match[1].split(',').map(item => item.trim()).filter(Boolean)) {
        const exists = await fs.access('quant_lab/src/robot_quant/' + imported + '.py').then(() => true, () => false);
        if (exists) await visit(imported);
      }
    }
    for (const match of source.matchAll(/^\s*import\s+robot_quant\.([A-Za-z_][A-Za-z_0-9]*)/gm)) await visit(match[1]);
  }
  for (const name of roots) await visit(name);
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

test('the closure is the runtime manifest plus the multi-only files, sorted, unique, frozen and present', async () => {
  assert.equal(MP_COMBINED_CLOSURE_VERSION, 'mp-combined-closure-v1');
  assert.equal(MP_COMBINED_ENGINE_FILES.length, new Set(MP_COMBINED_ENGINE_FILES).size);
  assert.deepEqual([...MP_COMBINED_ENGINE_FILES], [...MP_COMBINED_ENGINE_FILES].sort());
  assert.deepEqual([...MP_COMBINED_ONLY_FILES], [...MP_COMBINED_ONLY_FILES].sort());
  assert.equal(MP_COMBINED_ONLY_FILES.length, new Set(MP_COMBINED_ONLY_FILES).size);
  assert.equal(MP_COMBINED_ENGINE_FILES.length, QUANT_RUNTIME_ENGINE_FILES.length + MP_COMBINED_ONLY_FILES.length);
  for (const file of QUANT_RUNTIME_ENGINE_FILES) assert.ok(listed.has(file), 'missing runtime entry ' + file);
  for (const file of MP_COMBINED_ONLY_FILES) { assert.ok(listed.has(file), 'missing multi entry ' + file); assert.ok(!QUANT_RUNTIME_ENGINE_FILES.includes(file), file + ' is already in the runtime manifest'); }
  for (const file of NEW_FILES) assert.ok(MP_COMBINED_ONLY_FILES.includes(file), 'new file not listed ' + file);
  for (const file of MP_COMBINED_ENGINE_FILES) await fs.access(file);
  assert.ok(Object.isFrozen(MP_COMBINED_ENGINE_FILES) && Object.isFrozen(MP_COMBINED_ONLY_FILES));
});

test('Python import closure of the job (and the library it names) sits inside the closure', async () => {
  const modules = await pythonClosure(['__init__', 'mp_combined_job']);
  assert.ok(modules.has('mp_combined_job') && modules.has('mp_combined_paper') && modules.has('paper_state') && modules.has('bridge_replay') && modules.has('spt_custom_evaluator') && modules.has('ql3a'));
  assert.ok(modules.size > 10, 'traversal must reach the engine modules');
  for (const name of modules) assert.ok(listed.has('quant_lab/src/robot_quant/' + name + '.py'), 'unhashed Python dependency ' + name);
  // the new Python files are the ONLY Python files the multi closure adds to the runtime manifest
  assert.deepEqual(MP_COMBINED_ONLY_FILES.filter(file => file.endsWith('.py')), NEW_PYTHON_FILES);
});

test('Node import closure of the new modules sits inside the closure: shared application files included', async () => {
  const imports = await nodeClosure(NEW_NODE_FILES);
  for (const file of NEW_NODE_FILES) assert.ok(imports.has(file));
  assert.ok(imports.size > 15, 'traversal must reach the money, risk and Bridge modules');
  for (const file of imports) assert.ok(listed.has(file), 'unhashed dependency ' + file);
  // the files the multi run decides money with are hashed here, not exempt as shared application files
  for (const file of ['src/money.js', 'src/postgres/risk.js', 'src/postgres/pine-bridge-execution.js', 'src/pine-bridge/contract.js', 'src/pine-bridge/source.js', 'src/multi-pine/codes.js'])
    assert.ok(listed.has(file), file);
  // the list holds no Node file nothing imports (no stale entry): every Node entry beyond the runtime manifest is reached
  for (const file of MP_COMBINED_ONLY_FILES.filter(item => item.endsWith('.js'))) assert.ok(imports.has(file), 'unreached entry ' + file);
});

test('multi-Pine files remain outside the research closures and its job stays outside the I/O allowlist', () => {
  const lists = {LEGACY: LEGACY_ENGINE_FILES, FOUNDATION: FOUNDATION_ENGINE_FILES, INGESTION: INGESTION_ENGINE_FILES, PF2_engine: PF2_ENGINE_FILES, PF2_evaluator: PF2_EVALUATOR_FILES,
    runtime_manifest: QUANT_RUNTIME_ENGINE_FILES, FE2a: FIXED_EVAL_ENGINE_FILES};
  // the NEW files (the diff of F11 S3) are in none; shared files such as src/money.js may sit in an existing list and are not edited
  for (const [name, files] of Object.entries(lists)) for (const file of NEW_FILES) assert.ok(!files.includes(file), file + ' is in ' + name);
  assert.deepEqual([...QUANT_IO_MODULES].sort(), ['robot_quant.fixed_eval_job', 'robot_quant.pf2_replay', 'robot_quant.research_chunk']);
  assert.ok(!QUANT_IO_MODULES.has('robot_quant.mp_combined_job'), 'the I/O module allowlist must not list the job');
});

test('no runtime root imports a new module, and no other source file does', async () => {
  const reached = await nodeClosure(RUNTIME_ROOTS);
  for (const file of NEW_NODE_FILES) assert.ok(!reached.has(file), file + ' is reachable from a runtime root');
  const importers = [];
  for (const file of (await walk('src')).filter(item => item.endsWith('.js') || item.endsWith('.mjs'))) {
    if (NEW_NODE_FILES.includes(file)) continue;
    const source = await fs.readFile(file, 'utf8');
    if (/candidate-plan|engine-closure|multi-pine\/executor|\.\/executor|python-runner/.test(source)) importers.push(file);
  }
  assert.deepEqual(importers, []);
  for (const file of NEW_PYTHON_FILES) assert.ok(!(await fs.readFile('src/quant-research/process-supervisor.js', 'utf8')).includes(path.posix.basename(file, '.py')));
});

test('the hash is the version plus the sha256 of every listed file as checked out', async () => {
  const files = Object.fromEntries(await Promise.all(MP_COMBINED_ENGINE_FILES.map(async file => [file, hash(await fs.readFile(file))])));
  const expected = hash(canonical({version: MP_COMBINED_CLOSURE_VERSION, files}));
  assert.equal(await mpCombinedEngineHash(), expected);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.deepEqual(await mpCombinedClosure(), {version: 'mp-combined-closure-v1', hash: expected});
  // the version is part of the hashed object, and the bare map (the older closures' formula) is a different value
  assert.notEqual(hash(canonical({version: 'mp-combined-closure-v2', files})), expected);
  assert.notEqual(hash(canonical(files)), expected);
  // it differs from the fixed-input evaluation closure and every research closure
  for (const other of [await fixedEvalEngineHash(), await ingestionEngineHash(), await engineHash(true), await engineHash(false)]) assert.notEqual(other, expected);
});

test('a changed byte in a Python, a new Node, a shared Node or a runtime file rotates the hash', async () => {
  const baseline = await mpCombinedEngineHash();
  const samples = [...NEW_PYTHON_FILES, ...NEW_NODE_FILES, 'src/money.js', 'src/postgres/risk.js', 'src/pine-bridge/contract.js', 'src/postgres/mp-run-store.js', 'src/multi-pine/member-set.js',
    'quant_lab/src/robot_quant/paper_state.py', 'quant_lab/src/robot_quant/bridge_replay.py', 'src/quant-research/contract.js'];
  for (const file of samples) {
    const target = new URL('../' + file, import.meta.url).href;
    const changed = await mpCombinedEngineHash(async url => {
      const bytes = await fs.readFile(url);
      return url.href === target ? Buffer.concat([bytes, Buffer.from('\n# changed\n')]) : bytes;
    });
    assert.notEqual(changed, baseline, file);
  }
});

test('every listed file is read: a missing or unreadable file fails closed instead of hashing a shorter list', async () => {
  for (const file of [...MP_COMBINED_ONLY_FILES, 'quant_lab/src/robot_quant/ql3a.py', 'src/quant-research/runtime-engine-files.js']) {
    const target = new URL('../' + file, import.meta.url).href;
    await assert.rejects(mpCombinedEngineHash(url => {
      if (url.href === target) throw Object.assign(new Error('missing ' + file), {code: 'ENOENT'});
      return fs.readFile(url);
    }), new RegExp('missing ' + file.replace(/[.]/g, '[.]')), file);
  }
  await assert.rejects(mpCombinedClosure(() => Promise.reject(new Error('no disk'))), /no disk/);
});

// The pins are hashes of the Git blobs (LF). A Windows checkout writes CRLF, so the comparison reads every file with CRLF turned back into LF; on an LF
// checkout this reader returns the bytes unchanged.
const lfReadFile = async url => {
  const bytes = await fs.readFile(url);
  return bytes.includes(0x0d) ? Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : bytes;
};
// engineHash takes no reader, so the legacy and foundation hashes are recomputed here; the same function over raw bytes must equal engineHash itself.
const researchHash = async (files, readFile) =>
  hash(canonical(Object.fromEntries(await Promise.all(files.map(async name => [name, hash(await readFile(new URL('../' + name, import.meta.url)))])))));

test('the six engine closure hashes equal the authorized candidate pins', async () => {
  assert.equal(await researchHash(LEGACY_ENGINE_FILES, fs.readFile), await engineHash(false));
  assert.equal(await researchHash(FOUNDATION_ENGINE_FILES, fs.readFile), await engineHash(true));
  const pf2 = await pf2ExecutableHashes({readFile: lfReadFile});
  assert.deepEqual({
    legacy: await researchHash(LEGACY_ENGINE_FILES, lfReadFile), foundation: await researchHash(FOUNDATION_ENGINE_FILES, lfReadFile),
    ingestion: await ingestionEngineHash(lfReadFile), pf2_engine: pf2.engine_hash, pf2_evaluator: pf2.evaluator_hash, fixed_eval: await fixedEvalEngineHash(lfReadFile)
  }, BASE_HASHES);
});
