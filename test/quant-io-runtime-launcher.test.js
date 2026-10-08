import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  inspectIoRuntimeUnit,inspectIoRuntimeDevice,inspectIoRuntimeProc,
  inspectIoRuntimeMembership,
  inspectIoRuntimeReceipt,inspectIoRuntimeScratch,createIoRuntimeLauncher,syncStorageDirectory,
} from '../src/quant-research/io-runtime-launcher.js';
import {terminalReadbackDigest} from '../src/quant-research/io-terminal.js';
import {validateTerminalPolicy,capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {StorageBudget} from '../src/quant-research/storage-budget.js';

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
const enoent=file=>Object.assign(new Error('ENOENT '+file),{code:'ENOENT'});
const storageRoot=path.resolve('/srv/quant-storage-root');
const rootIdentity={dev:2049,ino:2};
const rootStats={
  dir:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,...rootIdentity}),
  symlink:()=>({isDirectory:()=>false,isSymbolicLink:()=>true,...rootIdentity}),
  file:()=>({isDirectory:()=>false,isSymbolicLink:()=>false,...rootIdentity}),
  missing:()=>{throw enoent('storage root');}};
const scratchStats={isFile:()=>true,isSymbolicLink:()=>false,size:4096,dev:9,ino:77};

/** Scriptable Linux host. phase: live, frozen, stopped.
 * FTR-1c fields: vmExpire and vmWriteback are the two vm sysctl sources (null: unreadable), rootStat picks the
 * lstat answer for the StorageBudget root, and barrier scripts the directory fsync: settle after `ms` fake
 * milliseconds, reject, or never settle. The barrier timer (the first sleep of 2000 after syncDirectory) is
 * virtual: it fires only when the barrier never settles, so a fast barrier costs no fake time.
 * FTR-1c-D fields: fsType is the statfs f_type of the StorageBudget root (default ext4), statfsError makes statfs
 * throw, and onFreezerState runs when the FreezerState property is read (after the cgroup reports frozen).
 */
function fakeHost(options={}){
  const host={phase:'live',now:0,log:[],removed:true,
    counters:{read:0,write:65536},dirty:0,writeback:0,inode:304778,startTicks:'12345',
    freezeCode:0,freezerReported:null,eventsStuck:false,maxSectors:'1280\n',stopResult:true,
    retained:null,afterSleep:null,rate:524288,memoryStat:null,events:null,
    vmExpire:'100\n',vmWriteback:'50\n',rootStat:'dir',barrier:{mode:'settle',ms:0},
    syncCalls:[],barrierOpen:false,barrierStartedAt:null,barrierDoneAt:null,barrierLate:null,onBarrier:null,
    beforeRead:null,postReady:null,fsType:0xEF53,statfsError:null,onFreezerState:null,
    swapMax:'0\n',meminfo:'MemTotal:        8000000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n',...options};
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
    [cgroupBase+'/pids.max']:()=>'16\n',
    // W2 L3: the drained ready gate reads memory.swap.max (null: no such file), then /proc/meminfo when it is missing.
    [cgroupBase+'/memory.swap.max']:()=>{if(host.swapMax===null)throw enoent('memory.swap.max');return at(host.swapMax);},
    '/proc/meminfo':()=>{if(host.meminfo===null)throw enoent('meminfo');return at(host.meminfo);},
    '/proc/sys/vm/dirty_expire_centisecs':()=>{
      if(host.vmExpire===null)throw enoent('dirty_expire_centisecs');return at(host.vmExpire);},
    '/proc/sys/vm/dirty_writeback_centisecs':()=>{
      if(host.vmWriteback===null)throw enoent('dirty_writeback_centisecs');return at(host.vmWriteback);}};
  host.seams={
    clock:()=>host.now,
    async sleep(ms){
      host.log.push('sleep '+ms);
      if(host.barrierOpen&&ms===2000){
        // The barrier timer. It fires only if the barrier never settles; otherwise it stays pending.
        host.barrierOpen=false;
        if(host.barrier.mode==='never'){host.now=host.barrierStartedAt+ms;return;}
        await new Promise(()=>{});
      }
      host.now+=ms;host.afterSleep?.(ms);
    },
    async syncDirectory(root,identity){
      host.log.push('syncDirectory '+root+' '+identity.dev+':'+identity.ino);
      host.syncCalls.push({root,identity:{...identity},phase:host.phase});
      host.barrierOpen=true;host.barrierStartedAt=host.now;
      host.onBarrier?.();
      if(host.barrier.mode==='never'){
        return new Promise((resolve,reject)=>{host.barrierLate={resolve,reject};});
      }
      host.now+=host.barrier.ms??0;host.barrierDoneAt=host.now;
      if(host.barrier.mode==='reject')throw Object.assign(new Error('EIO barrier'),{code:'EIO'});
    },
    async statfs(file){
      host.log.push('statfs '+file);
      if(host.statfsError)throw host.statfsError;
      return {type:host.fsType};
    },
    async lstat(file){
      host.log.push('lstat '+file);
      if(file===storageRoot)return rootStats[host.rootStat]();
      if(file.startsWith(storageRoot))return scratchStats;
      throw enoent(file);
    },
    async unlink(file){host.log.push('unlink '+file);},
    async realpath(file){return file;},
    spawn:()=>child,
    async command(file,args){
      const text=file+' '+args.join(' ');host.log.push('command '+text);
      if(args[0]==='--user'&&args[1]==='freeze'){
        if(host.freezeCode===0)host.phase='frozen';
        return {code:host.freezeCode,output:''};
      }
      if(text.includes('--property=FreezerState')){
        host.onFreezerState?.();
        return {code:0,output:`FreezerState=${host.freezerReported??(host.phase==='frozen'?'frozen':'running')}\n`};
      }
      if(args[1]==='list-jobs')return {code:0,output:''};
      if(args[1]==='show'&&host.phase!=='stopped')return {code:0,output:unitShow};
      return {code:0,output:'LoadState=not-found\nActiveState=inactive\n'};
    },
    async readFile(path){
      host.log.push('read '+path);
      host.beforeRead?.(path);
      if(gone(path)||!Object.hasOwn(files,path)&&!host.retained)throw enoent(path);
      if(host.phase==='stopped'&&host.retained&&path.startsWith(cgroupBase)){
        if(path.endsWith('/io.stat'))return `8:0 rbytes=${host.retained.read} wbytes=${host.retained.write} rios=0 wios=1 dbytes=0 dios=0\n`;
      }
      if(!Object.hasOwn(files,path))throw enoent(path);
      return files[path]();
    },
    async stat(path){
      host.log.push('stat '+path);
      if(path===storageRoot)return {dev:2048,ino:2};
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
/** A StorageBudget whose reservations are fake. The launcher only reads its root and reserves 4 KiB. */
function fakeBudget(host){
  const budget=new StorageBudget({root:storageRoot,diskQuotaBytes:1048576,tempQuotaBytes:1048576,freeFloorBytes:0});
  budget.reserve=async()=>({release:async()=>{host.log.push('release');}});
  return budget;
}
/** Spawns through the readiness path when the drain is on (it needs the StorageBudget root), else the plain path. */
async function spawnHandle(host,{timeoutMs=30000,launcher:launcherOptions={},ioControls=controls}={}){
  const drained=launcherOptions.terminalDrainMs>0;
  const launcher=createIoRuntimeLauncher({ioControls,timeoutMs,allowUnsupportedPlatformForTests:true,
    seams:host.seams,...(drained?{storageBudget:fakeBudget(host)}:{}),...launcherOptions});
  const handle=drained?(await launcher.prepare({unitName})).spawnPrepared():launcher.spawnPrepared({unitName});
  await handle.ready;
  host.log.length=0;
  host.postReady?.();
  return handle;
}
async function terminateWith(host,{timeoutMs=30000,terminate={},launcher:launcherOptions={},ioControls=controls}={}){
  const handle=await spawnHandle(host,{timeoutMs,launcher:launcherOptions,ioControls});
  return {handle,result:await handle.terminate({bound,commit:async()=>{host.log.push('commit');},...terminate})};
}
const before=(log,first,second)=>log.findIndex(line=>line.startsWith(first))<log.findIndex(line=>line.startsWith(second));
test('native child diagnostics attach after existing consumers and never infer stop proof',async()=>{
 const host=fakeHost(),handle=await spawnHandle(host);
 assert.equal(host.child.stderr.listenerCount('data'),2);
 assert.equal(handle.childDiagnostic().closeObserved,false);
 host.child.stderr.emit('data',Buffer.from('PROFILE_OPEN_BAR\n'));
 assert.equal(handle.childDiagnostic().code,'UNKNOWN');
 host.child.emit('close',1,null);
 const diagnostic=handle.childDiagnostic();assert.equal(diagnostic.code,'PROFILE_OPEN_BAR');
 assert.equal(diagnostic.exitStatus,1);assert.equal(diagnostic.childKernelStatusKnown,false);
 assert.equal(await handle.closed,1);assert.equal(host.log.some(line=>line.startsWith('child.kill')),false);
});
test('native diagnostic observation preserves existing combined output limit and kill',async()=>{
 const host=fakeHost(),handle=await spawnHandle(host);
 // Real process close arrives asynchronously after kill, not inside the data consumer.
 host.child.kill=signal=>{host.log.push('child.kill '+signal);return true;};
 host.child.stderr.emit('data',Buffer.alloc(65537));
 host.closeChild();
 assert.equal(host.log.filter(line=>line==='child.kill SIGKILL').length,1);
 assert.equal(handle.childDiagnostic().truncated,true);assert.equal(handle.childDiagnostic().code,'UNKNOWN');
});
test('native observation preserves accepted/result stdout frames and successful launcher exit',async()=>{
 const host=fakeHost(),{policy,contract}=profileV2Fixture(600);
 policy.environment='staging';contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);
 const budget=fakeBudget(host),payload=canonical({version:'profile-v2-provisional',jobId:'11111111-2222-4333-8444-555555555555',
  operationId:'operation-00001',contract,policy,storage:{root:budget.root,diskQuotaBytes:budget.diskQuotaBytes,
   tempQuotaBytes:budget.tempQuotaBytes,freeFloorBytes:budget.freeFloorBytes}});
 const launcher=createIoRuntimeLauncher({protocol:'profile-v2-provisional',ioControls:controls,storageBudget:budget,
  timeoutMs:30000,allowUnsupportedPlatformForTests:true,seams:host.seams});
 const handle=(await launcher.prepare({unitName,payload})).spawnPrepared();await handle.ready;handle.release();
 const frame={version:'synthetic-transport-frame',result:{evaluator_admission:false}};
 host.child.stdout.emit('data',Buffer.from(`QUANT_PROFILE_ACCEPTED_V2 ${hash(payload)}\n${canonical(frame)}\n`));
 assert.deepEqual(await handle.accepted,{unitName,payloadHash:hash(payload)});assert.deepEqual(await handle.profileResult,frame);
 host.child.emit('close',0,null);assert.equal(await handle.closed,0);
 assert.equal(handle.childDiagnostic().code,'UNKNOWN');assert.equal(handle.childDiagnostic().exitStatus,0);
 assert.equal(host.log.some(line=>line.startsWith('child.kill')),false);
});
/** FTR-1c-D F1: prepare() refuses a host whose vm sysctls the drain cannot cover. To exercise the terminate-time
 * re-check, the host passes prepare() with the default sysctls and then drifts to `options` once the unit is ready.
 */
function driftedHost(options){
  const host=fakeHost();
  host.postReady=()=>Object.assign(host,options);
  return host;
}

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
const drainOptions=(terminalDrainMs=20000)=>({timeoutMs:70000,launcher:{terminalDrainMs}});
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

test('drain floor: a clean cgroup waits STAT_FRESH_MS after the barrier finished, not after the freeze',async()=>{
  // Barrier 40 ms: polls at 40, 540, ... The first poll >= 40 + 2500 is 2540, and that is where the drain exits.
  const host=fakeHost({barrier:{mode:'settle',ms:40}});
  const {result}=await terminateWith(host,drainOptions(7500));
  assert.equal(result.measured,true);
  const evidence=result.readbackEvidence;
  assert.equal(evidence.drainMs,2540);assert.equal(evidence.drainPolls,6);
  assert.equal(evidence.barrierMs,40);assert.equal(evidence.requiredDrainMs,7000);
  assert.equal(sleepCount(host.log,500),5);
  assert.ok(host.log.lastIndexOf('sleep 500')<host.log.indexOf(ioLine));
  // A slower barrier moves the floor with it: done at 1000, so the floor is 3500. A floor measured from the
  // freeze (2500) would already have exited at 2500.
  const slow=fakeHost({barrier:{mode:'settle',ms:1000}});
  const {result:late}=await terminateWith(slow,drainOptions(7500));
  assert.equal(late.measured,true);
  assert.equal(late.readbackEvidence.drainMs,3500);assert.equal(late.readbackEvidence.drainPolls,6);
  assert.equal(late.readbackEvidence.barrierMs,1000);
});

test('drain does not exit at the floor while dirty pages are present; it exits on the first settled clean read',async()=>{
  // Clean at freeze, dirty from 1 s to 9 s, clean again. The 2.5 s floor is reached while dirty, so exit waits for 9 s.
  const host=fakeHost({dirty:now=>now>=1000&&now<9000?4096:0});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,true);
  assert.equal(result.readbackEvidence.drainMs,9000);assert.notEqual(result.readbackEvidence.drainMs,2500);
  assert.equal(result.readbackEvidence.drainPolls,19);
});

test('barrier exposure: pages the fsync exposes are waited out, so the drain outlasts the exposure',async()=>{
  // The cgroup is clean until the barrier finishes; the barrier then exposes 8192 dirty bytes for 31 s.
  // Without the barrier the drain would have exited at its floor with the dirty bytes still hidden.
  const host=fakeHost({barrier:{mode:'settle',ms:40},
    dirty:now=>host.barrierDoneAt!==null&&now<host.barrierDoneAt+31000?8192:0});
  const {result}=await terminateWith(host,drainOptions(45000));
  assert.equal(result.measured,true);
  assert.equal(result.readbackEvidence.drainMs,31040);assert.ok(result.readbackEvidence.drainMs>=31000);
  assert.equal(host.syncCalls.length,1);
  const hidden=fakeHost({dirty:0});
  const {result:quick}=await terminateWith(hidden,drainOptions(45000));
  assert.equal(quick.readbackEvidence.drainMs,2500);
});

test('host model: 3000/500 sysctls need the whole 45 s and a drain that clears at 35 s is measured',async()=>{
  const host=fakeHost({vmExpire:'3000\n',vmWriteback:'500\n',dirty:now=>now<35000?12288:0});
  const {result}=await terminateWith(host,drainOptions(45000));
  assert.equal(result.measured,true);
  const evidence=result.readbackEvidence;
  assert.equal(evidence.requiredDrainMs,45000);assert.equal(evidence.drainMs,35000);
  assert.ok(evidence.drainMs<=38000);assert.equal(evidence.barrierMs,0);
  assert.equal(evidence.fileDirty,0);assert.equal(evidence.fileWriteback,0);
  assert.equal(stopCount(host.log),1);
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
    assert.deepEqual(result.diagnostic,{version:'quant-io-terminal-diagnostic-v2',stage:'DRAIN',
      fileDirty:dirty,fileWriteback:writeback,memoryReads:21,sinceFreezeMs:10000,barrierMs:0,requiredDrainMs:7000,
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
  const host=fakeHost({dirty:now=>now>=3000?4096:0});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,false);assert.equal(result.reason,'WRITEBACK_PENDING');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  const {diagnostic}=result;
  assert.equal(diagnostic.stage,'QUIESCENCE');
  assert.equal(diagnostic.fileDirty,4096);assert.equal(diagnostic.fileWriteback,0);
  // 6 drain polls, then quiescence read 1 (clean, 2500 ms) and read 2 (dirty, 5000 ms).
  assert.equal(diagnostic.memoryReads,8);assert.equal(diagnostic.sinceFreezeMs,5000);
  assert.equal(diagnostic.drain.durationMs,2500);assert.equal(diagnostic.drain.polls,6);
  assert.equal(diagnostic.drain.firstZeroMs,0);
  assert.equal(diagnostic.barrierMs,0);assert.equal(diagnostic.requiredDrainMs,7000);
});

test('dirty pages that never clear fall back WRITEBACK_PENDING at freeze + drain, at most one poll late',async()=>{
  const host=fakeHost({barrier:{mode:'settle',ms:40},dirty:12288});
  const {result}=await terminateWith(host,drainOptions(9000));
  assert.equal(result.measured,false);assert.equal(result.reason,'WRITEBACK_PENDING');
  assert.ok(host.now>=9000&&host.now<=9000+500);
  assert.equal(host.log.includes('commit'),false);assert.equal(host.log.includes(ioLine),false);
  assert.equal(stopCount(host.log),1);assert.equal(result.stopProof.unitStopped,true);
  assert.equal(result.diagnostic.stage,'DRAIN');assert.equal(result.diagnostic.barrierMs,40);
  assert.equal(result.diagnostic.maxDirty,undefined);assert.equal(result.diagnostic.drain.maxDirty,12288);
});

test('stop() during the drain aborts it within one poll and shares the single stop proof',async()=>{
  const host=fakeHost({dirty:8192});
  const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:40000}});
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

test('terminalDrainMs and timeoutMs are validated; the drain and the tail margin are charged against the runtime',async()=>{
  const make=options=>createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,
    seams:fakeHost().seams,...(options.terminalDrainMs>0?{storageBudget:fakeBudget(fakeHost())}:{}),...options});
  const rejected={code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'};
  for(const bad of [1000,4999,45001,50000,-1,'40000',NaN,null,5000.5,Infinity])
    assert.throws(()=>make({timeoutMs:70000,terminalDrainMs:bad}),rejected,String(bad));
  for(const good of [0,5000,7500,40000,45000])assert.doesNotThrow(()=>make({timeoutMs:70000,terminalDrainMs:good}));
  assert.doesNotThrow(()=>make({timeoutMs:70000}));
  // The runtime cap is 70,000 ms so the host-required 45 s drain still fits. Drain 0 keeps its old freedom.
  assert.doesNotThrow(()=>make({timeoutMs:70000,terminalDrainMs:45000}));
  assert.doesNotThrow(()=>make({timeoutMs:60001}));
  for(const timeoutMs of [70001,75000,99])assert.throws(()=>make({timeoutMs}),rejected,String(timeoutMs));
  assert.throws(()=>make({timeoutMs:70001,terminalDrainMs:45000}),rejected);
  // The drain needs a StorageBudget for its commit barrier.
  assert.throws(()=>createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,
    seams:fakeHost().seams,timeoutMs:70000,terminalDrainMs:40000}),rejected);
  assert.throws(()=>createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,
    seams:fakeHost().seams,timeoutMs:70000,terminalDrainMs:40000,storageBudget:{root:storageRoot}}),
    {code:'QUANT_IO_READINESS_CONFIGURATION_REQUIRED'});
  // Constructor rule: ceil(timeoutMs to 1 s) must exceed 5 s budget + drain + 5 s spawn margin + 5 s tail margin.
  for(const [timeoutMs,terminalDrainMs] of [[30000,40000],[45000,40000],[50000,40000],[55000,40000],[22000,7500],
    [55000,45000],[56000,45000],[58000,45000],[60000,45000]])
    assert.throws(()=>make({timeoutMs,terminalDrainMs}),rejected,timeoutMs+'/'+terminalDrainMs);
  for(const [timeoutMs,terminalDrainMs] of [[55001,40000],[56000,40000],[22001,7500],[60001,45000],[61000,45000],
    [70000,45000],[5000,0],[30000,0]])
    assert.doesNotThrow(()=>make({timeoutMs,terminalDrainMs}),timeoutMs+'/'+terminalDrainMs);
});

test('terminate refuses RUNTIME_LIMIT_NEAR when budget + drain + tail margin no longer fit; no freeze, one stop',async()=>{
  // 56,000 ms holds 5 s budget + 40 s drain + 5 s tail only for the first 6 s after spawn.
  for(const [startedAt,near] of [[6000,true],[5999,false]]){
    const host=fakeHost();
    const handle=await spawnHandle(host,{timeoutMs:56000,launcher:{terminalDrainMs:40000}});
    host.now=startedAt;
    const result=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
    if(near){
      assert.equal(result.reason,'RUNTIME_LIMIT_NEAR');assert.equal(result.measured,false);
      assert.equal(host.log.some(line=>line.includes('--user freeze')),false);
      assert.equal(host.log.some(line=>line.includes('dirty_expire_centisecs')),false);
      assert.equal(host.syncCalls.length,0);assert.equal(host.log.includes('commit'),false);
      assert.equal(stopCount(host.log),1);assert.equal(result.diagnostic,undefined);
    }else{
      assert.equal(result.measured,true,'one millisecond earlier still fits');assert.equal(result.reason,undefined);
    }
  }
  // At the 70,000 ms cap with the 45 s drain the spawn-to-terminate window is 15 s.
  for(const [startedAt,near] of [[15000,true],[14999,false]]){
    const host=fakeHost({vmExpire:'3000\n',vmWriteback:'500\n'});
    const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:45000}});
    host.now=startedAt;
    const result=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
    assert.equal(result.reason==='RUNTIME_LIMIT_NEAR',near,String(startedAt));
    assert.equal(result.measured,!near);assert.equal(stopCount(host.log),1);
  }
  // Drain 0 keeps the FTR-1 precheck: no tail margin.
  const plain=fakeHost();
  const handle=await spawnHandle(plain,{timeoutMs:6000});
  plain.now=999;
  assert.equal((await handle.terminate({bound})).reason,undefined);
});

test('systemd-run arguments: RuntimeMaxSec follows the cap; KillSignal=SIGKILL is present for drained units only',async()=>{
  const argsFor=async(timeoutMs,launcherOptions)=>{
    const host=fakeHost();let args=null;
    const spawnCapture=(file,spawnArgs)=>{args=spawnArgs;return host.child;};
    const drained=launcherOptions.terminalDrainMs>0;
    const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs,allowUnsupportedPlatformForTests:true,
      seams:{...host.seams,spawn:spawnCapture},...(drained?{storageBudget:fakeBudget(host)}:{}),...launcherOptions});
    if(drained)(await launcher.prepare({unitName})).spawnPrepared();else launcher.spawnPrepared({unitName});
    return args;
  };
  const plain=await argsFor(60000,{});
  assert.ok(plain.includes('--property=RuntimeMaxSec=60'));
  assert.equal(plain.some(argument=>argument.startsWith('--property=KillSignal')),false);
  assert.ok(plain.includes('--property=KillMode=control-group'));
  const zero=await argsFor(60000,{terminalDrainMs:0});
  assert.deepEqual(zero,plain);
  const drained=await argsFor(70000,{terminalDrainMs:45000});
  assert.ok(drained.includes('--property=RuntimeMaxSec=70'));
  assert.equal(drained.filter(argument=>argument==='--property=KillSignal=SIGKILL').length,1);
  assert.ok(drained.includes('--property=KillMode=control-group'));
  // I2: swap is off for drained units only, next to KillSignal; drain 0 keeps the byte-identical argv.
  assert.equal(drained.filter(argument=>argument==='--property=MemorySwapMax=0').length,1);
  assert.equal(drained.indexOf('--property=MemorySwapMax=0'),drained.indexOf('--property=KillSignal=SIGKILL')+1);
  assert.equal(plain.some(argument=>argument.startsWith('--property=MemorySwap')),false);
  assert.equal(zero.some(argument=>argument.startsWith('--property=MemorySwap')),false);
});

test('diagnostic key set is exact and holds only integers, booleans, null and fixed enums',async()=>{
  const host=fakeHost({dirty:now=>now<2000?12288:8192});
  const {result}=await terminateWith(host,drainOptions(10000));
  const {diagnostic}=result;
  assert.deepEqual(Object.keys(diagnostic),['version','stage','fileDirty','fileWriteback','memoryReads',
    'sinceFreezeMs','barrierMs','requiredDrainMs','drain']);
  assert.equal(diagnostic.version,'quant-io-terminal-diagnostic-v2');
  assert.equal(diagnostic.barrierMs,0);assert.equal(diagnostic.requiredDrainMs,7000);
  assert.deepEqual(Object.keys(diagnostic.drain),['enabled','durationMs','polls','maxDirty','maxWriteback',
    'firstZeroMs','series']);
  const enums=new Set(['quant-io-terminal-diagnostic-v2','DRAIN','QUIESCENCE']);
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
  // With the drain on, the drain already supplies freshness (2500 ms after the barrier finished).
  host=fakeHost({rate:5242880});
  ({result}=await terminateWith(host,{ioControls:fast,...drainOptions(7500)}));
  assert.equal(result.measured,true);assert.ok(result.readbackEvidence.statFreshMs>=2500);
  assert.equal(result.readbackEvidence.drainMs,2500);assert.equal(result.readbackEvidence.statFreshMs,2750);
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
  // The all-zero io.stat row only appears after the readiness gate, which needs a readable counter row.
  const zeroRow=fakeHost({counters:{read:0,write:0}});
  zeroRow.postReady=()=>{zeroRow.zeroRow=true;};
  const cases=[['NO_QUIESCENCE',growing,{}],
    ['IDENTITY_CHANGED',startTicks,{}],
    ['COMMIT_FAILED',fakeHost(),{terminate:{commit:async()=>{throw Error('db down');}}}],
    ['counter_parse',zeroRow,{}]];
  for(const [reason,host,extra] of cases){
    const {result}=await terminateWith(host,{...drainOptions(),...extra});
    assert.equal(result.measured,false,reason);assert.equal(result.reason,reason);
    assert.equal(result.diagnostic.stage,'QUIESCENCE',reason);
    assert.equal(result.diagnostic.drain.polls,6,reason);assert.equal(result.diagnostic.drain.durationMs,2500,reason);
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
  const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:40000}});
  let requestedAt=null,stopping=null;
  // Counters keep growing after the drain, so quiescence cannot settle. The stop arrives at the first quiescence sleep.
  host.afterSleep=()=>{
    if(host.now>2500)host.counters.write+=4096;
    if(requestedAt===null&&host.now>=3000){requestedAt=host.now;stopping=handle.stop();}
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
  host.afterSleep=()=>{if(host.now>2500)host.counters.write+=4096;};
  const {result}=await terminateWith(host,drainOptions(40000));
  assert.equal(result.measured,false);assert.equal(result.reason,'NO_QUIESCENCE');
  assert.equal(result.diagnostic.stage,'QUIESCENCE');
  // The drain leaves at 2500. Quiescence gets budgetMs (5000): reads at 2500, 5000 and 7500, never later.
  assert.equal(host.log.filter(line=>line===ioLine).length,3);assert.ok(host.now<=2500+5000);
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

test('stop requested before the freeze aborts with no freeze, no barrier and no memory reads (RD-4)',async()=>{
  // Case 1: the stop lands right after terminate() starts. The pre-freeze steps still await, so it is seen
  // before the freeze command.
  const host=fakeHost({dirty:8192});
  const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:20000}});
  const pending=handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  const stopping=handle.stop();
  const terminal=await pending;
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(await stopping,terminal.stopProof);
  assert.equal(host.log.some(line=>line.includes('--user freeze')),false);
  assert.equal(host.syncCalls.length,0);assert.equal(host.log.includes(ioLine),false);
  assert.equal(host.log.filter(line=>line===memoryLine).length,0);assert.equal(sleepCount(host.log,500),0);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  // Nothing was frozen, so there is no drain series to report.
  assert.equal(terminal.diagnostic,undefined);
  // Case 2: the stop lands while the last pre-freeze read is in flight, after the plan and the root were read.
  const late=fakeHost();
  const lateHandle=await spawnHandle(late,{timeoutMs:70000,launcher:{terminalDrainMs:20000}});
  let lateStop=null;
  late.beforeRead=file=>{if(file.endsWith('dirty_writeback_centisecs')&&lateStop===null)lateStop=lateHandle.stop();};
  const lateTerminal=await lateHandle.terminate({bound,commit:async()=>{late.log.push('commit');}});
  assert.equal(lateTerminal.reason,'STOP_REQUESTED');assert.equal(await lateStop,lateTerminal.stopProof);
  assert.equal(late.log.some(line=>line.includes('--user freeze')),false);assert.equal(late.syncCalls.length,0);
  assert.equal(stopCount(late.log),1);assert.equal(lateTerminal.diagnostic,undefined);
});

test('thaw during quiescence fails NOT_FROZEN with a QUIESCENCE-stage diagnostic (F4)',async()=>{
  const host=fakeHost();
  // The drain leaves at 2500; the unit thaws before the second quiescence read at 5000.
  host.afterSleep=()=>{if(host.now>=3000)host.phase='live';};
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,false);assert.equal(result.reason,'NOT_FROZEN');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  const {diagnostic}=result;
  assert.equal(diagnostic.stage,'QUIESCENCE');
  assert.equal(diagnostic.fileDirty,0);assert.equal(diagnostic.fileWriteback,0);
  // 6 drain polls plus the clean first quiescence read; the thawed second read is rejected before parsing.
  assert.equal(diagnostic.memoryReads,7);assert.equal(diagnostic.drain.polls,6);
  assert.equal(diagnostic.drain.durationMs,2500);
});

test('malformed memory.stat during quiescence reports MEMORY_STAT_INVALID only with the drain on (F7)',async()=>{
  const memoryStat=now=>now>=3000?'anon 1\n':'file_dirty 0\nfile_writeback 0\n';
  const host=fakeHost({memoryStat});
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,false);assert.equal(result.reason,'MEMORY_STAT_INVALID');
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(result.diagnostic.stage,'QUIESCENCE');
  assert.equal(result.diagnostic.fileDirty,null);assert.equal(result.diagnostic.fileWriteback,null);
  assert.equal(result.diagnostic.memoryReads,7);
  // Drain off keeps the FTR-1 reason and the FTR-1 shape (no diagnostic).
  const plain=fakeHost({memoryStat:'anon 1\n'});
  const {result:legacy}=await terminateWith(plain);
  assert.equal(legacy.reason,'WRITEBACK_PENDING');assert.equal(legacy.diagnostic,undefined);
  assert.deepEqual(Object.keys(legacy).sort(),['measured','postExit','reason','stopProof']);
});

// ---- FTR-1c commit barrier, host-derived drain bound and the tail margin ----
const eventsLine='read '+cgroupBase+'/cgroup.events';
const freezeLine='command systemctl --user freeze '+unitName;
const freezerLine='command systemctl --user show '+unitName+' --property=FreezerState';
const syncLine='syncDirectory '+storageRoot+' '+rootIdentity.dev+':'+rootIdentity.ino;

test('drained call order: vm sysctls, root lstat, freeze, frozen 1, barrier, polls, phase-5 reads, commit, stop',async()=>{
  const host=fakeHost({barrier:{mode:'settle',ms:40}});
  const {result}=await terminateWith(host,drainOptions(20000));
  assert.equal(result.measured,true);
  const log=host.log,index=line=>{const found=log.indexOf(line);assert.ok(found>=0,line);return found;};
  const order=[index('read /proc/sys/vm/dirty_expire_centisecs'),index('read /proc/sys/vm/dirty_writeback_centisecs'),
    index('lstat '+storageRoot),index(freezeLine),index(eventsLine),index(freezerLine),index(syncLine),
    log.indexOf(memoryLine),log.indexOf(ioLine),index('commit'),log.findIndex(line=>line.startsWith('stopUnit'))];
  assert.deepEqual([...order].sort((a,b)=>a-b),order,'strictly ordered');
  assert.equal(new Set(order).size,order.length);
  // One barrier, on the storage root, with the identity read before the freeze, and only once the unit is frozen.
  assert.equal(host.syncCalls.length,1);assert.equal(log.filter(line=>line.startsWith('syncDirectory')).length,1);
  assert.deepEqual(host.syncCalls[0],{root:storageRoot,identity:rootIdentity,phase:'frozen'});
  assert.equal(stopCount(log),1);assert.equal(log.filter(line=>line===freezeLine).length,1);
  // The digest input has no barrier field: same digest as the drain-off terminal.
  const plain=await terminateWith(fakeHost());
  assert.equal(digestOf(result),digestOf(plain.result));
  assert.deepEqual(Object.keys(result.readbackEvidence).slice(-5),
    ['drainMs','drainPolls','statFreshMs','barrierMs','requiredDrainMs']);
  assert.equal(JSON.stringify(plain.result.readbackEvidence).includes('barrierMs'),false);
});

test('every drained phase-5 read takes cgroup.events, then memory.stat to completion, then io.stat',async()=>{
  const host=fakeHost({dirty:now=>now<1000?4096:0});
  const original=host.seams.readFile,doneMemory='done '+memoryLine;
  // memory.stat resolves a macrotask late: a parallel io.stat read would start, and even finish, before it.
  host.seams.readFile=async(file,encoding)=>{
    const value=await original(file,encoding);
    if(file===cgroupBase+'/memory.stat'){await new Promise(resolve=>setImmediate(resolve));host.log.push(doneMemory);}
    return value;
  };
  const {result}=await terminateWith(host,drainOptions());
  assert.equal(result.measured,true);
  const ioReads=host.log.map((line,index)=>line===ioLine?index:-1).filter(index=>index>=0);
  assert.equal(ioReads.length,2);
  for(const at of ioReads){
    const done=host.log.lastIndexOf(doneMemory,at);
    assert.ok(done>=2,'memory.stat completed before io.stat');
    assert.equal(host.log[done-1],memoryLine);assert.equal(host.log[done-2],eventsLine);
    assert.deepEqual(host.log.slice(done+1,at),['read '+cgroupBase+'/io.max']);
  }
  // Drain polls are events then memory.stat with no io.stat at all.
  const firstIo=ioReads[0];
  assert.equal(host.log.slice(0,firstIo).filter(line=>line===doneMemory).length,host.log.slice(0,firstIo).filter(line=>line===memoryLine).length);
});

test('commit barrier failure or timeout ends the drain before any memory.stat poll, commit or thaw',async()=>{
  const rejecting=fakeHost({barrier:{mode:'reject',ms:30}});
  const {result:failed}=await terminateWith(rejecting,drainOptions());
  assert.equal(failed.measured,false);assert.equal(failed.reason,'COMMIT_BARRIER_FAILED');
  assert.equal(rejecting.log.filter(line=>line===memoryLine).length,0);
  assert.equal(rejecting.log.includes('commit'),false);assert.equal(stopCount(rejecting.log),1);
  assert.equal(failed.stopProof.unitStopped,true);assert.equal(rejecting.log.includes(ioLine),false);
  assert.equal(failed.diagnostic.stage,'DRAIN');assert.equal(failed.diagnostic.barrierMs,null);
  assert.equal(failed.diagnostic.requiredDrainMs,7000);assert.equal(failed.diagnostic.memoryReads,0);
  assert.equal(failed.diagnostic.drain.polls,0);
  // A barrier that never settles is cut at 2000 ms, within one poll, and its late outcome is swallowed.
  for(const late of ['resolve','reject']){
    const hanging=fakeHost({barrier:{mode:'never'}});
    const {result:timedOut}=await terminateWith(hanging,drainOptions());
    assert.equal(timedOut.measured,false);assert.equal(timedOut.reason,'COMMIT_BARRIER_TIMEOUT');
    assert.ok(hanging.now>=2000&&hanging.now<=2000+500);
    assert.equal(hanging.log.filter(line=>line===memoryLine).length,0);
    assert.equal(hanging.log.includes('commit'),false);assert.equal(stopCount(hanging.log),1);
    assert.equal(timedOut.stopProof.unitStopped,true);
    assert.equal(timedOut.diagnostic.stage,'DRAIN');assert.equal(timedOut.diagnostic.barrierMs,null);
    hanging.barrierLate[late](Object.assign(new Error('late'),{code:'EIO'}));
    await new Promise(resolve=>setImmediate(resolve));
  }
});

test('a storage root that is a symlink, not a directory or unreadable never freezes',async()=>{
  for(const rootStat of ['symlink','file','missing']){
    const host=fakeHost({rootStat});
    const {result}=await terminateWith(host,drainOptions());
    assert.equal(result.measured,false,rootStat);assert.equal(result.reason,'COMMIT_BARRIER_FAILED',rootStat);
    assert.equal(host.log.some(line=>line.includes('--user freeze')),false,rootStat);
    assert.equal(host.syncCalls.length,0,rootStat);assert.equal(host.log.includes('commit'),false,rootStat);
    assert.equal(stopCount(host.log),1,rootStat);assert.equal(result.stopProof.unitStopped,true,rootStat);
    assert.equal(result.diagnostic,undefined,rootStat);
  }
});

test('a drain shorter than the host writeback model needs falls back DRAIN_UNDERSIZED with no freeze or barrier',async()=>{
  const cases=[
    ['3000/500 needs 45000, drain 40000',{vmExpire:'3000\n',vmWriteback:'500\n'},40000],
    ['3000/500 needs 45000, drain 44999',{vmExpire:'3000\n',vmWriteback:'500\n'},44999],
    ['writeback 0 has no bound',{vmExpire:'3000\n',vmWriteback:'0\n'},45000],
    ['writeback 0 and expire 0',{vmExpire:'0',vmWriteback:'0'},45000]];
  for(const [name,options,drain] of cases){
    const host=driftedHost(options);
    const {result}=await terminateWith(host,drainOptions(drain));
    assert.equal(result.measured,false,name);assert.equal(result.reason,'DRAIN_UNDERSIZED',name);
    assert.equal(host.log.some(line=>line.includes('--user freeze')),false,name);
    assert.equal(host.syncCalls.length,0,name);assert.equal(host.log.includes('lstat '+storageRoot),false,name);
    assert.equal(host.log.includes('commit'),false,name);assert.equal(stopCount(host.log),1,name);
    assert.equal(result.stopProof.unitStopped,true,name);assert.equal(result.stopProof.launcherClosed,true,name);
    assert.equal(result.diagnostic,undefined,name);assert.equal(result.frozenSample,undefined,name);
  }
  // The same host at exactly the required drain is measured.
  const fits=fakeHost({vmExpire:'3000\n',vmWriteback:'500\n'});
  assert.equal((await terminateWith(fits,drainOptions(45000))).result.measured,true);
});

test('unreadable or malformed vm sysctls fall back HOST_WRITEBACK_UNAVAILABLE before any freeze',async()=>{
  const eio=()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});};
  const cases=[['expire missing',{vmExpire:null}],['writeback missing',{vmWriteback:null}],
    ['expire unreadable',{vmExpire:eio}],['writeback empty',{vmWriteback:''}],['expire garbage',{vmExpire:'abc\n'}],
    ['expire negative',{vmExpire:'-5\n'}],['writeback two lines',{vmWriteback:'500\n500\n'}],
    ['expire scientific',{vmExpire:'1e3\n'}],['expire over a day',{vmExpire:'8640001\n'}],
    ['writeback leading zero',{vmWriteback:'05\n'}]];
  for(const [name,options] of cases){
    const host=driftedHost(options);
    const {result}=await terminateWith(host,drainOptions());
    assert.equal(result.measured,false,name);assert.equal(result.reason,'HOST_WRITEBACK_UNAVAILABLE',name);
    assert.equal(host.log.some(line=>line.includes('--user freeze')),false,name);
    assert.equal(host.syncCalls.length,0,name);assert.equal(host.log.includes('commit'),false,name);
    assert.equal(stopCount(host.log),1,name);assert.equal(result.diagnostic,undefined,name);
  }
});

test('stop() while the barrier is pending ends the drain within the barrier budget and one poll',async()=>{
  const host=fakeHost({barrier:{mode:'settle',ms:1500}});
  const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:20000}});
  let stopping=null;
  host.onBarrier=()=>{stopping=handle.stop();};
  const terminal=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  assert.notEqual(stopping,null);
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(await stopping,terminal.stopProof);assert.equal(await handle.stop(),terminal.stopProof);
  assert.ok(host.now<=2000+500,'ended within barrier budget + one poll');
  assert.equal(host.log.filter(line=>line===memoryLine).length,0);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(host.log.filter(line=>line===freezeLine).length,1);
  assert.equal(terminal.diagnostic.stage,'DRAIN');assert.equal(terminal.diagnostic.barrierMs,1500);
});

test('drain 0 never reads the vm sysctls, the storage root or the barrier; its phase-5 reads stay parallel',async()=>{
  const host=fakeHost();
  const {result}=await terminateWith(host);
  assert.equal(result.measured,true);
  assert.equal(host.syncCalls.length,0);
  assert.equal(host.log.some(line=>line.includes('/proc/sys/vm')||line.startsWith('lstat')||
    line.startsWith('syncDirectory')||line==='sleep 2000'),false);
  assert.deepEqual(Object.keys(result.readbackEvidence).slice(-3),['drainMs','drainPolls','statFreshMs']);
  // The whole call log equals the recorded pre-FTR-1b flow, including the Promise.all read order of phase 5.
  assert.deepEqual(host.log,expandGolden(GOLDEN_MEASURED));
  // A drain-off launcher works without a StorageBudget and ignores a missing root or sysctls entirely.
  const bare=fakeHost({vmExpire:null,vmWriteback:null,rootStat:'missing'});
  assert.equal((await terminateWith(bare)).result.measured,true);
  assert.equal(bare.syncCalls.length,0);
});

// The default barrier opens a directory descriptor, so it only runs on Linux (the fake host covers the flow).
test('default commit barrier fsyncs the exact storage root directory and refuses any other target',
  {skip:process.platform!=='linux'&&'directory fsync by descriptor needs Linux'},async()=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ftr1c-sync-'));
    const link=directory+'-link';
    try{
      const {dev,ino}=await fs.lstat(directory);
      await syncStorageDirectory(directory,{dev,ino});
      for(const expected of [{dev,ino:ino+1},{dev:dev+1,ino},{dev:0,ino:0},null,undefined])
        await assert.rejects(syncStorageDirectory(directory,expected),{code:'COMMIT_BARRIER_FAILED'});
      await fs.symlink(directory,link);
      await assert.rejects(syncStorageDirectory(link,{dev,ino}),error=>['ELOOP','ENOTDIR'].includes(error.code));
      const file=path.join(directory,'plain');
      await fs.writeFile(file,'x');
      await assert.rejects(syncStorageDirectory(file,{dev,ino}),{code:'ENOTDIR'});
      await assert.rejects(syncStorageDirectory(path.join(directory,'missing'),{dev,ino}),{code:'ENOENT'});
    }finally{
      await fs.rm(link,{force:true});
      await fs.rm(directory,{recursive:true,force:true});
    }
  });

// ---- FTR-1c-D hardening: pre-spawn host gate (F1, F2), post-freeze stop (F3), full-length drain tail (F4) ----
/** prepare() with call counters, so a refusal can prove no reservation and no spawn happened. */
function prepareCounted(host,{timeoutMs=70000,terminalDrainMs=20000}={}){
  const counts={reserve:0,spawn:0};
  const budget=fakeBudget(host),reserve=budget.reserve;
  budget.reserve=async(...values)=>{counts.reserve+=1;return reserve(...values);};
  const seams={...host.seams,spawn:(...values)=>{counts.spawn+=1;return host.seams.spawn(...values);}};
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs,terminalDrainMs,storageBudget:budget,
    allowUnsupportedPlatformForTests:true,seams});
  return {counts,prepared:()=>launcher.prepare({unitName})};
}
const configurationRefused={code:'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED'};

test('prepare refuses a drained launch whose vm sysctls the drain cannot cover: no reservation, no spawn (F1)',async()=>{
  const eio=()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});};
  const cases=[
    ['3000/500 needs 45000, drain 40000',{vmExpire:'3000\n',vmWriteback:'500\n'},40000],
    ['3000/500 needs 45000, drain 44999',{vmExpire:'3000\n',vmWriteback:'500\n'},44999],
    ['writeback 0 has no bound',{vmExpire:'3000\n',vmWriteback:'0\n'},45000],
    ['expire missing',{vmExpire:null},20000],['writeback missing',{vmWriteback:null},20000],
    ['expire unreadable',{vmExpire:eio},20000],['writeback empty',{vmWriteback:''},20000],
    ['expire garbage',{vmExpire:'abc\n'},20000],['writeback two lines',{vmWriteback:'500\n500\n'},20000],
    ['expire over a day',{vmExpire:'8640001\n'},20000]];
  for(const [name,options,terminalDrainMs] of cases){
    const host=fakeHost(options);
    const {counts,prepared}=prepareCounted(host,{terminalDrainMs});
    await assert.rejects(prepared(),configurationRefused,name);
    assert.equal(counts.reserve,0,name);assert.equal(counts.spawn,0,name);
    assert.equal(host.log.some(line=>line.includes('--user freeze')||line.startsWith('stopUnit')),false,name);
  }
  // Exactly the required drain is accepted. The terminate-time re-check still covers a host that drifts later.
  const fits=fakeHost({vmExpire:'3000\n',vmWriteback:'500\n'});
  const {counts,prepared}=prepareCounted(fits,{terminalDrainMs:45000});
  const preparation=await prepared();
  assert.equal(counts.reserve,1);assert.equal(counts.spawn,0);
  await preparation.abort();
  assert.equal(fits.log.filter(line=>line==='read /proc/sys/vm/dirty_expire_centisecs').length,1);
  assert.equal(fits.log.filter(line=>line==='read /proc/sys/vm/dirty_writeback_centisecs').length,1);
});

test('prepare requires an ext4 storage root for a drained launch and refuses statfs errors (F2)',async()=>{
  const eio=Object.assign(new Error('EIO'),{code:'EIO'});
  const refused=[['xfs',{fsType:0x58465342}],['btrfs',{fsType:0x9123683E}],['tmpfs',{fsType:0x01021994}],
    ['not the ext4 magic',{fsType:0xEF51}],['type missing',{fsType:undefined}],['type as string',{fsType:'61267'}],
    ['statfs error',{statfsError:eio}]];
  for(const [name,options] of refused){
    const host=fakeHost(options);
    const {counts,prepared}=prepareCounted(host);
    await assert.rejects(prepared(),configurationRefused,name);
    assert.equal(counts.reserve,0,name);assert.equal(counts.spawn,0,name);
    assert.deepEqual(host.log.filter(line=>line.startsWith('statfs')),['statfs '+storageRoot],name);
  }
  const host=fakeHost();
  const {counts,prepared}=prepareCounted(host);
  const preparation=await prepared();
  assert.equal(counts.reserve,1);assert.equal(typeof preparation.spawnPrepared,'function');
  assert.deepEqual(host.log.filter(line=>line.startsWith('statfs')),['statfs '+storageRoot]);
  await preparation.abort();
});

test('a filesystem that changes or a statfs that fails after prepare fails closed before any freeze (F2)',async()=>{
  const eio=Object.assign(new Error('EIO'),{code:'EIO'});
  for(const [name,mutate] of [['xfs',host=>{host.fsType=0x58465342;}],
    ['statfs error',host=>{host.statfsError=eio;}]]){
    const host=fakeHost();
    const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:20000}});
    mutate(host);
    const result=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
    assert.equal(result.measured,false,name);assert.equal(result.reason,'COMMIT_BARRIER_FAILED',name);
    assert.equal(host.log.some(line=>line.includes('--user freeze')),false,name);
    assert.equal(host.syncCalls.length,0,name);assert.equal(host.log.includes('commit'),false,name);
    assert.equal(host.log.filter(line=>line==='statfs '+storageRoot).length,1,name);
    assert.equal(stopCount(host.log),1,name);assert.equal(result.stopProof.unitStopped,true,name);
    assert.equal(result.diagnostic,undefined,name);
  }
  // Order: the lstat root check comes first, so a symlink root keeps its own reason without a statfs call.
  const symlink=fakeHost();
  const handle=await spawnHandle(symlink,{timeoutMs:70000,launcher:{terminalDrainMs:20000}});
  symlink.rootStat='symlink';
  const result=await handle.terminate({bound});
  assert.equal(result.reason,'COMMIT_BARRIER_FAILED');
  assert.equal(symlink.log.some(line=>line.startsWith('statfs')),false);
});

test('drain 0 never calls statfs, in prepare or at terminate, whatever the filesystem (F2)',async()=>{
  const host=fakeHost({fsType:0x58465342,statfsError:new Error('statfs must not run'),vmExpire:null,vmWriteback:null});
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:30000,terminalDrainMs:0,
    storageBudget:fakeBudget(host),allowUnsupportedPlatformForTests:true,seams:host.seams});
  const preparation=await launcher.prepare({unitName});
  const handle=preparation.spawnPrepared();
  await handle.ready;
  const result=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  assert.equal(result.measured,true);
  assert.equal(host.log.some(line=>line.startsWith('statfs')||line.includes('/proc/sys/vm')),false);
  assert.equal(host.syncCalls.length,0);
});

test('a stop between FreezerState=frozen and the barrier ends the drain before the barrier (F3)',async()=>{
  const host=fakeHost({dirty:8192});
  const handle=await spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:20000}});
  let stopping=null;
  // The stop lands as the FreezerState property is read: the freeze is confirmed, the barrier has not started.
  host.onFreezerState=()=>{stopping??=handle.stop();};
  const terminal=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
  assert.notEqual(stopping,null);
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(await stopping,terminal.stopProof);assert.equal(await handle.stop(),terminal.stopProof);
  assert.equal(host.syncCalls.length,0);assert.equal(host.log.some(line=>line.startsWith('syncDirectory')),false);
  assert.equal(host.log.filter(line=>line===freezeLine).length,1);
  assert.ok(host.log.indexOf(freezerLine)>host.log.indexOf(freezeLine));
  assert.equal(host.log.filter(line=>line===memoryLine).length,0);assert.equal(host.log.includes(ioLine),false);
  assert.equal(host.log.includes('commit'),false);assert.equal(stopCount(host.log),1);
  assert.equal(terminal.diagnostic.stage,'DRAIN');assert.equal(terminal.diagnostic.barrierMs,null);
  assert.equal(terminal.diagnostic.memoryReads,0);assert.equal(terminal.diagnostic.drain.polls,0);
});

test('a full-length drain from the latest permitted terminate start commits before runtime - TAIL_MARGIN_MS (F4)',async()=>{
  // Latest permitted start: runtime - (budget 5,000 + drain + tail 5,000) - 1. The host needs the whole drain.
  // cleanAfter is the first clean poll: freeze + drain - 1,000 (the brief case) and freeze + drain - 500, the last
  // poll the drain accepts before it ends at freeze + drain.
  const cases=[{timeoutMs:70000,drain:45000,startedAt:14999,vm:{vmExpire:'3000\n',vmWriteback:'500\n'}},
    {timeoutMs:56000,drain:40000,startedAt:5999,vm:{vmExpire:'2500\n',vmWriteback:'500\n'}}];
  for(const {timeoutMs,drain,startedAt,vm} of cases)for(const cleanAfter of [drain-1000,drain-500]){
    const name=timeoutMs+'/'+drain+' clean at freeze + '+cleanAfter;
    const host=fakeHost({...vm,dirty:now=>now<startedAt+cleanAfter?8192:0});
    const handle=await spawnHandle(host,{timeoutMs,launcher:{terminalDrainMs:drain}});
    host.now=startedAt;
    let committedAt=null;
    const result=await handle.terminate({bound,commit:async()=>{host.log.push('commit');committedAt=host.now;}});
    assert.equal(result.measured,true,name);assert.equal(result.reason,undefined,name);
    assert.equal(result.diagnostic,undefined,name);assert.equal(result.readbackEvidence.requiredDrainMs,drain,name);
    assert.equal(result.readbackEvidence.drainMs,cleanAfter,name);
    // Two identical reads a 2,500 ms window apart follow the drain, so the commit is 2,500 ms after it ends.
    assert.equal(committedAt,startedAt+cleanAfter+2500,name);
    assert.ok(committedAt<=timeoutMs-5000,name+': commit at '+committedAt);
    assert.ok(host.now<=timeoutMs-5000,name);assert.equal(stopCount(host.log),1,name);
  }
});

// ---- W2: terminalPolicy, policy tail margin, terminalLimitMs, drained swap gate, pre-reserve host gate ----
const policyBlock=(runtime,drain,tail)=>({version:'quant-io-terminal-policy-v1',runtime_max_ms:runtime,
  terminal_drain_ms:drain,tail_margin_ms:tail});
/** Launcher built from a terminal policy block. It always gets the fake StorageBudget, drain 0 included. */
function policyLauncher(host,terminal,extra={}){
  return createIoRuntimeLauncher({ioControls:controls,terminalPolicy:terminal,storageBudget:fakeBudget(host),
    allowUnsupportedPlatformForTests:true,seams:host.seams,...extra});
}
async function policyHandle(host,terminal){
  const handle=(await policyLauncher(host,terminal).prepare({unitName})).spawnPrepared();
  await handle.ready;
  host.log.length=0;
  return handle;
}

test('terminalPolicy derives the runtime cap, drain and tail; raw options beside it are refused (T-L2)',async()=>{
  const terminal=policyBlock(70000,45000,5000);
  const host=fakeHost();let args=null;
  const launcher=policyLauncher(host,terminal,{seams:{...host.seams,spawn:(file,spawnArgs)=>{args=spawnArgs;return host.child;}}});
  (await launcher.prepare({unitName})).spawnPrepared();
  assert.ok(args.includes('--property=RuntimeMaxSec=70'));
  assert.equal(args.filter(argument=>argument==='--property=KillSignal=SIGKILL').length,1);
  assert.equal(args.filter(argument=>argument==='--property=MemorySwapMax=0').length,1);
  // The launcher exposes its own frozen, detached copy of the validated block.
  assert.deepEqual(launcher.terminalConfig,terminal);
  assert.ok(Object.isFrozen(launcher.terminalConfig));assert.notEqual(launcher.terminalConfig,terminal);
  // A launcher without a policy exposes none, so the runtime cannot mistake it for a pinned one.
  const legacy=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams:host.seams});
  assert.equal(Object.hasOwn(legacy,'terminalConfig'),false);
  // Raw timing options beside a policy are refused, whatever their value; undefined means absent.
  for(const raw of [{timeoutMs:70000},{timeoutMs:30000},{terminalDrainMs:45000},{terminalDrainMs:0},{tailMarginMs:5000},
    {timeoutMs:70000,terminalDrainMs:45000}])
    assert.throws(()=>policyLauncher(fakeHost(),terminal,raw),configurationRefused,JSON.stringify(raw));
  assert.doesNotThrow(()=>policyLauncher(fakeHost(),terminal,{timeoutMs:undefined,terminalDrainMs:undefined}));
  // The launcher validates the block itself; any invalid block gets the launcher's own refusal code.
  const bad=[null,'x',{},{...terminal,version:'quant-io-terminal-policy-v0'},{...terminal,extra:1},
    {...terminal,runtime_max_ms:69999},policyBlock(60000,45000,5000),policyBlock(70000,4999,5000),
    policyBlock(70000,45001,5000),policyBlock(70000,45000,4999),policyBlock(70001,0,5000),policyBlock(9000,0,5000)];
  for(const value of bad)assert.throws(()=>policyLauncher(fakeHost(),value),configurationRefused,JSON.stringify(value));
  // Drain 0 policy: same RuntimeMaxSec rule, and the drained-only argv stays out.
  const zero=[];
  const zeroLauncher=policyLauncher(host,policyBlock(30000,0,5000),
    {seams:{...host.seams,spawn:(file,spawnArgs)=>{zero.push(spawnArgs);return host.child;}}});
  (await zeroLauncher.prepare({unitName})).spawnPrepared();
  assert.ok(zero[0].includes('--property=RuntimeMaxSec=30'));
  assert.equal(zero[0].some(argument=>argument.startsWith('--property=KillSignal')||argument.startsWith('--property=MemorySwap')),false);
});

test('a launcher built from any accepted policy passes its own constructor rule; rejected blocks never build (TAIL)',()=>{
  let accepted=0,rejected=0;
  for(const runtime of [9000,10000,15000,16000,20000,31000,45000,50000,55000,56000,60000,65000,65001,70000,70001])
    for(const drain of [0,4999,5000,7500,20000,40000,45000,45001])
      for(const tail of [4999,5000,7500,10000,14999,15000,15001]){
        const block=policyBlock(runtime,drain,tail);
        let valid=true;
        try{validateTerminalPolicy(block);}catch{valid=false;}
        const build=()=>policyLauncher(fakeHost(),block);
        if(valid){accepted++;assert.doesNotThrow(build,JSON.stringify(block));}
        else{rejected++;assert.throws(build,configurationRefused,JSON.stringify(block));}
      }
  assert.ok(accepted>100&&rejected>100,accepted+' accepted, '+rejected+' rejected');
});

test('with a policy the tail margin comes from the block, also for drain 0, never from a default (TAIL)',async()=>{
  // Policy 70,000 / 40,000 / 15,000 reserves 5,000 + 40,000 + 15,000 = 60,000 ms, so terminate may start within 10,000 ms
  // of spawn. A raw launcher with the same runtime and drain keeps the default 5,000 tail: its window is 20,000 ms.
  for(const [name,make,startedAt,near] of [
    ['policy tail 15,000, latest start',host=>policyHandle(host,policyBlock(70000,40000,15000)),9999,false],
    ['policy tail 15,000, one ms later',host=>policyHandle(host,policyBlock(70000,40000,15000)),10000,true],
    ['default tail 5,000 at the same instant',host=>spawnHandle(host,{timeoutMs:70000,launcher:{terminalDrainMs:40000}}),10000,false]]){
    const host=fakeHost();
    const handle=await make(host);
    host.now=startedAt;
    const result=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
    assert.equal(result.reason==='RUNTIME_LIMIT_NEAR',near,name);assert.equal(result.measured,!near,name);
    assert.equal(stopCount(host.log),1,name);
    if(near)assert.equal(host.log.some(line=>line.includes('--user freeze')),false,name);
  }
  // Drain 0 with a policy still owes the policy tail: 30,000 - budget 5,000 - tail 7,000 leaves 18,000 ms after spawn.
  for(const [startedAt,near] of [[17999,false],[18000,true]]){
    const host=fakeHost();
    const handle=await policyHandle(host,policyBlock(30000,0,7000));
    host.now=startedAt;
    const result=await handle.terminate({bound});
    assert.equal(result.reason==='RUNTIME_LIMIT_NEAR',near,String(startedAt));assert.equal(result.measured,!near);
    assert.equal(stopCount(host.log),1);
  }
  // A drain-0 launcher without a policy keeps the FTR-1 precheck: no tail margin.
  const plain=fakeHost();
  const handle=await spawnHandle(plain,{timeoutMs:6000});
  plain.now=999;
  assert.equal((await handle.terminate({bound})).reason,undefined);
});

test('terminalLimitMs is the precheck margin on the precheck clock; at 0 terminate refuses RUNTIME_LIMIT_NEAR (T-L3)',async()=>{
  const slow={vmExpire:'3000\n',vmWriteback:'500\n'};
  const cases=[
    ['policy 70/45/5',(host)=>policyHandle(host,policyBlock(70000,45000,5000)),15000,slow],
    ['policy 30/0/7',(host)=>policyHandle(host,policyBlock(30000,0,7000)),18000,{}],
    ['raw 56/40, default tail',(host)=>spawnHandle(host,{timeoutMs:56000,launcher:{terminalDrainMs:40000}}),6000,{}],
    ['raw drain 0, no tail',(host)=>spawnHandle(host,{timeoutMs:6000}),1000,{}]];
  for(const [name,make,window,options] of cases){
    const probe=fakeHost(options);
    const handle=await make(probe);
    for(const startedAt of [0,1234,window-2,window-1,window,window+1,window+500]){
      probe.now=startedAt;
      assert.equal(handle.terminalLimitMs(),window-startedAt,name+' at '+startedAt);
    }
    // The same number decides terminate(): above 0 it measures, at 0 it refuses with no freeze and one stop.
    for(const [startedAt,near] of [[window-1,false],[window,true]]){
      const host=fakeHost(options);
      const runner=await make(host);
      host.now=startedAt;
      assert.equal(runner.terminalLimitMs()<=0,near,name+' limit at '+startedAt);
      const result=await runner.terminate({bound,commit:async()=>{host.log.push('commit');}});
      assert.equal(result.reason==='RUNTIME_LIMIT_NEAR',near,name+' terminate at '+startedAt);
      assert.equal(result.measured,!near,name);assert.equal(stopCount(host.log),1,name);
      if(near)assert.equal(host.log.some(line=>line.includes('--user freeze')),false,name);
    }
  }
});

const swapLine='read '+cgroupBase+'/memory.swap.max',meminfoLine='read /proc/meminfo';
const deniedRead=code=>()=>{throw Object.assign(new Error(code),{code});};
/** Spawns a drained unit and reports how its readiness gate ended. */
async function drainedReady(options){
  const host=fakeHost(options);
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:70000,terminalDrainMs:20000,
    storageBudget:fakeBudget(host),allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=(await launcher.prepare({unitName})).spawnPrepared();
  const outcome=await handle.ready.then(value=>value,error=>error);
  return {host,handle,outcome};
}

test('the drained ready gate needs memory.swap.max exactly 0, or SwapTotal 0 kB when the file does not exist (L3)',async()=>{
  for(const swapMax of ['0\n','0']){
    const {host,outcome}=await drainedReady({swapMax});
    assert.equal(outcome.swapProof,'SWAP_MAX_ZERO',JSON.stringify(swapMax));
    assert.ok(host.log.includes(swapLine));assert.equal(host.log.includes(meminfoLine),false);
    assert.equal(outcome.unitName,unitName);assert.equal(Object.isFrozen(outcome),true);
  }
  // No such file (no swap accounting): only a host without swap proves it. The file read comes first.
  for(const meminfo of ['SwapTotal:             0 kB\n','MemTotal: 8 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n','SwapTotal:\t0 kB']){
    const {host,outcome}=await drainedReady({swapMax:null,meminfo});
    assert.equal(outcome.swapProof,'SWAP_TOTAL_ZERO',JSON.stringify(meminfo));
    assert.ok(host.log.indexOf(swapLine)<host.log.indexOf(meminfoLine));
  }
  // Anything else fails closed with the gate code, and the unit can still be stopped by the caller.
  const refused=[];
  for(const swapMax of ['max\n','1\n','4096\n','0 \n',' 0\n','00\n','0\n0\n','0\n\n','','-0\n','0x0\n','0.0\n'])
    refused.push([JSON.stringify(swapMax),{swapMax}]);
  for(const meminfo of ['SwapTotal: 2097148 kB\n','MemTotal: 8 kB\n','SwapTotal: 0 kB extra\n','SwapTotal: 00 kB\n','SwapTotal: 0 MB\n',
    'swaptotal: 0 kB\n','SwapTotal:0 kB\n','',null,deniedRead('EIO')])
    refused.push(['missing file, meminfo '+String(meminfo),{swapMax:null,meminfo}]);
  // Only ENOENT means "no such file". Any other read error is a refusal, even when meminfo says no swap.
  for(const code of ['EACCES','EIO','EISDIR','ENODEV'])
    refused.push(['swap file '+code,{swapMax:deniedRead(code),meminfo:'SwapTotal: 0 kB\n'}]);
  for(const [name,options] of refused){
    const {host,handle,outcome}=await drainedReady(options);
    assert.equal(outcome.code,'QUANT_IO_GATE_FAILED',name);
    const proof=await handle.stop();
    assert.equal(proof.unitStopped,true,name);assert.equal(stopCount(host.log),1,name);
  }
});

test('an undrained unit never reads memory.swap.max or /proc/meminfo, and its ready result has no swap proof (L3)',async()=>{
  const host=fakeHost({swapMax:'max\n',meminfo:'SwapTotal: 999 kB\n'});
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs:30000,terminalDrainMs:0,
    storageBudget:fakeBudget(host),allowUnsupportedPlatformForTests:true,seams:host.seams});
  const handle=(await launcher.prepare({unitName})).spawnPrepared();
  const ready=await handle.ready;
  assert.equal(Object.hasOwn(ready,'swapProof'),false);
  assert.equal(host.log.includes(swapLine)||host.log.includes(meminfoLine),false);
  const plainHost=fakeHost({swapMax:null,meminfo:null});
  const plain=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams:plainHost.seams})
    .spawnPrepared({unitName});
  await plain.ready;
  assert.equal(plainHost.log.includes(swapLine)||plainHost.log.includes(meminfoLine),false);
});

/** A drained launcher with counters, so a refusal can prove no reservation and no spawn happened. */
function gatedLauncher(host,{timeoutMs=70000,terminalDrainMs=20000}={}){
  const counts={reserve:0,spawn:0};
  const budget=fakeBudget(host),reserve=budget.reserve;
  budget.reserve=async(...values)=>{counts.reserve+=1;return reserve(...values);};
  const seams={...host.seams,spawn:(...values)=>{counts.spawn+=1;return host.seams.spawn(...values);}};
  const launcher=createIoRuntimeLauncher({ioControls:controls,timeoutMs,terminalDrainMs,storageBudget:budget,
    allowUnsupportedPlatformForTests:true,seams});
  return {counts,launcher};
}

test('assertDrainHost() refuses with an enum-only cause before anything is reserved; prepare() keeps the same gate (L1, I2)',async()=>{
  const eio=Object.assign(new Error('EIO'),{code:'EIO'});
  const cases=[['DRAIN_UNDERSIZED',{vmExpire:'3000\n',vmWriteback:'500\n'}],['HOST_WRITEBACK_UNAVAILABLE',{vmExpire:null}],
    ['HOST_WRITEBACK_UNAVAILABLE',{vmWriteback:'abc\n'}],['FS_NOT_EXT4',{fsType:0x58465342}],
    ['FS_NOT_EXT4',{fsType:undefined}],['COMMIT_BARRIER_FAILED',{statfsError:eio}]];
  for(const [cause,options] of cases){
    const host=fakeHost(options);
    const {counts,launcher}=gatedLauncher(host);
    await assert.rejects(launcher.assertDrainHost(),error=>{
      assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
      assert.deepEqual(error.ioDiagnostic,{phase:'PRE_RESERVE',cause});assert.ok(Object.isFrozen(error.ioDiagnostic));
      const text=JSON.stringify(error.ioDiagnostic)+error.message;
      for(const secret of ['/',unitName,'srv','quant-storage-root','sysctl','vm'])assert.equal(text.includes(secret),false,secret);
      return true;
    },cause);
    // Side effect free: sysctl and statfs reads only. No lstat, reservation, spawn, freeze or stop.
    assert.equal(counts.reserve,0,cause);assert.equal(counts.spawn,0,cause);
    assert.equal(host.log.every(line=>line.startsWith('read /proc/sys/vm/')||line.startsWith('statfs ')),true,cause+' '+host.log);
    // prepare() runs the same checks as the backstop and names its own phase.
    await assert.rejects(launcher.prepare({unitName}),error=>{
      assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
      assert.deepEqual(error.ioDiagnostic,{phase:'PREPARE',cause});return true;
    },cause);
    assert.equal(counts.reserve,0,cause);assert.equal(counts.spawn,0,cause);
  }
  // A healthy host passes and nothing was reserved or spawned: two sysctl reads and one statfs.
  const fine=fakeHost({vmExpire:'3000\n',vmWriteback:'500\n'});
  const ok=gatedLauncher(fine,{terminalDrainMs:45000});
  assert.equal(await ok.launcher.assertDrainHost(),undefined);
  assert.deepEqual(fine.log,['read /proc/sys/vm/dirty_expire_centisecs','read /proc/sys/vm/dirty_writeback_centisecs','statfs '+storageRoot]);
  assert.equal(ok.counts.reserve,0);assert.equal(ok.counts.spawn,0);
  // Drain 0 has no host gate: the method reads nothing, whatever the host looks like.
  const zero=fakeHost({fsType:0x58465342,vmExpire:null,vmWriteback:null,statfsError:eio});
  const idle=gatedLauncher(zero,{terminalDrainMs:0,timeoutMs:30000});
  assert.equal(await idle.launcher.assertDrainHost(),undefined);assert.deepEqual(zero.log,[]);
  // A launcher without a StorageBudget cannot drain, so it has no host gate to run.
  const bare=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams:fakeHost().seams});
  assert.equal(bare.assertDrainHost,undefined);
});

test('a host that changes between the pre-reserve gate and prepare() is refused by prepare() (L1 backstop)',async()=>{
  const host=fakeHost();
  const {counts,launcher}=gatedLauncher(host);
  await launcher.assertDrainHost();
  host.fsType=0x58465342;
  await assert.rejects(launcher.prepare({unitName}),error=>{
    assert.equal(error.code,'QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
    assert.deepEqual(error.ioDiagnostic,{phase:'PREPARE',cause:'FS_NOT_EXT4'});return true;
  });
  assert.equal(counts.reserve,0);assert.equal(counts.spawn,0);
});

test('a policy launcher: prepare of a PROFILE payload needs the terminal block the launcher enforces (W2 3.6)',async()=>{
  const terminal=policyBlock(70000,20000,5000);
  const payloadFor=block=>{
    const {policy,contract}=profileV2Fixture(600);
    policy.environment='staging';contract.capacity.environment='staging';
    if(block)policy.terminal=block;
    contract.capacity.policy_hash=capacityPolicyHash(policy);
    return canonical({version:'profile-v2-provisional',jobId:'11111111-2222-4333-8444-555555555555',operationId:'operation-00001',
      contract,policy,storage:{root:storageRoot,diskQuotaBytes:1048576,tempQuotaBytes:1048576,freeFloorBytes:0}});
  };
  const build=(host,extra)=>createIoRuntimeLauncher({ioControls:controls,protocol:'profile-v2-provisional',
    storageBudget:fakeBudget(host),allowUnsupportedPlatformForTests:true,seams:host.seams,...extra});
  const host=fakeHost();
  const launcher=build(host,{terminalPolicy:terminal});
  const preparation=await launcher.prepare({unitName,payload:payloadFor(terminal)});
  assert.equal(typeof preparation.spawnPrepared,'function');await preparation.abort();
  for(const [name,block] of [['no terminal block',null],['other drain',policyBlock(70000,25000,5000)],
    ['other tail',policyBlock(70000,20000,7500)],['other runtime',policyBlock(69000,20000,5000)]])
    await assert.rejects(launcher.prepare({unitName,payload:payloadFor(block)}),configurationRefused,name);
  // A launcher without a policy keeps its old behavior for a payload with or without a block (drain 20 s, raw).
  const raw=build(fakeHost(),{timeoutMs:70000,terminalDrainMs:20000});
  for(const block of [null,terminal])await (await raw.prepare({unitName,payload:payloadFor(block)})).abort();
});

test('stop() during any pre-freeze read ends STOP_REQUESTED with no freeze and one stop; also for drain 0 with a policy, not for a raw FTR-1 launcher (T-L1)',async()=>{
  // The stop lands in each pre-freeze read of the drained flow (RD-4 stop-before-freeze) that runs after terminate()
  // returned: the identity snapshot, then the two vm sysctls. Whatever read it lands in, nothing is frozen or fsynced.
  const reads=['/proc/4242/stat','dirty_expire_centisecs','dirty_writeback_centisecs'];
  for(const target of reads){
    const host=fakeHost({dirty:8192});
    const handle=await policyHandle(host,policyBlock(70000,20000,5000));
    let stopping=null;
    host.beforeRead=file=>{if(file.endsWith(target)&&stopping===null)stopping=handle.stop();};
    const terminal=await handle.terminate({bound,commit:async()=>{host.log.push('commit');}});
    assert.notEqual(stopping,null,target);
    assert.equal(terminal.reason,'STOP_REQUESTED',target);assert.equal(terminal.measured,false,target);
    assert.equal(await stopping,terminal.stopProof,target);
    assert.equal(host.log.some(line=>line.includes('--user freeze')),false,target);
    assert.equal(host.syncCalls.length,0,target);assert.equal(host.log.includes('commit'),false,target);
    assert.equal(host.log.filter(line=>line===memoryLine).length,0,target);
    assert.equal(stopCount(host.log),1,target);assert.equal(terminal.diagnostic,undefined,target);
  }
  // A policy-bound launcher with drain 0 refuses a stop that arrives before the freeze too (W2-L1): nothing is frozen,
  // committed or fsynced. The policy validator accepts drain 0, and the wiring contract makes no drain exception.
  const plain=fakeHost();
  const handle=await policyHandle(plain,policyBlock(30000,0,5000));
  let stopping=null;
  plain.beforeRead=file=>{if(file.endsWith('/proc/4242/stat')&&stopping===null)stopping=handle.stop();};
  const done=await handle.terminate({bound,commit:async()=>{plain.log.push('commit');}});
  assert.notEqual(stopping,null);
  assert.equal(done.reason,'STOP_REQUESTED');assert.equal(done.measured,false);
  assert.equal(await stopping,done.stopProof);
  assert.equal(plain.log.some(line=>line.includes('--user freeze')),false);
  assert.equal(plain.syncCalls.length,0);assert.equal(plain.log.includes('commit'),false);
  assert.equal(stopCount(plain.log),1);assert.equal(done.diagnostic,undefined);
  // A raw FTR-1 launcher (no policy, drain 0) keeps its flow: it ignores the stop before the freeze and still measures.
  const rawHost=fakeHost();
  const raw=createIoRuntimeLauncher({ioControls:controls,allowUnsupportedPlatformForTests:true,seams:rawHost.seams})
    .spawnPrepared({unitName});
  await raw.ready;rawHost.log.length=0;
  let rawStop=null;
  rawHost.beforeRead=file=>{if(file.endsWith('/proc/4242/stat')&&rawStop===null)rawStop=raw.stop();};
  const rawDone=await raw.terminate({bound});
  assert.notEqual(rawStop,null);
  assert.equal(rawDone.measured,true);assert.equal(await rawStop,rawDone.stopProof);
  assert.equal(rawHost.log.filter(line=>line===freezeLine).length,1);assert.equal(stopCount(rawHost.log),1);
});

test('emergency stop through a policy launcher: mid-drain within one poll, mid-barrier within the budget and one poll (T-L4)',async()=>{
  const drained=fakeHost({dirty:8192});
  const handle=await policyHandle(drained,policyBlock(70000,40000,5000));
  let requestedAt=null,stopping=null;
  drained.afterSleep=()=>{if(requestedAt===null&&drained.now>=2000){requestedAt=drained.now;stopping=handle.stop();}};
  const terminal=await handle.terminate({bound,commit:async()=>{drained.log.push('commit');}});
  assert.notEqual(requestedAt,null);
  assert.equal(terminal.reason,'STOP_REQUESTED');assert.equal(terminal.measured,false);
  assert.equal(await stopping,terminal.stopProof);
  assert.ok(drained.now-requestedAt<=500,'one poll: '+(drained.now-requestedAt));assert.ok(drained.now<40000);
  assert.equal(stopCount(drained.log),1);assert.equal(drained.log.includes('commit'),false);
  assert.equal(terminal.diagnostic.stage,'DRAIN');
  const barrier=fakeHost({barrier:{mode:'settle',ms:1500}});
  const other=await policyHandle(barrier,policyBlock(70000,20000,5000));
  let barrierStop=null;
  barrier.onBarrier=()=>{barrierStop=other.stop();};
  const ended=await other.terminate({bound,commit:async()=>{barrier.log.push('commit');}});
  assert.notEqual(barrierStop,null);
  assert.equal(ended.reason,'STOP_REQUESTED');assert.equal(await barrierStop,ended.stopProof);
  assert.ok(barrier.now<=2000+500,'ended within barrier budget + one poll');
  assert.equal(barrier.log.filter(line=>line===memoryLine).length,0);assert.equal(stopCount(barrier.log),1);
  assert.equal(barrier.log.includes('commit'),false);
});
