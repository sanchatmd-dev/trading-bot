// PREPARED, UNRUN. Linux GNU timeout only. No systemctl, network, database or service access.
// Run later only under a separate bounded local-fixture packet: node signal-r5.mjs <new-output-directory>.
// Exercises the actual rbMain/stopWorker/startWithLimit functions with an external sleeping command as systemctl seam.
// Scaled timing proves delivery ordering, not actual host/systemd behavior or the 268 s production arithmetic.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';
import * as H from './host.mjs';
if(process.platform!=='linux')throw Error('LINUX_REQUIRED_NO_WINDOWS_SIGNAL_EQUIVALENCE');
const version=cp.spawnSync('timeout',['--version'],{encoding:'utf8'});assert.match(version.stdout,/GNU coreutils/);
const root=path.resolve(process.argv[2]||'');if(!process.argv[2]||fs.existsSync(root))throw Error('NEW_OUTPUT_DIRECTORY_REQUIRED');fs.mkdirSync(root);
const results=[];
for(const scenario of ['slow-stop','first-start','start-limit-recovery','start-limit-exhaustion']){
 const d=root+'/'+scenario;fs.mkdirSync(d);const state=d+'/state.json',events=d+'/events.jsonl';
 fs.writeFileSync(state,JSON.stringify({active:'active',pid:1,result:'success',starts:0}));
 const child=`import fs from 'node:fs';const [file,log,scenario,verb]=process.argv.slice(1);let s=JSON.parse(fs.readFileSync(file));const event=x=>fs.appendFileSync(log,JSON.stringify({event:x,at:Date.now()})+'\\n');event(verb+'-begin');await new Promise(r=>setTimeout(r,scenario==='slow-stop'&&verb==='stop'?1100:scenario==='first-start'&&verb==='start'?1100:20));if(verb==='stop'){s.active='inactive';s.pid=0;}else{s.starts++;if(scenario.startsWith('start-limit-')&&s.starts===1){s.active='failed';s.result='start-limit-hit';}else{s.active='active';s.pid=2;s.result='success';}}fs.writeFileSync(file,JSON.stringify(s));event(verb+'-end');process.exit(verb==='start'&&s.result==='start-limit-hit'?1:0);`;
 const limits={...L.LIMITS,stopMs:1500,startMs:1500,showMs:100,startLimitAllowMs:scenario==='start-limit-exhaustion'?1500:2000};
 const sectionMs=limits.stopMs+4*limits.showMs+2*limits.startMs+limits.startLimitAllowMs;
 const reportMarginMs=1000,termAfterMs=700,killAfterMs=sectionMs+reportMarginMs,parentMarginMs=2000;
 const parentWallMs=termAfterMs+killAfterMs+parentMarginMs;
 const readyMs=100,configRestoreMs=100,rbPreMs=configRestoreMs+limits.showMs+sectionMs+readyMs;
 const remoteMs=rbPreMs+2*parentMarginMs;
 const B={job:'fixture',mode:'rb',attemptId:'a01',namespaceSha:'fixture',site:{units:{worker:'fixture'}},paths:{oldTree:'old',newTree:'new',layer:'layer',layerArchive:'archive',layerPending:'pending'},pins:{closure:{},baseline:{systemic:0},worker:{restart:{intervalMs:900}},units:{}},limits,budget:{remoteMs,marginMs:0,reloadStepMs:100,readyMs,startLimitSectionMs:sectionMs,configRestoreMs,rbPreMs}};
 const f={workerState:{active:'active',sub:'running',pid:1,wdIsNew:true,wdIsOld:false,needReload:'no'},fail:[],baseline:{systemic:0},sqlOk:true,proc:{cwdIsOld:false,dbUrlSha:null},units:{},health:{ok:true},api:{active:true},otherNeedReload:{needReload:0},ctx:{dbUrl:'synthetic',port:1}};
 const seams=`const STATE=${JSON.stringify(state)},EVENTS=${JSON.stringify(events)},SCENARIO=${JSON.stringify(scenario)},CHILD=${JSON.stringify(child)};
 const event=x=>fs.appendFileSync(EVENTS,JSON.stringify({event:x,at:Date.now()})+'\\n');process.on('SIGTERM',()=>event('term-handler'));
 const entryGate=()=>{},collect=async()=>${JSON.stringify(f)},dirState=p=>p==='old'?'DIR':p==='layer'?'FILE':'ABSENT',closureFacts=()=>({rawEqual:1,files:1}),noClobberMove=()=>event('archive'),reloadOnce=()=>event('reload'),loadedGate=()=>({ok:true,pid:1});
 const unitFacts=()=>{const s=JSON.parse(fs.readFileSync(STATE));return {...s,sub:s.active==='active'?'running':'dead'};};
 const procAlive=(_B,pid)=>JSON.parse(fs.readFileSync(STATE)).pid===pid;
 const sysctl=(_B,args,ms)=>{const r=cp.spawnSync(process.execPath,['--input-type=module','-e',CHILD,STATE,EVENTS,SCENARIO,args[0]],{timeout:ms,encoding:'utf8'});return {rc:r.status,error:r.error?r.error.code:null};};
 const readiness=async()=>{await new Promise(r=>setTimeout(r,30));termPoint();return {ready:true,pid:2,startMs:Date.now()};};
 `;
 const functions=['must','codeOf','canon','sleep','termPoint','timeLeft','needTime','startOut','stopWorker','startWorker','startLimitWait','startWithLimit','rbMain'].map(k=>H[k].toString()).join('\n');
 const text=L.PRELUDE+seams+'\nconst B='+JSON.stringify(B)+';\n'+functions+'\nconst out=await rbMain(B);DONE=true;event("report");console.log(JSON.stringify(out));';
 fs.writeFileSync(d+'/payload.mjs',text,{flag:'wx'});
 const r=cp.spawnSync('timeout',['--foreground','--signal=TERM','--kill-after='+killAfterMs/1000+'s',termAfterMs/1000+'s',process.execPath,d+'/payload.mjs'],{encoding:'utf8',timeout:parentWallMs,maxBuffer:1048576});
 fs.writeFileSync(d+'/transport.json',JSON.stringify({status:r.status,signal:r.signal,error:r.error?.code||null,stdout:r.stdout,stderr:r.stderr})+'\n',{flag:'wx'});
 let out=null;try{out=JSON.parse(r.stdout.trim());}catch{}
 const ev=fs.readFileSync(events,'utf8').trim().split('\n').map(JSON.parse),s=JSON.parse(fs.readFileSync(state));
 const exhaustion=scenario==='start-limit-exhaustion';
 const pass=exhaustion?!!out&&out.code==='RB_START_LIMIT_WAIT'&&out.phase==='EFFECT'&&s.starts===1&&s.active==='failed'&&out.startLimitWaitMs===0&&ev.some(x=>x.event==='report'):
  !!out&&r.signal!=='SIGKILL'&&s.active==='active'&&s.pid===2&&ev.some(x=>x.event==='term-handler')&&ev.some(x=>x.event==='report');
 results.push({scenario,pass,sectionMs,waitAllowanceMs:limits.startLimitAllowMs,killAfterMs,parentWallMs,rc:r.status,signal:r.signal,code:out?.code||null,oldWorkerStarted:s.active==='active'&&s.pid===2,events:ev});
}
fs.writeFileSync(root+'/results.json',JSON.stringify({schema:'dp1s-r5-linux-signal-v1',scaled:true,systemdProven:false,results},null,1)+'\n',{flag:'wx'});
console.log(JSON.stringify({cases:results.length,passed:results.filter(r=>r.pass).length}));if(results.some(r=>!r.pass))process.exitCode=1;
