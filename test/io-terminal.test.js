import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalFrame,verifyTerminalIo,inspectCgroupFrozen,inspectMemoryWriteback,quiescenceWindowMs,
  evaluateQuiescence,reconcilePostExit,terminalReadbackDigest,parseCgroupEvents,
  FROZEN_TERMINAL_VERSION,parseMemoryWriteback,createDrainRecorder,buildTerminalDiagnostic,
  DRAIN_SETTLE_MS,DRAIN_POLL_MS,MAX_DRAIN_MS,STAT_FRESH_MS,TERMINAL_DIAGNOSTIC_VERSION} from '../src/quant-research/io-terminal.js';
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

test('drain constants match the FTR-1b design',()=>{
  assert.deepEqual([DRAIN_SETTLE_MS,DRAIN_POLL_MS,MAX_DRAIN_MS,STAT_FRESH_MS],[7500,500,45000,2500]);
  assert.equal(FROZEN_TERMINAL_VERSION,'quant-io-frozen-terminal-v1');
  assert.equal(TERMINAL_DIAGNOSTIC_VERSION,'quant-io-terminal-diagnostic-v1');
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
    sinceFreezeMs:10000.4,drain});
  assert.deepEqual(diagnostic,{version:'quant-io-terminal-diagnostic-v1',stage:'DRAIN',fileDirty:8192,
    fileWriteback:0,memoryReads:21,sinceFreezeMs:10000,drain});
  assert.deepEqual(Object.keys(diagnostic),['version','stage','fileDirty','fileWriteback','memoryReads',
    'sinceFreezeMs','drain']);
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
