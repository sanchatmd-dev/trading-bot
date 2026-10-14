// Frozen DP1-S r5 synthetic signal projection. See provenance.json. No transport or deployment entry points.
export function must(v,c){if(!v)throw Object.assign(new Error(c),{code:c});}
export function codeOf(e,dflt){const c=e&&(e.code||e.message);return typeof c==='string'&&/^[A-Z][A-Z0-9_]{2,47}$/.test(c)?c:dflt;}
export function canon(x){return Array.isArray(x)?'['+x.map(canon).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canon(x[k])).join(',')+'}':JSON.stringify(x);}
export function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
export function termPoint(){if(TERM.req)throw Object.assign(new Error('TERMINATED'),{code:'TERMINATED'});}
export function timeLeft(B,t0){return t0+B.budget.remoteMs-B.budget.marginMs-Date.now();}
export function needTime(B,t0,ms,code){must(timeLeft(B,t0)>=ms,code);}
export function startOut(B,extra){
 const o={job:B.job,mode:B.mode,attemptId:B.attemptId,namespaceSha:B.namespaceSha,verdict:'STOP',code:null,phase:'PRE',pass:false,startedAt:new Date().toISOString(),hostPid:process.pid,...extra};LIVE(o);return o;}
export function stopWorker(B,oldPid){
 const r=sysctl(B,['stop',B.site.units.worker],B.limits.stopMs);must(r.rc===0&&!r.error,'STOP_FAILED');
 const u=unitFacts(B,B.site.units.worker);must((u.active==='inactive'||u.active==='failed')&&u.pid===0&&!(oldPid&&procAlive(B,oldPid)),'STOP_VERIFY');return {active:u.active};}
export function startWorker(B){const r=sysctl(B,['start',B.site.units.worker],B.limits.startMs);must(r.rc===0&&!r.error,'START_FAILED');}
export async function startLimitWait(B,t0,code,rec){const u=unitFacts(B,B.site.units.worker);if(u.result!=='start-limit-hit')return 0;const ms=B.pins&&B.pins.worker&&B.pins.worker.restart?B.pins.worker.restart.intervalMs:null;
 const used=rec.startLimitWaitMs||0;
 must(Number.isSafeInteger(ms)&&ms>=0&&used+ms+1000<=B.limits.startLimitAllowMs&&timeLeft(B,t0)>=ms+1000+2*B.limits.startMs+2*B.limits.showMs+B.budget.readyMs,code+'_START_LIMIT_WAIT');
 await sleep(ms+1000);rec.startLimitWaitMs=used+ms+1000;return ms+1000;}
export async function startWithLimit(B,t0,code,rec){rec.startLimitWaitMs=0;await startLimitWait(B,t0,code,rec);
 const r=sysctl(B,['start',B.site.units.worker],B.limits.startMs);if(r.rc===0&&!r.error)return;
 must(unitFacts(B,B.site.units.worker).result==='start-limit-hit','START_FAILED');await startLimitWait(B,t0,code,rec);startWorker(B);}
export async function rbMain(B){
 const t0=Date.now(),out=startOut(B,{effects:{pending:'NOT_ATTEMPTED',archive:'NOT_ATTEMPTED',reload:'NOT_ATTEMPTED',stop:'NOT_ATTEMPTED',start:'NOT_ATTEMPTED'},noRetry:true});
 const ctx={healthRequired:true,dbUrl:null,port:null};
 try{entryGate(B);must(dirState(B.paths.oldTree)==='DIR','RB_OLD_TREE_MISSING');
  const f=await collect(B,{heartbeatGate:false,healthGate:false,dbFromUnit:true,sqlSoft:true});
  const W=f.workerState,workerDown=!(W.active==='active'&&W.sub==='running'),systemicUp=!!f.sqlOk&&!!f.baseline&&f.baseline.systemic>B.pins.baseline.systemic,incident=workerDown||systemicUp;
  const asFact=['PCL_MEMORY','PCL_LOAD','PCL_HEAVY_JOB',...(incident?['PCL_QUEUED_OLD','PCL_SQL_UNAVAILABLE']:[])];
  out.pre={stops:f.fail.filter(c=>!asFact.includes(c)),facts:f.fail.filter(c=>asFact.includes(c)),workerDown,systemicUp,queue:f.queue||null,worker:W,health:f.health,load:f.load,heavy:f.heavy,otherNeedReload:f.otherNeedReload,dbUrlSource:f.proc?f.proc.dbUrlSource:(f.dbUrlSource||'NONE'),dbUrlMatchesPin:(f.proc?f.proc.dbUrlSha:f.unitDbUrlSha)===B.pins.dbUrlSha};
  if(out.pre.stops.length)throw Object.assign(new Error(out.pre.stops[0]),{code:out.pre.stops[0]});
  const oc=closureFacts(B.paths.oldTree,B.pins.closure,null);out.oldTree={ok:oc.rawEqual===oc.files,files:oc.files,rawEqual:oc.rawEqual};must(out.oldTree.ok,'RB_OLD_TREE_DRIFT');
  // Watched units: compared with the latest passing post receipt (else PC pins). PID changes are facts; a unit that was
  // active and is now down stops the rollback unless the trading worker itself is in an incident state.
  const ref=B.rbRef||B.pins.units;out.unitChanges=Object.entries(ref).filter(([l,u])=>!f.units[l]||f.units[l].pid!==u.pid||f.units[l].active!==u.active).map(([l])=>l);
  const down=Object.entries(ref).filter(([l,u])=>u.active==='active'&&(!f.units[l]||f.units[l].active!=='active')).map(([l])=>l);
  if(down.length&&!incident)throw Object.assign(new Error('RB_UNIT_STATE'),{code:'RB_UNIT_STATE'});
  ctx.dbUrl=f.ctx.dbUrl;ctx.port=f.ctx.port;ctx.healthRequired=!!f.api.active;
  const layer=dirState(B.paths.layer),arch=dirState(B.paths.layerArchive),pend=dirState(B.paths.layerPending),loadedNew=W.wdIsNew,loadedOld=W.wdIsOld,ndr=W.needReload;
  out.state={layer,archive:arch,pending:pend,loadedNew,loadedOld,needReload:ndr,active:W.active};
  if(pend==='FILE'){must(tuple(B.paths.layerPending).raw===B.layerSha,'RB_STATE_UNKNOWN');}
  let branch=null;
  if(layer==='FILE'&&arch==='ABSENT'&&loadedNew&&ndr==='no')branch='A';
  else if(layer==='FILE'&&arch==='ABSENT'&&loadedOld&&ndr!=='no')branch='A2';
  else if(layer==='ABSENT'&&arch==='FILE'&&loadedOld&&ndr==='no')branch='B1';
  else if(layer==='ABSENT'&&arch==='FILE'&&(loadedNew||ndr!=='no'))branch='B2';
  else if(layer==='ABSENT'&&arch==='ABSENT'&&pend==='FILE'&&loadedOld&&ndr==='no')branch='P';
  out.branch=branch;must(!!branch,'RB_STATE_UNKNOWN');
  if(branch!=='B1'&&branch!=='P')must(f.otherNeedReload.needReload===0,'RB_OTHER_NEED_RELOAD');
  if(branch==='B1'&&!workerDown&&f.proc&&f.proc.cwdIsOld){const g=loadedGate(B,false);out.loaded=g;must(g.ok,'RB_LOADED_GATE');out.pass=true;out.verdict='RB_PASS';out.code='ROLLBACK_ALREADY_DONE';out.phase='DONE';return out;}
  needTime(B,t0,B.budget.rbPreMs,'RB_PRE_TIME_BUDGET');
  out.phase='EFFECT';
  if(pend==='FILE'){out.effects.pending='ATTEMPTED';fs.unlinkSync(B.paths.layerPending);out.effects.pending='REMOVED';}
  termPoint();
  if(branch==='A'||branch==='A2'){out.effects.archive='ATTEMPTED';noClobberMove(B.paths.layer,B.paths.layerArchive);out.effects.archive='ARCHIVED';}
  termPoint();
  if(branch!=='B1'&&branch!=='P'){out.effects.reload='ATTEMPTED';reloadOnce(B,'RB');out.effects.reload='RELOADED';}
  const g=loadedGate(B,false);out.loaded=g;must(g.ok,'RB_LOADED_GATE');
  if(branch==='P'&&!workerDown&&f.proc&&f.proc.cwdIsOld){out.pass=true;out.verdict='RB_PASS';out.code='RB_PASS_PENDING_REMOVED';out.phase='DONE';return out;}
  termPoint();
  const w=unitFacts(B,B.site.units.worker);
  needTime(B,t0,B.budget.startLimitSectionMs+B.budget.readyMs,'RB_TIME_BUDGET');
  if(w.active==='active'||w.active==='activating'||w.active==='deactivating'){out.effects.stop='ATTEMPTED';stopWorker(B,w.pid);out.effects.stop='STOPPED_VERIFIED';}
  out.effects.start='ATTEMPTED';await startWithLimit(B,t0,'RB',out);const rd=await readiness(B,w.pid,B.paths.oldTree,ctx);out.ready=rd;must(rd.ready,'RB_'+(rd.code||'NOT_READY'));out.effects.start='STARTED_READY';
  out.pass=true;out.verdict='RB_PASS';out.code=branch==='B1'||branch==='P'?'RB_PASS_START_ONLY':'RB_PASS';out.phase='DONE';
 }catch(e){out.code=codeOf(e,out.phase==='PRE'?'PRE_UNKNOWN':'RB_UNKNOWN');}
 return out;}
