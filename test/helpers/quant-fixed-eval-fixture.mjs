import {randomUUID} from 'node:crypto';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {contractOf,outcomeOf} from './quant-library-fixture.mjs';
import {datasetBindingParameters,datasetBindingIdentity,pendingMetadata} from '../../src/quant-research/research-contract-v2.js';
import {contextKey} from '../../src/comparison/context.js';
import {specHashOf,validateSpec} from '../../src/comparison/ranking.js';
import {registrationHashOf,registrationBody} from '../../src/selection/hash.js';
import {QuantFixedEvalService,fixedEvalComparisonPolicyHash,fixedEvalComparisonProtocolHash} from '../../src/postgres/quant-fixed-eval.js';
import fs from 'node:fs/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {installQuantGuards} from './quant-guard-install.mjs';
import {expectedFoundationRequestV2} from '../../src/quant-research/research-contract-v2.js';
import {PACKAGE_FILES} from '../../src/quant-library/package-gates.js';
import {freezeWindow} from '../../src/postgres/selection-store.js';
import {fixedEvalEngineHash} from '../../src/postgres/quant-fixed-eval-engine.js';
import {Money} from '../../src/money.js';
import {buildFixedEvalContract,buildFixedEvalResult,fixedEvalBindingParameters,fixedEvalPendingMetadata} from '../../src/quant-research/fixed-eval-contract.js';

/** LABELLED TEST FIXTURE. This deterministic SQL double exercises admission decisions and rollback composition;
 * it does not certify PostgreSQL guards, grants, serialization or process execution. Root owns that isolated evidence.
 */
export function fixedEvalFixture({owner='fixture-owner',deployment='fixture-deployment',importId=randomUUID(),start=1800000000000,parentRunId='fixture-parent',secondRunId='fixture-parent-2',engine=hash('fixed-fixture-engine')}={}){
 const minute=60000;
 const policy={paperTrading:true,requireReduceOnlySell:true,killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,
  pauseAfterLossStreak:10000,blockHighVolatility:false,maxVolatilityPercent:100,blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',
  maxOpenPositions:3,onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,maxDailyNotional:100000000};
 const source='//@version=6\nindicator("LABELLED SYNTHETIC FE2B FIXTURE")';
 const c=contractOf({version:'v2',owner,deployment,importId,total:3250,warmup:1006,start:start-10000*minute,sourceHash:hash(source)});
 c.source=source;c.snapshot.policy=policy;c.snapshot.policy_hash=hash(canonical(policy));
 c.input_lock.selection.fixed_inputs=Object.entries({emaSlowInput:200,atrLenInput:14,stFactorInput:3.2,zoneAtrMultInput:1.15,setupExpiryInput:48,cooldownInput:8,confirmLookback:5,slAtrBufferInput:.6,minRiskATRInput:.5})
  .map(([pine_variable,effective_value],index)=>({input_id:'fixed_'+index,pine_variable,effective_value}));
 c.snapshot.selection=c.input_lock.selection;
 c.baseline_snapshot_hash=hash(canonical(c.snapshot));
 c.input_lock.lock_hash=hash(canonical({selection:c.input_lock.selection,domains:c.input_lock.domains}));
 c.plan.candidates=c.plan.candidates.map(({marker,...parameters})=>parameters);
 const metadata=pendingMetadata(c),parameters=datasetBindingParameters(c,{references:{raw:{dataset_id:hash('parent-raw'),sha256:hash('parent-raw'),metadata},
  sidecar:{sha256:hash('parent-sidecar'),bar_count:c.dataset.bar_count,first_time:c.dataset.start_time,profile:c.model.data_profile,price_tick:String(c.model.price_tick),quantity_step:String(c.model.quantity_step)}},dataset_sha256:hash('parent-files')});
 const outcome=outcomeOf(c,'QUALIFIED'),parent={run_id:parentRunId,owner_id:owner,bot_id:owner,deployment_id:c.deployment_id,status:'SUCCEEDED',contract:c,contract_hash:hash(canonical(c)),updated_at:start-100*minute,result:outcome.result};
 parent.result.dataset_hash=parameters.dataset_sha256;
 const second=structuredClone(parent);second.run_id=secondRunId;
 const spec=validateSpec({mode:'STANDARDIZED',participants:[parent.run_id,second.run_id],period:{start_ms:start,end_ms:start+200*minute},
  objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},
  benchmark:'qr3-bh-close-same-cost-v1',uncertainty:{method:null}}).spec;
 const context={mode:'STANDARDIZED',scope:c.scope,market:c.snapshot.market,data_model:{data_profile:c.model.data_profile,price_tick:'0.01',quantity_step:'0.001'},
  period:{...spec.period,evaluation_bars:200},dataset:{digest_kind:'ql3a-dataset-sha256-v1',digest:hash('future-files'),first_bar:start-1005*minute,last_bar:start+200*minute,bar_count:1206,timestamp_semantics:'verified closed-bar timestamps; half-open index end is last timestamp plus one minute'},
  engine,execution:{fill_model:'paper-close-v1',exit_semantics_version:'bridge-exit-v2'},cost_model:{version:'paper-close-v1',fee_bps:'10',slippage_bps:'1'},
  capital:{initial_cash:'1000',initial_inventory:'0',quote:'USDT'},risk_policy:fixedEvalComparisonPolicyHash(c),ledger_initialization:c.ledger_initialization,
  valuation:{price_series:'DATASET_CLOSE',grid_id:'qr3-grid-bar-close-v1',currency:'USDT',fx:'NONE',end_treatment:'MARK_AT_END_CLOSE'},benchmark:spec.benchmark,spec_hash:specHashOf(spec),validation_protocol:fixedEvalComparisonProtocolHash(c,spec)};
 const comparison={comparison_id:'fixture-comparison',owner_id:owner,mode:'STANDARDIZED',fixture:true,start_ms:start,end_ms:start+200*minute,participant_count:2,
  frozen_at_ms:start-10*minute,spec_hash:specHashOf(spec),spec_canonical:canonical(spec),spec_body_hash:hash(canonical(spec)),context_key:contextKey(context)};
 const participants=[parent,second].map((row,index)=>{const freeze={participant_id:row.run_id,source_hash:c.source_hash,context,prior_exposed_by:[]};return {participant_id:row.run_id,position:index+1,source_hash:c.source_hash,fixture:true,origin:'FIXTURE',context_key:contextKey(context),freeze_canonical:canonical(freeze),freeze_hash:hash(canonical(freeze))};});
 const state={jobs:[],foundation:[],bindings:[],status:[{seq:1,status:'SPEC_FROZEN'}],parents:[parent,second],participants,comparison,guards:6,queue:{total:0,owned:0},deny:false,serialFailures:0,exposures:[],starts:[],selectionStatus:[]};
 const calls=[];let active=false,tail=Promise.resolve();
 const db={get isTransaction(){return active;},async transaction(fn){
  let release;const before=tail;tail=new Promise(resolve=>{release=resolve;});await before;
  const saved=structuredClone({jobs:state.jobs,foundation:state.foundation,bindings:state.bindings,status:state.status,exposures:state.exposures,starts:state.starts,selectionStatus:state.selectionStatus});active=true;
  try{const value=await fn();if(state.serialFailures-->0)throw Object.assign(Error('serialization'),{code:'40001'});return value;}
  catch(error){Object.assign(state,saved);throw error;}finally{active=false;release();}
 },async query(sql,args=[]){calls.push({sql,args});let rows=[];
  if(sql==='SHOW transaction_isolation')rows=[{transaction_isolation:'serializable'}];
  else if(sql==='SHOW transaction_read_only')rows=[{transaction_read_only:'on'}];
  else if(sql==='SET TRANSACTION READ ONLY')rows=[];
  else if(sql.includes('FROM pg_catalog.pg_trigger'))rows=[{present:true,guards:state.guards}];
  else if(sql.includes('quant_foundation_scheduler'))rows=[{singleton:true}];
  else if(sql.includes('quant_research_executor_mode'))rows=[{mode:'FOUNDATION'}];
  else if(sql.includes('FROM public.users'))rows=[{id:owner}];
  else if(sql.startsWith('SELECT * FROM public.quant_comparison_specs'))rows=args[1]===owner?[comparison]:[];
  else if(sql.includes('FROM public.quant_comparison_participants'))rows=state.participants;
  else if(sql.startsWith('SELECT seq,status FROM public.quant_comparison_status_events'))rows=[state.status.at(-1)];
  else if(sql.startsWith('SELECT * FROM public.quant_jobs WHERE run_id='))rows=state.parents.concat(state.jobs).filter(row=>row.run_id===args[0]&&row.owner_id===args[1]);
  else if(sql.includes('FROM public.quant_job_steps'))rows=outcome.steps;
  else if(sql.includes('FROM public.quant_research_chunks'))rows=[{kind:'PREPARE',parameters,identity_hash:datasetBindingIdentity(c,parameters),next_bar:0,checkpoint:null,checkpoint_hash:null,unit_name:null,unit_token:null}];
  else if(sql.includes('FROM public.quant_research_foundation b')){
   const job=state.jobs.find(row=>row.run_id===args[0]);
   if(job){const f=state.foundation.find(row=>row.job_id===args[0]);rows=[{job_id:job.run_id,contract_hash:job.contract_hash,contract:f.contract,request_hash:f.contract_hash,owner_id:owner,status:'QUEUED',attempts:0,lease_token:null,result:null}];}
   else rows=[{contract_hash:parent.contract_hash,owner_id:owner,status:'SUCCEEDED'}];
  }
  else if(sql.includes('FROM pine_market_bars'))rows=[{n:(args[1]-args[0])/minute+1,first_time:args[0],last_time:args[1],bad:0,digest:hash('closed-market-content')}];
  else if(sql.includes('FROM public.quant_jobs WHERE owner_id=')&&sql.includes('idempotency_key'))rows=state.jobs.filter(row=>row.owner_id===args[0]&&row.idempotency_key===args[1]);
  else if(sql.startsWith('SELECT run_id FROM public.quant_jobs'))rows=state.jobs.filter(row=>row.contract.lineage.object_id===args[2]&&row.contract.lineage.parent_run_id===args[3]);
  else if(sql.includes('count(*)')&&sql.includes('public.quant_foundation_jobs'))rows=[state.queue];
  else if(sql.startsWith('INSERT INTO public.quant_jobs'))state.jobs.push({run_id:args[0],owner_id:args[1],bot_id:args[2],deployment_id:args[3],idempotency_key:args[4],submission_hash:args[5],contract_hash:args[6],contract:JSON.parse(args[7]),status:'QUEUED',deadline:args[9]});
  else if(sql.startsWith('INSERT INTO public.quant_foundation_owners')){}
  else if(sql.startsWith('INSERT INTO public.quant_foundation_jobs'))state.foundation.push({job_id:args[0],contract:JSON.parse(args[3]),contract_hash:args[4]});
  else if(sql.startsWith('INSERT INTO public.quant_research_foundation'))state.bindings.push({run_id:args[0],contract_hash:args[2]});
  else if(sql.startsWith('INSERT INTO public.quant_comparison_status_events'))state.status.push({seq:args[1],status:'EVALUATING'});
  else throw Error('Unexpected fixture SQL: '+sql);
  return {rows,rowCount:rows.length};
 }};
 const pineService={db,async authorize(who){if(state.deny||who!==owner)throw Object.assign(Error('NOT_FOUND'),{code:'NOT_FOUND'});}};
 const service=new QuantFixedEvalService({pineService,clock:()=>start+1000*minute,supportedSourceHash:c.source_hash,engineHash:async()=>engine});
 return {service,db,state,calls,owner,parent,c,context,participants,comparison,parentBinding:parameters,parentSteps:outcome.steps,body:{purpose:'QR3_COMPARISON',object_id:comparison.comparison_id,participant_id:parent.run_id}};
}

/** QR4 uses the production selection writer and exposure module over the same explicit SQL double. */
export function fixedEvalSelectionFixture(options){
 const f=fixedEvalFixture(options),selectionId=randomUUID(),exportId=randomUUID(),secondExport=randomUUID();
 const window={kind:'FORWARD_PAST',start_ms:f.comparison.start_ms,end_ms:f.comparison.end_ms,warmup_bars:1006,evaluation_bars:200,total_bars:1206};
 const chosen=[f.parent,f.state.parents[1]].map((p,index)=>({export_id:index?secondExport:exportId,run_id:p.run_id,package_hash:hash('package-'+index),source_hash:f.c.source_hash,rules_hash:hash('rules'),
  created_at_ms:index,validation_binding:{package_hash:hash('package-'+index),validated_at_utc:'2026-01-01T00:00:00.000Z'}})).sort((a,b)=>a.export_id.localeCompare(b.export_id));
 const universe=chosen.map((p,index)=>({run_id:p.run_id,kind:'RESEARCH_RUN',status:'PARTICIPANT',code:null,export_id:p.export_id,created_at_ms:index}));
 const registration={version:'qr4-registration-v1',owner_id:f.owner,selection_id:selectionId,fixture:true,window,participants:chosen,universe,prior_selection_ids:[],prior_selection_count:0,market:f.c.snapshot.market,
  participant_count:2,objective:{tie_tolerance_return_pp:'0.1',tie_tolerance_drawdown_pp:'0.1'},
  scope:{market:f.c.snapshot.market,data_model:f.context.data_model,cost_model:{...f.context.cost_model,risk_percent:'1'},capital:{equity:'1000',cash:'1000'},policy:{policy_version:'fixture-policy',policy_hash:f.c.snapshot.policy_hash},engine:f.context.engine}};
 const registrationHash=registrationHashOf(registration),row={...registration,body_canonical:canonical(registrationBody(registration)),registration_hash:registrationHash,frozen_at_ms:f.comparison.frozen_at_ms,admission_deadline_ms:window.end_ms+10000*60000};
 const participants=chosen.map((p,index)=>({...p,position:index+1,validation_package_hash:p.validation_binding.package_hash,validated_at_utc:p.validation_binding.validated_at_utc}));
 const freeze={dataset_hash:hash('selection-future-files'),start_ms:window.start_ms,end_ms:window.end_ms,bars_total:window.total_bars,frozen_at_ms:f.comparison.frozen_at_ms};
 const exports=chosen.map(p=>{const binding={contract_hash:f.parent.contract_hash,source_hash:f.c.source_hash,library_record_ref:{result_sha256:hash(canonical(f.parent.result))}};return {export_id:p.export_id,owner_id:f.owner,bot_id:f.owner,run_id:p.run_id,mode:'ONE_PINE',fixture:true,package_hash:p.package_hash,binding,binding_hash:hash(canonical(binding))};});
 f.state.selectionStatus=[{seq:1,event:'REGISTER',status:'SELECTION_REGISTERED'}];
 const original=f.db.query.bind(f.db);
 f.db.query=async(sql,args=[])=>{
  let rows=null;
  if(sql==='SET TRANSACTION READ ONLY'||sql.startsWith('LOCK TABLE public.quant_exposure_register'))rows=[];
  else if(sql.includes("current_setting('transaction_isolation')"))rows=[{level:'serializable'}];
  else if(sql.includes("to_regclass('public.quant_exposure_register')"))rows=[{register:'quant_exposure_register',marker:'quant_exposure_register_schema'}];
  else if(sql==='SELECT version FROM public.quant_exposure_register_schema')rows=[{version:1}];
  else if(sql.includes('FROM public.quant_exposure_register WHERE'))rows=f.state.exposures;
  else if(sql.startsWith('INSERT INTO public.quant_exposure_register')){
   const names=['exposure_id','kind','owner_id','broker','symbol','timeframe','start_ms','end_ms','comparison_id','participant_run_id','source_hash','selection_id','at_ms'];
   const exposure=Object.fromEntries(names.map((name,index)=>[name,args[index]]));f.state.exposures.push(exposure);rows=[exposure];
  }
  else if(sql.includes('FROM public.quant_selection_registrations'))rows=args[1]===f.owner||args.length===1?[row]:[];
  else if(sql.includes('FROM public.quant_selection_universe'))rows=universe.map((p,index)=>({...p,position:index+1,member_kind:p.kind,universe_status:p.status,first_code:p.code}));
  else if(sql.includes('SELECT p.export_id FROM public.quant_selection_participants'))rows=[];
  else if(sql.includes('FROM public.quant_selection_participants'))rows=sql.includes('export_id=$2')?participants.filter(p=>p.export_id===args[1]):participants;
  else if(sql.includes('FROM public.quant_selection_window_freezes'))rows=[freeze];
  else if(sql.includes('SELECT public.quant_selection_now_ms()'))rows=[{now_ms:window.end_ms+60000}];
  else if(sql.includes('FROM public.quant_selection_status_events')){
   if(sql.includes("event='FIRST_EVALUATION_START'"))rows=f.state.selectionStatus.filter(e=>e.event==='FIRST_EVALUATION_START');
   else rows=sql.includes('LIMIT 1')?[f.state.selectionStatus.at(-1)]:f.state.selectionStatus;
  }
  else if(sql.startsWith('INSERT INTO public.quant_selection_status_events')){f.state.selectionStatus.push({seq:args[1],event:args[2],status:args[3]});rows=[];}
  else if(sql.includes('FROM public.quant_selection_evaluation_starts'))rows=sql.includes('export_id=$2')?f.state.starts.filter(s=>s.export_id===args[1]):f.state.starts;
  else if(sql.startsWith('INSERT INTO public.quant_selection_evaluation_starts')){f.state.starts.push({selection_id:args[0],export_id:args[1],evaluation_run_id:args[2],parent_run_id:args[3],dataset_hash:args[4],engine_hash:args[5]});rows=[];}
  else if(sql.includes('FROM public.quant_selection_outcomes')||sql.includes('FROM public.quant_selection_replay_events'))rows=[];
  else if(sql.startsWith('SELECT run_id,contract FROM public.quant_jobs'))rows=f.state.parents;
  else if(sql.includes('FROM public.bi_exports'))rows=exports.filter(x=>x.export_id===args[0]&&x.owner_id===args[1]);
  else if(sql.includes('FROM public.bi_status_events'))rows=[{status:'EXPORT_VALIDATED'}];
  else if(sql.includes('FROM public.ql4c_validation')){const x=exports.find(x=>x.export_id===args[0]);rows=[{package_hash:x.package_hash,binding_hash:x.binding_hash,fixture:true,validated_at_utc:'2026-01-01T00:00:00.000Z'}];}
  if(rows===null)return original(sql,args);f.calls.push({sql,args});return {rows,rowCount:rows.length};
 };
 return {...f,registration,row,freeze,exports,body:{purpose:'QR4_SELECTION',object_id:selectionId,participant_id:exportId}};
}

/** Disposable PostgreSQL fixture. It seeds labelled synthetic terminal parents through the nonterminal insertion path,
 * keeps every installed guard active, and never launches a server, worker, Python child or market producer.
 */
export async function fixedEvalPostgresFixture(connection){
 const admin=new PostgresDatabase({connectionString:connection}),name='fe2b_admission_'+randomUUID().replaceAll('-','');
 let db,closed=false;
 const close=async()=>{
  if(closed)return;closed=true;
  try{await db?.close();await admin.query('DROP DATABASE IF EXISTS '+name);}
  finally{await admin.close();}
 };
 try{
  await admin.query('CREATE DATABASE '+name);const target=new URL(connection);target.pathname='/'+name;
  db=new PostgresDatabase({connectionString:target.toString(),max:6});await db.migrate();
  for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql',
   'quant-exposure-register.sql','best-inputs-package-schema.sql','quant-selection.sql','quant-comparison.sql'])
   await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  await installQuantGuards(db);await db.query("UPDATE public.quant_research_executor_mode SET mode='FOUNDATION'");
  const store=new Store(db),user=await store.createUser({email:'fe2b-'+randomUUID()+'@example.test',passwordHash:'unused-labelled-fixture-hash'});
  const deployment=randomUUID(),importId=randomUUID(),start=Math.floor(Date.now()/60000)*60000-2*86400000;
  const f=fixedEvalSelectionFixture({owner:user.id,deployment,importId,start,parentRunId:randomUUID(),secondRunId:randomUUID(),engine:await fixedEvalEngineHash()});
  await db.query('INSERT INTO public.pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,f.c.source_hash,'LABELLED SYNTHETIC FE2B',f.c.source,'{}',Date.now()]);
  await db.query("INSERT INTO public.pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
   [deployment,user.id,importId,JSON.stringify(f.c.snapshot),hash(canonical(f.c.snapshot)),Date.now()]);
  for(const parent of f.state.parents)await db.transaction(async()=>{
   const now=parent.updated_at,request=expectedFoundationRequestV2(f.c,900000);
   await db.query("INSERT INTO public.quant_jobs(run_id,owner_id,bot_id,deployment_id,idempotency_key,submission_hash,contract_hash,contract,status,created_at,updated_at,deadline) VALUES($1,$2,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$8,$9)",
    [parent.run_id,user.id,deployment,'parent:'+parent.run_id,hash('parent-submission'),parent.contract_hash,JSON.stringify(f.c),now,now+900000]);
   for(const step of f.parentSteps)await db.query('INSERT INTO public.quant_job_steps(run_id,step_id,kind,parameters,result,completed_at) VALUES($1,$2,$3,$4,$5,$6)',
    [parent.run_id,step.step_id,step.kind,JSON.stringify(step.parameters),JSON.stringify(step.result),step.completed_at]);
   await db.query('INSERT INTO public.quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[user.id]);
   await db.query("INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7)",
    [parent.run_id,user.id,'parent:'+parent.run_id,JSON.stringify(request),hash(canonical(request)),now,now+900000]);
   await db.query('INSERT INTO public.quant_research_foundation VALUES($1,$2,$3)',[parent.run_id,parent.run_id,parent.contract_hash]);
   await db.query("INSERT INTO public.quant_research_chunks(run_id,step_id,kind,parameters,identity_hash) VALUES($1,'prepare:dataset','PREPARE',$2,$3)",
    [parent.run_id,JSON.stringify(f.parentBinding),datasetBindingIdentity(f.c,f.parentBinding)]);
   await db.query("UPDATE public.quant_jobs SET status='SUCCEEDED',phase='COMPLETE',result=$2 WHERE run_id=$1",[parent.run_id,JSON.stringify(parent.result)]);
  });
  const utc='2026-01-01T00:00:00.000Z',at=Date.UTC(2026,0,1);
  for(const x of f.exports){
   const files=Object.fromEntries(PACKAGE_FILES.map(path=>[path,Buffer.from('LABELLED SYNTHETIC FE2B FIXTURE\n'+x.run_id+'\n'+path)]));
   x.package_hash=hash(files['quant-data/manifest.json']);Object.assign(x.binding,{owner_id:user.id,bot_id:user.id,run_id:x.run_id,mode:'ONE_PINE',fixture:true,created_at:utc});x.binding_hash=hash(canonical(x.binding));
   const participant=f.registration.participants.find(p=>p.export_id===x.export_id);participant.package_hash=x.package_hash;participant.validation_binding.package_hash=x.package_hash;
   await db.transaction(async()=>{
    for(const bytes of Object.values(files))await db.query('INSERT INTO public.bi_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[hash(bytes),bytes.length,bytes]);
    await db.query(`INSERT INTO public.bi_exports(export_id,owner_id,bot_id,run_id,parent_export_id,mode,internal,fixture,gate_version,library_versions,binding,binding_hash,package_hash,b0,created_at,created_at_utc)
     VALUES($1,$2,$2,$3,NULL,'ONE_PINE',false,true,'best-inputs-gates-v1','{}',$4,$5,$6,'{"gate":"B0","state":"PASS","codes":[]}',$7,$8)`,
     [x.export_id,user.id,x.run_id,JSON.stringify(x.binding),x.binding_hash,x.package_hash,at,utc]);
    for(const [path,bytes] of Object.entries(files))await db.query('INSERT INTO public.bi_package_files(export_id,path,sha256,bytes) VALUES($1,$2,$3,$4)',[x.export_id,path,hash(bytes),bytes.length]);
    await db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,1,'EXPORT_CANDIDATE','{}',NULL,$2,$3)",[x.export_id,at+1,utc]);
   },{isolation:'SERIALIZABLE'});
   await db.transaction(async()=>{
    const attempt=randomUUID();
    await db.query("INSERT INTO public.bi_attempts(export_id,attempt_no,attempt_id,package_hash,pass,codes,gate_results,evidence_refs,validator_engine_hash,validated_at_ms,validated_at_utc) VALUES($1,1,$2,$3,true,'{}','[]','{}',$4,$5,$6)",[x.export_id,attempt,x.package_hash,hash('validator'),at+2,utc]);
    await db.query("INSERT INTO public.ql4c_validation(export_id,package_hash,binding_hash,attempt_id,gate_results,validator_engine_hash,fixture,validated_at_ms,validated_at_utc) VALUES($1,$2,$3,$4,'[]',$5,true,$6,$7)",[x.export_id,x.package_hash,x.binding_hash,attempt,hash('validator'),at+3,utc]);
    await db.query("INSERT INTO public.bi_status_events(export_id,seq,status,codes,attempt_no,at_ms,at_utc) VALUES($1,2,'EXPORT_VALIDATED','{}',1,$2,$3)",[x.export_id,at+4,utc]);
   },{isolation:'SERIALIZABLE'});
  }
  await db.transaction(async()=>{
   const reg=f.registration,w=reg.window,now=(await db.query('SELECT public.quant_selection_now_ms() AS now')).rows[0].now;
   Object.assign(reg,{registration_key:hash(randomUUID()),registered_at_ms:now,admission_deadline_ms:now+86400000});
   const body=canonical(registrationBody(reg)),digest=registrationHashOf(reg);
   await db.query(`INSERT INTO public.quant_selection_registrations(selection_id,owner_id,fixture,broker,symbol,timeframe,window_kind,start_ms,end_ms,warmup_bars,evaluation_bars,total_bars,participant_count,admission_deadline_ms,registered_at_ms,registration_key,registration_hash,body_canonical)
    VALUES($1,$2,true,'binance-global','BTCUSDT','1','FORWARD_PAST',$3,$4,$5,$6,$7,2,$8,$9,$10,$11,$12)`,[reg.selection_id,user.id,w.start_ms,w.end_ms,w.warmup_bars,w.evaluation_bars,w.total_bars,reg.admission_deadline_ms,now,reg.registration_key,digest,body]);
   for(const [index,p] of reg.universe.entries())await db.query('INSERT INTO public.quant_selection_universe(selection_id,position,run_id,member_kind,universe_status,first_code,export_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[reg.selection_id,index+1,p.run_id,p.kind,p.status,p.code,p.export_id]);
   for(const [index,p] of reg.participants.entries())await db.query('INSERT INTO public.quant_selection_participants(selection_id,export_id,position,run_id,package_hash,source_hash,rules_hash,validation_package_hash,validated_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[reg.selection_id,p.export_id,index+1,p.run_id,p.package_hash,p.source_hash,p.rules_hash,p.validation_binding.package_hash,p.validation_binding.validated_at_utc]);
   await db.query("INSERT INTO public.quant_selection_status_events(selection_id,seq,event,status) VALUES($1,1,'REGISTER','SELECTION_REGISTERED')",[reg.selection_id]);
  },{isolation:'SERIALIZABLE'});
  const times=[],bars=[],hashes=[];
  for(let index=0;index<f.registration.window.total_bars;index++){
   const time=start-1006*60000+60000+index*60000,bar={time,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
   times.push(time);bars.push(JSON.stringify(bar));hashes.push(hash(canonical(bar)));
  }
  f.freeze.dataset_hash=hash(canonical(times.map((bar_time,index)=>({bar:JSON.parse(bars[index]),content_hash:hashes[index],provenance:{profile:'closed-ohlcv-atr14-v1'}}))));
  const frozen=await freezeWindow(db,{owner_id:user.id,selection_id:f.body.object_id,dataset_hash:f.freeze.dataset_hash});
  if(!frozen.ok)throw Error('Synthetic window freeze refused: '+frozen.code);
  await db.query("INSERT INTO public.pine_market_bars SELECT 'binance-global','BTCUSDT','1',x.t,x.b::jsonb,'{\"profile\":\"closed-ohlcv-atr14-v1\"}'::jsonb,x.h FROM unnest($1::bigint[],$2::text[],$3::text[]) x(t,b,h)",[times,bars,hashes]);
  const service=new QuantFixedEvalService({pineService:new PineBridgeService(store),supportedSourceHash:f.c.source_hash,engineHash:async()=>f.context.engine});
  return {...f,db,store,service,close,connectionString:target.toString()};
 }catch(error){await close();throw error;}
}

/* ---- QR-4 slice Q4-A: a LABELLED SYNTHETIC fixed-evaluation run for one participant of one object (selection or comparison) ----
 * The contract, binding, dataset rows and fixed-eval-result-v1 are built through the real builders (so the real validators accept them). The "evaluator"
 * figures come from an independent Money ledger, never from the code under test. Every fill, price and number is a fixture, never a research result.
 * Scenario: scored bar 2k closes at closes[0] and bar 2k+1 at closes[1]; trade k buys on bar 2k and sells on bar 2k+1 (k below trades), so the run is flat
 * after the last sell. Base prices are the close plus or minus 0.1 (slippage 0.1 per unit), stress prices plus or minus 0.2; fees are fee_bps of the notional.
 */
const QR4_MINUTE=60000;
const QR4_POLICY={killSwitch:false,maxSignalAgeSeconds:120,maxTradesPerDay:1000,maxDailyLossR:10000,pauseAfterLossStreak:10000,blockHighVolatility:false,maxVolatilityPercent:100,
 blockDuringNews:false,allowedSymbols:['BTCUSDT'],sideMode:'BOTH',maxOpenPositions:3,onePositionPerSymbol:false,capPercentEquitySize:true,maxRiskPercent:100,maxOrderNotional:10000,
 maxDailyNotional:100000000};
const QR4_INPUTS={ema_fast:3,ema_slow:8,atr_len:14,st_factor:3.2,zone_atr_mult:1.15,setup_expiry:48,cooldown:0,confirm_lookback:5,sl_atr_buffer:0.6,min_risk_atr:0.5};
const QR4_COST={version:'paper-close-v1',data_profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:'0.001',fee_bps:'10',slippage_bps:'10',risk_percent:'1'};

/** Independent ledger of the fixture: cash, inventory, mark-to-close NAV on the scored closes, drawdown from the initial NAV, in-market bars. */
export function qr4Ledger(closes,fills,cash0){
 let cash=new Money(cash0),held=new Money(0),peak=cash,drawdown=new Money(0),fees=new Money(0),slippage=new Money(0),inMarket=0,nav=cash;
 closes.forEach((close,bar)=>{
  for(const fill of fills.filter(item=>item.bar===bar)){
   const notional=new Money(fill.quantity).mul(fill.price);
   cash=fill.side==='BUY'?cash.minus(notional).minus(fill.fee):cash.plus(notional).minus(fill.fee);
   held=fill.side==='BUY'?held.plus(fill.quantity):held.minus(fill.quantity);
   fees=fees.plus(fill.fee);slippage=slippage.plus(fill.cost);
  }
  nav=cash.plus(held.mul(close));
  if(held.gt(0))inMarket+=1;
  if(nav.gt(peak))peak=nav;
  const down=peak.minus(nav).div(peak).mul(100);
  if(down.gt(drawdown))drawdown=down;
 });
 return {nav,fees,slippage,inMarket,held,drawdown,returnPercent:nav.div(cash0).minus(1).mul(100)};
}

/**
 * window: {start_ms, end_ms, warmup_bars, evaluation_bars, total_bars} (a registration window or the period of a comparison with its warm-up).
 * Returns {contract, binding, rows, result, closes, base, stress} where base and stress are the plain (cloneable, decimal string) ledger figures of the two steps.
 * purpose QR3_COMPARISON gives step results with selection_id null (the fixed-evaluation contract rule), QR4_SELECTION the object id.
 */
export function qr4FixedRunWorld({purpose='QR4_SELECTION',objectId,parentRunId,window,engine,datasetSha=hash('qr4-fixture-files'),owner='owner-1',bot='bot-1',deployment='deployment-1',
 cash='10000',trades=6,size='10',closes:pair=['100','110'],cost={},quantityStep='0.001',parentHash=hash('qr4-fixture-parent-contract')}={}){
 const warmup=window.warmup_bars,bars=window.total_bars,first=window.start_ms-warmup*QR4_MINUTE+QR4_MINUTE,end=window.end_ms,S=window.start_ms;
 if(bars!==warmup+window.evaluation_bars||2*trades>window.evaluation_bars)throw Error('The fixture window cannot hold the trades');
 const model={...QR4_COST,quantity_step:quantityStep,...cost};
 const contract=buildFixedEvalContract({purpose,owner_id:owner,bot_id:bot,deployment_id:deployment,lineage:{parent_run_id:parentRunId,parent_contract_hash:parentHash,object_id:objectId},
  engine_hash:engine,parameters:{inputs:{...QR4_INPUTS},atr_multiplier:'2',rr:'1.5'},capital:{initial_cash:cash,initial_equity:cash,initial_inventory:'0',quote:'USDT'},
  policy:{...QR4_POLICY},parent_policy:{...QR4_POLICY,paperTrading:true,requireReduceOnlySell:true},cost_model:model,
  dataset:{start_time:first,end_time:end,warmup_bars:warmup,content_digest:hash('qr4-fixture-content')},parent_dataset_range:{start_time:first-5000*QR4_MINUTE,end_time:first-QR4_MINUTE}});
 const metadata=fixedEvalPendingMetadata(contract);
 const sidecar={sha256:hash('qr4-fixture-sidecar'),bar_count:bars,first_time:first,profile:'closed-ohlcv-atr14-v1',price_tick:'0.01',quantity_step:quantityStep};
 const binding=fixedEvalBindingParameters(contract,{references:{raw:{dataset_id:hash('qr4-fixture-raw'),sha256:hash('qr4-fixture-raw'),metadata},sidecar},dataset_sha256:datasetSha});
 const evaluated=bars-warmup;
 const closes=Array.from({length:evaluated},(_,index)=>pair[index%2]);
 const rows=Array.from({length:bars},(_,index)=>({time:first+index*QR4_MINUTE,open:'100',high:'111',low:'98',close:index<warmup?'100':closes[index-warmup],volume:'1',atr14:'1.5'}));
 const fillsOf=factor=>{
  const slip=new Money('0.1').mul(factor),bps=new Money(model.fee_bps).mul(factor),list=[];
  for(let k=0;k<trades;k++){
   const buy=new Money(pair[0]).plus(slip),sell=new Money(pair[1]).minus(slip);
   for(const [bar,side,price] of [[2*k,'BUY',buy],[2*k+1,'SELL',sell]])
    list.push({bar,side,quantity:size,price:price.toFixed(),fee:new Money(size).mul(price).mul(bps).div(10000).toFixed(),cost:new Money(size).mul(slip).toFixed()});
  }
  return list;
 };
 const step=(kind,fills)=>{
  const factor=kind==='EVALUATION_STRESS'?2:1,led=qr4Ledger(closes,fills,cash),sells=fills.filter(fill=>fill.side==='SELL').length;
  return {version:'fixed-eval-v1',evaluator_closure:'fixed-eval-closure-v1',kind,cost_stress:{fee_multiplier:String(factor),slippage_multiplier:String(factor)},
   model:{price_tick:'0.01',quantity_step:quantityStep,fee_bps:new Money(model.fee_bps).mul(factor).toFixed(),slippage_bps:new Money(model.slippage_bps).mul(factor).toFixed(),
    risk_percent:model.risk_percent,version:'paper-close-v1'},
   bridge:{atr_multiplier:'2',rr:'1.5'},initial_equity:cash,split:{warmup,end:bars,evaluated_bars:evaluated},engine_hash:engine,dataset_sha256:binding.dataset_sha256,
   parent_run_id:parentRunId,selection_id:purpose==='QR4_SELECTION'?objectId:null,metrics_precision:80,
   metrics:{end_equity:led.nav.toFixed(),net_return_percent:led.returnPercent.toFixed(),max_drawdown_percent:led.drawdown.toFixed(),closed_trades:sells},
   fills:fills.map((fill,index)=>({event_type:fill.side==='BUY'?'BUY':'EXIT',time:S+fill.bar*QR4_MINUTE+QR4_MINUTE,price:fill.price,quantity:fill.quantity,fee:fill.fee,sequence:index+1,
    notional:new Money(fill.quantity).mul(fill.price).toFixed(),bar_time_ms:S+fill.bar*QR4_MINUTE,side:fill.side,slippage_cost_incl_tick:fill.cost})),
   fees_total:led.fees.toFixed(),slippage_cost_incl_tick_total:led.slippage.toFixed(),
   exposure:{bars_in_market:led.inMarket,bars:evaluated,fraction:new Money(led.inMarket).div(evaluated).toDecimalPlaces(18,Money.ROUND_HALF_EVEN).toFixed()},
   episodes:{completed_count:trades,completed:Array.from({length:trades},(_,k)=>({open_bar_time_ms:S+2*k*QR4_MINUTE,allocations:1,close_bar_time_ms:S+(2*k+1)*QR4_MINUTE}))},closed_allocations:sells,
   open_position:{quantity:led.held.toFixed(),allocations:0,mark_close:closes[closes.length-1],open_episode:null},
   rejected:{total:3,intents_total:2,orphan_exits:{warmup_entry:1,refused_entry:0},
    by_event_type_and_reason:[{event_type:'BUY',reason:'MAX_OPEN_POSITIONS',count:2},{event_type:'EXIT',reason:'TARGET_NOT_OPEN',count:1}]}};
 };
 const baseFills=fillsOf(1),stressFills=fillsOf(2);
 const result=buildFixedEvalResult(contract,binding,{base:step('EVALUATION',baseFills),stress:step('EVALUATION_STRESS',stressFills)},{version:'fixed-eval-closure-v1',hash:engine});
 const plain=led=>({nav:led.nav.toFixed(),fees:led.fees.toFixed(),slippage:led.slippage.toFixed(),drawdown:led.drawdown.toFixed(),returnPercent:led.returnPercent.toFixed(),inMarket:led.inMarket});
 return {contract,binding,rows,result,closes,base:plain(qr4Ledger(closes,baseFills,cash)),stress:plain(qr4Ledger(closes,stressFills,cash))};
}
