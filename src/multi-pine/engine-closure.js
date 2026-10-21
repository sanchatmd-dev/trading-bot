import fs from 'node:fs/promises';
import {canonical, hash} from '../pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../quant-research/runtime-engine-files.js';

/*
 * F11 S3: the engine closure of the combined multi-Pine run (docs/MULTI_PINE_CONTRACT.md RD-MP-31, root ruling R-9).
 * Same pattern as the FE-2a fixed-input evaluation closure: the reviewed runtime manifest plus the files only this closure
 * covers. The hash is hash(canonical({version, files})) over the sha256 of every listed file as checked out; the version sits inside the hashed object, so a change
 * of the file list rotates the hash even if every byte stays equal. The hash is the `engine_hash` of the multi-Pine run contract and the value RS-5 injects.
 *
 * MP_COMBINED_ONLY_FILES holds: the new Python files of the combined evaluator; the new Node files of the plan, oracle, executor, runner and this closure; and every
 * other Node file in the import closure of the executor, oracle and plan that the runtime manifest does not list, SHARED application files included (the multi run
 * decides money with money.js, risk.js and the Bridge execution rounding, so those bytes are hashed here even though the runtime boundary may leave them out).
 * The list is explicit and sorted. test/mp-engine-closure.test.js computes the real import closures and fails on any file this list misses.
 * No existing research closure (LEGACY, FOUNDATION, INGESTION, PF2 engine, PF2 evaluator, runtime, fixed evaluation) lists any of these files.
 */
export const MP_COMBINED_CLOSURE_VERSION = 'mp-combined-closure-v1';
/** Files only the multi-Pine closure covers. */
export const MP_COMBINED_ONLY_FILES = Object.freeze([
  'quant_lab/src/robot_quant/mp_combined_job.py',
  'quant_lab/src/robot_quant/mp_combined_paper.py',
  'src/domain.js',
  'src/money.js',
  'src/multi-pine/candidate-plan.js',
  'src/multi-pine/codes.js',
  'src/multi-pine/combined-oracle.js',
  'src/multi-pine/engine-closure.js',
  'src/multi-pine/executor.js',
  'src/multi-pine/member-set.js',
  'src/multi-pine/python-runner.js',
  'src/multi-pine/run-contract.js',
  'src/pine-bridge/contract.js',
  'src/pine-bridge/exit-version.js',
  'src/pine-bridge/source.js',
  'src/pine-bridge/template.js',
  'src/postgres/mp-member-set-store.js',
  'src/postgres/mp-run-store.js',
  'src/postgres/pine-bridge-execution.js',
  'src/postgres/pine-bridge-market.js',
  'src/postgres/pine-bridge-readiness.js',
  'src/postgres/pine-bridge-registry.js',
  'src/postgres/risk.js'
]);
export const MP_COMBINED_ENGINE_FILES = Object.freeze([...new Set([...QUANT_RUNTIME_ENGINE_FILES, ...MP_COMBINED_ONLY_FILES])].sort());

/** Hash of the closure. `readFile` is injectable so a test can change one file or drop one; a missing file rejects (it never hashes a shorter list). */
export async function mpCombinedEngineHash(readFile = fs.readFile) {
  const values = await Promise.all(MP_COMBINED_ENGINE_FILES.map(async name => [name, hash(await readFile(new URL('../../' + name, import.meta.url)))]));
  return hash(canonical({version: MP_COMBINED_CLOSURE_VERSION, files: Object.fromEntries(values)}));
}
/** The value a result carries as its closure. */
export async function mpCombinedClosure(readFile = fs.readFile) {
  return {version: MP_COMBINED_CLOSURE_VERSION, hash: await mpCombinedEngineHash(readFile)};
}
