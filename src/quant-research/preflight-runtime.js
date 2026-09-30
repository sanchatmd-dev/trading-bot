import {randomUUID} from 'node:crypto';
import {canonical} from '../pine-bridge/source.js';
import {runQuantProcess} from './process-supervisor.js';

/**
 * PF-2 runtime glue (slice R4): a runChunk for the S4 replay driver that runs each chunk through the
 * process supervisor as robot_quant.pf2_replay. Pure glue: no database import. The caller injects
 * persistUnit and clearUnit (fenced writes of the transient unit name), so a crash between spawn and
 * settle always leaves a unit name that offline recovery can stop.
 *
 * Per chunk: parse the driver's request bytes, persist a fresh unit name, only then start the
 * supervisor, and clear the name only after the supervisor settled with proof the process is gone.
 * Every step, including the persist that precedes the spawn, is tracked, so settled() cannot resolve
 * while a launch is still possible. Nothing about the child is returned beyond its result JSON: a
 * failed chunk throws one fixed runner error, and only an allowlisted supervisor code is kept for the
 * job diagnostic (PF2_RUNNER_FAILED:<CODE>). After a stop that could not be confirmed no further chunk starts.
 */
export const PF2_SUPERVISOR_CODES=Object.freeze(['EVALUATION_TIMED_OUT','EVALUATION_FAILED','INVALID_EVALUATION_RESPONSE',
  'EVALUATION_OUTPUT_TOO_LARGE','RESEARCH_INTERRUPTED','QUANT_PYTHON_UNAVAILABLE','QUANT_IO_GATE_FAILED',
  'QUANT_IO_TELEMETRY_UNAVAILABLE','QUANT_IO_READINESS_CONFIGURATION_REQUIRED','QUANT_IO_READINESS_CLEANUP_FAILED',
  'QUANT_IO_STORAGE_DEVICE_MISMATCH','QUANT_PROCESS_STOP_UNCONFIRMED','RESEARCH_REQUEST_TOO_LARGE']);
const ALLOWED=new Set(PF2_SUPERVISOR_CODES);
const PF2_MODULE='robot_quant.pf2_replay';
const TERMINAL_PROTOCOL='quant-io-terminal-v1';
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

const runnerFailure=()=>Object.assign(new Error('PF2_RUNNER_FAILED'),{code:'PF2_RUNNER_FAILED'});
const configInvalid=()=>Object.assign(new TypeError('PF2_RUNTIME_CONFIG_INVALID'),{code:'PF2_RUNTIME_CONFIG_INVALID'});
const read=(value,key)=>{try{return value?.[key];}catch{return undefined;}};

/** The driver-visible line: canonical JSON of the supervisor result plus one newline. */
function frameOf(result){
  if(result===null||typeof result!=='object'||Array.isArray(result))throw new TypeError('result');
  return Buffer.from(canonical(result)+'\n','utf8');
}

/**
 * Returns {runChunk, settled, unconfirmed, lastSupervisorCode}. `unconfirmed` and `lastSupervisorCode`
 * are live read-only properties. `unconfirmed` turns true once any supervisor failure did not prove
 * the process stopped (the unit name then stays persisted for recovery); it never turns back.
 */
export function createSupervisedRunner(options){
  let settings;
  try{
    if(options===null||typeof options!=='object')throw new TypeError('options');
    const {supervisor=runQuantProcess,python,limits,ioControls,storageBudget,allowUnsupportedPlatformForTests,
      deadlineAt,clock,persistUnit,clearUnit}=options;
    settings={supervisor,python,limits,ioControls,storageBudget,allowUnsupportedPlatformForTests,deadlineAt,clock,
      persistUnit,clearUnit};
  }catch{throw configInvalid();}
  const {supervisor,python,limits,ioControls,storageBudget,allowUnsupportedPlatformForTests,deadlineAt,clock,
    persistUnit,clearUnit}=settings;
  if(typeof supervisor!=='function'||typeof persistUnit!=='function'||typeof clearUnit!=='function'||
    typeof clock!=='function'||typeof deadlineAt!=='number'||!Number.isFinite(deadlineAt))throw configInvalid();
  const inFlight=new Set();
  let unconfirmed=false,lastSupervisorCode=null;

  async function execute(input,callOptions){
    // A later persistUnit would overwrite the kept unit name that recovery needs to stop the old process.
    if(unconfirmed)throw runnerFailure();
    let signal,payload;
    try{signal=callOptions?.signal;}catch{signal=undefined;}
    try{
      if(!(input instanceof Uint8Array))throw new TypeError('input');
      payload=JSON.parse(utf8.decode(input));
      if(payload===null||typeof payload!=='object'||Array.isArray(payload))throw new TypeError('payload');
    }catch{throw runnerFailure();}
    const unitName='robot-quant-'+randomUUID()+'.service';
    try{await persistUnit(unitName);}catch{throw runnerFailure();}
    let result,error,threw=false,launched=false;
    try{
      const timeoutMs=Math.floor(Math.min(30000,Math.max(100,deadlineAt-clock())));
      launched=true;
      result=await supervisor({payload,module:PF2_MODULE,signal,python,timeoutMs,limits,ioControls,
        ioTerminalProtocol:ioControls?TERMINAL_PROTOCOL:undefined,storageBudget:ioControls?storageBudget:undefined,
        unitName,allowUnsupportedPlatformForTests});
    }catch(caught){threw=true;error=caught;}
    if(threw&&launched){
      const code=read(error,'code');
      lastSupervisorCode=typeof code==='string'&&ALLOWED.has(code)?code:null;
    }
    // Only an explicit stopped:true proves the process is gone. A launch that never happened needs none.
    if(launched&&threw&&read(error,'stopped')!==true){unconfirmed=true;throw runnerFailure();}
    let line=null;
    if(!threw){
      try{line=frameOf(result);}catch{lastSupervisorCode='INVALID_EVALUATION_RESPONSE';}
    }
    try{await clearUnit(unitName);}catch{throw runnerFailure();}
    if(line===null)throw runnerFailure();
    return {exitCode:0,stdout:line};
  }

  function runChunk(input,callOptions){
    const outcome=execute(input,callOptions);
    const tracked=outcome.then(()=>{},()=>{});
    inFlight.add(tracked);
    void tracked.then(()=>{inFlight.delete(tracked);});
    return outcome;
  }

  /** Resolves when every started chunk finished its supervisor run and its unit bookkeeping. Never rejects. */
  async function settled(){
    while(inFlight.size>0)await Promise.all([...inFlight]);
  }

  return Object.freeze({runChunk,settled,
    get unconfirmed(){return unconfirmed;},
    get lastSupervisorCode(){return lastSupervisorCode;}});
}
