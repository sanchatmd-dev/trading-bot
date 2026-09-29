import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {
  inspectIoRuntimeUnit,inspectIoRuntimeDevice,inspectIoRuntimeProc,
  inspectIoRuntimeMembership,
  inspectIoRuntimeReceipt,inspectIoRuntimeScratch,createIoRuntimeLauncher,
} from '../src/quant-research/io-runtime-launcher.js';

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
    retained:null,afterSleep:null,...options};
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),
    stdout:new PassThrough(),stderr:new PassThrough(),
    kill(signal){host.log.push('child.kill '+signal);host.closeChild();return true;}});
  host.child=child;
  host.closeChild=()=>{if(!host.childClosed){host.childClosed=true;child.emit('close',255);}};
  const unitShow=`LoadState=loaded\nActiveState=active\nMainPID=4242\nControlGroup=${cgroupGroup}\nInvocationID=${invocationId}\n`;
  const gone=path=>host.phase==='stopped'&&!host.retained&&!path.startsWith('/dev/');
  const stat=()=>`8:0 rbytes=${host.counters.read} wbytes=${host.counters.write} rios=0 wios=1 dbytes=0 dios=0\n`;
  const files={
    '/sys/dev/block/8:0/queue/max_sectors_kb':()=>{if(host.maxSectors===null)throw enoent('max_sectors_kb');return host.maxSectors;},
    '/proc/4242/stat':()=>{const fields=Array(20).fill('1');fields[0]='S';fields[19]=host.startTicks;return `4242 (worker) ${fields.join(' ')}`;},
    '/proc/4242/cgroup':()=>`0::${cgroupGroup}\n`,
    [cgroupBase+'/io.max']:()=>'8:0 rbps=524288 wbps=524288 riops=max wiops=max\n',
    [cgroupBase+'/io.stat']:()=>host.zeroRow&&host.counters.read===0&&host.counters.write===0?'8:0\n':stat(),
    [cgroupBase+'/cgroup.events']:()=>host.phase==='stopped'?`populated 0\nfrozen ${host.retained?1:0}\n`:
      `populated 1\nfrozen ${host.phase==='frozen'&&!host.eventsStuck?1:0}\n`,
    [cgroupBase+'/memory.stat']:()=>`anon 4096\nfile 8192\nfile_dirty ${host.dirty}\nfile_writeback ${host.writeback}\n`,
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
async function terminateWith(host,{timeoutMs=30000,terminate={}}={}){
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs,allowUnsupportedPlatformForTests:true,
    seams:host.seams});
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
