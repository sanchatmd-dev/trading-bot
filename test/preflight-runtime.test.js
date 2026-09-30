import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PF2_ENGINE_FILES,PF2_EVALUATOR_FILES,pf2ExecutableHashes} from '../src/quant-research/preflight-resolver.js';
import {PF2_SUPERVISOR_CODES,createSupervisedRunner} from '../src/quant-research/preflight-runtime.js';
import {QUANT_IO_MODULES,runQuantProcess} from '../src/quant-research/process-supervisor.js';
import {canonical} from '../src/pine-bridge/source.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MARKER=String.raw`C:\secret-location\marker-4242`;
const UNIT=/^robot-quant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/;
const localPython=resolve(root,'quant_lab','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
// Only an absolute interpreter path is ever spawned (a bare command name can resolve through an installer
// alias). No interpreter means the real-process tests skip with a reason; PF2_REQUIRE_PYTHON=1 makes that a failure.
const configuredPython=process.env.QUANT_RESEARCH_PYTHON;
const python=configuredPython?(path.isAbsolute(configuredPython)?configuredPython:null):
  (existsSync(localPython)?localPython:null);
const probeEnvironment={PYTHONPATH:resolve(root,'quant_lab','src'),PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};
for(const name of ['PATH','SYSTEMROOT','WINDIR','SYSTEMDRIVE','TEMP','TMP','TMPDIR'])
  if(process.env[name])probeEnvironment[name]=process.env[name];
const probe=python===null?null:spawnSync(python,['-B','-s','-c','import robot_quant.pf2_replay'],
  {encoding:'utf8',timeout:180000,env:probeEnvironment});
const pythonReady=probe!==null&&!(probe.error?.code==='ENOENT'||/ModuleNotFoundError|No module named/.test(probe.stderr??''));
const NO_PYTHON=python===null?
  'no absolute python interpreter (set QUANT_RESEARCH_PYTHON to an absolute path or create quant_lab/.venv); the real-process runner test needs one':
  'python runtime or quant dependencies unavailable here; the real-process runner test needs them';
const needPython=st=>{
  if(pythonReady)return false;
  assert.notEqual(process.env.PF2_REQUIRE_PYTHON,'1','PF2_REQUIRE_PYTHON=1: '+NO_PYTHON);
  st.skip(NO_PYTHON);
  return true;
};

const requestOf=value=>Buffer.from(JSON.stringify(value),'utf8');
const gate=()=>{
  let open,fail;
  const promise=new Promise((yes,no)=>{open=yes;fail=no;});
  return {promise,open,fail};
};
const supervisorError=(code,stopped)=>Object.assign(new Error(MARKER),{code,stopped,ioDiagnostic:{marker:MARKER}});
const tick=()=>new Promise(resolveTick=>setImmediate(resolveTick));

/** The only thing a runner failure may show the driver: one fixed code, no message, cause or diagnostic. */
async function rejectsRunner(promise){
  await assert.rejects(promise,error=>{
    assert.equal(error.code,'PF2_RUNNER_FAILED');
    assert.equal(error.message,'PF2_RUNNER_FAILED');
    assert.equal(error.cause,undefined);
    assert.deepEqual(Object.keys(error),['code']);
    assert.equal(JSON.stringify(error).includes('secret'),false);
    return true;
  });
}

/** A runner over recording fakes; `supervisor(launch)` decides each launch. */
function rig(config={}){
  const log=[],launches=[],persisted=[],cleared=[];
  let now=config.now??1_000_000;
  const options={
    deadlineAt:config.deadlineAt??now+600_000,
    clock:()=>now,
    supervisor:async launch=>{
      log.push('spawn');launches.push(launch);
      return config.supervisor?config.supervisor(launch):{checkpoint:{next_bar:1},result:null};
    },
    persistUnit:config.persistUnit??(async unit=>{log.push('persist');persisted.push(unit);}),
    clearUnit:config.clearUnit??(async unit=>{log.push('clear');cleared.push(unit);}),
    ...config.extra
  };
  const runner=createSupervisedRunner(options);
  return {runner,log,launches,persisted,cleared,setNow:value=>{now=value;}};
}

test('PF-2 R4 supervisor I/O module allowlist',async t=>{
  await t.test('exactly research_chunk and pf2_replay, read-only',()=>{
    assert.deepEqual([...QUANT_IO_MODULES].sort(),['robot_quant.pf2_replay','robot_quant.research_chunk']);
    assert.equal(QUANT_IO_MODULES.size,2);
    assert.ok(QUANT_IO_MODULES instanceof Set);
    assert.ok(Object.isFrozen(QUANT_IO_MODULES));
    for(const name of ['robot_quant.research_engine','robot_quant.pf2_replay_x','robot_quant.','robot_quant','',
      'quant_lab.tests.quant_process_probe','ROBOT_QUANT.PF2_REPLAY','robot_quant.pf2_replay '])
      assert.equal(QUANT_IO_MODULES.has(name),false,name);
    assert.throws(()=>QUANT_IO_MODULES.add('robot_quant.research_engine'),TypeError);
    assert.throws(()=>QUANT_IO_MODULES.delete('robot_quant.pf2_replay'),TypeError);
    assert.throws(()=>QUANT_IO_MODULES.clear(),TypeError);
    assert.throws(()=>{QUANT_IO_MODULES.add=()=>{};},TypeError);
    assert.equal(QUANT_IO_MODULES.size,2);
  });

  await t.test('the gate reads the set; no other module name appears in the supervisor source',async()=>{
    const source=await readFile(resolve(root,'src/quant-research/process-supervisor.js'),'utf8');
    assert.ok(source.includes('!QUANT_IO_MODULES.has(module)||!storageBudget'));
    assert.equal(source.includes("module!=='robot_quant.research_chunk'"),false);
    assert.deepEqual([...new Set([...source.matchAll(/robot_quant\.[a-z0-9_]+/g)].map(match=>match[0]))].sort(),
      ['robot_quant.pf2_replay','robot_quant.research_chunk','robot_quant.research_engine']);
  });

  const controls={version:'quant-io-v1',device:'8:0',devicePath:'/dev/test-block',
    main:{readBytesPerSecond:1048576,writeBytesPerSecond:524288},
    evaluator:{readBytesPerSecond:524288,writeBytesPerSecond:262144}};
  await t.test('off Linux ioControls is refused for every module before the gate',
    {skip:process.platform==='linux'&&'Linux host'},async()=>{
      for(const module of [...QUANT_IO_MODULES,'robot_quant.research_engine'])
        await assert.rejects(runQuantProcess({payload:{},module,ioControls:controls,storageBudget:{root:'/nonexistent-quant-root'},
          allowUnsupportedPlatformForTests:true}),
          error=>error.code==='QUANT_IO_ISOLATION_REQUIRED'&&error.stopped===true);
    });

  // No process is spawned: an approved module reaches the readiness storage check (whose error carries a
  // diagnostic) and fails on the missing root; any other module, or no storage budget, stops at the gate first.
  await t.test('on Linux pf2_replay reaches readiness like research_chunk; other modules stop at the gate',
    {skip:process.platform!=='linux'&&'the Linux ioControls path is proved on Linux only (R7)'},async()=>{
      const storageBudget={root:'/nonexistent-quant-root'};
      for(const module of QUANT_IO_MODULES)
        await assert.rejects(runQuantProcess({payload:{},module,ioControls:controls,storageBudget}),error=>{
          assert.equal(error.code,'QUANT_IO_STORAGE_DEVICE_MISMATCH');
          assert.equal(error.stopped,true);
          assert.ok(error.ioDiagnostic);
          return true;
        });
      for(const options of [{module:'robot_quant.research_engine',storageBudget},{module:'robot_quant.pf2_replay'},
        {module:'robot_quant.research_chunk'}])
        await assert.rejects(runQuantProcess({payload:{},ioControls:controls,...options}),error=>{
          assert.equal(error.code,'QUANT_IO_READINESS_CONFIGURATION_REQUIRED');
          assert.equal(error.stopped,true);
          assert.equal(error.ioDiagnostic,undefined);
          return true;
        });
    });
});

test('PF-2 R4 createSupervisedRunner',async t=>{
  await t.test('configuration: injected bookkeeping, clock and deadline are required',()=>{
    const good={deadlineAt:5,clock:()=>0,supervisor:async()=>({}),persistUnit:async()=>{},clearUnit:async()=>{}};
    const runner=createSupervisedRunner(good);
    assert.deepEqual(Object.keys(runner).sort(),['lastSupervisorCode','runChunk','settled','unconfirmed']);
    assert.ok(Object.isFrozen(runner));
    assert.equal(runner.unconfirmed,false);
    assert.equal(runner.lastSupervisorCode,null);
    assert.throws(()=>{runner.unconfirmed=true;},TypeError);
    for(const bad of [undefined,null,'x',{},{...good,persistUnit:undefined},{...good,clearUnit:'x'},{...good,clock:undefined},
      {...good,deadlineAt:undefined},{...good,deadlineAt:'5'},{...good,deadlineAt:NaN},{...good,deadlineAt:Infinity},
      {...good,supervisor:'x'},{...good,supervisor:null}])
      assert.throws(()=>createSupervisedRunner(bad),error=>error.code==='PF2_RUNTIME_CONFIG_INVALID'&&error.message==='PF2_RUNTIME_CONFIG_INVALID');
    assert.throws(()=>createSupervisedRunner({get supervisor(){throw new Error(MARKER);}}),
      error=>error.code==='PF2_RUNTIME_CONFIG_INVALID'&&!error.message.includes('secret'));
    // The supervisor defaults to the real one; the runner is still constructible without it.
    const {supervisor,...withoutSupervisor}=good;void supervisor;
    assert.equal(typeof createSupervisedRunner(withoutSupervisor).runChunk,'function');
  });

  await t.test('launch options: module, payload, bounds and passthrough without I/O controls',async()=>{
    const signal=new AbortController().signal;
    const limits={cpuPercent:25,memoryBytes:256*1024*1024,tasks:8};
    const {runner,launches,persisted}=rig({now:5000,deadlineAt:5000+12345,extra:{python:'/abs/python',limits,
      allowUnsupportedPlatformForTests:true,storageBudget:{root:'/must-not-pass'}}});
    const payload={version:'pf2-replay-chunk-v1',rows:[{time:1,close:'1.5'}],checkpoint:null,contract:{a:[1,2,{b:'x'}]}};
    const answer=await runner.runChunk(requestOf(payload),{signal});
    assert.equal(launches.length,1);
    const [launch]=launches;
    assert.deepEqual(Object.keys(launch).sort(),['allowUnsupportedPlatformForTests','ioControls','ioTerminalProtocol',
      'limits','module','payload','python','signal','storageBudget','timeoutMs','unitName']);
    assert.equal(launch.module,'robot_quant.pf2_replay');
    assert.deepEqual(launch.payload,payload);
    assert.equal(launch.python,'/abs/python');
    assert.equal(launch.limits,limits);
    assert.equal(launch.timeoutMs,12345);
    assert.equal(launch.signal,signal);
    assert.equal(launch.allowUnsupportedPlatformForTests,true);
    assert.equal(launch.ioControls,undefined);
    assert.equal(launch.ioTerminalProtocol,undefined);
    assert.equal(launch.storageBudget,undefined);
    assert.match(launch.unitName,UNIT);
    assert.deepEqual(persisted,[launch.unitName]);
    assert.equal(answer.exitCode,0);
  });

  await t.test('launch options: I/O controls select the terminal protocol and the storage budget',async()=>{
    const ioControls={version:'quant-io-v1'};
    const storageBudget={root:'/budget'};
    const {runner,launches}=rig({extra:{ioControls,storageBudget}});
    await runner.runChunk(requestOf({a:1}));
    assert.equal(launches[0].ioControls,ioControls);
    assert.equal(launches[0].ioTerminalProtocol,'quant-io-terminal-v1');
    assert.equal(launches[0].storageBudget,storageBudget);
    assert.equal(launches[0].signal,undefined);
  });

  await t.test('input: only UTF-8 JSON object bytes run; anything else is a runner failure before any write or spawn',async()=>{
    const {runner,log}=rig();
    const cases=[undefined,null,'{"a":1}',{a:1},[1],Buffer.from('not json'),Buffer.from(''),Buffer.from('[1]'),
      Buffer.from('null'),Buffer.from('7'),Buffer.from('"x"'),Buffer.from([0x7b,0xff,0x7d]),
      Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{}')]),Buffer.from('{"a":1}{"a":2}')];
    for(const input of cases)await rejectsRunner(runner.runChunk(input));
    assert.deepEqual(log,[]);
    assert.equal(runner.unconfirmed,false);
    assert.equal(runner.lastSupervisorCode,null);
    await runner.settled();
    // A Uint8Array that is not a Buffer is accepted the same way.
    await runner.runChunk(new Uint8Array(Buffer.from('{"a":1}')));
    assert.deepEqual(log,['persist','spawn','clear']);
  });

  await t.test('order: the unit is persisted before the launch and cleared after the supervisor settled',async()=>{
    const persist=gate(),run=gate(),clear=gate();
    const events=[],unitsPersisted=[],unitsCleared=[];
    const {runner,launches}=rig({
      persistUnit:async unit=>{events.push('persist-start');await persist.promise;events.push('persist-done');unitsPersisted.push(unit);},
      supervisor:async()=>{events.push('supervisor-start');await run.promise;events.push('supervisor-done');return {result:null};},
      clearUnit:async unit=>{events.push('clear-start');await clear.promise;events.push('clear-done');unitsCleared.push(unit);}
    });
    const outcome=runner.runChunk(requestOf({a:1}));
    let done=false;outcome.then(()=>{done=true;},()=>{done=true;});
    await tick();
    assert.deepEqual(events,['persist-start']);
    assert.equal(launches.length,0);
    persist.open();await tick();
    assert.deepEqual(events,['persist-start','persist-done','supervisor-start']);
    await tick();
    assert.equal(done,false);
    run.open();await tick();
    assert.deepEqual(events,['persist-start','persist-done','supervisor-start','supervisor-done','clear-start']);
    assert.equal(done,false);  // The driver gets its answer only after the unit is cleared.
    clear.open();
    const answer=await outcome;
    assert.equal(answer.exitCode,0);
    assert.deepEqual(unitsPersisted,unitsCleared);
    assert.equal(unitsPersisted.length,1);
    assert.equal(launches[0].unitName,unitsPersisted[0]);
  });

  await t.test('persist failure: no launch, no clear, one fixed failure, nothing tracked',async()=>{
    for(const persistUnit of [async()=>{throw new Error(MARKER);},()=>{throw new Error(MARKER);},()=>Promise.reject(MARKER)]){
      const {runner,launches,cleared}=rig({persistUnit});
      await rejectsRunner(runner.runChunk(requestOf({a:1})));
      assert.equal(launches.length,0);
      assert.equal(cleared.length,0);
      assert.equal(runner.unconfirmed,false);
      assert.equal(runner.lastSupervisorCode,null);
      await runner.settled();
    }
  });

  await t.test('success: the driver line is canonical JSON plus one newline, after the clear',async()=>{
    const result={result:null,checkpoint:{version:'pf2-replay-chunk-v1',next_bar:1000,counters:{b:2,a:{z:1,y:'0.10'}},list:[3,{q:1,p:2}]}};
    const {runner,log,persisted,cleared}=rig({supervisor:async()=>result});
    const answer=await runner.runChunk(requestOf({a:1}));
    assert.deepEqual(Object.keys(answer).sort(),['exitCode','stdout']);
    assert.equal(answer.exitCode,0);
    assert.ok(Buffer.isBuffer(answer.stdout));
    const text=answer.stdout.toString('utf8');
    assert.equal(text,canonical(result)+'\n');
    assert.equal(text,'{"checkpoint":{"counters":{"a":{"y":"0.10","z":1},"b":2},"list":[3,{"p":2,"q":1}],"next_bar":1000,'+
      '"version":"pf2-replay-chunk-v1"},"result":null}\n');
    assert.deepEqual(JSON.parse(text),result);
    assert.deepEqual(log,['persist','spawn','clear']);
    assert.deepEqual(cleared,persisted);
    assert.equal(runner.unconfirmed,false);
    assert.equal(runner.lastSupervisorCode,null);
    await runner.settled();
  });

  await t.test('failure with proof of stop: unit cleared, fixed failure, allowlisted code kept',async()=>{
    assert.equal(PF2_SUPERVISOR_CODES.length,13);
    assert.ok(Object.isFrozen(PF2_SUPERVISOR_CODES));
    assert.deepEqual([...PF2_SUPERVISOR_CODES].sort(),['EVALUATION_FAILED','EVALUATION_OUTPUT_TOO_LARGE','EVALUATION_TIMED_OUT',
      'INVALID_EVALUATION_RESPONSE','QUANT_IO_GATE_FAILED','QUANT_IO_READINESS_CLEANUP_FAILED',
      'QUANT_IO_READINESS_CONFIGURATION_REQUIRED','QUANT_IO_STORAGE_DEVICE_MISMATCH','QUANT_IO_TELEMETRY_UNAVAILABLE',
      'QUANT_PROCESS_STOP_UNCONFIRMED','QUANT_PYTHON_UNAVAILABLE','RESEARCH_INTERRUPTED','RESEARCH_REQUEST_TOO_LARGE']);
    for(const code of PF2_SUPERVISOR_CODES.filter(item=>item!=='QUANT_PROCESS_STOP_UNCONFIRMED')){
      const {runner,log,persisted,cleared}=rig({supervisor:async()=>{throw supervisorError(code,true);}});
      await rejectsRunner(runner.runChunk(requestOf({a:1})));
      assert.equal(runner.lastSupervisorCode,code);
      assert.equal(runner.unconfirmed,false,code);
      assert.deepEqual(log,['persist','spawn','clear'],code);
      assert.deepEqual(cleared,persisted);
      await runner.settled();
    }
  });

  await t.test('failure codes outside the allowlist are dropped, never echoed',async()=>{
    let next=null;
    const {runner,cleared}=rig({supervisor:async()=>{throw next;}});
    for(const code of ['INVALID_QUANT_PROCESS_REQUEST','QUANT_OS_ISOLATION_REQUIRED','INVALID_QUANT_PROCESS_LIMITS',MARKER,
      '','evaluation_failed','EVALUATION_FAILED ',7,null,undefined,{},['EVALUATION_FAILED']]){
      next=Object.assign(new Error(MARKER),{code,stopped:true});
      await rejectsRunner(runner.runChunk(requestOf({a:1})));
      assert.equal(runner.lastSupervisorCode,null,String(code));
    }
    // The latest failure decides: an old allowlisted code is not carried into a later, unreportable failure.
    next=supervisorError('EVALUATION_TIMED_OUT',true);
    await rejectsRunner(runner.runChunk(requestOf({a:1})));
    assert.equal(runner.lastSupervisorCode,'EVALUATION_TIMED_OUT');
    next=supervisorError('SOMETHING_ELSE',true);
    await rejectsRunner(runner.runChunk(requestOf({a:1})));
    assert.equal(runner.lastSupervisorCode,null);
    assert.equal(cleared.length,14);
    assert.equal(runner.unconfirmed,false);
  });

  await t.test('stop unconfirmed: the unit stays persisted, the runner is marked and refuses further launches',async()=>{
    const {runner,log,persisted,cleared,launches}=rig({supervisor:async()=>{throw supervisorError('QUANT_PROCESS_STOP_UNCONFIRMED',false);}});
    await rejectsRunner(runner.runChunk(requestOf({a:1})));
    assert.equal(runner.unconfirmed,true);
    assert.equal(runner.lastSupervisorCode,'QUANT_PROCESS_STOP_UNCONFIRMED');
    assert.deepEqual(log,['persist','spawn']);
    assert.equal(persisted.length,1);
    assert.equal(cleared.length,0);
    // A later launch would overwrite the persisted unit name that recovery needs: it never starts.
    await rejectsRunner(runner.runChunk(requestOf({a:2})));
    assert.deepEqual(log,['persist','spawn']);
    assert.equal(launches.length,1);
    assert.equal(runner.unconfirmed,true);
    await runner.settled();
  });

  await t.test('only an explicit stopped:true proves the process is gone',async()=>{
    const shapes=[{stopped:false},{},{stopped:undefined},{stopped:'true'},{stopped:1},{stopped:null}];
    for(const shape of shapes){
      const {runner,cleared}=rig({supervisor:async()=>{throw Object.assign(new Error(MARKER),{code:'EVALUATION_FAILED'},shape);}});
      await rejectsRunner(runner.runChunk(requestOf({a:1})));
      assert.equal(runner.unconfirmed,true,JSON.stringify(shape));
      assert.equal(runner.lastSupervisorCode,'EVALUATION_FAILED');
      assert.equal(cleared.length,0);
    }
    for(const thrown of [undefined,null,MARKER,7,{code:'EVALUATION_FAILED'}]){
      const {runner,cleared}=rig({supervisor:async()=>{throw thrown;}});
      await rejectsRunner(runner.runChunk(requestOf({a:1})));
      assert.equal(runner.unconfirmed,true);
      assert.equal(cleared.length,0);
    }
    const hostile={get code(){throw new Error(MARKER);},get stopped(){throw new Error(MARKER);}};
    const {runner,cleared}=rig({supervisor:async()=>{throw hostile;}});
    await rejectsRunner(runner.runChunk(requestOf({a:1})));
    assert.equal(runner.unconfirmed,true);
    assert.equal(runner.lastSupervisorCode,null);
    assert.equal(cleared.length,0);
    // A supervisor that throws before returning a promise is the same failure.
    const sync=createSupervisedRunner({deadlineAt:10,clock:()=>0,persistUnit:async()=>{},clearUnit:async()=>{},
      supervisor:()=>{throw supervisorError('EVALUATION_FAILED',true);}});
    await rejectsRunner(sync.runChunk(requestOf({a:1})));
    assert.equal(sync.lastSupervisorCode,'EVALUATION_FAILED');
  });

  await t.test('a result that is not a JSON object is an invalid response, after the stop proof',async()=>{
    for(const value of [undefined,null,'text',7,true,[1],[]]){
      const {runner,log}=rig({supervisor:async()=>value});
      await rejectsRunner(runner.runChunk(requestOf({a:1})));
      assert.equal(runner.lastSupervisorCode,'INVALID_EVALUATION_RESPONSE');
      assert.equal(runner.unconfirmed,false);
      assert.deepEqual(log,['persist','spawn','clear']);
    }
  });

  await t.test('clear failure: a fixed failure even after a good result; the unit stays for recovery',async()=>{
    const failing=async()=>{throw new Error(MARKER);};
    const {runner,log}=rig({clearUnit:failing,supervisor:async()=>({result:null,checkpoint:{next_bar:1}})});
    await rejectsRunner(runner.runChunk(requestOf({a:1})));
    assert.deepEqual(log,['persist','spawn']);
    assert.equal(runner.unconfirmed,false);
    await runner.settled();
    const failed=rig({clearUnit:failing,supervisor:async()=>{throw supervisorError('EVALUATION_TIMED_OUT',true);}});
    await rejectsRunner(failed.runner.runChunk(requestOf({a:1})));
    assert.equal(failed.runner.lastSupervisorCode,'EVALUATION_TIMED_OUT');
    assert.equal(failed.runner.unconfirmed,false);
  });

  await t.test('timeoutMs: min(30 s, max(100 ms, time left to the deadline)), read at each launch',async()=>{
    for(const [left,expected] of [[-5000,100],[0,100],[50,100],[100,100],[101,101],[5000,5000],[29999,29999],[30000,30000],
      [30001,30000],[900000,30000],[1234.9,1234]]){
      const {runner,launches}=rig({now:2000,deadlineAt:2000+left});
      await runner.runChunk(requestOf({a:1}));
      assert.equal(launches[0].timeoutMs,expected,String(left));
    }
    const {runner,launches,setNow}=rig({now:0,deadlineAt:60000});
    await runner.runChunk(requestOf({a:1}));
    setNow(45000);
    await runner.runChunk(requestOf({a:1}));
    setNow(59950);
    await runner.runChunk(requestOf({a:1}));
    assert.deepEqual(launches.map(launch=>launch.timeoutMs),[30000,15000,100]);
  });

  await t.test('a failing clock is a runner failure before any launch; the persisted unit is cleared',async()=>{
    let calls=0;
    const {runner,log}=rig({extra:{clock:()=>{if(++calls>0)throw new Error(MARKER);return 0;}}});
    await rejectsRunner(runner.runChunk(requestOf({a:1})));
    assert.deepEqual(log,['persist','clear']);
    assert.equal(runner.unconfirmed,false);
    assert.equal(runner.lastSupervisorCode,null);
  });

  await t.test('signal: the caller signal goes to the supervisor untouched, even a pre-aborted one',async()=>{
    const controller=new AbortController();
    controller.abort();
    const {runner,launches}=rig({supervisor:async launch=>{
      if(launch.signal?.aborted)throw supervisorError('RESEARCH_INTERRUPTED',true);
      return {result:null};
    }});
    await rejectsRunner(runner.runChunk(requestOf({a:1}),{signal:controller.signal}));
    assert.equal(launches[0].signal,controller.signal);
    assert.equal(runner.lastSupervisorCode,'RESEARCH_INTERRUPTED');
    await runner.runChunk(requestOf({a:1}),{});
    await runner.runChunk(requestOf({a:1}),null);
    await runner.runChunk(requestOf({a:1}),{get signal(){throw new Error(MARKER);}});
    assert.deepEqual(launches.slice(1).map(launch=>launch.signal),[undefined,undefined,undefined]);
  });

  await t.test('settled(): waits for the whole launch even after the driver stopped waiting',async()=>{
    const {runner:idle}=rig();
    await idle.settled();
    const persist=gate(),run=gate(),clear=gate();
    const {runner,log}=rig({persistUnit:async()=>{log.push('persist');await persist.promise;},
      supervisor:async()=>{await run.promise;return {result:null};},
      clearUnit:async()=>{log.push('clear');await clear.promise;}});
    void runChunkAndForget(runner);   // The driver returned; nobody awaits this call any more.
    let settled=false;
    const waiting=runner.settled().then(()=>{settled=true;});
    await tick();
    assert.equal(settled,false);      // Persist pending: a launch is still possible.
    persist.open();await tick();
    assert.equal(settled,false);      // Supervisor running.
    run.open();await tick();
    assert.equal(settled,false);      // Unit not cleared yet.
    clear.open();await waiting;
    assert.equal(settled,true);
    assert.deepEqual(log,['persist','spawn','clear']);
  });

  await t.test('settled(): waits for every tracked launch, including ones that start while it waits',async()=>{
    const first=gate(),second=gate();
    const order=[];
    let launches=0;
    const {runner}=rig({supervisor:async()=>{
      const mine=++launches;
      await (mine===1?first:second).promise;
      order.push(mine);
      if(mine===1)throw supervisorError('EVALUATION_FAILED',true);
      return {result:null};
    }});
    void runChunkAndForget(runner);
    let settled=false;
    const waiting=runner.settled().then(()=>{settled=true;});
    await tick();
    void runChunkAndForget(runner);   // Started after settled() began waiting.
    await tick();
    first.open();await tick();
    assert.equal(settled,false);
    second.open();await waiting;
    assert.deepEqual(order,[1,2]);
    assert.equal(runner.lastSupervisorCode,'EVALUATION_FAILED');
    await runner.settled();
  });

  await t.test('an abandoned failing launch never becomes an unhandled rejection',async()=>{
    const seen=[];
    const listener=reason=>seen.push(reason);
    process.on('unhandledRejection',listener);
    try{
      const {runner}=rig({supervisor:async()=>{throw supervisorError('EVALUATION_FAILED',false);}});
      void runChunkAndForget(runner);
      await runner.settled();
      await tick();await tick();
      assert.deepEqual(seen,[]);
      assert.equal(runner.unconfirmed,true);
    }finally{process.off('unhandledRejection',listener);}
  });
});

function runChunkAndForget(runner){
  // Deliberately drops the promise: settled() and the runner's own bookkeeping must carry the launch alone.
  return runner.runChunk(requestOf({a:1}));
}

test('PF-2 R4 module boundaries and engine identity',async t=>{
  await t.test('preflight-runtime.js imports only source.js, process-supervisor.js and node:crypto',async()=>{
    const text=await readFile(resolve(root,'src/quant-research/preflight-runtime.js'),'utf8');
    const imports=[...text.matchAll(/^import\s.*?from\s*'([^']+)'/gm)].map(match=>match[1]).sort();
    assert.deepEqual(imports,['../pine-bridge/source.js','./process-supervisor.js','node:crypto']);
    assert.equal(/\bimport\s*\(|\brequire\s*\(/.test(text),false);
    for(const file of ['src/quant-research/preflight-runtime.js','src/quant-research/process-supervisor.js',
      'quant_lab/src/robot_quant/pf2_replay.py','test/preflight-runtime.test.js']){
      const lines=(await readFile(resolve(root,file),'utf8')).replace(/\r\n/g,'\n');
      assert.equal(lines.includes('\r'),false,file+' CR');
      assert.equal(/[ \t]+$/m.test(lines),false,file+' trailing whitespace');
    }
  });

  await t.test('the PF-2 engine hash covers the runner files and the evaluator hash does not move with them',async()=>{
    const added=['src/quant-research/io-controls.js','src/quant-research/io-terminal.js',
      'src/quant-research/preflight-runtime.js','src/quant-research/process-supervisor.js'];
    for(const file of added)assert.ok(PF2_ENGINE_FILES.includes(file),file);
    assert.equal(PF2_EVALUATOR_FILES.some(file=>file.startsWith('src/')),false);
    const base=await pf2ExecutableHashes({readFile:url=>readFile(url)});
    assert.match(base.engine_hash,/^[0-9a-f]{64}$/);
    for(const file of [...added,'quant_lab/src/robot_quant/pf2_replay.py']){
      const changed=await pf2ExecutableHashes({readFile:async url=>{
        const bytes=await readFile(url);
        return url.pathname.endsWith('/'+file)?Buffer.concat([bytes,Buffer.from('\n')]):bytes;
      }});
      assert.notEqual(changed.engine_hash,base.engine_hash,file);
      assert.equal(changed.evaluator_hash,base.evaluator_hash,file);
    }
  });
});

// Real interpreter and real supervisor (allowUnsupportedPlatformForTests, no ioControls). The Linux
// ioControls terminal path for pf2_replay is not exercised here; it is proved in R7.
test('PF-2 R4 real process through runQuantProcess',async t=>{
  const bookkeeping=()=>{
    const events=[];
    return {events,persistUnit:async unit=>{events.push(['persist',unit]);},clearUnit:async unit=>{events.push(['clear',unit]);}};
  };
  const realRunner=(extra,book)=>createSupervisedRunner({python,allowUnsupportedPlatformForTests:true,
    deadlineAt:Date.now()+120000,clock:Date.now,persistUnit:book.persistUnit,clearUnit:book.clearUnit,...extra});
  const probeModule=launch=>runQuantProcess({...launch,module:'quant_lab.tests.quant_process_probe'});

  await t.test('a real run returns its JSON result as one canonical driver line and leaves no process',async st=>{
    if(needPython(st))return;
    const book=bookkeeping();
    const runner=realRunner({supervisor:probeModule},book);
    const answer=await runner.runChunk(requestOf({mode:'ok'}));
    const text=answer.stdout.toString('utf8');
    const parsed=JSON.parse(text);
    assert.equal(answer.exitCode,0);
    assert.equal(parsed.ok,true);
    assert.equal(parsed.thread_limit,'1');
    assert.equal(text,canonical(parsed)+'\n');
    assert.deepEqual(book.events.map(event=>event[0]),['persist','clear']);
    assert.equal(book.events[0][1],book.events[1][1]);
    assert.match(book.events[0][1],UNIT);
    assert.equal(runner.unconfirmed,false);
    await runner.settled();
    assert.throws(()=>process.kill(parsed.pid,0),error=>error.code==='ESRCH');
  });

  await t.test('a real timeout and a real abort end with a verified stop and a cleared unit',async st=>{
    if(needPython(st))return;
    const book=bookkeeping();
    const slow=realRunner({supervisor:probeModule,deadlineAt:Date.now()+700},book);
    await rejectsRunner(slow.runChunk(requestOf({mode:'sleep'})));
    assert.equal(slow.lastSupervisorCode,'EVALUATION_TIMED_OUT');
    assert.equal(slow.unconfirmed,false);
    const controller=new AbortController();
    const aborted=realRunner({supervisor:probeModule},book);
    const pending=aborted.runChunk(requestOf({mode:'sleep'}),{signal:controller.signal});
    setTimeout(()=>controller.abort(),500);
    await rejectsRunner(pending);
    assert.equal(aborted.lastSupervisorCode,'RESEARCH_INTERRUPTED');
    await Promise.all([slow.settled(),aborted.settled()]);
    assert.deepEqual(book.events.map(event=>event[0]),['persist','clear','persist','clear']);
  });

  await t.test('the real pf2_replay module starts under the supervisor and an invalid request fails closed',async st=>{
    if(needPython(st))return;
    const body={version:'pf2-replay-chunk-v1',contract:{},rows:[],checkpoint:null};
    // Same module, working directory and source path as the supervisor uses; no I/O protocol variable is set.
    const env={...process.env,PYTHONPATH:resolve(root,'quant_lab/src')+path.delimiter+root};
    for(const name of Object.keys(env))if(name.startsWith('QUANT_IO_'))delete env[name];
    const direct=spawnSync(python,['-m','robot_quant.pf2_replay'],{cwd:root,env,input:JSON.stringify(body),timeout:120000});
    assert.equal(direct.status,1);
    assert.equal(direct.stdout.toString('utf8'),'{"error":"PF2_REQUEST_INVALID"}\n');
    const book=bookkeeping();
    const runner=realRunner({},book);
    await rejectsRunner(runner.runChunk(requestOf(body)));
    assert.equal(runner.lastSupervisorCode,'EVALUATION_FAILED');
    assert.equal(runner.unconfirmed,false);
    assert.deepEqual(book.events.map(event=>event[0]),['persist','clear']);
    await runner.settled();
  });
});
