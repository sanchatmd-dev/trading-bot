import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {hash,canonical} from '../pine-bridge/source.js';
import {readCgroupIoLimits,systemdIoProperties,validateIoControls} from './io-controls.js';
import {stopQuantUnit} from './process-supervisor.js';

const rootDefault=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fail=code=>Object.assign(new Error(code),{code});
const payload='{"mode":"sleep"}\n';
const payloadHash=hash(canonical({mode:'sleep'}));
const validUnit=name=>typeof name==='string'&&/^robot-quant-[a-f0-9]{64}\.service$/.test(name);

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
  root=rootDefault,ioControls,timeoutMs=30000}={}){
  if(process.platform!=='linux')throw fail('QUANT_IO_ISOLATION_REQUIRED');
  const approved=validateIoControls(ioControls);
  if(typeof python!=='string'||!python||typeof root!=='string'||!path.isAbsolute(root)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)
    throw fail('QUANT_IO_LAUNCH_CONFIGURATION_REQUIRED');
  return Object.freeze({
    spawnPrepared({unitName}){
      if(!validUnit(unitName))throw fail('INVALID_QUANT_PROCESS_REQUEST');
      const args=['--user','--quiet','--wait','--pipe','--collect','--unit='+unitName,
        '--property=CPUAccounting=yes','--property=MemoryAccounting=yes',
        '--property=CPUQuota=50%','--property=MemoryMax='+512*1024*1024,
        '--property=TasksMax=16','--property=IOWeight=10',...systemdIoProperties(approved),
        '--property=Nice=10','--property=KillMode=control-group',
        '--property=TimeoutStopSec=3','--property=RuntimeMaxSec='+Math.ceil(timeoutMs/1000),
        '--property=LimitCORE=0','--property=LimitNOFILE=64',
        '--setenv=OMP_NUM_THREADS=1','--setenv=OPENBLAS_NUM_THREADS=1',
        '--setenv=MKL_NUM_THREADS=1','--setenv=NUMEXPR_NUM_THREADS=1',
        '--setenv=PYTHONPATH='+path.join(root,'quant_lab/src')+path.delimiter+root,
        '--working-directory='+root,python,'-m','quant_lab.tests.quant_process_probe'];
      const env={PATH:process.env.PATH||'/usr/bin:/bin',
        ...(process.env.XDG_RUNTIME_DIR?{XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}:{}),
        ...(process.env.DBUS_SESSION_BUS_ADDRESS?{DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}:{})};
      const child=spawn('systemd-run',args,{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
      child.stdin.on('error',()=>{});
      let closed=false,closeCode=null,outputBytes=0,released=false,stopPromise=null;
      let startRegistered=false,readyState=false;
      const closure=new Promise(resolve=>{
        child.on('error',()=>{});
        child.on('close',code=>{closed=true;closeCode=code;resolve(code);});
      });
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
        outputBytes+=chunk.length;
        if(outputBytes>65536&&!closed)child.kill('SIGKILL');
      });
      const ready=(async()=>{
        const deadline=Date.now()+3000;
        while(!closed&&Date.now()<deadline){
          const state=await command('systemctl',['--user','show',unitName,
            '--property=LoadState,ActiveState,MainPID,ControlGroup'],1000);
          const group=state.output.match(/^ControlGroup=(\/.+)$/m)?.[1];
          const mainPid=Number(state.output.match(/^MainPID=(\d+)$/m)?.[1]);
          if(state.code===0&&/^LoadState=loaded$/m.test(state.output)&&
            /^ActiveState=active$/m.test(state.output)&&Number.isSafeInteger(mainPid)&&mainPid>0&&group){
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
            readyState=true;
            return Object.freeze({unitName,group,cgroupInode:io.inode,
              cpuQuota:quota,cpuPeriod:period,memoryMax,tasksMax});
          }
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        throw fail('QUANT_IO_GATE_FAILED');
      })();
      ready.catch(()=>{});
      const handle={payloadHash,
        release(){
          if(released||closed||!readyState)throw fail('QUANT_IO_LAUNCH_UNCERTAIN');
          released=true;
          child.stdin.end(payload);
        },
        async stop(){
          if(stopPromise)return stopPromise;
          stopPromise=(async()=>{
            const deadline=Date.now()+3000;
            while(!closed&&Date.now()<deadline){
              const state=await command('systemctl',['--user','show',unitName,
                '--property=LoadState,ActiveState,MainPID,ControlGroup'],1000);
              const pid=Number(state.output.match(/^MainPID=(\d+)$/m)?.[1]);
              if(state.code===0&&/^LoadState=loaded$/m.test(state.output)&&
                /^ActiveState=active$/m.test(state.output)&&Number.isSafeInteger(pid)&&pid>0&&
                /^ControlGroup=\/.+$/m.test(state.output)){startRegistered=true;break;}
              await new Promise(resolve=>setTimeout(resolve,25));
            }
            const unitStopped=await stopQuantUnit(unitName);
            if(!closed)child.kill('SIGKILL');
            await Promise.race([closure,new Promise(resolve=>setTimeout(resolve,5000))]);
            const pending=await command('systemctl',['--user','list-jobs','--no-legend','--no-pager'],2000);
            return Object.freeze({unitName,launcherClosed:closed,startRegistered,
              pendingStartsExcluded:closed&&pending.code===0&&!pending.output.includes(unitName),
              unitStopped:unitStopped===true,launcherCode:closeCode});
          })();
          return stopPromise;
        },
        closed:closure,ready
      };
      return Object.freeze(handle);
    }
  });
}
