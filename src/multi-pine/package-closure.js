import fs from 'node:fs/promises';
import {canonical, hash} from '../pine-bridge/source.js';

/*
 * F11 R6-1: the producer closure `mp-package-trace-closure-v1` (docs/MULTI_PINE_CONTRACT.md RD-MP-39).
 *
 * The multi-Pine trace producer (package-trace.js) derives the three trace files of a multi-Pine package from the stored holdout decisions of a finished run. The files
 * it writes are only as trustworthy as the code that wrote them, so each trace record carries a hash of that code: this closure.
 *
 * The closure lists ONLY the files that bind the producer and that the multi-Pine run engine closure (mp-combined-closure-v1) does not already hash. The producer's
 * shared dependencies (the digest and canonical-JSON module, the decimal module, the multi-Pine codes) sit in the run engine closure; a build refuses when the live run
 * closure differs from the run contract's engine hash, so those bytes are pinned there and are deliberately NOT repeated here. The two lists are disjoint: a test pins that.
 * The version sits inside the hashed object, so a change of the file list rotates the hash even if every byte stays equal.
 *
 * Nothing here is imported by a runtime root, by the run engine, or by the run store.
 */
export const MP_PACKAGE_TRACE_CLOSURE_VERSION = 'mp-package-trace-closure-v1';
/** The files only this closure covers: the producer and this module. Explicit and sorted. */
export const MP_PACKAGE_TRACE_FILES = Object.freeze([
  'src/multi-pine/package-closure.js',
  'src/multi-pine/package-trace.js'
]);

/** Hash of the closure. `readFile` is injectable so a test can change one file or drop one; a missing file rejects (it never hashes a shorter list). */
export async function mpPackageTraceClosureHash(readFile = fs.readFile) {
  const values = await Promise.all(MP_PACKAGE_TRACE_FILES.map(async name => [name, hash(await readFile(new URL('../../' + name, import.meta.url)))]));
  return hash(canonical({version: MP_PACKAGE_TRACE_CLOSURE_VERSION, files: Object.fromEntries(values)}));
}
/** The value a trace record carries as its producer closure. */
export async function mpPackageTraceClosure(readFile = fs.readFile) {
  return {version: MP_PACKAGE_TRACE_CLOSURE_VERSION, hash: await mpPackageTraceClosureHash(readFile)};
}
