import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {inspectMpRunStore,migrateMpRunStore} from '../../src/postgres/mp-run-store-migration.js';
import {storeBotState} from '../../src/postgres/mp-member-set-store.js';
import {appendRunEvent,getMultiRun} from '../../src/postgres/mp-run-store.js';
import {canonical,hash,inspectSource,validateSelection} from '../../src/pine-bridge/source.js';
import {assemble} from '../../src/pine-bridge/template.js';
import {MultiPineFixtureService,effectiveInputsHash} from '../../src/multi-pine/fixture-service.js';
import {SPT_CUSTOM_SETTINGS,SPT_SIGNAL_MAPPING} from '../../src/multi-pine/member-admission.js';
import {MultiPineFixtureExecutor,EXECUTOR_RESULT_VERSION,STEP_VERSION,JOB_CODES,validateTerminalResult} from '../../src/multi-pine/executor.js';
import {createPythonRunner} from '../../src/multi-pine/python-runner.js';
import {mpCombinedEngineHash,MP_COMBINED_CLOSURE_VERSION} from '../../src/multi-pine/engine-closure.js';
import {MP_CODES} from '../../src/multi-pine/codes.js';
import {config} from '../../src/config.js';
import {D} from '../../src/money.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {QuantResearchService} from '../../src/postgres/quant-research.js';
import {activateDeployment} from '../../src/postgres/pine-bridge-readiness.js';
import {prepareBridgeExecution} from '../../src/postgres/pine-bridge-execution.js';
import {executionPrice} from '../../src/pine-bridge/contract.js';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';

/*
 * F11 S3: the multi-Pine fixture executor (src/multi-pine/executor.js) on a throwaway PostgreSQL cluster, FIXTURE-role connection (RD-MP-32).
 *
 * REAL versus STUB (reported in the evidence packet):
 *  - "real job" cases run the REAL Python module robot_quant.mp_combined_job in a real child process (src/multi-pine/python-runner.js) on the committed 6,000 synthetic
 *    bars (test/fixtures/mp-combined), through the real executor, run store, member set and Node oracle. The ONE thing replaced is the private source gate: the owner's
 *    reviewed SPT source (hash 0be2c64c...) is not in the repository, so `validate_custom_snapshot` is replaced in the child by a function that returns the fixture
 *    CustomSignalInputs of the member (M1, M2 or M2_ZERO of the fixture manifest). The membership projection, the slot check, the frame checks, the signal
 *    evaluation (the real SPT Custom evaluator), the combined ledger, the diagnostics and the response framing all run unchanged.
 *  - "stub" cases use a Node test double for runEvaluator (canned or perturbed step responses) where a case needs a defect, a delay or a size that the real job
 *    never produces. The double is named in the case.
 * Every row is a LABELLED FIXTURE (fixture=true, synthetic). Rows are insert-only, so each case that commits uses its own owner.
 */
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const FIXTURES=new URL('../fixtures/mp-combined/',import.meta.url);
const GRANT_SCRIPT=new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url);
const FIXTURE_SCRIPT=new URL('../../scripts/grant-postgres-mp-fixture.sql',import.meta.url);
const MANIFEST=JSON.parse(await fs.readFile(new URL('manifest.json',FIXTURES),'utf8'));
const BARS=JSON.parse(await fs.readFile(new URL('bars-v1.json',FIXTURES),'utf8'));
const T0=1790000000000;
let admin,db,fx,fx2,connectionString,templateName,databaseName,runtimeName,fixtureName,store,service,ENGINE;
const databases=[],pools=[],extraRoles=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const serialOf=(name,user)=>{const url=new URL(urlOf(name,user));url.searchParams.set('options','-c default_transaction_isolation=serializable');return url.toString();};
const ser=pool=>{const original=pool.transaction.bind(pool);pool.transaction=(fn,options={})=>original(fn,{isolation:'SERIALIZABLE',...options});return pool;};
const track=pool=>{pools.push(pool);return pool;};
const sqlText=name=>fs.readFile(new URL(name,sourceDir),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const roleScript=async(file,roles)=>{let body=await fs.readFile(file,'utf8');for(const [variable,value] of Object.entries(roles))body=body.replaceAll(":'"+variable+"'","'"+value+"'");return body;};

/* ---- the fixture dataset: the committed 6,000 bars, stored as verified market rows ---- */
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:10,slippage_bps:1,risk_percent:0.05,data_profile:'closed-ohlcv-atr14-v1'};
const POLICY={paperTrading:true,requireReduceOnlySell:true,...MANIFEST.policy};
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const SOURCE='//@version=6\nindicator("mp executor fixture")\nbuySignal = ta.crossover(close, ta.sma(close, 20))\nsellSignal = ta.crossunder(close, ta.sma(close, 20))\nplot(close)\n';
const SUPPORTED=hash(SOURCE);
const START=BARS.first_time,BAR_COUNT=BARS.bar_count,END=START+(BAR_COUNT-1)*60000,NOW=END+3600000;
const DATASET={start_time:START,end_time:END,warmup_bars:MANIFEST.split.warmup};
const DOMAINS={atr_multiplier:{min:'1',max:'3',step:'0.5'},rr:{min:'0.5',max:'2.5',step:'0.5'}};
const barRow=(bar,source=BARS)=>({time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,atr14:bar.atr14,price_tick:source.price_tick,quantity_step:source.quantity_step});
const PROVENANCE={profile:MODEL.data_profile,source:BARS.provenance.source,fixture:true};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  ENGINE=await mpCombinedEngineHash();
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_ex_tpl_'+suffix;databaseName='robot_ex_main_'+suffix;
  runtimeName='robot_ex_rt_'+suffix.slice(0,14);fixtureName='robot_ex_fx_'+suffix.slice(0,14);
  for(const name of [runtimeName,fixtureName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  extraRoles.push(runtimeName,fixtureName);
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    await install(builder,'pine-bridge-schema.sql');
    await install(builder,'quant-research-schema.sql');
    await migrateMpMemberSet(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName),max:8})));
  store=new Store(db);
  await migrateMpRunStore(db);
  await db.query(await roleScript(GRANT_SCRIPT,{runtime_role:runtimeName}));
  await db.query(await roleScript(FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  fx=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:8})));
  fx2=ser(track(new PostgresDatabase({connectionString:serialOf(databaseName,fixtureName),max:8})));
  const report=await inspectMpRunStore(db,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(report.ok,true,report.failures?.join());
  service=serviceOn(fx);
  // the verified bars of the dataset, as the market-data writer stores them: bar, provenance and the content hash of the bar
  const rows=BARS.bars.map(bar=>barRow(bar));
  await db.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,b::jsonb,$4::jsonb,h FROM unnest($1::bigint[],$2::text[],$3::text[]) AS u(t,b,h)`,
    [rows.map(row=>row.time),rows.map(row=>JSON.stringify(row)),rows.map(row=>hash(canonical(row))),JSON.stringify(PROVENANCE)]);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of extraRoles)await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- worlds: one owner (= Bot) with COUNT connected members, the supported source, different reviewed inputs ---- */

const evidenceFor=(snapshot,snapshotHash,tag,model=MODEL)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(model),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});
/** The reviewed analysis of a member: 58 effective inputs; emaFast and emaSlow follow the fixture member so the admission warm-up floor equals the fixture's (1250). */
function analysisFor(inputs){
  const list=Object.entries(SPT_CUSTOM_SETTINGS).map(([name,value])=>({pine_variable:name,type:typeof value==='boolean'?'bool':'string',effective_value:value}));
  list.push({pine_variable:'emaFastInput',type:'int',effective_value:inputs.emaFastInput},{pine_variable:'emaSlowInput',type:'int',effective_value:inputs.emaSlowInput});
  list.push({pine_variable:'minRiskATRInput',type:'float',effective_value:inputs.minRiskATRInput});
  for(let i=list.length;i<58;i++)list.push({pine_variable:'fixtureInput'+i,type:'int',effective_value:i});
  list.forEach((input,i)=>Object.assign(input,{input_id:'in-'+i,eligible:true,declared_domain:{min:null,max:null}}));
  const effective_inputs_hash=effectiveInputsHash({inputs:list});
  return {inputs:list,declarations:['buySignal','sellSignal'],effective_inputs_hash,
    effective_input_review:{source_hash:SUPPORTED,effective_inputs_hash,input_count:58,reviewed_by:'fixture-reviewer',reviewed_at:1700000000000}};
}
const JOB_SQL=`INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,result)
  VALUES($1,$2,$3,'generate',$4,$5,'{}',$6,'SUCCEEDED',$7,$7,$7,$8)`;
/** `on` (optional {db, store}) is the database the world is written to (default: the main one). names: fixture member names of the manifest in ordinal order. The job gate is replaced by the member's fixture inputs, keyed by pine_import_id (inputsByImport). */
async function newWorld({names=['M1','M2'],model=MODEL,policy=POLICY,on}={}){
  const target=on?.db??db,targetStore=on?.store??store;
  const user=await targetStore.createUser({email:'ex-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=user.id;
  await target.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,$3,$3,'CONFIGURATION')",[bot,T0,MANIFEST.capital.equity]);
  const capital=await targetStore.paperAccounts(bot);
  const funding_cutoff=(await target.query('SELECT COALESCE(max(id),0)::int AS cutoff FROM paper_funding WHERE user_id=$1',[bot])).rows[0].cutoff;
  const ids=Array.from({length:names.length},()=>randomUUID()).sort();
  const deps=Array.from({length:names.length},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>({n:i+1,name:names[i],pine:id,dep:deps[i],inputs:MANIFEST.members[names[i]].inputs,analysis:analysisFor(MANIFEST.members[names[i]].inputs)}));
  for(const m of specs){
    await target.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',[m.pine,user.id,bot,SUPPORTED,'Member fixture',SOURCE,JSON.stringify(m.analysis),T0]);
    await target.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,SUPPORTED,SOURCE,JSON.stringify(m.analysis),T0]);
    await target.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:SUPPORTED,analysis:m.analysis}));
  const selection=validateSelection(inspectSource(SOURCE),{...SPT_SIGNAL_MAPPING,buy:'buySignal',exit:'sellSignal'},[]);
  for(const m of specs){
    const artifact=assemble(SOURCE,selection,{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET}).integrated_pine;
    const snapshot={policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection,market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:SUPPORTED,instruction_versions:{template:'fixture'},artifact_hash:hash(artifact)};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n,model);
    await target.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'DRAFT',$7)",
      [m.dep,user.id,bot,m.pine,JSON.stringify(snapshot),snapshotHash,T0]);
    await target.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
    await target.query(JOB_SQL,[randomUUID(),user.id,bot,randomUUID(),hash('request-'+randomUUID()),m.pine,T0,JSON.stringify({integrated_pine:artifact,deployment_id:m.dep,artifact_status:'DRAFT'})]);
  }
  return {id:user.id,bot,specs,inputsByImport:Object.fromEntries(specs.map(m=>[m.pine,m.inputs]))};
}
const namesOf=world=>world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}));
const keyOf=()=>'ex-key-'+randomUUID().replaceAll('-','');
const inputOf=(world,over={})=>({owner_id:world.id,bot_id:world.bot,fixture:true,idempotency_key:keyOf(),member_deployments:namesOf(world),bridge_domains:structuredClone(DOMAINS),
  dataset:{...DATASET},budget:{candidates:30},seed:42,...over});
function serviceOn(handle,over={},defaultRisk=POLICY){
  const own=new Store(handle);
  return new MultiPineFixtureService({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk}),clock:()=>NOW,engineHash:ENGINE,supported_source_hash:SUPPORTED,...over});
}
async function admitRun(world,over={},svc=service){
  const out=await svc.admit(inputOf(world,over));
  assert.equal(out.ok,true,JSON.stringify(out));
  return out.run;
}

/* ---- runners ---- */

/** The one-line wrapper of the real job: the private source gate is replaced by the fixture inputs of the member; everything else is the real module. */
const GATE_WRAPPER=[
  'import json,os',
  'from robot_quant import mp_combined_job as job',
  'from robot_quant.spt_custom_evaluator import CustomSignalInputs',
  'INPUTS=json.loads(os.environ["MP_TEST_INPUTS"])',
  'def gate(source,snapshot):',
  '    rows=snapshot["membership"]',
  '    if len(rows)!=1: raise ValueError("MISSING_SOURCE_MEMBERSHIP")',
  '    return CustomSignalInputs.from_source_values(INPUTS[rows[0]["pine_import_id"]]),[]',
  'job.validate_custom_snapshot=gate',
  'job.main()'
].join('\n');
// The interpreter is the runner's own default (QUANT_RESEARCH_PYTHON, else quant_lab/.venv): the job imports pydantic through the engine modules, which a bare
// `python` from PATH (the CI setup-python interpreter) does not have.
const realRunner=world=>createPythonRunner({args:['-c',GATE_WRAPPER],env:{MP_TEST_INPUTS:JSON.stringify(world.inputsByImport)}});
/** Wraps a runner and records every call: kind, pair, row count, the last row time and a digest of the member list. */
function recording(runner){
  const calls=[];
  const run=async(payload,options)=>{
    calls.push({kind:payload.step.kind,pair:payload.step.pair,rows:payload.rows.length,last_time:payload.rows.at(-1).time,timeoutMs:options?.timeoutMs});
    return runner(payload,options);
  };
  run.calls=calls;
  return run;
}
function executorOn(handle,{runEvaluator,clock=()=>NOW+1000,engineHash=()=>ENGINE,callTimeoutMs}={}){
  const own=new Store(handle);
  return new MultiPineFixtureExecutor({db:handle,store:own,readBotState:storeBotState({store:own,defaultRisk:POLICY}),clock,runEvaluator,engineHash,...(callTimeoutMs!==undefined?{callTimeoutMs}:{})});
}
const eventsOf=async (run_id,handle=db)=>(await handle.query('SELECT seq,status,reason_code,result FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq',[run_id])).rows;
const statusOf=async run_id=>(await eventsOf(run_id)).at(-1).status;
const rowDigest=async(table,where='',params=[])=>(await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t ${where}`,params)).rows[0];
/** A digest of every table of the schema and every sequence: what a side effect would change. */
async function digestAll(){
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
  const out={};
  for(const table of tables)out[table]=await rowDigest(table);
  out['(sequences)']=(await db.query("SELECT string_agg(sequencename||':'||COALESCE(last_value::text,'-'),',' ORDER BY sequencename) AS s FROM pg_sequences WHERE schemaname='public'")).rows[0].s;
  return out;
}
const except=(digest,names)=>Object.fromEntries(Object.entries(digest).filter(([name])=>!names.includes(name)));


/* ---- stub runners: Node test doubles for runEvaluator ---- */

const H=char=>char.repeat(64);
const metrics=(trades,ret,drawdown='1.0')=>({bars:950,closed_trades:trades,end_equity:'1000',gross_loss:'1',gross_profit:'2',max_drawdown_percent:drawdown,net_return_percent:ret,profit_factor:2,start_equity:'1000'});
const FUNNEL=()=>({accepted:0,capped:0,exit_fills:{},intents_buy:0,intents_exit:0,native_buy:5,native_exit:2,pre_start_intents:0,rejected:{},skipped_buys:0,suppressed_buys:0});
/**
 * A valid step response without Python (shape and echo only). Every candidate returns the same validation return, so every candidate is eligible; the STRESS step
 * returns `stress` (default negative): a run ends NO_VALID_CANDIDATE with COST_STRESS_FAILED and never asks for a HOLDOUT step, which this double cannot build.
 * onCall(index, payload, options) runs before the answer (a hook for a clock jump, a side effect or a delay).
 */
function canned({stress='-1',pad=0,signals=H('a'),onCall,mutate}={}){
  const calls=[];
  const run=async(payload,options)=>{
    const index=calls.length;
    calls.push({kind:payload.step.kind,pair:payload.step.pair,rows:payload.rows.length,timeoutMs:options?.timeoutMs});
    if(onCall)await onCall(index,payload,options);
    if(options?.signal?.aborted)throw Object.assign(new Error('RESEARCH_INTERRUPTED'),{code:'RESEARCH_INTERRUPTED'});
    const kind=payload.step.kind;
    const response={version:STEP_VERSION,evaluator:'mp-combined-paper-v1',closure:MP_COMBINED_CLOSURE_VERSION,run:payload.run,kind,pair:payload.step.pair,same_bar_order:'exit-first-ordinal-v1',
      train:metrics(10,'0.5'),validation:metrics(10,kind==='STRESS'?stress:'0.5'),decision_count:0,fills:0,rejections:pad>0?{padding:'x'.repeat(pad)}:{},exit_fill_reasons:{},
      diagnostics:{version:'mp-combined-diagnostics-v1',same_bar_order:'exit-first-ordinal-v1',members:payload.members.map(m=>({...FUNNEL(),ordinal:m.ordinal,deployment_id:m.deployment_id})),bot:FUNNEL(),cross_source_target:0,duplicate_intents:0},
      member_signals:payload.members.map(m=>({ordinal:m.ordinal,deployment_id:m.deployment_id,signals_hash:signals,native_buy:5,native_exit:2,segments:{train:{buy:3,exit:1},validation:{buy:2,exit:1}}})),
      ledger_hash:H('c'),owner_recommendation_ready:false};
    return mutate?(mutate(response,payload,index)??response):response;
  };
  run.calls=calls;
  return run;
}
const thrower=code=>{const calls=[];const run=async payload=>{calls.push(payload.step.kind);throw Object.assign(new Error(code),{code});};run.calls=calls;return run;};
/** Wraps a runner; mutate(response, payload, index) may change the parsed response in place or return a new one. Records the pair of calls. */
function wrap(runner,mutate){
  const calls=[];
  const run=async(payload,options)=>{
    const index=calls.length;calls.push(payload.step.kind);
    const response=await runner(payload,options);
    return mutate?(mutate(response,payload,index)??response):response;
  };
  run.calls=calls;
  return run;
}
/** The fixture HOLDOUT segment has 4 closed trades (the rule needs 5), so no real run can reach SUCCEEDED. This wrapper replaces ONLY the `test` metrics of the HOLDOUT response; the ledger, the signals and the diagnostics stay the real job's. */
const PASSING_TEST=metrics(6,'0.5','0.3');
const withPassingHoldout=runner=>wrap(runner,(response,payload)=>{if(payload.step.kind==='HOLDOUT')response.test=structuredClone(PASSING_TEST);});
/** Domains used by the real-job cases: nine grid points (11 to 14 job calls per run, about 0.6 s each). */
const SMALL={atr_multiplier:{min:'2',max:'3',step:'0.5'},rr:{min:'1',max:'2',step:'0.5'}};
const V2_DOMAINS=SMALL;
const STRESS_FAILS={atr_multiplier:{min:'1.5',max:'2.5',step:'0.5'},rr:{min:'1',max:'2.5',step:'0.5'}};

/* ---- the second fixture (bars-v2): its own database, because its rows overlap the v1 times of pine_market_bars (the table keeps one row per bar time) ---- */
const BARS2=JSON.parse(await fs.readFile(new URL('bars-v2.json',FIXTURES),'utf8'));
const MANIFEST2=JSON.parse(await fs.readFile(new URL('manifest-v2.json',FIXTURES),'utf8'));
const START2=BARS2.first_time,END2=START2+(BARS2.bar_count-1)*60000,NOW2=END2+3600000;
const DATASET2={start_time:START2,end_time:END2,warmup_bars:MANIFEST.split.warmup};
const PROVENANCE2={profile:MODEL.data_profile,source:BARS2.provenance.source,fixture:true};
let V2;
/** A clone of the template with the run store, the grants and the bars-v2 rows (a service and a fixture-role handle on it). Created once, on first use, and dropped with the other extra databases. */
async function secondDatabase(){
  if(V2)return V2;
  const name='robot_ex_v2_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  databases.push(name);
  const own=ser(track(new PostgresDatabase({connectionString:serialOf(name),max:4})));
  await migrateMpRunStore(own);
  await own.query(await roleScript(GRANT_SCRIPT,{runtime_role:runtimeName}));
  await own.query(await roleScript(FIXTURE_SCRIPT,{runtime_role:runtimeName,fixture_role:fixtureName}));
  const handle=ser(track(new PostgresDatabase({connectionString:serialOf(name,fixtureName),max:4})));
  const report=await inspectMpRunStore(own,{runtimeRole:runtimeName,fixtureRole:fixtureName});
  assert.equal(report.ok,true,report.failures?.join());
  const rows=BARS2.bars.map(bar=>barRow(bar,BARS2));
  await own.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,b::jsonb,$4::jsonb,h FROM unnest($1::bigint[],$2::text[],$3::text[]) AS u(t,b,h)`,
    [rows.map(row=>row.time),rows.map(row=>JSON.stringify(row)),rows.map(row=>hash(canonical(row))),JSON.stringify(PROVENANCE2)]);
  return V2={db:own,fx:handle,store:new Store(own),svc:serviceOn(handle,{clock:()=>NOW2})};
}
/** Options that point runWith at the second database (the executor clock is after the last bars-v2 bar). */
const onSecond=(two,bridge_domains)=>({db:two.fx,svc:two.svc,read:two.db,over:{dataset:{...DATASET2},bridge_domains},executor:{clock:()=>NOW2+1000}});

/* ---- shared world for cases that do not change it ---- */
let SHARED;
const shared=async()=>SHARED??=await newWorld();
async function runWith(world,runner,{over={},executor={},signal,db:handle=fx,svc=service,read=db}={}){
  const run=await admitRun(world,over,svc);
  const exec=executorOn(handle,{runEvaluator:runner,...executor});
  const out=await exec.execute({owner_id:world.id,run_id:run.run_id,signal});
  return {run,out,events:await eventsOf(run.run_id,read),exec};
}
const statuses=events=>events.map(event=>event.status);
const DEADLINE=NOW+900_000;
let SAMPLE;

/* ---- 1. the real job: NO_VALID_CANDIDATE after a HOLDOUT, F28, holdout once, F23, T-R1 to T-R3 ---- */

test('REAL JOB: a full run reaches the single HOLDOUT, stores a matched baseline, ends NO_VALID_CANDIDATE and changes nothing else (F28, F23, T-R1 to T-R3)',{timeout:600000},async()=>{
  const world=await newWorld();
  const run=await admitRun(world,{bridge_domains:SMALL});
  const runner=recording(realRunner(world));
  const before=await digestAll();
  const out=await executorOn(fx,{runEvaluator:runner}).execute({owner_id:world.id,run_id:run.run_id});
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'NO_VALID_CANDIDATE',reason_code:null});
  const events=await eventsOf(run.run_id);
  assert.deepEqual(statuses(events),['ADMITTED','RUNNING','NO_VALID_CANDIDATE']);
  const result=events[2].result;
  SAMPLE={result,run,world};
  assert.equal(result.version,EXECUTOR_RESULT_VERSION);
  assert.equal(result.completion_reason,'CANDIDATE_FAILED_CHECKS');
  assert.equal(result.holdout_evaluated,true);
  assert.deepEqual(result.selected.screen_reasons,['INSUFFICIENT_TEST_TRADES','NEGATIVE_HOLDOUT_RETURN'],'the fixture HOLDOUT segment has 4 trades and a negative return');
  // F28: the blocker stays, the recommendation flag stays false, member counts sum to the Bot counts
  assert.equal(result.owner_recommendation_ready,false);assert.ok(result.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B'));
  const funnel=result.funnel.diagnostics;
  assert.equal(result.funnel.step,'HOLDOUT');assert.equal(funnel.members.length,2);
  for(const key of ['native_buy','native_exit','intents_buy','intents_exit','pre_start_intents','suppressed_buys','skipped_buys','accepted','capped'])
    assert.equal(funnel.members.reduce((total,member)=>total+member[key],0),funnel.bot[key],'funnel '+key);
  assert.ok(funnel.bot.native_buy>0&&funnel.members.every(member=>member.native_buy>0),'both members traded signals');
  // the baseline: stored, tied to the run and the selected pair, matched, and it did not change the status
  const baseline=result.combined_baseline;
  assert.equal(baseline.version,'mp-combined-baseline-v1');assert.equal(baseline.matched,true,JSON.stringify(baseline.differences));
  assert.deepEqual(baseline.binding,{run_id:run.run_id,contract_hash:run.contract_hash});
  assert.deepEqual(baseline.pair,result.selected.parameters);
  assert.deepEqual(Object.values(baseline.differences).filter(count=>count!==0),[]);
  assert.equal(baseline.counts.decisions,result.holdout_decisions.length);assert.equal(baseline.counts.received_decisions,result.holdout_decisions.length);
  assert.ok(baseline.counts.fills>0,'the HOLDOUT trace has fills');
  assert.equal(result.holdout_decisions.length,result.selected.holdout.decision_count);
  // engine closure and plan
  assert.equal(result.engine_hash,ENGINE);assert.deepEqual(result.closure,{version:'mp-combined-closure-v1',hash:ENGINE});
  assert.equal(result.search.planned,9);assert.equal(result.search.max_evaluations,18);assert.match(result.search.plan_hash,/^[0-9a-f]{64}$/);assert.equal(result.search.dimension_coverage_percent,100);
  assert.equal(result.candidates.length,9);
  // HOLDOUT once, and nothing of it in any other payload or record
  const kinds=runner.calls.map(call=>call.kind);
  assert.equal(kinds.filter(kind=>kind==='HOLDOUT').length,1);assert.equal(kinds.at(-1),'HOLDOUT');assert.equal(kinds.filter(kind=>kind==='STRESS').length,1);
  assert.deepEqual(kinds.slice(0,9),Array(9).fill('CANDIDATE'));
  const split=MANIFEST.split,holdoutFrom=START+split.validation_end*60000;
  for(const call of runner.calls){
    if(call.kind==='HOLDOUT'){assert.equal(call.rows,split.test_end);assert.equal(call.last_time,END);}
    else{assert.equal(call.rows,split.validation_end);assert.ok(call.last_time<holdoutFrom,call.kind+' payload holds no holdout bar');}
    assert.ok(call.timeoutMs>=1&&call.timeoutMs<=30000);
  }
  assert.equal(Object.hasOwn(result.selected,'test'),true);
  for(const record of [...result.candidates,...result.selected.sensitivity,result.selected.cost_stress])assert.equal(Object.hasOwn(record,'test'),false,'no holdout metrics outside selected.test');
  assert.ok(runner.calls.length<=result.search.max_evaluations);
  // the stored run passes every storage check, and the result is under 1 MiB
  const read=await getMultiRun(fx,{owner_id:world.id,run_id:run.run_id});
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.status,'NO_VALID_CANDIDATE');assert.equal(read.owner_recommendation_ready,false);
  assert.ok(Buffer.byteLength(canonical(result))<1048576);
  assert.equal(validateTerminalResult(result,read.run),result);
  // F23: the run changed the run-store events and nothing else
  const after=await digestAll();
  assert.deepEqual(except(after,['mp_research_run_events']),except(before,['mp_research_run_events']),'no table or sequence other than the run events changed');
  assert.equal((await rowDigest('mp_research_run_events','WHERE run_id=$1',[run.run_id])).n,3);
  assert.deepEqual((await db.query("SELECT state FROM pine_deployments WHERE owner_id=$1 ORDER BY deployment_id",[world.id])).rows.map(row=>row.state),['DRAFT','DRAFT']);
  assert.equal((await store.getBotSession(world.bot)).state??'SETUP','SETUP');
  // T-R1 to T-R3: the three existing multi-Pine refusals still fire after a full run
  const pine=new PineBridgeService(store,{defaultRisk:POLICY});
  const dep=world.specs[0].dep;
  await db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[dep]);
  const quant=new QuantResearchService({pineService:pine,clock:()=>NOW,supportedSourceHash:SUPPORTED,foundation:false});
  await assert.rejects(db.transaction(()=>quant.enqueue(world.id,{bot_id:world.bot,deployment_id:dep,parameter_slots:[],bridge_domains:DOMAINS,dataset:DATASET,budget:{candidates:30},seed:42},keyOf())),
    {code:'MULTI_PINE_RESEARCH_NOT_SUPPORTED'},'T-R1');
  await assert.rejects(activateDeployment(pine,world.id,dep),{code:'MULTI_PINE_REQUIRES_APP_3B'},'T-R2');
  const bar=BARS.bars[100],row=barRow(bar),signal_id=(await db.query(`INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,event,side,payload,status)
    VALUES($1,$2,$3,$3,'binance-global','BTCUSDT','BUY','BUY','{}','PENDING') RETURNING id`,[world.bot,'tr3-'+randomUUID(),T0])).rows[0].id;
  await db.query('INSERT INTO pine_bridge_events(deployment_id,event_id,event_hash,entry_ref,bar_time,payload,signal_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [dep,'tr3-event',hash('tr3'),dep+':'+bar.time+':0',bar.time,JSON.stringify({event_type:'BUY'}),signal_id,'QUEUED']);
  const evidence=(await db.query('SELECT evidence_hash FROM pine_bridge_evidence WHERE deployment_id=$1',[dep])).rows[0].evidence_hash;
  await assert.rejects(prepareBridgeExecution(store,{id:signal_id,user_id:world.bot},{referencePrice:executionPrice(Number(bar.close),'BUY',MODEL.slippage_bps,MODEL.price_tick),
    bridge:{deployment_id:dep,event_id:'tr3-event',event_type:'BUY',bar_time:bar.time,evidence_hash:evidence,market_hash:hash(canonical(row))}},POLICY),{code:'MULTI_PINE_REQUIRES_APP_3B'},'T-R3');
});

/* ---- 2. SUCCEEDED, and a failed screen that never reaches HOLDOUT ---- */

test('REAL JOB + replaced HOLDOUT test metrics: SUCCEEDED with a matched baseline (the fixture HOLDOUT segment has 4 trades, so only the metrics are replaced)',{timeout:600000},async()=>{
  const world=await newWorld();
  const runner=withPassingHoldout(recording(realRunner(world)));
  const {run,out,events}=await runWith(world,runner,{over:{bridge_domains:SMALL}});
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'SUCCEEDED',reason_code:null});
  assert.deepEqual(statuses(events),['ADMITTED','RUNNING','SUCCEEDED']);
  const result=events[2].result;
  assert.equal(result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  assert.deepEqual(result.selected.screen_reasons,[]);
  assert.deepEqual(result.selected.test,PASSING_TEST);
  assert.equal(result.holdout_evaluated,true);
  assert.equal(result.combined_baseline.matched,true,JSON.stringify(result.combined_baseline.differences));
  assert.deepEqual(result.combined_baseline.binding,{run_id:run.run_id,contract_hash:run.contract_hash});
  assert.equal(result.owner_recommendation_ready,false);assert.ok(result.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B'));
  assert.equal(runner.calls.filter(kind=>kind==='HOLDOUT').length,1);
  const read=await getMultiRun(fx,{owner_id:world.id,run_id:run.run_id});
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.status,'SUCCEEDED');assert.equal(read.owner_recommendation_ready,false);
});

test('REAL JOB on bars-v2: SUCCEEDED with the real HOLDOUT metrics (no replaced metrics) and a matched baseline whose final state is the job\'s own',{timeout:600000},async()=>{
  // Why V2_DOMAINS: bars-v2 passes the one-Pine HOLDOUT gates (manifest-v2.json: M1+M2 at pair 2/1.5 has 21 closed trades, +0.797 %, drawdown 0.482 % on the HOLDOUT), but a grid that reaches
  // atr_multiplier 1.5 can fail the sensitivity or the cost stress (handoff). The SMALL grid (atr_multiplier 2 to 3, rr 1 to 2) was run on the real job: the search selects 2/2 (validation +0.824 %),
  // its two in-grid neighbours hold (2.5/2: -0.213 %, 5 trades, a drop of 1.04 points under the limit of 2 and exactly the 5-trade floor; 2/1.5: +0.656 %, 12 trades), the stress step holds
  // (+0.612 %, 12 trades) and the HOLDOUT of 2/2 has 20 closed trades, +0.740 %, drawdown 0.457 %. No metric of the run is replaced.
  const two=await secondDatabase();
  const world=await newWorld({on:two});
  const runner=recording(realRunner(world));
  const {run,out,events}=await runWith(world,runner,onSecond(two,V2_DOMAINS));
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'SUCCEEDED',reason_code:null});
  assert.deepEqual(statuses(events),['ADMITTED','RUNNING','SUCCEEDED']);
  const result=events[2].result;
  assert.equal(result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  assert.deepEqual(result.selected.screen_reasons,[],'sensitivity, cost stress and the HOLDOUT gates all pass on the real job output');
  assert.equal(result.holdout_evaluated,true);
  // the HOLDOUT metrics are the job's own (not the replaced PASSING_TEST), and the three gates hold on them
  const holdout=result.selected.test;
  assert.notDeepEqual(holdout,PASSING_TEST);
  assert.ok(holdout.closed_trades>=5&&!D(holdout.net_return_percent).lt(0)&&D(holdout.max_drawdown_percent).lte(20),JSON.stringify(holdout));
  assert.equal(result.search.dimension_coverage_percent,100);
  assert.equal(runner.calls.filter(call=>call.kind==='HOLDOUT').length,1);
  for(const call of runner.calls)assert.ok(call.kind==='HOLDOUT'?call.rows===MANIFEST.split.test_end&&call.last_time===END2:call.rows===MANIFEST.split.validation_end);
  assert.deepEqual(result.selected.parameters,{rr:'2',atr_multiplier:'2'},'the selected pair of this fixture and domain (deterministic)');
  assert.equal(holdout.closed_trades,20);
  // F1 pin: the CANDIDATE result of the manifest pair equals the measured block of manifest-v2.json (the real job and the manifest measurement agree), on the manifest's own first bar time
  assert.equal(START2,MANIFEST2.bars.first_time);
  const measured=MANIFEST2.measured;
  const pinned=result.candidates.filter(row=>D(row.parameters.atr_multiplier).eq(measured.pair.atr_multiplier)&&D(row.parameters.rr).eq(measured.pair.rr));
  assert.equal(pinned.length,1,'the manifest pair 2/1.5 is one candidate of the SMALL grid');
  for(const segment of ['train','validation']){
    assert.equal(pinned[0][segment].closed_trades,measured[segment].closed_trades,segment);
    assert.ok(D(pinned[0][segment].net_return_percent).eq(measured[segment].net_return_percent),segment+' net return '+pinned[0][segment].net_return_percent);
    assert.ok(D(pinned[0][segment].max_drawdown_percent).eq(measured[segment].max_drawdown_percent),segment+' drawdown '+pinned[0][segment].max_drawdown_percent);
  }
  // the baseline: matched, no difference of any kind (the job-supplied final state agrees with the oracle and with the trace derivation), and the status followed the search
  const baseline=result.combined_baseline;
  assert.equal(baseline.version,'mp-combined-baseline-v1');assert.equal(baseline.matched,true,JSON.stringify(baseline.differences));
  assert.deepEqual(Object.values(baseline.differences).filter(count=>count!==0),[]);
  assert.equal(Object.hasOwn(baseline.differences,'job_final_state_vs_trace'),false);assert.equal(Object.hasOwn(baseline,'job_final_state_mismatch'),false);
  assert.deepEqual(baseline.binding,{run_id:run.run_id,contract_hash:run.contract_hash});assert.deepEqual(baseline.pair,result.selected.parameters);
  assert.ok(baseline.counts.fills>=100,'a long HOLDOUT trace: '+JSON.stringify(baseline.counts));
  assert.equal(baseline.counts.received_decisions,result.holdout_decisions.length);
  assert.equal(baseline.final_cash_delta,'0');assert.equal(baseline.final_position_cost_delta,'0');
  const read=await getMultiRun(two.fx,{owner_id:world.id,run_id:run.run_id});
  assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.status,'SUCCEEDED');assert.equal(read.owner_recommendation_ready,false);
  assert.ok(result.acceptance_blockers.includes('MULTI_PINE_REQUIRES_APP_3B'));assert.equal(result.owner_recommendation_ready,false);
});

test('REAL JOB: no candidate passes the cost stress (F20): NO_VALID_CANDIDATE, no HOLDOUT, no baseline, no stored trace',{timeout:600000},async()=>{
  const world=await newWorld();
  const runner=recording(realRunner(world));
  const {out,events}=await runWith(world,runner,{over:{bridge_domains:STRESS_FAILS}});
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'NO_VALID_CANDIDATE',reason_code:null});
  const result=events[2].result;
  assert.equal(result.completion_reason,'CANDIDATE_FAILED_CHECKS');assert.deepEqual(result.selected.screen_reasons,['COST_STRESS_FAILED']);
  assert.equal(result.holdout_evaluated,false);assert.equal(result.combined_baseline,null);assert.equal(Object.hasOwn(result,'holdout_decisions'),false);assert.equal(Object.hasOwn(result.selected,'test'),false);
  assert.equal(result.funnel.step,'CANDIDATE');
  assert.equal(runner.calls.some(call=>call.kind==='HOLDOUT'),false,'a failed screen never asks for the holdout rows');
  for(const call of runner.calls)assert.equal(call.rows,MANIFEST.split.validation_end);
  assert.equal(runner.calls.filter(call=>call.kind==='STRESS').length,1);
});

test('REAL JOB: no search outcome at all (every candidate fails the screen) ends NO_VALID_TRAIN_VALIDATION_CANDIDATE with no selection',{timeout:600000},async()=>{
  // the rules need 5 closed trades on train and validation: a tiny-risk domain with rr 0.5 and wide stops leaves the screen empty only when it fails; use canned numbers
  const world=await shared();
  const runner=canned({mutate:(response,payload)=>{if(payload.step.kind==='CANDIDATE')response.validation=metrics(2,'0.5');}});
  const {out,events}=await runWith(world,runner);
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'NO_VALID_CANDIDATE',reason_code:null});
  const result=events[2].result;
  assert.equal(result.completion_reason,'NO_VALID_TRAIN_VALIDATION_CANDIDATE');assert.equal(result.selected,null);assert.equal(result.combined_baseline,null);assert.equal(result.funnel,null);
  assert.equal(runner.calls.length,25,'25 candidates, no sensitivity, stress or holdout');
  assert.ok(result.candidates.every(candidate=>candidate.screen_reasons.includes('INSUFFICIENT_VALIDATION_TRADES')));
});

/* ---- 3. the baseline never decides the status ---- */

test('baseline: a ledger difference or an oracle failure is stored and never changes the status (RD-MP-30)',{timeout:600000},async()=>{
  const world=await newWorld();
  // (a) the oracle runs and finds one extra unit of quantity in a fill decision: matched false, differences counted, SUCCEEDED stays
  const tampered=wrap(withPassingHoldout(realRunner(world)),(response,payload)=>{
    if(payload.step.kind!=='HOLDOUT')return;
    const decision=response.ledger.decisions.find(item=>item.outcome==='FILLED'&&item.event_type==='BUY');
    decision.quantity=String(Number(decision.quantity)+0.00001);
  });
  const a=await runWith(world,tampered,{over:{bridge_domains:SMALL}});
  assert.equal(a.out.status,'SUCCEEDED');
  const baseline=a.events[2].result.combined_baseline;
  assert.equal(baseline.matched,false);assert.ok(baseline.differences.quantity_steps>0,JSON.stringify(baseline.differences));
  assert.deepEqual(baseline.binding,{run_id:a.run.run_id,contract_hash:a.run.contract_hash});
  assert.equal(a.events[2].result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
  // (b) the oracle input cannot be built (the trace and the job's own counts disagree): an unmatched record with the error code, SUCCEEDED stays
  const inconsistent=wrap(withPassingHoldout(realRunner(world)),(response,payload)=>{if(payload.step.kind==='HOLDOUT')response.fills+=1;});
  const b=await runWith(world,inconsistent,{over:{bridge_domains:SMALL}});
  assert.equal(b.out.status,'SUCCEEDED');
  const record=b.events[2].result.combined_baseline;
  assert.equal(record.matched,false);assert.equal(record.error,'HOLDOUT_LEDGER_INCONSISTENT');assert.deepEqual(record.binding,{run_id:b.run.run_id,contract_hash:b.run.contract_hash});assert.deepEqual(record.pair,b.events[2].result.selected.parameters);
  assert.equal((await getMultiRun(fx,{owner_id:world.id,run_id:b.run.run_id})).ok,true);
});

/* ---- 4. F29, and the real source gate ---- */

test('REAL JOB F29: a member without native signals fails the run MP_MEMBER_NO_SIGNALS after the first CANDIDATE step',{timeout:600000},async()=>{
  const world=await newWorld({names:['M1','M2_ZERO']});
  const runner=recording(realRunner(world));
  const {out,events}=await runWith(world,runner);
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'FAILED',reason_code:'MP_MEMBER_NO_SIGNALS'});
  assert.deepEqual(events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['FAILED','MP_MEMBER_NO_SIGNALS']]);
  assert.deepEqual(runner.calls.map(call=>call.kind),['CANDIDATE'],'one step only');
  assert.equal(events[2].result,null);
});

test('REAL JOB: the unreplaced source gate refuses the synthetic source (the owner source is not in the repository): FAILED EVALUATION_FAILED',{timeout:120000},async()=>{
  const world=await shared();
  const failures=[];
  const real=createPythonRunner();
  const runner=async(payload,options)=>{try{return await real(payload,options);}catch(error){failures.push(error.code);throw error;}};
  const {out,events}=await runWith(world,runner);
  assert.deepEqual(out,{ok:true,action:'TERMINAL',status:'FAILED',reason_code:'EVALUATION_FAILED'});
  assert.deepEqual(failures,['UNSUPPORTED_SOURCE_HASH'],'the runner relays the job code only; the executor stores EVALUATION_FAILED');
  assert.deepEqual(statuses(events),['ADMITTED','RUNNING','FAILED']);
});

/* ---- 5. failures of the evaluator ---- */

test('runner failure codes become allowlisted reasons; a job code is stored as EVALUATION_FAILED (STUB runner)',async()=>{
  const world=await shared();
  const table=[['MP_CROSS_SOURCE_TARGET','FAILED','EVALUATION_FAILED'],['MP_INPUT_INVALID','FAILED','EVALUATION_FAILED'],['UNSUPPORTED_SOURCE_HASH','FAILED','EVALUATION_FAILED'],
    ['EVALUATION_FAILED','FAILED','EVALUATION_FAILED'],['EVALUATION_TIMED_OUT','FAILED','EVALUATION_TIMED_OUT'],['EVALUATION_OUTPUT_TOO_LARGE','FAILED','EVALUATION_OUTPUT_TOO_LARGE'],
    ['INVALID_EVALUATION_RESPONSE','FAILED','INVALID_EVALUATION_RESPONSE'],['QUANT_PYTHON_UNAVAILABLE','FAILED','QUANT_PYTHON_UNAVAILABLE'],['RESEARCH_REQUEST_TOO_LARGE','FAILED','RESEARCH_REQUEST_TOO_LARGE'],
    ['RESEARCH_INTERRUPTED','CANCELLED','RESEARCH_INTERRUPTED']];
  for(const [code,status,reason] of table){
    const runner=thrower(code);
    const {out,events}=await runWith(world,runner);
    assert.deepEqual([out.status,out.reason_code],[status,reason],code);
    assert.deepEqual(events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],[status,reason]],code);
    assert.equal(runner.calls.length,1);
  }
});

test('an evaluator defect fails the run EVALUATION_FAILED: counters, echo, shape, holdout leak, drifting signals (REAL JOB responses, perturbed)',{timeout:600000},async()=>{
  const world=await newWorld();
  const real=realRunner(world);
  const cases=[
    ['cross_source_target is not 0',response=>{response.diagnostics.cross_source_target=1;}],
    ['duplicate_intents is not 0',response=>{response.diagnostics.duplicate_intents=1;}],
    ['run echo differs',response=>{response.run={...response.run,run_id:randomUUID()};}],
    ['pair differs',response=>{response.pair={...response.pair,rr:'9'};}],
    ['kind differs',response=>{response.kind='STRESS';}],
    ['closure differs',response=>{response.closure='other-closure';}],
    ['version differs',response=>{response.version='mp-combined-step-v2';}],
    ['holdout metrics leak into a CANDIDATE step',response=>{response.test=metrics(9,'1');}],
    ['a ledger trace leaks into a CANDIDATE step',response=>{response.ledger={events:[],decisions:[]};}],
    ['a signal vector leaks into a CANDIDATE step',response=>{response.member_signals[0].signals={buy:[],native_exit:[]};}],
    ['train metrics are malformed',response=>{response.train.closed_trades=-1;}],
    ['validation drawdown is negative',response=>{response.validation.max_drawdown_percent='-1';}],
    ['ledger hash is malformed',response=>{response.ledger_hash='x';}],
    ['member ordinal is wrong',response=>{response.member_signals[0].ordinal=2;}],
    ['recommendation flag is true',response=>{response.owner_recommendation_ready=true;}],
    ['a member is missing',response=>{response.member_signals.pop();}]];
  for(const [label,change] of cases){
    const runner=wrap(real,(response,payload,index)=>{if(index===0)change(response,payload);});
    const {out,events}=await runWith(world,runner,{over:{bridge_domains:SMALL}});
    assert.deepEqual([out.status,out.reason_code],['FAILED','EVALUATION_FAILED'],label);
    assert.deepEqual(statuses(events),['ADMITTED','RUNNING','FAILED'],label);
    assert.equal(runner.calls.length,1,label+': no step after the defect');
  }
});

test('the member signal sets must not change between steps of one run (F24): a drift fails the run (STUB runner)',async()=>{
  const world=await shared();
  const runner=canned({mutate:(response,payload,index)=>{if(index===3)response.member_signals[0].signals_hash=H('d');}});
  const {out,events}=await runWith(world,runner);
  assert.deepEqual([out.status,out.reason_code],['FAILED','EVALUATION_FAILED']);
  assert.equal(runner.calls.length,4);assert.deepEqual(statuses(events),['ADMITTED','RUNNING','FAILED']);
});

/* ---- 6. deadline, engine, freshness, abort ---- */

test('deadline: past it before the claim ends TIMED_OUT without a claim; past it during the run ends TIMED_OUT from RUNNING; the call timeout never passes the time left (STUB runner)',async()=>{
  const world=await shared();
  const before=canned();
  const a=await runWith(world,before,{executor:{clock:()=>DEADLINE}});
  assert.deepEqual(a.out,{ok:true,action:'TERMINAL',status:'TIMED_OUT',reason_code:'JOB_DEADLINE_EXCEEDED'});
  assert.deepEqual(a.events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['TIMED_OUT','JOB_DEADLINE_EXCEEDED']]);
  assert.equal(before.calls.length,0);
  let now=NOW+1000;
  const during=canned({onCall:index=>{if(index===2)now=DEADLINE+1;}});
  const b=await runWith(world,during,{executor:{clock:()=>now}});
  assert.deepEqual(b.out,{ok:true,action:'TERMINAL',status:'TIMED_OUT',reason_code:'JOB_DEADLINE_EXCEEDED'});
  assert.deepEqual(b.events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['TIMED_OUT','JOB_DEADLINE_EXCEEDED']]);
  assert.equal(during.calls.length,3,'no step after the deadline');
  // the call timeout is the smaller of the configured timeout and the time left
  const near=canned({stress:'-1'});
  await runWith(world,near,{executor:{clock:()=>DEADLINE-5000}});
  assert.ok(near.calls.length>0&&near.calls.every(call=>call.timeoutMs===5000),'time left 5000 ms');
  const far=canned();
  await runWith(world,far,{executor:{clock:()=>NOW+1000,callTimeoutMs:2500}});
  assert.ok(far.calls.every(call=>call.timeoutMs===2500));
  const dflt=canned();
  await runWith(world,dflt);
  assert.ok(dflt.calls.every(call=>call.timeoutMs===30000));
  for(const bad of [0,-1,30001,1.5,'30000',NaN])assert.throws(()=>executorOn(fx,{runEvaluator:canned(),callTimeoutMs:bad}),TypeError,String(bad));
});

test('engine hash: a changed closure ends FAILED QUANT_ENGINE_CHANGED before the claim and before every step (STUB runner)',async()=>{
  const world=await shared();
  const early=canned();
  const a=await runWith(world,early,{executor:{engineHash:()=>H('e')}});
  assert.deepEqual(a.out,{ok:true,action:'TERMINAL',status:'FAILED',reason_code:'QUANT_ENGINE_CHANGED'});
  assert.deepEqual(statuses(a.events),['ADMITTED','FAILED']);assert.equal(early.calls.length,0);
  let current=ENGINE;
  const mid=canned({onCall:index=>{if(index===1)current=H('f');}});
  const b=await runWith(world,mid,{executor:{engineHash:async()=>current}});
  assert.deepEqual([b.out.status,b.out.reason_code],['FAILED','QUANT_ENGINE_CHANGED']);
  assert.deepEqual(b.events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['FAILED','QUANT_ENGINE_CHANGED']]);
  assert.equal(mid.calls.length,2);
  // a fixed string works as the configuration, and the real closure hash is the stored one
  const fixed=await runWith(world,canned(),{executor:{engineHash:ENGINE}});
  assert.equal(fixed.out.status,'NO_VALID_CANDIDATE');
  assert.equal(fixed.run.contract_hash.length,64);
  const stored=await getMultiRun(fx,{owner_id:world.id,run_id:fixed.run.run_id});
  assert.equal(stored.run.contract.engine_hash,ENGINE);assert.equal(stored.run.engine_hash,await mpCombinedEngineHash());
});

test('member set: a Bot change before the claim or during the run ends FAILED MP_MEMBER_SET_STALE; bytes the freshness check does not read are bound too (STUB runner)',async()=>{
  // (a) the Bot funding changed after the freeze: stale before the claim
  const w1=await newWorld();
  const run1=await admitRun(w1);
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,1,1,'CONFIGURATION')",[w1.bot,T0+1]);
  const early=canned();
  const out1=await executorOn(fx,{runEvaluator:early}).execute({owner_id:w1.id,run_id:run1.run_id});
  assert.deepEqual(out1,{ok:true,action:'TERMINAL',status:'FAILED',reason_code:'MP_MEMBER_SET_STALE'});
  assert.deepEqual(statuses(await eventsOf(run1.run_id)),['ADMITTED','FAILED']);assert.equal(early.calls.length,0);
  // (b) a reviewed input changes during the run: stale before the next step
  const w2=await newWorld();
  const mid=canned({onCall:async index=>{if(index===2)await db.query("UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1",[w2.specs[1].pine]);}});
  const b=await runWith(w2,mid);
  assert.deepEqual([b.out.status,b.out.reason_code],['FAILED','MP_MEMBER_SET_STALE']);
  assert.deepEqual(b.events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['FAILED','MP_MEMBER_SET_STALE']]);
  assert.equal(mid.calls.length,3);
  // (c) the stored source bytes no longer match the frozen source hash: the executor's own binding catches it
  const w3=await newWorld();
  const run3=await admitRun(w3);
  await db.query('UPDATE pine_source_revisions SET source=source||$2 WHERE pine_import_id=$1',[w3.specs[0].pine,'\n// tampered\n']);
  const late=canned();
  const out3=await executorOn(fx,{runEvaluator:late}).execute({owner_id:w3.id,run_id:run3.run_id});
  assert.deepEqual([out3.status,out3.reason_code],['FAILED','MP_MEMBER_SET_STALE']);
  assert.equal(late.calls.length,0);
});

test('abort: a signal ends the run CANCELLED RESEARCH_INTERRUPTED before the claim, between steps, and inside a running job (REAL JOB for the last)',{timeout:300000},async()=>{
  const world=await newWorld();
  // before the claim
  const controller=new AbortController();controller.abort();
  const none=canned();
  const a=await runWith(world,none,{signal:controller.signal});
  assert.deepEqual(a.out,{ok:true,action:'TERMINAL',status:'CANCELLED',reason_code:'RESEARCH_INTERRUPTED'});
  assert.deepEqual(statuses(a.events),['ADMITTED','CANCELLED']);assert.equal(none.calls.length,0);
  // between steps (the double ignores the signal; the gate catches it)
  const second=new AbortController();
  const between=canned({onCall:index=>{if(index===1)second.abort();}});
  const b=await runWith(world,between,{signal:second.signal});
  assert.deepEqual([b.out.status,b.out.reason_code],['CANCELLED','RESEARCH_INTERRUPTED']);
  assert.deepEqual(b.events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['CANCELLED','RESEARCH_INTERRUPTED']]);
  assert.equal(between.calls.length,2);
  // inside the real job: the child is killed and the run ends CANCELLED
  const third=new AbortController();
  const real=realRunner(world);
  let started=0;
  const killing=async(payload,options)=>{started++;setTimeout(()=>third.abort(),150);return real(payload,options);};
  const c=await runWith(world,killing,{signal:third.signal});
  assert.deepEqual([c.out.status,c.out.reason_code],['CANCELLED','RESEARCH_INTERRUPTED']);
  assert.equal(started,1);assert.equal(c.events.at(-1).status,'CANCELLED');
});

/* ---- 7. claim, ownership, operator, sweep ---- */

test('only an ADMITTED run proceeds: RUNNING, terminal, unknown and foreign runs return without a write (STUB runner)',async()=>{
  const world=await shared();
  const run=await admitRun(world);
  const append=await appendRunEvent(fx,{owner_id:world.id,run_id:run.run_id,status:'RUNNING'});assert.equal(append.ok,true);
  const none=canned();
  const exec=executorOn(fx,{runEvaluator:none});
  const digest=await digestAll();
  assert.deepEqual(await exec.execute({owner_id:world.id,run_id:run.run_id}),{ok:true,action:'SKIPPED',status:'RUNNING'});
  await appendRunEvent(fx,{owner_id:world.id,run_id:run.run_id,status:'FAILED',reason_code:'EVALUATION_FAILED'});
  const afterAppend=await digestAll();
  assert.deepEqual(await exec.execute({owner_id:world.id,run_id:run.run_id}),{ok:true,action:'SKIPPED',status:'FAILED'});
  assert.deepEqual(await digestAll(),afterAppend,'a skipped run writes nothing');
  assert.notDeepEqual(afterAppend,digest);
  assert.equal(none.calls.length,0);
  // unknown, malformed and foreign ids are NOT_FOUND (F21)
  const other=await newWorld();
  const admitted=await admitRun(other);
  for(const input of [{owner_id:other.id,run_id:randomUUID()},{owner_id:other.id,run_id:'nope'},{owner_id:world.id,run_id:admitted.run_id},{owner_id:'nobody',run_id:admitted.run_id}]) {
    const out=await exec.execute(input);
    assert.equal(out.ok,false);assert.equal(out.code,'NOT_FOUND');
  }
  assert.equal(await statusOf(admitted.run_id),'ADMITTED','a foreign owner touches nothing');
});

test('the RUNNING append is the only claim: the loser of a race writes nothing and runs nothing (STUB runner)',async()=>{
  const world=await newWorld();
  const run=await admitRun(world);
  // executor 2 is held at its claim until executor 1 has finished the whole run
  let reached,release;
  const arrived=new Promise(resolve=>{reached=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  const held={get isTransaction(){return fx2.isTransaction;},prepare:sql=>fx2.prepare(sql),query:(sql,params)=>fx2.query(sql,params),
    transaction:async(fn,options)=>{if(options?.isolation==='SERIALIZABLE'){reached();await wait;}return fx2.transaction(fn,options);}};
  const loserRunner=canned(),winnerRunner=canned();
  const loser=executorOn(held,{runEvaluator:loserRunner}).execute({owner_id:world.id,run_id:run.run_id});
  await arrived;
  const winner=await executorOn(fx,{runEvaluator:winnerRunner}).execute({owner_id:world.id,run_id:run.run_id});
  assert.equal(winner.status,'NO_VALID_CANDIDATE');
  release();
  const lost=await loser;
  assert.equal(lost.ok,true);assert.equal(lost.action,'CLAIM_LOST');
  assert.equal(loserRunner.calls.length,0);assert.ok(winnerRunner.calls.length>0);
  assert.deepEqual(statuses(await eventsOf(run.run_id)),['ADMITTED','RUNNING','NO_VALID_CANDIDATE'],'one claim, one terminal event');
  // two executors started together: exactly one claims and finishes, the other returns SKIPPED or CLAIM_LOST
  const second=await newWorld();
  const run2=await admitRun(second);
  const runners=[canned(),canned()];
  const outs=await Promise.all([executorOn(fx,{runEvaluator:runners[0]}).execute({owner_id:second.id,run_id:run2.run_id}),executorOn(fx2,{runEvaluator:runners[1]}).execute({owner_id:second.id,run_id:run2.run_id})]);
  assert.deepEqual(outs.map(out=>out.action).sort(),['CLAIM_LOST','TERMINAL'].sort().length===2&&outs.some(out=>out.action==='SKIPPED')?['SKIPPED','TERMINAL']:['CLAIM_LOST','TERMINAL']);
  assert.deepEqual(statuses(await eventsOf(run2.run_id)),['ADMITTED','RUNNING','NO_VALID_CANDIDATE']);
  assert.equal(runners.filter(runner=>runner.calls.length>0).length,1,'one runner ran');
});

test('an operator who ends the run while it runs stops the executor without another write (STUB runner)',async()=>{
  const world=await newWorld();
  const run=await admitRun(world);
  const runner=canned({onCall:async index=>{if(index===1)assert.equal((await appendRunEvent(fx2,{owner_id:world.id,run_id:run.run_id,status:'CANCELLED',reason_code:'OPERATOR_STOPPED'})).ok,true);}});
  const out=await executorOn(fx,{runEvaluator:runner}).execute({owner_id:world.id,run_id:run.run_id});
  assert.deepEqual(out,{ok:true,action:'RELEASED',status:'CANCELLED'});
  assert.equal(runner.calls.length,2);
  assert.deepEqual((await eventsOf(run.run_id)).map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['CANCELLED','OPERATOR_STOPPED']]);
});

test('sweep: a RUNNING run past its deadline ends TIMED_OUT JOB_DEADLINE_EXCEEDED; every other run is left alone',async()=>{
  const world=await shared();
  const exec=(clock)=>executorOn(fx,{runEvaluator:canned(),clock});
  const run=await admitRun(world);
  assert.deepEqual(await exec(()=>DEADLINE+10).sweep({owner_id:world.id,run_id:run.run_id}),{ok:true,action:'NONE',status:'ADMITTED'},'an ADMITTED run is not swept');
  await appendRunEvent(fx,{owner_id:world.id,run_id:run.run_id,status:'RUNNING'});
  assert.deepEqual(await exec(()=>DEADLINE-1).sweep({owner_id:world.id,run_id:run.run_id}),{ok:true,action:'NONE',status:'RUNNING'},'before the deadline');
  const swept=await exec(()=>DEADLINE).sweep({owner_id:world.id,run_id:run.run_id});
  assert.deepEqual(swept,{ok:true,action:'TIMED_OUT',status:'TIMED_OUT',reason_code:'JOB_DEADLINE_EXCEEDED'});
  assert.deepEqual((await eventsOf(run.run_id)).map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['TIMED_OUT','JOB_DEADLINE_EXCEEDED']]);
  assert.deepEqual(await exec(()=>DEADLINE+10).sweep({owner_id:world.id,run_id:run.run_id}),{ok:true,action:'NONE',status:'TIMED_OUT'},'a terminal run is left alone');
  assert.equal((await exec(()=>DEADLINE).sweep({owner_id:world.id,run_id:randomUUID()})).code,'NOT_FOUND');
  assert.equal((await exec(()=>DEADLINE).sweep({owner_id:'nobody',run_id:run.run_id})).code,'NOT_FOUND');
  // an executor that crashed after its claim leaves RUNNING: the run stays RUNNING until the sweep after the deadline
  const crashed=await admitRun(world);
  await assert.rejects(executorOn(fx,{runEvaluator:async()=>{throw new TypeError('defect');}}).execute({owner_id:world.id,run_id:crashed.run_id}),{message:'defect'});
  assert.deepEqual((await eventsOf(crashed.run_id)).map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['FAILED','EVALUATION_FAILED']],'a defect ends a claimed run best effort');
});

/* ---- 8. result size, evaluation cap, dataset checks, configuration ---- */

test('a result over 1 MiB ends FAILED EVALUATION_OUTPUT_TOO_LARGE; one just under it is stored (REPLAY of a recorded run, padded with HOLDOUT decisions)',{timeout:300000},async()=>{
  // The closed response shapes bound every per-candidate record, so the only unbounded part of a result is the stored HOLDOUT decision list.
  const rec=await recorded();
  const rejected=rec.list.find(item=>item.response.kind==='HOLDOUT').response.ledger.decisions.find(decision=>decision.outcome==='REJECTED');
  const padded=count=>replay(rec,response=>{if(response.kind==='HOLDOUT'){response.ledger.decisions=Array.from({length:count},()=>structuredClone(rejected));response.decision_count=count;}});
  const sizeOf=events=>Buffer.byteLength(canonical(events.at(-1).result));
  const probe=await runWith(rec.world,padded(1000),{over:{bridge_domains:SMALL}});
  assert.equal(probe.out.status,'SUCCEEDED');
  const per=Buffer.byteLength(canonical(rejected))+1,base=sizeOf(probe.events)-1000*per;
  const countFor=bytes=>Math.floor((bytes-base)/per);
  // the executor itself refuses before the database does: a result event is never even attempted
  const attempts=[];
  const watched={get isTransaction(){return fx.isTransaction;},prepare:sql=>fx.prepare(sql),transaction:(fn,options)=>fx.transaction(fn,options),
    query:(sql,params)=>{if(/INSERT INTO public\.mp_research_run_events/.test(String(sql)))attempts.push(params?.[2]);return fx.query(sql,params);}};
  const a=await runWith(rec.world,padded(countFor(1_100_000)),{over:{bridge_domains:SMALL},db:watched});
  assert.deepEqual(attempts.filter(status=>!['RUNNING','FAILED'].includes(status)),[],'no SUCCEEDED or NO_VALID_CANDIDATE insert was attempted');
  assert.deepEqual([a.out.status,a.out.reason_code],['FAILED','EVALUATION_OUTPUT_TOO_LARGE']);
  assert.deepEqual(a.events.map(event=>[event.status,event.reason_code,event.result]),[['ADMITTED',null,null],['RUNNING',null,null],['FAILED','EVALUATION_OUTPUT_TOO_LARGE',null]]);
  const b=await runWith(rec.world,padded(countFor(800_000)),{over:{bridge_domains:SMALL}});
  assert.equal(b.out.status,'SUCCEEDED');
  const size=sizeOf(b.events);
  assert.ok(size>700_000&&size<1048576,String(size));
});

test('bars: the executor reads pine_market_bars and refuses a changed, gapped or unverified dataset (STUB runner)',async()=>{
  const world=await newWorld();
  const time=START+3000*60000;
  const original=(await db.query("SELECT bar,content_hash FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time])).rows[0];
  const previous=(await db.query("SELECT bar,content_hash FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time-60000])).rows[0];
  const restore=()=>db.query("UPDATE pine_market_bars SET bar=$2::jsonb,content_hash=$3 WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time,JSON.stringify(original.bar),original.content_hash]);
  try {
    // a row whose content hash no longer matches its bar
    const one=await admitRun(world);
    await db.query("UPDATE pine_market_bars SET bar=jsonb_set(bar,'{close}','\"1.00\"') WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time]);
    const r1=canned();
    const a=await executorOn(fx,{runEvaluator:r1}).execute({owner_id:world.id,run_id:one.run_id});
    assert.deepEqual([a.status,a.reason_code],['FAILED','VERIFIED_MARKET_DATA_REQUIRED']);assert.equal(r1.calls.length,0);
    // a consistent row (bar and hash agree) that is not the bar of the contract's digest
    const two=await admitRun(world,{budget:{candidates:29}});
    const changed={...original.bar,close:'1.00',high:'99999.00',low:'0.50'};
    await db.query("UPDATE pine_market_bars SET bar=$2::jsonb,content_hash=$3 WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time,JSON.stringify(changed),hash(canonical(changed))]);
    const b=await executorOn(fx,{runEvaluator:canned()}).execute({owner_id:world.id,run_id:two.run_id});
    assert.deepEqual([b.status,b.reason_code],['FAILED','RESEARCH_DATASET_CHANGED']);
    // a missing last bar: the dataset is shorter than the contract's count
    const three=await admitRun(world,{budget:{candidates:28}});
    const last=(await db.query("SELECT bar,content_hash FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[END])).rows[0];
    await db.query("DELETE FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[END]);
    try {
      const c=await executorOn(fx,{runEvaluator:canned()}).execute({owner_id:world.id,run_id:three.run_id});
      assert.deepEqual([c.status,c.reason_code],['FAILED','INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET']);
    } finally {
      await db.query("INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',$1,$2::jsonb,$3::jsonb,$4",[END,JSON.stringify(last.bar),JSON.stringify(PROVENANCE),last.content_hash]);
    }
    // a gap inside the range: the next row is not the expected bar
    const four=await admitRun(world,{budget:{candidates:26}});
    await db.query("DELETE FROM pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time]);
    await db.query("UPDATE pine_market_bars SET bar=$2::jsonb,content_hash=$3 WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time-60000,JSON.stringify(original.bar),original.content_hash]);
    const d=await executorOn(fx,{runEvaluator:canned()}).execute({owner_id:world.id,run_id:four.run_id});
    assert.deepEqual([d.status,d.reason_code],['FAILED','VERIFIED_MARKET_DATA_REQUIRED']);
  } finally {
    await db.query("INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',$1,$2::jsonb,$3::jsonb,$4 ON CONFLICT DO NOTHING",[time,JSON.stringify(original.bar),JSON.stringify(PROVENANCE),original.content_hash]);
    await restore();
    await db.query("UPDATE pine_market_bars SET bar=$2::jsonb,content_hash=$3 WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time=$1",[time-60000,JSON.stringify(previous.bar),previous.content_hash]);
  }
  const ok=await runWith(world,canned(),{over:{budget:{candidates:27}}});
  assert.equal(ok.out.status,'NO_VALID_CANDIDATE','the restored dataset runs again');
});

test('executor configuration is closed: db, store on the same db, reader, clock, runner and engine hash are required',()=>{
  const good=()=>({db:fx,store:new Store(fx),readBotState:async()=>({}),clock:Date.now,runEvaluator:async()=>({}),engineHash:ENGINE});
  assert.doesNotThrow(()=>new MultiPineFixtureExecutor(good()));
  for(const [label,patch] of [['db',{db:null}],['db query',{db:{}}],['store on another db',{store:new Store(fx2)}],['store',{store:null}],['reader',{readBotState:null}],['clock',{clock:7}],['runner',{runEvaluator:null}],
    ['engine hash text',{engineHash:'nope'}],['engine hash type',{engineHash:7}],['timeout',{callTimeoutMs:30001}]])
    assert.throws(()=>new MultiPineFixtureExecutor({...good(),...patch}),TypeError,label);
  assert.throws(()=>new MultiPineFixtureExecutor(),TypeError);
});

test('validateTerminalResult refuses a result that does not tie to its run or drops a guarantee',()=>{
  assert.ok(SAMPLE,'needs the result of the first test');
  const {result,run}=SAMPLE;
  const stored={run_id:run.run_id,contract_hash:run.contract_hash,contract:{engine_hash:ENGINE,acceptance_blockers:result.acceptance_blockers}};
  assert.equal(validateTerminalResult(structuredClone(result),stored).version,EXECUTOR_RESULT_VERSION);
  const bad=[['another run',r=>{r.run_id=randomUUID();}],['another contract',r=>{r.contract_hash=H('1');}],['recommendation true',r=>{r.owner_recommendation_ready=true;}],
    ['blocker removed',r=>{r.acceptance_blockers=r.acceptance_blockers.filter(item=>item!=='MULTI_PINE_REQUIRES_APP_3B');}],['not fixture',r=>{r.fixture=false;}],
    ['another engine',r=>{r.engine_hash=H('2');}],['another closure',r=>{r.closure.hash=H('2');}],['candidate count',r=>{r.candidates.pop();}],
    ['baseline missing after a holdout',r=>{r.combined_baseline=null;}],['baseline not tied to the run',r=>{r.combined_baseline.binding.run_id=randomUUID();}],
    ['baseline for another pair',r=>{r.combined_baseline.pair={atr_multiplier:'9',rr:'9'};}],['baseline without a verdict',r=>{delete r.combined_baseline.matched;}],
    ['decisions missing after a holdout',r=>{delete r.holdout_decisions;}],['holdout flag false with a baseline',r=>{r.holdout_evaluated=false;}],['wrong version',r=>{r.version='x';}]];
  for(const [label,change] of bad){
    const copy=structuredClone(result);change(copy);
    assert.throws(()=>validateTerminalResult(copy,stored),{code:'EVALUATION_FAILED'},label);
  }
  // the baseline verdict itself is NOT a validity condition: an unmatched record is stored as it is
  const unmatched=structuredClone(result);unmatched.combined_baseline.matched=false;
  assert.doesNotThrow(()=>validateTerminalResult(unmatched,stored));
});

/* ---- 9. the operator script ---- */

test('operator script: refuses without the explicit isolated-cluster flag, a loopback fixture-role connection and a fixture role; runs a run with the fixture role',{timeout:180000},async()=>{
  const script=fileURLToPath(new URL('../../scripts/mp-fixture-run.mjs',import.meta.url));
  const world=await newWorld({policy:config.defaultRisk});
  // the script runs on the real clock, so the run is admitted on the real clock too (its deadline is 15 minutes from now)
  const live=serviceOn(fx,{clock:()=>Date.now()},config.defaultRisk);
  const admitLive=async()=>{const out=await live.admit(inputOf(world));assert.equal(out.ok,true,JSON.stringify(out));return out.run;};
  const run=await admitLive();
  const ids=['--owner-id='+world.id,'--run-id='+run.run_id];
  const call=(args,env={})=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:{PATH:process.env.PATH,...(process.env.QUANT_RESEARCH_PYTHON?{QUANT_RESEARCH_PYTHON:process.env.QUANT_RESEARCH_PYTHON}:{}),...env},timeout:120000});
  // the script adds its own isolation option and refuses any query parameter, so the URLs here carry none
  const fixtureUrl=urlOf(databaseName,fixtureName);
  let out=call(ids,{MP_FIXTURE_DATABASE_URL:fixtureUrl});
  assert.equal(out.status,2);assert.match(out.stderr,/--isolated-cluster is required/);
  out=call(['--isolated-cluster',...ids]);
  assert.equal(out.status,2);assert.match(out.stderr,/MP_FIXTURE_DATABASE_URL/);
  out=call(['--isolated-cluster',...ids],{DATABASE_URL:fixtureUrl});
  assert.equal(out.status,2,'DATABASE_URL is never read');
  out=call(['--isolated-cluster',...ids],{MP_FIXTURE_DATABASE_URL:'postgresql://fixture:secret@db.example.org:5432/robot'});
  assert.equal(out.status,2);assert.match(out.stderr,/loopback/);assert.ok(!out.stderr.includes('secret'));
  // B2: pg lets `?host=` override the host of the URL, and `?options=` set search_path: every query parameter is refused before any connection
  for(const query of ['?host=remote.example','?hostaddr=203.0.113.1','?options=-c%20search_path%3Dpublic','?options=-c%20default_transaction_isolation%3Dserializable','?sslmode=disable','?',
    '?host=remote.example&options=x','#fragment'])
    {out=call(['--isolated-cluster',...ids],{MP_FIXTURE_DATABASE_URL:fixtureUrl+query});
    assert.equal(out.status,2,query);assert.match(out.stderr,/query parameter/,query);assert.ok(!out.stderr.includes('remote.example'),query);}
  out=call(['--isolated-cluster','--owner-id=x','--run-id=not-a-uuid'],{MP_FIXTURE_DATABASE_URL:fixtureUrl});
  assert.equal(out.status,2);
  out=call(['--isolated-cluster',...ids,'--bogus'],{MP_FIXTURE_DATABASE_URL:fixtureUrl});
  assert.equal(out.status,2);
  out=call(['--isolated-cluster',...ids],{MP_FIXTURE_DATABASE_URL:fixtureUrl,NODE_ENV:'production'});
  assert.equal(out.status,2);
  // the schema owner / superuser connection is not a fixture role
  out=call(['--isolated-cluster',...ids],{MP_FIXTURE_DATABASE_URL:urlOf(databaseName)});
  assert.equal(out.status,1);assert.match(out.stderr,/not the fixture role/);
  assert.equal(await statusOf(run.run_id),'ADMITTED','every refusal left the run untouched');
  // the fixture role runs it; the real source gate refuses the synthetic source, so the run ends FAILED EVALUATION_FAILED (a recorded outcome, exit status 0)
  out=call(['--isolated-cluster',...ids],{MP_FIXTURE_DATABASE_URL:fixtureUrl});
  assert.equal(out.status,0,out.stderr);
  const printed=JSON.parse(out.stdout.trim());
  assert.deepEqual([printed.ok,printed.action,printed.status,printed.reason_code,printed.run_id],[true,'TERMINAL','FAILED','EVALUATION_FAILED',run.run_id]);
  assert.deepEqual(statuses(await eventsOf(run.run_id)),['ADMITTED','RUNNING','FAILED']);
  // --sweep on a RUNNING run before its deadline changes nothing
  const next=await admitLive();
  await appendRunEvent(fx,{owner_id:world.id,run_id:next.run_id,status:'RUNNING'});
  out=call(['--isolated-cluster','--sweep','--owner-id='+world.id,'--run-id='+next.run_id],{MP_FIXTURE_DATABASE_URL:fixtureUrl});
  assert.equal(out.status,0,out.stderr);
  assert.equal(JSON.parse(out.stdout.trim()).action,'NONE');
  // an unexpected error (the database refuses a read in the middle of the run) prints one JSON line with a code and nothing else: no message, stack, SQL or table name
  const doomed=await admitLive();
  await db.query('REVOKE SELECT ON public.pine_market_bars FROM '+runtimeName);
  try{
    out=call(['--isolated-cluster','--owner-id='+world.id,'--run-id='+doomed.run_id],{MP_FIXTURE_DATABASE_URL:fixtureUrl});
  }finally{await db.query('GRANT SELECT ON public.pine_market_bars TO '+runtimeName);}
  assert.equal(out.status,1,out.stdout+out.stderr);
  assert.equal(out.stdout,'');
  assert.deepEqual(JSON.parse(out.stderr.trim()),{ok:false,error:'UNEXPECTED_ERROR'});
  assert.equal(out.stderr.trim().split('\n').length,1);
  assert.ok(!/permission|pine_market_bars|\bat \w|node:|\.js/i.test(out.stderr),'no detail leaks');
  assert.equal(await statusOf(doomed.run_id),'FAILED','the claimed run was ended best effort');
});

/* ---- 9b. S3 fix round: pre-claim race (B1), error classes, deadline cut, release at the terminal append, closed responses, read-only snapshot ---- */

/** A db handle that waits (once) at the executor's own member-set read, which is its first query after getMultiRun. */
function heldAtSetRead(inner){
  let reached,release;
  const arrived=new Promise(resolve=>{reached=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  let used=false;
  const handle={get isTransaction(){return inner.isTransaction;},prepare:sql=>inner.prepare(sql),transaction:(fn,options)=>inner.transaction(fn,options),
    query:async(sql,params)=>{if(!used&&String(sql).includes('member_set_id=$1 AND owner_id=$2')){used=true;reached();await wait;}return inner.query(sql,params);}};
  return {handle,arrived,release};
}

test('B1: a loser that stops BEFORE the claim never ends the run another executor owns (abort, engine change)',async()=>{
  for(const variant of ['abort','engine']){
    const world=await newWorld();
    const run=await admitRun(world);
    const held=heldAtSetRead(fx2);
    const controller=new AbortController();
    let engineMoved=false;
    const loserRunner=canned();
    const loser=executorOn(held.handle,{runEvaluator:loserRunner,engineHash:()=>engineMoved?'f'.repeat(64):ENGINE}).execute({owner_id:world.id,run_id:run.run_id,signal:controller.signal});
    await held.arrived;
    // the winner claims and stays RUNNING, parked inside its first step
    let running,letGo;
    const parked=new Promise(resolve=>{running=resolve;}),go=new Promise(resolve=>{letGo=resolve;});
    const winnerRunner=canned({onCall:async index=>{if(index===0){running();await go;}}});
    const winner=executorOn(fx,{runEvaluator:winnerRunner}).execute({owner_id:world.id,run_id:run.run_id});
    await parked;
    assert.deepEqual(statuses(await eventsOf(run.run_id)),['ADMITTED','RUNNING'],variant);
    // now the loser wakes up, sees the abort (or the moved engine) and must not write
    if(variant==='abort')controller.abort();else engineMoved=true;
    held.release();
    const lost=await loser;
    assert.deepEqual([lost.ok,lost.action,lost.status],[true,'CLAIM_LOST','RUNNING'],variant);
    assert.equal(loserRunner.calls.length,0,variant);
    assert.deepEqual(statuses(await eventsOf(run.run_id)),['ADMITTED','RUNNING'],variant+': the winner run is untouched');
    letGo();
    const won=await winner;
    assert.deepEqual([won.action,won.status],['TERMINAL','NO_VALID_CANDIDATE'],variant);
    assert.deepEqual(statuses(await eventsOf(run.run_id)),['ADMITTED','RUNNING','NO_VALID_CANDIDATE'],variant+': one claim, one terminal event');
  }
});

test('a defect is rethrown, never recorded as an outcome: unknown and system error codes (ENOENT, ECONNRESET, TypeError, an unknown job code) end the run FAILED EVALUATION_FAILED and throw',async()=>{
  const world=await shared();
  const makers=[()=>Object.assign(new Error('boom'),{code:'ENOENT'}),()=>Object.assign(new Error('boom'),{code:'ECONNRESET'}),()=>new TypeError('boom'),
    ()=>Object.assign(new Error('boom'),{code:'MP_NOT_A_JOB_CODE'}),()=>Object.assign(new Error('boom'),{code:'UNSUPPORTEd'}),()=>Object.assign(new Error('boom'),{code:'40001'})];
  for(const make of makers){
    const run=await admitRun(world);
    const error=make();
    const exec=executorOn(fx,{runEvaluator:async()=>{throw error;}});
    await assert.rejects(exec.execute({owner_id:world.id,run_id:run.run_id}),thrown=>thrown===error,String(error.code??error.name));
    assert.deepEqual((await eventsOf(run.run_id)).map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['FAILED','EVALUATION_FAILED']],String(error.code??error.name));
  }
  // every code the job prints is a recorded outcome; the list is the job's own
  const source=await fs.readFile(new URL('../../quant_lab/src/robot_quant/mp_combined_job.py',import.meta.url),'utf8');
  const quoted=block=>[...block.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map(match=>match[1]);
  const sets=['_GATE_CODES','_LIBRARY_CODES'].flatMap(name=>quoted(source.match(new RegExp(name+' = frozenset\\(\\{([^}]*)\\}\\)'))[1]));
  const constants=['INPUT_INVALID','SOURCE_SLOTS_FORBIDDEN','DUPLICATE_LOGIC','OUTPUT_TOO_LARGE','FAILED'].map(name=>source.match(new RegExp('^'+name+' = "([A-Z_]+)"','m'))[1]);
  assert.deepEqual([...new Set([...sets,...constants])].sort(),[...JOB_CODES].sort(),'JOB_CODES equals the code sets of mp_combined_job.py');
  for(const code of JOB_CODES){
    const {out,events}=await runWith(world,thrower(code));
    assert.deepEqual([out.status,out.reason_code],['FAILED',code==='EVALUATION_OUTPUT_TOO_LARGE'?code:'EVALUATION_FAILED'],code);
    assert.deepEqual(statuses(events),['ADMITTED','RUNNING','FAILED'],code);
  }
});

test('a step cut by the run deadline ends TIMED_OUT JOB_DEADLINE_EXCEEDED; the same timeout before the deadline stays FAILED EVALUATION_TIMED_OUT (STUB runner)',async()=>{
  const world=await shared();
  let now=NOW+1000;
  const cut=async()=>{now=DEADLINE;throw Object.assign(new Error('EVALUATION_TIMED_OUT'),{code:'EVALUATION_TIMED_OUT'});};
  const a=await runWith(world,cut,{executor:{clock:()=>now}});
  assert.deepEqual(a.out,{ok:true,action:'TERMINAL',status:'TIMED_OUT',reason_code:'JOB_DEADLINE_EXCEEDED'});
  assert.deepEqual(a.events.map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['TIMED_OUT','JOB_DEADLINE_EXCEEDED']]);
  const b=await runWith(world,async()=>{throw Object.assign(new Error('EVALUATION_TIMED_OUT'),{code:'EVALUATION_TIMED_OUT'});});
  assert.deepEqual([b.out.status,b.out.reason_code],['FAILED','EVALUATION_TIMED_OUT']);
});

test('an operator who ends the run between the last gate and the terminal append makes the executor RELEASE the run, not fail (STUB runner)',async()=>{
  const world=await newWorld();
  const run=await admitRun(world);
  let serializable=0;
  const raced={get isTransaction(){return fx.isTransaction;},prepare:sql=>fx.prepare(sql),query:(sql,params)=>fx.query(sql,params),
    transaction:async(fn,options)=>{
      if(options?.isolation==='SERIALIZABLE'&&++serializable===2)assert.equal((await appendRunEvent(fx2,{owner_id:world.id,run_id:run.run_id,status:'CANCELLED',reason_code:'OPERATOR_STOPPED'})).ok,true);
      return fx.transaction(fn,options);
    }};
  const out=await executorOn(raced,{runEvaluator:canned()}).execute({owner_id:world.id,run_id:run.run_id});
  assert.equal(serializable,2,'the claim and the terminal append');
  assert.deepEqual(out,{ok:true,action:'RELEASED',status:'CANCELLED'});
  assert.deepEqual((await eventsOf(run.run_id)).map(event=>[event.status,event.reason_code]),[['ADMITTED',null],['RUNNING',null],['CANCELLED','OPERATOR_STOPPED']]);
});

test('the world snapshot is read inside a READ ONLY transaction, the Bot-state reader included',async()=>{
  const world=await newWorld();
  const seen=[];
  const own=new Store(fx);
  const reader=storeBotState({store:own,defaultRisk:POLICY});
  const readBotState=async input=>{
    const row=(await fx.query("SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso")).rows[0];
    seen.push(row);
    return reader(input);
  };
  const run=await admitRun(world);
  const exec=new MultiPineFixtureExecutor({db:fx,store:own,readBotState,clock:()=>NOW+1000,runEvaluator:canned(),engineHash:()=>ENGINE});
  const out=await exec.execute({owner_id:world.id,run_id:run.run_id});
  assert.equal(out.status,'NO_VALID_CANDIDATE');
  assert.ok(seen.length>=2,'the reader ran at the gate and before every step');
  for(const row of seen)assert.deepEqual(row,{ro:'on',iso:'repeatable read'});
  // and a write attempted inside that snapshot is refused by the database
  const probe=new MultiPineFixtureExecutor({db:fx,store:own,readBotState:async()=>{await fx.query('CREATE TABLE public.zz_readonly_probe(a int)');return reader({bot_id:world.bot});},clock:()=>NOW+1000,runEvaluator:canned(),engineHash:()=>ENGINE});
  const next=await admitRun(world);
  await assert.rejects(probe.execute({owner_id:world.id,run_id:next.run_id}),/read-only|permission denied/i);
});

test('SQL of the executor names the public schema (no search_path lookup)',async()=>{
  const source=await fs.readFile(new URL('../../src/multi-pine/executor.js',import.meta.url),'utf8');
  const sql=[...source.matchAll(/(?:FROM|JOIN)\s+([a-z_.]+)/g)].map(match=>match[1]).filter(name=>/^(mp_|pine_|public\.)/.test(name));
  assert.ok(sql.length>=5);
  assert.deepEqual(sql.filter(name=>!name.startsWith('public.')),[],'every table is schema qualified');
});

/** One real run to the HOLDOUT, recorded: the step responses by (kind, pair), with the passing HOLDOUT metrics of withPassingHoldout. */
let RECORDED;
async function recorded(){
  if(RECORDED)return RECORDED;
  const world=await newWorld();
  const real=realRunner(world),list=[];
  const recording_=async(payload,options)=>{const response=await real(payload,options);list.push({key:canonical([payload.step.kind,payload.step.pair]),response:structuredClone(response)});return response;};
  const {out,events}=await runWith(world,withPassingHoldout(recording_),{over:{bridge_domains:SMALL}});
  assert.equal(out.status,'SUCCEEDED',JSON.stringify(events.map(event=>[event.status,event.reason_code])));
  for(const item of list)if(item.response.kind==='HOLDOUT')item.response.test=structuredClone(PASSING_TEST);
  return RECORDED={world,list};
}
const replay=(rec,mutate)=>{
  const calls=[];
  const run=async payload=>{
    calls.push(payload.step.kind);
    const found=rec.list.find(item=>item.key===canonical([payload.step.kind,payload.step.pair]));
    assert.ok(found,'the recorded run has this step');
    const response=structuredClone(found.response);
    response.run=payload.run;
    return mutate?(mutate(response,payload,calls.length-1)??response):response;
  };
  run.calls=calls;
  return run;
};

test('job responses are closed: an extra or a missing key (the four final ledger fields included), a foreign value type or a stray decision field fails the run (REPLAY of one recorded real run)',{timeout:300000},async()=>{
  const rec=await recorded();
  const first=fn=>(response,payload,index)=>{if(index===0)fn(response);};
  const holdout=fn=>response=>{if(response.kind==='HOLDOUT')fn(response);};
  const cases=[
    ['extra top-level key',first(response=>{response.extra=1;})],
    ['extra metric key',first(response=>{response.train.extra=1;})],
    ['missing metric key',first(response=>{delete response.validation.profit_factor;})],
    ['rejection count is not a count',first(response=>{response.rejections.TARGET_NOT_OPEN='many';})],
    ['rejection count is negative',first(response=>{response.rejections.TARGET_NOT_OPEN=-1;})],
    ['exit fill count is a string',first(response=>{response.exit_fill_reasons.SL='1';})],
    ['extra diagnostics key',first(response=>{response.diagnostics.extra=1;})],
    ['extra Bot funnel key',first(response=>{response.diagnostics.bot.extra=1;})],
    ['missing Bot funnel key',first(response=>{delete response.diagnostics.bot.capped;})],
    ['member funnel count is negative',first(response=>{response.diagnostics.members[0].capped=-1;})],
    ['extra member funnel key',first(response=>{response.diagnostics.members[1].extra=1;})],
    ['member funnel ordinal is wrong',first(response=>{response.diagnostics.members[0].ordinal=9;})],
    ['extra signal row key',first(response=>{response.member_signals[0].extra=1;})],
    ['extra segment key',first(response=>{response.member_signals[0].segments.train.extra=1;})],
    ['segment is missing',first(response=>{delete response.member_signals[0].segments.validation;})],
    ['extra ledger key',holdout(response=>{response.ledger.extra=1;})],
    ...['final_cash','position_quantity','position_cost','open_allocations'].map(key=>['a dropped final ledger field: '+key,holdout(response=>{delete response.ledger[key];})]),
    ['two dropped final ledger fields',holdout(response=>{delete response.ledger.final_cash;delete response.ledger.position_cost;})],
    ['the old two-key ledger (no final field)',holdout(response=>{for(const key of ['final_cash','position_quantity','position_cost','open_allocations'])delete response.ledger[key];})],
    ['final_cash is a number',holdout(response=>{response.ledger.final_cash=20000;})],
    ['final_cash is not a decimal',holdout(response=>{response.ledger.final_cash='abc';})],
    ['final_cash is NaN text',holdout(response=>{response.ledger.final_cash='NaN';})],
    ['position_quantity is null',holdout(response=>{response.ledger.position_quantity=null;})],
    ['position_cost is outside the decimal range',holdout(response=>{response.ledger.position_cost='1e999';})],
    ['open_allocations is a string',holdout(response=>{response.ledger.open_allocations='0';})],
    ['open_allocations is negative',holdout(response=>{response.ledger.open_allocations=-1;})],
    ['open_allocations is not an integer',holdout(response=>{response.ledger.open_allocations=1.5;})],
    ['open_allocations is a decimal string',holdout(response=>{response.ledger.open_allocations='0.0';})],
    ['extra HOLDOUT metric key',holdout(response=>{response.test.extra=1;})],
    ...[['quantity',1],['cash',20000],['cost',null],['quantity','abc'],['cash','NaN'],['cost','1e999'],['entry_ref',7],['entry_ref',null],['event_type','SELL'],['event_type','buy']]
      .map(([key,value])=>['FILLED decision '+key+' is '+JSON.stringify(value),holdout(response=>{response.ledger.decisions.find(decision=>decision.outcome==='FILLED')[key]=value;})]),
    // F4: a negative final state is refused
    ...[['final_cash','-1'],['position_quantity','-0.5'],['position_cost','-0.000000000000000001'],['final_cash','-20000.5']]
      .map(([key,value])=>['negative '+key+' '+value,holdout(response=>{response.ledger[key]=value;})]),
    ['extra event key',holdout(response=>{response.ledger.events[0].extra=1;})],
    ['extra FILLED decision key',holdout(response=>{response.ledger.decisions.find(decision=>decision.outcome==='FILLED').extra=1;})],
    ['missing REJECTED decision key',holdout(response=>{delete response.ledger.decisions.find(decision=>decision.outcome==='REJECTED').reason;})],
    ['unknown decision outcome',holdout(response=>{response.ledger.decisions[0].outcome='PENDING';})],
    ['decision is not an object',holdout(response=>{response.ledger.decisions[0]=null;})]];
  for(const [label,mutate] of cases){
    const runner=replay(rec,mutate);
    const {out,events}=await runWith(rec.world,runner,{over:{bridge_domains:SMALL}});
    assert.deepEqual([out.status,out.reason_code],['FAILED','EVALUATION_FAILED'],label);
    assert.deepEqual(statuses(events),['ADMITTED','RUNNING','FAILED'],label);
  }
  // the unmodified replay (the real job sends all six ledger keys) is accepted
  const plain=await runWith(rec.world,replay(rec),{over:{bridge_domains:SMALL}});
  assert.deepEqual([plain.out.status,plain.out.reason_code],['SUCCEEDED',null]);
  assert.deepEqual(Object.keys(rec.list.find(item=>item.response.kind==='HOLDOUT').response.ledger).sort(),['decisions','events','final_cash','open_allocations','position_cost','position_quantity']);
  // decimal text is compared by value: '0E-18', '0' and '0.000' are one number, and so are trailing zeros of the cash
  const spelled=await runWith(rec.world,replay(rec,holdout(response=>{
    const wider=value=>D(value).toFixed(D(value).decimalPlaces()+3);
    for(const key of ['final_cash','position_quantity','position_cost'])response.ledger[key]=wider(response.ledger[key]);
  })),{over:{bridge_domains:SMALL}});
  assert.deepEqual([spelled.out.status,spelled.out.reason_code],['SUCCEEDED',null]);
  const record=spelled.events.at(-1).result.combined_baseline;
  assert.equal(record.matched,true,JSON.stringify(record.differences));assert.equal(Object.hasOwn(record.differences,'job_final_state_vs_trace'),false);
  // F4: '-0' is zero (not below zero) and is accepted wherever the recorded value is zero; the recorded run ends flat, so position_quantity and position_cost are zero
  assert.ok(D(rec.list.find(item=>item.response.kind==='HOLDOUT').response.ledger.position_quantity).eq(0));
  const negativeZero=await runWith(rec.world,replay(rec,holdout(response=>{response.ledger.position_quantity='-0';response.ledger.position_cost='-0.000';})),{over:{bridge_domains:SMALL}});
  assert.deepEqual([negativeZero.out.status,negativeZero.out.reason_code],['SUCCEEDED',null]);
  const zeroRecord=negativeZero.events.at(-1).result.combined_baseline;
  assert.equal(zeroRecord.matched,true,JSON.stringify(zeroRecord.differences));assert.equal(Object.hasOwn(zeroRecord.differences,'job_final_state_vs_trace'),false);
});

/** The final state derived from a decision list by the test itself (independent of the executor): fills, open quantity, open allocations, the last cash and cost. */
function finalStateOf(decisions){
  const fills=decisions.filter(decision=>decision.outcome==='FILLED');
  let quantity=D(0);
  const open=new Set();
  for(const fill of fills){
    if(fill.event_type==='BUY'){quantity=quantity.plus(fill.quantity);open.add(fill.entry_ref);}
    else{quantity=quantity.minus(fill.quantity);open.delete(fill.entry_ref);}
  }
  return {fills:fills.length,quantity,open:open.size,cash:fills.at(-1).cash,cost:fills.at(-1).cost};
}

test('baseline: the Python side uses the final state the job sent; a disagreement with its own FILLED decisions is a named difference and never the run status (REPLAY of one recorded real run)',{timeout:300000},async()=>{
  const rec=await recorded();
  const holdout=fn=>response=>{if(response.kind==='HOLDOUT')fn(response);};
  const ok=async(runner)=>{
    const {out,events,run}=await runWith(rec.world,runner,{over:{bridge_domains:SMALL}});
    assert.deepEqual([out.status,out.reason_code],['SUCCEEDED',null],'the baseline never changes the status (RD-MP-30)');
    const result=events.at(-1).result;
    assert.equal(result.completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');
    assert.deepEqual(result.combined_baseline.binding,{run_id:run.run_id,contract_hash:run.contract_hash});
    return result;
  };
  // the recorded run: the job values equal the derivation, no job difference
  const clean=await ok(replay(rec));
  assert.equal(clean.combined_baseline.matched,true);assert.equal(Object.hasOwn(clean.combined_baseline.differences,'job_final_state_vs_trace'),false);
  assert.equal(Object.hasOwn(clean.combined_baseline,'job_final_state_mismatch'),false);
  // (a) one job value disagrees with the derivation: that one field is named, the record is unmatched, the oracle still compares the job's value (remaining_quantity)
  const quantity=await ok(replay(rec,holdout(response=>{response.ledger.position_quantity='0.5';})));
  assert.equal(quantity.combined_baseline.matched,false);
  assert.equal(quantity.combined_baseline.differences.job_final_state_vs_trace,1);assert.deepEqual(quantity.combined_baseline.job_final_state_mismatch,['position_quantity']);
  assert.equal(quantity.combined_baseline.differences.remaining_quantity,1,'the oracle compared the job value 0.5 with its own');
  // (b) each other field alone, then all four
  const singles={final_cash:'1',position_cost:'5',open_allocations:2};
  for(const [key,value] of Object.entries(singles)){
    const one=await ok(replay(rec,holdout(response=>{response.ledger[key]=value;})));
    assert.equal(one.combined_baseline.matched,false,key);assert.equal(one.combined_baseline.differences.job_final_state_vs_trace,1,key);assert.deepEqual(one.combined_baseline.job_final_state_mismatch,[key]);
  }
  const every=await ok(replay(rec,holdout(response=>{Object.assign(response.ledger,{final_cash:'1',position_quantity:'0.5',position_cost:'5',open_allocations:2});})));
  assert.equal(every.combined_baseline.differences.job_final_state_vs_trace,4);
  assert.deepEqual(every.combined_baseline.job_final_state_mismatch,['final_cash','position_quantity','position_cost','open_allocations']);
  // (c) a HOLDOUT that ends with an OPEN position (REPLAY-perturbed: no fixture pair ends open, so the ledger is cut after its last filled BUY).
  // The trace ends with a non-zero quantity and cost. The job values below follow the cut trace, so the cross-check finds no job difference there, and the oracle (which ran the full
  // bars) is the only side that disagrees: unmatched, status unchanged. With the job's original (flat) values the same cut trace is a named job difference.
  const cut=holdout(response=>{
    const {decisions}=response.ledger;
    const last=decisions.findLastIndex(decision=>decision.outcome==='FILLED'&&decision.event_type==='BUY');
    response.ledger.decisions=decisions.slice(0,last+1);
    response.decision_count=response.ledger.decisions.length;
    const state=finalStateOf(response.ledger.decisions);
    response.fills=state.fills;
    cut.state=state;
  });
  const follow=holdout(response=>{
    cut(response);
    const state=cut.state;
    Object.assign(response.ledger,{final_cash:state.cash,position_quantity:state.quantity.toFixed(),position_cost:state.cost,open_allocations:state.open});
  });
  const open=await ok(replay(rec,follow));
  assert.ok(cut.state.quantity.gt(0)&&D(cut.state.cost).gt(0)&&cut.state.open>=1,'the cut trace ends with an open position: '+JSON.stringify({...cut.state,quantity:cut.state.quantity.toFixed()}));
  const baseline=open.combined_baseline;
  assert.equal(baseline.matched,false);
  assert.equal(Object.hasOwn(baseline.differences,'job_final_state_vs_trace'),false,'the job values follow the cut trace, so the cross-check agrees');
  assert.equal(baseline.counts.received_decisions,open.holdout_decisions.length);
  assert.equal(baseline.differences.remaining_quantity,1);assert.ok(baseline.differences.open_allocation_count>=1);
  assert.equal(open.holdout_decisions.length,baseline.counts.received_decisions);
  const stale=await ok(replay(rec,holdout(response=>{cut(response);})));
  assert.equal(stale.combined_baseline.matched,false);
  assert.ok(stale.combined_baseline.differences.job_final_state_vs_trace>=3,JSON.stringify(stale.combined_baseline.differences));
  assert.ok(stale.combined_baseline.job_final_state_mismatch.includes('position_quantity')&&stale.combined_baseline.job_final_state_mismatch.includes('position_cost')&&stale.combined_baseline.job_final_state_mismatch.includes('open_allocations'));
  // (d) auditor item 2: a HOLDOUT response with ZERO fills. Only REJECTED decisions stay, the counts follow, the final state is the start cash with no position. The cross-check
  // derives the same state (start cash, 0, 0, 0), so no job difference is named; the oracle (which ran the full bars) is the only side that disagrees.
  const noFill=(response,payload)=>{
    if(response.kind!=='HOLDOUT')return;
    response.ledger.decisions=response.ledger.decisions.filter(decision=>decision.outcome==='REJECTED');
    response.decision_count=response.ledger.decisions.length;response.fills=0;
    Object.assign(response.ledger,{final_cash:payload.capital.cash,position_quantity:'0',position_cost:'0',open_allocations:0});
  };
  const none=await ok(replay(rec,noFill));
  assert.equal(none.combined_baseline.matched,false);
  assert.equal(Object.hasOwn(none.combined_baseline,'error'),false,'the response is consistent, so the oracle compared it');
  assert.equal(Object.hasOwn(none.combined_baseline.differences,'job_final_state_vs_trace'),false,JSON.stringify(none.combined_baseline.differences));
  assert.equal(Object.hasOwn(none.combined_baseline,'job_final_state_mismatch'),false);
  assert.equal(none.selected.holdout.fills,0);
  // (e) F5: the job and the derivation disagree AND the oracle input cannot be built (a policy key dropped from the request after the checks): the error record keeps the named difference.
  const broken=await ok(replay(rec,(response,payload)=>{
    if(response.kind!=='HOLDOUT')return;
    response.ledger.position_quantity='0.5';
    delete payload.policy.killSwitch;
  }));
  const failed=broken.combined_baseline;
  assert.equal(failed.matched,false);assert.ok(typeof failed.error==='string'&&failed.error.length>0);
  assert.equal(failed.differences.oracle_error,1);assert.equal(failed.differences.job_final_state_vs_trace,1);
  assert.deepEqual(failed.job_final_state_mismatch,['position_quantity']);
  // a failure without a disagreement stays the plain error record
  const plain=await ok(replay(rec,(response,payload)=>{if(response.kind==='HOLDOUT')delete payload.policy.killSwitch;}));
  assert.equal(plain.combined_baseline.differences.oracle_error,1);assert.equal(Object.hasOwn(plain.combined_baseline.differences,'job_final_state_vs_trace'),false);assert.equal(Object.hasOwn(plain.combined_baseline,'job_final_state_mismatch'),false);
});

/* ---- 9c. S3 fix round: the child process (environment, working directory, kill) ---- */

const PY=process.env.QUANT_RESEARCH_PYTHON??'python';

test('python runner: the child gets a minimal environment (no DATABASE_URL, no secret), PYTHONHASHSEED, and refuses secret-looking extras',{timeout:60000},async()=>{
  const planted={DATABASE_URL:'postgresql://u:p@127.0.0.1/x',MP_FIXTURE_DATABASE_URL:'postgresql://u:p@127.0.0.1/y',MP_SECRET_PROBE:'s3cret',AWS_SECRET_ACCESS_KEY:'k',GITHUB_TOKEN:'t',HOME_PROBE:'h',PGPASSWORD:'pw'};
  const saved={};
  for(const [name,value] of Object.entries(planted)){saved[name]=process.env[name];process.env[name]=value;}
  try{
    const runner=createPythonRunner({python:PY,args:['-c','import os,sys,json\njson.load(sys.stdin)\nprint(json.dumps({"keys":sorted(os.environ),"seed":os.environ.get("PYTHONHASHSEED"),"extra":os.environ.get("MP_TEST_EXTRA")}))'],env:{MP_TEST_EXTRA:'x'}});
    const seen=await runner({});
    for(const name of Object.keys(planted))assert.ok(!seen.keys.includes(name),name+' is not visible to the child');
    assert.deepEqual(seen.keys.filter(name=>!['PATH','LANG','LC_ALL','LC_CTYPE'].includes(name)).sort(),['MP_TEST_EXTRA','PYTHONHASHSEED','PYTHONPATH'],'only the minimal list and the explicit extra');
    assert.equal(seen.seed,'0');assert.equal(seen.extra,'x');
  }finally{for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
  for(const name of ['DATABASE_URL','MP_FIXTURE_DATABASE_URL','MY_SECRET','API_TOKEN','DB_PASSWORD','PGHOST','PYTHONSTARTUP','PYTHONPATH','AWS_ACCESS_KEY','bad name'])
    assert.throws(()=>createPythonRunner({python:PY,env:{[name]:'v'}}),TypeError,name);
});

test('python runner: -P and the engine directory as working directory keep a planted json.py out; no fallback to a bare python from PATH',{timeout:60000},async()=>{
  const dir=await fs.mkdtemp(tmpdir()+'/mp-planted-');
  try{
    await fs.writeFile(dir+'/json.py','raise ImportError("PLANTED json.py was imported")\n');
    await fs.writeFile(dir+'/decimal.py','raise ImportError("PLANTED decimal.py was imported")\n');
    // the working directory is the planted directory (the test-only cwd seam): the standard library still wins
    const runner=createPythonRunner({python:PY,cwd:dir,args:['-c','import sys,json,decimal\njson.load(sys.stdin)\nprint(json.dumps({"ok":True}))']});
    assert.deepEqual(await runner({}),{ok:true});
    // the default working directory is the engine tree
    const where=createPythonRunner({python:PY,args:['-c','import os,json\nprint(json.dumps({"cwd":os.getcwd().replace(chr(92),"/")}))']});
    assert.match((await where({})).cwd,/quant_lab\/src$/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
  // no interpreter configured: every call fails QUANT_PYTHON_UNAVAILABLE (it never runs "python" from PATH)
  const saved=process.env.QUANT_RESEARCH_PYTHON;
  delete process.env.QUANT_RESEARCH_PYTHON;
  try{
    const venv=await fs.access(new URL('../../quant_lab/.venv',import.meta.url)).then(()=>true,()=>false);
    if(!venv)await assert.rejects(createPythonRunner({args:['-c','print(1)']})({}),error=>error.code==='QUANT_PYTHON_UNAVAILABLE');
  }finally{if(saved!==undefined)process.env.QUANT_RESEARCH_PYTHON=saved;}
});

test('python runner: a child that ignores SIGTERM is killed with SIGKILL after the grace period (timeout and abort)',{timeout:60000},async()=>{
  const dir=await fs.mkdtemp(tmpdir()+'/mp-sigterm-');
  try{
    let n=0;
    const stubborn=()=>{const pidFile=dir+'/pid'+(++n);return {pidFile,runner:createPythonRunner({python:PY,killGraceMs:300,args:['-c',`import signal,time,os\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(pidFile)},"w").write(str(os.getpid()))\ntime.sleep(60)`]})};};
    const dead=pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};
    const within=(promise,ms)=>Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve('HUNG'),ms))]);
    // timeout
    const a=stubborn();
    const started=Date.now();
    const outcome=await within(a.runner({}, {timeoutMs:1500}).then(()=>'RESOLVED',error=>error.code),15000);
    assert.equal(outcome,'EVALUATION_TIMED_OUT');
    assert.ok(Date.now()-started<10000);
    assert.ok(dead(Number(await fs.readFile(a.pidFile,'utf8'))),'the child is gone');
    // abort
    const b=stubborn();
    const controller=new AbortController();
    setTimeout(()=>controller.abort(),1500);
    assert.equal(await within(b.runner({}, {signal:controller.signal}).then(()=>'RESOLVED',error=>error.code),15000),'RESEARCH_INTERRUPTED');
    assert.ok(dead(Number(await fs.readFile(b.pidFile,'utf8'))),'the child is gone after an abort');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

/* ---- 10. the direct-spawn runner and its pythonEvaluation limits ---- */

test('python runner: request, response and time limits, abort, relayed job code only, stderr never echoed',{timeout:120000},async()=>{
  const script=code=>createPythonRunner({python:PY,args:['-c',code]});
  const rejects=async(runner,payload,options,code,label)=>{
    await assert.rejects(runner(payload,options),error=>{assert.equal(error.code,code,label);assert.equal(error.message,code,label+': the message is the code');return true;},label);
  };
  // a good call: one JSON object in, one JSON object out; PYTHONPATH names quant_lab/src
  const ok=script('import sys,json,os\njson.load(sys.stdin)\nprint(json.dumps({"path":os.environ["PYTHONPATH"].replace(chr(92),"/").endswith("quant_lab/src")}))');
  assert.deepEqual(await ok({a:1}),{path:true});
  // the job's own code is relayed; anything that is not exactly {"error":"CODE"} is a plain failure
  await rejects(script('print(\'{"error":"MP_CROSS_SOURCE_TARGET"}\')\nraise SystemExit(1)'),{},{},'MP_CROSS_SOURCE_TARGET','job code');
  await rejects(script('print(\'{"error":"not a code"}\')\nraise SystemExit(1)'),{},{},'EVALUATION_FAILED','unsafe code');
  await rejects(script('print(\'{"error":"MP_X1","detail":"secret"}\')\nraise SystemExit(1)'),{},{},'EVALUATION_FAILED','extra key');
  await rejects(script('raise SystemExit(3)'),{},{},'EVALUATION_FAILED','empty failure');
  // exit status 0 must carry one JSON object without an error key
  for(const body of ['print("not json")','print("[1,2]")','print(\'{"error":"MP_X1"}\')','print("null")','pass'])await rejects(script(body),{},{},'INVALID_EVALUATION_RESPONSE',body);
  // stderr is discarded: a secret on stderr never reaches the error
  await assert.rejects(script('import sys\nsys.stderr.write("TOP-SECRET-SOURCE")\nraise SystemExit(1)')({}),error=>{assert.ok(!String(error.message+error.stack).includes('TOP-SECRET'));return true;});
  // response limit 2 MiB
  await rejects(script('import sys\nsys.stdout.write("x"*(3*1024*1024))'),{},{},'EVALUATION_OUTPUT_TOO_LARGE','response');
  // request limit 8 MiB: refused before any process starts (the interpreter does not even exist)
  await rejects(createPythonRunner({python:'/nonexistent/python'}),{blob:'x'.repeat(9*1024*1024)},{},'RESEARCH_REQUEST_TOO_LARGE','request');
  // an interpreter that cannot start
  await rejects(createPythonRunner({python:'/nonexistent/python'}),{},{},'QUANT_PYTHON_UNAVAILABLE','unavailable');
  // the call timeout kills the child
  const sleeper=script('import time\ntime.sleep(60)');
  const started=Date.now();
  await rejects(sleeper,{},{timeoutMs:300},'EVALUATION_TIMED_OUT','timeout');
  assert.ok(Date.now()-started<10000,'the child was killed');
  // abort: before the call, and during it
  const controller=new AbortController();controller.abort();
  await rejects(sleeper,{},{signal:controller.signal},'RESEARCH_INTERRUPTED','aborted before');
  const later=new AbortController();setTimeout(()=>later.abort(),200);
  const begun=Date.now();
  await rejects(sleeper,{},{signal:later.signal},'RESEARCH_INTERRUPTED','aborted during');
  assert.ok(Date.now()-begun<10000);
  // the module of the real job is the default
  assert.equal((await import('../../src/multi-pine/python-runner.js')).RUNNER_MODULE,'robot_quant.mp_combined_job');
});
