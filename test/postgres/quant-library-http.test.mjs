import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {QuantLibraryService,quantLibraryRoutes} from '../../src/postgres/quant-library.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {httpClient} from '../helpers.mjs';
import {contractOf,runOf,seedRun,seedFoundation,MARKERS,T0,MINUTE,FIXTURE_LABEL} from '../helpers/quant-library-fixture.mjs';

// Quant Research Library APIs (P1-E): read-only, owner-scoped. Every run is a LABELLED FIXTURE written with plain inserts.
const HIDDEN=[MARKERS.source,MARKERS.bar,MARKERS.plan,MARKERS.policy,MARKERS.lease,MARKERS.worker,MARKERS.references,MARKERS.idempotency,MARKERS.submission];
const PATH='/api/quant/library';
let admin,db,store,databaseName;const children=[];

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_qlib_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
  await install('pine-bridge-schema.sql');
  store=new Store(db);
});
after(async()=>{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
  await db?.close();
  if(admin){if(databaseName)await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.close();}
});
const install=async name=>db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8')));

async function startServer(env={}){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:db.pool.options.connectionString,HOST:'127.0.0.1',PORT:String(port),
    PUBLIC_ORIGIN:base,SMTP_HOST:'',PINE_BRIDGE_ENABLED:'',QUANT_RESEARCH_ENABLED:'',PINE_AI_MODEL:'',PINE_AI_API_KEY:'',...env}});
  children.push(child);let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let ready=false;
  for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null&&!ready;i++){try{await fetch(base+'/healthz');ready=true;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.ok(ready,'server did not start: '+output.slice(-1500));
  // A child ended by a signal has exitCode null but a signalCode, so both are checked before waiting for its exit event.
  const stop=async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}};
  return {base,request:httpClient(base),child,stop};
}
async function newOwner(label){
  const password='qlib-'+randomUUID(),user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword(password)});
  await store.setRisk(user.id,structuredClone(config.defaultRisk));
  const importId=randomUUID(),deployment=randomUUID(),snapshot={marker:MARKERS.policy};
  await db.query('INSERT INTO pine_sources VALUES($1,$2,$2,1,$3,$4,$5,$6,$7)',[importId,user.id,hash(importId),'Library fixture',MARKERS.source,'{}',T0]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$2,$3,1,$4,$5,'READY',$6)",
    [deployment,user.id,importId,JSON.stringify(snapshot),hash(canonical(snapshot)),T0]);
  return {id:user.id,email:user.email,password,importId,deployment};
}
async function login(server,owner){
  const answer=await server.request('/api/auth/login','POST',{email:owner.email,password:owner.password});
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  return answer.session;
}
const get=(server,session,path)=>server.request(path,'GET',undefined,session);
const noMarkers=(body,extra=[])=>{
  const text=JSON.stringify(body);
  for(const marker of [...HIDDEN,...extra])assert.ok(!text.includes(marker),'leaked '+marker);
};
const seed=(owner,run,options={})=>seedRun(db,run,{owner:owner.id,deployment:owner.deployment,...options});
const make=(owner,options)=>runOf({owner:owner.id,deployment:owner.deployment,importId:owner.importId,...options});
let A,B,C,server,sessionA,sessionB,sessionC;

test('absent research tables: the list reads as empty, a run is not found, and a session is required',async()=>{
  A=await newOwner('qlib-a');B=await newOwner('qlib-b');C=await newOwner('qlib-c');
  server=await startServer();
  assert.equal((await server.request(PATH)).status,401,'a session is required');
  sessionA=await login(server,A);
  assert.equal((await db.query("SELECT to_regclass('quant_jobs') present")).rows[0].present,null);
  const answer=await get(server,sessionA,PATH);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.deepEqual(answer.body,{version:'quant-library-v1',rules:{classes:'library-class-v1',compatibility:'library-compat-v1',qualification:'library-qualification-v1'},
    schema_present:false,admission_enabled:false,totals:{all:0,ACTIVE:0,COMPLETED:0,INSUFFICIENT:0,FAILED:0,CANCELLED:0},qualified_total:0,qualified_winner:null,next_before:null,runs:[]});
  const id=randomUUID();
  for(const path of [PATH+'/runs/'+id,PATH+'/compare?run_id='+id+'&run_id='+randomUUID()]){
    const missing=await get(server,sessionA,path);
    assert.equal(missing.status,404,path);assert.equal(missing.body.code,'NOT_FOUND');
  }
});

test('request validation: fixed codes for the query, the path and the method, before anything is read',async()=>{
  const bad=async(path,status,code)=>{const answer=await get(server,sessionA,path);assert.equal(answer.status,status,path);assert.equal(answer.body.code,code,path);};
  for(const query of ['?limit=0','?limit=51','?limit=-1','?limit=abc','?limit=1.5','?limit=','?limit=1e1','?limit=%205','?limit=1000'])await bad(PATH+query,400,'INVALID_LIMIT');
  for(const query of ['?limit=5&limit=6','?before=1:x&before=2:y','?owner_id='+B.id,'?offset=1','?bot_id=a&bot_id=b'])await bad(PATH+query,400,'INVALID_FIELDS');
  for(const cursor of ['x','1','1:','1:abc','abc:'+randomUUID(),'12345678901234567:'+randomUUID(),'1:'+randomUUID().toUpperCase(),'1:'+randomUUID()+'x','-1:'+randomUUID()])await bad(PATH+'?before='+encodeURIComponent(cursor),400,'INVALID_CURSOR');
  const [one,two,three,four,five]=Array.from({length:5},()=>randomUUID());
  await bad(PATH+'/compare',400,'COMPARE_RUN_COUNT');await bad(PATH+'/compare?run_id='+one,400,'COMPARE_RUN_COUNT');
  await bad(PATH+'/compare?'+[one,two,three,four,five].map(id=>'run_id='+id).join('&'),400,'COMPARE_RUN_COUNT');
  await bad(PATH+'/compare?run_id='+one+'&run_id=not-a-uuid',400,'INVALID_RUN_ID');await bad(PATH+'/compare?run_id='+one+'&run_id='+two.toUpperCase(),400,'INVALID_RUN_ID');
  await bad(PATH+'/compare?run_id='+one+'&run_id='+one,400,'DUPLICATE_RUN_ID');
  await bad(PATH+'/compare?run_id='+one+'&run_id='+two+'&other=1',400,'INVALID_FIELDS');
  await bad(PATH+'/compare?run_id='+one+'&run_id='+two+'&bot_id=a&bot_id=b',400,'INVALID_FIELDS');
  for(const path of [PATH+'/runs/not-a-uuid',PATH+'/runs/'+one.toUpperCase(),PATH+'/runs/',PATH+'/runs/'+one+'/more',PATH+'/other',PATH+'/runs'])await bad(path,404,'NOT_FOUND');
  await bad(PATH+'/runs/'+one+'?limit=5',400,'INVALID_FIELDS');
  for(const path of [PATH,PATH+'/runs/'+one,PATH+'/compare',PATH+'/other'])for(const method of ['POST','PUT','DELETE'])assert.equal((await server.request(path,method,{},sessionA)).body.code,'METHOD_NOT_ALLOWED',method+' '+path);
  for(const query of ['?limit=1','?limit=50','?limit=005','?bot_id='+A.id+'&limit=5','?bot_id=all'])assert.equal((await get(server,sessionA,PATH+query)).status,200,query);
});

// Owner A: one run per class. Owner B has one run of its own. All share one context (tag a) except the run with another dataset (tag b).
const AT=index=>T0+index*3_600_000;
let runs;
async function seedLegacy(){
  await install('quant-research-schema.sql');
  const spec={
    noValid:{scenario:'NO_VALID',candidates:12,at:AT(1)},pending:{scenario:'PENDING',at:AT(2)},robustness:{scenario:'ROBUSTNESS',at:AT(3)},
    holdoutFew:{scenario:'HOLDOUT_FEW',at:AT(4)},failed:{status:'FAILED',diagnostic:'QUANT_ENGINE_CHANGED',partial:2,at:AT(5)},
    noData:{status:'FAILED',diagnostic:'VERIFIED_MARKET_DATA_REQUIRED',at:AT(6)},timedOut:{status:'TIMED_OUT',diagnostic:'JOB_DEADLINE_EXCEEDED',partial:3,at:AT(7)},
    cancelled:{status:'CANCELLED',partial:1,at:AT(8)},running:{status:'RUNNING',partial:4,at:AT(9)},queued:{status:'QUEUED',at:AT(10)},
    other:{scenario:'NO_VALID',candidates:6,tag:'b',at:AT(11)}};
  runs={};
  for(const [name,options] of Object.entries(spec)){
    runs[name]=make(A,options);
    await seed(A,runs[name],options.status==='RUNNING'?{leaseToken:MARKERS.lease}:{});
  }
  runs.foreign=make(B,{scenario:'PENDING',at:AT(12)});await seed(B,runs.foreign);
}
const LIST_KEYS=['candidates','compatibility_key','completion_reason','contract_version','cost','created_at','dataset','development_score','diagnostic','engine_family','engine_hash','finished_at',
  'input_lock_hash','integrity_checked','library_class','library_group','market','phase','policy_hash','qualification','run_id','source_hash','status'];
const byId=body=>Object.fromEntries(body.runs.map(run=>[run.run_id,run]));

test('list: owner-scoped runs, newest first, one class and group per run, raw status and diagnostic always shown',async()=>{
  await seedLegacy();sessionB=await login(server,B);sessionC=await login(server,C);
  const answer=await get(server,sessionA,PATH);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.equal(body.schema_present,true);assert.equal(body.admission_enabled,false);assert.equal(body.qualified_total,0);assert.equal(body.qualified_winner,null);assert.equal(body.next_before,null);
  assert.deepEqual(body.totals,{all:11,ACTIVE:2,COMPLETED:4,INSUFFICIENT:2,FAILED:2,CANCELLED:1});
  assert.deepEqual(body.runs.map(run=>run.run_id),['other','queued','running','cancelled','timedOut','noData','failed','holdoutFew','robustness','pending','noValid'].map(name=>runs[name].run_id));
  for(const run of body.runs)assert.deepEqual(Object.keys(run).sort(),LIST_KEYS);
  const by=byId(body),got=name=>by[runs[name].run_id];
  const expected={noValid:['NO_VALID_CANDIDATE','COMPLETED'],pending:['CANDIDATE_PENDING_ACCEPTANCE','COMPLETED'],robustness:['NO_VALID_CANDIDATE','COMPLETED'],
    holdoutFew:['INSUFFICIENT_EVIDENCE','INSUFFICIENT'],failed:['FAILED','FAILED'],noData:['INSUFFICIENT_DATA','INSUFFICIENT'],timedOut:['TIMED_OUT','FAILED'],
    cancelled:['CANCELLED','CANCELLED'],running:['IN_PROGRESS','ACTIVE'],queued:['IN_PROGRESS','ACTIVE'],other:['NO_VALID_CANDIDATE','COMPLETED']};
  for(const [name,[cls,group]] of Object.entries(expected)){
    assert.deepEqual([got(name).library_class,got(name).library_group],[cls,group],name);
    assert.equal(got(name).status,runs[name].status,name);assert.equal(got(name).diagnostic,runs[name].diagnostic,name);
  }
  const noValid=got('noValid');
  assert.equal(noValid.completion_reason,'NO_VALID_TRAIN_VALIDATION_CANDIDATE');assert.deepEqual(noValid.candidates,{planned:12,evaluated:12,screen_passed:0});
  assert.deepEqual(noValid.development_score,{value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'NO_SCREENED_CANDIDATE'});
  assert.deepEqual(noValid.qualification,{qualified:false,label:'NO_SCREENED_CANDIDATE'});
  assert.equal(noValid.finished_at,noValid.created_at+120000);assert.equal(got('running').finished_at,null);assert.equal(got('queued').finished_at,null);
  assert.equal(got('pending').development_score.value,'3.2');assert.deepEqual(got('pending').qualification,{qualified:false,label:'DEVELOPMENT_ONLY'});
  assert.equal(got('pending').completion_reason,'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE');assert.equal(got('pending').candidates.screen_passed,1);
  assert.equal(got('failed').development_score.reason,'NOT_EVALUATED');assert.equal(got('failed').qualification.label,'NOT_EVALUATED');
  assert.equal(got('failed').candidates.evaluated,2);assert.equal(got('failed').candidates.screen_passed,null,'no result: no count');
  assert.equal(got('running').candidates.evaluated,4);
  assert.equal(noValid.contract_version,'ql3a-research-job-v1');assert.equal(noValid.engine_family,'LEGACY');
  assert.deepEqual(noValid.market,{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
  assert.deepEqual(Object.keys(noValid.dataset).sort(),['bar_count','digest','digest_kind','end_time','start_time','warmup_bars']);
  assert.equal(noValid.dataset.digest_kind,'ql3a-dataset-sha256-v1');assert.deepEqual(noValid.cost,{fee_bps:10,slippage_bps:1});
  assert.ok(body.runs.every(run=>run.integrity_checked===false&&run.qualification.qualified===false));
  assert.equal(new Set(['noValid','pending','robustness','holdoutFew','failed','running'].map(name=>got(name).compatibility_key)).size,1,'one context, one key');
  assert.notEqual(got('other').compatibility_key,got('noValid').compatibility_key);assert.match(got('noValid').compatibility_key,/^[a-f0-9]{12}$/);
  noMarkers(body,[B.id,runs.foreign.run_id]);
});

test('list: pages follow the cursor without gaps or repeats; other owners see only their own runs; totals cover the whole library of the owner',async()=>{
  const seen=[];let before=null,pages=0;
  for(;;){
    const answer=await get(server,sessionA,PATH+'?limit=4'+(before?'&before='+encodeURIComponent(before):''));
    assert.equal(answer.status,200,JSON.stringify(answer.body));pages++;
    assert.equal(answer.body.totals.all,11,'totals ignore the page size');
    assert.ok(answer.body.runs.length<=4);seen.push(...answer.body.runs.map(run=>run.run_id));
    before=answer.body.next_before;
    if(before===null)break;
    assert.match(before,/^[0-9]{1,16}:[0-9a-f-]{36}$/);
  }
  assert.equal(pages,3);assert.equal(new Set(seen).size,11);
  assert.deepEqual(seen,Object.entries(runs).filter(([name])=>name!=='foreign').sort(([,a],[,b])=>b.created_at-a.created_at).map(([,run])=>run.run_id));
  const exact=await get(server,sessionA,PATH+'?limit=11');
  assert.equal(exact.body.runs.length,11);assert.equal(exact.body.next_before,null,'a page that holds every run has no next cursor');
  const one=await get(server,sessionA,PATH+'?limit=1');
  assert.equal(one.body.runs[0].run_id,runs.other.run_id);assert.equal(one.body.next_before,runs.other.created_at+':'+runs.other.run_id);
  // A cursor is a position, not a filter: another owner's cursor leaks nothing.
  const foreign=await get(server,sessionB,PATH+'?before='+encodeURIComponent(runs.foreign.created_at+1+':'+runs.foreign.run_id));
  assert.deepEqual(foreign.body.runs.map(run=>run.run_id),[runs.foreign.run_id]);
  const other=await get(server,sessionB,PATH);
  assert.deepEqual([other.body.totals,other.body.runs.map(run=>run.run_id)],[{all:1,ACTIVE:0,COMPLETED:1,INSUFFICIENT:0,FAILED:0,CANCELLED:0},[runs.foreign.run_id]]);
  noMarkers(other.body,[A.id,...Object.values(runs).filter(run=>run!==runs.foreign).map(run=>run.run_id)]);
  const empty=await get(server,sessionC,PATH);
  assert.deepEqual([empty.body.schema_present,empty.body.totals.all,empty.body.runs],[true,0,[]]);
});

test('detail: foreign and absent runs give the same 404; a run of the owner is never confused with another owner',async()=>{
  const foreign=await get(server,sessionA,PATH+'/runs/'+runs.foreign.run_id),absent=await get(server,sessionA,PATH+'/runs/'+randomUUID());
  assert.equal(foreign.status,404);assert.equal(absent.status,404);
  assert.deepEqual(foreign.body,absent.body,'one answer for a foreign and an absent run');assert.deepEqual(foreign.body,{error:'NOT_FOUND',code:'NOT_FOUND'});
  const mine=await get(server,sessionB,PATH+'/runs/'+runs.foreign.run_id);assert.equal(mine.status,200);
  assert.equal((await get(server,sessionC,PATH+'/runs/'+runs.noValid.run_id)).status,404);
  for(const query of [runs.noValid.run_id+'&run_id='+runs.foreign.run_id,runs.foreign.run_id+'&run_id='+runs.noValid.run_id]){
    const compare=await get(server,sessionA,PATH+'/compare?run_id='+query);
    assert.equal(compare.status,404);assert.deepEqual(compare.body,absent.body,'a foreign run in a comparison is not found either');
  }
});

const detailOf=async(name,session=sessionA)=>{const answer=await get(server,session,PATH+'/runs/'+runs[name].run_id);assert.equal(answer.status,200,name+' '+JSON.stringify(answer.body));return answer.body;};
const GATES=body=>body.qualification.gates.map(gate=>gate.state).join(' ');

test('detail: provenance, integrity, completeness, evaluation, qualification and compatibility of a run that passed screening',async()=>{
  const body=await detailOf('pending'),run=runs.pending,c=run.contract;
  assert.deepEqual(Object.keys(body).sort(),['compatibility','completeness','evaluation','integrity','limitations','provenance','qualification','qualified_total','qualified_winner','run','version']);
  assert.equal(body.version,'quant-library-run-v1');assert.equal(body.qualified_total,0);assert.equal(body.qualified_winner,null);
  assert.deepEqual(body.run,{run_id:run.run_id,created_at:run.created_at,finished_at:run.created_at+120000,status:'SUCCEEDED',phase:'COMPLETE',library_class:'CANDIDATE_PENDING_ACCEPTANCE',
    library_group:'COMPLETED',completion_reason:'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE',diagnostic:null,contract_version:'ql3a-research-job-v1',engine_family:'LEGACY',bot_id:A.id,
    deployment_id:A.deployment,attempts:1,evaluations_started:run.steps.length,deadline:run.created_at+900000});
  const p=body.provenance;
  assert.deepEqual(Object.keys(p),['source','input','dataset','engine','cost_policy','validation','foundation']);
  assert.equal(p.source.source_hash,c.source_hash);assert.equal(p.source.baseline_snapshot_hash,c.baseline_snapshot_hash);assert.equal(p.source.membership.length,1);
  assert.deepEqual(p.input.signals,{buy:'buySignal',exit:'sellSignal',timing:'bar_close'});assert.deepEqual(p.input.bridge,{atr_multiplier:2,rr:1.5});
  assert.equal(p.input.lock_hash,c.input_lock.lock_hash);assert.equal(p.input.bindings.length,1);assert.deepEqual(p.input.bindings[0].search_domain,{min:30,max:50,step:10});
  assert.equal(p.input.fixed_inputs_count,2);assert.deepEqual(Object.keys(p.input.fixed_inputs[0]).sort(),['effective_value','input_id','pine_variable','type']);
  assert.deepEqual(p.input.domains.map(item=>item.dimension),['atr_multiplier','emaFastInput','rr']);assert.deepEqual(p.input.domains[0],{dimension:'atr_multiplier',count:7,min:1,max:4});
  assert.deepEqual(p.input.search,{algorithm:'axis-covered-seeded-grid-v1',seed:7,requested_budget:6,planned_candidates:6,grid_combinations:105});
  assert.equal(p.dataset.digest,c.dataset.sha256);assert.equal(p.dataset.digest_kind,'ql3a-dataset-sha256-v1');assert.equal(p.dataset.bar_count,1000);assert.equal(p.dataset.collection_cutoff,null);
  assert.equal(p.engine.engine_hash,c.engine_hash);assert.equal(p.engine.engine_family,'LEGACY');assert.equal(p.cost_policy.model.fee_bps,10);assert.equal(p.cost_policy.cost_stress,'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE');
  assert.equal(p.cost_policy.policy_hash,c.snapshot.policy_hash);assert.deepEqual(p.cost_policy.capital,{equity:'1000',cash:'1000'});
  assert.deepEqual(p.validation.split,c.split);assert.deepEqual(p.validation.rules,c.rules);assert.deepEqual(p.validation.acceptance_blockers,c.acceptance_blockers);
  assert.deepEqual(p.validation.holdout_window,{start_time:T0+c.split.validation_end*MINUTE,end_time:T0+999*MINUTE});assert.equal(p.foundation,null);
  const i=body.integrity;
  assert.equal(i.contract_hash,run.contract_hash);assert.equal(i.contract_hash_verified,true);assert.equal(i.result_sha256,hash(canonical(run.result)));
  assert.equal(i.steps_count,run.steps.length);assert.match(i.steps_digest,/^[a-f0-9]{64}$/);assert.equal(i.report_matches_checkpoints,true);assert.deepEqual(i.checkpoint_problems,[]);
  assert.equal(i.identity_protection,'DB_TRIGGER');assert.equal(i.result_protection,'APPLICATION_ONLY');assert.deepEqual(i.warnings,[]);assert.equal(i.foundation_binding_matches,null);
  assert.deepEqual(body.completeness,{result_present:true,candidates_planned:6,candidates_recorded:6,holdout_evaluated:true,missing:[]});
  assert.deepEqual(body.limitations.acceptance_blockers,c.acceptance_blockers);
  for(const gap of ['NO_EFFECTIVE_INPUT_REVIEW_HASH','ENGINE_RELEASE_UNKNOWN','NO_DATA_COLLECTION_TIMESTAMP','NO_PARITY_REPAINT_EVIDENCE','NO_IMMUTABLE_FINISH_TIME','RESULT_NOT_DB_FROZEN','NO_BENCHMARK_OR_COMPARISON_OBJECTIVE'])assert.ok(body.limitations.provenance_gaps.includes(gap),gap);
  const e=body.evaluation;
  assert.equal(e.objective.rule,'VALIDATION_NET_RETURN_THEN_DRAWDOWN_THEN_PARAMETERS');assert.equal(e.objective.fixed_before_run,true);
  assert.deepEqual([e.candidate_count,e.screen_passed,e.holdout_evaluated,e.dimension_coverage_percent,e.stored_values_verified],[6,1,true,100,true]);
  assert.deepEqual(e.reason_counts,{VALIDATION_BELOW_BASELINE_OR_ZERO:5});assert.deepEqual(e.development_score,{value:'3.2',basis:'VALIDATION_NET_RETURN_PERCENT',reason:null});
  assert.equal(e.candidates.length,6);assert.deepEqual(Object.keys(e.candidates[0]),['index','parameters','train','validation','screen_reasons']);
  assert.equal(e.selected.validation.net_return_percent,'3.2');assert.equal(e.selected.sensitivity.length,2);assert.equal(e.selected.test.closed_trades,9);assert.deepEqual(e.selected.screen_reasons,[]);
  assert.equal(body.qualification.version,'library-qualification-v1');assert.equal(body.qualification.qualified,false);assert.equal(body.qualification.label,'DEVELOPMENT_ONLY');
  assert.equal(GATES(body),'PASS PASS PASS PASS PASS FAIL FAIL FAIL');assert.deepEqual(body.qualification.holdout_overlap,{checked:true,overlaps:false,run_ids:[]});
  assert.equal(body.compatibility.version,'library-compat-v1');assert.match(body.compatibility.key,/^[a-f0-9]{64}$/);assert.equal(body.compatibility.short_key,body.compatibility.key.slice(0,12));
  assert.deepEqual(Object.keys(body.compatibility.fields).length,13);assert.deepEqual(body.compatibility.missing,[]);
  noMarkers(body,[B.id,runs.foreign.run_id]);
});

test('detail: runs without a screened candidate, with failed checks, without a result and still running are shown honestly',async()=>{
  const none=await detailOf('noValid');
  assert.equal(none.run.library_class,'NO_VALID_CANDIDATE');assert.equal(none.run.status,'NO_VALID_CANDIDATE');assert.equal(none.run.completion_reason,'NO_VALID_TRAIN_VALIDATION_CANDIDATE');
  assert.equal(none.evaluation.selected,null);assert.deepEqual(none.evaluation.development_score,{value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'NO_SCREENED_CANDIDATE'});
  assert.deepEqual(none.evaluation.reason_counts,{INSUFFICIENT_VALIDATION_TRADES:12});assert.equal(none.evaluation.candidates.length,12);assert.equal(none.evaluation.holdout_evaluated,false);
  assert.equal(GATES(none),'PASS FAIL NOT_REACHED NOT_REACHED NOT_REACHED FAIL FAIL FAIL');assert.equal(none.qualification.label,'NO_SCREENED_CANDIDATE');assert.equal(none.qualification.gates[1].code,'NO_SCREENED_CANDIDATE');
  assert.deepEqual(none.qualification.holdout_overlap,{checked:false,overlaps:null,run_ids:[]});assert.equal(none.integrity.report_matches_checkpoints,true);
  const robust=await detailOf('robustness');
  assert.equal(robust.evaluation.development_score.value,'3.2','a selected candidate keeps its development score although a later check failed');
  assert.equal(GATES(robust),'PASS PASS FAIL NOT_REACHED NOT_REACHED FAIL FAIL FAIL');assert.equal(robust.qualification.gates[2].code,'COST_STRESS_FAILED');assert.equal(robust.qualification.label,'DEVELOPMENT_ONLY');
  const few=await detailOf('holdoutFew');
  assert.equal(few.run.library_class,'INSUFFICIENT_EVIDENCE');assert.equal(few.run.status,'NO_VALID_CANDIDATE');assert.equal(few.qualification.gates[3].code,'INSUFFICIENT_TEST_TRADES');assert.equal(few.evaluation.selected.test.closed_trades,2);
  const failed=await detailOf('failed');
  assert.equal(failed.run.library_class,'FAILED');assert.equal(failed.run.diagnostic,'QUANT_ENGINE_CHANGED');assert.equal(failed.run.completion_reason,null);
  assert.deepEqual(failed.completeness,{result_present:false,candidates_planned:6,candidates_recorded:2,holdout_evaluated:null,missing:[]});
  assert.deepEqual([failed.integrity.result_sha256,failed.integrity.report_matches_checkpoints,failed.integrity.contract_hash_verified],[null,null,true]);
  assert.deepEqual([failed.evaluation.candidates,failed.evaluation.selected,failed.evaluation.candidate_count],[[],null,null]);assert.equal(failed.evaluation.development_score.reason,'NOT_EVALUATED');
  assert.equal(GATES(failed),'FAIL NOT_REACHED NOT_REACHED NOT_REACHED NOT_REACHED FAIL FAIL FAIL');assert.equal(failed.qualification.gates[0].code,'STATUS_NOT_COMPLETED');
  const running=await detailOf('running');
  assert.equal(running.run.library_class,'IN_PROGRESS');assert.equal(running.run.finished_at,null);assert.equal(running.completeness.candidates_recorded,4);assert.equal(running.limitations.provenance_gaps.includes('NO_IMMUTABLE_FINISH_TIME'),false);
  assert.equal((await detailOf('noData')).run.library_class,'INSUFFICIENT_DATA');assert.equal((await detailOf('timedOut')).run.library_class,'TIMED_OUT');assert.equal((await detailOf('cancelled')).run.library_class,'CANCELLED');
  for(const body of [none,robust,few,failed,running])noMarkers(body);
});

test('compare: runs of one context are compared with development metrics only, ordered by creation time and never ranked; a different context is not comparable',async()=>{
  const ids=[runs.pending,runs.noValid,runs.failed,runs.robustness];
  const query=ids.map(run=>'run_id='+run.run_id).join('&');
  const answer=await get(server,sessionA,PATH+'/compare?'+query);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body;
  assert.deepEqual(Object.keys(body).sort(),['mismatches','qualified_total','qualified_winner','rules','runs','verdict','version']);
  assert.equal(body.version,'quant-library-compare-v1');assert.equal(body.verdict,'COMPATIBLE');assert.deepEqual(body.mismatches,[]);assert.equal(body.qualified_total,0);assert.equal(body.qualified_winner,null);
  assert.deepEqual(body.runs.map(run=>run.run_id),[runs.noValid,runs.pending,runs.robustness,runs.failed].map(run=>run.run_id),'created order, whatever the request order');
  const reversed=await get(server,sessionA,PATH+'/compare?'+[...ids].reverse().map(run=>'run_id='+run.run_id).join('&'));assert.deepEqual(reversed.body,body);
  const by=Object.fromEntries(body.runs.map(run=>[run.run_id,run]));
  const pending=by[runs.pending.run_id];
  assert.deepEqual(pending.metrics.candidates,{planned:6,evaluated:6,screen_passed:1});assert.equal(pending.metrics.development_score.value,'3.2');
  assert.deepEqual(Object.keys(pending.metrics.selected),['parameters','train','validation']);assert.ok(!('test' in pending.metrics.selected),'holdout results stay out of the comparison');
  assert.deepEqual(pending.qualification,{qualified:false,label:'DEVELOPMENT_ONLY'});assert.equal(pending.disclosed.search.seed,7);assert.equal(pending.disclosed.bot_id,A.id);
  assert.deepEqual(by[runs.noValid.run_id].metrics.selected,null);assert.equal(by[runs.noValid.run_id].metrics.development_score.reason,'NO_SCREENED_CANDIDATE');
  const failed=by[runs.failed.run_id];assert.equal(failed.metrics,null);assert.equal(failed.metrics_reason,'NOT_EVALUATED');assert.equal(failed.library_class,'FAILED');
  for(const run of body.runs){assert.ok(!/best|top|winner|rank|delta/i.test(Object.keys(run).join()),'no ranking field');assert.equal(run.qualification.qualified,false);}
  noMarkers(body);
  const other=await get(server,sessionA,PATH+'/compare?run_id='+runs.pending.run_id+'&run_id='+runs.other.run_id);
  assert.equal(other.status,200);assert.equal(other.body.verdict,'INCOMPATIBLE');
  assert.deepEqual(other.body.mismatches.map(item=>item.field),['dataset'],'only the dataset differs');
  assert.deepEqual(other.body.mismatches[0].values.map(item=>item.run_id),[runs.pending.run_id,runs.other.run_id]);
  for(const run of other.body.runs){assert.ok(!('metrics' in run)&&!('disclosed' in run),'no metrics for an incomparable pair');assert.ok(run.library_class&&run.qualification&&run.compatibility_key);}
  assert.equal(other.body.runs.length,2);noMarkers(other.body);
});

const counts=async()=>Object.fromEntries(await Promise.all(['quant_jobs','quant_job_steps','audit'].map(async table=>[table,(await db.query('SELECT count(*)::int AS n FROM '+table)).rows[0].n])));
// Sanitized proof record of one run: identity, integrity and derived facts. No source, bars, cookies or paths.
const proofOf=body=>({run_id:body.run.run_id,status:body.run.status,library_class:body.run.library_class,contract_hash:body.integrity.contract_hash,
  contract_hash_verified:body.integrity.contract_hash_verified,result_sha256:body.integrity.result_sha256,steps_count:body.integrity.steps_count,steps_digest:body.integrity.steps_digest,
  report_matches_checkpoints:body.integrity.report_matches_checkpoints,compatibility_key:body.compatibility.key,qualification_label:body.qualification.label});
async function readEverything(srv,session){
  const list=(await get(srv,session,PATH)).body,details={},proofs=[];
  for(const run of list.runs){const answer=await get(srv,session,PATH+'/runs/'+run.run_id);assert.equal(answer.status,200);details[run.run_id]=answer.body;proofs.push(proofOf(answer.body));}
  const compares=[];
  for(const pair of [[runs.pending,runs.noValid,runs.robustness],[runs.pending,runs.other]])compares.push((await get(srv,session,PATH+'/compare?'+pair.map(run=>'run_id='+run.run_id).join('&'))).body);
  return {list,details,proofs,compares};
}

test('restart readback: the same records, proofs, totals and verdicts after the server is stopped and started again on the same database; the reads write nothing',async()=>{
  const before=await counts(),first=await readEverything(server,sessionA);
  assert.deepEqual(await counts(),before,'reads change no quant row and write no audit row');
  assert.equal(first.proofs.length,11);assert.ok(first.proofs.every(proof=>proof.contract_hash_verified===true&&proof.report_matches_checkpoints!==false));
  await server.stop();
  const second=await startServer(),secondSession=await login(second,A);
  const again=await readEverything(second,secondSession);
  assert.deepEqual(again.proofs,first.proofs,'proof records are equal across the restart');
  assert.deepEqual(again.list,first.list);assert.deepEqual(again.details,first.details);assert.deepEqual(again.compares,first.compares);
  assert.deepEqual(again.list.totals,{all:11,ACTIVE:2,COMPLETED:4,INSUFFICIENT:2,FAILED:2,CANCELLED:1});
  assert.deepEqual(again.compares.map(item=>item.verdict),['COMPATIBLE','INCOMPATIBLE']);
  server=second;sessionA=secondSession;sessionB=await login(server,B);sessionC=await login(server,C);
  const after=await counts();
  assert.equal(after.quant_jobs,before.quant_jobs);assert.equal(after.quant_job_steps,before.quant_job_steps);
});

test('read only: the service issues SELECT statements only, no lock and no executor-mode check, and works in a READ ONLY transaction',async()=>{
  const statements=[],client=await db.pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    const spy={isTransaction:true,query:(sql,params)=>{statements.push(sql);return client.query(sql,params);},transaction:async fn=>fn()};
    const service=new QuantLibraryService(spy,{admissionEnabled:true});
    const list=await service.list(A.id),detail=await service.detail(A.id,runs.pending.run_id),compare=await service.compare(A.id,[runs.pending.run_id,runs.noValid.run_id]);
    assert.equal(list.runs.length,11);assert.equal(list.admission_enabled,true);assert.equal(detail.run.run_id,runs.pending.run_id);assert.equal(compare.verdict,'COMPATIBLE');
    const out={},json=(res,status,body)=>{res.out={status,body};};
    assert.equal(await quantLibraryRoutes({method:'GET'},out,new URL('http://x'+PATH+'?limit=2&bot_id=z'),{id:A.id},spy,json,{admissionEnabled:true}),true);
    assert.deepEqual([out.out.status,out.out.body.runs.length],[200,2]);
    assert.equal(await quantLibraryRoutes({method:'GET'},out,new URL('http://x/api/quant/research/history'),{id:A.id},spy,json,{}),false,'other paths fall through');
    await assert.rejects(quantLibraryRoutes({method:'POST'},out,new URL('http://x'+PATH),{id:A.id},spy,json,{}),{code:'METHOD_NOT_ALLOWED',status:405});
    await client.query('ROLLBACK');
    // The same service, handed a plain read-write connection, still starts with SET TRANSACTION READ ONLY, so a write would fail loudly.
    assert.equal(statements[0],'SET TRANSACTION READ ONLY');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  assert.ok(statements.length>=20,'statements were observed: '+statements.length);
  for(const sql of statements){
    assert.match(sql,/^\s*(SELECT|WITH|SET TRANSACTION READ ONLY)\b/i);
    assert.doesNotMatch(sql,/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b|pg_advisory|\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b|executor_mode/i);
  }
  // A write through the service's own transaction wrapper is refused by the database.
  await assert.rejects(new QuantLibraryService(db).read(()=>db.query("UPDATE quant_jobs SET diagnostic='X' WHERE run_id=$1",[runs.pending.run_id])),{code:'25006'});
  assert.equal((await db.query('SELECT diagnostic FROM quant_jobs WHERE run_id=$1',[runs.pending.run_id])).rows[0].diagnostic,null);
  assert.throws(()=>new QuantLibraryService(null),{code:'QUANT_LIBRARY_CONFIGURATION_INVALID'});
});

let v2;
async function seedFoundationRuns(){
  await install('quant-foundation-schema.sql');await install('quant-research-foundation-schema.sql');
  const spec={pending:{scenario:'PENDING',at:AT(13)},noBinding:{scenario:'NO_VALID',at:AT(14)},noRow:{scenario:'NO_VALID',at:AT(15)},mismatch:{scenario:'NO_VALID',at:AT(16)},foreignRow:{scenario:'NO_VALID',at:AT(17)}};
  v2={};
  for(const [name,options] of Object.entries(spec)){v2[name]=make(A,{version:'v2',tag:'v2',...options});await seed(A,v2[name]);}
  await seedFoundation(db,v2.pending,{owner:A.id});await seedFoundation(db,v2.noBinding,{owner:A.id,withBinding:false});
  await seedFoundation(db,v2.mismatch,{owner:A.id,bindingHash:hash('another contract')});
  await seedFoundation(db,v2.foreignRow,{owner:B.id});
}

test('FOUNDATION runs: execution facts and the dataset binding appear, worker and file references never do; gaps and a wrong binding are flagged',async()=>{
  await seedFoundationRuns();
  const pending=(await get(server,sessionA,PATH+'/runs/'+v2.pending.run_id)).body;
  assert.equal(pending.run.engine_family,'FOUNDATION');assert.equal(pending.run.contract_version,'ql3a-research-job-v2');assert.equal(pending.run.library_class,'CANDIDATE_PENDING_ACCEPTANCE');
  const f=pending.provenance.foundation;
  assert.deepEqual(Object.keys(f),['job_id','status','attempts','runtime_used_ms','stop_reason','diagnostic','created_at','deadline_at','budget','dataset_metadata','dataset_binding','chunk_rows']);
  assert.deepEqual([f.job_id,f.status,f.attempts,f.runtime_used_ms,f.stop_reason,f.chunk_rows],[v2.pending.run_id,'SUCCEEDED',1,12345,null,1]);
  assert.deepEqual(f.budget,{candidates:6,max_evaluations:v2.pending.contract.max_evaluations,chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:8388608,max_state_bytes:1048576});
  assert.deepEqual(f.dataset_metadata,{venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',cutoff:v2.pending.contract.dataset.end_time+MINUTE,source:'binance-spot-klines-v1'});
  assert.deepEqual(Object.keys(f.dataset_binding).sort(),['bar_count','content_digest','dataset_sha256','execution_contract_hash']);assert.equal(f.dataset_binding.bar_count,1000);
  assert.equal(pending.provenance.dataset.digest_kind,'pine-bar-content-digest-v1');assert.equal(pending.provenance.dataset.digest,v2.pending.contract.dataset.content_digest);
  assert.equal(pending.provenance.dataset.collection_cutoff,f.dataset_metadata.cutoff);assert.equal(pending.provenance.dataset.binding_sha256,f.dataset_binding.dataset_sha256);
  assert.equal(pending.limitations.provenance_gaps.includes('NO_DATA_COLLECTION_TIMESTAMP'),false,'a FOUNDATION run records its data cutoff');
  assert.equal(pending.integrity.foundation_binding_matches,true);assert.deepEqual(pending.integrity.warnings,[]);assert.deepEqual(pending.completeness.missing,[]);
  assert.deepEqual(pending.integrity.contract_hash_verified,true);noMarkers(pending,[B.id]);
  // The same bars as an earlier legacy run: the holdout is exposed already (time overlap, not a digest match).
  assert.equal(pending.qualification.holdout_overlap.overlaps,true);assert.deepEqual(pending.qualification.holdout_overlap.run_ids,[runs.pending.run_id,runs.holdoutFew.run_id],'earlier runs of the same owner and market that evaluated a holdout, oldest first');
  assert.equal(pending.qualification.gates[4].code,'HOLDOUT_WINDOW_REUSED');assert.equal(GATES(pending),'PASS PASS PASS PASS FAIL FAIL FAIL FAIL');
  const noBinding=(await get(server,sessionA,PATH+'/runs/'+v2.noBinding.run_id)).body;
  assert.deepEqual(noBinding.completeness.missing,['NO_DATASET_BINDING']);assert.equal(noBinding.provenance.foundation.dataset_binding,null);assert.equal(noBinding.provenance.foundation.chunk_rows,0);
  const noRow=(await get(server,sessionA,PATH+'/runs/'+v2.noRow.run_id)).body;
  assert.deepEqual(noRow.completeness.missing,['NO_FOUNDATION_ROW','NO_DATASET_BINDING']);assert.equal(noRow.provenance.foundation,null);assert.equal(noRow.integrity.foundation_binding_matches,null);
  const foreignRow=(await get(server,sessionA,PATH+'/runs/'+v2.foreignRow.run_id)).body;
  assert.equal(foreignRow.provenance.foundation,null,'a foundation row of another owner is never joined');assert.deepEqual(foreignRow.completeness.missing,['NO_FOUNDATION_ROW']);noMarkers(foreignRow,[B.id]);
  const mismatch=(await get(server,sessionA,PATH+'/runs/'+v2.mismatch.run_id)).body;
  assert.equal(mismatch.integrity.foundation_binding_matches,false);assert.deepEqual(mismatch.integrity.warnings,['FOUNDATION_BINDING_MISMATCH']);
  assert.equal(mismatch.qualification.gates[0].code,'INTEGRITY_CHECK_FAILED');assert.equal(mismatch.qualification.label,'NOT_EVALUATED');
  // Legacy and FOUNDATION runs are never comparable.
  const compare=await get(server,sessionA,PATH+'/compare?run_id='+runs.pending.run_id+'&run_id='+v2.pending.run_id);
  assert.equal(compare.body.verdict,'INCOMPATIBLE');assert.ok(['dataset','engine'].every(name=>compare.body.mismatches.some(item=>item.field===name)));
  const list=(await get(server,sessionA,PATH)).body;
  assert.equal(list.totals.all,16);assert.equal(byId(list)[v2.pending.run_id].engine_family,'FOUNDATION');assert.equal(byId(list)[v2.pending.run_id].dataset.digest_kind,'pine-bar-content-digest-v1');
  noMarkers(list,[B.id]);
  // Another owner cannot read A's FOUNDATION run, whatever job row is bound to it.
  assert.equal((await get(server,sessionB,PATH+'/runs/'+v2.foreignRow.run_id)).status,404);
});

test('holdout independence: an earlier same-owner run on the same market that used an overlapping holdout fails G5; other owners and later bars do not count',async()=>{
  const far=T0+100_000*MINUTE,near={tag:'g5',start:far,scenario:'PENDING'};
  const earlierOther=make(B,{...near,at:AT(19)});await seed(B,earlierOther);
  const x=make(A,{...near,at:AT(20)}),y=make(A,{...near,at:AT(21)}),z=make(A,{...near,start:far+2000*MINUTE,at:AT(22)});
  for(const run of [x,y,z])await seed(A,run);
  const gate5=async run=>{const body=(await get(server,sessionA,PATH+'/runs/'+run.run_id)).body;return {state:body.qualification.gates[4],overlap:body.qualification.holdout_overlap,label:body.qualification.label};};
  const first=await gate5(x),second=await gate5(y),third=await gate5(z);
  assert.equal(first.state.state,'PASS');assert.deepEqual(first.overlap,{checked:true,overlaps:false,run_ids:[]});
  assert.deepEqual([second.state.state,second.state.code],['FAIL','HOLDOUT_WINDOW_REUSED']);assert.deepEqual(second.overlap,{checked:true,overlaps:true,run_ids:[x.run_id]});
  assert.equal(third.state.state,'PASS','a later dataset window is independent');assert.deepEqual(third.overlap.run_ids,[]);
  assert.ok(![first,second,third].some(item=>item.label==='QUALIFIED'));
  // The comparison reads the same gates.
  const compare=(await get(server,sessionA,PATH+'/compare?run_id='+x.run_id+'&run_id='+y.run_id)).body;
  assert.equal(compare.verdict,'COMPATIBLE');assert.ok(compare.runs.every(run=>run.qualification.qualified===false));
});

test('tamper detection: an edited result or contract raises an integrity warning, fails G1, withdraws the development score, and never raises an error',async()=>{
  const run=make(A,{scenario:'PENDING',at:AT(30)});await seed(A,run);
  const read=async()=>(await get(server,sessionA,PATH+'/runs/'+run.run_id)).body;
  const clean=await read();assert.deepEqual(clean.integrity.warnings,[]);assert.equal(clean.evaluation.development_score.value,'3.2');
  await db.query("UPDATE quant_jobs SET result=jsonb_set(result,'{selected,result,validation,net_return_percent}','\"99.9\"') WHERE run_id=$1",[run.run_id]);
  const edited=await read();
  assert.equal(edited.integrity.report_matches_checkpoints,false);assert.ok(edited.integrity.checkpoint_problems.includes('SELECTED_MISMATCH'));assert.deepEqual(edited.integrity.warnings,['CHECKPOINT_MISMATCH']);
  assert.notEqual(edited.integrity.result_sha256,clean.integrity.result_sha256,'the result digest changes');assert.equal(edited.integrity.steps_digest,clean.integrity.steps_digest,'the checkpoints did not change');
  assert.equal(edited.integrity.contract_hash_verified,true);assert.equal(edited.qualification.gates[0].state,'FAIL');assert.equal(edited.qualification.gates[0].code,'INTEGRITY_CHECK_FAILED');
  assert.equal(edited.qualification.label,'NOT_EVALUATED');assert.deepEqual(edited.evaluation.development_score,{value:null,basis:'VALIDATION_NET_RETURN_PERCENT',reason:'INTEGRITY_CHECK_FAILED'});
  assert.equal(edited.evaluation.stored_values_verified,false);assert.equal(edited.qualification.qualified,false);
  const compare=(await get(server,sessionA,PATH+'/compare?run_id='+run.run_id+'&run_id='+runs.pending.run_id)).body;
  const flagged=compare.runs.find(item=>item.run_id===run.run_id);assert.equal(flagged.qualification.label,'NOT_EVALUATED');assert.equal(flagged.metrics.development_score.value,null);
  assert.equal(compare.runs.find(item=>item.run_id===runs.pending.run_id).qualification.label,'DEVELOPMENT_ONLY');
  // A fabricated candidate and an extra checkpoint are named too.
  await db.query("UPDATE quant_jobs SET result=jsonb_set(result,'{candidates}',(result->'candidates')||'[{\"parameters\":{},\"result\":{},\"screen_reasons\":[]}]'::jsonb) WHERE run_id=$1",[run.run_id]);
  assert.ok((await read()).integrity.checkpoint_problems.includes('CANDIDATE_COUNT_MISMATCH'));
  // The contract is immutable in the database. The isolated admin disables the trigger once to prove that the read-time hash catches an edit.
  const other=make(A,{scenario:'NO_VALID',at:AT(31)});await seed(A,other);
  await db.query('ALTER TABLE quant_jobs DISABLE TRIGGER quant_job_contract_immutable');
  try{await db.query("UPDATE quant_jobs SET contract=jsonb_set(contract,'{capital,cash}','\"1\"') WHERE run_id=$1",[other.run_id]);}
  finally{await db.query('ALTER TABLE quant_jobs ENABLE TRIGGER quant_job_contract_immutable');}
  const hashed=(await get(server,sessionA,PATH+'/runs/'+other.run_id)).body;
  assert.equal(hashed.integrity.contract_hash_verified,false);assert.deepEqual(hashed.integrity.warnings,['CONTRACT_HASH_MISMATCH']);assert.equal(hashed.qualification.gates[0].code,'INTEGRITY_CHECK_FAILED');
  assert.equal(hashed.integrity.contract_hash,other.contract_hash,'the stored hash is shown as it is');
  await assert.rejects(db.query("UPDATE quant_jobs SET contract=contract WHERE run_id=$1 AND false",[other.run_id]).then(()=>db.query("UPDATE quant_jobs SET contract='{}' WHERE run_id=$1",[other.run_id])),/immutable/,'the trigger is back');
  assert.equal((await get(server,sessionA,PATH)).status,200,'the list stays readable');
});

// p95 bound set here for the tester to review: 20 legacy runs, each with a 10,000-bar contract (about 1.5 MB), a 100-candidate result and 100 checkpoints.
const LIST_P95_MS=2000,DETAIL_P95_MS=2500;
test('performance: a page of 20 legacy runs with 10,000-bar contracts stays slim and within the p95 bound',async()=>{
  const D=await newOwner('qlib-d'),sessionD=await login(server,D);
  for(let index=0;index<20;index++){
    const run=make(D,{scenario:'NO_VALID',candidates:100,barCount:10000,total:10000,warmup:3250,at:AT(40+index)});
    run.contract.source+='\n'+'// padding '.repeat(2000);
    run.contract_hash=hash(canonical(run.contract));
    run.result.contract_hash=run.contract_hash;
    await seed(D,run);
  }
  const size=(await db.query("SELECT avg(pg_column_size(contract))::int AS stored,avg(length(contract::text))::int AS raw FROM quant_jobs WHERE owner_id=$1",[D.id])).rows[0];
  assert.ok(size.raw>1_000_000,'each contract holds its bars: '+size.raw);
  const samples=[],detailSamples=[];let body;
  for(let index=0;index<12;index++){
    const started=performance.now(),answer=await get(server,sessionD,PATH+'?limit=20');samples.push(performance.now()-started);
    assert.equal(answer.status,200);body=answer.body;
  }
  assert.equal(body.runs.length,20);assert.equal(body.totals.all,20);
  assert.ok(JSON.stringify(body).length<120_000,'the list carries no contract: '+JSON.stringify(body).length+' bytes');noMarkers(body);
  const runId=body.runs[0].run_id;
  for(let index=0;index<6;index++){const started=performance.now(),answer=await get(server,sessionD,PATH+'/runs/'+runId);detailSamples.push(performance.now()-started);assert.equal(answer.status,200);if(index===0){assert.equal(answer.body.integrity.contract_hash_verified,true);assert.equal(answer.body.evaluation.candidates.length,100);noMarkers(answer.body);}}
  const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  const listP95=p95(samples),detailP95=p95(detailSamples);
  if(process.env.QLIB_PRINT)console.error('qlib p95 list '+Math.round(listP95)+' ms of '+samples.map(Math.round).join(',')+'; detail '+Math.round(detailP95)+' ms of '+detailSamples.map(Math.round).join(','));
  assert.ok(listP95<LIST_P95_MS,'list p95 '+Math.round(listP95)+' ms over '+samples.map(Math.round).join(','));
  assert.ok(detailP95<DETAIL_P95_MS,'detail p95 '+Math.round(detailP95)+' ms over '+detailSamples.map(Math.round).join(','));
});

test('error mapping: a fixed code or a SQLSTATE error passes through unchanged, anything else becomes QUANT_LIBRARY_UNAVAILABLE (503) without its message',async()=>{
  const failing=error=>new QuantLibraryService({query:async()=>{throw error;},transaction:async fn=>fn()});
  const unexpected=Object.assign(new Error('connect ECONNRESET 10.0.0.5 secret-host'),{code:'ECONNRESET'});
  for(const [error,expected] of [[new Error('boom'),{code:'QUANT_LIBRARY_UNAVAILABLE',status:503,message:'QUANT_LIBRARY_UNAVAILABLE'}],[unexpected,{code:'QUANT_LIBRARY_UNAVAILABLE',status:503}],
    [new TypeError('x is not a function'),{code:'QUANT_LIBRARY_UNAVAILABLE',status:503}],[Object.assign(new Error('could not serialize access'),{code:'40001'}),{code:'40001'}],
    [Object.assign(new Error('deadlock'),{code:'40P01'}),{code:'40P01'}],[Object.assign(new Error('NOT_FOUND'),{code:'NOT_FOUND',status:404}),{code:'NOT_FOUND',status:404}]]){
    for(const call of [service=>service.list(A.id),service=>service.detail(A.id,randomUUID()),service=>service.compare(A.id,[randomUUID(),randomUUID()])])
      await assert.rejects(call(failing(error)),expected);
  }
  await assert.rejects(failing(unexpected).list(A.id),error=>!/secret-host|ECONNRESET/.test(error.message),'no internal message leaks');
});
