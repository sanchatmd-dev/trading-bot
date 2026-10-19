import fs from 'node:fs/promises';
import {canonical,hash} from '../pine-bridge/source.js';
import {QUANT_RUNTIME_ENGINE_FILES} from '../quant-research/runtime-engine-files.js';

/** Versioned evaluation closure of mode FIXED_INPUT_EVAL (FE-2a). It pins every byte a fixed-input evaluation runs:
 * the reviewed runtime manifest (which holds the Paper engine, the SPT Custom evaluator and the research modules the
 * job shares), the fixed-input evaluator and its job wrapper, and the Node modules that build and check the contract.
 * The hash is stored as the eval contract engine_hash. The version sits inside the hashed object, so a change of the
 * file list rotates the hash even if every byte stays equal. No research closure (LEGACY, FOUNDATION, INGESTION, PF2)
 * hashes these files yet; wiring them in is FE-2b, and the existing closure test then lists them.
 */
export const FIXED_EVAL_CLOSURE_VERSION='fixed-eval-closure-v1';
/** Files only the evaluation closure covers. The Python pair stays out of the runtime manifest on purpose. */
export const FIXED_EVAL_ONLY_FILES=Object.freeze([
 'quant_lab/src/robot_quant/fixed_eval.py',
 'quant_lab/src/robot_quant/fixed_eval_job.py',
 'src/postgres/quant-fixed-eval-engine.js',
 'src/quant-research/fixed-eval-contract.js',
]);
export const FIXED_EVAL_ENGINE_FILES=Object.freeze([...new Set([...QUANT_RUNTIME_ENGINE_FILES,...FIXED_EVAL_ONLY_FILES])].sort());

/** Hash of the evaluation closure. `readFile` is injectable so a test can change one file or drop one. */
export async function fixedEvalEngineHash(readFile=fs.readFile){
 const values=await Promise.all(FIXED_EVAL_ENGINE_FILES.map(async name=>[name,hash(await readFile(new URL('../../'+name,import.meta.url)))]));
 return hash(canonical({version:FIXED_EVAL_CLOSURE_VERSION,files:Object.fromEntries(values)}));
}
/** The value a result row carries as evaluation_closure. */
export async function fixedEvalClosure(readFile=fs.readFile){
 return {version:FIXED_EVAL_CLOSURE_VERSION,hash:await fixedEvalEngineHash(readFile)};
}
