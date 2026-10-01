import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readFileSync,constants as fsConstants} from 'node:fs';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {validateFoundationRequestV2} from '../src/quant-research/foundation-contract-v2.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {validateDiagnosticRequest,assertDiagnosticEnvironment,parseDiagnosticArguments,readPrivateRequest,
  enqueueQuantProfileDiagnostic,diagnosticReport,runQuantProfileDiagnostic,installCrashReporter,
  DIAGNOSTIC_PLAN_VERSION}
  from '../scripts/enqueue-quant-profile-diagnostic.mjs';

const sha=letter=>letter.repeat(64);
const request={owner_id:'owner-a',bot_id:'bot-a',raw_job_id:'11111111-1111-4111-8111-111111111111',
  deployment_id:'deployment-123',idempotency_key:'diagnostic-key-0001'};
const environment={PINE_BRIDGE_ENV:'staging',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1',QUANT_RESEARCH_ENABLED:'1',
  QUANT_RESEARCH_FOUNDATION_ENABLED:'1',QUANT_PROFILE_V2_ENABLED:'1',QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'0',
  QUANT_PREFLIGHT_ENABLED:'0',DATABASE_URL:'postgres://robot:hunter2@db.internal.example:5432/robot',
  QUANT_CAPACITY_POLICY_FILE:'/etc/robot/private/capacity-policy.json',
  QUANT_STORAGE_LIMITS_FILE:'/etc/robot/private/storage.json',QUANT_RESEARCH_DATASET_ROOT:'/var/lib/robot/quant'};
const code=expected=>error=>error.code===expected;

/** Valid staging policy plus synthetic raw and deployment records that the helper turns into a contract. */
function world({count=600,maxRuntimeMs}={}){
  const {policy,contract}=profileV2Fixture(count);
  policy.environment='staging';
  policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
  if(maxRuntimeMs!==undefined)policy.budget.max_runtime_ms=maxRuntimeMs;
  const raw={result:{dataset:contract.dataset,provenance:{pages:[{page:0,sha256:sha('9')}]}}};
  const deployment={deployment:{deployment_id:request.deployment_id,snapshot_hash:sha('4'),
      snapshot:{market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'}}},
    evidence:{execution_model:contract.profile.execution_model},
    source:{source_hash:sha('a'),analysis:{effective_inputs_hash:sha('b')}}};
  return {policy,raw,deployment,model:contract.profile.execution_model};
}

// A fault as the PostgreSQL driver raises it: the server sends a severity and a SQLSTATE code with the message.
const serverFault=(code,severity='ERROR')=>
  Object.assign(Error('postgres://robot:hunter2@db.internal.example:5432/robot'),{code,severity});
// Name of each statement, so a test can state the order of the helper's work in one list.
const stepOf=text=>/to_regclass/.test(text)?'tables':text.startsWith('SET LOCAL lock_timeout')?'lock_timeout':
  text.startsWith('LOCK TABLE')?'lock':text.endsWith('FOR UPDATE')?'row_lock':text.includes('idempotency_key=$2')?'idempotency':
  text.includes('bot_active')?'gate':text.startsWith('INSERT INTO quant_foundation_owners')?'owner_insert':
  text.startsWith('INSERT INTO quant_foundation_jobs')?'job_insert':text;

/** Recording database. It answers only the statements the helper is allowed to run and rejects anything else.
 * timeline lists every statement and every service call in the order they happened.
 */
function fakeDb({previous=[],gate={},tables={},scheduler=1,tamper=null,failOn=null,faultCode='57P01'}={}){
  const events=[],statements=[],timeline=[];
  const db={events,statements,timeline,isTransaction:false,
    async query(sql,params=[]){
      const text=sql.replace(/\s+/g,' ').trim();
      statements.push({sql:text,params});timeline.push(stepOf(text));
      if(failOn&&failOn.test(text))throw serverFault(faultCode);
      if(/to_regclass/.test(text))return {rows:[{scheduler:'s',jobs:'j',ledgers:'l',launches:'x',...tables}]};
      if(text==="SET LOCAL lock_timeout='1000ms'")return {rows:[],rowCount:0};
      if(text.startsWith('LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE'))return {rows:[],rowCount:0};
      if(text==='SELECT singleton FROM quant_foundation_scheduler FOR UPDATE')return {rows:scheduler?[{singleton:true}]:[],rowCount:scheduler};
      if(text.startsWith('SELECT * FROM quant_foundation_jobs WHERE owner_id=$1 AND idempotency_key=$2'))return {rows:previous};
      if(text.includes('bot_active'))return {rows:gate===null?[]:[{bot_active:0,executing:0,waiting:0,launches:false,invalid:false,operations:false,...gate}]};
      if(text.startsWith('INSERT INTO quant_foundation_owners'))return {rows:[],rowCount:1};
      if(text.startsWith('INSERT INTO quant_foundation_jobs')){
        const row={job_id:params[0],owner_id:params[1],idempotency_key:params[2],contract:JSON.parse(params[3]),
          contract_hash:params[4],status:'QUEUED',created_at:params[5],deadline_at:params[6],attempts:0,result:null,checkpoint:null};
        if(tamper==='missing')return {rows:[]};
        return {rows:[tamper?{...row,...tamper}:row]};
      }
      throw Error('unexpected statement '+text);
    },
    async transaction(callback,options){
      assert.equal(db.isTransaction,false);
      events.push('BEGIN '+options?.isolation);db.isTransaction=true;
      try{const value=await callback();events.push('COMMIT');return value;}
      catch(error){events.push('ROLLBACK');throw error;}
      finally{db.isTransaction=false;}
    }};
  return db;
}
const writes=db=>db.statements.filter(item=>/^(INSERT|UPDATE|DELETE)/.test(item.sql));

function fakeService(db,{policy,raw,deployment},{authorize={ok:true},failAt=null}={}){
  const calls=[];
  const step=(name,value)=>async()=>{calls.push(name);db.timeline.push(name);if(failAt?.[name])throw failAt[name];return value;};
  return {db,profileV2Enabled:true,enrollmentEnabled:false,capacityPolicy:policy,calls,
    ready:step('ready'),scope:step('scope'),raw:step('raw',raw),deployment:step('deployment',deployment),
    async authorizeV2(owner,contract,action){calls.push('authorize:'+action);db.timeline.push('authorize:'+action);return authorize;}};
}

function setup(options={}){
  const w=world(options.world);
  const db=fakeDb(options.db);
  const service=fakeService(db,w,options.service);
  const input={db,profileService:service,policy:w.policy,request,readEngineHash:async()=>sha('f'),clock:()=>1800000000000,...options.input};
  return {w,db,service,input,run:(extra={})=>enqueueQuantProfileDiagnostic({...input,...extra})};
}

test('request selects existing records only and refuses every other field or shape',()=>{
  const accepted=validateDiagnosticRequest(request);
  assert.deepEqual(accepted,request);assert.ok(Object.isFrozen(accepted));assert.notEqual(accepted,request);
  const bad=[{},{...request,completion_mode:'pf2-enrollment-v1'},{...request,policy:{}},{...request,budget:{}},
    {...request,engine_hash:sha('f')},{...request,contract:{}},{...request,result:{}},{...request,extra:1},
    ...Object.keys(request).map(name=>Object.fromEntries(Object.entries(request).filter(([key])=>key!==name))),
    ...Object.keys(request).map(name=>({...request,[name]:7})),
    {...request,owner_id:'-owner'},{...request,bot_id:'bot a'},{...request,owner_id:'o'.repeat(129)},
    {...request,raw_job_id:'ABCDEF12-1111-4111-8111-111111111111'},{...request,raw_job_id:'not-a-uuid'},
    {...request,deployment_id:'short'},{...request,deployment_id:'deployment_123'},
    {...request,idempotency_key:'short'},{...request,idempotency_key:'key with spaces'},
    null,[],'text',7,Object.create({inherited:true}),
    Object.defineProperty({...request},'owner_id',{get:()=>'owner-a',enumerable:true}),
    Object.defineProperty({...request},Symbol('x'),{value:1,enumerable:true})];
  for(const value of bad)assert.throws(()=>validateDiagnosticRequest(value),code('QUANT_DIAGNOSTIC_REQUEST_INVALID'));
  assert.throws(()=>validateDiagnosticRequest(JSON.parse('{"__proto__":{},"owner_id":"a"}')),code('QUANT_DIAGNOSTIC_REQUEST_INVALID'));
});

test('environment is explicit Linux staging diagnostic mode and is never changed by the check',()=>{
  const before=structuredClone(environment);
  assert.doesNotThrow(()=>assertDiagnosticEnvironment({environment,platform:'linux'}));
  assert.deepEqual(environment,before);
  const {QUANT_PROFILE_V2_ENROLLMENT_ENABLED,QUANT_PREFLIGHT_ENABLED,...unset}=environment;
  assert.doesNotThrow(()=>assertDiagnosticEnvironment({environment:unset,platform:'linux'}));
  const wrong=[];
  for(const platform of ['win32','darwin','freebsd'])wrong.push({environment,platform});
  for(const [name,value] of [['PINE_BRIDGE_ENV','production'],['PINE_BRIDGE_ENV','local'],['PAPER_TRADING','false'],
    ['PAPER_TRADING',undefined],['PINE_BRIDGE_ENABLED','0'],['QUANT_RESEARCH_ENABLED',undefined],
    ['QUANT_RESEARCH_FOUNDATION_ENABLED','true'],['QUANT_PROFILE_V2_ENABLED','0'],['QUANT_PROFILE_V2_ENABLED',undefined],
    ['QUANT_PROFILE_V2_ENROLLMENT_ENABLED','1'],['QUANT_PROFILE_V2_ENROLLMENT_ENABLED','true'],
    ['QUANT_PROFILE_V2_ENROLLMENT_ENABLED',''],['QUANT_PREFLIGHT_ENABLED','1'],['QUANT_PREFLIGHT_ENABLED','yes'],
    ['DATABASE_URL',undefined],['DATABASE_URL',''],['QUANT_CAPACITY_POLICY_FILE',undefined],
    ['QUANT_STORAGE_LIMITS_FILE',undefined],['QUANT_RESEARCH_DATASET_ROOT','']])
    wrong.push({environment:{...environment,[name]:value},platform:'linux'});
  for(const input of wrong)assert.throws(()=>assertDiagnosticEnvironment(input),code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED'));
  assert.deepEqual(environment,before);
});

test('arguments default to a dry run and a write must carry the reviewed plan hash',()=>{
  const file='/home/owner/request.json',hex=sha('a');
  assert.deepEqual(parseDiagnosticArguments([file]),{requestFile:file,enqueue:false,expectContractHash:null});
  assert.deepEqual(parseDiagnosticArguments([file,'--expect-contract-hash='+hex]),
    {requestFile:file,enqueue:false,expectContractHash:hex});
  for(const order of [['--enqueue','--expect-contract-hash='+hex],['--expect-contract-hash='+hex,'--enqueue']])
    assert.deepEqual(parseDiagnosticArguments([file,...order]),{requestFile:file,enqueue:true,expectContractHash:hex});
  assert.throws(()=>parseDiagnosticArguments([file,'--enqueue']),code('QUANT_DIAGNOSTIC_PLAN_REQUIRED'));
  for(const argv of [[],['--enqueue'],[file,'--enqueue','--enqueue'],[file,'--force'],[file,'enqueue'],
    [file,'--expect-contract-hash='+hex,'--expect-contract-hash='+hex],[file,'--expect-contract-hash='],
    [file,'--expect-contract-hash='+hex.toUpperCase()],[file,'--expect-contract-hash='+hex.slice(1)],
    [file,'--enqueue','--expect-contract-hash='+hex,'--verbose'],[7],null,'--enqueue',undefined])
    assert.throws(()=>parseDiagnosticArguments(argv),code('QUANT_DIAGNOSTIC_USAGE'));
});

const privatePath='/home/owner/private/request.json';
// Linux x86-64 open flag values, injected so the flag arithmetic is tested on every platform.
const LINUX={O_RDONLY:0,O_NOFOLLOW:0o400000,O_NONBLOCK:0o4000,O_CLOEXEC:0o2000000};
// Owner and mode of each directory above privatePath: root owns the top two, the running user (1000) the others.
const directoryDefaults={'/':{uid:0,mode:0o40755},'/home':{uid:0,mode:0o40755},
  '/home/owner':{uid:1000,mode:0o40750},'/home/owner/private':{uid:1000,mode:0o40700}};
function fakeFs({link={},info={},text=JSON.stringify(request),realpath=null,openError=null,directories={}}={}){
  const events=[],flags=[];
  const stats=overrides=>({dev:64,ino:7,uid:1000,mode:0o100600,nlink:1,size:Buffer.byteLength(text),
    isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false,...overrides});
  const folder=(name,overrides)=>({dev:64,ino:3,nlink:2,size:4096,isFile:()=>false,isDirectory:()=>true,
    isSymbolicLink:()=>false,...directoryDefaults[name],...overrides});
  return {events,flags,
    async lstat(file){
      events.push('lstat '+file);
      if(file===privatePath)return stats(link);
      if(directories[file] instanceof Error)throw directories[file];
      return folder(file,directories[file]);
    },
    async realpath(file){events.push('realpath');return realpath??file;},
    async open(file,mode){
      events.push('open');flags.push(mode);assert.equal(typeof mode,'number');
      if(openError)throw openError;
      return {async stat(){return stats(info);},async readFile(){return text;},async close(){events.push('close');}};
    }};
}
const readWith=(file,fileSystem,options={})=>
  readPrivateRequest(file,{fileSystem,platform:'linux',uid:1000,openConstants:LINUX,...options});

test('private request file is read only from an owner-only regular file with no link in the path',async()=>{
  const good=fakeFs();
  assert.deepEqual(await readWith(privatePath,good),request);
  assert.deepEqual(good.events,['lstat '+privatePath,'realpath','lstat /home/owner/private','lstat /home/owner',
    'lstat /home','lstat /','open','close']);
  const refused=[
    ['symlink',{link:{isSymbolicLink:()=>true,isFile:()=>false}}],
    ['not a regular file',{link:{isFile:()=>false}}],
    ['linked ancestor',{realpath:'/data/home/owner/private/request.json'}],
    ['opened object is not a file',{info:{isFile:()=>false}}],
    ['swapped after check',{info:{ino:8}}],['other device',{info:{dev:65}}],
    ['other user',{info:{uid:0}}],['group readable',{info:{mode:0o100640}}],['group writable',{info:{mode:0o100620}}],
    ['other readable',{info:{mode:0o100604}}],['world accessible',{info:{mode:0o100666}}],
    ['hard linked',{info:{nlink:2}}],
    ['too large by stat',{info:{size:16385}}],['too large by content',{text:' '.repeat(16385)}]];
  for(const [label,options] of refused){
    const system=fakeFs(options);
    await assert.rejects(readWith(privatePath,system),error=>{
      assert.equal(error.code,'QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED',label);
      assert.equal(error.message,error.code);assert.doesNotMatch(JSON.stringify(error)+error.message,/home|owner|secret/);
      return true;
    },label);
    assert.equal(system.events.filter(item=>item==='open').length,system.events.filter(item=>item==='close').length,
      label+' closes every handle it opened');
  }
  const noFollow=fakeFs({openError:Object.assign(Error('ELOOP: too many symbolic links /secret/path'),{code:'ELOOP'})});
  await assert.rejects(readWith(privatePath,noFollow),error=>error.code==='QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'&&
    !error.message.includes('secret'));
});

test('every directory above the request file belongs to the user or root and is closed to group and other',async()=>{
  for(const directories of [{},{'/home/owner':{uid:1000,mode:0o40755}},{'/home/owner/private':{uid:0,mode:0o40700}},
    {'/home':{uid:1000,mode:0o40755}},{'/home/owner':{uid:1000,mode:0o40500}}])
    assert.deepEqual(await readWith(privatePath,fakeFs({directories})),request);
  const refused=[
    ['other user owns the directory',{'/home/owner':{uid:1001}}],['other user owns the top directory',{'/':{uid:1001}}],
    ['group writable',{'/home/owner/private':{mode:0o40770}}],['group writable parent',{'/home/owner':{mode:0o40775}}],
    ['other writable',{'/home/owner/private':{mode:0o40702}}],
    ['world writable with sticky bit, like /tmp',{'/home':{mode:0o41777}}],
    ['root directory writable by group',{'/':{mode:0o40775}}],
    ['an ancestor is not a directory',{'/home/owner':{isDirectory:()=>false}}],
    ['an ancestor is a link',{'/home':{isDirectory:()=>false,isSymbolicLink:()=>true}}],
    ['an ancestor cannot be read',{'/home/owner':Object.assign(Error('EACCES /home/owner'),{code:'EACCES'})}]];
  for(const [label,directories] of refused){
    const system=fakeFs({directories});
    await assert.rejects(readWith(privatePath,system),error=>{
      assert.equal(error.code,'QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED',label);
      assert.equal(error.message,error.code,label);assert.ok(Number.isInteger(error.status),label);
      return true;
    },label);
    assert.equal(system.events.includes('open'),false,label+': the file is never opened');
  }
  // When root runs the command, root owns the file and only root-owned directories qualify.
  const asRoot=fakeFs({link:{uid:0},info:{uid:0},directories:{'/home/owner':{uid:0},'/home/owner/private':{uid:0}}});
  assert.deepEqual(await readWith(privatePath,asRoot,{uid:0}),request);
  await assert.rejects(readWith(privatePath,fakeFs({link:{uid:0},info:{uid:0}}),{uid:0}),
    code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
});

test('the request file is opened without following links, without blocking and close-on-exec',async()=>{
  const system=fakeFs();
  await readWith(privatePath,system);
  assert.deepEqual(system.flags,[LINUX.O_RDONLY|LINUX.O_NOFOLLOW|LINUX.O_NONBLOCK|LINUX.O_CLOEXEC]);
  assert.equal(new Set([LINUX.O_NOFOLLOW,LINUX.O_NONBLOCK,LINUX.O_CLOEXEC]).size,3);
  // Node exposes no O_CLOEXEC constant (libuv sets it on every open), so the other two flags cannot depend on it.
  const bare=fakeFs();
  await readWith(privatePath,bare,{openConstants:{O_RDONLY:0,O_NOFOLLOW:LINUX.O_NOFOLLOW,O_NONBLOCK:LINUX.O_NONBLOCK}});
  assert.deepEqual(bare.flags,[LINUX.O_NOFOLLOW|LINUX.O_NONBLOCK]);
  // A FIFO put in place after the checks opens at once and is then refused as no regular file.
  const fifo=fakeFs({info:{isFile:()=>false}});
  await assert.rejects(readWith(privatePath,fifo),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
  assert.deepEqual(fifo.flags,[LINUX.O_NOFOLLOW|LINUX.O_NONBLOCK|LINUX.O_CLOEXEC]);
  // On Linux the runtime itself must provide the two constants the open depends on.
  if(process.platform==='linux')for(const name of ['O_NOFOLLOW','O_NONBLOCK'])assert.equal(typeof fsConstants[name],'number',name);
});

test('private request file refuses non-canonical paths, other platforms and invalid content with fixed codes',async()=>{
  for(const file of ['request.json','./request.json','/home/owner/../owner/request.json','/home//owner/request.json',
    '/home/owner/request.json/','/home/owner/request\0.json','',7,null,undefined,{}])
    await assert.rejects(readWith(file,fakeFs()),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_REQUIRED'));
  for(const platform of ['win32','darwin'])
    await assert.rejects(readWith(privatePath,fakeFs(),{platform}),code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED'));
  await assert.rejects(readWith(privatePath,fakeFs(),{uid:undefined}),code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED'));
  const missing={...fakeFs(),lstat:async()=>{throw Object.assign(Error('ENOENT '+privatePath),{code:'ENOENT'});}};
  await assert.rejects(readWith(privatePath,missing),
    error=>error.code==='QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'&&!error.message.includes('home'));
  for(const text of ['','{',' not json ','[]','{}','null',JSON.stringify({...request,policy:{}}),JSON.stringify({...request,owner_id:7})])
    await assert.rejects(readWith(privatePath,fakeFs({text})),code('QUANT_DIAGNOSTIC_REQUEST_INVALID'));
});

/** True when every directory from the given one up to the root is owned by the running user or root and closed to
 * group and other: the ancestor rule of readPrivateRequest, which depends on how the host is set up.
 */
async function privateChain(directory){
  for(let current=directory;;current=path.dirname(current)){
    const info=await fs.lstat(current);
    if(!info.isDirectory()||(info.uid!==process.getuid()&&info.uid!==0)||(info.mode&0o022)!==0)return false;
    if(current===path.dirname(current))return true;
  }
}

test('real Linux directories: a request below a directory that others can write to is refused',{skip:process.platform!=='linux'&&'POSIX owner and mode bits are only real on Linux'},async t=>{
  // The temporary directory is writable by everyone on a normal host, so nothing below it can be trusted.
  const shared=await fs.realpath(os.tmpdir());
  if(((await fs.stat(shared)).mode&0o022)===0)return t.skip('the temporary directory is private on this host');
  const directory=await fs.mkdtemp(path.join(shared,'diagnostic-request-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'request.json');
  await fs.writeFile(file,JSON.stringify(request),{mode:0o600});await fs.chmod(file,0o600);
  await assert.rejects(readPrivateRequest(file),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
});

test('real Linux file permissions: only a private regular file is read',{skip:process.platform!=='linux'&&'POSIX owner and mode bits are only real on Linux'},async t=>{
  let base=null;
  for(const candidate of [path.dirname(fileURLToPath(import.meta.url)),os.homedir()]){
    if(base!==null)break;
    try{const real=await fs.realpath(candidate);if(await privateChain(real))base=real;}
    catch{/* This candidate is not usable on this host. */}
  }
  if(base===null)return t.skip('no directory chain on this host qualifies as private');
  const directory=await fs.mkdtemp(path.join(base,'.diagnostic-request-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'request.json');
  await fs.writeFile(file,JSON.stringify(request),{mode:0o600});await fs.chmod(file,0o600);
  assert.deepEqual(await readPrivateRequest(file),request);
  await fs.chmod(file,0o640);
  await assert.rejects(readPrivateRequest(file),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
  await fs.chmod(file,0o600);
  const link=path.join(directory,'link.json'),second=path.join(directory,'second.json');
  await fs.symlink(file,link);await fs.link(file,second);
  await assert.rejects(readPrivateRequest(link),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
  await assert.rejects(readPrivateRequest(file),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
  await assert.rejects(readPrivateRequest(path.join(directory,'missing.json')),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
  await assert.rejects(readPrivateRequest(directory),code('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'));
});

/** Contract the helper must create, written out independently of the helper. */
function expectedContract(w,{total=600,engine=sha('f')}={}){
  const model=w.model,market=w.deployment.deployment.snapshot.market,policyHash=capacityPolicyHash(w.policy);
  const budget={candidates:1,max_evaluations:1,max_runtime_ms:900000,max_output_bytes:1048576,max_state_bytes:1048576};
  return {version:'quant-foundation-v2',owner_id:request.owner_id,bot_id:request.bot_id,kind:'PROFILE',
    dataset:w.raw.result.dataset,engine_hash:engine,snapshot_hash:sha('4'),
    profile:{raw_job_id:request.raw_job_id,deployment_id:request.deployment_id,source_hash:sha('a'),
      effective_inputs_hash:sha('b'),execution_model:model,
      metadata_hash:hash(canonical({market,price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),
        data_profile:model.data_profile})),raw_provenance_sha256:hash(canonical(w.raw.result.provenance)),
      seed_bars:500,snapshot_hash:sha('4')},
    capacity:{version:'quant-capacity-v2',environment:'staging',policy_hash:policyHash,stage:'HISTORICAL_PREFLIGHT',
      scope:w.policy.scope,dataset:{raw_bars:total,seed_bars:500,warmup_bars:500,evaluation_bars:total-500,
        processed_bars:total-500},chunk_bars:Math.min(1000,total-500),budget,io:w.policy.io},
    budget:{...budget,chunk_bars:Math.min(1000,total-500)}};
}

test('dry run returns a deterministic plan, rolls back and writes nothing',async()=>{
  const f=setup({input:{readEngineHash:async()=>{f.db.events.push('ENGINE');return sha('f');}}});
  const plan=await f.run();
  assert.deepEqual(plan,{version:DIAGNOSTIC_PLAN_VERSION,ok:true,mode:'dry-run',outcome:'WOULD_ENQUEUE',refusal:null,
    request_sha256:hash(canonical(request)),contract_hash:hash(canonical(expectedContract(f.w))),
    policy_hash:capacityPolicyHash(f.w.policy),engine_hash:sha('f'),raw_bars:600,claim_window_ms:825000,
    completion_mode:null,evaluator_admission:false,job_id:null,job_status:null,reused:false});
  assert.equal(writes(f.db).length,0);
  // The executable closure is hashed before the transaction; the dry run always ends in a rollback.
  assert.deepEqual(f.db.events,['ENGINE','BEGIN SERIALIZABLE','ROLLBACK']);
  assert.deepEqual(f.service.calls,['ready','scope','raw','deployment','authorize:ENQUEUE']);
  // The lock wait is bounded by a statement right before the lock. The idle gate then runs straight after the
  // idempotency lookup and before the first raw, deployment, contract or authority step.
  assert.deepEqual(f.db.timeline,['tables','lock_timeout','lock','ready','row_lock','scope','idempotency','gate','raw',
    'deployment','authorize:ENQUEUE']);
  const inside=f.db.statements.map(item=>item.sql);
  assert.match(inside[0],/to_regclass/);assert.equal(inside[1],"SET LOCAL lock_timeout='1000ms'");
  assert.equal(inside[2],'LOCK TABLE quant_foundation_scheduler IN EXCLUSIVE MODE');
  const again=setup();
  assert.deepEqual(await again.run(),plan);
  assert.equal(diagnosticReport({plan}),diagnosticReport({plan:await setup().run()}));
});

test('write needs the reviewed hash and then adds one owner row and one unmarked queued job',async()=>{
  const plan=await setup().run();
  const missing=setup();
  await assert.rejects(missing.run({enqueue:true}),code('QUANT_DIAGNOSTIC_PLAN_REQUIRED'));
  assert.equal(missing.db.statements.length,0);
  const stale=setup();
  await assert.rejects(stale.run({enqueue:true,expectContractHash:sha('0')}),
    error=>error.code==='QUANT_DIAGNOSTIC_PLAN_MISMATCH'&&error.plan.contract_hash===plan.contract_hash);
  assert.equal(writes(stale.db).length,0);assert.deepEqual(stale.db.events,['BEGIN SERIALIZABLE','ROLLBACK']);
  const f=setup();
  const done=await f.run({enqueue:true,expectContractHash:plan.contract_hash});
  assert.deepEqual(f.db.events,['BEGIN SERIALIZABLE','COMMIT']);
  assert.deepEqual(f.db.timeline,['tables','lock_timeout','lock','ready','row_lock','scope','idempotency','gate','raw',
    'deployment','authorize:ENQUEUE','owner_insert','job_insert']);
  const [owner,job,...rest]=writes(f.db);
  assert.equal(rest.length,0);
  assert.match(owner.sql,/^INSERT INTO quant_foundation_owners\(owner_id\) VALUES\(\$1\) ON CONFLICT DO NOTHING$/);
  assert.deepEqual(owner.params,[request.owner_id]);
  const [jobId,ownerId,key,json,contractHash,createdAt,deadlineAt]=job.params;
  const stored=JSON.parse(json);
  assert.deepEqual(stored,expectedContract(f.w));
  assert.equal(Object.hasOwn(stored,'completion_mode'),false);
  assert.equal(contractHash,plan.contract_hash);assert.equal(hash(canonical(stored)),contractHash);
  assert.deepEqual([ownerId,key,createdAt,deadlineAt],[request.owner_id,request.idempotency_key,1800000000000,1800000900000]);
  assert.doesNotThrow(()=>validateFoundationRequestV2(stored,{policy:f.w.policy}));
  assert.deepEqual(done,{...plan,mode:'enqueue',outcome:'ENQUEUED',job_id:jobId,job_status:'QUEUED'});
});

function previousRow(w,{status='QUEUED',contract=expectedContract(w),...extra}={}){
  return {job_id:'22222222-2222-4222-8222-222222222222',owner_id:request.owner_id,
    idempotency_key:request.idempotency_key,contract,contract_hash:hash(canonical(contract)),status,...extra};
}

test('the same idempotency key returns the existing job in any state and writes nothing',async()=>{
  const reviewed=hash(canonical(expectedContract(world())));
  for(const status of ['QUEUED','PAUSED','RUNNING','STOPPING','CANCELLED','SUCCEEDED'])
    for(const enqueue of [false,true]){
      // The gates would refuse a new job here, so reaching the existing job proves they are not consulted.
      const first=setup({db:{previous:[previousRow(world(),{status})],gate:{executing:1,waiting:3,bot_active:1}}});
      const result=await first.run({enqueue,expectContractHash:enqueue?reviewed:null});
      assert.deepEqual([result.outcome,result.reused,result.job_status,result.job_id,result.ok],
        ['EXISTING',true,status,'22222222-2222-4222-8222-222222222222',true]);
      assert.deepEqual([result.contract_hash,result.policy_hash,result.engine_hash,result.raw_bars],
        [reviewed,capacityPolicyHash(first.w.policy),sha('f'),600]);
      assert.equal(writes(first.db).length,0);
      assert.deepEqual(first.service.calls,['ready','scope']);
      assert.equal(first.db.statements.some(item=>item.sql.includes('bot_active')),false);
      assert.deepEqual(first.db.events,['BEGIN SERIALIZABLE',enqueue?'COMMIT':'ROLLBACK']);
    }
});

test('an idempotency key bound to another selection, job type or damaged row is refused',async()=>{
  const w=world(),base=expectedContract(w);
  const contracts=[{...base,profile:{...base.profile,deployment_id:'deployment-999'}},
    {...base,profile:{...base.profile,raw_job_id:'33333333-3333-4333-8333-333333333333'}},
    {...base,bot_id:'bot-b'},{...base,owner_id:'owner-b'},{...base,completion_mode:'pf2-enrollment-v1'},
    {...base,version:'quant-foundation-v1'},{...base,kind:'BACKFILL'},{...base,profile:undefined}];
  const rows=contracts.map(contract=>previousRow(w,{contract,contract_hash:hash(canonical(JSON.parse(JSON.stringify(contract))))}));
  rows.push(previousRow(w,{contract_hash:sha('0')}),previousRow(w,{contract_hash:'bad'}),
    previousRow(w,{owner_id:'owner-b'}),previousRow(w,{contract:null,contract_hash:sha('0')}));
  for(const row of rows)for(const enqueue of [false,true]){
    const f=setup({db:{previous:[row]}});
    await assert.rejects(f.run({enqueue,expectContractHash:enqueue?sha('1'):null}),error=>error.code==='IDEMPOTENCY_CONFLICT'&&
      error.status===400&&error.plan.job_id===null&&error.plan.request_sha256===hash(canonical(request)));
    assert.equal(writes(f.db).length,0);assert.equal(f.db.events.at(-1),'ROLLBACK');
  }
  const twice=setup({db:{previous:[previousRow(w),previousRow(w)]}});
  await assert.rejects(twice.run(),code('QUANT_DIAGNOSTIC_IDEMPOTENCY_AMBIGUOUS'));
  const mismatch=setup({db:{previous:[previousRow(w)]}});
  await assert.rejects(mismatch.run({expectContractHash:sha('0')}),code('QUANT_DIAGNOSTIC_PLAN_MISMATCH'));
});

test('each gate refuses with its own code right after the idempotency lookup, before raw, deployment, contract and authority work',async()=>{
  const cases=[['QUANT_DIAGNOSTIC_BOT_ACTIVE',{bot_active:1}],
    ['QUANT_DIAGNOSTIC_BOT_ACTIVE',{bot_active:2,executing:1,launches:true,waiting:4}],
    ['QUANT_DIAGNOSTIC_NOT_IDLE',{executing:1}],['QUANT_DIAGNOSTIC_NOT_IDLE',{launches:true}],
    ['QUANT_DIAGNOSTIC_NOT_IDLE',{invalid:true}],['QUANT_DIAGNOSTIC_NOT_IDLE',{operations:true}],
    ['QUANT_DIAGNOSTIC_NOT_IDLE',{executing:1,waiting:2}],
    ['QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY',{waiting:1}],['QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY',{waiting:99}],
    ['QUANT_DIAGNOSTIC_STATE_INVALID',null],['QUANT_DIAGNOSTIC_STATE_INVALID',{bot_active:-1}],
    ['QUANT_DIAGNOSTIC_STATE_INVALID',{executing:1.5}],['QUANT_DIAGNOSTIC_STATE_INVALID',{waiting:'0'}],
    ['QUANT_DIAGNOSTIC_STATE_INVALID',{bot_active:null}],['QUANT_DIAGNOSTIC_STATE_INVALID',{launches:null}],
    ['QUANT_DIAGNOSTIC_STATE_INVALID',{invalid:'false'}],['QUANT_DIAGNOSTIC_STATE_INVALID',{operations:undefined}]];
  const reviewed=hash(canonical(expectedContract(world())));
  for(const [expected,gate] of cases)for(const enqueue of [false,true]){
    const f=setup({db:{gate}});
    await assert.rejects(f.run({enqueue,expectContractHash:enqueue?reviewed:null}),error=>{
      assert.equal(error.code,expected,JSON.stringify(gate));
      // The contract is built after the gate, so a refused plan holds the request and the policy only.
      assert.deepEqual([error.plan.contract_hash,error.plan.engine_hash,error.plan.raw_bars,error.plan.claim_window_ms,
        error.plan.mode,error.plan.job_id,error.plan.policy_hash,error.plan.request_sha256],
        [null,null,null,null,enqueue?'enqueue':'dry-run',null,capacityPolicyHash(f.w.policy),hash(canonical(request))]);
      return true;
    });
    // The scheduler lock covers the lookup and the gate only: no raw, deployment, contract or authority step ran.
    assert.deepEqual(f.service.calls,['ready','scope']);
    assert.deepEqual(f.db.timeline,['tables','lock_timeout','lock','ready','row_lock','scope','idempotency','gate']);
    assert.equal(writes(f.db).length,0);assert.deepEqual(f.db.events,['BEGIN SERIALIZABLE','ROLLBACK']);
  }
  // A busy system is refused before the reviewed hash is compared, so a wrong hash shows no contract hash either.
  const stale=setup({db:{gate:{waiting:1}}});
  await assert.rejects(stale.run({enqueue:true,expectContractHash:sha('0')}),
    error=>error.code==='QUANT_DIAGNOSTIC_QUEUE_NOT_EMPTY'&&error.plan.contract_hash===null);
});

test('schema, capacity, authority and contract refusals come before any write',async()=>{
  const reviewed=hash(canonical(expectedContract(world())));
  const cases=[
    ['QUANT_DIAGNOSTIC_SCHEMA_REQUIRED',{db:{tables:{ledgers:null}}},0],['QUANT_DIAGNOSTIC_SCHEMA_REQUIRED',{db:{tables:{launches:null}}},0],
    ['QUANT_DIAGNOSTIC_SCHEMA_REQUIRED',{db:{tables:{scheduler:null}}},0],['QUANT_DIAGNOSTIC_SCHEMA_REQUIRED',{db:{tables:{jobs:null}}},0],
    ['QUANT_DIAGNOSTIC_SCHEMA_REQUIRED',{db:{scheduler:0}},1],
    ['QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED',{world:{count:10001}},1],
    ['QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED',{world:{maxRuntimeMs:60000}},1],
    ['QUANT_DIAGNOSTIC_AUTHORITY_REFUSED',{service:{authorize:{ok:false}}},1],
    ['QUANT_DIAGNOSTIC_AUTHORITY_REFUSED',{service:{authorize:null}},1],['QUANT_DIAGNOSTIC_AUTHORITY_REFUSED',{service:{authorize:{}}},1],
    ['INVALID_FOUNDATION_V2',{input:{readEngineHash:async()=>'not-a-hash'}},1],
    ['FOUNDATION_INVALID_CLOCK',{input:{clock:()=>-1}},1],['FOUNDATION_INVALID_CLOCK',{input:{clock:()=>Number.MAX_SAFE_INTEGER}},1],
    ['FOUNDATION_INVALID_CLOCK',{input:{clock:()=>NaN}},1]];
  for(const [expected,options,transactions] of cases){
    const f=setup(options);
    await assert.rejects(f.run({enqueue:true,expectContractHash:reviewed}),error=>error.code===expected&&Number.isInteger(error.status),expected);
    assert.equal(writes(f.db).length,0);assert.equal(f.db.events.filter(item=>item==='COMMIT').length,0);
    assert.equal(f.db.events.filter(item=>item==='ROLLBACK').length,transactions);
  }
  // Boundary: exactly 10,000 raw bars and exactly runtime_max_ms plus the margin before the deadline are accepted.
  await assert.rejects(setup({world:{count:10001}}).run(),error=>error.code==='QUANT_DIAGNOSTIC_CAPACITY_UNSUPPORTED'&&
    error.plan.raw_bars===10001&&error.plan.contract_hash===null);
  assert.equal((await setup({world:{count:10000}}).run()).raw_bars,10000);
  assert.equal((await setup({world:{maxRuntimeMs:75000}}).run()).claim_window_ms,0);
  const other=world();other.deployment.source.source_hash=sha('7');
  const mismatch=setup();mismatch.service.deployment=async()=>other.deployment;
  await assert.rejects(mismatch.run(),code('INVALID_FOUNDATION_V2'));
});

test('wrong wiring, policy, request or arguments refuse before the database is touched',async()=>{
  const bad=[['enrollment enabled',f=>{f.service.enrollmentEnabled=true;}],
    ['profile v2 disabled',f=>{f.service.profileV2Enabled=false;}],
    ['no service policy',f=>{f.service.capacityPolicy=null;}],
    ['other service policy',f=>{f.service.capacityPolicy={...f.service.capacityPolicy,max_raw_bars:9999};}],
    ['other database',f=>{f.service.db={};}],['already in a transaction',f=>{f.db.isTransaction=true;}],
    ['not a database',f=>{f.input.db={};f.service.db=f.input.db;}]];
  for(const [label,mutate] of bad){
    const f=setup();mutate(f);
    await assert.rejects(enqueueQuantProfileDiagnostic({...f.input,db:f.input.db}),code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED'),label);
    assert.equal(f.db.statements.length,0,label);
  }
  const f=setup();
  const localPolicy={...f.w.policy,environment:'local'},noTerminal=structuredClone(f.w.policy);delete noTerminal.terminal;
  for(const policy of [localPolicy,noTerminal])
    await assert.rejects(f.run({policy}),code('QUANT_CAPACITY_POLICY_INVALID'));
  for(const policy of [null,undefined,{},{...f.w.policy,extra:1},{...f.w.policy,max_raw_bars:'10000'}])
    await assert.rejects(f.run({policy}),error=>error.code==='INVALID_CAPACITY_CONTRACT'||error.code==='QUANT_CAPACITY_POLICY_INVALID');
  await assert.rejects(f.run({request:{...request,policy:{}}}),code('QUANT_DIAGNOSTIC_REQUEST_INVALID'));
  await assert.rejects(f.run({enqueue:'yes'}),code('QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED'));
  await assert.rejects(f.run({expectContractHash:'abc'}),code('QUANT_DIAGNOSTIC_PLAN_REQUIRED'));
  await assert.rejects(f.run({enqueue:true}),code('QUANT_DIAGNOSTIC_PLAN_REQUIRED'));
  assert.equal(f.db.statements.length,0);assert.deepEqual(f.db.events,[]);
});

test('product refusals and database faults roll back untouched and never commit',async()=>{
  const reviewed=hash(canonical(expectedContract(world())));
  for(const step of ['ready','scope','raw','deployment']){
    const failure=Object.assign(Error('NOT_FOUND'),{code:'NOT_FOUND',status:404});
    const f=setup({service:{failAt:{[step]:failure}}});
    await assert.rejects(f.run({enqueue:true,expectContractHash:reviewed}),error=>error===failure&&
      error.plan.policy_hash===capacityPolicyHash(f.w.policy)&&(step==='raw'||step==='deployment'?error.plan.contract_hash===null:true));
    assert.equal(writes(f.db).length,0);assert.deepEqual(f.db.events,['BEGIN SERIALIZABLE','ROLLBACK']);
  }
  for(const pattern of [/^SET LOCAL/,/^LOCK TABLE/,/FOR UPDATE$/,/idempotency_key=\$2/,/bot_active/,/^INSERT INTO quant_foundation_owners/,/^INSERT INTO quant_foundation_jobs/]){
    const f=setup({db:{failOn:pattern}});
    await assert.rejects(f.run({enqueue:true,expectContractHash:reviewed}),error=>error.code==='57P01'&&!isPublic(error));
    assert.equal(f.db.events.includes('COMMIT'),false,String(pattern));assert.equal(f.db.events.at(-1),'ROLLBACK');
  }
  const loud=setup({input:{readEngineHash:async()=>{throw Error('cannot read /srv/release/src/secret.js');}}});
  await assert.rejects(loud.run(),error=>error.message.includes('secret.js'));
  assert.deepEqual(loud.db.events,[]);
});
const isPublic=error=>/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code??'')&&Number.isInteger(error.status);

test('the stored row is read back and any difference from the reviewed contract rolls the write back',async()=>{
  const reviewed=hash(canonical(expectedContract(world())));
  for(const tamper of ['missing',{status:'RUNNING'},{owner_id:'owner-b'},{idempotency_key:'other-key-0002'},
    {contract_hash:sha('0')},{attempts:1},{deadline_at:1},{result:{}},{checkpoint:{}},{contract:{...expectedContract(world()),bot_id:'bot-b'}}]){
    const f=setup({db:{tamper}});
    await assert.rejects(f.run({enqueue:true,expectContractHash:reviewed}),code('QUANT_DIAGNOSTIC_INSERT_FAILED'),JSON.stringify(tamper));
    assert.deepEqual(f.db.events,['BEGIN SERIALIZABLE','ROLLBACK']);
  }
});

const REPORT_KEYS=['claim_window_ms','completion_mode','contract_hash','engine_hash','evaluator_admission','job_id',
  'job_status','mode','ok','outcome','policy_hash','raw_bars','refusal','request_sha256','reused','sqlstate','version'];

test('report is one deterministic JSON line with a fixed key set and public codes only',async()=>{
  const blank=JSON.parse(diagnosticReport({}));
  assert.deepEqual(Object.keys(blank),[...REPORT_KEYS].sort());
  assert.equal(blank.ok,false);assert.equal(blank.evaluator_admission,false);assert.equal(blank.completion_mode,null);
  assert.equal(blank.sqlstate,null);
  const plan=await setup().run(),line=diagnosticReport({plan,mode:'dry-run'});
  assert.equal(line,diagnosticReport({plan:await setup().run(),mode:'dry-run'}));
  assert.equal(line.includes('\n'),false);assert.equal(canonical(JSON.parse(line)),line);
  assert.deepEqual(Object.keys(JSON.parse(line)),[...REPORT_KEYS].sort());
  const refused=JSON.parse(diagnosticReport({error:Object.assign(Error('free text'),{code:'QUANT_DIAGNOSTIC_NOT_IDLE',status:400}),mode:'enqueue'}));
  assert.deepEqual([refused.ok,refused.outcome,refused.refusal,refused.mode],[false,'REFUSED','QUANT_DIAGNOSTIC_NOT_IDLE','enqueue']);
  for(const error of [Object.assign(Error('postgres://robot:hunter2@db.internal.example/robot'),{code:'ECONNREFUSED'}),
    Object.assign(Error('x'),{code:'40001'}),Object.assign(Error('x'),{code:'QUANT_X',status:'400'}),
    Object.assign(Error('x'),{code:'lowercase_code',status:400}),Error('/etc/robot/private/policy.json'),'text',7,{}]){
    const generic=diagnosticReport({error});
    assert.equal(JSON.parse(generic).refusal,'QUANT_DIAGNOSTIC_FAILED');
    assert.equal(JSON.parse(generic).sqlstate,null);
    assert.doesNotMatch(generic,/hunter2|internal|etc|robot|text/);
  }
});

test('a server fault reports its five-character SQLSTATE and nothing else, so a rerun and a missing grant differ',()=>{
  const secret='postgres://robot:hunter2@db.internal.example/robot /srv/release/scripts/x.mjs';
  for(const sqlstate of ['40001','42501','55P03','57P01','57014','08006','25P03','XX000','P0001','HV000','0A000']){
    const line=diagnosticReport({error:serverFault(sqlstate),mode:'enqueue'}),report=JSON.parse(line);
    assert.deepEqual([report.ok,report.outcome,report.refusal,report.sqlstate],
      [false,'REFUSED','QUANT_DIAGNOSTIC_FAILED',sqlstate]);
    assert.deepEqual(Object.keys(report),[...REPORT_KEYS].sort());
    assert.doesNotMatch(line,/hunter2|internal|robot/);
  }
  const rerun=JSON.parse(diagnosticReport({error:serverFault('40001')})),grant=JSON.parse(diagnosticReport({error:serverFault('42501')}));
  assert.notEqual(rerun.sqlstate,grant.sqlstate);
  // Everything else shows no SQLSTATE: no server severity, a Node system error of five characters, a malformed code,
  // free text, a wrong type, and a coded refusal, whose own code already says what happened.
  for(const error of [Object.assign(Error(secret),{code:'40001'}),Object.assign(Error(secret),{code:'EPERM',errno:-1,syscall:'open'}),
    Object.assign(Error(secret),{code:'ELOOP',errno:-40,syscall:'open'}),Object.assign(Error(secret),{code:'EPIPE'}),
    Object.assign(Error(secret),{code:'4000',severity:'ERROR'}),Object.assign(Error(secret),{code:'400011',severity:'ERROR'}),
    Object.assign(Error(secret),{code:'4000a',severity:'ERROR'}),Object.assign(Error(secret),{code:40001,severity:'ERROR'}),
    Object.assign(Error(secret),{code:'40001',severity:7}),secret,7,{},{code:'42501'}]){
    const line=diagnosticReport({error}),report=JSON.parse(line);
    assert.deepEqual([report.refusal,report.sqlstate],['QUANT_DIAGNOSTIC_FAILED',null],String(error?.code));
    assert.doesNotMatch(line,/hunter2|internal|robot|srv/);
  }
  const coded=JSON.parse(diagnosticReport({error:Object.assign(Error('x'),{code:'QUANT_DIAGNOSTIC_NOT_IDLE',status:400,severity:'ERROR'})}));
  assert.deepEqual([coded.refusal,coded.sqlstate],['QUANT_DIAGNOSTIC_NOT_IDLE',null]);
  // A plan never carries one: only a failure does.
  assert.equal(JSON.parse(diagnosticReport({plan:{ok:true,outcome:'WOULD_ENQUEUE',mode:'dry-run'}})).sqlstate,null);
});

function command(options={}){
  const f=setup(options.setup);
  const counts={opened:0,closed:0,reads:0,policies:0};
  const input={argv:[privatePath],environment,platform:'linux',
    readRequest:async file=>{counts.reads++;assert.equal(file,privatePath);return request;},
    loadPolicy:async file=>{counts.policies++;assert.equal(file,environment.QUANT_CAPACITY_POLICY_FILE);return f.w.policy;},
    openDependencies:async({policy})=>{counts.opened++;assert.equal(policy,f.w.policy);
      return {db:f.db,profileService:f.service,close:async()=>{counts.closed++;}};},
    readEngineHash:async()=>sha('f'),clock:()=>1800000000000,...options.input};
  return {f,counts,run:()=>runQuantProfileDiagnostic(input)};
}
const parsed=result=>JSON.parse(result.output);

test('command dry run prints one stable plan, closes its database and never prints configuration',async()=>{
  const a=command(),b=command();
  const first=await a.run(),second=await b.run();
  assert.equal(first.exitCode,0);assert.equal(first.output,second.output);
  assert.deepEqual([parsed(first).ok,parsed(first).mode,parsed(first).outcome,parsed(first).refusal],
    [true,'dry-run','WOULD_ENQUEUE',null]);
  assert.deepEqual(a.counts,{opened:1,closed:1,reads:1,policies:1});
  assert.equal(writes(a.f.db).length,0);
  assert.doesNotMatch(first.output,/hunter2|db\.internal|postgres:|\/etc\/|\/home\/|\/var\/|owner-a|bot-a|deployment-123|diagnostic-key/);
  const reviewed=parsed(first).contract_hash;
  const write=command({input:{argv:[privatePath,'--enqueue','--expect-contract-hash='+reviewed]}});
  const written=await write.run();
  assert.equal(written.exitCode,0);assert.deepEqual([parsed(written).mode,parsed(written).outcome,parsed(written).job_status],
    ['enqueue','ENQUEUED','QUEUED']);
  assert.match(parsed(written).job_id,/^[a-f0-9-]{36}$/);assert.equal(writes(write.f.db).length,2);
});

test('a thrown null or undefined is still a refusal and never a plan',async()=>{
  for(const thrown of [null,undefined]){
    const c=command({input:{readRequest:async()=>{throw thrown;}}});
    const result=await c.run();
    assert.equal(result.exitCode,2);assert.deepEqual([parsed(result).ok,parsed(result).outcome,parsed(result).refusal],
      [false,'REFUSED','QUANT_DIAGNOSTIC_FAILED']);
  }
});

test('command refuses before any file, policy or database work when arguments or environment are wrong',async()=>{
  const reviewed=sha('1');
  const cases=[['QUANT_DIAGNOSTIC_USAGE',{argv:[]}],['QUANT_DIAGNOSTIC_USAGE',{argv:[privatePath,'--force']}],
    ['QUANT_DIAGNOSTIC_PLAN_REQUIRED',{argv:[privatePath,'--enqueue']}],
    ['QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED',{platform:'win32'}],
    ['QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED',{environment:{...environment,QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'1'}}],
    ['QUANT_DIAGNOSTIC_CONFIGURATION_REQUIRED',{argv:[privatePath,'--enqueue','--expect-contract-hash='+reviewed],environment:{...environment,PAPER_TRADING:'false'}}]];
  for(const [expected,input] of cases){
    const c=command({input});const result=await c.run();
    assert.equal(result.exitCode,2);assert.equal(parsed(result).refusal,expected);assert.equal(parsed(result).ok,false);
    assert.deepEqual(c.counts,{opened:0,closed:0,reads:0,policies:0});
  }
});

test('command maps every failure to a fixed code and still closes the database',async()=>{
  const secret=Error('postgres://robot:hunter2@db.internal.example:5432/robot at /srv/release/scripts/x.mjs');
  const refusal=Object.assign(Error('QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED'),{code:'QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED',status:400});
  const cases=[
    ['QUANT_DIAGNOSTIC_PRIVATE_FILE_UNTRUSTED',{readRequest:async()=>{throw refusal;}},{opened:0,closed:0}],
    ['QUANT_CAPACITY_POLICY_REQUIRED',{loadPolicy:async()=>{throw Object.assign(Error('ENOENT /etc/robot/private/capacity-policy.json'),{code:'ENOENT'});}},{opened:0,closed:0}],
    ['QUANT_CAPACITY_POLICY_UNTRUSTED',{loadPolicy:async()=>{throw Object.assign(Error('QUANT_CAPACITY_POLICY_UNTRUSTED'),{code:'QUANT_CAPACITY_POLICY_UNTRUSTED',status:400});}},{opened:0,closed:0}],
    ['QUANT_DIAGNOSTIC_FAILED',{openDependencies:async()=>{throw secret;}},{opened:0,closed:0}],
    ['QUANT_DIAGNOSTIC_FAILED',{readEngineHash:async()=>{throw secret;}},{opened:1,closed:1}]];
  for(const [expected,input,counts] of cases){
    const c=command({input});const result=await c.run();
    assert.equal(result.exitCode,2);assert.equal(parsed(result).refusal,expected);
    assert.doesNotMatch(result.output,/hunter2|db\.internal|\/srv\/|\/etc\/|ENOENT|postgres:/);
    assert.equal(c.counts.opened,counts.opened);assert.equal(c.counts.closed,counts.closed);
  }
  // A database fault inside the transaction: fixed code, the SQLSTATE alone, the redacted plan so far, rollback and
  // close. At the gate no contract exists yet. At the write it does.
  const faulty=command({setup:{db:{failOn:/bot_active/,faultCode:'40001'}}});
  const result=await faulty.run();
  assert.equal(parsed(result).refusal,'QUANT_DIAGNOSTIC_FAILED');assert.equal(parsed(result).outcome,'REFUSED');
  assert.deepEqual([parsed(result).sqlstate,parsed(result).contract_hash],['40001',null]);
  assert.equal(faulty.f.db.events.at(-1),'ROLLBACK');assert.equal(faulty.counts.closed,1);
  assert.doesNotMatch(result.output,/hunter2|db\.internal|postgres:/);
  const reviewed=hash(canonical(expectedContract(world())));
  const writing=command({input:{argv:[privatePath,'--enqueue','--expect-contract-hash='+reviewed]},
    setup:{db:{failOn:/^INSERT INTO quant_foundation_jobs/,faultCode:'42501'}}});
  const denied=await writing.run();
  assert.deepEqual([denied.exitCode,parsed(denied).refusal,parsed(denied).sqlstate,parsed(denied).contract_hash],
    [2,'QUANT_DIAGNOSTIC_FAILED','42501',reviewed]);
  assert.equal(writing.f.db.events.at(-1),'ROLLBACK');assert.equal(writing.counts.closed,1);
  assert.doesNotMatch(denied.output,/hunter2|db\.internal|postgres:/);
  // A failing close cannot change the decided outcome.
  const closing=setup();
  const closed=await runQuantProfileDiagnostic({argv:[privatePath],environment,platform:'linux',readRequest:async()=>request,
    loadPolicy:async()=>closing.w.policy,readEngineHash:async()=>sha('f'),
    openDependencies:async()=>({db:closing.db,profileService:closing.service,close:async()=>{throw secret;}})});
  assert.equal(closed.exitCode,0);assert.equal(parsed(closed).outcome,'WOULD_ENQUEUE');assert.doesNotMatch(closed.output,/hunter2/);
});

test('the wait for the scheduler lock is bounded and a lock timeout is a coded refusal that does nothing else',async()=>{
  const reviewed=hash(canonical(expectedContract(world())));
  for(const enqueue of [false,true])for(const [pattern,calls] of [[/^LOCK TABLE/,[]],[/FOR UPDATE$/,['ready']]]){
    const busy=setup({db:{failOn:pattern,faultCode:'55P03'}});
    await assert.rejects(busy.run({enqueue,expectContractHash:enqueue?reviewed:null}),error=>{
      assert.equal(error.code,'QUANT_DIAGNOSTIC_LOCK_TIMEOUT',String(pattern));
      assert.ok(Number.isInteger(error.status));assert.equal(error.message,error.code);
      assert.doesNotMatch(JSON.stringify(error)+error.message,/hunter2|internal/);
      assert.equal(error.plan.job_id,null);
      return true;
    });
    // Nothing after the failed statement ran, and nothing was written or committed.
    assert.deepEqual(busy.service.calls,calls);assert.equal(writes(busy.db).length,0);
    assert.deepEqual(busy.db.events,['BEGIN SERIALIZABLE','ROLLBACK']);
  }
  // Another cancellation of the same statement is no lock timeout.
  const cancelled=setup({db:{failOn:/^LOCK TABLE/,faultCode:'57014'}});
  await assert.rejects(cancelled.run(),error=>error.code==='57014'&&!isPublic(error));
  // The command prints the refusal line without a SQLSTATE, exits with 2 and closes its database.
  const c=command({setup:{db:{failOn:/^LOCK TABLE/,faultCode:'55P03'}}});
  const result=await c.run();
  assert.equal(result.exitCode,2);
  assert.deepEqual([parsed(result).ok,parsed(result).outcome,parsed(result).refusal,parsed(result).sqlstate],
    [false,'REFUSED','QUANT_DIAGNOSTIC_LOCK_TIMEOUT',null]);
  assert.equal(c.counts.closed,1);assert.doesNotMatch(result.output,/hunter2|internal|postgres:/);
});

test('the crash reporter prints one redacted failure line, once, and exits with 2',()=>{
  const secret='postgres://robot:hunter2@db.internal.example/robot at /srv/release/node_modules/pg/lib/client.js';
  const unreadable=new Proxy({},{get(){throw Error('unreadable '+secret);}});
  const leak={job_id:'33333333-3333-4333-8333-333333333333',ok:true};
  const faults=[[serverFault('57P01','FATAL'),['QUANT_DIAGNOSTIC_FAILED','57P01']],
    [Object.assign(Error(secret),{code:'ECONNRESET',stack:secret}),['QUANT_DIAGNOSTIC_FAILED',null]],
    [Object.assign(Error('x'),{code:'QUANT_DIAGNOSTIC_NOT_IDLE',status:400}),['QUANT_DIAGNOSTIC_NOT_IDLE',null]],
    [Object.assign(Error(secret),{plan:leak}),['QUANT_DIAGNOSTIC_FAILED',null]],
    [unreadable,['QUANT_DIAGNOSTIC_FAILED',null]],[secret,['QUANT_DIAGNOSTIC_FAILED',null]],
    [7,['QUANT_DIAGNOSTIC_FAILED',null]],[null,['QUANT_DIAGNOSTIC_FAILED',null]],
    [undefined,['QUANT_DIAGNOSTIC_FAILED',null]]];
  for(const [fault,expected] of faults)for(const event of ['uncaughtException','unhandledRejection']){
    const lines=[],exits=[];
    const target=Object.assign(new EventEmitter(),{exit:exitCode=>exits.push(exitCode)});
    installCrashReporter({target,write:line=>lines.push(line),mode:'enqueue'});
    assert.deepEqual([target.listenerCount('uncaughtException'),target.listenerCount('unhandledRejection')],[1,1]);
    target.emit(event,fault);
    // Any further event of either kind is ignored: one line and one exit.
    target.emit('uncaughtException',Error('again '+secret));target.emit('unhandledRejection',serverFault('40001'));
    assert.equal(lines.length,1,event);assert.deepEqual(exits,[2],event);
    const report=JSON.parse(lines[0]);
    assert.deepEqual([report.ok,report.outcome,report.mode,report.job_id,report.contract_hash],
      [false,'REFUSED','enqueue',null,null]);
    assert.deepEqual([report.refusal,report.sqlstate],expected);
    assert.equal(canonical(report),lines[0]);assert.deepEqual(Object.keys(report),[...REPORT_KEYS].sort());
    assert.doesNotMatch(lines[0],/hunter2|internal|\/srv\/|release|client\.js|3333/);
  }
  // An output that cannot be written does not stop the exit, and the mode is optional.
  const exits=[],lines=[];
  const closed=Object.assign(new EventEmitter(),{exit:exitCode=>exits.push(exitCode)});
  installCrashReporter({target:closed,write:()=>{throw Error('EPIPE '+secret);}});
  closed.emit('uncaughtException',Error('x'));assert.deepEqual(exits,[2]);
  const bare=Object.assign(new EventEmitter(),{exit:()=>{}});
  installCrashReporter({target:bare,write:line=>lines.push(line)});
  bare.emit('unhandledRejection',Error('x'));assert.equal(JSON.parse(lines[0]).mode,null);
});

test('a real uncaught exception or unhandled rejection prints one redacted line and exits with 2',async t=>{
  const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'crash-reporter-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const helper=new URL('../scripts/enqueue-quant-profile-diagnostic.mjs',import.meta.url).href;
  const secret='postgres://robot:hunter2@db.internal.example/robot /srv/release/secret.js';
  for(const trigger of ['setTimeout(()=>{throw fault;},5);','Promise.reject(fault);']){
    const file=path.join(directory,'crash.mjs');
    await fs.writeFile(file,[`import {installCrashReporter} from ${JSON.stringify(helper)};`,
      `const fault=Object.assign(new Error(${JSON.stringify(secret)}),{code:'57P01',severity:'FATAL'});`,
      "installCrashReporter({mode:'dry-run'});",trigger,
      "setTimeout(()=>{console.log('the process was still running');},3000);"].join('\n'));
    const result=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:60000});
    assert.equal(result.status,2,trigger);assert.equal(result.stderr,'',trigger);
    const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1,trigger);
    const report=JSON.parse(lines[0]);
    assert.deepEqual([report.ok,report.outcome,report.refusal,report.sqlstate,report.mode],
      [false,'REFUSED','QUANT_DIAGNOSTIC_FAILED','57P01','dry-run'],trigger);
    assert.doesNotMatch(result.stdout+result.stderr,/hunter2|internal|\/srv\/|secret\.js|running/,trigger);
  }
});

const scriptsDirectory=fileURLToPath(new URL('../scripts/',import.meta.url));
// No staging settings: the command stops at argument parsing or at the configuration check, before any file or
// database work, so a start through any path can only print its own refusal line.
const bareEnvironment=()=>{
  const env={...process.env};
  for(const name of ['PAPER_TRADING','PINE_BRIDGE_ENV','QUANT_RESEARCH_FOUNDATION_ENABLED','DATABASE_URL','TEST_DATABASE_URL'])
    delete env[name];
  return env;
};
const startScript=file=>spawnSync(process.execPath,[file],{env:bareEnvironment(),encoding:'utf8',timeout:60000});

test('the command still runs when it is started through a symbolic link or a junction',async t=>{
  const real=path.join(scriptsDirectory,'enqueue-quant-profile-diagnostic.mjs');
  const directory=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'script-link-'));
  const created=[];
  // Remove the links themselves and then the empty directory. Neither call can remove the real scripts through a link.
  t.after(async()=>{for(const item of created)await fs.unlink(item);await fs.rmdir(directory);});
  const folder=path.join(directory,'current');
  // A junction needs no privilege on Windows. Elsewhere the type is ignored and this is a symbolic link.
  await fs.symlink(scriptsDirectory,folder,'junction');created.push(folder);
  const direct=startScript(real),linked=startScript(path.join(folder,'enqueue-quant-profile-diagnostic.mjs'));
  for(const result of [direct,linked]){
    assert.equal(result.status,2);assert.equal(result.stderr,'');
    const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1);
    assert.deepEqual([JSON.parse(lines[0]).ok,JSON.parse(lines[0]).refusal],[false,'QUANT_DIAGNOSTIC_USAGE']);
  }
  assert.equal(linked.stdout,direct.stdout);
  // A link to the file itself runs as well. Windows may refuse to create one without privilege.
  const fileLink=path.join(directory,'diagnostic.mjs');
  try{await fs.symlink(real,fileLink,'file');created.push(fileLink);}
  catch(error){if(!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error;}
  if(created.includes(fileLink)){
    const viaFile=startScript(fileLink);
    assert.deepEqual([viaFile.status,viaFile.stderr,viaFile.stdout],[2,'',direct.stdout]);
  }
  // Imported by a process whose argv[1] is no real file, the module only defines its functions and prints nothing.
  const probe=path.join(directory,'probe.mjs');created.push(probe);
  await fs.writeFile(probe,["process.argv[1]='/no/such/place/diagnostic.mjs';",
    "const listeners=()=>process.listenerCount('uncaughtException')+process.listenerCount('unhandledRejection');",
    'const before=listeners();',
    `await import(${JSON.stringify(new URL('../scripts/enqueue-quant-profile-diagnostic.mjs',import.meta.url).href)});`,
    "console.log(listeners()===before?'imported':'the import changed the process handlers');"].join('\n'));
  const imported=startScript(probe);
  assert.deepEqual([imported.status,imported.stdout.trim(),imported.stderr],[0,'imported','']);
});

test('script source prints only the one report line, installs the crash reporter first and resolves links',()=>{
  const source=readFileSync(new URL('../scripts/enqueue-quant-profile-diagnostic.mjs',import.meta.url),'utf8');
  // One writer of standard output: the report line, from the command or from the crash reporter.
  assert.equal([...source.matchAll(/console\./g)].length,1);
  assert.match(source,/console\.log\(line\)/);
  assert.doesNotMatch(source,/\.message\b|\.stack\b|console\.(error|warn|info|debug|trace)|process\.exit\(|process\.stdout|process\.stderr/);
  // The command reads its environment and never assigns to it.
  assert.doesNotMatch(source,/(process\.env|environment)(\.\w+|\[[^\]]+\])\s*=[^=]/);
  // The only exit is the crash reporter's, with code 2, and it is armed before the command runs.
  assert.equal([...source.matchAll(/\.exit\(/g)].length,1);assert.match(source,/target\.exit\(2\)/);
  const entry=source.slice(source.indexOf('if(startedAsCommand())'));
  assert.ok(entry.includes('installCrashReporter(')&&
    entry.indexOf('installCrashReporter(')<entry.indexOf('await runQuantProfileDiagnostic()'));
  // The start guard compares the real path, so a link to the script still runs it.
  assert.match(source,/import\.meta\.url===pathToFileURL\(realpathSync\(process\.argv\[1\]\)\)\.href/);
  assert.doesNotMatch(source,/pathToFileURL\(process\.argv\[1\]\)/);
});
