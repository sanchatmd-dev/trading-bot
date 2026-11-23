// Generic systemd user-manager probe (J1R recovery design r9, section 10 test 1, with SB586 C1 to C6 and SB587 C12).
//
// Purpose: show on a real Linux user manager the systemd and kernel facts the J1R tool relies on, using throwaway
// static units and throwaway fixtures only. No product import, no tool import, no staging data, no secret, no
// network and no npm ci. It uses node:test, node:child_process and node:fs, plus node:path, node:os and node:crypto
// as core helpers.
//
// Skip rule: the test is skipped only when SYSTEMD_PROBE is not '1', so the ordinary `npm test` run skips it. With
// SYSTEMD_PROBE=1 it never skips: a non-Linux platform, an unreachable user manager or any setup error fails it.
//
// Summary file: $RUNNER_TEMP/systemd-probe.txt holds exactly eight newline-terminated lines in a fixed order, each
// KEY=value with a value from the closed token alphabet [A-Za-z0-9_.,:/<>-] and its own length cap. The workflow
// publish step re-checks every line. No runner path, user name or host name leaves the probe. The eighth line is
// DIAG (C15): one token <row>:<stage>:<observed> for every row that is not PASS, with stage and observed taken only
// from the closed lists DIAG_STAGES and DIAG_OBSERVED below, so a failing row can be diagnosed from the public check
// annotations alone. Row h always adds its U8 observation (h:U8:HOLDS or h:U8:NOT_HERE). DIAG is a record only.
//
// ---------------------------------------------------------------------------------------------------------------
// LINUX_ROWS fixed id list and result forms (SB586 C3). The probe and the fill both check the full list, in this
// order, each token `<id>:<form>`, joined by commas (copy this block into the build spec):
//   pgkill:GONE                   detached child group with a grandchild, killed as a group, both gone
//   pgexit0:CODE0_LIVE_GONE       child exits 0 at once, grandchild (stdio ignore) keeps the group live, group kill clears it
//   pgsig:SIGTERM                 child killed by SIGTERM closes with signal SIGTERM
//   pgnone:ENOENT                 spawn of a missing executable gives error code ENOENT
//   pgsetsid:ESCAPEE_ALIVE        setsid grandchild survives the group kill
//   stubpath:REACHED              stub systemctl on PATH is reached from the child group
//   envkeys:EXACT                 child env key set and cwd are exactly the given ones
//   symlinkexist:EEXIST_KEPT      symlink on an existing name fails EEXIST and leaves the entry unchanged
//   readlink:DEVNULL              readlink of the /dev/null link returns /dev/null
//   lstatbig:UID_STABLE_NEWINO    lstat bigint: link, runner uid, stable dev and ino, new ino after re-create
//   unlinklink:TARGET_KEPT        unlink of a link to a real file removes only the link
//   mkdirerr:ENOENT_EEXIST        mkdir fails ENOENT without a parent and EEXIST on an existing folder
//   nofollow:ELOOP                O_NOFOLLOW open of a link fails ELOOP
//   fifo:NONBLOCK_FIFO            O_NONBLOCK open of a FIFO returns at once and fstat shows a FIFO
//   inodecmp:SAME_THEN_SWAPPED    lstat then open give the same dev and ino; a swapped path gives another ino
//   sizecap:SIZE_FIRST            a file above a cap is seen by lstat size before any read
//   readdir:IDENTICAL             readdir of a fixture root leaves it byte-identical
//   zpipe:SHA_OK_NL3              C12: base64 -d | gzip -dc into a shell variable, sha256sum matches, a here-string
//                                 hands the text to node, and the three trailing newlines survive
//   zbad:EXIT86_NONODE            SB589 ruling 5: the packer's compressed-payload script construct (EXIT trap, brace
//                                 group, pipefail decode, sha256 check, exec of a stub node) with a corrupted base64
//                                 line, a changed hash and three truncations: each exits 86 with PAYLOAD_INTEGRITY on
//                                 stderr and the stub never starts; an unchanged script runs the stub with the exact text
// A row that gives another form is written as `<id>:FAIL` and fails the probe test. A row never run is `<id>:NOTRUN`.
// ---------------------------------------------------------------------------------------------------------------
import test from 'node:test';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ENABLED=process.env.SYSTEMD_PROBE==='1';

const LINUX_ROW_FORMS=Object.freeze([
  ['pgkill','GONE'],
  ['pgexit0','CODE0_LIVE_GONE'],
  ['pgsig','SIGTERM'],
  ['pgnone','ENOENT'],
  ['pgsetsid','ESCAPEE_ALIVE'],
  ['stubpath','REACHED'],
  ['envkeys','EXACT'],
  ['symlinkexist','EEXIST_KEPT'],
  ['readlink','DEVNULL'],
  ['lstatbig','UID_STABLE_NEWINO'],
  ['unlinklink','TARGET_KEPT'],
  ['mkdirerr','ENOENT_EEXIST'],
  ['nofollow','ELOOP'],
  ['fifo','NONBLOCK_FIFO'],
  ['inodecmp','SAME_THEN_SWAPPED'],
  ['sizecap','SIZE_FIRST'],
  ['readdir','IDENTICAL'],
  ['zpipe','SHA_OK_NL3'],
  ['zbad','EXIT86_NONODE'],
]);
const GATING=Object.freeze(['a','b','c','d','e','f','g','h','i','j','k','m','n']);
const ROW_ORDER=Object.freeze(['f','a','b','c','d','e','g','h','i','j','k','l','m','n']);
const GATING_TOTAL=13;
const NOTICE_KEYS=Object.freeze([['MAJORS',16],['ROWS',40],['ROW_L',48],['ROW_N',48],['UNITPATH',900],['FORMS',160],['LINUX_ROWS',400],['DIAG',300]]);
// C15 closed lists. A DIAG token is <row>:<stage>:<observed>; nothing outside these lists (and the row ids) is ever printed.
const DIAG_ROWS=Object.freeze(['setup',...GATING,'l',...LINUX_ROW_FORMS.map(([id])=>id)]);
const DIAG_STAGES=Object.freeze([
  'ROW','SETUP','NOTRUN','GUARD_SELF','U8',
  'STOP_HOLD','RELOAD_1','UNLOAD_WAIT','LINK_MAKE','LINK_NO_RELOAD','LINK_DROP','AFTER_UNLINK','RELOAD_2','LOAD_FINAL',   // row h
  'L_SETUP','L_NO_BUSCTL','L_MONITOR','L_ORDER',                                                                       // row l
  'SPAWN','PID_LINE','PID_VALID','GROUP_LIVE','ESC_LIVE','SESSION','GROUP_KILL','LEADER_EXIT','ESC_AFTER',              // pgsetsid
  'Z_CONTROL','Z_B64_BAD','Z_B64_FLIP','Z_HASH','Z_CUT_HEAD','Z_CUT_PAYLOAD','Z_CUT_EXEC',                              // zbad
  'UNKNOWN_STAGE']);
const DIAG_OBSERVED=Object.freeze([
  'HOLDS','NOT_HERE','NOT_RUN',
  'LS_loaded','LS_masked','LS_notfound','LS_empty','LS_other',
  'LIVE','NONE','EPERM','UNKNOWN',
  'SESS_OWN','SESS_SAME','SESS_OTHER','SESS_NOPROC',
  'CMD_FAIL','NOT_LOADED','STILL_LOADED','CF_PRESENT','TIMEOUT','CHECK','ERROR','SPAWN_ERR',
  'NO_TRUE_EXITED','NO_TRUE_8S','TRUE_EXITED','MONITOR_DEAD','ORDER_BAD',
  'CODE_0','CODE_1','CODE_2','CODE_86','CODE_OTHER','SIGNAL','NO_LABEL','STUB_RAN','STUB_SILENT','GOT_DIFF',
  'THROW_ESCAPED','REJECT_ESCAPED','BAD_RECORD',
  'UNKNOWN_OBS']);
const TOKEN=/^[A-Za-z0-9_.,:/<>-]+$/;
const REV_PROPS=Object.freeze(['RequiredBy','RequisiteOf','BoundBy','UpheldBy','WantedBy','PartOf','OnFailureOf','OnSuccessOf','BusName']);
const PRODUCT_SHOW=Object.freeze(['LoadState','ActiveState','SubState','ControlGroup','Job','MainPID','KillMode','TimeoutStopUSec']);
const VERSION_FORM=/^[0-9]{3}(?:[.~+-][0-9A-Za-z.~+-]{0,60})?$/;

class ProbeFail extends Error{
  constructor(message,obs){super(message);this.obs=obs;}      // obs: an optional DIAG_OBSERVED value for the failing stage
}
class ProbeInconclusive extends Error{}
const ok=(condition,message,obs)=>{if(!condition)throw new ProbeFail(message,obs);};
const eq=(actual,expected,message,obs)=>{if(actual!==expected)throw new ProbeFail(`${message}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`,obs);};
// Process-state strings (groupState, pidState) are themselves DIAG_OBSERVED values.
const eqState=(actual,expected,message)=>{if(actual!==expected)throw new ProbeFail(`${message}: got ${actual}`,actual);};
// The stage a row is in; a failure records the stage that was current when it happened.
let STAGE='ROW';
const at=stage=>{STAGE=stage;};
const lsObs=value=>value==='loaded'?'LS_loaded':value==='masked'?'LS_masked':value==='not-found'?'LS_notfound':value===''||value===undefined?'LS_empty':'LS_other';
function classify(failure){
  if(failure&&DIAG_OBSERVED.includes(failure.obs))return failure.obs;
  if(failure instanceof ProbeFail)return / failed code=/.test(failure.message)?'CMD_FAIL':/NOT_LOADED/.test(failure.message)?'NOT_LOADED':'CHECK';
  return 'ERROR';
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitUntil(predicate,limitMs,stepMs=50){
  const end=Date.now()+limitMs;
  for(;;){
    if(await predicate())return true;
    if(Date.now()>=end)return false;
    await sleep(stepMs);
  }
}
const sanitize=value=>String(value).replace(/[^A-Za-z0-9_.,:/<>-]/g,'_');

let CHILD_ENV=null;
function exec(file,args=[],options={}){
  const {timeoutMs=30000,env=CHILD_ENV||process.env,input,cwd,detached=false}=options;
  return new Promise(resolve=>{
    const out=[],err=[];
    let done=false,timedOut=false,spawnError=null,child;
    try{
      child=spawn(file,args,{env,cwd,detached,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});
    }catch(failure){
      resolve({code:null,signal:null,timedOut:false,spawnError:failure.code||'SPAWN',stdout:'',stdoutBuf:Buffer.alloc(0),stderr:''});
      return;
    }
    const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL');}catch{/* already gone */}},timeoutMs);
    const finish=(code,signal)=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      const buffer=Buffer.concat(out);
      resolve({code,signal,timedOut,spawnError,stdout:buffer.toString('utf8'),stdoutBuf:buffer,stderr:Buffer.concat(err).toString('utf8')});
    };
    child.stdout.on('data',data=>out.push(data));
    child.stderr.on('data',data=>err.push(data));
    if(child.stdin){child.stdin.on('error',()=>{});child.stdin.end(input);}
    child.on('error',failure=>{spawnError=failure.code||'ERR';finish(null,null);});
    child.on('close',(code,signal)=>finish(code,signal));
  });
}
const sc=(args,options)=>exec('systemctl',['--user',...args],options);
async function scOk(args,label){
  const result=await sc(args);
  if(result.code!==0)throw new ProbeFail(`${label||args[0]} failed code=${result.code} ${result.spawnError||''}${result.timedOut?' timeout':''}`);
  return result;
}
const reload=()=>scOk(['daemon-reload'],'daemon-reload');
async function showLines(unit,props){
  const args=['show','--no-pager',`--property=${props.join(',')}`];
  if(unit)args.push(unit);
  const result=await scOk(args,'show');
  return result.stdout.split('\n').filter(Boolean).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];});
}
const toMap=lines=>{const map={};for(const [key,value] of lines)map[key]=value;return map;};
async function showMap(unit,props){return toMap(await showLines(unit,props));}
async function loadState(unit){return (await showMap(unit,['LoadState'])).LoadState;}
async function isLoaded(unit){
  const result=await scOk(['list-units','--all','--plain','--no-legend',unit],'list-units');
  return result.stdout.split('\n').some(line=>{
    const tokens=line.trim().split(/\s+/);
    return tokens[0]===unit||(tokens.length>1&&tokens[1]===unit);
  });
}
async function requireLoaded(...units){
  for(const unit of units)ok(await isLoaded(unit),'NOT_LOADED');
}
async function ndr(unit){
  const value=(await showMap(unit,['NeedDaemonReload'])).NeedDaemonReload;
  return value==='yes'||value==='no'?value:'unknown';
}
const hex=bytes=>crypto.randomBytes(bytes).toString('hex');
const unitText=lines=>lines.join('\n')+'\n';
const oneshot=['[Service]','Type=oneshot','ExecStart=/bin/true'];

// ---------------------------------------------------------------------------------------------------------------
// Probe state and bookkeeping (everything the probe makes is registered so cleanup can remove exactly that).
let S=null;
function lstatOrNull(target){
  try{return fs.lstatSync(target);}catch(failure){if(failure.code==='ENOENT')return null;throw failure;}
}
function newState(){
  const suffix=hex(8);
  const uid=process.getuid();
  const xdg=process.env.XDG_RUNTIME_DIR||`/run/user/${uid}`;
  const home=(process.env.HOME||os.homedir()).replace(/\/+$/,'');
  const CF=`${xdg}/systemd/user.control`;
  const probe=`j1r-probe-${suffix}.service`;
  return {
    suffix,uid,xdg,home,CF,
    urt:`${xdg}/systemd/user`,
    unitDir:`${home}/.config/systemd/user`,
    probe,ctl:`j1r-ctl-${suffix}.service`,hold:`j1r-hold-${suffix}.service`,rev:`j1r-rev-${suffix}.service`,
    LNK:`${CF}/${probe}`,
    made:{files:[],dirs:[],tmp:[]},   // files and links we created, folders we created (in creation order), temp folders
    urtLinks:[],transient:[],
    cfMade:false,cfExistedAtStart:false,unitPathStart:[],
    mgrMajor:0,clientMajor:0,mgrVersion:'',
    origFrag:'',gB:false,gE:false,
    forms:{ver:'unknown',frag:'unknown',empty:'unknown',k:'unknown'},
    rowN:{B:'unknown',M:'unknown',S:'unknown',U:'unknown'},
    rowL:{outcome:'INCONCLUSIVE',attempts:0,form:'none'},
    u8:'NOT_RUN',guard:'NOT_RUN',fatalDiag:null,
    results:{},linux:{},linuxDiag:{},notes:[],cleanupFailed:[],
  };
}
function writeUnit(name,text){
  const file=`${S.unitDir}/${name}`;
  fs.writeFileSync(file,text,{flag:'wx',mode:0o644});
  S.made.files.push(file);
  return file;
}
function removeMadeFile(file){
  try{fs.unlinkSync(file);}catch(failure){if(failure.code!=='ENOENT')throw failure;}
}
function ensureCF(){
  try{
    fs.mkdirSync(S.CF);
    S.cfMade=true;
    S.made.dirs.push(S.CF);
    return false;                     // did not exist before
  }catch(failure){
    if(failure.code!=='EEXIST')throw failure;
    return true;                      // existed
  }
}
function makeLink(){
  fs.symlinkSync('/dev/null',S.LNK);
  if(!S.made.files.includes(S.LNK))S.made.files.push(S.LNK);
}
function dropLink(){
  const st=lstatOrNull(S.LNK);
  if(st&&st.isSymbolicLink())fs.unlinkSync(S.LNK);
}
async function readUnitPath(){
  const lines=await showLines(null,['UnitPath']);
  const found=lines.filter(([key])=>key==='UnitPath');
  ok(found.length===1,'UnitPath not printed once');
  return found[0][1].trim().split(/\s+/).filter(Boolean).map(entry=>entry.length>1?entry.replace(/\/+$/,''):entry);
}
function fragForm(fragment){
  if(fragment===''||fragment===undefined)return 'EMPTY';
  if(fragment==='/dev/null')return 'DEVNULL';
  if(fragment===S.LNK||fragment.startsWith(`${S.CF}/`))return 'LINK';
  return 'OTHER';
}
// Letters first, then digits: the digit token N must not be turned into a letter token afterwards (first run gave a.a-a.a).
const versionForm=value=>sanitize(value.replace(/[A-Za-z]+/g,'a').replace(/[0-9]+/g,'N'));
function classifyElapse(value){
  if(value===''||value===undefined)return 'EMPTY';
  if(value==='n/a')return 'NA';
  if(/^0(?:us|ms|s)?$/.test(value))return 'ZERO';
  return 'SET';
}

// ---------------------------------------------------------------------------------------------------------------
// Setup.
async function setup(){
  at('SETUP');
  const clientOut=await exec('systemctl',['--user','--version']);
  const clientMatch=/^systemd (\d+)/m.exec(clientOut.stdout);
  ok(clientOut.code===0&&clientMatch,'systemctl --version unreadable');
  S.clientMajor=Number(clientMatch[1]);
  const version=await showLines(null,['Version']);      // also proves the user manager answers
  const versionLine=version.filter(([key])=>key==='Version');
  ok(versionLine.length===1,'Version not printed once');
  S.mgrVersion=versionLine[0][1];
  S.mgrMajor=parseInt(S.mgrVersion,10)||0;
  // Facts at probe start, before any unit file is written and before any row could make CF (row f uses them).
  S.cfExistedAtStart=lstatOrNull(S.CF)!==null;
  S.unitPathStart=await readUnitPath();
  // The user unit folder; remember every level the probe makes so cleanup removes exactly those.
  const levels=[`${S.home}/.config`,`${S.home}/.config/systemd`,S.unitDir];
  for(const level of levels){
    if(lstatOrNull(level)===null){fs.mkdirSync(level);S.made.dirs.push(level);}
  }
  const unitBlock=name=>['[Unit]','Description=probe',''];
  writeUnit(S.probe,unitText([...unitBlock(),...oneshot]));
  writeUnit(S.ctl,unitText([...unitBlock(),...oneshot]));
  writeUnit(S.hold,unitText([
    '[Unit]','Description=probe holder',`After=${S.probe} ${S.ctl} ${S.rev}`,'',
    '[Service]','Type=oneshot','RemainAfterExit=yes','ExecStart=/bin/true']));
  await reload();
  await scOk(['start',S.hold],'start holder');
}

// ---------------------------------------------------------------------------------------------------------------
// Rows a to n.
async function rowF(){
  if(S.cfExistedAtStart)return {r:'INCONCLUSIVE',note:'CF_PRESENT_AT_START',stage:'ROW',obs:'CF_PRESENT'};
  const entries=S.unitPathStart;
  ok(entries.length>0,'UNITPATH_EMPTY');
  const rank=entry=>entries.indexOf(entry);
  const config=`${S.home}/.config/systemd`;
  const rCF=rank(S.CF),rHomeControl=rank(`${config}/user.control`),rConfig=rank(`${config}/user`),rRuntime=rank(S.urt);
  ok(rCF>=0,'CF_NOT_LISTED_BEFORE_IT_EXISTS');
  ok(rHomeControl>=0,'HOME_USER_CONTROL_NOT_LISTED');
  ok(rConfig>=0&&rRuntime>=0,'USER_FOLDERS_NOT_LISTED');
  ok(rCF<rConfig&&rConfig<rRuntime,'RANK_ORDER');
  return {r:'PASS'};
}
async function rowA(){
  try{
    await scOk(['mask','--runtime',S.probe],'mask --runtime');
    const state=await showMap(S.probe,['LoadState','FragmentPath','UnitFileState']);
    eq(state.LoadState,'loaded','row a LoadState after mask --runtime');
    await scOk(['unmask','--runtime',S.probe],'unmask --runtime');
  }finally{
    await sc(['unmask','--runtime',S.probe]);
    const link=`${S.urt}/${S.probe}`;
    const st=lstatOrNull(link);
    if(st&&st.isSymbolicLink())fs.unlinkSync(link);
  }
}
async function rowB(){
  await requireLoaded(S.probe,S.ctl);
  S.origFrag=(await showMap(S.probe,['FragmentPath'])).FragmentPath;
  await readUnitPath();
  S.notes.push(`b0:${await ndr(S.probe)}`);
  const existed=ensureCF();
  S.notes.push(`bCFexisted:${existed}`);
  S.notes.push(`bP1:${await ndr(S.probe)}`,`bC1:${await ndr(S.ctl)}`);
  makeLink();
  S.notes.push(`bP2:${await ndr(S.probe)}`,`bC2:${await ndr(S.ctl)}`);
  await reload();
  const state=await showMap(S.probe,['LoadState','ActiveState','NeedDaemonReload','FragmentPath','UnitFileState']);   // no sleep
  S.gB=state.LoadState==='masked';
  S.forms.frag=fragForm(state.FragmentPath);
  eq(state.LoadState,'masked','row b LoadState after reload');
  eq(state.ActiveState,'inactive','row b ActiveState');
  eq(state.NeedDaemonReload,'no','row b NeedDaemonReload after reload');
}
async function productShow(unit){
  const result=await scOk(['show',unit,`--property=${PRODUCT_SHOW.join(',')}`],'product show');
  return toMap(result.stdout.split('\n').filter(Boolean).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
}
function assertStoppedMasked(state,label){
  eq(state.LoadState,'masked',`${label} LoadState`);
  ok(['inactive','failed'].includes(state.ActiveState),`${label} ActiveState`);
  ok(['','0'].includes(state.Job??''),`${label} Job`);
  ok(!state.ControlGroup,`${label} ControlGroup`);
}
async function rowC(){
  assertStoppedMasked(await productShow(S.probe),'row c');
}
async function rowD(){
  await reload();
  eq(await loadState(S.probe),'masked','row d after second reload');
  const name=`robot-quant-${hex(32)}.service`;
  S.urtLinks.push(name);
  await scOk(['mask','--runtime',name],'mask --runtime never-loaded');
  eq(await loadState(S.probe),'masked','row d after the product reload');
}
async function rowE(){
  await requireLoaded(S.probe,S.ctl);
  ok(lstatOrNull(S.LNK)!==null,'row e needs the link row b made');
  fs.unlinkSync(S.LNK);
  S.notes.push(`eP:${await ndr(S.probe)}`);
  await reload();
  const state=await showMap(S.probe,['LoadState','FragmentPath','ActiveState','Job']);   // no sleep
  S.gE=state.LoadState==='loaded';
  eq(state.LoadState,'loaded','row e LoadState after unlink and reload');
  eq(state.FragmentPath,S.origFrag,'row e FragmentPath');
  eq(state.ActiveState,'inactive','row e ActiveState');
  ok(['','0'].includes(state.Job??''),'row e Job');
  const cf=lstatOrNull(S.CF);
  ok(cf&&cf.isDirectory(),'row e CF still present');
}
async function rowG(){
  ok(S.gB===true&&S.gE===true,'row b or row e did not show the new LoadState right after the reload');
}
// Row h (C16). U8 (an unloaded unit, loaded on demand after the link and with no reload, sees the link) is a fact the
// design never relies on for safety, so row h only records which way it went: masked is U8:HOLDS, loaded is U8:NOT_HERE.
// Any other LoadState, or any command error, at any stage is a FAIL, as is a closing reload that does not load the unit.
async function rowH(){
  try{
    at('STOP_HOLD');
    await scOk(['stop',S.hold],'stop holder');
    at('RELOAD_1');
    await reload();
    at('UNLOAD_WAIT');
    const gone=await waitUntil(async()=>!(await isLoaded(S.probe)),10000,250);
    if(!gone)return {r:'INCONCLUSIVE',note:'STILL_LOADED_10S',stage:'UNLOAD_WAIT',obs:'STILL_LOADED'};
    at('LINK_MAKE');
    ensureCF();
    makeLink();
    at('LINK_NO_RELOAD');
    const first=await loadState(S.probe);
    if(first==='masked')S.u8='HOLDS';
    else if(first==='loaded')S.u8='NOT_HERE';
    else throw new ProbeFail(`row h LoadState after link, no reload: ${JSON.stringify(first)}`,lsObs(first));
    at('LINK_DROP');
    dropLink();
    at('AFTER_UNLINK');
    S.notes.push(`hAfterUnlink:${await loadState(S.probe)}`);
    at('RELOAD_2');
    await reload();
    at('LOAD_FINAL');
    const last=await loadState(S.probe);
    if(last!=='loaded')throw new ProbeFail(`row h LoadState after unlink and reload: ${JSON.stringify(last)}`,lsObs(last));
    return {r:'PASS'};
  }finally{
    dropLink();
    await sc(['start',S.hold]);
  }
}
async function rowI(){
  try{
    await requireLoaded(S.probe);
    const lines=await showLines(S.probe,['Id','Names',...REV_PROPS,'NoSuchProperty']);
    const count=key=>lines.filter(([name])=>name===key).length;
    const value=key=>(lines.find(([name])=>name===key)||[,''])[1];
    const printed=REV_PROPS.filter(key=>count(key)===1).length;
    S.forms.empty=printed===REV_PROPS.length?'PRINTED_EMPTY':printed===0?'ABSENT':'MIXED';
    for(const key of REV_PROPS){
      eq(count(key),1,`row i ${key} printed once`);
      eq(value(key),'',`row i ${key} empty`);
    }
    eq(count('Names'),1,'row i Names printed once');
    ok(value('Names').split(/\s+/).includes(S.probe),'row i Names holds the probe');
    eq(count('NoSuchProperty'),0,'row i unknown property not printed');
    // Positive control: a loaded reverse-dependency unit makes WantedBy and OnFailureOf non-empty.
    writeUnit(S.rev,unitText(['[Unit]','Description=probe',`Wants=${S.probe}`,`OnFailure=${S.probe}`,'',...oneshot]));
    await reload();
    await requireLoaded(S.rev,S.probe);
    const positive=toMap(await showLines(S.probe,['WantedBy','OnFailureOf']));
    ok((positive.WantedBy||'')!=='','row i WantedBy non-empty');
    ok((positive.OnFailureOf||'')!=='','row i OnFailureOf non-empty');
  }finally{
    // C5: remove the reverse-dependency unit and reload before the next row.
    const file=`${S.unitDir}/${S.rev}`;
    removeMadeFile(file);
    S.made.files=S.made.files.filter(entry=>entry!==file);
    await reload();
  }
}
async function rowJ(){
  const lines=(await showLines(null,['Version'])).filter(([key])=>key==='Version');
  eq(lines.length,1,'row j Version printed once');
  const value=lines[0][1];
  S.forms.ver=versionForm(value);
  ok(VERSION_FORM.test(value),'row j Version form');
  eq(parseInt(value,10),S.clientMajor,'row j manager major equals client major');
}
async function rowK(){
  ensureCF();
  dropLink();
  makeLink();
  try{
    const result=await sc(['unmask',S.probe]);
    ok(!result.spawnError&&!result.timedOut,'row k unmask did not run');
    const kept=lstatOrNull(S.LNK)!==null;
    S.forms.k=kept?'LNKKEPT':'LNKGONE';
  }finally{
    dropLink();
    await reload();
  }
}
async function rowM(){
  const transientName=()=>`robot-quant-${hex(32)}`;
  const live=`${transientName()}.service`,finished=`${transientName()}.service`,calendar=transientName(),active=transientName();
  S.urtLinks.push(live,finished);
  S.transient.push(live,finished,`${calendar}.timer`,`${calendar}.service`,`${active}.timer`,`${active}.service`);
  const run=await exec('systemd-run',['--user','--collect','--quiet',`--unit=${live}`,'/bin/sleep','600']);
  ok(run.code===0,'row m live unit did not start');
  const done=await exec('systemd-run',['--user','--collect','--quiet',`--unit=${finished}`,'/bin/true']);
  ok(done.code===0,'row m finished unit did not start');
  await waitUntil(async()=>!['active','activating'].includes((await productShow(finished)).ActiveState),5000,200);
  // The product's own sequence (quant-foundation-recovery.js retireUnit): kill, stop, mask --runtime, show.
  for(const unit of [live,finished]){
    const before=await productShow(unit);
    const isLive=['active','activating','deactivating'].includes(before.ActiveState);
    if(unit===live)ok(isLive,'row m live unit is not live');
    if(isLive)ok((await sc(['kill','--kill-whom=all','--signal=KILL',unit])).code===0,'row m kill');
    if(isLive||before.LoadState==='loaded'){
      const stop=await sc(['stop',unit]);
      ok(stop.code===0||stop.code===5,'row m stop');          // 5: the --collect unit is already gone after SIGKILL
    }
    await scOk(['mask','--runtime',unit],'row m mask --runtime');
    assertStoppedMasked(await productShow(unit),'row m');
  }
  // Timer forms (GATE_TIMERS): one realtime-only timer and one monotonic-only timer.
  const cal=await exec('systemd-run',['--user','--quiet',`--unit=${calendar}`,'--on-calendar=2099-01-01 00:00:00','/bin/true']);
  ok(cal.code===0,'row m calendar timer did not start');
  const act=await exec('systemd-run',['--user','--quiet',`--unit=${active}`,'--on-active=3600','/bin/true']);
  ok(act.code===0,'row m monotonic timer did not start');
  const list=await scOk(['list-units','--no-legend','--plain','--no-pager','--type=timer','--state=active'],'row m timer list');
  const rows=list.stdout.split('\n').map(line=>line.trim().split(/\s+/));
  for(const name of [`${calendar}.timer`,`${active}.timer`]){
    const row=rows.find(tokens=>tokens[0]===name);
    ok(row&&row[1]==='loaded'&&row[2]==='active','row m timer list form');
  }
  const props=['Id','ActiveState','NextElapseUSecRealtime','NextElapseUSecMonotonic','Unit'];
  const elapse=async name=>{
    const lines=await showLines(name,props);
    for(const key of props)eq(lines.filter(([prop])=>prop===key).length,1,`row m ${key} printed once`);
    const map=toMap(lines);
    return {realtime:classifyElapse(map.NextElapseUSecRealtime),monotonic:classifyElapse(map.NextElapseUSecMonotonic)};
  };
  const unset=['EMPTY','NA','ZERO'];
  const calendarForms=await elapse(`${calendar}.timer`);
  eq(calendarForms.realtime,'SET','row m calendar timer realtime');
  ok(unset.includes(calendarForms.monotonic),'row m calendar timer monotonic unset');
  const activeForms=await elapse(`${active}.timer`);
  eq(activeForms.monotonic,'SET','row m monotonic timer monotonic');
  ok(unset.includes(activeForms.realtime),'row m monotonic timer realtime unset beside a set monotonic');
}
async function rowN(){
  await requireLoaded(S.ctl,S.probe);
  // C4 baseline: CF absent (removed when the probe made it), one reload, then read.
  dropLink();
  const cf=lstatOrNull(S.CF);
  if(cf&&S.cfMade){fs.rmdirSync(S.CF);S.cfMade=false;S.made.dirs=S.made.dirs.filter(entry=>entry!==S.CF);}
  const cfGone=lstatOrNull(S.CF)===null;
  await reload();
  S.rowN.B=await ndr(S.ctl);
  if(cfGone){
    ensureCF();
    S.rowN.M=await ndr(S.ctl);
    makeLink();
    S.rowN.S=await ndr(S.ctl);
    fs.unlinkSync(S.LNK);
    S.rowN.U=await ndr(S.ctl);
  }
}

// Row l: a guarded record row. It never fails the test or the job (C1); its outcome goes only to ROW_L.
async function rowL(){
  const bulk=[];
  let stage='L_SETUP';
  const monitorArgs=(json)=>['--user','--match=type=signal,interface=org.freedesktop.systemd1.Manager,member=Reloading',...(json?['--json=short']:[]),'monitor'];
  try{
    await requireLoaded(S.probe);
    const help=await exec('busctl',['--help']);
    if(help.spawnError)return {outcome:'INCONCLUSIVE',attempts:0,form:'nobusctl',stage:'L_NO_BUSCTL',obs:'SPAWN_ERR'};
    const json=help.stdout.includes('--json=');
    const stdbuf=(await exec('stdbuf',['--version'])).code===0;
    for(let i=0;i<200;i++)bulk.push(writeUnit(`j1r-bulk-${S.suffix}-${String(i).padStart(3,'0')}.service`,unitText(['[Unit]','Description=probe','',...oneshot])));
    ensureCF();
    let attempts=0,last='none',lastObs='NO_TRUE_8S';
    stage='L_MONITOR';
    while(attempts<5){
      attempts++;
      dropLink();
      await requireLoaded(S.probe);
      makeLink();                                   // the post-reload state is LoadState=masked
      const events=[];
      let pending=false,buffer='';
      const feed=line=>{
        const at=Number(process.hrtime.bigint());
        if(line.startsWith('{')){
          try{
            const parsed=JSON.parse(line);
            if(parsed.member==='Reloading'&&parsed.payload&&Array.isArray(parsed.payload.data)&&typeof parsed.payload.data[0]==='boolean')events.push({v:parsed.payload.data[0],t:at});
          }catch{/* not a message line */}
          return;
        }
        if(/Member=Reloading\b/.test(line)){pending=true;return;}
        const match=/BOOLEAN (true|false);/.exec(line);
        if(pending&&match){pending=false;events.push({v:match[1]==='true',t:at});}
      };
      const file=stdbuf?'stdbuf':'busctl';
      const args=stdbuf?['-oL','busctl',...monitorArgs(json)]:monitorArgs(json);
      const monitor=spawn(file,args,{env:CHILD_ENV,stdio:['ignore','pipe','ignore']});
      let client=null;
      monitor.on('error',()=>{});
      monitor.stdout.on('data',data=>{
        buffer+=data.toString('utf8');
        for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){feed(buffer.slice(0,at));buffer=buffer.slice(at+1);}
      });
      try{
        await sleep(800);
        client=spawn('systemctl',['--user','daemon-reload'],{env:CHILD_ENV,stdio:'ignore'});
        client.on('error',()=>{});
        await waitUntil(()=>events.some(event=>event.v===true)||client.exitCode!==null||client.signalCode!==null,8000,5);
        const sawTrue=events.some(event=>event.v===true);
        const alive=client.exitCode===null&&client.signalCode===null;
        if(!(sawTrue&&alive)){
          const dead=monitor.exitCode!==null||monitor.signalCode!==null;
          lastObs=dead?'MONITOR_DEAD':sawTrue?'TRUE_EXITED':alive?'NO_TRUE_8S':'NO_TRUE_EXITED';
          last='none';await new Promise(resolve=>{if(client.exitCode!==null||client.signalCode!==null)resolve();else client.on('exit',resolve);});continue;}
        const tKill=Number(process.hrtime.bigint());
        client.kill('SIGKILL');
        const answer=await showMap(S.probe,['LoadState']);
        const tShow=Number(process.hrtime.bigint());
        await sleep(400);
        const tTrue=events.find(event=>event.v===true).t;
        const falseEvent=events.find(event=>event.v===false&&event.t>tTrue);
        const tFalse=falseEvent?falseEvent.t:null;
        const tags=[['RT',tTrue],['K',tKill],['RF',tFalse],['S',tShow]].filter(([,at])=>at!==null).sort((x,y)=>x[1]-y[1]).map(([tag])=>tag);
        const form=tags.join('<');
        const orderOk=tFalse!==null&&tTrue<tKill&&tKill<tFalse&&tFalse<=tShow&&answer.LoadState==='masked';
        return orderOk?{outcome:'PASS',attempts,form}:{outcome:'FAIL',attempts,form,stage:'L_ORDER',obs:'ORDER_BAD'};
      }finally{
        if(client&&client.exitCode===null&&client.signalCode===null)client.kill('SIGKILL');
        if(monitor.exitCode===null&&monitor.signalCode===null){
          monitor.kill('SIGTERM');
          await waitUntil(()=>monitor.exitCode!==null||monitor.signalCode!==null,2000,20);
          if(monitor.exitCode===null&&monitor.signalCode===null)monitor.kill('SIGKILL');
        }
        dropLink();
        await sc(['daemon-reload']);
      }
    }
    return {outcome:'INCONCLUSIVE',attempts,form:last,stage:'L_MONITOR',obs:lastObs};
  }catch(failure){
    return {outcome:failure instanceof ProbeFail?'FAIL':'INCONCLUSIVE',attempts:0,form:failure instanceof ProbeFail?'check':'error',stage,obs:classify(failure)};
  }finally{
    try{
      for(const file of bulk){removeMadeFile(file);S.made.files=S.made.files.filter(entry=>entry!==file);}
      dropLink();
      await sc(['daemon-reload']);
    }catch{/* cleanup at the end of the test retries every registered path */}
  }
}

// The row-l guard wrapper (C1, SB588 A13). It turns a throw, a rejection or a malformed result of the row into a record,
// so row l can never fail the node test or the job. The test runs guardSelfCheck first and fails unless the wrapper
// returns a record, without throwing, for a function that throws and for one that rejects.
const ROW_L_ERROR=Object.freeze({outcome:'INCONCLUSIVE',attempts:0,form:'error',stage:'L_MONITOR',obs:'ERROR'});
async function guardRowL(work){
  try{
    const record=await work();
    if(record&&typeof record==='object'&&typeof record.outcome==='string'&&typeof record.attempts==='number'&&typeof record.form==='string')return record;
    return {...ROW_L_ERROR,obs:'BAD_RECORD'};
  }catch{
    return {...ROW_L_ERROR};
  }
}
async function guardSelfCheck(){
  const cases=[
    ['THROW_ESCAPED',()=>{throw new Error('guard self-check throw');}],
    ['REJECT_ESCAPED',()=>Promise.reject(new Error('guard self-check reject'))],
  ];
  for(const [escaped,work] of cases){
    let record=null;
    try{record=await guardRowL(work);}catch{return escaped;}
    if(!record||record.outcome!=='INCONCLUSIVE'||record.form!=='error')return 'BAD_RECORD';
  }
  return 'OK';
}

const ROW_FUNCTIONS={f:rowF,a:rowA,b:rowB,c:rowC,d:rowD,e:rowE,g:rowG,h:rowH,i:rowI,j:rowJ,k:rowK,m:rowM,n:rowN};
async function runRow(letter){
  at('ROW');
  try{
    const outcome=await ROW_FUNCTIONS[letter]();
    S.results[letter]=outcome&&outcome.r?outcome:{r:'PASS'};
    if(S.results[letter].r==='INCONCLUSIVE'&&letter!=='f'&&letter!=='h')S.results[letter]={r:'FAIL',note:'INCONCLUSIVE_NOT_ALLOWED',stage:'ROW',obs:'CHECK'};
  }catch(failure){
    S.results[letter]={r:'FAIL',note:String(failure&&failure.message||failure).slice(0,160),stage:STAGE,obs:classify(failure)};
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Generic Linux rows (tests 2, 8, 19 and 20 of the design). They need no user manager and no product code.
function groupState(pgid){
  try{process.kill(-pgid,0);return 'LIVE';}catch(failure){return failure.code==='ESRCH'?'NONE':failure.code==='EPERM'?'EPERM':'UNKNOWN';}
}
function pidState(pid){
  try{process.kill(pid,0);return 'LIVE';}catch(failure){return failure.code==='ESRCH'?'NONE':'UNKNOWN';}
}
function readFirstLine(stream,limitMs){
  return new Promise((resolve,reject)=>{
    let text='';
    const timer=setTimeout(()=>reject(new ProbeFail('no pid line','TIMEOUT')),limitMs);
    stream.on('data',data=>{
      text+=data.toString('utf8');
      const at=text.indexOf('\n');
      if(at>=0){clearTimeout(timer);resolve(text.slice(0,at).trim());}
    });
  });
}
const exited=child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.on('exit',()=>resolve());});
function tmpFolder(prefix){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  S.made.tmp.push(folder);
  return folder;
}
async function linuxPgkill(){
  const child=spawn('sh',['-c','sleep 300 & echo $!; wait'],{detached:true,stdio:['ignore','pipe','ignore']});
  const gone=exited(child);
  try{
    const grandchild=Number(await readFirstLine(child.stdout,5000));
    ok(Number.isInteger(grandchild)&&grandchild>1,'pgkill grandchild pid');
    eq(groupState(child.pid),'LIVE','pgkill group live');
    eq(pidState(grandchild),'LIVE','pgkill grandchild live');
    process.kill(-child.pid,'SIGKILL');
    await gone;
    ok(await waitUntil(()=>groupState(child.pid)==='NONE'&&pidState(grandchild)==='NONE',5000,50),'pgkill members still present');
    return 'GONE';
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}}
}
async function linuxPgexit0(){
  const child=spawn('sh',['-c','sleep 300 >/dev/null 2>&1 </dev/null & exit 0'],{detached:true,stdio:['ignore','ignore','ignore']});
  try{
    await exited(child);
    eq(child.exitCode,0,'pgexit0 exit code');
    eq(groupState(child.pid),'LIVE','pgexit0 group live after the leader exit');
    process.kill(-child.pid,'SIGKILL');
    ok(await waitUntil(()=>groupState(child.pid)==='NONE',5000,50),'pgexit0 group still present');
    return 'CODE0_LIVE_GONE';
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}}
}
async function linuxPgsig(){
  const child=spawn('sleep',['300'],{detached:true,stdio:'ignore'});
  const gone=exited(child);
  try{
    child.kill('SIGTERM');
    await gone;
    eq(child.signalCode,'SIGTERM','pgsig signal');
    return 'SIGTERM';
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}}
}
async function linuxPgnone(){
  const code=await new Promise(resolve=>{
    let child;
    try{child=spawn(`/nonexistent/j1r-probe-${S.suffix}`,[],{detached:true,stdio:'ignore'});}catch(failure){resolve(failure.code);return;}
    child.on('error',failure=>resolve(failure.code));
    child.on('exit',()=>resolve('EXIT'));
  });
  eq(code,'ENOENT','pgnone code');
  return 'ENOENT';
}
// Probe bug fixed on review (first CI run gave pgsetsid:FAIL): the escapee pid used to be `$!` of `setsid sleep 300 &`,
// which is the pid of the setsid command, not necessarily of the process that is left running. util-linux setsid forks
// and lets the parent exit at once when it is a process group leader, and then `$!` is a pid that is gone. Now the
// escapee prints its own pid (`echo $$` in the process that then execs sleep, so the pid stays the same) after it has
// been through setsid, whether setsid forks or not. A plain `sleep 300 &` stays in the leader group so the leader shell
// keeps waiting and the group is never empty when it is killed. The expected form ESCAPEE_ALIVE is unchanged.
const PGSETSID_SCRIPT="sleep 300 & setsid sh -c 'echo $$; exec sleep 300' & wait";
function sessionOf(pid,leader){
  try{
    const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');   // state ppid pgrp session ...
    const session=Number(fields[3]);
    return session===pid?'SESS_OWN':session===leader?'SESS_SAME':'SESS_OTHER';
  }catch{return 'SESS_NOPROC';}
}
async function linuxPgsetsid(){
  at('SPAWN');
  const child=spawn('sh',['-c',PGSETSID_SCRIPT],{detached:true,stdio:['ignore','pipe','ignore']});
  child.on('error',()=>{});
  const leader=child.pid;
  let escapee=0;
  try{
    ok(Number.isInteger(leader)&&leader>1,'pgsetsid spawn','SPAWN_ERR');
    at('PID_LINE');
    escapee=Number(await readFirstLine(child.stdout,5000));
    at('PID_VALID');
    ok(Number.isInteger(escapee)&&escapee>1&&escapee!==leader,'pgsetsid pid','CHECK');
    at('GROUP_LIVE');
    eqState(groupState(leader),'LIVE','pgsetsid leader group live before the kill');
    at('ESC_LIVE');
    eqState(pidState(escapee),'LIVE','pgsetsid escapee live before the kill');
    at('SESSION');
    const session=sessionOf(escapee,leader);
    ok(session!=='SESS_SAME','pgsetsid escapee is still in the leader session',session);
    at('GROUP_KILL');
    try{process.kill(-leader,'SIGKILL');}catch(failure){throw new ProbeFail(`pgsetsid group kill ${failure.code}`,failure.code==='ESRCH'?'NONE':failure.code==='EPERM'?'EPERM':'ERROR');}
    at('LEADER_EXIT');
    ok(await waitUntil(()=>child.exitCode!==null||child.signalCode!==null,5000,20),'pgsetsid leader still running after the kill','TIMEOUT');
    await sleep(300);
    at('ESC_AFTER');
    eqState(pidState(escapee),'LIVE','pgsetsid escapee survives the group kill');
    return 'ESCAPEE_ALIVE';
  }finally{
    try{process.kill(-leader,'SIGKILL');}catch{/* already gone */}
    if(escapee>1){try{process.kill(escapee,'SIGKILL');}catch{/* already gone */}}
  }
}
async function linuxStubpath(){
  const folder=tmpFolder('j1r-stub-');
  const stub=path.join(folder,'systemctl');
  fs.writeFileSync(stub,'#!/bin/sh\necho J1R_STUB_REACHED\n',{mode:0o755});
  const result=await exec('sh',['-c','systemctl --user show x'],{env:{PATH:`${folder}:/usr/bin:/bin`},detached:true});
  eq(result.code,0,'stubpath exit');
  ok(result.stdout.includes('J1R_STUB_REACHED'),'stubpath marker');
  return 'REACHED';
}
async function linuxEnvkeys(){
  const folder=tmpFolder('j1r-env-');
  const env={PATH:'/usr/bin:/bin',HOME:folder,LC_ALL:'C',TZ:'UTC',XDG_RUNTIME_DIR:`/run/user/${process.getuid()}`,
    DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${process.getuid()}/bus`,
    QUANT_RESEARCH_FOUNDATION_ENABLED:'1',QUANT_RECOVERY_POLICY_FILE:`${folder}/policy.json`,PG_POOL_SIZE:'3'};
  const listed=await exec('/usr/bin/env',[],{env,cwd:folder,detached:true});
  eq(listed.code,0,'envkeys exit');
  const seen={};
  for(const line of listed.stdout.split('\n').filter(Boolean)){const at=line.indexOf('=');seen[line.slice(0,at)]=line.slice(at+1);}
  eq(JSON.stringify(Object.keys(seen).sort()),JSON.stringify(Object.keys(env).sort()),'envkeys key set');
  for(const key of Object.keys(env))eq(seen[key],env[key],`envkeys value ${key}`);
  const where=await exec('/bin/pwd',['-P'],{env,cwd:folder,detached:true});
  eq(where.stdout.trim(),fs.realpathSync(folder),'envkeys cwd');
  return 'EXACT';
}
async function linuxSymlinkexist(){
  const folder=tmpFolder('j1r-fs-');
  const link=path.join(folder,'link');
  fs.symlinkSync('/dev/null',link);
  const before=fs.lstatSync(link,{bigint:true});
  let code=null;
  try{fs.symlinkSync('/dev/null',link);}catch(failure){code=failure.code;}
  eq(code,'EEXIST','symlinkexist code');
  const after=fs.lstatSync(link,{bigint:true});
  ok(before.ino===after.ino&&before.dev===after.dev&&fs.readlinkSync(link)==='/dev/null','symlinkexist entry changed');
  const plain=path.join(folder,'plain');
  fs.writeFileSync(plain,'x');
  code=null;
  try{fs.symlinkSync('/dev/null',plain);}catch(failure){code=failure.code;}
  eq(code,'EEXIST','symlinkexist code on a regular file');
  eq(fs.readFileSync(plain,'utf8'),'x','symlinkexist regular file changed');
  return 'EEXIST_KEPT';
}
async function linuxReadlink(){
  const folder=tmpFolder('j1r-fs-');
  const link=path.join(folder,'link');
  fs.symlinkSync('/dev/null',link);
  eq(fs.readlinkSync(link),'/dev/null','readlink value');
  return 'DEVNULL';
}
async function linuxLstatbig(){
  const folder=tmpFolder('j1r-fs-');
  const link=path.join(folder,'link');
  fs.symlinkSync('/dev/null',link);
  const first=fs.lstatSync(link,{bigint:true});
  const second=fs.lstatSync(link,{bigint:true});
  ok(typeof first.ino==='bigint'&&typeof first.dev==='bigint','lstatbig bigint');
  ok(first.isSymbolicLink(),'lstatbig link');
  eq(Number(first.uid),process.getuid(),'lstatbig uid');
  ok(first.ino===second.ino&&first.dev===second.dev,'lstatbig stable identity');
  fs.unlinkSync(link);
  // An inode number may be reused at once. Hold the freed number with throwaway entries, then re-create the link.
  const held=[];
  for(let i=0;i<64;i++){
    const blocker=path.join(folder,`blocker-${i}`);
    fs.symlinkSync('/dev/null',blocker);
    held.push(blocker);
    if(fs.lstatSync(blocker,{bigint:true}).ino===first.ino)break;
  }
  fs.symlinkSync('/dev/null',link);
  const third=fs.lstatSync(link,{bigint:true});
  ok(third.ino!==first.ino||third.dev!==first.dev,'lstatbig new identity after re-create');
  return 'UID_STABLE_NEWINO';
}
async function linuxUnlinklink(){
  const folder=tmpFolder('j1r-fs-');
  const real=path.join(folder,'real.txt'),link=path.join(folder,'link');
  fs.writeFileSync(real,'keep');
  fs.symlinkSync(real,link);
  fs.unlinkSync(link);
  eq(lstatOrNull(link),null,'unlinklink link gone');
  eq(fs.readFileSync(real,'utf8'),'keep','unlinklink target changed');
  return 'TARGET_KEPT';
}
async function linuxMkdirerr(){
  const folder=tmpFolder('j1r-fs-');
  let code=null;
  try{fs.mkdirSync(path.join(folder,'missing','child'));}catch(failure){code=failure.code;}
  eq(code,'ENOENT','mkdirerr missing parent');
  code=null;
  try{fs.mkdirSync(folder);}catch(failure){code=failure.code;}
  eq(code,'EEXIST','mkdirerr existing folder');
  return 'ENOENT_EEXIST';
}
async function linuxNofollow(){
  const folder=tmpFolder('j1r-fs-');
  const target=path.join(folder,'target.txt'),link=path.join(folder,'link');
  fs.writeFileSync(target,'secret');
  fs.symlinkSync(target,link);
  let code=null,fd=null;
  try{fd=fs.openSync(link,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(failure){code=failure.code;}
  if(fd!==null)fs.closeSync(fd);
  eq(code,'ELOOP','nofollow code');
  return 'ELOOP';
}
async function linuxFifo(){
  const folder=tmpFolder('j1r-fs-');
  const fifo=path.join(folder,'fifo');
  const made=await exec('mkfifo',[fifo]);
  eq(made.code,0,'fifo mkfifo');
  const fd=fs.openSync(fifo,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);
  try{ok(fs.fstatSync(fd).isFIFO(),'fifo fstat');}finally{fs.closeSync(fd);}
  return 'NONBLOCK_FIFO';
}
async function linuxInodecmp(){
  const folder=tmpFolder('j1r-fs-');
  const file=path.join(folder,'file'),other=path.join(folder,'other');
  fs.writeFileSync(file,'one');
  const named=fs.lstatSync(file,{bigint:true});
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let opened;
  try{opened=fs.fstatSync(fd,{bigint:true});}finally{fs.closeSync(fd);}
  ok(named.ino===opened.ino&&named.dev===opened.dev,'inodecmp lstat then open differ');
  fs.writeFileSync(other,'two');
  fs.renameSync(other,file);
  const swapped=fs.lstatSync(file,{bigint:true});
  ok(swapped.ino!==named.ino||swapped.dev!==named.dev,'inodecmp swapped path keeps the identity');
  return 'SAME_THEN_SWAPPED';
}
async function linuxSizecap(){
  const folder=tmpFolder('j1r-fs-');
  const file=path.join(folder,'big');
  fs.writeFileSync(file,Buffer.alloc(5000,0x61));
  ok(fs.lstatSync(file,{bigint:true}).size>4096n,'sizecap size above the cap');
  return 'SIZE_FIRST';
}
function snapshotRoot(root){
  const rows=[];
  const walk=(folder,prefix)=>{
    for(const name of fs.readdirSync(folder).sort()){
      const full=path.join(folder,name);
      const st=fs.lstatSync(full,{bigint:true});
      const type=st.isSymbolicLink()?'L':st.isDirectory()?'D':'F';
      const body=type==='L'?fs.readlinkSync(full):type==='F'?crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'):'';
      rows.push(`${prefix}${name}|${type}|${st.size}|${st.mtimeNs}|${st.ino}|${body}`);
      if(type==='D')walk(full,`${prefix}${name}/`);
    }
  };
  walk(root,'');
  const top=fs.lstatSync(root,{bigint:true});
  rows.push(`.|D|${top.mtimeNs}|${top.ino}`);
  return rows.join('\n');
}
async function linuxReaddir(){
  const root=tmpFolder('j1r-root-');
  fs.writeFileSync(path.join(root,'a.json'),'{"a":1}\n');
  fs.writeFileSync(path.join(root,'b.json'),'');
  fs.mkdirSync(path.join(root,'sub'));
  fs.writeFileSync(path.join(root,'sub','c'),'c');
  fs.symlinkSync('/dev/null',path.join(root,'link'));
  const before=snapshotRoot(root);
  fs.readdirSync(root);
  fs.readdirSync(root,{withFileTypes:true});
  fs.readdirSync(path.join(root,'sub'));
  const after=snapshotRoot(root);
  eq(after,before,'readdir changed the fixture root');
  return 'IDENTICAL';
}
const ZPIPE_READER="const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const b=Buffer.concat(c);"+
  "const h=require('node:crypto').createHash('sha256').update(b.subarray(0,b.length-1)).digest('hex');"+
  "process.stdout.write(JSON.stringify({len:b.length,sha:h,tail:b.subarray(b.length-4).toString('hex')}));});";
async function linuxZpipe(){
  const folder=tmpFolder('j1r-zpipe-');
  // 400000 ASCII bytes: 5000 lines of 79 random base64 characters, then two more newlines (three trailing newlines).
  const chars=crypto.randomBytes(296250).toString('base64');
  let text='';
  for(let i=0;i<5000;i++)text+=`${chars.slice(i*79,i*79+79)}\n`;
  text+='\n\n';
  const expected=crypto.createHash('sha256').update(text).digest('hex');
  const gz=await exec('gzip',['-9','-c'],{input:text});
  eq(gz.code,0,'zpipe gzip');
  const payload=gz.stdoutBuf.toString('base64').replace(/.{76}(?=.)/g,'$&\n');
  const reader=path.join(folder,'reader.cjs'),script=path.join(folder,'run.sh');
  fs.writeFileSync(reader,ZPIPE_READER);
  fs.writeFileSync(script,[
    't=$(base64 -d <<\'J1RZEOF\' | gzip -dc',payload,'J1RZEOF','printf x)',
    't=${t%x}',
    'h=$(printf \'%s\' "$t" | sha256sum)',
    'h=${h%% *}',
    'if [ "$h" != "$J1R_EXPECT" ]; then echo SHA_MISMATCH; exit 3; fi',
    '"$J1R_NODE" "$J1R_READER" <<<"$t"',''].join('\n'));
  const run=await exec('bash',[script],{env:{PATH:'/usr/bin:/bin',J1R_EXPECT:expected,J1R_NODE:process.execPath,J1R_READER:reader},timeoutMs:60000});
  eq(run.code,0,'zpipe bash exit');
  const seen=JSON.parse(run.stdout);
  eq(seen.len,text.length+1,'zpipe length (text plus the one newline a here-string adds)');
  eq(seen.sha,expected,'zpipe sha256');
  eq(seen.tail,'0a0a0a0a','zpipe trailing newlines');
  return 'SHA_OK_NL3';
}
// zbad (SB589 ruling 5): the script construct of payloadScriptZ (tool/r3-pack.mjs, the r13h block), line for line, with a
// stub in place of node. The stub writes a marker file inside the probe's own temp folder only if it starts, then keeps
// its stdin. The unchanged script must run the stub with the exact text; a corrupted base64 line, a changed hash and
// three truncations must each end with exit 86 and PAYLOAD_INTEGRITY on stderr, and the stub must never start.
const ZBAD_DELIM='S6_STAGING_R3_JS';
function zbadLines(stub,b64Lines,hash){
  return [
    "trap 'echo PAYLOAD_INTEGRITY >&2; exit 86' EXIT",
    'export XDG_RUNTIME_DIR=/run/user/$(id -u)',
    'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus',
    '{',
    `Z=$(set -o pipefail; base64 -d <<'${ZBAD_DELIM}' 2>/dev/null | gzip -dc 2>/dev/null && printf x`,
    ...b64Lines,
    ZBAD_DELIM,
    ') || exit 86',
    'Z=${Z%x}',
    `[ "$(printf %s "$Z" | sha256sum | cut -d' ' -f1)" = "${hash}" ] || exit 86`,
    "Z=${Z%$'\\n'}",
    'trap - EXIT',
    `exec env -i PATH="$PATH" HOME="$HOME" LC_ALL=C TZ=UTC XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" ${stub} --input-type=module 3<&0 <<<"$Z"`,
    '}',
  ];
}
const codeObs=result=>result.signal?'SIGNAL':result.code===0?'CODE_0':result.code===1?'CODE_1':result.code===2?'CODE_2':result.code===86?'CODE_86':'CODE_OTHER';
async function linuxZbad(){
  const folder=tmpFolder('j1r-zbad-');
  const stub=path.join(folder,'node'),marker=path.join(folder,'started'),got=path.join(folder,'got');
  fs.writeFileSync(stub,`#!/bin/sh\nprintf started > "${marker}"\ncat > "${got}"\n`,{mode:0o755});
  // The node input: one first line, 76 lines of random base64 text and a final empty line, so the text ends with two line feeds.
  const chars=crypto.randomBytes(4500).toString('base64');
  let text='globalThis.S6_R3_BOUND={"probe":true};\n';
  for(let i=0;i<chars.length;i+=79)text+=`${chars.slice(i,i+79)}\n`;
  text+='\n';
  const hash=crypto.createHash('sha256').update(text).digest('hex');
  const gz=await exec('gzip',['-9','-c'],{input:text});
  eq(gz.code,0,'zbad gzip');
  const b64=gz.stdoutBuf.toString('base64');
  const lines=[];
  for(let i=0;i<b64.length;i+=76)lines.push(b64.slice(i,i+76));
  ok(lines.length>=8,'zbad payload line count');
  const mid=lines.length>>1;
  const build=(payload,expect)=>`${zbadLines(stub,payload,expect).join('\n')}\n`;
  const full=build(lines,hash);
  const runIt=async script=>{
    for(const file of [marker,got]){try{fs.unlinkSync(file);}catch(failure){if(failure.code!=='ENOENT')throw failure;}}
    return exec('bash',['-s'],{env:{PATH:'/usr/bin:/bin',HOME:folder},input:script,timeoutMs:60000});
  };
  at('Z_CONTROL');
  const control=await runIt(full);
  if(control.timedOut)throw new ProbeFail('zbad control timeout','TIMEOUT');
  if(control.code!==0)throw new ProbeFail(`zbad control exit ${control.code}`,codeObs(control));
  if(lstatOrNull(marker)===null)throw new ProbeFail('zbad control stub did not start','STUB_SILENT');
  if(fs.readFileSync(got,'utf8')!==text)throw new ProbeFail('zbad control stub input differs','GOT_DIFF');
  const invalid=lines.slice();
  invalid[mid]=`${lines[mid].slice(0,10)}!${lines[mid].slice(11)}`;
  const flipped=lines.slice();
  flipped[mid]=`${lines[mid].slice(0,20)}${lines[mid][20]==='A'?'B':'A'}${lines[mid].slice(21)}`;
  const otherHash=`${hash[0]==='0'?'1':'0'}${hash.slice(1)}`;
  const braceAt=full.indexOf('{\n'),payloadAt=full.indexOf(lines[mid]),execAt=full.indexOf('exec env');
  ok(braceAt>0&&payloadAt>braceAt&&execAt>payloadAt,'zbad cut points');
  const cases=[
    ['Z_B64_BAD',build(invalid,hash)],
    ['Z_B64_FLIP',build(flipped,hash)],
    ['Z_HASH',build(lines,otherHash)],
    ['Z_CUT_HEAD',full.slice(0,braceAt+2)],                // after the opening brace line
    ['Z_CUT_PAYLOAD',full.slice(0,payloadAt+30)],          // inside the base64 lines
    ['Z_CUT_EXEC',full.slice(0,execAt+40)],                // inside the exec line
  ];
  for(const [stage,script] of cases){
    at(stage);
    const result=await runIt(script);
    if(result.timedOut)throw new ProbeFail(`zbad ${stage} timeout`,'TIMEOUT');
    if(lstatOrNull(marker)!==null)throw new ProbeFail(`zbad ${stage} stub started`,'STUB_RAN');
    if(result.code!==86)throw new ProbeFail(`zbad ${stage} exit ${result.code}`,codeObs(result));
    if(!result.stderr.includes('PAYLOAD_INTEGRITY'))throw new ProbeFail(`zbad ${stage} no label`,'NO_LABEL');
  }
  return 'EXIT86_NONODE';
}
const LINUX_FUNCTIONS={pgkill:linuxPgkill,pgexit0:linuxPgexit0,pgsig:linuxPgsig,pgnone:linuxPgnone,pgsetsid:linuxPgsetsid,
  stubpath:linuxStubpath,envkeys:linuxEnvkeys,symlinkexist:linuxSymlinkexist,readlink:linuxReadlink,lstatbig:linuxLstatbig,
  unlinklink:linuxUnlinklink,mkdirerr:linuxMkdirerr,nofollow:linuxNofollow,fifo:linuxFifo,inodecmp:linuxInodecmp,
  sizecap:linuxSizecap,readdir:linuxReaddir,zpipe:linuxZpipe,zbad:linuxZbad};
async function runLinuxRows(){
  for(const [id,form] of LINUX_ROW_FORMS){
    at('ROW');
    try{
      const got=await LINUX_FUNCTIONS[id]();
      S.linux[id]=got===form?form:'FAIL';
      if(got!==form)S.linuxDiag[id]={stage:'ROW',obs:'CHECK'};
    }catch(failure){
      S.linux[id]='FAIL';
      S.linuxDiag[id]={stage:STAGE,obs:classify(failure)};
      S.notes.push(`linux ${id}: ${String(failure&&failure.message||failure).slice(0,120)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup: stop the holder, remove every file and folder the probe made, reload. Runs in finally blocks.
async function cleanup(){
  const attempt=async work=>{try{await work();}catch(failure){S.cleanupFailed.push(String(failure&&failure.message||failure).slice(0,100));}};
  await attempt(async()=>{
    for(const name of S.urtLinks){await sc(['unmask','--runtime',name]);}
  });
  await attempt(async()=>{
    for(const name of S.transient){await sc(['stop',name],{timeoutMs:15000});}
    for(const name of S.transient.filter(entry=>entry.endsWith('.service'))){await sc(['kill','--kill-whom=all','--signal=KILL',name]);}
  });
  await attempt(async()=>{
    for(const name of S.urtLinks){
      const link=`${S.urt}/${name}`;
      const st=lstatOrNull(link);
      if(st&&st.isSymbolicLink())fs.unlinkSync(link);
    }
    const probeLink=`${S.urt}/${S.probe}`;
    const st=lstatOrNull(probeLink);
    if(st&&st.isSymbolicLink())fs.unlinkSync(probeLink);
  });
  await attempt(async()=>{await sc(['stop',S.hold]);});
  await attempt(async()=>{dropLink();});
  for(const file of [...S.made.files].reverse())await attempt(async()=>{removeMadeFile(file);});
  for(const folder of [...S.made.dirs].reverse()){
    await attempt(async()=>{
      try{fs.rmdirSync(folder);}catch(failure){if(failure.code!=='ENOENT')throw failure;}
    });
  }
  for(const folder of S.made.tmp)await attempt(async()=>{fs.rmSync(folder,{recursive:true,force:true});});
  await attempt(async()=>{await sc(['daemon-reload']);});
  for(const entry of [...S.made.files,...S.made.dirs,...S.made.tmp]){
    await attempt(async()=>{if(lstatOrNull(entry)!==null)throw new Error('LEFTOVER');});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Summary.
function noticeLine(key,value,cap){
  let text=sanitize(value);
  if(text==='')text='none';
  text=text.slice(0,cap);
  if(!TOKEN.test(text)||text.length>cap)throw new ProbeFail(`bad notice ${key}`);
  return `${key}=${text}\n`;
}
function gatingResult(letter){return S.results[letter]||{r:'FAIL',note:'NOTRUN',stage:'NOTRUN',obs:'NOT_RUN'};}
// C15: the DIAG value. Tokens are <row>:<stage>:<observed>, each part from the closed lists; a part that is not in its
// list is printed as UNKNOWN_STAGE or UNKNOWN_OBS. Whole tokens only: a token that would pass the cap ends the list.
function diagText(){
  const tokens=[];
  const add=(row,stage,observed)=>{
    if(!DIAG_ROWS.includes(row))return;
    tokens.push(`${row}:${DIAG_STAGES.includes(stage)?stage:'UNKNOWN_STAGE'}:${DIAG_OBSERVED.includes(observed)?observed:'UNKNOWN_OBS'}`);
  };
  if(S.fatalDiag)add('setup',S.fatalDiag.stage,S.fatalDiag.obs);
  if(S.guard!=='OK')add('l','GUARD_SELF',S.guard);
  for(const letter of GATING){
    if(letter==='h')add('h','U8',S.u8);
    const outcome=gatingResult(letter);
    if(outcome.r!=='PASS')add(letter,outcome.stage||'ROW',outcome.obs||'CHECK');
  }
  if(S.rowL.outcome!=='PASS')add('l',S.rowL.stage||'L_MONITOR',S.rowL.obs||'ERROR');
  for(const [id,form] of LINUX_ROW_FORMS){
    const got=S.linux[id];
    if(got===form)continue;
    const found=S.linuxDiag[id];
    if(got===undefined)add(id,'NOTRUN','NOT_RUN');
    else add(id,found?found.stage:'ROW',found?found.obs:'CHECK');
  }
  const cap=Object.fromEntries(NOTICE_KEYS).DIAG;
  let text='';
  for(const token of tokens){
    const next=text===''?token:`${text},${token}`;
    if(next.length>cap)break;
    text=next;
  }
  return text;
}
function summaryText(){
  const passed=GATING.filter(letter=>gatingResult(letter).r==='PASS').length;
  const inconclusive=GATING.filter(letter=>gatingResult(letter).r==='INCONCLUSIVE').length;
  const failed=GATING.filter(letter=>gatingResult(letter).r==='FAIL').join('')||'-';
  const unitPath=S.unitPathStart.map(entry=>{
    if(entry===S.xdg||entry.startsWith(`${S.xdg}/`))return `<R>${entry.slice(S.xdg.length)}`;
    if(entry===S.home||entry.startsWith(`${S.home}/`))return `<H>${entry.slice(S.home.length)}`;
    return entry;
  }).join(',');
  const linuxRows=LINUX_ROW_FORMS.map(([id])=>`${id}:${S.linux[id]||'NOTRUN'}`).join(',');
  const lines=[
    ['MAJORS',`m${S.mgrMajor},c${S.clientMajor}`],
    ['ROWS',`${passed}/${GATING_TOTAL},INC${inconclusive},FAIL${failed}`],
    ['ROW_L',`${S.rowL.outcome},att${S.rowL.attempts},${S.rowL.form}`],
    ['ROW_N',`B:${S.rowN.B},M:${S.rowN.M},S:${S.rowN.S},U:${S.rowN.U}`],
    ['UNITPATH',unitPath],
    ['FORMS',`ver:${S.forms.ver},frag:${S.forms.frag},empty:${S.forms.empty},k:${S.forms.k}`],
    ['LINUX_ROWS',linuxRows],
    ['DIAG',diagText()],
  ];
  const caps=Object.fromEntries(NOTICE_KEYS);
  return lines.map(([key,value])=>noticeLine(key,value,caps[key])).join('');
}
function writeSummary(){
  const folder=process.env.RUNNER_TEMP||os.tmpdir();
  fs.writeFileSync(path.join(folder,'systemd-probe.txt'),summaryText());
}

// ---------------------------------------------------------------------------------------------------------------
test('systemd user manager probe (SYSTEMD_PROBE=1 only)',{skip:ENABLED?false:'SYSTEMD_PROBE is not 1',timeout:600000},async t=>{
  if(process.platform!=='linux')throw new ProbeFail('SYSTEMD_PROBE=1 needs Linux and a systemd user manager');
  S=newState();
  CHILD_ENV={...process.env,XDG_RUNTIME_DIR:S.xdg,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS||`unix:path=${S.xdg}/bus`,
    LC_ALL:'C',SYSTEMD_COLORS:'0'};
  let fatal=null;
  try{
    await runLinuxRows();
    await setup();
    for(const letter of ROW_ORDER){
      if(letter==='l'){
        S.guard=await guardSelfCheck();             // SB588 A13: the wrapper must hold before row l runs
        await t.test('row l (record only, never gates)',async()=>{
          S.rowL=await guardRowL(rowL);
        });
      }else await runRow(letter);
    }
  }catch(failure){
    fatal=failure;
    S.fatalDiag={stage:STAGE,obs:classify(failure)};
  }finally{
    await cleanup();
    try{writeSummary();}catch(failure){fatal=fatal||failure;}
  }
  for(const [letter,outcome] of Object.entries(S.results))console.log(`row ${letter}: ${outcome.r}${outcome.note?` (${outcome.note})`:''}`);
  console.log(`row l: ${S.rowL.outcome} (record only)`);
  console.log(`row l guard self-check: ${S.guard}`);
  console.log(`row h U8: ${S.u8}`);
  for(const note of S.notes)console.log(`note ${note}`);
  const problems=[];
  if(fatal)problems.push(`setup or summary: ${String(fatal.message||fatal).slice(0,160)}`);
  if(S.guard!=='OK')problems.push(`row l guard self-check ${S.guard}`);
  for(const letter of GATING){
    const outcome=gatingResult(letter);
    if(outcome.r!=='PASS')problems.push(`row ${letter} ${outcome.r}${outcome.note?` ${outcome.note}`:''}`);
  }
  for(const [id,form] of LINUX_ROW_FORMS)if(S.linux[id]!==form)problems.push(`linux row ${id}`);
  if(S.cleanupFailed.length)problems.push(`cleanup: ${S.cleanupFailed.join('; ')}`);
  if(problems.length)throw new ProbeFail(problems.join(' | '));
});
