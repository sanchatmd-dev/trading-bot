import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from './test-role-password.mjs';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {migrateBestInputsPackage} from '../../src/postgres/best-inputs-package-migration.js';
import {migrateQuantSelection} from '../../src/postgres/quant-selection-migration.js';
import {registerSelection} from '../../src/postgres/selection-store.js';
import {readSelectionInputs} from '../../src/postgres/selection-inputs.js';
import {OBJECTIVE_REGISTRY} from '../../src/selection/index.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {PACKAGE_FILES} from '../../src/quant-library/package-gates.js';
import {contractOf,outcomeOf,seedRun,hex,T0,MINUTE,FIXTURE_LABEL} from './quant-library-fixture.mjs';

/**
 * LABELLED TEST FIXTURES for the QR-4 selection inputs reader and owner API (slice Q4-B). Everything here is synthetic. The helper builds a throwaway
 * PostgreSQL world (base schema, Pine Bridge, research, exposure register, Best Inputs package and selection extensions, the holdout boundary table), runs the repository
 * runtime grants for a non-owner LOGIN role, and seeds research runs with the rows the reader reads: the run and its checkpoints, the source, membership and deployment
 * of the Bot, the market bars of the package dataset and a validated one-Pine export with its validation record. The registration helper uses the store writer with an
 * INJECTED test registry and injected dependencies: that is a store-level test path only; a route never passes either (RC-S11, RR-Q4-2).
 * Nothing in this file uses fixed-evaluation modules.
 */
export const MS=60000,DAY=86400000;
export const BASE=Math.floor(Date.now()/MS)*MS;
export const OBJECTIVE_ID='qr4-objective-lexi-v1';
export const ENGINE=hex('qr4-engine');
export const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
export const UTC=new Date(T0).toISOString();
export const TOTAL=20,WARMUP=4;
/** The policy object stored in every fixture contract (contractOf) and its hash: the Bot policy hash and the contract snapshot hash are this value. */
export const POLICY_HASH=hash(canonical(contractOf({owner:'x',deployment:'d',importId:'i'}).snapshot.policy));
export const POLICY_VERSION='risk-v1';
/** OD-S3: the product registry holds null tie tolerances; a store-level test injects this TEST registry. */
export const TEST_REGISTRY=(()=>{const registry=structuredClone(OBJECTIVE_REGISTRY);registry[OBJECTIVE_ID].tie_tolerances.return_pp='0.5';registry[OBJECTIVE_ID].tie_tolerances.drawdown_pp='0.5';return registry;})();
/** The scope an owner declares for the fixture contracts (the decimal strings of the fixed evaluation comparison). valuation and engine are server fields. */
export const SCOPE=Object.freeze({market:structuredClone(MARKET),data_model:{data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001'},
  cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1',risk_percent:'1'},capital:{equity:'1000',cash:'1000'},policy:{policy_version:POLICY_VERSION,policy_hash:POLICY_HASH}});
export const FILTERS=Object.freeze({drawdown_limit_percent:'20',episode_floor:5,beats_buy_and_hold:false});
export const readBotState=async()=>({policy_hash:POLICY_HASH});

export const sha=value=>createHash('sha256').update(value).digest('hex');
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantScript=async role=>(await fs.readFile(fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url)),'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const EXPORT_SQL=`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;
const GATE_RESULTS=['C1','C2','C3','C4'].map(gate=>({gate,state:'PASS',pass:true,codes:[]}));

/** The throwaway world. options.boundaries: install the holdout boundary table (PF-2 R3). Returns handles and the seeding functions. */
export async function createQr4World({boundaries=true}={}){
  if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL is required; isolated PostgreSQL only');
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-',''),templateName='robot_q4_tpl_'+suffix,databaseName='robot_q4_main_'+suffix,roleName='robot_q4_rt_'+suffix.slice(0,14);
  const pools=[];
  const track=pool=>{pools.push(pool);return pool;};
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
    await migrateQuantExposureRegister(builder);await migrateBestInputsPackage(builder);await migrateQuantSelection(builder);
    if(boundaries){
      // The boundary table of the preflight extension (the table and its write-once trigger only), the way the package build suite installs it.
      const body=await sqlText('quant-preflight-schema.sql'),start=body.indexOf('CREATE TABLE quant_holdout_boundaries('),marker='EXECUTE FUNCTION quant_holdout_boundary_write_once();';
      const end=body.indexOf(marker);
      if(start<0||end<0)throw new Error('the boundary table text moved');
      const functionStart=body.indexOf('CREATE FUNCTION quant_holdout_boundary_write_once');
      await builder.transaction(async()=>builder.query((functionStart>=0&&functionStart<start?body.slice(functionStart,start):'')+body.slice(start,end+marker.length)));
    }
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  const db=track(new PostgresDatabase({connectionString:serialOf(databaseName),max:8}));
  const store=new Store(db);
  await db.query(await grantScript(roleName));
  if(boundaries)await db.query('GRANT SELECT ON public.quant_holdout_boundaries TO '+roleName);
  const rt=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,roleName),max:8})));
  const rtStore=new Store(rt);
  const world={admin,db,rt,store,rtStore,connectionString:urlOf(databaseName),databaseName,roleName};
  world.track=track;
  world.close=async()=>{
    for(const pool of pools)await pool.close().catch(()=>{});
    for(const name of [databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
    await admin.close();
  };
  return world;
}

/** The market bars of the package dataset: TOTAL one-minute bars from T0 (shared by every fixture run; the table has no owner). Returns the dataset digest the binding names. */
export async function seedBars(world){
  const rows=[];
  for(let index=0;index<TOTAL;index++){
    const time=T0+index*MINUTE,bar={time,open:'100',high:'101',low:'99',close:'100.5',volume:'1'},provenance={source:'LABELLED TEST FIXTURE'};
    rows.push({bar_time:time,bar,provenance,content_hash:hash(canonical(bar))});
    await world.db.query(`INSERT INTO public.pine_market_bars(broker,symbol,timeframe,bar_time,bar,provenance,content_hash) VALUES('binance-global','BTCUSDT','1',$1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [time,JSON.stringify(bar),JSON.stringify(provenance),hash(canonical(bar))]);
  }
  return hash(canonical(rows.map(item=>({bar:item.bar,content_hash:item.content_hash,provenance:item.provenance}))));
}

export async function newOwner(world,label){
  const user=await world.store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  return {id:user.id};
}

/**
 * One research run of the owner with its Bot rows (source, revision, membership, deployment) and, optionally, a validated one-Pine export.
 * options: tag, status/scenario (default SUCCEEDED/PENDING), labelled (the source names a fixture), packageOptions: false | {fixture, finish, mode, policyHash, mutateBinding}.
 * The export rows follow the documented path (blobs, export, files, seq 1 event, passing attempt, validation, seq 2).
 */
export async function seedRunWithPackage(world,owner,{tag=randomUUID().slice(0,8),scenario='PENDING',labelled=false,digest,start=T0,package:pack={},mutateContract=null,badContractHash=false,status:statusOverride=null}={}){
  const importId=randomUUID(),deployment=randomUUID(),sourceHash=hex('source:'+tag);
  // A package needs a Bot with exactly one connected Pine (the freshness rule compares the memberships), so a run with a package gets its own Bot user.
  const wantsPackage=pack!==false&&pack!==null;
  const bot=wantsPackage?(await world.store.createUser({email:'bot-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'})).id:owner.id;
  const contract=contractOf({version:'v1',owner:owner.id,bot,deployment,importId,tag,total:TOTAL,warmup:WARMUP,start,sourceHash,policyHash:POLICY_HASH});
  if(labelled)contract.source+='\n// LABELLED SYNTHETIC FIXTURE';
  // The package guard accepts only a fixture export for an engineering-scope run, so a non-fixture package needs another scope name.
  if(wantsPackage&&pack.fixture===false)contract.scope='SPT_CUSTOMER_FIXTURE_SCOPE';
  if(mutateContract)mutateContract(contract);
  const outcome=outcomeOf(contract,scenario,{at:T0+7_200_000});
  const run={run_id:'run-'+randomUUID(),status:statusOverride??outcome.status,created_at:T0+7_200_000+Number(BigInt('0x'+sha(tag).slice(0,6))%1000n),updated_at:T0+7_320_000,contract,contract_hash:badContractHash?hex('wrong-contract-hash'):hash(canonical(contract)),
    result:outcome.result,steps:outcome.steps,diagnostic:null,phase:'COMPLETE'};
  await world.db.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[importId,owner.id,bot,sourceHash,'Q4 fixture','//@version=6\nindicator("x")','{}',T0]);
  await world.db.query('INSERT INTO pine_source_revisions(pine_import_id,source_version,source_hash,source,analysis,created_at) VALUES($1,1,$2,$3,$4,$5)',[importId,sourceHash,'//@version=6\nindicator("x")','{}',T0]);
  await world.db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[importId,owner.id,bot]);
  await world.db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$7,$3,1,$4,$5,'READY',$6)",
    [deployment,owner.id,importId,JSON.stringify({marker:'q4-fixture'}),contract.baseline_snapshot_hash,T0,bot]);
  await seedRun(world.db,run,{owner:owner.id,deployment,bot});
  const out={runId:run.run_id,run,importId,deployment,sourceHash,botId:bot,export:null};
  if(pack!==false&&pack!==null){
    const dataset=digest??await seedBars(world);
    out.export=await seedExport(world,owner,out,{dataset,...pack});
  }
  return out;
}

export async function seedExport(world,owner,seeded,{fixture=true,finish='EXPORT_VALIDATED',mode='ONE_PINE',dataset,policyHash=POLICY_HASH,mutateBinding=null,validationFixture=null,validationGates=GATE_RESULTS}={}){
  const files=Object.fromEntries(PACKAGE_FILES.map(file=>[file,Buffer.from(FIXTURE_LABEL+'\n'+seeded.runId+'\n'+file+'\n')]));
  const exportId=randomUUID(),packageHash=sha(files['quant-data/manifest.json']),bindingHash=hex('binding:'+exportId);
  const binding={mode,fixture,owner_id:owner.id,bot_id:seeded.botId,run_id:seeded.runId,created_at:UTC,pine_import_id:seeded.importId,source_version:1,source_hash:seeded.sourceHash,
    membership:[{pine_import_id:seeded.importId,source_version:1,source_hash:seeded.sourceHash}],policy_version:POLICY_VERSION,policy_hash:policyHash,deployment_id:seeded.deployment,
    input_lock_hash:hex('lock:'+seeded.runId),dataset_ref:{sha256:dataset}};
  if(mutateBinding)mutateBinding(binding);
  await world.db.transaction(async()=>{
    for(const bytes of Object.values(files))await world.db.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(bytes),bytes.length,bytes]);
    await world.db.query(EXPORT_SQL,[exportId,owner.id,seeded.botId,seeded.runId,null,mode,mode==='MULTI_PINE',fixture,'best-inputs-gates-v1',JSON.stringify({label:FIXTURE_LABEL}),JSON.stringify(binding),
      bindingHash,packageHash,JSON.stringify({gate:'B0',state:'PASS',codes:[]}),T0,UTC]);
    for(const [file,bytes] of Object.entries(files))await world.db.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[exportId,file,sha(bytes),bytes.length]);
    await world.db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,'EXPORT_CANDIDATE','{}',NULL,$2,$3)",[exportId,T0+1,UTC]);
  },{isolation:'SERIALIZABLE'});
  if(finish!=='EXPORT_CANDIDATE'){
    const attemptId='att-'+randomUUID(),pass=finish!=='EXPORT_REFUSED',codes=pass?[]:['BI_NATIVE_SIGNAL_PARITY_FAILED'];
    await world.db.query(`INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc)
      VALUES($1,1,$2,$3,$4,$5,$6,'{}',$7,$8,$9)`,[exportId,attemptId,packageHash,pass,codes,JSON.stringify(GATE_RESULTS),hex('validator'),T0+2,UTC]);
    if(finish==='EXPORT_VALIDATED')await world.db.query(`INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[exportId,packageHash,bindingHash,attemptId,JSON.stringify(validationGates),hex('validator'),validationFixture??fixture,T0+3,UTC]);
    await world.db.query('INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,$2,$3,1,$4,$5)',[exportId,finish,codes,T0+4,UTC]);
  }
  return {exportId,packageHash,bindingHash,binding};
}

/** n runs with a validated export each. */
export async function seedSet(world,owner,{n=3,fixture=true,labelled=fixture}={}){
  const digest=await seedBars(world),runs=[];
  for(let i=0;i<n;i++)runs.push(await seedRunWithPackage(world,owner,{tag:'s'+i+'-'+randomUUID().slice(0,6),labelled,digest,package:{fixture}}));
  return runs;
}

/** The request the store registers: W opens startDays days after BASE, so a different startDays gives a different registration key. */
export const requestOf=(owner,{startDays=10,fixture=true,over={}}={})=>({owner_id:owner.id,confirmed:true,fixture,
  scope:{...structuredClone(SCOPE),valuation:{valuation:'qr3-valuation-std-v1',benchmark:'qr3-bh-close-same-cost-v1'},engine:ENGINE},
  window:{kind:'PROSPECTIVE',start_ms:BASE+startDays*DAY,end_ms:BASE+startDays*DAY+1000*MS,warmup_bars:200},objective:{id:OBJECTIVE_ID},filters:structuredClone(FILTERS),
  admission_deadline_ms:BASE+startDays*DAY+1000*MS+DAY,...over});
/** Every dependency fact true and the TEST registry: a store-level test context. */
export const testContext=(owner,over={})=>({dependencies:{qr3_context:true,evaluation_mode:true,episode_gate_version:'ql4-episode-gate-v1'},requester_owner_id:owner.id,
  objective_registry:TEST_REGISTRY,fixture_selections_allowed:true,...over});

/** Registers a selection through the store writer with the REAL inputs reader (injected registry and dependencies: store-level only). */
export function registerViaStore(world,owner,{startDays=10,fixture=true,over={},context={},ports={}}={}){
  return registerSelection(world.rt,{request:requestOf(owner,{startDays,fixture,over}),context:testContext(owner,context),
    readInputs:(tx,args)=>readSelectionInputs(tx,{...args,fixture,policy_hash:POLICY_HASH},{readBotState,...ports})});
}

/**
 * The quant_jobs row of one selection evaluation run (SB203 item 8: inserted BEFORE the evaluation start row, so a fixture stays valid when the start table links to quant_jobs).
 * mode FIXED_INPUT_EVAL, purpose QR4_SELECTION, and no top-level source_hash, so the universe read and readSearchedWindows keep excluding it. The parent is a seeded run (seedRunWithPackage result).
 */
export async function seedEvaluationJob(world,owner,parent,evaluationRunId,{status='SUCCEEDED'}={}){
  const contract={mode:'FIXED_INPUT_EVAL',purpose:'QR4_SELECTION',parent_run_id:parent.runId,snapshot:{market:structuredClone(MARKET)},label:FIXTURE_LABEL};
  await world.db.query(`INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,[evaluationRunId,owner.id,parent.botId,parent.deployment,'idem-'+evaluationRunId,hex('s:'+evaluationRunId),hash(canonical(contract)),JSON.stringify(contract),status,T0+9_000_000,T0+9_900_000]);
  return evaluationRunId;
}

export const SELECTION_TABLES=['quant_selection_registrations','quant_selection_universe','quant_selection_participants','quant_selection_status_events','quant_selection_window_freezes',
  'quant_selection_evaluation_starts','quant_selection_outcomes','quant_selection_replay_events'];
export const counts=async target=>Object.fromEntries(await Promise.all(SELECTION_TABLES.map(async table=>[table,(await target.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
/** A digest and row count of a table, for "unchanged" assertions. */
export async function tableDigest(target,table){
  const row=(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
  return {n:row.n,d:row.d};
}
