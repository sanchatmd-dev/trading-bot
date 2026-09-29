import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,stat,lstat,unlink} from 'node:fs/promises';
import {hash,canonical} from '../pine-bridge/source.js';
import {assertIoStorageDevice,readCgroupIo,readCgroupIoLimits,systemdIoProperties,validateIoControls} from './io-controls.js';
import {stopQuantUnit} from './process-supervisor.js';
import {StorageBudget} from './storage-budget.js';
import {validateFoundationRequestV2} from './foundation-contract-v2.js';
import {parseCgroupEvents,inspectCgroupFrozen,parseMemoryWriteback,quiescenceWindowMs,
  evaluateQuiescence,reconcilePostExit,POST_EXIT_MEASURED,DRAIN_SETTLE_MS,DRAIN_POLL_MS,MAX_DRAIN_MS,
  STAT_FRESH_MS,TERMINAL_DIAGNOSTIC_VERSION,createDrainRecorder,buildTerminalDiagnostic} from './io-terminal.js';

const rootDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fail=code=>Object.assign(new Error(code),{code});
const TERMINAL_BUDGET_MS=5000,FREEZE_BUDGET_MS=2000,MAX_TERMINAL_READS=32,SPAWN_MARGIN_MS=5000;
const BOUND_FIELDS=['unitName','group','pid','procStartTicks','cgroupInode','deviceId','deviceInode','invocationId'];
const SEAM_NAMES=['spawn','command','readFile','stat','lstat','unlink','stopUnit','clock','sleep'];
// Terminal readback failures never throw past terminate(); they select the unknown-final fallback.
// `diagnostic` is fallback evidence only (integers, booleans, enums). It is never digested or stored.
const terminalFail=(reason,diagnostic)=>Object.assign(fail('QUANT_IO_TELEMETRY_UNAVAILABLE'),{reason},
  diagnostic?{diagnostic}:{});
const failureDiagnostic=error=>error?.diagnostic?.version===TERMINAL_DIAGNOSTIC_VERSION?error.diagnostic:null;
const failureReason=error=>typeof error?.reason==='string'?error.reason:
  typeof error?.ioDiagnostic?.cause==='string'?error.ioDiagnostic.cause:
  typeof error?.code==='string'?error.code:'UNKNOWN';
const cgroupBase=group=>{
  const base=path.posix.resolve('/sys/fs/cgroup','.'+group);
  if(!base.startsWith('/sys/fs/cgroup/'))throw terminalFail('INVALID_GROUP');
  return base;
};
const sameBoundSnapshot=(snapshot,bound)=>BOUND_FIELDS.every(field=>snapshot[field]!==undefined&&snapshot[field]===bound[field]);
const payload='{"mode":"sleep"}\n';
const payloadHash=hash(canonical({mode:'sleep'}));
const receipt=`QUANT_IO_DIAGNOSTIC_ACCEPTED_V1 ${payloadHash}\n`;
const PROFILE='profile-v2-provisional';
export const inspectIoRuntimeReceipt=(output,released)=>{
  if(!released||output.length>receipt.length||!receipt.startsWith(output))
    throw fail('QUANT_IO_LAUNCH_UNCERTAIN');
  return output===receipt;
};
export const inspectIoRuntimeScratch=(identity,original=null)=>{
  if(!identity?.isFile?.()||identity.isSymbolicLink?.()||identity.size!==4096||
    !Number.isSafeInteger(identity.dev)||!Number.isSafeInteger(identity.ino)||identity.ino<=0||
    original&&(identity.dev!==original.dev||identity.ino!==original.ino))
    throw fail('QUANT_IO_READINESS_CLEANUP_FAILED');
  return {dev:identity.dev,ino:identity.ino};
};
const validUnit=name=>typeof name==='string'&&/^robot-quant-[a-f0-9]{64}\.service$/.test(name);
const deviceNumbers=value=>{
  const bits=BigInt(value);
  return `${((bits>>8n)&0xfffn)|((bits>>32n)&~0xfffn)}:${(bits&0xffn)|((bits>>12n)&~0xffn)}`;
};
export const inspectIoRuntimeUnit=(output,unitName)=>{
  const group=output.match(/^ControlGroup=(\/.+)$/m)?.[1];
  const pid=Number(output.match(/^MainPID=(\d+)$/m)?.[1]);
  const invocationId=output.match(/^InvocationID=([a-f0-9]{32})$/m)?.[1];
  const segments=group?.split('/').slice(1)??[];
  if(!/^LoadState=loaded$/m.test(output)||!/^ActiveState=active$/m.test(output)||
    !validUnit(unitName)||!group?.endsWith('/'+unitName)||
    path.posix.normalize(group)!==group||segments.some(segment=>!segment||segment==='.'||segment==='..')||
    segments.slice(0,-1).some(segment=>validUnit(segment))||!invocationId||
    !Number.isSafeInteger(pid)||pid<=0)
    throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
  return {group,pid,invocationId};
};
export const inspectIoRuntimeDevice=(identity,device)=>{
  if(!identity?.isBlockDevice?.()||!Number.isSafeInteger(identity.ino)||identity.ino<=0||
    deviceNumbers(identity.rdev)!==device)throw fail('QUANT_IO_DEVICE_IDENTITY_MISMATCH');
  return {deviceId:device,deviceInode:identity.ino,rdev:identity.rdev,dev:identity.dev};
};
export const inspectIoRuntimeProc=(source,pid)=>{
  if(!source.startsWith(String(pid)+' '))throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
  const end=source.lastIndexOf(')');
  const fields=end<0?[]:source.slice(end+2).trim().split(/\s+/);
  const value=fields[19];
  if(!/^[0-9]+$/.test(value||''))throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
  return value;
};
export const inspectIoRuntimeMembership=(source,group)=>{
  if(source.trim()!==`0::${group}`)throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
  return group;
};

function command(file,args,timeoutMs=2000){
  return new Promise(resolve=>{
    let output='',done=false;
    const child=spawn(file,args,{stdio:['ignore','pipe','ignore'],windowsHide:true});
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(-1);},timeoutMs);
    function finish(code){if(done)return;done=true;clearTimeout(timer);resolve({code,output});}
    child.stdout.on('data',chunk=>{
      if(Buffer.byteLength(output)+chunk.length>4096){child.kill('SIGKILL');finish(-1);return;}
      output+=chunk.toString('utf8');
    });
    child.on('error',()=>finish(-1));child.on('close',finish);
  });
}

async function readMaxSectorsKb({io,approved}){
  let source;
  try{source=await io.readFile(`/sys/dev/block/${approved.device}/queue/max_sectors_kb`,'utf8');}
  catch{return undefined;}
  const value=String(source).trim();
  if(!/^[1-9]\d{0,7}$/.test(value))throw terminalFail('MAX_SECTORS_INVALID');
  return Number(value);
}

/** FTR-1 steps 1-6: identity, freeze, quiescence, writeback gate, identity again, durable commit.
 * FTR-1b: when `terminalDrainMs` > 0, a frozen writeback drain runs after freeze confirmation and before
 * quiescence. The gate itself is unchanged and still demands file_dirty 0 and file_writeback 0.
 * The drain ends at frozenAt + terminalDrainMs but never after the overall deadline. Quiescence then gets
 * at most budgetMs, so unused drain allowance never lengthens it. With the drain on, a stop request also
 * aborts quiescence (STOP_REQUESTED); with the drain off the FTR-1 flow ignores it.
 * Returns the frozen measurement or throws with a reason. The unit stays frozen; the caller stops it.
 */
async function frozenReadback(ctx,{bound,commit,budgetMs}){
  const {io,approved,unitName,terminalDrainMs}=ctx;
  const started=io.clock(),deadline=started+budgetMs+terminalDrainMs;
  const live=ctx.state();
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1000||budgetMs>10000)throw terminalFail('INVALID_BUDGET');
  if(!bound||typeof bound!=='object'||BOUND_FIELDS.some(field=>bound[field]===undefined))
    throw terminalFail('NO_BOUND_IDENTITY');
  if(live.closed||!live.ready||live.unexpectedOutput)throw terminalFail('NOT_LIVE');
  if(ctx.runtimeMs-(started-ctx.spawnedAt)<=budgetMs+terminalDrainMs)throw terminalFail('RUNTIME_LIMIT_NEAR');
  const rates={readBytesPerSecond:approved.evaluator.readBytesPerSecond,
    writeBytesPerSecond:approved.evaluator.writeBytesPerSecond};
  const maxSectorsKb=await readMaxSectorsKb(ctx);
  if(quiescenceWindowMs({maxSectorsKb,rates,budgetMs}).overBudget)throw terminalFail('WINDOW_OVER_BUDGET');
  const snapshot=async()=>{
    const identity=await ctx.liveIdentity();
    const device=await io.stat(approved.devicePath);
    const block=inspectIoRuntimeDevice(device,approved.device);
    return {identity,block,device:{ino:device.ino,rdev:device.rdev,dev:device.dev},
      merged:{...identity,deviceId:block.deviceId,deviceInode:block.deviceInode}};
  };
  const before=await snapshot();
  if(!sameBoundSnapshot(before.merged,bound))throw terminalFail('IDENTITY_CHANGED');
  const base=cgroupBase(before.identity.group);
  const eventsFile=path.posix.join(base,'cgroup.events'),memoryFile=path.posix.join(base,'memory.stat');
  const freezeStarted=io.clock();
  const freezeCommand=await io.command('systemctl',['--user','freeze',unitName],FREEZE_BUDGET_MS);
  if(freezeCommand.code!==0)throw terminalFail('FREEZE_FAILED');
  for(;;){
    let events;
    try{events=parseCgroupEvents(await io.readFile(eventsFile,'utf8'));}
    catch{throw terminalFail('FREEZE_UNVERIFIED');}
    if(events.populated!==1)throw terminalFail('CGROUP_EMPTY');
    if(events.frozen===1)break;
    if(io.clock()-freezeStarted>=FREEZE_BUDGET_MS)throw terminalFail('FREEZE_TIMEOUT');
    await io.sleep(10);
  }
  const freezeMs=io.clock()-freezeStarted;
  const freezer=await io.command('systemctl',['--user','show',unitName,'--property=FreezerState'],1000);
  if(freezer.code!==0||!/^FreezerState=frozen$/m.test(freezer.output))throw terminalFail('FREEZER_STATE_MISMATCH');
  // Freeze is confirmed. `frozenAt` anchors the drain settle floor and the stat-freshness floor.
  const frozenAt=io.clock();
  const drain=createDrainRecorder();
  const unseen=Object.freeze({fileDirty:null,fileWriteback:null});
  let stage='DRAIN',memoryReads=0,drainMs=0,seen=unseen;
  const diagnostic=()=>terminalDrainMs>0?buildTerminalDiagnostic({stage,...seen,memoryReads,
    sinceFreezeMs:io.clock()-frozenAt,
    drain:{enabled:true,durationMs:stage==='DRAIN'?io.clock()-frozenAt:drainMs,...drain.snapshot()}}):undefined;
  try{
    if(terminalDrainMs>0){
      // FTR-1b step 3: while frozen, wait for child-owned dirty/writeback page cache to clean.
      const drainFail=reason=>terminalFail(reason,diagnostic());
      const drainEnd=Math.min(frozenAt+terminalDrainMs,deadline);
      const readText=async(file,invalid)=>{
        try{return await io.readFile(file,'utf8');}
        catch(error){throw drainFail(['ENOENT','ENODEV'].includes(error?.code)?'CGROUP_EMPTY':invalid);}
      };
      for(;;){
        if(ctx.stopRequested())throw drainFail('STOP_REQUESTED');
        const atMs=io.clock();
        let events;
        const eventsText=await readText(eventsFile,'FREEZE_UNVERIFIED');
        try{events=parseCgroupEvents(eventsText);}catch{throw drainFail('FREEZE_UNVERIFIED');}
        if(events.populated!==1)throw drainFail('CGROUP_EMPTY');
        if(events.frozen!==1)throw drainFail('NOT_FROZEN');
        seen=unseen;
        const memoryText=await readText(memoryFile,'MEMORY_STAT_INVALID');
        try{seen=parseMemoryWriteback(memoryText);}catch{throw drainFail('MEMORY_STAT_INVALID');}
        memoryReads+=1;
        drain.record(atMs-frozenAt,seen.fileDirty,seen.fileWriteback);
        if(seen.fileDirty===0&&seen.fileWriteback===0&&atMs-frozenAt>=DRAIN_SETTLE_MS)break;
        if(atMs>=drainEnd)throw drainFail('WRITEBACK_PENDING');
        await io.sleep(Math.max(1,Math.min(DRAIN_POLL_MS,Math.ceil(drainEnd-io.clock()))));
      }
      drainMs=Math.round(io.clock()-frozenAt);
    }
    stage='QUIESCENCE';
    const quiescenceStart=io.clock(),quiescenceEnd=Math.min(deadline,quiescenceStart+budgetMs);
    const plan=quiescenceWindowMs({maxSectorsKb,rates,budgetMs:Math.max(0,quiescenceEnd-quiescenceStart)});
    if(plan.overBudget)throw terminalFail('WINDOW_OVER_BUDGET');
    const readOnce=async()=>{
      const atMs=io.clock();
      const [counters,events,memory]=await Promise.all([
        readCgroupIo(before.identity.group,approved,'evaluator',{reader:io.readFile,statter:io.stat}),
        io.readFile(eventsFile,'utf8'),io.readFile(memoryFile,'utf8')]);
      try{inspectCgroupFrozen(events);}catch{throw terminalFail('NOT_FROZEN');}
      seen=unseen;
      try{seen=parseMemoryWriteback(memory);memoryReads+=1;}
      catch{throw terminalFail(terminalDrainMs>0?'MEMORY_STAT_INVALID':'WRITEBACK_PENDING',diagnostic());}
      if(seen.fileDirty!==0||seen.fileWriteback!==0)throw terminalFail('WRITEBACK_PENDING',diagnostic());
      return {atMs,inode:counters.inode,readBytes:counters.readBytes,writeBytes:counters.writeBytes};
    };
    const reads=[];
    let verdict=null;
    for(;;){
      if(terminalDrainMs>0&&ctx.stopRequested())throw terminalFail('STOP_REQUESTED');
      if(reads.length>=MAX_TERMINAL_READS)throw terminalFail('NO_QUIESCENCE');
      const read=await readOnce();
      if(read.inode!==bound.cgroupInode)throw terminalFail('IDENTITY_CHANGED');
      reads.push(read);
      const previous=ctx.last();
      try{
        verdict=evaluateQuiescence({reads,windowMs:plan.windowMs,deadlineMs:quiescenceEnd,
          last:previous?{readBytes:previous.readBytes,writeBytes:previous.writeBytes}:null});
      }catch{throw terminalFail('NO_QUIESCENCE');}
      let waitUntilMs=verdict.nextReadAtMs;
      if(verdict.stable){
        if(verdict.second.atMs-frozenAt>=STAT_FRESH_MS)break;
        // Stable but too soon after freeze for memcg stats to be fresh: read again once they are.
        waitUntilMs=frozenAt+STAT_FRESH_MS;
        if(waitUntilMs>quiescenceEnd)throw terminalFail('NO_QUIESCENCE');
      }
      await io.sleep(Math.max(1,Math.ceil(waitUntilMs-io.clock())));
    }
    const after=await snapshot();
    if(canonical(before.identity)!==canonical(after.identity)||canonical(before.device)!==canonical(after.device)||
      !sameBoundSnapshot(after.merged,bound))throw terminalFail('IDENTITY_CHANGED');
    const {first,second}=verdict;
    const frozenSample=Object.freeze({...after.merged,readBytes:second.readBytes,writeBytes:second.writeBytes});
    const readbackEvidence=Object.freeze({freezer:'frozen',windowMs:plan.windowMs,
      reads:[{readBytes:first.readBytes,writeBytes:first.writeBytes},
        {readBytes:second.readBytes,writeBytes:second.writeBytes}],
      fileDirty:0,fileWriteback:0,maxBioBytes:plan.maxBioBytes,rates,
      freezeMs:Math.round(freezeMs),elapsedMs:Math.round(io.clock()-started),
      drainMs,drainPolls:drain.snapshot().polls,statFreshMs:Math.round(second.atMs-frozenAt)});
    // Frozen counters must be durable before the unit is killed. Failure means fallback.
    if(commit){try{await commit(frozenSample,readbackEvidence);}catch{throw terminalFail('COMMIT_FAILED');}}
    return {frozenSample,readbackEvidence,group:after.identity.group};
  }catch(error){
    // Backstop: every post-freeze failure carries the drain series when the drain is enabled.
    if(terminalDrainMs>0&&error&&typeof error==='object'&&!error.diagnostic){
      try{error.diagnostic=diagnostic();}catch{}
    }
    throw error;
  }
}

/** Step 8. ENOENT/ENODEV: REMOVED. Equal retained counters: RETAINED_EQUAL. Anything else is not measured. */
async function readPostExit({io,approved},frozen,group){
  let code;
  const track=operation=>async(...args)=>{
    try{return await operation(...args);}catch(error){code??=error?.code;throw error;}
  };
  const reader=track(io.readFile),statter=track(io.stat);
  try{
    const base=cgroupBase(group);
    const events=parseCgroupEvents(await reader(path.posix.join(base,'cgroup.events'),'utf8'));
    const counters=await readCgroupIo(group,approved,'evaluator',{reader,statter});
    return reconcilePostExit({frozen:{inode:frozen.cgroupInode,readBytes:frozen.readBytes,
      writeBytes:frozen.writeBytes},read:{populated:events.populated,inode:counters.inode,
      readBytes:counters.readBytes,writeBytes:counters.writeBytes}});
  }catch{
    try{return reconcilePostExit({frozen:{inode:frozen.cgroupInode,readBytes:frozen.readBytes,
      writeBytes:frozen.writeBytes},read:{error:{code}}});}
    catch{return 'UNKNOWN';}
  }
}

/** Fixed, bounded diagnostic. This never evaluates or completes a PROFILE job.
 * `seams` replace process, filesystem, systemd and clock access for isolated tests only.
 */
export function createIoRuntimeLauncher({python=process.env.QUANT_RESEARCH_PYTHON||'python3',
  root=rootDefault,ioControls,storageBudget,timeoutMs=30000,terminalDrainMs=0,protocol=null,
  allowUnsupportedPlatformForTests=false,seams={}}={}){
  if(process.platform!=='linux'&&!allowUnsupportedPlatformForTests)throw fail('QUANT_IO_ISOLATION_REQUIRED');
  if(!seams||typeof seams!=='object'||Object.keys(seams).some(name=>!SEAM_NAMES.includes(name)||
    typeof seams[name]!=='function'))throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
  const host={spawn:seams.spawn??spawn,command:seams.command??command,readFile:seams.readFile??readFile,
    stat:seams.stat??stat,lstat:seams.lstat??lstat,unlink:seams.unlink??unlink,
    stopUnit:seams.stopUnit??stopQuantUnit,clock:seams.clock??(()=>performance.now()),
    sleep:seams.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)))};
  const approved=validateIoControls(ioControls);
  if(typeof python!=='string'||!python||typeof root!=='string'||!path.isAbsolute(root)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000||
    terminalDrainMs!==0&&(!Number.isSafeInteger(terminalDrainMs)||terminalDrainMs<DRAIN_SETTLE_MS||
      terminalDrainMs>MAX_DRAIN_MS)||
    // The runtime must hold the terminal budget, the drain and a spawn-to-frame margin.
    terminalDrainMs>0&&Math.ceil(timeoutMs/1000)*1000<=TERMINAL_BUDGET_MS+terminalDrainMs+SPAWN_MARGIN_MS)
    throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
  if(storageBudget&&!(storageBudget instanceof StorageBudget))
    throw fail('QUANT_IO_READINESS_CONFIGURATION_REQUIRED');
  if(protocol!==null&&protocol!==PROFILE||protocol===PROFILE&&!storageBudget)
    throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
  const spawnPrepared=({unitName},readiness=null,profilePayload=null)=>{
      if(!validUnit(unitName))throw fail('INVALID_QUANT_PROCESS_REQUEST');
      if(storageBudget&&!readiness)throw fail('QUANT_IO_READINESS_CONFIGURATION_REQUIRED');
      if(protocol===PROFILE&&!profilePayload)throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
      const expectedHash=profilePayload?hash(profilePayload):payloadHash;
      const expectedReceipt=profilePayload?`QUANT_PROFILE_ACCEPTED_V2 ${expectedHash}\n`:receipt;
      const inputPayload=profilePayload?profilePayload+'\n':payload;
      const args=['--user','--quiet','--wait','--pipe','--collect','--unit='+unitName,
        '--property=CPUAccounting=yes','--property=MemoryAccounting=yes',
        '--property=CPUQuota=50%','--property=MemoryMax='+512*1024*1024,
        '--property=TasksMax=16','--property=IOWeight=10',...systemdIoProperties(approved),
        '--property=Nice=10','--property=KillMode=control-group',
        '--property=TimeoutStopSec=3','--property=RuntimeMaxSec='+Math.ceil(timeoutMs/1000),
        '--property=LimitCORE=0','--property=LimitNOFILE=64',
        '--setenv=OMP_NUM_THREADS=1','--setenv=OPENBLAS_NUM_THREADS=1',
        '--setenv=MKL_NUM_THREADS=1','--setenv=NUMEXPR_NUM_THREADS=1',
        ...(readiness?['--setenv=QUANT_IO_READY_FILE='+readiness.filename,
          '--setenv=QUANT_IO_READY_DEVICE='+approved.device,
          '--setenv=QUANT_IO_READY_RBPS='+approved.evaluator.readBytesPerSecond,
          '--setenv=QUANT_IO_READY_WBPS='+approved.evaluator.writeBytesPerSecond]:[]),
        '--setenv=PYTHONPATH='+path.join(root,'quant_lab/src')+path.delimiter+root,
        '--working-directory='+root,...(profilePayload?
          [process.execPath,path.join(root,'src/quant-research/io-profile-worker.js')]:
          [python,...(readiness?
          [path.join(root,'quant_lab/src/robot_quant/io_runtime_probe.py')]:
          ['-m','quant_lab.tests.quant_process_probe'])])];
      const env={PATH:process.env.PATH||'/usr/bin:/bin',
        ...(process.env.XDG_RUNTIME_DIR?{XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}:{}),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS?{DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}:{})};
      const child=host.spawn('systemd-run',args,{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
      child.stdin.on('error',()=>{});
      let closed=false,closeCode=null,outputBytes=0,released=false,stopPromise=null;
      let stdout='',unexpectedOutput=false,acceptResolved=false,resultResolved=false;
      let resolveAccepted,rejectAccepted;
      let resolveResult,rejectResult;
      const accepted=readiness?new Promise((resolve,reject)=>{
        resolveAccepted=resolve;rejectAccepted=reject;
      }):null;
      accepted?.catch(()=>{});
      const profileResult=profilePayload?new Promise((resolve,reject)=>{
        resolveResult=resolve;rejectResult=reject;
      }):null;
      profileResult?.catch(()=>{});
      let startRegistered=false,readyState=false;
      let previousSample=null;
      let cleanupDone=false,readinessIdentity=null;
      const cleanupReadiness=async()=>{
        if(!readiness||cleanupDone)return true;
        try{
          let current;
          try{current=await host.lstat(readiness.filename);}catch(error){if(error.code!=='ENOENT')throw error;}
          if(!readinessIdentity)throw fail('QUANT_IO_READINESS_CLEANUP_FAILED');
          inspectIoRuntimeScratch(current,readinessIdentity);
          await host.unlink(readiness.filename);
          await readiness.reservation.release();
          cleanupDone=true;
          return true;
        }catch{return false;}
      };
      const closure=new Promise(resolve=>{
        child.on('error',()=>{});
        child.on('close',code=>{
          closed=true;closeCode=code;
          if(accepted&&!acceptResolved)rejectAccepted(fail('QUANT_IO_LAUNCH_UNCERTAIN'));
          if(profileResult&&!resultResolved)rejectResult(fail('QUANT_IO_LAUNCH_UNCERTAIN'));
          resolve(code);
        });
      });
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
        outputBytes+=chunk.length;
        if(outputBytes>(profilePayload?9*1024*1024:65536)&&!closed)child.kill('SIGKILL');
        if(readiness&&stream===child.stdout){
          stdout+=chunk.toString('utf8');
          let valid=true,complete=false;
          if(profilePayload){
            if(!released)valid=false;
            else if(!acceptResolved){
              if(stdout.length>=expectedReceipt.length){
                if(!stdout.startsWith(expectedReceipt))valid=false;
                else{acceptResolved=true;resolveAccepted(Object.freeze({unitName,payloadHash:expectedHash}));}
              }else if(!expectedReceipt.startsWith(stdout))valid=false;
            }
            if(valid&&acceptResolved&&!resultResolved){
              const tail=stdout.slice(expectedReceipt.length);
              if(tail.includes('\n')){
                if(tail.indexOf('\n')!==tail.length-1||Buffer.byteLength(tail)>8*1024*1024+4096)valid=false;
                else try{const parsed=JSON.parse(tail);resultResolved=true;resolveResult(parsed);}catch{valid=false;}
              }
            }else if(resultResolved&&stdout.slice(expectedReceipt.length).indexOf('\n')!==stdout.length-expectedReceipt.length-1)valid=false;
          }else try{complete=inspectIoRuntimeReceipt(stdout,released);}catch{valid=false;}
          if(!valid){
            unexpectedOutput=true;
            if(!acceptResolved){acceptResolved=true;rejectAccepted(fail('QUANT_IO_LAUNCH_UNCERTAIN'));}
            if(profileResult&&!resultResolved){resultResolved=true;rejectResult(fail('QUANT_IO_LAUNCH_UNCERTAIN'));}
            if(!closed)child.kill('SIGKILL');
          }
          if(complete){
            acceptResolved=true;resolveAccepted(Object.freeze({unitName,payloadHash}));
          }
        }
      });
      const ready=(async()=>{
        const deadline=Date.now()+3000;
        while(!closed&&Date.now()<deadline){
          const state=await host.command('systemctl',['--user','show',unitName,
            '--property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID'],1000);
          let unit=null;
          if(state.code===0)try{unit=inspectIoRuntimeUnit(state.output,unitName);}catch{}
          if(unit){
            const {group,invocationId}=unit;
            startRegistered=true;
            const base=path.posix.resolve('/sys/fs/cgroup','.'+group);
            if(!base.startsWith('/sys/fs/cgroup/'))throw fail('QUANT_IO_GATE_FAILED');
            const io=await readCgroupIoLimits(group,approved,'evaluator',{reader:host.readFile,statter:host.stat});
            const [cpu,memory,tasks]=await Promise.all(['cpu.max','memory.max','pids.max'].map(name=>
              host.readFile(path.posix.join(base,name),'utf8')));
            const [quota,period]=cpu.trim().split(/\s+/).map(Number);
            const memoryMax=Number(memory.trim()),tasksMax=Number(tasks.trim());
            if(!Number.isSafeInteger(quota)||!Number.isSafeInteger(period)||period<=0||
              quota<=0||quota/period>0.5||!Number.isSafeInteger(memoryMax)||memoryMax<=0||
              memoryMax>512*1024*1024||!Number.isSafeInteger(tasksMax)||tasksMax<=0||
              tasksMax>16||!Number.isSafeInteger(io.inode))throw fail('QUANT_IO_GATE_FAILED');
            if(readiness){
              let file=null,counters=null;
              try{file=await host.lstat(readiness.filename);}catch(error){if(error.code!=='ENOENT')throw error;}
              if(file){
                const scratch=inspectIoRuntimeScratch(file);
                try{counters=await readCgroupIo(group,approved,'evaluator',{reader:host.readFile,statter:host.stat});}
                catch(error){if(error.code!=='QUANT_IO_TELEMETRY_UNAVAILABLE')throw error;}
                if(counters){
                  if(counters.inode!==io.inode)throw fail('QUANT_IO_GATE_FAILED');
                  readinessIdentity=scratch;
                }
              }
              if(!readinessIdentity){await new Promise(resolve=>setTimeout(resolve,25));continue;}
            }
            readyState=true;
            return Object.freeze({unitName,group,invocationId,cgroupInode:io.inode,
              cpuQuota:quota,cpuPeriod:period,memoryMax,tasksMax});
          }
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw fail('QUANT_IO_GATE_FAILED');
      })();
      ready.catch(()=>{});
      const liveIdentity=async()=>{
        if(closed||!readyState||unexpectedOutput)throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
        const state=await host.command('systemctl',['--user','show',unitName,
          '--property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID'],1000);
        if(state.code!==0)throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
        const {group,pid,invocationId}=inspectIoRuntimeUnit(state.output,unitName);
        const [processState,membership,limits]=await Promise.all([
          host.readFile(`/proc/${pid}/stat`,'utf8'),host.readFile(`/proc/${pid}/cgroup`,'utf8'),
          readCgroupIoLimits(group,approved,'evaluator',{reader:host.readFile,statter:host.stat})]);
        inspectIoRuntimeMembership(membership,group);
        if(!Number.isSafeInteger(limits.inode)||limits.inode<=0)
          throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
        return {unitName,group,pid,invocationId,procStartTicks:inspectIoRuntimeProc(processState,pid),
          cgroupInode:limits.inode};
      };
      const spawnedAt=host.clock(),runtimeMs=Math.ceil(timeoutMs/1000)*1000;
      let terminatePromise=null,stopRequested=false;
      const stopUnitOnce=()=>{
        if(stopPromise)return stopPromise;
        stopPromise=(async()=>{
          const deadline=Date.now()+3000;
          while(!closed&&Date.now()<deadline){
            const state=await host.command('systemctl',['--user','show',unitName,
              '--property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID'],1000);
            if(state.code===0)try{inspectIoRuntimeUnit(state.output,unitName);
              startRegistered=true;break;}catch{}
            await new Promise(resolve=>setTimeout(resolve,25));
          }
          const unitStopped=await host.stopUnit(unitName);
          if(!closed)child.kill('SIGKILL');
          let closeTimer;
          await Promise.race([closure,new Promise(resolve=>{closeTimer=setTimeout(resolve,5000);})]);
          clearTimeout(closeTimer);
          const pending=await host.command('systemctl',['--user','list-jobs','--no-legend','--no-pager'],2000);
          const stopped=startRegistered&&unitStopped===true&&closed&&pending.code===0&&!pending.output.includes(unitName);
          const cleaned=stopped?await cleanupReadiness():false;
          return Object.freeze({unitName,launcherClosed:closed,startRegistered,
            pendingStartsExcluded:closed&&pending.code===0&&!pending.output.includes(unitName),
            unitStopped:stopped&&cleaned,launcherCode:closeCode});
        })();
        return stopPromise;
      };
      const handle={payloadHash:expectedHash,...(accepted?{accepted}:{}),
        ...(profileResult?{profileResult}:{}),
        async sample(){
          const before=await liveIdentity();
          const deviceBefore=await host.stat(approved.devicePath);
          const block=inspectIoRuntimeDevice(deviceBefore,approved.device);
          const counters=await readCgroupIo(before.group,approved,'evaluator',{reader:host.readFile,statter:host.stat});
          const [after,deviceAfter]=await Promise.all([liveIdentity(),host.stat(approved.devicePath)]);
          if(canonical(before)!==canonical(after)||counters.inode!==before.cgroupInode||
            !deviceAfter.isBlockDevice()||deviceAfter.ino!==deviceBefore.ino||
            deviceAfter.rdev!==deviceBefore.rdev||deviceAfter.dev!==deviceBefore.dev||closed||
            previousSample&&(counters.readBytes<previousSample.readBytes||
              counters.writeBytes<previousSample.writeBytes))throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
          const sample=Object.freeze({...before,deviceId:block.deviceId,
            deviceInode:block.deviceInode,readBytes:counters.readBytes,writeBytes:counters.writeBytes});
          previousSample=sample;
          return sample;
        },
        release(){
          if(released||closed||!readyState||unexpectedOutput)throw fail('QUANT_IO_LAUNCH_UNCERTAIN');
          released=true;
          child.stdin.end(inputPayload);
        },
        /** A stop requested while terminate() runs waits for it and shares its stop proof.
         * It also aborts a running writeback drain within one poll, so emergency stop stays fast.
         */
        async stop(){
          if(terminatePromise){stopRequested=true;return (await terminatePromise).stopProof;}
          return stopUnitOnce();
        },
        /** Single-flight FTR-1 terminal: frozen readback, durable commit, then the ordinary stop.
         * Always stops the unit. `measured` is true only for a complete frozen readback with a
         * REMOVED or RETAINED_EQUAL post-exit cgroup. Any other outcome is the unknown-final fallback.
         * Stop rc 5 (unit already collected after SIGKILL) and systemd-run exit 255 are not failures.
         */
        terminate({bound=null,commit=null,budgetMs=TERMINAL_BUDGET_MS}={}){
          if(terminatePromise)return terminatePromise;
          terminatePromise=(async()=>{
            let measurement=null,reason=null,diagnostic=null;
            if(stopPromise)reason='ALREADY_STOPPING';
            else if(commit!==null&&typeof commit!=='function')reason='INVALID_COMMIT';
            else try{
              measurement=await frozenReadback({io:host,approved,unitName,spawnedAt,runtimeMs,terminalDrainMs,
                state:()=>({closed,ready:readyState,unexpectedOutput}),stopRequested:()=>stopRequested,
                liveIdentity,last:()=>previousSample},{bound,commit,budgetMs});
            }catch(error){reason=failureReason(error);diagnostic=failureDiagnostic(error);}
            const stopProof=await stopUnitOnce();
            let postExit=null;
            if(measurement&&stopProof.unitStopped===true)
              postExit=await readPostExit({io:host,approved},measurement.frozenSample,measurement.group);
            const measured=measurement!==null&&POST_EXIT_MEASURED.includes(postExit);
            if(!measured&&reason===null)
              reason=measurement===null?'UNKNOWN':stopProof.unitStopped!==true?'STOP_UNCONFIRMED':'POST_EXIT_'+postExit;
            return Object.freeze({stopProof,measured,postExit,
              ...(measurement?{frozenSample:measurement.frozenSample,
                readbackEvidence:measurement.readbackEvidence}:{}),
              ...(measured?{}:{reason}),...(!measured&&diagnostic?{diagnostic}:{})});
          })();
          return terminatePromise;
        },
        closed:closure,ready
      };
      return Object.freeze(handle);
  };
  if(!storageBudget)return Object.freeze({spawnPrepared});
  return Object.freeze({
    async prepare({unitName,payload:preparedPayload}){
      if(!validUnit(unitName))throw fail('INVALID_QUANT_PROCESS_REQUEST');
      if(protocol===PROFILE){
        if(typeof preparedPayload!=='string'||Buffer.byteLength(preparedPayload)>65536)
          throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
        let parsed;
        try{parsed=JSON.parse(preparedPayload);}catch{throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');}
        if(parsed?.version!==PROFILE||parsed.policy?.environment!=='staging'||
          canonical(parsed)!==preparedPayload||
          !/^[a-f0-9-]{36}$/.test(parsed.jobId)||typeof parsed.operationId!=='string'||
          parsed.storage?.root!==storageBudget.root||
          parsed.storage?.diskQuotaBytes!==storageBudget.diskQuotaBytes||
          parsed.storage?.tempQuotaBytes!==storageBudget.tempQuotaBytes||
          parsed.storage?.freeFloorBytes!==storageBudget.freeFloorBytes)
          throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
        validateFoundationRequestV2(parsed.contract,{policy:parsed.policy});
      }else if(preparedPayload!==undefined)throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
      await assertIoStorageDevice(storageBudget.root,approved.device);
      const pendingName='.pending-'+randomUUID();
      const reservation=await storageBudget.reserve({diskBytes:4096,tempBytes:4096,
        pendingName,purpose:'quant-io-readiness-v1'});
      const readiness={filename:path.join(storageBudget.root,pendingName),reservation};
      let used=false;
      return Object.freeze({
        spawnPrepared(){
          if(used)throw fail('QUANT_IO_LAUNCH_UNCERTAIN');
          used=true;
          try{return spawnPrepared({unitName},readiness,preparedPayload??null);}
          catch(error){used=false;throw error;}
        },
        async abort(){
          if(used)throw fail('QUANT_IO_LAUNCH_UNCERTAIN');
          used=true;
          await reservation.release();
        }
      });
    },
    spawnPrepared({unitName}){return spawnPrepared({unitName});}
  });
}
