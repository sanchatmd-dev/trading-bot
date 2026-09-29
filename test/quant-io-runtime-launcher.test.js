import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {
  inspectIoRuntimeUnit,inspectIoRuntimeDevice,inspectIoRuntimeProc,
  inspectIoRuntimeMembership,
  inspectIoRuntimeReceipt,inspectIoRuntimeScratch,createIoRuntimeLauncher,
} from '../src/quant-research/io-runtime-launcher.js';
import {terminalReadbackDigest} from '../src/quant-research/io-terminal.js';

const unitName='robot-quant-'+'a'.repeat(64)+'.service';
const group='/user.slice/'+unitName;
const invocationId='1'.repeat(32);
const unit=`LoadState=loaded\nActiveState=active\nMainPID=4242\nControlGroup=${group}\nInvocationID=${invocationId}\n`;

test('registered active unit has one expected cgroup and live PID',()=>{
  assert.deepEqual(inspectIoRuntimeUnit(unit,unitName),{group,pid:4242,invocationId});
  for(const invalid of [unit.replace('active','inactive'),unit.replace('MainPID=4242','MainPID=0'),
    unit.replace(group,'/user.slice/unrelated.service'),unit.replace(invocationId,'not-an-invocation'),
    unit.replace(group,'/user.slice/robot-quant-'+'f'.repeat(64)+'.service/'+unitName)])
    assert.throws(()=>inspectIoRuntimeUnit(invalid,unitName),{code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
});

test('block device identity uses kernel rdev major/minor and inode',()=>{
  const block={isBlockDevice:()=>true,ino:17,rdev:2048,dev:9};
  assert.deepEqual(inspectIoRuntimeDevice(block,'8:0'),
    {deviceId:'8:0',deviceInode:17,rdev:2048,dev:9});
  for(const invalid of [{...block,rdev:2049},{...block,ino:0},
    {...block,isBlockDevice:()=>false}])
    assert.throws(()=>inspectIoRuntimeDevice(invalid,'8:0'),
      {code:'QUANT_IO_DEVICE_IDENTITY_MISMATCH'});
});

test('process start tick and exact unified cgroup membership are required',()=>{
  const fields=Array(20).fill('1');fields[19]='98765';
  const proc=`4242 (probe worker) ${fields.join(' ')}`;
  assert.equal(inspectIoRuntimeProc(proc,4242),'98765');
  assert.equal(inspectIoRuntimeMembership(`0::${group}\n`,group),group);
  assert.throws(()=>inspectIoRuntimeProc(proc,4243),{code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
  assert.throws(()=>inspectIoRuntimeProc(proc.replace('98765','x'),4242),
    {code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
  assert.throws(()=>inspectIoRuntimeMembership('0::/user.slice/other.service',group),
    {code:'QUANT_IO_IDENTITY_UNAVAILABLE'});
});

test('receipt requires release and exact fixed child output',()=>{
  const marker='QUANT_IO_DIAGNOSTIC_ACCEPTED_V1 292f32a95cc6db3ea98a386e65ee162d977317c73530f9947f8e0628c80d472c\n';
  assert.equal(inspectIoRuntimeReceipt(marker.slice(0,30),true),false);
  assert.equal(inspectIoRuntimeReceipt(marker,true),true);
  for(const [output,released] of [[marker,false],[marker+'extra',true],
    [marker.replace('ACCEPTED','WRONG'),true]])
    assert.throws(()=>inspectIoRuntimeReceipt(output,released),{code:'QUANT_IO_LAUNCH_UNCERTAIN'});
});

test('scratch cleanup accepts only same regular 4 KiB inode',()=>{
  const file={isFile:()=>true,isSymbolicLink:()=>false,size:4096,dev:3,ino:17};
  const original=inspectIoRuntimeScratch(file);
  assert.deepEqual(original,{dev:3,ino:17});
  for(const changed of [{...file,ino:18},{...file,size:4095},
    {...file,isSymbolicLink:()=>true},{...file,isFile:()=>false}])
    assert.throws(()=>inspectIoRuntimeScratch(changed,original),
      {code:'QUANT_IO_READINESS_CLEANUP_FAILED'});
  assert.throws(()=>inspectIoRuntimeScratch(null,original),
    {code:'QUANT_IO_READINESS_CLEANUP_FAILED'});
});

// ---- FTR-1 terminate(): injected host, no Linux, systemd or cgroup access ----
const controls={version:'quant-io-v1',device:'8:0',devicePath:'/dev/sda',
  main:{readBytesPerSecond:1048576,writeBytesPerSecond:1048576},
  evaluator:{readBytesPerSecond:524288,writeBytesPerSecond:524288}};
const cgroupGroup='/user.slice/user-1000.slice/user@1000.service/app.slice/'+unitName;
const cgroupBase='/sys/fs/cgroup'+cgroupGroup;
const enoent=path=>Object.assign(new Error('ENOENT '+path),{code:'ENOENT'});

/** Scriptable Linux host. phase: live, frozen, stopped. */
function fakeHost(options={}){
  const host={phase:'live',now:0,log:[],removed:true,
    counters:{read:0,write:65536},dirty:0,writeback:0,inode:304778,startTicks:'12345',
    freezeCode:0,freezerReported:null,eventsStuck:false,maxSectors:'1280\n',stopResult:true,
    retained:null,afterSleep:null,rate:524288,memoryStat:null,events:null,...options};
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),
    stdout:new PassThrough(),stderr:new PassThrough(),
    kill(signal){host.log.push('child.kill '+signal);host.closeChild();return true;}});
  host.child=child;
  host.closeChild=()=>{if(!host.childClosed){host.childClosed=true;child.emit('close',255);}};
  const unitShow=`LoadState=loaded\nActiveState=active\nMainPID=4242\nControlGroup=${cgroupGroup}\nInvocationID=${invocationId}\n`;
  const gone=path=>host.phase==='stopped'&&!host.retained&&!path.startsWith('/dev/');
  const at=value=>typeof value==='function'?value(host.now):value;
  const stat=()=>`8:0 rbytes=${host.counters.read} wbytes=${host.counters.write} rios=0 wios=1 dbytes=0 dios=0\n`;
  const files={
    '/sys/dev/block/8:0/queue/max_sectors_kb':()=>{if(host.maxSectors===null)throw enoent('max_sectors_kb');return host.maxSectors;},
    '/proc/4242/stat':()=>{const fields=Array(20).fill('1');fields[0]='S';fields[19]=host.startTicks;return `4242 (worker) ${fields.join(' ')}`;},
    '/proc/4242/cgroup':()=>`0::${cgroupGroup}\n`,
    [cgroupBase+'/io.max']:()=>`8:0 rbps=${host.rate} wbps=${host.rate} riops=max wiops=max\n`,
    [cgroupBase+'/io.stat']:()=>host.zeroRow&&host.counters.read===0&&host.counters.write===0?'8:0\n':stat(),
    // dirty, writeback, memoryStat and events may be numbers/strings or functions of the fake clock.
    [cgroupBase+'/cgroup.events']:()=>host.events!==null?at(host.events):host.phase==='stopped'?
      `populated 0\nfrozen ${host.retained?1:0}\n`:
      `populated 1\nfrozen ${host.phase==='frozen'&&!host.eventsStuck?1:0}\n`,
    [cgroupBase+'/memory.stat']:()=>{
      if(host.memoryStat!==null)return at(host.memoryStat);
      return `anon 4096\nfile 8192\nfile_dirty ${at(host.dirty)}\nfile_writeback ${at(host.writeback)}\n`;
    },
    [cgroupBase+'/cpu.max']:()=>'50000 100000\n',[cgroupBase+'/memory.max']:()=>'536870912\n',
    [cgroupBase+'/pids.max']:()=>'16\n'};
  host.seams={
    clock:()=>host.now,
    async sleep(ms){host.log.push('sleep '+ms);host.now+=ms;host.afterSleep?.(ms);},
    spawn:()=>child,
    async command(file,args){
      const text=file+' '+args.join(' ');host.log.push('command '+text);
      if(args[0]==='--user'&&args[1]==='freeze'){
        if(host.freezeCode===0)host.phase='frozen';
        return {code:host.freezeCode,output:''};
      }
      if(text.includes('--property=FreezerState'))
        return {code:0,output:`FreezerState=${host.freezerReported??(host.phase==='frozen'?'frozen':'running')}\n`};
      if(args[1]==='list-jobs')return {code:0,output:''};
      if(args[1]==='show'&&host.phase!=='stopped')return {code:0,output:unitShow};
      return {code:0,output:'LoadState=not-found\nActiveState=inactive\n'};
    },
    async readFile(path){
      host.log.push('read '+path);
      if(gone(path)||!Object.hasOwn(files,path)&&!host.retained)throw enoent(path);
      if(host.phase==='stopped'&&host.retained&&path.startsWith(cgroupBase)){
        if(path.endsWith('/io.stat'))return `8:0 rbytes=${host.retained.read} wbytes=${host.retained.write} rios=0 wios=1 dbytes=0 dios=0\n`;
      }
      if(!Object.hasOwn(files,path))throw enoent(path);
      return files[path]();
    },
    async stat(path){
      host.log.push('stat '+path);
      if(path==='/dev/sda')return {isBlockDevice:()=>true,ino:156,rdev:2048,dev:9};
      if(gone(path))throw enoent(path);
      return {ino:host.phase==='stopped'&&host.retained?host.retained.inode:host.inode};
    },
    async stopUnit(name){
      host.log.push('stopUnit '+name);
      host.phase='stopped';host.closeChild();return host.stopResult;
    }};
  return host;
}
const bound={unitName,group:cgroupGroup,pid:4242,procStartTicks:'12345',cgroupInode:304778,deviceId:'8:0',
  deviceInode:156,invocationId};
async function terminateWith(host,{timeoutMs=30000,terminate={},launcher:launcherOptions={},ioControls=controls}={}){
  const launcher=createIoRuntimeLauncher({ioControls,timeoutMs,allowUnsupportedPlatformForTests:true,
    seams:host.seams,...launcherOptions});
  const handle=launcher.spawnPrepared({unitName});
  await handle.ready;
  host.log.length=0;
  return {handle,result:await handle.terminate({bound,commit:async()=>{host.log.push('commit');},...terminate})};
}
const before=(log,first,second)=>log.findIndex(line=>line.startsWith(first))<log.findIndex(line=>line.startsWith(second));

test('terminate freezes, reads twice a window apart, commits, then stops; removed cgroup is measured',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host);
  assert.equal(result.measured,true);assert.equal(result.postExit,'REMOVED');
  assert.equal(result.stopProof.unitStopped,true);assert.equal(result.stopProof.launcherClosed,true);
  assert.equal(result.reason,undefined);
  assert.deepEqual(result.frozenSample,{unitName,group:cgroupGroup,pid:4242,invocationId,procStartTicks:'12345',
    cgroupInode:304778,deviceId:'8:0',deviceInode:156,readBytes:0,writeBytes:65536});
  const evidence=result.readbackEvidence;
  assert.equal(evidence.freezer,'frozen');assert.equal(evidence.windowMs,2500);
  assert.equal(evidence.maxBioBytes,1310720);assert.deepEqual(evidence.rates,controls.evaluator);
  assert.deepEqual(evidence.reads,[{readBytes:0,writeBytes:65536},{readBytes:0,writeBytes:65536}]);
  assert.equal(evidence.fileDirty,0);assert.equal(evidence.fileWriteback,0);
  assert.equal(host.log.filter(line=>line.startsWith('stopUnit')).length,1);
  assert.equal(host.log.includes('sleep 2500'),true);
});

test('terminate never stops the unit before the frozen readback and durable commit finish',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host);
  assert.equal(result.measured,true);
  const log=host.log;
  const stop=log.findIndex(line=>line.startsWith('stopUnit'));
  assert.equal(log.some(line=>line.startsWith('child.kill')),false);
  assert.ok(log.findIndex(line=>line.includes('--user freeze'))>=0);
  assert.ok(before(log,'command systemctl --user freeze','read '+cgroupBase+'/io.stat'));
  assert.ok(log.lastIndexOf('read '+cgroupBase+'/io.stat')<log.indexOf('commit'));
  assert.ok(log.lastIndexOf('read '+cgroupBase+'/memory.stat')<log.indexOf('commit'));
  assert.ok(log.indexOf('commit')<stop);
  assert.ok(log.lastIndexOf('read /proc/4242/stat')<stop);
  // post-exit reconciliation happens after the stop
  assert.ok(log.indexOf('read '+cgroupBase+'/cgroup.events',stop)>stop);
});

test('terminate is single-flight and a concurrent stop shares its stop proof',async()=>{
  const host=fakeHost();
  const launcher=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=launcher.spawnPrepared({unitName});
  await handle.ready;
  const first=handle.terminate({bound});
  const second=handle.terminate({bound});
  assert.equal(first,second);
  const stopping=handle.stop();
  const [terminal,proof]=await Promise.all([first,stopping]);
  assert.equal(proof,terminal.stopProof);
  assert.equal(await handle.stop(),terminal.stopProof);
  assert.equal(await handle.terminate({bound}),terminal);
  assert.equal(host.log.filter(line=>line.startsWith('stopUnit')).length,1);
  assert.equal(host.log.filter(line=>line.includes('--user freeze')).length,1);
  assert.equal(terminal.measured,true);
});

test('stop before terminate skips the freeze and reports not measured',async()=>{
  const host=fakeHost();
  const launcher=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=launcher.spawnPrepared({unitName});
  await handle.ready;
  const proof=await handle.stop();
  const terminal=await handle.terminate({bound});
  assert.equal(terminal.stopProof,proof);assert.equal(terminal.measured,false);
  assert.equal(terminal.reason,'ALREADY_STOPPING');
  assert.equal(host.log.some(line=>line.includes('--user freeze')),false);
});

test('freeze command failure, timeout, and freezer mismatch still stop and are not measured',async()=>{
  for(const [options,reason] of [[{freezeCode:1},'FREEZE_FAILED'],[{freezeCode:-1},'FREEZE_FAILED'],
    [{eventsStuck:true},'FREEZE_TIMEOUT'],[{freezerReported:'running'},'FREEZER_STATE_MISMATCH']]){
    const host=fakeHost(options);
    const {result}=await terminateWith(host);
    assert.equal(result.measured,false,reason);assert.equal(result.reason,reason);
    assert.equal(result.frozenSample,undefined);assert.equal(result.readbackEvidence,undefined);
    assert.equal(result.stopProof.unitStopped,true);
    assert.equal(host.log.filter(line=>line.startsWith('stopUnit')).length,1);
    assert.equal(host.log.includes('commit'),false);
  }
});

test('identity or inode change between the pre- and post-read gives not measured',async()=>{
  const startTicks=fakeHost();
  startTicks.afterSleep=()=>{startTicks.startTicks='99999';};
  let {result}=await terminateWith(startTicks);
  assert.equal(result.measured,false);assert.equal(result.reason,'IDENTITY_CHANGED');
  assert.equal(startTicks.log.includes('commit'),false);
  assert.equal(result.stopProof.unitStopped,true);
  const inode=fakeHost();
  inode.afterSleep=()=>{inode.inode=304779;};
  ({result}=await terminateWith(inode));
  assert.equal(result.measured,false);assert.equal(result.reason,'IDENTITY_CHANGED');
  assert.equal(inode.log.includes('commit'),false);
  const wrongBound=fakeHost();
  ({result}=await terminateWith(wrongBound,{terminate:{bound:{...bound,pid:4243}}}));
  assert.equal(result.reason,'IDENTITY_CHANGED');assert.equal(result.measured,false);
  assert.equal(wrongBound.log.some(line=>line.includes('--user freeze')),false);
});

test('missing bound identity, near runtime limit, and invalid budget skip the freeze but still stop',async()=>{
  let host=fakeHost();
  let {result}=await terminateWith(host,{terminate:{bound:null}});
  assert.equal(result.reason,'NO_BOUND_IDENTITY');assert.equal(result.measured,false);
  assert.equal(host.log.some(line=>line.includes('--user freeze')),false);
  assert.equal(result.stopProof.unitStopped,true);
  host=fakeHost();
  ({result}=await terminateWith(host,{timeoutMs:5000}));
  assert.equal(result.reason,'RUNTIME_LIMIT_NEAR');assert.equal(result.measured,false);
  assert.equal(host.log.some(line=>line.includes('--user freeze')),false);
  host=fakeHost();
  ({result}=await terminateWith(host,{terminate:{budgetMs:1}}));
  assert.equal(result.reason,'INVALID_BUDGET');assert.equal(result.measured,false);
  host=fakeHost({maxSectors:'junk\n'});
  ({result}=await terminateWith(host));
  assert.equal(result.reason,'MAX_SECTORS_INVALID');assert.equal(result.measured,false);
  assert.equal(host.log.some(line=>line.includes('--user freeze')),false);
  host=fakeHost({maxSectors:'2560000\n'});
  ({result}=await terminateWith(host));
  assert.equal(result.measured,false);
  host=fakeHost({maxSectors:null});
  ({result}=await terminateWith(host));
  assert.equal(result.measured,true);assert.equal(result.readbackEvidence.maxBioBytes,1310720);
});

test('commit failure kills the unit and is not measured',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host,{terminate:{commit:async()=>{host.log.push('commit');throw Error('db down');}}});
  assert.equal(result.measured,false);assert.equal(result.reason,'COMMIT_FAILED');
  assert.equal(result.stopProof.unitStopped,true);
  assert.ok(host.log.indexOf('commit')<host.log.findIndex(line=>line.startsWith('stopUnit')));
  const invalid=fakeHost();
  const {result:bad}=await terminateWith(invalid,{terminate:{commit:'nope'}});
  assert.equal(bad.reason,'INVALID_COMMIT');assert.equal(bad.measured,false);
});

test('dirty or writeback page cache, growth, and zero io.stat row fall back',async()=>{
  for(const [options,reason] of [[{dirty:65536},'WRITEBACK_PENDING'],[{writeback:4096},'WRITEBACK_PENDING'],
    [{zeroRow:true,counters:{read:0,write:0}},'counter_parse']]){
    const host=fakeHost(options);
    const {result}=await terminateWith(host);
    assert.equal(result.measured,false,reason);assert.equal(result.reason,reason);
    assert.equal(result.stopProof.unitStopped,true);assert.equal(host.log.includes('commit'),false);
  }
  const growing=fakeHost();
  growing.afterSleep=()=>{growing.counters.write+=4096;};
  const {result}=await terminateWith(growing);
  assert.equal(result.measured,false);assert.equal(result.reason,'NO_QUIESCENCE');
  assert.equal(growing.log.includes('commit'),false);
});

test('post-exit tail, changed inode, and unreadable retained group are not measured; equal retained is',async()=>{
  const retained=patch=>({read:0,write:65536,inode:304778,...patch});
  let host=fakeHost({retained:retained({})});
  let {result}=await terminateWith(host);
  assert.equal(result.measured,true);assert.equal(result.postExit,'RETAINED_EQUAL');
  host=fakeHost({retained:retained({write:69632})});
  ({result}=await terminateWith(host));
  assert.equal(result.measured,false);assert.equal(result.postExit,'TAIL_OBSERVED');
  assert.equal(result.reason,'POST_EXIT_TAIL_OBSERVED');
  assert.equal(result.frozenSample.writeBytes,65536);
  host=fakeHost({retained:retained({inode:5})});
  ({result}=await terminateWith(host));
  assert.equal(result.measured,false);assert.equal(result.postExit,'UNKNOWN');
  host=fakeHost({retained:retained({read:1,write:1})});
  ({result}=await terminateWith(host));
  assert.equal(result.measured,false);assert.equal(result.postExit,'UNKNOWN');
});

test('stop rc 5 after collect and systemd-run exit 255 do not misclassify a measured terminal',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host);
  assert.equal(result.stopProof.launcherCode,255);
  assert.equal(result.stopProof.unitStopped,true);assert.equal(result.measured,true);
  // Unit not proven stopped: no post-exit read, not measured, stop proof stays untrusted.
  const unproven=fakeHost({stopResult:false});
  const {result:failed}=await terminateWith(unproven);
  assert.equal(failed.stopProof.unitStopped,false);assert.equal(failed.measured,false);
  assert.equal(failed.postExit,null);assert.equal(failed.reason,'STOP_UNCONFIRMED');
  assert.equal(unproven.log.slice(unproven.log.findIndex(line=>line.startsWith('stopUnit')))
    .some(line=>line.includes('cgroup.events')),false);
});

test('seams and platform gate are validated',()=>{
  if(process.platform!=='linux')
    assert.throws(()=>createIoRuntimeLauncher({ioControls:controls}),{code:'QUANT_IO_ISOLATION_REQUIRED'});
  for(const seams of [{unknown:()=>{}},{clock:5},null])
    assert.throws(()=>createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams}),
      {code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'});
});

// ---- FTR-1b frozen writeback drain: same injected host, fake clock, no Linux access ----
const drainOptions=(terminalDrainMs=20000)=>({timeoutMs:60000,launcher:{terminalDrainMs}});
const memoryLine='read '+cgroupBase+'/memory.stat';
const ioLine='read '+cgroupBase+'/io.stat';
const sleepCount=(log,ms)=>log.filter(line=>line==='sleep '+ms).length;
const stopCount=log=>log.filter(line=>line.startsWith('stopUnit')).length;
const range=(count,step,map)=>Array.from({length:count},(_,index)=>map(index*step));
const digestOf=result=>terminalReadbackDigest({jobId:'job-00001',operationId:'operation-00001',
  unitName:result.frozenSample.unitName,group:result.frozenSample.group,cgroupInode:result.frozenSample.cgroupInode,
  invocationId:result.frozenSample.invocationId,pid:result.frozenSample.pid,
  procStartTicks:result.frozenSample.procStartTicks,deviceId:result.frozenSample.deviceId,
  deviceInode:result.frozenSample.deviceInode,reads:result.readbackEvidence.reads,
  windowMs:result.readbackEvidence.windowMs,fileDirty:result.readbackEvidence.fileDirty,
  fileWriteback:result.readbackEvidence.fileWriteback,freezer:result.readbackEvidence.freezer,
  postExit:result.postExit});

test('drain is off by default: no drain reads, no diagnostic, same result shape and log as explicit 0',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host);
  assert.equal(result.measured,true);
  assert.deepEqual(Object.keys(result).sort(),['frozenSample','measured','postExit','readbackEvidence','stopProof']);
  const evidence=result.readbackEvidence;
  assert.equal(evidence.drainMs,0);assert.equal(evidence.drainPolls,0);assert.equal(evidence.statFreshMs,2500);
  // Only the quiescence read's own memory.stat read precedes its io.stat read; there is no poll loop.
  const firstIo=host.log.indexOf(ioLine);
  assert.equal(host.log.slice(0,firstIo).filter(line=>line===memoryLine).length,1);
  assert.equal(host.log.filter(line=>line===memoryLine).length,host.log.filter(line=>line===ioLine).length);
  assert.equal(sleepCount(host.log,500),0);
  const explicit=fakeHost();
  const {result:again}=await terminateWith(explicit,{launcher:{terminalDrainMs:0}});
  assert.deepEqual(explicit.log,host.log);assert.deepEqual(again,result);
  // Fallback shape is unchanged too: reason only, no diagnostic.
  const dirty=fakeHost({dirty:65536});
  const {result:failed}=await terminateWith(dirty);
  assert.deepEqual(Object.keys(failed).sort(),['measured','postExit','reason','stopProof']);
  assert.equal(failed.reason,'WRITEBACK_PENDING');
  const malformed=fakeHost({memoryStat:'anon 1\n'});
  const {result:bad}=await terminateWith(malformed);
  assert.equal(bad.reason,'WRITEBACK_PENDING');assert.equal(bad.diagnostic,undefined);
});

test('drain waits while frozen for dirty pages to clean, then quiesces, commits, and stops in order',async()=>{
  const host=fakeHost({dirty:now=>now<12000?8192:0});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,true);assert.equal(result.reason,undefined);assert.equal(result.diagnostic,undefined);
  const evidence=result.readbackEvidence;
  assert.ok(evidence.drainMs>=12000);assert.equal(evidence.drainPolls,25);
  assert.equal(evidence.fileDirty,0);assert.equal(evidence.fileWriteback,0);assert.ok(evidence.statFreshMs>=12000);
  const log=host.log,firstIo=log.indexOf(ioLine),stop=log.findIndex(line=>line.startsWith('stopUnit'));
  assert.equal(sleepCount(log,500),24);assert.ok(log.lastIndexOf('sleep 500')<firstIo);
  // 25 drain polls plus the first quiescence read's own memory.stat read.
  assert.equal(log.slice(0,firstIo).filter(line=>line===memoryLine).length,26);
  assert.ok(firstIo<log.indexOf('commit'));assert.ok(log.indexOf('commit')<stop);
  assert.equal(stopCount(log),1);assert.equal(log.filter(line=>line.includes('--user freeze')).length,1);
  // The digest input has no drain field, so the digest equals the drain-off digest.
  const plain=await terminateWith(fakeHost());
  assert.equal(digestOf(result),digestOf(plain.result));
});

test('drain floor: a clean cgroup still waits DRAIN_SETTLE_MS before the quiescence reads',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host,drainOptions(7500));
  assert.equal(result.measured,true);
  assert.equal(result.readbackEvidence.drainMs,7500);assert.equal(result.readbackEvidence.drainPolls,16);
  assert.equal(sleepCount(host.log,500),15);
  assert.ok(host.log.lastIndexOf('sleep 500')<host.log.indexOf(ioLine));
});

test('drain does not exit at the floor while late dirty pages are present; it exits on the first settled clean read',async()=>{
  // Clean before 3 s, dirty from 3 s to 9 s, clean again. 7.5 s is reached while dirty, so exit waits for 9 s.
  const host=fakeHost({dirty:now=>now>=3000&&now<9000?4096:0});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,true);
  assert.equal(result.readbackEvidence.drainMs,9000);assert.notEqual(result.readbackEvidence.drainMs,7500);
  assert.equal(result.readbackEvidence.drainPolls,19);
});

test('drain timeout with dirty or writeback pages falls back with a DRAIN diagnostic and one stop',async()=>{
  for(const [options,dirty,writeback] of [[{dirty:8192},8192,0],[{writeback:4096},0,4096]]){
    const host=fakeHost(options);
    const {result}=await terminateWith(host,drainOptions(10000));
    assert.equal(result.measured,false);assert.equal(result.reason,'WRITEBACK_PENDING');
    assert.equal(result.frozenSample,undefined);assert.equal(result.readbackEvidence,undefined);
    assert.equal(result.stopProof.unitStopped,true);
    assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
    assert.equal(host.log.includes(ioLine),false);
    assert.ok(host.now<=10000+500);
    assert.deepEqual(result.diagnostic,{version:'quant-io-terminal-diagnostic-v1',stage:'DRAIN',
      fileDirty:dirty,fileWriteback:writeback,memoryReads:21,sinceFreezeMs:10000,
      drain:{enabled:true,durationMs:10000,polls:21,maxDirty:dirty,maxWriteback:writeback,firstZeroMs:null,
        series:range(21,500,ms=>[ms,dirty,writeback])}});
  }
});

test('malformed, unreadable or vanished memory.stat during the drain fails closed without values',async()=>{
  const eio=()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});};
  const gone=()=>{throw enoent('memory.stat');};
  const good='file_dirty 8192\nfile_writeback 0\n';
  for(const [memoryStat,reason] of [
    [now=>now<1500?good:'/sys/fs/cgroup/secret 1\nfile_dirty 1\n','MEMORY_STAT_INVALID'],
    [now=>now<1500?good:'file_dirty 1\nfile_writeback 0\nfile_dirty 1\n','MEMORY_STAT_INVALID'],
    [now=>now<1500?good:eio(),'MEMORY_STAT_INVALID'],[now=>now<1500?good:gone(),'CGROUP_EMPTY']]){
    const host=fakeHost({memoryStat});
    const {result}=await terminateWith(host,drainOptions());
    assert.equal(result.measured,false,reason);assert.equal(result.reason,reason);
    assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
    assert.equal(result.diagnostic.stage,'DRAIN');assert.equal(result.diagnostic.memoryReads,3);
    assert.equal(result.diagnostic.fileDirty,null);assert.equal(result.diagnostic.fileWriteback,null);
    assert.equal(JSON.stringify(result.diagnostic).includes('secret'),false);
  }
});

test('dirty pages that reappear during quiescence fail WRITEBACK_PENDING with a QUIESCENCE diagnostic',async()=>{
  const host=fakeHost({dirty:now=>now>=8000?4096:0});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,false);assert.equal(result.reason,'WRITEBACK_PENDING');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  const {diagnostic}=result;
  assert.equal(diagnostic.stage,'QUIESCENCE');
  assert.equal(diagnostic.fileDirty,4096);assert.equal(diagnostic.fileWriteback,0);
  // 16 drain polls, then quiescence read 1 (clean) and read 2 (dirty).
  assert.equal(diagnostic.memoryReads,18);assert.equal(diagnostic.sinceFreezeMs,10000);
  assert.equal(diagnostic.drain.durationMs,7500);assert.equal(diagnostic.drain.polls,16);
  assert.equal(diagnostic.drain.firstZeroMs,0);
});

test('stop() during the drain aborts it within one poll and shares the single stop proof',async()=>{
  const host=fakeHost({dirty:8192});
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:60000,terminalDrainMs:40000,
    allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=launcher.spawnPrepared({unitName});
  await handle.ready;host.log.length=0;
  let requestedAt=null,stopping=null;
  host.afterSleep=()=>{if(requestedAt===null&&host.now>=2000){requestedAt=host.now;stopping=handle.stop();}};
  const terminal=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  assert.notEqual(requestedAt,null);
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(await stopping,terminal.stopProof);assert.equal(await handle.stop(),terminal.stopProof);
  assert.equal(terminal.diagnostic.stage,'DRAIN');
  assert.ok(host.now-requestedAt<=1000);assert.ok(host.now<40000);
  assert.equal(stopCount(host.log),1);assert.equal(host.log.filter(line=>line.includes('--user freeze')).length,1);
  assert.equal(host.log.includes('commit'),false);assert.equal(host.log.includes(ioLine),false);
});

test('thaw, emptied, removed or unreadable cgroup.events during the drain fails closed',async()=>{
  const cases=[['thaw',host=>{host.phase='live';},'NOT_FROZEN'],
    ['unpopulated',host=>{host.events='populated 0\nfrozen 1\n';},'CGROUP_EMPTY'],
    ['removed',host=>{host.events=()=>{throw enoent('cgroup.events');};},'CGROUP_EMPTY'],
    ['garbled',host=>{host.events='populated 1\nfrozen one\n';},'FREEZE_UNVERIFIED']];
  for(const [name,mutate,reason] of cases){
    const host=fakeHost({dirty:8192});
    host.afterSleep=()=>{if(host.now>=1500)mutate(host);};
    const {result}=await terminateWith(host,drainOptions());
    assert.equal(result.measured,false,name);assert.equal(result.reason,reason,name);
    assert.equal(host.log.includes('commit'),false,name);assert.equal(stopCount(host.log),1,name);
    assert.equal(result.diagnostic.stage,'DRAIN',name);assert.equal(host.log.includes(ioLine),false,name);
  }
});

test('terminalDrainMs and timeoutMs are validated; drain is charged against the runtime limit',async()=>{
  const make=options=>createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,
    seams:fakeHost().seams,...options});
  for(const bad of [1000,7499,45001,50000,-1,'40000',NaN,null,7500.5,Infinity])
    assert.throws(()=>make({timeoutMs:60000,terminalDrainMs:bad}),{code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'},String(bad));
  for(const good of [0,7500,40000,45000])assert.doesNotThrow(()=>make({timeoutMs:60000,terminalDrainMs:good}));
  assert.doesNotThrow(()=>make({timeoutMs:60000}));
  assert.throws(()=>make({timeoutMs:60001}),{code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'});
  assert.throws(()=>make({timeoutMs:99}),{code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'});
  // RuntimeMaxSec follows the raised cap.
  const host=fakeHost();let args=null;
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:60000,allowUnsupportedPlatformForTests:true,
    seams:{...host.seams,spawn:(file,spawnArgs)=>{args=spawnArgs;return host.child;}}});
  launcher.spawnPrepared({unitName});
  assert.ok(args.includes('--property=RuntimeMaxSec=60'));
  // F3: with the drain on, ceil(timeoutMs/1000)*1000 must exceed 5 s budget + drain + 5 s spawn margin.
  for(const [timeoutMs,terminalDrainMs] of [[30000,40000],[45000,40000],[50000,40000],[17000,7500],[55000,45000]])
    assert.throws(()=>make({timeoutMs,terminalDrainMs}),{code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'},
      timeoutMs+'/'+terminalDrainMs);
  for(const [timeoutMs,terminalDrainMs] of [[50001,40000],[51000,40000],[17001,7500],[55001,45000],[60000,45000],
    [5000,0],[30000,0]])
    assert.doesNotThrow(()=>make({timeoutMs,terminalDrainMs}),timeoutMs+'/'+terminalDrainMs);
  // A runtime that fits at construction can still be too old by terminate time: no freeze, one stop, no diagnostic.
  const near=fakeHost();
  const nearLauncher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:51000,terminalDrainMs:40000,
    allowUnsupportedPlatformForTests:true,seams:near.seams});
  const nearHandle=nearLauncher.spawnPrepared({unitName});
  await nearHandle.ready;near.now=6000;near.log.length=0;
  const nearResult=await nearHandle.terminate({bound,commit:async()=>{near.log.push('commit');}});
  assert.equal(nearResult.reason,'RUNTIME_LIMIT_NEAR');assert.equal(nearResult.measured,false);
  assert.equal(near.log.some(line=>line.includes('--user freeze')),false);
  assert.equal(stopCount(near.log),1);assert.equal(nearResult.diagnostic,undefined);
  const fits=fakeHost();
  const {result}=await terminateWith(fits,{timeoutMs:51000,launcher:{terminalDrainMs:40000}});
  assert.equal(result.measured,true);assert.equal(result.readbackEvidence.drainMs,7500);
});

test('diagnostic key set is exact and holds only integers, booleans, null and fixed enums',async()=>{
  const host=fakeHost({dirty:now=>now<2000?12288:8192});
  const {result}=await terminateWith(host,drainOptions(10000));
  const {diagnostic}=result;
  assert.deepEqual(Object.keys(diagnostic),['version','stage','fileDirty','fileWriteback','memoryReads',
    'sinceFreezeMs','drain']);
  assert.deepEqual(Object.keys(diagnostic.drain),['enabled','durationMs','polls','maxDirty','maxWriteback',
    'firstZeroMs','series']);
  const enums=new Set(['quant-io-terminal-diagnostic-v1','DRAIN','QUIESCENCE']);
  const walk=value=>{
    if(Array.isArray(value)){assert.ok(Object.isFrozen(value));value.forEach(walk);return;}
    if(value&&typeof value==='object'){assert.ok(Object.isFrozen(value));Object.values(value).forEach(walk);return;}
    assert.ok(value===null||typeof value==='boolean'||Number.isSafeInteger(value)||enums.has(value),String(value));
  };
  walk(diagnostic);
  assert.equal(diagnostic.drain.maxDirty,12288);
  const json=JSON.stringify(diagnostic);
  for(const secret of ['/',unitName,'robot-quant',invocationId,cgroupGroup,'sys/fs/cgroup','user.slice','.service'])
    assert.equal(json.includes(secret),false,secret);
  assert.equal(/(?<!\d)4242(?!\d)/.test(json),false);assert.equal(/(?<!\d)304778(?!\d)/.test(json),false);
  // A measured outcome carries no diagnostic and its evidence never mentions one.
  const clean=await terminateWith(fakeHost(),drainOptions());
  assert.equal(clean.result.diagnostic,undefined);
  assert.equal(JSON.stringify(clean.result.readbackEvidence).includes('diagnostic'),false);
});

test('drain series stays at 32 points or fewer after 90 polls, keeping the first and last 16',async()=>{
  const host=fakeHost({dirty:now=>4096*(1+Math.floor(now/500)%3)});
  const {result}=await terminateWith(host,drainOptions(45000));
  assert.equal(result.reason,'WRITEBACK_PENDING');assert.equal(result.measured,false);
  const {drain}=result.diagnostic;
  assert.equal(drain.polls,91);assert.equal(result.diagnostic.memoryReads,91);
  assert.equal(drain.series.length,32);
  assert.deepEqual(drain.series.map(point=>point[0]),
    [...range(16,500,ms=>ms),...range(16,500,ms=>37500+ms)]);
  assert.equal(drain.maxDirty,12288);assert.equal(drain.firstZeroMs,null);
  assert.ok(host.now<=45000+500);
});

test('stat-freshness floor: with a 250 ms window the final stable read is still 2500 ms after freeze',async()=>{
  const fast={...controls,evaluator:{readBytesPerSecond:5242880,writeBytesPerSecond:5242880}};
  let host=fakeHost({rate:5242880});
  let {result}=await terminateWith(host,{ioControls:fast});
  assert.equal(result.measured,true);assert.equal(result.readbackEvidence.windowMs,250);
  assert.ok(result.readbackEvidence.statFreshMs>=2500);assert.equal(result.readbackEvidence.drainPolls,0);
  assert.equal(host.log.filter(line=>line===ioLine).length,3);
  assert.equal(sleepCount(host.log,250),1);assert.equal(sleepCount(host.log,2250),1);
  assert.deepEqual(result.readbackEvidence.reads[0],result.readbackEvidence.reads[1]);
  // With the drain on, the drain already supplies freshness.
  host=fakeHost({rate:5242880});
  ({result}=await terminateWith(host,{ioControls:fast,...drainOptions(7500)}));
  assert.equal(result.measured,true);assert.ok(result.readbackEvidence.statFreshMs>=7500);
  assert.equal(host.log.filter(line=>line===ioLine).length,2);
  // Not enough budget to reach the floor: fail closed instead of accepting a possibly stale read.
  host=fakeHost({rate:5242880});
  ({result}=await terminateWith(host,{ioControls:fast,terminate:{budgetMs:1000}}));
  assert.equal(result.measured,false);assert.equal(result.reason,'NO_QUIESCENCE');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
});

test('other failures after the drain carry the diagnostic in the QUIESCENCE stage; earlier ones carry none',async()=>{
  const growing=fakeHost();
  growing.afterSleep=()=>{growing.counters.write+=4096;};
  const startTicks=fakeHost();
  startTicks.afterSleep=()=>{startTicks.startTicks='99999';};
  const cases=[['NO_QUIESCENCE',growing,{}],
    ['IDENTITY_CHANGED',startTicks,{}],
    ['COMMIT_FAILED',fakeHost(),{terminate:{commit:async()=>{throw Error('db down');}}}],
    ['counter_parse',fakeHost({zeroRow:true,counters:{read:0,write:0}}),{}]];
  for(const [reason,host,extra] of cases){
    const {result}=await terminateWith(host,{...drainOptions(),...extra});
    assert.equal(result.measured,false,reason);assert.equal(result.reason,reason);
    assert.equal(result.diagnostic.stage,'QUIESCENCE',reason);
    assert.equal(result.diagnostic.drain.polls,16,reason);assert.equal(result.diagnostic.drain.durationMs,7500,reason);
    assert.equal(result.diagnostic.fileDirty,0,reason);assert.equal(result.diagnostic.fileWriteback,0,reason);
    assert.equal(stopCount(host.log),1,reason);
  }
  // Failures before the freeze is confirmed have no drain series to report.
  const host=fakeHost({freezeCode:1});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.reason,'FREEZE_FAILED');assert.equal(result.diagnostic,undefined);
});

// ---- FTR-1b audit fixes F1-F4, F7 ----
// Golden default-off logs: recorded from the HEAD c6e61ec launcher (before FTR-1b) on this same fake host.
// <cg> is the unit cgroup directory and <unit> the unit name.
const GOLDEN_MEASURED=`
read /sys/dev/block/8:0/queue/max_sectors_kb
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
read /proc/4242/stat
read /proc/4242/cgroup
read <cg>/io.max
stat <cg>
stat /dev/sda
command systemctl --user freeze <unit>
read <cg>/cgroup.events
command systemctl --user show <unit> --property=FreezerState
read <cg>/cgroup.events
read <cg>/memory.stat
read <cg>/io.max
read <cg>/io.stat
stat <cg>
sleep 2500
read <cg>/cgroup.events
read <cg>/memory.stat
read <cg>/io.max
read <cg>/io.stat
stat <cg>
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
read /proc/4242/stat
read /proc/4242/cgroup
read <cg>/io.max
stat <cg>
stat /dev/sda
commit
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
stopUnit <unit>
command systemctl --user list-jobs --no-legend --no-pager
read <cg>/cgroup.events
`;
const GOLDEN_DIRTY=`
read /sys/dev/block/8:0/queue/max_sectors_kb
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
read /proc/4242/stat
read /proc/4242/cgroup
read <cg>/io.max
stat <cg>
stat /dev/sda
command systemctl --user freeze <unit>
read <cg>/cgroup.events
command systemctl --user show <unit> --property=FreezerState
read <cg>/cgroup.events
read <cg>/memory.stat
read <cg>/io.max
read <cg>/io.stat
stat <cg>
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
stopUnit <unit>
command systemctl --user list-jobs --no-legend --no-pager
`;
const GOLDEN_GROWING=`
read /sys/dev/block/8:0/queue/max_sectors_kb
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
read /proc/4242/stat
read /proc/4242/cgroup
read <cg>/io.max
stat <cg>
stat /dev/sda
command systemctl --user freeze <unit>
read <cg>/cgroup.events
command systemctl --user show <unit> --property=FreezerState
read <cg>/cgroup.events
read <cg>/memory.stat
read <cg>/io.max
read <cg>/io.stat
stat <cg>
sleep 2500
read <cg>/cgroup.events
read <cg>/memory.stat
read <cg>/io.max
read <cg>/io.stat
stat <cg>
sleep 2500
read <cg>/cgroup.events
read <cg>/memory.stat
read <cg>/io.max
read <cg>/io.stat
stat <cg>
command systemctl --user show <unit> --property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID
stopUnit <unit>
command systemctl --user list-jobs --no-legend --no-pager
`;
const expandGolden=text=>text.trim().split('\n').map(line=>line.split('<cg>').join(cgroupBase).split('<unit>').join(unitName));

test('golden default-off flow: log, result keys and evidence equal the recorded HEAD flow (F4)',async()=>{
  const measured=fakeHost();
  const {result}=await terminateWith(measured);
  assert.deepEqual(measured.log,expandGolden(GOLDEN_MEASURED));
  assert.deepEqual(Object.keys(result).sort(),['frozenSample','measured','postExit','readbackEvidence','stopProof']);
  assert.equal(result.measured,true);assert.equal(result.postExit,'REMOVED');
  // HEAD evidence keys unchanged in value; FTR-1b only adds drainMs, drainPolls and statFreshMs.
  const {drainMs,drainPolls,statFreshMs,...headEvidence}=result.readbackEvidence;
  assert.deepEqual(headEvidence,{freezer:'frozen',windowMs:2500,
    reads:[{readBytes:0,writeBytes:65536},{readBytes:0,writeBytes:65536}],fileDirty:0,fileWriteback:0,
    maxBioBytes:1310720,rates:controls.evaluator,freezeMs:0,elapsedMs:2500});
  assert.deepEqual([drainMs,drainPolls,statFreshMs],[0,0,2500]);
  const dirty=fakeHost({dirty:65536});
  const {result:pending}=await terminateWith(dirty);
  assert.deepEqual(dirty.log,expandGolden(GOLDEN_DIRTY));
  assert.deepEqual(Object.keys(pending).sort(),['measured','postExit','reason','stopProof']);
  assert.equal(pending.reason,'WRITEBACK_PENDING');
  const growing=fakeHost();
  growing.afterSleep=()=>{growing.counters.write+=4096;};
  const {result:unstable}=await terminateWith(growing);
  assert.deepEqual(growing.log,expandGolden(GOLDEN_GROWING));
  assert.equal(unstable.reason,'NO_QUIESCENCE');assert.equal(unstable.measured,false);
});

test('stop() during quiescence with the drain on aborts within one window (F1); drain off keeps the FTR-1 flow',async()=>{
  const host=fakeHost();
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:60000,terminalDrainMs:40000,
    allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=launcher.spawnPrepared({unitName});
  await handle.ready;host.log.length=0;
  let requestedAt=null,stopping=null;
  // Counters keep growing after the drain, so quiescence cannot settle. The stop arrives at the first quiescence sleep.
  host.afterSleep=()=>{
    if(host.now>7500)host.counters.write+=4096;
    if(requestedAt===null&&host.now>=8000){requestedAt=host.now;stopping=handle.stop();}
  };
  const terminal=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  assert.notEqual(requestedAt,null);
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(terminal.diagnostic.stage,'QUIESCENCE');
  assert.equal(await stopping,terminal.stopProof);assert.equal(await handle.stop(),terminal.stopProof);
  // windowMs is 2500. Before the fix this waited until the inherited drain allowance ran out (about 35 s).
  assert.ok(host.now-requestedAt<=2500);assert.ok(host.now<12000);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(host.log.filter(line=>line.includes('--user freeze')).length,1);
  assert.equal(host.log.filter(line=>line===ioLine).length,1);assert.equal(sleepCount(host.log,2500),1);
  // Drain off: a stop that arrives during quiescence still lets the terminal finish and measure (FTR-1 flow).
  const plain=fakeHost();
  const plainLauncher=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,
    seams:plain.seams});
  const plainHandle=plainLauncher.spawnPrepared({unitName});
  await plainHandle.ready;
  let plainStop=null;
  plain.afterSleep=()=>{if(plainStop===null)plainStop=plainHandle.stop();};
  const done=await plainHandle.terminate({bound});
  assert.equal(done.measured,true);assert.equal(done.reason,undefined);
  assert.equal(await plainStop,done.stopProof);
});

test('unused drain allowance never lengthens quiescence (F1)',async()=>{
  const host=fakeHost();
  host.afterSleep=()=>{if(host.now>7500)host.counters.write+=4096;};
  const {result}=await terminateWith(host,drainOptions(40000));
  assert.equal(result.measured,false);assert.equal(result.reason,'NO_QUIESCENCE');
  assert.equal(result.diagnostic.stage,'QUIESCENCE');
  // The drain leaves at 7500. Quiescence gets budgetMs (5000): reads at 7500, 10000 and 12500, never later.
  assert.equal(host.log.filter(line=>line===ioLine).length,3);assert.ok(host.now<=7500+5000);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
});

test('drain end is bounded by the overall deadline when pre-freeze steps are slow (F2)',async()=>{
  const fast={...controls,evaluator:{readBytesPerSecond:5242880,writeBytesPerSecond:5242880}};
  const host=fakeHost({rate:5242880,dirty:8192});
  const command=host.seams.command;
  // The freeze command itself takes 3650 ms, so frozenAt + 10000 lies beyond the deadline (1000 + 10000).
  host.seams.command=async(file,args,timeout)=>{if(args[1]==='freeze')host.now+=3650;return command(file,args,timeout);};
  const {result}=await terminateWith(host,{ioControls:fast,terminate:{budgetMs:1000},...drainOptions(10000)});
  assert.equal(result.measured,false);assert.equal(result.reason,'WRITEBACK_PENDING');
  assert.equal(result.diagnostic.stage,'DRAIN');assert.equal(result.diagnostic.sinceFreezeMs,7350);
  assert.equal(host.now,11000);assert.equal(sleepCount(host.log,350),1);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(host.log.includes(ioLine),false);
});

test('stop requested before the freeze is confirmed aborts the drain with no memory reads (F4)',async()=>{
  const host=fakeHost({dirty:8192});
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:60000,terminalDrainMs:20000,
    allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=launcher.spawnPrepared({unitName});
  await handle.ready;host.log.length=0;
  const pending=handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  const stopping=handle.stop();
  const terminal=await pending;
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(await stopping,terminal.stopProof);
  assert.equal(host.log.filter(line=>line===memoryLine).length,0);
  assert.equal(host.log.includes(ioLine),false);assert.equal(sleepCount(host.log,500),0);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(terminal.diagnostic.stage,'DRAIN');assert.equal(terminal.diagnostic.memoryReads,0);
  assert.equal(terminal.diagnostic.drain.polls,0);
});

test('thaw during quiescence fails NOT_FROZEN with a QUIESCENCE-stage diagnostic (F4)',async()=>{
  const host=fakeHost();
  // The drain leaves at 7500; the unit thaws before the second quiescence read at 10000.
  host.afterSleep=()=>{if(host.now>=8000)host.phase='live';};
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,false);assert.equal(result.reason,'NOT_FROZEN');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  const {diagnostic}=result;
  assert.equal(diagnostic.stage,'QUIESCENCE');
  assert.equal(diagnostic.fileDirty,0);assert.equal(diagnostic.fileWriteback,0);
  // 16 drain polls plus the clean first quiescence read; the thawed second read is rejected before parsing.
  assert.equal(diagnostic.memoryReads,17);assert.equal(diagnostic.drain.polls,16);
  assert.equal(diagnostic.drain.durationMs,7500);
});

test('malformed memory.stat during quiescence reports MEMORY_STAT_INVALID only with the drain on (F7)',async()=>{
  const memoryStat=now=>now>=8000?'anon 1\n':'file_dirty 0\nfile_writeback 0\n';
  const host=fakeHost({memoryStat});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,false);assert.equal(result.reason,'MEMORY_STAT_INVALID');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(result.diagnostic.stage,'QUIESCENCE');
  assert.equal(result.diagnostic.fileDirty,null);assert.equal(result.diagnostic.fileWriteback,null);
  assert.equal(result.diagnostic.memoryReads,17);
  // Drain off keeps the FTR-1 reason and the FTR-1 shape (no diagnostic).
  const plain=fakeHost({memoryStat:'anon 1\n'});
  const {result:legacy}=await terminateWith(plain);
  assert.equal(legacy.reason,'WRITEBACK_PENDING');assert.equal(legacy.diagnostic,undefined);
  assert.deepEqual(Object.keys(legacy).sort(),['measured','postExit','reason','stopProof']);
});
