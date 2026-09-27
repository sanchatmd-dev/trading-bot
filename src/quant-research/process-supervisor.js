import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const failure=(code,stopped=false)=>Object.assign(new Error(code),{code,stopped});
const validUnit=name=>typeof name==='string'&&/^robot-quant-[a-z0-9-]{1,100}\.service$/.test(name);
export const DEFAULT_PROCESS_LIMITS=Object.freeze({cpuPercent:50,memoryBytes:512*1024*1024,tasks:16});

function command(file,args,timeoutMs=10000) {
  return new Promise(resolve=>{
    let stdout='',done=false;
    const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','ignore']});
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(-1);},timeoutMs);
    function finish(code){if(done)return;done=true;clearTimeout(timer);resolve({code,stdout});}
    child.stdout.on('data',data=>{if(stdout.length<4096)stdout+=data;});
    child.on('error',()=>finish(-1));child.on('close',code=>finish(code));
  });
}

/** Requires proof the launcher cannot issue a future start for this identity.
 * A missing unit by itself does not establish that proof after worker restart.
 */
export async function stopQuantUnit(unitName) {
  if(process.platform!=='linux'||!validUnit(unitName))return false;
  await command('systemctl',['--user','kill','--kill-whom=all','--signal=KILL',unitName]);
  await command('systemctl',['--user','stop',unitName]);
  const state=await command('systemctl',['--user','show',unitName,'--property=LoadState,ActiveState,SubState,ControlGroup']);
  // A missing unit is proof only when the manager answered successfully.
  if(state.code!==0||!(/LoadState=not-found/.test(state.stdout)||/ActiveState=(inactive|failed)\b/.test(state.stdout)))return false;
  const group=state.stdout.match(/^ControlGroup=(.+)$/m)?.[1];
  if(group){
    const location=path.resolve('/sys/fs/cgroup','.'+group);
    if(!location.startsWith('/sys/fs/cgroup/'))return false;
    try{if(!/^populated 0$/m.test(await readFile(path.join(location,'cgroup.events'),'utf8')))return false;}
    catch(error){if(error.code!=='ENOENT')return false;}
  }
  return true;
}

/** Linux transient service provides process-tree CPU/memory/task/wall limits.
 * The Promise never permits slot release before physical termination is verified.
 * Unsupported-platform mode is explicit and for isolated local tests only.
 */
export async function runQuantProcess({payload,module='robot_quant.research_engine',signal,
  python=process.env.QUANT_RESEARCH_PYTHON||'python3',timeoutMs=30000,
  limits=DEFAULT_PROCESS_LIMITS,unitName='robot-quant-'+randomUUID()+'.service',
  allowUnsupportedPlatformForTests=false}={}) {
  if(process.platform!=='linux'&&!allowUnsupportedPlatformForTests)throw failure('QUANT_OS_ISOLATION_REQUIRED',true);
  if(!validUnit(unitName)||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000||
    !/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)+$/.test(module)||typeof python!=='string'||!python)throw failure('INVALID_QUANT_PROCESS_REQUEST',true);
  const {cpuPercent,memoryBytes,tasks}=limits;
  if(!Number.isInteger(cpuPercent)||cpuPercent<1||cpuPercent>100||!Number.isSafeInteger(memoryBytes)||
    memoryBytes<128*1024*1024||memoryBytes>2*1024*1024*1024||!Number.isInteger(tasks)||tasks<4||tasks>32)throw failure('INVALID_QUANT_PROCESS_LIMITS',true);
  let input;
  try{input=JSON.stringify(payload);}catch{throw failure('INVALID_QUANT_PROCESS_PAYLOAD',true);}
  if(!input||Buffer.byteLength(input)>8*1024*1024)throw failure('RESEARCH_REQUEST_TOO_LARGE',true);
  if(signal?.aborted)throw failure('RESEARCH_INTERRUPTED',true);
  const linux=process.platform==='linux';
  const pythonArgs=['-m',module];
  const file=linux?'systemd-run':python;
  const args=linux?['--user','--quiet','--wait','--pipe','--collect','--unit='+unitName,
    '--property=CPUAccounting=yes','--property=MemoryAccounting=yes',
    '--property=CPUQuota='+cpuPercent+'%','--property=MemoryMax='+memoryBytes,
    '--property=TasksMax='+tasks,'--property=IOWeight=10','--property=Nice=10',
    '--property=KillMode=control-group','--property=TimeoutStopSec=3',
    '--property=RuntimeMaxSec='+Math.ceil(timeoutMs/1000),'--property=LimitCORE=0',
    '--property=LimitNOFILE=64','--setenv=OMP_NUM_THREADS=1','--setenv=OPENBLAS_NUM_THREADS=1',
    '--setenv=MKL_NUM_THREADS=1','--setenv=NUMEXPR_NUM_THREADS=1',
    '--setenv=PYTHONPATH='+path.join(root,'quant_lab/src')+path.delimiter+root,
    '--working-directory='+root,python,...pythonArgs]:pythonArgs;
  return new Promise((resolve,reject)=>{
    let output='',reason=null,closed=false,completed=false,stopPromise=null;
    const child=spawn(file,args,{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{...process.env,PYTHONPATH:path.join(root,'quant_lab/src')+path.delimiter+root,
        OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'}});
    const physicalStop=()=>{
      if(!stopPromise)stopPromise=(async()=>{
        if(linux){
          // Do not acknowledge a missing unit while systemd-run may still enqueue
          // its start. Wait for registration or a natural launcher completion.
          const deadline=Date.now()+3000;
          let registered=false;
          while(!closed&&Date.now()<deadline){
            const state=await command('systemctl',['--user','show',unitName,'--property=LoadState'],1000);
            if(state.code===0&&/^LoadState=loaded$/m.test(state.stdout)){registered=true;break;}
            await new Promise(resolve=>setTimeout(resolve,25));
          }
          if(!closed&&!registered){child.kill('SIGKILL');return false;}
          const stopped=await stopQuantUnit(unitName);
          if(!closed)child.kill('SIGKILL');
          return stopped;
        }
        if(child.pid&&!closed)await command('taskkill',['/PID',String(child.pid),'/T','/F']);
        if(!closed)child.kill('SIGKILL');
        return true; // Local test mode still waits for close below; not an OS isolation claim.
      })();
      return stopPromise;
    };
    const abort=()=>{reason??='RESEARCH_INTERRUPTED';void physicalStop();};
    const timer=setTimeout(()=>{reason??='EVALUATION_TIMED_OUT';void physicalStop();},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    const finish=async code=>{
      if(completed)return;completed=true;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      const stopped=linux?await physicalStop():stopPromise?await stopPromise:true;
      if(!stopped){reject(failure('QUANT_PROCESS_STOP_UNCONFIRMED',false));return;}
      if(reason||code!==0){reject(failure(reason||'EVALUATION_FAILED',true));return;}
      try{const result=JSON.parse(output);if(!result||result.error)throw Error();resolve(result);}
      catch{reject(failure('INVALID_EVALUATION_RESPONSE',true));}
    };
    child.stdout.on('data',data=>{if(reason)return;output+=data;if(Buffer.byteLength(output)>2*1024*1024){output='';reason='EVALUATION_OUTPUT_TOO_LARGE';void physicalStop();}});
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{reason??='QUANT_PYTHON_UNAVAILABLE';void finish(-1);});
    child.on('close',code=>void finish(code));
    child.stdin.end(input);
    if(signal?.aborted)abort();
  });
}
