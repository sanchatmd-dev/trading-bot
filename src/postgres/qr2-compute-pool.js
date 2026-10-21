import {Worker} from 'node:worker_threads';

// QR-2 S3b compute pool (RC-Q35, design option A). One lazily spawned worker thread per process computes the per-Bot view off the main
// thread's event loop. run() posts {id,snapshot,input} and settles with the worker's JSON-safe result; every infrastructure failure rejects
// with a Qr2ComputeFailure whose kind is timeout, crash, heap, spawn, busy, closed or clone. No queue and no retry: a second concurrent
// run() is refused (the route slot already prevents it, this is the second guard). The returned promise settles only after the worker has
// answered or has been terminated, so the route never frees its slot while a compute still runs. After a timeout or a crash the worker is
// dropped and the next run() spawns a new one. The worker holds no state, so termination leaves nothing to repair. Counters are
// process-local numbers only: no path, user, key or message text. The V8 flags --max-old-space-size, --max-old-space-size-percentage, --max-heap-size
// and --max-semi-space-size (each also spelled with underscores, with or without =value, on the command line or in NODE_OPTIONS) are process-wide
// and override the worker resourceLimits maxOldGenerationSizeMb (first three) or maxYoungGenerationSizeMb (the semi-space flag), which would
// silently disable the heap cap (Node 24.22 experiment, RC-Q40). The pool therefore fails closed: with that flag set, start() refuses before it calls spawn, so no worker
// exists and run() rejects with kind spawn (counted as spawn). Only the flag name is tested; its value is never read or reported.

export const QR2_COMPUTE_DEADLINE_MS=10000;
export const QR2_COMPUTE_RESOURCE_LIMITS=Object.freeze({maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32,stackSizeMb:4});
export const QR2_WORKER_ROLE='qr2-compute';
const DEFAULT_WORKER_URL=new URL('./qr2-compute-worker.js',import.meta.url);

const HEAP_FLAG=/^--?(?:max[-_]old[-_]space[-_]size(?:[-_]percentage)?|max[-_]heap[-_]size|max[-_]semi[-_]space[-_]size)(?:=|["']*$)/;
// True when the argv list or the NODE_OPTIONS text sets the process-wide old-space limit. Pure: reads only its arguments.
export function setsProcessHeapLimit(execArgv,nodeOptions){
  if(Array.isArray(execArgv)&&execArgv.some(arg=>typeof arg==='string'&&HEAP_FLAG.test(arg)))return true;
  if(typeof nodeOptions!=='string')return false;
  return nodeOptions.split(/\s+/).some(token=>HEAP_FLAG.test(token.replace(/^["']+/,'')));
}

export class Qr2ComputeFailure extends Error{
  constructor(kind){super('QR-2 compute '+kind);this.name='Qr2ComputeFailure';this.kind=kind;}
}

/**
 * options: {deadlineMs (default 10000; a pool option only, no environment override), resourceLimits, workerUrl, spawn, execArgv, nodeOptions}. spawn(url,options) is a test seam (default new Worker).
 * execArgv and nodeOptions are test seams for the heap-flag refusal; they default to process.execArgv and process.env.NODE_OPTIONS, read at each worker start. Returns
 * {run(snapshot,input), close(), counters, busy, alive}.
 */
export function createQr2ComputePool({deadlineMs=QR2_COMPUTE_DEADLINE_MS,resourceLimits=QR2_COMPUTE_RESOURCE_LIMITS,workerUrl=DEFAULT_WORKER_URL,
  spawn=(url,options)=>new Worker(url,options),execArgv,nodeOptions}={}){
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1)throw new TypeError('deadlineMs must be a positive integer');
  const counters={timeout:0,crash:0,heap:0,spawn:0,completed:0};
  let current=null;   // {worker,ready}: the live worker, or null
  let job=null;       // {id,resolve,reject,timer}: the one running job, or null
  let nextId=1,closed=false;

  const count=kind=>{
    if(kind==='heap'){counters.heap++;counters.crash++;}
    else if(Object.hasOwn(counters,kind))counters[kind]++;
  };

  // Rejects the running job after the worker is gone. The job stays set (so busy stays true and the slot stays held) until then.
  function failJob(entry,kind,{counted=true}={}){
    const failing=job;
    if(!failing)return;
    clearTimeout(failing.timer);
    if(counted)count(kind);
    // close() awaits failing.terminating and leaves the rejection (with the real failure kind) to this chain.
    failing.terminating=entry.worker.terminate().catch(()=>{}).then(()=>{
      if(job===failing)job=null;
      failing.reject(new Qr2ComputeFailure(kind));
    });
  }

  function onMessage(entry,message){
    if(entry!==current||!message||typeof message!=='object')return;
    if(message.type==='ready'){entry.ready=true;return;}
    if(!job||message.id!==job.id)return;
    const finished=job;
    clearTimeout(finished.timer);
    job=null;
    entry.worker.unref();
    counters.completed++;
    const {id,...result}=message;
    finished.resolve(typeof result.ok==='boolean'?result:{ok:false,kind:'other'});
  }

  function onGone(entry,error){
    if(entry!==current)return;
    current=null;
    if(!job)return;
    const heap=!!error&&error.code==='ERR_WORKER_OUT_OF_MEMORY';
    failJob(entry,entry.ready?(heap?'heap':'crash'):'spawn');
  }

  // An answer that cannot be deserialized ends the job as a crash: the worker state is unknown, so the worker is dropped.
  function onMessageError(entry){
    if(entry!==current)return;
    current=null;
    if(!job){entry.worker.terminate().catch(()=>{});return;}
    failJob(entry,'crash');
  }

  function start(){
    let worker;
    // Fail closed before any worker exists: a process-wide heap flag would override the worker heap cap.
    if(setsProcessHeapLimit(execArgv??process.execArgv,nodeOptions??process.env.NODE_OPTIONS)){counters.spawn++;throw new Qr2ComputeFailure('spawn');}
    try{worker=spawn(workerUrl,{resourceLimits:{...resourceLimits},workerData:{role:QR2_WORKER_ROLE},env:{}});}
    catch{counters.spawn++;throw new Qr2ComputeFailure('spawn');}
    const entry={worker,ready:false};
    worker.unref();
    worker.on('message',message=>onMessage(entry,message));
    worker.on('messageerror',()=>onMessageError(entry));
    worker.on('error',error=>onGone(entry,error));
    worker.on('exit',()=>onGone(entry,null));
    current=entry;
    return entry;
  }

  function run(snapshot,input){
    if(closed)return Promise.reject(new Qr2ComputeFailure('closed'));
    if(job)return Promise.reject(new Qr2ComputeFailure('busy'));
    let entry;
    try{entry=current||start();}catch(error){return Promise.reject(error);}
    return new Promise((resolve,reject)=>{
      const running={id:nextId++,resolve,reject,timer:null,terminating:null};
      job=running;
      // A running job keeps the worker and the deadline timer referenced; an idle worker never holds the process open.
      entry.worker.ref();
      running.timer=setTimeout(()=>{
        if(job!==running)return;
        if(current===entry)current=null;
        failJob(entry,'timeout');
      },deadlineMs);
      try{entry.worker.postMessage({id:running.id,snapshot,input});}
      catch{
        clearTimeout(running.timer);
        job=null;
        entry.worker.unref();
        reject(new Qr2ComputeFailure('clone'));
      }
    });
  }

  // Resolves only when no thread of this pool is left. A job that is already failing keeps its own failure kind (its chain rejects it).
  // Memoized: every call, concurrent or later, returns the same promise, so none resolves before the thread is gone.
  let closing$=null;
  function close(){
    return closing$??=(async()=>{
      closed=true;
      const entry=current;
      current=null;
      const closing=job;
      if(closing&&!closing.terminating)clearTimeout(closing.timer);
      if(entry)await entry.worker.terminate().catch(()=>{});
      if(!closing)return;
      if(closing.terminating){await closing.terminating;return;}
      if(job===closing){job=null;closing.reject(new Qr2ComputeFailure('closed'));}
    })();
  }

  return {
    run,
    close,
    get counters(){return {...counters};},
    get busy(){return job!==null;},
    get alive(){return current!==null;}
  };
}
