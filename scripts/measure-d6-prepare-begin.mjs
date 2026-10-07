import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

/**
 * D6 measurement harness. It never runs by itself: an operator or a test starts it against an empty database.
 *
 * It times the two steps that only a marked PROFILE V2 job (contract completion_mode 'pf2-enrollment-v1') runs
 * between its accepted frame and its terminal, through the same product objects the worker wiring builds:
 *   prepare  QuantIoRuntime.prepareEnrollment: strict validation, the executable-closure hash and the BEGIN ticket.
 *   begin    QuantFoundationScheduler.beginProfileCompletion: the SERIALIZABLE transaction with the scheduler table
 *            lock, the schema assertion and the locked enrollment authority.
 * The worker heartbeat drain that runs between the two (beforeTerminal) is reported as its own phase, with a random
 * heartbeat phase against prepare, as on the worker.
 *
 * Contention comes from separate processes, as on the host. Each can be switched off with a count of 0:
 *   read    API-style reads (QuantProfileService.get in SERIALIZABLE transactions) of the measured job. Each holds
 *           the scheduler row and the job row for its transaction, plus --hold-ms.
 *   cancel  API-style enrollment enqueues of a decoy (these hash the executable closure) and owner cancels of it.
 *   claim   scheduler claim polls (scheduler table lock and the running-job check).
 *   hash    executable-closure hashing (CPU and file reads).
 *   vacuum  VACUUM (ANALYZE) of the scheduler and job tables every --vacuum-interval-ms, as autovacuum would.
 * Between samples every contender pauses, so no decoy is queued when the measuring process claims its next job.
 *
 * Database safety. The database comes only from --database-url or D6_DATABASE_URL. No other variable is read, and the
 * PostgreSQL routing variables (PGHOST, PGDATABASE and similar) are removed first. Before it connects, the harness
 * refuses any database name that does not match d6_[a-z0-9_]+, any host other than loopback or a local socket
 * directory, and any URL query other than one socket directory. After it connects, and before any write, it refuses a
 * database that reports another name or server address or holds any relation outside the system schemas. The caller
 * creates the empty database and drops it afterwards. The harness installs the product schema through the product
 * migrations and fills it through the product services with synthetic Paper fixtures. It never contacts an exchange.
 *
 * Output: one JSON report on standard output and exit 0. A refusal prints {"error":CODE} on standard error and exits
 * 2; any other failure prints {"error":"D6_FAILED","code":CODE} and exits 1. The report and these lines hold no paths,
 * hosts, URLs, users or messages. --debug adds the stack of a failure on standard error.
 *
 * Usage (pass the URL in the environment, not on the command line, so the password stays out of the process list):
 *   D6_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:PORT/d6_example node scripts/measure-d6-prepare-begin.mjs
 *     [--samples=200] [--warmup=5] [--max-seconds=120] [--read=2] [--cancel=1] [--claim=1] [--hash=1] [--vacuum=1]
 *     [--hold-ms=0] [--think-ms=2] [--settle-ms=10] [--vacuum-interval-ms=500] [--heartbeat-ms=5000]
 *     [--evidence-class=development-only|staging-run] [--debug]
 * Every number has a hard cap (LIMITS). Sampling stops at --max-seconds after start, and a watchdog ends the run 60 s
 * later. The report is a measurement only: D6 acceptance and the marked reserve stay root decisions.
 */

const REPORT_VERSION='d6-prepare-begin-v1';
const SCRIPT=fileURLToPath(import.meta.url);
const DATABASE_NAME=/^d6_[a-z0-9_]{1,59}$/;
const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
const SCRUBBED_ENV=['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGSERVICE','PGSERVICEFILE','DATABASE_URL','TEST_DATABASE_URL'];
const LIMITS=Object.freeze({samples:[1,5000],warmup:[0,100],'max-seconds':[5,600],read:[0,8],cancel:[0,8],claim:[0,8],
  hash:[0,8],vacuum:[0,2],'hold-ms':[0,100],'think-ms':[0,1000],'settle-ms':[0,1000],'vacuum-interval-ms':[50,10000],
  'heartbeat-ms':[10,5000]});
// The heartbeat default is the worker's own interval for its 30 s lease: max(10, min(5000, floor(leaseMs / 3))).
const DEFAULTS=Object.freeze({samples:200,warmup:5,'max-seconds':120,read:2,cancel:1,claim:1,hash:1,vacuum:1,'hold-ms':0,
  'think-ms':2,'settle-ms':10,'vacuum-interval-ms':500,'heartbeat-ms':5000});
const ROLES=['read','cancel','claim','hash','vacuum'];
const EVIDENCE_CLASSES=['development-only','staging-run'];
const MAX_CONTENDERS=16,POOL_MAX=5,CONTENDER_POOL_MAX=2,LEASE_MS=30000,WATCHDOG_GRACE_MS=60000,BARRIER_MS=30000;
const PG_SETTINGS=['server_version','max_connections','shared_buffers','work_mem','default_transaction_isolation',
  'deadlock_timeout','lock_timeout','idle_in_transaction_session_timeout','autovacuum','autovacuum_naptime',
  'synchronous_commit','fsync','max_pred_locks_per_transaction','max_worker_processes'];
const MINUTE=60000;
const SOURCE='//@version=6\nindicator("Synthetic queue fixture")\nbuySignal=false\nsellSignal=false';

class Refusal extends Error{constructor(code){super(code);this.code=code;}}
const refuse=code=>{throw new Refusal(code);};
const failure=code=>Object.assign(new Error(code),{code});
const safeCode=error=>{const code=error?.code;return typeof code==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(code)?code:'UNKNOWN';};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tally=(counts,key)=>{counts[key]=(counts[key]??0)+1;};
const round=value=>Math.round(value*1000)/1000;
const debug=process.argv.includes('--debug');
/** Checks the URL text only; nothing here connects. */
function checkDatabaseUrl(value){
  if(typeof value!=='string'||!value)refuse('D6_DATABASE_URL_REQUIRED');
  let url,name,host;
  try{url=new URL(value);name=decodeURIComponent(url.pathname.slice(1));host=decodeURIComponent(url.hostname);}
  catch{refuse('D6_DATABASE_URL_INVALID');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash)refuse('D6_DATABASE_URL_INVALID');
  if(!DATABASE_NAME.test(name))refuse('D6_DATABASE_NAME_REFUSED');
  // The client lets query parameters replace the host, database and session options, so only one socket directory
  // may appear there.
  const keys=[...url.searchParams.keys()];
  if(keys.length>1||keys.some(key=>key!=='host'))refuse('D6_DATABASE_URL_INVALID');
  const socket=url.searchParams.get('host');
  if(socket!==null){
    if(host||!path.posix.isAbsolute(socket))refuse('D6_DATABASE_HOST_REFUSED');
    return {name,connection:'unix-socket'};
  }
  if(host.startsWith('/'))return {name,connection:'unix-socket'};
  if(LOOPBACK.has(host))return {name,connection:'loopback'};
  refuse('D6_DATABASE_HOST_REFUSED');
}

function parseOptions(argv,env){
  const options={...DEFAULTS,'database-url':undefined,'evidence-class':'development-only'};
  for(const arg of argv){
    if(arg==='--debug')continue;
    const match=/^--([a-z-]+)=(.*)$/s.exec(arg);
    if(!match||!Object.hasOwn(options,match[1]))refuse('D6_USAGE');
    options[match[1]]=match[2];
  }
  for(const [name,[min,max]] of Object.entries(LIMITS)){
    if(!/^\d{1,6}$/.test(String(options[name])))refuse('D6_USAGE');
    const value=Number(options[name]);
    if(value<min||value>max)refuse('D6_USAGE');
    options[name]=value;
  }
  if(ROLES.reduce((sum,role)=>sum+options[role],0)>MAX_CONTENDERS)refuse('D6_USAGE');
  if(!EVIDENCE_CLASSES.includes(options['evidence-class']))refuse('D6_USAGE');
  if(options['evidence-class']==='staging-run'&&process.platform!=='linux')refuse('D6_EVIDENCE_CLASS_REFUSED');
  const argument=options['database-url'],variable=env.D6_DATABASE_URL;
  if(argument!==undefined&&variable!==undefined&&argument!==variable)refuse('D6_USAGE');
  const url=argument??variable;
  delete options['database-url'];
  return {options,url,target:checkDatabaseUrl(url)};
}

async function product(){
  const load=file=>import(new URL('../src/'+file,import.meta.url));
  const [db,store,pine,data,profile,worker,research,budget,migration,ledger,io,ticket,schema,source,config,pipeline,scheduler]=
    await Promise.all(['postgres/db.js','postgres/store.js','postgres/pine-bridge.js','postgres/quant-data.js',
      'postgres/quant-profile.js','postgres/quant-research-foundation.js','quant-research/research-dataset-store.js',
      'quant-research/storage-budget.js','postgres/quant-foundation-migration.js','postgres/quant-io-ledger.js',
      'postgres/quant-io-runtime.js','postgres/quant-profile-enrollment-ticket.js',
      'postgres/quant-profile-enrollment-migration.js','pine-bridge/source.js','config.js',
      'quant-research/profile-pipeline-v2.js','postgres/quant-foundation-scheduler.js'].map(load));
  return {PostgresDatabase:db.PostgresDatabase,Store:store.Store,PineBridgeService:pine.PineBridgeService,
    QuantDataService:data.QuantDataService,ingestionEngineHash:data.ingestionEngineHash,
    QuantProfileService:profile.QuantProfileService,QuantResearchFoundationWorker:worker.QuantResearchFoundationWorker,
    ResearchDatasetStore:research.ResearchDatasetStore,StorageBudget:budget.StorageBudget,
    migrateQuantFoundation:migration.migrateQuantFoundation,QuantIoLedger:ledger.QuantIoLedger,
    QuantIoRuntime:io.QuantIoRuntime,canReleaseQuantIo:io.canReleaseQuantIo,
    createProfileEnrollmentTicketAuthority:ticket.createProfileEnrollmentTicketAuthority,
    loadQuantProfileEnrollmentSchemaAssertion:schema.loadQuantProfileEnrollmentSchemaAssertion,
    canonical:source.canonical,hash:source.hash,config:config.config,buildProfileV2:pipeline.buildProfileV2,
    QuantFoundationScheduler:scheduler.QuantFoundationScheduler};
}

// Synthetic Paper fixture, the same shape as the PostgreSQL enrollment tests use. The settings keys are the ones the
// profile service accepts (quant-profile.js), spelling included.
function syntheticAnalysis({canonical,hash}){
  const bounds={emaFastInput:50,emaSlowInput:200,atrLenInput:14,stFactorInput:3.2,zoneAtrMultInput:1.15,
    setupExpiryInput:48,cooldownInput:8,confirmLookback:5};
  const values={...bounds,slAtrBufferInput:.6,minRiskATRInput:.5,preset:'Custom',tradeDirectionectionection:'Long + Exit',
    useSlowFilter:true,useMTF:false,useRSIFilter:false,requireBOS:false,requireSweep:false,slMode:'Zone + ATR',
    useSession:false,confirmMode:'Any',notifyEnabled:false};
  while(Object.keys(values).length<58)values['fixed_'+Object.keys(values).length]=false;
  const inputs=Object.entries(values).map(([pine_variable,effective_value],index)=>({input_id:'input_'+index,pine_variable,
    effective_value,type:typeof effective_value==='number'?(Number.isInteger(effective_value)?'int':'float'):
      typeof effective_value==='boolean'?'bool':'string',
    eligible:pine_variable in bounds,origin:'source',declared_domain:{min:null,max:null}}));
  const analysis={inputs,declarations:['buySignal','sellSignal'],effective_inputs_hash:hash(canonical(values))};
  analysis.effective_input_review={source_hash:hash(SOURCE),effective_inputs_hash:analysis.effective_inputs_hash,
    input_count:58,reviewed_by:'d6-synthetic',reviewed_at:1};
  return {analysis,selection:{signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'},bridge:{atr_multiplier:60,rr:1.5}}};
}

// Staging-shaped capacity policy with synthetic evidence hashes; the enrollment tests use the same values.
function capacityPolicy(sourceHash,settingsHash){
  const sha=letter=>letter.repeat(64);
  return {version:'quant-capacity-v2',environment:'staging',
    scope:{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',source_profile:'SPT_CUSTOM',
      execution_model:'paper-close-v1',source_hash:sourceHash,settings_hash:settingsHash,evaluator_hash:sha('c')},
    evidence:{calibration_sha256:sha('d'),parity_sha256:sha('e')},max_raw_bars:50000,max_chunk_bars:1000,
    budget:{candidates:1,max_evaluations:1,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576},
    io:{read_bytes:100000000,write_bytes:100000000,overshoot_read_bytes:1000000,overshoot_write_bytes:1000000,
      cleanup_read_bytes:2000000,cleanup_write_bytes:2000000},
    terminal:{version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000}};
}

function datasetStores(m,root){
  const storageBudget=new m.StorageBudget({root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
  // Windows has no directory fsync; the store only relaxes that check on win32. Linux keeps the strict path.
  return new m.ResearchDatasetStore({root,storageBudget,allowUnsupportedDirectorySyncForTests:process.platform==='win32'});
}

function apiServices(m,db,root,{sourceHash,policy,enrollmentTicketVerifier}){
  const store=new m.Store(db),pine=new m.PineBridgeService(store,{defaultRisk:m.config.defaultRisk});
  const researchStore=datasetStores(m,root);
  const data=new m.QuantDataService({pineService:pine,datasetStore:researchStore.raw,enabled:true});
  const profile=new m.QuantProfileService({pineService:pine,dataService:data,researchStore,enabled:true,
    supportedSourceHash:sourceHash,capacityPolicy:policy,profileV2Enabled:true,enrollmentEnabled:true,enrollmentTicketVerifier});
  return {store,pine,researchStore,data,profile};
}

const serial=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE'});
async function checkDatabase(db,target){
  const row=(await db.query(`SELECT current_database() name,host(inet_server_addr()) address,
    (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname<>ALL(ARRAY['pg_catalog','information_schema']) AND n.nspname NOT LIKE 'pg\\_toast%'
      AND n.nspname NOT LIKE 'pg\\_temp\\_%') relations,
    (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspname<>ALL(ARRAY['public','pg_catalog','information_schema'])
      AND nspname NOT LIKE 'pg\\_%') schemas`)).rows[0];
  if(row.name!==target.name)refuse('D6_DATABASE_IDENTITY_MISMATCH');
  if(target.connection==='loopback'?!['127.0.0.1','::1'].includes(row.address):row.address!==null)
    refuse('D6_DATABASE_IDENTITY_MISMATCH');
  if(row.relations!==0||row.schemas!==0)refuse('D6_DATABASE_NOT_EMPTY');
}

const timed=(probe,key,fn)=>async(...args)=>{
  const start=performance.now();
  try{return await fn(...args);}finally{probe[key]+=performance.now()-start;}
};

async function installFixture(m,db,root){
  const read=name=>fs.readFile(new URL('../src/postgres/'+name,import.meta.url),'utf8');
  await db.migrate();
  // The Pine Bridge and Quant research extensions, as their migration scripts install them on an empty database.
  await db.transaction(async()=>{
    await db.maintenanceLock();await db.verifySchema();
    await db.query(await read('pine-bridge-schema.sql'));await db.query(await read('quant-research-schema.sql'));
  });
  await m.migrateQuantFoundation(db,{mode:'FOUNDATION',storageRoot:root});
  const {canonical,hash}=m,sourceHash=hash(SOURCE),input=syntheticAnalysis(m);
  const policy=capacityPolicy(sourceHash,input.analysis.effective_inputs_hash);
  const probe={closure:0,schema:0,authority:0,lock:0,inBegin:false};
  const tickets=m.createProfileEnrollmentTicketAuthority({readExecutableHash:timed(probe,'closure',()=>m.ingestionEngineHash()),
    releaseGuard:()=>db.runtimeClient,isTransaction:()=>db.isTransaction});
  const {store,researchStore,data,profile}=apiServices(m,db,root,{sourceHash,policy,enrollmentTicketVerifier:tickets.assert});
  const now=Date.now(),owner=(await store.createUser({email:randomUUID()+'@example.test',passwordHash:'d6-fixture',role:'ADMIN'})).id;
  const risk={...structuredClone(m.config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,
    equities:{'binance-global':1000},balances:{'binance-global':1000}};
  await store.setRisk(owner,risk);
  const importId=randomUUID(),deploymentId=randomUUID();
  await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,owner,owner,1,sourceHash,
    'D6 synthetic fixture',SOURCE,JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,sourceHash,SOURCE,
    JSON.stringify(input.analysis),now);
  await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,owner,owner,1);
  const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
  const capital=await store.paperAccounts(owner);
  const funding=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(owner)).cutoff;
  const snapshot={source_hash:sourceHash,artifact_hash:hash('d6-fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},
    policy:risk,policy_hash:hash(canonical(risk)),capital,funding_cutoff:funding,membership:members,
    selection:{...input.selection,bindings:[],fixed_inputs:input.analysis.inputs}};
  const snapshotHash=hash(canonical(snapshot));
  await db.prepare("INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,'READY',?)").run(deploymentId,owner,owner,importId,1,
    JSON.stringify(snapshot),snapshotHash,now);
  const evidence={snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:sourceHash,compilation_errors:0,
    warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,
    duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,
    cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
    decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,
    execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,
      data_profile:'closed-ohlcv-atr14-v1'},
    references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
  await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,snapshotHash,JSON.stringify(evidence),
    hash(canonical(evidence)),now);
  // Synthetic closed 1m bars in place of the exchange: the harness never makes a network request.
  const fetchHistory=(range,{onPage}={})=>{
    const first=range.start_time-range.warmup_bars*MINUTE;
    onPage?.({start_time:first,end_time:range.end_time,count:(range.end_time-first)/MINUTE,sha256:hash('d6-page'),
      retrieved_at:Date.now(),source:'https://api.binance.com/api/v3/klines',timestamp_semantics:'UTC open time; end exclusive'});
    return (async function*(){for(let time=first;time<range.end_time;time+=MINUTE)
      yield {time,open:'100',high:'102',low:'99',close:'101',volume:'1'};})();
  };
  const worker=new m.QuantResearchFoundationWorker({service:{foundation:true,db,store,datasetStore:researchStore,executorMode:async()=>{}},
    dataService:data,profileService:profile,health:async()=>({ok:true}),fetchHistory,stopUnit:async()=>true,leaseMs:LEASE_MS,
    profileV2Enabled:true,capacityPolicy:policy,terminalLog:()=>{}});
  const cutoff=Math.floor(Date.now()/MINUTE)*MINUTE,end=cutoff-2*MINUTE;
  const raw=await db.transaction(()=>data.enqueue(owner,{bot_id:owner,start_time:end-20*MINUTE,end_time:end,warmup_bars:500,cutoff},
    randomUUID()));
  if(await worker.tick()!==true)throw failure('D6_FIXTURE_INGESTION_FAILED');
  // The production wiring binds tickets to the runtime maintenance lock and builds this authority object.
  await db.runtimeLock();
  const assertSchema=await m.loadQuantProfileEnrollmentSchemaAssertion();
  const enrollment=Object.freeze({enabled:true,tickets,assertSchemaLocked:timed(probe,'schema',assertSchema),
    authorizeLocked:timed(probe,'authority',(owner,contract,context)=>profile.authorizeEnrollmentLocked(owner,contract,context))});
  await profile.ready();
  const ledger=new m.QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],authorizeTerminal:async()=>({ok:false})});
  const io=new m.QuantIoRuntime({db,ledger,scheduler:worker.scheduler,
    launcher:{spawnPrepared(){throw failure('D6_NO_LAUNCH');}},enrollment});
  const body={bot_id:owner,raw_job_id:raw.job_id,deployment_id:deploymentId};
  const first=await serial(db,()=>profile.enqueueEnrollment(owner,body,randomUUID()));
  const contract=(await db.query('SELECT contract FROM quant_foundation_jobs WHERE job_id=$1',[first.job_id])).rows[0].contract;
  const result=await m.buildProfileV2({contract,policy,rawStore:researchStore.raw,researchStore,now:Date.now()});
  await worker.scheduler.cancel(owner,first.job_id);
  // Lock-wait probe: the BEGIN transaction's scheduler table lock statement, on this instance only.
  const query=db.query.bind(db);
  db.query=async(sql,params)=>{
    if(!probe.inBegin||typeof sql!=='string'||!sql.startsWith('LOCK TABLE quant_foundation_scheduler'))return query(sql,params);
    const start=performance.now();
    try{return await query(sql,params);}finally{probe.lock+=performance.now()-start;}
  };
  return {m,db,root,worker,profile,io,probe,policy,owner,body,sourceHash,result,resultHash:hash(canonical(result)),
    engineHash:contract.engine_hash,failures:{prepare:{},begin:{}},heartbeat:{started:0,errors:{}},strayQueued:0};
}
function reply(child,type,timeoutMs=BARRIER_MS){
  return new Promise((resolve,reject)=>{
    const done=(error,value)=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);
      if(error)reject(error);else resolve(value);};
    const onMessage=message=>{
      if(message?.type===type)done(null,message);
      else if(message?.type==='failed')done(failure('D6_CONTENDER_FAILED'));
    };
    const onExit=()=>done(failure('D6_CONTENDER_EXITED'));
    const timer=setTimeout(()=>done(failure('D6_CONTENDER_TIMEOUT')),timeoutMs);
    child.on('message',onMessage);child.on('exit',onExit);
  });
}

const pause=children=>Promise.all(children.map(child=>{const answer=reply(child,'paused');child.send({type:'pause'});return answer;}));
const resume=(children,target)=>{for(const child of children)child.send({type:'resume',target});};

async function startContenders(options,url,f,children){
  const init={url,root:f.root,owner:f.owner,body:f.body,policy:f.policy,sourceHash:f.sourceHash,holdMs:options['hold-ms'],
    thinkMs:options['think-ms'],vacuumIntervalMs:options['vacuum-interval-ms']};
  const ready=[];
  for(const role of ROLES)for(let index=0;index<options[role];index++){
    const child=fork(SCRIPT,['--contender',...(debug?['--debug']:[])],
      {stdio:['ignore','ignore',debug?'inherit':'ignore','ipc'],serialization:'json'});
    child.role=role;children.push(child);
    ready.push(reply(child,'ready'));child.send({type:'init',role,index,...init});
  }
  await Promise.all(ready);
}

async function stopContenders(children){
  return Promise.all(children.map(async child=>{
    if(child.stopRequested||child.exitCode!==null||!child.connected)return null;
    child.stopRequested=true;
    const answer=reply(child,'stopped',10000).catch(()=>null);
    try{child.send({type:'stop'});}catch{}
    const stats=await answer;
    if(!stats)child.kill();
    return stats;
  }));
}

async function release(f,job){
  const {db,worker,owner}=f;
  const status=async()=>(await db.query('SELECT status FROM quant_foundation_jobs WHERE job_id=$1',[job.job_id])).rows[0]?.status;
  if(await status()==='RUNNING')await worker.scheduler.cancel(owner,job.job_id);
  if(await status()==='STOPPING')await worker.scheduler.acknowledgeStopped(job.job_id,job.lease_token);
  if(await status()!=='CANCELLED')throw failure('D6_RELEASE_FAILED');
}

/** One marked job from claim to BEGIN. Contenders are paused on entry and on return. */
async function runSample(f,children,options){
  const {m,db,worker,profile,io,probe,owner,body}=f;
  // Only a decoy whose cancel failed three times can still be queued; cancel it so the claim takes this sample's job.
  const stray=(await db.query("SELECT job_id FROM quant_foundation_jobs WHERE status IN ('QUEUED','PAUSED')")).rows;
  for(const row of stray)await worker.scheduler.cancel(owner,row.job_id);
  f.strayQueued+=stray.length;
  const queued=await serial(db,()=>profile.enqueueEnrollment(owner,body,randomUUID()));
  const claimed=await worker.scheduler.claim('d6-measure');
  if(claimed?.job_id!==queued.job_id)throw failure('D6_CLAIM_MISMATCH');
  const job={job_id:claimed.job_id,lease_token:claimed.lease_token},operationId='d6-operation-'+randomUUID();
  const frame={jobId:job.job_id,operationId,payloadHash:m.hash('d6-payload:'+operationId),resultHash:f.resultHash,result:f.result};
  const sample={outcome:null,prepare:null,closure:null,drain:null,begin:null,lock:null,schema:null,authority:null};
  let heartbeatTask=null,interval=null;
  const beat=()=>{
    if(heartbeatTask)return;
    f.heartbeat.started++;
    heartbeatTask=worker.scheduler.heartbeat(job).catch(error=>tally(f.heartbeat.errors,safeCode(error)))
      .finally(()=>{heartbeatTask=null;});
  };
  const first=setTimeout(()=>{beat();interval=setInterval(beat,options['heartbeat-ms']);},
    Math.floor(Math.random()*options['heartbeat-ms']));
  const quiet=async()=>{clearTimeout(first);clearInterval(interval);await heartbeatTask;};
  resume(children,job.job_id);
  try{
    if(options['settle-ms'])await sleep(options['settle-ms']);
    // The runtime reads the job row after the accepted frame and hands it to prepare.
    const row=(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[job.job_id])).rows[0];
    Object.assign(probe,{closure:0,schema:0,authority:0,lock:0});
    let attempt=null;
    const prepareStart=performance.now();
    try{attempt=await io.prepareEnrollment({job:row,frame,leaseToken:job.lease_token,operationId});}
    catch(error){tally(f.failures.prepare,safeCode(error));sample.outcome='PREPARE_FAILED';}
    const prepareEnd=performance.now();
    // beforeTerminal: the worker stops its heartbeat timer and waits for a heartbeat in flight.
    await quiet();
    const beginStart=performance.now();
    Object.assign(sample,{prepare:prepareEnd-prepareStart,closure:probe.closure,drain:beginStart-prepareEnd});
    if(attempt){
      probe.inBegin=true;
      try{
        await worker.scheduler.beginProfileCompletion({job_id:job.job_id,lease_token:job.lease_token,attempt});
        sample.outcome='COMPLETED';
      }catch(error){tally(f.failures.begin,safeCode(error));sample.outcome='BEGIN_FAILED';}
      finally{probe.inBegin=false;}
      Object.assign(sample,{begin:performance.now()-beginStart,lock:probe.lock,schema:probe.schema,authority:probe.authority});
    }
  }finally{
    await quiet();
    await pause(children);
    await release(f,job);
  }
  return sample;
}

function summary(values){
  if(!values.length)return {count:0};
  const sorted=[...values].sort((a,b)=>a-b);
  const at=p=>sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(p/100*sorted.length)-1))];
  return {count:sorted.length,min:round(sorted[0]),p50:round(at(50)),p95:round(at(95)),p99:round(at(99)),
    max:round(sorted.at(-1)),mean:round(sorted.reduce((sum,value)=>sum+value,0)/sorted.length)};
}

async function harnessHash(){
  // Line endings normalized to LF, so a Windows checkout reports the same hash as the Git blob and a Linux checkout.
  const text=(await fs.readFile(SCRIPT,'utf8')).replaceAll('\r\n','\n');
  return createHash('sha256').update(text).digest('hex');
}

async function environmentFacts(db,target){
  const settings=Object.fromEntries((await db.query(
    'SELECT name,setting,unit FROM pg_catalog.pg_settings WHERE name=ANY($1::text[]) ORDER BY name',[PG_SETTINGS])).rows
    .map(row=>[row.name,row.unit?row.setting+' '+row.unit:row.setting]));
  const cpus=os.cpus();
  return {platform:process.platform,arch:process.arch,os_release:os.release(),node:process.version,
    cpu_count:os.availableParallelism(),cpu_model:cpus[0]?.model?.trim()??null,total_memory_mb:Math.round(os.totalmem()/1048576),
    load_average_1m:process.platform==='win32'?null:round(os.loadavg()[0]),database_connection:target.connection,
    directory_sync_relaxed:process.platform==='win32',postgres:settings};
}
async function measure(options,url,target){
  const startedAt=new Date(),started=performance.now(),deadline=started+options['max-seconds']*1000;
  const children=[];
  const watchdog=setTimeout(()=>{
    for(const child of children)child.kill();
    process.stderr.write(JSON.stringify({error:'D6_WATCHDOG'})+'\n');process.exit(3);
  },options['max-seconds']*1000+WATCHDOG_GRACE_MS);
  watchdog.unref();
  const m=await product();
  const db=new m.PostgresDatabase({connectionString:url,max:POOL_MAX});
  let root=null;
  try{
    await checkDatabase(db,target);
    const environment=await environmentFacts(db,target);
    root=await fs.mkdtemp(path.join(os.tmpdir(),'d6-harness-'));
    const f=await installFixture(m,db,root);
    await startContenders(options,url,f,children);
    await pause(children);
    const samples=[],total=options.warmup+options.samples;
    let stoppedBy='samples';
    for(let index=0;index<total;index++){
      if(performance.now()>=deadline){stoppedBy='time-cap';break;}
      const sample=await runSample(f,children,options);
      sample.warmup=index<options.warmup;samples.push(sample);
    }
    const contention=await stopContenders(children);
    const measured=samples.filter(sample=>!sample.warmup),completed=measured.filter(sample=>sample.outcome==='COMPLETED');
    const prepared=measured.filter(sample=>sample.outcome!=='PREPARE_FAILED');
    const values=(list,key)=>list.map(sample=>sample[key]);
    const byRole={};
    for(const role of ROLES)if(options[role])byRole[role]={processes:options[role],reported:0,ops:0,errors:{}};
    for(const stats of contention){
      if(!stats)continue;
      const entry=byRole[stats.role];entry.reported++;entry.ops+=stats.ops;
      for(const [code,count] of Object.entries(stats.errors))entry.errors[code]=(entry.errors[code]??0)+count;
    }
    return {report:REPORT_VERSION,evidence_class:options['evidence-class'],
      note:'Measurement only. D6 acceptance and the marked reserve are root decisions.',
      harness:{name:'measure-d6-prepare-begin',sha256:await harnessHash(),line_endings:'normalized-lf'},
      product:{ingestion_engine_hash:f.engineHash},
      started_at:startedAt.toISOString(),duration_ms:Math.round(performance.now()-started),units:'ms',
      percentile_method:'nearest-rank',environment,
      settings:{...options,pool_max:POOL_MAX,contender_pool_max:CONTENDER_POOL_MAX,lease_ms:LEASE_MS,raw_bars:520,
        heartbeat_phase:'random'},
      samples:{requested:options.samples,warmup:Math.min(options.warmup,samples.length),measured:measured.length,
        completed:completed.length,prepare_failed:measured.length-prepared.length,
        begin_failed:prepared.length-completed.length,stopped_by:stoppedBy,stray_queued_cancelled:f.strayQueued},
      phases:{
        prepare:summary(values(prepared,'prepare')),
        prepare_closure_hash:summary(values(prepared,'closure')),
        heartbeat_drain:summary(values(prepared,'drain')),
        begin:summary(values(completed,'begin')),
        begin_lock_wait:summary(values(completed,'lock')),
        begin_schema_assert:summary(values(completed,'schema')),
        begin_authority:summary(values(completed,'authority')),
        begin_failed:summary(values(prepared.filter(sample=>sample.outcome==='BEGIN_FAILED'),'begin')),
        combined:summary(completed.map(sample=>sample.prepare+sample.begin)),
        combined_with_drain:summary(completed.map(sample=>sample.prepare+sample.drain+sample.begin))},
      failures:f.failures,
      serialization:{failures:f.failures.begin['40001']??0,retries:0,
        retry_policy:'none: beginProfileCompletion does not retry; the marked job then takes the diagnostic path'},
      heartbeat:f.heartbeat,contention:byRole};
  }finally{
    await stopContenders(children);
    await db.close().catch(()=>{});
    if(root)await fs.rm(root,{recursive:true,force:true}).catch(()=>{});
    clearTimeout(watchdog);
  }
}

async function contenderOperation(m,db,init,count){
  if(init.role==='hash')return ()=>m.ingestionEngineHash();
  if(init.role==='vacuum')return async()=>{
    await db.query('VACUUM (ANALYZE) quant_foundation_jobs');await db.query('VACUUM (ANALYZE) quant_foundation_scheduler');
  };
  const {profile}=apiServices(m,db,init.root,init);
  await profile.ready();
  const hold=async()=>{if(init.holdMs)await db.query('SELECT pg_sleep($1)',[init.holdMs/1000]);};
  if(init.role==='read')return target=>serial(db,async()=>{await profile.get(init.owner,target,false);await hold();});
  if(init.role==='cancel')return async()=>{
    const decoy=await serial(db,()=>profile.enqueueEnrollment(init.owner,init.body,randomUUID()));
    // A decoy must not stay queued: the measuring process claims the oldest queued job between samples.
    for(let attempt=1;;attempt++){
      try{await serial(db,async()=>{await profile.get(init.owner,decoy.job_id,true);await hold();});return;}
      catch(error){if(attempt>=3)throw error;count(error);}
    }
  };
  const scheduler=new m.QuantFoundationScheduler({db,capacityPolicy:init.policy,profileV2Enabled:true,leaseMs:LEASE_MS,
    authorize:(owner,request,action,context)=>profile.authorize(owner,request,action,context),health:async()=>({ok:true}),
    canRelease:row=>m.canReleaseQuantIo(db,row)});
  return async()=>{
    const claimed=await scheduler.claim('d6-contender-'+init.index);
    if(claimed){
      await scheduler.cancel(claimed.owner_id,claimed.job_id);await scheduler.acknowledgeStopped(claimed.job_id,claimed.lease_token);
      throw failure('D6_UNEXPECTED_CLAIM');
    }
  };
}

async function contender(){
  if(typeof process.send!=='function')refuse('D6_USAGE');
  process.on('disconnect',()=>process.exit(0));
  const init=await new Promise(resolve=>process.once('message',resolve));
  const m=await product();
  const db=new m.PostgresDatabase({connectionString:init.url,max:CONTENDER_POOL_MAX});
  const stats={ops:0,errors:{}},count=error=>tally(stats.errors,safeCode(error));
  let operation;
  try{operation=await contenderOperation(m,db,init,count);}
  catch(error){
    if(debug)process.stderr.write(String(error?.stack??error)+'\n');
    process.send({type:'failed',code:safeCode(error)});await db.close().catch(()=>{});process.exit(1);
  }
  let running=false,stopping=false,busy=false,waiter=null,target=null;
  const wake=()=>{const resolve=waiter;waiter=null;resolve?.();};
  process.on('message',message=>{
    if(message?.type==='resume'){target=message.target;running=true;wake();}
    else if(message?.type==='pause'){running=false;if(!busy)process.send({type:'paused'});wake();}
    else if(message?.type==='stop'){running=false;stopping=true;wake();}
  });
  process.send({type:'ready'});
  while(!stopping){
    if(!running){await new Promise(resolve=>{waiter=resolve;});continue;}
    busy=true;
    try{await operation(target);stats.ops++;}catch(error){count(error);}
    busy=false;
    if(!running){if(!stopping)process.send({type:'paused'});continue;}
    const rest=init.role==='vacuum'?init.vacuumIntervalMs:init.thinkMs;
    if(rest)await new Promise(resolve=>{
      const timer=setTimeout(()=>{waiter=null;resolve();},rest);
      waiter=()=>{clearTimeout(timer);resolve();};
    });
  }
  await db.close().catch(()=>{});
  process.send({type:'stopped',role:init.role,ops:stats.ops,errors:stats.errors},()=>process.exit(0));
}

const finish=(stream,text,code)=>stream.write(text+'\n',()=>process.exit(code));
// Product modules may log; only the report reaches standard output.
if(!debug)for(const method of ['log','info','warn','debug'])console[method]=()=>{};
if(process.argv[2]==='--contender'){
  contender().catch(error=>{if(debug)process.stderr.write(String(error?.stack??error)+'\n');process.exit(1);});
}else{
  try{
    const {options,url,target}=parseOptions(process.argv.slice(2),process.env);
    if(process.env.PAPER_TRADING!==undefined&&process.env.PAPER_TRADING!=='true')refuse('D6_PAPER_TRADING_REQUIRED');
    for(const key of SCRUBBED_ENV)delete process.env[key];
    const report=await measure(options,url,target);
    finish(process.stdout,JSON.stringify(report,null,1),0);
  }catch(error){
    if(debug)process.stderr.write(String(error?.stack??error)+'\n');
    const refused=error instanceof Refusal;
    finish(process.stderr,JSON.stringify(refused?{error:error.code}:{error:'D6_FAILED',code:safeCode(error)}),refused?2:1);
  }
}