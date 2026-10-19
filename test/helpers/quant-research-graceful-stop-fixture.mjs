import {fail} from '../../src/pine-bridge/source.js';
import {continuation} from './quant-research-contract-guards-fixture.mjs';

/**
 * D1 graceful-stop fixtures (docs/QL_3A_DURABLE_JOBS.md recovery paragraph, owner decision 2026-10-19).
 * Evaluators below stand in for the supervised subprocess. They are engineering stubs: the metrics they return say nothing
 * about strategy performance. Every evaluator that waits for an interruption does so on the worker's own AbortSignal, so a
 * test never needs a real sleep; the abort comes from worker.stop(), the call that the SIGTERM handler of
 * src/postgres/quant-research-main.js makes.
 */
const aborted=signal=>new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});

/**
 * Legacy evaluator: the `interruptAt`-th call blocks until the worker aborts, then rejects with RESEARCH_INTERRUPTED exactly as
 * pythonEvaluation() does after it kills the subprocess. Every other call is answered by the scripted stub.
 */
export function legacyInterruptible({script,interruptAt}){
 let calls=0,reached;
 const ready=new Promise(resolve=>{reached=resolve;});
 const evaluate=async(contract,parameters,kind,signal)=>{
  if(++calls!==interruptAt)return script.evaluate(contract,parameters,kind);
  reached();await aborted(signal);throw fail('RESEARCH_INTERRUPTED');
 };
 return {evaluate,ready,count:()=>calls};
}

/**
 * Foundation chunk evaluator that honours the abort like the real supervisor (process-supervisor.js): the `interruptAtCall`-th
 * call blocks until abort, then rejects RESEARCH_INTERRUPTED with stopped:true. The output the killed process would have
 * produced is computed and kept in `late()`; a test can look at it to prove that nobody committed it.
 */
export function chunkInterruptible({interruptAtCall}){
 let calls=0,reached,lateOutput=null;
 const ready=new Promise(resolve=>{reached=resolve;});
 const evaluateChunk=async(payload,signal)=>{
  if(++calls!==interruptAtCall)return continuation(payload);
  lateOutput=continuation(payload);
  reached();await aborted(signal);
  throw Object.assign(fail('RESEARCH_INTERRUPTED'),{stopped:true});
 };
 return {evaluateChunk,ready,count:()=>calls,late:()=>lateOutput};
}

/**
 * Foundation chunk evaluator that ignores the abort and answers late, after the test released its gate. The real supervisor never
 * does this; the stub checks that the worker itself refuses output that arrives after a graceful stop.
 */
export function chunkIgnoringAbort({lateAtCall}){
 let calls=0,reached,release;
 const ready=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const evaluateChunk=async payload=>{
  if(++calls!==lateAtCall)return continuation(payload);
  reached();await gate;return continuation(payload);
 };
 return {evaluateChunk,ready,release:()=>release(),count:()=>calls};
}
