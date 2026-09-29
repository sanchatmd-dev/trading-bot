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

const rootDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fail=code=>Object.assign(new Error(code),{code});
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

/** Fixed, bounded diagnostic. This never evaluates or completes a PROFILE job. */
export function createIoRuntimeLauncher({python=process.env.QUANT_RESEARCH_PYTHON||'python3',
  root=rootDefault,ioControls,storageBudget,timeoutMs=30000,protocol=null}={}){
  if(process.platform!=='linux')throw fail('QUANT_IO_ISOLATION_REQUIRED');
  const approved=validateIoControls(ioControls);
  if(typeof python!=='string'||!python||typeof root!=='string'||!path.isAbsolute(root)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)
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
      const child=spawn('systemd-run',args,{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
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
          try{current=await lstat(readiness.filename);}catch(error){if(error.code!=='ENOENT')throw error;}
          if(!readinessIdentity)throw fail('QUANT_IO_READINESS_CLEANUP_FAILED');
          inspectIoRuntimeScratch(current,readinessIdentity);
          await unlink(readiness.filename);
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
          const state=await command('systemctl',['--user','show',unitName,
            '--property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID'],1000);
          let unit=null;
          if(state.code===0)try{unit=inspectIoRuntimeUnit(state.output,unitName);}catch{}
          if(unit){
            const {group,invocationId}=unit;
            startRegistered=true;
            const base=path.posix.resolve('/sys/fs/cgroup','.'+group);
            if(!base.startsWith('/sys/fs/cgroup/'))throw fail('QUANT_IO_GATE_FAILED');
            const io=await readCgroupIoLimits(group,approved,'evaluator');
            const [cpu,memory,tasks]=await Promise.all(['cpu.max','memory.max','pids.max'].map(name=>
              readFile(path.posix.join(base,name),'utf8')));
            const [quota,period]=cpu.trim().split(/\s+/).map(Number);
            const memoryMax=Number(memory.trim()),tasksMax=Number(tasks.trim());
            if(!Number.isSafeInteger(quota)||!Number.isSafeInteger(period)||period<=0||
              quota<=0||quota/period>0.5||!Number.isSafeInteger(memoryMax)||memoryMax<=0||
              memoryMax>512*1024*1024||!Number.isSafeInteger(tasksMax)||tasksMax<=0||
              tasksMax>16||!Number.isSafeInteger(io.inode))throw fail('QUANT_IO_GATE_FAILED');
            if(readiness){
              let file=null,counters=null;
              try{file=await lstat(readiness.filename);}catch(error){if(error.code!=='ENOENT')throw error;}
              if(file){
                const scratch=inspectIoRuntimeScratch(file);
                try{counters=await readCgroupIo(group,approved,'evaluator');}
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
        const state=await command('systemctl',['--user','show',unitName,
          '--property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID'],1000);
        if(state.code!==0)throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
        const {group,pid,invocationId}=inspectIoRuntimeUnit(state.output,unitName);
        const [processState,membership,limits]=await Promise.all([
          readFile(`/proc/${pid}/stat`,'utf8'),readFile(`/proc/${pid}/cgroup`,'utf8'),
          readCgroupIoLimits(group,approved,'evaluator')]);
        inspectIoRuntimeMembership(membership,group);
        if(!Number.isSafeInteger(limits.inode)||limits.inode<=0)
          throw fail('QUANT_IO_IDENTITY_UNAVAILABLE');
        return {unitName,group,pid,invocationId,procStartTicks:inspectIoRuntimeProc(processState,pid),
          cgroupInode:limits.inode};
      };
      const handle={payloadHash:expectedHash,...(accepted?{accepted}:{}),
        ...(profileResult?{profileResult}:{}),
        async sample(){
          const before=await liveIdentity();
          const deviceBefore=await stat(approved.devicePath);
          const block=inspectIoRuntimeDevice(deviceBefore,approved.device);
          const counters=await readCgroupIo(before.group,approved,'evaluator');
          const [after,deviceAfter]=await Promise.all([liveIdentity(),stat(approved.devicePath)]);
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
        async stop(){
          if(stopPromise)return stopPromise;
          stopPromise=(async()=>{
            const deadline=Date.now()+3000;
            while(!closed&&Date.now()<deadline){
              const state=await command('systemctl',['--user','show',unitName,
                '--property=LoadState,ActiveState,MainPID,ControlGroup,InvocationID'],1000);
              if(state.code===0)try{inspectIoRuntimeUnit(state.output,unitName);
                startRegistered=true;break;}catch{}
              await new Promise(resolve=>setTimeout(resolve,25));
            }
            const unitStopped=await stopQuantUnit(unitName);
            if(!closed)child.kill('SIGKILL');
            await Promise.race([closure,new Promise(resolve=>setTimeout(resolve,5000))]);
            const pending=await command('systemctl',['--user','list-jobs','--no-legend','--no-pager'],2000);
            const stopped=startRegistered&&unitStopped===true&&closed&&pending.code===0&&!pending.output.includes(unitName);
            const cleaned=stopped?await cleanupReadiness():false;
            return Object.freeze({unitName,launcherClosed:closed,startRegistered,
              pendingStartsExcluded:closed&&pending.code===0&&!pending.output.includes(unitName),
              unitStopped:stopped&&cleaned,launcherCode:closeCode});
          })();
          return stopPromise;
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
