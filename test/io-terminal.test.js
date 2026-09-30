import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalFrame,verifyTerminalIo,inspectCgroupFrozen,inspectMemoryWriteback,quiescenceWindowMs,
  evaluateQuiescence,reconcilePostExit,terminalReadbackDigest,parseCgroupEvents,
  FROZEN_TERMINAL_VERSION,parseMemoryWriteback,createDrainRecorder,buildTerminalDiagnostic,
  parseCentisecs,writebackDrainPlan,DRAIN_POLL_MS,MIN_DRAIN_MS,MAX_DRAIN_MS,STAT_FRESH_MS,BARRIER_BUDGET_MS,
  TAIL_MARGIN_MS,TERMINAL_BUDGET_MS,SPAWN_MARGIN_MS,MAX_RUNTIME_MS,COMMIT_LOCK_TIMEOUT_MS,COMMIT_BOUND_MS,
  TERMINAL_DIAGNOSTIC_VERSION} from '../src/quant-research/io-terminal.js';
import {inspectCgroupIo} from '../src/quant-research/io-controls.js';

test('terminal frame accepts fragmented single JSON result',()=>{
  const frame=new TerminalFrame();
  assert.equal(frame.push(Buffer.from('{"checkpoint":')),null);
  assert.deepEqual(frame.push(Buffer.from('{},"result":null}\n')),{checkpoint:{},result:null});
  assert.equal(frame.complete,true);
});

test('terminal frame rejects invalid, duplicate, extra, and oversized output',()=>{
  for(const bytes of ['{"error":"failed"}\n','{"checkpoint":{},"result":null}\nX',
    '{"checkpoint":{},"result":null}\n{"checkpoint":{},"result":null}\n','[]\n']){
    assert.throws(()=>new TerminalFrame().push(Buffer.from(bytes)),{code:'INVALID_EVALUATION_RESPONSE'});
  }
  const frame=new TerminalFrame();
  frame.push(Buffer.from('{"checkpoint":{},"result":null}\n'));
  assert.throws(()=>frame.push(Buffer.from('X')),{code:'INVALID_EVALUATION_RESPONSE'});
  assert.throws(()=>new TerminalFrame(4).push(Buffer.from('123456')),{code:'EVALUATION_OUTPUT_TOO_LARGE'});
});

test('terminal readback waits pending sample and checks limits, inode, counters, and liveness',async()=>{
  const order=[];
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const readLimits=async()=>{order.push('limits');return {inode:5};};
  const readCounters=async()=>{order.push('counters');return {inode:5,readBytes:11,writeBytes:21};};
  const check=verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),pending,
    readLimits,readCounters,live:()=>true});
  assert.deepEqual(order,[]);
  release();
  assert.deepEqual(await check,{inode:5,readBytes:11,writeBytes:21});
  assert.deepEqual(order,['limits','counters']);
  for(const bad of [
    {readLimits:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}},
    {readLimits:async()=>({inode:6})},
    {readCounters:async()=>({inode:5,readBytes:9,writeBytes:21})},
    {live:()=>false}
  ])await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),
    readLimits,readCounters,live:()=>true,...bad}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  let alive=true;
  await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),
    readLimits,readCounters:async()=>{alive=false;return {inode:5,readBytes:11,writeBytes:21};},
    live:()=>alive}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('terminal readback compares against sample completed while waiting',async()=>{
  let accepted={inode:5,readBytes:10,writeBytes:20};
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const read=verifyTerminalIo({group:'/unit',getIdentity:()=>accepted,pending,
    readLimits:async()=>({inode:5}),readCounters:async()=>({inode:5,readBytes:12,writeBytes:22}),
    live:()=>true});
  accepted={inode:5,readBytes:13,writeBytes:23};
  release();
  await assert.rejects(read,{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('extra output invalidates frame while terminal read is pending',async()=>{
  const frame=new TerminalFrame();
  frame.push(Buffer.from('{"checkpoint":{},"result":null}\n'));
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const read=verifyTerminalIo({group:'/unit',getIdentity:()=>({inode:5,readBytes:10,writeBytes:20}),pending,
    readLimits:async()=>({inode:5}),readCounters:async()=>({inode:5,readBytes:11,writeBytes:21}),
    live:()=>!frame.invalid});
  assert.throws(()=>frame.push(Buffer.from('X')),{code:'INVALID_EVALUATION_RESPONSE'});
  release();
  await assert.rejects(read,{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

test('terminal readback rejects close before limits and abort during counters',async()=>{
  const identity=()=>({inode:5,readBytes:10,writeBytes:20});
  await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:identity,
    readLimits:async()=>({inode:5}),readCounters:async()=>({inode:5,readBytes:11,writeBytes:21}),
    live:()=>false}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
  let aborted=false;
  await assert.rejects(verifyTerminalIo({group:'/unit',getIdentity:identity,
    readLimits:async()=>({inode:5}),readCounters:async()=>{aborted=true;return {inode:5,readBytes:11,writeBytes:21};},
    live:()=>!aborted}),{code:'QUANT_IO_TELEMETRY_UNAVAILABLE'});
});

const unavailable={code:'QUANT_IO_TELEMETRY_UNAVAILABLE'};

test('frozen cgroup requires exact frozen 1 and populated 1',()=>{
  assert.deepEqual(inspectCgroupFrozen('populated 1\nfrozen 1\n'),{populated:1,frozen:1});
  assert.deepEqual(parseCgroupEvents('populated 1\nfrozen 0\n'),{populated:1,frozen:0});
  for(const bad of ['populated 1\nfrozen 0\n','populated 0\nfrozen 1\n','populated 1\n','frozen 1\n','',
    'populated 1\npopulated 1\nfrozen 1\n','populated 1\nfrozen 1\nfrozen 1\n','populated 1\nfrozen 2\n',
    'populated 1\nfrozen one\n','populated  1\nfrozen 1\n',null,undefined])
    assert.throws(()=>inspectCgroupFrozen(bad),unavailable);
});

test('memory writeback gate needs exactly one zero file_dirty and file_writeback row',()=>{
  const stat=(dirty,writeback,extra='')=>`anon 4096\nfile 8192\nfile_dirty ${dirty}\nfile_writeback ${writeback}\n${extra}`;
  assert.deepEqual(inspectMemoryWriteback(stat(0,0)),{fileDirty:0,fileWriteback:0});
  assert.deepEqual(inspectMemoryWriteback(stat(0,0,'workingset_refault_file 0\n')),{fileDirty:0,fileWriteback:0});
  for(const bad of [stat(65536,0),stat(0,4096),stat('abc',0),stat(0,'-1'),stat('00',0),stat('0x0',0),
    'anon 1\nfile_writeback 0\n','anon 1\nfile_dirty 0\n',stat(0,0,'file_dirty 0\n'),
    stat(0,0,'file_writeback 0\n'),'file_dirty\nfile_writeback 0\n','file_dirty 0 0\nfile_writeback 0\n','',null,7])
    assert.throws(()=>inspectMemoryWriteback(bad),unavailable);
});

test('memory.stat parser returns nonzero values and needs exactly one decimal row per key',()=>{
  const stat=(dirty,writeback,extra='')=>`anon 4096\nfile 8192\nfile_dirty ${dirty}\nfile_writeback ${writeback}\n${extra}`;
  assert.deepEqual(parseMemoryWriteback(stat(0,0)),{fileDirty:0,fileWriteback:0});
  assert.deepEqual(parseMemoryWriteback(stat(8192,4096)),{fileDirty:8192,fileWriteback:4096});
  assert.deepEqual(parseMemoryWriteback(stat(65536,0,'workingset_refault_file 7\n')),{fileDirty:65536,fileWriteback:0});
  assert.deepEqual(parseMemoryWriteback(stat(9007199254740991,0)),{fileDirty:9007199254740991,fileWriteback:0});
  for(const bad of [stat('abc',0),stat(0,'-1'),stat('00',0),stat('0x10',0),stat('1.5',0),stat('9007199254740993',0),
    'anon 1\nfile_writeback 0\n','anon 1\nfile_dirty 0\n',stat(8192,0,'file_dirty 0\n'),
    stat(0,0,'file_writeback 0\n'),'file_dirty\nfile_writeback 0\n','file_dirty 0 0\nfile_writeback 0\n','',null,7,undefined])
    assert.throws(()=>parseMemoryWriteback(bad),unavailable);
  // The gate keeps the same API: any nonzero value still fails closed.
  assert.throws(()=>inspectMemoryWriteback(stat(8192,0)),unavailable);
  assert.throws(()=>inspectMemoryWriteback(stat(0,4096)),unavailable);
});

test('drain constants match the FTR-1c design and the exported terminal constants (RD-2)',async()=>{
  assert.deepEqual([DRAIN_POLL_MS,MIN_DRAIN_MS,MAX_DRAIN_MS,STAT_FRESH_MS,BARRIER_BUDGET_MS],
    [500,5000,45000,2500,2000]);
  assert.deepEqual([TAIL_MARGIN_MS,TERMINAL_BUDGET_MS,SPAWN_MARGIN_MS,MAX_RUNTIME_MS,COMMIT_LOCK_TIMEOUT_MS,
    COMMIT_BOUND_MS],[5000,5000,5000,70000,2000,3000]);
  // The jbd2-based settle floor is gone: the drain floor is now the barrier plus STAT_FRESH_MS.
  assert.equal((await import('../src/quant-research/io-terminal.js')).DRAIN_SETTLE_MS,undefined);
  assert.equal(FROZEN_TERMINAL_VERSION,'quant-io-frozen-terminal-v1');
  assert.equal(TERMINAL_DIAGNOSTIC_VERSION,'quant-io-terminal-diagnostic-v2');
});

test('parseCentisecs takes one decimal line with an optional single LF and at most one day',()=>{
  for(const [source,value] of [['0',0],['0\n',0],['1',1],['500\n',500],['3000\n',3000],['3000',3000],
    ['1234567\n',1234567],['8640000\n',8640000],['8640000',8640000]])
    assert.equal(parseCentisecs(source),value,JSON.stringify(source));
  for(const bad of ['','\n','-1','-1\n','1e3','30 00','30 00\n','3000\n\n','3000\n3000\n','3000\r\n','08','00','0x10',
    ' 3000','3000 ','+3000','1.5','12345678','8640001\n','9007199254740993','abc',null,undefined,3000,{},[]])
    assert.throws(()=>parseCentisecs(bad),unavailable,JSON.stringify(bad));
});

test('writebackDrainPlan derives the drain need from the two vm sysctls',()=>{
  const plan=(expire,writeback,drain)=>writebackDrainPlan({expireSource:expire,writebackSource:writeback,
    terminalDrainMs:drain});
  // The recorded host: expire 3000, writeback 500 give barrier 2000 + 30000 + 2 x 5000 + 2500 + 500.
  assert.deepEqual(plan('3000\n','500\n',45000),{expireMs:30000,writebackMs:5000,requiredMs:45000,fits:true});
  assert.equal(plan('3000\n','500\n',44999).fits,false);assert.equal(plan('3000\n','500\n',44999).requiredMs,45000);
  assert.equal(plan('3000\n','500\n',45001).fits,true);
  assert.deepEqual(plan('500\n','100\n',12000),{expireMs:5000,writebackMs:1000,requiredMs:12000,fits:true});
  assert.equal(plan('500','100',11999).fits,false);
  assert.deepEqual(plan('0\n','1\n',5100),{expireMs:0,writebackMs:10,requiredMs:5020,fits:true});
  // A zero writeback interval never wakes the flusher by itself: no bound, never fits.
  assert.deepEqual(plan('3000\n','0\n',45000),{expireMs:30000,writebackMs:0,requiredMs:null,fits:false});
  assert.equal(plan('0','0',45000).fits,false);
  for(const bad of [{expireSource:'',writebackSource:'500\n'},{expireSource:'3000\n',writebackSource:'-1\n'},
    {expireSource:'3000\n',writebackSource:'5 00\n'},{expireSource:null,writebackSource:'500\n'},
    {expireSource:'3000\n'},{writebackSource:'500\n'},{expireSource:'8640001',writebackSource:'500'},
    {expireSource:'3000\n\n',writebackSource:'500\n'}])
    assert.throws(()=>writebackDrainPlan({terminalDrainMs:45000,...bad}),unavailable,JSON.stringify(bad));
  for(const drain of [-1,1.5,'45000',NaN,undefined,null])
    assert.throws(()=>plan('3000\n','500\n',drain),unavailable,String(drain));
  assert.throws(()=>writebackDrainPlan(),unavailable);
});

test('drain recorder keeps counts, maxima, first clean time, and the first and last 16 points',()=>{
  const recorder=createDrainRecorder();
  assert.deepEqual(recorder.snapshot(),{polls:0,maxDirty:0,maxWriteback:0,firstZeroMs:null,series:[]});
  recorder.record(0,4096,0);recorder.record(500.4,0,8192);recorder.record(1000,0,0);recorder.record(1500,0,0);
  assert.deepEqual(recorder.snapshot(),{polls:4,maxDirty:4096,maxWriteback:8192,firstZeroMs:1000,
    series:[[0,4096,0],[500,0,8192],[1000,0,0],[1500,0,0]]});
  const long=createDrainRecorder();
  for(let index=0;index<90;index++)long.record(index*500,4096,0);
  const snapshot=long.snapshot();
  assert.equal(snapshot.polls,90);assert.equal(snapshot.series.length,32);
  assert.deepEqual(snapshot.series.map(point=>point[0]),
    [...Array.from({length:16},(_,index)=>index*500),...Array.from({length:16},(_,index)=>(74+index)*500)]);
  const exact=createDrainRecorder();
  for(let index=0;index<32;index++)exact.record(index,0,4096);
  assert.deepEqual(exact.snapshot().series.map(point=>point[0]),Array.from({length:32},(_,index)=>index));
  assert.throws(()=>recorder.record(0,-1,0),unavailable);assert.throws(()=>recorder.record(0,0,1.5),unavailable);
  assert.throws(()=>recorder.record(0,null,0),unavailable);
  assert.equal(recorder.snapshot().polls,4);
});

test('terminal diagnostic is a frozen integer, boolean and enum record with an exact key set',()=>{
  const drain={enabled:true,durationMs:10000,polls:21,maxDirty:8192,maxWriteback:0,firstZeroMs:null,
    series:[[0,8192,0],[500,8192,0]]};
  const diagnostic=buildTerminalDiagnostic({stage:'DRAIN',fileDirty:8192,fileWriteback:0,memoryReads:21,
    sinceFreezeMs:10000.4,barrierMs:40,requiredDrainMs:45000,drain});
  assert.deepEqual(diagnostic,{version:'quant-io-terminal-diagnostic-v2',stage:'DRAIN',fileDirty:8192,
    fileWriteback:0,memoryReads:21,sinceFreezeMs:10000,barrierMs:40,requiredDrainMs:45000,drain});
  assert.deepEqual(Object.keys(diagnostic),['version','stage','fileDirty','fileWriteback','memoryReads',
    'sinceFreezeMs','barrierMs','requiredDrainMs','drain']);
  // Barrier and requirement are counts or null: an unfinished barrier or an unknown need reads null.
  const unfinished=buildTerminalDiagnostic({stage:'DRAIN',drain});
  assert.equal(unfinished.barrierMs,null);assert.equal(unfinished.requiredDrainMs,null);
  for(const bad of [-1,1.5,'40','/sys/x',NaN,{}]){
    const hostileBarrier=buildTerminalDiagnostic({stage:'DRAIN',barrierMs:bad,requiredDrainMs:bad,drain});
    assert.equal(hostileBarrier.barrierMs,null);assert.equal(hostileBarrier.requiredDrainMs,null);
  }
  assert.ok(Object.isFrozen(diagnostic)&&Object.isFrozen(diagnostic.drain)&&Object.isFrozen(diagnostic.drain.series)&&
    Object.isFrozen(diagnostic.drain.series[0]));
  // Nothing outside the fixed shape survives: extras, strings in number slots, negatives, floats, over-long series.
  const hostile=buildTerminalDiagnostic({stage:'/sys/fs/cgroup/x',fileDirty:'8192',fileWriteback:-1,
    memoryReads:'robot-quant-1',sinceFreezeMs:'12',unitName:'robot-quant-1.service',pid:4242,
    drain:{enabled:true,durationMs:'x',polls:1.5,maxDirty:-2,maxWriteback:null,firstZeroMs:'0',path:'/tmp/x',
      series:Array.from({length:50},(_,index)=>[index,'/etc/passwd',{unit:'x'}])}});
  assert.equal(hostile.stage,'DRAIN');assert.equal(hostile.fileDirty,null);assert.equal(hostile.fileWriteback,null);
  assert.equal(hostile.memoryReads,0);assert.equal(hostile.sinceFreezeMs,0);
  assert.deepEqual(Object.keys(hostile),Object.keys(diagnostic));
  assert.deepEqual(Object.keys(hostile.drain),Object.keys(diagnostic.drain));
  assert.equal(hostile.drain.series.length,32);
  assert.ok(hostile.drain.series.every(point=>point.length===3&&point.every(Number.isSafeInteger)));
  assert.equal(JSON.stringify(hostile).includes('/'),false);
  assert.equal(buildTerminalDiagnostic({stage:'QUIESCENCE'}).stage,'QUIESCENCE');
  assert.equal(buildTerminalDiagnostic().drain.series.length,0);
});

test('quiescence window uses bio size over slowest rate, 250 ms floor, and flags budget overrun',()=>{
  const rates={readBytesPerSecond:524288,writeBytesPerSecond:524288};
  assert.deepEqual(quiescenceWindowMs({maxSectorsKb:1280,rates,budgetMs:5000}),
    {windowMs:2500,maxBioBytes:1310720,overBudget:false});
  assert.deepEqual(quiescenceWindowMs({rates,budgetMs:5000}),
    {windowMs:2500,maxBioBytes:1310720,overBudget:false});
  assert.equal(quiescenceWindowMs({maxSectorsKb:null,rates,budgetMs:5000}).maxBioBytes,1310720);
  const slowWrite={readBytesPerSecond:524288,writeBytesPerSecond:262144};
  assert.equal(quiescenceWindowMs({maxSectorsKb:1280,rates:slowWrite,budgetMs:5000}).windowMs,5000);
  assert.equal(quiescenceWindowMs({maxSectorsKb:1280,rates:slowWrite,budgetMs:5000}).overBudget,false);
  assert.equal(quiescenceWindowMs({maxSectorsKb:1280,rates,budgetMs:2499}).overBudget,true);
  assert.equal(quiescenceWindowMs({maxSectorsKb:4,rates:{readBytesPerSecond:1073741824,
    writeBytesPerSecond:1073741824},budgetMs:5000}).windowMs,250);
  assert.equal(quiescenceWindowMs({maxSectorsKb:1280,rates:{readBytesPerSecond:1024,writeBytesPerSecond:1024},
    budgetMs:5000}).overBudget,true);
  for(const bad of [{maxSectorsKb:0},{maxSectorsKb:-1},{maxSectorsKb:1.5},{maxSectorsKb:'1280'},
    {maxSectorsKb:1048577},{rates:{readBytesPerSecond:0,writeBytesPerSecond:1}},
    {rates:{readBytesPerSecond:1}},{rates:null},{budgetMs:-1},{budgetMs:'5000'},{budgetMs:NaN}])
    assert.throws(()=>quiescenceWindowMs({maxSectorsKb:1280,rates,budgetMs:5000,...bad}),unavailable);
  assert.throws(()=>quiescenceWindowMs(),unavailable);
});

const read=(atMs,readBytes=0,writeBytes=65536,inode=304778)=>({atMs,inode,readBytes,writeBytes});

test('quiescence accepts two equal reads a window apart and otherwise waits or fails closed',()=>{
  const stable=evaluateQuiescence({reads:[read(1000),read(3500)],windowMs:2500,deadlineMs:5000});
  assert.deepEqual(stable,{stable:true,first:read(1000),second:read(3500)});
  assert.equal(evaluateQuiescence({reads:[read(1000),read(3500)],windowMs:2500}).stable,true);
  assert.equal(evaluateQuiescence({reads:[read(1000),read(2000),read(3500)],windowMs:2500,
    last:{readBytes:0,writeBytes:65536}}).first.atMs,1000);
  assert.deepEqual(evaluateQuiescence({reads:[read(1000)],windowMs:2500,deadlineMs:5000}),
    {stable:false,nextReadAtMs:3500});
  assert.deepEqual(evaluateQuiescence({reads:[read(1000),read(2000)],windowMs:2500,deadlineMs:5000}),
    {stable:false,nextReadAtMs:3500});
  // growth restarts the window: pending while time remains, growth at the deadline fails.
  assert.deepEqual(evaluateQuiescence({reads:[read(1000),read(2000,0,131072)],windowMs:2500,deadlineMs:5000}),
    {stable:false,nextReadAtMs:4500});
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(2600,0,131072)],windowMs:2500,deadlineMs:5000}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(3500,0,131072)],windowMs:2500}),unavailable);
  // fewer than two reads, or too little elapsed time without a deadline
  assert.throws(()=>evaluateQuiescence({reads:[read(1000)],windowMs:2500}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(3499)],windowMs:2500}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(3499)],windowMs:2500,deadlineMs:3499}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[],windowMs:2500,deadlineMs:5000}),unavailable);
});

test('quiescence rejects regression, inode change, and reads below the last accepted sample',()=>{
  for(const reads of [
    [read(1000,10,65536),read(3500,9,65536)],[read(1000,10,65536),read(3500,10,65535)],
    [read(1000),read(3500,0,65536,304779)],[read(3500),read(1000)],
    [read(1000,0,65536,0)],[{...read(1000),readBytes:-1}],[{...read(1000),atMs:'1000'}],[{...read(1000),writeBytes:1.5}]])
    assert.throws(()=>evaluateQuiescence({reads,windowMs:2500,deadlineMs:9000}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000,3),read(3500,3)],windowMs:2500,
    last:{readBytes:4,writeBytes:0}}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(3500)],windowMs:2500,
    last:{readBytes:0,writeBytes:65537}}),unavailable);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(3500)],windowMs:2500,
    last:{readBytes:0,writeBytes:0,inode:1}}),unavailable);
  assert.equal(evaluateQuiescence({reads:[read(1000),read(3500)],windowMs:2500,
    last:{readBytes:0,writeBytes:65536,inode:304778}}).stable,true);
  assert.throws(()=>evaluateQuiescence({reads:[read(1000),read(3500)],windowMs:0}),unavailable);
});

test('post-exit disposition accepts only removed or equal retained counters',()=>{
  const frozen={inode:304778,readBytes:0,writeBytes:65536};
  const retained=(patch={})=>({read:{populated:0,inode:304778,readBytes:0,writeBytes:65536,...patch}});
  assert.equal(reconcilePostExit({frozen,read:{error:{code:'ENOENT'}}}),'REMOVED');
  assert.equal(reconcilePostExit({frozen,read:{error:{code:'ENODEV'}}}),'REMOVED');
  assert.equal(reconcilePostExit({frozen,...retained()}),'RETAINED_EQUAL');
  assert.equal(reconcilePostExit({frozen,...retained({writeBytes:69632})}),'TAIL_OBSERVED');
  assert.equal(reconcilePostExit({frozen,...retained({readBytes:4096})}),'TAIL_OBSERVED');
  for(const bad of [{read:{error:{code:'EACCES'}}},{read:{error:{code:'EIO'}}},{read:{error:{}}},{read:{error:null}},
    retained({inode:1}),retained({populated:1}),retained({writeBytes:65535}),retained({readBytes:-1}),
    retained({writeBytes:1.5}),{read:{populated:0}},{read:null},{}])
    assert.equal(reconcilePostExit({frozen,...bad}),'UNKNOWN');
  assert.throws(()=>reconcilePostExit({frozen:{inode:0,readBytes:0,writeBytes:0},read:{error:{code:'ENOENT'}}}),unavailable);
  assert.throws(()=>reconcilePostExit({read:{error:{code:'ENOENT'}}}),unavailable);
});

const digestInput=()=>({jobId:'job-00001',operationId:'operation-00001',unitName:'robot-quant-'+'a'.repeat(64)+'.service',
  group:'/user.slice/robot-quant-'+'a'.repeat(64)+'.service',cgroupInode:304778,invocationId:'1'.repeat(32),pid:4242,
  procStartTicks:'12345',deviceId:'8:0',deviceInode:156,
  reads:[{readBytes:0,writeBytes:65536},{readBytes:0,writeBytes:65536}],
  windowMs:2500,fileDirty:0,fileWriteback:0,freezer:'frozen',postExit:'REMOVED'});

test('terminal readback digest is canonical over the exact required fields',()=>{
  const input=digestInput();
  const digest=terminalReadbackDigest(input);
  assert.match(digest,/^[a-f0-9]{64}$/);
  assert.equal(FROZEN_TERMINAL_VERSION,'quant-io-frozen-terminal-v1');
  // Regression vector recorded at HEAD 366e456 before FTR-1c: the digest bytes and version must not move.
  assert.equal(digest,'5aed3ce0238f37738ec17be617e339eba1d4eca7611ed8366717075c0381f742');
  assert.equal(terminalReadbackDigest(Object.fromEntries(Object.entries(input).reverse())),digest);
  const changes={jobId:'job-00002',operationId:'operation-00002',unitName:'robot-quant-'+'b'.repeat(64)+'.service',
    group:'/user.slice/other',cgroupInode:304779,invocationId:'2'.repeat(32),pid:4243,procStartTicks:'12346',
    deviceId:'8:1',deviceInode:157,reads:[{readBytes:0,writeBytes:65537},{readBytes:0,writeBytes:65537}],
    windowMs:2501,postExit:'RETAINED_EQUAL'};
  const seen=new Set([digest]);
  for(const [key,value] of Object.entries(changes)){
    const changed=terminalReadbackDigest({...digestInput(),[key]:value});
    assert.equal(seen.has(changed),false,key);seen.add(changed);
  }
  for(const bad of [{extra:1},{jobId:undefined},{fileDirty:1},{fileWriteback:1},{freezer:'thawed'},
    {postExit:'TAIL_OBSERVED'},{postExit:'UNKNOWN'},{windowMs:100},{cgroupInode:0},{pid:0},{procStartTicks:'x'},
    {invocationId:'zz'},{deviceId:'8'},{reads:[{readBytes:0,writeBytes:65536}]},
    {reads:[{readBytes:0,writeBytes:65536},{readBytes:0,writeBytes:65537}]},
    {reads:[{readBytes:0,writeBytes:65536,extra:1},{readBytes:0,writeBytes:65536}]}])
    assert.throws(()=>terminalReadbackDigest({...digestInput(),...bad}),unavailable);
  for(const key of Object.keys(input)){
    const missing=digestInput();delete missing[key];
    assert.throws(()=>terminalReadbackDigest(missing),unavailable);
  }
  assert.throws(()=>terminalReadbackDigest(null),unavailable);
  assert.throws(()=>terminalReadbackDigest([]),unavailable);
});

test('all-zero io.stat row prints a bare device and is rejected by the counter parser',()=>{
  const limits={readBytesPerSecond:524288,writeBytesPerSecond:524288};
  const max='8:0 rbps=524288 wbps=524288 riops=max wiops=max\n';
  assert.deepEqual(inspectCgroupIo({max,stat:'8:0 rbytes=0 wbytes=65536 rios=0 wios=1 dbytes=0 dios=0\n',
    device:'8:0',limits}),{readBytes:0,writeBytes:65536});
  assert.throws(()=>inspectCgroupIo({max,stat:'8:0\n',device:'8:0',limits}),unavailable);
});
